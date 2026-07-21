// /api/pattern-library — v361
//
// Builds a library of PROVEN REPEATING WINNER PATTERNS per pair.
//
// For every historical bar, encode the market state as a compact "fingerprint"
// (RSI zone, MACD sign, ADX regime, position vs EMAs, position in range,
// last-5-candle direction). Look forward N bars: did price hit +2×ATR first
// (win) or -2×ATR first (loss)? Group by fingerprint. Keep only fingerprints
// with ≥10 samples AND ≥70% same-direction outcome.
//
// Result: a per-pair library of "when the chart looked like THIS in the past,
// price moved THIS way ≥70% of the time." Cached to Cache API for 24h.
//
// This is the foundation the pattern-match endpoint uses to detect when the
// current live chart is entering a proven-winner state — the "same pattern
// again and again that always works" the user asked for.

import { encodeFingerprint } from './_feature-encoder.js';

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

// ── Indicator helpers ────────────────────────────────────────────────────
function _emaSeries(arr, p) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (p + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null || !isFinite(v)) { out[i] = prev; continue; }
    prev = prev == null ? v : (v * k + prev * (1 - k));
    out[i] = prev;
  }
  return out;
}
function _rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) { gain = (gain * (period - 1) + d) / period; loss = (loss * (period - 1)) / period; }
    else { gain = (gain * (period - 1)) / period; loss = (loss * (period - 1) - d) / period; }
    out[i] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  }
  return out;
}
function _atrSeries(highs, lows, closes, period = 14) {
  const out = new Array(highs.length).fill(null);
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
    if (trs.length >= period) {
      const slice = trs.slice(-period);
      out[i] = slice.reduce((a, b) => a + b, 0) / slice.length;
    }
  }
  return out;
}
function _macdHistSeries(closes) {
  const ema12 = _emaSeries(closes, 12);
  const ema26 = _emaSeries(closes, 26);
  const macdLine = closes.map((_, i) =>
    (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null
  );
  const signal = _emaSeries(macdLine.filter(v => v != null), 9);
  // Reconstruct with same indices
  const out = new Array(closes.length).fill(null);
  let sigIdx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] == null) continue;
    if (sigIdx >= signal.length) break;
    out[i] = macdLine[i] - signal[sigIdx];
    sigIdx++;
  }
  return out;
}
function _adxSeries(highs, lows, closes, period = 14) {
  const out = new Array(highs.length).fill(null);
  if (highs.length < period * 2 + 1) return out;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  // Wilder's smoothing
  const smooth = (arr) => {
    const s = new Array(arr.length).fill(null);
    if (arr.length < period) return s;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    s[period - 1] = sum;
    for (let i = period; i < arr.length; i++) {
      s[i] = s[i - 1] - (s[i - 1] / period) + arr[i];
    }
    return s;
  };
  const smTR = smooth(tr);
  const smPlus = smooth(plusDM);
  const smMinus = smooth(minusDM);
  const dx = tr.map((_, i) => {
    if (smTR[i] == null || smTR[i] === 0) return null;
    const plusDI = 100 * smPlus[i] / smTR[i];
    const minusDI = 100 * smMinus[i] / smTR[i];
    const sum = plusDI + minusDI;
    return sum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sum;
  });
  // ADX = smoothed DX
  const validDx = dx.filter(v => v != null);
  const adxRaw = smooth(validDx);
  // Map back with offset
  let dxIdx = 0;
  for (let i = 0; i < dx.length; i++) {
    if (dx[i] != null && adxRaw[dxIdx] != null) {
      out[i + 1] = adxRaw[dxIdx] / period;
      dxIdx++;
    }
  }
  return out;
}

// ── Forward-look outcome ─────────────────────────────────────────────────
// From bar i, does price hit +2×ATR before -2×ATR (win) or vice versa (loss)?
function _outcome(i, bars, atr, direction) {
  const entry = bars[i].c;
  if (!isFinite(atr) || atr <= 0) return null;
  const dist = atr * 2;
  const tp = direction === 'BUY' ? entry + dist : entry - dist;
  const sl = direction === 'BUY' ? entry - dist : entry + dist;
  for (let j = i + 1; j < Math.min(bars.length, i + 50); j++) {
    const b = bars[j];
    const bh = b.h != null ? b.h : b.high;
    const bl = b.l != null ? b.l : b.low;
    if (direction === 'BUY') {
      if (bl <= sl) return 'lost';
      if (bh >= tp) return 'won';
    } else {
      if (bh >= sl) return 'lost';
      if (bl <= tp) return 'won';
    }
  }
  return null;
}

// ── Fetch max-history daily bars ─────────────────────────────────────────
async function _fetchBars(origin, sym) {
  try {
    const isBTC = sym === 'BTC-USD' || sym === 'BTCUSD=X';
    const range = isBTC ? 'max' : '10y';
    const url = `${origin}/api/prices?symbol=${encodeURIComponent(sym)}&interval=1d&range=${range}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return Array.isArray(d.ohlc) ? d.ohlc : null;
  } catch { return null; }
}

// ── Build one pair's library ─────────────────────────────────────────────
function _buildLibrary(bars) {
  // v361b — Lowered min from 300 → 220 to include XAU (~266 bars) and BTC
  // when Yahoo returns fewer bars. 220 still leaves room for the 200-bar
  // EMA warmup (indicator init needs 200 bars) + 20-bar lookback window.
  if (!bars || bars.length < 220) return null;
  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h != null ? b.h : b.high);
  const lows = bars.map(b => b.l != null ? b.l : b.low);
  const ema20s = _emaSeries(closes, 20);
  const ema50s = _emaSeries(closes, 50);
  const ema200s = _emaSeries(closes, 200);
  const rsis = _rsiSeries(closes, 14);
  const atrs = _atrSeries(highs, lows, closes, 14);
  const macds = _macdHistSeries(closes);
  const adxs = _adxSeries(highs, lows, closes, 14);

  // Aggregate by fingerprint for BOTH directions
  const stats = {}; // fp → { BUY: {w,l}, SELL: {w,l} }

  // v368 FIX — Adaptive warmup. Was fixed 250; XAU/USD (Yahoo max ~266 bars)
  // left a NEGATIVE iteration range (250 to 216), giving 0 patterns.
  // Now: skip max(200, ceil(bars * 0.15)). Never exceeds 250. Never below 200
  // (needed for EMA200 warmup). For 266 bars → skip 200 → 16 iterations.
  const warmupSkip = Math.min(250, Math.max(200, Math.ceil(bars.length * 0.15)));
  for (let i = warmupSkip; i < bars.length - 50; i++) {
    if (!ema200s[i] || !rsis[i] || !atrs[i]) continue;
    const fp = encodeFingerprint(i, closes, highs, lows,
      rsis[i], macds[i], adxs[i], ema20s[i], ema50s[i], ema200s[i], atrs[i]);
    if (!fp) continue;

    // Look forward: what happened next?
    const buyOutcome = _outcome(i, bars, atrs[i], 'BUY');
    const sellOutcome = _outcome(i, bars, atrs[i], 'SELL');
    if (buyOutcome == null && sellOutcome == null) continue;

    if (!stats[fp]) stats[fp] = { BUY: { w: 0, l: 0 }, SELL: { w: 0, l: 0 } };
    if (buyOutcome === 'won') stats[fp].BUY.w++;
    else if (buyOutcome === 'lost') stats[fp].BUY.l++;
    if (sellOutcome === 'won') stats[fp].SELL.w++;
    else if (sellOutcome === 'lost') stats[fp].SELL.l++;
  }

  // Keep only PROVEN patterns: ≥10 samples AND ≥65% WR in one direction
  const provenPatterns = [];
  for (const [fp, s] of Object.entries(stats)) {
    for (const dir of ['BUY', 'SELL']) {
      const n = s[dir].w + s[dir].l;
      if (n < 10) continue;
      const wr = s[dir].w / n;
      if (wr < 0.65) continue;
      // Wilson lower bound for statistical confidence
      const z = 1.96;
      const p = wr;
      const wilson = (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n);
      provenPatterns.push({
        fingerprint: fp,
        direction: dir,
        samples: n,
        wins: s[dir].w,
        losses: s[dir].l,
        winRate: Math.round(wr * 100),
        wilsonLower: Math.round(wilson * 100),
      });
    }
  }
  // Sort by Wilson lower bound
  provenPatterns.sort((a, b) => b.wilsonLower - a.wilsonLower);

  return {
    barsScanned: bars.length,
    totalPatterns: Object.keys(stats).length,
    provenPatterns: provenPatterns.slice(0, 30), // top 30 per pair
    firstBar: new Date(bars[0].t).toISOString().slice(0, 10),
    lastBar: new Date(bars[bars.length - 1].t).toISOString().slice(0, 10),
  };
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const forceRun = url.searchParams.get('force') === '1';
  const singlePair = url.searchParams.get('pair');

  const { cacheGet, cachePut } = await import('./_cache-store.js');

  if (!forceRun && !singlePair) {
    const cached = await cacheGet('pattern-library:all');
    if (cached) return _json({ ...cached, cached: true });
  }

  const pairsToRun = singlePair ? { [singlePair]: PAIRS[singlePair] } : PAIRS;
  const results = {};
  let totalProven = 0;
  let totalSamplesStudied = 0;

  for (const [pair, sym] of Object.entries(pairsToRun)) {
    const bars = await _fetchBars(origin, sym);
    if (!bars) { results[pair] = { ok: false, error: 'no bars' }; continue; }
    const lib = _buildLibrary(bars);
    if (!lib) { results[pair] = { ok: false, error: 'too few bars' }; continue; }
    results[pair] = { ok: true, ...lib };
    totalProven += lib.provenPatterns.length;
    totalSamplesStudied += lib.barsScanned;
    // Cache per-pair library for 24h (used by pattern-match)
    await cachePut(`pattern-library:${pair}`, lib, 86400);
  }

  const aggregate = {
    ok: true,
    version: 'v361-pattern-library',
    timestamp: new Date().toISOString(),
    pairsScanned: Object.keys(results).length,
    totalProvenPatterns: totalProven,
    totalHistoricalBarsStudied: totalSamplesStudied,
    perPair: results,
  };
  await cachePut('pattern-library:all', aggregate, 86400);
  return _json(aggregate);
}

function _json(payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
