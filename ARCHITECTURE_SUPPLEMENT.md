# IPAS Control Plane — Architecture Supplement (§15–§17)

> Extends `ARCHITECTURE.md`. Covers three new capability layers that elevate the platform from "ops console" to "self-service data platform":
> - §15 Data API layer (publish data as governed external endpoints; "safe even without auth")
> - §16 Modeling-as-Code (visual star-schema modeling → auto-generate ETL scripts + DAGs)
> - §17 Schema evolution, table maintenance & data patch (operational autonomy, leave the CLI behind)
>
> Status legend matches PROGRESS.md (✅ 🟡 ⬜ ➕). Sections marked `// TODO` need confirmation.
> Backend = Go (per §7). All three reuse existing infra: query gateway (§10), L6 masking, `acl_*` (§2.3), Iceberg REST catalog (§5.3.1), DataHub (§5).

---

## §15 Data API Layer (Data-as-a-Service)

### 15.1 Goal & core principle

Expose internal data as stable, governed **external** REST/GraphQL endpoints (`/data-api/v1/<name>`) that other systems, partners, or BI tools can call. The internal query gateway (§10) is consumer-facing-internal; this layer is its **externalized, contract-bound** form.

**Core security principle — "safe even without auth"**: the security boundary is NOT authentication, it is the **published contract + query-layer masking**. Two orthogonal layers:
- **Auth mode** controls *who can call* (none / API key / OAuth / JWT).
- **Publish contract (column whitelist + allowed filters) + L6 masking** controls *what they can see*.

Because the contract is enforced server-side, even an `auth_mode='none'` endpoint can only return the whitelisted columns, only accept whitelisted filter parameters, and masking (`acl_column_policy`) still applies. A public read-only endpoint therefore leaks nothing beyond what was deliberately published. The two layers are independent: auth gates the caller, contract+masking bounds the data.

### 15.2 Metadata schema (`platform_metadata`)

```sql
CREATE TABLE platform_metadata.data_api (
    api_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT UNIQUE NOT NULL,         -- path segment: /data-api/v1/<name>
    version         TEXT NOT NULL DEFAULT 'v1',
    source_type     TEXT NOT NULL,                -- 'semantic_model' | 'table' | 'dataset'
    source_ref      TEXT NOT NULL,                -- model_id | catalog.schema.table | dataset_id
    allowed_columns JSONB NOT NULL,               -- [{src, exposed_as}] whitelist
    allowed_filters JSONB NOT NULL,               -- [{column, ops:[=, >, IN...], required, default}]
    pagination      JSONB,                        -- {default_size, max_size}
    sort_whitelist  JSONB,                        -- [columns sortable]
    auth_mode       TEXT NOT NULL DEFAULT 'none', -- 'none'|'apikey'|'oauth'|'jwt'
    rate_limit_rpm  INT,                          -- requests/min
    daily_quota     INT,
    max_concurrency INT,
    status          TEXT NOT NULL DEFAULT 'draft',-- 'draft'|'published'|'deprecated'
    owner           TEXT,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE platform_metadata.data_api_key (
    key_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_id     UUID REFERENCES platform_metadata.data_api,
    name       TEXT,
    key_hash   TEXT NOT NULL,                     -- store hash only; show raw once on creation
    scopes     JSONB,
    expires_at TIMESTAMPTZ,
    last_used  TIMESTAMPTZ,
    revoked    BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

API call auditing reuses `platform_metadata.acl_audit` (add `api_id`, `caller` columns or a parallel `data_api_audit` table).

### 15.3 Routing & middleware

Two separate router groups in the BFF:
- `/api/*` — internal, existing, `auth.Middleware` (Keycloak JWT) + coarse RBAC.
- `/data-api/v1/*` — **external**, its own middleware chain (does NOT use the internal Keycloak-admin middleware):
  1. Resolve `<name>` → `data_api` record (404 if not found / not published).
  2. **Auth gate** by `auth_mode`:
     - `none` → pass through.
     - `apikey` → validate `X-API-Key` header against `data_api_key` (hash compare, expiry, revoked, scope).
     - `oauth` → validate bearer token via Keycloak (`insight` client, client-credentials).
     - `jwt` → validate against configured issuer/audience.
  3. **Rate limit / quota** (token bucket per api_id + caller).
  4. **Contract enforcement** → build a structured query spec constrained to `allowed_columns` + `allowed_filters` (reject any param not whitelisted). **Reuse the existing `/api/query/build` whitelist-validation logic** — this is the same structured-spec→SQL machinery, just driven by the API contract instead of a UI builder.
  5. Route via query gateway (§10) → **L6 masking still applies** (the published column set and any `acl_column_policy` both bound the output).
  6. Audit + return JSON.

### 15.4 Go layout additions

```
internal/dataapi/
├── store.go        # CRUD on data_api / data_api_key
├── middleware.go   # auth-mode gate + rate limit + quota
├── contract.go     # external params -> constrained query spec (reuses query/build)
├── openapi.go      # generate OpenAPI/GraphQL schema from contract
api/http/dataapi.go # /api/data-apis CRUD (management, internal)
api/external/v1.go  # /data-api/v1/* (the external endpoints)
```

### 15.5 Status & priority
⬜ Not started. **P0 of the new capabilities** — highest reuse (query/build + L6 + acl_*), directly realizes the "external data service" vision. Implement MVP first: `source_type=table`, `auth_mode=none|apikey`, contract enforcement, audit. OAuth/JWT + versioning + OpenAPI gen follow.

### 15.6 External exposure (DECIDED — Nginx reverse proxy, same backend)

External traffic does NOT hit the K8s Ingress directly. A **standalone Nginx reverse proxy** sits in front as the only public-facing IP, hiding the real cluster topology. It forwards to the existing internal Ingress (`172.16.202.51`). The Data API and internal API share **one** Ingress + BFF — no second deployment; only path/host routing distinguishes them.

```
External caller ──> Nginx reverse proxy (public; TLS, WAF, rate-limit, IP allowlist, hides topology)
                         │ forwards; internal addresses never exposed
                         ▼
                   K8s Ingress (172.16.202.51) ──> BFF
                         ├─ /data-api/v1/*   (external contract endpoints — Nginx forwards)
                         └─ /api/*           (internal — Nginx does NOT forward, or restricts to internal network)
```

Nginx layer responsibilities (kept out of K8s, easy to change):
- TLS termination for external callers
- WAF / basic request filtering
- Coarse network-layer rate limiting + IP allowlist
- Strip/!hide `Server`/topology headers; the real Ingress IP and all `172.16.202.x` stay invisible externally
- Path gating: forward `/data-api/v1/*`; block or internal-only `/api/*`

Security model stays two-layer and orthogonal: **Nginx = coarse network-layer protection**; **BFF contract + L6 masking = data-layer protection** (§15.1). An `auth_mode='none'` Data API is reachable through Nginx but still bounded by its publish contract + masking — exactly the "safe without auth" property.

Backend impact: none beyond the existing router groups. The BFF still serves `/data-api/v1/*` and `/api/*`; whether a request arrives is decided at the Nginx layer. `// TODO` (minor) — confirm Nginx host placement (the same standalone server as anything else, or dedicated) and whether it also fronts the SPA.

---

## §16 Modeling-as-Code (visual modeling → ETL/DAG generation)

### 16.1 Goal & the central idea

Let users build a **star schema visually** (define dimensions, facts, aggregates, SCD types, field mappings, FK relationships) and **auto-generate the ETL scripts + Airflow DAG** for the full lifecycle (source already in RAW → Bronze → Silver dims/facts → Gold → ClickHouse).

**Central architectural rule**: visual modeling does NOT generate script strings directly. It writes a **meta-model (IR)** into `platform_metadata`; a **code generator** reads the IR and renders templates. Never couple drag-drop UI to string output — the IR is the contract between modeling and generation.

### 16.2 Reconciling with "scripts are immutable" (§5)

The §5 principle ("don't modify running, handcrafted ETL scripts") still holds. We split scripts into two physically-separated classes:

| Class | Location | Mutability |
|-------|----------|------------|
| **Handcrafted** | `etls/` (existing qms CHE etc.) | Immutable; control plane only orchestrates |
| **Generated** | `etls/generated/` | Control-plane owned; regenerable; header `# AUTO-GENERATED FROM model <id>, DO NOT EDIT` |

The generator never touches handcrafted scripts. "Re-model" = "re-generate" in `generated/` only.

### 16.3 What can / cannot be auto-generated (be honest)

Generation is **layered**, not all-or-nothing — the existing ETL contains hand-crafted logic templates can't fully cover (per-partition watermarks, gold range delete-then-insert idempotency, SPC 30-day ascending window, SCD2 effective/expiration, EAV flattening):

| Layer | Auto-gen level |
|-------|----------------|
| RAW→Bronze | ✅ Full (format standardize + land Iceberg; highly templated) |
| Silver Dim (SCD2) | ✅ High (standard pattern; template from existing `dimension_scd_etl.py`) |
| Silver Fact | 🟡 Partial (dim joins + FK resolution generated; special cleansing manual) |
| Gold simple agg | 🟡 Simple sum/count/rate generated; SPC / complex metrics NOT |
| Gold→ClickHouse | ✅ Full (template from existing `silver_to_clickhouse_sync.py`) |

**Design stance**: generate 80% skeleton + flag the 20% needing human logic via a preserved custom-block. Do NOT attempt to auto-generate SPC's rolling-window/ascending logic — that's a core asset; route it through skeleton+human.

### 16.4 Meta-model schema (`platform_metadata`)

```sql
CREATE TABLE platform_metadata.dwm_model (
    model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT, domain TEXT,
    status TEXT DEFAULT 'draft',   -- 'draft'|'generated'|'deployed'
    owner TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE platform_metadata.dwm_table (
    table_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID REFERENCES platform_metadata.dwm_model,
    name TEXT NOT NULL,
    layer TEXT NOT NULL,           -- 'bronze'|'silver'|'gold'
    table_type TEXT NOT NULL,      -- 'dim'|'fact'|'agg'
    target_ns TEXT NOT NULL,       -- iceberg namespace e.g. 'silver_qms'
    scd_type TEXT,                 -- 'scd1'|'scd2'|null
    source_ref TEXT,               -- upstream table / namespace
    partition_spec JSONB,          -- e.g. {"granularity":"day","fmt":"year_month_day"}
    write_mode TEXT,               -- 'overwrite'|'merge'|'range_delete_insert'
    has_custom_logic BOOLEAN DEFAULT FALSE
);

CREATE TABLE platform_metadata.dwm_column (
    column_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id UUID REFERENCES platform_metadata.dwm_table,
    name TEXT NOT NULL, dtype TEXT NOT NULL,
    source_expr TEXT,              -- source field or SQL expression
    role TEXT,                     -- 'business_key'|'surrogate_key'|'measure'|'attribute'|'fk'
    scd2_track BOOLEAN DEFAULT FALSE,
    agg_func TEXT                  -- sum|count|avg|... (agg tables)
);

CREATE TABLE platform_metadata.dwm_relationship (
    rel_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID REFERENCES platform_metadata.dwm_model,
    fact_table_id UUID, dim_table_id UUID,
    fact_fk TEXT, dim_pk TEXT
);
```

### 16.5 Code generator

```
internal/codegen/
├── templates/
│   ├── raw_to_bronze.py.tmpl    # abstracted from existing raw_to_bronze_etl.py
│   ├── dim_scd2.py.tmpl         # abstracted from existing dimension_scd_etl.py
│   ├── fact.py.tmpl             # abstracted from existing fact_table_etl.py
│   ├── gold_simple_agg.py.tmpl  # simple aggregation
│   ├── clickhouse_sync.py.tmpl  # abstracted from silver_to_clickhouse_sync.py
│   └── dag.py.tmpl              # abstracted from dag_complete_multi_table_etl.py
├── generator.go                 # IR (dwm_*) -> render templates -> .py files
├── validator.go                 # pre-gen checks: FK integrity, partition consistency, no cyclic deps
└── custom_block.go              # parse & preserve human custom regions across regeneration
```

**Key reuse**: templates are abstracted from the *existing, correct* ETL scripts (your SCD2, RAW→Bronze, CH sync logic). This guarantees generated code follows the proven patterns (FileIO split invariant, day partitioning, idempotent writes) rather than reinventing them.

### 16.6 Custom-logic slot (preserve human code across regeneration)

Templates embed a preserved region:
```python
# === BEGIN CUSTOM LOGIC (preserved across regeneration) ===
{{ custom_block }}
# === END CUSTOM LOGIC ===
```
On regenerate, `custom_block.go` parses the old generated file, extracts the content between the markers, and re-injects it into the freshly rendered skeleton. So re-modeling never destroys hand-written SPC/cleansing logic. (Pattern: "marked-region preservation", as used by DataWorks-style tools.)

### 16.7 Deploy flow (script path aligned with Spark exec)

Generated scripts must end up where the Spark exec model (§5.1) expects them: inside the Spark container at `/opt/bitnami/spark/jobs/`. Decision: generated scripts land in a **`generated/` subdirectory of the shared volume**, mounted into the Spark container at `/opt/bitnami/spark/jobs/generated/`.

```
codegen writes  ──>  shared volume  generated/<model>_<table>.py
                          │ same volume mounted into Spark container
                          ▼
Spark container  /opt/bitnami/spark/jobs/
                 ├── *.py                       (handcrafted, existing — untouched)
                 └── generated/<model>_<table>.py   (auto-generated)
```

So the generated DAG's task can `spark-submit /opt/bitnami/spark/jobs/generated/<model>_<table>.py` with the same exec mechanism as handcrafted scripts — same `--master local[4]` (or future cluster submit), same Iceberg/S3 config, same Pushgateway metrics. Physical isolation (subdir) preserves the §16.2 handcrafted-vs-generated split while keeping both reachable by one Spark image.

Full flow: generation → write `.py` to `generated/` on the shared volume → `EnsureDAG` (§8.1) renders & writes the DAG referencing the `generated/` path → DAG follows the §5.2 dependency graph (raw_to_bronze → dims ∥ → facts → validate → gold → clickhouse). Deploy is gated by `validator.go` passing.

`// TODO` (minor) — confirm the Spark container already mounts (or can mount) the same volume that holds `generated/`. If the Spark `jobs/` dir is baked into the image rather than volume-mounted, add a volume mount for `generated/` (an emptyDir won't persist; use the same Longhorn RWX PVC as DAGs or a dedicated codegen PVC).

### 16.8 Frontend
Extend the EXISTING semantic-model star-schema editor (already built per PROGRESS) into a superset "Modeling Studio": semantic model = read view; modeling studio = write definition + generate ETL. Same canvas, plus SCD config, field-mapping panel, code-gen preview with editable custom-block, deploy.

### 16.9 Status & priority
⬜ Not started. Sequence: P0 meta-model tables + RAW→Bronze generator (end-to-end thinnest slice) → P1 SCD2 dim generator → P2 fact generator → P3 simple-agg + custom-block mechanism → P4 modeling-studio frontend.

`// TODO` (resolved direction) — generated-script output path: `generated/` subdir on a shared volume mounted into the Spark container at `/opt/bitnami/spark/jobs/generated/` (§16.7). Only remaining check: confirm the Spark `jobs/` dir is volume-mounted (not baked into image); if baked, add the mount.

---

## §17 Schema Evolution, Table Maintenance & Data Patch (operational autonomy)

Goal: do from the UI what currently requires bare-metal CLI. Three sub-capabilities.

### 17.1 Schema evolution (safe schema change)

Iceberg natively supports schema evolution (add/rename/widen/drop column) at the metadata level (no data-file rewrite for compatible changes).

`CatalogAdapter` additions:
```go
AddColumn(ctx, ns, table, col ColumnSpec) error
RenameColumn(ctx, ns, table, old, new string) error
WidenColumn(ctx, ns, table, col, newType string) error   // compatible
DropColumn(ctx, ns, table, col string) error              // BREAKING
GetSchemaDiff(ctx, ns, table, target Schema) (Diff, error)
```

Flow:
- **Compatible** (add / rename / widen) → execute directly via Iceberg `ALTER TABLE`, audit, trigger DataHub re-ingest.
- **Breaking** (drop / narrow) → mandatory approval + **impact analysis**: query DataHub lineage to list downstream dependents (Data APIs, semantic models, dashboards, downstream tables using the column). Warn "may require ETL script sync" (esp. if the column is written by an ETL).

Tables in `platform_metadata`: `schema_change_request` (target, change_type, compatibility, status, requester, diff, impact, approver).

### 17.2 Table maintenance (Iceberg ops, UI-driven)

These are CLI tasks today (you run them by hand); surface as buttons. Trino/Iceberg procedures back them:
- **Compaction** — `ALTER TABLE ... EXECUTE optimize` (merge small files)
- **Expire snapshots** — `expire_snapshots` (choose retention)
- **Remove orphan files** — `remove_orphan_files`
- **Rewrite manifests** — `rewrite_manifests`

Each: async job (running/done/failed) + result (space reclaimed, files merged) + maintenance history. Health metrics shown first (file count, small-file ratio, snapshot count, oldest snapshot, storage, orphan estimate).

**Watermark management**: view current ETL watermarks (fact per-partition, gold range — Iceberg metadata tables `_fact_etl_watermarks` / `_gold_etl_watermarks`), and **reset** for full backfill (dangerous, double-confirm; reminder: full reload needs ALL_PARTITIONS reset + ascending backfill per memory).

### 17.3 Data patch (data mutation — guarded)

Lakehouse is analytical, not OLTP. Only safe, audited corrections:
- **Row-level UPDATE/DELETE** (Iceberg v2) for *data correction* — visual condition builder locates rows, preview affected count (SELECT count first).
- Mandatory: reason → **approval** → execute → retain pre-patch snapshot (rollback) → audit.
- **Not allowed**: routine business-data mutation. Business data's source of truth is upstream MySQL (via CDC). The UI must state this and block patch from being used as a general write path.
- Rollback = revert to the pre-patch Iceberg snapshot.

### 17.4 Status & priority
⬜ Not started. Priority after §15/§16: P2 schema evolution (high value, low risk for compatible changes; breaking changes gated). P3 table maintenance (operational autonomy). P4 data patch (guarded, lowest priority, highest risk).

---

## Cross-cutting: priority across all new capabilities

```
P0  §15 Data API MVP            (highest reuse; realizes external-service vision)
P1  §15 API governance          (auth modes, rate limit, usage, OpenAPI)
P1  §16 meta-model + RAW→Bronze + SCD2 generators (thin end-to-end, then dims)
P2  §16 fact/agg generators + custom-block; §17.1 schema evolution
P3  §16 modeling-studio frontend; §17.2 table maintenance
P4  §17.3 data patch (guarded)
```

## New open questions (`// TODO`)

Resolved: ✅ external exposure (Nginx reverse proxy, same backend — §15.6) · ✅ generated-script path (`generated/` subdir mounted at Spark's `/opt/bitnami/spark/jobs/generated/` — §16.7).

Still open:
1. Confirm Spark `jobs/` dir is volume-mounted (not image-baked); if baked, add a mount for `generated/` (§16.7).
2. Whether Modeling Studio generates into the SAME Iceberg namespaces as handcrafted models (collision policy) or a sandbox namespace first (§16).
3. Approval workflow backing — reuse the §D4c access-request queue, or a generic approval engine for schema-change / data-patch / API-publish? (§15/§17)
4. Minor: Nginx host placement (shared standalone server vs dedicated) and whether it also fronts the SPA (§15.6).
