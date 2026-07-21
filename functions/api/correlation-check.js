// /api/correlation-check?pair=XAU/USD — Cross-checks a signal against its
// institutional correlation basket. Every serious quant desk runs this on
// every trade: is the underlying macro backdrop actually supporting the
// direction you're taking?
//
// For each pair we define a basket of correlated instruments (Dollar Index,
// yields, related crosses, risk-on/risk-off proxies). We fetch each,
// compute their recent 1H direction, then score how well the target signal
// aligns with what the basket is doing.
//
// Output:
//   {
//     pair: 'XAU/USD',
//     basket: [
//       { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', direction: 'up',
//         changePct: +0.42, corrType: 'negative',
//         supports: { BUY: false, SELL: true } },
//       ...
//     ],
//     buyConfluence: 45,    // 0-100
//     sellConfluence: 55,   // 0-100
//     buySupport: -2,       // net weighted alignment for a BUY
//     sellSupport: +2,      // net weighted alignment for a SELL
//     summary: "DXY strong (opposes BUY), yields rising (opposes BUY), silver rising (supports BUY)..."
//   }
//
// Cached to KV 3 min so we don't fetch 6 instruments on every scan tick.

const CACHE_TTL_SECONDS = 180;

// Correlation baskets — each entry: { symbol, label, corrType, weight }
// corrType: 'positive' = target moves WITH this instrument
//           'negative' = target moves AGAINST this instrument
// weight: how much this instrument matters (0.0 - 1.0)
const BASKETS = {
  'XAU/USD': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 1.0 },
    { symbol: '^TNX',     label: 'US 10Y Treasury Yield', corrType: 'negative', weight: 0.9 },
    { symbol: 'SI=F',     label: 'Silver',                corrType: 'positive', weight: 0.6 },
    { symbol: '^GSPC',    label: 'S&P 500 (risk-on)',     corrType: 'negative', weight: 0.4 },
    { symbol: 'HG=F',     label: 'Copper',                corrType: 'positive', weight: 0.3 },
  ],
  'XAG/USD': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 0.9 },
    { symbol: 'GC=F',     label: 'Gold',                  corrType: 'positive', weight: 0.9 },
    { symbol: '^TNX',     label: 'US 10Y Yield',          corrType: 'negative', weight: 0.6 },
    { symbol: 'HG=F',     label: 'Copper',                corrType: 'positive', weight: 0.6 },
  ],
  'EUR/USD': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 1.0 },
    { symbol: 'EURGBP=X', label: 'EUR/GBP (EUR strength)', corrType: 'positive', weight: 0.7 },
    { symbol: 'EURJPY=X', label: 'EUR/JPY (EUR strength)', corrType: 'positive', weight: 0.7 },
    { symbol: '^GDAXI',   label: 'DAX (EUR risk-on)',     corrType: 'positive', weight: 0.4 },
  ],
  'GBP/USD': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 1.0 },
    { symbol: 'EURGBP=X', label: 'EUR/GBP (inv GBP)',     corrType: 'negative', weight: 0.7 },
    { symbol: 'GBPJPY=X', label: 'GBP/JPY (GBP strength)', corrType: 'positive', weight: 0.7 },
    { symbol: '^FTSE',    label: 'FTSE 100',              corrType: 'positive', weight: 0.4 },
  ],
  'USD/JPY': [
    { symbol: '^TNX',     label: 'US 10Y Yield',          corrType: 'positive', weight: 1.0 },
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'positive', weight: 0.9 },
    { symbol: '^N225',    label: 'Nikkei 225',            corrType: 'positive', weight: 0.6 },
    { symbol: 'GC=F',     label: 'Gold (risk-off)',       corrType: 'negative', weight: 0.4 },
  ],
  'AUD/USD': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 1.0 },
    { symbol: 'HG=F',     label: 'Copper',                corrType: 'positive', weight: 0.8 },
    { symbol: 'NZDUSD=X', label: 'NZD/USD (paired)',      corrType: 'positive', weight: 0.7 },
    { symbol: '^GSPC',    label: 'S&P 500 (risk-on)',     corrType: 'positive', weight: 0.5 },
  ],
  'NZD/USD': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 1.0 },
    { symbol: 'AUDUSD=X', label: 'AUD/USD (paired)',      corrType: 'positive', weight: 0.8 },
    { symbol: '^GSPC',    label: 'S&P 500 (risk-on)',     corrType: 'positive', weight: 0.5 },
  ],
  'USD/CAD': [
    { symbol: 'CL=F',     label: 'WTI Crude Oil',         corrType: 'negative', weight: 0.9 },
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'positive', weight: 0.8 },
    { symbol: 'BZ=F',     label: 'Brent Crude',           corrType: 'negative', weight: 0.6 },
  ],
  'USD/CHF': [
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'positive', weight: 1.0 },
    { symbol: 'GC=F',     label: 'Gold (CHF proxy)',      corrType: 'negative', weight: 0.5 },
    { symbol: '^GSPC',    label: 'S&P 500 (risk-on)',     corrType: 'positive', weight: 0.4 },
  ],
  'BTC/USD': [
    { symbol: 'ETH-USD',  label: 'Ethereum',              corrType: 'positive', weight: 1.0 },
    { symbol: '^GSPC',    label: 'S&P 500 (risk-on)',     corrType: 'positive', weight: 0.5 },
    { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 0.4 },
  ],
  'ETH/USD': [
    { symbol: 'BTC-USD',  label: 'Bitcoin',               corrType: 'positive', weight: 1.0 },
    { symbol: '^GSPC',    label: 'S&P 500 (risk-on)',     corrType: 'positive', weight: 0.5 },
  ],
};

// Same-direction fallback so pairs we don't have baskets for still get
// some cross-validation via DXY only.
const DEFAULT_BASKET = [
  { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', corrType: 'negative', weight: 0.7 },
];

// Compute 1H direction over the last N bars. Returns {direction, changePct}.
// Uses the same OHLC feed the brain and chart-bot use.
async function _fetchDirection(origin, symbol) {
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return { direction: 'unknown', changePct: 0, error: `status ${res.status}` };
    const data = await res.json();
    const bars = data.ohlc || [];
    if (bars.length < 6) return { direction: 'unknown', changePct: 0, error: 'insufficient bars' };
    // Use the last 6 bars (~6 hours) to determine short-term direction. This
    // window matches typical intraday signal duration.
    const window = bars.slice(-6);
    const first = window[0].c;
    const last = window[window.length - 1].c;
    const changePct = ((last - first) / first) * 100;
    // A meaningful move is > 0.10% for forex, > 0.15% for indices/metals.
    // Below that we call it flat — noise, not a directional signal.
    const threshold = Math.abs(first) > 100 ? 0.15 : 0.10;
    let direction = 'flat';
    if (changePct > threshold) direction = 'up';
    else if (changePct < -threshold) direction = 'down';
    return { direction, changePct: +changePct.toFixed(3) };
  } catch (e) {
    return { direction: 'unknown', changePct: 0, error: e.message || String(e) };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pair = (url.searchParams.get('pair') || 'XAU/USD').toUpperCase();
  const cacheKey = `correlation:${pair}`;

  // KV cache check
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw);
        const ageSec = Math.round((Date.now() - cached.ts) / 1000);
        if (ageSec < CACHE_TTL_SECONDS) {
          cached.ageSeconds = ageSec;
          return _json(cached);
        }
      }
    } catch { /* cache miss OK */ }
  }

  const basket = BASKETS[pair] || DEFAULT_BASKET;
  const origin = `${url.protocol}//${url.host}`;

  // Fetch all basket instruments in parallel
  const results = await Promise.all(basket.map(async (entry) => {
    const dir = await _fetchDirection(origin, entry.symbol);
    // Does this instrument's current move SUPPORT a BUY on the target pair?
    // If corrType = 'positive' and instrument = 'up', that supports BUY.
    // If corrType = 'negative' and instrument = 'down', that supports BUY.
    let supportsBuy = null;
    let supportsSell = null;
    if (dir.direction === 'up') {
      supportsBuy = entry.corrType === 'positive';
      supportsSell = entry.corrType === 'negative';
    } else if (dir.direction === 'down') {
      supportsBuy = entry.corrType === 'negative';
      supportsSell = entry.corrType === 'positive';
    }
    return {
      symbol: entry.symbol,
      label: entry.label,
      corrType: entry.corrType,
      weight: entry.weight,
      direction: dir.direction,
      changePct: dir.changePct,
      supportsBuy,
      supportsSell,
      error: dir.error || null,
    };
  }));

  // Weighted alignment score
  let buySupport = 0, sellSupport = 0, totalWeight = 0;
  const supportingBuy = [], supportingSell = [], opposingBuy = [], opposingSell = [];
  for (const r of results) {
    if (r.direction === 'unknown' || r.direction === 'flat') continue;
    totalWeight += r.weight;
    if (r.supportsBuy === true)  { buySupport  += r.weight; supportingBuy.push(r); opposingSell.push(r); }
    if (r.supportsBuy === false) { buySupport  -= r.weight; opposingBuy.push(r);   supportingSell.push(r); }
    if (r.supportsSell === true)  sellSupport += r.weight;
    if (r.supportsSell === false) sellSupport -= r.weight;
  }
  const buyConfluence  = totalWeight > 0 ? Math.round(50 + (buySupport  / totalWeight) * 50) : 50;
  const sellConfluence = totalWeight > 0 ? Math.round(50 + (sellSupport / totalWeight) * 50) : 50;

  // Build a human-readable summary
  const parts = [];
  for (const r of results) {
    if (r.direction === 'unknown') continue;
    if (r.direction === 'flat') { parts.push(`${r.label} flat`); continue; }
    const arrow = r.direction === 'up' ? '↑' : '↓';
    parts.push(`${r.label} ${arrow}${Math.abs(r.changePct).toFixed(2)}%`);
  }
  const summary = parts.join(', ');

  const payload = {
    pair,
    basketSize: basket.length,
    basket: results,
    buyConfluence,
    sellConfluence,
    buySupport: +buySupport.toFixed(2),
    sellSupport: +sellSupport.toFixed(2),
    supportingBuy: supportingBuy.map(r => r.label),
    opposingBuy: opposingBuy.map(r => r.label),
    supportingSell: supportingSell.map(r => r.label),
    opposingSell: opposingSell.map(r => r.label),
    summary,
    ts: Date.now(),
  };

  // v351 — Migrated from KV to Cache API. Correlation cache used to burn
  // ~48 KV writes/day/pair × 8 pairs = 384 writes/day. Now uses Cloudflare
  // Cache API (unlimited). Falls back to KV only if cache write fails.
  try {
    const { smartPut } = await import('./_cache-store.js');
    await smartPut(env, cacheKey, `corr-${cacheKey}`, payload, 1800);
  } catch {
    if (env.TRADES_KV) {
      try { await env.TRADES_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 1800 }); } catch {}
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
