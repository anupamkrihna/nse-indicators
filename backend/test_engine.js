/* Node stub test for Code.gs pure math. GAS services stubbed; routes not exercised. */
const fs = require('fs');
let src = fs.readFileSync(__dirname + '/Code.gs', 'utf8');

// stubs so eval succeeds (services only touched inside route/fetch/store fns)
global.CacheService = { getScriptCache: () => ({ get: () => null, put: () => { } }) };
global.UrlFetchApp = { fetch: () => { throw 'no net in test'; }, fetchAll: () => { throw 'no net'; } };
global.SpreadsheetApp = {}; global.ContentService = {}; global.ScriptApp = {}; global.Logger = { log: console.log };
global.Utilities = { sleep: () => { } };
eval(src);

let pass = 0, fail = 0;
function T(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function approx(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }

console.log('— basics —');
T('sma flat series', approx(sma([2,2,2,2,2], 3)[4], 2));
T('sma known', approx(sma([1,2,3,4,5], 3)[4], 4));
T('ema seeds with sma', approx(ema([1,2,3,4,5,6], 3)[2], 2));
T('ema responds upward', ema([1,2,3,4,5,6], 3)[5] > sma([1,2,3,4,5,6], 3)[5] - 1e-9);
T('linSlope up', approx(linSlope([1,2,3,4]), 1));
T('linSlope flat', approx(linSlope([5,5,5,5]), 0));

console.log('— RSI —');
const up = Array.from({length: 40}, (_, i) => 100 + i);
const dn = Array.from({length: 40}, (_, i) => 140 - i);
T('RSI ~100 in pure uptrend', rsiSeries(up, 14)[39] > 99);
T('RSI ~0 in pure downtrend', rsiSeries(dn, 14)[39] < 1);
T('rsiZone bands', rsiZone(75) === 'overbought' && rsiZone(25) === 'oversold' && rsiZone(50) === 'neutral' && rsiZone(65) === 'bull-zone' && rsiZone(35) === 'bear-zone');

console.log('— divergence —');
{
  // price makes higher high, rsi forced lower at the 2nd peak: synthetic arrays
  const close = [100,105,110,108,106,112,118,115,113]; // peaks at idx2(110) and idx6(118): higher high
  const rsi   = [50, 60, 75, 65, 60, 62, 68, 60, 58];  // rsi peak2 (68) < peak1 (75)
  T('bearish divergence detected', bearishDivergence(close, rsi, 20) === true);
  const rsi2  = [50, 60, 65, 60, 58, 62, 78, 60, 58];  // rsi higher high → no divergence
  T('no divergence when RSI confirms', bearishDivergence(close, rsi2, 20) === false);
}

console.log('— ADX / ATR —');
{
  // strong monotone trend: high ADX expected
  const n = 80, hi = [], lo = [], cl = [];
  for (let i = 0; i < n; i++) { const b = 100 + i * 2; hi.push(b + 1); lo.push(b - 1); cl.push(b); }
  const a = adxPack(hi, lo, cl, 14);
  T('ADX high in strong trend (' + a.value + ')', a.value > 40);
  T('+DI dominates in uptrend', a.plusDI > a.minusDI);
  T('regime says trend/strong', a.regime === 'trend' || a.regime === 'strong');
  // choppy flat series: low ADX
  const hi2 = [], lo2 = [], cl2 = [];
  for (let i = 0; i < n; i++) { const b = 100 + (i % 2 ? 1 : -1); hi2.push(b + 1); lo2.push(b - 1); cl2.push(b); }
  const a2 = adxPack(hi2, lo2, cl2, 14);
  T('ADX low in chop (' + a2.value + ')', a2.value < 20);
  T('ATR positive', atrSeries(hi, lo, cl, 14)[n - 1] > 0);
}

console.log('— Supertrend / PSAR —');
{
  const n = 60, hi = [], lo = [], cl = [];
  for (let i = 0; i < n; i++) { const b = 100 + i * 1.5; hi.push(b + 1); lo.push(b - 1); cl.push(b); }
  T('Supertrend buy in uptrend', supertrend(hi, lo, cl).state === 'buy');
  T('PSAR below in uptrend', psarSide(hi, lo) === 'below');
  const hi2 = hi.map(v => 300 - v), lo2 = lo.map(v => 296 - v), cl2 = cl.map(v => 298 - v);
  T('Supertrend sell in downtrend', supertrend(hi2, lo2, cl2).state === 'sell');
  T('PSAR above in downtrend', psarSide(hi2, lo2) === 'above');
}

console.log('— MACD / Stoch / RMI / OBV —');
{
  const upTrend = Array.from({length: 120}, (_, i) => 100 * Math.pow(1.01, i));
  const m = macdPack(upTrend);
  T('MACD above zero in uptrend', m.aboveZero === true);
  T('MACD hist bull', m.histDir === 'bull');
  const n = 60, hi = [], lo = [], cl = [];
  for (let i = 0; i < n; i++) { const b = 100 + i; hi.push(b + 0.5); lo.push(b - 0.5); cl.push(b + 0.4); }
  const s = stochPack(hi, lo, cl);
  T('Stoch pinned high in trend (' + s.k + ')', s.k > 80);
  T('RMI high in uptrend', rmiValue(upTrend) > 70);
  const vol = Array(120).fill(1000); vol[119] = 3000;
  T('RVOL detects 3× spike', approx(rvol20(vol), 3, 0.01));
  const ob = obvPack(upTrend, Array(120).fill(1000));
  T('OBV rising in uptrend', ob.trend === 'rising');
}

console.log('— crosses & pre-cross —');
{
  // fast rises through slow at a known point
  const N = 100, slow = Array(N).fill(50);
  const fast = Array.from({length: N}, (_, i) => 40 + i * 0.25); // crosses 50 at i=40
  const c = crossState(fast, slow);
  T('cross detected bullish', c.crossed && c.direction === 'bullish');
  T('cross barsAgo ≈ 59', Math.abs(c.barsAgo - 59) <= 1);
  const cd = crossState(fast.map(v => 100 - v), slow);
  T('reverse detected bearish', cd.crossed && cd.direction === 'bearish');

  // pre-cross: fast below slow, converging at 0.1/day, gap 1 → ETA ≈ 10
  const price = 100;
  const slowA = Array(30).fill(60);
  const fastA = Array.from({length: 30}, (_, i) => 57 + i * 0.1); // ends at 59.9, gap -0.1 abs on price=100 → gap% -0.1, vel +0.1%/d
  const pc = precross(fastA, slowA, price, 10);
  T('heading golden', pc.heading === 'golden');
  T('ETA ≈ 1d (' + pc.etaDays + ')', pc.etaDays !== null && pc.etaDays <= 2);
  T('band HOT', pc.band === 'HOT');
  const pcNone = precross(Array(30).fill(55), Array(30).fill(60), price, 10);
  T('parallel lines → none', pcNone.heading === 'none');
  // death approach: fast above slow, falling toward it
  const fastD = Array.from({length: 30}, (_, i) => 63 - i * 0.1);
  const pcd = precross(fastD, slowA, price, 10);
  T('heading death', pcd.heading === 'death');
}

console.log('— hazards & grade —');
{
  function pack(over) {
    return Object.assign({
      adx: { value: 30, regime: 'trend' },
      precross: { heading: 'golden', gapPct: -1.2, etaDays: 12, band: 'HOT' },
      macd: { hist: 1, histExpanding: true, histDir: 'bull', aboveZero: true },
      stoch: { state: 'mid' },
      crossEma: { crossed: false },
      rsiValue: 55, rsiDivergence: false,
      rvol: 1.8, obvTrend: 'rising', sma200SlopePct: 0.2
    }, over);
  }
  T('grade A: trending + confirms', hazardsAndGrade(pack({})).grade === 'A');
  const chop = hazardsAndGrade(pack({ adx: { value: 15, regime: 'chop' } }));
  T('CHOP hazard fires', chop.hazards.some(h => h.code === 'CHOP'));
  T('chop caps grade C', chop.grade === 'C');
  const div = hazardsAndGrade(pack({ rsiDivergence: true }));
  T('DIVERGENCE hazard fires', div.hazards.some(h => h.code === 'DIVERGENCE'));
  T('divergence caps grade C', div.grade === 'C');
  const comp = hazardsAndGrade(pack({ precross: { heading: 'golden', gapPct: -0.3, etaDays: 8, band: 'HOT' }, sma200SlopePct: 0.005 }));
  T('COMPRESSED hazard fires', comp.hazards.some(h => h.code === 'COMPRESSED'));
  const trap = hazardsAndGrade(pack({ stoch: { state: 'overbought' } }));
  T('STOCH_TRAP fires in trend', trap.hazards.some(h => h.code === 'STOCH_TRAP'));
  const noise = hazardsAndGrade(pack({ crossEma: { crossed: true, fresh: true, direction: 'bullish', barsAgo: 2 }, macd: { hist: 1, histExpanding: false, histDir: 'bull', aboveZero: true } }));
  T('MACD_NOISE fires on unconfirmed fresh cross', noise.hazards.some(h => h.code === 'MACD_NOISE'));
  T('no heading → grade null', hazardsAndGrade(pack({ precross: { heading: 'none' } })).grade === null);
}

console.log('— full pack on synthetic OHLCV —');
{
  // 300 bars: long downtrend, then a young recovery — EMA50 still below EMA200 and converging
  const n = 290, cl = [], hi = [], lo = [], vol = [];
  for (let i = 0; i < n; i++) {
    let b = i < 240 ? 200 - i * 0.35 : 200 - 240 * 0.35 + (i - 240) * 0.7;
    cl.push(b); hi.push(b * 1.01); lo.push(b * 0.99); vol.push(1000 + (i > 280 ? 800 : 0));
  }
  const p = computePack({ close: cl, high: hi, low: lo, volume: vol, adjusted: true }, true);
  T('pack ok', p.ok === true);
  T('bars=290', p.bars === 290);
  T('series windowed to 220', p.series.close.length === 220);
  T('EMA50 still below EMA200', p.ema.e50 < p.ema.e200);
  T('precross heading golden (' + JSON.stringify(p.precross) + ')', p.precross.heading === 'golden');
  T('ETA finite (' + p.precross.etaDays + 'd)', p.precross.etaDays !== null && p.precross.etaDays > 0);
  T('band WATCH or HOT', p.precross.band === 'WATCH' || p.precross.band === 'HOT');
  T('grade assigned for approaching cross', p.grade === 'A' || p.grade === 'B' || p.grade === 'C');
  const short = computePack({ close: cl.slice(0, 100), high: hi.slice(0, 100), low: lo.slice(0, 100), volume: vol.slice(0, 100), adjusted: true }, false);
  T('short history rejected honestly', short.ok === false && /insufficient/.test(short.error));
}


console.log('— partial-bar trimming (confirm on close) —');
{
  const IST=19800;
  // helper: seconds timestamp for an IST day at 09:15
  function mk(nBars, lastIsToday, nowIstMin){
    const today=Math.floor((Date.now()/1000+IST)/86400);
    const bars={close:[],high:[],low:[],volume:[],ts:[],adjusted:true};
    for(let i=0;i<nBars;i++){
      const day=today-(nBars-1-i);
      bars.close.push(100+i);bars.high.push(101+i);bars.low.push(99+i);bars.volume.push(1000);
      bars.ts.push((day*86400-IST)+555*60); // 09:15 IST that day
    }
    if(!lastIsToday){bars.ts[nBars-1]-=86400;} // shift last bar to yesterday
    const nowMs=((today*86400-IST)+nowIstMin*60)*1000;
    return trimPartialBar(JSON.parse(JSON.stringify(bars)), nowMs);
  }
  const open_=mk(10,true,590);   // 09:50 IST, last bar today → drop
  T('partial bar dropped at 09:50', open_.partialDropped===true && open_.close.length===9);
  T('live price preserved', open_.live && approx(open_.live.price,109));
  const closed=mk(10,true,960);  // 16:00 IST, last bar today → keep
  T('kept after close', !closed.partialDropped && closed.close.length===10);
  const yest=mk(10,false,590);   // 09:50 but last bar is yesterday (holiday/weekend) → keep
  T('kept when last bar is a prior day', !yest.partialDropped && yest.close.length===10);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
