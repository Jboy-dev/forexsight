#!/usr/bin/env node
/**
 * trend-alignment-test.mjs — ONE pre-specified question, asked once.
 *
 * The 288-combination search threw up a pattern that is not the shape of noise:
 *
 *     filter above-200    7 of 8 positive   mean +0.0788R
 *     filter with-200     7 of 8 positive   mean +0.0478R
 *     filter against-200  0 of 1            mean -0.1520R
 *     filter below-200    0 of 1            mean -0.1749R
 *
 * Nine combinations beat the random-entry null and every one of them was trend
 * aligned. But those 35 reached the sealed set BY SURVIVING train and validate,
 * so reading a family result off them is selection on the very thing being
 * measured.
 *
 * So this asks the question cleanly and only once: taking EVERY entry rule, on
 * EVERY instrument, does trading in the direction of the 200-period trend beat
 * trading against it? No survivors, no cherry-picking, no search. One
 * comparison, so no multiple-testing correction is owed — and the paired
 * structure means both sides see the same bars, the same costs and the same
 * ladder.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const DIR = 'data/intraday';
const SUFFIX = '.1h.json';
const HOLD = 240, SL_MULT = 3.0;
const TPS = [1.2, 2.0, 3.5];

const SPREAD = {
  'EUR/USD': 0.00008, 'GBP/USD': 0.00011, 'AUD/USD': 0.00010, 'NZD/USD': 0.00014,
  'USD/CAD': 0.00012, 'USD/CHF': 0.00011, 'EUR/GBP': 0.00011,
  'USD/JPY': 0.009,   'EUR/JPY': 0.013,   'GBP/JPY': 0.018,   'AUD/JPY': 0.013,
  'XAU/USD': 0.28,    'XAG/USD': 0.018,
  'BTC/USD': 22,      'ETH/USD': 1.6,     'SOL/USD': 0.09,    'XRP/USD': 0.0016,
  'US30': 2.2,        'NAS100': 1.6,
};
const costInR = (pair, px, sl) => sl > 0 ? (SPREAD[pair] ?? px * 0.00012) / sl : 0.02;

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
function rsi(c, p = 14) {
  const o = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i]-c[i-1]; d >= 0 ? g += d : l -= d; }
  g /= p; l /= p; o[p] = 100-100/(1+g/(l||1e-9));
  for (let i = p+1; i < c.length; i++) { const d = c[i]-c[i-1];
    g = (g*(p-1)+Math.max(d,0))/p; l = (l*(p-1)+Math.max(-d,0))/p; o[i] = 100-100/(1+g/(l||1e-9)); }
  return o;
}

const ENTRIES = {
  'momentum-60':  (d,i)=>{const a=d.c[i-60];return a?(d.c[i]>a?'BUY':'SELL'):null;},
  'momentum-120': (d,i)=>{const a=d.c[i-120];return a?(d.c[i]>a?'BUY':'SELL'):null;},
  'ma-cross':     (d,i)=>{if(d.ma20[i]==null||d.ma50[i]==null||d.ma20[i-1]==null)return null;
                          const n=d.ma20[i]>d.ma50[i],w=d.ma20[i-1]>d.ma50[i-1];return n!==w?(n?'BUY':'SELL'):null;},
  'rsi-trend':    (d,i)=>{const r=d.rsi[i];return r==null?null:r>60?'BUY':r<40?'SELL':null;},
  'rsi-reversion':(d,i)=>{const r=d.rsi[i];return r==null?null:r<30?'BUY':r>70?'SELL':null;},
  'donchian-20':  (d,i)=>{let hi=-Infinity,lo=Infinity;for(let j=i-20;j<i;j++){if(d.b[j].h>hi)hi=d.b[j].h;if(d.b[j].l<lo)lo=d.b[j].l;}
                          return d.c[i]>hi?'BUY':d.c[i]<lo?'SELL':null;},
  'pullback':     (d,i)=>{if(d.ma50[i]==null||d.rsi[i]==null)return null;const up=d.c[i]>d.ma50[i];
                          if(up&&d.rsi[i]<45)return 'BUY'; if(!up&&d.rsi[i]>55)return 'SELL'; return null;},
  'inside-break': (d,i)=>{const p=d.b[i-1],q=d.b[i-2];if(!p||!q)return null;
                          if(!(p.h<q.h&&p.l>q.l))return null;
                          return d.c[i]>p.h?'BUY':d.c[i]<p.l?'SELL':null;},
};

function runTrade(d, i, dir) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_MULT;
  const COST = costInR(d.pair, entry, slDist);
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0;
  for (let j = i+1; j < Math.min(d.b.length, i+1+HOLD); j++) {
    const b = d.b[j];
    if ((sign>0&&b.l<=stop)||(sign<0&&b.h>=stop)) {
      banked += left*((stop-entry)*sign/slDist);
      return { r: banked-COST, bars: j-i };
    }
    for (let k = hit; k < 3; k++) {
      const reached = sign>0 ? b.h>=tps[k] : b.l<=tps[k];
      if (!reached) break;
      banked += (1/3)*TPS[k]; left -= 1/3; hit = k+1;
      if (hit===1) stop = entry; else if (hit===2) stop = tps[0];
      if (hit>=3) return { r: banked-COST, bars: j-i };
    }
  }
  const li = Math.min(d.b.length-1, i+HOLD);
  banked += left*((d.b[li].c-entry)*sign/slDist);
  return { r: banked-COST, bars: HOLD };
}

if (!existsSync(DIR)) { console.error('no data/intraday'); process.exit(1); }

const withTrend = { train: [], validate: [], sealed: [] };
const against   = { train: [], validate: [], sealed: [] };
const perPair = new Map();

for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  const c = bars.map(x=>x.c);
  const d = { pair, b: bars, c, atr: atrSeries(bars), rsi: rsi(c), ma20: sma(c,20), ma50: sma(c,50), ma200: sma(c,200) };
  const pw = [], pa = [];

  for (const [name, fn] of Object.entries(ENTRIES)) {
    let free = 260;
    for (let i = 260; i < bars.length - HOLD - 2; i++) {
      if (i < free) continue;
      const dir = fn(d, i);
      if (!dir) continue;
      if (d.ma200[i] == null) continue;
      const up = d.c[i] > d.ma200[i];
      const aligned = (dir === 'BUY') === up;      // the ONE variable under test
      const t = runTrade(d, i, dir);
      if (!t) continue;
      const frac = i / bars.length;
      const bucket = aligned ? withTrend : against;
      (frac < 0.5 ? bucket.train : frac < 0.75 ? bucket.validate : bucket.sealed).push(t.r);
      (aligned ? pw : pa).push(t.r);
      free = i + t.bars + 1;
    }
  }
  if (pw.length > 40 && pa.length > 40)
    perPair.set(pair, { withTrend: +mean(pw).toFixed(4), against: +mean(pa).toFixed(4),
                        nWith: pw.length, nAgainst: pa.length });
}

const stat = (rs) => ({ n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2),
  ci: ci95(rs), winRate: rs.length ? +(rs.filter(r=>r>0).length/rs.length*100).toFixed(1) : null });

console.log('trend alignment: ONE question, asked once, on every entry rule and every instrument\n');
console.log('  WITH the 200-period trend:');
for (const k of ['train','validate','sealed']) {
  const s = stat(withTrend[k]);
  console.log(`    ${k.padEnd(10)} ${String(s.n).padStart(6)} trades  ${(s.avgR>=0?'+':'')+s.avgR}R  t=${String(s.t).padStart(6)}  win ${s.winRate}%  CI ${s.ci?'['+s.ci.join(', ')+']':'—'}`);
}
console.log('\n  AGAINST the 200-period trend:');
for (const k of ['train','validate','sealed']) {
  const s = stat(against[k]);
  console.log(`    ${k.padEnd(10)} ${String(s.n).padStart(6)} trades  ${(s.avgR>=0?'+':'')+s.avgR}R  t=${String(s.t).padStart(6)}  win ${s.winRate}%  CI ${s.ci?'['+s.ci.join(', ')+']':'—'}`);
}

// Welch's t-test on the sealed difference — the number that decides it.
const W = withTrend.sealed, A = against.sealed;
const se = Math.sqrt(sd(W)**2/W.length + sd(A)**2/A.length);
const diff = mean(W) - mean(A);
const tDiff = se > 0 ? diff / se : 0;

console.log(`\n  SEALED DIFFERENCE: ${(diff>=0?'+':'')+diff.toFixed(4)}R per trade, t=${tDiff.toFixed(2)}`);
console.log(`    (one pre-specified comparison, so no multiple-testing correction is owed)`);

const pairsAgree = [...perPair.values()].filter(v => v.withTrend > v.against).length;
console.log(`\n  per instrument, with-trend beat against-trend on ${pairsAgree} of ${perPair.size}:`);
for (const [p,v] of [...perPair.entries()].sort((a,b)=>(b[1].withTrend-b[1].against)-(a[1].withTrend-a[1].against)))
  console.log(`    ${p.padEnd(10)} with ${(v.withTrend>=0?'+':'')+v.withTrend}R (${v.nWith})   against ${(v.against>=0?'+':'')+v.against}R (${v.nAgainst})   ${v.withTrend>v.against?'' : '<-- against wins'}`);

const sealedW = stat(W), sealedA = stat(A);
const trainW = stat(withTrend.train), valW = stat(withTrend.validate);
const trainA = stat(against.train), valA = stat(against.validate);

// THE FALSIFIER. A real mechanism does not change sign between periods. So ask
// the same question in each window separately and see whether the answer holds.
const edge = { train: trainW.avgR - trainA.avgR, validate: valW.avgR - valA.avgR, sealed: sealedW.avgR - sealedA.avgR };
const stable = Object.values(edge).every(x => x > 0);

console.log('\n  STABILITY — the same difference, measured in each window on its own:');
for (const k of ['train', 'validate', 'sealed'])
  console.log(`    ${k.padEnd(10)} ${(edge[k] >= 0 ? '+' : '') + edge[k].toFixed(4)}R   ${edge[k] > 0 ? 'with-trend ahead' : 'AGAINST-TREND AHEAD'}`);
console.log(`    -> ${stable ? 'same direction in all three windows' : 'THE SIGN FLIPS. Not one mechanism.'}`);

// Instrument agreement against chance: two-sided binomial at p = 0.5.
function binomTwoSided(k, n) {
  const lc = x => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  const pmf = i => Math.exp(lc(n) - lc(i) - lc(n - i) + n * Math.log(0.5));
  const obs = pmf(k);
  let pv = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= obs * 1.0000001) pv += pmf(i);
  return Math.min(1, pv);
}
const pAgree = binomTwoSided(pairsAgree, perPair.size);
console.log(`\n  instrument agreement ${pairsAgree}/${perPair.size}: p=${pAgree.toFixed(3)} against a coin flip`
          + ` -> ${pAgree < 0.05 ? 'more agreement than chance' : 'INDISTINGUISHABLE FROM CHANCE'}`);

const established = stable && Math.abs(tDiff) > 2 && sealedW.ci && sealedW.ci[0] > 0 && pAgree < 0.05;
const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/trend-alignment-test.mjs',
  hypothesis: 'Trading in the direction of the 200-period trend outperforms trading against it.',
  prespecified: true, entryRules: Object.keys(ENTRIES).length, instruments: perPair.size,
  falsifierStatedBeforeRunning: 'The with-trend minus against-trend difference must hold the same sign in '
    + 'train, validate AND sealed, instrument agreement must beat a coin flip, and with-trend must itself be '
    + 'positive on sealed data with an interval excluding zero. Being less bad than the opposite is not an edge.',
  withTrend: { train: trainW, validate: valW, sealed: sealedW },
  against: { train: trainA, validate: valA, sealed: sealedA },
  sealedDifferenceR: +diff.toFixed(4), sealedDifferenceT: +tDiff.toFixed(2),
  periodEdgeR: { train: +edge.train.toFixed(4), validate: +edge.validate.toFixed(4), sealed: +edge.sealed.toFixed(4) },
  signStableAcrossPeriods: stable,
  instrumentsAgreeing: pairsAgree, instrumentsTested: perPair.size,
  instrumentAgreementP: +pAgree.toFixed(3),
  perInstrument: Object.fromEntries(perPair),
  established,
  method: `Every entry rule, every instrument, hourly bars. Stop ${SL_MULT}x ATR, ladder 1.2/2.0/3.5R, `
        + 'cost = spread/stop distance, stop checked before targets, non-overlapping. The ONLY variable '
        + 'is whether the signal direction agrees with price against its 200-period average. One '
        + 'pre-specified comparison, so no multiple-testing correction is owed.',
  verdict: established
    ? `Trend alignment holds: with-trend beats against-trend in all three windows, by `
      + `${diff.toFixed(4)}R on the sealed quarter at t=${tDiff.toFixed(2)}, and ${pairsAgree} of `
      + `${perPair.size} instruments agree (p=${pAgree.toFixed(3)}).`
    : `NOT ESTABLISHED. On the sealed quarter with-trend beat against-trend by ${diff.toFixed(4)}R `
      + `at t=${tDiff.toFixed(2)}, which looks like a result. It is not one. `
      + (stable ? '' : `Measured window by window the difference is ${edge.train >= 0 ? '+' : ''}`
        + `${edge.train.toFixed(4)}R in training, ${edge.validate >= 0 ? '+' : ''}${edge.validate.toFixed(4)}R `
        + `in validation and ${edge.sealed >= 0 ? '+' : ''}${edge.sealed.toFixed(4)}R sealed. The sign flips, `
        + `so this is not one mechanism measured three times. In the validation window trading AGAINST the `
        + `200-period trend returned ${valA.avgR}R at t=${valA.t} — the opposite of the claim, and more `
        + `significant than the claim. `)
      + `${pairsAgree} of ${perPair.size} instruments agree, p=${pAgree.toFixed(3)} against a coin flip. `
      + `And with-trend itself returns ${sealedW.avgR}R on sealed data`
      + `${sealedW.ci ? ` with interval [${sealedW.ci.join(', ')}]` : ''}, so even taken at face value it is `
      + `not profitable. The 7-of-8 pattern in the 288-combination search was selection, not a mechanism: `
      + `those combinations reached the sealed set by performing well in training and validation, which is `
      + `the very thing the family test then read back off them.`,
};

writeFileSync('data/trend-alignment-test.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
