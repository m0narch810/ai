// Local visual preview of web/ — no login, no Netlify, no scoring box.
//
//   node scripts/preview.mjs            → http://localhost:8899   (one tab at a time)
//   node scripts/preview.mjs --all      → every tab stacked on one page
//   node scripts/preview.mjs --port 9000
//
// It pulls a live snapshot from YYY once at startup, folds in whatever desk JSON happens to be
// sitting in web/ (dashboard / narrative / regime), and serves a harness page that imports the
// REAL modules and the REAL stylesheet. So what you see is the shipped front end, just with a
// frozen data frame and the auth layer bypassed.
//
// Nothing here is deployed: the harness page and its fixture are generated in memory, and
// scripts/ is outside the published `web` directory.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const BASE = (process.env.YYY_BASE_URL || "https://web-production-8a6973.up.railway.app").replace(/\/$/, "");

const argv = process.argv.slice(2);
const ALL = argv.includes("--all");
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 8899;

/** Everything the six views ask for, in one shot. */
const EPS = {
  gex: "/gex?ticker=QQQ", dex: "/dex?ticker=QQQ", charm: "/charm?ticker=QQQ",
  vanna: "/vanna?ticker=QQQ", vega: "/vega?ticker=QQQ", theta: "/theta?ticker=QQQ",
  veta: "/veta?ticker=QQQ", vomma: "/vomma?ticker=QQQ", rho: "/rho?ticker=QQQ",
  chart: "/chart?ticker=QQQ&interval=5min", zero_dte: "/zero_dte?ticker=QQQ",
  expected_move: "/expected_move?ticker=QQQ", levels: "/levels?ticker=QQQ",
  dealer_delta: "/dealer_delta?ticker=QQQ", atr: "/atr?ticker=QQQ",
  iv_surface: "/iv_surface?ticker=QQQ", net_iv: "/net_iv?ticker=QQQ",
  probability: "/probability?ticker=QQQ", vol_forecast: "/vol_forecast",
  flow: "/flow?ticker=QQQ", dealer_anomalies: "/dealer_anomalies?ticker=QQQ",
  dex_ladder: "/dex_ladder?ticker=QQQ", option_matrix: "/option-matrix?ticker=QQQ",
  scanner: "/scanner", flux: "/flux", bias: "/bias", hurst: "/hurst",
  history: "/history", macro: "/macro", macro_extended: "/macro_extended",
};

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

async function snapshot() {
  const yyy = {};
  await Promise.all(Object.entries(EPS).map(async ([k, ep]) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30_000);
      const r = await fetch(BASE + ep, { signal: ctl.signal });
      clearTimeout(t);
      yyy[k] = await r.json();
    } catch (e) { console.warn(`  · ${k}: ${String(e?.message ?? e).slice(0, 60)}`); }
  }));
  const desk = readJson(path.join(WEB, "dashboard.json"));
  return {
    spot: yyy.gex?.spot ?? desk?.spot ?? 700,
    yyy,
    desk,
    narrative: readJson(path.join(WEB, "narrative.json")),
    regime: readJson(path.join(WEB, "regime.json")),
    // The desk macro pulse is an authed cloud function; the pre-open brief carries the same
    // shape, so reuse it here rather than leaving the panel dark in preview.
    macro: null,
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TORII preview</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<style>
  .pv-bar{position:sticky;top:0;z-index:20;display:flex;gap:10px;align-items:center;
    background:var(--bg);border-bottom:2px solid var(--red);padding:7px 0;font-size:10px;letter-spacing:.18em}
  .pv-bar a{color:var(--ink2);text-decoration:none;border:1px solid var(--line2);padding:3px 7px}
  .pv-bar a:hover{color:var(--ink);border-color:var(--ink)}
  .pv-sec{margin:26px 0 10px;padding:6px 0;border-top:2px solid var(--red);
    font-size:11px;letter-spacing:.24em;color:var(--red)}
</style>
</head><body>
<canvas id="bg" class="bg-canvas" aria-hidden="true"></canvas>
<main id="app">
  <div class="pv-bar">
    <b>PREVIEW</b>
    <a href="?theme=light">LIGHT</a><a href="?theme=dark">DARK</a>
    <a href="?all=1">ALL TABS</a><a href="/">SINGLE</a>
    <span id="pvNote" style="color:var(--ink3)"></span>
  </div>
  <header class="top">
    <div class="brand"><span class="brand-mark">鳥居</span><span class="brand-text"><b>TORII</b><i>QQQ OPTIONS FLOW TERMINAL · YYY</i></span></div>
    <div class="top-right">
      <span class="status"><i class="dot is-live" id="statusDot"></i><span id="statusText">LIVE</span><em id="statusAge">just now</em></span>
      <span class="clock" id="clock"></span>
      <button class="ibtn" id="themeToggle" type="button">☾</button>
      <button class="ibtn" id="refresh" type="button">↻</button>
      <span class="who"><span id="accountUser">preview</span><button class="ibtn" id="signout" type="button">⏻</button></span>
    </div>
  </header>
  <section class="rail">
    <div class="rail-price"><span class="rail-spot" id="railSpot">—</span><span class="rail-chg" id="railChg"></span><span class="rail-src" id="railSrc"></span></div>
    <pre class="rail-spark" id="railSpark"></pre>
    <div class="rail-chips" id="railChips"></div>
  </section>
  <nav class="tabs" id="tabs"></nav>
  <div id="viewRoot" class="views"></div>
</main>
<script type="module">
import { el, asciiSpark, isNum, etClock } from "/lib/util.js";
import { tag } from "/lib/ui.js";
import { initBackground } from "/lib/bg.js";
import * as board from "/lib/views/board.js";
import * as greeks from "/lib/views/greeks.js";
import * as vol from "/lib/views/vol.js";
import * as flow from "/lib/views/flow.js";
import * as regime from "/lib/views/regime.js";
import * as narrative from "/lib/views/narrative.js";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get("theme") || "light";
document.getElementById("themeToggle").onclick = () => {
  const d = document.documentElement.dataset.theme === "dark";
  location.search = new URLSearchParams({ ...Object.fromEntries(q), theme: d ? "light" : "dark" });
};
document.getElementById("refresh").onclick = () => location.reload();

const f = await (await fetch("/__fixture.json")).json();
const ctx = {
  yyy: { ok: f.yyy, err: {}, at: Date.now() },
  pending: new Set(), wait: () => null, deskPending: false,
  spot: f.spot, spotMeta: { source: "QQQ", session: "PREVIEW" },
  desk: f.desk ? { board: f.desk, source: "desk", at: (f.desk.scored_at || Date.now()) } : null,
  narrative: f.narrative, regime: f.regime, macro: f.macro,
};

initBackground(document.getElementById("bg"));
document.getElementById("clock").textContent = etClock() + " ET";
document.getElementById("pvNote").textContent =
  "frozen snapshot · " + Object.keys(f.yyy).length + " YYY endpoints";

// rail
const gx = f.yyy.gex || {}, em = f.yyy.expected_move || {}, atr = f.yyy.atr || {};
document.getElementById("railSpot").textContent = isNum(f.spot) ? f.spot.toFixed(2) : "—";
const open = f.yyy.chart?.candles?.[0]?.open;
if (isNum(open) && isNum(f.spot)) {
  const chg = f.spot - open, e2 = document.getElementById("railChg");
  e2.textContent = (chg >= 0 ? "+" : "−") + Math.abs(chg).toFixed(2) + "  " + (chg / open * 100).toFixed(2) + "%";
  e2.className = "rail-chg " + (chg >= 0 ? "p" : "n");
}
document.getElementById("railSrc").textContent = "SNAPSHOT";
if (f.yyy.chart?.candles) {
  document.getElementById("railSpark").textContent =
    asciiSpark(f.yyy.chart.candles.slice(-60).map((b) => b.close));
}
const chips = [];
if (gx.gamma_env) chips.push(tag(gx.gamma_env + " Γ", gx.gamma_env === "POSITIVE" ? "cool" : "hot"));
if (isNum(gx.net_gex_bn)) chips.push(tag("GEX " + (gx.net_gex_bn >= 0 ? "+" : "−") + Math.abs(gx.net_gex_bn).toFixed(2) + "B", "mute"));
if (isNum(gx.call_wall)) chips.push(tag("CW " + gx.call_wall, "cool"));
if (isNum(gx.put_wall)) chips.push(tag("PW " + gx.put_wall, "hot"));
if (isNum(em.atm_iv)) chips.push(tag("IV " + em.atm_iv.toFixed(1) + "%", "mute"));
if (isNum(atr.atr)) chips.push(tag("ATR " + atr.atr.toFixed(2), "mute"));
document.getElementById("railChips").replaceChildren(...chips);

const views = [board, greeks, vol, flow, regime, narrative];
const tabs = document.getElementById("tabs");
const root = document.getElementById("viewRoot");

function show(v) {
  for (const b of tabs.children) b.classList.toggle("on", b.dataset.v === v.ID);
  const h = el("div.views");
  root.replaceChildren(h);
  v.render(h, ctx);
}
for (const v of views) {
  tabs.append(el("button.tab", { type: "button", "data-v": v.ID, onClick: () => show(v) },
    [el("i.tab-jp", { text: v.JP }), el("span.tab-en", { text: v.LABEL })]));
}
document.addEventListener("view:refresh", () => {
  const cur = views.find((v) => tabs.querySelector('[data-v="' + v.ID + '"]')?.classList.contains("on"));
  if (cur) show(cur);
});

if (q.get("all") === "1") {
  root.replaceChildren();
  for (const v of views) {
    const h = el("div.views");
    root.append(el("div.pv-sec", { text: "▚ " + v.LABEL + " ▚" }), h);
    v.render(h, ctx);
  }
} else {
  show(views[0]);
}
</script>
</body></html>`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

console.log(`pulling a live snapshot from ${BASE} …`);
const fixture = await snapshot();
console.log(`  got ${Object.keys(fixture.yyy).length}/${Object.keys(EPS).length} endpoints, spot ${fixture.spot}`);

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }
  if (url === "/__fixture.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(fixture));
  }
  // Serve web/ — but never the private desk JSONs, matching the real deploy.
  const rel = path.normalize(decodeURIComponent(url)).replace(/^[\\/]+/, "");
  if (/^(dashboard|narrative|regime)\.json$/.test(rel)) { res.writeHead(404); return res.end(); }
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`\npreview  →  http://localhost:${PORT}${ALL ? "/?all=1" : ""}`);
  console.log(`         →  http://localhost:${PORT}/?all=1&theme=dark   (everything, dark)`);
});
