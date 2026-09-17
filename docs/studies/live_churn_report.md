# LIVE WALL CHURN — 62 days, 2051 RTH captures (36/day median), 2026-06-22 → 2026-09-17

## Q1 how often each published level changes between consecutive captures (per day, then median across days)
           field  provider  days  distinct/day  chg%/tick  med tenure (ticks)  |x−spot|/EM med  ==spot strike%
       call_wall   altaris    17           2.0          4                14.0             1.00               2
        put_wall   altaris    17           2.0          7                 7.0             0.75               1
     vol_trigger   altaris    17           4.0         19                 2.0             0.14              22
        max_pain   altaris    17           1.0          0                27.0             2.07               0
  call_wall_0dte   altaris    17           2.0          7                 7.0             0.42               2
   put_wall_0dte   altaris    17           2.0         11                 5.5             0.39               3
         top_gex   altaris    17           2.0          7                11.0             0.42               3
       call_wall       yyy    43           2.0          5                10.0             0.38               9
        put_wall       yyy    43           2.0          3                15.0             0.47               7
     vol_trigger       yyy    43          22.0         67                 1.0             0.00              54
        max_pain       yyy    43           2.0          5                16.0             0.30              10
  call_wall_0dte       yyy    43           2.0          5                10.5             0.40               6
   put_wall_0dte       yyy    43           2.0          5                12.0             0.38               8
         top_gex       yyy    43           2.0          5                16.0             0.31              10

### share of call/put wall changes by hour (yyy era)
     call_wall: 09h 10% · 10h 21% · 11h 21% · 12h 11% · 13h 12% · 14h 12% · 15h 13%
      put_wall: 09h 12% · 10h 22% · 11h 18% · 12h 13% · 13h 16% · 14h 7% · 15h 13%
   vol_trigger: 09h 6% · 10h 17% · 11h 15% · 12h 15% · 13h 17% · 14h 14% · 15h 15% · 16h 1%

### the ATM-riding pattern (yyy era): fraction of captures where …
  call_wall == vol_trigger: 8% · call_wall within 0.25 EM of spot: 35% · put_wall within 0.25 EM: 28% · call_wall_0dte == put_wall_0dte: 0%
  call_wall ABOVE spot: 71% · put_wall BELOW spot: 72%

calibration: 257 touched strikes over 70 days; outcomes {'pending': 40, 'broke': 147, 'reversed': 46, 'retested': 24}

## Q2 does a wall's TENURE before the touch predict the detector's grade?
   tenure = consecutive captures (≈15 min each) the strike held the side-matched title right before touchedAt; 'at touch' = it was the wall on the last capture before the touch
   158 touched+resolved detector strikes with a capture history

### base rate by era (detector grades)
                               group  touched  reversed  broke  hold%
                   post-0815 (40/80)       51        27     24     53
                  pre-0815 (0.5/3.0)      107        12     95     11

### was the side-matched wall at the touch
                               group  touched  reversed  broke  hold%
           post-0815 (40/80) · False       47        24     23     51
            post-0815 (40/80) · True        4         3      1     75
          pre-0815 (0.5/3.0) · False       97         9     88      9
           pre-0815 (0.5/3.0) · True       10         3      7     30

### tenure as THE wall
                               group  touched  reversed  broke  hold%
post-0815 (40/80) · 0 (not the wall)       47        24     23     51
          post-0815 (40/80) · 1 tick        1         1      0    100
  post-0815 (40/80) · 4+ ticks (≥1h)        3         2      1     67
pre-0815 (0.5/3.0) · 0 (not the wall)       97         9     88      9
         pre-0815 (0.5/3.0) · 1 tick        1         0      1      0
      pre-0815 (0.5/3.0) · 2-3 ticks        1         1      0    100
 pre-0815 (0.5/3.0) · 4+ ticks (≥1h)        8         2      6     25

### tenure in the top-3 side list
                               group  touched  reversed  broke  hold%
               post-0815 (40/80) · 0       37        19     18     51
       post-0815 (40/80) · 2-3 ticks        3         2      1     67
        post-0815 (40/80) · 4+ ticks       11         6      5     55
              pre-0815 (0.5/3.0) · 0       95         9     86      9
      pre-0815 (0.5/3.0) · 2-3 ticks        1         0      1      0
       pre-0815 (0.5/3.0) · 4+ ticks       11         3      8     27

### was the wall at ANY capture before the touch
                               group  touched  reversed  broke  hold%
           post-0815 (40/80) · False       45        23     22     51
            post-0815 (40/80) · True        6         4      2     67
          pre-0815 (0.5/3.0) · False       94         8     86      9
           pre-0815 (0.5/3.0) · True       13         4      9     31

## Q3 desk-board level persistence (ticks a strike sat on the published board before its touch)

### detector grade by how long the strike had been a published desk level
                               group  touched  reversed  broke  hold%
  post-0815 (40/80) · never on board       36        19     17     53
          post-0815 (40/80) · 1 tick        1         0      1      0
       post-0815 (40/80) · 2-3 ticks        5         2      3     40
        post-0815 (40/80) · 4+ ticks       17         9      8     53
 pre-0815 (0.5/3.0) · never on board       87        11     76     13
         pre-0815 (0.5/3.0) · 1 tick        8         2      6     25
      pre-0815 (0.5/3.0) · 2-3 ticks       12         1     11      8
       pre-0815 (0.5/3.0) · 4+ ticks       27         2     25      7
