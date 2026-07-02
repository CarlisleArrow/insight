import { useState, useEffect } from 'react';
import {
  Button, Tag, TextInput, InlineNotification, Tile, Select, SelectItem,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, CarbonTable, StatusDot, EmptyState } from '../components/shared.jsx';
import * as api from '../data/api.js';
import { tr } from '../i18n.js';

/* Data Patch (§17.3): row-level UPDATE/DELETE corrections to lakehouse data.
   Always approval-gated, snapshot-backed, fully audited. A pre-flight count
   preview shows impact; apply enqueues an approval request. */

const STATUS_KIND = { executed: 'success', pending: 'amber', approved: 'blue', rejected: 'failed', failed: 'failed' };

function parse(j, def) { try { return JSON.parse(j); } catch { return def; } }

/* ---- elevated-role gate: full-width, light-red, fills + centers the area ---- */
function Gate({ onProceed, lang }) {
  return (
    <div style={{
      width: '100%', minHeight: 'calc(100vh - 220px)', boxSizing: 'border-box',
      background: 'rgba(218,30,40,.06)', border: '1px solid rgba(218,30,40,.3)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: '48px 24px',
    }}>
      <div style={{ width: 56, height: 56, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(218,30,40,.14)', color: 'var(--cds-support-error)' }}>
        <Icon name="warning--filled" size={28} />
      </div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 400, margin: '0 0 8px' }}>{tr(lang, 'Data patch is a high-risk capability')}</h2>
      <p style={{ fontSize: '.875rem', color: 'var(--cds-text-secondary)', margin: '0 0 8px', lineHeight: 1.5, maxWidth: 560 }}>
        {tr(lang, 'This tool directly modifies lakehouse data with row-level UPDATE / DELETE. It is restricted to elevated roles and every action is approval-gated and audited.')}
      </p>
      <p style={{ fontSize: '.875rem', color: 'var(--cds-support-error)', margin: '0 0 20px', maxWidth: 560 }}>
        {tr(lang, 'Use this only to correct data. Routine business changes belong at the source (upstream MySQL), never here.')}
      </p>
      <InlineNotification kind="error" lowContrast hideCloseButton
        title={tr(lang, 'Elevated role required')}
        subtitle={tr(lang, 'Only stewards and admins can run data patches. Every patch is approval-gated and audited.')}
        style={{ maxWidth: 560, width: '100%', textAlign: 'left', margin: '0 0 20px' }} />
      <Button kind="danger" size="md" renderIcon={iconFor('unlocked')} onClick={onProceed}>{tr(lang, 'I understand — proceed')}</Button>
    </div>
  );
}

/* ---- new patch ---- */
function NewPatch({ tables, onCancel, onDone, notify, lang }) {
  const [table, setTable] = useState(tables[0] || '');
  const [op, setOp] = useState('update');
  const [where, setWhere] = useState('');
  const [sets, setSets] = useState([{ col: '', val: '' }]);
  const [reason, setReason] = useState('');
  const [affected, setAffected] = useState(null);

  useEffect(() => { if (!table && tables.length) setTable(tables[0]); }, [tables]);
  const setObj = () => Object.fromEntries(sets.filter((s) => s.col).map((s) => [s.col, s.val]));

  const preview = async () => {
    const [ns, t] = table.split('.');
    try { const r = await api.patchPreview(ns, t, { op, where, set: setObj() }); setAffected(r.affected_rows); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Preview failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };
  const submit = async () => {
    const [ns, t] = table.split('.');
    try {
      const r = await api.patchApply(ns, t, { op, where, set: setObj(), reason });
      notify && notify({ kind: 'info', title: tr(lang, 'Patch submitted for approval'), subtitle: `${r.affected_rows ?? '?'} ${tr(lang, 'rows')} · ${tr(lang, 'routed to a data steward.')}` });
      onDone();
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Submit failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  return (
    <div>
      <InlineNotification kind="warning" lowContrast hideCloseButton title={tr(lang, 'Corrections only')}
        subtitle={tr(lang, 'This operation directly modifies lakehouse data. The pre-patch snapshot is retained automatically for rollback.')} />
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 24, alignItems: 'start', marginTop: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="w-row">
            <Select id="dp-table" labelText={tr(lang, 'Target table (Iceberg v2)')} value={table} onChange={(e) => { setTable(e.target.value); setAffected(null); }}>
              {tables.length === 0 && <SelectItem value="" text={tr(lang, '(loading…)')} />}
              {tables.map((t) => <SelectItem key={t} value={t} text={t} />)}
            </Select>
            <Select id="dp-op" labelText={tr(lang, 'Operation')} value={op} onChange={(e) => { setOp(e.target.value); setAffected(null); }}>
              <SelectItem value="update" text="UPDATE" />
              <SelectItem value="delete" text="DELETE" />
            </Select>
          </div>
          <TextInput id="dp-where" labelText={tr(lang, 'WHERE condition (required)')} value={where} onChange={(e) => { setWhere(e.target.value); setAffected(null); }} placeholder="process_id = 'P7' AND measured_at > DATE '2026-06-20'" />
          {op === 'update' && (
            <div className="w-fld"><label className="cds--label">{tr(lang, 'SET values')}</label>
              {sets.map((s, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 32px', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <TextInput size="sm" id={`set-col-${i}`} labelText="" placeholder="column" value={s.col} onChange={(e) => setSets((ss) => ss.map((x, j) => j === i ? { ...x, col: e.target.value } : x))} />
                  <TextInput size="sm" id={`set-val-${i}`} labelText="" placeholder="expr / literal" value={s.val} onChange={(e) => setSets((ss) => ss.map((x, j) => j === i ? { ...x, val: e.target.value } : x))} />
                  <Button kind="ghost" size="sm" hasIconOnly renderIcon={iconFor('subtract')} iconDescription={tr(lang, 'Remove')} onClick={() => setSets((ss) => ss.filter((_, j) => j !== i))} />
                </div>
              ))}
              <Button kind="ghost" size="sm" renderIcon={iconFor('add')} onClick={() => setSets((ss) => [...ss, { col: '', val: '' }])}>{tr(lang, 'Add SET')}</Button>
            </div>
          )}
          <TextInput id="dp-reason" labelText={tr(lang, 'Reason for correction (required)')} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr(lang, 'Why this patch is needed')} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Tile>
            <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Rows that will be')} {op === 'update' ? tr(lang, 'updated') : tr(lang, 'deleted')}</div>
            {affected != null
              ? <div style={{ fontSize: '2rem', fontWeight: 300, color: 'var(--cds-support-error)' }}>{String(affected)}<span style={{ fontSize: '.875rem', color: 'var(--cds-text-secondary)', marginLeft: 8 }}>{tr(lang, 'rows match (SELECT count)')}</span></div>
              : <Button kind="tertiary" size="md" renderIcon={iconFor('view')} disabled={!where} onClick={preview}>{tr(lang, 'Preview affected rows')}</Button>}
          </Tile>
          <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Forced flow')}
            subtitle={tr(lang, 'Reason → approval → execute → snapshot retained → audit. The patch cannot run without an approver.')} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <Button kind="secondary" onClick={onCancel}>{tr(lang, 'Cancel')}</Button>
        <Button kind="danger" renderIcon={iconFor('send')} disabled={affected == null || !reason} onClick={submit}>{tr(lang, 'Submit for approval')}</Button>
      </div>
    </div>
  );
}

/* ---- patch detail drill-down: full operation + retained pre-patch snapshot,
   with a guarded rollback to that snapshot (§17.3 snapshot-backed). ---- */
function PatchDetail({ patch, onBack, onDone, notify, lang }) {
  const diff = parse(patch.diff, {});
  const impact = parse(patch.impact, {});
  const op = diff.op || '';
  const sets = diff.set || {};
  const snapshot = impact.snapshot_id || impact.pre_snapshot || patch.snapshot_id;
  const [confirm, setConfirm] = useState(null); // null | open
  const [txt, setTxt] = useState('');

  const rollback = async () => {
    const [ns, t] = String(patch.target).split('.');
    try {
      await api.patchRollback(ns, t, { snapshot_id: snapshot, approval_id: patch.id });
      notify && notify({ kind: 'success', title: tr(lang, 'Rolled back'), subtitle: `${patch.target} → ${snapshot || tr(lang, 'pre-patch snapshot')}` });
      setConfirm(null); onDone();
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Rollback failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  return (
    <div>
      <Button kind="ghost" size="sm" onClick={onBack} style={{ marginBottom: 12, justifyContent: 'flex-start', paddingInlineStart: 12 }}><Icon name="arrow--left" size={16} style={{ marginRight: 8 }} />{tr(lang, 'Back')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 className="ip-mono" style={{ fontSize: '1.5rem', fontWeight: 400, margin: 0 }}>{patch.target}</h1>
        <Tag type={op === 'delete' ? 'red' : 'purple'} size="md">{String(op).toUpperCase()}</Tag>
        <StatusDot kind={STATUS_KIND[patch.status] || 'gray'}>{tr(lang, patch.status)}</StatusDot>
        {patch.status === 'executed' && snapshot && (
          <div style={{ marginLeft: 'auto' }}>
            <Button kind="danger" size="md" renderIcon={iconFor('restart')} onClick={() => { setConfirm(true); setTxt(''); }}>{tr(lang, 'Roll back')}</Button>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
        <div>
          <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Operation')}</div>
          <dl className="w-dl">
            <dt>{tr(lang, 'Operation')}</dt><dd><Tag type={op === 'delete' ? 'red' : 'purple'} size="sm">{String(op).toUpperCase()}</Tag></dd>
            <dt>{tr(lang, 'WHERE condition (required)')}</dt><dd className="ip-mono">{diff.where || '—'}</dd>
            {op === 'update' && <><dt>{tr(lang, 'SET values')}</dt><dd className="ip-mono">{Object.keys(sets).length ? Object.entries(sets).map(([k, v]) => `${k} = ${v}`).join('; ') : '—'}</dd></>}
            <dt>{tr(lang, 'Reason')}</dt><dd>{patch.reason || '—'}</dd>
            <dt>{tr(lang, 'By')}</dt><dd>{patch.requester || '—'}</dd>
            <dt>{tr(lang, 'Rows')}</dt><dd>{impact.affected_rows ?? '—'}</dd>
          </dl>
        </div>
        <div>
          <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Pre-patch snapshot')}</div>
          {snapshot ? (
            <Tile>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name="time" size={16} /><span className="ip-mono" style={{ fontSize: '.8125rem' }}>{snapshot}</span>
              </div>
              <p style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', margin: '10px 0 0', lineHeight: 1.5 }}>
                {tr(lang, 'The lakehouse state from just before this patch is retained. Roll back to restore it exactly.')}
              </p>
            </Tile>
          ) : (
            <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Snapshot retained on execute')}
              subtitle={tr(lang, 'A pre-patch snapshot is captured when the patch executes; it appears here once approved and applied.')} />
          )}
        </div>
      </div>

      {confirm && (
        <ComposedModal open size="sm" onClose={() => setConfirm(null)}>
          <ModalHeader label={tr(lang, 'High-risk operation')} title={tr(lang, 'Roll back')} />
          <ModalBody hasForm>
            <InlineNotification kind="error" lowContrast hideCloseButton title={tr(lang, 'This restores the pre-patch snapshot')}
              subtitle={tr(lang, 'Any changes made after this patch will be lost. This action is itself audited.')} />
            <TextInput id="rb-confirm" labelText={`${tr(lang, 'Type the table name to confirm')}: ${patch.target}`} value={txt} onChange={(e) => setTxt(e.target.value)} placeholder={patch.target} />
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" onClick={() => setConfirm(null)}>{tr(lang, 'Cancel')}</Button>
            <Button kind="danger" renderIcon={iconFor('restart')} disabled={txt !== patch.target} onClick={rollback}>{tr(lang, 'Roll back')}</Button>
          </ModalFooter>
        </ComposedModal>
      )}
    </div>
  );
}

/* Body — gate → list/new flow, no page chrome. Embedded under Monitoring & Ops. */
export function DataPatchBody({ notify, lang }) {
  const [unlocked, setUnlocked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [rows, setRows] = useState([]);
  const [tables, setTables] = useState([]);

  const load = () => api.getApprovals()
    .then((r) => setRows((r || []).filter((x) => x.type === 'data_patch')))
    .catch(() => setRows([]));
  useEffect(() => {
    if (!unlocked) return;
    load();
    api.getDatasets().then((ts) => setTables((ts || []).map((t) => `${t.namespace}.${t.name}`))).catch(() => setTables([]));
  }, [unlocked]);

  if (!unlocked) return <Gate onProceed={() => setUnlocked(true)} lang={lang} />;
  if (creating) return <NewPatch tables={tables} onCancel={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} notify={notify} lang={lang} />;
  if (detail) return <PatchDetail patch={detail} onBack={() => setDetail(null)} onDone={() => { setDetail(null); load(); }} notify={notify} lang={lang} />;
  return (
    <div>
      <InlineNotification kind="warning" lowContrast hideCloseButton title={tr(lang, 'Corrections only')}
        subtitle={tr(lang, 'Patches modify lakehouse data directly. Business data changes belong at the upstream source (MySQL).')} />
      {rows.length === 0 ? (
        <EmptyState icon="warning--alt" title={tr(lang, 'No patches yet')}
          sub={tr(lang, 'Create a patch to correct erroneous rows. Every patch is previewed, approved, and snapshot-backed.')}
          action={<Button kind="danger" renderIcon={iconFor('add')} onClick={() => setCreating(true)}>{tr(lang, 'New patch')}</Button>} />
      ) : (
        <CarbonTable
          headers={[
            { key: 'target', header: tr(lang, 'Table'), mono: true }, { key: 'op', header: tr(lang, 'Op') },
            { key: 'rows', header: tr(lang, 'Rows') }, { key: 'reason', header: tr(lang, 'Reason') },
            { key: 'requester', header: tr(lang, 'By') }, { key: 'status', header: tr(lang, 'Status') },
          ]}
          rows={rows.map((r) => ({ ...r, op: parse(r.diff, {}).op, rows: parse(r.impact, {}).affected_rows }))}
          withPagination
          searchPlaceholder={tr(lang, 'Search patch history')}
          onRowClick={setDetail}
          actions={<Button kind="danger" size="lg" renderIcon={iconFor('add')} onClick={() => setCreating(true)}>{tr(lang, 'New patch')}</Button>}
          renderCell={(r, k) => {
            if (k === 'target') return <a href="#" onClick={(e) => { e.preventDefault(); setDetail(r); }}>{r.target}</a>;
            if (k === 'op') return <Tag type={r.op === 'delete' ? 'red' : 'purple'} size="sm">{String(r.op || '').toUpperCase()}</Tag>;
            if (k === 'reason') return <span style={{ display: 'block', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.reason}</span>;
            if (k === 'status') return <StatusDot kind={STATUS_KIND[r.status] || 'gray'}>{tr(lang, r.status)}</StatusDot>;
            return r[k] ?? '—';
          }} />
      )}
    </div>
  );
}

export default function DataPatch({ notify, lang }) {
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Monitoring & Ops'), tr(lang, 'Data Patch')]} title={tr(lang, 'Data Patch')}
        sub={tr(lang, 'Row-level corrections to lakehouse data — approval-gated, snapshot-backed, fully audited.')} />
      <DataPatchBody notify={notify} lang={lang} />
    </div>
  );
}
