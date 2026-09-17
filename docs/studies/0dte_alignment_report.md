# 0DTE ALIGNMENT STUDY — 665 days, 119186 calls, 11031 first-appearance calls
in-sample 2022-2023: 417 days / 6310 calls · holdout 2024: 248 days / 4721 calls

bracket A = 40/80 MNQ fixed (0.983/1.966 QQQ pts) · bracket B = same scaled by spot/700 (era-normalised)


## 0 · NULL — read this before anything else

### population, by year (a 1:2 bracket on a driftless walk resolves ~33% wins) (spec A)

 group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
  2022   2776   62.8      1596   32.8 31-35    8.5           0.7
  2023   3534   49.9      1442   30.7 28-33   18.3          -0.3

### population, by year (spec B)

 group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
  2022   2776   62.8      1716   34.7 33-37    1.6           0.8
  2023   3534   49.9      1681   32.4 30-35    4.8          -0.2

### population by distance to spot in E (unreachable = wasted slot) (spec A)

 group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
 <0.5E   3417   77.0      2359   33.7 32-36   10.3           1.9
0.5-1E   1812   40.3       592   25.5 22-29   19.0          -5.3
  1-2E    936   15.6        85   24.7 17-35   41.8          -2.2
   >2E    145    1.4         2    0.0  0-66    0.0         -40.0


## 1 · DESK ALIGNMENT VECTOR (port of evaluateStrike) — IN-SAMPLE, split by year first

### vector by year (spec A)

         group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
2022 · aligned    731   57.3       379   27.7 23-32    9.5          -4.9
  2022 · mixed   1453   71.1       962   35.0 32-38    6.9           3.2
2022 · opposed    592   49.3       255   32.2 27-38   12.7          -0.4
2023 · aligned    847   37.2       262   35.5 30-41   16.8           3.6
  2023 · mixed   1814   61.6       920   29.5 27-32   17.6          -1.0
2023 · opposed    873   38.1       260   30.4 25-36   21.9          -1.5

### vector by year (spec B)

         group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
2022 · aligned    731   57.3       411   33.6 29-38    1.9           0.2
  2022 · mixed   1453   71.1      1021   35.4 32-38    1.2           1.1
2022 · opposed    592   49.3       284   34.2 29-40    2.7           0.6
2023 · aligned    847   37.2       299   31.8 27-37    5.1          -0.7
  2023 · mixed   1814   61.6      1073   33.2 30-36    3.9           0.3
2023 · opposed    873   38.1       309   30.4 26-36    7.2          -1.3

### vector by side (charm's structural asymmetry shows here) (spec A)

               group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · aligned     95   50.5        43   39.5 26-54   10.4           5.3
  resistance · mixed   1905   65.2      1094   30.6 28-33   11.9          -1.0
resistance · opposed   1164   39.9       382   30.9 26-36   17.8          -1.5
   support · aligned   1483   46.3       598   30.3 27-34   12.8          -1.7
     support · mixed   1362   66.7       788   34.6 31-38   13.2           3.7
   support · opposed    301   53.2       133   32.3 25-41   16.9           0.7

### role × vector (spec A)

                group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   dominant · aligned    617   54.0       289   28.0 23-33   13.2          -3.5
     dominant · mixed    605   75.7       385   29.1 25-34   15.9          -1.4
   dominant · opposed    585   51.8       245   30.2 25-36   19.1          -1.7
      empty · aligned     80   33.8        21   38.1 21-59   22.2           2.6
        empty · mixed    529   51.2       253   36.0 30-42    6.6           4.5
      empty · opposed     71   21.1        11   18.2  5-48   26.7          -8.1
      minor · aligned     89   46.1        37   43.2 29-59    9.8          12.4
        minor · mixed    498   62.7       281   36.3 31-42    9.9           4.5
      minor · opposed     74   36.5        21   19.0  8-40   22.2         -10.5
significant · aligned    792   42.0       294   31.6 27-37   11.7          -0.9
  significant · mixed   1635   67.8       963   31.5 29-34   13.2           0.2
significant · opposed    735   38.1       238   34.0 28-40   15.0           1.1

### desk prob tier → realised hold rate (calibration) (spec A)

 group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
     6    300   60.0       169   37.9 31-45    6.1           6.5
    10    145   29.0        32   18.8  9-35   23.8          -9.6
    12    229   39.7        84   32.1 23-43    7.7           0.4
    18    815   37.7       259   34.4 29-40   15.6           1.2
    19    300   65.0       186   37.1 30-44    4.6           4.9
    25    783   53.6       340   31.5 27-37   19.0          -0.1
    32    892   67.7       527   30.7 27-35   12.7          -0.9
    33     89   46.1        37   43.2 29-59    9.8          12.4
    38    743   68.0       436   32.3 28-37   13.7           1.5
    40    345   75.7       229   30.1 25-36   12.3          -1.0
    46    260   75.8       156   27.6 21-35   20.8          -1.9
    52    792   42.0       294   31.6 27-37   11.7          -0.9
    58    480   57.7       241   28.6 23-35   13.0          -3.1
    62    137   40.9        48   25.0 15-39   14.3          -5.3


## 2 · GEX + VEX + CHARM (the user's triad) — IN-SAMPLE

### triad by year (spec A)

                  group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   2022 · gamma opposed    586   73.5       394   32.2 28-37    8.6           0.6
2022 · gex vs vex/charm    324   53.1       148   33.1 26-41   14.0           0.9
         2022 · gex+one    123   84.6       100   37.0 28-47    3.8           5.0
   2022 · gex+vex+charm    427   59.0       236   25.4 20-31    6.3          -7.9
   2022 · no gamma vote   1316   59.7       718   35.0 32-39    8.5           2.8
   2023 · gamma opposed    638   70.5       348   28.2 24-33   22.7          -1.6
2023 · gex vs vex/charm    449   42.5       153   31.4 25-39   19.9          -1.1
         2023 · gex+one    265   79.6       178   28.7 23-36   15.6          -2.7
   2023 · gex+vex+charm    467   38.5       152   36.2 29-44   15.6           4.1
   2023 · no gamma vote   1715   42.7       611   31.3 28-35   16.6           0.4

### triad by side (spec A)

                        group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   resistance · gamma opposed    662   75.4       438   30.8 27-35   12.2          -0.6
resistance · gex vs vex/charm    773   47.0       301   32.2 27-38   17.1          -0.2
         resistance · gex+one    180   80.6       130   28.5 21-37   10.3          -4.1
   resistance · no gamma vote   1549   48.3       650   30.9 27-35   13.1          -1.0
      support · gamma opposed    562   68.0       304   29.6 25-35   20.4          -0.4
            support · gex+one    208   81.7       148   34.5 27-42   12.9           3.2
      support · gex+vex+charm    894   48.3       388   29.6 25-34   10.2          -2.9
      support · no gamma vote   1482   52.0       679   35.5 32-39   11.8           4.2

### triad, era-normalised bracket (spec B)

           group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   gamma opposed   1224   72.0       846   36.8 34-40    4.0           2.1
gex vs vex/charm    773   47.0       350   30.6 26-36    3.6          -1.3
         gex+one    388   81.2       310   34.2 29-40    1.6           1.0
   gex+vex+charm    894   48.3       417   30.9 27-36    3.5          -0.9
   no gamma vote   3031   50.1      1474   33.1 31-36    2.9          -0.1

### triad, dominant+significant roles only (spec A)

           group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   gamma opposed   1066   70.6       624   29.5 26-33   17.1          -1.0
gex vs vex/charm    765   47.2       299   32.4 27-38   17.2           0.1
         gex+one    379   81.0       270   31.1 26-37   12.1          -0.7
   gex+vex+charm    877   48.0       377   28.6 24-33   10.5          -3.9
   no gamma vote   1882   51.8       844   32.1 29-35   13.3           0.5

### gex_vote alone by side (spec A)

          group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · -1    662   75.4       438   30.8 27-35   12.2          -0.6
 resistance · 0   1544   48.2       646   31.1 28-35   13.2          -0.7
 resistance · 1    958   53.4       435   30.8 27-35   15.0          -1.6
   support · -1    562   68.0       304   29.6 25-35   20.4          -0.4
    support · 0   1478   51.8       675   35.4 32-39   11.9           4.1
    support · 1   1106   54.8       540   31.1 27-35   10.9          -1.0

### vex_vote alone by side (spec A)

          group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · -1    650   75.5       431   30.6 26-35   12.2          -0.7
 resistance · 0   1600   48.0       668   31.0 28-35   13.0          -1.0
 resistance · 1    914   54.3       420   31.2 27-36   15.3          -1.1
   support · -1    568   67.6       305   29.8 25-35   20.6          -0.3
    support · 0   1430   52.8       667   35.4 32-39   11.7           4.0
    support · 1   1148   53.6       547   31.1 27-35   11.1          -0.9

### charm_vote alone by side (spec A)

          group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · -1   1164   39.9       382   30.9 26-36   17.8          -1.5
 resistance · 0   1575   65.0       896   30.4 27-33   12.4          -1.1
 resistance · 1    425   62.8       241   33.2 28-39    9.7           0.8
   support · -1    298   53.0       133   32.3 25-41   15.8           0.7
    support · 0   1507   68.3       892   34.0 31-37   13.4           3.0
    support · 1   1341   42.2       494   30.6 27-35   12.7          -1.5

### vanna_vote alone by side (spec A)

          group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · -1    521   39.2       162   29.6 23-37   20.6          -1.8
 resistance · 0   2499   58.1      1274   30.6 28-33   12.3          -1.4
 resistance · 1    144   68.8        83   38.6 29-49   16.2           7.2
   support · -1     55   49.1        17   41.2 22-64   37.0           7.3
    support · 0   2676   56.7      1310   34.0 31-37   13.6           2.8
    support · 1    415   50.8       192   23.4 18-30    9.0          -9.8

### dex_vote alone by side (spec A)

         group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · 0   3164   55.5      1519   30.9 29-33   13.4          -0.9
   support · 0   1533   48.4       647   35.5 32-39   12.8           3.9
   support · 1   1613   62.7       872   30.6 28-34   13.8          -0.5


## 3 · CONTROLS — IN-SAMPLE

### PLACEBO — same labels, strike displaced 0.25E toward (near) / away (far) — in-sample (spec A)

        resolved             hold%                 ci              
strike       far  near  real   far  near  real    far   near   real
vector                                                             
aligned      437   808   641  29.7  29.3  30.9  26-34  26-33  27-35
mixed       1277  1945  1882  31.3  20.6  32.3  29-34  19-22  30-34
opposed      330   674   515  28.5  29.4  31.3  24-34  26-33  27-35

### PLACEBO — same labels, strike displaced 0.25E toward (near) / away (far) — in-sample (spec B)

        resolved             hold%                 ci              
strike       far  near  real   far  near  real    far   near   real
vector                                                             
aligned      507   881   710  34.7  29.5  32.8  31-39  27-33  29-36
mixed       1476  2076  2094  36.4  17.0  34.2  34-39  15-19  32-36
opposed      391   761   593  29.9  29.0  32.2  26-35  26-32  29-36

### by 0DTE gamma regime × vector (spec A)

          group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
False · aligned    273   39.2        93   25.8 18-36   13.1          -5.1
  False · mixed   1430   63.6       771   31.6 28-35   15.3           1.0
False · opposed   1190   42.9       424   30.0 26-34   17.0          -2.1
 True · aligned   1305   48.0       548   31.8 28-36   12.6          -0.6
   True · mixed   1837   67.5      1111   32.8 30-36   10.4           1.1
 True · opposed    275   41.5        91   37.4 28-48   20.2           4.2

### by IV direction × vector (spec A)

            group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
FALLING · aligned    532   55.5       270   26.3 21-32    8.5          -7.0
  FALLING · mixed   1175   67.7       734   30.4 27-34    7.8          -1.5
FALLING · opposed    645   42.2       228   29.8 24-36   16.2          -2.4
 RISING · aligned    385   43.4       140   29.3 22-37   16.2          -2.1
   RISING · mixed    791   64.9       419   34.1 30-39   18.3           3.3
 RISING · opposed    233   41.2        79   34.2 25-45   17.7           1.7
 STABLE · aligned    661   41.1       231   37.2 31-44   15.1           5.6
   STABLE · mixed   1301   64.6       729   33.2 30-37   13.3           2.0
 STABLE · opposed    587   43.8       208   31.7 26-38   19.1          -0.5

### ALL TICKS (secondary, overlapping) — vector (spec A)

  group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
aligned  16536   36.9      4390   29.1 28-30   28.1          -0.8
  mixed  30137   49.1     10998   30.1 29-31   25.7           0.4
opposed  16608   31.4      3528   25.4 24-27   32.3          -4.2


## 4 · HOLDOUT 2024 — touched once, same tables, no re-cutting

### vector (spec A)

  group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
aligned   1080   36.8       353   30.9 26-36   11.1          -0.6
  mixed   2492   59.0      1301   30.4 28-33   11.5          -1.3
opposed   1149   36.8       348   27.6 23-33   17.7          -3.8

### vector (spec B)

  group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
aligned   1080   36.8       384   33.1 29-38    3.3           0.3
  mixed   2492   59.0      1411   32.0 30-35    4.0          -0.4
opposed   1149   36.8       382   30.1 26-35    9.7          -1.4

### vector by side (spec A)

               group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
resistance · aligned     48   37.5        17   47.1 26-69    5.6          14.5
  resistance · mixed   1370   58.2       711   31.1 28-35   10.9          -1.7
resistance · opposed    950   32.2       248   25.8 21-32   19.0          -5.4
   support · aligned   1032   36.7       336   30.1 25-35   11.3          -1.3
     support · mixed   1122   59.9       590   29.7 26-33   12.2          -0.8
   support · opposed    199   58.8       100   32.0 24-42   14.5           0.3

### triad (spec A)

           group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   gamma opposed    872   74.3       551   31.9 28-36   15.0           0.8
gex vs vex/charm    613   38.5       197   27.4 22-34   16.5          -4.4
         gex+one    363   76.0       245   35.1 29-41   11.2           3.4
   gex+vex+charm    519   36.0       170   32.4 26-40    9.1           0.7
   no gamma vote   2354   40.1       839   27.4 25-31   11.0          -4.5

### triad (spec B)

           group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   gamma opposed    872   74.3       606   31.5 28-35    6.5          -0.4
gex vs vex/charm    613   38.5       213   30.0 24-37    9.7          -1.5
         gex+one    363   76.0       271   35.8 30-42    1.8           2.2
   gex+vex+charm    519   36.0       179   33.5 27-41    4.3           1.1
   no gamma vote   2354   40.1       908   31.1 28-34    3.7          -1.2

### role × vector (spec A)

                group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
   dominant · aligned    313   43.8       123   33.3 26-42   10.2           2.6
     dominant · mixed    390   77.7       248   34.3 29-40   18.2           3.8
   dominant · opposed    346   45.7       133   30.8 24-39   15.8           0.0
      empty · aligned    128   35.2        39   30.8 19-46   13.3          -1.5
        empty · mixed    674   37.8       228   23.2 18-29   10.6          -9.2
      empty · opposed    132   21.2        25   16.0  6-35   10.7         -18.8
      minor · aligned     59   47.5        27   22.2 11-41    3.6         -13.6
        minor · mixed    333   59.8       183   35.0 28-42    8.0           3.4
      minor · opposed     76   42.1        27   44.4 28-63   15.6          14.3
significant · aligned    580   32.2       164   30.5 24-38   12.3          -0.9
  significant · mixed   1095   65.1       642   30.2 27-34   10.0          -1.8
significant · opposed    595   34.5       163   23.9 18-31   20.5          -7.6

### desk prob tier → realised (spec A)

 group  calls  fill%  resolved  hold%    ci  flat%  exp MNQ/fill
     6    278   49.6       131   24.4 18-32    5.1          -9.8
    10    208   28.8        52   30.8 20-44   13.3          -1.1
    12    396   29.5        97   21.6 15-31   17.1          -8.6
    18    723   34.6       202   25.2 20-32   19.2          -6.5
    19    148   62.2        85   37.6 28-48    7.6           6.1
    25    531   49.9       231   31.6 26-38   12.8           0.4
    32    498   64.9       298   27.9 23-33    7.7          -5.7
    33     59   47.5        27   22.2 11-41    3.6         -13.6
    38    597   65.3       344   32.3 28-37   11.8           1.4
    40    181   73.5       116   30.2 23-39   12.8          -2.6
    46    209   81.3       132   37.9 30-46   22.4           8.7
    52    580   32.2       164   30.5 24-38   12.3          -0.9
    58    217   46.5        92   34.8 26-45    8.9           3.1
    62     96   37.5        31   29.0 16-47   13.9           1.2

### PLACEBO — same labels, strike displaced 0.25E toward (near) / away (far) — holdout (spec A)

        resolved             hold%                 ci              
strike       far  near  real   far  near  real    far   near   real
vector                                                             
aligned      258   460   353  28.7  27.4  30.9  24-34  24-32  26-36
mixed        867  1461  1301  30.0  22.7  30.4  27-33  21-25  28-33
opposed      225   467   348  24.0  26.8  27.6  19-30  23-31  23-33
