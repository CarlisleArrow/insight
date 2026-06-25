# IPAS Control Plane (BFF)

The single backend the IPAS front-end talks to. It hides the heterogeneous data
stack (Debezium / Airflow / Spark / Iceberg / Trino / ClickHouse / DataHub /
Postgres) behind one API and one auth boundary. See `../ARCHITECTURE.md` for the
full design; section references below (§) point there.

This repository implements the **full backend** with **real adapters only** (no mock):

- **Auth boundary** — Keycloak JWT verify (`go-oidc`) + coarse RBAC (§2.2), with a
  gated dev bypass for local runs.
- **`platform_metadata` store** (§2.3 + datasource) — pgx, auto-migrated on boot.
- **Adapters** (§8) — real clients for Debezium (Kafka-Connect REST), Airflow
  (REST v1 + §8.1 DAG write), Iceberg REST, Trino (`trino-go-client`), ClickHouse
  (`clickhouse-go/v2`), DataHub (GraphQL), Prometheus, OpenSearch, Sentry,
  Keycloak Admin, and K8s (`client-go`).
- **Query gateway** (§10) — engine routing (ClickHouse vs Trino) + the L6
  SQL-rewrite masking flow, executed on the real engine.
- **Orchestrator** (§11) — "build pipeline" saga (errgroup + rollback).
- **Endpoints** (§11) — `query`, `datasets`, `pipelines` (+POST saga, +`/{id}`),
  `datasources` (CRUD), `catalog/{search,lineage}`, `policies/{row,column,preview}`,
  `ops/{runs,logs,metrics,errors}`, `admin/users`.

The L6 masking microservice lives in `../sql-rewrite` (Python + sqlglot).

> Downstream calls require cluster reachability — run `telepresence connect` on the
> host (then `go run ./cmd/server`) or deploy the image into the cluster. Secrets
> are env-only: `CP_KEYCLOAK_CLIENT_SECRET`, `CP_POSTGRES_PASSWORD`,
> `CP_ADAPTERS_CLICKHOUSE_PASSWORD`, `CP_ADAPTERS_DATAHUB_TOKEN`, `CP_ADAPTERS_SENTRY_TOKEN`.

## Run locally

```bash
cd deploy
docker compose up --build
```

This starts Postgres, the L6 service (`:8000`), and the BFF (`:8088`) in **dev
mode** (`CP_DEV_AUTH_BYPASS=true`, `CP_DEV_USE_MOCK_ADAPTERS=true`). The BFF runs
the `platform_metadata` migration on boot.

### Smoke test

```bash
# liveness
curl localhost:8088/healthz

# auth boundary: 401 without a token UNLESS dev bypass is on (compose enables it)
curl localhost:8088/api/datasets

# create a row policy + a column mask for the analyst group
curl -XPOST localhost:8088/api/policies/row -H 'content-type: application/json' -d '{
  "keycloak_ref":"data-analyst","catalog":"iceberg","schema":"gold_qms",
  "table":"fact_chemical_results","filter_expr":"process_id IN ('\''P1'\'')"}'

curl -XPOST localhost:8088/api/policies/column -H 'content-type: application/json' -d '{
  "keycloak_ref":"data-analyst","catalog":"iceberg","schema":"gold_qms",
  "table":"fact_chemical_results","column":"result_value","mask_type":"full"}'

# run a query AS the analyst group — observe injected WHERE + masked column
curl -XPOST localhost:8088/api/policies/preview -H 'content-type: application/json' -d '{
  "sql":"SELECT process_id, result_value FROM gold_qms.fact_chemical_results",
  "target":{"catalog":"iceberg","schema":"gold_qms","table":"fact_chemical_results"},
  "groups":["data-analyst"]}'
```

The preview response's `rewritten_sql` shows `'***' AS result_value` and the
`process_id IN ('P1')` filter injected by L6 — and the decision is recorded in
`platform_metadata.acl_audit`.

## Run without Docker

```bash
go build ./...
go vet ./...
# needs a reachable Postgres + L6; set env then:
CP_DEV_AUTH_BYPASS=true CP_DEV_USE_MOCK_ADAPTERS=true \
CP_POSTGRES_HOST=localhost CP_POSTGRES_PASSWORD=devpass \
CP_REWRITE_BASE_URL=http://localhost:8000 \
go run ./cmd/server
```

## Configuration

`internal/config/config.yaml` holds non-secret defaults (all §4 addresses).
Override anything via `CP_`-prefixed env vars (`.` → `_`), e.g.
`CP_POSTGRES_HOST`, `CP_DEV_AUTH_BYPASS`. **Secrets are env/Secret-only** and never
live in the file: `CP_KEYCLOAK_CLIENT_SECRET`, `CP_POSTGRES_PASSWORD`.

## Deploy (skeletons, not applied)

`deploy/k8s/` holds namespace, deployment, service, ingress, `secret.example.yaml`,
the §8.1 `airflow-dags-pvc.yaml`, and the §9 `networkpolicy/` lock files. These are
authored for review; applying them requires cluster access and the real Secrets.

## Known prerequisites (after Telepresence is connected)

- Most §4 components have **no auth** (locked by §9 NetworkPolicy); the BFF reaches
  them with service accounts.
- **`admin/users`**: the `insight` client's service account needs the
  realm-management `view-users` role (§14.2), or the call returns 403.
- Provide `CP_ADAPTERS_DATAHUB_TOKEN` / `CP_ADAPTERS_SENTRY_TOKEN` for those sources.
- The K8s adapter is optional: if no in-cluster/kubeconfig is resolvable, it is
  disabled with a warning (NetworkPolicy apply / pod-status off), the data path
  is unaffected.
