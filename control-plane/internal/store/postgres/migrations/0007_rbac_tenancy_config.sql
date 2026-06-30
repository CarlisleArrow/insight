-- ============================================================
-- RBAC + multi-tenancy + system config — turns the previously document-only
-- admin entities (org / system_config / tenant / access_role) into typed,
-- enforced control-plane services.
--
-- Why: production Keycloak (Unified_SSO) defines no groups/roles, so JWTs carry
-- an empty `groups` claim and the static auth/rbac.go map grants nothing — every
-- real user would be 403. This migration introduces DB-backed roles + bindings
-- (keyed by username/email/org) that the BFF resolves into effective
-- permissions, plus logical tenancy scoping and a runtime config store.
-- ============================================================

-- --- RBAC: roles + bindings -------------------------------------------------

-- A role is a named set of coarse feature permissions (auth.Permission strings,
-- e.g. 'query:run', 'admin:all'). tenant_id NULL = global/system role.
CREATE TABLE IF NOT EXISTS platform_metadata.rbac_role (
    role_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT UNIQUE NOT NULL,
    description TEXT,
    permissions TEXT[] NOT NULL DEFAULT '{}',
    tenant_id   UUID,                        -- NULL = global
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Binds a subject (a username, email, or org name) to a role. This is how a
-- caller acquires permissions when Keycloak carries no groups.
CREATE TABLE IF NOT EXISTS platform_metadata.rbac_binding (
    binding_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject      TEXT NOT NULL,                       -- username | email | org name
    subject_kind TEXT NOT NULL DEFAULT 'user',        -- 'user' | 'org'
    role_id      UUID NOT NULL REFERENCES platform_metadata.rbac_role ON DELETE CASCADE,
    tenant_id    UUID,
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE (subject, subject_kind, role_id)
);

CREATE INDEX IF NOT EXISTS idx_rbac_binding_subject
    ON platform_metadata.rbac_binding (subject, subject_kind);

-- --- Tenancy + organizations ------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_metadata.tenant (
    tenant_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT UNIQUE NOT NULL,
    plan       TEXT NOT NULL DEFAULT 'Standard',       -- 'Enterprise'|'Standard'|'Trial'
    isolation  TEXT NOT NULL DEFAULT 'Shared (RLS)',   -- logical scoping label
    storage    TEXT NOT NULL DEFAULT '0 GB',
    status     TEXT NOT NULL DEFAULT 'Active',         -- 'Active'|'Provisioning'
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_metadata.org (
    org_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT UNIQUE NOT NULL,
    owner      TEXT,
    tenant_id  UUID REFERENCES platform_metadata.tenant ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Explicit org membership (a subject's LDAP-DN org is still used for display).
CREATE TABLE IF NOT EXISTS platform_metadata.org_member (
    org_id  UUID NOT NULL REFERENCES platform_metadata.org ON DELETE CASCADE,
    subject TEXT NOT NULL,                             -- username | email
    PRIMARY KEY (org_id, subject)
);

-- --- System config (runtime-effective) --------------------------------------

CREATE TABLE IF NOT EXISTS platform_metadata.system_config (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'Global',
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- --- Tenant scoping on existing tables (logical) ----------------------------
-- NULL tenant_id = shared/global so pre-existing rows stay visible to everyone.
ALTER TABLE platform_metadata.collection ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE platform_metadata.data_api   ADD COLUMN IF NOT EXISTS tenant_id UUID;

CREATE INDEX IF NOT EXISTS idx_collection_tenant
    ON platform_metadata.collection (collection, tenant_id);

-- --- Seeds ------------------------------------------------------------------

-- Default tenant (every subject without an explicit tenant maps here).
INSERT INTO platform_metadata.tenant (name, plan, isolation, status)
VALUES ('default', 'Enterprise', 'Shared (RLS)', 'Active')
ON CONFLICT (name) DO NOTHING;

-- System roles whose permission sets mirror the static groupPermissions
-- (auth/rbac.go): platform-admin, analyst, viewer.
INSERT INTO platform_metadata.rbac_role (name, description, permissions, is_system)
VALUES
  ('platform-admin', 'Full platform administration',
   ARRAY['query:run','datasets:read','pipelines:read','pipelines:write','catalog:read',
         'policies:read','policies:write','analytics:write','modeling:write','admin:all'], TRUE),
  ('analyst', 'Self-service analytics + modeling',
   ARRAY['query:run','datasets:read','pipelines:read','catalog:read','policies:read',
         'analytics:write','modeling:write'], TRUE),
  ('viewer', 'Read-only access',
   ARRAY['datasets:read','catalog:read'], TRUE)
ON CONFLICT (name) DO NOTHING;

-- Runtime-effective config defaults (see authz.ConfigService).
INSERT INTO platform_metadata.system_config (key, value, scope, updated_by)
VALUES
  ('query.default_row_limit',        '10000', 'Global', 'system'),
  ('dataapi.default_rate_limit_rpm', '600',   'Global', 'system'),
  ('auth.default_role',              '"viewer"', 'Global', 'system')
ON CONFLICT (key) DO NOTHING;
