"""
FAR-TRAVEL FILTERS — which touches run FAR once filled, on the user's fixed 15-MNQ stop.

PRE-REGISTERED 2026-09-17 before any of these outcomes was computed. User: "go ahead but don't overfit".
OUTCOME   filled trade (limit at the strike, trade-through fill within 30 min) that runs ≥120 MNQ before going
          15 MNQ past the strike. Break-even for 15 risk / 120 reward = 11.1%. Secondary: ≥80 (BE 15.8%).
FILTERS   (thresholds fixed here, from earlier studies or round numbers — none tuned on these outcomes)
  H1 room      expected move left to the close ≥ 120 MNQ  (E = spot · ATM IV · √(minutes to close / 525600))
  H2 target    the nearest heavy strike beyond the level in the trade direction (|gamma| ≥ 50% of the band max or
               OI ≥ 70%) is ≥ 80 MNQ away and ≤ 0.8 E                                     [live only: needs the book]
  H3 IV        support with ATM IV rising ≥ 0.5 vol pt over ~60 min, or resistance with it falling ≥ 0.5
  H4 flip      the gamma flip lies between the level and 120 MNQ in the trade direction
  H5 drive     touch after 10:30; first-hour move |price(10:30) − open| ≥ 0.5 · EM; trade in the drive's direction
  H6 leg       price moved ≥ 0.5 E INTO the level over the prior 60 min
  H7 volume    option volume share at the level grew over the prior hour                  [live only]
DATASETS  LIVE: RTH whole-strike touches 2026-07-20 → 09-17 (YYY book), halves explore / confirm.
          HISTORY: 2022-23 RTH contacts (0DTE book: 0DTE flip, 0DTE ATM IV), halves 2022 / 2023 — H1, H3, H4, H6.
          The 2024 holdout is spent and is not read. 2025 has no book.
PASS      with-filter rate − without-filter rate ≥ +3 pts on the ≥120 outcome in EVERY half of every dataset the
          filter is tested on, with ≥100 filled trades in the with-filter group per half.
COMBINE   the AND of every filter that passes, reported once, as trades: net MNQ/trade with a +120 and a +80 target,
          1 MNQ round-trip cost, stop wins a shared bar. If nothing passes, nothing is combined.
    python scripts/study_far_travel.py
"""
from __future__ import annotations
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import study_ledger_greeks as L
import study_precise_leadup as P
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
ST = L.ST; MNQ = L.MNQ; COST = 1.0
STOP = 15 / MNQ


def grade_live(nq, i, K, sup):
    lo, hi, cl, hm, day = nq.lq.to_numpy(), nq.hq.to_numpy(), nq.cq.to_numpy(), nq.hm.to_numpy(), nq.date_.to_numpy()
    through = (lo[i:i + 7] < K) if sup else (hi[i:i + 7] > K)
    if not through.any(): return None
    f = i + int(np.argmax(through)); end = f
    while end + 1 < len(nq) and day[end + 1] == day[f] and hm[end + 1] <= 15 * 60 + 55: end += 1
    adv = (K - lo[f:end + 1]) if sup else (hi[f:end + 1] - K)
    fav = ((hi[f:end + 1] - K) if sup else (K - lo[f:end + 1])).copy(); fav[0] = -np.inf
    close = ((cl[end] - K) if sup else (K - cl[end])) * MNQ
    s = np.flatnonzero(adv >= STOP); si = s[0] if len(s) else None
    out = {}
    for tgt in (80, 120):
        t = np.flatnonzero(fav >= tgt / MNQ); ti = t[0] if len(t) else None
        win = ti is not None and (si is None or ti < si)
        out[f"run{tgt}"] = win
        out[f"pnl{tgt}"] = tgt if win else (-15.0 if si is not None else close)
    return out


def live():
    F = pd.read_parquet(os.path.join(ST, "reader_pattern_features.parquet"))
    F["t"] = pd.to_datetime(F.t, utc=True).dt.tz_convert("America/New_York").astype("datetime64[ns, America/New_York]")
    F = F[F.sess == "RTH"].copy()
    nq = L.load_bars("5m"); nq["date_"] = nq.t.dt.strftime("%Y-%m-%d")
    idx = pd.Series(np.arange(len(nq)), index=nq.t.map(lambda x: x.value))
    book, ctx = P.load_book(); cap_ns = ctx.cap_t.map(lambda x: x.value).to_numpy()
    rows = []
    for r in F.itertuples():
        i = idx.get(r.t.value)
        if i is None: continue
        i = int(i); sup = r.side == "support"; s = 1 if sup else -1
        g = grade_live(nq, i, r.K, sup)
        if g is None: continue
        d = dict(sday=r.sday, half_=r.half_, side=r.side, **g)
        mtc = 16 * 60 - (r.t.hour * 60 + r.t.minute)
        j0 = np.searchsorted(cap_ns, r.t.value, side="left") - 1
        if j0 < 0: continue
        c0 = ctx.iloc[j0]
        spot = nq.cq.iloc[i - 1]
        E = spot * (c0.atm_iv / 100) * np.sqrt(max(mtc, 1) / 525600) * MNQ if pd.notna(c0.atm_iv) and c0.atm_iv > 0 else np.nan
        d["E"] = E
        d["H1"] = E >= 120 if np.isfinite(E) else np.nan
        gb = book.get(c0.key)
        if gb is not None and len(gb) and np.isfinite(E):
            sp = gb.spot.iloc[0]; band = gb[(gb.index >= sp * 0.985) & (gb.index <= sp * 1.015)]
            mg, mo = band.gex.abs().max(), band.oi_tot.max()
            ahead = gb[((gb.index - r.K) * s > 0) & ((gb.gex.abs() >= 0.5 * mg) | (gb.oi_tot >= 0.7 * mo))]
            dist = ((ahead.index - r.K) * s).min() * MNQ if len(ahead) else np.inf
            d["H2"] = bool(dist >= 80 and dist <= 0.8 * E)
        d["H3"] = (sup and r.d_iv_60 >= 0.5) or ((not sup) and r.d_iv_60 <= -0.5) if pd.notna(r.d_iv_60) else np.nan
        d["H4"] = bool(0 < (c0.flip - r.K) * s <= 120 / MNQ) if pd.notna(c0.flip) else np.nan
        day_bars = nq[(nq.date_ == nq.date_.iloc[i]) & (nq.hm >= 570)]
        o = day_bars[day_bars.hm == 570]; b1030 = day_bars[day_bars.hm == 625]
        if (r.t.hour * 60 + r.t.minute) >= 630 and len(o) and len(b1030) and pd.notna(c0.em) and c0.em > 0:
            drive = (b1030.cq.iloc[0] - o.oq.iloc[0]) / c0.em
            d["H5"] = bool(abs(drive) >= 0.5 and np.sign(drive) == s)
        else:
            d["H5"] = False if (r.t.hour * 60 + r.t.minute) >= 630 else np.nan
        d["H6"] = bool(r.into_60 >= 0.5 * E) if np.isfinite(E) and pd.notna(r.into_60) else np.nan
        d["H7"] = bool(r.vol_tot_share_d60 > 0) if pd.notna(r.vol_tot_share_d60) else np.nan
        rows.append(d)
    return pd.DataFrame(rows)


def history():
    c = pd.read_parquet(os.path.join(ST, "contacts_222324.parquet"))
    for col in [x[:-2] for x in c.columns if x.endswith("_x")]: c[col] = c[f"{col}_x"]; c = c.drop(columns=[f"{col}_x", f"{col}_y"])
    c = c[c.filled & (c.fill_min <= 30) & (c.mins_to_close >= 15) & (c.date < "2024") & (c.ltype == "strike")].copy()
    c["half_"] = c.date.str.slice(0, 4)
    s = np.where(c.side == "support", 1, -1); E = c.E * MNQ
    c["run120"] = c.run15_120.astype(bool); c["run80"] = c.run15_80.astype(bool)
    c["H1"] = E >= 120
    c["H3"] = np.where(c.side == "support", c.d_iv30 >= 0.005, c.d_iv30 <= -0.005)
    c["H4"] = [bool(0 < (fl - k) * ss <= 120 / MNQ) if np.isfinite(fl) else np.nan for fl, k, ss in zip(c.flip, c.K, s)]
    c["H6"] = ((-c.F_d60 * s * MNQ) >= 0.5 * E).astype(object).where(c.F_d60.notna(), np.nan)
    return c


def verdict(D, name, halves, pr):
    res = []
    for h in halves:
        g = D[D.half_ == h]; m = g[name]; ok = m.notna()
        w = g[ok & (m == True)]; wo = g[ok & (m == False)]
        if len(w) == 0 or len(wo) == 0: res.append((h, np.nan, np.nan, len(w), len(wo), np.nan, np.nan)); continue
        res.append((h, 100 * w.run120.mean(), 100 * wo.run120.mean(), len(w), len(wo), 100 * w.run80.mean(), 100 * wo.run80.mean()))
    passed = all(np.isfinite(a) and a - b >= 3 and nw >= 100 for _, a, b, nw, _, _, _ in res)
    for h, a, b, nw, nwo, a8, b8 in res:
        pr(f"   {name} {h:>8}: with {a:5.1f}% (n={nw:4d})  without {b:5.1f}% (n={nwo:4d})  gap {a - b:+5.1f}  | ≥80: {a8:5.1f}% vs {b8:5.1f}%")
    return passed


def main():
    out = []; pr = lambda x: (out.append(x), print(x))
    pr("# FAR-TRAVEL FILTERS — filled trades that run ≥120 MNQ before the 15 stop (BE 11.1%) · pass = ≥+3 pts in every half, ≥100 trades with the filter")
    D = live(); H = history()
    pr(f"\nLIVE RTH filled trades: {len(D)} (explore {int((D.half_ == 'explore').sum())}, confirm {int((D.half_ == 'confirm').sum())}) · base ≥120: explore {100 * D[D.half_ == 'explore'].run120.mean():.1f}% · confirm {100 * D[D.half_ == 'confirm'].run120.mean():.1f}%")
    pr(f"HISTORY 2022-23 RTH strike fills (≤30 min): {len(H)} · base ≥120: 2022 {100 * H[H.half_ == '2022'].run120.mean():.1f}% · 2023 {100 * H[H.half_ == '2023'].run120.mean():.1f}%")
    passed = []
    for name, label, where in [("H1", "room: E to close ≥ 120 MNQ", "both"), ("H2", "next heavy strike 80 MNQ – 0.8E away", "live"),
                               ("H3", "IV with the side (support rising / resistance falling)", "both"), ("H4", "gamma flip within 120 MNQ in the trade direction", "both"),
                               ("H5", "first-hour drive ≥0.5 EM, trade with it, after 10:30", "live"), ("H6", "moved ≥0.5E into the level over 60 min", "both"),
                               ("H7", "option volume at the level building", "live")]:
        pr(f"\n## {name} {label}")
        ok = verdict(D, name, ("explore", "confirm"), pr)
        if where == "both":
            ok = verdict(H, name, ("2022", "2023"), pr) and ok
        pr(f"   → {'PASS' if ok else 'fail'}")
        if ok: passed.append(name)
    pr(f"\n## COMBINED (AND of passers): {passed if passed else 'nothing passed — no combination'}")
    if passed:
        m = np.logical_and.reduce([D[p] == True for p in passed])
        for h in ("explore", "confirm"):
            g = D[m & (D.half_ == h)]; base = D[D.half_ == h]; days = base.sday.nunique()
            if len(g): pr(f"   LIVE {h:>8}: {len(g)} trades ({len(g) / days:.1f}/day) · ≥120 {100 * g.run120.mean():.1f}% · net +120 target {g.pnl120.mean() - COST:+.1f} · net +80 target {g.pnl80.mean() - COST:+.1f} MNQ/trade  | all trades: +120 {base.pnl120.mean() - COST:+.1f} · +80 {base.pnl80.mean() - COST:+.1f}")
        hp = [p for p in passed if p in H.columns]
        if hp:
            mh = np.logical_and.reduce([H[p] == True for p in hp])
            for h in ("2022", "2023"):
                g = H[mh & (H.half_ == h)]; base = H[H.half_ == h]
                if len(g): pr(f"   HIST {h:>8} ({'+'.join(hp)}): {len(g)} trades · ≥120 {100 * g.run120.mean():.1f}% (base {100 * base.run120.mean():.1f}%) · ≥80 {100 * g.run80.mean():.1f}% (base {100 * base.run80.mean():.1f}%)")
    open(os.path.join(ST, "far_travel_report.md"), "w", encoding="utf-8").write("\n".join(out))


if __name__ == "__main__":
    main()
