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
//
// REACH (2026-09-16): only levels within ±REACH_PCT of spot are exported. A wall 3% away is
// not a level for a day trade, it is clutter on the chart — the same lesson the desk learned
// when 93% of its published levels were never touched. The IV-anomaly strikes were dropped for
// the same reason (kinks live in the wings); vanna and charm walls were added because the
// hedge drift they force is what actually moves price through a strike intraday.

import { isNum, etNow } from "./util.js";
import { liveIvWalls } from "./ivwalls.js";
import { greek, frontExpiryIndex } from "./data.js";

const REACH_PCT = 2.5;

/**
 * The largest |net| strikes of one greek on each sign, inside the reach window. `share` guards
 * against listing noise: a "wall" has to carry at least that fraction of the biggest bar.
 */
function greekWalls(raw, spot, { perSign = 2, share = 0.3, expIdx = null } = {}) {
  const g = greek("", raw, expIdx);
  if (!g.ok || !isNum(spot)) return [];
  const lo = spot * (1 - REACH_PCT / 100), hi = spot * (1 + REACH_PCT / 100);
  const rows = g.rows.filter((r) => r.strike >= lo && r.strike <= hi && isNum(r.net) && r.net !== 0);
  if (!rows.length) return [];
  const big = Math.max(...rows.map((r) => Math.abs(r.net)));
  const pick = (sign) => rows
    .filter((r) => Math.sign(r.net) === sign && Math.abs(r.net) >= big * share)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, perSign)
    .map((r) => ({ strike: r.strike, sign }));
  return [...pick(1), ...pick(-1)];
}

/**
 * @param {object} ctx  the same ctx the views get: { yyy:{ok}, spot, desk }
 * @returns {{price:number, labels:string[]}[]} descending by price
 */
export function collectLevels(ctx) {
  const ok = ctx?.yyy?.ok || {};
  const spot = isNum(ctx?.spot) ? ctx.spot : ok.gex?.spot;
  const out = new Map();  // key = price rounded to 2dp
  const add = (price, label) => {
    if (!isNum(price) || price <= 0) return;
    if (isNum(spot) && Math.abs(price - spot) / spot * 100 > REACH_PCT) return;
    const k = Math.round(price * 100) / 100;
    if (!out.has(k)) out.set(k, { price: k, labels: [] });
    const e = out.get(k);
    if (label && !e.labels.includes(label)) e.labels.push(label);
  };

  // ── dealer structure (whole chain) ──────────────────────────────────────
  const g = ok.gex || {};
  // GEX walls are MAGNETS: turns print ~1 strike in front and light strikes out-hold heavy
  // ones (2022-25 studies) — labelled so the chart says it.
  add(g.call_wall,   "Call Wall (magnet)");
  add(g.call_wall_2, "Call Wall 2 (magnet)");
  add(g.put_wall,    "Put Wall (magnet)");
  add(g.put_wall_2,  "Put Wall 2 (magnet)");
  add(g.vol_trigger, "Vol Trigger");
  add(g.max_pain,    "Max Pain");

  // ── 0DTE ────────────────────────────────────────────────────────────────
  const z = ok.zero_dte || {};
  add(z.gamma_flip,      "0DTE Gamma Flip");
  add(z.gamma_wall_call, "0DTE Call Wall");
  add(z.gamma_wall_put,  "0DTE Put Wall");
  add(z.range_1s_high,   "0DTE +1s");
  add(z.range_1s_low,    "0DTE -1s");

  // ── vanna + charm walls: whole chain, and the front expiry's own ─────────
  // Sign carries the reading (data.js GREEKS): vanna + = falling IV makes dealers BUY there,
  // charm + = decay makes dealers BUY into the close. A "−" wall is the opposite drift.
  for (const [key, name] of [["vanna", "Vanna"], ["charm", "Charm"]]) {
    const raw = ok[key];
    if (!raw) continue;
    for (const w of greekWalls(raw, spot)) add(w.strike, `${name} Wall ${w.sign > 0 ? "+" : "−"}`);
    const exps = greek("", raw, null).expiries;
    const front = frontExpiryIndex(exps);
    const ftag = exps[front]?.tag ?? "0DTE";   // "1DTE" after the close, when tomorrow is the front
    for (const w of greekWalls(raw, spot, { perSign: 1, share: 0.4, expIdx: front })) add(w.strike, `${ftag} ${name} ${w.sign > 0 ? "+" : "−"}`);
  }

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

  // ── desk board (AI / rule levels + IV walls) ────────────────────────────
  const b = ctx?.desk?.board;
  for (const l of b?.levels || []) {
    const side = l.side === "support" ? "Sup" : "Res";
    add(l.strike, isNum(l.reversal_prob) ? `Desk ${side} ${l.reversal_prob}%` : `Desk ${side}`);
  }
  // IV walls: the FROZEN bracket (cloud open-frozen today → desk file → live as a last resort).
  // The live one shrinks ~4x through the day and filled at half the frozen rate in the study.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  let w = ok.ivtape?.date === today && ok.ivtape?.open_walls ? ok.ivtape.open_walls : (b?.iv_walls || null);
  let src = w ? "IV Wall" : "IV Wall (live)";
  if (!w) { try { w = liveIvWalls(ok.net_iv, spot, etNow().minutes); } catch { w = null; } }
  add(w?.u_outer, `${src} Upper Outer`);
  add(w?.u_inner, `${src} Upper Inner`);
  add(w?.l_inner, `${src} Lower Inner`);
  add(w?.l_outer, `${src} Lower Outer`);

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
