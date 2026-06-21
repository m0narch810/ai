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
import type { Board, DataSnapshot, MacroSnapshot, Narrative } from "./types.js";

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
1) "manip_down_real_up": price sits just below/at the put wall (obvious stops to trigger); DEX positive (dealers must BUY further drops); max pain well above; chain shows CALL buying at strikes above price while weak; clean air down to the put wall then strong support there. Tell: call buying DURING weakness.
2) "manip_up_real_down": price sits just below the call wall (shorts to squeeze); DEX negative (dealers must SELL rallies); max pain well below; chain shows PUT buying below price while futures strong overnight; clean air up to the call wall then strong resistance. VEX elevated → sharp reversal. Tell: put buying DURING strength.
3) "real_pump": price well ABOVE gamma flip, call wall far above (room); DEX strongly positive (dealers fuel rallies); max pain above; BROAD overnight call buying across MULTIPLE strikes/expiries (not one strike); clean air above; charm drifts up; VEX low → smooth trend.
4) "real_dump": price well BELOW gamma flip; DEX strongly negative (dealers sell every bounce); max pain below; BROAD overnight put buying across multiple strikes; clean air below; VEX high → fast sharp, convincing-but-failing bounces.
MANIPULATION TEST: does the opening move AGREE with DEX or FIGHT it? Fighting DEX = likely manipulation (dealer rehedging overpowers it). Does fresh chain flow CONFIRM the move or position OPPOSITE? Opposite fresh flow = manipulation. One strike of flow = one trader (ignore); flow across many strikes = real conviction.

METHOD 2 — RTH MACRO BIAS:
- 2Y yield: leads stocks. Higher this morning vs prior close = bearish NQ; lower = bullish. FAST move in the pre-open is the real signal; slow drift = nothing. Fast-rising 2Y (esp. WITHOUT the 10Y following) = bearish; fast-falling = bullish.
- Net liquidity: TGA falling (Treasury spending) = cash in = bullish; RRP draining = cash to work = bullish. Rising TGA / building RRP = tightening = bearish.
- Surprise mechanism: gap between expectation and print drives big moves; first 15min after a release is noise, real institutional move is 30–90min later.
- BOJ/carry: fast YEN STRENGTHENING (USD/JPY falling hard) forces carry unwind → sell equities regardless of US data.
- Crowding/COT: speculators at extremes (>80 = crowded long, no buyers left, reversal risk; <20 = crowded short). Below 50 = room for buyers.
BIAS RULE: bullish when 2Y stable/falling AND liquidity flowing in (TGA down / RRP draining) AND COT < 50. Bearish when 2Y rising fast (esp. without 10Y) AND liquidity tightening AND COT > 80. Otherwise neutral, and say which factors conflict.

METHOD 2.5 — CROSS-ASSET & EVENT OVERLAY (macro.cross):
Read the cross-asset basket as the market pricing geopolitics/commodities in real time — a fast move here can OVERRIDE the yield-curve bias toward risk-off. Each reading has dir computed on a 0.2% threshold, so "rising"/"falling" already means a real move.
- Oil (brent/wti) spiking = energy/geopolitics shock (e.g. supply disruption). Sharp oil up → inflation + growth fear → RISK-OFF, bearish NQ, regardless of yields. This is the Strait-of-Hormuz / Middle-East-flare case: oil leads, equities follow down.
- VIX rising fast = fear bid → bearish, expect chop/sharp reversals (raise VEX weighting). VIX falling = calm → supports clean trend.
- DXY (dollar) rising fast = tightening / haven flight → bearish NQ. Falling dollar = bullish.
- Gold rising WITH oil/VIX = haven rotation confirming risk-off. Gold rising alone (dollar flat) = softer read.
- Copper falling = global-growth fear (bearish); rising = reflation (bullish).
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

/** Build the full pre-open narrative from the latest snapshot + macro + board levels. */
export async function buildNarrative(
  snap: DataSnapshot,
  spot: number,
  board: Board | null,
  asOf: string,
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
  return {
    as_of: asOf,
    generated_at: new Date().toISOString(),
    scored_at: Date.now(),
    spot,
    macro_bias: parsed.macro_bias ?? "neutral",
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
  // Cross-asset risk-off overlay: a fast oil/VIX/dollar move is bearish NQ even if yields are calm.
  const oil = macro.cross?.brent ?? macro.cross?.wti;
  if (oil?.dir === "rising") { score -= 15; drivers.push({ label: "Oil", reading: `${oil.last} (rising)`, lean: "bear" }); }
  if (macro.cross?.vix) { const bear = macro.cross.vix.dir === "rising"; score += bear ? -15 : macro.cross.vix.dir === "falling" ? 8 : 0; drivers.push({ label: "VIX", reading: `${macro.cross.vix.last} (${macro.cross.vix.dir})`, lean: bear ? "bear" : "neutral" }); }
  if (macro.cross?.dxy?.dir === "rising") { score -= 10; drivers.push({ label: "Dollar", reading: `${macro.cross.dxy.last} (rising)`, lean: "bear" }); }

  const negRegime = (flow.net_gex_regime || "").toLowerCase().includes("neg");
  const open_type: Narrative["open_type"] = negRegime ? "real_dump" : flow.price_vs_flip === "above" ? "real_pump" : "unclear";
  const macro_bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";
  const res = boardLevels.filter((l) => l.side === "resistance").sort((a, b) => b.reversal_prob - a.reversal_prob)[0];
  const sup = boardLevels.filter((l) => l.side === "support").sort((a, b) => b.reversal_prob - a.reversal_prob)[0];

  return {
    macro_bias, macro_bias_score: score, macro_drivers: drivers,
    open_type, expansion_direction: macro_bias === "bullish" ? "up" : macro_bias === "bearish" ? "down" : "two-sided",
    clean_or_choppy: negRegime ? "choppy" : "clean",
    reversal_zones: [res, sup].filter(Boolean).map((l) => ({ price: l!.strike, side: l!.side as "support" | "resistance", note: "top board level" })),
    summary: `Rule-based pre-open read (AI offline): macro ${macro_bias}, gamma regime ${flow.net_gex_regime}. Watch ${res ? "$" + res.strike : "n/a"} resistance / ${sup ? "$" + sup.strike : "n/a"} support.`,
  };
}

export async function writeNarrative(n: Narrative): Promise<void> {
  await fs.mkdir(path.dirname(narrativeJsonPath), { recursive: true });
  await fs.writeFile(narrativeJsonPath, JSON.stringify(n, null, 2), "utf8");
}
