/* ============================================================
   mockData — single source of truth for all sample data.

   This is the seam for the control plane: every page reads its
   data from here. To wire real APIs, replace these exports with
   fetched data (e.g. a `useData()` hook backed by the control
   plane) without touching any page component.
   ============================================================ */

/* ---------- Navigation ---------- */
export const IPAS_NAV = [
  { id: 'overview', label: 'Home / Overview', icon: 'home' },
  { id: 'analytics', label: 'Self-Service Analytics', icon: 'dashboard' },
  { id: 'dataservices', label: 'Data Services', icon: 'apps' },
  { id: 'modeling', label: 'Data Modeling & Semantics', icon: 'data--base' },
  { id: 'devconfig', label: 'Data Development / Config', icon: 'code' },
  { id: 'governance', label: 'Data Assets & Governance', icon: 'folder' },
  { id: 'monitoring', label: 'Monitoring & Ops', icon: 'chart--line' },
  { id: 'ai', label: 'AI', icon: 'watson' },
  { id: 'federation', label: 'Federation', icon: 'share' },
  { id: 'admin', label: 'Platform Admin', icon: 'settings' },
];

export const CURRENT_USER = { name: 'Lena Marsh', initials: 'LM', role: 'Data Engineer', firstName: 'Lena', email: 'lmarsh@ipas' };

/* ---------- Welcome ---------- */
export const WELCOME_ACTIONS = [
  { icon: 'dashboard', title: 'Build a dashboard', desc: 'Compose charts on a drag-and-drop canvas.', to: 'analytics' },
  { icon: 'data--base', title: 'Define a metric', desc: 'Add a governed metric to the metrics store.', to: 'modeling' },
  { icon: 'folder', title: 'Browse the catalog', desc: 'Search every table and field across layers.', to: 'governance' },
  { icon: 'chart--line', title: 'Check operations', desc: 'Monitor pipeline runs and data SLAs.', to: 'monitoring' },
];

/* ---------- Analytics ---------- */
export const DASHBOARDS = [
  { id: 1, name: 'Production Yield Overview', owner: 'L. Marsh', mod: '2 hours ago', tags: ['Manufacturing', 'Gold'] },
  { id: 2, name: 'Daily Revenue & Margin', owner: 'A. Okafor', mod: 'Yesterday', tags: ['Finance'] },
  { id: 3, name: 'Supply Chain Latency', owner: 'R. Vance', mod: '3 days ago', tags: ['Logistics', 'SLA'] },
  { id: 4, name: 'SPC Control — Line 4', owner: 'L. Marsh', mod: '5 days ago', tags: ['Quality', 'SPC'] },
  { id: 5, name: 'Customer Cohort Retention', owner: 'J. Singh', mod: 'Apr 18', tags: ['Growth'] },
  { id: 6, name: 'Warehouse Throughput', owner: 'R. Vance', mod: 'Apr 16', tags: ['Logistics'] },
  { id: 7, name: 'Energy Consumption', owner: 'M. Díaz', mod: 'Apr 12', tags: ['Ops', 'IoT'] },
  { id: 8, name: 'Defect Pareto Analysis', owner: 'L. Marsh', mod: 'Apr 9', tags: ['Quality'] },
];

export const CHART_TYPES = [
  { label: 'Bar', icon: 'chart--bar' }, { label: 'Grouped bar', icon: 'chart--bar' }, { label: 'Stacked bar', icon: 'chart--bar' },
  { label: 'Line', icon: 'chart--line' }, { label: 'Area', icon: 'chart--line' }, { label: 'Scatter', icon: 'interactions' },
  { label: 'Pie', icon: 'dashboard' }, { label: 'Donut', icon: 'dashboard' }, { label: 'Word cloud', icon: 'chat' },
  { label: 'Gauge', icon: 'meter' }, { label: 'Heatmap', icon: 'grid' }, { label: 'Table', icon: 'list' },
];

export const REPORTS = [
  { id: 1, name: 'Weekly Yield Digest', schedule: '0 7 * * 1', recipients: 'ops-leads@ipas', format: 'PDF', channel: 'Email', status: 'Active' },
  { id: 2, name: 'Daily Revenue Snapshot', schedule: '0 6 * * *', recipients: 'finance@ipas', format: 'Excel', channel: 'Email', status: 'Active' },
  { id: 3, name: 'SLA Breach Alert Roll-up', schedule: '0 */4 * * *', recipients: '#data-sla', format: 'PDF', channel: 'IM', status: 'Active' },
  { id: 4, name: 'Monthly Exec Board Pack', schedule: '0 8 1 * *', recipients: 'exec@ipas', format: 'PDF', channel: 'Email', status: 'Paused' },
  { id: 5, name: 'Quality NCR Summary', schedule: '0 18 * * 5', recipients: 'quality@ipas', format: 'Excel', channel: 'Email', status: 'Draft' },
];

// Editor sample chart data
export const EDITOR_YIELD_BY_LINE = [
  { group: 'Line', key: 'LINE-01', value: 62 },
  { group: 'Line', key: 'LINE-02', value: 78 },
  { group: 'Line', key: 'LINE-03', value: 71 },
  { group: 'Line', key: 'LINE-04', value: 88 },
  { group: 'Line', key: 'LINE-05', value: 80 },
  { group: 'Line', key: 'LINE-06', value: 74 },
];

export const EDITOR_DEFECT_TREND = [
  { group: 'Defects', key: 'W1', value: 142 }, { group: 'Defects', key: 'W2', value: 118 },
  { group: 'Defects', key: 'W3', value: 165 }, { group: 'Defects', key: 'W4', value: 97 },
  { group: 'Defects', key: 'W5', value: 110 }, { group: 'Defects', key: 'W6', value: 84 },
];
export const EDITOR_SPC = [
  { group: 'Cycle time', key: 'S1', value: 62 }, { group: 'Cycle time', key: 'S2', value: 68 },
  { group: 'Cycle time', key: 'S3', value: 64 }, { group: 'Cycle time', key: 'S4', value: 72 },
  { group: 'Cycle time', key: 'S5', value: 66 }, { group: 'Cycle time', key: 'S6', value: 70 },
  { group: 'Cycle time', key: 'S7', value: 63 }, { group: 'Cycle time', key: 'S8', value: 69 },
];
export const ASSET_USAGE = [
  { group: 'Queries', key: 'Mon', value: 180 }, { group: 'Queries', key: 'Tue', value: 220 },
  { group: 'Queries', key: 'Wed', value: 260 }, { group: 'Queries', key: 'Thu', value: 240 },
  { group: 'Queries', key: 'Fri', value: 300 }, { group: 'Queries', key: 'Sat', value: 120 },
  { group: 'Queries', key: 'Sun', value: 90 },
];
export const SQL_DEFAULT = `-- Daily yield by production line
SELECT  line_id,
        avg(yield_pct) AS avg_yield,
        sum(units_produced) AS units
FROM    gold.fact_production
WHERE   event_date >= '2026-04-01'
GROUP BY line_id
ORDER BY avg_yield DESC;`;

export const QUERY_RESULTS = {
  columns: [
    { key: 'line_id', header: 'line_id' },
    { key: 'avg_yield', header: 'avg_yield' },
    { key: 'units', header: 'units' },
  ],
  rows: [
    { id: '1', line_id: 'LINE-04', avg_yield: '88.2', units: '142,800' },
    { id: '2', line_id: 'LINE-02', avg_yield: '80.4', units: '131,250' },
    { id: '3', line_id: 'LINE-05', avg_yield: '78.9', units: '128,910' },
    { id: '4', line_id: 'LINE-01', avg_yield: '74.1', units: '120,400' },
  ],
};

/* ---------- Modeling ---------- */
export const METRICS = [
  { id: 1, name: 'First-pass yield', def: 'Units passing QC on first attempt ÷ total units started', formula: '1 - (defects / units_started)', owner: 'L. Marsh', status: 'Certified', unit: '%' },
  { id: 2, name: 'Gross margin', def: 'Revenue minus COGS, as a share of revenue', formula: '(revenue - cogs) / revenue', owner: 'A. Okafor', status: 'Certified', unit: '%' },
  { id: 3, name: 'On-time delivery', def: 'Orders delivered by promised date ÷ total orders', formula: 'on_time_orders / total_orders', owner: 'R. Vance', status: 'Draft', unit: '%' },
  { id: 4, name: 'Mean cycle time', def: 'Average elapsed time per production run', formula: 'avg(end_ts - start_ts)', owner: 'L. Marsh', status: 'Certified', unit: 'min' },
  { id: 5, name: 'Scrap cost', def: 'Total cost of scrapped material per period', formula: 'sum(scrap_qty * unit_cost)', owner: 'M. Díaz', status: 'Review', unit: 'USD' },
  { id: 6, name: 'Net revenue retention', def: 'Recurring revenue retained + expansion ÷ starting', formula: '(start + expansion - churn) / start', owner: 'J. Singh', status: 'Draft', unit: '%' },
];
export const METRICS_TOTAL = 48;

export const SEMANTIC_TABLES = [
  { id: 'dim_product', x: 40, y: 40, title: 'dim_product', rows: [{ name: 'product_key', key: true, pk: true, type: 'PK' }, { name: 'sku', type: 'str' }, { name: 'category', type: 'str' }] },
  { id: 'dim_plant', x: 40, y: 280, title: 'dim_plant', rows: [{ name: 'plant_key', key: true, pk: true, type: 'PK' }, { name: 'region', type: 'str' }] },
  { id: 'fact', x: 340, y: 120, fact: true, title: 'fact_production', rows: [{ name: 'product_key', key: true, type: 'FK' }, { name: 'plant_key', key: true, type: 'FK' }, { name: 'date_key', key: true, type: 'FK' }, { name: 'units_produced', type: 'num' }, { name: 'defect_count', type: 'num' }] },
  { id: 'dim_date', x: 650, y: 40, title: 'dim_date', rows: [{ name: 'date_key', key: true, pk: true, type: 'PK' }, { name: 'week', type: 'int' }, { name: 'quarter', type: 'str' }] },
  { id: 'dim_shift', x: 650, y: 280, title: 'dim_shift', rows: [{ name: 'shift_key', key: true, pk: true, type: 'PK' }, { name: 'shift_name', type: 'str' }] },
];

export const FIELD_MAPPING = [
  { phys: 'units_produced', biz: 'Units produced' },
  { phys: 'defect_count', biz: 'Defects' },
  { phys: 'cycle_time_s', biz: 'Cycle time (sec)' },
];

/* ---------- DevConfig ---------- */
export const SOURCES = [
  { id: 1, name: 'erp-oracle-prod', type: 'Oracle', host: 'erp-db.ipas.internal:1521', status: 'Connected', tested: '2 min ago' },
  { id: 2, name: 'mes-mysql', type: 'MySQL', host: 'mes.ipas.internal:3306', status: 'Connected', tested: '5 min ago' },
  { id: 3, name: 'crm-sqlserver', type: 'SQL Server', host: 'crm-sql.ipas.internal:1433', status: 'Error', tested: '1 hour ago' },
  { id: 4, name: 'lake-iceberg', type: 'Iceberg', host: 's3://ipas-lakehouse/warehouse', status: 'Connected', tested: '12 min ago' },
  { id: 5, name: 'analytics-clickhouse', type: 'ClickHouse', host: 'ch.ipas.internal:8123', status: 'Connected', tested: '1 min ago' },
  { id: 6, name: 'events-kafka', type: 'Kafka', host: 'kafka-0.ipas.internal:9092', status: 'Degraded', tested: '8 min ago' },
];

export const DAG_LAYERS = ['RAW', 'Bronze', 'Silver', 'Gold', 'ClickHouse'];
export const DAG_NODES = [
  { id: 'n1', layer: 0, y: 60, label: 'ingest_erp', status: 'success', sub: 'extract · 2m' },
  { id: 'n2', layer: 0, y: 220, label: 'ingest_mes', status: 'success', sub: 'extract · 1m' },
  { id: 'n3', layer: 1, y: 60, label: 'clean_erp', status: 'success', sub: 'dbt · 3m' },
  { id: 'n4', layer: 1, y: 220, label: 'clean_mes', status: 'running', sub: 'dbt · running' },
  { id: 'n5', layer: 2, y: 140, label: 'conform_dims', status: 'success', sub: 'spark · 4m' },
  { id: 'n6', layer: 3, y: 60, label: 'fact_production', status: 'queued', sub: 'dbt · queued' },
  { id: 'n7', layer: 3, y: 220, label: 'agg_yield', status: 'queued', sub: 'dbt · queued' },
  { id: 'n8', layer: 4, y: 140, label: 'load_ch', status: 'queued', sub: 'sync · queued' },
];
export const DAG_EDGES = [['n1', 'n3'], ['n2', 'n4'], ['n3', 'n5'], ['n4', 'n5'], ['n5', 'n6'], ['n5', 'n7'], ['n6', 'n8'], ['n7', 'n8']];
export const DAG_RECENT_RUNS = ['success', 'success', 'failed', 'success', 'success', 'success', 'running'];

export const CONNECTORS = [
  { id: 1, name: 'erp-cdc', src: 'erp-oracle-prod', topic: 'cdc.erp.', status: 'Running', lag: '120 ms', lagKind: 'green' },
  { id: 2, name: 'mes-cdc', src: 'mes-mysql', topic: 'cdc.mes.', status: 'Running', lag: '1.4 s', lagKind: 'amber' },
  { id: 3, name: 'crm-cdc', src: 'crm-sqlserver', topic: 'cdc.crm.', status: 'Failed', lag: '— ', lagKind: 'red' },
  { id: 4, name: 'inventory-cdc', src: 'erp-oracle-prod', topic: 'cdc.inv.', status: 'Running', lag: '85 ms', lagKind: 'green' },
];
export const CDC_TABLES = ['ORDERS', 'ORDER_LINES', 'CUSTOMERS', 'SHIPMENTS'];

export const DQ_RULES = [
  { id: 1, target: 'gold.fact_production.yield_pct', type: 'Range (0–1)', sev: 'High', result: 'Pass', n: '0 failed' },
  { id: 2, target: 'silver.orders.order_id', type: 'Uniqueness', sev: 'High', result: 'Pass', n: '0 failed' },
  { id: 3, target: 'silver.orders.customer_id', type: 'Not null', sev: 'High', result: 'Fail', n: '142 failed' },
  { id: 4, target: 'gold.dim_product.sku', type: 'Not null', sev: 'Medium', result: 'Pass', n: '0 failed' },
  { id: 5, target: 'silver.shipments.delivered_at', type: 'Custom assertion', sev: 'Low', result: 'Warn', n: '8 stale' },
];

/* ---------- Governance ---------- */
export const ASSETS = [
  { id: 1, name: 'fact_production', layer: 'Gold', desc: 'Production events by line, shift, and product', owner: 'L. Marsh', score: 96, sens: 'Internal' },
  { id: 2, name: 'orders', layer: 'Silver', desc: 'Cleaned customer orders from ERP', owner: 'A. Okafor', score: 88, sens: 'Confidential' },
  { id: 3, name: 'customers', layer: 'Silver', desc: 'Customer master with contact details', owner: 'A. Okafor', score: 74, sens: 'PII' },
  { id: 4, name: 'raw_mes_events', layer: 'RAW', desc: 'Unprocessed MES machine telemetry', owner: 'M. Díaz', score: 61, sens: 'Internal' },
  { id: 5, name: 'dim_product', layer: 'Gold', desc: 'Conformed product dimension', owner: 'L. Marsh', score: 93, sens: 'Public' },
  { id: 6, name: 'agg_yield_daily', layer: 'Gold', desc: 'Daily yield aggregates for dashboards', owner: 'R. Vance', score: 90, sens: 'Internal' },
];
export const ASSETS_TOTAL = 186;

export const CATALOG_FACETS = [
  { title: 'Domain', opts: [{ l: 'Manufacturing', n: 42, on: true }, { l: 'Finance', n: 18 }, { l: 'Logistics', n: 23 }, { l: 'Customer', n: 11 }] },
  { title: 'Source layer', opts: [{ l: 'RAW', n: 64 }, { l: 'Bronze', n: 52 }, { l: 'Silver', n: 38, on: true }, { l: 'Gold', n: 26, on: true }] },
  { title: 'Sensitivity', opts: [{ l: 'Public', n: 12 }, { l: 'Internal', n: 88 }, { l: 'Confidential', n: 21 }, { l: 'PII', n: 9 }] },
  { title: 'Owner', opts: [{ l: 'L. Marsh', n: 14 }, { l: 'A. Okafor', n: 9 }, { l: 'R. Vance', n: 7 }] },
];

export const ASSET_SCHEMA = [
  { col: 'line_id', type: 'varchar', desc: 'Production line identifier', sens: 'Internal' },
  { col: 'shift', type: 'varchar', desc: 'Shift name (Day/Night)', sens: 'Internal' },
  { col: 'units_produced', type: 'bigint', desc: 'Units produced in window', sens: 'Internal' },
  { col: 'defect_count', type: 'bigint', desc: 'Defective units', sens: 'Internal' },
  { col: 'yield_pct', type: 'double', desc: 'First-pass yield', sens: 'Internal' },
];
export const ASSET_SAMPLE = [
  { line_id: 'LINE-04', shift: 'Day', units_produced: '12,480', defect_count: '142' },
  { line_id: 'LINE-02', shift: 'Night', units_produced: '9,310', defect_count: '88' },
  { line_id: 'LINE-05', shift: 'Day', units_produced: '11,002', defect_count: '203' },
];

export const LIN_LAYERS = ['RAW', 'Bronze', 'Silver', 'Gold', 'ClickHouse'];
export const LIN_NODES = [
  { id: 'l1', layer: 0, y: 120, label: 'raw_mes_events', fields: ['event_ts', 'machine_id', 'payload'] },
  { id: 'l2', layer: 1, y: 120, label: 'mes_clean', fields: ['ts', 'line_id', 'metric'] },
  { id: 'l3', layer: 2, y: 60, label: 'orders', fields: ['order_id', 'customer_id'] },
  { id: 'l4', layer: 2, y: 240, label: 'production', fields: ['line_id', 'units', 'defects'] },
  { id: 'l5', layer: 3, y: 150, label: 'fact_production', fields: ['line_id', 'yield_pct', 'units_produced'] },
  { id: 'l6', layer: 4, y: 150, label: 'ch.agg_yield', fields: ['line_id', 'avg_yield'] },
];
export const LIN_EDGES = [['l1', 'l2'], ['l2', 'l4'], ['l3', 'l5'], ['l4', 'l5'], ['l5', 'l6']];

export const ACCESS_USERS = [
  { name: 'Lena Marsh', email: 'lmarsh@ipas', role: 'Data Engineer', status: 'Active' },
  { name: 'Ade Okafor', email: 'aokafor@ipas', role: 'Analyst', status: 'Active' },
  { name: 'Ravi Vance', email: 'rvance@ipas', role: 'Steward', status: 'Active' },
  { name: 'Mara Díaz', email: 'mdiaz@ipas', role: 'Viewer', status: 'Invited' },
];
export const ACCESS_ROLES = [
  { role: 'Data Engineer', members: '12', scope: 'All layers · write Bronze→Gold', model: 'RBAC' },
  { role: 'Analyst', members: '34', scope: 'Read Gold · query', model: 'RBAC' },
  { role: 'Steward', members: '6', scope: 'Catalog · policies', model: 'ABAC' },
  { role: 'Viewer', members: '88', scope: 'Read dashboards', model: 'RBAC' },
];
export const ACCESS_MASKING = [
  { field: 'customers.email', rule: 'Partial mask' },
  { field: 'customers.ssn', rule: 'Full mask' },
  { field: 'orders.amount', rule: 'Visible' },
];

/* ---------- Monitoring ---------- */
export const RUNS = [
  { id: 1, dag: 'erp_to_gold', task: 'fact_production', start: '14:32', dur: '4m 12s', status: 'Success' },
  { id: 2, dag: 'mes_stream', task: 'clean_mes', start: '14:30', dur: 'running', status: 'Running' },
  { id: 3, dag: 'crm_sync', task: 'load_customers', start: '14:18', dur: '1m 02s', status: 'Failed' },
  { id: 4, dag: 'erp_to_gold', task: 'agg_yield', start: '14:10', dur: '2m 48s', status: 'Retrying' },
  { id: 5, dag: 'finance_daily', task: 'gross_margin', start: '13:55', dur: '3m 30s', status: 'Success' },
  { id: 6, dag: 'logistics_etl', task: 'on_time_delivery', start: '13:40', dur: '5m 01s', status: 'Success' },
];
export const RUNS_TOTAL = 421;
export const RUN_STATS = [
  { key: 'Running', value: 3, tone: 'run', icon: 'renew' },
  { key: 'Success (24h)', value: 412, tone: 'ok', icon: 'checkmark--filled' },
  { key: 'Failed (24h)', value: 7, tone: 'fail', icon: 'error--filled' },
  { key: 'Retrying', value: 2, tone: 'retry', icon: 'warning--filled' },
];

export const CLUSTER_CPU = [
  { group: 'CPU', key: 't-8', value: 55 }, { group: 'CPU', key: 't-7', value: 62 }, { group: 'CPU', key: 't-6', value: 48 },
  { group: 'CPU', key: 't-5', value: 70 }, { group: 'CPU', key: 't-4', value: 65 }, { group: 'CPU', key: 't-3', value: 72 },
  { group: 'CPU', key: 't-2', value: 60 }, { group: 'CPU', key: 't-1', value: 58 }, { group: 'CPU', key: 't-0', value: 66 },
];
export const INGEST_THROUGHPUT = [
  { group: 'Events', key: 'Mon', value: 40 }, { group: 'Events', key: 'Tue', value: 55 }, { group: 'Events', key: 'Wed', value: 60 },
  { group: 'Events', key: 'Thu', value: 72 }, { group: 'Events', key: 'Fri', value: 68 }, { group: 'Events', key: 'Sat', value: 80 },
  { group: 'Events', key: 'Sun', value: 76 },
];
export const CH_LATENCY = [
  { group: 'p95 (ms)', key: '09:00', value: 280 }, { group: 'p95 (ms)', key: '10:00', value: 305 },
  { group: 'p95 (ms)', key: '11:00', value: 290 }, { group: 'p95 (ms)', key: '12:00', value: 340 },
  { group: 'p95 (ms)', key: '13:00', value: 312 }, { group: 'p95 (ms)', key: '14:00', value: 360 },
];
export const SPARK_EXEC = [
  { group: 'Cores', key: '09:00', value: 32 }, { group: 'Cores', key: '10:00', value: 40 },
  { group: 'Cores', key: '11:00', value: 44 }, { group: 'Cores', key: '12:00', value: 48 },
  { group: 'Cores', key: '13:00', value: 46 }, { group: 'Cores', key: '14:00', value: 48 },
];

export const SLA = [
  { pipe: 'erp_to_gold', fresh: 'g', freshT: '14m ago', time: 'g', timeT: 'on time', lat: 'g', latT: '4m avg' },
  { pipe: 'mes_stream', fresh: 'a', freshT: '32m ago', time: 'a', timeT: '+8m', lat: 'g', latT: '1.4s' },
  { pipe: 'crm_sync', fresh: 'r', freshT: '3h ago', time: 'r', timeT: 'breached', lat: 'r', latT: 'failed' },
  { pipe: 'finance_daily', fresh: 'g', freshT: '6h ago', time: 'g', timeT: 'on time', lat: 'g', latT: '3m avg' },
  { pipe: 'logistics_etl', fresh: 'g', freshT: '20m ago', time: 'g', timeT: 'on time', lat: 'a', latT: '6m avg' },
];

/* ---------- Admin ---------- */
export const ADMIN_TABS = [
  { id: 'users', label: 'Users & roles' },
  { id: 'orgs', label: 'Organizations' },
  { id: 'config', label: 'System config' },
  { id: 'audit', label: 'Audit log' },
  { id: 'api', label: 'API gateway' },
  { id: 'tenancy', label: 'Multi-tenancy' },
];

export const ADMIN_DATA = {
  users: {
    create: 'Add user',
    cols: [
      { key: 'name', header: 'Name' }, { key: 'email', header: 'Email', mono: true },
      { key: 'role', header: 'Role' }, { key: 'org', header: 'Organization' }, { key: 'status', header: 'Status' },
    ],
    rows: [
      { name: 'Lena Marsh', email: 'lmarsh@ipas', role: 'Admin', org: 'Manufacturing', status: 'Active' },
      { name: 'Ade Okafor', email: 'aokafor@ipas', role: 'Editor', org: 'Finance', status: 'Active' },
      { name: 'Ravi Vance', email: 'rvance@ipas', role: 'Steward', org: 'Logistics', status: 'Active' },
      { name: 'Mara Díaz', email: 'mdiaz@ipas', role: 'Viewer', org: 'Operations', status: 'Suspended' },
      { name: 'Jon Singh', email: 'jsingh@ipas', role: 'Editor', org: 'Growth', status: 'Invited' },
    ],
  },
  orgs: {
    create: 'Create organization',
    cols: [
      { key: 'org', header: 'Organization' }, { key: 'members', header: 'Members' }, { key: 'projects', header: 'Projects' }, { key: 'owner', header: 'Owner' },
    ],
    rows: [
      { org: 'Manufacturing', members: '48', projects: '12', owner: 'L. Marsh' },
      { org: 'Finance', members: '22', projects: '7', owner: 'A. Okafor' },
      { org: 'Logistics', members: '31', projects: '9', owner: 'R. Vance' },
      { org: 'Operations', members: '18', projects: '5', owner: 'M. Díaz' },
    ],
  },
  config: {
    create: 'New setting',
    cols: [
      { key: 'key', header: 'Setting', mono: true }, { key: 'val', header: 'Value', mono: true }, { key: 'scope', header: 'Scope' }, { key: 'by', header: 'Updated by' },
    ],
    rows: [
      { key: 'query.engine.default', val: 'auto', scope: 'Global', by: 'system' },
      { key: 'retention.bronze.days', val: '90', scope: 'Global', by: 'L. Marsh' },
      { key: 'sla.freshness.minutes', val: '30', scope: 'Manufacturing', by: 'L. Marsh' },
      { key: 'auth.session.ttl', val: '8h', scope: 'Global', by: 'system' },
      { key: 'masking.pii.default', val: 'full', scope: 'Global', by: 'R. Vance' },
    ],
  },
  audit: {
    create: null,
    total: 4821,
    cols: [
      { key: 'time', header: 'Timestamp', mono: true }, { key: 'actor', header: 'Actor' }, { key: 'action', header: 'Action' }, { key: 'target', header: 'Target', mono: true }, { key: 'res', header: 'Result' },
    ],
    rows: [
      { time: '14:32:08', actor: 'L. Marsh', action: 'grant.role', target: 'analyst → aokafor', res: 'OK' },
      { time: '14:21:55', actor: 'system', action: 'pipeline.run', target: 'erp_to_gold', res: 'OK' },
      { time: '14:02:31', actor: 'R. Vance', action: 'policy.update', target: 'orders.row_filter', res: 'OK' },
      { time: '13:48:12', actor: 'aokafor', action: 'query.export', target: 'gold.fact_production', res: 'Denied' },
      { time: '13:30:00', actor: 'system', action: 'cdc.restart', target: 'crm-cdc', res: 'OK' },
    ],
  },
  api: {
    create: 'Create API key',
    cols: [
      { key: 'name', header: 'Key name' }, { key: 'prefix', header: 'Key', mono: true }, { key: 'scope', header: 'Scopes' }, { key: 'rate', header: 'Rate limit' }, { key: 'status', header: 'Status' },
    ],
    rows: [
      { name: 'bi-readonly', prefix: 'ipas_sk_a91f…', scope: 'read:gold', rate: '600/min', status: 'Active' },
      { name: 'airflow-orchestrator', prefix: 'ipas_sk_77c2…', scope: 'write:pipelines', rate: '1200/min', status: 'Active' },
      { name: 'legacy-export', prefix: 'ipas_sk_0b34…', scope: 'read:silver', rate: '120/min', status: 'Revoked' },
    ],
  },
  tenancy: {
    create: 'Add tenant',
    cols: [
      { key: 'tenant', header: 'Tenant' }, { key: 'plan', header: 'Plan' }, { key: 'isolation', header: 'Isolation' }, { key: 'storage', header: 'Storage' }, { key: 'status', header: 'Status' },
    ],
    rows: [
      { tenant: 'acme-mfg', plan: 'Enterprise', isolation: 'Dedicated schema', storage: '4.2 TB', status: 'Active' },
      { tenant: 'globex-fin', plan: 'Enterprise', isolation: 'Dedicated schema', storage: '1.8 TB', status: 'Active' },
      { tenant: 'initech-logistics', plan: 'Standard', isolation: 'Shared (RLS)', storage: '640 GB', status: 'Active' },
      { tenant: 'umbrella-trial', plan: 'Trial', isolation: 'Shared (RLS)', storage: '12 GB', status: 'Provisioning' },
    ],
  },
};

/* ---------- Overview (Home) ---------- */
export const OV_KPIS = [
  { key: 'Healthy pipelines', icon: 'checkmark--filled', value: '38', tone: 'ok', delta: '2 since yesterday', up: true },
  { key: 'Failed (24h)', icon: 'error--filled', value: '7', tone: 'fail', delta: '3 awaiting retry' },
  { key: 'Catalog assets', icon: 'data--base', value: '186', tone: '', delta: '12 certified this week' },
  { key: 'Open alerts', icon: 'warning--filled', value: '4', tone: 'warn', delta: '1 SLA breach' },
];
export const OV_QUICK = [
  { icon: 'flow', title: 'New pipeline', sub: 'Ingest a source to a layer', to: 'devconfig' },
  { icon: 'dashboard', title: 'New dashboard', sub: 'Build on the canvas', to: 'analytics' },
  { icon: 'terminal', title: 'Run a query', sub: 'Visual builder or SQL', to: 'analytics' },
];
export const OV_RUNS = [
  { id: 1, pipe: 'erp_to_gold', status: 'Success', dur: '11m 04s', when: '14:32' },
  { id: 2, pipe: 'mes_stream', status: 'Running', dur: '—', when: '14:30' },
  { id: 3, pipe: 'crm_sync', status: 'Failed', dur: '1m 02s', when: '14:18' },
  { id: 4, pipe: 'finance_daily', status: 'Success', dur: '3m 30s', when: '13:55' },
  { id: 5, pipe: 'logistics_etl', status: 'Success', dur: '5m 01s', when: '13:40' },
];
export const OV_REQUESTS = [
  { id: 'r1', who: 'Ade Okafor', role: 'Analyst', target: 'gold.fact_production', when: 'requested 2 min ago' },
  { id: 'r2', who: 'Mara Díaz', role: 'dataset access', target: 'silver.shipments', when: 'requested 1 hour ago' },
];
export const OV_FAVS = [
  { name: 'Production Yield Overview', mt: 'Edited 2 hours ago' },
  { name: 'SPC Control — Line 4', mt: 'Viewed yesterday' },
  { name: 'Daily Revenue & Margin', mt: 'Viewed 3 days ago' },
];

/* ---------- Profile (Personal center) ---------- */
export const PROFILE_TABS = [
  { id: 'profile', label: 'My profile' },
  { id: 'prefs', label: 'Preferences' },
  { id: 'notify', label: 'Notification settings' },
  { id: 'perms', label: 'My permissions' },
  { id: 'keys', label: 'API keys' },
  { id: 'sessions', label: 'Security & sessions' },
];
export const PROFILE_DETAILS = [
  { dt: 'Full name', dd: 'Lena Marsh' },
  { dt: 'Email', dd: 'lmarsh@ipas' },
  { dt: 'Department', dd: 'Manufacturing Analytics' },
  { dt: 'Identity source', dd: 'Active Directory · SCIM' },
  { dt: 'Member since', dd: 'Mar 2024' },
  { dt: 'Roles', dd: 'Data Engineer, Steward' },
];
export const NOTIF_EVENTS = ['Pipeline success', 'Pipeline failure', 'Quality alert', 'SLA breach', 'Access request', 'Mentions', 'Announcements'];
export const PROFILE_PERMS = [
  { id: 'p1', asset: 'gold.fact_production', access: 'Read / Write', masking: 'None' },
  { id: 'p2', asset: 'gold.dim_product', access: 'Read', masking: 'None' },
  { id: 'p3', asset: 'silver.orders', access: 'Read', masking: 'customer_id → hash' },
  { id: 'p4', asset: 'silver.customers', access: 'Read', masking: 'email → partial, ssn → full' },
  { id: 'p5', asset: 'gold.spc_xbar_r_chart', access: 'Read', masking: 'row filter: process_id IN (P1,P2)' },
];
export const PROFILE_KEYS = [
  { id: 'k1', name: 'personal-cli', prefix: 'ipas_pat_4f9a…', scope: 'read:gold', used: '2 hours ago' },
  { id: 'k2', name: 'notebook-dev', prefix: 'ipas_pat_b21c…', scope: 'read:silver, read:gold', used: 'Yesterday' },
];
export const PROFILE_SESSIONS = [
  { id: 's1', dev: 'MacBook Pro · Chrome', loc: 'Shanghai, CN', ip: '10.4.22.18', when: 'Active now', cur: true },
  { id: 's2', dev: 'iPhone 15 · Safari', loc: 'Shanghai, CN', ip: '10.4.30.9', when: '3 hours ago' },
  { id: 's3', dev: 'Windows · Edge', loc: 'Singapore, SG', ip: '52.187.11.4', when: '2 days ago' },
];

/* ---------- Notifications ---------- */
/* type → icon + tone color, used by the notifications panel */
export const NOTIF_META = {
  'pipeline-success': { icon: 'checkmark--filled', color: 'var(--cds-support-success)' },
  'pipeline-fail': { icon: 'error--filled', color: 'var(--cds-support-error)' },
  'pipeline-running': { icon: 'renew', color: 'var(--cds-blue-60)' },
  quality: { icon: 'warning--alt--filled', color: 'var(--cds-support-warning)' },
  sla: { icon: 'warning--filled', color: 'var(--cds-support-error)' },
  access: { icon: 'user--follow', color: 'var(--cds-blue-60)' },
  system: { icon: 'information--filled', color: 'var(--cds-text-secondary)' },
  mention: { icon: 'chat', color: 'var(--cds-purple-60)' },
};
export const NOTIFICATIONS = [
  { id: 'n1', type: 'access', title: 'Access request', desc: 'Ade Okafor requested the Analyst role on gold.fact_production.', ts: '2 min ago', unread: true, request: true },
  { id: 'n2', type: 'pipeline-fail', title: 'Pipeline failed', desc: 'crm_sync · load_customers failed after 3 retries.', ts: '14 min ago', unread: true },
  { id: 'n3', type: 'sla', title: 'SLA breach', desc: 'crm_sync freshness SLA breached (3h vs 30m target).', ts: '18 min ago', unread: true },
  { id: 'n4', type: 'quality', title: 'Data quality alert', desc: 'silver.orders.customer_id — 142 null rows (High).', ts: '32 min ago', unread: true },
  { id: 'n5', type: 'mention', title: 'Mentioned you', desc: 'R. Vance: "@lmarsh can you certify this metric?"', ts: '1 hour ago', unread: true, mention: true },
  { id: 'n6', type: 'pipeline-success', title: 'Pipeline completed', desc: 'erp_to_gold finished in 11m 04s.', ts: '1 hour ago', unread: false },
  { id: 'n7', type: 'system', title: 'Platform update', desc: 'ClickHouse upgraded to 24.3 · maintenance window closed.', ts: 'Yesterday', unread: false },
];

/* ---------- Shared lookups ---------- */
export const LAYER_TAG = { RAW: 'cool-gray', Bronze: 'cool-gray', Silver: 'cyan', Gold: 'teal' };
export const SENS_TAG = { PII: 'red', Confidential: 'purple', Internal: 'blue', Public: 'green' };
export const DAG_STATUS_COLOR = { success: 'var(--cds-support-success)', running: 'var(--cds-blue-60)', queued: 'var(--cds-text-placeholder)', failed: 'var(--cds-support-error)' };
export const RAG_COLOR = { g: 'var(--cds-support-success)', a: 'var(--cds-support-warning)', r: 'var(--cds-support-error)' };

/* ============================================================
   AI capabilities (§ Models · Semantic · Agent Studio · Insights)
   ============================================================ */

/* ---- AI Models ---- */
export const AI_PROVIDERS = {
  Anthropic: { c: '#d97757', ab: 'A' },
  OpenAI: { c: '#10a37f', ab: 'O' },
  Ollama: { c: '#161616', ab: 'Ω' },
  vLLM: { c: '#5a3ec8', ab: 'V' },
  Azure: { c: '#0078d4', ab: 'Az' },
};
export const AI_CAP_TAG = { chat: 'blue', embedding: 'teal', vision: 'purple', 'function-call': 'cool-gray' };
export const AI_MODELS = [
  { id: 1, name: 'claude-prod', provider: 'Anthropic', endpoint: 'api.anthropic.com', ref: 'claude-opus-4-8', deploy: 'external', caps: ['chat', 'vision', 'function-call'], status: 'Active', default: true, tested: '3 min ago', tok: '128k', usage: { calls: '14.2k', tokens: '8.9M', flows: ['Daily SPC analysis', 'Cpk alert + remediation'] } },
  { id: 2, name: 'local-qwen', provider: 'vLLM', endpoint: 'vllm.insight.svc:8000', ref: 'Qwen2.5-72B-Instruct', deploy: 'local', caps: ['chat', 'function-call'], status: 'Active', default: false, tested: '12 min ago', tok: '32k', usage: { calls: '6.1k', tokens: '3.2M', flows: ['Cross-plant yield report'] } },
  { id: 3, name: 'local-embed', provider: 'Ollama', endpoint: 'ollama.insight.svc:11434', ref: 'bge-m3', deploy: 'local', caps: ['embedding'], status: 'Active', default: false, tested: '1 hour ago', tok: '8k', usage: { calls: '212k', tokens: '54M', flows: ['Semantic vectorization'] } },
  { id: 4, name: 'gpt-vision-ext', provider: 'OpenAI', endpoint: 'api.openai.com', ref: 'gpt-4o', deploy: 'external', caps: ['chat', 'vision'], status: 'Active', default: false, tested: '2 hours ago', tok: '128k', usage: { calls: '3.4k', tokens: '1.1M', flows: [] } },
  { id: 5, name: 'azure-fallback', provider: 'Azure', endpoint: 'insight.openai.azure.com', ref: 'gpt-4o-mini', deploy: 'external', caps: ['chat'], status: 'Inactive', default: false, tested: '3 days ago', tok: '64k', usage: { calls: '0', tokens: '0', flows: [] } },
  { id: 6, name: 'qwen-vision-local', provider: 'vLLM', endpoint: 'vllm-v.insight.svc:8000', ref: 'Qwen2.5-VL-7B', deploy: 'local', caps: ['chat', 'vision'], status: 'Active', default: false, tested: '38 min ago', tok: '16k', usage: { calls: '980', tokens: '420k', flows: [] } },
];
export const AI_SENS_LEVELS = [
  { lvl: 'Public', tag: 'green' }, { lvl: 'Internal', tag: 'blue' }, { lvl: 'Confidential', tag: 'purple' }, { lvl: 'Restricted', tag: 'red' },
];

/* ---- AI Semantic layer ---- */
export const SEM_LAYERS = [
  { layer: 'gold', entities: [
    { id: 'g1', name: 'gold.spc_capability_daily', type: 'table', cb: 'vec' },
    { id: 'g2', name: 'cpk', type: 'metric', cb: 'vec' },
    { id: 'g3', name: 'r3_flag', type: 'field', cb: 'desc' },
    { id: 'g4', name: 'gold.agg_yield_daily', type: 'table', cb: 'pend' },
  ] },
  { layer: 'silver', entities: [
    { id: 's1', name: 'silver.spc_measurements', type: 'table', cb: 'desc' },
    { id: 's2', name: 'process_id', type: 'field', cb: 'vec' },
    { id: 's3', name: 'xbar', type: 'field', cb: 'pend' },
  ] },
  { layer: 'bronze', entities: [
    { id: 'b1', name: 'bronze.qc_results', type: 'table', cb: 'pend' },
    { id: 'b2', name: 'bronze.process_master', type: 'table', cb: 'pend' },
  ] },
];
export const SEM_CB_LABEL = { vec: 'Vectorized', desc: 'Described', pend: 'Pending' };
export const SEM_DETAIL = {
  g1: {
    nl: 'Daily process-capability summary. One row per process per plant per calendar day, reporting Cp and Cpk computed from that day’s in-control SPC measurements.',
    caliber: 'Cpk is computed only from points that pass Western Electric / Nelson rule checks. Out-of-control points are excluded from the daily index.',
    domain: 'gold aggregates must be written in ascending date order. Cpk < 1.33 is marginal; Cpk < 1.0 triggers an alert. r3_flag marks 7 consecutive points on one side of the mean.',
    samples: 'process_id="P1", plant="A", cal_date="2026-06-21", cpk=1.41, cp=1.58',
    rels: 'Aggregated from silver.spc_measurements. Joined to dim_process on process_id, dim_plant on plant.',
    constraints: 'cpk ≥ 0; cal_date NOT NULL; (process_id, plant, cal_date) is unique.',
    sens: 'Internal',
  },
};
export const SEM_DEFAULT_DETAIL = { nl: '', caliber: '', domain: '', samples: '', rels: '', constraints: '', sens: 'Internal' };

/* ---- Agent Studio ---- */
export const AG_NODE_TYPES = {
  trigger: { c: '#525252', icon: 'time', label: 'Trigger', grp: 'Triggers' },
  query: { c: '#0f62fe', icon: 'data--base', label: 'Data query', grp: 'Data & AI' },
  retrieve: { c: '#007d79', icon: 'search', label: 'Semantic search', grp: 'Data & AI' },
  ai: { c: '#8a3ffc', icon: 'watson', label: 'AI inference', grp: 'Data & AI' },
  tool: { c: '#b28600', icon: 'settings', label: 'Tool call', grp: 'Logic & tools' },
  cond: { c: '#ff832b', icon: 'interactions', label: 'Condition', grp: 'Logic & tools' },
  loop: { c: '#ff832b', icon: 'renew', label: 'Loop', grp: 'Logic & tools' },
  hitl: { c: '#da1e28', icon: 'user', label: 'Human approval', grp: 'Logic & tools' },
  output: { c: '#24a148', icon: 'send', label: 'Output', grp: 'Output' },
};
export const AG_PALETTE_GROUPS = ['Triggers', 'Data & AI', 'Logic & tools', 'Output'];
export const AG_FLOWS = [
  { id: 1, name: 'Daily SPC capability analysis', desc: 'Summarize Cpk by process and flag declines', trigger: 'scheduled', status: 'Published', lastRun: 'success', owner: 'L. Marsh' },
  { id: 2, name: 'Cpk alert + remediation', desc: 'On Cpk breach, draft a remediation plan for review', trigger: 'event', status: 'Published', lastRun: 'running', owner: 'R. Vance' },
  { id: 3, name: 'Cross-plant yield report', desc: 'Weekly yield comparison across plants A/B/C', trigger: 'scheduled', status: 'Published', lastRun: 'success', owner: 'M. Díaz' },
  { id: 4, name: 'Defect root-cause triage', desc: 'Cluster recent defects and propose causes', trigger: 'manual', status: 'Draft', lastRun: '—', owner: 'A. Okafor' },
];
export const AG_TRIGGER_TAG = { manual: { t: 'cool-gray', l: 'Manual' }, scheduled: { t: 'blue', l: 'Scheduled' }, event: { t: 'purple', l: 'Event' } };
export const AG_NODES = [
  { id: 'n1', type: 'trigger', x: 40, y: 60, name: 'On Cpk breach', sub: 'event · cpk < 1.0' },
  { id: 'n2', type: 'query', x: 300, y: 60, name: 'Query capability', sub: 'gold.spc_capability_daily', masked: true },
  { id: 'n3', type: 'retrieve', x: 300, y: 250, name: 'Retrieve context', sub: 'RAG · top-k 5' },
  { id: 'n4', type: 'ai', x: 560, y: 150, name: 'Draft remediation', sub: 'claude-prod' },
  { id: 'n5', type: 'cond', x: 820, y: 150, name: 'Severity gate', sub: 'cpk < 0.8 ?' },
  { id: 'n6', type: 'hitl', x: 820, y: 380, name: 'Engineer approval', sub: 'role: Process Eng' },
  { id: 'n7', type: 'output', x: 980, y: 60, name: 'Notify + report', sub: 'channel + PDF' },
];
export const AG_EDGES = [
  { a: 'n1', b: 'n2' }, { a: 'n2', b: 'n4' }, { a: 'n3', b: 'n4' },
  { a: 'n4', b: 'n5' }, { a: 'n5', b: 'n7', label: 'No' }, { a: 'n5', b: 'n6', label: 'Yes' }, { a: 'n6', b: 'n7' },
];
export const AG_TEMPLATES = [
  { name: 'Daily process-capability analysis', desc: 'Scheduled summary of Cpk by process with decline flags.', nodes: 6 },
  { name: 'Cpk alert + remediation', desc: 'Event-driven remediation draft with human approval.', nodes: 7 },
  { name: 'Cross-plant yield comparison report', desc: 'Weekly yield benchmark across plants A/B/C.', nodes: 5 },
];
export const AG_TRACE_STEPS = [
  { id: 'n1', dur: '2 ms', status: 'ok', io: { in: 'monitor event', out: 'process_id=P1, plant=A, cpk=0.74' } },
  { id: 'n2', dur: '128 ms', status: 'ok', masked: true, evidence: [['process_id', 'plant', 'cal_date', 'cpk', 'cp'], ['P1', 'A', '2026-06-21', '0.74', '0.81'], ['P1', 'A', '2026-06-20', '0.79', '0.86'], ['P1', 'A', '2026-06-19', '0.83', '0.90']] },
  { id: 'n3', dur: '64 ms', status: 'ok', io: { in: 'query: P1 capability decline', out: '5 chunks · cpk definition, r3_flag rule, gold ordering rule' } },
  { id: 'n4', dur: '2.1 s', status: 'ok', model: 'claude-prod', prompt: 'Process P1 on plant A has Cpk 0.74. Using context [cpk def; r3_flag rule]. Draft a remediation plan with 3 prioritized actions.', reply: '1. Halt P1 and re-center the process mean — Cpk 0.74 is below the 1.0 action limit.\n2. Audit the last calibration of gauge G-114; 3 consecutive points trend low (r3 pattern forming).\n3. Re-sample after adjustment and confirm Cpk ≥ 1.33 before resuming.' },
  { id: 'n5', dur: '1 ms', status: 'ok', io: { in: 'n2.cpk = 0.74', out: 'cpk < 0.8 → Yes branch' } },
  { id: 'n6', dur: 'waiting', status: 'wait' },
  { id: 'n7', dur: '—', status: 'pending' },
];

/* ---- AI Insights ---- */
export const AI_SEV_COLOR = { high: 'var(--cds-support-error)', medium: 'var(--cds-support-warning)', low: 'var(--cds-text-placeholder)' };
export const AI_SEV_TAG = { high: 'red', medium: 'purple', low: 'cool-gray' };
export const AI_INSIGHTS = [
  { id: 1, title: 'P1 capability fell below the action limit on plant A', sev: 'high', when: '14 min ago', source: 'Cpk alert + remediation', process: 'P1',
    summary: 'Cpk on process P1 (plant A) dropped to 0.74 today — below the 1.0 action limit and the third consecutive daily decline. An r3 pattern (7 points trending one side) is forming.',
    evidence: [['cal_date', 'process_id', 'plant', 'cpk', 'cp'], ['2026-06-21', 'P1', 'A', '0.74', '0.81'], ['2026-06-20', 'P1', 'A', '0.79', '0.86'], ['2026-06-19', 'P1', 'A', '0.83', '0.90']],
    rec: ['Halt P1 and re-center the process mean.', 'Audit the last calibration of gauge G-114.', 'Re-sample and confirm Cpk ≥ 1.33 before resuming.'] },
  { id: 2, title: 'Plant B yield trails the group by 2.1 points this week', sev: 'medium', when: '2 hours ago', source: 'Cross-plant yield report', process: 'All',
    summary: 'Weekly yield on plant B is 94.3% vs a group average of 96.4%. The gap concentrates in the final test step, where B’s scrap rate is 1.8× plant A.',
    evidence: [['plant', 'yield_pct', 'scrap_final'], ['A', '96.8', '0.9%'], ['B', '94.3', '1.6%'], ['C', '96.1', '1.0%']],
    rec: ['Review final-test fixture wear on plant B.', 'Compare B’s test limits against the A/C baseline.'] },
  { id: 3, title: 'Defect cluster D-204 recurring across three shifts', sev: 'low', when: 'Yesterday', source: 'Defect root-cause triage', process: 'P2',
    summary: 'A solder-bridge defect signature (D-204) appears across all three shifts on P2, suggesting an equipment rather than operator cause.',
    evidence: [['shift', 'defect_code', 'count'], ['A', 'D-204', '12'], ['B', 'D-204', '9'], ['C', 'D-204', '11']],
    rec: ['Inspect the reflow oven profile on P2.', 'Pull maintenance log for the last 7 days.'] },
];
export const AI_QA_SUGGEST = ['Which process had the worst Cpk last week?', 'Compare yield across plants this month', 'Why did P1 capability drop?'];

/* ============================================================
   Federation (Control Tower · Lakehouses)
   ============================================================ */
export const FED_PLANTS = [
  { id: 'plant-a', name: 'Plant A', region: 'Shanghai, CN', state: 'online', version: 'v2.4.1', blueprint: 'bp-2026.06', pipes: '18 / 18', fresh: '2 min', sync: '120 ms', report: '14s ago', cpk: 1.41, yield: 96.8 },
  { id: 'plant-b', name: 'Plant B', region: 'Penang, MY', state: 'alert', version: 'v2.4.1', blueprint: 'bp-2026.06', pipes: '15 / 17', fresh: '11 min', sync: '480 ms', report: '38s ago', cpk: 1.12, yield: 94.3 },
  { id: 'plant-c', name: 'Plant C', region: 'Dresden, DE', state: 'online', version: 'v2.3.9', blueprint: 'bp-2026.05', pipes: '12 / 12', fresh: '4 min', sync: '210 ms', report: '9s ago', cpk: 1.33, yield: 96.1 },
  { id: 'plant-d', name: 'Plant D', region: 'Austin, US', state: 'offline', version: 'v2.4.1', blueprint: 'bp-2026.06', pipes: '— / 14', fresh: '—', sync: '—', report: '12 min ago', cpk: null, yield: null },
];
export const FED_STATE_LABEL = { online: 'Online', alert: 'Alert', offline: 'Offline' };
export const FED_STATE_KIND = { online: 'success', alert: 'warning', offline: 'error' };
export const FED_CMD_TYPES = [
  { id: 'pipeline', nm: 'Trigger pipeline', dc: 'Run a named pipeline at the plant.' },
  { id: 'config', nm: 'Push config', dc: 'Send a configuration change to apply.' },
  { id: 'blueprint', nm: 'Push blueprint version', dc: 'Roll out a new lakehouse blueprint.' },
];
export const FED_COMMANDS = [
  { ty: 'trigger pipeline · spc_capability_daily', st: 'executed', when: '2 min ago' },
  { ty: 'push config · sync.interval=5m', st: 'pulled', when: '1 hour ago' },
  { ty: 'push blueprint · bp-2026.06', st: 'queued', when: '3 hours ago' },
  { ty: 'push config · retention=90d', st: 'refused', when: 'Yesterday' },
];
export const FED_CMD_KIND = { executed: 'success', pulled: 'blue', queued: 'warning', refused: 'error' };
export const FED_NEW_STEPS = [['Plant', 'ID & network'], ['Sources', 'Connections'], ['Blueprint', 'Generate'], ['Deploy', 'Guide']];
