/* test_search.js — regression gate for quick search (frontend v1.7).
   Sources qVal_/qMatch_/qMiss_/jumpDive_ verbatim from indicators.html
   so tests cannot drift from deployed code. Node-only — never deploy to GAS. */
var fs = require('fs');
var h = fs.readFileSync('indicators.html', 'utf8');
var m = h.match(/\/\* ══════════════ quick search[\s\S]*?(?=\/\* ══════════════ boot)/);
if (!m) { console.error('✗ quick-search block not found'); process.exit(1); }

/* stubs for the browser environment */
var DOM = {};
function $(id){ return DOM[id]; }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var UNIMAP = {}, UNI = [];
var dived = null, tabClicked = false;
function openDive(sym){ dived = sym; }
var document = { querySelector: function(){ return { click: function(){ tabClicked = true; } }; } };

eval(m[0]);

var n = 0, bad = 0;
function T(name, cond){ n++; if(!cond){ bad++; console.log('  ✗ ' + name); } }

/* fixtures */
UNI = [
  {sym:'HAL', name:'Hindustan Aeronautics', sector:'Defence'},
  {sym:'BEL', name:'Bharat Electronics', sector:'Defence'},
  {sym:'TCS', name:'Tata Consultancy Services', sector:'IT'},
  {sym:'TATAMOTORS', name:'Tata Motors', sector:'Auto'}
];
UNI.forEach(function(u){ UNIMAP[u.sym] = u; });

/* qVal_ */
DOM.x = { value: '  hal ' };
T('qVal_ trims', qVal_('x') === 'hal');
T('qVal_ missing element → empty string', qVal_('nope') === '');

/* qMatch_ */
T('sym substring, case-insensitive', qMatch_({sym:'HAL'}, 'hal') === true);
T('company name match via UNIMAP', qMatch_({sym:'HAL'}, 'aeronautics') === true);
T('sector match', qMatch_({sym:'HAL', sector:'Defence'}, 'defen') === true);
T('no match', qMatch_({sym:'HAL', sector:'Defence'}, 'zomato') === false);
T('sym not in UNIMAP still matches on sym', qMatch_({sym:'XYZLTD'}, 'xyz') === true);
T('partial mid-string sym', qMatch_({sym:'TATAMOTORS'}, 'motor') === true);

/* qMiss_ */
T('no query → plain empty-state row', qMiss_('', 9).indexOf('nothing matching filters') >= 0);
var out = qMiss_('tata', 6);
T('universe hit → chips rendered', out.indexOf('jumpDive_') >= 0);
T('chips include TCS', out.indexOf("jumpDive_('TCS')") >= 0);
T('chips include TATAMOTORS', out.indexOf("jumpDive_('TATAMOTORS')") >= 0);
T('colspan honoured', out.indexOf('colspan="6"') >= 0);
var out2 = qMiss_('GAYAPROJ', 8);
T('non-universe name → honest STOCK_MASTER message', out2.indexOf('may not be in STOCK_MASTER') >= 0);
T('non-universe: no chips', out2.indexOf('jumpDive_') < 0);
var out3 = qMiss_('a"b<c>', 9);
T('query is HTML-escaped in output', out3.indexOf('<c>') < 0);

/* jumpDive_ */
jumpDive_('BEL');
T('jumpDive_ switches to portfolio tab', tabClicked === true);
T('jumpDive_ opens deep dive', dived === 'BEL');

/* chip cap */
for (var i = 0; i < 20; i++) UNI.push({sym:'ZQ'+i, name:'ZQ Corp '+i, sector:'Test'});
var out4 = qMiss_('zq', 9);
T('chips capped at 6', (out4.match(/jumpDive_/g) || []).length === 6);

console.log((bad ? '✗ ' + bad + ' of ' : '✓ all ') + n + ' assertions ' + (bad ? 'FAILED' : 'passed'));
process.exit(bad ? 1 : 0);
