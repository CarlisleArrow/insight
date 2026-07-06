import { useState, useEffect, useRef } from 'react';
import {
  Button, Tag, TextInput, Checkbox, Toggle, InlineNotification,
  Tabs, TabList, Tab, TabPanels, TabPanel,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
  OverflowMenu, OverflowMenuItem,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot, ToolBtn } from '../components/shared.jsx';
import { Picker } from '../components/inputs.jsx';
import { startPointerDrag, snap } from '../components/dnd.js';
import { tr, trList } from '../i18n.js';
import {
  AI_PROVIDERS, AI_CAP_TAG, AI_SENS_LEVELS,
  SEM_CB_LABEL, SEM_DEFAULT_DETAIL,
  AG_NODE_TYPES, AG_PALETTE_GROUPS, AG_TRIGGER_TAG, AG_NODES, AG_EDGES, AG_TEMPLATES,
  AI_SEV_COLOR, AI_SEV_TAG, AI_INSIGHTS, AI_QA_SUGGEST,
} from '../data/mockData.js';
import {
  aiModels as aiModelsApi, testAiModel, testAiModelSpec,
  getAiSemantic, saveAiSemantic, compileAiSemantic, testAiSemantic,
  aiAnalyze,
  agentFlows as agentFlowsApi, runAgentFlow, approveAgentRun,
} from '../data/api.js';

/* AI capabilities (§ Models · Semantic · Agent Studio · Insights):
   register the models the platform may call (with a hard local-only data
   boundary for sensitive data), describe entities so agents reason correctly,
   compose governed agent flows, and surface data-grounded, traceable insights. */

/* ---------- shared bits ---------- */
function ProviderCell({ provider }) {
  const p = AI_PROVIDERS[provider] || { c: '#6f6f6f', ab: '?' };
  return <span className="am-prov"><span className="sw" style={{ background: p.c }}>{p.ab}</span>{provider}</span>;
}
function DeployTag({ kind, lang }) {
  return kind === 'local'
    ? <span className="am-deploy local"><Icon name="locked" size={12} />{tr(lang, 'Local · data stays on-site')}</span>
    : <span className="am-deploy external"><Icon name="cloud" size={12} />{tr(lang, 'External')}</span>;
}
function Bars({ data, height = 90 }) {
  const max = Math.max(...data, 1);
  return (
    <div className="ai-bars" style={{ height }}>
      {data.map((v, i) => <div key={i} className={`b ${v < 1.0 ? 'warn' : ''}`} style={{ height: `${(v / max) * 100}%` }} />)}
    </div>
  );
}

/* ============================ MODELS ============================ */
function ModelModal({ model, onClose, onDone, notify, lang }) {
  const editing = !!model;
  const [name, setName] = useState(model ? model.name : '');
  const [endpoint, setEndpoint] = useState(model ? model.endpoint : '');
  const [ref, setRef] = useState(model ? model.ref : '');
  const [secretRef, setSecretRef] = useState(model ? (model.auth_secret_ref || '') : '');
  const [maxTok, setMaxTok] = useState(model && model.max_tokens ? String(model.max_tokens) : '4096');
  const [provider, setProvider] = useState(model ? model.provider : 'Anthropic');
  const [deploy, setDeploy] = useState(model ? model.deploy : 'external');
  const [caps, setCaps] = useState(model ? model.caps : ['chat']);
  const [isDefault, setIsDefault] = useState(model ? model.default : false);
  const [test, setTest] = useState(null); // null | running | ok | err
  const [testDetail, setTestDetail] = useState(null); // {ms, reply} | {error}
  const [saving, setSaving] = useState(false);
  const toggleCap = (c) => setCaps((cs) => cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]);
  const body = () => ({
    name, provider, endpoint, ref, auth_secret_ref: secretRef,
    caps, max_tokens: parseInt(maxTok, 10) || 0, deploy, default: isDefault,
    status: model ? model.status : 'Active', enabled: model ? model.enabled !== false : true,
  });
  // Real connectivity probe against the (possibly unsaved) spec — the backend
  // dispatches a short prompt to the endpoint and relays the reply.
  const runTest = async () => {
    setTest('running'); setTestDetail(null);
    try {
      const res = await testAiModelSpec(body());
      setTest(res.ok ? 'ok' : 'err');
      setTestDetail(res);
    } catch (err) {
      setTest('err'); setTestDetail({ error: err.detail || err.message });
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      if (editing) await aiModelsApi.update(model.id, { ...body(), id: model.id });
      else await aiModelsApi.create(body());
      onDone();
      notify && notify({ kind: 'success', title: editing ? 'Model updated' : 'Model registered', subtitle: `${provider} · ${deploy === 'local' ? 'local deployment' : 'external endpoint'}` });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Save failed', subtitle: err.detail || err.message });
    } finally { setSaving(false); }
  };
  return (
    <ComposedModal open size="lg" onClose={onClose}>
      <ModalHeader label={editing ? 'Edit model' : tr(lang, 'Add model')} title={editing ? model.name : tr(lang, 'Register AI model')} />
      <ModalBody hasForm>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="w-row">
            <TextInput id="am-nm" labelText="Model name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. claude-prod" />
            <Picker label={tr(lang, 'Provider')} items={Object.keys(AI_PROVIDERS)} value={provider} onChange={setProvider} />
          </div>
          <div className="w-row">
            <TextInput id="am-ep" labelText={deploy === 'local' ? 'Endpoint (in-cluster address)' : 'Endpoint'} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={deploy === 'local' ? 'vllm.insight.svc:8000' : 'api.anthropic.com'} />
            <TextInput id="am-ref" labelText="Model identifier (model_ref)" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="claude-opus-4-8" />
          </div>
          <div className="w-row">
            <div className="w-fld">
              <TextInput id="am-key" labelText="API key Secret ref" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} placeholder="AI_KEY_CLAUDE_PROD" />
              <div style={{ fontSize: '.6875rem', color: 'var(--cds-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="locked" size={14} />Name of the K8s Secret / env var holding the key — the key itself is never stored here.</div>
            </div>
            <TextInput id="am-tok" labelText="max_tokens" value={maxTok} onChange={(e) => setMaxTok(e.target.value)} />
          </div>

          <div className="w-fld"><label className="cds--label">{tr(lang, 'Capabilities')}</label>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {['chat', 'embedding', 'vision', 'function-call'].map((c) => (
                <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Checkbox id={`am-cap-${c}`} labelText="" checked={caps.includes(c)} onChange={() => toggleCap(c)} />
                  <Tag type={AI_CAP_TAG[c]} size="sm">{c}</Tag>
                </div>
              ))}
            </div>
          </div>

          <div className="w-fld"><label className="cds--label">{tr(lang, 'Deployment type')}</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[{ id: 'local', nm: tr(lang, 'Local'), dc: 'In-cluster model. Data never leaves the plant.' }, { id: 'external', nm: tr(lang, 'External'), dc: 'Third-party API. Only de-identified data is sent.' }].map((o) => (
                <div key={o.id} className={`ds-authcard ${deploy === o.id ? 'sel' : ''}`} style={{ background: 'transparent' }} onClick={() => setDeploy(o.id)}>
                  <div className="hd"><span className="ds-radio" /><Icon name={o.id === 'local' ? 'locked' : 'cloud'} size={18} /><span className="nm">{o.nm}</span></div>
                  <div className="dc" style={{ paddingLeft: 26 }}>{o.dc}</div>
                </div>
              ))}
            </div>
            {deploy === 'local'
              ? <InlineNotification kind="success" lowContrast hideCloseButton title="Local model — sensitive data allowed" subtitle="Data stays on-site. This model may process Confidential and Restricted classifications." />
              : <InlineNotification kind="info" lowContrast hideCloseButton title="External model — de-identified data only" subtitle="Sensitive fields are intercepted by the query gateway before any prompt leaves the cluster." />}
          </div>

          <div className="w-fld"><label className="cds--label">Connectivity</label>
            <div className="am-testbox">
              <div className="am-testbox__h">
                {test === 'running' && <span className="am-spin" />}
                {test === 'ok' && <Icon name="checkmark--filled" size={16} style={{ color: 'var(--cds-support-success)' }} />}
                {test === 'err' && <Icon name="error--filled" size={16} style={{ color: 'var(--cds-support-error)' }} />}
                {!test && <Icon name="play--outline" size={16} />}
                <span>{test === 'running' ? 'Sending test prompt…' : test === 'ok' ? tr(lang, 'Connection successful') : test === 'err' ? 'Connection failed' : 'Verify the endpoint responds'}</span>
                <Button kind="tertiary" size="sm" renderIcon={iconFor('play--outline')} onClick={runTest} style={{ marginLeft: 'auto' }} disabled={test === 'running'}>{tr(lang, 'Test connection')}</Button>
              </div>
              <div className="am-testbox__b">
                {!test && <span>Sends a short prompt to verify credentials and reachability.</span>}
                {test === 'running' && <span>Prompt: "Reply with OK if you can read this."</span>}
                {test === 'ok' && <div className="am-reply">{`${testDetail && testDetail.ms != null ? `${testDetail.ms} ms · ` : ''}${provider}\n"${(testDetail && testDetail.reply) || 'OK'}"`}</div>}
                {test === 'err' && <span style={{ color: 'var(--cds-support-error)' }}>{(testDetail && (testDetail.error || testDetail.reply)) || 'Connection failed.'}</span>}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle id="am-default" size="sm" hideLabel labelText="" toggled={isDefault} onToggle={(v) => setIsDefault(v)} />
            <span style={{ fontSize: '.8125rem' }}>Set as default model for new Agent inference nodes</span>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>{tr(lang, 'Cancel')}</Button>
        <Button kind="primary" renderIcon={iconFor('save')} disabled={saving || !name || !endpoint || !ref} onClick={save}>{saving ? 'Saving…' : tr(lang, 'Save model')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

function DataBoundary({ models, lang }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InlineNotification kind="info" lowContrast hideCloseButton title="Rule — sensitive data is local-only" style={{ maxWidth: '100%', width: '100%' }}
        subtitle="Data carrying a Confidential or Restricted classification may only be sent to local models. The query gateway enforces this before any prompt is dispatched." />
      <div>
        <div className="w-section-label">Which models may process which sensitivity levels</div>
        <table className="am-boundary">
          <thead><tr><th>Model</th><th>{tr(lang, 'Deployment')}</th>{AI_SENS_LEVELS.map((l) => <th key={l.lvl}><Tag type={l.tag} size="sm">{l.lvl}</Tag></th>)}</tr></thead>
          <tbody>
            {models.filter((m) => m.status === 'Active').map((m) => (
              <tr key={m.id}>
                <td className="ip-mono" style={{ fontWeight: 500, color: 'var(--cds-text-primary)' }}>{m.name}</td>
                <td><DeployTag kind={m.deploy} lang={lang} /></td>
                {AI_SENS_LEVELS.map((l, i) => {
                  const allowed = m.deploy === 'local' ? true : i < 2;
                  return <td key={l.lvl}>{allowed ? <Icon name="checkmark--filled" size={16} className="yes" /> : <Icon name="close" size={16} className="no" />}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 8 }}>Local models process every level. External models are capped at Public and Internal — Confidential and Restricted are intercepted.</div>
      </div>
    </div>
  );
}

function ModelDetail({ model, onBack, notify, lang }) {
  const [pp, setPp] = useState(false);
  const usage = model.usage || { calls: '0', tokens: '0', flows: [] };
  const runTest = async () => {
    try {
      const res = await testAiModel(model.id);
      if (res.ok) notify && notify({ kind: 'success', title: tr(lang, 'Connection successful'), subtitle: `${model.name} responded in ${res.ms} ms.` });
      else notify && notify({ kind: 'error', title: 'Connection failed', subtitle: res.error });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Connection failed', subtitle: err.detail || err.message });
    }
  };
  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to models')}</Button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 className="ip-mono" style={{ fontSize: '1.75rem', fontWeight: 400, margin: 0 }}>{model.name}</h1>
        {model.default && <Icon name="star--filled" size={18} style={{ color: 'var(--cds-blue-60)' }} />}
        <DeployTag kind={model.deploy} lang={lang} />
        <StatusDot kind={model.status === 'Active' ? 'success' : 'stopped'}>{model.status}</StatusDot>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
          <Button kind="tertiary" size="md" renderIcon={iconFor('play--outline')} onClick={runTest}>{tr(lang, 'Test connection')}</Button>
          <Button kind="tertiary" size="md" renderIcon={iconFor('edit')}>{tr(lang, 'Edit')}</Button>
        </div>
      </div>
      <Tabs>
        <TabList aria-label="Model detail"><Tab>{tr(lang, 'Overview')}</Tab><Tab>{tr(lang, 'Usage')}</Tab><Tab>{tr(lang, 'Test playground')}</Tab></TabList>
        <TabPanels>
          <TabPanel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <dl className="w-dl">
                <dt>{tr(lang, 'Provider')}</dt><dd><ProviderCell provider={model.provider} /></dd>
                <dt>Endpoint</dt><dd className="ip-mono">{model.endpoint}</dd>
                <dt>Model ref</dt><dd className="ip-mono">{model.ref}</dd>
                <dt>{tr(lang, 'Deployment')}</dt><dd><DeployTag kind={model.deploy} lang={lang} /></dd>
                <dt>max_tokens</dt><dd>{model.tok || '—'}</dd>
                <dt>{tr(lang, 'Last tested')}</dt><dd>{model.tested ? new Date(model.tested).toLocaleString() : '—'}</dd>
              </dl>
              <div className="w-fld"><label className="cds--label">{tr(lang, 'Capabilities')}</label><div className="am-caps">{model.caps.map((c) => <Tag key={c} type={AI_CAP_TAG[c]} size="sm">{c}</Tag>)}</div></div>
              {model.deploy === 'local'
                ? <InlineNotification kind="success" lowContrast hideCloseButton title="Sensitive data allowed" subtitle="Local deployment — may process Confidential and Restricted data." />
                : <InlineNotification kind="info" lowContrast hideCloseButton title="De-identified data only" subtitle="External endpoint — sensitive fields are intercepted by the query gateway." />}
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <div className="w-stats" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
                <div className="s"><div className="k"><Icon name="chart--bar" size={16} />Calls (30d)</div><div className="v">{usage.calls}</div></div>
                <div className="s"><div className="k"><Icon name="data--base" size={16} />Tokens (30d)</div><div className="v">{usage.tokens}</div></div>
                <div className="s"><div className="k"><Icon name="share" size={16} />Referenced by</div><div className="v">{usage.flows.length}</div></div>
              </div>
              <div className="w-fld"><label className="cds--label">Referenced by Agent flows</label>
                {usage.flows.length === 0 ? <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-placeholder)' }}>Not referenced by any flow yet.</div>
                  : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{usage.flows.map((f) => <div key={f} className="w-chip" style={{ cursor: 'default' }}><Icon name="share" size={14} />{f}</div>)}</div>}
              </div>
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <div className="am-play">
                <div className="am-play__col">
                  <div style={{ fontSize: '.8125rem', fontWeight: 600 }}>Prompt</div>
                  <textarea className="am-ta" rows={6} defaultValue="Explain what gold.spc_capability_daily measures, in one sentence." />
                  <div className="w-row"><Picker label="Temperature" items={['0.0', '0.2', '0.7', '1.0']} value="0.2" onChange={() => {}} size="sm" /><Picker label="max_tokens" items={['256', '512', '1024']} value="512" onChange={() => {}} size="sm" /></div>
                  <Button kind="primary" renderIcon={iconFor('play')} onClick={() => setPp(true)}>Run prompt</Button>
                </div>
                <div className="am-play__col">
                  <div style={{ fontSize: '.8125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>Response{pp && <Tag type="green" size="sm" style={{ marginLeft: 'auto' }}>312 ms</Tag>}</div>
                  {pp ? <div className="am-reply" style={{ borderLeftColor: 'var(--cds-blue-60)' }}>gold.spc_capability_daily reports the daily process-capability indices (Cp, Cpk) per process and plant, aggregated upward from silver measurement data.</div>
                    : <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-placeholder)' }}>Run a prompt to verify the model behaves as expected.</div>}
                </div>
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

function AiModels({ open, setOpen, notify, lang }) {
  const [modal, setModal] = useState(null); // null | {} (new) | model (edit)
  const [models, setModels] = useState([]);
  const load = () => aiModelsApi.list().then(setModels).catch((err) => {
    notify && notify({ kind: 'error', title: 'Load models failed', subtitle: err.detail || err.message });
  });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveRow = async (row, patch, msg) => {
    try {
      await aiModelsApi.update(row.id, { ...row, ...patch });
      load();
      notify && notify({ kind: 'success', ...msg });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Update failed', subtitle: err.detail || err.message });
    }
  };
  const testRow = async (row) => {
    try {
      const res = await testAiModel(row.id);
      if (res.ok) { load(); notify && notify({ kind: 'success', title: tr(lang, 'Connection successful'), subtitle: `${row.name} responded in ${res.ms} ms.` }); }
      else notify && notify({ kind: 'error', title: 'Connection failed', subtitle: res.error });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Connection failed', subtitle: err.detail || err.message });
    }
  };
  const deleteRow = async (row) => {
    try {
      await aiModelsApi.remove(row.id);
      load();
      notify && notify({ kind: 'success', title: 'Model deleted', subtitle: row.name });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Delete failed', subtitle: err.detail || err.message });
    }
  };

  if (open) {
    return (
      <div>
        <div className="w-crumb"><a href="#" onClick={(e) => e.preventDefault()}>AI</a><span className="sep">/</span><a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'AI Models')}</a><span className="sep">/</span><span>{open.name}</span></div>
        <ModelDetail model={open} onBack={() => setOpen(null)} notify={notify} lang={lang} />
        {modal !== null && <ModelModal model={modal.id ? modal : null} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} notify={notify} lang={lang} />}
      </div>
    );
  }

  const headers = [
    { key: 'name', header: 'Model' }, { key: 'provider', header: tr(lang, 'Provider') },
    { key: 'endpoint', header: 'Endpoint', mono: true }, { key: 'ref', header: 'model_ref', mono: true },
    { key: 'deploy', header: tr(lang, 'Deployment') }, { key: 'caps', header: tr(lang, 'Capabilities') },
    { key: 'status', header: tr(lang, 'Status') }, { key: 'tested', header: tr(lang, 'Last tested') }, { key: 'ofw', header: '' },
  ];
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={models}
        withPagination
        searchPlaceholder={tr(lang, 'Search models by name or provider')}
        onRowClick={setOpen}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({})}>{tr(lang, 'Add model')}</Button>}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); setOpen(r); }}>{r.name}{r.default && <Icon name="star--filled" size={13} style={{ color: 'var(--cds-blue-60)', marginLeft: 6, verticalAlign: '-2px' }} />}</a>;
          if (k === 'provider') return <ProviderCell provider={r.provider} />;
          if (k === 'deploy') return <DeployTag kind={r.deploy} lang={lang} />;
          if (k === 'caps') return <span className="am-caps">{r.caps.map((c) => <Tag key={c} type={AI_CAP_TAG[c]} size="sm">{c}</Tag>)}</span>;
          if (k === 'status') return <StatusDot kind={r.status === 'Active' ? 'success' : 'stopped'}>{r.status}</StatusDot>;
          if (k === 'tested') return r.tested ? new Date(r.tested).toLocaleString() : '—';
          if (k === 'ofw') return (
            <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
              <OverflowMenuItem itemText={tr(lang, 'Edit')} onClick={() => setModal(r)} />
              <OverflowMenuItem itemText={tr(lang, 'Test connection')} onClick={() => testRow(r)} />
              <OverflowMenuItem itemText={tr(lang, 'Set as default')} onClick={() => saveRow(r, { default: true }, { title: 'Default updated', subtitle: `${r.name} is now the default model.` })} />
              <OverflowMenuItem itemText={r.status === 'Active' ? tr(lang, 'Deactivate') : 'Activate'} onClick={() => saveRow(r, { status: r.status === 'Active' ? 'Inactive' : 'Active', enabled: r.status !== 'Active' }, { title: r.status === 'Active' ? 'Model deactivated' : 'Model activated', subtitle: r.name })} />
              <OverflowMenuItem isDelete itemText={tr(lang, 'Delete')} onClick={() => deleteRow(r)} />
            </OverflowMenu>
          );
          return r[k];
        }}
      />

      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Icon name="locked" size={18} /><h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>{tr(lang, 'Data boundary policy')}</h2>
        </div>
        <DataBoundary models={models} lang={lang} />
      </div>

      {modal !== null && <ModelModal model={modal.id ? modal : null} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} notify={notify} lang={lang} />}
    </div>
  );
}

/* ============================ SEMANTIC ============================ */
function TestUnderstanding({ entity, onClose, notify, lang }) {
  const [phase, setPhase] = useState('running'); // running | done | err
  const [result, setResult] = useState(null); // {explanation, model} | {error}
  useEffect(() => {
    let live = true;
    testAiSemantic(entity.name)
      .then((res) => { if (live) { setResult(res); setPhase('done'); } })
      .catch((err) => { if (live) { setResult({ error: err.detail || err.message }); setPhase('err'); } });
    return () => { live = false; };
  }, [entity.name]);
  return (
    <ComposedModal open size="lg" onClose={onClose}>
      <ModalHeader label={tr(lang, 'Test AI understanding')} title={entity.name} />
      <ModalBody>
        <p style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', margin: '0 0 14px' }}>The AI explains this entity using only the current semantic layer. Judge whether the explanation is correct — if not, refine the semantics and re-test.</p>
        <div className="as-understand">
          <div className="as-understand__h"><Icon name="watson" size={16} />AI explanation {phase === 'done' && <Tag type="blue" size="sm" style={{ marginLeft: 'auto' }}>via {result.model} + semantic layer</Tag>}</div>
          {phase === 'running' && <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}><span className="am-spin" />Reading semantics and composing an explanation…</div>}
          {phase === 'done' && <div className="as-aibubble">{`"${result.explanation}"`}</div>}
          {phase === 'err' && <div style={{ padding: 16, color: 'var(--cds-support-error)', fontSize: '.8125rem' }}>{result.error}</div>}
        </div>
        {phase === 'done' && <InlineNotification kind="info" lowContrast hideCloseButton style={{ marginTop: 14 }} title="Grounding" subtitle="The explanation draws on nl_description, business_caliber, and domain_knowledge from the semantic layer — not the model’s prior knowledge." />}
      </ModalBody>
      <ModalFooter>
        {phase === 'done' ? (
          <>
            <Button kind="danger" renderIcon={iconFor('close')} onClick={() => { onClose(); notify && notify({ kind: 'warning', title: 'Marked as needs correction', subtitle: 'Returned to the semantic editor to refine.' }); }}>Needs correction</Button>
            <Button kind="primary" renderIcon={iconFor('checkmark')} onClick={() => { onClose(); notify && notify({ kind: 'success', title: 'Understanding confirmed', subtitle: `${entity.name} semantics verified.` }); }}>Correct</Button>
          </>
        ) : (
          <><Button kind="secondary" onClick={onClose}>{tr(lang, 'Cancel')}</Button><Button kind="primary" disabled>{phase === 'err' ? 'Failed' : 'Reviewing…'}</Button></>
        )}
      </ModalFooter>
    </ComposedModal>
  );
}

function EntityEditor({ entity, onTest, onSaved, notify, lang }) {
  const d = entity.detail || SEM_DEFAULT_DETAIL;
  const [form, setForm] = useState(d);
  useEffect(() => { setForm(entity.detail || SEM_DEFAULT_DETAIL); }, [entity]);
  const save = async () => {
    try {
      await saveAiSemantic(entity.name, { ...form, type: entity.type, urn: entity.name, cb: '' });
      notify && notify({ kind: 'success', title: 'Semantics saved', subtitle: entity.name });
      onSaved && onSaved();
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Save failed', subtitle: err.detail || err.message });
    }
  };
  const field = (lbl, sub, key, rows) => (
    <div className="as-grp">
      <div className="as-fldlbl">{lbl}</div>
      {sub && <div className="as-fldsub">{sub}</div>}
      <textarea className="as-ta" rows={rows || 2} value={form[key] || ''} key={entity.id + lbl}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </div>
  );
  return (
    <div className="as-edit">
      <div className="as-edit__h">
        <Icon name={entity.type === 'metric' ? 'analytics' : entity.type === 'field' ? 'list' : 'data--base'} size={20} />
        <h2>{entity.name}</h2>
        <Tag type="cool-gray" size="sm">{entity.type}</Tag>
        <span className={`as-cb ${entity.cb}`} style={{ marginLeft: 'auto' }}>{SEM_CB_LABEL[entity.cb]}</span>
      </div>
      <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', marginBottom: 20 }}>Describe this entity so AI agents and retrieval can reason about it accurately.</div>

      <div className="as-vecbar">
        <Icon name={entity.cb === 'vec' ? 'checkmark--filled' : 'time'} size={18} style={{ color: entity.cb === 'vec' ? 'var(--cds-support-success)' : 'var(--cds-text-secondary)' }} />
        <div style={{ flex: 1, fontSize: '.8125rem' }}>{entity.cb === 'vec' ? 'Vectorized · embeddings current as of 2026-06-21' : 'Not yet vectorized — embeddings will be stale until regenerated.'}</div>
        <Button kind="primary" renderIcon={iconFor('renew')} className="as-vecbtn" onClick={() => notify && notify({ kind: 'success', title: 'Re-vectorized', subtitle: `${entity.name} embeddings refreshed.` })}>Re-vectorize this entity</Button>
      </div>

      {field('Natural-language meaning', 'nl_description — read by the LLM to understand intent.', 'nl', 3)}
      {field('Business caliber', 'business_caliber — the exact definition and how it is measured.', 'caliber', 2)}
      {field('Domain knowledge', 'domain_knowledge — rules a domain expert knows (e.g. r3_flag = 7 consecutive points on one side; gold aggregates ascending).', 'domain', 3)}
      {field('Sample values', 'sample_values — concrete examples that help AI ground the entity.', 'samples', 2)}
      {field('Relationships', 'relationships — joins and lineage to other entities.', 'rels', 2)}
      {field('Constraints', 'constraints — invariants AI must respect.', 'constraints', 2)}

      <div className="as-grp">
        <div className="as-fldlbl">Sensitivity classification <Tag type="cool-gray" size="sm">read-only · from ACL</Tag></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Tag type={form.sens === 'Restricted' ? 'red' : form.sens === 'Confidential' ? 'purple' : 'blue'} size="md">{form.sens || 'Internal'}</Tag><span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>Inherited from access-control classification — edit in Governance.</span></div>
      </div>

      <div style={{ display: 'flex', gap: 1, paddingTop: 8, borderTop: '1px solid var(--wire-border)' }}>
        <Button kind="primary" renderIcon={iconFor('save')} onClick={save}>{tr(lang, 'Save')}</Button>
        <Button kind="tertiary" renderIcon={iconFor('watson')} onClick={() => onTest(entity)}>{tr(lang, 'Test AI understanding')}</Button>
      </div>
    </div>
  );
}

function AiSemantic({ notify, lang }) {
  const [layers, setLayers] = useState([]);
  const [sel, setSel] = useState(null);
  const [test, setTest] = useState(null);
  const [filter, setFilter] = useState('All');
  const [q, setQ] = useState('');
  // Group flat ai_semantic rows into the layer tree the UI renders: tables get
  // their schema prefix as the layer; bare metrics/fields land under "business".
  const load = () => getAiSemantic().then((items) => {
    const groups = {};
    items.forEach((it) => {
      const layer = it.urn.includes('.') ? it.urn.split('.')[0] : 'business';
      const ent = {
        id: it.urn, name: it.urn, type: it.type, cb: it.cb,
        detail: { nl: it.nl, caliber: it.caliber, domain: it.domain, samples: it.samples, rels: it.rels, constraints: it.constraints, sens: it.sens },
      };
      (groups[layer] = groups[layer] || []).push(ent);
    });
    const ls = Object.entries(groups).map(([layer, entities]) => ({ layer, entities }));
    setLayers(ls);
    setSel((s) => {
      const flat = ls.flatMap((g) => g.entities);
      return (s && flat.find((e) => e.id === s.id)) || flat[0] || null;
    });
  }).catch((err) => notify && notify({ kind: 'error', title: 'Load semantic layer failed', subtitle: err.detail || err.message }));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const compile = async () => {
    try {
      const res = await compileAiSemantic();
      load();
      notify && notify({ kind: 'success', title: 'Auto-generation finished', subtitle: `${res.added} new entities pre-filled from DataHub + Glossary.` });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Auto-generation failed', subtitle: err.detail || err.message });
    }
  };
  const match = (e) => (filter === 'All' || SEM_CB_LABEL[e.cb] === filter) && e.name.toLowerCase().includes(q.toLowerCase());
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 1, marginBottom: 16 }}>
        <Button kind="ghost" size="md" renderIcon={iconFor('watson')} onClick={compile}>{tr(lang, 'Auto-generate from DataHub + Glossary + ETL')}</Button>
        <Button kind="primary" size="md" renderIcon={iconFor('renew')} onClick={() => notify && notify({ kind: 'info', title: 'Re-vectorizing all entities', subtitle: 'Embedding job queued.' })}>{tr(lang, 'Re-vectorize')}</Button>
      </div>
      <div className="as-wrap">
        <div className="as-tree">
          <div className="as-tree__tb">
            <TextInput id="as-q" size="sm" labelText="" placeholder={tr(lang, 'Search entities')} value={q} onChange={(e) => setQ(e.target.value)} />
            <Picker items={['All', 'Vectorized', 'Described', 'Pending']} value={filter} onChange={setFilter} size="sm" />
          </div>
          <div className="as-tree__body">
            {layers.length === 0 && <div style={{ padding: 16, fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>No entities yet — run auto-generation to pre-fill from DataHub, or they appear as pipelines register tables.</div>}
            {layers.map((g) => {
              const ents = g.entities.filter(match);
              if (ents.length === 0) return null;
              return (
                <div key={g.layer}>
                  <div className={`as-layer ${g.layer}`}><Icon name="data--base" size={14} />{g.layer}</div>
                  {ents.map((e) => (
                    <div key={e.id} className={`as-ent ${sel && sel.id === e.id ? 'sel' : ''}`} onClick={() => setSel(e)}>
                      <Icon name={e.type === 'metric' ? 'analytics' : e.type === 'field' ? 'list' : 'data--base'} size={14} style={{ color: 'var(--cds-icon-secondary)' }} />
                      <span><div className="nm">{e.name}</div><div className="ty">{e.type}</div></span>
                      <span className={`as-cb ${e.cb}`}>{SEM_CB_LABEL[e.cb]}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        {sel && <EntityEditor entity={sel} onTest={setTest} onSaved={load} notify={notify} lang={lang} />}
      </div>
      {test && <TestUnderstanding entity={test} onClose={() => setTest(null)} notify={notify} lang={lang} />}
    </div>
  );
}

/* ============================ AGENT STUDIO ============================ */
const NW = 184, NH = 78;
const portOf = (node, side) => {
  if (side === 'out') return { x: node.x + NW, y: node.y + NH / 2 };
  if (side === 'in') return { x: node.x, y: node.y + NH / 2 };
  if (side === 'bottom') return { x: node.x + NW / 2, y: node.y + NH };
  return { x: node.x + NW / 2, y: node.y };
};

function FlowCanvas({ nodes, edges, zoom, sel, onSelect, onMove, onCreate, onConnect, onZoom, lang }) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const sceneRef = useRef(null);
  const canvasRef = useRef(null);
  const [link, setLink] = useState(null); // in-progress wire: { from, x, y } in scene coords
  const scenePoint = (e) => {
    const rect = sceneRef.current.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };
  // Hold Ctrl and scroll to zoom (native non-passive listener so preventDefault sticks).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => { if (!e.ctrlKey) return; e.preventDefault(); onZoom(e.deltaY < 0 ? 0.1 : -0.1); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);
  // Grab empty canvas to pan (scroll). Nodes and ports handle their own pointer events.
  const startPan = (e) => {
    if (e.button !== 0 || (e.target.closest && (e.target.closest('[data-node-id]') || e.target.closest('.ag-port')))) return;
    const el = canvasRef.current;
    const sl = el.scrollLeft; const st = el.scrollTop;
    el.classList.add('panning');
    startPointerDrag(e, (dx, dy) => { el.scrollLeft = sl - dx; el.scrollTop = st - dy; }, () => el.classList.remove('panning'));
  };
  // Drag a node by its header. Screen deltas are divided by zoom to stay 1:1 with the cursor.
  const drag = (e, id) => {
    e.stopPropagation();
    onSelect(id);
    const n = byId[id]; if (!n) return;
    const ox = n.x; const oy = n.y;
    startPointerDrag(e, (dx, dy) => onMove(id, Math.max(0, snap(ox + dx / zoom)), Math.max(0, snap(oy + dy / zoom))));
  };
  // Drag from a node's output port to another node to wire them together.
  const startLink = (e, id) => {
    e.stopPropagation();
    e.preventDefault();
    const p = scenePoint(e);
    setLink({ from: id, x: p.x, y: p.y });
    const move = (ev) => { const q = scenePoint(ev); setLink((l) => (l ? { ...l, x: q.x, y: q.y } : l)); };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const hit = ev.target.closest && ev.target.closest('[data-node-id]');
      const toId = hit && hit.getAttribute('data-node-id');
      setLink(null);
      if (toId && toId !== id) onConnect(id, toId);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  // Drop a palette node onto the canvas — position is the pointer, un-scaled into scene space.
  const onDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/ag-node');
    if (!type || !sceneRef.current) return;
    const p = scenePoint(e);
    onCreate(type, Math.max(0, snap(p.x - NW / 2)), Math.max(0, snap(p.y - NH / 2)));
  };
  return (
    <div className="ag-canvas" ref={canvasRef} onPointerDown={startPan} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="ag-scene" ref={sceneRef} style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <defs><marker id="agarrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L6,4 L0,8 z" fill="var(--cds-border-strong-01)" /></marker></defs>
          {link && byId[link.from] && (() => {
            const p = portOf(byId[link.from], 'out');
            const midx = (p.x + link.x) / 2;
            const d = `M ${p.x} ${p.y} C ${midx} ${p.y}, ${midx} ${link.y}, ${link.x} ${link.y}`;
            return <path d={d} fill="none" stroke="var(--cds-blue-60)" strokeWidth={2} strokeDasharray="5 4" markerEnd="url(#agarrow)" />;
          })()}
          {edges.map((e, i) => {
            const na = byId[e.a]; const nb = byId[e.b];
            if (!na || !nb) return null;
            let p, q;
            if (e.a === 'n3' && e.b === 'n4') { p = portOf(na, 'out'); q = { x: nb.x, y: nb.y + NH / 2 + 14 }; }
            else if (e.a === 'n5' && e.b === 'n6') { p = portOf(na, 'bottom'); q = portOf(nb, 'top'); }
            else { p = portOf(na, 'out'); q = portOf(nb, 'in'); }
            const active = sel === e.a || sel === e.b;
            const midx = (p.x + q.x) / 2;
            const d = `M ${p.x} ${p.y} C ${midx} ${p.y}, ${midx} ${q.y}, ${q.x} ${q.y}`;
            return <path key={i} d={d} fill="none" stroke={active ? 'var(--cds-blue-60)' : 'var(--cds-border-strong-01)'} strokeWidth={active ? 2 : 1.5} markerEnd="url(#agarrow)" />;
          })}
        </svg>
        {edges.filter((e) => e.label).map((e, i) => {
          const na = byId[e.a]; const nb = byId[e.b];
          if (!na || !nb) return null;
          const p = portOf(na, e.b === 'n6' ? 'bottom' : 'out');
          const q = e.b === 'n6' ? portOf(nb, 'top') : portOf(nb, 'in');
          return <span key={i} className="ag-branch" style={{ left: (p.x + q.x) / 2 - 12, top: (p.y + q.y) / 2 - 9, color: e.label === 'Yes' ? '#0e6027' : 'var(--cds-text-secondary)', borderColor: e.label === 'Yes' ? 'var(--cds-support-success)' : 'var(--wire-border)' }}>{e.label}</span>;
        })}
        {nodes.map((n) => {
          const t = AG_NODE_TYPES[n.type];
          return (
            <div key={n.id} data-node-id={n.id} className={`ag-node ${sel === n.id ? 'sel' : ''}`} style={{ left: n.x, top: n.y, borderTop: `3px solid ${t.c}` }} onClick={() => onSelect(n.id)}>
              <div className="ag-node__h" style={{ cursor: 'move', touchAction: 'none' }} onPointerDown={(e) => drag(e, n.id)}><span className="ic" style={{ background: t.c }}><Icon name={t.icon} size={13} /></span>{n.name}</div>
              <div className="ag-node__b">{t.label}{n.sub && <> · <span className="mono">{n.sub}</span></>}</div>
              {n.masked && <div className="ag-node__tag"><Tag type="teal" size="sm"><Icon name="locked" size={11} /> auto-masked</Tag></div>}
              <span className="ag-port in" />
              <span className="ag-port out" style={{ touchAction: 'none' }} title={tr(lang, 'Drag to connect')} onPointerDown={(e) => startLink(e, n.id)} />
            </div>
          );
        })}
        <div className="w-engine" style={{ position: 'absolute', right: 16, bottom: 16 }}><Icon name="share" size={16} /><span><b>{nodes.length} nodes</b> · {edges.length} edges</span></div>
      </div>
    </div>
  );
}

function NodeConfig({ node, lang }) {
  const n = node;
  if (!n) return <div style={{ padding: 16, fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>{tr(lang, 'Select a node to configure it.')}</div>;
  const t = AG_NODE_TYPES[n.type];
  return (
    <>
      <div className="ag-cfg__h">
        <span className="ic" style={{ background: t.c, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Icon name={t.icon} size={13} /></span>
        {n.name}<Tag type="cool-gray" size="sm" style={{ marginLeft: 'auto' }}>{t.label}</Tag>
      </div>
      <div className="ag-cfg__b">
        <TextInput size="sm" id={`ag-nm-${n.id}`} labelText="Node name" defaultValue={n.name} key={n.id} />
        {n.type === 'trigger' && <>
          <Picker size="sm" label="Trigger type" items={['Manual', 'Scheduled (cron)', 'Event']} value="Event" onChange={() => {}} />
          <TextInput size="sm" id="ag-evt" labelText="Event condition" defaultValue="metric.cpk < 1.0" />
          <div className="ag-cfg__note"><Icon name="information" size={14} />Fires when an upstream monitor reports Cpk below threshold.</div>
        </>}
        {n.type === 'query' && <>
          <Picker size="sm" label="Dataset / table" items={['gold.spc_capability_daily', 'gold.agg_yield_daily', 'silver.spc_measurements']} value="gold.spc_capability_daily" onChange={() => {}} />
          <div className="w-fld"><label className="cds--label">Fields</label><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{['process_id', 'plant', 'cal_date', 'cpk', 'cp'].map((f) => <Tag key={f} type="blue" size="sm">{f}</Tag>)}</div></div>
          <TextInput size="sm" id="ag-flt" labelText="Filter" defaultValue="cal_date = today AND cpk < 1.0" />
          <InlineNotification kind="info" lowContrast hideCloseButton title="Routed through the query gateway" subtitle="Results are automatically de-identified — sensitive fields are masked before the agent sees them." />
        </>}
        {n.type === 'retrieve' && <>
          <Picker size="sm" label="Retrieval scope" items={['gold layer', 'All layers', 'Domain: Quality']} value="Domain: Quality" onChange={() => {}} />
          <TextInput size="sm" id="ag-topk" labelText="top-k" defaultValue="5" />
          <div className="ag-cfg__note"><Icon name="search" size={14} />Searches the AI semantic layer for relevant definitions and domain rules.</div>
        </>}
        {n.type === 'ai' && <>
          <Picker size="sm" label="Model" items={['claude-prod', 'local-qwen', 'gpt-vision-ext']} value="claude-prod" onChange={() => {}} />
          <div className="w-fld"><label className="cds--label">Prompt template</label>
            <div className="ag-promptbox" contentEditable suppressContentEditableWarning style={{ minHeight: 110 }}>
              Process <span className="ag-var">{'{{n1.process_id}}'}</span> on plant <span className="ag-var">{'{{n1.plant}}'}</span> has Cpk <span className="ag-var">{'{{n2.cpk}}'}</span>.{'\n'}Using this context:{'\n'}<span className="ag-var">{'{{n3.retrieved}}'}</span>{'\n'}Draft a remediation plan with 3 prioritized actions.
            </div>
            <div className="ag-cfg__note"><Icon name="information" size={14} />Reference upstream outputs with <span className="ag-var">{'{{node.field}}'}</span>.</div>
          </div>
          <div className="w-row"><Picker size="sm" label="Temperature" items={['0.0', '0.2', '0.7']} value="0.2" onChange={() => {}} /><TextInput size="sm" id="ag-mt" labelText="max_tokens" defaultValue="1024" /></div>
        </>}
        {n.type === 'cond' && <>
          <TextInput size="sm" id="ag-cond" labelText="Condition expression" defaultValue="n2.cpk < 0.8" />
          <div className="ag-cfg__note"><Icon name="interactions" size={14} />Branches labelled Yes / No on the canvas. References upstream variables.</div>
        </>}
        {n.type === 'hitl' && <>
          <Picker size="sm" label="Approver role" items={['Process Engineer', 'Quality Manager', 'Plant Lead']} value="Process Engineer" onChange={() => {}} />
          <TextInput size="sm" id="ag-inst" labelText="Instruction" defaultValue="Review the AI remediation plan before dispatch." />
          <Picker size="sm" label="On timeout (4h)" items={['Reject', 'Auto-approve', 'Escalate']} value="Escalate" onChange={() => {}} />
        </>}
        {n.type === 'output' && <>
          <Picker size="sm" label="Output type" items={['Report (PDF)', 'Notification', 'Write-back', 'Push recommendation']} value="Notification" onChange={() => {}} />
          <TextInput size="sm" id="ag-tgt" labelText="Target" defaultValue="#quality-alerts, plant lead" />
          <div className="ag-cfg__note"><Icon name="send" size={14} />Also generates a PDF report attached to the AI Insights feed.</div>
        </>}
        {(n.type === 'tool' || n.type === 'loop') && <div className="ag-cfg__note"><Icon name="information" size={14} />Configure the {t.label.toLowerCase()} parameters.</div>}
      </div>
    </>
  );
}

const STATUS_ICON = { ok: { n: 'checkmark--filled', c: 'var(--cds-support-success)' }, wait: { n: 'time', c: 'var(--cds-support-warning)' }, pending: { n: 'time', c: 'var(--cds-text-placeholder)' }, skip: { n: 'subtract', c: 'var(--cds-text-placeholder)' }, err: { n: 'error--filled', c: 'var(--cds-support-error)' } };
const RUN_STATUS_DOT = { success: ['success', 'Success'], failed: ['error', 'Failed'], rejected: ['error', 'Rejected'], awaiting_approval: ['warning', 'Awaiting approval'], running: ['blue', 'Running'] };
function RunTrace({ flowName, run, onRunChange, onClose, notify, lang }) {
  const [open, setOpen] = useState({});
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const steps = Array.isArray(run.trace) ? run.trace : JSON.parse(run.trace || '[]');
  const [dotKind, dotLabel] = RUN_STATUS_DOT[run.status] || ['blue', run.status];
  // HITL resume (§21): records the decision, the backend re-enters the engine.
  const decide = async (approve) => {
    try {
      const updated = await approveAgentRun(run.id, approve);
      onRunChange(updated);
      notify && notify(approve
        ? { kind: 'success', title: tr(lang, 'Approve'), subtitle: 'Flow resumed — dispatching output.' }
        : { kind: 'info', title: tr(lang, 'Reject'), subtitle: 'Flow halted at approval step.' });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Approval failed', subtitle: err.detail || err.message });
    }
  };
  return (
    <div className="ag-tracewrap">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)', position: 'sticky', top: 0, zIndex: 2 }}>
        <Icon name="interactions" size={20} /><span style={{ fontSize: '1rem', fontWeight: 600 }}>{tr(lang, 'Run trace')} · {flowName}</span>
        <Tag type="blue" size="sm">run #{String(run.id).slice(0, 8)}</Tag><StatusDot kind={dotKind}>{dotLabel}</StatusDot>
        <Button kind="ghost" size="md" hasIconOnly renderIcon={iconFor('close')} iconDescription={tr(lang, 'Close')} onClick={onClose} style={{ marginLeft: 'auto' }} />
      </div>
      <div style={{ padding: '10px 20px', background: 'rgba(15,98,254,.06)', borderBottom: '1px solid var(--wire-border)', fontSize: '.8125rem', color: 'var(--cds-text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="information--filled" size={16} style={{ color: 'var(--cds-blue-60)' }} />Every AI conclusion is traceable to the exact data rows it read. Data queries show what was retrieved and whether masking was applied.
      </div>
      <div style={{ padding: 20 }}>
        <div className="ag-trace">
          {steps.map((s, idx) => {
            const t = AG_NODE_TYPES[s.type] || AG_NODE_TYPES.tool;
            const si = STATUS_ICON[s.status] || STATUS_ICON.pending;
            const key = s.id || idx;
            return (
              <div key={key} className="ag-step">
                <div className="ag-step__h" onClick={() => toggle(key)}>
                  <span className="ag-step__ic" style={{ background: t.c }}><Icon name={t.icon} size={14} /></span>
                  <span style={{ flex: 1 }}><div className="ag-step__nm">{s.name || s.id}</div><div className="ag-step__sub">{t.label}</div></span>
                  {s.masked && <Tag type="teal" size="sm"><Icon name="locked" size={11} /> masked</Tag>}
                  <span className="ag-step__sub" style={{ minWidth: 56, textAlign: 'right' }}>{s.dur}</span>
                  <Icon name={si.n} size={18} style={{ color: si.c }} />
                  <Icon name={open[key] ? 'chevron--up' : 'chevron--down'} size={16} />
                </div>
                {open[key] && (
                  <div className="ag-step__b">
                    {s.io && <dl className="ag-io"><dt>Input</dt><dd>{s.io.in}</dd><dt>Output</dt><dd>{s.io.out}</dd></dl>}
                    {s.evidence && s.evidence.length > 0 && <div><div style={{ fontSize: '.75rem', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="data--base" size={14} />Data rows read (grounding evidence) · masking applied</div>
                      <table className="ag-evidence"><thead><tr>{s.evidence[0].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{s.evidence.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>}
                    {s.model && <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '.75rem' }}><span style={{ fontWeight: 600 }}>Model</span><Tag type="purple" size="sm">{s.model}</Tag></div>
                      <div><div style={{ fontSize: '.75rem', fontWeight: 600, marginBottom: 4 }}>Prompt</div><div className="ag-codeblk">{s.prompt}</div></div>
                      <div><div style={{ fontSize: '.75rem', fontWeight: 600, marginBottom: 4 }}>Response</div><div className="ag-codeblk" style={{ borderLeft: '3px solid #8a3ffc' }}>{s.reply}</div></div>
                    </>}
                    {s.status === 'wait' && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <InlineNotification kind="warning" lowContrast hideCloseButton title="Paused — waiting for approval" subtitle="The flow stops here until an approver resumes it." />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button kind="primary" size="sm" renderIcon={iconFor('checkmark')} onClick={() => decide(true)}>{tr(lang, 'Approve')}</Button>
                        <Button kind="danger" size="sm" renderIcon={iconFor('close')} onClick={() => decide(false)}>{tr(lang, 'Reject')}</Button>
                      </div>
                    </div>}
                    {s.status === 'skip' && <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-placeholder)' }}>Skipped — branch not taken.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AgentCanvas({ flow, onBack, onSaved, notify, lang }) {
  const initialNodes = Array.isArray(flow.nodes) && flow.nodes.length ? flow.nodes : AG_NODES;
  const initialEdges = Array.isArray(flow.nodes) && flow.nodes.length ? (flow.edges || []) : AG_EDGES;
  const [name, setName] = useState(flow.name);
  const [run, setRun] = useState(null); // active run whose trace is shown
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(flow.status || 'Draft');
  const [sel, setSel] = useState(initialNodes[0] ? initialNodes[0].id : null);
  const [nodes, setNodes] = useState(() => initialNodes.map((n) => ({ ...n })));
  const [edges, setEdges] = useState(() => initialEdges.map((e) => ({ ...e })));
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const idRef = useRef(1);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const persist = async (patch = {}, msg) => {
    try {
      await agentFlowsApi.update(flow.id, {
        name, desc: flow.desc || '', trigger: flow.triggerSpec || { type: 'manual' },
        nodes, edges, status, ...patch,
      });
      onSaved && onSaved();
      msg && notify && notify({ kind: 'success', ...msg });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Save failed', subtitle: err.detail || err.message });
    }
  };
  // Test run: saves the canvas first so the engine executes what you see, then
  // runs to completion or the first approval pause and opens the trace.
  const testRun = async () => {
    setRunning(true);
    try {
      await persist();
      const res = await runAgentFlow(flow.id);
      setRun(res);
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Run failed', subtitle: err.detail || err.message });
    } finally { setRunning(false); }
  };

  // Esc exits fullscreen.
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [full]);

  const moveNode = (id, x, y) => setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, x, y } : n)));
  const addNode = (typeKey, x, y) => {
    const t = AG_NODE_TYPES[typeKey];
    const id = `ag${idRef.current++}`;
    setNodes((ns) => {
      const count = ns.filter((m) => m.type === typeKey).length + 1;
      const nx = x != null ? x : snap(60 + ((ns.length * 32) % 420));
      const ny = x != null ? y : snap(540 + Math.floor((ns.length * 32) / 420) * 100);
      return [...ns, { id, type: typeKey, x: nx, y: ny, name: `${t.label} ${count}`, sub: '' }];
    });
    setSel(id);
    notify && notify({ kind: 'success', title: `${t.label} node added`, subtitle: 'Drag it by the header to position; edit it on the right.' });
  };
  const connect = (a, b) => {
    if (a === b) return;
    setEdges((es) => (es.some((e) => e.a === a && e.b === b) ? es : [...es, { a, b }]));
    notify && notify({ kind: 'success', title: tr(lang, 'Nodes connected'), subtitle: `${byId[a]?.name || a} → ${byId[b]?.name || b}` });
  };
  const zoomBy = (d) => setZoom((z) => Math.min(2, Math.max(0.5, +(z + d).toFixed(2))));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack}>{tr(lang, 'Agent flows')}</Button>
        <Icon name="chevron--right" size={16} style={{ color: 'var(--cds-icon-secondary)' }} />
        <span style={{ fontSize: '1rem', fontWeight: 600 }}>{name}</span>
        <Tag type={status === 'Published' ? 'purple' : 'cool-gray'} size="sm">{tr(lang, status)}</Tag>
      </div>
      <div className="ag-studio" style={full ? { position: 'fixed', inset: 0, zIndex: 8000, height: '100vh', background: 'var(--cds-background)' } : undefined}>
        <div className="w-etoolbar">
          <TextInput size="sm" id="ag-title" labelText="" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 240 }} />
          <span className="gap" />
          <ToolBtn icon="save" label={tr(lang, 'Save')} onClick={() => persist({}, { title: 'Flow saved.' })} />
          <ToolBtn icon="checkmark" label={tr(lang, 'Validate')} onClick={() => notify && notify({ kind: 'success', title: 'Validation passed', subtitle: 'All nodes connected; no missing config.' })} />
          <span className="spacer" />
          <ToolBtn icon="zoom--out" title={tr(lang, 'Zoom out')} onClick={() => zoomBy(-0.1)} />
          <button className="w-iconbtn" title={tr(lang, 'Reset zoom')} onClick={() => setZoom(1)} style={{ minWidth: 48 }}>{Math.round(zoom * 100)}%</button>
          <ToolBtn icon="zoom--in" title={tr(lang, 'Zoom in')} onClick={() => zoomBy(0.1)} />
          <ToolBtn icon={full ? 'minimize' : 'maximize'} title={tr(lang, full ? 'Exit fullscreen' : 'Fullscreen')} onClick={() => setFull((f) => !f)} />
          <span className="gap" />
          <Button kind="ghost" renderIcon={iconFor('play--outline')} disabled={running} onClick={testRun}>{running ? 'Running…' : tr(lang, 'Test run')}</Button>
          <Button kind="primary" renderIcon={iconFor('launch')} onClick={() => { setStatus('Published'); persist({ status: 'Published' }, { title: 'Flow published', subtitle: name }); }}>{tr(lang, 'Publish')}</Button>
        </div>
        <div className="ag-body">
          <div className="ag-left">
            {AG_PALETTE_GROUPS.map((g) => (
              <div key={g} className="ag-grp"><h4>{g}</h4>
                {Object.entries(AG_NODE_TYPES).filter(([, t]) => t.grp === g).map(([k, t]) => (
                  <button key={k} className="ag-palitem" draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/ag-node', k); e.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => addNode(k)}>
                    <span className="sw" style={{ background: t.c }}><Icon name={t.icon} size={13} /></span>{t.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <FlowCanvas nodes={nodes} edges={edges} zoom={zoom} sel={sel} onSelect={setSel} onMove={moveNode} onCreate={addNode} onConnect={connect} onZoom={zoomBy} lang={lang} />
          <div className="ag-right"><NodeConfig node={byId[sel]} lang={lang} /></div>
        </div>
      </div>
      {run && <RunTrace flowName={name} run={run} onRunChange={setRun} onClose={() => setRun(null)} notify={notify} lang={lang} />}
    </div>
  );
}

function AgentStudio({ notify, lang }) {
  const [open, setOpen] = useState(null); // flow object being edited
  const [flows, setFlows] = useState([]);
  const load = () => agentFlowsApi.list().then(setFlows).catch((err) => {
    notify && notify({ kind: 'error', title: 'Load flows failed', subtitle: err.detail || err.message });
  });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // New flows persist immediately (with the starter template) so the canvas
  // always edits a real flow id — save/run need one.
  const createFlow = async (nm, desc) => {
    try {
      const created = await agentFlowsApi.create({
        name: nm, desc: desc || '', trigger: { type: 'manual' }, nodes: AG_NODES, edges: AG_EDGES, status: 'Draft',
      });
      setFlows((fs) => [...fs, created]);
      setOpen(created);
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Create flow failed', subtitle: err.detail || err.message });
    }
  };
  const deleteFlow = async (r) => {
    try {
      await agentFlowsApi.remove(r.id);
      load();
      notify && notify({ kind: 'success', title: 'Flow deleted', subtitle: r.name });
    } catch (err) {
      notify && notify({ kind: 'error', title: 'Delete failed', subtitle: err.detail || err.message });
    }
  };
  if (open) return <AgentCanvas flow={open} onBack={() => { setOpen(null); load(); }} onSaved={load} notify={notify} lang={lang} />;
  const headers = [
    { key: 'name', header: 'Flow' }, { key: 'desc', header: tr(lang, 'Description') },
    { key: 'trigger', header: tr(lang, 'Trigger') }, { key: 'status', header: tr(lang, 'Status') },
    { key: 'lastRun', header: tr(lang, 'Last run') }, { key: 'owner', header: tr(lang, 'Owner') }, { key: 'ofw', header: '' },
  ];
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={flows}
        searchPlaceholder={tr(lang, 'Search flows')}
        onRowClick={(r) => setOpen(r)}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => createFlow('Untitled flow')}>{tr(lang, 'New flow')}</Button>}
        renderCell={(r, k) => {
          if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); setOpen(r); }}>{r.name}</a>;
          if (k === 'trigger') { const tg = AG_TRIGGER_TAG[r.trigger === 'schedule' ? 'scheduled' : r.trigger] || { t: 'cool-gray', l: r.trigger }; return <Tag type={tg.t} size="sm">{tg.l}</Tag>; }
          if (k === 'status') return <Tag type={r.status === 'Published' ? 'green' : 'cool-gray'} size="sm">{r.status}</Tag>;
          if (k === 'lastRun') return r.lastRun === '—' ? <span>—</span> : <StatusDot kind={r.lastRun === 'running' ? 'blue' : r.lastRun === 'success' ? 'success' : 'error'}>{r.lastRun === 'running' ? tr(lang, 'Running') : r.lastRun === 'success' ? tr(lang, 'Success') : tr(lang, 'Failed')}</StatusDot>;
          if (k === 'ofw') return (
            <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
              <OverflowMenuItem itemText={tr(lang, 'Run')} onClick={() => setOpen(r)} />
              <OverflowMenuItem itemText={tr(lang, 'Edit')} onClick={() => setOpen(r)} />
              <OverflowMenuItem itemText={tr(lang, 'Run history')} onClick={() => setOpen(r)} />
              <OverflowMenuItem isDelete itemText={tr(lang, 'Delete')} onClick={() => deleteFlow(r)} />
            </OverflowMenu>
          );
          return r[k];
        }}
      />

      <div style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}><Icon name="idea" size={18} /><h2 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>{tr(lang, 'Start from a template')}</h2></div>
        <div className="w-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          {AG_TEMPLATES.map((t) => (
            <div key={t.name} className="ds-authcard" onClick={() => createFlow(t.name, t.desc)}>
              <div className="hd"><Icon name="interactions" size={18} style={{ color: 'var(--cds-blue-60)' }} /><span className="nm">{t.name}</span></div>
              <div className="dc">{t.desc}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}><Tag type="cool-gray" size="sm">{t.nodes} nodes</Tag><Button kind="ghost" size="sm" renderIcon={iconFor('add')}>{tr(lang, 'Use template')}</Button></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================ INSIGHTS ============================ */
function InsightCard({ ins, notify, lang }) {
  const [open, setOpen] = useState(ins.id === 1);
  const [fb, setFb] = useState(null);
  return (
    <div className="ai-card">
      <div className="ai-card__h">
        <span className="ai-sev" style={{ background: AI_SEV_COLOR[ins.sev] }} />
        <Icon name="watson" size={20} style={{ color: 'var(--cds-blue-60)', flex: '0 0 20px', marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <div className="ai-card__t">{ins.title}</div>
          <div className="ai-card__meta">
            <Tag type={AI_SEV_TAG[ins.sev]} size="sm">{ins.sev} severity</Tag>
            <span><Icon name="interactions" size={12} /> {ins.source}</span>
            <span><Icon name="time" size={12} /> {ins.when}</span>
            <span>process {ins.process}</span>
          </div>
        </div>
      </div>
      <div className="ai-card__sum">{ins.summary}</div>
      {open && (
        <div className="ai-card__det">
          <div>
            <div style={{ fontSize: '.75rem', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="data--base" size={14} />Data grounding — the exact rows this conclusion is based on</div>
            <table className="ai-evidence"><thead><tr>{ins.evidence[0].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{ins.evidence.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="idea" size={14} />{tr(lang, 'Recommended actions')}</div>
            <ol className="ai-rec" style={{ margin: 0, paddingLeft: 20 }}>{ins.rec.map((r) => <li key={r}>{r}</li>)}</ol>
          </div>
        </div>
      )}
      <div className="ai-actions">
        <Button kind="ghost" size="sm" renderIcon={iconFor(open ? 'chevron--up' : 'chevron--down')} onClick={() => setOpen((o) => !o)}>{open ? tr(lang, 'Hide analysis') : tr(lang, 'View full analysis')}</Button>
        <span className="ai-feedback">{tr(lang, 'Was this useful?')}
          <button className={`ai-fbtn ${fb === 'up' ? 'on' : ''}`} onClick={() => { setFb('up'); notify && notify({ kind: 'success', title: 'Thanks for the feedback' }); }}><Icon name="checkmark" size={14} /></button>
          <button className={`ai-fbtn ${fb === 'down' ? 'on' : ''}`} onClick={() => { setFb('down'); notify && notify({ kind: 'info', title: 'Feedback recorded', subtitle: 'We’ll downrank similar insights.' }); }}><Icon name="close" size={14} /></button>
        </span>
      </div>
    </div>
  );
}

function InsightsFeed({ notify, lang }) {
  const [sev, setSev] = useState('All severity');
  const [proc, setProc] = useState('All processes');
  const rows = AI_INSIGHTS.filter((i) => (sev === 'All severity' || i.sev === sev.split(' ')[0].toLowerCase()) && (proc === 'All processes' || i.process === proc));
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 160 }}><Picker items={['All processes', 'P1', 'P2', 'All']} value={proc} onChange={setProc} size="sm" /></div>
        <div style={{ minWidth: 160 }}><Picker items={['All severity', 'high severity', 'medium severity', 'low severity']} value={sev} onChange={setSev} size="sm" /></div>
        <div style={{ minWidth: 130 }}><Picker items={['All time', 'Today', 'This week']} value="All time" onChange={() => {}} size="sm" /></div>
        <div style={{ minWidth: 220, marginLeft: 'auto' }}><Picker items={['View: Line role (detail)', 'View: Management (summary)']} value="View: Line role (detail)" onChange={() => {}} size="sm" /></div>
      </div>
      <div className="ai-feed">{rows.map((i) => <InsightCard key={i.id} ins={i} notify={notify} lang={lang} />)}</div>
    </div>
  );
}

function AiQA() {
  const [msgs, setMsgs] = useState([{ who: 'bot', text: 'Ask a question about your data. Answers respect your access permissions and masking rules, and I’ll show the data I used.' }]);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  // Grounded Q&A (§20.5): the backend retrieves semantics, queries gold rows
  // through the masking gateway, and returns an answer citing those rows.
  const send = async (q) => {
    const text = q || val;
    if (!text.trim() || busy) return;
    setVal('');
    setMsgs((m) => [...m, { who: 'user', text }]);
    setBusy(true);
    try {
      const res = await aiAnalyze({ question: text });
      setMsgs((m) => [...m, { who: 'bot', text: res.answer, cite: `${res.source} · via ${res.model} · ${res.cited_rows.length} rows cited` }]);
    } catch (err) {
      setMsgs((m) => [...m, { who: 'bot', text: `I can’t answer that: ${err.detail || err.message}` }]);
    } finally { setBusy(false); }
  };
  return (
    <div className="ai-chat">
      <div className="ai-chat__body">
        {msgs.map((m, i) => (
          <div key={i} className={`ai-msg ${m.who}`}>
            <span className="ai-msg__av" style={{ background: m.who === 'user' ? 'var(--cds-gray-100, #161616)' : 'var(--cds-blue-60)' }}>{m.who === 'user' ? 'LM' : <Icon name="watson" size={16} />}</span>
            <div>
              <div className="ai-msg__bub">{m.text}</div>
              {m.chart && <div style={{ marginTop: 8, border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)', padding: 12 }}><div style={{ fontSize: '.6875rem', color: 'var(--cds-text-secondary)', marginBottom: 8 }}>Cpk by process · last 7 days</div><Bars data={[1.38, 0.74, 1.21, 1.45, 1.02]} height={90} /></div>}
              {m.cite && <div className="ai-cite"><Icon name="data--base" size={12} />Source: {m.cite}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="ai-suggest">{AI_QA_SUGGEST.map((s) => <button key={s} className="ai-sg" onClick={() => send(s)}>{s}</button>)}</div>
      <div className="ai-chat__foot">
        <TextInput id="ai-qa" labelText="" value={val} onChange={(e) => setVal(e.target.value)} placeholder="Ask about processes, yield, capability…" style={{ flex: 1 }} />
        <Button kind="primary" renderIcon={iconFor('send')} onClick={() => send()}>Ask</Button>
      </div>
    </div>
  );
}

function AiInsightsSection({ notify, lang }) {
  return (
    <Tabs>
      <TabList aria-label="AI Insights">
        <Tab>{tr(lang, 'Insights feed')}</Tab>
        <Tab>{tr(lang, 'Ask AI')}</Tab>
      </TabList>
      <TabPanels>
        <TabPanel><div style={{ marginTop: 16 }}><InsightsFeed notify={notify} lang={lang} /></div></TabPanel>
        <TabPanel><div style={{ marginTop: 16 }}><AiQA /></div></TabPanel>
      </TabPanels>
    </Tabs>
  );
}

/* ============================ ROOT ============================ */
const AI_SUBS = [
  { id: 'models', label: 'AI Models' },
  { id: 'semantic', label: 'AI Semantic' },
  { id: 'agents', label: 'Agent Studio' },
  { id: 'insights', label: 'AI Insights' },
];
const AI_TITLES = {
  models: ['AI Models', 'Register, test, and govern the LLM and embedding endpoints the platform may call.'],
  semantic: ['AI Semantic', 'Describe entities so AI agents and retrieval reason about your data accurately.'],
  agents: ['Agent Studio', 'Compose data, AI, and human steps into governed, auditable workflows.'],
  insights: ['AI Insights', 'AI-generated findings, grounded in real data, with recommended actions.'],
};

export default function Ai({ notify, lang }) {
  const [sub, setSub] = useState('models');
  const [openModel, setOpenModel] = useState(null); // AI Models detail — lifted so the header/sub-switch can hide
  const inModelDetail = sub === 'models' && openModel;
  const [t, s] = AI_TITLES[sub];
  return (
    <div className="w-page">
      {!inModelDetail && (
        <>
          <PageHeader crumb={[tr(lang, 'AI'), tr(lang, t)]} title={tr(lang, t)} sub={tr(lang, s)} />
          <SubSwitch items={trList(lang, AI_SUBS)} value={sub} onChange={(v) => { setSub(v); setOpenModel(null); }} />
        </>
      )}
      {sub === 'models' && <AiModels open={openModel} setOpen={setOpenModel} notify={notify} lang={lang} />}
      {sub === 'semantic' && <AiSemantic notify={notify} lang={lang} />}
      {sub === 'agents' && <AgentStudio notify={notify} lang={lang} />}
      {sub === 'insights' && <AiInsightsSection notify={notify} lang={lang} />}
    </div>
  );
}
