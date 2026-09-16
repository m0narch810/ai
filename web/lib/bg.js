// The character field behind the terminal.
//
// Replaces the old background stack (WebGL torii point-cloud + sakura drift + binary rain +
// slice glitch — three canvases and ~50KB of effect code for decoration). What is left is one
// canvas drawing a single idea: a dormant character grid, most of it blank, a handful of cells
// resolving and dissolving, with a slow vertical wipe that briefly wakes a column. It is the
// same visual language as the data (monospace glyphs on a grid) instead of a competing one.
//
// Cost budget: ~12fps, a few hundred glyph draws per frame, and nothing at all when the tab is
// hidden or the viewer asked for reduced motion.

const GLYPHS = "01█▓▒░+·=─│┼┴┬┤├/\\<>";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function initBackground(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const CELL = 15;
  let cols = 0, rows = 0, dpr = 1;
  let cells = [];        // per-cell { ch, life } — life 0 means blank
  let scan = -0.25;      // wipe position, in rows, normalised 0..1
  let raf = 0, last = 0;
  let ink = "rgba(0,0,0,.06)";

  function palette() {
    const dark = document.documentElement.dataset.theme === "dark";
    ink = dark ? "rgba(242,242,240,.085)" : "rgba(13,13,12,.055)";
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CELL) + 1;
    rows = Math.ceil(h / CELL) + 1;
    cells = new Array(cols * rows).fill(null);
    ctx.font = `12px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = "top";
  }

  /** Light a few random cells; each fades over its own short life. */
  function seed(n) {
    for (let i = 0; i < n; i++) {
      const idx = (Math.random() * cells.length) | 0;
      if (cells[idx]) continue;
      cells[idx] = { ch: GLYPHS[(Math.random() * GLYPHS.length) | 0], life: 0.6 + Math.random() * 2.4, age: 0 };
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.2, (now - last) / 1000);
    if (dt < 1 / 13) return;                 // cap at ~12fps — this is wallpaper
    last = now;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink;

    seed(3);
    scan += dt * 0.055;
    if (scan > 1.3) scan = -0.3;
    const scanRow = scan * rows;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      c.age += dt;
      if (c.age >= c.life) { cells[i] = null; continue; }

      const r = (i / cols) | 0, col = i % cols;
      // triangular fade in/out over the cell's life
      const t = c.age / c.life;
      let a = t < 0.25 ? t / 0.25 : (1 - t) / 0.75;
      // the wipe adds a short brightening band, two rows deep
      const d = Math.abs(r - scanRow);
      if (d < 2) a = Math.min(1, a + (2 - d) * 0.55);

      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillText(c.ch, col * CELL, r * CELL);
    }
    ctx.globalAlpha = 1;
  }

  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function start() {
    if (raf || reduced()) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  /** Static single pass — what reduced-motion viewers and hidden tabs get. */
  function still() {
    stop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < cells.length; i += 1) {
      if (Math.random() > 0.035) continue;
      const r = (i / cols) | 0, col = i % cols;
      ctx.fillText(GLYPHS[(Math.random() * GLYPHS.length) | 0], col * CELL, r * CELL);
    }
    ctx.globalAlpha = 1;
  }

  palette();
  resize();
  reduced() ? still() : start();

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { palette(); resize(); if (reduced()) still(); }, 160);
  });
  document.addEventListener("visibilitychange", () => {
    document.hidden ? stop() : (reduced() ? still() : start());
  });

  return { repaint: () => { palette(); if (reduced()) still(); } };
}
