-- ============================================================
-- AI capability (§20) — model registry + semantic layer.
--   ai_model    : LLM/embedding endpoints the platform may call. The raw API
--                 key is NEVER stored here; auth_secret_ref names the K8s
--                 Secret / env var the adapter reads at call time.
--   ai_semantic : per-entity semantics (natural-language meaning, business
--                 caliber, domain knowledge) that ground RAG retrieval and
--                 agent reasoning. Text fields are authored in the UI;
--                 embedding_status tracks vectorization (pend|desc|vec).
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.ai_model (
    model_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT UNIQUE NOT NULL,
    provider        TEXT NOT NULL,                 -- Anthropic|OpenAI|Ollama|vLLM|Azure
    endpoint        TEXT NOT NULL,
    model_ref       TEXT NOT NULL,                 -- e.g. claude-opus-4-8 / Qwen2.5-72B-Instruct
    auth_secret_ref TEXT,                          -- K8s Secret / env var name; NOT the raw key
    capabilities    JSONB NOT NULL DEFAULT '[]',   -- ["chat","embedding","vision","function-call"]
    max_tokens      INT,
    deployment      TEXT NOT NULL DEFAULT 'external', -- 'external'|'local' (§20.3 boundary)
    enabled         BOOLEAN DEFAULT TRUE,
    is_default      BOOLEAN DEFAULT FALSE,
    last_tested     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_metadata.ai_semantic (
    entity_urn       TEXT PRIMARY KEY,             -- e.g. gold.spc_capability_daily / cpk
    entity_type      TEXT NOT NULL,                -- 'table'|'metric'|'field'
    nl_description   TEXT,                         -- read by the LLM to understand intent
    business_caliber TEXT,                         -- exact definition + how measured
    domain_knowledge TEXT,                         -- expert rules (e.g. r3_flag semantics)
    sample_values    TEXT,                         -- concrete examples grounding the entity
    relationships    TEXT,                         -- joins / lineage to other entities
    constraints      TEXT,                         -- invariants AI must respect
    sensitivity      TEXT DEFAULT 'Internal',      -- Public|Internal|Confidential|Restricted
    embedding_status TEXT DEFAULT 'pend',          -- pend|desc|vec
    updated_at       TIMESTAMPTZ DEFAULT now()
);
