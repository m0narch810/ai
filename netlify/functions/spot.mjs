// Live-spot service for the dashboard. Runs on Netlify (server-side) so it works
// even when the local scoring box is OFF — the viewer's browser calls it, and it
// fetches the current price from Yahoo (which blocks direct browser CORS).
//
// Mirrors src/market.ts session logic:
//   US session   -> QQQ regular market price directly.
//   Asia / o-night-> NQ=F last, converted to QQQ-equiv via the smoothed NQ/QQQ ratio.
// The AI levels stay frozen in dashboard.json; only the spot datum updates live.

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

async function yahoo(symbol, range = "1d", interval = "1m") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
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

/** Smoothed NQ/QQQ ratio: mean of the last ~100 overlapping US-hours minutes. */
async function nqToQqqRatio() {
  const [q, n] = await Promise.all([yahoo("QQQ", "2d"), yahoo("NQ=F", "2d")]);
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

export const handler = async (event) => {
  if (!verifyToken(event.headers["authorization"] ?? event.headers["Authorization"])) return json(401, { error: "Unauthorized" });
  try {
    const { wd, minutes } = etNow();
    const usOpen = wd >= 1 && wd <= 5 && minutes >= 510 && minutes <= 1020;        // Mon–Fri 08:30–17:00 ET
    const asia = (minutes >= 1080 && wd >= 0 && wd <= 4) || (minutes <= 240 && wd >= 1 && wd <= 5); // 18:00→04:00 (NQ open)

    if (usOpen) {
      const spot = lastPrice(await yahoo("QQQ"));
      return json(200, { spot, source: "QQQ", session: "US", at: new Date().toISOString() });
    }
    if (asia) {
      const [nq, ratio] = await Promise.all([yahoo("NQ=F"), nqToQqqRatio()]);
      const last = lastPrice(nq);
      return json(200, { spot: last != null ? last / ratio : null, source: "NQ=F", session: "Asia", at: new Date().toISOString() });
    }
    // Markets closed (weekend / gap): best-effort last QQQ print, flagged closed.
    const spot = lastPrice(await yahoo("QQQ"));
    return json(200, { spot, source: "QQQ", session: "closed", at: new Date().toISOString() });
  } catch (err) {
    return json(502, { error: err instanceof Error ? err.message : String(err) });
  }
};
