/**
 * ═══════════════════════════════════════════════════════════════════
 * TIERLAB.gs — cross-sectional tier research (v1.0, 25-Jul-2026)
 * ADDITIVE. New file in the INDICATORS project. Touches nothing existing.
 *
 * ─────────────────────────── PRE-REGISTRATION ───────────────────────────
 * Written 25-Jul-2026, BEFORE any result from this file existed.
 *
 * PRIMARY HYPOTHESIS (Krishna, stated in advance):
 *   Proximity to the 52-week high predicts forward return. A stock cannot
 *   make a sustained run until it clears its prior high, so names trading
 *   AT or NEAR the 52-week high should rank in the TOP tier, and names far
 *   below it in the BOTTOM tier. Factor: pct52w = close / max(close, 252d),
 *   which is (0,1]; 1.0 means a new 52-week high today.
 *   Direction: HIGHER pct52w → HIGHER forward return.
 *   (Consistent with George & Hwang, "The 52-Week High and Momentum
 *   Investing", J.Finance 2004 — a motivated prior, not a mined one.)
 *
 * SUCCESS CRITERION — fixed now, not after seeing results:
 *   In the SEALED HOLDOUT period, the top decile's MEDIAN forward 1-month
 *   return must exceed the universe median, with a date-clustered 95% CI
 *   clear of zero. Median, because the Bull Watch backfill already showed
 *   means being carried by right tails. Additionally the decile gradient
 *   must be broadly monotone (Spearman rho ≥ 0.60 across deciles 1→10) —
 *   a clean gradient is hard to produce by chance; a top-vs-bottom gap is
 *   not.
 *
 * DISCIPLINE ENFORCED BY THIS FILE:
 *   · tierExplore()  reads ONLY the training period. Search freely here.
 *   · tierConfirm(f) reads the holdout, for ONE named factor. Every call is
 *     recorded in Script Properties; a second call warns that the holdout
 *     is now contaminated and any further p-value is not what it appears.
 *   · The split is by DATE, never random — a random split leaks, because
 *     the same market regime would appear on both sides.
 * ────────────────────────────────────────────────────────────────────────
 *
 * WHY CROSS-SECTIONAL, NOT ABSOLUTE
 *   Bull Watch asks an absolute per-stock question ("is this stock
 *   trending?") and tested flat: STRONG − ALL BARS was null on hold, mean
 *   AND median. Absolute rules drift with the market — in a rising tape
 *   most names qualify and the tier converges to the index. A cross-
 *   sectional rank is selective by construction: exactly 10% of names sit
 *   in the top decile on every date, in every regime.
 *
 * WHY MONTH-END ALIGNMENT
 *   Ranking stocks against each other requires them measured on the SAME
 *   date. BullBackfill strides 21 bars from each stock's own start, so its
 *   dates do not align and it cannot support a cross-section. This file
 *   harvests on the last trading day of each month instead.
 *
 * FACTORS HARVESTED (all backward-looking at the ranking date)
 *   pct52w    close / max(close, 252d)          — the primary hypothesis
 *   mom12_1   close[t-21]/close[t-252] − 1      — classic momentum, last month skipped
 *   ext200    close / sma200 − 1                — the BullBackfill survivor
 *   volMom    mom12_1 / realised vol (126d)     — risk-scaled momentum
 *   upFrac    fraction of up days (126d)        — trend persistence
 *
 * OPS (Run dropdown)
 *   runTierHarvest()      — resumable; re-run until the log says DONE
 *   tierExplore()         — TRAIN period only; all factors, decile tables
 *   tierConfirm('pct52w') — HOLDOUT; one factor; one shot
 *   tierSplitInfo()       — show the train/holdout boundary and usage log
 *   resetTierLab()        — clear everything (also clears the holdout log)
 * ═══════════════════════════════════════════════════════════════════
 */

var TLCFG = {
  RANGE:      '10y',
  BUDGET_MS:  200000,     // hard GAS ceiling is 360s; leave room for the final write
  SHEET:      'TierLab',
  RESULT:     'TierLabResults',
  MIN_BARS:   300,
  WARMUP:     260,        // need 252 for the 52w window + slack
  DECILES:    10,
  MIN_PER_DATE: 50,       // a cross-section thinner than this is not rankable
  TRAIN_FRAC: 0.70,       // earliest 70% of dates = train, newest 30% = sealed
  BOOT_EXPLORE: 250,      // indicative intervals while searching
  BOOT_ITERS: 1000,       // the confirmatory run
  BOOT_SEED:  20260725,
  RHO_MIN:    0.60,       // pre-registered monotonicity floor
  PLANNED_TESTS: 2        // declared 25-Jul-2026 BEFORE either ran: volMom (train-selected
                          // champion) and pct52w (the standing hypothesis). Each interval is
                          // widened to 1 - 0.05/2 = 97.5% so two looks cannot buy significance.
};

/* ══════════════ PURE: factor construction ══════════════ */

/* max close over the trailing `win` bars ending at idx (inclusive) */
function tlRollMax_(close, idx, win) {
  var from = idx - win + 1;
  if (from < 0) return null;
  var m = -Infinity;
  for (var i = from; i <= idx; i++) if (close[i] > m) m = close[i];
  return m === -Infinity ? null : m;
}

/* THE PRIMARY FACTOR: proximity to the 52-week high, in (0,1].
   1.0 = making a new 52-week high today; 0.6 = trading 40% below it. */
function tlPct52w_(close, idx) {
  var mx = tlRollMax_(close, idx, 252);
  if (mx == null || mx <= 0) return null;
  return close[idx] / mx;
}

/* 12-month return skipping the most recent month (short-term reversal) */
function tlMom12_1_(close, idx) {
  if (idx < 252) return null;
  var a = close[idx - 21], b = close[idx - 252];
  if (a == null || b == null || b <= 0) return null;
  return a / b - 1;
}

function tlExt200_(close, idx) {
  if (idx < 200) return null;
  var s = 0;
  for (var i = idx - 199; i <= idx; i++) s += close[i];
  var sma = s / 200;
  return sma > 0 ? close[idx] / sma - 1 : null;
}

/* realised volatility of daily log returns over `win` bars */
function tlVol_(close, idx, win) {
  win = win || 126;
  if (idx < win) return null;
  var r = [], m = 0;
  for (var i = idx - win + 1; i <= idx; i++) {
    if (close[i - 1] <= 0 || close[i] <= 0) return null;
    var x = Math.log(close[i] / close[i - 1]); r.push(x); m += x;
  }
  m /= r.length;
  var v = 0;
  for (var j = 0; j < r.length; j++) { var d = r[j] - m; v += d * d; }
  return Math.sqrt(v / r.length);
}

function tlUpFrac_(close, idx, win) {
  win = win || 126;
  if (idx < win) return null;
  var up = 0;
  for (var i = idx - win + 1; i <= idx; i++) if (close[i] > close[i - 1]) up++;
  return up / win;
}

/* last trading-day bar index of each calendar month (IST-naive, UTC dates) */
function tlMonthEnds_(ts) {
  var out = [], prevKey = null, lastIdx = -1;
  for (var i = 0; i < ts.length; i++) {
    if (ts[i] == null) continue;
    var d = new Date(ts[i] * 1000);
    var key = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
    if (prevKey !== null && key !== prevKey) out.push(lastIdx);
    prevKey = key; lastIdx = i;
  }
  return out;   // deliberately excludes the in-progress final month
}
function tlMonthKey_(unixSec) {
  var d = new Date(unixSec * 1000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}

/* Normalise a month key read back from the sheet.
   BUG FOUND 25-Jul-2026: Sheets silently coerces the string '2016-04' into a
   Date. String(cell) then yields 'Fri Apr 01 2016 00:00:00 GMT+0530', and
   sorting THOSE alphabetically sorts by WEEKDAY NAME — so the chronological
   train/holdout split silently became a split by day-of-week, spanning the
   whole sample on both sides. Always normalise before sorting or splitting. */
function tlNormYm_(v) {
  if (v == null) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return v.getFullYear() + "-" + ("0" + (v.getMonth() + 1)).slice(-2);   // Sheets stored it in script TZ
  }
  var s = String(v).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  /* Read the month NAME straight out of a coerced date string. Parsing with
     new Date() and reading getMonth() is timezone-dependent: "Apr 01 2016
     00:00 GMT+0530" is 31-Mar in UTC, so the month would silently shift. */
  var m = s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m) {
    var names = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    var mi = names.indexOf(m[1].toLowerCase());
    if (mi >= 0) return m[3] + "-" + ("0" + (mi + 1)).slice(-2);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2);
  return s;
}

/* ══════════════ PURE: cross-sectional ranking ══════════════ */

/* Assign 1..D deciles within one date's cross-section, by ascending factor.
   Decile D holds the HIGHEST factor values. Ties broken by position, so the
   buckets stay equal-sized. */
function tlAssignDeciles_(values, D) {
  D = D || TLCFG.DECILES;
  var idx = values.map(function (v, i) { return { v: v, i: i }; })
    .filter(function (x) { return x.v != null && !isNaN(x.v); });
  idx.sort(function (a, b) { return a.v - b.v; });
  var n = idx.length, out = new Array(values.length).fill(null);
  if (n < D) return out;
  for (var r = 0; r < n; r++) out[idx[r].i] = Math.min(D, Math.floor(r * D / n) + 1);
  return out;
}

function tlMedian_(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length, m = (n - 1) / 2;
  return n % 2 ? s[m] : (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}
function tlMean_(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }

/* Spearman rank correlation — measures whether the decile gradient is
   monotone rather than merely having a top-vs-bottom gap. */
function tlSpearman_(x, y) {
  var n = x.length;
  if (n < 3 || y.length !== n) return null;
  function ranks(a) {
    var s = a.map(function (v, i) { return { v: v, i: i }; }).sort(function (p, q) { return p.v - q.v; });
    var r = new Array(a.length);
    for (var k = 0; k < s.length;) {
      var j = k; while (j + 1 < s.length && s[j + 1].v === s[k].v) j++;
      var avg = (k + j) / 2 + 1;
      for (var t = k; t <= j; t++) r[s[t].i] = avg;
      k = j + 1;
    }
    return r;
  }
  var rx = ranks(x), ry = ranks(y);
  var mx = tlMean_(rx), my = tlMean_(ry), num = 0, dx = 0, dy = 0;
  for (var i = 0; i < n; i++) { var a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx === 0 || dy === 0) ? null : num / Math.sqrt(dx * dy);
}

/* decile table for one factor over a set of rows already carrying `dec` */
function tlDecileTable_(rows, horizonKey, D) {
  D = D || TLCFG.DECILES;
  var buckets = [];
  for (var d = 0; d < D; d++) buckets.push([]);
  var all = [];
  rows.forEach(function (r) {
    var f = r[horizonKey];
    if (f == null || r.dec == null) return;
    buckets[r.dec - 1].push(f); all.push(f);
  });
  var tbl = buckets.map(function (b, i) {
    return { decile: i + 1, n: b.length, median: tlMedian_(b), mean: tlMean_(b),
      hold: b.length ? b.filter(function (v) { return v >= 0; }).length / b.length : null };
  });
  var meds = tbl.map(function (t) { return t.median == null ? 0 : t.median; });
  var rho = tlSpearman_(tbl.map(function (t) { return t.decile; }), meds);
  return { table: tbl, universeMedian: tlMedian_(all), universeMean: tlMean_(all),
    n: all.length, rho: rho == null ? null : Math.round(rho * 1000) / 1000 };
}

/* Quickselect median. The bootstrap needs a median of ~90k pooled values on
   every iteration; sorting that 1000 times is ~1.5e9 comparisons and blew the
   6-minute ceiling. Selection is O(n) and operates in place on a reused
   buffer, so no per-iteration allocation either. */
function tlSelect_(a, n, k) {
  var lo = 0, hi = n - 1;
  while (lo < hi) {
    var p = a[(lo + hi) >> 1], i = lo, j = hi;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[lo];
}
function tlSelectMedian_(a, n) {
  if (!n) return null;
  var k = n >> 1, hi = tlSelect_(a, n, k);
  if (n % 2) return hi;
  var lo = -Infinity;                       // after selection a[0..k-1] are all <= a[k]
  for (var i = 0; i < k; i++) if (a[i] > lo) lo = a[i];
  return (lo + hi) / 2;
}

/* date-clustered bootstrap of (top-decile median − universe median) */
function tlRng_(seed) { var s = (seed || 1) % 4294967296; return function () { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296; }; }

function tlTopVsUniverseCI_(rows, horizonKey, D, iters, rng, tests) {
  D = D || TLCFG.DECILES; iters = iters || TLCFG.BOOT_ITERS; rng = rng || tlRng_(TLCFG.BOOT_SEED);
  tests = tests || 1;                                  // Bonferroni: widen the interval per planned test
  var alpha = 0.05 / tests, qLo = alpha / 2, qHi = 1 - alpha / 2;
  var byDate = {}, keys = [];
  rows.forEach(function (r) {
    if (r[horizonKey] == null || r.dec == null) return;
    if (!byDate[r.date]) { byDate[r.date] = { top: [], all: [] }; keys.push(r.date); }
    byDate[r.date].all.push(r[horizonKey]);
    if (r.dec === D) byDate[r.date].top.push(r[horizonKey]);
  });
  var K = keys.length;
  if (K < 4) return null;
  var groups = keys.map(function (k) { return byDate[k]; });
  var capT = 0, capA = 0;
  groups.forEach(function (g) { if (g.top.length > capT) capT = g.top.length; if (g.all.length > capA) capA = g.all.length; });
  var bufT = new Array(capT * K), bufA = new Array(capA * K);   // reused across iterations

  function spread(pick) {
    var nt = 0, na = 0;
    for (var j = 0; j < K; j++) {
      var g = groups[pick[j]], gt = g.top, ga = g.all;
      for (var x = 0; x < gt.length; x++) bufT[nt++] = gt[x];
      for (var y = 0; y < ga.length; y++) bufA[na++] = ga[y];
    }
    if (!nt || !na) return null;
    var mt = tlSelectMedian_(bufT, nt), ma = tlSelectMedian_(bufA, na);
    return (mt == null || ma == null) ? null : mt - ma;
  }
  var ident = []; for (var q = 0; q < K; q++) ident.push(q);
  var p = spread(ident), draws = [], pick = new Array(K);
  for (var it = 0; it < iters; it++) {
    for (var j2 = 0; j2 < K; j2++) pick[j2] = Math.floor(rng() * K);
    var v = spread(pick);
    if (v != null) draws.push(v);
  }
  if (draws.length < 50) return null;
  draws.sort(function (a, b) { return a - b; });
  function pct(qq) { return draws[Math.min(draws.length - 1, Math.max(0, Math.floor(qq * draws.length)))]; }
  return { point: Math.round(p * 100000) / 100000, lo: Math.round(pct(qLo) * 100000) / 100000,
    hi: Math.round(pct(qHi) * 100000) / 100000, dates: K, iters: draws.length,
    conf: Math.round((1 - alpha) * 1000) / 10, tests: tests };
}

/* pre-registered pass/fail */
function tlJudge_(ci, rho) {
  if (!ci) return { pass: false, why: 'no interval — too few dates' };
  if (rho == null) return { pass: false, why: 'no monotonicity estimate' };
  if (ci.lo <= 0) return { pass: false, why: 'top-decile median edge CI includes zero (' +
    (Math.round(ci.lo * 10000) / 100) + '% to ' + (Math.round(ci.hi * 10000) / 100) + '%)' };
  if (rho < TLCFG.RHO_MIN) return { pass: false, why: 'decile gradient not monotone enough (rho ' +
    rho + ' < ' + TLCFG.RHO_MIN + ') — a top-vs-bottom gap without a gradient is weak evidence' };
  return { pass: true, why: 'top-decile median edge CI clear of zero AND gradient monotone (rho ' + rho + ')' };
}

/* ══════════════ GAS: harvest (month-end aligned, resumable) ══════════════ */
function runTierHarvest() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('tl_idx') || '0', 10);
  var sh = sheet_(TLCFG.SHEET, ['sym', 'ym', 'pct52w', 'mom12_1', 'ext200', 'volMom', 'upFrac', 'fwd1m', 'fwd3m']);
  if (sh.getLastRow() >= 1) {
    var h = sh.getRange(1, 1, 1, 9).getValues()[0];
    if (String(h[2]) !== 'pct52w') { Logger.log('runTierHarvest: ABORT — sheet schema mismatch; run resetTierLab() first'); return; }
  }
  var batch = [], done = start, logged = 0, skipped = 0;
  var failFetch = 0, failShort = 0, failOther = 0, consecFail = 0;
  Logger.log('tierHarvest: resuming at ' + start + '/' + uni.length + ' · sheet has ' + Math.max(sh.getLastRow() - 1, 0) + ' rows');
  for (var s = start; s < uni.length; s++) {
    if (Date.now() - t0 > TLCFG.BUDGET_MS) break;
    done = s + 1;
    try {
      var u = uni[s], bars = getBarsDeep_(u.sym, TLCFG.RANGE);
      if (!bars || !bars.close) { skipped++; failFetch++; consecFail++; }
      else if (bars.close.length < TLCFG.MIN_BARS) { skipped++; failShort++; consecFail = 0; }
      if (!bars || !bars.close || bars.close.length < TLCFG.MIN_BARS) {
        /* THROTTLE GUARD: a healthy roster never fails to fetch many times in a
           row. Yahoo rate-limits the Apps Script egress IP after heavy deep-history
           use, and every request then costs ~10s and returns nothing. Abort early
           rather than burning the whole budget producing zero rows. */
        if (consecFail >= 15) {
          props.setProperty('tl_idx', String(s));
          Logger.log('tierHarvest: ABORTING — ' + consecFail + ' consecutive fetch failures. ' +
            'Yahoo is almost certainly throttling this IP after heavy use. Nothing is lost: ' +
            'progress is saved at ' + s + '/' + uni.length + '. Run tierProbeYahoo() to confirm, ' +
            'then wait 30-60 min and run runTierHarvest() again.');
          return;
        }
        continue;
      }
      consecFail = 0;
      var cl = bars.close, ts = bars.ts, n = cl.length;
      var me = tlMonthEnds_(ts);
      var pos = {};
      for (var m = 0; m < me.length; m++) pos[me[m]] = m;
      for (var k = 0; k < me.length; k++) {
        var t = me[k];
        if (t < TLCFG.WARMUP) continue;
        var n1 = me[k + 1], n3 = me[k + 3];
        if (n1 == null) continue;
        var f1 = cl[n1] / cl[t] - 1;
        var f3 = (n3 == null) ? '' : cl[n3] / cl[t] - 1;
        var p52 = tlPct52w_(cl, t), mom = tlMom12_1_(cl, t), ex = tlExt200_(cl, t);
        var vol = tlVol_(cl, t, 126), up = tlUpFrac_(cl, t, 126);
        if (p52 == null || mom == null || ex == null || vol == null || up == null || vol <= 0) continue;
        batch.push([u.sym, tlMonthKey_(ts[t]),
          Math.round(p52 * 100000) / 100000, Math.round(mom * 100000) / 100000,
          Math.round(ex * 100000) / 100000, Math.round(mom / vol * 10000) / 10000,
          Math.round(up * 10000) / 10000,
          Math.round(f1 * 100000) / 100000, f3 === '' ? '' : Math.round(f3 * 100000) / 100000]);
        logged++;
      }
      if (batch.length >= 2000) {
        sh.getRange(sh.getLastRow() + 1, 1, batch.length, 9).setValues(batch);
        batch = [];
        props.setProperty('tl_idx', String(s + 1));   // checkpoint: a hard kill now costs one batch, not the run
      }
    } catch (e) {
      if (tlQuotaExceeded_(e)) {                     // daily UrlFetch quota — stop immediately
        props.setProperty('tl_idx', String(s));
        Logger.log('tierHarvest: STOPPED at ' + s + '/' + uni.length +
          ' — Apps Script daily UrlFetch quota exhausted (shared across ALL your scripts, ' +
          'both projects). Progress saved. Quota resets at midnight Pacific (~12:30 PM IST); ' +
          'run runTierHarvest() again after that.');
        if (batch.length) sh.getRange(sh.getLastRow() + 1, 1, batch.length, 9).setValues(batch);
        return;
      }
      skipped++; failOther++;
    }
  }
  if (batch.length) sh.getRange(sh.getLastRow() + 1, 1, batch.length, 9).setValues(batch);
  var fin = done >= uni.length;
  props.setProperty('tl_idx', fin ? '0' : String(done));
  Logger.log('tierHarvest: ' + start + '→' + done + '/' + uni.length + ', ' + logged + ' rows, ' +
    skipped + ' skipped (fetch-failed ' + failFetch + ', too-short ' + failShort + ', errored ' + failOther + '), ' +
    Math.round((Date.now() - t0) / 1000) + 's. ' +
    (fin ? 'DONE — now run tierExplore().' : 'Not finished — run runTierHarvest() again.'));
}

function resetTierLab() {
  var ss = SpreadsheetApp.getActive();
  [TLCFG.SHEET, TLCFG.RESULT].forEach(function (n) {
    var sh = ss.getSheetByName(n); if (sh) { try { ss.deleteSheet(sh); } catch (e) { sh.clear(); } }
  });
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('tl_idx'); p.deleteProperty('TL_CONFIRMED');
  Logger.log('TierLab cleared — including the holdout usage log');
}

/* ══════════════ GAS: load + split ══════════════ */
function tlLoad_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(TLCFG.SHEET);
  if (!sh || sh.getLastRow() < 100) return null;
  var d = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues(), rows = [], dates = {};
  var seen = {}, dupes = 0;
  d.forEach(function (r) {
    if (r[7] === '' || r[7] === null) return;
    var ym = tlNormYm_(r[1]);                      // Sheets may have coerced this to a Date
    var key = String(r[0]) + '|' + ym;
    if (seen[key]) { dupes++; return; }            // a re-run after tl_idx reset appends duplicates
    seen[key] = 1;
    var o = { sym: String(r[0]), date: ym,
      pct52w: Number(r[2]), mom12_1: Number(r[3]), ext200: Number(r[4]),
      volMom: Number(r[5]), upFrac: Number(r[6]),
      fwd1m: Number(r[7]), fwd3m: (r[8] === '' ? null : Number(r[8])) };
    if (isNaN(o.fwd1m)) return;
    rows.push(o); dates[o.date] = 1;
  });
  var keys = Object.keys(dates).sort();           // safe now: keys are 'YYYY-MM' strings
  if (dupes) Logger.log('tlLoad_: dropped ' + dupes + ' duplicate sym+month rows ' +
    '(a harvest was re-run after finishing). Consider resetTierLab() + a clean harvest.');
  var cut = Math.floor(keys.length * TLCFG.TRAIN_FRAC);
  var trainSet = {}, boundary = keys[cut] || keys[keys.length - 1];
  for (var i = 0; i < cut; i++) trainSet[keys[i]] = 1;
  return { rows: rows, dates: keys, boundary: boundary,
    train: rows.filter(function (r) { return trainSet[r.date]; }),
    holdout: rows.filter(function (r) { return !trainSet[r.date]; }) };
}

/* rank one slice cross-sectionally, per date, by `factor` */
function tlRank_(rows, factor) {
  var byDate = {};
  rows.forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
  var out = [];
  Object.keys(byDate).forEach(function (d) {
    var g = byDate[d];
    if (g.length < TLCFG.MIN_PER_DATE) return;            // thin cross-section is not rankable
    var dec = tlAssignDeciles_(g.map(function (r) { return r[factor]; }), TLCFG.DECILES);
    for (var i = 0; i < g.length; i++) {
      if (dec[i] == null) continue;
      out.push({ sym: g[i].sym, date: d, dec: dec[i], fwd1m: g[i].fwd1m, fwd3m: g[i].fwd3m });
    }
  });
  return out;
}

function tierSplitInfo() {
  var L = tlLoad_();
  if (!L) { Logger.log('no TierLab data — run runTierHarvest()'); return; }
  var used = PropertiesService.getScriptProperties().getProperty('TL_CONFIRMED') || '[]';
  Logger.log('dates ' + L.dates.length + ' chronological: ' + L.dates[0] + ' … ' + L.dates[L.dates.length - 1]);
  if (L.dates[0] > L.dates[L.dates.length - 1]) Logger.log('⚠ dates are NOT in order — month keys failed to normalise');
  Logger.log('TRAIN   ' + L.train.length + ' rows, up to ' + L.boundary);
  Logger.log('HOLDOUT ' + L.holdout.length + ' rows, from ' + L.boundary + ' (SEALED)');
  Logger.log('holdout already used for: ' + used);
}

/* ══════════════ GAS: EXPLORE — training period only ══════════════ */
function tierExplore() {
  var L = tlLoad_();
  if (!L) { Logger.log('tierExplore: no data — run runTierHarvest()'); return; }
  function pc(x) { return x == null ? '—' : (Math.round(x * 10000) / 100) + '%'; }
  Logger.log('── TIERLAB · EXPLORE (TRAINING PERIOD ONLY) ──');
  Logger.log('train rows ' + L.train.length + ' · dates up to ' + L.boundary + ' · holdout SEALED');
  Logger.log('primary hypothesis: HIGHER pct52w → HIGHER forward return (pre-registered)');
  var factors = ['pct52w', 'mom12_1', 'ext200', 'volMom', 'upFrac'], summary = {};
  factors.forEach(function (f) {
    var ranked = tlRank_(L.train, f);
    var res = tlDecileTable_(ranked, 'fwd1m', TLCFG.DECILES);
    Logger.log('');
    Logger.log('FACTOR ' + f + '  (n=' + res.n + ', universe median ' + pc(res.universeMedian) + ', rho ' + res.rho + ')');
    Logger.log('  dec    n    median     mean    hold');
    res.table.forEach(function (t) {
      Logger.log('   ' + ('  ' + t.decile).slice(-2) + ' ' + ('     ' + t.n).slice(-6) + '  ' +
        ('       ' + pc(t.median)).slice(-8) + ' ' + ('       ' + pc(t.mean)).slice(-8) + '  ' + pc(t.hold));
    });
    var ci = tlTopVsUniverseCI_(ranked, 'fwd1m', TLCFG.DECILES, TLCFG.BOOT_EXPLORE, tlRng_(TLCFG.BOOT_SEED));
    var top = res.table[TLCFG.DECILES - 1], bot = res.table[0];
    Logger.log('  top−universe median ' + (ci ? pc(ci.point) + ' [' + pc(ci.lo) + ', ' + pc(ci.hi) + ']' : '—') +
      ' · top−bottom median ' + pc((top.median || 0) - (bot.median || 0)));
    summary[f] = { rho: res.rho, ci: ci, topMedian: top.median, botMedian: bot.median };
  });
  Logger.log('');
  Logger.log('NOTE: these are TRAINING numbers. Choose ONE factor, then run');
  Logger.log("      tierConfirm('<factor>') exactly once. Every factor you confirm");
  Logger.log('      spends holdout credibility — that is the point of the split.');
  sheet_(TLCFG.RESULT, ['at', 'phase', 'result']).appendRow([new Date().toISOString(), 'explore', JSON.stringify(summary)]);
  return summary;
}

/* ══════════════ GAS: CONFIRM — sealed holdout, one factor, one shot ══════════════ */
function tierConfirm(factor) {
  factor = factor || 'pct52w';
  var L = tlLoad_();
  if (!L) { Logger.log('tierConfirm: no data — run runTierHarvest()'); return; }
  var props = PropertiesService.getScriptProperties();
  var used = [];
  try { used = JSON.parse(props.getProperty('TL_CONFIRMED') || '[]'); } catch (e) { }
  function pc(x) { return x == null ? '—' : (Math.round(x * 10000) / 100) + '%'; }

  Logger.log('── TIERLAB · CONFIRM (SEALED HOLDOUT) ──');
  if (used.length) {
    Logger.log('⚠ HOLDOUT ALREADY USED for: ' + used.join(', '));
    Logger.log('  This is test #' + (used.length + 1) + ' of ' + TLCFG.PLANNED_TESTS + ' planned.');
    if (used.length + 1 <= TLCFG.PLANNED_TESTS) {
      Logger.log('  Within the declared plan — intervals are already Bonferroni-widened for it.');
    } else {
      Logger.log('  BEYOND the declared plan. The correction no longer covers this many looks;');
      Logger.log('  treat the result as exploratory, not confirmatory.');
    }
  }
  var ranked = tlRank_(L.holdout, factor);
  var res = tlDecileTable_(ranked, 'fwd1m', TLCFG.DECILES);
  var ci = tlTopVsUniverseCI_(ranked, 'fwd1m', TLCFG.DECILES, TLCFG.BOOT_ITERS,
    tlRng_(TLCFG.BOOT_SEED), TLCFG.PLANNED_TESTS);
  var judge = tlJudge_(ci, res.rho);

  Logger.log('factor ' + factor + ' · holdout rows ' + res.n + ' · from ' + L.boundary);
  Logger.log('  dec    n    median     mean    hold');
  res.table.forEach(function (t) {
    Logger.log('   ' + ('  ' + t.decile).slice(-2) + ' ' + ('     ' + t.n).slice(-6) + '  ' +
      ('       ' + pc(t.median)).slice(-8) + ' ' + ('       ' + pc(t.mean)).slice(-8) + '  ' + pc(t.hold));
  });
  Logger.log('universe median ' + pc(res.universeMedian) + ' · monotonicity rho ' + res.rho);
  Logger.log('top−universe median ' + (ci ? pc(ci.point) + ' [' + pc(ci.lo) + ', ' + pc(ci.hi) + ']' +
    '  (' + ci.conf + '% interval, Bonferroni for ' + ci.tests + ' planned tests)' : '—'));
  Logger.log('PRE-REGISTERED CRITERION: ' + (judge.pass ? 'PASS' : 'FAIL') + ' — ' + judge.why);

  /* 3-month horizon, reported but NOT part of the criterion */
  var r3 = tlDecileTable_(ranked, 'fwd3m', TLCFG.DECILES);
  if (r3.n > 200) Logger.log('secondary (3m, not part of the criterion): top ' +
    pc(r3.table[TLCFG.DECILES - 1].median) + ' vs universe ' + pc(r3.universeMedian) + ', rho ' + r3.rho);

  used.push(factor);
  props.setProperty('TL_CONFIRMED', JSON.stringify(used));
  sheet_(TLCFG.RESULT, ['at', 'phase', 'result']).appendRow([new Date().toISOString(), 'confirm:' + factor,
    JSON.stringify({ factor: factor, n: res.n, rho: res.rho, ci: ci, judge: judge, table: res.table })]);
  return { factor: factor, rho: res.rho, ci: ci, judge: judge };
}

/* ── Run-dropdown wrappers ──────────────────────────────────────────
   GAS only reliably lists ZERO-ARGUMENT functions in the Run dropdown, so
   tierConfirm(factor) cannot be launched from there directly. Run these in
   the declared order: volMom is test 1 of 2, pct52w is test 2 of 2. */
function tierConfirm_1_volMom() { return tierConfirm('volMom'); }
function tierConfirm_2_pct52w() { return tierConfirm('pct52w'); }

/* exploratory only — beyond the declared 2-test plan; the Bonferroni
   correction does not cover these, and tierConfirm will say so */
function tierConfirm_x_mom12_1() { return tierConfirm('mom12_1'); }
function tierConfirm_x_ext200()  { return tierConfirm('ext200');  }
function tierConfirm_x_upFrac()  { return tierConfirm('upFrac');  }

/* Diagnostic: where is the harvest, and is it actually advancing?
   Run this between harvest runs — if tl_idx does not move, the run is being
   killed before it can checkpoint and the budget needs lowering further. */
function tierHarvestStatus() {
  var p = PropertiesService.getScriptProperties();
  var sh = SpreadsheetApp.getActive().getSheetByName(TLCFG.SHEET);
  var rows = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
  var idx = p.getProperty('tl_idx') || '0';
  Logger.log('tl_idx = ' + idx + ' of ' + uniList_().length + ' stocks · sheet rows = ' + rows);
  Logger.log(idx === '0' && rows > 0 ? 'looks COMPLETE (index reset to 0 after finishing)'
    : idx === '0' ? 'not started' : 'in progress — run runTierHarvest() again');
}

/* Detect the Apps Script daily UrlFetch quota error. Shared helper: same
   project scope, so BullBackfill.gs and any other harvester can call it.
   Consumer accounts get ~20,000 UrlFetch calls per DAY across ALL scripts for
   the user — the Steam project's calls count against the same pool. The error
   takes ~9.5s to surface, so grinding on regardless wastes the whole budget
   for nothing. Quota resets at midnight Pacific (~12:30 PM IST). */
function tlQuotaExceeded_(err) {
  var m = String((err && err.message) || err || '').toLowerCase();
  return m.indexOf('too many times for one day') >= 0 || m.indexOf('urlfetch') >= 0 && m.indexOf('quota') >= 0;
}

/* Is Yahoo actually throttling us? Three raw requests, timed, with the HTTP
   status and the first bytes of the body. A healthy response is 200 in a few
   hundred ms. Throttling shows up as 429/999, an HTML body, or multi-second
   waits ending in failure. */
function tierProbeYahoo() {
  ['RELIANCE', 'TCS', 'HDFCBANK'].forEach(function (sym) {
    var t0 = Date.now();
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym +
      '.NS?range=10y&interval=1d&events=split';
    try {
      var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
      var code = r.getResponseCode(), body = r.getContentText();
      var bars = 0;
      try {
        var j = JSON.parse(body);
        var res = j && j.chart && j.chart.result && j.chart.result[0];
        bars = (res && res.timestamp) ? res.timestamp.length : 0;
      } catch (e) { bars = -1; }
      Logger.log(sym + ': HTTP ' + code + ' · ' + (Date.now() - t0) + 'ms · bars ' +
        (bars < 0 ? 'UNPARSEABLE' : bars) + ' · body starts: ' + body.slice(0, 120).replace(/\s+/g, ' '));
    } catch (err) {
      Logger.log(sym + ': THREW after ' + (Date.now() - t0) + 'ms · ' + err.message);
    }
    Utilities.sleep(1000);
  });
  Logger.log('READ: HTTP 200 with thousands of bars in <1s = healthy, retry the harvest. ' +
    'HTTP 429/999, an HTML body, or multi-second failures = throttled, wait and retry.');
}
