# altaris-levels — TODO / handoff

_Last updated: 2026-06-17 eve (Asia session)._

## Where it stands — built & working (layers 1–3)
- **Capture** (`src/capture.ts`): polls Altaris `/api/data`, `/api/greek_timeseries`, `/api/iv_tracker`; cookie from `.env`; appends `data/raw/<date>.data.jsonl` + per-day greek + `latest.json` board pointer. Strips `*_hm` heatmaps but aggregates charm/theta/vanna to per-strike bars.
- **Reversal detection** (`src/detect.ts` + `src/market.ts`): runs on **Yahoo OHLC wicks**, not the Altaris spot tape. Wick-and-reject classification → `reversed` / `broke` / `pending` / `untouched`. Verified on real data: $735 call wall = reversed, $730 gamma flip = broke (matches the chart). Two knobs: `TP_MIN_PCT` (0.25%, the trade target) vs `REVERSAL_SWING_PCT` (0.5%, what confirms a hold).
- **Scoring** (`src/score.ts`): runs through **Claude Code headless (`claude -p`) on the Max plan — no API key**. Model = **sonnet** (`ANTHROPIC_MODEL`, plenty for this; calibration data will tell us if Opus is worth it). Feeds the full greek stack per near-spot strike (gex, dex, vega, **vanna**, **charm**, **tex**, rho) in $M with deltas, + IV regime from `iv_tracker`, + prior board (revises, anti-jitter), + already-played-out levels. Output: ranked `strike | reversal % | side | why`.
- **Sessions** (`src/config.ts` `activeSession()`): **US** 08:30–17:00 ET (QQQ) and **Asia** 20:00–04:00 ET (QQQ stale → **NQ futures converted to QQQ** via `converter.pine` logic, smoothed NQ/QQQ ratio ≈ 41.5). Asia is scored more conservatively (static prior-close OI, NQ-derived spot, thin liquidity). Scheduler runs both windows.
- Reversal probability is **conditional**: P(reverse ≥0.25% | price reaches strike). Calibration is logged (`data/scored/<date>.calibration.jsonl`) — graded only on levels price actually reached.

## Run it
- `npm run verify` — cookie alive + detector (no scoring)
- `npm run capture` — one capture+score cycle now
- `npm run score:fixture` — score bundled fixture offline
- `npm start` — scheduled loop, US + Asia windows
- `npm run web` — serve the dashboard on your LAN (open the printed URL on your phone)
- `npm run publish` — rebuild `web/dashboard.json` from the latest board (and deploy if `PUBLISH_TARGET=netlify`)

## Layer 4: dashboard (BUILT — hybrid model)
- Decision: **hybrid**. Scoring stays local on Max (free); each score auto-publishes the board to a static dashboard you can open on your phone. Computer must be on during sessions.
- `web/` is a no-build static site (HTML/CSS/vanilla JS) — a **price-elevation board**: levels plotted at their true price on a vertical scale, gold **datum line** = spot, resistance walls above / support floors below, bar length = reversal %, outcome shown as held/broke/testing/resting. Tap a wall for the reasoning. Polls `dashboard.json` every 60s.
- `src/dashboard.ts` merges the scored `Board` + detector outcomes → `web/dashboard.json`. `src/publish.ts` writes it and (if `PUBLISH_TARGET=netlify`) runs `netlify deploy --prod --dir web`. Wired into `run.ts` after each score (non-fatal on failure).
- `src/web.ts` is a tiny dependency-free LAN server for phone viewing while the box is on.
- **To enable computer-off viewing:** `npm i -g netlify-cli`, `netlify login`, `netlify link` (or `netlify deploy` once to create the site), then set `PUBLISH_TARGET=netlify` in `.env`. `netlify.toml` already deploys `web/` with no build (zero build minutes) and no-store on `dashboard.json`.

## HOSTING DECISION — RESOLVED → hybrid (option 2)
Picked **hybrid**: Max scoring stays local (free), board auto-publishes to a static dashboard viewable from phone; computer on during sessions. (Rejected: cloud-native API-key path ~$100–180/mo; always-on mini box — revisit if computer-off ever beats cost.) Layer 4 built — see above.

## TODO
- [ ] (When wanted) enable computer-off viewing: install netlify-cli + link the site, set `PUBLISH_TARGET=netlify`.
- [ ] Let it run a few sessions to **accumulate calibration data**, then check "is 70% actually 70%?" and whether Opus beats Sonnet.
- [ ] (Optional) add `vol_skew_multi` per-strike IV skew if we want more IV granularity.

## Gotchas / facts
- **Cookie expires** — when capture returns 401/403, re-paste `altaris_session=...` into `.env`.
- Altaris VEX = **vega**; vanna is the separate VANNEX field (confirmed by magnitudes).
- `fixtures/` and `data/` are gitignored (live account data).
- Higher-order greeks (speed/zomma/color) intentionally skipped.
