package http

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"github.com/go-chi/chi/v5"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// --- Data API management (internal, RBAC-gated) — §15 ---

// ListDataAPIs — GET /api/data-apis.
func (h *Handlers) ListDataAPIs(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.ListDataAPIs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// GetDataAPIHandler — GET /api/data-apis/{id}.
func (h *Handlers) GetDataAPIHandler(w http.ResponseWriter, r *http.Request) {
	a, err := h.Store.GetDataAPI(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// CreateDataAPIHandler — POST /api/data-apis.
func (h *Handlers) CreateDataAPIHandler(w http.ResponseWriter, r *http.Request) {
	var a pg.DataAPI
	if err := decodeJSON(r, &a); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if a.Name == "" || a.SourceType == "" || a.SourceRef == "" {
		writeError(w, http.StatusBadRequest, "name, source_type, source_ref are required")
		return
	}
	created, err := h.Store.CreateDataAPI(r.Context(), a)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// UpdateDataAPIHandler — PUT /api/data-apis/{id}.
func (h *Handlers) UpdateDataAPIHandler(w http.ResponseWriter, r *http.Request) {
	var a pg.DataAPI
	if err := decodeJSON(r, &a); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	a.APIID = chi.URLParam(r, "id")
	updated, err := h.Store.UpdateDataAPI(r.Context(), a)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update failed")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// DeleteDataAPIHandler — DELETE /api/data-apis/{id}.
func (h *Handlers) DeleteDataAPIHandler(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteDataAPI(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PublishDataAPI — POST /api/data-apis/{id}/publish (draft → published).
func (h *Handlers) PublishDataAPI(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.SetDataAPIStatus(r.Context(), chi.URLParam(r, "id"), "published"); err != nil {
		writeError(w, http.StatusInternalServerError, "publish failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DeprecateDataAPI — POST /api/data-apis/{id}/deprecate.
func (h *Handlers) DeprecateDataAPI(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.SetDataAPIStatus(r.Context(), chi.URLParam(r, "id"), "deprecated"); err != nil {
		writeError(w, http.StatusInternalServerError, "deprecate failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- API keys ---

// ListDataAPIKeysHandler — GET /api/data-apis/{id}/keys.
func (h *Handlers) ListDataAPIKeysHandler(w http.ResponseWriter, r *http.Request) {
	keys, err := h.Store.ListDataAPIKeys(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, keys)
}

// CreateDataAPIKeyHandler — POST /api/data-apis/{id}/keys. Mints a key, stores
// only its sha256 hash, and returns the raw key ONCE.
func (h *Handlers) CreateDataAPIKeyHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	_ = decodeJSON(r, &body)

	raw := "dak_" + randHex(20)
	sum := sha256.Sum256([]byte(raw))
	k := pg.DataAPIKey{
		APIID:   chi.URLParam(r, "id"),
		Name:    body.Name,
		KeyHash: hex.EncodeToString(sum[:]),
		Prefix:  raw[:12] + "…",
	}
	created, err := h.Store.CreateDataAPIKey(r.Context(), k)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create key failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"key_id": created.KeyID, "prefix": created.Prefix, "name": created.Name,
		"key": raw, // one-time plaintext
	})
}

// DeleteDataAPIKeyHandler — DELETE /api/data-apis/{id}/keys/{keyId}.
func (h *Handlers) DeleteDataAPIKeyHandler(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteDataAPIKey(r.Context(), chi.URLParam(r, "keyId")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
