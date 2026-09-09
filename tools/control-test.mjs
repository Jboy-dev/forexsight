// v488 — THE TEST THAT MUST FAIL, RUN EVERY CYCLE.
//
// A backtest that only ever confirms itself is worthless. This exists to try to
// destroy the result: it runs the SAME bars through the SAME simulator and
// changes only the entry, replacing the strategy with random times and random
// directions. If random entries score what the strategy scores, the number came
// from the ladder rather than the rule and the strategy claim is void.
//
// This was not academic. The first control I wrote compared real bars against
// synthetic ones, and the "edge" survived on random data — which looked exactly
// like lookahead bias and nearly caused the proven-strategy feature to be pulled.
// The fault was in the synthetic bar generator: it built highs and lows by
// inflating each bar's range multiplicatively, producing wicks far wider than
// real ones, which let a single bar reach several targets. The simulator was
// fine. Comparing like with like — real bars either way — is the test that
// actually discriminates, which is why it is the one kept.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { rsiSeries } from './proven-strategies.mjs';

const MAX_HOLD = 48, ATR_STOP = 1.75, LADDER = [1.2, 2.0, 3.5], W = [1/3, 1/3, 1/3];
const SPREAD = { 'EUR/USD':0.8,'GBP/USD':1.2,'AUD/USD':1.0,'NZD/USD':1.5,'USD/CAD':1.5,
  'USD/CHF':1.4,'USD/JPY':0.9,'XAU/USD':25,'BTC/USD':20,'ETH/USD':15 };
const PIP = p => p==='XAU/USD'?0.1:p.includes('JPY')?0.01:p==='BTC/USD'?1:p==='ETH/USD'?0.1:0.0001;

function atrSeries(b, p = 14) {
  const o = []; let s = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h-b[i].l, Math.abs(b[i].h-b[i-1].c), Math.abs(b[i].l-b[i-1].c));
    if (i <= p) { s += tr; o[i] = i === p ? s/p : null; } else o[i] = (o[i-1]*(p-1)+tr)/p;
  }
  return o;
}
function outcome(bars, i, dir, a, pair) {
  const sp = (SPREAD[pair] ?? 1.5) * PIP(pair), buy = dir === 'BUY', nxt = bars[i+1];
  if (!nxt) return null;
  const entry = buy ? nxt.o + sp/2 : nxt.o - sp/2, slD = a * ATR_STOP;
  if (!(slD > 0)) return null;
  let stop = buy ? entry - slD : entry + slD, reached = 0, banked = 0;
  const tps = LADDER.map(m => buy ? entry + slD*m : entry - slD*m);
  for (let k = i+1; k < Math.min(bars.length, i+1+MAX_HOLD); k++) {
    const b = bars[k];
    if (buy ? b.l <= stop : b.h >= stop) {
      const rem = 1 - W.slice(0, reached).reduce((x,y)=>x+y, 0);
      return { r: banked + rem*(reached===0?-1:reached===1?0:LADDER[0]), at: bars[i].t };
    }
    while (reached < 3 && (buy ? b.h >= tps[reached] : b.l <= tps[reached])) {
      banked += W[reached]*LADDER[reached]; reached++;
      if (reached === 1) stop = entry; else if (reached === 2) stop = tps[0];
    }
    if (reached === 3) return { r: banked, at: bars[i].t };
  }
  const last = bars[Math.min(bars.length, i+1+MAX_HOLD)-1];
  const rem = 1 - W.slice(0, reached).reduce((x,y)=>x+y, 0);
  return { r: banked + rem*((buy?last.c-entry:entry-last.c)/slD), at: bars[i].t };
}
function eps(tr) {
  tr.sort((a,b)=>a.at-b.at); const e = [];
  for (const t of tr) {
    const o = e.find(x => x.pair===t.pair && x.dir===t.dir && (t.at-x.lastAt)/3600000 <= MAX_HOLD);
    if (o) { o.rs.push(t.r); o.lastAt = t.at; } else e.push({pair:t.pair,dir:t.dir,lastAt:t.at,rs:[t.r]});
  }
  return e.map(x => x.rs.reduce((a,b)=>a+b,0)/x.rs.length);
}
const mean = v => v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
function ci(v, n = 2500) {
  if (v.length < 10) return null;
  const s = [];
  for (let i = 0; i < n; i++) { let t = 0; for (let j = 0; j < v.length; j++) t += v[Math.floor(Math.random()*v.length)]; s.push(t/v.length); }
  s.sort((a,b)=>a-b);
  return [+s[Math.floor(.025*n)].toFixed(3), +s[Math.floor(.975*n)].toFixed(3)];
}

const D = [];
for (const f of readdirSync('data/bt').filter(x => x.endsWith('.json'))) {
  const pair = f.replace('.json','').replace('-','/');
  const bars = JSON.parse(readFileSync(`data/bt/${f}`, 'utf8'));
  if (bars.length < 300) continue;
  D.push({ pair, bars, rsi: rsiSeries(bars.map(b=>b.c), 14), atr: atrSeries(bars) });
}
if (!D.length) { console.log('control test skipped — data/bt not present (run the fetch first)'); process.exit(0); }

const strat = [], rand = [];
for (const { pair, bars, rsi, atr } of D) {
  let count = 0;
  for (let i = 210; i < bars.length - MAX_HOLD - 2; i++) {
    const r = rsi[i], p = rsi[i-1];
    if (r == null || p == null) continue;
    let d = null;
    if (p < 30 && r >= 30) d = 'BUY'; else if (p > 70 && r <= 70) d = 'SELL'; else continue;
    const a = atr[i]; if (!a) continue;
    const o = outcome(bars, i, d, a, pair);
    if (o) { strat.push({ pair, dir: d, ...o }); count++; }
  }
  for (let k = 0; k < count; k++) {
    const i = 210 + Math.floor(Math.random() * (bars.length - MAX_HOLD - 215));
    const a = atr[i]; if (!a) continue;
    const d = Math.random() < 0.5 ? 'BUY' : 'SELL';
    const o = outcome(bars, i, d, a, pair);
    if (o) rand.push({ pair, dir: d, ...o });
  }
}
const es = eps(strat), er = eps(rand);
const out = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  strategy: { name: 'RSI mean reversion', n: es.length, avgR: +mean(es).toFixed(3), ci: ci(es) },
  randomEntries: { n: er.length, avgR: +mean(er).toFixed(3), ci: ci(er) },
  edgeOverRandom: +(mean(es) - mean(er)).toFixed(3),
  // The claim only stands while random entries score about nothing AND the
  // strategy clears them.
  passes: !!(ci(er) && ci(er)[0] < 0 && ci(er)[1] > 0 && ci(es) && ci(es)[0] > 0),
};
out.verdict = out.passes
  ? `Random entries score ${out.randomEntries.avgR}R with an interval straddling zero, as they must. `
    + `The rule adds ${out.edgeOverRandom}R over them.`
  : 'CONTROL FAILED — random entries did not score about zero, so the simulator, not the '
    + 'strategy, is producing the number. The strategy claim must not be shown.';
writeFileSync('data/control-test.json', JSON.stringify(out, null, 2));
console.log(`  strategy entries  n=${String(es.length).padStart(5)}  ${mean(es)>=0?'+':''}${mean(es).toFixed(3)}R  CI[${out.strategy.ci}]`);
console.log(`  random entries    n=${String(er.length).padStart(5)}  ${mean(er)>=0?'+':''}${mean(er).toFixed(3)}R  CI[${out.randomEntries.ci}]`);
console.log(`  ${out.passes ? 'PASS' : 'FAIL'} — ${out.verdict}`);
