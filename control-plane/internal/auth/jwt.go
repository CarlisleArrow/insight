// Package auth is the control-plane's single authentication boundary
// (ARCHITECTURE.md §1, §2). It verifies Keycloak (Unified_SSO) JWTs against the
// realm JWKS and extracts the coarse `groups` claim used for RBAC.
package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"gitlab.siptory.com/ipas/control-plane/internal/config"
)

// Claims is the subset of the Keycloak token the control plane consumes.
type Claims struct {
	Subject           string   // sub
	PreferredUsername string   // preferred_username
	Email             string   // email
	Groups            []string // coarse RBAC groups (§2.2)
}

// claimsKeyType is an unexported context key type to avoid collisions.
type claimsKeyType struct{}

var claimsKey = claimsKeyType{}

// Authz is the resolved authorization state for a request: the effective coarse
// permission set (after merging groups + DB role bindings + bootstrap/default
// fallbacks), the human-readable roles, and the caller's tenant. It is computed
// once by the middleware when a resolver is configured, then read by
// RequirePermission and by handlers needing tenant scoping (§2, multi-tenancy).
type Authz struct {
	Perms  map[Permission]bool
	Roles  []string
	Tenant string
}

// Has reports whether the resolved set grants perm.
func (a *Authz) Has(p Permission) bool {
	return a != nil && a.Perms[p]
}

type authzKeyType struct{}

var authzKey = authzKeyType{}

// WithAuthz stores the resolved authorization state in the request context.
func WithAuthz(ctx context.Context, a *Authz) context.Context {
	return context.WithValue(ctx, authzKey, a)
}

// AuthzFromContext returns the resolved authorization state, or false when no
// resolver ran (e.g. tests) — callers then fall back to coarse group checks.
func AuthzFromContext(ctx context.Context) (*Authz, bool) {
	a, ok := ctx.Value(authzKey).(*Authz)
	return a, ok
}

// WithClaims stores verified claims in the request context.
func WithClaims(ctx context.Context, c *Claims) context.Context {
	return context.WithValue(ctx, claimsKey, c)
}

// FromContext returns the verified claims, or false if the request was not
// authenticated.
func FromContext(ctx context.Context) (*Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*Claims)
	return c, ok
}

// Verifier validates bearer tokens. The dev variant skips Keycloak entirely.
type Verifier interface {
	Verify(ctx context.Context, rawToken string) (*Claims, error)
}

// oidcVerifier verifies real Keycloak tokens via the realm's JWKS.
type oidcVerifier struct {
	verifier    *oidc.IDTokenVerifier
	groupsClaim string
}

// NewVerifier builds a Verifier. When cfg.Dev.AuthBypass is true it returns a
// devVerifier that injects a synthetic subject so the slice runs without
// Keycloak — this MUST stay off in production.
func NewVerifier(ctx context.Context, cfg *config.Config) (Verifier, error) {
	if cfg.Dev.AuthBypass {
		return &devVerifier{groups: cfg.Dev.BypassGroups}, nil
	}
	provider, err := oidc.NewProvider(ctx, cfg.Keycloak.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery (%s): %w", cfg.Keycloak.Issuer, err)
	}
	// Tokens issued for the `insight` client; verify audience accordingly.
	v := provider.Verifier(&oidc.Config{ClientID: cfg.Keycloak.ClientID})
	return &oidcVerifier{verifier: v, groupsClaim: cfg.Keycloak.GroupsClaim}, nil
}

func (o *oidcVerifier) Verify(ctx context.Context, rawToken string) (*Claims, error) {
	if rawToken == "" {
		return nil, errors.New("empty token")
	}
	tok, err := o.verifier.Verify(ctx, rawToken)
	if err != nil {
		return nil, fmt.Errorf("verify token: %w", err)
	}
	var raw map[string]any
	if err := tok.Claims(&raw); err != nil {
		return nil, fmt.Errorf("decode claims: %w", err)
	}
	return &Claims{
		Subject:           str(raw, "sub"),
		PreferredUsername: str(raw, "preferred_username"),
		Email:             str(raw, "email"),
		Groups:            strSlice(raw[o.groupsClaim]),
	}, nil
}

// devVerifier is the gated local bypass (§ plan: dev.auth_bypass).
type devVerifier struct{ groups []string }

func (d *devVerifier) Verify(_ context.Context, _ string) (*Claims, error) {
	g := d.groups
	if len(g) == 0 {
		g = []string{"data-platform-admin"}
	}
	return &Claims{
		Subject:           "dev-bypass",
		PreferredUsername: "dev",
		Email:             "dev@local",
		Groups:            g,
	}, nil
}

func str(m map[string]any, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

// strSlice coerces a JSON claim into []string. Keycloak emits groups as an
// array of strings; tolerate a single string too.
func strSlice(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	case string:
		return []string{t}
	default:
		return nil
	}
}
