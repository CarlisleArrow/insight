import { useState, useRef, useEffect } from 'react';
import { Button, Tag, Search, Toggle } from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { Picker } from '../components/inputs.jsx';
import {
  PageHeader, SubSwitch, CarbonTable, StatusDot, FieldChip, ToolBtn, RowMenu, SidePanel,
} from '../components/shared.jsx';
import { FormModal, ConfirmDelete } from '../components/modals.jsx';
import { BarChart, ChartByType } from '../components/Charts.jsx';
import { startPointerDrag, snap } from '../components/dnd.js';
import { useCollection } from '../data/DataProvider.jsx';
import * as api from '../data/api.js';
import { SCHEMAS } from '../data/formSchemas.js';
import { CHART_TYPES } from '../data/mockData.js';
import { tr, trList } from '../i18n.js';

/* Lazy real thumbnail: renders the dashboard's first widget via the BFF. */
function Thumb({ id, height = 124, mini = true, lang }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    api.renderDashboard(id, 'first')
      .then((r) => { if (alive) setData((r.widgets?.[0]?.chartData) || []); })
      .catch(() => { if (alive) setData([]); });
    return () => { alive = false; };
  }, [id]);
  if (data === null) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-placeholder)', fontSize: '.7rem' }}>…</div>;
  if (data.length === 0) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-placeholder)', fontSize: '.7rem' }}>{tr(lang, 'No widgets')}</div>;
  return <BarChart data={data} group={data[0]?.group || 'value'} height={height} mini={mini} />;
}

/* ---- lightweight SQL syntax highlighter (overlay) ---- */
const SQL_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'BY', 'AS', 'AND', 'OR', 'NOT', 'IN', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'ON', 'LIMIT', 'OFFSET', 'HAVING', 'DESC', 'ASC', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'VIEW', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'UNION', 'ALL', 'NULL', 'IS', 'BETWEEN', 'LIKE', 'OVER', 'PARTITION']);
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function highlightSql(code) {
  const re = /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = ''; let last = 0; let m;
  while ((m = re.exec(code))) {
    out += escHtml(code.slice(last, m.index));
    if (m[1]) out += `<span class="cm">${escHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="str">${escHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="num">${escHtml(m[3])}</span>`;
    else {
      const w = m[4];
      if (SQL_KEYWORDS.has(w.toUpperCase())) out += `<span class="kw">${escHtml(w)}</span>`;
      else if (/^\s*\(/.test(code.slice(re.lastIndex))) out += `<span class="fn">${escHtml(w)}</span>`;
      else out += escHtml(w);
    }
    last = re.lastIndex;
  }
  out += escHtml(code.slice(last));
  return `${out}\n`;
}

function SqlEditor({ value, onChange }) {
  const taRef = useRef(null);
  const preRef = useRef(null);
  const sync = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  return (
    <div className="an-sqlwrap">
      <pre ref={preRef} className="an-sql__code an-sql__hl" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightSql(value) }} />
      <textarea ref={taRef} className="an-sql__code an-sql__ta" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} onScroll={sync} rows={9} aria-label="SQL editor" />
    </div>
  );
}

function exportCsv(filename, cols, rows) {
  const head = cols.map((c) => c.header).join(',');
  const body = rows.map((r) => cols.map((c) => `"${String(r[c.key] ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([`${head}\n${body}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- Dashboard gallery ---------------- */
function GalleryCard({ d, list, onOpen, menu, lang }) {
  if (list) {
    return (
      <div className="an-listcard" onClick={onOpen}>
        <div style={{ width: 80, height: 48, flex: '0 0 auto', border: '1px solid var(--wire-border)' }}>
          <Thumb id={d.id} height={46} lang={lang} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '.875rem', color: 'var(--cds-text-primary)' }}>{d.name}</div>
          <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 2 }}>{d.owner} · {d.mod}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>{(d.tags || []).map((t) => <Tag key={t} type="cool-gray" size="sm">{t}</Tag>)}</div>
        {menu}
      </div>
    );
  }
  return (
    <div className="an-card">
      <div style={{ height: 140, borderBottom: '1px solid var(--wire-border)', padding: 8, cursor: 'pointer' }} onClick={onOpen}>
        <Thumb id={d.id} height={124} lang={lang} />
      </div>
      <div className="an-card__meta">
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          <h3 style={{ flex: 1, cursor: 'pointer' }} onClick={onOpen}>{d.name}</h3>
          {menu}
        </div>
        <div className="row"><Icon name="user--avatar" size={16} />{d.owner}</div>
        <div className="row"><Icon name="time" size={16} />{tr(lang, 'Modified')} {d.mod}</div>
        <div className="an-card__tags">{(d.tags || []).map((t) => <Tag key={t} type="cool-gray" size="sm">{t}</Tag>)}</div>
      </div>
    </div>
  );
}

function DashboardGallery({ notify, onOpenEditor, lang }) {
  const { items, add, remove } = useCollection('dashboards');
  const [view, setView] = useState('grid');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('All tags');
  const [owner, setOwner] = useState('All owners');
  const [del, setDel] = useState(null);

  const rows = items.filter((d) => (
    d.name.toLowerCase().includes(q.toLowerCase())
    && (tag === 'All tags' || (d.tags || []).includes(tag))
    && (owner === 'All owners' || d.owner === owner)
  ));

  const create = () => {
    const id = add({ name: 'Untitled dashboard', owner: '', mod: 'just now', tags: ['Draft'], widgets: [] });
    notify && notify({ kind: 'success', title: tr(lang, 'Dashboard created.') });
    onOpenEditor({ id, name: 'Untitled dashboard', widgets: [] });
  };
  const duplicate = (d) => { add({ ...d, id: undefined, name: `${d.name} (copy)`, mod: 'just now' }); notify && notify({ kind: 'success', title: tr(lang, 'Dashboard duplicated.') }); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240, maxWidth: 420 }}>
          <Search size="lg" labelText={tr(lang, 'Search dashboards')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr(lang, 'Search dashboards')} />
        </div>
        <Picker items={['All tags', 'Manufacturing', 'Finance', 'Logistics', 'Quality', 'Ops', 'Growth', 'Draft']} itemToString={(it) => tr(lang, it)} value={tag} onChange={setTag} />
        <Picker items={['All owners', 'L. Marsh', 'A. Okafor', 'R. Vance', 'J. Singh', 'M. Díaz']} itemToString={(it) => tr(lang, it)} value={owner} onChange={setOwner} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', border: '1px solid var(--cds-border-strong-01)' }}>
            <Button kind={view === 'grid' ? 'primary' : 'ghost'} size="md" hasIconOnly renderIcon={iconFor('grid')} iconDescription={tr(lang, 'Grid view')} onClick={() => setView('grid')} />
            <Button kind={view === 'list' ? 'primary' : 'ghost'} size="md" hasIconOnly renderIcon={iconFor('list')} iconDescription={tr(lang, 'List view')} onClick={() => setView('list')} />
          </div>
          <Button kind="primary" size="md" renderIcon={iconFor('add')} onClick={create}>{tr(lang, 'Create dashboard')}</Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="w-empty"><div className="ic"><Icon name="dashboard" size={32} /></div><h3>{tr(lang, 'No dashboards match')}</h3><p>{tr(lang, 'Try a different search or filter.')}</p></div>
      ) : (
        <div className={`an-gallery ${view === 'list' ? 'list' : ''}`}>
          {rows.map((d) => (
            <GalleryCard
              key={d.id}
              d={d}
              lang={lang}
              list={view === 'list'}
              onOpen={() => onOpenEditor(d)}
              menu={<RowMenu onView={() => onOpenEditor(d)} onDuplicate={() => duplicate(d)} onDelete={() => setDel(d)} />}
            />
          ))}
        </div>
      )}
      <ConfirmDelete
        open={!!del}
        title={tr(lang, 'Delete dashboard')}
        body={del ? `${tr(lang, 'Delete')} "${del.name}"? ${tr(lang, 'This cannot be undone.')}` : ''}
        onConfirm={() => { remove(del.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Dashboard deleted.') }); }}
        onClose={() => setDel(null)}
      />
    </div>
  );
}

/* ---------------- Dashboard editor (real, data-driven) ----------------
   Each widget carries a query spec {dataset, dimensions, measures, limit} and
   renders real data via POST /api/query/build. Save persists widgets to the
   dashboard doc; opening loads them back. No mock data. */
const AGG_OPTS = ['sum', 'avg', 'min', 'max', 'count'];

function WidgetChart({ w, lang }) {
  const h = Math.max(80, w.h - 64);
  const data = w.data || [];
  if (data.length === 0) {
    return <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.75rem' }}>{w.error ? `${tr(lang, 'Error')}: ${w.error}` : tr(lang, 'Configure dataset + measure →')}</div>;
  }
  if ((w.type || '').toLowerCase() === 'table') {
    return (
      <div style={{ height: h, overflow: 'auto' }}>
        <table className="ip-mono" style={{ width: '100%', fontSize: '.75rem', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left', borderBottom: '1px solid var(--wire-border)', padding: '2px 6px' }}>key</th><th style={{ textAlign: 'left', borderBottom: '1px solid var(--wire-border)', padding: '2px 6px' }}>group</th><th style={{ textAlign: 'right', borderBottom: '1px solid var(--wire-border)', padding: '2px 6px' }}>value</th></tr></thead>
          <tbody>{data.slice(0, 200).map((d, i) => <tr key={i}><td style={{ padding: '2px 6px' }}>{d.key}</td><td style={{ padding: '2px 6px' }}>{d.group}</td><td style={{ padding: '2px 6px', textAlign: 'right' }}>{String(d.value)}</td></tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <ChartByType type={w.type} data={data} height={h} />;
}

function DashboardEditor({ notify, onExit, dashboard, onSave, onSubscribe, lang }) {
  const [selected, setSelected] = useState(null);
  const [widgets, setWidgets] = useState(() => (dashboard?.widgets || []).map((w) => ({ ...w, data: [] })));
  const canvasRef = useRef(null);
  const idRef = useRef(widgets.length);

  // Left-pane data sources.
  const [datasets, setDatasets] = useState([]);
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getDatasets().then((ts) => { if (alive) setDatasets((ts || []).map((t) => `${t.namespace}.${t.name}`)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Run a single widget's query and store its chart data.
  const runWidget = async (wid) => {
    const w = widgets.find((x) => x.id === wid);
    if (!w || !w.spec?.table || (!w.spec.measures?.length && !w.spec.dimensions?.length)) return;
    try {
      const resp = await api.buildQuery({
        dataset: { catalog: 'iceberg', schema: w.spec.schema, table: w.spec.table },
        dimensions: w.spec.dimensions || [], measures: w.spec.measures || [], limit: w.spec.limit || 100,
      });
      setEngine(resp.engine);
      setWidgets((ws) => ws.map((x) => x.id === wid ? { ...x, data: resp.chartData || [], error: null } : x));
    } catch (err) {
      setWidgets((ws) => ws.map((x) => x.id === wid ? { ...x, data: [], error: String(err.message || err) } : x));
    }
  };
  // Render all widgets on mount.
  useEffect(() => { widgets.forEach((w) => runWidget(w.id)); /* eslint-disable-next-line */ }, []);

  const moveWidget = (e, id) => {
    e.stopPropagation(); setSelected(id);
    const w = widgets.find((x) => x.id === id); const ox = w.x, oy = w.y;
    startPointerDrag(e, (dx, dy) => setWidgets((ws) => ws.map((x) => x.id === id ? { ...x, x: Math.max(0, snap(ox + dx)), y: Math.max(0, snap(oy + dy)) } : x)));
  };
  const resizeWidget = (e, id) => {
    e.stopPropagation();
    const w = widgets.find((x) => x.id === id); const ow = w.w, oh = w.h;
    startPointerDrag(e, (dx, dy) => setWidgets((ws) => ws.map((x) => x.id === id ? { ...x, w: Math.max(220, snap(ow + dx)), h: Math.max(160, snap(oh + dy)) } : x)));
  };
  const removeWidget = (e, id) => { e.stopPropagation(); setWidgets((ws) => ws.filter((x) => x.id !== id)); };

  const addWidget = (type) => {
    idRef.current += 1; const id = `w${idRef.current}`;
    const n = widgets.length;
    setWidgets((ws) => [...ws, { id, type, title: `${type} chart`, x: 24 + (n % 3) * 320, y: 24 + Math.floor(n / 3) * 240, w: 300, h: 220, spec: { schema: '', table: '', dimensions: [], measures: [], limit: 100 }, data: [] }]);
    setSelected(id);
  };

  const sel = widgets.find((w) => w.id === selected);
  const [selCols, setSelCols] = useState([]);
  // Load columns when the selected widget's table changes.
  useEffect(() => {
    if (!sel?.spec?.table) { setSelCols([]); return; }
    api.getDatasetSchema(sel.spec.schema, sel.spec.table)
      .then((sc) => setSelCols((sc.columns || []).map((c) => ({ col: c.col, type: c.type }))))
      .catch(() => setSelCols([]));
  }, [sel?.spec?.schema, sel?.spec?.table]);

  const patchSpec = (patch, rerun = true) => {
    if (!sel) return;
    setWidgets((ws) => ws.map((x) => x.id === sel.id ? { ...x, spec: { ...x.spec, ...patch } } : x));
    if (rerun) setTimeout(() => runWidget(sel.id), 0);
  };
  const setDataset = (v) => { const [schema, table] = v.split('.'); patchSpec({ schema, table, dimensions: [], measures: [] }, false); };

  const save = async () => {
    try {
      const persist = widgets.map(({ data, error, ...rest }) => rest);
      await onSave({ widgets: persist });
      notify && notify({ kind: 'success', title: tr(lang, 'Dashboard saved.') });
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Save failed.'), subtitle: String(err.message || err) }); }
  };

  const numericCols = selCols.filter((c) => /int|dec|double|real|num|float|big/i.test(c.type));

  const [preview, setPreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const share = () => {
    const link = `${window.location.origin}/?dashboard=${dashboard.id}`;
    if (navigator.clipboard) navigator.clipboard.writeText(link);
    notify && notify({ kind: 'success', title: tr(lang, 'Share link copied.'), subtitle: link });
  };
  const subscribe = async () => { await save(); onSubscribe && onSubscribe(dashboard); };

  return (
    <div className="an-editor">
      <div className="w-etoolbar">
        <ToolBtn icon="arrow--left" label={tr(lang, 'Exit')} onClick={onExit} />
        <span className="gap" />
        <ToolBtn icon="save" label={tr(lang, 'Save')} onClick={save} />
        <ToolBtn icon="view" label={preview ? tr(lang, 'Edit') : tr(lang, 'Preview')} onClick={() => { setSelected(null); setPreview((p) => !p); }} />
        <ToolBtn icon="share" label={tr(lang, 'Share')} onClick={share} />
        <span className="gap" />
        <ToolBtn icon="zoom--out" label="" title={tr(lang, 'Zoom out')} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} />
        <span style={{ display: 'inline-flex', alignItems: 'center', alignSelf: 'center', height: '100%', fontSize: '.75rem', color: 'var(--cds-text-secondary)', minWidth: 38, justifyContent: 'center' }}>{Math.round(zoom * 100)}%</span>
        <ToolBtn icon="zoom--in" label="" title={tr(lang, 'Zoom in')} onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} />
        <ToolBtn icon="maximize" label="" title={tr(lang, 'Reset zoom')} onClick={() => setZoom(1)} />
        <span className="spacer" />
        {engine && (
          <span style={{ display: 'inline-flex', alignItems: 'center', alignSelf: 'center', gap: 4, height: '100%', marginRight: 12, fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>
            <Icon name="data--base" size={14} />{engine}
          </span>
        )}
        <Button kind="primary" size="md" renderIcon={iconFor('send')} onClick={subscribe}>{tr(lang, 'Subscribe')}</Button>
      </div>

      <div className="an-editor__body">
        {!preview && (
        <div className="an-pane" style={{ width: 200, flex: '0 0 200px' }}>
          <div className="an-pane__h">{tr(lang, 'Add chart')}</div>
          <div className="an-pane__body">
            <div className="an-palette">
              {CHART_TYPES.map((c) => (
                <div key={c.label} className="an-charttype" onClick={() => addWidget(c.label)} style={{ cursor: 'pointer' }}>
                  <Icon name={c.icon} size={20} />{c.label}
                </div>
              ))}
            </div>
          </div>
        </div>
        )}

        <div className="an-canvas" ref={canvasRef} onClick={() => setSelected(null)}>
          {widgets.length === 0 && <div style={{ padding: 40, color: 'var(--cds-text-secondary)', fontSize: '.875rem' }}>{tr(lang, 'Add a chart from the left, then pick a dataset + measure on the right.')}</div>}
          <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', position: 'relative', width: `${100 / zoom}%`, height: `${100 / zoom}%` }}>
          {widgets.map((w) => (
            <div key={w.id} className={`an-widget ${selected === w.id ? 'sel' : ''}`} style={{ left: w.x, top: w.y, width: w.w, height: w.h }} onClick={(e) => { e.stopPropagation(); if (!preview) setSelected(w.id); }}>
              <div className="an-widget__h" onPointerDown={(e) => !preview && moveWidget(e, w.id)} style={{ cursor: preview ? 'default' : 'move' }}>
                {w.title}
                {!preview && (
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="w-grip"><i /><i /><i /><i /><i /><i /></span>
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => removeWidget(e, w.id)} aria-label={tr(lang, 'Remove widget')}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cds-icon-secondary)', display: 'flex' }}><Icon name="close" size={16} /></button>
                </span>
                )}
              </div>
              <div className="an-widget__b"><WidgetChart w={w} lang={lang} /></div>
              {!preview && selected === w.id && <span className="an-resize" onPointerDown={(e) => resizeWidget(e, w.id)} />}
            </div>
          ))}
          </div>
        </div>

        {!preview && (
        <div className="an-pane an-pane--right" style={{ width: 290, flex: '0 0 290px' }}>
          <div className="an-pane__h">{tr(lang, 'Configure')} · {sel ? sel.title : tr(lang, 'No selection')}</div>
          <div className="an-pane__body">
            {!sel ? <span style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Select a widget to configure its query.')}</span> : (
              <>
                <div className="an-shelf"><span className="lbl">{tr(lang, 'Dataset')}</span>
                  <Picker items={datasets.length ? datasets : [tr(lang, '(loading…)')]} value={sel.spec.table ? `${sel.spec.schema}.${sel.spec.table}` : (datasets[0] || '')} onChange={setDataset} />
                </div>
                <div className="an-shelf"><span className="lbl">{tr(lang, 'Dimensions (X · 1st = axis, 2nd = series)')}</span>
                  <div className="an-fieldlist">
                    {selCols.length === 0 && <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>—</span>}
                    {selCols.map((c) => {
                      const on = (sel.spec.dimensions || []).includes(c.col);
                      return <FieldChip key={c.col} kind={on ? 'group' : 'dim'} onClick={() => patchSpec({ dimensions: on ? sel.spec.dimensions.filter((x) => x !== c.col) : [...(sel.spec.dimensions || []), c.col] })} style={{ cursor: 'pointer', opacity: on ? 1 : 0.6 }}>{c.col}</FieldChip>;
                    })}
                  </div>
                </div>
                <div className="an-shelf"><span className="lbl">{tr(lang, 'Measures (Y)')}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {(sel.spec.measures || []).map((m, i) => <span className="an-pill agg" key={i}>{m.agg}({m.col})<span className="x" onClick={() => patchSpec({ measures: sel.spec.measures.filter((_, idx) => idx !== i) })}><Icon name="close" size={16} /></span></span>)}
                    <Picker items={['+ add', ...numericCols.flatMap((c) => AGG_OPTS.map((a) => `${a}(${c.col})`))]} itemToString={(it) => (it === '+ add' ? tr(lang, '+ add') : it)} value="+ add"
                      onChange={(v) => { const mm = /^(\w+)\(([^)]+)\)$/.exec(v); if (mm) patchSpec({ measures: [...(sel.spec.measures || []), { agg: mm[1], col: mm[2] }] }); }} />
                  </div>
                </div>
                <div className="an-shelf"><span className="lbl">{tr(lang, 'Limit')}</span>
                  <Picker items={['50', '100', '500', '1000']} value={String(sel.spec.limit || 100)} onChange={(v) => patchSpec({ limit: Number(v) })} />
                </div>
                <div className="an-shelf"><span className="lbl">{tr(lang, 'Chart type')}</span>
                  <Picker items={CHART_TYPES.map((c) => c.label)} itemToString={(it) => tr(lang, it)} value={sel.type} onChange={(v) => setWidgets((ws) => ws.map((x) => x.id === sel.id ? { ...x, type: v } : x))} />
                </div>
                <Button kind="tertiary" size="sm" renderIcon={iconFor('renew')} onClick={() => runWidget(sel.id)}>{tr(lang, 'Refresh data')}</Button>
              </>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Ad-hoc query ---------------- */
// dataset value is "schema.table"; the catalog is iceberg (lakehouse surface).
function targetFor(source) {
  const [schema, table] = String(source).split('.');
  return { catalog: 'iceberg', schema, table };
}

const AGGS = ['sum', 'avg', 'min', 'max', 'count'];

function AdHocQuery({ notify, lang }) {
  const [mode, setMode] = useState('visual');
  const [running, setRunning] = useState(false);

  // Real datasets (three layers) + the selected table's real columns.
  const [datasets, setDatasets] = useState([]); // ["gold_qms.agg_...", ...]
  const [source, setSource] = useState('');
  const [columns, setColumns] = useState([]); // [{col,type}]
  // Visual builder state.
  const [dims, setDims] = useState([]);
  const [measures, setMeasures] = useState([]); // [{col,agg}]
  const [limit, setLimit] = useState(100);
  // SQL editor state.
  const [sql, setSql] = useState('-- pick a dataset, or write SQL\nSELECT 1');

  const [result, setResult] = useState({ columns: [], rows: [], engine: null, rewrittenSql: null, meta: tr(lang, 'Run a query to see results') });

  // Load datasets once.
  useEffect(() => {
    let alive = true;
    api.getDatasets()
      .then((ts) => {
        if (!alive) return;
        const names = (ts || []).map((t) => `${t.namespace}.${t.name}`);
        setDatasets(names);
        if (names.length && !source) setSource(names[0]);
      })
      .catch((err) => console.error('datasets failed', err));
    return () => { alive = false; };
  }, []);

  // Load the selected table's columns + a sensible default SQL.
  useEffect(() => {
    if (!source) return;
    const [ns, table] = source.split('.');
    setDims([]); setMeasures([]);
    setSql(`SELECT *\nFROM ${ns}.${table}\nLIMIT 100`);
    api.getDatasetSchema(ns, table)
      .then((sc) => setColumns((sc.columns || []).map((c) => ({ col: c.col, type: c.type }))))
      .catch((err) => { console.error('schema failed', err); setColumns([]); });
  }, [source]);

  const numericCols = columns.filter((c) => /int|dec|double|real|num|float|big/i.test(c.type));
  const toggleDim = (c) => setDims((d) => d.includes(c) ? d.filter((x) => x !== c) : [...d, c]);
  const addMeasure = (col, agg) => setMeasures((m) => [...m, { col, agg }]);
  const removeMeasure = (i) => setMeasures((m) => m.filter((_, idx) => idx !== i));

  const applyResult = (resp, t0) => {
    const cols = (resp.result?.columns || []).map((c) => ({ key: c.key, header: c.header }));
    const rows = (resp.result?.rows || []).map((r, i) => ({ id: String(i), ...r }));
    const ms = Math.max(1, Math.round(performance.now() - t0));
    setResult({ columns: cols, rows, engine: resp.engine, rewrittenSql: resp.rewritten_sql, meta: `${rows.length} ${tr(lang, 'rows')} · ${(ms / 1000).toFixed(2)}s · ${resp.engine}` });
    notify && notify({ kind: 'success', title: tr(lang, 'Query executed.'), subtitle: `${rows.length} ${tr(lang, 'rows')} · ${resp.engine}` });
  };

  const runSql = async () => {
    setRunning(true); const t0 = performance.now();
    try { applyResult(await api.runQuery(sql, targetFor(source)), t0); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Query failed.'), subtitle: String(err.message || err) }); }
    finally { setRunning(false); }
  };
  const runBuild = async () => {
    if (!source) return;
    const [schema, table] = source.split('.');
    setRunning(true); const t0 = performance.now();
    try {
      const resp = await api.buildQuery({ dataset: { catalog: 'iceberg', schema, table }, dimensions: dims, measures, limit });
      applyResult(resp, t0);
    } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Build failed.'), subtitle: String(err.message || err) }); }
    finally { setRunning(false); }
  };

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'inline-flex', border: '1px solid var(--cds-border-strong-01)' }}>
        <button className="w-iconbtn" style={{ height: 40, padding: '0 16px', background: mode === 'visual' ? 'var(--cds-gray-100)' : 'transparent', color: mode === 'visual' ? '#fff' : 'var(--cds-text-secondary)' }} onClick={() => setMode('visual')}>{tr(lang, 'Visual query builder')}</button>
        <button className="w-iconbtn" style={{ height: 40, padding: '0 16px', borderLeft: '1px solid var(--cds-border-strong-01)', background: mode === 'sql' ? 'var(--cds-gray-100)' : 'transparent', color: mode === 'sql' ? '#fff' : 'var(--cds-text-secondary)' }} onClick={() => setMode('sql')}>{tr(lang, 'SQL editor')}</button>
      </div>

      {mode === 'visual' ? (
        <div className="an-vbuilder">
          <div className="step"><h4><Icon name="data--base" size={16} />1 · {tr(lang, 'Source')}</h4><Picker items={datasets.length ? datasets : [tr(lang, '(loading…)')]} value={source} onChange={setSource} /></div>
          <div className="step"><h4><Icon name="add" size={16} />2 · {tr(lang, 'Dimensions (group by)')}</h4>
            <div className="an-fieldlist">
              {columns.length === 0 && <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>—</span>}
              {columns.map((c) => <FieldChip key={c.col} kind={dims.includes(c.col) ? 'group' : 'dim'} onClick={() => toggleDim(c.col)} style={{ cursor: 'pointer', opacity: dims.includes(c.col) ? 1 : 0.7 }}>{c.col}</FieldChip>)}
            </div>
          </div>
          <div className="step"><h4><Icon name="chart--line" size={16} />3 · {tr(lang, 'Measures')}</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {measures.map((m, i) => <span className="an-pill agg" key={i}>{m.agg}({m.col})<span className="x" onClick={() => removeMeasure(i)}><Icon name="close" size={16} /></span></span>)}
              <Picker items={['+ add measure', ...numericCols.flatMap((c) => AGGS.map((a) => `${a}(${c.col})`))]} itemToString={(it) => (it === '+ add measure' ? tr(lang, '+ add measure') : it)} value="+ add measure" onChange={(v) => { const mm = /^(\w+)\(([^)]+)\)$/.exec(v); if (mm) addMeasure(mm[2], mm[1]); }} />
            </div>
          </div>
          <div className="step"><h4><Icon name="list" size={16} />4 · {tr(lang, 'Limit & run')}</h4>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Picker items={['50', '100', '500', '1000']} value={String(limit)} onChange={(v) => setLimit(Number(v))} />
              <Button kind="primary" size="md" renderIcon={iconFor('play')} disabled={running || !source} onClick={runBuild}>{running ? tr(lang, 'Running…') : tr(lang, 'Run')}</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="an-sql">
          <div className="an-sql__bar">
            <Picker items={datasets.length ? datasets : [tr(lang, '(loading…)')]} value={source} onChange={setSource} />
            <span className="spacer" />
            <Button kind="primary" size="sm" renderIcon={iconFor('play')} disabled={running} onClick={runSql}>{running ? tr(lang, 'Running…') : tr(lang, 'Run')}</Button>
          </div>
          <SqlEditor value={sql} onChange={setSql} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 8px', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: '.875rem', fontWeight: 600, color: 'var(--cds-text-primary)' }}>{tr(lang, 'Results')} <span style={{ color: 'var(--cds-text-secondary)', fontWeight: 400 }}>· {result.meta}</span></div>
        <div style={{ display: 'flex', gap: 1 }}>
          <Button kind="tertiary" size="sm" renderIcon={iconFor('download')} onClick={() => { exportCsv('query-results.csv', result.columns, result.rows); notify && notify({ kind: 'success', title: tr(lang, 'Exported CSV.') }); }}>CSV</Button>
          <Button kind="tertiary" size="sm" renderIcon={iconFor('export')} onClick={() => { exportCsv('query-results.xls', result.columns, result.rows); notify && notify({ kind: 'success', title: tr(lang, 'Exported Excel.') }); }}>Excel</Button>
        </div>
      </div>
      {result.rewrittenSql && (
        <div className="ip-mono" style={{ fontSize: '.75rem', background: 'var(--cds-field-01)', border: '1px solid var(--wire-border)', padding: '8px 10px', marginBottom: 8, color: 'var(--cds-text-secondary)', overflowX: 'auto' }}>
          <span style={{ color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'rewritten (policy-applied)')} · {result.engine}: </span>{result.rewrittenSql}
        </div>
      )}
      <CarbonTable
        headers={result.columns.map((c) => ({ key: c.key, header: c.header, mono: true }))}
        rows={result.rows}
        withToolbar={false}
        renderCell={(r, k) => <span className="ip-mono" style={{ fontSize: '.8125rem' }}>{r[k]}</span>}
      />
    </div>
  );
}

/* ---------------- Report subscriptions ---------------- */
function ReportSubscriptions({ notify, lang }) {
  const { items, add, update, remove } = useCollection('reports');
  const { items: dashboards } = useCollection('dashboards');
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const [busy, setBusy] = useState(null); // report id currently running
  const [runsFor, setRunsFor] = useState(null); // { report, runs }

  // Report binds to a dashboard (its first widget supplies the data). The form
  // appends a dashboard picker; submit maps the name → source_type + dashboard_id.
  const dashNames = dashboards.map((d) => d.name);
  const reportSchema = [...SCHEMAS.report, { key: 'dashboard', label: tr(lang, 'Dashboard source'), type: 'select', items: dashNames.length ? dashNames : [tr(lang, '(no dashboards)')] }];
  const toDoc = (v) => {
    const dash = dashboards.find((d) => d.name === v.dashboard);
    const { dashboard, ...rest } = v;
    return { ...rest, source_type: 'dashboard', dashboard_id: dash ? dash.id : '' };
  };
  const initialFor = (row) => row ? { ...row, dashboard: (dashboards.find((d) => d.id === row.dashboard_id) || {}).name || '' } : undefined;
  const headers = [
    { key: 'name', header: tr(lang, 'Report') },
    { key: 'schedule', header: tr(lang, 'Schedule'), mono: true },
    { key: 'recipients', header: tr(lang, 'Recipients') },
    { key: 'format', header: tr(lang, 'Format') },
    { key: 'channel', header: tr(lang, 'Channel') },
    { key: 'status', header: tr(lang, 'Status') },
    { key: 'run', header: '' },
    { key: 'ofw', header: '' },
  ];

  const runNow = async (r) => {
    setBusy(r.id);
    try {
      const res = await api.runReport(r.id);
      notify && notify({ kind: res.status === 'Delivered' ? 'success' : 'info', title: `${tr(lang, 'Report run:')} ${tr(lang, res.status)}`, subtitle: `${res.rows} ${tr(lang, 'rows')}` });
      if (res.download) window.open(res.download, '_blank');
    } catch (err) {
      notify && notify({ kind: 'error', title: tr(lang, 'Run failed.'), subtitle: String(err.message || err) });
    } finally { setBusy(null); }
  };
  const openRuns = async (r) => {
    try { const runs = await api.getReportRuns(r.id); setRunsFor({ report: r, runs: runs || [] }); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'History failed.'), subtitle: String(err.message || err) }); }
  };

  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={items}
        withPagination
        searchPlaceholder={tr(lang, 'Search subscriptions')}
        actions={(
          <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({ mode: 'create' })}>{tr(lang, 'New subscription')}</Button>
        )}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); openRuns(r); }}>{r.name}</a>;
          if (k === 'channel') return <Tag type={r.channel === 'IM' ? 'purple' : 'blue'} size="sm">{r.channel}</Tag>;
          if (k === 'status') return <StatusDot kind={r.status}>{tr(lang, r.status)}</StatusDot>;
          if (k === 'run') return <Button kind="ghost" size="sm" renderIcon={iconFor('play')} disabled={busy === r.id} onClick={() => runNow(r)}>{busy === r.id ? tr(lang, 'Running…') : tr(lang, 'Run now')}</Button>;
          if (k === 'ofw') return <RowMenu onView={() => openRuns(r)} onEdit={() => setModal({ mode: 'edit', row: r })} onDelete={() => setDel(r)} />;
          return r[k];
        }}
      />
      {modal && (
        <FormModal
          open
          label={tr(lang, 'Distribution')}
          title={modal.mode === 'create' ? tr(lang, 'New subscription') : tr(lang, 'Edit subscription')}
          submitText={modal.mode === 'create' ? tr(lang, 'Create') : tr(lang, 'Save')}
          schema={reportSchema}
          initial={initialFor(modal.row)}
          onSubmit={(v) => { const doc = toDoc(v); if (modal.mode === 'create') add(doc); else update(modal.row.id, doc); setModal(null); notify && notify({ kind: 'success', title: modal.mode === 'create' ? tr(lang, 'Subscription created.') : tr(lang, 'Subscription updated.') }); }}
          onClose={() => setModal(null)}
        />
      )}
      {runsFor && (
        <SidePanel sup={tr(lang, 'Run history')} title={runsFor.report.name} width={520} onClose={() => setRunsFor(null)} footer={<Button kind="secondary" onClick={() => setRunsFor(null)}>{tr(lang, 'Close')}</Button>}>
          {runsFor.runs.length === 0 ? (
            <p style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'No runs yet. Use “Run now” to generate one.')}</p>
          ) : runsFor.runs.map((rn) => (
            <div key={rn.id} style={{ borderBottom: '1px solid var(--wire-border)', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusDot kind={rn.status === 'Delivered' ? 'success' : rn.status === 'Delivery failed' ? 'failed' : 'gray'}>{tr(lang, rn.status)}</StatusDot>
              <span style={{ flex: 1, fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{rn.time} · {rn.rows} {tr(lang, 'rows')}</span>
              <a href={`/api/reports/runs/${rn.id}/download`} target="_blank" rel="noreferrer" style={{ fontSize: '.75rem' }}>{tr(lang, 'Download')}</a>
            </div>
          ))}
        </SidePanel>
      )}
      <ConfirmDelete
        open={!!del}
        title={tr(lang, 'Delete subscription')}
        body={del ? `${tr(lang, 'Delete')} "${del.name}"?` : ''}
        onConfirm={() => { remove(del.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Subscription deleted.') }); }}
        onClose={() => setDel(null)}
      />
    </div>
  );
}

/* ---------------- Section ---------------- */
const ANALYTICS_SUBS = [
  { id: 'gallery', label: 'Dashboard gallery' },
  { id: 'query', label: 'Ad-hoc query' },
  { id: 'reports', label: 'Report subscriptions' },
];

function EditorWrap({ notify, dashboard, onExit, onSubscribe, lang }) {
  const { update } = useCollection('dashboards');
  return (
    <DashboardEditor
      notify={notify}
      lang={lang}
      dashboard={dashboard}
      onExit={onExit}
      onSave={async (patch) => update(dashboard.id, { ...patch, mod: 'just now' })}
      onSubscribe={onSubscribe}
    />
  );
}

export default function Analytics({ notify, lang }) {
  const [sub, setSub] = useState('gallery');
  const [editing, setEditing] = useState(null);
  if (sub === 'editor' && editing) {
    return <EditorWrap notify={notify} lang={lang} dashboard={editing} onExit={() => { setSub('gallery'); setEditing(null); }}
      onSubscribe={() => { setSub('reports'); setEditing(null); notify && notify({ kind: 'info', title: tr(lang, 'Create a subscription for this dashboard.') }); }} />;
  }

  const TITLES = {
    gallery: ['Dashboard gallery', 'Browse, open, and create self-service dashboards.'],
    query: ['Ad-hoc query', 'Explore data with a visual builder or SQL — results auto-route across engines.'],
    reports: ['Report subscription & distribution', 'Schedule and deliver reports to people and channels.'],
  };
  const [title, subtitle] = TITLES[sub] || TITLES.gallery;
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Self-Service Analytics'), tr(lang, title)]} title={tr(lang, title)} sub={tr(lang, subtitle)} />
      <SubSwitch items={trList(lang, ANALYTICS_SUBS)} value={sub} onChange={setSub} />
      {sub === 'gallery' && <DashboardGallery notify={notify} lang={lang} onOpenEditor={(d) => { setEditing(d); setSub('editor'); }} />}
      {sub === 'query' && <AdHocQuery notify={notify} lang={lang} />}
      {sub === 'reports' && <ReportSubscriptions notify={notify} lang={lang} />}
    </div>
  );
}
