# IPAS 前端交互缺口清单(给 Claude Code 逐项补全)

> 基于对 `insight` 仓库 `src/pages/*` 与 `control-plane` 后端的实际代码审查(2026-06-30)。
> 前提结论:**前端整体质量高,数据接线健康(DataProvider 真连后端、新页直调 api.js)、CRUD/导出/确认删除/toast/发布向导/建模画布均完整,无 TODO/空 onClick/占位**。本清单只列「设计应有 vs 实现现状 vs 缺什么」的真实缺口,按优先级排序。
>
> 格式:每项 = 位置 · 现状 · 缺什么 · 后端是否就绪 · 验收标准。

---

## 🔴 P0 — 后端/api.js 已就绪、前端没建 UI(纯前端工作,投入产出比最高)

### P0-1. DataServices 详情页(整体缺失)
- **位置**:`src/pages/DataServices.jsx`
- **现状**:列表(ApiGallery)+ 发布向导(5 步 stepper,完整)都很好;`onOpen(r)` 回调存在,但**点开后没有详情页**。
- **缺什么**(详情页 + 多 tab):
  - **Overview tab**:端点 URL(带复制)、认证模式、状态、所有者、描述、版本;状态操作按钮(发布/下线 → 调 `publishDataApi`/`deprecateDataApi`)
  - **Contract tab**:字段白名单(可编辑)、参数定义、排序白名单、脱敏说明
  - **Authentication tab**:当前认证模式 + **API Key 管理**(列表 `listDataApiKeys` / 创建 `createDataApiKey` — 创建后**一次性展示明文 key + 复制**,之后只存 hash / 吊销 `deleteDataApiKey`);按 key 设 scope/过期/查 last-used
  - **Docs tab**:自动生成的 OpenAPI 展示 + **Try-it 交互式调试器**(填白名单参数 → 调 `GET /data-api/v1/<name>?...` → 展示返回 JSON + 状态码 + 耗时)
  - **Usage tab**:调用量时序、按调用方统计、限流命中、配额使用
  - **Audit tab**:调用审计(复用 acl_audit:时间/调用方/参数/返回行数/是否触发脱敏)
  - **Versions tab**:版本列表,发布新版本/弃用旧版本
- **后端就绪**:✅ `getDataApi` / `publishDataApi` / `deprecateDataApi` / `listDataApiKeys` / `createDataApiKey` / `deleteDataApiKey` 均已暴露。Try-it 直接打外部端点 `/data-api/v1/<name>`。Usage/Audit 若无专用端点,需后端补一个 `/data-apis/{id}/usage`、`/data-apis/{id}/audit`(`// 待确认`)。
- **验收**:点列表行 → 进详情 → 能建/吊销 API Key 并看到一次性明文 → Try-it 真实调用返回数据 → 看到调用审计。

### P0-2. Try-it 调试器(P0-1 的子项,单独强调)
- **缺什么**:一个可复用的「API 调试器」组件 — 根据该 API 的 `allowed_filters` 动态生成参数表单 → 发请求 → 高亮展示 JSON 响应。这是 Data API 体验的关键,证明「无认证也安全」(匿名调也只返回白名单+脱敏数据)。
- **后端就绪**:✅ 外部端点已实现(`dataapi_external.go`)。
- **验收**:对一个 `auth_mode=none` 的 API,不带任何凭证即可在 UI 内调用成功,且返回只含发布字段。

---

## 🟡 P1 — 可视化交互退化 / 高级交互缺失

### P1-1. ModelingStudio 画布缺 FK 连线渲染
- **位置**:`src/pages/ModelingStudio.jsx`(画布 `ms-canvas`)
- **现状**:节点可拖拽定位、关系可在右侧面板「Add relationship」表单添加、生成代码调真后端 `generateModel` 并保留 custom block — 都好。
- **缺什么**:**画布上事实表↔维度表之间的可视化连线**(crow's-foot / 折线)没有渲染。设计意图是「在画布上拉线建 FK」,目前退化成「面板里填表单」。
  - 补一个 SVG overlay 层,按 `relationships` 在对应两节点间画连线;理想再支持从节点拖到另一节点直接建关系。
- **后端就绪**:✅ 关系存 `dwm_relationship`,数据已有,纯前端渲染。
- **验收**:画布上能看到 fact→dim 的连线,拖动节点连线跟随;新增关系即时出现连线。

### P1-2. SchemaChanges 影响分析(破坏性变更)
- **位置**:`src/pages/SchemaChanges.jsx`
- **现状**:有 schema diff 相关交互(取证显示有 Tabs/Detail 类)。
- **缺什么**:确认并补全 **破坏性变更(删列/窄化)→ 查 DataHub lineage 列出下游依赖(Data API / 语义模型 / 仪表板 / 下游表)→ 影响分析面板**;以及破坏性变更**强制审批流**入口。若已部分实现,补齐影响列表的真实 lineage 拉取。
- **后端就绪**:🟡 lineage 用 `getCatalogLineage`;schema 变更执行端点需确认是否存在(`// 待确认 CatalogAdapter 的 AddColumn/DropColumn 是否已接 HTTP`)。
- **验收**:对一个删列变更,UI 列出该列的下游使用者,并要求审批后才能执行。

### P1-3. DataPatch 详情/预览深度
- **位置**:`src/pages/DataPatch.jsx`(取证:Tabs/Detail/drill = 0)
- **现状**:页面存在、调 api,但**无详情/无影响行数预览/无回滚 UI**。
- **缺什么**:
  - 构造 UPDATE/DELETE 条件后 **「预览受影响行数」**(先 SELECT count 再执行)
  - 修正理由 + **审批流**入口
  - 执行后保留**修正前快照** + **回滚按钮**(回到 pre-patch Iceberg snapshot)
  - 醒目红色高风险警示 + 二次确认
- **后端就绪**:🟡 需确认 `tableops` 是否暴露 patch/preview-count/rollback(`// 待确认`)。
- **验收**:构造一个 DELETE → 看到「将影响 N 行」→ 审批 → 执行 → 出现可回滚的快照记录。

### P1-4. TableMaintenance watermark 重置 + 异步任务态
- **位置**:`src/pages/TableMaintenance.jsx`
- **现状**:有维护操作交互(取证 7)。
- **缺什么**:确认补全 — 各维护操作(compaction/expire/orphan/rewrite)的**异步任务态**(运行中/完成/失败 + 结果:释放空间/合并文件数);**watermark 管理**(查看 fact per-partition / gold range 当前值 + 重置,危险二次确认)。
- **后端就绪**:🟡 `tableops.go`(552 行)大概率已覆盖,确认 watermark 端点。
- **验收**:点 compaction → 看到运行中 → 完成后显示释放空间;能查看并(二次确认后)重置水位线。

---

## 🟢 P2 — 详情页深度 / 一致性打磨

### P2-1. Pipeline 详情 run drill-down
- **位置**:`src/pages/DevConfig.jsx`(Pipelines)
- **现状**:列表 + DAG view + run/pause/backfill 都有(取证 17,很丰富)。
- **缺什么**:确认 **run history → 单次 run 的 task 级 timeline/Gantt + per-task 日志**钻取深度;若只有 run 列表无 task drill,补之。
- **后端就绪**:✅ `getPipelineDag` / ops runs / retry 已有。
- **验收**:点一次 run → 看到该 run 的任务级时间线 + 日志。

### P2-2. Analytics dashboard editor 高级 shelf
- **位置**:`src/pages/Analytics.jsx`(editor)
- **现状**:widget 拖放、真实查询、12 图表、save/preview/share/subscribe 都有(质量很高)。
- **缺什么**(锦上添花):**计算字段编辑器**、**跨 widget 联动筛选 / 下钻**、维度度量 shelf 的更完整拖拽。若设计要求,补计算字段 + 全局筛选联动。
- **后端就绪**:✅ `/api/query/build` 支持结构化 spec。
- **验收**:能定义一个计算字段并用于图表;全局日期筛选联动多 widget。

### P2-3. 全局一致性项
- **空状态/骨架屏**:确认所有列表页在加载/空数据时都有 skeleton + empty state(部分页可能缺)。
- **脏数据守卫**:编辑器(dashboard / modeling / schema change)离开未保存时确认弹窗,逐页确认。
- **通知深链**:通知面板项点击 → deep-link 到来源页(确认已接)。
- **`mockData.js` 残留**:技术债 #6 提到死种子数组,确认仅用于 UI 列定义/tab 配置,无数据来源混用。

---

## 实施建议(给 Claude Code 的顺序)
1. **P0-1 + P0-2**:DataServices 详情页 + API Key 管理 + Try-it。纯前端,后端就绪,体验提升最大。
2. **P1-1**:ModelingStudio 画布 FK 连线(SVG overlay)。
3. **P1-2 / P1-3 / P1-4**:Schema 影响分析、DataPatch 预览+回滚、TableMaintenance watermark — 这三项需先确认对应后端端点是否就绪(见各项 `// 待确认`),缺则前后端一起补。
4. **P2**:详情 drill-down、计算字段、一致性打磨。

## 给 Claude Code 的约束
- 复用现有 Carbon 组件与 `src/components/shared.jsx`、`modals.jsx`、`inputs.jsx` 的既有模式,风格保持一致(方角、Plex、`PageHeader`/`CarbonTable`/`RowMenu`/`FormModal`/`ConfirmDelete`)。
- 所有取数走 `src/data/api.js` 既有封装;缺端点先在 api.js 加 thin wrapper。
- 维持「无 mock 数据源」原则:数据来自后端,`mockData.js` 仅用于列定义/tab 静态配置。
- 高风险操作(破坏性 schema 变更、data patch、watermark 重置)统一红色警示 + 二次确认 + 审批入口。
- i18n:沿用 `tr(lang, ...)` / `trList`。
