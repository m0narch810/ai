// Live YYY-methodology macro bias — fetches yields, liquidity, COT, and the cross-asset
// basket so the Narrative tab shows a self-refreshing bias read instead of the stale 9AM
// pre-open snapshot. 5-min Blobs cache (TGA/RRP/COT are daily/weekly so cache is fine).
//
// YYY guide's bias rule:
//   Bullish: 2Y stable/falling AND net liquidity in (TGA↓ / RRP↓) AND COT < 50
//   Bearish: 2Y rising fast AND liquidity tightening AND COT > 80
//   Neutral: signals conflict
import { connectLambda, getStore } from "@netlify/blobs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Fetch with an explicit AbortController timeout so slow external APIs don't stall the function. */
function fetchWithTimeout(url, opts, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function etIso() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

const round = (n, p = 3) => { const f = 10 ** p; return Math.round(n * f) / f; };
const dirOf = (chg, eps) => chg > eps ? "rising" : chg < -eps ? "falling" : "flat";

/** Fetch last price, previous close, and 30-min intraday velocity for a Yahoo symbol. */
async function yahooReading(symbol, eps) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const res = await fetchWithTimeout(url, { headers: { "user-agent": UA, accept: "application/json" } }, 7000);
    if (!res.ok) return null;
    const j = await res.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const closes = (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((x) => x != null && Number.isFinite(x));
    const last = Number(meta?.regularMarketPrice ?? closes[closes.length - 1]);
    const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose ?? last);
    if (!Number.isFinite(last)) return null;
    const chg = round(last - prev, 4);
    let velocity;
    if (closes.length > 2) {
      const ago = closes[Math.max(0, closes.length - 31)];
      velocity = round(closes[closes.length - 1] - ago, 4);
    }
    return { last: round(last, 4), prev: round(prev, 4), chg, velocity, dir: dirOf(chg, eps), asOf: etIso() };
  } catch { return null; }
}

/** Cross-asset: direction judged on % threshold (0.2%) so different price scales compare fairly. */
async function crossReading(symbol) {
  const r = await yahooReading(symbol, 0);
  if (!r) return null;
  const pct = r.prev ? (r.chg / r.prev) * 100 : 0;
  return { ...r, dir: dirOf(pct, 0.2) };
}

/** Treasury General Account — Treasury DTS daily, FRED WTREGEN weekly fallback. */
async function tgaReading() {
  try {
    const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance"
      + "?filter=account_type:eq:Treasury%20General%20Account%20(TGA)%20Closing%20Balance"
      + "&sort=-record_date&page%5Bsize%5D=2&fields=record_date,open_today_bal";
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 8000);
    if (!res.ok) return null;
    const body = await res.json();
    const data = body?.data ?? [];
    if (data.length < 2) return null;
    const last = Number(data[0].open_today_bal), prev = Number(data[1].open_today_bal);
    if (!Number.isFinite(last) || !Number.isFinite(prev)) return null;
    const chg = round(last - prev, 2);
    return { last: round(last, 2), prev: round(prev, 2), chg, dir: dirOf(chg, 1), asOf: data[0].record_date };
  } catch { /* fall through to FRED */ }

  // FRED WTREGEN fallback (weekly)
  try {
    const res = await fetchWithTimeout("https://fred.stlouisfed.org/graph/fredgraph.csv?id=WTREGEN", { headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" } }, 7000);
    if (!res.ok) return null;
    const rows = (await res.text()).trim().split("\n").slice(1)
      .map((l) => l.split(",")).filter((c) => c.length >= 2 && c[1] !== "." && Number.isFinite(Number(c[1])))
      .map((c) => ({ date: c[0], val: Number(c[1]) }));
    if (rows.length < 2) return null;
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    const chg = round(last.val - prev.val, 2);
    return { last: round(last.val, 2), prev: round(prev.val, 2), chg, dir: dirOf(chg, 1), asOf: last.date };
  } catch { return null; }
}

/** FRED keyless CSV — used for RRP (RRPONTSYD) and 2Y yield fallback (DGS2). */
async function fredReading(seriesId, eps) {
  try {
    const res = await fetchWithTimeout(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, { headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" } }, 7000);
    if (!res.ok) return null;
    const rows = (await res.text()).trim().split("\n").slice(1)
      .map((l) => l.split(",")).filter((c) => c.length >= 2 && c[1] !== "." && c[1]?.trim() !== "" && Number.isFinite(Number(c[1])))
      .map((c) => ({ date: c[0], val: Number(c[1]) }));
    if (rows.length < 2) return null;
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    const chg = round(last.val - prev.val, 2);
    return { last: round(last.val, 2), prev: round(prev.val, 2), chg, dir: dirOf(chg, eps), asOf: last.date };
  } catch { return null; }
}

/** OAS credit spreads — FRED BAMLH0A0HYM2 (ICE BofA High Yield OAS). YYY guide Ch.12.2 weekly layer.
 *  Thresholds: <3% healthy; 3-4% mild caution; 4-5% elevated stress; >5% crisis. Credit leads equities. */
async function oasReading() {
  const r = await fredReading("BAMLH0A0HYM2", 0.05);
  if (!r) return null;
  const level = r.last < 3.0 ? "healthy" : r.last < 4.0 ? "mild" : r.last < 5.0 ? "elevated" : "crisis";
  return { ...r, level };
}

/** VIX term structure: 9-day vs 1-month VIX ratio. Backwardation = stressed, don't fade large moves. */
function vixTermStructure(vix9d, vixFront) {
  if (!vix9d?.last || !vixFront?.last) return null;
  const ratio = round(vix9d.last / vixFront.last, 3);
  const structure = ratio > 1.02 ? "backwardation" : ratio < 0.98 ? "contango" : "flat";
  return { front: round(vix9d.last, 3), back: round(vixFront.last, 3), ratio, structure };
}

/** True if today (ET "YYYY-MM-DD") has a 10Y/20Y/30Y note or bond auction. YYY Ch.12.2: size down. */
async function auctionDayCheck(etDate) {
  try {
    const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query"
      + `?filter=auction_date:eq:${etDate}`
      + "&fields=auction_date,security_term,security_type"
      + "&page%5Bsize%5D=50";
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 8000);
    if (!res.ok) return false;
    const body = await res.json();
    const rows = body?.data ?? [];
    return rows.some((r) => {
      const term = (r.security_term || "").toLowerCase();
      const type = (r.security_type || "").toLowerCase();
      if (!["note", "bond"].includes(type)) return false;
      return /10.year|20.year|30.year/.test(term);
    });
  } catch { return false; }
}

/** COT speculator crowding for Nasdaq-100 — CFTC Socrata, best-effort (can be slow; 8s timeout). */
async function cotReading() {
  try {
    const url = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
      + "?$where=" + encodeURIComponent("contract_market_name like '%NASDAQ%'")
      + "&$order=" + encodeURIComponent("report_date_as_yyyy_mm_dd DESC")
      + "&$limit=400";
    const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 8000);
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const pick = (pred) => rows.filter((r) => { const n = (r.contract_market_name || "").toUpperCase(); return !n.includes("MICRO") && pred(n); });
    let series = pick((n) => n.includes("NASDAQ-100") && n.includes("CONSOLIDATED"));
    if (!series.length) series = pick((n) => n.includes("NASDAQ") && n.includes("MINI"));
    if (!series.length) series = pick((n) => n.includes("NASDAQ-100"));
    if (!series.length) return null;
    const market = series[0].contract_market_name || "Nasdaq-100";
    series = series.filter((r) => (r.contract_market_name || "") === market);
    const net = series.map((r) => Number(r.noncomm_positions_long_all) - Number(r.noncomm_positions_short_all)).filter((n) => Number.isFinite(n));
    if (net.length < 4) return null;
    const latest = net[0];
    const oi = Number(series[0].open_interest_all);
    const netPct = Number.isFinite(oi) && oi > 0 ? round((latest / oi) * 100, 1) : 0;
    const percentile = Math.round((net.filter((v) => v < latest).length / (net.length - 1)) * 100);
    return { netPct, percentile, market };
  } catch { return null; }
}

/**
 * YYY guide's bias rule applied to live data — same logic as fallbackNarrative in narrative.ts.
 * Returns bias ("bullish"|"bearish"|"neutral"), a -100..100 score, and the key drivers.
 * New layers (Ch.12.2 weekly): OAS credit spreads, reserve balances, WALCL, VIX term structure,
 * copper (growth proxy), auction day flag.
 */
function computeBias({ us2y, usdjpy, tga, rrp, cot, cross, oas, vix_term, reserve_bal, walcl, auction_today }) {
  let score = 0;
  const drivers = [];

  // ── Core yield + liquidity (existing) ──────────────────────────────────────
  if (us2y) {
    const bear = us2y.dir === "rising";
    score += bear ? -25 : us2y.dir === "falling" ? 25 : 0;
    drivers.push({ label: "2Y Yield", reading: `${us2y.last}% (${us2y.dir})`, lean: bear ? "bear" : us2y.dir === "falling" ? "bull" : "neutral" });
  }
  if (tga) {
    const bull = tga.dir === "falling";
    score += bull ? 15 : -10;
    drivers.push({ label: "TGA", reading: `$${Math.round(tga.last / 1000)}B (${tga.dir})`, lean: bull ? "bull" : "bear" });
  }
  if (rrp) {
    const bull = rrp.dir === "falling";
    score += bull ? 15 : -10;
    drivers.push({ label: "RRP", reading: `$${rrp.last}B (${rrp.dir})`, lean: bull ? "bull" : "bear" });
  }
  if (cot) {
    const bear = cot.percentile > 80;
    score += bear ? -15 : cot.percentile < 50 ? 10 : 0;
    drivers.push({ label: "COT", reading: `${cot.percentile}th pct`, lean: bear ? "bear" : cot.percentile < 50 ? "bull" : "neutral" });
  }

  // ── OAS credit spreads — YYY Ch.12.2 weekly layer (credit leads equities) ─
  if (oas) {
    if (oas.level === "crisis") {
      score -= 20;
      drivers.push({ label: "OAS", reading: `${oas.last}% CRISIS (>${5})`, lean: "bear" });
    } else if (oas.level === "elevated") {
      score -= 12;
      drivers.push({ label: "OAS", reading: `${oas.last}% elevated stress`, lean: "bear" });
    } else if (oas.level === "healthy") {
      score += 12;
      drivers.push({ label: "OAS", reading: `${oas.last}% healthy credit`, lean: "bull" });
    } else {
      drivers.push({ label: "OAS", reading: `${oas.last}% mild caution`, lean: "neutral" });
    }
  }

  // ── VIX term structure (backwardation = stressed, don't fade large moves) ──
  if (vix_term) {
    if (vix_term.structure === "backwardation") {
      score -= 8;
      drivers.push({ label: "VIX Term", reading: `backwardation (9d ${vix_term.front} > 1m ${vix_term.back}) — stressed`, lean: "bear" });
    } else if (vix_term.structure === "contango") {
      score += 5;
      drivers.push({ label: "VIX Term", reading: `contango (9d ${vix_term.front} < 1m ${vix_term.back}) — normal`, lean: "bull" });
    }
  }

  // ── Reserve balances (H.4.1 weekly — bank liquidity level) ────────────────
  if (reserve_bal && reserve_bal.dir !== "flat") {
    const bull = reserve_bal.dir === "rising";
    score += bull ? 8 : -8;
    drivers.push({ label: "Reserve Bal", reading: `${reserve_bal.last}B (${reserve_bal.dir})`, lean: bull ? "bull" : "bear" });
  }

  // ── Fed balance sheet (WALCL — monthly context layer, slow signal) ─────────
  if (walcl && walcl.dir !== "flat") {
    const bull = walcl.dir === "rising";
    score += bull ? 6 : -6;
    drivers.push({ label: "Fed BS", reading: `${walcl.last}B WALCL (${walcl.dir})`, lean: bull ? "bull" : "bear" });
  }

  // ── Cross-asset risk-off overlay (existing + copper) ──────────────────────
  const oil = cross?.brent ?? cross?.wti;
  if (oil?.dir === "rising") {
    score -= 15;
    drivers.push({ label: "Oil", reading: `${oil.last} (rising — geopolitics/supply)`, lean: "bear" });
  }
  if (cross?.vix) {
    const bear = cross.vix.dir === "rising";
    score += bear ? -15 : cross.vix.dir === "falling" ? 8 : 0;
    if (cross.vix.dir !== "flat") drivers.push({ label: "VIX", reading: `${cross.vix.last} (${cross.vix.dir})`, lean: bear ? "bear" : "neutral" });
  }
  if (cross?.dxy?.dir === "rising") {
    score -= 10;
    drivers.push({ label: "Dollar", reading: `${cross.dxy.last} (rising — tightening)`, lean: "bear" });
  }
  if (usdjpy?.dir === "falling") {
    score -= 15;
    drivers.push({ label: "USD/JPY", reading: `${usdjpy.last} (yen strengthening — carry unwind risk)`, lean: "bear" });
  }
  // Copper: global-growth proxy (YYY Ch.13 intermarket structure)
  if (cross?.copper && cross.copper.dir !== "flat") {
    const bull = cross.copper.dir === "rising";
    score += bull ? 8 : -8;
    drivers.push({ label: "Copper", reading: `${cross.copper.last} (${cross.copper.dir} — ${bull ? "reflation/growth" : "growth fear"})`, lean: bull ? "bull" : "bear" });
  }

  // ── Auction day flag (sizing guidance, no directional score) ──────────────
  if (auction_today) {
    drivers.push({ label: "Auction Day", reading: "10Y/20Y/30Y bond today — size down (YYY Ch.12.2)", lean: "neutral" });
  }

  const bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";
  return { bias, score, drivers };
}

const jsonResp = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store, max-age=0" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  connectLambda(event);
  const force = event?.queryStringParameters?.force === "1";
  const store = getStore("macro-cache");

  if (!force) {
    const cached = await store.get("latest", { type: "json" }).catch(() => null);
    if (cached && Date.now() - (cached.scored_at || 0) < CACHE_TTL_MS) return jsonResp(200, cached);
  }

  const notes = [];

  // 2Y is the lead signal per the YYY guide. Try Yahoo first (intraday), FRED fallback (daily).
  let us2y = await yahooReading("2YY=F", 0.01);
  if (!us2y) { notes.push("2Y (Yahoo) unavailable — using FRED DGS2 (daily)"); us2y = await fredReading("DGS2", 0.01); }

  // Fetch everything else in parallel — new: ^VIX9D (term structure), WRESBAL (reserves),
  // BAMLH0A0HYM2 (OAS credit spreads), WALCL (Fed balance sheet), auction day check.
  const etDate = etIso().slice(0, 10);
  const [us10y, usdjpy, tga, rrp, cot, brent, wti, gold, copper, dxy, vix, vxn, btc, hyg,
         vix9d, wresbal, oas, auction_today, walcl, skewIdx] = await Promise.all([
    yahooReading("^TNX", 0.01),
    yahooReading("JPY=X", 0.05),
    tgaReading(),
    fredReading("RRPONTSYD", 1),
    cotReading(),
    crossReading("BZ=F"),
    crossReading("CL=F"),
    crossReading("GC=F"),
    crossReading("HG=F"),
    crossReading("DX-Y.NYB"),
    crossReading("^VIX"),
    crossReading("^VXN"),                    // Nasdaq-specific vol (VXN/VIX spread = tech premium)
    crossReading("BTC-USD"),
    crossReading("HYG"),
    yahooReading("^VIX9D", 0.01),           // VIX 9-day (short-end term structure)
    fredReading("WRESBAL", 5),               // Fed reserve balances (H.4.1 weekly)
    oasReading(),                            // High yield OAS (BAMLH0A0HYM2)
    auctionDayCheck(etDate),                 // 10Y/20Y/30Y auction today?
    fredReading("WALCL", 1),                 // Fed total assets (WALCL, weekly)
    crossReading("^SKEW"),                   // CBOE SKEW index — tail risk premium (>135 = elevated)
  ]);

  const cross = {};
  if (brent)  cross.brent  = brent;
  if (wti)    cross.wti    = wti;
  if (gold)   cross.gold   = gold;
  if (copper) cross.copper = copper;
  if (dxy)    cross.dxy    = dxy;
  if (vix)    cross.vix    = vix;
  if (vxn)    cross.vxn    = vxn;
  if (skewIdx) cross.skew_index = skewIdx;
  if (btc)    cross.btc    = btc;
  if (hyg)    cross.hyg    = hyg;

  // Derived: VIX term structure, yield curve spread, copper/gold ratio
  const vix_term = vixTermStructure(vix9d, vix);
  const curve2s10s = (us10y && us2y) ? round(us10y.last - us2y.last, 3) : null;
  const copper_gold_ratio = (copper?.last && gold?.last && gold.last > 0)
    ? round(copper.last / gold.last, 6) : null;

  if (!us10y)   notes.push("10Y yield unavailable");
  if (!tga)     notes.push("TGA unavailable");
  if (!rrp)     notes.push("RRP unavailable");
  if (!cot)     notes.push("COT unavailable");
  if (!oas)     notes.push("OAS (BAMLH0A0HYM2) unavailable");
  if (!wresbal) notes.push("Reserve balances (WRESBAL) unavailable");
  if (!walcl)   notes.push("WALCL (Fed balance sheet) unavailable");

  const { bias, score: bias_score, drivers } = computeBias({
    us2y, usdjpy, tga, rrp, cot, cross,
    oas, vix_term, reserve_bal: wresbal, walcl, auction_today,
  });

  const result = {
    asOf: etIso(),
    scored_at: Date.now(),
    us2y, us10y, usdjpy,
    tga, rrp, cot,
    curve2s10s,
    oas,
    vix_term,
    auction_today: auction_today ?? false,
    reserve_bal: wresbal,
    walcl,
    copper_gold_ratio,
    cross,
    bias, bias_score, drivers,
    notes,
  };

  await store.setJSON("latest", result).catch(() => {});
  return jsonResp(200, result);
};
