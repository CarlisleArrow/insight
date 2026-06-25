// Package http hosts the BFF REST handlers (ARCHITECTURE.md §11). It is the only
// surface the front-end calls; every handler runs behind the auth middleware.
package http

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/health"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/msp"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/authz"
	"gitlab.siptory.com/ipas/control-plane/internal/orchestrator"
	"gitlab.siptory.com/ipas/control-plane/internal/query"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
	"gitlab.siptory.com/ipas/control-plane/internal/telemetry"
)

// Handlers bundles the dependencies shared by all BFF endpoints.
type Handlers struct {
	Log           *slog.Logger
	Metrics       *telemetry.Metrics
	Store         *pg.Store
	Resolver      *authz.Resolver
	Rewrite       *query.RewriteClient
	Router        *query.Router
	Adapters      adapter.Set
	Orchestrator  *orchestrator.Orchestrator
	Health        *health.Prober
	Quality       *QualityCache
	MSP           *msp.Client
	PublicBaseURL string          // for report download links in delivered messages
	Verifier      auth.Verifier   // for Data API oauth/jwt auth modes (§15)
	APILimiter    *APIRateLimiter // Data API per-(api,caller) rate limiting
	DAGsDir       string          // shared RWX volume: generated DAGs (§16 deploy)
	CodegenDir    string          // shared RWX volume: generated ETL scripts (§16)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func decodeJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}
