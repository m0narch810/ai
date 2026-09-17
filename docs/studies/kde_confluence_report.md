# KDE CONFLUENCE (the typhoon method) — does agreement across sources pick levels that react / travel?
LIVE RTH fills with a KDE score: 1494 · base ≥120 explore 9.8% confirm 6.7%
HIST 2022-23 fills: 2651 · base ≥120 2022 9.5% 2023 8.4%
source-count distribution (live): {0: np.int64(120), 1: np.int64(213), 2: np.int64(244), 3: np.int64(232), 4: np.int64(232), 5: np.int64(182), 6: np.int64(99), 7: np.int64(92), 8: np.int64(67), 9: np.int64(13)}

## K1 top-tercile KDE density
   K1  explore: with   9.3% (n= 602)  without  10.7% (n= 307)  gap  -1.4  | ≥80:  14.3% vs  15.3%
   K1  confirm: with   5.5% (n= 436)  without  10.1% (n= 149)  gap  -4.6  | ≥80:  10.8% vs  19.5%
   K1     2022: with   9.8% (n= 915)  without   9.0% (n= 553)  gap  +0.8  | ≥80:  15.8% vs  14.3%
   K1     2023: with   7.8% (n= 868)  without   9.8% (n= 315)  gap  -2.0  | ≥80:  14.3% vs  14.3%
   → fail

## K2 ≥4 distinct sources agree
   K2  explore: with  10.8% (n= 453)  without   8.8% (n= 456)  gap  +2.0  | ≥80:  15.7% vs  13.6%
   K2  confirm: with   4.3% (n= 232)  without   8.2% (n= 353)  gap  -3.9  | ≥80:  10.8% vs  14.4%
   K2     2022: with  10.8% (n= 526)  without   8.8% (n= 942)  gap  +2.0  | ≥80:  16.5% vs  14.5%
   K2     2023: with   8.4% (n= 249)  without   8.4% (n= 934)  gap  +0.1  | ≥80:  14.5% vs  14.2%
   → fail

## K3 ≥6 distinct sources agree
   K3  explore: with  11.6% (n= 190)  without   9.3% (n= 719)  gap  +2.3  | ≥80:  16.3% vs  14.2%
   K3  confirm: with   2.5% (n=  81)  without   7.3% (n= 504)  gap  -4.9  | ≥80:   7.4% vs  13.9%
   K3     2022: with  16.7% (n=   6)  without   9.5% (n=1462)  gap  +7.2  | ≥80:  16.7% vs  15.3%
   K3     2023: with   0.0% (n=   5)  without   8.4% (n=1178)  gap  -8.4  | ≥80:   0.0% vs  14.3%
   → fail

## K5 top density AND ≥4 sources
   K5  explore: with  10.3% (n= 417)  without   9.3% (n= 492)  gap  +1.0  | ≥80:  15.3% vs  14.0%
   K5  confirm: with   4.5% (n= 223)  without   8.0% (n= 362)  gap  -3.5  | ≥80:   9.9% vs  14.9%
   K5     2022: with  11.4% (n= 458)  without   8.7% (n=1010)  gap  +2.6  | ≥80:  17.5% vs  14.3%
   K5     2023: with   8.8% (n= 239)  without   8.3% (n= 944)  gap  +0.5  | ≥80:  14.6% vs  14.2%
   → fail

## monotone check — outcome by number of distinct sources (does more agreement = better?)
  LIVE:
    0-2 sources (n= 577): react+40   9.4% · ≥80  14.4% · ≥120   9.4%
    3-3 sources (n= 232): react+40   6.5% · ≥80  12.9% · ≥120   6.5%
    4-5 sources (n= 414): react+40   8.5% · ≥80  14.3% · ≥120   8.5%
    6-+ sources (n= 271): react+40   8.9% · ≥80  13.7% · ≥120   8.9%
  HIST:
    0-2 sources (n=1326): react+40  27.6% · ≥80  14.3% · ≥120   8.3%
    3-3 sources (n= 550): react+40  29.1% · ≥80  14.7% · ≥120   9.3%
    4-5 sources (n= 764): react+40  28.9% · ≥80  16.0% · ≥120  10.1%

## PASSED: nothing

## trades (≥40 in a half, net MNQ/trade, 1 MNQ cost)
filter     half  trades  ≥120%  net +120  react%  net +80
    K1  explore     602    9.3      -1.9     9.3     -1.3
    K1  confirm     436    5.5      -4.3     5.5     -2.8
    K2  explore     453   10.8      -0.2    10.8     -0.5
    K2  confirm     232    4.3      -7.0     4.3     -4.2
    K3  explore     190   11.6      -0.1    11.6     -0.5
    K3  confirm      81    2.5     -12.3     2.5     -8.6
    K5  explore     417   10.3      -0.8    10.3     -0.8
    K5  confirm     223    4.5      -7.5     4.5     -5.0
   ALL  explore     909    9.8      -1.3     9.8     -1.2
   ALL  confirm     585    6.7      -3.2     6.7     -1.3