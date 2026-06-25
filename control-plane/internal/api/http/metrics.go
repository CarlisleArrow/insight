package http

import (
	"net/http"
)

// MetricsList — GET /api/metrics. Business metrics come from the DataHub
// Glossary (authoritative, read-only here — maintained via glossary.yml), merged
// with any locally-defined draft metrics stored in platform_metadata. Each row
// carries `readonly` so the front-end shows glossary terms as managed and only
// lets users edit their own local drafts.
func (h *Handlers) MetricsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := []map[string]any{}

	if terms, err := h.Adapters.Metadata.ListGlossaryTerms(ctx); err != nil {
		h.Log.Warn("glossary terms", "err", err.Error())
	} else {
		for _, t := range terms {
			out = append(out, map[string]any{
				"id": t.URN, "name": t.Name, "def": t.Def, "formula": t.Formula,
				"unit": t.Unit, "owner": t.Owner, "status": t.Status,
				"source": t.Source, "readonly": true,
			})
		}
	}

	if docs, err := h.Store.ListDocs(ctx, "metric"); err == nil {
		for _, d := range docs {
			d["readonly"] = false
			out = append(out, d)
		}
	}

	writeJSON(w, http.StatusOK, out)
}
