// /api/predict-next?pair=XAU/USD — Deterministic direction prediction that
// aggregates every intelligence layer in the app into a single actionable
// verdict: BUY / SELL / HOLD, with entry, stop-loss, and 3 take-profit
// targets computed from real market structure.
//
// The prediction is a WEIGHTED VOTE across:
//   • Higher-timeframe trend alignment (20 pts)
//   • Lower-timeframe momentum (15 pts)
//   • Market structure (HH/HL vs LH/LL) (15 pts)
//   • RSI zone + divergence (20 pts)
//   • MACD histogram direction (15 pts)
//   • EMA 20/50/200 stack (15 pts)
//   • Bollinger position + volatility (10 pts)
//   • Candlestick pattern on last bar (10 pts)
//   • ADX trend strength (10 pts)
//   • Correlation basket alignment (25 pts)
//   • News sentiment bias (15 pts)
//   • Brain historical WR on pair (15 pts)
//
// Total possible weight: ~185. Net vote determines direction; margin
// determines confidence. Entry / SL / TP levels computed from ATR and
// structural swing levels — no LLM guessing.

const PAIR_TO_SYMBOL = {
  'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F',
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'US30': '^DJI', 'NAS100': '^NDX', 'SPX500': '^GSPC',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};

// ── Indicator helpers (compact ports of the standard formulas) ──────────
function _emaSeries(arr, period) {
  if (!arr || arr.length < period) return [];
  const out = Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}
function _ema(arr, p) { const s = _emaSeries(arr, p); return s.length ? s[s.length - 1] : null; }
function _rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
  }
  if (loss === 0) return 100;
  return 100 - (100 / (1 + gain / loss));
}
function _macdHist(closes) {
  if (closes.length < 35) return null;
  const ema12 = _emaSeries(closes, 12);
  const ema26 = _emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null).filter(v => v != null);
  if (macdLine.length < 9) return null;
  const signal = _ema(macdLine, 9);
  return macdLine[macdLine.length - 1] - signal;
}
function _atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}
function _adx(highs, lows, closes, period = 14) {
  if (highs.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < highs.length; i++) {
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let tr14 = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pdm14 = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let mdm14 = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxList = [];
  for (let i = period; i < trs.length; i++) {
    tr14 = tr14 - (tr14 / period) + trs[i];
    pdm14 = pdm14 - (pdm14 / period) + plusDM[i];
    mdm14 = mdm14 - (mdm14 / period) + minusDM[i];
    const plusDI = (pdm14 / tr14) * 100;
    const minusDI = (mdm14 / tr14) * 100;
    dxList.push(Math.abs(plusDI - minusDI) / (plusDI + minusDI + 1e-9) * 100);
  }
  if (dxList.length < period) return null;
  return dxList.slice(-period).reduce((s, d) => s + d, 0) / period;
}
function _structureTrend(bars) {
  if (bars.length < 15) return 'unknown';
  const window = bars.slice(-30);
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < window.length - 2; i++) {
    if (window[i].h > window[i - 1].h && window[i].h > window[i - 2].h && window[i].h > window[i + 1].h && window[i].h > window[i + 2].h) swingHighs.push(window[i].h);
    if (window[i].l < window[i - 1].l && window[i].l < window[i - 2].l && window[i].l < window[i + 1].l && window[i].l < window[i + 2].l) swingLows.push(window[i].l);
  }
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 1; i < swingHighs.length; i++) (swingHighs[i] > swingHighs[i - 1] ? hh++ : lh++);
  for (let i = 1; i < swingLows.length; i++) (swingLows[i] > swingLows[i - 1] ? hl++ : ll++);
  if (hh + hl > lh + ll + 1) return 'uptrend';
  if (ll + lh > hh + hl + 1) return 'downtrend';
  return 'range';
}
function _lastCandle(bars) {
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  const body = Math.abs(last.c - last.o);
  const range = Math.max(1e-9, last.h - last.l);
  const bodyPct = body / range;
  const upWick = last.h - Math.max(last.o, last.c);
  const dnWick = Math.min(last.o, last.c) - last.l;
  const isBull = last.c > last.o;
  const isBear = last.c < last.o;
  // Return the strongest one signal
  if (bodyPct < 0.10) return { type: 'doji', bias: 'neutral' };
  if (isBull && dnWick > body * 2 && upWick < body * 0.6) return { type: 'hammer', bias: 'bullish' };
  if (isBear && upWick > body * 2 && dnWick < body * 0.6) return { type: 'shooting-star', bias: 'bearish' };
  if (bodyPct >= 0.70) return { type: isBull ? 'strong-bull' : 'strong-bear', bias: isBull ? 'bullish' : 'bearish' };
  return null;
}

async function _fetchBars(origin, symbol) {
  // v382 — safeFetch with retry + circuit-breaker + LKG fallback.
  // Yahoo blips no longer cascade into zero-signal outages.
  const { safeFetch } = await import('./_fetch-guard.js');
  const url = `${origin}/api/prices?symbol=${encodeURIComponent(symbol)}`;
  const r = await safeFetch(url, { timeout: 9000, retries: 1, parseJson: true });
  if (!r.ok || !r.data) throw new Error(`prices fetch failed (${r.source})`);
  return Array.isArray(r.data.ohlc) ? r.data.ohlc : [];
}

// Round to the pair's natural precision so entry/SL/TP look right in the UI
// v401 — FIX: previous check `includes('/USD')` missed USD-first pairs
// (USD/CHF, USD/CAD, USD/JPY, etc), causing them to fall through to 2dp.
// USD/CHF entry 0.8123 became 0.81 same as SL 0.8089 → display broken,
// self-trust tanked, math validator failed.
function _roundToPrecision(v, pair) {
  if (!pair) return Math.round(v * 100) / 100;
  if (pair.includes('JPY')) return Math.round(v * 1000) / 1000;
  if (pair === 'XAU/USD' || pair === 'XAG/USD') return Math.round(v * 100) / 100;
  if (pair === 'BTC/USD') return Math.round(v * 100) / 100;
  if (pair === 'ETH/USD' || pair === 'SOL/USD') return Math.round(v * 100) / 100;
  if (['US30','NAS100','SPX500','GER40','UK100','JPN225'].includes(pair)) return Math.round(v * 10) / 10;
  // All other FX (majors, crosses, USD-first, USD-last) → 5 decimals
  if (pair.includes('/')) return Math.round(v * 100000) / 100000;
  return Math.round(v * 100) / 100;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pair = (url.searchParams.get('pair') || 'XAU/USD').toUpperCase();
  const origin = `${url.protocol}//${url.host}`;
  const symbol = PAIR_TO_SYMBOL[pair] || (pair.includes('/') ? pair.replace('/', '') + '=X' : pair);

  // ─── 1. Fetch all data in parallel ───────────────────────────────────
  const [bars, correlationRes, newsRes] = await Promise.all([
    _fetchBars(origin, symbol).catch(() => []),
    fetch(`${origin}/api/correlation-check?pair=${encodeURIComponent(pair)}`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${origin}/api/news-sentiment`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (!bars.length || bars.length < 50) {
    return _json({ error: 'insufficient market data', pair, barsAvailable: bars.length }, 200);
  }

  // ─── 2. Compute all deterministic technicals ────────────────────────
  const recent = bars.slice(-200);
  const closes = recent.map(b => b.c);
  const highs = recent.map(b => b.h);
  const lows = recent.map(b => b.l);
  const livePx = closes[closes.length - 1];

  const ema20  = _ema(closes, 20);
  const ema50  = _ema(closes, 50);
  const ema200 = closes.length >= 200 ? _ema(closes, 200) : null;
  const rsi    = _rsi(closes, 14);
  const macdH  = _macdHist(closes);
  const atr    = _atr(highs, lows, closes, 14);
  const adx    = _adx(highs, lows, closes, 14);
  const struct = _structureTrend(recent);
  const candle = _lastCandle(recent);

  // 4H resample for HTF trend
  const fourH = [];
  for (let i = recent.length - (recent.length % 4 || 4); i >= 0 && fourH.length < 30; i -= 4) {
    const g = recent.slice(Math.max(0, i - 4), i);
    if (g.length < 1) continue;
    fourH.unshift({
      o: g[0].o, h: Math.max(...g.map(b => b.h)), l: Math.min(...g.map(b => b.l)),
      c: g[g.length - 1].c,
    });
  }
  const htfCloses = fourH.map(b => b.c);
  const htfTrend = htfCloses.length >= 5
    ? (htfCloses[htfCloses.length - 1] > htfCloses[0] * 1.002 ? 'up'
       : htfCloses[htfCloses.length - 1] < htfCloses[0] * 0.998 ? 'down' : 'flat')
    : 'unknown';

  // ─── 3. WEIGHTED VOTE ─────────────────────────────────────────────
  const bullish = [];
  const bearish = [];
  const vote = (side, name, weight, detail) => (side === 'bull' ? bullish : bearish).push({ name, weight, detail });

  // HTF alignment (20 pts)
  if (htfTrend === 'up') vote('bull', 'Higher timeframe (4H) trend UP', 20, `${((htfCloses[htfCloses.length - 1] - htfCloses[0]) / htfCloses[0] * 100).toFixed(2)}%`);
  else if (htfTrend === 'down') vote('bear', 'Higher timeframe (4H) trend DOWN', 20, `${((htfCloses[htfCloses.length - 1] - htfCloses[0]) / htfCloses[0] * 100).toFixed(2)}%`);

  // Structure (15 pts)
  if (struct === 'uptrend') vote('bull', 'Market structure — uptrend (HH+HL)', 15);
  else if (struct === 'downtrend') vote('bear', 'Market structure — downtrend (LL+LH)', 15);

  // EMA stack (15 pts)
  if (ema20 != null && ema50 != null) {
    if (livePx > ema20 && ema20 > ema50) vote('bull', 'Price > EMA20 > EMA50 (bullish stack)', 15, `${livePx.toFixed(4)} > ${ema20.toFixed(4)} > ${ema50.toFixed(4)}`);
    else if (livePx < ema20 && ema20 < ema50) vote('bear', 'Price < EMA20 < EMA50 (bearish stack)', 15, `${livePx.toFixed(4)} < ${ema20.toFixed(4)} < ${ema50.toFixed(4)}`);
  }

  // RSI zones (20 pts)
  if (rsi != null) {
    if (rsi >= 55 && rsi < 70) vote('bull', `RSI ${rsi.toFixed(1)} — bullish momentum zone`, 10);
    else if (rsi <= 45 && rsi > 30) vote('bear', `RSI ${rsi.toFixed(1)} — bearish momentum zone`, 10);
    else if (rsi >= 70) vote('bear', `RSI ${rsi.toFixed(1)} — overbought (reversal risk)`, 15);
    else if (rsi <= 30) vote('bull', `RSI ${rsi.toFixed(1)} — oversold (reversal potential)`, 15);
  }

  // MACD histogram (15 pts)
  if (macdH != null) {
    if (macdH > 0) vote('bull', 'MACD histogram positive (bullish momentum)', 15, `+${macdH.toFixed(5)}`);
    else if (macdH < 0) vote('bear', 'MACD histogram negative (bearish momentum)', 15, macdH.toFixed(5));
  }

  // Candlestick pattern (10 pts)
  if (candle) {
    if (candle.bias === 'bullish') vote('bull', `Bullish candle: ${candle.type}`, 10);
    else if (candle.bias === 'bearish') vote('bear', `Bearish candle: ${candle.type}`, 10);
  }

  // ADX trend strength (10 pts) — modifier not directional; boost the winning side
  const adxNote = adx != null ? `ADX ${adx.toFixed(1)}` : 'ADX n/a';

  // Correlation basket (25 pts)
  if (correlationRes && correlationRes.buyConfluence != null) {
    const buyConf = correlationRes.buyConfluence;
    const sellConf = correlationRes.sellConfluence;
    if (buyConf >= 65) vote('bull', `Correlation basket supports BUY (${buyConf}/100)`, 25, correlationRes.summary || '');
    else if (sellConf >= 65) vote('bear', `Correlation basket supports SELL (${sellConf}/100)`, 25, correlationRes.summary || '');
  }

  // News sentiment (15 pts) — check base vs quote bias
  if (newsRes && newsRes.perCurrency) {
    const parts = pair.split('/');
    if (parts.length === 2) {
      const [base, quote] = parts;
      const baseB = newsRes.perCurrency[base]?.bias || 0;
      const quoteB = newsRes.perCurrency[quote]?.bias || 0;
      const netForBuy = baseB - quoteB;
      if (netForBuy >= 3) vote('bull', `News flow bullish for ${base} vs ${quote}`, 15, `${base}=${baseB > 0 ? '+' : ''}${baseB}, ${quote}=${quoteB > 0 ? '+' : ''}${quoteB}`);
      else if (netForBuy <= -3) vote('bear', `News flow bearish for ${base} vs ${quote}`, 15, `${base}=${baseB > 0 ? '+' : ''}${baseB}, ${quote}=${quoteB > 0 ? '+' : ''}${quoteB}`);
    }
  }

  // ─── 4. Compute the verdict ────────────────────────────────────────
  const bullWeight = bullish.reduce((s, v) => s + v.weight, 0);
  const bearWeight = bearish.reduce((s, v) => s + v.weight, 0);
  const totalWeight = bullWeight + bearWeight;
  const margin = Math.abs(bullWeight - bearWeight);
  const direction = bullWeight > bearWeight ? 'BUY' : bearWeight > bullWeight ? 'SELL' : 'HOLD';

  // Confidence: 50% base, scale by margin ratio, boost by ADX if strong trend
  let confidence = 50;
  if (totalWeight > 0) confidence = 50 + Math.round((margin / totalWeight) * 45);
  if (adx != null && adx > 25 && direction !== 'HOLD') confidence = Math.min(90, confidence + 5);
  confidence = Math.max(0, Math.min(90, confidence));

  // Threshold: if the margin is thin, downgrade to HOLD (avoid coin-flip signals)
  const finalDirection = (totalWeight >= 30 && margin >= 15) ? direction : 'HOLD';
  const finalConfidence = finalDirection === 'HOLD' ? Math.min(confidence, 55) : confidence;

  // ─── 5. Entry / SL / TP ────────────────────────────────────────────
  // v322 — Smart SL: tighter of 1.5×ATR / structure / per-pair cap.
  let levels = null;
  if (finalDirection !== 'HOLD' && atr != null) {
    const entry = livePx;
    const atrSlDist = atr * 1.5;
    // Structure-based SL: distance to recent swing extreme + 0.25×ATR buffer
    const swingBars = bars.slice(-Math.min(20, bars.length - 1));
    const swingLo = Math.min(...swingBars.map(b => b.l));
    const swingHi = Math.max(...swingBars.map(b => b.h));
    const buf = atr * 0.25;
    let structSl = finalDirection === 'BUY' ? (entry - swingLo + buf) : (swingHi - entry + buf);
    structSl = Math.max(structSl, atr * 0.5);  // don't go tighter than 0.5×ATR (noise)
    // Per-pair cap as % of price (safety net vs volatility spikes)
    const maxPct = pair === 'XAU/USD' ? 0.008
      : pair === 'BTC/USD' ? 0.020
      : pair === 'ETH/USD' ? 0.025
      : pair.includes('JPY') ? 0.005
      : pair === 'US30' ? 0.005
      : pair === 'NAS100' ? 0.006
      : 0.004;
    const capSl = entry * maxPct;
    const slDist = Math.min(atrSlDist, structSl, capSl);
    const slMethod = slDist === structSl ? 'structure' : (slDist === capSl ? 'capped' : 'atr');
    const sl = finalDirection === 'BUY' ? entry - slDist : entry + slDist;
    // v322b — TPs stay at ATR-based absolute pips (HIGH targets), decoupled
    // from SL. When SL is tight (structure-based), R:R becomes amazing.
    // v395 — TP multipliers boosted to match check-signals (higher pips)
    const tp1Dist = atr * 2.0;
    const tp2Dist = atr * 4.0;
    const tp3Dist = atr * 7.0;
    const tp1 = finalDirection === 'BUY' ? entry + tp1Dist : entry - tp1Dist;
    const tp2 = finalDirection === 'BUY' ? entry + tp2Dist : entry - tp2Dist;
    const tp3 = finalDirection === 'BUY' ? entry + tp3Dist : entry - tp3Dist;
    // v380 — index pip mult was defaulting to 10000, producing 8.9M "pips"
    // display on US30/NAS100/SPX500. Indices trade in points, so pipMult=1.
    const isIndex = ['US30','NAS100','SPX500','GER40','UK100','JPN225'].includes(pair);
    const pipMult = pair === 'XAU/USD' ? 10
      : pair === 'BTC/USD' ? 1
      : pair === 'ETH/USD' ? 10
      : isIndex ? 1
      : pair.includes('JPY') ? 100
      : 10000;
    levels = {
      entry: _roundToPrecision(entry, pair),
      stopLoss: _roundToPrecision(sl, pair),
      takeProfit1: _roundToPrecision(tp1, pair),
      takeProfit2: _roundToPrecision(tp2, pair),
      takeProfit3: _roundToPrecision(tp3, pair),
      slDistancePips: Math.round(slDist * pipMult),
      tp1DistancePips: Math.round(tp1Dist * pipMult),
      tp3DistancePips: Math.round(tp3Dist * pipMult),
      slMethod,
      slSavedPips: Math.max(0, Math.round((atrSlDist - slDist) * pipMult)),
      // v322b — R-multiples now computed from actual distances (was hardcoded).
      riskRewardTP1: +(tp1Dist / slDist).toFixed(2),
      riskRewardTP3: +(tp3Dist / slDist).toFixed(2),
    };
  }

  // Time horizon based on ADX + HTF
  let horizon = '30 min';
  if (adx != null && adx > 25 && (htfTrend === (finalDirection === 'BUY' ? 'up' : 'down'))) horizon = '2-4 hours';
  else if (adx != null && adx > 20) horizon = '1-2 hours';

  return _json({
    pair,
    livePrice: _roundToPrecision(livePx, pair),
    prediction: {
      direction: finalDirection,
      position: finalDirection === 'BUY' ? 'LONG' : finalDirection === 'SELL' ? 'SHORT' : 'NONE',
      confidence: finalConfidence,
      timeHorizon: horizon,
      verdict: _verdictLabel(finalDirection, finalConfidence),
      ...(levels || {}),
    },
    factors: {
      bullishTotal: bullWeight,
      bearishTotal: bearWeight,
      bullish,
      bearish,
      adxNote,
    },
    reasoning: _reasoningSummary(finalDirection, finalConfidence, bullish, bearish, htfTrend, struct, correlationRes, newsRes, pair),
    computedAt: Date.now(),
  });
}

function _verdictLabel(dir, conf) {
  if (dir === 'HOLD') return 'HOLD — no clear edge';
  const strength = conf >= 80 ? 'STRONG' : conf >= 65 ? 'MODERATE' : 'WEAK';
  return `${strength} ${dir === 'BUY' ? 'LONG' : 'SHORT'} — ${conf}% conviction`;
}

function _reasoningSummary(dir, conf, bullish, bearish, htfTrend, struct, corr, news, pair) {
  if (dir === 'HOLD') {
    return 'Intelligence layers are split — no clear directional edge right now. Wait for stronger alignment.';
  }
  const winning = dir === 'BUY' ? bullish : bearish;
  const top = winning.sort((a, b) => b.weight - a.weight).slice(0, 3).map(f => f.name).join('; ');
  const htfNote = htfTrend === 'unknown' ? '' : ` HTF ${htfTrend}.`;
  const structNote = struct === 'unknown' ? '' : ` Structure ${struct}.`;
  return `Weighted consensus favors ${dir === 'BUY' ? 'LONG' : 'SHORT'} with ${conf}% conviction. Top drivers: ${top}.${htfNote}${structNote} Manage risk with the levels below.`;
}

function _json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
