package http

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
)

// widgetResult is one rendered widget (chart data + the engine that ran it).
type widgetResult struct {
	ID        string           `json:"id"`
	Title     string           `json:"title"`
	Type      string           `json:"type"`
	Engine    string           `json:"engine"`
	ChartData []dto.ChartPoint `json:"chartData"`
	Error     string           `json:"error,omitempty"`
}

// DashboardRender — POST /api/dashboards/{id}/render?widget=. Executes each
// widget's stored query spec through the build pipeline and returns chart data.
// ?widget=first renders only the first widget (used by the gallery thumbnail).
func (h *Handlers) DashboardRender(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	claims, _ := auth.FromContext(ctx)

	doc, err := h.Store.GetDoc(ctx, "dashboard", chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "dashboard not found")
		return
	}

	widgets := parseWidgets(doc["widgets"])
	onlyFirst := r.URL.Query().Get("widget") == "first"

	out := []widgetResult{}
	for _, wd := range widgets {
		if wd.Spec.Dataset.Table == "" {
			continue // unconfigured widget — skip (no fake data)
		}
		res := widgetResult{ID: wd.ID, Title: wd.Title, Type: wd.Type}
		sql, cErr := h.compileBuildSpec(ctx, wd.Spec)
		if cErr != nil {
			res.Error = cErr.Error()
			out = append(out, res)
			if onlyFirst {
				break
			}
			continue
		}
		resp, qErr := h.runQueryOn(r, sql, wd.Spec.Dataset, claimsGroups(claims), subjectRef(claims), "trino")
		if qErr != nil {
			res.Error = qErr.Error()
		} else {
			res.Engine = resp.Engine
			res.ChartData = toChartData(resp.Result, wd.Spec)
		}
		out = append(out, res)
		if onlyFirst {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"widgets": out})
}

// widgetDoc is the stored widget shape (layout + query spec).
type widgetDoc struct {
	ID    string        `json:"id"`
	Title string        `json:"title"`
	Type  string        `json:"type"`
	Spec  dto.BuildSpec `json:"spec"`
}

// parseWidgets coerces the doc's loosely-typed widgets array into typed structs.
func parseWidgets(v any) []widgetDoc {
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var out []widgetDoc
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
