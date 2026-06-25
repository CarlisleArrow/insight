-- ============================================================
-- platform_metadata schema — the control plane's own store.
-- Verbatim from ARCHITECTURE.md §2.3. Owned by role cp_app.
-- mask_type semantics: deny = column-level (project NULL);
-- full|partial|hash = field-level masking; absent row = fully visible.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS platform_metadata;

-- Subject: binds to a Keycloak group/role (do not duplicate AD users)
CREATE TABLE IF NOT EXISTS platform_metadata.acl_subject (
    subject_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_ref  TEXT NOT NULL,         -- e.g. 'data-analyst-fab1'
    subject_type  TEXT NOT NULL,         -- 'group' | 'role' | 'user'
    description   TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Row-level: inject WHERE filter for a (subject, table)
CREATE TABLE IF NOT EXISTS platform_metadata.acl_row_policy (
    policy_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id    UUID REFERENCES platform_metadata.acl_subject,
    catalog       TEXT NOT NULL,         -- 'iceberg' | 'clickhouse'
    schema_name   TEXT NOT NULL,         -- e.g. 'gold'
    table_name    TEXT NOT NULL,
    filter_expr   TEXT NOT NULL,         -- e.g. "process_id IN ('P1','P2')"
    enabled       BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Column-level (deny) + field-level (mask): one table, mask_type distinguishes
CREATE TABLE IF NOT EXISTS platform_metadata.acl_column_policy (
    policy_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id    UUID REFERENCES platform_metadata.acl_subject,
    catalog       TEXT NOT NULL,
    schema_name   TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    column_name   TEXT NOT NULL,
    mask_type     TEXT NOT NULL,         -- 'deny'|'full'|'partial'|'hash'|'none'
    mask_expr     TEXT,                  -- SQL template for 'partial'
    enabled       BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Audit: every data access decision (for compliance + "preview as user")
CREATE TABLE IF NOT EXISTS platform_metadata.acl_audit (
    audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_ref   TEXT,
    raw_sql       TEXT,
    rewritten_sql TEXT,
    engine        TEXT,                  -- 'trino' | 'clickhouse'
    decided_at    TIMESTAMPTZ DEFAULT now()
);

-- Lookup indexes for policy resolution by (subject, catalog, schema, table).
CREATE INDEX IF NOT EXISTS idx_row_policy_subject
    ON platform_metadata.acl_row_policy (subject_id, catalog, schema_name, table_name);
CREATE INDEX IF NOT EXISTS idx_column_policy_subject
    ON platform_metadata.acl_column_policy (subject_id, catalog, schema_name, table_name);
CREATE INDEX IF NOT EXISTS idx_subject_ref
    ON platform_metadata.acl_subject (keycloak_ref);
