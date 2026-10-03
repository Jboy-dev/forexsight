#!/usr/bin/env node
/**
 * strategy-promote.mjs — the only route a strategy can take into the signal path.
 *
 * It reads data/strategy-trials.json and writes data/active-strategy.json, which
 * is what the generator consults. A rule reaches the site if and only if it
 * cleared the sealed test at a bar corrected for every hypothesis tried AND beat
 * a random-entry null. There is no manual override and no second route in.
 *
 * Today it promotes nothing, because nothing passes. That is the correct output,
 * not a failure of the mechanism — and the mechanism is tested by feeding it a
 * synthetic passing result (see --selftest), so the day something does pass, it
 * goes live without anyone having to remember to wire it up.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const TRIALS = 'data/strategy-trials.json';
const ACTIVE = 'data/active-strategy.json';
const selftest = process.argv.includes('--selftest');

let trials;
try { trials = JSON.parse(readFileSync(selftest ? '/tmp/fake-trials.json' : TRIALS, 'utf8')); }
catch (e) { console.error(`strategy-promote: cannot read trials — ${e.message}`); process.exit(1); }

const passed = Array.isArray(trials.passed) ? trials.passed : [];

// Rank by sealed performance, not by training performance. Training rank is
// what overfitting optimises; the sealed number is the only one that was not
// available while the rule was being chosen.
passed.sort((a, b) => (b.sealed?.avgR ?? -1e9) - (a.sealed?.avgR ?? -1e9));

const out = {
  ts: Date.now(),
  isoTime: new Date().toISOString(),
  builtBy: 'tools/strategy-promote.mjs',
  source: { ts: trials.ts, hypotheses: trials.hypotheses, bar: trials.bonferroniBarT },
  active: passed.length ? {
    name: passed[0].name, entry: passed[0].entry, filter: passed[0].filter,
    sealed: passed[0].sealed,
    note: 'Promoted on sealed evidence. Its forward record is tracked separately and will '
        + 'demote it if live results contradict the test.',
  } : null,
  alsoPassed: passed.slice(1).map(p => ({ name: p.name, sealedAvgR: p.sealed?.avgR })),
  verdict: passed.length
    ? `ACTIVE: ${passed[0].name} — sealed ${passed[0].sealed.avgR >= 0 ? '+' : ''}${passed[0].sealed.avgR}R over ${passed[0].sealed.n} trades, t=${passed[0].sealed.t}, clear of a random-entry null.`
    : 'No strategy is active. Nothing cleared the sealed test, so the signal path is unchanged. '
      + 'A rule that only works on the data it was chosen on is not a strategy, and shipping one '
      + 'would cost real money rather than merely being wrong on paper.',
  howToEarnAPlace: `Clear |t| > ${trials.bonferroniBarT ?? '?'} on the sealed 25% (a bar corrected for `
    + `${trials.hypotheses ?? '?'} hypotheses) and beat the random-entry 95th percentile at matched trade count.`,
};

if (selftest) { console.log(JSON.stringify(out.active ? { promoted: out.active.name } : { promoted: null })); process.exit(0); }

writeFileSync(ACTIVE, JSON.stringify(out, null, 2));
console.log('strategy-promote:', out.verdict);
if (!passed.length) console.log(`  ${out.howToEarnAPlace}`);
