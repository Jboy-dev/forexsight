#!/usr/bin/env node
/**
 * engine-sealed-test.mjs — put the ACTUAL ENGINE through the sealed test.
 *
 * Everything measured so far has been textbook rules: momentum, RSI, Donchian,
 * moving-average crosses. None of that is what the site ships. The signals that
 * reach a phone come from strictAnalyze() and its twenty strategy functions,
 * and that code had NEVER been measured on held-out data. The live record says
 * it is not established, but the live record is 389 trades over a few weeks;
 * this is years of bars.
 *
 * It walks the history forward one bar at a time, hands the engine a rolling
 * window ending at that bar — never anything after it — and takes whatever it
 * fires, using THE ENGINE'S OWN entry, stop and targets. So this measures the
 * product, not an approximation of it.
 *
 * Then the same discipline as every other search here: train on the oldest
 * half, validate on the next quarter, and open the final quarter once.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { strictAnalyze } from '../functions/api/check-signals.js';

const DIR = 'data/intraday';
const SUFFIX = process.argv.find(a => a.startsWith('--tf='))?.slice(5) === 'daily' ? null : '.1h.json';
const WINDOW = 300;            // bars handed to the engine; it looks back ~250
const HOLD = 240;              // bars before a trade is closed out
const COST_R = 0.02;
const STEP = 1;

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const ci95 = a => { if (a.length < 2) return null; const se = sd(a) / Math.sqrt(a.length);
  return [+(mean(a) - 1.96 * se).toFixed(4), +(mean(a) + 1.96 * se).toFixed(4)]; };

/** Resolve a signal using the levels the ENGINE chose, with its managed ladder. */
function resolve(bars, i, sig) {
  const entry = +sig.entry, sl = +sig.sl, tp1 = +sig.tp1, tp2 = +sig.tp2, tp3 = +sig.tp3;
  if (![entry, sl, tp1].every(v => isFinite(v) && v > 0)) return null;
  const dir = String(sig.direction || '').toUpperCase();
  const sign = (dir === 'BUY' || dir === 'LONG') ? 1 : -1;
  const slDist = Math.abs(entry - sl);
  if (!(slDist > 0)) return null;

  let banked = 0, left = 1, stop = sl, hit = 0;
  for (let j = i + 1; j < Math.min(bars.length, i + 1 + HOLD); j++) {
    const b = bars[j];
    // Stop checked before targets: within one bar the adverse touch cannot be
    // ruled out, and assuming otherwise manufactures returns.
    if ((sign > 0 && b.l <= stop) || (sign < 0 && b.h >= stop)) {
      banked += left * ((stop - entry) * sign / slDist);
      return { r: banked - COST_R, bars: j - i, hit };
    }
    const reach = (lvl) => isFinite(lvl) && (sign > 0 ? b.h >= lvl : b.l <= lvl);
    if (hit < 1 && reach(tp1)) { banked += (1/3) * ((tp1 - entry) * sign / slDist); left -= 1/3; stop = entry; hit = 1; }
    if (hit < 2 && reach(tp2)) { banked += (1/3) * ((tp2 - entry) * sign / slDist); left -= 1/3; stop = tp1;   hit = 2; }
    if (hit < 3 && reach(tp3)) { banked += left * ((tp3 - entry) * sign / slDist);  left = 0;                  hit = 3;
      return { r: banked - COST_R, bars: j - i, hit }; }
  }
  const last = bars[Math.min(bars.length - 1, i + HOLD)];
  banked += left * ((last.c - entry) * sign / slDist);
  return { r: banked - COST_R, bars: HOLD, hit };
}

if (!existsSync(DIR)) { console.error('engine-sealed-test: no data/intraday'); process.exit(1); }
const files = readdirSync(DIR).filter(f => f.endsWith(SUFFIX));
console.log(`engine sealed test: replaying strictAnalyze over ${files.length} instruments\n`);

const all = [];          // { pair, idx, frac, r, tier, conf }
let scanned = 0, fired = 0;

for (const f of files) {
  const pair = f.replace(SUFFIX, '').replace('-', '/');
  let bars;
  try {
    bars = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'))
      .filter(x => x && [x.o, x.h, x.l, x.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
  } catch { continue; }
  if (bars.length < WINDOW + 400) continue;

  let free = WINDOW;
  let pairFired = 0;
  for (let i = WINDOW; i < bars.length - HOLD - 2; i += STEP) {
    scanned++;
    if (i < free) continue;                       // non-overlapping: one at a time
    let sig = null;
    try {
      // The engine only ever sees bars up to and including i. Nothing after.
      sig = strictAnalyze(pair, bars.slice(i - WINDOW + 1, i + 1), []);
    } catch (_) { continue; }
    if (!sig || !sig.entry || !sig.sl) continue;
    const res = resolve(bars, i, sig);
    if (!res) continue;
    fired++; pairFired++;
    all.push({ pair, idx: i, frac: i / bars.length, r: res.r, hit: res.hit,
               tier: sig.tier || null, conf: typeof sig.confidence === 'number' ? sig.confidence : null });
    free = i + res.bars + 1;
  }
  console.log(`  ${pair.padEnd(9)} ${bars.length.toLocaleString().padStart(7)} bars -> ${String(pairFired).padStart(4)} signals`);
}

if (!all.length) { console.error('\nengine-sealed-test: the engine fired nothing across the whole history'); process.exit(0); }

const slice = (lo, hi) => all.filter(x => x.frac >= lo && x.frac < hi).map(x => x.r);
const train = slice(0, 0.5), validate = slice(0.5, 0.75), sealed = slice(0.75, 1.0001);
const stat = (rs) => ({ n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2),
                        ci: ci95(rs), winRate: rs.length ? +(rs.filter(r => r > 0).length / rs.length * 100).toFixed(1) : null });

const T = stat(train), V = stat(validate), S = stat(sealed), A = stat(all.map(x => x.r));

console.log(`\n  ${scanned.toLocaleString()} bars scanned, ${fired.toLocaleString()} signals fired (${(fired / scanned * 100).toFixed(2)}% of bars)\n`);
console.log('  THE ENGINE, MEASURED ON ITS OWN SIGNALS AND ITS OWN LEVELS:');
for (const [lbl, s] of [['train (oldest 50%)', T], ['validate (next 25%)', V], ['SEALED (newest 25%)', S], ['everything', A]]) {
  console.log(`    ${lbl.padEnd(22)} ${String(s.n).padStart(5)} signals  ${(s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(4)}R  t=${String(s.t).padStart(6)}  win ${s.winRate}%  CI ${s.ci ? '[' + s.ci.join(', ') + ']' : '—'}`);
}

// Does the engine's own confidence score separate anything?
const withConf = all.filter(x => x.conf != null);
let confSplit = null;
if (withConf.length > 60) {
  const sorted = [...withConf].sort((a, b) => a.conf - b.conf);
  const half = Math.floor(sorted.length / 2);
  const lowC = sorted.slice(0, half).map(x => x.r), highC = sorted.slice(half).map(x => x.r);
  confSplit = { low: stat(lowC), high: stat(highC),
                separates: mean(highC) > mean(lowC) + 0.05 };
  console.log(`\n  Does its own confidence score separate winners from losers?`);
  console.log(`    low  half  ${String(confSplit.low.n).padStart(5)} signals  ${(confSplit.low.avgR >= 0 ? '+' : '') + confSplit.low.avgR}R`);
  console.log(`    high half  ${String(confSplit.high.n).padStart(5)} signals  ${(confSplit.high.avgR >= 0 ? '+' : '') + confSplit.high.avgR}R`);
  console.log(`    ${confSplit.separates ? 'It separates them.' : 'It does NOT separate them — a high score is not a better trade.'}`);
}

const sealedPositive = S.ci && S.ci[0] > 0;
const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/engine-sealed-test.mjs',
  instruments: files.length, barsScanned: scanned, signalsFired: fired,
  fireRatePct: +(fired / scanned * 100).toFixed(3),
  train: T, validate: V, sealed: S, overall: A, confidenceSplit: confSplit,
  method: 'strictAnalyze replayed bar by bar over hourly history with a 300-bar rolling window. '
        + 'The engine never sees a bar after the one it is judging. Resolved with ITS OWN entry, '
        + 'stop and targets under the managed ladder, costs charged, stop checked before targets '
        + 'within a bar, non-overlapping. Train 0-50%, validate 50-75%, sealed 75-100%.',
  verdict: sealedPositive
    ? `The engine clears zero on the sealed quarter: ${S.avgR}R over ${S.n} signals, interval [${S.ci.join(', ')}].`
    : `The engine does not establish an edge on held-out data. Sealed: ${S.avgR}R over ${S.n} signals, `
      + `interval ${S.ci ? '[' + S.ci.join(', ') + ']' : 'unavailable'}, which ${S.ci && S.ci[0] <= 0 && S.ci[1] >= 0 ? 'includes zero' : 'is negative'}.`,
};
writeFileSync('data/engine-sealed-test.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
console.log(`\n  wrote data/engine-sealed-test.json`);
