# IPAS 数据平台控制面 — 实现进展（对照 ARCHITECTURE.md）

> 更新于 2026-06-24。逐节对照 `ARCHITECTURE.md` §1–§14 标注完成度。
> 图例：✅ 已实现并联调 · 🟡 已实现/已编写但未应用或未完全验证 · ⬜ 未做 · ➕ 超出规格的额外实现。

---

## 总览

| 架构章节 | 状态 | 摘要 |
|---------|------|------|
| §1 安全基线 | 🟡 | BFF 收口为唯一 auth 边界 ✅；secrets env 化 ✅；NetworkPolicy 已写 yaml + K8s adapter，**未 apply** |
| §2 身份与授权 | ✅ | Keycloak JWT 验签 ✅；coarse RBAC ✅；ABAC `acl_*` 表 + resolver + L6 ✅ |
| §3 分层 | ✅ | L1–L6 全部落地 |
| §4 组件/端点注册表 | ✅ | 所有调用方适配器接通（真实集群） |
| §5 ETL 契约 | ✅ | 未改脚本（脚本不可变原则）；编排只 wrap |
| §6 数据模型 | ✅ | silver/gold schema 用于语义模型 + 指标提炼 |
| §7 Go 工程布局 | ✅➕ | 按规格 + 额外 health/msp/report/quality 包 |
| §8 适配器接口 | ✅➕ | 全部实现并扩展多方法 |
| §8.1 DAG 部署机制 | 🟡 | `EnsureDAG` 写 RWX 卷已实现；PVC 迁移 yaml 已写，**未 apply** |
| §9 NetworkPolicy | 🟡 | 5 个 lock yaml + adapter，**未 apply** |
| §10 查询网关 | ✅ | 路由(CH/Trino) + L6 脱敏 + 审计 |
| §11 前端↔BFF API | ✅➕ | 规格端点全做 + 大量扩展（构建器/报表/语义/总览/me 等） |
| §12 部署 CI/CD | 🟡 | k8s 清单 + Dockerfile 已写；本地 Telepresence 跑通；CI 未建 |
| §13 技术债 | 📋 | 跟踪中（见末尾） |
| §14 开放问题 | ✅ | 多项已解（DataHub schema/Airflow auth/Keycloak TLS） |

---

## §1 安全基线

- ✅ **BFF 唯一 auth 边界**：所有 `/api/*` 走 `auth.Middleware`（JWT 验签）+ `RequirePermission`（coarse RBAC）。
- ✅ **secrets 出码**：PG/CH/DataHub/Sentry/Keycloak/Airflow/MSP 全部 env-only（`run-dev.ps1` 注入；`config.yaml` 仅非敏感默认）。
- 🟡 **NetworkPolicy 锁裸奔组件**：`deploy/k8s/networkpolicy/` 已写 5 份（debezium/trino/clickhouse/airflow/iceberg），`adapter/k8s` 的 `ApplyNetworkPolicy` 已实现，但**未在集群 apply**（需集群权限）。

## §2 身份与授权

- ✅ **AuthN**：`auth/jwt.go` Keycloak（`Unified_SSO`，client `insight`）JWKS 验签；issuer 已确认 **https**://ias.siptory.com:8443。dev bypass 注入合成 `data-platform-admin`。
- ✅ **Coarse RBAC**：`auth/rbac.go` group→permission；➕ 新增 `analytics:write`/`modeling:write`。
- ✅ **Fine-grained ABAC**：`platform_metadata.acl_subject/acl_row_policy/acl_column_policy/acl_audit`（migration 0001）+ `authz/resolver.go` + L6 改写。
- ✅ **policy DB**：迁移自动执行（`store.Migrate`）。
- 📌 **Keycloak 现状**：realm 无 groups/role 自定义属性；用户的 org/name 从 **LDAP_ENTRY_DN** 解析（OU→组织、CN→姓名），role 统一 `Regular user`；机器账号(`$`结尾)过滤；全量分页 + 5min 缓存。

## §3 架构分层

L1 Carbon SPA ✅ · L2 Go BFF ✅ · L3 Ingest/Orch/Query 适配器 ✅ · L4 组件层（既有）✅ · L5 DataHub GMS ✅ · L6 SQL-rewrite（本地 Docker，`:8000`）✅。

## §4 组件/端点注册表

所有「控制面调用方」适配器接通真实集群：Debezium / Airflow(2.7.3, Basic auth) / Iceberg REST / Trino / ClickHouse / DataHub GMS / Prometheus(instant+range) / OpenSearch / Sentry / Keycloak Admin / K8s。存储：PG(`platform_metadata`)、MinIO/Kafka（健康探测）。
- 📌 已知偏差：Airflow 实际**启用认证**（规格写 none）→ 用 Basic `admin/Admin2025`；PG 不支持 SSL → `sslmode=disable`。

## §5 ETL 契约

- ✅ **脚本不可变**：未改任何 `etls/*.py`。编排只 wrap（§11 saga）。
- ✅ 已审 `utils/lineage_reporter.py` → 确认其只上报 status/properties/upstreamLineage、**无 schemaMetadata**（这是 DataHub 缺 column 的根因，见 §11 目录部分）。

## §6 数据模型

silver 事实(`fact_analysis_records`/`fact_chemical_results`)+维度(`dim_*`) → 语义模型星型图；gold `agg_*`/`spc_*` → glossary 业务指标提炼。

## §7 Go 工程布局

按规格 `cmd/` `internal/{config,auth,authz,adapter,orchestrator,query,api,store,telemetry}`。
➕ 额外包：`adapter/health`(组件健康探测)、`adapter/msp`(通知网关)、`internal/report`(报表 runner+scheduler)、`api/http/quality.go`(质量分缓存)。

## §8 适配器接口

全部接口实现，并按需扩展：
- IngestAdapter ➕ `UpdateConnector`
- OrchestrationAdapter ➕ `PauseDAG` / `GetDAG`(任务图) / `ListDAGIDs`
- CatalogAdapter ✅（Iceberg REST schema/table）
- QueryAdapter ✅（Trino + ClickHouse）
- MetadataAdapter ➕ `Facets` / `ListGlossaryTerms` / `GetDatasetSchema`；Asset ➕ `urn`/`score`
- MetricsAdapter ➕ `QueryRange`（Prometheus range，监控时序）
- AdminAdapter ➕ `GetUser` / `CreateUser` / `UpdateUser` / `DeleteUser` / `ListSessions` / `DeleteSession`
- K8sAdapter ✅（可选，无 kubeconfig 则禁用，不影响数据路径）

### §8.1 DAG 部署
- ✅ `airflow.EnsureDAG` 渲染模板 → 原子写入共享 RWX 卷（temp+rename）。
- 🟡 `deploy/k8s/airflow-dags-pvc.yaml`(Longhorn RWX) 已写，**未迁移/未 apply**。

## §9 NetworkPolicy
🟡 5 份 lock yaml + `ApplyNetworkPolicy` 已写，**未 apply**（同 §1）。

## §10 查询网关
- ✅ **路由**（`query/router.go`）：Gold 聚合/点查 → ClickHouse，其余 → Trino；➕ `ForEngine` 强制引擎（构建器全限定名走 Trino 联邦，避开 `gold_qms`↔`qms_gold` 命名歧义）。
- ✅ **脱敏流**：JWT→groups→resolver→L6 `/rewrite`（行过滤注入 + 列遮罩）→执行→写 `acl_audit`。
- ✅ **L6**：本地 Docker，`POST /rewrite`；已修 nil-slice→`[]`（避 FastAPI 422）。

## §11 前端↔BFF API（规格端点 + 扩展）

| 规格端点 | 状态 | 备注/扩展 |
|---------|------|----------|
| `POST /api/query` | ✅ | + ➕`/api/query/build`(结构化 spec→白名单校验→SQL→多序列 chartData) |
| `GET /api/datasets` | ✅ | 扩展为 bronze/silver/gold 三层；+ ➕`/datasets/{ns}/{table}/schema` |
| `POST /api/pipelines`(saga) | ✅ | `orchestrator.BuildPipeline`：errgroup 并行(连接器+表)→DAG→DataHub + LIFO 补偿回滚；前端 DevConfig「Build pipeline」向导已接入 |
| `GET /api/pipelines` `/{id}` | ✅ | + ➕`/dag` `/run` `/pause` `/backfill` |
| `GET/POST /api/datasources` | ✅ | ➕ 改为**实时健康探测** 11 组件；+ ➕`/connectors` CRUD |
| `GET /api/catalog/search` `/lineage` | ✅ | + ➕`/facets` `/asset`（schema+sample+lineage+quality+usage） |
| `GET/POST /api/policies/row` `/column` `/preview` | ✅ | + ➕`/access/users` `/access/roles` |
| `GET /api/ops/runs` `/logs` | ✅ | + ➕`/metrics`(instant) `/metrics/range` `/errors` `/sla` `/runs/{id}/retry` |
| `GET /api/admin/users` | ✅ | + ➕ 用户 CRUD、`/admin/{audit,orgs,config,tenancy,apikeys}` |
| **➕ 自助分析扩展** | ✅ | `/dashboards`(+`/render`)、`/reports`(+`/run` `/runs` `/download`)、`/metrics`(DataHub Glossary)、`/semantic-model` |
| **➕ 总览/通知/个人中心** | ✅ | `/overview`、`/notifications*`、`/me*` |

### 自助分析专项（四子页全实装）
- ✅ Ad-hoc query：三层数据集 + 可视化构建器(多维度+多度量) / SQL。
- ✅ Dashboard gallery：真实 CRUD + 卡片首图懒加载(`renderDashboard`)。
- ✅ Dashboard editor：加载/保存 widgets、集群字段、widget 真实查询、缩放、Save/Preview/Share/Subscribe、移动/缩放手柄。
- ✅ 12 图表类型：Bar/Grouped/Stacked/Line/Area/Scatter/Pie/Donut/Word cloud/Gauge/Heatmap/Table。
- ✅ Report subscriptions：绑定仪表板、Run now、运行历史、下载、cron 调度 + MSP 分发。

### 前端各页接线状态（全部真实，无 mock）
Overview ✅ · Modeling(指标←Glossary / 语义←真实星型) ✅ · DevConfig(数据源/DAG/CDC/DQ) ✅ ·
Governance(目录/分面/资产详情/血缘/访问控制) ✅ · Monitoring(任务/资源时序/SLA) ✅ ·
Admin(用户/审计/组织/配置/租户/密钥) ✅ · Profile ✅ · 通知 ✅ · Login(布局+动画按 handoff 重做) ✅。

## §12 部署 / CI/CD
🟡 `deploy/k8s/`(namespace/deployment/service/ingress/secret.example/pvc/networkpolicy) + `deploy/Dockerfile` 已写；本地 Telepresence + `run-dev.ps1` 跑通；Harbor 推镜像 + GitLab CI 流水线未建。

## §13 技术债（跟踪）
1. NetworkPolicy/PVC 未 apply（需集群权限）。
2. MinIO/CH/Debezium/Iceberg 明文默认凭证未轮换进 Secret。
3. Keycloak 无 groups/roles → org/role 暂从 LDAP DN 解析。
4. DataHub 重复/空壳节点（三 catalog 各采一遍 + 旧 lineage stub）待 stateful 清理。
5. ETL `process_name` 存 UUID（未 join 维度）——ETL 侧问题。
6. `mockData.js` 残留死种子数组（无 import，纯 UI 常量仍用）。

## §14 开放问题（进展）
- ✅ DataHub schema：经 **Trino source ingestion** 补全（executor 缺 pyiceberg → 走 Trino 联邦）；3 份 recipe(iceberg/clickhouse/postgresql) 带 stateful。
- ✅ Business Glossary：`glossary.yml` 14 个 QMS 指标导入成功（38 events）；Metrics 页读取。
- ✅ Airflow auth：确认启用 → Basic。 ✅ Keycloak TLS：确认 https:8443。
- ✅ 质量分：DataHub profiling 不可用(GE 缺 pkg_resources) → BFF 自算 completeness（采样+缓存）。
- 🟡 MSP 分发：适配器就绪；凭证(`CP_ADAPTERS_MSP_*`)待填才真分发。

---

## 验证

```bash
cd control-plane && go build ./... && go vet ./... && go test ./internal/api/http/   # 全绿
.\run-dev.ps1     # Telepresence 已连 + secrets 已配；看 platform_metadata ready / using REAL adapters / report scheduler started
npm run dev       # Vite 代理 /api → :8088；逐页确认 Network 全 /api/*、无 mock
```
