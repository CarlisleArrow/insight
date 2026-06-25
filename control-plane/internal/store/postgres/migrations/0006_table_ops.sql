-- ============================================================
-- Table operations & governance (ARCHITECTURE_SUPPLEMENT §17).
--   approval_request — generic approval queue shared by destructive schema
--     changes, data patches and Data API publishes (type discriminator).
--   maintenance_job  — async Iceberg table-maintenance runs (optimize /
--     expire_snapshots / remove_orphan_files / rewrite_manifests).
-- Destructive operations never execute inline — they land here first and only
-- run once approved, carrying the impact analysis captured at request time.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.approval_request (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT NOT NULL,                       -- 'schema_change'|'data_patch'|'api_publish'
    target      TEXT NOT NULL,                       -- 'ns.table' (or api name)
    payload     JSONB NOT NULL,                      -- the operation to run once approved
    diff        JSONB,                               -- human-readable change summary
    impact      JSONB,                               -- downstream assets (lineage) at request time
    status      TEXT NOT NULL DEFAULT 'pending',     -- pending|approved|rejected|executed|failed
    requester   TEXT,
    reason      TEXT,
    approver    TEXT,
    result      TEXT,                                -- execution outcome / error
    created_at  TIMESTAMPTZ DEFAULT now(),
    decided_at  TIMESTAMPTZ,
    executed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_status ON platform_metadata.approval_request (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_type ON platform_metadata.approval_request (type);

CREATE TABLE IF NOT EXISTS platform_metadata.maintenance_job (
    job_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ns          TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    op          TEXT NOT NULL,                       -- optimize|expire_snapshots|remove_orphan_files|rewrite_manifests
    status      TEXT NOT NULL DEFAULT 'running',     -- running|succeeded|failed
    result      TEXT,
    requester   TEXT,
    started_at  TIMESTAMPTZ DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_maintenance_table ON platform_metadata.maintenance_job (ns, table_name, started_at DESC);
