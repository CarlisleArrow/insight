package http

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter/conntest"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// TestDataSource — POST /api/datasources/test {type,host,port,database,username,
// password}. Opens a REAL connection with the supplied credentials and probes it
// (Ping / SELECT 1 / broker metadata). Credentials are used only for this test
// and are never stored. Real network call from the BFF.
func (h *Handlers) TestDataSource(w http.ResponseWriter, r *http.Request) {
	var spec conntest.Spec
	if err := decodeJSON(r, &spec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if spec.Host == "" {
		writeError(w, http.StatusBadRequest, "host is required")
		return
	}
	res := conntest.Test(r.Context(), spec)
	writeJSON(w, http.StatusOK, res)
}

// ListDataSourceTables — POST /api/datasources/tables {type,host,port,database,
// username,password}. Opens a REAL connection and returns the source's tables
// (for the Create-pipeline wizard). Credentials transient, not stored.
func (h *Handlers) ListDataSourceTables(w http.ResponseWriter, r *http.Request) {
	var spec conntest.Spec
	if err := decodeJSON(r, &spec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if spec.Host == "" {
		writeError(w, http.StatusBadRequest, "host is required")
		return
	}
	tables, err := conntest.ListTables(r.Context(), spec)
	if err != nil {
		h.Log.Warn("list source tables", "type", spec.Type, "err", err.Error())
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if tables == nil {
		tables = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tables": tables})
}

// ListDataSources — GET /api/datasources. Backs the DevConfig "Data sources"
// page with LIVE state: the platform's core data-infrastructure components are
// health-probed at request time (Connected/Degraded/Error), then any
// user-registered custom sources are appended (also probed). Nothing here is a
// stored/seeded status — it reflects the actual cluster.
func (h *Handlers) ListDataSources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	out := []map[string]any{}
	if h.Health != nil {
		for _, s := range h.Health.Check(ctx) {
			out = append(out, map[string]any{
				"id": s.ID, "name": s.Name, "type": s.Type, "host": s.Host,
				"status": s.Status, "tested": s.Tested, "readonly": s.ReadOnly,
			})
		}
	}

	// User-registered sources (platform_metadata.datasource): probe each host so
	// its status is live too, not the value stored at create time.
	custom, err := h.Store.ListDataSources(ctx)
	if err != nil {
		h.Log.Warn("list custom datasources", "err", err.Error())
		custom = nil
	}
	for _, d := range custom {
		status := d.Status
		if h.Health != nil && d.Host != "" {
			status = h.Health.ProbeHost(ctx, hostPort(d.Host))
		}
		out = append(out, map[string]any{
			"id": d.ID, "name": d.Name, "type": d.Type, "host": d.Host,
			"status": status, "tested": "live", "readonly": false,
		})
	}

	writeJSON(w, http.StatusOK, out)
}

// hostPort strips a scheme prefix so an arbitrary registered host is dialable.
func hostPort(h string) string {
	if i := strings.Index(h, "://"); i >= 0 {
		return h[i+3:]
	}
	return h
}

// CreateDataSource — POST /api/datasources.
func (h *Handlers) CreateDataSource(w http.ResponseWriter, r *http.Request) {
	var d pg.DataSource
	if err := decodeJSON(r, &d); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if d.Name == "" || d.Type == "" || d.Host == "" {
		writeError(w, http.StatusBadRequest, "name, type, host are required")
		return
	}
	created, err := h.Store.CreateDataSource(r.Context(), d)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// UpdateDataSource — PUT /api/datasources/{id}.
func (h *Handlers) UpdateDataSource(w http.ResponseWriter, r *http.Request) {
	var d pg.DataSource
	if err := decodeJSON(r, &d); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	d.ID = chi.URLParam(r, "id")
	updated, err := h.Store.UpdateDataSource(r.Context(), d)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update failed")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// DeleteDataSource — DELETE /api/datasources/{id}.
func (h *Handlers) DeleteDataSource(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteDataSource(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
