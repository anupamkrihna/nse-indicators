/**
 * ═══════════════════════════════════════════════════════════════════
 * BULLBACKFILL.gs — retrospective Bull Watch validation (v1.0, 25-Jul-2026)
 * ADDITIVE. New file in the INDICATORS project. Touches nothing existing.
 *
 * THE QUESTION
 *   Bull Watch is a deterministic classifier, so there is no probability to
 *   recalibrate (see DECISIONS.md D-003). Its only honest health test is
 *   whether the classes SEPARATE OUTCOMES: does STRONG actually out-hold
 *   CAUTION, and does STRONG beat simply holding everything?
 *
 * WHY BACKFILL IS LEGITIMATE HERE
 *   Unlike the sell signal — whose pFall is derived from the stock's own
 *   forward-return distribution, hence the purged-embargo machinery in
 *   runCalibBackfill — Bull classification uses ONLY backward-looking
 *   inputs at bar t (DMA slopes, ADX, RSI, MACD, RVOL, OBV). There is no
 *   leakage channel, so classifying at historical bar t and measuring
 *   t→t+21 is clean. Thousands of episodes are available immediately
 *   instead of waiting ~32 days for live logging to mature.
 *
 * FIDELITY (the thing that could silently invalidate everything)
 *   bbClassifyAt_ reproduces bullPack_ (Code.gs) exactly, but indexed at an
 *   arbitrary bar instead of the last one. test_bullbf.js asserts the two
 *   agree on cls AND grade across randomised series — if bullPack_ is ever
 *   changed, that test must be re-run or this backfill is measuring a
 *   different system than the board displays.
 *
 * TWO BIASES — REPORTED, NOT HIDDEN
 *   · SURVIVORSHIP — the 799 roster is today's survivors, gate-screened for
 *     200+ clean bars. Absolute hold rates are inflated.
 *   · REGIME — bull classifications cluster in rising markets, and the
 *     sample window is mostly up.
 *   Both lift all classes together, so the headline metric is the
 *   STRONG−CAUTION SPREAD and the STRONG−BENCHMARK spread, not any absolute
 *   rate. The benchmark is the unconditional 21-day hold rate of the SAME
 *   universe at the SAME stride bars — if STRONG holds 62% while everything
 *   holds 61%, there is no edge however good 62% looks.
 *
 * UNCERTAINTY
 *   Episodes are non-overlapping within a stock (stride = H) but correlated
 *   ACROSS stocks on the same date (market-wide regime). A naive per-episode
 *   bootstrap would understate the interval badly. Two cluster bootstraps
 *   are reported instead — resampling whole STOCKS, and resampling whole
 *   DATES. The date-clustered interval is the conservative one; if EITHER
 *   includes zero, the tiering has not demonstrated discriminating power.
 *
 * PRE-REGISTERED KILL CRITERION
 *   If the STRONG−CAUTION spread CI includes zero, the labels do not rank
 *   outcomes: rebuild the classifier or stop presenting STRONG/BULL/CAUTION
 *   as an ordering.
 *
 * OPS (Run dropdown)
 *   runBullBackfill()    — resumable; re-run until the log says DONE
 *   bullBackfillReport() — compute the tables, CIs, and verdict
 *   resetBullBackfill()  — clear episodes and progress
 * ═══════════════════════════════════════════════════════════════════
 */

var BBCFG = {
  RANGE:       '10y',
  BUDGET_MS:   270000,      // stop before the 6-min GAS ceiling
  START_IDX:   210,         // warmup: e200 needs 200, ADX ~28, OBV 20, RVOL 21
  SHEET:       'BullBF',
  RESULT_SHEET:'BullBFResults',
  BOOT_ITERS:  2000,
  BOOT_SEED:   20260725,
  MIN_BARS:    260,         // skip stocks with too little history to yield any episode
  H2:          63,          // second horizon (~3 months) for sensitivity; see bbSubsample_
  BOOT_MEDIAN: 400          // median CIs need value arrays (no sufficient statistics) — fewer iterations
};

/* ══════════════ PURE: bar-indexed indicator reads ══════════════
   Each mirrors a Code.gs helper that reads the LAST bar, re-expressed to
   read bar `idx`. Equivalences are asserted in test_bullbf.js. */

/* mirrors bullSlp_(arr) with n = idx+1 */
function bbSlopeAt_(arr, idx) {
  if (idx < 11 || arr[idx] == null || arr[idx - 10] == null || arr[idx - 10] === 0) return null;
  return Math.round((arr[idx] - arr[idx - 10]) / arr[idx - 10] * 10000) / 100;
}

/* mirrors rvol20(vol) with n = idx+1 */
function bbRvolAt_(vol, idx) {
  if (idx < 20) return null;
  var last = vol[idx], s = 0, c = 0;
  for (var i = idx - 20; i < idx; i++) { s += vol[i]; c++; }
  var avg = c ? s / c : 0;
  return avg > 0 ? Math.round(last / avg * 100) / 100 : null;
}

/* mirrors obvPack(...).trend with n = idx+1 (window 20, same thresholds) */
function bbObvTrendAt_(obv, idx) {
  if (idx < 19) return 'flat';
  var w = [];
  for (var i = idx - 19; i <= idx; i++) w.push(obv[i]);
  var slope = bbLinSlope_(w);
  var mx = Math.max.apply(null, w), mn = Math.min.apply(null, w);
  var span = (mx - mn) || 1;
  var norm = slope * 20 / span;
  return norm > 0.15 ? 'rising' : norm < -0.15 ? 'falling' : 'flat';
}
function bbLinSlope_(a) {
  var n = a.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (var i = 0; i < n; i++) { sx += i; sy += a[i]; sxy += i * a[i]; sxx += i * i; }
  var d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

/* OBV series (mirrors obvPack's accumulation) */
function bbObvSeries_(close, vol) {
  var obv = [0];
  for (var i = 1; i < close.length; i++)
    obv.push(obv[i - 1] + (close[i] > close[i - 1] ? vol[i] : close[i] < close[i - 1] ? -vol[i] : 0));
  return obv;
}

/* MACD(12,26,9) full series — same construction as macdPack, arrays retained */
function bbMacdSeries_(close, emaFn) {
  var e12 = emaFn(close, 12), e26 = emaFn(close, 26), n = close.length, line = [];
  for (var i = 0; i < n; i++) line.push(e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  var first = -1;
  for (var f = 0; f < n; f++) { if (line[f] != null) { first = f; break; } }
  var sig = new Array(n).fill(null);
  if (first >= 0) {
    var sub = emaFn(line.slice(first), 9);
    for (var j = 0; j < sub.length; j++) sig[first + j] = sub[j];
  }
  var hist = [];
  for (var k = 0; k < n; k++) hist.push(line[k] != null && sig[k] != null ? line[k] - sig[k] : null);
  return { line: line, sig: sig, hist: hist };
}

/* mirrors macdPack's histDir / histExpanding at bar idx.
   macdPack takes the last 3 of the NULL-FILTERED hist; past warmup the
   filtered tail equals hist[idx], hist[idx-1], hist[idx-2], so this is
   equivalent for every bar this backfill evaluates (idx ≥ START_IDX). */
function bbMacdAt_(hist, idx) {
  var H = hist[idx];
  if (H == null) return { hist: null, histDir: 'na', histExpanding: false };
  var a = hist[idx], b = hist[idx - 1], c = hist[idx - 2];
  var expanding = (a != null && b != null && c != null &&
    Math.abs(a) > Math.abs(b) && Math.abs(b) > Math.abs(c));
  return { hist: H, histDir: H > 0 ? 'bull' : 'bear', histExpanding: !!expanding };
}

/* mirrors bearishDivergence(close, rsi, lookback) with n = idx+1 */
function bbDivergenceAt_(close, rsi, idx, lookback) {
  lookback = lookback || 60;
  var n = idx + 1, from = Math.max(2, n - lookback), peaks = [];
  for (var i = from; i < n - 1; i++)
    if (close[i] > close[i - 1] && close[i] > close[i + 1] && rsi[i] != null) peaks.push(i);
  if (peaks.length < 2) return false;
  var a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
  return close[b] > close[a] && rsi[b] < rsi[a];
}

/* ══════════════ PURE: the classifier, mirroring bullPack_ at bar idx ══════════════
   Returns {on, cls, grade, ext200, stacked} — pHold/pullTail are omitted
   because bullPack_ derives them from the sell bootstrap, which plays no
   part in classification. */
function bbClassifyAt_(cl, e20, e50, e200, adxRegime, macdObj, rvolV, obvTrendV, rsiV, rsiDiv, idx) {
  var price = cl[idx];
  var s20 = bbSlopeAt_(e20, idx), s50 = bbSlopeAt_(e50, idx), s200 = bbSlopeAt_(e200, idx);
  if (s20 == null || s50 == null || s200 == null) return { on: false };
  if (!(s20 > 0 && s50 > 0 && s200 > 0)) return { on: false };
  var v20 = e20[idx], v50 = e50[idx], v200 = e200[idx];
  if (v20 == null || v50 == null || v200 == null || v200 === 0) return { on: false };
  var ext200 = Math.round((price - v200) / v200 * 1000) / 10;
  var stacked = price > v20 && v20 > v50 && v50 > v200;
  var trending = (adxRegime === 'trend' || adxRegime === 'strong');
  var why = [];
  if (rsiDiv) why.push('div');
  if (ext200 >= 30) why.push('ext');
  if (rsiV != null && rsiV >= 80) why.push('rsi80');
  if (price < v20) why.push('below20');
  var cls = why.length ? 'CAUTION' : (stacked && trending ? 'STRONG' : 'BULL');
  var confirms = 0;
  if (macdObj && macdObj.histExpanding && macdObj.histDir === 'bull') confirms++;
  if (rvolV != null && rvolV >= 1.5) confirms++;
  if (obvTrendV === 'rising') confirms++;
  if (rsiV != null && rsiV >= 40 && rsiV <= 80) confirms++;
  var grade = cls === 'CAUTION' ? 'C' : (trending && confirms >= 2 ? 'A' : 'B');
  return { on: true, cls: cls, grade: grade, why: why, ext200: ext200, stacked: stacked };
}

/* ══════════════ PURE: statistics ══════════════ */

function bbRate_(rows) {
  if (!rows.length) return null;
  var h = 0;
  for (var i = 0; i < rows.length; i++) h += (rows[i].fwd >= 0 ? 1 : 0);
  return h / rows.length;
}
function bbMeanFwd_(rows) {
  if (!rows.length) return null;
  var s = 0;
  for (var i = 0; i < rows.length; i++) s += rows[i].fwd;
  return s / rows.length;
}

/* class table + the unconditional benchmark over the identical bar set */
function bbTable_(rows) {
  var byCls = { STRONG: [], BULL: [], CAUTION: [] }, all = rows || [];
  all.forEach(function (r) { if (byCls[r.cls]) byCls[r.cls].push(r); });
  function agg(a) {
    var hr = bbRate_(a), mf = bbMeanFwd_(a);
    return { n: a.length,
      holdRate: hr == null ? null : Math.round(hr * 10000) / 10000,
      meanFwd:  mf == null ? null : Math.round(mf * 100000) / 100000 };
  }
  return { STRONG: agg(byCls.STRONG), BULL: agg(byCls.BULL), CAUTION: agg(byCls.CAUTION),
    BENCHMARK: agg(all), onBoard: agg(byCls.STRONG.concat(byCls.BULL, byCls.CAUTION)) };
}

/* seeded LCG — same convention as sellRng_, so reports are reproducible */
function bbRng_(seed) {
  var s = (seed || 1) % 4294967296;
  return function () { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296; };
}

/* hold-rate difference between two groups, or vs the full sample */
function bbSpread_(rows, clsA, clsB) {
  var a = rows.filter(function (r) { return r.cls === clsA; });
  var b = (clsB === '*') ? rows : rows.filter(function (r) { return r.cls === clsB; });
  var ra = bbRate_(a), rb = bbRate_(b);
  if (ra == null || rb == null) return null;
  return ra - rb;
}

/* CLUSTER bootstrap on SUFFICIENT STATISTICS.
   A hold-rate spread needs only four counters per cluster (holds and n, for
   each of the two groups), so a resample is a sum over clusters rather than a
   rebuild-and-refilter of every episode. At ~86k episodes and 2000 iterations
   the naive form is ~500M ops — well past the 6-min GAS ceiling; this is
   ~1.6M and mathematically identical. Verified equal in test_bullbf.js. */
function bbClusterStats_(rows, clusterKey, clsA, clsB) {
  var m = {}, keys = [];
  rows.forEach(function (r) {
    var k = String(r[clusterKey]);
    if (!m[k]) { m[k] = { aH: 0, aN: 0, aS: 0, bH: 0, bN: 0, bS: 0 }; keys.push(k); }
    var held = r.fwd >= 0 ? 1 : 0;
    if (r.cls === clsA) { m[k].aN++; m[k].aH += held; m[k].aS += r.fwd; }
    if (clsB === '*') { m[k].bN++; m[k].bH += held; m[k].bS += r.fwd; }   // '*' = whole sample as benchmark
    else if (r.cls === clsB) { m[k].bN++; m[k].bH += held; m[k].bS += r.fwd; }
  });
  return keys.map(function (k) { return m[k]; });
}

function bbBootstrapCI_(rows, clusterKey, clsA, clsB, iters, rng, metric) {
  iters = iters || BBCFG.BOOT_ITERS;
  rng = rng || bbRng_(BBCFG.BOOT_SEED);
  metric = metric || 'hold';                                  // 'hold' = win rate · 'mean' = mean forward return
  var stats = bbClusterStats_(rows, clusterKey, clsA, clsB), K = stats.length;
  if (K < 2) return null;
  var point = (metric === 'mean') ? bbMeanSpread_(rows, clsA, clsB) : bbSpread_(rows, clsA, clsB);
  var draws = [];
  for (var it = 0; it < iters; it++) {
    var aH = 0, aN = 0, aS = 0, bH = 0, bN = 0, bS = 0;
    for (var j = 0; j < K; j++) {
      var g = stats[Math.floor(rng() * K)];
      aH += g.aH; aN += g.aN; aS += g.aS; bH += g.bH; bN += g.bN; bS += g.bS;
    }
    if (!aN || !bN) continue;
    draws.push(metric === 'mean' ? (aS / aN - bS / bN) : (aH / aN - bH / bN));
  }
  if (draws.length < 100) return null;
  draws.sort(function (x, y) { return x - y; });
  function pct(p) { return draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))]; }
  return { point: point == null ? null : Math.round(point * 10000) / 10000,
    lo: Math.round(pct(0.025) * 10000) / 10000,
    hi: Math.round(pct(0.975) * 10000) / 10000,
    iters: draws.length, clusters: K, metric: metric };
}

/* mean forward-return difference between two groups */
function bbMeanSpread_(rows, clsA, clsB) {
  var a = rows.filter(function (r) { return r.cls === clsA; });
  var b = (clsB === '*') ? rows : rows.filter(function (r) { return r.cls === clsB; });
  var ma = bbMeanFwd_(a), mb = bbMeanFwd_(b);
  if (ma == null || mb == null) return null;
  return ma - mb;
}

/* Bucket a CAUTION episode by WHY it was flagged. The four triggers are not
   one phenomenon: ext200≥30 and RSI≥80 fire on stocks that are stretched
   BECAUSE they have been running (a momentum characteristic at a 21-day
   horizon), whereas price<20DMA fires on one that has already broken down.
   Pooling them under a single CAUTION label is what the v1.0 backfill
   measured. Buckets are mutually exclusive, breakdown taking precedence. */
function bbBucketOf_(why) {
  var w = String(why || '');
  if (!w) return '';
  var has = function (c) { return w.split(',').indexOf(c) >= 0; };
  if (has('below20')) return 'C_PULLBACK';                    // already broken down
  if (has('ext') || has('rsi80')) return 'C_EXTENDED';        // stretched to the upside
  if (has('div')) return 'C_DIVERGENCE';                      // momentum not confirming
  return 'C_OTHER';
}

/* Re-label rows for an arbitrary comparison so the tested spread/bootstrap
   helpers can be reused unchanged. tagFn returns a group label, or '' to drop
   the row. horizonKey selects which forward return to analyse. */
function bbTag_(rows, tagFn, horizonKey) {
  var out = [];
  rows.forEach(function (r) {
    var g = tagFn(r); if (!g) return;
    var f = r[horizonKey];
    if (f == null || f === '') return;
    out.push({ sym: r.sym, date: r.date, cls: g, fwd: Number(f) });
  });
  return out;
}

/* Stride-H2 subsample. Episodes are harvested at stride 21, so at a 63-day
   horizon consecutive episodes overlap three-deep and are NOT independent —
   a date-clustered bootstrap would understate the interval. Keeping every
   third bar restores non-overlap at H2. */
function bbSubsample_(rows, startIdx, stride) {
  return rows.filter(function (r) { return ((Number(r.t) - startIdx) % stride) === 0; });
}

/* ── distribution shape ──
   A mean can be driven either by broad, reliable improvement or by a few very
   large winners. Those imply opposite position sizing, and the mean alone
   cannot tell them apart: C_EXTENDED wins only 56% of the time yet returns
   4.3%, which is the signature of right-skew. These stats separate the two. */
function bbQuantile_(sortedAsc, p) {
  var n = sortedAsc.length;
  if (!n) return null;
  var i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

function bbDist_(rows, key) {
  var v = [];
  (rows || []).forEach(function (r) { var x = r[key]; if (x != null) v.push(Number(x)); });
  var n = v.length;
  if (!n) return { n: 0 };
  v.sort(function (a, b) { return a - b; });
  var sum = 0, wins = [], losses = [];
  for (var i = 0; i < n; i++) { sum += v[i]; if (v[i] >= 0) wins.push(v[i]); else losses.push(v[i]); }
  var mean = sum / n;
  /* share of the total return contributed by the best 10% of episodes.
     ~0.1 would mean returns are evenly spread; values near or above 1 mean the
     whole result rests on a handful of outcomes (and >1 means the other 90%
     are net negative). */
  var cut = Math.max(1, Math.floor(n * 0.1)), top = 0;
  for (var j = n - cut; j < n; j++) top += v[j];
  var med = bbQuantile_(v, 0.5);
  function mn(a) { if (!a.length) return null; var s2 = 0; for (var k = 0; k < a.length; k++) s2 += a[k]; return s2 / a.length; }
  return { n: n, hold: wins.length / n, mean: mean, median: med,
    p10: bbQuantile_(v, 0.10), p25: bbQuantile_(v, 0.25),
    p75: bbQuantile_(v, 0.75), p90: bbQuantile_(v, 0.90),
    meanWin: mn(wins), meanLoss: mn(losses),
    skew: mean - med,                                        // >0 = right-skewed (a few big winners)
    topDecileShare: sum !== 0 ? top / sum : null };
}

/* median-difference cluster bootstrap. Medians are not expressible as
   sufficient statistics, so this keeps per-cluster VALUE arrays and runs fewer
   iterations. Only used on named pairs, so the working set stays small. */
function bbBootstrapMedianCI_(rows, clusterKey, clsA, clsB, iters, rng) {
  iters = iters || BBCFG.BOOT_MEDIAN;
  rng = rng || bbRng_(BBCFG.BOOT_SEED);
  var A = {}, B = {}, keys = [];
  rows.forEach(function (r) {
    var k = String(r[clusterKey]);
    if (!A[k]) { A[k] = []; B[k] = []; keys.push(k); }
    if (r.cls === clsA) A[k].push(r.fwd);
    if (clsB === '*' || r.cls === clsB) B[k].push(r.fwd);
  });
  var K = keys.length;
  if (K < 2) return null;
  function medOf(arr) { if (!arr.length) return null; var c = arr.slice().sort(function (x, y) { return x - y; }); return bbQuantile_(c, 0.5); }
  var allA = [], allB = [];
  keys.forEach(function (k) { allA = allA.concat(A[k]); allB = allB.concat(B[k]); });
  var mA = medOf(allA), mB = medOf(allB);
  if (mA == null || mB == null) return null;
  var point = mA - mB, draws = [];
  for (var it = 0; it < iters; it++) {
    var sa = [], sb = [];
    for (var j = 0; j < K; j++) {
      var k2 = keys[Math.floor(rng() * K)];
      var ga = A[k2], gb = B[k2];
      for (var p = 0; p < ga.length; p++) sa.push(ga[p]);
      for (var q = 0; q < gb.length; q++) sb.push(gb[q]);
    }
    if (!sa.length || !sb.length) continue;
    draws.push(medOf(sa) - medOf(sb));
  }
  if (draws.length < 50) return null;
  draws.sort(function (x, y) { return x - y; });
  function pct(p2) { return draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p2 * draws.length)))]; }
  return { point: Math.round(point * 10000) / 10000, lo: Math.round(pct(0.025) * 10000) / 10000,
    hi: Math.round(pct(0.975) * 10000) / 10000, iters: draws.length, clusters: K, metric: 'median' };
}

/* verdict against the pre-registered kill criterion */
function bbVerdict_(ciStock, ciDate) {
  if (!ciStock || !ciDate) return { pass: false, text: 'insufficient data for an interval' };
  var crosses = function (ci) { return ci.lo <= 0 && ci.hi >= 0; };
  if (crosses(ciDate) || crosses(ciStock))
    return { pass: false, text: 'KILL CRITERION MET — the STRONG−CAUTION spread interval includes zero (' +
      (crosses(ciDate) ? 'date-clustered' : 'stock-clustered') + '). The labels have not demonstrated ranking power.' };
  if (ciDate.point <= 0)
    return { pass: false, text: 'spread is negative — CAUTION is out-holding STRONG; the classifier is inverted or drifted' };
  return { pass: true, text: 'STRONG−CAUTION spread is positive with both cluster intervals clear of zero' };
}

/* ══════════════ GAS: resumable episode harvest ══════════════ */
function runBullBackfill() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('bullbf_idx') || '0', 10);
  var sh = sheet_(BBCFG.SHEET, ['sym', 'date', 't', 'cls', 'grade', 'why', 'fwd21', 'fwd63']);
  if (sh.getLastRow() >= 1) {                                  // guard: never append v1.1 rows onto a v1.0 sheet
    var h0 = sh.getRange(1, 1, 1, 8).getValues()[0];
    if (String(h0[2]) !== 't' || String(h0[6]) !== 'fwd21') {
      Logger.log('runBullBackfill: ABORT — ' + BBCFG.SHEET + ' holds the old v1.0 schema. ' +
        'Run resetBullBackfill() first, or the two schemas will mix and corrupt the report.');
      return;
    }
  }
  var batch = [], done = start, logged = 0, skipped = 0, H = SELL.H, H2 = BBCFG.H2;

  for (var s = start; s < uni.length; s++) {
    if (Date.now() - t0 > BBCFG.BUDGET_MS) break;
    done = s + 1;
    try {
      var u = uni[s], bars = getBarsDeep_(u.sym, BBCFG.RANGE);   // Code.gs helper
      if (!bars || !bars.close || bars.close.length < BBCFG.MIN_BARS) { skipped++; continue; }
      var cl = bars.close, hi = bars.high, lo = bars.low, vol = bars.volume, ts = bars.ts, n = cl.length;

      /* full-series indicators, computed ONCE per stock (Code.gs pure fns) */
      var e20 = ema(cl, 20), e50 = ema(cl, 50), e200 = ema(cl, 200);
      var rsiArr = rsiSeries(cl, 14);
      var adxS = adxSeries_(hi, lo, cl, 14);
      var macdS = bbMacdSeries_(cl, ema);
      var obv = bbObvSeries_(cl, vol);

      for (var t = BBCFG.START_IDX; t <= n - 1 - H; t += H) {      // stride H → non-overlapping at H
        var fwd = cl[t + H] / cl[t] - 1;
        var fwd2 = (t + H2 <= n - 1) ? (cl[t + H2] / cl[t] - 1) : '';
        var reg = adxRegimeOf_(adxS[t]);
        var b = bbClassifyAt_(cl, e20, e50, e200, reg, bbMacdAt_(macdS.hist, t),
          bbRvolAt_(vol, t), bbObvTrendAt_(obv, t), rsiArr[t],
          bbDivergenceAt_(cl, rsiArr, t, 60), t);
        var d = ts[t] ? new Date(ts[t] * 1000).toISOString().slice(0, 10) : '';
        batch.push([u.sym, d, t, b.on ? b.cls : 'OFF', b.on ? b.grade : '',
          (b.on && b.why) ? b.why.join(',') : '',
          Math.round(fwd * 100000) / 100000,
          fwd2 === '' ? '' : Math.round(fwd2 * 100000) / 100000]);
        logged++;
      }
      if (batch.length >= 2000) { sh.getRange(sh.getLastRow() + 1, 1, batch.length, 8).setValues(batch); batch = []; }
    } catch (err) {
      if (typeof tlQuotaExceeded_ === 'function' && tlQuotaExceeded_(err)) {
        props.setProperty('bullbf_idx', String(s));                // daily UrlFetch quota — stop, keep progress
        if (batch.length) sh.getRange(sh.getLastRow() + 1, 1, batch.length, 8).setValues(batch);
        Logger.log('bullBackfill: STOPPED at ' + s + '/' + uni.length +
          ' — Apps Script daily UrlFetch quota exhausted. Progress saved. Resets ~12:30 PM IST.');
        return;
      }
      skipped++;                                                  // one bad symbol never aborts the run
    }
  }
  if (batch.length) sh.getRange(sh.getLastRow() + 1, 1, batch.length, 8).setValues(batch);
  var finished = done >= uni.length;
  props.setProperty('bullbf_idx', finished ? '0' : String(done));
  Logger.log('bullBackfill: stocks ' + start + '→' + done + '/' + uni.length + ', ' + logged +
    ' episodes, ' + skipped + ' skipped, ' + Math.round((Date.now() - t0) / 1000) + 's. ' +
    (finished ? 'DONE — now run bullBackfillReport().' : 'Not finished — run runBullBackfill() again to resume.'));
}

function resetBullBackfill() {
  PropertiesService.getScriptProperties().deleteProperty('bullbf_idx');
  var ss = SpreadsheetApp.getActive();
  [BBCFG.SHEET, BBCFG.RESULT_SHEET].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh) { try { sh.clear(); } catch (e) { /* already gone */ } }   // clear, never delete (stale-handle quirk)
  });
  SpreadsheetApp.flush();
  Logger.log('bull backfill cleared — next runBullBackfill() starts fresh');
}

/* ══════════════ GAS: the report ══════════════ */
function bullBackfillReport() {
  var sh = SpreadsheetApp.getActive().getSheetByName(BBCFG.SHEET);
  if (!sh || sh.getLastRow() < 100) { Logger.log('bullBackfillReport: too few episodes — run runBullBackfill() first'); return; }
  /* SCHEMA GUARD — v1.0 wrote 4 columns [sym,date,cls,fwd]; v1.1 writes 8.
     If both are present the old rows read as fwd21='' → Number('')===0 → counted
     as a hold, which silently inflated BENCHMARK to 84.5% on the first v1.1 run.
     Refuse to report rather than mix schemas. */
  var hdr = sh.getRange(1, 1, 1, 8).getValues()[0];
  if (String(hdr[2]) !== 't' || String(hdr[6]) !== 'fwd21') {
    Logger.log('bullBackfillReport: ABORT — the ' + BBCFG.SHEET + ' sheet is in the old v1.0 schema ' +
      'or mixes schemas. Run resetBullBackfill(), then re-harvest with runBullBackfill().');
    return;
  }
  var d = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues(), rows = [], stale = 0;
  d.forEach(function (r) {
    if (r[6] === '' || r[6] === null || r[2] === '' || r[2] === null) { stale++; return; }  // strict: '' must NOT become 0
    var f = Number(r[6]), tt = Number(r[2]);
    if (isNaN(f) || isNaN(tt)) { stale++; return; }
    var c = String(r[3]);
    if (c !== 'STRONG' && c !== 'BULL' && c !== 'CAUTION' && c !== 'OFF') { stale++; return; }
    rows.push({ sym: String(r[0]), date: String(r[1]), t: tt, cls: c,
      grade: String(r[4]), why: String(r[5]), fwd21: f,
      fwd63: (r[7] === '' || r[7] === null || isNaN(Number(r[7]))) ? null : Number(r[7]) });
  });
  if (stale) {
    Logger.log('bullBackfillReport: ABORT — ' + stale + ' rows did not match the v1.1 schema ' +
      '(leftover v1.0 data). Run resetBullBackfill(), then re-harvest. Reporting on a mixed ' +
      'sheet silently corrupts BENCHMARK.');
    return;
  }
  if (rows.length < 100) { Logger.log('bullBackfillReport: <100 usable episodes'); return; }

  function pc(x) { return x == null ? '—' : (Math.round(x * 1000) / 10) + '%'; }
  function ci(t) { return t ? pc(t.point) + ' [' + pc(t.lo) + ', ' + pc(t.hi) + ']' : '—'; }
  function seed() { return bbRng_(BBCFG.BOOT_SEED); }
  function agg(rs, key) {
    var v = rs.filter(function (r) { return r[key] != null; });
    if (!v.length) return { n: 0, hold: null, mean: null };
    var h = 0, s2 = 0;
    v.forEach(function (r) { h += (r[key] >= 0 ? 1 : 0); s2 += r[key]; });
    return { n: v.length, hold: h / v.length, mean: s2 / v.length };
  }
  function line(label, rs, key) {
    var a = agg(rs, key);
    Logger.log('  ' + label + ': n=' + a.n + '  hold ' + pc(a.hold) + '  meanFwd ' + pc(a.mean));
    return a;
  }
  var out = { at: new Date().toISOString(), episodes: rows.length, horizons: [SELL.H, BBCFG.H2] };

  /* ── the CAUTION decomposition, at the primary horizon ── */
  Logger.log('── BULL WATCH BACKFILL v1.2 · trigger decomposition + distribution shape ──');
  Logger.log('episodes ' + rows.length + ' · horizons ' + SELL.H + 'd / ' + BBCFG.H2 + 'd');
  Logger.log('[H=' + SELL.H + '] classes');
  ['STRONG', 'BULL', 'CAUTION'].forEach(function (c) {
    line(c, rows.filter(function (r) { return r.cls === c; }), 'fwd21');
  });
  line('BENCHMARK (all bars)', rows, 'fwd21');

  Logger.log('[H=' + SELL.H + '] CAUTION split by trigger');
  var caut = rows.filter(function (r) { return r.cls === 'CAUTION'; });
  var buckets = {};
  caut.forEach(function (r) { var b = bbBucketOf_(r.why); (buckets[b] = buckets[b] || []).push(r); });
  ['C_EXTENDED', 'C_PULLBACK', 'C_DIVERGENCE', 'C_OTHER'].forEach(function (b) {
    if (buckets[b] && buckets[b].length) line(b, buckets[b], 'fwd21');
  });

  Logger.log('[H=' + SELL.H + '] exact trigger combinations (top 8)');
  var combos = {};
  caut.forEach(function (r) { var k = r.why || '(none)'; (combos[k] = combos[k] || []).push(r); });
  Object.keys(combos).sort(function (a, b) { return combos[b].length - combos[a].length; })
    .slice(0, 8).forEach(function (k) { line('  ' + k, combos[k], 'fwd21'); });

  Logger.log('[H=' + SELL.H + '] grade ordering');
  ['A', 'B', 'C'].forEach(function (g) {
    var rs = rows.filter(function (r) { return r.grade === g; });
    if (rs.length) line('grade ' + g, rs, 'fwd21');
  });

  var bucketTag = function (r) { return r.cls === 'STRONG' ? 'STRONG' : (r.cls === 'CAUTION' ? bbBucketOf_(r.why) : ''); };

  /* ── distribution shape: is an edge broad, or a handful of outliers? ── */
  Logger.log('[H=' + SELL.H + '] distribution shape (is the mean broad or outlier-driven?)');
  Logger.log('  label            n     mean   median     p25     p75     p10     p90  meanWin meanLoss  top10%share');
  function dline(label, rs) {
    var x = bbDist_(rs, 'fwd21');
    if (!x.n) return null;
    function f(v) { return (v == null ? '     —' : (v >= 0 ? ' ' : '') + (Math.round(v * 1000) / 10) + '%'); }
    Logger.log('  ' + (label + '                ').slice(0, 15) + ' ' + ('     ' + x.n).slice(-6) +
      ' ' + f(x.mean) + ' ' + f(x.median) + ' ' + f(x.p25) + ' ' + f(x.p75) + ' ' + f(x.p10) + ' ' + f(x.p90) +
      ' ' + f(x.meanWin) + ' ' + f(x.meanLoss) +
      '   ' + (x.topDecileShare == null ? '—' : Math.round(x.topDecileShare * 100) / 100));
    return x;
  }
  out.dist = {};
  ['STRONG', 'BULL', 'CAUTION'].forEach(function (c) {
    out.dist[c] = dline(c, rows.filter(function (r) { return r.cls === c; }));
  });
  ['C_EXTENDED', 'C_PULLBACK', 'C_DIVERGENCE'].forEach(function (b) {
    if (buckets[b] && buckets[b].length) out.dist[b] = dline(b, buckets[b]);
  });
  out.dist.BENCHMARK = dline('BENCHMARK', rows);

  /* ── median spreads: the discriminator between breadth and skew ── */
  Logger.log('[H=' + SELL.H + '] MEDIAN spreads (date-clustered) — if the mean gap survives here,');
  Logger.log('      the edge is broad; if it collapses, the mean is carried by a few outliers');
  function medCmp(label, tagFn, A, B) {
    var tagged = bbTag_(rows, tagFn, 'fwd21');
    var m = bbBootstrapMedianCI_(tagged, 'date', A, B, BBCFG.BOOT_MEDIAN, seed());
    Logger.log('  ' + label + '  median ' + ci(m));
    return m;
  }
  out.medianSpreads = {
    strongVsExtended: medCmp('STRONG − C_EXTENDED  ', bucketTag, 'STRONG', 'C_EXTENDED'),
    strongVsPullback: medCmp('STRONG − C_PULLBACK  ', bucketTag, 'STRONG', 'C_PULLBACK'),
    strongVsAll:      medCmp('STRONG − ALL BARS    ', function (r) { return r.cls === 'STRONG' ? 'STRONG' : 'REST'; }, 'STRONG', '*')
  };

  /* ── key spreads, date-clustered, on BOTH metrics ── */
  function cmp(label, tagFn, A, B, key) {
    var tagged = bbTag_(rows, tagFn, key);
    var h = bbBootstrapCI_(tagged, 'date', A, B, BBCFG.BOOT_ITERS, seed(), 'hold');
    var m = bbBootstrapCI_(tagged, 'date', A, B, BBCFG.BOOT_ITERS, seed(), 'mean');
    Logger.log('  ' + label + '  hold ' + ci(h) + '   mean ' + ci(m));
    return { hold: h, mean: m };
  }
  Logger.log('[H=' + SELL.H + '] spreads vs STRONG (date-clustered 95% CI)');
  out.h21 = {
    strongVsExtended: cmp('STRONG − C_EXTENDED  ', bucketTag, 'STRONG', 'C_EXTENDED', 'fwd21'),
    strongVsPullback: cmp('STRONG − C_PULLBACK  ', bucketTag, 'STRONG', 'C_PULLBACK', 'fwd21'),
    strongVsAll:      cmp('STRONG − ALL BARS    ', function (r) { return r.cls === 'STRONG' ? 'STRONG' : 'REST'; }, 'STRONG', '*', 'fwd21'),
    gradeAvsC:        cmp('grade A − grade C    ', function (r) { return r.grade === 'A' ? 'A' : (r.grade === 'C' ? 'C' : ''); }, 'A', 'C', 'fwd21')
  };

  /* ── horizon sensitivity: subsample to stride H2 so episodes stay independent ── */
  var sub = bbSubsample_(rows, BBCFG.START_IDX, BBCFG.H2).filter(function (r) { return r.fwd63 != null; });
  if (sub.length >= 200) {
    Logger.log('[H=' + BBCFG.H2 + '] classes (stride-' + BBCFG.H2 + ' subsample, n=' + sub.length + ')');
    ['STRONG', 'BULL', 'CAUTION'].forEach(function (c) {
      line(c, sub.filter(function (r) { return r.cls === c; }), 'fwd63');
    });
    line('BENCHMARK (all bars)', sub, 'fwd63');
    var subC = sub.filter(function (r) { return r.cls === 'CAUTION'; }), sb = {};
    subC.forEach(function (r) { var b = bbBucketOf_(r.why); (sb[b] = sb[b] || []).push(r); });
    ['C_EXTENDED', 'C_PULLBACK'].forEach(function (b) { if (sb[b] && sb[b].length) line(b, sb[b], 'fwd63'); });
    function cmp63(label, tagFn, A, B) {
      var tagged = bbTag_(sub, tagFn, 'fwd63');
      var h = bbBootstrapCI_(tagged, 'date', A, B, BBCFG.BOOT_ITERS, seed(), 'hold');
      var m = bbBootstrapCI_(tagged, 'date', A, B, BBCFG.BOOT_ITERS, seed(), 'mean');
      Logger.log('  ' + label + '  hold ' + ci(h) + '   mean ' + ci(m));
      return { hold: h, mean: m };
    }
    Logger.log('[H=' + BBCFG.H2 + '] spreads vs STRONG');
    out.h63 = {
      strongVsExtended: cmp63('STRONG − C_EXTENDED  ', bucketTag, 'STRONG', 'C_EXTENDED'),
      strongVsPullback: cmp63('STRONG − C_PULLBACK  ', bucketTag, 'STRONG', 'C_PULLBACK'),
      strongVsAll:      cmp63('STRONG − ALL BARS    ', function (r) { return r.cls === 'STRONG' ? 'STRONG' : 'REST'; }, 'STRONG', '*')
    };
  } else {
    Logger.log('[H=' + BBCFG.H2 + '] skipped — subsample too small (' + sub.length + ')');
  }

  /* ── verdicts ── */
  var tagged21 = bbTag_(rows, function (r) { return (r.cls === 'STRONG' || r.cls === 'CAUTION') ? r.cls : ''; }, 'fwd21');
  var vS = bbBootstrapCI_(tagged21, 'sym', 'STRONG', 'CAUTION', BBCFG.BOOT_ITERS, seed(), 'hold');
  var vD = bbBootstrapCI_(tagged21, 'date', 'STRONG', 'CAUTION', BBCFG.BOOT_ITERS, seed(), 'hold');
  out.verdictPooled = bbVerdict_(vS, vD);
  Logger.log('POOLED STRONG−CAUTION (v1.0 comparison): ' + ci(vD));
  Logger.log('VERDICT (pooled): ' + (out.verdictPooled.pass ? 'PASS — ' : 'FAIL — ') + out.verdictPooled.text);
  Logger.log('READ: if STRONG − C_PULLBACK is clearly positive while STRONG − C_EXTENDED is');
  Logger.log('      negative, CAUTION is pooling a momentum signal with a breakdown signal and');
  Logger.log('      the label — not the underlying features — is what failed.');
  Logger.log('READ 2: compare the MEAN and MEDIAN spreads for STRONG − C_EXTENDED. A mean gap');
  Logger.log('      with no median gap means C_EXTENDED is a lottery profile — a few very large');
  Logger.log('      winners, not a broadly better bucket — which implies small positions, not a');
  Logger.log('      promotion. topDecileShare near or above 1 says the same thing.');
  Logger.log('CAVEAT: survivorship + mostly-rising sample inflate ABSOLUTE rates; read spreads.');
  Logger.log('CAVEAT 2: C_EXTENDED is the bucket most exposed to survivorship — "ran 30% over the');
  Logger.log('      200 DMA, then collapsed, then delisted" is exactly the censored path.');

  var rs2 = sheet_(BBCFG.RESULT_SHEET, ['at', 'result']);
  rs2.appendRow([out.at, JSON.stringify(out)]);
  return out;
}
