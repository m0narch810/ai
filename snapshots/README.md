# Raw Altaris QQQ options-flow snapshots

Uninterpreted market data captured from the Altaris terminal (no scoring, no AI output).

## Files (in `data/`)

- `YYYY-MM-DD.data.jsonl` — one JSON object per line, one line per capture tick.
  Each record: `capturedAt` (ISO timestamp, ET) + raw Altaris panels:
  `data` (spot, per-strike GEX/charm/vanna/TEX bars, 0DTE slice, OI, IV skew),
  `iv` (IV tracker), `garch` (forecast + σ bands), `hedge_pressure`,
  `level_assessment`, `opex_gravity`, `oi_analytics`, `liquidity`,
  `unusual_activity` (sweeps), `hiro` (dealer-flow tape), `heston` (surface rich/cheap),
  `regime_v2`, `vol_stats`, `anomalies`, `pc_skew`, `skew_index`,
  `vol_regime_score`, `regime_intraday`, `oi365`, `entropy`, `hurst`.
- `YYYY-MM-DD.greek.json` — that day's Altaris greek timeseries pull.

## Coverage

- Date range: **2026-06-17 → 2026-07-14** (24 trading days; market holidays/weekend gaps absent).
- Tick rate: **~15 minutes** during capture windows (US session + Asia/Globex overnight),
  with occasional faster ticks when price moved quickly. Early days (Jun 17–22) are partial —
  the capture loop wasn't running full-time yet.

## Known data issues (audited 2026-07-14)

- **Bad-feed window: 2026-06-29 20:15 ET → 2026-06-30 09:15 ET (~21 records).** The Altaris
  server returned the wrong underlying (spot 614, strike chain centered ~585–645 — not QQQ,
  which traded 705–740 in this period). Drop records where `data.spot < 650`.
- **76 duplicate timestamps, Jun 24–26 (+1 on Jun 30)** — the same tick captured both locally
  and by the cloud function, merged during backfill. Dedupe on `capturedAt`.
- **Panel coverage varies by date (schema evolution, not data loss):** `data`/`iv` are present
  from day one; `garch`/`entropy`/`hurst` from Jun 25; `hedge_pressure` from Jun 28; everything
  else (`level_assessment`, `hiro`, `regime_v2`, `unusual_activity`, …) from **Jul 2**. For the
  complete panel set, use Jul 2 onward. Cloud-captured ticks also skip the three slowest panels
  (`heston`, `unusual_activity`, `regime_intraday`).
- `greek.json` series are capped at 500 points by the server — long days are truncated.
