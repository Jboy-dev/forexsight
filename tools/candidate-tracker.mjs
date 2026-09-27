// v503 — TRACK A CANDIDATE FORWARD INSTEAD OF CLAIMING IT.
//
// The volatility filter is the most promising thing this search has produced,
// and it is still not established. Measured on the deepest daily history
// available — 3-month momentum taken ONLY when ATR sits in the top third of its
// trailing year:
//
//   all 10 instruments   +0.3312 vs +0.2199 always-long   diff +0.1113  CI [-0.152, 0.374]
//   FX only              +0.1274 vs -0.0342 always-long   diff +0.1615  CI [-0.077, 0.421]
//   time split           +0.0628 first half, +0.1628 second half
//   per instrument       6 of 10 positive; gold -0.7186
//
// Both intervals include zero. The FX-only result is the interesting one,
// because always-long FX is NEGATIVE over the same window, so the filter is not
// simply capturing the gold and Bitcoin drift that has explained away every
// previous candidate. But "interesting" is not "established", and publishing it
// as proven is precisely the error of v495 — a strategy shipped on a number that
// a control had already explained, withdrawn six days later.
//
// So it is tracked instead. Every signal it would have produced is recorded with
// the date, the instrument, and the outcome once it resolves, building a forward
// record that nobody can fit in hindsight. Promotion requires the forward record
// to clear zero on its own, independently of the backtest that suggested it.
//
// This is what "learning" should mean here: a candidate enters a queue, not the
// product.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const HOLD = 21;              // trading days
const FILE = 'data/candidates.json';

function atrS(b,p=14){const o=[];let s=0;for(let i=1;i<b.length;i++){const tr=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));if(i<=p){s+=tr;o[i]=i===p?s/p:null;}else o[i]=(o[i-1]*(p-1)+tr)/p;}return o;}
const mean = v => v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
function ci(v,n=3000){
  if (v.length < 15) return null;
  const s=[]; for(let i=0;i<n;i++){let t=0;for(let j=0;j<v.length;j++)t+=v[Math.floor(Math.random()*v.length)];s.push(t/v.length);}
  s.sort((a,b)=>a-b); return [+s[Math.floor(.025*n)].toFixed(4), +s[Math.floor(.975*n)].toFixed(4)];
}

// The candidate rule, stated once so it cannot drift between files.
function volFilteredMomentum(d, i) {
  const a = d.atr[i];
  if (!a) return null;
  const w = [];
  for (let k = i-252; k < i; k++) if (d.atr[k]) w.push(d.atr[k]);
  if (w.length < 200) return null;
  w.sort((x,y)=>x-y);
  const pct = w.filter(x=>x<a).length / w.length;
  if (pct < 0.67) return null;                 // high-volatility regime only
  const p = (d.c[i]-d.c[i-63]) / d.c[i-63];    // 3-month momentum
  if (!isFinite(p) || p === 0) return null;
  return { direction: p > 0 ? 'BUY' : 'SELL', atr: a, volPercentile: +pct.toFixed(3) };
}

let book = { candidate: 'vol-filtered 3m momentum', holdDays: HOLD, entries: [] };
try { if (existsSync(FILE)) book = JSON.parse(readFileSync(FILE,'utf8')); } catch {}
if (!Array.isArray(book.entries)) book.entries = [];

// Read today's bars and record any signal the rule fires, once per instrument
// per day. Then resolve anything old enough.
const seen = new Set(book.entries.map(e => `${e.pair}|${e.date}`));
let added = 0, resolved = 0;

for (const f of readdirSync('data/deep').filter(x=>x.endsWith('.json'))) {
  const pair = f.replace('.json','').replace('-','/');
  const bars = JSON.parse(readFileSync(`data/deep/${f}`,'utf8'));
  if (bars.length < 600) continue;
  const d = { pair, b: bars, c: bars.map(x=>x.c), atr: atrS(bars) };
  const n = bars.length - 1;

  // record a signal on the most recent CLOSED bar
  const sig = volFilteredMomentum(d, n);
  if (sig) {
    const date = new Date(bars[n].t).toISOString().slice(0,10);
    if (!seen.has(`${pair}|${date}`)) {
      book.entries.push({ pair, date, firedAtBar: bars[n].t, direction: sig.direction,
        entryRef: bars[n].c, atr: sig.atr, volPercentile: sig.volPercentile,
        status: 'open', resultR: null });
      added++;
    }
  }

  // resolve open entries whose holding period has elapsed
  for (const e of book.entries) {
    if (e.pair !== pair || e.status !== 'open') continue;
    const idx = bars.findIndex(b => b.t === e.firedAtBar);
    if (idx < 0) continue;
    const exitIdx = idx + 1 + HOLD;
    if (exitIdx >= bars.length) continue;          // not finished yet
    const entry = bars[idx+1] ? bars[idx+1].o : e.entryRef;
    const exit = bars[exitIdx].c;
    const dir = e.direction === 'BUY' ? 1 : -1;
    e.resultR = +((dir * (exit - entry) / e.atr) - 0.02).toFixed(4);
    e.resolvedAt = new Date(bars[exitIdx].t).toISOString();
    e.status = e.resultR > 0 ? 'won' : 'lost';
    resolved++;
  }
}

const done = book.entries.filter(e => typeof e.resultR === 'number');
const rs = done.map(e => e.resultR);
const forwardCi = ci(rs);
book.updatedAt = new Date().toISOString();
book.forwardRecord = {
  resolved: done.length,
  open: book.entries.filter(e=>e.status==='open').length,
  won: done.filter(e=>e.resultR>0).length,
  avgR: done.length ? +mean(rs).toFixed(4) : null,
  ci: forwardCi,
  // Promotion is deliberately strict and independent of the backtest.
  promoted: !!(forwardCi && done.length >= 60 && forwardCi[0] > 0),
};
book.backtestEvidence = {
  allInstruments: { avgR: 0.3312, vsAlwaysLong: 0.1113, ci: [-0.1523, 0.3738] },
  fxOnly: { avgR: 0.1274, vsAlwaysLong: 0.1615, ci: [-0.0770, 0.4207] },
  note: 'Both intervals include zero. FX-only matters because always-long FX was '
      + 'NEGATIVE over the same window, so this is not the gold/Bitcoin drift that '
      + 'explained away earlier candidates. Suggestive, not established.',
};
book.verdict = book.forwardRecord.promoted
  ? `Forward record clears zero over ${done.length} resolved signals — promotable.`
  : `Not promoted. ${done.length} resolved of ${book.entries.length} recorded; `
    + `needs 60+ with an interval clearing zero. Nothing is traded on this yet.`;

writeFileSync(FILE, JSON.stringify(book, null, 2));
console.log(`candidate: ${book.candidate}`);
console.log(`  recorded ${added} new, resolved ${resolved} this run`);
console.log(`  forward record: ${done.length} resolved, ${book.forwardRecord.won} won`
  + (done.length ? `, ${book.forwardRecord.avgR>=0?'+':''}${book.forwardRecord.avgR}R CI[${forwardCi}]` : ''));
console.log(`  ${book.verdict}`);
