import { captureTick } from "./capture.js";
import { activeSession, nowInSessionTz, RTH_MIN, type SessionDef } from "./config.js";
import { detectMany } from "./detect.js";
import { fetchSessionBars, liveQqqEquivSpot } from "./market.js";

const session: SessionDef = activeSession() ?? { name: "US", source: "QQQ", startMin: RTH_MIN.start, endMin: RTH_MIN.end };
const { record } = await captureTick();
const cur = record.data;

console.log(`CAPTURE OK  ${record.capturedAt}  [${session.name}]  altaris_spot=${cur.spot}  regime=${cur.gex_regime}`);
console.log(`  named: call_wall=${cur.call_wall} put_wall=${cur.put_wall} major_wall=${cur.major_wall} max_pain=${cur.max_pain} zero_gamma=${cur.zero_gamma}`);
if (record.iv) console.log(`  iv: ${record.iv.current_iv} (start ${record.iv.session_start_iv}, ${record.iv.direction}) — ${record.iv.vanna_note}`);

const bars = await fetchSessionBars(session);
const src = session.source === "NQ=F" ? "NQ→QQQ" : "QQQ";
console.log(`\nMARKET OK  ${session.name} bars=${bars.length} via ${src}` + (bars.length ? `  range ${Math.min(...bars.map((b) => b.low)).toFixed(2)}..${Math.max(...bars.map((b) => b.high)).toFixed(2)}` : ""));
if (session.name === "Asia") console.log(`  live QQQ-equiv spot (from NQ): ${(await liveQqqEquivSpot()).toFixed(2)}`);

const strikes = [cur.call_wall, cur.put_wall, cur.major_wall, cur.max_pain, cur.zero_gamma, cur.vol_trigger];
console.log("\nDETECTOR (named levels vs OHLC wicks):");
for (const d of detectMany(bars, strikes)) {
  const pct = d.reversalPct ? `  (${(d.reversalPct * 100).toFixed(2)}%)` : "";
  console.log(`  $${String(d.strike).padEnd(8)} ${d.side.padEnd(11)} ${d.outcome}${d.resolvedAt ? "  @" + d.resolvedAt : ""}${pct}`);
}
