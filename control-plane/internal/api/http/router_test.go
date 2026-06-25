package http

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/telemetry"
)

// devVerifierForTest satisfies auth.Verifier so the router can be constructed
// without Keycloak; it injects a synthetic admin caller.
type devVerifierForTest struct{}

func (devVerifierForTest) Verify(_ context.Context, _ string) (*auth.Claims, error) {
	return &auth.Claims{Groups: []string{auth.GroupPlatformAdmin}}, nil
}

// TestNewRouterNoPanic ensures the full route table registers without chi
// panicking on conflicting patterns (e.g. /pipelines/dag vs /pipelines/{id})
// and that the unauthenticated /healthz route responds.
func TestNewRouterNoPanic(t *testing.T) {
	h := &Handlers{Log: telemetry.NewLogger(), Metrics: telemetry.NewMetrics()}
	router := NewRouter(h, devVerifierForTest{})
	if router == nil {
		t.Fatal("nil router")
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", rec.Code)
	}
}
