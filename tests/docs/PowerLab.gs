/**
 * ═══════════════════════════════════════════════════════════════════
 * POWERLAB.gs — how long until an experiment can answer? (v1.0, 26-Jul-2026)
 * ADDITIVE. New file in the INDICATORS project. No network calls.
 *
 * THE QUESTION
 *   D-006 closed with both TierLab factors "underpowered, not negative" and an
 *   estimate of ~12 more months — derived from a single 1/sqrt(K) scaling on
 *   the observed point estimate. That estimate is fragile: if the true effect
 *   is half what we measured, the same arithmetic gives ELEVEN YEARS. Before
 *   committing years to any of these experiments, it is worth knowing which
 *   are answerable at all.
 *
 * WHAT THIS IS NOT
 *   Not a predictor. Monte Carlo propagates assumptions; it cannot create
 *   information. Simulating price paths to get "P(bull run)" would return the
 *   drift you fed in, wearing a probability's clothing — precisely the false
 *   confidence D-005 and D-006 exist to prevent.
 *
 *   Used HERE, simulation answers a question that has nothing to do with
 *   prediction: given the return distribution we actually observe, how many
 *   months of data are needed before an effect of size d becomes
 *   distinguishable from zero? That is a POWER calculation, and it is exactly
 *   what the Monte Carlo machinery is good for.
 *
 * METHOD — empirical, not parametric
 *   1. Read TierLab's real monthly cross-sections.
 *   2. Per date, compute the statistic of interest:
 *          x_d = median(top decile at d) − median(all names at d)
 *   3. Build the NULL by shuffling decile labels WITHIN each date. That
 *      destroys any real relationship while preserving the actual return
 *      distribution — fat tails, skew, and the fact that everything moves
 *      together on a bad month. A parametric normal would understate all of it.
 *   4. Power at effect d over K months = the share of resamples of size K
 *      drawn from (null + d) whose 95% interval clears zero.
 *
 *   Resampling whole DATES preserves cross-sectional correlation, the same
 *   reason TierLab and BullBackfill cluster their bootstraps by date.
 *
 * READ THE OUTPUT AS
 *   "at effect d, N months gives an X% chance of detecting it IF IT IS REAL."
 *   Low power does not mean no effect — it means the experiment cannot speak.
 *   That distinction is the whole point.
 *
 * OPS (Run dropdown)
 *   powerCurve()        — power table for pct52w, plus months needed for 80%
 *   powerCurveVolMom()  — same for volMom
 *   powerSanity()       — verifies the null rejects at ~5% (the method's own check)
 * ═══════════════════════════════════════════════════════════════════
 */

var PLCFG = {
  DECILES: 10,
  SIMS:    3000,          // resamples per (effect, K) cell
  Z:       1.96,          // two-sided 95%
  SEED:    20260726,
  KS:      [24, 32, 44, 60, 84, 120, 180, 240],          // months of data
  DELTAS:  [0.0025, 0.005, 0.0079, 0.012, 0.02],         // monthly median edge
  TARGET:  0.80
};

/* ══════════════ PURE (Node-tested in test_powerlab.js) ══════════════ */

function plRng_(seed) { var s = (seed || 1) % 4294967296; return function () { s = (1664525 * s + 1013904223) % 4294967296; return s / 4294967296; }; }
function plMedian_(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length, m = (n - 1) / 2;
  return n % 2 ? s[m] : (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}
function plMean_(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
function plSd_(a) {
  if (a.length < 2) return null;
  var m = plMean_(a), v = 0;
  for (var i = 0; i < a.length; i++) { var d = a[i] - m; v += d * d; }
  return Math.sqrt(v / (a.length - 1));
}

/* Per-date effect: median(top decile) − median(all).
   shuffle=true randomises decile labels within each date, which is the null:
   the same returns, the same correlation structure, no relationship. */
function plDateEffects_(byDate, D, shuffle, rng) {
  D = D || PLCFG.DECILES;
  var out = [];
  Object.keys(byDate).forEach(function (d) {
    var g = byDate[d];
    if (g.length < D * 3) return;
    var decs = g.map(function (r) { return r.dec; });
    if (shuffle) {
      for (var i = decs.length - 1; i > 0; i--) {          // Fisher-Yates
        var j = Math.floor(rng() * (i + 1)), t = decs[i]; decs[i] = decs[j]; decs[j] = t;
      }
    }
    var top = [], all = [];
    for (var k = 0; k < g.length; k++) { all.push(g[k].fwd); if (decs[k] === D) top.push(g[k].fwd); }
    if (!top.length) return;
    var mt = plMedian_(top), ma = plMedian_(all);
    if (mt == null || ma == null) return;
    out.push(mt - ma);
  });
  return out;
}

/* Centre a distribution on its own mean. The shuffled null does NOT sit at
   zero: comparing an ~80-name decile median against a 799-name median is a
   biased comparison on skewed returns (the small-sample median carries an
   O(1/n) bias). Left uncorrected the test detects that offset rather than any
   effect, and the false-positive rate CLIMBS with K — observed at 12.4% for
   K=120 before this fix. The null hypothesis is "no more than chance", not
   "exactly zero", and the shuffle is what estimates chance. */
function plCenter_(a) {
  var m = plMean_(a);
  return a.map(function (v) { return v - m; });
}

/* Power: share of K-month resamples from (base + delta) whose 95% CI clears zero.
   One-sample test on the date-level effects — the estimator is their mean, and
   SE = sd/sqrt(K). Resampling from the EMPIRICAL null keeps the real skew. */
/* `base` must be the CENTRED OBSERVED month-to-month effects, not the shuffled
   null: future months will vary like real months. The shuffle destroys genuine
   cross-date variation in the effect, so its spread is far too narrow (1.41%
   vs 2.91% on real data) and using it would overstate power roughly fourfold. */
function plPowerAt_(base, delta, K, sims, z, rng) {
  sims = sims || PLCFG.SIMS; z = z || PLCFG.Z; rng = rng || plRng_(PLCFG.SEED);
  var xNull = base, n = base.length;
  if (n < 8 || K < 4) return null;
  var hits = 0, samp = new Array(K);
  for (var s = 0; s < sims; s++) {
    var sum = 0, sq = 0;
    for (var i = 0; i < K; i++) {
      var v = xNull[Math.floor(rng() * n)] + delta;
      samp[i] = v; sum += v; sq += v * v;
    }
    var mean = sum / K;
    var varr = (sq - K * mean * mean) / (K - 1);
    if (varr <= 0) continue;
    var se = Math.sqrt(varr / K);
    if (mean - z * se > 0) hits++;                          // CI clears zero, correct sign
  }
  return hits / sims;
}

/* Smallest K in the grid reaching the target power; null if the grid tops out. */
function plMonthsFor_(xNull, delta, target, ks, sims, z, seed) {
  for (var i = 0; i < ks.length; i++) {
    var p = plPowerAt_(xNull, delta, ks[i], sims, z, plRng_(seed + i));
    if (p != null && p >= target) return ks[i];
  }
  return null;
}

/* ══════════════ GAS ══════════════ */

/* group TierLab rows into date → [{dec, fwd}] for a given factor */
function plLoad_(factor, horizonKey) {
  factor = factor || 'pct52w'; horizonKey = horizonKey || 'fwd1m';
  if (typeof tlLoad_ !== 'function') { Logger.log('PowerLab needs TierLab.gs in this project'); return null; }
  var L = tlLoad_();
  if (!L) { Logger.log('no TierLab data — run runTierHarvest()'); return null; }
  var ranked = tlRank_(L.rows, factor);                     // whole sample; this is not a hypothesis test
  var byDate = {};
  ranked.forEach(function (r) {
    if (r[horizonKey] == null) return;
    (byDate[r.date] = byDate[r.date] || []).push({ dec: r.dec, fwd: r[horizonKey] });
  });
  return byDate;
}

function plReport_(factor) {
  var byDate = plLoad_(factor);
  if (!byDate) return;
  var rng = plRng_(PLCFG.SEED);
  var xObs = plDateEffects_(byDate, PLCFG.DECILES, false, rng);
  var xNull = plDateEffects_(byDate, PLCFG.DECILES, true, rng);
  if (xNull.length < 8) { Logger.log('too few usable dates'); return; }

  function pc(v) { return v == null ? '—' : (Math.round(v * 10000) / 100) + '%'; }
  var bias = plMean_(xNull);                 // estimator bias, from the shuffle
  var netEdge = plMean_(xObs) - bias;        // observed edge net of that bias
  var base = plCenter_(xObs);                // real month-to-month variability, centred
  Logger.log('── POWER · ' + factor + ' ──');
  Logger.log('dates ' + xObs.length + ' · raw mean edge ' + pc(plMean_(xObs)) +
    ' · month-to-month sd ' + pc(plSd_(xObs)));
  Logger.log('estimator bias from the shuffle: ' + pc(bias) + '  →  NET observed edge ' + pc(netEdge));
  Logger.log('shuffled sd ' + pc(plSd_(xNull)) + ' vs observed sd ' + pc(plSd_(xObs)) +
    ' — power below uses the OBSERVED spread, since future months vary like real ones');
  Logger.log('');
  var head = 'true edge |';
  PLCFG.KS.forEach(function (k) { head += ('    ' + k + 'm').slice(-6); });
  Logger.log(head + '  |  months for ' + Math.round(PLCFG.TARGET * 100) + '%');
  PLCFG.DELTAS.forEach(function (d, di) {
    var line = ('     ' + pc(d)).slice(-9) + ' |';
    PLCFG.KS.forEach(function (k, ki) {
      var p = plPowerAt_(base, d, k, PLCFG.SIMS, PLCFG.Z, plRng_(PLCFG.SEED + di * 100 + ki));
      line += ('    ' + Math.round(p * 100) + '%').slice(-6);
    });
    var need = plMonthsFor_(base, d, PLCFG.TARGET, PLCFG.KS, PLCFG.SIMS, PLCFG.Z, PLCFG.SEED + di * 7);
    line += '  |  ' + (need == null ? '>' + PLCFG.KS[PLCFG.KS.length - 1] + ' (' +
      Math.round(PLCFG.KS[PLCFG.KS.length - 1] / 12) + '+ yrs)' : need + ' (' + (Math.round(need / 12 * 10) / 10) + ' yrs)');
    Logger.log(line);
  });
  Logger.log('');
  Logger.log('Read as: at a TRUE edge of d, K months give this chance of detecting it.');
  Logger.log('Low power is not evidence of no effect — it means the experiment cannot speak.');
  Logger.log('The observed edge is itself uncertain, so read the ROW RANGE, not one cell.');
}

function powerCurve()       { plReport_('pct52w'); }
function powerCurveVolMom() { plReport_('volMom'); }

/* The method checking itself: with no real effect, a 95% test must reject
   about 5% of the time. Materially more means the machinery is broken and
   every power number above it is worthless. */
function powerSanity() {
  var byDate = plLoad_('pct52w');
  if (!byDate) return;
  var rng = plRng_(PLCFG.SEED);
  var xObs = plDateEffects_(byDate, PLCFG.DECILES, false, rng);
  var base = plCenter_(xObs);                // exactly what the power table resamples
  Logger.log('── SANITY ──');
  [32, 60, 120, 240].forEach(function (k) {
    var fp = plPowerAt_(base, 0, k, PLCFG.SIMS, PLCFG.Z, plRng_(PLCFG.SEED + k));
    Logger.log('K=' + k + ' · false-positive rate ' + (Math.round(fp * 1000) / 10) +
      '% ' + (fp < 0.085 ? 'OK' : '⚠ TOO HIGH — power numbers unreliable'));
  });
  Logger.log('(one-sided at 95%, so ~2.5-5% is expected)');
}
