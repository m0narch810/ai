// The field behind the terminal: an ASCII topographic contour map that drifts.
//
// Ported from the trifekta site's `AsciiContour` (YYYmacropad/macropad/src/components/fx),
// which is the look the user asked for. A slowly drifting elevation field (layered rotated
// sines — cheap, smooth, no noise table) is sliced into contour bands; a character is drawn
// only where a band boundary passes, so the output reads as a topo map drawn in type. Each
// contour LEVEL gets its own glyph, from `·` at the lowest to `%` at the highest, and the line
// width is normalised by the local gradient (canvas fwidth) so contours stay ~one cell wide on
// flat ground instead of smearing into blobs. Monochrome ink at subliminal opacity, ~10fps,
// vignetted to the page colour at the edges by `.bg-vignette` in index.html.
//
// COST (v3.8): the first port called `elevation()` three times per cell and `fillText` once per
// lit cell — ~40k sine evaluations and several thousand text draws per frame, which on a school
// laptop was most of the page's idle CPU. Now the elevation field is sampled ONCE per frame into
// a typed grid (the gradient reads neighbours from it), every glyph × level × alpha step is
// pre-rendered to a sprite sheet and blitted with drawImage, the canvas renders at 1× (it is a
// subliminal texture, not text), and frames are skipped while the page scrolls.

const LEVEL_GLYPHS = ["·", ":", "-", "=", "+", "*", "─", "#", "%"];
const ALPHA_STEPS = 10;

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

export function initBackground(canvas, { cell = 12, levels = 8, lineWidth = 0.09, maxAlpha = 0.42, spread = 0.72, speed = 0.7 } = {}) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  let W = 0, H = 0, cols = 0, rows = 0;
  let field = new Float32Array(0);

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W; canvas.height = H;      // 1× on purpose — see the header note
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    cols = Math.ceil(W / cell) + 2;
    rows = Math.ceil(H / cell) + 2;
    field = new Float32Array(cols * rows);
  }

  // Two tones, mixed by contour level: graphite in the valleys rising to the ice accent on the
  // peaks — the same LIT / GRAPHITE language the data uses, so the field reads as part of the
  // instrument instead of a white texture behind it.
  function tones() {
    return isDark()
      ? { lo: [156, 158, 178], hi: [169, 205, 255] }
      : { lo: [124, 126, 140], hi: [43, 102, 204] };
  }

  // Sprite sheet: one glyph per level, at ALPHA_STEPS opacities. Rebuilt on theme change only.
  let sheet = null;
  const SW = cell, SH = cell;
  function buildSheet() {
    const { lo, hi } = tones();
    sheet = document.createElement("canvas");
    sheet.width = SW * levels;
    sheet.height = SH * ALPHA_STEPS;
    const sc = sheet.getContext("2d");
    sc.font = `${Math.round(cell * 0.78)}px "Geist Mono", ui-monospace, monospace`;
    sc.textBaseline = "middle";
    sc.textAlign = "center";
    for (let i = 0; i < levels; i++) {
      const t = Math.pow(i / Math.max(1, levels - 1), 1.4);
      const rgb = lo.map((c, k) => Math.round(c + (hi[k] - c) * t)).join(",");
      const glyph = LEVEL_GLYPHS[Math.min(LEVEL_GLYPHS.length - 1, i)];
      for (let a = 0; a < ALPHA_STEPS; a++) {
        const alpha = ((a + 1) / ALPHA_STEPS) * maxAlpha;
        sc.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
        sc.fillText(glyph, i * SW + SW / 2, a * SH + SH / 2);
      }
    }
  }

  function draw(t0) {
    const t = t0 * speed;
    if (!sheet) buildSheet();
    ctx.clearRect(0, 0, W, H);
    // 1. sample the field once
    for (let gy = 0; gy < rows; gy++) {
      const row = gy * cols;
      for (let gx = 0; gx < cols; gx++) field[row + gx] = elevation(gx * spread, gy * spread, t);
    }
    // 2. contour test per cell, gradient from the cached neighbours
    const lw = lineWidth * 10;
    for (let gy = 0; gy < rows - 1; gy++) {
      const row = gy * cols;
      const vfade = 1 - (gy / rows) * 0.3;              // quieter toward the ladders at the bottom
      for (let gx = 0; gx < cols - 1; gx++) {
        const e = field[row + gx];
        const band = e * levels;
        const f = band - Math.floor(band);
        const distToLine = f < 1 - f ? f : 1 - f;
        const gxe = field[row + gx + 1] - e;
        const gye = field[row + cols + gx] - e;
        const grad = Math.hypot(gxe, gye) * levels;
        const cells = distToLine / (grad > 0.02 ? grad : 0.02);
        if (cells > lw) continue;
        const level = Math.floor(band) % levels;
        const edge = 1 - cells / lw;                     // 1 at line centre, 0 at edge
        const a = (0.3 + 0.7 * e) * edge * vfade;        // 0..1 of maxAlpha
        const step = Math.round(a * ALPHA_STEPS) - 1;
        if (step < 0) continue;
        ctx.drawImage(sheet, level * SW, step * SH, SW, SH, gx * cell - SW / 2, gy * cell - SH / 2, SW, SH);
      }
    }
  }

  let raf = 0, last = 0, running = false, lastScroll = 0;
  const FRAME_MS = 100;
  const step = (ms) => {
    raf = requestAnimationFrame(step);
    if (ms - last < FRAME_MS) return;
    if (ms - lastScroll < 150) return;                 // never fight a scroll for the main thread
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
  window.addEventListener("scroll", () => { lastScroll = performance.now(); }, { passive: true });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : (reduced() ? still() : start())));

  return { repaint: () => { sheet = null; if (reduced() || document.hidden) still(); } };
}
