package authz

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// This file implements the DB-backed effective-permission resolver and the
// runtime system-config service (ARCHITECTURE.md §2). Because production
// Keycloak carries no groups, a caller's permissions come primarily from
// rbac_binding → rbac_role rather than the static auth/rbac.go map.

// --- Runtime system config --------------------------------------------------

// ConfigService reads platform_metadata.system_config with a short TTL cache so
// selected settings (query row-limit cap, Data API default rate limit, default
// role) take effect at runtime without a restart. SetConfig handlers call
// Invalidate so writes are reflected immediately.
type ConfigService struct {
	store *pg.Store
	ttl   time.Duration

	mu    sync.RWMutex
	cache map[string]json.RawMessage
	exp   time.Time
}

// NewConfigService builds a config service with a 30s cache TTL.
func NewConfigService(store *pg.Store) *ConfigService {
	return &ConfigService{store: store, ttl: 30 * time.Second}
}

// Invalidate clears the cache (call after a config write).
func (c *ConfigService) Invalidate() {
	c.mu.Lock()
	c.exp = time.Time{}
	c.mu.Unlock()
}

func (c *ConfigService) snapshot(ctx context.Context) map[string]json.RawMessage {
	c.mu.RLock()
	if c.cache != nil && time.Now().Before(c.exp) {
		m := c.cache
		c.mu.RUnlock()
		return m
	}
	c.mu.RUnlock()

	m := map[string]json.RawMessage{}
	if entries, err := c.store.ListConfig(ctx); err == nil {
		for _, e := range entries {
			m[e.Key] = e.Value
		}
	}
	c.mu.Lock()
	c.cache = m
	c.exp = time.Now().Add(c.ttl)
	c.mu.Unlock()
	return m
}

// Int returns a numeric config value, or def when absent/unparseable.
func (c *ConfigService) Int(ctx context.Context, key string, def int) int {
	raw, ok := c.snapshot(ctx)[key]
	if !ok || len(raw) == 0 {
		return def
	}
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	// tolerate a quoted number ("600")
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if v, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			return v
		}
	}
	return def
}

// String returns a string config value, or def when absent.
func (c *ConfigService) String(ctx context.Context, key, def string) string {
	raw, ok := c.snapshot(ctx)[key]
	if !ok || len(raw) == 0 {
		return def
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil && s != "" {
		return s
	}
	return def
}

// Bool returns a boolean config value, or def when absent.
func (c *ConfigService) Bool(ctx context.Context, key string, def bool) bool {
	raw, ok := c.snapshot(ctx)[key]
	if !ok || len(raw) == 0 {
		return def
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		return b
	}
	return def
}

// --- Effective-permission resolver ------------------------------------------

// RBAC resolves a caller's effective coarse permissions, roles, and tenant by
// merging: (1) static Keycloak-group permissions (dev/legacy), (2) bootstrap
// admins (always full admin), (3) DB role bindings keyed by username/email/org,
// and (4) a default role fallback so a fresh authenticated user still gets a
// read-only baseline rather than a blanket 403.
type RBAC struct {
	store           *pg.Store
	cfg             *ConfigService
	bootstrapAdmins map[string]bool // lowercased username/email
	staticDefault   string          // fallback default role when config unset
	groupAdmins     map[string]bool // lowercased groups granted factory scope "all" (§22.7①)
	factoryID       string          // this instance's site id — the default scope
}

// NewRBAC builds the resolver. bootstrapAdmins and staticDefaultRole come from
// config.Auth; the system_config `auth.default_role` overrides staticDefault.
// groupAdminGroups members get FactoryScope "all"; everyone else is scoped to
// factoryID (this instance's own site).
func NewRBAC(store *pg.Store, cfg *ConfigService, bootstrapAdmins []string, staticDefaultRole string,
	groupAdminGroups []string, factoryID string) *RBAC {
	set := map[string]bool{}
	for _, a := range bootstrapAdmins {
		if a = strings.TrimSpace(strings.ToLower(a)); a != "" {
			set[a] = true
		}
	}
	ga := map[string]bool{}
	for _, g := range groupAdminGroups {
		if g = strings.TrimSpace(strings.ToLower(g)); g != "" {
			ga[g] = true
		}
	}
	return &RBAC{store: store, cfg: cfg, bootstrapAdmins: set, staticDefault: staticDefaultRole,
		groupAdmins: ga, factoryID: factoryID}
}

// Effective computes the authorization state for a verified caller.
func (a *RBAC) Effective(ctx context.Context, claims *auth.Claims) *auth.Authz {
	out := &auth.Authz{Perms: map[auth.Permission]bool{}}
	if claims == nil {
		return out
	}
	add := func(perms ...auth.Permission) {
		for _, p := range perms {
			out.Perms[p] = true
		}
	}
	addStr := func(perms []string) {
		for _, p := range perms {
			out.Perms[auth.Permission(p)] = true
		}
	}
	roleSeen := map[string]bool{}
	addRole := func(name string) {
		if name != "" && !roleSeen[name] {
			roleSeen[name] = true
			out.Roles = append(out.Roles, name)
		}
	}

	// 1. Static group permissions (dev bypass + any future real groups).
	add(auth.PermissionsForGroups(claims.Groups)...)
	for _, g := range claims.Groups {
		addRole(g)
	}

	// 2. Bootstrap admins — full admin regardless of bindings.
	if a.bootstrapAdmins[strings.ToLower(claims.PreferredUsername)] ||
		(claims.Email != "" && a.bootstrapAdmins[strings.ToLower(claims.Email)]) {
		add(auth.AllPermissions()...)
		addRole("platform-admin")
	}

	// 3. DB role bindings keyed by username/email/sub + the caller's orgs.
	subjects := dedupe([]string{claims.PreferredUsername, claims.Email, claims.Subject})
	if claims.PreferredUsername != "" {
		if orgs, err := a.store.OrgsForSubject(ctx, claims.PreferredUsername); err == nil {
			subjects = append(subjects, orgs...)
		}
	}
	if roles, err := a.store.RolesForSubjects(ctx, subjects); err == nil {
		for _, r := range roles {
			addStr(r.Permissions)
			addRole(r.Name)
			if r.TenantID != "" && out.Tenant == "" {
				out.Tenant = r.TenantID
			}
		}
	}

	// Expand the admin wildcard so an admin role passes every gate.
	if out.Perms[auth.PermAdmin] {
		add(auth.AllPermissions()...)
	}

	// 4. Default-role fallback for an authenticated user with no permissions yet.
	if len(out.Perms) == 0 {
		if name := a.defaultRole(ctx); name != "" {
			if r, ok, _ := a.store.RoleByName(ctx, name); ok {
				addStr(r.Permissions)
				addRole(r.Name)
				if out.Perms[auth.PermAdmin] {
					add(auth.AllPermissions()...)
				}
			}
		}
	}

	// Tenant defaults to the seeded 'default' tenant when no binding set one.
	if out.Tenant == "" {
		if id, err := a.store.DefaultTenantID(ctx); err == nil {
			out.Tenant = id
		}
	}

	// Factory scope (§22.7①): permission-independent site visibility. Group
	// admins (designated groups or bootstrap admins) see every factory; everyone
	// else only this instance's own site.
	out.FactoryScope = a.factoryID
	if a.bootstrapAdmins[strings.ToLower(claims.PreferredUsername)] ||
		(claims.Email != "" && a.bootstrapAdmins[strings.ToLower(claims.Email)]) {
		out.FactoryScope = auth.ScopeAll
	}
	for _, g := range claims.Groups {
		if a.groupAdmins[strings.ToLower(g)] {
			out.FactoryScope = auth.ScopeAll
			break
		}
	}
	return out
}

// defaultRole prefers the runtime system_config value, else the static config.
func (a *RBAC) defaultRole(ctx context.Context) string {
	if a.cfg != nil {
		if r := a.cfg.String(ctx, "auth.default_role", ""); r != "" {
			return r
		}
	}
	return a.staticDefault
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
