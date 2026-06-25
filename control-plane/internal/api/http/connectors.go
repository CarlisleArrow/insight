package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// CreateConnector — POST /api/connectors. Registers a Debezium CDC connector
// directly (DevConfig "CDC / sync" page). For a full multi-component pipeline
// use POST /api/pipelines (the saga).
func (h *Handlers) CreateConnector(w http.ResponseWriter, r *http.Request) {
	var spec adapter.ConnectorSpec
	if err := decodeJSON(r, &spec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if spec.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	id, err := h.Adapters.Ingest.CreateConnector(r.Context(), spec)
	if err != nil {
		h.Log.Error("create connector", "err", err.Error())
		writeError(w, http.StatusBadGateway, "create connector failed")
		return
	}
	status, err := h.Adapters.Ingest.GetConnectorStatus(r.Context(), id)
	if err != nil {
		// The connector was created; return a minimal record if status read fails.
		writeJSON(w, http.StatusCreated, adapter.ConnectorStatus{ID: id, Name: spec.Name})
		return
	}
	writeJSON(w, http.StatusCreated, status)
}

// UpdateConnector — PUT /api/connectors/{id}. Upserts the connector config.
func (h *Handlers) UpdateConnector(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var spec adapter.ConnectorSpec
	if err := decodeJSON(r, &spec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	status, err := h.Adapters.Ingest.UpdateConnector(r.Context(), adapter.ConnectorID(id), spec)
	if err != nil {
		h.Log.Error("update connector", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "update connector failed")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// DeleteConnector — DELETE /api/connectors/{id}.
func (h *Handlers) DeleteConnector(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.Adapters.Ingest.DeleteConnector(r.Context(), adapter.ConnectorID(id)); err != nil {
		h.Log.Error("delete connector", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "delete connector failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
