package http

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/xuri/excelize/v2"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// RunReport — POST /api/reports/{id}/run. Executes the report's bound query or
// dashboard, renders the configured format, delivers via MSP, and records a
// report_run. Returns the run summary + download link.
func (h *Handlers) RunReport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	doc, err := h.Store.GetDoc(r.Context(), "report", id)
	if err != nil {
		writeError(w, http.StatusNotFound, "report not found")
		return
	}
	run, err := h.runReport(r.Context(), doc)
	if err != nil {
		h.Log.Error("run report", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// ReportRuns — GET /api/reports/{id}/runs. History for one report.
func (h *Handlers) ReportRuns(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	all, err := h.Store.ListDocs(r.Context(), "report_run")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	out := []pg.Doc{}
	for _, d := range all {
		if rid, _ := d["report_id"].(string); rid == id {
			delete(d, "file_b64") // don't ship the payload in the history list
			out = append(out, d)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// ReportDownload — GET /api/reports/runs/{runId}/download. Streams the rendered
// CSV/XLSX stored on the report_run.
func (h *Handlers) ReportDownload(w http.ResponseWriter, r *http.Request) {
	runID := chi.URLParam(r, "runId")
	doc, err := h.Store.GetDoc(r.Context(), "report_run", runID)
	if err != nil {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	b64, _ := doc["file_b64"].(string)
	if b64 == "" {
		writeError(w, http.StatusNotFound, "no file for this run")
		return
	}
	data, err := decodeB64(b64)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "decode failed")
		return
	}
	name, _ := doc["file_name"].(string)
	ctype, _ := doc["file_ctype"].(string)
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	_, _ = w.Write(data)
}

// RunReportByID is the scheduler callback: load + run a report by id.
func (h *Handlers) RunReportByID(ctx context.Context, id string) error {
	doc, err := h.Store.GetDoc(ctx, "report", id)
	if err != nil {
		return err
	}
	_, err = h.runReport(ctx, doc)
	return err
}

// ListReportSchedules returns active reports' cron expressions for the scheduler
// (id -> schedule). Only Active reports with a non-empty cron are included.
func (h *Handlers) ListReportSchedules(ctx context.Context) (map[string]string, error) {
	docs, err := h.Store.ListDocs(ctx, "report")
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, d := range docs {
		if !strings.EqualFold(strOf(d["status"]), "Active") {
			continue
		}
		if sched := strings.TrimSpace(strOf(d["schedule"])); sched != "" {
			if id, _ := d["id"].(string); id != "" {
				out[id] = sched
			}
		}
	}
	return out, nil
}

// runReport executes + renders + delivers a report and writes a report_run doc.
// Scheduled runs (no HTTP request) call this directly with context.Background().
func (h *Handlers) runReport(ctx context.Context, report pg.Doc) (pg.Doc, error) {
	name, _ := report["name"].(string)
	reportID, _ := report["id"].(string)

	rs, err := h.reportResultSet(ctx, report)
	if err != nil {
		return nil, err
	}

	format := strings.ToLower(strOf(report["format"]))
	var fileBytes []byte
	var fileName, ctype string
	switch format {
	case "excel", "xlsx":
		fileBytes, err = renderXLSX(rs)
		fileName, ctype = safeName(name)+".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	default: // csv / pdf(降级) / 其它
		fileBytes = renderCSV(rs)
		fileName, ctype = safeName(name)+".csv", "text/csv"
	}
	if err != nil {
		return nil, err
	}

	// Persist the run first so the download link is valid even if delivery fails.
	runDoc := pg.Doc{
		"report_id":  reportID,
		"name":       name,
		"time":       time.Now().Format("2006-01-02 15:04:05"),
		"rows":       len(rs.Rows),
		"file_name":  fileName,
		"file_ctype": ctype,
		"file_b64":   encodeB64(fileBytes),
		"status":     "Rendered",
	}
	saved, err := h.Store.CreateDoc(ctx, "report_run", runDoc)
	if err != nil {
		return nil, fmt.Errorf("save run: %w", err)
	}
	runID, _ := saved["id"].(string)

	// Deliver (best-effort; record outcome). Download link points back at the BFF.
	delivered, deliverErr := h.deliverReport(ctx, report, name, rs, runID)
	patch := pg.Doc{"delivered": delivered}
	if deliverErr != nil {
		patch["status"] = "Delivery failed"
		patch["error"] = deliverErr.Error()
	} else {
		patch["status"] = "Delivered"
	}
	updated, _ := h.Store.PatchDoc(ctx, "report_run", runID, patch)
	if updated != nil {
		delete(updated, "file_b64")
		updated["download"] = "/api/reports/runs/" + runID + "/download"
		return updated, nil
	}
	saved["download"] = "/api/reports/runs/" + runID + "/download"
	delete(saved, "file_b64")
	return saved, nil
}

// reportResultSet runs the report's data source (query spec or dashboard's first
// widget) and returns the result set. Scheduled runs execute with no row/column
// masking (system identity) — platform reports see the full data.
func (h *Handlers) reportResultSet(ctx context.Context, report pg.Doc) (adapter.ResultSet, error) {
	srcType := strings.ToLower(strOf(report["source_type"]))
	switch srcType {
	case "dashboard":
		dashID := strOf(report["dashboard_id"])
		dash, err := h.Store.GetDoc(ctx, "dashboard", dashID)
		if err != nil {
			return adapter.ResultSet{}, fmt.Errorf("dashboard not found")
		}
		widgets := parseWidgets(dash["widgets"])
		if len(widgets) == 0 {
			return adapter.ResultSet{}, fmt.Errorf("dashboard has no widgets")
		}
		return h.execSpec(ctx, widgets[0].Spec)
	default: // "query" or unset — expect an embedded spec
		spec := parseSpec(report["spec"])
		if spec.Dataset.Table == "" {
			return adapter.ResultSet{}, fmt.Errorf("report has no query spec")
		}
		return h.execSpec(ctx, spec)
	}
}

// execSpec compiles + runs a build spec (Trino, no masking for system reports).
func (h *Handlers) execSpec(ctx context.Context, spec dto.BuildSpec) (adapter.ResultSet, error) {
	sql, err := h.compileBuildSpec(ctx, spec)
	if err != nil {
		return adapter.ResultSet{}, err
	}
	resp, err := h.runQueryCtx(ctx, sql, spec.Dataset, nil, "report-scheduler", "trino")
	if err != nil {
		return adapter.ResultSet{}, err
	}
	return resp.Result, nil
}

// deliverReport sends the report via MSP per the report's channel. Email/IM use
// MSP; the body is an HTML table + a download link (MSP has no attachment field).
func (h *Handlers) deliverReport(ctx context.Context, report pg.Doc, name string, rs adapter.ResultSet, runID string) ([]string, error) {
	channel := strings.ToLower(strOf(report["channel"]))
	recipients := splitRecipients(strOf(report["recipients"]))
	if len(recipients) == 0 {
		return nil, nil // nothing to deliver to
	}
	if h.MSP == nil || !h.MSP.Enabled() {
		return nil, fmt.Errorf("MSP not configured")
	}
	link := strings.TrimRight(h.PublicBaseURL, "/") + "/api/reports/runs/" + runID + "/download"
	subject := "[IPAS] " + name

	switch channel {
	case "im", "wechat":
		vars := map[string]string{"title": name, "rows": fmt.Sprint(len(rs.Rows)), "link": link}
		if err := h.MSP.SendWeChat(ctx, recipients, subject, vars); err != nil {
			return nil, err
		}
	default: // email / webhook → email
		body := htmlReport(name, rs, link)
		if err := h.MSP.SendEmail(ctx, recipients, subject, body); err != nil {
			return nil, err
		}
	}
	return recipients, nil
}

// --- rendering ---

func renderCSV(rs adapter.ResultSet) []byte {
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	head := make([]string, len(rs.Columns))
	for i, c := range rs.Columns {
		head[i] = c.Header
	}
	_ = cw.Write(head)
	for _, row := range rs.Rows {
		rec := make([]string, len(rs.Columns))
		for i, c := range rs.Columns {
			rec[i] = asString(row[c.Key])
		}
		_ = cw.Write(rec)
	}
	cw.Flush()
	return buf.Bytes()
}

func renderXLSX(rs adapter.ResultSet) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()
	sheet := "Sheet1"
	for i, c := range rs.Columns {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		_ = f.SetCellValue(sheet, cell, c.Header)
	}
	for r, row := range rs.Rows {
		for i, c := range rs.Columns {
			cell, _ := excelize.CoordinatesToCellName(i+1, r+2)
			_ = f.SetCellValue(sheet, cell, row[c.Key])
		}
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// htmlReport renders a compact HTML table (first 100 rows) + a download link.
func htmlReport(name string, rs adapter.ResultSet, link string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<h2>%s</h2><p>%d rows · <a href="%s">Download full report</a></p>`,
		html.EscapeString(name), len(rs.Rows), html.EscapeString(link))
	b.WriteString(`<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font:13px sans-serif"><thead><tr>`)
	for _, c := range rs.Columns {
		fmt.Fprintf(&b, "<th>%s</th>", html.EscapeString(c.Header))
	}
	b.WriteString("</tr></thead><tbody>")
	for i, row := range rs.Rows {
		if i >= 100 {
			break
		}
		b.WriteString("<tr>")
		for _, c := range rs.Columns {
			fmt.Fprintf(&b, "<td>%s</td>", html.EscapeString(asString(row[c.Key])))
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table>")
	return b.String()
}

// --- helpers ---

func parseSpec(v any) dto.BuildSpec {
	var s dto.BuildSpec
	if v == nil {
		return s
	}
	raw, err := marshalJSON(v)
	if err != nil {
		return s
	}
	_ = unmarshalJSON(raw, &s)
	return s
}

func splitRecipients(s string) []string {
	out := []string{}
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == ' ' }) {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func strOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func safeName(s string) string {
	if s == "" {
		return "report"
	}
	r := strings.NewReplacer("/", "_", "\\", "_", " ", "_", ":", "_")
	return r.Replace(s)
}
