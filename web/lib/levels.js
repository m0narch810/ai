// Every price level the terminal knows about, in the one-line-per-level form the Pine
// converter (`converter.pine`, "Batch Strikes" input) parses:
//
//     705 "Call Wall / Max Pain"
//     704
//     700 "Put Wall"
//
// One line per price, descending, label in double quotes. Prices that several sources agree
// on are merged into one line with the labels joined — a strike that is the call wall AND max
// pain AND the 0DTE gamma flip is one level with three reasons, not three levels.

import { isNum } from "./util.js";
import { findIvAnomalies } from "./ivanom.js";

/**
 * @param {object} ctx  the same ctx the views get: { yyy:{ok}, spot, desk }
 * @returns {{price:number, labels:string[]}[]} descending by price
 */
export function collectLevels(ctx) {
  const ok = ctx?.yyy?.ok || {};
  const out = new Map();  // key = price rounded to 2dp
  const add = (price, label) => {
    if (!isNum(price) || price <= 0) return;
    const k = Math.round(price * 100) / 100;
    if (!out.has(k)) out.set(k, { price: k, labels: [] });
    const e = out.get(k);
    if (label && !e.labels.includes(label)) e.labels.push(label);
  };

  // ── dealer structure (whole chain) ──────────────────────────────────────
  const g = ok.gex || {};
  add(g.call_wall,   "Call Wall");
  add(g.call_wall_2, "Call Wall 2");
  add(g.put_wall,    "Put Wall");
  add(g.put_wall_2,  "Put Wall 2");
  add(g.vol_trigger, "Vol Trigger");
  add(g.max_pain,    "Max Pain");

  // ── 0DTE ────────────────────────────────────────────────────────────────
  const z = ok.zero_dte || {};
  add(z.gamma_flip,      "0DTE Gamma Flip");
  add(z.gamma_wall_call, "0DTE Call Wall");
  add(z.gamma_wall_put,  "0DTE Put Wall");
  add(z.range_1s_high,   "0DTE +1s");
  add(z.range_1s_low,    "0DTE -1s");

  // ── dealer delta ────────────────────────────────────────────────────────
  add(ok.dealer_delta?.delta_flip, "Delta Flip");

  // ── expected move (1 day) ───────────────────────────────────────────────
  const em = ok.expected_move?.moves?.["1d"];
  add(em?.upper, "EM +1d");
  add(em?.lower, "EM -1d");

  // ── multi-method day extremes ───────────────────────────────────────────
  for (const r of ok.levels?.hod || []) add(r?.price, `HOD ${r?.confluence ?? ""}x`.trim());
  for (const r of ok.levels?.lod || []) add(r?.price, `LOD ${r?.confluence ?? ""}x`.trim());

  // ── session VWAP from the bars ──────────────────────────────────────────
  const bars = ok.chart?.candles;
  if (Array.isArray(bars) && bars.length) {
    let pv = 0, vv = 0;
    for (const b of bars) {
      const tp = ((b.high ?? b.h) + (b.low ?? b.l) + (b.close ?? b.c)) / 3;
      const v = b.volume ?? b.v ?? 1;
      if (isNum(tp)) { pv += tp * v; vv += v; }
    }
    if (vv) add(pv / vv, "VWAP");
  }

  // ── IV anomalies: strikes the surface is kinked at (score ≥ 2, top six) ──
  try {
    const anom = findIvAnomalies({ net_iv: ok.net_iv, flow: ok.flow, spot: ctx?.spot ?? ok.gex?.spot });
    for (const s of anom.byStrike.filter((x) => x.score >= 2).slice(0, 6)) {
      add(s.strike, `IV ${s.dir === "rich" ? "Rich" : s.dir === "cheap" ? "Cheap" : "Kink"} ${s.score.toFixed(1)}`);
    }
  } catch { /* the anomaly pass is best-effort */ }

  // ── desk board (AI / rule levels + IV walls) ────────────────────────────
  const b = ctx?.desk?.board;
  for (const l of b?.levels || []) {
    const side = l.side === "support" ? "Sup" : "Res";
    add(l.strike, isNum(l.reversal_prob) ? `Desk ${side} ${l.reversal_prob}%` : `Desk ${side}`);
  }
  const w = b?.iv_walls;
  add(w?.u_outer, "IV Wall Upper Outer");
  add(w?.u_inner, "IV Wall Upper Inner");
  add(w?.l_inner, "IV Wall Lower Inner");
  add(w?.l_outer, "IV Wall Lower Outer");

  return [...out.values()].sort((a, b2) => b2.price - a.price);
}

/** The text that goes on the clipboard. Whole strikes print bare (705), others keep 2dp. */
export function formatLevels(levels) {
  return levels.map(({ price, labels }) => {
    const p = Number.isInteger(price) ? String(price) : price.toFixed(2);
    return labels.length ? `${p} "${labels.join(" / ")}"` : p;
  }).join("\n");
}

/** Copy to clipboard; resolves true on success. Falls back to a hidden textarea. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
