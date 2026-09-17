# VOLUME NODES, PASS 2 — declared definition fix (pass 1's LVN hit only 2% of touches, so it was untestable)
node = the strike's traded volume percentile within ±2.5% of spot in a 5-SESSION composite profile (prior sessions only)
LVN = bottom tercile · HVN = top tercile · outcome ≥120 MNQ before the 15 stop (BE 11.1%), secondary ≥80 (BE 15.8%)

fills 1444 · prevalence LVN 23% HVN 47% wall+HVN 13%

## LVN
   LVN  explore: with  10.6% (n= 226)  without   9.7% (n= 632)  gap  +1.0  | ≥80:  14.6% vs  14.7%
   LVN  confirm: with   9.9% (n= 111)  without   5.9% (n= 475)  gap  +4.0  | ≥80:  12.6% vs  13.1%
   → fail

## HVN
   HVN  explore: with   9.3% (n= 367)  without  10.4% (n= 491)  gap  -1.1  | ≥80:  15.8% vs  13.8%
   HVN  confirm: with   6.4% (n= 311)  without   6.9% (n= 275)  gap  -0.5  | ≥80:  14.8% vs  10.9%
   → fail

## wall_LVN
   wall_LVN  explore: with   6.7% (n=  45)  without  10.1% (n= 813)  gap  -3.4  | ≥80:  11.1% vs  14.9%
   wall_LVN  confirm: with  12.2% (n=  41)  without   6.2% (n= 545)  gap  +6.0  | ≥80:  17.1% vs  12.7%
   → fail

## wall_HVN
   wall_HVN  explore: with   5.8% (n= 103)  without  10.5% (n= 755)  gap  -4.6  | ≥80:  11.7% vs  15.1%
   wall_HVN  confirm: with   2.3% (n=  88)  without   7.4% (n= 498)  gap  -5.2  | ≥80:   6.8% vs  14.1%
   → fail

## LVN_nowall
   LVN_nowall  explore: with  11.6% (n= 181)  without   9.5% (n= 677)  gap  +2.1  | ≥80:  15.5% vs  14.5%
   LVN_nowall  confirm: with   8.6% (n=  70)  without   6.4% (n= 516)  gap  +2.2  | ≥80:  10.0% vs  13.4%
   → fail

## wall_HVN_iv
   wall_HVN_iv  explore: with   0.0% (n=  11)  without  10.0% (n= 847)  gap -10.0  | ≥80:  18.2% vs  14.6%
   wall_HVN_iv  confirm: with   0.0% (n=  11)  without   6.8% (n= 575)  gap  -6.8  | ≥80:   0.0% vs  13.2%
   → fail

## trades (net MNQ/trade, 1 MNQ cost)
         group     half  trades  ≥120%  net +120   ≥80%  net +80
           LVN  explore     226   10.6      -0.3   14.6     -1.0
           LVN  confirm     111    9.9      -0.6   12.6     -2.0
           HVN  explore     367    9.3      -1.7   15.8     -0.2
           HVN  confirm     311    6.4      -1.8   14.8     +1.2
      wall_LVN  explore      45    6.7      -5.9   11.1     -5.4
      wall_LVN  confirm      41   12.2      +3.5   17.1     +3.3
      wall_HVN  explore     103    5.8      -6.2   11.7     -3.8
      wall_HVN  confirm      88    2.3      -5.1    6.8     -3.8
    LVN_nowall  explore     181   11.6      +1.0   15.5     +0.1
    LVN_nowall  confirm      70    8.6      -3.0   10.0     -5.1
           ALL  explore     858    9.9      -1.1   14.7     -1.1
           ALL  confirm     586    6.7      -3.2   13.0     -1.3
