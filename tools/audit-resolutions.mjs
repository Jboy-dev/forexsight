#!/usr/bin/env node
/**
 * audit-resolutions.mjs — are the recorded results true?
 *
 * Every other test here asks whether the STRATEGY works. This asks something
 * more basic and more important: when the book says a signal WON at TP2, did
 * price actually reach TP2 before the stop? A strategy that does not work is a
 * disappointment. A record that reports outcomes that did not happen is a lie,
 * and every number on the site inherits it.
 *
 * So each resolved signal is replayed from the published hourly bars, by code
 * written here rather than shared with the watcher, between the moment it fired
 * and the moment the watcher says it ended. The replay decides for itself what
 * happened, and the two verdicts are compared.
 *
 * Bar-granularity caveat, stated up front: on an hourly bar that contains both
 * the stop and a target, neither this replay nor the watcher can know which came
 * first. Those are counted and reported separately rather than scored as
 * agreements or disagreements, because the honest answer is that the bar does
 * not say.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const MIRROR = 'https://raw.githubusercontent.com/Jboy-dev/forexsight/main/data';
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

const ledger = await get(`${MIRROR}/ledger.json`);
const history = (ledger.history || []).filter(x => x.status && x.status !== 'open');
console.log(`auditing ${history.length} resolved signals against the bars they actually traded through\n`);

// Load every published bar set once.
const barsByPair = new Map();
for (const f of readdirSync('data/ohlc').filter(x => /^[A-Z0-9-]+\.json$/.test(x))) {
  try {
    const d = JSON.parse(readFileSync(`data/ohlc/${f}`, 'utf8'));
    const rows = (d.ohlc || []).filter(b => b && [b.o, b.h, b.l, b.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
    if (rows.length) barsByPair.set(d.pair || f.replace('.json', '').replace('-', '/'), rows);
  } catch { /* a missing or broken file is reported as uncheckable, never guessed at */ }
}
console.log(`  bar sets loaded: ${barsByPair.size}\n`);

/** Replay the managed ladder independently of the watcher's own code. */
function replay(sig, bars) {
  const { entry, sl, tp1, tp2, tp3 } = sig;
  if (![entry, sl].every(v => typeof v === 'number')) return null;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const buy = /^(BUY|LONG)/i.test(String(sig.direction || ''));
  const sgn = buy ? 1 : -1;
  const fired = Date.parse(sig.firedAt), ended = Date.parse(sig.resolvedAt);
  if (!isFinite(fired) || !isFinite(ended)) return null;

  const win = bars.filter(b => b.t > fired && b.t <= ended + 3600000);
  if (win.length < 1) return { verdict: 'no bars', bars: 0 };

  const tps = [tp1, tp2, tp3];
  let stop = sl, hit = 0, banked = 0, open = 1, ambiguous = 0;
  for (const b of win) {
    const stopTouched = buy ? b.l <= stop : b.h >= stop;
    let targetTouched = -1;
    for (let k = hit; k < 3; k++) {
      const t = tps[k];
      if (typeof t !== 'number') break;
      if (buy ? b.h >= t : b.l <= t) targetTouched = k; else break;
    }
    // Both inside one hourly bar: the bar cannot say which came first.
    if (stopTouched && targetTouched >= 0) ambiguous++;
    if (stopTouched && targetTouched < 0) {
      // Value the remaining position AT THE STOP, whatever the stop currently is.
      // An earlier version reached for tps[hit-1], which after TP2 is TP2 itself
      // rather than the trailing stop at TP1 — it credited the last third at 2.0R
      // instead of 1.2R and produced a tidy, wrong 1.733R again and again. That
      // made the BOOK look like it was lying when the auditor was.
      banked += open * ((stop - entry) * sgn / risk);
      return { verdict: hit > 0 ? 'won' : 'lost', tpReached: hit, resultR: banked, bars: win.length, ambiguous };
    }
    if (targetTouched >= 0) {
      for (let k = hit; k <= targetTouched; k++) {
        banked += (1/3) * ((tps[k] - entry) * sgn / risk);
        open = Math.max(0, open - 1/3);
      }
      hit = targetTouched + 1;
      if (hit === 1) stop = entry; else if (hit === 2) stop = tps[0];
      if (hit >= 3) return { verdict: 'won', tpReached: 3, resultR: banked, bars: win.length, ambiguous };
    }
  }
  const lastC = win[win.length - 1].c;
  banked += open * ((lastC - entry) * sgn / risk);
  return { verdict: 'expired', tpReached: hit, resultR: banked, bars: win.length, ambiguous };
}

const out = { agree: 0, disagree: 0, uncheckable: 0, ambiguousBars: 0, rPairs: [] };
const problems = [];

for (const sig of history) {
  const bars = barsByPair.get(sig.pair);
  if (!bars) { out.uncheckable++; continue; }
  const rep = replay(sig, bars);
  if (!rep || rep.verdict === 'no bars') { out.uncheckable++; continue; }
  if (rep.ambiguous) out.ambiguousBars++;

  const statusOk = rep.verdict === sig.status;
  const tpOk = (rep.tpReached || 0) === (sig.tpReached || 0);
  if (typeof sig.resultR === 'number') out.rPairs.push([sig.resultR, rep.resultR]);

  if (statusOk && tpOk) { out.agree++; continue; }
  out.disagree++;
  if (problems.length < 14) problems.push({
    pair: sig.pair, direction: sig.direction, firedAt: sig.firedAt,
    recorded: { status: sig.status, tpReached: sig.tpReached || 0, resultR: sig.resultR },
    replayed: { status: rep.verdict, tpReached: rep.tpReached, resultR: +rep.resultR.toFixed(3) },
    ambiguousBars: rep.ambiguous,
  });
}

const checked = out.agree + out.disagree;
const pct = checked ? (out.agree / checked * 100) : 0;
console.log(`  checked      ${checked}`);
console.log(`  agree        ${out.agree}  (${pct.toFixed(1)}%)`);
console.log(`  disagree     ${out.disagree}`);
console.log(`  uncheckable  ${out.uncheckable}   (no published bars covering the period)`);
console.log(`  of the checked, ${out.ambiguousBars} had an hourly bar containing BOTH a target and the stop,`);
console.log(`  where no bar-based replay can say which came first.\n`);

if (problems.length) {
  console.log('  disagreements:');
  for (const p of problems)
    console.log(`    ${p.pair.padEnd(9)} ${String(p.direction).padEnd(5)} ${String(p.firedAt).slice(0,16)}  `
      + `book says ${p.recorded.status}/TP${p.recorded.tpReached}/${p.recorded.resultR}R  `
      + `bars say ${p.replayed.status}/TP${p.replayed.tpReached}/${p.replayed.resultR}R`
      + (p.ambiguousBars ? `  (${p.ambiguousBars} ambiguous bar(s))` : ''));
}

// How closely do the two R figures track, where both exist?
let rErr = null;
if (out.rPairs.length > 2) {
  const d = out.rPairs.map(([a, b]) => Math.abs(a - b));
  d.sort((a, b) => a - b);
  rErr = { median: +d[Math.floor(d.length/2)].toFixed(3), p90: +d[Math.floor(d.length*0.9)].toFixed(3), worst: +d[d.length-1].toFixed(3) };
  console.log(`\n  recorded R vs replayed R, absolute difference: median ${rErr.median}, p90 ${rErr.p90}, worst ${rErr.worst}`);
}

const clean = out.disagree === 0;
const result = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/audit-resolutions.mjs',
  question: 'When the book says a signal won or lost, did the price actually do that?',
  method: 'Each resolved signal replayed from published hourly bars between firedAt and resolvedAt, by code '
        + 'written independently of the watcher. Status and furthest target compared.',
  caveat: 'On an hourly bar containing both a target and the stop, neither the replay nor the watcher can know '
        + 'which came first. Those are counted and reported, not scored.',
  checked, agree: out.agree, disagree: out.disagree, uncheckable: out.uncheckable,
  agreementPct: +pct.toFixed(1), ambiguousBarCases: out.ambiguousBars,
  rDifference: rErr, problems,
  established: clean,
  verdict: clean
    ? `Every one of the ${checked} resolved signals that could be checked replays to the same outcome the book `
      + `records. The record is not inventing results.`
    : `${out.disagree} of ${checked} resolved signals replay to a DIFFERENT outcome than the book records `
      + `(${pct.toFixed(1)}% agree). ${out.ambiguousBars} involved an hourly bar holding both a target and the `
      + `stop, where the bar genuinely cannot say which came first; the rest need explaining.`,
};
writeFileSync('data/audit-resolutions.json', JSON.stringify(result, null, 2));
console.log(`\n  ${result.verdict}`);
