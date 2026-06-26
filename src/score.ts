import { spawn } from "node:child_process";
import { fetchCandles } from "./altaris.js";
import { config, type SessionDef } from "./config.js";
import { retrieveKnowledge } from "./knowledge.js";
import type { AltarisCandlesResponse, Board, CaptureRecord, CoverageLevel, DataSnapshot, DetectedLevel, GreekTimeseries, Narrative, ScoredLevel } from "./types.js";

/** Compact pre-open call fed into the board scorer to tilt probabilities (see SYSTEM). */
export interface DayContext {
  macro_bias: Narrative["macro_bias"];
  open_type: Narrative["open_type"];
  open_type_label: string;
  expansion_direction: Narrative["expansion_direction"];
  summary: string;
}

/** Distil a Narrative into the tilt context the board scorer consumes. */
export function dayContextFromNarrative(n: Narrative | null): DayContext | undefined {
  if (!n || n.scoring_method === "unavailable") return undefined;
  return {
    macro_bias: n.macro_bias,
    open_type: n.open_type,
    open_type_label: n.open_type_label,
    expansion_direction: n.expansion_direction,
    summary: n.summary,
  };
}

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
- NEAREST BOUNDARY FIRST — the top-probability slots belong to the IMMEDIATE structural boundaries price is currently trading against, not the most massive distant walls. When evaluating any candidate, count how many named structural barriers lie BETWEEN spot and the candidate (put_walls/put_wall/major_wall between spot and a support candidate; call_walls/call_wall/major_wall between spot and a resistance candidate):
  - Zero intervening named walls → immediate boundary; score the full greek confluence.
  - One intervening named wall → backstop; hard cap ≤ 40% regardless of OI size or structural dominance.
  - Two or more intervening named walls → tertiary/deeper backstop; hard cap ≤ 25%.
  Example: spot=$714, named supports exist at $710 and $705 before a massive $700 put wall → $700 is TERTIARY (≤25%) even with 113k OI — it only becomes live if BOTH $710 AND $705 have broken and been confirmed as broken today. A single massive wall 14 pts away with two intervening named supports must NOT score 60%+ and crowd out the current session's active range endpoints.
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
- NEAR-SPOT BATTLEGROUND PRIORITY — a strike WITHIN 4 QQQ POINTS of spot with vol_oi_pct_calls or vol_oi_pct_puts > 200% is an ACTIVE INTRADAY PIVOT where participants are fighting TODAY. This wins a top-slot level over distant structural walls. If $713 shows 400% put vol/OI and sits 1 pt below spot while $700 is a massive standing put wall 14 pts away with two intervening walls, $713 belongs in the top 2 slots (≥50%) and $700 is a tertiary backstop (≤25%). The market reveals its intraday hinges through active volume — trust the live tape over the standing structure when they conflict. A strike marked "battleground: true" in the data has met this criterion and MUST be included on the board if it is near spot.
- TRENDING SESSION BOARD (when Hurst rolling_50 > 0.60): the board paradigm SHIFTS. Do not try to find the range endpoints — in a trending session the range expands and named distant walls get run through before they hold. Instead: (1) fill the top slots with the NEAR-SPOT VOL/OI PIVOTS (battleground strikes or high vol_oi_pct within 4 pts of spot) — these are the intraday pause points where participants defending their positions temporarily halt the trend; (2) use the nearest distant named wall as the target_strike for each near-spot pivot (the move after the pause runs toward it, but that wall itself is not a clean entry in a trending tape); (3) expect SHORTER moves from these pivots — the trend resumes after the pause, so the reaction is "mixed" or "chop" rather than "clean" even when the level holds; (4) do NOT fill the board with distant structural walls that are far from spot and have no active vol/OI concentration — in a trending session they are potential targets, not entries. The board should look like: 2-3 near-spot active pivots (battleground strikes or high vol/OI) as the primary levels, with distant walls appearing only as supporting context in target_strike, not as standalone entries above 35%.
- INITIATIVE vs RESPONSIVE ACTIVITY — every order in the market is either initiative (repricing) or responsive (mean-reverting). This distinction is the deepest explanation for whether a structural wall holds or breaks, and it should govern how you read ALL level confluence in context.
  RESPONSIVE activity: participants reacting to price moving away from perceived fair value. A buyer stepping in at the bottom of a range because price is cheap; a seller stepping in at the top because price is expensive. Responsive activity is what OPTIONS WALLS in positive-gamma regimes enable — dealers stabilizing price by fading moves away from their hedged strikes. In a mean-reverting session (Hurst rolling_50 < 0.5, stable entropy, positive net GEX), RESPONSIVE activity dominates and walls hold reliably because every move away from structure is instantly faded back.
  INITIATIVE activity: participants deciding that current prices are fundamentally wrong and aggressively repricing the market. This activity DOES NOT STOP at structural levels. It continues through them. In a trending session (Hurst > 0.6, negative net GEX, high GARCH persistence), initiative selling or buying dominates and intermediate structural walls are not reversal points — they are SPEED BUMPS or TARGET LEVELS that the initiative move is heading toward. The wall that stops initiative activity is the TERMINAL wall: the one where the initiative participants finally run out of conviction, where absorption is present (heavy counter-flow not giving ground), or where the structural concentration is overwhelming enough to force a pause.
  The board rule: in an initiative regime, include ONLY the terminal boundary (the one dominant wall in the trend's direction where initiative flow is most likely to exhaust) as a high-probability entry. Every intermediate wall that the trend is moving through gets scored as a PASS-THROUGH target, not a standalone reversal entry. A wall in the path of initiative flow gets run through even at 90th-percentile GEX — because the initiative force driving price there is larger than the mechanical hedging response.
  To identify initiative vs responsive: read the 'strike_dex_flow' and 'intraday_flow' data. If cumulative delta has been consistently directional (same sign for most of the session), initiative is dominant. If cumulative delta oscillates — rising then falling then rising — responsive is dominant. Combine with the Hurst/GEX regime for the full picture.

- APPROACH CHARACTER — how price arrives at a level determines whether the first touch holds cleanly or breaks through. This is separate from how strong the structural wall is.
  GRINDING approach (setup coming in clean): delta is FADING as price approaches the level. Volume is thinning. The move into the level is losing its engine before it even touches. The participants who drove the move are running out of conviction. At first contact, the structural force at the level (GEX, OI, absorbed positioning) meets an already-exhausted move. This produces a CLEAN reaction — price snaps back from the level quickly, to the tick. Look for: intraday_flow delta decelerating across the last 2-3 bars approaching the level; strike_dex_flow showing the level being approached but delta fading. In the 'strikes_near_spot' data: approaching strikes show thinning vol_oi_pct on the current bar vs prior.
  IMPULSIVE approach: price moves fast and hard into the level. Wide bars, strong directional delta all the way to the level, no deceleration. An impulsive approach into a wall means the level is being tested under LOAD — the selling or buying pressure is still fully active at first touch. In a positive gamma regime with very strong named walls, this sometimes produces a sharp spike-and-reverse (the wall is overwhelmed briefly then snaps back). More commonly it produces CHOP on first touch — the level breaks slightly or requires a second test before holding. Downgrade the reaction call from "clean" to "mixed" or "chop" for any level being approached with active, sustained directional flow. The SECOND test (where the approach is then responsive rather than impulsive) is often the cleaner entry.

- ABSORPTION vs EXHAUSTION — two distinct signals at a level that determine whether a reversal is coming or merely a pause. Both look like "the level is holding" from price alone, but only one means buyers/sellers have genuinely stepped up.
  ABSORPTION: one side is hitting the market aggressively (heavy vol/OI at this strike, strong directional flow in one direction) and price is NOT RESPONDING proportionally. Heavy selling arriving at a level, delta going negative, and yet price is not falling — or is only ticking slightly lower before recovering. Something large is on the other side, absorbing every seller that comes. The absorbing participant has built a position at a good price; when the selling runs out they push through with conviction. This is the STRONGEST reversal signal and is exactly what a "battleground: true" strike flags — active participants fighting over a specific price level. When a battleground strike shows high vol/OI and price is not breaking despite heavy flow, you are watching absorption. Predict: "clean" once the selling exhausts. The reversal is not a guess — it is the mechanical consequence of absorbed selling with no sellers left.
  EXHAUSTION: the selling (or buying) came in, delta was extreme, and now it is FADING. Vol is thinning. The tape is going quiet at the level. Price is sitting at a low (or high) but nobody is pushing further. The aggressive side finished their business. This is different from absorption — no large buyer stepped in; the sellers just ran out. Exhaustion CLEARS THE PATH for a reversal but does not guarantee one. The price action after exhaustion can sit there or resume in the original direction if new initiative enters. For the reaction call: exhaustion → "mixed" (the condition for reversal is developing but needs a trigger — first aggressive buying/selling in the other direction). Do NOT call "clean" on pure exhaustion without absorption evidence.
  Key tell: in absorption, the aggressive flow is ongoing but price is resisting. In exhaustion, the aggressive flow has already stopped. "battleground: true" + price not breaking = absorption = strong. High prior vol/OI + now thinning = exhaustion = moderate.

- LVN/THIN STRUCTURE AWARENESS — a named wall (call_wall, put_wall, major_wall) tells you ALTARIS has identified a structural GEX concentration. It does not tell you whether real participants have built positions AT that strike. If the per-strike data shows a named wall with: low oi_calls/oi_puts, low vol_calls/vol_puts, vol_oi_pct near 0%, no d_oi_day movement, no battleground flag — that wall is a GHOST WALL. It has mechanical GEX mass on paper but no lived-in positions defending it. In a trending/initiative session these ghost walls get accelerated through, not reversed at, because there are no participants at that exact price defending their entries. The relevant analogy: in volume profile, a price level with no volume (LVN) produces price ACCELERATION through it, not reversal — the market has no memory there, no trapped participants, no business done. A named wall with no live positioning is the options equivalent of an LVN. Conversely, a strike that is NOT a named wall but shows high OI, high vol/OI, and a battleground flag IS a lived-in level — real money is positioned there, participants are defending it, and absorption/exhaustion mechanics apply. When evaluating any named wall: check its per-strike data. Named + high OI + high vol = real. Named + low OI + no vol = ghost. Ghost walls in trending sessions are through-levels, not entries.

- VANNA & CHARM AS FORCED MECHANICAL FLOWS — vanna (vanna_m) and charm (charm_m) are not speculative or directional flows. They are FORCED REBALANCING by dealers and institutions that happens regardless of directional view. Understanding the mechanism makes them more reliable as confluence factors than pure speculation:
  VANNA: measures how much delta shifts when implied volatility changes. When IV spikes (as in a selloff), the delta of every option on the book shifts. Dealers who were delta-neutral are suddenly not — they MUST buy or sell underlying to re-hedge. This is the vanna flow. A strike with large positive vanna_m sits in a zone where a significant amount of this forced rebalancing will occur when IV moves. In a IV-expansion environment (rising/elevated per the iv block), vanna flows are most active and strikes with high |vanna_m| attract mechanical buying/selling that is independent of speculative conviction — it MUST happen because hedges are required.
  CHARM: measures how delta changes as time passes. Into expiration, the delta of every option converges to its terminal value (0 or 1 for calls; -1 or 0 for puts). The convergence requires daily delta re-hedging as the option delta drifts. This produces systematic, predictable order flow in the hours and days before expiration — the directional drift you sometimes see into the close on option-expiry days is charm forcing dealer hedges. A strike with high |charm_m| sits at a level that is attracting this time-driven rebalancing flow continuously as each session progresses. Into the last 2 hours of the session (low minutes_to_cash_close), charm is the dominant mechanical force for 0DTE strikes — the directional drift is dealers re-hedging as theta eats into the delta. This is why charm_0dte_m is a powerful close-of-day signal: it is literally the forced delta rebalancing that must happen before the options expire.
  The practical implication: when evaluating a level, treat high |vanna_m| in a rising-IV environment and high |charm_0dte_m| into the close as ALMOST CERTAIN order flows — not probabilistic confluence, but scheduled mechanical demand/supply. They don't guarantee the level holds because initiative flow can overwhelm them, but they are the most reliable non-speculative flows in the market. Layer them on top of GEX/OI in the confluence read.

- TIME OF DAY matters — "minutes_to_cash_close" is minutes left to the 16:00 ET cash close. Into the close: gamma/charm pinning intensifies and 0DTE positioning dominates — price gets pulled toward the dominant pin / max-pain, large walls hold harder and to the tick, while far-OTM strikes lose relevance. Early/mid-session, moves are more directional and walls are more likely to be probed and broken. Fridays (weekly expiry; monthly OPEX on the 3rd Friday) amplify charm/pin effects. Weight both probability AND the reaction call by the clock.
- SESSION RANGE EXTENSION: the expected_move and realized_vol context lets you assess whether price has reached a statistical range limit for this session. A GEX wall that coincides with the edge of the session's expected daily range has BOTH mechanical dealer hedging AND statistical exhaustion aligned — these produce the sharpest, cleanest reversals. Price arriving at a dominant wall after already covering the day's expected move is an exhausted move running into a forced-buyer barrier: the highest-conviction setup. A GEX wall deep inside the day's range (price barely off the open, still well within expected move) is structural positioning, but without the exhaustion component — approaches are more likely to be probed and passed without clean resolution. Factor this into reaction character: wall-at-range-extension → bias toward "clean"; wall-mid-range → lean toward "mixed" unless greek confluence is extraordinary.
- The "iv" block gives the IV regime: current vs session-start IV, the change, direction, and a vanna_note. USE IT to weight vanna/vega: if IV is RISING/FALLING, vanna flows matter and vanna-heavy strikes gain reversal strength; if STABLE, downweight vanna and lean on gamma/charm. Follow the vanna_note's guidance. ALSO read the vol environment to assess reaction character: vol shocks persist for sessions in equity indices, not hours. When IV is running notably elevated from session open (large positive change, direction=RISING) you are in an elevated vol state where the mechanical behavior of walls changes — the same dominant named wall that gives a tick-perfect clean reversal in a calm session requires multiple test attempts and wider oscillation before holding in an elevated vol state. Adjust reaction predictions accordingly: calm IV → "clean" for dominant named walls; rising/elevated IV → "mixed" for most, "clean" only for the single most concentrated dominant wall; IV shock (sudden large jump intraday) → "chop" for almost everything, restrict the board to 2-3 structural extremes. Reversal_prob stays anchored to structural confluence; the REACTION CHARACTER is what degrades with elevated vol. If a wall turns "chop" in elevated vol, that is a real execution risk — say so explicitly even at high probability.
  The "context" block also includes "atm_iv" (live ATM IV) and "atm_iv_avg" (session-average smoothed ATM IV). The gap between them is an intraday IV signal: if atm_iv >> atm_iv_avg, IV has spiked mid-session above its own average — a vol surge that degrades reaction character on most levels (the spike inflates dealer hedging uncertainty). If atm_iv << atm_iv_avg, IV has compressed intraday — the vol regime is normalizing and reaction character improves. Use this alongside the "iv" block direction to form the sharpest possible picture of intraday vol state.
  Additional context fields: "pc_ratio" (put/call vol ratio, all strikes) — >1.2 = heavy put hedging, fear in market, supports hold harder; <0.7 = call chasing, resistance faces more buying, breakouts more likely. "gex_0dte_ratio" (0DTE GEX fraction, 0-1) — >0.6 = most gamma expires today, strong close pin; <0.3 = multi-expiry book, less same-day sensitivity. "net_charm_near_m" ($M sum of charm across near-spot strikes) — negative = dealers must sell delta into close; positive = must buy; predictable directional drift. "net_vanna_near_m" ($M sum of vanna near spot) — in a rising-IV environment, positive = forced dealer buying; negative = forced selling.
- VOLATILITY RISK PREMIUM (VRP) — the gap between atm_iv and realized_vol is the highest-order structural prior for whether options walls hold. When atm_iv materially exceeds realized_vol, the market is over-hedged: option sellers (including dealers) hold excess theta and are incentivized to maintain positioning around structural levels — walls benefit from this anchoring and mean-reversion character dominates. When realized_vol has exceeded or is approaching atm_iv, the market is under-hedged: hedgers are forced to buy protection at rising premiums mid-session, dealers are dynamically rehedging more aggressively, and structural walls that appear solid on a GEX snapshot get routinely run through by the mechanical buying of late protection. In a negative-VRP environment, lean toward continuation over reversal and bias reaction predictions to "chop" or "mixed" for all but the single most dominant structural barrier — the math that makes walls hold (dealer gamma stabilization) breaks down when the options market itself is under pressure to reprice. The intraday flip from negative to positive VRP (realized vol spike subsiding while IV prices it in) often marks the session transition from directional move to ranging — watch for the iv block direction changing from RISING to STABLE as a confirmation signal. You can assess VRP from context.atm_iv vs context.realized_vol (both in vol-percentage terms); treat the direction and magnitude of the gap as the base prior that greek confluence then modifies — not a separate multiplier, but the background state that determines how hard any given wall actually holds.
- LEFT-TAIL ASYMMETRY — beyond shadow gamma, the risk-neutral probability distribution itself is structurally skewed: in equity indices, the risk-neutral density derived from the options chain has a heavier left tail and lighter right tail than a symmetric lognormal model would produce. This means, mechanically, that the probability mass below spot is greater than the mass above it at equivalent strike distances. The practical consequence: a put support at K points below spot is a more reliable reversal candidate than a call resistance at K points above spot with identical GEX and OI, because the probability density the market itself assigns to price reaching the put support and turning is higher than the equivalent call scenario. When you see two levels with nearly matched greek confluence — one above spot, one below — the put support deserves the higher probability score, not because of any separate rule, but because the market's own pricing of downside risk implies it. This asymmetry is encoded in the skew: a steep risk_reversal (positive) is the market revealing this asymmetry explicitly. But it exists even when the skew is moderate, because it is structural to how equity markets distribute risk. Account for it by systematically rating otherwise-equal put supports above otherwise-equal call resistances when differentiating borderline cases.
- IV SKEW — the per-strike implied-vol smile (nearest expiration). Two places: the "iv_skew" context block (atm_iv, otm_put_iv, otm_call_iv, risk_reversal = OTM-put IV − OTM-call IV), and per-strike "iv" + "iv_vs_atm" on each strike row. Read it as DEMAND, which strengthens levels:
  - A LOCAL IV BUMP at a strike (iv_vs_atm clearly positive vs its neighbours) = concentrated option demand / dealers defending that strike = a STRONGER, CLEANER reversal node. This often marks the exact strike price turns at — weight it like a real confluence alongside gex/charm/OI.
  - risk_reversal strongly POSITIVE (steep put skew) = heavy downside hedging: supports below spot are better-defended (more reliable bounces) and resistances are easier fades on a relief pop. risk_reversal NEGATIVE (call skew) = upside chase: call walls are more likely to be defended/pinned.
  - The skew tape is jumpy near ATM — treat a single noisy print cautiously; trust a bump that lines up with other confluence (a wall, heavy OI, charm) far more than one standing alone.
- SHADOW GAMMA — why skew calibrates dealer exposure beyond what GEX shows: standard options models compute dealer gamma assuming vol stays constant as price moves. For equity indices this assumption is structurally wrong — realized vol rises when price falls and is comparatively stable when price rises. The IV skew on the chain is the market's real-time estimate of this asymmetric vol response: the OTM put IV at a given strike is approximately the vol the market expects if spot falls to that level. This means dealers' actual delta-hedge rebalancing on a downside move is always larger than the model gamma predicts — they must buy more aggressively at a support than the raw GEX number shows, because as price falls, their short-put delta exposure grows faster than the static vol assumption captures. The practical read: when put skew is steep (large positive risk_reversal), the shadow-gamma gap is wide and downside walls are mechanically stronger than GEX alone implies — the forced dealer buying at a major put support is larger than the snapshot shows. When put skew is flat or near zero, GEX is nearly the full story and there is no extra hidden support. When evaluating any support wall, read positive risk_reversal as evidence that the wall is MORE defensible than its raw GEX suggests; a flat or negative risk_reversal means trust the GEX at face value. This is not a multiplier — it is a qualitative calibration of how hard dealers are actually forced to defend a given support level beyond what the model shows.
- 0DTE ISOLATION — the "gex_0dte_m", "charm_0dte_m", "vanna_0dte_m" per-strike fields are the SAME-DAY-expiry slice of gamma/charm/vanna, separated out from the all-expiration "*_m" bars. This is the slice that actually pins price to the tick. WEIGHT IT BY THE CLOCK: as minutes_to_cash_close drops (last 1-2 hours), 0DTE positioning DOMINATES — a strike with huge 0DTE gamma/charm is the pin that holds hardest and cleanest into the close; lean on the 0DTE numbers far more than the all-expiration aggregate there. Early/mid-session 0DTE is one input among many. A strike whose strength is mostly 0DTE will fade after the close; one with strength across expirations is more durable — say which it is.
- OI BUILDING — the "d_oi_day_calls"/"d_oi_day_puts" fields are DAY-OVER-DAY OI change (today vs prior close), distinct from the intraday "d_oi_*". Positive = contracts ADDED overnight/today; this is where new positioning is being laid. Puts growing at/below spot = support being reinforced; calls growing above = resistance building. A wall with growing OI is STRENGTHENING (more reliable hold); one with shrinking OI is being unwound (weakening — de-rate it even if its standing OI is still large).
- The DELTAS (d_*) matter as much as the levels: a level strengthens when its |gex| is growing, weakens when |gex| is shrinking. For call walls (positive gex): d_gex positive = strengthening, d_gex negative = weakening. For put walls (negative gex): d_gex MORE NEGATIVE = strengthening, d_gex toward zero or positive = weakening. Same logic applies to d_charm — for put walls, charm building means d_charm more negative (wall gaining bullish dealer-buy force); for call walls, d_charm more negative = wall gaining bearish dealer-sell force. Weigh the trend, not just the snapshot.
- Regime modifier (NET/aggregate GEX, not per-strike): positive net GEX = pinning regime — dealers stabilize, fade into levels, walls hold cleanly. Negative net GEX (spot BELOW the gamma flip / zero_gamma) = AMPLIFICATION regime — dealers are short gamma and ADD to moves, so weak and moderate levels get blown through. In a negative net GEX regime: RAISE THE BAR HARD. Only score the 2-3 highest-confluence structural levels (dominant named walls with stacked greeks); drop everything else from the board entirely. A level that would score 40-55% in a positive regime should not appear on the board at all in a negative regime — it will simply get run through. Do not confuse this with per-strike sign — a put-heavy strike (negative per-strike gex) is a support node regardless of the net regime.
- VOL TRIGGER as REGIME BOUNDARY — vol_trigger is qualitatively different from zero_gamma, and the distinction matters for how you assess levels. Vol_trigger is the aggregate price where dealers' NET portfolio DELTA crosses zero: above it, dealers are net long underlying (forced to be, hedging their aggregate short-options book) and they dampen moves by selling rallies and buying dips. Below vol_trigger, dealers are net short underlying and must SELL into further price declines to maintain delta neutrality — they become mandatory procyclical sellers into a falling market. A put wall BELOW vol_trigger must absorb both organic selling pressure AND this mandatory dealer selling simultaneously; only the session's single dominant named put wall with very heavy concentrated OI can absorb that combined flow — every other support fails. When spot is below vol_trigger: dramatically restrict the board to the 2-3 most dominant structural levels (dominant named put wall below, call wall above), bias all reaction predictions toward "chop" or "mixed" because dealer selling amplifies the approach, and hold "clean" predictions only for the single most dominant structural extreme. The one mechanically reliable long setup below vol_trigger is the RECAPTURE: when price recovers back through vol_trigger from below, dealers who have been net short underlying must now BUY BACK their short delta hedge in size — forced, mechanical buying that tends to be fast and to the tick. If vol_trigger recapture is the scenario you identify (price approaching vol_trigger from below, strong structural support holding), mark the vol_trigger level as a high-conviction "clean" long setup with the move running to the call_wall above. The flip from below to above vol_trigger changes the whole session's character.
  NOTE — two vol trigger levels are provided: "vol_trigger" (near-term/weekly aggregate, most responsive to intraday flow) and "total_vol_trigger" (all-expiration aggregate, more stable). When they diverge, interpret the gap: spot between them = dealers are in a transition zone — hedging posture is neutral on the near-term book but still net-long on the full term structure, or vice versa. For intraday regime assessment, vol_trigger (weekly) is primary; total_vol_trigger gives the broader structural delta-neutral level. When both are above spot, dealer procyclical selling is confirmed across all time horizons.
- ZERO GAMMA BOUNDARY — the real entry is above zero_gamma, not at it: when spot is BELOW zero_gamma and price rallies toward it, zero_gamma itself is a TRANSITION ZONE (chop, diffuse, dealer gamma flipping sign) — NOT a clean entry. The actual resistance that snaps price to the tick is the FIRST POSITIVE GEX concentration immediately above zero_gamma, where dealer gamma flips from negative (amplifying) to positive (dampening) and they begin selling their long delta hedge into the rally. This cluster is often 1-2 strikes with 50-80M GEX each — smaller than the named call wall beyond it, but the FIRST place a dealer-hedging reversal can happen. Include this first positive-GEX barrier as a curated level (with "chop" or "clean" depending on concentration) instead of or alongside zero_gamma. Do not list zero_gamma as a resistance entry if the first positive GEX is 1-2 strikes above it — price will grind through zero_gamma in a rally and stall at that first cluster. Similarly on the downside: the first NEGATIVE GEX cluster immediately below zero_gamma (not zero_gamma itself) is the first support where dealers switch to buying.
- HURST EXPONENT (when "hurst" block is present) — measures the persistence/trend character of price behaviour. Read hurst (global) and rolling_50 (short-term) together: above 0.5 = price is trending/persistent (moves extend rather than mean-revert); below 0.5 = mean-reverting (oscillates, walls hold cleanly). The rolling_50 reflects CURRENT character; global hurst is structural. Rolling_50 > 0.65 = strongly trending session — this is the single most important context for whether walls hold: in a strongly trending tape, only the one dominant structural extreme in the trend direction (the resistance the trend is heading toward, or the support that could end it) is a high-probability clean entry; every other level is likely to be run through. Rolling_50 < 0.45 = mean-reverting session — walls are highly reliable, multiple levels can score high, confidence in clean reactions increases across the board. The hurst state also sets how wide the range is: high hurst means price can travel much farther in one session than the expected_move implies; low hurst means it oscillates tightly between the nearest structural boundaries. Let the hurst reading calibrate HOW MANY high-probability levels to include (few in high-hurst trending; more in low-hurst ranging) and the reaction character of each.
- GARCH VOL PERSISTENCE (when "garch" block is present) — the garch block gives you a live conditional volatility model: persistence (α+β) shows how long vol clusters last, z_score shows where current vol sits relative to its own mean, current_regime names the state ("low/normal/elevated/large"), and half_life is how many days a vol shock takes to decay. Interpret together: high persistence (near 1.0) + z_score > 1 + "large" or "elevated" regime = you are in a sustained high-vol state that will NOT revert quickly — mechanical walls that work perfectly in normal vol take multiple tests before holding in this environment, and intermediate walls get blown through. The reaction character degrades proportionally: "clean" is only achievable at the single most dominant structural barrier with the highest greek confluence; everything else is "mixed" or "chop." Half-life matters for sessions: if half_life is 20 days and we have been in elevated vol for weeks, the market is not going to normalize today — do not assume the vol regime resets intraday. Low persistence + z_score near 0 + "normal/low" regime = the mechanical behavior of walls is reliable and normal; clean reversals at dominant walls are the base expectation.
- FLOW ENTROPY (when "entropy" block is present) — measures the disorder/randomness of the options positioning path. current_entropy < threshold = STABLE FLOW: options positioning is orderly and concentrated, implying participants are positioning AROUND specific structural levels with conviction — walls are more reliable and cleaner in stable flow. current_entropy > threshold = CHAOTIC FLOW: positioning is diffuse and erratic, either because participants are confused about the direction or because a major reprice is in progress — walls are less predictable and a "chop" reaction is more likely even at dominant structures. The entropy status is a modifier on reaction character, not on the structural probability itself: a dominant put wall with high GEX + OI remains a structural barrier in chaotic flow, but the exact-tick clean reversal becomes a "mixed" reaction instead. In stable flow, lean into clean reactions at confirmed structural levels.
- You are given your OWN previous call. REVISE it rather than recomputing from scratch — only move a probability when the data justifies it. Avoid jitter.
- Let today's tape teach you. A structure that held cleanly today is evidence the same kind of structure (same greek signature) holds again in this tape; one that broke is evidence its kind is weak today. Update your priors from these outcomes — don't just read the snapshot. "graded_levels" shows which levels price has REACHED today and how they resolved (overshoot_pts = how far price pushed beyond; clean = whether it turned tightly):
  - outcome "broke" => price traded past the stop (hard_stop_pts) beyond it. DROP it entirely. Do not relist a broken level as a fresh setup; that price area is invalid until structure rebuilds.
  - outcome "retested" => price broke through earlier, recovered, then came back to the level and held on a second touch. The level is VALID AGAIN — keep it. It has demonstrated two-way relevance (break + recovery + hold). Apply a modest discount vs a first-touch clean reversal (the break shows structure is not impregnable), but do NOT drop it. Note in the "why" that it retested.
  - outcome "reversed" with clean=false => it held only after grinding past the clean zone: a weak hold. If you keep it, lower its probability.
  - outcome "pending" with clean=false => price is grinding through it RIGHT NOW (overshot the clean zone, not yet a full strike): treat as compromised and de-rate it.
  - outcome "pending" with retestAt set => price broke, recovered, and is now actively retesting the level — treat as a live setup, similar to a first-touch pending.
  - A clean "reversed" already played out — don't re-rank it as a fresh entry for the same touch.
- A "session" block tells you whether it's the US session or the Asia overnight session. In Asia: the OI/greeks are STATIC prior-close positioning (US options closed) and spot is NQ-futures-derived — be more conservative, lean on the largest walls, factor thinner liquidity, and say so in your reasoning. Read its "note" and adjust. "spot" is the effective live price; "altaris_spot" may be stale overnight.
- Focus on actionable levels near spot. Output 4-7 levels, ranked by conviction — quality over coverage. Only the 1-3 you would actually rest an order at should read >= 50%.
- For each level also output "tags": 2-4 SHORT confluence chips naming the structural reasons it's a level — e.g. "Call Wall", "Put Wall", "0DTE", "Major Wall", "Max Pain", "Zero Gamma", "Vol Trigger", "GEX +1.7B", "OI 107k", "Charm", "Vanna". Terse (chip-sized); the "why" remains the one-line narrative of what makes this strike special.
- For each level also predict "reaction" — the CHARACTER of the touch, which decides if it's tradeable to the tick:
  - "clean" = likely an instant touch-and-reject: a sharp, concentrated wall (dominant single-strike gamma/charm, a hard 0DTE wall, dealers forced to defend) that snaps price away to the tick with ~zero drawdown. The ideal setup.
  - "chop" = likely grind/oscillation with drawdown: diffuse/broad OI, competing walls within a point or two, zero-gamma / vol-trigger regions, or a strike price is already churning at — it may reverse eventually but not cleanly. Bad for a tick entry; de-rate the probability too.
  - "mixed" = genuinely unclear.
  Decide from the greek structure (concentrated vs diffuse), nearby competing levels, and the clock. A high probability with "chop" still isn't a clean trade — say so.
- The "reference_material" block contains excerpts retrieved from the trading-theory PDF library (YYY Practitioner's Guide, Regime Engine, Litzenberger, GARCH reference, dxrk frameworks). These are the most contextually relevant passages for the current board state. READ THEM — they are not boilerplate. They contain specific mechanistic reasoning about dealer flows, absorption, initiative/responsive activity, GARCH regimes, Hurst persistence, and volatility structure that directly informs how to score today's levels. Where a passage speaks to the current regime (e.g. negative gamma, trending Hurst, elevated vol), apply that reasoning to the level assessment.
- The "intraday_flow" block (present for US session) is Altaris's own chart data (15-min bars):
  - "recent_bars": last 5 bars — each has h/l/c and "delta" (net buyer−seller volume). Consecutive negative delta bars approaching a resistance wall = selling pressure confirming the level. Positive delta stacking under a support = buyers defending. Use the trend of delta (not just sign) — acceleration matters.
  - "vwap" and "vwap_z": current VWAP and its z-score. z < −1.5 = oversold/extended below VWAP (support more likely to hold, resistance harder to reach); z > +1.5 = extended above (resistance more likely to hold, support harder to reach).
  - "ema20" and "ema50": where the 20- and 50-period EMAs sit vs current spot. Price above both = bullish structure; below both = bearish. Proximity to EMA levels matters for reaction prediction.
  - "delta_profile_top5": the 5 price levels where the most net delta traded today. Large negative delta concentrations = where sellers have been dominant; positive = where buyers. These often align with the strongest reversal levels.
- The "greek_context" block (when present) gives session-level flow signals:
  - "wall_drift": the last ~6 readings of call_wall, put_wall, and net_gex_b ($B). A wall that shifted mid-session is more significant than the current snapshot alone — a call_wall jumping from 741 to 750 means a new dominant ceiling formed. A net_gex_b collapsing (e.g. 5.9 → 0.8) means the positive gamma regime is deteriorating fast; treat all levels more conservatively.
  - "strike_dex_flow": cumulative net delta traded at each strike near spot today (negative = net selling/put-buying; positive = net call-buying). A strike with large negative dex_flow AND high vol/OI in puts = this is where participants have been actively positioning for downside. Combined with the greek snapshot, this separates "standing OI" from "where money moved today."
  - "cum_dex_session": ~6 sampled readings of the SESSION-TOTAL running cumulative delta (cum_total = net buyer-minus-seller volume for the WHOLE options session; cum_call = from call delta; cum_put = from put delta). READ THE SHAPE: if cum_total has been consistently negative (or positive) across ALL 6 readings, this is an INITIATIVE session — directional participants have been repricing all day and structural walls in the trend path are at risk of being run through. If cum_total has CHANGED SIGN across the readings (positive early, negative late, or oscillating), this is a RESPONSIVE session — participants are mean-reverting, structural walls are more reliable, multiple levels can score high. A monotonically decreasing cum_total into the close = sustained initiative selling that will not turn until a dominant absorption wall is found. Use cum_dex_session to confirm or override the Hurst/regime read: Hurst 0.62 but cum_total oscillating = the Hurst is picking up a recent trending stretch but TODAY's flow character is actually responsive. Trust the cumulative delta shape for the current session character.
- DAY NARRATIVE TILT (when a "day_narrative" block is present — the pre-open macro + open-type call): treat it as a SECONDARY modifier on top of the greek structure, never an override. Modestly RAISE the probability of reversal levels that align with the day's expansion_direction / macro_bias (e.g. in a bullish/up day, support levels that catch dips and become launch points deserve a small lift; the resistance the open-type targets is a more reliable fade). Modestly LOWER counter-trend levels likely to be run through (e.g. a support in a "real_dump" day). Keep the tilt small (a few points) — clean structural confluence still rules, and if the structure contradicts the narrative, trust the structure and say so in the "why". Do not invent levels to fit the narrative.
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

/** Build near-spot GEX distribution for the dashboard chart (GEX in $M per strike). */
function buildGexProfile(snap: DataSnapshot, spot: number): { strike: number; gex_m: number }[] {
  return strikesNear(snap, spot).map((k) => ({
    strike: k,
    gex_m: Math.round(((snap.gex_bar[k.toFixed(1)] ?? 0) / 1e6) * 10) / 10,
  }));
}

/** Implied vol (%) at a strike from the skew map — exact, else nearest within ~0.6 pt. */
function ivAt(cur: DataSnapshot, strike: number): number | null {
  const sk = cur.iv_skew;
  if (!sk) return null;
  const exact = sk[strike.toFixed(1)];
  if (typeof exact === "number") return exact;
  let best: number | null = null, bd = 0.6;
  for (const [k, v] of Object.entries(sk)) {
    const dd = Math.abs(Number(k) - strike);
    if (dd <= bd) { bd = dd; best = v; }
  }
  return best;
}

/**
 * Skew summary near spot: ATM IV + a 25-delta-ish risk reversal (≈3% OTM put IV − OTM call IV).
 * Positive risk_reversal = put skew = downside hedging demand. Null when no skew was captured.
 */
function skewContext(cur: DataSnapshot, spot: number) {
  if (!cur.iv_skew) return null;
  const atm = ivAt(cur, spot);
  const otmPut = ivAt(cur, spot * 0.97);
  const otmCall = ivAt(cur, spot * 1.03);
  return {
    atm_iv: atm != null ? round(atm, 2) : null,
    otm_put_iv: otmPut != null ? round(otmPut, 2) : null,
    otm_call_iv: otmCall != null ? round(otmCall, 2) : null,
    risk_reversal: otmPut != null && otmCall != null ? round(otmPut - otmCall, 2) : null,
  };
}

/**
 * Local IV-bump confidence for ONE strike: how elevated its IV is vs the smooth local skew
 * (mean of the strikes ±2 away). A positive bump = concentrated demand / dealers defending here =
 * a stronger, cleaner node. Returns a 0-8 confluence contribution (capped, modest — the skew tape
 * is noisy near ATM, so this only nudges; the AI reads the full per-strike IV for nuance).
 */
function skewBump(cur: DataSnapshot, k: number): number {
  const iv = ivAt(cur, k);
  if (iv == null) return 0;
  const lo = ivAt(cur, k - 2), hi = ivAt(cur, k + 2);
  const base = lo != null && hi != null ? (lo + hi) / 2 : null;
  if (base == null || base <= 0) return 0;
  const rel = (iv - base) / base; // relative elevation vs neighbours
  return rel > 0.08 ? Math.min(8, (rel - 0.08) * 20) : 0;
}

/** Per-strike near-spot rows with deltas vs the oldest snapshot in the lookback window. */
function buildStrikeRows(history: CaptureRecord[], spot: number) {
  const cur = history[history.length - 1]!.data;
  const ref = history[0]!.data;
  const key = (k: number) => k.toFixed(1);
  const M = (n: number) => Math.round((n / 1e6) * 10) / 10;
  type BarName = "gex_bar" | "dex_bar" | "vex_bar" | "charm_bar" | "tex_bar" | "vanna_bar" | "rex_bar";
  const bar = (snap: typeof cur, name: BarName, k: string) => snap[name]?.[k] ?? 0;

  const atmIv = ivAt(cur, spot); // skew baseline so each strike's IV is read vs ATM
  return strikesNear(cur, spot).map((k) => {
    const s = key(k);
    const oi = cur.oi_bar[s] ?? { calls: 0, puts: 0 };
    const oiRef = ref.oi_bar[s] ?? { calls: 0, puts: 0 };
    const vol = cur.vol_bar?.[s] ?? { calls: 0, puts: 0 };
    const d = (name: BarName) => M(bar(cur, name, s) - bar(ref, name, s));
    const iv = ivAt(cur, k);
    const volOiCallPct = oi.calls > 0 ? (vol.calls / oi.calls) * 100 : 0;
    const volOiPutPct  = oi.puts  > 0 ? (vol.puts  / oi.puts)  * 100 : 0;
    return {
      strike: k,
      oi_calls: round(oi.calls), oi_puts: round(oi.puts),
      vol_calls: round(vol.calls), vol_puts: round(vol.puts),
      vol_oi_pct_calls: round(volOiCallPct),
      vol_oi_pct_puts: round(volOiPutPct),
      // battleground: participants are actively fighting over this strike TODAY (>200% vol/OI near spot).
      // A "true" here means this strike MUST be considered as a primary intraday pivot.
      battleground: Math.abs(k - spot) <= 4 && (volOiCallPct > 200 || volOiPutPct > 200),
      gex_m: M(bar(cur, "gex_bar", s)), dex_m: M(bar(cur, "dex_bar", s)),
      vega_m: M(bar(cur, "vex_bar", s)), vanna_m: M(bar(cur, "vanna_bar", s)),
      charm_m: M(bar(cur, "charm_bar", s)), tex_m: M(bar(cur, "tex_bar", s)),
      rho_m: M(bar(cur, "rex_bar", s)),
      // 0DTE-isolated gamma/charm/vanna — weight these into the close (0DTE dominates pinning).
      gex_0dte_m: M(cur.gex_0dte_bar?.[s] ?? 0),
      charm_0dte_m: M(cur.charm_0dte_bar?.[s] ?? 0),
      vanna_0dte_m: M(cur.vanna_0dte_bar?.[s] ?? 0),
      // Per-strike IV from the skew + how elevated it sits vs ATM (a local bump = demand/defense here).
      iv: iv != null ? round(iv, 2) : null,
      iv_vs_atm: iv != null && atmIv != null ? round(iv - atmIv, 2) : null,
      d_oi_calls: round(oi.calls - oiRef.calls), d_oi_puts: round(oi.puts - oiRef.puts),
      // Day-over-day OI change (walls building vs unwinding) from /api/oi_change.
      d_oi_day_calls: round(cur.oi_day_bar?.[s]?.calls ?? 0), d_oi_day_puts: round(cur.oi_day_bar?.[s]?.puts ?? 0),
      d_gex_m: d("gex_bar"), d_vanna_m: d("vanna_bar"), d_charm_m: d("charm_bar"), d_vega_m: d("vex_bar"),
    };
  });
}

/** Wall drift + per-strike dex_flow + session cumulative delta from the greek timeseries. */
function buildGreekContext(greek: GreekTimeseries, spot: number) {
  const h = greek.history;
  if (h.length === 0) return { wall_drift: [], strike_dex_flow: [], cum_dex_session: [] };
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

  // Session cumulative delta — the running net total of buyer-minus-seller volume for the whole session.
  // Consistently directional = initiative session; oscillating sign = responsive/mean-reverting session.
  // Sample 6 points through the session so the AI can read the shape, not just the final value.
  const cd = greek.cumulative_dex;
  let cum_dex_session: { ts: string; cum_total: number; cum_call: number; cum_put: number }[] = [];
  if (cd.length > 0) {
    const cdStep = Math.max(1, Math.floor(cd.length / 6));
    const cdIdx = [...Array(6).keys()].map((i) => Math.min(cd.length - 1, i * cdStep));
    cdIdx[5] = cd.length - 1;
    cum_dex_session = [...new Set(cdIdx)].map((i) => ({
      ts: cd[i]!.ts,
      cum_total: round(cd[i]!.cum_total),
      cum_call: round(cd[i]!.cum_call),
      cum_put: round(cd[i]!.cum_put),
    }));
  }

  return { wall_drift, strike_dex_flow, cum_dex_session };
}

/**
 * Build a BM25 query from the current board state and retrieve the most relevant
 * excerpts from the PDF knowledge base. These are injected into the scoring prompt
 * so the AI always has access to the relevant theory regardless of context limits.
 */
function buildKnowledgeContext(cur: DataSnapshot, latest: CaptureRecord): { source: string; excerpt: string }[] {
  const terms: string[] = [];
  // Regime context
  if ((cur.gex_regime || "").toLowerCase().includes("neg")) terms.push("negative gamma dealer amplification initiative");
  else terms.push("positive gamma pinning responsive mean-reverting");
  // Hurst
  const h = latest.hurst?.rolling_50;
  if (h != null && h > 0.6) terms.push("trending initiative Hurst persistent momentum");
  else if (h != null && h < 0.45) terms.push("mean reverting ranging responsive oscillating");
  // GARCH
  const g = latest.garch;
  if (g?.z_score != null && g.z_score > 1) terms.push("elevated vol GARCH persistence volatility clustering");
  // Entropy
  if (latest.entropy?.status?.toLowerCase().includes("stable")) terms.push("stable flow orderly absorption");
  else if (latest.entropy?.status?.toLowerCase().includes("chao")) terms.push("chaotic flow disorder diffuse");
  // Vol trigger
  if (cur.vol_trigger != null) terms.push("vol trigger dealer net delta procyclical");
  // Always include core trading concepts
  terms.push("absorption exhaustion reversal wall GEX charm vanna delta divergence");
  const query = terms.join(" ");
  return retrieveKnowledge(query, 5);
}

function buildInput(history: CaptureRecord[], prior: Board | null, detected: DetectedLevel[], session: SessionDef, spot: number, candles?: AltarisCandlesResponse, greek?: GreekTimeseries, dayContext?: DayContext) {
  const cur = history[history.length - 1]!.data;
  return {
    as_of: history[history.length - 1]!.capturedAt,
    day_narrative: dayContext ?? null,
    session: { name: session.name, note: SESSION_NOTES[session.name] },
    lookback_snapshots: history.length,
    spot,
    altaris_spot: cur.spot,
    spot_path_recent: history.map((h) => round(h.data.spot, 2)),
    named_levels: {
      call_wall: cur.call_wall, put_wall: cur.put_wall, major_wall: cur.major_wall,
      max_pain: cur.max_pain, zero_gamma: cur.zero_gamma,
      // vol_trigger = near-term (weekly) aggregate; total_vol_trigger = across all expirations.
      // Both matter: spot below vol_trigger = near-term dealers short; below total_vol_trigger = all dealers short.
      vol_trigger: cur.vol_trigger, total_vol_trigger: cur.total_vol_trigger,
      call_walls: cur.call_walls, put_walls: cur.put_walls,
      call_wall_0dte: cur.call_wall_0dte, put_wall_0dte: cur.put_wall_0dte, major_wall_0dte: cur.major_wall_0dte,
    },
    context: {
      gex_regime: cur.gex_regime, atm_iv: cur.atm_iv,
      // atm_iv_avg = session-average ATM IV (smoothed). Gap between atm_iv and atm_iv_avg shows
      // whether IV is spiking vs mean-reverting intraday — informs VRP read and reaction quality.
      atm_iv_avg: cur.atm_iv_avg,
      expected_move: cur.expected_move,
      realized_vol: cur.realized_vol, net_vanna: cur.net_vanna,
      min_reversal_move_pts: round(config.tpMinPct * cur.spot, 2),
      min_reversal_move_nq_pts: 100,
      hard_stop_pts: config.hardStopPts,
      clean_reversal_pts: config.cleanReversalPts,
      minutes_to_cash_close: minutesToCashClose(history[history.length - 1]!.capturedAt),
      // P/C ratio: >1.2 = heavy put hedging (fear; supports hold harder); <0.7 = call chasing.
      pc_ratio: cur.pc_ratio ?? null,
      // 0DTE GEX fraction: >0.6 = most gamma expires today (strong close pin); <0.3 = multi-expiry.
      gex_0dte_ratio: cur.gex_0dte_ratio ?? null,
      // Net charm near spot ($M): negative = dealers sell delta into close; positive = buy. Weight into close.
      net_charm_near_m: round(strikesNear(cur, spot).reduce((s, k) => s + (cur.charm_bar?.[k.toFixed(1)] ?? 0), 0) / 1e6, 1),
      // Net vanna near spot ($M): direction of forced dealer rebalancing when IV moves.
      net_vanna_near_m: round(strikesNear(cur, spot).reduce((s, k) => s + (cur.vanna_bar?.[k.toFixed(1)] ?? 0), 0) / 1e6, 1),
    },
    iv: history[history.length - 1]!.iv ?? null,
    iv_skew: skewContext(cur, spot),
    entropy: history[history.length - 1]!.entropy ?? null,
    hurst: history[history.length - 1]!.hurst ?? null,
    garch: history[history.length - 1]!.garch ?? null,
    reference_material: buildKnowledgeContext(cur, history[history.length - 1]!),
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
const SCORE_TIMEOUT_MS = 8 * 60_000; // 8 min — allow time for cold-start hook overhead on PC wake

// Prevent concurrent scorer calls — a stuck/slow claude process must finish (or be killed)
// before the next tick is allowed to spawn another one.
let scorerLocked = false;

function killChild(pid: number): void {
  if (process.platform === "win32") {
    // Kill the entire process tree; child.kill() on Windows only signals the direct child
    // and is silently ignored when the process was spawned under a different integrity level.
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

function runClaude(userPrompt: string): Promise<string> {
  if (scorerLocked) return Promise.reject(new Error("scorer already running — concurrent call blocked"));
  scorerLocked = true;

  return new Promise((resolve, reject) => {
    const args = [
      "-p", "--output-format", "json",
      "--model", config.model,
      "--system-prompt", SYSTEM,
      "--disallowed-tools", "*",
    ];
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", settled = false;

    function done(fn: () => void) {
      if (settled) return;
      settled = true;
      scorerLocked = false;
      clearTimeout(timer);
      fn();
    }

    const timer = setTimeout(() => {
      if (child.pid) killChild(child.pid);
      done(() => reject(new Error(`claude -p timed out after ${SCORE_TIMEOUT_MS / 1000}s`)));
    }, SCORE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done(() => reject(new Error(`Could not launch "${CLAUDE_BIN}". Is Claude Code installed/on PATH? ${e.message}`))));
    child.on("close", (code) => done(() => code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`))));
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
  dayContext?: DayContext,
): Promise<Board> {
  // Fetch Altaris candle context for US session; fail gracefully for fixture runs / Asia.
  let candles: AltarisCandlesResponse | undefined;
  if (session.source === "QQQ") {
    try { candles = await fetchCandles(1); } catch { /* non-fatal */ }
  }
  const input = buildInput(history, prior, detected, session, spot, candles, greek, dayContext);
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
  board.gex_profile = buildGexProfile(cur, spot);
  board.coverage = buildCoverage(cur, spot, detected);
  board.zero_gamma = cur.zero_gamma;
  board.vol_trigger = cur.vol_trigger;
  // net_gex from the latest greek_timeseries point; fall back to summing gex_bar if unavailable.
  const lastGreek = greek?.history[greek.history.length - 1];
  board.net_gex = lastGreek?.net_gex ?? Object.values(cur.gex_bar ?? {}).reduce((s, v) => s + v, 0);
  const ent = history[history.length - 1]!.entropy;
  if (ent && ent.threshold > 0) {
    const r = ent.current_entropy / ent.threshold;
    board.entropy_state = r >= 1.2 ? "CRITICAL" : r >= 1.0 ? "ELEVATED" : "NORMAL";
    board.entropy_ratio = Math.round(r * 100) / 100;
  }
  if (cur.pc_ratio != null) board.pc_ratio = cur.pc_ratio;
  if (cur.gex_0dte_ratio != null) board.gex_0dte_ratio = cur.gex_0dte_ratio;
  return board;
}

// GEX threshold for unlisted strikes to count as structural walls (mirrors run.ts).
const GEX_RULE_THRESHOLD = 50e6;

type NamedSets = Record<"major_wall" | "call_wall" | "put_wall" | "call_walls" | "put_walls" | "zero_gamma" | "vol_trigger" | "max_pain", Set<number>>;

/** Named-level sets used for the confluence bonus + tag generation. */
function namedSets(cur: DataSnapshot): NamedSets {
  const fin = (n: number) => Number.isFinite(n) && n > 0;
  return {
    major_wall: new Set([cur.major_wall, cur.major_wall_0dte].filter(fin)),
    call_wall: new Set([cur.call_wall, cur.call_wall_0dte].filter(fin)),
    put_wall: new Set([cur.put_wall, cur.put_wall_0dte].filter(fin)),
    call_walls: new Set(cur.call_walls),
    put_walls: new Set(cur.put_walls),
    zero_gamma: new Set([cur.zero_gamma].filter(fin)),
    vol_trigger: new Set([cur.vol_trigger].filter(fin)),
    max_pain: new Set([cur.max_pain].filter(fin)),
  };
}

interface StrikeScore {
  strike: number; score: number; side: "support" | "resistance";
  tags: string[]; reaction: "clean" | "chop" | "mixed"; gex: number; oi: number;
}

/**
 * Confluence score for ONE strike from its own greeks — the shared core of both the curated
 * rule board and the full per-strike coverage. `score` is an unbounded-ish confluence sum
 * (named-wall + |GEX| + OI + |charm| + activity); callers either rank it or map it to a prob.
 */
function scoreStrike(cur: DataSnapshot, k: number, spot: number, ns: NamedSets, riskRev?: number | null): StrikeScore {
  const M = (n: number) => n / 1e6;
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
  const skewScore = skewBump(cur, k); // local IV bump = concentrated demand/defense (0-8, modest)

  // 0DTE pin emphasis: large SAME-DAY gamma+charm = a same-day pin that holds to the tick (0-10, capped).
  const gex0 = cur.gex_0dte_bar?.[s] ?? 0, charm0 = cur.charm_0dte_bar?.[s] ?? 0;
  const dte0Mag = Math.abs(M(gex0)) + Math.abs(M(charm0));
  const dte0Score = Math.min(10, Math.log1p(dte0Mag / 50) * 2.5);

  // OI BUILDING day-over-day on the relevant side (puts at a support, calls at a resistance) = wall
  // being reinforced overnight (0-6, modest). Shrinking OI gives nothing — it's weakening.
  const oiDay = cur.oi_day_bar?.[s];
  const oiBuild = oiDay ? (side === "resistance" ? oiDay.calls : oiDay.puts) : 0;
  const oiBuildScore = oiBuild > 0 ? Math.min(6, Math.log1p(oiBuild / 500) * 1.5) : 0;

  // SHADOW GAMMA / LEFT-TAIL ASYMMETRY: when put skew is steep (risk_reversal > 0), the
  // market's own pricing tells us that dealer delta-rebalancing on downside is larger than
  // raw GEX shows (shadow gamma gap). The risk_reversal value IS the market's quantification
  // of that asymmetry — it directly scales this boost rather than using an arbitrary constant.
  // Capped so a single noisy skew print can't dominate the score.
  const shadowGammaBoost = (side === "support" && riskRev != null && riskRev > 0)
    ? Math.min(6, riskRev * 0.8) : 0;

  const score = nameScore + gexScore + oiScore + charmScore + activityScore + skewScore + dte0Score + oiBuildScore + shadowGammaBoost;

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
  if (dte0Score >= 5) tags.push("0DTE Pin");
  if (oiBuildScore >= 2) tags.push("OI Building");
  if (shadowGammaBoost > 2) tags.push("Shadow Gamma");

  // VRP-AWARE REACTION: when realized_vol exceeds atm_iv the market is under-hedged — walls
  // don't hold cleanly because dealers are dynamically rehedging rather than pinning.
  // Non-dominant walls degrade to "mixed" in this state; only primary named walls with
  // heavy GEX retain "clean" character.
  const vrpNegative = typeof cur.realized_vol === "number" && typeof cur.atm_iv === "number"
    && cur.realized_vol > cur.atm_iv;
  let reaction: "clean" | "chop" | "mixed";
  if (vrpNegative && nameScore < 35) reaction = "mixed";
  else if ((nameScore >= 35 && gexAbs >= 100) || dte0Score >= 7 || (gexAbs >= 50 && dte0Score >= 5)) reaction = "clean";
  else if (ns.zero_gamma.has(k) || ns.vol_trigger.has(k) || ns.max_pain.has(k)) reaction = "chop";
  else reaction = "mixed";

  return { strike: k, score, side, tags: tags.slice(0, 4), reaction, gex, oi };
}

/**
 * Map a confluence score to an absolute 0-100 reversal likelihood AT the strike. A transparent
 * monotonic squash — NOT tuned to historical PnL: a dominant multi-greek node (score ~80+) lands
 * ~64, a named-wall-only strike (~40) ~36, an empty strike (~5) ~11. Conditional on price reaching
 * the strike (reachability is the spot line's job, not this number's).
 */
const probFromConfluence = (score: number) => Math.max(5, Math.min(78, Math.round(8 + score * 0.7)));

/**
 * Per-strike reversal coverage: a score for EVERY near-spot strike, so a resting limit at any
 * exact strike has its own number and no real node is ever omitted. Differentiated by real greek
 * confluence (empty strikes ~low, true nodes peak). Intraday breaks are not de-rated here —
 * calibration records them, but the structural score reflects the level's option positioning.
 */
export function buildCoverage(cur: DataSnapshot, spot: number, detected: DetectedLevel[]): CoverageLevel[] {
  const ns = namedSets(cur);
  const riskRev = skewContext(cur, spot)?.risk_reversal ?? null;
  return strikesNear(cur, spot)
    .map((k) => {
      const ss = scoreStrike(cur, k, spot, ns, riskRev);
      const iv = ivAt(cur, k);
      return {
        strike: k, side: ss.side, reaction: ss.reaction, tags: ss.tags,
        prob: probFromConfluence(ss.score),
        ...(iv != null ? { iv: round(iv, 1) } : {}),
      };
    })
    .sort((a, b) => b.strike - a.strike);
}

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

  const ns = namedSets(cur);
  const allNamed = new Set([
    ...ns.major_wall, ...ns.call_wall, ...ns.put_wall,
    ...ns.call_walls, ...ns.put_walls, ...ns.zero_gamma, ...ns.vol_trigger, ...ns.max_pain,
  ]);

  const fromGex = Object.entries(cur.gex_bar ?? {})
    .filter(([, gex]) => Math.abs(gex) >= GEX_RULE_THRESHOLD)
    .map(([s]) => parseFloat(s))
    .filter((k) => Number.isFinite(k) && k > 0);

  // Active intraday pivots: near-spot strikes with >200% vol/OI concentration even if
  // not a named wall and below the GEX threshold — these are where participants are
  // fighting today and often produce real reversals in trending sessions.
  const BATTLEGROUND_VOIOI_PCT = 2.0; // 200%
  const BATTLEGROUND_BAND = 4; // within 4 QQQ pts of spot
  const fromVolOi = strikesNear(cur, spot)
    .filter((k) => {
      if (Math.abs(k - spot) > BATTLEGROUND_BAND) return false;
      const s = k.toFixed(1);
      const oi = cur.oi_bar?.[s], vol = cur.vol_bar?.[s];
      if (!oi || !vol) return false;
      return (oi.calls > 0 && vol.calls / oi.calls >= BATTLEGROUND_VOIOI_PCT)
          || (oi.puts  > 0 && vol.puts  / oi.puts  >= BATTLEGROUND_VOIOI_PCT);
    });

  let candidates = [...new Set([...allNamed, ...fromGex, ...fromVolOi])]
    .filter((k) => Math.abs(k - spot) <= band && !brokenStrikes.has(k));

  if (!candidates.length) {
    candidates = [...allNamed].filter((k) => !brokenStrikes.has(k)).slice(0, 10);
  }

  // VOL TRIGGER REGIME GATE: below vol_trigger, dealers are net short underlying and must
  // sell into further declines — procyclical sellers amplify every approach. Only the
  // single most dominant named walls on each side can absorb combined organic + dealer flow.
  // Everything else gets run through, so excluding non-dominant levels produces a cleaner board.
  const belowVolTrigger = cur.vol_trigger != null && spot < cur.vol_trigger;
  if (belowVolTrigger) {
    const dominant = candidates.filter((k) => ns.major_wall.has(k) || ns.call_wall.has(k) || ns.put_wall.has(k));
    if (dominant.length) candidates = dominant;
  }

  const riskRev = skewContext(cur, spot)?.risk_reversal ?? null;
  const scored = candidates.map((k) => scoreStrike(cur, k, spot, ns, riskRev));

  scored.sort((a, b) => b.score - a.score);

  // In a negative gamma regime (dealers amplify moves), only the structurally dominant
  // 1-2 levels per side can absorb initiative flow. Showing 7 levels implies 7 are worth
  // watching — that's wrong: most get blown through. Restrict the visible board to force
  // the signal to concentrate on what actually matters.
  const negRegime = (cur.gex_regime || "").toLowerCase().includes("neg");
  const boardSize = negRegime ? 3 : 7;
  const top = scored.slice(0, boardSize);

  // Probabilities come from relative structural strength, not fixed rank slots.
  // The top-ranked level always gets the probability ceiling; each subsequent level
  // scales by its score as a fraction of the top score. This means a tightly-clustered
  // group gets similar probabilities, and an isolated dominant wall sits far above
  // everything else — which is structurally correct.
  // In a negative regime the ceiling is lower because even the dominant wall faces
  // dealer amplification on approach — the same structural mass produces a less-clean
  // first touch, so peak confidence is realistically lower.
  const topScore = Math.max(1, top[0]?.score ?? 1);
  const probCeiling = negRegime ? 58 : 65;
  const probFloor = 18;

  const bestRes = top.find((c) => c.side === "resistance");
  const bestSup = top.find((c) => c.side === "support");

  const levels: ScoredLevel[] = top.map((c) => {
    const relativeStrength = c.score / topScore; // 1.0 for rank 1, proportionally less for others
    const prob = Math.round(probFloor + (probCeiling - probFloor) * relativeStrength);
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
      reversal_prob: prob,
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
    gex_profile: buildGexProfile(cur, spot),
    coverage: buildCoverage(cur, spot, detected),
    zero_gamma: cur.zero_gamma,
    vol_trigger: cur.vol_trigger,
    net_gex: Object.values(cur.gex_bar ?? {}).reduce((s, v) => s + v, 0),
    ...(() => {
      const ent = history[history.length - 1]!.entropy;
      if (!ent || ent.threshold <= 0) return {};
      const r = ent.current_entropy / ent.threshold;
      return {
        entropy_state: (r >= 1.2 ? "CRITICAL" : r >= 1.0 ? "ELEVATED" : "NORMAL") as "NORMAL" | "ELEVATED" | "CRITICAL",
        entropy_ratio: Math.round(r * 100) / 100,
      };
    })(),
    ...(cur.pc_ratio != null ? { pc_ratio: cur.pc_ratio } : {}),
    ...(cur.gex_0dte_ratio != null ? { gex_0dte_ratio: cur.gex_0dte_ratio } : {}),
  };
}
