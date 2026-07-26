/* test_bullbf.js — validation of the Bull Watch backfill.
   THE CRITICAL TEST is FIDELITY: bbClassifyAt_(…, n-1) must produce the same
   cls and grade as bullPack_(full arrays). If it doesn't, the backfill is
   measuring a different system than the live board displays.
   Code.gs helpers (ema/rsi/adx/obv/macd/bullPack_) are copied verbatim. */

/* ─── verbatim from Code.gs ─── */
function ema(a, n) {
  var out = new Array(a.length).fill(null), k = 2 / (n + 1), prev = null, seed = 0;
  for (var i = 0; i < a.length; i++) {
    if (i < n - 1) { seed += a[i]; continue; }
    if (i === n - 1) { prev = (seed + a[i]) / n; out[i] = prev; continue; }
    prev = a[i] * k + prev * (1 - k); out[i] = prev;
  }
  return out;
}
function rsiSeries(close, n) {
  n = n || 14;
  var out = new Array(close.length).fill(null), g = 0, l = 0;
  for (var i = 1; i < close.length; i++) {
    var d = close[i] - close[i - 1], up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function bearishDivergence(close, rsi, lookback) {
  lookback = lookback || 60;
  var n = close.length, from = Math.max(2, n - lookback), peaks = [];
  for (var i = from; i < n - 1; i++) if (close[i] > close[i - 1] && close[i] > close[i + 1] && rsi[i] != null) peaks.push(i);
  if (peaks.length < 2) return false;
  var a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
  return close[b] > close[a] && rsi[b] < rsi[a];
}
function linSlope(a) {
  var n = a.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (var i = 0; i < n; i++) { sx += i; sy += a[i]; sxy += i * a[i]; sxx += i * i; }
  var d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}
function macdPack(close) {
  var e12 = ema(close, 12), e26 = ema(close, 26), line = [], n = close.length;
  for (var i = 0; i < n; i++) line.push(e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  var first = line.findIndex(function (v) { return v != null; });
  var sig = new Array(n).fill(null);
  if (first >= 0) { var sub = ema(line.slice(first), 9); for (var j = 0; j < sub.length; j++) sig[first + j] = sub[j]; }
  var hist = line.map(function (v, k) { return v != null && sig[k] != null ? v - sig[k] : null; });
  var h = hist.filter(function (v) { return v != null; });
  var expanding = h.length >= 3 && Math.abs(h[h.length - 1]) > Math.abs(h[h.length - 2]) && Math.abs(h[h.length - 2]) > Math.abs(h[h.length - 3]);
  var L = line[n - 1], S = sig[n - 1], H = hist[n - 1];
  return { line: L == null ? null : Math.round(L * 100) / 100, signal: S == null ? null : Math.round(S * 100) / 100,
    hist: H == null ? null : Math.round(H * 100) / 100, histDir: H == null ? 'na' : H > 0 ? 'bull' : 'bear',
    histExpanding: !!expanding, aboveZero: L != null && L > 0 };
}
function obvPack(close, vol) {
  var obv = [0];
  for (var i = 1; i < close.length; i++) obv.push(obv[i - 1] + (close[i] > close[i - 1] ? vol[i] : close[i] < close[i - 1] ? -vol[i] : 0));
  var w = obv.slice(-20), slope = linSlope(w);
  var span = Math.max.apply(null, w) - Math.min.apply(null, w) || 1;
  var norm = slope * 20 / span;
  return { obv: obv, trend: norm > 0.15 ? 'rising' : norm < -0.15 ? 'falling' : 'flat' };
}
function rvol20(vol) {
  if (vol.length < 21) return null;
  var last = vol[vol.length - 1], w = vol.slice(-21, -1);
  var avg = w.reduce(function (a, b) { return a + b; }) / w.length;
  return avg > 0 ? Math.round(last / avg * 100) / 100 : null;
}
function bullSlp_(arr) {
  var n = arr.length;
  if (n < 12 || arr[n - 1] == null || arr[n - 11] == null || arr[n - 11] === 0) return null;
  return Math.round((arr[n - 1] - arr[n - 11]) / arr[n - 11] * 10000) / 100;
}
function bullPack_(cl, e20, e50, e200, adxRegime, sell, macdObj, rvolV, obvTrendV, rsiV, rsiDiv) {
  var n = cl.length, price = cl[n - 1];
  var s20 = bullSlp_(e20), s50 = bullSlp_(e50), s200 = bullSlp_(e200);
  if (s20 == null || s50 == null || s200 == null) return { ok: true, on: false };
  var risingAll = s20 > 0 && s50 > 0 && s200 > 0;
  if (!risingAll) return { ok: true, on: false };
  var v20 = e20[n - 1], v50 = e50[n - 1], v200 = e200[n - 1];
  var ext200 = Math.round((price - v200) / v200 * 1000) / 10;
  var dist50 = Math.round((price - v50) / price * 1000) / 10;
  var stacked = price > v20 && v20 > v50 && v50 > v200;
  var trending = (adxRegime === 'trend' || adxRegime === 'strong');
  var why = [];
  if (rsiDiv) why.push('RSI divergence');
  if (ext200 >= 30) why.push('extended');
  if (rsiV != null && rsiV >= 80) why.push('RSI 80');
  if (price < v20) why.push('below 20 DMA');
  var cls = why.length ? 'CAUTION' : (stacked && trending ? 'STRONG' : 'BULL');
  var confirms = 0;
  if (macdObj && macdObj.histExpanding && macdObj.histDir === 'bull') confirms++;
  if (rvolV != null && rvolV >= 1.5) confirms++;
  if (obvTrendV === 'rising') confirms++;
  if (rsiV != null && rsiV >= 40 && rsiV <= 80) confirms++;
  var grade = cls === 'CAUTION' ? 'C' : (trending && confirms >= 2 ? 'A' : 'B');
  return { ok: true, on: true, cls: cls, grade: grade, s20: s20, s50: s50, s200: s200, ext200: ext200, dist50: dist50, stacked: stacked, reasons: why };
}

/* ─── under test: verbatim from BullBackfill.gs ─── */
var BBCFG = { BOOT_ITERS: 400, BOOT_SEED: 20260725 };
function bbSlopeAt_(arr, idx) {
  if (idx < 11 || arr[idx] == null || arr[idx - 10] == null || arr[idx - 10] === 0) return null;
  return Math.round((arr[idx] - arr[idx - 10]) / arr[idx - 10] * 10000) / 100;
}
function bbRvolAt_(vol, idx) {
  if (idx < 20) return null;
  var last = vol[idx], s = 0, c = 0;
  for (var i = idx - 20; i < idx; i++) { s += vol[i]; c++; }
  var avg = c ? s / c : 0;
  return avg > 0 ? Math.round(last / avg * 100) / 100 : null;
}
function bbLinSlope_(a) {
  var n = a.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (var i = 0; i < n; i++) { sx += i; sy += a[i]; sxy += i * a[i]; sxx += i * i; }
  var d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}
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
function bbObvSeries_(close, vol) {
  var obv = [0];
  for (var i = 1; i < close.length; i++) obv.push(obv[i - 1] + (close[i] > close[i - 1] ? vol[i] : close[i] < close[i - 1] ? -vol[i] : 0));
  return obv;
}
function bbMacdSeries_(close, emaFn) {
  var e12 = emaFn(close, 12), e26 = emaFn(close, 26), n = close.length, line = [];
  for (var i = 0; i < n; i++) line.push(e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  var first = -1;
  for (var f = 0; f < n; f++) { if (line[f] != null) { first = f; break; } }
  var sig = new Array(n).fill(null);
  if (first >= 0) { var sub = emaFn(line.slice(first), 9); for (var j = 0; j < sub.length; j++) sig[first + j] = sub[j]; }
  var hist = [];
  for (var k = 0; k < n; k++) hist.push(line[k] != null && sig[k] != null ? line[k] - sig[k] : null);
  return { line: line, sig: sig, hist: hist };
}
function bbMacdAt_(hist, idx) {
  var H = hist[idx];
  if (H == null) return { hist: null, histDir: 'na', histExpanding: false };
  var a = hist[idx], b = hist[idx - 1], c = hist[idx - 2];
  var expanding = (a != null && b != null && c != null && Math.abs(a) > Math.abs(b) && Math.abs(b) > Math.abs(c));
  return { hist: H, histDir: H > 0 ? 'bull' : 'bear', histExpanding: !!expanding };
}
function bbDivergenceAt_(close, rsi, idx, lookback) {
  lookback = lookback || 60;
  var n = idx + 1, from = Math.max(2, n - lookback), peaks = [];
  for (var i = from; i < n - 1; i++) if (close[i] > close[i - 1] && close[i] > close[i + 1] && rsi[i] != null) peaks.push(i);
  if (peaks.length < 2) return false;
  var a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
  return close[b] > close[a] && rsi[b] < rsi[a];
}
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
function bbRate_(rows) { if (!rows.length) return null; var h = 0; for (var i = 0; i < rows.length; i++) h += (rows[i].fwd >= 0 ? 1 : 0); return h / rows.length; }
function bbMeanFwd_(rows) { if (!rows.length) return null; var s = 0; for (var i = 0; i < rows.length; i++) s += rows[i].fwd; return s / rows.length; }
function bbTable_(rows) {
  var byCls = { STRONG: [], BULL: [], CAUTION: [] }, all = rows || [];
  all.forEach(function (r) { if (byCls[r.cls]) byCls[r.cls].push(r); });
  function agg(a) {
    var hr = bbRate_(a), mf = bbMeanFwd_(a);
    return { n: a.length, holdRate: hr == null ? null : Math.round(hr * 10000) / 10000, meanFwd: mf == null ? null : Math.round(mf * 100000) / 100000 };
  }
  return { STRONG: agg(byCls.STRONG), BULL: agg(byCls.BULL), CAUTION: agg(byCls.CAUTION),
    BENCHMARK: agg(all), onBoard: agg(byCls.STRONG.concat(byCls.BULL, byCls.CAUTION)) };
}
function bbRng_(seed) { var s = (seed || 1) % 4294967296; return function () { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296; }; }
function bbSpread_(rows, clsA, clsB) {
  var a = rows.filter(function (r) { return r.cls === clsA; });
  var b = (clsB === '*') ? rows : rows.filter(function (r) { return r.cls === clsB; });
  var ra = bbRate_(a), rb = bbRate_(b);
  if (ra == null || rb == null) return null;
  return ra - rb;
}
function bbBootstrapCI_naive_(rows, clusterKey, clsA, clsB, iters, rng) {
  iters = iters || BBCFG.BOOT_ITERS;
  rng = rng || bbRng_(BBCFG.BOOT_SEED);
  var groups = {}, keys = [];
  rows.forEach(function (r) { var k = String(r[clusterKey]); if (!groups[k]) { groups[k] = []; keys.push(k); } groups[k].push(r); });
  if (keys.length < 2) return null;
  var point = bbSpread_(rows, clsA, clsB), draws = [];
  for (var it = 0; it < iters; it++) {
    var samp = [];
    for (var j = 0; j < keys.length; j++) { var g = groups[keys[Math.floor(rng() * keys.length)]]; for (var q = 0; q < g.length; q++) samp.push(g[q]); }
    var s = bbSpread_(samp, clsA, clsB);
    if (s != null) draws.push(s);
  }
  if (draws.length < 100) return null;
  draws.sort(function (x, y) { return x - y; });
  function pct(p) { return draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))]; }
  return { point: point == null ? null : Math.round(point * 10000) / 10000, lo: Math.round(pct(0.025) * 10000) / 10000,
    hi: Math.round(pct(0.975) * 10000) / 10000, iters: draws.length, clusters: keys.length };
}
function bbClusterStats_(rows, clusterKey, clsA, clsB) {
  var m = {}, keys = [];
  rows.forEach(function (r) {
    var k = String(r[clusterKey]);
    if (!m[k]) { m[k] = { aH: 0, aN: 0, aS: 0, bH: 0, bN: 0, bS: 0 }; keys.push(k); }
    var held = r.fwd >= 0 ? 1 : 0;
    if (r.cls === clsA) { m[k].aN++; m[k].aH += held; m[k].aS += r.fwd; }
    if (clsB === '*') { m[k].bN++; m[k].bH += held; m[k].bS += r.fwd; }
    else if (r.cls === clsB) { m[k].bN++; m[k].bH += held; m[k].bS += r.fwd; }
  });
  return keys.map(function (k) { return m[k]; });
}
function bbMeanSpread_(rows, clsA, clsB) {
  var a = rows.filter(function (r) { return r.cls === clsA; });
  var b = (clsB === '*') ? rows : rows.filter(function (r) { return r.cls === clsB; });
  var ma = bbMeanFwd_(a), mb = bbMeanFwd_(b);
  if (ma == null || mb == null) return null;
  return ma - mb;
}
function bbBucketOf_(why) {
  var w = String(why || '');
  if (!w) return '';
  var has = function (c) { return w.split(',').indexOf(c) >= 0; };
  if (has('below20')) return 'C_PULLBACK';
  if (has('ext') || has('rsi80')) return 'C_EXTENDED';
  if (has('div')) return 'C_DIVERGENCE';
  return 'C_OTHER';
}
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
function bbSubsample_(rows, startIdx, stride) {
  return rows.filter(function (r) { return ((Number(r.t) - startIdx) % stride) === 0; });
}
function bbBootstrapCI_(rows, clusterKey, clsA, clsB, iters, rng, metric) {
  iters = iters || BBCFG.BOOT_ITERS;
  rng = rng || bbRng_(BBCFG.BOOT_SEED);
  metric = metric || 'hold';
  var stats = bbClusterStats_(rows, clusterKey, clsA, clsB), K = stats.length;
  if (K < 2) return null;
  var point = (metric === 'mean') ? bbMeanSpread_(rows, clsA, clsB) : bbSpread_(rows, clsA, clsB);
  var draws = [];
  for (var it = 0; it < iters; it++) {
    var aH = 0, aN = 0, aS = 0, bH = 0, bN = 0, bS = 0;
    for (var j = 0; j < K; j++) { var g = stats[Math.floor(rng() * K)]; aH += g.aH; aN += g.aN; aS += g.aS; bH += g.bH; bN += g.bN; bS += g.bS; }
    if (!aN || !bN) continue;
    draws.push(metric === 'mean' ? (aS / aN - bS / bN) : (aH / aN - bH / bN));
  }
  if (draws.length < 100) return null;
  draws.sort(function (x, y) { return x - y; });
  function pct(p) { return draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))]; }
  return { point: point == null ? null : Math.round(point * 10000) / 10000, lo: Math.round(pct(0.025) * 10000) / 10000,
    hi: Math.round(pct(0.975) * 10000) / 10000, iters: draws.length, clusters: K, metric: metric };
}
function bbVerdict_(ciStock, ciDate) {
  if (!ciStock || !ciDate) return { pass: false, text: 'insufficient data' };
  var crosses = function (ci) { return ci.lo <= 0 && ci.hi >= 0; };
  if (crosses(ciDate) || crosses(ciStock)) return { pass: false, text: 'KILL CRITERION MET' };
  if (ciDate.point <= 0) return { pass: false, text: 'spread negative' };
  return { pass: true, text: 'spread positive, intervals clear of zero' };
}

/* ─── harness ─── */
let fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) fails++; }
function mkRng(seed) { var s = seed; return function () { s = (1103515245 * s + 12345) % 2147483648; return s / 2147483648; }; }

/* synthetic series generator: trend + noise + occasional shocks */
function series(seed, n, drift, volPct) {
  var r = mkRng(seed), cl = [], vo = [], p = 100;
  for (var i = 0; i < n; i++) {
    var shock = (r() < 0.02) ? (r() - 0.5) * 0.18 : 0;
    p = Math.max(1, p * (1 + drift + (r() - 0.5) * volPct + shock));
    cl.push(p);
    vo.push(Math.round(50000 + r() * 200000));
  }
  return { close: cl, volume: vo };
}
function adxRegimeFake(seed) { var r = mkRng(seed)(); return r < 0.3 ? 'chop' : r < 0.5 ? 'weak' : r < 0.85 ? 'trend' : 'strong'; }

console.log('── FIDELITY: bbClassifyAt_(n-1) must equal bullPack_(full) ──');
(function () {
  var mismatchCls = 0, mismatchGrade = 0, checked = 0, onCount = 0;
  var configs = [
    { drift: 0.0012, vol: 0.02 }, { drift: 0.0025, vol: 0.03 }, { drift: -0.0010, vol: 0.02 },
    { drift: 0.0000, vol: 0.04 }, { drift: 0.0040, vol: 0.015 }, { drift: 0.0008, vol: 0.055 }
  ];
  for (var c = 0; c < configs.length; c++) {
    for (var seed = 1; seed <= 25; seed++) {
      var n = 320 + (seed % 40);
      var s = series(seed * 7919 + c * 101, n, configs[c].drift, configs[c].vol);
      var cl = s.close, vol = s.volume;
      var e20 = ema(cl, 20), e50 = ema(cl, 50), e200 = ema(cl, 200);
      var rsiArr = rsiSeries(cl, 14);
      var reg = adxRegimeFake(seed * 13 + c);

      // LIVE path (Code.gs): whole-array helpers reading the last bar
      var live = bullPack_(cl, e20, e50, e200, reg, null, macdPack(cl),
        rvol20(vol), obvPack(cl, vol).trend, rsiArr[cl.length - 1],
        bearishDivergence(cl, rsiArr, 60));

      // BACKFILL path: bar-indexed helpers at idx = n-1
      var idx = cl.length - 1;
      var macdS = bbMacdSeries_(cl, ema), obv = bbObvSeries_(cl, vol);
      var bf = bbClassifyAt_(cl, e20, e50, e200, reg, bbMacdAt_(macdS.hist, idx),
        bbRvolAt_(vol, idx), bbObvTrendAt_(obv, idx), rsiArr[idx],
        bbDivergenceAt_(cl, rsiArr, idx, 60), idx);

      checked++;
      if (!!live.on !== !!bf.on) { mismatchCls++; continue; }
      if (live.on) {
        onCount++;
        if (live.cls !== bf.cls) mismatchCls++;
        if (live.grade !== bf.grade) mismatchGrade++;
      }
    }
  }
  console.log('   (' + checked + ' series compared, ' + onCount + ' on-board)');
  ok('on/off agreement across all series', mismatchCls === 0 || onCount === 0);
  ok('cls identical in every on-board case', mismatchCls === 0);
  ok('grade identical in every on-board case', mismatchGrade === 0);
  ok('sample exercised the on-board branch (not vacuous)', onCount >= 20);
})();

console.log('\n── bar-indexed helpers match their whole-array originals ──');
(function () {
  var s = series(4242, 300, 0.0015, 0.025), cl = s.close, vol = s.volume;
  var idx = cl.length - 1;
  var e50 = ema(cl, 50);
  ok('bbSlopeAt_ == bullSlp_', bbSlopeAt_(e50, idx) === bullSlp_(e50));
  ok('bbRvolAt_ == rvol20', bbRvolAt_(vol, idx) === rvol20(vol));
  ok('bbObvTrendAt_ == obvPack().trend', bbObvTrendAt_(bbObvSeries_(cl, vol), idx) === obvPack(cl, vol).trend);
  var rsiArr = rsiSeries(cl, 14);
  ok('bbDivergenceAt_ == bearishDivergence', bbDivergenceAt_(cl, rsiArr, idx, 60) === bearishDivergence(cl, rsiArr, 60));
  var m = bbMacdAt_(bbMacdSeries_(cl, ema).hist, idx), mp = macdPack(cl);
  ok('bbMacdAt_ histDir matches', m.histDir === mp.histDir);
  ok('bbMacdAt_ histExpanding matches', m.histExpanding === mp.histExpanding);

  // and at an INTERIOR bar, the bar-indexed read must equal the truncated-array read
  var mid = 240;
  ok('interior bar: slope matches truncated array', bbSlopeAt_(e50, mid) === bullSlp_(e50.slice(0, mid + 1)));
  ok('interior bar: rvol matches truncated array', bbRvolAt_(vol, mid) === rvol20(vol.slice(0, mid + 1)));
  ok('interior bar: divergence matches truncated array',
    bbDivergenceAt_(cl, rsiArr, mid, 60) === bearishDivergence(cl.slice(0, mid + 1), rsiArr.slice(0, mid + 1), 60));
})();

console.log('\n── statistics ──');
(function () {
  var rows = [
    { sym: 'A', date: '2025-01-01', cls: 'STRONG', fwd: 0.05 },
    { sym: 'A', date: '2025-02-01', cls: 'STRONG', fwd: -0.02 },
    { sym: 'B', date: '2025-01-01', cls: 'CAUTION', fwd: -0.04 },
    { sym: 'B', date: '2025-02-01', cls: 'CAUTION', fwd: -0.01 },
    { sym: 'C', date: '2025-01-01', cls: 'OFF', fwd: 0.01 }
  ];
  var t = bbTable_(rows);
  ok('STRONG hold rate 1/2', t.STRONG.holdRate === 0.5);
  ok('CAUTION hold rate 0/2', t.CAUTION.holdRate === 0);
  ok('BENCHMARK spans ALL rows incl. OFF', t.BENCHMARK.n === 5);
  ok('onBoard excludes OFF', t.onBoard.n === 4);
  ok('spread STRONG−CAUTION = +0.5', bbSpread_(rows, 'STRONG', 'CAUTION') === 0.5);
  ok('spread vs "*" uses the whole sample', Math.abs(bbSpread_(rows, 'STRONG', '*') - (0.5 - 0.4)) < 1e-9);
  ok('empty class → null spread', bbSpread_(rows, 'BULL', 'CAUTION') === null);
})();

console.log('\n── bootstrap + kill criterion ──');
(function () {
  // build a genuine +20pp separation across 40 stocks × 6 dates
  var strong = [], caution = [], r = mkRng(99);
  var dates = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
  for (var i = 0; i < 40; i++) for (var d = 0; d < dates.length; d++) {
    strong.push({ sym: 'S' + i, date: dates[d], cls: 'STRONG', fwd: r() < 0.70 ? 0.03 : -0.03 });
    caution.push({ sym: 'C' + i, date: dates[d], cls: 'CAUTION', fwd: r() < 0.50 ? 0.03 : -0.03 });
  }
  var rows = strong.concat(caution);
  var ciS = bbBootstrapCI_(rows, 'sym', 'STRONG', 'CAUTION', 400, bbRng_(7));
  var ciD = bbBootstrapCI_(rows, 'date', 'STRONG', 'CAUTION', 400, bbRng_(7));
  ok('stock-clustered CI produced', ciS && ciS.iters >= 100);
  ok('date-clustered CI produced', ciD && ciD.iters >= 100);
  ok('point estimate is positive and near +20pp', ciS.point > 0.10 && ciS.point < 0.30);
  ok('CI brackets the point estimate', ciS.lo <= ciS.point && ciS.point <= ciS.hi);
  ok('real separation → verdict PASS', bbVerdict_(ciS, ciD).pass === true);
  ok('date clusters counted correctly', ciD.clusters === 6);

  // null case: identical distributions → CI must include zero → FAIL
  var nul = [], r2 = mkRng(5);
  for (var k = 0; k < 40; k++) for (var e = 0; e < dates.length; e++) {
    nul.push({ sym: 'S' + k, date: dates[e], cls: 'STRONG', fwd: r2() < 0.55 ? 0.03 : -0.03 });
    nul.push({ sym: 'C' + k, date: dates[e], cls: 'CAUTION', fwd: r2() < 0.55 ? 0.03 : -0.03 });
  }
  var nS = bbBootstrapCI_(nul, 'sym', 'STRONG', 'CAUTION', 400, bbRng_(11));
  var nD = bbBootstrapCI_(nul, 'date', 'STRONG', 'CAUTION', 400, bbRng_(11));
  ok('no separation → CI includes zero', nS.lo <= 0 && nS.hi >= 0);
  ok('no separation → verdict FAILS (kill criterion)', bbVerdict_(nS, nD).pass === false);
  ok('  and says so explicitly', /KILL CRITERION/.test(bbVerdict_(nS, nD).text));

  // inverted case: CAUTION out-holds STRONG
  var inv = [], r3 = mkRng(21);
  for (var q = 0; q < 40; q++) for (var w = 0; w < dates.length; w++) {
    inv.push({ sym: 'S' + q, date: dates[w], cls: 'STRONG', fwd: r3() < 0.40 ? 0.03 : -0.03 });
    inv.push({ sym: 'C' + q, date: dates[w], cls: 'CAUTION', fwd: r3() < 0.70 ? 0.03 : -0.03 });
  }
  var iS = bbBootstrapCI_(inv, 'sym', 'STRONG', 'CAUTION', 400, bbRng_(13));
  var iD = bbBootstrapCI_(inv, 'date', 'STRONG', 'CAUTION', 400, bbRng_(13));
  ok('inverted classifier → negative point', iS.point < 0);
  ok('inverted classifier → verdict FAILS', bbVerdict_(iS, iD).pass === false);
})();

console.log('\n── reproducibility ──');
(function () {
  var rows = [], r = mkRng(3);
  for (var i = 0; i < 30; i++) for (var d = 0; d < 5; d++) {
    rows.push({ sym: 'S' + i, date: 'd' + d, cls: 'STRONG', fwd: r() < 0.6 ? 0.02 : -0.02 });
    rows.push({ sym: 'C' + i, date: 'd' + d, cls: 'CAUTION', fwd: r() < 0.45 ? 0.02 : -0.02 });
  }
  var a = bbBootstrapCI_(rows, 'sym', 'STRONG', 'CAUTION', 300, bbRng_(BBCFG.BOOT_SEED));
  var b = bbBootstrapCI_(rows, 'sym', 'STRONG', 'CAUTION', 300, bbRng_(BBCFG.BOOT_SEED));
  ok('same seed → identical interval', a.lo === b.lo && a.hi === b.hi && a.point === b.point);
  var c = bbBootstrapCI_(rows, 'sym', 'STRONG', 'CAUTION', 300, bbRng_(BBCFG.BOOT_SEED + 1));
  ok('different seed → interval still brackets the same point', c.point === a.point);
})();

console.log('\n── optimised bootstrap == naive bootstrap ──');
(function () {
  var rows = [], r = mkRng(77), dates = ['d1','d2','d3','d4','d5','d6','d7','d8'];
  for (var i = 0; i < 50; i++) for (var d = 0; d < dates.length; d++) {
    rows.push({ sym: 'S' + i, date: dates[d], cls: 'STRONG',  fwd: r() < 0.63 ? 0.02 : -0.02 });
    rows.push({ sym: 'S' + i, date: dates[d], cls: 'CAUTION', fwd: r() < 0.47 ? 0.02 : -0.02 });
    rows.push({ sym: 'S' + i, date: dates[d], cls: 'OFF',     fwd: r() < 0.55 ? 0.02 : -0.02 });
  }
  ['sym','date'].forEach(function (key) {
    var fast = bbBootstrapCI_(rows, key, 'STRONG', 'CAUTION', 500, bbRng_(1234));
    var slow = bbBootstrapCI_naive_(rows, key, 'STRONG', 'CAUTION', 500, bbRng_(1234));
    ok(key + '-clustered: identical point', fast.point === slow.point);
    ok(key + '-clustered: identical lo/hi', fast.lo === slow.lo && fast.hi === slow.hi);
    ok(key + '-clustered: identical cluster count', fast.clusters === slow.clusters);
  });
  var fb = bbBootstrapCI_(rows, 'date', 'STRONG', '*', 500, bbRng_(1234));
  var sb = bbBootstrapCI_naive_(rows, 'date', 'STRONG', '*', 500, bbRng_(1234));
  ok('benchmark "*" spread: identical interval', fb.lo === sb.lo && fb.hi === sb.hi && fb.point === sb.point);
  ok('  and the benchmark denominator includes OFF rows',
    Math.abs(fb.point - bbSpread_(rows,'STRONG','*')) < 1e-4);   // point is stored rounded to 4dp

  // scale sanity: the optimised path must be fast enough for GAS at real volume
  var big = [], r2 = mkRng(9);
  for (var s2 = 0; s2 < 799; s2++) for (var e2 = 0; e2 < 108; e2++)
    big.push({ sym: 'X' + s2, date: 'D' + e2, cls: (e2 % 3 === 0 ? 'STRONG' : e2 % 3 === 1 ? 'CAUTION' : 'OFF'), fwd: r2() < 0.55 ? 0.01 : -0.01 });
  var t0 = Date.now();
  var res = bbBootstrapCI_(big, 'sym', 'STRONG', 'CAUTION', 2000, bbRng_(5));
  var ms = Date.now() - t0;
  console.log('   (86k episodes, 2000 iters, 799 clusters → ' + ms + 'ms)');
  ok('full-scale bootstrap completes well inside the GAS budget', ms < 20000 && res != null);
})();

console.log('\n── v1.1: trigger buckets ──');
ok('below20 → PULLBACK', bbBucketOf_('below20') === 'C_PULLBACK');
ok('ext → EXTENDED', bbBucketOf_('ext') === 'C_EXTENDED');
ok('rsi80 → EXTENDED', bbBucketOf_('rsi80') === 'C_EXTENDED');
ok('div alone → DIVERGENCE', bbBucketOf_('div') === 'C_DIVERGENCE');
ok('breakdown takes precedence over extension', bbBucketOf_('ext,below20') === 'C_PULLBACK');
ok('multi-extension still EXTENDED', bbBucketOf_('div,ext,rsi80') === 'C_EXTENDED');
ok('empty why → no bucket', bbBucketOf_('') === '');
ok('buckets are mutually exclusive', ['below20','ext','rsi80','div'].map(bbBucketOf_).filter(function(v,i,a){return a.indexOf(v)!==i;}).length === 1);

console.log('\n── v1.1: classifier emits trigger codes matching bullPack_ reasons ──');
(function(){
  var mism = 0, checked = 0, cautions = 0;
  for (var seed = 1; seed <= 60; seed++) {
    var s = series(seed * 3301, 340, 0.0030, 0.030), cl = s.close, vol = s.volume;
    var e20 = ema(cl,20), e50 = ema(cl,50), e200 = ema(cl,200), rsiArr = rsiSeries(cl,14);
    var reg = adxRegimeFake(seed);
    var live = bullPack_(cl, e20, e50, e200, reg, null, macdPack(cl), rvol20(vol),
      obvPack(cl, vol).trend, rsiArr[cl.length-1], bearishDivergence(cl, rsiArr, 60));
    var idx = cl.length - 1, macdS = bbMacdSeries_(cl, ema), obv = bbObvSeries_(cl, vol);
    var bf = bbClassifyAt_(cl, e20, e50, e200, reg, bbMacdAt_(macdS.hist, idx), bbRvolAt_(vol, idx),
      bbObvTrendAt_(obv, idx), rsiArr[idx], bbDivergenceAt_(cl, rsiArr, idx, 60), idx);
    if (!live.on || !bf.on) continue;
    checked++;
    if (live.cls === 'CAUTION') cautions++;
    if (live.reasons.length !== bf.why.length) mism++;
  }
  console.log('   (' + checked + ' on-board, ' + cautions + ' CAUTION)');
  ok('trigger COUNT matches bullPack_ reasons in every case', mism === 0);
  ok('CAUTION branch was exercised', cautions >= 3);
})();

console.log('\n── v1.1: mean-difference bootstrap ──');
(function(){
  var rows = [], r = mkRng(31), dates = ['d1','d2','d3','d4','d5','d6'];
  // equal hold rates, but B has much fatter winners → mean differs, hold does not
  for (var i = 0; i < 50; i++) for (var d = 0; d < dates.length; d++) {
    rows.push({ sym:'A'+i, date:dates[d], cls:'A', fwd: r() < 0.55 ?  0.02 : -0.02 });
    rows.push({ sym:'B'+i, date:dates[d], cls:'B', fwd: r() < 0.55 ?  0.09 : -0.02 });
  }
  var h = bbBootstrapCI_(rows, 'date', 'A', 'B', 400, bbRng_(3), 'hold');
  var m = bbBootstrapCI_(rows, 'date', 'A', 'B', 400, bbRng_(3), 'mean');
  ok('hold spread ≈ 0 (identical win rates)', Math.abs(h.point) < 0.05);
  ok('mean spread is clearly negative (B wins bigger)', m.hi < 0);
  ok('metric is recorded on the result', h.metric === 'hold' && m.metric === 'mean');
  ok('mean point matches bbMeanSpread_', Math.abs(m.point - bbMeanSpread_(rows,'A','B')) < 1e-4);
  ok('THE v1.0 BLIND SPOT: hold-rate CI alone would have missed it', h.lo <= 0 && h.hi >= 0 && m.hi < 0);
})();

console.log('\n── v1.1: tagging + subsampling ──');
(function(){
  var rows = [
    { sym:'A', date:'d1', t:210, cls:'CAUTION', grade:'C', why:'ext',      fwd21: 0.05, fwd63: 0.10 },
    { sym:'A', date:'d2', t:231, cls:'CAUTION', grade:'C', why:'below20',  fwd21:-0.03, fwd63: null },
    { sym:'A', date:'d3', t:252, cls:'STRONG',  grade:'A', why:'',         fwd21: 0.01, fwd63: 0.02 },
    { sym:'A', date:'d4', t:273, cls:'OFF',     grade:'',  why:'',         fwd21: 0.02, fwd63: 0.03 }
  ];
  var tagged = bbTag_(rows, function(r){ return r.cls==='STRONG' ? 'STRONG' : (r.cls==='CAUTION' ? bbBucketOf_(r.why) : ''); }, 'fwd21');
  ok('OFF rows dropped by the tagger', tagged.length === 3);
  ok('CAUTION relabelled to its bucket', tagged.filter(function(x){return x.cls==='C_EXTENDED';}).length === 1);
  ok('pullback bucket separated', tagged.filter(function(x){return x.cls==='C_PULLBACK';}).length === 1);
  var t63 = bbTag_(rows, function(r){ return r.cls==='STRONG' ? 'S' : 'X'; }, 'fwd63');
  ok('rows with a null horizon are dropped', t63.length === 3);
  var sub = bbSubsample_(rows, 210, 63);
  ok('stride-63 subsample keeps every third bar (t=210, t=273)',
    sub.length === 2 && sub[0].t === 210 && sub[1].t === 273);
  ok('  and drops the overlapping ones (t=231, t=252)',
    sub.filter(function (x) { return x.t === 231 || x.t === 252; }).length === 0);
  ok('  spacing between kept bars equals the long horizon', (sub[1].t - sub[0].t) === 63);
})();

/* ── v1.2 helpers under test ── */
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
  var cut = Math.max(1, Math.floor(n * 0.1)), top = 0;
  for (var j = n - cut; j < n; j++) top += v[j];
  var med = bbQuantile_(v, 0.5);
  function mn(a) { if (!a.length) return null; var s2 = 0; for (var k = 0; k < a.length; k++) s2 += a[k]; return s2 / a.length; }
  return { n: n, hold: wins.length / n, mean: mean, median: med,
    p10: bbQuantile_(v, 0.10), p25: bbQuantile_(v, 0.25), p75: bbQuantile_(v, 0.75), p90: bbQuantile_(v, 0.90),
    meanWin: mn(wins), meanLoss: mn(losses), skew: mean - med, topDecileShare: sum !== 0 ? top / sum : null };
}
function bbBootstrapMedianCI_(rows, clusterKey, clsA, clsB, iters, rng) {
  iters = iters || 400;
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
      var k2 = keys[Math.floor(rng() * K)], ga = A[k2], gb = B[k2];
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

console.log('\n── v1.2: quantiles ──');
ok('median of odd list', bbQuantile_([1,2,3,4,5], 0.5) === 3);
ok('median of even list interpolates', bbQuantile_([1,2,3,4], 0.5) === 2.5);
ok('p0 = min, p1 = max', bbQuantile_([1,2,3,4], 0) === 1 && bbQuantile_([1,2,3,4], 1) === 4);
ok('empty → null', bbQuantile_([], 0.5) === null);

console.log('\n── v1.2: distribution shape separates breadth from skew ──');
(function () {
  // BROAD: every episode slightly positive
  var broad = []; for (var i = 0; i < 200; i++) broad.push({ f: 0.02 + (i % 5) * 0.001 });
  // LOTTERY: same mean, but 95% flat and 5% enormous
  var lott = [];
  for (var j = 0; j < 190; j++) lott.push({ f: 0.001 });
  for (var k = 0; k < 10; k++) lott.push({ f: 0.40 });
  var B = bbDist_(broad, 'f'), L = bbDist_(lott, 'f');
  ok('means are comparable by construction', Math.abs(B.mean - L.mean) < 0.005);
  ok('BROAD: median ≈ mean (skew ~0)', Math.abs(B.skew) < 0.002);
  ok('LOTTERY: median far below mean (right-skew)', L.skew > 0.015);
  ok('BROAD: top decile carries ~its share', B.topDecileShare > 0.09 && B.topDecileShare < 0.12);
  ok('LOTTERY: top decile carries almost everything', L.topDecileShare > 0.90);
  ok('THE DISCRIMINATOR: equal means, very different medians', B.median > L.median * 10);
  ok('quantiles ordered p10≤p25≤median≤p75≤p90',
    L.p10 <= L.p25 && L.p25 <= L.median && L.median <= L.p75 && L.p75 <= L.p90);
  ok('meanWin / meanLoss split', bbDist_([{f:0.1},{f:-0.2}], 'f').meanWin === 0.1 && bbDist_([{f:0.1},{f:-0.2}], 'f').meanLoss === -0.2);
  ok('null values excluded', bbDist_([{f:0.1},{f:null}], 'f').n === 1);
})();

console.log('\n── v1.2: median bootstrap detects a lottery profile ──');
(function () {
  var rows = [], r = mkRng(808), dates = ['d1','d2','d3','d4','d5','d6','d7','d8'];
  for (var i = 0; i < 60; i++) for (var d = 0; d < dates.length; d++) {
    // A: broadly better.  B: same-or-higher MEAN driven purely by rare huge winners
    rows.push({ sym:'A'+i, date:dates[d], cls:'A', fwd: 0.02 + (r() - 0.5) * 0.01 });
    rows.push({ sym:'B'+i, date:dates[d], cls:'B', fwd: (r() < 0.05) ? 0.60 : 0.001 });
  }
  var meanCI = bbBootstrapCI_(rows, 'date', 'A', 'B', 400, bbRng_(17), 'mean');
  var medCI  = bbBootstrapMedianCI_(rows, 'date', 'A', 'B', 300, bbRng_(17));
  ok('mean spread favours B (or is ambiguous)', meanCI.point < 0.01);
  ok('MEDIAN spread strongly favours A', medCI.point > 0.015 && medCI.lo > 0);
  ok('  → the two metrics disagree, which is the whole point',
    (meanCI.point < 0) !== (medCI.point < 0));
  ok('median CI brackets its point', medCI.lo <= medCI.point && medCI.point <= medCI.hi);
  ok('median metric labelled', medCI.metric === 'median');

  // control: when an edge IS broad, mean and median agree
  var broadRows = [], r2 = mkRng(99);
  for (var q = 0; q < 60; q++) for (var e = 0; e < dates.length; e++) {
    broadRows.push({ sym:'A'+q, date:dates[e], cls:'A', fwd: 0.03 + (r2() - 0.5) * 0.02 });
    broadRows.push({ sym:'B'+q, date:dates[e], cls:'B', fwd: 0.01 + (r2() - 0.5) * 0.02 });
  }
  var bm = bbBootstrapCI_(broadRows, 'date', 'A', 'B', 400, bbRng_(23), 'mean');
  var bd = bbBootstrapMedianCI_(broadRows, 'date', 'A', 'B', 300, bbRng_(23));
  ok('broad edge: mean and median agree in sign', (bm.point > 0) === (bd.point > 0));
  ok('broad edge: both intervals clear of zero', bm.lo > 0 && bd.lo > 0);
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
