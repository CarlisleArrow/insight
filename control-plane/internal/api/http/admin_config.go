package http

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// System configuration (§4 runtime-effective). Replaces the former
// `system_config` document collection with the typed platform_metadata.
// system_config table. Selected keys are read at runtime via the ConfigService
// (query.default_row_limit, dataapi.default_rate_limit_rpm, auth.default_role),
// so writes call Invalidate to take effect immediately. Response keeps the
// Admin page table shape ({id:key, key, val, scope, by}).

type configBody struct {
	Key   string `json:"key"`
	Val   string `json:"val"`
	Scope string `json:"scope"`
	By    string `json:"by"`
}

// toJSONValue stores a free-text value with its natural JSON type so runtime
// readers get clean typing: bools and numbers are stored bare, everything else
// as a JSON string.
func toJSONValue(s string) json.RawMessage {
	t := strings.TrimSpace(s)
	switch strings.ToLower(t) {
	case "true":
		return json.RawMessage(`true`)
	case "false":
		return json.RawMessage(`false`)
	}
	if _, err := strconv.ParseInt(t, 10, 64); err == nil {
		return json.RawMessage(t)
	}
	if _, err := strconv.ParseFloat(t, 64); err == nil {
		return json.RawMessage(t)
	}
	b, _ := json.Marshal(s)
	return b
}

// displayVal renders a stored JSON value back to a flat string for the table.
func displayVal(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

func configView(c pg.ConfigEntry) map[string]any {
	return map[string]any{
		"id": c.Key, "key": c.Key, "val": displayVal(c.Value),
		"scope": c.Scope, "by": c.UpdatedBy,
	}
}

// AdminConfig — GET /api/admin/config.
func (h *Handlers) AdminConfig(w http.ResponseWriter, r *http.Request) {
	entries, err := h.Store.ListConfig(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list config failed")
		return
	}
	out := make([]map[string]any, 0, len(entries))
	for _, c := range entries {
		out = append(out, configView(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminSetConfig — POST /api/admin/config. Upserts by key.
func (h *Handlers) AdminSetConfig(w http.ResponseWriter, r *http.Request) {
	var b configBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if b.Key == "" {
		writeError(w, http.StatusBadRequest, "config key required")
		return
	}
	h.setConfig(w, r, b)
}

// AdminUpdateConfig — PUT /api/admin/config/{id}. {id} is the config key.
func (h *Handlers) AdminUpdateConfig(w http.ResponseWriter, r *http.Request) {
	var b configBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if b.Key == "" {
		b.Key = chi.URLParam(r, "id")
	}
	h.setConfig(w, r, b)
}

func (h *Handlers) setConfig(w http.ResponseWriter, r *http.Request, b configBody) {
	by := b.By
	if by == "" {
		if c, ok := auth.FromContext(r.Context()); ok {
			by = subjectRef(c)
		}
	}
	saved, err := h.Store.SetConfig(r.Context(), pg.ConfigEntry{
		Key: b.Key, Value: toJSONValue(b.Val), Scope: b.Scope, UpdatedBy: by,
	})
	if err != nil {
		h.Log.Error("set config", "key", b.Key, "err", err.Error())
		writeError(w, http.StatusInternalServerError, "set config failed")
		return
	}
	if h.Config != nil {
		h.Config.Invalidate() // runtime readers pick up the change immediately
	}
	writeJSON(w, http.StatusOK, configView(saved))
}

// AdminDeleteConfig — DELETE /api/admin/config/{id}. {id} is the config key.
func (h *Handlers) AdminDeleteConfig(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteConfig(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete config failed")
		return
	}
	if h.Config != nil {
		h.Config.Invalidate()
	}
	w.WriteHeader(http.StatusNoContent)
}
