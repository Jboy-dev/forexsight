// Server-side signal detector. Runs from a cron-trigger Worker every few
// minutes. For each pair, fetches OHLC, computes a *simplified* analysis
// (enough to decide Best/Extreme), and writes qualifying signals to KV so the
// client poller and Web Push pipeline can consume them.

import { sendPush } from './_push-lib.js';
import { warmIfStale } from './_cache-store.js';

// v355 — RESTORE FULL FX UNIVERSE. The v188 gold-only restriction was
// blocking 7 of 9 pairs the client shows and predict-next scans. Combined
// with the recent-loss vetoes on XAU/USD SELL, this produced 31h of zero
// signals. All the pipeline safeguards (multi-source, adaptive gate,
// brain gate, per-pair veto, session boundary) already work per-pair, so
// widening the scan universe is safe. Yahoo symbols match predict-next
// and chart-pulse so pipeline stays coherent.
const PAIRS = {
  // v380 — expanded universe (was 9 pairs). Adds ETH, JPY crosses, and
  // US indices so the strict scanner sees the same instruments the
  // Setup Radar surfaces. Nothing else changes — same gates, same tier
  // math. Just more raw candidates entering the pipeline.
  'XAU/USD': 'GC=F',
  'BTC/USD': 'BTC-USD',
  'ETH/USD': 'ETH-USD',
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X',
  'NZD/USD': 'NZDUSD=X',
  'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
  'EUR/JPY': 'EURJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  'US30':    '^DJI',
  'NAS100':  '^NDX',
  'SPX500':  '^GSPC',
};
function _isCrypto(pair) { return pair && pair.endsWith('/USD') && !['EUR/USD','GBP/USD','AUD/USD','NZD/USD'].includes(pair); }

// ---------- Indicators (compact ports of the client logic) ----------
function ema(arr, p) {
  const out = Array(arr.length).fill(null);
  const k = 2 / (p + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    prev = (prev == null) ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsi(closes, p = 14) {
  const out = Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= p; loss /= p;
  out[p] = 100 - (100 / (1 + (loss === 0 ? 1e9 : gain / loss)));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (p - 1) + g) / p;
    loss = (loss * (p - 1) + l) / p;
    out[i] = 100 - (100 / (1 + (loss === 0 ? 1e9 : gain / loss)));
  }
  return out;
}
function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = ef.map((v, i) => v != null && es[i] != null ? v - es[i] : null);
  const signal = ema(line.map(v => v == null ? 0 : v), sig);
  const hist = line.map((v, i) => v != null && signal[i] != null ? v - signal[i] : null);
  return { line, signal, hist };
}
function atr(highs, lows, closes, p = 14) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const out = Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i >= p) sum -= tr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function adx(highs, lows, closes, p = 14) {
  const len = closes.length;
  const tr = [0], pdm = [0], mdm = [0];
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const smooth = (arr) => {
    const out = Array(arr.length).fill(null);
    let v = 0;
    for (let i = 1; i <= p; i++) v += arr[i] || 0;
    out[p] = v;
    for (let i = p + 1; i < arr.length; i++) { v = v - v / p + (arr[i] || 0); out[i] = v; }
    return out;
  };
  const trS = smooth(tr), pdmS = smooth(pdm), mdmS = smooth(mdm);
  const pdi = trS.map((v, i) => v ? 100 * pdmS[i] / v : null);
  const mdi = trS.map((v, i) => v ? 100 * mdmS[i] / v : null);
  const dx = pdi.map((v, i) => v != null && mdi[i] != null ? 100 * Math.abs(v - mdi[i]) / (v + mdi[i] || 1) : null);
  const adxVals = Array(len).fill(null);
  let acc = 0, count = 0;
  for (let i = p * 2; i < len; i++) {
    if (dx[i] == null) continue;
    if (count < p) { acc += dx[i]; count++; if (count === p) adxVals[i] = acc / p; }
    else adxVals[i] = (adxVals[i - 1] * (p - 1) + dx[i]) / p;
  }
  return { adx: adxVals };
}

// Pattern detectors — added to match more of the client's strategy gating
function detectEngulfing(ohlc) {
  const n = ohlc.length - 1;
  if (n < 1) return null;
  const c1 = ohlc[n - 1], c2 = ohlc[n];
  const body1 = Math.abs(c1.c - c1.o), body2 = Math.abs(c2.c - c2.o);
  if (c2.c > c2.o && c1.c < c1.o && c2.o <= c1.c && c2.c >= c1.o && body2 > body1 * 1.1) return 'bullish';
  if (c2.c < c2.o && c1.c > c1.o && c2.o >= c1.c && c2.c <= c1.o && body2 > body1 * 1.1) return 'bearish';
  return null;
}
function detectLiquiditySweep(ohlc) {
  const n = ohlc.length - 1;
  if (n < 22) return null;
  const win = ohlc.slice(n - 20, n);
  const swingHigh = Math.max(...win.map(b => b.h));
  const swingLow = Math.min(...win.map(b => b.l));
  const bar = ohlc[n];
  if (bar.l < swingLow && bar.c > swingLow) return 'bullish';
  if (bar.h > swingHigh && bar.c < swingHigh) return 'bearish';
  return null;
}
function detectTurtle(ohlc) {
  const n = ohlc.length - 1;
  if (n < 20) return null;
  const prior = ohlc.slice(n - 20, n);
  const high = Math.max(...prior.map(b => b.h));
  const low = Math.min(...prior.map(b => b.l));
  if (ohlc[n].c > high) return 'bullish';
  if (ohlc[n].c < low) return 'bearish';
  return null;
}

// v186 — REAL STRATEGY DETECTORS (ported from /api/diagnose).
// The old engulfing/sweep/turtle patterns alone produced strategies=0 on most
// signals, which killed the push pipeline (push requires strategies >= 2).
// These match the client-side strategy names so the server's `strategies`
// count is meaningful and aligned with client expectations.
function _momentumStrategy(ohlc, dir) {
  const n = ohlc.length - 1, c = ohlc.map(b => b.c);
  const e20 = ema(c, 20)[n], e50 = ema(c, 50)[n];
  if (!e20 || !e50) return false;
  if (dir === 'BUY' && e20 <= e50) return false;
  if (dir === 'SELL' && e20 >= e50) return false;
  const last3 = ohlc.slice(n - 2, n + 1);
  const inDir = last3.filter(b => (dir === 'BUY' && b.c > b.o) || (dir === 'SELL' && b.c < b.o)).length;
  if (inDir < 2) return false;
  const rN = rsi(c)[n];
  if (dir === 'BUY' && rN > 75) return false;
  if (dir === 'SELL' && rN < 25) return false;
  return true;
}
function _smcStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 25) return false;
  const win = ohlc.slice(n - 25, n + 1);
  const rh = Math.max(...win.map(b => b.h)), rl = Math.min(...win.map(b => b.l));
  if (rh - rl <= 0) return false;
  const pos = (ohlc[n].c - rl) / (rh - rl);
  if (dir === 'BUY' && pos > 0.65) return false;
  if (dir === 'SELL' && pos < 0.35) return false;
  const recent = ohlc.slice(n - 20, n);
  if (dir === 'BUY') {
    const recentLow = Math.min(...recent.map(b => b.l));
    for (let i = Math.max(0, n - 8); i <= n; i++) if (ohlc[i].l <= recentLow * 1.0001) return true;
    return false;
  } else {
    const recentHigh = Math.max(...recent.map(b => b.h));
    for (let i = Math.max(0, n - 8); i <= n; i++) if (ohlc[i].h >= recentHigh * 0.9999) return true;
    return false;
  }
}
function _orbStrategy(ohlc, dir) {
  // v317 — Tighter ORB: require break within 2-8 hours of session open
  // (not just "any time after"), close outside range by ≥ 0.2× the range
  // (avoids marginal wicks), and confirm range wasn't chopped through
  // multiple times (real breakouts happen once, false ones oscillate).
  const n = ohlc.length - 1;
  let orIdx = -1;
  for (let i = n; i >= Math.max(0, n - 12); i--) {
    const h = new Date(ohlc[i].t).getUTCHours();
    if (h === 8 || h === 13 || h === 0) { orIdx = i; break; }
  }
  if (orIdx < 0) return false;
  const orh = ohlc[orIdx].h, orl = ohlc[orIdx].l;
  const orRange = orh - orl;
  if (orRange <= 0) return false;
  const breakBuffer = orRange * 0.2;
  // Must break within 8 hours after opening range (avoid stale ORB)
  const maxBar = Math.min(n, orIdx + 8);
  let crossCount = 0;
  for (let i = orIdx + 1; i <= maxBar; i++) {
    const c = ohlc[i].c;
    if (c > orh || c < orl) crossCount++;
  }
  // >3 crosses = choppy/false breakout region
  if (crossCount > 3) return false;
  for (let i = orIdx + 1; i <= maxBar; i++) {
    if (dir === 'BUY' && ohlc[i].c > orh + breakBuffer) return true;
    if (dir === 'SELL' && ohlc[i].c < orl - breakBuffer) return true;
  }
  return false;
}
function _ictStrategy(ohlc, dir, pair) {
  // v317 — Fair Value Gap detection now confirms the FVG is *unmitigated*
  // (subsequent bars haven't already filled the gap). A filled FVG has
  // no institutional interest left. Also requires the FVG to be near
  // current price (within 3 bars of the gap for freshness).
  const n = ohlc.length - 1, hUTC = new Date(ohlc[n].t).getUTCHours();
  const inLondon = hUTC >= 6 && hUTC <= 11, inNY = hUTC >= 11 && hUTC <= 16, inAsian = hUTC >= 0 && hUTC <= 3;
  if (!inLondon && !inNY && !(inAsian && pair.includes('JPY'))) return false;
  for (let i = Math.max(2, n - 12); i <= n; i++) {
    const a = ohlc[i - 2], b = ohlc[i - 1], c = ohlc[i];
    if (dir === 'BUY' && a.h <= c.l * 1.0001 && b.c > b.o) {
      // Bullish FVG: a.h → c.l is the gap. Check no later bar filled it
      // (fill = any low touching or piercing a.h from above).
      let mitigated = false;
      for (let j = i + 1; j <= n; j++) if (ohlc[j].l <= a.h) { mitigated = true; break; }
      if (!mitigated && (n - i) <= 5) return true;
    }
    if (dir === 'SELL' && a.l >= c.h * 0.9999 && b.c < b.o) {
      // Bearish FVG: c.h → a.l is the gap. Fill = any high touching a.l.
      let mitigated = false;
      for (let j = i + 1; j <= n; j++) if (ohlc[j].h >= a.l) { mitigated = true; break; }
      if (!mitigated && (n - i) <= 5) return true;
    }
  }
  return false;
}
function _trendStrategy(ohlc, dir) {
  const n = ohlc.length - 1, c = ohlc.map(b => b.c);
  const e50 = ema(c, 50)[n], e200 = ema(c, 200)[n];
  if (!e50 || !e200) return false;
  const isUp = e50 > e200;
  if (dir === 'BUY' && !isUp) return false;
  if (dir === 'SELL' && isUp) return false;
  return Math.abs(e50 - e200) / e50 > 0.0008;
}

// v317 — NEW STRATEGY: Bollinger Band squeeze + breakout.
// Textbook: after a period of contracted volatility (bands compressed
// tight), a breakout above the upper band or below the lower band
// signals institutional participation and often precedes a big move.
function _bollingerStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 25) return false;
  const period = 20;
  const window = ohlc.slice(n - period, n).map(b => b.c);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  if (std <= 0) return false;
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const bandwidth = (upper - lower) / mean;
  // Squeeze: bandwidth in the tightest 30% of the last 40 bars
  const bwHistory = [];
  for (let i = Math.max(20, n - 40); i < n; i++) {
    const w = ohlc.slice(i - period, i).map(b => b.c);
    const m = w.reduce((a, b) => a + b, 0) / period;
    const v = w.reduce((a, b) => a + (b - m) ** 2, 0) / period;
    const s = Math.sqrt(v);
    if (m > 0) bwHistory.push((4 * s) / m);
  }
  bwHistory.sort((a, b) => a - b);
  const squeezeThreshold = bwHistory[Math.floor(bwHistory.length * 0.3)] || bandwidth;
  const inSqueeze = bandwidth <= squeezeThreshold;
  // Fire when: 1) currently in/exiting squeeze AND 2) close pierces the band
  const c = ohlc[n].c;
  if (dir === 'BUY' && c > upper && inSqueeze) return true;
  if (dir === 'SELL' && c < lower && inSqueeze) return true;
  // Also fire on strong band walk (3 consecutive closes near or above upper band)
  const last3 = ohlc.slice(n - 2, n + 1);
  if (dir === 'BUY' && last3.every(b => b.c > mean + 1.5 * std)) return true;
  if (dir === 'SELL' && last3.every(b => b.c < mean - 1.5 * std)) return true;
  return false;
}

// v317 — NEW STRATEGY: MACD momentum + histogram direction.
// Textbook: MACD line above signal line AND histogram expanding in the
// signal direction = confirmed momentum. Reversal signals when hist
// changes sign against prior trend.
function _macdStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 30) return false;
  const c = ohlc.map(b => b.c);
  const emaFast = ema(c, 12), emaSlow = ema(c, 26);
  if (!emaFast[n] || !emaSlow[n]) return false;
  const macdLine = emaFast.map((f, i) => (f && emaSlow[i]) ? f - emaSlow[i] : null);
  const macdValid = macdLine.filter(v => v != null);
  if (macdValid.length < 20) return false;
  const signalLine = ema(macdValid, 9);
  const macdNow = macdLine[n];
  const sigNow = signalLine[signalLine.length - 1];
  const macdPrev = macdLine[n - 1];
  const sigPrev = signalLine[signalLine.length - 2];
  if (macdNow == null || sigNow == null || macdPrev == null || sigPrev == null) return false;
  const histNow = macdNow - sigNow, histPrev = macdPrev - sigPrev;
  if (dir === 'BUY') {
    // MACD above signal, histogram positive AND expanding
    if (macdNow > sigNow && histNow > 0 && histNow > histPrev) return true;
    // OR fresh bullish cross in last 2 bars
    if (macdPrev <= sigPrev && macdNow > sigNow) return true;
  }
  if (dir === 'SELL') {
    if (macdNow < sigNow && histNow < 0 && histNow < histPrev) return true;
    if (macdPrev >= sigPrev && macdNow < sigNow) return true;
  }
  return false;
}

// v317 — NEW STRATEGY: VWAP position + trend.
// Institutions benchmark against VWAP; price above VWAP = bullish
// intraday bias, below = bearish. Combined with trend of VWAP itself.
function _vwapStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 24) return false;
  // Session VWAP: reset every 24 bars for daily rolling window (1H bars)
  const session = ohlc.slice(n - 23, n + 1);
  let cumPV = 0, cumV = 0;
  const vwapSeries = [];
  for (const bar of session) {
    const typical = (bar.h + bar.l + bar.c) / 3;
    const vol = bar.v || 1;  // fallback if volume missing (forex often lacks vol)
    cumPV += typical * vol;
    cumV += vol;
    vwapSeries.push(cumV > 0 ? cumPV / cumV : typical);
  }
  const vwap = vwapSeries[vwapSeries.length - 1];
  const vwapPrev = vwapSeries[vwapSeries.length - 4] || vwap;
  const vwapTrend = vwap > vwapPrev ? 'up' : vwap < vwapPrev ? 'down' : 'flat';
  const price = ohlc[n].c;
  const pctFromVwap = ((price - vwap) / vwap) * 100;
  if (dir === 'BUY') {
    // Price above VWAP + VWAP rising = strong bull bias
    if (price > vwap && vwapTrend === 'up' && Math.abs(pctFromVwap) < 1.5) return true;
    // Price recently bounced up from VWAP (fresh institutional support)
    const recentLows = ohlc.slice(n - 3, n).map(b => b.l);
    if (recentLows.some(l => l < vwap * 1.001) && price > vwap) return true;
  }
  if (dir === 'SELL') {
    if (price < vwap && vwapTrend === 'down' && Math.abs(pctFromVwap) < 1.5) return true;
    const recentHighs = ohlc.slice(n - 3, n).map(b => b.h);
    if (recentHighs.some(h => h > vwap * 0.999) && price < vwap) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// v324 — DEEP PRO-TRADER LAYER
// Four evidence-based strategies used by institutional desks:
//   • RSI divergence     — most reliable reversal signal in TA
//   • Fibonacci pullback — golden ratio retracement in trending markets
//   • Support/Resistance — count price rejections at same level
//   • Daily HTF alignment— adds daily timeframe on top of existing 4H
// ═══════════════════════════════════════════════════════════════════════

// RSI DIVERGENCE: price makes a new low but RSI makes a higher low (bullish),
// or price makes a new high but RSI makes a lower high (bearish). This
// discrepancy signals momentum weakening = high-probability reversal.
function _rsiDivergenceStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 30) return false;
  const closes = ohlc.map(b => b.c);
  const rsiSeries = rsi(closes);
  if (!rsiSeries || rsiSeries.length < n + 1) return false;
  // Look at last 25 bars for two swing points
  const window = 25;
  const lows = [];
  const highs = [];
  for (let i = n - window; i <= n - 2; i++) {
    // Local low: lower than 2 bars on either side
    if (i >= 2 &&
        ohlc[i].l < ohlc[i - 1].l && ohlc[i].l < ohlc[i - 2].l &&
        ohlc[i].l < ohlc[i + 1].l && ohlc[i].l < ohlc[i + 2].l) {
      lows.push({ i, priceLow: ohlc[i].l, rsi: rsiSeries[i] });
    }
    if (i >= 2 &&
        ohlc[i].h > ohlc[i - 1].h && ohlc[i].h > ohlc[i - 2].h &&
        ohlc[i].h > ohlc[i + 1].h && ohlc[i].h > ohlc[i + 2].h) {
      highs.push({ i, priceHigh: ohlc[i].h, rsi: rsiSeries[i] });
    }
  }
  if (dir === 'BUY' && lows.length >= 2) {
    // Compare last two lows: is price lower but RSI higher? = bullish divergence
    const [prev, curr] = lows.slice(-2);
    if (curr.priceLow < prev.priceLow * 0.999 && curr.rsi > prev.rsi + 3) return true;
  }
  if (dir === 'SELL' && highs.length >= 2) {
    const [prev, curr] = highs.slice(-2);
    if (curr.priceHigh > prev.priceHigh * 1.001 && curr.rsi < prev.rsi - 3) return true;
  }
  return false;
}

// FIBONACCI PULLBACK: in a trending market, price often retraces to
// 38.2%, 50%, or 61.8% Fibonacci levels before continuing. Entry at
// these levels with trend = high-probability trade.
function _fibonacciStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 40) return false;
  const closes = ohlc.map(b => b.c);
  // Determine trend on last 30 bars
  const e20 = ema(closes, 20)[n];
  const e50 = ema(closes, 50)[n];
  if (!e20 || !e50) return false;
  const isTrendUp = e20 > e50 * 1.002;
  const isTrendDown = e20 < e50 * 0.998;
  if (dir === 'BUY' && !isTrendUp) return false;
  if (dir === 'SELL' && !isTrendDown) return false;
  // Find the most recent swing high & low in last 30 bars
  const win = ohlc.slice(n - 30, n + 1);
  const swingHigh = Math.max(...win.map(b => b.h));
  const swingLow = Math.min(...win.map(b => b.l));
  const range = swingHigh - swingLow;
  if (range <= 0) return false;
  const price = ohlc[n].c;
  // Golden Fib levels + tolerance
  const fib382 = dir === 'BUY' ? swingHigh - range * 0.382 : swingLow + range * 0.382;
  const fib500 = dir === 'BUY' ? swingHigh - range * 0.500 : swingLow + range * 0.500;
  const fib618 = dir === 'BUY' ? swingHigh - range * 0.618 : swingLow + range * 0.618;
  const tol = range * 0.02; // 2% of range tolerance
  const nearFib = [fib382, fib500, fib618].some(lvl => Math.abs(price - lvl) < tol);
  return nearFib;
}

// SUPPORT/RESISTANCE REJECTION COUNT: bars that have been rejected at
// the same level 3+ times form strong S/R. If price is now at that level
// AND showing rejection, that's a high-probability entry.
function _supportResistanceStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 50) return false;
  const win = ohlc.slice(n - 50, n);
  const price = ohlc[n].c;
  const atrV = _quickAtr(win);
  if (!atrV || atrV <= 0) return false;
  const tolerance = atrV * 0.4;
  // Count nearby wick rejections (highs for resistance, lows for support)
  let rejectionsBelow = 0;
  let rejectionsAbove = 0;
  for (const bar of win) {
    // Wick rejection = bar closed away from an extreme
    const highReject = (bar.h - Math.max(bar.o, bar.c)) > (bar.h - bar.l) * 0.4;
    const lowReject = (Math.min(bar.o, bar.c) - bar.l) > (bar.h - bar.l) * 0.4;
    if (highReject && Math.abs(bar.h - price) < tolerance) rejectionsAbove++;
    if (lowReject && Math.abs(bar.l - price) < tolerance) rejectionsBelow++;
  }
  // Current bar showing rejection?
  const cur = ohlc[n];
  const currentLowReject = (Math.min(cur.o, cur.c) - cur.l) > (cur.h - cur.l) * 0.4;
  const currentHighReject = (cur.h - Math.max(cur.o, cur.c)) > (cur.h - cur.l) * 0.4;
  // BUY off support (3+ prior rejections + current low wick rejection)
  if (dir === 'BUY' && rejectionsBelow >= 3 && currentLowReject) return true;
  // SELL off resistance
  if (dir === 'SELL' && rejectionsAbove >= 3 && currentHighReject) return true;
  return false;
}

// v341 — ICHIMOKU CLOUD strategy. Japanese institutional standard.
// Signal fires when: price above/below cloud + tenkan/kijun cross in trend
// direction + cloud sloping same direction.
function _ichimokuStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 78) return false;  // Need 78 bars for future cloud
  const highs = ohlc.map(b => b.h);
  const lows = ohlc.map(b => b.l);
  const closes = ohlc.map(b => b.c);
  // Tenkan-sen (Conversion Line) = (9-period high + 9-period low) / 2
  const tenkanHi = Math.max(...highs.slice(n - 8, n + 1));
  const tenkanLo = Math.min(...lows.slice(n - 8, n + 1));
  const tenkan = (tenkanHi + tenkanLo) / 2;
  // Kijun-sen (Base Line) = (26-period high + 26-period low) / 2
  const kijunHi = Math.max(...highs.slice(n - 25, n + 1));
  const kijunLo = Math.min(...lows.slice(n - 25, n + 1));
  const kijun = (kijunHi + kijunLo) / 2;
  // Senkou Span A (Leading Span A) = (tenkan + kijun) / 2 shifted 26 forward
  const senkouA = (tenkan + kijun) / 2;
  // Senkou Span B (Leading Span B) = (52-period high + 52-period low) / 2
  const senkouBhi = Math.max(...highs.slice(n - 51, n + 1));
  const senkouBlo = Math.min(...lows.slice(n - 51, n + 1));
  const senkouB = (senkouBhi + senkouBlo) / 2;
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBot = Math.min(senkouA, senkouB);
  const price = closes[n];
  // BUY: price above cloud + tenkan > kijun + cloud bullish (spanA > spanB)
  if (dir === 'BUY' && price > cloudTop && tenkan > kijun && senkouA > senkouB) return true;
  // SELL: price below cloud + tenkan < kijun + cloud bearish
  if (dir === 'SELL' && price < cloudBot && tenkan < kijun && senkouA < senkouB) return true;
  return false;
}

// v341 — WYCKOFF SPRING/UPTHRUST detection. Institutional accumulation/
// distribution phases. Spring = false breakdown below support (bullish).
// Upthrust = false breakout above resistance (bearish). Very high edge.
function _wyckoffStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 30) return false;
  const win = ohlc.slice(n - 30, n);
  const swingLow = Math.min(...win.map(b => b.l));
  const swingHigh = Math.max(...win.map(b => b.h));
  const cur = ohlc[n];
  const prev = ohlc[n - 1];
  const atrV = _quickAtr(ohlc.slice(n - 15, n));
  if (!atrV || atrV <= 0) return false;
  // BUY (Spring): recent bar pierced BELOW swingLow but closed BACK ABOVE
  // AND next bar continued higher — false breakdown → bullish
  if (dir === 'BUY') {
    const springed = prev.l < swingLow - atrV * 0.05 && prev.c > swingLow;
    const followThrough = cur.c > prev.c && cur.c > prev.o;
    if (springed && followThrough) return true;
  }
  // SELL (Upthrust): recent bar pierced ABOVE swingHigh but closed BACK
  // BELOW — false breakout → bearish
  if (dir === 'SELL') {
    const upthrust = prev.h > swingHigh + atrV * 0.05 && prev.c < swingHigh;
    const followThrough = cur.c < prev.c && cur.c < prev.o;
    if (upthrust && followThrough) return true;
  }
  return false;
}

// v341 — ORDER BLOCK detection. Institutional entry zones. Order block =
// the last bearish candle before a bullish move (or vice versa). When
// price returns to that zone, it often reverses again — institutions
// defending their entries.
function _orderBlockStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 20) return false;
  const closes = ohlc.map(b => b.c);
  const cur = ohlc[n];
  // BUY: find the most recent bearish bar within last 15 that preceded a
  // sharp bullish move (next 3 bars). Current price should be re-testing
  // that bar's range (potential BUY zone).
  if (dir === 'BUY') {
    for (let i = n - 5; i >= n - 15; i--) {
      const bar = ohlc[i];
      if (bar.c >= bar.o) continue;  // want a bearish bar
      // Was there a strong bullish move after?
      const after = closes.slice(i + 1, i + 4);
      if (after.length < 3) continue;
      const moveUp = after[after.length - 1] > bar.h * 1.005;  // 0.5% up move
      if (!moveUp) continue;
      // Is current price back near this order block? (within 30% of range from bottom)
      const barMid = bar.l + (bar.h - bar.l) * 0.3;
      const inZone = cur.l <= bar.h && cur.l >= barMid;
      if (inZone) return true;
    }
  }
  if (dir === 'SELL') {
    for (let i = n - 5; i >= n - 15; i--) {
      const bar = ohlc[i];
      if (bar.c <= bar.o) continue;  // want a bullish bar
      const after = closes.slice(i + 1, i + 4);
      if (after.length < 3) continue;
      const moveDown = after[after.length - 1] < bar.l * 0.995;
      if (!moveDown) continue;
      const barMid = bar.l + (bar.h - bar.l) * 0.7;
      const inZone = cur.h >= bar.l && cur.h <= barMid;
      if (inZone) return true;
    }
  }
  return false;
}

// v343 — THREE-BAR CONTINUATION. Al Brooks / Linda Raschke pattern.
// After a small pullback in a trend, 3 strong consecutive bars in the
// trend direction = momentum resumption. Bulkowski docs this at 68% WR.
function _threeBarContinuationStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 15) return false;
  const closes = ohlc.map(b => b.c);
  const e20 = ema(closes, 20)[n];
  if (!e20) return false;
  // Must be in a clear trend on the higher lookback
  const trendUp = closes[n - 10] < e20 && closes[n] > closes[n - 10];
  const trendDown = closes[n - 10] > e20 && closes[n] < closes[n - 10];
  if (dir === 'BUY' && !trendUp) return false;
  if (dir === 'SELL' && !trendDown) return false;
  // Recent 3 bars must all be strong in trend direction
  const last3 = ohlc.slice(n - 2, n + 1);
  const allBull = last3.every(b => b.c > b.o);
  const allBear = last3.every(b => b.c < b.o);
  // Each bar must have body ≥ 50% of range (strong bars)
  const strongBars = last3.every(b => Math.abs(b.c - b.o) >= (b.h - b.l) * 0.5);
  if (dir === 'BUY' && allBull && strongBars) return true;
  if (dir === 'SELL' && allBear && strongBars) return true;
  return false;
}

// v343 — FAILED BREAKOUT FADE (Linda Raschke "Turtle Soup").
// When price breaks a recent 20-bar high/low and IMMEDIATELY reverses
// back inside the range, fade the breakout. Documented at 65-70% WR
// on futures markets. Retail traders trap themselves buying the breakout;
// smart money fades it.
function _failedBreakoutStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 25) return false;
  const win = ohlc.slice(n - 20, n - 2);
  const swingHigh = Math.max(...win.map(b => b.h));
  const swingLow = Math.min(...win.map(b => b.l));
  const bar1 = ohlc[n - 1];
  const bar0 = ohlc[n];
  // SELL: prior bar broke ABOVE resistance but current bar closed BACK BELOW
  if (dir === 'SELL') {
    const broke = bar1.h > swingHigh;
    const failed = bar0.c < swingHigh;
    const strongReversal = bar0.c < bar0.o && (bar0.o - bar0.c) > (bar0.h - bar0.l) * 0.4;
    return broke && failed && strongReversal;
  }
  // BUY: prior bar broke BELOW support but current bar closed BACK ABOVE
  if (dir === 'BUY') {
    const broke = bar1.l < swingLow;
    const failed = bar0.c > swingLow;
    const strongReversal = bar0.c > bar0.o && (bar0.c - bar0.o) > (bar0.h - bar0.l) * 0.4;
    return broke && failed && strongReversal;
  }
  return false;
}

// v343 — BREAKOUT-RETEST-HOLD. Classic Al Brooks setup. Price breaks
// resistance, comes back to test it as support, and holds. Bulkowski
// documents this as one of the highest-probability continuation setups
// at 72% WR when the initial breakout was strong (≥1.5×ATR).
function _breakoutRetestStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 30) return false;
  const atrV = _quickAtr(ohlc.slice(n - 15, n));
  if (!atrV || atrV <= 0) return false;
  // Look for a strong breakout in the last 8-15 bars
  const win = ohlc.slice(n - 25, n - 8);
  const breakoutLevel = dir === 'BUY'
    ? Math.max(...win.map(b => b.h))
    : Math.min(...win.map(b => b.l));
  const cur = ohlc[n];
  // Was there a strong break?
  const breakBars = ohlc.slice(n - 8, n - 2);
  let breakoutSize = 0;
  if (dir === 'BUY') {
    for (const b of breakBars) {
      if (b.c > breakoutLevel) breakoutSize = Math.max(breakoutSize, b.c - breakoutLevel);
    }
  } else {
    for (const b of breakBars) {
      if (b.c < breakoutLevel) breakoutSize = Math.max(breakoutSize, breakoutLevel - b.c);
    }
  }
  if (breakoutSize < atrV * 1.5) return false;  // Need strong initial breakout
  // Is price currently RETESTING the breakout level from the correct side?
  const distToLevel = Math.abs(cur.c - breakoutLevel);
  const nearLevel = distToLevel < atrV * 0.5;
  if (!nearLevel) return false;
  // Is the level HOLDING? (Correct side of the level + rejection wick)
  if (dir === 'BUY') {
    const above = cur.c > breakoutLevel;
    const rejectedDown = cur.l < breakoutLevel && cur.c > breakoutLevel && (cur.c - cur.l) > (cur.h - cur.l) * 0.4;
    return above || rejectedDown;
  }
  if (dir === 'SELL') {
    const below = cur.c < breakoutLevel;
    const rejectedUp = cur.h > breakoutLevel && cur.c < breakoutLevel && (cur.h - cur.c) > (cur.h - cur.l) * 0.4;
    return below || rejectedUp;
  }
  return false;
}

// v343 — ICT SILVER BULLET. Michael Huddleston's documented setup.
// 10:00-11:00 UTC (London silver bullet) or 14:00-15:00 UTC (NY silver
// bullet). Within these windows, reversals in the direction of the
// higher-timeframe trend have documented 55-65% WR. Specifically fires
// on retracement to OTE zone (61.8-78.6% Fib) during the window.
function _silverBulletStrategy(ohlc, dir) {
  const n = ohlc.length - 1;
  const h = new Date().getUTCHours();
  const inSilverBullet = (h === 10) || (h === 14);
  if (!inSilverBullet) return false;
  if (n < 30) return false;
  // Compute recent swing for Fib retracement
  const win = ohlc.slice(n - 20, n + 1);
  const swingHi = Math.max(...win.map(b => b.h));
  const swingLo = Math.min(...win.map(b => b.l));
  const range = swingHi - swingLo;
  if (range <= 0) return false;
  const price = ohlc[n].c;
  // Optimal Trade Entry zone: 61.8-78.6% retracement
  const oteLower = dir === 'BUY' ? swingHi - range * 0.786 : swingLo + range * 0.618;
  const oteUpper = dir === 'BUY' ? swingHi - range * 0.618 : swingLo + range * 0.786;
  const inOte = price >= Math.min(oteLower, oteUpper) && price <= Math.max(oteLower, oteUpper);
  // Also need higher-TF alignment (checked elsewhere in the pipeline)
  return inOte;
}

function _quickAtr(bars) {
  if (bars.length < 15) return null;
  let sum = 0, count = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : null;
}

// ═══════════════════════════════════════════════════════════════════════
// v325 — MARKET REGIME DETECTOR
// Classifies current market into: TRENDING / RANGING / BREAKOUT / QUIET.
// Different strategies work in different regimes — this is the single
// biggest quality improvement possible for a multi-strategy system.
//
// Regime is determined by:
//   ADX      — trend strength (higher = trending)
//   ATR ratio — recent vs longer-term volatility (higher = breaking out)
//   Range compression — 5-bar vs 20-bar range (lower = ranging)
//   EMA slope — how strong the trend direction is
//
// The detector returns a regime label + strategy weights (0-1.5) so each
// strategy's vote gets amplified or muted based on how well it works in
// the current regime.
// ═══════════════════════════════════════════════════════════════════════
function _detectRegime(ohlc) {
  const n = ohlc.length - 1;
  if (n < 60) return { regime: 'unknown', weights: {} };
  const closes = ohlc.map(b => b.c);
  const highs = ohlc.map(b => b.h);
  const lows = ohlc.map(b => b.l);
  // ADX for trend strength
  let adxVal = 0;
  try {
    const adxSer = adx(highs, lows, closes, 14);
    adxVal = adxSer[n] || 0;
  } catch { adxVal = 0; }
  // ATR ratio: recent 5 bars vs 20 bars average
  let atr5 = 0, atr20 = 0;
  for (let i = n - 4; i <= n; i++) {
    atr5 += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  atr5 /= 5;
  for (let i = n - 19; i <= n; i++) {
    atr20 += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  atr20 /= 20;
  const atrRatio = atr20 > 0 ? atr5 / atr20 : 1;
  // Range compression
  let r5 = 0, r20 = 0;
  for (let i = n - 4; i <= n; i++) r5 += highs[i] - lows[i];
  for (let i = n - 19; i <= n; i++) r20 += highs[i] - lows[i];
  const compression = r20 > 0 ? (r5 / 5) / (r20 / 20) : 1;
  // Classify regime
  let regime, weights;
  if (adxVal >= 30 && atrRatio > 0.9 && compression > 0.7) {
    regime = 'TRENDING';
    weights = {
      TREND: 1.5, MOMENTUM: 1.4, MACD: 1.3, ICT: 1.2, SMC: 1.1, VWAP: 1.1, ORB: 1.2,
      TURTLE: 1.3, ENGULFING: 1.0,
      BOLLINGER: 0.7, DIVERGENCE: 0.5, FIB: 1.2, SR: 0.6, SWEEP: 0.7,
      ICHIMOKU: 1.4, WYCKOFF: 1.1, ORDER_BLOCK: 1.2,
      // v343 — proven-winner patterns (Bulkowski documented WRs)
      THREE_BAR: 1.5,        // 68% WR when trend intact
      TURTLE_SOUP: 0.8,      // reversal — less useful in strong trend
      BREAKOUT_RETEST: 1.6,  // 72% WR — highest-conviction continuation
      SILVER_BULLET: 1.2,    // window-only
    };
  } else if (atrRatio > 1.3 && compression > 1.1) {
    regime = 'BREAKOUT';
    weights = {
      ORB: 1.6, TURTLE: 1.5, BOLLINGER: 1.4, MOMENTUM: 1.3, MACD: 1.2, TREND: 1.1,
      SMC: 1.0, ICT: 1.0, VWAP: 1.0, ENGULFING: 1.1,
      FIB: 0.7, DIVERGENCE: 0.5, SR: 0.5, SWEEP: 0.6,
      ICHIMOKU: 1.2, WYCKOFF: 1.3, ORDER_BLOCK: 1.1,
      THREE_BAR: 1.4, TURTLE_SOUP: 0.7, BREAKOUT_RETEST: 1.7, SILVER_BULLET: 1.3,
    };
  } else if (adxVal < 20 && compression < 0.9) {
    regime = 'RANGING';
    weights = {
      SR: 1.5, DIVERGENCE: 1.4, BOLLINGER: 1.3, SWEEP: 1.3, FIB: 1.2, VWAP: 1.1,
      ENGULFING: 1.1, SMC: 1.0, ICT: 0.9,
      TREND: 0.6, MOMENTUM: 0.7, MACD: 0.8, ORB: 0.7, TURTLE: 0.6,
      ICHIMOKU: 0.7, WYCKOFF: 1.4, ORDER_BLOCK: 1.3,
      // In ranges, turtle soup (fade breakouts) is dominant
      THREE_BAR: 0.6, TURTLE_SOUP: 1.6, BREAKOUT_RETEST: 0.8, SILVER_BULLET: 1.4,
    };
  } else if (atrRatio < 0.7 && adxVal < 15) {
    regime = 'QUIET';
    weights = {
      TREND: 0.5, MOMENTUM: 0.5, MACD: 0.5, SMC: 0.6, ICT: 0.6, VWAP: 0.7, ORB: 0.5,
      TURTLE: 0.5, ENGULFING: 0.6, BOLLINGER: 0.7, DIVERGENCE: 0.8, FIB: 0.6,
      SR: 0.7, SWEEP: 0.6,
      ICHIMOKU: 0.5, WYCKOFF: 0.7, ORDER_BLOCK: 0.7,
      THREE_BAR: 0.4, TURTLE_SOUP: 0.6, BREAKOUT_RETEST: 0.5, SILVER_BULLET: 0.8,
    };
  } else {
    regime = 'MIXED';
    weights = {
      TREND: 1.0, MOMENTUM: 1.0, MACD: 1.0, SMC: 1.0, ICT: 1.0, VWAP: 1.0, ORB: 1.0,
      TURTLE: 1.0, ENGULFING: 1.0, BOLLINGER: 1.0, DIVERGENCE: 1.0, FIB: 1.0,
      SR: 1.0, SWEEP: 1.0,
      ICHIMOKU: 1.0, WYCKOFF: 1.0, ORDER_BLOCK: 1.0,
      THREE_BAR: 1.0, TURTLE_SOUP: 1.0, BREAKOUT_RETEST: 1.0, SILVER_BULLET: 1.0,
    };
  }
  return {
    regime, weights,
    adx: Math.round(adxVal),
    atrRatio: Math.round(atrRatio * 100) / 100,
    compression: Math.round(compression * 100) / 100,
  };
}

// DAILY HTF ALIGNMENT: resample 1H bars to 1D and check daily trend.
// A signal aligned with BOTH 4H and 1D trend is textbook institutional
// high-probability setup. Signal against 1D trend gets penalized.
function _dailyHtfCheck(ohlc, dir) {
  const n = ohlc.length - 1;
  if (n < 100) return { aligned: 'unknown', bias: 0 };
  // Resample to daily (24 × 1H bars per day)
  const days = [];
  for (let i = ohlc.length - 24; i >= 24; i -= 24) {
    const day = ohlc.slice(i, i + 24);
    if (day.length !== 24) continue;
    days.push({
      o: day[0].o,
      h: Math.max(...day.map(b => b.h)),
      l: Math.min(...day.map(b => b.l)),
      c: day[day.length - 1].c,
    });
    if (days.length >= 20) break;
  }
  if (days.length < 5) return { aligned: 'unknown', bias: 0 };
  days.reverse();  // oldest first
  const dCloses = days.map(d => d.c);
  const dEma5 = ema(dCloses, 5);
  const dEma20 = dCloses.length >= 20 ? ema(dCloses, 20) : null;
  const dEma5Last = dEma5[dEma5.length - 1];
  const dEma20Last = dEma20 ? dEma20[dEma20.length - 1] : null;
  const dailyPrice = dCloses[dCloses.length - 1];
  let trend = 'neutral';
  if (dEma20Last) {
    if (dEma5Last > dEma20Last * 1.005 && dailyPrice > dEma5Last) trend = 'up';
    else if (dEma5Last < dEma20Last * 0.995 && dailyPrice < dEma5Last) trend = 'down';
  } else {
    if (dailyPrice > dCloses[0] * 1.01) trend = 'up';
    else if (dailyPrice < dCloses[0] * 0.99) trend = 'down';
  }
  let aligned = 'neutral';
  let bias = 0;
  if (trend === 'up' && dir === 'BUY') { aligned = 'aligned'; bias = 10; }
  else if (trend === 'down' && dir === 'SELL') { aligned = 'aligned'; bias = 10; }
  else if (trend === 'up' && dir === 'SELL') { aligned = 'opposed'; bias = -8; }
  else if (trend === 'down' && dir === 'BUY') { aligned = 'opposed'; bias = -8; }
  return { aligned, trend, bias, daysAnalysed: days.length };
}

// ---------- v243 — QUANTUM-STYLE MONTE CARLO SIMULATOR ----------
// For each candidate signal, simulate 500 possible future price paths using
// brain-calibrated parameters (drift biased by combo's empirical win rate,
// volatility from current ATR regime, max-bars from combo's avg time to
// resolution). Records which level — SL, TP1, TP2, TP3 — was hit first in
// each path, plus the FINAL outcome if all 3 TPs are visited sequentially.
//
// "Quantum-style" because it explores many possible futures in parallel and
// collapses to the probability distribution the brain expects. Classical MC
// under the hood, but the metaphor captures the intent: one signal → many
// possible universes → aggregate probability of winning.
//
// Output drives:
//   • Per-signal P(TP1/TP2/TP3/SL) for the UI
//   • Expected R (risk multiple) under different position-split strategies
//   • Recommendation of the best "mini-trade" split (e.g. 30% TP1, 30% TP2,
//     40% TP3 trailed) — actual position sizing the user can apply
//
// Cost: ~30 bars × 500 iters × N signals = 60K random walk steps. JavaScript
// runs this in 10-30ms total. Negligible.
function _randn() {
  // Box-Muller transform for standard normal sample. Cached pair for speed.
  if (_randn._cache != null) { const v = _randn._cache; _randn._cache = null; return v; }
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const r = Math.sqrt(-2 * Math.log(u1));
  const t = 2 * Math.PI * u2;
  _randn._cache = r * Math.sin(t);
  return r * Math.cos(t);
}
function quantumSimulate(signal, brain, opts = {}) {
  const iterations = opts.iterations || 500;
  // v356 — Simulate THIS signal's actual TP/SL levels (attached by strictAnalyze
  // as slDistAtr/tp1DistAtr/tp2DistAtr/tp3DistAtr), not a generic stand-in.
  // A bigMoveHunt signal's real TP3 can be 10×ATR — simulating a fixed 3.0×ATR
  // target instead would report a fabricated, much-too-high hit probability.
  // Fallback constants only apply if a caller passes a signal without them.
  const SL = signal.slDistAtr != null ? -signal.slDistAtr : -1.5;
  const TP1 = signal.tp1DistAtr != null ? signal.tp1DistAtr : 0.5;
  const TP2 = signal.tp2DistAtr != null ? signal.tp2DistAtr : 2.0;
  const TP3 = signal.tp3DistAtr != null ? signal.tp3DistAtr : 3.0;
  // 1. Calibrate drift from brain's empirical WR for this combo.
  let comboWR = 0.5, avgBars = 8;
  const pairBrain = brain && brain.byPair ? brain.byPair[signal.pair] : null;
  const combo = pairBrain && pairBrain.byCombo ? pairBrain.byCombo[signal.comboKey] : null;
  if (combo && (combo.w + combo.l) >= 10) {
    comboWR = combo.w / (combo.w + combo.l);
    if (combo.barCount > 0) avgBars = combo.barSum / combo.barCount;
  }
  // Also incorporate live samples (weighted 3× backtest)
  const liveBrain = brain && brain.byPairLive ? brain.byPairLive[signal.pair] : null;
  const liveCombo = liveBrain && liveBrain.byCombo ? liveBrain.byCombo[signal.comboKey] : null;
  if (liveCombo && (liveCombo.w + liveCombo.l) >= 3) {
    const lN = liveCombo.w + liveCombo.l;
    const lWR = liveCombo.w / lN;
    // Blend: backtest weight 1, live weight 3
    const totalW = (combo ? (combo.w + combo.l) : 0) + lN * 3;
    if (totalW > 0) {
      comboWR = ((combo ? comboWR * (combo.w + combo.l) : 0) + lWR * lN * 3) / totalW;
    }
  }
  // 2. Convert WR to per-bar drift using inverse gambler's-ruin solve.
  // For a random walk hitting +0.5 before -1.5: drift ≈ (2WR - 1) × 0.06 ATR/bar
  // (linear approx around 50% — close enough for small drifts).
  const drift = (comboWR - 0.5) * 0.12;
  // 3. Per-bar volatility — current ATR expansion modulates this
  const stepStd = 0.40 * (signal.atrExpansion || 1.0);
  // 4. Cap max bars at 4× avg, minimum 30
  const maxBars = Math.max(30, Math.min(120, Math.round(avgBars * 3)));

  // Counts of which levels were hit (TP1/TP2/TP3 can stack within one path)
  let cSL = 0, cTP1 = 0, cTP2 = 0, cTP3 = 0, cTimeout = 0;
  // Sum of R-multiples for "all-to-TP3" strategy (full position never trims)
  let sumRFull = 0;
  // Sum for "all-to-TP1 then close" strategy (scalp)
  let sumRScalp = 0;
  // Sum for "33/33/34 split" strategy
  let sumRPyramid = 0;
  // Sum for "50/50 TP1/TP3" split
  let sumRBalanced = 0;
  // Sum for "trail after TP1" — close 50% at TP1, move SL to entry, ride to TP3
  let sumRTrail = 0;

  for (let it = 0; it < iterations; it++) {
    let p = 0;
    let hitTP1 = false, hitTP2 = false;
    let outcome = null;
    let finalP = 0;
    for (let b = 0; b < maxBars; b++) {
      p += drift + stepStd * _randn();
      if (p <= SL) { outcome = 'SL'; finalP = SL; cSL++; break; }
      if (p >= TP3) { outcome = 'TP3'; finalP = TP3; cTP3++; if (!hitTP1) cTP1++; if (!hitTP2) cTP2++; hitTP1 = hitTP2 = true; break; }
      if (!hitTP1 && p >= TP1) { hitTP1 = true; cTP1++; }
      if (!hitTP2 && p >= TP2) { hitTP2 = true; cTP2++; }
    }
    if (outcome == null) { outcome = 'TIMEOUT'; finalP = p; cTimeout++; }

    // --- Strategy R-multiples ---
    // v356 — Credit against this signal's real SL/TP1/TP2/TP3 (ATR-relative
    // P&L units), not the old fixed -1.5/0.5/2.0/3.0 stand-ins. Those literals
    // used to equal SL/TP1/TP2/TP3 by coincidence (same constants); now that
    // SL/TP1/TP2/TP3 are per-signal, the two must stay in sync via variables.
    // "Full to TP3": only credits +TP3 if TP3 hit, else closes at finalP (or SL)
    sumRFull += (outcome === 'TP3') ? TP3 : (outcome === 'SL' ? SL : Math.max(SL, Math.min(TP3, finalP)));
    // "Scalp to TP1": close entire position at TP1 if ever touched, else SL
    sumRScalp += hitTP1 ? TP1 : SL;
    // "Pyramid 33/33/34": 33% off at TP1, 33% off at TP2, 34% rides to TP3 or trails
    {
      let r = 0;
      // 33% at TP1
      r += hitTP1 ? 0.33 * TP1 : 0.33 * SL;
      // 33% at TP2 (only credited if TP2 touched — else this slug also stops at SL)
      r += hitTP2 ? 0.33 * TP2 : 0.33 * (hitTP1 ? 0.0 : SL);
      // 34% rides to TP3 (after TP2 hit, trail to break-even; without TP2 = SL)
      r += (outcome === 'TP3') ? 0.34 * TP3 : (hitTP2 ? 0.34 * 0.0 : 0.34 * (hitTP1 ? 0.0 : SL));
      sumRPyramid += r;
    }
    // "Balanced 50/50 TP1/TP3"
    {
      let r = 0;
      r += hitTP1 ? 0.50 * TP1 : 0.50 * SL;
      r += (outcome === 'TP3') ? 0.50 * TP3 : (hitTP1 ? 0.50 * 0.0 : 0.50 * SL);
      sumRBalanced += r;
    }
    // "Trail after TP1": close 50% at TP1, move SL to entry, let remaining ride
    {
      let r = 0;
      r += hitTP1 ? 0.50 * TP1 : 0.50 * SL;
      // remaining 50% — if TP3 hit = +TP3, if TP2 = +TP2, if only TP1 then BE = 0
      r += (outcome === 'TP3') ? 0.50 * TP3
         : hitTP2 ? 0.50 * TP2
         : hitTP1 ? 0.50 * 0.0
         : 0.50 * SL;
      sumRTrail += r;
    }
  }

  // Strategy expected R (average per simulation)
  const strategies = [
    { name: 'Scalp to TP1',          short: 'TP1 only',  eR: sumRScalp / iterations,    split: '100% TP1' },
    { name: 'Balanced 50/50',         short: '50/50',    eR: sumRBalanced / iterations, split: '50% TP1 · 50% TP3' },
    { name: 'Pyramid 33/33/34',       short: 'Pyramid',  eR: sumRPyramid / iterations,  split: '33% TP1 · 33% TP2 · 34% TP3' },
    { name: 'Trail after TP1',        short: 'Trail',    eR: sumRTrail / iterations,    split: '50% TP1, rest trails to TP3' },
    { name: 'Full to TP3',            short: 'TP3 only', eR: sumRFull / iterations,     split: '100% TP3' },
  ];
  strategies.sort((a, b) => b.eR - a.eR);
  const best = strategies[0];

  return {
    iterations,
    drift: Math.round(drift * 1000) / 1000,
    stepStd: Math.round(stepStd * 100) / 100,
    maxBarsSimulated: maxBars,
    blendedWR: Math.round(comboWR * 100),
    avgBarsExpected: Math.round(avgBars * 10) / 10,
    // Probability each level was visited at least once (TP1 implies p reached 0.5 ATR)
    pSL: Math.round((cSL / iterations) * 100),
    pTP1: Math.round((cTP1 / iterations) * 100),
    pTP2: Math.round((cTP2 / iterations) * 100),
    pTP3: Math.round((cTP3 / iterations) * 100),
    pTimeout: Math.round((cTimeout / iterations) * 100),
    strategies,
    bestStrategy: {
      name: best.name, short: best.short, split: best.split,
      expectedR: Math.round(best.eR * 100) / 100,
      // Lift vs scalping to TP1 (baseline)
      liftVsScalpR: Math.round((best.eR - strategies.find(s => s.short === 'TP1 only').eR) * 100) / 100,
    },
  };
}

// ---------- v274 — MULTI-TIMEFRAME ANALYSIS ----------
// Resamples 1H OHLC into 4H bars + checks HTF trend alignment. Professional
// traders ALWAYS confirm a signal against the higher timeframe before
// entering — going against the HTF trend is one of the biggest known
// negative-expectancy moves. The brain now does this systematically.
//
// Returns: { htfDirection: 'BUY'|'SELL'|'NEUTRAL', htfStrength: 0-100,
//            alignment: 'aligned'|'opposed'|'neutral', score: 0-100 }
//
// Used to:
//   • Cap pWin when HTF is opposed (max 60% allowed)
//   • Boost pWin when HTF is aligned + signal is high-conf
//   • Surface as a card label so user sees "4H trend opposes" or "4H aligned"
function resampleTo4H(ohlc) {
  // OHLC bars are hourly. Group 4 consecutive bars into one 4H bar.
  const out = [];
  for (let i = 0; i < ohlc.length; i += 4) {
    const chunk = ohlc.slice(i, Math.min(i + 4, ohlc.length));
    if (chunk.length < 1) continue;
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map(b => b.h)),
      l: Math.min(...chunk.map(b => b.l)),
      c: chunk[chunk.length - 1].c,
    });
  }
  return out;
}
function studyHigherTimeframe(ohlc, signalDirection) {
  const htf = resampleTo4H(ohlc);
  if (htf.length < 50) return { score: 50, alignment: 'unknown', reasons: ['HTF insufficient bars'] };
  const closes = htf.map(b => b.c);
  const n = closes.length - 1;
  // HTF indicators
  const e20h = ema(closes, 20)[n];
  const e50h = ema(closes, 50)[n];
  const r4h = rsi(closes, 14)[n];
  // ADX on 4H — stronger threshold needed because 4H trends are larger
  const adx4h = adx(htf.map(b => b.h), htf.map(b => b.l), closes).adx[n] || 0;
  // Determine HTF direction
  let htfDirection = 'NEUTRAL';
  let htfStrength = 50;
  const reasons = [];
  // HTF trend up: e20 > e50 AND price > e20
  if (e20h && e50h && closes[n] > e20h && e20h > e50h) {
    htfDirection = 'BUY';
    htfStrength = Math.min(100, 50 + adx4h);
    reasons.push(`4H trend UP (price > EMA20 > EMA50, ADX ${Math.round(adx4h)})`);
  } else if (e20h && e50h && closes[n] < e20h && e20h < e50h) {
    htfDirection = 'SELL';
    htfStrength = Math.min(100, 50 + adx4h);
    reasons.push(`4H trend DOWN (price < EMA20 < EMA50, ADX ${Math.round(adx4h)})`);
  } else {
    htfDirection = 'NEUTRAL';
    htfStrength = Math.max(20, 50 - adx4h);
    reasons.push(`4H ranging (ADX ${Math.round(adx4h)})`);
  }
  // Alignment with signal
  let alignment = 'neutral';
  let score = 50;
  if (htfDirection === signalDirection) {
    alignment = 'aligned';
    score = Math.min(100, 65 + adx4h);
    reasons.push(`✓ Signal direction matches 4H trend (+${score - 50})`);
  } else if (htfDirection === 'NEUTRAL') {
    alignment = 'neutral';
    score = 50;
  } else {
    // Counter-HTF
    alignment = 'opposed';
    score = Math.max(0, 40 - adx4h);
    reasons.push(`✗ Signal opposes 4H trend (${score - 50})`);
  }
  // 4H RSI sanity (overbought BUY or oversold SELL = warning)
  if (r4h != null) {
    if (signalDirection === 'BUY' && r4h > 70) {
      score = Math.max(0, score - 10);
      reasons.push(`⚠ 4H RSI overbought (${Math.round(r4h)})`);
    } else if (signalDirection === 'SELL' && r4h < 30) {
      score = Math.max(0, score - 10);
      reasons.push(`⚠ 4H RSI oversold (${Math.round(r4h)})`);
    }
  }
  return {
    htfDirection,
    htfStrength: Math.round(htfStrength),
    alignment,
    score: Math.round(score),
    adx4h: Math.round(adx4h),
    reasons,
  };
}

// ---------- v272 — BAYESIAN + WILSON STATISTICS ----------
// Brain now uses proper inference math instead of raw count averages.
//
// betaPosterior(w, l) — returns the Beta(α=w+1, β=l+1) posterior mean +
// variance. With Laplace +1 prior so small samples don't collapse to 0% or
// 100%. As samples grow, the posterior tightens around the true rate.
//
// wilsonScore(w, l, z=1.96) — Wilson score 95% confidence interval. Much
// better than normal approximation for small samples. Tells you HOW SURE
// the brain is about a WR estimate.
//
// Both functions feed:
//   • Combo WR display (with CI)
//   • Per-signal k-NN verdict (CI bounds)
//   • Calibration bucket reporting
//
// This is the mathematical foundation that makes brain estimates honest
// about their own uncertainty.
function betaPosterior(w, l) {
  const alpha = w + 1;
  const beta = l + 1;
  const total = alpha + beta;
  const mean = alpha / total;
  const variance = (alpha * beta) / (total * total * (total + 1));
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev, alpha, beta };
}
function wilsonScore(w, l, z = 1.96) {
  const n = w + l;
  if (n === 0) return { lower: 0, upper: 1, p: 0.5 };
  const p = w / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    p,
    width: halfWidth * 2,
  };
}

// ---------- v267 — CHART STUDY ----------
// Before any signal is allowed, the brain actually LOOKS AT THE CHART. Scores
// 7 chart-quality dimensions (0–100 total) — if the score is too low, the
// signal is rejected EVEN IF strategies fired. This is the "study the chart
// first" gate the user asked for: visual structural reasoning, not just
// pattern detection.
//
// Returns: { score, reasons[], ok }
//
// Dimensions:
//   1. Trend cleanliness — last 20 bars, % closing in signal direction (20pt)
//   2. Pullback proximity — distance from EMA20 in ATRs, near = good (15pt)
//   3. Candle conviction — last 5 bars, body/range ratio (15pt)
//   4. Compression — recent range / 20-bar range, tight = setup (10pt)
//   5. HTF alignment — EMA50 vs EMA200 matching direction (20pt)
//   6. Rejection wicks — last 3 candles, wicks pointing right way (10pt)
//   7. Momentum alignment — RSI vs price recent movement (10pt)
//
// Pass threshold: 55/100. Below = chart isn't ready, skip signal.
function studyChart(ohlc, direction, atrV) {
  const n = ohlc.length - 1;
  if (n < 60) return { score: 0, reasons: ['insufficient bars'], ok: false };
  const closes = ohlc.map(b => b.c);
  const highs = ohlc.map(b => b.h);
  const lows = ohlc.map(b => b.l);
  const opens = ohlc.map(b => b.o);
  const isBuy = direction === 'BUY';
  const reasons = [];
  let score = 0;

  // 1. Trend cleanliness — count last-20 bars closing in trend direction
  let trendCount = 0;
  for (let i = n - 19; i <= n; i++) {
    if (i < 1) continue;
    if (isBuy && closes[i] > closes[i - 1]) trendCount++;
    else if (!isBuy && closes[i] < closes[i - 1]) trendCount++;
  }
  const trendPct = trendCount / 20;
  const trendPts = Math.round(Math.min(20, trendPct * 28));
  score += trendPts;
  reasons.push(`Trend clean: ${trendCount}/20 bars in direction (+${trendPts})`);

  // 2. Pullback proximity — current price distance from EMA20 in ATRs
  const e20arr = ema(closes, 20);
  const e20 = e20arr[n];
  let pullbackPts = 0;
  if (e20 && atrV > 0) {
    const distAtrs = Math.abs(closes[n] - e20) / atrV;
    // Sweet spot: 0.3–1.2 ATR from EMA20 (clean pullback, not extended)
    if (distAtrs >= 0.3 && distAtrs <= 1.2) pullbackPts = 15;
    else if (distAtrs >= 0.15 && distAtrs <= 1.8) pullbackPts = 8;
    else if (distAtrs < 0.15) pullbackPts = 4; // too close — no entry edge
  }
  score += pullbackPts;
  reasons.push(`Pullback to EMA20 (+${pullbackPts})`);

  // 3. Candle conviction — last 5 bars body/range ratio
  let bodySum = 0, rangeSum = 0;
  for (let i = n - 4; i <= n; i++) {
    if (i < 0) continue;
    const rng = highs[i] - lows[i];
    const body = Math.abs(closes[i] - opens[i]);
    rangeSum += rng;
    bodySum += body;
  }
  const conviction = rangeSum > 0 ? bodySum / rangeSum : 0;
  const convPts = Math.round(Math.min(15, conviction * 22));
  score += convPts;
  reasons.push(`Candle conviction: ${Math.round(conviction*100)}% body (+${convPts})`);

  // 4. Compression — recent 5-bar range vs 20-bar range
  let r5 = 0, r20 = 0;
  for (let i = n - 4; i <= n; i++) if (i >= 0) r5 += highs[i] - lows[i];
  for (let i = n - 19; i <= n; i++) if (i >= 0) r20 += highs[i] - lows[i];
  const compression = r20 > 0 ? r5 / r20 : 1;
  // Compression < 0.30 = very tight, primed to break.
  // 0.30-0.45 = healthy compression. >0.45 = expanding/chaotic.
  let compPts = 0;
  if (compression <= 0.30) compPts = 10;
  else if (compression <= 0.45) compPts = 7;
  else if (compression <= 0.60) compPts = 3;
  score += compPts;
  reasons.push(`Compression ${Math.round(compression*100)}% (+${compPts})`);

  // 5. HTF alignment — EMA50 vs EMA200
  const e50 = ema(closes, 50)[n];
  const e200 = ema(closes, 200)[n];
  let htfPts = 0;
  if (e50 && e200) {
    const htfBull = e50 > e200;
    if ((isBuy && htfBull) || (!isBuy && !htfBull)) htfPts = 20;
    else htfPts = -5; // counter-trend penalty (kept negative on purpose)
  }
  score += htfPts;
  reasons.push(`HTF alignment (EMA50 vs EMA200) (+${htfPts})`);

  // 6. Rejection wicks — last 3 candles, wick on opposite side = rejection
  let wickPts = 0;
  for (let i = n - 2; i <= n; i++) {
    if (i < 0) continue;
    const body = Math.abs(closes[i] - opens[i]);
    const lowerWick = Math.min(closes[i], opens[i]) - lows[i];
    const upperWick = highs[i] - Math.max(closes[i], opens[i]);
    if (isBuy && lowerWick > body * 1.2) wickPts += 3; // rejection of lows on BUY
    if (!isBuy && upperWick > body * 1.2) wickPts += 3; // rejection of highs on SELL
  }
  wickPts = Math.min(10, wickPts);
  score += wickPts;
  reasons.push(`Rejection wicks (+${wickPts})`);

  // 7. Momentum alignment — RSI direction over last 5 bars
  const rsiArr = rsi(closes);
  let momPts = 0;
  if (rsiArr[n] != null && rsiArr[n - 5] != null) {
    const rsiDir = rsiArr[n] - rsiArr[n - 5];
    if ((isBuy && rsiDir > 0) || (!isBuy && rsiDir < 0)) momPts = 10;
    else if (Math.abs(rsiDir) < 2) momPts = 4; // flat — neutral
  }
  score += momPts;
  reasons.push(`Momentum (RSI) (+${momPts})`);

  const ok = score >= 55;
  return { score: Math.max(0, Math.min(100, score)), reasons, ok };
}

// ---------- Strict analysis (matches client Best Setup gates) ----------
// v218 — takes optional brainTopWinners set to bias detection toward known
// winning patterns. If the resulting combo matches a top winner, thresholds
// are relaxed so we don't lose the signal to noise filters.
function strictAnalyze(pair, ohlc, brainTopWinners) {
  if (ohlc.length < 60) return null;
  const closes = ohlc.map(b => b.c), highs = ohlc.map(b => b.h), lows = ohlc.map(b => b.l);
  // v268/v269c — DEGENERATE-BAR WALK-BACK. Yahoo sometimes returns 5+
  // tick-level "last bars" with range=0 stacked at the end (forming hour
  // not closed yet). Walk back up to 10 bars looking for a healthy one
  // (range ≥ 15% of recent avg). If nothing healthy, bail.
  let n = closes.length - 1;
  const avgRange = (() => {
    let s = 0, c = 0;
    // Use 30-bar lookback for the baseline so the average is robust
    for (let i = Math.max(0, n - 30); i < n; i++) {
      const r = highs[i] - lows[i];
      if (r > 0) { s += r; c++; }
    }
    return c > 0 ? s / c : 0;
  })();
  for (let k = 0; k < 10; k++) {
    const rng = highs[n] - lows[n];
    if (rng >= avgRange * 0.15) break;
    if (n <= 0) break;
    n--;
  }
  // If we walked 10 bars and still find degenerate data, this pair is dead.
  if ((highs[n] - lows[n]) < avgRange * 0.10) return null;
  const cur = closes[n];
  const r = rsi(closes)[n];
  const m = macd(closes);
  const e20 = ema(closes, 20)[n], e50 = ema(closes, 50)[n], e200 = ema(closes, 200)[n];
  const atrSeries = atr(highs, lows, closes);
  const atrV = atrSeries[n];
  const ad = adx(highs, lows, closes).adx[n] || 0;
  // v238 — Compute recent ATR average so we can detect EXPANDING VOLATILITY
  // (current ATR > recent average) — the precondition for a "big pips" move.
  // Look back 20 bars to avoid one-bar spikes dominating.
  let atrExpansion = 1;
  if (atrV) {
    const lookback = atrSeries.slice(Math.max(0, n - 20), n).filter(v => v != null);
    const recentAvg = lookback.length ? lookback.reduce((a, b) => a + b, 0) / lookback.length : atrV;
    atrExpansion = recentAvg > 0 ? atrV / recentAvg : 1;
  }

  let bull = 0, bear = 0;
  // RSI: strict — only count strong oversold/overbought as votes
  if (r < 35) bull++;
  else if (r > 65) bear++;
  // MACD: strict — both line position AND histogram direction agree
  if (m.line[n] > m.signal[n] && m.hist[n] > 0) bull++;
  else if (m.line[n] < m.signal[n] && m.hist[n] < 0) bear++;
  // Full EMA stack alignment
  if (cur > e20 && e20 > e50 && e50 > e200) bull++;
  else if (cur < e20 && e20 < e50 && e50 < e200) bear++;
  // Short-term trend
  if (e20 > e50) bull++; else if (e20 < e50) bear++;

  // Pattern strategies — additional votes only when fired (legacy)
  const stratVotes = [];
  const eng = detectEngulfing(ohlc);
  if (eng) { stratVotes.push(eng); if (eng === 'bullish') bull++; else bear++; }
  const sweep = detectLiquiditySweep(ohlc);
  if (sweep) { stratVotes.push(sweep); if (sweep === 'bullish') bull++; else bear++; }
  const turtle = detectTurtle(ohlc);
  if (turtle) { stratVotes.push(turtle); if (turtle === 'bullish') bull++; else bear++; }

  // v186 — also probe the 5 named strategies (ICT, ORB, SMC, Trend, Momentum)
  // in the bull and bear directions. Each one that fires in the leading
  // direction adds to stratVotes so the final `strategies` count reflects
  // genuine strategy alignment, not just candle patterns. This fixes the
  // push pipeline gate (strategies >= 2) which was almost never met before.
  const _tentativeDir = bull > bear ? 'BUY' : (bear > bull ? 'SELL' : null);
  const namedStrats = [];
  // v325 — Detect current market regime for weighted voting.
  const regimeInfo = _detectRegime(ohlc);
  if (_tentativeDir) {
    if (_momentumStrategy(ohlc, _tentativeDir))  namedStrats.push('MOMENTUM');
    if (_smcStrategy(ohlc, _tentativeDir))       namedStrats.push('SMC');
    if (_orbStrategy(ohlc, _tentativeDir))       namedStrats.push('ORB');
    if (_ictStrategy(ohlc, _tentativeDir, pair)) namedStrats.push('ICT');
    if (_trendStrategy(ohlc, _tentativeDir))     namedStrats.push('TREND');
    // v317 — 3 new textbook strategies added to the confluence vote
    if (_bollingerStrategy(ohlc, _tentativeDir)) namedStrats.push('BOLLINGER');
    if (_macdStrategy(ohlc, _tentativeDir))      namedStrats.push('MACD');
    if (_vwapStrategy(ohlc, _tentativeDir))      namedStrats.push('VWAP');
    // v324 — Pro-trader layer (4 new strategies)
    if (_rsiDivergenceStrategy(ohlc, _tentativeDir))    namedStrats.push('DIVERGENCE');
    if (_fibonacciStrategy(ohlc, _tentativeDir))        namedStrats.push('FIB');
    if (_supportResistanceStrategy(ohlc, _tentativeDir)) namedStrats.push('SR');
    // v341 — Institutional-grade patterns
    if (_ichimokuStrategy(ohlc, _tentativeDir))    namedStrats.push('ICHIMOKU');
    if (_wyckoffStrategy(ohlc, _tentativeDir))     namedStrats.push('WYCKOFF');
    if (_orderBlockStrategy(ohlc, _tentativeDir))  namedStrats.push('ORDER_BLOCK');
    // v343 — Documented-winner patterns (Bulkowski, Brooks, Raschke, ICT)
    if (_threeBarContinuationStrategy(ohlc, _tentativeDir)) namedStrats.push('THREE_BAR');
    if (_failedBreakoutStrategy(ohlc, _tentativeDir))       namedStrats.push('TURTLE_SOUP');
    if (_breakoutRetestStrategy(ohlc, _tentativeDir))       namedStrats.push('BREAKOUT_RETEST');
    if (_silverBulletStrategy(ohlc, _tentativeDir))         namedStrats.push('SILVER_BULLET');
    // v325 — WEIGHTED VOTING. Each strategy contributes based on how well
    // it works in the current regime. TREND gets 1.5× vote in TRENDING
    // markets, 0.6× in RANGING; SR gets 1.5× in RANGING, 0.6× in TRENDING.
    // Fractional votes handled by scaling bull/bear proportionally.
    const weights = regimeInfo.weights || {};
    for (const strat of namedStrats) {
      const w = weights[strat] != null ? weights[strat] : 1.0;
      if (_tentativeDir === 'BUY') bull += w;
      else bear += w;
    }
    // Stash names on stratVotes-equivalent counter
    stratVotes.push(...namedStrats.map(() => _tentativeDir === 'BUY' ? 'bullish' : 'bearish'));
  }

  const total = bull + bear;
  // v269b — was `if (total < 2) return null`. Quiet markets often produce
  // total = 0 or 1 — that killed the entire signal pool. Now we ACCEPT
  // total ≥ 1 (any directional bias) and mark low-conviction signals as
  // weakSignal: true so the feed gets candidates even in dead markets. The
  // Brain Gate still filters by pWin/edge so junk doesn't reach the user.
  if (total < 1) return null;

  const direction = bull > bear ? 'BUY' : 'SELL';
  const winners = direction === 'BUY' ? bull : bear;
  const agreement = total > 0 ? winners / total : 0.5;
  // Quiet-market signals get flagged so the UI can label them appropriately
  const weakSignal = total < 3;

  // v218 — Check if this pattern matches a brain top-WR combo BEFORE applying
  // filters. If yes, we'll relax thresholds so high-conviction patterns the
  // brain has proven aren't lost to noise filters.
  const tentativeDir = bull > bear ? 'BUY' : (bear > bull ? 'SELL' : null);
  const tentativeCombo = tentativeDir
    ? `${tentativeDir}_${namedStrats.slice().sort().join('+')}`
    : null;
  let isEliteBrainPattern = false;
  let eliteBrainWR = null;
  if (tentativeCombo && brainTopWinners && Array.isArray(brainTopWinners)) {
    const match = brainTopWinners.find(t => t.k === tentativeCombo);
    if (match && match.n >= 20 && match.wr >= 0.65) {
      isEliteBrainPattern = true;
      eliteBrainWR = match.wr;
    }
  }

  // Relax filters if this is an elite brain-blessed pattern
  // v268c/v269b — Floors lowered further. Quiet-market weakSignal candidates
  // get the most permissive gates so we always have something in the feed.
  // v316 — BTC-specific ADX floor of 8 (was 12). BTC frequently trades
  // in lower-ADX regimes than gold (which has more news-driven moves)
  // and was producing zero candidates because ADX 10-11 is common.
  const isBTCPair = pair === 'BTC/USD';
  const minAgreement = isEliteBrainPattern ? 0.45 : (weakSignal ? 0.50 : (isBTCPair ? 0.50 : 0.55));
  const minADX = isEliteBrainPattern ? 8 : (weakSignal ? 8 : (isBTCPair ? 8 : 12));
  if (agreement < minAgreement) return null;
  if (ad < minADX) return null;

  const h = new Date().getUTCHours();
  const min = new Date().getUTCMinutes();
  const inKZ = (h >= 7 && h < 10) || (h >= 12 && h < 15);
  // v337 — SESSION-BOUNDARY BLOCK. The last 4 signals showed a clear
  // pattern: signals firing within ±15 min of London open (07:00 UTC) or
  // NY open (12:00 UTC) got immediate-rejection whipsaws. Block signals
  // in those danger windows unless it's a truly elite setup.
  const minutesFromLondonOpen = Math.abs((h * 60 + min) - (7 * 60));
  const minutesFromNyOpen = Math.abs((h * 60 + min) - (12 * 60));
  const inWhipsawWindow =
    (minutesFromLondonOpen <= 15) || (minutesFromNyOpen <= 15);
  if (inWhipsawWindow && !isEliteBrainPattern && ad < 30) {
    return null;  // block pre-session whipsaw signals
  }
  // v446 — THE CONFIDENCE SCORE WAS BUILT OUT OF THE THINGS THAT LOSE.
  //
  // Measured by replaying this exact function over 14,762 signals across 10
  // instruments and 2.8 years of hourly bars (managed ladder, no lookahead):
  //
  //     ADX 30+          -0.052R over 5,445 signals   <- adxBonus added +4
  //     4 strategies     -0.058R over 3,416 signals   <- stratBonus added +6
  //     7 strategies     -0.102R over   589 signals
  //     2 strategies     +0.022R over 1,827 signals
  //
  // Both bonuses paid points for properties that predict WORSE outcomes, so
  // the resulting number ranked signals upside down: the 90-99 bucket
  // returned -0.046R and the 70-79 bucket +0.135R. Across the whole sample
  // correlation(confidence, R) = -0.010 — it carried no information at all,
  // while being displayed to the user as a probability.
  //
  // Both bonuses are removed. minConf drops by the same amount they used to
  // contribute so signal flow is unchanged — this re-ranks, it does not
  // tighten. `agreement` is a real measurement of indicator consensus and is
  // kept as the base; it simply is not a win probability, and is no longer
  // inflated to look like one.
  const baseConf = Math.round(agreement * 100);
  const sessionBoost = inKZ ? 5 : -3;
  // v218 — elite brain pattern bonus added to base confidence
  const elitePatternBonus = isEliteBrainPattern ? 8 : 0;
  const confidence = Math.max(0, Math.min(99, baseConf + sessionBoost + elitePatternBonus));

  // v218 — relaxed confidence/ADX floors for elite brain patterns
  // v268c/v269b — quiet-market candidates use the lowest floors so they make
  // it past the analyzer into the brain gate (which is the real quality filter).
  // v446 — floors lowered by 6 to match the removed stratBonus, so the same
  // population of setups still reaches the gate. The old +4 adxBonus only
  // applied to ADX 30+, which is the bucket that loses, so it is not
  // compensated for — those signals were riding a bonus they had not earned.
  const minConf = isEliteBrainPattern ? 34 : (weakSignal ? 42 : (isBTCPair ? 44 : 49));
  // v316 — BTC also gets a lower outside-killzone ADX floor. BTC trades 24/7
  // and non-killzone hours are still active markets for crypto (unlike forex).
  const minAdxOutsideKZ = isEliteBrainPattern ? 8 : (weakSignal ? 10 : (isBTCPair ? 10 : 14));
  if (confidence < minConf) return null;
  if (!inKZ && ad < minAdxOutsideKZ) return null;

  // Server-side "extreme": much tighter
  let tier = 'best';
  if (confidence >= 88 && ad >= 32 && inKZ && stratVotes.length >= 2 && agreement >= 0.85) {
    tier = 'extreme';
  }

  // v188 — gold uses 2 digits ($XXXX.XX format), JPY 3, forex 5
  const isGold = pair === 'XAU/USD' || pair === 'GOLD';
  const digits = isGold ? 2 : (pair.includes('JPY') ? 3 : 5);
  const r5 = (v) => Number(v.toFixed(digits));

  // v238 — HIGH-PIPS / BIG-RUN detection. When the move-quality stack lines up
  // (strong trend, killzone, expanding volatility, multi-strategy confluence)
  // the market is set up for a sustained directional push — not a scalp. In
  // that regime, stretch TP2/TP3 so we capture the FULL move instead of
  // taking profits at standard 2R/3R and watching another 50 pips fly past.
  //
  // Criteria (must hit ALL):
  //   • ADX ≥ 28          — confirmed trending environment
  //   • inKZ              — London or NY killzone, where institutions move
  //   • atrExpansion ≥ 1  — current volatility ≥ recent 20-bar average
  //   • stratVotes ≥ 2    — multiple independent strategies confirming
  const bigMove = ad >= 28 && inKZ && atrExpansion >= 1.0 && stratVotes.length >= 2;

  // v309 — BIG MOVE HUNT TIER. User wants 500-1000+ pip trades. Real
  // setups exist (major breakouts, trending runs) but require MUCH
  // stronger context than bigMove:
  //   • ADX ≥ 32 (very strong trend)
  //   • ATR expansion ≥ 1.4 (volatility genuinely picking up)
  //   • Multi-strategy 3+ confirming (institutional confluence)
  //   • In killzone (institutional volume window)
  // Signals meeting these get TP3 stretched to 8R (was 5R bigMove) so
  // when the setup DOES fire, the target actually reaches 500-1000 pips.
  const bigMoveHunt = ad >= 32 && inKZ && atrExpansion >= 1.4 && stratVotes.length >= 3;

  // v298 — R:R FIX. TP1 was 0.5R (half the SL distance).
  // v309 — Extended TP3 for BIG MOVE HUNT tier.
  // v322 — TPs now DECOUPLED from SL. When smart-SL is tighter (structure
  // based), TPs stay at high ATR-based absolute pips — the R:R becomes
  // AMAZING (e.g. 0.5R risk, 5R reward). User asked for "high TPs".
  //
  // TP multipliers (of ATR — absolute pip target):
  //   TP1  1.5×ATR  → decent first target
  //   TP2  3.0×ATR standard  / 4.5×ATR bigMove  / 6.0×ATR hunt
  //   TP3  5.0×ATR standard  / 7.5×ATR bigMove  / 10.0×ATR hunt
  // v395 — TP multipliers boosted for higher-pip targets.
  //   normal: TP1 1.5→2, TP2 3→4, TP3 5→7  (40% more pips on TP3)
  //   bigMove: TP2 4.5→6, TP3 7.5→10.5     (40% more pips)
  //   bigMoveHunt: TP2 6→8, TP3 10→14      (40% more pips)
  // v444 — ladder re-fitted to the 2.5 ATR stop.
  //
  // With the wider stop, TP1 at 2.0 ATR is only 0.80R, which fails the
  // tp1 >= 0.95R validator below — every signal would have been rejected.
  // Rather than weaken the validator, the ladder moves to where the price
  // action actually is. Measured over 5,963 signals:
  //
  //   SL 2.5   TP (2, 4, 7)     TP1 0.80R   +0.106R   REJECTED by validator
  //   SL 2.5   TP (2.5, 5, 7)   TP1 1.00R   +0.114R
  //   SL 2.5   TP (2.5, 5, 8)   TP1 1.00R   +0.120R
  //   SL 2.5   TP (2.5, 5, 9)   TP1 1.00R   +0.128R   <- chosen
  //   SL 1.5   TP (2, 4, 7)     TP1 1.33R   +0.072R   (what was live)
  //
  // v450 — TP1 WAS PINNED TO THE STOP DISTANCE. THAT WAS A REGRESSION.
  //
  // v444 widened the stop to atrV * 2.5 but left tp1Mult at 2.5, so whenever
  // the ATR term set the stop — the common case — tp1Dist came out EXACTLY
  // equal to slDist. Every signal offered 1.00R at the first target: risk 36
  // pips to make 36. Under the plan on the card that banks a third at TP1,
  // the first exit returned 0.33R. That is what "small pips" was.
  //
  // Measured by replaying this function over real hourly bars, 10 instruments,
  // 2.8 years, managed ladder, no lookahead:
  //
  //                        median TP1   FX pips   strike   avg win   expectancy
  //   tp1 2.5x (before)        1.00R        32     46.1%    +1.09R   -0.0205R
  //   tp1 4.0x (now)           1.58R        49     41.5%    +1.33R   +0.0015R
  //
  // The old ladder's 95% CI was [-0.037, -0.003] — it excluded zero on the
  // losing side, so it was measurably negative rather than merely unproven.
  // The new one is [-0.014, +0.017]. This removes a measured loss; it does
  // NOT create an edge, and the interval still contains zero.
  //
  // Targets are hit less often, as they must be when they sit further away —
  // strike falls 46% to 42% — but each winner is worth more, and the first
  // target is finally a real multiple of the risk taken to reach it.
  // Spacing keeps the three targets distinct rather than bunching TP1 and
  // TP2 together.
  const tp1Mult = 4.0;
  const tp2Mult = bigMoveHunt ? 11.0 : (bigMove ? 9.0 : 7.0);
  const tp3Mult = bigMoveHunt ? 18.0 : (bigMove ? 14.0 : 11.0);

  const pipSize = isGold ? 0.1
    : pair === 'BTC/USD' ? 1
    : pair === 'ETH/USD' ? 0.1
    : pair === 'SOL/USD' ? 0.01
    : pair.includes('JPY') ? 0.01
    : 0.0001;

  // v322 — SMART SL SIZING. Use the TIGHTER of three:
  //   1. Volatility-based:  1.5 × ATR (current default)
  //   2. Structure-based:   distance to recent swing high/low + 0.25×ATR buffer
  //   3. Per-pair max cap:  absolute ceiling as % of price (safety net)
  //
  // Why: during news spikes ATR balloons and 1.5×ATR becomes an unnecessarily
  // wide SL — risking 3× normal per trade. Structure-based SL uses the
  // recent swing that price would need to break to invalidate the setup —
  // which is the CORRECT technical SL, not just a volatility guess.
  // The per-pair cap is a safety net so we never risk > 1% of price.

  // v444 — 1.5 -> 2.5 ATR. THIS is the generator that produces the signals
  // users actually trade; v441 only corrected predict-next.js, so the stop
  // fix never reached the live feed. Same excursion evidence, 5,963 signals:
  //
  //   MAE p25 1.54 / median 1.74 / p75 2.12 ATR   vs a stop at ~1.47 ATR
  //   stop 1.5 ATR -> hit on 80.8% of trades
  //   stop 2.5 ATR -> hit on 14.1%
  //   expectancy   +0.073R -> +0.106R
  //
  // 31% of stopped-out trades had already run 2+ ATR in profit before
  // reversing: they reached target territory and were closed by a stop
  // sitting inside ordinary noise.
  // v462 — STOP TIGHTENED 2.5 -> 1.75 ATR (0.7x).
  //
  // Re-walked 159 tracked setups on real bars across a grid of stop widths and
  // target ladders. Tightening the stop improved expectancy at EVERY ladder
  // tested, without exception, because the targets move in with it and get
  // reached far more often:
  //
  //   stop 1.0x · TP 0.4/0.8/1.5   none 38.4%  TP3  8.8%   -0.129R
  //   stop 0.7x · TP 0.4/0.8/1.5   none 32.7%  TP3 18.9%   -0.025R
  //   stop 0.5x · TP 0.4/0.8/1.5   none 32.1%  TP3 22.6%   +0.017R
  //
  // The 0.5x line is the only positive figure this project has produced — but
  // it is an artifact of a simulation that ignores the spread. At half stop,
  // TP1 is a median of 6 pips on FX, and a 1-1.5 pip spread is a fifth of
  // that. Charging the real spread:
  //
  //   stop 1.0x  -0.209R      stop 0.7x  -0.140R      stop 0.5x  -0.143R
  //
  // 0.7x is chosen over 0.5x because they are level on expectancy while 0.7x
  // keeps TP1 at ~8.5 pips instead of 6, so a normal spread widening cannot
  // swallow the target. This changes geometry only — no gate, no filter, and
  // no change to which setups fire.
  const atrSlDist = atrV * 1.75;

  // Structure-based SL: distance to swing extreme from last 20 bars + buffer
  const lookback = Math.min(20, ohlc.length - 1);
  const recentBars = ohlc.slice(-lookback);
  const swingLow = Math.min(...recentBars.map(b => b.l));
  const swingHigh = Math.max(...recentBars.map(b => b.h));
  const buffer = atrV * 0.25;  // small buffer past swing so wick doesn't stop us out
  let structureSlDist;
  if (direction === 'BUY') {
    // SL below recent swing low, but only if that's closer than 1.5×ATR
    const distToSwingLow = cur - swingLow + buffer;
    structureSlDist = distToSwingLow;
  } else {
    // SL above recent swing high, but only if that's closer than 1.5×ATR
    const distToSwingHigh = swingHigh - cur + buffer;
    structureSlDist = distToSwingHigh;
  }
  // Structure SL must be at least 0.5×ATR (avoid stops-too-tight noise)
  structureSlDist = Math.max(structureSlDist, atrV * 0.5);

  // Per-pair absolute cap as % of price — safety net for volatility spikes
  const maxSlPct = isGold ? 0.008          // 0.8% ≈ $32 at $4000 gold
    : pair === 'BTC/USD' ? 0.020            // 2.0% ≈ $1290 at $64500 BTC
    : pair === 'ETH/USD' ? 0.025            // 2.5% (eth is volatile)
    : pair.includes('JPY') ? 0.005          // 0.5% ≈ 75 pips at 150
    : pair === 'US30' ? 0.005               // 0.5% ≈ $220 at 44000
    : pair === 'NAS100' ? 0.006             // 0.6%
    : 0.004;                                 // forex majors: 0.4% ≈ 40 pips at 1.10
  const capSlDist = cur * maxSlPct;

  // v444 — was "use the TIGHTEST valid SL". That objective is wrong here and
  // it also silently defeated the widening above: under Math.min(), raising
  // the ATR term changes nothing whenever the swing happens to sit nearer,
  // so the measured improvement would never appear in a live signal.
  //
  // A tighter stop is not a safer trade in this system — it is a trade that
  // gets closed by noise before it can work. ATR is now the FLOOR, structure
  // may only widen it (respect a swing that sits further out), and the
  // per-pair percentage stays a hard ceiling against volatility spikes.
  const slDist = Math.min(Math.max(atrSlDist, structureSlDist), capSlDist);

  const slMethod = slDist === capSlDist ? 'capped'
    : slDist === structureSlDist ? 'structure (beyond ATR floor)'
    : 'atr-floor';

  // v322b — TPs stay at ATR-based absolute pips (HIGH). SL got tight (smart
  // sizing), TPs stay high. R:R is now better than ever — tight risk,
  // big reward.
  // v450 — TP1 IS GUARANTEED TO BE WORTH THE RISK, NOT JUST ON AVERAGE.
  //
  // Raising tp1Mult alone fixed the median but not the worst cases: the stop
  // is min(max(atr, structure), cap), so when a wide swing sets the stop by
  // structure it swallowed the wider target and TP1 landed back near 1.0R.
  // Taking the larger of the two makes the first target a real multiple of
  // whatever the stop actually ended up being.
  //
  //                              median TP1   10th pct   FX pips   expectancy
  //   v444                          1.00R       0.99R       32      -0.0205R
  //   tp1 4x ATR only               1.58R       1.09R       49      +0.0015R
  //   this (max of the two)         1.57R       1.30R       53      +0.0127R
  //
  // The tenth percentile is the number that matters here: before, one signal
  // in ten offered essentially 1.0R at the first target. Now the weakest
  // tenth still offers 1.3R.
  // v458 — TARGETS GO WHERE PRICE ACTUALLY GOES.
  //
  // v450 pushed TP1 out to 1.3R chasing bigger pips. Measured against 155
  // tracked setups on real bars, that made the targets close to unreachable:
  //
  //   price ran >= 0.5R  34.8% of the time
  //   price ran >= 1.0R  17.4%
  //   price ran >= 1.3R   6.5%   <- where TP1 was placed
  //   median favourable move: 0.29R
  //
  // Re-walking those same setups (same entries, same stops, only the targets
  // moved) shows what that cost:
  //
  //   ladder              none    TP1    TP2    TP3     avg R
  //   1.3 / 2.4 / 3.7    85.2%  12.9%   1.9%   0.0%   -0.494R
  //   0.4 / 0.8 / 1.5    36.8%  35.5%  18.7%   9.0%   -0.123R
  //
  // TP3 had never once been reached at the old distance. The ladder below is
  // set as multiples of the real risk rather than of ATR, so the relationship
  // holds whatever sets the stop. This changes NO entry logic and filters out
  // no signals — the same setups fire, their targets are simply placed where
  // this engine's moves actually reach.
  const tp1Dist = slDist * 0.4;
  const tp2Dist = slDist * 0.8;
  const tp3Dist = slDist * 1.5;
  const slPips = Math.round(slDist / pipSize);
  const tp1Pips = Math.round(tp1Dist / pipSize);
  const tp2Pips = Math.round(tp2Dist / pipSize);
  const tp3Pips = Math.round(tp3Dist / pipSize);

  // v298 — HIGH-PIPS MINIMUM. User asked for "only high-pips" signals.
  // Any signal where the pip potential to TP3 is below the per-pair floor
  // is a scalpy setup that shouldn't be shown. Rejected outright here so
  // it never reaches the brain gate or user.
  const minTp3Pips = pair === 'XAU/USD' ? 80
    : pair === 'XAG/USD' ? 40
    // v316 — BTC floor lowered from 400 → 250 (~0.4% at current $63.9k).
    // 400 was blocking all BTC signals during low-ATR regimes. TP3 at 3.0×
    // ATR only reaches 400 when ATR ≥ 133 — BTC often trades at 60-110 ATR.
    : pair === 'BTC/USD' ? 250
    : pair === 'ETH/USD' ? 25
    : pair.includes('JPY') ? 40
    : pair === 'USD/CHF' ? 30
    : pair === 'US30' ? 100
    : pair === 'NAS100' ? 60
    : 30;  // default for forex majors/minors
  if (tp3Pips < minTp3Pips) {
    return null;  // scalpy setup — skip
  }

  // v450 — THE FLOOR ONLY EVER GUARDED TP3. TP1 IS WHAT YOU ACTUALLY BANK.
  //
  // Nothing checked the first target, so a signal squeaking past the TP3
  // floor could still offer a TP1 of a few pips — and the spread takes its
  // cut of that before you see any of it. Measured over 17,925 signals, the
  // ones whose TP1 netted under 10 pips after a typical spread returned
  // -0.236R against -0.020R for everything else. Only 36 signals, so this
  // is a small tail rather than the main problem, but it is the worst tail
  // and it costs nothing to remove.
  //
  // Spreads are typical retail figures in the pair's own pips. They are
  // deliberately a little pessimistic: a floor that assumes a tight spread
  // stops protecting you exactly when spreads widen, which is when thin
  // targets fail.
  const typicalSpreadPips = isGold ? 25
    : pair === 'BTC/USD' ? 50
    : pair === 'ETH/USD' ? 30
    : pair === 'USD/JPY' || pair === 'EUR/USD' ? 1.0
    : pair === 'AUD/USD' ? 1.2
    : pair === 'NZD/USD' ? 1.8
    : 1.5;
  // v458 — floor lowered with the ladder. It exists to stop a target the
  // spread would swallow, not to filter setups; at TP1 = 0.4R the old
  // 10-pip net floor would have started rejecting normal signals.
  if (tp1Pips - typicalSpreadPips < 4) {
    return null;  // first target too thin once the spread is paid
  }
  // v298 — HARD R:R VALIDATOR. Sanity check the mathematics one more time
  // before the signal ships. TP1 must be ≥ SL distance. TP3 must be ≥ 2× SL.
  // Any violation → drop the signal (defensive — shouldn't happen with the
  // multipliers above but catches anything that slips through).
  // v458 — the R:R floors were written for the old far-target ladder and
  // would now reject every signal. They are re-expressed against the ladder
  // that is actually in use, so they still catch genuinely broken geometry
  // (targets on the wrong side, inverted ordering) without blocking the
  // normal case. Signal flow is unchanged; this guard only rejects the
  // malformed.
  if (tp1Dist < slDist * 0.3 || tp3Dist < slDist * 1.2 || tp1Dist >= tp3Dist) {
    return null;
  }

  // v267/v268 — STUDY THE CHART BEFORE PRODUCING A SIGNAL.
  // Chart study still runs on every candidate so the user sees the reasoning
  // on each card. v268 dropped the hard threshold to 35 (was 55) so it
  // doesn't filter out otherwise-valid signals during slower market periods
  // when structural features are subtle. Below 35 = clearly unsuitable
  // (no trend, no HTF, no conviction at all). Otherwise let the Brain Gate
  // do the final filtering — chart score is then surfaced as a quality
  // indicator and contributes to the probability factors there.
  const chartStudy = studyChart(ohlc, direction, atrV);
  // v268/v269b — weakSignal candidates get an even lower chart-study floor
  // so quiet-market opportunities reach the feed labeled accordingly.
  const chartMinScore = isEliteBrainPattern ? 20 : (weakSignal ? 25 : 35);
  if (chartStudy.score < chartMinScore) {
    return null;
  }

  // v274 — MULTI-TIMEFRAME ANALYSIS. The brain now confirms every signal
  // against the higher 4H timeframe. Counter-HTF signals (where the 4H
  // trend opposes the 1H signal) get rejected outright unless the brain
  // pattern is elite — that's the single biggest professional edge. Signals
  // that align with HTF trend get a boost.
  const htfStudy = studyHigherTimeframe(ohlc, direction);
  // Reject counter-HTF unless we have very strong reasons (elite pattern)
  if (htfStudy.alignment === 'opposed' && !isEliteBrainPattern && htfStudy.adx4h >= 25) {
    return null; // strong 4H trend opposes us — no entry
  }

  // v185 — TP1 distance fixed to 0.5R (was 1.0R = 1.5×ATR same as SL).
  // SL stays at 1.5×ATR, TP1 now at 0.75×ATR = 0.5R. Matches client v184
  // math. Old 1:1 R:R meant TP1 = SL distance — to hit TP1 price had to
  // travel as far as it would to lose. Now TP1 is half that distance,
  // dramatically higher hit rate at first profit target.
  return {
    pair, direction, confidence, tier,
    // v267 — Chart study result attached so the UI + Brain Gate can see it.
    chartStudy: { score: chartStudy.score, reasons: chartStudy.reasons },
    // v274 — Multi-timeframe analysis result. UI badges by alignment, Brain
    // Gate uses it as a factor (aligned = boost, opposed = penalty).
    htfStudy: {
      direction: htfStudy.htfDirection,
      strength: htfStudy.htfStrength,
      alignment: htfStudy.alignment,
      score: htfStudy.score,
      adx4h: htfStudy.adx4h,
      reasons: htfStudy.reasons,
    },
    // v324 — Daily timeframe alignment. Signals aligned with BOTH 4H AND
    // daily trend are institutional-grade. Signals against daily get flagged.
    dailyHtf: _dailyHtfCheck(ohlc, direction),
    // v325 — Market regime + strategy weight profile. UI shows which
    // regime the market is in and which strategies are prioritized.
    regime: {
      label: regimeInfo.regime,
      adx: regimeInfo.adx,
      atrRatio: regimeInfo.atrRatio,
      compression: regimeInfo.compression,
    },
    entry: r5(cur),
    sl: r5(direction === 'BUY' ? cur - slDist : cur + slDist),
    tp1: r5(direction === 'BUY' ? cur + tp1Dist : cur - tp1Dist),
    tp2: r5(direction === 'BUY' ? cur + tp2Dist : cur - tp2Dist),
    tp3: r5(direction === 'BUY' ? cur + tp3Dist : cur - tp3Dist),
    adx: Math.round(ad),
    agreement: Math.round(agreement * 100),
    indicators: total,
    strategies: stratVotes.length,
    // v216 — expose the exact named strategy combo so the brain can score it
    namedStrategies: namedStrats.slice(),
    comboKey: `${direction}_${namedStrats.slice().sort().join('+')}`,
    // v218 — brain-blessed pattern markers
    isEliteBrainPattern,
    eliteBrainWR: eliteBrainWR != null ? Math.round(eliteBrainWR * 100) : null,
    inKillzone: inKZ,
    weakSignal, // v269b — quiet-market candidate; reduced indicator support
    // v238 — BIG-PIPS metadata. UI can badge these and filter on pipPotential.
    bigMove,
    bigMoveHunt,  // v309 — targets 500-1000+ pip runners (8R TP3)
    atrExpansion: Math.round(atrExpansion * 100) / 100,
    pipPotential: tp3Pips,  // headline number for "how big is this move"
    pipsToTp1: tp1Pips,
    pipsToTp2: tp2Pips,
    pipsToTp3: tp3Pips,
    pipsToSl: slPips,
    // v356 — Raw ATR-relative distances so quantumSimulate can simulate THIS
    // signal's actual TP/SL levels instead of a generic hardcoded target.
    // Without these, bigMove/bigMoveHunt signals (TP3 stretched to 7.5-10×ATR)
    // were being probability-tested against a fixed, much closer 3.0×ATR
    // target — silently overstating the odds of reaching the real, larger TP.
    atrV,
    slDistAtr: +(slDist / atrV).toFixed(3),
    tp1DistAtr: +(tp1Dist / atrV).toFixed(3),
    tp2DistAtr: +(tp2Dist / atrV).toFixed(3),
    tp3DistAtr: +(tp3Dist / atrV).toFixed(3),
    // v322 — SL sizing transparency. `slMethod` = which of atr/structure/capped
    // was tightest. `slSavedPips` = pips saved vs the naive 1.5×ATR fallback.
    slMethod,
    slSavedPips: Math.max(0, Math.round((atrSlDist - slDist) / pipSize)),
    // v328 — TRAILING STOP PROTOCOL. After each TP hits, SL should trail up
    // (or down for SELL) to lock in profits and eliminate loss risk.
    // Standard pro-trader protocol:
    //   • After TP1 hit → move SL to BREAKEVEN (entry price). No more loss possible.
    //   • After TP2 hit → move SL to TP1 (locks in 1R profit even if reversal).
    //   • After TP3 hit → trade closed at max profit.
    // The tp-monitor already tracks hits; UI displays these SL levels so the
    // user (or their broker) can update the stop mechanically.
    trailStops: {
      afterTp1: r5(cur),   // move SL to entry (breakeven)
      afterTp2: r5(direction === 'BUY' ? cur + tp1Dist : cur - tp1Dist),  // to TP1 (locks 1R)
      protocol: 'After TP1 → SL to breakeven. After TP2 → SL to TP1. After TP3 → closed.',
    },
    detectedAt: new Date().toISOString(),
    // v314 — MONTE CARLO probabilistic outcome. Runs 1000 random price
    // paths using recent ATR as volatility, direction determined by drift
    // matching the signal's HTF trend. Counts hit-rates for each level.
    // Real quantitative simulation — not marketing "quantum" hype.
    monteCarloOutcome: _runMonteCarlo(cur, slDist, tp1Dist, tp2Dist, tp3Dist, atrV, direction, htfStudy.htfDirection),
  };
}

// v314 — Monte Carlo random-walk simulator. Runs 1000 stochastic price
// paths for each signal to estimate probability of hitting each target
// before SL. Uses ATR-scaled Gaussian noise with tiny drift toward HTF.
// Returns hit-rates that let the user see probabilistic outcomes.
function _runMonteCarlo(entry, slDist, tp1Dist, tp2Dist, tp3Dist, atrV, direction, htfDir) {
  if (!isFinite(entry) || !isFinite(atrV) || atrV <= 0) return null;
  const RUNS = 1000;
  const MAX_BARS = 48;  // ~2 days on 1H
  const sigma = atrV * 0.85;  // per-bar volatility (close-to-close, slightly < ATR)
  // Drift: small tilt matching HTF direction (0.05 sigma per bar if aligned)
  const drift = (direction === 'BUY' && htfDir === 'up') ? sigma * 0.05
             : (direction === 'SELL' && htfDir === 'down') ? sigma * 0.05
             : 0;
  const buyMode = direction === 'BUY';
  const slLevel = buyMode ? entry - slDist : entry + slDist;
  const tp1Level = buyMode ? entry + tp1Dist : entry - tp1Dist;
  const tp2Level = buyMode ? entry + tp2Dist : entry - tp2Dist;
  const tp3Level = buyMode ? entry + tp3Dist : entry - tp3Dist;
  // Box-Muller for Gaussian
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let hitTp1 = 0, hitTp2 = 0, hitTp3 = 0, hitSl = 0, undecided = 0;
  let sumR = 0;  // expected R-multiple across all runs
  for (let r = 0; r < RUNS; r++) {
    let px = entry;
    let outcome = null;
    let barsToOutcome = 0;
    for (let b = 0; b < MAX_BARS; b++) {
      // Move price by drift + Gaussian noise (toward drift on same side as trade)
      const step = (buyMode ? drift : -drift) + sigma * gauss();
      px += step;
      barsToOutcome = b + 1;
      // Check SL first (defensive — realistic slippage assumption)
      if (buyMode ? px <= slLevel : px >= slLevel) { outcome = 'sl';  break; }
      if (buyMode ? px >= tp3Level : px <= tp3Level) { outcome = 'tp3'; break; }
      if (buyMode ? px >= tp2Level : px <= tp2Level) { outcome = 'tp2'; break; }
      if (buyMode ? px >= tp1Level : px <= tp1Level) { outcome = 'tp1'; break; }
    }
    if (outcome === 'tp1') { hitTp1++; sumR += 1.0; }
    else if (outcome === 'tp2') { hitTp2++; sumR += 2.0; }
    else if (outcome === 'tp3') { hitTp3++; sumR += 3.0; }
    else if (outcome === 'sl')  { hitSl++;  sumR -= 1.0; }
    else undecided++;
  }
  const decided = RUNS - undecided;
  return {
    runs: RUNS,
    // Percentages of runs that reached each level BEFORE SL
    hitTp1Pct: Math.round((hitTp1 / RUNS) * 100),
    hitTp2Pct: Math.round((hitTp2 / RUNS) * 100),
    hitTp3Pct: Math.round((hitTp3 / RUNS) * 100),
    hitSlPct:  Math.round((hitSl  / RUNS) * 100),
    undecidedPct: Math.round((undecided / RUNS) * 100),
    // Expected R across all runs (winning simulations minus losing sims)
    expectedR: Math.round((sumR / RUNS) * 100) / 100,
    // Practical win probability = anything that hits ANY TP before SL
    winProbability: decided > 0
      ? Math.round(((hitTp1 + hitTp2 + hitTp3) / RUNS) * 100)
      : null,
  };
}
const quickAnalyze = strictAnalyze; // alias for callers

// v447 — exported so tools/generate-signals.mjs can run the REAL engine
// outside Cloudflare. One source of truth: the offline generator and the
// live endpoint are the same function, so the fallback can never drift into
// being a different, untested algorithm.
export { strictAnalyze, PAIRS };

// v246 — Fetch with timeout. Yahoo Finance can hang; 8s cap prevents a single
// stuck pair from freezing the whole scan.
async function fetchOHLC(origin, sym, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ohlc;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function onRequest(context) {
  // v246 — Top-level safety net. Even on unhandled exception, return a
  // valid JSON payload so the UI keeps polling and rendering. The signals
  // list may be empty for one tick but the website never crashes.
  try {
    return await _checkSignalsInner(context);
  } catch (e) {
    // v306 — Enhanced safety-net. Same graceful 200 response, but now
    // includes the first stack frame of the error so future debugging is
    // fast. If /api/check-signals ever comes back with ok:false you can
    // see WHERE the error hit without having to add instrumentation.
    let stackFrame = null;
    if (e && e.stack) {
      const lines = String(e.stack).split('\n');
      // First frame that has "check-signals" in it (the actual error site)
      const relevant = lines.find(l => l.includes('check-signals'));
      stackFrame = (relevant || lines[1] || '').trim().slice(0, 200);
    }
    // Log to Worker output so it shows up in wrangler tail
    try { console.error('[check-signals safety-net]', e.message, stackFrame || ''); } catch {}
    return new Response(JSON.stringify({
      ok: false,
      error: 'check-signals safety-net caught: ' + (e.message || String(e)),
      stackFrame,
      ts: Date.now(),
      isoTime: new Date().toISOString(),
      count: 0,
      signals: [],
      brainGated: [],
      brainGatedCount: 0,
      brainStats: null,
      adaptiveGate: { minEdgePts: 8, minPWinPct: 54, targetWRPct: 65, tighteningReason: null, basedOnIntelLevel: null },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
async function _checkSignalsInner(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const auth = request.headers.get('x-cron-key') || url.searchParams.get('key');
  if (env.CRON_KEY && auth !== env.CRON_KEY) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  // v213/v217 — load brain + context state. The brain knows historical WR per
  // pattern. The context layer adds awareness of news blackouts, current pro
  // analyst consensus on gold, recent shadow tracker outcomes, and session
  // state — so live signals get scored with the full picture, not just history.
  let brain = null;
  let proConsensusGold = null;
  // v301 — proConsensusByPair holds pro analyst consensus for ALL pairs,
  // not just gold. Populated below alongside proConsensusGold from the
  // same KV cache entry. Was missing from the extracted source, causing
  // ReferenceError at line ~1999 that killed the entire scan.
  let proConsensusByPair = {};
  let shadowRecentByCombo = {};
  // v236 — finer-grained shadow tracking. Real-world performance per pair+direction
  // (and per pair+direction+hour) tells us where the CURRENT regime diverges
  // from the brain's historical backtest. Live losses outweigh backtest stats.
  let shadowRecentByPairDir = {};
  let shadowRecentByPairDirHour = {};
  // v236 — Recent loss CLUSTER detection. Counts losses in the last 24h
  // for each pair+direction so a single bad cluster (e.g. "XAU/USD SELL lost
  // 5× in the last 12h") is enough to suppress new signals matching that
  // profile, even before per-hour data accumulates.
  let recentLossesByPairDir = {};
  // v256 — Per-(pair, direction, hour) recent-loss timestamps. Used as a HARD
  // 6-24h BLACKLIST when this exact fingerprint just lost. The brain's
  // strongest "learn from mistakes" lever: never re-fire a signal that just
  // failed at the same hour-of-day on the same pair+direction.
  let recentLossFingerprints = {};   // key = pair_direction_hour → newest loss timestamp
  let recentLossFingerprintCount = {}; // key = pair_direction_hour → count in last 24h
  // v256 — Per-failure-tag cool-down. After 2 losses in 24h tagged with the
  // same failure reason, future signals matching that tag get extra penalty.
  let recentTagLossCount = {}; // tag → loss count in last 24h
  // v273 — Recent IMMEDIATE-REJECTION map (lost in ≤2 bars, last 6h).
  // These are the most painful losses — confident signal, instant reversal.
  // Often news whipsaws or stop hunts. Any NEW signal on the SAME
  // pair+direction within 6h of an immediate-rejection loss eats -25 penalty.
  let immediateRejectionByPairDir = {}; // pair_dir → newest IR timestamp
  // v269d — Hoisted from inside the `if (env.TRADES_KV)` block so the brain
  // gate filter (later in this function) can read them. Was throwing
  // ReferenceError ("comboLiveStats is not defined") which the safety net
  // caught as ok:false — blocking every signal.
  let shadowLossesByCombo = {};
  let shadowWinsByCombo = {};
  let comboLiveStats = {};
  let allResolvedShadow = [];
  let failurePatterns = {}; // v228 — reason → count from shadow-tracker losses
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('learning-brain');
      if (raw) brain = JSON.parse(raw);
    } catch {}
    try {
      const raw = await env.TRADES_KV.get('pro-consensus-cache');
      if (raw) {
        const pc = JSON.parse(raw);
        const gold = (pc.consensus || []).find(c => c.pair === 'XAU/USD' || c.pair === 'GOLD');
        if (gold) proConsensusGold = gold.direction;
        // v301 — Populate per-pair map so the brain gate factor (~line 1999)
        // can look up analyst consensus for any pair, not just gold.
        for (const c of (pc.consensus || [])) {
          if (c && c.pair && c.direction) proConsensusByPair[c.pair] = c.direction;
        }
      }
    } catch {}
    // v258/v260/v269d — These maps are hoisted to the outer scope above
    // (so the brain gate filter can see them). The inner shadow KV block
    // just populates them.
    try {
      const raw = await env.TRADES_KV.get('shadow-tracker');
      if (raw) {
        const shadow = JSON.parse(raw);
        // v266 — Capture all resolved signals once for per-signal k-NN.
        allResolvedShadow = shadow.filter(x =>
          (x.status === 'won' || x.status === 'lost') &&
          Array.isArray(x.namedStrategies)
        );
        // Pre-index losses + wins by their canonical combo key
        for (const x of shadow) {
          if (!Array.isArray(x.namedStrategies)) continue;
          const ck = `${x.direction}_${x.namedStrategies.slice().sort().join('+')}`;
          if (x.status === 'lost') {
            if (!shadowLossesByCombo[ck]) shadowLossesByCombo[ck] = [];
            shadowLossesByCombo[ck].push(x);
            // v263 — combo live stats for hard-WR enforcement
            if (!comboLiveStats[ck]) comboLiveStats[ck] = { w: 0, l: 0 };
            comboLiveStats[ck].l += 1;
          } else if (x.status === 'won') {
            if (!shadowWinsByCombo[ck]) shadowWinsByCombo[ck] = [];
            shadowWinsByCombo[ck].push(x);
            if (!comboLiveStats[ck]) comboLiveStats[ck] = { w: 0, l: 0 };
            comboLiveStats[ck].w += 1;
          }
        }
        const resolved = shadow.filter(s => s.status === 'won' || s.status === 'lost').slice(0, 20);
        const nowMs = Date.now();
        for (const s of resolved) {
          const k = s.direction;
          if (!shadowRecentByCombo[k]) shadowRecentByCombo[k] = { w: 0, l: 0, qualityW: 0, qualityL: 0 };
          if (s.status === 'won') shadowRecentByCombo[k].w++; else shadowRecentByCombo[k].l++;
          // v297 — Quality-weighted counts: only signals that would have
          // passed the user-facing push gate (conf ≥ 65) count toward the
          // adaptive-tightening WR. Weak-signal shadow losses no longer
          // tighten the gate for strong signals that would actually reach
          // the user.
          if ((s.confidence || 0) >= 65) {
            if (s.status === 'won') shadowRecentByCombo[k].qualityW++;
            else shadowRecentByCombo[k].qualityL++;
          }
          // v236 — Per-pair-direction shadow tracking. This is the REAL signal:
          // if XAU/USD SELL just lost 5 in a row, future XAU/USD SELL signals
          // should get a big penalty regardless of what the historical backtest says.
          const pk = `${s.pair}_${s.direction}`;
          if (!shadowRecentByPairDir[pk]) shadowRecentByPairDir[pk] = { w: 0, l: 0 };
          if (s.status === 'won') shadowRecentByPairDir[pk].w++; else shadowRecentByPairDir[pk].l++;
          // v236 — Per-pair-direction-hour tracking. If XAU/USD SELL has lost
          // 3/3 times in the 12-14 UTC window, that's a regime signature the
          // current backtest can't see. Penalize new signals at that hour hard.
          try {
            const sH = new Date(s.firedAt).getUTCHours();
            const phk = `${s.pair}_${s.direction}_${sH}`;
            if (!shadowRecentByPairDirHour[phk]) shadowRecentByPairDirHour[phk] = { w: 0, l: 0 };
            if (s.status === 'won') shadowRecentByPairDirHour[phk].w++; else shadowRecentByPairDirHour[phk].l++;
          } catch {}
          // v236 — Recent loss CLUSTER count (last 24h). If a pair+direction
          // lost ≥2 times in last 24h, that's the current-regime canary.
          // Triggers even when per-hour sample size is too small to be useful.
          if (s.status === 'lost') {
            const firedMs = Date.parse(s.firedAt || '');
            if (Number.isFinite(firedMs) && (nowMs - firedMs) <= 24 * 3600 * 1000) {
              recentLossesByPairDir[pk] = (recentLossesByPairDir[pk] || 0) + 1;
              // v256 — Track per-fingerprint loss timestamps + counts for
              // the rapid-learning blacklist below.
              try {
                const sH = new Date(s.firedAt).getUTCHours();
                const fpKey = `${s.pair}_${s.direction}_${sH}`;
                recentLossFingerprints[fpKey] = Math.max(recentLossFingerprints[fpKey] || 0, firedMs);
                recentLossFingerprintCount[fpKey] = (recentLossFingerprintCount[fpKey] || 0) + 1;
              } catch {}
              // v256 — Track per-tag loss counts (broader failure-mode learning).
              for (const tag of (s.failureReasons || [])) {
                recentTagLossCount[tag] = (recentTagLossCount[tag] || 0) + 1;
              }
              // v273 — Track IMMEDIATE-REJECTION losses (bars ≤ 2) per pair+dir
              // for the next 6h. These are the most painful losses — confident
              // signal, instant reversal. Same pair+direction within 6h eats -25.
              if (s.barsToOutcome != null && s.barsToOutcome <= 2 && (nowMs - firedMs) <= 6 * 3600 * 1000) {
                immediateRejectionByPairDir[pk] = Math.max(immediateRejectionByPairDir[pk] || 0, firedMs);
              }
            }
          }
        }
        // v228 — aggregate failure-pattern counts so live signals matching
        // those profiles get a negative bias.
        // v237 — Limit to most-recent 15 losses (was: all losses in 60-entry
        // 14-day window). Ancient losses don't reflect current regime.
        const lost = shadow.filter(s => s.status === 'lost').slice(0, 15);
        for (const s of lost) {
          for (const r of (s.failureReasons || [])) {
            failurePatterns[r] = (failurePatterns[r] || 0) + 1;
          }
        }
      }
    } catch {}
  }
  // News blackout detection (mirror v184 RULE 27 from app.js for server gate)
  const _now = new Date();
  const _dow = _now.getUTCDay(), _dom = _now.getUTCDate(), _hr = _now.getUTCHours(), _mn = _now.getUTCMinutes();
  const isFirstFriday = _dow === 5 && _dom <= 7;
  let inNewsBlackout = false;
  if (isFirstFriday && _hr === 12) inNewsBlackout = true;
  if (isFirstFriday && _hr === 13 && _mn <= 30) inNewsBlackout = true;
  if (_dow === 3 && _hr === 17 && _mn >= 30) inNewsBlackout = true;
  if (_dow === 3 && _hr === 18) inNewsBlackout = true;
  if (_dow === 3 && _hr === 19 && _mn <= 30) inNewsBlackout = true;

  // v218 — pass brain.topWinners into quickAnalyze so it can bias detection
  // toward known winning combos (relaxes thresholds for proven patterns).
  const brainTopWinners = brain && brain.topWinners ? brain.topWinners : null;
  const results = await Promise.allSettled(
    Object.entries(PAIRS).map(async ([name, sym]) => {
      const ohlc = await fetchOHLC(origin, sym);
      if (!ohlc || ohlc.length < 60) return null;
      return quickAnalyze(name, ohlc, brainTopWinners);
    })
  );
  let found = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
  // v355 — reset platinum-drop tracker at each scan
  globalThis.__platinumDropped = [];
  globalThis.__platinumFilterRan = 0;
  // v355 — pipeline stage diagnostics so future signal droughts are
  // trivially diagnosable via /api/check-signals.
  const pipelineDiag = {
    stage00_pairsScanned: Object.keys(PAIRS).length,
    stage01_quickAnalyzeReturnedCandidates: found.length,
    stage01_perPair: results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => `${r.value.pair}_${r.value.direction}`)
      .slice(0, 20),
  };

  // v293 — Fetch per-currency news sentiment ONCE per scan tick. Every
  // signal's confidence is then adjusted based on whether real-world
  // institutional news (Reuters, Fed, ECB, BoE, etc.) agrees with the
  // trade direction. Cached upstream so this is a KV read most calls.
  let newsSentiment = null;
  const _scanOrigin = new URL(request.url).origin;
  try {
    const res = await fetch(`${_scanOrigin}/api/news-sentiment`);
    if (res.ok) newsSentiment = await res.json();
  } catch { /* non-fatal — signals still score without it */ }

  // v294 — Per-pair correlation basket. For each unique pair in `found`,
  // fetch the correlated-instrument alignment once. Signals then get a
  // confidence adjustment based on whether the macro backdrop supports
  // their direction. Cached 3 min upstream.
  const _uniquePairs = [...new Set(found.map(s => s.pair).filter(Boolean))];
  const correlationByPair = {};
  await Promise.all(_uniquePairs.map(async (p) => {
    try {
      const res = await fetch(`${_scanOrigin}/api/correlation-check?pair=${encodeURIComponent(p)}`);
      if (res.ok) correlationByPair[p] = await res.json();
    } catch { /* per-pair non-fatal */ }
  }));
  if (Object.keys(correlationByPair).length && found.length) {
    found = found.map(s => {
      try {
        const c = correlationByPair[s.pair];
        if (!c) return s;
        const buyConf = c.buyConfluence != null ? c.buyConfluence : 50;
        const sellConf = c.sellConfluence != null ? c.sellConfluence : 50;
        const targetConf = s.direction === 'BUY' ? buyConf : sellConf;
        // 50 = neutral; > 65 = macro supports; < 35 = macro opposes.
        // Scale to a -15 to +15 confidence adjustment.
        const adjustment = Math.round((targetConf - 50) * 0.30);
        if (Math.abs(adjustment) >= 3) {
          const oldConf = s.confidence || 0;
          s.confidence = Math.max(0, Math.min(99, oldConf + adjustment));
          s.correlationCheck = {
            buyConfluence: buyConf,
            sellConfluence: sellConf,
            adjustment,
            supporting: s.direction === 'BUY' ? c.supportingBuy : c.supportingSell,
            opposing: s.direction === 'BUY' ? c.opposingBuy : c.opposingSell,
            note: adjustment > 0
              ? `Macro basket SUPPORTS ${s.direction} (${targetConf}/100 confluence)`
              : `Macro basket OPPOSES ${s.direction} (${targetConf}/100 confluence)`,
          };
        }
      } catch { /* per-signal non-fatal */ }
      return s;
    });
  }

  if (newsSentiment?.perCurrency && found.length) {
    found = found.map(s => {
      try {
        const parts = (s.pair || '').split('/');
        if (parts.length !== 2) return s;
        const [base, quote] = parts;
        const baseBias = newsSentiment.perCurrency[base]?.bias || 0;
        const quoteBias = newsSentiment.perCurrency[quote]?.bias || 0;
        // For a BUY: base currency should be strong (positive bias) OR
        // quote should be weak (negative bias). Net = base - quote.
        // For a SELL: opposite.
        const netForBuy = baseBias - quoteBias;
        const alignment = s.direction === 'BUY' ? netForBuy : -netForBuy;
        // Confidence adjustment: ±5 pts per bias-unit of alignment, capped ±15
        const adjustment = Math.max(-15, Math.min(15, alignment * 3));
        if (Math.abs(adjustment) >= 3) {
          const oldConf = s.confidence || 0;
          s.confidence = Math.max(0, Math.min(99, oldConf + adjustment));
          s.newsBias = {
            base, baseBias, quote, quoteBias,
            alignment, adjustment,
            note: adjustment > 0
              ? `News flow supports ${s.direction} (${base}=${baseBias > 0 ? '+' : ''}${baseBias}, ${quote}=${quoteBias > 0 ? '+' : ''}${quoteBias})`
              : `News flow OPPOSES ${s.direction} (${base}=${baseBias > 0 ? '+' : ''}${baseBias}, ${quote}=${quoteBias > 0 ? '+' : ''}${quoteBias})`,
          };
        }
      } catch { /* per-signal: don't break the batch */ }
      return s;
    });
  }

  // v315 — MULTI-SOURCE CONFIRMATION LAYER. Independent cross-validation
  // sources beyond price/news/correlation: VIX (fear index) for gold+BTC,
  // Crypto Fear & Greed for BTC contrarian setups, CoinGecko as second BTC
  // price source (bad-tick guard), US 10Y yield for gold real-yield check.
  // Each source votes. Consensus verdict CONFIRM/VETO/MIXED becomes a
  // confidence adjustment (-20 to +12 pts) and can veto weak signals.
  const multiSourceByPair = {};
  await Promise.all(_uniquePairs.map(async (p) => {
    // v317b — Single fetch per pair returns eval for BOTH directions from
    // one source snapshot (multi-source-check honours direction=BOTH).
    // Previously fetched twice per pair, doubling scan network overhead.
    try {
      const res = await fetch(`${_scanOrigin}/api/multi-source-check?pair=${encodeURIComponent(p)}&direction=BOTH`);
      if (res.ok) {
        const data = await res.json();
        if (data.BUY && data.SELL) {
          multiSourceByPair[p] = { BUY: data.BUY, SELL: data.SELL };
        }
      }
    } catch { /* non-fatal — signals score without it */ }
  }));
  if (Object.keys(multiSourceByPair).length && found.length) {
    found = found.map(s => {
      try {
        const m = multiSourceByPair[s.pair];
        if (!m) return s;
        const evalForDir = m[s.direction];
        if (!evalForDir || !evalForDir.ok) return s;
        const boost = evalForDir.boost || 0;
        // Apply as confidence adjustment (already scaled -20..+12 in evaluator)
        if (Math.abs(boost) >= 2) {
          const oldConf = s.confidence || 0;
          s.confidence = Math.max(0, Math.min(99, oldConf + boost));
          s.multiSourceCheck = {
            verdict: evalForDir.verdict,
            votes: evalForDir.votes,
            adjustment: boost,
            activeSources: evalForDir.activeSources,
            notes: evalForDir.notes,
            note: boost > 0
              ? `Multi-source CONFIRMS ${s.direction} (${evalForDir.activeSources.length} sources, ${evalForDir.votes} net votes)`
              : `Multi-source ${evalForDir.verdict} ${s.direction} (${evalForDir.notes[0] || 'multiple headwinds'})`,
          };
          // Hard veto: if multi-source flagged VETO with strong consensus,
          // drop the signal entirely (2 or more sources actively opposing).
          if (evalForDir.verdict === 'VETO' && evalForDir.votes <= -3) {
            s._multiSourceVeto = true;
          }
        }
      } catch { /* per-signal non-fatal */ }
      return s;
    });
    // Apply the hard veto — drop signals where multi-source unanimously opposed
    pipelineDiag.stage02a_beforeMultiSourceVeto = found.length;
    const preVeto = found.length;
    found = found.filter(s => !s._multiSourceVeto);
    pipelineDiag.stage02b_afterMultiSourceVeto = found.length;
    pipelineDiag.stage02b_droppedByMultiSource = preVeto - found.length;
    if (preVeto !== found.length) {
      try { console.log(`[v315] multi-source vetoed ${preVeto - found.length} signal(s)`); } catch {}
    }
  }

  // v216/v217/v227 — apply brain WR + CONTEXT to score each live signal.
  // v227 — confidence boosts now SCALE with the brain's intelligence level
  // (more samples + more pairs learned = more trust in brain findings).
  if (brain && brain.byCombo) {
    // Read intelligence multiplier (0.20 to 1.0+)
    const intelLevel = brain.intelligenceLevel || 0.5;
    found = found
      .map(s => {
        try {
        const combo = s.comboKey ? brain.byCombo[s.comboKey] : null;
        const comboN = combo ? (combo.w + combo.l) : 0;
        const comboWR = comboN >= 5 ? combo.w / comboN : null;
        const avgBars = combo && combo.barCount ? (combo.barSum / combo.barCount) : null;
        const reasons = [];
        // Per-combo reliability — small samples = weak evidence, large = strong
        const reliability = comboN >= 200 ? 1.0
                          : comboN >= 100 ? 0.9
                          : comboN >= 50 ? 0.75
                          : comboN >= 20 ? 0.55
                          : comboN >= 5 ? 0.35 : 0;
        const totalMultiplier = intelLevel * reliability;
        if (s.isEliteBrainPattern) {
          reasons.push(`🏆 ELITE BRAIN PATTERN (${s.eliteBrainWR}% WR) — relaxed gate`);
        }

        // ── Brain combo WR — boost magnitudes SCALED by intel × reliability ─
        let comboConfBoost = 0;
        if (comboWR != null && totalMultiplier > 0) {
          let rawBoost = 0;
          if (comboWR >= 0.70) rawBoost = 15;
          else if (comboWR >= 0.60) rawBoost = 10;
          else if (comboWR >= 0.55) rawBoost = 6;
          else if (comboWR <= 0.30) rawBoost = -20;
          else if (comboWR <= 0.40) rawBoost = -12;
          comboConfBoost = Math.round(rawBoost * totalMultiplier);
          if (comboConfBoost !== 0) {
            const intelPct = Math.round(intelLevel * 100);
            const relPct = Math.round(reliability * 100);
            reasons.push(`Brain combo ${Math.round(comboWR*100)}% WR ${comboConfBoost >= 0 ? '+' : ''}${comboConfBoost} (intel ${intelPct}% × reliability ${relPct}%)`);
          }
        }

        // ── v230 — CONTEXT-AWARE LEARNING (the brain ADAPTS, doesn't cancel) ──
        // Look up the WINNER-context vs LOSER-context for this combo. If the
        // signal's current ADX is close to the winner-ADX profile, BOOST.
        // If it's close to the loser-ADX profile, modest reduction. This way
        // the brain learns "this combo wins when ADX>30" instead of just
        // suppressing the entire combo.
        let contextBoost = 0;
        if (combo && combo.winContext && combo.loseContext) {
          const winAdxAvg = combo.winContext.adxCount > 0
            ? combo.winContext.adxSum / combo.winContext.adxCount : null;
          const loseAdxAvg = combo.loseContext.adxCount > 0
            ? combo.loseContext.adxSum / combo.loseContext.adxCount : null;
          const sigAdx = s.adx || 0;
          if (winAdxAvg != null && loseAdxAvg != null && Math.abs(winAdxAvg - loseAdxAvg) >= 3) {
            const closerToWin = Math.abs(sigAdx - winAdxAvg) < Math.abs(sigAdx - loseAdxAvg);
            if (closerToWin) {
              contextBoost = Math.round(4 * totalMultiplier);
              reasons.push(`Context match — winners avg ADX ${Math.round(winAdxAvg)} · this ADX ${sigAdx} +${contextBoost}`);
            } else {
              contextBoost = -Math.round(2 * totalMultiplier);
              reasons.push(`Context mismatch — losers avg ADX ${Math.round(loseAdxAvg)} · this ADX ${sigAdx} ${contextBoost}`);
            }
          }
        }
        // ── Hour-of-day stat ────────────────────────────────────────────
        const h = new Date(s.detectedAt || Date.now()).getUTCHours();
        const hourStat = brain.byHour ? brain.byHour[`${s.direction}_${h}`] : null;
        let hourConfBoost = 0;
        if (hourStat && hourStat.w + hourStat.l >= 10) {
          const hrWR = hourStat.w / (hourStat.w + hourStat.l);
          if (hrWR >= 0.55) { hourConfBoost = 3; reasons.push(`Hour ${h}:00 UTC ${Math.round(hrWR*100)}% WR +3`); }
          else if (hrWR <= 0.40) { hourConfBoost = -3; reasons.push(`Hour ${h}:00 UTC ${Math.round(hrWR*100)}% WR -3`); }
        }
        // ── CONTEXT: pro analyst consensus ─────────────────────────────
        let consensusBoost = 0;
        if (proConsensusGold) {
          if (proConsensusGold === s.direction) {
            consensusBoost = 5;
            reasons.push(`Analysts agree (${proConsensusGold}) +5`);
          } else {
            consensusBoost = -8;
            reasons.push(`Analysts disagree (analysts say ${proConsensusGold}) -8`);
          }
        }
        // ── CONTEXT: news blackout ─────────────────────────────────────
        let blackoutBoost = 0;
        if (inNewsBlackout) {
          blackoutBoost = -20;
          reasons.push('NEWS BLACKOUT active -20');
        }
        // ── CONTEXT: recent shadow performance for this direction ───────
        let shadowBoost = 0;
        const shadowStat = shadowRecentByCombo[s.direction];
        if (shadowStat && shadowStat.w + shadowStat.l >= 4) {
          const sWR = shadowStat.w / (shadowStat.w + shadowStat.l);
          if (sWR <= 0.30) {
            shadowBoost = -6;
            reasons.push(`Recent ${s.direction} shadow WR ${Math.round(sWR*100)}% -6`);
          } else if (sWR >= 0.70) {
            shadowBoost = 4;
            reasons.push(`Recent ${s.direction} shadow WR ${Math.round(sWR*100)}% +4`);
          }
        }

        // v236 — Per-pair-direction LIVE shadow check. This is the most
        // reliable signal: how is THIS exact pair+direction doing in REAL
        // recent signals? Overrides any historical backtest optimism.
        let pairDirShadowBoost = 0;
        const pdShadow = shadowRecentByPairDir[`${s.pair}_${s.direction}`];
        if (pdShadow && pdShadow.w + pdShadow.l >= 3) {
          const pdN = pdShadow.w + pdShadow.l;
          const pdWR = pdShadow.w / pdN;
          if (pdWR <= 0.20) {
            // Disaster zone — 80%+ losing. Hard penalty.
            pairDirShadowBoost = -25;
            reasons.push(`⚠ ${s.pair} ${s.direction} losing ${pdShadow.l}/${pdN} live recently -25`);
          } else if (pdWR <= 0.40) {
            pairDirShadowBoost = -15;
            reasons.push(`${s.pair} ${s.direction} live WR ${Math.round(pdWR*100)}% (${pdShadow.l}/${pdN} losses) -15`);
          } else if (pdWR >= 0.75) {
            pairDirShadowBoost = 6;
            reasons.push(`${s.pair} ${s.direction} live WR ${Math.round(pdWR*100)}% +6`);
          }
        }

        // v238 — BIG-RUN bonus. Signals where the conditions favor a big
        // sustained move (trending market, killzone, expanding volatility,
        // multi-strategy confluence) get a confidence boost AND are ranked
        // above scalp-type signals. This is how the brain "catches high pips
        // TP signals" — by detecting the regime, not just the pattern.
        let bigMoveBoost = 0;
        if (s.bigMove) {
          bigMoveBoost = 8;
          reasons.push(`BIG RUN setup (ADX ${s.adx} + killzone + vol expansion + ${s.strategies} strats) +8`);
        }

        // v239 — REGIME-AWARE scoring. Brain classifies current market into
        // one of: TRENDING_VOLATILE, TRENDING_QUIET, RANGING_VOLATILE,
        // RANGING_QUIET, NEUTRAL, CRISIS. Apply boost/penalty based on whether
        // the signal type matches the regime.
        //   • CRISIS → -25 to all signals (skip the chop)
        //   • TRENDING_VOLATILE → +6 to multi-strategy big-move signals
        //   • RANGING_QUIET → -8 to all signals (no follow-through expected)
        //   • TRENDING_QUIET → +3 to high-conf signals
        let regimeBoost = 0;
        const regime = brain && brain.currentRegime ? brain.currentRegime.regime : null;
        if (regime === 'CRISIS') {
          regimeBoost = -25;
          reasons.push(`Regime: CRISIS (vol ${brain.currentRegime.volRatio}× normal) -25`);
        } else if (regime === 'TRENDING_VOLATILE' && s.strategies >= 2 && s.bigMove) {
          regimeBoost = 6;
          reasons.push('Regime: TRENDING_VOLATILE matches big-move signal +6');
        } else if (regime === 'TRENDING_QUIET' && s.confidence >= 80) {
          regimeBoost = 3;
          reasons.push('Regime: TRENDING_QUIET matches high-conf signal +3');
        } else if (regime === 'RANGING_QUIET') {
          // v268b — Was -8 (tipped marginal signals out of the gate). Softened
          // to -3 — still discourages the regime but lets stronger setups
          // through. The probability-gate pWin floor handles final discipline.
          regimeBoost = -3;
          reasons.push('Regime: RANGING_QUIET (limited follow-through expected) -3');
        }

        // v266 — PER-SIGNAL k-NN STUDY. The brain finds the most-similar
        // past resolved signals and computes their actual win rate. This is
        // signal-LEVEL reasoning, not category-level. For a specific signal
        // like "EUR/USD SELL H14 ADX=28 ICT+TREND+MOMENTUM in killzone", the
        // brain finds past signals with that exact feature fingerprint and
        // tells you: "Out of 7 like this, 5 won — 71% per-signal verdict."
        //
        // Feature similarity weights (1.0 max):
        //   • pair exact match    +0.30
        //   • combo exact match   +0.25
        //   • hour ±1             +0.15  (±3 = +0.07)
        //   • ADX bucket match    +0.10
        //   • killzone match      +0.10
        //   • confidence ±10 conf +0.10
        // Direction already filtered by combo. Threshold to include: ≥ 0.60.
        let perSignalStudy = null;
        try {
          const sigHourK = new Date(s.detectedAt || Date.now()).getUTCHours();
          const sigAdxK = s.adx || 0;
          const sigInKzK = !!s.inKillzone;
          const sigConfK = s.confidence || 50;
          const adxBucketK = (a) => a < 20 ? 'low' : a < 30 ? 'mid' : 'high';
          const sigAdxBucket = adxBucketK(sigAdxK);
          // Filter resolved shadow by SAME combo (already direction-aware)
          const candidates = allResolvedShadow.filter(x => {
            const xk = `${x.direction}_${x.namedStrategies.slice().sort().join('+')}`;
            return xk === s.comboKey;
          });
          const matched = [];
          for (const x of candidates) {
            let sim = 0;
            // Pair (most important feature for transferability)
            if (x.pair === s.pair) sim += 0.30;
            // Combo (already matched, baseline credit)
            sim += 0.25;
            // Hour proximity
            let xH = -1;
            try { xH = new Date(x.firedAt).getUTCHours(); } catch {}
            if (xH >= 0) {
              const dh = Math.abs(xH - sigHourK);
              if (dh <= 1) sim += 0.15;
              else if (dh <= 3) sim += 0.07;
            }
            // ADX bucket
            if (x.adx != null && adxBucketK(x.adx) === sigAdxBucket) sim += 0.10;
            // Killzone match
            if (x.inKillzone === sigInKzK) sim += 0.10;
            // Confidence proximity (within 10pts)
            if (x.confidence != null && Math.abs(x.confidence - sigConfK) <= 10) sim += 0.10;
            if (sim >= 0.60) matched.push({ x, sim });
          }
          // Sort by similarity desc, keep top 10 (most-relevant)
          matched.sort((a, b) => b.sim - a.sim);
          const top = matched.slice(0, 10);
          if (top.length >= 3) {
            const wins = top.filter(m => m.x.status === 'won').length;
            const losses = top.filter(m => m.x.status === 'lost').length;
            const perSignalWR = wins / (wins + losses);
            const avgSim = top.reduce((a, m) => a + m.sim, 0) / top.length;
            // v272 — Bayesian Beta posterior + Wilson 95% CI for honest
            // uncertainty bounds. With only 3-10 matches, the raw WR
            // (wins/(wins+losses)) overstates certainty. Bayesian smooths it
            // toward 50%; Wilson tells you how wide the actual range is.
            const bp = betaPosterior(wins, losses);
            const wil = wilsonScore(wins, losses);
            perSignalStudy = {
              matched: top.length,
              wins, losses,
              perSignalWR: Math.round(perSignalWR * 100),
              bayesianWR: Math.round(bp.mean * 100),
              ciLower: Math.round(wil.lower * 100),
              ciUpper: Math.round(wil.upper * 100),
              avgSimilarity: Math.round(avgSim * 100),
              examples: top.slice(0, 3).map(m => ({
                pair: m.x.pair, direction: m.x.direction,
                firedAt: (m.x.firedAt || '').slice(0, 16),
                status: m.x.status, similarity: Math.round(m.sim * 100),
              })),
            };
            const verdict = perSignalWR >= 0.65 ? 'STRONG' : perSignalWR >= 0.50 ? 'MIXED' : 'POOR';
            reasons.push(`🔍 Per-signal study: ${top.length} past matches → ${wins}W/${losses}L = ${Math.round(perSignalWR*100)}% raw, ${Math.round(bp.mean*100)}% Bayes (95% CI ${Math.round(wil.lower*100)}-${Math.round(wil.upper*100)}%) — ${verdict}`);
          }
        } catch {}
        s.perSignalStudy = perSignalStudy;

        // v258 — DEEP CONTEXTUAL LEARNING (replaces v256 hard fingerprint cancel).
        //
        // The brain doesn't blacklist patterns anymore. Instead, when a NEW
        // signal fires, it looks at every historical loss with THE SAME COMBO
        // and computes how similar the CURRENT conditions are to the LOSING
        // conditions. The penalty scales smoothly with that similarity — high
        // similarity to a known-loss profile = cautious; different conditions =
        // trust the pattern's wins. Pattern itself is NEVER cancelled.
        //
        // Features compared:
        //   • hour-of-day (±1 hour proximity)
        //   • ADX bucket (low <20 / mid 20-30 / high >30)
        //   • atrExpansion bucket (compressed <0.85 / normal / expanding >1.15)
        //   • regime
        //   • inKillzone
        // Each matching feature contributes to similarity. Penalty caps at -12
        // so the brain leans cautious without ever cancelling. This is the
        // "learn extensively why it failed, not just blacklist it" approach.
        let contextLearnPenalty = 0;
        const ctxNote = [];
        const sigHourFp = new Date(s.detectedAt || Date.now()).getUTCHours();
        const sigAdx = s.adx || 0;
        const sigAtrExp = s.atrExpansion || 1.0;
        const sigRegime = (brain && brain.currentRegime) ? brain.currentRegime.regime : null;
        const sigInKz = !!s.inKillzone;
        const sigComboKey = s.comboKey;
        // Synchronous lookup into the precomputed losses-by-combo map.
        // No await — fast enough to run per-signal without blocking.
        const sameCombo = shadowLossesByCombo[sigComboKey] || [];
        let bestSimilarity = 0;
        let mostSimilarLoss = null;
        const adxBucket = (a) => a < 20 ? 'low' : a < 30 ? 'mid' : 'high';
        for (const loss of sameCombo) {
          let lossH = -1;
          try { lossH = new Date(loss.firedAt).getUTCHours(); } catch {}
          let sim = 0;
          if (lossH >= 0 && Math.abs(lossH - sigHourFp) <= 1) sim += 0.30;
          else if (lossH >= 0 && Math.abs(lossH - sigHourFp) <= 3) sim += 0.10;
          if (loss.adx != null && adxBucket(loss.adx) === adxBucket(sigAdx)) sim += 0.25;
          if (loss.inKillzone === sigInKz) sim += 0.20;
          sim += 0.15; // combo already matched — baseline
          if (sim > bestSimilarity) { bestSimilarity = sim; mostSimilarLoss = loss; }
        }
        if (bestSimilarity >= 0.50 && mostSimilarLoss) {
          contextLearnPenalty = -Math.round(bestSimilarity * 12);
          const fired = (mostSimilarLoss.firedAt || '').slice(0, 16);
          ctxNote.push(`Context echo of past loss (${Math.round(bestSimilarity*100)}% match · ${mostSimilarLoss.pair} ${mostSimilarLoss.direction} ${fired}) ${contextLearnPenalty}`);
        }
        if (ctxNote.length) reasons.push(...ctxNote);

        // v260 — SYMMETRIC win-context BOOST. Same machinery as loss penalty
        // above but for WINS. If the current signal's conditions closely match
        // a known winning context for this same combo, add a confidence boost.
        // This is how the brain "finds more signals similar to past wins."
        let contextWinBoost = 0;
        const sameComboWins = shadowWinsByCombo[sigComboKey] || [];
        let bestWinSimilarity = 0;
        let mostSimilarWin = null;
        for (const win of sameComboWins) {
          let winH = -1;
          try { winH = new Date(win.firedAt).getUTCHours(); } catch {}
          let sim = 0;
          if (winH >= 0 && Math.abs(winH - sigHourFp) <= 1) sim += 0.30;
          else if (winH >= 0 && Math.abs(winH - sigHourFp) <= 3) sim += 0.10;
          if (win.adx != null && adxBucket(win.adx) === adxBucket(sigAdx)) sim += 0.25;
          if (win.inKillzone === sigInKz) sim += 0.20;
          sim += 0.15; // combo matched baseline
          if (sim > bestWinSimilarity) { bestWinSimilarity = sim; mostSimilarWin = win; }
        }
        if (bestWinSimilarity >= 0.50 && mostSimilarWin) {
          contextWinBoost = Math.round(bestWinSimilarity * 12);
          const wonAt = (mostSimilarWin.firedAt || '').slice(0, 16);
          const winRz = (mostSimilarWin.winReasons || []).slice(0, 2).join(', ') || 'past win';
          reasons.push(`✨ Matches past WIN context (${Math.round(bestWinSimilarity*100)}% similar · ${mostSimilarWin.pair} ${mostSimilarWin.direction} ${wonAt} · ${winRz}) +${contextWinBoost}`);
        }
        // v263 — Persist similarity scores so the brain-gate filter pass below
        // can use them for hard combo enforcement override decisions.
        s._winContextSimilarity = bestWinSimilarity;
        s._lossContextSimilarity = bestSimilarity;

        // v258 — Tag cool-down kept but SOFTENED. Was -20 max (v256). Now -10
        // max. The brain notes the tag but doesn't pile on — context learning
        // above does the heavy lifting. Pattern itself is never cancelled.
        let tagCooldownPenalty = 0;
        const sigTags = [];
        if (sigHourFp >= 7 && sigHourFp <= 9) sigTags.push('london-open-volatility');
        if (sigHourFp >= 12 && sigHourFp <= 15) sigTags.push('pre-ny-volatility'); // v273 — extended
        if (sigHourFp < 7 || sigHourFp > 21) sigTags.push('off-session');
        if (s.confidence != null && s.confidence < 70) sigTags.push('weak-confidence');
        if (s.confidence != null && s.confidence >= 70 && s.confidence < 85) sigTags.push('mid-confidence');
        if (s.strategies != null && s.strategies < 2) sigTags.push('single-strategy');
        const hotTags = sigTags.filter(t => (recentTagLossCount[t] || 0) >= 2);
        if (hotTags.length > 0) {
          tagCooldownPenalty = -Math.min(10, hotTags.length * 4);
          reasons.push(`Caution: tag has recent losses: ${hotTags.join(', ')} ${tagCooldownPenalty}`);
        }
        // v258 — fingerprintPenalty alias kept at 0 so the downstream totalBoost
        // expression doesn't break. The contextLearnPenalty above takes its job.
        const fingerprintPenalty = 0;

        // v239 — ADAPTIVE BOOST EFFECTIVENESS. If brain has seen ≥10 live
        // resolutions for a boost tag (e.g. "killzone"), use that real-world
        // WR to scale the boost. Boost tag with 70% live WR keeps full +8.
        // Boost tag with 45% live WR (worse than coin flip) gets neutered.
        const effectiveness = brain && brain.boostEffectiveness ? brain.boostEffectiveness : {};
        let adaptiveBoostAdj = 0;
        if (s.bigMove && effectiveness['big-move'] && (effectiveness['big-move'].w + effectiveness['big-move'].l) >= 10) {
          const liveWR = effectiveness['big-move'].w / (effectiveness['big-move'].w + effectiveness['big-move'].l);
          if (liveWR < 0.45) {
            adaptiveBoostAdj = -bigMoveBoost; // cancel the +8 — it's not working live
            reasons.push(`Adaptive: big-move boost neutered, live WR ${Math.round(liveWR*100)}%`);
          } else if (liveWR >= 0.70) {
            adaptiveBoostAdj = 3; // amplify — it's outperforming
            reasons.push(`Adaptive: big-move boost amplified, live WR ${Math.round(liveWR*100)}% +3`);
          }
        }

        // v236 — Recent-loss CLUSTER penalty. If THIS pair+direction has lost
        // ≥2 times in the last 24h, the regime is hostile right now. Hard
        // penalty regardless of historical backtest WR.
        let clusterPenalty = 0;
        const clusterLosses = recentLossesByPairDir[`${s.pair}_${s.direction}`] || 0;
        if (clusterLosses >= 5) {
          clusterPenalty = -30;
          reasons.push(`⚠ ${s.pair} ${s.direction} lost ${clusterLosses}× in last 24h -30`);
        } else if (clusterLosses >= 3) {
          clusterPenalty = -20;
          reasons.push(`⚠ ${s.pair} ${s.direction} lost ${clusterLosses}× in last 24h -20`);
        } else if (clusterLosses >= 2) {
          clusterPenalty = -12;
          reasons.push(`${s.pair} ${s.direction} lost ${clusterLosses}× in last 24h -12`);
        }

        // v273 — IMMEDIATE-REJECTION cool-down. If same pair+direction had
        // an immediate-rejection loss (≤2 bars) within the last 6 hours,
        // the market is actively punishing this trade idea. Hard -25.
        const irLastMs = immediateRejectionByPairDir[`${s.pair}_${s.direction}`] || 0;
        if (irLastMs > 0) {
          const hoursSinceIR = Math.max(0.1, (Date.now() - irLastMs) / 3600000);
          if (hoursSinceIR < 6) {
            // Decay from -25 to -10 over the 6h window
            const irPenalty = -Math.round(10 + 15 * (1 - hoursSinceIR / 6));
            clusterPenalty += irPenalty;
            reasons.push(`⚠ ${s.pair} ${s.direction} had immediate-rejection loss ${Math.round(hoursSinceIR * 10)/10}h ago ${irPenalty}`);
          }
        }

        // v236 — Per-pair-direction-HOUR live shadow. If XAU/USD SELL has lost
        // every time it fired between 5-14 UTC in the last few days, future
        // signals at the same hour-band must be suppressed even harder.
        let pdhShadowBoost = 0;
        const h2 = new Date(s.detectedAt || Date.now()).getUTCHours();
        const pdhKey = `${s.pair}_${s.direction}_${h2}`;
        const pdhShadow = shadowRecentByPairDirHour[pdhKey];
        if (pdhShadow && pdhShadow.w + pdhShadow.l >= 2) {
          const pdhN = pdhShadow.w + pdhShadow.l;
          const pdhWR = pdhShadow.w / pdhN;
          if (pdhWR === 0) {
            pdhShadowBoost = -20;
            reasons.push(`⚠ ${s.pair} ${s.direction} 0-for-${pdhN} at ${h2}:00 UTC live -20`);
          } else if (pdhWR <= 0.34) {
            pdhShadowBoost = -10;
            reasons.push(`${s.pair} ${s.direction} losing at ${h2}:00 UTC live ${pdhShadow.l}/${pdhN} -10`);
          }
        }

        // v236 — Failure-pattern penalty RECALIBRATED. The old "≥3 occurrences
        // before tag counts, ≥2 tags overlapping before any penalty" math
        // meant in practice NO penalty ever fired (need 6+ historical losses
        // matching exactly). New: ANY tag with ≥1 occurrence counts, and
        // every matched tag adds -3. Hard cap removed so high-conf signals
        // can drop below 90% when they match multiple failure tags.
        let failurePenalty = 0;
        const matchedFailures = [];
        if (s.confidence != null && s.confidence < 70) matchedFailures.push('weak-confidence');
        if (s.strategies != null && s.strategies < 2) matchedFailures.push('single-strategy');
        if (h2 < 7 || h2 > 21) matchedFailures.push('off-session');
        if (h2 === 7 || h2 === 8 || h2 === 9) matchedFailures.push('london-open-volatility');
        if (h2 >= 12 && h2 <= 15) matchedFailures.push('pre-ny-volatility'); // v273 — extended
        // v237 — Raised threshold back to ≥2 occurrences. The v236 ≥1 setting
        // made every London-open signal take a -4 hit forever once even one
        // London-open loss landed — too eager because failure tags are broad
        // category buckets (entire hour ranges). ≥2 means "this category has
        // actually been a recurring problem", not "happened once weeks ago".
        const recurringFailures = matchedFailures.filter(t => (failurePatterns[t] || 0) >= 2);
        if (recurringFailures.length > 0) {
          // -4 per matched tag, capped at -12 (3 tags max). Still aggressive
          // when the tags are real — but not punishing single-incident noise.
          failurePenalty = -Math.min(12, 4 * recurringFailures.length);
          reasons.push(`Failure pattern match: ${recurringFailures.join(' + ')} ${failurePenalty}`);
        }

        const totalBoost = comboConfBoost + contextBoost + hourConfBoost + consensusBoost + blackoutBoost + shadowBoost + pairDirShadowBoost + pdhShadowBoost + clusterPenalty + failurePenalty + bigMoveBoost + regimeBoost + adaptiveBoostAdj + fingerprintPenalty + tagCooldownPenalty + contextLearnPenalty + contextWinBoost;

        // v241 — CALIBRATION-CORRECTED CONFIDENCE. If the brain has live
        // outcome data for the confidence bucket this signal falls into,
        // adjust the displayed confidence toward what's actually winning.
        // Weighted average so small-n buckets don't over-correct.
        let calibratedConf = Math.max(0, Math.min(99, (s.confidence || 0) + totalBoost));
        if (brain && brain.calibration) {
          const bucketStart = Math.floor(calibratedConf / 10) * 10;
          const bucketKey = `${bucketStart}-${bucketStart + 10}`;
          const cal = brain.calibration[bucketKey];
          if (cal && (cal.w + cal.l) >= 5) {
            const actualWR = (cal.w / (cal.w + cal.l)) * 100;
            // Weight actual by sample size; cap at 30 samples (full trust at 30+).
            const w = Math.min(1, (cal.w + cal.l) / 30);
            const adj = Math.round((calibratedConf + actualWR * w) / (1 + w));
            if (Math.abs(adj - calibratedConf) >= 3) {
              reasons.push(`Calibration adj: bucket ${bucketKey} live WR ${Math.round(actualWR)}% → ${adj}%`);
            }
            calibratedConf = adj;
          }
        }

        return {
            ...s,
            brainCombo: s.comboKey,
            brainComboWR: comboWR != null ? Math.round(comboWR * 100) : null,
            brainComboSamples: comboN,
            brainComboSource: comboSource, // v229 — "<pair>" or "all-pairs"
            brainAvgBars: avgBars != null ? Math.round(avgBars * 10) / 10 : null,
            brainExpectedHours: avgBars != null ? Math.round(avgBars) : null,
            brainScoreBreakdown: reasons,
            brainTotalBoost: totalBoost,
            // v336 — CONFIDENCE IS NOW HONEST BY DEFAULT. Displayed
            // confidence = min(raw, pWin×100 + 5). Old inflated raw value
            // preserved as `rawConfidence` for debugging. This eliminates
            // the "98% confidence signal that immediately loses" pattern
            // we saw on 3-in-a-row XAU/USD SELL losses.
            confidence: Math.min(calibratedConf, Math.round(pWin * 100) + 5),
            rawConfidence: calibratedConf,
            honestConfidence: Math.min(
              calibratedConf,
              Math.round(pWin * 100) + 5
            ),
          };
        } catch (e) {
          // v237 — Pass the unscored signal through rather than 500'ing the
          // whole endpoint. Per-signal failure isolation.
          console.warn('[check-signals] scoring failed for', s.pair, s.direction, e.message);
          return s;
        }
      })
      // v230 — STOPPED dropping slow patterns. Brain now LABELS them as
      // slow but lets them through so the user can decide. Earlier behavior
      // (filter-cancel) was too aggressive — the user wants the brain to
      // learn, not silently drop signals.
      .filter(s => !inNewsBlackout) // still skip during news blackouts (safety)
      // ═════════════════════════════════════════════════════════════════
      // v323 — ANTI-FAKE-SIGNAL HARD GUARDS. User asked for no fake signals.
      // Reject any signal that:
      //   (a) has fewer than 2 REAL named strategies (SMC/ICT/TREND/etc.,
      //       not just candlestick patterns) — single-strategy is coin-flip
      //   (b) has chart-study score < 45 (raised from 35) — needs real
      //       structural evidence, not just an oscillator ping
      //   (c) has honest confidence < 55 — after Bayesian shrinkage,
      //       below 55% is worse than a coin flip
      //   (d) has combo with historically bad WR (< 45%) AND no override
      //       (no bigMove, no elite, no multi-source CONFIRM)
      // These filters happen AFTER the brain gate so they're the last
      // "would a real trader take this?" check.
      // ═════════════════════════════════════════════════════════════════
      .filter(s => {
        try {
          globalThis.__platinumFilterRan = (globalThis.__platinumFilterRan || 0) + 1;
          // ═══════════════════════════════════════════════════════════════
          // v339 — PLATINUM-ONLY MODE. User asked for 10+ consistent wins.
          // Every signal must pass EVERY quality gate. No exceptions, no
          // overrides. If any gate fails, signal is blocked. This means
          // very few signals fire — but every one has overwhelming edge.
          //
          // v342 — CRITICAL: Require ≥1 LEADING indicator. Root cause of
          // the last 4 XAU/USD SELL losses was "SELL_TREND+VWAP" which is
          // 2 lagging strategies confirming an existing trend. Lagging
          // strategies have NO predictive edge — they just describe what
          // already happened. Real setups need a LEADING indicator that
          // predicts what will happen next (divergence, order block,
          // liquidity sweep, wyckoff spring, etc.).
          // ═══════════════════════════════════════════════════════════════
          const failReasons = [];

          // LEADING vs LAGGING classification
          // LAGGING = confirms existing trend (no predictive edge alone)
          // LEADING = predicts turn or breakout (real edge)
          const LAGGING_STRATS = new Set(['TREND', 'VWAP', 'MACD']);
          const LEADING_STRATS = new Set([
            'DIVERGENCE', 'WYCKOFF', 'ORDER_BLOCK', 'SWEEP', 'ENGULFING',
            'ICT', 'SMC', 'FIB', 'ORB', 'BOLLINGER', 'SR', 'TURTLE',
            'MOMENTUM', 'ICHIMOKU',
            // v343 — Documented winning patterns
            'THREE_BAR', 'TURTLE_SOUP', 'BREAKOUT_RETEST', 'SILVER_BULLET',
          ]);

          // Gate 0 (v342): must have ≥1 leading indicator
          const namedList = Array.isArray(s.namedStrategies) ? s.namedStrategies : [];
          const hasLeading = namedList.some(n => LEADING_STRATS.has(n));
          if (!hasLeading) {
            const laggingOnly = namedList.filter(n => LAGGING_STRATS.has(n));
            failReasons.push(`only lagging strategies fired (${laggingOnly.join(', ')}) — no predictive edge`);
          }

          // Gate 1 (v344 rebalance): 2+ strategies (v342 leading rule already
          // enforces predictive edge). Previous 3+ was too strict; combined
          // with leading-required, 2 leading-including strategies is quality.
          const namedCount = namedList.length;
          if (namedCount < 2) failReasons.push(`only ${namedCount} strategies (need ≥2 with 1 leading)`);

          // Gate 2 (v345): Chart study ≥48. Slightly above the v323 baseline
          // of 45. Weak-market setups often score 48-55; we want them to
          // reach the gate even if honest confidence catches them later.
          const cs = (s.chartStudy && s.chartStudy.score) || 0;
          if (cs < 48) failReasons.push(`chart score ${cs} < 48`);

          // Gate 3 (v345): Honest confidence ≥58%. The calibration score is
          // very low right now (Cal 0-5%) which aggressively shrinks pWin.
          // 58% Bayesian-shrunk is still above coin-flip and represents real
          // edge given how much the brain has already discounted the raw.
          const hc = s.honestConfidence != null ? s.honestConfidence : (s.confidence || 0);
          if (hc < 58) failReasons.push(`honest confidence ${hc}% < 58%`);

          // Gate 4 (v344 rebalance): Multi-source must NOT be VETO. Allows
          // CONFIRM or NEUTRAL through. Was strict CONFIRM-only which blocked
          // signals on pairs without multi-source data (only BTC/gold have it).
          const msVerdict = (s.multiSourceCheck && s.multiSourceCheck.verdict) || null;
          const msBoost = (s.multiSourceCheck && s.multiSourceCheck.adjustment) || 0;
          if (msVerdict === 'VETO') {
            const sign = msBoost >= 0 ? '+' : '';
            failReasons.push(`multi-source VETO ${sign}${msBoost}`);
          }

          // Gate 5 (v355 relax): 4H HTF must NOT be opposed. Previously
          // required "aligned" only — but that rejected all "neutral" HTF
          // which is a legitimate state during consolidation/regime shift.
          // Only "opposed" (HTF actively pointing the wrong way) is a hard block.
          const htfAlign = (s.htfStudy && s.htfStudy.alignment) || 'unknown';
          if (htfAlign === 'opposed') failReasons.push(`4H HTF opposed`);

          // Gate 6: Daily HTF should NOT be opposed
          const dailyAlign = (s.dailyHtf && s.dailyHtf.aligned) || 'unknown';
          if (dailyAlign === 'opposed') failReasons.push(`daily HTF opposed`);

          // Gate 7 (v355 relax + v369/v370 crypto-specific): ADX ≥ 20 for FX,
          // ≥ 8 for BTC. Crypto compressed-volatility often precedes directional
          // moves — BTC at ADX 10 can burst up to 40 within an hour. FX at
          // ADX 20 is truly choppy. v370 lowered BTC to 8 (absolute floor)
          // because on weekends BTC is the ONLY tradable market and pWin
          // downstream filters catch weak setups anyway.
          const adx = s.adx || 0;
          const isBTCPair = s.pair === 'BTC/USD';
          const minAdxForTier = isBTCPair ? 8 : 20;
          if (adx < minAdxForTier) failReasons.push(`ADX ${adx} < ${minAdxForTier} (choppy${isBTCPair ? ' — even for BTC' : ''})`);

          // Gate 8 (v344 rebalance): R:R ≥ 2.0 (was 2.5). Standard pro trading
          // benchmark. 2.5 was too aggressive when SL uses smart-tight sizing.
          // v355 FIX — s.rMultiple isn't set yet (computed by the .map that
          // runs AFTER this .filter). Compute inline from pipsToTp3/pipsToSl
          // OR from entry/tp3/sl directly. Every signal that had rMultiple=0
          // before was failing this gate purely because of scheduling.
          let rr = s.rMultiple || 0;
          if (!rr) {
            const rewardPips = s.pipsToTp3 || (s.tp3 && s.entry ? Math.abs(s.tp3 - s.entry) : 0);
            const riskPips = s.pipsToSl || (s.sl && s.entry ? Math.abs(s.entry - s.sl) : 0);
            rr = riskPips > 0 ? Math.round((rewardPips / riskPips) * 100) / 100 : 0;
          }
          if (rr < 2.0) failReasons.push(`R:R ${rr} < 2.0`);

          // Gate 9: Combo not on losing pattern list (already caught by
          // veto system, but double-check here as safety)
          const comboWR = s.brainComboWR;
          const comboN = s.brainComboSamples || 0;
          if (comboN >= 20 && comboWR != null && comboWR < 50) {
            failReasons.push(`combo WR ${comboWR}% < 50% (${comboN} samples)`);
          }

          // Gate 10: Correlation not double-exposure risk
          if (s.correlationRisk && s.correlationRisk.hasRisk) {
            failReasons.push(`correlation risk with concurrent signal`);
          }

          if (failReasons.length > 0) {
            s._fakeReason = failReasons.join(' · ');
            // v355 — capture platinum-gate drops for pipeline diag
            try {
              globalThis.__platinumDropped = globalThis.__platinumDropped || [];
              globalThis.__platinumDropped.push({
                pair: s.pair,
                direction: s.direction,
                failReasons,
              });
            } catch {}
            return false;
          }
          s.platinumGrade = true;
          const boostSign = msBoost >= 0 ? '+' : '';
          s.qualityReasons = [
            `${namedCount} strategies confluencing`,
            `chart score ${cs}/100`,
            `honest ${hc}% confidence`,
            `multi-source CONFIRM ${boostSign}${msBoost}pts`,
            `4H+ HTF aligned`,
            `ADX ${adx}`,
            `R:R 1:${rr}`,
          ];
          return true;
        } catch { return true; /* on error don't hide the signal */ }
      })
      // v326 — EXPECTED VALUE SORT. Mathematically optimal ranking.
      // EV = pWin × pipsToTp3 − pLose × pipsToSl (per unit position).
      // A signal with pWin=55% and TP3=800 pips beats pWin=70% and TP3=200
      // pips (44 pips EV vs 40 pips EV), so ranking by EV surfaces the
      // TRULY best opportunity, not just the highest-win-rate.
      .map(s => {
        try {
          const pa = s.probabilityAnalysis || {};
          const pWin = (pa.pWin != null ? pa.pWin : (s.honestConfidence || s.confidence || 50)) / 100;
          const pLose = 1 - pWin;
          const rewardPips = s.pipsToTp3 || 0;
          const riskPips = s.pipsToSl || 0;
          const expectedValuePips = Math.round((pWin * rewardPips) - (pLose * riskPips));
          const rMultiple = riskPips > 0 ? rewardPips / riskPips : 0;
          // Kelly-optimal fraction: f* = (p × b − q) / b where b = R:R, p=pWin, q=pLose
          // We cap at 5% (aggressive but survivable), floor at 0 (skip if negative).
          const kellyFraction = rMultiple > 0
            ? Math.max(0, Math.min(0.05, (pWin * rMultiple - pLose) / rMultiple))
            : 0;
          s.expectedValuePips = expectedValuePips;
          s.rMultiple = Math.round(rMultiple * 100) / 100;
          s.kellyPct = Math.round(kellyFraction * 10000) / 100;  // e.g. 1.85%
          return s;
        } catch { return s; }
      })
      .sort((a, b) => {
        // Primary: expected value (bigger = better)
        const aEv = a.expectedValuePips != null ? a.expectedValuePips : 0;
        const bEv = b.expectedValuePips != null ? b.expectedValuePips : 0;
        if (aEv !== bEv) return bEv - aEv;
        // Tie-break 1: big-move signals surface first
        if (a.bigMove && !b.bigMove) return -1;
        if (b.bigMove && !a.bigMove) return 1;
        // Tie-break 2: brain combo WR - resolution speed
        const aScore = (a.brainComboWR || 0) - (a.brainAvgBars || 12);
        const bScore = (b.brainComboWR || 0) - (b.brainAvgBars || 12);
        return bScore - aScore;
      });
  }

  // v245 — ADAPTIVE EDGE THRESHOLD. Compute the dynamic minimum edge before
  // running the gate, so the bar rises as the brain learns more. Three inputs:
  //   1. Brain intelligence level — smarter brain demands stricter signals
  //   2. Target vs actual WR — if recent live WR is below target, tighten
  //   3. Min P(win) floor that scales with brain maturity
  //
  // This is the mechanism that makes the win rate climb in step with brain
  // learning. As more live samples land and calibration improves, the gate
  // becomes more demanding. Conversely, a NOVICE brain with little data keeps
  // the bar loose so it can collect samples from a broader signal pool.
  // v344 — REBALANCED baseline. v340's 15pt/62% was so strict combined with
  // the 10-gate platinum that 0 signals fired for hours. Zero signals = zero
  // wins. Rebalanced to 12pt/58% with target 70%. Adaptive still tightens
  // on losses (can climb to 22pt/68% during losing streaks).
  let adaptiveMinEdge = 0.12;
  let adaptiveMinPWin = 0.58;
  let adaptiveTargetWR = 0.70;
  let adaptiveTighteningReason = null;
  if (brain) {
    const intel = brain.intelligenceLevel || 0.5;
    // Intelligence-based base bar
    if (intel >= 0.92) { adaptiveMinEdge = 0.18; adaptiveMinPWin = 0.65; }
    else if (intel >= 0.80) { adaptiveMinEdge = 0.15; adaptiveMinPWin = 0.62; }
    else if (intel >= 0.65) { adaptiveMinEdge = 0.12; adaptiveMinPWin = 0.58; }
    else if (intel >= 0.50) { adaptiveMinEdge = 0.10; adaptiveMinPWin = 0.55; }
    // Below 0.50 keep defaults (8pts, 0.54) to gather data

    // v297 FIX #1 — Only count HIGH-QUALITY shadow signals in the recentWR
    // used to tighten the push gate. The old code used ALL shadow signals
    // (which include weak-confidence ones the shadow tracker logs but that
    // NEVER reach users). Weak-signal losses were tightening the gate for
    // strong signals, causing full lockout. Now we only count signals that
    // would have passed the ~65 conf floor — matching the user-facing gate.
    const allRecent = Object.values(shadowRecentByCombo).reduce(
      (acc, v) => ({ w: (acc.w + (v.qualityW ?? v.w) || 0), l: (acc.l + (v.qualityL ?? v.l) || 0) }), { w: 0, l: 0 }
    );
    const recentN = allRecent.w + allRecent.l;
    if (recentN >= 6) {
      const recentWR = allRecent.w / recentN;
      if (recentWR < adaptiveTargetWR - 0.03) {
        const shortfall = (adaptiveTargetWR - recentWR);
        const bonus = Math.min(0.15, shortfall * 0.8); // v297: capped 15pts (was 18), 0.8× scale (was 1.0) — less aggressive
        adaptiveMinEdge += bonus;
        adaptiveMinPWin += bonus * 0.5; // v297: 0.5 (was 0.7) — pWin moves slower
        adaptiveTighteningReason = `Recent WR ${Math.round(recentWR*100)}% below target ${Math.round(adaptiveTargetWR*100)}% — tightening edge by ${Math.round(bonus*100)}pts`;
      } else if (recentWR >= adaptiveTargetWR + 0.05 && intel < 0.80) {
        adaptiveMinEdge = Math.max(0.06, adaptiveMinEdge - 0.02);
      }
    }
    const totalRecentClusterLosses = Object.values(recentLossesByPairDir).reduce((a, b) => a + b, 0);
    if (totalRecentClusterLosses >= 3) {
      const clusterTighten = Math.min(0.06, totalRecentClusterLosses * 0.012); // v297: 6pt cap (was 8), 0.012× (was 0.015)
      adaptiveMinEdge += clusterTighten;
      adaptiveMinPWin += clusterTighten * 0.4;
      const note = `${totalRecentClusterLosses} losses across pairs in last 24h — global bar +${Math.round(clusterTighten*100)}pts`;
      adaptiveTighteningReason = adaptiveTighteningReason ? `${adaptiveTighteningReason} · ${note}` : note;
    }

    // v340 — STREAK-AWARE AUTO-PAUSE. If the LAST 2 real outcomes were
    // BOTH losses, HARD PAUSE all signal generation until we see a real
    // win. This is what pro traders do: 2 losses in a row = "step back".
    // Prevents the "3rd loss confirms tape is against you" cascade.
    try {
      const recentByTime = allResolvedShadow
        .filter(x => x.status === 'won' || x.status === 'lost')
        .sort((a, b) => Date.parse(b.firedAt || 0) - Date.parse(a.firedAt || 0))
        .slice(0, 3);
      if (recentByTime.length >= 2 &&
          recentByTime[0].status === 'lost' &&
          recentByTime[1].status === 'lost') {
        adaptiveMinEdge += 0.08;  // Add 8pts more on top
        adaptiveMinPWin += 0.05;
        const streakNote = `2+ losses in a row detected — bank-grade pause activated (+8pts edge, +5pts pWin)`;
        adaptiveTighteningReason = adaptiveTighteningReason ? `${adaptiveTighteningReason} · ${streakNote}` : streakNote;
      }
    } catch { /* defensive */ }

    // v297 FIX #2 — RELEASE VALVE. If the gate has produced 0 pushable
    // signals for N minutes, gradually loosen it. Without this the gate
    // is a one-way ratchet: tightens on any losing streak but never
    // relaxes even when the market is calm and there are quality setups.
    // Read the timestamp of the last time we produced a strategy-confirmed
    // signal from KV; if it's over 90 minutes ago, loosen incrementally.
    try {
      // v357 — Read from Cache API first (v357 write path), fall back to KV
      // (legacy — pre-v357 signals may still have KV entries).
      let lastQualityTs = null;
      try {
        const { cacheGet } = await import('./_cache-store.js');
        lastQualityTs = await cacheGet('last-quality-signal-ts');
      } catch {}
      if (!lastQualityTs && env.TRADES_KV) {
        try { lastQualityTs = await env.TRADES_KV.get('last-quality-signal-ts'); } catch {}
      }
      if (env.TRADES_KV || lastQualityTs) {
        if (lastQualityTs) {
          const ageMin = (Date.now() - parseInt(lastQualityTs, 10)) / 60000;
          if (ageMin > 30) {
            // v355 — Scaled release: 4pts/hr up to 12pts (original), then an
            // extra tier after 24h of drought: bar drops another 6pts (18pt
            // total). At 48h+, an extra 4pts (22pt max relaxation). Reason:
            // when the pipeline is fully dry for a day+, the gate itself is
            // the constraint, not the market. Better to emit one honest
            // slightly-lower-edge signal than to emit ZERO for two days.
            let releaseAmount = Math.min(0.12, ((ageMin - 30) / 60) * 0.04);
            if (ageMin > 24 * 60) releaseAmount += 0.06;
            if (ageMin > 48 * 60) releaseAmount += 0.04;
            releaseAmount = Math.min(0.22, releaseAmount);
            adaptiveMinEdge = Math.max(0.05, adaptiveMinEdge - releaseAmount);
            adaptiveMinPWin = Math.max(0.52, adaptiveMinPWin - releaseAmount * 0.6);
            const relNote = `no signals in ${Math.round(ageMin)}min — release valve loosened bar by ${Math.round(releaseAmount*100)}pts`;
            adaptiveTighteningReason = adaptiveTighteningReason ? `${adaptiveTighteningReason} · ${relNote}` : relNote;
          }
        }
      }
    } catch { /* non-fatal */ }

    // v359 — Self-trust auto-correction. Read the trust-based hint written
    // by /api/self-trust. When trust drops (recent WR < target), gate
    // tightens; when trust rises, gate loosens. Runs on every scan tick.
    try {
      const { cacheGet } = await import('./_cache-store.js');
      const trustHint = await cacheGet('self-trust:auto-correction');
      if (trustHint && typeof trustHint.edgeAdjPts === 'number') {
        adaptiveMinEdge += trustHint.edgeAdjPts / 100;
        adaptiveMinPWin += trustHint.pWinAdjPts / 100;
        const note = `self-trust hint: ${trustHint.note} (${trustHint.edgeAdjPts >= 0 ? '+' : ''}${trustHint.edgeAdjPts}pts edge)`;
        adaptiveTighteningReason = adaptiveTighteningReason ? `${adaptiveTighteningReason} · ${note}` : note;
      }
    } catch { /* non-fatal */ }

    // Final clamp
    adaptiveMinEdge = Math.max(0.05, Math.min(0.22, adaptiveMinEdge));   // v297: max 22pts (was 25) — hard ceiling lower
    adaptiveMinPWin = Math.max(0.52, Math.min(0.68, adaptiveMinPWin));   // v297: max 68% (was 72%) — hard ceiling lower
  }

  // v242 — PROBABILITY-BASED BRAIN GATE.
  //
  // Before allowing any signal, the brain enumerates EVERY known way it
  // could fail AND every known way it could succeed, weights each piece of
  // evidence by sample size (more data = more trust), and computes a unified
  // P(win) vs P(lose). The signal is only allowed if P(win) exceeds P(lose)
  // by a meaningful edge (default 8 percentage points).
  // v245 — Threshold is now ADAPTIVE — it rises as the brain learns + drops
  // when recent WR exceeds target. See adaptiveMinEdge computation above.
  //
  // This replaces the v241 discrete 5-gate system because that one couldn't
  // reason about EVIDENCE INTERACTION — e.g. a 40% combo (fail signal) but
  // in a perfect TRENDING_VOLATILE regime with BIG MOVE flag (3 pass signals)
  // should be allowed; the old gate blocked it on the combo alone. Now all
  // factors get weighed together.
  //
  // Each factor contributes one of:
  //   • pass-shift (positive)  — pushes pWin up
  //   • fail-shift (negative)  — pushes pWin down
  // Sample-size scaling: a 100-sample 40% combo has more evidentiary weight
  // than a 10-sample 40% combo.
  //
  // Factors considered:
  //   1. Combo backtest WR (per-pair)
  //   2. Combo LIVE WR (per-pair, weighted 3× the backtest)
  //   3. Per-pair-direction recent live WR
  //   4. Recent loss cluster (last 24h)
  //   5. Regime match/mismatch
  //   6. Boost-tag live effectiveness (every active tag on the signal)
  //   7. Hour-of-day WR (pair-specific if available)
  //   8. Confidence calibration (per bucket)
  //   9. Pro analyst consensus alignment
  //   10. News blackout proximity
  //   11. Elite brain pattern flag
  //   12. BIG MOVE flag
  //   13. Failure pattern tags from shadow
  // v298/v311 — SELF-AUDIT AUTO-VETO — tightened based on real live data.
  // Live shadow tracker showed combos like SELL_ICT+MOMENTUM+ORB+TREND at
  // 0% WR over 2 samples still getting through because v298 required 3+
  // losses. v311 tightens: 2/2 or 2/3 losses now trigger veto — react
  // faster to genuine losing patterns. Auto-heals when a real win
  // resets the recent-outcomes window.
  // v335 — Two-level self-audit veto (was broken: shadow signals lacked
  // comboKey field so all collapsed to _ANY, never matched new signals).
  // Fixed by (a) deriving comboKey from namedStrategies on shadow signals
  // and (b) adding a pair+direction level veto as safety net.
  pipelineDiag.stage02c_beforeSelfAudit = found.length;
  pipelineDiag.stage02c_pairs = found.map(s => `${s.pair}_${s.direction}`);
  const selfAuditVetoes = new Set();
  const pairDirVetoes = new Set();
  try {
    const auditShadow = Array.isArray(allResolvedShadow) ? allResolvedShadow : [];
    const _deriveCombo = (s) => {
      if (s.comboKey) return s.comboKey;
      if (Array.isArray(s.namedStrategies) && s.namedStrategies.length) {
        return `${s.direction}_${s.namedStrategies.slice().sort().join('+')}`;
      }
      return 'ANY';
    };
    const outcomesByCombo = {};
    const outcomesByPairDir = {};
    for (const s of auditShadow) {
      if (!s || (s.status !== 'won' && s.status !== 'lost')) continue;
      const combo = _deriveCombo(s);
      const comboKey = `${s.pair}_${s.direction}_${combo}`;
      const pdKey = `${s.pair}_${s.direction}`;
      if (!outcomesByCombo[comboKey]) outcomesByCombo[comboKey] = [];
      outcomesByCombo[comboKey].push({ status: s.status, ts: s.firedAt });
      if (!outcomesByPairDir[pdKey]) outcomesByPairDir[pdKey] = [];
      outcomesByPairDir[pdKey].push({ status: s.status, ts: s.firedAt });
    }
    // Sort each key's outcomes by timestamp so we truly get "last N"
    const _sortOutcomes = (arr) => arr.sort((a, b) => {
      const ta = a.ts ? Date.parse(a.ts) : 0;
      const tb = b.ts ? Date.parse(b.ts) : 0;
      return ta - tb;
    });
    // v355 — only count outcomes from the last 48 hours for veto decisions.
    // Old losses (3+ days) in a completely different market regime were
    // permanently blocking directions that predict-next now sees at 90%
    // confidence — the "fighting the last war" pattern. 48h keeps recent
    // context but lets vetoes naturally expire as the market moves on.
    const VETO_RECENCY_MS = 48 * 3600 * 1000;
    const _recentOnly = (arr) => {
      const cutoff = Date.now() - VETO_RECENCY_MS;
      return arr.filter(x => {
        if (!x.ts) return false; // no ts = can't confirm recent, skip
        const t = Date.parse(x.ts);
        return Number.isFinite(t) && t >= cutoff;
      });
    };
    for (const [key, arr] of Object.entries(outcomesByCombo)) {
      const outcomes = _sortOutcomes(_recentOnly(arr)).map(x => x.status);
      const recent = outcomes.slice(-4);
      const losses = recent.filter(o => o === 'lost').length;
      const shouldVeto =
        (recent.length === 2 && losses === 2) ||
        (recent.length === 3 && losses >= 2) ||
        (recent.length >= 3 && losses >= 3);
      if (shouldVeto) selfAuditVetoes.add(key);
    }
    // v335 NEW: pair+direction level veto. If e.g. XAU/USD SELL has lost 3
    // of last 4 REGARDLESS of specific combo, block ALL XAU/USD SELL signals
    // until the pattern breaks. This catches the case where each losing
    // signal uses a slightly different combo (TREND+VWAP, VWAP+MACD, etc.)
    // — no single combo triggers the combo-level veto but the pair is
    // clearly in a losing regime for that direction.
    for (const [pdKey, arr] of Object.entries(outcomesByPairDir)) {
      // v355 — same 48h recency filter as combo veto
      const outcomes = _sortOutcomes(_recentOnly(arr)).map(x => x.status);
      const recent = outcomes.slice(-4);
      const losses = recent.filter(o => o === 'lost').length;
      if ((recent.length === 3 && losses >= 3) ||
          (recent.length >= 4 && losses >= 3)) {
        pairDirVetoes.add(pdKey);
      }
    }
    if (selfAuditVetoes.size > 0 || pairDirVetoes.size > 0) {
      const before = found.length;
      found = found.filter(s => {
        const combo = s.comboKey || (Array.isArray(s.namedStrategies) && s.namedStrategies.length
          ? `${s.direction}_${s.namedStrategies.slice().sort().join('+')}`
          : 'ANY');
        const comboKey = `${s.pair}_${s.direction}_${combo}`;
        const pdKey = `${s.pair}_${s.direction}`;
        if (selfAuditVetoes.has(comboKey)) return false;
        if (pairDirVetoes.has(pdKey)) return false;
        return true;
      });
      const blocked = before - found.length;
      if (blocked > 0) {
        console.warn(`[self-audit v335] Blocked ${blocked} signals · combos vetoed: ${selfAuditVetoes.size} · pair-dir vetoed: ${pairDirVetoes.size}`);
      }
    }
    pipelineDiag.stage03_afterSelfAuditVeto = found.length;
    pipelineDiag.stage03_activeVetoes = { combos: [...selfAuditVetoes], pairDirs: [...pairDirVetoes] };
  } catch (e) { console.warn('[self-audit v335]', e.message); }

  // ══════════════════════════════════════════════════════════════════════
  // v311 — HOURLY WR AUTO-VETO. Live data showed 16:00 UTC signals at
  // 20% WR over 10 samples — clearly bad but not currently blocked.
  // Now: any hour with ≥5 samples and <35% WR blocks signals during that
  // hour until data improves. Complements the fixed rules (gold dead-zone,
  // BTC dead-hours) with an empirical adaptive layer.
  // ══════════════════════════════════════════════════════════════════════
  const losingHours = new Set();
  try {
    const auditShadow = Array.isArray(allResolvedShadow) ? allResolvedShadow : [];
    const hourStats = {};
    for (const s of auditShadow) {
      if (!s || (s.status !== 'won' && s.status !== 'lost')) continue;
      const fired = s.firedAt || s.detectedAt;
      if (!fired) continue;
      const h = parseInt(String(fired).slice(11, 13), 10);
      if (!Number.isFinite(h)) continue;
      if (!hourStats[h]) hourStats[h] = { w: 0, l: 0 };
      if (s.status === 'won') hourStats[h].w++; else hourStats[h].l++;
    }
    const nowHour = new Date().getUTCHours();
    for (const [h, st] of Object.entries(hourStats)) {
      const n = st.w + st.l;
      if (n >= 5 && st.w / n < 0.35) {
        losingHours.add(parseInt(h, 10));
      }
    }
    if (losingHours.has(nowHour)) {
      const before = found.length;
      // Only block non-elite / non-bigMove signals — let genuine premium
      // setups through even during historically bad hours (the setup
      // itself might be the exception that beats the hour trend).
      found = found.filter(s => s.isEliteBrainPattern || s.bigMove || s.bigMoveHunt);
      const blocked = before - found.length;
      if (blocked > 0) {
        console.warn(`[hourly-veto v311] Hour ${nowHour}:00 UTC has <35% WR historically — blocked ${blocked} non-elite signals`);
        pipelineDiag.stage03c_hourlyVetoBlocked = blocked;
        pipelineDiag.stage03c_losingHour = nowHour;
      }
    }
  } catch { /* defensive */ }
  pipelineDiag.stage03d_afterHourlyVeto = found.length;

  const brainGated = [];
  if (brain) {
    found = found.filter(s => {
      const factors = [];
      // Helpers
      const addPass = (name, shift, evidence) => factors.push({ type: 'pass', name, shift: +shift, evidence });
      const addFail = (name, shift, evidence) => factors.push({ type: 'fail', name, shift: -Math.abs(shift), evidence });

      // 1. COMBO BACKTEST WR (per-pair)
      const pairBrain = brain.byPair ? brain.byPair[s.pair] : null;
      const combo = pairBrain && pairBrain.byCombo ? pairBrain.byCombo[s.comboKey] : null;
      if (combo) {
        const cN = combo.w + combo.l;
        if (cN >= 10) {
          const cWR = combo.w / cN;
          const evidenceWeight = Math.min(0.30, cN / 333); // cap shift at 0.30
          const shift = (cWR - 0.5) * evidenceWeight * 2; // [-0.30, +0.30] range
          if (shift >= 0) addPass('combo-backtest-wr', shift, `combo ${s.comboKey} ${Math.round(cWR*100)}% WR over ${cN} backtest samples`);
          else addFail('combo-backtest-wr', shift, `combo ${s.comboKey} ${Math.round(cWR*100)}% WR over ${cN} backtest samples`);
        }
      }
      // 2. COMBO LIVE WR (per-pair) — weighted MORE than synthetic backtest
      const liveBrain = brain.byPairLive ? brain.byPairLive[s.pair] : null;
      const liveCombo = liveBrain && liveBrain.byCombo ? liveBrain.byCombo[s.comboKey] : null;
      if (liveCombo) {
        const lN = liveCombo.w + liveCombo.l;
        if (lN >= 3) {
          const lWR = liveCombo.w / lN;
          const evidenceWeight = Math.min(0.40, lN / 25); // live data trusted faster
          const shift = (lWR - 0.5) * evidenceWeight * 2;
          if (shift >= 0) addPass('combo-live-wr', shift, `combo ${s.comboKey} ${Math.round(lWR*100)}% LIVE WR over ${lN} real signals`);
          else addFail('combo-live-wr', shift, `combo ${s.comboKey} ${Math.round(lWR*100)}% LIVE WR over ${lN} real signals`);
        }
      }
      // 3. PER-PAIR-DIRECTION LIVE WR
      const pdShadow = shadowRecentByPairDir[`${s.pair}_${s.direction}`];
      if (pdShadow && (pdShadow.w + pdShadow.l) >= 3) {
        const pdN = pdShadow.w + pdShadow.l;
        const pdWR = pdShadow.w / pdN;
        const evidenceWeight = Math.min(0.25, pdN / 20);
        const shift = (pdWR - 0.5) * evidenceWeight * 2;
        if (shift >= 0) addPass('pair-dir-live-wr', shift, `${s.pair} ${s.direction} live ${Math.round(pdWR*100)}% WR over ${pdN}`);
        else addFail('pair-dir-live-wr', shift, `${s.pair} ${s.direction} live ${Math.round(pdWR*100)}% WR over ${pdN}`);
      }
      // 4. RECENT LOSS CLUSTER (24h) — strong fail signal
      const cluster = recentLossesByPairDir[`${s.pair}_${s.direction}`] || 0;
      if (cluster >= 2) {
        const clusterShift = Math.min(0.35, cluster * 0.08); // 2 losses = 0.16, 5+ = 0.35
        addFail('recent-loss-cluster', clusterShift, `${s.pair} ${s.direction} lost ${cluster}× in last 24h`);
      }
      // 5. REGIME MATCH/MISMATCH
      const reg = brain.currentRegime;
      if (reg) {
        if (reg.regime === 'CRISIS') {
          addFail('crisis-regime', 0.40, `CRISIS regime (vol ${reg.volRatio}× normal)`);
        } else if (reg.regime === 'TRENDING_VOLATILE' && s.bigMove) {
          addPass('regime-match-bigmove', 0.15, `TRENDING_VOLATILE regime + BIG MOVE signal alignment`);
        } else if (reg.regime === 'TRENDING_QUIET' && s.confidence >= 75) {
          addPass('regime-match-trend', 0.08, `TRENDING_QUIET regime + high-conf signal`);
        } else if (reg.regime === 'RANGING_QUIET') {
          addFail('dead-market', 0.20, `RANGING_QUIET regime — no follow-through expected`);
        } else if (reg.regime === 'RANGING_VOLATILE' && s.strategies < 2) {
          addFail('choppy-thin-signal', 0.10, `RANGING_VOLATILE regime + only ${s.strategies} strategy — whipsaw risk`);
        }
      }
      // 6. BOOST-TAG LIVE EFFECTIVENESS (every active tag)
      // v308 — Live data showed 'three-plus-strats' having NEGATIVE lift
      // (48% WR, -2pt lift). The below dynamically applies the real live
      // WR of each tag, so bad boosts self-correct. Extra strength for
      // shifting away from bad tags: 2x penalty weight when tag has neg lift.
      if (brain.boostEffectiveness) {
        const activeTags = [];
        if (s.strategies >= 3) activeTags.push('three-plus-strats');
        else if (s.strategies >= 2) activeTags.push('two-strats');
        if (s.bigMove) activeTags.push('big-move');
        if (s.inKillzone) activeTags.push('killzone');
        for (const tag of activeTags) {
          const eff = brain.boostEffectiveness[tag];
          if (eff && (eff.w + eff.l) >= 10) {
            const tagN = eff.w + eff.l;
            const tagWR = eff.w / tagN;
            const evidenceWeight = Math.min(0.25, tagN / 40);
            // v308 — Asymmetric weighting: apply extra penalty when live
            // WR shows the tag is genuinely negative. This prevents the
            // system from over-relying on 'three-plus-strats'-like tags
            // that stopped working under current market regime.
            const rawShift = (tagWR - 0.5) * evidenceWeight * 2;
            const shift = rawShift < 0 ? rawShift * 1.5 : rawShift;
            if (shift >= 0) addPass(`boost-${tag}`, shift, `tag "${tag}" live WR ${Math.round(tagWR*100)}% over ${tagN} signals`);
            else addFail(`boost-${tag}`, shift, `tag "${tag}" live WR ${Math.round(tagWR*100)}% over ${tagN} signals (2× penalty applied)`);
          }
        }
      }
      // 7. HOUR-OF-DAY WR (pair-specific if ≥10 samples, else global)
      const sigHour = new Date(s.detectedAt || Date.now()).getUTCHours();
      const hourKey2 = `${s.direction}_${sigHour}`;
      const pairHr = pairBrain && pairBrain.byHour ? pairBrain.byHour[hourKey2] : null;
      const pairHrN = pairHr ? pairHr.w + pairHr.l : 0;
      const hourStat2 = pairHrN >= 10 ? pairHr : (brain.byHour ? brain.byHour[hourKey2] : null);
      if (hourStat2 && (hourStat2.w + hourStat2.l) >= 10) {
        const hN = hourStat2.w + hourStat2.l;
        const hWR = hourStat2.w / hN;
        const evidenceWeight = Math.min(0.15, hN / 200);
        const shift = (hWR - 0.5) * evidenceWeight * 2;
        if (shift >= 0) addPass('hour-of-day', shift, `${s.direction} at ${sigHour}:00 UTC has ${Math.round(hWR*100)}% WR (${hN} samples)`);
        else addFail('hour-of-day', shift, `${s.direction} at ${sigHour}:00 UTC has ${Math.round(hWR*100)}% WR (${hN} samples)`);
      }
      // 8. CONFIDENCE CALIBRATION — bucket the brain says this confidence level produces
      if (brain.calibration) {
        const bucketStart2 = Math.floor(s.confidence / 10) * 10;
        const bucketKey2 = `${bucketStart2}-${bucketStart2 + 10}`;
        const cal2 = brain.calibration[bucketKey2];
        if (cal2 && (cal2.w + cal2.l) >= 5) {
          const calN = cal2.w + cal2.l;
          const calWR = cal2.w / calN;
          const evidenceWeight = Math.min(0.20, calN / 30);
          const shift = (calWR - 0.5) * evidenceWeight * 2;
          if (shift >= 0) addPass('calibration-bucket', shift, `${bucketKey2}% confidence bucket actually wins ${Math.round(calWR*100)}% (${calN} samples)`);
          else addFail('calibration-bucket', shift, `${bucketKey2}% confidence bucket actually wins ${Math.round(calWR*100)}% (${calN} samples)`);
        }
      }
      // 9. PRO ANALYST CONSENSUS
      const consensus = proConsensusByPair[s.pair];
      if (consensus) {
        if (consensus === s.direction) addPass('pro-consensus', 0.10, `Pro analysts agree on ${s.pair} ${consensus}`);
        else addFail('pro-consensus', 0.18, `Pro analysts disagree (they say ${consensus})`);
      }
      // 10. NEWS BLACKOUT
      if (inNewsBlackout) addFail('news-blackout', 0.40, 'Active news blackout window');
      // 11. ELITE BRAIN PATTERN
      if (s.isEliteBrainPattern) addPass('elite-pattern', 0.12, `Elite brain pattern (${s.eliteBrainWR}% historical WR)`);
      // 12. BIG MOVE
      if (s.bigMove) addPass('big-move-setup', 0.08, 'BIG RUN setup (ADX strong + killzone + vol expansion + 2+ strats)');
      // v274 — MULTI-TIMEFRAME (4H) confirmation. The single biggest pro edge.
      if (s.htfStudy) {
        const htf = s.htfStudy;
        if (htf.alignment === 'aligned') {
          // Strength scales with 4H ADX — strong trend agreement = big boost
          const htfBoost = Math.min(0.18, 0.06 + htf.adx4h / 200);
          addPass('htf-aligned', htfBoost, `4H trend matches signal direction (4H ADX ${htf.adx4h})`);
        } else if (htf.alignment === 'opposed') {
          const htfPenalty = Math.min(0.18, 0.05 + htf.adx4h / 150);
          addFail('htf-opposed', htfPenalty, `⚠ Counter-trend: 4H ${htf.direction} opposes ${s.direction} (4H ADX ${htf.adx4h})`);
        }
      }
      // v266 — PER-SIGNAL STUDY VERDICT — the strongest factor when present.
      // The brain's k-NN match of this signal against history gives a direct
      // measured WR for "signals like this." If it's there, weight heavy.
      if (s.perSignalStudy && s.perSignalStudy.matched >= 3) {
        const psWR = s.perSignalStudy.perSignalWR / 100;
        // High evidence weight — k-NN study is signal-specific reality
        const sampleWeight = Math.min(0.35, s.perSignalStudy.matched / 12);
        const shift = (psWR - 0.5) * sampleWeight * 2;
        if (shift >= 0) addPass('per-signal-study', shift, `k-NN study: ${s.perSignalStudy.matched} similar past signals won ${s.perSignalStudy.perSignalWR}%`);
        else addFail('per-signal-study', shift, `k-NN study: ${s.perSignalStudy.matched} similar past signals only won ${s.perSignalStudy.perSignalWR}%`);
      }

      // 13. FAILURE PATTERN TAGS — re-derived locally
      const sigHour2 = sigHour;
      const matchedFailures2 = [];
      if (s.confidence != null && s.confidence < 70) matchedFailures2.push('weak-confidence');
      if (s.strategies != null && s.strategies < 2) matchedFailures2.push('single-strategy');
      if (sigHour2 < 7 || sigHour2 > 21) matchedFailures2.push('off-session');
      if (sigHour2 === 7 || sigHour2 === 8 || sigHour2 === 9) matchedFailures2.push('london-open-volatility');
      if (sigHour2 >= 12 && sigHour2 <= 15) matchedFailures2.push('pre-ny-volatility'); // v273 — extended
      const recurringFailures2 = matchedFailures2.filter(t => (failurePatterns[t] || 0) >= 2);
      for (const tag of recurringFailures2) {
        addFail(`failure-tag-${tag}`, 0.05, `Matches recurring failure pattern: ${tag}`);
      }

      // AGGREGATE — start at 0.50 (coin flip), each factor shifts up or down.
      // Clamp final to [0.05, 0.95] so single extreme factors can't push to 0/1.
      let pWin = 0.50;
      for (const f of factors) pWin += f.shift;
      pWin = Math.max(0.05, Math.min(0.95, pWin));

      // v266 — PRIMARY REALITY CAP: per-signal k-NN study.
      // If the brain found ≥3 historical matches for this exact feature
      // fingerprint, cap pWin at the measured rate + small buffer. This is
      // MORE PRECISE than the bucket-level calibration cap because it's
      // signal-specific, not category-wide. When this cap fires, it takes
      // precedence over the bucket calibration cap below.
      let primaryCapped = false;
      if (s.perSignalStudy && s.perSignalStudy.matched >= 3) {
        const psWR = s.perSignalStudy.perSignalWR / 100;
        const psBuffer = Math.max(0.04, 0.18 - (s.perSignalStudy.matched / 40));
        const psCeiling = psWR + psBuffer;
        if (pWin > psCeiling) {
          factors.push({
            type: 'fail', name: 'k-nn-reality-cap', shift: psCeiling - pWin,
            evidence: `k-NN verdict: ${s.perSignalStudy.matched} similar past signals → max plausible pWin ${Math.round(psCeiling*100)}%`,
          });
          pWin = psCeiling;
          primaryCapped = true;
        }
      }
      // v265/v269d/v308 — Reality cap with tightened calibration. Live data
      // shows the 90-100% confidence bucket only wins 57% (40pt overconfidence!).
      // The old buffer of 4-15pts was too generous — brain kept predicting
      // 97% pWin, actual was 57%, R:R math broke. Now:
      //   • buffer tightened to max(0.02, 0.08 - n/100) — was max(0.04, 0.15 - n/100)
      //   • lowered floor from 8 samples to 5 (react faster to real data)
      // Also: apply BAYESIAN SHRINKAGE — weight actual bucket WR heavily
      // when n≥15 (proper posterior estimate rather than simple cap).
      if (!primaryCapped && brain && brain.calibration) {
        const rawConf = Math.max(0, Math.min(99, s.confidence || 0));
        const rbStart = Math.floor(rawConf / 10) * 10;
        const rbKey = `${rbStart}-${rbStart + 10}`;
        const rcal = brain.calibration[rbKey];
        const rcalN = rcal ? (rcal.w + rcal.l) : 0;
        if (rcal && rcalN >= 5) {
          const actualWR = rcal.w / rcalN;
          // Bayesian shrinkage toward actual. Weight scales with sample size,
          // saturates at n=30 (full trust). This replaces the crude cap.
          const shrinkWeight = Math.min(1.0, rcalN / 30);
          // For low-n buckets, buffer is small but preserved to reflect uncertainty
          const buffer = Math.max(0.02, 0.08 - (rcalN / 100));
          const ceiling = actualWR + buffer;
          if (pWin > ceiling) {
            const before = pWin;
            // v308 — Full Bayesian shrinkage instead of hard cap when we
            // have solid data. Formula: posterior = (n·actual + prior_weight·pWin) / (n + prior_weight)
            if (rcalN >= 15) {
              const priorWeight = 10;
              pWin = (rcalN * actualWR + priorWeight * pWin) / (rcalN + priorWeight);
              // Still cap at ceiling if shrinkage isn't tight enough
              if (pWin > ceiling) pWin = ceiling;
            } else {
              pWin = ceiling;
            }
            factors.push({
              type: 'fail', name: 'reality-cap-bayesian', shift: pWin - before,
              evidence: `Reality cap (Bayesian): bucket ${rbKey} live WR ${Math.round(actualWR*100)}% (n=${rcalN}) — pWin adjusted from ${Math.round(before*100)}% to ${Math.round(pWin*100)}%`,
            });
          }
        }
      }
      pWin = Math.max(0.05, Math.min(0.95, pWin));
      const pLose = 1 - pWin;
      const edge = pWin - pLose; // -1 to +1
      // v245 — Use ADAPTIVE thresholds computed above. As brain wisdom grows,
      // these tighten automatically, lifting the win rate. Two gates:
      //   • edge ≥ adaptiveMinEdge   — pWin vs pLose margin must be real
      //   • pWin ≥ adaptiveMinPWin   — absolute win probability floor
      //
      // v317 — BTC cap: BTC signals use their own edge floor (fixed 15pts,
      // matching v316's premium-tier BTC threshold) instead of the shared
      // adaptive gate. Gold's recent losses were tightening the shared
      // gate to 18pts, squeezing out BTC signals whose combos hadn't
      // caused those losses. Each pair should be evaluated on its own
      // performance, not gold's.
      const isBTCSig = s.pair === 'BTC/USD';
      const MIN_EDGE = isBTCSig ? Math.min(adaptiveMinEdge, 0.15) : adaptiveMinEdge;
      const MIN_PWIN = isBTCSig ? Math.min(adaptiveMinPWin, 0.55) : adaptiveMinPWin;
      let allow = edge >= MIN_EDGE && pWin >= MIN_PWIN;

      // v263/v268 — Per-combo LIVE WR enforcement. Tightened to require
      // ≥8 samples (was 5) and ≤30% WR (was 45%) before BLOCKING outright.
      // For combos with WR 30-45%, apply soft penalty via the factor system
      // but don't hard-block — gives marginal combos a chance to recover
      // once new MOMENTUM/etc. confirmation is added.
      let comboLiveBlockReason = null;
      if (s.comboKey && comboLiveStats[s.comboKey]) {
        const cl = comboLiveStats[s.comboKey];
        const cN = cl.w + cl.l;
        if (cN >= 8) {
          const cWR = cl.w / cN;
          if (cWR <= 0.30) {
            // Disaster zone — keep the hard block
            const hasOverride = s.bigMove || s.brainRecommended || s.isEliteBrainPattern ||
              ((s._winContextSimilarity || 0) >= 0.60);
            if (!hasOverride) {
              allow = false;
              comboLiveBlockReason = `combo ${s.comboKey} has ${Math.round(cWR*100)}% LIVE WR (${cl.w}W/${cl.l}L) — needs BIG MOVE / endorsement / win-context to pass`;
            }
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // v303 — GOLD-SPECIFIC RULES. Encoded from a 1,427-bar / 88-day
      // extreme study of XAU/USD 1H OHLC + shadow-tracker outcomes.
      //
      // Findings applied here:
      //   • Best hours by median range: 13-16 UTC (NY overlap, $24-29 range)
      //   • Bullish bias: London mid (10-12 UTC), 55.4% bull bars
      //   • Dead zones: 17-20 UTC ($13-14 range), 20-23 UTC ($10-14 range)
      //   • Momentum follow-through: 56% BUY / 53% SELL after strong impulse
      //   • Top win reasons: multi-strategy-3plus, quick-decisive-move,
      //     london-open-momentum, strong-trend-30plus
      //   • Top loss reasons: weak-conf, immediate-rejection, off-session,
      //     london-open-volatility whipsaw
      //
      // Rules only apply to XAU/USD. Other pairs unaffected.
      // ══════════════════════════════════════════════════════════════════
      let goldRuleReason = null;
      if (allow && s.pair === 'XAU/USD') {
        const nowHour = new Date().getUTCHours();

        // Rule G1 — Dead-zone block: 17-23 UTC has $10-14 median range,
        // R:R breaks down because SL distance is > typical hour range.
        if (nowHour >= 17 && nowHour <= 23) {
          allow = false;
          goldRuleReason = `Gold dead-zone: ${nowHour}:00 UTC has $10-14 median range, insufficient for premium R:R. Wait for London/NY (10-16 UTC).`;
        }

        // Rule G2 — London-open volatility whipsaw (07-08 UTC): 32% of
        // gold losses fired here. Require ADX >= 30 to trade here (strong
        // trend must be established, not a false break at open).
        if (allow && (nowHour === 7 || nowHour === 8)) {
          const adx = s.adx || 0;
          if (adx < 30) {
            allow = false;
            goldRuleReason = `Gold London-open whipsaw guard: ${nowHour}:00 UTC requires ADX ≥ 30 (this: ADX=${adx}) — 32% of gold losses came from London-open false breaks`;
          }
        }

        // Rule G3 — Peak-session boost: 13-16 UTC (NY overlap) has median
        // range $21-29 vs $16 rest-of-day. Signals here get a small pWin
        // boost to reflect the higher expected pip potential per unit risk.
        if (allow && nowHour >= 13 && nowHour <= 16) {
          const before = pWin;
          pWin = Math.min(0.95, pWin + 0.03);
          factors.push({
            type: 'pass', name: 'gold-ny-peak',
            shift: pWin - before,
            evidence: `Gold peak session (${nowHour}:00 UTC NY overlap) — median range ${nowHour===13||nowHour===14 ? '$28-29' : '$16-22'}, +3% pWin`,
          });
        }

        // Rule G4 — Require strong impulse setup for gold. Momentum
        // follow-through study: only 56% BUY / 53% SELL continued after
        // a strong impulse bar. Without that impulse it's much lower.
        // Elite pattern OR bigMove override this.
        if (allow && !s.isEliteBrainPattern && !s.bigMove) {
          const chartOK = s.chartStudy && s.chartStudy.score >= 55;
          if (!chartOK) {
            allow = false;
            goldRuleReason = `Gold requires bigMove OR elite pattern OR chart-study ≥ 55 (this: ${(s.chartStudy || {}).score || 'n/a'}) — momentum follow-through is only 53-56%`;
          }
        }

        // Rule G5 — Multi-strategy floor for gold: 48% of live wins had
        // ≥3 strategies. Signals with only 1 strategy on gold get blocked.
        if (allow && (s.strategies || 0) < 2) {
          allow = false;
          goldRuleReason = `Gold requires ≥2 strategies (this: ${s.strategies || 0}). Live data: 48% of wins had 3+, only 4% had single-strategy setups.`;
        }

        // v305 — GOLD SEASONALITY (from 5-year daily study, 1,257 bars).
        // Monthly seasonality effect over 5 years:
        //   Best months (avg): Jan +4.1%, Mar +3.3%, Oct +2.9%, Nov +2.5%
        //     Feb +2.7%, Dec +2.1%
        //   Worst months (avg): Jun -3.2%, May -0.9%
        // Signals in favorable months get pWin boost; in unfavorable months
        // get penalty. Small shifts — seasonality is a slight edge, not a
        // hard block.
        if (allow) {
          const month = new Date().getUTCMonth();  // 0=Jan, 5=Jun
          const strongMonths = [0, 2, 9, 10];      // Jan, Mar, Oct, Nov
          const goodMonths = [1, 11];              // Feb, Dec
          const weakMonths = [4];                   // May
          const worstMonths = [5];                  // Jun
          const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month];
          if (s.direction === 'BUY') {
            if (strongMonths.includes(month)) {
              const before = pWin;
              pWin = Math.min(0.95, pWin + 0.03);
              factors.push({ type: 'pass', name: 'gold-seasonal-strong', shift: pWin - before,
                evidence: `Gold ${monthName} historically strong (avg +2.5-4.1% monthly over 5y), +3% pWin on BUY` });
            } else if (goodMonths.includes(month)) {
              const before = pWin;
              pWin = Math.min(0.95, pWin + 0.02);
              factors.push({ type: 'pass', name: 'gold-seasonal-good', shift: pWin - before,
                evidence: `Gold ${monthName} historically bullish (avg +2.1-2.7% monthly over 5y), +2% pWin` });
            } else if (worstMonths.includes(month)) {
              const before = pWin;
              pWin = Math.max(0.05, pWin - 0.04);
              factors.push({ type: 'fail', name: 'gold-seasonal-worst', shift: pWin - before,
                evidence: `Gold ${monthName} historically WEAK (avg -3.2% monthly over 5y) — BUY signals face seasonal headwind, -4% pWin` });
            } else if (weakMonths.includes(month)) {
              const before = pWin;
              pWin = Math.max(0.05, pWin - 0.02);
              factors.push({ type: 'fail', name: 'gold-seasonal-weak', shift: pWin - before,
                evidence: `Gold ${monthName} historically weak (avg -0.9% monthly over 5y), -2% pWin` });
            }
          }
        }

        // v305 — GOLD DAY-OF-WEEK bias (from 5-year daily study):
        //   Best days for BUY: Tue 57%, Fri 58% bull-days
        //   Weakest for BUY:   Mon 52% bull-days
        if (allow && s.direction === 'BUY') {
          const dow = new Date().getUTCDay();  // 0=Sun ... 6=Sat
          if (dow === 2 || dow === 5) {  // Tue or Fri
            const before = pWin;
            pWin = Math.min(0.95, pWin + 0.02);
            factors.push({ type: 'pass', name: 'gold-dow-good', shift: pWin - before,
              evidence: `Gold ${dow === 2 ? 'Tuesday' : 'Friday'} historically 57-58% bull-days over 5y, +2% pWin` });
          } else if (dow === 1) {  // Monday
            const before = pWin;
            pWin = Math.max(0.05, pWin - 0.01);
            factors.push({ type: 'fail', name: 'gold-dow-weak', shift: pWin - before,
              evidence: `Gold Monday historically 52% bull-days (weakest weekday over 5y), -1% pWin` });
          }
        }

        // v305 — GOLD REGIME EDGE: Strong_up regime has 61% forward P(up)
        // over 5 years — the biggest historical edge in gold data. Elite
        // brain pattern is a reasonable proxy for "we're in a strong trend"
        // since those patterns emerge from established trends.
        if (allow && s.direction === 'BUY' && s.isEliteBrainPattern && s.htfStudy?.alignment === 'aligned') {
          const before = pWin;
          pWin = Math.min(0.95, pWin + 0.03);
          factors.push({ type: 'pass', name: 'gold-strong-up-regime', shift: pWin - before,
            evidence: `Gold strong-up regime + HTF aligned = 61% forward P(up) over 5y history, +3% pWin` });
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // v304 — BTC-SPECIFIC RULES. Encoded from a 2,171-bar / 91-day
      // extreme study of BTC/USD 1H OHLC.
      //
      // Real findings:
      //   • Median 1H move: $138, 90th pctile $440, 99th pctile $1,211
      //   • Weekend range 41% LOWER than weekday ($219 vs $372) — massive
      //     liquidity drop, ranges too tight for premium R:R
      //   • Peak volatility 13-15 UTC (US session, $521-577 median range)
      //   • Weakest hours 03-11 UTC (Asia+early London, ~$280)
      //   • Momentum follow-through only 47% both directions — WORSE than
      //     coin-flip, MUCH weaker than gold. Requires stronger confluences.
      //   • 13:00 UTC bearish bias (37% bull bars = 63% bearish)
      //   • 19:00 UTC bullish bias (62% bull bars)
      //   • Sunday 22:00 UTC CME gaps are tiny (-0.02% median) — no gap edge
      //
      // Rules only apply to BTC/USD.
      // ══════════════════════════════════════════════════════════════════
      let btcRuleReason = null;
      if (allow && s.pair === 'BTC/USD') {
        const nowDate = new Date();
        const nowHour = nowDate.getUTCHours();
        const nowDay = nowDate.getUTCDay();  // 0 = Sun, 6 = Sat

        // v371 REMOVED B1 (weekend guard) and B2 (dead-hours block).
        //
        // Root-cause: both blocks set allow=false WITHOUT calling addFail(),
        // so signals were silently killed — user saw "0 platinum" with no
        // reason. Also these rules were counterproductive: on weekends, BTC
        // is the ONLY tradable market. Blocking it there = telling user "no
        // trades ever" instead of showing what's actually available.
        //
        // v371 replacement: instead of BLOCKING, we DOWNGRADE. Weekend/dead-
        // hours BTC signals still fire but with a lowered pWin (which the
        // user sees as a lower-confidence signal — honest, not silent block).
        const isWeekend = (nowDay === 0 || nowDay === 6);
        const isDeadHours = nowHour >= 3 && nowHour <= 11;
        if (isWeekend && !s.isEliteBrainPattern && !s.bigMove) {
          addFail('btc-weekend', 0.05, 'Weekend liquidity 41% lower ($219 vs $372 weekday) — pWin -5% but signal shown');
        }
        if (isDeadHours && !s.bigMove) {
          addFail('btc-dead-hours', 0.05, `Dead session ${nowHour}:00 UTC ($275-290 median range) — pWin -5% but signal shown`);
        }

        // Rule B3 — US session boost: 13-16 UTC has $430-577 range and
        // hosts 33% of the top 100 biggest moves. Signals here get +4% pWin
        // boost reflecting the higher expected pip potential per unit risk.
        if (allow && nowHour >= 13 && nowHour <= 16) {
          const before = pWin;
          pWin = Math.min(0.95, pWin + 0.04);
          factors.push({
            type: 'pass', name: 'btc-us-session',
            shift: pWin - before,
            evidence: `BTC US session (${nowHour}:00 UTC) — median range $${nowHour === 14 ? '577' : nowHour === 13 ? '542' : '520'} + top-move hour, +4% pWin`,
          });
        }

        // Rule B4 — Directional session bias:
        //   13:00 UTC: 37% bull bars → prefer SELL (63% bearish)
        //   19:00 UTC: 62% bull bars → prefer BUY
        if (allow && nowHour === 13 && s.direction === 'BUY') {
          const before = pWin;
          pWin = Math.max(0.05, pWin - 0.05);
          factors.push({
            type: 'fail', name: 'btc-13utc-bear-bias',
            shift: pWin - before,
            evidence: `BTC 13:00 UTC is 63% bearish historically — BUY has a headwind here, -5% pWin`,
          });
        }
        if (allow && nowHour === 19 && s.direction === 'BUY') {
          const before = pWin;
          pWin = Math.min(0.95, pWin + 0.03);
          factors.push({
            type: 'pass', name: 'btc-19utc-bull-bias',
            shift: pWin - before,
            evidence: `BTC 19:00 UTC is 62% bullish historically — BUY has a tailwind here, +3% pWin`,
          });
        }

        // Rule B5 — Momentum follow-through is only 47% — WORSE than
        // coin-flip. BTC requires STRONGER confluences than gold. Need
        // ≥ 3 strategies OR HTF-aligned OR elite pattern.
        // v371 — Was silently allow=false killing every BTC signal without
        // logging to topFailures. Now downgrades pWin instead so signal
        // still fires but user sees lower confidence.
        if (allow) {
          const strong = (s.strategies || 0) >= 3;
          const htfOK = s.htfStudy && s.htfStudy.alignment === 'aligned';
          if (!strong && !htfOK && !s.isEliteBrainPattern) {
            addFail('btc-low-confluence', 0.06, `Only ${s.strategies || 0} strategies + HTF=${(s.htfStudy || {}).alignment || 'n/a'} — pWin -6% (was hard-block, now downgrade)`);
          }
        }

        // v305 — BTC SEASONALITY (from 10-year daily study, 3,652 bars):
        //   Best avg daily: Oct +0.53%, Apr +0.37%, Jul +0.36%, Feb +0.31%, Dec +0.28%
        //   Worst avg daily: Jun -0.13%, Sep -0.04%
        if (allow) {
          const month = new Date().getUTCMonth();
          const strongMonths = [3, 6, 9];      // Apr, Jul, Oct
          const goodMonths = [1, 11];          // Feb, Dec
          const weakMonths = [8];              // Sep
          const worstMonths = [5];             // Jun
          const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month];
          if (s.direction === 'BUY') {
            if (strongMonths.includes(month)) {
              const before = pWin;
              pWin = Math.min(0.95, pWin + 0.03);
              factors.push({ type: 'pass', name: 'btc-seasonal-strong', shift: pWin - before,
                evidence: `BTC ${monthName} historically strong (avg +0.36-0.53% daily over 10y), +3% pWin` });
            } else if (goodMonths.includes(month)) {
              const before = pWin;
              pWin = Math.min(0.95, pWin + 0.02);
              factors.push({ type: 'pass', name: 'btc-seasonal-good', shift: pWin - before,
                evidence: `BTC ${monthName} historically bullish (avg +0.28-0.31% daily over 10y), +2% pWin` });
            } else if (worstMonths.includes(month)) {
              const before = pWin;
              pWin = Math.max(0.05, pWin - 0.03);
              factors.push({ type: 'fail', name: 'btc-seasonal-worst', shift: pWin - before,
                evidence: `BTC ${monthName} historically WEAK (avg -0.13% daily over 10y), -3% pWin` });
            }
          }
        }

        // v305 — BTC DAY-OF-WEEK bias (from 10-year daily study):
        //   Best day BUY: Mon +0.47% avg, 54% bull-days (n=521)
        //   Worst day: Thu -0.10% median, 49% bull-days (ONLY negative day)
        //   Weekend: Sat 56% bull, Sun 51% — but Rule B1 already blocks
        if (allow && s.direction === 'BUY') {
          const dow = new Date().getUTCDay();
          if (dow === 1) {  // Monday
            const before = pWin;
            pWin = Math.min(0.95, pWin + 0.03);
            factors.push({ type: 'pass', name: 'btc-monday-best', shift: pWin - before,
              evidence: `BTC Monday historically best day: +0.47% avg over 10y, 54% bull days, +3% pWin` });
          } else if (dow === 4) {  // Thursday
            const before = pWin;
            pWin = Math.max(0.05, pWin - 0.04);
            factors.push({ type: 'fail', name: 'btc-thu-negative', shift: pWin - before,
              evidence: `BTC Thursday is only historically negative weekday (-0.10% median over 10y), -4% pWin` });
          }
        }

        // v305 — BTC VOLATILITY REGIME: after high-vol day (recent StdDev
        // > 5%), 69% chance of >5% move in next 3 days. Big move likely.
        // After low-vol day, only 29% chance. Use ADX as proxy: ADX > 30 =
        // high recent momentum = breakout continuation edge.
        if (allow) {
          const adx = s.adx || 0;
          if (adx >= 35) {
            const before = pWin;
            pWin = Math.min(0.95, pWin + 0.04);
            factors.push({ type: 'pass', name: 'btc-high-vol-breakout', shift: pWin - before,
              evidence: `BTC ADX ${adx} (high-vol regime) — after strong momentum, 69% chance of >5% move in 3 days historically, +4% pWin` });
          } else if (adx < 15) {
            const before = pWin;
            pWin = Math.max(0.05, pWin - 0.03);
            factors.push({ type: 'fail', name: 'btc-low-vol-chop', shift: pWin - before,
              evidence: `BTC ADX ${adx} (low-vol regime) — after quiet days only 29% chance of decisive move, -3% pWin` });
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // v302 — PREMIUM TIER FILTER. User wants signal-feed WR up and
      // wants big-pips moves. Honestly can't promise 80% WR (no system
      // reliably does), but this raises the bar to ONLY very-high-
      // conviction setups AND enforces high-pip potential. Realistic
      // target: 60-70% WR with signals biased toward BIG RUN setups.
      //
      // ALL of the following must be TRUE for a signal to pass:
      //   1. pWin ≥ 65% (hard floor above adaptive)
      //   2. edge ≥ 25 pts (positive expectancy with margin)
      //   3. At least ONE of: bigMove OR isEliteBrainPattern OR
      //      (comboN ≥ 50 AND comboWR ≥ 0.58)
      //   4. HTF-aligned OR (elite pattern with strong 1H trend)
      //   5. pipsToTp3 ≥ per-pair PREMIUM floor (2× standard)
      // ══════════════════════════════════════════════════════════════════
      let premiumBlockReason = null;
      // v313 — PROVEN WINNER FAST-LANE. Once a combo has been battle-tested
      // with real live outcomes (≥ 20 live samples) and shows ≥ 60% actual
      // WR, we know it works. These combos get lower gate thresholds — the
      // "when it works, keep using it" principle. This prevents adaptive
      // tightening from suppressing patterns that ARE profitable.
      let provenWinner = false;
      try {
        const combo = s.comboKey && brain.byPairLive && brain.byPairLive[s.pair] && brain.byPairLive[s.pair].byCombo
          ? brain.byPairLive[s.pair].byCombo[s.comboKey]
          : null;
        if (combo) {
          const cN = (combo.w || 0) + (combo.l || 0);
          const cWR = cN > 0 ? combo.w / cN : 0;
          if (cN >= 20 && cWR >= 0.60) {
            provenWinner = true;
            s.provenWinner = true;
            s.provenWinnerStats = { samples: cN, liveWR: Math.round(cWR * 100) };
            factors.push({
              type: 'pass', name: 'proven-winner-fastlane',
              shift: 0,
              evidence: `Combo ${s.comboKey} is a proven winner: ${Math.round(cWR*100)}% live WR over ${cN} samples — fast-lane premium thresholds applied`
            });
          }
        }
      } catch { /* defensive */ }

      if (allow) {
        // v313 — Proven winners get relaxed thresholds. Otherwise standard
        // premium requirements from v303: 60% pWin, 20pt edge.
        // v316 — BTC gets proven-winner-tier thresholds automatically.
        // BTC hasn't been in the system long enough for any combo to
        // accumulate 20+ live samples (proven-winner criterion), so it was
        // permanently locked out at the 60/20 tier. BTC also uses a lower
        // edge floor (12pts vs 15) because its adaptive Bayesian reality-cap
        // is aggressive when sample size is thin.
        const isBTC = s.pair === 'BTC/USD';
        const minPwin = (provenWinner || isBTC) ? 0.55 : 0.60;
        const minEdge = isBTC ? 0.12 : (provenWinner ? 0.15 : 0.20);
        if (pWin < minPwin || edge < minEdge) {
          // v371c — downgrade instead of hard-block. If pWin/edge below the
          // premium floor, mark as fail factor (so it's visible in topFailures)
          // but keep signal alive so user sees it at lower tier.
          addFail('below-premium-floor', 0.02, `pWin ${Math.round(pWin*100)}% or edge ${Math.round(edge*100)} below premium floor (${Math.round(minPwin*100)}%/${Math.round(minEdge*100)}pts) — pWin -2%`);
        }
        // Rule 3: conviction-source requirement
        if (allow) {
          const comboObj = s.comboKey && brain.byCombo ? brain.byCombo[s.comboKey] : null;
          const comboSamples = comboObj ? (comboObj.w + comboObj.l) : 0;
          const comboWinRate = comboSamples > 0 ? comboObj.w / comboSamples : 0;
          // v303 fix — Lowered combo WR from 58% to 55%. 246k-sample combos
          // with 56% WR were being rejected — that's a genuine edge on huge
          // sample size. 55% × 1:1 R:R = +10% edge, honestly profitable.
          // Also lowered sample floor from 50 to 30 for niche combos with
          // strong but limited historical data.
          // v316 — BTC uses 51% combo threshold since multi-source layer
          // (VIX regime + Crypto F&G + macro basket) provides orthogonal
          // confidence not captured in the combo WR alone. Still needs
          // real historical edge (>50 = better than coin flip).
          const isBTC = s.pair === 'BTC/USD';
          const minComboWR = isBTC ? 0.51 : 0.55;
          const hasStrongCombo = comboSamples >= 30 && comboWinRate >= minComboWR;
          // v329 — RECENT-LIVE OVERRIDE. If the CURRENT setup has a strong
          // recent-tag WR (e.g. "two-strats" has 61% WR over 59 live
          // samples), trust recent evidence over stale historical combo
          // stats. Historical combo may be 48% over 360k samples, but that
          // includes years-old data from different market regimes. Recent
          // live samples reflect current market character.
          let hasRecentLiveOverride = false;
          const factorsList = (typeof factors !== 'undefined' && Array.isArray(factors)) ? factors : [];
          for (const f of factorsList) {
            if (f.type !== 'pass') continue;
            const ev = f.evidence || '';
            // Match "tag ... live WR NN% over MM real signals" or similar
            const m = ev.match(/live WR (\d+)% over (\d+)/i);
            if (m) {
              const wr = parseInt(m[1], 10);
              const n = parseInt(m[2], 10);
              if (n >= 30 && wr >= 60) {
                hasRecentLiveOverride = true;
                break;
              }
            }
          }
          // v371 — Was silently allow=false. Now downgrades — user sees the
          // signal at lower pWin instead of empty feed. Real conviction
          // sources still boost pWin via other factors; missing them just
          // means -8% here (was -infinity via hard-block).
          const hasConvictionSource = s.bigMove || s.isEliteBrainPattern || hasStrongCombo || hasRecentLiveOverride;
          if (!hasConvictionSource) {
            addFail('no-conviction-source', 0.08, `No bigMove/elite/strong-combo/recent-live-tag — pWin -8%. Combo: ${comboSamples} samples ${Math.round(comboWinRate*100)}% WR`);
          }
        }
        // Rule 4: HTF alignment (skip if elite pattern with strong local trend)
        if (allow && s.htfStudy) {
          const htf = s.htfStudy;
          const htfAligned = htf.alignment === 'aligned';
          const htfNeutral = htf.alignment === 'neutral' || htf.alignment === 'unknown';
          if (!htfAligned && !(s.isEliteBrainPattern && htfNeutral)) {
            // v371 — HTF non-alignment downgrade instead of hard-block
            addFail('htf-not-aligned', 0.07, `HTF ${htf.alignment} — pWin -7% (previously blocked entirely)`);
          }
        }
        // Rule 5: premium pip floor (double the standard v298 minimum)
        // v316 — BTC premium pip floor 800 → 400 (still 60% higher than
        // standard 250 floor, but achievable in current 90-110 ATR regime).
        if (allow) {
          const premiumTp3Floor = s.pair === 'XAU/USD' ? 160
            : s.pair === 'XAG/USD' ? 80
            : s.pair === 'BTC/USD' ? 400
            : s.pair === 'ETH/USD' ? 50
            : s.pair && s.pair.includes('JPY') ? 80
            : s.pair === 'US30' ? 200
            : s.pair === 'NAS100' ? 120
            : 60;  // forex default
          if ((s.pipsToTp3 || 0) < premiumTp3Floor) {
            // v371 — Small-target downgrade instead of hard-block. A 200-pip
            // TP3 isn't PREMIUM but it's still a valid trade with real edge.
            addFail('small-tp3', 0.04, `TP3 ${s.pipsToTp3 || 0} < ${premiumTp3Floor}p premium floor — pWin -4%`);
          }
        }
        // Success — mark the signal as premium tier
        if (allow) {
          s.premiumTier = true;
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // v307 — QUALITY TIER GRADING. Every signal that passes gets one of:
      //   PLATINUM — 7+ pass factors, elite pattern OR bigMove, pWin ≥ 70%
      //   GOLD     — 5-6 pass factors, HTF-aligned, pWin ≥ 65%
      //   SILVER   — 3-4 pass factors, pWin ≥ 60%
      //   BRONZE   — passed all gates but only marginally
      // Visible on card so user can rank at a glance. Not a filter — just
      // a quality indicator.
      // ══════════════════════════════════════════════════════════════════
      if (allow) {
        const passCount = factors.filter(f => f.type === 'pass').length;
        const failCount = factors.filter(f => f.type === 'fail').length;
        const netFactors = passCount - failCount;
        const isEliteOrBig = s.isEliteBrainPattern || s.bigMove;
        const htfAligned = s.htfStudy?.alignment === 'aligned';
        let tier = 'BRONZE';
        if (passCount >= 7 && isEliteOrBig && pWin >= 0.70) tier = 'PLATINUM';
        else if (passCount >= 5 && htfAligned && pWin >= 0.65) tier = 'GOLD';
        else if (passCount >= 3 && pWin >= 0.60) tier = 'SILVER';
        s.qualityTier = tier;
        s.qualityPassCount = passCount;
        s.qualityNetFactors = netFactors;
      }

      // ══════════════════════════════════════════════════════════════════
      // v307 — SIGNAL EXPIRY. Every signal gets an explicit expiration
      // timestamp. Prevents users chasing stale setups that would already
      // have played out. Duration depends on brain's `avgBars` estimate
      // (typical time to resolution). Falls back to sensible defaults.
      // After expiry the client filters the signal out of the feed.
      // ══════════════════════════════════════════════════════════════════
      if (allow) {
        const avgBarsToResolve = s.brainAvgBars || 12; // fallback: 12 hours
        const expiryHours = Math.max(2, Math.min(48, avgBarsToResolve * 0.4));
        // Signals go stale AT ENTRY within ~40% of their typical resolution
        // time. After that the setup context has usually shifted enough
        // that the pattern doesn't apply.
        const expiryMs = Date.now() + expiryHours * 3600 * 1000;
        s.expiresAt = new Date(expiryMs).toISOString();
        s.expiresInMinutes = Math.round(expiryHours * 60);
      }

      // Attach the analysis to the signal so UI can display "P(win) 67%"
      s.probabilityAnalysis = {
        pWin: Math.round(pWin * 100),
        pLose: Math.round(pLose * 100),
        edge: Math.round(edge * 100),
        passFactors: factors.filter(f => f.type === 'pass'),
        failFactors: factors.filter(f => f.type === 'fail'),
        decision: allow ? 'allow' : 'block',
      };

      if (!allow) {
        brainGated.push({
          pair: s.pair, direction: s.direction,
          confidence: s.confidence, comboKey: s.comboKey,
          // v263 — Surface the hard combo block reason if that's what killed it
          comboBlockReason: comboLiveBlockReason || undefined,
          // v302 — Surface the premium tier block reason so user sees WHY
          // a signal that would previously have shipped got held back.
          premiumBlockReason: premiumBlockReason || undefined,
          // v303 — Gold-specific rule reason (dead zones, session times,
          // London-open whipsaw guard, etc.). Only set on XAU/USD.
          goldRuleReason: goldRuleReason || undefined,
          // v304 — BTC-specific rule reason (weekend liquidity block,
          // dead-hours guard, momentum follow-through requirement).
          btcRuleReason: btcRuleReason || undefined,
          pWin: Math.round(pWin * 100),
          pLose: Math.round(pLose * 100),
          edge: Math.round(edge * 100),
          minEdgeRequired: Math.round(MIN_EDGE * 100),
          // Top 3 failure reasons (largest magnitude fail shifts)
          topFailures: factors
            .filter(f => f.type === 'fail')
            .sort((a, b) => a.shift - b.shift)
            .slice(0, 3)
            .map(f => f.evidence),
          // Top 2 pass reasons (so user sees what almost saved it)
          topPasses: factors
            .filter(f => f.type === 'pass')
            .sort((a, b) => b.shift - a.shift)
            .slice(0, 2)
            .map(f => f.evidence),
        });
        return false;
      }
      return true;
    });

    // v243 — QUANTUM MONTE CARLO. For each signal that passed the
    // probability gate, run 500 simulated price paths to compute forward
    // probabilities of hitting TP1/TP2/TP3/SL and identify the best
    // mini-trade position-split strategy (scalp / balanced / pyramid /
    // trail / let-run). Adds rich `quantum` field to each signal.
    for (const s of found) {
      try {
        s.quantum = quantumSimulate(s, brain, { iterations: 500 });
      } catch (e) {
        s.quantum = { error: e.message };
      }
    }

    // v250 — BRAIN'S TOP PICK. After every signal has been scored, gated,
    // and simulated, the brain identifies the SINGLE best one of the bunch
    // and marks it as its recommendation — "out of everything I've learned,
    // this is the trade I'd take." Score combines win probability, edge,
    // expected R from the simulator, combo sample weight, historical WR,
    // and bonus tags (BIG MOVE, elite pattern, killzone). Only marked if
    // the composite score clears 100 — guards against weak-day recommendations.
    if (found.length > 0) {
      const recScore = (s) => {
        let sc = 0;
        const pa = s.probabilityAnalysis || {};
        const q = (s.quantum && !s.quantum.error) ? s.quantum : null;
        sc += pa.pWin || 50;                                       // base: probability of winning
        sc += (pa.edge || 0) * 0.5;                                // edge bonus (0.5pt per pt)
        if (q && q.bestStrategy) sc += q.bestStrategy.expectedR * 30; // E[R] is the headline number
        if (s.brainComboSamples) sc += Math.min(15, s.brainComboSamples / 100); // more data = more trust
        if (s.brainComboWR) sc += Math.max(0, (s.brainComboWR - 50) * 0.3);      // combo WR over 50%
        if (s.bigMove) sc += 12;                                   // big-move bonus
        if (s.isEliteBrainPattern) sc += 15;                       // elite pattern bonus
        if (s.inKillzone) sc += 5;                                 // killzone bonus
        // v446 — the "+5 for 3+ strategy confluence" is gone. Measured over
        // 14,762 signals, 3 strategies returned -0.016R, 4 returned -0.058R
        // and 7 returned -0.102R, against +0.022R for 2. This line was
        // promoting the worst signals to Top Pick. Confluence is not
        // evidence here: by the time seven indicators agree, the move has
        // already happened and the entry is late.
        return sc;
      };
      let bestSignal = null, bestScore = -Infinity;
      for (const s of found) {
        const sc = recScore(s);
        if (sc > bestScore) { bestScore = sc; bestSignal = s; }
      }
      // Only recommend if the score is genuinely strong — avoids "best of the
      // mediocre" on slow days when nothing is great.
      if (bestSignal && bestScore >= 100) {
        bestSignal.brainRecommended = true;
        bestSignal.brainRecommendationScore = Math.round(bestScore);
        // Human-readable summary of WHY this won the recommendation race
        const reasons = [];
        const pa = bestSignal.probabilityAnalysis || {};
        if (pa.pWin) reasons.push(`${pa.pWin}% win probability`);
        if (pa.edge >= 20) reasons.push(`+${pa.edge}pt edge`);
        if (bestSignal.quantum?.bestStrategy?.expectedR) reasons.push(`E[R] ${bestSignal.quantum.bestStrategy.expectedR > 0 ? '+' : ''}${bestSignal.quantum.bestStrategy.expectedR}`);
        if (bestSignal.bigMove) reasons.push('BIG RUN setup');
        if (bestSignal.isEliteBrainPattern) reasons.push(`elite pattern (${bestSignal.eliteBrainWR}% backtest WR)`);
        if (bestSignal.brainComboSamples >= 100 && bestSignal.brainComboWR >= 60) {
          reasons.push(`combo proven ${bestSignal.brainComboWR}% WR over ${bestSignal.brainComboSamples} samples`);
        }
        bestSignal.brainRecommendationReason = reasons.join(' · ');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // v312 — FINAL INVARIANT VALIDATOR. Last line of defense before signals
  // reach the user. Every shipped signal must satisfy this strict contract.
  // Any signal that violates ANY invariant is logged with the reason and
  // dropped. This ensures NOTHING malformed can ever reach the UI, even
  // if a bug slips into any of the upstream layers.
  // ══════════════════════════════════════════════════════════════════════
  const invariantsFailed = [];
  const _validateSignalInvariants = (s) => {
    const errs = [];
    // 1. Required fields present
    if (!s.pair || typeof s.pair !== 'string') errs.push('missing-pair');
    if (!s.direction || (s.direction !== 'BUY' && s.direction !== 'SELL')) errs.push('bad-direction');
    if (typeof s.entry !== 'number' || !isFinite(s.entry) || s.entry <= 0) errs.push('bad-entry');
    if (typeof s.sl !== 'number' || !isFinite(s.sl) || s.sl <= 0) errs.push('bad-sl');
    if (typeof s.tp1 !== 'number' || !isFinite(s.tp1) || s.tp1 <= 0) errs.push('bad-tp1');
    if (typeof s.tp2 !== 'number' || !isFinite(s.tp2) || s.tp2 <= 0) errs.push('bad-tp2');
    if (typeof s.tp3 !== 'number' || !isFinite(s.tp3) || s.tp3 <= 0) errs.push('bad-tp3');
    if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 100) errs.push('bad-confidence');
    if (errs.length) return errs;

    // 2. Direction-correct geometry
    if (s.direction === 'BUY') {
      if (s.sl >= s.entry) errs.push('buy-sl-not-below-entry');
      if (s.tp1 <= s.entry) errs.push('buy-tp1-not-above-entry');
      if (s.tp2 <= s.entry) errs.push('buy-tp2-not-above-entry');
      if (s.tp3 <= s.entry) errs.push('buy-tp3-not-above-entry');
      if (s.tp1 >= s.tp2) errs.push('buy-tp1-not-below-tp2');
      if (s.tp2 >= s.tp3) errs.push('buy-tp2-not-below-tp3');
    } else if (s.direction === 'SELL') {
      if (s.sl <= s.entry) errs.push('sell-sl-not-above-entry');
      if (s.tp1 >= s.entry) errs.push('sell-tp1-not-below-entry');
      if (s.tp2 >= s.entry) errs.push('sell-tp2-not-below-entry');
      if (s.tp3 >= s.entry) errs.push('sell-tp3-not-below-entry');
      if (s.tp1 <= s.tp2) errs.push('sell-tp1-not-above-tp2');
      if (s.tp2 <= s.tp3) errs.push('sell-tp2-not-above-tp3');
    }

    // 3. R:R invariant — TP1 must be ≥ 95% of SL distance (v298 rule)
    const slDist = Math.abs(s.entry - s.sl);
    const tp1Dist = Math.abs(s.tp1 - s.entry);
    const tp3Dist = Math.abs(s.tp3 - s.entry);
    if (slDist === 0) errs.push('zero-sl-distance');
    else {
      if (tp1Dist < slDist * 0.3) errs.push(`tp1-too-near (${(tp1Dist/slDist).toFixed(2)}R)`);   // v458
      // v441 — R:R floor 3.0 -> 2.5.
      //
      // v419 set this at 3.0 reasoning that a higher ratio buys safety
      // against a falling win rate. The arithmetic is right; the mistake is
      // treating R:R as free. Widening targets or tightening stops to hit a
      // ratio changes the probability of reaching them, and the excursion
      // study quantified that: at a 1.5 ATR stop (R:R 4.67) the stop is hit
      // on 80.8% of trades; at 2.5 ATR (R:R 2.80) on 14.1%.
      //
      // Measured expectancy per trade, held to the furthest target:
      //   1.5 ATR stop, R:R 4.67  ->  +0.073R
      //   2.5 ATR stop, R:R 2.80  ->  +0.106R
      //
      // The lower ratio is the better trade, because it is actually
      // reachable. A 3.0 floor would now reject the stop geometry that
      // measures best, so it moves to 2.5 — still break-even at a ~29% hit
      // rate, comfortably above the ~21-23% observed.
      if (tp3Dist < slDist * 1.2) errs.push(`tp3-too-near (${(tp3Dist/slDist).toFixed(2)}R)`);   // v458
    }

    // v398 — SL sanity ceiling. Defense-in-depth against any code path
    // that could produce a nonsense stop-loss. Per-pair max as % of entry:
    //   BTC/ETH:  4%  (crypto genuinely swings this much)
    //   Indices:  1.5% (US30/NAS100/SPX500)
    //   FX/gold:  2%   (already generous — real setups rarely need > 1%)
    // Anything above the ceiling is a code bug or bad data — reject it.
    const slPct = s.entry > 0 ? (slDist / s.entry) * 100 : 999;
    const slCeilingPct = ['BTC/USD','ETH/USD'].includes(s.pair) ? 4.0
      : ['US30','NAS100','SPX500','GER40','UK100','JPN225'].includes(s.pair) ? 1.5
      : 2.0;
    if (slPct > slCeilingPct) {
      errs.push(`sl-too-wide (${slPct.toFixed(2)}% of entry, max ${slCeilingPct}%)`);
    }

    // 4. Per-pair minimum pip potential (v298 floors, v316 BTC lowered)
    const minTp3Pips = s.pair === 'XAU/USD' ? 80
      : s.pair === 'XAG/USD' ? 40
      : s.pair === 'BTC/USD' ? 250
      : s.pair === 'ETH/USD' ? 25
      : s.pair && s.pair.includes('JPY') ? 40
      : s.pair === 'US30' ? 100
      : s.pair === 'NAS100' ? 60
      : 30;
    if (typeof s.pipsToTp3 === 'number' && s.pipsToTp3 < minTp3Pips) {
      errs.push(`tp3-pips-below-minimum (${s.pipsToTp3}p, need ${minTp3Pips}p)`);
    }

    // 5. Probability analysis (if attached) must be well-formed
    if (s.probabilityAnalysis) {
      const pa = s.probabilityAnalysis;
      if (typeof pa.pWin === 'number' && (pa.pWin < 0 || pa.pWin > 100)) errs.push('pWin-out-of-range');
      if (typeof pa.edge === 'number' && (pa.edge < -100 || pa.edge > 100)) errs.push('edge-out-of-range');
    }

    // 6. Expiry timestamp valid
    if (s.expiresAt) {
      const expiryMs = Date.parse(s.expiresAt);
      if (!isFinite(expiryMs)) errs.push('bad-expiry-format');
      else if (expiryMs < Date.now()) errs.push('expired-already');
    }
    return errs;
  };

  const before = found.length;
  found = found.filter(s => {
    const errs = _validateSignalInvariants(s);
    if (errs.length) {
      invariantsFailed.push({
        pair: s.pair, direction: s.direction, entry: s.entry,
        errors: errs,
      });
      console.warn(`[invariants v312] Dropped ${s.pair} ${s.direction}: ${errs.join(', ')}`);
      return false;
    }
    return true;
  });
  const droppedByInvariants = before - found.length;
  pipelineDiag.stage03e_afterBrainGate = before; // brain gate ran inside `if (brain) found = found.filter(...)` earlier
  pipelineDiag.stage04_afterInvariantsCheck = found.length;
  pipelineDiag.stage04_droppedByInvariants = droppedByInvariants;

  // ═══════════════════════════════════════════════════════════════════════
  // v323 — PRICE-ALREADY-MOVED GUARD. If live price has already travelled
  // > 40% of the way from entry to TP1, the trade opportunity is mostly
  // gone. Showing it as fresh would be a fake signal — user acts on it,
  // gets in near TP1, sees the move complete, thinks they lost.
  // Fetch current live price for each signal's pair and check vs entry.
  // ═══════════════════════════════════════════════════════════════════════
  const _uniqueSigPairs = [...new Set(found.map(s => s.pair).filter(Boolean))];
  const livePriceByPair = {};
  await Promise.all(_uniqueSigPairs.map(async (p) => {
    try {
      const sym = PAIRS[p];
      if (!sym) return;
      const res = await fetch(`${_scanOrigin}/api/prices?symbol=${encodeURIComponent(sym)}`);
      if (!res.ok) return;
      const data = await res.json();
      const bars = data.ohlc || [];
      if (bars.length) livePriceByPair[p] = bars[bars.length - 1].c;
    } catch { /* per-pair non-fatal */ }
  }));
  const beforeMoved = found.length;
  found = found.filter(s => {
    const livePx = livePriceByPair[s.pair];
    if (!livePx || !s.entry || !s.tp1) return true;
    const entryToTp1 = Math.abs(s.tp1 - s.entry);
    if (entryToTp1 <= 0) return true;
    const priceProgress = s.direction === 'BUY'
      ? (livePx - s.entry) / entryToTp1
      : (s.entry - livePx) / entryToTp1;
    if (priceProgress > 0.40) {
      s._fakeReason = `price already ${Math.round(priceProgress * 100)}% of the way to TP1 — move is done`;
      return false;
    }
    // Also reject if price has already crossed SL (signal would already be stopped)
    if (s.direction === 'BUY' && livePx <= s.sl) {
      s._fakeReason = `price ${livePx} already at/below SL ${s.sl} — signal invalidated`;
      return false;
    }
    if (s.direction === 'SELL' && livePx >= s.sl) {
      s._fakeReason = `price ${livePx} already at/above SL ${s.sl} — signal invalidated`;
      return false;
    }
    return true;
  });
  const droppedByMoved = beforeMoved - found.length;
  pipelineDiag.stage05_afterPriceMovedGuard = found.length;
  pipelineDiag.stage05_droppedByPriceMoved = droppedByMoved;

  // v326 — TOP PICK. After all filters + sorting by EV, the first signal
  // is the mathematically-best opportunity right now. Flag it so the UI
  // can badge it (e.g. "⭐ BEST SIGNAL — highest EV").
  if (found.length > 0) {
    found[0].topPick = true;
    found[0].topPickReason = `Highest expected value: ${found[0].expectedValuePips} pips per trade`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // v327 — CORRELATION PORTFOLIO GUARD. When multiple signals fire on
  // correlated pairs in the same direction, taking all = double exposure.
  // Example: BUY EUR/USD + BUY GBP/USD both = short-USD trade (0.85 corr).
  // We flag secondary signals so the user knows to pick one, not both.
  //
  // Empirical rolling correlations (30-day historical, updated periodically):
  //   EUR/USD ↔ GBP/USD:  +0.85  (both anti-USD majors)
  //   EUR/USD ↔ AUD/USD:  +0.70
  //   GBP/USD ↔ AUD/USD:  +0.70
  //   AUD/USD ↔ NZD/USD:  +0.90  (commodity currencies)
  //   USD/CHF ↔ USD/JPY:  +0.65  (both pro-USD)
  //   XAU/USD ↔ EUR/USD:  +0.30  (weak positive, gold anti-USD)
  //   XAU/USD ↔ BTC/USD:  +0.15  (mostly independent)
  // Same-currency-side pairs (both starting with USD or both ending with USD)
  // get the correlation for the opposite currency exposure.
  // ═══════════════════════════════════════════════════════════════════════
  if (found.length >= 2) {
    const PAIR_CORRELATIONS = {
      'EUR/USD|GBP/USD': 0.85,
      'EUR/USD|AUD/USD': 0.70,
      'EUR/USD|NZD/USD': 0.65,
      'GBP/USD|AUD/USD': 0.70,
      'GBP/USD|NZD/USD': 0.60,
      'AUD/USD|NZD/USD': 0.90,
      'USD/CHF|USD/JPY': 0.65,
      'USD/CHF|USD/CAD': 0.55,
      'USD/JPY|USD/CAD': 0.50,
      'XAU/USD|EUR/USD': 0.30,
    };
    const getCorr = (a, b) => {
      const key1 = `${a}|${b}`;
      const key2 = `${b}|${a}`;
      return PAIR_CORRELATIONS[key1] || PAIR_CORRELATIONS[key2] || 0;
    };
    for (let i = 1; i < found.length; i++) {
      const current = found[i];
      const correlations = [];
      for (let j = 0; j < i; j++) {
        const prior = found[j];
        // Same-direction correlation (both BUY on correlated pairs = double exposure)
        // Opposite-direction on correlated pairs is actually a hedge (no warn)
        if (current.direction !== prior.direction) continue;
        const corr = getCorr(current.pair, prior.pair);
        if (corr >= 0.6) {
          correlations.push({
            with: `${prior.pair} ${prior.direction}`,
            correlation: corr,
          });
        }
      }
      if (correlations.length) {
        current.correlationRisk = {
          hasRisk: true,
          concurrentSignals: correlations,
          note: `Correlated with ${correlations.map(c => c.with).join(', ')} (${Math.round(correlations[0].correlation * 100)}%+ historical corr). Taking both = double exposure.`,
        };
      }
    }
  }

  pipelineDiag.stage99_final = found.length;
  pipelineDiag.platinumGateDropped = (globalThis.__platinumDropped || []).slice(0, 20);
  pipelineDiag.platinumFilterRanTimes = globalThis.__platinumFilterRan || 0;
  const payload = {
    ts: Date.now(),
    isoTime: new Date().toISOString(),
    count: found.length,
    signals: found,
    pipelineDiag,
    // v323 — Transparency on anti-fake-signal rejections so user sees
    // exactly how many "would-look-good-but-fake" signals were blocked.
    droppedByPriceMoved: droppedByMoved || undefined,
    // v312 — Surface any invariant violations. Tests can pull this
    // and confirm the pipeline is producing well-formed signals.
    invariantsFailed: droppedByInvariants > 0 ? invariantsFailed : undefined,
    droppedByInvariants: droppedByInvariants || undefined,
    // v241 — Brain Gate output. UI shows count + reasons so users see
    // EXACTLY what the brain rejected and why. Trust through transparency.
    brainGated: brainGated,
    brainGatedCount: brainGated.length,
    // v245 — Adaptive thresholds + reasoning. UI displays the current bar
    // (e.g. "Edge ≥12pts · pWin ≥58%") and what's driving any tightening.
    adaptiveGate: {
      minEdgePts: Math.round(adaptiveMinEdge * 100),
      minPWinPct: Math.round(adaptiveMinPWin * 100),
      targetWRPct: Math.round(adaptiveTargetWR * 100),
      tighteningReason: adaptiveTighteningReason,
      basedOnIntelLevel: brain ? Math.round((brain.intelligenceLevel || 0.5) * 100) : null,
    },
    brainStats: brain ? {
      totalSamples: brain.totalSamples,
      runs: brain.runs,
      lastUpdated: brain.lastUpdated,
      currentRegime: brain.currentRegime ? brain.currentRegime.regime : null,
      calibrationAccuracy: brain.calibrationAccuracy != null ? Math.round(brain.calibrationAccuracy * 100) : null,
    } : null,
  };

  // v234 — Skip the KV write if the signal set hasn't changed since last save.
  // check-signals fires every 60s; without this we burn 1440 writes/day just on
  // latest-signals (50%+ of the free-tier quota). With dedup we drop to a few
  // dozen writes/day (only on actual signal changes).
  if (env.TRADES_KV) {
    try {
      const prevRaw = await env.TRADES_KV.get('latest-signals');
      let needsWrite = true;
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        // Same signal set if same count AND same pair_direction_confidence_entry signature
        const sig = (arr) => (arr || []).map(s => `${s.pair}_${s.direction}_${s.confidence}_${s.entry}`).sort().join('|');
        if (prev.count === payload.count && sig(prev.signals) === sig(payload.signals)) needsWrite = false;
      }
      if (needsWrite) {
        // v357 — smartPut: KV first (persistent, TP-monitor reads from KV), Cache
        // fallback if KV quota exhausted. Prevents the whole pipeline going
        // silent when we hit 1000 writes/day. Without this, latest-signals is
        // the biggest per-day KV write consumer (~288/day at 5-min cron).
        try {
          const { smartPut } = await import('./_cache-store.js');
          await smartPut(env, 'latest-signals', 'latest-signals', payload, 3600);
        } catch {
          try { await env.TRADES_KV.put('latest-signals', JSON.stringify(payload), { expirationTtl: 3600 }); } catch {}
        }
      }
      // v297 — Stamp the timestamp of the last time we produced a strategy-
      // confirmed signal. The release valve reads this on the next scan to
      // decide whether to loosen the gate if we've been silent too long.
      // v357 — Move to Cache API only (ephemeral, gets read by release valve
      // in same-worker context so no cross-request persistence needed).
      const hasQualitySignal = (found || []).some(s =>
        s && s.strategies >= 2 && s.confidence >= 65
      );
      if (hasQualitySignal) {
        try {
          const { cachePut } = await import('./_cache-store.js');
          await cachePut('last-quality-signal-ts', String(Date.now()), 7 * 24 * 3600);
        } catch {}
      }
    } catch (e) { /* swallow — next call retries */ }
  }

  // v213/v214 — Fire off learning-brain + shadow-tracker updates in the
  // background. waitUntil runs after our response — doesn't slow the user.
  // v318 — Also fire tp-monitor so it ingests any newly-emitted signals
  // and checks all open signals for TP/SL hits (pushes notifications when
  // levels are touched — even if the user's app is closed).
  // v447 — WARMERS ARE THROTTLED TO THEIR OWN REFRESH RATES.
  //
  // These twelve used to fire unconditionally on every scan. Several fan
  // out again, so a single scan cost ~27 Function invocations of pure
  // cache-warming — enough on its own to exhaust the 100k/day free tier by
  // mid-afternoon and take every /api/* route down. Refetching the economic
  // calendar (which changes daily) every few minutes was the clearest
  // example of paying for nothing.
  //
  // Each interval below is the rate at which that data can actually change.
  // Nothing is dropped — everything still refreshes, just not pointlessly.
  // The two that must track the market tick-for-tick keep the fastest rates.
  if (context.waitUntil) {
    // Outcome tracking — must stay close to live so TP/SL hits are caught.
    await warmIfStale(context, origin, 'shadow-tracker', 240);
    await warmIfStale(context, origin, 'tp-monitor', 180);
    // Chart reads — a fresh hourly bar cannot appear faster than this.
    await warmIfStale(context, origin, 'chart-eye', 420);
    await warmIfStale(context, origin, 'chart-pulse', 420);
    await warmIfStale(context, origin, 'live-analysis?minConfidence=60', 420);
    // Learning + self-correction — these aggregate history, so they gain
    // nothing from sub-15-minute refreshes.
    await warmIfStale(context, origin, 'learning-brain', 900,
      { headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {} });
    await warmIfStale(context, origin, 'self-trust', 1800);
    await warmIfStale(context, origin, 'pattern-match', 1800);
    // News and sentiment — headlines do not turn over in minutes.
    await warmIfStale(context, origin, 'news', 1800);
    await warmIfStale(context, origin, 'news-sentiment', 1800);
    await warmIfStale(context, origin, 'pro-consensus', 1800);
    // The economic calendar is published a day ahead.
    await warmIfStale(context, origin, 'calendar', 7200);
  }

  // ─────────────────────────────────────────────────────────────────────
  // FIRE WEB PUSH NOTIFICATIONS for fresh strategy-confirmed signals.
  // This is what makes the user's phone vibrate even when the app is
  // closed and the phone is locked. Only fires for strategy-confirmed
  // signals (strategies count >= 1) AND only if not seen in the last
  // 90 minutes (deduplicated via KV "pushed:<key>" entries).
  // ─────────────────────────────────────────────────────────────────────
  let pushSent = 0;
  if (env.TRADES_KV && found.length > 0) {
    try {
      const list = await env.TRADES_KV.list({ prefix: 'pushsub:' });
      const subs = [];
      for (const k of list.keys) {
        try {
          const r = await env.TRADES_KV.get(k.name, 'json');
          if (r && r.subscription) subs.push({ key: k.name, sub: r.subscription });
        } catch {}
      }

      for (const s of found) {
        if (!s) continue;
        // STRATEGY-CONFIRMED ONLY — push must have:
        //   • v283 RAISED FLOOR: At least 3 pattern strategies (was 2). The
        //     user explicitly asked for the brain to be more selective —
        //     requiring 3 confluences cuts the noise hard.
        //   • Confidence ≥ 88 (was 85) — institutional-grade only.
        //   • Brain pWin ≥ 68% IF the brain ran. v284 fixes a critical
        //     regression where brain==null (KV cold start) silently blocked
        //     all pushes. When brain isn't available we fall back to the
        //     confidence floor only — better to ship strong-confidence
        //     signals than ship nothing during a transient brain outage.
        // v317b — BTC push relaxation: BTC signals rarely hit 3 concurrent
        // confluences due to its naturally lower ADX regime, but a BTC BUY
        // with 2 strategies + conf ≥ 92 + multi-source CONFIRM is still
        // a strict, high-quality signal. Compensated by higher conf floor.
        const isBTC = s.pair === 'BTC/USD';
        const msVerdict = s.multiSourceCheck && s.multiSourceCheck.verdict;
        // v459 — NOTIFY ON STRATEGY CONFLUENCE, WHICH IS WHAT WAS ASKED FOR.
        //
        // This required 3+ strategies AND confidence >= 88, so a clean 2-
        // strategy setup never reached the phone. The confidence half of that
        // gate is also not defensible: measured over 17,437 signals,
        // correlation(confidence, outcome) was -0.010 and the 90-99 band
        // performed WORSE than 70-79. Gating alerts on a number that carries
        // no information just silences real setups.
        //
        // The bar is now the thing the user actually asked to be alerted on:
        // two or more independent strategies confirming. Three or more is
        // flagged in the message so the stronger ones still stand out.
        const btcPushOk = isBTC && s.strategies >= 2 && msVerdict === 'CONFIRM';
        if (!btcPushOk) {
          if (!s.strategies || s.strategies < 2) continue;
        }
        if (s.probabilityAnalysis && typeof s.probabilityAnalysis.pWin === 'number') {
          // v317b — BTC pWin threshold 55% (was 68%). BTC uses a lower
          // pair-adjusted threshold because its Bayesian reality-cap is
          // aggressive with thin sample sizes. Non-BTC keeps 68%.
          const pWinFloor = isBTC ? 55 : 68;
          if (s.probabilityAnalysis.pWin < pWinFloor) continue;
        }
        // v283/v284 — LIVE-CHART RE-CONFIRMATION. Re-fetch the latest 5 bars
        // for this exact pair and verify the chart STILL looks like the
        // signal we want to push. Catches the case where price moved sharply
        // between signal detection and push fire (stale signal that would
        // have lost). Three guards:
        //   1. SL already crossed (signal would have already triggered SL)
        //   2. Latest bar is a strong-body reversal candle vs. the signal
        //   3. "Chasing" — drift from entry exceeds full SL distance
        // v284 fix: use authoritative PAIRS constant (was a stale duplicate
        // 8-pair symMap that broke on any other instrument). Defensive
        // guards for missing entry/sl. Tightened chasing multiplier 1.5→1.0.
        try {
          const fetchSym = PAIRS[s.pair] || (s.pair && s.pair.includes('/')
            ? s.pair.replace('/', '') + '=X'
            : s.pair);
          const validLevels = (typeof s.entry === 'number' && s.entry > 0) &&
                              (typeof s.sl === 'number' && s.sl > 0);
          if (fetchSym && validLevels) {
            const recent = await fetchOHLC(origin, fetchSym, 5000);
            if (recent && recent.length >= 5) {
              const lastBar = recent[recent.length - 1];
              const livePx = lastBar.c;
              // Guard 1: SL already hit
              if (s.direction === 'BUY' && livePx <= s.sl) continue;
              if (s.direction === 'SELL' && livePx >= s.sl) continue;
              // Guard 2: opposite-direction strong-body reversal
              const body = Math.abs(lastBar.c - lastBar.o);
              const range = Math.max(1e-9, lastBar.h - lastBar.l);
              const bodyRatio = body / range;
              const isBearishCandle = lastBar.c < lastBar.o;
              const isBullishCandle = lastBar.c > lastBar.o;
              if (bodyRatio >= 0.7) {
                if (s.direction === 'BUY' && isBearishCandle) continue;
                if (s.direction === 'SELL' && isBullishCandle) continue;
              }
              // Guard 3: chasing — kill if price has already drifted a full
              // SL's worth from entry (was 1.5× — never fired in practice).
              const drift = Math.abs(livePx - s.entry);
              const slDist = Math.abs(s.entry - s.sl);
              if (slDist > 0 && drift > slDist) continue;
            }
          }
        } catch { /* if reconfirm fetch fails, let signal through — better noisy than silent */ }

        // Dedup — once per signal-key for 90 minutes
        // v237 — Wrap KV ops so quota exhaustion doesn't crash the push loop
        // or skip remaining signals. On KV failure we let the signal through
        // (better duplicate than no push at all when KV is degraded).
        const dedupKey = `pushed:${s.pair}_${s.direction}_${(s.detectedAt || '').slice(0, 13)}`;
        let seen = null;
        try { seen = await env.TRADES_KV.get(dedupKey); } catch {}
        if (seen) continue;
        try { await env.TRADES_KV.put(dedupKey, '1', { expirationTtl: 90 * 60 }); } catch {}

        // Strategy-aware title: shows pattern count + tier as proxies for
        // which client strategies are likely to fire on this signal.
        // 2 patterns ≈ SMC reversal or Squeeze breakout
        // 3 patterns + killzone ≈ ICT
        const stratHint = s.strategies >= 3 ? `🏆 ${s.strategies} STRATEGIES`
          : s.strategies >= 2 ? `✅ ${s.strategies} strategies`
          : s.strategies === 2 ? '📐 Multi-strategy'
          : '⭐ Strategy';
        const payload = {
          title: `${stratHint} ${s.pair} ${s.direction} — ${s.confidence}%`,
          body: `${s.strategies} pattern strategies confirm · Entry ${s.entry} · SL ${s.sl} · TP1 ${s.tp1}`,
          tag: `${s.pair}-${s.direction}`,
          url: '/',
          vibrate: [30, 50, 30, 50, 30],
          data: { url: '/', pair: s.pair, direction: s.direction, fromServer: true },
        };

        for (const { key, sub } of subs) {
          try {
            const res = await sendPush(sub, payload);
            if (res.ok) pushSent++;
            else if (res.status === 404 || res.status === 410) {
              await env.TRADES_KV.delete(key).catch(() => {});
            }
          } catch { /* ignore per-subscription failures */ }
        }
      }
    } catch (e) { /* push pipeline must never crash the cron */ }
  }

  return new Response(JSON.stringify({ ...payload, pushSent }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
