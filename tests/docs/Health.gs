/**
 * ═══════════════════════════════════════════════════════════════════
 * HEALTH.gs — unified weekly calibration / health engine (v1.0, 24-Jul-2026)
 * ADDITIVE. New file in the nse-indicators GAS project. Touches NO
 * existing function. Reuses globals from Code.gs: CFG, SELL, uniList_,
 * uniMap_, getBars_, sheet_, ss_, sellBrier_, loadChampionMap_,
 * runCalibChampion.
 *
 * Wire-in (the ONE edit to Code.gs) — add to doGet's dispatch chain:
 *     else if (a === 'health') out = routeHealth_();
 *
 * WHAT IT DOES
 *   Sell  — already fully built (runCalibChampion / action=calib). The
 *           Saturday job refits its champion; the health route surfaces it.
 *   Bull  — NEW. Harvested, not recomputed: runScan already writes each
 *           stock's bull{} into the Scan sheet, so runBullLog() copies the
 *           bull-on names into BullCalib daily (no runScan change). Matured
 *           at CFG.CALIB_MATURE_DAYS by runBullScore(): realizedHold =
 *           close[t+H] ≥ close[t]. Reports Brier on P(hold) + a per-class
 *           STRONG/BULL/CAUTION hold-rate & forward-return table (the honest
 *           health read for a deterministic classifier — does STRONG really
 *           beat CAUTION?).
 *   Sheep — NEW. Cross-project sweep of the roster against the Steam
 *           blacksheep engine (?action=blacksheep), chunked + budgeted +
 *           resumable (sheep_idx, mirrors runCalibBackfill). On completion,
 *           diffs verdicts vs last sweep and surfaces NEWLY-flagged names
 *           (the Gayatri drift guard, on a schedule).
 *
 * ROUTES (add the one dispatch line above):
 *   ?action=health  → { sell, bull, sheep, sheepSweepIdx, lastHealthRun }
 *
 * OPS (Run dropdown; verify before deploy):
 *   runBullLog()          — harvest today's bull-on names from Scan sheet
 *   runBullScore()        — mature + score bull predictions, write BullResults
 *   runSheepHealthNow()   — sweep roster vs Steam engine (cached, resumable)
 *   runSheepHealthForce() — same sweep with &nocache=1 (use after deploying BlackSheep.gs)
 *   resetSheepSweep()     — reset sweep progress to 0
 *   saturdayHealthRun()   — the weekly orchestrator (sell refit + bull + sheep)
 *   installHealthTrigger()— daily runBullLog (~18:45) + weekly Sat run (~10:00)
 *
 * NOTE ON THE SELL CHAMPION TRIGGER: saturdayHealthRun() calls
 *   runCalibChampion() itself. If you previously ran installChampionTrigger()
 *   (standalone Sat 09:00 refit), delete that trigger after installing this
 *   one so the sell champion isn't refit twice on Saturdays.
 * ═══════════════════════════════════════════════════════════════════
 */

var HCFG = {
  BULL_SHEET: 'BullCalib', BULL_RESULTS_SHEET: 'BullResults',
  SHEEP_VERDICT_SHEET: 'SheepVerdicts', HEALTH_LOG_SHEET: 'HealthLog',
  SHEEP_API: 'https://script.google.com/macros/s/AKfycbxbqcip3QPPRP5YUxngoWecv5nN2eKk5h9T2WYL2_vmTs3ix6Tjt_KTfKq2MDptrmPMcw/exec',
  SHEEP_CHUNK: 20, SHEEP_BUDGET_MS: 240000, SHEEP_SLEEP_MS: 500,
  SHEEP_CHUNK_FORCE: 10, SHEEP_SLEEP_FORCE_MS: 1200
};

/* ═══════════════ PURE MATH (Node-stub-tested; no GAS services) ═══════════════ */

/* per-class hold-rate & mean forward-return table for Bull Watch health.
   rows: [{cls, held(0|1), fwd(number)}] → {STRONG,BULL,CAUTION:{n,holdRate,meanFwd}} */
function bullClassTable_(rows) {
  var C = { STRONG: [], BULL: [], CAUTION: [] };
  (rows || []).forEach(function (r) { if (C[r.cls]) C[r.cls].push(r); });
  function agg(a) {
    if (!a.length) return { n: 0, holdRate: null, meanFwd: null };
    var h = 0, f = 0;
    for (var i = 0; i < a.length; i++) { h += a[i].held; f += a[i].fwd; }
    return { n: a.length, holdRate: Math.round(h / a.length * 1000) / 1000, meanFwd: Math.round(f / a.length * 10000) / 10000 };
  }
  return { STRONG: agg(C.STRONG), BULL: agg(C.BULL), CAUTION: agg(C.CAUTION) };
}

/* week-over-week black-sheep drift.
   prevFlagged: [sym…] flagged last sweep; curr: {sym:verdict} this sweep.
   → { flagged:[…], newly:[…], cleared:[…] } (all sorted) */
function sheepDiff_(prevFlagged, curr) {
  var prev = {};
  (prevFlagged || []).forEach(function (s) { prev[s] = 1; });
  var flagged = [], k;
  for (k in curr) { if (!curr.hasOwnProperty(k)) continue; var v = curr[k]; if (v === 'BLACKSHEEP' || v === 'GREY') flagged.push(k); }
  var newly = flagged.filter(function (s) { return !prev[s]; });
  var cleared = (prevFlagged || []).filter(function (s) { return curr[s] === 'CLEAN'; });
  return { flagged: flagged.sort(), newly: newly.sort(), cleared: cleared.sort() };
}

/* ═══════════════ BULL WATCH CALIBRATION (harvest → mature → score) ═══════════════ */

/* daily: copy bull-on names out of the Scan sheet (runScan already wrote bull{}) */
function runBullLog() {
  var sh = ss_().getSheetByName(CFG.SCAN_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('bullLog: no scan yet — run runScan first'); return; }
  var today = new Date().toISOString().slice(0, 10);
  var bc = sheet_(HCFG.BULL_SHEET, ['predDate', 'sym', 'price', 'cls', 'pHold', 'realizedHold', 'realizedFwd', 'scoredAt']);
  var last = bc.getLastRow();
  if (last > 1) {
    var col = bc.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) if (String(col[i][0]).slice(0, 10) === today) { Logger.log('bullLog: already logged ' + today); return; }
  }
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues(), rows = [];
  data.forEach(function (r) {
    var o; try { o = JSON.parse(r[1]); } catch (e) { return; }
    if (o && o.ok && o.bull && o.bull.on && o.bull.pHold != null)
      rows.push([today, o.sym, o.price, o.bull.cls, o.bull.pHold, '', '', '']);
  });
  if (rows.length) bc.getRange(bc.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
  Logger.log('bullLog: ' + rows.length + ' bull-on names logged ' + today);
}

/* weekly: mature bull predictions at H sessions, score hold, write Brier + class table */
function runBullScore() {
  var bc = ss_().getSheetByName(HCFG.BULL_SHEET);
  if (!bc || bc.getLastRow() < 2) { Logger.log('bullScore: nothing logged yet'); return { ok: false, error: 'no bull log' }; }
  var last = bc.getLastRow(), data = bc.getRange(2, 1, last - 1, 8).getValues();
  var cutoff = Date.now() - CFG.CALIB_MATURE_DAYS * 86400000, bySym = {};
  data.forEach(function (r, i) {
    if (r[5] !== '') return;                                  // already scored (realizedHold filled)
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
      var held = bars.close[fut] >= bars.close[idx] ? 1 : 0;
      var fwd = Math.round((bars.close[fut] / bars.close[idx] - 1) * 10000) / 10000;
      bc.getRange(p.row, 6).setValue(held);
      bc.getRange(p.row, 7).setValue(fwd);
      bc.getRange(p.row, 8).setValue(new Date().toISOString());
      scored++;
    });
  });
  var all = bc.getRange(2, 1, bc.getLastRow() - 1, 8).getValues(), pairs = [], crows = [];
  all.forEach(function (r) {
    if (r[5] === '') return;
    var held = Number(r[5]), pHold = Number(r[4]), fwd = r[6] === '' ? 0 : Number(r[6]);
    pairs.push({ p: pHold, y: held });
    crows.push({ cls: String(r[3]), held: held, fwd: fwd });
  });
  if (!pairs.length) { Logger.log('bullScore: scored ' + scored + ' new; none mature enough to report'); return { ok: true, scored: scored, ready: false }; }
  var brier = sellBrier_(pairs), tbl = bullClassTable_(crows);      // sellBrier_ is global in Code.gs
  var brs = sheet_(HCFG.BULL_RESULTS_SHEET, ['scoredAt', 'nScored', 'brier', 'classTable']);
  brs.appendRow([new Date().toISOString(), pairs.length, brier, JSON.stringify(tbl)]);
  Logger.log('bullScore: scored ' + scored + ' new; total ' + pairs.length + '; Brier ' + brier + '; ' + JSON.stringify(tbl));
  return { ok: true, scored: scored, n: pairs.length, brier: brier, classTable: tbl };
}

/* ═══════════════ BLACK SHEEP ROSTER HEALTH (resumable cross-project sweep) ═══════════════ */

function runSheepHealth_(budgetMs, force) {
  budgetMs = budgetMs || HCFG.SHEEP_BUDGET_MS;
  /* force=true appends &nocache=1, bypassing the engine's 6h per-symbol cache.
     Needed after deploying a new BlackSheep.gs version — otherwise the sweep
     replays stale verdicts. Uncached calls make the engine hit Yahoo + Google
     News for every name, so force mode paces itself down (smaller chunks,
     longer sleep) to avoid burst throttling manufacturing false NO_DATA. */
  var CH = force ? HCFG.SHEEP_CHUNK_FORCE : HCFG.SHEEP_CHUNK;
  var SL = force ? HCFG.SHEEP_SLEEP_FORCE_MS : HCFG.SHEEP_SLEEP_MS;
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var uni = uniList_(), start = parseInt(props.getProperty('sheep_idx') || '0', 10);
  var sv = sheet_(HCFG.SHEEP_VERDICT_SHEET, ['sym', 'verdict', 'checkedAt']);
  if (start === 0) { sv.clear(); sv.appendRow(['sym', 'verdict', 'checkedAt']); }   // fresh sweep
  var done = start, checked = 0;
  for (var i = start; i < uni.length; i += CH) {
    if (Date.now() - t0 > budgetMs) break;
    var chunk = uni.slice(i, i + CH);
    var reqs = chunk.map(function (u) {
      return { url: HCFG.SHEEP_API + '?action=blacksheep&sym=' + encodeURIComponent(u.sym) + '&name=' + encodeURIComponent(u.name) + (force ? '&nocache=1' : ''), muteHttpExceptions: true };
    });
    var resps; try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { break; }   // stop clean; resume next run
    var out = [];
    for (var j = 0; j < resps.length; j++) {
      var v = 'ERROR';
      try { if (resps[j].getResponseCode() === 200) { var jj = JSON.parse(resps[j].getContentText()); v = (jj && jj.verdict) || 'ERROR'; } } catch (e) { }
      out.push([chunk[j].sym, v, new Date().toISOString()]); checked++;
    }
    if (out.length) sv.getRange(sv.getLastRow() + 1, 1, out.length, 3).setValues(out);
    done = i + CH;
    Utilities.sleep(SL);
  }
  var finished = done >= uni.length;
  props.setProperty('sheep_idx', finished ? '0' : String(done));
  if (finished) return sheepFinalize_(sv, props);
  Logger.log('sheepHealth' + (force ? ' [FORCE/nocache]' : '') + ': ' + start + '→' + done + '/' + uni.length + ', ' + checked + ' checked — not finished, re-run (runSheepHealthNow / runSheepHealthForce) to resume');
  return { ok: true, finished: false, progress: done + '/' + uni.length };
}

function sheepFinalize_(sv, props) {
  var last = sv.getLastRow(), curr = {};
  if (last > 1) { var d = sv.getRange(2, 1, last - 1, 2).getValues(); d.forEach(function (r) { curr[r[0]] = String(r[1]); }); }
  var prevFlagged = []; try { prevFlagged = JSON.parse(props.getProperty('SHEEP_PREV_FLAGGED') || '[]'); } catch (e) { }
  var diff = sheepDiff_(prevFlagged, curr);
  var black = 0, grey = 0, clean = 0, err = 0, k;
  for (k in curr) { if (!curr.hasOwnProperty(k)) continue; var v = curr[k]; if (v === 'BLACKSHEEP') black++; else if (v === 'GREY') grey++; else if (v === 'CLEAN') clean++; else err++; }
  props.setProperty('SHEEP_PREV_FLAGGED', JSON.stringify(diff.flagged));
  var snap = { checkedAt: new Date().toISOString(), black: black, grey: grey, clean: clean, error: err,
    newly: diff.newly, cleared: diff.cleared, flaggedCount: diff.flagged.length };
  props.setProperty('SHEEP_HEALTH', JSON.stringify(snap));
  Logger.log('sheepHealth DONE: ' + black + ' black · ' + grey + ' grey · ' + clean + ' clean · ' + err + ' err; ' + diff.newly.length + ' newly flagged, ' + diff.cleared.length + ' cleared');
  return { ok: true, finished: true, snap: snap };
}

/* ═══════════════ SATURDAY ORCHESTRATOR ═══════════════ */
function saturdayHealthRun() {
  var res = { runAt: new Date().toISOString() };
  try { res.sell = runCalibChampion(); } catch (e) { res.sell = { ok: false, error: String(e) }; }   // sell isotonic refit
  try { res.bull = runBullScore(); } catch (e) { res.bull = { ok: false, error: String(e) }; }        // bull mature + score
  try { res.sheep = runSheepHealth_(); } catch (e) { res.sheep = { ok: false, error: String(e) }; }   // sheep sweep (resumable)
  PropertiesService.getScriptProperties().setProperty('HEALTH_LATEST', JSON.stringify({
    runAt: res.runAt,
    sellPromoted: res.sell && res.sell.ok ? res.sell.promoted : null,
    sellVersion: res.sell && res.sell.ok ? res.sell.version : null
  }));
  var hl = sheet_(HCFG.HEALTH_LOG_SHEET, ['runAt', 'sell', 'bull', 'sheep']);
  hl.appendRow([res.runAt, JSON.stringify(res.sell || null), JSON.stringify(res.bull || null), JSON.stringify(res.sheep || null)]);
  Logger.log('saturdayHealthRun complete @ ' + res.runAt);
  return res;
}

function installHealthTrigger() {
  var fns = { runBullLog: 1, saturdayHealthRun: 1 };
  ScriptApp.getProjectTriggers().forEach(function (t) { if (fns[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runBullLog').timeBased().atHour(18).nearMinute(45).everyDays(1).create();
  ScriptApp.newTrigger('saturdayHealthRun').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(10).create();
  Logger.log('installed: daily runBullLog (~18:45, after runScan) + weekly saturdayHealthRun (Sat ~10:00). ' +
    'If installChampionTrigger() is still active, delete its Sat 09:00 runCalibChampion trigger — health owns the sell refit now.');
}

/* ═══════════════ ROUTE ═══════════════ */
function routeHealth_() {
  var props = PropertiesService.getScriptProperties();

  var sell = null;
  var rs = ss_().getSheetByName(CFG.CALIB_RESULTS_SHEET), champ = loadChampionMap_();
  if (rs && rs.getLastRow() >= 2) {
    var r = rs.getRange(rs.getLastRow(), 1, 1, 3).getValues()[0];
    sell = { scoredAt: String(r[0]), nScored: r[1], brier: r[2],
      champVer: champ ? champ.version : null, champHoldBrier: champ ? champ.holdBrier : null };
  }

  var bull = null;
  var br = ss_().getSheetByName(HCFG.BULL_RESULTS_SHEET);
  if (br && br.getLastRow() >= 2) {
    var b = br.getRange(br.getLastRow(), 1, 1, 4).getValues()[0];
    bull = { scoredAt: String(b[0]), nScored: b[1], brier: b[2], classTable: JSON.parse(b[3] || 'null') };
  }

  var sheep = null; try { sheep = JSON.parse(props.getProperty('SHEEP_HEALTH') || 'null'); } catch (e) { }
  var lastRun = null; try { var hl = JSON.parse(props.getProperty('HEALTH_LATEST') || 'null'); if (hl) lastRun = hl.runAt; } catch (e) { }

  return { ok: true, sell: sell, bull: bull, sheep: sheep,
    sheepSweepIdx: props.getProperty('sheep_idx') || '0', lastHealthRun: lastRun };
}

/* run wrappers */
/* Post-deploy validation sweep: bypasses the engine's 6h cache so a freshly
   deployed BlackSheep.gs is actually exercised. Resumable — re-run until the
   log says DONE (it is slower than the cached sweep by design). */
function runSheepHealthForce() { Logger.log(JSON.stringify(runSheepHealth_(HCFG.SHEEP_BUDGET_MS, true))); }
function resetSheepSweep() { PropertiesService.getScriptProperties().setProperty('sheep_idx', '0'); Logger.log('sheep_idx reset to 0 — next sweep starts fresh'); }
/* plain cached sweep, callable from the Run dropdown (saturdayHealthRun uses the same path) */
function runSheepHealthNow() { Logger.log(JSON.stringify(runSheepHealth_())); }
function runHealthNow() { Logger.log(JSON.stringify(saturdayHealthRun()).slice(0, 400)); }
function runHealthRoute() { Logger.log(JSON.stringify(routeHealth_()).slice(0, 800)); }
