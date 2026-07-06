package http

import (
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
)

// Me — GET /api/me. The caller's identity (from the verified JWT) enriched with
// Keycloak profile detail. Returns a details list shaped for the Profile page.
func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	username := ""
	name := ""
	email := ""
	if claims != nil {
		username = claims.PreferredUsername
		email = claims.Email
		name = claims.PreferredUsername
	}
	dept := ""
	if username != "" {
		if u, err := h.Adapters.Admin.GetUser(r.Context(), username); err == nil {
			if u.Name != "" {
				name = u.Name
			}
			if u.Email != "" {
				email = u.Email
			}
			dept = u.Org
		}
	}
	// Prefer the resolved effective roles + tenant (DB RBAC); fall back to the
	// raw group claim when no resolver ran.
	roles := []string{}
	tenant := ""
	if az, ok := auth.AuthzFromContext(r.Context()); ok && az != nil {
		roles = az.Roles
		tenant = az.Tenant
	} else if claims != nil {
		roles = claims.Groups
	}

	details := []map[string]any{
		{"dt": "Full name", "dd": name},
		{"dt": "Email", "dd": email},
		{"dt": "Department", "dd": dept},
		{"dt": "Identity source", "dd": "Keycloak (Unified_SSO)"},
		{"dt": "Username", "dd": username},
		{"dt": "Roles", "dd": strings.Join(roles, ", ")},
		{"dt": "Tenant", "dd": tenant},
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name": name, "email": email, "username": username,
		"roles": roles, "tenant": tenant, "details": details,
	})
}

// MeContext — GET /api/me/context. Deployment role + capability flags so the
// SPA renders by role (§22.8) and never shows empty pages: a factory instance
// hides the Federation surface entirely; hybrid (HQ) exposes it.
func (h *Handlers) MeContext(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	name, email := "", ""
	roles := []string{}
	scope := ""
	if claims != nil {
		name = claims.PreferredUsername
		email = claims.Email
		roles = claims.Groups
	}
	if az, ok := auth.AuthzFromContext(r.Context()); ok && az != nil {
		if len(az.Roles) > 0 {
			roles = az.Roles
		}
		scope = az.FactoryScope
	}

	role, factoryID, version := "factory", "", ""
	if h.Cfg != nil {
		role = h.Cfg.Insight.Role
		factoryID = h.Cfg.Insight.FactoryID
		version = h.Cfg.Insight.Version
	}
	if scope == "" {
		scope = factoryID
	}
	hybrid := role == "hybrid"
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{"name": name, "email": email, "roles": roles},
		"deployment": map[string]any{
			"role": role, "factory_id": factoryID, "version": version,
		},
		"factory_scope": scope,
		"capabilities": map[string]bool{
			"data_ops":   true, // factory + hybrid both have local data
			"ai":         true,
			"federation": hybrid, // Federation UI only on hybrid
			"tower":      hybrid,
		},
	})
}

// MyPermissions — GET /api/me/permissions. Effective data-access permissions
// derived from the acl_* policies that apply to the caller's groups, grouped by
// table (Profile "My permissions"). An asset with no column policy + no row
// filter is fully visible.
func (h *Handlers) MyPermissions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	claims, _ := auth.FromContext(ctx)
	groups := claimsGroups(claims)

	// Effective coarse roles (DB RBAC) for display; ABAC data policies below are
	// still resolved per the caller's groups (acl_subject keys on groups).
	roles := groups
	if az, ok := auth.AuthzFromContext(ctx); ok && az != nil && len(az.Roles) > 0 {
		roles = az.Roles
	}

	resp := map[string]any{"roles": roles, "permissions": []map[string]any{}}
	if len(groups) == 0 {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	subjectIDs, err := h.Store.SubjectIDsForGroups(ctx, groups)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "resolve subjects failed")
		return
	}
	idset := map[string]bool{}
	for _, id := range subjectIDs {
		idset[id] = true
	}

	// Collect row filters + column masks per table for the caller's subjects.
	type agg struct {
		rowFilters []string
		masks      []string
	}
	byTable := map[string]*agg{}
	keyOf := func(schema, table string) string { return schema + "." + table }
	get := func(k string) *agg {
		if byTable[k] == nil {
			byTable[k] = &agg{}
		}
		return byTable[k]
	}

	if rows, err := h.Store.ListRowPolicies(ctx); err == nil {
		for _, p := range rows {
			if p.Enabled && idset[p.SubjectID] {
				a := get(keyOf(p.SchemaName, p.TableName))
				a.rowFilters = append(a.rowFilters, p.FilterExpr)
			}
		}
	}
	if cols, err := h.Store.ListColumnPolicies(ctx); err == nil {
		for _, p := range cols {
			if p.Enabled && idset[p.SubjectID] && p.MaskType != "" && p.MaskType != "none" {
				a := get(keyOf(p.SchemaName, p.TableName))
				a.masks = append(a.masks, p.ColumnName+" → "+p.MaskType)
			}
		}
	}

	perms := make([]map[string]any, 0, len(byTable))
	for table, a := range byTable {
		masking := "None"
		parts := append([]string{}, a.masks...)
		for _, f := range a.rowFilters {
			parts = append(parts, "row filter: "+f)
		}
		if len(parts) > 0 {
			masking = strings.Join(parts, ", ")
		}
		perms = append(perms, map[string]any{"asset": table, "access": "Read", "masking": masking})
	}
	sort.Slice(perms, func(i, j int) bool {
		return perms[i]["asset"].(string) < perms[j]["asset"].(string)
	})
	resp["permissions"] = perms
	writeJSON(w, http.StatusOK, resp)
}

// MySessions — GET /api/me/sessions. The caller's active Keycloak sessions.
func (h *Handlers) MySessions(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	username := ""
	if claims != nil {
		username = claims.PreferredUsername
	}
	if username == "" {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	sessions, err := h.Adapters.Admin.ListSessions(r.Context(), username)
	if err != nil {
		h.Log.Error("my sessions", "err", err.Error())
		writeError(w, http.StatusBadGateway, "keycloak unavailable")
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

// DeleteMySession — DELETE /api/me/sessions/{id}. Revokes one session.
func (h *Handlers) DeleteMySession(w http.ResponseWriter, r *http.Request) {
	if err := h.Adapters.Admin.DeleteSession(r.Context(), chi.URLParam(r, "id")); err != nil {
		h.Log.Error("delete session", "err", err.Error())
		writeError(w, http.StatusBadGateway, "revoke failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
