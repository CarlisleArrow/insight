import { useState, useEffect } from 'react';
import {
  Tabs, TabList, Tab, TabPanels, TabPanel,
  Tag, Button, Toggle, Checkbox, TextInput, CodeSnippet,
  StructuredListWrapper, StructuredListBody, StructuredListRow, StructuredListCell,
  Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
} from '@carbon/react';
import Icon, { iconFor } from '../components/Icon.jsx';
import { PageHeader, CarbonTable } from '../components/shared.jsx';
import { Picker } from '../components/inputs.jsx';
import * as api from '../data/api.js';
import { PROFILE_TABS, NOTIF_EVENTS } from '../data/mockData.js';
import { tr } from '../i18n.js';

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

/* ---- My profile (GET /api/me) ---- */
function MyProfile({ lang }) {
  const [me, setMe] = useState({ name: '', email: '', roles: [], details: [] });
  useEffect(() => {
    let alive = true;
    api.getMe().then((d) => { if (alive) setMe(d); }).catch((err) => console.error('me failed', err));
    return () => { alive = false; };
  }, []);
  return (
    <div className="pr-card">
      <div className="pr-id">
        <span className="av">{initialsOf(me.name)}</span>
        <div>
          <div className="nm">{me.name || '—'}</div>
          <div className="em">{me.email || ''}</div>
          <div className="badges">{(me.roles || []).map((rr) => <Tag key={rr} type="blue" size="sm">{tr(lang, rr)}</Tag>)}</div>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Tag type="gray" renderIcon={iconFor('locked')}>{tr(lang, 'Identity fields are managed in corporate IAM (read-only).')}</Tag>
      </div>
      <StructuredListWrapper aria-label={tr(lang, 'My profile')} isCondensed>
        <StructuredListBody>
          {(me.details || []).map((d) => (
            <StructuredListRow key={d.dt}>
              <StructuredListCell head>{tr(lang, d.dt)}</StructuredListCell>
              <StructuredListCell>{d.dd}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
    </div>
  );
}

/* ---- Preferences ---- */
function Preferences({ lang, notify }) {
  return (
    <div className="pr-card">
      <div className="pr-grp">
        <h3>{tr(lang, 'Appearance')}</h3>
        <p className="h">{tr(lang, 'Choose how the platform looks.')}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {['Light', 'Dark', 'High contrast'].map((m, i) => (
            <Button key={m} kind={i === 0 ? 'primary' : 'tertiary'} size="md">{tr(lang, m)}</Button>
          ))}
        </div>
      </div>
      <div className="pr-grp">
        <h3>{tr(lang, 'Localization & defaults')}</h3>
        <div className="w-row" style={{ marginBottom: 16 }}>
          <Picker label={tr(lang, 'Language')} items={['English', '中文']} value={lang === 'zh' ? '中文' : 'English'} onChange={() => {}} />
          <Picker label={tr(lang, 'Timezone')} items={['UTC', 'America/New_York', 'Asia/Shanghai']} value="Asia/Shanghai" onChange={() => {}} />
        </div>
        <div className="w-row" style={{ marginBottom: 16 }}>
          <Picker label={tr(lang, 'Default landing page')} items={['Home / Overview', 'Dashboards', 'Pipelines']} value="Home / Overview" onChange={() => {}} />
          <Picker label={tr(lang, 'Default query engine')} items={['Auto', 'ClickHouse', 'Trino']} value="Auto" onChange={() => {}} />
        </div>
        <div className="w-row">
          <Picker label={tr(lang, 'Table page size')} items={['10', '25', '50']} value="25" onChange={() => {}} />
          <Picker label={tr(lang, 'Date format')} items={['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']} value="YYYY-MM-DD" onChange={() => {}} />
        </div>
      </div>
      <Button kind="primary" renderIcon={iconFor('save')} onClick={() => notify({ kind: 'success', title: tr(lang, 'Preferences saved.') })}>{tr(lang, 'Save preferences')}</Button>
    </div>
  );
}

/* ---- Notification settings ---- */
function NotificationSettings({ lang, notify }) {
  return (
    <div className="pr-card">
      <div className="pr-grp" style={{ marginBottom: 16 }}>
        <h3>{tr(lang, 'Notification channels')}</h3>
        <p className="h">{tr(lang, 'Pick how you are notified for each event type.')}</p>
      </div>
      <Table size="lg" className="pr-ntable">
        <TableHead>
          <TableRow>
            <TableHeader>{tr(lang, 'Event')}</TableHeader>
            <TableHeader>{tr(lang, 'In-app')}</TableHeader>
            <TableHeader>{tr(lang, 'Email')}</TableHeader>
            <TableHeader>IM</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {NOTIF_EVENTS.map((e, i) => (
            <TableRow key={e}>
              <TableCell>{tr(lang, e)}</TableCell>
              <TableCell><Checkbox id={`nc-app-${i}`} labelText="" defaultChecked /></TableCell>
              <TableCell><Checkbox id={`nc-mail-${i}`} labelText="" defaultChecked={i < 4} /></TableCell>
              <TableCell><Checkbox id={`nc-im-${i}`} labelText="" defaultChecked={i === 1 || i === 3} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div style={{ display: 'flex', gap: 32, margin: '20px 0', flexWrap: 'wrap' }}>
        <Toggle size="sm" id="nc-digest" labelText={tr(lang, 'Daily digest instead of per-event email')} />
        <Toggle size="sm" id="nc-mute" labelText={tr(lang, 'Mute 22:00–07:00')} defaultToggled />
      </div>
      <Button kind="primary" renderIcon={iconFor('save')} onClick={() => notify({ kind: 'success', title: tr(lang, 'Notification settings saved.') })}>{tr(lang, 'Save settings')}</Button>
    </div>
  );
}

/* ---- My permissions (GET /api/me/permissions) ---- */
function MyPermissions({ lang }) {
  const [data, setData] = useState({ roles: [], permissions: [] });
  useEffect(() => {
    let alive = true;
    api.getMyPermissions()
      .then((d) => { if (alive) setData({ roles: d.roles || [], permissions: (d.permissions || []).map((p, i) => ({ ...p, id: String(i) })) }); })
      .catch((err) => console.error('permissions failed', err));
    return () => { alive = false; };
  }, []);
  const headers = [
    { key: 'asset', header: tr(lang, 'Asset'), mono: true },
    { key: 'access', header: tr(lang, 'Access') },
    { key: 'masking', header: tr(lang, 'Masking applied') },
  ];
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Tag type="gray" renderIcon={iconFor('security')}>{tr(lang, 'Effective access — computed from your roles & policies')}</Tag>
      </div>
      <div className="pr-grp">
        <h3>{tr(lang, 'My roles')}</h3>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {data.roles.length === 0
            ? <span style={{ fontSize: '.8125rem', color: 'var(--cds-text-secondary)' }}>—</span>
            : data.roles.map((rr) => <Tag key={rr} type="blue" size="md">{rr}</Tag>)}
        </div>
      </div>
      <CarbonTable
        headers={headers}
        rows={data.permissions}
        searchPlaceholder={tr(lang, 'Search assets I can access')}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')}>{tr(lang, 'Request access')}</Button>}
        renderCell={(r, k) => (k === 'masking'
          ? (r.masking === 'None' ? <Tag type="green" size="sm">None</Tag> : <span className="ip-mono" style={{ fontSize: '.75rem' }}>{r.masking}</span>)
          : r[k])}
      />
    </div>
  );
}

/* ---- API keys (GET/POST/DELETE /api/me/apikeys) ---- */
function MyApiKeys({ lang, notify }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(null); // one-time plaintext after create
  const [keys, setKeys] = useState([]);
  const [form, setForm] = useState({ name: '', scope: 'read:gold', expiry: '90 days' });

  const reload = () => api.myApiKeys.list().then((rows) => setKeys((rows || []).map((r, i) => ({ ...r, id: String(r.id != null ? r.id : i) })))).catch((err) => console.error('keys failed', err));
  useEffect(() => { reload(); }, []);

  const headers = [
    { key: 'name', header: tr(lang, 'Name') },
    { key: 'prefix', header: tr(lang, 'Token'), mono: true },
    { key: 'scope', header: tr(lang, 'Scopes') },
    { key: 'used', header: tr(lang, 'Last used') },
    { key: 'ofw', header: '' },
  ];
  const close = () => { setOpen(false); setToken(null); setForm({ name: '', scope: 'read:gold', expiry: '90 days' }); };
  const generate = async () => {
    try {
      const created = await api.myApiKeys.create(form);
      setToken(created.token);
      await reload();
    } catch (err) {
      notify({ kind: 'error', title: tr(lang, 'Create failed.'), subtitle: String(err.message || err) });
    }
  };
  const del = async (id) => {
    try { await api.myApiKeys.remove(id); setKeys((ks) => ks.filter((k) => k.id !== id)); notify({ kind: 'success', title: tr(lang, 'API key revoked.') }); }
    catch (err) { notify({ kind: 'error', title: tr(lang, 'Revoke failed.'), subtitle: String(err.message || err) }); }
  };
  return (
    <div>
      <CarbonTable
        headers={headers}
        rows={keys}
        searchPlaceholder={tr(lang, 'Search keys')}
        actions={<Button kind="primary" size="lg" renderIcon={iconFor('add')} onClick={() => { setToken(null); setOpen(true); }}>{tr(lang, 'Create API key')}</Button>}
        renderCell={(r, k) => {
          if (k === 'scope') return <Tag type="cool-gray" size="sm">{r.scope}</Tag>;
          if (k === 'ofw') return <Button kind="ghost" size="sm" hasIconOnly renderIcon={iconFor('trash-can')} iconDescription="Revoke" onClick={(e) => { e.stopPropagation(); del(r.id); }} />;
          return r[k];
        }}
      />

      {open && (
        <ComposedModal open size="sm" onClose={close}>
          <ModalHeader label={tr(lang, 'Personal access token')} title={tr(lang, 'Create API key')} />
          <ModalBody hasForm>
            {token ? (
              <div className="w-fld">
                <label className="cds--label">{tr(lang, 'Copy this token now — it will not be shown again.')}</label>
                <CodeSnippet
                  type="single"
                  feedback={tr(lang, 'Token copied.')}
                  onClick={() => { navigator.clipboard?.writeText(token); notify({ kind: 'info', title: tr(lang, 'Token copied.') }); }}
                >
                  {token}
                </CodeSnippet>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <TextInput id="ak-name" labelText={tr(lang, 'Key name')} placeholder="personal-cli" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                <div className="w-row">
                  <Picker label={tr(lang, 'Scope')} items={['read:gold', 'read:silver', 'write:pipelines']} value={form.scope} onChange={(v) => setForm((f) => ({ ...f, scope: v }))} />
                  <Picker label={tr(lang, 'Expiry')} items={['30 days', '90 days', '1 year', 'No expiry']} value={form.expiry} onChange={(v) => setForm((f) => ({ ...f, expiry: v }))} />
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            {token ? (
              <Button kind="primary" onClick={close}>{tr(lang, 'Done')}</Button>
            ) : (
              <>
                <Button kind="secondary" onClick={close}>{tr(lang, 'Cancel')}</Button>
                <Button kind="primary" renderIcon={iconFor('add')} onClick={generate}>{tr(lang, 'Generate token')}</Button>
              </>
            )}
          </ModalFooter>
        </ComposedModal>
      )}
    </div>
  );
}

/* ---- Security & sessions (GET/DELETE /api/me/sessions) ---- */
function Sessions({ lang, notify }) {
  const [sessions, setSessions] = useState([]);
  const reload = () => api.getMySessions().then((rows) => setSessions(rows || [])).catch((err) => console.error('sessions failed', err));
  useEffect(() => { reload(); }, []);

  const signOut = async (id) => {
    try { await api.deleteMySession(id); setSessions((s) => s.filter((x) => x.id !== id)); notify({ kind: 'info', title: tr(lang, 'Session signed out.') }); }
    catch (err) { notify({ kind: 'error', title: tr(lang, 'Sign out failed.'), subtitle: String(err.message || err) }); }
  };
  return (
    <div className="pr-card">
      <div className="pr-grp" style={{ marginBottom: 16 }}>
        <h3>{tr(lang, 'Active sessions')}</h3>
        <p className="h">{tr(lang, 'Your password is managed in corporate SSO (Keycloak).')}</p>
      </div>
      {sessions.length === 0 && <p className="h">{tr(lang, 'No active sessions.')}</p>}
      {sessions.map((s, i) => (
        <div key={s.id} className="pr-session" style={{ borderBottom: i < sessions.length - 1 ? '1px solid var(--wire-border)' : 'none' }}>
          <Icon name="laptop" size={20} style={{ color: 'var(--cds-icon-secondary)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dev">{s.clients || tr(lang, 'Session')}{i === 0 && <Tag type="green" size="sm" style={{ marginLeft: 8 }}>{tr(lang, 'This device')}</Tag>}</div>
            <div className="meta">{s.ip} · {s.last_seen || s.started}</div>
          </div>
          {i !== 0 && <Button kind="ghost" size="sm" onClick={() => signOut(s.id)}>{tr(lang, 'Sign out')}</Button>}
        </div>
      ))}
      <div style={{ marginTop: 20 }}>
        <Button kind="danger" size="md" renderIcon={iconFor('logout')} onClick={() => { sessions.slice(1).forEach((s) => signOut(s.id)); }}>{tr(lang, 'Sign out all other sessions')}</Button>
      </div>
    </div>
  );
}

export default function Profile({ tab, lang, notify }) {
  const initial = Math.max(0, PROFILE_TABS.findIndex((t) => t.id === (tab || 'profile')));
  const [idx, setIdx] = useState(initial);
  useEffect(() => { setIdx(initial); }, [initial]);

  return (
    <div className="w-page">
      <PageHeader
        crumb={[tr(lang, 'Personal center'), tr(lang, PROFILE_TABS[idx].label)]}
        title={tr(lang, 'Personal center')}
        sub={tr(lang, 'Your profile, preferences, permissions, and security.')}
      />
      <Tabs selectedIndex={idx} onChange={({ selectedIndex }) => setIdx(selectedIndex)}>
        <TabList aria-label={tr(lang, 'Personal center')}>
          {PROFILE_TABS.map((t) => <Tab key={t.id}>{tr(lang, t.label)}</Tab>)}
        </TabList>
        <TabPanels>
          <TabPanel><MyProfile lang={lang} /></TabPanel>
          <TabPanel><Preferences lang={lang} notify={notify} /></TabPanel>
          <TabPanel><NotificationSettings lang={lang} notify={notify} /></TabPanel>
          <TabPanel><MyPermissions lang={lang} /></TabPanel>
          <TabPanel><MyApiKeys lang={lang} notify={notify} /></TabPanel>
          <TabPanel><Sessions lang={lang} notify={notify} /></TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}
