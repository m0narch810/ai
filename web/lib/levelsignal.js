// LEVEL SIGNAL — the only rules that survived the 2026-09-17 studies, applied live to each strike.
//
// Every rule here carries its evidence in `why`, and nothing is printed as a probability. What the studies
// (docs/studies/: forward_2025, ivwalls_2224, wholechain_2022, live_precision, precise_leadup, far_travel,
// far_travel2, volnode, afternoon_walls) actually support:
//
//   DAY GATE  the expected move LEFT to the close must be ≥120 MNQ. The only filter that passed a
//             pre-registered test in all four test periods (+3.5 to +6.0 pts on "runs 120 before the 15 stop").
//             Under that, a 15-MNQ stop is inside the noise: quiet days ran 120 on 5% of fills vs 15-16% on wide ones.
//   SKIP      support reached while ATM IV is FALLING ≥0.5 vol pt — the one rule replicated five separate times
//             (2022-24 approaches, 2025 forward test, IV walls, whole chain, and this desk's own live feed:
//             26%/20% reaction vs 37%/35% when flat, −4 to −5 MNQ per trade).
//   SKIP      a wall sitting in heavily traded price (top tercile of the session's volume profile): the worst
//             cell in both live halves, 5.8%/2.3% vs a 10%/7% base, −6.2/−5.1 MNQ per trade.
//   MINUS     a wall before 11:30 (live 23.9% vs 27.1% for ordinary strikes; the afternoon is the better wall
//             window, 30.0% vs 24.0% — but 2022-23 says the opposite, so it is a tilt, never a gate).
//   PLUS      the 0DTE gamma flip within 1.2 pts of the strike (part of the only recipe with a same-sign lift:
//             RTH 34.8%/42.5% vs 30.0%/33.4%).
//   PLUS*     the next heavy strike 80 MNQ – 0.8E ahead in the trade direction. Biggest gap of anything tested
//             (+7.3/+8.4) but it failed the sample-size bar (87 trades), so it is marked UNCONFIRMED.
//   EXIT      target +40 MNQ, stop 15. +80 came out near zero and holding to the close lost in every group.
//
// What is deliberately NOT here: gamma/charm/vanna/theta size or alignment at the strike, named walls as such,
// OI, "already traded today", session extremes, volume climax, round numbers, stretch from VWAP/open, gap zones.
// All tested, all null. Do not add one back without a study that beats the same both-halves bar.

import { isNum, etNow } from "./util.js";
import { greek } from "./data.js";

const MNQ = 40.7;
export const TARGET_MNQ = 40, STOP_MNQ = 15, ROOM_MNQ = 120;

/** Minutes from now to the 16:00 ET cash close (0 outside RTH). */
function minsToClose(now = etNow()) {
  const m = now.minutes;
  return m >= 570 && m < 960 ? 960 - m : 0;
}

/** Expected move still left in the session, in MNQ points. */
export function roomLeft(spot, atmIvPct, now = etNow()) {
  const mtc = minsToClose(now);
  if (!isNum(spot) || !isNum(atmIvPct) || atmIvPct <= 0 || mtc <= 0) return NaN;
  return spot * (atmIvPct / 100) * Math.sqrt(mtc / 525600) * MNQ;
}

/** Today's traded-volume profile from the 5-min chart: {volume at each whole strike} over ±2.5% of spot. */
export function volumeProfile(candles, spot) {
  const out = new Map();
  if (!Array.isArray(candles) || !isNum(spot)) return out;
  for (const c of candles) {
    const hi = c.high ?? c.h, lo = c.low ?? c.l, v = c.volume ?? c.v;
    if (!isNum(hi) || !isNum(lo) || !isNum(v) || v <= 0) continue;
    const a = Math.round(lo), b = Math.round(hi), n = b - a + 1;
    for (let k = a; k <= b; k++) out.set(k, (out.get(k) || 0) + v / n);
  }
  return out;
}

/** Tercile of a strike's traded volume within ±2.5% of spot: "high" | "mid" | "low" | null. */
export function volumeNode(profile, K, spot) {
  if (!profile?.size || !isNum(spot)) return null;
  const band = [...profile.entries()].filter(([k]) => Math.abs(k - spot) <= spot * 0.025);
  if (band.length < 10) return null;
  const vals = band.map(([, v]) => v).sort((a, b) => a - b);
  const v = profile.get(Math.round(K));
  if (!isNum(v)) return null;
  const lo = vals[Math.floor(vals.length / 3)], hi = vals[Math.floor((2 * vals.length) / 3)];
  return v >= hi ? "high" : v <= lo ? "low" : "mid";
}

/** Heavy strikes from /gex strike_data: |net gex| ≥50% of the band max, or total OI ≥70% of it. */
export function heavyStrikes(gexRaw, spot) {
  const rows = (gexRaw?.strike_data || [])
    .map((r) => ({ K: Number(r.strike), gex: Math.abs((r.call_gex || 0) + (r.put_gex || 0)), oi: (r.call_oi || 0) + (r.put_oi || 0) }))
    .filter((r) => isNum(r.K) && isNum(spot) && Math.abs(r.K - spot) <= spot * 0.015);
  if (rows.length < 8) return [];
  const mg = Math.max(...rows.map((r) => r.gex)), mo = Math.max(...rows.map((r) => r.oi));
  return rows.filter((r) => (mg > 0 && r.gex >= 0.5 * mg) || (mo > 0 && r.oi >= 0.7 * mo)).map((r) => r.K);
}

/**
 * The day gate. `verdict`: "TAKE" (rules apply), "STAND DOWN" (not enough move left), "OFF" (outside RTH).
 */
export function dayGate(ctx) {
  const ok = ctx?.yyy?.ok || {};
  const spot = isNum(ctx?.spot) ? ctx.spot : ok.gex?.spot;
  // /expected_move's ATM IV first: it is the chain IV the studies measured. zero_dte's own ATM IV is the
  // dying 0DTE smile and blows past 30% after ~15:00, which would fake a wide-open day gate at the close.
  const iv = isNum(ok.expected_move?.atm_iv) ? ok.expected_move.atm_iv : ok.zero_dte?.atm_iv;
  const now = etNow();
  const rth = now.dow >= 1 && now.dow <= 5 && now.minutes >= 570 && now.minutes < 960;
  const room = roomLeft(spot, iv, now);
  if (!rth) return { verdict: "OFF", room, iv, why: "signals are RTH only — every rule was measured on 09:30-16:00 fills" };
  if (!isNum(room)) return { verdict: "OFF", room, iv, why: "no ATM IV yet" };
  return {
    verdict: room >= ROOM_MNQ ? "TAKE" : "STAND DOWN", room, iv,
    why: room >= ROOM_MNQ
      ? `${room.toFixed(0)} MNQ of expected move left — the one filter that passed in all four test periods (runs 120 before the 15 stop: +3.5 to +6.0 pts)`
      : `only ${room.toFixed(0)} MNQ of expected move left (need ${ROOM_MNQ}); on days with this little room fills ran 120 just 5% of the time vs 15-16% on wide ones`,
  };
}

/**
 * Judge one strike. Returns {verdict: "TAKE"|"WATCH"|"SKIP", plus[], minus[], skip[], note}.
 * `side` is "support" (buy) or "resistance" (sell).
 */
export function judgeLevel(ctx, K, side, pre = {}) {
  const ok = ctx?.yyy?.ok || {};
  const spot = isNum(ctx?.spot) ? ctx.spot : ok.gex?.spot;
  const st = ctx?.ivstate;
  const gate = pre.gate || dayGate(ctx);
  const room = gate.room;
  const heavy = pre.heavy || heavyStrikes(ok.gex, spot);
  const profile = pre.profile || volumeProfile(ok.chart?.candles, spot);
  const now = etNow();
  const sup = side === "support", s = sup ? 1 : -1;
  const isHeavy = heavy.some((h) => Math.abs(h - K) < 0.01);
  const node = volumeNode(profile, K, spot);
  const skip = [], minus = [], plus = [];

  if (sup && st?.status === "ok" && st.d30 <= -0.005)
    skip.push({ tag: "IV falling into a support", why: "the one rule replicated five times (2022-24, 2025, IV walls, whole chain, this feed): 20-26% react vs 35-37% on flat IV, −4 to −5 MNQ per trade" });
  if (isHeavy && node === "high")
    skip.push({ tag: "wall in heavily traded price", why: "worst cell in both live halves: runs 120 on 5.8%/2.3% vs a 10%/7% base, −6.2/−5.1 MNQ per trade — the market has already done its business there" });
  if (isHeavy && now.minutes < 690)
    minus.push({ tag: "wall before 11:30", why: "live: walls react 23.9% in the morning vs 27.1% for ordinary strikes; the afternoon is the better wall window (30.0% vs 24.0%) — 2022-23 disagrees, so this is a tilt, not a gate" });

  const flip = isNum(ok.zero_dte?.gamma_flip) ? ok.zero_dte.gamma_flip : ok.gex?.vol_trigger;
  if (isNum(flip) && Math.abs(flip - K) <= 1.2)
    plus.push({ tag: "0DTE flip within 1.2", why: "part of the only recipe with a same-sign lift (RTH 34.8%/42.5% vs 30.0%/33.4% reaction)" });
  const ahead = heavy.filter((h) => (h - K) * s > 0).map((h) => Math.abs(h - K) * MNQ).sort((a, b) => a - b)[0];
  if (isNum(ahead) && isNum(room) && ahead >= 80 && ahead <= 0.8 * room)
    plus.push({ tag: `next heavy strike ${ahead.toFixed(0)} MNQ ahead`, why: "UNCONFIRMED: biggest gap of anything tested (+7.3/+8.4 pts) but only 87 trades, below the sample bar" });
  if (node === "low")
    plus.push({ tag: "low-volume price", why: "mild and unconfirmed: +1.0/+4.0 pts, the only group that was near flat on money" });

  let verdict = "WATCH";
  if (skip.length || gate.verdict === "STAND DOWN") verdict = "SKIP";
  else if (gate.verdict === "TAKE" && plus.length && !minus.length) verdict = "TAKE";
  return { K, side, verdict, skip, minus, plus, node, isHeavy, room,
    note: `limit at ${K}, stop ${STOP_MNQ} MNQ, target +${TARGET_MNQ} MNQ (+80 tested near zero, holding to the close lost in every group)` };
}

/** Candidate strikes within reach: whole strikes inside ±0.8 of the move left, nearest first (max 8). */
export function candidates(ctx) {
  const ok = ctx?.yyy?.ok || {};
  const spot = isNum(ctx?.spot) ? ctx.spot : ok.gex?.spot;
  const gate = dayGate(ctx);
  if (!isNum(spot)) return { gate, rows: [] };
  const reach = isNum(gate.room) ? Math.max(1, (0.8 * gate.room) / MNQ) : 3;
  const heavy = heavyStrikes(ok.gex, spot), profile = volumeProfile(ok.chart?.candles, spot);
  const rows = [];
  for (let K = Math.ceil(spot - reach); K <= Math.floor(spot + reach); K++) {
    if (Math.abs(K - spot) < 0.2) continue;
    rows.push(judgeLevel(ctx, K, K < spot ? "support" : "resistance", { gate, heavy, profile }));
  }
  rows.sort((a, b) => Math.abs(a.K - spot) - Math.abs(b.K - spot));
  return { gate, rows: rows.slice(0, 8) };
}
