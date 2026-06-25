package http

import (
	"net/http"

	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// ListRowPolicies — GET /api/policies/row.
func (h *Handlers) ListRowPolicies(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.ListRowPolicies(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// CreateRowPolicy — POST /api/policies/row. Ensures the subject row exists for
// the keycloak group, then inserts the row filter.
func (h *Handlers) CreateRowPolicy(w http.ResponseWriter, r *http.Request) {
	var req dto.RowPolicyRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.KeycloakRef == "" || req.Catalog == "" || req.Schema == "" || req.Table == "" || req.FilterExpr == "" {
		writeError(w, http.StatusBadRequest, "keycloak_ref, catalog, schema, table, filter_expr are required")
		return
	}
	ctx := r.Context()
	subjectID, err := h.Store.EnsureSubject(ctx, req.KeycloakRef, "group")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ensure subject failed")
		return
	}
	created, err := h.Store.CreateRowPolicy(ctx, pg.RowPolicy{
		SubjectID:  subjectID,
		Catalog:    req.Catalog,
		SchemaName: req.Schema,
		TableName:  req.Table,
		FilterExpr: req.FilterExpr,
		Enabled:    boolOr(req.Enabled, true),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// ListColumnPolicies — GET /api/policies/column.
func (h *Handlers) ListColumnPolicies(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.ListColumnPolicies(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// CreateColumnPolicy — POST /api/policies/column.
func (h *Handlers) CreateColumnPolicy(w http.ResponseWriter, r *http.Request) {
	var req dto.ColumnPolicyRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.KeycloakRef == "" || req.Catalog == "" || req.Schema == "" || req.Table == "" || req.Column == "" || req.MaskType == "" {
		writeError(w, http.StatusBadRequest, "keycloak_ref, catalog, schema, table, column, mask_type are required")
		return
	}
	ctx := r.Context()
	subjectID, err := h.Store.EnsureSubject(ctx, req.KeycloakRef, "group")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ensure subject failed")
		return
	}
	created, err := h.Store.CreateColumnPolicy(ctx, pg.ColumnPolicy{
		SubjectID:  subjectID,
		Catalog:    req.Catalog,
		SchemaName: req.Schema,
		TableName:  req.Table,
		ColumnName: req.Column,
		MaskType:   req.MaskType,
		MaskExpr:   req.MaskExpr,
		Enabled:    boolOr(req.Enabled, true),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// Preview — POST /api/policies/preview. Runs the query "as" the given groups so
// a steward can see exactly what a subject would receive (§11).
func (h *Handlers) Preview(w http.ResponseWriter, r *http.Request) {
	caller, _ := auth.FromContext(r.Context())
	var req dto.PreviewRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.SQL == "" {
		writeError(w, http.StatusBadRequest, "sql is required")
		return
	}
	// Audit identity records who previewed and on whose behalf.
	ref := subjectRef(caller) + " preview-as " + joinGroups(req.Groups)
	resp, err := h.runQuery(r, req.SQL, req.Target, req.Groups, ref)
	if err != nil {
		h.Log.Error("preview failed", "err", err.Error())
		writeError(w, http.StatusBadGateway, "preview failed")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func joinGroups(g []string) string {
	out := ""
	for i, s := range g {
		if i > 0 {
			out += ","
		}
		out += s
	}
	if out == "" {
		return "(no groups)"
	}
	return out
}
