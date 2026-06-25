-- ============================================================
-- collection — generic JSONB document store for the control plane's
-- "platform-owned" UI collections that have no downstream component as
-- a source of truth: dashboards, report subscriptions, business metrics,
-- data-quality rules, organizations, system config, API keys, tenants,
-- notifications, and access roles (§11 front-end pages).
--
-- One physical table backs every such collection (discriminated by the
-- `collection` column). Rows are loosely-typed documents so the front-end
-- row shape (src/data/mockData.js + formSchemas.js) passes through unchanged;
-- the server only owns `id` and timestamps. Relational policy data stays in
-- the typed acl_* tables (§2.3) — this is strictly for UI-owned lists.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.collection (
    collection  TEXT NOT NULL,                       -- 'dashboard' | 'report' | 'metric' | ...
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    doc         JSONB NOT NULL,                       -- the front-end row (without id)
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_collection_name
    ON platform_metadata.collection (collection, created_at DESC);
