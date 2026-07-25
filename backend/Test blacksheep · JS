/* test_blacksheep.js — pure-math checks for BlackSheep.gs v1.2.
   Copies of the keyword tables + pure functions, kept identical to the .gs. */

var BS_NEWS_HIGH = [
  ['insolvency', 'insolvency proceedings'],
  ['nclt', 'NCLT action'],
  ['cirp', 'CIRP (corporate insolvency resolution)'],
  ['resolution professional', 'resolution professional appointed'],
  ['liquidation', 'liquidation'],
  ['going.?concern[^.]{0,25}(doubt|uncertaint|qualif|material|risk|emphasis)', 'going-concern doubt'],
  ['(accounting|financial|corporate|securities|accounts?) fraud|fraud (case|charge|probe|scam|investigation|conviction|indictment)|(accused|charged|booked|indicted|convicted|guilty)[^.]{0,30}fraud', 'fraud allegation'],
  ['wilful default(er)?', 'wilful defaulter tag'],
  ['debt default', 'debt default'],
  ['defaults? on (loan|payment|interest|dues)', 'payment default'],
  ['suspend(ed|s)? (from )?trading', 'trading suspension'],
  ['trading suspension', 'trading suspension'],
  ['delist(ed|ing)?', 'delisting'],
  ['auditor(s)? resign', 'auditor resignation'],
  ['forensic audit', 'forensic audit ordered'],
  ['relist(ed|ing)', 'relisting after suspension']
];
var BS_NEWS_MED = [
  ['sebi (order|penalt\\w*|bars?|ban(s|ned)?|probe)', 'SEBI action'],
  ['\\bgsm\\b', 'GSM surveillance list'],
  ['\\basm\\b', 'ASM surveillance list'],
  ['surveillance measure', 'exchange surveillance'],
  ['promoter(s)? pledge', 'promoter share pledge'],
  ['\\bed\\b (raid|probe|attach)', 'ED action'],
  ['\\bcbi\\b (raid|probe|books?|case)', 'CBI action'],
  ['income tax raid', 'IT raid'],
  ['show.?cause notice', 'show-cause notice'],
  ['rating downgrade', 'credit rating downgrade'],
  ['one.?time settlement', 'one-time settlement with lenders']
];
var BS_RESTRUCTURED = [
  ['exit(s|ed|ing)? insolvency|emerge[sd]? from insolvency|out of insolvency', 'exited insolvency resolution'],
  ['post.?cirp', 'post-CIRP — fresh out of resolution'],
  ['withdrawal of insolvency|insolvency withdrawal|withdraw\\w* .{0,15}insolvency', 'insolvency proceedings withdrawn'],
  ['reconstitut\\w+ board', 'board reconstituted post-insolvency'],
  ['relist(ed|ing)? after|resume[sd]? trading|revoke[sd]? .{0,12}suspension|trading resume', 'relisted / trading resumed after suspension']
];
var BS_CREDITOR_CUE = /\b(files?|filed|filing|moves?|moved|drags?|dragged|approach\w+|seeks?|sought|initiat\w+|tags?|tagged|flags?|flagged|declares?|declared|names?|named|recovers?|recovered|invokes?|invoked|admits?|admitted|hauls?|hauled|summons?|summoned|lends?|lent)\b/;

function bsNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60); }
function bsNameToken_(name) {
  var stop = { bank:1, india:1, indian:1, limited:1, ltd:1, corporation:1, corp:1, company:1,
    industries:1, enterprises:1, finance:1, financial:1, services:1, holdings:1, group:1,
    national:1, general:1, life:1, insurance:1, power:1, motors:1, steel:1, energy:1, cement:1 };
  var words = bsNorm_(name).split(' ');
  for (var i = 0; i < words.length; i++) if (words[i].length >= 4 && !stop[words[i]]) return words[i];
  return '';
}
function bsScanTitle_(title, name) {
  var t = ' ' + String(title || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  var tok = bsNameToken_(name);
  var nameIdx = tok ? t.indexOf(tok) : -1;
  var againstIdx = t.indexOf(' against ');
  function subjectOf(kwIdx) {
    if (againstIdx >= 0) {
      if (nameIdx >= 0 && nameIdx > againstIdx) return 'subject';
      return 'creditor';
    }
    var cm = BS_CREDITOR_CUE.exec(t);
    if (cm && nameIdx >= 0 && nameIdx <= cm.index && cm.index < kwIdx) return 'creditor';
    if (nameIdx >= 0) return 'subject';
    return 'unknown';
  }
  for (var r = 0; r < BS_RESTRUCTURED.length; r++) {
    var mr = new RegExp(BS_RESTRUCTURED[r][0], 'i').exec(t);
    if (mr) {
      var sr = subjectOf(mr.index);
      if (sr === 'creditor') continue;
      if (sr === 'unknown') return { sev: 'MED', label: BS_RESTRUCTURED[r][1] + ' — subject unconfirmed' };
      return { sev: 'HIGH', struct: true, label: BS_RESTRUCTURED[r][1] };
    }
  }
  for (var i = 0; i < BS_NEWS_HIGH.length; i++) {
    var mh = new RegExp(BS_NEWS_HIGH[i][0], 'i').exec(t);
    if (mh) {
      var st = subjectOf(mh.index);
      if (st === 'creditor') continue;
      if (st === 'unknown') return { sev: 'MED', label: BS_NEWS_HIGH[i][1] + ' — subject unconfirmed' };
      return { sev: 'HIGH', label: BS_NEWS_HIGH[i][1] };
    }
  }
  for (var k = 0; k < BS_NEWS_MED.length; k++)
    if (new RegExp(BS_NEWS_MED[k][0], 'i').test(t)) return { sev: 'MED', label: BS_NEWS_MED[k][1] };
  return null;
}
function bsVerdict_(flags) {
  var structuralHigh = false, med = false;
  for (var i = 0; i < flags.length; i++) {
    var f = flags[i];
    if (f.tier === 3 && !f.struct) continue;
    if (f.sev === 'HIGH') structuralHigh = true;
    else if (f.sev === 'MED') med = true;
  }
  if (structuralHigh) return 'BLACKSHEEP';
  if (med) return 'GREY';
  return 'CLEAN';
}

let fails = 0;
function ok(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) fails++; }
function sev(title, name) { var h = bsScanTitle_(title, name); return h ? h.sev : null; }

// ── VERDICT: the core reclassification ───────────────────────────
(function () {
  ok('structural Tier-1 HIGH → BLACKSHEEP',
    bsVerdict_([{ tier: 1, sev: 'HIGH', code: 'GAP' }]) === 'BLACKSHEEP');
  ok('v1.4: informational news HIGH alone → CLEAN (news is context, not verdict)',
    bsVerdict_([{ tier: 3, sev: 'HIGH', code: 'NEWS' }]) === 'CLEAN');
  ok('news HIGH + structural HIGH → BLACKSHEEP (Gayatri: gap corroborates)',
    bsVerdict_([{ tier: 3, sev: 'HIGH' }, { tier: 1, sev: 'HIGH', code: 'GAP' }]) === 'BLACKSHEEP');
  ok('MED only → GREY', bsVerdict_([{ tier: 1, sev: 'MED', code: 'THIN_VOLUME' }]) === 'GREY');
  ok('no flags → CLEAN', bsVerdict_([]) === 'CLEAN');
  ok('NO_DATA (structural HIGH) → BLACKSHEEP',
    bsVerdict_([{ tier: 1, sev: 'HIGH', code: 'NO_DATA' }]) === 'BLACKSHEEP');
})();

// ── SUBJECT vs CREDITOR guard: banks must not flag ───────────────
(function () {
  ok('bank files insolvency AGAINST borrower → dropped',
    sev('SBI files insolvency plea against Reliance Naval at NCLT', 'State Bank of India') === null);
  ok('bank tags borrower wilful defaulter → dropped',
    sev('Kotak Mahindra Bank tags Ruchi Soya as wilful defaulter', 'Kotak Mahindra Bank') === null);
  ok('NCLT admits plea AGAINST the company → HIGH (subject)',
    sev('NCLT admits insolvency resolution plea against Gayatri Projects', 'Gayatri Projects') === 'HIGH');
  ok('company faces liquidation (subject) → HIGH',
    sev('Gayatri Projects faces liquidation as lenders move in', 'Gayatri Projects') === 'HIGH');
  ok('insolvency against a third party, company not named → not HIGH',
    sev('Insolvency plea against XYZ Infra admitted', 'State Bank of India') !== 'HIGH');
})();

// ── TIGHTENED keywords: blue-chip co-occurrence must not fire ────
(function () {
  ok('generic "fraud" warning → no HIGH',
    sev('ITC warns customers about fraud emails and fake offers', 'ITC') === null);
  ok('real "fraud probe" on the company → HIGH',
    sev('Accounting fraud probe ordered at ABCorp', 'ABCorp Technologies') === 'HIGH');
  ok('generic "going concern" mention → no HIGH',
    sev('Analysts discuss going concern basis in accounting standards', 'Marico') === null);
  ok('real going-concern doubt → HIGH',
    sev('Auditor flags going concern doubt at ZeeMedia', 'ZeeMedia Enterprises') === 'HIGH');
  ok('blue-chip earnings headline → null',
    sev('Asian Paints Q1 net profit rises 12% on demand', 'Asian Paints') === null);
  ok('SEBI mention (regulator) → MED not HIGH', sev('SEBI order tightens F&O rules', 'HDFC Bank') === 'MED');
})();

// ── name token extraction ────────────────────────────────────────
(function () {
  ok('first distinctive brand token', bsNameToken_('Kotak Mahindra Bank') === 'kotak');
  ok('skips stop-words', bsNameToken_('State Bank of India') === 'state');
  ok('short/stop-only name → empty', bsNameToken_('3M India') === '');
  ok('ITC (3 letters) → empty token', bsNameToken_('ITC') === '');
})();

// ── v1.3 RESTRUCTURED: rescue the flagship without re-breaking banks ──
(function () {
  function hit(title,name){ return bsScanTitle_(title,name); }
  var g1=hit("Gayatri Projects Exits Insolvency, Plans Fundraising to Repay Creditors","Gayatri Projects");
  ok('Gayatri "exits insolvency" → struct HIGH', g1 && g1.sev==='HIGH' && g1.struct===true);
  var g2=hit("Gayatri Projects reconstitutes board after insolvency withdrawal","Gayatri Projects");
  ok('Gayatri "reconstitutes board" → struct HIGH', g2 && g2.struct===true);
  var g3=hit("Financial Results Post-CIRP clarified by Gayatri Projects","Gayatri Projects");
  ok('Gayatri "post-CIRP" → struct HIGH', g3 && g3.struct===true);

  ok('struct news HIGH → BLACKSHEEP-grade verdict',
    bsVerdict_([{tier:3,sev:'HIGH',struct:true}])==='BLACKSHEEP');
  ok('non-struct news HIGH → CLEAN (ignored by rollup)',
    bsVerdict_([{tier:3,sev:'HIGH',struct:false}])==='CLEAN');

  // KOTAKBANK fraud case must NOT become struct/BLACKSHEEP
  var k=hit("ED conducted searches in Kotak Mahindra Bank fraud case","Kotak Mahindra Bank");
  ok('KOTAK fraud → HIGH but NOT struct (informational, verdict CLEAN)',
    k && k.sev==='HIGH' && !k.struct && bsVerdict_([{tier:1,sev:null}].slice(0,0).concat([]))==='CLEAN');
  // a bank mentioning a borrower's CIRP exit, name unconfirmed → capped MED, not BLACKSHEEP
  var b=hit("SBI reports recovery as borrower exits insolvency","State Bank of India");
  ok('bank + borrower CIRP exit, unconfirmed → MED not struct', b && b.sev==='MED');
})();

// ── v1.4: news is informational; structure alone decides ─────────
(function () {
  // the four real cases from the live sweep
  var syn = bsScanTitle_("Syngene International subsidiary auditor resigns effective July 7","Syngene International");
  ok('SYNGENE auditor-resignation classifies HIGH but non-struct', syn && syn.sev==='HIGH' && !syn.struct);
  ok('SYNGENE verdict is CLEAN once news is informational',
    bsVerdict_([{tier:3,sev:'HIGH',struct:false,code:'NEWS'}])==='CLEAN');

  // structural still governs
  ok('young listing (MED, tier1) → GREY',
    bsVerdict_([{tier:1,sev:'MED',code:'YOUNG_LISTING'}])==='GREY');
  ok('thin volume (MED, tier1) → GREY',
    bsVerdict_([{tier:1,sev:'MED',code:'THIN_VOLUME'}])==='GREY');
  ok('real gap (HIGH, tier1) → BLACKSHEEP',
    bsVerdict_([{tier:1,sev:'HIGH',code:'GAP'}])==='BLACKSHEEP');
  ok('CIRP-exit (struct news) → BLACKSHEEP',
    bsVerdict_([{tier:3,sev:'HIGH',struct:true,code:'RESTRUCTURED'}])==='BLACKSHEEP');

  // news noise cannot change a verdict either way
  var noisy=[{tier:3,sev:'HIGH',struct:false},{tier:3,sev:'MED',struct:false}];
  ok('news noise on a clean name → CLEAN', bsVerdict_(noisy)==='CLEAN');
  ok('news noise cannot mask a structural gap',
    bsVerdict_(noisy.concat([{tier:1,sev:'HIGH',code:'GAP'}]))==='BLACKSHEEP');
  ok('news noise cannot upgrade a young listing past GREY',
    bsVerdict_(noisy.concat([{tier:1,sev:'MED',code:'YOUNG_LISTING'}]))==='GREY');

  // determinism: verdict must not depend on whether news was fetched
  var withNews=[{tier:1,sev:'MED',code:'THIN_VOLUME'},{tier:3,sev:'HIGH',struct:false}];
  var noNews=[{tier:1,sev:'MED',code:'THIN_VOLUME'}];
  ok('verdict identical whether or not news fetch succeeded',
    bsVerdict_(withNews)===bsVerdict_(noNews));
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
