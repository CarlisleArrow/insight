import { useState, useCallback } from 'react';
import { Theme, ToastNotification } from '@carbon/react';
import { DataProvider } from './data/DataProvider.jsx';
import Sidebar from './components/Sidebar.jsx';
import NotificationsPanel from './components/NotificationsPanel.jsx';
import Login from './pages/Login.jsx';
import Welcome from './pages/Welcome.jsx';
import Overview from './pages/Overview.jsx';
import Profile from './pages/Profile.jsx';
import Analytics from './pages/Analytics.jsx';
import DataServices from './pages/DataServices.jsx';
import Modeling from './pages/Modeling.jsx';
import DevConfig from './pages/DevConfig.jsx';
import Governance from './pages/Governance.jsx';
import Monitoring from './pages/Monitoring.jsx';
import Ai from './pages/Ai.jsx';
import Federation from './pages/Federation.jsx';
import Admin from './pages/Admin.jsx';
import { tr } from './i18n.js';

const SECTIONS = {
  overview: Overview,
  analytics: Analytics,
  dataservices: DataServices,
  modeling: Modeling,
  devconfig: DevConfig,
  governance: Governance,
  monitoring: Monitoring,
  ai: Ai,
  federation: Federation,
  admin: Admin,
};

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [nav, setNav] = useState(null);
  const [profileTab, setProfileTab] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [lang, setLang] = useState('en');
  const [toasts, setToasts] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);

  const notify = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 4500);
  }, []);

  const selectNav = (id) => { setProfileTab(null); setNav(id); };
  const goProfile = (tab) => { setProfileTab(tab); setNav('__profile'); };

  if (!authed) {
    return (
      <Theme theme="white">
        <Login onLogin={() => setAuthed(true)} />
      </Theme>
    );
  }

  const logout = () => { setAuthed(false); setNav(null); setProfileTab(null); setNotifOpen(false); };
  const Section = nav && SECTIONS[nav] ? SECTIONS[nav] : null;

  let content;
  if (nav === '__profile') content = <Profile tab={profileTab} lang={lang} notify={notify} onNavigate={selectNav} />;
  else if (Section) content = <Section notify={notify} lang={lang} onNavigate={selectNav} />;
  else content = <Welcome onNavigate={selectNav} lang={lang} />;

  return (
    <Theme theme="white">
     <DataProvider>
      <div className="ip-shell">
        <Sidebar
          current={nav}
          onSelect={selectNav}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          onHome={() => selectNav(null)}
          lang={lang}
          onLang={setLang}
          onLogout={logout}
          onNotifications={() => setNotifOpen(true)}
          onProfile={goProfile}
          onAppearance={() => notify({ kind: 'info', title: tr(lang, 'Appearance'), subtitle: 'Light / Dark / High-contrast — set in Preferences.' })}
        />
        <main className="ip-main">
          <div key={nav || 'home'} className="ip-anim-page">
            {content}
          </div>
        </main>

        {notifOpen && (
          <NotificationsPanel lang={lang} notify={notify} onNavigate={selectNav} onClose={() => setNotifOpen(false)} />
        )}

        {toasts.length > 0 && (
          <div className="ip-toaststack">
            {toasts.map((t) => (
              <ToastNotification
                key={t.id}
                kind={t.kind || 'success'}
                title={t.title}
                subtitle={t.subtitle}
                lowContrast
                onClose={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
              />
            ))}
          </div>
        )}
      </div>
     </DataProvider>
    </Theme>
  );
}
