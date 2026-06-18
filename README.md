# altaris-levels

Personal pipeline that pulls options-flow data from the Altaris Terminal (paid
account, no public API), scores price **levels**, and serves them on a private,
self-only dashboard.

> Personal use only — pulls **my own** account's data for **my own** analysis.

## Vision

A private live terminal that answers one question continuously:

> "Where should I be sitting a limit order right now, and how strong is that level?"

Built around the trading philosophy: **find levels in advance, place limit orders
waiting at them.** Institutional sizing, minimum take-profit = 0.25% of index
price. No reactive market-order logic.

## Architecture (3 layers)

```
[1] CAPTURE                [2] SCORING                 [3] DASHBOARD
poller hits Altaris   ->   compute level scores   ->   private web app
fetch endpoints            + confluence + regime       (auth-gated, self only)
   |                            |                           |
   v                            v                           v
data/raw/*.jsonl          data/scored/*.json          live level board
(time series)             (latest + history)          + score heatmap
```

### [1] Capture (`scraper/`)
Polling capture of the Altaris fetch endpoints (these are polled, not streamed).
Reads the session cookie from `.env`, never from source. Timestamps every pull
and appends to JSONL so we build a time series of how levels shift intraday.

Priority endpoints (confirmed from Network tab):

| Endpoint           | Feeds                                            | Priority |
|--------------------|--------------------------------------------------|----------|
| `data`             | Header levels (Call/Put/Major Wall, Max Pain, Gamma Flip), OI by strike, net GEX | must-have |
| `greek_timeseries` | Per-strike GEX/DEX + live flow tape              | high     |
| `regime_v2`/`macro`| Regime state / stress warning (filter)           | useful   |
| `iv_tracker`/`vol_skew_multi` | IV term structure + skew (sizing/TP)  | optional |
| `charm_overlay`/`anomalies` | derived viz                             | skip     |

### [2] Scoring (`src/score.ts`) — AI-as-analyst
The differentiator. Instead of a brittle weighted formula (tried it; too jittery),
**Claude Opus analyzes each snapshot every 15 min** and assigns a reversal
probability per strike. It runs through **Claude Code headless (`claude -p`) on the
Max subscription — no API key, no per-call billing**, just Max usage. Per near-spot
strike it sees the **full greek stack** — gamma (gex), delta (dex), vega, vanna,
charm, theta (tex), rho — plus OI, all with **deltas** (building vs bleeding), the
recent spot path, the **IV regime** from `iv_tracker` (so it weights vanna/vega up
when IV is moving, down when flat), and **its own previous call** — so it *revises*
rather than recomputing, which kills the jitter. (Altaris naming: VEX = vega; vanna
is the separate VANNEX field.)

The probability is **conditional**: `P(price reverses >= 0.25% of spot at this
strike | price reaches the strike)`. A strike can score high and never be reached —
the resting limit order just never fills, no harm done. Evidence the model weighs:
OI mass, gamma-wall strength (|GEX|), named-level status (Call/Put/Major Wall, Max
Pain, Gamma Flip, Vol Trigger), confluence, and the regime (positive net GEX
strengthens pins; negative weakens them).

**Sessions (US + Asia).** Runs in two windows (ET): the **US** session (08:30–17:00)
prices off QQQ directly; the **Asia** overnight session (20:00–04:00) prices off **NQ
futures converted to QQQ-equivalent** (QQQ doesn't trade overnight). The conversion is
the `converter.pine` logic — a smoothed `NQ/QQQ` ratio from the most recent US-hours
overlap, then `QQQ_equiv = NQ / ratio`. In Asia the model is told the OI/greeks are
**static prior-close positioning** (US options closed) and spot is NQ-derived, so it
scores more conservatively. `src/config.ts` `activeSession()` picks the window.

**Reversal detection / calibration (`src/detect.ts` + `src/market.ts`).** "Did a
level actually reverse?" is read from **Yahoo OHLC bars** (1m) — QQQ in the US session,
NQ→QQQ-converted in Asia — not the Altaris spot tape, which is downsampled and misses
intrabar wicks. Each named/scored
strike is classified by where price *lived* relative to it: a level price stayed
below and **wicked up into and rejected** (>= `REVERSAL_SWING_PCT`, default 0.5%, no
*close* beyond it) = `reversed`; a level it closed clean through = `broke`; reached
but hugged = `pending`; never reached = `untouched` (excluded from grading, not a
miss). Using real wicks fixes both timing and false positives — e.g. on 2026-06-17 it
correctly tags the $735 call wall `reversed` (wick + 1.9% rejection) and the $730
gamma flip `broke` (price sliced through it). Feeds the model ("these already played
out") and lets us check whether 70% means 70%.

Output: a ranked board of `strike | reversal % | side | why` — set a limit at the
high-prob strikes and wait.

### [3] Dashboard (`web/`)
Private, single-user web app that renders the scored levels live. Auth so only I
can access it. Stack TBD (leaning Next.js to match existing projects + share TS
types with the scoring layer). Built last, once capture + scoring are solid.

## Status / Roadmap

- [x] **1. Capture** — poller hits `data` + `greek_timeseries` every 15 min (8:30–17:00 ET)
- [x] **2. Storage** — JSONL append (`<date>.data.jsonl`) + per-day greek snapshot + `latest.json` board pointer
- [x] **3. Scoring** — Opus 4.8 reversal-probability board + data-driven reversal detector / calibration
- [ ] **4. Dashboard** — private live board (Next.js, shares the TS types in `src/types.ts`)

## Layout

```
altaris-levels/
  src/
    config.ts     env + session-window helpers
    types.ts      typed Altaris responses + board/detector types
    altaris.ts    API client (cookie auth)
    capture.ts    poll -> JSONL + per-day greek snapshot
    detect.ts     reversal detector over the spot path (calibration)
    score.ts      Opus 4.8 scoring call (structured output)
    run.ts        orchestrator: --once | --fixture | scheduled loop
    verify.ts     smoke test: is the cookie alive + does detection work
  data/
    raw/          <date>.data.jsonl + <date>.greek.json   (gitignored)
    scored/       latest.json + <date>.boards.jsonl + <date>.calibration.jsonl
  fixtures/       captured API samples for offline runs    (gitignored)
  .env            cookie + Anthropic key + config          (gitignored)
  .env.example    template
```

## Setup

Scoring runs through **Claude Code on the Max plan** — no API key. Just make sure
`claude` is installed and logged in (`claude` you're already using counts).

1. `npm install`
2. Copy `.env.example` to `.env` — the Altaris cookie + base URL are pre-filled.
3. Run:
   - `npm run verify` — confirm the cookie is live and the detector works
   - `npm run capture` — one full capture + score cycle right now
   - `npm run score:fixture` — score the bundled fixture (no Altaris call)
   - `npm start` — scheduled loop, every 15 min during the US (08:30–17:00) and Asia (20:00–04:00) ET windows
   - `npm run web` — serve the phone dashboard on your LAN (open the printed URL on your phone, same Wi-Fi)

> The session cookie expires; when capture starts returning HTTP 401/403, re-copy
> `altaris_session=...` from a fresh "Copy as cURL" into `.env`.

## Dashboard (hybrid)

Scoring runs locally on the Max plan; every scored board is written to `web/dashboard.json`
and rendered by a no-build static site in `web/` — a **price-elevation board**: each level sits at
its true price on a vertical scale, a gold datum line marks spot, resistance walls stack above and
support floors below, bar length encodes reversal probability, and each level shows whether it has
held / broken / is testing / resting. Tap a level for the reasoning.

- **On your phone while the box is on:** `npm run web`, then open the printed LAN URL.
- **Computer-off viewing (optional):** `npm i -g netlify-cli`, `netlify login`, `netlify link` once,
  then set `PUBLISH_TARGET=netlify` in `.env`. Each score then deploys `web/` (no build step via
  `netlify.toml`, so it costs no build minutes). `npm run publish` re-publishes the latest board on demand.
