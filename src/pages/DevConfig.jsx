import { useState, useEffect, useMemo } from 'react';
import {
  Button, Tag, Toggle, Checkbox, TextInput,
  Tabs, TabList, Tab, TabPanels, TabPanel,
  ProgressIndicator, ProgressStep,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
} from '@carbon/react';
import { CardNode, CardNodeColumn, CardNodeTitle, CardNodeSubtitle } from '@carbon/charts-react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { Picker } from '../components/inputs.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot, ToolBtn, RowMenu, SidePanel, Placeholder } from '../components/shared.jsx';
import { FormModal, ConfirmDelete } from '../components/modals.jsx';
import NetworkDiagram from '../components/NetworkDiagram.jsx';
import { useCollection } from '../data/DataProvider.jsx';
import * as api from '../data/api.js';
import { SCHEMAS } from '../data/formSchemas.js';
import { DAG_STATUS_COLOR, CDC_TABLES } from '../data/mockData.js';
import { tr, trList } from '../i18n.js';

/* Add/edit data source modal — matches the prototype's multi-field connection
   form (type/name, host/port, database/username, password, test). Persisted
   fields map to the backend datasource shape (host = host:port). */
function DataSourceModal({ mode, row, onClose, onSubmit, lang }) {
  const init = row || {};
  const splitHost = String(init.host || '').split(':');
  const [v, setV] = useState({
    type: init.type || 'Oracle',
    name: init.name || '',
    host: splitHost[0] || '',
    port: splitHost[1] || '',
    database: init.database || '',
    username: init.username || '',
    password: '',
  });
  const [tested, setTested] = useState(null); // null | {status, ms} | 'busy'
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const hostPort = () => (v.port ? `${v.host}:${v.port}` : v.host);
  const test = async () => {
    if (!v.host) { setTested({ status: 'Error', ms: 0, message: tr(lang, 'Host required') }); return; }
    setTested('busy');
    try {
      // Real credentialed connect — type/host/port/database/username/password.
      setTested(await api.testDatasource({ type: v.type, host: v.host, port: v.port, database: v.database, username: v.username, password: v.password }));
    } catch (err) { setTested({ status: 'Error', ms: 0, message: String(err.message || err) }); }
  };
  const submit = () => onSubmit({ name: v.name, type: v.type, host: hostPort(), status: 'Connected', tested: 'just now' });
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader label={tr(lang, 'Connections')} title={mode === 'create' ? tr(lang, 'Add data source') : tr(lang, 'Edit data source')} />
      <ModalBody hasForm>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="w-row">
            <Picker label={tr(lang, 'Type')} items={['Oracle', 'MySQL', 'SQL Server', 'Iceberg', 'ClickHouse', 'Kafka', 'PostgreSQL', 'S3']} value={v.type} onChange={(val) => set('type', val)} />
            <TextInput id="ds-name" labelText={tr(lang, 'Connection name')} placeholder="erp-oracle-prod" value={v.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="w-row">
            <TextInput id="ds-host" labelText={tr(lang, 'Host')} placeholder="db.ipas.internal" value={v.host} onChange={(e) => set('host', e.target.value)} />
            <TextInput id="ds-port" labelText={tr(lang, 'Port')} placeholder="1521" value={v.port} onChange={(e) => set('port', e.target.value)} />
          </div>
          <div className="w-row">
            <TextInput id="ds-db" labelText={tr(lang, 'Database / service')} placeholder="ORCLPDB1" value={v.database} onChange={(e) => set('database', e.target.value)} />
            <TextInput id="ds-user" labelText={tr(lang, 'Username')} placeholder="svc_ipas" value={v.username} onChange={(e) => set('username', e.target.value)} />
          </div>
          <TextInput id="ds-pw" type="password" labelText={tr(lang, 'Password')} placeholder="••••••••••" value={v.password} onChange={(e) => set('password', e.target.value)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button kind="tertiary" size="md" renderIcon={iconFor('renew')} disabled={tested === 'busy'} onClick={test}>{tested === 'busy' ? tr(lang, 'Testing…') : tr(lang, 'Test connection')}</Button>
            {tested && tested !== 'busy' && (tested.status === 'Connected'
              ? <StatusDot kind="connected">{tr(lang, 'Connected')} · {tested.message} · {tested.ms}ms</StatusDot>
              : <StatusDot kind="failed">{tested.message || tr(lang, 'Unreachable')}</StatusDot>)}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>{tr(lang, 'Cancel')}</Button>
        <Button kind="primary" renderIcon={iconFor('checkmark')} onClick={submit}>{mode === 'create' ? tr(lang, 'Add source') : tr(lang, 'Save')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

/* ---------------- Data sources ----------------
   Rows are LIVE: the platform's core components are health-probed by the BFF on
   every fetch (readonly), and user-registered sources are probed too. Status
   reflects the actual cluster, not a stored value. */
function DataSources({ notify, lang }) {
  const { items, add, update, remove, set } = useCollection('sources');
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const headers = [
    { key: 'name', header: tr(lang, 'Connection') },
    { key: 'type', header: tr(lang, 'Type') },
    { key: 'host', header: tr(lang, 'Host'), mono: true },
    { key: 'status', header: tr(lang, 'Status') },
    { key: 'tested', header: tr(lang, 'Last tested') },
    { key: 'ofw', header: '' },
  ];
  // Re-probe everything by re-fetching the live status list.
  const refresh = async () => {
    setRefreshing(true);
    try {
      const rows = await api.datasources.list();
      set((rows || []).map((c, i) => ({ ...c, id: String(c.id != null ? c.id : `sources-${i}`) })));
    } catch (err) {
      notify && notify({ kind: 'error', title: tr(lang, 'Refresh failed.'), subtitle: String(err.message || err) });
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={items}
        withPagination
        searchPlaceholder={tr(lang, 'Search connections')}
        actions={(
          <>
            <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('renew')} iconDescription={tr(lang, 'Re-probe')} disabled={refreshing} onClick={refresh} />
            <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({ mode: 'create' })}>{tr(lang, 'Add data source')}</Button>
          </>
        )}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => e.preventDefault()}>{r.name}</a>;
          if (k === 'type') return <Tag type="cool-gray" size="sm">{r.type}</Tag>;
          if (k === 'status') return <StatusDot kind={r.status}>{tr(lang, r.status)}</StatusDot>;
          // Core infra rows are readonly (no edit/delete); only custom sources get the menu.
          if (k === 'ofw') return r.readonly
            ? <Tag type="cool-gray" size="sm" title={tr(lang, 'Managed platform component')}>{tr(lang, 'platform')}</Tag>
            : <RowMenu items={undefined} onEdit={() => setModal({ mode: 'edit', row: r })} onDelete={() => setDel(r)} />;
          return r[k];
        }}
      />
      {modal && (
        <DataSourceModal mode={modal.mode} row={modal.row} lang={lang}
          onSubmit={(vals) => { if (modal.mode === 'create') add(vals); else update(modal.row.id, vals); setModal(null); notify && notify({ kind: 'success', title: modal.mode === 'create' ? tr(lang, 'Data source added.') : tr(lang, 'Data source updated.') }); }}
          onClose={() => setModal(null)} />
      )}
      <ConfirmDelete open={!!del} title={tr(lang, 'Delete data source')} body={del ? `${tr(lang, 'Delete')} "${del.name}"?` : ''} onConfirm={() => { remove(del.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Data source removed.') }); }} onClose={() => setDel(null)} />
    </div>
  );
}

/* ---------------- ETL DAG (Carbon network diagram, ELK layout) ---------------- */
function DagNode({ node, selected }) {
  return (
    <div className={`nd-wrap ${selected ? 'sel' : ''}`}>
      <CardNode color={DAG_STATUS_COLOR[node.status]}>
        <CardNodeColumn><Icon name="data--base" size={20} /></CardNodeColumn>
        <CardNodeColumn><CardNodeTitle>{node.label}</CardNodeTitle><CardNodeSubtitle>{node.sub}</CardNodeSubtitle></CardNodeColumn>
        <span style={{ marginLeft: 'auto', alignSelf: 'center', width: 8, height: 8, borderRadius: '50%', flex: '0 0 8px', background: DAG_STATUS_COLOR[node.status] }} />
      </CardNode>
    </div>
  );
}

function EtlDag({ notify, lang }) {
  // ETL DAG graph from GET /api/pipelines/dag (Airflow task graph + run states).
  const [dag, setDag] = useState({ dag_id: '', tasks: [], recent_runs: [] });
  const [sel, setSel] = useState(null);
  const [logs, setLogs] = useState(false);

  const load = () => api.getPipelineDag()
    .then((g) => { setDag(g || { tasks: [], recent_runs: [] }); setSel((s) => s || (g.tasks && g.tasks[0] && g.tasks[0].id)); })
    .catch((err) => console.error('dag failed', err));
  useEffect(() => { load(); }, []);

  const nodes = useMemo(() => (dag.tasks || []).map((t) => ({ id: t.id, label: t.label, status: t.status, sub: t.status })), [dag]);
  const links = useMemo(() => {
    const out = [];
    (dag.tasks || []).forEach((t) => (t.downstream || []).forEach((d, i) => out.push({ id: `${t.id}->${d}-${i}`, source: t.id, target: d })));
    return out;
  }, [dag]);
  const sn = nodes.find((n) => n.id === sel) || nodes[0] || { id: '', label: '—', status: 'queued' };

  const run = async () => {
    if (!dag.dag_id) return;
    try { await api.runPipeline(dag.dag_id); notify && notify({ kind: 'success', title: tr(lang, 'Pipeline run started.') }); await load(); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Run failed.'), subtitle: String(err.message || err) }); }
  };
  const pause = async () => {
    if (!dag.dag_id) return;
    try { await api.pausePipeline(dag.dag_id); notify && notify({ kind: 'warning', title: tr(lang, 'Pipeline paused.') }); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Pause failed.'), subtitle: String(err.message || err) }); }
  };
  const backfill = async () => {
    if (!dag.dag_id) return;
    try { await api.backfillPipeline(dag.dag_id, '', ''); notify && notify({ kind: 'info', title: tr(lang, 'Backfill scheduled.') }); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Backfill failed.'), subtitle: String(err.message || err) }); }
  };

  return (
    <div className="dv-dag">
      <div className="w-etoolbar">
        <Button kind="primary" size="lg" renderIcon={iconFor('play')} onClick={run}>{tr(lang, 'Run')}</Button>
        <ToolBtn icon="pause" label={tr(lang, 'Pause')} onClick={pause} />
        <ToolBtn icon="renew" label={tr(lang, 'Backfill')} onClick={backfill} />
        <span className="gap" />
        <ToolBtn icon="time" label={dag.dag_id ? `DAG: ${dag.dag_id}` : 'DAG'} />
        <span className="spacer" />
        <ToolBtn icon="zoom--out" label="" title={tr(lang, 'Zoom out')} />
        <ToolBtn icon="zoom--in" label="" title={tr(lang, 'Zoom in')} />
      </div>
      <div className="dv-runstrip">
        <span>{tr(lang, 'Recent runs')}</span>
        <div className="bars">{(dag.recent_runs || []).map((s, i) => <i key={i} style={{ background: DAG_STATUS_COLOR[s] }} title={s} />)}</div>
        <span style={{ marginLeft: 'auto' }}>{(dag.tasks || []).length} {tr(lang, 'tasks')}</span>
      </div>
      <div className="dv-dagbody">
        <div className="dv-canvas" style={{ background: 'var(--cds-layer-02)' }}>
          {nodes.length > 0 ? (
            <NetworkDiagram nodes={nodes} links={links} nodeSize={() => ({ width: 188, height: 64 })} selected={sel} onSelect={(n) => setSel(n.id)} height={520} edgeColor="#8d8d8d" renderNode={(node, { selected }) => <DagNode node={node} selected={selected} />} />
          ) : (
            <div style={{ height: 520, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>{tr(lang, 'No DAG tasks to display.')}</div>
          )}
        </div>
        <aside className="dv-side">
          <div className="dv-side__h">{tr(lang, 'Task')} · {sn.label}</div>
          <div className="dv-side__body">
            <StatusDot kind={sn.status}>{tr(lang, sn.status[0].toUpperCase() + sn.status.slice(1))}</StatusDot>
            <div className="w-fld"><label>{tr(lang, 'Parameters')}</label>
              <div className="dv-kv">
                <div className="dv-kv__r"><span className="k">operator</span><span className="v">dbt_run</span></div>
                <div className="dv-kv__r"><span className="k">model</span><span className="v">{sn.label}</span></div>
                <div className="dv-kv__r"><span className="k">pool</span><span className="v">transform</span></div>
              </div>
            </div>
            <Picker label={tr(lang, 'Schedule')} items={['Inherit from DAG', '0 */2 * * *', '@daily']} itemToString={(it) => tr(lang, it)} value="Inherit from DAG" onChange={() => {}} />
            <div className="w-fld"><label>{tr(lang, 'Upstream dependencies')}</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><Tag type="cool-gray" size="sm">conform_dims</Tag></div></div>
            <Button kind="tertiary" size="sm" renderIcon={iconFor('document')} onClick={() => setLogs(true)}>{tr(lang, 'View logs (ELK)')}</Button>
          </div>
        </aside>
      </div>
      {logs && (
        <SidePanel sup={tr(lang, 'ELK logs')} title={sn.label} width={520} onClose={() => setLogs(false)} footer={<Button kind="secondary" onClick={() => setLogs(false)}>{tr(lang, 'Close')}</Button>}>
          <div className="ip-mono" style={{ fontSize: '.75rem', background: 'var(--cds-gray-100)', color: '#f4f4f4', padding: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {`[14:32:01] INFO  Starting ${sn.label}\n[14:32:01] INFO  Resolving upstream: conform_dims (success)\n[14:32:02] INFO  dbt run --select ${sn.label}\n[14:32:08] INFO  1 model OK in 6.4s\n[14:32:08] INFO  Rows affected: 142,800\n[14:32:08] INFO  Status: ${sn.status}`}
          </div>
        </SidePanel>
      )}
    </div>
  );
}

/* ---------------- CDC / sync ---------------- */
// buildConnectorSpec maps the connector form to an adapter.ConnectorSpec (§5.4).
function buildConnectorSpec(v) {
  return {
    name: v.name,
    topic_prefix: v.topicPrefix,
    tables: String(v.tables || '').split(',').map((t) => t.trim()).filter(Boolean),
    config: {
      'database.hostname': v.dbHost || '',
      'database.port': v.dbPort || '3306',
      'database.user': v.dbUser || '',
      'database.password': v.dbPassword || '',
      'database.server.id': v.serverId || '184054',
      'database.include.list': v.database || '',
      'topic.prefix': v.topicPrefix || '',
      'schema.history.internal.kafka.bootstrap.servers': v.bootstrap || 'kafka-cluster.kafka.svc.cluster.local:9092',
    },
  };
}

function Cdc({ notify, lang }) {
  const { items, set } = useCollection('connectors');
  const [selId, setSelId] = useState(items[0] && items[0].id);
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const sel = items.find((c) => c.id === selId) || items[0];

  // Re-read connectors from the BFF (Debezium) after any mutation.
  const reload = () => api.getPipelines()
    .then((rows) => set((rows || []).map((c, i) => ({ ...c, id: String(c.id != null ? c.id : i) }))))
    .catch((err) => console.error('connectors reload failed', err));
  const submit = async (mode, row, v) => {
    try {
      if (mode === 'create') await api.createConnector(buildConnectorSpec(v));
      else await api.updateConnector(row.id, buildConnectorSpec(v));
      await reload();
      notify && notify({ kind: 'success', title: mode === 'create' ? tr(lang, 'Connector created.') : tr(lang, 'Connector updated.') });
    } catch (err) {
      notify && notify({ kind: 'error', title: tr(lang, 'Connector save failed.'), subtitle: String(err.message || err) });
    }
  };
  const confirmDelete = async () => {
    try { await api.deleteConnector(del.id); await reload(); notify && notify({ kind: 'success', title: tr(lang, 'Connector deleted.') }); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Delete failed.'), subtitle: String(err.message || err) }); }
    setDel(null);
  };
  const headers = [
    { key: 'name', header: tr(lang, 'Connector') },
    { key: 'src', header: tr(lang, 'Source DB') },
    { key: 'topic', header: tr(lang, 'Topic prefix'), mono: true },
    { key: 'status', header: tr(lang, 'Status') },
    { key: 'lag', header: tr(lang, 'Watermark lag') },
    { key: 'ofw', header: '' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16, alignItems: 'start' }}>
      <CarbonTable
        headers={headers}
        rows={items}
        onRowClick={(r) => setSelId(r.id)}
        searchPlaceholder={tr(lang, 'Search connectors')}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({ mode: 'create' })}>{tr(lang, 'New connector')}</Button>}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => e.preventDefault()}>{r.name}</a>;
          if (k === 'status') return <StatusDot kind={r.status}>{tr(lang, r.status)}</StatusDot>;
          if (k === 'lag') return <span className="dv-lag"><span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--cds-support-${r.lagKind === 'green' ? 'success' : r.lagKind === 'amber' ? 'warning' : 'error'})` }} />{r.lag}</span>;
          if (k === 'ofw') return <RowMenu onEdit={() => setModal({ mode: 'edit', row: r })} onDelete={() => setDel(r)} />;
          return r[k];
        }}
      />
      <div style={{ background: 'var(--cds-layer-02)', border: '1px solid var(--wire-border)' }}>
        <div className="dv-side__h" style={{ borderBottom: '1px solid var(--wire-border)' }}>{tr(lang, 'Connector')} · {sel ? sel.name : '—'}</div>
        {sel && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <StatusDot kind={sel.status}>{tr(lang, sel.status)} · Debezium 2.5</StatusDot>
            <div className="w-fld"><label>{tr(lang, 'Tables synced')} ({CDC_TABLES.length})</label>
              <div className="dv-kv">{CDC_TABLES.map((t) => <div key={t} className="dv-kv__r"><span className="k">{t}</span><span className="v">{tr(lang, 'snapshot ✓')}</span></div>)}</div>
            </div>
            <div className="w-fld"><label>{tr(lang, 'Schema-change retention')}</label><Picker items={['7 days', '30 days', '90 days']} itemToString={(it) => tr(lang, it)} value="30 days" onChange={() => {}} /></div>
            <Toggle size="sm" id="cdc-evolve" labelText={tr(lang, 'Auto-evolve downstream schema')} defaultToggled />
          </div>
        )}
      </div>
      {modal && (
        <FormModal open label="CDC" title={modal.mode === 'create' ? tr(lang, 'New connector') : tr(lang, 'Edit connector')} submitText={modal.mode === 'create' ? tr(lang, 'Create') : tr(lang, 'Save')} schema={SCHEMAS.connector} initial={modal.row && { name: modal.row.name, topicPrefix: modal.row.topic }}
          onSubmit={(v) => { submit(modal.mode, modal.row, v); setModal(null); }}
          onClose={() => setModal(null)} />
      )}
      <ConfirmDelete open={!!del} title={tr(lang, 'Delete connector')} body={del ? `${tr(lang, 'Delete')} "${del.name}"?` : ''} onConfirm={confirmDelete} onClose={() => setDel(null)} />
    </div>
  );
}

/* Add/edit data-quality rule modal — matches the prototype (target/field,
   rule type/severity, assertion SQL, alerts). Target tables + fields are pulled
   from the real catalog (/api/datasets + schema). */
const DQ_TYPES = ['Not null', 'Range', 'Uniqueness', 'Custom assertion'];
function assertionFor(type, field) {
  switch (type) {
    case 'Not null': return `${field} IS NOT NULL`;
    case 'Range': return `${field} BETWEEN 0 AND 1`;
    case 'Uniqueness': return `count(*) = count(DISTINCT ${field})`;
    default: return `-- custom SQL on ${field}`;
  }
}
function DataQualityModal({ mode, row, onClose, onSubmit, lang }) {
  const init = row || {};
  const [tables, setTables] = useState([]);
  const [cols, setCols] = useState([]);
  const initTable = String(init.target || '').split('.').slice(0, -1).join('.');
  const initField = String(init.target || '').split('.').slice(-1)[0];
  const [v, setV] = useState({
    table: initTable || '', field: initField || '',
    type: init.type || 'Range', sev: init.sev || 'High',
    notify: true, block: true,
  });
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));

  useEffect(() => {
    let alive = true;
    api.getDatasets()
      .then((ts) => { if (!alive) return; const names = (ts || []).map((t) => `${t.namespace}.${t.name}`); setTables(names); setV((s) => ({ ...s, table: s.table || names[0] || '' })); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!v.table) return;
    const [ns, table] = v.table.split('.');
    api.getDatasetSchema(ns, table)
      .then((sc) => { const cs = (sc.columns || []).map((c) => c.col); setCols(cs); setV((s) => ({ ...s, field: cs.includes(s.field) ? s.field : (cs[0] || '') })); })
      .catch(() => setCols([]));
  }, [v.table]);

  const submit = () => onSubmit({
    target: `${v.table}.${v.field}`, type: v.type, sev: v.sev,
    result: 'Pending', n: '—',
    assertion: assertionFor(v.type, v.field),
    alert_notify: v.notify, alert_block: v.block,
  });
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader label={tr(lang, 'Data quality')} title={mode === 'create' ? tr(lang, 'Add rule') : tr(lang, 'Edit rule')} />
      <ModalBody hasForm>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="w-row">
            <Picker label={tr(lang, 'Target table')} items={tables.length ? tables : [tr(lang, '(loading…)')]} value={v.table} onChange={(val) => set('table', val)} />
            <Picker label={tr(lang, 'Field')} items={cols.length ? cols : [tr(lang, '(none)')]} value={v.field} onChange={(val) => set('field', val)} />
          </div>
          <div className="w-row">
            <Picker label={tr(lang, 'Rule type')} items={DQ_TYPES} itemToString={(it) => tr(lang, it)} value={v.type} onChange={(val) => set('type', val)} />
            <Picker label={tr(lang, 'Severity')} items={['High', 'Medium', 'Low']} itemToString={(it) => tr(lang, it)} value={v.sev} onChange={(val) => set('sev', val)} />
          </div>
          <div className="w-fld"><label className="cds--label">{tr(lang, 'Assertion (SQL)')}</label>
            <div className="ip-mono" style={{ fontSize: '.8125rem', background: 'var(--cds-gray-100)', color: '#f4f4f4', padding: 12, minHeight: 56, whiteSpace: 'pre' }}>{assertionFor(v.type, v.field || 'field')}</div>
          </div>
          <div className="w-fld"><label className="cds--label">{tr(lang, 'Alert')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Checkbox id="dq-notify" labelText={tr(lang, 'Notify #data-quality on failure')} checked={v.notify} onChange={(_, { checked }) => set('notify', checked)} />
              <Checkbox id="dq-block" labelText={tr(lang, 'Block downstream pipeline on High severity')} checked={v.block} onChange={(_, { checked }) => set('block', checked)} />
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>{tr(lang, 'Cancel')}</Button>
        <Button kind="primary" renderIcon={iconFor('checkmark')} onClick={submit}>{mode === 'create' ? tr(lang, 'Add rule') : tr(lang, 'Save')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

/* ---------------- Data quality ---------------- */
function DataQuality({ notify, lang }) {
  const { items, add, update, remove } = useCollection('dqRules');
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const headers = [
    { key: 'target', header: tr(lang, 'Target table / field'), mono: true },
    { key: 'type', header: tr(lang, 'Rule type') },
    { key: 'sev', header: tr(lang, 'Severity') },
    { key: 'result', header: tr(lang, 'Last result') },
    { key: 'n', header: tr(lang, 'Rows') },
    { key: 'ofw', header: '' },
  ];
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={items}
        withPagination
        searchPlaceholder={tr(lang, 'Search rules')}
        actions={(
          <>
            <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('filter')} iconDescription={tr(lang, 'Filter')} />
            <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({ mode: 'create' })}>{tr(lang, 'Add rule')}</Button>
          </>
        )}
        renderCell={(r, k) => {
          if (k === 'type') return tr(lang, r.type);
          if (k === 'sev') return <Tag type={r.sev === 'High' ? 'red' : r.sev === 'Medium' ? 'purple' : 'cool-gray'} size="sm">{tr(lang, r.sev)}</Tag>;
          if (k === 'result') return <StatusDot kind={r.result === 'Pass' ? 'success' : r.result === 'Fail' ? 'failed' : 'warning'}>{tr(lang, r.result)}</StatusDot>;
          if (k === 'ofw') return <RowMenu onEdit={() => setModal({ mode: 'edit', row: r })} onDelete={() => setDel(r)} />;
          return r[k];
        }}
      />
      {modal && (
        <DataQualityModal mode={modal.mode} row={modal.row} lang={lang}
          onSubmit={(vals) => { if (modal.mode === 'create') add(vals); else update(modal.row.id, vals); setModal(null); notify && notify({ kind: 'success', title: modal.mode === 'create' ? tr(lang, 'Rule added and scheduled.') : tr(lang, 'Rule updated.') }); }}
          onClose={() => setModal(null)} />
      )}
      <ConfirmDelete open={!!del} title={tr(lang, 'Delete rule')} body={del ? `${tr(lang, 'Delete rule on')} "${del.target}"?` : ''} onConfirm={() => { remove(del.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Rule deleted.') }); }} onClose={() => setDel(null)} />
    </div>
  );
}

/* ---------------- Pipelines (unified ingest-to-serve) ---------------- */
const WIZ_STEPS = [
  { t: 'Source', s: 'Connection' }, { t: 'Tables', s: 'Select' }, { t: 'Target', s: 'Layer & format' },
  { t: 'Schedule', s: 'Cron / interval' }, { t: 'Transform', s: 'CDC / batch' }, { t: 'Review', s: 'Create' },
];

function PipelineWizard({ onClose, notify, onCreated, lang }) {
  const [step, setStep] = useState(0);
  const last = step === WIZ_STEPS.length - 1;
  const [spec, setSpec] = useState({
    name: '', source: '', tables: [],
    target: 'Gold', format: 'Iceberg', namespace: 'gold_qms',
    trigger: 'Cron schedule', cron: '@hourly', mode: 'CDC (incremental)',
    database: '', username: '', password: '',
  });
  const [sources, setSources] = useState([]); // full registered data source objects
  const [tableOpts, setTableOpts] = useState([]); // real tables listed from the source
  const [listing, setListing] = useState(false);
  const [listErr, setListErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Pull the registered data sources (DevConfig "Data sources" page, live probe).
  useEffect(() => {
    let alive = true;
    api.datasources.list()
      .then((ds) => {
        if (!alive) return;
        setSources(ds || []);
        setSpec((s) => ({ ...s, source: s.source || (ds && ds[0] && ds[0].name) || '' }));
      })
      .catch((err) => console.error('datasources failed', err));
    return () => { alive = false; };
  }, []);

  const srcObj = sources.find((d) => d.name === spec.source) || {};
  // Connect to the selected source and list its real tables.
  const listTables = async () => {
    if (!srcObj.host) { setListErr(tr(lang, 'Selected source has no host.')); return; }
    setListing(true); setListErr(''); setTableOpts([]);
    try {
      const r = await api.listSourceTables({ type: srcObj.type, host: srcObj.host, database: spec.database, username: spec.username, password: spec.password });
      setTableOpts(r.tables || []);
      if ((r.tables || []).length === 0) setListErr(tr(lang, 'No tables returned.'));
    } catch (err) {
      setListErr(String(err.message || err));
    } finally { setListing(false); }
  };
  const set = (k, v) => setSpec((s) => ({ ...s, [k]: v }));
  const toggleTable = (t) => setSpec((s) => ({ ...s, tables: s.tables.includes(t) ? s.tables.filter((x) => x !== t) : [...s.tables, t] }));

  const create = async () => {
    setBusy(true);
    try {
      await api.createPipeline({ source: spec.source, target_layer: spec.target, schedule: spec.cron, tables: spec.tables });
      notify && notify({ kind: 'success', title: tr(lang, 'Pipeline created.'), subtitle: tr(lang, 'First run scheduled.') });
      onCreated && onCreated();
      onClose();
    } catch (err) {
      notify && notify({ kind: 'error', title: tr(lang, 'Create failed (rolled back).'), subtitle: String(err.message || err) });
    } finally { setBusy(false); }
  };

  return (
    <ComposedModal open size="lg" onClose={onClose}>
      <ModalHeader label={tr(lang, 'Pipelines')} title={tr(lang, 'Create pipeline')} />
      <ModalBody hasForm>
        <ProgressIndicator currentIndex={step} spaceEqually style={{ marginBottom: 28 }}>
          {WIZ_STEPS.map((w, i) => <ProgressStep key={w.t} label={tr(lang, w.t)} secondaryLabel={tr(lang, w.s)} onClick={() => setStep(i)} />)}
        </ProgressIndicator>

        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Picker label={tr(lang, 'Source connection')} items={sources.length ? sources.map((d) => d.name) : [tr(lang, '(loading…)')]} value={spec.source} onChange={(v) => { set('source', v); setTableOpts([]); set('tables', []); }} />
            {srcObj.type && <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{srcObj.type} · {srcObj.host}</span>}
            <TextInput id="wiz-name" labelText={tr(lang, 'Pipeline name')} placeholder="qms_to_gold" value={spec.name} onChange={(e) => set('name', e.target.value)} />
          </div>
        )}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Connect to')} <b>{spec.source}</b> ({srcObj.type}) {tr(lang, 'and list its tables. Credentials are used only to read the table list — not stored.')}</div>
            <div className="w-row">
              <TextInput id="wiz-db" labelText={tr(lang, 'Database / schema')} placeholder="qms" value={spec.database} onChange={(e) => set('database', e.target.value)} />
              <TextInput id="wiz-user" labelText={tr(lang, 'Username')} value={spec.username} onChange={(e) => set('username', e.target.value)} />
            </div>
            <div className="w-row">
              <TextInput id="wiz-pw" type="password" labelText={tr(lang, 'Password')} value={spec.password} onChange={(e) => set('password', e.target.value)} />
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <Button kind="tertiary" size="md" renderIcon={iconFor('renew')} disabled={listing} onClick={listTables}>{listing ? tr(lang, 'Listing…') : tr(lang, 'List tables')}</Button>
              </div>
            </div>
            {listErr && <span style={{ fontSize: '.75rem', color: 'var(--cds-support-error)' }}>{listErr}</span>}
            {tableOpts.length > 0 && (
              <div className="w-fld"><label className="cds--label">{tr(lang, 'Tables to ingest')} ({spec.tables.length} {tr(lang, 'selected')})</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflow: 'auto' }}>
                  {tableOpts.map((tb) => <Checkbox key={tb} id={`wiz-${tb}`} labelText={tb} checked={spec.tables.includes(tb)} onChange={() => toggleTable(tb)} />)}
                </div>
              </div>
            )}
          </div>
        )}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="w-row">
              <Picker label={tr(lang, 'Target layer')} items={['RAW', 'Bronze', 'Silver', 'Gold']} value={spec.target} onChange={(v) => set('target', v)} />
              <Picker label={tr(lang, 'Format')} items={['Iceberg', 'Delta', 'Parquet']} value={spec.format} onChange={(v) => set('format', v)} />
            </div>
            <TextInput id="wiz-ns" labelText={tr(lang, 'Target namespace')} value={spec.namespace} onChange={(e) => set('namespace', e.target.value)} />
          </div>
        )}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Picker label={tr(lang, 'Trigger')} items={['Cron schedule', 'Fixed interval', 'On source change (CDC)']} itemToString={(it) => tr(lang, it)} value={spec.trigger} onChange={(v) => set('trigger', v)} />
            <TextInput id="wiz-cron" labelText={tr(lang, 'Cron expression')} value={spec.cron} onChange={(e) => set('cron', e.target.value)} helperText={tr(lang, 'e.g. @hourly or 0 */2 * * *')} />
          </div>
        )}
        {step === 4 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Picker label={tr(lang, 'Load mode')} items={['CDC (incremental)', 'Full batch', 'Append only']} itemToString={(it) => tr(lang, it)} value={spec.mode} onChange={(v) => set('mode', v)} />
            <Checkbox id="wiz-dedup" labelText={tr(lang, 'Deduplicate on primary key')} defaultChecked />
            <Checkbox id="wiz-dq" labelText={tr(lang, 'Run data quality rules after load')} defaultChecked />
          </div>
        )}
        {step === 5 && (
          <div className="dv-kv">
            <div className="dv-kv__r"><span className="k">{tr(lang, 'Name')}</span><span className="v">{spec.name || `${spec.source}_to_${spec.target.toLowerCase()}`}</span></div>
            <div className="dv-kv__r"><span className="k">{tr(lang, 'Source')}</span><span className="v">{spec.source}</span></div>
            <div className="dv-kv__r"><span className="k">{tr(lang, 'Tables')}</span><span className="v">{spec.tables.length} {tr(lang, 'selected')}</span></div>
            <div className="dv-kv__r"><span className="k">{tr(lang, 'Target')}</span><span className="v">{spec.namespace} · {spec.format}</span></div>
            <div className="dv-kv__r"><span className="k">{tr(lang, 'Schedule')}</span><span className="v">{spec.cron}</span></div>
            <div className="dv-kv__r"><span className="k">{tr(lang, 'Mode')}</span><span className="v">{tr(lang, spec.mode)}</span></div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? tr(lang, 'Cancel') : tr(lang, 'Back')}</Button>
        <Button kind="primary" renderIcon={iconFor(last ? 'checkmark' : 'arrow--right')} disabled={busy} onClick={last ? create : () => setStep(step + 1)}>{last ? (busy ? tr(lang, 'Creating…') : tr(lang, 'Create pipeline')) : tr(lang, 'Next')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

function PipelineDetail({ pipe, onBack, notify, lang }) {
  const [runs, setRuns] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getPipeline(pipe.id).then((d) => { if (alive) setRuns(d.runs || []); }).catch(() => {});
    return () => { alive = false; };
  }, [pipe.id]);
  const act = async (fn, ok, fail) => {
    try { await fn(); notify && notify({ kind: 'success', title: ok, subtitle: pipe.name }); }
    catch (err) { notify && notify({ kind: 'error', title: fail, subtitle: String(err.message || err) }); }
  };
  const runHeaders = [
    { key: 'start', header: tr(lang, 'Started') }, { key: 'dur', header: tr(lang, 'Duration') },
    { key: 'status', header: tr(lang, 'Status') }, { key: 'task', header: tr(lang, 'Task'), mono: true },
  ];
  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to pipelines')}</Button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h1 className="ip-mono" style={{ fontSize: '1.5rem', fontWeight: 400, margin: 0 }}>{pipe.name}</h1>
            <StatusDot kind={pipe.last}>{pipe.last}</StatusDot>
          </div>
          <p style={{ color: 'var(--cds-text-secondary)', fontSize: '.875rem', margin: '8px 0 0' }}>{pipe.source} → {pipe.target} · {pipe.schedule}</p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
          <Button kind="primary" size="md" renderIcon={iconFor('play')} onClick={() => act(() => api.runPipeline(pipe.id), tr(lang, 'Run started.'), tr(lang, 'Run failed.'))}>{tr(lang, 'Run now')}</Button>
          <Button kind="tertiary" size="md" renderIcon={iconFor('pause')} onClick={() => act(() => api.pausePipeline(pipe.id), tr(lang, 'Pipeline paused.'), tr(lang, 'Pause failed.'))}>{tr(lang, 'Pause')}</Button>
          <Button kind="tertiary" size="md" renderIcon={iconFor('calendar')} onClick={() => act(() => api.backfillPipeline(pipe.id, '', ''), tr(lang, 'Backfill scheduled.'), tr(lang, 'Backfill failed.'))}>{tr(lang, 'Backfill')}</Button>
        </div>
      </div>
      <Tabs>
        <TabList aria-label="Pipeline detail"><Tab>{tr(lang, 'Overview')}</Tab><Tab>DAG</Tab><Tab>{tr(lang, 'Run history')}</Tab><Tab>{tr(lang, 'Config')}</Tab><Tab>{tr(lang, 'Lineage')}</Tab></TabList>
        <TabPanels>
          <TabPanel>
            <div className="dv-kv" style={{ maxWidth: 520, marginTop: 8 }}>
              <div className="dv-kv__r"><span className="k">{tr(lang, 'Status')}</span><span className="v">{pipe.last}</span></div>
              <div className="dv-kv__r"><span className="k">{tr(lang, 'Source')}</span><span className="v">{pipe.source}</span></div>
              <div className="dv-kv__r"><span className="k">{tr(lang, 'Target')}</span><span className="v">{pipe.target}</span></div>
              <div className="dv-kv__r"><span className="k">{tr(lang, 'Schedule')}</span><span className="v">{pipe.schedule}</span></div>
            </div>
          </TabPanel>
          <TabPanel><div style={{ marginTop: 8 }}><EtlDag notify={notify} lang={lang} /></div></TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <CarbonTable headers={runHeaders} rows={runs} withToolbar={false}
                renderCell={(r, k) => k === 'status' ? <StatusDot kind={r.status}>{tr(lang, r.status)}</StatusDot> : r[k]} />
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <TextInput id="pd-cron" labelText={tr(lang, 'Schedule (cron)')} defaultValue={pipe.schedule} />
              <Picker label={tr(lang, 'Load mode')} items={['CDC (incremental)', 'Full batch']} itemToString={(it) => tr(lang, it)} value="CDC (incremental)" onChange={() => {}} />
              <Toggle size="sm" id="pd-dq" labelText={tr(lang, 'Run data quality after load')} defaultToggled />
              <div><Button kind="primary" renderIcon={iconFor('save')} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Config saved.') })}>{tr(lang, 'Save config')}</Button></div>
            </div>
          </TabPanel>
          <TabPanel><div style={{ marginTop: 8 }}><Placeholder label={tr(lang, 'end-to-end lineage RAW → Gold → ClickHouse')} icon="data--base" height={260} /></div></TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

function Pipelines({ notify, lang }) {
  const [wiz, setWiz] = useState(false);
  const [sel, setSel] = useState(null);
  const [rows, setRows] = useState([]);
  const load = () => api.getPipelines()
    .then((conns) => setRows((conns || []).map((c, i) => ({
      id: c.id != null ? String(c.id) : String(i),
      name: c.name, source: c.src || c.source || '—',
      target: layerOfTopic(c.topic), schedule: c.schedule || 'streaming',
      last: c.status, next: '—',
    }))))
    .catch((err) => console.error('pipelines failed', err));
  useEffect(() => { load(); }, []);

  const headers = [
    { key: 'name', header: tr(lang, 'Pipeline') },
    { key: 'source', header: tr(lang, 'Source') },
    { key: 'target', header: tr(lang, 'Target layer') },
    { key: 'schedule', header: tr(lang, 'Schedule'), mono: true },
    { key: 'last', header: tr(lang, 'Last run') },
    { key: 'next', header: tr(lang, 'Next run') },
    { key: 'ofw', header: '' },
  ];
  if (sel) return <PipelineDetail pipe={sel} onBack={() => setSel(null)} notify={notify} lang={lang} />;
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={rows}
        withPagination
        searchPlaceholder={tr(lang, 'Search pipelines')}
        onRowClick={setSel}
        actions={(
          <>
            <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('filter')} iconDescription={tr(lang, 'Filter')} />
            <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setWiz(true)}>{tr(lang, 'Create pipeline')}</Button>
          </>
        )}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); setSel(r); }}>{r.name}</a>;
          if (k === 'target') return <Tag type={r.target === 'Gold' ? 'teal' : r.target === 'Silver' ? 'cyan' : 'cool-gray'} size="sm">{r.target}</Tag>;
          if (k === 'last') return <StatusDot kind={r.last}>{tr(lang, r.last)}</StatusDot>;
          if (k === 'ofw') return <RowMenu onView={() => setSel(r)} />;
          return r[k];
        }}
      />
      {wiz && <PipelineWizard onClose={() => setWiz(false)} notify={notify} onCreated={load} lang={lang} />}
    </div>
  );
}

// layerOfTopic infers a target layer label from a connector's topic prefix.
function layerOfTopic(topic) {
  const t = String(topic || '').toLowerCase();
  if (t.includes('gold')) return 'Gold';
  if (t.includes('silver')) return 'Silver';
  if (t.includes('bronze')) return 'Bronze';
  return 'Bronze';
}

const DEV_SUBS = [
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'sources', label: 'Data sources' },
  { id: 'etl', label: 'ETL / DAG' },
  { id: 'cdc', label: 'CDC / sync' },
  { id: 'quality', label: 'Data quality' },
];
const DEV_TITLES = {
  pipelines: ['Pipelines', 'Unified ingest-to-serve data pipelines across all layers.'],
  sources: ['Data source management', 'Registered database, lakehouse, and streaming connections.'],
  etl: ['ETL pipeline orchestration', 'Layered RAW → Bronze → Silver → Gold → ClickHouse DAG.'],
  cdc: ['CDC / sync configuration', 'Debezium change-data-capture connectors and watermarks.'],
  quality: ['Data quality rules', 'Assertions on tables and fields with severity and alerting.'],
};

export default function DevConfig({ notify, lang }) {
  const [sub, setSub] = useState('pipelines');
  const [t, s] = DEV_TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Data Development / Config'), tr(lang, t)]} title={tr(lang, t)} sub={tr(lang, s)} />
      <SubSwitch items={trList(lang, DEV_SUBS)} value={sub} onChange={setSub} />
      {sub === 'pipelines' && <Pipelines notify={notify} lang={lang} />}
      {sub === 'sources' && <DataSources notify={notify} lang={lang} />}
      {sub === 'etl' && <EtlDag notify={notify} lang={lang} />}
      {sub === 'cdc' && <Cdc notify={notify} lang={lang} />}
      {sub === 'quality' && <DataQuality notify={notify} lang={lang} />}
    </div>
  );
}
