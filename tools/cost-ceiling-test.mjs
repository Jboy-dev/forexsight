#!/usr/bin/env node
/**
 * cost-ceiling-test.mjs — refuse the trades you cannot afford.
 *
 * The cost audit found that on sealed data this strategy grosses +0.032R and
 * nets +0.0027R. The spread takes 91.6% of it. That is not a failure to find
 * edge; it is a failure to keep any.
 *
 * So: refuse a signal when the spread is too large a share of the stop distance.
 * This is categorically different from every filter that has failed here. It
 *   - selects on a quantity known BEFORE the trade (spread / stop distance),
 *     never on past returns, so it cannot be selection on the outcome;
 *   - is dynamic, not a market blacklist. The same pair passes on a wide-range
 *     day and is refused on a quiet one, because the denominator moves.
 *
 * The obvious confound: a low cost ratio means a wide stop, which means high
 * ATR. If high-volatility periods simply pay better, the ceiling is just a
 * volatility filter wearing a cost filter's clothes. So every ceiling is run
 * against an ATR-percentile control arm admitting the SAME NUMBER of trades.
 * If the cost arm does not beat the volatility arm, it is the volatility doing
 * the work and the cost story is wrong.
 *
 * Falsifier, stated before running: the sign must hold in train, validate AND
 * sealed, and the cost arm must beat its matched volatility control.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const DIR = 'data/intraday', SUFFIX = '.1h.json';
const HOLD = 240, SL_MULT = 3.0, TPS = [1.2, 2.0, 3.5];
const CEILINGS = [0.005, 0.0075, 0.01, 0.015, 0.02, 0.025, 0.03, Infinity];

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

function atrSeries(b, p = 14) {
  const out = Array(b.length).fill(null); let acc = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
    if (i <= p) { acc += tr; if (i === p) out[i] = acc / p; } else out[i] = (out[i-1]*(p-1)+tr)/p;
  }
  return out;
}
const sma = (c, p) => { const o = Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= p) s -= c[i-p]; if (i >= p-1) o[i] = s/p; } return o; };

function runTrade(d, i, dir) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_MULT;
  const spread = SPREAD[d.pair] ?? entry * 0.00012;
  const cost = spread / slDist;
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0, bars = HOLD;
  const done = g => ({ r: g - cost, cost, atrPct: a / entry, bars });
  for (let j = i+1; j < Math.min(d.b.length, i+1+HOLD); j++) {
    const b = d.b[j]; bars = j - i;
    if ((sign>0&&b.l<=stop)||(sign<0&&b.h>=stop))
      return done(banked + left*((stop-entry)*sign/slDist));
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

// One pass. Every trade recorded once with its cost and its volatility, so each
// arm is a different way of reading the SAME trades rather than a fresh search.
const all = [];
for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  const c = bars.map(x=>x.c);
  const d = { pair, b: bars, c, atr: atrSeries(bars), ma200: sma(c,200) };
  let free = 260;
  for (let i = 260; i < bars.length - HOLD - 2; i++) {
    if (i < free) continue;
    const dir = signal(d, i); if (!dir) continue;
    const t = runTrade(d, i, dir); if (!t) continue;
    const frac = i / bars.length;
    all.push({ pair, r: t.r, cost: t.cost, atrPct: t.atrPct,
               win: frac < 0.5 ? 'train' : frac < 0.75 ? 'validate' : 'sealed' });
    free = i + t.bars + 1;
  }
}
console.log(`${all.length} trades priced, ${new Set(all.map(t=>t.pair)).size} instruments\n`);

const byWin = w => all.filter(t => t.win === w);
const stat = rs => ({ n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2), ci: ci95(rs),
  winRate: rs.length ? +(rs.filter(r=>r>0).length/rs.length*100).toFixed(1) : null });

// ATR control: admit the same count by taking the highest-ATR trades, per window.
function atrControl(pool, keepN) {
  return [...pool].sort((a,b)=>b.atrPct-a.atrPct).slice(0, keepN).map(t=>t.r);
}

const results = [];
console.log('  ceiling    kept      train      validate     sealed    | ATR control (same n)  | stable?');
for (const ceil of CEILINGS) {
  const arms = {}, ctrl = {};
  for (const w of ['train','validate','sealed']) {
    const pool = byWin(w);
    const kept = pool.filter(t => t.cost <= ceil);
    arms[w] = stat(kept.map(t=>t.r));
    ctrl[w] = stat(atrControl(pool, kept.length));
  }
  const keptPct = +(arms.train.n + arms.validate.n + arms.sealed.n) / all.length * 100;
  const stable = ['train','validate','sealed'].every(w => arms[w].avgR > 0);
  const beatsCtrl = arms.sealed.avgR > ctrl.sealed.avgR;
  const label = ceil === Infinity ? 'none' : (ceil*100).toFixed(2)+'%';
  results.push({ ceilingPctOfStop: ceil === Infinity ? null : +(ceil*100).toFixed(2),
    keptPct: +keptPct.toFixed(1), train: arms.train, validate: arms.validate, sealed: arms.sealed,
    atrControlSealed: ctrl.sealed, signStable: stable, beatsAtrControl: beatsCtrl });
  console.log(`  ${label.padEnd(9)} ${(keptPct.toFixed(0)+'%').padStart(4)}  `
    + `${((arms.train.avgR>=0?'+':'')+arms.train.avgR).padStart(9)}  `
    + `${((arms.validate.avgR>=0?'+':'')+arms.validate.avgR).padStart(9)}  `
    + `${((arms.sealed.avgR>=0?'+':'')+arms.sealed.avgR).padStart(9)} (t=${String(arms.sealed.t).padStart(5)}) | `
    + `${((ctrl.sealed.avgR>=0?'+':'')+ctrl.sealed.avgR).padStart(9)} ${beatsCtrl?'cost wins':'ATR wins '} | `
    + `${stable?'YES':'no'}`);
}

const passing = results.filter(r => r.signStable && r.beatsAtrControl && r.ceilingPctOfStop != null
  && r.sealed.ci && r.sealed.ci[0] > 0);
const baseline = results.find(r => r.ceilingPctOfStop == null);

console.log(`\n  baseline, no ceiling: sealed ${(baseline.sealed.avgR>=0?'+':'')+baseline.sealed.avgR}R`
  + ` t=${baseline.sealed.t} CI ${baseline.sealed.ci?'['+baseline.sealed.ci.join(', ')+']':'—'}`);
console.log(`  ceilings that are positive in all three windows, beat their ATR control, and whose sealed`);
console.log(`  interval excludes zero: ${passing.length} of ${CEILINGS.length - 1}`);
for (const p of passing)
  console.log(`    <=${p.ceilingPctOfStop}% of stop: sealed ${(p.sealed.avgR>=0?'+':'')+p.sealed.avgR}R `
    + `t=${p.sealed.t} CI [${p.sealed.ci.join(', ')}] n=${p.sealed.n}, keeps ${p.keptPct}% of trades`);

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/cost-ceiling-test.mjs',
  hypothesis: 'Refusing signals whose spread is too large a share of the stop distance raises net return.',
  whyNotSelection: 'The filter reads spread / stop distance, both known at signal time, never past returns.',
  confoundControlled: 'Each ceiling is matched against the highest-ATR trades in the same window, same count, '
    + 'because a low cost ratio implies a wide stop implies high volatility.',
  falsifierStatedBeforeRunning: 'Sign must hold in train, validate and sealed, and the cost arm must beat its '
    + 'matched volatility control.',
  stopMultiple: SL_MULT, ladder: TPS, totalTrades: all.length,
  baselineSealed: baseline.sealed, results, passingCeilings: passing.map(p => p.ceilingPctOfStop),
  established: passing.length > 0,
  verdict: passing.length > 0
    ? `A cost ceiling survives: ${passing.length} of ${CEILINGS.length - 1} thresholds are positive in all `
      + `three windows, beat a volatility-matched control, and have a sealed interval excluding zero. `
      + `Tightest passing: <=${passing[0].ceilingPctOfStop}% of stop distance, sealed `
      + `${passing[0].sealed.avgR}R at t=${passing[0].sealed.t} on ${passing[0].sealed.n} trades. `
      + `Baseline with no ceiling was ${baseline.sealed.avgR}R at t=${baseline.sealed.t}.`
    : `No cost ceiling clears the stated falsifier. Baseline sealed ${baseline.sealed.avgR}R at `
      + `t=${baseline.sealed.t}. Spread is demonstrably eating the gross, but refusing the dear trades does `
      + `not reliably recover it: ${results.filter(r=>r.signStable&&r.ceilingPctOfStop!=null).length} `
      + `threshold(s) held sign across all three windows and `
      + `${results.filter(r=>r.beatsAtrControl&&r.ceilingPctOfStop!=null).length} beat the volatility control.`,
};
writeFileSync('data/cost-ceiling-test.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
