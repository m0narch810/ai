// DAY GATE — one deterministic answer to "should I be resting limits at levels TODAY at all?"
//
// The nuance it encodes: an expiry on the calendar does NOT by itself make a low-probability
// day. Expiries matter in proportion to (a) how much vol/gamma positioning exists to unwind
// and (b) how fragile the tape regime already is. So the gate is a composite: the computed
// CBOE calendar × live flow state (entropy, VRP, vanna×charm alignment, net-gamma regime,
// GARCH, Hurst) × the pre-open call (topology alignment, auction day).
//
// DELIBERATELY NO NUMERIC WEIGHTS. Point scores would be pseudo-precision (hand-picked
// magnitudes), and fitting weights to our own short history would be curve-fitting — both
// violate the project's no-overfitting rule. Instead each factor is classified by SEVERITY,
// the one judgment that IS defensible from the references:
//   MAJOR — the mechanism alone breaks the edge (clean tick reversals at structure):
//           disordered flow, an under-hedged tape, a vol shock, the VIX settlement morning.
//   minor — contextual; degrades the day only in combination.
// Verdict is a plain-English count rule:
//   STAND DOWN — two majors, or one major with three corroborating minors.
//   SELECTIVE  — one major, or three minors (half size, confirmation entries only).
//   TAKE       — otherwise.
// Every firing factor is listed, so the verdict is auditable, never a black box.
//
// It is ADVISORY (display-layer): it never blocks scoring or caps the AI's probabilities —
// per the system's discretion principle, the trader (and the AI, which sees the same raw
// inputs) can overrule it with a stated reason. Calibration path, when enough history exists:
// VALIDATE the factor list out-of-sample against the calibration logs (clean-reversal rate on
// STAND DOWN vs TAKE days) and promote/demote factors on evidence — never tune weights in-sample.
import type { CaptureRecord, DayGate, DayGateReason } from "./types.js";
import { expiryContext } from "./expiries.js";
import type { DayContext } from "./score.js";

const near = (map: Record<string, number> | undefined, spot: number, bandPct = 0.025): number => {
  if (!map) return 0;
  const band = spot * bandPct;
  let s = 0;
  for (const [k, v] of Object.entries(map)) if (Math.abs(Number(k) - spot) <= band) s += v ?? 0;
  return s;
};

/**
 * Altaris's realized_vol prints degenerate values at session boundaries (seen live: 200.0 on the
 * 09:30 open capture — the overnight gap annualized off two bars — and 55.4 post-close vs ~7 all
 * afternoon). Only trust it from mid-morning to the cash close.
 */
export function reliableRealizedVol(capturedAt: string, rv: unknown): number | null {
  if (typeof rv !== "number" || !Number.isFinite(rv)) return null;
  const m = /T(\d{2}):(\d{2})/.exec(capturedAt);
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 9 * 60 + 45 && min <= 16 * 60 ? rv : null;
}

export function computeDayGate(latest: CaptureRecord, spot: number, dayContext?: DayContext): DayGate {
  const cur = latest.data;
  const reasons: DayGateReason[] = [];
  const major = (label: string) => reasons.push({ severity: "major", label });
  const minor = (label: string) => reasons.push({ severity: "minor", label });

  // ── Calendar (computed CBOE dates) ────────────────────────────────────────────
  const exp = expiryContext(latest.capturedAt);
  if (exp) {
    // Settlement DAY is major on its own — the AM SOQ print mechanically distorts the open
    // regardless of regime. The EVE only matters when flow state corroborates → minor.
    if (exp.days_to_vix_settlement === 0) major("VIX monthly settlement this morning — AM print distorts the open, vol positioning unwinds");
    else if (exp.days_to_vix_settlement === 1) minor("VIX monthly settlement tomorrow AM — unwind chop often starts today");
    else if (exp.vix_weekly_expiry_today) minor("VIX weekly expiry (Wednesday) — small OI vs the monthly");
    if (exp.days_to_monthly_opex === 0) {
      if (exp.quad_witching_opex) major("Quad witching OPEX — the largest scheduled unwind flows, wide oscillation around pins");
      else minor("Monthly OPEX — pins run hot but evaporate at the bell");
    } else if (exp.days_since_monthly_opex >= 1 && exp.days_since_monthly_opex <= 2) {
      minor("Just after monthly OPEX — OI rebuilding, standing walls may be stale");
    }
  }
  if (dayContext?.auction_today) minor("10Y/20Y/30Y auction today — liquidity pulled, vol without direction");
  // Scheduled macro releases (ForexFactory USD high-impact calendar via the pre-open narrative;
  // this was the Altaris FRED calendar until Altaris was retired 2026-09-01). An FOMC decision
  // lands MID-SESSION (14:00 ET) — the pre-print squaring + post-print repricing break the
  // resting-limit edge on their own → major. CPI/NFP/PCE print pre-open (08:30) and shape the
  // whole tape → minor. (Altaris's composite event_risk score had no replacement and is gone.)
  const eventsToday = (dayContext?.upcoming_events ?? []).filter((e) => e.days === 0);
  if (eventsToday.some((e) => /fomc|rate decision|fed funds/i.test(e.name))) {
    major("FOMC decision today — mid-session repricing breaks the resting-limit edge");
  } else if (eventsToday.some((e) => /cpi|nfp|payroll|pce|ism/i.test(e.name))) {
    minor(`Major macro print today (${eventsToday.map((e) => e.name).join(", ")}) — event-driven tape`);
  }

  // ── Live flow state (this tick's capture) ─────────────────────────────────────
  const ent = latest.entropy;
  if (ent && ent.threshold > 0) {
    const r = ent.current_entropy / ent.threshold;
    if (r >= 1.2) major(`Flow entropy CRITICAL (ρ=${r.toFixed(2)}) — positioning is disordered, walls unreliable`);
    else if (r >= 1.0) minor(`Flow entropy elevated (ρ=${r.toFixed(2)}) — noisy flow`);
  }
  // Negative VRP: realized vol has caught up to implied — dealers under-hedged, walls get run through.
  const rv = reliableRealizedVol(latest.capturedAt, cur.realized_vol);
  if (rv != null && typeof cur.atm_iv === "number" && rv > cur.atm_iv) {
    major(`Negative VRP (realized ${rv.toFixed(1)} > implied ${cur.atm_iv.toFixed(1)}) — under-hedged tape, continuation over reversal`);
  }
  const g = latest.garch;
  if (g && (g.current_regime === "elevated" || g.current_regime === "large") && (g.z_score ?? 0) > 1) {
    major(`GARCH ${g.current_regime} vol (z=${g.z_score?.toFixed(1)}) — vol shock regime, walls need multiple tests`);
  }
  // Vanna × charm alignment (the day-conviction filter, deterministic version): opposed forced
  // flows cancel — no net drift, structurally real levels produce "nothing happens" fades.
  const ivDir = (latest.iv?.direction ?? "").toUpperCase();
  const vannaDrift = ivDir.includes("FALL") ? 1 : ivDir.includes("RIS") ? -1 : 0;
  const charmDrift = Math.sign(near(cur.charm_bar, spot));
  if (vannaDrift !== 0 && charmDrift !== 0 && vannaDrift !== charmDrift) {
    minor("Vanna and charm drifts OPPOSED — forced flows cancel, low-conviction day");
  }
  if ((cur.gex_regime ?? "").toLowerCase().includes("neg")) {
    minor("Negative net gamma — dealers amplify moves, non-dominant levels get blown through");
  }
  if (cur.vol_trigger != null && spot < cur.vol_trigger) {
    minor("Spot below vol trigger — dealers are forced procyclical sellers into declines");
  }
  const h50 = latest.hurst?.rolling_50;
  if (typeof h50 === "number" && h50 > 0.65) {
    minor(`Strongly trending tape (Hurst ${h50.toFixed(2)}) — only the terminal wall is a fade, intermediates are targets`);
  }

  // ── Pre-open call ─────────────────────────────────────────────────────────────
  if (dayContext?.topology_alignment === "conflicted") {
    minor("Topology conflicted (trend axis vs vol/gamma axis disagree) — sized-down day per the pre-open read");
  }
  // A committed chop/rotation call means the expected range rarely clears the 0.5% large-reversal
  // objective — contextual, degrades the day only in combination (rotation CAN still reach a range end).
  if (dayContext?.open_type === "chop_day") {
    minor("Pre-open call is a chop/rotation day — no directional expansion expected, range ends only");
  }

  const majors = reasons.filter((r) => r.severity === "major").length;
  const minors = reasons.length - majors;
  const verdict: DayGate["verdict"] =
    majors >= 2 || (majors === 1 && minors >= 3) ? "STAND DOWN"
    : majors === 1 || minors >= 3 ? "SELECTIVE"
    : "TAKE";
  reasons.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1));
  return { verdict, majors, minors, reasons };
}
