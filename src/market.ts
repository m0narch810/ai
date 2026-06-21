import YahooFinance from "yahoo-finance2";
import { fetchCandles } from "./altaris.js";
import { config, type SessionDef } from "./config.js";
import type { Bar } from "./types.js";

const yf = new YahooFinance();

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
  const res = await yf.chart(symbol, { period1: start, period2: now, interval: config.marketInterval as "1m" });
  return res.quotes
    .filter((r) => r.high != null && r.low != null && r.open != null && r.close != null)
    .map((r) => ({ date: r.date, open: r.open!, high: r.high!, low: r.low!, close: r.close!, volume: r.volume ?? 0 }));
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

/** Current QQQ-equivalent spot from the latest NQ print (for Asia, when QQQ is stale). */
export async function liveQqqEquivSpot(): Promise<number> {
  const [nq, ratio] = await Promise.all([fetchRaw("NQ=F", 6), nqToQqqRatio()]);
  const last = nq[nq.length - 1];
  if (!last) throw new Error("No recent NQ bars.");
  return last.close / ratio;
}

/**
 * Detection bars for a session, in QQQ price terms.
 *  US   — Altaris /api/candles (15-min, same source as the chart the user watches; includes delta per bar).
 *  Asia — NQ=F OHLC from Yahoo converted to QQQ-equiv via smoothed ratio (Altaris doesn't serve futures).
 */
export async function fetchSessionBars(session: SessionDef): Promise<Bar[]> {
  if (session.source === "QQQ") {
    const resp = await fetchCandles(1);
    return resp.candles
      .filter((c) => {
        const m = /T(\d{2}):(\d{2})/.exec(c.t);
        if (!m) return false;
        return inWindow(Number(m[1]) * 60 + Number(m[2]), session.startMin, session.endMin);
      })
      .map((c) => ({ ts: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v, delta: c.d }));
  }

  // Asia: NQ→QQQ via Yahoo (Altaris doesn't serve futures bars).
  const raw = await fetchRaw("NQ=F", 14);
  const inSession = raw.filter((r) => inWindow(etMinutes(r.date), session.startMin, session.endMin));
  const ratio = await nqToQqqRatio();
  return inSession.map((r) => ({
    ts: etIso(r.date),
    open: r.open / ratio, high: r.high / ratio, low: r.low / ratio, close: r.close / ratio,
    volume: r.volume,
  }));
}
