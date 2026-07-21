// /api/tp-debug — v338 debug endpoint to see WHY tp-monitor isn't detecting hits.

const SYMBOLS = {
  'XAU/USD': 'GC=F',
  'BTC/USD': 'BTC-USD',
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X',
  'NZD/USD': 'NZDUSD=X',
  'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
};

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  const raw = await env.TRADES_KV.get('tp-tracker').catch(() => null);
  let tracker = { signals: [] };
  try { if (raw) tracker = JSON.parse(raw); } catch {}

  const openSignals = (tracker.signals || []).filter(s => !s.resolvedAt);
  const uniquePairs = [...new Set(openSignals.map(s => s.pair))];

  const barsByPair = {};
  const fetchDebug = {};
  for (const p of uniquePairs) {
    const sym = SYMBOLS[p];
    if (!sym) { fetchDebug[p] = { error: 'no symbol map' }; continue; }
    try {
      const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`);
      if (!res.ok) { fetchDebug[p] = { error: `HTTP ${res.status}` }; continue; }
      const data = await res.json();
      const ohlc = data.ohlc || [];
      fetchDebug[p] = { symbol: sym, bars: ohlc.length, source: data.source, lastBar: ohlc[ohlc.length - 1] };
      barsByPair[p] = ohlc;
    } catch (e) {
      fetchDebug[p] = { error: e.message };
    }
  }

  // For each open signal, check if any bar since addedAt should have hit SL or TP
  const analysis = [];
  for (const s of openSignals.slice(0, 5)) {
    const bars = barsByPair[s.pair] || [];
    const startTs = s.addedAt || 0;
    const relevantBars = bars.filter(b => b.t >= startTs - 3600000);
    let maxHigh = -Infinity, minLow = Infinity;
    for (const b of relevantBars) {
      if (b.h > maxHigh) maxHigh = b.h;
      if (b.l < minLow) minLow = b.l;
    }
    const isBuy = s.direction === 'BUY';
    const shouldHitSl = isBuy ? (minLow <= s.sl) : (maxHigh >= s.sl);
    const shouldHitTp1 = isBuy ? (maxHigh >= s.tp1) : (minLow <= s.tp1);
    analysis.push({
      id: s.id,
      pair: s.pair,
      direction: s.direction,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      addedAt: s.addedAt,
      addedAtIso: s.addedAt ? new Date(s.addedAt).toISOString() : null,
      totalBars: bars.length,
      relevantBars: relevantBars.length,
      firstRelevantBarTs: relevantBars[0]?.t,
      lastRelevantBarTs: relevantBars[relevantBars.length - 1]?.t,
      maxHighSince: maxHigh === -Infinity ? null : maxHigh,
      minLowSince: minLow === Infinity ? null : minLow,
      shouldHaveHitSl: shouldHitSl,
      shouldHaveHitTp1: shouldHitTp1,
      diagnosis: !relevantBars.length ? 'NO BARS after addedAt — filter dropping all bars'
        : shouldHitSl ? 'SHOULD HAVE HIT SL — bug in tp-monitor'
        : shouldHitTp1 ? 'SHOULD HAVE HIT TP1 — bug in tp-monitor'
        : 'genuinely still open',
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    fetchDebug,
    openSignals: openSignals.length,
    analysis,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
