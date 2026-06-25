-- ============================================================
-- Modeling-as-Code meta-model (ARCHITECTURE_SUPPLEMENT §16.4). Visual star-schema
-- modeling writes this IR; the code generator (internal/codegen) reads it and
-- renders ETL/DAG templates. The drag-drop UI never emits script strings — the
-- IR is the contract between modeling and generation.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.dwm_model (
    model_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    domain     TEXT,
    status     TEXT NOT NULL DEFAULT 'draft',   -- 'draft'|'generated'|'deployed'
    owner      TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_metadata.dwm_table (
    table_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id        UUID REFERENCES platform_metadata.dwm_model ON DELETE CASCADE,
    name            TEXT NOT NULL,
    layer           TEXT NOT NULL,           -- 'bronze'|'silver'|'gold'
    table_type      TEXT NOT NULL,           -- 'dim'|'fact'|'agg'
    target_ns       TEXT NOT NULL,           -- iceberg namespace e.g. 'silver_qms'
    scd_type        TEXT,                    -- 'scd1'|'scd2'|null
    source_ref      TEXT,                    -- upstream table / namespace
    partition_spec  JSONB,                   -- {"granularity":"day","fmt":"year_month_day"}
    write_mode      TEXT,                    -- 'overwrite'|'merge'|'range_delete_insert'
    has_custom_logic BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_metadata.dwm_column (
    column_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id    UUID REFERENCES platform_metadata.dwm_table ON DELETE CASCADE,
    name        TEXT NOT NULL,
    dtype       TEXT NOT NULL,
    source_expr TEXT,                        -- source field or SQL expression
    role        TEXT,                        -- 'business_key'|'surrogate_key'|'measure'|'attribute'|'fk'
    scd2_track  BOOLEAN DEFAULT FALSE,
    agg_func    TEXT                         -- sum|count|avg|... (agg tables)
);

CREATE TABLE IF NOT EXISTS platform_metadata.dwm_relationship (
    rel_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id      UUID REFERENCES platform_metadata.dwm_model ON DELETE CASCADE,
    fact_table_id UUID REFERENCES platform_metadata.dwm_table ON DELETE CASCADE,
    dim_table_id  UUID REFERENCES platform_metadata.dwm_table ON DELETE CASCADE,
    fact_fk       TEXT,
    dim_pk        TEXT
);

CREATE INDEX IF NOT EXISTS idx_dwm_table_model ON platform_metadata.dwm_table (model_id);
CREATE INDEX IF NOT EXISTS idx_dwm_column_table ON platform_metadata.dwm_column (table_id);
CREATE INDEX IF NOT EXISTS idx_dwm_rel_model ON platform_metadata.dwm_relationship (model_id);
