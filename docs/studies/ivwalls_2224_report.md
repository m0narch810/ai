# IV WALLS 2022-24 — 665 days

## DRIFT of the LIVE bracket through the session (per day medians)
inner width at open 6.59 pts → at close 1.62 pts (ratio 4.1x)
upper inner: intraday range 4.80 pts = 1.28 E0 · median |15-min move| 0.34 pts
lower inner: intraday range 5.72 pts = 1.52 E0 · median |15-min move| 0.40 pts
open bracket half-width vs E0: upper inner 0.85 E0, lower inner 0.91 E0 (outer +0.77 / +0.88 pts)

## REACH + OUTCOME by variant × wall (limit AT the wall, 40/80 MNQ; 'held' = rejected 80 before overshoot 40, fill or not)

### variant × wall
         group  days  reached%  filled%  win|res%     ci  n_res  held%  exp MNQ/fill  over med MNQ
live · l_inner   381        42       55      17.6   8-34     34   48.0          -0.8           2.8
live · l_outer   646         0       50     100.0 21-100      1  100.0          80.0         124.1
live · u_inner   367        52       44      37.5  21-57     24   65.0           2.3          -2.5
live · u_outer   633         0       50       NaN             0  100.0          44.8          -0.8
open · l_inner   660        37       85      34.3  28-42    178   50.5           2.6          49.5
open · l_outer   654        25       80      28.7  21-38    115   43.5          -2.9          49.8
open · u_inner   657        41       80      28.1  22-35    178   48.9          -3.9          42.8
open · u_outer   658        28       83      28.9  21-38    114   44.9          -1.8          38.6
 t10 · l_inner   657        36       83      33.3  27-41    168   49.3           2.4          46.1
 t10 · l_outer   659        25       81      28.6  21-38    105   47.8          -1.3          35.7
 t10 · u_inner   659        41       81      29.5  23-37    156   50.2          -1.6          32.1
 t10 · u_outer   654        28       76      22.8  15-32     92   46.8          -6.3          28.9

## PLACEBO — frozen brackets displaced 0.25 E0 further out (same construction, wrong level)

### open-frozen: real vs displaced
          group  days  reached%  filled%  win|res%    ci  n_res  held%  exp MNQ/fill  over med MNQ
False · l_inner   660        37       85      34.3 28-42    178   50.5           2.6          49.5
False · l_outer   654        25       80      28.7 21-38    115   43.5          -2.9          49.8
False · u_inner   657        41       80      28.1 22-35    178   48.9          -3.9          42.8
False · u_outer   658        28       83      28.9 21-38    114   44.9          -1.8          38.6
 True · l_inner   655        25       83      31.4 24-40    118   48.3          -0.0          48.0
 True · l_outer   657        16       83      26.0 17-37     77   45.7          -4.9          52.9
 True · u_inner   660        26       84      22.5 16-32    102   38.1          -5.7          38.5
 True · u_outer   658        17       78      27.3 17-40     55   46.6          -2.2          26.0

## FROZEN-AT-OPEN bracket by year

### open × year
         group  days  reached%  filled%  win|res%    ci  n_res  held%  exp MNQ/fill  over med MNQ
2022 · l_inner   165        39       94      32.1 21-45     53   44.8           0.5          69.1
2022 · l_outer   164        30       84      34.2 21-50     38   44.2           3.5          73.0
2022 · u_inner   165        36       78      31.7 20-47     41   54.9          -0.8          45.8
2022 · u_outer   165        25       88      28.6 15-47     28   48.5          -4.7          41.1
2023 · l_inner   247        36       78      32.1 21-45     53   55.3          -0.1          33.6
2023 · l_outer   245        24       73      31.2 18-49     32   51.2           1.4          25.8
2023 · u_inner   246        44       79      23.1 15-35     65   45.2          -7.0          39.0
2023 · u_outer   246        30       84      22.4 13-36     49   35.1          -7.1          41.3
2024 · l_inner   248        38       85      37.5 27-49     72   50.0           6.6          48.3
2024 · l_outer   245        22       85      22.2 13-36     45   36.5         -12.4          84.8
2024 · u_inner   246        41       83      30.6 21-42     72   48.8          -2.3          43.3
2024 · u_outer   247        27       79      37.8 24-54     37   54.2           6.6          32.2

## FROZEN-AT-OPEN: by IV state at the approach (t-1)

### open × wall × IV class
            group  days  reached%  filled%  win|res%    ci  n_res  held%  exp MNQ/fill  over med MNQ
l_inner · falling    53       100       85      21.1 11-36     38   37.5          -9.6          60.5
   l_inner · flat    88       100       81      40.3 29-53     62   56.8           8.9          34.0
 l_inner · rising   106       100       88      35.9 26-47     78   51.7           3.8          53.0
l_outer · falling    29       100       83      20.8  9-40     24   34.5         -15.0          74.2
   l_outer · flat    45       100       80      24.1 12-42     29   41.7          -4.3          49.7
 l_outer · rising    90       100       80      33.9 23-46     62   47.9           1.9          40.2
u_inner · falling   154       100       82      32.1 24-41    112   51.4          -1.0          46.1
   u_inner · flat    85       100       82      14.0  7-26     50   35.5         -14.5          46.7
 u_inner · rising    31       100       68      43.8 23-67     16   71.4          14.6          22.4
u_outer · falling   102       100       85      35.6 26-47     73   52.3           4.1          40.9
   u_outer · flat    48       100       88      10.7  4-27     28   26.5         -12.1          43.0
 u_outer · rising    33       100       70      30.8 13-58     13   43.8          -5.8          12.8

## FROZEN-AT-OPEN: by time of day reached

### open × time × wall
                 group  days  reached%  filled%  win|res%    ci  n_res  held%  exp MNQ/fill  over med MNQ
    <90 left · l_inner    23       100       65       0.0  0-32      8   53.8         -22.0          17.6
    <90 left · l_outer    22       100       59      25.0  7-59      8   50.0           0.2           7.7
    <90 left · u_inner    31       100       55      12.5  2-47      8   58.3          -7.2           3.8
    <90 left · u_outer    34       100       65      50.0 24-76     10   69.2           6.9           6.4
      90-240 · l_inner    63       100       83      42.1 28-58     38   61.2          11.4          28.2
      90-240 · l_outer    51       100       76      29.4 17-46     34   48.8          -4.0          35.6
      90-240 · u_inner    64       100       83      24.3 13-40     37   42.6          -6.9          35.2
      90-240 · u_outer    50       100       92      20.0 10-36     35   24.3          -8.4          44.5
>240 morning · l_inner   161       100       88      34.1 27-43    132   46.8           2.0          67.0
>240 morning · l_outer    91       100       88      28.8 20-40     73   40.0          -2.8          77.5
>240 morning · u_inner   175       100       84      30.1 23-38    133   50.0          -2.4          54.3
>240 morning · u_outer    99       100       85      30.4 21-42     69   50.0          -0.5          43.6

## by distance of the frozen wall from the open in E0

### open × distance
   group  days  reached%  filled%  win|res%    ci  n_res  held%  exp MNQ/fill  over med MNQ
0.6-0.9E   344       100       83      29.2 24-35    236   49.0          -3.2          46.3
0.9-1.2E   459       100       83      31.0 26-36    310   46.4           0.0          40.6
   >1.2E    61       100       75      30.8 19-46     39   48.0          -0.6          39.0
