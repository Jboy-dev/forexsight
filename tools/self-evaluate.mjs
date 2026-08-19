// v463 — SELF-EVALUATION THAT CAN SAY "NO".
//
// The app has claimed to learn for a long time, but nothing was ever held to
// a standard. Every previous "learning" pass found a pattern in the data it
// was fitted to, shipped it, and the pattern did not survive contact with new
// data — five times, on this project alone.
//
// The difference between evaluating and guessing is a rule you can fail. This
// runs every cycle over the setups the watcher has resolved against real
// bars, and reports each slice with a bootstrap confidence interval. A finding
// is only ACTIONABLE if:
//
//   • it has at least MIN_N samples, and
//   • its 95% interval clears zero on the winning side, and
//   • it still clears zero on the more recent half of the data
//
// The last condition is the one that matters. Anything can look good over a
// whole sample; surviving a time split is what separates an edge from a
// coincidence. When nothing qualifies, this says so, and the system changes
// nothing. That is a result, not a failure.
import { readFileSync, writeFileSync } from 'fs';
import { toEpisodes } from './lib/episodes.mjs';

const MIN_N = 25;
const BOOT = 6000;

const book = JSON.parse(readFileSync('data/open-setups.json', 'utf8'));
const rawResolved = book
  .filter(x => typeof x.resultR === 'number' && x.firedAt)
  .sort((a, b) => String(a.firedAt).localeCompare(String(b.firedAt)));

// v469 — collapse republished setups into single episodes before measuring
// anything. Without this the same move counts many times and the intervals
// below are far narrower than the evidence justifies. See tools/lib/episodes.mjs.
const resolved = toEpisodes(rawResolved);

const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
function ci(v) {
  if (v.length < 5) return null;
  const m = [];
  for (let i = 0; i < BOOT; i++) {
    let t = 0;
    for (let j = 0; j < v.length; j++) t += v[Math.floor(Math.random() * v.length)];
    m.push(t / v.length);
  }
  m.sort((a, b) => a - b);
  return [m[Math.floor(0.025 * BOOT)], m[Math.floor(0.975 * BOOT)]];
}

// Feature extractors. Add one here and it is evaluated from then on; nothing
// else needs changing.
const FEATURES = {
  strategyCount: x => x.strategies != null ? `${x.strategies} strategies` : null,
  strategy:      x => (x.namedStrategies || []),          // multi-valued
  combo:         x => x.comboKey || null,
  independence:  x => x.independentFamilies == null ? null : `${x.independentFamilies} independent`,
  dominantFamily:x => x.dominantFamily || null,
  pair:          x => x.pair || null,
  direction:     x => x.direction || null,
  session:       x => { const h = +String(x.firedAt).slice(11, 13); return Number.isFinite(h) ? `${String(h - h % 4).padStart(2,'0')}-${String(h - h % 4 + 3).padStart(2,'0')} UTC` : null; },
  regime:        x => x.regime || null,
  htfAlignment:  x => x.htfAlignment || null,
  adxBand:       x => x.adx == null ? null : (x.adx < 20 ? 'ADX <20' : x.adx < 30 ? 'ADX 20-30' : 'ADX 30+'),
  killzone:      x => x.inKillzone === true ? 'in killzone' : 'outside killzone',
};

const half = Math.floor(resolved.length / 2);
const recent = resolved.slice(half);

const report = {};
const actionable = [];

for (const [feature, extract] of Object.entries(FEATURES)) {
  const groups = {}, recentGroups = {};
  const add = (bag, key, r) => { (bag[key] ||= []).push(r); };
  for (const x of resolved) {
    const v = extract(x);
    for (const k of (Array.isArray(v) ? v : [v])) if (k) add(groups, k, x.resultR);
  }
  for (const x of recent) {
    const v = extract(x);
    for (const k of (Array.isArray(v) ? v : [v])) if (k) add(recentGroups, k, x.resultR);
  }

  const rows = [];
  for (const [k, v] of Object.entries(groups)) {
    if (v.length < 5) continue;
    const c = ci(v);
    const rc = recentGroups[k] && recentGroups[k].length >= 5 ? ci(recentGroups[k]) : null;
    const row = {
      value: k, n: v.length,
      avgR: +mean(v).toFixed(3),
      ci: c ? [+c[0].toFixed(3), +c[1].toFixed(3)] : null,
      recentN: recentGroups[k] ? recentGroups[k].length : 0,
      recentAvgR: recentGroups[k] ? +mean(recentGroups[k]).toFixed(3) : null,
      verdict: 'not enough evidence',
    };
    if (c && v.length >= MIN_N) {
      if (c[0] > 0 && rc && rc[0] > 0) { row.verdict = 'ACTIONABLE — positive and holds on recent half'; actionable.push({ feature, ...row }); }
      else if (c[0] > 0)              row.verdict = 'positive overall but does not hold recently';
      else if (c[1] < 0)              row.verdict = 'reliably negative';
      else                            row.verdict = 'indistinguishable from zero';
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.avgR - a.avgR);
  report[feature] = rows;
}

// ── Assumption tests ───────────────────────────────────────────────────────
// The engine is built on beliefs it has never had to defend: that more
// strategies agreeing is better, that higher-timeframe alignment confirms a
// setup, that a strong trend reading is a better place to trade. Each is a
// claim about ordering, so each can be checked. This does not change the
// engine — it reports where a belief and the record disagree, so the
// disagreement is visible rather than assumed away.
function slice(feature, value) {
  const r = (report[feature] || []).find(x => String(x.value) === value);
  return r || null;
}
const assumptions = [];
function testOrdering(name, belief, feature, ordered) {
  const got = ordered.map(v => ({ v, r: slice(feature, v) })).filter(x => x.r);
  if (got.length < 2) return;
  // Belief holds if avgR is non-decreasing along the stated order.
  let holds = true;
  for (let i = 1; i < got.length; i++) if (got[i].r.avgR < got[i - 1].r.avgR - 0.05) holds = false;
  assumptions.push({
    name, belief, holds,
    observed: got.map(x => `${x.v}: ${x.r.avgR >= 0 ? '+' : ''}${x.r.avgR}R (n=${x.r.n})`),
    note: holds
      ? 'The record is consistent with this.'
      : 'The record runs against this. Treat the belief as unsupported, not as fact.',
  });
}

testOrdering(
  'More confirmation is better',
  'A setup with more strategies agreeing should perform better than one with fewer.',
  'strategyCount', ['1 strategies', '2 strategies', '3 strategies', '4 strategies'],
);
// v465 — this one was MY hypothesis, added at the same time as the metric it
// tests. The strategies are near-duplicates of each other (ICHIMOKU never
// fires without VWAP), so the theory was that counting distinct kinds of
// evidence instead of raw indicators would separate good setups from bad.
// It does not. Recorded here rather than removed, because a failed idea that
// stays measured is worth more than one that quietly disappears.
testOrdering(
  'Independent confirmation beats redundant confirmation',
  'A setup confirmed by two different KINDS of evidence should beat one confirmed by several restatements of the same kind.',
  'independence', ['1 independent', '2 independent', '3 independent'],
);
testOrdering(
  'Higher-timeframe alignment confirms',
  'A setup aligned with the 4H trend should perform better than one that is not.',
  'htfAlignment', ['neutral', 'aligned'],
);
testOrdering(
  'Stronger trend is a better trade',
  'A higher ADX reading should mark a better environment to enter.',
  'adxBand', ['ADX <20', 'ADX 20-30', 'ADX 30+'],
);

for (const a of assumptions) {
  console.log(`  assumption "${a.name}": ${a.holds ? 'consistent' : 'CONTRADICTED'}`);
  if (!a.holds) for (const o of a.observed) console.log(`      ${o}`);
}

const all = resolved.map(x => x.resultR);
const overallCi = ci(all);
const out = {
  ts: Date.now(),
  isoTime: new Date().toISOString(),
  samples: resolved.length,
  rawPublications: rawResolved.length,
  inflationFactor: +(rawResolved.length / Math.max(1, resolved.length)).toFixed(2),
  overall: { avgR: +mean(all).toFixed(3), ci: overallCi ? [+overallCi[0].toFixed(3), +overallCi[1].toFixed(3)] : null },
  rules: { minSamples: MIN_N, requiresRecentHalfToHold: true, bootstrapIterations: BOOT },
  actionable,
  assumptions,
  verdict: actionable.length
    ? `${actionable.length} finding(s) cleared the bar and may be acted on.`
    : 'No slice of the data has a positive edge that survives a time split. '
      + 'The system is deliberately changing nothing rather than fitting to noise.',
  byFeature: report,
};

writeFileSync('data/self-evaluation.json', JSON.stringify(out, null, 2));

console.log(`self-evaluation over ${resolved.length} independent episodes `
  + `(${rawResolved.length} raw publications, ${(rawResolved.length/Math.max(1,resolved.length)).toFixed(2)}x inflation)`);
console.log(`  overall ${out.overall.avgR >= 0 ? '+' : ''}${out.overall.avgR}R  CI[${out.overall.ci}]`);
console.log(`  ${out.verdict}`);
for (const [f, rows] of Object.entries(report)) {
  const best = rows.filter(r => r.n >= MIN_N)[0];
  if (best) console.log(`  ${f.padEnd(15)} best: ${String(best.value).padEnd(22)} n=${String(best.n).padEnd(4)} ${best.avgR >= 0 ? '+' : ''}${best.avgR}R — ${best.verdict}`);
}
