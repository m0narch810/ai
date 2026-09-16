// Debug tool: grade a day's calls.jsonl with the CURRENT gradeTradeCall against Yahoo RTH bars
// — mirrors persistCalls' windowing. Usage: npx tsx scripts/regrade-check.ts [YYYY-MM-DD]
import fs from "node:fs/promises";
import { gradeTradeCall } from "../src/detect.js";

const date = process.argv[2] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/QQQ?interval=1m&range=1d`, {
  headers: { "User-Agent": "Mozilla/5.0" },
});
const j = (await res.json()) as any;
const r0 = j.chart.result[0];
const q = r0.indicators.quote[0];
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const etIso = (sec: number) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
};
const bars = (r0.timestamp as number[])
  .map((t: number, i: number) => ({ ts: etIso(t), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
  .filter((b: any) => b.high != null && b.ts >= `${date}T09:30:00` && b.ts <= `${date}T16:00:00`);

console.log(`RTH bars: ${bars.length}  last=${bars[bars.length - 1]!.ts}  close=${bars[bars.length - 1]!.close.toFixed(2)}`);

const calls = (await fs.readFile(`data/scored/${date}.calls.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const c of calls) {
  const g = gradeTradeCall(bars.filter((b: any) => b.ts >= c.as_of), c.side, c.entry, false);
  console.log(`${c.as_of.slice(11)} ${c.side.padEnd(5)} entry=${c.entry} -> ${g.status.padEnd(10)} filled=${g.filledAt?.slice(11) ?? "-"} resolved=${g.resolvedAt?.slice(11) ?? "-"} mfe=${g.mfe_pct ?? "-"} pnl=${g.pnl_pts ?? "-"}`);
}
