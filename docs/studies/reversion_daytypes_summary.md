# REVERSION CONSISTENCIES — summary (2026-09-17)

Scripts: `scripts/study_reversion_daytypes.py` (2022-23 in-sample, 2024 holdout read once),
`scripts/study_live_churn.py` (the live cloud captures Jun 22 – Sep 17 2026 × the desk's own grades).
Files: `reversion_2223_report.md`, `reversion_2024_holdout.md`, `reversion_2025_check.md`, `live_churn_report.md`.

## What replicated (in-sample → holdout → 2025)
- **Reaction ladder.** Of filled approaches, 70% react ≥20 MNQ, 47% ≥40, 26-27% ≥80 (2022-23 and 2024 identical).
  Given a 20-MNQ reaction, 36-38% go on to the 80 and 43% get stopped. A 20-point bounce that then runs
  is the MODAL outcome of a resting order, not a failure of the level.
- **Every bracket sits at its break-even.** 20/40 → 33%, 40/40 → 50-51%, 40/80 → 31-32%, 80/80 → 49-51%,
  80/160 → 23-25%, all periods. Expectancy −2 to +1 MNQ per fill before costs. No bracket rescues a level.
- **Ladder churn does not matter, and tenure does not help.** The top-|gex| strike in the ±1% band changes
  ~19 times a day (median run 4 min). Hold rate is flat across churn buckets (30-34%) and across tenure
  buckets. In-sample the TOP strike itself held worse (24.8% vs 33.6%, n=796); on the holdout that
  vanished (31.5 vs 30.3). Isolation (no other heavy strike within 0.5E): 27.2% vs 33.3% in-sample,
  27.9% vs 31.2% holdout — weak, same sign, CI-overlapping. Not a rule.
- **Day type by 10:30 barely moves the hold rate** (drive, range, IV change, gap, gamma sign, churn,
  cluster count: all 31-35%). Chop days (range ≤1E, |close−open| ≤0.5E, 13% of days) are predictable
  only by a NARROW first hour (0.5-0.8E range → 22% chop; >0.8E drive → 0%), but approaches on chop
  days hold no differently (30.6 vs 32.0).

## The one effect that did NOT survive cleanly: "trade with the drive on a strong morning"
- First-hour drive >0.8E (≈9% of days; the day closes in the drive direction 85-95% of the time):
  2022-23 WITH the drive 49.4% (+19.8 MNQ, n=135) vs AGAINST 18.0% (−12.9, n=137);
  2025 WITH 52.3% (+20.9, n=75) vs AGAINST 18.8% (−13.2, n=63);
  **2024 WITH 29.3% (−2.8, n=161) vs AGAINST 35.1% (+5.8, n=145) — reversed.**
  At 0.5-0.8E: 2024 WITH 35.3 vs AGAINST 25.0; 2022-23 33 vs 31; 2025 36 vs 31.
  Two of three periods say "never fade a >0.8E morning drive"; the grind-up year says the opposite. This is
  regime-dependent, not a rule; it is recorded, not encoded.

## Live feed (what the terminal actually shows, 43 YYY days)
- The NAMED walls do not change every few minutes: call/put wall change on ~5% / 3% of captures, median
  tenure 10-15 captures (2.5-4 h), ~2 distinct values a day. Most changes land 10:00-12:00.
- What DOES churn: `vol_trigger` changes on 67% of captures, has ~22 distinct values a day, and is the
  spot strike 54% of the time (in negative gamma the flip rides ATM by construction). The 0DTE ±1σ,
  expected move, VWAP, HOD/LOD confluence and the sliding-window vanna/charm walls move with every tick
  too. The call wall sits within 0.25 EM of spot on 35% of captures, the put wall 28%.
- Desk grades vs wall tenure: post-Aug-15 sample is 51 resolved touches — too small to say anything.

## Bottom line
Nothing new beats ~31-33% on 40/80 in a way that survives the holdout. The three things that hold across
every cut are: the IV screen's one avoid rule (put-side on falling IV), the reaction ladder (expect 20,
not 80), and that no bracket or day type changes the base rate. The "with-the-drive" read is worth a
glance on a >0.8E morning but was wrong in 2024.
