import { useState, useEffect } from 'react';
import {
  Button, Tag, TextInput, InlineNotification, Tile, Select, SelectItem,
  StructuredListWrapper, StructuredListBody, StructuredListRow, StructuredListCell,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { Picker } from '../components/inputs.jsx';
import { CarbonTable, StatusDot, RowMenu } from '../components/shared.jsx';
import * as api from '../data/api.js';
import { tr } from '../i18n.js';

/* Schema Changes (§17.1): propose/review/apply Iceberg schema changes.
   Compatible changes (add/rename/widen) execute immediately; breaking ones
   (drop/narrow) route to the approval queue with a DataHub impact analysis. */

const STATUS_KIND = { pending: 'amber', approved: 'blue', executed: 'success', rejected: 'failed', failed: 'failed' };
const OP_TAG = { add: 'green', rename: 'blue', widen: 'blue', drop: 'red', narrow: 'red' };
const DESTRUCTIVE = (op) => op === 'drop' || op === 'narrow';

function parse(j, def) { try { return JSON.parse(j); } catch { return def; } }

/* ---- change list (approvals of type schema_change) ---- */
function ChangeList({ rows, onOpen, onNew, onRefresh, lang }) {
  return (
    <CarbonTable
      headers={[
        { key: 'target', header: tr(lang, 'Target table'), mono: true },
        { key: 'op', header: tr(lang, 'Change type') },
        { key: 'compat', header: tr(lang, 'Compatibility') },
        { key: 'status', header: tr(lang, 'Status') },
        { key: 'requester', header: tr(lang, 'Requester') },
        { key: 'ofw', header: '' },
      ]}
      rows={rows}
      withPagination
      searchPlaceholder={tr(lang, 'Search by table or requester')}
      onRowClick={onOpen}
      actions={(
        <>
          <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('renew')} iconDescription={tr(lang, 'Refresh')} onClick={onRefresh} />
          <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={onNew}>{tr(lang, 'New change')}</Button>
        </>
      )}
      renderCell={(r, k) => {
        const op = parse(r.diff, {}).op || '';
        if (k === 'op') return <Tag type={OP_TAG[op] || 'cool-gray'} size="sm">{tr(lang, op || 'change')}</Tag>;
        if (k === 'compat') return <Tag type={DESTRUCTIVE(op) ? 'red' : 'green'} size="sm">{DESTRUCTIVE(op) ? tr(lang, 'Breaking') : tr(lang, 'Compatible')}</Tag>;
        if (k === 'status') return <StatusDot kind={STATUS_KIND[r.status] || 'gray'}>{tr(lang, r.status)}</StatusDot>;
        if (k === 'ofw') return <RowMenu onView={() => onOpen(r)} />;
        return r[k] || '—';
      }} />
  );
}

/* ---- new schema change editor ---- */
function SchemaEditor({ tables, onBack, onDone, notify, lang }) {
  const [target, setTarget] = useState(tables[0] || '');
  const [op, setOp] = useState({ op: 'add', column: '', data_type: 'integer', new_name: '', reason: '' });
  const [diff, setDiff] = useState(null);
  const breaking = DESTRUCTIVE(op.op);
  const set = (k, v) => setOp((o) => ({ ...o, [k]: v }));
  const [ns, table] = target.split('.');

  const runDiff = async () => {
    try {
      // ask the backend for the live column set; render the proposed target locally
      const d = await api.schemaDiff(ns, table, { columns: [{ name: op.column, type: op.data_type }] });
      setDiff(d);
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Diff failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  const submit = async () => {
    try {
      const r = await api.schemaAlter(ns, table, op);
      if (r.status === 'pending_approval') notify && notify({ kind: 'info', title: tr(lang, 'Submitted for approval'), subtitle: tr(lang, 'Breaking change routed to a steward.') });
      else notify && notify({ kind: 'success', title: tr(lang, 'Change applied'), subtitle: tr(lang, 'Schema updated and DataHub re-scanned.') });
      onDone();
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Alter failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to changes')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 400, margin: 0 }}>{tr(lang, 'New schema change')}</h1>
        <div style={{ width: 280 }}>
          <Select id="sc-target" labelText={tr(lang, 'Target table')} value={target} onChange={(e) => { setTarget(e.target.value); setDiff(null); }}>
            {tables.length === 0 && <SelectItem value="" text={tr(lang, '(loading…)')} />}
            {tables.map((t) => <SelectItem key={t} value={t} text={t} />)}
          </Select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 24, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="w-section-label" style={{ margin: 0 }}>{tr(lang, 'Change operation')}</div>
          <div className="w-row">
            <Picker label={tr(lang, 'Operation')} items={['add', 'rename', 'widen', 'drop', 'narrow']} value={op.op} onChange={(v) => set('op', v)} />
            <TextInput id="sc-col" labelText={tr(lang, 'Column')} value={op.column} onChange={(e) => set('column', e.target.value)} />
          </div>
          {op.op === 'rename'
            ? <TextInput id="sc-new" labelText={tr(lang, 'New name')} value={op.new_name} onChange={(e) => set('new_name', e.target.value)} />
            : (op.op !== 'drop' && <TextInput id="sc-dt" labelText={tr(lang, 'Data type')} value={op.data_type} onChange={(e) => set('data_type', e.target.value)} />)}
          {breaking
            ? <InlineNotification kind="error" lowContrast hideCloseButton title={tr(lang, 'Breaking change — approval required')} subtitle={tr(lang, 'Dropping or narrowing columns can break downstream consumers. Impact analysis is mandatory.')} />
            : <InlineNotification kind="success" lowContrast hideCloseButton title={tr(lang, 'Safe to execute')} subtitle={tr(lang, 'All operations are backward-compatible (add / rename / type relaxation).')} />}
          <TextInput id="sc-reason" labelText={tr(lang, 'Reason for change')} value={op.reason} onChange={(e) => set('reason', e.target.value)} placeholder={tr(lang, 'Why this change is needed')} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button kind="tertiary" renderIcon={iconFor('renew')} onClick={runDiff}>{tr(lang, 'Compute diff')}</Button>
            <Button kind="primary" renderIcon={iconFor(breaking ? 'send' : 'checkmark')} onClick={submit}>{breaking ? tr(lang, 'Submit for approval') : tr(lang, 'Apply change')}</Button>
          </div>
        </div>
        <div>
          <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Schema diff — current vs target')}</div>
          {diff ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Tile>
                <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Added')} ({(diff.added || []).length})</div>
                {(diff.added || []).map((c) => <div key={c.name} className="ip-mono" style={{ fontSize: '.75rem', color: 'var(--cds-support-success)' }}>+ {c.name} {c.type}</div>)}
                {(diff.added || []).length === 0 && <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>—</span>}
              </Tile>
              <Tile>
                <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Removed / changed')} ({(diff.removed || []).length + (diff.changed || []).length})</div>
                {(diff.removed || []).map((c) => <div key={c.name} className="ip-mono" style={{ fontSize: '.75rem', color: 'var(--cds-support-error)' }}>− {c.name}</div>)}
                {(diff.changed || []).map((c) => <div key={c.name} className="ip-mono" style={{ fontSize: '.75rem', color: '#8a6d00' }}>~ {c.name}: {c.from} → {c.to}</div>)}
                {((diff.removed || []).length + (diff.changed || []).length) === 0 && <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>—</span>}
              </Tile>
            </div>
          ) : <Tile><span style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Compute diff to compare the desired column set against the live schema.')}</span></Tile>}
        </div>
      </div>
    </div>
  );
}

/* ---- change detail (approval) ---- */
function ChangeDetail({ change, onBack, onDone, notify, lang }) {
  const diff = parse(change.diff, {});
  const impact = parse(change.impact, {});
  const op = diff.op || '';
  const breaking = DESTRUCTIVE(op);
  const downstream = impact.downstream || [];

  const decide = async (approve) => {
    try {
      if (approve) { await api.approveRequest(change.id); notify && notify({ kind: 'success', title: tr(lang, 'Change approved'), subtitle: tr(lang, 'ALTER executed · DataHub re-scan triggered.') }); }
      else { await api.rejectRequest(change.id); notify && notify({ kind: 'info', title: tr(lang, 'Change rejected') }); }
      onDone();
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Decision failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to changes')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 className="ip-mono" style={{ fontSize: '1.5rem', fontWeight: 400, margin: 0 }}>{change.target}</h1>
        <Tag type={breaking ? 'red' : 'green'} size="md">{breaking ? tr(lang, 'Breaking') : tr(lang, 'Compatible')}</Tag>
        <StatusDot kind={STATUS_KIND[change.status] || 'gray'}>{tr(lang, change.status)}</StatusDot>
        {change.status === 'pending' && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
            <Button kind="danger" size="md" onClick={() => decide(false)}>{tr(lang, 'Reject')}</Button>
            <Button kind="primary" size="md" renderIcon={iconFor('checkmark')} onClick={() => decide(true)}>{tr(lang, 'Approve & execute')}</Button>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
        <div>
          <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Operation')}</div>
          <StructuredListWrapper isCondensed>
            <StructuredListBody>
              <StructuredListRow><StructuredListCell>{tr(lang, 'Operation')}</StructuredListCell><StructuredListCell><Tag type={OP_TAG[op] || 'cool-gray'} size="sm">{op}</Tag></StructuredListCell></StructuredListRow>
              <StructuredListRow><StructuredListCell>{tr(lang, 'Column')}</StructuredListCell><StructuredListCell className="ip-mono">{diff.column || '—'}</StructuredListCell></StructuredListRow>
              <StructuredListRow><StructuredListCell>{tr(lang, 'Reason')}</StructuredListCell><StructuredListCell>{change.reason || '—'}</StructuredListCell></StructuredListRow>
              <StructuredListRow><StructuredListCell>{tr(lang, 'Requester')}</StructuredListCell><StructuredListCell>{change.requester || '—'}</StructuredListCell></StructuredListRow>
            </StructuredListBody>
          </StructuredListWrapper>
        </div>
        <div>
          {breaking ? (
            <>
              <div className="w-section-label" style={{ margin: '0 0 8px', color: 'var(--cds-support-error)' }}>{tr(lang, 'Impact analysis — downstream (DataHub)')}</div>
              <Tile>
                {downstream.length ? downstream.map((d) => (
                  <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--cds-layer-01)' }}>
                    <Icon name="data--base" size={16} /><span className="ip-mono" style={{ fontSize: '.8125rem' }}>{d}</span><Tag type="red" size="sm" style={{ marginLeft: 'auto' }}>{tr(lang, 'affected')}</Tag>
                  </div>
                )) : <span style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'No downstream consumers recorded in DataHub.')}</span>}
              </Tile>
              {impact.warning && <InlineNotification kind="warning" lowContrast hideCloseButton title={tr(lang, 'Warning')} subtitle={impact.warning} style={{ marginTop: 12 }} />}
            </>
          ) : (
            <InlineNotification kind="success" lowContrast hideCloseButton title={tr(lang, 'Backward-compatible')} subtitle={tr(lang, 'No downstream impact — safe to execute immediately.')} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function SchemaChanges({ notify, lang }) {
  const [view, setView] = useState('list');
  const [change, setChange] = useState(null);
  const [rows, setRows] = useState([]);
  const [tables, setTables] = useState([]);

  const load = () => api.getApprovals()
    .then((r) => setRows((r || []).filter((x) => x.type === 'schema_change')))
    .catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    api.getDatasets().then((ts) => setTables((ts || []).map((t) => `${t.namespace}.${t.name}`))).catch(() => setTables([]));
  }, []);

  if (view === 'editor') return <SchemaEditor tables={tables} onBack={() => setView('list')} onDone={() => { setView('list'); load(); }} notify={notify} lang={lang} />;
  if (view === 'detail' && change) return <ChangeDetail change={change} onBack={() => { setView('list'); setChange(null); }} onDone={() => { setView('list'); setChange(null); load(); }} notify={notify} lang={lang} />;
  return <ChangeList rows={rows} onNew={() => setView('editor')} onOpen={(r) => { setChange(r); setView('detail'); }} onRefresh={load} lang={lang} />;
}
