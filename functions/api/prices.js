// Cloudflare Pages Function: GET /api/prices?symbol=EURUSD=X
// Tries Yahoo Finance, falls back to Twelve Data. Response cached at the CF edge
// for 10 minutes via Cache-Control s-maxage. Serves stale for 1 hour on upstream
// failures.

const YAHOO_HOSTS = [
  'https://query2.finance.yahoo.com',
  'https://query1.finance.yahoo.com',
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function yahooFetch(symbol, interval, range) {
  let lastErr = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        cf: { cacheTtl: 300, cacheEverything: true },
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) { lastErr = `${host} HTTP ${res.status}`; continue; }
      const data = await res.json();
      const chart = data?.chart?.result?.[0];
      if (!chart) { lastErr = `${host} no chart`; continue; }
      const ts = chart.timestamp || [];
      const q = chart.indicators?.quote?.[0] || {};
      const ohlc = ts.map((t, i) => ({
        t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i],
      })).filter(x => x.c != null && x.o != null && x.h != null && x.l != null);
      if (ohlc.length >= 60) return ohlc;
      lastErr = `${host} only ${ohlc.length} bars`;
    } catch (e) { lastErr = `${host} ${e.message}`; }
  }
  throw new Error(lastErr || 'yahoo failed');
}

async function twelveDataFetch(symbol, interval, apiKey) {
  const tdSymbol = symbol.replace('=X', '').replace(/(.{3})(.{3})/, '$1/$2');
  const intervalMap = { '1h': '1h', '30m': '30min', '1d': '1day' };
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${intervalMap[interval] || '1h'}&outputsize=1500&apikey=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`twelvedata HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(`twelvedata: ${data.message}`);
  const values = data.values || [];
  return values.reverse().map(v => ({
    t: new Date(v.datetime).getTime(),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
  })).filter(x => !isNaN(x.c));
}

// v319 — Kraken OHLC for BTC. US-based, free, no API key, doesn't block
// Cloudflare Worker IPs (unlike Binance which returns 403).
async function krakenBtcFetch() {
  const url = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    cf: { cacheTtl: 60, cacheEverything: true },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`kraken HTTP ${res.status}`);
  const data = await res.json();
  if (data.error && data.error.length) throw new Error(`kraken: ${data.error.join(',')}`);
  const key = Object.keys(data.result || {}).find(k => k !== 'last');
  if (!key) throw new Error('kraken no pair key');
  const rows = data.result[key];
  if (!Array.isArray(rows) || !rows.length) throw new Error('kraken empty');
  // Kraken format: [ts, o, h, l, c, vwap, volume, count]
  return rows.map(r => ({
    t: r[0] * 1000,
    o: +r[1],
    h: +r[2],
    l: +r[3],
    c: +r[4],
  })).filter(x => Number.isFinite(x.c));
}

// v319 — Bitstamp OHLC for BTC. US-based fallback if Kraken fails.
async function bitstampBtcFetch(limit = 1000) {
  const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=3600&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    cf: { cacheTtl: 60, cacheEverything: true },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`bitstamp HTTP ${res.status}`);
  const data = await res.json();
  const rows = data.data?.ohlc;
  if (!Array.isArray(rows) || !rows.length) throw new Error('bitstamp empty');
  return rows.map(r => ({
    t: parseInt(r.timestamp, 10) * 1000,
    o: +r.open,
    h: +r.high,
    l: +r.low,
    c: +r.close,
  })).filter(x => Number.isFinite(x.c));
}

// v319 — CoinGecko OHLC for BTC (free, real-time, no API key).
// Kept as secondary fallback. Rate-limits CF Workers hard.
async function coingeckoBtcFetch(days = 90) {
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    // v319 — Cache market_chart at CF edge for 5 minutes. Free tier limit
    // is 10-30 req/min; caching means we hit CoinGecko ~12 times/hour
    // instead of hundreds. Data is hourly so 5-min cache never causes stale.
    cf: { cacheTtl: 300, cacheEverything: true },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
  const data = await res.json();
  const prices = data.prices || [];
  if (!prices.length) throw new Error('coingecko empty');
  // CoinGecko gives close prices only — reconstruct O/H/L from adjacent points.
  // For 1H bars, this is close enough since crypto moves fast within the hour.
  const ohlc = [];
  for (let i = 0; i < prices.length; i++) {
    const [t, c] = prices[i];
    const prevC = i > 0 ? prices[i - 1][1] : c;
    // Approximate H/L as ±0.3% around close (typical BTC 1H wick range)
    // and O as prev close. Good enough for indicators; TP/SL crossing
    // still detected on close value.
    ohlc.push({ t, o: prevC, h: Math.max(c, prevC) * 1.003, l: Math.min(c, prevC) * 0.997, c });
  }
  // Also fetch current spot for the freshest last bar
  try {
    const spotRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_high=true&include_24hr_low=true', {
      // Spot price cached 60s — real-time enough for TP checks, well within rate limits
      cf: { cacheTtl: 60, cacheEverything: true },
      signal: AbortSignal.timeout(5000),
    });
    if (spotRes.ok) {
      const spot = await spotRes.json();
      const price = spot.bitcoin?.usd;
      if (price) {
        const now = Date.now();
        ohlc.push({
          t: now,
          o: ohlc.length ? ohlc[ohlc.length - 1].c : price,
          h: spot.bitcoin.usd_24h_high || price,
          l: spot.bitcoin.usd_24h_low || price,
          c: price,
        });
      }
    }
  } catch { /* spot is optional bonus */ }
  return ohlc;
}

// v319 — Detect stale price data. If the last bar is > `maxAgeMinutes` old,
// return true so we try a different source. Yahoo BTC-USD was returning
// data 2500+ minutes (42h) stale intermittently — this catches it.
function _isDataStale(ohlc, maxAgeMinutes) {
  if (!ohlc || !ohlc.length) return true;
  const lastMs = ohlc[ohlc.length - 1].t;
  const ageMin = (Date.now() - lastMs) / 60000;
  return ageMin > maxAgeMinutes;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  // v306 — Validate symbol input. Allow only alphanumeric, hyphens, dots,
  // equals signs (Yahoo format) — nothing else. Prevents malformed queries
  // reaching Yahoo AND makes it clear when caller forgot the param.
  const rawSymbol = url.searchParams.get('symbol');
  const symbol = (rawSymbol || 'EURUSD=X').toUpperCase();
  const symbolClean = /^[A-Z0-9=^.\-_]+$/i.test(symbol) ? symbol : null;
  const interval = url.searchParams.get('interval') || '1h';
  const range = url.searchParams.get('range') || '3mo';

  // Bad symbol format — return 200 with empty ohlc + error, so downstream
  // code (correlation-check, predict-next, chart-bot) can gracefully
  // degrade instead of cascading failures.
  if (!symbolClean) {
    return new Response(JSON.stringify({
      symbol: rawSymbol, interval, range,
      ohlc: [], count: 0, source: 'invalid-symbol',
      error: 'Symbol contains invalid characters. Only A-Z, 0-9, =, ^, ., -, _ allowed.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=3600' },
    });
  }

  // Edge cache lookup — v319 bumped cache-version so old stale-Yahoo cached
  // responses (from before Kraken was primary) are invalidated on deploy.
  const CACHE_VERSION = 'v319';
  const cache = caches.default;
  const cacheKeyUrl = new URL(url.toString());
  cacheKeyUrl.searchParams.set('_cv', CACHE_VERSION);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) {
    const copy = new Response(cached.body, cached);
    copy.headers.set('x-cf-cache', 'HIT');
    return copy;
  }

  const errors = [];
  let result = null;

  // v319 — For BTC, we now use Kraken as primary (US-based, allows CF
  // Workers, ~720 bars of hourly data). Bitstamp as secondary. CoinGecko
  // as last resort. Binance blocks CF (403), Yahoo intermittently 42h stale.
  const isBTC = symbol === 'BTC-USD' || symbol === 'BTCUSD=X';
  if (isBTC) {
    try {
      const ohlc = await krakenBtcFetch();
      if (ohlc.length >= 60 && !_isDataStale(ohlc, 30)) {
        result = { symbol, interval, range, ohlc, count: ohlc.length, source: 'kraken' };
      } else errors.push(`kraken: ${ohlc.length < 60 ? 'thin' : 'stale'}`);
    } catch (e) { errors.push('kraken: ' + e.message); }
    if (!result) {
      try {
        const ohlc = await bitstampBtcFetch(1000);
        if (ohlc.length >= 60 && !_isDataStale(ohlc, 30)) {
          result = { symbol, interval, range, ohlc, count: ohlc.length, source: 'bitstamp' };
        } else errors.push(`bitstamp: ${ohlc.length < 60 ? 'thin' : 'stale'}`);
      } catch (e) { errors.push('bitstamp: ' + e.message); }
    }
    if (!result) {
      try {
        const days = range === '1d' ? 1 : range === '5d' ? 5 : 90;
        const ohlc = await coingeckoBtcFetch(days);
        if (ohlc.length >= 60 && !_isDataStale(ohlc, 60)) {
          result = { symbol, interval, range, ohlc, count: ohlc.length, source: 'coingecko' };
        } else errors.push(`coingecko: ${ohlc.length < 60 ? 'thin' : 'stale'}`);
      } catch (e) { errors.push('coingecko: ' + e.message); }
    }
  }

  if (!result) {
    try {
      const ohlc = await yahooFetch(symbol, interval, range);
      // v319 — Reject stale Yahoo data. If BTC is >60 min stale we prefer no
      // data over wrong data (downstream will use whatever it can).
      const staleThreshold = isBTC ? 60 : (symbol === 'GC=F' ? 240 : 240);
      if (!_isDataStale(ohlc, staleThreshold)) {
        result = { symbol, interval, range, ohlc, count: ohlc.length, source: 'yahoo' };
      } else {
        const ageMin = ((Date.now() - ohlc[ohlc.length - 1].t) / 60000).toFixed(0);
        errors.push(`yahoo: stale (${ageMin}min > ${staleThreshold}min threshold)`);
      }
    } catch (e) { errors.push('yahoo: ' + e.message); }
  }

  if (!result && env.TWELVE_DATA_KEY) {
    try {
      const ohlc = await twelveDataFetch(symbol, interval, env.TWELVE_DATA_KEY);
      if (ohlc.length >= 60) {
        result = { symbol, interval, range, ohlc, count: ohlc.length, source: 'twelvedata' };
      } else errors.push('twelvedata: thin data');
    } catch (e) { errors.push('twelvedata: ' + e.message); }
  } else if (!result) {
    errors.push('no TWELVE_DATA_KEY configured');
  }

  if (!result) {
    // v306 — HARDENING: never 503. Return 200 with empty ohlc + error.
    // The old 503 cascaded to every consumer (correlation-check,
    // predict-next, chart-bot) causing silent breakage. Now callers get
    // an obvious empty-ohlc signal and can degrade gracefully.
    return new Response(JSON.stringify({
      symbol, interval, range,
      ohlc: [], count: 0, source: 'upstream-failed',
      error: 'All price sources unavailable',
      detail: errors,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short cache (30s) so we retry quickly when Yahoo comes back.
        'Cache-Control': 'public, s-maxage=30',
        'x-cf-cache': 'MISS-FALLBACK',
      },
    });
  }

  const response = new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=600, max-age=60, stale-while-revalidate=3600',
      'x-cf-cache': 'MISS',
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
