import { useEffect, useRef } from 'react';
import Icon from '../components/Icon.jsx';
import AnimatedLogo from '../components/AnimatedLogo.jsx';
import '../styles/login.css';

const FEATURES = [
  { icon: 'dashboard', t: 'Self-service analytics', d: 'Drag-and-drop dashboards on governed data.' },
  { icon: 'data--base', t: 'Governed metrics store', d: 'One certified definition for every KPI.' },
  { icon: 'interactions', t: 'End-to-end lineage', d: 'Trace any field across every layer.' },
  { icon: 'chart--bar', t: 'Real-time pipeline ops', d: 'Live ETL status, SLAs, and recovery.' },
];

/* Canvas "data lifecycle" → wall: particles flow left→right maturing in
   colour (raw→violet→blue→teal) toward the form's left boundary (the wall),
   where they SHATTER into dispersing shards. The wall is an elastic spring
   divider that bends on impact and ripples. Clean zone right of the wall is
   left untouched. */
function useNetworkCanvas(ref, rootRef) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const root = rootRef.current || document;
    const wallEl = root.querySelector('.lg-wall');
    const logoEl = root.querySelector('.lg-card__brand');
    const legalEl = root.querySelector('.lg-legal');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0, H = 0, wallPx = 0, bandTop = 0, bandH = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let lanes = [], parts = [], shards = [], pts = [], wallTmpL = [], wallTmpR = [];
    let raf = 0;
    const mouse = { x: -9999, y: -9999, px: 0, py: 0 };

    const STOPS = [
      { t: 0.0, c: [150, 152, 162] },
      { t: 0.36, c: [124, 99, 246] },
      { t: 0.64, c: [69, 137, 255] },
      { t: 1.0, c: [8, 189, 186] },
    ];
    const tint = (t) => {
      let a = STOPS[0], b = STOPS[STOPS.length - 1];
      for (let i = 0; i < STOPS.length - 1; i++) {
        if (t >= STOPS[i].t && t <= STOPS[i + 1].t) { a = STOPS[i]; b = STOPS[i + 1]; break; }
      }
      const k = (t - a.t) / ((b.t - a.t) || 1);
      return [a.c[0] + (b.c[0] - a.c[0]) * k, a.c[1] + (b.c[1] - a.c[1]) * k, a.c[2] + (b.c[2] - a.c[2]) * k];
    };
    const rgba = (c, al) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;

    const build = () => {
      const L = Math.max(4, Math.min(7, Math.round(H / 120)));
      lanes = [];
      for (let i = 0; i < L; i++) {
        lanes.push({ base: (i + 0.5) / L, amp: 0.03 + Math.random() * 0.045, ph: Math.random() * 6.28, ph2: Math.random() * 6.28, sp: 0.4 + Math.random() * 0.5, z: 0.5 + Math.random() * 0.5 });
      }
      parts = [];
      const per = Math.max(6, Math.round(wallPx / 130));
      for (const ln of lanes) {
        for (let i = 0; i < per; i++) parts.push({ lane: ln, t: Math.random(), v: 0.00006 + Math.random() * 0.00005, size: 1.0 + Math.random() * 1.2 });
      }
    };
    // elastic divider modelled as a vertical chain of spring points
    const buildWall = () => {
      const seg = Math.max(20, Math.round(bandH / 9));
      pts = [];
      for (let i = 0; i <= seg; i++) pts.push({ y: bandTop + (i / seg) * bandH, disp: 0, vel: 0 });
      wallTmpL = new Array(pts.length).fill(0);
      wallTmpR = new Array(pts.length).fill(0);
    };
    const kickWall = (y, force) => {
      if (!pts.length) return;
      const seg = pts.length - 1;
      const idx = Math.max(0, Math.min(seg, Math.round(((y - bandTop) / bandH) * seg)));
      pts[idx].vel += force;
      if (pts[idx - 1]) pts[idx - 1].vel += force * 0.5;
      if (pts[idx + 1]) pts[idx + 1].vel += force * 0.5;
    };
    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const r = wallEl ? wallEl.getBoundingClientRect().left : W * 0.58;
      wallPx = (r && r > 80) ? r : W * 0.58;
      const lr = logoEl ? logoEl.getBoundingClientRect() : null;
      const gr = legalEl ? legalEl.getBoundingClientRect() : null;
      const over = 26;
      bandTop = ((lr && lr.height) ? lr.top : H * 0.16) - over;
      const bandBottom = ((gr && gr.height) ? gr.bottom : H * 0.84) + over;
      bandH = Math.max(120, bandBottom - bandTop);
      build();
      buildWall();
    };
    const laneX = (ln, t) => t * wallPx + mouse.px * (0.3 + ln.z);
    const laneY = (ln, t, time) => {
      const base = bandTop + ln.base * bandH, a = ln.amp * bandH;
      return base
        + Math.sin(t * Math.PI * 1.5 + ln.ph + time * 0.00013 * ln.sp) * a
        + Math.sin(t * Math.PI * 2.7 + ln.ph2) * (a * 0.3)
        + mouse.py * (0.3 + ln.z);
    };
    const env = (t) => { const fin = 0.12; return t < fin ? t / fin : 1; };

    const shatter = (y, c, z) => {
      const n = 7 + ((Math.random() * 5) | 0);
      for (let i = 0; i < n; i++) {
        const ang = Math.PI + (Math.random() * 1.5 - 0.75);
        const sp = 0.5 + Math.random() * 1.9;
        shards.push({ x: wallPx, y, vx: Math.cos(ang) * sp, vy: (Math.random() * 2 - 1) * 1.7,
          life: 1, decay: 0.0009 + Math.random() * 0.0007, size: 0.7 + Math.random() * 1.5, c, z });
      }
      kickWall(y, 2.5 + Math.random() * 1.5);
      if (shards.length > 420) shards.splice(0, shards.length - 420);
    };

    let last = performance.now();
    const step = (now) => {
      now = now || performance.now();
      const dt = Math.min(40, now - last); last = now;
      ctx.clearRect(0, 0, W, H);

      const tx = mouse.x < 0 ? 0 : ((mouse.x - W / 2) / W) * 18;
      const ty = mouse.x < 0 ? 0 : ((mouse.y - H / 2) / H) * 18;
      mouse.px += (tx - mouse.px) * 0.05; mouse.py += (ty - mouse.py) * 0.05;

      // quiet maturation channels (only up to the wall)
      ctx.lineWidth = 1;
      for (const ln of lanes) {
        ctx.beginPath();
        for (let s = 0; s <= 30; s++) {
          const t = s / 30;
          if (s) ctx.lineTo(laneX(ln, t), laneY(ln, t, now)); else ctx.moveTo(laneX(ln, t), laneY(ln, t, now));
        }
        ctx.strokeStyle = 'rgba(125,138,170,0.045)'; ctx.stroke();
      }

      // elastic divider: a spring line that bends at the impact point and ripples
      if (pts.length) {
        const f = dt / 16.67, n = pts.length, TENS = 0.015, DAMP = 0.91, SPREAD = 0.10;
        for (const p of pts) {
          p.vel += (-TENS * p.disp) * f;
          p.vel *= Math.pow(DAMP, f);
          p.disp += p.vel * f;
          if (p.disp > 16) { p.disp = 16; p.vel *= -0.3; }
          else if (p.disp < -16) { p.disp = -16; p.vel *= -0.3; }
        }
        const lD = wallTmpL, rD = wallTmpR;
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < n; i++) {
            if (i > 0) { lD[i] = SPREAD * (pts[i].disp - pts[i - 1].disp); pts[i - 1].vel += lD[i] * f; }
            if (i < n - 1) { rD[i] = SPREAD * (pts[i].disp - pts[i + 1].disp); pts[i + 1].vel += rD[i] * f; }
          }
          for (let i = 0; i < n; i++) {
            if (i > 0) pts[i - 1].disp += lD[i] * f;
            if (i < n - 1) pts[i + 1].disp += rD[i] * f;
          }
        }
        const grad = ctx.createLinearGradient(0, bandTop, 0, bandTop + bandH);
        grad.addColorStop(0, 'rgba(15,98,254,0)');
        grad.addColorStop(0.09, 'rgba(15,98,254,0.6)');
        grad.addColorStop(0.91, 'rgba(8,189,186,0.62)');
        grad.addColorStop(1, 'rgba(8,189,186,0)');
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 1; ctx.lineWidth = 1.6;
        ctx.strokeStyle = grad;
        ctx.beginPath();
        for (let i = 0; i < n; i++) { const x = wallPx + pts[i].disp, y = pts[i].y; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
        ctx.stroke();
      }

      // dispersing shards
      ctx.lineCap = 'round';
      for (let i = shards.length - 1; i >= 0; i--) {
        const s = shards[i];
        s.x += s.vx * dt * 0.06; s.y += s.vy * dt * 0.06;
        s.vx *= 0.95; s.vy = s.vy * 0.96 + 0.006 * dt * 0.04;
        s.life -= s.decay * dt;
        if (s.life <= 0) { shards.splice(i, 1); continue; }
        const depth = 0.42 + 0.5 * s.z;
        ctx.fillStyle = rgba(s.c, (s.life * 0.8 * depth).toFixed(3));
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size * (0.5 + s.life * 0.6), 0, 6.283); ctx.fill();
      }

      // flowing data → shatter at the wall
      for (const p of parts) {
        p.t += p.v * dt;
        const z = p.lane.z;
        if (p.t >= 1) { shatter(laneY(p.lane, 1, now), tint(1), z); p.t -= 1; }
        const x = laneX(p.lane, p.t), y = laneY(p.lane, p.t, now);
        const c = tint(p.t), e = env(p.t), depth = 0.42 + 0.5 * z;
        const tb = Math.max(0, p.t - 0.014);
        ctx.strokeStyle = rgba(c, (0.5 * e * depth).toFixed(3));
        ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(laneX(p.lane, tb), laneY(p.lane, tb, now)); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = rgba(c, (0.85 * e * depth).toFixed(3));
        ctx.beginPath(); ctx.arc(x, y, p.size * 1.1, 0, 6.283); ctx.fill();
      }

      if (!reduce) raf = requestAnimationFrame(step);
    };
    const onMove = (e) => { mouse.x = e.clientX; mouse.y = e.clientY; };
    const onLeave = () => { mouse.x = -9999; mouse.y = -9999; };
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    resize();
    if (reduce) step(); else raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, [ref, rootRef]);
}

export default function Login({ onLogin }) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const pwRef = useRef(null);
  useNetworkCanvas(canvasRef, rootRef);

  const submit = (e) => { e.preventDefault(); onLogin && onLogin(); };
  const togglePw = () => { const p = pwRef.current; if (p) p.type = p.type === 'password' ? 'text' : 'password'; };

  return (
    <div className="lg-root" ref={rootRef}>
      <canvas id="lg-net" className="lg-net" ref={canvasRef} aria-hidden="true" />
      <div className="lg-wall" aria-hidden="true" />
      <div className="lg-wash" aria-hidden="true" />

      <div className="lg-topright">New to the platform? <a href="#" onClick={(e) => e.preventDefault()}>Request access</a></div>

      <main className="lg-stage">
        <section className="lg-hero">
          <span className="lg-kicker">Supercharged by IT Fabric Portfolio</span>
          <h1>One connected fabric<br />for every <span className="accent">data asset.</span></h1>
          <p>From RAW to Gold — model, govern, analyze, and operate your entire data estate in a single platform.</p>
          <div className="lg-feats">
            {FEATURES.map((f) => (
              <div className="lg-feat" key={f.t}>
                <span className="ic"><Icon name={f.icon} size={20} /></span>
                <div><div className="t">{f.t}</div><div className="d">{f.d}</div></div>
              </div>
            ))}
          </div>
        </section>

        <section className="lg-auth">
          <form className="lg-card" onSubmit={submit}>
            <div className="lg-card__brand"><AnimatedLogo size="lg" /></div>
            <h2>Welcome back</h2>
            <p className="sub">Sign in to your workspace to continue.</p>

            <div className="lg-fld">
              <label htmlFor="lg-email">Email</label>
              <div className="lg-ctrl"><input id="lg-email" type="email" defaultValue="lmarsh@ipas" placeholder="you@company.com" /></div>
            </div>
            <div className="lg-fld">
              <label htmlFor="lg-pw">Password</label>
              <div className="lg-ctrl">
                <input id="lg-pw" ref={pwRef} type="password" defaultValue="supersecret" placeholder="Enter your password" />
                <button type="button" className="lg-reveal" aria-label="Show password" onClick={togglePw}><Icon name="view" size={18} /></button>
              </div>
            </div>

            <div className="lg-row">
              <label className="lg-chk"><input type="checkbox" /> Keep me signed in</label>
              <a className="lg-link" href="#" onClick={(e) => e.preventDefault()}>Forgot password?</a>
            </div>

            <button type="submit" className="lg-submit">Sign in<Icon name="arrow--right" size={18} /></button>

            <div className="lg-or">or</div>
            <button type="button" className="lg-sso" onClick={() => onLogin && onLogin()}>
              <Icon name="locked" size={16} />Continue with SiPTORY ZTNA
            </button>

            <p className="lg-legal">© 2026 SiPTORY · Lakehouse Data Platform — IT In-house Product Portfolio</p>
          </form>
        </section>
      </main>
    </div>
  );
}
