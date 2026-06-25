import { useRef, useEffect } from 'react';
import gsap from 'gsap';
import { ClickableTile } from '@carbon/react';
import Icon from '../components/Icon.jsx';
import { WELCOME_ACTIONS, CURRENT_USER } from '../data/mockData.js';
import { tr } from '../i18n.js';

/* A small "data node" on an orbit. */
function Node({ x, y, r, fill, halo, pulse }) {
  return (
    <g>
      {halo && <circle cx={x} cy={y} r={r + 5} fill="none" stroke={fill} strokeWidth="1" opacity="0.35" />}
      <circle className={pulse ? 'wc-pulse' : undefined} cx={x} cy={y} r={r} fill={fill} />
    </g>
  );
}

/* Mini dashboard card that drifts. Outer group holds the static position
   (untouched by GSAP); inner .wc-float is what animates, so the base offset
   is never clobbered by the tween's transform. */
function Card({ x, y, w, h, children }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <g className="wc-float">
        <rect width={w} height={h} fill="#ffffff" stroke="#e0e0e0" strokeWidth="1.4" />
        <rect x="12" y="12" width={w * 0.42} height="4" fill="#c6c6c6" />
        {children}
      </g>
    </g>
  );
}

function WelcomeIllustration() {
  return (
    <svg viewBox="0 0 600 600" role="img" aria-label="SiPTORY InSight data fabric">
      <defs>
        <linearGradient id="wcBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4589ff" /><stop offset="1" stopColor="#0f62fe" /></linearGradient>
        <linearGradient id="wcTeal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#08bdba" /><stop offset="1" stopColor="#007d79" /></linearGradient>
        <radialGradient id="wcCore" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#d0e2ff" /><stop offset="1" stopColor="#ffffff" /></radialGradient>
      </defs>

      <g className="wc-scene">
        {/* orbits (flowing dotted) */}
        <circle className="wc-orbit wc-flow" cx="300" cy="300" r="120" fill="none" stroke="#c6c6c6" strokeWidth="1.25" strokeDasharray="2 9" />
        <circle className="wc-orbit wc-flow" cx="300" cy="300" r="186" fill="none" stroke="#c6c6c6" strokeWidth="1.25" strokeDasharray="2 11" />
        <circle className="wc-orbit wc-flow" cx="300" cy="300" r="252" fill="none" stroke="#d0d0d0" strokeWidth="1.25" strokeDasharray="2 13" />

        {/* orbiting node groups */}
        <g className="wc-spin-1">
          <Node x={300} y={180} r={8} fill="url(#wcBlue)" halo pulse />
          <Node x={300} y={420} r={5} fill="#007d79" />
        </g>
        <g className="wc-spin-2">
          <Node x={114} y={300} r={6} fill="#8a3ffc" pulse />
          <Node x={486} y={300} r={4} fill="#78a9ff" />
        </g>
        <g className="wc-spin-3">
          <Node x={300} y={48} r={5} fill="#08bdba" />
          <Node x={477} y={477} r={4} fill="#0f62fe" pulse />
          <Node x={123} y={477} r={3} fill="#a6c8ff" />
        </g>

        {/* core */}
        <circle className="wc-corepulse" cx="300" cy="300" r="46" fill="none" stroke="#0f62fe" strokeWidth="1.5" />
        <circle className="wc-corepulse" cx="300" cy="300" r="46" fill="none" stroke="#08bdba" strokeWidth="1.25" />
        <circle cx="300" cy="300" r="40" fill="url(#wcCore)" />
        <g>
          <polygon points="300,272 324,286 324,314 300,328 276,314 276,286" fill="#d9fbfb" stroke="#007d79" strokeWidth="1.5" />
          <g stroke="#007d79" strokeWidth="1.2">
            <line x1="300" y1="300" x2="286" y2="290" /><line x1="300" y1="300" x2="314" y2="290" />
            <line x1="300" y1="300" x2="290" y2="316" /><line x1="300" y1="300" x2="310" y2="316" />
          </g>
          <g fill="#007d79">
            <circle cx="300" cy="300" r="3.2" /><circle cx="286" cy="290" r="2.2" /><circle cx="314" cy="290" r="2.2" />
            <circle cx="290" cy="316" r="2.2" /><circle cx="310" cy="316" r="2.2" />
          </g>
        </g>

        {/* floating mini cards */}
        <Card x={392} y={96} w={120} h={78}>
          <rect x="14" y="46" width="14" height="22" fill="#0f62fe" />
          <rect x="34" y="36" width="14" height="32" fill="#4589ff" />
          <rect x="54" y="52" width="14" height="16" fill="#0f62fe" />
          <rect x="74" y="30" width="14" height="38" fill="#78a9ff" />
          <rect x="94" y="44" width="14" height="24" fill="#0f62fe" />
        </Card>

        {/* accents */}
        <circle className="wc-pulse" cx="430" cy="330" r="4" fill="#0f62fe" />
        <circle className="wc-pulse" cx="180" cy="200" r="3.5" fill="#08bdba" />
      </g>
    </svg>
  );
}

/* Split a string into per-character spans (like the SiPTORY wordmark) so each
   letter can rise in. Spaces use a non-breaking space to keep inline-block width. */
function SplitLine({ text }) {
  return (
    <span className="wc-line">
      {[...text].map((ch, i) => <span className="wc-ch" key={i}>{ch === ' ' ? ' ' : ch}</span>)}
    </span>
  );
}

export default function Welcome({ onNavigate, lang }) {
  const wcRef = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const ctx = gsap.context(() => {
      // heading: per-letter rise, then a one-off primary-blue shine sweep
      const tl = gsap.timeline();
      tl.from('.wc-h1 .wc-ch', { yPercent: 120, duration: 0.7, ease: 'power3.out', stagger: 0.02 });
      tl.fromTo('.wc-gloss', { backgroundPosition: '200% 0' }, { backgroundPosition: '-20% 0', duration: 1, ease: 'power2.inOut' }, '+=0.05');
      gsap.from('.wc-sub', { opacity: 0, y: 8, duration: 0.6, delay: 0.45, ease: 'power2.out' });

      gsap.from('.wc-scene', { opacity: 0, scale: 0.92, svgOrigin: '300 300', duration: 1.1, ease: 'power2.out' });
      gsap.to('.wc-flow', { strokeDashoffset: '-=240', duration: 3.5, repeat: -1, ease: 'none' });
      gsap.to('.wc-spin-1', { rotation: 360, svgOrigin: '300 300', duration: 26, repeat: -1, ease: 'none' });
      gsap.to('.wc-spin-2', { rotation: -360, svgOrigin: '300 300', duration: 38, repeat: -1, ease: 'none' });
      gsap.to('.wc-spin-3', { rotation: 360, svgOrigin: '300 300', duration: 54, repeat: -1, ease: 'none' });
      gsap.fromTo('.wc-corepulse', { scale: 1, opacity: 0.5, svgOrigin: '300 300' }, { scale: 2, opacity: 0, duration: 2.6, repeat: -1, ease: 'power1.out', stagger: 0.9 });
      gsap.to('.wc-float', { y: -10, duration: 3, repeat: -1, yoyo: true, ease: 'sine.inOut', stagger: 0.6 });
      gsap.to('.wc-pulse', { scale: 1.8, opacity: 0.35, transformOrigin: '50% 50%', duration: 1.6, repeat: -1, yoyo: true, ease: 'sine.inOut', stagger: 0.4 });
    }, wcRef);
    return () => ctx.revert();
  }, []);

  const h = new Date().getHours();
  const greetEn = h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
  const greetZh = h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
  const line1 = lang === 'zh' ? `${greetZh}，${CURRENT_USER.firstName}。` : `${greetEn}, ${CURRENT_USER.firstName}.`;

  return (
    <div className="wc" ref={wcRef}>
      <div className="wc-bg" aria-hidden="true"><WelcomeIllustration /></div>
      <div className="wc-hero">
        <div className="wc-hero__text">
          <div className="wc-h1wrap">
            <h1 className="wc-h1"><SplitLine text={line1} /><SplitLine text={tr(lang, 'Welcome to SiPTORY InSight')} /></h1>
            <span className="wc-gloss" aria-hidden="true">{line1}</span>
          </div>
          <p className="wc-sub">{tr(lang, 'What do you want to do today?')}</p>
        </div>
      </div>
      <div className="wc-actions">
        {WELCOME_ACTIONS.map((a) => (
          <ClickableTile key={a.to} className="wc-tile" onClick={() => onNavigate(a.to)}>
            <span className="ic"><Icon name={a.icon} size={24} /></span>
            <h3>{tr(lang, a.title)}</h3>
            <p>{tr(lang, a.desc)}</p>
            <span className="go"><Icon name="arrow--right" size={20} /></span>
          </ClickableTile>
        ))}
      </div>
    </div>
  );
}
