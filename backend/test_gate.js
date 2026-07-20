/* test_gate.js — regression gate for UniverseGate.gs v1.0.
   Sources the PURE FUNCTIONS block verbatim. Node-only. */
var fs = require('fs');
var src = fs.readFileSync('UniverseGate.gs', 'utf8');
var cfg = src.match(/var UG_INDEX_CSV[\s\S]*?var UG_SHEET[^;]*;/);
var m = src.match(/\/\* ══════════════ PURE FUNCTIONS[\s\S]*?(?=\/\* ══════════════ GAS-ONLY)/);
if (!m || !cfg) { console.error('✗ source blocks not found'); process.exit(1); }
eval(cfg[0]); eval(m[0]);

var n = 0, bad = 0;
function T(name, cond){ n++; if(!cond){ bad++; console.log('  ✗ ' + name); } }
var DAY = 86400, T0 = 1700000000;
function series(steps){ var ts=[T0]; steps.forEach(function(s){ ts.push(ts[ts.length-1]+s*DAY); }); return ts; }
function flat(len,v){ var a=[]; for(var i=0;i<len;i++) a.push(v); return a; }
function weekSteps(nBars){ var s=[]; for(var i=0;i<nBars-1;i++) s.push(i%5===4?3:1); return s; }

/* ── CSV parsing ── */
var csv = 'Company Name,Industry,Symbol,Series,ISIN Code\n' +
  'Gayatri Projects Ltd.,CONSTRUCTION,GAYAPROJ,EQ,INE336H01023\n' +
  '"Kirloskar Oil Engines Ltd.",CAPITAL GOODS,KIRLOSENG,EQ,INE146L01010\n' +
  'Some BE Stock Ltd.,SERVICES,BESTOCK,BE,INE000000000\n' +
  '"Quoted, Comma Co Ltd.",FINANCIAL SERVICES,QCOMMA,EQ,INE111111111\n' +
  '\n';
var parsed = ugParseCsv_(csv);
T('csv: EQ rows parsed', parsed.length === 3);
T('csv: BE series excluded', !parsed.some(function(c){ return c.sym === 'BESTOCK'; }));
T('csv: quoted comma name intact', parsed.some(function(c){ return c.sym === 'QCOMMA' && c.name === 'Quoted, Comma Co Ltd.'; }));
T('csv: fields mapped', parsed[0].sym === 'GAYAPROJ' && parsed[0].isin === 'INE336H01023' && parsed[0].industry === 'CONSTRUCTION');

/* ── gate: clean liquid stock → ADMIT ── */
var ts = series(weekSteps(400));
T('clean 400-bar liquid stock → ADMIT', ugScanBars_(ts, flat(400,100), flat(400,500000)).decision === 'ADMIT');

/* ── gate: Gayatri pattern → REJECT with restructuring reason ── */
(function(){
  var steps = weekSteps(200); steps.push(115); weekSteps(70).forEach(function(s){ steps.push(s); });
  var t2 = series(steps), n2 = t2.length, cl = flat(n2,100);
  for (var i = 200; i < n2; i++) cl[i] = 65;
  var v = ugScanBars_(t2, cl, flat(n2,500000));
  T('gayatri → REJECT', v.decision === 'REJECT');
  T('gayatri reason names the jump+gap', /jump across a \d+-day gap/.test(v.reason));
})();

/* ── gate: gap without jump, few bars since → REJECT suspension pattern ── */
(function(){
  var steps = weekSteps(300); steps.push(30); weekSteps(50).forEach(function(s){ steps.push(s); });
  var t2 = series(steps);
  var v = ugScanBars_(t2, flat(t2.length,100), flat(t2.length,500000));
  T('gap + <200 bars since → REJECT', v.decision === 'REJECT' && /suspension/.test(v.reason));
})();

/* ── gate: old gap, plenty of bars since → still REJECT for manual review ── */
(function(){
  var steps = [20]; weekSteps(260).forEach(function(s){ steps.push(s); });
  var t2 = series(steps);
  var v = ugScanBars_(t2, flat(t2.length,100), flat(t2.length,500000));
  T('any 2y gap → never auto-admitted', v.decision === 'REJECT' && /manual review/.test(v.reason));
})();

/* ── gate: young listing → GREY ── */
(function(){
  var t2 = series(weekSteps(90));
  var v = ugScanBars_(t2, flat(90,100), flat(90,300000));
  T('young listing → GREY', v.decision === 'GREY' && /young listing/.test(v.reason));
})();

/* ── gate: thin on volume AND turnover → GREY; thin volume but high turnover → ADMIT ── */
(function(){
  var t2 = series(weekSteps(400));
  var thin = ugScanBars_(t2, flat(400,50), flat(400,20000));         // 20k sh × ₹50 = ₹10L/day
  T('illiquid → GREY', thin.decision === 'GREY' && /thin liquidity/.test(thin.reason));
  var pricey = ugScanBars_(t2, flat(400,3000), flat(400,20000));     // 20k sh × ₹3000 = ₹6 Cr/day
  T('low volume but ₹6Cr turnover → ADMIT (MRF case)', pricey.decision === 'ADMIT');
})();

/* ── gate: results-day ±22% without gap must not reject ── */
(function(){
  var t2 = series(weekSteps(400)), cl = flat(400,100); cl[150] = 122;
  T('big single-day move w/o gap → ADMIT', ugScanBars_(t2, cl, flat(400,500000)).decision === 'ADMIT');
})();

T('empty bars → REJECT no data', ugScanBars_([], [], []).decision === 'REJECT');

/* ── sector + snippet ── */
T('sector title-cased', ugSector_('FINANCIAL SERVICES') === 'Financial Services');
T('sector And → &', ugSector_('OIL GAS AND CONSUMABLE FUELS') === 'Oil Gas & Consumable Fuels');
T('sector empty → NSE Listed', ugSector_('') === 'NSE Listed');
var sn = ugSnippet_({ sym:'KIRLOSENG', name:'Kirloskar Oil Engines Ltd.', industry:'CAPITAL GOODS' });
T('snippet: steam.html format', sn === "  'KIRLOSENG':{n:'Kirloskar Oil Engines',yf:'KIRLOSENG.NS',s:'Capital Goods'},");
var sn2 = ugSnippet_({ sym:'DOL', name:"D'Ollywood Ltd", industry:'MEDIA' });
T('snippet: apostrophe escaped', sn2.indexOf("D\\'Ollywood") >= 0);

console.log((bad ? '✗ ' + bad + ' of ' : '✓ all ') + n + ' assertions ' + (bad ? 'FAILED' : 'passed'));
process.exit(bad ? 1 : 0);
