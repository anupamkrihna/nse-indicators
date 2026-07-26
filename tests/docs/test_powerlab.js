/* test_powerlab.js — a power calculator that lies is worse than none: it would
   authorise years of waiting on an unanswerable question, or abandonment of a
   real one. The load-bearing test is CALIBRATION — with no effect present, a
   95% test must reject about 5% of the time. */

var PLCFG = { DECILES: 10, SIMS: 3000, Z: 1.96, SEED: 20260726,
  KS: [24,32,44,60,84,120,180,240], DELTAS: [0.0025,0.005,0.0079,0.012,0.02], TARGET: 0.80 };

function plRng_(seed) { var s = (seed || 1) % 4294967296; return function () { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296; }; }
function plMedian_(a) { if (!a.length) return null; var s = a.slice().sort(function (x,y){return x-y;}), n = s.length, m = (n-1)/2; return n%2 ? s[m] : (s[Math.floor(m)]+s[Math.ceil(m)])/2; }
function plMean_(a) { if (!a.length) return null; var s=0; for (var i=0;i<a.length;i++) s+=a[i]; return s/a.length; }
function plSd_(a) { if (a.length<2) return null; var m=plMean_(a), v=0; for (var i=0;i<a.length;i++){var d=a[i]-m; v+=d*d;} return Math.sqrt(v/(a.length-1)); }
function plDateEffects_(byDate, D, shuffle, rng) {
  D = D || PLCFG.DECILES;
  var out = [];
  Object.keys(byDate).forEach(function (d) {
    var g = byDate[d];
    if (g.length < D*3) return;
    var decs = g.map(function (r) { return r.dec; });
    if (shuffle) for (var i=decs.length-1;i>0;i--){ var j=Math.floor(rng()*(i+1)), t=decs[i]; decs[i]=decs[j]; decs[j]=t; }
    var top=[], all=[];
    for (var k=0;k<g.length;k++){ all.push(g[k].fwd); if(decs[k]===D) top.push(g[k].fwd); }
    if (!top.length) return;
    var mt=plMedian_(top), ma=plMedian_(all);
    if (mt==null||ma==null) return;
    out.push(mt-ma);
  });
  return out;
}
function plCenter_(a) { var m = plMean_(a); return a.map(function (v) { return v - m; }); }
function plPowerAt_(xNull, delta, K, sims, z, rng) {
  sims = sims || PLCFG.SIMS; z = z || PLCFG.Z; rng = rng || plRng_(PLCFG.SEED);
  var n = xNull.length;
  if (n < 8 || K < 4) return null;
  var hits = 0;
  for (var s=0;s<sims;s++){
    var sum=0, sq=0;
    for (var i=0;i<K;i++){ var v = xNull[Math.floor(rng()*n)] + delta; sum+=v; sq+=v*v; }
    var mean=sum/K, varr=(sq-K*mean*mean)/(K-1);
    if (varr<=0) continue;
    if (mean - z*Math.sqrt(varr/K) > 0) hits++;
  }
  return hits/sims;
}
function plMonthsFor_(xNull, delta, target, ks, sims, z, seed) {
  for (var i=0;i<ks.length;i++){ var p=plPowerAt_(xNull, delta, ks[i], sims, z, plRng_(seed+i)); if (p!=null && p>=target) return ks[i]; }
  return null;
}

let fails = 0;
function ok(n,c){ console.log((c?'PASS':'FAIL')+' — '+n); if(!c) fails++; }
function mk(s){ var x=s; return function(){ x=(1103515245*x+12345)%2147483648; return x/2147483648; }; }

/* fat-tailed monthly returns, roughly NSE-shaped */
function ret(r){ var u=r(); var base=(u-0.49)*0.20; if(r()<0.05) base*=3.5; return base; }
function makeDates(nDates, perDate, edge, seed){
  var r=mk(seed), byDate={};
  for(var d=0; d<nDates; d++){
    var g=[], shock=(r()-0.5)*0.06;                 /* market-wide move: cross-date correlation */
    for(var i=0;i<perDate;i++){
      var dec=Math.floor(i/(perDate/10))+1;
      g.push({ dec: Math.min(10,dec), fwd: ret(r)+shock+(dec===10?edge:0) });
    }
    byDate['m'+d]=g;
  }
  return byDate;
}

console.log('── CALIBRATION: the null must reject ~5% ──');
(function(){
  var xNull = plDateEffects_(makeDates(120, 300, 0, 11), 10, true, plRng_(1));
  [24,60,120,240].forEach(function(k){
    var fp = plPowerAt_(xNull, 0, k, 4000, 1.96, plRng_(7+k));
    console.log('   K='+k+' false-positive '+(Math.round(fp*1000)/10)+'%');
    ok('K='+k+': false-positive rate under 8%', fp < 0.08);
  });
  ok('null effects centre near zero', Math.abs(plMean_(xNull)) < 0.004);
})();

console.log('\n── shuffling actually destroys a real effect ──');
(function(){
  var by = makeDates(120, 300, 0.02, 22);
  var xObs  = plDateEffects_(by, 10, false, plRng_(3));
  var xNull = plDateEffects_(by, 10, true,  plRng_(3));
  ok('observed effects recover the planted edge', plMean_(xObs) > 0.012);
  ok('shuffled effects lose it', Math.abs(plMean_(xNull)) < 0.004);
  ok('shuffling preserves the return spread', Math.abs(plSd_(xNull) - plSd_(xObs)) / plSd_(xObs) < 0.6);
})();

console.log('\n── power behaves as power must ──');
(function(){
  var xNull = plDateEffects_(makeDates(120, 300, 0, 33), 10, true, plRng_(5));
  var p32 = plPowerAt_(xNull, 0.008, 32, 3000, 1.96, plRng_(9));
  var p120 = plPowerAt_(xNull, 0.008, 120, 3000, 1.96, plRng_(9));
  var p240 = plPowerAt_(xNull, 0.008, 240, 3000, 1.96, plRng_(9));
  console.log('   d=0.8%: K=32 → '+Math.round(p32*100)+'%, K=120 → '+Math.round(p120*100)+'%, K=240 → '+Math.round(p240*100)+'%');
  ok('power rises with more months', p32 < p120 && p120 <= p240);
  var small = plPowerAt_(xNull, 0.002, 60, 3000, 1.96, plRng_(13));
  var big   = plPowerAt_(xNull, 0.020, 60, 3000, 1.96, plRng_(13));
  console.log('   K=60: d=0.2% → '+Math.round(small*100)+'%, d=2.0% → '+Math.round(big*100)+'%');
  ok('power rises with a larger true effect', small < big);
  ok('a large effect is detectable within a decade', big > 0.8);
  ok('a tiny effect is NOT detectable at 60 months', small < 0.6);
  ok('power never exceeds 1', p240 <= 1 && big <= 1);
  ok('negative effect gives near-zero power (sign matters)',
    plPowerAt_(xNull, -0.01, 120, 2000, 1.96, plRng_(17)) < 0.02);
})();

console.log('\n── months-to-target ──');
(function(){
  var xNull = plDateEffects_(makeDates(120, 300, 0, 44), 10, true, plRng_(6));
  var nBig = plMonthsFor_(xNull, 0.02, 0.80, PLCFG.KS, 2000, 1.96, 101);
  var nSmall = plMonthsFor_(xNull, 0.002, 0.80, PLCFG.KS, 2000, 1.96, 202);
  console.log('   d=2.0% needs '+nBig+'m · d=0.2% needs '+(nSmall===null?'>240m':nSmall+'m'));
  ok('a large effect needs fewer months', nBig !== null && nBig <= 60);
  ok('a tiny effect exceeds the grid (honest "unanswerable")', nSmall === null);
  var nMid = plMonthsFor_(xNull, 0.005, 0.8, PLCFG.KS, 1500, 1.96, 5);
  ok('requirement is monotone in effect size (null = beyond grid = more)',
    nMid === null || nMid >= nBig);
  ok('  and the mid effect is harder than the large one',
    nMid === null || nMid > nBig || nBig === PLCFG.KS[0]);
})();

console.log('\n── guards ──');
ok('too few dates → null', plPowerAt_([0.01,0.02], 0.01, 60, 100, 1.96, plRng_(1)) === null);
ok('K below 4 → null', plPowerAt_([1,2,3,4,5,6,7,8,9,10], 0.01, 2, 100, 1.96, plRng_(1)) === null);
ok('thin cross-sections are skipped', plDateEffects_({ a: [{dec:10,fwd:0.1}] }, 10, false, plRng_(1)).length === 0);
ok('same seed reproduces exactly',
  plPowerAt_([0.01,-0.01,0.02,-0.02,0.03,-0.03,0.01,0.00,0.02,-0.01], 0.01, 30, 500, 1.96, plRng_(42)) ===
  plPowerAt_([0.01,-0.01,0.02,-0.02,0.03,-0.03,0.01,0.00,0.02,-0.01], 0.01, 30, 500, 1.96, plRng_(42)));

console.log('\n── the two bugs found on real data ──');
(function () {
  /* Real data shows observed sd 2.91% vs shuffled 1.41% — the top-decile effect
     genuinely VARIES month to month (some months momentum works, some it does
     not). A constant planted edge cannot reproduce that, so vary it per date. */
  var rv = mk(909), byV = {};
  for (var d = 0; d < 120; d++) {
    var edgeD = 0.008 + (rv() - 0.5) * 0.05;          // effect itself swings by date
    var g = [], shock = (rv() - 0.5) * 0.06;
    for (var i = 0; i < 300; i++) {
      var dec = Math.min(10, Math.floor(i / 30) + 1);
      g.push({ dec: dec, fwd: ret(rv) + shock + (dec === 10 ? edgeD : 0) });
    }
    byV['m' + d] = g;
  }
  var by = byV;
  var xObs = plDateEffects_(by, 10, false, plRng_(2));
  var xNull = plDateEffects_(by, 10, true, plRng_(2));
  ok('BUG 1 reproduced: the shuffled null is NOT exactly zero', Math.abs(plMean_(xNull)) > 1e-9);
  var centred = plCenter_(xNull);
  ok('  centring removes it', Math.abs(plMean_(centred)) < 1e-12);
  /* inject a known +0.15%/month bias — the magnitude seen on real data */
  var biased = plCenter_(xNull).map(function (v) { return v + 0.0015; });
  var fpRaw = plPowerAt_(biased, 0, 240, 3000, 1.96, plRng_(3));
  var fpFix = plPowerAt_(plCenter_(xNull), 0, 240, 3000, 1.96, plRng_(3));
  console.log('   K=240 false-positive: uncentred ' + Math.round(fpRaw * 100) + '% vs centred ' + Math.round(fpFix * 100) + '%');
  ok('  an uncentred null inflates false positives at large K', fpRaw > fpFix);
  ok('  the centred null stays calibrated at K=240', fpFix < 0.08);

  console.log('   sd: shuffled ' + (Math.round(plSd_(xNull) * 10000) / 100) + '% vs observed ' +
    (Math.round(plSd_(xObs) * 10000) / 100) + '%');
  ok('BUG 2 reproduced: shuffled spread is narrower when the effect varies',
    plSd_(xNull) < plSd_(xObs));
  var pNarrow = plPowerAt_(plCenter_(xNull), 0.005, 60, 2000, 1.96, plRng_(4));
  var pReal = plPowerAt_(plCenter_(xObs), 0.005, 60, 2000, 1.96, plRng_(4));
  console.log('   d=0.5%, K=60 power: shuffled spread ' + Math.round(pNarrow * 100) + '% vs observed spread ' + Math.round(pReal * 100) + '%');
  ok('  using the shuffled spread overstates power', pNarrow >= pReal);
})();

console.log(fails ? ('\n'+fails+' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
