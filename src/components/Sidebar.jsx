/* Custom vertically-centered product sidebar.
   Deliberately NOT Carbon UIShell — built from layout + Carbon
   Search to match the prototype's borderless, centered nav. */
import { useState, useRef, useEffect } from 'react';
import Icon from './Icon.jsx';
import AnimatedLogo from './AnimatedLogo.jsx';
import { useCollection } from '../data/DataProvider.jsx';
import { IPAS_NAV, CURRENT_USER } from '../data/mockData.js';
import { tr } from '../i18n.js';

const HELP_ITEMS = [
  { icon: 'document', label: 'Documentation' },
  { icon: 'keyboard', label: 'Keyboard shortcuts', meta: '⌘ /' },
  { icon: 'idea', label: "What's new" },
  { icon: 'help-desk', label: 'Support' },
];

export default function Sidebar({
  current, caps, onSelect, collapsed, onToggle, onHome, lang, onLang,
  onLogout, onNotifications, onProfile, onAppearance,
}) {
  // Capability-gated nav (§22.8): Federation appears only when the backend
  // reports this instance is hybrid (group HQ).
  const navItems = IPAS_NAV.filter((n) => n.id !== 'federation' || !!(caps && caps.federation));
  const [menu, setMenu] = useState(null); // 'user' | 'help' | null
  const footRef = useRef(null);
  const { items: notifications } = useCollection('notifications');
  const unread = notifications.filter((n) => n.unread).length;

  // Close any open menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const onDoc = (e) => { if (footRef.current && !footRef.current.contains(e.target)) setMenu(null); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const go = (fn) => { setMenu(null); if (fn) fn(); };

  return (
    <nav className={`ip-sidenav ${collapsed ? 'collapsed' : ''}`} aria-label="Product navigation">
      <div className="ip-navgroup">
        <a className="ip-brand" href="#" onClick={(e) => { e.preventDefault(); onHome && onHome(); }} aria-label="SiPTORY InSight — home">
          <AnimatedLogo size="sm" />
          <span className="mark">iS</span>
        </a>

        <div className="ip-nav">
          {navItems.map((n) => (
            <button
              key={n.id}
              className={`ip-navitem ${current === n.id ? 'active' : ''}`}
              onClick={() => onSelect(n.id)}
              title={tr(lang, n.label)}
            >
              <span className="ic"><Icon name={n.icon} size={18} /></span>
              <span className="t">{tr(lang, n.label)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="ip-foot" ref={footRef}>
        <div className="ip-utility">
          <button className="ip-ubtn ip-lang" aria-label="Switch language" title="中文 / English" onClick={() => onLang(lang === 'zh' ? 'en' : 'zh')}>
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <button className="ip-ubtn" aria-label={tr(lang, 'Notifications')} title={tr(lang, 'Notifications')} onClick={() => onNotifications && onNotifications()}>
            <Icon name="notification" size={20} />{unread > 0 && <span className="ncount">{unread}</span>}
          </button>
          <button className={`ip-ubtn ${menu === 'help' ? 'on' : ''}`} aria-label={tr(lang, 'Help')} title={tr(lang, 'Help')} onClick={() => setMenu((m) => (m === 'help' ? null : 'help'))}>
            <Icon name="help" size={20} />
          </button>
          <button className="ip-ubtn ip-collapse" aria-label="Collapse navigation" onClick={onToggle}>
            <Icon name={collapsed ? 'chevron--right' : 'chevron--left'} size={20} />
          </button>
        </div>

        {menu === 'help' && (
          <div className="ip-usermenu" role="menu">
            <div className="ip-usermenu__lbl">{tr(lang, 'Help & resources')}</div>
            {HELP_ITEMS.map((it) => (
              <button key={it.label} className="ip-usermenu__item" role="menuitem" onClick={() => setMenu(null)}>
                <Icon name={it.icon} size={16} />{tr(lang, it.label)}{it.meta && <span className="meta">{it.meta}</span>}
              </button>
            ))}
          </div>
        )}

        {menu === 'user' && (
          <div className="ip-usermenu ip-usermenu--lg" role="menu">
            <div className="ip-usermenu__hd">
              <div className="nm">{CURRENT_USER.name}</div>
              <div className="em">{CURRENT_USER.email}</div>
              <div className="badges"><span className="b blue">{tr(lang, 'Data Engineer')}</span><span className="b gray">Manufacturing</span></div>
            </div>
            <button className="ip-usermenu__item" role="menuitem" onClick={() => go(() => onProfile && onProfile('profile'))}><Icon name="user" size={16} />{tr(lang, 'My profile')}</button>
            <button className="ip-usermenu__item" role="menuitem" onClick={() => go(() => onProfile && onProfile('prefs'))}><Icon name="settings--adjust" size={16} />{tr(lang, 'Preferences')}</button>
            <button className="ip-usermenu__item" role="menuitem" onClick={() => go(() => onProfile && onProfile('perms'))}><Icon name="security" size={16} />{tr(lang, 'My permissions')}</button>
            <button className="ip-usermenu__item" role="menuitem" onClick={() => go(() => onProfile && onProfile('keys'))}><Icon name="api" size={16} />{tr(lang, 'API keys')}</button>
            <div className="ip-usermenu__sep" />
            <button className="ip-usermenu__item" role="menuitem" onClick={() => setMenu(null)}><Icon name="enterprise" size={16} />{tr(lang, 'Switch organization')}<span className="meta">Manufacturing</span></button>
            <button className="ip-usermenu__item" role="menuitem" onClick={() => go(onAppearance)}><Icon name="screen" size={16} />{tr(lang, 'Appearance')}<span className="meta">{tr(lang, 'Light')}</span></button>
            <button className="ip-usermenu__item" role="menuitem" onClick={() => go(() => onLang(lang === 'zh' ? 'en' : 'zh'))}><Icon name="translate" size={16} />{tr(lang, 'Language')}<span className="meta">{lang === 'zh' ? '中文' : 'English'}</span></button>
            <div className="ip-usermenu__sep" />
            <button className="ip-usermenu__item" role="menuitem" onClick={() => { setMenu(null); onLogout && onLogout(); }}><Icon name="logout" size={16} />{tr(lang, 'Sign out')}</button>
          </div>
        )}

        <button
          className={`ip-user ${menu === 'user' ? 'open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={menu === 'user'}
          title={CURRENT_USER.name}
          onClick={() => setMenu((m) => (m === 'user' ? null : 'user'))}
        >
          <span className="av">{CURRENT_USER.initials}</span>
          <span className="meta">
            <span className="nm">{CURRENT_USER.name}</span>
            <span className="rl">{tr(lang, CURRENT_USER.role)}</span>
          </span>
          <span className="caret"><Icon name="chevron--down" size={16} /></span>
        </button>
      </div>
    </nav>
  );
}
