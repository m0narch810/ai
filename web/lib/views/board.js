// BOARD — the "where are we, what is around us" tab.
//
// Everything here is live YYY, so it is correct with the scoring PC off. The locally-scored
// desk board (AI levels / tape / day gate / IV walls) is appended at the bottom as a clearly
// age-stamped block rather than the page's headline, because in practice it is days old.

import { el, isNum, fmt, pct, compact, compactSigned, strikeLabel, agoText, clamp, asciiBar } from "../util.js";
import { panel, tag, segmented, statGrid, nodata, rule } from "../ui.js";
import { spine, candles, stat, emptyPanel } from "../draw.js";
import { greek, levelMarks, boardMarks } from "../data.js";

export const ID = "board";
export const LABEL = "BOARD";
export const JP = "板";
export const EPS = ["gex", "chart", "zero_dte", "expected_move", "levels", "dealer_delta", "atr"];

// Expiry column chosen in the gamma ladder; null = whole chain. Survives re-renders.
let expIdx = null;

export function render(host, ctx) {
  const { ok, err } = ctx.yyy;
  const spot = ctx.spot;
  const g = greek("gex", ok.gex, expIdx);
  const lv = g.levels || {};
  const marks = new Set([...levelMarks(lv), ...boardMarks(ctx.desk?.board)]);

  host.replaceChildren(
    structurePanel(ok, spot, lv),
    pricePanel(ok, spot, lv, ctx.desk?.board),
    gammaPanel(g, spot, marks, err),
    zeroDtePanel(ok.zero_dte, spot),
    movePanel(ok.expected_move, ok.levels, ok.atr, spot),
    deskPanel(ctx.desk, spot),
  );
}

/* ── 01 STRUCTURE: the wall ladder ───────────────────────────────────────── */

function structurePanel(ok, spot, lv) {
  const rows = [
    { k: "call_wall_2", label: "CALL WALL 2", role: "res" },
    { k: "call_wall",   label: "CALL WALL",   role: "res", strong: true },
    { k: "max_pain",    label: "MAX PAIN",    role: "pin" },
    { k: "vol_trigger", label: "VOL TRIGGER", role: "pin", strong: true },
    { k: "put_wall",    label: "PUT WALL",    role: "sup", strong: true },
    { k: "put_wall_2",  label: "PUT WALL 2",  role: "sup" },
  ]
    .map((r) => ({ ...r, price: lv[r.k] }))
    .filter((r) => isNum(r.price));

  if (!rows.length) return panel({ idx: "01", title: "STRUCTURE", jp: "構造", body: nodata("NO GEX LEVELS") });

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
    return el(`div.ladder-row.is-${r.role}${r.strong ? ".is-strong" : ""}`, null, [
      el("span.lr-name", { text: r.label }),
      el("span.lr-price", { text: strikeLabel(r.price) }),
      el("span.lr-bar", null, el("i.lr-fill", { style: `width:${(frac * 100).toFixed(1)}%` })),
      el("span", { class: `lr-dist ${d >= 0 ? "p" : "n"}`, text: isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}  ${(Math.abs(d) / spot * 100).toFixed(2)}%` : "—" }),
    ]);
  }));

  const env = lv.gamma_env || (lv.positive_gamma ? "POSITIVE" : "NEGATIVE");
  const tools = [
    tag(`${env} GAMMA`, env === "POSITIVE" ? "cool" : "neg"),
    tag(lv.above_vol_trigger ? "ABOVE VT" : "BELOW VT", lv.above_vol_trigger ? "cool" : "warn"),
  ];

  return panel({
    idx: "01", title: "STRUCTURE", jp: "構造", tools, body,
    note: isNum(lv.net_gex_bn)
      ? `net gamma ${compactSigned(lv.net_gex_bn, 3)}Bn · ${lv.positive_gamma ? "dealer hedging suppresses moves" : "dealer hedging amplifies moves"}`
      : null,
  });
}

/* ── 02 PRICE ────────────────────────────────────────────────────────────── */

function pricePanel(ok, spot, lv, deskBoard) {
  const chart = ok.chart;
  const host = el("div.chart-host");

  const levels = [];
  const add = (price, label, tone) => { if (isNum(price)) levels.push({ price, label, tone }); };
  add(lv.call_wall, "CALL WALL", "res");
  add(lv.put_wall, "PUT WALL", "sup");
  add(lv.vol_trigger, "VOL TRIG", "pin");
  for (const l of deskBoard?.levels || []) {
    if (isNum(l.strike)) levels.push({ price: l.strike, label: `${l.reversal_prob ?? ""}% ${strikeLabel(l.strike)}`, tone: "desk" });
  }

  const body = [host];
  queueMicrotask(() => {
    if (!Array.isArray(chart?.candles) || chart.candles.length < 2) return emptyPanel(host, "NO CANDLES");
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

function gammaPanel(g, spot, marks, err) {
  if (!g.ok) {
    return panel({ idx: "03", title: "GAMMA LADDER", jp: "ガンマ", body: nodata(err?.gex ? `GEX: ${err.gex}` : "NO GEX") });
  }
  const host = el("div.chart-host");
  queueMicrotask(() => spine(host, {
    rows: g.rows, spot, marks, maxRows: 34, unit: "$M",
    fmtVal: (n) => compact(n, 1),
  }));

  const items = [{ label: "CHAIN", value: null, title: "every expiry summed" },
    ...g.expiries.map((e, i) => ({ label: e.short, value: i, title: `${e.label}${isNum(e.dte) ? ` · ${e.dte}d` : ""}` }))];
  const tools = [segmented(items, expIdx, (v) => { expIdx = v; document.dispatchEvent(new CustomEvent("view:refresh")); })];

  return panel({
    idx: "03", title: "GAMMA LADDER", jp: "ガンマ", tools, body: host, flush: true,
    note: "bar length = |gamma exposure|, colour = sign · cool bars suppress, hot bars amplify · flagged strikes are walls + desk levels",
  });
}

/* ── 04 ZERO-DTE ─────────────────────────────────────────────────────────── */

function zeroDtePanel(z, spot) {
  if (!z || z.error) return panel({ idx: "04", title: "ZERO DTE", jp: "当日", body: nodata("NO 0DTE CHAIN") });

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
    idx: "04", title: "ZERO DTE", jp: "当日",
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

function movePanel(em, lvls, atr, spot) {
  if (!em && !lvls) return null;

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
    idx: "05", title: "EXPECTED MOVE", jp: "想定幅",
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
function deskPanel(desk, spot) {
  if (!desk?.board) {
    return panel({
      idx: "06", title: "DESK BOARD", jp: "採点", cls: "p-desk",
      body: nodata("NO SCORED BOARD REACHABLE"),
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
  ]);

  const levels = (b.levels || []).filter((l) => isNum(l.strike)).sort((a, b2) => b2.strike - a.strike);
  const list = levels.length
    ? el("div.dlevels", null, levels.map((l) => {
        const d = isNum(spot) ? l.strike - spot : NaN;
        return el(`div.dlevel.is-${l.side === "support" ? "sup" : "res"}`, null, [
          el("span.dl-k", { text: strikeLabel(l.strike) }),
          el("span.dl-side", { text: (l.side || "").slice(0, 3).toUpperCase() }),
          el("span.dl-prob", null, [
            el("i.dl-probbar", { style: `width:${clamp(l.reversal_prob ?? 0, 0, 100)}%` }),
            el("span.dl-probtxt", { text: `${l.reversal_prob ?? "—"}%` }),
          ]),
          el("span.dl-dist", { text: isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}` : "" }),
          el("span.dl-tags", { text: (l.tags || []).join(" · ") }),
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
    idx: "06", title: "DESK BOARD", jp: "採点", cls: `p-desk${old ? " is-old" : ""}`,
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
