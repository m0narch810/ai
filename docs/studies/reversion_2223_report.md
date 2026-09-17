# REVERSION CONSISTENCIES — 2223: 417 days, 3549 first approaches after 10:30 (whole strikes within ±1%)
bracket 40/80 MNQ unless stated · trade-through fill · adverse-first · decision at t-1 · win|res = wins / (wins+stops)

## Q0 population

### by IV state (replication of the approach test, after 10:30 only)
                             group      n  fill%  win|res%       ci  MNQ/fill
                           falling   1415   84.3      30.9   28-34       -1.0
                              flat    968   78.3      32.5   29-36        1.9
                            rising   1166   80.4      32.7   29-36        2.3

### side × IV state
                             group      n  fill%  win|res%       ci  MNQ/fill
              resistance · falling    701   86.2      28.8   25-33       -3.6
                 resistance · flat    478   81.0      34.2   29-40        2.8
               resistance · rising    600   80.7      33.1   28-38        2.9
                 support · falling    714   82.5      33.1   29-37        1.5
                    support · flat    490   75.7      30.8   26-36        0.9
                  support · rising    566   80.0      32.3   28-37        1.6

## Q1 DAY TYPE (features fixed at 10:30; approaches after 10:30)

### first-hour |drive| in E0
                             group      n  fill%  win|res%       ci  MNQ/fill
                            <0.25E   1349   81.0      31.3   28-34        0.3
                          0.25-0.5   1098   82.6      32.2   29-36        0.8
                           0.5-0.8    830   79.4      32.3   29-36        1.3
                             >0.8E    272   84.2      32.0   26-39        1.9

### |drive| × approach WITH the drive (support on an up-drive day) vs AGAINST
                             group      n  fill%  win|res%       ci  MNQ/fill
                    <0.25E · False    676   80.9      29.2   25-33       -2.4
                     <0.25E · True    673   81.1      33.4   29-38        3.0
                  0.25-0.5 · False    552   85.0      32.4   28-37        0.4
                   0.25-0.5 · True    546   80.2      32.1   28-37        1.3
                   0.5-0.8 · False    416   80.8      31.3   26-37        0.1
                    0.5-0.8 · True    414   78.0      33.3   28-39        2.5
                     >0.8E · False    137   91.2      18.0   12-27      -12.9
                      >0.8E · True    135   77.0      49.4   39-60       19.8

### first-hour range in E0 (compression → expansion)
                             group      n  fill%  win|res%       ci  MNQ/fill
                             <0.5E    416   84.6      34.1   29-40        2.6
                           0.5-0.8   1449   80.9      31.2   28-34        0.1
                           0.8-1.2   1412   80.7      31.9   29-35        1.0
                             >1.2E    272   82.7      31.5   25-39        0.6

### first-hour range × side
                             group      n  fill%  win|res%       ci  MNQ/fill
                <0.5E · resistance    211   85.3      32.3   25-40        0.6
                   <0.5E · support    205   83.9      35.9   29-44        4.8
              0.5-0.8 · resistance    727   82.8      30.0   26-34       -1.7
                 0.5-0.8 · support    722   78.9      32.5   28-37        2.0
              0.8-1.2 · resistance    705   81.8      32.6   29-37        1.9
                 0.8-1.2 · support    707   79.5      31.1   27-35        0.1
                >1.2E · resistance    136   85.3      32.3   24-42        1.4
                   >1.2E · support    136   80.1      30.7   22-41       -0.3

### IV at the open vs the prior close (vol pts)
                             group      n  fill%  win|res%       ci  MNQ/fill
                             <-2vp   3423   81.4      31.9   30-34        0.8
                           -2..-.5     17   88.2      38.5   18-64        5.3
                              flat     15   73.3      16.7    3-56       -5.5
                            +.5..2     14   78.6      14.3    3-51       -7.1
                             >+2vp     75   81.3      33.3   22-47        0.8
                               nan      5   80.0      50.0    9-91       10.0

### ATM IV change over the first hour
                             group      n  fill%  win|res%       ci  MNQ/fill
                            fell>1   2686   79.8      30.8   29-33        0.0
                              flat    384   85.4      36.3   31-42        5.1
                            rose>1    479   87.1      33.5   29-38        1.4

### first-hour IV change × side
                             group      n  fill%  win|res%       ci  MNQ/fill
               fell>1 · resistance   1352   81.6      30.0   27-33       -1.3
                  fell>1 · support   1334   78.0      31.7   29-35        1.4
                 flat · resistance    187   85.6      38.2   30-47        8.0
                    flat · support    197   85.3      34.5   27-43        2.3
               rose>1 · resistance    240   88.3      33.9   27-41        2.2
                  rose>1 · support    239   85.8      33.2   27-40        0.5

### overnight gap |open − prior close| in E0
                             group      n  fill%  win|res%       ci  MNQ/fill
                            <0.25E   1168   83.0      31.6   28-35       -0.0
                         0.25-0.75   1632   81.0      32.1   29-35        1.4
                            >0.75E    749   79.7      31.9   28-36        1.0

### 0DTE net gamma sign at 10:00 (True = negative)
                             group      n  fill%  win|res%       ci  MNQ/fill
                             False   1508   79.8      30.8   28-34       -0.1
                              True   2041   82.6      32.6   30-35        1.5

### ladder churn in the first hour (top-|gex| strike changes)
                             group      n  fill%  win|res%       ci  MNQ/fill
                               0-3   1851   80.3      31.8   29-35        1.3
                               4-8   1184   82.4      32.1   29-35        0.5
                              9-15    450   81.1      31.4   26-37       -0.4
                               16+     64   93.8      32.0   21-46        1.6

### heavy strikes within ±0.5E of spot at 10:00
                             group      n  fill%  win|res%       ci  MNQ/fill
                               0-1    700   76.3      30.9   27-36        0.9
                               2-3   2662   82.0      31.8   30-34        0.6
                                4+    187   90.9      35.4   28-43        3.0

### EX-POST day was chop (range ≤ 1E and |close−open| ≤ 0.5E) — not tradeable, for reference
                             group      n  fill%  win|res%       ci  MNQ/fill
                             False   3250   81.9      32.0   30-34        0.7
                              True    299   75.9      30.6   24-38        2.7

### P(ex-post chop day) by 10:30 features (days)
     drive1h: <0.25E 20% (n=154) · 0.25-0.5 13% (n=128) · 0.5-0.8 6% (n=98) · >0.8E 0% (n=37) · base 13%
     range1h: <0.5E 16% (n=38) · 0.5-0.8 22% (n=179) · 0.8-1.2 5% (n=166) · >1.2E 0% (n=34) · base 13%
       iv_1h: fell>1 14% (n=332) · flat 9% (n=43) · rose>1 12% (n=42) · base 13%
     churn1h: 0-3 15% (n=233) · 4-8 11% (n=128) · 9-15 10% (n=50) · 16+ 17% (n=6) · base 13%
   cluster10: 0-1 12% (n=100) · 2-3 14% (n=303) · 4+ 0% (n=14) · base 13%

## Q2 LADDER CHURN + TENURE (the top-|gex| strike inside ±1%, prior 60 min)
  top strike changes per day: median 19 (IQR 10-29) over ~390 min · median run length 4 min · first-hour changes median 3

### level IS the top-|gex| strike at t-1
                             group      n  fill%  win|res%       ci  MNQ/fill
                             False   2753   82.5      33.6   32-36        2.5
                              True    796   77.6      24.8   21-29       -5.5

### level is in the top-3 at t-1
                             group      n  fill%  win|res%       ci  MNQ/fill
                             False   1487   83.6      34.8   32-38        3.7
                              True   2062   79.8      29.4   27-32       -1.4

### tenure as top-1 in the last 60 min
                             group      n  fill%  win|res%       ci  MNQ/fill
                                 0   2530   82.6      33.9   32-36        2.7
                               1-9    167   75.4      23.2   16-32       -9.0
                             10-29    233   79.4      29.8   23-38       -1.4
                             30-60    619   78.8      25.6   21-30       -4.1

### tenure in top-3 in the last 60 min
                             group      n  fill%  win|res%       ci  MNQ/fill
                                 0   1171   83.8      33.8   31-37        2.9
                              1-19    419   85.7      31.2   26-37       -1.3
                             20-44    482   82.4      33.1   28-38        1.9
                             45-60   1477   77.9      29.8   27-33       -0.7

### ladder churn in the last 60 min (all approaches)
                             group      n  fill%  win|res%       ci  MNQ/fill
                               0-2   1879   79.8      31.8   29-34        1.1
                               3-6    883   83.0      30.5   27-34       -1.1
                              7-12    642   84.1      34.1   30-39        2.9
                               13+    145   79.3      31.3   23-41       -0.0

### churn × IV state
                             group      n  fill%  win|res%       ci  MNQ/fill
                     0-2 · falling    675   81.9      30.1   26-34       -1.5
                        0-2 · flat    542   77.9      32.5   28-38        2.1
                      0-2 · rising    662   79.3      33.2   29-38        2.9
                     3-6 · falling    375   85.6      31.2   26-37       -1.5
                        3-6 · flat    217   79.3      31.2   24-39        0.0
                      3-6 · rising    291   82.5      28.9   23-36       -1.5
                    7-12 · falling    282   89.7      32.6   27-39        1.0
                       7-12 · flat    182   79.1      34.7   27-44        4.0
                     7-12 · rising    178   80.3      36.3   28-45        5.1

### tenure3 × IV state
                             group      n  fill%  win|res%       ci  MNQ/fill
                       0 · falling    484   84.7      34.6   30-40        3.2
                          0 · flat    310   82.6      35.4   29-42        4.7
                        0 · rising    377   83.6      31.6   26-37        1.0
                    1-19 · falling    178   88.2      29.5   23-38       -2.8
                     1-19 · rising    151   84.8      34.9   27-44        2.2
                   20-44 · falling    197   84.8      31.3   24-39       -0.5
                      20-44 · flat    112   76.8      33.3   24-45        1.5
                    20-44 · rising    173   83.2      35.4   27-45        4.9
                   45-60 · falling    556   82.6      27.9   24-32       -4.4
                      45-60 · flat    456   75.0      30.9   26-37        1.2
                    45-60 · rising    465   75.3      31.6   26-38        2.4

## Q3 CLUSTERING at the level (t-1)

### other heavy strikes within ±0.5E of the level
                             group      n  fill%  win|res%       ci  MNQ/fill
                                 0    999   70.8      27.2   23-32        0.2
                                 1   1180   83.8      33.3   30-36        1.6
                                2+   1370   87.0      32.5   30-35        0.5

### distance to the nearest other heavy strike
                             group      n  fill%  win|res%       ci  MNQ/fill
                            <0.25E    600   92.5      33.5   30-38        0.2
                          0.25-0.5   1950   83.4      32.6   30-35        1.3
                             0.5-1    914   72.8      27.6   23-32        0.7
                               >1E     84   48.8      15.4    4-42       -7.1
                               nan      1  100.0       0.0    0-79      -40.0

### cluster × side
                             group      n  fill%  win|res%       ci  MNQ/fill
                    0 · resistance    501   72.1      27.3   22-34       -0.4
                       0 · support    498   69.5      27.1   21-33        0.8
                    1 · resistance    581   86.1      32.3   28-37        0.2
                       1 · support    599   81.6      34.3   30-39        3.2
                   2+ · resistance    697   88.1      32.4   29-36        0.7
                      2+ · support    673   85.9      32.7   29-37        0.3

### distance from spot at t-1 (E)
                             group      n  fill%  win|res%       ci  MNQ/fill
                             <0.1E     83   97.6      34.6   25-45        1.5
                           0.1-0.3   2471   85.3      31.8   30-34       -0.2
                           0.3-0.6    926   71.6      32.0   28-37        3.9
                             >0.6E     69   52.2      25.0    7-59        1.2

## Q4 REACTION SIZE (filled approaches; reaction = max favourable excursion before the 40-MNQ stop)
  filled 2888 of 3549 (81%)
         all (n=2888): ≥10: 89% · ≥20: 70% · ≥30: 56% · ≥40: 47% · ≥60: 35% · ≥80: 27%
      rising (n=937): ≥10: 91% · ≥20: 72% · ≥30: 58% · ≥40: 50% · ≥60: 35% · ≥80: 26%
        flat (n=758): ≥10: 87% · ≥20: 67% · ≥30: 52% · ≥40: 43% · ≥60: 34% · ≥80: 27%
     falling (n=1193): ≥10: 89% · ≥20: 69% · ≥30: 56% · ≥40: 48% · ≥60: 36% · ≥80: 27%
     support (n=1413): ≥10: 90% · ≥20: 70% · ≥30: 56% · ≥40: 48% · ≥60: 35% · ≥80: 27%
  resistance (n=1475): ≥10: 88% · ≥20: 69% · ≥30: 55% · ≥40: 47% · ≥60: 35% · ≥80: 26%
  given a ≥20-MNQ reaction (n=2009): reached 40 68% · reached 80 (win on 40/80) 38% · stopped after it 43%
  given a ≥40-MNQ reaction (n=1369): reached 80 56% · stopped after it 25%

## Q5 BRACKET SENSITIVITY (same approaches, stop/target in MNQ; BE = stop/(stop+tp))
   bracket   BE% |                    all |                 rising |                   flat |                falling |                support |             resistance
  20/40     33.3 |   33.6%   +0.4 n=2888  |   35.2%   +1.4 n=937   |   31.2%   -0.9 n=758   |   34.0%   +0.4 n=1193  |   32.8%   -0.1 n=1413  |   34.4%   +0.8 n=1475 
  40/40     50.0 |   51.4%   +0.9 n=2888  |   55.7%   +3.8 n=937   |   47.5%   -1.7 n=758   |   50.6%   +0.3 n=1193  |   51.6%   +1.2 n=1413  |   51.1%   +0.7 n=1475 
  40/80     33.3 |   31.9%   +0.8 n=2888  |   32.7%   +2.3 n=937   |   32.5%   +1.9 n=758   |   30.9%   -1.0 n=1193  |   32.3%   +1.4 n=1413  |   31.5%   +0.2 n=1475 
  40/120    25.0 |   19.9%   +0.3 n=2888  |   21.0%   +1.8 n=937   |   19.0%   +0.8 n=758   |   19.6%   -1.1 n=1193  |   19.6%   +1.0 n=1413  |   20.1%   -0.3 n=1475 
  60/120    33.3 |   28.4%   +1.0 n=2888  |   30.8%   +3.1 n=937   |   26.5%   +0.7 n=758   |   27.9%   -0.4 n=1193  |   28.1%   +1.7 n=1413  |   28.8%   +0.3 n=1475 
  80/80     50.0 |   51.0%   +0.7 n=2888  |   52.8%   +2.6 n=937   |   53.4%   +3.2 n=758   |   48.6%   -2.4 n=1193  |   50.6%   +1.5 n=1413  |   51.5%   +0.0 n=1475 
  80/160    33.3 |   24.7%   +0.3 n=2888  |   27.6%   +1.6 n=937   |   23.3%   +2.3 n=758   |   23.5%   -2.0 n=1193  |   22.9%   +0.2 n=1413  |   26.5%   +0.5 n=1475 

  median minutes to resolution on 40/80 (resolved only): rising: 28 · flat: 46 · falling: 34
