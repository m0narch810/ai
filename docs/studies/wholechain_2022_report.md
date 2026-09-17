# WHOLE-CHAIN WALLS 2022 — 167 days, 2155 first approaches (TD Ameritrade full chain × ThetaData IV tape × NQ bars)

### strike class by the 09:36 whole-chain book
                      group    n  fill%  win|res%    ci  n_res  exp MNQ/fill
           heavy: 0DTE only  354     85      33.9 29-40    286           1.7
heavy: whole chain AND 0DTE  372     88      31.7 27-37    312          -0.8
    heavy: whole chain only  361     85      31.9 27-38    282          -0.9
                      light 1068     86      34.3 31-38    849           2.1

### side × class
                                   group   n  fill%  win|res%    ci  n_res  exp MNQ/fill
           resistance · heavy: 0DTE only 182     84      32.9 26-41    149          -0.2
resistance · heavy: whole chain AND 0DTE 185     90      31.8 25-39    157          -0.4
    resistance · heavy: whole chain only 177     87      33.6 26-42    140           0.6
                      resistance · light 535     86      35.5 31-40    420           3.6
              support · heavy: 0DTE only 172     87      35.0 28-43    137           3.6
   support · heavy: whole chain AND 0DTE 187     87      31.6 25-39    155          -1.1
       support · heavy: whole chain only 184     83      30.3 23-38    142          -2.4
                         support · light 533     86      33.1 29-38    429           0.7

### class × IV state at approach
                                group   n  fill%  win|res%    ci  n_res  exp MNQ/fill
           heavy: 0DTE only · falling 123     82      30.9 23-41     97          -2.4
              heavy: 0DTE only · flat  65     86      29.4 19-43     51          -2.1
            heavy: 0DTE only · rising 110     87      32.6 24-43     89           0.7
heavy: whole chain AND 0DTE · falling 137     88      32.2 24-41    115          -1.1
   heavy: whole chain AND 0DTE · flat  86     86      25.7 17-37     74          -9.2
 heavy: whole chain AND 0DTE · rising 104     89      31.7 23-42     82           1.7
    heavy: whole chain only · falling 138     85      27.0 20-36    111          -7.6
       heavy: whole chain only · flat  75     84      47.5 36-60     61          16.5
     heavy: whole chain only · rising 134     85      27.8 20-37     97          -3.4
                      light · falling 399     85      36.1 31-41    324           4.0
                         light · flat 213     86      31.0 25-38    174          -2.3
                       light · rising 370     86      35.8 30-42    274           4.7

### WHOLE-CHAIN HEAVY: side × IV
               group   n  fill%  win|res%    ci  n_res  exp MNQ/fill
resistance · falling 138     87      35.1 27-44    111           2.1
   resistance · flat  78     91      36.6 26-48     71           3.9
 resistance · rising 117     87      23.9 16-34     88          -7.3
   support · falling 137     85      24.3 17-33    115         -10.8
      support · flat  83     80      34.4 24-47     64           1.2
    support · rising 121     87      35.2 26-45     91           4.9

### the NAMED whole-chain wall (call/put gex wall or call/put OI wall) vs everything else
 group    n  fill%  win|res%    ci  n_res  exp MNQ/fill
 False 1993     86      33.8 31-36   1594           1.5
  True  162     88      28.9 22-37    135          -4.4

### NAMED wall × side × IV
               group  n  fill%  win|res%    ci  n_res  exp MNQ/fill
resistance · falling 35     89      33.3 19-51     30           0.8
   resistance · flat 23     91      26.3 12-49     19          -5.9
 resistance · rising 22     86      17.6  6-41     17         -17.9
   support · falling 29     90      19.2  9-38     26         -16.9
      support · flat 16     94      26.7 11-52     15          -8.0
    support · rising 25     84      47.4 27-68     19          17.8

### by whole-chain defending OI vs band median
 group   n  fill%  win|res%    ci  n_res  exp MNQ/fill
 <0.5x 181     87      42.6 35-51    148          11.7
0.5-1x 752     87      31.7 28-35    612          -1.0
  1-2x 610     84      35.4 31-40    475           3.3
  2-4x 187     86      35.1 28-43    148           3.8
 4-10x 194     88      33.1 26-41    157          -0.1
  >10x 231     87      25.4 20-32    189          -7.7

### prior-evening (15:51) whole-chain heavy vs light
              group    n  fill%  win|res%    ci  n_res  exp MNQ/fill
prior-evening heavy  740     86      30.6 27-34    589          -2.0
prior-evening light 1415     86      34.8 32-38   1140           2.6

### PRIOR-EVENING HEAVY × side × IV
               group   n  fill%  win|res%    ci  n_res  exp MNQ/fill
resistance · falling 137     85      31.8 24-41    107          -1.6
   resistance · flat  79     91      35.2 25-47     71           2.7
 resistance · rising 111     86      23.5 16-34     81          -6.7
   support · falling 136     85      26.3 19-35    114          -8.5
      support · flat  80     82      30.2 20-42     63          -3.6
    support · rising 116     84      33.3 24-44     81           3.5

for reference — the same test on 0DTE-only heaviness, 2022, from approach_2224: 0DTE heavy=True: 29.9% (n=278) · 0DTE heavy=False: 33.6% (n=1296) · 
