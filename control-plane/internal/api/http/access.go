package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// AccessUsers — GET /api/access/users. Realm users mapped to the Governance
// access-control "Users" tab shape ({name,email,role,status,username}). Reads
// Keycloak via the admin adapter (same source as /api/admin/users).
func (h *Handlers) AccessUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.Adapters.Admin.ListUsers(r.Context())
	if err != nil {
		h.Log.Error("access users", "err", err.Error())
		writeError(w, http.StatusBadGateway, "keycloak unavailable")
		return
	}
	out := make([]map[string]any, 0, len(users))
	for _, u := range users {
		out = append(out, map[string]any{
			"name": u.Name, "email": u.Email, "role": u.Role, "status": u.Status, "username": u.Username,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// AccessCreateUser — POST /api/access/users. Invites/creates a realm user.
func (h *Handlers) AccessCreateUser(w http.ResponseWriter, r *http.Request) {
	var u adapter.AdminUser
	if err := decodeJSON(r, &u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if u.Status == "" {
		u.Status = "Invited"
	}
	created, err := h.Adapters.Admin.CreateUser(r.Context(), u)
	if err != nil {
		h.Log.Error("access create user", "err", err.Error())
		writeError(w, http.StatusBadGateway, "create user failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"name": created.Name, "email": created.Email, "role": created.Role,
		"status": created.Status, "username": created.Username,
	})
}

// AccessUpdateUser — PUT /api/access/users/{username}.
func (h *Handlers) AccessUpdateUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	var u adapter.AdminUser
	if err := decodeJSON(r, &u); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.Adapters.Admin.UpdateUser(r.Context(), username, u); err != nil {
		h.Log.Error("access update user", "username", username, "err", err.Error())
		writeError(w, http.StatusBadGateway, "update user failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AccessDeleteUser — DELETE /api/access/users/{username}.
func (h *Handlers) AccessDeleteUser(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	if err := h.Adapters.Admin.DeleteUser(r.Context(), username); err != nil {
		h.Log.Error("access delete user", "username", username, "err", err.Error())
		writeError(w, http.StatusBadGateway, "delete user failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
