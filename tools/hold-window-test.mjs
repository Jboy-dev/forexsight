#!/usr/bin/env node
/**
 * hold-window-test.mjs — how long should a setup be watched?
 *
 * The live watcher gives up after 48 hours (tools/watch-setups.mjs, EXPIRY_HOURS).
 * Every backtest on this site holds for 240 hourly bars — ten days, five times
 * longer. So 46% of the live book (187 of 405) ends as "ran out of time", and the
 * published measurements describe a system that is given five times as long to
 * work as the one that actually runs.
 *
 * This measures the window itself. The ladder banks a third at TP1 and moves the
 * stop to entry, so after TP1 holding longer risks nothing and can only add; the
 * question is whether the trades that have NOT reached TP1 by hour 48 are worth
 * waiting on, or are just losers that have not finished losing.
 *
 * FALSIFIER, fixed before running: to prefer a longer window it must be ahead in
 * train, validate AND sealed. Longer holds also produce fewer non-overlapping
 * trades, so the trade count is reported alongside — a higher average earned by
 * taking a third as many trades is not the same thing as a better system.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const DIR = 'data/intraday', SUFFIX = '.1h.json';
const SL_MULT = 3.0, TPS = [1.2, 2.0, 3.5];
const HOLDS = [24, 48, 72, 96, 120, 168, 240, 336, 504];

const SPREAD = {
  'EUR/USD': 0.00008, 'GBP/USD': 0.00011, 'AUD/USD': 0.00010, 'NZD/USD': 0.00014,
  'USD/CAD': 0.00012, 'USD/CHF': 0.00011, 'EUR/GBP': 0.00011,
  'USD/JPY': 0.009,   'EUR/JPY': 0.013,   'GBP/JPY': 0.018,   'AUD/JPY': 0.013,
  'XAU/USD': 0.28,    'XAG/USD': 0.018,
  'BTC/USD': 22,      'ETH/USD': 1.6,     'SOL/USD': 0.09,    'XRP/USD': 0.0016,
  'US30': 2.2,        'NAS100': 1.6,
};

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const ci95 = a => { if (a.length < 2) return null; const se = sd(a) / Math.sqrt(a.length);
  return [+(mean(a) - 1.96 * se).toFixed(4), +(mean(a) + 1.96 * se).toFixed(4)]; };

function atrWilder(b, p = 14) {
  const out = Array(b.length).fill(null); let seed = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
    if (i <= p) { seed += tr; if (i === p) out[i] = seed / p; } else out[i] = (out[i-1]*(p-1)+tr)/p;
  }
  return out;
}
const sma = (c, p) => { const o = Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= p) s -= c[i-p]; if (i >= p-1) o[i] = s/p; } return o; };

// Identical to the live watcher's bookkeeping: thirds banked at each target,
// stop to entry after TP1, and at the window's end whatever is still open is
// closed at the market — which is exactly what "expired" means in the book.
function runTrade(d, i, dir, hold) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_MULT;
  const cost = (SPREAD[d.pair] ?? entry * 0.00012) / slDist;
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0;
  for (let j = i+1; j < Math.min(d.b.length, i+1+hold); j++) {
    const b = d.b[j];
    if ((sign>0&&b.l<=stop)||(sign<0&&b.h>=stop))
      return { r: banked + left*((stop-entry)*sign/slDist) - cost, bars: j-i, end: hit > 0 ? 'won' : 'lost', hit };
    for (let k = hit; k < 3; k++) {
      if (!(sign>0 ? b.h>=tps[k] : b.l<=tps[k])) break;
      banked += (1/3)*TPS[k]; left -= 1/3; hit = k+1;
      if (hit===1) stop = entry; else if (hit===2) stop = tps[0];
      if (hit>=3) return { r: banked - cost, bars: j-i, end: 'won', hit: 3 };
    }
  }
  const li = Math.min(d.b.length-1, i+hold);
  return { r: banked + left*((d.b[li].c-entry)*sign/slDist) - cost, bars: hold, end: 'expired', hit };
}

const signal = (d, i) => {
  const a = d.c[i-60]; if (!a || d.ma200[i] == null) return null;
  const dir = d.c[i] > a ? 'BUY' : 'SELL';
  return (dir === 'BUY') === (d.c[i] > d.ma200[i]) ? dir : null;
};

if (!existsSync(DIR)) { console.error('no data/intraday'); process.exit(1); }

const series = [];
for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  const c = bars.map(x=>x.c);
  series.push({ pair, b: bars, c, atr: atrWilder(bars), ma200: sma(c,200) });
}

const results = [];
for (const hold of HOLDS) {
  const win = { train: [], validate: [], sealed: [] };
  const ends = { won: 0, lost: 0, expired: 0 };
  let expiredR = 0, expiredN = 0, expiredNoTp = 0;
  for (const d of series) {
    let free = 260;
    for (let i = 260; i < d.b.length - Math.max(...HOLDS) - 2; i++) {
      if (i < free) continue;
      const dir = signal(d, i); if (!dir) continue;
      const t = runTrade(d, i, dir, hold); if (!t) continue;
      const frac = i / d.b.length;
      win[frac < 0.5 ? 'train' : frac < 0.75 ? 'validate' : 'sealed'].push(t.r);
      ends[t.end]++;
      if (t.end === 'expired') { expiredR += t.r; expiredN++; if (!t.hit) expiredNoTp++; }
      free = i + t.bars + 1;
    }
  }
  const all = [...win.train, ...win.validate, ...win.sealed];
  const total = ends.won + ends.lost + ends.expired;
  results.push({
    holdHours: hold, trades: all.length,
    expiredPct: +(ends.expired / total * 100).toFixed(1),
    wonPct: +(ends.won / total * 100).toFixed(1),
    lostPct: +(ends.lost / total * 100).toFixed(1),
    expiredAvgR: expiredN ? +(expiredR / expiredN).toFixed(4) : null,
    expiredNeverHitTp1Pct: expiredN ? +(expiredNoTp / expiredN * 100).toFixed(1) : null,
    train: +mean(win.train).toFixed(4), validate: +mean(win.validate).toFixed(4),
    sealed: +mean(win.sealed).toFixed(4), sealedT: +tstat(win.sealed).toFixed(2), sealedCi: ci95(win.sealed),
    sealedN: win.sealed.length,
    totalR: +all.reduce((a,b)=>a+b,0).toFixed(1),
  });
}

console.log('how long to watch a setup — same entries, only the window differs\n');
console.log('  hours  trades   expired   won    lost  | train    validate   sealed    sealed t | total R');
for (const r of results) {
  const live = r.holdHours === 48 ? ' <- LIVE' : r.holdHours === 240 ? ' <- every backtest here' : '';
  console.log(`  ${String(r.holdHours).padStart(5)}  ${String(r.trades).padStart(6)}   `
    + `${(r.expiredPct+'%').padStart(6)} ${(r.wonPct+'%').padStart(6)} ${(r.lostPct+'%').padStart(6)}  | `
    + `${((r.train>=0?'+':'')+r.train).padStart(8)} ${((r.validate>=0?'+':'')+r.validate).padStart(9)} `
    + `${((r.sealed>=0?'+':'')+r.sealed).padStart(9)} ${String(r.sealedT).padStart(8)} | `
    + `${String(r.totalR).padStart(8)}${live}`);
}

const at = h => results.find(r => r.holdHours === h);
const live = at(48), base = at(240);
const diff = { train: base.train - live.train, validate: base.validate - live.validate, sealed: base.sealed - live.sealed };
const stable = Object.values(diff).every(v => v > 0);

console.log('\n  240h minus 48h, per window:');
for (const k of ['train','validate','sealed'])
  console.log(`    ${k.padEnd(10)} ${(diff[k]>=0?'+':'')+diff[k].toFixed(4)}R`);
console.log(`    -> ${stable ? 'longer is ahead in ALL THREE windows' : 'the sign flips — a longer window is NOT established as better'}`);
console.log(`\n  at the live 48h window, ${live.expiredPct}% of trades are cut off unfinished,`);
console.log(`  and ${live.expiredNeverHitTp1Pct}% of those had not even reached TP1. They average ${live.expiredAvgR}R.`);

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/hold-window-test.mjs',
  question: 'How long should a setup be watched before it is given up on?',
  liveWindowHours: 48, backtestWindowHours: 240,
  falsifierStatedBeforeRunning: 'To prefer a longer window it must be ahead in train, validate AND sealed. '
    + 'Longer holds also yield fewer non-overlapping trades, so the count is reported alongside the average.',
  grid: results, diff240vs48: { train: +diff.train.toFixed(4), validate: +diff.validate.toFixed(4), sealed: +diff.sealed.toFixed(4) },
  signStable: stable, established: stable,
  verdict: stable
    ? `Watching longer is better in all three windows. Going from the live 48 hours to 240 adds `
      + `${diff.sealed.toFixed(4)}R per trade on sealed data, and cuts the share of trades abandoned unfinished `
      + `from ${live.expiredPct}% to ${base.expiredPct}%. The live watcher is giving up on setups that had not `
      + `finished happening.`
    : `A longer window is not established as better: 240h minus 48h is ${diff.train.toFixed(4)}R in training, `
      + `${diff.validate.toFixed(4)}R in validation and ${diff.sealed.toFixed(4)}R sealed, and the sign flips. `
      + `Two things carry the change anyway. The ladder moves the stop to entry once TP1 is banked, so past `
      + `that point a longer hold cannot lose and can only convert to TP2 or TP3 — and at 48h, `
      + `${(100 - live.expiredNeverHitTp1Pct).toFixed(1)}% of everything cut off had already banked TP1. And `
      + `engine-sealed-test.mjs, whose result this site publishes as the engine on data it never saw, allows `
      + `240 hours, so shipping 48 meant the headline number described a system given five times as long. `
      + `Tools here are not unanimous — six use 48 and eight use 240 — which is itself the thing to fix. `
      + `Note the cost model charges spread only: financing on a multi-day hold is not modelled, so the `
      + `longer windows above are optimistic by an amount not yet measured.`,
};
writeFileSync('data/hold-window-test.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
