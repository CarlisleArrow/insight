package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// This file is the data-access layer for the RBAC + tenancy + system-config
// services (migration 0007). Roles hold coarse permission strings
// (auth.Permission); bindings attach a subject (username/email/org) to a role;
// tenants/orgs provide logical scoping; system_config backs runtime-effective
// settings.

// --- Domain types -----------------------------------------------------------

type Role struct {
	RoleID      string    `json:"role_id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Permissions []string  `json:"permissions"`
	TenantID    string    `json:"tenant_id,omitempty"`
	IsSystem    bool      `json:"is_system"`
	CreatedAt   time.Time `json:"created_at"`
}

type Binding struct {
	BindingID   string   `json:"binding_id"`
	Subject     string   `json:"subject"`
	SubjectKind string   `json:"subject_kind"`
	RoleID      string   `json:"role_id"`
	RoleName    string   `json:"role_name,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	TenantID    string   `json:"tenant_id,omitempty"`
}

type Tenant struct {
	TenantID  string    `json:"tenant_id"`
	Name      string    `json:"name"`
	Plan      string    `json:"plan"`
	Isolation string    `json:"isolation"`
	Storage   string    `json:"storage"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

type Org struct {
	OrgID     string    `json:"org_id"`
	Name      string    `json:"name"`
	Owner     string    `json:"owner"`
	TenantID  string    `json:"tenant_id,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type ConfigEntry struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	Scope     string          `json:"scope"`
	UpdatedBy string          `json:"updated_by"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// --- Roles ------------------------------------------------------------------

func (s *Store) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT role_id::text, name, COALESCE(description,''), permissions,
		       COALESCE(tenant_id::text,''), is_system, created_at
		FROM platform_metadata.rbac_role ORDER BY is_system DESC, name`)
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.RoleID, &r.Name, &r.Description, &r.Permissions,
			&r.TenantID, &r.IsSystem, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RoleByName fetches one role by its unique name (used to resolve the default
// role's permission set). ok=false when no such role exists.
func (s *Store) RoleByName(ctx context.Context, name string) (Role, bool, error) {
	var r Role
	err := s.pool.QueryRow(ctx, `
		SELECT role_id::text, name, COALESCE(description,''), permissions,
		       COALESCE(tenant_id::text,''), is_system, created_at
		FROM platform_metadata.rbac_role WHERE name=$1`, name).
		Scan(&r.RoleID, &r.Name, &r.Description, &r.Permissions, &r.TenantID, &r.IsSystem, &r.CreatedAt)
	if err != nil {
		return Role{}, false, nil // not found or scan error → treat as absent
	}
	return r, true, nil
}

func (s *Store) CreateRole(ctx context.Context, r Role) (Role, error) {
	if r.Permissions == nil {
		r.Permissions = []string{}
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.rbac_role (name, description, permissions, tenant_id, is_system)
		VALUES ($1,$2,$3,$4,FALSE)
		RETURNING role_id::text, created_at`,
		r.Name, nullable(r.Description), r.Permissions, nullable(r.TenantID),
	).Scan(&r.RoleID, &r.CreatedAt)
	if err != nil {
		return Role{}, fmt.Errorf("create role: %w", err)
	}
	return r, nil
}

func (s *Store) UpdateRole(ctx context.Context, id string, r Role) (Role, error) {
	if r.Permissions == nil {
		r.Permissions = []string{}
	}
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.rbac_role
		SET name=$2, description=$3, permissions=$4, tenant_id=$5, updated_at=now()
		WHERE role_id=$1`,
		id, r.Name, nullable(r.Description), r.Permissions, nullable(r.TenantID))
	if err != nil {
		return Role{}, fmt.Errorf("update role: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return Role{}, fmt.Errorf("role %s not found", id)
	}
	r.RoleID = id
	return r, nil
}

// DeleteRole removes a non-system role (system roles are protected).
func (s *Store) DeleteRole(ctx context.Context, id string) error {
	ct, err := s.pool.Exec(ctx,
		`DELETE FROM platform_metadata.rbac_role WHERE role_id=$1 AND is_system=FALSE`, id)
	if err != nil {
		return fmt.Errorf("delete role: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("role %s not found or is a protected system role", id)
	}
	return nil
}

// CountBindingsByRole returns role_id → number of distinct subjects bound.
func (s *Store) CountBindingsByRole(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT role_id::text, count(DISTINCT subject)
		FROM platform_metadata.rbac_binding GROUP BY role_id`)
	if err != nil {
		return nil, fmt.Errorf("count bindings: %w", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// --- Bindings ---------------------------------------------------------------

// RolesForSubjects returns the roles bound to any of the given subjects
// (usernames, emails, or org names). Used by the effective-permission resolver.
func (s *Store) RolesForSubjects(ctx context.Context, subjects []string) ([]Role, error) {
	if len(subjects) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT r.role_id::text, r.name, COALESCE(r.description,''), r.permissions,
		       COALESCE(r.tenant_id::text,''), r.is_system, r.created_at
		FROM platform_metadata.rbac_binding b
		JOIN platform_metadata.rbac_role r ON r.role_id = b.role_id
		WHERE b.subject = ANY($1)`, subjects)
	if err != nil {
		return nil, fmt.Errorf("roles for subjects: %w", err)
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.RoleID, &r.Name, &r.Description, &r.Permissions,
			&r.TenantID, &r.IsSystem, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListBindingsForSubject returns the role bindings (with role name + perms) for
// one subject — backs the per-user "roles" view.
func (s *Store) ListBindingsForSubject(ctx context.Context, subject string) ([]Binding, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT b.binding_id::text, b.subject, b.subject_kind, r.role_id::text, r.name,
		       r.permissions, COALESCE(b.tenant_id::text,'')
		FROM platform_metadata.rbac_binding b
		JOIN platform_metadata.rbac_role r ON r.role_id = b.role_id
		WHERE b.subject = $1 ORDER BY r.name`, subject)
	if err != nil {
		return nil, fmt.Errorf("bindings for subject: %w", err)
	}
	defer rows.Close()
	out := []Binding{}
	for rows.Next() {
		var b Binding
		if err := rows.Scan(&b.BindingID, &b.Subject, &b.SubjectKind, &b.RoleID,
			&b.RoleName, &b.Permissions, &b.TenantID); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// SetSubjectRoles replaces all of a subject's role bindings with the given role
// names (transactional). Unknown role names are ignored.
func (s *Store) SetSubjectRoles(ctx context.Context, subject, subjectKind string, roleNames []string) error {
	if subjectKind == "" {
		subjectKind = "user"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM platform_metadata.rbac_binding WHERE subject=$1 AND subject_kind=$2`,
		subject, subjectKind); err != nil {
		return fmt.Errorf("clear bindings: %w", err)
	}
	for _, name := range roleNames {
		if name == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO platform_metadata.rbac_binding (subject, subject_kind, role_id)
			SELECT $1, $2, role_id FROM platform_metadata.rbac_role WHERE name=$3
			ON CONFLICT (subject, subject_kind, role_id) DO NOTHING`,
			subject, subjectKind, name); err != nil {
			return fmt.Errorf("bind role %s: %w", name, err)
		}
	}
	return tx.Commit(ctx)
}

// --- Tenants ----------------------------------------------------------------

func (s *Store) ListTenants(ctx context.Context) ([]Tenant, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT tenant_id::text, name, plan, isolation, storage, status, created_at
		FROM platform_metadata.tenant ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list tenants: %w", err)
	}
	defer rows.Close()
	out := []Tenant{}
	for rows.Next() {
		var t Tenant
		if err := rows.Scan(&t.TenantID, &t.Name, &t.Plan, &t.Isolation,
			&t.Storage, &t.Status, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) CreateTenant(ctx context.Context, t Tenant) (Tenant, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.tenant (name, plan, isolation, storage, status)
		VALUES ($1, COALESCE(NULLIF($2,''),'Standard'), COALESCE(NULLIF($3,''),'Shared (RLS)'),
		        COALESCE(NULLIF($4,''),'0 GB'), COALESCE(NULLIF($5,''),'Active'))
		RETURNING tenant_id::text, plan, isolation, storage, status, created_at`,
		t.Name, t.Plan, t.Isolation, t.Storage, t.Status,
	).Scan(&t.TenantID, &t.Plan, &t.Isolation, &t.Storage, &t.Status, &t.CreatedAt)
	if err != nil {
		return Tenant{}, fmt.Errorf("create tenant: %w", err)
	}
	return t, nil
}

func (s *Store) UpdateTenant(ctx context.Context, id string, t Tenant) (Tenant, error) {
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.tenant
		SET name=$2, plan=$3, isolation=$4, storage=$5, status=$6, updated_at=now()
		WHERE tenant_id=$1`,
		id, t.Name, t.Plan, t.Isolation, t.Storage, t.Status)
	if err != nil {
		return Tenant{}, fmt.Errorf("update tenant: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return Tenant{}, fmt.Errorf("tenant %s not found", id)
	}
	t.TenantID = id
	return t, nil
}

func (s *Store) DeleteTenant(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM platform_metadata.tenant WHERE tenant_id=$1 AND name<>'default'`, id)
	if err != nil {
		return fmt.Errorf("delete tenant: %w", err)
	}
	return nil
}

// DefaultTenantID returns the seeded 'default' tenant id (cached-friendly, cheap).
func (s *Store) DefaultTenantID(ctx context.Context) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT tenant_id::text FROM platform_metadata.tenant WHERE name='default'`).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("default tenant: %w", err)
	}
	return id, nil
}

// --- Orgs -------------------------------------------------------------------

func (s *Store) ListOrgs(ctx context.Context) ([]Org, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.org_id::text, o.name, COALESCE(o.owner,''), COALESCE(o.tenant_id::text,''), o.created_at
		FROM platform_metadata.org o ORDER BY o.name`)
	if err != nil {
		return nil, fmt.Errorf("list orgs: %w", err)
	}
	defer rows.Close()
	out := []Org{}
	for rows.Next() {
		var o Org
		if err := rows.Scan(&o.OrgID, &o.Name, &o.Owner, &o.TenantID, &o.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// CountOrgMembers returns org_id → member count.
func (s *Store) CountOrgMembers(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT org_id::text, count(*) FROM platform_metadata.org_member GROUP BY org_id`)
	if err != nil {
		return nil, fmt.Errorf("count org members: %w", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

func (s *Store) CreateOrg(ctx context.Context, o Org) (Org, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.org (name, owner, tenant_id)
		VALUES ($1, $2, $3) RETURNING org_id::text, created_at`,
		o.Name, nullable(o.Owner), nullable(o.TenantID),
	).Scan(&o.OrgID, &o.CreatedAt)
	if err != nil {
		return Org{}, fmt.Errorf("create org: %w", err)
	}
	return o, nil
}

func (s *Store) UpdateOrg(ctx context.Context, id string, o Org) (Org, error) {
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.org SET name=$2, owner=$3, tenant_id=$4, updated_at=now()
		WHERE org_id=$1`,
		id, o.Name, nullable(o.Owner), nullable(o.TenantID))
	if err != nil {
		return Org{}, fmt.Errorf("update org: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return Org{}, fmt.Errorf("org %s not found", id)
	}
	o.OrgID = id
	return o, nil
}

func (s *Store) DeleteOrg(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.org WHERE org_id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete org: %w", err)
	}
	return nil
}

// OrgsForSubject returns the org names a subject explicitly belongs to.
func (s *Store) OrgsForSubject(ctx context.Context, subject string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT o.name FROM platform_metadata.org_member m
		JOIN platform_metadata.org o ON o.org_id = m.org_id
		WHERE m.subject = $1`, subject)
	if err != nil {
		return nil, fmt.Errorf("orgs for subject: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// --- System config ----------------------------------------------------------

func (s *Store) ListConfig(ctx context.Context) ([]ConfigEntry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT key, value, scope, COALESCE(updated_by,''), updated_at
		FROM platform_metadata.system_config ORDER BY key`)
	if err != nil {
		return nil, fmt.Errorf("list config: %w", err)
	}
	defer rows.Close()
	out := []ConfigEntry{}
	for rows.Next() {
		var c ConfigEntry
		if err := rows.Scan(&c.Key, &c.Value, &c.Scope, &c.UpdatedBy, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetConfig upserts a typed config entry (value is raw JSON).
func (s *Store) SetConfig(ctx context.Context, c ConfigEntry) (ConfigEntry, error) {
	if c.Scope == "" {
		c.Scope = "Global"
	}
	if len(c.Value) == 0 {
		c.Value = json.RawMessage(`null`)
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.system_config (key, value, scope, updated_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, scope=EXCLUDED.scope,
			updated_by=EXCLUDED.updated_by, updated_at=now()
		RETURNING updated_at`,
		c.Key, []byte(c.Value), c.Scope, nullable(c.UpdatedBy),
	).Scan(&c.UpdatedAt)
	if err != nil {
		return ConfigEntry{}, fmt.Errorf("set config: %w", err)
	}
	return c, nil
}

func (s *Store) DeleteConfig(ctx context.Context, key string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.system_config WHERE key=$1`, key)
	if err != nil {
		return fmt.Errorf("delete config: %w", err)
	}
	return nil
}
