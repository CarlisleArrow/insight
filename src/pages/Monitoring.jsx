import { useState, useEffect, useCallback } from 'react';
import { Button } from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { Picker } from '../components/inputs.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot, RowMenu, SidePanel } from '../components/shared.jsx';
import { BarChart, TrendLine } from '../components/Charts.jsx';
import { useCollection } from '../data/DataProvider.jsx';
import * as api from '../data/api.js';
import { RAG_COLOR } from '../data/mockData.js';
import { tr, trList } from '../i18n.js';
import { TableMaintenanceBody } from './TableMaintenance.jsx';
import { DataPatchBody } from './DataPatch.jsx';

/* Live run-status summary cards, derived from GET /api/ops/runs `stats`. */
const STAT_CARDS = [
  { key: 'Running', label: 'Running', tone: 'run', icon: 'renew' },
  { key: 'Success', label: 'Success', tone: 'ok', icon: 'checkmark--filled' },
  { key: 'Failed', label: 'Failed', tone: 'fail', icon: 'error--filled' },
  { key: 'Retrying', label: 'Retrying', tone: 'retry', icon: 'warning--filled' },
];

/* ---------------- Task monitoring ---------------- */
function TaskMonitoring({ notify, lang }) {
  const { items, update, set } = useCollection('runs');
  const [status, setStatus] = useState('All status');
  const [logRun, setLogRun] = useState(null);
  const [stats, setStats] = useState({ Running: 0, Success: 0, Failed: 0, Retrying: 0 });

  const refresh = useCallback(async () => {
    try {
      const resp = await api.getOpsRuns();
      set((resp.runs || []).map((r, i) => ({ ...r, id: String(r.id != null ? r.id : i) })));
      setStats(resp.stats || {});
      notify && notify({ kind: 'info', title: tr(lang, 'Runs refreshed.') });
    } catch (err) {
      notify && notify({ kind: 'error', title: tr(lang, 'Refresh failed.'), subtitle: String(err.message || err) });
    }
  }, [set, notify, lang]);

  // Load the status roll-up once on mount (the runs list is hydrated globally).
  useEffect(() => {
    let alive = true;
    api.getOpsRuns().then((resp) => { if (alive) setStats(resp.stats || {}); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const rows = status === 'All status' ? items : items.filter((r) => r.status === status);
  const headers = [
    { key: 'dag', header: 'DAG', mono: true },
    { key: 'task', header: tr(lang, 'Task'), mono: true },
    { key: 'start', header: tr(lang, 'Started') },
    { key: 'dur', header: tr(lang, 'Duration') },
    { key: 'status', header: tr(lang, 'Status') },
    { key: 'logs', header: tr(lang, 'Logs') },
    { key: 'act', header: '' },
  ];
  const retry = (r) => { update(r.id, { status: 'Running', dur: 'running' }); notify && notify({ kind: 'info', title: `${tr(lang, 'Retrying')} ${r.task}…` }); };
  return (
    <div>
      <div className="mn-cards">
        {STAT_CARDS.map((s) => (
          <div className="mn-card" key={s.key}>
            <div className="k"><Icon name={s.icon} size={16} />{tr(lang, s.label)}</div>
            <div className={`v ${s.tone}`}>{stats[s.key] ?? 0}</div>
          </div>
        ))}
      </div>
      <CarbonTable
        headers={headers}
        rows={rows}
        withPagination
        searchPlaceholder={tr(lang, 'Search runs by DAG or task')}
        actions={(
          <>
            <Picker
              items={['All status', 'Running', 'Failed', 'Retrying', 'Success']}
              itemToString={(it) => tr(lang, it)}
              value={status}
              onChange={setStatus}
            />
            <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('renew')} iconDescription={tr(lang, 'Refresh')} onClick={refresh} />
          </>
        )}
        renderCell={(r, k) => {
          if (k === 'status') return <StatusDot kind={r.status}>{tr(lang, r.status)}</StatusDot>;
          if (k === 'logs') return <a href="#" onClick={(e) => { e.preventDefault(); setLogRun(r); }} style={{ color: 'var(--cds-link-primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="document" size={16} />ELK</a>;
          if (k === 'act') return (r.status === 'Failed' || r.status === 'Retrying')
            ? <Button kind="ghost" size="sm" renderIcon={iconFor('renew')} onClick={() => retry(r)}>{tr(lang, 'Retry')}</Button>
            : <RowMenu onView={() => setLogRun(r)} items={undefined} />;
          return r[k];
        }}
      />
      {logRun && (
        <SidePanel sup={tr(lang, 'ELK logs')} title={`${logRun.dag} · ${logRun.task}`} width={520} onClose={() => setLogRun(null)} footer={<Button kind="secondary" onClick={() => setLogRun(null)}>{tr(lang, 'Close')}</Button>}>
          <StatusDot kind={logRun.status}>{tr(lang, logRun.status)} · {tr(lang, 'started')} {logRun.start} · {logRun.dur}</StatusDot>
          <div className="ip-mono" style={{ fontSize: '.75rem', background: 'var(--cds-gray-100)', color: '#f4f4f4', padding: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {`[${logRun.start}:01] INFO  Task ${logRun.task} started\n[${logRun.start}:02] INFO  Acquiring pool slot: transform\n[${logRun.start}:03] INFO  Executing operator\n${logRun.status === 'Failed' ? `[${logRun.start}:59] ERROR Connection refused (SQLSTATE 08001)\n[${logRun.start}:59] ERROR Task ${logRun.task} failed` : `[${logRun.start}:59] INFO  Task ${logRun.task} ${logRun.status.toLowerCase()}`}`}
          </div>
        </SidePanel>
      )}
    </div>
  );
}

/* ---------------- Resource & SLA ---------------- */
function Rag({ s, t }) { return <span className="mn-rag"><span className="sq" style={{ background: RAG_COLOR[s] }} />{t}</span>; }
function GrafanaBadge({ tone = 'var(--cds-support-success)' }) { return <span className="badge"><span style={{ width: 8, height: 8, borderRadius: '50%', background: tone }} />Grafana</span>; }

// Resource panels — PromQL range queries (KubeSphere node-exporter / cadvisor).
// Tune these to the cluster's actual exporters if a panel comes back empty.
const RESOURCE_PANELS = {
  cpu: { group: 'CPU', promql: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)' },
  spark: { group: 'Cores', promql: 'sum(rate(container_cpu_usage_seconds_total{namespace="spark"}[5m]))' },
  ch: { group: 'p95 (ms)', promql: 'sum(rate(container_cpu_usage_seconds_total{namespace="default",pod=~"clickhouse.*"}[5m]))' },
  ingest: { group: 'Events', promql: 'sum(rate(container_network_receive_bytes_total{namespace="kafka"}[5m]))' },
};

function ResourceSla({ lang }) {
  // Per-pipeline SLA board from GET /api/ops/sla (derived from Airflow runs).
  const [sla, setSla] = useState([]);
  // Live resource time series from GET /api/ops/metrics/range.
  const [series, setSeries] = useState({ cpu: [], spark: [], ch: [], ingest: [] });
  useEffect(() => {
    let alive = true;
    api.getOpsSla().then((rows) => { if (alive) setSla(rows || []); }).catch((err) => console.error('sla failed', err));
    Object.entries(RESOURCE_PANELS).forEach(([key, { group, promql }]) => {
      api.getOpsMetricsRange(promql)
        .then((pts) => { if (alive) setSeries((s) => ({ ...s, [key]: (pts || []).map((p) => ({ group, key: p.key, value: p.value })) })); })
        .catch((err) => console.error(`metric ${key} failed`, err));
    });
    return () => { alive = false; };
  }, []);
  return (
    <div>
      <div className="mn-grafana">
        <div className="mn-panel">
          <div className="mn-panel__h"><Icon name="dashboard" size={16} />Cluster CPU<GrafanaBadge /></div>
          <div className="mn-panel__b"><BarChart data={series.cpu} group="CPU" height={140} /><div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 8 }}>node CPU utilisation %</div></div>
        </div>
        <div className="mn-panel">
          <div className="mn-panel__h"><Icon name="watson" size={16} />Spark CPU (ns)<GrafanaBadge /></div>
          <div className="mn-panel__b"><TrendLine data={series.spark} group="Cores" height={140} /><div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 8 }}>spark namespace CPU cores</div></div>
        </div>
        <div className="mn-panel">
          <div className="mn-panel__h"><Icon name="data--base" size={16} />ClickHouse CPU<GrafanaBadge tone="var(--cds-support-warning)" /></div>
          <div className="mn-panel__b"><TrendLine data={series.ch} group="p95 (ms)" color="#f1c21b" height={140} /><div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 8 }}>clickhouse pod CPU cores</div></div>
        </div>
        <div className="mn-panel">
          <div className="mn-panel__h"><Icon name="chart--bar" size={16} />Kafka ingest (bytes/s)<GrafanaBadge /></div>
          <div className="mn-panel__b"><BarChart data={series.ingest} group="Events" height={140} /><div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 8 }}>kafka namespace network in</div></div>
        </div>
      </div>
      <div className="mn-panel">
        <div className="mn-panel__h"><Icon name="time" size={16} />{tr(lang, 'Data SLA board')}</div>
        <table className="mn-sla">
          <thead><tr><th>{tr(lang, 'Pipeline')}</th><th>{tr(lang, 'Freshness')}</th><th>{tr(lang, 'Timeliness')}</th><th>{tr(lang, 'Latency')}</th><th>{tr(lang, 'SLA')}</th></tr></thead>
          <tbody>
            {sla.map((r) => (
              <tr key={r.pipe}>
                <td className="pipe">{r.pipe}</td>
                <td><Rag s={r.fresh} t={r.freshT} /></td>
                <td><Rag s={r.time} t={r.timeT} /></td>
                <td><Rag s={r.lat} t={r.latT} /></td>
                <td>{(r.fresh === 'r' || r.time === 'r' || r.lat === 'r')
                  ? <span className="w-status"><span className="dot" style={{ background: 'var(--cds-support-error)' }} />{tr(lang, 'Breached')}</span>
                  : (r.fresh === 'a' || r.time === 'a' || r.lat === 'a')
                    ? <span className="w-status"><span className="dot" style={{ background: 'var(--cds-support-warning)' }} />{tr(lang, 'At risk')}</span>
                    : <span className="w-status"><span className="dot" style={{ background: 'var(--cds-support-success)' }} />{tr(lang, 'Met')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MON_SUBS = [
  { id: 'tasks', label: 'Task monitoring' },
  { id: 'sla', label: 'Resource & SLA' },
  { id: 'maint', label: 'Table Maintenance' },
  { id: 'patch', label: 'Data Patch' },
];
const TITLES = {
  tasks: ['Task monitoring', 'Live ETL run status with logs and failure recovery.'],
  sla: ['Resource & SLA monitoring', 'Cluster, Spark, and ClickHouse health plus per-pipeline data SLAs.'],
  maint: ['Table Maintenance', 'Self-service Iceberg table maintenance and ETL watermark management.'],
  patch: ['Data Patch', 'Row-level corrections to lakehouse data — approval-gated, snapshot-backed, fully audited.'],
};

export default function Monitoring({ notify, lang }) {
  const [sub, setSub] = useState('tasks');
  const [t, s] = TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Monitoring & Ops'), tr(lang, t)]} title={tr(lang, t)} sub={tr(lang, s)} />
      <SubSwitch items={trList(lang, MON_SUBS)} value={sub} onChange={setSub} />
      {sub === 'tasks' && <TaskMonitoring notify={notify} lang={lang} />}
      {sub === 'sla' && <ResourceSla lang={lang} />}
      {sub === 'maint' && <TableMaintenanceBody notify={notify} lang={lang} />}
      {sub === 'patch' && <DataPatchBody notify={notify} lang={lang} />}
    </div>
  );
}
