/* test_render.js — EXECUTION smoke test for indicators.html render functions.
   Exists because `node --check` validates syntax only: it happily passed a
   version of bullDiveBlock_ that referenced a deleted `extra` variable, which
   threw ReferenceError for every stock with bull.on (found on THANGAMAYL,
   26-Jul-2026). A ReferenceError inside a function body only surfaces when the
   function is CALLED, so this harness loads the inline script and calls the
   pure render helpers with mock payloads. */
const fs = require('fs'), path = require('path'), vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'indicators.html'), 'utf8');
const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1]).filter(s => s.trim()).join('\n;\n');

/* minimal browser stubs so top-level wiring does not throw on load */
const el = () => ({ textContent: '', innerHTML: '', value: '', className: '', style: {},
  dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null });
const sandbox = {
  console,
  document: { getElementById: el, querySelector: el, querySelectorAll: () => [],
    createElement: el, addEventListener() {}, body: el() },
  window: {}, location: { href: '', search: '' },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.window = sandbox;

let fails = 0;
function ok(n, c, err) { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n + (err ? '  → ' + err : '')); if (!c) fails++; }

const ctx = vm.createContext(sandbox);
try { vm.runInContext(js, ctx); ok('inline script loads without throwing', true); }
catch (e) { ok('inline script loads without throwing', false, e.message); process.exit(1); }

function call(fn, arg, label) {
  if (typeof ctx[fn] !== 'function') { ok(label + ' (' + fn + ' present)', false, 'not defined'); return; }
  try { const out = ctx[fn](arg); ok(label, typeof out === 'string'); }
  catch (e) { ok(label, false, e.constructor.name + ': ' + e.message); }
}

/* the exact shape scalarRow/computePack emit for a bull-on stock */
const bull = (cls, reasons) => ({ bull: { ok: true, on: true, cls, grade: null,
  s20: 1.2, s50: 0.8, s200: 0.3, ext200: 12.5, dist50: 6.1,
  stacked: true, pHold: 0.62, pullTail: 0.18, reasons: reasons || [] } });

console.log('\n── bullDiveBlock_ across every D-005 class ──');
['STRONG', 'BULL', 'EXTENDED', 'WEAKENING', 'PULLBACK'].forEach(c =>
  call('bullDiveBlock_', bull(c, c === 'STRONG' ? [] : ['extended 34% over 200']), 'renders ' + c));
call('bullDiveBlock_', bull('LEGACY_UNKNOWN'), 'unknown class does not throw');
call('bullDiveBlock_', { bull: { ok: true, on: false } }, 'bull-off returns empty');
call('bullDiveBlock_', {}, 'missing bull object handled');

console.log('\n── null-tolerance (pHold/pullTail can be null) ──');
const nul = bull('EXTENDED'); nul.bull.pHold = null; nul.bull.pullTail = null;
call('bullDiveBlock_', nul, 'null pHold/pullTail handled');

console.log('\n── black sheep chip + flag text ──');
['BLACKSHEEP', 'GREY', 'CLEAN'].forEach(v =>
  call('bsChipHtml_', { verdict: v, flags: [{ sev: 'HIGH', text: 'x' }], newsContext: [], newsOk: true }, 'bsChipHtml_ ' + v));
call('bsFlagText_', { flags: [{ sev: 'HIGH', text: 'gap' }], newsContext: [{ text: 'headline' }], newsOk: true }, 'bsFlagText_ with news');
call('bsFlagText_', { flags: [], newsContext: [], newsOk: false }, 'bsFlagText_ with failed news fetch');

console.log('\n── drawDive: chart additions (20 DMA, ADX shading, 52w band, volume) ──');
(function () {
  /* build a payload shaped exactly like computePack(bars, true) */
  function pack(opts) {
    opts = opts || {};
    var n = opts.n || 220, cl = [], e20 = [], e50 = [], e200 = [], s50 = [], s200 = [], obv = [], adx = [], vol = [];
    var p = 100, r = 7;
    for (var i = 0; i < n; i++) {
      r = (1103515245 * r + 12345) % 2147483648;
      p = Math.max(1, p * (1 + ((r / 2147483648) - 0.49) * 0.03));
      cl.push(Math.round(p * 100) / 100);
      e20.push(i < 19 ? null : p * 0.99);
      e50.push(i < 49 ? null : p * 0.97);
      e200.push(i < 199 ? null : p * 0.93);
      s50.push(i < 49 ? null : p * 0.97);
      s200.push(i < 199 ? null : p * 0.93);
      obv.push(i * 1000);
      vol.push(50000 + (r % 200000));
      adx.push(i < 28 ? null : (opts.adx != null ? opts.adx : (i % 40 < 15 ? 18 : 31)));
    }
    var o = {
      ok: true, price: cl[n - 1], bars: n,
      series: { close: cl, volume: vol, ema20: e20, ema50: e50, ema200: e200, sma50: s50, sma200: s200, obv: obv, adx: adx },
      precross: opts.precross || { heading: 'golden', gapPct: -1.2, velPctPerDay: 0.05, etaDays: 12, band: 'HOT' },
      high52: opts.high52 === undefined ? Math.max.apply(null, cl) : opts.high52,
      low52: opts.low52 === undefined ? Math.min.apply(null, cl) : opts.low52,
      pct52w: 94.2
    };
    if (opts.drop) opts.drop.forEach(function (k) { delete o.series[k]; });
    return o;
  }
  function run(label, p) {
    if (typeof ctx.drawDive !== 'function') { ok(label + ' (drawDive present)', false, 'not defined'); return; }
    try { ctx.drawDive(p); ok(label, true); }
    catch (e) { ok(label, false, e.constructor.name + ': ' + e.message); }
  }
  run('renders with all new layers', pack());
  run('all-chop series (ADX shading spans everything)', pack({ adx: 12 }));
  run('all-trending series (no shading)', pack({ adx: 40 }));
  run('no approaching cross (no projection)', pack({ precross: { heading: 'none' } }));
  run('death cross approaching', pack({ precross: { heading: 'death', etaDays: 20, gapPct: 1.1, velPctPerDay: -0.04, band: 'WATCH' } }));

  console.log('   — graceful degradation when the backend has not been redeployed —');
  run('missing series.adx (old backend)', pack({ drop: ['adx'] }));
  run('missing series.ema20', pack({ drop: ['ema20'] }));
  run('missing series.volume', pack({ drop: ['volume'] }));
  run('missing high52/low52', pack({ high52: null, low52: null }));
  run('all new fields absent at once', (function () {
    var p = pack({ high52: null, low52: null, drop: ['adx', 'ema20', 'volume'] }); return p;
  })());

  console.log('   — edge cases —');
  run('flat series (zero price range)', (function () {
    var p = pack(); p.series.close = p.series.close.map(function () { return 100; });
    p.high52 = 100; p.low52 = 100; return p;
  })());
  run('zero volume throughout', (function () {
    var p = pack(); p.series.volume = p.series.volume.map(function () { return 0; }); return p;
  })());
  run('short series (200 bars)', pack({ n: 200 }));
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
