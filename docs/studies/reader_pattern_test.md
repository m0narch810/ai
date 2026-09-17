# READERS' SHARED PATTERN vs ALL RESOLVED TOUCHES (precise = +40 before 15 past; good = +80 first, ≤10 overshoot)
                             ALL touches with a book: explore  34.3% good 20.1% n=2037 | confirm  37.0% good 19.8% n=1426

## how common is the condition among PRECISE vs FAILED touches (the readers only saw precise ones)
            gamma_is_max: present in  15.1% of precise ·  15.0% of good ·  17.3% of failed
       gamma_max_or_next: present in  49.1% of precise ·  49.7% of good ·  50.0% of failed
    gamma_heavy5_or_next: present in  39.4% of precise ·  40.9% of good ·  40.2% of failed
               oi_is_max: present in  16.1% of precise ·  15.9% of good ·  17.9% of failed
          oi_max_or_next: present in  52.4% of precise ·  52.0% of good ·  54.5% of failed
       oi_heavy5_or_next: present in  44.5% of precise ·  46.0% of good ·  46.5% of failed
            theta_is_max: present in  17.0% of precise ·  15.7% of good ·  20.2% of failed
       theta_max_or_next: present in  58.0% of precise ·  57.4% of good ·  59.1% of failed
    theta_heavy5_or_next: present in  55.2% of precise ·  55.1% of good ·  57.8% of failed
                    is_5: present in  17.2% of precise ·  16.3% of good ·  21.2% of failed
              near_flip3: present in  54.2% of precise ·  53.6% of good ·  53.1% of failed
            flip_side_ok: present in  62.9% of precise ·  63.7% of good ·  64.9% of failed
             new_extreme: present in  17.7% of precise ·  18.3% of good ·  18.5% of failed
               retest_35: present in  69.7% of precise ·  68.1% of good ·  69.1% of failed
       two_prior_precise: present in  30.8% of precise ·  30.3% of good ·  24.6% of failed
               shape_any: present in  91.4% of precise ·  90.9% of good ·  91.0% of failed
          inside_touched: present in  80.8% of precise ·  79.8% of good ·  79.9% of failed

## precise rate WITH the condition vs WITHOUT, by half
                          gamma_heavy5_or_next = yes: explore  32.1% good 19.5% n= 835 | confirm  39.3% good 21.9% n= 547
                           gamma_heavy5_or_next = no: explore  35.9% good 20.5% n=1202 | confirm  35.6% good 18.5% n= 879
                             oi_heavy5_or_next = yes: explore  33.0% good 19.4% n=1018 | confirm  36.9% good 21.4% n= 566
                              oi_heavy5_or_next = no: explore  35.6% good 20.8% n=1019 | confirm  37.1% good 18.8% n= 858
                          theta_heavy5_or_next = yes: explore  32.9% good 18.9% n=1192 | confirm  36.7% good 20.0% n= 771
                           theta_heavy5_or_next = no: explore  36.3% good 21.6% n= 838 | confirm  37.4% good 19.6% n= 652
                                  gamma_is_max = yes: explore  29.0% good 17.5% n= 338 | confirm  37.2% good 19.2% n= 234
                                   gamma_is_max = no: explore  35.4% good 20.6% n=1699 | confirm  37.0% good 20.0% n=1192
                                          is_5 = yes: explore  28.0% good 15.0% n= 393 | confirm  34.6% good 18.5% n= 292
                                           is_5 = no: explore  35.8% good 21.3% n=1644 | confirm  37.7% good 20.2% n=1134
                                    near_flip3 = yes: explore  34.0% good 20.3% n=1044 | confirm  38.3% good 19.7% n= 809
                                     near_flip3 = no: explore  34.6% good 19.8% n= 993 | confirm  35.3% good 20.1% n= 617
                                  flip_side_ok = yes: explore  33.5% good 21.0% n=1326 | confirm  36.5% good 18.2% n= 898
                                   flip_side_ok = no: explore  35.9% good 18.4% n= 711 | confirm  37.9% good 22.7% n= 528
                                     shape_any = yes: explore  34.4% good 20.0% n=1866 | confirm  37.1% good 19.8% n=1300
                                      shape_any = no: explore  33.1% good 20.4% n= 181 | confirm  36.5% good 20.6% n= 126
                                inside_touched = yes: explore  34.5% good 20.0% n=1644 | confirm  37.3% good 19.6% n=1142
                                 inside_touched = no: explore  33.3% good 20.1% n= 403 | confirm  35.9% good 20.8% n= 284

## the recipes
reader 3: theta heavy-5±1 + touched inside + flip side: explore  32.0% good 20.6% n= 591 | confirm  36.5% good 16.9% n= 373
                                                 not: explore  35.2% good 19.8% n=1456 | confirm  37.2% good 20.9% n=1053
    reader 2: gamma heavy-5±1 + ≤3 from flip + shape: explore  31.8% good 19.8% n= 459 | confirm  39.0% good 20.3% n= 305
                                                 not: explore  34.9% good 20.1% n=1588 | confirm  36.5% good 19.7% n=1121
                                reader 2 recipe, RTH: explore  32.9% good 22.7% n= 304 | confirm  40.1% good 21.9% n= 192
                                            not, RTH: explore  30.8% good 16.9% n= 673 | confirm  35.6% good 19.2% n= 458
                                reader 2 recipe, ETH: explore  29.7% good 14.2% n= 155 | confirm  37.2% good 17.7% n= 113
                                            not, ETH: explore  38.0% good 22.4% n= 915 | confirm  37.1% good 20.1% n= 663

## READER 4 (P36-P47): tested + mass within ±2 + wall/flip within 2
                  tested: present in  85.6% of precise ·  85.1% of good ·  84.6% of failed
            mass_within2: present in  85.3% of precise ·  86.0% of good ·  84.5% of failed
    wall_or_flip_within2: present in  82.1% of precise ·  83.1% of good ·  80.5% of failed
     own_2nd_order_small: present in  48.7% of precise ·  48.4% of good ·  48.4% of failed
                                     reader 4 recipe: explore  35.0% good 21.0% n=1226 | confirm  37.8% good 20.2% n= 986
                                                 not: explore  33.1% good 18.6% n= 821 | confirm  35.2% good 19.1% n= 440
        reader 4 recipe + own charm/vanna/vega small: explore  34.9% good 21.3% n= 765 | confirm  40.0% good 19.9% n= 403
                                                 not: explore  33.9% good 19.3% n=1282 | confirm  35.9% good 19.8% n=1023

## READER 1 (P00-P11): retest + flip within 1.2 at some capture in 2 h + busiest-volume strike at the level or 1-2 on the approach side
                      tested: present in  85.6% of precise ·  85.1% of good ·  84.6% of failed
           flip_within12_any: present in  45.6% of precise ·  44.9% of good ·  46.1% of failed
    busiest_at_or_approach12: present in  39.8% of precise ·  37.9% of good ·  38.6% of failed
                                     reader 1 recipe: explore  34.8% good 20.8% n= 414 | confirm  38.5% good 18.2% n= 351
                                                 not: explore  34.1% good 19.8% n=1633 | confirm  36.6% good 20.4% n=1075
                                reader 1 recipe, RTH: explore  34.8% good 21.3% n= 287 | confirm  42.5% good 20.2% n= 252
                                            not, RTH: explore  30.0% good 17.7% n= 690 | confirm  33.4% good 19.8% n= 398
                                reader 1 recipe, ETH: explore  34.6% good 19.7% n= 127 | confirm  28.3% good 13.1% n=  99
                                            not, ETH: explore  37.1% good 21.4% n= 943 | confirm  38.4% good 20.7% n= 677
