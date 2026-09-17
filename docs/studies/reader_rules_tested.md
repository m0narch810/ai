# READER RULES, TESTED ON 2022-23 (7,348 filled contacts) — BE: r15→80 15.8%, r40→80 33.3%

## 0. FILL TIMING (the grader fills any time after the touch)
  fill within 1 min 13% · ≤5 37% · ≤30 75% · >60 min 13% · median 10 min
  fresh (≤5 min): r15→80 12.8% · r40→80 28.5% · pnl40@close  -2.4 · n=2705
  late  (>5 min): r15→80 12.4% · r40→80 23.1% · pnl40@close  -0.7 · n=4643
  late (>60 min): r15→80 10.5% · r40→80 17.3% · pnl40@close  -5.2 · n=955

## 1. STANDING vs FRESH wall (named levels only; the level's own value unchanged over 60 min vs changed within 15 min) — fresh fills
  standing ≥60 min: r15→80 16.7% · r40→80 28.2% · pnl40@close  +0.6 · n=234
  moved in last 15: r15→80 10.4% · r40→80 23.0% · pnl40@close  -8.9 · n=318
  all named:        r15→80 11.3% · r40→80 26.5% · pnl40@close  -3.9 · n=1032
       pwall standing r15→80 15.2% · r40→80 24.2% · pnl40@close -13.8 · n=33 | moved15 r15→80 11.2% · r40→80 23.6% · pnl40@close  -6.4 · n=89
       cwall standing r15→80 11.4% · r40→80 22.9% · pnl40@close  -6.1 · n=35 | moved15 r15→80 13.0% · r40→80 35.2% · pnl40@close  +2.1 · n=54
       major standing r15→80 18.8% · r40→80 31.2% · pnl40@close  +4.9 · n=64 | moved15 r15→80  9.6% · r40→80 19.1% · pnl40@close  -9.7 · n=94

## 2. ONE-SIDED BOOK: call wall absent (no positive-gamma strike above spot) at a SUPPORT contact — fresh fills
  cw absent: r15→80  9.3% · r40→80 23.4% · pnl40@close -15.3 · n=205
  cw present: r15→80 11.1% · r40→80 28.5% · pnl40@close  -1.1 · n=1220
  mirror — pw absent at resistance: r15→80 18.9% · r40→80 24.5% · pnl40@close  +9.9 · n=106 · pw present: r15→80 14.7% · r40→80 29.6% · pnl40@close  -2.5 · n=1174
  after 13:00, cw absent: r15→80 10.1% · r40→80 15.9% · pnl40@close -21.8 · n=69 · present: r15→80  8.9% · r40→80 21.7% · pnl40@close  +0.7 · n=337

## 3. SESSION-EXTREME contact (the touch is at/beyond the running HOD/LOD of the prior tick, i.e. a new extreme) — fresh fills
  new extreme: r15→80 13.4% · r40→80 28.5% · pnl40@close  -4.0 · n=1279
  inside range: r15→80 12.3% · r40→80 28.4% · pnl40@close  -0.9 · n=1426
  new extreme, 10:00-11:00: r15→80 11.3% · r40→80 23.7% · pnl40@close -18.0 · n=380 · new extreme 09:41-10:00: r15→80 14.9% · r40→80 35.0% · pnl40@close  +8.4 · n=417 · new extreme 11:00-14:00: r15→80 15.1% · r40→80 28.3% · pnl40@close  -2.7 · n=258

## 4. OPENING WINDOW — fresh fills
  09:41-10:00: r15→80 14.4% · r40→80 33.0% · pnl40@close  +1.6 · n=800
  10:00-10:30: r15→80 11.6% · r40→80 27.7% · pnl40@close  -6.5 · n=524
  10:30-12:00: r15→80 13.7% · r40→80 28.9% · pnl40@close  -6.0 · n=495
  12:00-14:00: r15→80 11.0% · r40→80 27.6% · pnl40@close  -1.2 · n=283
  14:00-15:00: r15→80 14.4% · r40→80 31.4% · pnl40@close  -1.7 · n=341
  15:00-16:00: r15→80  8.8% · r40→80 12.6% · pnl40@close  -1.7 · n=262

## 5. RETEST OF A LEVEL BROKEN EARLIER TODAY (same K, opposite side, that earlier contact filled and hit the 15 stop) — fresh fills
  retest: r15→80 12.5% · r40→80 28.3% · pnl40@close  -0.6 · n=959
  not:    r15→80 13.0% · r40→80 28.6% · pnl40@close  -3.3 · n=1746
  retest WITH the day's direction (support on an up day): r15→80 13.5% · r40→80 28.6% · pnl40@close  -0.0 · n=779 · AGAINST: r15→80  8.3% · r40→80 26.7% · pnl40@close  -3.3 · n=180

## 6. FROZEN IV WALLS lower vs upper — fresh fills
   ivl_in_frz: r15→80 18.5% · r40→80 33.3% · pnl40@close  +4.2 · n=54
  ivl_out_frz: r15→80 16.7% · r40→80 33.3% · pnl40@close -11.2 · n=48
   ivu_in_frz: r15→80  6.1% · r40→80 28.6% · pnl40@close -12.7 · n=49
  ivu_out_frz: r15→80 20.6% · r40→80 35.3% · pnl40@close -11.1 · n=34
       ivl_in: r15→80  5.1% · r40→80 13.9% · pnl40@close  +4.3 · n=79
       ivu_in: r15→80  3.0% · r40→80 18.2% · pnl40@close  +6.8 · n=33

## 7. WALL STEP-AWAY: put wall stepped DOWN in the last 15 min at a support contact (book chasing price) — fresh fills
  pw stepped down: r15→80 12.1% · r40→80 26.0% · pnl40@close -16.3 · n=173 · pw unchanged: r15→80 10.2% · r40→80 25.4% · pnl40@close  -3.0 · n=637 · pw stepped up: r15→80  8.2% · r40→80 26.0% · pnl40@close  +1.0 · n=196
  cw stepped up at resistance: r15→80  7.3% · r40→80 17.7% · pnl40@close -28.4 · n=96 · unchanged: r15→80 15.1% · r40→80 27.9% · pnl40@close  -2.0 · n=531 · stepped down: r15→80 13.7% · r40→80 24.2% · pnl40@close -10.2 · n=153

## 8. CONCENTRATION: contact at the major when c1 ≥ 0.45 (pin) — fresh fills
  c1≥0.45: r15→80 11.1% · r40→80 22.2% · pnl40@close  +7.7 · n=27 · c1<0.30: r15→80 11.2% · r40→80 24.7% · pnl40@close  +0.3 · n=170

## 9. IV × side on fresh fills (replication)
  support: rising r15→80  9.6% · r40→80 23.1% · pnl40@close  -8.3 · n=467 · flat r15→80  9.9% · r40→80 30.4% · pnl40@close  +4.5 · n=283 · falling r15→80 12.0% · r40→80 29.9% · pnl40@close  -2.8 · n=675
  resistance: rising r15→80 16.3% · r40→80 32.5% · pnl40@close  -2.5 · n=412 · flat r15→80 17.1% · r40→80 28.0% · pnl40@close  -4.1 · n=321 · falling r15→80 13.0% · r40→80 27.4% · pnl40@close  +0.8 · n=547

## 10. AFTERNOON IV SPIKE ≥ +4 vol pts (14:00-14:30) then short? — day-level: does price fall ≥2 pts within 90 min (reader 6)
  days with a +4 vp spike 14:00-14:30: 140 · price fell ≥2 pts by 15:30 on 34 (24%) · base (any day, from 14:15): 9% (n=415)
