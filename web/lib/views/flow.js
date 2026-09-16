// FLOW — where the dealer book actually sits, and what the tape has been doing to it.
//
// Caveat that governs this whole tab: there is NO traded order-flow delta in this system any
// more. The Altaris per-bar buyer/seller feed died with that service; everything below is
// positioning-derived (open interest, exposure, dealer inventory) or a statistical read on
// futures bars. Nothing here says "a buyer stepped in" — it says "the book is leaning".

import { el, isNum, fmt, compact, compactSigned, strikeLabel, clamp } from "../util.js";
import { panel, tag, statGrid, nodata, rule } from "../ui.js";
import { spine, lineChart, stat, biMeter, emptyPanel } from "../draw.js";

export const ID = "flow";
export const LABEL = "FLOW";
export const JP = "流";
export const EPS = ["dealer_delta", "dealer_anomalies", "dex_ladder", "option_matrix", "scanner", "flow"];

/** Fold a single signed series into the spine's two-sided shape: negatives left, positives right. */
const signedRows = (list, key) => (list || [])
  .filter((r) => isNum(r?.strike))
  .map((r) => {
    const v = isNum(r[key]) ? r[key] : 0;
    return { strike: r.strike, put: v < 0 ? v : 0, call: v > 0 ? v : 0, net: v };
  })
  .filter((r) => r.net !== 0);

export function render(host, ctx) {
  const { ok, err } = ctx.yyy;
  host.replaceChildren(
    dealerPanel(ok.dealer_delta, ctx.spot, err),
    anomalyPanel(ok.dealer_anomalies),
    dexPanel(ok.dex_ladder, ctx.spot),
    expiryPanel(ok.option_matrix),
    crossPanel(ok.scanner),
    notePanel(),
  );
}

/* ── F0 DEALER INVENTORY ─────────────────────────────────────────────────── */

function dealerPanel(dd, spot, err) {
  if (!dd || dd.error) {
    return panel({ idx: "F0", title: "DEALER INVENTORY", jp: "在庫", body: nodata(err?.dealer_delta ? `dealer_delta: ${err.dealer_delta}` : "NO DEALER DATA") });
  }

  const long = dd.dealer_lean === "long";
  const cells = [
    stat("NET DELTA", compactSigned(dd.net_dealer_delta, 2), { tone: long ? "cool" : "hot", sub: `dealers ${dd.dealer_lean ?? "—"}` }),
    stat("DELTA FLIP", strikeLabel(dd.delta_flip), { sub: dd.above_delta_flip ? "spot above" : "spot below", tone: dd.above_delta_flip ? "cool" : "hot" }),
    stat("FROM FLIP", isNum(dd.delta_flip) && isNum(spot) ? `${spot - dd.delta_flip >= 0 ? "+" : "−"}${Math.abs(spot - dd.delta_flip).toFixed(2)}` : "—", { sub: "points" }),
  ];

  const rows = signedRows(dd.strike_data, "net_delta");
  const host = el("div.chart-host");
  queueMicrotask(() => (rows.length
    ? spine(host, { rows, spot, maxRows: 30, fmtVal: (n) => compact(n, 1), marks: isNum(dd.delta_flip) ? new Set([dd.delta_flip]) : undefined })
    : emptyPanel(host)));

  return panel({
    idx: "F0", title: "DEALER INVENTORY", jp: "在庫",
    tools: [tag(long ? "LONG BOOK" : "SHORT BOOK", long ? "cool" : "hot")],
    body: [statGrid(cells), host],
    note: long
      ? "a long dealer book sells strength and buys weakness — rallies get faded"
      : "a short dealer book buys strength and sells weakness — moves get chased",
  });
}

/* ── F1 ANOMALIES ────────────────────────────────────────────────────────── */

/**
 * Futures-bar delta z-scores. This is the closest surviving thing to an order-flow read: it is
 * computed from bar shape, not from a traded buyer/seller feed, so it is evidence of unusual
 * bar-level pressure and nothing stronger.
 */
function anomalyPanel(da) {
  if (!da || da.error || !Array.isArray(da.z_scores)) return null;

  const host = el("div.chart-host");
  queueMicrotask(() => lineChart(host, {
    series: [{ values: da.z_scores, tone: "ink", dot: true }],
    marks: [
      { value: da.z_threshold ?? 2, label: "+2σ", tone: "cool" },
      { value: -(da.z_threshold ?? 2), label: "−2σ", tone: "hot" },
      { value: 0, tone: "mute" },
    ],
    bands: [{ from: -(da.z_threshold ?? 2), to: da.z_threshold ?? 2, tone: "mute" }],
    fmtY: (n) => n.toFixed(1),
    height: 150,
  }));

  const recent = (da.anomalies || []).slice(-10).reverse();
  const list = recent.length
    ? el("div.anom", null, recent.map((a) => el(`div.anom-row.is-${String(a.direction || "").toLowerCase()}`, null, [
        el("span.an-time", { text: String(a.time || "").slice(5, 16) }),
        el("span.an-dir", { text: a.direction || "" }),
        el("span.an-z", { text: `${a.z >= 0 ? "+" : "−"}${Math.abs(a.z ?? 0).toFixed(2)}σ` }),
        el("span.an-mag", { text: a.magnitude || "" }),
        el("span.an-px", { text: fmt(a.price, 2) }),
      ])))
    : nodata("NO ANOMALIES IN WINDOW");

  const bal = (da.buy_count ?? 0) - (da.sell_count ?? 0);
  const total = (da.buy_count ?? 0) + (da.sell_count ?? 0);

  return panel({
    idx: "F1", title: "BAR PRESSURE", jp: "偏り",
    tools: [tag(da.imbalance || "—", da.imbalance === "BALANCED" ? "mute" : bal > 0 ? "cool" : "hot")],
    body: [
      el("div.dealer-bal", null, [
        biMeter({
          label: `BUY ${da.buy_count ?? 0} / SELL ${da.sell_count ?? 0}`,
          value: `z ${fmt(da.current_z, 2)}`,
          frac: total ? bal / total : 0,
          tone: bal > 0 ? "cool" : bal < 0 ? "hot" : "",
        }),
      ]),
      host,
      rule("FLAGGED BARS"),
      list,
    ],
    note: "derived from futures bar shape — there is no traded buyer/seller feed in this system, so read this as pressure, not as confirmed absorption",
  });
}

/* ── F2 DEX LADDER ───────────────────────────────────────────────────────── */

function dexPanel(dl, spot) {
  const rows = (dl?.ladder || [])
    .filter((r) => isNum(r?.strike))
    .map((r) => ({
      strike: r.strike,
      put: isNum(r.put_dex) ? r.put_dex : 0,
      call: isNum(r.call_dex) ? r.call_dex : 0,
      net: isNum(r.net_dex) ? r.net_dex : 0,
    }))
    .filter((r) => r.put !== 0 || r.call !== 0);
  if (!rows.length) return null;

  const host = el("div.chart-host");
  queueMicrotask(() => spine(host, { rows, spot, maxRows: 30, fmtVal: (n) => compact(n, 2) }));

  return panel({
    idx: "F2", title: "DELTA LADDER", jp: "デルタ", body: host, flush: true,
    note: "per-strike call and put delta exposure · the strike where net delta changes sign is where hedging flips direction",
  });
}

/* ── F3 EXPIRY MATRIX ────────────────────────────────────────────────────── */

/** /option-matrix: one row per expiry with its own walls, exposure and turnover. */
function expiryPanel(om) {
  const rows = (om?.rows || []).filter((r) => r?.expiration);
  if (!rows.length) return null;

  const maxOi = Math.max(1, ...rows.map((r) => Math.abs(r.total_oi ?? 0)));
  const maxVol = Math.max(1, ...rows.map((r) => Math.abs(r.total_vol ?? 0)));

  const head = el("div.omx-row.is-head", null, [
    el("span.om-exp", { text: "EXPIRY" }),
    el("span.om-dte", { text: "DTE" }),
    el("span.om-num", { text: "NET GEX" }),
    el("span.om-num", { text: "NET DEX" }),
    el("span.om-bar2", { text: "OI" }),
    el("span.om-bar2", { text: "VOLUME" }),
    el("span.om-lvl", { text: "RES / SUP" }),
    el("span.om-num", { text: "EM" }),
  ]);

  const body = rows.slice(0, 14).map((r) => el(`div.omx-row${r.dte === 0 ? ".is-0dte" : ""}`, null, [
    el("span.om-exp", { text: String(r.expiration).slice(5) }),
    el("span.om-dte", { text: isNum(r.dte) ? `${r.dte}d` : "" }),
    el("span", { class: `om-num ${sg(r.net_gex)}`, text: compactSigned(r.net_gex, 1) }),
    el("span", { class: `om-num ${sg(r.net_dex)}`, text: compactSigned(r.net_dex, 2) }),
    barCell(r.total_oi, maxOi, `${compact(r.call_oi, 0)}C/${compact(r.put_oi, 0)}P`),
    barCell(r.total_vol, maxVol, `${compact(r.call_vol, 0)}C/${compact(r.put_vol, 0)}P`),
    el("span.om-lvl", { text: `${strikeLabel(r.call_resistance)} / ${strikeLabel(r.put_support)}` }),
    el("span.om-num", { text: fmt(r.expected_move, 0) }),
  ]));

  const t = om.totals || {};
  const foot = el("div.omx-foot", null, [
    el("span", { text: `TOTAL EXPOSURE  gex ${compactSigned(t.net_gex, 1)} · dex ${compactSigned(t.net_dex, 2)}` }),
    el("span", { text: `P/C  gex ${fmt(t.gex_pc, 2)} · oi ${fmt(t.oi_pc, 2)} · vol ${fmt(t.vol_pc, 2)}` }),
  ]);

  return panel({
    idx: "F3", title: "EXPIRY MATRIX", jp: "満期",
    body: el("div.omx", null, [head, ...body, foot]),
    note: "each expiry carries its own walls · an expiry with heavy volume but light OI is same-day churn, not position building",
  });
}

const sg = (v) => (!isNum(v) || v === 0 ? "z" : v > 0 ? "p" : "n");

function barCell(value, max, label) {
  return el("span.om-bar2", null, [
    el("i.om-bar-fill", { style: `width:${clamp((Math.abs(value ?? 0) / max) * 100, 0, 100).toFixed(1)}%` }),
    el("span.om-bar-txt", { text: label }),
  ]);
}

/* ── F4 CROSS ASSET ──────────────────────────────────────────────────────── */

function crossPanel(sc) {
  const list = (sc?.tickers || []).filter((t) => t?.ticker);
  if (!list.length) return null;

  const byCat = new Map();
  for (const t of list) {
    const c = t.category || "Other";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(t);
  }
  const maxMove = Math.max(1, ...list.map((t) => Math.abs(t.change_1d ?? 0)));

  const groups = [...byCat.entries()].map(([cat, items]) => el("div.xa-group", null, [
    el("div.xa-cat", { text: cat.toUpperCase() }),
    el("div.xa-list", null, items
      .sort((a, b) => (b.change_1d ?? 0) - (a.change_1d ?? 0))
      .map((t) => el("div.xa-row", { title: t.name || "" }, [
        el("span.xa-tk", { text: t.ticker }),
        el("span.xa-px", { text: fmt(t.price, 2) }),
        el("span.xa-bar", null, el("i", {
          class: `xa-fill ${(t.change_1d ?? 0) >= 0 ? "p" : "n"}`,
          style: `width:${(Math.abs(t.change_1d ?? 0) / maxMove * 50).toFixed(1)}%;${(t.change_1d ?? 0) >= 0 ? "left:50%" : "right:50%"}`,
        })),
        el("span", { class: `xa-chg ${(t.change_1d ?? 0) >= 0 ? "p" : "n"}`, text: `${(t.change_1d ?? 0) >= 0 ? "+" : "−"}${Math.abs(t.change_1d ?? 0).toFixed(2)}%` }),
        el("span", { class: `xa-chg5 ${(t.change_5d ?? 0) >= 0 ? "p" : "n"}`, text: `${(t.change_5d ?? 0) >= 0 ? "+" : "−"}${Math.abs(t.change_5d ?? 0).toFixed(2)}%` }),
      ]))),
  ]));

  return panel({
    idx: "F4", title: "CROSS ASSET", jp: "市場",
    tools: [tag(`${list.length} SYMBOLS`, "mute")],
    body: el("div.xa", null, groups),
    note: "1-day move (bar) and 5-day move (right column)",
  });
}

/* ── F5 what is missing ──────────────────────────────────────────────────── */

function notePanel() {
  return panel({
    idx: "F5", title: "FEED LIMITS", jp: "欠損", cls: "p-quiet",
    body: el("ul.limits", null, [
      el("li", { text: "No traded order-flow delta. YYY has no tape feed; /chart is OHLCV and /dex is open-interest derived. Nothing on this page confirms absorption or initiative." }),
      el("li", { text: "Tenor depth stops at the eight front expiries, so anything past ~15 days is structurally absent rather than zero." }),
      el("li", { text: "Greek magnitudes are consistent within a greek only. Never compare a theta number to a vanna number." }),
    ]),
  });
}
