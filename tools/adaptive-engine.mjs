#!/usr/bin/env node
/**
 * adaptive-engine.mjs — an engine that changes its mind.
 *
 * Every test so far asked a STATIC question: does this rule work on average,
 * across the whole history. The answer has been no, about twenty-four thousand
 * times. But that is not the only question. A rule can be useless on average
 * and still work in the regimes where it works — if you can tell which regime
 * you are in WITHOUT looking ahead.
 *
 * So this learns online. At every decision point it looks only at how each rule
 * has performed on its own RECENT CLOSED TRADES, and trades only the rules that
 * are currently paying. Nothing from the future is ever consulted: a rule's
 * score at bar i is built exclusively from trades that had already resolved
 * before bar i.
 *
 * TWO TRAPS THIS IS BUILT TO AVOID, both of which have caught this project:
 *
 *  · A RELATIVE BAR PROMOTES LOSERS. Scoring rules against each other means the
 *    least-bad rule always scores well, even when every rule is losing. The bar
 *    here is ABSOLUTE: a rule must be positive in its own right, net of costs.
 *
 *  · THE WARM-UP IS NOT FREE. A rule needs a minimum number of resolved trades
 *    before its recent record means anything. Below that it does not trade.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const DIR = 'data/intraday';
const SUFFIX = '.1h.json';
const HOLD = 240, COST_R = 0.02, SL_ATR = 1.5;
const TPS = [1.2, 2.0, 3.5];
const LOOKBACK = 30;        // recent resolved trades that form a rule's score
const MIN_TRADES = 12;      // before that, the rule stays silent
const MIN_AVG_R = 0.0;      // absolute bar: must be positive on its own

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
const pctRank = (arr, i, look) => { const lo = Math.max(0, i-look); let b = 0, n = 0;
  for (let j = lo; j < i; j++) { if (arr[j] == null) continue; n++; if (arr[j] < arr[i]) b++; } return n ? b/n : 0.5; };

const RULES = {
  'momentum-60':    (d,i)=>{const a=d.c[i-60];return a?(d.c[i]>a?'BUY':'SELL'):null;},
  'momentum-120':   (d,i)=>{const a=d.c[i-120];return a?(d.c[i]>a?'BUY':'SELL'):null;},
  'ma-cross':       (d,i)=>{if(d.ma20[i]==null||d.ma50[i]==null||d.ma20[i-1]==null)return null;
                            const n=d.ma20[i]>d.ma50[i],w=d.ma20[i-1]>d.ma50[i-1];return n!==w?(n?'BUY':'SELL'):null;},
  'rsi-reversion':  (d,i)=>{const r=d.rsi[i];return r==null?null:r<30?'BUY':r>70?'SELL':null;},
  'rsi-trend':      (d,i)=>{const r=d.rsi[i];return r==null?null:r>60?'BUY':r<40?'SELL':null;},
  'donchian-20':    (d,i)=>{let hi=-Infinity,lo=Infinity;for(let j=i-20;j<i;j++){if(d.b[j].h>hi)hi=d.b[j].h;if(d.b[j].l<lo)lo=d.b[j].l;}
                            return d.c[i]>hi?'BUY':d.c[i]<lo?'SELL':null;},
  'pullback':       (d,i)=>{if(d.ma50[i]==null||d.rsi[i]==null)return null;const up=d.c[i]>d.ma50[i];
                            if(up&&d.rsi[i]<45)return 'BUY'; if(!up&&d.rsi[i]>55)return 'SELL'; return null;},
  'trend-with-vol': (d,i)=>{if(d.ma200[i]==null)return null;if(pctRank(d.atr,i,252)<0.5)return null;
                            return d.c[i]>d.ma200[i]?'BUY':'SELL';},
};
const RULE_IDS = Object.keys(RULES);

function runTrade(d, i, dir) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_ATR;
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0;
  for (let j = i+1; j < Math.min(d.b.length, i+1+HOLD); j++) {
    const bar = d.b[j];
    if ((sign>0&&bar.l<=stop)||(sign<0&&bar.h>=stop)) {
      banked += left*((stop-entry)*sign/slDist);
      return { r: banked-COST_R, closeIdx: j };
    }
    for (let k = hit; k < tps.length; k++) {
      const reached = sign>0 ? bar.h>=tps[k] : bar.l<=tps[k];
      if (!reached) break;
      banked += (1/3)*TPS[k]; left -= 1/3; hit = k+1;
      if (hit===1) stop = entry; else if (hit===2) stop = tps[0];
      if (hit>=3) return { r: banked-COST_R, closeIdx: j };
    }
  }
  const lastI = Math.min(d.b.length-1, i+HOLD);
  banked += left*((d.b[lastI].c-entry)*sign/slDist);
  return { r: banked-COST_R, closeIdx: lastI };
}

if (!existsSync(DIR)) { console.error('no data/intraday'); process.exit(1); }

const adaptive = [], staticAll = [], perRuleUse = new Map(RULE_IDS.map(r => [r, 0]));
let instruments = 0;

for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  instruments++;
  const c = bars.map(x=>x.c);
  const d = { pair, b: bars, c, atr: atrSeries(bars), rsi: rsi(c), ma20: sma(c,20), ma50: sma(c,50), ma200: sma(c,200) };

  // Each rule keeps its own ledger of RESOLVED trades, with the bar it closed on.
  const ledger = new Map(RULE_IDS.map(r => [r, []]));
  let free = 260;

  for (let i = 260; i < bars.length - HOLD - 2; i++) {
    for (const id of RULE_IDS) {
      const dir = RULES[id](d, i);
      if (!dir) continue;
      const t = runTrade(d, i, dir);
      if (!t) continue;

      // STATIC baseline: every rule, every signal, no selection at all.
      staticAll.push({ frac: i / bars.length, r: t.r });

      // ADAPTIVE: only trade this rule if its RECENT RESOLVED record is positive.
      // Only trades that closed strictly before i can count.
      if (i >= free) {
        const closed = ledger.get(id).filter(x => x.closeIdx < i);
        if (closed.length >= MIN_TRADES) {
          const recent = closed.slice(-LOOKBACK).map(x => x.r);
          if (mean(recent) > MIN_AVG_R) {
            adaptive.push({ frac: i / bars.length, r: t.r, rule: id });
            perRuleUse.set(id, perRuleUse.get(id) + 1);
            free = t.closeIdx + 1;          // non-overlapping across the portfolio
          }
        }
      }
      ledger.get(id).push({ closeIdx: t.closeIdx, r: t.r });
    }
  }
}

const split = (arr, lo, hi) => arr.filter(x => x.frac >= lo && x.frac < hi).map(x => x.r);
const stat = (rs) => ({ n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2),
  ci: ci95(rs), winRate: rs.length ? +(rs.filter(r=>r>0).length/rs.length*100).toFixed(1) : null });

const A = { train: stat(split(adaptive,0,0.5)), validate: stat(split(adaptive,0.5,0.75)),
            sealed: stat(split(adaptive,0.75,1.0001)), all: stat(adaptive.map(x=>x.r)) };
const St = { sealed: stat(split(staticAll,0.75,1.0001)), all: stat(staticAll.map(x=>x.r)) };

console.log(`adaptive engine: ${instruments} instruments, ${RULE_IDS.length} rules learning online\n`);
console.log(`  a rule trades only when its last ${LOOKBACK} RESOLVED trades average above ${MIN_AVG_R}R`);
console.log(`  (absolute bar, not relative — a relative bar promotes the least-bad loser)\n`);
console.log('  ADAPTIVE — only rules currently paying:');
for (const [k,v] of Object.entries(A))
  console.log(`    ${k.padEnd(10)} ${String(v.n).padStart(6)} trades  ${(v.avgR>=0?'+':'')+v.avgR}R  t=${String(v.t).padStart(6)}  win ${v.winRate}%  CI ${v.ci?'['+v.ci.join(', ')+']':'—'}`);
console.log('\n  STATIC baseline — every rule, every signal, no selection:');
for (const [k,v] of Object.entries(St))
  console.log(`    ${k.padEnd(10)} ${String(v.n).padStart(6)} trades  ${(v.avgR>=0?'+':'')+v.avgR}R  t=${String(v.t).padStart(6)}  win ${v.winRate}%`);

const gain = A.sealed.avgR - St.sealed.avgR;
console.log(`\n  Selection changed the sealed result by ${(gain>=0?'+':'')+gain.toFixed(4)}R per trade.`);
console.log('\n  which rules it chose to use:');
for (const [id,n] of [...perRuleUse.entries()].sort((a,b)=>b[1]-a[1]))
  console.log(`    ${id.padEnd(16)} ${String(n).padStart(6)} trades`);

const works = A.sealed.ci && A.sealed.ci[0] > 0;
const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/adaptive-engine.mjs',
  instruments, rules: RULE_IDS.length, lookback: LOOKBACK, minTrades: MIN_TRADES, absoluteBarR: MIN_AVG_R,
  adaptive: A, staticBaseline: St, selectionGainR: +gain.toFixed(4),
  ruleUsage: Object.fromEntries(perRuleUse),
  method: 'Online learning with no lookahead. At each bar a rule is traded only if its own recently '
        + 'RESOLVED trades (closed strictly before that bar) average above an ABSOLUTE positive bar. '
        + 'Non-overlapping. Compared against the same rules with no selection at all.',
  verdict: works
    ? `Adapting works: ${A.sealed.avgR}R per trade on the sealed quarter, interval [${A.sealed.ci.join(', ')}].`
    : `Adapting does not rescue it. On the sealed quarter the adaptive engine returned ${A.sealed.avgR}R `
      + `against ${St.sealed.avgR}R for no selection at all — a difference of ${(gain>=0?'+':'')+gain.toFixed(4)}R `
      + `with the interval ${A.sealed.ci?'['+A.sealed.ci.join(', ')+']':''} including zero. Choosing rules by `
      + `their recent record does not predict their next trade.`,
};
writeFileSync('data/adaptive-engine.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
