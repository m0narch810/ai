# RECIPE AS TRADES — RTH, limit at the strike, trade-through fill within 30 min, 15-MNQ stop, 5m bars, cost 1.0 MNQ/round trip
A = +40 target (BE 27.3%) · B = +80 target (BE 15.8%) · C = let it run (breakeven after +40, out 15:55) · MNQ pts per trade

## EXPLORE
                                   group touches  filled trades/day | A win%  A net | B win%  B net |  C net   C tot
                         all RTH touches     977     93%       41.4 |  22.2%   -3.6 |  14.6%   -1.3 |   -0.4    -335
                                  recipe     287     92%       12.0 |  22.8%   -3.2 |  15.2%   -0.5 |   -2.5    -659
     recipe minus supports on falling IV     252     91%       10.5 |  24.3%   -2.3 |  16.1%   +0.5 |   -2.7    -623
                               no recipe     690     94%       29.5 |  21.9%   -3.8 |  14.4%   -1.6 |   +0.5    +324
  no recipe minus supports on falling IV     609     94%       26.0 |  22.2%   -3.7 |  14.8%   -1.1 |   +1.4    +788
            supports on falling IV (any)     116     93%        4.9 |  17.6%   -6.3 |  10.2%   -6.0 |   -4.6    -501
                                         gross (no cost) for reference: all A -2.6 · recipe A -2.2 · recipe−avoid A -1.3

## CONFIRM
                                   group touches  filled trades/day | A win%  A net | B win%  B net |  C net   C tot
                         all RTH touches     650     90%       27.9 |  25.6%   -1.4 |  13.0%   -1.3 |   -6.0   -3491
                                  recipe     252     90%       10.8 |  31.3%   +1.9 |  12.8%   -0.7 |   -3.5    -792
     recipe minus supports on falling IV     228     90%        9.8 |  31.7%   +2.2 |  13.2%   -0.0 |   -2.8    -567
                               no recipe     398     90%       17.1 |  22.0%   -3.5 |  13.1%   -1.7 |   -7.5   -2699
  no recipe minus supports on falling IV     376     90%       16.2 |  22.6%   -3.1 |  13.5%   -1.2 |   -7.1   -2425
            supports on falling IV (any)      46     89%        2.0 |  19.5%   -5.3 |   7.3%   -9.0 |  -12.2    -499
                                         gross (no cost) for reference: all A -0.4 · recipe A +2.9 · recipe−avoid A +3.2
# RECIPE AS TRADES — RTH, limit at the strike, trade-through fill within 30 min, 15-MNQ stop, 1m bars, cost 1.0 MNQ/round trip
A = +40 target (BE 27.3%) · B = +80 target (BE 15.8%) · C = let it run (breakeven after +40, out 15:55) · MNQ pts per trade

## CONFIRM
                                   group touches  filled trades/day | A win%  A net | B win%  B net |  C net   C tot
                         all RTH touches     621     89%       26.3 |  26.8%   -0.7 |  13.4%   -0.8 |   -5.8   -3200
                                  recipe     242     89%       10.3 |  32.9%   +2.8 |  13.9%   +1.0 |   -2.2    -468
     recipe minus supports on falling IV     219     89%        9.3 |  32.8%   +2.9 |  13.8%   +1.4 |   -2.3    -441
                               no recipe     379     89%       16.0 |  22.9%   -3.0 |  13.1%   -2.0 |   -8.1   -2732
  no recipe minus supports on falling IV     359     89%       15.2 |  23.8%   -2.5 |  13.8%   -1.3 |   -7.8   -2475
            supports on falling IV (any)      43     88%        1.8 |  21.1%   -4.4 |   7.9%   -8.5 |   -7.5    -284
                                         gross (no cost) for reference: all A +0.3 · recipe A +3.8 · recipe−avoid A +3.9
