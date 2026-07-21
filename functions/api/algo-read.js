// /api/algo-read — v375
//
// Reads the FOOTPRINTS institutional algorithms leave in the price data.
// Retail traders react to price. Pros read what the algos are doing to it.
//
// Six algo signatures we detect from live OHLC:
//
//   1. VWAP POSITION — Volume Weighted Average Price is the institutional
//      benchmark. Price above VWAP = institutions still buying. Below =
//      selling. VWAP retest is the classic algo-defended level.
//
//   2. ABSORPTION BAR — big real-volume bar with tiny body = institutions
//      absorbing the other side. Retail selling into institutional buying
//      (or vice versa). Approximated from OHLC as: bar range ≥ 1.5× avg AND
//      body ≤ 30% of range.
//
//   3. WICK REJECTION — long wick at a level = algo defended it. Long
//      lower wick > 2× body = buy algo defended. Long upper wick = sell.
//
//   4. ROUND-NUMBER GRAVITY — price magnetized to 00 / 50 levels.
//      Distance to nearest round below/above matters. Within 0.3× ATR
//      of a round number = high probability of touch.
//
//   5. TIME-OF-DAY ALGO WINDOWS — specific UTC times when institutional
//      algos are provably more active:
//        08:30 UTC → London morning fix
//        10:00 NY (14:00/15:00 UTC) → institutional AM rebalance
//        16:00 UTC → London 4pm fix (largest single moment in FX)
//        21:00 UTC → NY close volume spike
//
//   6. RANGE COMPRESSION — 5-bar ATR compressed below 60% of 20-bar ATR
//      = algo squeezing before breakout. Directional bias comes from the
//      breakout direction of the next bar.
//
// Every check + evidence returned so user can see the algo signature.

const PAIRS = {
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

// ── Utilities ────────────────────────────────────────────────────────
function _atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h != null ? bars[i].h : bars[i].high;
    const l = bars[i].l != null ? bars[i].l : bars[i].low;
    const pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const s = trs.slice(-period);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

async function _fetchBars(origin, sym) {
  try {
    const r = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d.ohlc) ? d.ohlc : null;
  } catch { return null; }
}

// ── 1. VWAP ──────────────────────────────────────────────────────────
// Session-anchored VWAP (each day starts fresh)
function _computeVWAP(bars) {
  if (!bars || bars.length < 10) return null;
  // Anchor to start of today (UTC)
  const now = new Date();
  const midnightUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayBars = bars.filter(b => b.t >= midnightUTC);
  const useBars = todayBars.length >= 3 ? todayBars : bars.slice(-24);
  let cumTPV = 0, cumV = 0;
  for (const b of useBars) {
    const h = b.h != null ? b.h : b.high;
    const l = b.l != null ? b.l : b.low;
    const typical = (h + l + b.c) / 3;
    // Yahoo OHLC doesn't have volume for FX — use bar range as proxy
    const v = Math.max(0.01, h - l);
    cumTPV += typical * v;
    cumV += v;
  }
  const vwap = cumV > 0 ? cumTPV / cumV : null;
  const price = bars[bars.length - 1].c;
  const atr = _atr(bars.slice(-30), 14);
  const distATR = vwap && atr ? (price - vwap) / atr : 0;
  return {
    vwap: vwap ? Math.round(vwap * 100000) / 100000 : null,
    price,
    distanceATR: Math.round(distATR * 100) / 100,
    position: distATR > 0.3 ? 'above' : distATR < -0.3 ? 'below' : 'at',
    bias: distATR > 0.3 ? 'institutional-BUY' : distATR < -0.3 ? 'institutional-SELL' : 'neutral',
    bars: useBars.length,
  };
}

// ── 2. Absorption bar ────────────────────────────────────────────────
function _detectAbsorption(bars) {
  if (!bars || bars.length < 15) return null;
  const atr = _atr(bars.slice(-15), 14);
  if (!atr) return null;
  const last = bars[bars.length - 1];
  const h = last.h != null ? last.h : last.high;
  const l = last.l != null ? last.l : last.low;
  const range = h - l;
  const body = Math.abs(last.c - last.o);
  const bigRange = range >= atr * 1.5;
  const smallBody = body <= range * 0.3;
  if (bigRange && smallBody) {
    // Direction inferred from close position within range
    const closePos = range > 0 ? (last.c - l) / range : 0.5;
    // Close in upper 40% = buyers absorbing at bottom (bullish)
    // Close in lower 40% = sellers absorbing at top (bearish)
    const direction = closePos > 0.6 ? 'BUY' : closePos < 0.4 ? 'SELL' : 'NEUTRAL';
    return {
      detected: true,
      rangeATR: Math.round((range / atr) * 100) / 100,
      bodyPct: Math.round((body / range) * 100),
      closePosPct: Math.round(closePos * 100),
      direction,
      note: `Absorption bar — big range (${Math.round((range/atr)*100)/100}× ATR), tiny body (${Math.round((body/range)*100)}% of range). Close at ${Math.round(closePos*100)}% = institutional ${direction}`,
    };
  }
  return { detected: false };
}

// ── 3. Wick rejection ────────────────────────────────────────────────
function _detectWickRejection(bars) {
  if (!bars || bars.length < 5) return null;
  const last = bars[bars.length - 1];
  const h = last.h != null ? last.h : last.high;
  const l = last.l != null ? last.l : last.low;
  const body = Math.abs(last.c - last.o);
  const upperWick = h - Math.max(last.c, last.o);
  const lowerWick = Math.min(last.c, last.o) - l;
  if (body <= 0) return null;
  if (lowerWick >= body * 2 && upperWick <= body * 0.5) {
    return {
      detected: true,
      side: 'lower',
      wickToBodyRatio: Math.round((lowerWick / body) * 10) / 10,
      direction: 'BUY',
      note: `Long lower wick (${Math.round((lowerWick/body)*10)/10}× body) — buyers defended below ${l}`,
    };
  }
  if (upperWick >= body * 2 && lowerWick <= body * 0.5) {
    return {
      detected: true,
      side: 'upper',
      wickToBodyRatio: Math.round((upperWick / body) * 10) / 10,
      direction: 'SELL',
      note: `Long upper wick (${Math.round((upperWick/body)*10)/10}× body) — sellers rejected above ${h}`,
    };
  }
  return { detected: false };
}

// ── 4. Round-number gravity ──────────────────────────────────────────
function _detectRoundNumberGravity(price, atr, pair) {
  let step;
  if (pair === 'BTC/USD') step = 500;
  else if (pair === 'XAU/USD') step = 5;         // 5-dollar levels
  else if (pair.includes('JPY')) step = 0.5;     // 50-pip
  else step = 0.01;                              // 100-pip FX
  const roundBelow = Math.floor(price / step) * step;
  const roundAbove = roundBelow + step;
  const distBelow = (price - roundBelow) / atr;
  const distAbove = (roundAbove - price) / atr;
  const nearest = distBelow < distAbove ? { level: roundBelow, side: 'below', distATR: distBelow }
                                        : { level: roundAbove, side: 'above', distATR: distAbove };
  const isMagnetized = nearest.distATR < 0.3;
  return {
    roundBelow: Math.round(roundBelow * 100000) / 100000,
    roundAbove: Math.round(roundAbove * 100000) / 100000,
    nearestLevel: Math.round(nearest.level * 100000) / 100000,
    distanceATR: Math.round(nearest.distATR * 100) / 100,
    isMagnetized,
    note: isMagnetized
      ? `⚡ Price magnetized to ${nearest.side === 'below' ? 'roundBelow' : 'roundAbove'} ${nearest.level} (${nearest.distATR.toFixed(2)}× ATR away)`
      : `Nearest round: ${nearest.level} (${nearest.distATR.toFixed(2)}× ATR away)`,
  };
}

// ── 5. Time-of-day algo window ───────────────────────────────────────
function _detectAlgoWindow() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const minsFromMidnight = utcHour * 60 + utcMin;
  // Time windows (UTC) with algo activity level
  const windows = [
    { name: 'London morning fix', start: 8 * 60 + 15, end: 8 * 60 + 45, algo: 'high' },
    { name: 'London-NY overlap', start: 13 * 60, end: 16 * 60, algo: 'peak' },
    { name: 'ICT NY AM Silver Bullet', start: 14 * 60, end: 15 * 60, algo: 'high' },
    { name: 'London 4pm fix', start: 15 * 60 + 45, end: 16 * 60 + 15, algo: 'peak' },
    { name: 'NY close volume spike', start: 20 * 60, end: 21 * 60, algo: 'high' },
    { name: 'Asian range compression', start: 22 * 60, end: 5 * 60 + 60 * 24, algo: 'low' },
  ];
  const active = windows.filter(w => minsFromMidnight >= w.start && minsFromMidnight <= w.end);
  return {
    utcTime: `${String(utcHour).padStart(2, '0')}:${String(utcMin).padStart(2, '0')}`,
    activeWindow: active.length ? active[0] : null,
    algoIntensity: active.length ? active[0].algo : 'normal',
    note: active.length ? `🕒 Active: ${active[0].name} (${active[0].algo} algo activity)` : 'No specific algo window',
  };
}

// ── 6. Range compression ─────────────────────────────────────────────
function _detectRangeCompression(bars) {
  if (!bars || bars.length < 25) return null;
  const atr5 = _atr(bars.slice(-5), 5);
  const atr20 = _atr(bars.slice(-20), 20);
  if (!atr5 || !atr20 || atr20 === 0) return null;
  const ratio = atr5 / atr20;
  const compressed = ratio < 0.6;
  return {
    ratio: Math.round(ratio * 100) / 100,
    compressed,
    note: compressed
      ? `⚡ Range compressed (${(ratio * 100).toFixed(0)}% of 20-bar ATR) — algo squeezing before breakout`
      : `Normal volatility (${(ratio * 100).toFixed(0)}% of 20-bar ATR)`,
  };
}

// ── Per-pair evaluation ──────────────────────────────────────────────
async function _readAlgoForPair(origin, pair, sym) {
  const bars = await _fetchBars(origin, sym);
  if (!bars || bars.length < 20) return { pair, ok: false, error: 'no bars' };
  const price = bars[bars.length - 1].c;
  const atr = _atr(bars.slice(-30), 14);
  if (!atr) return { pair, ok: false, error: 'no ATR' };

  const vwap = _computeVWAP(bars);
  const absorption = _detectAbsorption(bars);
  const wick = _detectWickRejection(bars);
  const roundNum = _detectRoundNumberGravity(price, atr, pair);
  const compression = _detectRangeCompression(bars);

  // Aggregate directional bias
  const votes = { BUY: 0, SELL: 0 };
  if (vwap && vwap.bias === 'institutional-BUY') votes.BUY += 2;
  if (vwap && vwap.bias === 'institutional-SELL') votes.SELL += 2;
  if (absorption?.detected && absorption.direction === 'BUY') votes.BUY += 3;
  if (absorption?.detected && absorption.direction === 'SELL') votes.SELL += 3;
  if (wick?.detected && wick.direction === 'BUY') votes.BUY += 2;
  if (wick?.detected && wick.direction === 'SELL') votes.SELL += 2;
  const algoBias = votes.BUY > votes.SELL + 1 ? 'BUY'
                 : votes.SELL > votes.BUY + 1 ? 'SELL' : 'NEUTRAL';
  const algoStrength = Math.abs(votes.BUY - votes.SELL);

  return {
    pair,
    ok: true,
    price,
    atr: Math.round(atr * 100000) / 100000,
    vwap,
    absorption,
    wick,
    roundNumber: roundNum,
    rangeCompression: compression,
    algoBias,
    algoStrength,
    votes,
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  const now = new Date();

  const algoWindow = _detectAlgoWindow();
  const results = await Promise.all(
    Object.entries(PAIRS).map(([pair, sym]) => _readAlgoForPair(origin, pair, sym))
  );
  const withData = results.filter(r => r.ok);

  // Overall market algo state
  const buyBiased = withData.filter(r => r.algoBias === 'BUY').length;
  const sellBiased = withData.filter(r => r.algoBias === 'SELL').length;
  const overallBias = buyBiased > sellBiased ? 'net-BUY' : sellBiased > buyBiased ? 'net-SELL' : 'balanced';

  return new Response(JSON.stringify({
    ok: true,
    version: 'v375-algo-read',
    timestamp: now.toISOString(),
    algoWindow,
    overallBias,
    pairsScanned: results.length,
    marketState: {
      buyBiased,
      sellBiased,
      neutral: withData.length - buyBiased - sellBiased,
    },
    pairs: results,
    interpretation: `Algo footprints across ${withData.length} pairs · ${buyBiased} showing institutional BUY bias, ${sellBiased} SELL. Currently in "${algoWindow.activeWindow?.name || 'no specific'}" window with ${algoWindow.algoIntensity} algo activity.`,
    honestNote: 'These are FOOTPRINTS visible in OHLC data — approximations of real order flow (which requires L2 data we do not have). Correlated with real institutional activity but not identical. Best used as bias confirmation alongside chart pattern signals.',
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
