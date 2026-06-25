/* Minimal pointer-drag helper for moving/resizing absolutely
   positioned elements on a canvas. Captures the start pointer and
   streams deltas until pointer-up. */
/* Snap a coordinate to the nearest grid step (matches the 24px canvas grid). */
export const snap = (v, g = 24) => Math.round(v / g) * g;

export function startPointerDrag(e, onDelta, onEnd) {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => onDelta(ev.clientX - sx, ev.clientY - sy);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (onEnd) onEnd();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
