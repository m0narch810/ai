// Chart primitives. Everything is hand-built SVG/canvas — no chart library.
//
// Why no library: this terminal draws one shape over and over (a strike ladder with a centre
// spine) at six different scales, and every chart has to survive a theme flip and a phone
// width. A 60KB general-purpose library gets in the way of both. Each renderer here measures
// its host, draws at real pixel size (so text is never scaled and never blurs) and repaints
// on resize.

import { svg, el, isNum, clamp, maxAbs, strikeLabel, compact } from "./util.js";

/* ── mount ───────────────────────────────────────────────────────────────── */

const RO = new WeakMap();

/**
 * Draw into `host` at its measured size, and redraw whenever that size changes.
 * `render({ w, h })` must return an SVG (or any Node) — it replaces whatever was there.
 */
function mount(host, render) {
  if (!host) return;
  const paint = () => {
    const w = Math.max(160, Math.round(host.clientWidth || 0));
    if (!w) return;
    let node = null;
    try { node = render({ w }); } catch (e) { node = errNode(String(e?.message ?? e)); }
    host.replaceChildren(node || errNode("no data"));
  };
  host._paint = paint;

  let ro = RO.get(host);
  if (!ro) {
    let last = -1;
    ro = new ResizeObserver(() => {
      const w = Math.round(host.clientWidth || 0);
      if (w && Math.abs(w - last) > 2) { last = w; host._paint?.(); }
    });
    ro.observe(host);
    RO.set(host, ro);
  }
  paint();
}

function errNode(msg) {
  return el("div.chart-empty", { text: msg });
}

export function emptyPanel(host, msg = "NO DATA") {
  if (host) host.replaceChildren(el("div.chart-empty", { text: msg }));
}

/* ── shared scales ───────────────────────────────────────────────────────── */

/**
 * A bar length that stays readable when one strike dwarfs every other. Raw linear scaling
 * against the max turns a 40-row ladder into one long bar and 39 slivers, which is the single
 * most common way a positioning chart lies about structure. The 0.62 power keeps ordering
 * intact while giving the mid-field visible length.
 */
const SHAPE = 0.62;
const shape = (frac) => Math.pow(clamp(Math.abs(frac), 0, 1), SHAPE);

/** Sign → the two-colour data coding used everywhere: cool = positive, hot = negative. */
const signClass = (v) => (!isNum(v) || v === 0 ? "z" : v > 0 ? "p" : "n");

/* ── SPINE: the per-strike ladder ────────────────────────────────────────── */

/**
 * The house chart. One row per strike; puts grow left of a centre spine, calls grow right,
 * and the bar's colour is the SIGN of that side's exposure (not which side it is) so a
 * positive put charm reads as positive rather than as "put-ish".
 *
 * @param {HTMLElement} host
 * @param {object}  o
 * @param {Array}   o.rows      [{strike, put, call, net}]
 * @param {number}  o.spot
 * @param {number} [o.maxRows]  window size around spot (default 32)
 * @param {(n:number)=>string} [o.fmtVal]
 * @param {Set<number>} [o.marks] strikes to flag (walls, board levels)
 * @param {string} [o.unit]     printed in the header
 */
export function spine(host, o) {
  const rows = (o.rows || []).filter((r) => isNum(r?.strike));
  if (!rows.length) return emptyPanel(host);

  const spot = isNum(o.spot) ? o.spot : rows[Math.floor(rows.length / 2)].strike;
  const fmtVal = o.fmtVal || ((n) => compact(n, 1));
  const marks = o.marks || new Set();

  // Window the ladder to the strikes that can actually trade today. A 112-strike chain drawn
  // in full makes the near-money rows 6px tall and unreadable.
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  // Rendered high-strike-first, the way a chain is read.
  const window_ = windowAround(sorted, spot, o.maxRows ?? 32).reverse();
  const scaleMax = maxAbs(window_.flatMap((r) => [r.put, r.call]));

  mount(host, ({ w }) => {
    const ROW = w < 520 ? 15 : 17;
    const PAD_T = 20, PAD_B = 8;
    const colStrike = w < 520 ? 40 : 46;
    const colVal    = w < 420 ? 0 : (w < 620 ? 46 : 56);
    const colNet    = w < 520 ? 0 : 60;
    const gut = 8;

    const barL = colStrike + gut + colVal;
    const barR = w - colNet - (colNet ? gut : 0) - colVal - (colVal ? gut : 0);
    const barW = Math.max(60, barR - barL);
    const mid  = barL + barW / 2;
    const half = barW / 2 - 1;

    const h = PAD_T + window_.length * ROW + PAD_B;
    const root = svg("svg", { class: "spine", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img" });

    // header strip
    root.append(svg("text", { class: "sp-hd", x: colStrike, y: 11, "text-anchor": "end", text: "STRIKE" }));
    root.append(svg("text", { class: "sp-hd", x: mid - half, y: 11, text: "◀ PUT" }));
    root.append(svg("text", { class: "sp-hd", x: mid + half, y: 11, "text-anchor": "end", text: "CALL ▶" }));
    if (colNet) root.append(svg("text", { class: "sp-hd", x: w, y: 11, "text-anchor": "end", text: o.unit ? `NET ${o.unit}` : "NET" }));

    // spine + frame
    root.append(svg("line", { class: "sp-spine", x1: mid, y1: PAD_T - 4, x2: mid, y2: h - PAD_B + 2 }));
    root.append(svg("line", { class: "sp-rule", x1: 0, y1: PAD_T - 4, x2: w, y2: PAD_T - 4 }));

    // quarter gridlines — give the eye a magnitude reference without a full axis
    for (const q of [0.5, 1]) {
      for (const s of [-1, 1]) {
        const x = mid + s * half * q;
        root.append(svg("line", { class: "sp-grid", x1: x, y1: PAD_T - 2, x2: x, y2: h - PAD_B }));
      }
    }

    let spotDrawn = false;
    window_.forEach((r, i) => {
      const y = PAD_T + i * ROW;
      const cy = y + ROW / 2;
      const bh = Math.max(4, ROW - 6);
      const isMark = marks.has(r.strike);

      if (i % 2 === 1) root.append(svg("rect", { class: "sp-zebra", x: 0, y, width: w, height: ROW }));

      // Spot rail: once, at the first boundary where the ladder crosses below the live print.
      // Rows descend, so that is the top edge of the first strike under spot.
      if (!spotDrawn && r.strike <= spot) {
        root.append(svg("line", { class: "sp-spot", x1: 0, y1: y, x2: w, y2: y }));
        root.append(svg("text", { class: "sp-spot-tag", x: 2, y: y - 2.5, text: `SPOT ${spot.toFixed(2)}` }));
        spotDrawn = true;
      }

      root.append(svg("text", {
        class: `sp-k${isMark ? " is-mark" : ""}`,
        x: colStrike, y: cy + 3.5, "text-anchor": "end", text: strikeLabel(r.strike),
      }));

      // put bar — grows left (the CSS animation scales it out from the spine)
      if (isNum(r.put) && r.put !== 0) {
        const len = shape(r.put / scaleMax) * half;
        root.append(svg("rect", {
          class: `sp-bar l ${signClass(r.put)}`, style: `--i:${i}`,
          x: mid - len, y: cy - bh / 2, width: len, height: bh, rx: 1.5,
        }));
      }
      // call bar — grows right
      if (isNum(r.call) && r.call !== 0) {
        const len = shape(r.call / scaleMax) * half;
        root.append(svg("rect", {
          class: `sp-bar r ${signClass(r.call)}`, style: `--i:${i}`,
          x: mid, y: cy - bh / 2, width: len, height: bh, rx: 1.5,
        }));
      }

      if (colVal) {
        root.append(svg("text", { class: `sp-v ${signClass(r.put)}`, x: barL - gut, y: cy + 3.5, "text-anchor": "end", text: fmtVal(r.put) }));
        root.append(svg("text", { class: `sp-v ${signClass(r.call)}`, x: mid + half + gut, y: cy + 3.5, text: fmtVal(r.call) }));
      }
      if (colNet) {
        root.append(svg("text", { class: `sp-net ${signClass(r.net)}`, x: w, y: cy + 3.5, "text-anchor": "end", text: fmtVal(r.net) }));
      }
      if (isMark) root.append(svg("rect", { class: "sp-markbar", x: 0, y: y + 1, width: 2, height: ROW - 2 }));
    });

    return root;
  });
}

/** Take the `n` strikes closest to spot, returned in ascending order. */
function windowAround(sorted, spot, n) {
  if (sorted.length <= n) return sorted;
  let idx = 0, best = Infinity;
  sorted.forEach((r, i) => { const d = Math.abs(r.strike - spot); if (d < best) { best = d; idx = i; } });
  const half = Math.floor(n / 2);
  let lo = clamp(idx - half, 0, Math.max(0, sorted.length - n));
  return sorted.slice(lo, lo + n);
}

/* ── TERM MATRIX: strike × expiry heat grid ──────────────────────────────── */

/**
 * The tenor view of a greek: rows are strikes, columns are the eight front expiries, cell
 * intensity is |value| against the grid max, hue is the sign. This is the panel that answers
 * "is this wall today's, or is it structural?" — the single most useful thing the heatmap feed
 * carries, and the reason the m-bucket being empty matters.
 */
export function termMatrix(host, o) {
  const rows = (o.rows || []).filter((r) => isNum(r?.strike) && Array.isArray(r.cells));
  const cols = o.expiries || [];
  if (!rows.length || !cols.length) return emptyPanel(host);

  const spot = isNum(o.spot) ? o.spot : rows[Math.floor(rows.length / 2)].strike;
  const sorted = [...rows].sort((a, b) => b.strike - a.strike);   // high strike at top, like a chain
  const win = windowAround([...sorted].reverse(), spot, o.maxRows ?? 26).reverse();
  const scaleMax = maxAbs(win.flatMap((r) => r.cells));

  mount(host, ({ w }) => {
    const LBL = w < 520 ? 40 : 48;
    const PAD_T = 26, PAD_B = 6;
    const ROW = w < 520 ? 14 : 16;
    const cw = Math.max(18, (w - LBL - 4) / cols.length);
    const h = PAD_T + win.length * ROW + PAD_B;
    const root = svg("svg", { class: "tmx", viewBox: `0 0 ${w} ${h}`, width: w, height: h });

    cols.forEach((c, j) => {
      const x = LBL + j * cw + cw / 2;
      const label = c.short ?? c.label ?? "";
      root.append(svg("text", { class: `tmx-hd${c.dte === 0 ? " is-0dte" : ""}`, x, y: 10, "text-anchor": "middle", text: label }));
      if (isNum(c.dte)) root.append(svg("text", { class: "tmx-hd2", x, y: 19, "text-anchor": "middle", text: `${c.dte}d` }));
    });
    root.append(svg("line", { class: "sp-rule", x1: 0, y1: PAD_T - 4, x2: w, y2: PAD_T - 4 }));

    let spotDrawn = false;
    win.forEach((r, i) => {
      const y = PAD_T + i * ROW;
      if (!spotDrawn && r.strike <= spot) {
        root.append(svg("line", { class: "sp-spot", x1: 0, y1: y, x2: w, y2: y }));
        spotDrawn = true;
      }
      root.append(svg("text", { class: "tmx-k", x: LBL - 6, y: y + ROW / 2 + 3.5, "text-anchor": "end", text: strikeLabel(r.strike) }));
      cols.forEach((c, j) => {
        const v = r.cells[j];
        if (!isNum(v) || v === 0) return;
        const a = shape(v / scaleMax);
        root.append(svg("rect", {
          class: `tmx-cell ${signClass(v)}`,
          x: LBL + j * cw + 1, y: y + 1, width: cw - 2, height: ROW - 2,
          "fill-opacity": (0.06 + a * 0.88).toFixed(3),
        }));
      });
    });
    return root;
  });
}

/* ── MATRIX: arbitrary rows × columns, per-column scale ──────────────────── */

/**
 * A heat grid whose columns each carry their OWN scale.
 *
 * That is not a cosmetic choice. The house rule for this data is that greek magnitudes are
 * internally consistent within a greek and meaningless across greeks — theta is quoted in raw
 * dollars and vomma in units near 1e-3, so a shared scale would render eight of nine columns
 * blank and imply theta dominates everything. Per-column normalisation asks the only question
 * worth asking here: within THIS greek, how big is this strike, and which way does it point.
 */
export function matrix(host, o) {
  const rows = o.rows || [];
  const cols = o.cols || [];
  if (!rows.length || !cols.length) return emptyPanel(host);

  const scales = cols.map((_, c) => maxAbs(rows.map((r) => r.cells[c])));

  mount(host, ({ w }) => {
    const LBL = o.labelWidth ?? (w < 520 ? 44 : 52);
    const PAD_T = 30, PAD_B = 6;
    const ROW = w < 520 ? 20 : 22;
    const cw = Math.max(26, (w - LBL - 4) / cols.length);
    const h = PAD_T + rows.length * ROW + PAD_B;
    const root = svg("svg", { class: "tmx mx", viewBox: `0 0 ${w} ${h}`, width: w, height: h });

    cols.forEach((c, j) => {
      const x = LBL + j * cw + cw / 2;
      root.append(svg("text", { class: "tmx-hd", x, y: 11, "text-anchor": "middle", text: c.label }));
      if (c.sub) root.append(svg("text", { class: "tmx-hd2", x, y: 21, "text-anchor": "middle", text: c.sub }));
    });
    root.append(svg("line", { class: "sp-rule", x1: 0, y1: PAD_T - 5, x2: w, y2: PAD_T - 5 }));

    rows.forEach((r, i) => {
      const y = PAD_T + i * ROW;
      if (r.rail) root.append(svg("line", { class: "sp-spot", x1: 0, y1: y, x2: w, y2: y }));
      root.append(svg("text", {
        class: `tmx-k${r.strong ? " is-mark" : ""}`,
        x: LBL - 6, y: y + ROW / 2 + 3.5, "text-anchor": "end", text: r.label,
      }));
      cols.forEach((c, j) => {
        const v = r.cells[j];
        const cx = LBL + j * cw;
        if (!isNum(v) || v === 0) {
          root.append(svg("text", { class: "mx-zero", x: cx + cw / 2, y: y + ROW / 2 + 3.5, "text-anchor": "middle", text: "·" }));
          return;
        }
        const a = shape(v / scales[j]);
        root.append(svg("rect", {
          class: `tmx-cell ${signClass(v)}`,
          x: cx + 1, y: y + 1.5, width: cw - 2, height: ROW - 3,
          "fill-opacity": (0.05 + a * 0.85).toFixed(3),
        }));
        if (o.showValues !== false && cw >= 40) {
          root.append(svg("text", {
            class: `mx-v ${a > 0.55 ? "on" : ""}`,
            x: cx + cw / 2, y: y + ROW / 2 + 3.5, "text-anchor": "middle",
            text: (o.fmtCell || ((n) => compact(n, 1)))(v),
          }));
        }
      });
    });
    return root;
  });
}

/* ── LINE: time series ───────────────────────────────────────────────────── */

/**
 * One or more series on a shared y-scale. `bands` draws horizontal reference zones behind
 * (regime thresholds, the 0.5 Hurst line), `marks` draws labelled horizontal rules.
 */
export function lineChart(host, o) {
  const series = (o.series || []).filter((s) => (s.values || []).some(isNum));
  if (!series.length) return emptyPanel(host);

  const all = series.flatMap((s) => s.values.filter(isNum));
  let lo = isNum(o.min) ? o.min : Math.min(...all);
  let hi = isNum(o.max) ? o.max : Math.max(...all);
  for (const m of o.marks || []) { if (isNum(m.value)) { lo = Math.min(lo, m.value); hi = Math.max(hi, m.value); } }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.08;
  lo -= padY; hi += padY;

  mount(host, ({ w }) => {
    const h = o.height ?? 132;
    const L = o.labelWidth ?? 40, R = 6, T = 8, B = 16;
    const iw = Math.max(20, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "lchart", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const Y = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;
    const X = (i, n) => L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);

    for (const b of o.bands || []) {
      const y1 = Y(Math.max(b.from, b.to)), y2 = Y(Math.min(b.from, b.to));
      root.append(svg("rect", { class: `lc-band ${b.tone || ""}`, x: L, y: y1, width: iw, height: Math.max(1, y2 - y1) }));
    }

    // y ticks — three is enough to read magnitude without turning into a grid
    for (const t of [0, 0.5, 1]) {
      const v = lo + (hi - lo) * t, y = Y(v);
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: w - R, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: L - 5, y: y + 3, "text-anchor": "end", text: (o.fmtY || ((n) => n.toFixed(2)))(v) }));
    }

    for (const m of o.marks || []) {
      if (!isNum(m.value)) continue;
      const y = Y(m.value);
      root.append(svg("line", { class: `lc-mark ${m.tone || ""}`, x1: L, y1: y, x2: w - R, y2: y }));
      if (m.label) root.append(svg("text", { class: `lc-marklbl ${m.tone || ""}`, x: w - R - 2, y: y - 3, "text-anchor": "end", text: m.label }));
    }

    for (const s of series) {
      const vals = s.values;
      const pts = [];
      vals.forEach((v, i) => { if (isNum(v)) pts.push(`${X(i, vals.length).toFixed(1)},${Y(v).toFixed(1)}`); });
      if (pts.length < 2) continue;
      if (s.fill) root.append(svg("polygon", { class: `lc-fill ${s.tone || ""}`, points: `${L},${T + ih} ${pts.join(" ")} ${L + iw},${T + ih}` }));
      root.append(svg("polyline", { class: `lc-line ${s.tone || ""}`, points: pts.join(" ") }));
      const last = [...vals].reverse().find(isNum);
      if (isNum(last) && s.dot !== false) {
        root.append(svg("circle", { class: `lc-dot ${s.tone || ""}`, cx: L + iw, cy: Y(last), r: 2.4 }));
      }
    }

    if (o.xLabels?.length) {
      const n = o.xLabels.length;
      o.xLabels.forEach((lab, i) => {
        if (!lab) return;
        root.append(svg("text", {
          class: "lc-ax", x: X(i, n), y: h - 4,
          "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", text: lab,
        }));
      });
    }
    return root;
  });
}

/* ── BARS: vertical histogram / per-category column chart ────────────────── */

/**
 * Vertical columns on a zero baseline. Handles signed values (columns hang below the axis)
 * so the same renderer covers a return histogram and a per-expiry skew chart.
 */
export function bars(host, o) {
  const vals = (o.values || []).map((v) => (isNum(v) ? v : 0));
  if (!vals.length) return emptyPanel(host);

  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const span = hi - lo || 1;

  mount(host, ({ w }) => {
    const h = o.height ?? 140;
    const L = o.labelWidth ?? 38, R = 6, T = 8, B = o.xLabels ? 20 : 8;
    const iw = Math.max(20, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "bchart", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const Y = (v) => T + ih - ((v - lo) / span) * ih;
    const zero = Y(0);
    const cw = iw / vals.length;
    const bw = Math.max(1, cw * (o.gap ?? 0.76));

    for (const t of [0, 1]) {
      const v = t ? hi : lo, y = Y(v);
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: w - R, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: L - 5, y: y + 3, "text-anchor": "end", text: (o.fmtY || ((n) => n.toFixed(2)))(v) }));
    }
    root.append(svg("line", { class: "lc-zero", x1: L, y1: zero, x2: w - R, y2: zero }));

    vals.forEach((v, i) => {
      const x = L + i * cw + (cw - bw) / 2;
      const y = v >= 0 ? Y(v) : zero;
      const bh = Math.max(0.6, Math.abs(Y(v) - zero));
      const cls = o.tones?.[i] ?? signClass(v);
      root.append(svg("rect", { class: `bc-bar ${cls}`, style: `--i:${i}`, x, y, width: bw, height: bh, rx: 1 }));
    });

    if (o.mark !== undefined && isNum(o.mark)) {
      const i = clamp(o.mark, 0, vals.length - 1);
      const x = L + i * cw + cw / 2;
      root.append(svg("line", { class: "bc-mark", x1: x, y1: T, x2: x, y2: T + ih }));
    }

    if (o.xLabels?.length) {
      const n = o.xLabels.length;
      o.xLabels.forEach((lab, i) => {
        if (!lab) return;
        root.append(svg("text", {
          class: "lc-ax", x: L + (i + 0.5) * (iw / n), y: h - 5, "text-anchor": "middle", text: lab,
        }));
      });
    }
    return root;
  });
}

/* ── SMILE: IV by moneyness, one curve per expiry ────────────────────────── */

/**
 * The volatility smile the old build never actually drew (it fed the chart a board `coverage[]`
 * that is usually empty off-RTH, so the panel was permanently blank). This takes YYY's
 * iv_surface grid directly: `grid.moneyness[]` × `grid.dte[]` → `grid.z[dte][moneyness]`.
 */
export function smile(host, o) {
  const xs = o.moneyness || [];
  const curves = (o.curves || []).filter((c) => (c.iv || []).some(isNum));
  if (xs.length < 3 || !curves.length) return emptyPanel(host, "NO IV SURFACE");

  const all = curves.flatMap((c) => c.iv.filter(isNum));
  const lo = Math.max(0, Math.min(...all) * 0.92), hi = Math.max(...all) * 1.04;

  mount(host, ({ w }) => {
    const h = o.height ?? 210;
    const L = 40, R = 10, T = 12, B = 26;
    const iw = Math.max(40, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "lchart smile", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const X = (m) => L + ((m - xs[0]) / (xs[xs.length - 1] - xs[0])) * iw;
    const Y = (v) => T + ih - ((v - lo) / (hi - lo || 1)) * ih;

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = lo + (hi - lo) * t, y = Y(v);
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: w - R, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: L - 5, y: y + 3, "text-anchor": "end", text: `${(v * 100).toFixed(0)}%` }));
    }
    // ATM rail — the smile is read as the shape either side of it
    const atmX = X(1);
    root.append(svg("line", { class: "sm-atm", x1: atmX, y1: T, x2: atmX, y2: T + ih }));
    root.append(svg("text", { class: "lc-ax", x: atmX, y: h - 14, "text-anchor": "middle", text: "ATM" }));
    root.append(svg("text", { class: "lc-ax", x: L, y: h - 14, text: `${(xs[0] * 100).toFixed(0)}%` }));
    root.append(svg("text", { class: "lc-ax", x: w - R, y: h - 14, "text-anchor": "end", text: `${(xs[xs.length - 1] * 100).toFixed(0)}%` }));
    root.append(svg("text", { class: "lc-ax dim", x: (L + w - R) / 2, y: h - 3, "text-anchor": "middle", text: "MONEYNESS  (strike / spot)" }));

    curves.forEach((c) => {
      const pts = [];
      c.iv.forEach((v, i) => { if (isNum(v) && isNum(xs[i])) pts.push(`${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`); });
      if (pts.length < 2) return;
      root.append(svg("polyline", {
        class: `sm-curve${c.dte === 0 ? " is-0dte" : ""}`,
        points: pts.join(" "),
        "stroke-opacity": c.dte === 0 ? 1 : (0.9 - Math.min(0.62, (c.rank ?? 0) * 0.11)).toFixed(2),
      }));
    });
    return root;
  });
}

/* ── CANDLES ─────────────────────────────────────────────────────────────── */

/** Intraday price with VWAP and horizontal level rails (walls, board levels, spot). */
export function candles(host, o) {
  const bars = (o.bars || []).filter((b) => isNum(b?.close ?? b?.c));
  if (bars.length < 2) return emptyPanel(host, "NO BARS");

  const val = (b, k) => b[k] ?? b[k[0]];
  const highs = bars.map((b) => val(b, "high")), lows = bars.map((b) => val(b, "low"));
  const levels = (o.levels || []).filter((l) => isNum(l.price));
  let lo = Math.min(...lows), hi = Math.max(...highs);
  for (const l of levels) if (l.price > lo * 0.97 && l.price < hi * 1.03) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;

  // Session VWAP, cumulative from the first bar we were given.
  let pv = 0, vv = 0;
  const vwap = bars.map((b) => {
    const tp = ((val(b, "high") + val(b, "low") + val(b, "close")) / 3);
    const v = val(b, "volume") ?? 1;
    pv += tp * v; vv += v;
    return vv ? pv / vv : tp;
  });

  mount(host, ({ w }) => {
    const h = o.height ?? 210;
    const R = 52, L = 4, T = 8, B = 16;
    const iw = Math.max(40, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "cchart", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const Y = (p) => T + ih - ((p - lo) / (hi - lo)) * ih;
    const cw = iw / bars.length;
    const bw = Math.max(1, Math.min(7, cw * 0.62));

    for (const t of [0, 0.5, 1]) {
      const y = T + ih * t;
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: L + iw, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: w - 3, y: y + 3, "text-anchor": "end", text: (lo + (hi - lo) * (1 - t)).toFixed(2) }));
    }

    for (const l of levels) {
      const y = Y(l.price);
      if (y < T - 2 || y > T + ih + 2) continue;
      root.append(svg("line", { class: `cc-lvl ${l.tone || ""}`, x1: L, y1: y, x2: L + iw, y2: y }));
      if (l.label) root.append(svg("text", { class: `cc-lvl-lbl ${l.tone || ""}`, x: L + 3, y: y - 3, text: l.label }));
    }

    bars.forEach((b, i) => {
      const x = L + i * cw + cw / 2;
      const o_ = val(b, "open"), c_ = val(b, "close"), hi_ = val(b, "high"), lo_ = val(b, "low");
      const up = c_ >= o_;
      root.append(svg("line", { class: `cc-wick ${up ? "up" : "dn"}`, x1: x, y1: Y(hi_), x2: x, y2: Y(lo_) }));
      const y1 = Y(Math.max(o_, c_)), y2 = Y(Math.min(o_, c_));
      root.append(svg("rect", { class: `cc-body ${up ? "up" : "dn"}`, x: x - bw / 2, y: y1, width: bw, height: Math.max(1, y2 - y1) }));
    });

    const vpts = vwap.map((v, i) => `${(L + i * cw + cw / 2).toFixed(1)},${Y(v).toFixed(1)}`);
    root.append(svg("polyline", { class: "cc-vwap", points: vpts.join(" ") }));

    if (isNum(o.spot)) {
      const y = Y(o.spot);
      root.append(svg("line", { class: "cc-spot", x1: L, y1: y, x2: w - 2, y2: y }));
      root.append(svg("rect", { class: "cc-spot-tag", x: w - R + 2, y: y - 7, width: R - 4, height: 14 }));
      root.append(svg("text", { class: "cc-spot-txt", x: w - 3, y: y + 3.5, "text-anchor": "end", text: o.spot.toFixed(2) }));
    }
    return root;
  });
}

/* ── CONE: probability / expected-move bands over time ───────────────────── */

/** Forward price cone: symmetric percentile or sigma envelopes fanning out from spot. */
export function cone(host, o) {
  const bands = (o.bands || []).filter((b) => (b.upper || []).some(isNum));
  if (!bands.length) return emptyPanel(host);

  const all = bands.flatMap((b) => [...b.upper, ...b.lower]).filter(isNum);
  const lo = Math.min(...all), hi = Math.max(...all);

  mount(host, ({ w }) => {
    const h = o.height ?? 200;
    const L = 6, R = 52, T = 10, B = 18;
    const iw = Math.max(40, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "cchart cone", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const n = bands[0].upper.length;
    const X = (i) => L + (n <= 1 ? iw : (i / (n - 1)) * iw);
    const Y = (p) => T + ih - ((p - lo) / (hi - lo || 1)) * ih;

    for (const t of [0, 0.5, 1]) {
      const y = T + ih * t;
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: L + iw, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: w - 3, y: y + 3, "text-anchor": "end", text: (lo + (hi - lo) * (1 - t)).toFixed(0) }));
    }

    bands.forEach((b, bi) => {
      const up = [], dn = [];
      for (let i = 0; i < n; i++) {
        if (isNum(b.upper[i])) up.push(`${X(i).toFixed(1)},${Y(b.upper[i]).toFixed(1)}`);
      }
      for (let i = n - 1; i >= 0; i--) {
        if (isNum(b.lower[i])) dn.push(`${X(i).toFixed(1)},${Y(b.lower[i]).toFixed(1)}`);
      }
      root.append(svg("polygon", { class: "cn-band", points: [...up, ...dn].join(" "), "fill-opacity": (0.16 - bi * 0.035).toFixed(3) }));
      root.append(svg("polyline", { class: "cn-edge", points: up.join(" ") }));
      root.append(svg("polyline", { class: "cn-edge", points: dn.reverse().join(" ") }));
      if (b.label) {
        root.append(svg("text", { class: "cn-lbl", x: X(n - 1) - 2, y: Y(b.upper[n - 1]) - 3, "text-anchor": "end", text: b.label }));
      }
    });

    if (isNum(o.spot)) {
      const y = Y(o.spot);
      root.append(svg("line", { class: "cc-spot", x1: L, y1: y, x2: w - 2, y2: y }));
      root.append(svg("text", { class: "cc-spot-txt", x: w - 3, y: y - 4, "text-anchor": "end", text: o.spot.toFixed(2) }));
    }
    if (o.xLabel) root.append(svg("text", { class: "lc-ax dim", x: L + iw / 2, y: h - 3, "text-anchor": "middle", text: o.xLabel }));
    return root;
  });
}

/* ── inline meters ───────────────────────────────────────────────────────── */

/** A labelled 0-100 meter. Used for gauges, factor scores, percentile readings. */
export function meter({ label, value, pct: p, tone = "", note }) {
  const frac = clamp((isNum(p) ? p : 0) / 100, 0, 1);
  return el("div.meter", null, [
    el("div.meter-top", null, [
      el("span.meter-lbl", { text: label }),
      el("span.meter-val", { class: `meter-val ${tone}`, text: value ?? "" }),
    ]),
    el("div.meter-track", null, el("i", { class: `meter-fill ${tone}`, style: `width:${(frac * 100).toFixed(1)}%` })),
    note ? el("div.meter-note", { text: note }) : null,
  ]);
}

/** Centre-zero meter for signed readings (dealer lean, skew, net flow). */
export function biMeter({ label, value, frac, tone = "", note }) {
  const f = clamp(isNum(frac) ? frac : 0, -1, 1);
  const w = Math.abs(f) * 50;
  return el("div.meter.bi", null, [
    el("div.meter-top", null, [
      el("span.meter-lbl", { text: label }),
      el("span.meter-val", { class: `meter-val ${tone}`, text: value ?? "" }),
    ]),
    el("div.meter-track", null, [
      el("i.meter-zero"),
      el("i", { class: `meter-fill ${tone}`, style: f < 0 ? `right:50%;width:${w.toFixed(1)}%` : `left:50%;width:${w.toFixed(1)}%` }),
    ]),
    note ? el("div.meter-note", { text: note }) : null,
  ]);
}

/** The KPI cell used across every tab: big number, small label, optional sub. */
export function stat(label, value, { sub, tone = "", jp } = {}) {
  return el("div.stat", null, [
    el("div.stat-lbl", null, [el("span", { text: label }), jp ? el("i.stat-jp", { text: jp }) : null]),
    el("div", { class: `stat-val ${tone}`, text: value ?? "—" }),
    sub ? el("div.stat-sub", { text: sub }) : null,
  ]);
}

/* ── SPARK: the hero rail's session line ─────────────────────────────────── */

/**
 * A lit line with a soft fill and a live dot at the last print. Sized by its host; used only
 * in the rail, where it replaces the old block-glyph sparkline.
 */
export function spark(host, values) {
  const vals = (values || []).filter(isNum);
  if (!host || vals.length < 2) { if (host) host.replaceChildren(); return; }
  mount(host, ({ w }) => {
    const h = Math.max(36, host.clientHeight || 56);
    const T = 6, B = 6, L = 2, R = 10;
    const iw = w - L - R, ih = h - T - B;
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const X = (i) => L + (i / (vals.length - 1)) * iw;
    const Y = (v) => T + ih - ((v - lo) / span) * ih;
    const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    const root = svg("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, preserveAspectRatio: "none" });
    root.append(svg("defs", null, [
      svg("linearGradient", { id: "rsGrad", x1: 0, y1: 0, x2: 0, y2: 1 }, [
        svg("stop", { offset: "0%", "stop-color": "var(--acc)", "stop-opacity": ".22" }),
        svg("stop", { offset: "100%", "stop-color": "var(--acc)", "stop-opacity": "0" }),
      ]),
    ]));
    root.append(svg("line", { class: "rs-base", x1: L, y1: T + ih, x2: L + iw, y2: T + ih }));
    root.append(svg("polygon", { class: "rs-fill", points: `${L},${T + ih} ${pts.join(" ")} ${L + iw},${T + ih}` }));
    root.append(svg("polyline", { class: "rs-line", points: pts.join(" ") }));
    root.append(svg("circle", { class: "rs-dot", cx: X(vals.length - 1), cy: Y(vals[vals.length - 1]), r: 2.6 }));
    return root;
  });
}
