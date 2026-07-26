/**
 * ═══════════════════════════════════════════════════════════════════
 * ROSTERHEALTH.gs — roster auto-maintenance, PART 1: the safety core
 * (v0.9, 25-Jul-2026) — ADDITIVE, pure. No GAS services in this file.
 *
 * WHAT THIS IS
 *   The decision layer that sits between ugAuditUniverse()'s per-run
 *   verdicts and any actual roster change. It answers one question:
 *   "is this flag trustworthy enough to act on yet?"
 *
 * WHY IT EXISTS (earned the hard way, 25-Jul-2026)
 *   · AURIONPRO and FIEMIND were false REJECTs — Yahoo returned
 *     transient bad data mid-corporate-action on healthy stocks.
 *   · The Black Sheep sweep flagged 137/799 names in one pass, every
 *     one a false positive, from a SINGLE systemic cause (RSS
 *     throttling + a stale cache). An auto-swapper acting on that run
 *     would have proposed replacing 17% of the roster.
 *   Conclusion: a single run's verdict is never evidence. Only a
 *   persistent, non-systemic pattern is.
 *
 * THREE GUARDS
 *   1. PER-NAME DEBOUNCE — escalate only after N consecutive bad
 *      audits. One bad run does nothing.
 *   2. ERROR ≠ DEATH — a fetch/parse failure ('X') carries NO
 *      information: it neither counts toward escalation nor resets a
 *      genuine streak. This is the AURIONPRO lesson encoded.
 *   3. SYSTEMIC CIRCUIT BREAKER — if an unusual share of the whole
 *      roster flags in one run, the run itself is suspect (outage,
 *      throttle, API change). Escalation freezes for that run; nothing
 *      moves. This is the 137/799 lesson encoded.
 *
 * NEVER AUTOMATIC
 *   REPLACE_READY produces a PROPOSAL only — a digest naming the stock
 *   to drop, why, and screened candidates to add. A human commits the
 *   swap. Nothing in this file mutates UNIVERSE.
 *
 * HISTORY ENCODING
 *   One compact string per symbol, oldest→newest, one char per audit:
 *     O = OK        C = CAUTION      (healthy)
 *     P = PROBLEM   D = DEAD         (bad)
 *     X = ERROR/unreachable          (no information)
 *   e.g. 'OOOCXDDD' = long healthy, one unreadable run, then 3 bad.
 *   Auditable in a single sheet cell; trivially testable.
 *
 * STATUSES
 *   OK            — healthy, or a lone bad run not yet meaningful
 *   WATCH         — bad but below the quarantine threshold, or flapping
 *   QUARANTINE    — persistently bad; excluded from NEW signals but
 *                   still in the roster (no silent data loss)
 *   REPLACE_READY — persistently bad long enough to propose a swap
 *
 * PART 2 (needs UniverseGate.gs) will wire this to real verdicts:
 *   ugAuditUniverse() → verdict chars → this state machine → digest
 *   email → generated whole-file UNIVERSE replacement for review.
 * ═══════════════════════════════════════════════════════════════════
 */

var RHCFG = {
  RH_SHEET:  'RosterHealth',   // per-symbol verdict history
  SWAP_SHEET:'RosterSwap',     // staged UNIVERSE replacement for review
  DIGEST_TO: '',          // blank = the script owner's address
  MIN_COVERAGE:  0.95,   // audited/roster below this → audit incomplete, freeze escalation
  HIST_KEEP:      12,     // audits retained per symbol
  WATCH_N:         1,     // consecutive bad → WATCH
  QUARANTINE_N:    3,     // consecutive bad → QUARANTINE (exclude from new signals)
  REPLACE_N:       5,     // consecutive bad → propose a swap
  FLAP_WINDOW:     8,     // look-back for the flapping check
  FLAP_MIN:        4,     // bad audits within the window (non-consecutive) → WATCH
  MAX_SWAPS_RUN:   5,     // hard cap on proposals per run — no mass churn
  SUSPECT_BAD_PCT: 0.10,  // >10% of roster bad in one run  → run is systemic-suspect
  SUSPECT_ERR_PCT: 0.25   // >25% of roster unreadable      → run is systemic-suspect
};

/* ── verdict char helpers ── */
function rhIsBad_(ch)     { return ch === 'D' || ch === 'P'; }
function rhIsUnknown_(ch) { return ch === 'X'; }

/* map an ugAuditUniverse verdict string to a history char */
function rhCharOf_(verdict) {
  var v = String(verdict || '').toUpperCase();
  if (v === 'DEAD')    return 'D';
  if (v === 'PROBLEM') return 'P';
  if (v === 'CAUTION') return 'C';
  if (v === 'OK')      return 'O';
  return 'X';                                  // ERROR / unreachable / anything unrecognised
}

/* append a char, keeping the last HIST_KEEP */
function rhPush_(hist, ch, keep) {
  keep = keep || RHCFG.HIST_KEEP;
  var h = String(hist || '') + ch;
  return h.length > keep ? h.slice(h.length - keep) : h;
}

/* trailing consecutive bad audits, SKIPPING unknowns (they carry no info) */
function rhStreak_(hist) {
  var h = String(hist || ''), n = 0;
  for (var i = h.length - 1; i >= 0; i--) {
    var c = h.charAt(i);
    if (rhIsUnknown_(c)) continue;             // 'X' neither breaks nor extends the streak
    if (rhIsBad_(c)) { n++; continue; }
    break;                                     // a healthy audit ends the streak
  }
  return n;
}

/* bad audits within the trailing window — catches flapping that never goes consecutive */
function rhFlaps_(hist, win) {
  win = win || RHCFG.FLAP_WINDOW;
  var h = String(hist || '');
  var s = h.length > win ? h.slice(h.length - win) : h, n = 0;
  for (var i = 0; i < s.length; i++) if (rhIsBad_(s.charAt(i))) n++;
  return n;
}

/* Classify one symbol from its history.
   NOTE on recovery: a single healthy audit clears the STREAK immediately, so a
   name drops straight out of QUARANTINE / REPLACE_READY (never actionable
   again on one good run). It may still read WATCH while its bad audits remain
   inside FLAP_WINDOW — deliberate: a just-recovered name stays visible until
   the bad history ages out, and WATCH triggers no action. */
function rhClassify_(hist, cfg) {
  cfg = cfg || RHCFG;
  var streak = rhStreak_(hist), flaps = rhFlaps_(hist, cfg.FLAP_WINDOW);
  var status;
  if (streak >= cfg.REPLACE_N)          status = 'REPLACE_READY';
  else if (streak >= cfg.QUARANTINE_N)  status = 'QUARANTINE';
  else if (streak >= cfg.WATCH_N)       status = 'WATCH';
  else if (flaps >= cfg.FLAP_MIN)       status = 'WATCH';       // unstable data source, not yet actionable
  else                                  status = 'OK';
  return { status: status, streak: streak, flaps: flaps };
}

/* ── SYSTEMIC CIRCUIT BREAKER ──
   Decide whether a whole audit run is trustworthy. counts = {bad, err, total}.
   A run that flags an implausible share of the roster is far more likely to be
   an outage/throttle/API change than a genuine mass delisting. When suspect,
   the caller records history but escalates NOTHING. */
function rhRunSuspect_(counts, cfg) {
  cfg = cfg || RHCFG;
  var total = counts && counts.total ? counts.total : 0;
  if (!total) return { suspect: true, reason: 'empty run — nothing audited' };
  if (counts.expected && total < counts.expected * cfg.MIN_COVERAGE)
    return { suspect: true, reason: 'audit incomplete — only ' + total + ' of ' + counts.expected +
      ' roster names evaluated; escalation frozen until a full pass completes' };
  var badPct = (counts.bad || 0) / total, errPct = (counts.err || 0) / total;
  if (badPct > cfg.SUSPECT_BAD_PCT)
    return { suspect: true, reason: Math.round(badPct * 1000) / 10 + '% of the roster flagged bad (>' +
      Math.round(cfg.SUSPECT_BAD_PCT * 100) + '%) — systemic, not per-stock; escalation frozen' };
  if (errPct > cfg.SUSPECT_ERR_PCT)
    return { suspect: true, reason: Math.round(errPct * 1000) / 10 + '% of the roster unreadable (>' +
      Math.round(cfg.SUSPECT_ERR_PCT * 100) + '%) — fetch layer degraded; escalation frozen' };
  return { suspect: false, reason: null };
}

/* ── SWAP PLANNER ──
   states:     [{sym, status, streak, lastVerdict}]
   candidates: [{sym, name, sector, yf}]  already gate-screened admits
   Pairs REPLACE_READY names with candidates, capped. Proposals only. */
function rhPlanSwaps_(states, candidates, cfg) {
  cfg = cfg || RHCFG;
  var ready = (states || []).filter(function (s) { return s.status === 'REPLACE_READY'; })
    .sort(function (a, b) { return (b.streak || 0) - (a.streak || 0); });   // worst-persisting first
  var cands = (candidates || []).slice();
  var proposals = [], deferred = [];
  for (var i = 0; i < ready.length; i++) {
    if (proposals.length >= cfg.MAX_SWAPS_RUN) { deferred.push({ sym: ready[i].sym, why: 'per-run swap cap reached' }); continue; }
    if (!cands.length) { deferred.push({ sym: ready[i].sym, why: 'no screened replacement candidate available' }); continue; }
    var c = cands.shift();
    proposals.push({ drop: ready[i].sym, dropStreak: ready[i].streak, dropVerdict: ready[i].lastVerdict || null,
      add: c.sym, addName: c.name || '', addSector: c.sector || '' });
  }
  return { proposals: proposals, deferred: deferred,
    quarantined: (states || []).filter(function (s) { return s.status === 'QUARANTINE'; }).map(function (s) { return s.sym; }),
    watch: (states || []).filter(function (s) { return s.status === 'WATCH'; }).map(function (s) { return s.sym; }) };
}

/* ═══════════════════════════════════════════════════════════════════
 * PART 2 — WIRING (v1.0). Reads ugAuditUniverse()'s verdicts, persists
 * per-symbol history, applies the three guards, and PROPOSES swaps.
 *
 * Depends on UniverseGate.gs + Code.gs (same project scope):
 *   ugAuditUniverse, ugCurrentUniverse_, ugMirrorEntry_, ugSector_,
 *   ugShortName_, ugEsc_, UG_SHEET, UNIVERSE
 *
 * OPS (Run dropdown):
 *   ugHealthWatch()            — the weekly watch (self-chains if the
 *                                audit needs more than one budget window)
 *   rhShowState()              — print the current roster-health table
 *   rhResetRosterHealth()      — wipe history and start clean
 *   installRosterWatchTrigger()— weekly Saturday ~11:00 trigger
 *
 * NOTHING IS APPLIED AUTOMATICALLY. A completed run emails a digest and,
 * when swaps are proposed, writes a full replacement UNIVERSE block to the
 * RosterSwap sheet. You review it, paste it into Code.gs, and redeploy.
 * ═══════════════════════════════════════════════════════════════════ */

/* ── pure: universe line helpers (Node-tested) ── */
function rhSymOfLine_(line) { return String(line || '').split('|')[0].trim().toUpperCase(); }

/* drop + add + re-sort, returning the new line list. Pure. */
function rhBuildSwapped_(lines, dropSyms, addLines) {
  var drop = {};
  (dropSyms || []).forEach(function (s) { drop[String(s).toUpperCase()] = 1; });
  var kept = (lines || []).filter(function (l) { return l.trim() && !drop[rhSymOfLine_(l)]; });
  var out = kept.concat((addLines || []).filter(function (l) { return l && l.trim(); }));
  out.sort(function (a, b) { var x = rhSymOfLine_(a), y = rhSymOfLine_(b); return x < y ? -1 : x > y ? 1 : 0; });
  return out;
}

/* emit the exact `var UNIVERSE = '…' + …;` source block. Pure. */
function rhFormatUniverseBlock_(lines, note) {
  var esc = function (s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); };
  var out = [];
  if (note) out.push('/* ' + note + ' */');
  out.push('var UNIVERSE =');
  for (var i = 0; i < lines.length; i++) {
    var tail = (i === lines.length - 1) ? "';" : "\\n' +";
    out.push("'" + esc(lines[i]) + tail);
  }
  return out;
}

/* ── GAS: read this week's audit ── */
function rhReadAudit_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('UniverseAudit');
  if (!sh || sh.getLastRow() < 2) return { verdicts: {}, details: {}, counts: { bad: 0, err: 0, total: 0 } };
  var d = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var verdicts = {}, details = {}, bad = 0, err = 0, total = 0;
  d.forEach(function (r) {
    var sym = String(r[0] || '').toUpperCase(); if (!sym) return;
    var st = String(r[1] || '').toUpperCase();
    verdicts[sym] = st; details[sym] = String(r[2] || '');
    total++;
    if (st === 'DEAD' || st === 'PROBLEM') bad++;
    if (st !== 'OK' && st !== 'CAUTION' && st !== 'PROBLEM' && st !== 'DEAD') err++;
  });
  return { verdicts: verdicts, details: details, counts: { bad: bad, err: err, total: total } };
}

/* ── GAS: history persistence ── */
function rhLoadHist_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(RHCFG.RH_SHEET);
  var h = {};
  if (!sh || sh.getLastRow() < 2) return h;
  sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(function (r) {
    var sym = String(r[0] || '').toUpperCase(); if (!sym) return;
    h[sym] = { hist: String(r[1] || ''), firstFlagged: r[6] ? String(r[6]) : '' };
  });
  return h;
}
function rhSaveHist_(states) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(RHCFG.RH_SHEET) || ss.insertSheet(RHCFG.RH_SHEET);
  sh.clear();
  sh.getRange(1, 1, 1, 8).setValues([['Symbol', 'History (old→new)', 'Status', 'Streak', 'Flaps', 'Last verdict', 'First flagged', 'Updated']]);
  var ord = { REPLACE_READY: 0, QUARANTINE: 1, WATCH: 2, OK: 3 };
  var rows = states.slice().sort(function (a, b) {
    var d = (ord[a.status] == null ? 9 : ord[a.status]) - (ord[b.status] == null ? 9 : ord[b.status]);
    return d !== 0 ? d : (a.sym < b.sym ? -1 : 1);
  }).map(function (s) {
    return [s.sym, s.hist, s.status, s.streak, s.flaps, s.lastVerdict || '', s.firstFlagged || '', new Date().toISOString()];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, 8).setValues(rows);
  sh.setFrozenRows(1);
}

/* ── GAS: screened replacement candidates = GateReport ADMIT names not already in the universe ── */
function rhCandidatePool_() {
  var ss = SpreadsheetApp.getActive();
  var rep = ss.getSheetByName(UG_SHEET);
  if (!rep || rep.getLastRow() < 2) return [];
  var inUni = {};
  ugCurrentUniverse_().forEach(function (s) { inUni[s] = 1; });
  var seen = {}, out = [];
  rep.getRange(2, 1, rep.getLastRow() - 1, 6).getValues().forEach(function (r) {
    var sym = String(r[0] || '').toUpperCase();
    if (!sym || sym === 'SUMMARY') return;
    if (String(r[4]).toUpperCase() !== 'ADMIT') return;   // ADMIT only — never GREY, never REJECT
    if (inUni[sym] || seen[sym]) return;
    seen[sym] = 1;
    out.push({ sym: sym, name: String(r[1] || ''), industry: String(r[2] || ''), sector: ugSector_(r[2]) });
  });
  return out;
}

/* ── the weekly watch ── */
function ugHealthWatch() {
  var t0 = Date.now();
  function lg(m) { Logger.log('[' + Math.round((Date.now() - t0) / 1000) + 's] ' + m); }
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActive();
  var phase = props.getProperty('RH_PHASE') || 'START';

  if (phase === 'START') {                       // fresh cycle: clear last week's audit so verdicts are current
    var old = ss.getSheetByName('UniverseAudit');
    if (old) { old.clear(); lg('cleared UniverseAudit — starting a fresh pass'); }
    props.setProperty('RH_PHASE', 'AUDIT');
  }

  lg('running ugAuditUniverse (resumable)…');
  ugAuditUniverse();                             // its own 4.5-min budget; skips already-audited syms

  var roster = ugCurrentUniverse_(), audit = rhReadAudit_();
  audit.counts.expected = roster.length;
  lg('coverage ' + audit.counts.total + '/' + roster.length +
     ' · bad ' + audit.counts.bad + ' · unreadable ' + audit.counts.err);

  if (audit.counts.total < roster.length * RHCFG.MIN_COVERAGE) {
    rhChain_();                                  // not done — resume in ~1 min
    lg('audit incomplete — chained a resume in ~1 min');
    return;
  }
  props.deleteProperty('RH_PHASE');
  rhUnchain_();

  /* GUARD 3 — is this run trustworthy at all? */
  var suspect = rhRunSuspect_(audit.counts, RHCFG);

  /* record history for every roster name (unknown → 'X') */
  var prev = rhLoadHist_(), states = [], today = new Date().toISOString().slice(0, 10);
  roster.forEach(function (sym) {
    var v = audit.verdicts[sym] || 'ERROR';
    var p = prev[sym] || { hist: '', firstFlagged: '' };
    var hist = rhPush_(p.hist, rhCharOf_(v), RHCFG.HIST_KEEP);
    var cl = rhClassify_(hist, RHCFG);
    var ff = p.firstFlagged;
    if (cl.streak > 0 && !ff) ff = today;
    if (cl.streak === 0) ff = '';
    states.push({ sym: sym, hist: hist, status: suspect.suspect ? 'OK' : cl.status,
      rawStatus: cl.status, streak: cl.streak, flaps: cl.flaps,
      lastVerdict: v, lastDetail: audit.details[sym] || '', firstFlagged: ff });
  });
  rhSaveHist_(states);

  if (suspect.suspect) {                         // history kept, escalation frozen
    lg('RUN SUSPECT — ' + suspect.reason);
    rhDigest_({ suspect: suspect, states: states, audit: audit, roster: roster.length, plan: null });
    return;
  }

  /* GUARD 1 + 2 already applied inside rhClassify_ → plan proposals */
  var pool = rhCandidatePool_();
  var plan = rhPlanSwaps_(states, pool, RHCFG);
  lg('proposals ' + plan.proposals.length + ' · quarantine ' + plan.quarantined.length +
     ' · watch ' + plan.watch.length + ' · candidate pool ' + pool.length);

  if (plan.proposals.length) rhWriteSwap_(plan);
  rhDigest_({ suspect: suspect, states: states, audit: audit, roster: roster.length, plan: plan, pool: pool.length });
  lg('watch complete');
}

/* ── staged whole-file UNIVERSE replacement (review, then paste) ── */
function rhWriteSwap_(plan) {
  if (typeof UNIVERSE !== 'string') { Logger.log('rhWriteSwap_: UNIVERSE not in scope — skipped'); return; }
  var lines = UNIVERSE.split('\n').filter(function (l) { return l.trim(); });
  var drops = plan.proposals.map(function (p) { return p.drop; });
  var adds = plan.proposals.map(function (p) {
    return ugMirrorEntry_('pipe', { sym: p.add, name: p.addName, industry: p.addSector });
  });
  var next = rhBuildSwapped_(lines, drops, adds);
  var note = 'UNIVERSE — PROPOSED · ' + new Date().toISOString().slice(0, 10) +
    ' · ' + lines.length + ' → ' + next.length + ' names · dropped: ' + drops.join(', ') +
    ' · added: ' + plan.proposals.map(function (p) { return p.add; }).join(', ') +
    ' · REVIEW BEFORE PASTING';
  var block = rhFormatUniverseBlock_(next, note);
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(RHCFG.SWAP_SHEET) || ss.insertSheet(RHCFG.SWAP_SHEET);
  sh.clear();
  sh.getRange(1, 1, block.length, 1).setValues(block.map(function (l) { return [l]; }));
  Logger.log('RosterSwap written: ' + lines.length + ' → ' + next.length + ' names (proposal only)');
}

/* ── digest email ── */
function rhDigest_(r) {
  var to = RHCFG.DIGEST_TO || Session.getEffectiveUser().getEmail();
  var b = [], plan = r.plan;
  b.push('Roster health — ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  b.push('Roster ' + r.roster + ' · audited ' + r.audit.counts.total +
    ' · bad ' + r.audit.counts.bad + ' · unreadable ' + r.audit.counts.err);
  b.push('');
  if (r.suspect.suspect) {
    b.push('⚠ RUN FROZEN — ' + r.suspect.reason);
    b.push('History was recorded, but NO name was escalated. This guard exists because');
    b.push('a sweep on 25-Jul-2026 flagged 137 of 799 names, every one a false positive,');
    b.push('from a single systemic cause. Re-run next cycle; if it repeats, investigate');
    b.push('the fetch layer rather than the stocks.');
    MailApp.sendEmail({ to: to, subject: '⚠ Roster health — run frozen (systemic)', body: b.join('\n') });
    return;
  }
  if (plan && plan.proposals.length) {
    b.push('PROPOSED SWAPS (' + plan.proposals.length + ') — nothing applied:');
    plan.proposals.forEach(function (p) {
      b.push('  ✖ drop ' + p.drop + '  (' + p.dropVerdict + ' for ' + p.dropStreak + ' consecutive audits)');
      b.push('  ✔ add  ' + p.add + '  ' + p.addName + ' · ' + p.addSector);
    });
    b.push('');
    b.push('A complete replacement UNIVERSE block is staged in the "' + RHCFG.SWAP_SHEET + '" sheet.');
    b.push('Review it, paste over var UNIVERSE in Code.gs, deploy a New version, then run runScan().');
  } else {
    b.push('No swaps proposed.');
  }
  b.push('');
  if (plan) {
    if (plan.quarantined.length) {
      b.push('QUARANTINE (' + plan.quarantined.length + ') — persistently bad, still in the roster, not yet swappable:');
      b.push('  ' + plan.quarantined.join(', '));
    }
    if (plan.watch.length) {
      b.push('WATCH (' + plan.watch.length + ') — one bad audit or unstable data; no action:');
      b.push('  ' + plan.watch.join(', '));
    }
    if (plan.deferred.length) {
      b.push('DEFERRED:');
      plan.deferred.forEach(function (d) { b.push('  ' + d.sym + ' — ' + d.why); });
      b.push('  (build a candidate pool with ugRunGateAuto(), then ugExportBlocks())');
    }
  }
  b.push('');
  b.push('Screened candidates available: ' + (r.pool == null ? '?' : r.pool));
  b.push('Thresholds — WATCH ' + RHCFG.WATCH_N + ' · QUARANTINE ' + RHCFG.QUARANTINE_N +
    ' · REPLACE ' + RHCFG.REPLACE_N + ' consecutive · max ' + RHCFG.MAX_SWAPS_RUN + ' swaps/run');
  b.push('Full per-name history: the "' + RHCFG.RH_SHEET + '" sheet.');
  var subj = (plan && plan.proposals.length)
    ? '🐏 Roster health — ' + plan.proposals.length + ' swap(s) proposed'
    : '✅ Roster health — no action needed';
  MailApp.sendEmail({ to: to, subject: subj, body: b.join('\n') });
  Logger.log('digest emailed to ' + to);
}

/* ── trigger plumbing ── */
function rhChain_() {
  rhUnchain_();
  ScriptApp.newTrigger('rhAutoResume_').timeBased().after(60 * 1000).create();
}
function rhUnchain_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'rhAutoResume_') ScriptApp.deleteTrigger(t);
  });
}
function rhAutoResume_() { ugHealthWatch(); }

function installRosterWatchTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ugHealthWatch') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ugHealthWatch').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(11).create();
  Logger.log('weekly ugHealthWatch trigger installed (Sat ~11:00) — after saturdayHealthRun (~10:00)');
}

/* ── inspection / reset ── */
function rhShowState() {
  var sh = SpreadsheetApp.getActive().getSheetByName(RHCFG.RH_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('no roster history yet — run ugHealthWatch()'); return; }
  var d = sh.getRange(2, 1, Math.min(sh.getLastRow() - 1, 40), 6).getValues();
  var c = { REPLACE_READY: 0, QUARANTINE: 0, WATCH: 0, OK: 0 };
  sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { if (c[r[0]] != null) c[r[0]]++; });
  Logger.log('REPLACE_READY ' + c.REPLACE_READY + ' · QUARANTINE ' + c.QUARANTINE + ' · WATCH ' + c.WATCH + ' · OK ' + c.OK);
  d.forEach(function (r) { if (r[2] !== 'OK') Logger.log('  ' + r[0] + '  ' + r[1] + '  ' + r[2] + '  streak ' + r[3] + '  ' + r[5]); });
}
function rhResetRosterHealth() {
  var ss = SpreadsheetApp.getActive();
  [RHCFG.RH_SHEET, RHCFG.SWAP_SHEET].forEach(function (n) {
    var sh = ss.getSheetByName(n); if (sh) { try { ss.deleteSheet(sh); } catch (e) { sh.clear(); } }
  });
  PropertiesService.getScriptProperties().deleteProperty('RH_PHASE');
  rhUnchain_();
  Logger.log('roster health history cleared — next ugHealthWatch() starts a fresh baseline');
}
