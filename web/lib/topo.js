// TOPO — a surface as terrain, viewed from a 3/4 elevated camera.
//
// Ported from the trifekta site's TopoSurface (YYYmacropad/macropad/src/components/optionsflow),
// itself a port of the panel this repo shipped in July: a data grid Catmull-Rom upsampled to a
// dense display mesh, lambert-shaded, painted back-to-front on a 2D canvas with seam-sealed
// quads, over a floor grid; spot column and markers drawn on top with cartographic halos.
// Drag to rotate, scroll to zoom, double-click to reset, slow auto-turn while idle. Hover reads
// the nearest node into the terminal's shared tooltip (via `data-tip` on the canvas).
//
// Generic: any rows × cols grid. The IV surface hands it expiry rows × strike columns with IV
// as height; a greek surface could hand it tenor rows × strike columns with exposure.
//
// Palette: MONO (graphite → ice → white-ice, the terminal's own language) is the default; the
// HEAT and TURBO ramps from the reference are kept behind the chip for when colour is wanted.

import { el, isNum } from "./util.js";

const DROWS = 28;            // display mesh depth
const DCOLS_MAX = 96;        // display mesh width
const MAX_COLS = 60;         // data columns kept (subsampled above this)
const PAL_KEY = "topo.pal.v1";

const PALETTES = [
  { id: "mono", label: "MONO", mag: true, stops: [
    [0, 44, 46, 62], [0.25, 74, 78, 102], [0.5, 112, 132, 170], [0.75, 169, 205, 255], [1, 236, 244, 255],
  ] },
  { id: "heat", label: "HEAT", mag: true, stops: [
    [0, 45, 7, 64], [0.08, 46, 20, 118], [0.18, 33, 74, 190], [0.3, 32, 130, 205], [0.42, 42, 175, 180], [0.54, 55, 195, 90], [0.66, 170, 218, 50], [0.76, 248, 222, 38], [0.86, 250, 140, 30], [0.94, 240, 45, 25], [1, 200, 10, 20],
  ] },
  { id: "turbo", label: "TURBO", mag: true, stops: [
    [0, 35, 23, 27], [0.087, 75, 79, 208], [0.174, 54, 140, 249], [0.261, 37, 194, 219], [0.348, 51, 234, 165], [0.435, 99, 253, 112], [0.522, 166, 247, 72], [0.609, 227, 217, 49], [0.696, 255, 167, 35], [0.783, 252, 107, 26], [0.87, 206, 50, 13], [0.957, 154, 14, 0], [1, 144, 12, 0],
  ] },
];

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Skip frames while the page scrolls: a canvas repaint under a scroll is pure jank.
let lastScroll = 0;
window.addEventListener("scroll", () => { lastScroll = performance.now(); }, { passive: true, capture: true });
const scrolling = () => performance.now() - lastScroll < 120;

const catmull = (p0, p1, p2, p3, t) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

function resample1d(src, outN) {
  const n = src.length;
  const at = (i) => src[Math.min(n - 1, Math.max(0, i))];
  return Array.from({ length: outN }, (_, o) => {
    const x = (o / (outN - 1)) * (n - 1);
    const i = Math.floor(x), f = x - i;
    return f === 0 ? at(i) : catmull(at(i - 1), at(i), at(i + 1), at(i + 2), f);
  });
}

function upsampleGrid(h, outR, outC) {
  const wide = h.map((row) => resample1d(row, outC));
  const out = Array.from({ length: outR }, () => new Array(outC));
  const col = new Array(h.length);
  for (let c = 0; c < outC; c++) {
    for (let r = 0; r < h.length; r++) col[r] = wide[r][c];
    const sm = resample1d(col, outR);
    for (let r = 0; r < outR; r++) out[r][c] = Math.max(-1.05, Math.min(1.05, sm[r]));
  }
  return out;
}

/** Per-vertex lambert from central-difference normals (light baked in model space). */
function lambertGrid(hd, RR, CC, AMP) {
  const dx = 2 / (CC - 1), dz = 1.2 / (RR - 1);
  const LX = -0.42, LY = 0.84, LZ = -0.36, LN = Math.hypot(LX, LY, LZ);
  const lam = Array.from({ length: RR }, () => new Array(CC));
  for (let r = 0; r < RR; r++) {
    const rl = Math.max(0, r - 1), rh = Math.min(RR - 1, r + 1);
    for (let c = 0; c < CC; c++) {
      const cl = Math.max(0, c - 1), ch = Math.min(CC - 1, c + 1);
      const dhdx = ((hd[r][ch] - hd[r][cl]) * AMP) / ((ch - cl) * dx);
      const dhdz = ((hd[rh][c] - hd[rl][c]) * AMP) / ((rh - rl) * dz);
      const nn = Math.hypot(dhdx, 1, dhdz);
      lam[r][c] = Math.max(0, (-dhdx * LX + LY - dhdz * LZ) / (nn * LN));
    }
  }
  return lam;
}

function rampOf(stops) {
  return (t) => {
    t = Math.min(1, Math.max(0, t));
    let i = 1;
    while (i < stops.length - 1 && stops[i][0] < t) i++;
    const a = stops[i - 1], b = stops[i], f = (t - a[0]) / (b[0] - a[0] || 1);
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
  };
}
const rgbStr = (c, k = 1) => `rgb(${(c[0] * k) | 0},${(c[1] * k) | 0},${(c[2] * k) | 0})`;

function cssVar(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

/**
 * @param {HTMLElement} host
 * @param {object} o
 * @param {number[]}   o.cols        x-axis values, ascending (strikes)
 * @param {number[][]} o.rows        rows[depth][col] raw values; row 0 is nearest the camera
 * @param {string[]}   o.rowLabels
 * @param {number}     [o.spot]      x value of spot
 * @param {{x:number,label:string,tone?:string}[]} [o.marks]
 * @param {"mag"|"signed"} [o.mode]  mag: 0..max → 0..1 height; signed: −max..max → −1..1
 * @param {(v:number)=>string} [o.fmtVal]
 * @param {number} [o.height]
 * @param {string} [o.caption]
 */
export function mountTopo(host, o) {
  if (!host) return null;
  const rows = (o.rows || []).filter((r) => Array.isArray(r) && r.some(isNum));
  let cols = o.cols || [];
  if (rows.length < 2 || cols.length < 5) { host.replaceChildren(el("div.chart-empty", { text: "NO SURFACE" })); return null; }

  // subsample columns
  let keep = cols.map((_, i) => i);
  if (cols.length > MAX_COLS) {
    const step = cols.length / MAX_COLS;
    keep = Array.from({ length: MAX_COLS }, (_, i) => Math.floor(i * step));
  }
  cols = keep.map((i) => cols[i]);
  const raw = rows.map((r) => keep.map((i) => (isNum(r[i]) ? r[i] : 0)));
  const nR = raw.length, nC = cols.length;

  // normalise
  const mode = o.mode || "mag";
  let hn, maxAbs, minV = 0;
  if (mode === "signed") {
    maxAbs = Math.max(1e-9, ...raw.flat().map((v) => Math.abs(v)));
    hn = raw.map((r) => r.map((v) => v / maxAbs));
  } else {
    minV = Math.min(...raw.flat());
    maxAbs = Math.max(1e-9, Math.max(...raw.flat()) - minV);
    hn = raw.map((r) => r.map((v) => (v - minV) / maxAbs));   // 0..1
  }
  const CC = Math.min(DCOLS_MAX, (nC - 1) * 3 + 1), RR = DROWS;
  const AMP = mode === "signed" ? 0.42 : 0.5;
  const hd = upsampleGrid(hn, RR, CC);
  const lam = lambertGrid(hd, RR, CC, AMP);
  const floorY = mode === "signed" ? -AMP * 1.08 : -0.06;
  const fmtVal = o.fmtVal || ((v) => v.toFixed(2));

  // chrome
  let palIdx = 0;
  try { const i = PALETTES.findIndex((p) => p.id === localStorage.getItem(PAL_KEY)); if (i >= 0) palIdx = i; } catch { /* optional */ }
  const canvas = el("canvas.topo-canvas", { "aria-label": "surface" });
  const palBtn = el("button.seg-btn.on", { type: "button", text: PALETTES[palIdx].label, title: "cycle colour scheme" });
  const read = el("span.topo-read");
  const bar = el("div.topo-bar", null, [el("div.seg", null, palBtn), read]);
  const wrap = el("div.topo-wrap", { style: `height:${o.height ?? 340}px` }, canvas);
  host.replaceChildren(bar, wrap);
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!ctx) { host.replaceChildren(el("div.chart-empty", { text: "NO CANVAS" })); return null; }

  let pal = { paper: "#0b0b11", ink2: "#a1a3b0", ink3: "#65677a", acc: "#a9cdff", neg: "#7e8094" };
  const refreshPal = () => {
    pal = { paper: cssVar("--bg-2", pal.paper), ink2: cssVar("--ink2", pal.ink2), ink3: cssVar("--ink3", pal.ink3), acc: cssVar("--acc", pal.acc), neg: cssVar("--neg-2", pal.neg) };
  };
  refreshPal();
  let ramp = rampOf(PALETTES[palIdx].stops);
  const tOf = (v) => (mode === "signed" ? (Math.max(-1, Math.min(1, v)) + 1) / 2 : Math.pow(Math.min(1, Math.max(0, v)), 0.85));

  const view = { yaw: 0.62, pitch: 0.52, zoom: 1, dragUntil: 0 };
  const label = (str, x, y, color) => {
    ctx.strokeStyle = pal.paper; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeText(str, x, y);
    ctx.fillStyle = color; ctx.fillText(str, x, y);
  };
  const makeProject = (W, H) => {
    const { yaw, pitch, zoom } = view;
    const cx = W / 2, cy = H * 0.52;
    const scale = Math.min(W * 0.34, H * 0.58) * zoom, f = 3.8;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    return (x, y, z) => {
      const xr = x * cosY - z * sinY, zr = x * sinY + z * cosY;
      const yr = y * cosP + zr * sinP, z2 = zr * cosP - y * sinP;
      const s = f / (f + z2);
      return { px: cx + xr * s * scale, py: cy - yr * s * scale, z: z2 };
    };
  };
  const X = (c) => (c / (CC - 1)) * 2 - 1;
  const Z = (r) => ((r / (RR - 1)) * 2 - 1) * 0.6;
  const dispC = (c) => (c * (CC - 1)) / (nC - 1);
  const dispR = (r) => (r * (RR - 1)) / (nR - 1);
  let pts = [];
  const mono = `"Geist Mono", ui-monospace, monospace`;

  function draw() {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const proj = makeProject(W, H);

    // project mesh (also feeds hover)
    pts = [];
    const P = [];
    for (let r = 0; r < RR; r++) {
      P.push([]);
      for (let c = 0; c < CC; c++) {
        const p = proj(X(c), hd[r][c] * AMP, Z(r));
        P[r].push(p);
        pts.push({ px: p.px, py: p.py, r: Math.round((r * (nR - 1)) / (RR - 1)), c: Math.round((c * (nC - 1)) / (CC - 1)) });
      }
    }

    // floor grid
    ctx.lineWidth = 0.6; ctx.strokeStyle = pal.ink3; ctx.globalAlpha = 0.35;
    for (let c = 0; c < nC; c += Math.max(1, Math.round(nC / 10))) {
      const a = proj(X(dispC(c)), floorY, Z(0)), b = proj(X(dispC(c)), floorY, Z(RR - 1));
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }
    for (let r = 0; r < nR; r++) {
      const a = proj(X(0), floorY, Z(dispR(r))), b = proj(X(CC - 1), floorY, Z(dispR(r)));
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // quads, back to front, flat-shaded, seam-sealed
    const quads = [];
    for (let r = 0; r < RR - 1; r++) for (let c = 0; c < CC - 1; c++) {
      quads.push({
        r, c,
        z: (P[r][c].z + P[r + 1][c + 1].z) / 2,
        v: (hd[r][c] + hd[r][c + 1] + hd[r + 1][c] + hd[r + 1][c + 1]) / 4,
        shade: 0.62 + 0.38 * ((lam[r][c] + lam[r][c + 1] + lam[r + 1][c] + lam[r + 1][c + 1]) / 4),
      });
    }
    quads.sort((a, b) => b.z - a.z);
    for (const q of quads) {
      const a = P[q.r][q.c], b = P[q.r][q.c + 1], d = P[q.r + 1][q.c + 1], e = P[q.r + 1][q.c];
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.lineTo(d.px, d.py); ctx.lineTo(e.px, e.py); ctx.closePath();
      const fill = rgbStr(ramp(tOf(q.v)), q.shade);
      ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = fill; ctx.lineWidth = 1; ctx.stroke();
    }

    // x axis ticks
    const kMin = cols[0], kMax = cols[nC - 1], span = kMax - kMin || 1;
    const step = span > 240 ? 100 : span > 120 ? 50 : span > 24 ? 10 : span > 12 ? 5 : span > 6 ? 2 : 1;
    ctx.font = `9px ${mono}`; ctx.textAlign = "center";
    for (let k = Math.ceil(kMin / step) * step; k <= kMax; k += step) {
      const c = ((k - kMin) / span) * (CC - 1);
      const p = proj(X(c), floorY, Z(0)), p2 = proj(X(c), floorY - 0.03, Z(0));
      ctx.strokeStyle = pal.ink3; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p2.px, p2.py); ctx.stroke();
      label(String(k), p2.px, p2.py + 10, pal.ink3);
    }
    // row labels, right edge, collision-culled from the far row back
    ctx.textAlign = "left";
    const kept = [];
    const collides = (p) => kept.some((q) => Math.abs(q.py - p.py) < 11 && Math.abs(q.px - p.px) < 58);
    for (let li = nR - 1; li >= 0; li--) {
      const p = proj(X(CC - 1) + 0.06, floorY, Z(dispR(li)));
      if (collides(p)) continue;
      kept.push(p);
      label(o.rowLabels?.[li] ?? "", p.px, p.py, li === 0 ? pal.acc : pal.ink2);
    }
    // spot column
    ctx.textAlign = "center";
    if (isNum(o.spot)) {
      let sc = 0, best = Infinity;
      cols.forEach((k, i) => { const dd = Math.abs(k - o.spot); if (dd < best) { best = dd; sc = i; } });
      const dc = Math.round(dispC(sc));
      const top = P[RR - 1][dc], bot = proj(X(dc), floorY, Z(0));
      ctx.strokeStyle = pal.acc; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(bot.px, bot.py); ctx.lineTo(top.px, top.py - 14); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 9px ${mono}`;
      label(`SPOT ${o.spot.toFixed(1)}`, top.px, top.py - 18, pal.acc);
    }
    // marks
    for (const m of o.marks || []) {
      if (!isNum(m.x)) continue;
      let wc = 0, wb = Infinity;
      cols.forEach((k, i) => { const dd = Math.abs(k - m.x); if (dd < wb) { wb = dd; wc = i; } });
      const dc = Math.round(dispC(wc));
      const top = P[Math.min(RR - 1, Math.round(dispR(m.row ?? 0)))][dc], bot = proj(X(dc), floorY, Z(dispR(m.row ?? 0)));
      const color = m.tone === "hot" ? pal.neg : pal.acc;
      ctx.strokeStyle = color; ctx.lineWidth = 1.1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(bot.px, bot.py); ctx.lineTo(top.px, top.py - 10); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = `600 8.5px ${mono}`;
      label(m.label, top.px, top.py - 14, color);
    }
    // legend
    const lw = 90, lh = 5, lx = 12, ly = H - 18;
    ctx.globalAlpha = 0.85; ctx.fillStyle = pal.paper; ctx.fillRect(lx - 8, ly - 16, lw + 76, 30); ctx.globalAlpha = 1;
    for (let i = 0; i < lw; i++) { ctx.fillStyle = rgbStr(ramp(i / (lw - 1))); ctx.fillRect(lx + i, ly, 1.2, lh); }
    ctx.strokeStyle = pal.ink3; ctx.lineWidth = 0.6; ctx.strokeRect(lx - 0.5, ly - 0.5, lw + 1, lh + 1);
    ctx.fillStyle = pal.ink3; ctx.font = `8.5px ${mono}`; ctx.textAlign = "left";
    ctx.fillText(mode === "signed" ? `−${fmtVal(maxAbs)}` : fmtVal(minV), lx, ly - 4);
    ctx.textAlign = "right";
    ctx.fillText(mode === "signed" ? `+${fmtVal(maxAbs)}` : fmtVal(minV + maxAbs), lx + lw, ly + lh + 11);
  }

  // loop — draws only when the view changed, capped at ~24fps while auto-turning. Every repaint
  // of the owning panel mounts a fresh instance, so this one retires itself the moment its
  // canvas leaves the document (the old build kept every loop alive forever — the board tab
  // accumulated one 60fps terrain per data tick, which is what "laggy" was).
  let raf = 0, visible = true, last = 0, dirty = true, dead = false, mo = null;
  const FRAME_MS = 42;
  const frame = (now) => {
    if (dead) return;
    if (!canvas.isConnected) { destroy(); return; }
    raf = requestAnimationFrame(frame);
    if (document.hidden || !visible || scrolling()) return;
    if (!reduced() && now > view.dragUntil) { if (now - last < FRAME_MS) return; view.yaw += 0.0026 * 2.5; dirty = true; }
    if (!dirty) return;
    dirty = false; last = now;
    draw();
  };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) dirty = true; }, { threshold: 0 });
  io.observe(wrap);
  raf = requestAnimationFrame(frame);
  const destroy = () => { dead = true; cancelAnimationFrame(raf); io.disconnect(); mo?.disconnect(); };

  // interaction
  let dragging = false, lx = 0, ly = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
  const up = () => { dragging = false; view.dragUntil = performance.now() + 6000; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      view.yaw += (e.clientX - lx) * 0.006;
      view.pitch = Math.max(-0.35, Math.min(1.4, view.pitch + (e.clientY - ly) * 0.004));
      lx = e.clientX; ly = e.clientY;
      view.dragUntil = performance.now() + 6000;
      dirty = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let bp = null, bd = 22 * 22;
    for (const p of pts) { const dd = (p.px - mx) ** 2 + (p.py - my) ** 2; if (dd < bd) { bd = dd; bp = p; } }
    if (bp) {
      const v = raw[bp.r][bp.c];
      const text = `${o.rowLabels?.[bp.r] ?? ""}\n${o.colLabel ? o.colLabel(cols[bp.c]) : cols[bp.c]}\nvalue: ${fmtVal(v)}`;
      read.textContent = text.replace(/\n/g, " · ");
      canvas.setAttribute("data-tip", text);
    } else { read.textContent = ""; canvas.removeAttribute("data-tip"); }
  });
  canvas.addEventListener("pointerleave", () => { read.textContent = ""; canvas.removeAttribute("data-tip"); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.zoom = Math.max(0.5, Math.min(2.5, view.zoom * (1 - Math.sign(e.deltaY) * 0.08)));
    view.dragUntil = performance.now() + 6000;
    dirty = true;
  }, { passive: false });
  canvas.addEventListener("dblclick", () => { view.yaw = 0.62; view.pitch = 0.52; view.zoom = 1; view.dragUntil = performance.now() + 6000; dirty = true; });
  palBtn.addEventListener("click", () => {
    palIdx = (palIdx + 1) % PALETTES.length;
    ramp = rampOf(PALETTES[palIdx].stops);
    palBtn.textContent = PALETTES[palIdx].label;
    try { localStorage.setItem(PAL_KEY, PALETTES[palIdx].id); } catch { /* optional */ }
    dirty = true;
  });
  mo = new MutationObserver(() => { refreshPal(); dirty = true; });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  if (reduced()) draw();
  return { destroy };
}
