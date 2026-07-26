/* test_rosterhealth.js — the safety core of roster auto-maintenance.
   Every guard here traces to a real incident; the scenario tests at the
   bottom replay them. Pure functions copied byte-identical from the .gs. */

var RHCFG = {
  HIST_KEEP: 12, WATCH_N: 1, QUARANTINE_N: 3, REPLACE_N: 5,
  FLAP_WINDOW: 8, FLAP_MIN: 4, MAX_SWAPS_RUN: 5,
  SUSPECT_BAD_PCT: 0.10, SUSPECT_ERR_PCT: 0.25, MIN_COVERAGE: 0.95
};
function rhIsBad_(ch) { return ch === 'D' || ch === 'P'; }
function rhIsUnknown_(ch) { return ch === 'X'; }
function rhCharOf_(verdict) {
  var v = String(verdict || '').toUpperCase();
  if (v === 'DEAD') return 'D';
  if (v === 'PROBLEM') return 'P';
  if (v === 'CAUTION') return 'C';
  if (v === 'OK') return 'O';
  return 'X';
}
function rhPush_(hist, ch, keep) {
  keep = keep || RHCFG.HIST_KEEP;
  var h = String(hist || '') + ch;
  return h.length > keep ? h.slice(h.length - keep) : h;
}
function rhStreak_(hist) {
  var h = String(hist || ''), n = 0;
  for (var i = h.length - 1; i >= 0; i--) {
    var c = h.charAt(i);
    if (rhIsUnknown_(c)) continue;
    if (rhIsBad_(c)) { n++; continue; }
    break;
  }
  return n;
}
function rhFlaps_(hist, win) {
  win = win || RHCFG.FLAP_WINDOW;
  var h = String(hist || '');
  var s = h.length > win ? h.slice(h.length - win) : h, n = 0;
  for (var i = 0; i < s.length; i++) if (rhIsBad_(s.charAt(i))) n++;
  return n;
}
function rhClassify_(hist, cfg) {
  cfg = cfg || RHCFG;
  var streak = rhStreak_(hist), flaps = rhFlaps_(hist, cfg.FLAP_WINDOW);
  var status;
  if (streak >= cfg.REPLACE_N) status = 'REPLACE_READY';
  else if (streak >= cfg.QUARANTINE_N) status = 'QUARANTINE';
  else if (streak >= cfg.WATCH_N) status = 'WATCH';
  else if (flaps >= cfg.FLAP_MIN) status = 'WATCH';
  else status = 'OK';
  return { status: status, streak: streak, flaps: flaps };
}
function rhRunSuspect_(counts, cfg) {
  cfg = cfg || RHCFG;
  var total = counts && counts.total ? counts.total : 0;
  if (!total) return { suspect: true, reason: 'empty run — nothing audited' };
  if (counts.expected && total < counts.expected * cfg.MIN_COVERAGE)
    return { suspect: true, reason: 'audit incomplete' };
  var badPct = (counts.bad || 0) / total, errPct = (counts.err || 0) / total;
  if (badPct > cfg.SUSPECT_BAD_PCT) return { suspect: true, reason: 'bad pct' };
  if (errPct > cfg.SUSPECT_ERR_PCT) return { suspect: true, reason: 'err pct' };
  return { suspect: false, reason: null };
}
function rhPlanSwaps_(states, candidates, cfg) {
  cfg = cfg || RHCFG;
  var ready = (states || []).filter(function (s) { return s.status === 'REPLACE_READY'; })
    .sort(function (a, b) { return (b.streak || 0) - (a.streak || 0); });
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

let fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) fails++; }
function st(h) { return rhClassify_(h).status; }

console.log('── verdict mapping ──');
ok('DEAD→D', rhCharOf_('DEAD') === 'D');
ok('PROBLEM→P', rhCharOf_('PROBLEM') === 'P');
ok('CAUTION→C (healthy)', rhCharOf_('CAUTION') === 'C' && !rhIsBad_('C'));
ok('OK→O', rhCharOf_('OK') === 'O');
ok('unknown/ERROR→X', rhCharOf_('ERROR') === 'X' && rhCharOf_('') === 'X' && rhCharOf_(null) === 'X');

console.log('\n── GUARD 1: per-name debounce ──');
ok('one bad audit does NOT quarantine', st('OOOOD') === 'WATCH');
ok('two bad audits still only WATCH', st('OOODD') === 'WATCH');
ok('three consecutive → QUARANTINE', st('OODDD') === 'QUARANTINE');
ok('four consecutive → still QUARANTINE', st('ODDDD') === 'QUARANTINE');
ok('five consecutive → REPLACE_READY', st('DDDDD') === 'REPLACE_READY');
ok('recovery de-escalates out of actionable status', st('DDDDO') === 'WATCH');
ok('  (streak cleared — it stays on WATCH only while bad history is in the window)',
  rhClassify_('DDDDO').streak === 0);
ok('recovery from REPLACE_READY drops to non-actionable', st('DDDDDO') === 'WATCH');
ok('bad history ages out of the window → OK', st('DDDDOOOOOOOO') === 'OK');
ok('all-healthy history → OK', st('OOOOOOOO') === 'OK');
ok('empty history → OK', st('') === 'OK');
ok('mixed P and D both count as bad', st('OOPDP') === 'QUARANTINE');

console.log('\n── GUARD 2: error ≠ death (the AURIONPRO lesson) ──');
ok('a lone unreadable run does nothing', st('OOOOX') === 'OK');
ok('all-unknown history → OK, never escalates', st('XXXXXX') === 'OK');
ok('X does not RESET a genuine bad streak', rhStreak_('DDXD') === 3);
ok('  → and that name still quarantines', st('ODDXD') === 'QUARANTINE');
ok('X does not COUNT toward escalation', rhStreak_('OXXXX') === 0);
ok('  → so an outage cannot manufacture a quarantine', st('OOOXXXX') === 'OK');
ok('recovery after X still resets', st('DDDXO') === 'OK');

console.log('\n── flapping (unstable source, not yet actionable) ──');
ok('4 bad in 8, never consecutive → WATCH not QUARANTINE', st('DODODODO') === 'WATCH');
ok('  (streak is 0 — it is the flap rule firing)', rhStreak_('DODODODO') === 0);
ok('2 bad in 8 → OK', st('DOOODOOO') === 'OK');

console.log('\n── history retention ──');
ok('push keeps last N', rhPush_('OOOOOOOOOOOO', 'D', 12).length === 12);
ok('push appends newest at the end', rhPush_('OOO', 'D') === 'OOOD');
ok('oldest is dropped first', rhPush_('DOOOOOOOOOOO', 'O', 12).charAt(0) === 'O');

console.log('\n── GUARD 3: systemic circuit breaker (the 137/799 lesson) ──');
ok('REPLAY: 137 bad of 799 → run suspect, escalation frozen',
  rhRunSuspect_({ bad: 137, err: 0, total: 799 }).suspect === true);
ok('REPLAY: 219 flagged of 799 → suspect',
  rhRunSuspect_({ bad: 219, err: 0, total: 799 }).suspect === true);
ok('a plausible 3 bad of 799 → run trusted',
  rhRunSuspect_({ bad: 3, err: 0, total: 799 }).suspect === false);
ok('mass unreadable (fetch layer down) → suspect',
  rhRunSuspect_({ bad: 0, err: 300, total: 799 }).suspect === true);
ok('a few unreadable is fine', rhRunSuspect_({ bad: 1, err: 20, total: 799 }).suspect === false);
ok('empty run → suspect (never act on nothing)', rhRunSuspect_({ bad: 0, err: 0, total: 0 }).suspect === true);
ok('boundary: exactly 10% bad is NOT suspect', rhRunSuspect_({ bad: 10, err: 0, total: 100 }).suspect === false);
ok('boundary: 11% bad IS suspect', rhRunSuspect_({ bad: 11, err: 0, total: 100 }).suspect === true);

console.log('\n── swap planner: proposals only, capped ──');
(function () {
  var states = [
    { sym: 'DEADCO1', status: 'REPLACE_READY', streak: 7, lastVerdict: 'DEAD' },
    { sym: 'DEADCO2', status: 'REPLACE_READY', streak: 5, lastVerdict: 'DEAD' },
    { sym: 'SICKCO', status: 'QUARANTINE', streak: 3, lastVerdict: 'PROBLEM' },
    { sym: 'WOBBLY', status: 'WATCH', streak: 1, lastVerdict: 'PROBLEM' },
    { sym: 'FINECO', status: 'OK', streak: 0, lastVerdict: 'OK' }
  ];
  var cands = [{ sym: 'NEWCO1', name: 'New One', sector: 'IT' }, { sym: 'NEWCO2', name: 'New Two', sector: 'Pharma' }];
  var p = rhPlanSwaps_(states, cands);
  ok('only REPLACE_READY gets proposed', p.proposals.length === 2);
  ok('worst-persisting proposed first', p.proposals[0].drop === 'DEADCO1');
  ok('each proposal pairs a drop with an add', p.proposals[0].add === 'NEWCO1' && p.proposals[1].add === 'NEWCO2');
  ok('QUARANTINE listed but NOT swapped', p.quarantined.length === 1 && p.quarantined[0] === 'SICKCO');
  ok('WATCH listed but NOT swapped', p.watch.length === 1 && p.watch[0] === 'WOBBLY');

  var none = rhPlanSwaps_(states, []);
  ok('no candidates → deferred, never a bare deletion', none.proposals.length === 0 && none.deferred.length === 2);
  ok('  deferral gives a reason', /no screened replacement/.test(none.deferred[0].why));

  var many = [], mc = [];
  for (var i = 0; i < 12; i++) { many.push({ sym: 'D' + i, status: 'REPLACE_READY', streak: 6 }); mc.push({ sym: 'N' + i }); }
  var capped = rhPlanSwaps_(many, mc);
  ok('per-run swap cap enforced (no mass churn)', capped.proposals.length === RHCFG.MAX_SWAPS_RUN);
  ok('  overflow is deferred, not dropped', capped.deferred.length === 12 - RHCFG.MAX_SWAPS_RUN);
})();

console.log('\n── end-to-end scenarios ──');
(function () {
  // AURIONPRO: healthy stock, one transient bad reading mid-corporate-action
  var h = '';
  ['OK', 'OK', 'OK', 'OK', 'DEAD', 'OK', 'OK'].forEach(function (v) { h = rhPush_(h, rhCharOf_(v)); });
  ok('AURIONPRO replay: never escalated past WATCH, ends OK', st(h) === 'OK' && h === 'OOOODOO');

  // a genuinely dead ticker (renamed) — sustained, with one unreadable run in the middle
  var d = '';
  ['OK', 'OK', 'DEAD', 'DEAD', 'ERROR', 'DEAD', 'DEAD', 'DEAD'].forEach(function (v) { d = rhPush_(d, rhCharOf_(v)); });
  ok('genuine dead ticker replay: reaches REPLACE_READY', st(d) === 'REPLACE_READY');
  ok('  and the unreadable run did not delay it', rhClassify_(d).streak === 5);

  // the 25-Jul false-positive sweep: run frozen, so nothing escalates even though
  // every name individually looked bad that run
  var run = rhRunSuspect_({ bad: 137, err: 0, total: 799 });
  var wouldEscalate = run.suspect ? 0 : 137;
  ok('25-Jul sweep replay: zero names escalated', wouldEscalate === 0);
})();

// ══════════════ PART 2: universe swap generation ══════════════
function rhSymOfLine_(line) { return String(line || '').split('|')[0].trim().toUpperCase(); }
function rhBuildSwapped_(lines, dropSyms, addLines) {
  var drop = {};
  (dropSyms || []).forEach(function (s) { drop[String(s).toUpperCase()] = 1; });
  var kept = (lines || []).filter(function (l) { return l.trim() && !drop[rhSymOfLine_(l)]; });
  var out = kept.concat((addLines || []).filter(function (l) { return l && l.trim(); }));
  out.sort(function (a, b) { var x = rhSymOfLine_(a), y = rhSymOfLine_(b); return x < y ? -1 : x > y ? 1 : 0; });
  return out;
}
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

console.log('\n── coverage guard (audit incomplete) ──');
ok('partial audit → suspect', rhRunSuspect_({bad:1,err:0,total:400,expected:799},
   Object.assign({},RHCFG,{MIN_COVERAGE:0.95})).suspect === true);
ok('full audit → trusted', rhRunSuspect_({bad:1,err:0,total:799,expected:799},
   Object.assign({},RHCFG,{MIN_COVERAGE:0.95})).suspect === false);
ok('96% coverage → trusted', rhRunSuspect_({bad:1,err:0,total:767,expected:799},
   Object.assign({},RHCFG,{MIN_COVERAGE:0.95})).suspect === false);

console.log('\n── swap construction ──');
(function(){
  var lines = [
    'AAA|Alpha|IT|AAA.NS',
    'MMM|Mid Co|Pharma|MMM.NS',
    'ZZZ|Zeta|Power|ZZZ.NS'
  ];
  var next = rhBuildSwapped_(lines, ['MMM'], ['BBB|Beta|Metals|BBB.NS']);
  ok('drop removes exactly one line', next.length === 3);
  ok('dropped sym gone', next.filter(function(l){return rhSymOfLine_(l)==='MMM';}).length === 0);
  ok('added sym present', next.filter(function(l){return rhSymOfLine_(l)==='BBB';}).length === 1);
  ok('result re-sorted alphabetically',
    next.map(rhSymOfLine_).join(',') === 'AAA,BBB,ZZZ');
  ok('count preserved on 1-for-1 swap', next.length === lines.length);

  var same = rhBuildSwapped_(lines, [], []);
  ok('no-op swap returns the same set', same.length === 3 && same.map(rhSymOfLine_).join(',')==='AAA,MMM,ZZZ');
  ok('dropping an absent sym is harmless', rhBuildSwapped_(lines,['NOPE'],[]).length === 3);
})();

console.log('\n── UNIVERSE block emission ──');
(function(){
  var lines = ['AAA|Alpha|IT|AAA.NS','DIVISLAB|Divi\'s Laboratories|Pharma|DIVISLAB.NS','ZZZ|Zeta|Power|ZZZ.NS'];
  var b = rhFormatUniverseBlock_(lines, 'test note');
  ok('note emitted as a comment', /^\/\* test note \*\/$/.test(b[0]));
  ok('declaration line present', b[1] === 'var UNIVERSE =');
  ok('non-final lines end with \\n\' +', b[2].slice(-5) === "\\n' +");
  ok('final line terminates the statement', b[b.length-1].slice(-2) === "';");
  ok('apostrophe in a name is escaped', b[3].indexOf("Divi\\'s") > 0);
  ok('one source line per name (+2 header)', b.length === lines.length + 2);

  // round-trip: eval the emitted block and confirm it reconstructs the same lines
  var src = b.slice(1).join('\n');
  var UNIVERSE = null; eval(src);
  var back = UNIVERSE.split('\n');
  ok('ROUND-TRIP: block evaluates back to the identical line list',
    JSON.stringify(back) === JSON.stringify(lines));
  ok('ROUND-TRIP: apostrophe survives intact', back[1].indexOf("Divi's Laboratories") > 0);
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
