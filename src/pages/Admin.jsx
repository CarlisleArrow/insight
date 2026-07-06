import { useState } from 'react';
import { Button, Tag } from '@carbon/react';
import { iconFor } from '../components/Icon.jsx';
import { PageHeader, SubSwitch, CarbonTable, StatusDot, RowMenu } from '../components/shared.jsx';
import { FormModal, ConfirmDelete } from '../components/modals.jsx';
import { useCollection } from '../data/DataProvider.jsx';
import { SCHEMAS } from '../data/formSchemas.js';
import { ADMIN_TABS, ADMIN_DATA } from '../data/mockData.js';
import { tr, trList } from '../i18n.js';

const COLLECTION = { users: 'adminUsers', orgs: 'adminOrgs', config: 'adminConfig', audit: 'adminAudit', api: 'adminApi', tenancy: 'adminTenancy' };
const SCHEMA_KEY = { users: 'adminUsers', orgs: 'adminOrgs', config: 'adminConfig', api: 'adminApi', tenancy: 'adminTenancy' };

function cellFor(tab, r, k, lang) {
  if (tab === 'users') {
    if (k === 'role') return <Tag type="cool-gray" size="sm">{tr(lang, r.role)}</Tag>;
    if (k === 'status') return <StatusDot kind={r.status === 'Active' ? 'active' : r.status === 'Suspended' ? 'failed' : 'gray'}>{tr(lang, r.status)}</StatusDot>;
  }
  if (tab === 'config' && k === 'scope') return <Tag type="cool-gray" size="sm">{tr(lang, r.scope)}</Tag>;
  if (tab === 'audit' && k === 'res') return <StatusDot kind={r.res === 'OK' ? 'success' : 'failed'}>{tr(lang, r.res)}</StatusDot>;
  if (tab === 'api') {
    if (k === 'scope') return <Tag type="cool-gray" size="sm">{r.scope}</Tag>;
    if (k === 'status') return <StatusDot kind={r.status === 'Active' ? 'active' : 'gray'}>{tr(lang, r.status)}</StatusDot>;
  }
  if (tab === 'tenancy') {
    if (k === 'plan') return <Tag type={r.plan === 'Enterprise' ? 'teal' : r.plan === 'Trial' ? 'cool-gray' : 'blue'} size="sm">{tr(lang, r.plan)}</Tag>;
    if (k === 'status') return <StatusDot kind={r.status}>{tr(lang, r.status)}</StatusDot>;
  }
  return r[k];
}

function exportCsv(filename, cols, rows) {
  const head = cols.map((c) => c.header).join(',');
  const body = rows.map((r) => cols.map((c) => `"${String(r[c.key] ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([`${head}\n${body}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function Admin({ notify, lang }) {
  const [tab, setTab] = useState('users');
  const [modal, setModal] = useState(null); // { mode, row }
  const [del, setDel] = useState(null);

  const d = ADMIN_DATA[tab];
  const label = tr(lang, ADMIN_TABS.find((t) => t.id === tab).label);
  const coll = useCollection(COLLECTION[tab]);
  const schema = SCHEMAS[SCHEMA_KEY[tab]];
  const baseHeaders = tab === 'audit' ? d.cols : [...d.cols, { key: 'ofw', header: '' }];
  const headers = baseHeaders.map((c) => ({ ...c, header: c.header ? tr(lang, c.header) : c.header }));

  const submit = (vals) => {
    if (modal.mode === 'create') { coll.add(vals); notify && notify({ kind: 'success', title: `${label} — ${tr(lang, 'entry added.')}` }); }
    else { coll.update(modal.row.id, vals); notify && notify({ kind: 'success', title: tr(lang, 'Changes saved.') }); }
    setModal(null);
  };
  const confirmDelete = () => { coll.remove(del.id); setDel(null); notify && notify({ kind: 'success', title: tr(lang, 'Entry deleted.') }); };

  return (
    <div className="w-page">
      <PageHeader
        crumb={[tr(lang, 'Platform Admin'), label]}
        title={tr(lang, 'Platform administration')}
        sub={tr(lang, 'Manage people, organizations, configuration, and platform-wide controls.')}
      />
      <SubSwitch items={trList(lang, ADMIN_TABS)} value={tab} onChange={(v) => { setTab(v); setModal(null); setDel(null); }} />
      <CarbonTable
        headers={headers}
        rows={coll.items}
        withPagination
        searchPlaceholder={`${tr(lang, 'Search')} ${label.toLowerCase()}`}
        actions={(
          <>
            <Button kind="ghost" style={{background:"transparent"}} size="lg" hasIconOnly renderIcon={iconFor('filter')} iconDescription={tr(lang, 'Filter')} />
            {tab === 'audit' && <Button kind="ghost" size="lg" hasIconOnly renderIcon={iconFor('download')} iconDescription={tr(lang, 'Export CSV')} onClick={() => { exportCsv('audit-log.csv', d.cols, coll.items); notify && notify({ kind: 'success', title: tr(lang, 'Audit log exported.') }); }} />}
            {d.create && schema && <Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => setModal({ mode: 'create' })}>{tr(lang, d.create)}</Button>}
          </>
        )}
        renderCell={(r, k) => (k === 'ofw'
          ? <RowMenu onEdit={() => setModal({ mode: 'edit', row: r })} onDelete={() => setDel(r)} />
          : cellFor(tab, r, k, lang))}
      />

      {modal && schema && (
        <FormModal
          open
          label={tr(lang, 'Platform admin')}
          title={modal.mode === 'create' ? tr(lang, d.create) : `${tr(lang, 'Edit')} ${label.toLowerCase()}`}
          submitText={modal.mode === 'create' ? tr(lang, 'Add') : tr(lang, 'Save')}
          schema={schema}
          initial={modal.row}
          onSubmit={submit}
          onClose={() => setModal(null)}
        />
      )}
      <ConfirmDelete
        open={!!del}
        title={tr(lang, 'Delete entry')}
        body={del ? `${tr(lang, 'Delete')} "${del.name || del.org || del.key || del.tenant || del.id}"? ${tr(lang, 'This cannot be undone.')}` : ''}
        onConfirm={confirmDelete}
        onClose={() => setDel(null)}
      />
    </div>
  );
}
