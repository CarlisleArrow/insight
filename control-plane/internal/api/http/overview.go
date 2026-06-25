package http

import (
	"fmt"
	"net/http"
)

// Overview — GET /api/overview. Aggregates the Home dashboard: KPI tiles, recent
// pipeline runs, pending access requests, and the caller's favorite dashboards.
// Every source is best-effort so one unavailable component degrades gracefully.
func (h *Handlers) Overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	healthy, failed24 := 0, 0
	if conns, err := h.Adapters.Ingest.ListConnectors(ctx); err == nil {
		for _, c := range conns {
			if c.State == "Running" {
				healthy++
			}
		}
	}
	if runs, err := h.Adapters.Orch.ListRuns(ctx, 200); err == nil {
		for _, run := range runs {
			if run.Status == "Failed" {
				failed24++
			}
		}
	}
	assets := 0
	if found, err := h.Adapters.Metadata.Search(ctx, "*"); err == nil {
		assets = len(found)
	}
	alerts := 0
	if issues, err := h.Adapters.Errors.ListIssues(ctx, 50); err == nil {
		alerts = len(issues)
	}

	kpis := []map[string]any{
		{"key": "Healthy pipelines", "icon": "checkmark--filled", "value": fmt.Sprint(healthy), "tone": "ok"},
		{"key": "Failed (24h)", "icon": "error--filled", "value": fmt.Sprint(failed24), "tone": "fail"},
		{"key": "Catalog assets", "icon": "data--base", "value": fmt.Sprint(assets), "tone": ""},
		{"key": "Open alerts", "icon": "warning--filled", "value": fmt.Sprint(alerts), "tone": "warn"},
	}

	// Recent runs (latest 5).
	recent := []map[string]any{}
	if runs, err := h.Adapters.Orch.ListRuns(ctx, 5); err == nil {
		for _, run := range runs {
			recent = append(recent, map[string]any{
				"id": run.ID, "pipe": run.DAG, "status": run.Status, "dur": run.Dur, "when": run.Start,
			})
		}
	}

	// Pending access requests — notification docs flagged request=true.
	requests := []map[string]any{}
	if notifs, err := h.Store.ListDocs(ctx, "notification"); err == nil {
		for _, n := range notifs {
			if req, _ := n["request"].(bool); req {
				requests = append(requests, map[string]any{
					"id": n["id"], "who": n["title"], "role": "access request",
					"target": n["desc"], "when": n["ts"],
				})
			}
		}
	}

	// Favorite dashboards — top few from the dashboards collection.
	favs := []map[string]any{}
	if dashes, err := h.Store.ListDocs(ctx, "dashboard"); err == nil {
		for i, d := range dashes {
			if i >= 3 {
				break
			}
			favs = append(favs, map[string]any{"name": d["name"], "mt": d["mod"]})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"kpis": kpis, "runs": recent, "requests": requests, "favorites": favs,
	})
}
