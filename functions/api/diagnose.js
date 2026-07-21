// /api/diagnose — runs the strategy detection logic server-side against
// live OHLC data for all 31 instruments and returns a JSON report of what
// would fire. This is the authoritative answer to "are signals being
// produced?" — independent of any client cache or PWA state.
//
// Visit https://forexsight-justice.pages.dev/api/diagnose in any browser.

const PAIRS = {
  'EUR/USD':'EURUSD=X','GBP/USD':'GBPUSD=X','USD/JPY':'USDJPY=X','AUD/USD':'AUDUSD=X',
  'USD/CAD':'USDCAD=X','USD/CHF':'USDCHF=X','NZD/USD':'NZDUSD=X','EUR/JPY':'EURJPY=X',
  'GBP/JPY':'GBPJPY=X','AUD/JPY':'AUDJPY=X','NZD/JPY':'NZDJPY=X','CHF/JPY':'CHFJPY=X',
  'CAD/JPY':'CADJPY=X','EUR/GBP':'EURGBP=X','EUR/CHF':'EURCHF=X','EUR/AUD':'EURAUD=X',
  'EUR/CAD':'EURCAD=X','EUR/NZD':'EURNZD=X','GBP/CHF':'GBPCHF=X','GBP/AUD':'GBPAUD=X',
  'GBP/CAD':'GBPCAD=X','GBP/NZD':'GBPNZD=X','AUD/NZD':'AUDNZD=X','AUD/CAD':'AUDCAD=X',
  'NZD/CAD':'NZDCAD=X','AUD/CHF':'AUDCHF=X','NZD/CHF':'NZDCHF=X','CAD/CHF':'CADCHF=X',
  'BTC/USD':'BTC-USD','ETH/USD':'ETH-USD','SOL/USD':'SOL-USD','GOLD':'GC=F'
};

// ── Indicators ──────────────────────────────────────────────────────────
function ema(arr,p){const k=2/(p+1);let prev=null;const out=[];for(const v of arr){prev=prev==null?v:v*k+prev*(1-k);out.push(prev);}return out;}
function rsi(c,p=14){const out=Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<=p&&i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;out[p]=100-100/(1+(l===0?1e9:g/l));for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];const gn=d>0?d:0,ll=d<0?-d:0;g=(g*(p-1)+gn)/p;l=(l*(p-1)+ll)/p;out[i]=100-100/(1+(l===0?1e9:g/l));}return out;}
function atr(h,l,c,p=14){const tr=[0];for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));const out=Array(c.length).fill(null);let s=0;for(let i=0;i<tr.length;i++){s+=tr[i];if(i>=p)s-=tr[i-p];if(i>=p-1)out[i]=s/p;}return out;}

function pickDirection(ohlc) {
  const n=ohlc.length-1, c=ohlc.map(b=>b.c), cur=c[n];
  const r=rsi(c)[n], e20=ema(c,20)[n], e50=ema(c,50)[n], e200=ema(c,200)[n];
  let bull=0, bear=0;
  if (r!=null) { if(r<35) bull++; else if(r>65) bear++; }
  if (e20>e50) bull++; else if (e20<e50) bear++;
  if (e50>e200) bull++; else if (e50<e200) bear++;
  if (cur>e20) bull++; else if (cur<e20) bear++;
  if (cur>e50) bull++; else if (cur<e50) bear++;
  return bull===bear?null:(bull>bear?'BUY':'SELL');
}

// ── Strategies (simplified mirrors of deployed client logic) ────────────
function momentum(ohlc, dir) {
  const n=ohlc.length-1, c=ohlc.map(b=>b.c);
  const e20=ema(c,20)[n], e50=ema(c,50)[n];
  if(!e20||!e50)return false;
  if(dir==='BUY'&&e20<=e50)return false;
  if(dir==='SELL'&&e20>=e50)return false;
  const last3=ohlc.slice(n-2,n+1);
  const inDir=last3.filter(b=>(dir==='BUY'&&b.c>b.o)||(dir==='SELL'&&b.c<b.o)).length;
  if(inDir<2)return false;
  const rN=rsi(c)[n];
  if(dir==='BUY'&&rN>75)return false;
  if(dir==='SELL'&&rN<25)return false;
  return true;
}
function smc(ohlc, dir) {
  const n=ohlc.length-1;
  const win=ohlc.slice(n-25,n+1);
  const rh=Math.max(...win.map(b=>b.h)),rl=Math.min(...win.map(b=>b.l));
  if(rh-rl<=0)return false;
  const pos=(ohlc[n].c-rl)/(rh-rl);
  if(dir==='BUY'&&pos>0.65)return false;
  if(dir==='SELL'&&pos<0.35)return false;
  const recent=ohlc.slice(n-20,n);
  if(dir==='BUY'){
    const recentLow=Math.min(...recent.map(b=>b.l));
    for(let i=Math.max(0,n-8);i<=n;i++)if(ohlc[i].l<=recentLow*1.0001)return true;
    return false;
  } else {
    const recentHigh=Math.max(...recent.map(b=>b.h));
    for(let i=Math.max(0,n-8);i<=n;i++)if(ohlc[i].h>=recentHigh*0.9999)return true;
    return false;
  }
}
function orb(ohlc, dir) {
  const n=ohlc.length-1; let orIdx=-1;
  for(let i=n;i>=Math.max(0,n-16);i--){const h=new Date(ohlc[i].t).getUTCHours();if(h===8||h===13||h===0){orIdx=i;break;}}
  if(orIdx<0)return false;
  const orh=ohlc[orIdx].h,orl=ohlc[orIdx].l;
  for(let i=orIdx+1;i<=n;i++){
    if(dir==='BUY'&&ohlc[i].c>orh)return true;
    if(dir==='SELL'&&ohlc[i].c<orl)return true;
  }
  return false;
}
function ict(ohlc, dir, pair) {
  const n=ohlc.length-1, h=new Date(ohlc[n].t).getUTCHours();
  const inLondon=h>=6&&h<=11, inNY=h>=11&&h<=16, inAsian=h>=0&&h<=3;
  if(!inLondon&&!inNY&&!(inAsian&&pair.includes('JPY')))return false;
  for(let i=Math.max(2,n-12);i<=n;i++){
    const a=ohlc[i-2],b=ohlc[i-1],c=ohlc[i];
    if(dir==='BUY'&&a.h<=c.l*1.0001&&b.c>b.o)return true;
    if(dir==='SELL'&&a.l>=c.h*0.9999&&b.c<b.o)return true;
  }
  return false;
}
function trendStrat(ohlc, dir) {
  const n=ohlc.length-1, c=ohlc.map(b=>b.c);
  const e50=ema(c,50)[n],e200=ema(c,200)[n];
  if(!e50||!e200)return false;
  const isUp=e50>e200;
  if(dir==='BUY'&&!isUp)return false;
  if(dir==='SELL'&&isUp)return false;
  return Math.abs(e50-e200)/e50>0.0008;
}

function pairCfg(pair) {
  if (pair === 'BTC/USD') return { pip: 1, digits: 2 };
  if (pair === 'ETH/USD') return { pip: 0.1, digits: 2 };
  if (pair === 'SOL/USD') return { pip: 0.01, digits: 2 };
  if (pair === 'GOLD')    return { pip: 0.1, digits: 2 };
  if (pair.includes('JPY')) return { pip: 0.01, digits: 3 };
  return { pip: 0.0001, digits: 5 };
}
function calcLevels(ohlc, dir, pair) {
  const n = ohlc.length - 1;
  const c = ohlc.map(b => b.c), h = ohlc.map(b => b.h), l = ohlc.map(b => b.l);
  const current = c[n];
  const atrV = atr(h, l, c)[n];
  if (!atrV) return null;
  const swingHigh = Math.max(...h.slice(n - 20, n + 1));
  const swingLow  = Math.min(...l.slice(n - 20, n + 1));
  let sl, tp1, tp2, tp3;
  if (dir === 'BUY') {
    const slStr = swingLow - atrV * 0.4;
    const slAtr = current - atrV * 1.5;
    sl = Math.min(slStr, slAtr);
    const d = current - sl;
    tp1 = current + d; tp2 = current + d * 2; tp3 = current + d * 3;
  } else {
    const slStr = swingHigh + atrV * 0.4;
    const slAtr = current + atrV * 1.5;
    sl = Math.max(slStr, slAtr);
    const d = sl - current;
    tp1 = current - d; tp2 = current - d * 2; tp3 = current - d * 3;
  }
  const p = pairCfg(pair);
  const f = v => Number(v.toFixed(p.digits));
  return {
    entry: f(current), sl: f(sl), tp1: f(tp1), tp2: f(tp2), tp3: f(tp3),
    risk_pips: Math.round(Math.abs(current - sl) / p.pip),
  };
}

async function fetchOHLC(origin, sym) {
  const r = await fetch(`${origin}/api/prices?symbol=${sym}`);
  if (!r.ok) return null;
  const d = await r.json();
  return d.ohlc || null;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  const signals = [];

  const results = await Promise.allSettled(
    Object.entries(PAIRS).map(async ([name, sym]) => {
      const ohlc = await fetchOHLC(origin, sym);
      if (!ohlc || ohlc.length < 60) return null;
      const dir = pickDirection(ohlc);
      if (!dir) return null;
      const fires = [];
      if (momentum(ohlc, dir))     fires.push('MOMENTUM');
      if (smc(ohlc, dir))          fires.push('SMC');
      if (orb(ohlc, dir))          fires.push('ORB');
      if (ict(ohlc, dir, name))    fires.push('ICT');
      if (trendStrat(ohlc, dir))   fires.push('TREND');
      if (!fires.length) return null;
      const levels = calcLevels(ohlc, dir, name);
      return { pair: name, direction: dir, strategies: fires, ...levels };
    })
  );
  for (const r of results) if (r.status === 'fulfilled' && r.value) signals.push(r.value);

  signals.sort((a, b) => b.strategies.length - a.strategies.length);

  return new Response(JSON.stringify({
    ts: new Date().toISOString(),
    instruments_scanned: Object.keys(PAIRS).length,
    signals_firing: signals.length,
    signals,
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
