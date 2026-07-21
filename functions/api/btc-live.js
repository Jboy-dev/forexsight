// /api/btc-live — Dedicated fast-path scan for BTC/USD.
//
// Mirrors /api/gold-live. Pulls the latest BTC signal from KV plus a compact
// technicals summary (live price, day range, swing levels, EMA cross state).
// Cached 15s so UI can poll frequently without blowing KV budget.

const BTC_SYMBOL = 'BTC-USD';
// v320c — bumped 15s → 60s to reduce KV writes (client polls every 25s;
// most polls now hit cache without triggering a KV write).
const CACHE_TTL_SECONDS = 60;

async function _fetchBtcOHLC(origin) {
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(BTC_SYMBOL)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.ohlc) ? data.ohlc : null;
  } catch { return null; }
}

function _summarise(bars) {
  if (!bars || bars.length < 30) return null;
  const recent = bars.slice(-100);
  const closes = recent.map(b => b.c);
  const last = recent[recent.length - 1];
  const livePx = last.c;
  const dayBars = recent.slice(-24);
  const dayOpen = dayBars[0].o;
  const dayHigh = Math.max(...dayBars.map(b => b.h));
  const dayLow  = Math.min(...dayBars.map(b => b.l));
  const dayChange = livePx - dayOpen;
  const dayChangePct = (dayChange / dayOpen) * 100;
  const swingBars = recent.slice(-40);
  const swingHigh = Math.max(...swingBars.map(b => b.h));
  const swingLow  = Math.min(...swingBars.map(b => b.l));
  const first20 = recent.slice(-40, -20).reduce((s, b) => s + b.c, 0) / 20;
  const last20 = recent.slice(-20).reduce((s, b) => s + b.c, 0) / 20;
  const trend = last20 > first20 * 1.001 ? 'UP' : last20 < first20 * 0.999 ? 'DOWN' : 'RANGE';
  const ema9 = _ema(closes, 9);
  const ema21 = _ema(closes, 21);
  const emaSignal = (ema9 && ema21)
    ? (ema9 > ema21 ? 'bullish' : ema9 < ema21 ? 'bearish' : 'neutral')
    : null;
  // Simple ADX proxy — measures directional strength over the last 14 bars.
  // The main scanner uses full ADX; this is a fast approximation.
  const adx14 = _simpleADX(recent.slice(-30));
  return {
    livePrice: livePx,
    dayOpen, dayHigh, dayLow,
    dayChange, dayChangePct,
    swingHigh, swingLow,
    trend,
    ema9, ema21,
    emaSignal,
    adx: adx14,
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
function _simpleADX(bars) {
  if (!bars || bars.length < 15) return null;
  let sumPlus = 0, sumMinus = 0, sumTR = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i-1].h;
    const dn = bars[i-1].l - bars[i].l;
    const plusDM = up > dn && up > 0 ? up : 0;
    const minusDM = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
    sumPlus += plusDM;
    sumMinus += minusDM;
    sumTR += tr;
  }
  if (sumTR === 0) return 0;
  const plusDI = (sumPlus / sumTR) * 100;
  const minusDI = (sumMinus / sumTR) * 100;
  const denom = plusDI + minusDI;
  if (denom === 0) return 0;
  return Math.round((Math.abs(plusDI - minusDI) / denom) * 100);
}

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;

  // v351 — Cache API check (unlimited writes)
  try {
    const { cacheGet } = await import('./_cache-store.js');
    const cached = await cacheGet('btc-live-v1');
    if (cached) {
      const ageSec = Math.round((Date.now() - cached.ts) / 1000);
      if (ageSec < CACHE_TTL_SECONDS) {
        cached.ageSeconds = ageSec;
        cached.cached = true;
        return _json(cached);
      }
    }
  } catch { /* miss OK */ }
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('btc-live-v1');
      if (raw) {
        const cached = JSON.parse(raw);
        const ageSec = Math.round((Date.now() - cached.ts) / 1000);
        if (ageSec < CACHE_TTL_SECONDS) {
          cached.ageSeconds = ageSec;
          cached.cached = true;
          return _json(cached);
        }
      }
    } catch { /* cache miss OK */ }
  }

  const [bars, latestRaw] = await Promise.all([
    _fetchBtcOHLC(origin),
    env.TRADES_KV ? env.TRADES_KV.get('latest-signals').catch(() => null) : Promise.resolve(null),
  ]);
  const summary = _summarise(bars);
  let currentSignal = null;
  if (latestRaw) {
    try {
      const latest = JSON.parse(latestRaw);
      currentSignal = (latest.signals || []).find(s => s && s.pair === 'BTC/USD') || null;
    } catch {}
  }

  const payload = {
    ok: true,
    pair: 'BTC/USD',
    ts: Date.now(),
    isoTime: new Date().toISOString(),
    summary,
    signal: currentSignal,
    cached: false,
  };
  // v351 — Migrated to Cache API (unlimited writes)
  try {
    const { cachePut } = await import('./_cache-store.js');
    await cachePut('btc-live-v1', payload, 60);
  } catch {
    if (env.TRADES_KV) {
      try { await env.TRADES_KV.put('btc-live-v1', JSON.stringify(payload), { expirationTtl: 300 }); } catch {}
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
