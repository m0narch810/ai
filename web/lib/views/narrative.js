// NARRATIVE — the pre-open brief.
//
// This is desk output, not a live feed: it is generated once before the cash open (09:00 ET
// cron, or `npm run narrative`) and then stands all day. With the scoring box off it can be
// weeks old, so the age stamp is the first thing in the panel and a stale brief is dimmed
// rather than quietly presented as this morning's call.

import { el, isNum, fmt, agoText, msAgo, strikeLabel, etNow } from "../util.js";
import { panel, tag, statGrid, nodata, rule, skeleton } from "../ui.js";
import { stat } from "../draw.js";

export const ID = "narrative";
export const LABEL = "BRIEF";
export const JP = "物語";
export const EPS = [];

const TONE = {
  manip_down_real_up: "cool", real_pump: "cool",
  manip_up_real_down: "hot", real_dump: "hot",
  chop_day: "mute", unclear: "mute",
};

export function render(host, ctx) {
  const n = ctx.narrative;
  if (!n) {
    host.replaceChildren(panel({
      idx: "N0", title: "PRE-OPEN BRIEF", jp: JP,
      body: ctx.deskPending ? skeleton("rows", 5) : nodata("NO BRIEF PUBLISHED — generates before the open, or run `npm run narrative`"),
    }));
    return;
  }

  const age = msAgo(n.scored_at ?? n.generated_at);
  const stale = !(age < 20 * 60 * 60_000);   // anything older than the current session

  host.replaceChildren(...[
    openPanel(n, stale),
    callPanel(n),
    zonePanel(n, ctx.spot),
    levelPanel(n, ctx.spot),
    driverPanel(n),
  ].filter(Boolean));
}

/* ── N0 THE CALL ─────────────────────────────────────────────────────────── */

function openPanel(n, stale) {
  const tone = TONE[n.open_type] ?? "";
  const cd = nextOpen();

  return panel({
    idx: "N0", title: "PRE-OPEN BRIEF", jp: JP, cls: stale ? "p-desk is-old" : "p-desk",
    tools: [
      tag(n.scoring_method === "ai" ? "AI" : "RULE", "mute"),
      tag(agoText(n.scored_at ?? n.generated_at).toUpperCase(), stale ? "warn" : "pos"),
    ],
    body: [
      el("div.nopen", null, [
        el("div", { class: `nopen-type ${tone}`, text: n.open_type_label || n.open_type || "—" }),
        el("div.nopen-meta", null, [
          n.size_rule ? tag(`SIZE ${n.size_rule}`, n.size_rule === "NO TRADE" ? "hot" : n.size_rule === "FULL" ? "cool" : "warn") : null,
          n.macro_bias ? tag(`MACRO ${String(n.macro_bias).toUpperCase()}`, n.macro_bias === "bull" ? "cool" : n.macro_bias === "bear" ? "hot" : "mute") : null,
          n.clean_or_choppy ? tag(String(n.clean_or_choppy).toUpperCase(), "mute") : null,
        ]),
      ]),
      el("div.ncount", null, [
        el("span.nc-lbl", { text: "NEXT CASH OPEN" }),
        el("span.nc-val", { text: cd.text }),
        el("span.nc-day", { text: cd.day }),
      ]),
      n.summary ? el("p.narr-body", { text: n.summary }) : null,
      n.size_rule_reason ? el("div.narr-sub", { text: n.size_rule_reason }) : null,
    ],
    note: stale ? "this brief is not from today's session" : null,
  });
}

/** Countdown to the next 09:30 ET weekday open. */
function nextOpen() {
  const { dow, minutes } = etNow();
  const OPEN = 9 * 60 + 30;
  let daysAhead = 0;
  if (dow === 0) daysAhead = 1;
  else if (dow === 6) daysAhead = 2;
  else if (minutes >= OPEN) daysAhead = dow === 5 ? 3 : 1;
  const mins = daysAhead * 1440 + OPEN - minutes;
  const h = Math.floor(mins / 60), m = mins % 60;
  const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return { text: `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`, day: names[(dow + daysAhead) % 7] };
}

/* ── N1 THE PLAY ─────────────────────────────────────────────────────────── */

function callPanel(n) {
  const cells = [
    stat("EXPANSION", String(n.expansion_direction ?? "—").toUpperCase(), {
      tone: n.expansion_direction === "up" ? "cool" : n.expansion_direction === "down" ? "hot" : "",
    }),
    stat("TARGET", strikeLabel(n.targeted_level), { sub: "first touch" }),
    stat("NEXT", strikeLabel(n.next_target), { sub: "if it breaks" }),
    stat("ENTROPY", n.entropy_state || "—", { sub: isNum(n.entropy_ratio) ? `ratio ${n.entropy_ratio.toFixed(2)}` : null }),
    stat("TOPOLOGY", String(n.topology_alignment ?? "—").toUpperCase(), { tone: n.topology_alignment === "aligned" ? "cool" : "warn" }),
    stat("VOL TRIGGER", String(n.vol_trigger_position ?? "—").toUpperCase(), { tone: n.vol_trigger_position === "above" ? "cool" : "hot" }),
  ];

  const lines = [
    ["MOVE EXTENT", n.move_extent],
    ["COMPLETION", n.completion_signal],
    ["MANIPULATION TELL", n.manipulation_tell],
    ["TOPOLOGY", n.topology_note],
  ].filter(([, v]) => v);

  return panel({
    idx: "N1", title: "THE PLAY", jp: "手",
    body: [
      statGrid(cells),
      lines.length ? el("div.nlines", null, lines.map(([k, v]) => el("div.nline", null, [
        el("span.nline-k", { text: k }),
        el("span.nline-v", { text: v }),
      ]))) : null,
    ],
  });
}

/* ── N2 REVERSAL ZONES ───────────────────────────────────────────────────── */

function zonePanel(n, spot) {
  const zones = (n.reversal_zones || []).filter((z) => isNum(z.price)).sort((a, b) => b.price - a.price);
  if (!zones.length) return null;

  return panel({
    idx: "N2", title: "REVERSAL ZONES", jp: "反転", cls: "half",
    body: el("div.nzones", null, zones.map((z) => {
      const d = isNum(spot) ? z.price - spot : NaN;
      return el(`div.nzone.is-${z.side === "support" ? "sup" : "res"}`, null, [
        el("span.nz-price", { text: strikeLabel(z.price) }),
        el("span.nz-side", { text: String(z.side || "").slice(0, 3).toUpperCase() }),
        el("span.nz-dist", { text: isNum(d) ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}` : "" }),
        el("span.nz-note", { text: z.note || "" }),
      ]);
    })),
    note: "priced at the brief's spot — distances recompute against the live print",
  });
}

/* ── N3 GEX LEVELS AT THE BRIEF ──────────────────────────────────────────── */

function levelPanel(n, spot) {
  const g = n.gex_key_levels;
  if (!g) return null;
  const rows = [
    ["CALL WALL", g.call_wall], ["VOL TRIGGER", g.vol_trigger],
    ["MAX PAIN", g.max_pain], ["PUT WALL", g.put_wall],
  ].filter(([, v]) => isNum(v));
  if (!rows.length) return null;

  return panel({
    idx: "N3", title: "LEVELS AT THE BRIEF", jp: "水準", cls: "p-quiet half",
    body: el("div.nglv", null, [
      ...rows.map(([k, v]) => el("div.ngl-row", null, [
        el("span.ngl-k", { text: k }),
        el("span.ngl-v", { text: strikeLabel(v) }),
        el("span.ngl-d", { text: isNum(spot) ? `${v - spot >= 0 ? "+" : "−"}${Math.abs(v - spot).toFixed(2)} now` : "" }),
      ])),
      isNum(g.expected_move) ? el("div.ngl-row", null, [
        el("span.ngl-k", { text: "EXPECTED MOVE" }),
        el("span.ngl-v", { text: fmt(g.expected_move, 2) }),
        el("span.ngl-d", { text: "" }),
      ]) : null,
    ]),
    note: "the structure as it stood pre-open — compare against BOARD for today's live walls",
  });
}

/* ── N4 MACRO DRIVERS ────────────────────────────────────────────────────── */

function driverPanel(n) {
  const ds = (n.macro_drivers || []).filter((d) => d?.label);
  const news = (n.news_events || []).filter(Boolean);
  if (!ds.length && !news.length) return null;

  return panel({
    idx: "N4", title: "MACRO DRIVERS", jp: "要因",
    tools: isNum(n.macro_bias_score) ? [tag(`SCORE ${n.macro_bias_score}`, n.macro_bias_score > 0 ? "cool" : n.macro_bias_score < 0 ? "hot" : "mute")] : null,
    body: [
      ds.length ? el("div.ndrv", null, ds.map((d) => el(`div.ndrv-row.is-${d.lean || "flat"}`, null, [
        el("span.nd-k", { text: d.label }),
        el("span", { class: `nd-lean ${d.lean === "bull" ? "cool" : d.lean === "bear" ? "hot" : "mute"}`, text: String(d.lean || "flat").toUpperCase() }),
        el("span.nd-r", { text: d.reading || "" }),
      ]))) : null,
      news.length ? el("div", null, [
        rule("EVENTS"),
        el("ul.limits", null, news.map((e) => el("li", { text: typeof e === "string" ? e : (e.title || e.label || JSON.stringify(e)) }))),
      ]) : null,
    ],
  });
}
