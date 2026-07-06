# InSight — Implementation Plan (§22 role → §20 AI → §21 Agent → §19 Federation)

> Executable plan for Claude Code. Audited against live code (config.go / router.go / me.go / App.jsx / auth pkg). Each step: files to touch · data model · handler skeletons · acceptance.
> Backend = Go (chi, pgx, existing patterns). Reuse existing infra: query gateway, L6 masking, acl_*, datasource CRUD pattern, collection helpers.
> Ordering is dependency-driven: role mechanism is the foundation for federation and gates the "every factory looks like a center" bug; AI backend unblocks the already-built AI frontend; agent engine builds on AI; federation backend depends on role.

---

# STEP 1 — Deployment Role Mechanism (§22) · P0

Foundation. Makes factory vs hybrid render/behave correctly. Do this first.

## 1.1 config.go — add role + tower config

Add to `Config` struct:
```go
type Config struct {
    // ...existing...
    Insight    Insight    `mapstructure:"insight"`
    Federation Federation `mapstructure:"federation"`
}

// Insight holds the deployment-role identity of THIS instance (§22.2).
type Insight struct {
    Role      string `mapstructure:"role"`       // "factory" | "hybrid"; env INSIGHT_ROLE; default "factory"
    FactoryID string `mapstructure:"factory_id"` // this site's id, e.g. "fab-a"; env INSIGHT_FACTORY_ID
    Version   string `mapstructure:"version"`    // build/blueprint version, informational
}

// Federation configures how a factory reports up, and (hybrid) the tower.
type Federation struct {
    TowerEndpoint  string `mapstructure:"tower_endpoint"`   // factory→HQ report target; empty on hybrid
    ReportEverySec int    `mapstructure:"report_every_sec"` // default 60
    PullEverySec   int    `mapstructure:"pull_every_sec"`   // command pull interval, default 30
}
```
- Defaults in `config.yaml`: `insight.role: factory`, `federation.report_every_sec: 60`, `federation.pull_every_sec: 30`.
- Env binding (viper): `INSIGHT_ROLE`, `INSIGHT_FACTORY_ID`, `CP_FEDERATION_TOWER_ENDPOINT`.
- Validation in `config.Load`: role ∈ {factory, hybrid}; if role=factory then tower_endpoint required (warn if empty); factory_id required always.

## 1.2 auth — add factory scope to RBAC (§22.7①)

- Add permission-independent **scope** concept. In `auth/context.go` (or wherever claims land), add `FactoryScope string` to the caller principal: `"all"` for group-admins, `"<factory_id>"` otherwise.
- Derivation (given Keycloak has no groups, org parsed from LDAP DN today): reuse that parse — map a user's OU/group to a factory_id; a designated group-admin group → `all`. Config `auth.group_admin_groups: []` lists which Keycloak groups get `all`.
- `authz/resolver.go`: when building effective row-policies, if `FactoryScope != "all"`, AND-inject a site predicate is NOT needed at single factory (data is already only this site's). Scope matters at hybrid/tower for cross-site queries (Step 4). Keep scope on the principal now; enforce in query routing later.

## 1.3 me.go — add /api/me/context

New handler returning deployment role + capabilities (drives frontend):
```go
// MeContext — GET /api/me/context. Deployment role + capability flags so the
// SPA renders by role (§22.8) and never shows empty pages.
func (h *Handlers) MeContext(w http.ResponseWriter, r *http.Request) {
    p := auth.PrincipalFrom(r.Context())
    role := h.Cfg.Insight.Role
    hybrid := role == "hybrid"
    resp := map[string]any{
        "user": map[string]any{"name": p.Name, "email": p.Email, "roles": p.Groups},
        "deployment": map[string]any{
            "role": role, "factory_id": h.Cfg.Insight.FactoryID, "version": h.Cfg.Insight.Version,
        },
        "factory_scope": p.FactoryScope,
        "capabilities": map[string]bool{
            "data_ops":   true,        // factory + hybrid both have local data
            "ai":         true,
            "federation": hybrid,      // Federation UI only on hybrid
            "tower":      hybrid,
        },
    }
    httpx.JSON(w, http.StatusOK, resp)
}
```
Wire in router: `api.Get("/me/context", h.MeContext)` (no special permission; any authenticated user).
Requires `Handlers` to hold `Cfg *config.Config` (add if not present).

## 1.4 router.go — mount by role

```go
func NewRouter(h *Handlers, verifier auth.Verifier, cfg *config.Config) http.Handler {
    // ...existing core /api routes...

    // Federation surface — HQ (hybrid) only. Command dispatch additionally
    // checks group-admin inside handlers (§22.3 permission lock).
    if cfg.Insight.Role == "hybrid" {
        api.With(auth.RequirePermission(auth.PermFederationAdmin)).Route("/federation", func(fed chi.Router) {
            fed.Get("/lakehouses", h.FedListLakehouses)
            fed.Get("/lakehouses/{id}", h.FedGetLakehouse)
            fed.Post("/lakehouses/{id}/commands", h.FedDispatchCommand)
            fed.Get("/tower/overview", h.FedTowerOverview)
            fed.Get("/tower/rollups", h.FedRollups)
        })
    }
    // Factory always runs report client + command-receive worker (background, not routes) — started in main.go.
}
```
Add `auth.PermFederationAdmin` constant. Thread `cfg` into `NewRouter` (currently not passed).

## 1.5 Frontend App.jsx — conditional nav

- On load, `GET /api/me/context` → store `capabilities`.
- Filter `SECTIONS` / side-nav by capabilities:
```js
const [ctx, setCtx] = useState(null);
useEffect(() => { api.meContext().then(setCtx); }, []);
const visible = useMemo(() => {
  const base = ['overview','analytics','modeling','devconfig','governance','monitoring','ai','admin'];
  if (ctx?.capabilities?.federation) base.push('federation');
  return base;
}, [ctx]);
```
- Remove the unconditional `SECTIONS.federation` mount; render Federation only when `visible.includes('federation')`.
- Factory: optionally a tiny "Connected to group ✓" indicator in header (reads `ctx.deployment` + last report ok). **No empty Federation page.**
- Add `api.meContext()` to `src/data/api.js`.

## 1.6 Acceptance
- Deploy with `INSIGHT_ROLE=factory` → no Federation in nav; all data/AI pages present.
- Deploy with `INSIGHT_ROLE=hybrid` → Federation present.
- `curl /api/me/context` returns correct role + capabilities.
- Federation routes 404 on a factory instance even if called directly.

---

# STEP 2 — AI Model Registry + AI Gateway backend (§20) · P1

Frontend already built (Ai.jsx, 919 lines) but mock-driven. Wire it to real backend.

## 2.1 Migration — platform_metadata

`store/postgres/migrations/00xx_ai.sql`:
```sql
CREATE TABLE platform_metadata.ai_model (
    model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL, provider TEXT NOT NULL,
    endpoint TEXT NOT NULL, model_ref TEXT NOT NULL,
    auth_secret_ref TEXT,                 -- k8s secret name; NOT the raw key
    capabilities JSONB NOT NULL DEFAULT '[]',
    max_tokens INT, deployment TEXT NOT NULL DEFAULT 'external', -- 'external'|'local'
    enabled BOOLEAN DEFAULT TRUE, is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE platform_metadata.ai_semantic (
    entity_urn TEXT PRIMARY KEY, entity_type TEXT NOT NULL,
    nl_description TEXT, business_caliber TEXT, domain_knowledge TEXT,
    sample_values JSONB, relationships JSONB, constraints JSONB,
    sensitivity TEXT, embedding_status TEXT DEFAULT 'pending', -- pending|vectorized
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- embeddings: pgvector if available (see open Q); else store in a side table / external store.
```
Secrets: the raw API key is NOT stored in PG. `auth_secret_ref` names a K8s Secret; the AI adapter reads the key from env/secret at call time.

## 2.2 internal/ai package

```
internal/ai/
├── registry.go     # model CRUD over ai_model (store)
├── client.go       # provider-agnostic call: chat(model, messages) / embed(model, text)
│                   #   dispatch by provider: anthropic|openai|ollama|vllm|azure
├── boundary.go     # data-boundary enforcement: sensitive data -> local-only (§20.3)
├── gateway.go      # /ai/analyze (inbound, grounded) + /ai/assist (outbound)
└── semantic.go     # ai_semantic CRUD + compile-from-DataHub + RAG retrieval
```

**registry.go** — mirrors the datasource CRUD pattern (list/create/update/delete/test).
**client.go** — thin HTTP clients per provider; `TestConnection(model)` sends a probe prompt.
**boundary.go** — `AllowedForData(model, sensitivity) bool`: if sensitivity ∈ {Confidential,Restricted} then require `model.deployment=='local'`.
**gateway.go**:
- `POST /api/ai/analyze` (grounded self-observation): input question → `semantic.Retrieve` (RAG) to understand structure → generate a **query spec** (constrained, via existing query/build whitelist) → run through query gateway (already-computed results, e.g. spc_capability_daily) → call model to explain, **must cite rows** → return {answer, cited_rows, model}.
- `POST /api/ai/assist` (decision support): same path + role context; management→rollups, line→detail; masking auto-applies.

**Iron rules enforced in code (§20.5):**
- Never recompute SPC — analyze reads gold results only; the query spec targets gold_qms tables, no arithmetic in the LLM path.
- Response schema requires `cited_rows` non-empty when making a data claim (validate before returning).
- All queries go through the query gateway + L6 (no direct engine calls from ai pkg).

## 2.3 Routes (always available; AI is factory-local)
```go
api.With(auth.RequirePermission(auth.PermAiRead)).Get("/ai/models", h.AiListModels)
api.With(auth.RequirePermission(auth.PermAiWrite)).Post("/ai/models", h.AiCreateModel)
api.With(auth.RequirePermission(auth.PermAiWrite)).Put("/ai/models/{id}", h.AiUpdateModel)
api.With(auth.RequirePermission(auth.PermAiWrite)).Delete("/ai/models/{id}", h.AiDeleteModel)
api.With(auth.RequirePermission(auth.PermAiWrite)).Post("/ai/models/{id}/test", h.AiTestModel)
api.With(auth.RequirePermission(auth.PermAiRead)).Get("/ai/semantic", h.AiSemanticList)
api.With(auth.RequirePermission(auth.PermAiWrite)).Put("/ai/semantic/{urn}", h.AiSemanticUpsert)
api.With(auth.RequirePermission(auth.PermAiWrite)).Post("/ai/semantic/compile", h.AiSemanticCompile) // from DataHub+Glossary+ETL
api.With(auth.RequirePermission(auth.PermAiRead)).Post("/ai/semantic/{urn}/test", h.AiSemanticTest)  // "test understanding"
api.With(auth.RequirePermission(auth.PermAiRead)).Post("/ai/analyze", h.AiAnalyze)
api.With(auth.RequirePermission(auth.PermAiRead)).Post("/ai/assist", h.AiAssist)
```

## 2.4 Frontend — swap mock → api
- `src/data/api.js`: add ai* wrappers.
- `Ai.jsx`: replace `AI_MODELS`/`SEM_LAYERS` constants with fetched data; keep the (excellent) UI. Model modal "Test connection" → `POST /ai/models/{id}/test`. "Test understanding" → `POST /ai/semantic/{urn}/test`.

## 2.5 Acceptance
- Register a model (external Claude / local vLLM), Test connection returns a real probe reply.
- Try to analyze a Confidential-classified table with an external model → boundary blocks it; with a local model → allowed.
- `/ai/analyze` returns an answer whose `cited_rows` reference real gold rows; masking applies to the caller's scope.

---

# STEP 3 — Agent Workflow Engine (§21) · P2

Frontend canvas + run-trace already built (Ai.jsx). Add storage + execution.

## 3.1 Migration
```sql
CREATE TABLE platform_metadata.agent_flow (
    flow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL, description TEXT,
    trigger JSONB NOT NULL,               -- {type:'schedule'|'manual'|'event', config}
    nodes JSONB NOT NULL, edges JSONB NOT NULL,
    status TEXT DEFAULT 'draft', owner TEXT,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE platform_metadata.agent_run (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id UUID REFERENCES platform_metadata.agent_flow,
    status TEXT DEFAULT 'running',        -- running|success|failed|awaiting_approval
    trace JSONB DEFAULT '[]',             -- per-node {node_id,input,output,ms,status}
    started_at TIMESTAMPTZ DEFAULT now(), ended_at TIMESTAMPTZ
);
```

## 3.2 internal/agent package
```
internal/agent/
├── store.go       # flow/run CRUD
├── engine.go      # topological walk of nodes; per-node execute; persist trace
├── nodes.go       # node executors by type
└── scheduler.go   # schedule triggers (cron); manual = API; event = Step 3 later
```

**engine.go** — DAG walk (reuse validator ideas from codegen: no cycles). For each node, call its executor with resolved inputs (upstream outputs via `{{var}}` templating), append to `trace`. On `human_approval` node → set run `awaiting_approval`, persist, stop; resume via API.

**nodes.go executors** (each returns output persisted to trace):
- `data_query` → query gateway (auto-masked). **This is where security inheritance happens** — no bypass.
- `ai_inference` → ai.client.Chat(model, prompt-with-vars).
- `semantic_retrieval` → ai.semantic.Retrieve (RAG).
- `tool_call` → invoke platform capability (BuildPipeline, lineage, notify) via existing handlers/services.
- `condition` → eval expression over vars.
- `human_approval` → pause.
- `output` → report/notify/writeback.

**scheduler.go** — cron-like ticker triggers published flows; reuse the report scheduler pattern already in `internal/report`.

## 3.3 Routes
```go
api.With(auth.RequirePermission(auth.PermAiRead)).Get("/agent/flows", h.AgentListFlows)
api.With(auth.RequirePermission(auth.PermAiWrite)).Post("/agent/flows", h.AgentCreateFlow)
api.With(auth.RequirePermission(auth.PermAiWrite)).Put("/agent/flows/{id}", h.AgentUpdateFlow)
api.With(auth.RequirePermission(auth.PermAiWrite)).Delete("/agent/flows/{id}", h.AgentDeleteFlow)
api.With(auth.RequirePermission(auth.PermAiWrite)).Post("/agent/flows/{id}/run", h.AgentRunFlow)
api.With(auth.RequirePermission(auth.PermAiRead)).Get("/agent/flows/{id}/runs", h.AgentListRuns)
api.With(auth.RequirePermission(auth.PermAiRead)).Get("/agent/runs/{runId}", h.AgentGetRun)          // trace
api.With(auth.RequirePermission(auth.PermAiWrite)).Post("/agent/runs/{runId}/approve", h.AgentApprove) // HITL resume
```

## 3.4 Frontend
- Swap `AG_FLOWS`/`AG_NODES`/`AG_TRACE_STEPS` mock → fetched. Canvas save → `PUT /agent/flows/{id}` (nodes/edges JSON). Test run → `POST .../run`, poll `GET /agent/runs/{runId}` for trace. Approval node → `POST .../approve`.

## 3.5 Acceptance
- Build the daily process-capability flow (schedule→query→AI→condition→approval/output), save, run.
- Run trace shows each node's real I/O; data_query node shows masked rows; ai_inference shows model + prompt + reply.
- Human-approval node pauses run; approving resumes to completion.

---

# STEP 4 — Federation backend: Control Tower + report/command modules (§19) · P3

Depends on Step 1 role mechanism. Largest step.

## 4.1 Tower store (hybrid/HQ side) — separate schema `tower`
Use the §19.7 DDL (`tower.lakehouse`, `tower.command`, `tower.metric_rollup`). On a hybrid instance, migrations create `tower.*` in addition to `platform_metadata.*`.

## 4.2 Factory side — two background workers (started in main.go on every instance)
```
internal/federation/
├── reporter.go     # factory→HQ: every ReportEverySec, POST health snapshot to TowerEndpoint
├── receiver.go     # factory→HQ pull: every PullEverySec, GET own commands, execute, report result
├── tower.go        # HQ side (hybrid only): registry + command queue + rollup ingest handlers
└── drill.go        # HQ side: on-demand federated query to a target site's Trino (§22.7②)
```

**reporter.go** (runs on factory AND hybrid's own data-site):
- Collect snapshot: pipeline statuses (from existing ops), data freshness, sync lag, errors, version.
- `POST {TowerEndpoint}/federation/report` with `{factory_id, snapshot}`. Outbound only (NAT-friendly). Failures logged, retried next tick — factory keeps running regardless.

**receiver.go**:
- `GET {TowerEndpoint}/federation/commands?factory_id=` → list queued commands.
- Execute each by invoking existing capabilities (trigger pipeline, push config, apply blueprint). Blueprint apply respects local policy (auto vs require-approval, §19.6).
- Report result back → command status done/failed/rejected.

**tower.go** (hybrid only — mounted via Step 1's role gate):
- `POST /federation/report` → upsert `tower.lakehouse.last_report_at + health`.
- `GET /federation/commands` → return queued for that factory; mark pulled.
- `POST /federation/report-result` → update command status.
- `FedDispatchCommand` (from Step 1 routes) → insert into `tower.command`.
- `FedTowerOverview` → aggregate all lakehouses; staleness = now - last_report_at.
- Ingest `tower.metric_rollup` from reports for cross-site compare.

**drill.go** (hybrid only): given target factory_id, connect that site's Trino (from `tower.lakehouse.endpoint`) for real-time detail query. Respects the caller's factory_scope (group-admin only).

## 4.3 main.go wiring
```go
// every instance runs reporter + receiver (points at TowerEndpoint)
go federation.NewReporter(cfg, deps).Run(ctx)
go federation.NewReceiver(cfg, deps).Run(ctx)
// hybrid also serves tower routes (mounted in router by role) — no extra goroutine needed
```
Note: a hybrid instance's TowerEndpoint = itself (loopback) or skip reporter and ingest its own site directly — decide per §22 open-Q2.

## 4.4 Lakehouse Blueprint (§19.5) — parallel workstream (declarative deploy)
- Package the whole stack as a parameterized Helm chart / Kustomize overlay. `factory-params.yaml`: factory_id, network, source DB conns, namespace prefix, INSIGHT_ROLE, TowerEndpoint.
- New factory: fill params → deploy → control plane self-registers (reporter's first report auto-creates `tower.lakehouse` row if unknown, or an explicit `POST /federation/register`).

## 4.5 Acceptance
- Two factory instances + one hybrid. Factories report; Tower overview shows both online with health; kill one → shows stale after N min, other unaffected.
- Dispatch "trigger pipeline" to factory A from HQ → A's receiver pulls, executes existing pipeline, reports done.
- HQ federated-drill into factory B returns B's live detail (group-admin scope only).
- New factory stood up from Blueprint self-registers into the Tower.

---

# Cross-step notes
- **Permissions**: add `auth` constants `PermAiRead/PermAiWrite`, `PermFederationAdmin`. Map to coarse groups in `auth/rbac.go`.
- **Security inheritance**: every data touch in AI (Step 2/3) and federated drill (Step 4) MUST go through the query gateway + L6 masking. No package calls Trino/CH directly.
- **Migrations**: additive, auto-run via existing `store.Migrate`.
- **Config threading**: Steps 1–4 all need `cfg` on `Handlers`/`NewRouter` — do that thread-through in Step 1.
- **Tests**: mirror existing `router_test`/`generator_test` patterns; unit-test boundary.go (sensitive→local) and engine.go (trace, approval pause) especially.

# Recommended execution order
1. Step 1 (role) — unblocks correct factory/hybrid behavior, foundation for Step 4.
2. Step 2 (AI backend) — frontend already waiting; highest visible payoff.
3. Step 3 (agent engine) — builds on Step 2.
4. Step 4 (federation) — largest; do after role + after single-factory AI proven; pair with Blueprint.
