// A short burst of confetti in the brand's pinks, falling under gravity and gone in under two seconds: the first-run
// demo's moment of success (content/demo-coach.ts, setup/setup.ts) and a key that works (setup and settings pages). Nothing at all with reduced motion.

const COLORS = ['#f472b6', '#db2777', '#be185d', '#fbcfe8', '#fde68a'];
const LIFE_MS = 1800;

/** Bursts from (x, y), in CSS pixels, upward and outward, on a canvas covering the viewport; removes the canvas when
 *  done unless `keep`. */
export function confettiBurst(canvas: HTMLCanvasElement, x: number, y: number, keep = false): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { if (!keep) canvas.remove(); return; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.hidden = false;
  const ctx = canvas.getContext('2d');
  if (!ctx) { if (!keep) canvas.remove(); return; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bits = Array.from({ length: 90 }, () => {
    const a = Math.PI * (0.15 + Math.random() * 0.7), v = 6 + Math.random() * 8;
    return { x, y, vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1), vy: -Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, c: COLORS[Math.floor(Math.random() * COLORS.length)]! };
  });
  const t0 = performance.now();
  const frame = (t: number) => {
    const age = t - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalAlpha = Math.max(0, 1 - age / LIFE_MS);
    for (const b of bits) {
      b.vy += 0.28; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
    if (age < LIFE_MS) requestAnimationFrame(frame);
    else if (keep) { ctx.clearRect(0, 0, innerWidth, innerHeight); canvas.hidden = true; } else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** A burst from the middle of `from`, on a canvas of its own over the page, gone once it falls. */
export function celebrate(from: HTMLElement): void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647';
  document.body.append(canvas);
  const r = from.getBoundingClientRect();
  confettiBurst(canvas, r.left + r.width / 2, r.top);
}
