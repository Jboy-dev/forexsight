// v501 — DOES MOVING THE STOP TO BREAKEVEN AFTER TP1 HELP, ON THIS GEOMETRY?
//
// A finding from a sibling project said the opposite: protecting winners early
// measured worse at every level and cost 556R. That is a serious warning and
// worth taking literally — but findings do not transfer between systems with
// different geometry, so it was tested here rather than assumed either way.
//
// Method matters. MFE cannot answer this question: the stored peak excursion is
// the peak reached under the ORIGINAL stop, so a trade the new rule would have
// exited earlier has an MFE that never existed under that rule. The bars are
// re-walked in full under each rule instead, on identical entries, which also
// permits a PAIRED comparison — far more powerful than comparing two averages.
//
// Result on ~57,000 daily bars across 10 instruments, 7,691 paired trades:
//
//     breakeven after TP1   +0.0394R
//     original stop held    +0.0293R
//     paired difference     +0.0102R   t = 2.20   CI [0.0011, 0.0192]
//     positive on 8 of 10 instruments, +78R in total
//
// So the rule helps slightly here, and the sibling project's result does not
// apply. The mechanical reason is the ladder: TP1 sits at 1.2R, ABOVE the stop,
// so reaching it banks 0.4R of secured profit BEFORE the stop is moved. A ladder
// whose first target sits inside the stop gives up upside without securing
// enough to pay for it, which is the situation that loses.
//
// t = 2.20 is marginal, not overwhelming. This exists so the answer is re-checked
// on fresh data rather than remembered, and so a future change to the ladder
// cannot quietly invalidate it.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';

const ATR_STOP = 1.75, LADDER = [1.2, 2.0, 3.5], W = [1/3,1/3,1/3], MAX_HOLD = 48, COST = 0.02;
const mean = v => v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
function atrS(b,p=14){const o=[];let s=0;for(let i=1;i<b.length;i++){const tr=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));if(i<=p){s+=tr;o[i]=i===p?s/p:null;}else o[i]=(o[i-1]*(p-1)+tr)/p;}return o;}
const ema=(a,p)=>{const k=2/(p+1);const e=[];let pr=null;for(let i=0;i<a.length;i++){pr=pr==null?a[i]:a[i]*k+pr*(1-k);e[i]=i<p-1?null:pr;}return e;};

function walk(bars, i, dir, a, moveStop) {
  const buy = dir === 'BUY', nxt = bars[i+1];
  if (!nxt) return null;
  const entry = nxt.o, slD = a * ATR_STOP;
  if (!(slD > 0)) return null;
  let stop = buy ? entry - slD : entry + slD, reached = 0, banked = 0;
  const tps = LADDER.map(m => buy ? entry + slD*m : entry - slD*m);
  for (let k = i+1; k < Math.min(bars.length, i+1+MAX_HOLD); k++) {
    const b = bars[k];
    if (buy ? b.l <= stop : b.h >= stop) {
      const rem = 1 - W.slice(0,reached).reduce((x,y)=>x+y,0);
      const exitR = reached === 0 ? -1 : (buy ? (stop-entry) : (entry-stop)) / slD;
      return banked + rem*exitR - COST;
    }
    while (reached < 3 && (buy ? b.h >= tps[reached] : b.l <= tps[reached])) {
      banked += W[reached]*LADDER[reached]; reached++;
      if (moveStop) { if (reached === 1) stop = entry; else if (reached === 2) stop = tps[0]; }
    }
    if (reached === 3) return banked - COST;
  }
  const last = bars[Math.min(bars.length, i+1+MAX_HOLD)-1];
  const rem = 1 - W.slice(0,reached).reduce((x,y)=>x+y,0);
  return banked + rem*((buy ? last.c-entry : entry-last.c)/slD) - COST;
}

if (!existsSync('data/deep')) { console.log('ladder-rule-test: data/deep missing'); process.exit(0); }
const D = [];
for (const f of readdirSync('data/deep').filter(x=>x.endsWith('.json'))) {
  const b = JSON.parse(readFileSync(`data/deep/${f}`,'utf8'));
  if (b.length < 900) continue;
  const c = b.map(x=>x.c);
  D.push({ pair: f.replace('.json','').replace('-','/'), b, atr: atrS(b), e20: ema(c,20), e50: ema(c,50) });
}

const diffs = [], withMove = [], without = [], byPair = {};
for (const d of D) {
  for (let i = 260; i < d.b.length - MAX_HOLD - 2; i += 7) {
    const a = d.atr[i];
    if (!a || !d.e20[i] || !d.e50[i]) continue;
    const dir = d.e20[i] > d.e50[i] ? 'BUY' : 'SELL';
    const be = walk(d.b, i, dir, a, true), ho = walk(d.b, i, dir, a, false);
    if (be == null || ho == null) continue;
    withMove.push(be); without.push(ho); diffs.push(be - ho);
    (byPair[d.pair] ??= []).push(be - ho);
  }
}
const m = mean(diffs);
const sd = Math.sqrt(mean(diffs.map(x=>(x-m)**2)));
const se = sd / Math.sqrt(Math.max(1, diffs.length));
const t = se > 0 ? m/se : 0;

const report = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  question: 'Does moving the stop to breakeven after TP1 help on this ladder?',
  method: 'bars re-walked in full under each rule on identical entries (MFE cannot answer '
        + 'this — it is the peak under the original stop), paired comparison',
  trades: diffs.length,
  breakevenAvgR: +mean(withMove).toFixed(4),
  holdAvgR: +mean(without).toFixed(4),
  pairedDifference: +m.toFixed(4),
  tStat: +t.toFixed(2),
  ci95: [+(m-1.96*se).toFixed(4), +(m+1.96*se).toFixed(4)],
  totalR: +(m*diffs.length).toFixed(0),
  instrumentsPositive: Object.values(byPair).filter(v=>mean(v)>0).length,
  instrumentsTested: Object.keys(byPair).length,
  keepRule: t > 2 && m > 0,
  verdict: t > 2 && m > 0
    ? `Keep it: +${m.toFixed(4)}R per trade, t=${t.toFixed(2)}, positive on `
      + `${Object.values(byPair).filter(v=>mean(v)>0).length} of ${Object.keys(byPair).length} instruments. `
      + `Marginal, not overwhelming.`
    : t < -2
      ? `REMOVE IT: the rule costs ${m.toFixed(4)}R per trade, t=${t.toFixed(2)}.`
      : `No significant difference (t=${t.toFixed(2)}); the rule is neutral here.`,
  note: 'A sibling project measured this rule as harmful (cost 556R). It does not transfer: '
      + 'this ladder places TP1 at 1.2R, above the stop, so reaching it banks 0.4R before the '
      + 'stop moves. A ladder with TP1 inside the stop gives up upside without securing enough.',
};
writeFileSync('data/ladder-rule-test.json', JSON.stringify(report, null, 2));

console.log(`paired over ${diffs.length} trades, ${D.length} instruments`);
console.log(`  breakeven after TP1  ${mean(withMove)>=0?'+':''}${mean(withMove).toFixed(4)}R`);
console.log(`  original stop held   ${mean(without)>=0?'+':''}${mean(without).toFixed(4)}R`);
console.log(`  paired difference    ${m>=0?'+':''}${m.toFixed(4)}R   t=${t.toFixed(2)}   total ${m*diffs.length>=0?'+':''}${(m*diffs.length).toFixed(0)}R`);
console.log(`  ${report.verdict}`);
