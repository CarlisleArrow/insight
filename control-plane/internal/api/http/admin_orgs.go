package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Organization management (§2 tenancy). Replaces the former `org` document
// collection with the typed platform_metadata.org table + explicit membership.
// Response keeps the Admin page table shape ({id, org, members, projects, owner}).

type orgBody struct {
	Org      string `json:"org"`
	Name     string `json:"name"`
	Owner    string `json:"owner"`
	TenantID string `json:"tenant_id"`
}

func (b orgBody) orgName() string {
	if b.Org != "" {
		return b.Org
	}
	return b.Name
}

func orgView(o pg.Org, members int) map[string]any {
	return map[string]any{
		"id": o.OrgID, "org": o.Name, "owner": o.Owner,
		"members": members, "projects": 0, "tenant_id": o.TenantID,
	}
}

// AdminOrgs — GET /api/admin/orgs.
func (h *Handlers) AdminOrgs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	orgs, err := h.Store.ListOrgs(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list orgs failed")
		return
	}
	counts, _ := h.Store.CountOrgMembers(ctx)
	out := make([]map[string]any, 0, len(orgs))
	for _, o := range orgs {
		out = append(out, orgView(o, counts[o.OrgID]))
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminCreateOrg — POST /api/admin/orgs.
func (h *Handlers) AdminCreateOrg(w http.ResponseWriter, r *http.Request) {
	var b orgBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if b.orgName() == "" {
		writeError(w, http.StatusBadRequest, "org name required")
		return
	}
	created, err := h.Store.CreateOrg(r.Context(), pg.Org{Name: b.orgName(), Owner: b.Owner, TenantID: b.TenantID})
	if err != nil {
		h.Log.Error("create org", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "create org failed")
		return
	}
	writeJSON(w, http.StatusCreated, orgView(created, 0))
}

// AdminUpdateOrg — PUT /api/admin/orgs/{id}.
func (h *Handlers) AdminUpdateOrg(w http.ResponseWriter, r *http.Request) {
	var b orgBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := h.Store.UpdateOrg(r.Context(), chi.URLParam(r, "id"), pg.Org{Name: b.orgName(), Owner: b.Owner, TenantID: b.TenantID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update org failed")
		return
	}
	writeJSON(w, http.StatusOK, orgView(updated, 0))
}

// AdminDeleteOrg — DELETE /api/admin/orgs/{id}.
func (h *Handlers) AdminDeleteOrg(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteOrg(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete org failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
