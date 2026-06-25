-- ============================================================
-- Data API layer (ARCHITECTURE_SUPPLEMENT §15) — publish internal data as
-- governed external REST endpoints (/data-api/v1/<name>). The published
-- contract (column whitelist + allowed filters) + L6 masking is the security
-- boundary; auth_mode only gates the caller ("safe even without auth").
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.data_api (
    api_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT UNIQUE NOT NULL,          -- path segment: /data-api/v1/<name>
    version         TEXT NOT NULL DEFAULT 'v1',
    source_type     TEXT NOT NULL,                 -- 'semantic_model' | 'table' | 'dataset'
    source_ref      TEXT NOT NULL,                 -- model_id | catalog.schema.table | dataset_id
    allowed_columns JSONB NOT NULL DEFAULT '[]',   -- [{src, exposed_as}] whitelist
    allowed_filters JSONB NOT NULL DEFAULT '[]',   -- [{column, ops:[=,>,IN...], required, default}]
    pagination      JSONB,                         -- {default_size, max_size}
    sort_whitelist  JSONB,                         -- [columns sortable]
    auth_mode       TEXT NOT NULL DEFAULT 'none',  -- 'none'|'apikey'|'oauth'|'jwt'
    rate_limit_rpm  INT,                           -- requests/min
    daily_quota     INT,
    max_concurrency INT,
    status          TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'published'|'deprecated'
    owner           TEXT,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_metadata.data_api_key (
    key_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_id     UUID REFERENCES platform_metadata.data_api ON DELETE CASCADE,
    name       TEXT,
    key_hash   TEXT NOT NULL,                      -- sha256 hex; raw shown once at creation
    prefix     TEXT,                               -- display prefix e.g. dak_ab12…
    scopes     JSONB,
    expires_at TIMESTAMPTZ,
    last_used  TIMESTAMPTZ,
    revoked    BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_api_status ON platform_metadata.data_api (status);
CREATE INDEX IF NOT EXISTS idx_data_api_key_api ON platform_metadata.data_api_key (api_id);

-- External Data API call audit reuses acl_audit, with optional api/caller cols.
ALTER TABLE platform_metadata.acl_audit ADD COLUMN IF NOT EXISTS api_id UUID;
ALTER TABLE platform_metadata.acl_audit ADD COLUMN IF NOT EXISTS caller TEXT;
