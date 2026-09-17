// Live-spot service for the dashboard. Runs on Netlify (server-side) so it works
// even when the local scoring box is OFF — the viewer's browser calls it, and it
// fetches the current price from Yahoo (which blocks direct browser CORS).
//
// Session logic (2026-09-17 — the old version mirrored src/market.ts and served the PRIOR
// CLOSE from 04:00 until the 09:30 bell, because Yahoo's `regularMarketPrice` only moves in
// the regular session; the terminal read a stale spot all pre-market, so no planning was
// possible before the open):
//   QQQ extended (Mon–Fri 04:00–20:00 ET) -> the last 1-min print of the QQQ chart fetched
//     with includePrePost, tagged pre / US / post. If that print is more than PRINT_MAX_AGE
//     old (thin pre-market tape) and Globex is open, NQ=F converted is used instead.
//   Globex otherwise (Sun 18:00 -> Fri 17:00, minus the 17:00–18:00 daily halt) -> NQ=F last,
//     converted to QQQ-equiv via the smoothed NQ/QQQ ratio (last ~100 overlapping US minutes,
//     looked back 5 trading days so a Sunday-night ratio still has Friday's overlap).
//   Closed (Fri 20:00 -> Sun 18:00, holidays) -> last QQQ print, flagged closed.
// The AI levels stay frozen in the board; only the spot datum updates live.

import { createHmac, timingSafeEqual } from "node:crypto";
function verifyToken(authHeader) {
  const token = (authHeader ?? "").replace(/^Bearer\s+/, "");
  if (!token || !process.env.AUTH_SECRET) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try { const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return Number.isFinite(exp) && Date.now() < exp; }
  catch { return false; }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

async function yahoo(symbol, range = "1d", interval = "1m", prePost = false) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}${prePost ? "&includePrePost=true" : ""}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`yahoo ${symbol} -> HTTP ${res.status}`);
  return res.json();
}

const lastPrice = (j) => j?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;

/** [minuteBucket, close] pairs for the overlap math. */
function closes(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const c = r?.indicators?.quote?.[0]?.close ?? [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (c[i] != null) out.push([Math.floor(ts[i] / 60), c[i]]);
  return out;
}

/** The last non-null 1-min close and its epoch ms — the actual last print, pre/post included. */
function lastPrint(j) {
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const c = r?.indicators?.quote?.[0]?.close ?? [];
  for (let i = ts.length - 1; i >= 0; i--) if (c[i] != null) return { price: c[i], at: ts[i] * 1000 };
  return null;
}

/**
 * Smoothed NQ/QQQ ratio: mean of the last ~100 overlapping US-hours minutes. Five trading
 * days of 1-min bars, not two: on a Sunday night a 2-day window can hold no QQQ session at
 * all, and the ratio (hence the Asia spot) fails exactly when it is the only source.
 */
async function nqToQqqRatio() {
  const [q, n] = await Promise.all([yahoo("QQQ", "5d"), yahoo("NQ=F", "5d")]);
  const qm = new Map(closes(q));
  const ratios = [];
  for (const [bucket, close] of closes(n)) {
    const qq = qm.get(bucket);
    if (qq) ratios.push(close / qq);
  }
  if (!ratios.length) throw new Error("no overlapping QQQ/NQ bars for ratio");
  const recent = ratios.slice(-100);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** ET weekday (0=Sun) + minutes-since-midnight. */
function etNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { wd: WD[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store, max-age=0",
  },
  body: JSON.stringify(body),
});

const PRINT_MAX_AGE_MS = 10 * 60_000;

/** QQQ extended hours: Mon–Fri 04:00–20:00 ET, tagged by sub-session. */
function qqqSession(wd, minutes) {
  if (wd < 1 || wd > 5) return null;
  if (minutes >= 240 && minutes < 570) return "pre";
  if (minutes >= 570 && minutes < 960) return "US";
  if (minutes >= 960 && minutes < 1200) return "post";
  return null;
}

/** NQ Globex: Sun 18:00 -> Fri 17:00, closed 17:00–18:00 every day. */
function globexOpen(wd, minutes) {
  if (wd === 6) return false;
  if (wd === 0) return minutes >= 1080;
  if (wd === 5) return minutes < 1020;
  return minutes < 1020 || minutes >= 1080;
}

async function nqSpot() {
  const [nq, ratio] = await Promise.all([yahoo("NQ=F"), nqToQqqRatio()]);
  const last = lastPrice(nq);
  return last != null ? last / ratio : null;
}

export const handler = async (event) => {
  if (!verifyToken(event.headers["authorization"] ?? event.headers["Authorization"])) return json(401, { error: "Unauthorized" });
  try {
    const { wd, minutes } = etNow();
    const at = new Date().toISOString();
    const qs = qqqSession(wd, minutes);
    const globex = globexOpen(wd, minutes);

    if (qs) {
      const j = await yahoo("QQQ", "1d", "1m", true);
      const p = lastPrint(j);
      const fresh = p && Date.now() - p.at <= PRINT_MAX_AGE_MS;
      if (fresh || !globex) {
        // Regular session: the meta price is the most current tick; the bar close can lag it.
        const spot = qs === "US" ? (lastPrice(j) ?? p?.price ?? null) : (p?.price ?? lastPrice(j));
        return json(200, { spot, source: "QQQ", session: qs, at });
      }
      // Thin pre/post tape and Globex is open: the futures print is the better spot.
      return json(200, { spot: await nqSpot(), source: "NQ=F", session: qs, at });
    }
    if (globex) return json(200, { spot: await nqSpot(), source: "NQ=F", session: "Asia", at });

    // Markets closed (weekend / holiday gap): best-effort last QQQ print, flagged closed.
    const j = await yahoo("QQQ", "1d", "1m", true);
    return json(200, { spot: lastPrint(j)?.price ?? lastPrice(j), source: "QQQ", session: "closed", at });
  } catch (err) {
    return json(502, { error: err instanceof Error ? err.message : String(err) });
  }
};
