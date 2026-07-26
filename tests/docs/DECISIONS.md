# Decision Record

Why things are the way they are. Written so a future session doesn't re-litigate
settled questions or "fix" a deliberate choice.

---

## D-001 · Black Sheep verdicts are driven by structure, not news (25-Jul-2026)

**Final state:** `BlackSheep.gs` v1.4. A regulatory news headline never determines
the verdict. News is returned separately as `newsContext` for display. The verdict
comes from Tier 1 (data integrity), Tier 2 (fundamentals, frontend-side), and one
narrow news category: confirmed-subject CIRP/insolvency **exit** language.

**How we got here — four versions in one session:**

- **v1.1** treated any news keyword hit as HIGH → BLACKSHEEP. A full-roster sweep
  flagged **219 of 799 (27%)**, including ITC, SBIN, KOTAKBANK, ASIANPAINT,
  AMBUJACEM, HDFCAMC, ALKEM, ADANIPORTS. Obviously wrong.
- **v1.2** found two causes. First, banks are *creditors*: "SBI files insolvency
  plea against X" flagged SBI. Added a subject/creditor guard. Second, bare `fraud`
  and `going concern` co-occur in benign blue-chip news; tightened both. Also
  demoted news-only HIGH to GREY, and added a Yahoo retry so burst throttling
  couldn't manufacture a false `NO_DATA` (a structural HIGH).
- **v1.3** the demotion downgraded the flagship case: GAYAPROJ went GREY. Its
  suspension gap had aged out of Yahoo's 2y window (500 clean bars), so structure
  no longer saw anything — only news did. Added `BS_RESTRUCTURED`: narrow CIRP-exit
  vocabulary ("exits insolvency", "post-CIRP", "insolvency withdrawal",
  "reconstitutes board") treated as structural-grade. GAYAPROJ → BLACKSHEEP;
  KOTAKBANK's "fraud case" stayed GREY.
- **v1.4** SYNGENE appeared as newly-flagged on the corrected sweep. Its flag was
  `auditor resignation` — statutory auditor rotation in India, and it was a
  *subsidiary's* auditor. Even a perfect matcher flags that. Worse: `bsNews_`
  swallowed fetch errors silently, so under 799 rapid calls many names had **no
  news evaluated at all** — making the verdict depend on fetch luck. CLEAN could
  mean "sound data" or "news never ran", and the weekly drift diff churned on RSS
  availability rather than deterioration.

**The principle that settled it:** a headline does not corrupt an indicator. The
🐏/⚠/🟢 stamp exists to warn that the *data* is untrustworthy. Structure is
deterministic and reproducible; keyword matching on headlines is not, and is
unwinnable in the limit. `newsOk` now reports fetch success so silent degradation
is visible.

**Accepted trade:** SYNGENE's auditor resignation and KOTAKBANK's ED search now
read CLEAN. Both headlines still display. If a genuine fundamental-deterioration
signal is wanted, it belongs in Tier 2 or a dedicated news panel with its own
severity — not in the data-integrity stamp.

**Residual, by design:** the subject guard locates the company via its most
distinctive name token, so 3-letter names like ITC yield no token and fall to
"subject unconfirmed" (→ context, not verdict). Correct outcome here — the ITC
headlines were about *input tax credit* GST fraud, not the company.

---

## D-002 · Roster auto-maintenance never acts on a single run (25-Jul-2026)

**Final state:** `RosterHealth.gs` v1.0. Three guards, and nothing auto-applies.

**Guard 1 — per-name debounce.** One bad audit → WATCH. Three consecutive →
QUARANTINE. Five → REPLACE_READY. A single bad run moves nothing.

**Guard 2 — error ≠ death.** A fetch/parse failure records as `X` and carries no
information: it cannot manufacture an escalation, and it does not reset a genuine
bad streak (`DDXD` → streak 3). This encodes the AURIONPRO / FIEMIND lesson, where
Yahoo returned transient bad data on healthy stocks mid-corporate-action.

**Guard 3 — systemic circuit breaker.** If >10% of the roster flags bad, or >25%
is unreadable, or coverage is <95%, the *run* is suspect rather than the stocks.
History is recorded; escalation freezes entirely. This exists because the v1.1
sweep flagged 137/799 from one systemic cause — an auto-swapper acting on that run
would have proposed replacing 17% of the roster. The test suite replays those
exact numbers.

**Nothing automatic.** REPLACE_READY produces a proposal pairing a drop with a
gate-screened add, capped at 5 per run, deferred with a stated reason when no
candidate exists — never a bare deletion. A complete replacement `var UNIVERSE`
block is staged to the `RosterSwap` sheet for human review. The generating
function is round-trip tested: the emitted block is `eval`'d and verified to
reconstruct the identical line list, apostrophes intact.

**Consequence to expect:** genuine escalation takes five weekly cycles. The system
is quiet by design for over a month. Silence is it working.

**Note on scope:** this hangs off `ugAuditUniverse()` (DEAD/PROBLEM/CAUTION/OK),
not Black Sheep. Black Sheep correctly returns 0 BLACKSHEEP across the roster
because UniverseGate already screens for exactly what its structural tier detects
— two independent screens agreeing. Black Sheep's role is prospective: individual
lookups on portfolio adds and universe candidates.

---

## D-003 · Bull Watch has no probability to calibrate (25-Jul-2026)

Bull Watch is a deterministic 20/50/200-DMA classifier, so unlike Sell Watch there
is no forecast to recalibrate. Its honest health metric is whether the classes
separate outcomes: STRONG should show a higher hold rate and mean forward return
than BULL, and BULL than CAUTION. If CAUTION out-holds STRONG, the classifier has
drifted.

Predictions are **harvested, not recomputed** — `runScan` already writes each
stock's `bull{}` into the `Scan` sheet, so `runBullLog` copies bull-on names into
`BullCalib` daily with zero change to `runScan`. The Brier scores the `P(hold·21d)`
column the board already displays (1 − bootstrap P(fall)). The sell champion map is
deliberately **not** applied: it was fit on the mean-reverting population only.

---

## D-004 · The Black Sheep tab bug was an async contract collision (25-Jul-2026)

Symptom: the tab rendered for portfolio holdings but returned nothing for a symbol
picked from the universe.

Cause: `bsFetch_` deduped in-flight requests with `if (BS[sym].pending) return
BS[sym].pending`, returning the *promise*. But the on-demand input path seeded
`BS[sym] = {pending: true}` — a **boolean** — purely to paint a "checking…" row.
So `bsFetch_` returned `true`, and `true.then(...)` threw; the network call never
fired. The portfolio path worked only because it never seeded that placeholder.

Fix: short-circuit only on a thenable (`typeof BS[sym].pending.then === 'function'`),
otherwise fall through and fetch. One line. Dedupe and cache behaviour preserved,
verified by `test_bsfetch.js`.

---

## D-005 · Bull Watch has no selection edge; its labels were inverted (25-Jul-2026)

**Evidence:** `BullBackfill.gs` v1.2, 65,229 non-overlapping episodes across 799
stocks, horizons 21d and 63d, date- and stock-clustered bootstraps.

### Finding 1 — the board does not beat its own universe (robust)

`STRONG − ALL BARS`, 21-day horizon:

| metric | point | 95% CI |
|---|---|---|
| hold rate | +2.1% | [−0.7%, +4.6%] |
| mean return | −0.1% | [−0.8%, +0.6%] |
| median return | +0.3% | [−0.3%, +0.9%] |

Null on all three. Same at 63 days. BULL is the weakest bucket in the system
(median 0.7% vs the benchmark's 0.8%).

This conclusion has **no survivorship escape hatch**: both sides are drawn from
the identical gate-screened universe at the identical stride bars, so the bias
cancels. Being on the STRONG board is worth what picking a random bar in the
same universe is worth.

STRONG's raw numbers (55.4% hold, 2.0% mean) look respectable only until set
against the benchmark (53.4%, 2.1%). The universe is decent; the classifier
adds nothing on top.

### Finding 2 — CAUTION pooled two opposite populations

Splitting CAUTION by trigger:

| bucket | n | hold | mean | median |
|---|---|---|---|---|
| C_EXTENDED (ext200≥30 or RSI≥80) | 6,012 | 56.0% | 4.3% | 1.9% |
| C_PULLBACK (below 20 DMA) | 4,554 | 53.9% | 2.1% | 1.0% |
| STRONG (for comparison) | 5,548 | 55.4% | 2.0% | 1.1% |

`ext200 ≥ 30%` fires on stocks stretched *because they have been running* — a
momentum characteristic at a 1–3 month horizon, not a warning. `below20` fires
on one that has already broken down. Pooling them under a single label and
calling it "caution" is what the v1.0 test actually measured.

### Finding 3 — the grade ordering is inverted, twice over

`grade A − grade C` mean = −1.4% [−2.2%, −0.6%], interval clear of zero.

Two distinct failures. **Structural:** `grade = cls === 'CAUTION' ? 'C' : …`
makes grade C *identical to* CAUTION, so C mechanically inherits the best
bucket's numbers. **Independent:** setting the label aside, grade A (1.8% mean)
underperforms grade B (2.1%) on ~6,000 episodes each — so the four-indicator
confirmation stack (MACD expansion, RVOL≥1.5, OBV rising, RSI 40–80) does not
rank either.

### Finding 4 — the extension effect is real but a third the apparent size

`STRONG − C_EXTENDED`: mean −2.3% [−3.3%, −1.3%], median **−0.8% [−1.5%, +0.2%]**.

The whole distribution shifts, so it is not a pure lottery profile — but
two-thirds of the apparent advantage lives in the right tail, and the median
interval touches zero. `topDecileShare` argues the same way and against the
prior expectation: C_EXTENDED is **0.93** vs BENCHMARK **1.39** and STRONG
**1.25** (above 1.0 means the bottom 90% are net negative), so C_EXTENDED is
the *least* tail-concentrated bucket, not the most.

Dispersion accounts for much of the rest: (p90−p10)/2.56 gives ≈10.0% for
STRONG and ≈14.5% for C_EXTENDED — 45% wider for a 0.8pp median gain.

### Decisions

1. **Split the CAUTION label.** Robust in both possible worlds: if the momentum
   finding is genuine, warning about C_EXTENDED is backwards; if it is entirely
   survivorship, C_EXTENDED is at most comparable to STRONG — nothing suggests
   it is *worse*, which is what the label claims.
2. **Remove the grade, do not re-fit it.** Neither component has earned an
   ordering, and re-deriving grades from this sample would be fitting labels to
   noise.
3. **Do NOT promote extension to a buy signal.** The statistic best supported
   (the mean) is the one least trustworthy: survivorship censors
   extended→collapsed→delisted, which would fatten the left tail and pull the
   mean down. The survivorship-robust statistic (the median) is marginal.
   Asymmetric cost decides it — relabelling is cheap and reversible; promotion
   would systematically route toward the population whose failures were deleted
   from the sample.

**Threshold to revisit, set in advance:** a median gap whose CI clears zero on
either (a) 6–12 months of live `runBullLog` accrual, which is uncensored, or
(b) a delisted-inclusive historical sample.

### Method note

The mean-difference bootstrap was decisive and nearly absent: on hold rate
alone, `STRONG − C_EXTENDED` reads −0.7% [−3.6%, +2.6%] — a clean null. The
entire finding lives in the return distribution, which v1.0 had no instrument
to see. Any future classifier test needs hold rate, mean, AND median.

---

## D-006 · TierLab: cross-sectional ranking, pre-registered (25-Jul-2026)

**Why a new tool.** Bull Watch asks an absolute per-stock question ("is this
stock trending?") and tested flat. Absolute rules drift with the market — in a
rising tape most names qualify and the tier converges to the index. A
cross-sectional rank is selective by construction: exactly 10% of names sit in
the top decile on every date, in every regime.

**PRE-REGISTRATION (Krishna, before any result existed).** Proximity to the
52-week high predicts forward return; a stock cannot make a sustained run until
it clears its prior high. Factor `pct52w = close / max(close, 252d)`, direction
HIGHER → HIGHER forward return. Motivated by, not mined from, the literature
(George & Hwang, *The 52-Week High and Momentum Investing*, J.Finance 2004).

**Success criterion, fixed in advance:** in the sealed holdout, the top decile's
median 1-month forward return must exceed the universe median with a
date-clustered CI clear of zero, AND the decile gradient must be broadly
monotone (Spearman rho ≥ 0.60). Median because D-005 showed means carried by
tails; monotonicity because a lucky single bucket is easy to stumble into
whereas a clean 1→10 gradient is not.

**Analysis plan, declared before either test ran:** two confirmations —
`volMom` (train-selected champion) and `pct52w` (the standing hypothesis) —
with intervals Bonferroni-widened to 97.5% so that two looks cannot buy
significance.

**Correction to an earlier position.** I first advised against confirming
`volMom` on the grounds that selecting it after seeing train would be
data-mining. That was wrong. Exploring on train, selecting, then testing once
on holdout is the standard and correct procedure; what would be illegitimate is
running all five through the holdout and reporting the winner as a single test.

**Training results (holdout untouched):**

| factor | rho | top − universe median |
|---|---|---|
| volMom | 0.976 | +0.82% [0.22, 1.36] |
| mom12_1 | 0.915 | +0.79% [0.17, 1.42] |
| ext200 | 0.77 | +0.54% [−0.13, 1.16] |
| upFrac | 0.915 | +0.38% [−0.24, 0.81] |
| pct52w | 0.879 | +0.11% [−0.55, 0.72] |

**Refinement to the hypothesis, from training data.** The *direction* holds:
deciles 1→9 climb steadily (0%, 0.23%, 0.55%, 0.78%, 0.82%, 0.76%, 1.17%,
0.92%, 1.26%) — buy-the-dip is not what the data shows. But decile 10 falls
back to 0.88%, and `pct52w` is the only factor of the five whose top decile is
not its own best bucket. Mechanical reason: `pct52w` is bounded at 1.0 and
compresses in a bull market, so deciles 9 and 10 differ mostly by noise.

`volMom` (momentum ÷ realised volatility) has the cleanest gradient in the set
and corroborates D-005 independently — dividing by volatility is precisely what
strips out the tail-driven component that made raw extension look better than
it was.

### OUTCOME — both confirmations FAILED the criterion (26-Jul-2026)

Holdout: 22,464 rows, 32 months from 2023-10. Harvest verified deterministic
(64,077 rows / 48 too-short, identical to the first clean run).

| factor | top − universe median | 97.5% CI (Bonferroni, 2 tests) | rho | verdict |
|---|---|---|---|---|
| volMom | +0.57% | [−0.26%, +1.82%] | 0.855 | FAIL |
| pct52w | **+0.79%** | [−0.17%, +1.66%] | 0.855 | FAIL |

*(Both rho values are genuinely 0.855 — verified by hand, Σd² = 24 in each
table, 1 − 144/990 = 0.8545. Coincidence, not a bug.)*

**What failed was precision, not the gradient.** Both cleared the monotonicity
floor comfortably (0.855 vs 0.60) and both point estimates are positive. They
failed only because the intervals include zero. Bonferroni is not the culprit:
widening 95% → 97.5% adds roughly 15% to the half-width, and at 95% single-test
`pct52w` would give approximately [−0.01%, +1.59%] — still touching zero,
marginally. It fails either way.

**Two observations that survive the failure:**

1. **`pct52w` IMPROVED out of sample** — +0.11% in training to +0.79% in the
   holdout, overtaking `volMom`. That is the opposite of the overfitting
   signature; a noise-fitted factor degrades. Could be regime rather than
   substance, but it is not what a spurious result usually looks like.
2. **The decile-10 anomaly did not replicate.** In training, decile 10 fell back
   (0.88% vs decile 9's 1.26%), prompting a "mild reversal at new highs"
   reading. In the holdout the top is monotone: 1.31%, 1.32%. That inference
   was training noise and is withdrawn.

**Explicitly NOT used to rescue the result:** the 3-month secondary looked
strong for `pct52w` (top 2.94% vs universe 1.33%, rho 0.903), and top-vs-bottom
has more power. Both were excluded from the criterion in advance; reaching for
them now is precisely the post-hoc move this design exists to prevent.

### NEW PRE-REGISTRATION, for a future test on data that does not yet exist

**Hypothesis:** `pct52w`, 3-month horizon. Top decile's median 3-month forward
return exceeds the universe median, CI clear of zero, rho ≥ 0.60.
**Rationale:** the 1-month test was underpowered, not negative, and the 3-month
secondary was directionally strong. A longer horizon carries more signal per
observation if the effect is a genuine momentum persistence.
**Condition:** may only be tested once the holdout contains ≥ 44 months. At 32
months the half-width was ~0.92pp against a 0.79pp point estimate; since the
interval narrows roughly as 1/√K, resolving an effect of that size needs about
K × (0.92/0.79)² ≈ 43–44 date clusters. **That is ~12 more months of data.**
Re-testing before then is re-rolling the same dice.

**Status:** closed. Holdout spent. No tier ships on this evidence.

### Bugs found and fixed in this file

- **Sheets coerced `'2016-04'` into a Date.** `String(cell)` then returned
  `'Fri Apr 01 2016 …'`, and sorting those alphabetically sorted by WEEKDAY
  NAME — so the chronological train/holdout split silently became a split by
  day-of-week, spanning the whole sample on both sides. Caught only because
  `tierSplitInfo()` printed a range running Apr-2022 → Sep-2021. Fixed by
  reading the month name out of the string (timezone-independent; parsing with
  `new Date()` and reading `getMonth()` shifts the month in a UTC runtime).
- **Bootstrap sorted ~90k values per iteration** (~1.5e9 comparisons) and blew
  the 6-minute ceiling. Replaced with quickselect on a reused buffer: 250
  medians of 90k values now take 31ms.

---

## D-007 · Apps Script UrlFetch quota is the binding constraint on research (26-Jul-2026)

Both projects execute as the same user, so Steam Gauge and Indicators share ONE
daily UrlFetch pool — roughly 20,000 calls/day for a consumer account. On
25-Jul it was exhausted, and every fetch then failed after ~9.5s with
*"Service invoked too many times for one day: urlfetch"*. Steam Gauge went dark
as collateral damage: every one of its features needs UrlFetch, so there is no
path through it that degrades gracefully.

Rough spend that day: two black-sheep sweeps at ~2,400 each (every roster name
triggers a Steam call, which itself fetches Yahoo *and* Google News), a forced
sweep, `ugAuditUniverse` 799, two BullBackfill harvests, one TierLab harvest,
five failed TierLab attempts, plus daily `runScan`.

Quota resets at midnight Pacific (~12:30 PM IST).

**Recurring automated load is fine:** `runScan` ~799/day, `saturdayHealthRun`
~2,400 (sheep) + `ugHealthWatch` ~799 → roughly 4,000 on a Saturday.

**Research is what overruns it.** BullBackfill and TierLab fetch the *identical*
10-year history for the *identical* 799 stocks, and every re-run pays again.

**Decision — build a deep-history vault.** Fetch 10y once per stock, store it
(one row per stock, compact JSON), and have every research tool read from
storage. A weekly incremental top-up costs a few hundred calls instead of
thousands. Re-harvests, new factors, and new horizons then cost nothing, and
iteration goes from ~184s to a few seconds of sheet reads. This is the highest-
leverage item remaining.

**Diagnostic lesson.** Two wrong diagnoses preceded the right one (a whole-
column reformat; then Yahoo-side throttling), both reasoned from plausible
mechanisms rather than from the actual error text. The probe that printed the
raw exception settled it in ten seconds. Get the error string first.

Guard added: `tlQuotaExceeded_()` in TierLab.gs (shared project scope, called by
BullBackfill.gs too) detects this specific error, saves progress, and stops
immediately rather than burning the budget at 9.5s per doomed call.

