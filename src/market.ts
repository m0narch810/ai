import YahooFinance from "yahoo-finance2";
import { config, type SessionDef } from "./config.js";
import type { Bar } from "./types.js";

const yf = new YahooFinance();

/** Reject if a promise doesn't settle within ms — guards against a hung Yahoo request. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.sessionTz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function etMinutes(d: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: config.sessionTz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return g("hour") * 60 + g("minute");
}
function etIso(d: Date): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: config.sessionTz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${etDate(d)}T${g("hour")}:${g("minute")}:${g("second")}`;
}
/** Window membership in ET minutes, wrap-aware (start > end means it crosses midnight). */
function inWindow(m: number, start: number, end: number): boolean {
  return start <= end ? m >= start && m <= end : m >= start || m <= end;
}

interface RawBar { date: Date; open: number; high: number; low: number; close: number; volume: number }

async function fetchRaw(symbol: string, lookbackHours: number): Promise<RawBar[]> {
  const now = new Date();
  const start = new Date(now.getTime() - lookbackHours * 3600 * 1000);
  // Yahoo's edge intermittently serves a transient HTTP 400 error page (seen live 2026-07-10:
  // one 400 killed the candle-freeze fallback, and reversal detection with it). Retry the
  // library call, then fall back to a direct query1 fetch — the host the Netlify functions
  // use, which kept working through the same episode.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const res = await withTimeout(
        yf.chart(symbol, { period1: start, period2: now, interval: config.marketInterval as "1m" }),
        config.fetchTimeoutMs, `Yahoo chart ${symbol}`,
      );
      return res.quotes
        .filter((r) => r.high != null && r.low != null && r.open != null && r.close != null)
        .map((r) => ({ date: r.date, open: r.open!, high: r.high!, low: r.low!, close: r.close!, volume: r.volume ?? 0 }));
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    return await fetchRawDirect(symbol, start, now);
  } catch {
    throw lastErr; // the library error names the real failure; the direct call is best-effort
  }
}

/** Bare v8 chart fetch against query1 (no library, no query2) — last-resort path for fetchRaw. */
async function fetchRawDirect(symbol: string, start: Date, end: Date): Promise<RawBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${config.marketInterval}&period1=${Math.floor(start.getTime() / 1000)}` +
    `&period2=${Math.floor(end.getTime() / 1000)}&includePrePost=true`;
  const resp = await withTimeout(
    fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }),
    config.fetchTimeoutMs, `Yahoo direct ${symbol}`,
  );
  if (!resp.ok) throw new Error(`Yahoo direct ${symbol}: HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, Array<number | null>>> } }> };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0] ?? {};
  const bars: RawBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ date: new Date(ts[i]! * 1000), open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  if (!bars.length) throw new Error(`Yahoo direct ${symbol}: no bars in response`);
  console.warn(`Yahoo library chart failed for ${symbol} — served by direct query1 fallback (${bars.length} bars)`);
  return bars;
}

/**
 * Smoothed NQ/QQQ ratio (converter.pine logic): mean of the last ~100 minutes where
 * both QQQ and NQ have a print — i.e. the most recent US-hours overlap. QQQ-equiv = NQ / ratio.
 */
export async function nqToQqqRatio(): Promise<number> {
  // 96h, not 36h: over a weekend (or any multi-day market gap) the most recent overlapping
  // QQQ+NQ minute can be 50h+ back (Fri RTH seen from Sun), so a 36h window finds no overlap.
  const [qqq, nq] = await Promise.all([fetchRaw("QQQ", 96), fetchRaw("NQ=F", 96)]);
  const bucket = (d: Date) => Math.floor(d.getTime() / 60000);
  const qmap = new Map<number, number>();
  for (const r of qqq) qmap.set(bucket(r.date), r.close);
  const ratios: number[] = [];
  for (const r of nq) {
    const q = qmap.get(bucket(r.date));
    if (q) ratios.push(r.close / q);
  }
  if (ratios.length === 0) throw new Error("No overlapping QQQ/NQ bars to compute conversion ratio.");
  const recent = ratios.slice(-100);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** Latest live QQQ print from Yahoo (US-session sanity reference vs the YYY chain spot). */
export async function liveQqqSpot(): Promise<number> {
  const qqq = await fetchRaw("QQQ", 6);
  const last = qqq[qqq.length - 1];
  if (!last) throw new Error("No recent QQQ bars.");
  return last.close;
}

/** Current QQQ-equivalent spot from the latest NQ print (for Asia, when QQQ is stale). */
export async function liveQqqEquivSpot(): Promise<number> {
  const [nq, ratio] = await Promise.all([fetchRaw("NQ=F", 6), nqToQqqRatio()]);
  const last = nq[nq.length - 1];
  if (!last) throw new Error("No recent NQ bars.");
  return last.close / ratio;
}

/**
 * Detection bars for a session, in QQQ price terms.
 *  US   — QQQ 1-min OHLC from Yahoo.
 *  Asia — NQ=F OHLC from Yahoo converted to QQQ-equiv via smoothed ratio.
 */
export async function fetchSessionBars(session: SessionDef, date?: string): Promise<Bar[]> {
  if (session.source === "QQQ") {
    // Yahoo QQQ 1-min bars. This was the fallback under Altaris (whose candle feed intermittently
    // froze on a prior day) and is now the only US bar source — Altaris was retired 2026-09-01.
    // No per-bar order-flow delta, which detection doesn't use.
    const raw = await fetchRaw("QQQ", 14);
    return raw
      .filter((r) => (!date || etDate(r.date) === date) && inWindow(etMinutes(r.date), session.startMin, session.endMin))
      .map((r) => ({ ts: etIso(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }

  // Asia: NQ→QQQ via Yahoo.
  const raw = await fetchRaw("NQ=F", 14);
  const inSession = raw.filter((r) => inWindow(etMinutes(r.date), session.startMin, session.endMin));
  const ratio = await nqToQqqRatio();
  return inSession.map((r) => ({
    ts: etIso(r.date),
    open: r.open / ratio, high: r.high / ratio, low: r.low / ratio, close: r.close / ratio,
    volume: r.volume,
  }));
}
