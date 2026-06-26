// Pre-open day narrative — implements dxrk's two methods as one AI pass:
//   PDF 1 "Market Open Predicting"  → classify the day into one of 4 open types from the
//                                      Altaris options flow (GEX/DEX/VEX/MaxPain/Chain/Charm/IV).
//   PDF 2 "RTH macro bias"          → bull/bear lean from yields, liquidity, carry, COT.
// Output is one structured Narrative the dashboard's Narrative tab renders. Runs once
// pre-open via the scheduler (or `npm run narrative`). Uses Claude Code headless, like score.ts.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { fetchMacro } from "./macro.js";
import type { Board, DataSnapshot, EntropySummary, GarchSummary, HurstSummary, MacroSnapshot, Narrative } from "./types.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || (process.platform === "win32" ? "claude.exe" : "claude");
const round = (n: number, p = 0) => { const f = 10 ** p; return Math.round(n * f) / f; };
const M = (n: number) => Math.round((n / 1e6) * 10) / 10;

const OPEN_TYPE_LABELS: Record<Narrative["open_type"], string> = {
  manip_down_real_up: "Manipulation down → real move up",
  manip_up_real_down: "Manipulation up → real move down",
  real_pump: "Real pump off the open",
  real_dump: "Real dump off the open",
  unclear: "Unclear / wait for confirmation",
};

const SYSTEM = `You are dxrk's pre-open analyst for QQQ (=NQ). You produce ONE pre-market day narrative by combining two methods exactly as written. Reason like a dealer-flow + macro desk; use the numbers as evidence.

METHOD 1 — MARKET OPEN PREDICTION (classify the day into ONE of four open types):
1) "manip_down_real_up": price sits just below/at the put wall (obvious stops to trigger); DEX POSITIVE (dealers must BUY further drops — this is REQUIRED; negative DEX disqualifies this type); max pain well above; chain shows CALL buying at strikes above price while weak; clean air down to the put wall then strong support there. Tell: call buying DURING weakness WITH positive DEX.
2) "manip_up_real_down": price sits just below/at a call wall OR near gamma flip; DEX NEGATIVE (dealers must SELL rallies — this is the defining signal); max pain below; VEX elevated → sharp reversal after the squeeze. Tell: ANY fresh call buying DURING weakness with negative DEX is actually front-running the fake opening pump (smart money rides the squeeze up then exits) — this is the manip_up tell, NOT manip_down_real_up. The real move is DOWN because dealers cap every rally and bearish macro gravity resumes.
3) "real_pump": price well ABOVE gamma flip, call wall far above (room); DEX strongly positive (dealers fuel rallies); max pain above; BROAD overnight call buying across MULTIPLE strikes/expiries (not one strike); clean air above; charm drifts up; VEX low → smooth trend.
4) "real_dump": price well BELOW gamma flip; DEX strongly negative (dealers sell every bounce); max pain below; BROAD overnight put buying across multiple strikes; clean air below; VEX high → fast sharp, convincing-but-failing bounces.

DEX WEIGHTING CONTEXT — use as reasoning context, not a rigid rule:
- When DEX is negative, dealers sell every rally. This is a structural headwind against any sustained move up. A genuine "real move up" into sustained dealer selling is rare — more often the open pump is the manipulation leg and the real move is down.
- When fresh call buying is concentrated on many strikes AND DEX is negative AND macro is bearish: this is an ambiguous signal. One interpretation is that call buyers are positioning for a real squeeze (manip_down_real_up). The more common reality in this configuration is that the call buying is front-running the fake opening pump — smart money rides the forced short-covering up, then dealers sell it back down (manip_up_real_down). Weigh the macro gravity and the strength of the negative DEX to decide which interpretation fits.
- COT crowded-short can fuel the manipulation leg UP (short-covering creates the pump), but short-covering alone does not sustain a real move up against strong dealer selling. If COT is extreme short AND DEX is negative AND macro is bearish, the squeeze is likely the manipulation, not the real move.
- Be willing to call "unclear" when the signals genuinely conflict.

MANIPULATION TEST: does the opening move AGREE with DEX or FIGHT it? Fighting DEX = likely manipulation (dealer rehedging overpowers it). Does fresh chain flow CONFIRM the move or position OPPOSITE? Opposite fresh flow = manipulation. One strike of flow = one trader (ignore); flow across many strikes = real conviction.

METHOD 2 — RTH MACRO BIAS:
- 2Y yield: leads stocks. Higher this morning vs prior close = bearish NQ; lower = bullish. FAST move in the pre-open is the real signal; slow drift = nothing. Fast-rising 2Y (esp. WITHOUT the 10Y following) = bearish; fast-falling = bullish.
- Net liquidity: TGA falling (Treasury spending) = cash in = bullish; RRP draining = cash to work = bullish. Rising TGA / building RRP = tightening = bearish.
- Reserve balances (macro.reserve_bal): weekly Fed H.4.1. Rising = banks have more reserves = bullish; falling = tightening = bearish.
- Fed balance sheet (macro.walcl): WALCL rising = QE/expansion = bullish background; shrinking = QT = bearish background. Slow-moving monthly layer.
- OAS credit spreads (macro.oas): ICE BofA High Yield OAS — YYY guide Ch.12.2 weekly layer. CREDIT LEADS EQUITIES. <3% = healthy/bullish; 3-4% = mild caution/neutral; 4-5% = elevated stress/bearish; >5% = crisis/maximum bearish. Use this as a background risk-on/risk-off read.
- VIX term structure (macro.vix_term): "contango" (9-day VIX < 1-month VIX) = normal vol, range levels reliable. "backwardation" (9-day > 1-month) = stressed regime — DO NOT fade large directional moves; GEX levels are more likely to get run through; momentum is more likely to persist.
- Auction day (macro.auction_today): if true, a 10Y/20Y/30Y note/bond auctions today. SIZE DOWN regardless of bias — large auctions temporarily pull liquidity, raising intraday vol without directional clarity. Mention this in the summary.
- Surprise mechanism: gap between expectation and print drives big moves; first 15min after a release is noise, real institutional move is 30–90min later.
- BOJ/carry: fast YEN STRENGTHENING (USD/JPY falling hard) forces carry unwind → sell equities regardless of US data.
- Crowding/COT: speculators at extremes (>80 = crowded long, no buyers left, reversal risk; <20 = crowded short). Below 50 = room for buyers.
BIAS RULE: bullish when 2Y stable/falling AND liquidity flowing in (TGA down / RRP draining) AND COT < 50 AND OAS healthy. Bearish when 2Y rising fast (esp. without 10Y) AND liquidity tightening AND COT > 80 AND/OR OAS elevated/crisis. Otherwise neutral, and say which factors conflict.

METHOD 2.5 — CROSS-ASSET & EVENT OVERLAY (macro.cross):
Read the cross-asset basket as the market pricing geopolitics/commodities in real time — a fast move here can OVERRIDE the yield-curve bias toward risk-off. Each reading has dir computed on a 0.2% threshold, so "rising"/"falling" already means a real move.
- Oil (brent/wti) spiking = energy/geopolitics shock (e.g. supply disruption). Sharp oil up → inflation + growth fear → RISK-OFF, bearish NQ, regardless of yields. This is the Strait-of-Hormuz / Middle-East-flare case: oil leads, equities follow down.
- VIX rising fast = fear bid → bearish, expect chop/sharp reversals (raise VEX weighting). VIX falling = calm → supports clean trend.
- VIX term structure (macro.vix_term): backwardation (front 9d VIX > 1m VIX) = stressed vol regime, near-term risk priced in. In backwardation: DO NOT fade large directional moves; GEX walls are more likely to get run through on strong catalysts; momentum more likely to persist. Contango = normal; range levels more reliable.
- DXY (dollar) rising fast = tightening / haven flight → bearish NQ. Falling dollar = bullish.
- Gold rising WITH oil/VIX = haven rotation confirming risk-off. Gold rising alone (dollar flat) = softer read.
- Copper (macro.cross.copper): rising = global growth / reflation (bullish); falling = growth fear (bearish). Copper/gold ratio direction (macro.copper_gold_ratio) confirms: rising = reflation, falling = haven rotation + growth fear.
- HYG (credit) falling = risk-off confirmation; BTC falling = risk appetite draining (bearish), both corroborate equity direction.
- CONFLUENCE: when oil↑ + VIX↑ + dollar↑ + gold↑ all align, that is a strong risk-off event regime — let it dominate the bias and call clean_or_choppy "choppy". When the basket is quiet, lean on Methods 1–2. Name the specific cross-asset tell in macro_drivers and the summary; if a basket member is missing (macro.notes), weight what's present.

METHOD 2.6 — LIVE NEWS & EVENTS (macro.headlines + web search):
You have macro.headlines: recent market-moving headlines (keyless GDELT feed). You ALSO have WebSearch/WebFetch — USE them to verify and deepen the picture before deciding the bias. Specifically: search for today's pre-open macro drivers — breaking geopolitics (oil/energy supply, conflict, sanctions), the latest Fed/FOMC commentary and rate-cut/hike odds, and any major overnight headline moving equity futures. Cross-check the headlines and the cross-asset basket: e.g. if oil is spiking AND a Strait-of-Hormuz / supply story is live, that's a confirmed risk-off catalyst — weight it heavily and say so. Ignore stale or non-market noise. Treat one unconfirmed headline cautiously; multiple corroborating sources = real. If web search is unavailable, fall back to macro.headlines alone. Record what you actually used in news_events with a per-item impact (bullish/bearish/neutral for NQ) and reflect it in macro_bias and the summary. Do NOT invent events — only report what the feed or your searches actually returned.

SYNTHESIS:
- Combine: the macro bias is the day's gravity; the open-type is the mechanics of the first move. State the TRUE EXPANSION DIRECTION at the open (where price actually goes once the open-type resolves), the exact level targeted, how far it runs, what confirms the move is complete, and the next target.
- reversal_zones: pick from the provided board levels (real scored strikes) the 2–4 where a major reversal is most likely given today's open-type + bias; each with a one-line reason. Use those strike prices; do not invent.
- clean_or_choppy: clean trending vs choppy, from DEX strength, VEX level, heatmap structure, charm.
- If macro inputs are missing (see macro.notes), weight what is present and say so; never fabricate readings.

OUTPUT — CRITICAL: respond with ONLY one raw JSON object, no prose/markdown. Shape:
{"macro_bias":"bullish"|"bearish"|"neutral","macro_bias_score":<-100..100 int>,"macro_drivers":[{"label":"2Y Yield","reading":"<short factual>","lean":"bull"|"bear"|"neutral"}],"open_type":"manip_down_real_up"|"manip_up_real_down"|"real_pump"|"real_dump"|"unclear","expansion_direction":"up"|"down"|"two-sided","targeted_level":<number>,"move_extent":"<short>","completion_signal":"<short>","next_target":<number>,"clean_or_choppy":"clean"|"choppy","manipulation_tell":"<short or empty>","reversal_zones":[{"price":<number>,"side":"support"|"resistance","note":"<short>"}],"news_events":[{"headline":"<short factual>","impact":"bullish"|"bearish"|"neutral","source":"<domain or empty>"}],"summary":"<one paragraph: bias, open type, expansion direction, key levels, main flow tell, clean/choppy, and any live event catalyst. Exact price levels only.>"}`;

const strikesNear = (snap: DataSnapshot, spot: number) => {
  const band = config.nearSpotBandPct * spot;
  return Object.keys(snap.gex_bar).map(Number).filter((k) => Math.abs(k - spot) <= band).sort((a, b) => a - b);
};

/** Distil the options snapshot into the PDF-1 inputs (flow, walls, fresh chain positioning). */
function buildFlowInput(snap: DataSnapshot, spot: number) {
  const rows = strikesNear(snap, spot).map((k) => {
    const s = k.toFixed(1);
    const oi = snap.oi_bar[s] ?? { calls: 0, puts: 0 };
    const vol = snap.vol_bar?.[s] ?? { calls: 0, puts: 0 };
    return {
      strike: k,
      side: k > spot ? "above" : "below",
      gex_m: M(snap.gex_bar[s] ?? 0),
      dex_m: M(snap.dex_bar[s] ?? 0),
      charm_m: M(snap.charm_bar?.[s] ?? 0),
      vega_m: M(snap.vex_bar?.[s] ?? 0),
      oi_calls: round(oi.calls), oi_puts: round(oi.puts),
      vol_oi_pct_calls: round(oi.calls > 0 ? (vol.calls / oi.calls) * 100 : 0),
      vol_oi_pct_puts: round(oi.puts > 0 ? (vol.puts / oi.puts) * 100 : 0),
    };
  });
  // Fresh flow = strikes that traded more than their OI today (a live battleground).
  const freshCalls = rows.filter((r) => r.vol_oi_pct_calls >= 100);
  const freshPuts = rows.filter((r) => r.vol_oi_pct_puts >= 100);
  return {
    gamma_flip: snap.zero_gamma,
    price_vs_flip: spot > snap.zero_gamma ? "above" : "below",
    call_wall: snap.call_wall, put_wall: snap.put_wall, major_wall: snap.major_wall,
    max_pain: snap.max_pain, vol_trigger: snap.vol_trigger,
    call_walls: snap.call_walls, put_walls: snap.put_walls,
    net_gex_regime: snap.gex_regime,
    net_dex_near: round(rows.reduce((a, r) => a + r.dex_m, 0), 1),
    net_vega_near: round(rows.reduce((a, r) => a + Math.abs(r.vega_m), 0), 1),
    atm_iv: snap.atm_iv, expected_move: snap.expected_move, realized_vol: snap.realized_vol, net_vanna: snap.net_vanna,
    fresh_call_strikes: freshCalls.map((r) => ({ strike: r.strike, side: r.side, vol_oi_pct: r.vol_oi_pct_calls })),
    fresh_put_strikes: freshPuts.map((r) => ({ strike: r.strike, side: r.side, vol_oi_pct: r.vol_oi_pct_puts })),
    strikes_near_spot: rows,
  };
}

function runClaude(userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The narrative pass MAY read live news (web search) — the per-tick scorer never does.
    // Whitelisting only WebSearch/WebFetch leaves everything else (Bash/Edit/Write) denied:
    // in headless `-p` mode an un-allowlisted tool can't prompt, so it simply can't run.
    const toolArgs = config.narrativeWebSearch
      ? ["--allowed-tools", "WebSearch WebFetch"]
      : ["--disallowed-tools", "*"];
    const args = ["-p", "--output-format", "json", "--model", config.model, "--system-prompt", SYSTEM, ...toolArgs];
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`Could not launch "${CLAUDE_BIN}": ${e.message}`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`))));
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

function parseJson<T>(cliStdout: string): T {
  let text = cliStdout;
  try { const env = JSON.parse(cliStdout) as { result?: string }; if (typeof env.result === "string") text = env.result; } catch { /* raw */ }
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON in model output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export const narrativeJsonPath = path.join(config.paths.root, "web", "narrative.json");

type SizeTopology = Pick<Narrative,
  "size_rule" | "size_rule_reason" | "entropy_state" | "entropy_ratio" |
  "topology_alignment" | "topology_note" | "pca1_dir" | "pca2_dir" |
  "vol_trigger_position" | "gex_key_levels">;

/**
 * YYY guide Ch.12.4: deterministically compute the entropy gate + topology alignment → size rule.
 * Entropy is the gate (CRITICAL = ZERO); topology sets conviction (conflicted = HALF not FULL).
 * PCA1 proxy = Hurst rolling_50 direction + macro lean; PCA2 proxy = GEX regime + GARCH state.
 */
function computeSizeAndTopology(
  entropy: EntropySummary | undefined,
  hurst: HurstSummary | undefined,
  garch: GarchSummary | undefined,
  snap: DataSnapshot,
  spot: number,
  macroBias: "bullish" | "bearish" | "neutral",
): SizeTopology {
  // Entropy gate ----------------------------------------------------------------
  let entropy_state: Narrative["entropy_state"] = "NORMAL";
  let entropy_ratio: number | undefined;
  if (entropy && entropy.threshold > 0) {
    entropy_ratio = Math.round((entropy.current_entropy / entropy.threshold) * 100) / 100;
    entropy_state = entropy_ratio >= 1.2 ? "CRITICAL" : entropy_ratio >= 1.0 ? "ELEVATED" : "NORMAL";
  }

  // PCA1 proxy — trend character (Hurst) + direction from macro bias -----------
  const h50 = hurst?.rolling_50 ?? hurst?.hurst ?? 0.5;
  const trending = h50 >= 0.55;
  const meanRev = h50 <= 0.45;
  const pca1_dir: Narrative["pca1_dir"] =
    macroBias === "bullish" ? "up" : macroBias === "bearish" ? "down" : "flat";

  // PCA2 proxy — vol/gamma structural axis: GEX regime + GARCH persistence -----
  const negGex = (snap.gex_regime ?? "").toLowerCase().includes("neg");
  const highVol = garch ? (garch.current_regime === "elevated" || garch.current_regime === "large") : false;
  let pca2_dir: Narrative["pca2_dir"] = "neutral";
  if (negGex || highVol) pca2_dir = "amplify";
  else if (!negGex && !highVol && (garch?.current_regime === "low" || garch?.current_regime === "normal")) pca2_dir = "suppress";

  // Topology alignment: trend axis vs structural axis agree ---------------------
  let topology_alignment: Narrative["topology_alignment"] = "unclear";
  let topology_note = "insufficient signal data";
  if (hurst) {
    if (trending && pca2_dir === "amplify") {
      topology_alignment = "aligned";
      topology_note = `Hurst ${h50.toFixed(2)} trending + GEX ${negGex ? "neg" : ""}/GARCH ${garch?.current_regime ?? "?"} amplifying — trust direction`;
    } else if (meanRev && pca2_dir === "suppress") {
      topology_alignment = "aligned";
      topology_note = `Hurst ${h50.toFixed(2)} mean-reverting + structure suppressing — fade the range`;
    } else if (trending && pca2_dir === "suppress") {
      topology_alignment = "conflicted";
      topology_note = `Hurst ${h50.toFixed(2)} trending but gamma suppressing — fade bias, lean bullish caution`;
    } else if (meanRev && pca2_dir === "amplify") {
      topology_alignment = "conflicted";
      topology_note = `Hurst ${h50.toFixed(2)} mean-reverting but gamma amplifying — chop with tails`;
    } else {
      topology_alignment = "unclear";
      topology_note = `Hurst ${h50.toFixed(2)}, ${pca2_dir} gamma — mixed signal`;
    }
  }

  // Size rule: entropy gate first, then topology conviction --------------------
  let size_rule: Narrative["size_rule"];
  let size_rule_reason: string;
  if (entropy_state === "CRITICAL") {
    size_rule = "ZERO";
    size_rule_reason = `entropy critical (ρ=${entropy_ratio?.toFixed(2)}) — flow is too disordered, no trades this session`;
  } else if (entropy_state === "ELEVATED" && topology_alignment === "conflicted") {
    size_rule = "ZERO";
    size_rule_reason = `elevated entropy + conflicted topology — double signal risk, sit out`;
  } else if (entropy_state === "ELEVATED") {
    size_rule = "HALF";
    size_rule_reason = `entropy elevated (ρ=${entropy_ratio?.toFixed(2)}) — noise in the flow, half size`;
  } else if (topology_alignment === "conflicted") {
    size_rule = "HALF";
    size_rule_reason = `topology conflicted (${topology_note.split("—")[0]?.trim() ?? topology_note}) — size conservatively`;
  } else if (topology_alignment === "aligned") {
    size_rule = "FULL";
    size_rule_reason = `entropy normal + topology aligned — full size`;
  } else {
    size_rule = "HALF";
    size_rule_reason = `topology unclear — default to half size until structure confirms`;
  }

  return {
    size_rule,
    size_rule_reason,
    entropy_state,
    entropy_ratio,
    topology_alignment,
    topology_note,
    pca1_dir,
    pca2_dir,
    vol_trigger_position: snap.vol_trigger != null ? (spot >= snap.vol_trigger ? "above" : "below") : undefined,
    gex_key_levels: {
      call_wall: snap.call_wall || undefined,
      put_wall: snap.put_wall || undefined,
      vol_trigger: snap.vol_trigger || undefined,
      max_pain: snap.max_pain || undefined,
      expected_move: snap.expected_move || undefined,
    },
  };
}

/** Build the full pre-open narrative from the latest snapshot + macro + board levels. */
export async function buildNarrative(
  snap: DataSnapshot,
  spot: number,
  board: Board | null,
  asOf: string,
  capture?: { entropy?: EntropySummary; hurst?: HurstSummary; garch?: GarchSummary },
): Promise<Narrative> {
  const macro = await fetchMacro();
  const flow = buildFlowInput(snap, spot);
  const boardLevels = (board?.levels ?? []).map((l) => ({ strike: l.strike, side: l.side, reversal_prob: l.reversal_prob }));

  const input = {
    as_of: asOf,
    spot,
    minutes_to_open: minutesToOpen(asOf),
    flow,
    macro,
    board_levels: boardLevels,
  };

  let parsed: Partial<Narrative>;
  let method: Narrative["scoring_method"] = "ai";
  try {
    parsed = parseJson<Partial<Narrative>>(await runClaude(JSON.stringify(input)));
  } catch (err) {
    console.warn("Narrative AI failed:", err instanceof Error ? err.message : err);
    parsed = fallbackNarrative(flow, macro, boardLevels);
    method = "unavailable";
  }

  const open_type = (parsed.open_type ?? "unclear") as Narrative["open_type"];
  const macroBias = (parsed.macro_bias ?? "neutral") as Narrative["macro_bias"];
  const sizeTopology = computeSizeAndTopology(
    capture?.entropy, capture?.hurst, capture?.garch, snap, spot, macroBias,
  );
  return {
    as_of: asOf,
    generated_at: new Date().toISOString(),
    scored_at: Date.now(),
    spot,
    macro_bias: macroBias,
    macro_bias_score: parsed.macro_bias_score,
    macro_drivers: parsed.macro_drivers ?? [],
    open_type,
    open_type_label: OPEN_TYPE_LABELS[open_type],
    expansion_direction: parsed.expansion_direction ?? "two-sided",
    targeted_level: parsed.targeted_level,
    move_extent: parsed.move_extent,
    completion_signal: parsed.completion_signal,
    next_target: parsed.next_target,
    clean_or_choppy: parsed.clean_or_choppy ?? "choppy",
    manipulation_tell: parsed.manipulation_tell,
    reversal_zones: parsed.reversal_zones ?? [],
    summary: parsed.summary ?? "Narrative unavailable.",
    news_events: parsed.news_events ?? [],
    scoring_method: method,
    macro,
    ...sizeTopology,
  };
}

/** Minutes until the 09:30 ET open, from an ET-wall-clock ISO. */
function minutesToOpen(etIso: string): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(etIso);
  if (!m) return null;
  return 9 * 60 + 30 - (Number(m[1]) * 60 + Number(m[2]));
}

/** Deterministic fallback when Claude is unavailable — rough bias + open-type from raw signals. */
function fallbackNarrative(
  flow: ReturnType<typeof buildFlowInput>,
  macro: MacroSnapshot,
  boardLevels: { strike: number; side: string; reversal_prob: number }[],
): Partial<Narrative> {
  // Macro lean from the simple PDF-2 rules.
  let score = 0;
  const drivers: Narrative["macro_drivers"] = [];
  if (macro.us2y) {
    const bear = macro.us2y.dir === "rising";
    score += bear ? -25 : macro.us2y.dir === "falling" ? 25 : 0;
    drivers.push({ label: "2Y Yield", reading: `${macro.us2y.last} (${macro.us2y.dir})`, lean: bear ? "bear" : macro.us2y.dir === "falling" ? "bull" : "neutral" });
  }
  if (macro.tga) { const bull = macro.tga.dir === "falling"; score += bull ? 15 : -10; drivers.push({ label: "TGA", reading: `${macro.tga.last} (${macro.tga.dir})`, lean: bull ? "bull" : "bear" }); }
  if (macro.rrp) { const bull = macro.rrp.dir === "falling"; score += bull ? 15 : -10; drivers.push({ label: "RRP", reading: `${macro.rrp.last} (${macro.rrp.dir})`, lean: bull ? "bull" : "bear" }); }
  if (macro.cot) { const bear = macro.cot.percentile > 80; score += bear ? -15 : macro.cot.percentile < 50 ? 10 : 0; drivers.push({ label: "COT", reading: `${macro.cot.percentile}th pct`, lean: bear ? "bear" : "neutral" }); }
  // OAS credit spreads (YYY Ch.12.2)
  if (macro.oas) {
    if (macro.oas.level === "crisis") { score -= 20; drivers.push({ label: "OAS", reading: `${macro.oas.last}% CRISIS`, lean: "bear" }); }
    else if (macro.oas.level === "elevated") { score -= 12; drivers.push({ label: "OAS", reading: `${macro.oas.last}% elevated`, lean: "bear" }); }
    else if (macro.oas.level === "healthy") { score += 12; drivers.push({ label: "OAS", reading: `${macro.oas.last}% healthy`, lean: "bull" }); }
    else { drivers.push({ label: "OAS", reading: `${macro.oas.last}% mild`, lean: "neutral" }); }
  }
  // VIX term structure (backwardation = stressed)
  if (macro.vix_term?.structure === "backwardation") { score -= 8; drivers.push({ label: "VIX Term", reading: `backwardation (stressed)`, lean: "bear" }); }
  else if (macro.vix_term?.structure === "contango") { score += 5; drivers.push({ label: "VIX Term", reading: `contango (normal)`, lean: "bull" }); }
  // Reserve balances
  if (macro.reserve_bal && macro.reserve_bal.dir !== "flat") {
    const bull = macro.reserve_bal.dir === "rising";
    score += bull ? 8 : -8;
    drivers.push({ label: "Reserve Bal", reading: `${macro.reserve_bal.dir}`, lean: bull ? "bull" : "bear" });
  }
  // Cross-asset risk-off overlay: a fast oil/VIX/dollar move is bearish NQ even if yields are calm.
  const oil = macro.cross?.brent ?? macro.cross?.wti;
  if (oil?.dir === "rising") { score -= 15; drivers.push({ label: "Oil", reading: `${oil.last} (rising)`, lean: "bear" }); }
  if (macro.cross?.vix) { const bear = macro.cross.vix.dir === "rising"; score += bear ? -15 : macro.cross.vix.dir === "falling" ? 8 : 0; drivers.push({ label: "VIX", reading: `${macro.cross.vix.last} (${macro.cross.vix.dir})`, lean: bear ? "bear" : "neutral" }); }
  if (macro.cross?.dxy?.dir === "rising") { score -= 10; drivers.push({ label: "Dollar", reading: `${macro.cross.dxy.last} (rising)`, lean: "bear" }); }
  if (macro.cross?.copper && macro.cross.copper.dir !== "flat") { const bull = macro.cross.copper.dir === "rising"; score += bull ? 8 : -8; drivers.push({ label: "Copper", reading: `${macro.cross.copper.last} (${macro.cross.copper.dir})`, lean: bull ? "bull" : "bear" }); }

  const macro_bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";
  const res = boardLevels.filter((l) => l.side === "resistance").sort((a, b) => b.reversal_prob - a.reversal_prob)[0];
  const sup = boardLevels.filter((l) => l.side === "support").sort((a, b) => b.reversal_prob - a.reversal_prob)[0];

  return {
    macro_bias, macro_bias_score: score, macro_drivers: drivers,
    open_type: "unclear",
    expansion_direction: "two-sided",
    clean_or_choppy: "choppy",
    reversal_zones: [res, sup].filter(Boolean).map((l) => ({ price: l!.strike, side: l!.side as "support" | "resistance", note: "top board level" })),
    summary: `Rule-based pre-open read (AI offline): macro ${macro_bias}. Open type requires AI — wait for AI to be available. Watch ${res ? "$" + res.strike : "n/a"} resistance / ${sup ? "$" + sup.strike : "n/a"} support.`,
  };
}

export async function writeNarrative(n: Narrative): Promise<void> {
  await fs.mkdir(path.dirname(narrativeJsonPath), { recursive: true });
  await fs.writeFile(narrativeJsonPath, JSON.stringify(n, null, 2), "utf8");
}
