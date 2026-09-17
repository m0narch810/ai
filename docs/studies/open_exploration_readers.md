# THE READERS — seven agents, 84 daily tapes, no hypotheses given (2026-09-17)

Each agent read 12 full tapes from `data/study/tapes/` (5-minute book/IV/price state plus the day's
contacts and their 15- and 40-stop outcomes). **Sample caveat: a selection bug gave every reader
the first 12 of every 7th file, so all 84 days are January–July 2022** — a bear market with ATM IV
40–100% and E0 150–340 MNQ. Nothing here was seen from 2023 or 2024. Their counts are hand counts on
those days; the programmatic test of each claim on all of 2022-23 is in `reader_rules_tested.md`.

## What all seven saw independently
1. **The 15-MNQ stop is inside the wick of a real turn.** Every reader listed 14–29 contacts per
   12 days that the 15 killed and a 40 turned into 100–700-MNQ runs; measured overshoot of a turn
   past its strike was 0.2–1.0 QQQ pts (median ≈0.5 = 20 MNQ). On the highest-vol days nothing at
   all survived 15. (Programmatic: 84% of fills hit 15 before the close, half within 5 minutes.)
2. **The best turns print IN FRONT of the strike and never fill.** "Touched, did not trade
   through" contacts were the session extreme on 7–10 of 12 days for every reader (e.g. 2022-02-02
   370 = HOD 369.92 and 364 = LOD 364.31; 04-27 315 = LOD 315.17; 05-31 304 = LOD 304.34). The
   orders that filled were the ones that got overshot. Three readers proposed entering 0.25 in front.
3. **The live 19Δ IV walls are not levels.** Start equal to the frozen bracket, ride spot 1:1,
   shrink ~4x by the close, only get touched after 15:00. 0–3 of 9 fills survived, all late-day.
4. **The frozen bracket is E0 restated** (half-width 0.87–0.92 E0 on every day) and marked the
   day's extreme on range days (6 of 9, 8 of 12, 7 of 12, 8 of 12 by reader) while being run on
   trend days. Which side worked disagreed: reader 2 lower 3/4 vs upper 0/4; reader 4 upper
   inner 5/5 reactions; reader 3 outer best 4/6.
5. **Charm/vanna sums, the gamma flip, concentration: contemporaneous relabellings of where spot
   sits relative to the major.** The sums flip sign the line spot crosses the major; the flip is
   blank on negative-gamma days and flickers between adjacent strikes when present (0–3 of 10
   fills); c1 rises into the close on every day as gamma collapses onto ATM. Seven of seven.
6. **The walls re-anchor in tiers and lag price.** Flicker between two adjacent strikes when spot
   sits between them is window selection, not repositioning; the OI walls are the stickiest. Three
   readers noted a **wall stepping AWAY in the direction of the move (put wall stepping down on a
   decline, call wall stepping up on a rally) = continuation to the new wall** (5/5, 9/11, 8/9) and
   a **wall landing ON the price strike = fresh wall, fails** (2–3 holds vs 12 fails).
7. **ATM IV has the same daily shape every day**: falls from the open to a trough between 10:40
   and 13:25, drifts up, then goes vertical after 15:15 (dt→0). Any IV screen after ~15:00 is
   mechanical; "falling IV in the morning" is the default state, not information.
8. **The opening 20–40 minutes kill a 15 stop** (2–5 survivors of 40–75 contacts per reader), yet
   the opening-leg extreme WAS the day's extreme on 7 of 12 days (readers 3, 6) and a 40-stop fade of
   it after 10:00 ran ≥80 on 10 of 12 days (reader 3).
9. **Nothing in the book leads price by more than the one 5-minute line in which price crossed a
   strike.** (Reader 4's closing sentence; every reader said a version of it.)

## Where they disagreed
- **IV direction into the level.** Reader 1: falling-IV tops held 7+3 vs 1, rising-IV supports
  held. Reader 2: rising-IV lows held (8 of 9 lows printed on rising IV) but the exceptions to the
  falling-IV avoid rule were all pullbacks in a rally. Reader 3: NO separation on supports (4/16 vs
  4/17). Reader 5: 4 of 5 flat/falling-IV lows bounced vs 1 of 4 rising-IV lows — the opposite.
  Reader 6: 7 wins on falling-IV supports vs 3 on rising. Reader 7: supports 9/9 vs 8/25 favouring
  rising, resistances 14/18 vs 10/25 favouring falling. Net: the 2022 readers split three ways.
- **Gamma sign.** Reader 3: positive-gex days trended (5 of 6), negative chopped. Readers 4, 5, 6:
  no separation either way. Reader 1: negative-gex days were often pins.
- **With-the-drive.** Readers 3 and 4 found with-trend retest entries the only thing that worked on
  trend days (counter-trend 2 of 35); reader 6 found polarity retests at base rate (19 of 74) and
  could not identify the trend side in advance.

## Their candidate rules (each tested in reader_rules_tested.md / entry_variants_2223_report.md)
- R-A (readers 1,3,5,7): **fade / buy with a 40 stop, not 15**; stop should scale with E0
  (~0.12–0.15 E0).
- R-B (readers 3,6,7): **rest the order 0.25 in front of a heavy strike or frozen wall**, stop 40
  beyond the strike.
- R-C (reader 6): **rejection entry** — touched within 0.15 without trade-through, next 5-min bar
  closes ≥0.5 away → enter at that close, stop 15 beyond the strike (16 of 19 ran ≥100).
- R-D (reader 7): **stale-wall filter** — a named level unchanged ≥60 min holds, one that moved
  within 15 min fails.
- R-E (readers 2,3,4,7): **wall step-away = continuation target, do not fade toward the new wall**;
  call wall jump above spot while spot is still below the OLD wall = a top (reader 2: 5/1).
- R-F (readers 3,6): **call wall absent ("—") after 13:00 = no longs**.
- R-G (readers 1,2,4): opening-range extreme fade after 10:00, 40 stop; frozen lower inner wall on
  rising IV; spike-low bid (largest +Δ30 IV of the session so far, ≤12:30).
- R-H (reader 1): c1 ≥ 0.45 = pin at the major, nothing rests within ±1 pt of it.
- R-I (reader 6): afternoon IV spike ≥ +3 vp at 14:00–14:30 → ≥2-pt drop within 90 min (8 of 10).

## What the readers found that the numbers had not
- The contact/fill timing conflation (reader 4, 5, 1): the grader fills any time after the touch,
  so a 10:33 "contact" can fill at 15:45 and be "stopped @2m". Verified; see the tested file §0.
- The "vs open in E" column divides by E REMAINING (readers 2,4,5) — a display bug in the tapes,
  fixed in the reading by the readers, harmless to the parquet data.
- The tapes carry no prior close, so gaps could not be read (readers 4, 5).
