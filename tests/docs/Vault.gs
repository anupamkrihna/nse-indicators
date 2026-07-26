/**
 * ═══════════════════════════════════════════════════════════════════
 * VAULT.gs — deep-history store (v1.0, 26-Jul-2026)
 * ADDITIVE. New file in the INDICATORS project. Touches nothing existing.
 *
 * WHY (docs/DECISIONS.md D-007)
 *   Apps Script allows ~20,000 UrlFetch calls per DAY, counted per USER across
 *   ALL scripts — so the Steam project and this one share one pool. On
 *   25-Jul-2026 research exhausted it and took the Steam Gauge dashboard down
 *   as collateral damage. The waste was structural: BullBackfill and TierLab
 *   fetch the IDENTICAL 10-year history for the IDENTICAL 799 stocks, and every
 *   re-run paid again. Roughly 3,200 calls that day went on re-downloading
 *   bytes we already had.
 *
 *   Fetch once, store, read from the sheet. A re-harvest then costs ~0 quota
 *   and seconds instead of ~180s.
 *
 * WHAT IS STORED — and the deliberate limit
 *   CLOSE + TIMESTAMPS ONLY. Full OHLCV for 799 stocks x 10y is ~67MB of
 *   string data, which Sheets will hold but hates. Close-only is ~26KB/stock,
 *   ~21MB total, and covers TierLab plus essentially every cross-sectional
 *   factor. Research needing high/low/volume (ADX, RVOL, OBV — i.e.
 *   BullBackfill) still fetches live. That is the trade, made knowingly.
 *
 * ENCODING (keeps every cell under the 50,000-char ceiling)
 *   days   delta-encoded day numbers: "19723,1,1,3,1,..." — trading days sit
 *          1-4 apart, so deltas cost ~2 chars each instead of ~11 for raw unix
 *          seconds. ~6KB per stock.
 *   close  JSON array rounded to 2dp. ~20KB per stock.
 *   Timestamps are reconstructed as day*86400, so the intraday close TIME is
 *   lost. Every consumer only ever uses the calendar date (month keys, date
 *   strings, >= comparisons), so this is safe — but do not add a consumer that
 *   needs intraday precision without checking.
 *
 * OPS (Run dropdown)
 *   vaultBuild()    — resumable full build, 10y x 799 (~800 calls, ~180s)
 *   vaultTopUp()    — resumable incremental refresh, 6mo payloads, merged
 *   vaultStats()    — coverage, freshness, largest cell, total size
 *   vaultReset()    — clear the store
 *
 * READ API (for other files in this project)
 *   vaultCloseSeries_(sym) → { ts:[], close:[], bars:n, fromVault:true } or null
 * ═══════════════════════════════════════════════════════════════════
 */

var VCFG = {
  SHEET:      'DeepVault',
  RANGE:      '10y',
  TOPUP_RANGE:'6mo',
  BUDGET_MS:  200000,        // hard GAS ceiling is 360s; leave room for writes
  CELL_MAX:   45000,         // stay clear of the 50,000-char cell limit
  FLUSH_EVERY:60             // write + checkpoint every N stocks
};

/* ══════════════ PURE: encoding (Node-tested in test_vault.js) ══════════════ */

/* unix seconds → delta-encoded day numbers */
function vEncodeDays_(tsArr) {
  var out = [], prev = null;
  for (var i = 0; i < tsArr.length; i++) {
    if (tsArr[i] == null) return null;
    var d = Math.floor(tsArr[i] / 86400);
    out.push(prev === null ? d : d - prev);
    prev = d;
  }
  return out.join(',');
}

/* delta-encoded string → unix seconds at day boundaries */
function vDecodeDays_(str) {
  var s = String(str || '').trim();
  if (!s) return [];
  var p = s.split(','), day = 0, out = [];
  for (var i = 0; i < p.length; i++) {
    var v = parseInt(p[i], 10);
    if (isNaN(v)) return null;
    day = (i === 0) ? v : day + v;
    out.push(day * 86400);
  }
  return out;
}

function vEncodeNums_(arr, dp) {
  var m = Math.pow(10, dp == null ? 2 : dp), out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] == null || isNaN(arr[i])) return null;
    out.push(Math.round(arr[i] * m) / m);
  }
  return JSON.stringify(out);
}
function vDecodeNums_(str) {
  try { var a = JSON.parse(str); return Array.isArray(a) ? a : null; } catch (e) { return null; }
}

/* Trim a series to the most recent bars that fit inside the cell ceiling.
   Returns {ts, close, trimmed}. Only bites on unusually long or high-priced
   series; normal 10y history fits comfortably. */
function vFitCell_(ts, close, cellMax) {
  cellMax = cellMax || VCFG.CELL_MAX;
  var t = ts.slice(), c = close.slice(), trimmed = 0;
  while (t.length > 300) {
    var ec = vEncodeNums_(c, 2), ed = vEncodeDays_(t);
    if (ec == null || ed == null) return null;
    if (ec.length <= cellMax && ed.length <= cellMax) break;
    var drop = Math.max(50, Math.floor(t.length * 0.05));   // shed oldest 5%
    t = t.slice(drop); c = c.slice(drop); trimmed += drop;
  }
  return { ts: t, close: c, trimmed: trimmed };
}

/* Merge a fresh tail into a stored series, deduping by day and keeping order.
   Fresh bars WIN on overlap — they carry later split/dividend adjustment. */
function vMergeSeries_(oldTs, oldClose, newTs, newClose) {
  var m = {}, i;
  for (i = 0; i < oldTs.length; i++) m[Math.floor(oldTs[i] / 86400)] = oldClose[i];
  for (i = 0; i < newTs.length; i++) m[Math.floor(newTs[i] / 86400)] = newClose[i];
  var days = Object.keys(m).map(Number).sort(function (a, b) { return a - b; });
  var ts = [], cl = [];
  for (i = 0; i < days.length; i++) { ts.push(days[i] * 86400); cl.push(m[days[i]]); }
  return { ts: ts, close: cl };
}

/* ══════════════ GAS: sheet plumbing ══════════════ */

/* stale-handle-proof accessor (same quirk documented in TierLab.gs / UniverseGate.gs) */
function vSheet_() {
  var ss = SpreadsheetApp.getActive(), sh = null;
  try { sh = ss.getSheetByName(VCFG.SHEET); } catch (e) { sh = null; }
  if (sh) { try { sh.getLastRow(); } catch (e2) { sh = null; } }
  if (!sh) {
    try { sh = ss.insertSheet(VCFG.SHEET); }
    catch (e3) { throw new Error('vSheet_: cannot open or create "' + VCFG.SHEET + '" — ' + e3.message); }
  }
  if (sh.getLastRow() === 0) sh.appendRow(['sym', 'updatedAt', 'bars', 'firstDay', 'lastDay', 'days', 'close']);
  return sh;
}

var _vIdx;   // sym → sheet row, built once per execution
function vaultIndex_() {
  if (_vIdx) return _vIdx;
  var sh = vSheet_(), last = sh.getLastRow();
  _vIdx = {};
  if (last > 1) {
    var col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) if (col[i][0]) _vIdx[String(col[i][0]).toUpperCase()] = i + 2;
  }
  return _vIdx;
}

/* ══════════════ READ API ══════════════ */
function vaultCloseSeries_(sym) {
  var idx = vaultIndex_(), row = idx[String(sym).toUpperCase()];
  if (!row) return null;
  var v = vSheet_().getRange(row, 1, 1, 7).getValues()[0];
  var ts = vDecodeDays_(v[5]), cl = vDecodeNums_(v[6]);
  if (!ts || !cl || ts.length !== cl.length || !ts.length) return null;
  return { ts: ts, close: cl, bars: ts.length, fromVault: true };
}

/* ══════════════ BUILD ══════════════ */
function vaultBuild() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('vault_idx') || '0', 10);
  var sh = vSheet_(), idx = vaultIndex_();
  var pend = [], done = start, stored = 0, skipped = 0, trimmedAny = 0, biggest = 0;
  Logger.log('vaultBuild: resuming at ' + start + '/' + uni.length + ' · stored rows ' + Math.max(sh.getLastRow() - 1, 0));

  function flush() {
    if (!pend.length) return;
    pend.forEach(function (r) {
      var row = idx[r[0]];
      if (row) sh.getRange(row, 1, 1, 7).setValues([r]);
      else { sh.appendRow(r); idx[r[0]] = sh.getLastRow(); }
    });
    pend = [];
  }

  for (var s = start; s < uni.length; s++) {
    if (Date.now() - t0 > VCFG.BUDGET_MS) break;
    done = s + 1;
    try {
      var u = uni[s], bars = getBarsDeep_(u.sym, VCFG.RANGE);      // Code.gs helper
      if (!bars || !bars.close || !bars.ts || bars.close.length < 30) { skipped++; continue; }
      var fit = vFitCell_(bars.ts, bars.close, VCFG.CELL_MAX);
      if (!fit) { skipped++; continue; }
      if (fit.trimmed) trimmedAny++;
      var ed = vEncodeDays_(fit.ts), ec = vEncodeNums_(fit.close, 2);
      if (ed == null || ec == null) { skipped++; continue; }
      if (ec.length > biggest) biggest = ec.length;
      pend.push([u.sym, new Date().toISOString(), fit.ts.length,
        Math.floor(fit.ts[0] / 86400), Math.floor(fit.ts[fit.ts.length - 1] / 86400), ed, ec]);
      stored++;
      if (pend.length >= VCFG.FLUSH_EVERY) { flush(); props.setProperty('vault_idx', String(s + 1)); }
    } catch (e) {
      if (typeof tlQuotaExceeded_ === 'function' && tlQuotaExceeded_(e)) {
        flush(); props.setProperty('vault_idx', String(s));
        Logger.log('vaultBuild: STOPPED at ' + s + '/' + uni.length +
          ' — daily UrlFetch quota exhausted. Progress saved; resets ~12:30 PM IST.');
        return;
      }
      skipped++;
    }
  }
  flush();
  var fin = done >= uni.length;
  props.setProperty('vault_idx', fin ? '0' : String(done));
  Logger.log('vaultBuild: ' + start + '→' + done + '/' + uni.length + ' · stored ' + stored +
    ' · skipped ' + skipped + ' · trimmed ' + trimmedAny + ' · largest close cell ' + biggest + ' chars · ' +
    Math.round((Date.now() - t0) / 1000) + 's. ' + (fin ? 'DONE — run vaultStats().' : 'Not finished — run vaultBuild() again.'));
}

/* ══════════════ INCREMENTAL TOP-UP ══════════════ */
function vaultTopUp() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('vault_top_idx') || '0', 10);
  var sh = vSheet_(), idx = vaultIndex_();
  var done = start, updated = 0, fresh = 0, skipped = 0;
  var todayDay = Math.floor(Date.now() / 86400000);

  for (var s = start; s < uni.length; s++) {
    if (Date.now() - t0 > VCFG.BUDGET_MS) break;
    done = s + 1;
    var sym = uni[s].sym, row = idx[sym];
    if (!row) { skipped++; continue; }                             // not built yet — vaultBuild() first
    try {
      var cur = sh.getRange(row, 1, 1, 7).getValues()[0];
      if (Number(cur[4]) >= todayDay - 1) { fresh++; continue; }   // already current, no fetch
      var bars = getBarsDeep_(sym, VCFG.TOPUP_RANGE);
      if (!bars || !bars.close || !bars.ts) { skipped++; continue; }
      var oldTs = vDecodeDays_(cur[5]), oldCl = vDecodeNums_(cur[6]);
      if (!oldTs || !oldCl) { skipped++; continue; }
      var mg = vMergeSeries_(oldTs, oldCl, bars.ts, bars.close);
      var fit = vFitCell_(mg.ts, mg.close, VCFG.CELL_MAX);
      if (!fit) { skipped++; continue; }
      sh.getRange(row, 1, 1, 7).setValues([[sym, new Date().toISOString(), fit.ts.length,
        Math.floor(fit.ts[0] / 86400), Math.floor(fit.ts[fit.ts.length - 1] / 86400),
        vEncodeDays_(fit.ts), vEncodeNums_(fit.close, 2)]]);
      updated++;
    } catch (e) {
      if (typeof tlQuotaExceeded_ === 'function' && tlQuotaExceeded_(e)) {
        props.setProperty('vault_top_idx', String(s));
        Logger.log('vaultTopUp: STOPPED at ' + s + '/' + uni.length + ' — daily UrlFetch quota exhausted.');
        return;
      }
      skipped++;
    }
  }
  var fin = done >= uni.length;
  props.setProperty('vault_top_idx', fin ? '0' : String(done));
  Logger.log('vaultTopUp: ' + start + '→' + done + '/' + uni.length + ' · updated ' + updated +
    ' · already fresh ' + fresh + ' (no fetch) · skipped ' + skipped + ' · ' +
    Math.round((Date.now() - t0) / 1000) + 's. ' + (fin ? 'DONE.' : 'Not finished — run vaultTopUp() again.'));
}

/* ══════════════ DIAGNOSTICS ══════════════ */
function vaultStats() {
  var sh = vSheet_(), last = sh.getLastRow();
  if (last < 2) { Logger.log('vault is empty — run vaultBuild()'); return; }
  var n = last - 1, meta = sh.getRange(2, 1, n, 5).getValues();
  var uni = {}, u = uniList_();
  u.forEach(function (x) { uni[x.sym] = 1; });
  var minBars = 1e9, maxBars = 0, sumBars = 0, oldestDay = 1e9, newestDay = 0, orphan = 0;
  meta.forEach(function (r) {
    var b = Number(r[2]) || 0;
    if (b < minBars) minBars = b;
    if (b > maxBars) maxBars = b;
    sumBars += b;
    if (Number(r[3]) < oldestDay) oldestDay = Number(r[3]);
    if (Number(r[4]) > newestDay) newestDay = Number(r[4]);
    if (!uni[String(r[0]).toUpperCase()]) orphan++;
  });
  var idx = vaultIndex_(), missing = [];
  u.forEach(function (x) { if (!idx[x.sym]) missing.push(x.sym); });
  /* sample a few rows to estimate on-disk size without loading 21MB */
  var probe = Math.min(n, 20), bytes = 0, big = 0;
  var rows = sh.getRange(2, 6, probe, 2).getValues();
  rows.forEach(function (r) {
    var a = String(r[0]).length, b = String(r[1]).length;
    bytes += a + b;
    if (b > big) big = b;
  });
  var avg = bytes / probe;
  Logger.log('── VAULT ──');
  Logger.log('stocks stored ' + n + ' of ' + u.length + ' · missing ' + missing.length +
    (missing.length && missing.length <= 12 ? ' (' + missing.join(', ') + ')' : '') +
    ' · orphaned (not in universe) ' + orphan);
  Logger.log('bars: min ' + minBars + ' · avg ' + Math.round(sumBars / n) + ' · max ' + maxBars);
  Logger.log('coverage: ' + new Date(oldestDay * 86400000).toISOString().slice(0, 10) +
    ' … ' + new Date(newestDay * 86400000).toISOString().slice(0, 10) +
    ' (newest is ' + (Math.floor(Date.now() / 86400000) - newestDay) + ' days old)');
  Logger.log('size: ~' + Math.round(avg / 1024) + 'KB per stock, largest close cell ' + big +
    ' chars (ceiling ' + VCFG.CELL_MAX + ') · est. total ~' + Math.round(avg * n / 1048576) + 'MB');
  Logger.log(missing.length ? 'run vaultBuild() again to fill the gaps' : 'complete');
}

function vaultReset() {
  var sh = SpreadsheetApp.getActive().getSheetByName(VCFG.SHEET);
  if (sh) { try { sh.clear(); } catch (e) { } }                    // clear, never delete
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('vault_idx'); p.deleteProperty('vault_top_idx');
  _vIdx = null;
  Logger.log('vault cleared');
}

/* Quick check that a stored series round-trips and matches a live fetch. */
function vaultVerify() {
  ['RELIANCE', 'TCS', 'THANGAMAYL'].forEach(function (sym) {
    var v = vaultCloseSeries_(sym);
    if (!v) { Logger.log(sym + ': NOT IN VAULT'); return; }
    var live = getBarsDeep_(sym, VCFG.RANGE);
    if (!live || !live.close) { Logger.log(sym + ': vault ' + v.bars + ' bars · live fetch failed'); return; }
    var lastV = v.close[v.close.length - 1], lastL = live.close[live.close.length - 1];
    var diff = lastL ? Math.abs(lastV - lastL) / lastL : 1;
    Logger.log(sym + ': vault ' + v.bars + ' bars (live ' + live.close.length + ') · last close ' +
      lastV + ' vs ' + Math.round(lastL * 100) / 100 + ' · ' +
      (diff < 0.005 ? 'MATCH' : 'DIVERGED ' + Math.round(diff * 1000) / 10 + '% — run vaultTopUp()'));
  });
}
