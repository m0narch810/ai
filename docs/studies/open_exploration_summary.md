# OPEN EXPLORATION — "everything, as wide as possible, for a 15-point stop that lets winners run"
2026-09-17. User brief: look for things rather than confirm things; every feature and its change over
time; the objective is limit orders at levels with a 15-MNQ stop and no fixed target.

## Data layer (new, reusable)
- `scripts/study_state_tape.py` → `data/study/state_tape_222324.parquet` (50,944 rows: every 5 minutes
  of 665 sessions 2022-24: spot, E to close, ATM IV, Δ15/Δ30 IV, off-peak, the 0DTE flip / major /
  call+put gamma walls / call+put OI walls, live 19Δ IV walls + the open-frozen ones, concentration
  (share of |gamma| in the top 1 / top 3 strikes), net gex / charm / vanna / dex / vex sums, a 2%-wing
  skew proxy, HOD/LOD/open distances — plus within-day Δ5/Δ15/Δ30/Δ60 of every level and sum) and
  `contacts_222324.parquet` (14,828 first contacts: plain whole strikes ±1% and every named level, with
  the state at the last tick before contact and an outcome ladder: for stops 10/15/20/30/40 MNQ —
  survived to the close?, max favourable run before the stop, reached 20/40/80/120/200 before the stop?,
  time to stop, P&L at close, and a breakeven-rule P&L for 10/15/20).
- `scripts/study_state_explore.py` → `state_explore_2223.md`: stop ladders, every cut, a sweep of ~150
  features × quantile bins against run15→80 / survive-15 / breakeven-P&L with a 2022-vs-2023 sign flag,
  and event-aligned profiles (−60…+30 min) around the 1,025 atlas turns and 237 run-throughs.
- `scripts/render_tapes.py` → `data/study/tapes/<date>.txt` (665 human-readable daily tapes, 5-minute
  rows + the day's contacts and outcomes) — what the seven reader agents worked from.
- The QQQ 1-min file the user supplied (`data/QQQ_raw_1min.parquet`, 2002-2026) was checked and NOT
  used for grading: from 2022-03 it is IEX-only prints (median 500-1,500 shares/min ≈ 2% of the tape),
  its bar ranges are 35-45% narrower than the NQ-converted consolidated range, 1-9% of bars are
  zero-range, and prices are dividend-adjusted (factor 1.028 in 2022 → 1.008 late 2024). It would miss
  touches and trade-throughs at exact strikes. NQ 1-min converted through a rolling ratio stays the grader.

## What the numbers say (2022-23 in-sample, 7,348 filled contacts ≥15 min to close)
**The 15-point stop.** 84% of fills hit a 15-MNQ adverse excursion before the close; half of those
within 5 minutes, 72% within 15. Only 12.6% run 80 before the 15 (break-even for 15/80 is 15.8%);
25.5% run 40 (break-even 27.3%). With a 40 stop: 25% run 80 (BE 33%). Every stop from 10 to 40 and
every run target from 20 to 200 sits at or slightly below its own break-even. The breakeven rule
(15 stop, move to breakeven after +40, exit at close) averages +0.2 MNQ per fill. Named levels (flip,
walls, OI walls, IV walls) are no better than plain strikes on any stop.

**It is a volatility-scaling problem, not a level problem.** The single strongest feature in the whole
sweep is E itself. A fixed 15-point stop is 0.25E on a quiet day and 0.06E on a wild one:
| E to close (MNQ) | 15 stop as E | run15→40 (BE 27) | run15→80 (BE 16) | run40→80 (BE 33) |
| <80 | 0.25E | 19% | 5% | 7% |
| 80-120 | 0.15E | 23% | 12% | 23% |
| 120-180 | 0.10E | 28% | 16% | 32% |
| >180 | 0.06E | 32% | 15% | 33% |
On quiet days a 15-point stop is inside the noise and loses badly; on big days it reaches break-even.
Every other "top" feature in the sweep (IV-wall width, distance to the outer walls, distance to LOD,
minutes to close) is a proxy for E. Nothing else moved run15→80 by more than ~6 points on a 12.6% base,
and those that did were mostly single-bin wobbles.

**The winners are big but not kept.** Of the 923 fills that ran 80 before a 15 stop, the median
maximum run was 136 MNQ (75th 177, 90th 255), but only 51% were still ≥80 at the close: letting it
run to the bell gives back half. In E units, the median 15-stop trade runs 0.17E before it dies;
19% reach 0.5E and 8% reach 1E.

**Event profiles confirm the earlier read and add two things.** Into a bottom, ATM IV rises ~2 vol
points over the prior hour and net dealer gamma gets steadily more negative (−0.5 → −1.0 of its value
at the low), then recovers. Into a top, IV falls and the downside skew steepens (0.07 → 0.10). Into an
UP run-through, IV falls hard (+2.2 → 0 → −1.5 after) and net gamma turns positive as it goes. Into a
DOWN run-through, IV falls too (the mirror of the bottom). The live 19Δ IV walls sit at a constant
+0.86E / −0.91E from spot in every class at every offset: they ride price and carry no information
about where it turns. Concentration (c1, c3), charm and vanna sums are flat across every event class.

**Time.** In the last hour, a 15-stop survives more often (41%) only because there is no time left to
hit it; run15→80 is 6%. Supports in the last two hours are the worst cell (4-6%).

## Reader agents (seven, 84 sessions, no hypotheses given)
`open_exploration_readers.md` has the synthesis. A selection bug gave every reader the first 12 of
every 7th file, so all 84 days are Jan–Jul 2022 (bear market, IV 40–100%). Seven of seven saw the
same four things: the 15 stop is inside the wick of a real turn; the best turns print IN FRONT of
the strike and never fill; the live IV walls, the flip, the charm/vanna sums and concentration are
relabellings of where spot sits; the book re-anchors in tiers and lags price. They split three ways
on IV direction into the level and could not agree on gamma sign.

## What the readers caught that the numbers had missed
**The grader fills any time after the touch.** A "contact" at 10:33 can fill at 15:45 and be graded
"stopped 2 minutes later" — a resting order does behave that way, but the state features belong to
the touch, not the fill. Verified on 2022-03-16 338.34 and 2022-05-25 290. Every study in this family
(the 2025 forward test, the 2022-24 approach test, this one) shares the definition. On 2022-23:
37% of fills come within 5 minutes of the touch, median 10 min, 13% after an hour. Fresh (≤5 min)
fills: run15→80 12.8%, run40→80 28.5%; late (>60 min): 10.5% / 17.3%. Fresh fills are slightly
better, still below break-even.

## Candidate rules from the readers, tested on all of 2022-23 (`reader_rules_tested.md`, `entry_variants_2223_report.md`)
| rule | result |
|---|---|
| use a 40 stop, not 15 | 40 catches 28.5% to 80 (BE 33.3) vs 15's 13.8% (BE 15.8): both below their own break-even; P&L at close −0.5 vs −0.8 MNQ/fill |
| rest the order 0.25 IN FRONT of the strike (readers 3,6,7) | fill rate 60% → 79%; run→80 before a 40 stop beyond K 30.8% (BE 38.5); P&L at close −0.5. More fills, same zero |
| rejection entry: touched, no trade-through, next 5-min close ≥0.5 away (reader 6) | 171 events, 24% run 80 but the risk from entry averages 59 MNQ (BE 43%); −18 MNQ/fill. Worst variant |
| stale wall holds, fresh wall fails (reader 7) | named level unchanged 60 min: 16.7% / 28.2%, moved within 15 min: 10.4% / 23.0% (n=234/318). Same sign, small, most of it at the major (18.8 vs 9.6) |
| call wall absent at a support (readers 3,6) | 9.3% vs 11.1%; P&L −15 vs −1 MNQ (n=205). Same sign, small |
| call wall stepped UP in the last 15 min at a resistance (readers 2,7: continuation) | 7.3% / 17.7%, −28 MNQ/fill (n=96) vs unchanged 15.1% / 27.9%. The clearest "don't fade" tell, small n |
| put wall stepped down at a support | 12.1% / 26.0%, −16 MNQ (n=173): weakly worse |
| session-extreme touch, opening-range fade (readers 1,3,5) | new extreme 13.4% vs inside 12.3%: nothing. 09:41–10:00 is the best window on the 40 (33.0%, +1.6) and the worst on the 15 |
| retest of a level broken earlier today (readers 3,4,6) | 12.5% vs 13.0%: base rate. With the day's direction 13.5%, against 8.3% (n=180) |
| frozen lower walls > upper (reader 2) | lower inner 18.5% / 33.3% vs upper inner 6.1% / 28.6% at fresh fills (n=54/49); equal on the 40. Bear-market skew geometry, unconfirmed |
| c1 ≥ 0.45 pin at the major (reader 1) | 11.1% vs 11.2%: nothing |
| IV × side at fresh fills | supports 9.6 / 9.9 / 12.0 (rising/flat/falling), resistances 16.3 / 17.1 / 13.0: the 2025 direction on resistances, the opposite on supports, all near base |
| afternoon IV spike ≥ +4 vp at 14:00–14:30 → ≥2-pt drop by 15:30 (reader 6) | 24% of 140 days vs 9% base from 14:15. A 2.7× lift on a day-level event, not E-scaled, untested out of sample |

## Bottom line
Across 14,828 contacts, seven readers and every entry variant they proposed, the resting-order
result at any level is a random walk priced at its own break-even: the 15 stop dies 84% of the
time, the 40 stop 68%, in-front entries fill more and earn the same zero, and the winners that do
run give half back by the bell. Three weak directional tells survived every cut with the same sign
(a wall that just relocated, a call wall stepping up into a rally, a one-sided book) and one
day-level lead (the afternoon IV spike) — all small-n, all in-sample, none encodable as a rule
yet. The only lever that actually moves the numbers is volatility scaling: a stop must be a
fraction of E, and 15 MNQ is only that on a very wide day.
