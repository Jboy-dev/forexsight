// v499 — TESTING ACROSS DECADES INSTEAD OF ONE REGIME.
//
// The strategy claim withdrawn in v495 rested on two years of hourly bars — a
// single market regime, and a sample small enough that a counting choice moved
// the answer by 0.4R. This runs the same rules over the deepest daily history
// that actually exists for each instrument:
//
//     USD/JPY 29.9y   XAU/USD 26.0y   USD/CAD 23.0y   USD/CHF 23.0y
//     EUR/USD 22.8y   GBP/USD 22.8y   NZD/USD 22.8y   AUD/USD 20.3y
//     BTC/USD 12.0y   ETH/USD  8.9y
//
// About 53,000 daily bars, spanning the 2008 crisis, the 2015 franc unpeg,
// the 2020 collapse and the 2022 rate shock. Fifty years was asked for and does
// not exist: floating exchange rates began in 1971, free data starts in the
// mid-90s, and crypto is younger than most of the questions being asked of it.
// This is the real ceiling, stated rather than quietly rounded up.
//
// Everything is measured PER SIGNAL, the unit a person trades. That is the
// correction from v495, where collapsing repeats into episodes turned -0.060R
// into +0.176R and produced a claim that had to be retracted.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const MAX_HOLD = 48;          // 48 daily bars ~ 10 trading weeks
const ATR_STOP = 1.75;
const LADDER = [1.2, 2.0, 3.5];
const W = [1/3, 1/3, 1/3];
const SPLIT = 0.65;
// Daily bars carry a wider effective cost than hourly: a day's spread plus the
// slippage of acting on a daily close. Deliberately pessimistic.
const COST_R = 0.02;

const ema=(a,p)=>{const k=2/(p+1);const e=[];let pr=null;for(let i=0;i<a.length;i++){pr=pr==null?a[i]:a[i]*k+pr*(1-k);e[i]=i<p-1?null:pr;}return e;};
const sma=(a,p)=>{const o=[];let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];o[i]=i>=p-1?s/p:null;}return o;};
const sd=(a,p)=>{const o=[];for(let i=p-1;i<a.length;i++){const w=a.slice(i-p+1,i+1),m=w.reduce((x,y)=>x+y,0)/p;o[i]=Math.sqrt(w.reduce((x,y)=>x+(y-m)**2,0)/p);}return o;};
function rsiS(c,p=14){const o=[];let g=0,l=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];if(i<=p){g+=Math.max(d,0);l+=Math.max(-d,0);o[i]=null;if(i===p){g/=p;l/=p;o[i]=100-100/(1+g/(l||1e-9));}}else{g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;o[i]=100-100/(1+g/(l||1e-9));}}return o;}
function atrS(b,p=14){const o=[];let s=0;for(let i=1;i<b.length;i++){const tr=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));if(i<=p){s+=tr;o[i]=i===p?s/p:null;}else o[i]=(o[i-1]*(p-1)+tr)/p;}return o;}

const STRATEGIES = {
  'RSI mean reversion': (x,i)=>{const r=x.rsi[i],p=x.rsi[i-1];if(r==null||p==null)return null;
    if(p<30&&r>=30)return 'BUY'; if(p>70&&r<=70)return 'SELL'; return null;},
  'Bollinger reversion': (x,i)=>{if(!x.sma20[i]||!x.sd20[i])return null;
    const u=x.sma20[i]+2*x.sd20[i],d=x.sma20[i]-2*x.sd20[i];
    if(x.c[i-1]<d&&x.c[i]>=d)return 'BUY'; if(x.c[i-1]>u&&x.c[i]<=u)return 'SELL'; return null;},
  'MACD cross': (x,i)=>{if(!x.e12[i]||!x.e26[i]||!x.e12[i-1]||!x.e26[i-1])return null;
    const m=x.e12[i]-x.e26[i],mp=x.e12[i-1]-x.e26[i-1];
    if(m>0&&mp<=0)return 'BUY'; if(m<0&&mp>=0)return 'SELL'; return null;},
  'EMA cross 20/50': (x,i)=>{if(!x.e20[i]||!x.e50[i]||!x.e20[i-1]||!x.e50[i-1])return null;
    const up=x.e20[i]>x.e50[i],pu=x.e20[i-1]>x.e50[i-1];
    return up&&!pu?'BUY':(!up&&pu?'SELL':null);},
  'Golden cross 50/200': (x,i)=>{if(!x.e50[i]||!x.e200[i]||!x.e50[i-1]||!x.e200[i-1])return null;
    const up=x.e50[i]>x.e200[i],pu=x.e50[i-1]>x.e200[i-1];
    return up&&!pu?'BUY':(!up&&pu?'SELL':null);},
  'Donchian 20 breakout': (x,i)=>{if(i<21)return null;let hh=-Infinity,ll=Infinity;
    for(let k=i-20;k<i;k++){hh=Math.max(hh,x.b[k].h);ll=Math.min(ll,x.b[k].l);}
    if(x.b[i].c>hh)return 'BUY'; if(x.b[i].c<ll)return 'SELL'; return null;},
  'Trend pullback to EMA20': (x,i)=>{if(!x.e20[i]||!x.e50[i]||!x.e200[i])return null;
    const up=x.e50[i]>x.e200[i],dn=x.e50[i]<x.e200[i];
    if(up&&x.b[i].l<=x.e20[i]&&x.c[i]>x.e20[i])return 'BUY';
    if(dn&&x.b[i].h>=x.e20[i]&&x.c[i]<x.e20[i])return 'SELL'; return null;},
  '52-week breakout': (x,i)=>{if(i<253)return null;let hh=-Infinity,ll=Infinity;
    for(let k=i-252;k<i;k++){hh=Math.max(hh,x.b[k].h);ll=Math.min(ll,x.b[k].l);}
    if(x.b[i].c>hh)return 'BUY'; if(x.b[i].c<ll)return 'SELL'; return null;},
};

function outcome(bars,i,dir,a){
  const buy=dir==='BUY', nxt=bars[i+1]; if(!nxt) return null;
  const entry=nxt.o, slD=a*ATR_STOP; if(!(slD>0)) return null;
  let stop=buy?entry-slD:entry+slD, reached=0, banked=0;
  const tps=LADDER.map(m=>buy?entry+slD*m:entry-slD*m);
  for(let k=i+1;k<Math.min(bars.length,i+1+MAX_HOLD);k++){
    const b=bars[k];
    if(buy?b.l<=stop:b.h>=stop){
      const rem=1-W.slice(0,reached).reduce((x,y)=>x+y,0);
      return banked+rem*(reached===0?-1:reached===1?0:LADDER[0])-COST_R;
    }
    while(reached<3&&(buy?b.h>=tps[reached]:b.l<=tps[reached])){
      banked+=W[reached]*LADDER[reached]; reached++;
      if(reached===1)stop=entry; else if(reached===2)stop=tps[0];
    }
    if(reached===3) return banked-COST_R;
  }
  const last=bars[Math.min(bars.length,i+1+MAX_HOLD)-1];
  const rem=1-W.slice(0,reached).reduce((x,y)=>x+y,0);
  return banked+rem*((buy?last.c-entry:entry-last.c)/slD)-COST_R;
}

const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:0;
function ci(v,n=2500){if(v.length<20)return null;const s=[];
  for(let i=0;i<n;i++){let t=0;for(let j=0;j<v.length;j++)t+=v[Math.floor(Math.random()*v.length)];s.push(t/v.length);}
  s.sort((a,b)=>a-b);return[+s[Math.floor(.025*n)].toFixed(4),+s[Math.floor(.975*n)].toFixed(4)];}

if (!existsSync('data/deep')) { console.log('deep-history-lab: data/deep missing — run the fetch first'); process.exit(0); }
const D=[];
for(const f of readdirSync('data/deep').filter(x=>x.endsWith('.json'))){
  const pair=f.replace('.json','').replace('-','/');
  const b=JSON.parse(readFileSync('data/deep/'+f,'utf8'));
  if(b.length<600) continue;
  const c=b.map(x=>x.c);
  D.push({pair,b,c,rsi:rsiS(c),atr:atrS(b),sma20:sma(c,20),sd20:sd(c,20),
          e12:ema(c,12),e26:ema(c,26),e20:ema(c,20),e50:ema(c,50),e200:ema(c,200)});
}
const totalBars=D.reduce((a,d)=>a+d.b.length,0);

// Shared random-entry null, the same control that exposed v495.
const randR=[];
for(const d of D){
  for(let k=0;k<600;k++){
    const i=260+Math.floor(Math.random()*Math.max(1,d.b.length-MAX_HOLD-265));
    const a=d.atr[i]; if(!a) continue;
    const o=outcome(d.b,i,Math.random()<0.5?'BUY':'SELL',a);
    if(o!=null) randR.push(o);
  }
}
const randCi=ci(randR);
const randomOk=!!(randCi&&randCi[0]<0&&randCi[1]>0);

const results=[];
for(const [name,rule] of Object.entries(STRATEGIES)){
  const inS=[], outS=[], perPair={};
  for(const d of D){
    const cut=Math.floor(d.b.length*SPLIT);
    for(let i=260;i<d.b.length-MAX_HOLD-2;i++){
      let dir=null; try{dir=rule(d,i);}catch{continue;}
      if(!dir) continue;
      const a=d.atr[i]; if(!a) continue;
      const o=outcome(d.b,i,dir,a); if(o==null) continue;
      (i<cut?inS:outS).push(o);
      (perPair[d.pair]??=[]).push(o);
    }
  }
  const oc=ci(outS);
  results.push({ name,
    inSample:{n:inS.length,avgR:+mean(inS).toFixed(4),ci:ci(inS)},
    outSample:{n:outS.length,avgR:+mean(outS).toFixed(4),ci:oc},
    pairsPositive:Object.values(perPair).filter(v=>mean(v)>0).length,
    pairsTested:Object.keys(perPair).length,
    beatsRandom:+(mean(outS)-mean(randR)).toFixed(4),
    passes: !!(randomOk && oc && oc[0]>0 && mean(outS)>mean(randR)),
  });
}
results.sort((a,b)=>b.outSample.avgR-a.outSample.avgR);
const survivors=results.filter(r=>r.passes);

const report={ ts:Date.now(), isoTime:new Date().toISOString(),
  method:'daily bars, deepest available per instrument, entry at next open, cost charged, '
        +'v442 managed ladder, PER SIGNAL (not episodes), 65/35 split, textbook parameters',
  instruments:Object.fromEntries(D.map(d=>[d.pair,{bars:d.b.length,
    years:+((Date.now()-d.b[0].t)/(365.25*86400000)).toFixed(1)}])),
  totalDailyBars:totalBars,
  randomEntryNull:{n:randR.length,avgR:+mean(randR).toFixed(4),ci:randCi,behavesAsNull:randomOk},
  results, survivors:survivors.map(s=>s.name),
  verdict: survivors.length
    ? `${survivors.length} strategy(ies) positive out of sample across decades.`
    : 'No strategy is positive out of sample across this history.',
  note:'Fifty years was requested. Floating exchange rates began in 1971 and free daily data '
      +'starts in the mid-1990s; crypto is younger still. This is the real ceiling.',
};
writeFileSync('data/deep-history.json',JSON.stringify(report,null,2));

console.log(`${D.length} instruments, ${totalBars.toLocaleString()} daily bars`);
console.log(`random-entry null: ${mean(randR)>=0?'+':''}${mean(randR).toFixed(4)}R  CI[${randCi}]  ${randomOk?'behaves as null':'DOES NOT'}\n`);
console.log('  '+'strategy'.padEnd(24)+'IN-SAMPLE'.padEnd(22)+'OUT-OF-SAMPLE'.padEnd(24)+'pairs+');
console.log('  '+'-'.repeat(78));
for(const r of results){
  const f=s=>`${String(s.n).padStart(5)} ${(s.avgR>=0?'+':'')+s.avgR.toFixed(4)}`;
  const oc=r.outSample.ci?`[${r.outSample.ci[0]},${r.outSample.ci[1]}]`:'—';
  console.log('  '+r.name.padEnd(24)+f(r.inSample).padEnd(22)+(f(r.outSample)+' '+oc).padEnd(24)+`${r.pairsPositive}/${r.pairsTested}`+(r.passes?'  <<':''));
}
console.log(`\n  ${report.verdict}`);
