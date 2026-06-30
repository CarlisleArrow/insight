import { useState, useEffect } from 'react';
import {
  Button, Tag, Search, Checkbox,
  Tabs, TabList, Tab, TabPanels, TabPanel,
} from '@carbon/react';
import { CardNode, CardNodeColumn, CardNodeTitle, CardNodeSubtitle } from '@carbon/charts-react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot, SidePanel, ToolBtn, RowMenu } from '../components/shared.jsx';
import { FormModal, ConfirmDelete } from '../components/modals.jsx';
import NetworkDiagram from '../components/NetworkDiagram.jsx';
import { BarChart } from '../components/Charts.jsx';
import { useCollection } from '../data/DataProvider.jsx';
import * as api from '../data/api.js';
import { SCHEMAS } from '../data/formSchemas.js';
import {
  ACCESS_MASKING, LAYER_TAG, SENS_TAG,
} from '../data/mockData.js';
import { tr, trList } from '../i18n.js';
import SchemaChanges from './SchemaChanges.jsx';

// countBy turns the loaded assets into facet options [{l, n}] for a field,
// ordered by descending count. Facets are derived from the same rows the table
// filters on, so counts stay consistent and clicking a value actually filters.
function countBy(items, field) {
  const m = new Map();
  for (const it of items) {
    const v = it[field];
    if (v == null || v === '') continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => ({ l, n }));
}

// shortLabel renders a readable name from a DataHub urn (last dotted segment).
function shortLabel(urn) {
  if (!urn) return '';
  const inner = urn.includes(',') ? urn.split(',')[1] : urn;
  const parts = inner.split('.');
  return parts[parts.length - 1];
}

// lineageToGraph maps GET /api/catalog/lineage ({nodes:[{urn,label}], edges})
// into NetworkDiagram props (elkjs lays it out — no coordinates needed).
function lineageToGraph(lin) {
  const nodes = (lin?.nodes || []).map((n) => ({ id: n.urn, label: n.label || shortLabel(n.urn), urn: n.urn }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = (lin?.edges || [])
    .filter(([s, t]) => ids.has(s) && ids.has(t))
    .map(([source, target], i) => ({ id: `le${i}`, source, target }));
  return { nodes, links };
}

function LineageNode({ node, selected }) {
  return (
    <div className={`nd-wrap ${selected ? 'sel' : ''}`}>
      <CardNode color="#0f62fe">
        <CardNodeColumn><Icon name="data--base" size={20} /></CardNodeColumn>
        <CardNodeColumn><CardNodeTitle>{node.label}</CardNodeTitle><CardNodeSubtitle>dataset</CardNodeSubtitle></CardNodeColumn>
      </CardNode>
    </div>
  );
}

function ScoreBar({ v }) {
  const color = v >= 90 ? 'var(--cds-support-success)' : v >= 75 ? 'var(--cds-support-warning)' : 'var(--cds-support-error)';
  return <span className="gv-score"><span className="track"><i style={{ width: v + '%', background: color }} /></span>{v}</span>;
}

function Facet({ title, opts, selected, onToggle }) {
  const controlled = !!onToggle;
  return (
    <div className="gv-facets__grp">
      <h4>{title}</h4>
      {opts.map((o, i) => (
        <label key={o.l} className="gv-facets__opt">
          <Checkbox
            id={`facet-${title}-${i}`}
            labelText=""
            checked={controlled ? selected.has(o.l) : undefined}
            defaultChecked={controlled ? undefined : o.on}
            onChange={controlled ? () => onToggle(o.l) : undefined}
          />
          {o.l}<span style={{ marginLeft: 'auto', color: 'var(--cds-text-placeholder)', fontSize: '.6875rem' }}>{o.n}</span>
        </label>
      ))}
    </div>
  );
}

/* ---------------- Catalog ---------------- */
function Catalog({ onOpen, lang }) {
  const { items } = useCollection('assets');
  const [q, setQ] = useState('');
  const [layers, setLayers] = useState(() => new Set());
  const [sens, setSens] = useState(() => new Set());
  const toggle = (set, setter) => (v) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); setter(n); };
  const headers = [
    { key: 'name', header: tr(lang, 'Asset') }, { key: 'layer', header: tr(lang, 'Layer') }, { key: 'desc', header: tr(lang, 'Description') },
    { key: 'owner', header: tr(lang, 'Owner') }, { key: 'score', header: tr(lang, 'Quality') }, { key: 'sens', header: tr(lang, 'Sensitivity') },
  ];
  const rows = items.filter((a) => (
    (a.name.toLowerCase().includes(q.toLowerCase()) || (a.desc || '').toLowerCase().includes(q.toLowerCase()))
    && (layers.size === 0 || layers.has(a.layer))
    && (sens.size === 0 || sens.has(a.sens))
  ));
  // Facets derived from the loaded catalog assets — the same fields the table
  // filters on (consistent counts; clicking a value actually filters).
  const layerOpts = countBy(items, 'layer');
  const sensOpts = countBy(items, 'sens');
  const ownerOpts = countBy(items, 'owner');
  return (
    <div className="gv-catalog">
      <aside className="gv-facets">
        <Facet title={tr(lang, 'Source layer')} opts={layerOpts} selected={layers} onToggle={toggle(layers, setLayers)} />
        <Facet title={tr(lang, 'Sensitivity')} opts={sensOpts} selected={sens} onToggle={toggle(sens, setSens)} />
        {ownerOpts.length > 0 && <Facet title={tr(lang, 'Owner')} opts={ownerOpts} />}
      </aside>
      <div>
        <div style={{ marginBottom: 16 }}>
          <Search size="lg" labelText={tr(lang, 'Search catalog')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr(lang, 'Search the catalog — tables, fields, descriptions')} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {[...layers].map((l) => <Tag key={l} type="blue" size="sm" onClick={toggle(layers, setLayers)} title={tr(lang, 'Remove filter')} style={{ cursor: 'pointer' }}>{tr(lang, 'layer')}: {l} ✕</Tag>)}
          {[...sens].map((sv) => <Tag key={sv} type="purple" size="sm" onClick={toggle(sens, setSens)} title={tr(lang, 'Remove filter')} style={{ cursor: 'pointer' }}>{tr(lang, 'sensitivity')}: {sv} ✕</Tag>)}
          <span style={{ marginLeft: 'auto', fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{rows.length} {tr(lang, 'of')} {items.length} {tr(lang, 'assets')}</span>
        </div>
        <CarbonTable
          headers={headers}
          rows={rows}
          withToolbar={false}
          withPagination
          onRowClick={onOpen}
          renderCell={(r, k) => {
            if (k === 'name') return <a href="#" onClick={(e) => e.preventDefault()}>{r.name}</a>;
            if (k === 'layer') return <Tag type={LAYER_TAG[r.layer]} size="sm"><span className="gv-layerchip">{r.layer}</span></Tag>;
            if (k === 'desc') return <span style={{ display: 'block', maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.desc}</span>;
            if (k === 'score') return r.score > 0 ? <ScoreBar v={r.score} /> : <span style={{ color: 'var(--cds-text-secondary)' }}>—</span>;
            if (k === 'sens') return <Tag type={SENS_TAG[r.sens]} size="sm">{r.sens}</Tag>;
            return r[k];
          }}
        />
      </div>
    </div>
  );
}

/* ---------------- Asset detail ---------------- */
function AssetDetail({ asset, onBack, notify, lang }) {
  // Schema (DataHub) + live sample (Trino) + usage (audit) + downstream (lineage).
  const [detail, setDetail] = useState({ schema: { columns: [] }, sample: { columns: [], rows: [] }, usage: [], downstream: 0, quality: 0 });
  // Field/table lineage from DataHub (GET /api/catalog/lineage?urn=).
  const [graph, setGraph] = useState({ nodes: [], links: [] });
  useEffect(() => {
    let alive = true;
    if (asset.urn) {
      api.getAsset(asset.urn)
        .then((d) => { if (alive) setDetail({ schema: d.schema || { columns: [] }, sample: d.sample || { columns: [], rows: [] }, usage: d.usage || [], downstream: d.downstream || 0, quality: d.quality || 0 }); })
        .catch((err) => console.error('asset detail failed', err));
      api.getCatalogLineage(asset.urn)
        .then((lin) => { if (alive) setGraph(lineageToGraph(lin)); })
        .catch((err) => console.error('asset lineage failed', err));
    }
    return () => { alive = false; };
  }, [asset.urn]);

  const totalQueries = (detail.usage || []).reduce((s, p) => s + (p.value || 0), 0);
  const schemaRows = (detail.schema.columns || []).map((c, i) => ({ id: String(i), col: c.col, type: c.type, desc: c.desc || '', sens: asset.sens }));
  const sampleHeaders = (detail.sample.columns || []).map((c) => ({ key: c.key, header: c.header, mono: true }));
  const sampleRows = (detail.sample.rows || []).map((r, i) => ({ id: String(i), ...r }));
  const schemaHeaders = [
    { key: 'col', header: tr(lang, 'Column'), mono: true }, { key: 'type', header: tr(lang, 'Type') }, { key: 'desc', header: tr(lang, 'Description') }, { key: 'sens', header: tr(lang, 'Sensitivity') },
  ];
  return (
    <div>
      <Button kind="ghost" size="sm" renderIcon={iconFor('arrow--left')} onClick={onBack} style={{ marginBottom: 12 }}>{tr(lang, 'Back to catalog')}</Button>
      <div className="gv-detail__top">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1 className="ip-mono" style={{ fontSize: '1.75rem', fontWeight: 400, margin: 0 }}>{asset.name}</h1>
            <Tag type={LAYER_TAG[asset.layer]} size="md">{asset.layer}</Tag>
            <Tag type={SENS_TAG[asset.sens]} size="md">{asset.sens}</Tag>
          </div>
          <p style={{ color: 'var(--cds-text-secondary)', fontSize: '.875rem', margin: '8px 0 0' }}>{asset.desc} · {tr(lang, 'Owner')} {asset.owner}</p>
        </div>
        <div className="gv-detail__stats">
          <div className="s"><div className="v">{detail.quality > 0 ? detail.quality : '—'}</div><div className="k">{tr(lang, 'Quality (completeness)')}</div></div>
          <div className="s"><div className="v">{detail.downstream}</div><div className="k">{tr(lang, 'Downstream')}</div></div>
          <div className="s"><div className="v">{totalQueries}</div><div className="k">{tr(lang, 'Queries (audited)')}</div></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 1, marginBottom: 16 }}>
        <Button kind="tertiary" size="sm" renderIcon={iconFor('locked')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Access request submitted.') })}>{tr(lang, 'Request access')}</Button>
        <Button kind="tertiary" size="sm" renderIcon={iconFor('edit')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Edit metadata (mock).') })}>{tr(lang, 'Edit metadata')}</Button>
        <Button kind="tertiary" size="sm" renderIcon={iconFor('launch')} onClick={() => notify && notify({ kind: 'info', title: tr(lang, 'Opening in BI…') })}>{tr(lang, 'Open in BI')}</Button>
      </div>
      <Tabs>
        <TabList aria-label="Asset detail"><Tab>{tr(lang, 'Schema')}</Tab><Tab>{tr(lang, 'Sample data')}</Tab><Tab>{tr(lang, 'Lineage')}</Tab><Tab>{tr(lang, 'Usage')}</Tab></TabList>
        <TabPanels>
          <TabPanel>
            <div style={{ marginTop: 8 }}><CarbonTable headers={schemaHeaders} rows={schemaRows} withToolbar={false} renderCell={(r, k) => k === 'sens' ? <Tag type="blue" size="sm">{r.sens}</Tag> : r[k]} /></div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}><CarbonTable headers={sampleHeaders} rows={sampleRows} withToolbar={false} renderCell={(r, k) => <span className="ip-mono" style={{ fontSize: '.8125rem' }}>{r[k]}</span>} /></div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8, border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)' }}>
              {graph.nodes.length > 0 ? (
                <NetworkDiagram nodes={graph.nodes} links={graph.links} nodeSize={() => ({ width: 188, height: 60 })} height={300} edgeColor="#0f62fe" renderNode={(node, { selected }) => <LineageNode node={node} selected={selected} />} />
              ) : (
                <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>{tr(lang, 'No lineage recorded for this asset in DataHub.')}</div>
              )}
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8, border: '1px solid var(--wire-border)', background: 'var(--cds-layer-02)', padding: 16 }}>
              <div style={{ fontSize: '.8125rem', fontWeight: 600, marginBottom: 8, color: 'var(--cds-text-primary)' }}>{tr(lang, 'Queries over time')} <span style={{ color: 'var(--cds-text-secondary)', fontWeight: 400 }}>· {tr(lang, 'from query audit')}</span></div>
              {detail.usage.length > 0 ? (
                <BarChart data={detail.usage} group="Queries" height={240} />
              ) : (
                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>{tr(lang, 'No audited queries reference this table yet.')}</div>
              )}
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

/* ---------------- Lineage graph (DataHub, GET /api/catalog/lineage) ---------------- */
function LineageGraph({ notify, lang }) {
  const { items: assets } = useCollection('assets');
  const [rootUrn, setRootUrn] = useState('');
  const [graph, setGraph] = useState({ nodes: [], links: [] });
  const [sel, setSel] = useState(null);
  const [drawer, setDrawer] = useState(false);

  // Default the root to the first catalog asset once assets hydrate.
  useEffect(() => {
    if (!rootUrn && assets.length > 0 && assets[0].urn) setRootUrn(assets[0].urn);
  }, [assets, rootUrn]);

  useEffect(() => {
    if (!rootUrn) return undefined;
    let alive = true;
    api.getCatalogLineage(rootUrn)
      .then((lin) => { if (alive) setGraph(lineageToGraph(lin)); })
      .catch((err) => console.error('lineage failed', err));
    return () => { alive = false; };
  }, [rootUrn]);

  const sn = graph.nodes.find((n) => n.id === sel);
  const assetByUrn = Object.fromEntries(assets.filter((a) => a.urn).map((a) => [a.urn, a]));
  return (
    <div className="gv-lin">
      <div className="w-etoolbar">
        <Search size="sm" labelText={tr(lang, 'Root asset')} placeholder={tr(lang, 'Filter assets…')} style={{ maxWidth: 220 }}
          onChange={(e) => {
            const q = e.target.value.toLowerCase();
            const hit = assets.find((a) => a.urn && a.name.toLowerCase().includes(q));
            if (hit) setRootUrn(hit.urn);
          }} />
        <span className="gap" />
        <span style={{ fontSize: '.75rem', color: 'var(--cds-text-secondary)' }}>{graph.nodes.length} {tr(lang, 'nodes')} · {tr(lang, 'root')}: {shortLabel(rootUrn) || '—'}</span>
        <span className="spacer" />
        <ToolBtn icon="zoom--out" label="" title={tr(lang, 'Zoom out')} />
        <ToolBtn icon="zoom--in" label="" title={tr(lang, 'Zoom in')} />
        <ToolBtn icon="maximize" label="" title={tr(lang, 'Fit')} />
      </div>
      <div className="gv-lincanvas" style={{ background: 'var(--cds-layer-02)' }}>
        {graph.nodes.length > 0 ? (
          <NetworkDiagram nodes={graph.nodes} links={graph.links} nodeSize={() => ({ width: 188, height: 64 })} selected={sel} onSelect={(n) => { setSel(n.id); setDrawer(true); }} height={520} edgeColor="#0f62fe" renderNode={(node, { selected }) => <LineageNode node={node} selected={selected} />} />
        ) : (
          <div style={{ height: 520, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>
            {rootUrn ? tr(lang, 'No lineage recorded in DataHub for this asset.') : tr(lang, 'No catalog assets available.')}
          </div>
        )}
      </div>
      {drawer && sn && (
        <SidePanel sup={tr(lang, 'Lineage')} title={sn.label} width={360} onClose={() => setDrawer(false)}
          footer={<><Button kind="secondary" onClick={() => setDrawer(false)}>{tr(lang, 'Close')}</Button><Button kind="primary" renderIcon={iconFor('renew')} onClick={() => { setRootUrn(sn.urn); setDrawer(false); }}>{tr(lang, 'Re-root here')}</Button></>}>
          <StatusDot kind="success">{assetByUrn[sn.urn]?.layer || tr(lang, 'Dataset')}</StatusDot>
          <div className="w-fld"><label>URN</label><div className="ip-mono" style={{ fontSize: '.6875rem', wordBreak: 'break-all', color: 'var(--cds-text-primary)' }}>{sn.urn}</div></div>
          {assetByUrn[sn.urn] && <div className="w-fld"><label>{tr(lang, 'Description')}</label><div style={{ fontSize: '.8125rem', color: 'var(--cds-text-primary)' }}>{assetByUrn[sn.urn].desc || '—'}</div></div>}
        </SidePanel>
      )}
    </div>
  );
}

/* ---------------- Access control ---------------- */
function AccessControl({ notify, lang }) {
  const users = useCollection('accessUsers');
  const roles = useCollection('accessRoles');
  const [userModal, setUserModal] = useState(null);
  const [roleModal, setRoleModal] = useState(null);
  const [rolesAssign, setRolesAssign] = useState(null); // { user, current: [names] }
  const [del, setDel] = useState(null); // { kind, row }

  // Open the role-assignment modal for a user, pre-loading their current roles.
  const openRolesAssign = (user) => {
    api.getUserRoles(user.username || user.id)
      .then((d) => setRolesAssign({ user, current: d.roles || [] }))
      .catch(() => setRolesAssign({ user, current: [] }));
  };
  const userHeaders = [
    { key: 'name', header: tr(lang, 'User') }, { key: 'email', header: tr(lang, 'Email'), mono: true }, { key: 'role', header: tr(lang, 'Role') }, { key: 'status', header: tr(lang, 'Status') }, { key: 'ofw', header: '' },
  ];
  const roleHeaders = [
    { key: 'role', header: tr(lang, 'Role') }, { key: 'members', header: tr(lang, 'Members') }, { key: 'scope', header: tr(lang, 'Scope') }, { key: 'model', header: tr(lang, 'Model') }, { key: 'ofw', header: '' },
  ];
  const remove = () => { (del.kind === 'user' ? users : roles).remove(del.row.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Removed.') }); };
  return (
    <div>
      <div style={{ marginBottom: 16 }}><span className="gv-iam"><Icon name="locked" size={16} />{tr(lang, 'Linked to corporate IAM · SCIM sync enabled')}</span></div>
      <Tabs>
        <TabList aria-label="Access control"><Tab>{tr(lang, 'Users')}</Tab><Tab>{tr(lang, 'Roles')}</Tab><Tab>{tr(lang, 'Policies')}</Tab></TabList>
        <TabPanels>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <CarbonTable headers={userHeaders} rows={users.items} searchPlaceholder={tr(lang, 'Search users')}
                actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setUserModal({ mode: 'create' })}>{tr(lang, 'Invite user')}</Button>}
                renderCell={(r, k) => {
                  if (k === 'role') return <Tag type="cool-gray" size="sm">{tr(lang, r.role)}</Tag>;
                  if (k === 'status') return <StatusDot kind={r.status === 'Active' ? 'active' : 'gray'}>{tr(lang, r.status)}</StatusDot>;
                  if (k === 'ofw') return <RowMenu onEdit={() => setUserModal({ mode: 'edit', row: r })} onRoles={() => openRolesAssign(r)} onDelete={() => setDel({ kind: 'user', row: r })} />;
                  return r[k];
                }} />
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <CarbonTable headers={roleHeaders} rows={roles.items} searchPlaceholder={tr(lang, 'Search roles')}
                actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setRoleModal({ mode: 'create' })}>{tr(lang, 'Create role')}</Button>}
                renderCell={(r, k) => {
                  if (k === 'role') return tr(lang, r.role);
                  if (k === 'model') return <Tag type="purple" size="sm">{tr(lang, r.model)}</Tag>;
                  if (k === 'ofw') return <RowMenu onEdit={() => setRoleModal({ mode: 'edit', row: r })} onDelete={() => setDel({ kind: 'role', row: r })} />;
                  return r[k];
                }} />
            </div>
          </TabPanel>
          <TabPanel>
            <div style={{ marginTop: 8 }}>
              <h3 style={{ fontSize: '.875rem', margin: '0 0 12px', color: 'var(--cds-text-primary)' }}>{tr(lang, 'Row & column-level permissions — orders')}</h3>
              <table className="gv-matrix">
                <thead><tr><th>{tr(lang, 'Role')}</th><th>{tr(lang, 'Select')}</th><th>customer_id ({tr(lang, 'col')})</th><th>{tr(lang, 'Row filter')}</th><th>{tr(lang, 'Masking')}</th></tr></thead>
                <tbody>
                  <tr><td className="col">{tr(lang, 'Data Engineer')}</td><td><Icon name="checkmark" size={16} /></td><td><Icon name="checkmark" size={16} /></td><td>—</td><td>{tr(lang, 'None')}</td></tr>
                  <tr><td className="col">{tr(lang, 'Analyst')}</td><td><Icon name="checkmark" size={16} /></td><td><Icon name="view--off" size={16} /></td><td>region = user.region</td><td>{tr(lang, 'Hash')}</td></tr>
                  <tr><td className="col">{tr(lang, 'Viewer')}</td><td><Icon name="close" size={16} /></td><td><Icon name="close" size={16} /></td><td>{tr(lang, 'aggregated only')}</td><td>{tr(lang, 'Full')}</td></tr>
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 24, marginTop: 24, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h3 style={{ fontSize: '.875rem', margin: '0 0 12px', color: 'var(--cds-text-primary)' }}>{tr(lang, 'Data masking')}</h3>
                  <div className="dv-kv">{ACCESS_MASKING.map((m) => <div key={m.field} className="dv-kv__r"><span className="k">{m.field}</span><span className="v">{m.rule}</span></div>)}</div>
                </div>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <h3 style={{ fontSize: '.875rem', margin: '0 0 12px', color: 'var(--cds-text-primary)' }}>{tr(lang, 'Sensitivity & compliance tags')}</h3>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><Tag type="red" size="md">PII</Tag><Tag type="purple" size="md">GDPR</Tag><Tag type="purple" size="md">SOX</Tag><Tag type="blue" size="md">{tr(lang, 'Internal')}</Tag><Tag type="outline" size="md" renderIcon={iconFor('add')}>{tr(lang, 'Add tag')}</Tag></div>
                </div>
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      {userModal && (
        <FormModal open label={tr(lang, 'Access control')} title={userModal.mode === 'create' ? tr(lang, 'Invite user') : tr(lang, 'Edit user')} submitText={userModal.mode === 'create' ? tr(lang, 'Invite') : tr(lang, 'Save')} schema={SCHEMAS.accessUser} initial={userModal.row}
          onSubmit={(v) => { if (userModal.mode === 'create') users.add(v); else users.update(userModal.row.id, v); setUserModal(null); notify && notify({ kind: 'success', title: userModal.mode === 'create' ? tr(lang, 'Invitation sent.') : tr(lang, 'User updated.') }); }}
          onClose={() => setUserModal(null)} />
      )}
      {roleModal && (
        <FormModal open label={tr(lang, 'Access control')} title={roleModal.mode === 'create' ? tr(lang, 'Create role') : tr(lang, 'Edit role')} submitText={roleModal.mode === 'create' ? tr(lang, 'Create') : tr(lang, 'Save')} schema={SCHEMAS.accessRole} initial={roleModal.row}
          onSubmit={(v) => { if (roleModal.mode === 'create') roles.add(v); else roles.update(roleModal.row.id, v); setRoleModal(null); notify && notify({ kind: 'success', title: roleModal.mode === 'create' ? tr(lang, 'Role created.') : tr(lang, 'Role updated.') }); }}
          onClose={() => setRoleModal(null)} />
      )}
      {rolesAssign && (
        <FormModal open label={tr(lang, 'Access control')}
          title={`${tr(lang, 'Manage roles')} — ${rolesAssign.user.name || rolesAssign.user.username}`}
          submitText={tr(lang, 'Save')}
          schema={[{ key: 'roles', label: tr(lang, 'Assigned roles'), type: 'multiselect', items: roles.items.map((x) => x.role) }]}
          initial={{ roles: rolesAssign.current }}
          onSubmit={(v) => {
            const username = rolesAssign.user.username || rolesAssign.user.id;
            api.setUserRoles(username, v.roles || [])
              .then(() => notify && notify({ kind: 'success', title: tr(lang, 'Roles updated.') }))
              .catch((e) => notify && notify({ kind: 'error', title: tr(lang, 'Update failed.'), subtitle: e.detail || e.message }));
            setRolesAssign(null);
          }}
          onClose={() => setRolesAssign(null)} />
      )}
      <ConfirmDelete open={!!del} title={tr(lang, 'Remove')} body={del ? `${tr(lang, 'Remove')} "${del.row.name || del.row.role}"?` : ''} onConfirm={remove} onClose={() => setDel(null)} />
    </div>
  );
}

const GOV_SUBS = [
  { id: 'catalog', label: 'Data catalog' },
  { id: 'lineage', label: 'Lineage graph' },
  { id: 'access', label: 'Access control' },
  { id: 'schema', label: 'Schema Changes' },
];
const TITLES = {
  catalog: ['Data catalog', 'Search and explore every table and field across the platform.'],
  lineage: ['Lineage graph', 'Trace data flow RAW → Bronze → Silver → Gold → ClickHouse, down to field level.'],
  access: ['Access control', 'Manage users, roles, and row/column-level policies (RBAC / ABAC).'],
  schema: ['Schema Changes', 'Propose, review, and apply Iceberg schema changes with compatibility and impact analysis.'],
};

export default function Governance({ notify, lang }) {
  const [sub, setSub] = useState('catalog');
  const [asset, setAsset] = useState(null);

  if (sub === 'catalog' && asset) {
    return (
      <div className="w-page">
        <div className="w-crumb">
          <a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'Data Assets & Governance')}</a><span className="sep">/</span>
          <a href="#" onClick={(e) => e.preventDefault()}>{tr(lang, 'Data catalog')}</a><span className="sep">/</span><span>{asset.name}</span>
        </div>
        <AssetDetail asset={asset} onBack={() => setAsset(null)} notify={notify} lang={lang} />
      </div>
    );
  }
  const [t, s] = TITLES[sub];
  return (
    <div className="w-page">
      <PageHeader crumb={[tr(lang, 'Data Assets & Governance'), tr(lang, t)]} title={tr(lang, t)} sub={tr(lang, s)} />
      <SubSwitch items={trList(lang, GOV_SUBS)} value={sub} onChange={(v) => { setSub(v); setAsset(null); }} />
      {sub === 'catalog' && <Catalog onOpen={setAsset} lang={lang} />}
      {sub === 'lineage' && <LineageGraph notify={notify} lang={lang} />}
      {sub === 'access' && <AccessControl notify={notify} lang={lang} />}
      {sub === 'schema' && <SchemaChanges notify={notify} lang={lang} />}
    </div>
  );
}
