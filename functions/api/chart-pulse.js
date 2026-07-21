// /api/chart-pulse — v346 always-reading endpoint.
//
// Analyses EVERY pair on EVERY call. Shows what the system sees on each
// chart in real time: trend, momentum, key levels, distance to significant
// price zones. Even when no signals fire, the user can see the system is
// actively reading. Pure read-only — never writes to KV.

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

async function _fetchOhlc(origin, symbol) {
  try {
    const r = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d.ohlc) && d.ohlc.length > 20 ? d.ohlc : null;
  } catch { return null; }
}

function _ema(arr, p) {
  if (!arr || arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function _rsi(closes, period = 14) {
  const n = closes.length - 1;
  if (n < period) return null;
  let gains = 0, losses = 0;
  for (let i = n - period + 1; i <= n; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg > 0) gains += chg; else losses -= chg;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function _adx(highs, lows, closes, period = 14) {
  if (highs.length < period * 2) return null;
  let sumPlus = 0, sumMinus = 0, sumTR = 0;
  const start = highs.length - period;
  for (let i = start; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    const plusDM = up > dn && up > 0 ? up : 0;
    const minusDM = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]));
    sumPlus += plusDM; sumMinus += minusDM; sumTR += tr;
  }
  if (sumTR === 0) return 0;
  const plusDI = (sumPlus / sumTR) * 100;
  const minusDI = (sumMinus / sumTR) * 100;
  if (plusDI + minusDI === 0) return 0;
  return Math.round(Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100);
}

function _analyzeChart(ohlc, pair) {
  if (!ohlc || ohlc.length < 50) return { error: 'insufficient bars' };
  const closes = ohlc.map(b => b.c);
  const highs = ohlc.map(b => b.h);
  const lows = ohlc.map(b => b.l);
  const n = ohlc.length - 1;
  const price = closes[n];

  const ema20 = _ema(closes, 20);
  const ema50 = _ema(closes, 50);
  const ema200 = closes.length >= 200 ? _ema(closes, 200) : null;
  const rsi = _rsi(closes);
  const adx = _adx(highs, lows, closes);

  // Trend read
  let trend = 'range';
  if (ema20 && ema50 && price > ema20 && ema20 > ema50) trend = 'up';
  else if (ema20 && ema50 && price < ema20 && ema20 < ema50) trend = 'down';

  // Recent swing levels (last 40 bars)
  const winBars = ohlc.slice(-40);
  const swingHigh = Math.max(...winBars.map(b => b.h));
  const swingLow = Math.min(...winBars.map(b => b.l));

  // Day range (last 24 bars ≈ 1 day on 1H)
  const dayBars = ohlc.slice(-24);
  const dayHigh = Math.max(...dayBars.map(b => b.h));
  const dayLow = Math.min(...dayBars.map(b => b.l));
  const dayOpen = dayBars[0].o;
  const dayChangePct = ((price - dayOpen) / dayOpen) * 100;

  // ATR14
  let atr = 0, count = 0;
  for (let i = n - 13; i <= n; i++) {
    const tr = Math.max(highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]));
    atr += tr;
    count++;
  }
  atr = count > 0 ? atr / count : 0;

  // Position within day's range
  const dayRange = dayHigh - dayLow;
  const posInDay = dayRange > 0 ? ((price - dayLow) / dayRange) * 100 : 50;

  // Distance to key levels
  const distToSwingHigh = ((swingHigh - price) / price) * 100;
  const distToSwingLow = ((price - swingLow) / price) * 100;

  // Last 5 candles pattern
  const last5 = ohlc.slice(-5);
  const bulls = last5.filter(b => b.c > b.o).length;
  const bears = 5 - bulls;
  let candleBias = 'balanced';
  if (bulls >= 4) candleBias = 'strong bullish';
  else if (bears >= 4) candleBias = 'strong bearish';
  else if (bulls === 3) candleBias = 'slight bullish';
  else if (bears === 3) candleBias = 'slight bearish';

  // Overall verdict
  let verdict = 'HOLD';
  let reason = 'No clear setup';
  if (trend === 'up' && rsi < 70 && posInDay < 60 && adx >= 20) {
    verdict = 'BUY BIAS';
    reason = `Uptrend intact, RSI ${rsi} not overbought, price in lower ${Math.round(posInDay)}% of day range, ADX ${adx} confirms strength`;
  } else if (trend === 'down' && rsi > 30 && posInDay > 40 && adx >= 20) {
    verdict = 'SELL BIAS';
    reason = `Downtrend intact, RSI ${rsi} not oversold, price in upper ${Math.round(100 - posInDay)}% of day range, ADX ${adx} confirms strength`;
  } else if (adx < 15) {
    verdict = 'WAIT';
    reason = `ADX ${adx} — no trend, market ranging`;
  } else if (rsi > 75) {
    verdict = 'CAUTION-OVERBOUGHT';
    reason = `RSI ${rsi} overbought — reversal risk`;
  } else if (rsi < 25) {
    verdict = 'CAUTION-OVERSOLD';
    reason = `RSI ${rsi} oversold — bounce risk`;
  }

  return {
    price,
    trend,
    verdict,
    reason,
    indicators: { rsi, adx, ema20, ema50, ema200, atr: Math.round(atr * 100) / 100 },
    range: {
      dayHigh, dayLow, dayChangePct: Math.round(dayChangePct * 100) / 100,
      posInDayPct: Math.round(posInDay),
    },
    swings: { swingHigh, swingLow,
      distToHigh: Math.round(distToSwingHigh * 100) / 100,
      distToLow: Math.round(distToSwingLow * 100) / 100,
    },
    momentum: { candleBias, bulls5: bulls, bears5: bears },
  };
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  const pairs = Object.keys(SYMBOLS);
  const results = await Promise.all(pairs.map(async (p) => {
    const ohlc = await _fetchOhlc(origin, SYMBOLS[p]);
    if (!ohlc) return { pair: p, error: 'no data' };
    const analysis = _analyzeChart(ohlc, p);
    return { pair: p, ...analysis };
  }));

  const withVerdict = results.filter(r => r.verdict);
  const buyBias = withVerdict.filter(r => r.verdict === 'BUY BIAS');
  const sellBias = withVerdict.filter(r => r.verdict === 'SELL BIAS');
  const waiting = withVerdict.filter(r => r.verdict === 'WAIT');

  const bestBuy = buyBias.sort((a, b) => (b.indicators?.adx || 0) - (a.indicators?.adx || 0))[0];
  const bestSell = sellBias.sort((a, b) => (b.indicators?.adx || 0) - (a.indicators?.adx || 0))[0];

  return new Response(JSON.stringify({
    ok: true,
    version: 'v346-chart-pulse',
    scanned: pairs.length,
    summary: {
      buyBias: buyBias.length,
      sellBias: sellBias.length,
      waiting: waiting.length,
      strongest: bestBuy?.indicators?.adx > (bestSell?.indicators?.adx || 0)
        ? { pair: bestBuy?.pair, direction: 'BUY', adx: bestBuy?.indicators?.adx }
        : bestSell?.pair ? { pair: bestSell?.pair, direction: 'SELL', adx: bestSell?.indicators?.adx }
        : null,
    },
    charts: results,
    timestamp: new Date().toISOString(),
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=30',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
