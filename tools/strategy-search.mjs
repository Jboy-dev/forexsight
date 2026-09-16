// v500 — THE SEARCH, AND WHY IT KEEPS RETURNING NOTHING.
//
// Every strategy family tried so far, tested on the deepest daily history that
// exists (~57,000 bars, up to 30 years per instrument), measured per signal,
// costs charged, entry at the next open:
//
//   mean reversion   RSI 30/70, Bollinger 2sd        negative out of sample
//   trend following  EMA 20/50, golden cross,        none positive out of sample
//                    trend pullback
//   breakout         Donchian 20, 52-week            none positive out of sample
//   oscillator       MACD cross                      not positive out of sample
//   time-series
//   momentum         12-month sign, held 1-12 months no edge over random
//
// The momentum result is the instructive one, because it looked overwhelming
// first: +2.74 ATR held a year, intervals nowhere near zero. Two faults, both
// of which this file now guards against permanently.
//
//   OVERLAPPING WINDOWS. Stepping five days at a time while holding 252 means
//   consecutive observations share 98% of their outcome. The sample looked like
//   10,000 trades and behaved like a few hundred. Stepping by the full holding
//   period cut it to 425 and the interval opened up to include zero.
//
//   NO NULL TO BEAT. Against random direction over the same windows, momentum
//   returned +0.693 versus +0.699 — an edge of MINUS 0.006. And simply always
//   going long returned +1.728, beating both, because gold and Bitcoin rose
//   enormously over the sample. Six of ten instruments were negative; the whole
//   apparent effect was two bull markets.
//
// So the honest state of the search: nothing tested has an edge. That is a
// result, not a gap, and it is recorded here so the same families are not
// rediscovered as findings later.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';

const COST = 0.02;
const mean = v => v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
function ci(v, n = 2000) {
  if (v.length < 15) return null;
  const s = [];
  for (let i = 0; i < n; i++) { let t=0; for (let j=0;j<v.length;j++) t+=v[Math.floor(Math.random()*v.length)]; s.push(t/v.length); }
  s.sort((a,b)=>a-b);
  return [+s[Math.floor(.025*n)].toFixed(3), +s[Math.floor(.975*n)].toFixed(3)];
}
function atrS(b,p=14){const o=[];let s=0;for(let i=1;i<b.length;i++){const tr=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));if(i<=p){s+=tr;o[i]=i===p?s/p:null;}else o[i]=(o[i-1]*(p-1)+tr)/p;}return o;}

if (!existsSync('data/deep')) { console.log('strategy-search: data/deep missing'); process.exit(0); }
const D = [];
for (const f of readdirSync('data/deep').filter(x=>x.endsWith('.json'))) {
  const b = JSON.parse(readFileSync(`data/deep/${f}`,'utf8'));
  if (b.length < 900) continue;
  D.push({ pair: f.replace('.json','').replace('-','/'), b, c: b.map(x=>x.c), atr: atrS(b) });
}

// Non-overlapping by construction: step equals the holding period.
function evaluate(pick, HOLD) {
  const all = [], perPair = {};
  for (const d of D) {
    for (let i = 253; i < d.b.length - HOLD - 1; i += HOLD) {
      const a = d.atr[i]; if (!a) continue;
      const dir = pick(d, i); if (!dir) continue;
      const entry = d.b[i+1].o;
      const exit = d.b[Math.min(d.b.length-1, i+1+HOLD)].c;
      const r = dir * (exit - entry) / a - COST;
      all.push(r); (perPair[d.pair] ??= []).push(r);
    }
  }
  return { all, perPair };
}

const HOLD = 126;
// v500b — a single random draw is not a null. Measured twice, the same random
// test returned +0.699 and then -0.405, which is a swing wide enough to make
// any strategy look brilliant or useless depending on which draw it was
// compared against. The null is now a distribution of 300 draws, and a result
// only counts as outside chance if it clears the 95th percentile of it.
const NULL_DRAWS = 300;

const tests = {
  'momentum 12m': (d,i)=>{const p=(d.c[i]-d.c[i-252])/d.c[i-252];return isFinite(p)&&p!==0?(p>0?1:-1):null;},
  'momentum 3m':  (d,i)=>{const p=(d.c[i]-d.c[i-63])/d.c[i-63];return isFinite(p)&&p!==0?(p>0?1:-1):null;},
  'reversal 12m': (d,i)=>{const p=(d.c[i]-d.c[i-252])/d.c[i-252];return isFinite(p)&&p!==0?(p>0?-1:1):null;},
  'always long':  ()=>1,
  'random':       ()=>Math.random()<0.5?1:-1,
};

const out = {};
for (const [name, pick] of Object.entries(tests)) {
  const { all, perPair } = evaluate(pick, HOLD);
  out[name] = { n: all.length, avgR: +mean(all).toFixed(3), ci: ci(all),
    pairsPositive: Object.values(perPair).filter(v=>mean(v)>0).length,
    pairsTested: Object.keys(perPair).length };
}
// Build the null distribution properly.
const nulls = [];
for (let k = 0; k < NULL_DRAWS; k++) {
  const { all } = evaluate(() => Math.random() < 0.5 ? 1 : -1, HOLD);
  nulls.push(mean(all));
}
nulls.sort((a,b)=>a-b);
const nullMean = mean(nulls);
const null95 = nulls[Math.floor(0.95 * nulls.length)];
const alwaysLong = out['always long'].avgR;
for (const k of Object.keys(out)) {
  out[k].beatsRandomDraws = +(nulls.filter(x => x < out[k].avgR).length / nulls.length * 100).toFixed(0);
  out[k].outsideChance = out[k].avgR > null95;
  // The question that matters: does the timing rule beat simply holding?
  out[k].edgeOverBuyAndHold = +(out[k].avgR - alwaysLong).toFixed(3);
}

const report = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  holdingDays: HOLD,
  method: 'non-overlapping windows (step = holding period), entry next open, cost charged, '
        + 'measured against a random-direction null AND a buy-and-hold null',
  results: out,
  nullDistribution: { draws: NULL_DRAWS, mean: +nullMean.toFixed(3),
    p95: +null95.toFixed(3),
    note: 'A single random draw ranged from -0.405 to +0.699 between runs, so the '
        + 'null is a distribution and the bar is its 95th percentile.' },
  verdict: 'Nothing tested shows TIMING skill. Momentum at 3 months clears the random null, '
         + 'but beats simply holding by only 0.086 — what is outside chance is being LONG, not '
         + 'the timing, because gold and Bitcoin rose enormously over the sample. Knowing in '
         + 'advance which assets will rise is not a strategy this or any backtest can supply.',
  familiesExhausted: ['mean reversion','trend following','breakout','oscillator','time-series momentum'],
};
writeFileSync('data/strategy-search.json', JSON.stringify(report, null, 2));

console.log(`non-overlapping, hold ${HOLD} days, ${D.length} instruments\n`);
console.log('  '+'test'.padEnd(16)+'n'.padStart(5)+'  avgR'.padEnd(10)+'95% CI'.padEnd(20)+'beats null'.padEnd(11)+'pairs+');
console.log('  '+'-'.repeat(70));
for (const [k,v] of Object.entries(out)) {
  console.log('  '+k.padEnd(16)+String(v.n).padStart(5)+'  '+((v.avgR>=0?'+':'')+v.avgR).padEnd(9)+`[${v.ci}]`.padEnd(20)+String(v.beatsRandomDraws+'%').padEnd(11)+`${v.pairsPositive}/${v.pairsTested}`);
}
console.log(`\n  null distribution (${NULL_DRAWS} draws): mean ${nullMean.toFixed(3)}, 95th ${null95.toFixed(3)}`);
for (const [k,v] of Object.entries(out)) {
  console.log(`  ${k.padEnd(16)}${v.outsideChance ? 'outside chance' : 'inside chance '}   vs buy-and-hold ${v.edgeOverBuyAndHold>=0?'+':''}${v.edgeOverBuyAndHold}`);
}
console.log(`\n  ${report.verdict}`);
