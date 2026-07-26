/* ═══════════════════════════════════════════════════════════════════════
   UniverseGate.gs — v1.6.1 (resumable tranche engine · embedded+Candidates constituents · tab-aware · self-audit · paste exporter · rebalance reminder)

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
   3. Screens missing names (cap UG_MAX_PER_RUN per tranche) against
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

/* Constituent data is EMBEDDED (NSE slow-walls GAS UrlFetchApp — v1.1 hung
   359s on one request). Snapshot of the official NSE archives lists, taken
   2026-07-20: ind_nifty100list.csv + ind_niftymidcap150list.csv +
   ind_niftysmallcap250list.csv = the complete Nifty 500 (verified: 500
   unique symbols, zero overlap). To refresh after a rebalance: download the
   CSVs in a browser, paste into a sheet named Candidates (that sheet always
   wins over the embedded snapshot), or ask for a regenerated file. */
var UG_EMBEDDED_DATE = '2026-07-20';
var UG_SELF_API     = 'https://script.google.com/macros/s/AKfycbzZ6mQ6z50KRcNbFq7zWgY_sTjXOBTi-3GGye8EEWFM8cBX8mwxPmqatZ7edsEIaSw7fw/exec';
var UG_MAX_PER_RUN  = 250;     // v1.5: Yahoo answers GAS in ~2s/batch, so 250 fits one run easily
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
    if (sym.indexOf('DUMMY') === 0 || String(f[4] || '').trim().toUpperCase().indexOf('DUM') === 0) continue;  // NSE placeholder rows
    out.push({ name: String(f[0]).trim(), industry: String(f[1]).trim(), sym: sym, isin: String(f[4]).trim() });
  }
  return out;
}
function ugSplitCsvLine_(line) {
  /* v1.6: delimiter-flexible — a tab in the line means it was pasted from a
     browser (tab-separated); otherwise split on commas. Handles quoted commas. */
  var delim = (line.indexOf('\t') >= 0) ? '\t' : ',';
  var f = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') q = !q;
    else if (c === delim && !q) { f.push(cur); cur = ''; }
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

/* ══════════════ GAS-ONLY ORCHESTRATION (v1.1 — resumable) ══════════════
   v1.0 timed out at 6 min (slow NSE/Yahoo responses to GAS). v1.1 is a
   checkpointed state machine:
     • every run works inside a 4.5-minute budget, then saves state to a
       hidden GateState sheet and stops cleanly
     • ugRunGate() — run repeatedly; each run resumes where the last stopped
     • ugRunGateAuto() — run ONCE; it re-triggers itself every minute until
       the whole tranche is done, then removes its own trigger
     • every step logs elapsed ms, so if something hangs, the log shows
       exactly which fetch stalled
     • if both CSV mirrors fail, paste the official CSV into a sheet named
       Candidates (raw text in A1 or one line per row) and re-run           */

var UG_DEADLINE_MS = 270000;   // 4.5 min work budget per run
var UG_STATE       = 'GateState';

function ugRunGate()     { ugStep_(false); }
function ugRunGateAuto() { ugStep_(true);  }

function ugStep_(auto) {
  var t0 = Date.now();
  function leftMs(){ return UG_DEADLINE_MS - (Date.now() - t0); }
  function lg(msg){ Logger.log('[' + Math.round((Date.now()-t0)/1000) + 's] ' + msg); }

  var ss = SpreadsheetApp.getActive();
  var st = ss.getSheetByName(UG_STATE);

  /* ── phase 1: build the candidate queue (first run only) ── */
  if (!st || st.getLastRow() < 2) {
    lg('phase 1: downloading constituent CSV…');
    var csv = ugFetchIndexCsv_(lg);
    lg('CSV in hand (' + csv.length + ' chars); parsing…');
    var all = ugParseCsv_(csv);
    lg('parsed ' + all.length + ' EQ constituents; loading current universe…');
    var uni = ugCurrentUniverse_();
    lg('universe has ' + uni.length + ' names; diffing…');
    var have = {}; uni.forEach(function(s){ have[s] = 1; });
    var missing = all.filter(function(c){ return !have[c.sym]; }).slice(0, UG_MAX_PER_RUN);
    var oldRep = ss.getSheetByName(UG_SHEET); if (oldRep) oldRep.clear();   // v1.4.4: fresh tranche = fresh report (no more append-duplicates)
    st = st || ss.insertSheet(UG_STATE); st.hideSheet(); st.clear();
    var rows = [['sym','name','industry','isin']];
    missing.forEach(function(c){ rows.push([c.sym, c.name, c.industry, c.isin]); });
    st.getRange(1, 1, rows.length, 4).setValues(rows);
    ugMeta_(ss, { idxN: all.length, uniN: uni.length, missN: missing.length });
    lg('queue built: ' + missing.length + ' candidates to screen. ' +
       (auto ? 'auto-resuming…' : 'Run ugRunGate again to start screening.'));
    if (auto) ugChain_();
    if (!auto || leftMs() < 60000) return;
  }

  /* ── phase 2: screen the next chunk(s) within budget ── */
  var pending = st.getRange(2, 1, Math.max(st.getLastRow() - 1, 1), 4).getValues()
    .filter(function(r){ return r[0]; })
    .map(function(r){ return { sym:String(r[0]), name:String(r[1]), industry:String(r[2]), isin:String(r[3]) }; });
  lg('phase 2: ' + pending.length + ' candidates pending');

  var done = 0;
  while (pending.length && leftMs() > 45000) {
    var batch = pending.slice(0, UG_BATCH);
    var bt = Date.now();
    var reqs = batch.map(function(c){
      return { url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(c.sym + '.NS') + '?range=2y&interval=1d',
               muteHttpExceptions: true, headers: { 'User-Agent':'Mozilla/5.0' } };
    });
    var resps;
    try { resps = UrlFetchApp.fetchAll(reqs); }
    catch (err) { lg('fetchAll failed (' + err.message + ') — stopping this run; state saved'); break; }
    var results = [];
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
      } catch (err2) {
        verdict = { decision:'REJECT', reason:'no Yahoo data (' + err2.message + ') — possibly suspended or renamed', bars:0, medVol:0, medTurn:0 };
      }
      results.push({ c:c, v:verdict });
    }
    ugAppendResults_(ss, results);
    pending = pending.slice(batch.length);
    done += batch.length;
    lg('batch of ' + batch.length + ' screened in ' + (Date.now() - bt) + 'ms · ' + pending.length + ' left');
    Utilities.sleep(300);
  }

  /* ── save remaining state or finish ── */
  st.clear();
  if (pending.length) {
    var rows2 = [['sym','name','industry','isin']];
    pending.forEach(function(c){ rows2.push([c.sym, c.name, c.industry, c.isin]); });
    st.getRange(1, 1, rows2.length, 4).setValues(rows2);
    lg('budget used: screened ' + done + ' this run, ' + pending.length + ' remain. ' +
       (auto ? 'auto-resuming in ~1 min…' : 'Run ugRunGate again to continue.'));
    if (auto) ugChain_();
  } else {
    ugFinalize_(ss);
    ugUnchain_();
    lg('tranche complete — see the GateReport sheet.');
  }
}

/* ── incremental report writing ── */
function ugAppendResults_(ss, results) {
  var sh = ss.getSheetByName(UG_SHEET) || ss.insertSheet(UG_SHEET);
  if (sh.getLastRow() === 0)
    sh.getRange(1, 1, 1, 9).setValues([['Symbol','Name','Industry','ISIN','Decision','Reason','MedVol','₹Cr/day','Paste line (steam.html format — Indicators backend: adapt sector field)']]);
  var rows = results.map(function(r){
    return [ r.c.sym, r.c.name, r.c.industry, r.c.isin, r.v.decision, r.v.reason,
             Math.round(r.v.medVol), Math.round(r.v.medTurn/1e5)/100,
             (r.v.decision === 'REJECT') ? '' : ugSnippet_(r.c) ];
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
}

function ugFinalize_(ss) {
  var sh = ss.getSheetByName(UG_SHEET); if (!sh || sh.getLastRow() < 2) return;
  var n = sh.getLastRow() - 1;
  var data = sh.getRange(2, 1, n, 9).getValues();
  var order = { ADMIT:0, GREY:1, REJECT:2 };
  data.sort(function(a,b){
    var d = (order[a[4]] != null ? order[a[4]] : 3) - (order[b[4]] != null ? order[b[4]] : 3);
    return d !== 0 ? d : (a[0] < b[0] ? -1 : 1);
  });
  var counts = { ADMIT:0, GREY:0, REJECT:0 };
  data.forEach(function(r){ if (counts[r[4]] != null) counts[r[4]]++; });
  sh.getRange(2, 1, n, 9).setValues(data);
  var meta = ugMeta_(ss) || {};
  sh.getRange(sh.getLastRow() + 1, 1, 1, 9).setValues([[
    'SUMMARY', new Date().toISOString().slice(0,16).replace('T',' '),
    'index=' + (meta.idxN || '?'), 'universe=' + (meta.uniN || '?'),
    'ADMIT ' + counts.ADMIT + ' · GREY ' + counts.GREY + ' · REJECT ' + counts.REJECT,
    'missing=' + (meta.missN || '?'), '', '', '' ]]);
  sh.setFrozenRows(1);
  Logger.log('SUMMARY — ADMIT ' + counts.ADMIT + ' · GREY ' + counts.GREY + ' · REJECT ' + counts.REJECT);
}

/* ── meta, trigger chain, CSV helpers ── */
function ugMeta_(ss, set) {
  var p = PropertiesService.getScriptProperties();
  if (set) { p.setProperty('UG_META', JSON.stringify(set)); return set; }
  try { return JSON.parse(p.getProperty('UG_META') || 'null'); } catch (e) { return null; }
}
function ugChain_() {
  ugUnchain_();
  ScriptApp.newTrigger('ugAutoResume_').timeBased().after(60 * 1000).create();
}
function ugUnchain_() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'ugAutoResume_') ScriptApp.deleteTrigger(t);
  });
}
function ugAutoResume_() { ugStep_(true); }

function ugFetchIndexCsv_(lg) {
  /* the Candidates sheet always wins (freshest, manually pasted after a rebalance) */
  var sh = SpreadsheetApp.getActive().getSheetByName('Candidates');
  if (sh && sh.getLastRow() > 0) {
    /* v1.6.1: read ALL columns and rejoin — robust to Sheets spreading a
       tab/comma paste across columns A–E. If a row already lives entirely in
       column A (single cell), the trailing empties are dropped and it passes
       through unchanged. */
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var vals = sh.getRange(1, 1, sh.getLastRow(), lastCol).getValues();
    var lines = vals.map(function(row){
      var cells = row.map(function(c){ return (c === null || c === undefined) ? '' : String(c); });
      while (cells.length && cells[cells.length - 1] === '') cells.pop();   // trim trailing empties
      return (cells.length <= 1) ? (cells[0] || '') : cells.join(',');       // multi-col → comma-join
    }).filter(function(l){ return l.trim(); });
    if (lg) lg('using pasted CSV from the Candidates sheet (' + lines.length + ' rows, ' + lastCol + ' cols)');
    return lines.join('\n');
  }
  if (lg) lg('using embedded Nifty 500 snapshot dated ' + UG_EMBEDDED_DATE);
  return UG_EMBEDDED_CSV;
}

function ugCurrentUniverse_() {
  try {
    if (typeof UNIVERSE === 'string') {   // v1.4.3: Indicators backend — read the local constant (reflects a paste immediately on save, no redeploy needed)
      return UNIVERSE.split('\n').map(function(r){ return String(r.split('|')[0] || '').toUpperCase().trim(); }).filter(function(s){ return s; });
    }
    if (typeof STOCK_MASTER !== 'undefined') {
      if (Array.isArray(STOCK_MASTER)) return STOCK_MASTER.map(function(x){ return (x.sym || x).toString().toUpperCase(); });
      return Object.keys(STOCK_MASTER).map(function(k){ return k.toUpperCase(); });
    }
  } catch (e) {}
  var r = UrlFetchApp.fetch(UG_SELF_API + '?action=universe', { muteHttpExceptions:true, followRedirects:true });
  var j = JSON.parse(r.getContentText());
  return (j.universe || []).map(function(u){ return String(u.sym).toUpperCase(); });
}

/* Reset everything and start a tranche from scratch. */
function ugResetGate() {
  var ss = SpreadsheetApp.getActive();
  ['GateState', UG_SHEET, 'UniverseAudit'].forEach(function(name){
    try {
      var sh = ss.getSheetByName(name);
      if (!sh) return;
      try { ss.deleteSheet(sh); }
      catch (e) { sh.clear(); }          // v1.5.1: stale-reference quirk — clearing is as good as deleting for our purposes
    } catch (e2) { /* sheet vanished mid-loop — fine */ }
  });
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().deleteProperty('UG_META');
  ugUnchain_();
  Logger.log('gate reset — next ugRunGate/ugRunGateAuto starts fresh');
}

/* ── embedded official constituent snapshot (500 rows, 2026-07-20) ── */
var UG_EMBEDDED_CSV = "Company Name,Industry,Symbol,Series,ISIN Code\n360 ONE WAM Ltd.,Financial Services,360ONE,EQ,INE466L01038\n3M India Ltd.,Diversified,3MINDIA,EQ,INE470A01017\nAadhar Housing Finance Ltd.,Financial Services,AADHARHFC,EQ,INE883F01010\nAarti Industries Ltd.,Chemicals,AARTIIND,EQ,INE769A01020\nAavas Financiers Ltd.,Financial Services,AAVAS,EQ,INE216P01012\nABB India Ltd.,Capital Goods,ABB,EQ,INE117A01022\nAbbott India Ltd.,Healthcare,ABBOTINDIA,EQ,INE358A01014\nAditya Birla Capital Ltd.,Financial Services,ABCAPITAL,EQ,INE674K01013\nAllied Blenders and Distillers Ltd.,Fast Moving Consumer Goods,ABDL,EQ,INE552Z01027\nAditya Birla Fashion and Retail Ltd.,Consumer Services,ABFRL,EQ,INE647O01011\nAditya Birla Lifestyle Brands Ltd.,Consumer Services,ABLBL,EQ,INE14LE01019\nAditya Birla Real Estate Ltd.,Realty,ABREL,EQ,INE055A01016\nAditya Birla Sun Life AMC Ltd.,Financial Services,ABSLAMC,EQ,INE404A01024\nACC Ltd.,Construction Materials,ACC,EQ,INE012A01025\nAction Construction Equipment Ltd.,Capital Goods,ACE,EQ,INE731H01025\nACME Solar Holdings Ltd.,Power,ACMESOLAR,EQ,INE622W01025\nAcutaas Chemicals Ltd.,Healthcare,ACUTAAS,EQ,INE00FF01025\nAdani Energy Solutions Ltd.,Power,ADANIENSOL,EQ,INE931S01010\nAdani Enterprises Ltd.,Metals & Mining,ADANIENT,EQ,INE423A01024\nAdani Green Energy Ltd.,Power,ADANIGREEN,EQ,INE364U01010\nAdani Ports and Special Economic Zone Ltd.,Services,ADANIPORTS,EQ,INE742F01042\nAdani Power Ltd.,Power,ADANIPOWER,EQ,INE814H01029\nAegis Logistics Ltd.,Oil Gas & Consumable Fuels,AEGISLOG,EQ,INE208C01025\nAegis Vopak Terminals Ltd.,Oil Gas & Consumable Fuels,AEGISVOPAK,EQ,INE0INX01018\nAfcons Infrastructure Ltd.,Construction,AFCONS,EQ,INE101I01011\nAffle 3i Ltd.,Information Technology,AFFLE,EQ,INE00WC01027\nAIA Engineering Ltd.,Capital Goods,AIAENG,EQ,INE212H01026\nAuthum Investment & Infrastructure Ltd.,Financial Services,AIIL,EQ,INE206F01022\nAjanta Pharmaceuticals Ltd.,Healthcare,AJANTPHARM,EQ,INE031B01049\nAlkem Laboratories Ltd.,Healthcare,ALKEM,EQ,INE540L01014\nAmber Enterprises India Ltd.,Consumer Durables,AMBER,EQ,INE371P01015\nAmbuja Cements Ltd.,Construction Materials,AMBUJACEM,EQ,INE079A01024\nAnand Rathi Wealth Ltd.,Financial Services,ANANDRATHI,EQ,INE463V01026\nAnant Raj Ltd.,Realty,ANANTRAJ,EQ,INE242C01024\nAngel One Ltd.,Financial Services,ANGELONE,EQ,INE732I01021\nAnthem Biosciences Ltd.,Healthcare,ANTHEM,EQ,INE0CZ201020\nAnupam Rasayan India Ltd.,Chemicals,ANURAS,EQ,INE930P01018\nApar Industries Ltd.,Capital Goods,APARINDS,EQ,INE372A01015\nAPL Apollo Tubes Ltd.,Capital Goods,APLAPOLLO,EQ,INE702C01027\nApollo Hospitals Enterprise Ltd.,Healthcare,APOLLOHOSP,EQ,INE437A01024\nApollo Tyres Ltd.,Automobile and Auto Components,APOLLOTYRE,EQ,INE438A01022\nAptus Value Housing Finance India Ltd.,Financial Services,APTUS,EQ,INE852O01025\nAmara Raja Energy & Mobility Ltd.,Automobile and Auto Components,ARE&M,EQ,INE885A01032\nAsahi India Glass Ltd.,Automobile and Auto Components,ASAHIINDIA,EQ,INE439A01020\nAshok Leyland Ltd.,Capital Goods,ASHOKLEY,EQ,INE208A01029\nAsian Paints Ltd.,Consumer Durables,ASIANPAINT,EQ,INE021A01026\nAster DM Healthcare Ltd.,Healthcare,ASTERDM,EQ,INE914M01019\nAstral Ltd.,Capital Goods,ASTRAL,EQ,INE006I01046\nAdani Total Gas Ltd.,Oil Gas & Consumable Fuels,ATGL,EQ,INE399L01023\nAther Energy Ltd.,Automobile and Auto Components,ATHERENERG,EQ,INE0LEZ01016\nAtul Ltd.,Chemicals,ATUL,EQ,INE100A01010\nAU Small Finance Bank Ltd.,Financial Services,AUBANK,EQ,INE949L01017\nAurobindo Pharma Ltd.,Healthcare,AUROPHARMA,EQ,INE406A01037\nAWL Agri Business Ltd.,Fast Moving Consumer Goods,AWL,EQ,INE699H01024\nAxis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034\nBajaj Auto Ltd.,Automobile and Auto Components,BAJAJ-AUTO,EQ,INE917I01010\nBajaj Finserv Ltd.,Financial Services,BAJAJFINSV,EQ,INE918I01026\nBajaj Housing Finance Ltd.,Financial Services,BAJAJHFL,EQ,INE377Y01014\nBajaj Holdings & Investment Ltd.,Financial Services,BAJAJHLDNG,EQ,INE118A01012\nBajaj Finance Ltd.,Financial Services,BAJFINANCE,EQ,INE296A01032\nBalkrishna Industries Ltd.,Automobile and Auto Components,BALKRISIND,EQ,INE787D01026\nBalrampur Chini Mills Ltd.,Fast Moving Consumer Goods,BALRAMCHIN,EQ,INE119A01028\nBandhan Bank Ltd.,Financial Services,BANDHANBNK,EQ,INE545U01014\nBank of Baroda,Financial Services,BANKBARODA,EQ,INE028A01039\nBank of India,Financial Services,BANKINDIA,EQ,INE084A01016\nBata India Ltd.,Consumer Durables,BATAINDIA,EQ,INE176A01028\nBayer Cropscience Ltd.,Chemicals,BAYERCROP,EQ,INE462A01022\nBombay Burmah Trading Corporation Ltd.,Fast Moving Consumer Goods,BBTC,EQ,INE050A01025\nBharat Dynamics Ltd.,Capital Goods,BDL,EQ,INE171Z01026\nBharat Electronics Ltd.,Capital Goods,BEL,EQ,INE263A01024\nBelrise Industries Ltd.,Automobile and Auto Components,BELRISE,EQ,INE894V01022\nBEML Ltd.,Capital Goods,BEML,EQ,INE258A01024\nBerger Paints India Ltd.,Consumer Durables,BERGEPAINT,EQ,INE463A01038\nBharat Forge Ltd.,Automobile and Auto Components,BHARATFORG,EQ,INE465A01025\nBharti Airtel Ltd.,Telecommunication,BHARTIARTL,EQ,INE397D01024\nBharti Hexacom Ltd.,Telecommunication,BHARTIHEXA,EQ,INE343G01021\nBharat Heavy Electricals Ltd.,Capital Goods,BHEL,EQ,INE257A01026\nBikaji Foods International Ltd.,Fast Moving Consumer Goods,BIKAJI,EQ,INE00E101023\nBiocon Ltd.,Healthcare,BIOCON,EQ,INE376G01013\nBLS International Services Ltd.,Consumer Services,BLS,EQ,INE153T01027\nBlue Dart Express Ltd.,Services,BLUEDART,EQ,INE233B01017\nBlue Jet Healthcare Ltd.,Healthcare,BLUEJET,EQ,INE0KBH01020\nBlue Star Ltd.,Consumer Durables,BLUESTARCO,EQ,INE472A01039\nBosch Ltd.,Automobile and Auto Components,BOSCHLTD,EQ,INE323A01026\nBharat Petroleum Corporation Ltd.,Oil Gas & Consumable Fuels,BPCL,EQ,INE029A01011\nBrigade Enterprises Ltd.,Realty,BRIGADE,EQ,INE791I01019\nBritannia Industries Ltd.,Fast Moving Consumer Goods,BRITANNIA,EQ,INE216A01030\nBSE Ltd.,Financial Services,BSE,EQ,INE118H01025\nBirlasoft Ltd.,Information Technology,BSOFT,EQ,INE836A01035\nComputer Age Management Services Ltd.,Financial Services,CAMS,EQ,INE596I01020\nCanara Bank,Financial Services,CANBK,EQ,INE476A01022\nCan Fin Homes Ltd.,Financial Services,CANFINHOME,EQ,INE477A01020\nCanara HSBC Life Insurance Company Ltd.,Financial Services,CANHLIFE,EQ,INE01TY01017\nCaplin Point Laboratories Ltd.,Healthcare,CAPLIPOINT,EQ,INE475E01026\nCarborundum Universal Ltd.,Capital Goods,CARBORUNIV,EQ,INE120A01034\nCartrade Tech Ltd.,Consumer Services,CARTRADE,EQ,INE290S01011\nCastrol India Ltd.,Oil Gas & Consumable Fuels,CASTROLIND,EQ,INE172A01027\nCCL Products (I) Ltd.,Fast Moving Consumer Goods,CCL,EQ,INE421D01022\nCentral Depository Services (India) Ltd.,Financial Services,CDSL,EQ,INE736A01011\nCeat Ltd.,Automobile and Auto Components,CEATLTD,EQ,INE482A01020\nCemindia Projects Ltd.,Construction,CEMPRO,EQ,INE686A01026\nCentral Bank of India,Financial Services,CENTRALBK,EQ,INE483A01010\nCESC Ltd.,Power,CESC,EQ,INE486A01021\nCapri Global Capital Ltd.,Financial Services,CGCL,EQ,INE180C01042\nCG Power and Industrial Solutions Ltd.,Capital Goods,CGPOWER,EQ,INE067A01029\nChalet Hotels Ltd.,Consumer Services,CHALET,EQ,INE427F01016\nChambal Fertilizers & Chemicals Ltd.,Chemicals,CHAMBLFERT,EQ,INE085A01013\nChennai Petroleum Corporation Ltd.,Oil Gas & Consumable Fuels,CHENNPETRO,EQ,INE178A01016\nChoice International Ltd.,Financial Services,CHOICEIN,EQ,INE102B01014\nCholamandalam Investment and Finance Company Ltd.,Financial Services,CHOLAFIN,EQ,INE121A01024\nCholamandalam Financial Holdings Ltd.,Financial Services,CHOLAHLDNG,EQ,INE149A01033\nCIE Automotive India Ltd.,Automobile and Auto Components,CIEINDIA,EQ,INE536H01010\nCipla Ltd.,Healthcare,CIPLA,EQ,INE059A01026\nClean Science and Technology Ltd.,Chemicals,CLEAN,EQ,INE227W01023\nCoal India Ltd.,Oil Gas & Consumable Fuels,COALINDIA,EQ,INE522F01014\nCochin Shipyard Ltd.,Capital Goods,COCHINSHIP,EQ,INE704P01025\nCoforge Ltd.,Information Technology,COFORGE,EQ,INE591G01025\nCohance Lifesciences Ltd.,Healthcare,COHANCE,EQ,INE03QK01018\nColgate Palmolive (India) Ltd.,Fast Moving Consumer Goods,COLPAL,EQ,INE259A01022\nContainer Corporation of India Ltd.,Services,CONCOR,EQ,INE111A01025\nConcord Biotech Ltd.,Healthcare,CONCORDBIO,EQ,INE338H01029\nCoromandel International Ltd.,Chemicals,COROMANDEL,EQ,INE169A01031\nAditya Infotech Ltd.,Capital Goods,CPPLUS,EQ,INE819V01029\nCraftsman Automation Ltd.,Automobile and Auto Components,CRAFTSMAN,EQ,INE00LO01017\nCreditAccess Grameen Ltd.,Financial Services,CREDITACC,EQ,INE741K01010\nCRISIL Ltd.,Financial Services,CRISIL,EQ,INE007A01025\nCrompton Greaves Consumer Electricals Ltd.,Consumer Durables,CROMPTON,EQ,INE299U01018\nCity Union Bank Ltd.,Financial Services,CUB,EQ,INE491A01021\nCummins India Ltd.,Capital Goods,CUMMINSIND,EQ,INE298A01020\nCyient Ltd.,Information Technology,CYIENT,EQ,INE136B01020\nDabur India Ltd.,Fast Moving Consumer Goods,DABUR,EQ,INE016A01026\nDalmia Bharat Ltd.,Construction Materials,DALBHARAT,EQ,INE00R701025\nData Patterns (India) Ltd.,Capital Goods,DATAPATTNS,EQ,INE0IX101010\nDCM Shriram Ltd.,Diversified,DCMSHRIRAM,EQ,INE499A01024\nDeepak Fertilisers & Petrochemicals Corp. Ltd.,Chemicals,DEEPAKFERT,EQ,INE501A01019\nDeepak Nitrite Ltd.,Chemicals,DEEPAKNTR,EQ,INE288B01029\nDelhivery Ltd.,Services,DELHIVERY,EQ,INE148O01028\nDevyani International Ltd.,Consumer Services,DEVYANI,EQ,INE872J01023\nDivi's Laboratories Ltd.,Healthcare,DIVISLAB,EQ,INE361B01024\nDixon Technologies (India) Ltd.,Consumer Durables,DIXON,EQ,INE935N01020\nDLF Ltd.,Realty,DLF,EQ,INE271C01023\nAvenue Supermarts Ltd.,Consumer Services,DMART,EQ,INE192R01011\nDOMS Industries Ltd.,Fast Moving Consumer Goods,DOMS,EQ,INE321T01012\nDr. Reddy's Laboratories Ltd.,Healthcare,DRREDDY,EQ,INE089A01031\neClerx Services Ltd.,Services,ECLERX,EQ,INE738I01010\nEicher Motors Ltd.,Automobile and Auto Components,EICHERMOT,EQ,INE066A01021\nE.I.D. Parry (India) Ltd.,Fast Moving Consumer Goods,EIDPARRY,EQ,INE126A01031\nEIH Ltd.,Consumer Services,EIHOTEL,EQ,INE230A01023\nElecon Engineering Co. Ltd.,Capital Goods,ELECON,EQ,INE205B01031\nElgi Equipments Ltd.,Capital Goods,ELGIEQUIP,EQ,INE285A01027\nEmami Ltd.,Fast Moving Consumer Goods,EMAMILTD,EQ,INE548C01032\nEmcure Pharmaceuticals Ltd.,Healthcare,EMCURE,EQ,INE168P01015\nEmmvee Photovoltaic Power Ltd.,Capital Goods,EMMVEE,EQ,INE1C6T01020\nEndurance Technologies Ltd.,Automobile and Auto Components,ENDURANCE,EQ,INE913H01037\nEngineers India Ltd.,Construction,ENGINERSIN,EQ,INE510A01028\nSiemens Energy India Ltd.,Capital Goods,ENRIN,EQ,INE1NPP01017\nEris Lifesciences Ltd.,Healthcare,ERIS,EQ,INE406M01024\nEscorts Kubota Ltd.,Capital Goods,ESCORTS,EQ,INE042A01014\nEternal Ltd.,Consumer Services,ETERNAL,EQ,INE758T01015\nExide Industries Ltd.,Automobile and Auto Components,EXIDEIND,EQ,INE302A01020\nFertilisers and Chemicals Travancore Ltd.,Chemicals,FACT,EQ,INE188A01015\nFederal Bank Ltd.,Financial Services,FEDERALBNK,EQ,INE171A01029\nFinolex Cables Ltd.,Capital Goods,FINCABLES,EQ,INE235A01022\nBrainbees Solutions Ltd.,Consumer Services,FIRSTCRY,EQ,INE02RE01045\nFive-Star Business Finance Ltd.,Financial Services,FIVESTAR,EQ,INE128S01021\nGujarat Fluorochemicals Ltd.,Chemicals,FLUOROCHEM,EQ,INE09N301011\nForce Motors Ltd.,Automobile and Auto Components,FORCEMOT,EQ,INE451A01017\nFortis Healthcare Ltd.,Healthcare,FORTIS,EQ,INE061F01013\nFirstsource Solutions Ltd.,Services,FSL,EQ,INE684F01012\nGabriel India Ltd.,Automobile and Auto Components,GABRIEL,EQ,INE524A01029\nGAIL (India) Ltd.,Oil Gas & Consumable Fuels,GAIL,EQ,INE129A01019\nGallantt Ispat Ltd.,Capital Goods,GALLANTT,EQ,INE297H01019\nGreat Eastern Shipping Co. Ltd.,Services,GESHIP,EQ,INE017A01032\nGeneral Insurance Corporation of India,Financial Services,GICRE,EQ,INE481Y01014\nGillette India Ltd.,Fast Moving Consumer Goods,GILLETTE,EQ,INE322A01010\nGland Pharma Ltd.,Healthcare,GLAND,EQ,INE068V01023\nGlaxosmithkline Pharmaceuticals Ltd.,Healthcare,GLAXO,EQ,INE159A01016\nGlenmark Pharmaceuticals Ltd.,Healthcare,GLENMARK,EQ,INE935A01035\nGujarat Mineral Development Corporation Ltd.,Metals & Mining,GMDCLTD,EQ,INE131A01031\nGMR Airports Ltd.,Services,GMRAIRPORT,EQ,INE776C01039\nGodfrey Phillips India Ltd.,Fast Moving Consumer Goods,GODFRYPHLP,EQ,INE260B01028\nGo Digit General Insurance Ltd.,Financial Services,GODIGIT,EQ,INE03JT01014\nGodrej Consumer Products Ltd.,Fast Moving Consumer Goods,GODREJCP,EQ,INE102D01028\nGodrej Industries Ltd.,Diversified,GODREJIND,EQ,INE233A01035\nGodrej Properties Ltd.,Realty,GODREJPROP,EQ,INE484J01027\nGodawari Power & Ispat Ltd.,Capital Goods,GPIL,EQ,INE177H01039\nGranules India Ltd.,Healthcare,GRANULES,EQ,INE101D01020\nGraphite India Ltd.,Capital Goods,GRAPHITE,EQ,INE371A01025\nGrasim Industries Ltd.,Construction Materials,GRASIM,EQ,INE047A01021\nGravita India Ltd.,Metals & Mining,GRAVITA,EQ,INE024L01027\nBillionbrains Garage Ventures Ltd.,Financial Services,GROWW,EQ,INE0HOQ01053\nGarden Reach Shipbuilders & Engineers Ltd.,Capital Goods,GRSE,EQ,INE382Z01011\nGE Vernova T&D India Ltd.,Capital Goods,GVT&D,EQ,INE200A01026\nHindustan Aeronautics Ltd.,Capital Goods,HAL,EQ,INE066F01020\nHavells India Ltd.,Consumer Durables,HAVELLS,EQ,INE176B01034\nHBL Engineering Ltd.,Capital Goods,HBLENGINE,EQ,INE292B01021\nHCL Technologies Ltd.,Information Technology,HCLTECH,EQ,INE860A01027\nHDB Financial Services Ltd.,Financial Services,HDBFS,EQ,INE756I01012\nHDFC Asset Management Company Ltd.,Financial Services,HDFCAMC,EQ,INE127D01025\nHDFC Bank Ltd.,Financial Services,HDFCBANK,EQ,INE040A01034\nHDFC Life Insurance Company Ltd.,Financial Services,HDFCLIFE,EQ,INE795G01014\nH.E.G. Ltd.,Capital Goods,HEG,EQ,INE545A01024\nHero MotoCorp Ltd.,Automobile and Auto Components,HEROMOTOCO,EQ,INE158A01026\nHexaware Technologies Ltd.,Information Technology,HEXT,EQ,INE093A01041\nHFCL Ltd.,Telecommunication,HFCL,EQ,INE548A01028\nHindalco Industries Ltd.,Metals & Mining,HINDALCO,EQ,INE038A01020\nHindustan Copper Ltd.,Metals & Mining,HINDCOPPER,EQ,INE531E01026\nHindustan Petroleum Corporation Ltd.,Oil Gas & Consumable Fuels,HINDPETRO,EQ,INE094A01015\nHindustan Unilever Ltd.,Fast Moving Consumer Goods,HINDUNILVR,EQ,INE030A01027\nHindustan Zinc Ltd.,Metals & Mining,HINDZINC,EQ,INE267A01025\nHome First Finance Company India Ltd.,Financial Services,HOMEFIRST,EQ,INE481N01025\nHonasa Consumer Ltd.,Fast Moving Consumer Goods,HONASA,EQ,INE0J5401028\nHoneywell Automation India Ltd.,Capital Goods,HONAUT,EQ,INE671A01010\nHimadri Speciality Chemical Ltd.,Chemicals,HSCL,EQ,INE019C01026\nHousing & Urban Development Corporation Ltd.,Financial Services,HUDCO,EQ,INE031A01017\nHyundai Motor India Ltd.,Automobile and Auto Components,HYUNDAI,EQ,INE0V6F01027\nICICI Prudential Asset Management Company Ltd.,Financial Services,ICICIAMC,EQ,INE346A01027\nICICI Bank Ltd.,Financial Services,ICICIBANK,EQ,INE090A01021\nICICI Lombard General Insurance Company Ltd.,Financial Services,ICICIGI,EQ,INE765G01017\nICICI Prudential Life Insurance Company Ltd.,Financial Services,ICICIPRULI,EQ,INE726G01019\nIDBI Bank Ltd.,Financial Services,IDBI,EQ,INE008A01015\nVodafone Idea Ltd.,Telecommunication,IDEA,EQ,INE669E01016\nIDFC First Bank Ltd.,Financial Services,IDFCFIRSTB,EQ,INE092T01019\nIndian Energy Exchange Ltd.,Financial Services,IEX,EQ,INE022Q01020\nIFCI Ltd.,Financial Services,IFCI,EQ,INE039A01010\nInternational Gemological Institute Ltd.,Services,IGIL,EQ,INE0Q9301021\nIndraprastha Gas Ltd.,Oil Gas & Consumable Fuels,IGL,EQ,INE203G01027\nIIFL Finance Ltd.,Financial Services,IIFL,EQ,INE530B01024\nInventurus Knowledge Solutions Ltd.,Information Technology,IKS,EQ,INE115Q01022\nIndegene Ltd.,Healthcare,INDGN,EQ,INE065X01017\nIndian Hotels Co. Ltd.,Consumer Services,INDHOTEL,EQ,INE053A01029\nIndia Cements Ltd.,Construction Materials,INDIACEM,EQ,INE383A01012\nIndiamart Intermesh Ltd.,Consumer Services,INDIAMART,EQ,INE933S01016\nIndian Bank,Financial Services,INDIANB,EQ,INE562A01011\nInterGlobe Aviation Ltd.,Services,INDIGO,EQ,INE646L01027\nIndusInd Bank Ltd.,Financial Services,INDUSINDBK,EQ,INE095A01012\nIndus Towers Ltd.,Telecommunication,INDUSTOWER,EQ,INE121J01017\nInfosys Ltd.,Information Technology,INFY,EQ,INE009A01021\nInox Wind Ltd.,Capital Goods,INOXWIND,EQ,INE066P01011\nIntellect Design Arena Ltd.,Information Technology,INTELLECT,EQ,INE306R01017\nIndian Overseas Bank,Financial Services,IOB,EQ,INE565A01014\nIndian Oil Corporation Ltd.,Oil Gas & Consumable Fuels,IOC,EQ,INE242A01010\nIpca Laboratories Ltd.,Healthcare,IPCALAB,EQ,INE571A01038\nIRB Infrastructure Developers Ltd.,Construction,IRB,EQ,INE821I01022\nIRCON International Ltd.,Construction,IRCON,EQ,INE962Y01021\nIndian Railway Catering And Tourism Corporation Ltd.,Consumer Services,IRCTC,EQ,INE335Y01020\nIndian Renewable Energy Development Agency Ltd.,Financial Services,IREDA,EQ,INE202E01016\nIndian Railway Finance Corporation Ltd.,Financial Services,IRFC,EQ,INE053F01010\nITC Ltd.,Fast Moving Consumer Goods,ITC,EQ,INE154A01025\nITC Hotels Ltd.,Consumer Services,ITCHOTELS,EQ,INE379A01028\nITI Ltd.,Telecommunication,ITI,EQ,INE248A01017\nJammu & Kashmir Bank Ltd.,Financial Services,J&KBANK,EQ,INE168A01041\nJain Resource Recycling Ltd.,Metals & Mining,JAINREC,EQ,INE0YD401026\nJ.B. Chemicals & Pharmaceuticals Ltd.,Healthcare,JBCHEPHARM,EQ,INE572A01036\nJBM Auto Ltd.,Automobile and Auto Components,JBMA,EQ,INE927D01051\nJindal Saw Ltd.,Capital Goods,JINDALSAW,EQ,INE324A01032\nJindal Steel Ltd.,Metals & Mining,JINDALSTEL,EQ,INE749A01030\nJio Financial Services Ltd.,Financial Services,JIOFIN,EQ,INE758E01017\nJ.K. Cement Ltd.,Construction Materials,JKCEMENT,EQ,INE823G01014\nJK Tyre & Industries Ltd.,Automobile and Auto Components,JKTYRE,EQ,INE573A01042\nJM Financial Ltd.,Financial Services,JMFINANCIL,EQ,INE780C01023\nJaiprakash Power Ventures Ltd.,Power,JPPOWER,EQ,INE351F01018\nJindal Stainless Ltd.,Metals & Mining,JSL,EQ,INE220G01021\nJSW Cement Ltd.,Construction Materials,JSWCEMENT,EQ,INE718I01012\nJSW Dulux Ltd.,Consumer Durables,JSWDULUX,EQ,INE133A01011\nJSW Energy Ltd.,Power,JSWENERGY,EQ,INE121E01018\nJSW Infrastructure Ltd.,Services,JSWINFRA,EQ,INE880J01026\nJSW Steel Ltd.,Metals & Mining,JSWSTEEL,EQ,INE019A01038\nJubilant Foodworks Ltd.,Consumer Services,JUBLFOOD,EQ,INE797F01020\nJubilant Ingrevia Ltd.,Chemicals,JUBLINGREA,EQ,INE0BY001018\nJubilant Pharmova Ltd.,Healthcare,JUBLPHARMA,EQ,INE700A01033\nJupiter Wagons Ltd.,Capital Goods,JWL,EQ,INE209L01016\nJyoti CNC Automation Ltd.,Capital Goods,JYOTICNC,EQ,INE980O01024\nKajaria Ceramics Ltd.,Consumer Durables,KAJARIACER,EQ,INE217B01036\nKalyan Jewellers India Ltd.,Consumer Durables,KALYANKJIL,EQ,INE303R01014\nKarur Vysya Bank Ltd.,Financial Services,KARURVYSYA,EQ,INE036D01028\nKaynes Technology India Ltd.,Capital Goods,KAYNES,EQ,INE918Z01012\nKec International Ltd.,Construction,KEC,EQ,INE389H01022\nKEI Industries Ltd.,Capital Goods,KEI,EQ,INE878B01027\nKfin Technologies Ltd.,Financial Services,KFINTECH,EQ,INE138Y01010\nKrishna Institute of Medical Sciences Ltd.,Healthcare,KIMS,EQ,INE967H01025\nKirloskar Oil Eng Ltd.,Capital Goods,KIRLOSENG,EQ,INE146L01010\nKotak Mahindra Bank Ltd.,Financial Services,KOTAKBANK,EQ,INE237A01036\nKalpataru Projects International Ltd.,Construction,KPIL,EQ,INE220B01022\nKPIT Technologies Ltd.,Information Technology,KPITTECH,EQ,INE04I401011\nK.P.R. Mill Ltd.,Textiles,KPRMILL,EQ,INE930H01031\nDr. Lal Path Labs Ltd.,Healthcare,LALPATHLAB,EQ,INE600L01024\nLatent View Analytics Ltd.,Information Technology,LATENTVIEW,EQ,INE0I7C01011\nLaurus Labs Ltd.,Healthcare,LAURUSLABS,EQ,INE947Q01028\nLemon Tree Hotels Ltd.,Consumer Services,LEMONTREE,EQ,INE970X01018\nLenskart Solutions Ltd.,Consumer Services,LENSKART,EQ,INE956O01016\nLG Electronics India Ltd.,Consumer Durables,LGEINDIA,EQ,INE324D01010\nLIC Housing Finance Ltd.,Financial Services,LICHSGFIN,EQ,INE115A01026\nLife Insurance Corporation of India,Financial Services,LICI,EQ,INE0J1Y01017\nLinde India Ltd.,Chemicals,LINDEINDIA,EQ,INE473A01011\nLloyds Metals And Energy Ltd.,Metals & Mining,LLOYDSME,EQ,INE281B01032\nLodha Developers Ltd.,Realty,LODHA,EQ,INE670K01029\nLarsen & Toubro Ltd.,Construction,LT,EQ,INE018A01030\nL&T Finance Ltd.,Financial Services,LTF,EQ,INE498L01015\nLT Foods Ltd.,Fast Moving Consumer Goods,LTFOODS,EQ,INE818H01020\nLTM Ltd.,Information Technology,LTM,EQ,INE214T01019\nL&T Technology Services Ltd.,Information Technology,LTTS,EQ,INE010V01017\nLupin Ltd.,Healthcare,LUPIN,EQ,INE326A01037\nMahindra & Mahindra Ltd.,Automobile and Auto Components,M&M,EQ,INE101A01026\nMahindra & Mahindra Financial Services Ltd.,Financial Services,M&MFIN,EQ,INE774D01024\nBank of Maharashtra,Financial Services,MAHABANK,EQ,INE457A01014\nManappuram Finance Ltd.,Financial Services,MANAPPURAM,EQ,INE522D01027\nMankind Pharma Ltd.,Healthcare,MANKIND,EQ,INE634S01028\nC.E. Info Systems Ltd.,Information Technology,MAPMYINDIA,EQ,INE0BV301023\nMarico Ltd.,Fast Moving Consumer Goods,MARICO,EQ,INE196A01026\nMaruti Suzuki India Ltd.,Automobile and Auto Components,MARUTI,EQ,INE585B01010\nMax Healthcare Institute Ltd.,Healthcare,MAXHEALTH,EQ,INE027H01010\nMazagoan Dock Shipbuilders Ltd.,Capital Goods,MAZDOCK,EQ,INE249Z01020\nMulti Commodity Exchange of India Ltd.,Financial Services,MCX,EQ,INE745G01043\nGlobal Health Ltd.,Healthcare,MEDANTA,EQ,INE474Q01031\nMeesho Ltd.,Consumer Services,MEESHO,EQ,INE0VDM01015\nMax Financial Services Ltd.,Financial Services,MFSL,EQ,INE180A01020\nMahanagar Gas Ltd.,Oil Gas & Consumable Fuels,MGL,EQ,INE002S01010\nMinda Corporation Ltd.,Automobile and Auto Components,MINDACORP,EQ,INE842C01021\nMMTC Ltd.,Services,MMTC,EQ,INE123F01029\nSamvardhana Motherson International Ltd.,Automobile and Auto Components,MOTHERSON,EQ,INE775A01035\nMotilal Oswal Financial Services Ltd.,Financial Services,MOTILALOFS,EQ,INE338I01027\nMphasiS Ltd.,Information Technology,MPHASIS,EQ,INE356A01018\nMRF Ltd.,Automobile and Auto Components,MRF,EQ,INE883A01011\nMangalore Refinery & Petrochemicals Ltd.,Oil Gas & Consumable Fuels,MRPL,EQ,INE103A01014\nMotherson Sumi Wiring India Ltd.,Automobile and Auto Components,MSUMI,EQ,INE0FS801015\nMuthoot Finance Ltd.,Financial Services,MUTHOOTFIN,EQ,INE414G01012\nNippon Life India Asset Management Ltd.,Financial Services,NAM-INDIA,EQ,INE298J01013\nNATCO Pharma Ltd.,Healthcare,NATCOPHARM,EQ,INE987B01026\nNational Aluminium Co. Ltd.,Metals & Mining,NATIONALUM,EQ,INE139A01034\nInfo Edge (India) Ltd.,Consumer Services,NAUKRI,EQ,INE663F01032\nNava Ltd.,Power,NAVA,EQ,INE725A01030\nNavin Fluorine International Ltd.,Chemicals,NAVINFLUOR,EQ,INE048G01026\nNBCC (India) Ltd.,Construction,NBCC,EQ,INE095N01031\nNCC Ltd.,Construction,NCC,EQ,INE868B01028\nNestle India Ltd.,Fast Moving Consumer Goods,NESTLEIND,EQ,INE239A01024\nNetweb Technologies India Ltd.,Information Technology,NETWEB,EQ,INE0NT901020\nNeuland Laboratories Ltd.,Healthcare,NEULANDLAB,EQ,INE794A01010\nNewgen Software Technologies Ltd.,Information Technology,NEWGEN,EQ,INE619B01017\nNarayana Hrudayalaya Ltd.,Healthcare,NH,EQ,INE410P01011\nNHPC Ltd.,Power,NHPC,EQ,INE848E01016\nThe New India Assurance Company Ltd.,Financial Services,NIACL,EQ,INE470Y01017\nNiva Bupa Health Insurance Company Ltd.,Financial Services,NIVABUPA,EQ,INE995S01015\nNLC India Ltd.,Power,NLCINDIA,EQ,INE589A01014\nNMDC Ltd.,Metals & Mining,NMDC,EQ,INE584A01023\nNMDC Steel Ltd.,Metals & Mining,NSLNISP,EQ,INE0NNS01018\nNTPC Ltd.,Power,NTPC,EQ,INE733E01010\nNTPC Green Energy Ltd.,Power,NTPCGREEN,EQ,INE0ONG01011\nNuvama Wealth Management Ltd.,Financial Services,NUVAMA,EQ,INE531F01023\nNuvoco Vistas Corporation Ltd.,Construction Materials,NUVOCO,EQ,INE118D01016\nFSN E-Commerce Ventures Ltd.,Consumer Services,NYKAA,EQ,INE388Y01029\nOberoi Realty Ltd.,Realty,OBEROIRLTY,EQ,INE093I01010\nOracle Financial Services Software Ltd.,Information Technology,OFSS,EQ,INE881D01027\nOil India Ltd.,Oil Gas & Consumable Fuels,OIL,EQ,INE274J01014\nOla Electric Mobility Ltd.,Automobile and Auto Components,OLAELEC,EQ,INE0LXG01040\nOlectra Greentech Ltd.,Automobile and Auto Components,OLECTRA,EQ,INE260D01016\nOnesource Specialty Pharma Ltd.,Healthcare,ONESOURCE,EQ,INE013P01021\nOil & Natural Gas Corporation Ltd.,Oil Gas & Consumable Fuels,ONGC,EQ,INE213A01029\nPage Industries Ltd.,Textiles,PAGEIND,EQ,INE761H01022\nParadeep Phosphates Ltd.,Chemicals,PARADEEP,EQ,INE088F01024\nPatanjali Foods Ltd.,Fast Moving Consumer Goods,PATANJALI,EQ,INE619A01035\nOne 97 Communications Ltd.,Financial Services,PAYTM,EQ,INE982J01020\nPCBL Chemical Ltd.,Chemicals,PCBL,EQ,INE602A01031\nPersistent Systems Ltd.,Information Technology,PERSISTENT,EQ,INE262H01021\nPetronet LNG Ltd.,Oil Gas & Consumable Fuels,PETRONET,EQ,INE347G01014\nPower Finance Corporation Ltd.,Financial Services,PFC,EQ,INE134E01011\nPfizer Ltd.,Healthcare,PFIZER,EQ,INE182A01018\nPG Electroplast Ltd.,Consumer Durables,PGEL,EQ,INE457L01029\nPhoenix Mills Ltd.,Realty,PHOENIXLTD,EQ,INE211B01039\nPidilite Industries Ltd.,Chemicals,PIDILITIND,EQ,INE318A01026\nPI Industries Ltd.,Chemicals,PIIND,EQ,INE603J01030\nPine Labs Ltd.,Financial Services,PINELABS,EQ,INE15B701018\nPiramal Finance Ltd.,Financial Services,PIRAMALFIN,EQ,INE202B01038\nPunjab National Bank,Financial Services,PNB,EQ,INE160A01022\nPNB Housing Finance Ltd.,Financial Services,PNBHOUSING,EQ,INE572E01012\nPB Fintech Ltd.,Financial Services,POLICYBZR,EQ,INE417T01026\nPolycab India Ltd.,Capital Goods,POLYCAB,EQ,INE455K01017\nPoly Medicure Ltd.,Healthcare,POLYMED,EQ,INE205C01021\nPoonawalla Fincorp Ltd.,Financial Services,POONAWALLA,EQ,INE511C01022\nPower Grid Corporation of India Ltd.,Power,POWERGRID,EQ,INE752E01010\nHitachi Energy India Ltd.,Capital Goods,POWERINDIA,EQ,INE07Y701011\nPiramal Pharma Ltd.,Healthcare,PPLPHARMA,EQ,INE0DK501011\nPremier Energies Ltd.,Capital Goods,PREMIERENE,EQ,INE0BS701011\nPrestige Estates Projects Ltd.,Realty,PRESTIGE,EQ,INE811K01011\nPTC Industries Ltd.,Capital Goods,PTCIL,EQ,INE596F01018\nPVR INOX Ltd.,Media Entertainment & Publication,PVRINOX,EQ,INE191H01014\nPhysicswallah Ltd.,Consumer Services,PWL,EQ,INE0LP301011\nRadico Khaitan Ltd,Fast Moving Consumer Goods,RADICO,EQ,INE944F01028\nRailtel Corporation Of India Ltd.,Telecommunication,RAILTEL,EQ,INE0DD101019\nRainbow Childrens Medicare Ltd.,Healthcare,RAINBOW,EQ,INE961O01016\nThe Ramco Cements Ltd.,Construction Materials,RAMCOCEM,EQ,INE331A01037\nRBL Bank Ltd.,Financial Services,RBLBANK,EQ,INE976G01028\nREC Ltd.,Financial Services,RECLTD,EQ,INE020B01018\nRedington Ltd.,Services,REDINGTON,EQ,INE891D01026\nReliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018\nRHI MAGNESITA INDIA LTD.,Capital Goods,RHIM,EQ,INE743M01012\nRITES Ltd.,Construction,RITES,EQ,INE320J01015\nRamkrishna Forgings Ltd.,Automobile and Auto Components,RKFORGE,EQ,INE399G01023\nReliance Power Ltd.,Power,RPOWER,EQ,INE614G01033\nR R Kabel Ltd.,Capital Goods,RRKABEL,EQ,INE777K01022\nRail Vikas Nigam Ltd.,Construction,RVNL,EQ,INE415G01027\nSagility Ltd.,Information Technology,SAGILITY,EQ,INE0W2G01015\nSteel Authority of India Ltd.,Metals & Mining,SAIL,EQ,INE114A01011\nSai Life Sciences Ltd.,Healthcare,SAILIFE,EQ,INE570L01029\nSammaan Capital Ltd.,Financial Services,SAMMAANCAP,EQ,INE148I01020\nSapphire Foods India Ltd.,Consumer Services,SAPPHIRE,EQ,INE806T01020\nSarda Energy and Minerals Ltd.,Metals & Mining,SARDAEN,EQ,INE385C01021\nSaregama India Ltd,Media Entertainment & Publication,SAREGAMA,EQ,INE979A01025\nSBFC Finance Ltd.,Financial Services,SBFC,EQ,INE423Y01016\nSBI Cards and Payment Services Ltd.,Financial Services,SBICARD,EQ,INE018E01016\nSBI Life Insurance Company Ltd.,Financial Services,SBILIFE,EQ,INE123W01016\nState Bank of India,Financial Services,SBIN,EQ,INE062A01020\nSchaeffler India Ltd.,Automobile and Auto Components,SCHAEFFLER,EQ,INE513A01022\nSchneider Electric Infrastructure Ltd.,Capital Goods,SCHNEIDER,EQ,INE839M01018\nShipping Corporation of India Ltd.,Services,SCI,EQ,INE109A01011\nShree Cement Ltd.,Construction Materials,SHREECEM,EQ,INE070A01015\nShriram Finance Ltd.,Financial Services,SHRIRAMFIN,EQ,INE721A01047\nShyam Metalics and Energy Ltd.,Capital Goods,SHYAMMETL,EQ,INE810G01011\nSiemens Ltd.,Capital Goods,SIEMENS,EQ,INE003A01024\nSignatureglobal (India) Ltd.,Realty,SIGNATURE,EQ,INE903U01023\nSJVN Ltd.,Power,SJVN,EQ,INE002L01015\nSobha Ltd.,Realty,SOBHA,EQ,INE671H01015\nSolar Industries India Ltd.,Chemicals,SOLARINDS,EQ,INE343H01029\nSona BLW Precision Forgings Ltd.,Automobile and Auto Components,SONACOMS,EQ,INE073K01018\nSonata Software Ltd.,Information Technology,SONATSOFTW,EQ,INE269A01021\nSupreme Petrochem Ltd.,Chemicals,SPLPETRO,EQ,INE663A01033\nSRF Ltd.,Chemicals,SRF,EQ,INE647A01010\nStar Health and Allied Insurance Company Ltd.,Financial Services,STARHEALTH,EQ,INE575P01011\nSumitomo Chemical India Ltd.,Chemicals,SUMICHEM,EQ,INE258G01013\nSundaram Finance Ltd.,Financial Services,SUNDARMFIN,EQ,INE660A01013\nSun Pharmaceutical Industries Ltd.,Healthcare,SUNPHARMA,EQ,INE044A01036\nSun TV Network Ltd.,Media Entertainment & Publication,SUNTV,EQ,INE424H01027\nSupreme Industries Ltd.,Capital Goods,SUPREMEIND,EQ,INE195A01028\nSuzlon Energy Ltd.,Capital Goods,SUZLON,EQ,INE040H01021\nSwan Corp Ltd.,Chemicals,SWANCORP,EQ,INE665A01038\nSwiggy Ltd.,Consumer Services,SWIGGY,EQ,INE00H001014\nSyngene International Ltd.,Healthcare,SYNGENE,EQ,INE398R01022\nSyrma SGS Technology Ltd.,Capital Goods,SYRMA,EQ,INE0DYJ01015\nTransformers And Rectifiers (India) Ltd.,Capital Goods,TARIL,EQ,INE763I01026\nTata Capital Ltd.,Financial Services,TATACAP,EQ,INE976I01016\nTata Chemicals Ltd.,Chemicals,TATACHEM,EQ,INE092A01019\nTata Communications Ltd.,Telecommunication,TATACOMM,EQ,INE151A01013\nTata Consumer Products Ltd.,Fast Moving Consumer Goods,TATACONSUM,EQ,INE192A01025\nTata Elxsi Ltd.,Information Technology,TATAELXSI,EQ,INE670A01012\nTata Investment Corporation Ltd.,Financial Services,TATAINVEST,EQ,INE672A01026\nTata Power Co. Ltd.,Power,TATAPOWER,EQ,INE245A01021\nTata Steel Ltd.,Metals & Mining,TATASTEEL,EQ,INE081A01020\nTata Technologies Ltd.,Information Technology,TATATECH,EQ,INE142M01025\nTBO Tek Ltd.,Consumer Services,TBOTEK,EQ,INE673O01025\nTata Consultancy Services Ltd.,Information Technology,TCS,EQ,INE467B01029\nTech Mahindra Ltd.,Information Technology,TECHM,EQ,INE669C01036\nTechno Electric & Engineering Company Ltd.,Construction,TECHNOE,EQ,INE285K01026\nTega Industries Ltd.,Capital Goods,TEGA,EQ,INE011K01018\nTejas Networks Ltd.,Telecommunication,TEJASNET,EQ,INE010J01012\nTenneco Clean Air India Ltd.,Automobile and Auto Components,TENNIND,EQ,INE19RI01016\nLeela Palaces Hotels & Resorts Ltd.,Consumer Services,THELEELA,EQ,INE0AQ201015\nThermax Ltd.,Capital Goods,THERMAX,EQ,INE152A01029\nTube Investments of India Ltd.,Automobile and Auto Components,TIINDIA,EQ,INE974X01010\nTimken India Ltd.,Capital Goods,TIMKEN,EQ,INE325A01013\nTitagarh Rail Systems Ltd.,Capital Goods,TITAGARH,EQ,INE615H01020\nTitan Company Ltd.,Consumer Durables,TITAN,EQ,INE280A01028\nTata Motors Ltd.,Capital Goods,TMCV,EQ,INE1TAE01010\nTata Motors Passenger Vehicles Ltd.,Automobile and Auto Components,TMPV,EQ,INE155A01022\nTorrent Pharmaceuticals Ltd.,Healthcare,TORNTPHARM,EQ,INE685A01028\nTorrent Power Ltd.,Power,TORNTPOWER,EQ,INE813H01021\nTravel Food Services Ltd.,Consumer Services,TRAVELFOOD,EQ,INE103V01028\nTrent Ltd.,Consumer Services,TRENT,EQ,INE849A01020\nTrident Ltd.,Textiles,TRIDENT,EQ,INE064C01022\nTriveni Turbine Ltd.,Capital Goods,TRITURBINE,EQ,INE152M01016\nTata Teleservices (Maharashtra) Ltd.,Telecommunication,TTML,EQ,INE517B01013\nTVS Motor Company Ltd.,Automobile and Auto Components,TVSMOTOR,EQ,INE494B01023\nUnited Breweries Ltd.,Fast Moving Consumer Goods,UBL,EQ,INE686F01025\nUCO Bank,Financial Services,UCOBANK,EQ,INE691A01018\nUltraTech Cement Ltd.,Construction Materials,ULTRACEMCO,EQ,INE481G01011\nUnion Bank of India,Financial Services,UNIONBANK,EQ,INE692A01016\nUnited Spirits Ltd.,Fast Moving Consumer Goods,UNITDSPR,EQ,INE854D01024\nUNO Minda Ltd.,Automobile and Auto Components,UNOMINDA,EQ,INE405E01023\nUPL Ltd.,Chemicals,UPL,EQ,INE628A01036\nUrban Company Ltd.,Consumer Services,URBANCO,EQ,INE0CAZ01013\nUsha Martin Ltd.,Capital Goods,USHAMART,EQ,INE228A01035\nUTI Asset Management Company Ltd.,Financial Services,UTIAMC,EQ,INE094J01016\nVarun Beverages Ltd.,Fast Moving Consumer Goods,VBL,EQ,INE200M01039\nVedanta Ltd.,Metals & Mining,VEDL,EQ,INE205A01025\nVijaya Diagnostic Centre Ltd.,Healthcare,VIJAYA,EQ,INE043W01024\nVishal Mega Mart Ltd.,Consumer Services,VMM,EQ,INE01EA01019\nVoltas Ltd.,Consumer Durables,VOLTAS,EQ,INE226A01021\nVardhman Textiles Ltd.,Textiles,VTL,EQ,INE825A01020\nWaaree Energies Ltd.,Capital Goods,WAAREEENER,EQ,INE377N01017\nWelspun Corp Ltd.,Capital Goods,WELCORP,EQ,INE191B01025\nWelspun Living Ltd.,Textiles,WELSPUNLIV,EQ,INE192B01031\nWhirlpool of India Ltd.,Consumer Durables,WHIRLPOOL,EQ,INE716A01013\nWipro Ltd.,Information Technology,WIPRO,EQ,INE075A01022\nWockhardt Ltd.,Healthcare,WOCKPHARMA,EQ,INE049B01025\nYes Bank Ltd.,Financial Services,YESBANK,EQ,INE528G01035\nZee Entertainment Enterprises Ltd.,Media Entertainment & Publication,ZEEL,EQ,INE256A01028\nZensar Technolgies Ltd.,Information Technology,ZENSARTECH,EQ,INE520A01027\nZen Technologies Ltd.,Capital Goods,ZENTEC,EQ,INE251B01027\nZF Commercial Vehicle Control Systems India Ltd.,Automobile and Auto Components,ZFCVINDIA,EQ,INE342J01019\nZydus Lifesciences Ltd.,Healthcare,ZYDUSLIFE,EQ,INE010B01027\nZydus Wellness Ltd.,Fast Moving Consumer Goods,ZYDUSWELL,EQ,INE768C01028\n";

/* ══════════════ rebalance reminder (v1.3 — additive) ══════════════
   NSE rebalances the Nifty family semi-annually: cut-offs Jan 31 / Jul 31,
   changes effective late March / late September. This reminder fires on the
   1st of every month, acts only in April and October (when the refreshed
   constituent lists are final on NSE archives), and emails the project owner
   the exact refresh steps.

   SETUP (once): run ugSetupRebalanceReminder() from the editor.
   REMOVE: run ugRemoveRebalanceReminder().                                 */

function ugIsRebalanceMonth_(monthIdx0) {   // 0-based month; pure, Node-tested
  return monthIdx0 === 3 || monthIdx0 === 9;   // April, October
}

function ugSetupRebalanceReminder() {
  ugRemoveRebalanceReminder();
  ScriptApp.newTrigger('ugRebalanceCheck_').timeBased().onMonthDay(1).atHour(9).create();
  Logger.log('reminder installed — fires monthly, emails you in April and October');
}
function ugRemoveRebalanceReminder() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'ugRebalanceCheck_') ScriptApp.deleteTrigger(t);
  });
}

function ugRebalanceCheck_() {
  if (!ugIsRebalanceMonth_(new Date().getMonth())) return;
  var to = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({
    to: to,
    subject: '🐏 NSE rebalance — refresh the UniverseGate constituent snapshot',
    body:
      'The Nifty semi-annual rebalance has taken effect. The embedded snapshot in UniverseGate.gs (dated ' + UG_EMBEDDED_DATE + ') is now stale.\n\n' +
      'Refresh steps (10 minutes):\n' +
      '1. In a normal browser, download the three official lists:\n' +
      '   https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv\n' +
      '   https://nsearchives.nseindia.com/content/indices/ind_niftymidcap150list.csv\n' +
      '   https://archives.nseindia.com/content/indices/ind_niftysmallcap250list.csv\n' +
      '2. Combine them (keep one header row) and paste into a sheet named "Candidates" in the Indicators spreadsheet — one CSV line per row in column A. The Candidates sheet always overrides the embedded snapshot.\n' +
      '3. In the GAS editor run ugResetGate(), then ugRunGateAuto().\n' +
      '4. Review the GateReport sheet, paste the ADMIT lines into both STOCK_MASTERs, redeploy, and re-run runScan().\n\n' +
      'Also worth checking: whether GAYAPROJ or other watched special situations now clear the gate.\n\n' +
      '— UniverseGate v1.3, Indicators project'
  });
  Logger.log('rebalance reminder emailed to ' + to);
}

/* ══════════════ paste-block exporter (v1.4 — additive) ══════════════
   Reads GateReport and writes ready-to-paste blocks to a "PasteBlocks"
   sheet, one line per row:
     section 1 — steam.html STOCK_MASTER lines (column I verbatim)
     section 2 — Indicators backend lines, auto-mirroring the EXACT shape
                 of this project's own STOCK_MASTER (key style, field names),
                 so the block drops into Code.gs without hand-editing.
   GREY names are included but tagged with a trailing comment so you can
   delete those lines if you decide not to admit them.
   Run ugExportBlocks() from the editor after a tranche completes.        */

function ugMirrorEntry_(shape, c) {   // pure, Node-tested
  var sec = ugSector_(c.industry);
  if (shape === 'pipe')     return c.sym + '|' + ugShortName_(c.name) + '|' + sec + '|' + c.sym + '.NS';
  if (shape === 'obj-n')    return "  '" + c.sym + "':{n:'" + ugEsc_(ugShortName_(c.name)) + "',yf:'" + c.sym + ".NS',s:'" + ugEsc_(sec) + "'},";
  if (shape === 'obj-name') return "  '" + c.sym + "':{name:'" + ugEsc_(ugShortName_(c.name)) + "',sector:'" + ugEsc_(sec) + "'},";
  if (shape === 'arr')      return "  {sym:'" + c.sym + "',name:'" + ugEsc_(ugShortName_(c.name)) + "',sector:'" + ugEsc_(sec) + "'},";
  return JSON.stringify({ sym:c.sym, name:ugShortName_(c.name), sector:sec }) + ',';
}
function ugShortName_(name) { return String(name).replace(/ Ltd\.?$| Limited$/i, ''); }
function ugEsc_(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function ugDetectShape_() {
  try {
    if (typeof UNIVERSE === 'string') return 'pipe';   // Indicators backend: sym|name|sector|yfTicker lines
    if (typeof STOCK_MASTER === 'undefined') return 'json';
    if (Array.isArray(STOCK_MASTER)) return 'arr';
    var k = Object.keys(STOCK_MASTER)[0];
    var v = STOCK_MASTER[k] || {};
    if ('n' in v) return 'obj-n';
    if ('name' in v) return 'obj-name';
    return 'json';
  } catch (e) { return 'json'; }
}

function ugExportBlocks() {
  var ss = SpreadsheetApp.getActive();
  var rep = ss.getSheetByName(UG_SHEET);
  if (!rep || rep.getLastRow() < 2) { Logger.log('no GateReport found — run the gate first'); return; }
  var seen = {};
  var data = rep.getRange(2, 1, rep.getLastRow() - 1, 9).getValues()
    .filter(function(r){ return r[4] === 'ADMIT' || r[4] === 'GREY'; })
    .filter(function(r){ var s = String(r[0]); if (seen[s]) return false; seen[s] = 1; return true; });   // v1.4.1: dedupe (re-runs append to GateReport)
  var shape = ugDetectShape_();
  var out = [];
  out.push(['── SECTION 1: paste into steam.html STOCK_MASTER (' + data.length + ' lines) ──']);
  data.forEach(function(r){
    out.push([String(r[8]) + (r[4] === 'GREY' ? '   // GREY: ' + r[5] : '')]);
  });
  out.push(['']);
  out.push(['── SECTION 2: paste into Indicators backend STOCK_MASTER (shape: ' + shape + ') ──']);
  data.forEach(function(r){
    var c = { sym:String(r[0]), name:String(r[1]), industry:String(r[2]), isin:String(r[3]) };
    var tag = (r[4] === 'GREY' && shape !== 'pipe') ? '   // GREY: ' + r[5] : '';   // pipe lines must stay pure — a comment would corrupt the UNIVERSE string
    out.push([ugMirrorEntry_(shape, c) + tag]);
  });
  var sh = ss.getSheetByName('PasteBlocks') || ss.insertSheet('PasteBlocks');
  sh.clear();
  sh.getRange(1, 1, out.length, 1).setValues(out);
  Logger.log('PasteBlocks written: ' + data.length + ' entries per section, backend shape "' + shape + '"');
}


/* ══════════════ universe self-audit (v1.5 — additive) ══════════════
   Screens EVERY existing universe member through the same bar-quality
   engine used for admissions. Catches phantom syms (no Yahoo data),
   delisted names, suspension gaps, and thin liquidity hiding inside the
   universe itself. Results land in a "UniverseAudit" sheet, problems
   sorted to the top. Run ugAuditUniverse() from the editor; it is
   resumable like the gate (re-run if the log says budget was reached). */

function ugAuditUniverse() {
  var t0 = Date.now();
  function lg(m){ Logger.log('[' + Math.round((Date.now()-t0)/1000) + 's] ' + m); }
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('UniverseAudit') || ss.insertSheet('UniverseAudit');
  var doneSyms = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function(r){ if (r[0]) doneSyms[r[0]] = 1; });
  } else {
    sh.clear();
    sh.getRange(1, 1, 1, 5).setValues([['Symbol','Status','Detail','MedVol','Bars']]);
  }
  var all = ugCurrentUniverse_().filter(function(s){ return !doneSyms[s]; });
  lg('auditing ' + all.length + ' remaining universe members');
  var rows = [];
  for (var b = 0; b < all.length; b += UG_BATCH) {
    if (Date.now() - t0 > UG_DEADLINE_MS) { lg('budget reached — run ugAuditUniverse() again to continue'); break; }
    var batch = all.slice(b, b + UG_BATCH);
    var reqs = batch.map(function(s){
      return { url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s + '.NS') + '?range=2y&interval=1d',
               muteHttpExceptions: true, headers: { 'User-Agent':'Mozilla/5.0' } };
    });
    var resps = UrlFetchApp.fetchAll(reqs);
    for (var k = 0; k < batch.length; k++) {
      var s = batch[k], status = 'OK', detail = '', mv = 0, bars = 0;
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
        var v = ugScanBars_(ts, cl, vo);
        bars = v.bars; mv = Math.round(v.medVol);
        if (v.decision !== 'ADMIT') { status = (v.decision === 'REJECT') ? 'PROBLEM' : 'CAUTION'; detail = v.reason; }
      } catch (e) { status = 'DEAD'; detail = 'no Yahoo data (' + e.message + ') — phantom sym, delisting, or rename'; }
      rows.push([s, status, detail, mv, bars]);
    }
    Utilities.sleep(300);
  }
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  if (Date.now() - t0 <= UG_DEADLINE_MS) {
    var n = sh.getLastRow() - 1;
    var data = sh.getRange(2, 1, n, 5).getValues();
    var ord = { DEAD:0, PROBLEM:1, CAUTION:2, OK:3 };
    data.sort(function(a,b){ var d = ord[a[1]] - ord[b[1]]; return d !== 0 ? d : (a[0] < b[0] ? -1 : 1); });
    sh.getRange(2, 1, n, 5).setValues(data);
    var c = { DEAD:0, PROBLEM:0, CAUTION:0, OK:0 };
    data.forEach(function(r){ if (c[r[1]] != null) c[r[1]]++; });
    lg('AUDIT COMPLETE — DEAD ' + c.DEAD + ' · PROBLEM ' + c.PROBLEM + ' · CAUTION ' + c.CAUTION + ' · OK ' + c.OK);
  }
}
