import { useState, useEffect } from 'react';
import { Button, Tag, ClickableTile } from '@carbon/react';
import Icon from '../components/Icon.jsx';
import { CarbonTable, StatusDot } from '../components/shared.jsx';
import { OV_QUICK, CURRENT_USER } from '../data/mockData.js';
import * as api from '../data/api.js';
import { tr } from '../i18n.js';

const RUN_COLS = [
  { key: 'pipe', header: 'Pipeline', mono: true },
  { key: 'status', header: 'Status' },
  { key: 'dur', header: 'Duration' },
  { key: 'when', header: 'Started' },
];

export default function Overview({ notify, lang, onNavigate }) {
  const h = new Date().getHours();
  const greet = lang === 'zh'
    ? (h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好')
    : (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');

  // Home aggregate from GET /api/overview (KPIs + runs + requests + favorites).
  const [ov, setOv] = useState({ kpis: [], runs: [], requests: [], favorites: [] });
  useEffect(() => {
    let alive = true;
    api.getOverview()
      .then((d) => { if (alive) setOv({ kpis: d.kpis || [], runs: d.runs || [], requests: d.requests || [], favorites: d.favorites || [] }); })
      .catch((err) => console.error('overview failed', err));
    return () => { alive = false; };
  }, []);
  const { kpis: OV_KPIS, runs: OV_RUNS, requests: OV_REQUESTS, favorites: OV_FAVS } = ov;

  const headers = RUN_COLS.map((c) => ({ ...c, header: tr(lang, c.header) }));

  return (
    <div className="w-page">
      <div className="ov-greet">
        <h1>{greet}, <b>{CURRENT_USER.firstName}</b>.</h1>
        <div className="badges">
          <Tag type="blue" size="md">Manufacturing</Tag>
          <Tag type="cool-gray" size="md">{tr(lang, 'Data Engineer')}</Tag>
        </div>
      </div>

      <div className="ov-kpis">
        {OV_KPIS.map((k) => (
          <div key={k.key} className="ov-kpi">
            <div className="k"><Icon name={k.icon} size={16} />{tr(lang, k.key)}</div>
            <div className={`v ${k.tone}`}>{k.value}</div>
            <div className="d">{k.up && <Icon name="arrow--up" size={14} />}{k.delta}</div>
          </div>
        ))}
      </div>

      <div className="ov-quick">
        {OV_QUICK.map((q) => (
          <ClickableTile key={q.title} className="ov-qa" onClick={() => onNavigate(q.to)}>
            <span className="ic"><Icon name={q.icon} size={20} /></span>
            <span><div className="t">{tr(lang, q.title)}</div><div className="s">{tr(lang, q.sub)}</div></span>
          </ClickableTile>
        ))}
      </div>

      <div className="ov-grid">
        <div className="ov-block">
          <div className="ov-block__h">
            <Icon name="flow" size={16} />{tr(lang, 'Recent pipelines')}
            <Button className="more" kind="ghost" size="sm" onClick={() => onNavigate('monitoring')}>{tr(lang, 'View all')}</Button>
          </div>
          <CarbonTable
            headers={headers}
            rows={OV_RUNS}
            withToolbar={false}
            onRowClick={() => onNavigate('monitoring')}
            renderCell={(r, k) => (k === 'status' ? <StatusDot kind={r.status}>{r.status}</StatusDot> : r[k])}
          />
        </div>

        <div className="ov-side">
          <div className="ov-block">
            <div className="ov-block__h">
              <Icon name="user--follow" size={16} />{tr(lang, 'Pending access requests')}
              <Tag type="red" size="sm" style={{ marginLeft: 'auto' }}>{OV_REQUESTS.length}</Tag>
            </div>
            {OV_REQUESTS.map((r) => (
              <div key={r.id} className="ov-req">
                <div className="t">{r.who} → <b>{r.role}</b></div>
                <div className="s">{r.target} · {r.when}</div>
                <div className="acts">
                  <Button kind="primary" size="sm" onClick={() => notify({ kind: 'success', title: tr(lang, 'Access approved'), subtitle: `${r.who} · ${r.role}` })}>{tr(lang, 'Approve')}</Button>
                  <Button kind="tertiary" size="sm" onClick={() => notify({ kind: 'info', title: tr(lang, 'Access denied'), subtitle: `${r.who} · ${r.role}` })}>{tr(lang, 'Deny')}</Button>
                </div>
              </div>
            ))}
          </div>

          <div className="ov-block">
            <div className="ov-block__h"><Icon name="dashboard" size={16} />{tr(lang, 'My dashboards')}</div>
            {OV_FAVS.map((f) => (
              <ClickableTile key={f.name} className="ov-fav" onClick={() => onNavigate('analytics')}>
                <span className="ic"><Icon name="star--filled" size={16} /></span>
                <span style={{ flex: 1, minWidth: 0 }}><div className="nm">{f.name}</div><div className="mt">{f.mt}</div></span>
                <Icon name="chevron--right" size={16} style={{ color: 'var(--cds-icon-secondary)' }} />
              </ClickableTile>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
