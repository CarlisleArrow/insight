package auth

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// Resolver computes a caller's effective authorization state (permissions,
// roles, tenant) from the verified claims. Implemented by authz.RBAC. Optional:
// when nil, RequirePermission falls back to the static coarse-group check.
type Resolver interface {
	Effective(ctx context.Context, claims *Claims) *Authz
}

// Middleware verifies the bearer token on every request and injects Claims into
// the context. This is the only place identity is established (§1). When a
// resolver is supplied it also computes the effective authorization state once
// (DB role bindings + bootstrap/default fallbacks) and stores it in context.
func Middleware(v Verifier, log *slog.Logger, resolver Resolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw := bearer(r)
			claims, err := v.Verify(r.Context(), raw)
			if err != nil {
				log.Warn("auth rejected", "path", r.URL.Path, "err", err.Error())
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			ctx := WithClaims(r.Context(), claims)
			if resolver != nil {
				ctx = WithAuthz(ctx, resolver.Effective(ctx, claims))
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequirePermission gates a handler on a feature permission derived from the
// caller's groups (§2.2 coarse RBAC).
func RequirePermission(perm Permission) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c, ok := FromContext(r.Context())
			if !ok {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			// Prefer the resolved effective permissions (DB roles + fallbacks);
			// fall back to the static coarse-group check when no resolver ran.
			if az, ok := AuthzFromContext(r.Context()); ok {
				if !az.Has(perm) {
					writeErr(w, http.StatusForbidden, "forbidden")
					return
				}
			} else if !HasPermission(c.Groups, perm) {
				writeErr(w, http.StatusForbidden, "forbidden")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const p = "Bearer "
	if strings.HasPrefix(h, p) {
		return strings.TrimSpace(h[len(p):])
	}
	return strings.TrimSpace(h)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
