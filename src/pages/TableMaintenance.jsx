import { useState, useEffect } from 'react';
import {
  Button, Tag, TextInput, InlineNotification, Tile, Select, SelectItem,
  Tabs, TabList, Tab, TabPanels, TabPanel,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, CarbonTable, StatusDot } from '../components/shared.jsx';
import * as api from '../data/api.js';
import { tr } from '../i18n.js';

/* Table Maintenance (§17.2): self-service Iceberg table maintenance (optimize /
   expire_snapshots / remove_orphan_files / rewrite_manifests) + ETL watermark
   management. Operations run async via Trino EXECUTE and are job-tracked. */

const OPS = [
  { id: 'optimize', nm: 'Compaction', cmd: 'OPTIMIZE', dc: 'Merge small files into right-sized data files.' },
  { id: 'expire_snapshots', nm: 'Expire snapshots', cmd: 'expire_snapshots', dc: 'Remove snapshots older than the retention period to reclaim storage.' },
  { id: 'remove_orphan_files', nm: 'Remove orphan files', cmd: 'remove_orphan_files', dc: 'Delete files no longer referenced by any snapshot.' },
  { id: 'rewrite_manifests', nm: 'Rewrite manifests', cmd: 'rewrite_manifests', dc: 'Rebuild manifests to speed planning on partitioned tables.' },
];

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v > 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v > 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  return `${v}`;
}

/* A maintenance operation card. The Run button sits flush in the bottom-right
   corner with the primary style. */
function MaintOp({ op, table, onRan, notify, lang }) {
  const [state, setState] = useState('idle');
  const run = async () => {
    setState('running');
    try {
      const [ns, t] = table.split('.');
      await api.runMaintenance(ns, t, op.id);
      setState('done');
      notify && notify({ kind: 'success', title: `${tr(lang, op.nm)} ${tr(lang, 'started')}`, subtitle: table });
      onRan();
    } catch (err) {
      setState('idle');
      notify && notify({ kind: 'error', title: tr(lang, 'Operation failed.'), subtitle: (err.detail || String(err.message || err)) });
    }
  };
  return (
    <Tile style={{ position: 'relative', minHeight: 140, paddingBottom: 56 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: '.9375rem', fontWeight: 600 }}>{tr(lang, op.nm)}</span>
        <Tag type="cool-gray" size="sm" className="ip-mono" style={{ marginLeft: 'auto' }}>{op.cmd}</Tag>
      </div>
      <p style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', margin: 0, lineHeight: 1.45 }}>{tr(lang, op.dc)}</p>
      {state === 'running' && <div style={{ position: 'absolute', left: 16, bottom: 16 }}><StatusDot kind="syncing">{tr(lang, 'Running…')}</StatusDot></div>}
      {state === 'done' && <div style={{ position: 'absolute', left: 16, bottom: 16 }}><StatusDot kind="success">{tr(lang, 'Job submitted')}</StatusDot></div>}
      <Button kind="primary" size="md" renderIcon={iconFor('play')} disabled={state === 'running'}
        style={{ position: 'absolute', right: 0, bottom: 0 }} onClick={run}>{tr(lang, 'Run')}</Button>
    </Tile>
  );
}

function MaintenanceTab({ tables, notify, lang }) {
  const [table, setTable] = useState('');
  const [health, setHealth] = useState(null);
  const [jobs, setJobs] = useState([]);

  useEffect(() => { if (!table && tables.length) setTable(tables[0]); }, [tables]);

  const refresh = () => {
    if (!table) return;
    const [ns, t] = table.split('.');
    api.tableHealth(ns, t).then(setHealth).catch(() => setHealth(null));
    api.getMaintenanceJobs(ns, t).then((r) => setJobs(r || [])).catch(() => setJobs([]));
  };
  useEffect(refresh, [table]);

  const small = health ? Number(health.small_files || 0) : 0;
  const files = health ? Number(health.file_count || 0) : 0;
  const ratio = files ? Math.round((small / files) * 100) : 0;

  return (
    <div>
      <div style={{ maxWidth: 360, marginBottom: 16 }}>
        <Select id="tm-table" labelText={tr(lang, 'Table')} value={table} onChange={(e) => setTable(e.target.value)}>
          {tables.length === 0 && <SelectItem value="" text={tr(lang, '(loading…)')} />}
          {tables.map((t) => <SelectItem key={t} value={t} text={t} />)}
        </Select>
      </div>

      <div className="w-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 24 }}>
        <div className="s"><div className="k"><Icon name="document" size={16} />{tr(lang, 'Data files')}</div><div className="v">{health ? files : '—'}</div></div>
        <div className="s"><div className="k"><Icon name="warning--alt" size={16} />{tr(lang, 'Small-file ratio')}</div><div className="v" style={ratio > 40 ? { color: 'var(--cds-support-warning)' } : undefined}>{health ? `${ratio}%` : '—'}</div><div className="d">{health ? `${small} ${tr(lang, 'small files')}` : ''}</div></div>
        <div className="s"><div className="k"><Icon name="time" size={16} />{tr(lang, 'Snapshots')}</div><div className="v">{health ? (health.snapshot_count ?? '—') : '—'}</div><div className="d">{health && health.oldest_snapshot ? `${tr(lang, 'oldest')} ${health.oldest_snapshot}` : ''}</div></div>
        <div className="s"><div className="k"><Icon name="cloud" size={16} />{tr(lang, 'Storage')}</div><div className="v">{health ? fmtBytes(health.total_bytes) : '—'}</div></div>
      </div>

      <div className="w-section-label">{tr(lang, 'Maintenance operations')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {OPS.map((op) => <MaintOp key={op.id} op={op} table={table} onRan={refresh} notify={notify} lang={lang} />)}
      </div>

      <div className="w-section-label">{tr(lang, 'Maintenance history')}</div>
      <CarbonTable
        headers={[
          { key: 'op', header: tr(lang, 'Operation') }, { key: 'table', header: tr(lang, 'Table'), mono: true },
          { key: 'started_at', header: tr(lang, 'Started'), mono: true }, { key: 'result', header: tr(lang, 'Result') }, { key: 'status', header: tr(lang, 'Status') },
        ]}
        rows={jobs.map((j, i) => ({ id: j.job_id || String(i), op: j.op, table: `${j.ns}.${j.table}`, started_at: j.started_at, result: j.result, status: j.status }))}
        withPagination
        searchPlaceholder={tr(lang, 'Search maintenance history')}
        actions={<Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('renew')} iconDescription={tr(lang, 'Refresh metrics')} onClick={refresh} />}
        renderCell={(r, k) => k === 'status'
          ? <StatusDot kind={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'failed' : 'syncing'}>{tr(lang, r.status)}</StatusDot>
          : (r[k] || '—')} />
    </div>
  );
}

function WatermarkTab({ tables, notify, lang }) {
  const [table, setTable] = useState('');
  const [data, setData] = useState({ columns: [], rows: [] });
  const [reset, setReset] = useState(null);
  const [confirm, setConfirm] = useState('');

  useEffect(() => { if (!table && tables.length) setTable(tables[0]); }, [tables]);

  const load = () => {
    if (!table) return;
    const [ns, t] = table.split('.');
    api.getWatermarks(ns, t).then((d) => setData(d || { columns: [], rows: [] })).catch(() => setData({ columns: [], rows: [] }));
  };
  useEffect(load, [table]);

  const doReset = async () => {
    const [ns, t] = table.split('.');
    try { await api.resetWatermark(ns, t, { confirm: true }); setReset(null); notify && notify({ kind: 'warning', title: tr(lang, 'Watermark reset'), subtitle: tr(lang, 'The ETL will re-process from the start on its next run.') }); load(); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Reset failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  const headers = (data.columns || []).map((c) => ({ key: c.key || c.name, header: c.header || c.name, mono: true }));
  return (
    <div>
      <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Watermarks track ETL incremental progress')}
        subtitle={tr(lang, 'A full reload requires resetting watermarks and back-filling in ascending order. Reset is high-risk.')} />
      <CarbonTable
        headers={headers.length ? headers : [{ key: '_', header: tr(lang, 'No watermark rows') }]}
        rows={(data.rows || []).map((r, i) => ({ id: String(i), ...r }))}
        searchPlaceholder={tr(lang, 'Search watermark rows')}
        filters={[{ items: tables.length ? tables : [tr(lang, '(loading…)')], value: table, onChange: setTable }]}
        actions={<Button kind="danger" size="lg" renderIcon={iconFor('restart')} onClick={() => { setReset(table); setConfirm(''); }}>{tr(lang, 'Reset watermark')}</Button>}
        renderCell={(r, k) => <span className="ip-mono" style={{ fontSize: '.8125rem' }}>{String(r[k] ?? '')}</span>} />

      {reset && (
        <ComposedModal open size="sm" onClose={() => setReset(null)}>
          <ModalHeader label={tr(lang, 'High-risk operation')} title={tr(lang, 'Reset watermark')} />
          <ModalBody hasForm>
            <InlineNotification kind="error" lowContrast hideCloseButton title={tr(lang, 'This forces a full re-process')}
              subtitle={tr(lang, 'Resetting can be expensive and may temporarily double-write partitions.')} />
            <TextInput id="wm-confirm" labelText={`${tr(lang, 'Type the table name to confirm')}: ${reset}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={reset} />
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" onClick={() => setReset(null)}>{tr(lang, 'Cancel')}</Button>
            <Button kind="danger" renderIcon={iconFor('restart')} disabled={confirm !== reset} onClick={doReset}>{tr(lang, 'Reset watermark')}</Button>
          </ModalFooter>
        </ComposedModal>
      )}
    </div>
  );
}

/* Body — internal maintenance/watermarks tabs, no page chrome. Embedded under
   Monitoring & Ops which supplies the PageHeader + SubSwitch. */
export function TableMaintenanceBody({ notify, lang }) {
  const [tables, setTables] = useState([]);
  useEffect(() => {
    api.getDatasets().then((ts) => setTables((ts || []).map((t) => `${t.namespace}.${t.name}`))).catch(() => setTables([]));
  }, []);
  return (
    <Tabs>
      <TabList aria-label="Table maintenance">
        <Tab>{tr(lang, 'Iceberg maintenance')}</Tab>
        <Tab>{tr(lang, 'Watermarks')}</Tab>
      </TabList>
      <TabPanels>
        <TabPanel><div style={{ marginTop: 8 }}><MaintenanceTab tables={tables} notify={notify} lang={lang} /></div></TabPanel>
        <TabPanel><div style={{ marginTop: 8 }}><WatermarkTab tables={tables} notify={notify} lang={lang} /></div></TabPanel>
      </TabPanels>
    </Tabs>
  );
}

export default function TableMaintenance({ notify, lang }) {
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Monitoring & Ops'), tr(lang, 'Table Maintenance')]} title={tr(lang, 'Table Maintenance')}
        sub={tr(lang, 'Self-service Iceberg table maintenance and ETL watermark management.')} />
      <TableMaintenanceBody notify={notify} lang={lang} />
    </div>
  );
}
