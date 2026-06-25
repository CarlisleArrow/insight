import { useState, useEffect, useMemo } from 'react';
import { Button, Tag } from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, ToolBtn, RowMenu, SidePanel, StatusDot } from '../components/shared.jsx';
import { FormModal, ConfirmDelete } from '../components/modals.jsx';
import { startPointerDrag, snap } from '../components/dnd.js';
import { useCollection } from '../data/DataProvider.jsx';
import * as api from '../data/api.js';
import { SCHEMAS } from '../data/formSchemas.js';
import { tr, trList } from '../i18n.js';
import ModelingStudio from './ModelingStudio.jsx';

const STATUS_TAG = { Certified: 'green', Review: 'purple', Draft: 'gray' };

/* ---------------- Metrics store ---------------- */
function MetricsStore({ notify, lang }) {
  const { items, add, update, remove } = useCollection('metrics');
  const [modal, setModal] = useState(null);
  const [del, setDel] = useState(null);
  const [view, setView] = useState(null);
  const headers = [
    { key: 'name', header: tr(lang, 'Metric') },
    { key: 'def', header: tr(lang, 'Business definition') },
    { key: 'formula', header: tr(lang, 'Formula'), mono: true },
    { key: 'owner', header: tr(lang, 'Owner') },
    { key: 'status', header: tr(lang, 'Status') },
    { key: 'lineage', header: tr(lang, 'Lineage') },
    { key: 'ofw', header: '' },
  ];
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={items}
        withPagination
        searchPlaceholder={tr(lang, 'Search metrics')}
        actions={(
          <>
            <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('filter')} iconDescription={tr(lang, 'Filter')} />
            <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({ mode: 'create' })}>{tr(lang, 'Define metric')}</Button>
          </>
        )}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); setView(r); }}>{r.name}</a>;
          if (k === 'def') return <span style={{ display: 'block', maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.def}</span>;
          if (k === 'status') return <Tag type={STATUS_TAG[r.status] || 'gray'} size="sm">{tr(lang, r.status)}</Tag>;
          if (k === 'lineage') return r.source
            ? <span className="md-lineage" onClick={(e) => { e.stopPropagation(); setView(r); }}><Icon name="data--base" size={16} />{r.source}</span>
            : <span className="md-lineage" onClick={(e) => { e.stopPropagation(); setView(r); }}><Icon name="data--base" size={16} />{tr(lang, 'View')}</span>;
          // Glossary-sourced metrics are managed in DataHub (read-only here).
          if (k === 'ofw') return r.readonly
            ? <Tag type="cool-gray" size="sm" title={tr(lang, 'Managed in DataHub Glossary')}>{tr(lang, 'glossary')}</Tag>
            : <RowMenu onView={() => setView(r)} onEdit={() => setModal({ mode: 'edit', row: r })} onDelete={() => setDel(r)} />;
          return r[k];
        }}
      />

      {modal && (
        <FormModal
          open
          label={tr(lang, 'Metrics store')}
          title={modal.mode === 'create' ? tr(lang, 'Define metric') : tr(lang, 'Edit metric')}
          submitText={modal.mode === 'create' ? tr(lang, 'Save metric') : tr(lang, 'Save')}
          schema={SCHEMAS.metric}
          initial={modal.row}
          onSubmit={(v) => { if (modal.mode === 'create') add(v); else update(modal.row.id, v); setModal(null); notify && notify({ kind: 'success', title: modal.mode === 'create' ? tr(lang, 'Metric submitted for review.') : tr(lang, 'Metric updated.') }); }}
          onClose={() => setModal(null)}
        />
      )}
      <ConfirmDelete open={!!del} title={tr(lang, 'Delete metric')} body={del ? `${tr(lang, 'Delete')} "${del.name}"?` : ''} onConfirm={() => { remove(del.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Metric deleted.') }); }} onClose={() => setDel(null)} />

      {view && (
        <SidePanel sup={tr(lang, 'Metric')} title={view.name} width={400} onClose={() => setView(null)}
          footer={<><Button kind="secondary" onClick={() => setView(null)}>{tr(lang, 'Close')}</Button><Button kind="primary" renderIcon={iconFor('edit')} onClick={() => { setModal({ mode: 'edit', row: view }); setView(null); }}>{tr(lang, 'Edit')}</Button></>}>
          <StatusDot kind={view.status === 'Certified' ? 'success' : view.status === 'Review' ? 'warning' : 'gray'}>{tr(lang, view.status)} · {tr(lang, 'owner')} {view.owner}</StatusDot>
          <div className="w-fld"><label>{tr(lang, 'Business definition')}</label><div style={{ fontSize: '.8125rem', color: 'var(--cds-text-primary)' }}>{view.def}</div></div>
          <div className="w-fld"><label>{tr(lang, 'Formula')}</label><div className="ip-mono" style={{ fontSize: '.8125rem', background: 'var(--cds-gray-100)', color: '#f4f4f4', padding: 12, whiteSpace: 'pre-wrap' }}>{view.formula}</div></div>
          <div className="w-fld"><label>{tr(lang, 'Unit')}</label><div><Tag type="cool-gray" size="sm">{view.unit}</Tag></div></div>
          <div className="w-fld"><label>{tr(lang, 'Dimensions')}</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{['plant', 'line_id', 'shift', 'product_sku', 'date'].map((d) => <Tag key={d} type="cool-gray" size="sm">{d}</Tag>)}</div></div>
        </SidePanel>
      )}
    </div>
  );
}

/* ---------------- Semantic model editor ---------------- */
function TableBox({ t, pos, sel, onSelect, onDragStart }) {
  return (
    <div className={`md-tablebox ${t.fact ? 'fact' : ''} ${sel ? 'sel' : ''}`} style={{ left: pos.x, top: pos.y }} onClick={() => onSelect(t.id)}>
      <div className="md-tablebox__h" onPointerDown={onDragStart}><Icon name="data--base" size={16} />{t.title}</div>
      {t.rows.map((r, i) => (
        <div key={i} className={`md-tablebox__row ${r.pk ? 'pk' : ''}`}>
          {r.key && <Icon name="locked" size={16} className="key" />}{r.name}
          <span className="ip-mono" style={{ marginLeft: 'auto', fontSize: '.625rem', color: 'var(--cds-text-placeholder)' }}>{r.type}</span>
        </div>
      ))}
    </div>
  );
}

// starLayout positions fact tables down the centre and dimensions on the sides,
// producing a star/constellation arrangement from the real table list.
function starLayout(tables) {
  const facts = tables.filter((t) => t.fact);
  const dims = tables.filter((t) => !t.fact);
  const pos = {};
  facts.forEach((t, i) => { pos[t.id] = { x: 360, y: 80 + i * 320 }; });
  dims.forEach((t, i) => {
    const left = i % 2 === 0;
    const col = Math.floor(i / 2);
    pos[t.id] = { x: left ? 40 : 700, y: 40 + col * 230 };
  });
  return pos;
}

function SemanticModeler({ notify, lang }) {
  // Real star schema from GET /api/semantic-model (silver facts + dims + joins).
  const [model, setModel] = useState({ tables: [], joins: [] });
  const [pos, setPos] = useState({});
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.getSemanticModel()
      .then((m) => {
        if (!alive) return;
        const tables = m.tables || [];
        setModel({ tables, joins: m.joins || [] });
        setPos(starLayout(tables));
        setSel((s) => s || (tables.find((t) => t.fact)?.id) || tables[0]?.id || null);
      })
      .catch((err) => console.error('semantic model failed', err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const drag = (e, id) => {
    e.stopPropagation(); setSel(id);
    const p = pos[id]; if (!p) return; const ox = p.x, oy = p.y;
    startPointerDrag(e, (dx, dy) => setPos((s) => ({ ...s, [id]: { x: Math.max(0, snap(ox + dx)), y: Math.max(0, snap(oy + dy)) } })));
  };

  const selTable = useMemo(() => model.tables.find((t) => t.id === sel), [model, sel]);

  // Join lines connect a dimension's PK to the fact's FK (using table positions).
  const joinLines = model.joins.filter((j) => pos[j.from] && pos[j.to]);

  return (
    <div className="md-editor">
      <div className="w-etoolbar">
        <ToolBtn icon="data--base" label={`${model.tables.length} ${tr(lang, 'tables')} · ${model.joins.length} ${tr(lang, 'joins')}`} />
        <span className="spacer" />
        <ToolBtn icon="renew" label={tr(lang, 'Reload')} onClick={() => { setLoading(true); api.getSemanticModel().then((m) => { setModel({ tables: m.tables || [], joins: m.joins || [] }); setPos(starLayout(m.tables || [])); }).catch(() => {}).finally(() => setLoading(false)); }} />
        <ToolBtn icon="launch" label={tr(lang, 'Open in DataHub')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Open the dataset in DataHub for full lineage.') })} />
      </div>
      <div className="md-body">
        <div className="md-canvas">
          {loading && model.tables.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>{tr(lang, 'Loading star schema…')}</div>
          ) : model.tables.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>{tr(lang, 'No silver-layer fact/dimension tables found.')}</div>
          ) : (
            <>
              <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <g stroke="var(--cds-border-strong-01)" strokeWidth="1.5" fill="none">
                  {joinLines.map((j, i) => { const a = pos[j.to]; const b = pos[j.from]; return <line key={i} x1={a.x + 100} y1={a.y + 16} x2={b.x + 100} y2={b.y + 16} />; })}
                </g>
                <g fill="var(--cds-blue-60)">
                  {joinLines.map((j, i) => { const a = pos[j.to]; return <circle key={i} cx={a.x + 100} cy={a.y + 16} r="4" />; })}
                </g>
              </svg>
              {model.tables.map((t) => pos[t.id] && <TableBox key={t.id} t={t} pos={pos[t.id]} sel={sel === t.id} onSelect={setSel} onDragStart={(e) => drag(e, t.id)} />)}
            </>
          )}
        </div>
        <aside className="md-side">
          <div className="md-side__h">{selTable ? `${selTable.title} · ${selTable.fact ? tr(lang, 'fact') : tr(lang, 'dimension')}` : tr(lang, 'Select a table')}</div>
          <div className="md-side__body">
            {selTable && (
              <>
                <div className="w-fld"><label>{tr(lang, 'Columns')} ({selTable.rows.length})</label>
                  <div className="md-map">
                    {selTable.rows.map((c) => (
                      <div key={c.name} className="md-map__row">
                        <span className="phys">{c.key && <Icon name="locked" size={14} style={{ marginRight: 4 }} />}{c.name}</span>
                        <span className="biz"><Tag type={c.type === 'PK' ? 'teal' : c.type === 'FK' ? 'blue' : 'cool-gray'} size="sm">{c.type}</Tag></span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="w-fld"><label>{tr(lang, 'Relationships')}</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {model.joins.filter((j) => j.from === selTable.id || j.to === selTable.id).map((j, i) => (
                      <div key={i} className="ip-mono" style={{ fontSize: '.75rem', color: 'var(--cds-text-primary)' }}>{j.from}.{j.fromField} → {j.to}.{j.toField}</div>
                    ))}
                    {model.joins.filter((j) => j.from === selTable.id || j.to === selTable.id).length === 0 && <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>—</span>}
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

const MODELING_SUBS = [
  { id: 'metrics', label: 'Metrics store' },
  { id: 'semantic', label: 'Semantic model editor' },
  { id: 'studio', label: 'Modeling Studio' },
];
const MODELING_TITLES = {
  metrics: ['Metrics store', 'A governed catalog of business metrics — definitions, formulas, and ownership.'],
  semantic: ['Semantic model editor', 'Model star schemas, map physical tables to business names, and link field lineage.'],
  studio: ['Modeling Studio', 'Visual star-schema modeling that generates ETL scripts and an orchestration DAG.'],
};

export default function Modeling({ notify, lang }) {
  const [sub, setSub] = useState('metrics');
  const [t, s] = MODELING_TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader
        crumb={[tr(lang, 'Data Modeling & Semantics'), tr(lang, t)]}
        title={tr(lang, t)}
        sub={tr(lang, s)}
      />
      <SubSwitch items={trList(lang, MODELING_SUBS)} value={sub} onChange={setSub} />
      {sub === 'metrics' && <MetricsStore notify={notify} lang={lang} />}
      {sub === 'semantic' && <SemanticModeler notify={notify} lang={lang} />}
      {sub === 'studio' && <ModelingStudio notify={notify} lang={lang} />}
    </div>
  );
}
