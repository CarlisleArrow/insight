package http

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
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

// --- Roles (rbac_role, §2) ---
//
// Replaces the former free-form `access_role` document collection. Roles now
// carry an enforced permission set; bindings (below) attach them to users so a
// caller actually acquires those permissions. The response keeps the front-end
// table shape ({id, role, members, scope, model, permissions, description}).

type roleBody struct {
	Role        string   `json:"role"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

func (b roleBody) roleName() string {
	if b.Role != "" {
		return b.Role
	}
	return b.Name
}

// AccessRoles — GET /api/access/roles. Lists roles with member counts.
func (h *Handlers) AccessRoles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	roles, err := h.Store.ListRoles(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list roles failed")
		return
	}
	counts, _ := h.Store.CountBindingsByRole(ctx)
	out := make([]map[string]any, 0, len(roles))
	for _, role := range roles {
		out = append(out, roleView(role, counts[role.RoleID]))
	}
	writeJSON(w, http.StatusOK, out)
}

// roleView maps a stored role to the front-end Access-control table shape.
func roleView(role pg.Role, members int) map[string]any {
	perms := role.Permissions
	if perms == nil {
		perms = []string{}
	}
	return map[string]any{
		"id":          role.RoleID,
		"role":        role.Name,
		"members":     members,
		"scope":       strings.Join(perms, " · "),
		"model":       "RBAC",
		"permissions": perms,
		"description": role.Description,
		"system":      role.IsSystem,
	}
}

// AccessCreateRole — POST /api/access/roles.
func (h *Handlers) AccessCreateRole(w http.ResponseWriter, r *http.Request) {
	var b roleBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if b.roleName() == "" {
		writeError(w, http.StatusBadRequest, "role name required")
		return
	}
	created, err := h.Store.CreateRole(r.Context(), pg.Role{
		Name: b.roleName(), Description: b.Description, Permissions: b.Permissions,
	})
	if err != nil {
		h.Log.Error("create role", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "create role failed")
		return
	}
	writeJSON(w, http.StatusCreated, roleView(created, 0))
}

// AccessUpdateRole — PUT /api/access/roles/{id}.
func (h *Handlers) AccessUpdateRole(w http.ResponseWriter, r *http.Request) {
	var b roleBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := h.Store.UpdateRole(r.Context(), chi.URLParam(r, "id"), pg.Role{
		Name: b.roleName(), Description: b.Description, Permissions: b.Permissions,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update role failed")
		return
	}
	writeJSON(w, http.StatusOK, roleView(updated, 0))
}

// AccessDeleteRole — DELETE /api/access/roles/{id}. System roles are protected.
func (h *Handlers) AccessDeleteRole(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteRole(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AccessUserRoles — GET /api/access/users/{username}/roles. The role names bound
// to a user.
func (h *Handlers) AccessUserRoles(w http.ResponseWriter, r *http.Request) {
	bindings, err := h.Store.ListBindingsForSubject(r.Context(), chi.URLParam(r, "username"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list bindings failed")
		return
	}
	names := make([]string, 0, len(bindings))
	for _, b := range bindings {
		names = append(names, b.RoleName)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": names})
}

// AccessSetUserRoles — PUT /api/access/users/{username}/roles. Replaces a user's
// role bindings ({"roles":[...]}). Takes effect on the user's next request
// (effective permissions are resolved per-request).
func (h *Handlers) AccessSetUserRoles(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	var body struct {
		Roles []string `json:"roles"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.Store.SetSubjectRoles(r.Context(), username, "user", body.Roles); err != nil {
		h.Log.Error("set user roles", "username", username, "err", err.Error())
		writeError(w, http.StatusInternalServerError, "set roles failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": body.Roles})
}
