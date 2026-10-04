#!/usr/bin/env node
/**
 * cost-audit.mjs — the one lever in this system that is arithmetic, not statistics.
 *
 * Every hypothesis about WHICH trade to take has failed a sealed test: 288
 * entry/filter/stop combinations, a pre-specified trend-alignment family test,
 * 120 exit schemes, the confidence score, per-chart search. Entry prediction is
 * exhausted. But cost is not a prediction. It is division:
 *
 *     cost_in_R = spread / stop_distance
 *
 * Widening the engine's stop from 1.75x ATR to 3.0x ATR is what moved the sealed
 * result from -0.0302R to +0.0140R, and it did so without predicting anything.
 * It just stopped paying so much to get in.
 *
 * So this audits the bill. Per instrument: what the trades make BEFORE costs,
 * what the spread takes, and what is left. A market whose spread eats most of
 * its gross is not a market this engine should be quoting, and that judgement
 * needs no holdout, because the numerator and the denominator are both known at
 * signal time. The gross figure still needs a holdout, and gets one.
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

// Gross trade: identical ladder, cost deliberately NOT subtracted.
function grossTrade(d, i, dir) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_MULT;
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0;
  for (let j = i+1; j < Math.min(d.b.length, i+1+HOLD); j++) {
    const b = d.b[j];
    if ((sign>0&&b.l<=stop)||(sign<0&&b.h>=stop))
      return { gross: banked + left*((stop-entry)*sign/slDist), slDist, entry, bars: j-i };
    for (let k = hit; k < 3; k++) {
      if (!(sign>0 ? b.h>=tps[k] : b.l<=tps[k])) break;
      banked += (1/3)*TPS[k]; left -= 1/3; hit = k+1;
      if (hit===1) stop = entry; else if (hit===2) stop = tps[0];
      if (hit>=3) return { gross: banked, slDist, entry, bars: j-i };
    }
  }
  const li = Math.min(d.b.length-1, i+HOLD);
  return { gross: banked + left*((d.b[li].c-entry)*sign/slDist), slDist, entry, bars: HOLD };
}

// The engine's own shape: momentum with trend agreement. Not tuned here — the
// point is to price a fixed strategy, not to search for a better one.
const signal = (d, i) => {
  const a = d.c[i-60]; if (!a || d.ma200[i] == null) return null;
  const dir = d.c[i] > a ? 'BUY' : 'SELL';
  return (dir === 'BUY') === (d.c[i] > d.ma200[i]) ? dir : null;
};

if (!existsSync(DIR)) { console.error('no data/intraday'); process.exit(1); }

const rows = [];
const allGross = { train: [], validate: [], sealed: [] }, allNet = { train: [], validate: [], sealed: [] };

for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  const c = bars.map(x=>x.c);
  const d = { pair, b: bars, c, atr: atrSeries(bars), ma200: sma(c,200) };

  const g = [], costs = [], n = [], gS = [], nS = [];
  let free = 260;
  for (let i = 260; i < bars.length - HOLD - 2; i++) {
    if (i < free) continue;
    const dir = signal(d, i); if (!dir) continue;
    const t = grossTrade(d, i, dir); if (!t) continue;
    const spread = SPREAD[pair] ?? t.entry * 0.00012;
    const cost = spread / t.slDist;
    g.push(t.gross); costs.push(cost); n.push(t.gross - cost);
    const frac = i / bars.length, w = frac < 0.5 ? 'train' : frac < 0.75 ? 'validate' : 'sealed';
    allGross[w].push(t.gross); allNet[w].push(t.gross - cost);
    if (w === 'sealed') { gS.push(t.gross); nS.push(t.gross - cost); }
    free = i + t.bars + 1;
  }
  if (n.length < 60) continue;

  const mg = mean(g), mc = mean(costs), mn = mean(n);
  rows.push({
    pair, trades: n.length,
    grossR: +mg.toFixed(4), costR: +mc.toFixed(4), netR: +mn.toFixed(4),
    costAsPctOfGross: mg > 0 ? +(mc / mg * 100).toFixed(1) : null,
    spreadAsPctOfStop: +(mc * 100).toFixed(2),
    sealedGrossR: +mean(gS).toFixed(4), sealedNetR: +mean(nS).toFixed(4), sealedTrades: nS.length,
    netT: +tstat(n).toFixed(2),
  });
}

rows.sort((a, b) => b.spreadAsPctOfStop - a.spreadAsPctOfStop);

console.log('cost audit — what the spread actually takes, per instrument\n');
console.log('  pair        trades   gross      cost     net     cost as % of stop   % of gross eaten');
for (const r of rows)
  console.log(`  ${r.pair.padEnd(10)} ${String(r.trades).padStart(6)}  `
    + `${(r.grossR>=0?'+':'')+r.grossR.toFixed(4)}  ${('-'+Math.abs(r.costR).toFixed(4)).padStart(8)}  `
    + `${((r.netR>=0?'+':'')+r.netR.toFixed(4)).padStart(8)}  ${(r.spreadAsPctOfStop+'%').padStart(14)}  `
    + `${r.costAsPctOfGross == null ? '      (gross<=0)' : (r.costAsPctOfGross+'%').padStart(14)}`);

const stat = a => ({ n: a.length, avgR: +mean(a).toFixed(4), t: +tstat(a).toFixed(2), ci: ci95(a) });
console.log('\n  pooled, all instruments:');
for (const w of ['train','validate','sealed']) {
  const G = stat(allGross[w]), N = stat(allNet[w]);
  console.log(`    ${w.padEnd(10)} gross ${(G.avgR>=0?'+':'')+G.avgR}R   net ${(N.avgR>=0?'+':'')+N.avgR}R   `
    + `cost ${(G.avgR-N.avgR).toFixed(4)}R   net t=${N.t}  CI ${N.ci?'['+N.ci.join(', ')+']':'—'}  n=${N.n}`);
}

const sealedG = stat(allGross.sealed), sealedN = stat(allNet.sealed);
const costShare = sealedG.avgR > 0 ? (sealedG.avgR - sealedN.avgR) / sealedG.avgR * 100 : null;
const dearest = rows.slice(0, 5).map(r => r.pair);

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/cost-audit.mjs',
  question: 'How much of this strategy\'s gross return does the spread take, and where?',
  stopMultiple: SL_MULT, ladder: TPS, perInstrument: rows,
  pooled: { train: { gross: stat(allGross.train), net: stat(allNet.train) },
            validate: { gross: stat(allGross.validate), net: stat(allNet.validate) },
            sealed: { gross: sealedG, net: sealedN } },
  sealedCostShareOfGrossPct: costShare == null ? null : +costShare.toFixed(1),
  dearestInstruments: dearest,
  method: 'One fixed strategy (60-bar momentum, trend-agreeing), priced rather than searched. Gross is the '
        + 'managed ladder with no cost subtracted; cost is spread divided by stop distance, which is known at '
        + 'signal time. Non-overlapping trades, stop checked before targets, last quarter of each series sealed.',
  verdict: `Gross ${sealedG.avgR}R per trade on sealed data, net ${sealedN.avgR}R after `
    + `${(sealedG.avgR - sealedN.avgR).toFixed(4)}R of spread`
    + `${costShare != null ? ` — the spread takes ${costShare.toFixed(1)}% of the gross` : ''}. `
    + `Dearest relative to their stops: ${dearest.join(', ')}. `
    + `Cost is the only quantity here that is known before the trade rather than hoped for after it.`,
};
writeFileSync('data/cost-audit.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
