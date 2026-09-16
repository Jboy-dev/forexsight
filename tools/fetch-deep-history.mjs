// v499 — fetch the deepest DAILY history available per instrument.
//
// Yahoo silently downsamples when asked for range=max: a request for daily bars
// over twenty years comes back as 275 monthly ones. Explicit period1/period2
// returns the real series — 5,900 daily bars instead of 275. Worth knowing,
// because a backtest run on monthly bars mislabelled as daily would look fine
// and mean nothing.
import { writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'fs';
const PAIRS = { 'EUR/USD':'EURUSD=X','GBP/USD':'GBPUSD=X','AUD/USD':'AUDUSD=X','NZD/USD':'NZDUSD=X',
  'USD/CAD':'USDCAD=X','USD/CHF':'USDCHF=X','USD/JPY':'USDJPY=X','XAU/USD':'GC=F',
  'BTC/USD':'BTC-USD','ETH/USD':'ETH-USD' };
const MAX_AGE_H = Number(process.env.DEEP_MAX_AGE_H || 72);
mkdirSync('data/deep', { recursive: true });
const p1 = Math.floor(new Date('1970-01-01').getTime()/1000), p2 = Math.floor(Date.now()/1000);
let fetched=0, reused=0;
for (const [pair, sym] of Object.entries(PAIRS)) {
  const path = `data/deep/${pair.replace('/','-')}.json`;
  if (existsSync(path) && (Date.now()-statSync(path).mtimeMs)/3600000 < MAX_AGE_H) { reused++; continue; }
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=${p1}&period2=${p2}`,
      { headers:{'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(45000) });
    if (!r.ok) { console.log(`  ${pair}: HTTP ${r.status}`); continue; }
    const d = await r.json(); const res = d?.chart?.result?.[0];
    const t = res?.timestamp||[], q = res?.indicators?.quote?.[0];
    if (!q) continue;
    const bars=[];
    for (let i=0;i<t.length;i++){
      if (q.open[i]==null||q.high[i]==null||q.low[i]==null||q.close[i]==null) continue;
      bars.push({t:t[i]*1000,o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i]});
    }
    if (bars.length < 600) { console.log(`  ${pair}: only ${bars.length} bars`); continue; }
    writeFileSync(path, JSON.stringify(bars)); fetched++;
  } catch(e){ console.log(`  ${pair}: ${e.message.slice(0,45)}`); }
}
const have = readdirSync('data/deep').filter(f=>f.endsWith('.json')).length;
console.log(`deep history: ${fetched} fetched, ${reused} still fresh — ${have} instruments`);
