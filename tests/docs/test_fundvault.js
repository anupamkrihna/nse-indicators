/* test_fundvault.js — FundVault copies the Buffett scorecard CACHE into an
   append-only history. The one thing that must never fail is column alignment:
   a positional copy would silently corrupt every past row the first time
   someone inserted a column into the scorecard, and the damage would stay
   invisible until analysis, years later. */

var FVCFG = {
  SHEET: 'FundSnap',
  SIGNATURE: ['Score','Moat','Value','Consistency','Ownership','Safety','PE','SectorPE','ROE','ROCE','Promoter','FII','FetchedAt'],
  MIN_SIG: 6,
  SYM_KEYS: ['sym','symbol','ticker','nse','code']
};
function fvToday_(nowMs) {
  var d = new Date((nowMs == null ? Date.now() : nowMs) + 19800000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function fvHeaderScore_(header, signature) {
  var have = {}, n = 0;
  (header || []).forEach(function (h) { have[String(h).trim().toLowerCase()] = 1; });
  (signature || []).forEach(function (k) { if (have[String(k).toLowerCase()]) n++; });
  return n;
}
function fvSymCol_(header, keys) {
  for (var i = 0; i < (header || []).length; i++) {
    var h = String(header[i]).trim().toLowerCase();
    for (var k = 0; k < keys.length; k++) if (h === keys[k]) return i;
  }
  for (var j = 0; j < (header || []).length; j++) {
    var h2 = String(header[j]).trim().toLowerCase();
    for (var m = 0; m < keys.length; m++) if (h2.indexOf(keys[m]) >= 0) return j;
  }
  return -1;
}
function fvAlign_(srcHeader, storedHeader, row) {
  var pos = {};
  (srcHeader || []).forEach(function (h, i) { pos[String(h).trim().toLowerCase()] = i; });
  var out = [], missing = [];
  for (var i = 0; i < storedHeader.length; i++) {
    var key = String(storedHeader[i]).trim().toLowerCase();
    if (key === 'asof') { out.push(null); continue; }
    var p = pos[key];
    if (p === undefined) { out.push(''); missing.push(storedHeader[i]); continue; }
    var v = row[p];
    out.push(v === undefined || v === null ? '' : v);
  }
  var added = [];
  (srcHeader || []).forEach(function (h) {
    var k = String(h).trim().toLowerCase();
    for (var i = 0; i < storedHeader.length; i++) if (String(storedHeader[i]).trim().toLowerCase() === k) return;
    added.push(h);
  });
  return { row: out, missing: missing, added: added };
}

let fails = 0;
function ok(n, c) { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) fails++; }

/* the real scorecard shape, from steam.html drawBuffett_ */
var SRC = ['Symbol','Score','Moat','Value','Consistency','Ownership','Safety','DataPct','FetchedAt',
  'PE','SectorPE','GrahamNum','GrahamMarginPct','ROE','ROCE','RevCAGR','ProfCAGR',
  'DE_Ratio','QuickRatio','OCFtoProfit','Promoter','PromoterQoQ','FII','FIIQoQ'];
var STORED = ['asOf'].concat(SRC);
function srcRow(sym) { return [sym,72,15,12,14,16,15,86,'2026-07-25',24.5,26.0,410,-8.2,18.2,21.4,11.1,9.4,0.42,1.8,0.91,54.2,0.3,18.1,-0.4]; }

console.log('── source detection ──');
ok('the real scorecard header scores high', fvHeaderScore_(SRC, FVCFG.SIGNATURE) >= FVCFG.MIN_SIG);
ok('an unrelated sheet does not', fvHeaderScore_(['date','open','high','low','close'], FVCFG.SIGNATURE) < FVCFG.MIN_SIG);
ok('detection is case-insensitive', fvHeaderScore_(SRC.map(function(h){return h.toUpperCase();}), FVCFG.SIGNATURE) >= FVCFG.MIN_SIG);
ok('tolerates stray whitespace', fvHeaderScore_(SRC.map(function(h){return ' '+h+' ';}), FVCFG.SIGNATURE) >= FVCFG.MIN_SIG);
ok('a partial header still clears the floor', fvHeaderScore_(['Symbol','Score','Moat','PE','ROE','ROCE','FetchedAt'], FVCFG.SIGNATURE) >= FVCFG.MIN_SIG);
ok('empty header scores zero', fvHeaderScore_([], FVCFG.SIGNATURE) === 0);

console.log('\n── symbol column ──');
ok('finds "Symbol"', fvSymCol_(SRC, FVCFG.SYM_KEYS) === 0);
ok('finds "sym"', fvSymCol_(['sym','Score'], FVCFG.SYM_KEYS) === 0);
ok('finds a non-first symbol column', fvSymCol_(['Score','Ticker','PE'], FVCFG.SYM_KEYS) === 1);
ok('falls back to a partial match', fvSymCol_(['Score','NSE Code','PE'], FVCFG.SYM_KEYS) === 1);
ok('returns -1 when absent', fvSymCol_(['Score','PE','ROE'], FVCFG.SYM_KEYS) === -1);

console.log('\n── ALIGNMENT: the corruption guard ──');
(function () {
  var a = fvAlign_(SRC, STORED, srcRow('RELIANCE'));
  ok('width matches the stored schema', a.row.length === STORED.length);
  ok('asOf slot left for the caller', a.row[0] === null);
  ok('symbol lands in its column', a.row[1] === 'RELIANCE');
  ok('values land under the right names', a.row[STORED.indexOf('ROE')] === 18.2 && a.row[STORED.indexOf('ROCE')] === 21.4);
  ok('no drift reported on an unchanged schema', a.missing.length === 0 && a.added.length === 0);

  /* THE SCENARIO THIS EXISTS FOR: a column inserted mid-table upstream */
  var moved = ['Symbol','NEWCOL','Score','Moat','Value','Consistency','Ownership','Safety','DataPct','FetchedAt',
    'PE','SectorPE','GrahamNum','GrahamMarginPct','ROE','ROCE','RevCAGR','ProfCAGR',
    'DE_Ratio','QuickRatio','OCFtoProfit','Promoter','PromoterQoQ','FII','FIIQoQ'];
  var mrow = ['RELIANCE','xx',72,15,12,14,16,15,86,'2026-07-25',24.5,26.0,410,-8.2,18.2,21.4,11.1,9.4,0.42,1.8,0.91,54.2,0.3,18.1,-0.4];
  var b = fvAlign_(moved, STORED, mrow);
  ok('inserted column does NOT shift the data', b.row[STORED.indexOf('ROE')] === 18.2);
  ok('  ROCE also still correct', b.row[STORED.indexOf('ROCE')] === 21.4);
  ok('  Promoter still correct', b.row[STORED.indexOf('Promoter')] === 54.2);
  ok('the new column is REPORTED, not silently dropped', b.added.indexOf('NEWCOL') >= 0);
  ok('a positional copy WOULD have corrupted it (control)', mrow[STORED.indexOf('ROE') - 1] !== 18.2);

  /* reordering */
  var rev = SRC.slice().reverse();
  var revRow = srcRow('TCS').slice().reverse();
  var c = fvAlign_(rev, STORED, revRow);
  ok('fully reversed source still aligns', c.row[1] === 'TCS' && c.row[STORED.indexOf('ROE')] === 18.2);

  /* removal */
  var less = SRC.filter(function (h) { return h !== 'QuickRatio'; });
  var lessRow = srcRow('INFY').filter(function (_, i) { return SRC[i] !== 'QuickRatio'; });
  var d = fvAlign_(less, STORED, lessRow);
  ok('removed column comes back blank, not shifted', d.row[STORED.indexOf('QuickRatio')] === '');
  ok('  and neighbours are unaffected', d.row[STORED.indexOf('OCFtoProfit')] === 0.91);
  ok('  removal is reported', d.missing.indexOf('QuickRatio') >= 0);
})();

console.log('\n── null / blank handling ──');
(function () {
  var r = srcRow('X'); r[13] = null; r[14] = undefined; r[9] = 0;
  var a = fvAlign_(SRC, STORED, r);
  ok('null becomes empty string', a.row[STORED.indexOf('ROE')] === '');
  ok('undefined becomes empty string', a.row[STORED.indexOf('ROCE')] === '');
  ok('a genuine ZERO survives as 0', a.row[STORED.indexOf('PE')] === 0);
  ok('  (0 and blank are not conflated)', a.row[STORED.indexOf('PE')] !== a.row[STORED.indexOf('ROE')]);
  ok('negative values pass through', fvAlign_(SRC, STORED, srcRow('Y')).row[STORED.indexOf('GrahamMarginPct')] === -8.2);
  ok('text columns pass through', fvAlign_(SRC, STORED, srcRow('Y')).row[STORED.indexOf('FetchedAt')] === '2026-07-25');
})();

console.log('\n── asOf is IST ──');
ok('19:00 UTC is already tomorrow in IST', fvToday_(Date.UTC(2026, 6, 26, 19, 0)) === '2026-07-27');
ok('18:00 UTC is the same IST day', fvToday_(Date.UTC(2026, 6, 26, 18, 0)) === '2026-07-26');
ok('month rolls correctly', fvToday_(Date.UTC(2026, 6, 31, 19, 0)) === '2026-08-01');
ok('zero-padded', /^\d{4}-\d{2}-\d{2}$/.test(fvToday_(Date.UTC(2026, 0, 5, 6, 0))));
ok('sorts chronologically as a string',
  ['2026-01-05','2025-12-28','2026-02-01'].sort()[0] === '2025-12-28');

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
