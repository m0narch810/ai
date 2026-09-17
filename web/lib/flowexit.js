// FLOW-MANAGED EXIT — the one flow rule that passed (2026-09-17 study, docs/studies/flow_exit_report.md).
//
// The study: on a filled fade, HOLD while cumulative traded delta (CVD) keeps making new extremes in the
// runner's direction, and EXIT the first time CVD stalls for 2 bars. That beat both a fixed +40 target and
// holding-to-the-close in all four test periods (live +5.3/+3.7 vs fixed −3.6/−1.4; history −4.8/−6.3 vs
// −7.7/−8.2). It is an EXIT edge only — flow does NOT pick entries (the veto failed five ways) and does not
// make a bad fade good; entry selection stays the day gate + IV screen (levelsignal.js).
//
// Data: YYY /dealer_anomalies gives the session's per-5-min `bar_deltas` (net traded delta, ±1-ish) + prices.
// This is REAL traded flow, not the OHLCV proxy the backtest used — treat the live read as the better version.

import { isNum } from "./util.js";

const STALL_BARS = 2;

/** Parse /dealer_anomalies into a clean tape: [{t, delta, cvd, price}]. */
export function flowTape(da) {
  const times = da?.times, deltas = da?.bar_deltas, prices = da?.prices;
  if (!Array.isArray(times) || !Array.isArray(deltas) || times.length !== deltas.length) return [];
  let cvd = 0;
  return times.map((t, i) => {
    const d = Number(deltas[i]) || 0; cvd += d;
    return { t, delta: d, cvd, price: isNum(prices?.[i]) ? prices[i] : NaN };
  });
}

/**
 * The current flow state: cumulative delta, its recent direction, and how many bars since CVD last made a new
 * high / new low. `imbalance`, `buy`, `sell` pass through from the endpoint.
 */
export function flowState(da) {
  const tape = flowTape(da);
  if (tape.length < 4) return { status: "empty", tape };
  const cvd = tape.map((r) => r.cvd);
  const now = cvd[cvd.length - 1];
  let barsSinceHigh = 0, barsSinceLow = 0;
  const runMax = Math.max(...cvd), runMin = Math.min(...cvd);
  for (let i = cvd.length - 1; i > 0; i--) { if (cvd[i] >= runMax - 1e-9) break; barsSinceHigh++; }
  for (let i = cvd.length - 1; i > 0; i--) { if (cvd[i] <= runMin + 1e-9) break; barsSinceLow++; }
  const d3 = now - (cvd[cvd.length - 4] ?? 0);
  return {
    status: "ok", tape, cvd: now, d3,
    dir: d3 > 0 ? "buying" : d3 < 0 ? "selling" : "flat",
    barsSinceHigh, barsSinceLow,
    imbalance: da?.imbalance ?? null, buy: da?.buy_count ?? null, sell: da?.sell_count ?? null, z: da?.current_z ?? null,
  };
}

/**
 * Hold-or-exit for a runner on `side` ("support" = you bought, runner is UP; "resistance" = you sold, runner is
 * DOWN). Returns {call: "HOLD"|"EXIT"|"—", why}.
 *   support fade → runner up → track CVD HIGHS; stall = CVD hasn't made a new high in STALL_BARS bars → EXIT.
 *   resistance fade → runner down → track CVD LOWS.
 */
export function holdCall(st, side) {
  if (!st || st.status !== "ok") return { call: "—", why: "no live flow tape yet (needs /dealer_anomalies in the session)" };
  const up = side === "support";
  const stale = up ? st.barsSinceHigh : st.barsSinceLow;
  if (stale >= STALL_BARS)
    return { call: "EXIT", why: `flow stalled — CVD has not made a new ${up ? "high" : "low"} in ${stale} bars; the runner's flow is done (study exit rule)` };
  return { call: "HOLD", why: `CVD still making new ${up ? "highs" : "lows"} (${stale} bars since last) — flow confirms the runner, hold and let it run` };
}
