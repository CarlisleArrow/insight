import { useState } from 'react';
import { Button, ContentSwitcher, Switch } from '@carbon/react';
import Icon, { iconFor } from './Icon.jsx';
import { SidePanel } from './shared.jsx';
import { useCollection } from '../data/DataProvider.jsx';
import * as api from '../data/api.js';
import { NOTIF_META } from '../data/mockData.js';
import { tr } from '../i18n.js';

const TABS = [['all', 'All'], ['unread', 'Unread'], ['mentions', 'Mentions']];

export default function NotificationsPanel({ lang, notify, onClose }) {
  const { items: notifs, update, remove, set } = useCollection('notifications');
  const [tab, setTab] = useState('all');

  const unread = notifs.filter((n) => n.unread).length;
  const list = notifs.filter((n) => (tab === 'all' ? true : tab === 'unread' ? n.unread : n.mention));

  const markRead = (id) => update(id, { unread: false });
  const markAll = () => {
    set(notifs.map((n) => ({ ...n, unread: false })));
    api.markAllNotificationsRead().catch((err) => console.error('mark all read failed', err));
  };
  const act = (n, decision) => {
    remove(n.id);
    notify({
      kind: decision === 'approve' ? 'success' : 'info',
      title: decision === 'approve' ? tr(lang, 'Access approved') : tr(lang, 'Access denied'),
      subtitle: 'Ade Okafor · Analyst role',
    });
  };

  return (
    <SidePanel
      sup={tr(lang, 'Notifications')}
      title={tr(lang, 'Notifications')}
      width={400}
      onClose={onClose}
      footer={(
        <>
          <Button kind="secondary" onClick={markAll}>{tr(lang, 'Mark all as read')}</Button>
          <Button kind="primary" renderIcon={iconFor('settings')}>{tr(lang, 'Settings')}</Button>
        </>
      )}
    >
      <div className="w-notif__wrap">
        <div className="w-notif__switch">
          <ContentSwitcher
            size="md"
            selectedIndex={Math.max(0, TABS.findIndex(([id]) => id === tab))}
            onChange={({ index }) => setTab(TABS[index][0])}
          >
            {TABS.map(([id, lbl]) => (
              <Switch key={id} name={id} text={`${tr(lang, lbl)}${id === 'unread' && unread > 0 ? ` (${unread})` : ''}`} />
            ))}
          </ContentSwitcher>
        </div>
        <div className="w-notif__list">
          {list.length === 0 ? (
            <div className="w-notif__empty">{tr(lang, 'Nothing here.')}</div>
          ) : list.map((n) => {
            const m = NOTIF_META[n.type] || NOTIF_META.system;
            return (
              <div key={n.id} className={`w-notif ${n.unread ? 'unread' : ''}`} onClick={() => markRead(n.id)}>
                <span className="w-notif__ic" style={{ color: m.color }}><Icon name={m.icon} size={20} /></span>
                <div className="w-notif__bd">
                  <div className="t">{tr(lang, n.title)}</div>
                  <div className="d">{n.desc}</div>
                  <div className="ts">{n.ts}</div>
                  {n.request && (
                    <div className="w-notif__req">
                      <Button kind="primary" size="sm" onClick={(e) => { e.stopPropagation(); act(n, 'approve'); }}>{tr(lang, 'Approve')}</Button>
                      <Button kind="tertiary" size="sm" onClick={(e) => { e.stopPropagation(); act(n, 'deny'); }}>{tr(lang, 'Deny')}</Button>
                    </div>
                  )}
                </div>
                {n.unread && <span className="w-notif__dot" />}
              </div>
            );
          })}
        </div>
      </div>
    </SidePanel>
  );
}
