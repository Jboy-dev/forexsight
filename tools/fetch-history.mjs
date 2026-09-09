// v489 — FETCH THE BACKTEST CORPUS IN CI.
//
// The control test and the strategy lab both read data/bt — two years of hourly
// bars per instrument. That directory is gitignored because it is tens of
// megabytes and re-fetchable, which meant CI had nothing to read: both steps
// exited early, and the `|| true` guarding them turned that into silence. The
// control-test.json sitting in the repository was produced on a laptop, not by
// the pipeline, so the guard that is supposed to withdraw the strategy claim if
// it ever stops holding was never actually running.
//
// This fetches the corpus at the start of the run. It is cached by freshness so
// a cycle that already has current data does not re-download 130,000 bars.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';

const PAIRS = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'AUD/USD': 'AUDUSD=X', 'NZD/USD': 'NZDUSD=X',
  'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X', 'USD/JPY': 'USDJPY=X', 'XAU/USD': 'GC=F',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};
const MAX_AGE_H = Number(process.env.HIST_MAX_AGE_H || 20);

mkdirSync('data/bt', { recursive: true });
let fetched = 0, reused = 0, failed = 0;

for (const [pair, sym] of Object.entries(PAIRS)) {
  const path = `data/bt/${pair.replace('/', '-')}.json`;
  if (existsSync(path)) {
    const ageH = (Date.now() - statSync(path).mtimeMs) / 3600000;
    if (ageH < MAX_AGE_H) { reused++; continue; }
  }
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&range=2y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(40000) });
    if (!r.ok) { failed++; console.log(`  ${pair}: HTTP ${r.status}`); continue; }
    const d = await r.json();
    const res = d?.chart?.result?.[0];
    const t = res?.timestamp || [], q = res?.indicators?.quote?.[0];
    if (!q) { failed++; continue; }
    const bars = [];
    for (let i = 0; i < t.length; i++) {
      if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
      bars.push({ t: t[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    }
    if (bars.length < 1000) { failed++; console.log(`  ${pair}: only ${bars.length} bars`); continue; }
    writeFileSync(path, JSON.stringify(bars));
    fetched++;
  } catch (e) { failed++; console.log(`  ${pair}: ${e.message.slice(0, 50)}`); }
}
const have = existsSync('data/bt') ? readdirSync('data/bt').filter(f => f.endsWith('.json')).length : 0;
console.log(`history: ${fetched} fetched, ${reused} still fresh, ${failed} failed — ${have} instrument(s) available`);
// Loud failure: without this corpus the control cannot run, and a control that
// silently does not run is the same as having none.
if (have < 5) { console.error('FATAL: fewer than 5 instruments of history — control test cannot run'); process.exit(1); }
