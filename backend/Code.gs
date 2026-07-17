/**
 * ═══════════════════════════════════════════════════════════════════
 * NSE INDICATORS — fresh backend (v1.0, 16-Jul-2026)
 * Standalone Google Apps Script project. No dependency on the old
 * dashboard backend. Bound to its own spreadsheet (Scan + Portfolios).
 *
 * ROUTES (all GET, JSON):
 *   ?action=ping                       → health check
 *   ?action=ind&sym=HAL                → full per-stock indicator pack + series
 *   ?action=ind&syms=HAL,BEL,TCS       → scalar matrix (no series)
 *   ?action=radar                      → cached universe scan + scannedAt
 *   ?action=pf&sub=list                → portfolios
 *   ?action=pf&sub=save&name=X&syms=A,B→ create/update portfolio
 *   ?action=pf&sub=del&name=X          → delete portfolio
 *   ?action=universe                   → the embedded stock universe
 *
 * OPS:
 *   runScan()      — manual full-universe scan (seed / re-run)
 *   installTrigger() — daily 18:30 IST scan trigger (run ONCE)
 *
 * DESIGN FOR CAPACITY (no throttling, no cell-ceiling pressure):
 *   · Scan sheet stores ONE JSON cell per symbol (~438 rows total)
 *   · CacheService fronts Yahoo (25-min TTL) so repeat loads don't refetch
 *   · Universe fetched in chunked UrlFetchApp.fetchAll (40/batch)
 *   · No price history stored — series always fetched fresh (2y, adjusted)
 *
 * FALSE-SIGNAL DIRECTORY (reference PDF Part 4) — encoded as hazard flags:
 *   CHOP            ADX<20 → EMA-crossover entries blocked (grade capped C);
 *                   Supertrend & PSAR marked not-applicable
 *   COMPRESSED      50/200 gap tight + flat 200 slope → false-crossover zone
 *   MACD_NOISE      MACD signal-line cross without expanding histogram
 *   STOCH_TRAP      strong trend (ADX≥25) with stoch pinned >80/<20 →
 *                   ignore stochastic reversal reads
 *   DIVERGENCE      bearish RSI divergence during a golden approach → downgrade
 * ═══════════════════════════════════════════════════════════════════
 */

var CFG = {
  RANGE: '2y',
  CHUNK: 40,                 // symbols per fetchAll batch
  CACHE_SEC: 1500,           // 25 min per-symbol OHLCV cache
  SERIES_WINDOW: 220,        // bars returned to charts
  PRECROSS_LOOKBACK: 10,     // sessions for gap-slope regression
  HOT_DAYS: 15, WATCH_DAYS: 30,
  SCAN_SHEET: 'Scan', PF_SHEET: 'Portfolios',
  CALIB_SHEET: 'Calib', CALIB_RESULTS_SHEET: 'CalibResults', CALIB_MATURE_DAYS: 32,
  CALIB_BF_RANGE: '10y', CALIB_BF_BUDGET_MS: 270000,   // deep history + ~4.5-min wall budget per invocation
  CALIB_MAP_SHEET: 'CalibMap', CALIB_TRAIN_FRAC: 0.7,  // isotonic champion/challenger: time-split
  RESEXP_SHEET: 'ResExp'                                // resolution experiment log
};

/* ═══════════════ UNIVERSE (sym|name|sector|yfTicker) ═══════════════ */
function uniList_() {
  if (uniList_.c) return uniList_.c;
  uniList_.c = UNIVERSE.split('\n').map(function (r) {
    var p = r.split('|');
    return { sym: p[0], name: p[1], sector: p[2], yf: p[3] };
  });
  return uniList_.c;
}
function uniMap_() {
  if (uniMap_.c) return uniMap_.c;
  uniMap_.c = {};
  uniList_().forEach(function (u) { uniMap_.c[u.sym] = u; });
  return uniMap_.c;
}

/* ═══════════════ PURE MATH (Node-stub-tested; no GAS services) ═══════════════ */

function sma(a, n) {
  var out = new Array(a.length).fill(null), s = 0;
  for (var i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function ema(a, n) {
  var out = new Array(a.length).fill(null), k = 2 / (n + 1), prev = null, seed = 0;
  for (var i = 0; i < a.length; i++) {
    if (i < n - 1) { seed += a[i]; continue; }
    if (i === n - 1) { prev = (seed + a[i]) / n; out[i] = prev; continue; }
    prev = a[i] * k + prev * (1 - k); out[i] = prev;
  }
  return out;
}

/* Wilder RSI(14) */
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

/* RSI structural zone per playbook: bull regime rides 40–80, bear 20–60 */
function rsiZone(v) {
  if (v == null) return 'na';
  if (v >= 70) return 'overbought';
  if (v <= 30) return 'oversold';
  if (v >= 60) return 'bull-zone';
  if (v <= 40) return 'bear-zone';
  return 'neutral';
}

/* Classic bearish divergence: price higher swing-high, RSI lower high */
function bearishDivergence(close, rsi, lookback) {
  lookback = lookback || 60;
  var n = close.length, from = Math.max(2, n - lookback), peaks = [];
  for (var i = from; i < n - 1; i++) {
    if (close[i] > close[i - 1] && close[i] > close[i + 1] && rsi[i] != null) peaks.push(i);
  }
  if (peaks.length < 2) return false;
  var a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
  return close[b] > close[a] && rsi[b] < rsi[a];
}

/* Wilder ATR(14) on true range */
function atrSeries(hi, lo, cl, n) {
  n = n || 14;
  var out = new Array(cl.length).fill(null), prev = null;
  for (var i = 0; i < cl.length; i++) {
    var tr = i === 0 ? hi[i] - lo[i]
      : Math.max(hi[i] - lo[i], Math.abs(hi[i] - cl[i - 1]), Math.abs(lo[i] - cl[i - 1]));
    if (i < n) { prev = (prev === null ? 0 : prev) + tr; if (i === n - 1) { prev /= n; out[i] = prev; } continue; }
    prev = (prev * (n - 1) + tr) / n; out[i] = prev;
  }
  return out;
}

/* ADX(14) with +DI/−DI, Wilder smoothing */
function adxPack(hi, lo, cl, n) {
  n = n || 14;
  var len = cl.length, trS = 0, pS = 0, mS = 0, dxArr = [], adx = null, pdi = null, mdi = null;
  var trPrev = null, pPrev = null, mPrev = null;
  for (var i = 1; i < len; i++) {
    var up = hi[i] - hi[i - 1], dn = lo[i - 1] - lo[i];
    var pDM = (up > dn && up > 0) ? up : 0, mDM = (dn > up && dn > 0) ? dn : 0;
    var tr = Math.max(hi[i] - lo[i], Math.abs(hi[i] - cl[i - 1]), Math.abs(lo[i] - cl[i - 1]));
    if (i <= n) {
      trS += tr; pS += pDM; mS += mDM;
      if (i === n) { trPrev = trS; pPrev = pS; mPrev = mS; }
    } else {
      trPrev = trPrev - trPrev / n + tr;
      pPrev = pPrev - pPrev / n + pDM;
      mPrev = mPrev - mPrev / n + mDM;
    }
    if (i >= n && trPrev > 0) {
      pdi = 100 * pPrev / trPrev; mdi = 100 * mPrev / trPrev;
      var dx = (pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
      dxArr.push(dx);
      if (dxArr.length === n) adx = dxArr.reduce(function (a, b) { return a + b; }) / n;
      else if (dxArr.length > n) adx = (adx * (n - 1) + dx) / n;
    }
  }
  var regime = adx == null ? 'na' : adx < 20 ? 'chop' : adx < 25 ? 'weak' : adx < 50 ? 'trend' : 'strong';
  return { value: adx == null ? null : Math.round(adx * 10) / 10, plusDI: pdi == null ? null : Math.round(pdi * 10) / 10, minusDI: mdi == null ? null : Math.round(mdi * 10) / 10, regime: regime };
}

/* ADX value at every bar (nulls before warmup) — for historical regime lookup in backfill */
function adxSeries_(hi, lo, cl, n) {
  n = n || 14;
  var len = cl.length, out = new Array(len).fill(null), dxArr = [], adx = null;
  var trPrev = null, pPrev = null, mPrev = null, trS = 0, pS = 0, mS = 0;
  for (var i = 1; i < len; i++) {
    var up = hi[i] - hi[i - 1], dn = lo[i - 1] - lo[i];
    var pDM = (up > dn && up > 0) ? up : 0, mDM = (dn > up && dn > 0) ? dn : 0;
    var tr = Math.max(hi[i] - lo[i], Math.abs(hi[i] - cl[i - 1]), Math.abs(lo[i] - cl[i - 1]));
    if (i <= n) { trS += tr; pS += pDM; mS += mDM; if (i === n) { trPrev = trS; pPrev = pS; mPrev = mS; } }
    else { trPrev = trPrev - trPrev / n + tr; pPrev = pPrev - pPrev / n + pDM; mPrev = mPrev - mPrev / n + mDM; }
    if (i >= n && trPrev > 0) {
      var pdi = 100 * pPrev / trPrev, mdi = 100 * mPrev / trPrev;
      var dx = (pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
      dxArr.push(dx);
      if (dxArr.length === n) adx = dxArr.reduce(function (a, b) { return a + b; }) / n;
      else if (dxArr.length > n) adx = (adx * (n - 1) + dx) / n;
      out[i] = adx;
    }
  }
  return out;
}
function adxRegimeOf_(v) { return v == null ? 'na' : v < 20 ? 'chop' : v < 25 ? 'weak' : v < 50 ? 'trend' : 'strong'; }

/* Supertrend(10, 3×ATR) — returns final state + flip bars-ago */
function supertrend(hi, lo, cl, period, mult) {
  period = period || 10; mult = mult || 3;
  var atr = atrSeries(hi, lo, cl, period), n = cl.length;
  var upper = [], lower = [], dir = new Array(n).fill(null);
  var fu = null, fl = null, d = 1;
  for (var i = 0; i < n; i++) {
    if (atr[i] == null) { upper.push(null); lower.push(null); continue; }
    var mid = (hi[i] + lo[i]) / 2, bu = mid + mult * atr[i], bl = mid - mult * atr[i];
    fu = (fu === null || bu < fu || cl[i - 1] > fu) ? bu : fu;
    fl = (fl === null || bl > fl || cl[i - 1] < fl) ? bl : fl;
    if (d === 1 && cl[i] < fl) d = -1;
    else if (d === -1 && cl[i] > fu) d = 1;
    upper.push(fu); lower.push(fl); dir[i] = d;
  }
  var flip = null;
  for (var j = n - 1; j > 0; j--) { if (dir[j] != null && dir[j - 1] != null && dir[j] !== dir[j - 1]) { flip = n - 1 - j; break; } }
  return { state: dir[n - 1] === 1 ? 'buy' : dir[n - 1] === -1 ? 'sell' : 'na', flipBarsAgo: flip };
}

/* Parabolic SAR (0.02 step, 0.2 max) — final side only */
function psarSide(hi, lo) {
  var n = hi.length; if (n < 5) return 'na';
  var up = true, af = 0.02, maxAf = 0.2, sar = lo[0], ep = hi[0];
  for (var i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      if (lo[i] < sar) { up = false; sar = ep; ep = lo[i]; af = 0.02; }
      else if (hi[i] > ep) { ep = hi[i]; af = Math.min(maxAf, af + 0.02); }
    } else {
      if (hi[i] > sar) { up = true; sar = ep; ep = hi[i]; af = 0.02; }
      else if (lo[i] < ep) { ep = lo[i]; af = Math.min(maxAf, af + 0.02); }
    }
  }
  return up ? 'below' : 'above';   // dots below price = uptrend
}

/* MACD(12,26,9): line, signal, histogram + expanding check */
function macdPack(close) {
  var e12 = ema(close, 12), e26 = ema(close, 26), line = [], n = close.length;
  for (var i = 0; i < n; i++) line.push(e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  var first = line.findIndex(function (v) { return v != null; });
  var sig = new Array(n).fill(null);
  if (first >= 0) {
    var sub = ema(line.slice(first), 9);
    for (var j = 0; j < sub.length; j++) sig[first + j] = sub[j];
  }
  var hist = line.map(function (v, k) { return v != null && sig[k] != null ? v - sig[k] : null; });
  var h = hist.filter(function (v) { return v != null; });
  var expanding = h.length >= 3 && Math.abs(h[h.length - 1]) > Math.abs(h[h.length - 2]) && Math.abs(h[h.length - 2]) > Math.abs(h[h.length - 3]);
  var L = line[n - 1], S = sig[n - 1], H = hist[n - 1];
  return {
    line: L == null ? null : Math.round(L * 100) / 100,
    signal: S == null ? null : Math.round(S * 100) / 100,
    hist: H == null ? null : Math.round(H * 100) / 100,
    histDir: H == null ? 'na' : H > 0 ? 'bull' : 'bear',
    histExpanding: !!expanding,
    aboveZero: L != null && L > 0
  };
}

/* Stochastic(14,3) */
function stochPack(hi, lo, cl, n, d) {
  n = n || 14; d = d || 3;
  var len = cl.length, kArr = [];
  for (var i = 0; i < len; i++) {
    if (i < n - 1) { kArr.push(null); continue; }
    var hh = -Infinity, ll = Infinity;
    for (var j = i - n + 1; j <= i; j++) { if (hi[j] > hh) hh = hi[j]; if (lo[j] < ll) ll = lo[j]; }
    kArr.push(hh === ll ? 50 : 100 * (cl[i] - ll) / (hh - ll));
  }
  var kClean = kArr.filter(function (v) { return v != null; });
  var K = kClean[kClean.length - 1], D = null;
  if (kClean.length >= d) D = kClean.slice(-d).reduce(function (a, b) { return a + b; }) / d;
  var state = K == null ? 'na' : K > 80 ? 'overbought' : K < 20 ? 'oversold' : 'mid';
  return { k: K == null ? null : Math.round(K * 10) / 10, d: D == null ? null : Math.round(D * 10) / 10, state: state };
}

/* RMI — Relative Momentum Index: RSI computed on n-period momentum */
function rmiValue(close, n, m) {
  n = n || 14; m = m || 5;
  var mom = [];
  for (var i = m; i < close.length; i++) mom.push(close[i] - close[i - m]);
  var g = 0, l = 0, out = null;
  for (var k = 1; k < mom.length; k++) {
    var up = mom[k] > 0 ? mom[k] : 0, dn = mom[k] < 0 ? -mom[k] : 0;
    if (k <= n) { g += up; l += dn; if (k === n) { g /= n; l /= n; out = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out == null ? null : Math.round(out * 10) / 10;
}

/* OBV + trend over last 20 sessions */
function obvPack(close, vol) {
  var obv = [0];
  for (var i = 1; i < close.length; i++) {
    obv.push(obv[i - 1] + (close[i] > close[i - 1] ? vol[i] : close[i] < close[i - 1] ? -vol[i] : 0));
  }
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

function linSlope(a) {
  var n = a.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (var i = 0; i < n; i++) { sx += i; sy += a[i]; sxy += i * a[i]; sxx += i * i; }
  var d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

/* Last cross of fast over slow: {crossed, direction, barsAgo} */
function crossState(fast, slow) {
  var ps = null, idx = null, dir = null, n = fast.length;
  for (var k = 0; k < n; k++) {
    if (fast[k] == null || slow[k] == null) continue;
    var sg = Math.sign(fast[k] - slow[k]); if (sg === 0) continue;
    if (ps != null && sg !== ps) { idx = k; dir = sg > 0 ? 'bullish' : 'bearish'; }
    ps = sg;
  }
  return idx == null ? { crossed: false } : { crossed: true, direction: dir, barsAgo: n - 1 - idx, fresh: (n - 1 - idx) <= 5 };
}

/* EMA stack state */
function stackState(price, f, m, s) {
  if (f == null || m == null || s == null) return 'na';
  if (price > f && f > m && m > s) return 'bull';
  if (price < f && f < m && m < s) return 'bear';
  return 'tangled';
}

/* ═══ PRE-CROSS PROJECTION — the early-warning core ═══ */
function precross(fastArr, slowArr, price, lookback) {
  lookback = lookback || CFG.PRECROSS_LOOKBACK;
  var n = fastArr.length, gaps = [];
  for (var i = Math.max(0, n - lookback); i < n; i++) {
    if (fastArr[i] == null || slowArr[i] == null) return { heading: 'na' };
    gaps.push((fastArr[i] - slowArr[i]) / price * 100);
  }
  if (gaps.length < 3) return { heading: 'na' };
  var gap = gaps[gaps.length - 1], vel = linSlope(gaps); // % per session
  var converging = (gap > 0 && vel < 0) || (gap < 0 && vel > 0);
  var eta = converging && Math.abs(vel) > 1e-6 ? Math.abs(gap) / Math.abs(vel) : null;
  var heading = !converging ? 'none' : gap < 0 ? 'golden' : 'death';
  var band = eta == null ? 'none' : eta <= CFG.HOT_DAYS ? 'HOT' : eta <= CFG.WATCH_DAYS ? 'WATCH' : 'far';
  return {
    heading: heading,
    gapPct: Math.round(gap * 100) / 100,
    velPctPerDay: Math.round(vel * 1000) / 1000,
    etaDays: eta == null ? null : Math.round(eta),
    band: band
  };
}

/* ═══ HAZARDS (False-Signal Directory, PDF Part 4) + GRADE ═══ */
function hazardsAndGrade(pack) {
  var hz = [];
  var adx = pack.adx, pc = pack.precross, macd = pack.macd, stoch = pack.stoch;

  if (adx.regime === 'chop' || adx.regime === 'weak')
    hz.push({ code: 'CHOP', msg: 'ADX ' + adx.value + ' <25 — crossover entries blocked; Supertrend/PSAR unreliable here' });

  if (pc.gapPct != null && Math.abs(pc.gapPct) < 0.6 && Math.abs(pack.sma200SlopePct) < 0.02)
    hz.push({ code: 'COMPRESSED', msg: '50/200 compressed on a flat 200 — classic false-crossover zone' });

  if (macd.hist != null && !macd.histExpanding && pack.crossEma.crossed && pack.crossEma.fresh)
    hz.push({ code: 'MACD_NOISE', msg: 'fresh MA cross without expanding MACD histogram — unconfirmed' });

  if ((adx.regime === 'trend' || adx.regime === 'strong') && (stoch.state === 'overbought' || stoch.state === 'oversold'))
    hz.push({ code: 'STOCH_TRAP', msg: 'stoch pinned ' + stoch.state + ' in a strong trend — ignore reversal read' });

  if (pack.rsiDivergence && pc.heading === 'golden')
    hz.push({ code: 'DIVERGENCE', msg: 'bearish RSI divergence while approaching golden — momentum not confirming' });

  /* grade the approaching-cross setup */
  var grade = null;
  if (pc.heading === 'golden' || pc.heading === 'death') {
    var confirms = 0;
    if (macd.histExpanding && ((pc.heading === 'golden') === (macd.histDir === 'bull'))) confirms++;
    if (pack.rvol != null && pack.rvol >= 1.5) confirms++;
    if (pc.heading === 'golden' && (pack.rsiValue >= 40 && pack.rsiValue <= 80)) confirms++;
    if (pc.heading === 'death' && (pack.rsiValue >= 20 && pack.rsiValue <= 60)) confirms++;
    if (pack.obvTrend === (pc.heading === 'golden' ? 'rising' : 'falling')) confirms++;

    var chopBlocked = hz.some(function (h) { return h.code === 'CHOP' || h.code === 'COMPRESSED'; });
    var diverged = hz.some(function (h) { return h.code === 'DIVERGENCE'; });

    if (chopBlocked) grade = 'C';
    else if (diverged) grade = 'C';
    else if ((adx.regime === 'trend' || adx.regime === 'strong') && confirms >= 2) grade = 'A';
    else grade = 'B';
  }
  return { hazards: hz, grade: grade };
}

/* ═══════════════ SELL WATCH (v1.3 — additive, pure) ═══════════════
   Statistical exit signal. Conditional forward-return distribution vs
   the stock's own base rate; only positive lift is an edge. ADX-gated
   (valid only when mean-reverting). Entry price never referenced.
   v1.3 adds trust guards: effective-sample floor (overlapping windows
   collapse to few real episodes) and a bootstrap-agreement cap, so a
   thin or bootstrap-contradicted reading can't earn grade A/B.
   Bootstrap is seeded per-series → grades reproducible run-to-run.   */
var SELL = { H:21, N:100, BIN:0.5, MINBIN:40, TAIL:-0.05, BOOT_BLOCK:5, BOOT_ITERS:400, MIN_EFF_N:4, MAX_DIVERGE:0.15 };

function sellMean_(a){ var s=0; for(var i=0;i<a.length;i++) s+=a[i]; return s/a.length; }
function sellStd_(a){ var m=sellMean_(a),s=0; for(var i=0;i<a.length;i++){var d=a[i]-m; s+=d*d;} return Math.sqrt(s/a.length); }

/* z-score of ln(price) vs trailing N window ending at idx (inclusive) */
function sellExtZ_(close, N, idx){
  if (idx < N-1) return 0;
  var w=[]; for(var i=idx-N+1;i<=idx;i++) w.push(Math.log(close[i]));
  var sd=sellStd_(w); return sd>0 ? (Math.log(close[idx])-sellMean_(w))/sd : 0;
}

/* conditional forward-return distribution — deterministic */
function sellConditional_(close, H, N, bin, minBin, tailK){
  var n=close.length;
  if (n < N + H + 30) return null;               // too little history to be honest
  var zs=[], fs=[];
  for (var t=N-1; t<=n-1-H; t++){ zs.push(sellExtZ_(close,N,t)); fs.push(close[t+H]/close[t]-1); }
  var m=fs.length, baseFall=0; for(var i=0;i<m;i++) if(fs[i]<0) baseFall++; baseFall/=m;
  var zNow=sellExtZ_(close, N, n-1);
  var bw=bin, inBin=[];
  for (var pass=0; pass<8; pass++){
    inBin=[]; for(var j=0;j<m;j++) if(Math.abs(zs[j]-zNow)<=bw) inBin.push(fs[j]);
    if (inBin.length>=minBin) break; bw+=0.25;
  }
  var k=inBin.length, fall=0, tail=0;
  for(var j2=0;j2<k;j2++){ if(inBin[j2]<0) fall++; if(inBin[j2]<tailK) tail++; }
  var pFall = k? fall/k : baseFall, pTail = k? tail/k : null;
  var se = Math.sqrt(pFall*(1-pFall)/Math.max(k,1));
  return { z:Math.round(zNow*100)/100, baseRate:Math.round(baseFall*1000)/1000,
    pFall:Math.round(pFall*1000)/1000, lift:Math.round((pFall-baseFall)*1000)/1000,
    tail: pTail==null?null:Math.round(pTail*1000)/1000, n:k, bw:Math.round(bw*100)/100,
    se:Math.round(se*1000)/1000 };
}

/* deterministic seed from series tail + seeded LCG → reproducible bootstrap */
function sellSeed_(close){
  var s=0, start=Math.max(0, close.length-24);
  for (var i=start;i<close.length;i++){ s=(s*31 + Math.round(close[i]*100)) % 2147483647; }
  return (s+1) % 2147483647;
}
function sellRng_(seed){ var s=(seed||1)%4294967296; return function(){ s=(1664525*s+1013904223)%4294967296; return s/4294967296; }; }

/* moving-block bootstrap P(fall over H) */
function sellBootstrap_(close, H, block, iters, rng){
  rng = rng || Math.random;
  var r=[]; for(var i=1;i<close.length;i++) r.push(Math.log(close[i]/close[i-1]));
  if (r.length < block+1) return null;
  var below=0, maxStart=r.length-block;
  for (var it=0; it<iters; it++){
    var sum=0, filled=0;
    while (filled<H){ var start=Math.floor(rng()*maxStart);
      for (var j=0;j<block && filled<H;j++,filled++) sum+=r[start+j]; }
    if (sum<0) below++;
  }
  return Math.round(below/iters*1000)/1000;
}

/* assemble sell object + trust guards; grade never A/B when thin or bootstrap-divergent */
function sellPack_(close, adxRegime, precrossObj){
  var c = sellConditional_(close, SELL.H, SELL.N, SELL.BIN, SELL.MINBIN, SELL.TAIL);
  if (!c) return { ok:false };
  var meanRev = (adxRegime==='chop' || adxRegime==='weak');
  var gated = !meanRev;
  var deathEta = (precrossObj && precrossObj.heading==='death') ? precrossObj.etaDays : null;
  var boot = sellBootstrap_(close, SELL.H, SELL.BOOT_BLOCK, SELL.BOOT_ITERS, sellRng_(sellSeed_(close)));

  var effN = c.n / SELL.H;                                          // overlapping windows → real episodes
  var thin = effN < SELL.MIN_EFF_N;
  var divergent = (boot!=null) && Math.abs(c.pFall - boot) > SELL.MAX_DIVERGE;

  var g='';
  if (!gated && c.lift>0){
    if (thin || divergent) g='C';                                  // detected but low-trust → capped at C
    else if (c.lift>=0.15 && ((deathEta!=null && deathEta<=25) || (c.tail!=null && c.tail>=0.28))) g='A';
    else if (c.lift>=0.08) g='B'; else g='C';
  }
  return { ok:true, horizon:SELL.H, pFall:c.pFall, baseRate:c.baseRate, lift:c.lift, tail:c.tail,
    z:c.z, n:c.n, se:c.se, bootstrap:boot, effN:Math.round(effN*10)/10,
    thin:thin, divergent:divergent, trust:(thin||divergent)?'low':'ok',
    regime: meanRev?'MR':'TR', gated:gated, deathEta:deathEta, grade:g };
}

/* ─── calibration scoring math (pure; Node-tested) ─── */
function sellBrier_(pairs){                                         // pairs:[{p,y}], y∈{0,1}
  if(!pairs.length) return null;
  var s=0; for(var i=0;i<pairs.length;i++){ var d=pairs[i].p-pairs[i].y; s+=d*d; }
  return Math.round(s/pairs.length*10000)/10000;
}
function sellReliability_(pairs, bins){                             // predicted-vs-observed table
  bins=bins||10; var b=[]; for(var i=0;i<bins;i++) b.push({lo:i/bins,hi:(i+1)/bins,n:0,sp:0,sy:0});
  for(var j=0;j<pairs.length;j++){ var k=Math.min(bins-1,Math.floor(pairs[j].p*bins)); b[k].n++; b[k].sp+=pairs[j].p; b[k].sy+=pairs[j].y; }
  return b.map(function(x){ return { band:Math.round(x.lo*100)+'-'+Math.round(x.hi*100)+'%', n:x.n,
    predicted:x.n?Math.round(x.sp/x.n*1000)/1000:null, observed:x.n?Math.round(x.sy/x.n*1000)/1000:null }; });
}

/* ═══ FULL PER-STOCK COMPUTE (pure — takes OHLCV, returns pack) ═══ */
function computePack(bars, withSeries) {
  var cl = bars.close, hi = bars.high, lo = bars.low, vol = bars.volume, n = cl.length;
  if (n < 210) return { ok: false, error: 'insufficient history (' + n + ' bars, need 210+)' };

  var e20 = ema(cl, 20), e50 = ema(cl, 50), e200 = ema(cl, 200);
  var s50 = sma(cl, 50), s200 = sma(cl, 200), s20 = sma(cl, 20);
  var price = cl[n - 1];

  var rsiArr = rsiSeries(cl, 14), rsiV = rsiArr[n - 1];
  var adx = adxPack(hi, lo, cl, 14);
  var st = supertrend(hi, lo, cl, 10, 3);
  var sar = psarSide(hi, lo);
  var macd = macdPack(cl);
  var stoch = stochPack(hi, lo, cl, 14, 3);
  var rmi = rmiValue(cl, 14, 5);
  var ob = obvPack(cl, vol);
  var rv = rvol20(vol);

  var crossEma = crossState(e50, e200), crossSma = crossState(s50, s200);
  var pcEma = precross(e50, e200, price), pcSma = precross(s50, s200, price);

  /* flat-200 measure for COMPRESSED hazard: 10-session SMA200 slope as % of price */
  var s200w = s200.slice(-10).filter(function (v) { return v != null; });
  var sma200SlopePct = s200w.length >= 3 ? linSlope(s200w) / price * 100 : 0;

  var pack = {
    ok: true,
    price: Math.round(price * 100) / 100,          // last COMPLETED close — all indicators anchor here
    livePrice: bars.live ? Math.round(bars.live.price * 100) / 100 : null,
    intraday: !!bars.partialDropped,               // true = market open; today's partial bar excluded
    bars: n,
    adjusted: !!bars.adjusted,
    stack: stackState(price, e20[n - 1], e50[n - 1], e200[n - 1]),
    ema: { e20: r2(e20[n - 1]), e50: r2(e50[n - 1]), e200: r2(e200[n - 1]) },
    smaX: { s50: r2(s50[n - 1]), s200: r2(s200[n - 1]) },
    crossEma: crossEma, crossSma: crossSma,
    precross: pcEma, precrossSma: pcSma,
    adx: adx,
    rsiValue: rsiV == null ? null : Math.round(rsiV * 10) / 10,
    rsiZoneV: rsiZone(rsiV),
    rsiDivergence: bearishDivergence(cl, rsiArr, 60),
    macd: macd,
    stoch: stoch,
    stochApplicable: adx.regime === 'chop' || adx.regime === 'weak',
    rmi: rmi,
    supertrendV: st,
    trendToolsApplicable: adx.regime === 'trend' || adx.regime === 'strong',
    psar: sar,
    rvol: rv,
    obvTrend: ob.trend,
    sma200SlopePct: Math.round(sma200SlopePct * 1000) / 1000
  };

  var hg = hazardsAndGrade(pack);
  pack.hazards = hg.hazards;
  pack.grade = hg.grade;

  pack.sell = sellPack_(cl, adx.regime, pcEma);   // additive — statistical exit signal + trust guards
  if (pack.sell && pack.sell.ok) {                // apply the promoted calibration map, if any
    var _ch = loadChampionMap_();                 // cached per execution
    if (_ch) { pack.sell.pFallCal = isoApply_(_ch.map, pack.sell.pFall); pack.sell.calVer = _ch.version; }
  }

  if (withSeries) {
    var w = CFG.SERIES_WINDOW;
    pack.series = {
      close: tailArr(cl, w), volume: tailArr(vol, w),
      ema20: tailArr(e20, w), ema50: tailArr(e50, w), ema200: tailArr(e200, w),
      sma50: tailArr(s50, w), sma200: tailArr(s200, w),
      obv: tailArr(ob.obv, w)
    };
  }
  return pack;
}

/* scalar subset for matrix / radar rows */
function scalarRow(sym, pack, meta) {
  if (!pack.ok) return { sym: sym, ok: false, error: pack.error };
  return {
    sym: sym, name: meta ? meta.name : '', sector: meta ? meta.sector : '',
    ok: true, price: pack.price, livePrice: pack.livePrice, intraday: pack.intraday, stack: pack.stack,
    crossEma: pack.crossEma, crossSma: pack.crossSma,
    precross: pack.precross, adx: pack.adx.value, adxRegime: pack.adx.regime,
    rsi: pack.rsiValue, rsiZone: pack.rsiZoneV, divergence: pack.rsiDivergence,
    macdHist: pack.macd.hist, macdExpanding: pack.macd.histExpanding, macdAboveZero: pack.macd.aboveZero,
    supertrend: pack.supertrendV.state, psar: pack.psar,
    stochK: pack.stoch.k, stochState: pack.stoch.state,
    rmi: pack.rmi, rvol: pack.rvol, obvTrend: pack.obvTrend,
    hazards: pack.hazards.map(function (h) { return h.code; }),
    grade: pack.grade,
    sell: pack.sell
  };
}

function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function tailArr(a, n) { return a.length > n ? a.slice(a.length - n) : a; }

/* ═══════════════ YAHOO FETCH (GAS-only from here down) ═══════════════ */

function yahooUrl_(yf) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yf)
    + '?range=' + CFG.RANGE + '&interval=1d&events=split';
}
function fetchOpts_() {
  return {
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json'
    }
  };
}

/* Parse one Yahoo v8 payload → aligned OHLCV, split-adjusted throughout.
   H/L are scaled by adjclose/close so range indicators are split-safe. */
function parseYahoo_(json) {
  var res = json && json.chart && json.chart.result && json.chart.result[0];
  if (!res) return null;
  var q = res.indicators && res.indicators.quote && res.indicators.quote[0];
  if (!q || !q.close || !q.high || !q.low) return null;   // some ranges/symbols return meta-only (no bars)
  var adj = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  var ts = res.timestamp || [];
  var cl = [], hi = [], lo = [], vol = [], tArr = [], hasAdj = !!adj;
  for (var i = 0; i < q.close.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    var c = q.close[i], f = (hasAdj && adj[i] != null && c !== 0) ? adj[i] / c : 1;
    cl.push(c * f); hi.push(q.high[i] * f); lo.push(q.low[i] * f);
    vol.push(q.volume[i] == null ? 0 : q.volume[i]);
    tArr.push(ts[i] || null);
  }
  var bars = { close: cl, high: hi, low: lo, volume: vol, ts: tArr, adjusted: hasAdj };
  return trimPartialBar(bars, Date.now());
}

/* PURE: drop today's in-progress candle so indicators run on COMPLETED bars
   only ("confirm on close"). Live price preserved separately for display.
   A bar is partial iff its IST calendar day == today's AND now is before
   ~15:35 IST (NSE closes 15:30). IST = UTC+5:30, no DST. */
function trimPartialBar(bars, nowMs) {
  var n = bars.close.length;
  if (!n || !bars.ts || bars.ts[n - 1] == null) return bars;
  var IST_OFF = 19800; // seconds
  var lastDay = Math.floor((bars.ts[n - 1] + IST_OFF) / 86400);
  var nowSec = Math.floor(nowMs / 1000);
  var nowDay = Math.floor((nowSec + IST_OFF) / 86400);
  var nowMin = Math.floor(((nowSec + IST_OFF) % 86400) / 60); // minutes since IST midnight
  if (lastDay === nowDay && nowMin < 935) {                    // before 15:35 IST
    bars.live = { price: bars.close[n - 1], volumeSoFar: bars.volume[n - 1] };
    bars.close = bars.close.slice(0, n - 1);
    bars.high = bars.high.slice(0, n - 1);
    bars.low = bars.low.slice(0, n - 1);
    bars.volume = bars.volume.slice(0, n - 1);
    bars.ts = bars.ts.slice(0, n - 1);
    bars.partialDropped = true;
  }
  return bars;
}

function getBars_(sym) {
  var u = uniMap_()[sym];
  var yf = u ? u.yf : sym + '.NS';
  var cache = CacheService.getScriptCache();
  var key = 'b2:' + yf;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var resp = UrlFetchApp.fetch(yahooUrl_(yf), fetchOpts_());
  if (resp.getResponseCode() !== 200) return null;
  var bars = parseYahoo_(JSON.parse(resp.getContentText()));
  if (bars) { try { cache.put(key, JSON.stringify(bars), CFG.CACHE_SEC); } catch (e) { /* >100KB: skip cache */ } }
  return bars;
}

/* Parallel fetch for many symbols → {sym: bars} */
function getBarsMany_(syms) {
  var out = {}, need = [], map = uniMap_();
  var cache = CacheService.getScriptCache();
  syms.forEach(function (s) {
    var yf = map[s] ? map[s].yf : s + '.NS';
    var hit = cache.get('b2:' + yf);
    if (hit) out[s] = JSON.parse(hit); else need.push(s);
  });
  for (var i = 0; i < need.length; i += CFG.CHUNK) {
    var chunk = need.slice(i, i + CFG.CHUNK);
    var reqs = chunk.map(function (s) {
      var yf = map[s] ? map[s].yf : s + '.NS';
      var o = fetchOpts_(); o.url = yahooUrl_(yf); return o;
    });
    var resps = UrlFetchApp.fetchAll(reqs);
    for (var j = 0; j < resps.length; j++) {
      try {
        if (resps[j].getResponseCode() !== 200) continue;
        var bars = parseYahoo_(JSON.parse(resps[j].getContentText()));
        if (bars) {
          out[chunk[j]] = bars;
          var yf2 = map[chunk[j]] ? map[chunk[j]].yf : chunk[j] + '.NS';
          try { cache.put('b2:' + yf2, JSON.stringify(bars), CFG.CACHE_SEC); } catch (e) { }
        }
      } catch (e) { /* skip symbol */ }
    }
    if (i + CFG.CHUNK < need.length) Utilities.sleep(400);   // be polite, avoid burst throttling
  }
  return out;
}

/* ═══════════════ SHEET STORE ═══════════════ */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, headers) {
  var sh = ss_().getSheetByName(name);
  if (!sh) { sh = ss_().insertSheet(name); if (headers) sh.appendRow(headers); }
  return sh;
}

/* ═══════════════ SCAN (daily trigger + manual) ═══════════════ */
function runScan() {
  var t0 = Date.now();
  var uni = uniList_(), rows = [], syms = uni.map(function (u) { return u.sym; });
  var barsMap = getBarsMany_(syms);
  var calib = [], today = new Date().toISOString().slice(0, 10);
  uni.forEach(function (u) {
    var bars = barsMap[u.sym];
    var pack = bars ? computePack(bars, false) : { ok: false, error: 'fetch failed' };
    rows.push([u.sym, JSON.stringify(scalarRow(u.sym, pack, u))]);
    if (pack.ok && pack.sell && pack.sell.ok && !pack.sell.gated && pack.sell.lift > 0)
      calib.push([today, u.sym, pack.price, pack.sell.pFall, pack.sell.bootstrap, pack.sell.lift, pack.sell.grade, '', '']);
  });
  var sh = sheet_(CFG.SCAN_SHEET, null);
  sh.clear();
  sh.getRange(1, 1).setValue('scannedAt');
  sh.getRange(1, 2).setValue(new Date().toISOString());
  if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
  if (calib.length) logCalib_(calib, today);   // append-only, idempotent per day
  Logger.log('scan: ' + rows.length + ' symbols, ' + calib.length + ' sell predictions logged, in ' + Math.round((Date.now() - t0) / 1000) + 's');
}

/* ═══════════════ CALIBRATION ENGINE (additive) ═══════════════
   runScan logs each active sell prediction; runCalibScore matures
   them at H sessions, scores realized falls, and writes Brier +
   reliability. Its own champion — does NOT inherit steam's.        */
function logCalib_(rows, today) {
  var sh = sheet_(CFG.CALIB_SHEET, ['predDate', 'sym', 'price', 'pFall', 'boot', 'lift', 'grade', 'realizedFall', 'scoredAt']);
  var last = sh.getLastRow();
  if (last > 1) {
    var col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) if (String(col[i][0]).slice(0, 10) === today) return; // already logged today
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function runCalibScore() {
  var sh = sheet_(CFG.CALIB_SHEET, ['predDate', 'sym', 'price', 'pFall', 'boot', 'lift', 'grade', 'realizedFall', 'scoredAt']);
  var last = sh.getLastRow();
  if (last < 2) { Logger.log('calib: no predictions logged yet'); return; }
  var data = sh.getRange(2, 1, last - 1, 9).getValues();
  var cutoff = Date.now() - CFG.CALIB_MATURE_DAYS * 86400000, bySym = {};
  data.forEach(function (r, i) {
    if (r[7] !== '') return;                                  // already scored
    var pd = new Date(r[0]).getTime();
    if (isNaN(pd) || pd > cutoff) return;                     // not matured
    (bySym[r[1]] = bySym[r[1]] || []).push({ row: i + 2, predSec: Math.floor(pd / 1000) });
  });
  var scored = 0;
  Object.keys(bySym).forEach(function (sym) {
    var bars = getBars_(sym); if (!bars || !bars.ts) return;
    bySym[sym].forEach(function (p) {
      var idx = -1;
      for (var k = 0; k < bars.ts.length; k++) { if (bars.ts[k] != null && bars.ts[k] >= p.predSec) { idx = k; break; } }
      if (idx < 0) return;
      var fut = idx + SELL.H; if (fut >= bars.close.length) return;   // future bars not in yet
      sh.getRange(p.row, 8).setValue(bars.close[fut] < bars.close[idx] ? 1 : 0);
      sh.getRange(p.row, 9).setValue(new Date().toISOString());
      scored++;
    });
  });
  var all = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues();
  var pairs = all.filter(function (r) { return r[7] !== ''; }).map(function (r) { return { p: Number(r[3]), y: Number(r[7]) }; });
  if (!pairs.length) { Logger.log('calib: scored ' + scored + ' new; none mature enough to report'); return; }
  var brier = sellBrier_(pairs), rel = sellReliability_(pairs, 10);
  var rs = sheet_(CFG.CALIB_RESULTS_SHEET, ['scoredAt', 'nScored', 'brier', 'reliability']);
  rs.appendRow([new Date().toISOString(), pairs.length, brier, JSON.stringify(rel)]);
  Logger.log('calib: scored ' + scored + ' new; total ' + pairs.length + '; Brier ' + brier);
}

function installCalibTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runCalibScore') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runCalibScore').timeBased().atHour(19).nearMinute(0).everyDays(1).create();
  Logger.log('daily runCalibScore trigger installed (~19:00)');
}

function installChampionTrigger() {   // weekly auto-refit; safe — promotion gated by holdout Brier
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runCalibChampion') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runCalibChampion').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(9).create();
  Logger.log('weekly runCalibChampion trigger installed (Sat ~09:00)');
}

/* ═══════════════ CALIBRATION BACKFILL (Phase 1 — additive) ═══════════════
   Walk the universe over deep history and score the sell signal
   retrospectively, so the reliability curve has thousands of episodes
   TODAY instead of after a month of live logging. Purged-embargo:
   each prediction's own outcome window (±H) is excluded from the
   distribution it is scored against, so the label can't leak in.
   Episodes are sampled non-overlapping (stride H) → independent.
   Only the shown population is logged: mean-reverting (ADX<25) with
   positive lift. Rows are written pre-scored (realizedFall filled),
   so a subsequent runCalibScore() folds them into the report.
   Chunked + resumable: run repeatedly (or on a trigger) until done. */

function getBarsDeep_(sym, range) {
  var u = uniMap_()[sym], yf = u ? u.yf : sym + '.NS';
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yf)
    + '?range=' + (range || CFG.CALIB_BF_RANGE) + '&interval=1d&events=split';
  var resp = UrlFetchApp.fetch(url, fetchOpts_());
  if (resp.getResponseCode() !== 200) return null;
  return parseYahoo_(JSON.parse(resp.getContentText()));   // not cached (deep payloads exceed the cache cap)
}

/* purged-embargo conditional at prediction position p (index into Z/F arrays).
   Z,F are aligned over valid prediction indices; IDX holds their bar positions. */
function sellPurged_(Z, F, IDX, p, H, bin, minBin, tailK) {
  var m = Z.length, zNow = Z[p];
  var baseN = 0, baseFall = 0;
  for (var i = 0; i < m; i++) { if (Math.abs(IDX[i] - IDX[p]) <= H) continue; baseN++; if (F[i] < 0) baseFall++; }
  if (!baseN) return null;
  baseFall /= baseN;
  var bw = bin, inBin;
  for (var pass = 0; pass < 8; pass++) {
    inBin = [];
    for (var j = 0; j < m; j++) { if (Math.abs(IDX[j] - IDX[p]) <= H) continue; if (Math.abs(Z[j] - zNow) <= bw) inBin.push(F[j]); }
    if (inBin.length >= minBin) break; bw += 0.25;
  }
  var k = inBin.length, fall = 0, tail = 0;
  for (var q = 0; q < k; q++) { if (inBin[q] < 0) fall++; if (inBin[q] < tailK) tail++; }
  var pFall = k ? fall / k : baseFall;
  return { pFall: Math.round(pFall * 1000) / 1000, lift: Math.round((pFall - baseFall) * 1000) / 1000,
    tail: k ? Math.round(tail / k * 1000) / 1000 : null, n: k };
}

function runCalibBackfill() {
  var t0 = Date.now();
  var props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('calib_bf_idx') || '0', 10);
  var sh = sheet_(CFG.CALIB_SHEET, ['predDate', 'sym', 'price', 'pFall', 'boot', 'lift', 'grade', 'realizedFall', 'scoredAt']);
  var batch = [], done = start, logged = 0, skipped = 0, scoredAt = new Date().toISOString();
  for (var s = start; s < uni.length; s++) {
    if (Date.now() - t0 > CFG.CALIB_BF_BUDGET_MS) break;      // stop before the 6-min GAS ceiling
    done = s + 1;
    try {
      var u = uni[s], bars = getBarsDeep_(u.sym);
      if (!bars || !bars.close || bars.close.length < SELL.N + SELL.H + 60) { skipped++; continue; }
      var cl = bars.close, hi = bars.high, lo = bars.low, ts = bars.ts, n = cl.length;
      var adxS = adxSeries_(hi, lo, cl, 14);
      var Z = [], F = [], IDX = [];
      for (var t = SELL.N - 1; t <= n - 1 - SELL.H; t++) { Z.push(sellExtZ_(cl, SELL.N, t)); F.push(cl[t + SELL.H] / cl[t] - 1); IDX.push(t); }
      for (var p = 0; p < Z.length; p += SELL.H) {            // non-overlapping episodes → independent
        var bi = IDX[p], reg = adxRegimeOf_(adxS[bi]);
        if (reg !== 'chop' && reg !== 'weak') continue;       // only the shown (mean-reverting) population
        var c = sellPurged_(Z, F, IDX, p, SELL.H, SELL.BIN, SELL.MINBIN, SELL.TAIL);
        if (!c || c.lift <= 0) continue;                      // only active sell calls
        var realized = F[p] < 0 ? 1 : 0;
        var pd = ts[bi] ? new Date(ts[bi] * 1000).toISOString().slice(0, 10) : '';
        batch.push([pd, u.sym, Math.round(cl[bi] * 100) / 100, c.pFall, '', c.lift, 'bf', realized, scoredAt]);
        logged++;
      }
      if (batch.length >= 2000) { sh.getRange(sh.getLastRow() + 1, 1, batch.length, 9).setValues(batch); batch = []; }
    } catch (err) { skipped++; }                              // one bad symbol never aborts the batch
  }
  if (batch.length) sh.getRange(sh.getLastRow() + 1, 1, batch.length, 9).setValues(batch);
  var finished = done >= uni.length;
  props.setProperty('calib_bf_idx', finished ? '0' : String(done));
  Logger.log('backfill: stocks ' + start + '→' + done + '/' + uni.length + ', ' + logged + ' episodes logged, ' + skipped + ' symbols skipped, ' +
    Math.round((Date.now() - t0) / 1000) + 's. ' + (finished ? 'DONE — now run runCalibScore().' : 'Not finished — run runCalibBackfill() again to resume.'));
}

function resetCalibBackfill() {
  PropertiesService.getScriptProperties().deleteProperty('calib_bf_idx');
  var sh = ss_().getSheetByName(CFG.CALIB_SHEET);
  if (sh) { var last = sh.getLastRow(); if (last > 1) {
    var g = sh.getRange(2, 7, last - 1, 1).getValues();       // drop only 'bf' (backfilled) rows, keep live log
    for (var i = g.length - 1; i >= 0; i--) if (g[i][0] === 'bf') sh.deleteRow(i + 2);
  } }
  Logger.log('backfill progress + backfilled rows cleared (live predictions kept)');
}

/* ═══════════════ ISOTONIC RECALIBRATION + CHAMPION/CHALLENGER (Phase 3) ═══════════════
   Fit a monotone map raw P(fall) → true frequency via pool-adjacent-violators,
   so the displayed probability equals the observed rate. A challenger is fit on
   the older slice and only PROMOTED if it beats the incumbent on a time-separated
   holdout — never in-sample. The live signal applies the champion map to pFall. */

function isoFit_(pairs) {                                   // pairs:[{p,y}] → monotone map [{x,y}]
  var pts = pairs.slice().sort(function (a, b) { return a.p - b.p; });
  if (!pts.length) return [];
  var bl = pts.map(function (pt) { return { xl: pt.p, xr: pt.p, w: 1, y: pt.y }; });
  var i = 0;
  while (i < bl.length - 1) {
    if (bl[i].y > bl[i + 1].y + 1e-12) {                    // PAV: pool the violating adjacent blocks
      var w = bl[i].w + bl[i + 1].w, y = (bl[i].y * bl[i].w + bl[i + 1].y * bl[i + 1].w) / w;
      bl.splice(i, 2, { xl: bl[i].xl, xr: bl[i + 1].xr, w: w, y: y });
      if (i > 0) i--;
    } else i++;
  }
  var map = [{ x: Math.round(bl[0].xl * 1000) / 1000, y: Math.round(bl[0].y * 10000) / 10000 }];
  bl.forEach(function (b) {
    var x = Math.round(b.xr * 1000) / 1000, yv = Math.round(b.y * 10000) / 10000;
    if (x > map[map.length - 1].x) map.push({ x: x, y: yv });
    else map[map.length - 1].y = yv;
  });
  return map;
}

function isoApply_(map, p) {                                // interpolate calibrated probability
  if (!map || !map.length) return p;
  if (p <= map[0].x) return map[0].y;
  if (p >= map[map.length - 1].x) return map[map.length - 1].y;
  for (var i = 1; i < map.length; i++) {
    if (p <= map[i].x) {
      var x0 = map[i - 1].x, x1 = map[i].x, y0 = map[i - 1].y, y1 = map[i].y, t = (x1 - x0) ? (p - x0) / (x1 - x0) : 0;
      return Math.round((y0 + t * (y1 - y0)) * 1000) / 1000;
    }
  }
  return map[map.length - 1].y;
}

function brierPairs_(pairs, map) {                          // Brier under raw (map=null) or a calibration map
  if (!pairs.length) return null;
  var s = 0;
  for (var i = 0; i < pairs.length; i++) { var pr = map ? isoApply_(map, pairs[i].p) : pairs[i].p, d = pr - pairs[i].y; s += d * d; }
  return Math.round(s / pairs.length * 100000) / 100000;
}

var _champCache;                                           // undefined = not loaded; null = none; object = champion
function loadChampionMap_() {
  if (_champCache !== undefined) return _champCache;
  var ms = ss_().getSheetByName(CFG.CALIB_MAP_SHEET), champ = null;
  if (ms && ms.getLastRow() > 1) {
    var d = ms.getRange(2, 1, ms.getLastRow() - 1, 9).getValues();
    for (var i = d.length - 1; i >= 0; i--) {
      if (d[i][7] === true || String(d[i][7]).toUpperCase() === 'TRUE') { champ = { version: d[i][0], map: JSON.parse(d[i][8]), holdBrier: d[i][6] }; break; }
    }
  }
  _champCache = champ;
  return champ;
}

function runCalibChampion() {
  var sh = ss_().getSheetByName(CFG.CALIB_SHEET);
  if (!sh || sh.getLastRow() < 51) { Logger.log('champion: need ≥50 scored pairs'); return { ok:false, error:'need ≥50 scored pairs' }; }
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues();
  var rows = [];
  data.forEach(function (r) {
    if (r[7] === '' || r[3] === '') return;
    var p = Number(r[3]), y = Number(r[7]); if (isNaN(p) || isNaN(y)) return;
    rows.push({ date: String(r[0]), p: p, y: y });
  });
  if (rows.length < 50) { Logger.log('champion: <50 usable pairs'); return { ok:false, error:'<50 usable pairs' }; }
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });   // time order
  var cut = Math.floor(rows.length * CFG.CALIB_TRAIN_FRAC), train = rows.slice(0, cut), hold = rows.slice(cut);
  var challenger = isoFit_(train);
  var bRaw = brierPairs_(hold, null), bCha = brierPairs_(hold, challenger);
  var champ = loadChampionMap_(), bChamp = champ ? brierPairs_(hold, champ.map) : null;
  var beat = (bChamp == null) ? (bCha < bRaw - 1e-6) : (bCha < bChamp - 1e-6);
  var ver = (champ ? champ.version : 0) + (beat ? 1 : 0);
  var ms = sheet_(CFG.CALIB_MAP_SHEET, ['version', 'fittedAt', 'nTrain', 'nHold', 'brierRaw', 'brierChampion', 'brierChallenger', 'promoted', 'map']);
  ms.appendRow([beat ? ver : (champ ? champ.version : 0), new Date().toISOString(), train.length, hold.length,
    bRaw, bChamp == null ? '' : bChamp, bCha, beat, JSON.stringify(beat ? challenger : (champ ? champ.map : challenger))]);
  _champCache = undefined;                                  // force reload
  var summary = { ok: true, promoted: beat, version: beat ? ver : (champ ? champ.version : 0),
    nTrain: train.length, nHold: hold.length, brierRaw: bRaw,
    brierChampion: bChamp, brierChallenger: bCha };
  Logger.log('champion: holdout Brier — raw ' + bRaw + ' | champ ' + (bChamp == null ? '—' : bChamp) + ' | challenger ' + bCha +
    ' → ' + (beat ? 'PROMOTED v' + ver + ' (' + challenger.length + ' pts)' : 'kept incumbent'));
  return summary;
}

/* ═══════════════ RESOLUTION EXPERIMENT (Phase B) ═══════════════
   Does a second feature separate outcomes WITHIN the actionable high-pFall
   tail, beyond raw overextension? Logs per-episode candidate features over
   deep history; resolutionReport() measures the tail-sharpening each adds.
   Chunked + resumable, same as backfill. */

function runResolutionExperiment() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('resexp_idx') || '0', 10);
  var sh = sheet_(CFG.RESEXP_SHEET, ['sym', 'realizedFall', 'pFall', 'emaGapPct', 'rsi']);
  var batch = [], done = start, logged = 0, skipped = 0;
  for (var s = start; s < uni.length; s++) {
    if (Date.now() - t0 > CFG.CALIB_BF_BUDGET_MS) break;
    done = s + 1;
    try {
      var u = uni[s], bars = getBarsDeep_(u.sym);
      if (!bars || !bars.close || bars.close.length < SELL.N + SELL.H + 60) { skipped++; continue; }
      var cl = bars.close, hi = bars.high, lo = bars.low, n = cl.length;
      var adxS = adxSeries_(hi, lo, cl, 14), e50 = ema(cl, 50), e200 = ema(cl, 200), rsiA = rsiSeries(cl, 14);
      var Z = [], F = [], IDX = [];
      for (var t = SELL.N - 1; t <= n - 1 - SELL.H; t++) { Z.push(sellExtZ_(cl, SELL.N, t)); F.push(cl[t + SELL.H] / cl[t] - 1); IDX.push(t); }
      for (var p = 0; p < Z.length; p += SELL.H) {
        var bi = IDX[p], reg = adxRegimeOf_(adxS[bi]);
        if (reg !== 'chop' && reg !== 'weak') continue;
        var c = sellPurged_(Z, F, IDX, p, SELL.H, SELL.BIN, SELL.MINBIN, SELL.TAIL);
        if (!c || c.lift <= 0) continue;
        if (e50[bi] == null || e200[bi] == null || e200[bi] === 0 || rsiA[bi] == null) continue;
        var gap = Math.round((e50[bi] - e200[bi]) / e200[bi] * 10000) / 10000;
        batch.push([u.sym, F[p] < 0 ? 1 : 0, c.pFall, gap, Math.round(rsiA[bi] * 10) / 10]);
        logged++;
      }
      if (batch.length >= 2000) { sh.getRange(sh.getLastRow() + 1, 1, batch.length, 5).setValues(batch); batch = []; }
    } catch (err) { skipped++; }
  }
  if (batch.length) sh.getRange(sh.getLastRow() + 1, 1, batch.length, 5).setValues(batch);
  var finished = done >= uni.length;
  props.setProperty('resexp_idx', finished ? '0' : String(done));
  Logger.log('resexp: stocks ' + start + '→' + done + '/' + uni.length + ', ' + logged + ' episodes, ' + skipped + ' skipped, ' +
    Math.round((Date.now() - t0) / 1000) + 's. ' + (finished ? 'DONE — now run resolutionReport().' : 'Not finished — run runResolutionExperiment() again.'));
}

function resolutionTable_(rows) {                           // pure — the experiment's analysis
  if (rows.length < 30) return null;
  function rate(rs) { if (!rs.length) return null; var f = 0; for (var i = 0; i < rs.length; i++) f += rs[i].y; return Math.round(f / rs.length * 1000) / 1000; }
  function split3(arr, key) {                              // bottom third / top third by RANK (tie-safe)
    var s = arr.slice().sort(function (a, b) { return a[key] - b[key]; }), t = Math.floor(s.length / 3);
    return { lo: s.slice(0, t), hi: s.slice(s.length - t) };
  }
  var base = rate(rows), ps = split3(rows, 'p'), top = ps.hi, bot = ps.lo;
  var out = { n: rows.length, baseRate: base, pFall: { bottom: rate(bot), top: rate(top), spread: Math.round((rate(top) - rate(bot)) * 1000) / 1000 }, features: {} };
  ['gap', 'rsi'].forEach(function (f) {
    var solo = split3(rows, f), tail = split3(top, f);
    var rHi = rate(solo.hi), rLo = rate(solo.lo), rtHi = rate(tail.hi), rtLo = rate(tail.lo);
    out.features[f] = { soloLo: rLo, soloHi: rHi, soloSpread: (rHi != null && rLo != null) ? Math.round((rHi - rLo) * 1000) / 1000 : null,
      inTopLo: rtLo, inTopHi: rtHi, tailSharpen: (rtHi != null && rtLo != null) ? Math.round((rtHi - rtLo) * 1000) / 1000 : null };
  });
  return out;
}

function resolutionReport() {
  var sh = ss_().getSheetByName(CFG.RESEXP_SHEET);
  if (!sh || sh.getLastRow() < 31) { Logger.log('resexp: not enough rows — run runResolutionExperiment() first'); return; }
  var d = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues(), rows = [];
  d.forEach(function (r) { rows.push({ y: Number(r[1]), p: Number(r[2]), gap: Number(r[3]), rsi: Number(r[4]) }); });
  var tbl = resolutionTable_(rows);
  var rs = sheet_(CFG.RESEXP_SHEET + 'Results', ['at', 'result']);
  rs.appendRow([new Date().toISOString(), JSON.stringify(tbl)]);
  Logger.log('resexp report: ' + JSON.stringify(tbl));
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runScan') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runScan').timeBased().atHour(18).nearMinute(30).everyDays(1).create();
  Logger.log('daily runScan trigger installed (~18:30 script-timezone — set project timezone to Asia/Kolkata)');
}

/* ═══════════════ ROUTES ═══════════════ */
function doGet(e) {
  var a = (e.parameter.action || '').toLowerCase();
  var out;
  try {
    if (a === 'ping') out = { ok: true, v: '1.5', now: new Date().toISOString() };
    else if (a === 'universe') out = { ok: true, universe: uniList_() };
    else if (a === 'ind') out = routeInd_(e);
    else if (a === 'radar') out = routeRadar_();
    else if (a === 'pf') out = routePf_(e);
    else if (a === 'calib') out = routeCalib_();
    else if (a === 'resexp') out = routeResexp_();
    else if (a === 'calibfit') out = runCalibChampion();   // push-to-recalibrate; safe — promotion holdout-gated
    else out = { ok: false, error: 'unknown action' };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function routeCalib_() {
  var champ = loadChampionMap_();
  var champObj = champ ? { version: champ.version, holdoutBrier: champ.holdBrier, points: champ.map.length, map: champ.map } : null;
  var rs = ss_().getSheetByName(CFG.CALIB_RESULTS_SHEET);
  if (!rs || rs.getLastRow() < 2)
    return { ok: true, ready: false, champion: champObj, msg: 'no calibration results yet — run runCalibScore()' };
  var r = rs.getRange(rs.getLastRow(), 1, 1, 4).getValues()[0];
  return { ok: true, ready: true, scoredAt: String(r[0]), nScored: r[1], brier: r[2], reliability: JSON.parse(r[3]), champion: champObj };
}

function routeResexp_() {
  var rs = ss_().getSheetByName(CFG.RESEXP_SHEET + 'Results');
  if (!rs || rs.getLastRow() < 2) return { ok: true, ready: false, msg: 'no resolution report yet — run runResolutionExperiment() then resolutionReport()' };
  var r = rs.getRange(rs.getLastRow(), 1, 1, 2).getValues()[0];
  return { ok: true, ready: true, at: String(r[0]), result: JSON.parse(r[1]) };
}

function routeInd_(e) {
  if (e.parameter.sym) {
    var sym = e.parameter.sym.toUpperCase().replace(/\.NS$/, '');
    var bars = getBars_(sym);
    if (!bars) return { ok: false, error: 'fetch failed for ' + sym };
    var pack = computePack(bars, true);
    pack.sym = sym;
    var meta = uniMap_()[sym];
    if (meta) { pack.name = meta.name; pack.sector = meta.sector; }
    return pack;
  }
  if (e.parameter.syms) {
    var syms = e.parameter.syms.toUpperCase().split(',').map(function (s) { return s.trim().replace(/\.NS$/, ''); }).filter(Boolean).slice(0, 60);
    var barsMap = getBarsMany_(syms), rows = [], map = uniMap_();
    syms.forEach(function (s) {
      var b = barsMap[s];
      rows.push(b ? scalarRow(s, computePack(b, false), map[s]) : { sym: s, ok: false, error: 'fetch failed' });
    });
    return { ok: true, rows: rows, at: new Date().toISOString() };
  }
  return { ok: false, error: 'sym or syms required' };
}

function routeRadar_() {
  var sh = ss_().getSheetByName(CFG.SCAN_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'no scan yet — run runScan once', state: 'UNAVAILABLE' };
  var scannedAt = sh.getRange(1, 2).getValue();
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  var rows = data.map(function (r) { try { return JSON.parse(r[1]); } catch (e) { return null; } }).filter(Boolean);
  return { ok: true, scannedAt: scannedAt instanceof Date ? scannedAt.toISOString() : String(scannedAt), rows: rows };
}

function routePf_(e) {
  var sub = (e.parameter.sub || 'list').toLowerCase();
  var sh = sheet_(CFG.PF_SHEET, ['name', 'symbols', 'updatedAt']);
  var last = sh.getLastRow();
  var data = last > 1 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];
  if (sub === 'list') {
    return { ok: true, portfolios: data.map(function (r) { return { name: r[0], symbols: String(r[1]).split(',').filter(Boolean), updatedAt: r[2] }; }) };
  }
  var name = (e.parameter.name || '').trim();
  if (!name) return { ok: false, error: 'name required' };
  var rowIdx = -1;
  for (var i = 0; i < data.length; i++) if (data[i][0] === name) { rowIdx = i + 2; break; }
  if (sub === 'save') {
    var syms = (e.parameter.syms || '').toUpperCase().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!syms.length) return { ok: false, error: 'syms required' };
    var row = [name, syms.join(','), new Date().toISOString()];
    if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, 3).setValues([row]); else sh.appendRow(row);
    return { ok: true, saved: name, count: syms.length };
  }
  if (sub === 'del') {
    if (rowIdx > 0) { sh.deleteRow(rowIdx); return { ok: true, deleted: name }; }
    return { ok: false, error: 'not found' };
  }
  return { ok: false, error: 'unknown sub' };
}

/* run wrappers (functions ending _ are hidden from the Run dropdown) */
function runPing() { Logger.log(JSON.stringify(doGet({ parameter: { action: 'ping' } }).getContent())); }
function runIndHAL() { Logger.log(doGet({ parameter: { action: 'ind', sym: 'HAL' } }).getContent().slice(0, 800)); }

/* ═══════════════ UNIVERSE DATA (438 stocks: sym|name|sector|yf) ═══════════════ */
var UNIVERSE =
'AARTIIND|Aarti Industries|Chemicals|AARTIIND.NS\n' +
'ABB|ABB India|Industrial|ABB.NS\n' +
'ABBOTINDIA|Abbott India|Pharma|ABBOTINDIA.NS\n' +
'ABCAPITAL|Aditya Birla Capital|Financial Services|ABCAPITAL.NS\n' +
'ABFRL|Aditya Birla Fashion|Retail|ABFRL.NS\n' +
'ADANIENT|Adani Enterprises|Conglomerate|ADANIENT.NS\n' +
'ADANIGREEN|Adani Green Energy|Renewable Energy|ADANIGREEN.NS\n' +
'ADANIPORTS|Adani Ports & SEZ|Infrastructure|ADANIPORTS.NS\n' +
'ADANIPOWER|Adani Power|Power|ADANIPOWER.NS\n' +
'AIAENG|AIA Engineering|Industrial|AIAENG.NS\n' +
'AJANTPHARM|Ajanta Pharma|Pharma|AJANTPHARM.NS\n' +
'ALKEM|Alkem Laboratories|Pharma|ALKEM.NS\n' +
'AMBUJACEM|Ambuja Cements|Cement|AMBUJACEM.NS\n' +
'ANANTRAJ|Anant Raj|Realty|ANANTRAJ.NS\n' +
'ANGELONE|Angel One|Financial Services|ANGELONE.NS\n' +
'APLAPOLLO|APL Apollo Tubes|Metal|APLAPOLLO.NS\n' +
'APOLLOHOSP|Apollo Hospitals|Healthcare|APOLLOHOSP.NS\n' +
'APOLLOMIC|Apollo Micro Systems|Defence|APOLLOMIC.NS\n' +
'APOLLOTYRE|Apollo Tyres|Auto Ancillary|APOLLOTYRE.NS\n' +
'APTUS|Aptus Value Housing|NBFC|APTUS.NS\n' +
'ASHOKLEY|Ashok Leyland|Auto|ASHOKLEY.NS\n' +
'ASIANPAINT|Asian Paints|Consumer|ASIANPAINT.NS\n' +
'ASTRAMICRO|Astra Microwave Products|Defence|ASTRAMICRO.NS\n' +
'ASTRAL|Astral|Plastics|ASTRAL.NS\n' +
'ATGL|Adani Total Gas|Gas Distribution|ATGL.NS\n' +
'AUBANK|AU Small Finance Bank|Banking|AUBANK.NS\n' +
'AUROPHARMA|Aurobindo Pharma|Pharma|AUROPHARMA.NS\n' +
'AXISBANK|Axis Bank|Banking|AXISBANK.NS\n' +
'BAJAJ-AUTO|Bajaj Auto|Auto|BAJAJ-AUTO.NS\n' +
'BAJAJFINSV|Bajaj Finserv|Financial Services|BAJAJFINSV.NS\n' +
'BAJAJHFL|Bajaj Housing Finance|Housing Finance|BAJAJHFL.NS\n' +
'BAJFINANCE|Bajaj Finance|NBFC|BAJFINANCE.NS\n' +
'BALRAMCHIN|Balrampur Chini|Sugar|BALRAMCHIN.NS\n' +
'BANDHANBNK|Bandhan Bank|Banking|BANDHANBNK.NS\n' +
'BANKBARODA|Bank of Baroda|Banking/PSU|BANKBARODA.NS\n' +
'BATAINDIA|Bata India|Consumer|BATAINDIA.NS\n' +
'BDL|Bharat Dynamics|Defence|BDL.NS\n' +
'BEL|Bharat Electronics|Defence|BEL.NS\n' +
'BEML|BEML|Defence|BEML.NS\n' +
'BHARATFORG|Bharat Forge|Auto Ancillary|BHARATFORG.NS\n' +
'BHARTIARTL|Bharti Airtel|Telecom|BHARTIARTL.NS\n' +
'BHEL|Bharat Heavy Electricals|Power/Defence|BHEL.NS\n' +
'BIKAJI|Bikaji Foods|FMCG|BIKAJI.NS\n' +
'BIOCON|Biocon|Pharma|BIOCON.NS\n' +
'BOSCHLTD|Bosch|Auto Ancillary|BOSCHLTD.NS\n' +
'BPCL|Bharat Petroleum|Oil & Gas/PSU|BPCL.NS\n' +
'BRIGADE|Brigade Enterprises|Realty|BRIGADE.NS\n' +
'BRITANNIA|Britannia Industries|FMCG|BRITANNIA.NS\n' +
'BSE|BSE|Financial Services|BSE.NS\n' +
'CAMS|CAMS|Financial Services|CAMS.NS\n' +
'CANBK|Canara Bank|Banking/PSU|CANBK.NS\n' +
'CANFINHOME|Can Fin Homes|Housing Finance|CANFINHOME.NS\n' +
'CDSL|CDSL|Financial Services|CDSL.NS\n' +
'CEATLTD|CEAT|Auto Ancillary|CEATLTD.NS\n' +
'CENTRALBK|Central Bank of India|Banking/PSU|CENTRALBK.NS\n' +
'CENTURYPLY|Century Plyboards|Building Materials|CENTURYPLY.NS\n' +
'CENTURYTEX|Century Textiles|Textile|CENTURYTEX.NS\n' +
'CESC|CESC|Power|CESC.NS\n' +
'CGPOWER|CG Power & Industrial|Industrial|CGPOWER.NS\n' +
'CHALET|Chalet Hotels|Hospitality|CHALET.NS\n' +
'CHOLAFIN|Cholamandalam Investment|NBFC|CHOLAFIN.NS\n' +
'CIPLA|Cipla|Pharma|CIPLA.NS\n' +
'COALINDIA|Coal India|Mining|COALINDIA.NS\n' +
'COCHINSHIP|Cochin Shipyard|Defence|COCHINSHIP.NS\n' +
'COFORGE|Coforge|IT|COFORGE.NS\n' +
'COLPAL|Colgate-Palmolive India|FMCG|COLPAL.NS\n' +
'CONCOR|Container Corp of India|Logistics/PSU|CONCOR.NS\n' +
'CRISIL|CRISIL|Financial Services|CRISIL.NS\n' +
'CUB|City Union Bank|Banking|CUB.NS\n' +
'CUMMINSIND|Cummins India|Industrial Machinery|CUMMINSIND.NS\n' +
'CYIENT|Cyient|IT|CYIENT.NS\n' +
'DABUR|Dabur India|FMCG|DABUR.NS\n' +
'DATAPATTNS|Data Patterns India|Defence|DATAPATTNS.NS\n' +
'DCXINDIA|DCX Systems|Defence|DCXINDIA.NS\n' +
'DEEPAKFERT|Deepak Fertilisers|Chemicals|DEEPAKFERT.NS\n' +
'DELHIVERY|Delhivery|Logistics|DELHIVERY.NS\n' +
'DIVISLAB|Divi\'s Laboratories|Pharma|DIVISLAB.NS\n' +
'DIXON|Dixon Technologies|Electronics|DIXON.NS\n' +
'DLF|DLF|Realty|DLF.NS\n' +
'DMART|Avenue Supermarts (DMart)|Retail|DMART.NS\n' +
'DRREDDY|Dr. Reddy\'s Laboratories|Pharma|DRREDDY.NS\n' +
'EICHERMOT|Eicher Motors|Auto|EICHERMOT.NS\n' +
'ELGIEQUIP|Elgi Equipments|Industrial|ELGIEQUIP.NS\n' +
'EMAMILTD|Emami|FMCG|EMAMILTD.NS\n' +
'ENDURANCE|Endurance Technologies|Auto Ancillary|ENDURANCE.NS\n' +
'ENGINERSIN|Engineers India|Consulting/PSU|ENGINERSIN.NS\n' +
'EQUITASBNK|Equitas Small Finance Bank|Banking|EQUITASBNK.NS\n' +
'ESCORTS|Escorts Kubota|Farm Equipment|ESCORTS.NS\n' +
'EXIDEIND|Exide Industries|Auto Ancillary|EXIDEIND.NS\n' +
'FEDERALBNK|Federal Bank|Banking|FEDERALBNK.NS\n' +
'FINCABLES|Finolex Cables|Electrical|FINCABLES.NS\n' +
'FIVESTAR|Five-Star Business Finance|NBFC|FIVESTAR.NS\n' +
'FORTIS|Fortis Healthcare|Healthcare|FORTIS.NS\n' +
'GAIL|GAIL India|Oil & Gas/PSU|GAIL.NS\n' +
'GESHIP|Great Eastern Shipping|Shipping|GESHIP.NS\n' +
'GLAND|Gland Pharma|Pharma|GLAND.NS\n' +
'GLENMARK|Glenmark Pharmaceuticals|Pharma|GLENMARK.NS\n' +
'GMRINFRA|GMR Airports Infrastructure|Infrastructure|GMRINFRA.NS\n' +
'GNFC|GNFC|Chemicals|GNFC.NS\n' +
'GODREJCP|Godrej Consumer Products|FMCG|GODREJCP.NS\n' +
'GODREJIND|Godrej Industries|Diversified|GODREJIND.NS\n' +
'GODREJPROP|Godrej Properties|Realty|GODREJPROP.NS\n' +
'GRAPHITE|Graphite India|Metal|GRAPHITE.NS\n' +
'GRASIM|Grasim Industries|Diversified|GRASIM.NS\n' +
'GRINDWELL|Grindwell Norton|Industrial|GRINDWELL.NS\n' +
'GRSE|Garden Reach Shipbuilders|Defence|GRSE.NS\n' +
'GSPL|Gujarat State Petronet|Gas Distribution|GSPL.NS\n' +
'GUJGASLTD|Gujarat Gas|Gas Distribution|GUJGASLTD.NS\n' +
'HAL|Hindustan Aeronautics|Defence|HAL.NS\n' +
'HAPPSTMNDS|Happiest Minds Technologies|IT|HAPPSTMNDS.NS\n' +
'HAVELLS|Havells India|Electrical|HAVELLS.NS\n' +
'HCLTECH|HCL Technologies|IT|HCLTECH.NS\n' +
'HDFCAMC|HDFC AMC|Asset Management|HDFCAMC.NS\n' +
'HDFCBANK|HDFC Bank|Banking|HDFCBANK.NS\n' +
'HDFCLIFE|HDFC Life Insurance|Insurance|HDFCLIFE.NS\n' +
'HEROMOTOCO|Hero MotoCorp|Auto|HEROMOTOCO.NS\n' +
'HFCL|HFCL|Telecom|HFCL.NS\n' +
'HINDALCO|Hindalco Industries|Metal|HINDALCO.NS\n' +
'HINDPETRO|Hindustan Petroleum|Oil & Gas/PSU|HINDPETRO.NS\n' +
'HINDUNILVR|Hindustan Unilever|FMCG|HINDUNILVR.NS\n' +
'HUDCO|HUDCO|NBFC/PSU|HUDCO.NS\n' +
'ICICIBANK|ICICI Bank|Banking|ICICIBANK.NS\n' +
'ICICIPRULI|ICICI Prudential Life|Insurance|ICICIPRULI.NS\n' +
'IDEAFORGE|ideaForge Technology|Defence/Drone|IDEAFORGE.NS\n' +
'IDFCFIRSTB|IDFC First Bank|Banking|IDFCFIRSTB.NS\n' +
'IEX|Indian Energy Exchange|Financial Services|IEX.NS\n' +
'IGL|Indraprastha Gas|Gas Distribution|IGL.NS\n' +
'IIFL|IIFL Finance|NBFC|IIFL.NS\n' +
'INDHOTEL|Indian Hotels Company|Hospitality|INDHOTEL.NS\n' +
'INDIANB|Indian Bank|Banking/PSU|INDIANB.NS\n' +
'INDIGO|IndiGo (InterGlobe Aviation)|Aviation|INDIGO.NS\n' +
'INDUSINDBK|IndusInd Bank|Banking|INDUSINDBK.NS\n' +
'INDUSTOWER|Indus Towers|Telecom Infra|INDUSTOWER.NS\n' +
'INFY|Infosys|IT|INFY.NS\n' +
'INTELLECT|Intellect Design Arena|IT|INTELLECT.NS\n' +
'IOB|Indian Overseas Bank|Banking/PSU|IOB.NS\n' +
'IOC|Indian Oil Corporation|Oil & Gas/PSU|IOC.NS\n' +
'IPCALAB|IPCA Laboratories|Pharma|IPCALAB.NS\n' +
'IRCON|IRCON International|Infrastructure/PSU|IRCON.NS\n' +
'IRCTC|Indian Railway Catering|Services/PSU|IRCTC.NS\n' +
'IREDA|IREDA|NBFC/PSU|IREDA.NS\n' +
'IRFC|Indian Railway Finance Corp|NBFC/PSU|IRFC.NS\n' +
'ITC|ITC|FMCG|ITC.NS\n' +
'JINDALSTEL|Jindal Steel & Power|Metal|JINDALSTEL.NS\n' +
'JKCEMENT|JK Cement|Cement|JKCEMENT.NS\n' +
'JSL|Jindal Stainless|Metal|JSL.NS\n' +
'JSWENERGY|JSW Energy|Power|JSWENERGY.NS\n' +
'JSWSTEEL|JSW Steel|Metal|JSWSTEEL.NS\n' +
'JUBLFOOD|Jubilant FoodWorks|Consumer|JUBLFOOD.NS\n' +
'JUSTDIAL|Just Dial|Internet|JUSTDIAL.NS\n' +
'JYOTHYLAB|Jyothy Labs|FMCG|JYOTHYLAB.NS\n' +
'KAJARIACER|Kajaria Ceramics|Building Materials|KAJARIACER.NS\n' +
'KALYANKJIL|Kalyan Jewellers|Jewellery|KALYANKJIL.NS\n' +
'KAYNES|Kaynes Technology|Electronics|KAYNES.NS\n' +
'KIMS|KIMS|Healthcare|KIMS.NS\n' +
'KIRLOSENG|Kirloskar Oil Engines|Industrial Machinery|KIRLOSENG.NS\n' +
'KNRCON|KNR Constructions|Infrastructure|KNRCON.NS\n' +
'KOTAKBANK|Kotak Mahindra Bank|Banking|KOTAKBANK.NS\n' +
'KPITTECH|KPIT Technologies|IT|KPITTECH.NS\n' +
'LALPATHLAB|Dr Lal PathLabs|Diagnostics|LALPATHLAB.NS\n' +
'LAURUSLABS|Laurus Labs|Pharma|LAURUSLABS.NS\n' +
'LICHSGFIN|LIC Housing Finance|Housing Finance|LICHSGFIN.NS\n' +
'LICI|Life Insurance Corp (LIC)|Insurance/PSU|LICI.NS\n' +
'LT|Larsen & Toubro|Infrastructure|LT.NS\n' +
'LTIM|LTIMindtree|IT|LTIM.NS\n' +
'LTTS|L&T Technology Services|IT|LTTS.NS\n' +
'LUPIN|Lupin|Pharma|LUPIN.NS\n' +
'M&M|Mahindra & Mahindra|Auto|M&M.NS\n' +
'MAHABANK|Bank of Maharashtra|Banking/PSU|MAHABANK.NS\n' +
'MANAPPURAM|Manappuram Finance|NBFC|MANAPPURAM.NS\n' +
'MANKIND|Mankind Pharma|Pharma|MANKIND.NS\n' +
'MARICO|Marico|FMCG|MARICO.NS\n' +
'MARUTI|Maruti Suzuki|Auto|MARUTI.NS\n' +
'MASTEK|Mastek|IT|MASTEK.NS\n' +
'MAXHEALTH|Max Healthcare|Healthcare|MAXHEALTH.NS\n' +
'MAZAGON|Mazagon Dock Shipbuilders|Defence|MAZDOCK.NS\n' +
'MCX|Multi Commodity Exchange|Financial Services|MCX.NS\n' +
'MEDANTA|Global Health (Medanta)|Healthcare|MEDANTA.NS\n' +
'METROPOLIS|Metropolis Healthcare|Diagnostics|METROPOLIS.NS\n' +
'MFSL|Max Financial Services|Insurance|MFSL.NS\n' +
'MGL|Mahanagar Gas|Gas Distribution|MGL.NS\n' +
'MIDHANI|Mishra Dhatu Nigam|Defence|MIDHANI.NS\n' +
'MOIL|MOIL|Mining/PSU|MOIL.NS\n' +
'MOTHERSON|Samvardhana Motherson|Auto Ancillary|MOTHERSON.NS\n' +
'MPHASIS|Mphasis|IT|MPHASIS.NS\n' +
'MTAR|MTAR Technologies|Defence/Space|MTAR.NS\n' +
'MUTHOOTFIN|Muthoot Finance|NBFC|MUTHOOTFIN.NS\n' +
'NATCOPHARM|Natco Pharma|Pharma|NATCOPHARM.NS\n' +
'NATIONALUM|National Aluminium|Metal/PSU|NATIONALUM.NS\n' +
'NAUKRI|Info Edge (India)|Internet|NAUKRI.NS\n' +
'NAVINFLUOR|Navin Fluorine|Chemicals|NAVINFLUOR.NS\n' +
'NCC|NCC|Infrastructure|NCC.NS\n' +
'NESTLEIND|Nestle India|FMCG|NESTLEIND.NS\n' +
'NHPC|NHPC|Power/PSU|NHPC.NS\n' +
'NLC|NLC India|Power/PSU|NLC.NS\n' +
'NMDC|NMDC|Mining/PSU|NMDC.NS\n' +
'NTPC|NTPC|Power|NTPC.NS\n' +
'NYKAA|FSN E-Commerce (Nykaa)|Consumer Tech|NYKAA.NS\n' +
'OBEROIRLTY|Oberoi Realty|Realty|OBEROIRLTY.NS\n' +
'OFSS|Oracle Financial Services|IT|OFSS.NS\n' +
'OLECTRA|Olectra Greentech|EV/Bus|OLECTRA.NS\n' +
'ONGC|Oil & Natural Gas Corp|Oil & Gas|ONGC.NS\n' +
'PAGEIND|Page Industries|Textile|PAGEIND.NS\n' +
'PARAS|Paras Defence & Space|Defence|PARAS.NS\n' +
'PERSISTENT|Persistent Systems|IT|PERSISTENT.NS\n' +
'PETRONET|Petronet LNG|Oil & Gas|PETRONET.NS\n' +
'PHOENIXLTD|Phoenix Mills|Realty|PHOENIXLTD.NS\n' +
'PIIND|PI Industries|Agrochem|PIIND.NS\n' +
'PNB|Punjab National Bank|Banking/PSU|PNB.NS\n' +
'POLICYBZR|PB Fintech (Policybazaar)|Fintech|POLICYBZR.NS\n' +
'POLYCAB|Polycab India|Electrical|POLYCAB.NS\n' +
'POONAWALLA|Poonawalla Fincorp|NBFC|POONAWALLA.NS\n' +
'POWERGRID|Power Grid Corp|Power/PSU|POWERGRID.NS\n' +
'PRESTIGE|Prestige Estates|Realty|PRESTIGE.NS\n' +
'RADICO|Radico Khaitan|Beverages|RADICO.NS\n' +
'RECLTD|REC|NBFC/PSU|RECLTD.NS\n' +
'RELIANCE|Reliance Industries|Energy|RELIANCE.NS\n' +
'RVNL|Rail Vikas Nigam|Infrastructure/PSU|RVNL.NS\n' +
'SAFARI|Safari Industries|Consumer|SAFARI.NS\n' +
'SAIL|Steel Authority of India|Metal/PSU|SAIL.NS\n' +
'SBICARD|SBI Cards & Payment|Financial Services|SBICARD.NS\n' +
'SBILIFE|SBI Life Insurance|Insurance|SBILIFE.NS\n' +
'SBIN|State Bank of India|Banking|SBIN.NS\n' +
'SHREECEM|Shree Cement|Cement|SHREECEM.NS\n' +
'SHRIRAMFIN|Shriram Finance|NBFC|SHRIRAMFIN.NS\n' +
'SIEMENS|Siemens|Industrial|SIEMENS.NS\n' +
'SJVN|SJVN|Power/PSU|SJVN.NS\n' +
'SOBHA|Sobha|Realty|SOBHA.NS\n' +
'SOLARINDS|Solar Industries India|Defence/Explosive|SOLARINDS.NS\n' +
'SONACOMS|Sona BLW Precision Forgings|Auto Ancillary|SONACOMS.NS\n' +
'SUNDARMFIN|Sundaram Finance|NBFC|SUNDARMFIN.NS\n' +
'SUNPHARMA|Sun Pharma|Pharma|SUNPHARMA.NS\n' +
'SUPREMEIND|Supreme Industries|Plastics|SUPREMEIND.NS\n' +
'SURYAROSNI|Surya Roshni|Electrical|SURYAROSNI.NS\n' +
'SYNGENE|Syngene International|Pharma/CRO|SYNGENE.NS\n' +
'TATACOMM|Tata Communications|Telecom|TATACOMM.NS\n' +
'TATACONSUM|Tata Consumer Products|FMCG|TATACONSUM.NS\n' +
'TATAELXSI|Tata Elxsi|IT|TATAELXSI.NS\n' +
'TATAMOTORS|Tata Motors|Auto|TATAMOTORS.NS\n' +
'TATAPOWER|Tata Power|Power|TATAPOWER.NS\n' +
'TATASTEEL|Tata Steel|Metal|TATASTEEL.NS\n' +
'TCS|Tata Consultancy Services|IT|TCS.NS\n' +
'TECHM|Tech Mahindra|IT|TECHM.NS\n' +
'THERMAX|Thermax|Industrial|THERMAX.NS\n' +
'TIINDIA|Tube Investments of India|Auto Ancillary|TIINDIA.NS\n' +
'TITAN|Titan Company|Consumer|TITAN.NS\n' +
'TORNTPHARM|Torrent Pharmaceuticals|Pharma|TORNTPHARM.NS\n' +
'TORNTPOWER|Torrent Power|Power|TORNTPOWER.NS\n' +
'TRENT|Trent|Retail|TRENT.NS\n' +
'TRIDENT|Trident|Textile|TRIDENT.NS\n' +
'UCOBANK|UCO Bank|Banking/PSU|UCOBANK.NS\n' +
'UJJIVANSFB|Ujjivan Small Finance Bank|Banking|UJJIVANSFB.NS\n' +
'ULTRACEMCO|UltraTech Cement|Cement|ULTRACEMCO.NS\n' +
'UNIONBANK|Union Bank of India|Banking/PSU|UNIONBANK.NS\n' +
'UNITDSPR|United Spirits|Beverages|UNITDSPR.NS\n' +
'UNOMINDA|Uno Minda|Auto Ancillary|UNOMINDA.NS\n' +
'UPL|UPL|Agrochem|UPL.NS\n' +
'VBL|Varun Beverages|FMCG|VBL.NS\n' +
'VEDL|Vedanta|Metal|VEDL.NS\n' +
'VGUARD|V-Guard Industries|Electrical|VGUARD.NS\n' +
'VOLTAS|Voltas|Consumer Durables|VOLTAS.NS\n' +
'WELCORP|Welspun Corp|Metal|WELCORP.NS\n' +
'WELSPUNLIV|Welspun Living|Textile|WELSPUNLIV.NS\n' +
'WIPRO|Wipro|IT|WIPRO.NS\n' +
'YESBANK|Yes Bank|Banking|YESBANK.NS\n' +
'ZEEL|Zee Entertainment|Media|ZEEL.NS\n' +
'ZENSARTECH|Zensar Technologies|IT|ZENSARTECH.NS\n' +
'ZENTEC|Zen Technologies|Defence|ZENTEC.NS\n' +
'ZOMATO|Zomato|Consumer Tech|ZOMATO.NS\n' +
'ZYDUSLIFE|Zydus Lifesciences|Pharma|ZYDUSLIFE.NS\n' +
'ADANIGAS|Adani Gas (ATGL)|Gas Distribution|ATGL.NS\n' +
'AFFLE|Affle India|Ad Tech|AFFLE.NS\n' +
'AKZOINDIA|Akzo Nobel India|Paints|AKZOINDIA.NS\n' +
'ALKYLAMINE|Alkyl Amines Chemicals|Chemicals|ALKYLAMINE.NS\n' +
'ALOKTEXT|Alok Industries|Textile|ALOKTEXT.NS\n' +
'AMBER|Amber Enterprises|Electronics|AMBER.NS\n' +
'ANURAS|Anurag Rubber|Industrial|ANURAS.NS\n' +
'APARINDS|Apar Industries|Electrical|APARINDS.NS\n' +
'ARCHIES|Archies|Consumer|ARCHIES.NS\n' +
'ASAHIINDIA|Asahi India Glass|Auto Ancillary|ASAHIINDIA.NS\n' +
'ASHOKA|Ashoka Buildcon|Infrastructure|ASHOKA.NS\n' +
'ASTRAZEN|AstraZeneca Pharma|Pharma|ASTRAZEN.NS\n' +
'AVANTIFEED|Avanti Feeds|Aquaculture|AVANTIFEED.NS\n' +
'BCG|Bengal & Assam Company|Diversified|BCG.NS\n' +
'BERGEPAINT|Berger Paints|Paints|BERGEPAINT.NS\n' +
'BLUESTARCO|Blue Star|Consumer Durables|BLUESTARCO.NS\n' +
'BOROLT|Borosil|Consumer|BOROLT.NS\n' +
'CANTABIL|Cantabil Retail India|Retail|CANTABIL.NS\n' +
'CARBORUNIV|Carborundum Universal|Industrial|CARBORUNIV.NS\n' +
'CARTRADE|CarTrade Tech|Internet|CARTRADE.NS\n' +
'CASTROLIND|Castrol India|Lubricants|CASTROLIND.NS\n' +
'CCL|CCL Products India|FMCG|CCL.NS\n' +
'CERA|Cera Sanitaryware|Building Materials|CERA.NS\n' +
'CHAMBLFERT|Chambal Fertilisers|Chemicals|CHAMBLFERT.NS\n' +
'CHEMPLASTS|Chemplast Sanmar|Chemicals|CHEMPLASTS.NS\n' +
'CLEAN|Clean Science Technology|Chemicals|CLEAN.NS\n' +
'COMPUSOFT|Compusoft|IT|COMPUSOFT.NS\n' +
'CROMPTON|Crompton Greaves Consumer|Consumer Durables|CROMPTON.NS\n' +
'CSBBANK|CSB Bank|Banking|CSBBANK.NS\n' +
'DATAMATICS|Datamatics Global Services|IT|DATAMATICS.NS\n' +
'DBREALTY|D B Realty|Realty|DBREALTY.NS\n' +
'DCBBANK|DCB Bank|Banking|DCBBANK.NS\n' +
'DEEPAKNTR|Deepak Nitrite|Chemicals|DEEPAKNTR.NS\n' +
'DELTACORP|Delta Corp|Entertainment|DELTACORP.NS\n' +
'DODLA|Dodla Dairy|FMCG|DODLA.NS\n' +
'EDELWEISS|Edelweiss Financial|Financial Services|EDELWEISS.NS\n' +
'ENIL|Entertainment Network India|Media|ENIL.NS\n' +
'EMCURE|Emcure Pharmaceuticals|Pharma|EMCURE.NS\n' +
'EQUITAS|Equitas Holdings|Financial Services|EQUITAS.NS\n' +
'ESABINDIA|ESAB India|Industrial|ESABINDIA.NS\n' +
'FINEORG|Fine Organic Industries|Chemicals|FINEORG.NS\n' +
'FLUOROCHEM|Gujarat Fluorochemicals|Chemicals|FLUOROCHEM.NS\n' +
'GAEL|Gujarat Ambuja Exports|Agri|GAEL.NS\n' +
'GALLANTT|Gallantt Ispat|Metal|GALLANTT.NS\n' +
'GATEWAY|Gateway Distriparks|Logistics|GATEWAY.NS\n' +
'GICRE|General Insurance Corp|Insurance|GICRE.NS\n' +
'GIPCL|Gujarat Industries Power|Power|GIPCL.NS\n' +
'GLAXO|GSK Pharmaceuticals|Pharma|GLAXO.NS\n' +
'GPPL|Gujarat Pipavav Port|Logistics|GPPL.NS\n' +
'HAPPYFORGE|Happy Forgings|Auto Ancillary|HAPPYFORGE.NS\n' +
'HEG|HEG|Metal|HEG.NS\n' +
'HIMATSEIDE|Himatsingka Seide|Textile|HIMATSEIDE.NS\n' +
'HINDCOPPER|Hindustan Copper|Metal|HINDCOPPER.NS\n' +
'IBULHSGFIN|Indiabulls Housing Finance|Housing Finance|IBULHSGFIN.NS\n' +
'ICICLOMBRD|ICICI Lombard GIC|Insurance|ICICLOMBRD.NS\n' +
'IFBIND|IFB Industries|Consumer Durables|IFBIND.NS\n' +
'IGPL|IG Petrochemicals|Chemicals|IGPL.NS\n' +
'INDIAMART|IndiaMart InterMesh|Internet|INDIAMART.NS\n' +
'INDIGOPNTS|Indigo Paints|Paints|INDIGOPNTS.NS\n' +
'INOXGREEN|INOX Green Energy|Renewable Energy|INOXGREEN.NS\n' +
'ION|ION Exchange|Chemicals|ION.NS\n' +
'JTEKTINDIA|JTEKT India|Auto Ancillary|JTEKTINDIA.NS\n' +
'JUBLINGREA|Jubilant Ingrevia|Chemicals|JUBLINGREA.NS\n' +
'KANSAINER|Kansai Nerolac Paints|Paints|KANSAINER.NS\n' +
'KARTIKAYS|Kartik|Chemicals|KARTIKAYS.NS\n' +
'KEEI|KEI Industries|Electrical|KEI.NS\n' +
'KEILTD|KEI Industries|Electrical|KEI.NS\n' +
'KEI|KEI Industries|Electrical|KEI.NS\n' +
'KENNAMETAL|Kennametal India|Industrial|KENNAMETAL.NS\n' +
'KMSUGAR|KM Sugar Mills|Sugar|KMSUGAR.NS\n' +
'KRBL|KRBL (India Gate Rice)|FMCG|KRBL.NS\n' +
'KSCL|Kaveri Seed Company|Agri|KSCL.NS\n' +
'LATENTVIEW|LatentView Analytics|IT|LATENTVIEW.NS\n' +
'LAXMIMACH|Lakshmi Machine Works|Industrial|LAXMIMACH.NS\n' +
'LINDEINDIA|Linde India|Industrial Gases|LINDEINDIA.NS\n' +
'LLOYDSME|Lloyds Metals & Energy|Metal|LLOYDSME.NS\n' +
'LODHA|Lodha (Macrotech Dev)|Realty|MACROTECH.NS\n' +
'MAHSCOOTER|Maharashtra Scooters|Auto|MAHSCOOTER.NS\n' +
'MAHSEAMLES|Maharashtra Seamless|Metal|MAHSEAMLES.NS\n' +
'MASFIN|MAS Financial Services|NBFC|MASFIN.NS\n' +
'MAXESTATES|Max Estates|Realty|MAXESTATES.NS\n' +
'MEDPLUS|Medplus Health Services|Healthcare Retail|MEDPLUS.NS\n' +
'METROBRAND|Metro Brands|Retail|METROBRAND.NS\n' +
'MMTC|MMTC|Trading/PSU|MMTC.NS\n' +
'MOLDTKPAC|Mold-Tek Packaging|Packaging|MOLDTKPAC.NS\n' +
'MUKKA|Mukka Proteins|Aquaculture|MUKKA.NS\n' +
'MUTHOOTMF|Muthoot Microfin|NBFC|MUTHOOTMF.NS\n' +
'NACLIND|NACL Industries|Agrochem|NACLIND.NS\n' +
'NAVNETEDUL|Navneet Education|Education|NAVNETEDUL.NS\n' +
'NAYARA|Nayara Energy (Essar Oil)|Oil & Gas|NAYARA.NS\n' +
'NESCO|NESCO|Exhibitions|NESCO.NS\n' +
'NETWORK18|Network18 Media|Media|NETWORK18.NS\n' +
'NIACL|New India Assurance|Insurance/PSU|NIACL.NS\n' +
'NOCIL|NOCIL|Chemicals|NOCIL.NS\n' +
'NSLNISP|Nuvoco Vistas|Cement|NUVOCO.NS\n' +
'NUVOCO|Nuvoco Vistas|Cement|NUVOCO.NS\n' +
'OLAELEC|Ola Electric Mobility|EV|OLAELEC.NS\n' +
'ONCOSIL|OncoSil Medical|Medical Devices|ONCOSIL.NS\n' +
'OPTIEMUS|Optiemus Infracom|Telecom|OPTIEMUS.NS\n' +
'PGHH|P&G Hygiene & Health|FMCG|PGHH.NS\n' +
'PFC|Power Finance Corp|NBFC/PSU|PFC.NS\n' +
'PFIZER|Pfizer|Pharma|PFIZER.NS\n' +
'PHILIPCARB|Phillips Carbon Black|Chemicals|PHILIPCARB.NS\n' +
'PIDILITIND|Pidilite Industries|Adhesives|PIDILITIND.NS\n' +
'PILANIINVS|Pilani Investment|Investment|PILANIINVS.NS\n' +
'PILOTSQUAD|Pilot Industries|Industrial|PILOTSQUAD.NS\n' +
'PNBHOUSING|PNB Housing Finance|Housing Finance|PNBHOUSING.NS\n' +
'POKARNA|Pokarna|Building Materials|POKARNA.NS\n' +
'POLPHARMA|Poly Medicure|Medical Devices|POLMED.NS\n' +
'PRAXIS|Praxis Home Retail|Retail|PRAXIS.NS\n' +
'PRICOL|Pricol|Auto Ancillary|PRICOL.NS\n' +
'PRINCEPIPE|Prince Pipes & Fittings|Plastics|PRINCEPIPE.NS\n' +
'PRISM|Prism Johnson|Cement|PRISMJOHNS.NS\n' +
'PVRINOX|PVR INOX|Entertainment|PVRINOX.NS\n' +
'RITES|RITES|Infrastructure/PSU|RITES.NS\n' +
'RPGLIFE|RPG Life Sciences|Pharma|RPGLIFE.NS\n' +
'RTNPOWER|Rattanindia Power|Power|RTNPOWER.NS\n' +
'SAKSOFT|Saksoft|IT|SAKSOFT.NS\n' +
'SANOFI|Sanofi India|Pharma|SANOFI.NS\n' +
'SAPPHIRE|Sapphire Foods|QSR|SAPPHIRE.NS\n' +
'SAREGAMA|Saregama India|Media|SAREGAMA.NS\n' +
'SARDAEN|Sarda Energy & Minerals|Metal|SARDAEN.NS\n' +
'SCI|Shipping Corp of India|Shipping/PSU|SCI.NS\n' +
'SENCO|Senco Gold|Jewellery|SENCO.NS\n' +
'SEQUENT|Sequent Scientific|Pharma|SEQUENT.NS\n' +
'SHARDAMOTR|Sharda Motor Industries|Auto Ancillary|SHARDAMOTR.NS\n' +
'SHAREINDIA|Share India Securities|Broking|SHAREINDIA.NS\n' +
'SHOPERSTOP|Shoppers Stop|Retail|SHOPERSTOP.NS\n' +
'SHYAMMETL|Shyam Metalics & Energy|Metal|SHYAMMETL.NS\n' +
'SKIPPER|Skipper|Electrical|SKIPPER.NS\n' +
'SMLISUZU|SML Isuzu|Auto|SMLISUZU.NS\n' +
'SOLARA|Solara Active Pharma|Pharma|SOLARA.NS\n' +
'SPARC|Sun Pharma Advanced Research|Pharma|SPARC.NS\n' +
'STARCEMENT|Star Cement|Cement|STARCEMENT.NS\n' +
'STLTECH|Sterlite Technologies|Telecom Infra|STLTECH.NS\n' +
'SUBROS|Subros|Auto Ancillary|SUBROS.NS\n' +
'SUMICHEM|Sumitomo Chemical India|Agrochem|SUMICHEM.NS\n' +
'SUNTECK|Sunteck Realty|Realty|SUNTECK.NS\n' +
'SURYODAY|Suryoday Small Finance Bank|Banking|SURYODAY.NS\n' +
'SUTLEJTEX|Sutlej Textiles|Textile|SUTLEJTEX.NS\n' +
'SWSOLAR|Sterling & Wilson Renewable|Renewable Energy|SWSOLAR.NS\n' +
'SYMPHONY|Symphony|Consumer Durables|SYMPHONY.NS\n' +
'TAKE|Take Solutions|IT|TAKE.NS\n' +
'TANLA|Tanla Platforms|IT|TANLA.NS\n' +
'TASTYBITE|Tasty Bite Eatables|FMCG|TASTYBITE.NS\n' +
'TBOTEK|TBO Tek|Internet|TBOTEK.NS\n' +
'THANGAMAYL|Thangamayil Jewellery|Jewellery|THANGAMAYL.NS\n' +
'THYROCARE|Thyrocare Technologies|Diagnostics|THYROCARE.NS\n' +
'TIMETECHNO|Time Technoplast|Plastics|TIMETECHNO.NS\n' +
'TIPSINDLTD|Tips Industries|Media|TIPSINDLTD.NS\n' +
'TTML|Tata Teleservices Maharashtra|Telecom|TTML.NS\n' +
'TV18BRDCST|TV18 Broadcast|Media|TV18BRDCST.NS\n' +
'TVSL|TVS Logistics Services|Logistics|TVSL.NS\n' +
'TVSSCS|TVS Supply Chain Solutions|Logistics|TVSSCS.NS\n' +
'TVSMOTOR|TVS Motor Company|Auto|TVSMOTOR.NS\n' +
'UJJIVAN|Ujjivan Financial Services|Financial Services|UJJIVAN.NS\n' +
'UTIAMC|UTI AMC|Asset Management|UTIAMC.NS\n' +
'VAIBHAVGBL|Vaibhav Global|Retail/Gems|VAIBHAVGBL.NS\n' +
'VARUNBEV|Varun Beverages|FMCG|VBL.NS\n' +
'VENKEYS|Venky\'s (India)|Poultry|VENKEYS.NS\n' +
'VIJAYA|Vijaya Diagnostic Centre|Healthcare|VIJAYA.NS\n' +
'VSTTILLERS|V.S.T Tillers Tractors|Farm Equipment|VSTTILLERS.NS\n' +
'VSTIND|VST Industries|FMCG|VSTIND.NS\n' +
'WABAG|VA Tech Wabag|Infrastructure|WABAG.NS\n' +
'WELSPUNIND|Welspun India|Textile|WELSPUNIND.NS\n' +
'WENDT|Wendt (India)|Industrial|WENDT.NS\n' +
'WHIRLPOOL|Whirlpool of India|Consumer Durables|WHIRLPOOL.NS\n' +
'XCHANGING|Xchanging Solutions|IT|XCHANGING.NS';
