import { useState, useEffect } from 'react';
import {
  Button, Tag, TextInput, Checkbox, Tile, TileGroup, RadioTile, Select, SelectItem,
  InlineNotification, Tabs, TabList, Tab, TabPanels, TabPanel, CodeSnippet,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
  ProgressIndicator, ProgressStep,
  StructuredListWrapper, StructuredListBody, StructuredListRow, StructuredListCell,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot, RowMenu, EmptyState } from '../components/shared.jsx';
import { TrendLine } from '../components/Charts.jsx';
import * as api from '../data/api.js';
import { tr, trList } from '../i18n.js';

/* Data Services (§15 Data-as-a-Service): publish internal data as governed,
   read-only external REST APIs. The contract whitelist + L6 masking is the
   security boundary — "safe even without auth". */

const AUTH_TAG = { none: 'cool-gray', apikey: 'blue', oauth: 'teal', jwt: 'purple' };
const AUTH_LABEL = { none: 'No auth', apikey: 'API Key', oauth: 'OAuth 2.0', jwt: 'JWT' };
const STATUS_KIND = { published: 'success', draft: 'draft', deprecated: 'gray', retired: 'gray' };

/* ============================ API GALLERY ============================ */
function ApiGallery({ rows, onOpen, onPublish, onRefresh, notify, lang }) {
  const headers = [
    { key: 'name', header: tr(lang, 'API name') },
    { key: 'endpoint', header: tr(lang, 'Endpoint path'), mono: true },
    { key: 'source_ref', header: tr(lang, 'Source'), mono: true },
    { key: 'auth_mode', header: tr(lang, 'Auth mode') },
    { key: 'status', header: tr(lang, 'Status') },
    { key: 'rate_limit_rpm', header: tr(lang, 'Rate limit') },
    { key: 'owner', header: tr(lang, 'Owner') },
    { key: 'ofw', header: '' },
  ];
  if (rows.length === 0) {
    return (
      <EmptyState icon="apps" title={tr(lang, 'No data APIs published yet')}
        sub={tr(lang, 'Expose a governed, read-only API over a semantic model or table. Field whitelisting and masking are enforced for you.')}
        action={<Button kind="primary" renderIcon={iconFor('add')} onClick={onPublish}>{tr(lang, 'Publish your first data API')}</Button>} />
    );
  }
  return (
    <CarbonTable
      headers={headers}
      rows={rows}
      withPagination
      searchPlaceholder={tr(lang, 'Search APIs by name or source')}
      onRowClick={onOpen}
      actions={(
        <>
          <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('renew')} iconDescription={tr(lang, 'Refresh')} onClick={onRefresh} />
          <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={onPublish}>{tr(lang, 'Publish API')}</Button>
        </>
      )}
      renderCell={(r, k) => {
        if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r); }}>{r.name}</a>;
        if (k === 'endpoint') return `/data-api/v1/${r.name}`;
        if (k === 'auth_mode') return <Tag type={AUTH_TAG[r.auth_mode] || 'cool-gray'} size="sm">{tr(lang, AUTH_LABEL[r.auth_mode] || r.auth_mode)}</Tag>;
        if (k === 'status') return <StatusDot kind={STATUS_KIND[r.status] || 'gray'}>{tr(lang, r.status)}</StatusDot>;
        if (k === 'rate_limit_rpm') return r.rate_limit_rpm ? `${r.rate_limit_rpm}/min` : '—';
        if (k === 'ofw') return <RowMenu onView={() => onOpen(r)} />;
        return r[k];
      }}
    />
  );
}

/* ============================ PUBLISH WIZARD ============================ */
const WIZ_STEPS = [
  ['Source', 'Model or table'],
  ['Field whitelist', 'What is exposed'],
  ['Parameters', 'Query & paging'],
  ['Auth mode', 'How callers prove identity'],
  ['Limits', 'Rate & quota'],
  ['Review & publish', 'Confirm contract'],
];
const FILTER_OPS = ['=', '>', '<', 'in', 'like', 'between'];

// sampleValue renders a placeholder for a column by its declared dtype.
function sampleValue(type) {
  const t = String(type || '').toLowerCase();
  if (/int|bigint|long/.test(t)) return 142;
  if (/double|float|dec|real|num/.test(t)) return 0.962;
  if (/bool/.test(t)) return true;
  if (/date|time/.test(t)) return '2026-06-21T08:14:00Z';
  return 'P1';
}

function PublishWizard({ onClose, onDone, notify, lang }) {
  const [step, setStep] = useState(0);
  const [datasets, setDatasets] = useState([]);   // real ns.table list
  const [cols, setCols] = useState([]);            // [{col,type}] of the chosen source
  const [colCfg, setColCfg] = useState({});        // { col: { exposed, as } }
  const [filters, setFilters] = useState([]);      // [{column, op, required, default}]
  const [sort, setSort] = useState([]);            // exposed cols allowed to sort
  const [spec, setSpec] = useState({
    name: '', version: 'v1', source_type: 'table', source_ref: '',
    auth_mode: 'none', oauth_issuer: 'https://sso.ipas/realms/ipas', oauth_client: '', oauth_scope: 'data-api:read',
    jwt_issuer: 'https://sso.ipas/realms/ipas', jwt_aud: 'data-api',
    rate_limit_rpm: 600, daily_quota: 500000, max_concurrency: 20,
    page_default: 50, page_max: 500, description: '',
  });
  const last = step === WIZ_STEPS.length - 1;
  const set = (k, v) => setSpec((s) => ({ ...s, [k]: v }));

  // Load the real registered Iceberg datasets once.
  useEffect(() => {
    api.getDatasets().then((ts) => setDatasets((ts || []).map((t) => `${t.namespace}.${t.name}`))).catch(() => setDatasets([]));
  }, []);

  // When a source is chosen, load its real columns and default everything exposed.
  const chooseSource = (ref) => {
    set('source_ref', ref);
    const [ns, table] = String(ref).split('.');
    if (!ns || !table) { setCols([]); return; }
    api.getDatasetSchema(ns, table)
      .then((sc) => {
        const cs = (sc.columns || []).map((c) => ({ col: c.col, type: c.type }));
        setCols(cs);
        setColCfg(Object.fromEntries(cs.map((c) => [c.col, { exposed: true, as: c.col }])));
        setFilters([]); setSort([]);
      })
      .catch(() => { setCols([]); setColCfg({}); });
  };

  const exposed = cols.filter((c) => colCfg[c.col]?.exposed);

  const publish = async () => {
    try {
      const body = {
        name: spec.name, version: spec.version, source_type: spec.source_type, source_ref: spec.source_ref,
        allowed_columns: exposed.map((c) => ({ src: c.col, exposed_as: colCfg[c.col].as || c.col })),
        allowed_filters: filters.map((f) => ({ column: f.column, ops: [f.op], required: !!f.required, default: f.default || null })),
        pagination: { default_size: Number(spec.page_default) || 50, max_size: Number(spec.page_max) || 500 },
        sort_whitelist: sort,
        auth_mode: spec.auth_mode,
        rate_limit_rpm: Number(spec.rate_limit_rpm), daily_quota: Number(spec.daily_quota), max_concurrency: Number(spec.max_concurrency),
        status: 'published', owner: '', description: spec.description,
      };
      await api.dataApis.create(body);
      notify && notify({ kind: 'success', title: tr(lang, 'API published'), subtitle: `/data-api/v1/${spec.name}` });
      onDone();
    } catch (err) {
      notify && notify({ kind: 'error', title: tr(lang, 'Publish failed.'), subtitle: (err.detail || String(err.message || err)) });
    }
  };

  const canNext = (step === 0 && spec.name && spec.source_ref) || (step === 1 && exposed.length > 0) || step > 1;

  return (
    <ComposedModal open size="lg" onClose={onClose}>
      <ModalHeader label={tr(lang, 'Data Services')} title={tr(lang, 'Publish data API')} />
      <ModalBody hasForm>
        <ProgressIndicator currentIndex={step} spaceEqually style={{ marginBottom: 28 }}>
          {WIZ_STEPS.map(([t, s], i) => <ProgressStep key={t} label={tr(lang, t)} secondaryLabel={tr(lang, s)} onClick={() => setStep(i)} />)}
        </ProgressIndicator>

        {/* ---- Step 0: source + endpoint ---- */}
        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="w-row">
              <Select id="ds-name" labelText={tr(lang, 'Source type')} value={spec.source_type} onChange={(e) => set('source_type', e.target.value)}>
                <SelectItem value="table" text={tr(lang, 'Iceberg table')} />
                <SelectItem value="semantic" text={tr(lang, 'Semantic model')} />
                <SelectItem value="dataset" text={tr(lang, 'Saved dataset')} />
              </Select>
              <Select id="ds-ref" labelText={tr(lang, 'Source reference')} value={spec.source_ref} onChange={(e) => chooseSource(e.target.value)}>
                <SelectItem value="" text={datasets.length ? tr(lang, 'Select a source…') : tr(lang, '(loading…)')} />
                {datasets.map((d) => <SelectItem key={d} value={d} text={d} />)}
              </Select>
            </div>
            <div className="w-row">
              <TextInput id="ds-apiname" labelText={tr(lang, 'API name (endpoint path)')} placeholder="che-quality-api" value={spec.name} onChange={(e) => set('name', e.target.value.replace(/[^a-z0-9-]/g, ''))} />
              <TextInput id="ds-ver" labelText={tr(lang, 'Version')} value={spec.version} onChange={(e) => set('version', e.target.value)} />
            </div>
            <TextInput id="ds-endpoint" labelText={tr(lang, 'Endpoint URL')} value={spec.name ? `/data-api/v1/${spec.name}` : ''} placeholder="/data-api/v1/…" readOnly />
            <div className="w-fld"><label className="cds--label">{tr(lang, 'Resolved fields')} ({cols.length})</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {cols.length === 0 ? <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'Pick a source to resolve its fields.')}</span>
                  : cols.map((c) => <Tag key={c.col} type="cool-gray" size="sm"><span className="ip-mono">{c.col}</span></Tag>)}
              </div>
            </div>
          </div>
        )}

        {/* ---- Step 1: field whitelist + outward rename ---- */}
        {step === 1 && (
          <div>
            <p style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', margin: '0 0 14px' }}>
              {tr(lang, 'Only checked fields are exposed. Unchecked fields are invisible to callers — not in the schema, not in errors.')}
            </p>
            {cols.length === 0
              ? <Tile><span style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Pick a source on the first step to load fields.')}</span></Tile>
              : (
                <div style={{ border: '1px solid var(--wire-border)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr 100px 1.2fr', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--wire-border)', fontSize: '.6875rem', fontWeight: 600, letterSpacing: '.16px', color: 'var(--cds-text-secondary)', textTransform: 'uppercase' }}>
                    <span /><span>{tr(lang, 'Field')}</span><span>{tr(lang, 'Type')}</span><span>{tr(lang, 'Exposed as (rename)')}</span>
                  </div>
                  {cols.map((c) => {
                    const cfg = colCfg[c.col] || { exposed: false, as: c.col };
                    return (
                      <div key={c.col} style={{ display: 'grid', gridTemplateColumns: '32px 1fr 100px 1.2fr', gap: 10, padding: '6px 14px', alignItems: 'center', borderBottom: '1px solid var(--cds-layer-01)' }}>
                        <Checkbox id={`exp-${c.col}`} labelText="" checked={cfg.exposed} onChange={(_, { checked }) => setColCfg((m) => ({ ...m, [c.col]: { ...cfg, exposed: checked } }))} />
                        <span className="ip-mono" style={{ fontSize: '.8125rem' }}>{c.col}</span>
                        <span className="ip-mono" style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{c.type}</span>
                        <TextInput size="sm" id={`as-${c.col}`} labelText="" value={cfg.as} disabled={!cfg.exposed} onChange={(e) => setColCfg((m) => ({ ...m, [c.col]: { ...cfg, as: e.target.value } }))} />
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        )}

        {/* ---- Step 2: parameters + paging + sort ---- */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div className="w-fld"><label className="cds--label">{tr(lang, 'Allowed query parameters')}</label>
              <div style={{ border: '1px solid var(--wire-border)', padding: '10px 14px' }}>
                {filters.length === 0 && <div style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)', marginBottom: 8 }}>{tr(lang, 'No parameters — callers can only page. Add one to allow filtering.')}</div>}
                {filters.map((f, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto 32px', gap: 8, alignItems: 'end', marginBottom: 8 }}>
                    <Select size="sm" id={`f-col-${i}`} labelText={i === 0 ? tr(lang, 'Field') : ''} value={f.column} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, column: e.target.value } : x))}>
                      {exposed.map((c) => <SelectItem key={c.col} value={c.col} text={c.col} />)}
                    </Select>
                    <Select size="sm" id={`f-op-${i}`} labelText={i === 0 ? tr(lang, 'Operator') : ''} value={f.op} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, op: e.target.value } : x))}>
                      {FILTER_OPS.map((o) => <SelectItem key={o} value={o} text={o} />)}
                    </Select>
                    <TextInput size="sm" id={`f-def-${i}`} labelText={i === 0 ? tr(lang, 'Default') : ''} placeholder="—" value={f.default} onChange={(e) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, default: e.target.value } : x))} />
                    <Checkbox id={`f-req-${i}`} labelText={tr(lang, 'Required')} checked={f.required} onChange={(_, { checked }) => setFilters((fs) => fs.map((x, j) => j === i ? { ...x, required: checked } : x))} />
                    <Button kind="ghost" size="sm" hasIconOnly renderIcon={iconFor('subtract')} iconDescription={tr(lang, 'Remove')} onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button kind="ghost" size="sm" renderIcon={iconFor('add')} disabled={exposed.length === 0}
                  onClick={() => setFilters((fs) => [...fs, { column: exposed[0]?.col || '', op: '=', required: false, default: '' }])}>{tr(lang, 'Add parameter')}</Button>
              </div>
            </div>
            <div className="w-row">
              <TextInput id="ds-pgs" labelText={tr(lang, 'Default page size')} value={String(spec.page_default)} onChange={(e) => set('page_default', e.target.value)} />
              <TextInput id="ds-mpgs" labelText={tr(lang, 'Max page size')} value={String(spec.page_max)} onChange={(e) => set('page_max', e.target.value)} />
            </div>
            <div className="w-fld"><label className="cds--label">{tr(lang, 'Sort whitelist')}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {exposed.length === 0 ? <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'Expose fields first.')}</span>
                  : exposed.map((c) => {
                    const on = sort.includes(c.col);
                    return <Tag key={c.col} type={on ? 'blue' : 'outline'} size="sm" style={{ cursor: 'pointer' }}
                      onClick={() => setSort((s) => on ? s.filter((x) => x !== c.col) : [...s, c.col])}>{c.col}</Tag>;
                  })}
              </div>
            </div>
          </div>
        )}

        {/* ---- Step 3: auth mode + per-mode config ---- */}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <TileGroup name="auth" valueSelected={spec.auth_mode} legend={tr(lang, 'Auth mode')} onChange={(v) => set('auth_mode', v)}>
              <RadioTile value="none">{tr(lang, 'No auth (public read-only) — anyone can call with no credentials.')}</RadioTile>
              <RadioTile value="apikey">{tr(lang, 'API Key — issue keys with scope and expiry.')}</RadioTile>
              <RadioTile value="oauth">{tr(lang, 'OAuth 2.0 (client credentials) — reuse Keycloak.')}</RadioTile>
              <RadioTile value="jwt">{tr(lang, 'JWT — validate signed tokens against a configured issuer.')}</RadioTile>
            </TileGroup>
            {spec.auth_mode === 'none' && (
              <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'No auth, still safe by contract')}
                subtitle={tr(lang, 'This API needs no credentials, but can only ever return whitelisted fields, and masking still applies. Anonymous callers never see masked or unexposed columns.')} />
            )}
            {spec.auth_mode === 'apikey' && (
              <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'Keys are minted after publish')}
                subtitle={tr(lang, 'Publish first, then create one or more API keys from the API’s Authentication tab. Keys are shown once.')} />
            )}
            {spec.auth_mode === 'oauth' && (
              <div className="w-row" style={{ flexWrap: 'wrap', gap: 16 }}>
                <TextInput id="oa-iss" labelText={tr(lang, 'Issuer (token URL)')} value={spec.oauth_issuer} onChange={(e) => set('oauth_issuer', e.target.value)} />
                <TextInput id="oa-cli" labelText={tr(lang, 'Client ID')} value={spec.oauth_client} onChange={(e) => set('oauth_client', e.target.value)} />
                <TextInput id="oa-sco" labelText={tr(lang, 'Scope')} value={spec.oauth_scope} onChange={(e) => set('oauth_scope', e.target.value)} />
              </div>
            )}
            {spec.auth_mode === 'jwt' && (
              <div className="w-row">
                <TextInput id="jwt-iss" labelText={tr(lang, 'Issuer (iss)')} value={spec.jwt_issuer} onChange={(e) => set('jwt_issuer', e.target.value)} />
                <TextInput id="jwt-aud" labelText={tr(lang, 'Audience (aud)')} value={spec.jwt_aud} onChange={(e) => set('jwt_aud', e.target.value)} />
              </div>
            )}
          </div>
        )}

        {/* ---- Step 4: limits ---- */}
        {step === 4 && (
          <div className="w-row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <TextInput id="ds-rpm" labelText={tr(lang, 'Requests per minute')} value={String(spec.rate_limit_rpm)} onChange={(e) => set('rate_limit_rpm', e.target.value)} />
            <TextInput id="ds-quota" labelText={tr(lang, 'Daily quota')} value={String(spec.daily_quota)} onChange={(e) => set('daily_quota', e.target.value)} />
            <TextInput id="ds-conc" labelText={tr(lang, 'Max concurrency')} value={String(spec.max_concurrency)} onChange={(e) => set('max_concurrency', e.target.value)} />
          </div>
        )}

        {/* ---- Step 5: review ---- */}
        {step === 5 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <StructuredListWrapper isCondensed>
              <StructuredListBody>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Endpoint URL')}</StructuredListCell><StructuredListCell className="ip-mono">/data-api/v1/{spec.name || '—'}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Source')}</StructuredListCell><StructuredListCell className="ip-mono">{spec.source_ref || '—'}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Auth mode')}</StructuredListCell><StructuredListCell>{tr(lang, AUTH_LABEL[spec.auth_mode])}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Exposed fields')}</StructuredListCell><StructuredListCell>{exposed.length} {tr(lang, 'of')} {cols.length}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Parameters')}</StructuredListCell><StructuredListCell>{filters.length ? filters.map((f) => `${colCfg[f.column]?.as || f.column} ${f.op}${f.required ? '*' : ''}`).join(', ') : '—'}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Rate limit')}</StructuredListCell><StructuredListCell>{spec.rate_limit_rpm}/min · {spec.daily_quota}/day · {spec.max_concurrency} {tr(lang, 'concurrent')}</StructuredListCell></StructuredListRow>
              </StructuredListBody>
            </StructuredListWrapper>
            <div className="w-fld"><label className="cds--label">{tr(lang, 'Response shape (exposed fields)')}</label>
              <CodeSnippet type="multi" feedback={tr(lang, 'Copied')} style={{ maxHeight: 220 }}>
                {`[\n  {\n${exposed.map((c) => `    "${colCfg[c.col].as || c.col}": ${JSON.stringify(sampleValue(c.type))}`).join(',\n')}\n  }\n]`}
              </CodeSnippet>
            </div>
            {spec.auth_mode === 'none' && (
              <InlineNotification kind="warning" lowContrast hideCloseButton title={tr(lang, 'Publishing as a public API')}
                subtitle={tr(lang, 'Anonymous callers will reach this endpoint. They can only ever receive whitelisted, masked fields.')} />
            )}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>{step === 0 ? tr(lang, 'Cancel') : tr(lang, 'Back')}</Button>
        <Button kind="primary" renderIcon={iconFor(last ? 'send' : 'arrow--right')} disabled={!canNext}
          onClick={last ? publish : () => setStep((s) => s + 1)}>{last ? tr(lang, 'Publish API') : tr(lang, 'Next')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

/* ---- safe parse for stored contract fields (string | array | object) ---- */
function parseField(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v) || typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

/* ============================ TRY-IT DEBUGGER (§P0-2) ============================
   Generates a parameter form from the API's allowed_filters, fires a REAL GET
   against the public endpoint, and shows status + latency + response JSON. The
   point: an auth_mode=none API returns data here with no credentials, yet only
   ever whitelisted, masked fields. */
function TryItDebugger({ api: a, lang }) {
  const filters = parseField(a.allowed_filters, []);
  const pag = parseField(a.pagination, {}) || {};
  const [vals, setVals] = useState({});
  const [limit, setLimit] = useState(pag.default_size || 50);
  const [apiKey, setApiKey] = useState('');
  const [resp, setResp] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const missingRequired = filters.some((f) => f.required && !String(vals[f.column] ?? '').trim());

  const send = async () => {
    setBusy(true);
    const params = {};
    filters.forEach((f) => { const v = vals[f.column]; if (v !== undefined && String(v).trim() !== '') params[f.column] = v; });
    if (limit) params.limit = limit;
    try {
      const r = await api.callDataApi(a.name, params, a.auth_mode === 'apikey' ? apiKey : undefined);
      setResp(r);
    } finally {
      setBusy(false);
    }
  };

  const statusKind = !resp ? 'gray' : resp.status === 0 ? 'red' : resp.ok ? 'success' : (resp.status >= 500 ? 'red' : 'amber');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div style={{ border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--wire-border)', fontSize: '.8125rem', fontWeight: 600 }}>
        <Icon name="play--outline" size={16} />{tr(lang, 'Try it')}
        <Tag type="green" size="sm" style={{ marginLeft: 'auto' }}>GET</Tag>
        <span className="ip-mono" style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>/data-api/v1/{a.name}</span>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {a.auth_mode === 'none' && (
          <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, 'No auth, still safe by contract')}
            subtitle={tr(lang, 'Send with no credentials — the response can only ever contain whitelisted, masked fields.')} />
        )}
        {a.auth_mode === 'apikey' && (
          <TextInput id="tryit-key" type="password" labelText={tr(lang, 'API key (x-api-key)')} placeholder="ipas_sk_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        )}

        <div className="w-fld"><label className="cds--label">{tr(lang, 'Allowed query parameters')}</label>
          {filters.length === 0
            ? <span style={{ fontSize: '.75rem', color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'No parameters — this API only supports paging.')}</span>
            : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                {filters.map((f) => (
                  <TextInput key={f.column} id={`tryit-${f.column}`} size="sm"
                    labelText={`${f.column} (${(f.ops || []).join(', ')})${f.required ? ' *' : ''}`}
                    placeholder={f.default != null ? String(f.default) : '—'}
                    value={vals[f.column] ?? ''} onChange={(e) => set(f.column, e.target.value)} />
                ))}
              </div>
            )}
        </div>
        <div style={{ maxWidth: 200 }}>
          <TextInput id="tryit-limit" size="sm" labelText={tr(lang, 'Limit')} value={String(limit)} onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ''))} />
        </div>

        <div>
          <Button kind="primary" renderIcon={iconFor('send')} disabled={busy || missingRequired} onClick={send}>
            {busy ? tr(lang, 'Sending…') : tr(lang, 'Send request')}
          </Button>
        </div>

        {resp && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <StatusDot kind={statusKind}>{resp.status === 0 ? tr(lang, 'Network error') : `HTTP ${resp.status}`}</StatusDot>
              <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}><Icon name="time" size={12} /> {resp.ms} ms</span>
              <span className="ip-mono" style={{ fontSize: '.6875rem', color: 'var(--cds-text-secondary)', wordBreak: 'break-all' }}>{origin}{resp.url}</span>
            </div>
            <CodeSnippet type="multi" feedback={tr(lang, 'Copied')} style={{ maxHeight: 320 }}>
              {resp.error ? resp.error : (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body, null, 2))}
            </CodeSnippet>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================ API DETAIL ============================ */
/* Usage / Audit / Versions panels — defensive against varying backend shapes;
   `null` state means the endpoint isn't wired yet (// 待确认) → graceful notice. */
function UsagePanel({ usage, lang }) {
  if (usage === undefined) return <div style={{ marginTop: 12, color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'Loading…')}</div>;
  if (usage === null) {
    return <InlineNotification kind="info" lowContrast hideCloseButton style={{ marginTop: 8 }}
      title={tr(lang, 'Usage metrics')}
      subtitle={tr(lang, 'Per-API call volume and latency are recorded in the access audit. A usage dashboard will surface them here.')} />;
  }
  const total = usage.total ?? usage.calls ?? usage.count ?? 0;
  const p95 = usage.p95_ms ?? usage.latency_p95 ?? usage.p95;
  const limited = usage.rate_limited ?? usage.throttled ?? 0;
  const series = usage.series || usage.by_day || usage.timeline || [];
  const kpis = [
    { k: 'Total calls', v: String(total), icon: 'analytics' },
    { k: 'p95 latency', v: p95 != null ? `${p95}ms` : '—', icon: 'time' },
    { k: 'Rate-limit hits', v: String(limited), icon: 'warning--filled', color: limited ? 'var(--cds-support-warning)' : undefined },
  ];
  const line = series.map((d) => ({ group: 'calls', key: String(d.key ?? d.t ?? d.date ?? d.label ?? ''), value: Number(d.value ?? d.calls ?? d.count ?? 0) }));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="w-stats">
        {kpis.map((s) => (
          <div className="s" key={s.k}>
            <div className="k"><Icon name={s.icon} size={16} style={s.color ? { color: s.color } : undefined} />{tr(lang, s.k)}</div>
            <div className="v">{s.v}</div>
          </div>
        ))}
      </div>
      {line.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="w-section-label">{tr(lang, 'Call volume')}</div>
          <TrendLine data={line} group="calls" height={180} />
        </div>
      )}
    </div>
  );
}

function AuditPanel({ audit, lang }) {
  if (audit === undefined) return <div style={{ marginTop: 12, color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'Loading…')}</div>;
  if (audit === null) {
    return <InlineNotification kind="info" lowContrast hideCloseButton style={{ marginTop: 8 }}
      title={tr(lang, 'Access audit')}
      subtitle={tr(lang, 'Every call is recorded with caller, parameters, rows returned and whether masking was applied. The audit feed will surface here.')} />;
  }
  if (!audit.length) return <div style={{ marginTop: 8 }}><EmptyState title={tr(lang, 'No calls recorded yet')} sub={tr(lang, 'Calls to this API will appear here once it is invoked.')} icon="analytics" /></div>;
  const rows = audit.map((r, i) => ({
    id: r.id || String(i),
    ts: r.ts || r.time || r.at || r.created_at || '—',
    caller: r.caller || r.principal || r.subject || r.client || '—',
    params: typeof r.params === 'string' ? r.params : JSON.stringify(r.params || r.query || {}),
    rows_returned: r.rows_returned ?? r.rows ?? r.count ?? '—',
    masked: r.masked ?? r.masking_applied ?? false,
  }));
  return (
    <div style={{ marginTop: 8 }}>
      <CarbonTable
        headers={[
          { key: 'ts', header: tr(lang, 'Time'), mono: true },
          { key: 'caller', header: tr(lang, 'Caller') },
          { key: 'params', header: tr(lang, 'Parameters'), mono: true },
          { key: 'rows_returned', header: tr(lang, 'Rows') },
          { key: 'masked', header: tr(lang, 'Masked') },
        ]}
        rows={rows}
        renderCell={(r, k) => k === 'masked'
          ? (r.masked ? <Tag type="magenta" size="sm">{tr(lang, 'Masked')}</Tag> : <span style={{ color: 'var(--cds-text-placeholder)' }}>—</span>)
          : r[k]} />
    </div>
  );
}

function VersionsPanel({ versions, current, lang, onPublish }) {
  const publishBtn = <Button kind="primary" size="lg" renderIcon={iconFor('play')} onClick={onPublish}>{tr(lang, 'Publish new version')}</Button>;
  if (versions === undefined) return <div style={{ marginTop: 12, color: 'var(--cds-text-placeholder)' }}>{tr(lang, 'Loading…')}</div>;
  const list = (versions && versions.length) ? versions : [{ version: current || 'v1', status: 'published', published_at: '—', _current: true }];
  return (
    <div style={{ marginTop: 8 }}>
      <CarbonTable
        headers={[
          { key: 'version', header: tr(lang, 'Version'), mono: true },
          { key: 'status', header: tr(lang, 'Status') },
          { key: 'published_at', header: tr(lang, 'Published'), mono: true },
        ]}
        rows={list.map((v, i) => ({ id: String(i), version: v.version || v.name || `v${i + 1}`, status: v.status || 'published', published_at: v.published_at || v.created_at || '—' }))}
        actions={publishBtn}
        renderCell={(r, k) => k === 'status'
          ? <StatusDot kind={STATUS_KIND[r.status] || 'gray'}>{tr(lang, r.status)}</StatusDot>
          : r[k]} />
      {versions === null && (
        <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="information" size={14} />{tr(lang, 'Showing the active version. A full version history endpoint will populate this list.')}
        </div>
      )}
    </div>
  );
}

function ApiDetail({ api: a, onBack, onChanged, notify, lang }) {
  const [keys, setKeys] = useState([]);
  const [newKey, setNewKey] = useState(null);
  const [usage, setUsage] = useState(undefined); // undefined=loading, null=unavailable
  const [audit, setAudit] = useState(undefined);
  const [versions, setVersions] = useState(undefined);
  const id = a.id || a.api_id;
  useEffect(() => {
    if (a.auth_mode === 'apikey') api.listDataApiKeys(id).then(setKeys).catch(() => setKeys([]));
    api.dataApiUsage(id).then((u) => setUsage(u || null)).catch(() => setUsage(null));
    api.dataApiAudit(id).then((r) => setAudit(Array.isArray(r) ? r : (r && r.rows) || [])).catch(() => setAudit(null));
    api.dataApiVersions(id).then((r) => setVersions(Array.isArray(r) ? r : (r && r.rows) || [])).catch(() => setVersions(null));
  }, [id, a.auth_mode]);

  const allowed = (() => { try { return JSON.parse(a.allowed_columns || '[]'); } catch { return []; } })();

  const mintKey = async () => {
    try { const k = await api.createDataApiKey(id, { name: `key-${Date.now()}` }); setNewKey(k); setKeys((ks) => [...ks, k]); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Create key failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };
  const retire = async () => {
    try { await api.deprecateDataApi(id); notify && notify({ kind: 'warning', title: tr(lang, 'API deprecated') }); onChanged(); onBack(); }
    catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Deprecate failed.'), subtitle: (err.detail || String(err.message || err)) }); }
  };

  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to gallery')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 className="ip-mono" style={{ fontSize: '1.75rem', fontWeight: 400, margin: 0 }}>{a.name}</h1>
        <Tag type={AUTH_TAG[a.auth_mode] || 'cool-gray'} size="md">{tr(lang, AUTH_LABEL[a.auth_mode] || a.auth_mode)}</Tag>
        <StatusDot kind={STATUS_KIND[a.status] || 'gray'}>{tr(lang, a.status)}</StatusDot>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
          {a.status !== 'published' && <Button kind="tertiary" size="md" renderIcon={iconFor('play')} onClick={async () => { await api.publishDataApi(id); onChanged(); notify && notify({ kind: 'success', title: tr(lang, 'API published') }); }}>{tr(lang, 'Publish')}</Button>}
          <Button kind="danger" size="md" renderIcon={iconFor('stop--outline')} onClick={retire}>{tr(lang, 'Deprecate')}</Button>
        </div>
      </div>
      <Tabs>
        <TabList aria-label="API detail">
          <Tab>{tr(lang, 'Overview')}</Tab><Tab>{tr(lang, 'Contract')}</Tab><Tab>{tr(lang, 'Authentication')}</Tab><Tab>{tr(lang, 'Docs')}</Tab><Tab>{tr(lang, 'Usage')}</Tab><Tab>{tr(lang, 'Audit')}</Tab><Tab>{tr(lang, 'Versions')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <StructuredListWrapper isCondensed style={{ marginTop: 8 }}>
              <StructuredListBody>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Endpoint URL')}</StructuredListCell><StructuredListCell className="ip-mono">/data-api/v1/{a.name}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Source')}</StructuredListCell><StructuredListCell className="ip-mono">{a.source_ref}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Owner')}</StructuredListCell><StructuredListCell>{a.owner || '—'}</StructuredListCell></StructuredListRow>
                <StructuredListRow><StructuredListCell>{tr(lang, 'Rate limit')}</StructuredListCell><StructuredListCell>{a.rate_limit_rpm || '—'}/min</StructuredListCell></StructuredListRow>
              </StructuredListBody>
            </StructuredListWrapper>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <div className="w-section-label">{tr(lang, 'Exposed fields')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {allowed.length ? allowed.map((f) => <Tag key={f} type="cool-gray" size="sm">{f}</Tag>)
                  : <span style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'All non-masked columns')}</span>}
              </div>
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              {a.auth_mode !== 'apikey' ? (
                <InlineNotification kind="info" lowContrast hideCloseButton title={tr(lang, AUTH_LABEL[a.auth_mode])}
                  subtitle={tr(lang, 'No API keys for this auth mode. Callers authenticate via the configured provider.')} />
              ) : (
                <>
                  {newKey && (
                    <InlineNotification kind="success" lowContrast title={tr(lang, 'Key created — copy it now')} subtitle={newKey.key} />
                  )}
                  <CarbonTable
                    headers={[{ key: 'name', header: tr(lang, 'Key name') }, { key: 'prefix', header: tr(lang, 'Token'), mono: true }, { key: 'ofw', header: '' }]}
                    rows={keys}
                    actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={mintKey}>{tr(lang, 'Create key')}</Button>}
                    renderCell={(r, k) => k === 'ofw'
                      ? <Button kind="ghost" size="sm" onClick={() => api.deleteDataApiKey(id, r.key_id).then(() => setKeys((ks) => ks.filter((x) => x.key_id !== r.key_id)))}>{tr(lang, 'Revoke')}</Button>
                      : r[k]} />
                </>
              )}
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <StructuredListWrapper isCondensed>
                <StructuredListBody>
                  <StructuredListRow><StructuredListCell>{tr(lang, 'Method')}</StructuredListCell><StructuredListCell><Tag type="green" size="sm">GET</Tag></StructuredListCell></StructuredListRow>
                  <StructuredListRow><StructuredListCell>{tr(lang, 'Endpoint URL')}</StructuredListCell><StructuredListCell className="ip-mono">/data-api/v1/{a.name}</StructuredListCell></StructuredListRow>
                  <StructuredListRow><StructuredListCell>{tr(lang, 'Auth mode')}</StructuredListCell><StructuredListCell>{tr(lang, AUTH_LABEL[a.auth_mode] || a.auth_mode)}</StructuredListCell></StructuredListRow>
                </StructuredListBody>
              </StructuredListWrapper>
              <div>
                <div className="w-section-label">cURL</div>
                <CodeSnippet type="multi" feedback={tr(lang, 'Copied')}>
                  {`curl ${a.auth_mode === 'apikey' ? '-H "x-api-key: <key>" ' : ''}"${typeof window !== 'undefined' ? window.location.origin : ''}/data-api/v1/${a.name}"`}
                </CodeSnippet>
              </div>
              <div>
                <div className="w-section-label">{tr(lang, 'Try it')}</div>
                <TryItDebugger api={a} lang={lang} />
              </div>
            </div>
          </TabPanel>
          <TabPanel>
            <UsagePanel usage={usage} lang={lang} />
          </TabPanel>
          <TabPanel>
            <AuditPanel audit={audit} lang={lang} />
          </TabPanel>
          <TabPanel>
            <VersionsPanel versions={versions} current={a.version} lang={lang}
              onPublish={async () => { try { await api.publishDataApi(id); onChanged(); notify && notify({ kind: 'success', title: tr(lang, 'API published') }); } catch (err) { notify && notify({ kind: 'error', title: tr(lang, 'Publish failed.'), subtitle: (err.detail || String(err.message || err)) }); } }} />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

/* ============================ GOVERNANCE OVERVIEW ============================ */
function GovOverview({ rows, onOpen, lang }) {
  const published = rows.filter((r) => r.status === 'published');
  const kpis = [
    { k: 'Total APIs', v: rows.length, icon: 'apps' },
    { k: 'Published', v: published.length, icon: 'checkmark--filled' },
    { k: 'Auth modes', v: new Set(rows.map((r) => r.auth_mode)).size, icon: 'locked' },
    { k: 'Public (no auth)', v: rows.filter((r) => r.auth_mode === 'none').length, icon: 'unlocked' },
  ];
  return (
    <div>
      <div className="w-stats" style={{ marginBottom: 24 }}>
        {kpis.map((s) => <div className="s" key={s.k}><div className="k"><Icon name={s.icon} size={16} />{tr(lang, s.k)}</div><div className="v">{s.v}</div></div>)}
      </div>
      <div className="w-section-label">{tr(lang, 'Published APIs')}</div>
      <CarbonTable
        headers={[{ key: 'name', header: tr(lang, 'API') }, { key: 'source_ref', header: tr(lang, 'Source'), mono: true }, { key: 'auth_mode', header: tr(lang, 'Auth') }]}
        rows={published}
        onRowClick={onOpen}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r); }}>{r.name}</a>;
          if (k === 'auth_mode') return <Tag type={AUTH_TAG[r.auth_mode] || 'cool-gray'} size="sm">{tr(lang, AUTH_LABEL[r.auth_mode] || r.auth_mode)}</Tag>;
          return r[k];
        }} />
    </div>
  );
}

/* ============================ ROOT ============================ */
const DS_SUBS = [
  { id: 'gallery', label: 'API gallery' },
  { id: 'overview', label: 'Governance overview' },
];
const TITLES = {
  gallery: ['API gallery', 'Publish, secure, and monitor read-only data APIs over your semantic models and tables.'],
  overview: ['Governance overview', 'Health and traffic across every published data API.'],
};

export default function DataServices({ notify, lang }) {
  const [sub, setSub] = useState('gallery');
  const [api_, setApi] = useState(null);
  const [wizard, setWizard] = useState(false);
  const [rows, setRows] = useState([]);

  const load = () => api.dataApis.list()
    .then((r) => setRows((r || []).map((x, i) => ({ ...x, id: String(x.id || x.api_id || i) }))))
    .catch((err) => console.error('data-apis failed', err));
  useEffect(() => { load(); }, []);

  if (sub === 'gallery' && api_) {
    return (
      <div className="w-page">
        <div className="w-crumb">
          <a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'Data Services')}</a><span className="sep">/</span>
          <a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'API gallery')}</a><span className="sep">/</span><span>{api_.name}</span>
        </div>
        <ApiDetail api={api_} onBack={() => setApi(null)} onChanged={load} notify={notify} lang={lang} />
        {wizard && <PublishWizard onClose={() => setWizard(false)} onDone={() => { setWizard(false); load(); }} notify={notify} lang={lang} />}
      </div>
    );
  }
  const [t, s] = TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Data Services'), tr(lang, t)]} title={tr(lang, t)} sub={tr(lang, s)}
        actions={sub === 'gallery' ? <Button kind="primary" size="md" renderIcon={iconFor('add')} onClick={() => setWizard(true)}>{tr(lang, 'Publish API')}</Button> : null} />
      <SubSwitch items={trList(lang, DS_SUBS)} value={sub} onChange={(v) => { setSub(v); setApi(null); }} />
      {sub === 'gallery' && <ApiGallery rows={rows} onOpen={setApi} onPublish={() => setWizard(true)} onRefresh={load} notify={notify} lang={lang} />}
      {sub === 'overview' && <GovOverview rows={rows} onOpen={(r) => { setSub('gallery'); setApi(r); }} lang={lang} />}
      {wizard && <PublishWizard onClose={() => setWizard(false)} onDone={() => { setWizard(false); load(); }} notify={notify} lang={lang} />}
    </div>
  );
}
