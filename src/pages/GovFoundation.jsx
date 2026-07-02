import React, { useState } from 'react';
import {
  Button, Tag, TextInput, InlineNotification, InlineLoading,
  Tabs, TabList, Tab, TabPanels, TabPanel,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
  ProgressIndicator, ProgressStep,
  OverflowMenu, OverflowMenuItem,
  Toggle, Checkbox,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot } from '../components/shared.jsx';
import { Picker } from '../components/inputs.jsx';
import { tr, trList } from '../i18n.js';
import {
  GOV_DOMAINS,
  GF_ENTITIES, GF_SRC_MAP, GF_METHOD_TAG, GF_ID_PREVIEW, GF_CONFLICTS, GF_GRAPH_NODES,
  STD_NAMING, STD_CODING, STD_DOMAIN, STD_DICT, STD_TYPES, STD_VIOLATIONS, STD_IMPACT,
  BM_DIMS, BM_PROCESSES, BM_CONFORMED, BM_INCONSISTENCIES,
  AV_ASSETS, AV_CAT_LABEL, AV_ROI_DOMAINS,
  SG_SENS_FIELDS, SG_LEVEL_TAG, SG_CLASSIFY, SG_CLS_DIST, SG_SEMANTIC, SG_RULES,
} from '../data/mockData.js';

/* Governance Foundation (§ 治理底座): the platform-wide governance bedrock —
   entity resolution (OneID), enforced standards, conformed dimensions (bus
   matrix), asset value accounting, and AI-driven governance automation.
   Standards here are computation, not paperwork: they bind to Modeling
   Studio's validator, and non-compliant models cannot generate ETL. */

/* ============================ shared bits ============================ */

function DomainFilter({ value, onChange, lang, extra }) {
  return (
    <div className="gf-filterbar">
      <span className="lbl"><Icon name="filter" size={14} />{tr(lang, 'Subject domain')}</span>
      <div style={{ width: 220 }}>
        <Picker size="sm" items={GOV_DOMAINS.map((d) => tr(lang, d))} value={tr(lang, value)}
          onChange={(v) => onChange(GOV_DOMAINS[GOV_DOMAINS.map((d) => tr(lang, d)).indexOf(v)] || v)} />
      </div>
      {extra}
    </div>
  );
}

function ScoreBar({ value, max = 100 }) {
  const pct = (value / max) * 100;
  const color = pct >= 66 ? 'var(--cds-support-success)' : pct >= 33 ? 'var(--cds-support-warning)' : 'var(--cds-support-error)';
  return (
    <span className="gf-score">
      <span className="gf-score__bar"><span className="gf-score__fill" style={{ width: pct + '%', background: color }} /></span>
      <span className="gf-score__num">{value}{max === 100 ? '' : '/' + max}</span>
    </span>
  );
}

function Confidence({ value }) {
  return (
    <span className="gf-conf">
      <span className="gf-conf__bar"><span className="gf-conf__fill" style={{ width: value + '%' }} /></span>
      <span style={{ fontSize: '.75rem', fontFamily: 'var(--cds-font-mono)' }}>{value}%</span>
    </span>
  );
}

function Callout({ icon = 'idea', title, children }) {
  return (
    <div className="gf-callout">
      <span className="ic"><Icon name={icon} size={20} /></span>
      <div><div className="t">{title}</div><div className="d">{children}</div></div>
    </div>
  );
}

function Stars({ score }) {
  const n = Math.round(score / 20);
  return <span className="av-star">{Array.from({ length: 5 }).map((_, i) => <Icon key={i} name={i < n ? 'star--filled' : 'star'} size={13} />)}</span>;
}

/* Visual condition builder (field / op / value, AND-OR) — used to author
   OneID matching rules without writing SQL. */
function ConditionBuilder({ fields, ops = ['=', 'normalized =', 'similarity ≥'], initial, sql, lang }) {
  const [rows, setRows] = useState(initial || [{ field: fields[0], op: ops[0], value: '' }]);
  const [join, setJoin] = useState('AND');
  const update = (i, key, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const generated = sql || ('MATCH WHEN ' + rows.map((r) => `${r.field} ${r.op} ${r.value}`).join(`\n  ${join} `));
  return (
    <div className="w-cond">
      <div className="w-cond__grp">
        {rows.map((r, i) => (
          <div key={i}>
            {i > 0 && (
              <span className="w-cond__join">
                <button type="button" className="w-cond__pill" onClick={() => setJoin(join === 'AND' ? 'OR' : 'AND')}>{join}</button>
              </span>
            )}
            <div className="w-cond__row">
              <div style={{ width: 190 }}><Picker size="sm" items={fields} value={r.field} onChange={(v) => update(i, 'field', v)} /></div>
              <div style={{ width: 140 }}><Picker size="sm" items={ops} value={r.op} onChange={(v) => update(i, 'op', v)} /></div>
              <div style={{ width: 200 }}><TextInput id={`gf-cond-${i}`} labelText="" hideLabel size="sm" value={r.value} onChange={(e) => update(i, 'value', e.target.value)} /></div>
              <button type="button" className="x" aria-label="Remove condition" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="subtract" size={16} /></button>
            </div>
          </div>
        ))}
      </div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('add')} onClick={() => setRows((rs) => [...rs, { field: fields[0], op: ops[0], value: '' }])}>{tr(lang, 'Add condition')}</Button>
      <div className="w-cond__sql">{generated}</div>
    </div>
  );
}

/* ================================ OneID ================================ */

function OneIDDetail({ entity, onBack, notify, lang }) {
  const overview = (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <dl className="gf-dl">
        <dt>{tr(lang, 'Entity')}</dt><dd>{entity.type}</dd>
        <dt>{tr(lang, 'Business definition')}</dt><dd style={{ fontWeight: 400 }}>{entity.def}</dd>
        <dt>{tr(lang, 'Global ID strategy')}</dt><dd style={{ fontFamily: 'var(--cds-font-mono)' }}>{entity.strat}</dd>
        <dt>{tr(lang, 'Global entities')}</dt><dd>{entity.global}</dd>
        <dt>{tr(lang, 'Source systems')}</dt><dd style={{ display: 'flex', gap: 6 }}>{entity.systems.map((s) => <Tag key={s} type="cool-gray" size="sm">{s}</Tag>)}</dd>
      </dl>
      <Callout icon="interactions" title={tr(lang, 'Cross-source identity resolution — the same idea as IAM')}>
        {tr(lang, 'This unifies one business entity’s many native identifiers into a single global ID, exactly as an identity provider unifies a person’s accounts across systems.')}
      </Callout>
    </div>
  );
  const mappings = (
    <div style={{ marginTop: 8 }}>
      <CarbonTable withToolbar={false}
        headers={[
          { key: 'sys', header: tr(lang, 'Source system') },
          { key: 'field', header: tr(lang, 'Identifier field'), mono: true },
          { key: 'method', header: tr(lang, 'Mapping method') },
          { key: 'ex', header: tr(lang, 'Example'), mono: true },
        ]}
        rows={GF_SRC_MAP.map((r, i) => ({ ...r, id: String(i) }))}
        renderCell={(r, k) => (k === 'method'
          ? <Tag type={GF_METHOD_TAG[r.method]} size="sm">{tr(lang, r.method === 'direct' ? 'Direct map' : r.method === 'rule' ? 'Rule match' : 'Fuzzy match')}</Tag>
          : r[k])} />
    </div>
  );
  const rules = (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Exact rule — MES ↔ QMS')}</div>
      <ConditionBuilder lang={lang} fields={['MES.lot_no', 'QMS.batch_id', 'EAP.lotId', 'ERP.production_order']}
        initial={[{ field: 'MES.lot_no', op: 'normalized =', value: 'QMS.batch_id' }]}
        sql={'MATCH WHEN normalize(MES.lot_no) = normalize(QMS.batch_id)'} />
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Fuzzy rule — MES ↔ ERP (multi-field + similarity threshold)')}</div>
      <ConditionBuilder lang={lang} fields={['MES.lot_no', 'MES.product', 'ERP.production_order', 'ERP.item']}
        initial={[{ field: 'MES.product', op: '=', value: 'ERP.item' }, { field: 'MES.lot_no', op: 'similarity ≥', value: '0.85' }]} />
      <div><Button kind="tertiary" size="md" renderIcon={iconFor('save')} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Matching rules saved'), subtitle: entity.type })}>{tr(lang, 'Save rules')}</Button></div>
    </div>
  );
  const preview = (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', marginBottom: 10 }}>{tr(lang, 'Actual resolved mapping — global entity_id ↔ each source native_id, with match confidence.')}</div>
      <CarbonTable withToolbar={false}
        headers={[
          { key: 'gid', header: tr(lang, 'Global entity_id'), mono: true },
          { key: 'mes', header: 'MES', mono: true }, { key: 'qms', header: 'QMS', mono: true },
          { key: 'eap', header: 'EAP', mono: true }, { key: 'erp', header: 'ERP', mono: true },
          { key: 'conf', header: tr(lang, 'Confidence') },
        ]}
        rows={GF_ID_PREVIEW.map((r) => ({ ...r, id: r.gid }))}
        renderCell={(r, k) => (k === 'conf' ? <Confidence value={r.conf} /> : r[k])} />
    </div>
  );
  const conflicts = (
    <div style={{ marginTop: 8 }}>
      <InlineNotification kind="warning" lowContrast hideCloseButton
        title={`${GF_CONFLICTS.length} ${tr(lang, 'records need human adjudication')}`}
        subtitle={tr(lang, 'Unmatched, one-to-many, or below-threshold matches are held here for manual linking.')} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 12 }}>
        {GF_CONFLICTS.map((c, i) => (
          <div key={i} className="oid-conflict">
            <Icon name="warning--alt" size={18} style={{ color: 'var(--cds-support-warning)', flex: '0 0 18px' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--cds-font-mono)', fontSize: '.8125rem', color: 'var(--cds-text-primary)' }}>{c.native}</div>
              <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 2 }}>{c.issue}</div>
            </div>
            <Tag type="cool-gray" size="sm">{c.kind}</Tag>
            <Button kind="tertiary" size="sm" renderIcon={iconFor('interactions')} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Linked'), subtitle: tr(lang, 'Manual association recorded.') })}>{tr(lang, 'Link')}</Button>
            <Button kind="ghost" size="sm" onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Marked'), subtitle: tr(lang, 'Flagged for review.') })}>{tr(lang, 'Ignore')}</Button>
          </div>
        ))}
      </div>
    </div>
  );
  const graph = (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', marginBottom: 10 }}>{tr(lang, 'One global entity → its identity in each source + related entities.')}</div>
      <div className="oid-graph">
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {GF_GRAPH_NODES.filter((n) => !n.center).map((n, i) => (
            <line key={i} x1="50%" y1="50%" x2={n.x + '%'} y2={n.y + '%'} stroke="var(--cds-border-strong-01)" strokeWidth="1" />
          ))}
        </svg>
        {GF_GRAPH_NODES.map((n) => (
          <div key={n.nid} className={`oid-node ${n.center ? 'center' : ''}`} style={{ left: n.x + '%', top: n.y + '%' }}>
            <div className="sys">{n.sys}</div><div className="nid">{n.nid}</div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to entities')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 400, margin: 0 }}>{entity.type}</h1>
        <StatusDot kind={entity.status === 'Active' ? 'success' : 'draft'}>{tr(lang, entity.status)}</StatusDot>
        <Tag type="blue" size="sm">{entity.coverage}% {tr(lang, 'mapped')}</Tag>
      </div>
      <Tabs>
        <TabList aria-label="OneID entity detail">
          <Tab>{tr(lang, 'Overview')}</Tab><Tab>{tr(lang, 'Source mappings')}</Tab><Tab>{tr(lang, 'Matching rules')}</Tab>
          <Tab>{tr(lang, 'ID mapping preview')}</Tab><Tab>{`${tr(lang, 'Unmatched / conflicts')} (${GF_CONFLICTS.length})`}</Tab><Tab>{tr(lang, 'Relationship graph')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>{overview}</TabPanel><TabPanel>{mappings}</TabPanel><TabPanel>{rules}</TabPanel>
          <TabPanel>{preview}</TabPanel><TabPanel>{conflicts}</TabPanel><TabPanel>{graph}</TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

function OneID({ notify, lang }) {
  const [domain, setDomain] = useState('All subject domains');
  const [open, setOpen] = useState(null);
  const [modal, setModal] = useState(false);
  if (open) return <OneIDDetail entity={open} onBack={() => setOpen(null)} notify={notify} lang={lang} />;
  const stats = [
    { k: 'Avg coverage', v: '92%', icon: 'interactions' },
    { k: 'Global entities', v: '1.29M', icon: 'checkmark--filled' },
    { k: 'Conflicts', v: '47', icon: 'warning--alt' },
    { k: 'Awaiting review', v: '12', icon: 'user' },
  ];
  return (
    <div>
      <DomainFilter value={domain} onChange={setDomain} lang={lang} />
      <div className="w-stats" style={{ marginBottom: 24 }}>
        {stats.map((s) => (
          <div className="s" key={s.k}><div className="k"><Icon name={s.icon} size={16} />{tr(lang, s.k)}</div><div className="v">{s.v}</div></div>
        ))}
      </div>
      <CarbonTable
        searchPlaceholder={tr(lang, 'Search entities')}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal(true)}>{tr(lang, 'Define new entity')}</Button>}
        headers={[
          { key: 'type', header: tr(lang, 'Entity type') },
          { key: 'global', header: tr(lang, 'Global entities') },
          { key: 'sources', header: tr(lang, 'Mapped sources') },
          { key: 'coverage', header: tr(lang, 'Coverage') },
          { key: 'rules', header: tr(lang, 'Match rules') },
          { key: 'status', header: tr(lang, 'Status') },
          { key: 'ofw', header: '' },
        ]}
        rows={GF_ENTITIES}
        onRowClick={setOpen}
        renderCell={(r, k) => {
          if (k === 'type') return <span style={{ color: 'var(--cds-link-primary)', fontWeight: 500 }}>{r.type}</span>;
          if (k === 'sources') return `${r.sources} ${tr(lang, 'systems')}`;
          if (k === 'coverage') return <Confidence value={r.coverage} />;
          if (k === 'status') return <StatusDot kind={r.status === 'Active' ? 'success' : 'draft'}>{tr(lang, r.status)}</StatusDot>;
          if (k === 'ofw') {
            return (
              <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
                <OverflowMenuItem itemText={tr(lang, 'View')} onClick={(e) => { e.stopPropagation(); setOpen(r); }} />
                <OverflowMenuItem itemText={tr(lang, 'Edit mapping rules')} onClick={(e) => { e.stopPropagation(); setOpen(r); }} />
                <OverflowMenuItem itemText={tr(lang, 'View unmatched')} onClick={(e) => { e.stopPropagation(); setOpen(r); }} />
                <OverflowMenuItem itemText={tr(lang, 'Delete')} isDelete onClick={(e) => { e.stopPropagation(); notify && notify({ kind: 'warning', title: tr(lang, 'Delete entity?'), subtitle: r.type }); }} />
              </OverflowMenu>
            );
          }
          return r[k];
        }} />
      {modal && (
        <ComposedModal open size="sm" onClose={() => setModal(false)}>
          <ModalHeader label="OneID" title={tr(lang, 'Define new entity')} />
          <ModalBody hasForm>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="w-row">
                <TextInput id="gf-ent-type" labelText={tr(lang, 'Entity type')} placeholder="e.g. Reticle 光罩" />
                <Picker label={tr(lang, 'Subject domain')} items={['QMS', 'MES', 'EAP', 'ERP']} value="MES" onChange={() => {}} />
              </div>
              <TextInput id="gf-ent-def" labelText={tr(lang, 'Business definition')} placeholder={tr(lang, 'What this entity represents')} />
              <TextInput id="gf-ent-strat" labelText={tr(lang, 'Global ID strategy')} placeholder="ret_<plant>_<id>" />
              <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Next: source mappings & rules')} subtitle={tr(lang, 'After creating, map each source system’s identifier and define matching rules.')} />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" onClick={() => setModal(false)}>{tr(lang, 'Cancel')}</Button>
            <Button kind="primary" renderIcon={iconFor('save')} onClick={() => { setModal(false); notify && notify({ kind: 'success', title: tr(lang, 'Entity defined'), subtitle: tr(lang, 'Add source mappings next.') }); }}>{tr(lang, 'Create')}</Button>
          </ModalFooter>
        </ComposedModal>
      )}
    </div>
  );
}

/* ============================ Data Standards ============================ */

function StdTable({ headers, rows, renderCell, addLabel, notify, lang }) {
  return (
    <div style={{ marginTop: 8 }}>
      <CarbonTable
        searchPlaceholder={tr(lang, 'Search standards')}
        actions={(
          <>
            <Button kind="ghost" size="lg" renderIcon={iconFor('upload')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Import') })}>{tr(lang, 'Import')}</Button>
            <Button kind="ghost" size="lg" renderIcon={iconFor('export')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Export') })}>{tr(lang, 'Export')}</Button>
            <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, addLabel) })}>{tr(lang, addLabel)}</Button>
          </>
        )}
        headers={headers} rows={rows} renderCell={renderCell} />
    </div>
  );
}

function ComplianceCheck({ notify, lang }) {
  const [phase, setPhase] = useState('idle');
  const [model, setModel] = useState('gold.spc_capability_daily');
  const run = () => { setPhase('running'); setTimeout(() => setPhase('done'), 1200); };
  const steps = [
    ['Bind', 'Standards bind to Modeling Studio', 'Naming, coding, domain rules attach to the model validator.'],
    ['Validate', 'Checked on every save', 'The model is scanned against all active standards in real time.'],
    ['Block', 'Non-compliant → no ETL', 'The codegen step refuses to emit pipelines until violations are fixed.'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Callout icon="locked" title={tr(lang, 'Governance is computation, not paperwork')}>
        {tr(lang, 'These standards are enforced automatically at modeling time. A model that fails validation cannot generate ETL — the codegen validator blocks it.')}
      </Callout>
      <div className="ds2-flow">
        {steps.map((s, i) => (
          <div key={s[0]} style={{ display: 'contents' }}>
            <div className="ds2-flow__step">
              <div className="n">{tr(lang, 'Step')} {i + 1}</div>
              <div className="t">{tr(lang, s[1])}</div>
              <div className="d">{tr(lang, s[2])}</div>
            </div>
            {i < steps.length - 1 && <div className="ds2-flow__arrow"><Icon name="arrow--right" size={18} /></div>}
          </div>
        ))}
      </div>
      <div style={{ border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--wire-border)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '.8125rem', fontWeight: 600 }}>{tr(lang, 'Run compliance check')}</span>
          <div style={{ width: 280 }}>
            <Picker size="sm" items={['gold.spc_capability_daily', 'gold.agg_yield_daily', 'silver.spc_measurements']} value={model} onChange={setModel} />
          </div>
          <Button kind="primary" size="sm" renderIcon={iconFor('play--outline')} onClick={run} disabled={phase === 'running'} style={{ marginLeft: 'auto' }}>
            {phase === 'running' ? tr(lang, 'Scanning…') : tr(lang, 'Run validation')}
          </Button>
        </div>
        {phase === 'idle' && <div style={{ padding: 16, fontSize: '.8125rem', color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'Pick a model and run to see standard violations.')}</div>}
        {phase === 'running' && <div style={{ padding: 16 }}><InlineLoading description={tr(lang, 'Checking fields against active standards…')} /></div>}
        {phase === 'done' && (
          <div>
            <div style={{ padding: '10px 16px', background: 'rgba(218,30,40,.06)', borderBottom: '1px solid var(--wire-border)', fontSize: '.8125rem', color: 'var(--cds-support-error)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="error--filled" size={16} />{tr(lang, '2 violations — this model cannot generate ETL until fixed.')}
            </div>
            <div className="ds2-viol">
              {STD_VIOLATIONS.map((v, i) => (
                <div key={i} className={`ds2-viol__row ${v.ok ? 'ok' : ''}`}>
                  <Icon name={v.ok ? 'checkmark--filled' : 'error--filled'} size={18} style={{ color: v.ok ? 'var(--cds-support-success)' : 'var(--cds-support-error)', flex: '0 0 18px', marginTop: 1 }} />
                  <div style={{ flex: 1 }}>
                    <div className="ds2-code" style={{ fontWeight: 600 }}>{v.field}</div>
                    <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 2 }}>{v.rule}</div>
                    {v.fix && <div style={{ fontSize: '.75rem', color: 'var(--cds-support-error)', marginTop: 4 }}>{tr(lang, 'Fix')}: {v.fix}</div>}
                  </div>
                  {!v.ok && <Button kind="tertiary" size="sm" onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Fix applied'), subtitle: v.fix })}>{tr(lang, 'Auto-fix')}</Button>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeImpact({ notify, lang }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Change a standard to preview which existing models and tables must be remediated.')}</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 320 }}>
          <Picker label={tr(lang, 'Standard to change')} size="sm" items={['Field case — lower_snake_case', 'Defect code — D-2xx', 'Dimension prefix — dim_*']} value="Field case — lower_snake_case" onChange={() => {}} />
        </div>
        <Button kind="tertiary" size="md" renderIcon={iconFor('renew')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Impact analysis complete'), subtitle: tr(lang, '3 models require remediation.') })}>{tr(lang, 'Analyze impact')}</Button>
      </div>
      <InlineNotification kind="warning" lowContrast hideCloseButton title={tr(lang, '3 models need remediation if this standard changes')} subtitle={tr(lang, 'Tightening the case rule to reject mixed-case would flag the following.')} />
      <CarbonTable withToolbar={false}
        headers={[
          { key: 'model', header: tr(lang, 'Model / table'), mono: true },
          { key: 'domain', header: tr(lang, 'Domain') },
          { key: 'fields', header: tr(lang, 'Non-compliant fields') },
          { key: 'owner', header: tr(lang, 'Owner') },
        ]}
        rows={STD_IMPACT.map((r) => ({ ...r, id: r.model }))}
        renderCell={(r, k) => (k === 'fields' ? <Tag type="red" size="sm">{r.fields}</Tag> : r[k])} />
    </div>
  );
}

function DataStandards({ notify, lang }) {
  const [domain, setDomain] = useState('All subject domains');
  const toggleCell = (r) => <Toggle id={`gf-std-${r.id}-${r.name || r.field || r.term}`} size="sm" labelText="" hideLabel defaultToggled={r.on} />;
  return (
    <div>
      <DomainFilter value={domain} onChange={setDomain} lang={lang} />
      <Tabs>
        <TabList aria-label="Data standards">
          <Tab>{tr(lang, 'Naming')}</Tab><Tab>{tr(lang, 'Coding')}</Tab><Tab>{tr(lang, 'Value domains')}</Tab>
          <Tab>{tr(lang, 'Data dictionary')}</Tab><Tab>{tr(lang, 'Data types')}</Tab>
          <Tab>{tr(lang, 'Enforcement & compliance')}</Tab><Tab>{tr(lang, 'Change impact')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <StdTable notify={notify} lang={lang} addLabel="Add naming rule"
              headers={[
                { key: 'name', header: tr(lang, 'Rule') }, { key: 'pattern', header: tr(lang, 'Pattern'), mono: true },
                { key: 'scope', header: tr(lang, 'Scope') }, { key: 'ex', header: tr(lang, 'Example'), mono: true },
                { key: 'on', header: tr(lang, 'Enabled') },
              ]}
              rows={STD_NAMING} renderCell={(r, k) => (k === 'on' ? toggleCell(r) : r[k])} />
          </TabPanel>
          <TabPanel>
            <StdTable notify={notify} lang={lang} addLabel="Add code set"
              headers={[
                { key: 'name', header: tr(lang, 'Code set') }, { key: 'code', header: tr(lang, 'Values'), mono: true },
                { key: 'mean', header: tr(lang, 'Meaning') }, { key: 'on', header: tr(lang, 'Enabled') },
              ]}
              rows={STD_CODING} renderCell={(r, k) => (k === 'on' ? toggleCell(r) : r[k])} />
          </TabPanel>
          <TabPanel>
            <StdTable notify={notify} lang={lang} addLabel="Add value domain"
              headers={[
                { key: 'field', header: tr(lang, 'Field'), mono: true }, { key: 'domain', header: tr(lang, 'Allowed domain') },
                { key: 'note', header: tr(lang, 'Note') }, { key: 'on', header: tr(lang, 'Enabled') },
              ]}
              rows={STD_DOMAIN} renderCell={(r, k) => (k === 'on' ? toggleCell(r) : r[k])} />
          </TabPanel>
          <TabPanel>
            <StdTable notify={notify} lang={lang} addLabel="Add term"
              headers={[
                { key: 'term', header: tr(lang, 'Business term') }, { key: 'field', header: tr(lang, 'Standard field'), mono: true },
                { key: 'type', header: tr(lang, 'Type'), mono: true }, { key: 'def', header: tr(lang, 'Definition') },
              ]}
              rows={STD_DICT} renderCell={(r, k) => r[k]} />
          </TabPanel>
          <TabPanel>
            <StdTable notify={notify} lang={lang} addLabel="Add type standard"
              headers={[
                { key: 'concept', header: tr(lang, 'Concept') }, { key: 'type', header: tr(lang, 'Standard type'), mono: true },
                { key: 'note', header: tr(lang, 'Note') },
              ]}
              rows={STD_TYPES} renderCell={(r, k) => r[k]} />
          </TabPanel>
          <TabPanel><div style={{ marginTop: 8 }}><ComplianceCheck notify={notify} lang={lang} /></div></TabPanel>
          <TabPanel><div style={{ marginTop: 8 }}><ChangeImpact notify={notify} lang={lang} /></div></TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

/* ============================== Bus Matrix ============================== */

function BusMatrixView({ notify, lang }) {
  const [cell, setCell] = useState(null);
  const rowsByDomain = {};
  BM_PROCESSES.forEach((p) => { (rowsByDomain[p.dom] = rowsByDomain[p.dom] || []).push(p); });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Callout icon="grid" title={tr(lang, 'Conformed dimensions make cross-domain comparison possible')}>
        {tr(lang, 'Every business process references the same shared dimensions. Because QMS, MES, and EAP all join to the same Product and Date dimensions, their facts are directly comparable — that is the whole point of the bus matrix.')}
      </Callout>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button kind="tertiary" size="sm" renderIcon={iconFor('add')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Add business process') })}>{tr(lang, 'Add process')}</Button>
        <Button kind="tertiary" size="sm" renderIcon={iconFor('add')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Add conformed dimension') })}>{tr(lang, 'Add dimension')}</Button>
      </div>
      <div style={{ overflow: 'auto', border: '1px solid var(--wire-border)' }}>
        <table className="bm-matrix">
          <thead>
            <tr><th className="rowhead" style={{ minWidth: 200 }}>{tr(lang, 'Business process')}</th>{BM_DIMS.map((d) => <th key={d}>{tr(lang, d)}</th>)}</tr>
          </thead>
          <tbody>
            {Object.entries(rowsByDomain).map(([dom, procs]) => (
              <React.Fragment key={dom}>
                <tr><td className="bm-domband" colSpan={BM_DIMS.length + 1}>{dom}</td></tr>
                {procs.map((p) => (
                  <tr key={p.name}>
                    <td className="rowhead">{tr(lang, p.name)}<span className="dom">{p.dom}</span></td>
                    {p.use.map((u, i) => (
                      <td key={i} className="bm-cell" onClick={() => setCell({ p: p.name, d: BM_DIMS[i], on: u })}>
                        {u ? <span className="mk"><Icon name="checkmark" size={13} /></span> : ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {cell && (
        <ComposedModal open size="sm" onClose={() => setCell(null)}>
          <ModalHeader label={tr(lang, 'Bus matrix cell')} title={`${tr(lang, cell.p)} × ${tr(lang, cell.d)}`} />
          <ModalBody>
            <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', marginBottom: 14 }}>
              {tr(lang, 'Does this business process reference the')} <b>{tr(lang, cell.d)}</b> {tr(lang, 'conformed dimension?')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Tag type={cell.on ? 'green' : 'cool-gray'} size="md">{tr(lang, cell.on ? 'Referenced' : 'Not referenced')}</Tag>
              <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>
                {tr(lang, 'Uses conformed dimension')} <span style={{ fontFamily: 'var(--cds-font-mono)' }}>dim_{cell.d.toLowerCase()}</span>
              </span>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" onClick={() => setCell(null)}>{tr(lang, 'Close')}</Button>
            <Button kind="primary" renderIcon={iconFor('save')} onClick={() => { setCell(null); notify && notify({ kind: 'success', title: tr(lang, 'Updated'), subtitle: `${cell.p} × ${cell.d}` }); }}>{tr(lang, 'Save')}</Button>
          </ModalFooter>
        </ComposedModal>
      )}
    </div>
  );
}

function ConformedDims({ notify, lang }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InlineNotification kind="info" lowContrast hideCloseButton
        title={tr(lang, 'Facts may only reference these shared dimensions')}
        subtitle={tr(lang, 'A domain cannot create its own duplicate dimension. Attempting to build a new “product” dimension is blocked and routed to the conformed Product dimension.')} />
      <CarbonTable
        searchPlaceholder={tr(lang, 'Search dimensions')}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'New conformed dimension') })}>{tr(lang, 'New dimension')}</Button>}
        headers={[
          { key: 'name', header: tr(lang, 'Dimension') }, { key: 'grain', header: tr(lang, 'Grain') },
          { key: 'scd', header: tr(lang, 'SCD type') }, { key: 'shared', header: tr(lang, 'Shared by') },
          { key: 'refs', header: tr(lang, 'Referenced by') }, { key: 'owner', header: tr(lang, 'Owner') },
          { key: 'ofw', header: '' },
        ]}
        rows={BM_CONFORMED.map((r) => ({ ...r, id: r.name }))}
        renderCell={(r, k) => {
          if (k === 'name') return <span style={{ color: 'var(--cds-link-primary)', fontFamily: 'var(--cds-font-mono)', fontSize: '.8125rem' }}>dim_{r.name.toLowerCase()}</span>;
          if (k === 'scd') return <Tag type="cool-gray" size="sm">{r.scd}</Tag>;
          if (k === 'shared') return `${r.shared} ${tr(lang, 'processes')}`;
          if (k === 'ofw') {
            return (
              <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
                <OverflowMenuItem itemText={tr(lang, 'View definition')} onClick={() => notify && notify({ kind: 'info', title: r.name, subtitle: tr(lang, 'Definition, hierarchy, lineage.') })} />
                <OverflowMenuItem itemText={tr(lang, 'View lineage')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Lineage'), subtitle: r.name })} />
              </OverflowMenu>
            );
          }
          return r[k];
        }} />
    </div>
  );
}

function ConsistencyCheck({ notify, lang }) {
  const [phase, setPhase] = useState('idle');
  const run = () => { setPhase('running'); setTimeout(() => setPhase('done'), 1200); };
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Scan domain models for duplicate or inconsistent dimensions that should be merged into a conformed dimension.')}</div>
      <div>
        <Button kind="primary" size="md" renderIcon={iconFor('play--outline')} onClick={run} disabled={phase === 'running'}>
          {phase === 'running' ? tr(lang, 'Scanning…') : tr(lang, 'Run consistency scan')}
        </Button>
      </div>
      {phase === 'running' && <InlineLoading description={tr(lang, 'Scanning domain models…')} />}
      {phase === 'done' && (
        <>
          <InlineNotification kind="warning" lowContrast hideCloseButton
            title={tr(lang, '2 inconsistencies found')}
            subtitle={tr(lang, 'Two domains built their own product dimension instead of referencing the conformed one.')} />
          {BM_INCONSISTENCIES.map((c, i) => (
            <div key={i} style={{ border: '1px solid var(--wire-border)', borderLeft: '3px solid var(--cds-support-warning)', background: 'var(--cds-layer-02)', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Icon name="warning--alt" size={18} style={{ color: 'var(--cds-support-warning)', flex: '0 0 18px' }} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-primary)', fontWeight: 500 }}>{tr(lang, c.issue)}</div>
                <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 2, fontFamily: 'var(--cds-font-mono)' }}>{c.a} ↔ {c.b}</div>
              </div>
              <Button kind="tertiary" size="sm" renderIcon={iconFor('interactions')} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Merge proposed'), subtitle: tr(lang, c.act) })}>{tr(lang, c.act)}</Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function BusMatrix({ notify, lang }) {
  const [domain, setDomain] = useState('All subject domains');
  return (
    <div>
      <DomainFilter value={domain} onChange={setDomain} lang={lang} />
      <Tabs>
        <TabList aria-label="Bus matrix">
          <Tab>{tr(lang, 'Bus matrix')}</Tab><Tab>{tr(lang, 'Conformed dimensions')}</Tab><Tab>{tr(lang, 'Consistency check')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel><div style={{ marginTop: 8 }}><BusMatrixView notify={notify} lang={lang} /></div></TabPanel>
          <TabPanel><ConformedDims notify={notify} lang={lang} /></TabPanel>
          <TabPanel><ConsistencyCheck notify={notify} lang={lang} /></TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

/* ============================ Asset Inventory ============================ */

function AssetDetail({ asset, onBack, notify, lang }) {
  const radar = [['Usage heat', 88], ['Downstream deps', 76], ['Quality', asset.quality], ['Freshness', 92], ['Breadth', 64]];
  const overview = (
    <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      <div>
        <div style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--cds-text-secondary)', marginBottom: 12 }}>{tr(lang, 'VALUE SCORE COMPOSITION')}</div>
        <div className="gf-radar">
          {radar.map(([k, v]) => (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 34px', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, k)}</span>
              <span style={{ height: 8, background: 'var(--cds-layer-01)', position: 'relative' }}>
                <span style={{ position: 'absolute', inset: '0 auto 0 0', width: v + '%', background: 'var(--cds-blue-60)' }} />
              </span>
              <span style={{ fontFamily: 'var(--cds-font-mono)', fontSize: '.75rem', textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Composite')}</span>
          <ScoreBar value={asset.score} /><Stars score={asset.score} />
        </div>
      </div>
      <div>
        <div style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--cds-text-secondary)', marginBottom: 12 }}>{tr(lang, 'COST TREND (6 MONTHS)')}</div>
        <div className="av-costbars">
          {[[30, 20], [34, 22], [40, 26], [44, 30], [48, 34], [52, 38]].map((c, i) => (
            <div key={i} className="c"><div className="cp" style={{ height: c[1] }} /><div className="s" style={{ height: c[0] }} /><div className="lb">M{i + 1}</div></div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 12, fontSize: '.75rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, background: 'var(--cds-blue-60)' }} />{tr(lang, 'Storage')} {asset.storage}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, background: '#78a9ff' }} />{tr(lang, 'Compute')} {asset.compute}/mo</span>
        </div>
      </div>
    </div>
  );
  const downstream = (
    <div style={{ marginTop: 8 }}>
      <div className="w-stats" style={{ marginBottom: 16 }}>
        <div className="s"><div className="k">{tr(lang, 'Downstream assets')}</div><div className="v">{asset.deps}</div></div>
        <div className="s"><div className="k">APIs</div><div className="v">4</div></div>
        <div className="s"><div className="k">{tr(lang, 'Dashboards')}</div><div className="v">9</div></div>
        <div className="s"><div className="k">{tr(lang, 'Agent flows')}</div><div className="v">3</div></div>
      </div>
      <div className="w-ph" style={{ height: 180 }}><span className="lbl"><Icon name="share" size={14} />downstream dependency graph · {asset.name}</span></div>
    </div>
  );
  const advice = (
    <div style={{ marginTop: 8 }}>
      {asset.cat === 'zombie'
        ? <Callout icon="warning--alt" title={tr(lang, 'Archive candidate')}>{tr(lang, 'No queries in a long time and no downstream dependencies. Recommended action: archive with a 90-day retention window.')}</Callout>
        : asset.cat === 'costly'
          ? <Callout icon="warning--alt" title={tr(lang, 'Optimization candidate')}>{tr(lang, 'High cost relative to value score. Consider partitioning, compaction, or a shorter retention.')}</Callout>
          : <Callout icon="checkmark--filled" title={tr(lang, 'Healthy, high-value asset')}>{tr(lang, 'Strong usage and downstream breadth. No action needed — keep monitoring cost.')}</Callout>}
    </div>
  );
  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to inventory')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 400, margin: 0, fontFamily: 'var(--cds-font-mono)' }}>{asset.name}</h1>
        <Tag type="cool-gray" size="sm">{asset.dom}</Tag><Tag type="cool-gray" size="sm">{asset.layer}</Tag>
        <span className={`av-tag ${asset.cat}`}>{tr(lang, AV_CAT_LABEL[asset.cat])}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
          <Button kind="tertiary" size="md" renderIcon={iconFor('share')}>{tr(lang, 'Lineage')}</Button>
          <Button kind="tertiary" size="md" renderIcon={iconFor('folder')} onClick={() => notify && notify({ kind: 'warning', title: tr(lang, 'Archive asset?'), subtitle: `${asset.name} — ${tr(lang, '90-day retention.')}` })}>{tr(lang, 'Archive')}</Button>
        </div>
      </div>
      <Tabs>
        <TabList aria-label="Asset detail">
          <Tab>{tr(lang, 'Value & cost')}</Tab><Tab>{tr(lang, 'Downstream impact')}</Tab><Tab>{tr(lang, 'Governance advice')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>{overview}</TabPanel><TabPanel>{downstream}</TabPanel><TabPanel>{advice}</TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

function ArchiveWizard({ onClose, onDone, notify, lang }) {
  const [step, setStep] = useState(0);
  const steps = [['Select assets', 'Zombie assets'], ['Retention', 'Policy'], ['Approval', 'Sign-off']];
  const last = step === steps.length - 1;
  return (
    <ComposedModal open size="md" onClose={onClose}>
      <ModalHeader label={tr(lang, 'Governance action')} title={tr(lang, 'Bulk archive zombie assets')} />
      <ModalBody hasForm>
        <ProgressIndicator currentIndex={step} spaceEqually style={{ marginBottom: 20 }}>
          {steps.map((s, i) => <ProgressStep key={s[0]} label={tr(lang, s[0])} secondaryLabel={tr(lang, s[1])} onClick={() => setStep(i)} />)}
        </ProgressIndicator>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {step === 0 && (
            <>
              <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, '2 assets have no downstream dependencies and no queries in 90+ days.')}</div>
              {AV_ASSETS.filter((a) => a.cat === 'zombie').map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)' }}>
                  <Checkbox id={`gf-arch-${a.id}`} labelText="" defaultChecked />
                  <span style={{ fontFamily: 'var(--cds-font-mono)', fontSize: '.8125rem', flex: 1 }}>{a.name}</span>
                  <Tag type="cool-gray" size="sm">{a.storage}</Tag>
                  <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{a.last}</span>
                </div>
              ))}
              <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Estimated monthly saving')} subtitle={tr(lang, '$520/mo compute + 166 GB storage reclaimed.')} />
            </>
          )}
          {step === 1 && (
            <>
              <Picker label={tr(lang, 'Retention period')} items={['30 days', '90 days', '180 days', '1 year']} value="90 days" onChange={() => {}} />
              <Picker label={tr(lang, 'After retention')} items={['Permanently delete', 'Move to cold storage']} value="Move to cold storage" onChange={() => {}} />
              <InlineNotification kind="warning" lowContrast hideCloseButton title={tr(lang, 'Reversible during retention')} subtitle={tr(lang, 'Archived assets can be restored until the retention window ends.')} />
            </>
          )}
          {step === 2 && (
            <>
              <Picker label={tr(lang, 'Approver')} items={['Data Governance Lead', 'Platform Owner']} value="Data Governance Lead" onChange={() => {}} />
              <TextInput id="gf-arch-just" labelText={tr(lang, 'Justification')} defaultValue="No downstream, 90+ days idle — cost reduction." />
            </>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>{tr(lang, step === 0 ? 'Cancel' : 'Back')}</Button>
        <Button kind="primary" renderIcon={iconFor(last ? 'checkmark' : 'arrow--right')}
          onClick={last
            ? () => { onDone(); notify && notify({ kind: 'success', title: tr(lang, 'Archive submitted for approval'), subtitle: tr(lang, '2 assets · 90-day retention.') }); }
            : () => setStep((s) => s + 1)}>
          {tr(lang, last ? 'Submit for approval' : 'Next')}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

function InventoryList({ onOpen, onArchive, notify, lang }) {
  const [filter, setFilter] = useState('All');
  const filterItems = ['All', 'High value', 'Zombie', 'Costly / low-value'];
  const rows = AV_ASSETS.filter((a) => filter === 'All' || (filter === 'Zombie' ? a.cat === 'zombie' : filter === 'High value' ? a.cat === 'high' : a.cat === 'costly'));
  return (
    <CarbonTable
      searchPlaceholder={tr(lang, 'Search assets')}
      filters={[{ items: filterItems.map((f) => tr(lang, f)), value: tr(lang, filter), onChange: (v) => setFilter(filterItems[filterItems.map((f) => tr(lang, f)).indexOf(v)] || 'All') }]}
      actions={<Button kind="tertiary" size="lg" renderIcon={iconFor('folder')} onClick={onArchive}>{tr(lang, 'Bulk archive')}</Button>}
      headers={[
        { key: 'name', header: tr(lang, 'Asset'), mono: true },
        { key: 'dom', header: tr(lang, 'Domain') },
        { key: 'layer', header: tr(lang, 'Layer') },
        { key: 'heat', header: tr(lang, 'Heat (30d)') },
        { key: 'storage', header: tr(lang, 'Storage') },
        { key: 'compute', header: tr(lang, 'Compute/mo') },
        { key: 'deps', header: tr(lang, 'Downstream') },
        { key: 'quality', header: tr(lang, 'Quality') },
        { key: 'score', header: tr(lang, 'Value score') },
        { key: 'ofw', header: '' },
      ]}
      rows={rows}
      onRowClick={onOpen}
      renderCell={(r, k) => {
        if (k === 'name') return <span style={{ color: 'var(--cds-link-primary)', fontFamily: 'var(--cds-font-mono)', fontSize: '.8125rem' }}>{r.name}</span>;
        if (k === 'layer') return <Tag type="cool-gray" size="sm">{r.layer}</Tag>;
        if (k === 'quality') return <ScoreBar value={r.quality} />;
        if (k === 'score') {
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <ScoreBar value={r.score} />
              <span className={`av-tag ${r.cat}`}>{tr(lang, r.cat === 'high' ? 'High' : r.cat === 'zombie' ? 'Zombie' : 'Costly')}</span>
            </span>
          );
        }
        if (k === 'ofw') {
          return (
            <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
              <OverflowMenuItem itemText={tr(lang, 'View detail')} onClick={(e) => { e.stopPropagation(); onOpen(r); }} />
              <OverflowMenuItem itemText={tr(lang, 'View lineage')} onClick={(e) => { e.stopPropagation(); notify && notify({ kind: 'info', title: tr(lang, 'Lineage'), subtitle: r.name }); }} />
              <OverflowMenuItem itemText={tr(lang, 'Assign owner')} onClick={(e) => { e.stopPropagation(); notify && notify({ kind: 'info', title: tr(lang, 'Owner'), subtitle: r.owner }); }} />
              <OverflowMenuItem itemText={tr(lang, 'Mark for archive')} isDelete onClick={(e) => { e.stopPropagation(); notify && notify({ kind: 'warning', title: tr(lang, 'Archive asset?'), subtitle: r.name }); }} />
            </OverflowMenu>
          );
        }
        return r[k];
      }} />
  );
}

function ROIReport({ lang }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="w-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="s"><div className="k"><Icon name="chart--line" size={16} />{tr(lang, 'Estimated data asset value')}</div><div className="v">$4.8M</div><div className="d">{tr(lang, 'Modeled from decisions enabled + reuse')}</div></div>
        <div className="s"><div className="k"><Icon name="data--base" size={16} />{tr(lang, 'Annual platform cost')}</div><div className="v">$610k</div><div className="d">{tr(lang, 'Storage + compute + ops')}</div></div>
        <div className="s"><div className="k"><Icon name="checkmark--filled" size={16} />{tr(lang, 'Return on data')}</div><div className="v">7.9×</div><div className="d">{tr(lang, 'Value ÷ cost')}</div></div>
      </div>
      <div style={{ border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)', padding: 18 }}>
        <div style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--cds-text-secondary)', marginBottom: 14 }}>{tr(lang, 'VALUE VS COST BY DOMAIN')}</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, height: 160 }}>
          {AV_ROI_DOMAINS.map((d) => (
            <div key={d[0]} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', justifyContent: 'center', height: 130 }}>
                <div style={{ width: 18, height: d[1] + '%', background: 'var(--cds-support-success)' }} />
                <div style={{ width: 18, height: d[2] + '%', background: 'var(--cds-support-warning)' }} />
              </div>
              <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 6 }}>{d[0]}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: '.75rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, background: 'var(--cds-support-success)' }} />{tr(lang, 'Value')}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, background: 'var(--cds-support-warning)' }} />{tr(lang, 'Cost')}</span>
        </div>
      </div>
    </div>
  );
}

function AssetInventory({ notify, lang }) {
  const [domain, setDomain] = useState('All subject domains');
  const [open, setOpen] = useState(null);
  const [archive, setArchive] = useState(false);
  if (open) return <AssetDetail asset={open} onBack={() => setOpen(null)} notify={notify} lang={lang} />;
  const stats = [
    ['data--base', 'Total assets', '1,842'], ['folder', 'Storage', '4.2 TB'], ['chart--line', 'Monthly compute', '$51k'],
    ['warning--alt', 'Zombie assets', '64'], ['star--filled', 'High-value', '312'],
  ];
  return (
    <div>
      <DomainFilter value={domain} onChange={setDomain} lang={lang}
        extra={<Button kind="ghost" size="sm" renderIcon={iconFor('download')} style={{ marginLeft: 'auto' }} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'ROI report exported'), subtitle: tr(lang, 'PDF generated for management.') })}>{tr(lang, 'Export ROI report')}</Button>} />
      <div className="w-stats" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginBottom: 24 }}>
        {stats.map(([icon, k, v]) => (
          <div className="s" key={k}><div className="k"><Icon name={icon} size={16} />{tr(lang, k)}</div><div className="v">{v}</div></div>
        ))}
      </div>
      <Tabs>
        <TabList aria-label="Asset inventory">
          <Tab>{tr(lang, 'Inventory')}</Tab><Tab>{tr(lang, 'ROI / value report')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel><div style={{ marginTop: 8 }}><InventoryList onOpen={setOpen} onArchive={() => setArchive(true)} notify={notify} lang={lang} /></div></TabPanel>
          <TabPanel><ROIReport lang={lang} /></TabPanel>
        </TabPanels>
      </Tabs>
      {archive && <ArchiveWizard onClose={() => setArchive(false)} onDone={() => setArchive(false)} notify={notify} lang={lang} />}
    </div>
  );
}

/* =========================== Smart Governance =========================== */

const SG_STATUS_MAP = { pending: { k: 'warning', l: 'Pending' }, confirmed: { k: 'success', l: 'Confirmed' }, ignored: { k: 'gray', l: 'Ignored' } };

function SensitiveDetection({ notify, lang }) {
  const [rows, setRows] = useState(SG_SENS_FIELDS);
  const set = (id, status) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Callout icon="watson" title={tr(lang, 'AI scans field names + sample values to find sensitive data')}>
        {tr(lang, 'Suspected sensitive fields are surfaced for human confirmation. Once confirmed, row/column masking policies are applied automatically through the existing ACL classification — no manual policy wiring.')}
      </Callout>
      <CarbonTable
        searchPlaceholder={tr(lang, 'Search fields')}
        actions={<Button kind="tertiary" size="lg" renderIcon={iconFor('watson')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Rescan started'), subtitle: tr(lang, 'AI scanning all bronze + silver fields…') })}>{tr(lang, 'Rescan')}</Button>}
        headers={[
          { key: 'field', header: tr(lang, 'Field'), mono: true },
          { key: 'table', header: tr(lang, 'Table'), mono: true },
          { key: 'type', header: tr(lang, 'AI-detected type') },
          { key: 'conf', header: tr(lang, 'Confidence') },
          { key: 'level', header: tr(lang, 'Suggested level') },
          { key: 'status', header: tr(lang, 'Status') },
          { key: 'act', header: '' },
        ]}
        rows={rows}
        renderCell={(r, k) => {
          if (k === 'conf') return <Confidence value={r.conf} />;
          if (k === 'level') return <Tag type={SG_LEVEL_TAG[r.level]} size="sm">{tr(lang, r.level)}</Tag>;
          if (k === 'status') return <StatusDot kind={SG_STATUS_MAP[r.status].k}>{tr(lang, SG_STATUS_MAP[r.status].l)}</StatusDot>;
          if (k === 'act') {
            return r.status === 'pending' ? (
              <span style={{ display: 'flex', gap: 4 }}>
                <Button kind="tertiary" size="sm" renderIcon={iconFor('checkmark')} onClick={(e) => { e.stopPropagation(); set(r.id, 'confirmed'); notify && notify({ kind: 'success', title: tr(lang, 'Classification applied'), subtitle: `${r.field} → ${r.level} · ${tr(lang, 'masking enabled.')}` }); }}>{tr(lang, 'Approve')}</Button>
                <Button kind="ghost" size="sm" onClick={(e) => { e.stopPropagation(); set(r.id, 'ignored'); }}>{tr(lang, 'Ignore')}</Button>
              </span>
            ) : <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>{tr(lang, r.status === 'confirmed' ? '✓ masking active' : 'dismissed')}</span>;
          }
          return r[k];
        }} />
    </div>
  );
}

function AutoClassify({ notify, lang }) {
  return (
    <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 20 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', marginBottom: 4 }}>
          <span style={{ fontSize: '.8125rem', fontWeight: 600, flex: 1 }}>{tr(lang, 'AI batch classification suggestions')}</span>
          <Button kind="primary" size="sm" renderIcon={iconFor('checkmark')} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Batch confirmed'), subtitle: tr(lang, '4 classifications applied.') })}>{tr(lang, 'Confirm all')}</Button>
        </div>
        <CarbonTable withToolbar={false}
          headers={[
            { key: 'sel', header: '' },
            { key: 'asset', header: tr(lang, 'Asset'), mono: true },
            { key: 'cls', header: tr(lang, 'Suggested class') },
            { key: 'level', header: tr(lang, 'Level') },
            { key: 'conf', header: tr(lang, 'Confidence') },
          ]}
          rows={SG_CLASSIFY}
          renderCell={(r, k) => {
            if (k === 'sel') return <Checkbox id={`gf-cls-${r.id}`} labelText="" defaultChecked />;
            if (k === 'level') return <Tag type={SG_LEVEL_TAG[r.level]} size="sm">{tr(lang, r.level)}</Tag>;
            if (k === 'conf') return <Confidence value={r.conf} />;
            return r[k];
          }} />
      </div>
      <div style={{ border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)', padding: 18, alignSelf: 'start' }}>
        <div style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--cds-text-secondary)', marginBottom: 14 }}>{tr(lang, 'CLASSIFICATION DISTRIBUTION')}</div>
        {SG_CLS_DIST.map((d) => (
          <div key={d[0]} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 32px', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <Tag type={d[1]} size="sm">{tr(lang, d[0])}</Tag>
            <span style={{ height: 8, background: 'var(--cds-layer-01)', position: 'relative' }}>
              <span style={{ position: 'absolute', inset: '0 auto 0 0', width: d[2] + '%', background: `var(--cds-${d[1] === 'red' ? 'support-error' : d[1] === 'purple' ? 'purple-60' : d[1] === 'blue' ? 'blue-60' : 'support-success'})` }} />
            </span>
            <span style={{ fontFamily: 'var(--cds-font-mono)', fontSize: '.75rem', textAlign: 'right' }}>{d[2]}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SemanticAutofill({ notify, lang }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Callout icon="renew" title={tr(lang, 'A self-reinforcing loop')}>
        {tr(lang, 'AI drafts field descriptions from DataHub schema, samples, and ETL logic. A reviewer accepts them into the AI Semantic layer — better semantics make future AI answers more accurate, which makes governance easier. Governance → cleaner data → smarter AI → back again.')}
      </Callout>
      {SG_SEMANTIC.map((s) => (
        <div key={s.field} style={{ border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--wire-border)' }}>
            <Icon name="watson" size={16} style={{ color: 'var(--cds-blue-60)' }} />
            <span style={{ fontFamily: 'var(--cds-font-mono)', fontSize: '.8125rem', flex: 1 }}>{s.field}</span>
            <Confidence value={s.conf} />
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div><div style={{ fontSize: '.6875rem', fontWeight: 600, color: 'var(--cds-text-secondary)' }}>{tr(lang, 'AI-suggested nl_description')}</div><div className="sg-diff"><span className="ai">{s.nl}</span></div></div>
            <div><div style={{ fontSize: '.6875rem', fontWeight: 600, color: 'var(--cds-text-secondary)' }}>{tr(lang, 'AI-suggested domain_knowledge')}</div><div className="sg-diff"><span className="ai">{s.dk}</span></div></div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button kind="primary" size="sm" renderIcon={iconFor('checkmark')} onClick={() => notify && notify({ kind: 'success', title: tr(lang, 'Accepted into semantic layer'), subtitle: s.field })}>{tr(lang, 'Accept to AI Semantic')}</Button>
              <Button kind="tertiary" size="sm" renderIcon={iconFor('edit')}>{tr(lang, 'Edit first')}</Button>
              <Button kind="ghost" size="sm">{tr(lang, 'Reject')}</Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RuleEngine({ notify, lang }) {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', flex: 1 }}>{tr(lang, 'Define automated governance rules — AI continuously patrols and acts on matches.')}</div>
        <Button kind="primary" size="md" renderIcon={iconFor('add')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'New governance rule') })}>{tr(lang, 'New rule')}</Button>
      </div>
      {SG_RULES.map((r) => (
        <div key={r.id} style={{ border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <Icon name="watson" size={18} style={{ color: 'var(--cds-blue-60)', flex: '0 0 18px' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '.875rem', fontWeight: 600, color: 'var(--cds-text-primary)' }}>{tr(lang, r.name)}</div>
            <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 2 }}>
              {/* When/then stay English in both locales — rule-DSL keywords */}
              <b>When</b> {tr(lang, r.when)} <b>→ then</b> {tr(lang, r.then)}
            </div>
          </div>
          <StatusDot kind={r.on ? 'success' : 'gray'}>{tr(lang, r.on ? 'Active' : 'Off')}</StatusDot>
        </div>
      ))}
    </div>
  );
}

function SmartGovernance({ notify, lang }) {
  const [domain, setDomain] = useState('All subject domains');
  const [tab, setTab] = useState(0);
  const tasks = [
    ['12', 'Sensitive fields to confirm', 'locked', 1],
    ['8', 'Auto-classifications to review', 'view', 2],
    ['23', 'Semantic descriptions to fill', 'watson', 3],
  ];
  const coverage = [['Auto-classified assets', 78], ['Sensitive detection coverage', 91], ['Semantic layer completeness', 64]];
  const overview = (
    <div style={{ marginTop: 8 }}>
      <div className="sg-tasks">
        {tasks.map((t) => (
          <button type="button" key={t[1]} className="sg-task" onClick={() => setTab(t[3])}>
            <div className="n">{t[0]}</div>
            <div className="t"><Icon name={t[2]} size={14} />{tr(lang, t[1])}</div>
            <div className="go">{tr(lang, 'Review')} <Icon name="arrow--right" size={12} /></div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: '.75rem', fontWeight: 600, color: 'var(--cds-text-secondary)', margin: '4px 0 10px' }}>{tr(lang, 'AUTOMATION COVERAGE')}</div>
      <div className="sg-cov">
        {coverage.map((c) => (
          <div key={c[0]} className="c"><div className="k">{tr(lang, c[0])}</div><div className="bar"><span style={{ width: c[1] + '%' }} /></div><div className="v">{c[1]}%</div></div>
        ))}
      </div>
    </div>
  );
  return (
    <div>
      <DomainFilter value={domain} onChange={setDomain} lang={lang} />
      <Tabs selectedIndex={tab} onChange={({ selectedIndex }) => setTab(selectedIndex)}>
        <TabList aria-label="Smart governance">
          <Tab>{tr(lang, 'Overview')}</Tab><Tab>{tr(lang, 'Sensitive detection')}</Tab><Tab>{tr(lang, 'Auto-classification')}</Tab>
          <Tab>{tr(lang, 'Semantic autofill')}</Tab><Tab>{tr(lang, 'Rule engine')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>{overview}</TabPanel>
          <TabPanel><SensitiveDetection notify={notify} lang={lang} /></TabPanel>
          <TabPanel><AutoClassify notify={notify} lang={lang} /></TabPanel>
          <TabPanel><SemanticAutofill notify={notify} lang={lang} /></TabPanel>
          <TabPanel><RuleEngine notify={notify} lang={lang} /></TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

/* ============================== wrapper ============================== */

const GF_SUBS = [
  { id: 'oneid', label: 'OneID' },
  { id: 'standards', label: 'Data Standards' },
  { id: 'busmatrix', label: 'Bus Matrix' },
  { id: 'inventory', label: 'Asset Inventory' },
  { id: 'smart', label: 'Smart Governance' },
];
const GF_TITLES = {
  oneid: ['OneID', 'Unify one business entity’s many source identifiers into a single global ID — cross-source identity resolution.'],
  standards: ['Data Standards', 'Global naming, coding, and value standards — enforced automatically at modeling time.'],
  busmatrix: ['Bus Matrix', 'Business processes × conformed dimensions — enforce cross-domain dimensional consistency.'],
  inventory: ['Asset Inventory', 'Quantify every data asset’s value and cost — surface high-value and zombie assets.'],
  smart: ['Smart Governance', 'AI automates sensitive-data detection, classification, and semantic enrichment at scale.'],
};

export default function GovFoundation({ notify, lang }) {
  const [sub, setSub] = useState('oneid');
  const [t, s] = GF_TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader crumb={['Governance Foundation', t].map((c) => tr(lang, c))} title={tr(lang, t)} sub={tr(lang, s)} />
      <SubSwitch items={trList(lang, GF_SUBS)} value={sub} onChange={setSub} />
      {sub === 'oneid' && <OneID notify={notify} lang={lang} />}
      {sub === 'standards' && <DataStandards notify={notify} lang={lang} />}
      {sub === 'busmatrix' && <BusMatrix notify={notify} lang={lang} />}
      {sub === 'inventory' && <AssetInventory notify={notify} lang={lang} />}
      {sub === 'smart' && <SmartGovernance notify={notify} lang={lang} />}
    </div>
  );
}
