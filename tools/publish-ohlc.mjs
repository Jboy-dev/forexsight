// v454 — PUBLISH REAL BARS TO THE STATIC MIRROR.
//
// The trade monitor needs candles, not just a current price. It needs to see
// the high and low over the whole life of an open trade, because that is the
// only way to know whether a stop or target was touched while nobody was
// looking. With Cloudflare Functions down, /api/prices cannot supply that,
// and the browser cannot fetch Yahoo directly (no CORS headers).
//
// So the bars are fetched here, on the GitHub Actions runner where CORS does
// not apply, and written to data/ohlc/<pair>.json. Cloudflare Pages serves
// those as static assets — same origin as the app, unlimited quota, no
// Functions involved — so the client gets true bar history regardless.
//
// This is what stops a trade that hit its target overnight from being written
// down as a loss the next morning because the app only saw today's price.
//
//   node tools/publish-ohlc.mjs
//   node tools/publish-ohlc.mjs --dry-run

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';

const PAIRS = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'NZD/USD': 'NZDUSD=X',
  'USD/CHF': 'USDCHF=X', 'XAU/USD': 'GC=F',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};

// 14 days of hourly bars. Long enough to cover any trade the app would still
// consider open (the longest time-stop is 4h, and expiry is 48h) with a wide
// margin, while keeping each file small enough to commit every cycle.
const RANGE = '14d';
const DRY = process.argv.includes('--dry-run');

export const slugFor = (pair) => pair.replace('/', '-');

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
            + `?interval=1h&range=${RANGE}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error('no result');
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some(v => v == null || !Number.isFinite(v))) continue;
    // Round to the instrument's meaningful precision to keep files compact.
    const dp = symbol.includes('JPY') ? 3 : (symbol === 'GC=F' || symbol.includes('-USD')) ? 2 : 5;
    bars.push({ t: ts[i] * 1000, o: +o.toFixed(dp), h: +h.toFixed(dp), l: +l.toFixed(dp), c: +c.toFixed(dp) });
  }
  return bars;
}

const summary = [];
let wrote = 0;

if (!DRY) mkdirSync('data/ohlc', { recursive: true });

await Promise.all(Object.entries(PAIRS).map(async ([pair, sym]) => {
  try {
    const bars = await fetchBars(sym);
    if (bars.length < 24) { summary.push(`${pair}: only ${bars.length} bars — skipped`); return; }
    const ageMin = Math.round((Date.now() - bars[bars.length - 1].t) / 60000);
    const payload = {
      pair, symbol: sym,
      ts: Date.now(),
      isoTime: new Date().toISOString(),
      count: bars.length,
      firstBar: bars[0].t,
      lastBar: bars[bars.length - 1].t,
      lastBarAgeMinutes: ageMin,
      ohlc: bars,
      note: 'Hourly bars published by tools/publish-ohlc.mjs so the client can '
          + 'verify stop/target touches over a trade\'s full life without the '
          + 'live API. Served as a static asset.',
    };
    // v465 — only rewrite when the newest bar has actually advanced.
    //
    // These files are republished on every watch cycle, roughly 48 times a
    // day. When the last bar is unchanged the rewrite still produces a new
    // git object, so the repository was growing by megabytes a week to record
    // that nothing happened. Markets close at weekends and quiet hours repeat
    // the same final bar, so a large share of those writes carried no news.
    const _path = `data/ohlc/${slugFor(pair)}.json`;
    let _changed = true;
    if (existsSync(_path)) {
      try {
        const prev = JSON.parse(readFileSync(_path, 'utf8'));
        const prevBars = Array.isArray(prev) ? prev : (prev.bars || prev.ohlc || []);
        const newBars = Array.isArray(payload) ? payload : (payload.bars || payload.ohlc || []);
        const a = prevBars[prevBars.length - 1], b = newBars[newBars.length - 1];
        if (a && b && a.t === b.t && a.c === b.c && prevBars.length === newBars.length) _changed = false;
      } catch { /* unreadable previous file — rewrite it */ }
    }
    if (!DRY && _changed) writeFileSync(_path, JSON.stringify(payload));
    if (!_changed) console.log(`  = ${pair} unchanged, not rewritten`);
    wrote++;
    summary.push(`${pair}: ${bars.length} bars, last ${ageMin}min old`);
  } catch (e) {
    summary.push(`${pair}: FAILED ${e.message}`);
  }
}));

summary.sort();
for (const line of summary) console.log('  ' + line);
console.log(`${DRY ? '[dry-run] would write' : 'wrote'} ${wrote} file(s) to data/ohlc/`);
