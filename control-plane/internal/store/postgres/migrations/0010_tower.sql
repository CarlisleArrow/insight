-- ============================================================
-- Group Control Tower (§19.7) — HQ-side registry of factory lakehouses,
-- the command queue factories pull from, and cross-site metric rollups.
-- The schema is created everywhere (migrations are uniform) but only a
-- hybrid instance mounts routes that read/write it.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS tower;

CREATE TABLE IF NOT EXISTS tower.lakehouse (
    factory_id     TEXT PRIMARY KEY,          -- e.g. fab-a
    name           TEXT,
    region         TEXT,
    endpoint       TEXT,                      -- site control-plane base URL (drill/ops)
    trino_endpoint TEXT,                      -- site Trino for federated drill (§22.7②)
    version        TEXT,
    blueprint      TEXT,
    health         JSONB DEFAULT '{}',        -- last report snapshot
    last_report_at TIMESTAMPTZ,
    registered_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tower.command (
    command_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    factory_id   TEXT NOT NULL REFERENCES tower.lakehouse ON DELETE CASCADE,
    type         TEXT NOT NULL,               -- trigger_pipeline|push_config|apply_blueprint
    payload      JSONB DEFAULT '{}',
    status       TEXT DEFAULT 'queued',       -- queued|pulled|done|failed|rejected
    result       TEXT,
    created_by   TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    pulled_at    TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS command_factory_status_idx
    ON tower.command (factory_id, status, created_at);

CREATE TABLE IF NOT EXISTS tower.metric_rollup (
    factory_id TEXT NOT NULL,
    metric     TEXT NOT NULL,                 -- e.g. cpk, yield
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    value      DOUBLE PRECISION,
    PRIMARY KEY (factory_id, metric, ts)
);
