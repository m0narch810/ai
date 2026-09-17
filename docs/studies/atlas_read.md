# What the 0DTE options tape looked like at real reversals — an analyst's read

Source: `data/study/atlas_events.parquet` (1,681 turns that paid the 80-MNQ swing, 371 run-throughs of the day's
heaviest 0DTE gamma strikes; 665 days 2022-2024), read by eye from the 102-event sample in `atlas_sample.md`,
each impression then checked against the whole population. No rule was fitted; the numbers below are
descriptive checks of things seen in the ladders.

## 1. Positioning locates the fight. It does not decide it.
- Turns do not print at strikes: 22% within 0.10 pt of a whole strike (uniform = 20%).
- A local OI wall (≥2× the ladder's median OI on the defending side) sits within 1 pt of the event strike at
  34-38% of turns AND 38-39% of run-throughs. Identical. Wall proximity has no discriminating power.
- Turns sit ~1 pt IN FRONT of the nearest wall (bottoms: wall median 1 strike below; tops: 1 above). So do
  run-throughs. The wall is where price interacts; something else decides the outcome.
- The event strike is the ±3 local maximum of |GEX| at only 19-21% of turns (random ≈ 14%).
- On 0DTE, VEX is the same map as GEX (both ∝ φ(d1)): it adds nothing. Charm flow is positive at bottoms AND at
  downside run-throughs (63-69% vs 65-80%); its truth-table reading is structurally true and predictively empty.
- Vanna at the event strike is ≈ 0 (ATM). Its DRIVER — the IV change — is what discriminates (next section).

## 2. The decider is what implied vol does INTO the level.
| into the event, ATM 0DTE IV over the prior 30 min | share RISING >1 vol pt | share FALLING >1 vol pt |
|---|---|---|
| bottoms that held (n=862) | 53% | 23% |
| put strikes run THROUGH (n=179) | 17% | 53% |
| tops that held (n=819) | 27% | 51% |
| call strikes run THROUGH (n=192) | 7% | 67% |
By year the bottom/run-through contrast is 54/17 (2022), 41/15 (2023), 57/19 (2024): not a regime artefact.

Read: a low forms when the market is paying for protection into it. A put strike gets sliced when nobody is
scared — the move down is orderly, there is no vol bid to exhaust and no vanna/hedge bid to lean on. This is
ALSO why the desk's "vanna+ with falling IV defends supports" prior tested at 23% in the backtest: falling IV
into a support is the run-through signature, not the defence.
Upside mirror: a rally on falling IV grinds THROUGH call walls (vol crush = the vanna tailwind); a rally on
RISING IV is a squeeze spike and it tops (2022-09-21 152→192, 2023-03-13 +24 in 30 min, 2023-10-26 52→68,
2023-02-07 73→84, 2024-08-29 39→49).

## 3. Vol exhausts before price does.
At 45% of bottoms ATM IV had already come off its 60-min peak by >1 vol pt at the minute BEFORE the low
(median 0.8 pt). The last push into the low happens on IV rolling over: the puts are being sold into it.
Examples: 2022-05-25 (IV 108.9 at −10m → 105.1 at −1m, price low after), 2022-11-02 14:53 (158 → 122 in
30 min, then the low), 2022-05-06 (100.6 → 98.0), 2022-02-11 top (117 → 90 in 10 min).

## 4. Skew shape into the event.
Into a real low the downside wing's IV rises LESS than ATM (wing − ATM drift median −1.45 vol; 57% of
bottoms show the wing decompressing vs ATM by >1) — panic is in the front strikes, the tail is not being
re-priced. Into a run-through the wing stays relatively bid (−0.48; 40%) — the market keeps paying for more
downside, and gets it. Upside: at tops the put wing catches a relative bid (+1.82) — someone buying dip
protection at the high; weaker separation vs run-through-up (+1.26).

## 5. Late-day pins attract; the extreme prints in front of them.
Very large late charm/OI walls pull price toward them and the turn prints 1-4 pts short of the strike:
2022-02-04 15:13 top at 361.3 under the 365 wall (36k calls, +412/hr charm); 2024-08-29 15:38 top at 472.45
under 473 (32k calls, +1358/hr). The pin itself is not touched.

## 6. Time of day.
26% of turns are in the 10:00 hour; run-throughs are morning events (median 345 min to close vs 235 for
turns). The 09:45-10:30 window is where the day's first structure is resolved either way.

## What this means for the live desk
Stop reading the size of the wall. Read the vol tape into the wall: ATM 0DTE IV direction over the last
15-30 min, whether it has rolled over in the last 5-10 min, and whether the front strikes are bidding up
faster than the wing. A put wall with IV rising into it and rolling over = the low; a put wall reached on
falling IV = a pass-through. A call wall reached on a vol crush = a pass-through; on rising IV = a spike top.
The terminal already polls /net_iv and /expected_move every 60 s in RTH — the missing panel is an
"IV into level" tape, not another exposure ladder.

Caveats: 0DTE-only positioning; per-strike IV is parity-averaged (no put/call split); events were selected by
price outcome (this is a description of what reversals looked like, not a forecast test); the IV-rising-into-
lows signature is partly the ordinary spot-vol correlation — the CONTRAST with run-throughs, where price was
also falling but IV was not rising, is the finding.
