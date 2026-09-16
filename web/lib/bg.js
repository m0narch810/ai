// The field behind the terminal: an ASCII contour map that drifts.
//
// A 2D fbm noise field, sampled once per character cell, drawn as glyphs: cells that sit on
// a contour boundary get a `+`, the high ground between contours gets a density ramp of dots
// and blocks, and everything else stays blank. A slow vertical scan band lifts whatever it
// passes over. The result reads as a topographic map printed in the same alphabet as the data,
// and it moves at a pace that never competes with a number changing.
//
// Cost: glyphs are pre-rendered once per (glyph, tone) to sprite canvases and blitted with
// drawImage; ~6k cells at 12fps with ~35% drawn is a few thousand blits per frame, fine on a
// laptop, and the cell size steps up on small screens. Reduced motion → one still frame;
// hidden tab → paused.

const RAMP = ["·", "∙", ":", "░", "▒", "▓"];   // · ∙ : ░ ▒ ▓
const CONTOUR = "+";

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const isDark = () => document.documentElement.dataset.theme !== "light";

/* ── noise (2D simplex, Ashima) ──────────────────────────────────────────── */
const perm = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
function snoise(x, y) {
  const F2 = 0.3660254037844386, G2 = 0.21132486540518713;
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { const g = G[perm[ii + perm[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { const g = G[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { const g = G[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
  return 70 * n;
}
function fbm(x, y) {
  return 0.55 * snoise(x, y) + 0.3 * snoise(x * 2.1 + 3.7, y * 2.1 - 1.3) + 0.15 * snoise(x * 4.3 - 2.2, y * 4.3 + 5.1);
}

/* ── field ───────────────────────────────────────────────────────────────── */

export function initBackground(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;

  let CW = 11, CH = 15, FONT = 11;
  let cols = 0, rows = 0, dpr = 1;
  let sprites = {};          // `${glyph}|${tone}` → canvas
  let raf = 0, last = 0, t = 0;
  let scan = -0.2;

  function tones() {
    return isDark()
      ? { ink: "rgba(236,237,243,", acc: "rgba(169,205,255," }
      : { ink: "rgba(15,16,22,",    acc: "rgba(43,102,204," };
  }

  /** One sprite per glyph × tone at full alpha; alpha is applied at blit time. */
  function buildSprites() {
    sprites = {};
    const tn = tones();
    for (const [tone, rgb] of Object.entries(tn)) {
      for (const g of [...RAMP, CONTOUR]) {
        const c = document.createElement("canvas");
        c.width = Math.ceil(CW * dpr); c.height = Math.ceil(CH * dpr);
        const cx = c.getContext("2d");
        cx.scale(dpr, dpr);
        cx.font = `${FONT}px "Geist Mono", ui-monospace, monospace`;
        cx.textBaseline = "middle"; cx.textAlign = "center";
        cx.fillStyle = rgb + "1)";
        cx.fillText(g, CW / 2, CH / 2);
        sprites[`${g}|${tone}`] = c;
      }
    }
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    const small = w < 700;
    CW = small ? 13 : 11; CH = small ? 18 : 15; FONT = small ? 12 : 11;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CW) + 1; rows = Math.ceil(h / CH) + 1;
    buildSprites();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.2, (now - last) / 1000);
    if (dt < 1 / 12) return;
    last = now;
    t += dt;
    scan += dt * 0.045; if (scan > 1.25) scan = -0.25;
    draw();
  }

  function draw() {
    const w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    const dark = isDark();
    const baseInk = dark ? 0.07 : 0.09, baseAcc = dark ? 0.14 : 0.16;
    const sx = 0.055, sy = 0.075;          // field scale in cells
    const drift = t * 0.06;
    const scanRow = scan * rows;

    for (let r = 0; r < rows; r++) {
      // calmer toward the bottom of the viewport where the ladders live
      const vfade = 1 - (r / rows) * 0.55;
      const dScan = Math.abs(r - scanRow);
      const lift = dScan < 3 ? (3 - dScan) / 3 : 0;
      const y = r * CH;
      for (let c = 0; c < cols; c++) {
        const n = fbm(c * sx + drift, r * sy - drift * 0.45);          // ≈ [-1, 1]
        const v = (n + 1) * 0.5;
        const band = v * 7;
        const f = band - Math.floor(band);
        let g = null, tone = "ink", a = 0;
        if (f < 0.07 || f > 0.93) {                                     // contour line
          g = CONTOUR; tone = "acc"; a = baseAcc * (0.7 + 0.3 * v);
        } else if (v > 0.6) {                                           // high ground
          const k = Math.min(RAMP.length - 1, Math.floor(((v - 0.6) / 0.4) * RAMP.length));
          g = RAMP[k]; tone = "ink"; a = baseInk * (0.5 + 0.5 * ((v - 0.6) / 0.4));
        } else if (v < 0.22 && ((c * 7 + r * 13) % 5 === 0)) {          // sparse valley dots
          g = RAMP[0]; tone = "ink"; a = baseInk * 0.5;
        }
        if (!g) continue;
        a = Math.min(0.42, (a + lift * 0.12) * vfade);
        ctx.globalAlpha = a;
        ctx.drawImage(sprites[`${g}|${tone}`], c * CW, y, CW, CH);
      }
    }
    ctx.globalAlpha = 1;
  }

  function start() { if (!raf && !reduced()) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function still() { stop(); draw(); }

  resize();
  reduced() ? still() : start();

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { resize(); if (reduced()) still(); }, 140); });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : (reduced() ? still() : start())));

  return { repaint: () => { buildSprites(); if (reduced() || document.hidden) still(); } };
}
