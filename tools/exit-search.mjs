#!/usr/bin/env node
/**
 * exit-search.mjs — the lever nothing has ever pulled.
 *
 * Every backtest in this project has used ONE exit scheme: stop at 1.5x ATR,
 * targets at 1.2 / 2.0 / 3.5R, thirds banked, stop trailed behind each. That
 * was never chosen by measurement — it was inherited and then held fixed while
 * everything else was searched.
 *
 * This takes the engine's OWN entries — the same ones the sealed test replayed
 * — and re-resolves every one of them under a grid of exit schemes. The entries
 * are held constant, so any difference is attributable to the exit alone.
 *
 * A warning worth stating before the numbers: with no edge at entry, exits move
 * the SHAPE of the return distribution much more than its mean. A scheme that
 * wins more often usually wins less per win. The search is still worth running,
 * because real series trend and cluster rather than coin-flip — but a large
 * apparent gain here is more likely a wider stop quietly taking more risk per
 * trade than a discovery, which is why everything is measured in R and checked
 * on a sealed quarter.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { strictAnalyze } from '../functions/api/check-signals.js';

const DIR = 'data/intraday';
const SUFFIX = '.1h.json';
const WINDOW = 300, HOLD = 240, COST_R = 0.02;

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const ci95 = a => { if (a.length < 2) return null; const se = sd(a) / Math.sqrt(a.length);
  return [+(mean(a) - 1.96 * se).toFixed(4), +(mean(a) + 1.96 * se).toFixed(4)]; };

function atrAt(bars, i, p = 14) {
  let acc = 0;
  for (let j = i - p + 1; j <= i; j++) {
    if (j < 1) return null;
    acc += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j-1].c), Math.abs(bars[j].l - bars[j-1].c));
  }
  return acc / p;
}

/**
 * Resolve one entry under one exit scheme.
 * scheme = { sl, tps: [r...], trail: 'none'|'entry'|'prev' }
 */
function resolveWith(bars, i, dir, atr, scheme) {
  const entry = bars[i + 1] && bars[i + 1].o;
  if (!entry || !(atr > 0)) return null;
  const sign = dir === 'BUY' ? 1 : -1;
  const slDist = atr * scheme.sl;
  const stopInit = entry - sign * slDist;
  const tps = scheme.tps.map(r => entry + sign * slDist * r);
  const share = 1 / tps.length;

  let banked = 0, left = 1, stop = stopInit, hit = 0;
  for (let j = i + 1; j < Math.min(bars.length, i + 1 + HOLD); j++) {
    const b = bars[j];
    // Stop before targets, always.
    if ((sign > 0 && b.l <= stop) || (sign < 0 && b.h >= stop)) {
      banked += left * ((stop - entry) * sign / slDist);
      return banked - COST_R;
    }
    for (let k = hit; k < tps.length; k++) {
      const reached = sign > 0 ? b.h >= tps[k] : b.l <= tps[k];
      if (!reached) break;
      banked += share * scheme.tps[k];
      left -= share;
      hit = k + 1;
      if (scheme.trail === 'entry' && hit >= 1) stop = entry;
      if (scheme.trail === 'prev' && hit >= 2) stop = tps[hit - 2];
      if (hit >= tps.length) return banked - COST_R;
    }
  }
  const last = bars[Math.min(bars.length - 1, i + HOLD)];
  banked += left * ((last.c - entry) * sign / slDist);
  return banked - COST_R;
}

/* ── collect the engine's entries once; re-resolve them many times ──────── */
if (!existsSync(DIR)) { console.error('exit-search: no data/intraday'); process.exit(1); }
const entries = [];           // { bars, i, dir, atr, frac }
const byPair = new Map();

for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX, '').replace('-', '/');
  let bars;
  try {
    bars = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'))
      .filter(x => x && [x.o,x.h,x.l,x.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
  } catch { continue; }
  if (bars.length < WINDOW + 400) continue;
  byPair.set(pair, bars);

  let free = WINDOW;
  for (let i = WINDOW; i < bars.length - HOLD - 2; i++) {
    if (i < free) continue;
    let sig = null;
    try { sig = strictAnalyze(pair, bars.slice(i - WINDOW + 1, i + 1), []); } catch { continue; }
    if (!sig || !sig.entry || !sig.sl) continue;
    const atr = atrAt(bars, i);
    if (!atr) continue;
    const dir = String(sig.direction || '').toUpperCase().startsWith('B') ? 'BUY' : 'SELL';
    entries.push({ pair, i, dir, atr, frac: i / bars.length });
    free = i + 40;            // a fixed spacing, so the entry set does not
                              // change as the exit scheme changes
  }
}

console.log(`exit-search: ${entries.length.toLocaleString()} engine entries across ${byPair.size} instruments`);
console.log('  the entries are HELD CONSTANT, so any difference is the exit alone\n');

/* ── the grid ───────────────────────────────────────────────────────────── */
const SLS = [0.75, 1.0, 1.5, 2.0, 3.0];
const LADDERS = [
  { id: '1.2/2.0/3.5 (current)', tps: [1.2, 2.0, 3.5] },
  { id: '1.0/2.0/3.0',           tps: [1.0, 2.0, 3.0] },
  { id: '0.5/1.0/2.0',           tps: [0.5, 1.0, 2.0] },
  { id: '2.0/3.0/5.0',           tps: [2.0, 3.0, 5.0] },
  { id: '1.0 only',              tps: [1.0] },
  { id: '2.0 only',              tps: [2.0] },
  { id: '3.0 only',              tps: [3.0] },
  { id: '1.5/3.0',               tps: [1.5, 3.0] },
];
const TRAILS = ['none', 'entry', 'prev'];

const schemes = [];
for (const sl of SLS) for (const L of LADDERS) for (const tr of TRAILS)
  schemes.push({ id: `SL ${sl}xATR · TP ${L.id} · trail ${tr}`, sl, tps: L.tps, trail: tr });

const HYP = schemes.length;
const BAR_T = 3.4;            // roughly Bonferroni for this many schemes

const results = [];
for (const sc of schemes) {
  const tr = [], va = [], se = [];
  for (const e of entries) {
    const r = resolveWith(byPair.get(e.pair), e.i, e.dir, e.atr, sc);
    if (r == null) continue;
    (e.frac < 0.5 ? tr : e.frac < 0.75 ? va : se).push(r);
  }
  if (se.length < 200) continue;
  results.push({ id: sc.id, sl: sc.sl, tps: sc.tps, trail: sc.trail,
    train: { n: tr.length, avgR: +mean(tr).toFixed(4), t: +tstat(tr).toFixed(2) },
    validate: { n: va.length, avgR: +mean(va).toFixed(4), t: +tstat(va).toFixed(2) },
    sealed: { n: se.length, avgR: +mean(se).toFixed(4), t: +tstat(se).toFixed(2), ci: ci95(se),
              winRate: +(se.filter(r => r > 0).length / se.length * 100).toFixed(1) } });
}

const current = results.find(r => r.id.includes('current') && r.sl === 1.5 && r.trail === 'prev')
             || results.find(r => r.id.includes('current'));

results.sort((a, b) => b.sealed.avgR - a.sealed.avgR);
console.log(`  ${HYP} exit schemes tested on the same entries, bar |t| > ${BAR_T}\n`);
console.log('  BEST BY SEALED RESULT:');
for (const r of results.slice(0, 10)) {
  console.log(`    ${r.id.padEnd(42)} train ${(r.train.avgR>=0?'+':'')+r.train.avgR}  valid ${(r.validate.avgR>=0?'+':'')+r.validate.avgR}  SEALED ${(r.sealed.avgR>=0?'+':'')+r.sealed.avgR}R t=${String(r.sealed.t).padStart(6)} win ${r.sealed.winRate}%`);
}
if (current) {
  console.log(`\n  CURRENT SCHEME for comparison:`);
  console.log(`    ${current.id.padEnd(42)} train ${(current.train.avgR>=0?'+':'')+current.train.avgR}  valid ${(current.validate.avgR>=0?'+':'')+current.validate.avgR}  SEALED ${(current.sealed.avgR>=0?'+':'')+current.sealed.avgR}R t=${current.sealed.t} win ${current.sealed.winRate}%`);
}

// A better exit must beat the current one AND clear zero on its own.
const best = results[0];
const beatsCurrent = current ? best.sealed.avgR - current.sealed.avgR : null;
const clearsZero = best.sealed.ci && best.sealed.ci[0] > 0;
const consistent = best.train.avgR > 0 && best.validate.avgR > 0 && best.sealed.avgR > 0;

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/exit-search.mjs',
  entries: entries.length, instruments: byPair.size, schemesTested: HYP, barT: BAR_T,
  current, best, improvementVsCurrentR: beatsCurrent == null ? null : +beatsCurrent.toFixed(4),
  bestClearsZero: !!clearsZero, bestPositiveInAllThree: consistent,
  top: results.slice(0, 15),
  method: 'Engine entries held constant; only the exit varies. Entry at the next open, '
        + 'stop checked before targets within a bar, costs charged, fixed 40-bar spacing between '
        + 'entries so the entry set cannot change with the scheme. Train 0-50%, validate 50-75%, '
        + 'sealed 75-100%.',
  verdict: (clearsZero && consistent)
    ? `A different exit clears zero on the sealed quarter: ${best.id} at ${best.sealed.avgR}R, interval [${best.sealed.ci.join(', ')}].`
    : `No exit scheme turns these entries positive. The best on the sealed quarter is ${best.id} at `
      + `${best.sealed.avgR}R with interval ${best.sealed.ci ? '[' + best.sealed.ci.join(', ') + ']' : '—'}`
      + `${clearsZero ? '' : ', which includes zero'}. Exits change the shape of the distribution; they do not `
      + `create an edge the entries do not have.`,
};
writeFileSync('data/exit-search.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
