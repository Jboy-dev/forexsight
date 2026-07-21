// /api/gold-live — Dedicated fast-path scan for XAU/USD.
//
// Full /api/check-signals scans all 8 pairs + brain gate + news + correlation
// (~10-20 seconds). This endpoint touches only XAU/USD, no expensive checks,
// returns in ~1-2 seconds. Client rapid-polls it every 25 s when the Signals
// tab is visible so gold price + fresh signal state is always current.
//
// Cache: 15 s KV TTL — one write per 15s window per app instance keeps the
// KV budget minimal while feeling live. Skips the write if the cached value
// is fresh enough for the current poll.

const XAU_SYMBOL = 'GC=F';
// v320c — bumped 15s → 60s to reduce KV write pressure. Client polls
// every 25s; with 60s cache most polls hit cache = no KV write.
const CACHE_TTL_SECONDS = 60;

async function _fetchGoldOHLC(origin) {
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(XAU_SYMBOL)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.ohlc) ? data.ohlc : null;
  } catch { return null; }
}

// Compact technicals — same maths as v291's compute but scoped to what the
// Signals tab surfaces on the gold card (price, day range, swing levels,
// HTF trend, current signal-like state).
function _summarise(bars) {
  if (!bars || bars.length < 30) return null;
  const recent = bars.slice(-100);
  const closes = recent.map(b => b.c);
  const highs  = recent.map(b => b.h);
  const lows   = recent.map(b => b.l);
  const last = recent[recent.length - 1];
  const livePx = last.c;
  const dayBars = recent.slice(-24);
  const dayOpen = dayBars[0].o;
  const dayHigh = Math.max(...dayBars.map(b => b.h));
  const dayLow  = Math.min(...dayBars.map(b => b.l));
  const dayChange = livePx - dayOpen;
  const dayChangePct = (dayChange / dayOpen) * 100;
  // Swing levels over the last 40 bars
  const swingBars = recent.slice(-40);
  const swingHigh = Math.max(...swingBars.map(b => b.h));
  const swingLow  = Math.min(...swingBars.map(b => b.l));
  // Simple trend read
  const first20 = recent.slice(-40, -20).reduce((s, b) => s + b.c, 0) / 20;
  const last20 = recent.slice(-20).reduce((s, b) => s + b.c, 0) / 20;
  const trend = last20 > first20 * 1.001 ? 'UP' : last20 < first20 * 0.999 ? 'DOWN' : 'RANGE';
  // 1H EMA cross state — tells us momentum without expensive full compute
  const ema9 = _ema(closes, 9);
  const ema21 = _ema(closes, 21);
  const emaSignal = (ema9 && ema21)
    ? (ema9 > ema21 ? 'bullish' : ema9 < ema21 ? 'bearish' : 'neutral')
    : null;
  return {
    livePrice: livePx,
    dayOpen, dayHigh, dayLow,
    dayChange, dayChangePct,
    swingHigh, swingLow,
    trend,
    ema9, ema21,
    emaSignal,
    lastBar: { o: last.o, h: last.h, l: last.l, c: last.c },
    barsAnalysed: recent.length,
  };
}
function _ema(arr, p) {
  if (!arr || arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // v351 — Cache API check (unlimited). Falls back to KV for old records.
  try {
    const { cacheGet } = await import('./_cache-store.js');
    const cached = await cacheGet('gold-live-v1');
    if (cached) {
      const ageSec = Math.round((Date.now() - cached.ts) / 1000);
      if (ageSec < CACHE_TTL_SECONDS) {
        cached.ageSeconds = ageSec;
        cached.cached = true;
        return _json(cached);
      }
    }
  } catch { /* cache miss OK */ }
  // KV fallback for any old data still there
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('gold-live-v1');
      if (raw) {
        const cached = JSON.parse(raw);
        const ageSec = Math.round((Date.now() - cached.ts) / 1000);
        if (ageSec < CACHE_TTL_SECONDS) {
          cached.ageSeconds = ageSec;
          cached.cached = true;
          return _json(cached);
        }
      }
    } catch { /* miss OK */ }
  }

  // Pull the freshest gold OHLC + the shared /latest-signals snapshot to
  // find any XAU/USD signal the main scan produced. This is the "current
  // gold state" view the client shows on tab-open and every 25s poll.
  const [bars, latestRaw] = await Promise.all([
    _fetchGoldOHLC(origin),
    env.TRADES_KV ? env.TRADES_KV.get('latest-signals').catch(() => null) : Promise.resolve(null),
  ]);
  const summary = _summarise(bars);
  let currentSignal = null;
  if (latestRaw) {
    try {
      const latest = JSON.parse(latestRaw);
      currentSignal = (latest.signals || []).find(s => s && s.pair === 'XAU/USD') || null;
    } catch {}
  }

  const payload = {
    ok: true,
    pair: 'XAU/USD',
    ts: Date.now(),
    isoTime: new Date().toISOString(),
    summary,
    signal: currentSignal,
    cached: false,
  };
  // v351 — Migrated from KV to Cache API. Client polls every 25s; cache
  // hits keep KV writes near zero.
  try {
    const { cachePut } = await import('./_cache-store.js');
    await cachePut('gold-live-v1', payload, 60);
  } catch {
    if (env.TRADES_KV) {
      try { await env.TRADES_KV.put('gold-live-v1', JSON.stringify(payload), { expirationTtl: 300 }); } catch {}
    }
  }
  payload.ageSeconds = 0;
  return _json(payload);
}

function _json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  });
}
