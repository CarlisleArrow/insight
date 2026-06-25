/* Field schemas that drive create/edit FormModals.
   type: 'text' | 'password' | 'textarea' | 'select'. */

export const SCHEMAS = {
  // ---- Admin ----
  adminUsers: [
    { key: 'name', label: 'Name', type: 'text', placeholder: 'Jane Doe' },
    { key: 'email', label: 'Email', type: 'text', placeholder: 'jdoe@ipas' },
    { key: 'role', label: 'Role', type: 'select', items: ['Admin', 'Editor', 'Steward', 'Viewer'] },
    { key: 'org', label: 'Organization', type: 'select', items: ['Manufacturing', 'Finance', 'Logistics', 'Operations', 'Growth'] },
    { key: 'status', label: 'Status', type: 'select', items: ['Active', 'Invited', 'Suspended'] },
  ],
  adminOrgs: [
    { key: 'org', label: 'Organization', type: 'text' },
    { key: 'members', label: 'Members', type: 'text', default: '0' },
    { key: 'projects', label: 'Projects', type: 'text', default: '0' },
    { key: 'owner', label: 'Owner', type: 'text' },
  ],
  adminConfig: [
    { key: 'key', label: 'Setting', type: 'text', placeholder: 'feature.flag.x' },
    { key: 'val', label: 'Value', type: 'text' },
    { key: 'scope', label: 'Scope', type: 'select', items: ['Global', 'Manufacturing', 'Finance', 'Logistics', 'Operations'] },
    { key: 'by', label: 'Updated by', type: 'text', default: 'L. Marsh' },
  ],
  adminApi: [
    { key: 'name', label: 'Key name', type: 'text', placeholder: 'bi-readonly' },
    { key: 'prefix', label: 'Key', type: 'text', default: 'ipas_sk_…' },
    { key: 'scope', label: 'Scopes', type: 'text', placeholder: 'read:gold' },
    { key: 'rate', label: 'Rate limit', type: 'text', default: '600/min' },
    { key: 'status', label: 'Status', type: 'select', items: ['Active', 'Revoked'] },
  ],
  adminTenancy: [
    { key: 'tenant', label: 'Tenant', type: 'text' },
    { key: 'plan', label: 'Plan', type: 'select', items: ['Enterprise', 'Standard', 'Trial'] },
    { key: 'isolation', label: 'Isolation', type: 'select', items: ['Dedicated schema', 'Shared (RLS)'] },
    { key: 'storage', label: 'Storage', type: 'text', default: '0 GB' },
    { key: 'status', label: 'Status', type: 'select', items: ['Active', 'Provisioning'] },
  ],

  // ---- Analytics ----
  report: [
    { key: 'name', label: 'Report', type: 'text', placeholder: 'Weekly digest' },
    { key: 'schedule', label: 'Schedule (cron)', type: 'text', default: '0 7 * * 1' },
    { key: 'recipients', label: 'Recipients', type: 'text', placeholder: 'team@ipas' },
    { key: 'format', label: 'Format', type: 'select', items: ['PDF', 'Excel', 'PNG'] },
    { key: 'channel', label: 'Channel', type: 'select', items: ['Email', 'IM', 'Webhook'] },
    { key: 'status', label: 'Status', type: 'select', items: ['Active', 'Paused', 'Draft'] },
  ],

  // ---- Modeling ----
  metric: [
    { key: 'name', label: 'Metric name', type: 'text', placeholder: 'First-pass yield' },
    { key: 'unit', label: 'Unit', type: 'select', items: ['%', 'USD', 'min', 'count', 'ratio'] },
    { key: 'def', label: 'Business definition', type: 'textarea', placeholder: 'Plain-language definition' },
    { key: 'formula', label: 'Formula', type: 'text', placeholder: '1 - (defects / units_started)' },
    { key: 'owner', label: 'Owner', type: 'text', default: 'L. Marsh' },
    { key: 'status', label: 'Status', type: 'select', items: ['Draft', 'Review', 'Certified'] },
  ],

  // ---- DevConfig ----
  source: [
    { key: 'type', label: 'Type', type: 'select', items: ['Oracle', 'MySQL', 'SQL Server', 'Iceberg', 'ClickHouse', 'Kafka'] },
    { key: 'name', label: 'Connection name', type: 'text', placeholder: 'erp-oracle-prod' },
    { key: 'host', label: 'Host', type: 'text', placeholder: 'db.ipas.internal:1521' },
    { key: 'status', label: 'Status', type: 'select', items: ['Connected', 'Degraded', 'Error'] },
    { key: 'tested', label: 'Last tested', type: 'text', default: 'just now' },
  ],
  dqRule: [
    { key: 'target', label: 'Target table / field', type: 'text', placeholder: 'gold.fact_production.yield_pct' },
    { key: 'type', label: 'Rule type', type: 'select', items: ['Not null', 'Range', 'Uniqueness', 'Custom assertion'] },
    { key: 'sev', label: 'Severity', type: 'select', items: ['High', 'Medium', 'Low'] },
    { key: 'result', label: 'Last result', type: 'select', items: ['Pass', 'Warn', 'Fail'] },
    { key: 'n', label: 'Rows', type: 'text', default: '0 failed' },
  ],
  // Real Debezium (MySQL) connector spec — submitted to POST/PUT /api/connectors.
  connector: [
    { key: 'name', label: 'Connector name', type: 'text', placeholder: 'qms-che-connector' },
    { key: 'topicPrefix', label: 'Topic prefix', type: 'text', placeholder: 'qms' },
    { key: 'dbHost', label: 'Source DB host', type: 'text', placeholder: '172.16.201.30' },
    { key: 'dbPort', label: 'Source DB port', type: 'text', default: '3306' },
    { key: 'dbUser', label: 'DB user', type: 'text', placeholder: 'debezium_user' },
    { key: 'dbPassword', label: 'DB password', type: 'password' },
    { key: 'database', label: 'Database (include list)', type: 'text', placeholder: 'qms' },
    { key: 'tables', label: 'Tables (comma-separated)', type: 'text', placeholder: 'qms.categories, qms.lines' },
    { key: 'serverId', label: 'DB server id', type: 'text', default: '184054' },
    { key: 'bootstrap', label: 'Kafka bootstrap', type: 'text', default: 'kafka-cluster.kafka.svc.cluster.local:9092' },
  ],

  // ---- Governance ----
  accessUser: [
    { key: 'name', label: 'User', type: 'text' },
    { key: 'email', label: 'Email', type: 'text', placeholder: 'name@ipas' },
    { key: 'role', label: 'Role', type: 'select', items: ['Data Engineer', 'Analyst', 'Steward', 'Viewer'] },
    { key: 'status', label: 'Status', type: 'select', items: ['Active', 'Invited'] },
  ],
  accessRole: [
    { key: 'role', label: 'Role', type: 'text' },
    { key: 'members', label: 'Members', type: 'text', default: '0' },
    { key: 'scope', label: 'Scope', type: 'text', placeholder: 'Read Gold · query' },
    { key: 'model', label: 'Model', type: 'select', items: ['RBAC', 'ABAC'] },
  ],
};

export function emptyValues(schema, initial) {
  const out = {};
  for (const f of schema) {
    if (initial && initial[f.key] != null) out[f.key] = initial[f.key];
    else if (f.default != null) out[f.key] = f.default;
    else if (f.type === 'select') out[f.key] = f.items[0];
    else out[f.key] = '';
  }
  return out;
}
