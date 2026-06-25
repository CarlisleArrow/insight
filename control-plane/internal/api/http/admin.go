package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// AdminUsers — GET /api/admin/users. View of Keycloak realm users (§11). Each
// row's id is its username so the front-end can target update/delete.
func (h *Handlers) AdminUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.Adapters.Admin.ListUsers(r.Context())
	if err != nil {
		h.Log.Error("admin users", "err", err.Error())
		writeError(w, http.StatusBadGateway, "keycloak unavailable")
		return
	}
	if users == nil {
		users = []adapter.AdminUser{}
	}
	writeJSON(w, http.StatusOK, users)
}

// AdminCreateUser — POST /api/admin/users. Creates a realm user (may fail on an
// LDAP read-only realm — the error is surfaced, not faked).
func (h *Handlers) AdminCreateUser(w http.ResponseWriter, r *http.Request) {
	var u adapter.AdminUser
	if err := decodeJSON(r, &u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	created, err := h.Adapters.Admin.CreateUser(r.Context(), u)
	if err != nil {
		h.Log.Error("create user", "err", err.Error())
		writeError(w, http.StatusBadGateway, "create user failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// AdminUpdateUser — PUT /api/admin/users/{username}.
func (h *Handlers) AdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	var u adapter.AdminUser
	if err := decodeJSON(r, &u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.Adapters.Admin.UpdateUser(r.Context(), username, u); err != nil {
		h.Log.Error("update user", "username", username, "err", err.Error())
		writeError(w, http.StatusBadGateway, "update user failed")
		return
	}
	if u.Username == "" {
		u.Username = username
	}
	writeJSON(w, http.StatusOK, u)
}

// AdminDeleteUser — DELETE /api/admin/users/{username}.
func (h *Handlers) AdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if err := h.Adapters.Admin.DeleteUser(r.Context(), username); err != nil {
		h.Log.Error("delete user", "username", username, "err", err.Error())
		writeError(w, http.StatusBadGateway, "delete user failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
