# LIVE-FEED PRECISION STUDY — summary (2026-09-17)
Script `scripts/study_ledger_greeks.py`; full tables `live_precision_report.md`. Data: 60 days of NQ=F 5-min
bars (RTH + Globex) converted to QQQ, 1-min for the last 30 days as a check, and the desk's own YYY cloud
captures (1,669 captures, per-strike gex/charm/vanna/theta/vega/dex, 0DTE slices, tenor ladders, OI,
volume, strike IV). Pre-registered design in the script docstring; explore 07-20→08-18, confirm 08-19→09-17.

Definition (the user's): a touch reaches within 0.15 of the level after price was ≥0.50 away; **precise**
= runs 40 MNQ from the level before going 15 MNQ past it; **strong** = runs 80 first.
The user's three examples (09-17 712 support, 09-16 700 support, 09-16 712 resistance) are all found and
all grade precise and strong, at both 1-min and 5-min resolution.

## 1. Precise reactions are common — and just as common where there are no options
| | whole strikes | half-strikes (no options) |
|---|---|---|
| RTH precise | 32.1% (n=1703) | 33.9% (n=1712) |
| ETH precise | 36.5% (n=1873) | 37.6% (n=1865) |
| RTH strong | 20.4% | 21.6% |
| ETH strong | 21.3% | 22.8% |
1-min check (last 30 days): 37.7 vs 37.2 RTH, 37.8 vs 39.0 ETH. Median overshoot when price traded
through: 10.0 vs 10.4 MNQ. A precise touch happens on about a third of all touches at any price.

## 2. Nothing in the book at the strike picks them (bar: same sign in both halves, non-overlapping confirm CIs)
Nothing cleared the bar. Every |greek| rank, local peak, sign, 0DTE share, strike-IV premium, skew slope,
named wall, regime, distance and desk-board membership sits between 27% and 41% in both halves, with
direction flipping between halves for most. Specifically:
- **gamma** top third 33.4% / 40.7% vs bottom third 32.1% / 33.5% — no effect in the first half.
- **charm** top third 32.2% / 37.0%; dealer charm flow WITH the side 31.5% / 37.0% vs against 35.2% / 35.0%.
- **vanna** local peak 31.7% / 41.3% (flips); vanna×IV flow with the side 33.6% / 37.0% vs against 33.4% / 38.1%.
- **theta** top third 33.2% / 37.0% vs middle 33.2% / 37.3%.
- **gamma peak + charm with + vanna×IV with (all three)**: 28.8% / 34.3% vs 33.3% / 36.6% — slightly WORSE both halves.
- **band max |gex|** 27.8% / 34.5% vs no named level 33.2% / 36.1% — slightly worse both halves.
- **named put wall** 40.0% / 38.6% (n=90/70) — best named cell, CIs overlap the base.
- **on the desk board** 33.1% / 38.4% vs off 33.0% / 36.0%.

## 3. The one thing that held again: IV into the level
ATM IV change over the prior 30-45 min: falling ≤−0.5 vol pt 27.1% / 29.8% vs flat 35.1% / 37.6%.
**Supports reached on falling IV: 26.3% (n=114) / 20.0% (n=40) vs flat 37.1% / 34.6%** — the same avoid
rule as the 2022-24 approach test, the 2025 forward test, the IV-walls test and the whole-chain test.
Fifth independent replication, now on the live feed. Confirm-half CIs just overlap (n=40).

## 4. Day-level
Precise rate per session day: median 36%, IQR 31–39%, range 23–48% over 43 days. 2026-09-17: RTH 14% (n=7,
the post-FOMC gap day before triple witching), ETH 32%.
