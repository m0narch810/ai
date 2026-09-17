"""
VOLUME NODES × WALLS × IV — the user's idea: use the NQ tape's volume-at-price together with the options book.

PRE-REGISTERED 2026-09-17 before these outcomes were computed.
PROFILE   volume-at-price built from the NQ 5-min bars converted to QQQ, each bar's volume spread evenly over its
          range into 0.10-pt bins. Two profiles per touch, both strictly before it: PRIOR = the previous two RTH
          sessions; TODAY = today's RTH bars so far. A strike's volume = the bins within ±0.25 of it.
NODE      at a strike, versus the ±1.5%-of-spot band of the same profile:
          LVN = volume ≤ 60% of the band median AND lower than the strike ±1 either side
          HVN = volume ≥ 140% of the band median AND higher than both neighbours
WALL      |gamma| ≥ 50% of the band max, or OI ≥ 70% of the band max, at the last capture before the touch.
IV        "with the side" = support with ATM IV rising ≥0.5 vol pt over ~60 min, resistance with it falling ≥0.5.
OUTCOME   filled trade (limit at the strike, trade-through within 30 min, 15-MNQ stop) running ≥120 MNQ before
          going 15 past (BE 11.1%); secondary ≥80 (BE 15.8%); net MNQ/trade, 1 MNQ cost.
FILTERS   G1 LVN (prior)        G2 HVN (prior)        G3 wall + LVN (the desk's old doctrine: cleanest rejection)
          G4 wall + HVN         G5 LVN without a wall (doctrine: accelerant, should be WORSE)
          G6 wall + IV with the side                  G7 wall + LVN + IV with the side
          G8 ≥0.5E from the prior profile's POC       G9 LVN (today)      G10 HVN (today)
          G11 outside the prior session's value area (70%)
PASS      with − without ≥ +3 pts on ≥120 in BOTH live halves, ≥100 trades with the filter per half. Anything that
          passes is then re-run unchanged on 2022-23 (the NQ file has volume there too) before it means anything.
    python scripts/study_volnode.py
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
import study_precise_leadup as P
import study_far_travel as FT
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0
BIN = 0.10


def profile(bars):
    """volume-at-price: each bar's volume spread evenly over its range into BIN-wide bins → {bin_index: volume}"""
    acc = {}
    for lo, hi, v in zip(bars.lq.to_numpy(), bars.hq.to_numpy(), bars.v.to_numpy(dtype=float)):
        if not np.isfinite(v) or v <= 0 or not np.isfinite(lo) or not np.isfinite(hi): continue
        a, b = int(np.floor(lo / BIN)), int(np.floor(hi / BIN))
        n = b - a + 1
        share = v / n
        for k in range(a, b + 1): acc[k] = acc.get(k, 0.0) + share
    return acc


def at(acc, price, halfwidth=0.25):
    a, b = int(np.floor((price - halfwidth) / BIN)), int(np.floor((price + halfwidth) / BIN))
    return sum(acc.get(k, 0.0) for k in range(a, b + 1))


def node_flags(acc, K, spot):
    """LVN / HVN of strike K against the ±1.5% band of this profile."""
    lo, hi = spot * 0.985, spot * 1.015
    ks = [k for k in range(int(np.floor(lo)), int(np.ceil(hi)) + 1)]
    vols = {k: at(acc, k) for k in ks}
    live = [v for v in vols.values() if v > 0]
    if len(live) < 8 or K not in vols: return np.nan, np.nan, np.nan, np.nan
    med = float(np.median(list(vols.values())))
    v0 = vols[K]; nb = [vols.get(K - 1, np.nan), vols.get(K + 1, np.nan)]
    lvn = bool(med > 0 and v0 <= 0.6 * med and all(np.isfinite(x) and v0 < x for x in nb))
    hvn = bool(med > 0 and v0 >= 1.4 * med and all(np.isfinite(x) and v0 > x for x in nb))
    poc = max(vols, key=vols.get)
    # 70% value area around the POC
    tot = sum(vols.values()); order = sorted(vols, key=lambda k: -vols[k]); cum = 0.0; va = []
    for k in order:
        cum += vols[k]; va.append(k)
        if cum >= 0.7 * tot: break
    return lvn, hvn, float(poc), bool(K < min(va) or K > max(va))


def build():
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    nq = L.load_bars("5m"); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d"); nq["min_"] = nq.t.dt.hour * 60 + nq.t.dt.minute
    rth = nq[(nq.min_ >= 570) & (nq.min_ < 960)]
    days = sorted(rth.date_.unique())
    prior_prof = {}
    for i, d in enumerate(days):
        prev = days[max(0, i - 2):i]
        prior_prof[d] = profile(rth[rth.date_.isin(prev)]) if prev else {}
    idx = pd.Series(np.arange(len(nq)), index=nq.t.map(lambda x: x.value))
    book, ctx = P.load_book(); cap_ns = ctx.cap_t.map(lambda x: x.value).to_numpy()
    rows = []; today_cache = {}
    for r in F.itertuples():
        i = idx.get(r.t.value)
        if i is None: continue
        i = int(i); sup = r.side == "support"; s = 1 if sup else -1
        g = FT.grade_live(nq, i, r.K, sup)
        if g is None: continue
        date = nq.date_.iloc[i]; mtc = 16 * 60 - (r.t.hour * 60 + r.t.minute)
        j0 = np.searchsorted(cap_ns, r.t.value, side="left") - 1
        if j0 < 0: continue
        c0 = ctx.iloc[j0]; spot = nq.cq.iloc[i - 1]
        E = spot * (c0.atm_iv / 100) * np.sqrt(max(mtc, 1) / 525600) * MNQ if pd.notna(c0.atm_iv) and c0.atm_iv > 0 else np.nan
        d = dict(sday=r.sday, half_=r.half_, side=r.side, K=r.K, E=E, **g)
        pl, ph, poc, outva = node_flags(prior_prof.get(date, {}), r.K, spot)
        key = (date, i // 6)
        if key not in today_cache:
            td = nq[(nq.date_ == date) & (nq.min_ >= 570) & (nq.index < i)]
            today_cache[key] = profile(td) if len(td) >= 6 else {}
        tl, th, _, _ = node_flags(today_cache[key], r.K, spot)
        wall = np.nan
        gb = book.get(c0.key)
        if gb is not None and r.K in gb.index:
            sp = gb.spot.iloc[0]; band = gb[(gb.index >= sp * 0.985) & (gb.index <= sp * 1.015)]
            mg, mo = band.gex.abs().max(), band.oi_tot.max()
            wall = bool((mg and abs(gb.at[r.K, "gex"]) >= 0.5 * mg) or (mo and gb.at[r.K, "oi_tot"] >= 0.7 * mo))
        ivw = ((sup and r.d_iv_60 >= 0.5) or ((not sup) and r.d_iv_60 <= -0.5)) if pd.notna(r.d_iv_60) else np.nan
        d.update(lvn=pl, hvn=ph, lvn_today=tl, hvn_today=th, wall=wall, iv_with=ivw,
                 G1=pl, G2=ph, G9=tl, G10=th, G11=outva,
                 G3=(bool(wall and pl) if np.isfinite(float(wall or 0)) and pl is not np.nan else np.nan),
                 G4=(bool(wall and ph) if ph is not np.nan else np.nan),
                 G5=(bool(pl and not wall) if pl is not np.nan else np.nan),
                 G6=(bool(wall and ivw) if not pd.isna(ivw) else np.nan),
                 G7=(bool(wall and pl and ivw) if (pl is not np.nan and not pd.isna(ivw)) else np.nan),
                 G8=(bool(np.isfinite(poc) and np.isfinite(E) and abs(r.K - poc) * MNQ >= 0.5 * E) if np.isfinite(poc) else np.nan))
        rows.append(d)
    return pd.DataFrame(rows)


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    D = build()
    D.to_parquet(os.path.join(ST, "volnode_live.parquet"), index=False)
    pr("# VOLUME NODES × WALLS × IV — live feed, RTH · outcome ≥120 MNQ before the 15 stop (BE 11.1%)")
    pr(f"fills {len(D)} · base ≥120 explore {100 * D[D.half_ == 'explore'].run120.mean():.1f}% confirm {100 * D[D.half_ == 'confirm'].run120.mean():.1f}%")
    pr(f"prevalence: LVN(prior) {100 * D.lvn.mean(skipna=True):.0f}% · HVN(prior) {100 * D.hvn.mean(skipna=True):.0f}% · LVN(today) {100 * D.lvn_today.mean(skipna=True):.0f}% · HVN(today) {100 * D.hvn_today.mean(skipna=True):.0f}% · wall {100 * D.wall.mean(skipna=True):.0f}% · IV with side {100 * D.iv_with.mean(skipna=True):.0f}%")
    labels = {"G1": "LVN at the strike (prior 2 sessions)", "G2": "HVN at the strike (prior 2 sessions)",
              "G3": "wall + LVN (old doctrine: cleanest rejection)", "G4": "wall + HVN", "G5": "LVN with NO wall (doctrine: accelerant → worse)",
              "G6": "wall + IV with the side", "G7": "wall + LVN + IV with the side", "G8": "≥0.5E from the prior POC",
              "G9": "LVN at the strike (today so far)", "G10": "HVN at the strike (today so far)", "G11": "outside the prior session's 70% value area"}
    passed = []
    for f, lab in labels.items():
        pr(f"\n## {f} {lab}")
        ok = FT.verdict(D, f, ("explore", "confirm"), pr)
        pr(f"   → {'PASS' if ok else 'fail'}")
        if ok: passed.append(f)
    pr(f"\n## PASSED: {passed if passed else 'nothing'}")
    pr("\n## trades (≥40 in a half; net MNQ/trade, 1 MNQ cost) — descriptive")
    pr(f"{'filter':>6} {'half':>8} {'trades':>7} {'/day':>5} {'≥120%':>6} {'net +120':>9} {'≥80%':>6} {'net +80':>8}")
    for f in list(labels) + ["ALL"]:
        for h in ("explore", "confirm"):
            g = D[D.half_ == h] if f == "ALL" else D[(D.half_ == h) & (D[f] == True)]
            if len(g) < 40: continue
            days = D[D.half_ == h].sday.nunique()
            pr(f"{f:>6} {h:>8} {len(g):7d} {len(g) / days:5.1f} {100 * g.run120.mean():6.1f} {g.pnl120.mean() - COST:+9.1f} {100 * g.run80.mean():6.1f} {g.pnl80.mean() - COST:+8.1f}")
    open(os.path.join(ST, "volnode_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
