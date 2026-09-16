// The field behind the terminal: an ASCII topographic contour map that drifts.
//
// Ported from the trifekta site's `AsciiContour` (YYYmacropad/macropad/src/components/fx),
// which is the look the user asked for. A slowly drifting elevation field (layered rotated
// sines — cheap, smooth, no noise table) is sliced into contour bands; a character is drawn
// only where a band boundary passes, so the output reads as a topo map drawn in type. Each
// contour LEVEL gets its own glyph, from `·` at the lowest to `%` at the highest, and the line
// width is normalised by the local gradient (canvas fwidth) so contours stay ~one cell wide on
// flat ground instead of smearing into blobs. Monochrome ink at subliminal opacity, ~12fps,
// vignetted to the page colour at the edges by `.bg-vignette` in index.html.

const LEVEL_GLYPHS = ["·", ":", "-", "=", "+", "*", "─", "#", "%"];

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const isDark = () => document.documentElement.dataset.theme !== "light";

/** Cheap smooth pseudo-noise: layered rotated sines, range ~0..1. */
function elevation(x, y, t) {
  const n =
    Math.sin(x * 0.045 + t * 0.21) * 0.9 +
    Math.sin(y * 0.062 - t * 0.13) * 0.7 +
    Math.sin((x * 0.7 + y) * 0.038 + t * 0.09) * 0.8 +
    Math.sin((x - y * 0.6) * 0.031 - t * 0.06) * 0.6 +
    Math.sin(Math.hypot(x * 0.9, y * 1.1) * 0.05 + t * 0.11) * 0.5;
  return (n + 3.5) / 7;
}

export function initBackground(canvas, { cell = 14, levels = 9, lineWidth = 0.09, maxAlpha = 0.5 } = {}) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  let W = 0, H = 0;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function ink() {
    return isDark() ? "236,237,243" : "15,16,22";
  }

  function draw(t) {
    const rgb = ink();
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${Math.round(cell * 0.78)}px "Geist Mono", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    const cols = Math.ceil(W / cell);
    const rows = Math.ceil(H / cell);
    for (let gy = 0; gy <= rows; gy++) {
      for (let gx = 0; gx <= cols; gx++) {
        const e = elevation(gx, gy, t);
        const band = e * levels;
        const f = band - Math.floor(band);
        const distToLine = Math.min(f, 1 - f);
        // Normalise by the local gradient so contour lines stay ~1 cell wide even where the
        // terrain is nearly flat — flat regions render as crisp lines instead of wide blobs.
        const gxe = elevation(gx + 1, gy, t) - e;
        const gye = elevation(gx, gy + 1, t) - e;
        const grad = Math.hypot(gxe, gye) * levels;
        const cells = distToLine / Math.max(grad, 0.02);
        if (cells > lineWidth * 10) continue;
        const level = Math.max(0, Math.min(LEVEL_GLYPHS.length - 1, Math.floor(band) % LEVEL_GLYPHS.length));
        const edge = 1 - cells / (lineWidth * 10);        // 1 at line centre, 0 at edge
        const a = (0.3 + 0.7 * e) * edge * maxAlpha;
        if (a < 0.015) continue;
        ctx.fillStyle = `rgba(${rgb}, ${a.toFixed(3)})`;
        ctx.fillText(LEVEL_GLYPHS[level], gx * cell, gy * cell);
      }
    }
  }

  let raf = 0, last = 0, running = false;
  const FRAME_MS = 83;
  const step = (ms) => {
    raf = requestAnimationFrame(step);
    if (ms - last < FRAME_MS) return;
    last = ms;
    draw(ms / 1000);
  };
  const start = () => { if (running || reduced()) return; running = true; raf = requestAnimationFrame(step); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  const still = () => { stop(); draw(performance.now() / 1000); };

  resize();
  reduced() ? still() : start();

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { resize(); if (reduced()) still(); }, 120); });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : (reduced() ? still() : start())));

  return { repaint: () => { if (reduced() || document.hidden) still(); } };
}
