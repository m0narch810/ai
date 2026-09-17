"""
Render one text "tape" per session from the state tape — every 5 minutes: price, IV, expected
move, the 0DTE flip / walls / OI walls / IV walls, concentration, sums, HOD/LOD — followed by the
day's level contacts and what each did on a 15-MNQ stop. For a qualitative, open-ended read
(by a person or an agent): nothing is pre-classified.

    python scripts/render_tapes.py --tag 222324 --out data/study/tapes [--dates 2023-03-13,...] [--sample 60 --seed 7]
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "study")
MNQ = 40.7


def f2(x, d=2): return "  —  " if x is None or not np.isfinite(x) else f"{x:.{d}f}"
def sig(x):
    if x is None or not np.isfinite(x): return "   —"
    a = abs(x); s = "+" if x >= 0 else "−"
    return f"{s}{a / 1e9:.1f}B" if a >= 1e9 else f"{s}{a / 1e6:.0f}M" if a >= 1e6 else f"{s}{a / 1e3:.0f}k"


def render(tape, con, date):
    t = tape[tape.date == date].sort_values("tick"); c = con[con.date == date].sort_values("hm")
    if t.empty: return None
    r0 = t.iloc[0]
    lines = [f"# {date} · open {f2(r0.day_open)} · E0 {f2(r0.E)} pts ({f2(r0.E * MNQ, 0)} MNQ) · ATM IV {100 * r0.atm_iv:.1f}% · frozen IV walls {f2(r0.ivl_out_frz)} / {f2(r0.ivl_in_frz)} ↔ {f2(r0.ivu_in_frz)} / {f2(r0.ivu_out_frz)}",
             "# columns: time | spot (vs open in E0, the expected move at 09:35) | ATM IV (Δ30m vol pts) | E to close | flip · major · call wall · put wall · call-OI wall · put-OI wall | live IV walls lo/hi | conc1 | net gex · charm · vanna (dealer flows, + = dealers buy) | HOD LOD",
             "#  Δ marks = the level moved since the previous line", ""]
    prev = None
    for r in t.itertuples():
        def lv(name, v):
            moved = prev is not None and np.isfinite(v) and np.isfinite(getattr(prev, name)) and v != getattr(prev, name)
            return f"{f2(v, 0) if name not in ('ivu_in', 'ivl_in') else f2(v, 1)}{'Δ' if moved else ' '}"
        lines.append(f"{r.tick} | {r.F:8.2f} ({(r.F - r.day_open) / r0.E:+.2f}E0) | IV {100 * r.atm_iv:5.1f} ({100 * r.d_iv30:+.1f}) | E {r.E:4.2f} | flip {lv('flip', r.flip)} maj {lv('major', r.major)} cw {lv('cwall', r.cwall)} pw {lv('pwall', r.pwall)} cOI {lv('coi_wall', r.coi_wall)} pOI {lv('poi_wall', r.poi_wall)} | IVw {lv('ivl_in', r.ivl_in)}/{lv('ivu_in', r.ivu_in)} | c1 {r.conc1:.2f} | gex {sig(r.net_gex)} ch {sig(r.charm_sum)} va {sig(r.vanna_sum)} | H {r.hod:.2f} L {r.lod:.2f}")
        prev = r
    lines += ["", "## contacts (first touch of each level; outcome with a 15-MNQ stop; run = max favourable move before the stop or the close)"]
    for r in c.itertuples():
        if not r.filled: lines.append(f"{r.hm} {r.ltype:>10} {r.K:8.2f} {r.side:>10}  not filled (touched, did not trade through)"); continue
        st = "SURVIVED" if r.surv15 else f"stopped @{int(r.tstop15)}m"
        lines.append(f"{r.hm} {r.ltype:>10} {r.K:8.2f} {r.side:>10}  15-stop: {st:>12} · ran {r.mfe15:5.0f} MNQ · with 40-stop ran {r.mfe40:5.0f} · to close {r.pnl_close:+5.0f}")
    return "\n".join(lines)


def main():
    tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else "222324"
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(OUT, "tapes")
    os.makedirs(out, exist_ok=True)
    tape = pd.read_parquet(os.path.join(OUT, f"state_tape_{tag}.parquet")); con = pd.read_parquet(os.path.join(OUT, f"contacts_{tag}.parquet"))
    dates = sorted(tape.date.unique())
    if "--dates" in sys.argv: dates = sys.argv[sys.argv.index("--dates") + 1].split(",")
    elif "--sample" in sys.argv:
        n = int(sys.argv[sys.argv.index("--sample") + 1]); seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 7
        rng = np.random.default_rng(seed); dates = sorted(rng.choice(dates, size=min(n, len(dates)), replace=False))
    for d in dates:
        s = render(tape, con, d)
        if s: open(os.path.join(out, f"{d}.txt"), "w", encoding="utf-8").write(s)
    print("rendered", len(dates), "tapes →", out)


if __name__ == "__main__":
    main()
