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
import { rsiSeries, emaSeries, smaSeries, stdevSeries } from './proven-strategies.mjs';

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
  const c = bars.map(b => b.c);
  D.push({ pair, bars, c,
    rsi: rsiSeries(c, 14), atr: atrSeries(bars),
    ema200: emaSeries(c, 200), ema12: emaSeries(c, 12), ema26: emaSeries(c, 26),
    sma20: smaSeries(c, 20), sd20: stdevSeries(c, 20) });
}
if (!D.length) { console.log('control test skipped — data/bt not present (run the fetch first)'); process.exit(0); }

// v489 — every strategy whose evidence is displayed gets its own control.
// Previously only RSI mean reversion was tested while four claims were shown on
// cards, so three of them rested on nothing more than the lab's own number.
const RULES = {
  'RSI mean reversion': (x, i) => {
    const r = x.rsi[i], p = x.rsi[i-1];
    if (r == null || p == null) return null;
    if (p < 30 && r >= 30) return 'BUY';
    if (p > 70 && r <= 70) return 'SELL';
    return null;
  },
  'RSI trend filter': (x, i) => {
    const r = x.rsi[i], p = x.rsi[i-1];
    if (r == null || p == null || !x.ema200[i]) return null;
    const up = x.c[i] > x.ema200[i];
    if (up && p < 40 && r >= 40) return 'BUY';
    if (!up && p > 60 && r <= 60) return 'SELL';
    return null;
  },
  'Bollinger reversion': (x, i) => {
    if (!x.sma20[i] || !x.sd20[i]) return null;
    const up = x.sma20[i] + 2*x.sd20[i], dn = x.sma20[i] - 2*x.sd20[i];
    if (x.c[i-1] < dn && x.c[i] >= dn) return 'BUY';
    if (x.c[i-1] > up && x.c[i] <= up) return 'SELL';
    return null;
  },
  'MACD cross': (x, i) => {
    if (!x.ema12[i] || !x.ema26[i] || !x.ema12[i-1] || !x.ema26[i-1]) return null;
    const m = x.ema12[i]-x.ema26[i], mp = x.ema12[i-1]-x.ema26[i-1];
    if (m > 0 && mp <= 0) return 'BUY';
    if (m < 0 && mp >= 0) return 'SELL';
    return null;
  },
};

// One shared pool of random entries: the null hypothesis does not depend on
// which rule it is being compared against, and reusing it keeps the comparison
// stable between strategies.
const rand = [];
for (const { pair, bars, atr } of D) {
  for (let k = 0; k < 400; k++) {
    const i = 210 + Math.floor(Math.random() * Math.max(1, bars.length - MAX_HOLD - 215));
    const a = atr[i]; if (!a) continue;
    const d = Math.random() < 0.5 ? 'BUY' : 'SELL';
    const o = outcome(bars, i, d, a, pair);
    if (o) rand.push({ pair, dir: d, ...o });
  }
}
const er = eps(rand);
const randomOk = !!(ci(er) && ci(er)[0] < 0 && ci(er)[1] > 0);

const perStrategy = {};
for (const [name, rule] of Object.entries(RULES)) {
  const hits = [];
  for (const { pair, bars, ...x } of D) {
    for (let i = 210; i < bars.length - MAX_HOLD - 2; i++) {
      let d = null;
      try { d = rule(x, i); } catch { continue; }
      if (!d) continue;
      const a = x.atr[i]; if (!a) continue;
      const o = outcome(bars, i, d, a, pair);
      if (o) hits.push({ pair, dir: d, ...o });
    }
  }
  const e = eps(hits);
  const c = ci(e);
  perStrategy[name] = {
    n: e.length, avgR: +mean(e).toFixed(3), ci: c,
    edgeOverRandom: +(mean(e) - mean(er)).toFixed(3),
    // A strategy only keeps its claim if random entries behave AND it clears
    // zero on its own AND it beats the random pool.
    passes: !!(randomOk && c && c[0] > 0 && mean(e) - mean(er) > 0),
  };
}

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  randomEntries: { n: er.length, avgR: +mean(er).toFixed(3), ci: ci(er), behavesAsNull: randomOk },
  perStrategy,
  passes: randomOk && Object.values(perStrategy).some(s => s.passes),
};
out.verdict = !randomOk
  ? 'CONTROL FAILED — random entries did not score about zero, so the simulator is producing '
    + 'the number rather than any strategy. No claim may be shown.'
  : `Random entries score ${out.randomEntries.avgR}R with the interval straddling zero, as they must. `
    + `${Object.values(perStrategy).filter(s => s.passes).length} of ${Object.keys(RULES).length} strategies clear it.`;
writeFileSync('data/control-test.json', JSON.stringify(out, null, 2));

console.log(`  random entries    n=${String(er.length).padStart(5)}  ${mean(er)>=0?'+':''}${mean(er).toFixed(3)}R  CI[${ci(er)}]  ${randomOk?'behaves as null':'DOES NOT BEHAVE AS NULL'}`);
for (const [name, s] of Object.entries(perStrategy)) {
  console.log(`  ${name.padEnd(22)} n=${String(s.n).padStart(5)}  ${s.avgR>=0?'+':''}${s.avgR}R  CI[${s.ci}]  vs random ${s.edgeOverRandom>=0?'+':''}${s.edgeOverRandom}  ${s.passes?'PASS':'FAIL'}`);
}
console.log(`\n  ${out.verdict}`);
