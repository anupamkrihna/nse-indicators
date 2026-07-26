/* test_tierlab.js — cross-sectional tier research. The important checks:
   (1) the primary factor is computed correctly and in the direction Krishna
   pre-registered, (2) decile assignment is balanced and correctly oriented,
   (3) the monotonicity + CI judge accepts a real gradient and rejects both a
   flat one and a top-vs-bottom gap with no gradient. */

var TLCFG = { DECILES: 10, MIN_PER_DATE: 50, TRAIN_FRAC: 0.70, BOOT_ITERS: 400, BOOT_SEED: 20260725, RHO_MIN: 0.60 };

function tlRollMax_(close, idx, win) {
  var from = idx - win + 1; if (from < 0) return null;
  var m = -Infinity; for (var i = from; i <= idx; i++) if (close[i] > m) m = close[i];
  return m === -Infinity ? null : m;
}
function tlPct52w_(close, idx) { var mx = tlRollMax_(close, idx, 252); if (mx == null || mx <= 0) return null; return close[idx] / mx; }
function tlMom12_1_(close, idx) {
  if (idx < 252) return null;
  var a = close[idx - 21], b = close[idx - 252];
  if (a == null || b == null || b <= 0) return null;
  return a / b - 1;
}
function tlMonthEnds_(ts) {
  var out = [], prevKey = null, lastIdx = -1;
  for (var i = 0; i < ts.length; i++) {
    if (ts[i] == null) continue;
    var d = new Date(ts[i] * 1000);
    var key = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
    if (prevKey !== null && key !== prevKey) out.push(lastIdx);
    prevKey = key; lastIdx = i;
  }
  return out;
}
function tlAssignDeciles_(values, D) {
  D = D || TLCFG.DECILES;
  var idx = values.map(function (v, i) { return { v: v, i: i }; }).filter(function (x) { return x.v != null && !isNaN(x.v); });
  idx.sort(function (a, b) { return a.v - b.v; });
  var n = idx.length, out = new Array(values.length).fill(null);
  if (n < D) return out;
  for (var r = 0; r < n; r++) out[idx[r].i] = Math.min(D, Math.floor(r * D / n) + 1);
  return out;
}
function tlMedian_(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length, m = (n - 1) / 2; return n % 2 ? s[m] : (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; }
function tlMean_(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
function tlSpearman_(x, y) {
  var n = x.length; if (n < 3 || y.length !== n) return null;
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
  var rx = ranks(x), ry = ranks(y), mx = tlMean_(rx), my = tlMean_(ry), num = 0, dx = 0, dy = 0;
  for (var i = 0; i < n; i++) { var a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx === 0 || dy === 0) ? null : num / Math.sqrt(dx * dy);
}
function tlDecileTable_(rows, horizonKey, D) {
  D = D || TLCFG.DECILES;
  var buckets = []; for (var d = 0; d < D; d++) buckets.push([]);
  var all = [];
  rows.forEach(function (r) { var f = r[horizonKey]; if (f == null || r.dec == null) return; buckets[r.dec - 1].push(f); all.push(f); });
  var tbl = buckets.map(function (b, i) {
    return { decile: i + 1, n: b.length, median: tlMedian_(b), mean: tlMean_(b),
      hold: b.length ? b.filter(function (v) { return v >= 0; }).length / b.length : null };
  });
  var meds = tbl.map(function (t) { return t.median == null ? 0 : t.median; });
  var rho = tlSpearman_(tbl.map(function (t) { return t.decile; }), meds);
  return { table: tbl, universeMedian: tlMedian_(all), universeMean: tlMean_(all), n: all.length, rho: rho == null ? null : Math.round(rho * 1000) / 1000 };
}
function tlRng_(seed) { var s = (seed || 1) % 4294967296; return function () { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296; }; }
function tlTopVsUniverseCI_(rows, horizonKey, D, iters, rng) {
  D = D || TLCFG.DECILES; iters = iters || TLCFG.BOOT_ITERS; rng = rng || tlRng_(TLCFG.BOOT_SEED);
  var byDate = {}, keys = [];
  rows.forEach(function (r) {
    if (r[horizonKey] == null || r.dec == null) return;
    if (!byDate[r.date]) { byDate[r.date] = { top: [], all: [] }; keys.push(r.date); }
    byDate[r.date].all.push(r[horizonKey]);
    if (r.dec === D) byDate[r.date].top.push(r[horizonKey]);
  });
  var K = keys.length; if (K < 4) return null;
  function point(ks) {
    var t = [], a = [];
    ks.forEach(function (k) { var g = byDate[k]; t = t.concat(g.top); a = a.concat(g.all); });
    var mt = tlMedian_(t), ma = tlMedian_(a);
    return (mt == null || ma == null) ? null : mt - ma;
  }
  var p = point(keys), draws = [];
  for (var it = 0; it < iters; it++) {
    var samp = []; for (var j = 0; j < K; j++) samp.push(keys[Math.floor(rng() * K)]);
    var v = point(samp); if (v != null) draws.push(v);
  }
  if (draws.length < 50) return null;
  draws.sort(function (a, b) { return a - b; });
  function pct(q) { return draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))]; }
  return { point: Math.round(p * 100000) / 100000, lo: Math.round(pct(0.025) * 100000) / 100000,
    hi: Math.round(pct(0.975) * 100000) / 100000, dates: K, iters: draws.length };
}
function tlJudge_(ci, rho) {
  if (!ci) return { pass: false, why: 'no interval' };
  if (rho == null) return { pass: false, why: 'no monotonicity estimate' };
  if (ci.lo <= 0) return { pass: false, why: 'CI includes zero' };
  if (rho < TLCFG.RHO_MIN) return { pass: false, why: 'gradient not monotone (rho ' + rho + ')' };
  return { pass: true, why: 'CI clear of zero and gradient monotone (rho ' + rho + ')' };
}

let fails = 0;
function ok(n, c) { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) fails++; }
function mkRng(s) { var x = s; return function () { x = (1103515245 * x + 12345) % 2147483648; return x / 2147483648; }; }

console.log('── PRIMARY FACTOR: pct52w ──');
(function () {
  var cl = []; for (var i = 0; i < 300; i++) cl.push(100);
  cl[299] = 100;
  ok('flat series at its high → 1.0', tlPct52w_(cl, 299) === 1);
  var rising = []; for (var j = 0; j < 300; j++) rising.push(100 + j);
  ok('monotone riser is always AT its 52w high', tlPct52w_(rising, 299) === 1);
  var fallen = rising.slice(); fallen[299] = 0.6 * fallen[298];
  ok('a stock 40% off its high scores ~0.6', Math.abs(tlPct52w_(fallen, 299) - 0.6) < 0.005);
  ok('score is bounded in (0,1]', tlPct52w_(rising, 299) <= 1 && tlPct52w_(fallen, 299) <= 1);
  ok('insufficient history → null', tlPct52w_(rising, 100) === null);
  // the 52w window must FORGET older highs
  var spike = []; for (var k = 0; k < 400; k++) spike.push(100);
  spike[10] = 500;                       // ancient high, outside the trailing 252
  ok('a high older than 252 bars is forgotten', tlPct52w_(spike, 399) === 1);
  spike[200] = 500;                      // inside the window at idx 399? 399-251=148, so yes
  ok('a high inside the window still counts', Math.abs(tlPct52w_(spike, 399) - 0.2) < 1e-9);
})();

console.log('\n── momentum + month-end alignment ──');
(function () {
  var cl = []; for (var i = 0; i < 300; i++) cl.push(100 * Math.pow(1.001, i));
  var m = tlMom12_1_(cl, 299);
  ok('12-1 momentum positive on a riser', m > 0);
  ok('  and it skips the most recent month', Math.abs(m - (cl[278] / cl[47] - 1)) < 1e-12);
  // month-end detection across a year of daily stamps
  var ts = [], d = Date.UTC(2024, 0, 1) / 1000;
  for (var k = 0; k < 365; k++) ts.push(d + k * 86400);
  var me = tlMonthEnds_(ts);
  ok('one month-end per completed month', me.length === 11);
  var last = new Date(ts[me[0]] * 1000);
  ok('first month-end is 31 Jan', last.getUTCMonth() === 0 && last.getUTCDate() === 31);
  ok('in-progress final month excluded', me[me.length - 1] < ts.length - 1);
})();

console.log('\n── decile assignment ──');
(function () {
  var v = []; for (var i = 0; i < 100; i++) v.push(i);
  var d = tlAssignDeciles_(v, 10);
  ok('every value gets a decile', d.filter(function (x) { return x == null; }).length === 0);
  ok('buckets are equal-sized', [1,2,3,4,5,6,7,8,9,10].every(function (k) { return d.filter(function (x) { return x === k; }).length === 10; }));
  ok('HIGHEST factor value lands in decile 10 (orientation)', d[99] === 10);
  ok('lowest factor value lands in decile 1', d[0] === 1);
  ok('too few names → all null', tlAssignDeciles_([1,2,3], 10).every(function (x) { return x === null; }));
  var withNulls = [5, null, 3, NaN, 1];
  ok('nulls and NaN excluded, not ranked', tlAssignDeciles_(withNulls, 2)[1] === null);
})();

console.log('\n── the judge: accepts real gradients, rejects the rest ──');
(function () {
  function build(medianByDecile, seed) {
    var rows = [], r = mkRng(seed);
    for (var dt = 0; dt < 40; dt++) for (var dec = 1; dec <= 10; dec++)
      for (var k = 0; k < 25; k++)
        rows.push({ sym: 'S' + dec + '_' + k, date: 'm' + dt, dec: dec,
          fwd1m: medianByDecile[dec - 1] + (r() - 0.5) * 0.06 });
    return rows;
  }
  // (a) genuine monotone gradient
  var grad = [], base = -0.02;
  for (var i = 0; i < 10; i++) grad.push(base + i * 0.006);
  var A = build(grad, 11);
  var ta = tlDecileTable_(A, 'fwd1m'), ca = tlTopVsUniverseCI_(A, 'fwd1m', 10, 300, tlRng_(1));
  ok('monotone gradient → rho near 1', ta.rho > 0.95);
  ok('monotone gradient → CI clear of zero', ca.lo > 0);
  ok('monotone gradient → PASS', tlJudge_(ca, ta.rho).pass === true);

  // (b) flat — no relationship
  var flat = []; for (var j = 0; j < 10; j++) flat.push(0.01);
  var B = build(flat, 22);
  var tb = tlDecileTable_(B, 'fwd1m'), cb = tlTopVsUniverseCI_(B, 'fwd1m', 10, 300, tlRng_(2));
  ok('flat → CI includes zero', cb.lo <= 0 && cb.hi >= 0);
  ok('flat → FAIL', tlJudge_(cb, tb.rho).pass === false);

  // (c) THE SUBTLE ONE: top decile good, everything else flat — a gap with no gradient
  var gap = []; for (var q = 0; q < 9; q++) gap.push(0.01); gap.push(0.05);
  var C = build(gap, 33);
  var tc = tlDecileTable_(C, 'fwd1m'), cc = tlTopVsUniverseCI_(C, 'fwd1m', 10, 300, tlRng_(3));
  ok('gap-without-gradient: CI IS clear of zero (looks good)', cc.lo > 0);
  ok('gap-without-gradient: but rho is low', tc.rho < TLCFG.RHO_MIN);
  ok('gap-without-gradient → still FAILS the criterion', tlJudge_(cc, tc.rho).pass === false);
  ok('  and the reason names the gradient', /monotone/.test(tlJudge_(cc, tc.rho).why));

  // (d) inverted — buy-the-dip would look like this
  var inv = []; for (var z = 0; z < 10; z++) inv.push(0.04 - z * 0.006);
  var D = build(inv, 44);
  var td = tlDecileTable_(D, 'fwd1m'), cd = tlTopVsUniverseCI_(D, 'fwd1m', 10, 300, tlRng_(4));
  ok('inverted → rho strongly negative', td.rho < -0.95);
  ok('inverted → FAIL', tlJudge_(cd, td.rho).pass === false);
  ok('inverted → top decile BELOW universe', cd.point < 0);
})();

console.log('\n── date-clustered CI behaves ──');
(function () {
  var rows = [], r = mkRng(55);
  for (var dt = 0; dt < 30; dt++) for (var dec = 1; dec <= 10; dec++) for (var k = 0; k < 20; k++)
    rows.push({ sym: 'S' + k, date: 'm' + dt, dec: dec, fwd1m: (dec === 10 ? 0.03 : 0.01) + (r() - 0.5) * 0.04 });
  var ci = tlTopVsUniverseCI_(rows, 'fwd1m', 10, 300, tlRng_(9));
  ok('clusters by date, not by row', ci.dates === 30);
  ok('interval brackets the point', ci.lo <= ci.point && ci.point <= ci.hi);
  var a = tlTopVsUniverseCI_(rows, 'fwd1m', 10, 300, tlRng_(9));
  ok('same seed → reproducible', a.lo === ci.lo && a.hi === ci.hi);
  ok('too few dates → null', tlTopVsUniverseCI_(rows.filter(function (x) { return x.date === 'm0'; }), 'fwd1m', 10, 300, tlRng_(9)) === null);
})();

console.log('\n── train/holdout split is by DATE ──');
(function () {
  var dates = []; for (var i = 0; i < 100; i++) dates.push('m' + ('00' + i).slice(-3));
  var cut = Math.floor(dates.length * TLCFG.TRAIN_FRAC);
  var train = {}, i2;
  for (i2 = 0; i2 < cut; i2++) train[dates[i2]] = 1;
  ok('70/30 by date count', cut === 70);
  ok('train holds the EARLIEST dates', train['m000'] === 1 && train['m069'] === 1);
  ok('holdout holds the LATEST dates', train['m070'] === undefined && train['m099'] === undefined);
  ok('no date appears on both sides', Object.keys(train).filter(function (d) { return dates.indexOf(d) >= cut; }).length === 0);
})();

/* ── v1.1 helpers under test ── */
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
  var lo = -Infinity;
  for (var i = 0; i < k; i++) if (a[i] > lo) lo = a[i];
  return (lo + hi) / 2;
}

console.log('\n── THE BUG: Sheets coerces month keys to Dates ──');
(function () {
  ok('plain string passes through', tlNormYm_('2016-04') === '2016-04');
  var asDate = new Date(2016, 3, 1);                       // what Sheets hands back
  ok('Date object recovers the right month', tlNormYm_(asDate) === '2016-04');
  ok('coerced date STRING recovers too', tlNormYm_('Fri Apr 01 2016 00:00:00 GMT+0530') === '2016-04');
  ok('null/blank safe', tlNormYm_(null) === '' && tlNormYm_('') === '');

  // the failure this caused: sorting coerced strings sorts by WEEKDAY NAME
  var raw = ['Fri Apr 01 2022 00:00:00', 'Wed Sep 01 2021 00:00:00', 'Mon Jan 01 2018 00:00:00'];
  var badOrder = raw.slice().sort();
  ok('REPRODUCES THE BUG: raw sort puts 2022 before 2018', badOrder[0].indexOf('2022') > 0);
  var good = raw.map(tlNormYm_).sort();
  ok('normalised sort is chronological', good[0] === '2018-01' && good[2] === '2022-04');
  ok('  and spans the right range', good.join(',') === '2018-01,2021-09,2022-04');
})();

console.log('\n── quickselect median == sort-based median ──');
(function () {
  function refMedian(a) { var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length, m = (n - 1) / 2; return n % 2 ? s[m] : (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; }
  var r = mkRng(4242), bad = 0;
  for (var trial = 0; trial < 200; trial++) {
    var n = 1 + Math.floor(r() * 60), a = [];
    for (var i = 0; i < n; i++) a.push(Math.round((r() - 0.5) * 200) / 100);
    var want = refMedian(a);
    var got = tlSelectMedian_(a.slice(), n);
    if (Math.abs(want - got) > 1e-12) bad++;
  }
  ok('matches on 200 random arrays (odd and even lengths)', bad === 0);
  ok('single element', tlSelectMedian_([7], 1) === 7);
  ok('two elements averages', tlSelectMedian_([1, 4], 2) === 2.5);
  ok('all identical', tlSelectMedian_([3,3,3,3], 4) === 3);
  ok('already sorted', tlSelectMedian_([1,2,3,4,5], 5) === 3);
  ok('reverse sorted', tlSelectMedian_([5,4,3,2,1], 5) === 3);
  ok('empty → null', tlSelectMedian_([], 0) === null);
  // buffer semantics: only the first n entries are meaningful
  var buf = [9, 1, 5, 999, 999];
  ok('respects the valid-length bound', tlSelectMedian_(buf, 3) === 5);

  // scale: this is what timed out before
  var big = [], r2 = mkRng(7);
  for (var k = 0; k < 90000; k++) big.push((r2() - 0.5) * 0.4);
  var t0 = Date.now();
  for (var it = 0; it < 250; it++) tlSelectMedian_(big, big.length);
  var ms = Date.now() - t0;
  console.log('   (250 medians of 90k values → ' + ms + 'ms)');
  ok('fast enough for a bootstrap inside the GAS budget', ms < 15000);
})();

console.log('\n── duplicate guard ──');
(function () {
  var raw = [
    { sym: 'A', ym: '2020-01' }, { sym: 'A', ym: '2020-02' },
    { sym: 'A', ym: '2020-01' },                            // duplicate from a harvest re-run
    { sym: 'B', ym: '2020-01' }
  ];
  var seen = {}, kept = [], dupes = 0;
  raw.forEach(function (r) {
    var k = r.sym + '|' + r.ym;
    if (seen[k]) { dupes++; return; }
    seen[k] = 1; kept.push(r);
  });
  ok('duplicate sym+month dropped', kept.length === 3);
  ok('duplicate counted for reporting', dupes === 1);
  ok('distinct pairs preserved', kept.filter(function (x) { return x.sym === 'A'; }).length === 2);
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
