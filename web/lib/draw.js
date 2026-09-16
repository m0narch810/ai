// Chart primitives. Everything is hand-built SVG — no chart library.
//
// Why no library: this terminal draws one shape over and over (a strike ladder with a centre
// spine) at six different scales, and every chart has to survive a theme flip and a phone
// width. Each renderer measures its host, draws at real pixel size (so text never blurs) and
// repaints on resize.
//
// HOVER: every renderer puts `data-tip` on whatever should answer the pointer — a bar, a cell,
// an invisible hit column over a line. lib/tip.js turns those into the floating tag. There is
// no per-chart tooltip code; only the text.

import { svg, el, isNum, clamp, maxAbs, strikeLabel, compact } from "./util.js";

/* ── mount ───────────────────────────────────────────────────────────────── */

const RO = new WeakMap();

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

const errNode = (msg) => el("div.chart-empty", { text: msg });
export function emptyPanel(host, msg = "NO DATA") {
  if (host) host.replaceChildren(el("div.chart-empty", { text: msg }));
}

/* ── shared ──────────────────────────────────────────────────────────────── */

const SHAPE = 0.62;
const shape = (frac) => Math.pow(clamp(Math.abs(frac), 0, 1), SHAPE);
const signClass = (v) => (!isNum(v) || v === 0 ? "z" : v > 0 ? "p" : "n");
const pctS = (v, d = 1) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : "—");
/** An invisible hit target: transparent fill so it catches the pointer without drawing. */
const hit = (attrs) => svg("rect", { class: "hit", fill: "transparent", ...attrs });

/* ── SPINE ───────────────────────────────────────────────────────────────── */

export function spine(host, o) {
  const rows = (o.rows || []).filter((r) => isNum(r?.strike));
  if (!rows.length) return emptyPanel(host);
  const spot = isNum(o.spot) ? o.spot : rows[Math.floor(rows.length / 2)].strike;
  const fmtVal = o.fmtVal || ((n) => compact(n, 1));
  const marks = o.marks || new Set();
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const window_ = windowAround(sorted, spot, o.maxRows ?? 32).reverse();
  const scaleMax = maxAbs(window_.flatMap((r) => [r.put, r.call]));

  mount(host, ({ w }) => {
    const ROW = w < 520 ? 15 : 17;
    const PAD_T = 20, PAD_B = 8;
    const colStrike = w < 520 ? 40 : 46;
    const colVal = w < 420 ? 0 : (w < 620 ? 46 : 56);
    const colNet = w < 520 ? 0 : 60;
    const gut = 8;
    const barL = colStrike + gut + colVal;
    const barR = w - colNet - (colNet ? gut : 0) - colVal - (colVal ? gut : 0);
    const barW = Math.max(60, barR - barL);
    const mid = barL + barW / 2;
    const half = barW / 2 - 1;
    const h = PAD_T + window_.length * ROW + PAD_B;
    const root = svg("svg", { class: "spine", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img" });

    root.append(svg("text", { class: "sp-hd", x: colStrike, y: 11, "text-anchor": "end", text: "STRIKE" }));
    root.append(svg("text", { class: "sp-hd", x: mid - half, y: 11, text: "◀ PUT" }));
    root.append(svg("text", { class: "sp-hd", x: mid + half, y: 11, "text-anchor": "end", text: "CALL ▶" }));
    if (colNet) root.append(svg("text", { class: "sp-hd", x: w, y: 11, "text-anchor": "end", text: o.unit ? `NET ${o.unit}` : "NET" }));
    root.append(svg("line", { class: "sp-spine", x1: mid, y1: PAD_T - 4, x2: mid, y2: h - PAD_B + 2 }));
    root.append(svg("line", { class: "sp-rule", x1: 0, y1: PAD_T - 4, x2: w, y2: PAD_T - 4 }));
    for (const q of [0.5, 1]) for (const s of [-1, 1]) {
      const x = mid + s * half * q;
      root.append(svg("line", { class: "sp-grid", x1: x, y1: PAD_T - 2, x2: x, y2: h - PAD_B }));
    }

    // price → y, interpolated between the window's strikes (rows descend), clamped to the ladder
    const yOf = (price) => {
      const n = window_.length;
      if (price >= window_[0].strike) return PAD_T;
      if (price <= window_[n - 1].strike) return PAD_T + n * ROW;
      for (let i = 0; i < n - 1; i++) {
        const a = window_[i].strike, b = window_[i + 1].strike;
        if (price <= a && price >= b) {
          const f = (a - price) / (a - b || 1);
          return PAD_T + (i + 0.5) * ROW + f * ROW;
        }
      }
      return PAD_T;
    };
    // zones: shaded price bands (the IV-wall brackets) behind the rows
    for (const z of o.zones || []) {
      if (!isNum(z.lo) || !isNum(z.hi)) continue;
      const y1 = yOf(z.hi), y2 = yOf(z.lo);
      if (y2 - y1 < 1) continue;
      root.append(svg("rect", { class: "sp-zone", x: 0, y: y1, width: w, height: y2 - y1, "data-tip": `${z.label}\n${z.lo.toFixed(2)} \u2013 ${z.hi.toFixed(2)}` }));
      root.append(svg("line", { class: "sp-zone-edge", x1: 0, y1: y1, x2: w, y2: y1 }));
      root.append(svg("line", { class: "sp-zone-edge", x1: 0, y1: y2, x2: w, y2: y2 }));
      if (z.label) root.append(svg("text", { class: "sp-zone-lbl", x: w - 3, y: y1 + 8, "text-anchor": "end", text: z.label, "pointer-events": "none" }));
    }

    let spotDrawn = false;
    window_.forEach((r, i) => {
      const y = PAD_T + i * ROW, cy = y + ROW / 2, bh = Math.max(4, ROW - 6);
      const isMark = marks.has(r.strike);
      if (i % 2 === 1) root.append(svg("rect", { class: "sp-zebra", x: 0, y, width: w, height: ROW }));
      if (!spotDrawn && r.strike <= spot) {
        root.append(svg("line", { class: "sp-spot", x1: 0, y1: y, x2: w, y2: y }));
        root.append(svg("text", { class: "sp-spot-tag", x: 2, y: y - 2.5, text: `SPOT ${spot.toFixed(2)}` }));
        spotDrawn = true;
      }
      root.append(svg("text", { class: `sp-k${isMark ? " is-mark" : ""}`, x: colStrike, y: cy + 3.5, "text-anchor": "end", text: strikeLabel(r.strike) }));
      if (isNum(r.put) && r.put !== 0) {
        const len = shape(r.put / scaleMax) * half;
        root.append(svg("rect", { class: `sp-bar l ${signClass(r.put)}`, style: `--i:${i}`, x: mid - len, y: cy - bh / 2, width: len, height: bh, rx: 1.5 }));
      }
      if (isNum(r.call) && r.call !== 0) {
        const len = shape(r.call / scaleMax) * half;
        root.append(svg("rect", { class: `sp-bar r ${signClass(r.call)}`, style: `--i:${i}`, x: mid, y: cy - bh / 2, width: len, height: bh, rx: 1.5 }));
      }
      if (colVal) {
        root.append(svg("text", { class: `sp-v ${signClass(r.put)}`, x: barL - gut, y: cy + 3.5, "text-anchor": "end", text: fmtVal(r.put) }));
        root.append(svg("text", { class: `sp-v ${signClass(r.call)}`, x: mid + half + gut, y: cy + 3.5, text: fmtVal(r.call) }));
      }
      if (colNet) root.append(svg("text", { class: `sp-net ${signClass(r.net)}`, x: w, y: cy + 3.5, "text-anchor": "end", text: fmtVal(r.net) }));
      if (isMark) root.append(svg("rect", { class: "sp-markbar", x: 0, y: y + 1, width: 2, height: ROW - 2 }));

      const dist = isNum(spot) ? r.strike - spot : NaN;
      root.append(hit({
        x: 0, y, width: w, height: ROW,
        "data-tip": `${strikeLabel(r.strike)}${isMark ? "  ▮ marked" : ""}\nput: ${fmtVal(r.put)}\ncall: ${fmtVal(r.call)}\nnet: ${fmtVal(r.net)}${isNum(dist) ? `\nfrom spot: ${dist >= 0 ? "+" : "−"}${Math.abs(dist).toFixed(2)}` : ""}`,
      }));
    });
    return root;
  });
}

function windowAround(sorted, spot, n) {
  if (sorted.length <= n) return sorted;
  let idx = 0, best = Infinity;
  sorted.forEach((r, i) => { const d = Math.abs(r.strike - spot); if (d < best) { best = d; idx = i; } });
  const half = Math.floor(n / 2);
  const lo = clamp(idx - half, 0, Math.max(0, sorted.length - n));
  return sorted.slice(lo, lo + n);
}

/* ── TERM MATRIX ─────────────────────────────────────────────────────────── */

export function termMatrix(host, o) {
  const rows = (o.rows || []).filter((r) => isNum(r?.strike) && Array.isArray(r.cells));
  const cols = o.expiries || [];
  if (!rows.length || !cols.length) return emptyPanel(host);
  const spot = isNum(o.spot) ? o.spot : rows[Math.floor(rows.length / 2)].strike;
  const sorted = [...rows].sort((a, b) => b.strike - a.strike);
  const win = windowAround([...sorted].reverse(), spot, o.maxRows ?? 26).reverse();
  const scaleMax = maxAbs(win.flatMap((r) => r.cells));
  const fmtVal = o.fmtVal || ((n) => compact(n, 1));

  mount(host, ({ w }) => {
    const LBL = w < 520 ? 40 : 48, PAD_T = 26, PAD_B = 6, ROW = w < 520 ? 14 : 16;
    const cw = Math.max(18, (w - LBL - 4) / cols.length);
    const h = PAD_T + win.length * ROW + PAD_B;
    const root = svg("svg", { class: "tmx", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    cols.forEach((c, j) => {
      const x = LBL + j * cw + cw / 2;
      root.append(svg("text", { class: `tmx-hd${c.dte === 0 ? " is-0dte" : ""}`, x, y: 10, "text-anchor": "middle", text: c.short ?? c.label ?? "" }));
      if (isNum(c.dte)) root.append(svg("text", { class: "tmx-hd2", x, y: 19, "text-anchor": "middle", text: `${c.dte}d` }));
    });
    root.append(svg("line", { class: "sp-rule", x1: 0, y1: PAD_T - 4, x2: w, y2: PAD_T - 4 }));
    let spotDrawn = false;
    win.forEach((r, i) => {
      const y = PAD_T + i * ROW;
      if (!spotDrawn && r.strike <= spot) { root.append(svg("line", { class: "sp-spot", x1: 0, y1: y, x2: w, y2: y })); spotDrawn = true; }
      root.append(svg("text", { class: "tmx-k", x: LBL - 6, y: y + ROW / 2 + 3.5, "text-anchor": "end", text: strikeLabel(r.strike) }));
      cols.forEach((c, j) => {
        const v = r.cells[j];
        const tip = `${strikeLabel(r.strike)} · ${c.label ?? c.short ?? ""}\nvalue: ${isNum(v) ? fmtVal(v) : "—"}`;
        if (isNum(v) && v !== 0) {
          root.append(svg("rect", {
            class: `tmx-cell ${signClass(v)}`, style: `--i:${i * cols.length + j}`,
            x: LBL + j * cw + 1, y: y + 1, width: cw - 2, height: ROW - 2,
            "fill-opacity": (0.06 + shape(v / scaleMax) * 0.88).toFixed(3), "data-tip": tip,
          }));
        } else {
          root.append(hit({ x: LBL + j * cw, y, width: cw, height: ROW, "data-tip": tip }));
        }
      });
    });
    return root;
  });
}

/* ── MATRIX (per-column scale) ───────────────────────────────────────────── */

export function matrix(host, o) {
  const rows = o.rows || [], cols = o.cols || [];
  if (!rows.length || !cols.length) return emptyPanel(host);
  const scales = cols.map((_, c) => maxAbs(rows.map((r) => r.cells[c])));
  const fmtCell = o.fmtCell || ((n) => compact(n, 1));

  mount(host, ({ w }) => {
    const LBL = o.labelWidth ?? (w < 520 ? 44 : 52), PAD_T = 30, PAD_B = 6, ROW = w < 520 ? 20 : 22;
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
      root.append(svg("text", { class: `tmx-k${r.strong ? " is-mark" : ""}`, x: LBL - 6, y: y + ROW / 2 + 3.5, "text-anchor": "end", text: r.label }));
      cols.forEach((c, j) => {
        const v = r.cells[j], cx = LBL + j * cw;
        const tip = `${r.label} · ${c.label}${c.sub ? ` (${c.sub})` : ""}\nvalue: ${isNum(v) && v !== 0 ? fmtCell(v) : "—"}`;
        if (!isNum(v) || v === 0) {
          root.append(svg("text", { class: "mx-zero", x: cx + cw / 2, y: y + ROW / 2 + 3.5, "text-anchor": "middle", text: "·" }));
          root.append(hit({ x: cx, y, width: cw, height: ROW, "data-tip": tip }));
          return;
        }
        const a = shape(v / scales[j]);
        root.append(svg("rect", {
          class: `tmx-cell ${signClass(v)}`, style: `--i:${i * cols.length + j}`,
          x: cx + 1, y: y + 1.5, width: cw - 2, height: ROW - 3,
          "fill-opacity": (0.05 + a * 0.85).toFixed(3), "data-tip": tip,
        }));
        if (o.showValues !== false && cw >= 40) {
          root.append(svg("text", { class: `mx-v ${a > 0.55 ? "on" : ""}`, x: cx + cw / 2, y: y + ROW / 2 + 3.5, "text-anchor": "middle", text: fmtCell(v), "pointer-events": "none" }));
        }
      });
    });
    return root;
  });
}

/* ── LINE ────────────────────────────────────────────────────────────────── */

export function lineChart(host, o) {
  const series = (o.series || []).filter((s) => (s.values || []).some(isNum));
  if (!series.length) return emptyPanel(host);
  const all = series.flatMap((s) => s.values.filter(isNum));
  let lo = isNum(o.min) ? o.min : Math.min(...all);
  let hi = isNum(o.max) ? o.max : Math.max(...all);
  for (const m of o.marks || []) if (isNum(m.value)) { lo = Math.min(lo, m.value); hi = Math.max(hi, m.value); }
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
  const fmtY = o.fmtY || ((n) => n.toFixed(2));
  const n = Math.max(...series.map((s) => s.values.length));

  mount(host, ({ w }) => {
    const h = o.height ?? 132;
    const L = o.labelWidth ?? 40, R = 6, T = 8, B = 16;
    const iw = Math.max(20, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "lchart", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const Y = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;
    const X = (i, len) => L + (len <= 1 ? iw / 2 : (i / (len - 1)) * iw);

    for (const b of o.bands || []) {
      const y1 = Y(Math.max(b.from, b.to)), y2 = Y(Math.min(b.from, b.to));
      root.append(svg("rect", { class: `lc-band ${b.tone || ""}`, x: L, y: y1, width: iw, height: Math.max(1, y2 - y1) }));
    }
    for (const t of [0, 0.5, 1]) {
      const v = lo + (hi - lo) * t, y = Y(v);
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: w - R, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: L - 5, y: y + 3, "text-anchor": "end", text: fmtY(v) }));
    }
    for (const m of o.marks || []) {
      if (!isNum(m.value)) continue;
      const y = Y(m.value);
      root.append(svg("line", { class: `lc-mark ${m.tone || ""}`, x1: L, y1: y, x2: w - R, y2: y }));
      if (m.label) root.append(svg("text", { class: `lc-marklbl ${m.tone || ""}`, x: w - R - 2, y: y - 3, "text-anchor": "end", text: m.label }));
    }
    series.forEach((s) => {
      const vals = s.values, pts = [];
      vals.forEach((v, i) => { if (isNum(v)) pts.push(`${X(i, vals.length).toFixed(1)},${Y(v).toFixed(1)}`); });
      if (pts.length < 2) return;
      if (s.fill) root.append(svg("polygon", { class: `lc-fill ${s.tone || ""}`, points: `${L},${T + ih} ${pts.join(" ")} ${L + iw},${T + ih}` }));
      root.append(svg("polyline", { class: `lc-line ${s.tone || ""}`, points: pts.join(" ") }));
      const last = [...vals].reverse().find(isNum);
      if (isNum(last) && s.dot !== false) root.append(svg("circle", { class: `lc-dot ${s.tone || ""}`, cx: L + iw, cy: Y(last), r: 2.4 }));
    });
    if (o.xLabels?.length) {
      const m = o.xLabels.length;
      o.xLabels.forEach((lab, i) => {
        if (!lab) return;
        root.append(svg("text", { class: "lc-ax", x: X(i, m), y: h - 4, "text-anchor": i === 0 ? "start" : i === m - 1 ? "end" : "middle", text: lab }));
      });
    }
    // hover columns: one per index of the longest series, listing every series' value there
    const cw = n > 1 ? iw / (n - 1) : iw;
    for (let i = 0; i < n; i++) {
      const lines = series.map((s, k) => `${s.name ?? `s${k + 1}`}: ${isNum(s.values[i]) ? fmtY(s.values[i]) : "—"}`);
      const head = o.tipX ? o.tipX(i) : (o.xTips?.[i] ?? `#${i + 1}`);
      root.append(hit({ x: X(i, n) - cw / 2, y: T, width: Math.max(2, cw), height: ih, "data-tip": `${head}\n${lines.join("\n")}` }));
    }
    return root;
  });
}

/* ── BARS ────────────────────────────────────────────────────────────────── */

export function bars(host, o) {
  const vals = (o.values || []).map((v) => (isNum(v) ? v : 0));
  if (!vals.length) return emptyPanel(host);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), span = hi - lo || 1;
  const fmtY = o.fmtY || ((n) => n.toFixed(2));

  mount(host, ({ w }) => {
    const h = o.height ?? 140;
    const L = o.labelWidth ?? 38, R = 6, T = 8, B = o.xLabels ? 20 : 8;
    const iw = Math.max(20, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "bchart", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const Y = (v) => T + ih - ((v - lo) / span) * ih;
    const zero = Y(0), cw = iw / vals.length, bw = Math.max(1, cw * (o.gap ?? 0.76));
    for (const t of [0, 1]) {
      const v = t ? hi : lo, y = Y(v);
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: w - R, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: L - 5, y: y + 3, "text-anchor": "end", text: fmtY(v) }));
    }
    root.append(svg("line", { class: "lc-zero", x1: L, y1: zero, x2: w - R, y2: zero }));
    vals.forEach((v, i) => {
      const x = L + i * cw + (cw - bw) / 2;
      const y = v >= 0 ? Y(v) : zero, bh = Math.max(0.6, Math.abs(Y(v) - zero));
      root.append(svg("rect", { class: `bc-bar ${o.tones?.[i] ?? signClass(v)}`, style: `--i:${i}`, x, y, width: bw, height: bh, rx: 1 }));
      const head = o.tips?.[i] ?? o.xLabels?.[i] ?? `#${i + 1}`;
      root.append(hit({ x: L + i * cw, y: T, width: cw, height: ih, "data-tip": `${head}\nvalue: ${fmtY(v)}` }));
    });
    if (o.mark !== undefined && isNum(o.mark)) {
      const x = L + clamp(o.mark, 0, vals.length - 1) * cw + cw / 2;
      root.append(svg("line", { class: "bc-mark", x1: x, y1: T, x2: x, y2: T + ih, "pointer-events": "none" }));
    }
    if (o.xLabels?.length) {
      const m = o.xLabels.length;
      o.xLabels.forEach((lab, i) => { if (lab) root.append(svg("text", { class: "lc-ax", x: L + (i + 0.5) * (iw / m), y: h - 5, "text-anchor": "middle", text: lab })); });
    }
    return root;
  });
}

/* ── SMILE ───────────────────────────────────────────────────────────────── */

export function smile(host, o) {
  const xs = o.moneyness || [];
  const curves = (o.curves || []).filter((c) => (c.iv || []).some(isNum));
  if (xs.length < 3 || !curves.length) return emptyPanel(host, "NO IV SURFACE");
  const all = curves.flatMap((c) => c.iv.filter(isNum));
  const lo = Math.max(0, Math.min(...all) * 0.92), hi = Math.max(...all) * 1.04;

  mount(host, ({ w }) => {
    const h = o.height ?? 210, L = 40, R = 10, T = 12, B = 26;
    const iw = Math.max(40, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "lchart smile", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const X = (m) => L + ((m - xs[0]) / (xs[xs.length - 1] - xs[0])) * iw;
    const Y = (v) => T + ih - ((v - lo) / (hi - lo || 1)) * ih;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const v = lo + (hi - lo) * t, y = Y(v);
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: w - R, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: L - 5, y: y + 3, "text-anchor": "end", text: pctS(v, 0) }));
    }
    const atmX = X(1);
    root.append(svg("line", { class: "sm-atm", x1: atmX, y1: T, x2: atmX, y2: T + ih }));
    root.append(svg("text", { class: "lc-ax", x: atmX, y: h - 14, "text-anchor": "middle", text: "ATM" }));
    root.append(svg("text", { class: "lc-ax", x: L, y: h - 14, text: pctS(xs[0], 0) }));
    root.append(svg("text", { class: "lc-ax", x: w - R, y: h - 14, "text-anchor": "end", text: pctS(xs[xs.length - 1], 0) }));
    root.append(svg("text", { class: "lc-ax dim", x: (L + w - R) / 2, y: h - 3, "text-anchor": "middle", text: "MONEYNESS  (strike / spot)" }));
    curves.forEach((c) => {
      const pts = [];
      c.iv.forEach((v, i) => { if (isNum(v) && isNum(xs[i])) pts.push(`${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`); });
      if (pts.length < 2) return;
      root.append(svg("polyline", { class: `sm-curve${c.dte === 0 ? " is-0dte" : ""}`, points: pts.join(" "), "stroke-opacity": c.dte === 0 ? 1 : (0.9 - Math.min(0.62, (c.rank ?? 0) * 0.11)).toFixed(2) }));
    });
    // hover: nearest curve point — small hit discs on every vertex, nearer expiries on top
    [...curves].sort((a, b) => (b.dte ?? 0) - (a.dte ?? 0)).forEach((c) => {
      c.iv.forEach((v, i) => {
        if (!isNum(v) || !isNum(xs[i])) return;
        root.append(svg("circle", { class: "hit", fill: "transparent", cx: X(xs[i]), cy: Y(v), r: 5, "data-tip": `${c.label}\nmoneyness: ${pctS(xs[i], 0)}${isNum(o.spot) ? ` (≈ ${(xs[i] * o.spot).toFixed(1)})` : ""}\niv: ${pctS(v, 1)}` }));
      });
    });
    return root;
  });
}

/* ── HEAT SURFACE ────────────────────────────────────────────────────────── */

export function heatSurface(host, o) {
  const xs = o.moneyness || [];
  const rows = (o.curves || []).filter((c) => (c.iv || []).some(isNum));
  if (xs.length < 3 || !rows.length) return emptyPanel(host, "NO IV SURFACE");
  const all = rows.flatMap((c) => c.iv.filter(isNum));
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;

  mount(host, ({ w }) => {
    const L = 40, R = 6, T = 8, B = 18, ROW = 16;
    const iw = w - L - R, cw = iw / xs.length, h = T + rows.length * ROW + B;
    const root = svg("svg", { class: "tmx heat", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const ordered = [...rows].sort((a, b) => (a.dte ?? 0) - (b.dte ?? 0));
    ordered.forEach((c, i) => {
      const y = T + i * ROW;
      root.append(svg("text", { class: `hs-k${c.dte === 0 ? " is-0dte" : ""}`, x: L - 5, y: y + ROW / 2 + 3, "text-anchor": "end", text: c.label }));
      c.iv.forEach((v, k) => {
        if (!isNum(v)) return;
        root.append(svg("rect", {
          class: "hs-cell", style: `--i:${i * xs.length + k}`,
          x: L + k * cw, y: y + 1, width: Math.max(1, cw - 0.5), height: ROW - 2,
          "fill-opacity": (0.04 + Math.pow((v - lo) / span, 1.3) * 0.9).toFixed(3),
          "data-tip": `${c.label}\nmoneyness: ${pctS(xs[k], 0)}${isNum(o.spot) ? ` (≈ ${(xs[k] * o.spot).toFixed(1)})` : ""}\niv: ${pctS(v, 1)}`,
        }));
      });
    });
    for (const m of o.marks || []) {
      const i = ordered.findIndex((c) => c.dteIdx === m.dteIdx);
      if (i < 0 || !isNum(m.m)) continue;
      let k = 0, best = Infinity;
      xs.forEach((x, idx) => { const d = Math.abs(x - m.m); if (d < best) { best = d; k = idx; } });
      root.append(svg("rect", { class: `hs-anom${m.cheap ? " cheap" : ""}`, x: L + k * cw - 0.5, y: T + i * ROW, width: cw + 1, height: ROW, "pointer-events": "none" }));
    }
    const atmK = xs.reduce((b, x, i) => (Math.abs(x - 1) < Math.abs(xs[b] - 1) ? i : b), 0);
    root.append(svg("line", { class: "rg-atm", x1: L + (atmK + 0.5) * cw, y1: T, x2: L + (atmK + 0.5) * cw, y2: T + rows.length * ROW, "pointer-events": "none" }));
    [0, Math.floor(xs.length / 2), xs.length - 1].forEach((k) => {
      root.append(svg("text", { class: "lc-ax", x: L + (k + 0.5) * cw, y: h - 5, "text-anchor": k === 0 ? "start" : k === xs.length - 1 ? "end" : "middle", text: pctS(xs[k], 0) }));
    });
    return root;
  });
}

/* ── CANDLES ─────────────────────────────────────────────────────────────── */

export function candles(host, o) {
  const bars_ = (o.bars || []).filter((b) => isNum(b?.close ?? b?.c));
  if (bars_.length < 2) return emptyPanel(host, "NO BARS");
  const val = (b, k) => b[k] ?? b[k[0]];
  const levels = (o.levels || []).filter((l) => isNum(l.price));
  let lo = Math.min(...bars_.map((b) => val(b, "low"))), hi = Math.max(...bars_.map((b) => val(b, "high")));
  for (const l of levels) if (l.price > lo * 0.97 && l.price < hi * 1.03) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); }
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  let pv = 0, vv = 0;
  const vwap = bars_.map((b) => { const tp = (val(b, "high") + val(b, "low") + val(b, "close")) / 3; const v = val(b, "volume") ?? 1; pv += tp * v; vv += v; return vv ? pv / vv : tp; });
  const timeOf = (b) => { const t = b.time ?? b.t ?? ""; const m = String(t).match(/T?(\d{2}:\d{2})/); return m ? m[1] : String(t).slice(-5); };

  mount(host, ({ w }) => {
    const h = o.height ?? 210, R = 52, L = 4, T = 8, B = 16;
    const iw = Math.max(40, w - L - R), ih = h - T - B;
    const root = svg("svg", { class: "cchart", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
    const Y = (p) => T + ih - ((p - lo) / (hi - lo)) * ih;
    const cw = iw / bars_.length, bw = Math.max(1, Math.min(7, cw * 0.62));
    for (const t of [0, 0.5, 1]) {
      const y = T + ih * t;
      root.append(svg("line", { class: "lc-grid", x1: L, y1: y, x2: L + iw, y2: y }));
      root.append(svg("text", { class: "lc-ax", x: w - 3, y: y + 3, "text-anchor": "end", text: (lo + (hi - lo) * (1 - t)).toFixed(2) }));
    }
    for (const l of levels) {
      const y = Y(l.price);
      if (y < T - 2 || y > T + ih + 2) continue;
      root.append(svg("line", { class: `cc-lvl ${l.tone || ""}`, x1: L, y1: y, x2: L + iw, y2: y, "data-tip": `${l.label ?? "level"}\nprice: ${l.price.toFixed(2)}` }));
      if (l.label) root.append(svg("text", { class: `cc-lvl-lbl ${l.tone || ""}`, x: L + 3, y: y - 3, text: l.label, "pointer-events": "none" }));
    }
    bars_.forEach((b, i) => {
      const x = L + i * cw + cw / 2;
      const o_ = val(b, "open"), c_ = val(b, "close"), hi_ = val(b, "high"), lo_ = val(b, "low");
      const up = c_ >= o_;
      root.append(svg("line", { class: `cc-wick ${up ? "up" : "dn"}`, x1: x, y1: Y(hi_), x2: x, y2: Y(lo_) }));
      const y1 = Y(Math.max(o_, c_)), y2 = Y(Math.min(o_, c_));
      root.append(svg("rect", { class: `cc-body ${up ? "up" : "dn"}`, x: x - bw / 2, y: y1, width: bw, height: Math.max(1, y2 - y1) }));
      root.append(hit({
        x: L + i * cw, y: T, width: cw, height: ih,
        "data-tip": `${timeOf(b)}\nopen: ${o_.toFixed(2)}\nhigh: ${hi_.toFixed(2)}\nlow: ${lo_.toFixed(2)}\nclose: ${c_.toFixed(2)}\nvwap: ${vwap[i].toFixed(2)}${isNum(val(b, "volume")) ? `\nvolume: ${compact(val(b, "volume"), 1)}` : ""}`,
      }));
    });
    root.append(svg("polyline", { class: "cc-vwap", points: vwap.map((v, i) => `${(L + i * cw + cw / 2).toFixed(1)},${Y(v).toFixed(1)}`).join(" "), "pointer-events": "none" }));
    if (isNum(o.spot)) {
      const y = Y(o.spot);
      root.append(svg("line", { class: "cc-spot", x1: L, y1: y, x2: w - 2, y2: y, "pointer-events": "none" }));
      root.append(svg("rect", { class: "cc-spot-tag", x: w - R + 2, y: y - 7, width: R - 4, height: 14, "data-tip": `spot: ${o.spot.toFixed(2)}` }));
      root.append(svg("text", { class: "cc-spot-txt", x: w - 3, y: y + 3.5, "text-anchor": "end", text: o.spot.toFixed(2), "pointer-events": "none" }));
    }
    return root;
  });
}

/* ── CONE ────────────────────────────────────────────────────────────────── */

export function cone(host, o) {
  const bands = (o.bands || []).filter((b) => (b.upper || []).some(isNum));
  if (!bands.length) return emptyPanel(host);
  const all = bands.flatMap((b) => [...b.upper, ...b.lower]).filter(isNum);
  const lo = Math.min(...all), hi = Math.max(...all);

  mount(host, ({ w }) => {
    const h = o.height ?? 200, L = 6, R = 52, T = 10, B = 18;
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
      for (let i = 0; i < n; i++) if (isNum(b.upper[i])) up.push(`${X(i).toFixed(1)},${Y(b.upper[i]).toFixed(1)}`);
      for (let i = n - 1; i >= 0; i--) if (isNum(b.lower[i])) dn.push(`${X(i).toFixed(1)},${Y(b.lower[i]).toFixed(1)}`);
      root.append(svg("polygon", { class: "cn-band", points: [...up, ...dn].join(" "), "fill-opacity": (0.16 - bi * 0.035).toFixed(3), "pointer-events": "none" }));
      root.append(svg("polyline", { class: "cn-edge", points: up.join(" "), "pointer-events": "none" }));
      root.append(svg("polyline", { class: "cn-edge", points: dn.reverse().join(" "), "pointer-events": "none" }));
      if (b.label) root.append(svg("text", { class: "cn-lbl", x: X(n - 1) - 2, y: Y(b.upper[n - 1]) - 3, "text-anchor": "end", text: b.label }));
    });
    if (isNum(o.spot)) {
      const y = Y(o.spot);
      root.append(svg("line", { class: "cc-spot", x1: L, y1: y, x2: w - 2, y2: y, "pointer-events": "none" }));
      root.append(svg("text", { class: "cc-spot-txt", x: w - 3, y: y - 4, "text-anchor": "end", text: o.spot.toFixed(2) }));
    }
    if (o.xLabel) root.append(svg("text", { class: "lc-ax dim", x: L + iw / 2, y: h - 3, "text-anchor": "middle", text: o.xLabel }));
    const cw = n > 1 ? iw / (n - 1) : iw;
    for (let i = 0; i < n; i++) {
      const head = o.xTips?.[i] ?? `step ${i + 1}`;
      const lines = bands.map((b) => `${b.label ?? "band"}: ${isNum(b.lower[i]) ? b.lower[i].toFixed(1) : "—"} – ${isNum(b.upper[i]) ? b.upper[i].toFixed(1) : "—"}`);
      root.append(hit({ x: X(i) - cw / 2, y: T, width: Math.max(2, cw), height: ih, "data-tip": `${head}\n${lines.join("\n")}` }));
    }
    return root;
  });
}

/* ── meters / stat ───────────────────────────────────────────────────────── */

export function meter({ label, value, pct: p, tone = "", note }) {
  const frac = clamp((isNum(p) ? p : 0) / 100, 0, 1);
  return el("div.meter", { "data-tip": `${label}\n${value ?? ""}${isNum(p) ? `\n${p.toFixed(0)} / 100` : ""}${note ? `\n${note}` : ""}` }, [
    el("div.meter-top", null, [el("span.meter-lbl", { text: label }), el("span.meter-val", { class: `meter-val ${tone}`, text: value ?? "" })]),
    el("div.meter-track", null, el("i", { class: `meter-fill ${tone}`, style: `width:${(frac * 100).toFixed(1)}%` })),
    note ? el("div.meter-note", { text: note }) : null,
  ]);
}

export function biMeter({ label, value, frac, tone = "", note }) {
  const f = clamp(isNum(frac) ? frac : 0, -1, 1);
  const w = Math.abs(f) * 50;
  return el("div.meter.bi", { "data-tip": `${label}\n${value ?? ""}\n${f >= 0 ? "right of centre (bullish)" : "left of centre (bearish)"}${note ? `\n${note}` : ""}` }, [
    el("div.meter-top", null, [el("span.meter-lbl", { text: label }), el("span.meter-val", { class: `meter-val ${tone}`, text: value ?? "" })]),
    el("div.meter-track", null, [el("i.meter-zero"), el("i", { class: `meter-fill ${tone}`, style: f < 0 ? `right:50%;width:${w.toFixed(1)}%` : `left:50%;width:${w.toFixed(1)}%` })]),
    note ? el("div.meter-note", { text: note }) : null,
  ]);
}

export function stat(label, value, { sub, tone = "" } = {}) {
  return el("div.stat", null, [
    el("div.stat-lbl", null, [el("span", { text: label })]),
    el("div", { class: `stat-val ${tone}`, text: value ?? "—" }),
    sub ? el("div.stat-sub", { text: sub }) : null,
  ]);
}

/* ── SPARK ───────────────────────────────────────────────────────────────── */

export function spark(host, values, { draw = false, tips } = {}) {
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
    root.append(svg("defs", null, [svg("linearGradient", { id: "rsGrad", x1: 0, y1: 0, x2: 0, y2: 1 }, [
      svg("stop", { offset: "0%", "stop-color": "var(--acc)", "stop-opacity": ".22" }),
      svg("stop", { offset: "100%", "stop-color": "var(--acc)", "stop-opacity": "0" }),
    ])]));
    root.append(svg("line", { class: "rs-base", x1: L, y1: T + ih, x2: L + iw, y2: T + ih }));
    root.append(svg("polygon", { class: "rs-fill", points: `${L},${T + ih} ${pts.join(" ")} ${L + iw},${T + ih}`, "pointer-events": "none" }));
    root.append(svg("polyline", { class: `rs-line${draw ? " draw" : ""}`, points: pts.join(" "), pathLength: 1, "pointer-events": "none" }));
    root.append(svg("circle", { class: "rs-dot", cx: X(vals.length - 1), cy: Y(vals[vals.length - 1]), r: 2.6, "pointer-events": "none" }));
    root.append(svg("text", { class: "rs-hi", x: L + iw + 4, y: T + 3, text: hi.toFixed(2) }));
    root.append(svg("text", { class: "rs-lo", x: L + iw + 4, y: T + ih + 1, text: lo.toFixed(2) }));
    const cw = iw / (vals.length - 1);
    vals.forEach((v, i) => root.append(hit({ x: X(i) - cw / 2, y: 0, width: Math.max(2, cw), height: h, "data-tip": `${tips?.[i] ?? `bar ${i + 1}`}\nclose: ${v.toFixed(2)}` })));
    return root;
  });
}
