# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Trading-algorithm design rules (minimum 0.25% TP, limit-orders-at-levels, strictly
> sequential SL/TP outcomes, no look-ahead/overfitting) live in the user-level `~/CLAUDE.md`
> and apply here. This file covers only what's specific to this repo.

## What this is

A local pipeline that pulls QQQ options-flow data from the Altaris terminal, finds price
levels where a reversal is likely, scores each level with an LLM, and publishes a
phone/PC-viewable board. The trader enters on **MNQ futures** using a QQQ→NQ strike converter
(`converter.pine`) as limit orders at the exact QQQ strike prices, targeting top/bottom tick
entries with a **~20 MNQ point stop** (~0.48 QQQ pts). The system is **level-finding first**:
the output is a ranked set of strikes to rest limit orders at, not real-time signals.

## Commands

```bash
npm run capture        # one full capture → detect → score → publish cycle, now
npm start              # scheduled loop: every SCORE_INTERVAL_MIN during US + Asia windows
npm run score:fixture  # score the bundled fixtures/ offline (no Altaris call) — smoke test
npm run verify         # confirm the Altaris cookie is live + the detector runs (no scoring)
npm run web            # serve web/ on the LAN for phone viewing (prints LAN URL)
npm run publish        # re-deploy the latest board to Netlify without re-scoring
npm run typecheck      # tsc --noEmit  (there is no compile step; tsx runs the TS directly)
```

There is **no test runner** and no build. `score:fixture` + `verify` + `typecheck` are the
checks. To exercise one stage in isolation, import its module under `tsx` or use the fixture run.

ESM throughout: relative imports must carry the `.js` extension (e.g. `import { config } from
"./config.js"`) even though the files are `.ts`.

## Pipeline architecture

One cycle is orchestrated in `src/run.ts` (`scoreFromHistory`) and chains four stages:

1. **Capture** (`src/capture.ts` ← `src/altaris.ts` ← `src/auth.ts`) — fetches `/api/data`,
   `/api/greek_timeseries`, `/api/iv_tracker`. **Auto-logs in** using `ALTARIS_USER`/`ALTARIS_PASS`
   via `POST /api/login`; refreshes the session cookie automatically on 401 — no manual paste
   needed (`ALTARIS_COOKIE` in `.env` is optional once credentials are set). `compactSnapshot`
   drops the giant `*_hm` heatmaps but **aggregates `cex_hm`/`tex_hm`/`vannex_hm` into per-strike
   `charm_bar`/`tex_bar`/`vanna_bar`** (those greeks have no native per-strike `*_bar`).

2. **Detect** (`src/detect.ts` ← `src/market.ts`) — sequential, bar-by-bar grader on **Yahoo
   OHLC wicks, not the Altaris spot tape**. Key thresholds (all in absolute QQQ points, sized
   to MNQ execution):
   - `fillTolPts` (0.08) — price must actually reach within 0.08 pts of the strike to count as
     *tested*. A resting limit at the strike only fills if price reaches it; coming within a
     point is not a touch.
   - `hardStopPts` (0.48 ≈ 20 MNQ pts) — crossing this far beyond the level = **broke**.
   - `cleanReversalPts` (0.10 ≈ 4 MNQ pts) — reversed within this range = **clean** (near-tick).
   - **Side-matched**: a resistance reversal at a strike never stamps "held" on a support level
     at the same strike (`outcomeFor` in `src/dashboard.ts` requires side agreement).

3. **Score** (`src/score.ts`) — runs through **Claude Code headless (`claude -p`), not the
   Anthropic API** (Max-plan, no API key). Model is `ANTHROPIC_MODEL` (default `sonnet`).
   **AI scoring is gated to RTH only** (09:15–16:00 ET, Mon–Fri). Outside this window,
   `refreshTick()` holds the last RTH board's levels and still updates spot + detector outcomes,
   but skips the AI call (overnight positioning is static prior-close). Key prompt design:
   - Framed for MNQ tick trading: score for clean top/bottom-tick entry, not grinds.
   - `reaction` per level: `"clean"` / `"chop"` / `"mixed"` — predicted character of the touch.
   - `tags`: 2–4 chip-sized confluence labels.
   - `read`: one plain-English directional line — no jargon ("desk"/"fade" etc.).
   - `minutes_to_cash_close` fed in context so scorer weights time-of-day (pinning, 0DTE charm).
   - Probability discipline: at most one level >65%, two ≥55%; levels must be differentiated.
   - Editing scoring behavior: edit `SYSTEM` / `buildInput` in `src/score.ts`, not code structure.

4. **Persist + publish** (`src/dashboard.ts`, `src/publish.ts`) — writes `data/scored/latest.json`
   (+ `<date>.boards.jsonl` + `<date>.calibration.jsonl` for grading), merges board × detector
   outcomes into `web/dashboard.json`, then deploys `web/` **and** `netlify/functions/` to
   Netlify. The `--functions` flag is required in the deploy command or the live-spot function
   won't deploy.

## Scheduler

The live scoring loop runs as a **Windows Scheduled Task named `AltarisLevels`** (registered via
PowerShell). It launches at user logon, restarts on failure, no time limit. After any code change
to `src/`, restart it:

```powershell
Stop-ScheduledTask -TaskName "AltarisLevels"
Start-ScheduledTask -TaskName "AltarisLevels"
```

Do **not** also run `npm start` in a terminal — two schedulers double-score and double-deploy.

## Two sessions, two spot sources (`src/config.ts` `activeSession`)

- **US** (Mon–Fri 08:30–17:00 ET): QQQ is live; AI re-scores 09:15–16:00 only.
- **Asia** (Sun–Thu 20:00 → Mon–Fri 04:00 ET): OI/greeks are static prior-close positioning.
  Spot is **NQ=F futures converted to QQQ-equiv** via a smoothed NQ/QQQ ratio
  (`src/market.ts` `nqToQqqRatio`, ~last 100 overlapping US-hours minutes; mirrors `converter.pine`).

Off-RTH (outside 09:15–16:00): the loop skips the AI call, holds the last RTH board's levels,
re-runs the detector, and republishes. Dashboard shows `held · off-rth` vs `scored Xago`
(unexpectedly stale during RTH = box offline, levels dim).

When adding logic that depends on price, route it through `effectiveSpot`/`fetchSessionBars` —
don't read `snapshot.spot` directly in Asia.

## Dashboard / hosting (hybrid model — settled)

Scoring stays local on Max (free); boards auto-publish to `web/` (vanilla HTML/CSS/JS, polls
`dashboard.json`). Live spot is served by a **Netlify serverless function**
(`netlify/functions/spot.mjs`) that fetches from Yahoo server-side — the spot line stays live
even when the scoring box is off. View on LAN (`npm run web`) or at the linked Netlify site
(`PUBLISH_TARGET=netlify`, site: `aaravaltai`). **Do not re-pitch the cloud-native/API-key path**
— it was considered and rejected on cost.

## Dashboard data fields (key additions this session)

- `scored_at`: epoch ms — use for staleness, not `as_of` (ET wall-clock, breaks in non-ET browsers)
- `read`: one-line plain-English directional call — no jargon
- `hard_stop_pts` / `clean_reversal_pts`: thresholds for live grind/break detection in the browser
- Per level: `reaction` ("clean"/"chop"/"mixed"), `tags` (chips), `overshoot`, `clean` (bool)

## Gotchas

- **Cookie auto-refreshes.** If `ALTARIS_USER`/`ALTARIS_PASS` are set, a 401 triggers auto-login
  and retry. If credentials are missing and `ALTARIS_COOKIE` is expired, capture fails with 401.
- **Altaris field names:** `vex_bar`/VEX = **vega**; vanna is `vannex_hm`/VANNEX. Don't conflate.
- **`data/`, `fixtures/`, `.env` are gitignored.** `web/dashboard.json` **is** tracked (Netlify
  needs a board to render on first deploy).
- **Windows:** `netlify` is a `.cmd` shim — spawn with `shell: true` (handled in `publish.ts`).
- **Netlify deploy must include `--functions netlify/functions`** or the live-spot function won't
  deploy. Both `[functions]` in `netlify.toml` and the flag in `publish.ts` are required.
- **`[hidden]` in CSS:** always keep `[hidden] { display: none !important }` before any
  `display: flex/grid` rules — flex display overrides the hidden attribute otherwise.
- After CSS/JS changes: `npm run publish` re-deploys without re-scoring.
- After `src/` changes: restart the `AltarisLevels` scheduled task.
- Higher-order greeks (speed/zomma/color) are intentionally skipped.
