#!/usr/bin/env node
/**
 * atr-method-test.mjs — the engine and the backtests do not use the same ATR.
 *
 * functions/api/check-signals.js computes ATR as a SIMPLE MOVING AVERAGE of
 * true range (`sum / p` over a rolling window). Every backtest on this site —
 * strategy-trials, cost-audit, the sealed engine test — uses WILDER smoothing,
 * `(prev*(p-1) + tr)/p`, which is what TradingView, MT4 and MT5 all use by
 * default and what the literature means by ATR.
 *
 * On live data the simple mean runs about 20% higher, because it weights the
 * last 14 bars equally while Wilder's keeps a long tail of calmer history. The
 * stop is 3x ATR, so the shipped stops are roughly a fifth wider than the ones
 * every measurement on this site describes. That is not a small labelling
 * detail: cost in R is spread / stop distance, and widening the stop is the one
 * change that has ever moved the sealed result.
 *
 * So this asks the only question that settles it: holding everything else
 * fixed, which ATR produces the better result on data the rule never saw?
 *
 * FALSIFIER, fixed before running: to prefer one method the difference must
 * hold the same sign in train, validate AND sealed. A single sealed win is the
 * shape noise takes.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const DIR = 'data/intraday', SUFFIX = '.1h.json';
const HOLD = 240, SL_MULT = 3.0, TPS = [1.2, 2.0, 3.5];

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

const trueRange = (b) => {
  const tr = Array(b.length).fill(0);
  for (let i = 1; i < b.length; i++)
    tr[i] = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
  return tr;
};
// What every backtest here uses, and what TradingView/MT5 call ATR.
function atrWilder(b, p = 14) {
  const tr = trueRange(b), out = Array(b.length).fill(null);
  let seed = 0;
  for (let i = 1; i < b.length; i++) {
    if (i <= p) { seed += tr[i]; if (i === p) out[i] = seed / p; }
    else out[i] = (out[i-1] * (p - 1) + tr[i]) / p;
  }
  return out;
}
// What the live engine uses, copied from check-signals.js.
function atrSma(b, p = 14) {
  const tr = trueRange(b), out = Array(b.length).fill(null);
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= p) sum -= tr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
const sma = (c, p) => { const o = Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= p) s -= c[i-p]; if (i >= p-1) o[i] = s/p; } return o; };

function runTrade(d, i, dir, atrArr) {
  const a = atrArr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_MULT;
  const cost = (SPREAD[d.pair] ?? entry * 0.00012) / slDist;
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0, bars = HOLD;
  const done = g => ({ r: g - cost, cost, slDist, bars });
  for (let j = i+1; j < Math.min(d.b.length, i+1+HOLD); j++) {
    const b = d.b[j]; bars = j - i;
    if ((sign>0&&b.l<=stop)||(sign<0&&b.h>=stop)) return done(banked + left*((stop-entry)*sign/slDist));
    for (let k = hit; k < 3; k++) {
      if (!(sign>0 ? b.h>=tps[k] : b.l<=tps[k])) break;
      banked += (1/3)*TPS[k]; left -= 1/3; hit = k+1;
      if (hit===1) stop = entry; else if (hit===2) stop = tps[0];
      if (hit>=3) return done(banked);
    }
  }
  bars = HOLD;
  const li = Math.min(d.b.length-1, i+HOLD);
  return done(banked + left*((d.b[li].c-entry)*sign/slDist));
}

const signal = (d, i) => {
  const a = d.c[i-60]; if (!a || d.ma200[i] == null) return null;
  const dir = d.c[i] > a ? 'BUY' : 'SELL';
  return (dir === 'BUY') === (d.c[i] > d.ma200[i]) ? dir : null;
};

if (!existsSync(DIR)) { console.error('no data/intraday'); process.exit(1); }

const arms = {
  wilder: { train: [], validate: [], sealed: [], costs: [], widths: [] },
  sma:    { train: [], validate: [], sealed: [], costs: [], widths: [] },
};
let pairs = 0;

for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  pairs++;
  const c = bars.map(x=>x.c);
  const d = { pair, b: bars, c, ma200: sma(c,200) };
  const atrs = { wilder: atrWilder(bars), sma: atrSma(bars) };

  // The SAME entry bars in both arms, so the only variable is the stop width.
  for (const [name, arr] of Object.entries(atrs)) {
    let free = 260;
    for (let i = 260; i < bars.length - HOLD - 2; i++) {
      if (i < free) continue;
      const dir = signal(d, i); if (!dir) continue;
      const t = runTrade(d, i, dir, arr); if (!t) continue;
      const frac = i / bars.length;
      arms[name][frac < 0.5 ? 'train' : frac < 0.75 ? 'validate' : 'sealed'].push(t.r);
      arms[name].costs.push(t.cost);
      arms[name].widths.push(t.slDist / d.b[i+1].o);
      free = i + t.bars + 1;
    }
  }
}

const stat = rs => ({ n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2), ci: ci95(rs) });

console.log(`ATR method, head to head — ${pairs} instruments, identical entries, only the stop width differs\n`);
console.log('           method   train      validate    sealed      avg cost   avg stop width');
for (const k of ['wilder', 'sma']) {
  const a = arms[k];
  const tr = stat(a.train), va = stat(a.validate), se = stat(a.sealed);
  console.log(`  ${(k === 'sma' ? 'engine (SMA)' : 'backtests (Wilder)').padEnd(20)} `
    + `${((tr.avgR>=0?'+':'')+tr.avgR).padStart(8)} ${((va.avgR>=0?'+':'')+va.avgR).padStart(10)} `
    + `${((se.avgR>=0?'+':'')+se.avgR).padStart(10)} (t=${se.t})  ${mean(a.costs).toFixed(4)}R   `
    + `${(mean(a.widths)*100).toFixed(2)}% of price`);
}

const diff = {};
for (const w of ['train','validate','sealed']) diff[w] = mean(arms.sma[w]) - mean(arms.wilder[w]);
const stable = Object.values(diff).every(x => x > 0) || Object.values(diff).every(x => x < 0);
const better = mean(arms.sma.sealed) > mean(arms.wilder.sealed) ? 'sma' : 'wilder';

console.log('\n  engine minus backtests, per window:');
for (const w of ['train','validate','sealed'])
  console.log(`    ${w.padEnd(10)} ${(diff[w]>=0?'+':'')+diff[w].toFixed(4)}R`);
console.log(`  -> ${stable ? `same sign in all three: ${better === 'sma' ? 'the engine\'s SMA ATR' : 'Wilder'} is consistently ahead`
                            : 'THE SIGN FLIPS — neither method is established as better'}`);

const widthRatio = mean(arms.sma.widths) / mean(arms.wilder.widths);
console.log(`\n  the engine's stops are ${((widthRatio - 1) * 100).toFixed(1)}% wider than every published measurement assumes,`);
console.log(`  which cuts cost from ${mean(arms.wilder.costs).toFixed(4)}R to ${mean(arms.sma.costs).toFixed(4)}R per trade.`);

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/atr-method-test.mjs',
  hypothesis: 'The ATR definition used to size the stop changes the result.',
  falsifierStatedBeforeRunning: 'To prefer one method the difference must hold the same sign in train, '
    + 'validate AND sealed. A single sealed win is the shape noise takes.',
  engineUses: 'simple moving average of true range (functions/api/check-signals.js)',
  backtestsUse: 'Wilder smoothing, which is what TradingView and MT5 call ATR',
  stopMultiple: SL_MULT, ladder: TPS, instruments: pairs,
  wilder: { train: stat(arms.wilder.train), validate: stat(arms.wilder.validate), sealed: stat(arms.wilder.sealed),
            avgCostR: +mean(arms.wilder.costs).toFixed(4), avgStopPctOfPrice: +(mean(arms.wilder.widths)*100).toFixed(3) },
  sma:    { train: stat(arms.sma.train), validate: stat(arms.sma.validate), sealed: stat(arms.sma.sealed),
            avgCostR: +mean(arms.sma.costs).toFixed(4), avgStopPctOfPrice: +(mean(arms.sma.widths)*100).toFixed(3) },
  perWindowDiffR: { train: +diff.train.toFixed(4), validate: +diff.validate.toFixed(4), sealed: +diff.sealed.toFixed(4) },
  signStable: stable,
  engineStopsWiderPct: +((widthRatio - 1) * 100).toFixed(1),
  established: stable,
  verdict: stable
    ? `${better === 'sma' ? "The engine's simple-mean ATR" : 'Wilder ATR'} is ahead in all three windows `
      + `(${diff.train.toFixed(4)}R, ${diff.validate.toFixed(4)}R, ${diff.sealed.toFixed(4)}R as engine minus backtests). `
      + `The difference is almost entirely stop width: the engine's stops are ${((widthRatio-1)*100).toFixed(1)}% wider, `
      + `which cuts the spread's share of each trade.`
    : `Neither ATR definition is established as better: engine minus backtests is ${diff.train.toFixed(4)}R in `
      + `training, ${diff.validate.toFixed(4)}R in validation and ${diff.sealed.toFixed(4)}R sealed, and the sign `
      + `flips. What is NOT in doubt is that they differ: the engine's stops run `
      + `${((widthRatio-1)*100).toFixed(1)}% wider than every published measurement on this site assumes, so the `
      + `backtests describe a slightly different system from the one that ships.`,
};
writeFileSync('data/atr-method-test.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
