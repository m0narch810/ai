// The field behind the terminal: a 3D topographic surface, drawn as ridge lines.
//
// A heightfield of fbm noise projected in perspective — far rows compress toward a horizon a
// third of the way down the viewport, near rows spread across the bottom. Each depth row is a
// ridge line drawn back-to-front and filled with the page colour, so nearer terrain hides
// what is behind it (classic hidden-line wireframe). Every fifth ridge is an index ridge in the
// accent, a shade heavier, dotted at its vertices with `·` so the surface keeps the alphabet
// of the data. The terrain scrolls slowly toward the viewer.
//
// Cost: ~40 rows × ~90 columns = a few thousand noise samples and forty paths per frame at
// 12fps. Reduced motion → one still frame; hidden tab → paused.

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

/* ── surface ─────────────────────────────────────────────────────────────── */

export function initBackground(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;

  let dpr = 1, W = 0, H = 0;
  let ROWS = 40, COLS = 90;
  let raf = 0, last = 0, t = 0;

  function palette() {
    return isDark()
      ? { bg: "#06060a", ink: "236,237,243", acc: "169,205,255" }
      : { bg: "#f4f4f7", ink: "15,16,22",    acc: "43,102,204" };
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const small = W < 700;
    ROWS = small ? 30 : 42;
    COLS = small ? 56 : Math.min(120, Math.round(W / 12));
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.2, (now - last) / 1000);
    if (dt < 1 / 12) return;
    last = now;
    t += dt;
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const pal = palette();
    const dark = isDark();

    const horizon = H * 0.30;                 // vanishing line
    const amp = H * 0.16;                     // peak height at the front
    const spread = 1.55;                      // how far the front row overhangs the viewport
    const scroll = t * 0.22;                  // world units per second toward the viewer
    const cx = W / 2;

    ctx.lineJoin = "round";
    ctx.lineWidth = 1;

    for (let i = 0; i < ROWS; i++) {
      const z = i / (ROWS - 1);                            // 0 far → 1 near
      const p = Math.pow(z, 1.55);                         // perspective compression
      const yBase = horizon + (H * 1.08 - horizon) * p;
      const scale = 0.14 + 0.86 * p;                       // lateral scale with depth
      const worldZ = (ROWS - 1 - i) * 0.16 + scroll;       // scroll: far → near
      const index = ((ROWS - 1 - i) % 5) === 0;

      // depth-faded alpha: near ridges are legible, far ones a whisper
      const aLine = (dark ? 0.05 : 0.06) + (dark ? 0.20 : 0.18) * p;
      const aIdx  = (dark ? 0.09 : 0.09) + (dark ? 0.30 : 0.26) * p;

      ctx.beginPath();
      let firstX = 0, lastX = 0;
      const verts = [];
      for (let j = 0; j <= COLS; j++) {
        const u = j / COLS;
        const x = cx + (u - 0.5) * W * spread * scale;
        const e = fbm(u * 3.4 + 0.7, worldZ * 0.55);       // ≈ [-1, 1]
        const y = yBase - (e * 0.5 + 0.5) * amp * scale - amp * 0.15 * scale;
        if (j === 0) { ctx.moveTo(x, y); firstX = x; } else ctx.lineTo(x, y);
        lastX = x;
        verts.push(x, y);
      }
      // close down to the bottom so this ridge hides everything behind it
      ctx.lineTo(lastX, H + 4);
      ctx.lineTo(firstX, H + 4);
      ctx.closePath();
      ctx.fillStyle = pal.bg;
      ctx.fill();

      ctx.strokeStyle = index ? `rgba(${pal.acc},${aIdx.toFixed(3)})` : `rgba(${pal.ink},${aLine.toFixed(3)})`;
      ctx.stroke();

      // ASCII grain: a dot at every third vertex of an index ridge
      if (index && p > 0.08) {
        ctx.fillStyle = `rgba(${pal.acc},${Math.min(0.5, aIdx * 1.4).toFixed(3)})`;
        for (let j = 0; j < verts.length; j += 6) {
          ctx.fillRect(verts[j] - 0.5, verts[j + 1] - 0.5, 1.2, 1.2);
        }
      }
    }

    // fade the top of the surface into the field so the horizon has no hard edge
    const g = ctx.createLinearGradient(0, horizon - 40, 0, horizon + H * 0.22);
    g.addColorStop(0, pal.bg);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon + H * 0.22);
  }

  function start() { if (!raf && !reduced()) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function still() { stop(); draw(); }

  resize();
  reduced() ? still() : start();

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { resize(); if (reduced()) still(); }, 140); });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : (reduced() ? still() : start())));

  return { repaint: () => { if (reduced() || document.hidden) still(); } };
}
