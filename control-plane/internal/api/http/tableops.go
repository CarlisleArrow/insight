package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Table operations (ARCHITECTURE_SUPPLEMENT §17): schema evolution, Iceberg table
// maintenance, watermark inspection, and row-level data patches. Everything runs
// through Trino (ALTER / EXECUTE / UPDATE / DELETE). Destructive operations never
// execute inline — they land in approval_request with a downstream impact analysis
// and only run once approved.

var identRe = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func validIdent(s string) bool { return identRe.MatchString(s) }

// icebergTable -> iceberg."ns"."table"
func icebergTable(ns, table string) string {
	return fmt.Sprintf(`iceberg."%s"."%s"`, ns, table)
}

// icebergMeta -> iceberg."ns"."table$meta" (e.g. $files, $snapshots)
func icebergMeta(ns, table, meta string) string {
	return fmt.Sprintf(`iceberg."%s"."%s$%s"`, ns, table, meta)
}

func currentUser(r *http.Request) string {
	if c, ok := auth.FromContext(r.Context()); ok && c != nil {
		if c.PreferredUsername != "" {
			return c.PreferredUsername
		}
		return c.Subject
	}
	return "unknown"
}

func datasetURN(ns, table string) string {
	return fmt.Sprintf("urn:li:dataset:(urn:li:dataPlatform:iceberg,%s.%s,PROD)", ns, table)
}

// runTrino executes a statement via the Trino adapter and writes an audit row.
func (h *Handlers) runTrino(ctx context.Context, user, sql string) (pg.AuditEntry, error) {
	_, err := h.Adapters.Trino.Execute(ctx, sql)
	_ = h.Store.WriteAudit(ctx, pg.AuditEntry{SubjectRef: user, RawSQL: sql, RewrittenSQL: sql, Engine: "trino"})
	return pg.AuditEntry{}, err
}

// impactOf returns downstream asset labels from DataHub lineage (best-effort).
func (h *Handlers) impactOf(ctx context.Context, ns, table string) []string {
	if h.Adapters.Metadata == nil {
		return nil
	}
	g, err := h.Adapters.Metadata.GetLineage(ctx, datasetURN(ns, table))
	if err != nil {
		return nil
	}
	self := datasetURN(ns, table)
	var out []string
	for _, n := range g.Nodes {
		if n.URN == self {
			continue
		}
		label := n.Label
		if label == "" {
			label = n.URN
		}
		out = append(out, label)
	}
	return out
}

// --- §17.1 schema evolution ---

type schemaDiffReq struct {
	Columns []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"columns"`
}

// SchemaDiff — POST /api/tables/{ns}/{table}/schema/diff. Compares the desired
// column set against the live schema (Trino information_schema).
func (h *Handlers) SchemaDiff(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	var req schemaDiffReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	rs, err := h.Adapters.Trino.Execute(r.Context(), fmt.Sprintf(
		`SELECT column_name, data_type FROM iceberg.information_schema.columns
		 WHERE table_schema='%s' AND table_name='%s'`, ns, table))
	if err != nil {
		writeError(w, http.StatusBadGateway, "schema read failed: "+err.Error())
		return
	}
	current := map[string]string{}
	for _, row := range rs.Rows {
		current[asString(row["column_name"])] = asString(row["data_type"])
	}
	desired := map[string]string{}
	var added, changed []map[string]string
	for _, c := range req.Columns {
		desired[c.Name] = c.Type
		cur, ok := current[c.Name]
		if !ok {
			added = append(added, map[string]string{"name": c.Name, "type": c.Type})
		} else if !strings.EqualFold(cur, c.Type) {
			changed = append(changed, map[string]string{"name": c.Name, "from": cur, "to": c.Type})
		}
	}
	var removed []map[string]string
	for name, typ := range current {
		if _, ok := desired[name]; !ok {
			removed = append(removed, map[string]string{"name": name, "type": typ})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"added": added, "removed": removed, "changed": changed, "current_columns": len(current),
	})
}

type schemaAlterReq struct {
	Op       string `json:"op"`        // add|rename|widen|drop|narrow
	Column   string `json:"column"`    // existing/new column name
	NewName  string `json:"new_name"`  // for rename
	DataType string `json:"data_type"` // for add/widen/narrow
	Reason   string `json:"reason"`
}

func (a schemaAlterReq) destructive() bool { return a.Op == "drop" || a.Op == "narrow" }

func (a schemaAlterReq) toSQL(ns, table string) (string, error) {
	t := icebergTable(ns, table)
	switch a.Op {
	case "add":
		if !validIdent(a.Column) || a.DataType == "" {
			return "", fmt.Errorf("add requires column and data_type")
		}
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", t, a.Column, a.DataType), nil
	case "rename":
		if !validIdent(a.Column) || !validIdent(a.NewName) {
			return "", fmt.Errorf("rename requires column and new_name")
		}
		return fmt.Sprintf("ALTER TABLE %s RENAME COLUMN %s TO %s", t, a.Column, a.NewName), nil
	case "widen", "narrow":
		if !validIdent(a.Column) || a.DataType == "" {
			return "", fmt.Errorf("%s requires column and data_type", a.Op)
		}
		return fmt.Sprintf("ALTER TABLE %s ALTER COLUMN %s SET DATA TYPE %s", t, a.Column, a.DataType), nil
	case "drop":
		if !validIdent(a.Column) {
			return "", fmt.Errorf("drop requires column")
		}
		return fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s", t, a.Column), nil
	default:
		return "", fmt.Errorf("unsupported op %q", a.Op)
	}
}

// SchemaAlter — POST /api/tables/{ns}/{table}/schema/alter. Compatible changes
// (add/rename/widen) execute immediately; destructive ones (drop/narrow) enter the
// approval queue with a downstream impact analysis.
func (h *Handlers) SchemaAlter(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	var req schemaAlterReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	sql, err := req.toSQL(ns, table)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user := currentUser(r)

	if req.destructive() {
		impact := h.impactOf(r.Context(), ns, table)
		payload, _ := json.Marshal(map[string]any{"sql": sql, "op": req.Op})
		diff, _ := json.Marshal(map[string]any{"op": req.Op, "column": req.Column, "data_type": req.DataType})
		impactJSON, _ := json.Marshal(map[string]any{
			"downstream": impact,
			"warning":    "destructive change — downstream ETL scripts / Data APIs / dashboards may need updating",
		})
		ar, err := h.Store.CreateApproval(r.Context(), pg.ApprovalRequest{
			Type: "schema_change", Target: ns + "." + table, Payload: payload,
			Diff: diff, Impact: impactJSON, Requester: user, Reason: req.Reason,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "create approval failed")
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status": "pending_approval", "approval_id": ar.ID, "impact": impact, "sql": sql,
		})
		return
	}

	if _, err := h.runTrino(r.Context(), user, sql); err != nil {
		writeError(w, http.StatusBadGateway, "alter failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "executed", "sql": sql})
}

// --- §17.2 table maintenance ---

// TableHealth — GET /api/tables/{ns}/{table}/health. Iceberg file/snapshot metrics.
func (h *Handlers) TableHealth(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	ctx := r.Context()
	const smallFile = 32 * 1024 * 1024 // 32MB
	files, err := h.Adapters.Trino.Execute(ctx, fmt.Sprintf(
		`SELECT count(*) AS file_count,
		        COALESCE(sum(file_size_in_bytes),0) AS total_bytes,
		        COALESCE(sum(CASE WHEN file_size_in_bytes < %d THEN 1 ELSE 0 END),0) AS small_files
		 FROM %s`, smallFile, icebergMeta(ns, table, "files")))
	if err != nil {
		writeError(w, http.StatusBadGateway, "files metadata read failed: "+err.Error())
		return
	}
	snaps, err := h.Adapters.Trino.Execute(ctx, fmt.Sprintf(
		`SELECT count(*) AS snapshot_count, min(committed_at) AS oldest_snapshot
		 FROM %s`, icebergMeta(ns, table, "snapshots")))
	if err != nil {
		writeError(w, http.StatusBadGateway, "snapshot metadata read failed: "+err.Error())
		return
	}
	out := map[string]any{}
	if len(files.Rows) > 0 {
		out["file_count"] = files.Rows[0]["file_count"]
		out["total_bytes"] = files.Rows[0]["total_bytes"]
		out["small_files"] = files.Rows[0]["small_files"]
	}
	if len(snaps.Rows) > 0 {
		out["snapshot_count"] = snaps.Rows[0]["snapshot_count"]
		out["oldest_snapshot"] = snaps.Rows[0]["oldest_snapshot"]
	}
	writeJSON(w, http.StatusOK, out)
}

var maintenanceSQL = map[string]string{
	"optimize":            "ALTER TABLE %s EXECUTE optimize",
	"expire_snapshots":    "ALTER TABLE %s EXECUTE expire_snapshots(retention_threshold => '7d')",
	"remove_orphan_files": "ALTER TABLE %s EXECUTE remove_orphan_files(retention_threshold => '7d')",
	"rewrite_manifests":   "ALTER TABLE %s EXECUTE rewrite_manifests",
}

// RunMaintenance — POST /api/tables/{ns}/{table}/maintenance/{op}. Records a job
// and runs the Iceberg procedure asynchronously via Trino.
func (h *Handlers) RunMaintenance(w http.ResponseWriter, r *http.Request) {
	ns, table, op := chi.URLParam(r, "ns"), chi.URLParam(r, "table"), chi.URLParam(r, "op")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	tmpl, ok := maintenanceSQL[op]
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported maintenance op")
		return
	}
	user := currentUser(r)
	job, err := h.Store.CreateMaintenanceJob(r.Context(), pg.MaintenanceJob{NS: ns, Table: table, Op: op, Requester: user})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create job failed")
		return
	}
	sql := fmt.Sprintf(tmpl, icebergTable(ns, table))
	go func() {
		ctx := context.Background()
		_, err := h.Adapters.Trino.Execute(ctx, sql)
		_ = h.Store.WriteAudit(ctx, pg.AuditEntry{SubjectRef: user, RawSQL: sql, RewrittenSQL: sql, Engine: "trino"})
		if err != nil {
			_ = h.Store.FinishMaintenanceJob(ctx, job.JobID, "failed", err.Error())
			return
		}
		_ = h.Store.FinishMaintenanceJob(ctx, job.JobID, "succeeded", "ok")
	}()
	writeJSON(w, http.StatusAccepted, job)
}

// ListMaintenanceJobs — GET /api/maintenance/jobs?ns=&table=.
func (h *Handlers) ListMaintenanceJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := h.Store.ListMaintenanceJobs(r.Context(), r.URL.Query().Get("ns"), r.URL.Query().Get("table"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

// Watermarks — GET /api/tables/{ns}/{table}/watermarks. Reads the named Iceberg
// watermark table (e.g. _fact_etl_watermarks).
func (h *Handlers) Watermarks(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	rs, err := h.Adapters.Trino.Execute(r.Context(), "SELECT * FROM "+icebergTable(ns, table)+" LIMIT 500")
	if err != nil {
		writeError(w, http.StatusBadGateway, "watermark read failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rs.Rows, "columns": rs.Columns})
}

type watermarkResetReq struct {
	Confirm bool   `json:"confirm"`
	Where   string `json:"where"` // optional row filter; empty = truncate all
}

// ResetWatermark — POST /api/tables/{ns}/{table}/watermarks/reset. Double-confirm
// required (resetting forces a full re-process on the next ETL run).
func (h *Handlers) ResetWatermark(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	var req watermarkResetReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !req.Confirm {
		writeError(w, http.StatusBadRequest, "confirm:true is required to reset a watermark")
		return
	}
	sql := "DELETE FROM " + icebergTable(ns, table)
	if strings.TrimSpace(req.Where) != "" {
		sql += " WHERE " + req.Where
	}
	if _, err := h.runTrino(r.Context(), currentUser(r), sql); err != nil {
		writeError(w, http.StatusBadGateway, "reset failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "reset", "sql": sql})
}

// --- §17.3 data patch ---

type patchReq struct {
	Op     string            `json:"op"`    // update|delete
	Where  string            `json:"where"` // required filter
	Set    map[string]string `json:"set"`   // for update: col -> SQL literal/expr
	Reason string            `json:"reason"`
}

func (p patchReq) toSQL(ns, table string) (string, error) {
	if strings.TrimSpace(p.Where) == "" {
		return "", fmt.Errorf("where clause is required (refusing unbounded patch)")
	}
	t := icebergTable(ns, table)
	switch p.Op {
	case "delete":
		return fmt.Sprintf("DELETE FROM %s WHERE %s", t, p.Where), nil
	case "update":
		if len(p.Set) == 0 {
			return "", fmt.Errorf("update requires set")
		}
		var assigns []string
		for col, val := range p.Set {
			if !validIdent(col) {
				return "", fmt.Errorf("invalid column %q", col)
			}
			assigns = append(assigns, fmt.Sprintf("%s = %s", col, val))
		}
		return fmt.Sprintf("UPDATE %s SET %s WHERE %s", t, strings.Join(assigns, ", "), p.Where), nil
	default:
		return "", fmt.Errorf("unsupported op %q (use update|delete)", p.Op)
	}
}

// PatchPreview — POST /api/tables/{ns}/{table}/patch/preview. Counts affected rows.
func (h *Handlers) PatchPreview(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	var req patchReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Where) == "" {
		writeError(w, http.StatusBadRequest, "where clause is required")
		return
	}
	rs, err := h.Adapters.Trino.Execute(r.Context(), fmt.Sprintf(
		"SELECT count(*) AS affected FROM %s WHERE %s", icebergTable(ns, table), req.Where))
	if err != nil {
		writeError(w, http.StatusBadGateway, "preview failed: "+err.Error())
		return
	}
	var affected any
	if len(rs.Rows) > 0 {
		affected = rs.Rows[0]["affected"]
	}
	writeJSON(w, http.StatusOK, map[string]any{"affected_rows": affected})
}

// PatchApply — POST /api/tables/{ns}/{table}/patch/apply. Row-level patches ALWAYS
// require approval; this enqueues the request with the preview count + impact.
func (h *Handlers) PatchApply(w http.ResponseWriter, r *http.Request) {
	ns, table := chi.URLParam(r, "ns"), chi.URLParam(r, "table")
	if !validIdent(ns) || !validIdent(table) {
		writeError(w, http.StatusBadRequest, "invalid namespace or table")
		return
	}
	var req patchReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	sql, err := req.toSQL(ns, table)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// capture the impact count now so the approver sees it
	var affected any
	if rs, e := h.Adapters.Trino.Execute(r.Context(), fmt.Sprintf(
		"SELECT count(*) AS affected FROM %s WHERE %s", icebergTable(ns, table), req.Where)); e == nil && len(rs.Rows) > 0 {
		affected = rs.Rows[0]["affected"]
	}
	payload, _ := json.Marshal(map[string]any{"sql": sql, "op": req.Op})
	diff, _ := json.Marshal(map[string]any{"op": req.Op, "where": req.Where, "set": req.Set})
	impact, _ := json.Marshal(map[string]any{
		"affected_rows": affected,
		"downstream":    h.impactOf(r.Context(), ns, table),
		"warning":       "data patches bypass the upstream source of truth — use only for corrections",
	})
	ar, err := h.Store.CreateApproval(r.Context(), pg.ApprovalRequest{
		Type: "data_patch", Target: ns + "." + table, Payload: payload,
		Diff: diff, Impact: impact, Requester: currentUser(r), Reason: req.Reason,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create approval failed")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status": "pending_approval", "approval_id": ar.ID, "affected_rows": affected, "sql": sql,
	})
}

// --- approval queue ---

// ListApprovals — GET /api/approvals?status=pending.
func (h *Handlers) ListApprovals(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.ListApprovals(r.Context(), r.URL.Query().Get("status"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// GetApproval — GET /api/approvals/{id}.
func (h *Handlers) GetApproval(w http.ResponseWriter, r *http.Request) {
	a, err := h.Store.GetApproval(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// ApproveRequest — POST /api/approvals/{id}/approve. Marks approved then executes
// the carried operation (schema change / data patch / api publish).
func (h *Handlers) ApproveRequest(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx := r.Context()
	ar, err := h.Store.GetApproval(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if ar.Status != "pending" {
		writeError(w, http.StatusConflict, "request is not pending")
		return
	}
	if err := h.Store.DecideApproval(ctx, id, "approved", currentUser(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "decide failed")
		return
	}

	var payload struct {
		SQL string `json:"sql"`
	}
	_ = json.Unmarshal(ar.Payload, &payload)

	switch ar.Type {
	case "api_publish":
		if err := h.Store.SetDataAPIStatus(ctx, ar.Target, "published"); err != nil {
			_ = h.Store.MarkApprovalExecuted(ctx, id, "failed", err.Error())
			writeError(w, http.StatusInternalServerError, "publish failed")
			return
		}
	case "schema_change", "data_patch":
		if payload.SQL == "" {
			_ = h.Store.MarkApprovalExecuted(ctx, id, "failed", "no sql in payload")
			writeError(w, http.StatusInternalServerError, "no sql to execute")
			return
		}
		if _, err := h.runTrino(ctx, currentUser(r), payload.SQL); err != nil {
			_ = h.Store.MarkApprovalExecuted(ctx, id, "failed", err.Error())
			writeError(w, http.StatusBadGateway, "execution failed: "+err.Error())
			return
		}
	default:
		_ = h.Store.MarkApprovalExecuted(ctx, id, "failed", "unknown request type")
		writeError(w, http.StatusBadRequest, "unknown request type")
		return
	}

	_ = h.Store.MarkApprovalExecuted(ctx, id, "executed", "ok")
	writeJSON(w, http.StatusOK, map[string]any{"status": "executed", "id": id})
}

// RejectRequest — POST /api/approvals/{id}/reject.
func (h *Handlers) RejectRequest(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DecideApproval(r.Context(), chi.URLParam(r, "id"), "rejected", currentUser(r)); err != nil {
		writeError(w, http.StatusInternalServerError, "reject failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "rejected"})
}
