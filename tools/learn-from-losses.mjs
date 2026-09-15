// v498 — SELF-LEARNING THAT KNOWS WHEN IT HAS FOUND NOTHING.
//
// Mines every resolved signal for a feature that separates winners from losers,
// and runs the only test that makes such a search honest: the same analysis on
// SHUFFLED outcomes. Shuffling destroys any real relationship while preserving
// the shape of the data, so the number of "significant" slices it produces is
// the number this method invents from noise. A finding only counts if the real
// data yields materially more than the shuffle does.
//
// Measured on the current book, that bar matters: 13 slices cleared zero on the
// real outcomes while shuffled labels produced 7.1 on average, ranging as high
// as 14. Thirteen is inside the range chance produces, so none of those thirteen
// can be trusted — and without this control every one of them would have looked
// like a discovery.
//
// Everything is measured PER SIGNAL. v495 established that collapsing
// republications into episodes moves results by up to 0.4R in whichever
// direction the clustering runs, and per-signal is the unit a person can
// actually trade.
//
// The loop is deliberately capable of concluding "no change". That is not a
// failure mode; on a system with no established edge it is the expected result,
// and a learner that cannot return it will eventually fit noise and act on it.
import { readFileSync, writeFileSync } from 'fs';

const MIN_N = 20;
const BOOT = 2500;
const SHUFFLES = 30;
// A finding must beat the chance baseline by this margin before it is even
// reported as a candidate. One standard deviation above the shuffle mean.
const MARGIN_SDS = 1.0;

const book = JSON.parse(readFileSync('data/open-setups.json', 'utf8'));
const res = book
  .filter(x => typeof x.resultR === 'number' && x.firedAt)
  .sort((a, b) => String(a.firedAt).localeCompare(String(b.firedAt)));

const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
function ci(v, n = BOOT) {
  if (v.length < 12) return null;
  const m = [];
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (let j = 0; j < v.length; j++) t += v[Math.floor(Math.random() * v.length)];
    m.push(t / v.length);
  }
  m.sort((a, b) => a - b);
  return [+m[Math.floor(0.025 * n)].toFixed(3), +m[Math.floor(0.975 * n)].toFixed(3)];
}

function featuresOf(x) {
  const f = {};
  f.pair = x.pair;
  f.direction = x.direction;
  f.strategyCount = x.strategies != null ? `${x.strategies} strategies` : null;
  f.regime = typeof x.regime === 'string' ? x.regime : (x.regime && x.regime.label) || null;
  f.htfAlignment = x.htfAlignment || null;
  f.killzone = x.inKillzone ? 'in killzone' : 'outside killzone';
  f.adxBand = x.adx == null ? null : (x.adx < 20 ? 'ADX<20' : x.adx < 30 ? 'ADX 20-30' : 'ADX 30+');
  f.confidenceBand = x.confidence == null ? null
    : (x.confidence < 70 ? 'conf<70' : x.confidence < 85 ? 'conf 70-85' : 'conf 85+');
  const h = +String(x.firedAt).slice(11, 13);
  f.session = Number.isFinite(h) ? `${String(h - h % 4).padStart(2,'0')}-${String(h - h % 4 + 3).padStart(2,'0')} UTC` : null;
  f.independence = x.independentFamilies != null ? `${x.independentFamilies} independent` : null;
  return f;
}

function countSignificant(rows, bootN) {
  const g = {};
  for (const x of rows) {
    for (const [k, v] of Object.entries(featuresOf(x))) {
      if (v == null) continue;
      ((g[k] ||= {})[v] ||= []).push(x.resultR);
    }
    for (const s of (x.namedStrategies || [])) ((g.strategy ||= {})[s] ||= []).push(x.resultR);
  }
  const found = [];
  for (const [feature, vals] of Object.entries(g)) {
    for (const [value, rs] of Object.entries(vals)) {
      if (rs.length < MIN_N) continue;
      const c = ci(rs, bootN);
      if (!c) continue;
      if (c[0] > 0 || c[1] < 0) {
        found.push({ feature, value, n: rs.length, avgR: +mean(rs).toFixed(3), ci: c,
                     direction: c[0] > 0 ? 'positive' : 'negative' });
      }
    }
  }
  return found;
}

const realFindings = countSignificant(res, BOOT);

// The control: identical analysis on outcomes shuffled between signals.
const outcomes = res.map(x => x.resultR);
const chanceCounts = [];
for (let t = 0; t < SHUFFLES; t++) {
  const shuffled = outcomes.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  chanceCounts.push(countSignificant(res.map((x, i) => ({ ...x, resultR: shuffled[i] })), 700).length);
}
const chanceMean = mean(chanceCounts);
const chanceSd = Math.sqrt(mean(chanceCounts.map(c => (c - chanceMean) ** 2)));
const threshold = chanceMean + MARGIN_SDS * chanceSd;
const beatsChance = realFindings.length > threshold;

// Even when the count beats chance, only POSITIVE findings could justify
// trading something, so they are separated out.
const positives = realFindings.filter(f => f.direction === 'positive');

const report = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  measuredOn: 'every signal, not episode averages',
  signalsAnalysed: res.length,
  won: res.filter(x => x.resultR > 0.02).length,
  lost: res.filter(x => x.resultR < -0.02).length,
  slicesClearingZero: realFindings.length,
  chanceBaseline: { mean: +chanceMean.toFixed(1), sd: +chanceSd.toFixed(1),
                    range: [Math.min(...chanceCounts), Math.max(...chanceCounts)],
                    shuffles: SHUFFLES },
  threshold: +threshold.toFixed(1),
  beatsChance,
  findings: realFindings.sort((a, b) => a.avgR - b.avgR),
  positiveFindings: positives,
  // What the losses actually look like, which is worth recording even when no
  // feature separates them.
  lossShape: (() => {
    const lost = res.filter(x => x.resultR < -0.02);
    const full = lost.filter(x => x.resultR <= -0.99).length;
    const partial = lost.length - full;
    const reachedTp1 = lost.filter(x => (x.tpReached || 0) >= 1).length;
    return { total: lost.length, fullStopOuts: full, partial,
             reachedTp1First: reachedTp1,
             note: 'Losses that first reached TP1 then reversed are the ones trade '
                 + 'management can address; full stop-outs without reaching TP1 are not.' };
  })(),
};
report.verdict = !beatsChance
  ? `${realFindings.length} slices cleared zero, but shuffled outcomes produce ${chanceMean.toFixed(1)} `
    + `on average (up to ${Math.max(...chanceCounts)}). That is inside what chance yields, so nothing here `
    + `is a reliable pattern and no rule is changed.`
  : positives.length
    ? `${realFindings.length} slices clear zero against a chance baseline of ${chanceMean.toFixed(1)}, `
      + `including ${positives.length} positive — worth investigating, not yet worth trading.`
    : `${realFindings.length} slices clear zero against a chance baseline of ${chanceMean.toFixed(1)}, `
      + `but every one is NEGATIVE. The system loses broadly rather than in a removable subset.`;

writeFileSync('data/loss-learning.json', JSON.stringify(report, null, 2));

console.log(`analysed ${res.length} signals (${report.won} won, ${report.lost} lost)`);
console.log(`  slices clearing zero : ${realFindings.length}`);
console.log(`  chance baseline      : ${chanceMean.toFixed(1)} +- ${chanceSd.toFixed(1)} (range ${Math.min(...chanceCounts)}-${Math.max(...chanceCounts)})`);
console.log(`  beats chance         : ${beatsChance ? 'YES' : 'no'}`);
console.log(`  positive findings    : ${positives.length}`);
console.log(`  losses: ${report.lossShape.fullStopOuts} full stop-outs, ${report.lossShape.partial} partial, ${report.lossShape.reachedTp1First} reached TP1 first`);
console.log(`\n  ${report.verdict}`);
