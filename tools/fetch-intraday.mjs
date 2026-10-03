#!/usr/bin/env node
/**
 * fetch-intraday.mjs — the deep intraday foundation.
 *
 * Every backtest in this project ran on DAILY bars. The site signals on H1. So
 * nothing measured so far actually tested what the site does — a daily-bar
 * result says little about an hourly rule, and the 523 hourly bars the project
 * published (30 days) could not establish anything either way.
 *
 * Yahoo's depth is not what the obvious parameter suggests. Measured:
 *   range=60d   1h ->  1,440 bars (82d)
 *   range=1y    1h ->  6,264 bars (365d)
 *   range=2y    1h -> 12,528 bars (730d)
 *   range=730d  1h -> 17,520 bars (1,019d)   <- the real ceiling, and 2y != 730d
 * So 730d is used literally rather than as "2 years", because it returns 40%
 * more history than the 2y alias does.
 *
 * Writes data/intraday/<PAIR>.<TF>.json. Refuses to overwrite a good cache with
 * a thinner answer, because a bad fetch that silently truncates history is
 * worse than no fetch at all.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

const OUT = 'data/intraday';
const PAIRS = {
  'EUR-USD': 'EURUSD=X', 'GBP-USD': 'GBPUSD=X', 'AUD-USD': 'AUDUSD=X', 'NZD-USD': 'NZDUSD=X',
  'USD-JPY': 'USDJPY=X', 'USD-CHF': 'USDCHF=X', 'USD-CAD': 'USDCAD=X',
  'XAU-USD': 'GC=F',     'BTC-USD': 'BTC-USD',  'ETH-USD': 'ETH-USD',

  'XAG-USD': 'SI=F', 'EUR-GBP': 'EURGBP=X', 'EUR-JPY': 'EURJPY=X', 'GBP-JPY': 'GBPJPY=X',
  'AUD-JPY': 'AUDJPY=X', 'US30': '^DJI', 'NAS100': '^NDX', 'SOL-USD': 'SOL-USD', 'XRP-USD': 'XRP-USD',};
// Each timeframe with the range that actually returns the most, not the one
// that reads most naturally.
const TFS = [
  { tf: '1h',  range: '730d' },
  { tf: '15m', range: '60d'  },
];

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOne(sym, tf, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`
            + `?interval=${tf}&range=${range}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { await sleep(1200 * (attempt + 1)); continue; }
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      const ts = res?.timestamp, q = res?.indicators?.quote?.[0];
      if (!ts || !q) { await sleep(1200 * (attempt + 1)); continue; }
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
        if ([o, h, l, c].some(v => typeof v !== 'number' || !isFinite(v) || v <= 0)) continue;
        // A bar whose high is below its low, or whose close sits outside the
        // range, is corrupt. Keeping it would put impossible prices into the
        // backtest and the backtest would happily trade them.
        if (h < l || c > h || c < l || o > h || o < l) continue;
        bars.push({ t: ts[i] * 1000, o, h, l, c });
      }
      return bars;
    } catch (_) { await sleep(1200 * (attempt + 1)); }
  }
  return null;
}

let wrote = 0, kept = 0, failed = 0;
for (const [pair, sym] of Object.entries(PAIRS)) {
  for (const { tf, range } of TFS) {
    const path = `${OUT}/${pair}.${tf}.json`;
    const bars = await fetchOne(sym, tf, range);
    if (!bars || bars.length < 100) { console.log(`  ${pair} ${tf}: fetch failed`); failed++; await sleep(400); continue; }

    let have = 0;
    try { have = JSON.parse(readFileSync(path, 'utf8')).length; } catch {}
    // Never trade depth away. A thinner answer than what is on disk means the
    // upstream had a bad day, not that history got shorter.
    if (have > bars.length * 1.05) {
      console.log(`  ${pair} ${tf}: kept ${have} on disk (fetch only returned ${bars.length})`);
      kept++; await sleep(400); continue;
    }
    writeFileSync(path, JSON.stringify(bars));
    const days = (bars[bars.length - 1].t - bars[0].t) / 864e5;
    console.log(`  ${pair} ${tf}: ${bars.length.toLocaleString()} bars, ${days.toFixed(0)} days`);
    wrote++;
    await sleep(400);
  }
}
const files = readdirSync(OUT).filter(f => f.endsWith('.json'));
const total = files.reduce((s, f) => { try { return s + JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')).length; } catch { return s; } }, 0);
console.log(`\nintraday: ${wrote} written, ${kept} kept, ${failed} failed — ${files.length} caches, ${total.toLocaleString()} bars total`);
