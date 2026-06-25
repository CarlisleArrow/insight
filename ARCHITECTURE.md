# IPAS Control Plane — Architecture Specification

> **Audience**: Claude Code (and human engineers) building the IPAS Data Platform Control Plane.
> **Status**: Design baseline. Sections marked `// TODO: confirm` need verification before coding that part.
> **Owner**: IT System Architecture (Carlisle, Siptory).
> **Stack decision**: Control plane backend = **Go**. SQL-rewrite (masking) = **separate microservice** (Python + sqlglot).

---

## 0. Purpose & Scope

The control plane is the **single backend** the unified front-end talks to. It exists to hide the heterogeneous open-source stack (Debezium, Airflow, Spark, Iceberg, Trino, ClickHouse, DataHub, MinIO, PostgreSQL) behind one coherent API and one auth boundary.

Front-end **never** calls a component directly. Every front-end action goes to the control-plane BFF, which:
1. Verifies the caller's identity (Keycloak JWT).
2. Resolves coarse RBAC (Keycloak groups) + fine-grained data policy (own policy DB).
3. Calls downstream components through typed **Adapters** using platform service accounts.
4. Reads all "current state" (schemas, lineage, job status) from **DataHub** (the metadata hub), not by polling each component.

**Non-goals**: This control plane does NOT modify the existing ETL Spark scripts. The "scripts-are-immutable" principle holds — orchestration wraps them, never edits them.

---

## 1. CRITICAL SECURITY BASELINE (read first)

Current verified state of downstream auth:

| Component | Auth status (verified) | Consequence |
|-----------|------------------------|-------------|
| Debezium Connect (`:8083`) | **No auth** | Anyone with network access can manage connectors |
| Trino (`:8080`) | **No auth** (`no auth config`) | Open query access |
| ClickHouse (`:8123`) | **`default` user, empty password, open networks** | Open OLAP access |
| Airflow | **No `auth_backends`** configured | Open API/UI |
| MinIO | `minioadmin/minioadmin` (seen in DAG configs) | Default creds |

**Design response (mandatory, do this BEFORE exposing anything):**

1. **Network lockdown via Calico NetworkPolicy** — every component above accepts traffic **only** from the `control-plane` namespace (and existing internal callers like Spark/Airflow that legitimately need them). No direct ingress from user networks.
2. **BFF is the only auth boundary** — it validates Keycloak JWT on every request, then uses service accounts to reach components.
3. **Secrets out of code** — MinIO keys, Debezium DB password, ClickHouse creds move to K8s Secrets, mounted into BFF. Current hardcoded creds in ETL scripts are out of scope to fix here but must be tracked as debt.
4. **Do NOT add per-component OIDC** as the primary control — the BFF-收口 + NetworkPolicy model is the chosen approach because configuring auth on each裸奔 engine is high-cost and brittle.

`// TODO: confirm` — whether Spark / Airflow internal callers need explicit allow rules in each NetworkPolicy (they do for the components they read/write).

---

## 2. Identity & Authorization Model

### 2.1 Authentication (who you are) — Keycloak

- **Deployment**: Standalone (NOT in K8s).
- **Issuer / base URL**: `http://ias.siptory.com:8443`
- **Realm**: `Unified_SSO`
- **Client (for control plane)**: `insight`
- **Client secret**: provided out-of-band → store in K8s Secret `cp-keycloak` key `client-secret`. **Never commit.**
- **User source**: AD → LDAP sync into Keycloak. Users are read-only from the platform's perspective.
- **Current limitation**: Keycloak carries identity + zero-trust only. **No roles/groups defined yet.**

Derived OIDC endpoints (BFF config):
```
issuer:       http://ias.siptory.com:8443/realms/Unified_SSO
jwks_uri:     http://ias.siptory.com:8443/realms/Unified_SSO/protocol/openid-connect/certs
token:        http://ias.siptory.com:8443/realms/Unified_SSO/protocol/openid-connect/token
authorize:    http://ias.siptory.com:8443/realms/Unified_SSO/protocol/openid-connect/auth
```
`// TODO: confirm` — Keycloak is HTTP on :8443 (not HTTPS). Verify TLS posture; if it's actually TLS, switch scheme.

### 2.2 Authorization — two layers, do NOT push fine-grained into Keycloak

| Layer | Lives in | Controls | Granularity |
|-------|----------|----------|-------------|
| **Coarse RBAC** | Keycloak groups → JWT claim | Which feature pages, admin vs viewer | Role |
| **Fine-grained ABAC** | Control-plane policy DB (PostgreSQL) | Row / column / field-level data access & masking | Data |

**Action item for Keycloak (minimal)**: create coarse groups only, e.g. `data-platform-admin`, `data-analyst`, `data-viewer`, plus factory-scoped analyst groups (e.g. `data-analyst-fab1`). Map them into the `insight` client's token as a `groups` claim.

### 2.3 Data-access policy DB schema (control plane owns this)

Target: PostgreSQL, new schema `platform_metadata` (see §4 for connection). Core tables:

```sql
CREATE SCHEMA IF NOT EXISTS platform_metadata;

-- Subject: binds to a Keycloak group/role (do not duplicate AD users)
CREATE TABLE platform_metadata.acl_subject (
    subject_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_ref  TEXT NOT NULL,         -- e.g. 'data-analyst-fab1'
    subject_type  TEXT NOT NULL,         -- 'group' | 'role' | 'user'
    description   TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Row-level: inject WHERE filter for a (subject, table)
CREATE TABLE platform_metadata.acl_row_policy (
    policy_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id    UUID REFERENCES platform_metadata.acl_subject,
    catalog       TEXT NOT NULL,         -- 'iceberg' | 'clickhouse'
    schema_name   TEXT NOT NULL,         -- e.g. 'gold'
    table_name    TEXT NOT NULL,
    filter_expr   TEXT NOT NULL,         -- e.g. "process_id IN ('P1','P2')"
    enabled       BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Column-level (deny) + field-level (mask): one table, mask_type distinguishes
CREATE TABLE platform_metadata.acl_column_policy (
    policy_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id    UUID REFERENCES platform_metadata.acl_subject,
    catalog       TEXT NOT NULL,
    schema_name   TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    column_name   TEXT NOT NULL,
    mask_type     TEXT NOT NULL,         -- 'deny'|'full'|'partial'|'hash'|'none'
    mask_expr     TEXT,                  -- SQL template for 'partial'
    enabled       BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Audit: every data access decision (for compliance + the "preview as user" feature)
CREATE TABLE platform_metadata.acl_audit (
    audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_ref   TEXT,
    raw_sql       TEXT,
    rewritten_sql TEXT,
    engine        TEXT,                  -- 'trino' | 'clickhouse'
    decided_at    TIMESTAMPTZ DEFAULT now()
);
```

`mask_type` semantics: `deny` = column-level (project `NULL`); `full|partial|hash` = field-level masking; absent row = fully visible.

---

## 3. Architectural Layers

```
┌─────────────────────────────────────────────────────────────┐
│ L1  Front-end (IBM Carbon UI) — single entry via Ingress     │
└─────────────────────────────────────────────────────────────┘
                          │  JWT (Keycloak)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ L2  Control-plane BFF / Orchestrator (Go)                    │
│     - AuthN (JWT verify) + AuthZ (RBAC+ABAC)                 │
│     - Orchestration (multi-component "build pipeline")       │
│     - Aggregation (read state from DataHub)                  │
└─────────────────────────────────────────────────────────────┘
        │                 │                      │
        ▼                 ▼                      ▼
┌───────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│ L3a Ingest    │ │ L3b Orchestration│ │ L3c Query Gateway    │
│ Adapter       │ │ Adapter          │ │ (engine routing)     │
│ Debezium/etc  │ │ Airflow/Spark    │ │ Trino / ClickHouse   │
└───────────────┘ └──────────────────┘ └──────────────────────┘
        │                 │                      │
        ▼                 ▼                      ▼
┌─────────────────────────────────────────────────────────────┐
│ L4  Component layer (already deployed) + Storage             │
│     Debezium, Airflow, Spark, Iceberg REST, Trino,           │
│     ClickHouse, Kafka | MinIO, PostgreSQL                    │
└─────────────────────────────────────────────────────────────┘
                          │  (cross-cutting)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ L5  Metadata hub: DataHub GMS — schema / lineage / status    │
│     (Front-end reads catalog & lineage from HERE only)       │
└─────────────────────────────────────────────────────────────┘
        │  separate microservice
        ▼
┌─────────────────────────────────────────────────────────────┐
│ L6  SQL-Rewrite service (Python + sqlglot) — field masking   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Service / Endpoint Registry (verified from cluster)

All in-cluster DNS form: `<svc>.<namespace>.svc.cluster.local`.

### Components the control plane calls

| Capability | Component | In-cluster address | External LB / NodePort | Protocol | Auth | Service Account |
|-----------|-----------|--------------------|------------------------|----------|------|-----------------|
| CDC ingest | Debezium Connect | `debezium-connect.data-warehouse:8083` | NodePort `172.16.202.38:30012` | Kafka Connect REST | none | n/a (lock by NetPol) |
| Batch ingest | Airbyte | `airbyte-airbyte-server-svc.airbyte:8001` | — | Airbyte API | `// TODO` | `// TODO` |
| Stream | Flink | `flink-jobmanager.flink:8081` | `172.16.202.57` | Flink REST | `// TODO` | `// TODO` |
| Orchestration | Airflow | `airflow-webserver.airflow:8080` | `172.16.202.58` | REST API v1 | **none** | enable + svc acct |
| Batch engine | Spark master | `spark-master.spark:7077` / UI `:8080` | NodePort `:30077/:30080` | `kubectl exec` spark-submit | n/a | k8s RBAC |
| Schema/catalog | Iceberg REST | `iceberg-rest-catalog.data-warehouse:8181` | — | Iceberg REST | none | lock by NetPol |
| Federation query | Trino | `my-trino-trino.trino:8080` | `172.16.202.59` | Trino REST/JDBC | **none** | lock by NetPol |
| OLAP / hot query | ClickHouse | `clickhouse-service.default:8123` (HTTP), `:9000` (native) | `172.16.202.53` | HTTP/JDBC | **default/empty** | create cp user |
| Message bus | Kafka | `kafka-cluster.kafka:9092` | NodePort `:32700` | Kafka protocol | `// TODO` | — |
| Metadata hub | DataHub GMS | `datahub-datahub-gms.datahub:8080` | `172.16.202.61` | OpenAPI/GraphQL | `// TODO` token | cp token |
| DataHub UI | DataHub Frontend | `datahub-datahub-frontend.datahub:9002` | `172.16.202.60` | HTTP | — | — |

### Storage / data stores

| Store | In-cluster | External | Notes |
|-------|-----------|----------|-------|
| MinIO (S3) | `minio.default:9000` (console `:9001`) | `172.16.202.55` | creds `minioadmin/minioadmin` → move to Secret. Bucket `datalake-bronze-iceberg/`, raw under `datalake-raw/qms/<table>` |
| PostgreSQL | `postgres-external.pgsql:5432` | `172.16.202.54` | see §4.1 |
| Prometheus Pushgateway | `172.16.201.110:9091` | — | ETL pushes metrics here (from DAG) |
| Prometheus | `prometheus-k8s.kubesphere-monitoring-system:9090` | `172.16.202.66` | PromQL for Ops pages |
| Logs | `opensearch-cluster-master.kubesphere-logging-system:9200` | — | Ops "logs" tab |
| Errors | `my-sentry-web.sentry:80` | `172.16.202.68` | Ops "errors" |

### 4.1 PostgreSQL role & schema layout (VERIFIED — PG is NOT a query surface)

Host: `postgres-external.pgsql:5432` (ext `172.16.202.54`).

**Architecture principle (lakehouse, storage-compute separated)**: PostgreSQL does **not** serve analytical queries. All querying happens in **Iceberg (on MinIO)** and **ClickHouse**. PG's roles are narrow:
1. **ETL dual-write target + dimension source** (ETL-internal; control plane does NOT touch this) — see §5.5.
2. **Iceberg REST catalog JDBC backend** (DB `iceberg_catalog`).
3. **Control-plane's own store** (`platform_metadata`).

Schema/DB inventory:
- DB housing the QMS warehouse schemas contains `silver` (dims + facts) and `gold` (aggregates + SPC). **These PG tables are the *second leg* of an atomic dual-write, plus the JDBC source for dimension joins during ETL — they are NOT the query surface.** The authoritative query data lives in Iceberg (`silver_qms`, `gold_qms`) and ClickHouse.
- `iceberg_catalog` — **separate database**, Iceberg catalog's JDBC backend (production metadata, §5.3.1; do not touch). Connection string confirms it: `.../iceberg_catalog`.
- Others: `airbyte_prod`, `airflow_db`, `graphql_db`, `metastore`.
- **Control plane gets a NEW schema** `platform_metadata` (per §2.3).

**Consequence for the control plane**:
- `CatalogAdapter` authoritative source = **Iceberg REST catalog** (namespaces `bronze_qms`/`silver_qms`/`gold_qms`), NOT PG.
- Query gateway engines = **Iceberg-via-Trino** + **ClickHouse**. PG is never in the query routing path.
- The control plane connects to PG only for `platform_metadata` (its own data) and optionally read-only `gold`/`silver` for the policy "preview as user" feature — though preview should ideally run against Iceberg/ClickHouse to match the real query surface.

**VERIFIED**: `silver`/`gold` live in DB **`qms_warehouse`** (`172.16.202.54:5432/qms_warehouse`; also confirmed by Trino's postgresql catalog). `iceberg_catalog` is a separate DB. The control plane's `cp_app` role needs: full on `platform_metadata`; read on `qms_warehouse.gold`/`silver` only if the policy preview reads PG (preferably preview reads Iceberg/ClickHouse instead, so this grant may be unnecessary).

### 4.2 Registries & VCS

| Service | Address | Use |
|---------|---------|-----|
| Harbor (registry) | `172.16.202.30` | push control-plane images here, e.g. `172.16.202.30/ipas/control-plane:<tag>` |
| GitLab | `gitlab.siptory.com` | source + CI/CD; holds canonical DAG template (NO runtime git-sync — see §8.1) |
| Ingress | `ingress-nginx-controller` `172.16.202.51` (`:80/:443`) | single front-end + API entry |

---

## 5. Existing ETL Contract (what orchestration must wrap — DO NOT modify scripts)

Verified from the live DAG `dag_complete_multi_table_etl.py`.

### 5.1 Execution model
- DAG schedule: **`@hourly`**.
- Tasks are `PythonOperator`s that **locate the Spark master pod** (`namespace=spark`, label `component=master`) and run **`spark-submit --master local[4]`** inside it via the k8s API (exec), NOT KubernetesPodOperator. This is deliberate (reliability) — keep it.
- Scripts live at `/opt/bitnami/spark/jobs/` inside the Spark image:
  - `raw_to_bronze_etl.py`
  - `dimension_scd_etl.py`
  - `fact_table_etl.py`
  - `gold_aggregation_etl.py`
  - `silver_to_clickhouse_sync.py`
- Metrics pushed to Prometheus Pushgateway `172.16.201.110:9091`, job `ipas_che_etl_v2`.
- Lineage reported via `utils/lineage_reporter.LineageReporter` (→ DataHub).

### 5.2 Task dependency graph (the orchestration template)
```
raw_to_bronze_etl
        │
        ├─> etl_dim_categories ┐
        ├─> etl_dim_lines      ├─ (parallel dims)
        └─> etl_dim_processes  ┘
                 │
                 ▼
        etl_fact_analysis_records
                 │
                 ▼
        etl_fact_chemical_results
                 │
                 ▼
        validate_silver_tables
                 │
                 ▼
        gold_aggregation_etl
                 │
                 ▼
        clickhouse_sync
```
DIM_TABLES = `['categories','lines','processes']`
FACT_TABLES = `['analysis_records','chemical_analysis_results']`

### 5.3 Iceberg / S3 config the scripts rely on (FileIO split — keep intact)
```
spark.sql.catalog.iceberg                = org.apache.iceberg.spark.SparkCatalog
spark.sql.catalog.iceberg.type           = rest
spark.sql.catalog.iceberg.uri            = http://iceberg-rest-catalog.data-warehouse.svc.cluster.local:8181
spark.sql.catalog.iceberg.warehouse      = s3a://datalake-bronze-iceberg/
spark.sql.catalog.iceberg.io-impl        = org.apache.iceberg.hadoop.HadoopFileIO   # Spark side
spark.hadoop.fs.s3a.endpoint             = http://172.16.202.55:9000
spark.hadoop.fs.s3a.path.style.access    = true
# Catalog side uses S3FileIO with CATALOG_WAREHOUSE=s3a://datalake-bronze-iceberg/
```
**Invariant**: catalog side = `S3FileIO`; Spark side = `HadoopFileIO` + `s3a://`. They coexist only because `CATALOG_WAREHOUSE` uses the `s3a://` prefix. The control plane must never "fix" this into matching FileIO impls.

### 5.3.1 Iceberg REST Catalog backend (VERIFIED — production-grade)

Image: `apache/iceberg-rest-fixture:1.10.0` (this is the **only official REST-catalog image** Apache currently ships that resolves S3FileIO access — the `fixture` name is misleading; it is the standard choice here, not a test-only artifact).

Verified backend config (catalog deployment env):
```
CATALOG_CATALOG__IMPL = org.apache.iceberg.jdbc.JdbcCatalog
CATALOG_URI / CATALOG_JDBC_URL = jdbc:postgresql://postgres-external.pgsql.svc.cluster.local:5432/iceberg_catalog
CATALOG_WAREHOUSE     = s3a://datalake-bronze-iceberg/
CATALOG_IO__IMPL      = org.apache.iceberg.aws.s3.S3FileIO
CATALOG_S3_ENDPOINT   = http://minio.default.svc.cluster.local:9000
CATALOG_S3_PATH__STYLE__ACCESS = true
```

**Key fact**: catalog metadata is stored in **PostgreSQL** (DB `iceberg_catalog`), NOT SQLite. The prior "SQLite on /tmp" concern is obsolete — metadata is durable and survives catalog-pod restarts.

**Consequence for the control plane**: `CatalogAdapter` MAY treat the REST catalog (`:8181`) as an authoritative, trustworthy source for schema/table listing. No need to degrade to DataHub-only reads. DataHub remains the hub for lineage + cross-component status, but Iceberg schema can be read directly from the catalog.

**Residual cleanup (low-priority debt)**: an `iceberg-catalog-data-pvc` is still mounted at `/data`, and an init container (`fix-permissions`) still references the legacy `jdbc:sqlite:/data/iceberg_catalog.db` path. These are migration leftovers — the running container uses PG JDBC. The PVC + SQLite init reference can be removed in a cleanup pass (non-blocking).

**Security**: catalog `CATALOG_JDBC_PASSWORD` (`Pg123654`) and MinIO creds (`minioadmin/minioadmin`) are **plaintext in the deployment env** — same class as the ETL hardcoded-secrets debt. Move to K8s Secrets (see §13.2).

### 5.4 CDC source contract (verified connector `qms-che-connector-all-tables`)
```
connector.class : io.debezium.connector.mysql.MySqlConnector
topic.prefix    : qms
database.include.list : qms
table.include.list    : qms.categories, qms.lines, qms.processes,
                        qms.analysis_records, qms.chemical_analysis_results
schema.history.internal.kafka.topic : schema-changes.qms.all-tables
schema.history.internal.kafka.bootstrap.servers : kafka-cluster.kafka.svc.cluster.local:9092
snapshot.mode   : schema_only_recovery
decimal.handling.mode : double
transforms      : unwrap (ExtractNewRecordState, drop.tombstones=false, delete.handling.mode=rewrite)
source DB       : 172.16.201.30:12315 (MySQL), user debezium_user
```
**Known fragility to encode as guardrails**: schema-history topic must have `retention.ms=-1`, `retention.bytes=-1`. The "build pipeline" adapter must set these when creating new connectors.

Kafka → RAW mapping (from `register_cdc_lineage.py`):
`kafka: qms.qms.<table>` → `s3: datalake-raw/qms/<table>`.

### 5.5 Data flow & storage truth (VERIFIED from ETL scripts — lakehouse, storage-compute separated)

This is the single most important section for the control plane's data model. Verified by reading `fact_table_etl.py`, `gold_aggregation_etl.py`, `silver_to_clickhouse_sync.py`:

| Layer | Physical write target(s) | Query surface? |
|-------|--------------------------|----------------|
| RAW | MinIO `datalake-raw/qms/<table>` (from CDC streaming) | no |
| Bronze | **Iceberg** `bronze_qms.<table>` (on MinIO) | Iceberg/Trino |
| Silver — dims | **PostgreSQL** `silver.dim_*` | **No — read by Spark via JDBC during fact ETL only** (`fact_table_etl.py` "Loading dimensions from PostgreSQL") |
| Silver — facts | **Dual-write**: PG `silver.fact_*` **AND** Iceberg `silver_qms.<table>` (atomic, all-or-nothing) | Iceberg/Trino |
| Gold | **Dual-write**: PG `gold.*` **AND** Iceberg `gold_qms.*` | Iceberg/Trino |
| ClickHouse | synced **FROM Iceberg `gold_qms`** (`spark.table(iceberg.gold_qms.*)` → CH) | **ClickHouse (hot query / reports)** |

**Therefore**:
- **Querying never touches PG.** It hits Iceberg (detail/federation via Trino) or ClickHouse (hot/report). This is the storage-compute-separated lakehouse design.
- **Fact & Gold are dual-written** to PG + Iceberg for transactional consistency, but the *read path* is Iceberg/ClickHouse. PG fact/gold are the second leg, not a query target.
- **Dimensions live only in PG** and exist to be JOINed during Silver fact ETL. They are an ETL-internal concern, not a control-plane query surface.
- **Watermarks**: fact ETL keeps per-partition watermarks in Iceberg `iceberg.silver_qms._fact_etl_watermarks`. Gold keeps `_gold_etl_watermarks`. These are Iceberg metadata tables.

**Control-plane implications (override any earlier section that implied PG is the query store):**
1. `CatalogAdapter` reads Iceberg namespaces `bronze_qms` / `silver_qms` / `gold_qms` from the REST catalog as the authoritative catalog. (dims are PG-only and surfaced for lineage via DataHub, not as query datasets.)
2. Self-service analytics datasets = Iceberg `gold_qms` tables (+ ClickHouse mirror for hot path), NOT PG.
3. The control plane must NOT introduce a third write path or touch the dual-write — orchestration only triggers the existing ETL.

---

## 6. Data Model Reference (Silver / Gold)

> These tables exist in **both** PG and Iceberg (dual-write, §5.5), EXCEPT dimensions which are PG-only. The schema below is shared. The **query surface is the Iceberg copy** (`silver_qms` / `gold_qms`), plus the ClickHouse mirror of gold.
> Note: the `tableoid/cmin/cmax/xmin/xmax/ctid` columns in the DDL are Postgres system columns leaking into the dump — ignore them; they are not real user columns.

### 6.1 Silver — dimensions (SCD Type-2 pattern) — **PG-only, ETL-internal**
- `silver.dim_categories` (sk: `category_sk`, bk: `category_id`, `is_current`, `effective_date`/`expiration_date`)
- `silver.dim_lines` (sk: `line_sk`, bk: `line_id`)
- `silver.dim_processes` (sk: `process_sk`, bk: `process_id`)
- `silver.dim_date` (`date_key` PK, `full_date` unique) — static role-play dim
- `silver.dim_time` (`time_key` PK, `full_time` unique, `shift`)

### 6.2 Silver — facts (star schema) — **dual-written PG + Iceberg `silver_qms`**
- `fact_analysis_records` — grain: one analysis. FKs: `date_key, process_key, category_key, line_key`. Partitioned by `year/month/day`.
- `fact_chemical_results` — grain: one chemical measurement. Carries `result_value`, control/spec ranges, `judgment`. Partitioned by `year/month/day`.

### 6.3 Gold — aggregates & SPC — **dual-written PG + Iceberg `gold_qms`, mirrored to ClickHouse**
(per memory: ascending-date processing, 30-day SPC window, idempotent delete-then-insert)
- `agg_daily_summary` (unique `analysis_date`)
- `agg_qualification_rate_daily` (unique `process_name, shift, analysis_date`)
- `agg_warning_statistics_daily` (unique `process_name, shift, analysis_date`)
- SPC charts (ISO 7870 / AIAG): `spc_c_chart`, `spc_p_chart`, `spc_xbar_r_chart`, `spc_xbar_s_chart`, `spc_capability_daily` (Cp/Cpk/Pp/Ppk), `spc_trend_ma` (SMA/EMA), `spc_monthly_alarm_rate`, plus `spc_baseline` (Iceberg gold_qms).

The Iceberg `gold_qms` tables (and their ClickHouse mirror) are the **primary surface for self-service analytics**. ClickHouse serves the hot/report path; Trino serves Iceberg detail/federation.

---

## 7. Control-plane Backend — Go Project Layout

Module: `gitlab.siptory.com/ipas/control-plane`

```
control-plane/
├── cmd/
│   └── server/
│       └── main.go                # wire config, start HTTP+gRPC, graceful shutdown
├── internal/
│   ├── config/
│   │   ├── config.go              # env + file (viper); all endpoints from §4
│   │   └── config.yaml            # non-secret defaults
│   ├── auth/
│   │   ├── jwt.go                 # Keycloak JWKS verify (issuer Unified_SSO)
│   │   ├── middleware.go          # gin/chi middleware: verify + inject claims
│   │   └── rbac.go                # map Keycloak groups -> feature permissions
│   ├── authz/
│   │   ├── policy_store.go        # read acl_* tables (platform_metadata)
│   │   └── resolver.go            # subject(groups) -> row/column policies
│   ├── adapter/
│   │   ├── adapter.go             # interfaces (see §8)
│   │   ├── debezium/              # Kafka Connect REST client
│   │   ├── airflow/               # Airflow REST API v1 client
│   │   ├── spark/                 # (optional) trigger via Airflow only
│   │   ├── iceberg/               # Iceberg REST catalog (schema/table list)
│   │   ├── trino/                 # query exec
│   │   ├── clickhouse/            # query exec
│   │   ├── datahub/               # GMS GraphQL/OpenAPI (state, lineage)
│   │   └── k8s/                   # client-go: NetworkPolicy, pod status
│   ├── orchestrator/
│   │   ├── pipeline.go            # "build pipeline" saga (errgroup + rollback)
│   │   └── steps.go               # register connector / gen DAG / create table
│   ├── query/
│   │   ├── router.go              # ClickHouse vs Trino routing rule
│   │   └── rewrite_client.go      # calls L6 sql-rewrite microservice
│   ├── api/
│   │   ├── http/                  # REST handlers (BFF endpoints)
│   │   │   ├── pipelines.go
│   │   │   ├── query.go
│   │   │   ├── catalog.go         # proxy DataHub
│   │   │   ├── policies.go        # CRUD acl_* + "preview as user"
│   │   │   └── ops.go             # Prometheus/OpenSearch/Sentry proxy
│   │   └── dto/                   # request/response structs
│   ├── store/
│   │   └── postgres/              # platform_metadata access (pgx)
│   └── telemetry/
│       ├── metrics.go             # Prometheus client
│       └── logging.go             # structured logs -> Vector/OpenSearch
├── deploy/
│   ├── k8s/
│   │   ├── namespace.yaml         # control-plane ns
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   ├── ingress.yaml           # via 172.16.202.51
│   │   ├── secret.example.yaml    # cp-keycloak, cp-minio, cp-ch, cp-debezium-db
│   │   └── networkpolicy/         # one per locked component (see §9)
│   └── Dockerfile
├── .gitlab-ci.yml
├── go.mod
└── go.sum
```

### Recommended Go libraries
- HTTP router: `chi` or `gin`
- JWT/JWKS: `github.com/coreos/go-oidc/v3` + `golang.org/x/oauth2`
- Postgres: `github.com/jackc/pgx/v5`
- K8s: `k8s.io/client-go`
- Concurrency saga: `golang.org/x/sync/errgroup`
- Config: `spf13/viper`
- ClickHouse: `github.com/ClickHouse/clickhouse-go/v2`
- Trino: `github.com/trinodb/trino-go-client`

---

## 8. Adapter Interfaces (Go)

```go
package adapter

import "context"

// IngestAdapter abstracts CDC/batch/stream ingestion sources.
type IngestAdapter interface {
    CreateConnector(ctx context.Context, spec ConnectorSpec) (ConnectorID, error)
    GetConnectorStatus(ctx context.Context, id ConnectorID) (ConnectorStatus, error)
    DeleteConnector(ctx context.Context, id ConnectorID) error
    ListConnectors(ctx context.Context) ([]ConnectorStatus, error)
}

// OrchestrationAdapter abstracts Airflow DAG/job control.
type OrchestrationAdapter interface {
    EnsureDAG(ctx context.Context, spec DAGSpec) (DAGID, error)   // render template + write to shared DAG volume (see §8.1)
    TriggerDAG(ctx context.Context, id DAGID, conf map[string]any) (RunID, error)
    GetRunStatus(ctx context.Context, id DAGID, run RunID) (RunStatus, error)
    Backfill(ctx context.Context, id DAGID, from, to string) (RunID, error)
}

// CatalogAdapter abstracts Iceberg REST (schema/table truth at write side).
type CatalogAdapter interface {
    ListNamespaces(ctx context.Context) ([]string, error)
    ListTables(ctx context.Context, ns string) ([]TableMeta, error)
    GetSchema(ctx context.Context, ns, table string) (Schema, error)
    CreateTable(ctx context.Context, ns string, schema Schema) error // df.writeTo().create() is script-side; this is metadata-only
}

// QueryAdapter abstracts an execution engine (Trino or ClickHouse).
type QueryAdapter interface {
    Engine() string // "trino" | "clickhouse"
    Execute(ctx context.Context, sql string) (ResultSet, error)
}

// MetadataAdapter abstracts DataHub GMS (state, lineage, search).
type MetadataAdapter interface {
    Search(ctx context.Context, q string) ([]Asset, error)
    GetLineage(ctx context.Context, urn string) (LineageGraph, error)
    UpsertStatus(ctx context.Context, urn string, status any) error
}

// K8sAdapter abstracts cluster ops needed by the control plane.
type K8sAdapter interface {
    ApplyNetworkPolicy(ctx context.Context, np NetworkPolicySpec) error
    PodStatus(ctx context.Context, ns, labelSelector string) ([]PodStatus, error)
}
```

### 8.1 DAG deployment mechanism (VERIFIED — no git-sync)

Verified cluster state:
- Airflow `scheduler` and `webserver` are **two separate Pods**, currently both on node `k8s-worker-01`.
- DAG dir `/opt/airflow/dags` is a **`hostPath`** volume → node path `/data/conf/dags` (`type: DirectoryOrCreate`).
- **There is NO git-sync sidecar.** DAGs are NOT synced from GitLab at runtime.
- The **scheduler** is the process that scans the DAG dir and registers DAGs; the webserver only renders them.

**Implication**: `EnsureDAG` must place a rendered `.py` file where the scheduler can read it. Committing to a GitLab repo would do nothing (nothing pulls it). 

**Chosen approach (Plan A): shared RWX DAG volume.**
1. **Migrate** the DAG volume from `hostPath` → a **Longhorn `ReadWriteMany` PVC** named `airflow-dags-rwx`. This also fixes the latent bug where a Pod rescheduled to another node would see an empty `DirectoryOrCreate` dir and lose all DAGs.
2. Mount `airflow-dags-rwx` (read-only) into the control-plane BFF Pod at `/airflow-dags`, and (read-write) into scheduler + webserver at `/opt/airflow/dags`.
3. `EnsureDAG` renders the DAG from the §5.2 template and **writes the file** into the shared volume. The scheduler auto-discovers it on its next scan (`dag_dir_list_interval`, default 300s — tune down if faster pickup needed).

```
Control-plane BFF ──write .py──> [ Longhorn RWX PVC: airflow-dags-rwx ] <──read── Airflow scheduler
                                                                          <──read── Airflow webserver
```

GitLab role: holds the **canonical DAG template** (version-controlled, reviewed). CI bakes the template into the control-plane image. Runtime materialization goes to the shared volume — not git-sync. This keeps review/versioning in Git without coupling pipeline creation to GitLab availability.

`EnsureDAG` reference implementation:
```go
func (a *airflowAdapter) EnsureDAG(ctx context.Context, spec DAGSpec) (DAGID, error) {
    // 1. Render from embedded template (baked from GitLab at build time)
    var buf bytes.Buffer
    if err := a.dagTmpl.Execute(&buf, spec); err != nil {
        return "", fmt.Errorf("render dag: %w", err)
    }
    // 2. Atomic write into shared RWX volume: temp file then rename
    dagID := DAGID("ipas_pipeline_" + spec.Name)
    final := filepath.Join(a.dagsDir, string(dagID)+".py") // a.dagsDir = "/airflow-dags"
    tmp := final + ".tmp"
    if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
        return "", fmt.Errorf("write dag: %w", err)
    }
    if err := os.Rename(tmp, final); err != nil { // atomic; scheduler never sees partial file
        return "", fmt.Errorf("rename dag: %w", err)
    }
    // 3. (optional) wait for scheduler to register via Airflow REST GET /dags/{id}
    return dagID, a.waitForRegistration(ctx, dagID)
}
```

PVC migration manifest (`deploy/k8s/airflow-dags-pvc.yaml`):
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: airflow-dags-rwx
  namespace: airflow
spec:
  accessModes: [ReadWriteMany]
  storageClassName: longhorn          # RWX via Longhorn share-manager (NFS)
  resources:
    requests:
      storage: 2Gi
```
Then patch scheduler + webserver Deployments to replace the `hostPath` volume with this PVC, and **one-time copy** existing DAGs from `/data/conf/dags` on `k8s-worker-01` into the new PVC before cutover.

`// TODO: confirm` — Longhorn RWX (share-manager) is enabled (the cluster already shows `share-manager` PVCs in `longhorn-system`, so RWX works). Decide `dag_dir_list_interval` for desired pickup latency.

---

## 9. NetworkPolicy plan (Calico) — lock裸奔 components

For each component below, default-deny ingress, then allow only from `control-plane` ns + legitimate internal callers.

| Target | Allow ingress from | Port |
|--------|--------------------|------|
| `debezium-connect.data-warehouse` | `control-plane` | 8083 |
| `my-trino-trino.trino` | `control-plane`, `spark` (if it queries) | 8080 |
| `clickhouse-service.default` | `control-plane`, `spark` (sync writes) | 8123/9000 |
| `airflow-webserver.airflow` | `control-plane` | 8080 |
| `iceberg-rest-catalog.data-warehouse` | `control-plane`, `spark`, `airflow` | 8181 |

Skeleton (one file per target under `deploy/k8s/networkpolicy/`):
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: lock-debezium
  namespace: data-warehouse
spec:
  podSelector:
    matchLabels: { app: debezium-connect }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: control-plane }
      ports:
        - protocol: TCP
          port: 8083
```
`// TODO: confirm` — Calico is enforcing K8s NetworkPolicy (it is, per cluster CNI). Verify no existing global allow-all overrides these.

---

## 10. Query Gateway — routing + masking

### 10.1 Engine routing rule (in `query/router.go`)

Two query surfaces (PG is never one of them — §5.5):
- **ClickHouse** = mirror of Iceberg `gold_qms` — hot path for finished reports/aggregates.
- **Trino over Iceberg** = `bronze_qms`/`silver_qms`/`gold_qms` detail + any federation.

```
IF query targets a Gold report/aggregate already mirrored in ClickHouse
   AND is an aggregation/point-lookup
   -> route ClickHouse (clickhouse-service.default:8123)
ELSE  // Iceberg detail (bronze/silver/gold), large scans, or cross-source federation
   -> route Trino over Iceberg (my-trino-trino.trino:8080)
```
Engine choice is invisible to the front-end; it calls `POST /api/query` only. Trino's `iceberg` catalog must point at the same REST catalog (`:8181`) the ETL uses.

**VERIFIED — all three catalogs already configured** (`my-trino-trino-catalog` configmap). Federation is ready out of the box; the query gateway only needs to *route*, Trino does the execution:

| Trino catalog | Points at | Use |
|---------------|-----------|-----|
| `iceberg` | REST `iceberg-rest-catalog:8181` + MinIO S3 (`register-table-procedure.enabled=true`) | same catalog the ETL writes — `iceberg.bronze_qms/silver_qms/gold_qms.*` queryable now |
| `clickhouse` | `172.16.202.53:8123/default` | hot/report path |
| `postgresql` | `172.16.202.54:5432/qms_warehouse` | available for joins, but NOT the analytics query surface (§5.5) |
| `tpcds`,`tpch` | benchmark | ignore |

A single Trino session can join across `iceberg.*`, `clickhouse.*`, and `postgresql.*`. So **cross-source federation needs zero additional setup** — `query/router.go` decides ClickHouse-direct vs Trino, and Trino handles everything else.

**Security note**: this configmap stores plaintext creds (`postgresql` password `Pg123654`, iceberg `minioadmin/minioadmin`), and Trino has no auth. A Trino that can join *everything* with embedded credentials is a high-value open door — **NetworkPolicy lockdown (§9) is mandatory and high-priority** for `my-trino-trino`. Move these creds to mounted Secrets.

### 10.2 Masking flow (combines L2 authz + L6 rewrite)
```
1. BFF verifies JWT, resolves subject's groups.
2. authz/resolver loads row + column policies for those groups.
3. BFF calls L6 sql-rewrite service with {raw_sql, row_filters, column_policies, engine_dialect}.
4. L6 returns rewritten SQL (WHERE injected, columns NULL/ masked).
5. BFF routes rewritten SQL to the chosen QueryAdapter.
6. BFF writes acl_audit row.
```

**Engineering decision (chosen)**: hybrid.
- Row-level → prefer engine-native (Trino rules / ClickHouse ROW POLICY) where stable.
- Field-level masking → always via L6 rewrite (engine-native masking differs across Trino/ClickHouse; centralize for consistency).
- Masking functions execute **inside the engine** (push down `substr/concat/sha256`), never by pulling full data into the BFF.

### 10.3 L6 SQL-Rewrite microservice
- Language: **Python**, lib: `sqlglot` (best-in-class; reason it's a separate service so Go BFF isn't bound to it).
- Image: `172.16.202.30/ipas/sql-rewrite:<tag>`, deployed in `control-plane` ns.
- Endpoint: `POST /rewrite` `{sql, dialect, row_filters[], column_policies[]}` → `{sql}`.
- Stateless; horizontally scalable.

---

## 11. Front-end ↔ BFF API surface (initial)

| Page domain | Method + path | Backend action |
|-------------|---------------|----------------|
| Self-service analytics | `POST /api/query` | route + mask + execute |
| | `GET /api/datasets` | list Gold tables (via DataHub/Iceberg) |
| Data dev — pipelines | `POST /api/pipelines` | orchestrator saga (§ below) |
| | `GET /api/pipelines` | aggregate Debezium+Airflow status from DataHub |
| | `GET /api/pipelines/{id}` | per-pipeline detail |
| Data dev — sources | `GET/POST /api/datasources` | Debezium/connection mgmt |
| Catalog | `GET /api/catalog/search` | proxy DataHub search |
| | `GET /api/catalog/lineage` | proxy DataHub lineage |
| Governance | `GET/POST /api/policies/row` | CRUD acl_row_policy |
| | `GET/POST /api/policies/column` | CRUD acl_column_policy |
| | `POST /api/policies/preview` | run rewritten query "as user X" |
| Ops | `GET /api/ops/runs` | Airflow runs + Prometheus |
| | `GET /api/ops/logs` | OpenSearch query |
| Admin | `GET /api/admin/users` | read Keycloak (read-only) |

### "Build pipeline" saga (orchestrator/pipeline.go)
```
POST /api/pipelines { source, target_layer, schedule, tables[] }
  errgroup:
    g1: Debezium.CreateConnector(spec)   // + set schema-history retention=-1
    g2: Iceberg.CreateTable(metadata)    // RAW/Bronze targets
  then (sequential):
    Airflow.EnsureDAG(template from §5.2) // write rendered .py to shared RWX DAG volume (§8.1)
    DataHub.UpsertStatus(pipeline urn)
  on any failure -> rollback (delete connector, drop table, revert commit)
```

---

## 12. Deployment & CI/CD

### 12.1 Namespaces
- New: `control-plane` (BFF, L6 rewrite, their Services + Ingress).
- Existing referenced: `data-warehouse`, `airflow`, `spark`, `trino`, `datahub`, `default`, `pgsql`, `kafka`.

### 12.2 Images (Harbor `172.16.202.30`)
- `172.16.202.30/ipas/control-plane:<git-sha>`
- `172.16.202.30/ipas/sql-rewrite:<git-sha>`

### 12.3 Secrets (K8s, never in Git)
- `cp-keycloak`: client-secret for `insight`.
- `cp-minio`: MinIO access/secret (replace defaults).
- `cp-clickhouse`: dedicated CH user/password (create; do not use empty default).
- `cp-debezium-db`: source DB creds if BFF needs them for connector specs.
- `cp-postgres`: `cp_app` role for `platform_metadata`.

### 12.4 GitLab CI (`gitlab.siptory.com`)
Stages: `lint -> test -> build -> push(Harbor) -> deploy(k8s)`. The DAG template is version-controlled in GitLab and baked into the control-plane image at build time (§8.1).

**DAG deployment (VERIFIED)**: No git-sync sidecar exists. DAG dir is a `hostPath` (`/data/conf/dags`) — to be migrated to a Longhorn RWX PVC `airflow-dags-rwx` shared with the control plane. See §8.1 for the full mechanism. GitLab holds the canonical DAG template (baked into the control-plane image at build); runtime DAGs are written to the shared volume by `EnsureDAG`.

---

## 13. Tech-debt & follow-ups (track, don't block)

1. **Amundsen vs DataHub overlap** — both run (Amundsen `172.16.202.62` + neo4j; DataHub `172.16.202.60/61`). Standardize on **DataHub**, plan Amundsen decommission. Front-end catalog must read DataHub only.
2. **Default/empty credentials (plaintext everywhere)** — MinIO `minioadmin`, ClickHouse empty password, Debezium source-DB password, Iceberg catalog `CATALOG_JDBC_PASSWORD`, and the **Trino `my-trino-trino-catalog` configmap** (`postgresql` password `Pg123654` + MinIO keys). Spread across ETL scripts, catalog deployment env, and the Trino configmap. Rotate into K8s Secrets.
3. **Keycloak roles** — currently none. Add coarse groups before RBAC works.
4. **Keycloak on HTTP :8443** — verify TLS.
5. **Ingest sprawl** — Debezium + Airbyte + Flink + NiFi all present. Long-term, the ingest adapter should expose one "create ingestion" concept and pick the engine; don't surface four tools to users.
6. **Hardcoded secrets in ETL scripts** — out of scope here (scripts immutable), but flag for a future secret-injection pass.
7. **Airflow DAG dir is `hostPath` (single-node) — latent data-loss bug.** scheduler+webserver currently co-located on `k8s-worker-01`; if either reschedules to another node, `DirectoryOrCreate` yields an empty dir and DAGs vanish. Fixed by the §8.1 RWX PVC migration — prioritize this even independent of the control plane.
8. **Iceberg catalog migration leftovers** — `iceberg-catalog-data-pvc` (mounted `/data`) and the `fix-permissions` init container's `jdbc:sqlite:/data/...` reference are dead remnants from the pre-PG era. Remove in a cleanup pass; non-blocking (running container uses PG JDBC).

---

## 14. Open questions for the owner (`// TODO: confirm`)

Resolved since first draft: ✅ PG DB name (`qms_warehouse`) · ✅ Iceberg catalog backend (PG JDBC, durable) · ✅ Trino catalogs (all three ready) · ✅ DAG deploy mechanism (no git-sync; RWX PVC plan) · ✅ storage/query surface (Iceberg+ClickHouse, not PG).

Still open (none block starting §8.1 or §10):
1. Airbyte / Flink / Kafka / DataHub-GMS **auth state** (Debezium/Trino/CH/Airflow verified open).
2. Keycloak **TLS** posture on :8443, and desired `groups` claim mapping for client `insight`.
3. Whether ClickHouse and Trino must stay reachable by `spark`/other ns (affects NetworkPolicy allow-lists — note `spark` writes the CH mirror and reads Iceberg, so it likely needs CH + Iceberg-catalog access, not Trino).
4. Desired `dag_dir_list_interval` (DAG pickup latency after `EnsureDAG` writes the file).
5. MES scrap sub-domain (in parallel dev per memory): should the control plane manage its Iceberg tables now, or after it stabilizes?
