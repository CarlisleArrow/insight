package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/config"
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
// testHandlers is shared across router tests: telemetry.NewMetrics registers
// on the global Prometheus registry, so it must run only once per process.
var testHandlers = &Handlers{Log: telemetry.NewLogger(), Metrics: telemetry.NewMetrics()}

func TestNewRouterNoPanic(t *testing.T) {
	h := testHandlers
	router := NewRouter(h, devVerifierForTest{}, nil)
	if router == nil {
		t.Fatal("nil router")
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", rec.Code)
	}
}

// TestFederationRoleGate verifies §22.3: the Federation surface exists only on
// a hybrid instance — a factory 404s it even for an admin caller. (The hybrid
// handler itself 500s here because tests run without a store; the gate only
// controls whether the route is mounted.)
func TestFederationRoleGate(t *testing.T) {
	h := testHandlers
	for _, tc := range []struct {
		role      string
		wantMount bool
	}{
		{config.RoleFactory, false},
		{config.RoleHybrid, true},
	} {
		cfg := &config.Config{Insight: config.Insight{Role: tc.role, FactoryID: "fab-a"}}
		router := NewRouter(h, devVerifierForTest{}, cfg)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/federation/lakehouses", nil))
		mounted := rec.Code != http.StatusNotFound
		if mounted != tc.wantMount {
			t.Fatalf("role %s: /api/federation/lakehouses = %d, want mounted=%v", tc.role, rec.Code, tc.wantMount)
		}
	}
}

// TestMeContextByRole verifies /api/me/context reports the deployment role and
// that the federation capability tracks hybrid-ness.
func TestMeContextByRole(t *testing.T) {
	h := testHandlers
	defer func() { h.Cfg = nil }()
	for _, tc := range []struct {
		role    string
		wantFed bool
	}{
		{config.RoleFactory, false},
		{config.RoleHybrid, true},
	} {
		cfg := &config.Config{Insight: config.Insight{Role: tc.role, FactoryID: "fab-a"}}
		h.Cfg = cfg
		router := NewRouter(h, devVerifierForTest{}, cfg)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/me/context", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("role %s: /api/me/context = %d, want 200", tc.role, rec.Code)
		}
		var resp struct {
			Deployment   struct{ Role string }  `json:"deployment"`
			Capabilities map[string]bool        `json:"capabilities"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("role %s: decode: %v", tc.role, err)
		}
		if resp.Deployment.Role != tc.role {
			t.Fatalf("role = %q, want %q", resp.Deployment.Role, tc.role)
		}
		if resp.Capabilities["federation"] != tc.wantFed {
			t.Fatalf("role %s: capabilities.federation = %v, want %v", tc.role, resp.Capabilities["federation"], tc.wantFed)
		}
	}
}
