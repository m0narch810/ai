import { spawn } from "node:child_process";
import { config, type SessionDef } from "./config.js";
import type { Board, CaptureRecord, DataSnapshot, DetectedLevel } from "./types.js";

const SESSION_NOTES: Record<SessionDef["name"], string> = {
  US: "US regular session: options are trading, so OI/GEX/charm/vanna and flows are LIVE and updating. Spot is QQQ.",
  Asia: "ASIA OVERNIGHT session: US options are CLOSED, so OI/GEX/charm/vanna are STATIC from the prior US close (standing positioning, not fresh flow). Spot is derived from NQ futures converted to QQQ-equivalent; overnight liquidity is thinner and moves are lower-conviction. Treat the levels as prior-close positioning that price may probe on light volume — be more conservative, lean on the largest/highest-OI walls, and don't over-read minor overnight pokes.",
};

const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || (process.platform === "win32" ? "claude.exe" : "claude");

const SYSTEM = `You are a reversal-level analyst for QQQ options flow from the Altaris terminal.

Your one job: given the current options structure and how it is SHIFTING intraday, output a ranked list of price levels (strikes) where a reversal is likely IF price reaches them, each with a probability.

Definitions and rules — follow exactly:
- Reversal probability is CONDITIONAL on a CLEAN reversal: P(price turns within ~clean_reversal_pts of the strike AND moves >= min_reversal_move | price reaches the strike). A strike can score high yet never be reached — that's fine, the resting limit order simply never fills.
- HARD STOP: a level is for resting a limit order with a one-strike stop. If price trades a full strike (hard_stop_pts) BEYOND the level, that level has BROKEN — it is invalid, not a reversal. Score for the clean turn, not a sloppy grind: a level price chews through by half a strike before bouncing is a WEAK reversal, score it lower. Favor levels with the structure to turn price tightly.
- "side": "resistance" if it's above spot (price would rise into it and reverse down), "support" if below spot (price would fall into it and reverse up).
- This is institutional-style positioning, not scalping. Levels must respect >= 0.25% of spot spacing; do not cluster trivially adjacent strikes.
- Evidence for a strong reversal level: large OI mass (calls+puts), strong gamma wall (|GEX|), being a named level (Call/Put/Major Wall, Max Pain, Gamma Flip / zero_gamma, Vol Trigger), and CONFLUENCE of several at/near the same strike.
- Per-strike exposures are in $millions. Read them together:
  - gex (gamma): large |gex| = strong pin/wall — the primary reversal magnet.
  - dex (delta): directional dealer positioning at the strike.
  - vega: exposure to IV level — matters more when IV is moving.
  - vanna: exposure to IV-x-spot — drives hedging flows WHEN IV MOVES. Its weight depends on the iv block (below): heavy when IV is trending, minor when IV is flat.
  - charm (delta decay): intensifies into expiry; large |charm| marks strikes that pull/repel price as time passes — a strong confluence signal at walls.
  - tex (theta): time-decay exposure; concentrations mark pinning strikes.
  - rho: rate sensitivity — usually minor intraday; only note it if unusually large.
  A level with several of these stacking (e.g. big gex + big |charm| + big vanna + OI mass) is a much stronger reversal candidate than gex alone.
- The "iv" block gives the IV regime: current vs session-start IV, the change, direction, and a vanna_note. USE IT to weight vanna/vega: if IV is RISING/FALLING, vanna flows matter and vanna-heavy strikes gain reversal strength; if STABLE, downweight vanna and lean on gamma/charm. Follow the vanna_note's guidance.
- The DELTAS (d_*) matter as much as the levels: gex/vanna/charm/OI building at a strike strengthens it; bleeding weakens it. Weigh the trend, not just the snapshot.
- Regime modifier: positive net GEX strengthens pinning (fade into levels); negative net GEX weakens pins and favors breaks — temper reversal probabilities accordingly.
- You are given your OWN previous call. REVISE it rather than recomputing from scratch — only move a probability when the data justifies it. Avoid jitter.
- "graded_levels" shows which levels price has REACHED today and how they resolved on the tape (overshoot_pts = how far price pushed beyond the level; clean = whether it turned tightly):
  - outcome "broke" => price went a full strike beyond it. DROP it entirely. Do not relist a broken level as a fresh setup; that price area is invalid until structure rebuilds.
  - outcome "reversed" with clean=false => it held only after grinding past the clean zone: a weak hold. If you keep it, lower its probability.
  - outcome "pending" with clean=false => price is grinding through it RIGHT NOW (overshot the clean zone, not yet a full strike): treat as compromised and de-rate it.
  - A clean "reversed" already played out — don't re-rank it as a fresh entry for the same touch.
- A "session" block tells you whether it's the US session or the Asia overnight session. In Asia: the OI/greeks are STATIC prior-close positioning (US options closed) and spot is NQ-futures-derived — be more conservative, lean on the largest walls, factor thinner liquidity, and say so in your reasoning. Read its "note" and adjust. "spot" is the effective live price; "altaris_spot" may be stale overnight.
- Focus on actionable levels near spot. Output at most ~8 levels. Be selective.
- For each level also output "tags": 2-4 SHORT confluence chips naming the structural reasons it's a level — e.g. "Call Wall", "Put Wall", "0DTE", "Major Wall", "Max Pain", "Zero Gamma", "Vol Trigger", "GEX +1.7B", "OI 107k", "Charm", "Vanna". Terse (chip-sized); the "why" remains the one-line narrative.

OUTPUT FORMAT — CRITICAL:
Respond with ONLY a single raw JSON object, no prose, no markdown fences. Shape:
{"as_of":"<string>","spot":<number>,"regime":"<string>","levels":[{"strike":<number>,"reversal_prob":<0-100 integer>,"side":"support"|"resistance","tags":["<chip>","<chip>"],"why":"<one short line>"}]}`;

const round = (n: number, p = 0) => { const f = 10 ** p; return Math.round(n * f) / f; };
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
  const M = (n: number) => Math.round((n / 1e6) * 10) / 10; // exposures in $millions
  type BarName = "gex_bar" | "dex_bar" | "vex_bar" | "charm_bar" | "tex_bar" | "vanna_bar" | "rex_bar";
  const bar = (snap: typeof cur, name: BarName, k: string) => snap[name]?.[k] ?? 0;

  return strikesNear(cur, spot).map((k) => {
    const s = key(k);
    const oi = cur.oi_bar[s] ?? { calls: 0, puts: 0 };
    const oiRef = ref.oi_bar[s] ?? { calls: 0, puts: 0 };
    const d = (name: BarName) => M(bar(cur, name, s) - bar(ref, name, s));
    return {
      strike: k,
      oi_calls: round(oi.calls), oi_puts: round(oi.puts),
      gex_m: M(bar(cur, "gex_bar", s)), dex_m: M(bar(cur, "dex_bar", s)),
      vega_m: M(bar(cur, "vex_bar", s)), vanna_m: M(bar(cur, "vanna_bar", s)),
      charm_m: M(bar(cur, "charm_bar", s)), tex_m: M(bar(cur, "tex_bar", s)),
      rho_m: M(bar(cur, "rex_bar", s)),
      d_oi_calls: round(oi.calls - oiRef.calls), d_oi_puts: round(oi.puts - oiRef.puts),
      d_gex_m: d("gex_bar"), d_vanna_m: d("vanna_bar"), d_charm_m: d("charm_bar"), d_vega_m: d("vex_bar"),
    };
  });
}

function buildInput(history: CaptureRecord[], prior: Board | null, detected: DetectedLevel[], session: SessionDef, spot: number) {
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
      hard_stop_pts: config.hardStopPts,
      clean_reversal_pts: config.cleanReversalPts,
    },
    iv: history[history.length - 1]!.iv ?? null,
    strikes_near_spot: buildStrikeRows(history, spot),
    your_prior_call: prior ? prior.levels.map((l) => ({ strike: l.strike, reversal_prob: l.reversal_prob, side: l.side })) : null,
    graded_levels: detected
      .filter((d) => d.touched)
      .map((d) => ({ strike: d.strike, side: d.side, outcome: d.outcome, overshoot_pts: d.overshoot ?? null, clean: d.clean ?? null })),
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
): Promise<Board> {
  const input = buildInput(history, prior, detected, session, spot);
  const board = parseBoard(await runClaude(JSON.stringify(input)));

  const cur = history[history.length - 1]!.data;
  const iv = history[history.length - 1]!.iv;
  board.as_of = input.as_of;
  board.scored_at = Date.now();
  board.spot = spot;
  board.regime = cur.gex_regime;
  board.iv = iv ? { current: iv.current_iv, direction: iv.direction } : undefined;
  board.expected_move = cur.expected_move;
  board.levels = (board.levels ?? []).sort((a, b) => b.reversal_prob - a.reversal_prob);
  return board;
}
