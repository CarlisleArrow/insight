/* ============================================================
   api — thin client for the IPAS control-plane BFF.

   All calls go through the Vite dev proxy (/api -> :8088), so the
   SPA and backend are same-origin. In dev the backend runs with
   CP_DEV_AUTH_BYPASS=true, so no token is required; when real
   Keycloak auth is enabled, set the bearer token via setToken().
   ============================================================ */

const BASE = '/api';

let authToken = null;
export function setToken(t) { authToken = t; }

async function req(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(BASE + path, { ...opts, headers });
  if (!res.ok) {
    let detail = '';
    let details = null;
    try {
      const body = await res.json();
      detail = body.error || '';
      // Validation endpoints (§16 generate/§17) return a `details` string array —
      // surface it so the caller can show the actual problems, not just "failed".
      if (Array.isArray(body.details) && body.details.length) {
        details = body.details;
        detail = `${detail ? `${detail}: ` : ''}${body.details.join('; ')}`;
      }
    } catch { /* ignore */ }
    const err = new Error(`${opts.method || 'GET'} ${path} → ${res.status}${detail ? ` (${detail})` : ''}`);
    err.status = res.status;
    err.detail = detail;
    err.details = details;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/* Generic REST resource: list/create/update/remove against a collection path.
   Used by DataProvider to back a front-end collection with a BFF endpoint. */
export function resource(path) {
  return {
    list: () => req(path),
    create: (body) => req(path, { method: 'POST', body: JSON.stringify(body) }),
    update: (id, body) => req(`${path}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    remove: (id) => req(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

/* ---------- Self-service analytics ---------- */
export const getDatasets = () => req('/datasets');
export const getDatasetSchema = (ns, table) =>
  req(`/datasets/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/schema`);
export const runQuery = (sql, target) =>
  req('/query', { method: 'POST', body: JSON.stringify({ sql, target }) });
export const buildQuery = (spec) =>
  req('/query/build', { method: 'POST', body: JSON.stringify(spec) });

/* ---------- Data dev — pipelines ---------- */
export const getPipelines = () => req('/pipelines');
// createPipeline runs the "build pipeline" saga (§11): Debezium connector +
// Iceberg table (parallel) → Airflow DAG → DataHub status, with rollback.
export const createPipeline = (spec) => req('/pipelines', { method: 'POST', body: JSON.stringify(spec) });
export const getPipeline = (id) => req(`/pipelines/${encodeURIComponent(id)}`);
export const getPipelineDag = () => req('/pipelines/dag');
export const runPipeline = (id) => req(`/pipelines/${encodeURIComponent(id)}/run`, { method: 'POST' });
export const pausePipeline = (id) => req(`/pipelines/${encodeURIComponent(id)}/pause`, { method: 'POST' });
export const backfillPipeline = (id, from, to) =>
  req(`/pipelines/${encodeURIComponent(id)}/backfill`, { method: 'POST', body: JSON.stringify({ from, to }) });

/* ---------- Data sources (platform_metadata.datasource) ---------- */
export const datasources = resource('/datasources');
// testDatasource opens a REAL credentialed connection (Ping/SELECT 1) via the
// BFF. Pass {type,host,port,database,username,password}; nothing is stored.
export const testDatasource = (spec) => req('/datasources/test', { method: 'POST', body: JSON.stringify(spec) });
// listSourceTables connects to the source and returns its real table list.
export const listSourceTables = (spec) => req('/datasources/tables', { method: 'POST', body: JSON.stringify(spec) });

/* ---------- CDC connectors (Debezium direct) ---------- */
export const createConnector = (spec) => req('/connectors', { method: 'POST', body: JSON.stringify(spec) });
export const updateConnector = (id, spec) => req(`/connectors/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(spec) });
export const deleteConnector = (id) => req(`/connectors/${encodeURIComponent(id)}`, { method: 'DELETE' });

/* ---------- Catalog (DataHub proxy) ---------- */
export const getCatalogSearch = (q = '') => req(`/catalog/search?q=${encodeURIComponent(q)}`);
export const getCatalogLineage = (urn = '') => req(`/catalog/lineage?urn=${encodeURIComponent(urn)}`);
export const getCatalogFacets = (q = '') => req(`/catalog/facets?q=${encodeURIComponent(q)}`);
// getAsset fetches schema + live sample + usage + downstream count by urn.
export const getAsset = (urn) => req(`/catalog/asset?urn=${encodeURIComponent(urn)}`);

/* ---------- Governance — policies + access ---------- */
export const listRowPolicies = () => req('/policies/row');
export const createRowPolicy = (p) => req('/policies/row', { method: 'POST', body: JSON.stringify(p) });
export const listColumnPolicies = () => req('/policies/column');
export const createColumnPolicy = (p) => req('/policies/column', { method: 'POST', body: JSON.stringify(p) });
export const previewPolicy = (body) => req('/policies/preview', { method: 'POST', body: JSON.stringify(body) });
export const getAccessUsers = () => req('/access/users');
export const createAccessUser = (u) => req('/access/users', { method: 'POST', body: JSON.stringify(u) });
export const updateAccessUser = (username, u) => req(`/access/users/${encodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(u) });
export const deleteAccessUser = (username) => req(`/access/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
export const accessRoles = resource('/access/roles');
// Per-user role bindings (RBAC). setUserRoles replaces a user's bound roles.
export const getUserRoles = (username) => req(`/access/users/${encodeURIComponent(username)}/roles`);
export const setUserRoles = (username, roles) =>
  req(`/access/users/${encodeURIComponent(username)}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) });

/* ---------- Modeling ---------- */
export const metrics = resource('/metrics');
export const getSemanticModel = () => req('/semantic-model');

/* ---------- Analytics — dashboards + reports ---------- */
export const dashboards = resource('/dashboards');
export const renderDashboard = (id, widget) =>
  req(`/dashboards/${encodeURIComponent(id)}/render${widget ? `?widget=${widget}` : ''}`, { method: 'POST' });
export const reports = resource('/reports');
export const runReport = (id) => req(`/reports/${encodeURIComponent(id)}/run`, { method: 'POST' });
export const getReportRuns = (id) => req(`/reports/${encodeURIComponent(id)}/runs`);

/* ---------- Data quality ---------- */
export const dqRules = resource('/dq/rules');

/* ---------- Monitoring & Ops ---------- */
export const getOpsRuns = (limit) => req(`/ops/runs${limit ? `?limit=${limit}` : ''}`);
export const getOpsLogs = (q = '', limit) => req(`/ops/logs?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`);
export const getOpsMetrics = (promql) => req(`/ops/metrics?q=${encodeURIComponent(promql)}`);
export const getOpsMetricsRange = (promql, minutes = 30, step = 120) =>
  req(`/ops/metrics/range?q=${encodeURIComponent(promql)}&minutes=${minutes}&step=${step}`);
export const getOpsErrors = (limit) => req(`/ops/errors${limit ? `?limit=${limit}` : ''}`);
export const getOpsSla = () => req('/ops/sla');
export const retryRun = (id) => req(`/ops/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' });

/* ---------- Home overview ---------- */
export const getOverview = () => req('/overview');

/* ---------- Platform admin ---------- */
export const getAdminUsers = () => req('/admin/users');
export const createAdminUser = (u) => req('/admin/users', { method: 'POST', body: JSON.stringify(u) });
export const updateAdminUser = (username, u) => req(`/admin/users/${encodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(u) });
export const deleteAdminUser = (username) => req(`/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
export const adminOrgs = resource('/admin/orgs');
export const adminConfig = resource('/admin/config');
export const adminTenancy = resource('/admin/tenancy');
export const adminApiKeys = resource('/admin/apikeys');
export const getAdminAudit = () => req('/admin/audit');

/* ---------- Data Services (§15 Data-as-a-Service) ---------- */
export const dataApis = resource('/data-apis');
export const getDataApi = (id) => req(`/data-apis/${encodeURIComponent(id)}`);
export const publishDataApi = (id) => req(`/data-apis/${encodeURIComponent(id)}/publish`, { method: 'POST' });
export const deprecateDataApi = (id) => req(`/data-apis/${encodeURIComponent(id)}/deprecate`, { method: 'POST' });
export const listDataApiKeys = (id) => req(`/data-apis/${encodeURIComponent(id)}/keys`);
export const createDataApiKey = (id, body) => req(`/data-apis/${encodeURIComponent(id)}/keys`, { method: 'POST', body: JSON.stringify(body) });
export const deleteDataApiKey = (id, keyId) => req(`/data-apis/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });

/* ---------- Modeling-as-Code (§16) ---------- */
export const models = resource('/models');
export const getModel = (id) => req(`/models/${encodeURIComponent(id)}`);
export const replaceModelTables = (id, body) => req(`/models/${encodeURIComponent(id)}/tables`, { method: 'PUT', body: JSON.stringify(body) });
export const generateModel = (id) => req(`/models/${encodeURIComponent(id)}/generate`, { method: 'POST' });
export const deployModel = (id) => req(`/models/${encodeURIComponent(id)}/deploy`, { method: 'POST' });

/* ---------- Table operations (§17 schema / maintenance / patch) ---------- */
export const schemaDiff = (ns, table, body) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/schema/diff`, { method: 'POST', body: JSON.stringify(body) });
export const schemaAlter = (ns, table, body) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/schema/alter`, { method: 'POST', body: JSON.stringify(body) });
export const tableHealth = (ns, table) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/health`);
export const runMaintenance = (ns, table, op) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/maintenance/${encodeURIComponent(op)}`, { method: 'POST' });
export const getMaintenanceJobs = (ns, table) => req(`/maintenance/jobs${ns && table ? `?ns=${encodeURIComponent(ns)}&table=${encodeURIComponent(table)}` : ''}`);
export const getWatermarks = (ns, table) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/watermarks`);
export const resetWatermark = (ns, table, body) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/watermarks/reset`, { method: 'POST', body: JSON.stringify(body) });
export const patchPreview = (ns, table, body) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/patch/preview`, { method: 'POST', body: JSON.stringify(body) });
export const patchApply = (ns, table, body) => req(`/tables/${encodeURIComponent(ns)}/${encodeURIComponent(table)}/patch/apply`, { method: 'POST', body: JSON.stringify(body) });

/* ---------- Approval queue (shared by §15 publish / §17 schema & patch) ---------- */
export const getApprovals = (status) => req(`/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`);
export const getApproval = (id) => req(`/approvals/${encodeURIComponent(id)}`);
export const approveRequest = (id) => req(`/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
export const rejectRequest = (id) => req(`/approvals/${encodeURIComponent(id)}/reject`, { method: 'POST' });

/* ---------- Notifications ---------- */
export const getNotifications = () => req('/notifications');
export const markNotificationRead = (id) => req(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
export const markAllNotificationsRead = () => req('/notifications/read-all', { method: 'POST' });
export const deleteNotification = (id) => req(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });

/* ---------- Personal center (me) ---------- */
export const getMe = () => req('/me');
export const getMyPermissions = () => req('/me/permissions');
export const getMySessions = () => req('/me/sessions');
export const deleteMySession = (id) => req(`/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const myApiKeys = resource('/me/apikeys');
