package http

import (
	"context"
	"net/http"
	"strings"

	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/authz"
)

// Query implements POST /api/query — the full §10.2 masking flow:
//  1. JWT already verified (middleware); resolve the caller's groups.
//  2. authz resolver loads row + column policies for the target.
//  3. call L6 /rewrite (WHERE injected, columns masked).
//  4. router picks ClickHouse vs Trino (§10.1); execute.
//  5. write acl_audit.
func (h *Handlers) Query(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())

	var req dto.QueryRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.SQL) == "" {
		writeError(w, http.StatusBadRequest, "sql is required")
		return
	}

	resp, err := h.runQuery(r, req.SQL, req.Target, claims.Groups, subjectRef(claims))
	if err != nil {
		h.Log.Error("query failed", "err", err.Error())
		writeError(w, http.StatusBadGateway, "query failed")
		return
	}
	h.Metrics.QueriesTotal.WithLabelValues(resp.Engine).Inc()
	writeJSON(w, http.StatusOK, resp)
}

// runQuery is shared by Query and Preview. It resolves policy for the given
// groups, rewrites, routes, executes, and audits.
func (h *Handlers) runQuery(r *http.Request, sql string, t dto.TargetRef, groups []string, subjectRef string) (dto.QueryResponse, error) {
	return h.runQueryCtx(r.Context(), sql, t, groups, subjectRef, "")
}

// runQueryOn is runQuery with an optional forced engine ("trino"|"clickhouse").
// The visual builder forces Trino with fully-qualified names so federation is
// unambiguous (the keyword router can misroute gold_qms to the CH mirror).
func (h *Handlers) runQueryOn(r *http.Request, sql string, t dto.TargetRef, groups []string, subjectRef, forceEngine string) (dto.QueryResponse, error) {
	return h.runQueryCtx(r.Context(), sql, t, groups, subjectRef, forceEngine)
}

// runQueryCtx is the context-based core (used by scheduled report runs that have
// no HTTP request). resolves policy, rewrites, routes, executes, audits.
func (h *Handlers) runQueryCtx(ctx context.Context, sql string, t dto.TargetRef, groups []string, subjectRef, forceEngine string) (dto.QueryResponse, error) {
	decision, err := h.Resolver.Resolve(ctx, groups, authz.Target{
		Catalog: t.Catalog, Schema: t.Schema, Table: t.Table,
	})
	if err != nil {
		return dto.QueryResponse{}, err
	}

	// Route first so we can pass the correct dialect to L6.
	engine, qa := h.Router.Route(sql)
	if forceEngine != "" {
		engine, qa = h.Router.ForEngine(forceEngine)
	}
	dialect := dialectFor(engine)

	rewritten, err := h.Rewrite.Rewrite(ctx, sql, dialect, decision)
	if err != nil {
		return dto.QueryResponse{}, err
	}

	rs, err := qa.Execute(ctx, rewritten)
	if err != nil {
		return dto.QueryResponse{}, err
	}

	// Audit the decision (§10.2 step 6). Audit failure must not fail the query.
	if auditErr := h.Store.WriteAudit(ctx, pgAudit(subjectRef, sql, rewritten, engine)); auditErr != nil {
		h.Log.Warn("audit write failed", "err", auditErr.Error())
	}

	return dto.QueryResponse{Engine: engine, RewrittenSQL: rewritten, Result: rs}, nil
}
