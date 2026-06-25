-- ============================================================
-- datasource — registered DB/lakehouse/stream connections managed by the
-- control plane (DevConfig "Data sources" page, §11 /api/datasources).
-- Lives in the control plane's own platform_metadata schema.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.datasource (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,        -- Oracle|MySQL|SQL Server|Iceberg|ClickHouse|Kafka
    host        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'Connected', -- Connected|Error|Degraded
    tested      TEXT,                 -- human label, e.g. '2 min ago'
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_datasource_name ON platform_metadata.datasource (name);
