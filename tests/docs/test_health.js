/* test_health.js — pure-math checks for Health.gs (bullClassTable_, sheepDiff_)
   and the sellBrier_ contract that runBullScore reuses. */

// ---- copies of the pure functions under test (kept byte-identical to Health.gs) ----
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
function sheepDiff_(prevFlagged, curr) {
  var prev = {};
  (prevFlagged || []).forEach(function (s) { prev[s] = 1; });
  var flagged = [], k;
  for (k in curr) { if (!curr.hasOwnProperty(k)) continue; var v = curr[k]; if (v === 'BLACKSHEEP' || v === 'GREY') flagged.push(k); }
  var newly = flagged.filter(function (s) { return !prev[s]; });
  var cleared = (prevFlagged || []).filter(function (s) { return curr[s] === 'CLEAN'; });
  return { flagged: flagged.sort(), newly: newly.sort(), cleared: cleared.sort() };
}
// sellBrier_ contract (from Code.gs) that runBullScore relies on
function sellBrier_(pairs) {
  if (!pairs.length) return null;
  var s = 0; for (var i = 0; i < pairs.length; i++) { var d = pairs[i].p - pairs[i].y; s += d * d; }
  return Math.round(s / pairs.length * 10000) / 10000;
}

let fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) fails++; }
function approx(a, b) { return Math.abs(a - b) < 1e-9; }

// ── bullClassTable_ ──────────────────────────────────────────────
(function () {
  var rows = [
    { cls: 'STRONG', held: 1, fwd: 0.08 }, { cls: 'STRONG', held: 1, fwd: 0.04 }, { cls: 'STRONG', held: 0, fwd: -0.02 },
    { cls: 'BULL', held: 1, fwd: 0.03 }, { cls: 'BULL', held: 0, fwd: -0.01 },
    { cls: 'CAUTION', held: 0, fwd: -0.06 }, { cls: 'CAUTION', held: 0, fwd: -0.03 }, { cls: 'CAUTION', held: 1, fwd: 0.01 }
  ];
  var t = bullClassTable_(rows);
  ok('STRONG n counted', t.STRONG.n === 3);
  ok('STRONG holdRate = 2/3', approx(t.STRONG.holdRate, 0.667));
  ok('STRONG meanFwd', approx(t.STRONG.meanFwd, Math.round((0.08 + 0.04 - 0.02) / 3 * 10000) / 10000));
  ok('CAUTION holdRate = 1/3', approx(t.CAUTION.holdRate, 0.333));
  ok('health signal: STRONG holdRate > CAUTION holdRate', t.STRONG.holdRate > t.CAUTION.holdRate);
  ok('empty class → nulls, not NaN', bullClassTable_([]).STRONG.holdRate === null);
  ok('unknown class ignored', bullClassTable_([{ cls: 'ZZZ', held: 1, fwd: 1 }]).STRONG.n === 0);
})();

// ── sheepDiff_ ───────────────────────────────────────────────────
(function () {
  var prev = ['GAYAPROJ', 'FOO'];
  var curr = { GAYAPROJ: 'BLACKSHEEP', FOO: 'CLEAN', BAR: 'GREY', BAZ: 'CLEAN', QUX: 'BLACKSHEEP' };
  var d = sheepDiff_(prev, curr);
  ok('flagged = current BLACKSHEEP+GREY sorted', JSON.stringify(d.flagged) === JSON.stringify(['BAR', 'GAYAPROJ', 'QUX']));
  ok('newly = flagged not in prev', JSON.stringify(d.newly) === JSON.stringify(['BAR', 'QUX']));
  ok('cleared = prev now CLEAN', JSON.stringify(d.cleared) === JSON.stringify(['FOO']));
  ok('GAYAPROJ persists (not newly)', d.newly.indexOf('GAYAPROJ') === -1);
  var first = sheepDiff_([], { A: 'GREY', B: 'CLEAN' });
  ok('first sweep: everything flagged is newly', JSON.stringify(first.newly) === JSON.stringify(['A']));
  ok('ERROR verdict is not flagged', sheepDiff_([], { A: 'ERROR' }).flagged.length === 0);
})();

// ── sellBrier_ contract used by runBullScore ─────────────────────
(function () {
  ok('perfect P(hold) → Brier 0', sellBrier_([{ p: 1, y: 1 }, { p: 0, y: 0 }]) === 0);
  ok('worst → Brier 1', sellBrier_([{ p: 1, y: 0 }, { p: 0, y: 1 }]) === 1);
  ok('empty → null', sellBrier_([]) === null);
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
