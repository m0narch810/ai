# PRECISE-TOUCH LEAD-UP — what the two hours before a precise reaction have in common (2026-09-17)
Script `scripts/study_precise_leadup.py` (build / analyse / dossiers). Raw tables: `precise_leadup_report.md`,
`precise_leadup_nullcheck.md`. Data: 3,473 resolved whole-strike touches on the live feed 07-20 → 09-17
(1,229 precise, 693 good = +80 first with ≤10 MNQ overshoot, 2,244 failed), NQ 5-min converted, the desk's
YYY captures (per-strike gex/charm/vanna/theta/vega/delta/OI/volume/IV + whole-book context: ATM IV, EM,
regime, flip, walls, HIRO, entropy, Hurst, GARCH, regime vote, risk reversal, level assessment).
87 lead-up features: price path (move into the level over 15/30/60/120 min, efficiency, ranges, last bar,
volume), session (prior-day H/L/C, open, overnight H/L, session extreme, earlier touches), whole book, and the
strike neighbourhood (band-relative share, rank, vs neighbours, strikes behind vs in front, 60-min changes).

## 1. Programmatic: nothing separates precise touches from failed ones
- **Classifier** (gradient boosting, trained on one half, scored once on the other, 30 shuffled-label nulls):
  everything AUC 0.503 / 0.501 (null max 0.539); price/session only 0.496 / 0.503; book only 0.527 / 0.527
  (null max 0.537 / 0.535). No combination of the 87 features beats shuffled labels.
- **Unconditional rates**: new session extreme 32.8% / 36.6% vs inside the range 34.6% / 37.1%; moved into
  the level over the last hour 34.1% / 39.1% vs came back 34.4% / 34.6%; earlier other-side touches 0 / 1-2 / 3+
  all 33-38%. Within-day Mantel-Haenszel odds ratio for "new session extreme": 1.06 / 1.11.
- **Matched pairs looked strong and were an artefact.** Pairing each precise touch with the nearest failed
  touch the same day showed precise touches much closer to the session extreme (share 0.19), after a steady move
  into the level (0.66), with less option volume behind the level (0.36) — same sign in both halves, p<0.001.
  Shuffling labels within the day took it to 0.50, but forcing the pairs ≥2.5 h apart took it to 0.40 / 0.52 /
  0.45: the failed partner's two-hour window contained the precise touch's own 40-point run (and vice versa).
  Nothing survives once the windows cannot overlap.

## 2. AI readers: four agents read 48 precise reactions only (explore half, 28 RTH / 20 Globex)
Dossiers: `data/study/dossiers/precise/P00-P47.txt` — 24 five-minute bars before the touch, session references,
every book capture in the prior two hours, and the level ±3 strikes on eight measures now and 60 min earlier.
All four converged on the same picture, independently:
- **The level had already traded that session** (touched or crossed, then came back): 10/12, 11/12, 11/12, 12/12.
- **Mass next door:** a heavy multiple-of-5 strike (largest |gamma|, |theta| or OI in the seven rows) is the level
  or 1–2 strikes away; the level itself is usually the lighter strike just in front of or just past it. 10/12, 10-11/12, 12/12, and reader 1 split 3 at-the-wall / 9 beside it.
- **The gamma flip or a wall within 1–2 points** at some capture in the prior two hours: 8-10/12 each.
- Reader 1 also: in RTH the band's highest-option-volume strike is the level or 1–2 strikes on the approach side.
- Common but probably base rate: HIRO BALANCED, hedged regime vote, negative risk reversal, small own charm/vanna/vega (ATM by construction).
- Things that clearly VARY: session, side, gamma regime, IV level and direction, approach speed and shape, time of day, Hurst, entropy.
- Data faults they flagged: the "ATM IV vs open" field always reads 0.00; strike IV blows out on stale Globex books;
  several dossiers share one book (overnight touches on the same prior close).

## 3. The readers' recipes tested against all 3,473 touches (`reader_pattern_test.md`)
How often each trait appears among precise vs failed touches:
| trait | precise | failed |
|---|---|---|
| heavy $5 gamma strike at the level or ±1 | 39.4% | 40.2% |
| heavy $5 theta strike at the level or ±1 | 55.2% | 57.8% |
| heavy $5 OI strike at the level or ±1 | 44.5% | 46.5% |
| level already traded today | 85.6% | 84.6% |
| mass (≥50% band gamma or ≥70% OI) within ±2 | 85.3% | 84.5% |
| wall or flip within 2 in the prior 2 h | 82.1% | 80.5% |
| flip within 1.2 in the prior 2 h | 45.6% | 46.1% |
| busiest-volume strike at the level or 1-2 on approach | 39.8% | 38.6% |
The traits the readers saw in precise touches are just as common in failed ones. Recipe precise rates (explore | confirm):
- reader 2 (gamma heavy-5 ±1 + ≤3 from flip + approach shape): 31.8% vs 34.9% | 39.0% vs 36.5%
- reader 3 (theta heavy-5 ±1 + touched inside the range + flip side): 32.0% vs 35.2% | 36.5% vs 37.2%
- reader 4 (tested + mass within ±2 + wall/flip within 2): 35.0% vs 33.1% | 37.8% vs 35.2%
- reader 1 (tested + flip within 1.2 + busiest strike at/approach side): 34.8% vs 34.1% | 38.5% vs 36.6%;
  **RTH only: 34.8% vs 30.0% | 42.5% vs 33.4%** — the one same-sign lift (+5 / +9), but the +80 rate is flat
  (21.3 vs 17.7 | 20.2 vs 19.8), it is one of several cuts, and the explore half contains the 12 dossiers it came from. A lead only.

## 4. Blind test: an AI given the readers' findings sorts 40 unlabeled dossiers (confirm half, 20/20)
Scored against `blind_key.csv` (`blind_test_result.md`). **On features: 11 of 29 right (38%)** — 2/6 on the calls
it made from features alone, and 9/23 on its features-only first pass, written before it noticed the leak below.
The readers' strongest trait (already-traded level / retest) pointed the WRONG way in its read (6 retests, 6 failed).
**Overall 32/40, but only through leakage the test design allowed:** same-day dossiers overlap in time, so one
dossier's lead-up bars show what happened after another's touch (18/20 on those calls), and the one-precise-one-
failed-per-day-and-side pairing gives away each partner (12/14). A clean re-run would need one dossier per day and side.
Also flagged: `prior_same_side_precise` counts earlier touches whose outcome resolved AFTER the current touch — a
hindsight leak in that one feature (it sat in the classifier, AUC still 0.50; reader 2's "≥2 earlier precise
reactions" condition and the 30.8% vs 24.6% gap in `reader_pattern_test.md` should be disregarded).

## Bottom line
Looked at from only the precise side, precise reactions share a clear picture: a level already traded that session,
heavy gamma / theta / OI at a round strike on or next to it, the gamma flip or a wall close by. **Failed touches share
exactly the same picture in the same proportions** — at the strike, in the whole book, and in the price approach —
because that picture is simply what the tape looks like wherever price is trading. No programmatic cut, no classifier
over 87 features, and no AI reading told them apart from the two hours before. The one same-sign lead: reader 1's
recipe in RTH (tested level + flip within 1.2 + busiest option-volume strike at the level or 1-2 on the approach side)
34.8% vs 30.0% and 42.5% vs 33.4% on +40, flat on +80. Untested out of sample; not encoded.

## 5. Recipe × IV into the level (RTH, `recipe_x_iv.md`)
Recipe with supports-on-falling-IV removed: 36.9% / 43.4% precise vs no recipe 30.0% / 34.0% (+7 / +9 pts);
+80 rate 22.6% / 21.1% vs 17.9% / 20.2%. Inside the recipe, supports on falling IV drop to 20.0% / 33.3%, and
resistances on falling IV also drop (25.0% / 30.3%) — that second cut was not pre-registered. Confirm-half 95%
intervals [37.1-49.9] vs [29.4-39.0] just overlap. "Precise" counts touches that never traded through, so these are
reaction rates, not fill P&L; grading as real limit fills is the next step before any rule.

## 6. The recipe as real trades (`scripts/study_recipe_fills.py`, `recipe_fills_report.md`)
Limit at the strike, trade-through fill within 30 min, 15-MNQ stop, stop wins a shared bar, 1 MNQ/round trip, RTH.
Net MNQ per trade (explore | confirm, confirm also at 1-min):
| group | trades/day | +40 target | +80 target | let it run (BE after +40, out 15:55) |
|---|---|---|---|---|
| all RTH touches | 41 / 28 | −3.6 \| −1.4 (−0.7) | −1.3 \| −1.3 (−0.8) | −0.4 \| −6.0 (−5.8) |
| recipe | 12 / 11 | −3.2 \| +1.9 (+2.8) | −0.5 \| −0.7 (+1.0) | −2.5 \| −3.5 (−2.2) |
| recipe minus supports on falling IV | 10.5 / 9.8 | −2.3 \| +2.2 (+2.9) | +0.5 \| −0.0 (+1.4) | −2.7 \| −2.8 (−2.3) |
| no recipe | 30 / 17 | −3.8 \| −3.5 (−3.0) | −1.6 \| −1.7 (−2.0) | +0.5 \| −7.5 (−8.1) |
| supports on falling IV | 5 / 2 | −6.3 \| −5.3 (−4.4) | −6.0 \| −9.0 (−8.5) | −4.6 \| −12.2 (−7.5) |
The recipe beats no recipe in both halves on the +40 target (by 1.5 and 5.7 MNQ/trade), and the IV screen adds ~1 more;
supports on falling IV are the worst trades in every column. But it is net positive only in the confirm half (+2.2 to
+2.9 on ~10 trades/day, 21 days), negative in the half the recipe was found in, and letting winners run loses in every group.
