// Macro inputs behind dxrk's RTH bias (PDF 2): 2Y/10Y yields, USD/JPY carry, net
// liquidity (TGA/RRP), and COT crowding. All sources are free + keyless:
//   - yields & USD/JPY  → Yahoo Finance (intraday, for level + velocity)
//   - TGA / RRP         → FRED fredgraph CSV (no API key)
//   - COT               → CFTC public reporting (Socrata), best-effort
// Every fetch is independent and non-fatal: a failure is recorded in notes[] and the
// narrative scorer simply weights the rest. Nothing here throws.
import YahooFinance from "yahoo-finance2";
import { config } from "./config.js";
import type { CrossAssetSnapshot, MacroReading, MacroSnapshot, NewsEvent } from "./types.js";

const yf = new YahooFinance();

const round = (n: number, p = 3) => { const f = 10 ** p; return Math.round(n * f) / f; };
const dirOf = (chg: number, eps: number): MacroReading["dir"] =>
  chg > eps ? "rising" : chg < -eps ? "falling" : "flat";

function etIso(d = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.sessionTz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

/**
 * A Yahoo yield/FX reading: last price, prior close, and ~30-min velocity from 1-min bars.
 * dxrk weights the *speed* of the pre-open move, not just the level — hence velocity.
 */
async function yahooReading(symbol: string, eps: number): Promise<MacroReading | undefined> {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 8 * 3600 * 1000);
    const [q, chart] = await Promise.all([
      yf.quote(symbol),
      yf.chart(symbol, { period1: start, period2: now, interval: "1m" }).catch(() => null),
    ]);
    const last = Number(q?.regularMarketPrice);
    const prev = Number(q?.regularMarketPreviousClose ?? q?.regularMarketPrice);
    if (!Number.isFinite(last)) return undefined;

    let velocity: number | undefined;
    const quotes = chart?.quotes?.filter((r) => r.close != null) ?? [];
    if (quotes.length > 2) {
      const lastClose = quotes[quotes.length - 1]!.close!;
      const ago = quotes[Math.max(0, quotes.length - 31)]!.close!; // ~30 bars back
      velocity = round(lastClose - ago, 4);
    }
    const chg = round(last - prev, 4);
    return { last: round(last, 4), prev: round(prev, 4), chg, velocity, dir: dirOf(chg, eps), asOf: etIso(now) };
  } catch {
    return undefined;
  }
}

/** Latest two numeric points of a FRED series via the keyless fredgraph CSV endpoint. */
async function fredReading(seriesId: string, eps: number): Promise<MacroReading | undefined> {
  try {
    const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, {
      headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" },
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    const rows = text.trim().split("\n").slice(1) // drop header
      .map((l) => l.split(","))
      .filter((c) => c.length >= 2 && c[1] !== "." && c[1]!.trim() !== "" && Number.isFinite(Number(c[1])))
      .map((c) => ({ date: c[0]!, val: Number(c[1]) }));
    if (rows.length < 2) return undefined;
    const last = rows[rows.length - 1]!;
    const prev = rows[rows.length - 2]!;
    const chg = round(last.val - prev.val, 2);
    return { last: round(last.val, 2), prev: round(prev.val, 2), chg, dir: dirOf(chg, eps), asOf: last.date };
  } catch {
    return undefined;
  }
}

/**
 * COT speculator crowding for Nasdaq-100 (CFTC legacy futures-only). Returns the latest
 * net non-commercial position as a percentile of its own ~3-year history — dxrk's >80 / <20
 * extreme-crowding read. Best-effort: returns null on any hiccup.
 */
async function cotReading(): Promise<MacroSnapshot["cot"]> {
  try {
    const url = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
      + "?$where=" + encodeURIComponent("contract_market_name like '%NASDAQ%'")
      + "&$order=" + encodeURIComponent("report_date_as_yyyy_mm_dd DESC")
      + "&$limit=400";
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const rows = (await res.json()) as Record<string, string>[];
    if (!Array.isArray(rows) || !rows.length) return null;

    // Prefer the E-mini Nasdaq-100; fall back to any Nasdaq-100 contract.
    const pick = (pred: (n: string) => boolean) =>
      rows.filter((r) => pred((r.contract_market_name || "").toUpperCase()));
    let series = pick((n) => n.includes("NASDAQ-100") && (n.includes("MINI") || n.includes("E-MINI")));
    if (!series.length) series = pick((n) => n.includes("NASDAQ-100"));
    if (!series.length) series = pick((n) => n.includes("NASDAQ"));
    if (!series.length) return null;

    const market = series[0]!.contract_market_name || "Nasdaq-100";
    const net = series
      .map((r) => Number(r.noncomm_positions_long_all) - Number(r.noncomm_positions_short_all))
      .filter((n) => Number.isFinite(n));
    if (net.length < 4) return null;

    const latest = net[0]!;
    const oi = Number(series[0]!.open_interest_all);
    const netPct = Number.isFinite(oi) && oi > 0 ? round((latest / oi) * 100, 1) : 0;
    const below = net.filter((v) => v < latest).length;
    const percentile = Math.round((below / (net.length - 1)) * 100);
    return { netPct, percentile, market };
  } catch {
    return null;
  }
}

/**
 * A cross-asset reading. Same Yahoo fetch as a yield, but `dir` is recomputed on a *percentage*
 * threshold (0.2% pre-open move = meaningful) so oil, VIX, the dollar and BTC — wildly different
 * price scales — are all judged on the same "did it actually move" bar.
 */
async function crossReading(symbol: string): Promise<MacroReading | undefined> {
  const r = await yahooReading(symbol, 0); // raw fetch; dir overridden below
  if (!r) return undefined;
  const pct = r.prev ? (r.chg / r.prev) * 100 : 0;
  return { ...r, dir: dirOf(pct, 0.2) };
}

/** The keyless cross-asset / commodity basket (oil, gold, copper, dollar, VIX, BTC, credit). */
async function fetchCrossAssets(): Promise<{ cross: CrossAssetSnapshot; missing: string[] }> {
  const symbols: [keyof CrossAssetSnapshot, string][] = [
    ["brent", "BZ=F"], ["wti", "CL=F"], ["gold", "GC=F"], ["copper", "HG=F"],
    ["dxy", "DX-Y.NYB"], ["vix", "^VIX"], ["btc", "BTC-USD"], ["hyg", "HYG"],
  ];
  const results = await Promise.all(symbols.map(([, sym]) => crossReading(sym)));
  const cross: CrossAssetSnapshot = {};
  const missing: string[] = [];
  symbols.forEach(([key], i) => {
    const r = results[i];
    if (r) cross[key] = r;
    else missing.push(key);
  });
  return { cross, missing };
}

/**
 * Recent market-moving headlines via GDELT DOC 2.0 — keyless, no rate limit. This is the
 * deterministic geopolitics/event backstop: it works even when the AI's live web search is
 * flaky, and surfaces things like an oil-supply / Strait-of-Hormuz story as a real headline.
 * Best-effort: returns [] on any hiccup.
 */
async function fetchNews(): Promise<NewsEvent[]> {
  try {
    // Market-moving macro + geopolitics, last 24h, freshest first, English news sources.
    const query =
      '("stock market" OR "Federal Reserve" OR "interest rate" OR "oil price" OR inflation '
      + 'OR sanctions OR tariffs OR "Strait of Hormuz" OR geopolitical) sourcelang:english';
    const url = "https://api.gdeltproject.org/api/v2/doc/doc"
      + `?query=${encodeURIComponent(query)}`
      + "&mode=ArtList&format=json&maxrecords=25&timespan=24H&sort=DateDesc";
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
    if (!res.ok) return []; // includes GDELT's 429 rate-limit ("1 request / 5s")
    // Sniff the body, not the content-type header: GDELT returns plain-text errors (rate-limit
    // notice) or HTML on a malformed query, but a real result is a JSON object starting with "{".
    const text = (await res.text()).trim();
    if (!text.startsWith("{")) return [];
    const body = JSON.parse(text) as { articles?: { title?: string; domain?: string; seendate?: string; url?: string }[] };
    const arts = Array.isArray(body?.articles) ? body.articles : [];

    const seen = new Set<string>();
    const events: NewsEvent[] = [];
    for (const a of arts) {
      const title = (a.title || "").trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ title, source: a.domain || "", when: a.seendate || "", url: a.url });
      if (events.length >= 12) break;
    }
    return events;
  } catch {
    return [];
  }
}

/** Pull every macro input concurrently. Never throws; failures land in notes[]. */
export async function fetchMacro(): Promise<MacroSnapshot> {
  const notes: string[] = [];
  // 2Y is the lead signal; try Yahoo (intraday) first, fall back to FRED DGS2 (daily, no velocity).
  let us2y = await yahooReading("2YY=F", 0.01);
  if (!us2y) us2y = await fredReading("DGS2", 0.01);
  const [us10y, usdjpy, tga, rrp, cot, crossResult, headlines] = await Promise.all([
    yahooReading("^TNX", 0.01),
    yahooReading("JPY=X", 0.05),
    fredReading("WTREGEN", 1),    // Treasury General Account (weekly)
    fredReading("RRPONTSYD", 1),  // Overnight reverse repo (daily)
    cotReading(),
    fetchCrossAssets(),
    fetchNews(),
  ]);

  if (!us2y) notes.push("2Y yield unavailable");
  if (!us10y) notes.push("10Y yield unavailable");
  if (!usdjpy) notes.push("USD/JPY unavailable");
  if (!tga) notes.push("TGA (FRED) unavailable");
  if (!rrp) notes.push("RRP (FRED) unavailable");
  if (!cot) notes.push("COT (CFTC) unavailable");
  if (crossResult.missing.length) notes.push(`cross-asset unavailable: ${crossResult.missing.join(", ")}`);
  if (!headlines.length) notes.push("news (GDELT) unavailable");

  const curve = us10y && us2y ? round(us10y.last - us2y.last, 3) : undefined;

  return { asOf: etIso(), us2y, us10y, curve2s10s: curve, usdjpy, tga, rrp, cot, cross: crossResult.cross, headlines, notes };
}
