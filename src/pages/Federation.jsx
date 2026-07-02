import { useState } from 'react';
import {
  Button, Tag, TextInput, InlineNotification,
  Tabs, TabList, Tab, TabPanels, TabPanel,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
  ProgressIndicator, ProgressStep,
  OverflowMenu, OverflowMenuItem,
} from '@carbon/react';
import { ChoroplethChart, SimpleBarChart } from '@carbon/charts-react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot } from '../components/shared.jsx';
import { Picker } from '../components/inputs.jsx';
import { tr, trList } from '../i18n.js';
import {
  FED_PLANTS, FED_STATE_LABEL, FED_STATE_KIND, FED_CMD_TYPES,
  FED_COMMANDS, FED_CMD_KIND, FED_NEW_STEPS,
} from '../data/mockData.js';
import { CHORO_DATA, CHORO_OPTIONS } from '../data/choropleth.js';

/* Federation (§ multi-plant control plane): a control tower over every plant's
   autonomous lakehouse. Each plant runs independently — an offline plant never
   takes down the others; a dispatched command is an intent the plant may refuse. */

/* ============================ CONTROL TOWER ============================ */
function ControlTower({ onOpen, lang }) {
  const online = FED_PLANTS.filter((p) => p.state !== 'offline').length;
  const alerts = FED_PLANTS.filter((p) => p.state === 'alert').length;
  const kpis = [
    { k: 'Plants online', v: `${online} / ${FED_PLANTS.length}`, icon: 'checkmark--filled', color: 'var(--cds-support-success)' },
    { k: 'Total pipelines', v: '61', icon: 'data--base' },
    { k: 'Plants with alerts', v: String(alerts), icon: 'warning--filled', color: 'var(--cds-support-warning)' },
    { k: 'Avg sync latency', v: '270ms', icon: 'time' },
  ];
  // Cross-plant Cpk as a Carbon bar chart. Offline plants have no Cpk (drawn as 0/grey);
  // colour flags plants below the 1.33 capability target.
  const cpkData = FED_PLANTS.map((p) => ({ group: p.name, value: p.cpk == null ? 0 : p.cpk }));
  const cpkColorScale = Object.fromEntries(FED_PLANTS.map((p) => [p.name, p.cpk == null ? '#c6c6c6' : p.cpk < 1.33 ? '#f1c21b' : '#0f62fe']));
  const cpkOptions = {
    axes: {
      left: { mapsTo: 'value', title: 'Cpk', includeZero: true,
        thresholds: [{ value: 1.33, label: tr(lang, 'Capability target'), fillColor: '#24a148' }] },
      bottom: { mapsTo: 'group', scaleType: 'labels' },
    },
    color: { scale: cpkColorScale },
    legend: { enabled: false },
    height: '260px',
    toolbar: { enabled: false },
    theme: 'white',
    tooltip: { valueFormatter: (v) => (v === 0 ? tr(lang, 'offline') : Number(v).toFixed(2)) },
  };
  return (
    <div>
      <div className="w-stats" style={{ marginBottom: 24 }}>
        {kpis.map((s) => (
          <div className="s" key={s.k}>
            <div className="k"><Icon name={s.icon} size={16} style={s.color ? { color: s.color } : undefined} />{tr(lang, s.k)}</div>
            <div className="v">{s.v}</div>
          </div>
        ))}
      </div>

      <div className="fd-grid">
        {FED_PLANTS.map((p) => (
          <button key={p.id} className={`fd-plant ${p.state}`} onClick={() => onOpen(p)} style={{ textAlign: 'left', font: 'inherit', padding: 0 }}>
            <div className="fd-plant__h">
              <Icon name="data--base" size={20} style={{ color: 'var(--cds-icon-secondary)' }} />
              <div style={{ flex: 1 }}><div className="nm">{p.name}</div><div className="fd-plant__rg">{p.region}</div></div>
              <StatusDot kind={FED_STATE_KIND[p.state]}>{tr(lang, FED_STATE_LABEL[p.state])}</StatusDot>
            </div>
            <div className="fd-plant__b">
              <div className="fd-metric"><div className="k">{tr(lang, 'Version')}</div><div className="v">{p.version}</div></div>
              <div className="fd-metric"><div className="k">{tr(lang, 'Blueprint')}</div><div className="v">{p.blueprint}</div></div>
              <div className="fd-metric"><div className="k">{tr(lang, 'Pipelines')}</div><div className="v">{p.pipes}</div></div>
              <div className="fd-metric"><div className="k">{tr(lang, 'Freshness')}</div><div className="v">{p.fresh}</div></div>
            </div>
            <div className={`fd-plant__foot ${p.state === 'offline' ? 'warn' : ''}`}>
              <Icon name={p.state === 'offline' ? 'warning--filled' : 'time'} size={13} />
              {p.state === 'offline' ? `No report for ${p.report}` : `Last report ${p.report} · sync ${p.sync}`}
            </div>
          </button>
        ))}
      </div>

      <div className="fd-cmp" style={{ marginBottom: 16 }}>
        <div className="fd-cmp__h"><Icon name="map" size={16} />{tr(lang, 'Federated footprint')} · {tr(lang, 'Global')}</div>
        <div className="fd-map">
          <ChoroplethChart data={CHORO_DATA} options={CHORO_OPTIONS} />
        </div>
      </div>

      <div className="fd-cmp">
        <div className="fd-cmp__h"><Icon name="chart--bar" size={16} />Cross-plant comparison · Cpk (process P1)</div>
        <div style={{ padding: '10px 14px 4px' }}>
          <SimpleBarChart data={cpkData} options={cpkOptions} />
        </div>
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="information" size={14} />Each plant runs autonomously — an offline plant does not affect the others. Status is judged by last report time.
      </div>
    </div>
  );
}

/* ============================ DISPATCH COMMAND ============================ */
function DispatchModal({ plant, onClose, onDone, notify, lang }) {
  const [type, setType] = useState('pipeline');
  const dispatch = () => {
    onDone();
    notify && notify({ kind: 'success', title: tr(lang, 'Command queued'), subtitle: `${FED_CMD_TYPES.find((c) => c.id === type).nm} → ${plant ? plant.name : 'plant'}` });
  };
  return (
    <ComposedModal open size="sm" onClose={onClose}>
      <ModalHeader label={`Dispatch to ${plant ? plant.name : 'plant'}`} title={tr(lang, 'Dispatch command')} />
      <ModalBody hasForm>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!plant && <Picker label={tr(lang, 'Target plant')} items={FED_PLANTS.map((p) => p.name)} value="Plant A" onChange={() => {}} />}
          <div className="w-fld"><label className="cds--label">{tr(lang, 'Command type')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {FED_CMD_TYPES.map((c) => (
                <div key={c.id} className={`ds-authcard ${type === c.id ? 'sel' : ''}`} onClick={() => setType(c.id)}>
                  <div className="hd"><span className="ds-radio" /><span className="nm">{tr(lang, c.nm)}</span></div>
                  <div className="dc" style={{ paddingLeft: 26 }}>{c.dc}</div>
                </div>
              ))}
            </div>
          </div>
          {type === 'pipeline' && <Picker label="Pipeline" items={['spc_capability_daily', 'agg_yield_daily', 'qms_cdc']} value="spc_capability_daily" onChange={() => {}} />}
          {type === 'config' && <TextInput id="fd-cfg" labelText="Config key = value" defaultValue="sync.interval = 5m" />}
          {type === 'blueprint' && <Picker label="Blueprint version" items={['bp-2026.06', 'bp-2026.05']} value="bp-2026.06" onChange={() => {}} />}
          <InlineNotification kind="info" lowContrast hideCloseButton title="A command is an intent, not a guarantee"
            subtitle="The plant control plane executes it and retains the right to refuse. Track status in the plant’s command queue." />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>{tr(lang, 'Cancel')}</Button>
        <Button kind="primary" renderIcon={iconFor('send')} onClick={dispatch}>{tr(lang, 'Dispatch command')}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

/* ============================ CREATE LAKEHOUSE WIZARD ============================ */
function NewLakehouse({ onClose, onDone, notify, lang }) {
  const [step, setStep] = useState(0);
  const last = step === FED_NEW_STEPS.length - 1;
  return (
    <ComposedModal open size="lg" onClose={onClose}>
      <ModalHeader label={tr(lang, 'Federation')} title={tr(lang, 'Create new lakehouse')} />
      <ModalBody hasForm>
        <ProgressIndicator currentIndex={step} spaceEqually style={{ marginBottom: 28 }}>
          {FED_NEW_STEPS.map(([t, s], i) => <ProgressStep key={t} label={tr(lang, t)} secondaryLabel={s} onClick={() => setStep(i)} />)}
        </ProgressIndicator>
        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="w-row"><TextInput id="lh-id" labelText="Plant ID" placeholder="plant-e" /><TextInput id="lh-nm" labelText="Display name" placeholder="Plant E" /></div>
            <div className="w-row"><TextInput id="lh-rg" labelText={tr(lang, 'Region')} placeholder="Guadalajara, MX" /><TextInput id="lh-net" labelText="Network segment (CIDR)" placeholder="10.40.0.0/16" /></div>
            <TextInput id="lh-ns" labelText="Namespace prefix" defaultValue="plant_e" />
          </div>
        )}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <TextInput id="lh-src" labelText="Source database connection" placeholder="postgres://mes.plant-e.local:5432/qms" />
            <TextInput id="lh-stream" labelText="Streaming source (optional)" placeholder="kafka://broker.plant-e:9092" />
            <InlineNotification kind="info" lowContrast hideCloseButton title="Connections are validated from the plant side"
              subtitle="The plant control plane confirms reachability before the blueprint deploys." />
          </div>
        )}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <InlineNotification kind="success" lowContrast hideCloseButton title="Blueprint generated"
              subtitle="bp-2026.06 tailored to plant-e — 5 layers, 14 pipelines, namespace plant_e.*" />
            <dl className="w-dl">
              <dt>Layers</dt><dd>RAW → Bronze → Silver → Gold → ClickHouse</dd>
              <dt>Pipelines</dt><dd>14 generated from blueprint</dd>
              <dt>{tr(lang, 'Blueprint')}</dt><dd>bp-2026.06</dd>
            </dl>
          </div>
        )}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>Run the deploy agent at the plant with the generated token, then it registers back to the control tower.</div>
            <div className="ds-code">{`helm install insight-lakehouse \\\n  --set plantId=plant-e \\\n  --set token=lh_deploy_••••a91f \\\n  --set blueprint=bp-2026.06`}</div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>{step === 0 ? tr(lang, 'Cancel') : tr(lang, 'Back')}</Button>
        <Button kind="primary" renderIcon={iconFor(last ? 'checkmark' : 'arrow--right')}
          onClick={last ? () => { onDone(); notify && notify({ kind: 'success', title: 'Lakehouse provisioning', subtitle: 'plant-e — awaiting first report from the deploy agent.' }); } : () => setStep((s) => s + 1)}>
          {last ? tr(lang, 'Done') : tr(lang, 'Next')}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

/* ============================ LAKEHOUSE DETAIL ============================ */
function LakehouseDetail({ plant, onBack, onDispatch, notify, lang }) {
  const pipeRows = plant.state === 'offline'
    ? [{ name: 'spc_capability_daily', status: 'unknown', fresh: '—', last: '12 min ago' }]
    : [
      { name: 'spc_capability_daily', status: 'success', fresh: plant.fresh, last: '14s ago' },
      { name: 'agg_yield_daily', status: 'success', fresh: '6 min', last: '5 min ago' },
      { name: 'qms_cdc', status: plant.state === 'alert' ? 'retrying' : 'running', fresh: '1 min', last: 'now' },
    ];
  return (
    <div>
      <Button kind="ghost" size="sm" onClick={onBack} style={{ marginBottom: 12, justifyContent: 'flex-start', paddingInlineStart: 12 }}><Icon name="arrow--left" size={16} style={{ marginRight: 8 }} />{tr(lang, 'Back to lakehouses')}</Button>
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 400, margin: 0 }}>{plant.name}</h1>
          <span className="ip-mono" style={{ color: 'var(--cds-text-secondary)' }}>{plant.region}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 1 }}>
            <Button kind="ghost" size="md" renderIcon={iconFor('search')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Federated query'), subtitle: `Connecting to ${plant.name} via federated Trino…` })}>{tr(lang, 'Federated drill-down')}</Button>
            <Button kind="primary" size="md" renderIcon={iconFor('send')} onClick={onDispatch}>{tr(lang, 'Dispatch command')}</Button>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <StatusDot kind={FED_STATE_KIND[plant.state]}>{tr(lang, FED_STATE_LABEL[plant.state])}</StatusDot>
        </div>
      </div>
      <Tabs>
        <TabList aria-label="Lakehouse detail">
          <Tab>{tr(lang, 'Overview')}</Tab><Tab>{tr(lang, 'Pipelines')}</Tab><Tab>{tr(lang, 'New command')}</Tab>
          <Tab>{tr(lang, 'Federated query')}</Tab><Tab>{tr(lang, 'Lineage')}</Tab><Tab>{tr(lang, 'Blueprint')}</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {plant.state === 'offline' && <InlineNotification kind="error" lowContrast hideCloseButton title={`Offline — no report for ${plant.report}`} subtitle="Other plants are unaffected. Showing the last known state." />}
              <dl className="w-dl">
                <dt>{tr(lang, 'Plant ID')}</dt><dd className="ip-mono">{plant.id}</dd>
                <dt>{tr(lang, 'Region')}</dt><dd>{plant.region}</dd>
                <dt>Platform version</dt><dd>{plant.version}</dd>
                <dt>{tr(lang, 'Blueprint')}</dt><dd>{plant.blueprint}</dd>
                <dt>{tr(lang, 'Pipelines')}</dt><dd>{plant.pipes}</dd>
                <dt>Last report</dt><dd>{plant.report}</dd>
              </dl>
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <CarbonTable
                withToolbar={false}
                headers={[{ key: 'name', header: tr(lang, 'Pipeline'), mono: true }, { key: 'status', header: tr(lang, 'Status') }, { key: 'fresh', header: tr(lang, 'Freshness') }, { key: 'last', header: tr(lang, 'Last run') }]}
                rows={pipeRows}
                renderCell={(r, k) => k === 'status'
                  ? <StatusDot kind={r.status === 'unknown' ? 'gray' : r.status}>{tr(lang, r.status)}</StatusDot>
                  : r[k]} />
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <CarbonTable
                headers={[
                  { key: 'ty', header: tr(lang, 'Command') },
                  { key: 'st', header: tr(lang, 'Status') },
                  { key: 'when', header: tr(lang, 'When') },
                ]}
                rows={FED_COMMANDS.map((c, i) => ({ id: i, ...c }))}
                searchPlaceholder={tr(lang, 'Search commands')}
                actions={<Button kind="primary" size="lg" renderIcon={iconFor('send')} onClick={onDispatch}>{tr(lang, 'New command')}</Button>}
                renderCell={(r, k) => k === 'st'
                  ? <StatusDot kind={FED_CMD_KIND[r.st]}>{r.st}</StatusDot>
                  : r[k]} />
              <div style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="information" size={14} />A refused command is the plant exercising its veto — the control plane stays authoritative locally.</div>
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)', marginBottom: 10 }}>Real-time drill-down into this plant via federated Trino. Subject to your access permissions.</div>
              <div className="ds-code">{`SELECT process_id, cpk\nFROM federated.${plant.id}.gold.spc_capability_daily\nWHERE cal_date = current_date`}</div>
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <div className="w-ph" style={{ height: 220 }}><span className="lbl"><Icon name="share" size={14} />RAW → Bronze → Silver → Gold lineage · {plant.name}</span></div>
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <dl className="w-dl"><dt>Current blueprint</dt><dd>{plant.blueprint}</dd><dt>Latest available</dt><dd>bp-2026.06</dd></dl>
              {plant.blueprint !== 'bp-2026.06' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Blueprint is one version behind" subtitle="bp-2026.06 is available. The plant may auto-apply or require local approval." />}
              <div><Button kind="tertiary" size="md" renderIcon={iconFor('launch')} onClick={() => notify && notify({ kind: 'success', title: 'Blueprint push queued', subtitle: `${plant.name} ← bp-2026.06 (plant chooses auto-apply or local approval).` })}>{tr(lang, 'Push new blueprint version')}</Button></div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

/* ============================ LAKEHOUSES LIST ============================ */
function LakehousesList({ onOpen, onNew, onDispatch, notify, lang }) {
  const headers = [
    { key: 'id', header: tr(lang, 'Plant ID'), mono: true },
    { key: 'name', header: tr(lang, 'Name') },
    { key: 'region', header: tr(lang, 'Region') },
    { key: 'version', header: tr(lang, 'Version'), mono: true },
    { key: 'blueprint', header: tr(lang, 'Blueprint'), mono: true },
    { key: 'report', header: tr(lang, 'Last run') },
    { key: 'state', header: tr(lang, 'Health') },
    { key: 'ofw', header: '' },
  ];
  return (
    <CarbonTable
      headers={headers}
      rows={FED_PLANTS}
      withPagination
      searchPlaceholder={tr(lang, 'Search lakehouses')}
      onRowClick={onOpen}
      actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={onNew}>{tr(lang, 'Create new lakehouse')}</Button>}
      renderCell={(r, k) => {
        if (k === 'name') return <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r); }}>{r.name}</a>;
        if (k === 'state') return <StatusDot kind={FED_STATE_KIND[r.state]}>{tr(lang, FED_STATE_LABEL[r.state])}</StatusDot>;
        if (k === 'ofw') return (
          <OverflowMenu size="sm" flipped aria-label="Row actions" onClick={(e) => e.stopPropagation()}>
            <OverflowMenuItem itemText={tr(lang, 'View')} onClick={() => onOpen(r)} />
            <OverflowMenuItem itemText={tr(lang, 'Dispatch command')} onClick={() => onDispatch(r)} />
            <OverflowMenuItem itemText={tr(lang, 'Federated drill-down')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Federated query'), subtitle: `Connecting to ${r.name}…` })} />
          </OverflowMenu>
        );
        return r[k];
      }}
    />
  );
}

/* ============================ ROOT ============================ */
const FED_SUBS = [{ id: 'tower', label: 'Control Tower' }, { id: 'lakehouses', label: 'Lakehouses' }];
const TITLES = {
  tower: ['Control Tower', 'Fleet-wide view of every plant lakehouse — status, health, and cross-plant metrics.'],
  lakehouses: ['Lakehouses', 'Each plant’s lakehouse, its commands, and federated drill-down.'],
};

export default function Federation({ notify, lang }) {
  const [sub, setSub] = useState('tower');
  const [plant, setPlant] = useState(null);
  const [dispatch, setDispatch] = useState(null); // null | plant
  const [newLh, setNewLh] = useState(false);

  if (sub === 'lakehouses' && plant) {
    return (
      <div className="w-page">
        <div className="w-crumb">
          <a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'Federation')}</a><span className="sep">/</span>
          <a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'Lakehouses')}</a><span className="sep">/</span><span>{plant.name}</span>
        </div>
        <LakehouseDetail plant={plant} onBack={() => setPlant(null)} onDispatch={() => setDispatch(plant)} notify={notify} lang={lang} />
        {dispatch && <DispatchModal plant={dispatch} onClose={() => setDispatch(null)} onDone={() => setDispatch(null)} notify={notify} lang={lang} />}
      </div>
    );
  }

  const [t, s] = TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Federation'), tr(lang, t)]} title={tr(lang, t)} sub={tr(lang, s)} />
      <SubSwitch items={trList(lang, FED_SUBS)} value={sub} onChange={(v) => { setSub(v); setPlant(null); }} />
      {sub === 'tower' && <ControlTower onOpen={(p) => { setSub('lakehouses'); setPlant(p); }} lang={lang} />}
      {sub === 'lakehouses' && <LakehousesList onOpen={setPlant} onNew={() => setNewLh(true)} onDispatch={(p) => setDispatch(p)} notify={notify} lang={lang} />}
      {dispatch && <DispatchModal plant={dispatch} onClose={() => setDispatch(null)} onDone={() => setDispatch(null)} notify={notify} lang={lang} />}
      {newLh && <NewLakehouse onClose={() => setNewLh(false)} onDone={() => setNewLh(false)} notify={notify} lang={lang} />}
    </div>
  );
}
