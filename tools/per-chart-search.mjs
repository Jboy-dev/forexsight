#!/usr/bin/env node
/**
 * per-chart-search.mjs — every chart tested on its own.
 *
 * The pooled search asks "does this rule work across the market". This asks
 * the different question: does it work on THIS instrument. A pooled null can
 * hide a single chart that genuinely trends, and a trader does not trade the
 * pool — they trade one chart.
 *
 * THE COST OF ASKING. Testing 19 instruments x 72 combinations x 3 timeframes
 * is 4,104 hypotheses. At the usual 5% bar roughly 205 of them pass by luck
 * alone. So the bar is corrected for EVERY hypothesis in the whole sweep, not
 * per instrument — correcting per instrument would be the same mistake as not
 * correcting at all, just better disguised.
 *
 * Same discipline as the pooled search: entry at the next open, the managed
 * ladder, costs charged, stop checked before targets within a bar,
 * non-overlapping trades, and a sealed final quarter opened once.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const TFS = [
  { id: 'daily', dir: 'data/deep', suffix: '.json', hold: 120 },
  { id: '1h', dir: 'data/intraday', suffix: '.1h.json', hold: 240 },
  { id: '15m', dir: 'data/intraday', suffix: '.15m.json', hold: 480 },
];
const SL_ATR = 1.5, TP1 = 1.2, TP2 = 2.0, TP3 = 3.5, MIN_TRADES = 30;
// Cost in R = spread / stop distance, NOT a flat figure.
//
// Every backtest here charged a flat 0.02R regardless of stop width, which
// penalised wide stops exactly as much as tight ones and biased the whole
// search toward stops that pay the spread more often per unit of risk.
// Correcting it changed which exit schemes win, and moved the engine's sealed
// result from -0.0302R to +0.0140R.
const SPREAD = {
  'EUR/USD': 0.00008, 'GBP/USD': 0.00011, 'AUD/USD': 0.00010, 'NZD/USD': 0.00014,
  'USD/CAD': 0.00012, 'USD/CHF': 0.00011, 'EUR/GBP': 0.00011,
  'USD/JPY': 0.009,   'EUR/JPY': 0.013,   'GBP/JPY': 0.018,   'AUD/JPY': 0.013,
  'XAU/USD': 0.28,    'XAG/USD': 0.018,
  'BTC/USD': 22,      'ETH/USD': 1.6,     'SOL/USD': 0.09,    'XRP/USD': 0.0016,
  'US30': 2.2,        'NAS100': 1.6,
};
function costInR(pair, price, slDist) {
  if (!(slDist > 0)) return 0.02;
  const spread = SPREAD[pair] != null ? SPREAD[pair] : price * 0.00012;
  return spread / slDist;
}


const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };

function normInv(p) {
  const a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.3577518672690,-30.66479806614716,2.506628277459239];
  const b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
  const c=[-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
  const d=[0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
  const pl=0.02425;
  if (p<pl){const q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if (p<=1-pl){const q=p-0.5,r=q*q;return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
  const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

function atrSeries(b, p = 14) {
  const out = Array(b.length).fill(null); let acc = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
    if (i <= p) { acc += tr; if (i === p) out[i] = acc / p; } else out[i] = (out[i-1] * (p-1) + tr) / p;
  }
  return out;
}
const sma = (c, p) => { const o = Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= p) s -= c[i-p]; if (i >= p-1) o[i] = s/p; } return o; };
function rsi(c, p = 14) {
  const o = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i]-c[i-1]; d >= 0 ? g += d : l -= d; }
  g /= p; l /= p; o[p] = 100 - 100/(1 + g/(l||1e-9));
  for (let i = p+1; i < c.length; i++) { const d = c[i]-c[i-1];
    g = (g*(p-1)+Math.max(d,0))/p; l = (l*(p-1)+Math.max(-d,0))/p; o[i] = 100-100/(1+g/(l||1e-9)); }
  return o;
}
const pctRank = (arr, i, look) => { const lo = Math.max(0, i-look); let b = 0, n = 0;
  for (let j = lo; j < i; j++) { if (arr[j] == null) continue; n++; if (arr[j] < arr[i]) b++; } return n ? b/n : 0.5; };

const ENTRIES = {
  'momentum-60':   (d,i)=>{const a=d.c[i-60];return a?(d.c[i]>a?'BUY':'SELL'):null;},
  'momentum-120':  (d,i)=>{const a=d.c[i-120];return a?(d.c[i]>a?'BUY':'SELL'):null;},
  'ma-cross-20-50':(d,i)=>{if(d.ma20[i]==null||d.ma50[i]==null||d.ma20[i-1]==null)return null;
                           const n=d.ma20[i]>d.ma50[i],w=d.ma20[i-1]>d.ma50[i-1];return n!==w?(n?'BUY':'SELL'):null;},
  'rsi-reversion': (d,i)=>{const r=d.rsi[i];return r==null?null:r<30?'BUY':r>70?'SELL':null;},
  'rsi-trend':     (d,i)=>{const r=d.rsi[i];return r==null?null:r>60?'BUY':r<40?'SELL':null;},
  'donchian-20':   (d,i)=>{let hi=-Infinity,lo=Infinity;for(let j=i-20;j<i;j++){if(d.b[j].h>hi)hi=d.b[j].h;if(d.b[j].l<lo)lo=d.b[j].l;}
                           return d.c[i]>hi?'BUY':d.c[i]<lo?'SELL':null;},
  'pullback-trend':(d,i)=>{if(d.ma50[i]==null||d.rsi[i]==null)return null;const up=d.c[i]>d.ma50[i];
                           if(up&&d.rsi[i]<45)return 'BUY'; if(!up&&d.rsi[i]>55)return 'SELL'; return null;},
};
const FILTERS = {
  'none':        ()=>true,
  'vol-high':    (d,i)=>pctRank(d.atr,i,252)>0.66,
  'vol-low':     (d,i)=>pctRank(d.atr,i,252)<0.34,
  'with-200':    (d,i,dir)=>d.ma200[i]!=null&&((dir==='BUY')===(d.c[i]>d.ma200[i])),
  'against-200': (d,i,dir)=>d.ma200[i]!=null&&((dir==='BUY')!==(d.c[i]>d.ma200[i])),
  'expanding':   (d,i)=>d.atr[i]!=null&&d.atr[i-5]!=null&&d.atr[i]>d.atr[i-5],
};

function runTrade(d, i, dir, hold) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_ATR;
  const sl = entry - sign*slDist;
  const t1 = entry+sign*slDist*TP1, t2 = entry+sign*slDist*TP2, t3 = entry+sign*slDist*TP3;
  let banked = 0, left = 1, stop = sl, hit = 0;
  for (let j = i+1; j < Math.min(d.b.length, i+1+hold); j++) {
    const bar = d.b[j];
    // Stop first: within one bar the adverse touch cannot be ruled out, and
    // assuming the favourable one came first manufactures returns.
    if ((dir==='BUY'&&bar.l<=stop)||(dir==='SELL'&&bar.h>=stop)) {
      banked += left*((stop-entry)*sign/slDist);
      return { r: banked - costInR(d.pair, entry, slDist), bars: j-i };
    }
    const reach = l => dir==='BUY' ? bar.h>=l : bar.l<=l;
    if (hit<1 && reach(t1)) { banked += (1/3)*TP1; left -= 1/3; stop = entry; hit = 1; }
    if (hit<2 && reach(t2)) { banked += (1/3)*TP2; left -= 1/3; stop = t1;    hit = 2; }
    if (hit<3 && reach(t3)) { banked += left*TP3;  left = 0;                  hit = 3;
      return { r: banked - costInR(d.pair, entry, slDist), bars: j-i }; }
  }
  const last = d.b[Math.min(d.b.length-1, i+hold)];
  banked += left*((last.c-entry)*sign/slDist);
  return { r: banked - costInR(d.pair, entry, slDist), bars: hold };
}

function backtest(d, ef, ff, lo, hi, hold) {
  const rs = [];
  const a = Math.max(210, Math.floor(d.b.length*lo));
  const z = Math.min(d.b.length-2, Math.floor(d.b.length*hi));
  let free = a;
  for (let i = a; i < z; i++) {
    if (i < free) continue;
    const dir = ef(d, i); if (!dir) continue;
    if (!ff(d, i, dir)) continue;
    const t = runTrade(d, i, dir, hold); if (!t) continue;
    rs.push(t.r); free = i + t.bars + 1;
  }
  return rs;
}

/* ── count every hypothesis in the whole sweep, then set the bar once ────── */
const combos = [];
for (const [en, ef] of Object.entries(ENTRIES)) for (const [fn, ff] of Object.entries(FILTERS)) combos.push({ name: `${en} × ${fn}`, ef, ff });

const sets = [];
for (const tf of TFS) {
  if (!existsSync(tf.dir)) continue;
  for (const f of readdirSync(tf.dir).filter(x => x.endsWith(tf.suffix))) {
    const bars = JSON.parse(readFileSync(`${tf.dir}/${f}`, 'utf8'))
      .filter(x => x && [x.o,x.h,x.l,x.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
    if (bars.length < 900) continue;
    const c = bars.map(x => x.c);
    sets.push({ tf: tf.id, hold: tf.hold, pair: f.replace(tf.suffix,'').replace('-','/'),
                b: bars, c, atr: atrSeries(bars), rsi: rsi(c), ma20: sma(c,20), ma50: sma(c,50), ma200: sma(c,200) });
  }
}

const HYP = sets.length * combos.length;
const BAR = Math.abs(normInv(1 - 0.05/(2*HYP)));
console.log(`per-chart search: ${sets.length} chart/timeframe pairs x ${combos.length} combinations = ${HYP.toLocaleString()} hypotheses`);
console.log(`  at the usual 5% bar, about ${Math.round(HYP*0.05)} would pass by luck alone`);
console.log(`  so the bar is |t| > ${BAR.toFixed(2)}, corrected for the WHOLE sweep\n`);

const results = [];
let tested = 0;
for (const d of sets) {
  for (const c of combos) {
    const tr = backtest(d, c.ef, c.ff, 0, 0.5, d.hold);
    tested++;
    if (tr.length < MIN_TRADES) continue;
    const tT = tstat(tr);
    if (!(tT > 1.5 && mean(tr) > 0)) continue;              // only promising ones cost a validation
    const va = backtest(d, c.ef, c.ff, 0.5, 0.75, d.hold);
    if (va.length < MIN_TRADES/2 || mean(va) <= 0) continue;
    const se = backtest(d, c.ef, c.ff, 0.75, 1.0, d.hold);
    if (se.length < MIN_TRADES/2) continue;
    const sT = tstat(se);
    results.push({
      pair: d.pair, tf: d.tf, combo: c.name,
      train: { n: tr.length, avgR: +mean(tr).toFixed(4), t: +tT.toFixed(2) },
      validate: { n: va.length, avgR: +mean(va).toFixed(4), t: +tstat(va).toFixed(2) },
      sealed: { n: se.length, avgR: +mean(se).toFixed(4), t: +sT.toFixed(2) },
      passes: Math.abs(sT) > BAR && mean(se) > 0,
    });
  }
}

results.sort((a,b) => b.sealed.t - a.sealed.t);
const passed = results.filter(r => r.passes);

console.log(`  ${tested.toLocaleString()} backtests run`);
console.log(`  ${results.length} survived training AND validation on their own chart`);
console.log(`  ${passed.length} cleared the sealed test at the corrected bar\n`);

if (results.length) {
  console.log('  Best survivors, by their SEALED result (the only number not available when chosen):');
  for (const r of results.slice(0, 10)) {
    console.log(`    ${(r.pair+' '+r.tf).padEnd(16)} ${r.combo.padEnd(28)} train t=${String(r.train.t).padStart(5)}  valid t=${String(r.validate.t).padStart(5)}  SEALED ${(r.sealed.avgR>=0?'+':'')+r.sealed.avgR.toFixed(4)}R t=${String(r.sealed.t).padStart(5)} ${r.passes?'PASSES':''}`);
  }
}

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/per-chart-search.mjs',
  chartsTested: sets.length, combinations: combos.length, hypotheses: HYP,
  correctedBarT: +BAR.toFixed(2), backtestsRun: tested,
  survivedTrainAndValidate: results.length, passedSealed: passed.length,
  passed, top: results.slice(0, 25),
  method: 'Each instrument and timeframe tested on its own. Entry at next open, v442 managed ladder, '
        + 'costs charged, stop checked before targets within a bar, non-overlapping trades, '
        + 'three-way split with the newest 25% opened once. The significance bar is corrected for '
        + 'EVERY hypothesis in the sweep, not per chart — correcting per chart would be the same '
        + 'mistake as not correcting, only better disguised.',
  verdict: passed.length
    ? `${passed.length} chart/strategy pairing cleared a bar corrected for ${HYP.toLocaleString()} hypotheses.`
    : `No individual chart has a strategy that survives its own sealed test at a bar corrected for `
      + `${HYP.toLocaleString()} hypotheses. ${results.length} looked good through training and validation `
      + `and then did not hold — which is what overfitting looks like when you search hard enough.`,
};
writeFileSync('data/per-chart-search.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
