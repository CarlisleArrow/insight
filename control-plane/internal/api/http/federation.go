package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/trino"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/federation"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Federation (§19). Two surfaces live here:
//   - /api/federation/*        — HQ UI (hybrid only, PermFederationAdmin):
//     lakehouse registry, command dispatch, tower overview, drill.
//   - /federation-ingest/*     — machine surface factories call (hybrid only,
//     gated by the shared token, NOT the user auth middleware): report upload,
//     command pull, result report.
// The factory-side reporter/receiver workers live in internal/federation and
// are wired in main.go.

// staleAfter marks a lakehouse stale when no report arrived for this long.
const staleAfter = 5 * time.Minute

func lakehouseState(l pg.Lakehouse) string {
	if l.LastReportAt == nil {
		return "offline"
	}
	if time.Since(*l.LastReportAt) > staleAfter {
		return "stale"
	}
	return "online"
}

func lakehouseJSON(l pg.Lakehouse) map[string]any {
	report := "never"
	if l.LastReportAt != nil {
		report = fmt.Sprintf("%ds ago", int(time.Since(*l.LastReportAt).Seconds()))
	}
	return map[string]any{
		"id": l.FactoryID, "name": l.Name, "region": l.Region,
		"endpoint": l.Endpoint, "trino_endpoint": l.TrinoEndpoint,
		"version": l.Version, "blueprint": l.Blueprint,
		"state": lakehouseState(l), "health": l.Health, "report": report,
		"last_report_at": l.LastReportAt,
	}
}

// FedListLakehouses — GET /api/federation/lakehouses.
func (h *Handlers) FedListLakehouses(w http.ResponseWriter, r *http.Request) {
	sites, err := h.Store.ListLakehouses(r.Context())
	if err != nil {
		h.Log.Error("list lakehouses", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "list lakehouses failed")
		return
	}
	out := make([]map[string]any, 0, len(sites))
	for _, l := range sites {
		out = append(out, lakehouseJSON(l))
	}
	writeJSON(w, http.StatusOK, out)
}

// FedGetLakehouse — GET /api/federation/lakehouses/{id}. Detail + commands.
func (h *Handlers) FedGetLakehouse(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	l, err := h.Store.GetLakehouse(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "lakehouse not found: "+id)
		return
	}
	out := lakehouseJSON(l)
	if cmds, err := h.Store.ListTowerCommands(r.Context(), id, 50); err == nil {
		out["commands"] = cmds
	}
	writeJSON(w, http.StatusOK, out)
}

// FedDispatchCommand — POST /api/federation/lakehouses/{id}/commands.
// Queues a command; the factory's receiver pulls and executes it (§19.4).
func (h *Handlers) FedDispatchCommand(w http.ResponseWriter, r *http.Request) {
	var cmd pg.TowerCommand
	if err := decodeJSON(r, &cmd); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	cmd.FactoryID = chi.URLParam(r, "id")
	if cmd.Type == "" {
		writeError(w, http.StatusBadRequest, "command type is required")
		return
	}
	claims, _ := auth.FromContext(r.Context())
	cmd.CreatedBy = subjectRef(claims)
	created, err := h.Store.CreateTowerCommand(r.Context(), cmd)
	if err != nil {
		h.Log.Error("dispatch command", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "dispatch failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// FedTowerOverview — GET /api/federation/tower/overview. Aggregate health;
// staleness = now - last_report_at.
func (h *Handlers) FedTowerOverview(w http.ResponseWriter, r *http.Request) {
	sites, err := h.Store.ListLakehouses(r.Context())
	if err != nil {
		h.Log.Error("tower overview", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "overview failed")
		return
	}
	online, stale, offline := 0, 0, 0
	out := make([]map[string]any, 0, len(sites))
	for _, l := range sites {
		switch lakehouseState(l) {
		case "online":
			online++
		case "stale":
			stale++
		default:
			offline++
		}
		out = append(out, lakehouseJSON(l))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"lakehouses": out, "total": len(sites),
		"online": online, "stale": stale, "offline": offline,
	})
}

// FedRollups — GET /api/federation/tower/rollups. Latest cross-site metrics.
func (h *Handlers) FedRollups(w http.ResponseWriter, r *http.Request) {
	rollups, err := h.Store.LatestRollups(r.Context())
	if err != nil {
		h.Log.Error("tower rollups", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "rollups failed")
		return
	}
	writeJSON(w, http.StatusOK, rollups)
}

// FedDrill — POST /api/federation/lakehouses/{id}/drill {sql}. On-demand
// federated query against the target site's Trino (§22.7②). Group-admin
// (factory scope "all") only — a site-scoped caller cannot cross sites.
func (h *Handlers) FedDrill(w http.ResponseWriter, r *http.Request) {
	az, _ := auth.AuthzFromContext(r.Context())
	if az == nil || az.FactoryScope != auth.ScopeAll {
		writeError(w, http.StatusForbidden, "federated drill requires group-admin scope")
		return
	}
	var req struct {
		SQL string `json:"sql"`
	}
	if err := decodeJSON(r, &req); err != nil || req.SQL == "" {
		writeError(w, http.StatusBadRequest, "sql is required")
		return
	}
	l, err := h.Store.GetLakehouse(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "lakehouse not found")
		return
	}
	if l.TrinoEndpoint == "" {
		writeError(w, http.StatusConflict, "site has not reported a trino endpoint")
		return
	}
	cli, err := trino.New(l.TrinoEndpoint, "control-tower")
	if err != nil {
		writeError(w, http.StatusBadGateway, "connect site trino failed")
		return
	}
	rs, err := cli.Execute(r.Context(), req.SQL)
	if err != nil {
		h.Log.Error("federated drill", "site", l.FactoryID, "err", err.Error())
		writeError(w, http.StatusBadGateway, "drill query failed: "+err.Error())
		return
	}
	// Audit the cross-site access like any other data touch.
	claims, _ := auth.FromContext(r.Context())
	if err := h.Store.WriteAudit(r.Context(), pgAudit(subjectRef(claims), req.SQL, req.SQL, "trino:"+l.FactoryID)); err != nil {
		h.Log.Warn("drill audit failed", "err", err.Error())
	}
	writeJSON(w, http.StatusOK, map[string]any{"site": l.FactoryID, "result": rs})
}

// --- Ingest surface (factory → HQ machine calls) ----------------------------

// requireFederationToken gates the ingest surface with the shared token when
// one is configured. Without a token configured the surface is open (trusted
// network) — set CP_FEDERATION_SHARED_TOKEN in production.
func (h *Handlers) requireFederationToken(w http.ResponseWriter, r *http.Request) bool {
	want := ""
	if h.Cfg != nil {
		want = h.Cfg.Federation.SharedToken
	}
	if want == "" || r.Header.Get("X-Federation-Token") == want {
		return true
	}
	writeError(w, http.StatusUnauthorized, "federation token invalid")
	return false
}

// FedIngestReport — POST /federation-ingest/report. Upserts the site registry
// (first report self-registers) and ingests rollup metrics.
func (h *Handlers) FedIngestReport(w http.ResponseWriter, r *http.Request) {
	if !h.requireFederationToken(w, r) {
		return
	}
	var rep federation.Report
	if err := decodeJSON(r, &rep); err != nil {
		writeError(w, http.StatusBadRequest, "invalid report body")
		return
	}
	if rep.FactoryID == "" {
		writeError(w, http.StatusBadRequest, "factory_id is required")
		return
	}
	if err := h.Store.UpsertLakehouseReport(r.Context(), rep.FactoryID, rep.Name,
		rep.Endpoint, rep.TrinoEndpoint, rep.Version, rep.Snapshot); err != nil {
		h.Log.Error("ingest report", "factory", rep.FactoryID, "err", err.Error())
		writeError(w, http.StatusInternalServerError, "ingest failed")
		return
	}
	if len(rep.Metrics) > 0 {
		if err := h.Store.IngestRollups(r.Context(), rep.FactoryID, rep.Metrics); err != nil {
			h.Log.Warn("ingest rollups", "factory", rep.FactoryID, "err", err.Error())
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// FedIngestCommands — GET /federation-ingest/commands?factory_id=. Returns and
// marks pulled the factory's queued commands.
func (h *Handlers) FedIngestCommands(w http.ResponseWriter, r *http.Request) {
	if !h.requireFederationToken(w, r) {
		return
	}
	factoryID := r.URL.Query().Get("factory_id")
	if factoryID == "" {
		writeError(w, http.StatusBadRequest, "factory_id is required")
		return
	}
	cmds, err := h.Store.PullTowerCommands(r.Context(), factoryID)
	if err != nil {
		h.Log.Error("pull commands", "factory", factoryID, "err", err.Error())
		writeError(w, http.StatusInternalServerError, "pull failed")
		return
	}
	out := make([]federation.Command, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, federation.Command{ID: c.ID, Type: c.Type, Payload: c.Payload})
	}
	writeJSON(w, http.StatusOK, out)
}

// FedIngestResult — POST /federation-ingest/report-result.
func (h *Handlers) FedIngestResult(w http.ResponseWriter, r *http.Request) {
	if !h.requireFederationToken(w, r) {
		return
	}
	var res federation.CommandResult
	if err := decodeJSON(r, &res); err != nil {
		writeError(w, http.StatusBadRequest, "invalid result body")
		return
	}
	if err := h.Store.CompleteTowerCommand(r.Context(), res.CommandID, res.Status, res.Result); err != nil {
		h.Log.Error("complete command", "command", res.CommandID, "err", err.Error())
		writeError(w, http.StatusInternalServerError, "complete failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Factory-side worker callbacks (wired in main.go) ------------------------

// FederationSnapshot collects this site's health snapshot + rollup metrics
// (federation.CollectFunc). Component health comes from the existing prober.
func (h *Handlers) FederationSnapshot(ctx context.Context) (federation.Report, error) {
	snapshot := map[string]any{"ts": time.Now().UTC().Format(time.RFC3339)}
	if h.Health != nil {
		probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		statuses := h.Health.Check(probeCtx)
		cancel()
		up, total := 0, len(statuses)
		comps := map[string]string{}
		for _, s := range statuses {
			comps[s.ID] = s.Status
			if s.Status == "Connected" || s.Status == "Degraded" {
				up++
			}
		}
		snapshot["components"] = comps
		snapshot["components_up"] = up
		snapshot["components_total"] = total
	}
	raw, err := marshalJSON(snapshot)
	if err != nil {
		return federation.Report{}, err
	}
	rep := federation.Report{Snapshot: raw}
	if h.Cfg != nil {
		rep.Version = h.Cfg.Insight.Version
		rep.Endpoint = h.Cfg.Server.PublicBaseURL
		rep.TrinoEndpoint = h.Cfg.Adapters.TrinoURL
	}
	return rep, nil
}

// ExecuteFederationCommand runs one tower command via existing capabilities
// (federation.ExecuteFunc). Blueprint/config application respects local policy
// (§19.6): unsupported or gated types are rejected, not failed.
func (h *Handlers) ExecuteFederationCommand(ctx context.Context, cmd federation.Command) (string, error) {
	var payload map[string]any
	_ = json.Unmarshal(cmd.Payload, &payload)
	switch cmd.Type {
	case "trigger_pipeline":
		dag, _ := payload["pipeline_id"].(string)
		if dag == "" {
			return "", fmt.Errorf("trigger_pipeline requires payload.pipeline_id")
		}
		run, err := h.Adapters.Orch.TriggerDAG(ctx, adapter.DAGID(dag), nil)
		if err != nil {
			return "", fmt.Errorf("trigger %s: %w", dag, err)
		}
		return fmt.Sprintf("pipeline %s triggered (run %v)", dag, run), nil
	case "push_config", "apply_blueprint":
		// §19.6: these require local approval flows not yet automated — the
		// factory acknowledges but refuses automatic application.
		return "", federation.ErrRejected{Reason: cmd.Type + " requires local approval on this site"}
	default:
		return "", federation.ErrRejected{Reason: "unknown command type " + cmd.Type}
	}
}
