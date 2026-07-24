/* test_bsfetch.js — reproduces the Black Sheep input-path bug and verifies the fix.
   Models the BS state machine + bsFetch_ dedupe guard in isolation. */

function makeEngine(guardVariant) {
  const BS = {};
  let calls = 0;                       // real "network" calls made
  function fakeFetch(sym) { calls++; return Promise.resolve({ ok: true, verdict: 'CLEAN', sym }); }

  function bsFetch_(sym) {
    if (BS[sym] && !BS[sym].pending && !BS[sym].error) return Promise.resolve(BS[sym]);

    if (guardVariant === 'old') {
      // BUG: returns whatever .pending holds — even a boolean placeholder
      if (BS[sym] && BS[sym].pending) return BS[sym].pending;
    } else {
      // FIX: only join a real in-flight promise; else fall through and fetch
      if (BS[sym] && BS[sym].pending && typeof BS[sym].pending.then === 'function') return BS[sym].pending;
    }

    const p = fakeFetch(sym).then(j => { BS[sym] = j; return j; });
    BS[sym] = { pending: p };
    return p;
  }

  // mirrors renderSheepPending_: seeds a BOOLEAN placeholder so the row paints "checking…"
  function seedPendingPlaceholder(sym) { BS[sym] = BS[sym] || { pending: true }; }

  return { BS, bsFetch_, seedPendingPlaceholder, calls: () => calls };
}

// Reproduces sheepCheckInput(): delete → seed boolean placeholder → bsFetch_.then(...)
function runInputPath(engine, sym) {
  delete engine.BS[sym];
  engine.seedPendingPlaceholder(sym);          // BS[sym] = {pending:true}
  const ret = engine.bsFetch_(sym);
  return ret;
}

let failures = 0;
function ok(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; }

(async () => {
  // 1) OLD guard: input path returns a non-thenable → .then would throw → no fetch
  const oldEng = makeEngine('old');
  const oldRet = runInputPath(oldEng, 'GAYAPROJ');
  ok('old guard returns a non-thenable (the break)', !(oldRet && typeof oldRet.then === 'function'));
  ok('old guard never fires the network call', oldEng.calls() === 0);

  // 2) NEW guard: input path returns a real promise resolving to a verdict, one fetch fired
  const newEng = makeEngine('fix');
  const newRet = runInputPath(newEng, 'GAYAPROJ');
  ok('new guard returns a thenable', newRet && typeof newRet.then === 'function');
  const res = await newRet;
  ok('new guard resolves to a verdict', res && res.verdict === 'CLEAN');
  ok('new guard fires exactly one network call', newEng.calls() === 1);

  // 3) NEW guard still dedupes concurrent real fetches (portfolio/matrix behaviour intact)
  const dedupe = makeEngine('fix');
  const a = dedupe.bsFetch_('RELIANCE');
  const b = dedupe.bsFetch_('RELIANCE');   // second call while first in-flight → must join, not refetch
  ok('new guard joins an in-flight fetch (same promise)', a === b);
  await a;
  ok('new guard dedupes concurrent calls to one network hit', dedupe.calls() === 1);

  // 4) NEW guard returns cached resolved verdict without refetching
  const c = await dedupe.bsFetch_('RELIANCE');
  ok('new guard serves cached verdict, no refetch', dedupe.calls() === 1 && c.verdict === 'CLEAN');

  console.log(failures ? ('\n' + failures + ' FAILURE(S)') : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
