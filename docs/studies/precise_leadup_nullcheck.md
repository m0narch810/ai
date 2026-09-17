# NULL CHECK FOR THE MATCHED-PAIR SIGNAL

## A. labels shuffled WITHIN each session day + side, same pairing (a real effect → real share far from the shuffled share)
                   feature real share shuffled mean   shuffled range
      dist_session_extreme       0.19          0.50    0.47-0.54
                   into_60       0.66          0.49    0.47-0.51
                  into_120       0.66          0.49    0.45-0.53
  k_beyond_session_extreme       0.73          0.50    0.40-0.60
  prior_touches_other_side       0.38          0.48    0.46-0.53
   vol_tot_behind_vs_front       0.36          0.52    0.49-0.55
                   d_iv_60       0.58          0.50    0.43-0.55
                charm_with       0.62          0.46    0.40-0.52
                   iv_prem       0.56          0.50    0.45-0.53

## B. unconditional precise rate (all resolved touches), by half

### new session extreme
    level is a new session extreme: explore  32.8% n= 378 | confirm  36.6% n= 254
          inside the session range: explore  34.6% n=1669 | confirm  37.1% n=1172

### distance to the session extreme
          <30 MNQ from the extreme: explore  32.9% n= 586 | confirm  40.2% n= 405
                            30-100: explore  36.1% n= 402 | confirm  39.2% n= 380
                              ≥100: explore  34.3% n=1059 | confirm  33.7% n= 641

### direction of the last hour
  moved INTO the level over 60 min: explore  34.1% n=1112 | confirm  39.1% n= 765
            moved AWAY / came back: explore  34.4% n= 935 | confirm  34.6% n= 661

### earlier touches from the other side today
      0 earlier other-side touches: explore  33.2% n= 635 | confirm  37.8% n= 426
                               1-2: explore  34.9% n= 654 | confirm  35.8% n= 503
                                3+: explore  34.6% n= 758 | confirm  37.6% n= 497

## C. within-day stratified (Mantel-Haenszel odds ratio of precise for 'new session extreme', strata = session day × side)
  explore: MH odds ratio 1.06
  confirm: MH odds ratio 1.11

## D. the timing-overlap test: same pairing, but partners must be ≥ N hours apart (no lead-up window can contain the other touch's run)
                   feature   0-3 h (orig)         ≥2.5 h           ≥4 h
      dist_session_extreme           0.19           0.40           0.42
                   into_60           0.66           0.52           0.54
                  into_120           0.66           0.53           0.53
  k_beyond_session_extreme           0.73           0.56           0.53
  prior_touches_other_side           0.38           0.44           0.46
   vol_tot_behind_vs_front           0.36           0.45           0.48
                   d_iv_60           0.58           0.54           0.50
                charm_with           0.62           0.53           0.54
                   iv_prem           0.56           0.50           0.46
                     pairs           1103           1192           1159
