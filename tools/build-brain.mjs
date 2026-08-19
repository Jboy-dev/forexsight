// v469 — THE LEARNING BRAIN, BUILT OFFLINE.
//
// The brain used to live in Cloudflare KV, written by a Function with a
// 14-day expiry. That made the app's intelligence hostage to Cloudflare: when
// Functions went down the brain stopped being refreshed, and when the key
// expired it vanished entirely. It did vanish — the namespace was found empty,
// which is why every signal was arriving with no probability estimate.
//
// This rebuilds it from the tracked book instead: same statistics, computed in
// CI, published as a static asset. No Function invocation, no KV write, no
// quota consumed, nothing to expire.
//
// What it will NOT do is invent confidence. Every slice carries its sample
// count and a bootstrap interval, and a win rate is only marked usable when
// there is enough evidence to mean something. Where the data is thin the brain
// says so and the card shows "not scored" rather than a number that looks
// authoritative and is not. The measured record on this book is negative
// overall; a brain that reported otherwise would be lying.
import { readFileSync, writeFileSync } from 'fs';
import { toEpisodes } from './lib/episodes.mjs';

const MIN_SAMPLES = 20;     // below this, a rate is not reported as usable
const BOOT = 4000;

const book = JSON.parse(readFileSync('data/open-setups.json', 'utf8'));
const resolved = book
  .filter(x => typeof x.resultR === 'number' && x.firedAt)
  .sort((a, b) => String(a.firedAt).localeCompare(String(b.firedAt)));

// Episode collapsing lives in tools/lib/episodes.mjs — shared with the
// self-evaluator so both agree on what one observation is.

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
  return [+m[Math.floor(0.025 * BOOT)].toFixed(3), +m[Math.floor(0.975 * BOOT)].toFixed(3)];
}

// A slice is a group of resolved setups plus everything that can honestly be
// said about it. `usable` is the flag the app keys on: below the sample floor
// nothing here should drive a displayed probability.
function slice(rows) {
  const rs = rows.map(x => x.resultR);
  const w = rows.filter(x => x.resultR > 0.02).length;
  const l = rows.filter(x => x.resultR < -0.02).length;
  const n = rows.length;
  const interval = ci(rs);
  return {
    w, l, samples: n,
    winRate: n ? +(w / n).toFixed(4) : null,
    avgR: +mean(rs).toFixed(3),
    ci: interval,
    usable: n >= MIN_SAMPLES,
    // Positive only when the interval clears zero — the same bar the
    // self-evaluator uses, so the two can never disagree.
    proven: !!(interval && n >= MIN_SAMPLES && interval[0] > 0),
  };
}

function group(rows, keyFn) {
  const bag = {};
  for (const x of rows) {
    const k = keyFn(x);
    if (k == null) continue;
    (bag[k] ||= []).push(x);
  }
  const out = {};
  for (const [k, v] of Object.entries(bag)) out[k] = slice(v);
  return out;
}

// Everything below is computed on EPISODES. `resolved` is kept only to report
// how many raw publications those episodes came from.
const episodes = toEpisodes(resolved);

const byCombo = group(episodes, x => x.comboKey || null);
const byPair  = group(episodes, x => x.pair || null);
const byHour  = group(episodes, x => {
  const h = +String(x.firedAt).slice(11, 13);
  return Number.isFinite(h) ? String(h) : null;
});
const byStrategyCount = group(episodes, x => x.strategies != null ? String(x.strategies) : null);
const byRegime = group(episodes, x => x.regime || null);

// Per-strategy, multi-valued: a setup counts toward every strategy that fired.
const byStrategy = {};
{
  const bag = {};
  for (const x of episodes) for (const s of (x.namedStrategies || [])) (bag[s] ||= []).push(x);
  for (const [k, v] of Object.entries(bag)) byStrategy[k] = slice(v);
}

const all = slice(episodes);
// Recent regime: what the last 30 resolved setups looked like. Descriptive
// only — it labels conditions, it does not predict them.
const recent = episodes.slice(-30);
const recentAvg = recent.length ? mean(recent.map(x => x.resultR)) : 0;

// ── v471 — HOW MUCH EVIDENCE WOULD SETTLE THIS ────────────────────────────
//
// The interval on this book includes zero. That does not mean the system has
// no edge; it means the sample cannot tell yet, and the difference matters. A
// record can look bad for a long time on too few observations, and it can look
// good for exactly as long.
//
// So rather than assert either way, this reports what it would take. Episodes
// needed to detect an edge of a given size at 95% confidence with 80% power,
// using the spread of outcomes actually observed. It turns "is this
// profitable?" into a question with a date on it.
const rs = episodes.map(x => x.resultR);
const sd = rs.length > 1
  ? Math.sqrt(rs.reduce((a, b) => a + (b - mean(rs)) ** 2, 0) / rs.length)
  : 0;
const firstT = Date.parse(episodes[0]?.firedAt || Date.now());
const lastT  = Date.parse(episodes[episodes.length - 1]?.firedAt || Date.now());
const spanDays = Math.max(0.5, (lastT - firstT) / 86400000);
const perDay = episodes.length / spanDays;
const evidenceNeeded = [0.05, 0.10, 0.20, 0.30, 0.50].map(edge => {
  const need = Math.ceil(Math.pow((1.96 + 0.84) * sd / edge, 2));
  return {
    edge, episodesNeeded: need,
    stillToGo: Math.max(0, need - episodes.length),
    daysAtCurrentRate: +((Math.max(0, need - episodes.length)) / Math.max(0.1, perDay)).toFixed(0),
  };
});

const brain = {
  ts: Date.now(),
  isoTime: new Date().toISOString(),
  source: 'offline-brain',
  builtBy: 'tools/build-brain.mjs',
  // Everything below is derived from setups this system published and then
  // watched to resolution against real candles. It is not a backtest.
  // Episodes are the honest unit. rawPublications is shown alongside so the
  // difference between "how often it fired" and "how much it learned" is
  // visible rather than silently conflated.
  totalSamples: episodes.length,
  rawPublications: resolved.length,
  inflationFactor: +(resolved.length / Math.max(1, episodes.length)).toFixed(2),
  // What the same book would report if republications were counted as
  // separate samples. Published so the correction is visible, not just claimed.
  uncorrectedAvgR: +mean(resolved.map(x => x.resultR)).toFixed(3),
  overall: all,
  minSamplesForUse: MIN_SAMPLES,
  byCombo, byPair, byHour, byStrategy, byStrategyCount, byRegime,
  currentRegime: {
    label: recentAvg > 0.05 ? 'favourable' : recentAvg < -0.05 ? 'unfavourable' : 'neutral',
    recentAvgR: +recentAvg.toFixed(3),
    basedOn: recent.length,
    note: 'Describes how recent setups resolved. It is not a forecast.',
  },
  // Honest headline for anything that wants one number.
  standardDeviation: +sd.toFixed(3),
  episodesPerDay: +perDay.toFixed(1),
  evidenceNeeded,
  provenSlices: Object.entries({ ...byCombo, ...byPair, ...byStrategy })
    .filter(([, v]) => v.proven).map(([k]) => k),
  verdict: null,
};
brain.verdict = brain.provenSlices.length
  ? `${brain.provenSlices.length} slice(s) show a positive edge that clears its confidence interval.`
  : 'No slice shows a positive edge that clears its confidence interval. '
    + 'Win chances are reported where samples allow, but none is yet evidence of an edge.';

writeFileSync('data/learning-brain.json', JSON.stringify(brain, null, 2));

console.log(`brain built from ${episodes.length} independent episodes `
  + `(${resolved.length} raw publications, ${(resolved.length / Math.max(1, episodes.length)).toFixed(2)}x inflation)`);
console.log(`  overall ${all.avgR >= 0 ? '+' : ''}${all.avgR}R  win rate ${(all.winRate * 100).toFixed(1)}%  CI[${all.ci}]`);
console.log(`  combos ${Object.keys(byCombo).length}, pairs ${Object.keys(byPair).length}, strategies ${Object.keys(byStrategy).length}`);
console.log(`  usable combos (>=${MIN_SAMPLES} samples): ${Object.values(byCombo).filter(v => v.usable).length}`);
console.log(`  ${brain.verdict}`);
