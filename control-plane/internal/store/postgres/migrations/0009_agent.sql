-- ============================================================
-- Agent workflow engine (§21) — governed, auditable AI workflows.
--   agent_flow : the canvas definition (nodes + edges JSON, trigger spec).
--   agent_run  : one execution; trace records every node's real input/output
--                so each AI conclusion stays traceable to the rows it read.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_metadata.agent_flow (
    flow_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    trigger     JSONB NOT NULL DEFAULT '{"type":"manual"}', -- {type:'schedule'|'manual'|'event', cron, condition}
    nodes       JSONB NOT NULL DEFAULT '[]',
    edges       JSONB NOT NULL DEFAULT '[]',
    status      TEXT DEFAULT 'draft',                        -- 'draft'|'published'
    owner       TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_metadata.agent_run (
    run_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id    UUID REFERENCES platform_metadata.agent_flow ON DELETE CASCADE,
    status     TEXT DEFAULT 'running',  -- running|success|failed|awaiting_approval|rejected
    trace      JSONB DEFAULT '[]',      -- per-node {id,dur,status,io,evidence,model,prompt,reply,masked}
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_run_flow_idx
    ON platform_metadata.agent_run (flow_id, started_at DESC);
