# NSE Dashboard — Backlog & State

_Last updated: 26-Jul-2026_

## Systems

| Repo | Frontend | GAS backend deployment id |
|---|---|---|
| `nse-dashboard` | `index.html`, `dashboard.html`, `steam.html` | `AKfycbxbqcip3QPPRP5YUxngoWecv5nN2eKk5h9T2WYL2_vmTs3ix6Tjt_KTfKq2MDptrmPMcw` |
| `nse-indicators` | `indicators.html` | `AKfycbzZ6mQ6z50KRcNbFq7zWgY_sTjXOBTi-3GGye8EEWFM8cBX8mwxPmqatZ7edsEIaSw7fw` |

**Indicators GAS files:** `Code.gs` · `UniverseGate.gs` (v1.6.1) · `Health.gs` (v1.0.1) · `RosterHealth.gs` (v1.0) · `BullBackfill.gs` (v1.2) · `TierLab.gs` (v1.1)
**Steam GAS files:** `Code.gs` · `SignalEngine.gs` · `SteamGauge_News_v2.gs` · `BlackSheep.gs` (v1.4)

Universe: **799** names (`var UNIVERSE`, v6). Steam `STOCK_MASTER`: 718.

## Active triggers (Indicators)

| Function | Schedule |
|---|---|
| `runScan` | daily ~18:30 |
| `runCalibScore` | daily ~19:00 |
| `runBullLog` | daily ~18:45 |
| `saturdayHealthRun` | Sat ~10:00 |
| `ugHealthWatch` | Sat ~11:00 |

`installChampionTrigger()`'s standalone Sat 09:00 `runCalibChampion` must NOT be active — `saturdayHealthRun` owns the sell refit now.

## Health status (25-Jul-2026)

- **Roster structure — verified.** `ugAuditUniverse`: DEAD 0 · PROBLEM 0 · CAUTION 30 · OK 769 (799/799 coverage, 65s). Black Sheep v1.4 sweep: 0 BLACKSHEEP. Two independent screens agree.
- **Sell Watch — calibrated, resolution unproven.** Champion v1, holdout Brier 0.24713 vs raw 0.25482, 15,271 train / 6,546 holdout. Challenger tied the incumbent → correctly kept.
- **Bull Watch — TESTED, no selection edge.** 65,229 backfilled episodes: `STRONG − ALL BARS` is null on hold, mean AND median. The CAUTION label pooled a momentum bucket with a breakdown bucket; the grade ordering is inverted by construction. Full reasoning in `docs/DECISIONS.md` D-005. Live `runBullLog` continues accruing as the uncensored out-of-sample check.
- **TierLab — CLOSED, both confirmations failed.** `volMom` +0.57% [−0.26, +1.82], `pct52w` +0.79% [−0.17, +1.66]; both gradients monotone (rho 0.855) but both intervals include zero. Underpowered at 32 holdout months, not negative. Holdout spent. New pre-registration logged in D-006 for a 3-month-horizon test once ≥44 months exist (~12 months away).
- **Roster watch — baseline seeded.** Every name has a 1-char history; escalation needs 5 weekly cycles.

## Open items

### HIGH — the binding constraint

- **Deep-history vault (D-007).** Apps Script allows ~20,000 UrlFetch calls/day, shared across BOTH projects by user. BullBackfill and TierLab fetch the identical 10y history for the identical 799 stocks, and every re-run pays again — on 25-Jul that exhausted the quota and took Steam Gauge down with it. Fetch once per stock, store as compact JSON (one row per stock), have all research read from storage, top up weekly. Turns a 184s harvest into seconds and makes re-harvests free. Highest leverage remaining.

### HIGH — act on what is settled

- **Act on D-005 in `bullPack_`:** split the CAUTION label (C_EXTENDED vs C_PULLBACK) and remove the grade. Both are presentation changes; neither alters what is computed. Do NOT invert extension into a buy signal — see D-005 for why.

### HIGH — validate what's asserted
- **`resolutionReport()` — measure sell-signal resolution.** Holdout Brier 0.24713 is close to the base-rate-only score (≈0.2475 at a 0.45 base rate). Under the Murphy decomposition, isotonic recalibration buys reliability; it cannot create resolution. Run `runResolutionExperiment()` (resumable) then `resolutionReport()` to find out whether the probabilities separate outcomes at all, or whether the edge lives purely in conditional `lift`.
- **Classify the 30 CAUTION names.** `ugScanBars_` returns CAUTION for two unlike reasons: young listing (<200 bars, self-healing) and thin liquidity (persistent, never improves). Both currently encode as healthy `C` and never escalate. If a meaningful share are thin-liquidity, add a slow-lane counter rather than folding them into the healthy bucket. Read `UniverseAudit` → Detail column.

### MEDIUM
- **`steam.html` — `newsContext` render.** BlackSheep v1.4 splits verdict-bearing `flags` from informational `newsContext`. `steam.html` picks up corrected verdicts automatically but won't display headlines until it mirrors the `indicators.html` render change. Nothing breaks meanwhile.
- **BUG-001 backend.** Apply `computeSectorPE_` (median, drop non-positive) at source from `BACKEND_FIXES.gs.txt`. Frontend guard already renders "n/m" for spe≤0 or ≥200, so this is cleanliness not correctness.
- **Candidate pool is empty.** `rhCandidatePool_()` draws from `GateReport` ADMIT rows not already in the universe; the last tranche pasted all its ADMITs in. A REPLACE_READY name would therefore defer with "no screened replacement candidate available" rather than propose a bare deletion — correct, but means a pool must be built (`ugRunGateAuto()`) before any swap can complete.

### LOW / deferred
- **FEATURE-001 — `steam.html` auto-syncing universe from `?action=universe`.** Attempted, reverted: duplicate `const BACKEND` and a hung Buffett fetch. Needs a deferred non-blocking loader and a browser console open.
- **Universe growth past 799.** Clean index-CSV path is exhausted (Nifty Total Market was 742/743 already covered). Further growth needs SME or turnover-ranked full-EQ sources. Deferred by choice.

## Engineering discipline (non-negotiable)

- **Whole-file replacements only.** Every outage this project has had came from pasting on top of existing code. Deliver and deploy complete files; verify the line count after pasting.
- **`node --check` everything** before it goes near GAS. Extract inline `<script>` blocks from HTML and check those too.
- **Pure math gets a Node test harness** (`test_*.js`) before deployment.
- **Deploy = Manage deployments → pencil → New version.** Never "New deployment" (it mints a new URL).
- **Only web-request code needs deploying.** Editor- and trigger-run functions execute the saved code, so `RosterHealth.gs` needs no deploy.
- **GAS hides functions ending in `_`** from the Run dropdown. Anything meant to be run by hand must not have a trailing underscore.
- **Verify REJECTs before acting.** Yahoo returns transient bad data on healthy stocks mid-corporate-action (AURIONPRO, FIEMIND were false negatives).
- **Cache TTLs are in UTC.** BlackSheep caches 6h; a sweep re-run inside that window replays stale verdicts. Use `runSheepHealthForce` (passes `&nocache=1`) after deploying engine changes.
