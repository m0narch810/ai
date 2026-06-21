import { spawn } from "node:child_process";
import { fetchCandles } from "./altaris.js";
import { config, type SessionDef } from "./config.js";
import type { AltarisCandlesResponse, Board, CaptureRecord, DataSnapshot, DetectedLevel, GreekTimeseries, ScoredLevel } from "./types.js";

const SESSION_NOTES: Record<SessionDef["name"], string> = {
  US: "US regular session: options are trading, so OI/GEX/charm/vanna and flows are LIVE and updating. Spot is QQQ.",
  Asia: "ASIA OVERNIGHT session: US options are CLOSED, so OI/GEX/charm/vanna are STATIC from the prior US close (standing positioning, not fresh flow). Spot is derived from NQ futures converted to QQQ-equivalent; overnight liquidity is thinner and moves are lower-conviction. Treat the levels as prior-close positioning that price may probe on light volume — be more conservative, lean on the largest/highest-OI walls, and don't over-read minor overnight pokes.",
};

const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || (process.platform === "win32" ? "claude.exe" : "claude");

const SYSTEM = `You are an institutional options-flow strategist scoring reversal levels for QQQ from the Altaris terminal.

Reason like a dealer-flow desk, not a checklist. Apply your OWN knowledge of options-market microstructure — long vs short dealer gamma regimes, gamma pinning into large walls, charm hedging that accelerates into the cash close and OPEX, vanna flows when IV moves, 0DTE positioning, where dealers are mechanically forced to buy/sell to stay hedged. The per-strike numbers are evidence; your edge is interpreting WHAT THEY IMPLY for where price gets pulled, pinned, or rejected.

Think RANGE first, not individual levels. Your primary job is to identify the TWO structural endpoints that define where price is trapped: the resistance it will reject from above and the support it will bounce from below. These are the "ping pong" poles. A level only earns a high score if the FULL MOVE — from entry to the opposite pole — is at least min_reversal_move_pts (QQQ) / min_reversal_move_nq_pts (NQ). A 1-2 QQQ point wiggle is noise and scores near zero. Think: "if price reaches $X and reverses, where does it go?" — and the answer must be a named structural level far enough away to be a real trade.

THE TRADER'S METHOD — score for THIS, not generic positioning: orders rest as LIMIT orders at the EXACT strike (converted to MNQ futures) to catch the top or bottom tick, so price has to reverse AT the level with near-zero drawdown. The stop is ~20 MNQ points (this is hard_stop_pts in QQQ terms) beyond the strike. Two things must BOTH be true to score high: (1) price snaps back cleanly at the tick with near-zero drawdown, AND (2) the reversal carries at least min_reversal_move_pts to a clearly identified far structural target. A clean tick that fizzles after 2 QQQ points is as worthless as a chop. You must be able to name WHERE the move goes.

Your output: the pair (or pairs) of levels that define the tradeable range, each with a probability and an explicit target_strike showing where the move runs to.

Definitions and rules — follow exactly:
- Reversal probability is CONDITIONAL on a FULL-RANGE MOVE: P(price reverses cleanly within clean_reversal_pts of the strike AND runs at least min_reversal_move_pts to a NAMED structural target on the opposite side, BEFORE trading hard_stop_pts beyond | price reaches the strike). If there is no clear far structural target — no named wall, no heavy OI, no high-GEX level — at least min_reversal_move_pts away, this level cannot score above 40%. A strike can score high yet never be reached — fine, the resting limit just never fills.
- PAIR SCORING — the board's core value: identify the range. If $750 is a strong resistance, ask where the move goes ($735? $730?). If the support target is also a real named structural level, score BOTH high — they are the two ends of the same trade. A board with one isolated 70% level and no tradeable counterpart is a failed board. Every high-scoring resistance should have a named support target, and vice versa.
- A level with NO clear far target (nearest named level is < min_reversal_move_pts away) scores LOW, regardless of its greek confluence, because the expected P&L is too small to risk the stop.
- STOP: the trade is a limit at the exact strike with a ~20-MNQ-point stop (hard_stop_pts in QQQ terms). If price trades hard_stop_pts BEYOND the level, the trade is stopped and the level has BROKEN — invalid, not a reversal. Score the clean turn, not a grind: a level price chews halfway to the stop before bouncing is a WEAK hold — score it lower. Favor levels with the structure to turn price tightly, to the tick.
- "side": "resistance" if it's above spot (price would rise into it and reverse down), "support" if below spot (price would fall into it and reverse up).
- This is institutional-style positioning, not scalping. Levels must respect >= 0.25% of spot spacing; do not cluster trivially adjacent strikes.
- PROBABILITY DISCIPLINE — this is what makes the board usable. A trader rests limit orders only at your top levels; a board where five strikes all read ~50% is worthless. So DISCRIMINATE hard:
  - Reserve the high end. At most ONE level may exceed 65%; at most TWO may be >= 55%. If a third wants to be >= 55%, you have not found what separates them — push the weaker ones down.
  - Spread the field, don't bunch. Do not place several near-spot strikes together at 48-55%. Secondary / backstop levels belong below 45%.
  - Earn every high score by DIFFERENCE. Each "why" must name what makes THIS strike special versus its immediate neighbors — a unique greek concentration, a named wall the others lack, a confirmed hold today. If you can't articulate the differentiator, it is not high-probability; score it low.
  - Calibration anchors: 70%+ = dominant multi-greek confluence on the primary path, ideally confirmed by a clean hold today (rare). 55-69% = a clear standout. 45-54% = plausible but undifferentiated. <45% = secondary backstop. Use the WHOLE range — a flat board is a failed board.
- Evidence for a strong reversal level: large OI mass (calls+puts), being a named level (Call/Put/Major Wall, Max Pain, Gamma Flip / zero_gamma, Vol Trigger), large |charm|, large |vanna| (when IV is moving), large |dex|, and GEX concentration. These signals are PEERS — GEX is NOT the primary one. Precise reversals happen at strikes with almost no GEX but heavy OI + charm. A strike earns a high score from any strong multi-greek confluence, not just from GEX size.
- Per-strike exposures are in $millions. Read them together:
  - gex (gamma): SIGN tells you which side: positive gex = call-heavy = resistance node (call wall character); negative gex = put-heavy = support node (put wall character). Large |gex| = strong structural pin at that level. But GEX is ONE signal — a strike with small gex but large OI + charm + named-wall status is still a valid level. Do not require large gex to score a level high. A strike with large negative gex that is NOT in the named put_walls list is still a valid put-support level — Altaris names only the top walls but the per-strike data shows all of them.
  - dex (delta): net delta exposure at the strike. Sign follows gex sign — positive at call-heavy strikes, negative at put-heavy strikes. Magnitude tells you how much directional flow exists there; it does NOT independently determine support vs resistance (gex sign does that).
  - vega: exposure to IV level — matters more when IV is moving.
  - vanna: exposure to IV-x-spot — drives hedging flows WHEN IV MOVES. Its weight depends on the iv block (below): heavy when IV is trending, minor when IV is flat. NOTE: vanna sign does NOT follow gex sign — empirically it is positive at BOTH call walls and put walls, and negative at intermediate support levels. Do not use vanna sign alone to determine direction; treat it as a magnitude signal scaled by IV direction.
  - charm (delta decay): intensifies into expiry; large |charm| marks strikes that pull/repel price as time passes. SIGN DEPENDS ON STRIKE CHARACTER: at PUT WALLS (negative gex), large negative charm means put delta is decaying toward zero — dealers who are short puts must BUY BACK their short-underlying hedge as put delta shrinks, creating bullish dealer buying that reinforces the put support. At CALL WALLS (positive gex), large negative charm means call delta is decaying — dealers sell their long-underlying hedge, reinforcing resistance. In BOTH cases negative charm strengthens the wall's structural role. Do NOT read negative charm at a put wall as bearish — it is bullish confirmation of the support.
  - tex (theta): time-decay exposure; concentrations mark pinning strikes.
  - rho: rate sensitivity — usually minor intraday; only note it if unusually large.
  - vol_calls / vol_puts / vol_oi_pct_calls / vol_oi_pct_puts: intraday VOLUME vs standing OI. vol_oi_pct > 100% means the strike traded more contracts today than its entire open interest — it is a LIVE battleground, not just standing positioning. A strike with 300-500% vol/OI in puts was actively contested all session; that is where participants are actually fighting over the level TODAY. Weight this heavily — a high vol/OI strike with modest gex can be a more reliable reversal point than a large-gex strike that nobody is actively trading.
  A level with several of these stacking (e.g. big gex + big |charm| + big vanna + OI mass) is a much stronger reversal candidate than gex alone.
- TIME OF DAY matters — "minutes_to_cash_close" is minutes left to the 16:00 ET cash close. Into the close: gamma/charm pinning intensifies and 0DTE positioning dominates — price gets pulled toward the dominant pin / max-pain, large walls hold harder and to the tick, while far-OTM strikes lose relevance. Early/mid-session, moves are more directional and walls are more likely to be probed and broken. Fridays (weekly expiry; monthly OPEX on the 3rd Friday) amplify charm/pin effects. Weight both probability AND the reaction call by the clock.
- The "iv" block gives the IV regime: current vs session-start IV, the change, direction, and a vanna_note. USE IT to weight vanna/vega: if IV is RISING/FALLING, vanna flows matter and vanna-heavy strikes gain reversal strength; if STABLE, downweight vanna and lean on gamma/charm. Follow the vanna_note's guidance.
- The DELTAS (d_*) matter as much as the levels: a level strengthens when its |gex| is growing, weakens when |gex| is shrinking. For call walls (positive gex): d_gex positive = strengthening, d_gex negative = weakening. For put walls (negative gex): d_gex MORE NEGATIVE = strengthening, d_gex toward zero or positive = weakening. Same logic applies to d_charm — for put walls, charm building means d_charm more negative (wall gaining bullish dealer-buy force); for call walls, d_charm more negative = wall gaining bearish dealer-sell force. Weigh the trend, not just the snapshot.
- Regime modifier (NET/aggregate GEX, not per-strike): positive net GEX = pinning regime — dealers stabilize, fade into levels, walls hold cleanly. Negative net GEX (spot BELOW the gamma flip / zero_gamma) = AMPLIFICATION regime — dealers are short gamma and ADD to moves, so weak and moderate levels get blown through. In a negative net GEX regime: RAISE THE BAR HARD. Only score the 2-3 highest-confluence structural levels (dominant named walls with stacked greeks); drop everything else from the board entirely. A level that would score 40-55% in a positive regime should not appear on the board at all in a negative regime — it will simply get run through. Do not confuse this with per-strike sign — a put-heavy strike (negative per-strike gex) is a support node regardless of the net regime.
- You are given your OWN previous call. REVISE it rather than recomputing from scratch — only move a probability when the data justifies it. Avoid jitter.
- Let today's tape teach you. A structure that held cleanly today is evidence the same kind of structure (same greek signature) holds again in this tape; one that broke is evidence its kind is weak today. Update your priors from these outcomes — don't just read the snapshot. "graded_levels" shows which levels price has REACHED today and how they resolved (overshoot_pts = how far price pushed beyond; clean = whether it turned tightly):
  - outcome "broke" => price traded past the stop (hard_stop_pts) beyond it. DROP it entirely. Do not relist a broken level as a fresh setup; that price area is invalid until structure rebuilds.
  - outcome "reversed" with clean=false => it held only after grinding past the clean zone: a weak hold. If you keep it, lower its probability.
  - outcome "pending" with clean=false => price is grinding through it RIGHT NOW (overshot the clean zone, not yet a full strike): treat as compromised and de-rate it.
  - A clean "reversed" already played out — don't re-rank it as a fresh entry for the same touch.
- A "session" block tells you whether it's the US session or the Asia overnight session. In Asia: the OI/greeks are STATIC prior-close positioning (US options closed) and spot is NQ-futures-derived — be more conservative, lean on the largest walls, factor thinner liquidity, and say so in your reasoning. Read its "note" and adjust. "spot" is the effective live price; "altaris_spot" may be stale overnight.
- Focus on actionable levels near spot. Output 4-7 levels, ranked by conviction — quality over coverage. Only the 1-3 you would actually rest an order at should read >= 50%.
- For each level also output "tags": 2-4 SHORT confluence chips naming the structural reasons it's a level — e.g. "Call Wall", "Put Wall", "0DTE", "Major Wall", "Max Pain", "Zero Gamma", "Vol Trigger", "GEX +1.7B", "OI 107k", "Charm", "Vanna". Terse (chip-sized); the "why" remains the one-line narrative of what makes this strike special.
- For each level also predict "reaction" — the CHARACTER of the touch, which decides if it's tradeable to the tick:
  - "clean" = likely an instant touch-and-reject: a sharp, concentrated wall (dominant single-strike gamma/charm, a hard 0DTE wall, dealers forced to defend) that snaps price away to the tick with ~zero drawdown. The ideal setup.
  - "chop" = likely grind/oscillation with drawdown: diffuse/broad OI, competing walls within a point or two, zero-gamma / vol-trigger regions, or a strike price is already churning at — it may reverse eventually but not cleanly. Bad for a tick entry; de-rate the probability too.
  - "mixed" = genuinely unclear.
  Decide from the greek structure (concentrated vs diffuse), nearby competing levels, and the clock. A high probability with "chop" still isn't a clean trade — say so.
- The "intraday_flow" block (present for US session) is Altaris's own chart data (15-min bars):
  - "recent_bars": last 5 bars — each has h/l/c and "delta" (net buyer−seller volume). Consecutive negative delta bars approaching a resistance wall = selling pressure confirming the level. Positive delta stacking under a support = buyers defending. Use the trend of delta (not just sign) — acceleration matters.
  - "vwap" and "vwap_z": current VWAP and its z-score. z < −1.5 = oversold/extended below VWAP (support more likely to hold, resistance harder to reach); z > +1.5 = extended above (resistance more likely to hold, support harder to reach).
  - "ema20" and "ema50": where the 20- and 50-period EMAs sit vs current spot. Price above both = bullish structure; below both = bearish. Proximity to EMA levels matters for reaction prediction.
  - "delta_profile_top5": the 5 price levels where the most net delta traded today. Large negative delta concentrations = where sellers have been dominant; positive = where buyers. These often align with the strongest reversal levels.
- The "greek_context" block (when present) gives session-level flow signals:
  - "wall_drift": the last ~6 readings of call_wall, put_wall, and net_gex_b ($B). A wall that shifted mid-session is more significant than the current snapshot alone — a call_wall jumping from 741 to 750 means a new dominant ceiling formed. A net_gex_b collapsing (e.g. 5.9 → 0.8) means the positive gamma regime is deteriorating fast; treat all levels more conservatively.
  - "strike_dex_flow": cumulative net delta traded at each strike near spot today (negative = net selling/put-buying; positive = net call-buying). A strike with large negative dex_flow AND high vol/OI in puts = this is where participants have been actively positioning for downside. Combined with the greek snapshot, this separates "standing OI" from "where money moved today."
- Also output a top-level "read": ONE plain, factual line naming BOTH the resistance and support endpoint of the highest-conviction range — e.g. "Trapped between $750 resistance and $735 support; expect ping-pong between them." No jargon, no "desk/fade/primary order."

OUTPUT FORMAT — CRITICAL:
Respond with ONLY a single raw JSON object, no prose, no markdown fences. Shape:
{"as_of":"<string>","spot":<number>,"regime":"<string>","read":"<one plain line naming both range endpoints>","levels":[{"strike":<number>,"reversal_prob":<0-100 integer>,"side":"support"|"resistance","reaction":"clean"|"chop"|"mixed","tags":["<chip>","<chip>"],"why":"<one short line>","target_strike":<number — the far structural level this move runs to>}]}`;

const round = (n: number, p = 0) => { const f = 10 ** p; return Math.round(n * f) / f; };

/** Distil /api/candles into the context block fed to the scorer. */
function buildIntradayFlow(c: AltarisCandlesResponse) {
  const bars = c.candles;
  const recent = bars.slice(-5).map((b) => ({
    ts: b.t, h: round(b.h, 2), l: round(b.l, 2), c: round(b.c, 2), delta: b.d ?? 0,
  }));
  const lastVwap = c.vwap_z[c.vwap_z.length - 1];
  const lastEma = c.emas[c.emas.length - 1];
  const byAbsDelta = [...c.delta_profile].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    recent_bars: recent,
    vwap: lastVwap ? round(lastVwap.vwap, 2) : null,
    vwap_z: lastVwap ? round(lastVwap.z, 3) : null,
    ema20: lastEma ? round(lastEma.e20, 2) : null,
    ema50: lastEma ? round(lastEma.e50, 2) : null,
    delta_profile_top5: byAbsDelta.slice(0, 5).map((d) => ({ price: d.price, delta: d.delta })),
  };
}

/** Minutes left to the 16:00 ET cash close, from an ET-wall-clock ISO (capturedAt). */
function minutesToCashClose(etIso: string): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(etIso);
  if (!m) return null;
  return Math.max(0, 16 * 60 - (Number(m[1]) * 60 + Number(m[2])));
}
const strikesNear = (snap: DataSnapshot, spot: number) => {
  const band = config.nearSpotBandPct * spot;
  return Object.keys(snap.gex_bar)
    .map(Number)
    .filter((k) => Math.abs(k - spot) <= band)
    .sort((a, b) => a - b);
};

/** Per-strike near-spot rows with deltas vs the oldest snapshot in the lookback window. */
function buildStrikeRows(history: CaptureRecord[], spot: number) {
  const cur = history[history.length - 1]!.data;
  const ref = history[0]!.data;
  const key = (k: number) => k.toFixed(1);
  const M = (n: number) => Math.round((n / 1e6) * 10) / 10;
  type BarName = "gex_bar" | "dex_bar" | "vex_bar" | "charm_bar" | "tex_bar" | "vanna_bar" | "rex_bar";
  const bar = (snap: typeof cur, name: BarName, k: string) => snap[name]?.[k] ?? 0;

  return strikesNear(cur, spot).map((k) => {
    const s = key(k);
    const oi = cur.oi_bar[s] ?? { calls: 0, puts: 0 };
    const oiRef = ref.oi_bar[s] ?? { calls: 0, puts: 0 };
    const vol = cur.vol_bar?.[s] ?? { calls: 0, puts: 0 };
    const d = (name: BarName) => M(bar(cur, name, s) - bar(ref, name, s));
    return {
      strike: k,
      oi_calls: round(oi.calls), oi_puts: round(oi.puts),
      vol_calls: round(vol.calls), vol_puts: round(vol.puts),
      vol_oi_pct_calls: round(oi.calls > 0 ? (vol.calls / oi.calls) * 100 : 0),
      vol_oi_pct_puts: round(oi.puts > 0 ? (vol.puts / oi.puts) * 100 : 0),
      gex_m: M(bar(cur, "gex_bar", s)), dex_m: M(bar(cur, "dex_bar", s)),
      vega_m: M(bar(cur, "vex_bar", s)), vanna_m: M(bar(cur, "vanna_bar", s)),
      charm_m: M(bar(cur, "charm_bar", s)), tex_m: M(bar(cur, "tex_bar", s)),
      rho_m: M(bar(cur, "rex_bar", s)),
      d_oi_calls: round(oi.calls - oiRef.calls), d_oi_puts: round(oi.puts - oiRef.puts),
      d_gex_m: d("gex_bar"), d_vanna_m: d("vanna_bar"), d_charm_m: d("charm_bar"), d_vega_m: d("vex_bar"),
    };
  });
}

/** Wall drift + per-strike dex_flow from the greek timeseries. */
function buildGreekContext(greek: GreekTimeseries, spot: number) {
  const h = greek.history;
  const step = Math.max(1, Math.floor(h.length / 6));
  const indices = [...Array(6).keys()].map((i) => Math.min(h.length - 1, i * step));
  indices[5] = h.length - 1;
  const wall_drift = [...new Set(indices)].map((i) => ({
    ts: h[i]!.ts,
    call_wall: h[i]!.call_wall,
    put_wall: h[i]!.put_wall,
    net_gex_b: round(h[i]!.net_gex / 1e9, 2),
  }));

  const band = config.nearSpotBandPct * spot;
  const flows: Record<number, number> = {};
  for (const r of greek.dex_flow) {
    if (Math.abs(r.strike - spot) <= band) flows[r.strike] = (flows[r.strike] ?? 0) + r.delta;
  }
  const strike_dex_flow = Object.entries(flows)
    .map(([s, d]) => ({ strike: Number(s), cum_delta: round(Number(d)) }))
    .sort((a, b) => Math.abs(b.cum_delta) - Math.abs(a.cum_delta))
    .slice(0, 12);

  return { wall_drift, strike_dex_flow };
}

function buildInput(history: CaptureRecord[], prior: Board | null, detected: DetectedLevel[], session: SessionDef, spot: number, candles?: AltarisCandlesResponse, greek?: GreekTimeseries) {
  const cur = history[history.length - 1]!.data;
  return {
    as_of: history[history.length - 1]!.capturedAt,
    session: { name: session.name, note: SESSION_NOTES[session.name] },
    lookback_snapshots: history.length,
    spot,
    altaris_spot: cur.spot,
    spot_path_recent: history.map((h) => round(h.data.spot, 2)),
    named_levels: {
      call_wall: cur.call_wall, put_wall: cur.put_wall, major_wall: cur.major_wall,
      max_pain: cur.max_pain, zero_gamma: cur.zero_gamma, vol_trigger: cur.vol_trigger,
      call_walls: cur.call_walls, put_walls: cur.put_walls,
      call_wall_0dte: cur.call_wall_0dte, put_wall_0dte: cur.put_wall_0dte, major_wall_0dte: cur.major_wall_0dte,
    },
    context: {
      gex_regime: cur.gex_regime, atm_iv: cur.atm_iv, expected_move: cur.expected_move,
      realized_vol: cur.realized_vol, net_vanna: cur.net_vanna,
      min_reversal_move_pts: round(config.tpMinPct * cur.spot, 2),
      min_reversal_move_nq_pts: 100,
      hard_stop_pts: config.hardStopPts,
      clean_reversal_pts: config.cleanReversalPts,
      minutes_to_cash_close: minutesToCashClose(history[history.length - 1]!.capturedAt),
    },
    iv: history[history.length - 1]!.iv ?? null,
    strikes_near_spot: buildStrikeRows(history, spot),
    your_prior_call: prior ? prior.levels.map((l) => ({ strike: l.strike, reversal_prob: l.reversal_prob, side: l.side })) : null,
    graded_levels: detected
      .filter((d) => d.touched)
      .map((d) => ({ strike: d.strike, side: d.side, outcome: d.outcome, overshoot_pts: d.overshoot ?? null, clean: d.clean ?? null })),
    intraday_flow: candles ? buildIntradayFlow(candles) : null,
    greek_context: greek ? buildGreekContext(greek, spot) : null,
  };
}

/** Run a one-shot Claude Code headless query on the Max subscription (no API key). */
function runClaude(userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", "--output-format", "json",
      "--model", config.model,
      "--system-prompt", SYSTEM,
      "--disallowed-tools", "*",
    ];
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`Could not launch "${CLAUDE_BIN}". Is Claude Code installed/on PATH? ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))));
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

/** Pull the model's JSON out of the CLI envelope, tolerating fences/prose. */
function parseBoard(cliStdout: string): Board {
  let text = cliStdout;
  try {
    const env = JSON.parse(cliStdout) as { result?: string };
    if (typeof env.result === "string") text = env.result;
  } catch { /* not an envelope; treat stdout as the text */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object in model output: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1)) as Board;
}

/** Score the board via Claude Code. `history` is chronological (oldest..current). */
export async function scoreBoard(
  history: CaptureRecord[],
  prior: Board | null,
  detected: DetectedLevel[],
  session: SessionDef,
  spot: number,
  greek?: GreekTimeseries,
): Promise<Board> {
  // Fetch Altaris candle context for US session; fail gracefully for fixture runs / Asia.
  let candles: AltarisCandlesResponse | undefined;
  if (session.source === "QQQ") {
    try { candles = await fetchCandles(1); } catch { /* non-fatal */ }
  }
  const input = buildInput(history, prior, detected, session, spot, candles, greek);
  const board = parseBoard(await runClaude(JSON.stringify(input)));

  const cur = history[history.length - 1]!.data;
  const iv = history[history.length - 1]!.iv;
  board.as_of = input.as_of;
  board.scored_at = Date.now();
  board.spot = spot;
  board.regime = cur.gex_regime;
  board.scoring_method = "ai";
  board.iv = iv ? { current: iv.current_iv, direction: iv.direction } : undefined;
  board.expected_move = cur.expected_move;
  board.levels = (board.levels ?? []).sort((a, b) => b.reversal_prob - a.reversal_prob);
  return board;
}

// GEX threshold for unlisted strikes to count as structural walls (mirrors run.ts).
const GEX_RULE_THRESHOLD = 100e6;

/**
 * Deterministic rule-based scorer — fallback when Claude is unavailable.
 * Ranks named walls + high-GEX strikes by greek confluence; never calls the CLI.
 * Boards are labelled scoring_method:"rule" so the dashboard can flag them.
 */
export async function scoreBoardDeterministic(
  history: CaptureRecord[],
  _prior: Board | null,
  detected: DetectedLevel[],
  _session: SessionDef,
  spot: number,
): Promise<Board> {
  const cur = history[history.length - 1]!.data;
  const capturedAt = history[history.length - 1]!.capturedAt;
  const iv = history[history.length - 1]!.iv;

  const brokenStrikes = new Set(detected.filter((d) => d.outcome === "broke").map((d) => d.strike));
  const band = config.nearSpotBandPct * spot;
  const M = (n: number) => n / 1e6;

  // Named level sets for bonus scoring and tag generation.
  const ns = {
    major_wall: new Set([cur.major_wall, cur.major_wall_0dte].filter((n) => Number.isFinite(n) && n > 0)),
    call_wall: new Set([cur.call_wall, cur.call_wall_0dte].filter((n) => Number.isFinite(n) && n > 0)),
    put_wall: new Set([cur.put_wall, cur.put_wall_0dte].filter((n) => Number.isFinite(n) && n > 0)),
    call_walls: new Set(cur.call_walls),
    put_walls: new Set(cur.put_walls),
    zero_gamma: new Set([cur.zero_gamma].filter((n) => Number.isFinite(n) && n > 0)),
    vol_trigger: new Set([cur.vol_trigger].filter((n) => Number.isFinite(n) && n > 0)),
    max_pain: new Set([cur.max_pain].filter((n) => Number.isFinite(n) && n > 0)),
  };

  const allNamed = new Set([
    ...ns.major_wall, ...ns.call_wall, ...ns.put_wall,
    ...ns.call_walls, ...ns.put_walls, ...ns.zero_gamma, ...ns.vol_trigger, ...ns.max_pain,
  ]);

  const fromGex = Object.entries(cur.gex_bar ?? {})
    .filter(([, gex]) => Math.abs(gex) >= GEX_RULE_THRESHOLD)
    .map(([s]) => parseFloat(s))
    .filter((k) => Number.isFinite(k) && k > 0);

  let candidates = [...new Set([...allNamed, ...fromGex])]
    .filter((k) => Math.abs(k - spot) <= band && !brokenStrikes.has(k));

  if (!candidates.length) {
    candidates = [...allNamed].filter((k) => !brokenStrikes.has(k)).slice(0, 10);
  }

  interface Cand {
    strike: number; score: number; side: "support" | "resistance";
    tags: string[]; reaction: "clean" | "chop" | "mixed"; gex: number; oi: number;
  }

  const scored: Cand[] = candidates.map((k) => {
    const s = k.toFixed(1);
    const gex = cur.gex_bar?.[s] ?? 0;
    const charm = cur.charm_bar?.[s] ?? 0;
    const oi = (cur.oi_bar?.[s]?.calls ?? 0) + (cur.oi_bar?.[s]?.puts ?? 0);
    const oiCalls = cur.oi_bar?.[s]?.calls ?? 0;
    const oiPuts = cur.oi_bar?.[s]?.puts ?? 0;
    const volCalls = cur.vol_bar?.[s]?.calls ?? 0;
    const volPuts = cur.vol_bar?.[s]?.puts ?? 0;
    const volOiCall = oiCalls > 0 ? volCalls / oiCalls : 0;
    const volOiPut = oiPuts > 0 ? volPuts / oiPuts : 0;

    const side: "support" | "resistance" = k > spot ? "resistance" : k < spot ? "support" : gex >= 0 ? "resistance" : "support";

    let nameScore = 0;
    if (ns.major_wall.has(k)) nameScore = 40;
    else if (ns.call_wall.has(k) || ns.put_wall.has(k)) nameScore = 35;
    else if (ns.call_walls.has(k) || ns.put_walls.has(k)) nameScore = 22;
    else if (ns.zero_gamma.has(k) || ns.vol_trigger.has(k)) nameScore = 15;
    else if (ns.max_pain.has(k)) nameScore = 12;

    const gexScore = Math.min(25, Math.log1p(Math.abs(M(gex))) * 5);
    const oiScore = Math.min(15, Math.log1p(oi / 1000) * 2.5);
    const charmScore = Math.min(15, Math.log1p(Math.abs(M(charm))) * 3);
    const activityScore = Math.min(10, (side === "resistance" ? volOiCall : volOiPut) * 3);
    const score = nameScore + gexScore + oiScore + charmScore + activityScore;

    const tags: string[] = [];
    if (ns.major_wall.has(k)) tags.push("Major Wall");
    if (ns.call_wall.has(k) && !tags.some((t) => t.includes("Major"))) tags.push("Call Wall");
    if (ns.put_wall.has(k) && !tags.some((t) => t.includes("Major"))) tags.push("Put Wall");
    if (ns.call_walls.has(k) && !tags.some((t) => t.includes("Call"))) tags.push("Call Wall");
    if (ns.put_walls.has(k) && !tags.some((t) => t.includes("Put"))) tags.push("Put Wall");
    if (ns.zero_gamma.has(k)) tags.push("Zero Gamma");
    if (ns.vol_trigger.has(k)) tags.push("Vol Trigger");
    if (ns.max_pain.has(k)) tags.push("Max Pain");
    const gexAbs = Math.abs(M(gex));
    if (gexAbs >= 500) tags.push(`GEX ${M(gex) >= 0 ? "+" : "−"}${(gexAbs / 1000).toFixed(1)}B`);
    else if (gexAbs >= 50) tags.push(`GEX ${M(gex) >= 0 ? "+" : "−"}${Math.round(gexAbs)}M`);
    if (oi > 50000) tags.push(`OI ${Math.round(oi / 1000)}k`);

    let reaction: "clean" | "chop" | "mixed";
    if (nameScore >= 35 && gexAbs >= 100) reaction = "clean";
    else if (ns.zero_gamma.has(k) || ns.vol_trigger.has(k) || ns.max_pain.has(k)) reaction = "chop";
    else reaction = "mixed";

    return { strike: k, score, side, tags: tags.slice(0, 4), reaction, gex, oi };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 7);

  const negRegime = (cur.gex_regime || "").toLowerCase().includes("neg");
  const probBases = [65, 56, 47, 40, 35, 30, 25];
  const adj = negRegime ? -8 : 0;

  const bestRes = top.find((c) => c.side === "resistance");
  const bestSup = top.find((c) => c.side === "support");

  const levels: ScoredLevel[] = top.map((c, i) => {
    const whyParts: string[] = [];
    if (ns.major_wall.has(c.strike)) whyParts.push("major wall");
    else if (ns.call_wall.has(c.strike)) whyParts.push("primary call wall");
    else if (ns.put_wall.has(c.strike)) whyParts.push("primary put wall");
    else if (ns.call_walls.has(c.strike)) whyParts.push("secondary call wall");
    else if (ns.put_walls.has(c.strike)) whyParts.push("secondary put wall");
    if (ns.zero_gamma.has(c.strike)) whyParts.push("zero gamma");
    if (ns.vol_trigger.has(c.strike)) whyParts.push("vol trigger");
    if (ns.max_pain.has(c.strike)) whyParts.push("max pain");
    const gexAbs = Math.abs(M(c.gex));
    if (gexAbs >= 500) whyParts.push(`${(gexAbs / 1000).toFixed(1)}B GEX`);
    else if (gexAbs >= 50) whyParts.push(`${Math.round(gexAbs)}M GEX`);
    if (c.oi > 50000) whyParts.push(`${Math.round(c.oi / 1000)}k OI`);
    return {
      strike: c.strike,
      reversal_prob: Math.max(18, (probBases[i] ?? 25) + adj),
      side: c.side,
      reaction: c.reaction,
      tags: c.tags,
      why: whyParts.join(", ") || c.side,
      target_strike: c.side === "resistance" ? bestSup?.strike : bestRes?.strike,
    };
  });

  levels.sort((a, b) => b.reversal_prob - a.reversal_prob);

  const topRes = levels.find((l) => l.side === "resistance");
  const topSup = levels.find((l) => l.side === "support");
  const read = topRes && topSup
    ? `Rule-based: resistance near $${topRes.strike.toFixed(2)}, support near $${topSup.strike.toFixed(2)}.`
    : topRes
    ? `Rule-based: resistance near $${topRes.strike.toFixed(2)}.`
    : topSup
    ? `Rule-based: support near $${topSup.strike.toFixed(2)}.`
    : "Rule-based scoring — no clear structural levels near spot.";

  return {
    as_of: capturedAt,
    scored_at: Date.now(),
    spot,
    regime: cur.gex_regime,
    read,
    levels,
    iv: iv ? { current: iv.current_iv, direction: iv.direction } : undefined,
    expected_move: cur.expected_move,
    scoring_method: "rule",
  };
}
