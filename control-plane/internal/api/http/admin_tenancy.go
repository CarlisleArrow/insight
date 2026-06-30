package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Tenant management (§2 multi-tenancy, logical scoping). Replaces the former
// `tenant` document collection with the typed platform_metadata.tenant table.
// Response keeps the Admin page table shape ({id, tenant, plan, isolation,
// storage, status}).

type tenantBody struct {
	Tenant    string `json:"tenant"`
	Name      string `json:"name"`
	Plan      string `json:"plan"`
	Isolation string `json:"isolation"`
	Storage   string `json:"storage"`
	Status    string `json:"status"`
}

func (b tenantBody) tenantName() string {
	if b.Tenant != "" {
		return b.Tenant
	}
	return b.Name
}

func tenantView(t pg.Tenant) map[string]any {
	return map[string]any{
		"id": t.TenantID, "tenant": t.Name, "plan": t.Plan,
		"isolation": t.Isolation, "storage": t.Storage, "status": t.Status,
	}
}

// AdminTenancy — GET /api/admin/tenancy.
func (h *Handlers) AdminTenancy(w http.ResponseWriter, r *http.Request) {
	tenants, err := h.Store.ListTenants(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list tenants failed")
		return
	}
	out := make([]map[string]any, 0, len(tenants))
	for _, t := range tenants {
		out = append(out, tenantView(t))
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminCreateTenant — POST /api/admin/tenancy.
func (h *Handlers) AdminCreateTenant(w http.ResponseWriter, r *http.Request) {
	var b tenantBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if b.tenantName() == "" {
		writeError(w, http.StatusBadRequest, "tenant name required")
		return
	}
	created, err := h.Store.CreateTenant(r.Context(), pg.Tenant{
		Name: b.tenantName(), Plan: b.Plan, Isolation: b.Isolation, Storage: b.Storage, Status: b.Status,
	})
	if err != nil {
		h.Log.Error("create tenant", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "create tenant failed")
		return
	}
	writeJSON(w, http.StatusCreated, tenantView(created))
}

// AdminUpdateTenant — PUT /api/admin/tenancy/{id}.
func (h *Handlers) AdminUpdateTenant(w http.ResponseWriter, r *http.Request) {
	var b tenantBody
	if err := decodeJSON(r, &b); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := h.Store.UpdateTenant(r.Context(), chi.URLParam(r, "id"), pg.Tenant{
		Name: b.tenantName(), Plan: b.Plan, Isolation: b.Isolation, Storage: b.Storage, Status: b.Status,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update tenant failed")
		return
	}
	writeJSON(w, http.StatusOK, tenantView(updated))
}

// AdminDeleteTenant — DELETE /api/admin/tenancy/{id}. The 'default' tenant is
// protected (the store ignores deletion of it).
func (h *Handlers) AdminDeleteTenant(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteTenant(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete tenant failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
