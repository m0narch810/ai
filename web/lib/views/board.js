// BOARD — the "where are we, what is around us" tab.
//
// Everything here is live YYY, so it is correct with the scoring PC off. The locally-scored
// desk board (AI levels / tape / day gate / IV walls) is appended at the bottom as a clearly
// age-stamped block rather than the page's headline, because in practice it is days old.

import { el, isNum, fmt, pct, compact, compactSigned, strikeLabel, agoText, clamp, asciiBar } from "../util.js";
import { panel, tag, segmented, statGrid, nodata, rule, skeleton } from "../ui.js";
import { spine, candles, stat, emptyPanel, lineChart } from "../draw.js";
import { screen, fmtDelta, inSession, openDrive, wallTargets, studyRate, fmtRate, rateLine, screenEta, openGap, BREAK_EVEN } from "../ivtape.js";
import { greek, levelMarks, boardMarks, frontExpiryIndex } from "../data.js";
import { liveIvWalls, wallZones } from "../ivwalls.js";
import { buildSurfacePanel } from "./vol.js";
import { candidates, TARGET_MNQ, STOP_MNQ } from "../levelsignal.js";
import { etNow } from "../util.js";

export const ID = "board";
export const LABEL = "BOARD";
export const JP = "板";
export const EPS = ["gex", "chart", "zero_dte", "expected_move", "levels", "dealer_delta", "atr", "iv_surface", "net_iv", "flow"];

// Expiry column chosen in the gamma ladder. "front" = the first expiry that can still trade
// (today's before the close, tomorrow's after it) — the default; null = whole chain.
let expIdx = "front";
const resolveExp = (expiries) => (expIdx === "front" ? frontExpiryIndex(expiries) : expIdx);

export function render(host, ctx) {
  const { ok, err } = ctx.yyy;
  const spot = ctx.spot;
  const g = greek("gex", ok.gex, resolveExp(greek("gex", ok.gex, null).expiries));
  const lv = g.levels || {};
  const marks = new Set([...levelMarks(lv), ...boardMarks(ctx.desk?.board)]);

  // Zones on the ladders use the FROZEN bracket (cloud open-frozen → desk → live): the study
  // (data/study/ivwalls_2224_report.md) found the live bracket shrinks ~4x through the day and
  // its walls, being a moving target, filled at half the rate of the frozen ones.
  const walls = frozenWalls(ctx) || liveIvWalls(ok.net_iv, spot, etNow().minutes) || null;
  const zones = wallZones(walls);

  // Default order (the user can rearrange any of it — app.js applyLayout runs after this):
  // structure + walls, the desk read, the gamma ladder, the surface, expected move, 0DTE, price last.
  host.replaceChildren(...[
    signalPanel(ctx),
    structurePanel(ok, spot, lv, ctx),
    ivWallsPanel(ok.net_iv, ctx.desk?.board?.iv_walls, spot, ctx),
    ivStatePanel(ctx),
    dayReadPanel(ctx, g, spot),
    deskPanel(ctx.desk, spot, ctx),
    gammaPanel(g, spot, marks, err, ctx, zones),
    buildSurfacePanel(ok, ctx, "07"),
    movePanel(ok.expected_move, ok.levels, ok.atr, spot, ctx),
    zeroDtePanel(ok.zero_dte, spot, ctx),
    pricePanel(ok, spot, lv, ctx.desk?.board, ctx),
  ].filter(Boolean));
}

/* ── 00 SIGNAL: which level to take ──────────────────────────────────────── */

/**
 * The take list. Only the rules that survived the 2026-09-17 studies (see web/lib/levelsignal.js for each
 * rule's evidence): a day gate on the expected move left, two hard skips (support on falling IV; a wall in
 * heavily traded price), one tilt (walls before 11:30) and the pluses. Hover any row for the reasoning.
 */
function signalPanel(ctx) {
  const { gate, rows } = candidates(ctx);
  const tone = gate.verdict === "TAKE" ? "cool" : gate.verdict === "STAND DOWN" ? "neg" : "mute";
  const head = statGrid([
    stat("DAY", gate.verdict, { tone, sub: isNum(gate.room) ? `${gate.room.toFixed(0)} MNQ of move left (need 120)` : "RTH only" }),
    stat("ATM IV", isNum(gate.iv) ? `${gate.iv.toFixed(1)}%` : "—", { sub: ctx.ivstate?.status === "ok" ? `${ctx.ivstate.cls} 30m` : "tape warming" }),
    stat("BRACKET", `${STOP_MNQ} / +${TARGET_MNQ}`, { sub: "MNQ stop / target" }),
  ]);
  const body = rows.length
    ? el("div.ladder", null, rows.map((r) => {
        const t = r.verdict === "TAKE" ? "cool" : r.verdict === "SKIP" ? "neg" : "mute";
        const reasons = [...r.skip, ...r.minus, ...r.plus];
        const lines = [`${r.K} ${r.side.toUpperCase()} — ${r.verdict}`, ...reasons.map((x) => `${x.tag}: ${x.why}`), r.note];
        const tip = lines.join(String.fromCharCode(10));
        return el(`div.ladder-row.plain.is-${r.side === "support" ? "sup" : "res"}`, { "data-tip": tip }, [
          el("span.lr-name", { text: r.side === "support" ? "BUY" : "SELL" }),
          el("span.lr-price", { text: strikeLabel(r.K) }),
          el("span.lr-bar", null, el("span.lr-desk", { text: reasons.map((x) => x.tag).join(" · ") || "nothing for or against" })),
          el("span.lr-dist", null, tag(r.verdict, t)),
        ]);
      }))
    : nodata(gate.verdict === "OFF" ? "RTH ONLY" : "NO CANDIDATES IN REACH");
  return panel({
    idx: "00", title: "SIGNAL", tools: [tag(gate.verdict, tone)], body: [head, body],
    note: `${gate.why} · skips: a support reached on falling IV (replicated five times) and a wall sitting in heavily traded price (worst cell in both halves) · walls before 11:30 are a tilt against, the afternoon is the better wall window · everything else tested — greeks at the strike, named walls, OI, retests, session extremes, round numbers, volume climax, gaps — came back null`,
  });
}

/* ── 01 STRUCTURE: the wall ladder ───────────────────────────────────────── */

function structurePanel(ok, spot, lv, ctx) {
  const rows = [
    { k: "call_wall_2", label: "CALL WALL 2", role: "res", wall: true },
    { k: "call_wall",   label: "CALL WALL",   role: "res", wall: true, strong: true },
    { k: "max_pain",    label: "MAX PAIN",    role: "pin" },
    { k: "vol_trigger", label: "VOL TRIGGER", role: "pin", strong: true },
    { k: "put_wall",    label: "PUT WALL",    role: "sup", wall: true, strong: true },
    { k: "put_wall_2",  label: "PUT WALL 2",  role: "sup", wall: true },
  ]
    .map((r) => ({ ...r, price: lv[r.k] }))
    .filter((r) => isNum(r.price));

  if (!rows.length) return panel({ idx: "01", title: "STRUCTURE", jp: "構造", cls: "half", body: ctx.wait("gex", "rows", 7) || nodata("NO GEX LEVELS") });

  // One ordering, top to bottom by price, with spot spliced into its true place — this is the
  // panel that answers "what is above me and what is below me" in one glance.
  const merged = [...rows].sort((a, b) => b.price - a.price);
  const spotRow = { label: "SPOT", price: spot, role: "spot" };
  let inserted = false;
  const laddered = [];
  for (const r of merged) {
    if (!inserted && isNum(spot) && r.price < spot) { laddered.push(spotRow); inserted = true; }
    laddered.push(r);
  }
  if (!inserted && isNum(spot)) laddered.push(spotRow);

  const span = Math.max(1e-6, laddered[0].price - laddered[laddered.length - 1].price);

  const body = el("div.ladder", null, laddered.map((r) => {
    if (r.role === "spot") {
      return el("div.ladder-row.is-spot", null, [
        el("span.lr-name", { text: "▶ SPOT" }),
        el("span.lr-price", { text: fmt(spot, 2) }),
        el("span.lr-bar", null, el("i.lr-rail")),
        el("span.lr-dist", { text: "" }),
      ]);
    }
    const d = isNum(spot) ? r.price - spot : NaN;
    const frac = clamp(Math.abs(r.price - (laddered[laddered.length - 1].price)) / span, 0, 1);
    const side = r.role === "res" ? "resistance" : r.role === "sup" ? "support" : (isNum(d) && d < 0 ? "support" : "resistance");
    return el(`div.ladder-row.is-${r.role}${r.strong ? ".is-strong" : ""}`, { "data-tip": `${r.label}\nprice: ${strikeLabel(r.price)}${isNum(d) ? `\nfrom spot: ${d >= 0 ? "+" : "\u2212"}${Math.abs(d).toFixed(2)} (${(Math.abs(d) / spot * 100).toFixed(2)}%)` : ""}` }, [
      el("span.lr-name", { text: r.label }),
      el("span.lr-price", { text: strikeLabel(r.price) }),
      el("span.lr-bar", null, el("i.lr-fill", { style: `width:${(frac * 100).toFixed(1)}%` })),
      el("span", { class: `lr-dist ${d >= 0 ? "p" : "n"}`, text: isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}  ${(Math.abs(d) / spot * 100).toFixed(2)}%` : "—" }),
      screenChip(ctx.ivstate, side, !!r.wall),
    ]);
  }));

  const env = lv.gamma_env || (lv.positive_gamma ? "POSITIVE" : "NEGATIVE");
  const tools = [
    screenTag(ctx),
    tag(`${env} GAMMA`, env === "POSITIVE" ? "cool" : "neg"),
    tag(lv.above_vol_trigger ? "ABOVE VT" : "BELOW VT", lv.above_vol_trigger ? "cool" : "warn"),
  ];

  return panel({
    idx: "01", title: "STRUCTURE", jp: "構造", cls: "half", tools, body,
    note: (isNum(lv.net_gex_bn)
      ? `net gamma ${compactSigned(lv.net_gex_bn, 3)}Bn · ${lv.positive_gamma ? "dealer hedging suppresses moves" : "dealer hedging amplifies moves"} · `
      : "") + "walls are MAGNETS, not turns: turns print ~1 strike in front, and light-OI strikes out-held heavy ones in every IV state (2022-25) · the chip is the IV screen and the % is the STUDY'S win rate on 40/80 for that cell (33% = break-even); 33% base until the tape is live",
  });
}

/**
 * The IV-screen chip for one level: the screen label plus the STUDY'S win rate for the cell the
 * level sits in (side × IV state; `wall` = a named heavy wall / IV wall, where the strong
 * put-side rule applies). Until the tape is live it prints the 33% base. Hover has the numbers.
 */
function screenChip(ivstate, side, wall = false) {
  const sc = screen(ivstate, side);
  const r = studyRate(ivstate, side, { wall });
  const pct = `${r.win.toFixed(0)}%`;
  const tone = r.screened ? (r.win >= BREAK_EVEN + 2 ? "cool" : r.win <= BREAK_EVEN - 5 ? "neg" : sc.tone) : "mute";
  return el("span.lr-scr", null, [
    el("span", { class: `tag ${sc.tone}`, text: sc.label, "data-tip": `${side.toUpperCase()} · ${sc.label}\n${sc.why}` }),
    " ",
    el("span", { class: `tag ${tone}`, text: r.screened ? pct : `${pct} base`, "data-tip": `${side.toUpperCase()}${wall ? " · WALL" : ""}\n${rateLine(r)}\nbreak-even on 40/80: ${BREAK_EVEN}% before costs` }),
  ]);
}

const etHHMM = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * SCREENED / UNSCREENED status for a panel's tool strip. Until the IV tape has 25 min of session
 * the board is the unconditional (base-rate) version; the tag says when the screen goes live.
 */
function screenTag(ctx) {
  const st = ctx.ivstate;
  if (st?.status === "ok") {
    const arrow = st.cls === "rising" ? "↑" : st.cls === "falling" ? "↓" : "→";
    return tag(`SCREENED · IV${arrow}`, st.cls === "rising" ? "cool" : st.cls === "falling" ? "warn" : "mute");
  }
  const eta = screenEta(ctx.ivtape);
  if (st?.status === "stale") return tag("UNSCREENED · TAPE STALE", "warn");
  if (eta && inSession()) return tag(`UNSCREENED · LIVE ~${etHHMM(eta)}`, "warn");
  return tag(inSession() ? "UNSCREENED · NO TAPE" : "UNSCREENED · OFF-SESSION", "mute");
}

/** The fixed bracket: the cloud's open-frozen walls (today) → the desk's frozen file → null. */
function frozenWalls(ctx) {
  const c = ctx.ivcloud;
  if (c?.open_walls && c.date === new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())) return { ...c.open_walls, src: "open", at: c.open_at };
  const d = ctx.desk?.board?.iv_walls;
  return d ? { ...d, src: "desk" } : null;
}

/* ── 01c IV STATE ────────────────────────────────────────────────────────── */

/**
 * The 0DTE ATM-IV tape and the one screen the studies support. No probability is printed:
 * the numbers in the tooltips are the 2022-25 study's conditional rates, not a forecast.
 */
function ivStatePanel(ctx) {
  const st = ctx.ivstate, tape = ctx.ivtape || [];
  const sup = screen(st, "support"), res = screen(st, "resistance");
  const gap = openGap(ctx.ivcloud, tape), eta = screenEta(tape);
  const rSup = studyRate(st, "support"), rRes = studyRate(st, "resistance");
  const cells = [
    stat("0DTE ATM IV", st?.atm != null ? `${(100 * st.atm).toFixed(1)}%` : "—", { sub: st?.status === "ok" ? `${st.n} samples · ${Math.round(st.spanMin)} min` : st?.status === "warming" ? "warming — needs 30 min" : st?.status === "stale" ? "stale" : inSession() ? "no tape yet" : "outside the cash session" }),
    stat("30 MIN", st?.status === "ok" ? fmtDelta(st.d30) : "—", { tone: st?.cls === "rising" ? "cool" : st?.cls === "falling" ? "hot" : "", sub: st?.status === "ok" ? st.cls.toUpperCase() : null }),
    stat("15 MIN", st?.status === "ok" ? fmtDelta(st.d15) : "—", { sub: "vol pts" }),
    stat("OFF 60M PEAK", st?.status === "ok" ? `−${(100 * st.offPeak).toFixed(1)}` : "—", { sub: st?.status === "ok" && st.rolled ? "rolled over" : "at/near peak" }),
    stat("WING − ATM", st?.status === "ok" && isNum(st.wingRel) ? fmtDelta(st.wingRel) : "—", { sub: "30-min drift, spot−2..−5" }),
    stat("SPOT", st?.spot != null ? fmt(st.spot, 2) : "—", { sub: "at last sample" }),
    stat("OPEN vs CLOSE", gap ? fmtDelta(gap.d) : "—", { tone: gap ? (gap.d > 0.01 ? "cool" : gap.d < -0.01 ? "hot" : "") : "", sub: gap ? `09:31 ${(100 * gap.openAtm).toFixed(1)} vs ${gap.prevDate.slice(5)} close ${(100 * gap.prevAtm).toFixed(1)} · UNTESTED` : "needs the prior close (cloud)" }),
    stat("SCREEN", st?.status === "ok" ? "LIVE" : eta && inSession() ? `~${etHHMM(eta)}` : "—", { tone: st?.status === "ok" ? "cool" : "", sub: st?.status === "ok" ? `since ~${etHHMM(eta)}` : eta ? "needs 25 min of tape" : inSession() ? "first sample at 09:31" : "cash session only" }),
  ];
  const host = el("div.chart-host");
  if (tape.length >= 2) queueMicrotask(() => lineChart(host, {
    series: [{ name: "atm iv", values: tape.map((s) => 100 * s.atm), tone: "cool", fill: true }, { name: "wing", values: tape.map((s) => (isNum(s.wing) ? 100 * s.wing : NaN)), tone: "ink", dot: false }],
    xTips: tape.map((s) => new Date(s.t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })),
    xLabels: tape.map((s, i) => (i % Math.max(1, Math.floor(tape.length / 5)) === 0 ? new Date(s.t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) : "")),
    fmtY: (n) => `${n.toFixed(1)}%`, height: 120, labelWidth: 46,
  }));
  const rows = el("div.ladder", null, [
    el("div.ladder-row.plain.is-sup", { "data-tip": `SUPPORTS · ${sup.label}\n${sup.why}\n${rateLine(rSup)}` }, [el("span.lr-name", { text: "PUT-SIDE LEVELS" }), el("span.lr-price", null, el("span", { class: `tag ${sup.tone}`, text: sup.label })), el("span.lr-bar", null, el("span.lr-desk", { text: sup.why.split(":")[0] })), el("span.lr-dist", { text: fmtRate(rSup) + (rSup.screened ? "" : " base") })]),
    el("div.ladder-row.plain.is-res", { "data-tip": `RESISTANCES · ${res.label}\n${res.why}\n${rateLine(rRes)}` }, [el("span.lr-name", { text: "CALL-SIDE LEVELS" }), el("span.lr-price", null, el("span", { class: `tag ${res.tone}`, text: res.label })), el("span.lr-bar", null, el("span.lr-desk", { text: res.why.split(":")[0] })), el("span.lr-dist", { text: fmtRate(rRes) + (rRes.screened ? "" : " base") })]),
  ]);
  return panel({
    idx: "01c", title: "IV INTO LEVEL", cls: "half",
    tools: [screenTag(ctx), tag(st?.status === "ok" ? st.cls.toUpperCase() : (st?.status || "EMPTY").toUpperCase(), st?.cls === "rising" ? "cool" : st?.cls === "falling" ? "hot" : "mute")],
    body: [statGrid(cells), host, rows],
    note: "a screen, not a signal (2022-25, 9,358 strike approaches): skip put-side levels reached on FALLING IV (21-24% held, −10 MNQ/fill); rising IV into a level is modestly positive (35-40%); 'rolled over' did not time entries · the % on every level is the STUDY'S rate for its cell, 33% base (= break-even on 40/80) until the tape is live · options do not trade pre-market, so there is no 0DTE tape before 09:31 and the screen cannot exist before ~09:56; OPEN vs CLOSE is the one earlier read and it is UNTESTED · cloud samples every 5 min from 09:31, this browser every 60 s",
  });
}

/* ── 01b IV WALLS ────────────────────────────────────────────────────────── */

/**
 * The four IV-wall brackets, computed LIVE in the browser from the front expiry's smile
 * (lib/ivwalls.js, a port of the desk's src/ivWalls.ts). The desk's frozen bracket — one per
 * session, from its first usable chain — is shown beside it when it exists; the two differing
 * is information (IV has moved since that chain), not a bug.
 */
function ivWallsPanel(netIv, deskWalls0, spot, ctx) {
  const live = liveIvWalls(netIv, spot, etNow().minutes);
  const frozen = frozenWalls(ctx);
  // primary = the FROZEN bracket (the spec's fixed one); the live value sits in the side column
  const deskWalls = frozen || deskWalls0 || null;
  if (!live && !deskWalls) {
    return panel({ idx: "01b", title: "IV WALLS", cls: "half", body: ctx.wait("net_iv", "rows", 4) || nodata("CHAIN TOO THIN FOR A 19\u0394 CROSSING") });
  }
  const rows = [
    { k: "u_outer", label: "UPPER OUTER", role: "res" },
    { k: "u_inner", label: "UPPER INNER", role: "res", strong: true },
    { k: "l_inner", label: "LOWER INNER", role: "sup", strong: true },
    { k: "l_outer", label: "LOWER OUTER", role: "sup" },
  ];
  const body = el("div.ladder", null, rows.map((r) => {
    const v = deskWalls?.[r.k] ?? live?.[r.k];
    const d = isNum(v) && isNum(spot) ? v - spot : NaN;
    const lv = live?.[r.k];
    return el(`div.ladder-row.plain.is-${r.role}${r.strong ? ".is-strong" : ""}`, {
      "data-tip": `${r.label}\nfrozen: ${fmt(deskWalls?.[r.k], 2)}${isNum(lv) ? `\nlive now: ${fmt(lv, 2)}` : ""}${isNum(d) ? `\nfrom spot: ${d >= 0 ? "+" : "\u2212"}${Math.abs(d).toFixed(2)}` : ""}`,
    }, [
      el("span.lr-name", { text: r.label }),
      el("span.lr-price", { text: fmt(v, 2) }),
      el("span.lr-bar", null, isNum(lv) && deskWalls ? el("span.lr-desk.is-live", { text: fmt(lv, 2) }) : null),
      el("span", { class: `lr-dist ${d >= 0 ? "p" : "n"}`, text: isNum(d) ? `${d >= 0 ? "+" : "\u2212"}${Math.abs(d).toFixed(2)}  ${(Math.abs(d) / spot * 100).toFixed(2)}%` : "\u2014" }),
      screenChip(ctx.ivstate, r.role === "res" ? "resistance" : "support", true),
    ]);
  }));
  const src = deskWalls || live;
  return panel({
    idx: "01b", title: "IV WALLS", cls: "half",
    tools: [
      tag(deskWalls ? (deskWalls.src === "open" ? "FROZEN AT OPEN" : "DESK FROZEN") : "LIVE 19\u0394 (no frozen yet)", deskWalls ? "cool" : "warn"),
      tag(`${src.dte ?? 0}DTE`, "mute"),
      tag(`\u03c3atm ${fmt(src.sigma_atm_pct, 1)}%`, "mute"),
    ],
    body,
    note: deskWalls
      ? "the FIXED bracket: |\u0394| 0.1925 strikes of the 0DTE smile frozen at the open (spec) \u00b7 the small grey number is the LIVE recomputation, which shrinks ~4x through the day and filled at half the rate in the study \u00b7 reached 25-41% of days; when reached, ~break-even on 40/80 except lower walls on falling IV (21%)"
      : "no frozen bracket yet today (cloud freezes at the first 5-min warm after 09:31) \u2014 showing the live recomputation, which MOVES with spot and time",
  });
}

/* ── 01d DAY READ ────────────────────────────────────────────────────────── */

/**
 * Open-drive bias, wall targets in expected-move units, and what a break does — the three
 * things the 2022-24 breakout study supported (data/study/breaks_2224_report.md). Descriptive
 * rates, printed as the study's, never as a forecast.
 */
function dayReadPanel(ctx, g, spot) {
  const st = ctx.ivstate, tape = ctx.ivtape || [];
  const od = openDrive(tape);
  const T = st?.status === "ok" ? Math.max(30, 960 - etNow().minutes) / 525600 : NaN;
  const E = st?.status === "ok" && isNum(spot) ? spot * st.atm * Math.sqrt(T) : NaN;
  const tg = wallTargets(g?.rows, spot, E);
  const driveCells = od
    ? [
        stat("FIRST HOUR", `${od.h1 >= 0 ? "+" : "\u2212"}${Math.abs(od.h1).toFixed(2)}E`, { tone: od.dir === "up" ? "cool" : "hot", sub: `${fmt(od.spot0, 2)} \u2192 ${fmt(od.spot1, 2)} \u00b7 ${od.size} drive ${od.dir}` }),
        stat("CLOSED THIS WAY", `${od.persist}%`, { sub: "of days with a first hour this size, 2022-24" }),
        stat("REST OF DAY", `${od.rest >= 0 ? "+" : "\u2212"}${Math.abs(od.rest).toFixed(2)}E`, { sub: "median further move in the drive direction" }),
      ]
    : [stat("OPEN DRIVE", "\u2014", { sub: etNow().minutes < 630 ? "forms at 10:30 ET" : "needs the 09:31 and 10:30 samples" })];
  const row = (t, side) => el(`div.ladder-row.plain.is-${side}`, { "data-tip": `${strikeLabel(t.strike)}\n${t.dE.toFixed(2)} E from spot\nreached before a return: ${t.reach}% of breaks at this distance (2022-24)` }, [
    el("span.lr-name", { text: side === "res" ? "TARGET \u25b2" : "TARGET \u25bc" }),
    el("span.lr-price", { text: strikeLabel(t.strike) }),
    el("span.lr-bar", null, el("span.lr-desk", { text: `${t.dE.toFixed(2)}E` })),
    el("span", { class: `lr-dist ${t.reach >= 70 ? "p" : "n"}`, text: `${t.reach}% reach` }),
    el("span.lr-scr", null, el("span", { class: `tag ${t.reach >= 70 ? "cool" : t.reach >= 40 ? "mute" : "hot"}`, text: t.reach >= 70 ? "in range" : t.reach >= 40 ? "coin flip" : "unlikely" })),
  ]);
  const targets = tg.above.length || tg.below.length
    ? el("div.ladder", null, [...[...tg.above].reverse().map((t) => row(t, "res")), ...tg.below.map((t) => row(t, "sup"))])
    : nodata(isNum(E) ? "NO HEAVY STRIKE WITHIN 3E" : "TARGETS NEED THE IV TAPE (E)");
  return panel({
    idx: "01d", title: "DAY READ", cls: "half",
    tools: [tag(isNum(E) ? `E to close \u00b1${E.toFixed(2)}` : "E \u2014", "mute"), od ? tag(`DRIVE ${od.dir.toUpperCase()}`, od.dir === "up" ? "cool" : "hot") : null],
    body: [statGrid(driveCells), rule("NEXT HEAVY STRIKES \u00b7 reach rate by distance"), targets],
    note: "breaks: 75% retest the broken strike, median 13 min later; at heavy strikes the retest RECLAIMS it 71% of the time on a 40-pt basis \u2014 don't chase a heavy-strike break, and don't fade its retest at the level \u00b7 a break runs a median 0.8E beyond the level before returning \u00b7 overnight: the prior-evening bracket is reached on 7% of nights, whole strikes are a coin flip",
  });
}

/* ── 02 PRICE ────────────────────────────────────────────────────────────── */

function pricePanel(ok, spot, lv, deskBoard, ctx) {
  const chart = ok.chart;
  const host = el("div.chart-host");

  const levels = [];
  const add = (price, label, tone) => { if (isNum(price)) levels.push({ price, label, tone }); };
  add(lv.call_wall, "CALL WALL", "res");
  add(lv.put_wall, "PUT WALL", "sup");
  add(lv.vol_trigger, "VOL TRIG", "pin");
  for (const l of deskBoard?.levels || []) {
    if (!isNum(l.strike)) continue;
    const r = studyRate(ctx.ivstate, l.side === "support" ? "support" : "resistance", { wall: /wall/i.test((l.tags || []).join(" ")) });
    levels.push({ price: l.strike, label: `${r.win.toFixed(0)}% ${strikeLabel(l.strike)}`, tone: "desk" });
  }

  const body = [host];
  queueMicrotask(() => {
    if (!Array.isArray(chart?.candles) || chart.candles.length < 2) {
      return ctx.pending.has("chart") ? host.replaceChildren(skeleton("chart")) : emptyPanel(host, "NO CANDLES");
    }
    candles(host, { bars: chart.candles, spot, levels, height: 230 });
  });

  const n = chart?.candles?.length ?? 0;
  return panel({
    idx: "02", title: "PRICE · VWAP", jp: "価格",
    tools: [tag("5 MIN", "mute")], body, flush: true,
    note: n ? `${n} bars · session VWAP · rails: GEX walls + desk levels` : null,
  });
}

/* ── 03 GAMMA LADDER ─────────────────────────────────────────────────────── */

function gammaPanel(g, spot, marks, err, ctx, zones = []) {
  if (!g.ok) {
    return panel({ idx: "03", title: "GAMMA LADDER", jp: "ガンマ", body: ctx.wait("gex", "rows", 12) || nodata(err?.gex ? `GEX: ${err.gex}` : "NO GEX") });
  }
  const host = el("div.chart-host");
  queueMicrotask(() => spine(host, {
    rows: g.rows, spot, marks, maxRows: 34, unit: "$M", zones,
    fmtVal: (n) => compact(n, 1),
  }));

  const items = [
    ...g.expiries.map((e, i) => ({ label: e.tag ?? e.short, value: i, title: `${e.label}${isNum(e.dte) ? ` · ${e.dte} calendar days${e.expired ? " · expired" : ""}` : ""}` })),
    { label: "CHAIN", value: null, title: "every expiry summed" },
  ];
  const tools = [segmented(items, resolveExp(g.expiries), (v) => { expIdx = v; document.dispatchEvent(new CustomEvent("view:refresh")); })];

  return panel({
    idx: "03", title: "GAMMA LADDER", jp: "ガンマ", tools, body: host, flush: true,
    note: "bar length = |gamma exposure|, colour = sign \u00b7 lit bars suppress, graphite bars amplify \u00b7 shaded bands are the IV-wall brackets \u00b7 flagged strikes are walls + desk levels",
  });
}

/* ── 04 ZERO-DTE ─────────────────────────────────────────────────────────── */

function zeroDtePanel(z, spot, ctx) {
  if (!z || z.error) return panel({ idx: "04", title: "ZERO DTE", jp: "当日", cls: "half", body: ctx.wait("zero_dte", "stats", 6) || nodata("NO 0DTE CHAIN") });

  const cells = [
    stat("GAMMA FLIP", strikeLabel(z.gamma_flip), { sub: isNum(z.gamma_flip) && isNum(spot) ? `${(spot - z.gamma_flip >= 0 ? "+" : "−")}${Math.abs(spot - z.gamma_flip).toFixed(2)} from spot` : null }),
    stat("CALL WALL", strikeLabel(z.gamma_wall_call), { tone: "cool" }),
    stat("PUT WALL", strikeLabel(z.gamma_wall_put), { tone: "hot" }),
    stat("ATM IV", isNum(z.atm_iv) ? `${z.atm_iv.toFixed(1)}%` : "—", { sub: isNum(z.dte_hours) ? `${z.dte_hours}h to expiry` : null }),
    stat("P/C RATIO", fmt(z.pc_ratio, 2), { sub: z.pc_sentiment, tone: z.pc_sentiment === "bearish" ? "hot" : z.pc_sentiment === "bullish" ? "cool" : "" }),
    stat("1σ RANGE", isNum(z.expected_move_1s) ? `±${z.expected_move_1s.toFixed(2)}` : "—", { sub: isNum(z.range_1s_low) ? `${z.range_1s_low.toFixed(1)} – ${z.range_1s_high.toFixed(1)}` : null }),
  ];

  const drift = el("div.drift", null, [
    driftRow("CHARM", z.charm_direction, z.charm_note, z.charm_sum),
    driftRow("VANNA", z.vanna_direction, z.vanna_note, z.vanna_sum),
  ]);

  const oi = el("div.oibar", null, [
    el("span.oibar-lbl", { text: "0DTE OI" }),
    el("span.oibar-track", null, [
      el("i.oibar-call", { style: `width:${oiPct(z.total_call_oi, z.total_put_oi)}%` }),
      el("i.oibar-put", { style: `width:${100 - oiPct(z.total_call_oi, z.total_put_oi)}%` }),
    ]),
    el("span.oibar-val", { text: `${compact(z.total_call_oi, 0)}C / ${compact(z.total_put_oi, 0)}P` }),
  ]);

  return panel({
    idx: "04", title: "ZERO DTE", jp: "当日", cls: "half",
    tools: [tag(z.expiry || "", "mute")],
    body: [statGrid(cells), drift, oi],
    note: "charm and vanna are the two forces that move a 0DTE hedge without price moving at all",
  });
}

const oiPct = (c, p) => {
  const t = (c || 0) + (p || 0);
  return t ? clamp(((c || 0) / t) * 100, 0, 100).toFixed(1) : 50;
};

function driftRow(name, dir, note, val) {
  const tone = dir === "bullish" ? "cool" : dir === "bearish" ? "hot" : "";
  return el("div.drift-row", null, [
    el("span.drift-name", { text: name }),
    el("span", { class: `drift-dir ${tone}`, text: (dir || "flat").toUpperCase() }),
    el("span.drift-note", { text: note || "" }),
    el("span.drift-val", { text: compactSigned(val, 1) }),
  ]);
}

/* ── 05 EXPECTED MOVE ────────────────────────────────────────────────────── */

function movePanel(em, lvls, atr, spot, ctx) {
  if (!em && !lvls) {
    const sk = ctx.wait("expected_move", "stats", 6);
    return sk ? panel({ idx: "05", title: "EXPECTED MOVE", jp: "想定幅", cls: "half", body: sk }) : null;
  }

  const bars = [];
  for (const [k, label] of [["1d", "1 DAY"], ["1w", "1 WEEK"], ["1m", "1 MONTH"]]) {
    const m = em?.moves?.[k];
    if (!m) continue;
    bars.push(el("div.emrow", null, [
      el("span.emrow-k", { text: label }),
      el("span.emrow-iv", { text: isNum(m.iv) ? `${m.iv.toFixed(1)}%` : "—" }),
      el("span.emrow-band", null, [
        el("span.emrow-lo", { text: fmt(m.lower, 1) }),
        el("i.emrow-line"),
        el("span.emrow-mid", { text: `±${fmt(m.move_pts, 2)}` }),
        el("i.emrow-line"),
        el("span.emrow-hi", { text: fmt(m.upper, 1) }),
      ]),
      el("span.emrow-pct", { text: isNum(m.move_pct) ? `${m.move_pct.toFixed(2)}%` : "—" }),
    ]));
  }

  const cells = [
    stat("ATM IV", isNum(em?.atm_iv) ? `${em.atm_iv.toFixed(2)}%` : "—", { sub: isNum(em?.iv_percentile) ? `${em.iv_percentile.toFixed(0)}th pct` : null }),
    stat("VIX", fmt(em?.vix, 2), { sub: isNum(em?.vix_move_pts) ? `±${em.vix_move_pts.toFixed(2)} implied` : null }),
    stat("ATR", fmt(atr?.atr, 2), { sub: "daily true range" }),
    stat("DAILY EST", fmt(lvls?.daily_move_est, 2), { sub: lvls?.regime || null }),
    stat("ASYMMETRY", fmt(lvls?.asymmetry, 3), { sub: lvls?.asymmetry_label || null, tone: (lvls?.asymmetry ?? 0) > 0.1 ? "cool" : (lvls?.asymmetry ?? 0) < -0.1 ? "hot" : "" }),
    stat("ENTROPY", fmt(lvls?.entropy_scalar, 2), { sub: "state scalar" }),
  ];

  const conf = confluencePanel(lvls, spot);

  return panel({
    idx: "05", title: "EXPECTED MOVE", jp: "想定幅", cls: "half",
    body: [statGrid(cells), bars.length ? el("div.emlist", null, bars) : null, conf],
  });
}

/** /levels hod + lod: multi-method confluence candidates for the day's extremes. */
function confluencePanel(lvls, spot) {
  const rows = [
    ...(lvls?.hod || []).map((r) => ({ ...r, side: "res" })),
    ...(lvls?.lod || []).map((r) => ({ ...r, side: "sup" })),
  ].filter((r) => isNum(r.price)).sort((a, b) => b.price - a.price);
  if (!rows.length) return null;

  return el("div", null, [
    rule("CONFLUENCE · DAY EXTREMES"),
    el("div.conf", null, rows.map((r) => el(`div.conf-row.is-${r.side}`, null, [
      el("span.conf-price", { text: strikeLabel(r.price) }),
      el("span.conf-side", { text: r.side === "res" ? "HOD" : "LOD" }),
      el("span.conf-bar", { text: asciiBar((r.confidence ?? 0), 8) }),
      el("span.conf-n", { text: `${r.confluence ?? 0}×` }),
      el("span.conf-methods", { text: (r.methods || []).join(" · ") }),
      el("span.conf-dist", { text: isNum(spot) ? `${((r.price - spot) / spot * 100).toFixed(2)}%` : "" }),
    ]))),
  ]);
}

/* ── 06 DESK ─────────────────────────────────────────────────────────────── */

/**
 * The locally-scored board. Deliberately last and deliberately stamped: the scoring box is
 * rarely on, so this is usually a historical read and must never be mistaken for live.
 */
function deskPanel(desk, spot, ctx) {
  if (!desk?.board) {
    return panel({
      idx: "06", title: "DESK BOARD", jp: "採点", cls: "p-desk half",
      body: ctx.deskPending ? skeleton("rows", 4) : nodata("NO SCORED BOARD REACHABLE"),
    });
  }
  const b = desk.board;
  const age = Date.now() - desk.at;
  const old = age > 45 * 60_000;
  const isAi = b.scoring_method === "ai";

  const head = el("div.desk-head", null, [
    tag(isAi ? "AI SCORED" : "RULE BOARD", isAi ? "cool" : "mute"),
    tag(desk.source === "cloud" ? "CLOUD" : desk.source === "static" ? "LAN FILE" : "DESK", "mute"),
    tag(agoText(desk.at).toUpperCase(), old ? "warn" : "pos"),
    b.session ? tag(String(b.session).toUpperCase(), "mute") : null,
    screenTag(ctx),
  ]);

  const levels = (b.levels || []).filter((l) => isNum(l.strike)).sort((a, b2) => b2.strike - a.strike);
  const list = levels.length
    ? el("div.dlevels", null, levels.map((l) => {
        const d = isNum(spot) ? l.strike - spot : NaN;
        const side = l.side === "support" ? "support" : "resistance";
        // The bar is the STUDY'S rate for this level's cell (side × IV state × wall), the number
        // the desk can actually expect on 40/80; the AI's reversal_prob is kept as a small tag.
        const r = studyRate(ctx.ivstate, side, { wall: /wall/i.test((l.tags || []).join(" ")) });
        return el(`div.dlevel.is-${l.side === "support" ? "sup" : "res"}`, null, [
          el("span.dl-k", { text: strikeLabel(l.strike) }),
          el("span.dl-side", { text: (l.side || "").slice(0, 3).toUpperCase() }),
          el("span.dl-prob", { "data-tip": `${strikeLabel(l.strike)} ${side}\n${rateLine(r)}\nbreak-even on 40/80: ${BREAK_EVEN}%${isNum(l.reversal_prob) ? `\ndesk AI prob: ${l.reversal_prob}% (its calibration tested at the base rate)` : ""}` }, [
            el("i.dl-probbar", { style: `width:${clamp(r.win, 0, 100)}%${r.screened ? "" : ";opacity:.25"}` }),
            el("span.dl-probtxt", { text: `${r.win.toFixed(0)}%${r.screened ? "" : " base"}` }),
          ]),
          el("span.dl-dist", { text: isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}` : "" }),
          el("span.dl-tags", null, [screenChip(ctx.ivstate, side), " ", isNum(l.reversal_prob) ? `desk ${l.reversal_prob}% · ` : "", (l.tags || []).join(" · ")]),
          el("span.dl-why", { text: l.why || "" }),
        ]);
      }))
    : nodata("BOARD PUBLISHED NO LEVELS");

  const gate = b.day_gate
    ? el("div.gate", null, [
        rule("DAY GATE"),
        el("div.gate-head", null, [
          el("span", { class: `gate-verdict v-${String(b.day_gate.verdict || "").toLowerCase().replace(/\s+/g, "-")}`, text: b.day_gate.verdict || "—" }),
          el("span.gate-count", { text: `${b.day_gate.majors ?? 0} major · ${b.day_gate.minors ?? 0} minor` }),
        ]),
        el("ul.gate-list", null, (b.day_gate.reasons || []).map((r) =>
          el(`li.gate-reason.is-${r.severity || "minor"}`, { text: r.label || "" }))),
      ])
    : null;

  const walls = b.iv_walls ? ivWallBlock(b.iv_walls, spot) : null;
  const tape = b.tape ? tapeBlock(b.tape) : null;

  return panel({
    idx: "06", title: "DESK BOARD", jp: "採点", cls: `p-desk half${old ? " is-old" : ""}`,
    tools: [tag(`SPOT@SCORE ${fmt(b.spot, 2)}`, "mute")],
    body: [head, tape, list, gate, walls],
    note: old
      ? "the scoring box has not published recently — treat these levels as history, not as a live call"
      : null,
  });
}

function tapeBlock(t) {
  if (!t || typeof t !== "object") return null;
  return el("div.tape", null, [
    rule("TAPE"),
    el("div.tape-head", null, [
      t.direction ? el("span.tape-dir", { text: String(t.direction).toUpperCase() }) : null,
      t.now ? el("span.tape-now", { text: t.now }) : null,
    ]),
    t.narrative ? el("p.tape-body", { text: t.narrative }) : null,
    Array.isArray(t.path) && t.path.length
      ? el("div.tape-path", null, t.path.map((p) =>
          el(`span.tape-wp.is-${p.kind || "chop"}`, { text: `${strikeLabel(p.price)} ${p.kind || ""}` })))
      : null,
    t.trade ? el("div.tape-trade", { text: typeof t.trade === "string" ? t.trade : JSON.stringify(t.trade) }) : null,
  ]);
}

function ivWallBlock(w, spot) {
  const pts = [
    { k: "u_outer", label: "OUTER ▲" }, { k: "u_inner", label: "INNER ▲" },
    { k: "l_inner", label: "INNER ▼" }, { k: "l_outer", label: "OUTER ▼" },
  ].map((p) => ({ ...p, v: w[p.k] })).filter((p) => isNum(p.v));
  if (!pts.length) return null;

  const carried = w.computed_at ? String(w.computed_at).slice(0, 10) : null;
  return el("div", null, [
    rule("IV WALLS · 19Δ"),
    el("div.ivw", null, pts.map((p) => el("div.ivw-row", null, [
      el("span.ivw-lbl", { text: p.label }),
      el("span.ivw-v", { text: fmt(p.v, 2) }),
      el("span.ivw-d", { text: isNum(spot) ? `${p.v - spot >= 0 ? "+" : "−"}${Math.abs(p.v - spot).toFixed(2)}` : "" }),
    ]))),
    el("div.ivw-note", { text: `σatm ${fmt(w.sigma_atm_pct, 2)}% · Δ${fmt(w.delta, 4)} · dte ${w.dte ?? "—"} · frozen ${carried ?? "—"}` }),
  ]);
}
