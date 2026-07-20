/* ═══════════════════════════════════════════════════════════════════════
   UniverseGate.gs — v1.0 (Tranche engine for universe expansion 438 → 1000)

   PURPOSE
   Grow STOCK_MASTER slowly and steadily, with every candidate screened
   BEFORE admission. No name enters the universe unscreened.

   WHERE IT LIVES
   Add as a new file in the INDICATORS GAS project (the 438-name canon).
   Fully self-contained — every symbol is prefixed ug/UG_. No doGet touch,
   no deployment needed: run ugRunGate() manually from the editor whenever
   you want to process a tranche. Results land in a "GateReport" sheet.

   WHAT ONE RUN DOES
   1. Downloads the LIVE official NSE constituent CSV (UG_INDEX_CSV) —
      never a stale copy.
   2. Diffs it against the current universe (from this project's own
      ?action=universe route, falling back to a STOCK_MASTER global if
      one is in scope).
   3. Takes up to UG_MAX_PER_RUN missing names and screens each against
      2 years of Yahoo daily bars, fetched in parallel batches:
        REJECT — trading gap ≥14 days, ≥25% jump across a gap,
                 <200 bars since a gap, or no data (black-sheep patterns)
        GREY   — clean history but young listing (<200 bars total) or
                 thin liquidity (median vol < UG_MIN_MEDVOL AND median
                 turnover < UG_MIN_TURNOVER)
        ADMIT  — ≥200 clean bars and liquid
   4. Writes the admission report + ready-to-paste snippet lines
      (steam.html STOCK_MASTER format AND a generic JSON line) to the
      GateReport sheet, and logs a summary.

   FUTURE TRANCHES: point UG_INDEX_CSV at ind_niftysmallcap250list.csv,
   then ind_niftymicrocap250_list.csv, and run again. Re-running is safe —
   already-admitted names simply stop appearing in the diff.
   ═══════════════════════════════════════════════════════════════════════ */

var UG_INDEX_CSV = [
  'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv',
  'https://niftyindices.com/IndexConstituent/ind_nifty500list.csv'
];
var UG_SELF_API     = 'https://script.google.com/macros/s/AKfycbzZ6mQ6z50KRcNbFq7zWgY_sTjXOBTi-3GGye8EEWFM8cBX8mwxPmqatZ7edsEIaSw7fw/exec';
var UG_MAX_PER_RUN  = 120;     // stay well inside the 6-minute limit
var UG_BATCH        = 20;      // parallel Yahoo fetches per batch
var UG_GAP_DAYS     = 14;      // suspension fingerprint
var UG_JUMP_PCT     = 0.25;    // restructured-equity fingerprint
var UG_MIN_BARS     = 200;     // trustworthy 200 DMA
var UG_MIN_MEDVOL   = 50000;   // shares/day floor …
var UG_MIN_TURNOVER = 1e7;     // … OR ₹1 Cr/day median turnover
var UG_SHEET        = 'GateReport';

/* ══════════════ PURE FUNCTIONS (Node-tested in test_gate.js) ══════════════ */

/* Parse the NSE constituent CSV → [{name,industry,sym,isin}] (EQ series only). */
function ugParseCsv_(text) {
  var out = [], lines = String(text || '').split(/\r?\n/);
  for (var i = 1; i < lines.length; i++) {              // skip header
    var f = ugSplitCsvLine_(lines[i]);
    if (f.length < 5) continue;
    var sym = String(f[2] || '').trim().toUpperCase();
    var series = String(f[3] || '').trim().toUpperCase();
    if (!sym || series !== 'EQ') continue;
    out.push({ name: String(f[0]).trim(), industry: String(f[1]).trim(), sym: sym, isin: String(f[4]).trim() });
  }
  return out;
}
function ugSplitCsvLine_(line) {
  var f = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { f.push(cur); cur = ''; }
    else cur += c;
  }
  f.push(cur);
  return f;
}

/* Screen one candidate's bars. ts=unix sec asc, close, vol arrays.
   Returns {decision:'ADMIT'|'GREY'|'REJECT', reason, bars, medVol, medTurn}. */
function ugScanBars_(ts, close, vol) {
  var n = ts ? ts.length : 0;
  if (n < 5) return { decision:'REJECT', reason:'no usable price data', bars:n, medVol:0, medTurn:0 };
  var DAY = 86400, lastGap = -1, worstGap = 0;
  for (var i = 1; i < n; i++) {
    var d = (ts[i] - ts[i-1]) / DAY;
    if (d >= UG_GAP_DAYS) {
      lastGap = i; if (d > worstGap) worstGap = d;
      var jump = (close[i-1] > 0 && close[i] > 0) ? Math.abs(close[i] / close[i-1] - 1) : 0;
      if (d >= 7 && jump >= UG_JUMP_PCT)
        return { decision:'REJECT', reason:Math.round(jump*100) + '% price jump across a ' + Math.round(d) + '-day gap — restructured equity', bars:n, medVol:0, medTurn:0 };
    }
  }
  if (lastGap >= 0) {
    var since = n - lastGap;
    if (since < UG_MIN_BARS)
      return { decision:'REJECT', reason:Math.round(worstGap) + '-day trading gap; only ' + since + ' bars since — suspension pattern', bars:n, medVol:0, medTurn:0 };
    return { decision:'REJECT', reason:'trading gap of ' + Math.round(worstGap) + ' days within 2y — needs manual review before admission', bars:n, medVol:0, medTurn:0 };
  }
  var mv = ugMedian_(vol, n), mt = ugMedTurn_(close, vol, n);
  if (n < UG_MIN_BARS)
    return { decision:'GREY', reason:'young listing — only ' + n + ' bars; admit with ⚠, long indicators unreliable', bars:n, medVol:mv, medTurn:mt };
  if (mv < UG_MIN_MEDVOL && mt < UG_MIN_TURNOVER)
    return { decision:'GREY', reason:'thin liquidity — median ' + Math.round(mv).toLocaleString('en-IN') + ' sh/day, ₹' + (mt/1e7).toFixed(2) + ' Cr/day', bars:n, medVol:mv, medTurn:mt };
  return { decision:'ADMIT', reason:'clean — ' + n + ' bars, no gaps, liquid', bars:n, medVol:mv, medTurn:mt };
}
function ugMedian_(vol, n) {
  var v = [], from = Math.max(0, n - 60);
  for (var i = from; i < n; i++) if (vol[i] != null) v.push(vol[i]);
  if (!v.length) return 0;
  v.sort(function(a,b){ return a - b; });
  return v[Math.floor(v.length / 2)];
}
function ugMedTurn_(close, vol, n) {
  var t = [], from = Math.max(0, n - 60);
  for (var i = from; i < n; i++) if (vol[i] != null && close[i] != null) t.push(vol[i] * close[i]);
  if (!t.length) return 0;
  t.sort(function(a,b){ return a - b; });
  return t[Math.floor(t.length / 2)];
}

/* NSE industry string → dashboard sector label (title case, trimmed). */
function ugSector_(industry) {
  var s = String(industry || '').toLowerCase().trim();
  if (!s) return 'NSE Listed';
  return s.replace(/\b\w/g, function(c){ return c.toUpperCase(); })
          .replace(/\bAnd\b/g, '&').replace(/\s+/g, ' ');
}

/* steam.html STOCK_MASTER paste line. */
function ugSnippet_(c) {
  var esc = function(s){ return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); };
  return "  '" + c.sym + "':{n:'" + esc(c.name).replace(/ Ltd\.?$| Limited$/i,'') + "',yf:'" + c.sym + ".NS',s:'" + esc(ugSector_(c.industry)) + "'},";
}

/* ══════════════ GAS-ONLY ORCHESTRATION ══════════════ */

function ugFetchIndexCsv_() {
  for (var i = 0; i < UG_INDEX_CSV.length; i++) {
    try {
      var r = UrlFetchApp.fetch(UG_INDEX_CSV[i], { muteHttpExceptions:true, headers:{ 'User-Agent':'Mozilla/5.0' }, followRedirects:true });
      if (r.getResponseCode() === 200 && r.getContentText().indexOf('Symbol') >= 0) return r.getContentText();
    } catch (e) { /* try next mirror */ }
  }
  throw new Error('could not download the constituent CSV from any source');
}

function ugCurrentUniverse_() {
  try {
    if (typeof STOCK_MASTER !== 'undefined') {
      if (Array.isArray(STOCK_MASTER)) return STOCK_MASTER.map(function(x){ return (x.sym || x).toString().toUpperCase(); });
      return Object.keys(STOCK_MASTER).map(function(k){ return k.toUpperCase(); });
    }
  } catch (e) {}
  var r = UrlFetchApp.fetch(UG_SELF_API + '?action=universe', { muteHttpExceptions:true, followRedirects:true });
  var j = JSON.parse(r.getContentText());
  return (j.universe || []).map(function(u){ return String(u.sym).toUpperCase(); });
}

function ugRunGate() {
  var csv = ugFetchIndexCsv_();
  var all = ugParseCsv_(csv);
  var have = {}, uni = ugCurrentUniverse_();
  uni.forEach(function(s){ have[s] = 1; });
  var missing = all.filter(function(c){ return !have[c.sym]; });
  var take = missing.slice(0, UG_MAX_PER_RUN);
  Logger.log('index list: ' + all.length + ' · current universe: ' + uni.length + ' · missing: ' + missing.length + ' · screening now: ' + take.length);

  var results = [];
  for (var b = 0; b < take.length; b += UG_BATCH) {
    var batch = take.slice(b, b + UG_BATCH);
    var reqs = batch.map(function(c){
      return { url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(c.sym + '.NS') + '?range=2y&interval=1d',
               muteHttpExceptions: true, headers: { 'User-Agent':'Mozilla/5.0' } };
    });
    var resps = UrlFetchApp.fetchAll(reqs);
    for (var k = 0; k < batch.length; k++) {
      var c = batch[k], verdict;
      try {
        if (resps[k].getResponseCode() !== 200) throw new Error('http ' + resps[k].getResponseCode());
        var j = JSON.parse(resps[k].getContentText());
        var r = j.chart && j.chart.result && j.chart.result[0];
        if (!r || !r.timestamp) throw new Error('no series');
        var q = r.indicators.quote[0];
        var adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || q.close;
        var ts = [], cl = [], vo = [];
        for (var z = 0; z < r.timestamp.length; z++) {
          if (adj[z] == null) continue;
          ts.push(r.timestamp[z]); cl.push(adj[z]); vo.push(q.volume ? q.volume[z] : null);
        }
        verdict = ugScanBars_(ts, cl, vo);
      } catch (err) {
        verdict = { decision:'REJECT', reason:'no Yahoo data (' + err.message + ') — possibly suspended or renamed', bars:0, medVol:0, medTurn:0 };
      }
      results.push({ c:c, v:verdict });
    }
    Utilities.sleep(400);   // be polite between batches
  }
  ugWriteReport_(results, all.length, uni.length, missing.length);
}

function ugWriteReport_(results, idxN, uniN, missN) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(UG_SHEET) || ss.insertSheet(UG_SHEET);
  sh.clear();
  var order = { ADMIT:0, GREY:1, REJECT:2 };
  results.sort(function(a,b){
    var d = order[a.v.decision] - order[b.v.decision];
    return d !== 0 ? d : (a.c.sym < b.c.sym ? -1 : 1);
  });
  var rows = [['Run ' + new Date().toISOString().slice(0,16).replace('T',' ') +
               ' · index=' + idxN + ' · universe=' + uniN + ' · missing=' + missN + ' · screened=' + results.length, '', '', '', '', '', '', '', ''],
              ['Symbol','Name','Industry','ISIN','Decision','Reason','MedVol','₹Cr/day','Paste line (steam.html format — Indicators backend: adapt sector field)']];
  var counts = { ADMIT:0, GREY:0, REJECT:0 };
  results.forEach(function(r){
    counts[r.v.decision]++;
    rows.push([ r.c.sym, r.c.name, r.c.industry, r.c.isin, r.v.decision, r.v.reason,
                Math.round(r.v.medVol), Math.round(r.v.medTurn/1e5)/100,
                (r.v.decision === 'REJECT') ? '' : ugSnippet_(r.c) ]);
  });
  rows.push(['SUMMARY', '', '', '', 'ADMIT ' + counts.ADMIT + ' · GREY ' + counts.GREY + ' · REJECT ' + counts.REJECT, '', '', '', '']);
  sh.getRange(1, 1, rows.length, 9).setValues(rows);
  sh.setFrozenRows(2);
  Logger.log('GateReport written: ADMIT ' + counts.ADMIT + ' · GREY ' + counts.GREY + ' · REJECT ' + counts.REJECT);
}
