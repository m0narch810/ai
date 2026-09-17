# LIVE-FEED PRECISION STUDY — NQ 5m converted, 2026-07-20 → 2026-09-17 · dropped for ratio disagreement: 0.3% of bars
touches: 7153 (3576 whole strikes, 3577 half-strikes) over 43 session days
precise = runs 40 MNQ from the strike before going 15 past it · strong = runs 80 first · horizon 6 h

## 0. USER'S EXAMPLES (must appear as precise touches)
   2026-09-17 712.0 support → [{'t': Timestamp('2026-09-17 05:15:00-0400', tz='America/New_York'), 'sess': 'ETH', 'overshoot': 0.0, 'precise': True, 'strong': True, 'mfe_before_stop': 195.3}, {'t': Timestamp('2026-09-17 07:40:00-0400', tz='America/New_York'), 'sess': 'ETH', 'overshoot': 0.0, 'precise': True, 'strong': True, 'mfe_before_stop': 195.3}]
   2026-09-16 700.0 support → [{'t': Timestamp('2026-09-16 15:25:00-0400', tz='America/New_York'), 'sess': 'RTH', 'overshoot': 1.3, 'precise': True, 'strong': True, 'mfe_before_stop': 411.2}]
   2026-09-16 712.0 resistance → [{'t': Timestamp('2026-09-16 11:45:00-0400', tz='America/New_York'), 'sess': 'RTH', 'overshoot': 0.0, 'precise': True, 'strong': True, 'mfe_before_stop': 489.7}]

## 1. NULL CHECK — do whole strikes react precisely more often than half-strikes (no options there)?
  RTH precise: whole  32.1% [29.9-34.4] n=1703 · half  33.9% [31.7-36.2] n=1712
  RTH  strong: whole  20.4% [18.6-22.4] n=1703 · half  21.6% [19.7-23.6] n=1712
  ETH precise: whole  36.5% [34.3-38.7] n=1873 · half  37.6% [35.5-39.9] n=1865
  ETH  strong: whole  21.3% [19.5-23.2] n=1873 · half  22.8% [20.9-24.7] n=1865
  overshoot when it traded through (MNQ): whole median 10.0 · half 10.4
  share of touches that turned within 0.15 WITHOUT trading through: whole 36.7% · half 37.1%

## 2. BOOK FEATURES AT THE STRIKE — 3531 whole-strike touches with a capture (RTH 1703, ETH 1828)

### base   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                       all  2115  33.0% [31.1-35.1] |  1416  36.4% [34.0-39.0]
                                       RTH  1036  29.6% [26.9-32.5] |   667  36.0% [32.4-39.7]
                                       ETH  1079  36.3% [33.5-39.2] |   749  36.8% [33.5-40.4]
                                   support  1089  33.6% [30.9-36.5] |   724  34.3% [30.9-37.8]
                                resistance  1026  32.5% [29.7-35.4] |   692  38.7% [35.2-42.4]

### gex: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   445  32.1% [28.0-36.6] |   284  33.5% [28.2-39.1]
                              middle third   652  32.7% [29.2-36.4] |   384  30.7% [26.3-35.5]
                                 top third   991  33.4% [30.5-36.4] |   723  40.7% [37.1-44.3]
                                   top 10%   383  30.3% [25.9-35.1] |   326  37.4% [32.3-42.8]
                                local peak   726  31.8% [28.5-35.3] |   471  39.1% [34.8-43.5]
                                not a peak  1362  33.5% [31.0-36.0] |   920  35.1% [32.1-38.2]

### charm: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third  1258  33.6% [31.1-36.3] |   812  37.6% [34.3-40.9]
                              middle third   485  31.8% [27.8-36.0] |   334  33.2% [28.4-38.5]
                                 top third   342  32.2% [27.4-37.3] |   243  37.0% [31.2-43.3]
                                   top 10%    91  27.5% [19.4-37.4] |    74  36.5% [26.4-47.9]
                                local peak   555  31.5% [27.8-35.5] |   334  38.3% [33.3-43.6]
                                not a peak  1533  33.4% [31.1-35.8] |  1057  35.9% [33.0-38.8]

### vanna: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third  1241  33.5% [30.9-36.2] |   886  37.1% [34.0-40.4]
                              middle third   519  32.4% [28.5-36.5] |   231  34.6% [28.8-41.0]
                                 top third   328  31.4% [26.6-36.6] |   272  35.7% [30.2-41.5]
                                   top 10%   106  26.4% [19.0-35.5] |    97  44.3% [34.8-54.2]
                                local peak   593  31.7% [28.1-35.6] |   395  41.3% [36.5-46.2]
                                not a peak  1495  33.4% [31.0-35.8] |   996  34.5% [31.6-37.5]

### tex: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   381  31.2% [26.8-36.1] |    90  26.7% [18.6-36.6]
                              middle third   797  33.2% [30.1-36.6] |   590  37.3% [33.5-41.3]
                                 top third   903  33.2% [30.2-36.4] |   708  37.0% [33.5-40.6]
                                   top 10%   307  27.4% [22.7-32.6] |   316  33.9% [28.9-39.2]
                                local peak   758  31.7% [28.5-35.1] |   547  36.6% [32.6-40.7]
                                not a peak  1330  33.6% [31.1-36.2] |   844  36.4% [33.2-39.7]

### vex: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third  1205  32.7% [30.1-35.4] |   893  37.3% [34.2-40.5]
                              middle third   547  33.6% [29.8-37.7] |   233  33.5% [27.7-39.8]
                                 top third   329  32.2% [27.4-37.4] |   262  36.3% [30.7-42.2]
                                   top 10%   101  30.7% [22.5-40.3] |    90  45.6% [35.7-55.8]
                                local peak   582  32.0% [28.3-35.9] |   391  39.6% [34.9-44.6]
                                not a peak  1506  33.3% [30.9-35.7] |  1000  35.2% [32.3-38.2]

### dex: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   609  30.9% [27.3-34.6] |   287  32.4% [27.3-38.0]
                              middle third   780  33.3% [30.1-36.7] |   598  39.1% [35.3-43.1]
                                 top third   696  34.3% [30.9-37.9] |   504  35.5% [31.5-39.8]
                                   top 10%   302  29.5% [24.6-34.8] |   200  33.0% [26.9-39.8]
                                local peak   689  30.9% [27.6-34.5] |   460  37.8% [33.5-42.3]
                                not a peak  1399  33.9% [31.4-36.4] |   931  35.8% [32.8-38.9]

### gex0: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   402  32.6% [28.2-37.3] |   217  26.3% [20.9-32.5]
                              middle third   617  33.1% [29.5-36.9] |   402  34.6% [30.1-39.4]
                                 top third  1069  32.9% [30.2-35.8] |   772  40.3% [36.9-43.8]
                                   top 10%   401  32.9% [28.5-37.7] |   404  39.9% [35.2-44.7]
                                local peak   717  32.2% [28.9-35.7] |   460  38.7% [34.4-43.2]
                                not a peak  1371  33.3% [30.8-35.8] |   931  35.3% [32.3-38.5]

### charm0: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third  1294  33.7% [31.2-36.3] |   809  37.3% [34.1-40.7]
                              middle third   460  30.4% [26.4-34.8] |   345  34.2% [29.4-39.4]
                                 top third   331  33.5% [28.7-38.8] |   235  36.6% [30.7-42.9]
                                   top 10%    99  26.3% [18.6-35.7] |    87  32.2% [23.3-42.6]
                                local peak   567  31.0% [27.4-35.0] |   316  38.0% [32.8-43.4]
                                not a peak  1521  33.6% [31.3-36.0] |  1075  36.0% [33.2-38.9]

### vanna0: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third  1204  34.4% [31.8-37.1] |   812  36.9% [33.7-40.3]
                              middle third   564  29.8% [26.2-33.7] |   293  34.5% [29.3-40.1]
                                 top third   320  32.8% [27.9-38.1] |   284  37.0% [31.6-42.7]
                                   top 10%   131  29.8% [22.6-38.1] |    92  38.0% [28.8-48.3]
                                local peak   576  30.2% [26.6-34.1] |   361  40.7% [35.8-45.9]
                                not a peak  1512  33.9% [31.6-36.4] |  1030  35.0% [32.1-37.9]

### tex0: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   328  33.2% [28.4-38.5] |    75  28.0% [19.1-39.0]
                              middle third   763  34.2% [30.9-37.6] |   400  38.0% [33.4-42.8]
                                 top third   965  31.6% [28.8-34.6] |   888  36.3% [33.2-39.5]
                                   top 10%   391  33.2% [28.8-38.1] |   431  33.9% [29.6-38.5]
                                local peak   701  31.4% [28.1-34.9] |   513  36.6% [32.6-40.9]
                                not a peak  1387  33.7% [31.2-36.2] |   878  36.3% [33.2-39.6]

### oi_tot: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   598  31.3% [27.7-35.1] |   237  34.2% [28.4-40.4]
                              middle third   698  34.8% [31.4-38.4] |   594  38.2% [34.4-42.2]
                                 top third   792  32.4% [29.3-35.8] |   558  35.5% [31.6-39.5]
                                   top 10%   256  28.1% [23.0-33.9] |   245  31.8% [26.3-37.9]
                                local peak   724  31.6% [28.3-35.1] |   451  34.8% [30.6-39.3]
                                not a peak  1364  33.6% [31.1-36.1] |   940  37.2% [34.2-40.4]

### vol_tot: |value| rank in the ±1.5% band, and local peak   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                              bottom third   160  28.8% [22.3-36.2] |    50  38.0% [25.9-51.8]
                              middle third   683  32.9% [29.5-36.6] |   282  33.7% [28.4-39.4]
                                 top third  1245  33.4% [30.8-36.1] |  1057  37.1% [34.2-40.0]
                                   top 10%   591  31.8% [28.2-35.7] |   621  38.2% [34.4-42.0]
                                local peak   466  31.5% [27.5-35.9] |   306  35.6% [30.5-41.1]
                                not a peak  1622  33.3% [31.0-35.6] |  1085  36.7% [33.9-39.6]

### gex sign at the strike   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  positive   886  34.0% [30.9-37.2] |   518  37.3% [33.2-41.5]
                                  negative  1202  32.1% [29.5-34.8] |   873  36.0% [32.9-39.2]

### gex0 sign at the strike   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  positive   885  34.1% [31.1-37.3] |   540  36.3% [32.4-40.4]
                                  negative  1203  32.0% [29.4-34.7] |   851  36.5% [33.4-39.8]

### tex sign at the strike   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  positive     0   nan% [ nan- nan] |     0   nan% [ nan- nan]
                                  negative  2081  32.9% [30.9-34.9] |  1388  36.5% [34.0-39.0]

### tex0 sign at the strike   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  positive     0   nan% [ nan- nan] |     0   nan% [ nan- nan]
                                  negative  2056  32.8% [30.8-34.9] |  1363  36.3% [33.8-38.9]

### dex sign at the strike   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  positive   869  33.7% [30.7-36.9] |   606  36.5% [32.7-40.4]
                                  negative  1216  32.4% [29.8-35.1] |   783  36.4% [33.1-39.8]

### vex sign at the strike   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  positive  1210  31.4% [28.9-34.1] |   884  37.0% [33.9-40.2]
                                  negative   871  34.9% [31.8-38.1] |   504  35.5% [31.5-39.8]

### charm_with: forced dealer flow WITH the side (+1) or AGAINST (−1)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      with  1281  31.5% [29.1-34.1] |   972  37.0% [34.1-40.1]
                                   against   804  35.2% [32.0-38.6] |   417  35.0% [30.6-39.7]

### charm0_with: forced dealer flow WITH the side (+1) or AGAINST (−1)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      with  1280  31.6% [29.1-34.2] |   974  37.1% [34.1-40.1]
                                   against   805  35.2% [31.9-38.5] |   415  34.9% [30.5-39.6]

### vanna_with: forced dealer flow WITH the side (+1) or AGAINST (−1)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      with   755  33.6% [30.4-37.1] |   460  37.0% [32.7-41.5]
                                   against   937  33.4% [30.5-36.5] |   591  38.1% [34.2-42.1]

### vanna0_with: forced dealer flow WITH the side (+1) or AGAINST (−1)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      with   751  32.5% [29.2-35.9] |   471  37.6% [33.3-42.0]
                                   against   941  34.3% [31.4-37.4] |   580  37.6% [33.7-41.6]

### gex: 0DTE share of the tenor ladder   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      <1/3   351  31.3% [26.7-36.4] |   114  36.8% [28.6-46.0]
                                   1/3-2/3   612  33.2% [29.6-37.0] |   338  29.9% [25.3-35.0]
                                      >2/3  1125  33.2% [30.6-36.1] |   939  38.8% [35.7-41.9]

### charm: 0DTE share of the tenor ladder   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      <1/3   188  34.6% [28.1-41.6] |    84  44.0% [33.9-54.7]
                                   1/3-2/3   654  33.0% [29.5-36.7] |   370  32.2% [27.6-37.1]
                                      >2/3  1243  32.7% [30.1-35.3] |   935  37.4% [34.4-40.6]

### vanna: 0DTE share of the tenor ladder   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      <1/3   435  35.9% [31.5-40.5] |   211  37.0% [30.7-43.7]
                                   1/3-2/3   636  32.9% [29.3-36.6] |   426  32.4% [28.1-37.0]
                                      >2/3  1017  31.7% [28.9-34.6] |   752  38.6% [35.2-42.1]

### tex: 0DTE share of the tenor ladder   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                      <1/3   616  35.6% [31.9-39.4] |   398  35.7% [31.1-40.5]
                                   1/3-2/3   903  31.9% [28.9-35.0] |   552  38.8% [34.8-42.9]
                                      >2/3   562  31.5% [27.8-35.4] |   438  34.2% [30.0-38.8]

### ATM IV change over the prior 30-45 min (vol pts)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                            falling ≤ −0.5   181  27.1% [21.1-34.0] |    84  29.8% [21.0-40.2]
                                      flat  1509  35.1% [32.7-37.5] |  1115  37.6% [34.8-40.5]
                             rising ≥ +0.5   300  30.3% [25.4-35.8] |   141  37.6% [30.0-45.8]

### support: ATM IV change   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                   falling   114  26.3% [19.1-35.1] |    40  20.0% [10.5-34.8]
                                      flat   771  37.1% [33.8-40.6] |   573  34.6% [30.8-38.5]
                                    rising   140  30.0% [23.0-38.0] |    69  46.4% [35.1-58.0]

### resistance: ATM IV change   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                   falling    67  28.4% [19.0-40.1] |    44  38.6% [25.7-53.4]
                                      flat   738  32.9% [29.6-36.4] |   542  40.8% [36.7-45.0]
                                    rising   160  30.6% [24.0-38.2] |    72  29.2% [19.9-40.5]

### strike IV − ATM IV (terciles at 3.07, 10.69)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                       low   480  31.5% [27.5-35.7] |   681  35.8% [32.3-39.5]
                                       mid   727  31.6% [28.4-35.1] |   432  39.1% [34.6-43.8]
                                      high   878  34.9% [31.8-38.1] |   276  33.7% [28.4-39.5]

### local skew slope at the strike (terciles)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                       low   732  35.0% [31.6-38.5] |   430  34.7% [30.3-39.3]
                                       mid   668  29.8% [26.4-33.4] |   486  34.8% [30.7-39.1]
                                      high   685  33.9% [30.4-37.5] |   473  39.7% [35.4-44.2]

### named walls   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                 call wall    99  34.3% [25.7-44.1] |   102  39.2% [30.3-48.9]
                                  put wall    90  40.0% [30.5-50.3] |    70  38.6% [28.0-50.3]
                            0DTE call wall    70  31.4% [21.8-43.0] |    85  35.3% [26.0-45.9]
                             0DTE put wall   111  30.6% [22.8-39.7] |   100  40.0% [30.9-49.8]
                            band max |gex|   115  27.8% [20.5-36.6] |   139  34.5% [27.1-42.8]
                             none of these  1852  33.2% [31.1-35.4] |  1137  36.1% [33.4-39.0]

### regime at the capture   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                            negative gamma  1075  32.2% [29.5-35.0] |   989  36.6% [33.7-39.7]
                            positive gamma   989  33.6% [30.7-36.6] |   400  36.0% [31.4-40.8]

### distance from the capture spot (expected moves)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  <0.25 EM  1510  33.0% [30.7-35.4] |   927  37.9% [34.8-41.0]
                                  0.25-0.5   359  30.4% [25.8-35.3] |   271  32.8% [27.5-38.6]
                                   ≥0.5 EM   219  36.5% [30.4-43.1] |   193  34.7% [28.4-41.7]

### on the desk board at the time   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                  on board   314  33.1% [28.1-38.5] |   245  38.4% [32.5-44.6]
                              not on board  1801  33.0% [30.9-35.2] |  1171  36.0% [33.3-38.8]

### gamma local peak + charm with + vanna×IV with (all three)   (precise)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                                 all three   132  28.8% [21.8-37.0] |   108  34.3% [26.0-43.6]
                             not all three  1983  33.3% [31.3-35.4] |  1308  36.6% [34.1-39.3]

### strong (80 first): top-third |gex| / |charm| / |vanna| / |tex|   (strong)
                                                   EXPLORE 07-20→08-18 |         CONFIRM 08-19→09-17
                             gex top third   991  21.0% [18.6-23.6] |   723  24.2% [21.2-27.5]
                           charm top third   342  20.2% [16.3-24.7] |   243  26.7% [21.6-32.6]
                           vanna top third   328  19.8% [15.9-24.5] |   272  23.9% [19.2-29.3]
                             tex top third   903  19.7% [17.2-22.4] |   708  20.5% [17.7-23.6]
                                       all  2115  21.0% [19.3-22.8] |  1416  20.8% [18.7-23.0]
