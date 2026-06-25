/* SiPTORY InSight wordmark with the entrance animation from the
   login design: each letter rises in, then the InSight badge wipes
   in with a one-off shine. Reused on the login screen and sidebar. */
const WORD = 'SiPTORY';

export default function AnimatedLogo({ size = 'sm', animate = true, className = '' }) {
  return (
    <span className={`ip-logo ip-logo--${size} ${animate ? 'is-anim' : ''} ${className}`}>
      <span className="word">
        {WORD.split('').map((c, i) => (
          <span className="ch" key={i} style={animate ? { animationDelay: `${0.05 * (i + 1)}s` } : undefined}>{c}</span>
        ))}
      </span>
      <span className="badge">InSight</span>
    </span>
  );
}
