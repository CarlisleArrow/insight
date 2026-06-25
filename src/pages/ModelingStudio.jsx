import { useState, useEffect } from 'react';
import {
  Button, Tag, TextInput, Checkbox, Select, SelectItem, Search,
  InlineNotification, CodeSnippet,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { CarbonTable, StatusDot, RowMenu, ToolBtn, Placeholder } from '../components/shared.jsx';
import { ConfirmDelete } from '../components/modals.jsx';
import { startPointerDrag, snap } from '../components/dnd.js';
import * as api from '../data/api.js';
import { tr } from '../i18n.js';

// errMsg prefers the backend's parsed detail (incl. validation `details`) over the raw message.
const errMsg = (err) => err?.detail || String(err?.message || err);

/* Modeling Studio (§16 Modeling-as-Code): visual star-schema modeling persists
   the meta-model IR (dwm_*); Generate renders ETL scripts + DAG (custom blocks
   preserved); Deploy writes them to the shared volume. Tables/columns/relations
   are fully editable and saved via PUT /models/{id}/tables. */

const TYPE_TINT = { fact: 'var(--cds-blue-60)', dim: '#007d79', agg: '#b28600' };
const STATUS_KIND = { deployed: 'success', generated: 'blue', draft: 'draft' };
const ROLE_OPTS = ['business_key', 'surrogate_key', 'fk', 'measure', 'attribute'];
let _uid = 0;
const uid = () => `t${++_uid}`;

const NODE_W = 172;
function starLayout(tables) {
  const pos = {};
  const facts = tables.filter((t) => t.table_type === 'fact');
  const others = tables.filter((t) => t.table_type !== 'fact');
  facts.forEach((t, i) => { pos[t.uid] = { x: 320, y: 60 + i * 300 }; });
  others.forEach((t, i) => { pos[t.uid] = { x: i % 2 === 0 ? 40 : 600, y: 40 + Math.floor(i / 2) * 210 }; });
  return pos;
}

function StarCanvas({ tables, rels, pos, zoom, sel, onSelect, onMove }) {
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const byFull = Object.fromEntries(tables.map((t) => [`${t.target_ns}.${t.name}`, t.uid]));
  // Fact↔dim join edges (solid).
  const joinEdges = rels
    .map((r) => ({ a: byName[r.fact]?.uid, b: byName[r.dim]?.uid }))
    .filter((e) => pos[e.a] && pos[e.b]);
  // Source-derivation edges (dashed): a table reads from another table in the model
  // (e.g. an aggregate reading from its silver fact). Drawn so aggregates connect.
  const srcEdges = tables.map((t) => {
    const ref = String(t.source_ref || '').replace(/^iceberg\./, '');
    if (!ref) return null;
    const up = byFull[ref] || byName[ref.split('.').pop()]?.uid;
    return up && up !== t.uid ? { a: up, b: t.uid } : null;
  }).filter((e) => e && pos[e.a] && pos[e.b]);
  // Drag a node by its header. Screen deltas are divided by zoom to stay 1:1 with the cursor.
  const drag = (e, uid) => {
    e.stopPropagation();
    onSelect(uid);
    const p = pos[uid]; if (!p) return;
    const ox = p.x; const oy = p.y;
    startPointerDrag(e, (dx, dy) => onMove(uid, Math.max(0, snap(ox + dx / zoom)), Math.max(0, snap(oy + dy / zoom))));
  };
  return (
    <div className="ms-canvas">
      <div style={{ position: 'absolute', inset: 0, transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%`, height: `${100 / zoom}%` }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {srcEdges.map((e, i) => {
            const a = pos[e.a]; const b = pos[e.b];
            return <line key={`s${i}`} x1={a.x + NODE_W / 2} y1={a.y + 20} x2={b.x + NODE_W / 2} y2={b.y + 20}
              stroke="var(--cds-border-strong-01)" strokeWidth={1.5} strokeDasharray="5 4" />;
          })}
          {joinEdges.map((e, i) => {
            const a = pos[e.a]; const b = pos[e.b];
            const active = sel === e.a || sel === e.b;
            return <line key={`j${i}`} x1={a.x + NODE_W / 2} y1={a.y + 20} x2={b.x + NODE_W / 2} y2={b.y + 20}
              stroke={active ? 'var(--cds-blue-60)' : 'var(--cds-border-strong-01)'} strokeWidth={active ? 2 : 1.5} />;
          })}
        </svg>
        {tables.map((t) => pos[t.uid] && (
          <div key={t.uid} className={`ms-node ${sel === t.uid ? 'sel' : ''}`}
            style={{ left: pos[t.uid].x, top: pos[t.uid].y, borderTop: `3px solid ${TYPE_TINT[t.table_type] || '#8d8d8d'}` }}
            onClick={() => onSelect(t.uid)}>
            <div className="ms-node__h" style={{ cursor: 'move' }} onPointerDown={(e) => drag(e, t.uid)}><Icon name="data--base" size={14} />{t.name}</div>
            <div className="ms-node__tags">
              <Tag type="cool-gray" size="sm">{t.table_type}</Tag><Tag type="cool-gray" size="sm">{t.layer}</Tag>
              {t.scd_type && <Tag type="cool-gray" size="sm">{t.scd_type}</Tag>}
            </div>
            {(t.columns || []).map((c) => (
              <div key={c.name} className="ms-node__f">
                {(c.role === 'business_key' || c.role === 'surrogate_key') && <Icon name="locked" size={12} style={{ flex: '0 0 auto' }} />}
                <span className="nm" title={c.name}>{c.name}</span>
                <span className="rl">{c.agg_func ? `${c.agg_func}()` : c.role}</span>
              </div>
            ))}
            {(t.columns || []).length === 0 && <div className="ms-node__f" style={{ color: 'var(--cds-text-placeholder)' }}>—</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Codegen only has templates for these layer+type combos (bronze loads anything).
const LAYER_FOR_TYPE = { fact: ['silver', 'bronze'], dim: ['silver', 'bronze'], agg: ['gold', 'bronze'] };

/* Right config panel — fully editable table + columns. */
function ConfigPanel({ table, onPatch, onPatchCols, lang }) {
  if (!table) return <div style={{ padding: 16, fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Select a table')}</div>;
  const isDim = table.table_type === 'dim';
  const isAgg = table.table_type === 'agg';
  const cols = table.columns || [];
  const editCol = (i, patch) => onPatchCols(cols.map((c, j) => j === i ? { ...c, ...patch } : c));
  const validCombo = (LAYER_FOR_TYPE[table.table_type] || []).includes(table.layer);
  // Changing the type snaps the layer to a valid one so generation never breaks.
  const changeType = (nt) => {
    const allowed = LAYER_FOR_TYPE[nt] || ['silver'];
    const layer = allowed.includes(table.layer) ? table.layer : allowed[0];
    onPatch({ table_type: nt, layer, scd_type: nt === 'dim' ? (table.scd_type || 'scd1') : '' });
  };
  return (
    <div>
      <div className="ms-grp">
        <div className="w-section-label" style={{ margin: '0 0 10px' }}>{tr(lang, 'Table settings')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TextInput size="sm" id="ms-name" labelText={tr(lang, 'Table name')} value={table.name} onChange={(e) => onPatch({ name: e.target.value.replace(/[^a-z0-9_]/g, '') })} />
          <div className="w-row" style={{ gap: 8 }}>
            <Select size="sm" id="ms-type" labelText={tr(lang, 'Type')} value={table.table_type} onChange={(e) => changeType(e.target.value)}>
              {['dim', 'fact', 'agg'].map((l) => <SelectItem key={l} value={l} text={l} />)}
            </Select>
            <Select size="sm" id="ms-layer" labelText={tr(lang, 'Layer')} value={table.layer} onChange={(e) => onPatch({ layer: e.target.value })}>
              {(LAYER_FOR_TYPE[table.table_type] || ['silver', 'bronze']).map((l) => <SelectItem key={l} value={l} text={l} />)}
              {!validCombo && <SelectItem value={table.layer} text={`${table.layer} ⚠`} />}
            </Select>
          </div>
          {!validCombo && (
            <InlineNotification kind="error" lowContrast hideCloseButton title={tr(lang, 'Invalid layer + type')}
              subtitle={tr(lang, 'Facts and dimensions live in silver; aggregates in gold (bronze allowed for raw loads). Pick a valid layer so code can be generated.')} />
          )}
          <TextInput size="sm" id="ms-ns" labelText={tr(lang, 'Iceberg namespace')} value={table.target_ns} onChange={(e) => onPatch({ target_ns: e.target.value })} />
          <TextInput size="sm" id="ms-src" labelText={tr(lang, 'Source reference')} value={table.source_ref} placeholder="bronze_qms.raw_table" onChange={(e) => onPatch({ source_ref: e.target.value })} />
          {isDim && (
            <Select size="sm" id="ms-scd" labelText={tr(lang, 'SCD type')} value={table.scd_type || 'scd1'} onChange={(e) => onPatch({ scd_type: e.target.value })}>
              {['scd1', 'scd2'].map((l) => <SelectItem key={l} value={l} text={l} />)}
            </Select>
          )}
        </div>
      </div>

      <div className="ms-grp">
        <div className="w-section-label" style={{ margin: '0 0 10px' }}>{tr(lang, 'Columns')} ({cols.length})</div>
        {isAgg && <div style={{ fontSize: '.6875rem', color: 'var(--cds-text-secondary)', marginBottom: 10, lineHeight: 1.5 }}><Icon name="information" size={12} /> {tr(lang, 'Aggregate tables need at least one measure with an aggregate function. Columns left as “group by” become GROUP BY keys.')} <span style={{ color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'e.g. avg on yield_pct, sum on defect_count.')}</span></div>}
        {cols.length === 0 && <div style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)', marginBottom: 8 }}>{tr(lang, 'Add columns, or click a source table to import its schema.')}</div>}
        {cols.map((c, i) => (
          <div key={i} style={{ border: '1px solid var(--cds-layer-01)', padding: 8, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6, alignItems: 'center' }}>
              <TextInput size="sm" id={`c-name-${i}`} labelText="" placeholder={tr(lang, 'name')} value={c.name} onChange={(e) => editCol(i, { name: e.target.value })} />
              <TextInput size="sm" id={`c-type-${i}`} labelText="" placeholder={tr(lang, 'dtype')} value={c.dtype} onChange={(e) => editCol(i, { dtype: e.target.value })} />
              <Button kind="ghost" size="sm" hasIconOnly renderIcon={iconFor('subtract')} iconDescription={tr(lang, 'Remove')} onClick={() => onPatchCols(cols.filter((_, j) => j !== i))} />
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Select size="sm" id={`c-role-${i}`} labelText="" value={c.role || 'attribute'} onChange={(e) => editCol(i, { role: e.target.value })} style={{ flex: 1 }}>
                {ROLE_OPTS.map((r) => <SelectItem key={r} value={r} text={r} />)}
              </Select>
              {isDim && table.scd_type === 'scd2' && <Checkbox id={`c-scd-${i}`} labelText={tr(lang, 'track')} checked={!!c.scd2_track} onChange={(_, { checked }) => editCol(i, { scd2_track: checked })} />}
              {isAgg && (
                <Select size="sm" id={`c-agg-${i}`} labelText="" value={c.agg_func || ''} onChange={(e) => editCol(i, { agg_func: e.target.value })} style={{ width: 130 }}>
                  <SelectItem value="" text={tr(lang, '(group by)')} />
                  {['sum', 'avg', 'count', 'min', 'max'].map((f) => <SelectItem key={f} value={f} text={f} />)}
                </Select>
              )}
            </div>
          </div>
        ))}
        <Button kind="ghost" size="sm" renderIcon={iconFor('add')} onClick={() => onPatchCols([...cols, { name: '', dtype: 'string', source_expr: '', role: 'attribute', scd2_track: false, agg_func: '' }])}>{tr(lang, 'Add column')}</Button>
      </div>
    </div>
  );
}

/* Relationships editor (right-panel footer section). */
function RelEditor({ tables, rels, onChange, lang }) {
  const facts = tables.filter((t) => t.table_type === 'fact');
  const dims = tables.filter((t) => t.table_type === 'dim');
  const add = () => onChange([...rels, { fact: facts[0]?.name || '', dim: dims[0]?.name || '', fact_fk: '', dim_pk: '' }]);
  return (
    <div className="ms-grp">
      <div className="w-section-label" style={{ margin: '0 0 10px' }}>{tr(lang, 'Relationships')}</div>
      <div style={{ fontSize: '.6875rem', color: 'var(--cds-text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
        <Icon name="information" size={12} /> {tr(lang, 'Relationships are fact→dimension joins. Aggregate tables instead derive from their upstream table — set it in the table’s Source reference (drawn as a dashed link).')}
      </div>
      {rels.length === 0 && <div style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)', marginBottom: 8 }}>{tr(lang, 'Link a fact FK to a dimension PK.')}</div>}
      {rels.map((r, i) => (
        <div key={i} style={{ border: '1px solid var(--cds-layer-01)', padding: 8, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6, alignItems: 'center' }}>
            <Select size="sm" id={`r-f-${i}`} labelText="" value={r.fact} onChange={(e) => onChange(rels.map((x, j) => j === i ? { ...x, fact: e.target.value } : x))}>
              {facts.map((t) => <SelectItem key={t.uid} value={t.name} text={t.name} />)}
            </Select>
            <Select size="sm" id={`r-d-${i}`} labelText="" value={r.dim} onChange={(e) => onChange(rels.map((x, j) => j === i ? { ...x, dim: e.target.value } : x))}>
              {dims.map((t) => <SelectItem key={t.uid} value={t.name} text={t.name} />)}
            </Select>
            <Button kind="ghost" size="sm" hasIconOnly renderIcon={iconFor('subtract')} iconDescription={tr(lang, 'Remove')} onClick={() => onChange(rels.filter((_, j) => j !== i))} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <TextInput size="sm" id={`r-fk-${i}`} labelText="" placeholder={tr(lang, 'fact FK')} value={r.fact_fk} onChange={(e) => onChange(rels.map((x, j) => j === i ? { ...x, fact_fk: e.target.value } : x))} />
            <TextInput size="sm" id={`r-pk-${i}`} labelText="" placeholder={tr(lang, 'dim PK')} value={r.dim_pk} onChange={(e) => onChange(rels.map((x, j) => j === i ? { ...x, dim_pk: e.target.value } : x))} />
          </div>
        </div>
      ))}
      <Button kind="ghost" size="sm" renderIcon={iconFor('add')} disabled={facts.length === 0 || dims.length === 0} onClick={add}>{tr(lang, 'Add relationship')}</Button>
    </div>
  );
}

/* Generated code preview (real backend). */
function CodeGen({ modelId, onClose, onDeploy, notify, lang }) {
  const [files, setFiles] = useState([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(true);
  const regenerate = () => {
    setBusy(true);
    api.generateModel(modelId)
      .then((r) => { setFiles(r.files || []); setActive(0); notify && notify({ kind: 'success', title: tr(lang, 'Generated'), subtitle: tr(lang, 'Custom-logic regions preserved.') }); })
      .catch((err) => notify && notify({ kind: 'error', title: tr(lang, 'Generate failed.'), subtitle: errMsg(err) }))
      .finally(() => setBusy(false));
  };
  useEffect(() => { regenerate(); /* eslint-disable-next-line */ }, [modelId]);
  const file = files[active];
  return (
    <ComposedModal open size="lg" onClose={onClose}>
      <ModalHeader label={tr(lang, 'Modeling Studio')} title={tr(lang, 'Generated code')} />
      <ModalBody>
        <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Platform-managed scripts')}
          subtitle={tr(lang, 'Edits inside CUSTOM LOGIC regions are preserved across re-generation.')} />
        {busy ? <Placeholder label={tr(lang, 'Generating…')} icon="code" height={120} /> : files.length === 0 ? (
          <p style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'No files generated.')}</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, marginTop: 12 }}>
            <div className="ms-codetree">
              {files.map((f, i) => (
                <button key={f.name} className={`ms-codetree__item ${active === i ? 'on' : ''}`} onClick={() => setActive(i)}>
                  <Icon name={f.kind === 'dag' ? 'share' : 'document'} size={14} />{f.name}
                  <Tag type={f.kind === 'dag' ? 'purple' : 'green'} size="sm" style={{ marginLeft: 'auto' }}>{f.kind}</Tag>
                </button>
              ))}
            </div>
            <div style={{ minWidth: 0 }}>
              {file && <CodeSnippet type="multi" feedback={tr(lang, 'Copied')} style={{ maxHeight: 420 }}>{file.content}</CodeSnippet>}
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="ghost" renderIcon={iconFor('renew')} onClick={regenerate}>{tr(lang, 'Re-generate')}</Button>
        <Button kind="secondary" onClick={onClose}>{tr(lang, 'Close')}</Button>
        <Button kind="primary" renderIcon={iconFor('launch')} onClick={onDeploy}>{tr(lang, 'Deploy')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

function ModelsList({ onOpen, onNew, notify, lang }) {
  const [rows, setRows] = useState([]);
  const [del, setDel] = useState(null);
  const load = () => api.models.list().then((r) => setRows(r || [])).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const remove = async () => {
    const id = del.model_id || del.id;
    try { await api.models.remove(id); notify && notify({ kind: 'success', title: tr(lang, 'Model deleted.') }); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Delete failed.'), subtitle: (err.detail || String(err.message || err)) }); }
    setDel(null); load();
  };
  return (
    <>
      <CarbonTable
        headers={[
          { key: 'name', header: tr(lang, 'Model') }, { key: 'domain', header: tr(lang, 'Domain') },
          { key: 'status', header: tr(lang, 'Status') }, { key: 'owner', header: tr(lang, 'Owner') }, { key: 'ofw', header: '' },
        ]}
        rows={rows}
        withPagination
        searchPlaceholder={tr(lang, 'Search models')}
        onRowClick={onOpen}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={onNew}>{tr(lang, 'New model')}</Button>}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r); }}>{r.name}</a>;
          if (k === 'status') return <StatusDot kind={STATUS_KIND[r.status] || 'draft'}>{tr(lang, r.status)}</StatusDot>;
          if (k === 'ofw') return <RowMenu onView={() => onOpen(r)} onDelete={() => setDel(r)} />;
          return r[k] || '—';
        }} />
      <ConfirmDelete open={!!del} title={tr(lang, 'Delete model')} body={del ? `${tr(lang, 'Delete')} "${del.name}"? ${tr(lang, 'This cannot be undone.')}` : ''} onConfirm={remove} onClose={() => setDel(null)} />
    </>
  );
}

/* Map a backend FullModel into the local editable shape. */
function fromBackend(fm) {
  const tables = (fm.tables || []).map((t) => ({
    uid: t.table_id || uid(),
    name: t.name, layer: t.layer, table_type: t.table_type, target_ns: t.target_ns,
    scd_type: t.scd_type || '', source_ref: t.source_ref || '', write_mode: t.write_mode || '',
    columns: (t.columns || []).map((c) => ({ name: c.name, dtype: c.dtype, source_expr: c.source_expr || '', role: c.role || 'attribute', scd2_track: !!c.scd2_track, agg_func: c.agg_func || '' })),
  }));
  const byId = Object.fromEntries((fm.tables || []).map((t) => [t.table_id, t.name]));
  const rels = (fm.relationships || []).map((r) => ({ fact: byId[r.fact_table_id], dim: byId[r.dim_table_id], fact_fk: r.fact_fk || '', dim_pk: r.dim_pk || '' }))
    .filter((r) => r.fact && r.dim);
  return { tables, rels };
}

function ModelingCanvas({ modelRow, onBack, notify, lang }) {
  const [id, setId] = useState(modelRow.model_id || modelRow.id || null);
  const [name, setName] = useState(modelRow.name || 'new_model');
  const [status, setStatus] = useState(modelRow.status || 'draft');
  const [tables, setTables] = useState([]);
  const [rels, setRels] = useState([]);
  const [sel, setSel] = useState(null);
  const [srcQ, setSrcQ] = useState('');
  const [sources, setSources] = useState([]);
  const [codeGen, setCodeGen] = useState(false);
  const [pos, setPos] = useState({});   // { uid: {x,y} } canvas positions
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);

  // Esc exits fullscreen.
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [full]);

  // Keep a position for every table; seed new ones from the star layout, prune removed.
  useEffect(() => {
    setPos((prev) => {
      const layout = starLayout(tables);
      const next = {};
      let changed = false;
      tables.forEach((t) => { next[t.uid] = prev[t.uid] || layout[t.uid] || { x: 40, y: 40 }; if (!prev[t.uid]) changed = true; });
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [tables]);
  const moveNode = (uid, x, y) => setPos((p) => ({ ...p, [uid]: { x, y } }));
  const fit = () => { setZoom(1); setPos(starLayout(tables)); };

  // Load real data sources for the left tree.
  useEffect(() => {
    api.getDatasets().then((ts) => setSources((ts || []).map((t) => `${t.namespace}.${t.name}`))).catch(() => setSources([]));
  }, []);
  // Load an existing model (new drafts start empty — no fetch).
  useEffect(() => {
    if (!id) return;
    api.getModel(id).then((m) => { const { tables: ts, rels: rs } = fromBackend(m); setTables(ts); setRels(rs); setStatus(m.model?.status || 'draft'); setSel(ts[0]?.uid || null); }).catch(() => {});
  }, [id]);

  const selTable = tables.find((t) => t.uid === sel);
  const patchSel = (patch) => setTables((ts) => ts.map((t) => t.uid === sel ? { ...t, ...patch } : t));
  const patchSelCols = (cols) => setTables((ts) => ts.map((t) => t.uid === sel ? { ...t, columns: cols } : t));

  const addTable = (type) => {
    // Layer must match the codegen template router: silver dim/fact, gold agg.
    const layer = type === 'agg' ? 'gold' : 'silver';
    let n = 1; const base = type === 'fact' ? 'fact' : type === 'agg' ? 'agg' : 'dim';
    while (tables.some((t) => t.name === `${base}_${n}`)) n += 1;
    const t = { uid: uid(), name: `${base}_${n}`, layer, table_type: type, target_ns: `${layer}_qms`, scd_type: type === 'dim' ? 'scd1' : '', source_ref: '', write_mode: '', columns: [] };
    setTables((ts) => [...ts, t]); setSel(t.uid);
  };

  // Click a source table → import its real schema into the selected table.
  const importSource = (ref) => {
    if (!sel) { notify && notify({ kind: 'info', title: tr(lang, 'Select or add a table first.') }); return; }
    const [ns, table] = ref.split('.');
    api.getDatasetSchema(ns, table).then((sc) => {
      const cols = (sc.columns || []).map((c) => ({ name: c.col, dtype: c.type, source_expr: '', role: 'attribute', scd2_track: false, agg_func: '' }));
      setTables((ts) => ts.map((t) => t.uid === sel ? { ...t, source_ref: ref, columns: cols } : t));
      notify && notify({ kind: 'success', title: `${tr(lang, 'Imported')} ${cols.length} ${tr(lang, 'columns')}`, subtitle: ref });
    }).catch((err) => notify && notify({ kind: 'error', title: tr(lang, 'Import failed.'), subtitle: errMsg(err) }));
  };

  // Persist: create the model the first time, then PUT the full table-set.
  const save = async () => {
    try {
      let mid = id;
      if (!mid) { const m = await api.models.create({ name, domain: '', status: 'draft' }); mid = m.model_id || m.id; setId(mid); }
      const fm = await api.replaceModelTables(mid, {
        tables: tables.map((t) => ({
          name: t.name, layer: t.layer, table_type: t.table_type, target_ns: t.target_ns,
          scd_type: t.scd_type || '', source_ref: t.source_ref || '', write_mode: t.write_mode || '', has_custom_logic: false,
          columns: t.columns.map((c) => ({ name: c.name, dtype: c.dtype, source_expr: c.source_expr || '', role: c.role || '', scd2_track: !!c.scd2_track, agg_func: c.agg_func || '' })),
        })),
        relationships: rels.filter((r) => r.fact && r.dim).map((r) => ({ fact_table: r.fact, dim_table: r.dim, fact_fk: r.fact_fk, dim_pk: r.dim_pk })),
      });
      const { tables: ts, rels: rs } = fromBackend(fm);
      setTables(ts); setRels(rs); setStatus('draft');
      if (sel && !ts.some((t) => t.uid === sel)) setSel(ts[0]?.uid || null);
      notify && notify({ kind: 'success', title: tr(lang, 'Model saved.') });
      return mid;
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Save failed.'), subtitle: errMsg(err) }); return null; }
  };

  const openCodeGen = async () => { const mid = await save(); if (mid) setCodeGen(true); };
  const deploy = async () => {
    const mid = await save();
    if (!mid) return;
    try { const r = await api.deployModel(mid); setStatus('deployed'); setCodeGen(false); notify && notify({ kind: 'success', title: tr(lang, 'Model deployed'), subtitle: `${r.scripts} ${tr(lang, 'scripts')} · DAG ${r.dag || ''}` }); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Deploy failed.'), subtitle: errMsg(err) }); }
  };

  const srcRows = sources.filter((s) => s.toLowerCase().includes(srcQ.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack}>{tr(lang, 'Models')}</Button>
        <Icon name="chevron--right" size={16} style={{ color: 'var(--cds-icon-secondary)' }} />
        {id
          ? <span className="ip-mono" style={{ fontSize: '1rem', fontWeight: 600, marginLeft: 'auto' }}>{name}</span>
          : <div style={{ maxWidth: 260, marginLeft: 'auto' }}><TextInput size="sm" id="ms-modelname" labelText="" placeholder={tr(lang, 'Model name')} value={name} onChange={(e) => setName(e.target.value.replace(/[^a-z0-9_]/g, ''))} /></div>}
      </div>
      <div className="ms-studio" style={full ? { position: 'fixed', inset: 0, zIndex: 8000, height: '100vh', background: 'var(--cds-background)' } : undefined}>
        <div className="w-etoolbar">
          <ToolBtn icon="save" label={tr(lang, 'Save')} onClick={save} />
          <span className="gap" />
          <ToolBtn icon="checkmark" label={tr(lang, 'Validate')} onClick={save} />
          <span style={{ display: 'inline-flex', alignItems: 'center', alignSelf: 'center', height: '100%', padding: '0 12px' }}>
            <Tag type="cool-gray" size="sm">{tr(lang, id ? status : 'unsaved')}</Tag>
          </span>
          <span className="spacer" />
          <ToolBtn icon="zoom--out" label="" title={tr(lang, 'Zoom out')} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} />
          <button className="w-iconbtn" title={tr(lang, 'Reset zoom & layout')} onClick={fit} style={{ minWidth: 48 }}>{Math.round(zoom * 100)}%</button>
          <ToolBtn icon="zoom--in" label="" title={tr(lang, 'Zoom in')} onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} />
          <ToolBtn icon={full ? 'minimize' : 'maximize'} label="" title={tr(lang, full ? 'Exit fullscreen' : 'Fullscreen')} onClick={() => setFull((f) => !f)} />
          <span className="gap" />
          <Button kind="tertiary" size="lg" renderIcon={iconFor('code')} disabled={tables.length === 0} onClick={openCodeGen}>{tr(lang, 'Generate code')}</Button>
          <Button kind="primary" size="lg" renderIcon={iconFor('launch')} disabled={tables.length === 0} onClick={deploy}>{tr(lang, 'Deploy')}</Button>
        </div>
        <div className="ms-body">
          <div className="ms-left">
            <div className="ms-grp">
              <div className="w-section-label" style={{ margin: '0 0 10px' }}>{tr(lang, 'Add table')}</div>
              <Button kind="tertiary" size="sm" renderIcon={iconFor('add')} style={{ width: '100%', marginBottom: 6 }} onClick={() => addTable('fact')}>{tr(lang, 'Fact table')}</Button>
              <Button kind="tertiary" size="sm" renderIcon={iconFor('add')} style={{ width: '100%', marginBottom: 6 }} onClick={() => addTable('dim')}>{tr(lang, 'Dimension table')}</Button>
              <Button kind="tertiary" size="sm" renderIcon={iconFor('add')} style={{ width: '100%' }} onClick={() => addTable('agg')}>{tr(lang, 'Aggregate table')}</Button>
            </div>
            <div className="ms-grp">
              <div className="w-section-label" style={{ margin: '0 0 8px' }}>{tr(lang, 'Data sources')}</div>
              <Search size="sm" labelText={tr(lang, 'Search sources')} placeholder={tr(lang, 'Search sources')} value={srcQ} onChange={(e) => setSrcQ(e.target.value)} />
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' }}>
                {srcRows.length === 0 && <span style={{ fontSize: '.6875rem', color: 'var(--cds-text-placeholder)', padding: '4px 0' }}>{sources.length ? tr(lang, 'No match.') : tr(lang, '(loading…)')}</span>}
                {srcRows.map((s) => (
                  <button key={s} className="ms-codetree__item" style={{ border: 'none', borderBottom: '1px solid var(--cds-layer-01)' }} title={tr(lang, 'Import schema into selected table')} onClick={() => importSource(s)}>
                    <Icon name="data--base" size={14} />{s}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '.625rem', color: 'var(--cds-text-placeholder)', marginTop: 8 }}>{tr(lang, 'Click a source to import its columns into the selected table.')}</div>
            </div>
          </div>
          {tables.length > 0
            ? <StarCanvas tables={tables} rels={rels} pos={pos} zoom={zoom} sel={sel} onSelect={setSel} onMove={moveNode} />
            : <div className="ms-canvas" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>{tr(lang, 'Add a fact, dimension, or aggregate table to begin.')}</div>}
          <div className="ms-right" style={{ overflow: 'hidden' }}>
            <div className="ms-grp" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
              <Icon name="settings" size={16} /><span className="ip-mono" style={{ fontSize: '.8125rem', fontWeight: 600 }}>{selTable?.name || tr(lang, 'No selection')}</span>
              {selTable && <Button kind="ghost" size="sm" hasIconOnly renderIcon={iconFor('trash-can')} iconDescription={tr(lang, 'Delete table')} style={{ marginLeft: 'auto' }}
                onClick={() => { setTables((ts) => ts.filter((t) => t.uid !== sel)); setRels((rs) => rs.filter((r) => r.fact !== selTable.name && r.dim !== selTable.name)); setSel(null); }} />}
            </div>
            {/* table + columns config scrolls on its own */}
            <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
              <ConfigPanel table={selTable} onPatch={patchSel} onPatchCols={patchSelCols} lang={lang} />
            </div>
            {/* relationships pinned to the bottom, always reachable */}
            <div style={{ flex: '0 0 auto', maxHeight: '42%', overflow: 'auto', borderTop: '1px solid var(--wire-border)', background: 'var(--cds-layer-01)' }}>
              <RelEditor tables={tables} rels={rels} onChange={setRels} lang={lang} />
            </div>
          </div>
        </div>
      </div>
      {codeGen && <CodeGen modelId={id} onClose={() => setCodeGen(false)} onDeploy={deploy} notify={notify} lang={lang} />}
    </div>
  );
}

export default function ModelingStudio({ notify, lang }) {
  const [open, setOpen] = useState(null);
  // New model switches to the canvas with an unsaved draft — no POST until Save.
  // Default to a unique name so multiple drafts are distinguishable.
  const newModel = () => setOpen({ name: `model_${Date.now().toString(36).slice(-4)}`, status: 'draft', _new: true });
  if (open) return <ModelingCanvas modelRow={open} onBack={() => setOpen(null)} notify={notify} lang={lang} />;
  return <ModelsList onOpen={setOpen} onNew={newModel} notify={notify} lang={lang} />;
}
