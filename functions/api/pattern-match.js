// /api/pattern-match — v361
//
// Live matcher: fetches current bars for every pair, encodes the current
// market fingerprint, and looks up the pair's proven-pattern library from
// Cache API. If the current fingerprint matches (exact or near, ≥7 of 8
// fields) a proven-winner pattern, fires a signal-shaped object with entry,
// SL, TP1/2/3.
//
// "The website should always be checking the trade view for the same
// pattern again and again that always works — whenever it's about to play
// out, make a signal." This is that scanner.
//
// Runs on every scan tick via check-signals waitUntil chain (added in v361).
// Cache API storage for library ensures unlimited reads. Match is O(N) over
// ~30 proven patterns per pair — negligible cost.

import { encodeFingerprint, similarity } from './_feature-encoder.js';

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

// ── Indicators (compact) ─────────────────────────────────────────────────
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
function _rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) { gain = (gain * (period - 1) + d) / period; loss = (loss * (period - 1)) / period; }
    else { gain = (gain * (period - 1)) / period; loss = (loss * (period - 1) - d) / period; }
  }
  if (loss === 0) return 100;
  return 100 - (100 / (1 + gain / loss));
}
function _atr(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const sliced = trs.slice(-period);
  return sliced.reduce((a, b) => a + b, 0) / sliced.length;
}
function _macdHist(closes) {
  if (closes.length < 35) return 0;
  const ema12 = _emaSeries(closes, 12);
  const ema26 = _emaSeries(closes, 26);
  const macd = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const macdValid = macd.filter(v => v != null);
  if (macdValid.length < 9) return 0;
  const sig = _emaSeries(macdValid, 9);
  const last = macdValid.length - 1;
  return sig[last] != null ? macdValid[last] - sig[last] : 0;
}
function _adx(highs, lows, closes, period = 14) {
  if (highs.length < period * 2 + 1) return null;
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
  const smooth = (arr) => {
    if (arr.length < period) return null;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    let s = sum;
    for (let i = period; i < arr.length; i++) {
      s = s - (s / period) + arr[i];
    }
    return s;
  };
  const smTR = smooth(tr);
  const smPlus = smooth(plusDM);
  const smMinus = smooth(minusDM);
  if (!smTR || smTR === 0) return null;
  const plusDI = 100 * smPlus / smTR;
  const minusDI = 100 * smMinus / smTR;
  const sum = plusDI + minusDI;
  if (sum === 0) return 0;
  return 100 * Math.abs(plusDI - minusDI) / sum;
}

// ── Fetch bars for live analysis ─────────────────────────────────────────
async function _fetchBars(origin, sym) {
  try {
    // v361b — range=3mo (Yahoo's default) reliably works for ALL symbols
    // including XAU (GC=F) and BTC (which routes through Kraken w/ ignored
    // interval). range=6mo intermittently returns 0 bars for those two.
    // 3 months of daily = ~90 bars — enough for EMA200 requires special
    // handling: we use best-effort with what's available.
    const url = `${origin}/api/prices?symbol=${encodeURIComponent(sym)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return Array.isArray(d.ohlc) ? d.ohlc : null;
  } catch { return null; }
}

// ── Precision helper (per-pair rounding) ────────────────────────────────
function _round(value, pair) {
  if (!isFinite(value)) return value;
  if (pair === 'USD/JPY') return Math.round(value * 1000) / 1000;
  if (pair === 'XAU/USD') return Math.round(value * 100) / 100;
  if (pair === 'BTC/USD') return Math.round(value * 100) / 100;
  return Math.round(value * 100000) / 100000;
}

// ── Match one pair against its library ──────────────────────────────────
async function _matchPair(origin, pair, sym, cacheGet) {
  const bars = await _fetchBars(origin, sym);
  if (!bars || bars.length < 30) return { pair, ok: false, error: 'insufficient bars' };

  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h != null ? b.h : b.high);
  const lows = bars.map(b => b.l != null ? b.l : b.low);
  const n = closes.length - 1;
  const price = closes[n];

  // Compute all indicators at CURRENT bar
  const ema20 = _emaSeries(closes, 20)[n];
  const ema50 = _emaSeries(closes, 50)[n];
  const ema200 = _emaSeries(closes.slice(-220), 200);
  const ema200Now = ema200[ema200.length - 1];
  const rsi = _rsi(closes.slice(-30), 14);
  const atr = _atr(highs.slice(-30), lows.slice(-30), closes.slice(-30), 14);
  const macd = _macdHist(closes.slice(-50));
  const adx = _adx(highs.slice(-40), lows.slice(-40), closes.slice(-40), 14);

  // Encode CURRENT fingerprint
  const fp = encodeFingerprint(n, closes, highs, lows,
    rsi, macd, adx, ema20, ema50, ema200Now, atr);
  if (!fp) return { pair, ok: false, error: 'fingerprint encode failed' };

  // Look up library
  const lib = await cacheGet(`pattern-library:${pair}`);
  if (!lib || !lib.provenPatterns) {
    return { pair, ok: true, currentFingerprint: fp, match: null, libraryMissing: true };
  }

  // Find best match — exact first, then near (7+ of 8 fields matching)
  let bestMatch = null;
  let bestSim = 0;
  for (const pattern of lib.provenPatterns) {
    if (pattern.fingerprint === fp) {
      bestMatch = { ...pattern, matchType: 'exact', matchScore: 8 };
      bestSim = 8;
      break; // exact match wins
    }
    const sim = similarity(fp, pattern.fingerprint);
    if (sim > bestSim && sim >= 7) {
      bestMatch = { ...pattern, matchType: 'near', matchScore: sim };
      bestSim = sim;
    }
  }

  if (!bestMatch) {
    return { pair, ok: true, currentFingerprint: fp, match: null };
  }

  // Build signal from the matched pattern
  const direction = bestMatch.direction;
  const slDist = atr * 1.5;
  const tp3Dist = slDist * 2.5;
  const tp2Dist = slDist * 1.8;
  const tp1Dist = slDist * 1.0;
  const sl = direction === 'BUY' ? price - slDist : price + slDist;
  const tp1 = direction === 'BUY' ? price + tp1Dist : price - tp1Dist;
  const tp2 = direction === 'BUY' ? price + tp2Dist : price - tp2Dist;
  const tp3 = direction === 'BUY' ? price + tp3Dist : price - tp3Dist;

  // Confidence — capped by both match strength AND wilson lower bound.
  // Never claim more confidence than the pattern's own statistical floor.
  const matchStrength = bestMatch.matchScore === 8 ? 1.0 : 0.85;
  const confidence = Math.min(88, Math.round(bestMatch.wilsonLower * matchStrength));

  return {
    pair,
    ok: true,
    currentFingerprint: fp,
    match: {
      ...bestMatch,
      matchStrength,
      confidence,
      signal: {
        pair,
        direction,
        entry: _round(price, pair),
        sl: _round(sl, pair),
        tp1: _round(tp1, pair),
        tp2: _round(tp2, pair),
        tp3: _round(tp3, pair),
        atr: _round(atr, pair),
        confidence,
        pWin: bestMatch.wilsonLower,   // conservative WR estimate
        rMultiple: 2.5,
        source: 'pattern-match',
        matchType: bestMatch.matchType,
        matchScore: bestMatch.matchScore,
        patternSamples: bestMatch.samples,
        patternWinRate: bestMatch.winRate,
        patternWilsonLower: bestMatch.wilsonLower,
        reasoning: `Pattern matched: ${bestMatch.matchType === 'exact' ? 'EXACT' : `NEAR (${bestMatch.matchScore}/8)`} match to proven ${direction} setup with ${bestMatch.winRate}% WR (Wilson ≥${bestMatch.wilsonLower}%) over ${bestMatch.samples} historical instances`,
      },
    },
  };
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const singlePair = url.searchParams.get('pair');

  const { cacheGet, cachePut } = await import('./_cache-store.js');

  const pairsToRun = singlePair ? { [singlePair]: PAIRS[singlePair] } : PAIRS;

  const results = await Promise.all(
    Object.entries(pairsToRun).map(([pair, sym]) => _matchPair(origin, pair, sym, cacheGet))
  );

  const matches = results.filter(r => r.ok && r.match);
  // Sort strongest match first (by confidence * matchScore)
  matches.sort((a, b) => (b.match.confidence * b.match.matchScore) - (a.match.confidence * a.match.matchScore));

  const payload = {
    ok: true,
    version: 'v361-pattern-match',
    timestamp: new Date().toISOString(),
    pairsScanned: results.length,
    matchesFound: matches.length,
    exactMatches: matches.filter(m => m.match.matchType === 'exact').length,
    signals: matches.map(m => m.match.signal),
    fullMatches: matches,
    scans: results.map(r => ({
      pair: r.pair,
      ok: r.ok,
      fingerprint: r.currentFingerprint || null,
      matched: !!r.match,
      matchType: r.match?.matchType || null,
      libraryMissing: r.libraryMissing || false,
    })),
  };

  await cachePut('pattern-match:latest', payload, 90);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=30',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
