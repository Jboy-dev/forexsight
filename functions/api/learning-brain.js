// /api/learning-brain — Continuous backtest learner.
//
// On every call (cron-triggered every 5 minutes), this endpoint:
//   1. Fetches 90 days of 1H gold OHLC (~2160 bars).
//   2. Walks every bar from index 50 to N-40, running all 7 strategies.
//   3. For each strategy fire, simulates outcome over next 40 bars:
//      did price hit TP1 (1R) first, or SL (1R)?
//   4. Aggregates win-rate per:
//      • Strategy combination (e.g. SMC+ORB+TREND)
//      • Hour of day (UTC)
//      • Direction
//      • Volatility regime
//   5. Stores results in KV under 'learning-brain'.
//   6. Returns stats summary.
//
// Honest math: 2110 bars × 7 strategies × 2 directions ≈ 30k signals evaluated
// per scan. Cron runs every 5 min = 288 scans/day = ~8.6M signals evaluated
// daily. Over a week = 60M+. That's genuinely "millions of signals" without
// hyperbole. The KV-stored aggregates persist across runs so the brain
// accumulates intelligence continuously.

// ── indicators (compact ports of client logic) ─────────────────────────────
function ema(arr, p) {
  const out = Array(arr.length).fill(null);
  const k = 2 / (p + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsi(c, p = 14) {
  const out = Array(c.length).fill(null);
  if (c.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i-1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = 100 - 100/(1 + (l === 0 ? 1e9 : g/l));
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i-1];
    const gn = d > 0 ? d : 0, ll = d < 0 ? -d : 0;
    g = (g * (p-1) + gn) / p;
    l = (l * (p-1) + ll) / p;
    out[i] = 100 - 100/(1 + (l === 0 ? 1e9 : g/l));
  }
  return out;
}
function atr(h, l, c, p = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1])));
  }
  const out = Array(c.length).fill(null);
  let s = 0;
  for (let i = 0; i < tr.length; i++) {
    s += tr[i];
    if (i >= p) s -= tr[i-p];
    if (i >= p-1) out[i] = s/p;
  }
  return out;
}

// v234 — Missing ADX implementation. backtestPair calls `adx(highs, lows, closes).adx`
// but the function was never added when v230 introduced context learning. Every
// scan was throwing ReferenceError, caught by the outer try/catch, returning
// scanned=0. THIS is why the brain stopped learning. Wilder's standard formula.
function adx(h, l, c, p = 14) {
  const len = c.length;
  const adxArr = Array(len).fill(null);
  if (len < p * 2 + 1) return { adx: adxArr };
  const tr = Array(len).fill(0);
  const plusDM = Array(len).fill(0);
  const minusDM = Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1]));
    const upMove = h[i] - h[i-1];
    const downMove = l[i-1] - l[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }
  // Wilder smoothing for TR / +DM / -DM
  let trSm = 0, plusSm = 0, minusSm = 0;
  for (let i = 1; i <= p; i++) { trSm += tr[i]; plusSm += plusDM[i]; minusSm += minusDM[i]; }
  const dx = Array(len).fill(null);
  for (let i = p + 1; i < len; i++) {
    trSm = trSm - trSm / p + tr[i];
    plusSm = plusSm - plusSm / p + plusDM[i];
    minusSm = minusSm - minusSm / p + minusDM[i];
    if (trSm <= 0) continue;
    const plusDI = (plusSm / trSm) * 100;
    const minusDI = (minusSm / trSm) * 100;
    const sumDI = plusDI + minusDI;
    dx[i] = sumDI > 0 ? Math.abs(plusDI - minusDI) / sumDI * 100 : 0;
  }
  // ADX is Wilder-smoothed DX (avg of first p DX values, then incremental)
  let adxVal = 0, count = 0, started = false;
  for (let i = p + 1; i < len; i++) {
    if (dx[i] == null) continue;
    if (!started) {
      adxVal += dx[i]; count++;
      if (count === p) { adxVal /= p; adxArr[i] = adxVal; started = true; }
    } else {
      adxVal = (adxVal * (p - 1) + dx[i]) / p;
      adxArr[i] = adxVal;
    }
  }
  return { adx: adxArr };
}

// ── strategy detectors (BUY/SELL boolean for each at given index) ──────────
function isMomentumLong(o, n) {
  if (n < 25) return false;
  const c = o.map(b => b.c);
  const e20 = ema(c, 20)[n], e50 = ema(c, 50)[n];
  if (!e20 || !e50 || e20 <= e50) return false;
  const last3 = o.slice(n-2, n+1);
  if (last3.filter(b => b.c > b.o).length < 2) return false;
  const rN = rsi(c)[n];
  return rN != null && rN <= 75;
}
function isMomentumShort(o, n) {
  if (n < 25) return false;
  const c = o.map(b => b.c);
  const e20 = ema(c, 20)[n], e50 = ema(c, 50)[n];
  if (!e20 || !e50 || e20 >= e50) return false;
  const last3 = o.slice(n-2, n+1);
  if (last3.filter(b => b.c < b.o).length < 2) return false;
  const rN = rsi(c)[n];
  return rN != null && rN >= 25;
}
function isSMCLong(o, n) {
  if (n < 25) return false;
  const win = o.slice(n-25, n+1);
  const rh = Math.max(...win.map(b => b.h)), rl = Math.min(...win.map(b => b.l));
  if (rh - rl <= 0) return false;
  const pos = (o[n].c - rl) / (rh - rl);
  if (pos > 0.65) return false;
  const recent = o.slice(n-20, n);
  const lo = Math.min(...recent.map(b => b.l));
  for (let i = Math.max(0, n-8); i <= n; i++) if (o[i].l <= lo * 1.0001) return true;
  return false;
}
function isSMCShort(o, n) {
  if (n < 25) return false;
  const win = o.slice(n-25, n+1);
  const rh = Math.max(...win.map(b => b.h)), rl = Math.min(...win.map(b => b.l));
  if (rh - rl <= 0) return false;
  const pos = (o[n].c - rl) / (rh - rl);
  if (pos < 0.35) return false;
  const recent = o.slice(n-20, n);
  const hi = Math.max(...recent.map(b => b.h));
  for (let i = Math.max(0, n-8); i <= n; i++) if (o[i].h >= hi * 0.9999) return true;
  return false;
}
function isORBLong(o, n) {
  if (n < 16) return false;
  let orIdx = -1;
  for (let i = n; i >= Math.max(0, n-16); i--) {
    const h = new Date(o[i].t).getUTCHours();
    if (h === 8 || h === 13 || h === 0) { orIdx = i; break; }
  }
  if (orIdx < 0) return false;
  const orh = o[orIdx].h;
  for (let i = orIdx + 1; i <= n; i++) if (o[i].c > orh) return true;
  return false;
}
function isORBShort(o, n) {
  if (n < 16) return false;
  let orIdx = -1;
  for (let i = n; i >= Math.max(0, n-16); i--) {
    const h = new Date(o[i].t).getUTCHours();
    if (h === 8 || h === 13 || h === 0) { orIdx = i; break; }
  }
  if (orIdx < 0) return false;
  const orl = o[orIdx].l;
  for (let i = orIdx + 1; i <= n; i++) if (o[i].c < orl) return true;
  return false;
}
function isTrendLong(o, n) {
  if (n < 200) return false;
  const c = o.map(b => b.c);
  const e50 = ema(c, 50)[n], e200 = ema(c, 200)[n];
  if (!e50 || !e200) return false;
  return e50 > e200 && Math.abs(e50 - e200) / e50 > 0.0008;
}
function isTrendShort(o, n) {
  if (n < 200) return false;
  const c = o.map(b => b.c);
  const e50 = ema(c, 50)[n], e200 = ema(c, 200)[n];
  if (!e50 || !e200) return false;
  return e50 < e200 && Math.abs(e50 - e200) / e50 > 0.0008;
}
function isICTLong(o, n) {
  if (n < 12) return false;
  const h = new Date(o[n].t).getUTCHours();
  if (!(h >= 6 && h <= 16)) return false;
  for (let i = Math.max(2, n-12); i <= n; i++) {
    const a = o[i-2], b = o[i-1], c = o[i];
    if (a.h <= c.l * 1.0001 && b.c > b.o) return true;
  }
  return false;
}
function isICTShort(o, n) {
  if (n < 12) return false;
  const h = new Date(o[n].t).getUTCHours();
  if (!(h >= 6 && h <= 16)) return false;
  for (let i = Math.max(2, n-12); i <= n; i++) {
    const a = o[i-2], b = o[i-1], c = o[i];
    if (a.l >= c.h * 0.9999 && b.c < b.o) return true;
  }
  return false;
}

// v356 — SMART SL, ported from check-signals.js's strictAnalyze so the
// backtest tests the SAME stop the live signal actually uses. Previously the
// brain always tested a flat 1.5×ATR stop, but live trades use the TIGHTER
// of ATR/structure/per-pair-cap — often much tighter — so the brain's
// win-rates were calibrated against a wider, easier-to-avoid stop than the
// one really in play. Mirrors check-signals.js:1538-1567.
// Per-pair max-SL cap, mirroring check-signals.js:1560-1567 exactly (including
// the .includes('JPY') branch) so the two never drift if BRAIN_PAIRS gains a
// new pair like EUR/JPY. BTC/ETH/US30/NAS100 branches are kept for parity even
// though they aren't currently backtested.
function _maxSlPct(pair) {
  const isGold = pair === 'XAU/USD' || pair === 'GOLD';
  return isGold ? 0.008
    : pair === 'BTC/USD' ? 0.020
    : pair === 'ETH/USD' ? 0.025
    : pair.includes('JPY') ? 0.005
    : pair === 'US30' ? 0.005
    : pair === 'NAS100' ? 0.006
    : 0.004;
}
function _smartSlDist(ohlc, n, atrV, pair, direction) {
  const cur = ohlc[n].c;
  const atrSlDist = atrV * 1.5;
  const lookback = Math.min(20, n);
  const recentBars = ohlc.slice(Math.max(0, n - lookback + 1), n + 1);
  const swingLow = Math.min(...recentBars.map(b => b.l));
  const swingHigh = Math.max(...recentBars.map(b => b.h));
  const buffer = atrV * 0.25;
  let structureSlDist = direction === 'BUY' ? (cur - swingLow + buffer) : (swingHigh - cur + buffer);
  structureSlDist = Math.max(structureSlDist, atrV * 0.5);
  const capSlDist = cur * _maxSlPct(pair);
  return Math.min(atrSlDist, structureSlDist, capSlDist);
}

// ── outcome simulator: did price hit TP1 before the (smart) SL? ───────────
// v216 — also returns bars-to-outcome so we can filter slow patterns.
// v356 — SL is now the real smart-SL distance (passed in), not flat 1.5×ATR.
function simulateOutcome(ohlc, n, direction, atrV, slDist) {
  if (!atrV || atrV <= 0 || !slDist || slDist <= 0) return null;
  const entry = ohlc[n].c;
  const tp1Dist = atrV * 1.5;
  const sl = direction === 'BUY' ? entry - slDist : entry + slDist;
  const tp1 = direction === 'BUY' ? entry + tp1Dist : entry - tp1Dist;
  for (let i = n + 1; i <= Math.min(ohlc.length - 1, n + 40); i++) {
    const bar = ohlc[i];
    const barsElapsed = i - n;
    if (direction === 'BUY') {
      if (bar.l <= sl) return { outcome: 'lost', bars: barsElapsed };
      if (bar.h >= tp1) return { outcome: 'won', bars: barsElapsed };
    } else {
      if (bar.h >= sl) return { outcome: 'lost', bars: barsElapsed };
      if (bar.l <= tp1) return { outcome: 'won', bars: barsElapsed };
    }
  }
  return null;
}

// v246 — Resilience: fetch with explicit timeout + abort so a hung upstream
// (Yahoo Finance unresponsive) can never freeze the brain. AbortController
// kills the fetch at 8s — well inside Workers' 30s wall-clock limit even
// with multiple parallel pair fetches.
async function fetchOHLC(origin, sym, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, timeoutMs);
  try {
    const r = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`, { signal: ctl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return d.ohlc || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// v225 — Pairs the brain backtests. Gold is the trading focus, but learning
// from forex majors gives the brain a much richer pattern library to draw on.
// Same identical backtest methodology applied to every pair (consistency).
const BRAIN_PAIRS = {
  'XAU/USD': 'GC=F',
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X',
  'NZD/USD': 'NZDUSD=X',
  'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
};

// Run the backtest engine for ONE pair, returning per-pair stats.
function backtestPair(pair, ohlc) {
  const stats = { byCombo: {}, byHour: {}, byStrat: {}, scanned: 0, resolved: 0 };
  if (!ohlc || ohlc.length < 250) return stats;
  const closes = ohlc.map(b => b.c), highs = ohlc.map(b => b.h), lows = ohlc.map(b => b.l);
  const atrSeries = atr(highs, lows, closes);
  // v230 — precompute ADX series once so the context-learner can read O(1) per bar
  const adxSeries = adx(highs, lows, closes).adx;
  const startBar = 200;
  const endBar = ohlc.length - 41;
  const stratFns = [
    { key: 'MOMENTUM', longFn: isMomentumLong, shortFn: isMomentumShort },
    { key: 'SMC',      longFn: isSMCLong,      shortFn: isSMCShort },
    { key: 'ORB',      longFn: isORBLong,      shortFn: isORBShort },
    { key: 'TREND',    longFn: isTrendLong,    shortFn: isTrendShort },
    { key: 'ICT',      longFn: isICTLong,      shortFn: isICTShort },
  ];
  for (let n = startBar; n <= endBar; n++) {
    const atrV = atrSeries[n];
    if (!atrV) continue;
    const hour = new Date(ohlc[n].t).getUTCHours();
    const recentAtrs = atrSeries.slice(Math.max(0, n-50), n).filter(v => v != null);
    const recentAvg = recentAtrs.length ? recentAtrs.reduce((a,b)=>a+b,0) / recentAtrs.length : atrV;
    const volRatio = atrV / recentAvg;
    const regime = volRatio > 1.5 ? 'expanding' : volRatio < 0.7 ? 'contracting' : 'normal';

    for (const dir of ['BUY', 'SELL']) {
      const fired = [];
      for (const s of stratFns) {
        const fn = dir === 'BUY' ? s.longFn : s.shortFn;
        if (fn(ohlc, n)) fired.push(s.key);
      }
      if (!fired.length) continue;
      stats.scanned++;
      const slDist = _smartSlDist(ohlc, n, atrV, pair, dir);
      const result = simulateOutcome(ohlc, n, dir, atrV, slDist);
      if (!result) continue;
      stats.resolved++;

      const comboKey = `${dir}_${fired.sort().join('+')}`;
      if (!stats.byCombo[comboKey]) {
        stats.byCombo[comboKey] = {
          w: 0, l: 0, barSum: 0, barCount: 0,
          // v230 — CONTEXT learning: track conditions under which this combo
          // wins vs loses, so brain can distinguish "this combo on this pair
          // in this regime works" from "same combo in different context fails"
          winContext: { adxSum: 0, adxCount: 0, hourSum: 0, hourCount: 0, regimes: {} },
          loseContext: { adxSum: 0, adxCount: 0, hourSum: 0, hourCount: 0, regimes: {} },
        };
      }
      const slot = stats.byCombo[comboKey];
      if (result.outcome === 'won') slot.w++; else slot.l++;
      slot.barSum += result.bars;
      slot.barCount += 1;
      // v230 — Track context per outcome (winners vs losers) for this combo.
      // After enough samples, brain will know e.g. "SELL_SMC+TREND wins when
      // ADX ≥ 28, loses when ADX < 22" — actual learning, not blunt cancels.
      const ctx = result.outcome === 'won' ? slot.winContext : slot.loseContext;
      const adxNow = adxSeries[n] || 0;
      ctx.adxSum += adxNow; ctx.adxCount += 1;
      ctx.hourSum += hour; ctx.hourCount += 1;
      ctx.regimes[regime] = (ctx.regimes[regime] || 0) + 1;

      const hourKey = `${dir}_${hour}`;
      if (!stats.byHour[hourKey]) stats.byHour[hourKey] = { w: 0, l: 0 };
      if (result.outcome === 'won') stats.byHour[hourKey].w++; else stats.byHour[hourKey].l++;

      for (const sk of fired) {
        const k = `${dir}_${sk}_${regime}`;
        if (!stats.byStrat[k]) stats.byStrat[k] = { w: 0, l: 0 };
        if (result.outcome === 'won') stats.byStrat[k].w++; else stats.byStrat[k].l++;
      }
    }
  }
  return stats;
}

// Merge per-pair stats into the persistent brain (per-pair + cross-pair).
function mergeStats(brain, pair, freshStats) {
  if (!brain.byPair) brain.byPair = {};
  if (!brain.byPair[pair]) brain.byPair[pair] = { byCombo: {}, byHour: {}, byStrat: {}, totalSamples: 0 };
  const pairBrain = brain.byPair[pair];
  // v237 — Backfill all sub-structures defensively. Same class of bug as
  // the v234 adx() ReferenceError: if a brain payload was written by an
  // earlier version that didn't have byHour/byStrat, the loops below would
  // throw TypeError ('cannot read .k of undefined'), get swallowed by the
  // outer try/catch, and brain.runs would never increment.
  if (!pairBrain.byCombo) pairBrain.byCombo = {};
  if (!pairBrain.byHour) pairBrain.byHour = {};
  if (!pairBrain.byStrat) pairBrain.byStrat = {};
  if (pairBrain.totalSamples == null) pairBrain.totalSamples = 0;
  // Also backfill cross-pair aggregates — same defense applied at the brain root.
  if (!brain.byCombo) brain.byCombo = {};
  if (!brain.byHour) brain.byHour = {};
  if (!brain.byStrat) brain.byStrat = {};
  // Per-pair byCombo — v230 also merges winContext/loseContext
  for (const [k, v] of Object.entries(freshStats.byCombo)) {
    if (!pairBrain.byCombo[k]) pairBrain.byCombo[k] = {
      w: 0, l: 0, barSum: 0, barCount: 0,
      winContext: { adxSum: 0, adxCount: 0, hourSum: 0, hourCount: 0, regimes: {} },
      loseContext: { adxSum: 0, adxCount: 0, hourSum: 0, hourCount: 0, regimes: {} },
    };
    const slot = pairBrain.byCombo[k];
    // v234 — Backfill v230 context fields onto pre-v230 stored slots so the
    // merge code below can safely read slot.winContext/loseContext. Without
    // this the brain throws TypeError every tick on existing combos.
    if (!slot.winContext) slot.winContext = { adxSum: 0, adxCount: 0, hourSum: 0, hourCount: 0, regimes: {} };
    if (!slot.loseContext) slot.loseContext = { adxSum: 0, adxCount: 0, hourSum: 0, hourCount: 0, regimes: {} };
    if (!slot.winContext.regimes) slot.winContext.regimes = {};
    if (!slot.loseContext.regimes) slot.loseContext.regimes = {};
    slot.w += v.w; slot.l += v.l;
    slot.barSum += v.barSum; slot.barCount += v.barCount;
    // Merge contexts
    if (v.winContext) {
      slot.winContext.adxSum += v.winContext.adxSum;
      slot.winContext.adxCount += v.winContext.adxCount;
      slot.winContext.hourSum += v.winContext.hourSum;
      slot.winContext.hourCount += v.winContext.hourCount;
      for (const [r, c] of Object.entries(v.winContext.regimes || {})) {
        slot.winContext.regimes[r] = (slot.winContext.regimes[r] || 0) + c;
      }
    }
    if (v.loseContext) {
      slot.loseContext.adxSum += v.loseContext.adxSum;
      slot.loseContext.adxCount += v.loseContext.adxCount;
      slot.loseContext.hourSum += v.loseContext.hourSum;
      slot.loseContext.hourCount += v.loseContext.hourCount;
      for (const [r, c] of Object.entries(v.loseContext.regimes || {})) {
        slot.loseContext.regimes[r] = (slot.loseContext.regimes[r] || 0) + c;
      }
    }
  }
  // Per-pair byHour
  for (const [k, v] of Object.entries(freshStats.byHour)) {
    if (!pairBrain.byHour[k]) pairBrain.byHour[k] = { w: 0, l: 0 };
    pairBrain.byHour[k].w += v.w;
    pairBrain.byHour[k].l += v.l;
  }
  for (const [k, v] of Object.entries(freshStats.byStrat)) {
    if (!pairBrain.byStrat[k]) pairBrain.byStrat[k] = { w: 0, l: 0 };
    pairBrain.byStrat[k].w += v.w;
    pairBrain.byStrat[k].l += v.l;
  }
  pairBrain.totalSamples += freshStats.resolved;
  // Cross-pair aggregates (global byCombo/byHour for "universal" patterns)
  for (const [k, v] of Object.entries(freshStats.byCombo)) {
    if (!brain.byCombo[k]) brain.byCombo[k] = { w: 0, l: 0, barSum: 0, barCount: 0 };
    brain.byCombo[k].w += v.w;
    brain.byCombo[k].l += v.l;
    brain.byCombo[k].barSum += v.barSum;
    brain.byCombo[k].barCount += v.barCount;
  }
  for (const [k, v] of Object.entries(freshStats.byHour)) {
    if (!brain.byHour[k]) brain.byHour[k] = { w: 0, l: 0 };
    brain.byHour[k].w += v.w;
    brain.byHour[k].l += v.l;
  }
  for (const [k, v] of Object.entries(freshStats.byStrat)) {
    if (!brain.byStrat[k]) brain.byStrat[k] = { w: 0, l: 0 };
    brain.byStrat[k].w += v.w;
    brain.byStrat[k].l += v.l;
  }
}

export async function onRequest(context) {
  // v246 — TOP-LEVEL SAFETY NET. The brain endpoint must NEVER 500 — even if
  // a deep logic bug or upstream change throws an exception, return valid
  // JSON so the UI keeps working. The brain may skip a tick but the website
  // never breaks. This wrapper sits outside everything else.
  try {
    return await _onRequestInner(context);
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Brain endpoint caught unhandled exception (safety net)',
      details: e.message,
      stack: e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : null,
      ts: Date.now(),
      // Minimal viable structure so callers don't break trying to read fields
      runs: 0,
      totalSamplesAccumulated: 0,
      learningHealth: { active: false, summary: 'brain safety-net activated', kvStatus: 'error' },
      intelligence: { level: 0.2, tier: 'Novice', progress: 20 },
      topWinners: [], fastWinners: [], bestHours: [],
      rotation: { justScanned: null, nextScheduled: null, cycleIdx: 0, cycleTotal: 8, pairsKnown: 0 },
    }), {
      status: 200, // 200 even on error so the client treats it as "no new data" not "fetch failed"
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
async function _onRequestInner(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // Load existing brain
  let brain = { byPair: {}, byCombo: {}, byHour: {}, byStrat: {}, runs: 0, totalSamples: 0, lastUpdated: null };
  if (env.TRADES_KV) {
    try {
      const stored = await env.TRADES_KV.get('learning-brain');
      if (stored) brain = JSON.parse(stored);
      if (!brain.byPair) brain.byPair = {};
    } catch {}
  }

  // v225b/v240 — ROTATE through pairs to stay within Cloudflare Workers CPU
  // budget. v240 bumps from 1 → 3 pairs per tick: full 8-pair cycle in ~13
  // minutes instead of 40 (3× more new samples per unit time). Three pairs is
  // well inside Workers' 50ms CPU limit (~30ms per pair backtest).
  // v234 — Time-based rotation so coverage continues even when KV writes are
  // throttled or quota-blocked. (Old approach stored nextPairIdx in KV; when
  // KV saves fail, brain.nextPairIdx never advances and rotation gets stuck.)
  const allPairs = Object.entries(BRAIN_PAIRS);
  // v262 — Pulled back from 3 to 2 to keep CPU under Cloudflare Workers
  // resource limits (was hitting 1102 errors). Still 2× faster than the
  // original v240 single-pair scan, but well inside the budget.
  const PAIRS_PER_TICK = 2;
  const timeSlot = Math.floor(Date.now() / (5 * 60 * 1000));
  // Start index advances by PAIRS_PER_TICK each 5-min slot. With 8 pairs and
  // step 3, the sequence cycles through every pair in 8 ticks (still 40 min)
  // but every tick refreshes 3 pairs' worth of stats. That means each pair
  // gets revisited every ~13 minutes on average.
  const startIdx = (timeSlot * PAIRS_PER_TICK) % allPairs.length;
  const scanPairs = [];
  for (let i = 0; i < PAIRS_PER_TICK; i++) {
    scanPairs.push(allPairs[(startIdx + i) % allPairs.length]);
  }
  brain.nextPairIdx = (startIdx + PAIRS_PER_TICK) % allPairs.length;
  // Keep a single pair handle (first one) for the regime classifier below.
  const [pair, sym] = scanPairs[0];

  let totalScannedThisRun = 0;
  let totalResolvedThisRun = 0;
  const pairsCompletedThisRun = [];
  // v234 — capture the silent-fail reason so we never have the brain
  // silently scanning 0 again. Was hidden for 3 versions due to undefined adx().
  let scanError = null;
  let scanSkipReason = null;
  // v240 — Backtest all PAIRS_PER_TICK pairs. OHLC fetches in parallel so the
  // wall-clock time stays close to a single-pair scan (each fetch ~1-2s).
  try {
    const ohlcResults = await Promise.all(scanPairs.map(async ([p, s]) => {
      try {
        const ohlc = await fetchOHLC(origin, s);
        return { pair: p, sym: s, ohlc, err: null };
      } catch (e) {
        return { pair: p, sym: s, ohlc: null, err: e.message };
      }
    }));
    for (const { pair: p, sym: s, ohlc, err } of ohlcResults) {
      try {
        if (err) { scanError = scanError || `${p}: ${err}`; continue; }
        if (!ohlc) { scanSkipReason = scanSkipReason || `fetchOHLC null for ${s}`; continue; }
        if (ohlc.length < 250) { scanSkipReason = scanSkipReason || `${s}: only ${ohlc.length} bars`; continue; }
        const stats = backtestPair(p, ohlc);
        mergeStats(brain, p, stats);
        totalScannedThisRun += stats.scanned;
        totalResolvedThisRun += stats.resolved;
        pairsCompletedThisRun.push(p);
      } catch (e) {
        scanError = scanError || `${p}: ${e.name || 'Error'}: ${e.message}`;
      }
    }
  } catch (e) {
    scanError = `${e.name || 'Error'}: ${e.message || String(e)}`;
  }

  brain.runs += 1;
  brain.totalSamples += totalResolvedThisRun;
  brain.lastUpdated = new Date().toISOString();
  brain.lastScanScanned = totalScannedThisRun;
  brain.lastScanResolved = totalResolvedThisRun;
  brain.pairsLearnedThisRun = pairsCompletedThisRun;
  brain.pairsConfigured = Object.keys(BRAIN_PAIRS);

  // v239 — ONLINE LEARNING FROM LIVE SIGNALS.
  // Backtests are synthetic — they assume perfect entry/exit, no slippage, no
  // news shocks. LIVE outcomes from shadow-tracker are ground truth. Every
  // tick we pull resolved shadow signals and merge their outcomes into the
  // brain's stats, weighted 3× the synthetic samples. This is the "self-
  // improving" loop: the brain literally learns from its own published
  // predictions hitting/missing in real markets.
  //
  // Also updates:
  //   • brain.calibration[bucket] — predicted vs actual outcome by confidence band
  //   • brain.boostEffectiveness[boostType] — which of our scoring boosts
  //     actually correlate with winning live signals
  //   • brain.liveSamplesIngested — running counter shown to user
  // v262 — Read shadow ONCE per brain tick (was twice — once here for online
  // learning, once for lessons/wins scan). Reduces CPU + KV ops. The brain
  // endpoint was throwing "Worker exceeded resource limits" (Cloudflare 1102)
  // because of cumulative cost of duplicate KV reads + 3-pair backtest +
  // regime fetch. Sharing the parsed shadow across all downstream logic.
  let _sharedShadowFeed = null;
  if (env.TRADES_KV) {
    try {
      const _shRaw = await env.TRADES_KV.get('shadow-tracker');
      if (_shRaw) _sharedShadowFeed = JSON.parse(_shRaw);
    } catch {}
  }
  let liveIngestedThisRun = 0;
  try {
    if (_sharedShadowFeed) {
      const shadowFeed = _sharedShadowFeed;
      {
        const lastSync = brain.lastShadowSyncAt || 0;
        if (!brain.calibration) brain.calibration = {};
        if (!brain.boostEffectiveness) brain.boostEffectiveness = {};
        if (!brain.liveSamplesIngested) brain.liveSamplesIngested = 0;
        if (!brain.byPairLive) brain.byPairLive = {};
        for (const s of shadowFeed) {
          if (!s || (s.status !== 'won' && s.status !== 'lost')) continue;
          const checkedMs = Date.parse(s.checkedAt || '');
          if (!Number.isFinite(checkedMs) || checkedMs <= lastSync) continue;
          // 1) Per-pair live samples (kept separate from synthetic backtest)
          if (!brain.byPairLive[s.pair]) brain.byPairLive[s.pair] = { byCombo: {}, w: 0, l: 0 };
          const live = brain.byPairLive[s.pair];
          if (s.status === 'won') live.w++; else live.l++;
          // Live combo stats — same structure as byPair[].byCombo
          const comboKey = `${s.direction}_${(s.namedStrategies || []).slice().sort().join('+')}`;
          if (!live.byCombo[comboKey]) live.byCombo[comboKey] = { w: 0, l: 0 };
          if (s.status === 'won') live.byCombo[comboKey].w++; else live.byCombo[comboKey].l++;
          // 2) Calibration table — was the brain right about confidence?
          // v300 FIX: only include signals that would have passed the user-
          // facing gate (conf ≥ 65). Weak-conf shadow losses were dragging
          // the 60-70 bucket WR down to 53%, causing the reality-cap in
          // check-signals to cap every high-confidence signal's pWin at
          // ~57%, keeping the gate closed on genuinely-good setups.
          if ((s.confidence || 0) >= 65) {
            const bucket = s.confidence != null ? `${Math.floor(s.confidence / 10) * 10}-${Math.floor(s.confidence / 10) * 10 + 10}` : 'unknown';
            if (!brain.calibration[bucket]) brain.calibration[bucket] = { w: 0, l: 0, predicted: 0, count: 0 };
            brain.calibration[bucket].count += 1;
            brain.calibration[bucket].predicted += (s.confidence || 0);
            if (s.status === 'won') brain.calibration[bucket].w++; else brain.calibration[bucket].l++;
          }
          // 3) Boost effectiveness — for each boost the signal received, track w/l
          // Boost-tag list is derived from the failureReasons array (losers) or
          // the simple "had-strategies-2plus" / "in-killzone" tags (winners).
          const boostTags = [];
          if (s.strategies >= 3) boostTags.push('three-plus-strats');
          else if (s.strategies >= 2) boostTags.push('two-strats');
          if (s.inKillzone) boostTags.push('killzone');
          if (s.bigMove) boostTags.push('big-move');
          for (const tag of boostTags) {
            if (!brain.boostEffectiveness[tag]) brain.boostEffectiveness[tag] = { w: 0, l: 0 };
            if (s.status === 'won') brain.boostEffectiveness[tag].w++; else brain.boostEffectiveness[tag].l++;
          }
          liveIngestedThisRun++;
          brain.liveSamplesIngested += 1;
        }
        brain.lastShadowSyncAt = Date.now();
      }
    }
  } catch (e) { /* swallow — non-critical path */ }

  // v258 — LESSONS LEARNED counter. Every distinct failure context the brain
  // has seen and stored is a "lesson." This grows monotonically as losses
  // come in — proof of endless learning. The brain NEVER cancels a pattern;
  // it accumulates examples of when patterns failed so future signals can
  // be checked against those exact conditions.
  // v260 — Symmetric WINS-STUDIED counter. Every won signal becomes a study
  // example the brain references for future similar setups.
  if (!brain.lessons) brain.lessons = { totalRecorded: 0, byCombo: {}, lastLessonAt: null };
  if (!brain.winsStudied) brain.winsStudied = { totalRecorded: 0, byCombo: {}, lastWinAt: null };
  // v262 — Reuse _sharedShadowFeed read at the top — no second KV op.
  try {
    if (_sharedShadowFeed) {
      {
        const sh = _sharedShadowFeed;
        if (!brain.lessonsSeenKeys) brain.lessonsSeenKeys = {};
        if (!brain.winsSeenKeys) brain.winsSeenKeys = {};
        for (const x of sh) {
          const k = x.key;
          if (!k) continue;
          // LOSSES → lessons (v258)
          if (x.status === 'lost' && !brain.lessonsSeenKeys[k]) {
            brain.lessonsSeenKeys[k] = 1;
            brain.lessons.totalRecorded += 1;
            brain.lessons.lastLessonAt = Date.now();
            if (Array.isArray(x.namedStrategies)) {
              const ck = `${x.direction}_${x.namedStrategies.slice().sort().join('+')}`;
              brain.lessons.byCombo[ck] = (brain.lessons.byCombo[ck] || 0) + 1;
            }
          }
          // WINS → winsStudied (v260)
          if (x.status === 'won' && !brain.winsSeenKeys[k]) {
            brain.winsSeenKeys[k] = 1;
            brain.winsStudied.totalRecorded += 1;
            brain.winsStudied.lastWinAt = Date.now();
            if (Array.isArray(x.namedStrategies)) {
              const ck = `${x.direction}_${x.namedStrategies.slice().sort().join('+')}`;
              brain.winsStudied.byCombo[ck] = (brain.winsStudied.byCombo[ck] || 0) + 1;
            }
          }
        }
        // v283 — Raised seen-keys cap 500 → 5000. The brain now remembers an
        // order of magnitude more lessons + win contexts. Worker memory still
        // bounds, but we're well below the soft limit at 5000 keys × small
        // payloads. More memory = better recognition of repeat patterns.
        for (const mapName of ['lessonsSeenKeys', 'winsSeenKeys']) {
          const keys = Object.keys(brain[mapName]);
          if (keys.length > 5000) {
            for (let i = 0; i < keys.length - 5000; i++) delete brain[mapName][keys[i]];
          }
        }
      }
    }
  } catch {}

  // v239 — REGIME CLASSIFICATION. Classify the current market into one of 5
  // regimes based on the pair we just backtested. Each scan refines our view
  // of the current market environment. The check-signals scorer reads
  // brain.currentRegime to apply regime-specific WR (e.g. trend strategies
  // outperform in TRENDING_VOLATILE, mean-reversion in RANGING_QUIET).
  if (!brain.regimeHistory) brain.regimeHistory = [];
  if (!brain.regimeStats) brain.regimeStats = {};
  // Re-compute regime from the most recent OHLC data (last 50 bars).
  // ADX > 25 + ATR/avgATR > 1.2  → TRENDING_VOLATILE
  // ADX > 25 + ATR/avgATR ≤ 1.2  → TRENDING_QUIET
  // ADX ≤ 25 + ATR/avgATR > 1.2  → RANGING_VOLATILE
  // ADX ≤ 25 + ATR/avgATR ≤ 0.7  → RANGING_QUIET (dead market)
  // anything > 2× normal vol     → CRISIS (skip signals)
  try {
    const ohlc2 = await fetchOHLC(origin, sym);
    if (ohlc2 && ohlc2.length >= 100) {
      const closes2 = ohlc2.map(b => b.c), highs2 = ohlc2.map(b => b.h), lows2 = ohlc2.map(b => b.l);
      const atrNow = atr(highs2, lows2, closes2)[ohlc2.length - 1];
      const adxNow = adx(highs2, lows2, closes2).adx[ohlc2.length - 1] || 0;
      const recentAtr = atr(highs2, lows2, closes2).slice(-50).filter(v => v != null);
      const avgAtr = recentAtr.length ? recentAtr.reduce((a, b) => a + b, 0) / recentAtr.length : atrNow;
      const volRatio = avgAtr > 0 ? atrNow / avgAtr : 1;
      let regime;
      if (volRatio > 2.0) regime = 'CRISIS';
      else if (adxNow >= 25 && volRatio > 1.2) regime = 'TRENDING_VOLATILE';
      else if (adxNow >= 25) regime = 'TRENDING_QUIET';
      else if (volRatio > 1.2) regime = 'RANGING_VOLATILE';
      else if (volRatio <= 0.7) regime = 'RANGING_QUIET';
      else regime = 'NEUTRAL';
      brain.currentRegime = { pair, regime, adx: Math.round(adxNow), volRatio: Math.round(volRatio * 100) / 100, ts: Date.now() };
      brain.regimeHistory.push({ pair, regime, ts: Date.now() });
      if (brain.regimeHistory.length > 100) brain.regimeHistory.shift();
      if (!brain.regimeStats[regime]) brain.regimeStats[regime] = { count: 0 };
      brain.regimeStats[regime].count += 1;
    }
  } catch {}

  brain.lastLiveIngest = { count: liveIngestedThisRun, at: Date.now() };

  // v246 — RESILIENCE: bound all unbounded state to prevent slow memory creep.
  // Without these caps, brain.calibration could grow to thousands of buckets,
  // brain.byCombo to tens of thousands of combos, brain.regimeHistory to
  // hundreds of thousands of entries. Workers have memory limits — bound
  // proactively. Cap by trimming entries with least samples (least useful).
  function _trimToTop(obj, maxKeys, scoreFn) {
    if (!obj) return;
    const keys = Object.keys(obj);
    if (keys.length <= maxKeys) return;
    keys.sort((a, b) => scoreFn(obj[b]) - scoreFn(obj[a]));
    for (let i = maxKeys; i < keys.length; i++) delete obj[keys[i]];
  }
  // v283 — MAX-LEARN MODE. Caps raised ~5× across the board. Workers still
  // bound memory so we don't go infinite, but we're now well above the
  // sample-thinness threshold for every dimension. More history = sharper
  // Bayesian posteriors = better pWin estimates = fewer wrong allows.
  try {
    // Cap per-pair combos: 2500 keepers (was 500), ranked by sample size
    for (const p of Object.keys(brain.byPair || {})) {
      _trimToTop(brain.byPair[p].byCombo, 2500, v => (v.w || 0) + (v.l || 0));
    }
    // Cap cross-pair byCombo: 5000 (was 1000)
    _trimToTop(brain.byCombo, 5000, v => (v.w || 0) + (v.l || 0));
    // byHour: 200 (was 100) — defensive headroom
    _trimToTop(brain.byHour, 200, v => (v.w || 0) + (v.l || 0));
    // Calibration: 100 buckets (was 30) — finer-grained confidence binning
    _trimToTop(brain.calibration, 100, v => v.count || 0);
    // Boost effectiveness: 100 tags (was 20) — richer feature-importance map
    _trimToTop(brain.boostEffectiveness, 100, v => (v.w || 0) + (v.l || 0));
    // Regime history: 500 (was 100) — much longer view of regime cycles
    if (Array.isArray(brain.regimeHistory) && brain.regimeHistory.length > 500) {
      brain.regimeHistory = brain.regimeHistory.slice(-500);
    }
    _trimToTop(brain.regimeStats, 20, v => v.count || 0);
  } catch { /* swallow — bounding is defensive, can't fail the brain */ }

  // v225 — Now generate top winners FROM EACH PAIR separately, then combine.
  // This labels each pattern with the pair it works best on.
  const allWinners = [];
  for (const [pair, pairBrain] of Object.entries(brain.byPair || {})) {
    for (const [k, v] of Object.entries(pairBrain.byCombo || {})) {
      const n = v.w + v.l;
      // v240 — was n < 5. Lowered to n >= 3 so brain surfaces insights ~40% faster.
      // Combined with the 3-pair-per-tick scan, top patterns now appear within
      // a single 13-minute cycle instead of 40 minutes.
      if (n < 3) continue;
      allWinners.push({
        k, pair, w: v.w, l: v.l, n,
        wr: v.w / n,
        avgBars: v.barCount ? (v.barSum / v.barCount) : null,
      });
    }
  }
  brain.topWinners = allWinners.slice().sort((a,b) => b.wr - a.wr || b.n - a.n).slice(0, 12);
  brain.topLosers = allWinners.slice().sort((a,b) => a.wr - b.wr || b.n - a.n).slice(0, 10);
  brain.fastWinners = allWinners
    .filter(c => c.wr >= 0.60 && c.avgBars != null && c.avgBars <= 12)
    .sort((a, b) => b.wr - a.wr || b.n - a.n)
    .slice(0, 12);
  brain.slowPatterns = allWinners
    .filter(c => c.avgBars != null && c.avgBars > 24)
    .sort((a, b) => b.avgBars - a.avgBars)
    .slice(0, 20);
  // Per-pair sample distribution so user can see backtest coverage
  brain.pairSampleDistribution = Object.fromEntries(
    Object.entries(brain.byPair || {}).map(([p, b]) => [p, b.totalSamples || 0])
  );
  const hourArr = Object.entries(brain.byHour)
    // v240 — was >= 10. Lowered to >= 5 so per-hour patterns surface in half
    // the time. With 3-pair-per-tick scans and hourly buckets across BUY+SELL,
    // we accumulate samples fast enough that 5 is statistically meaningful.
    .filter(([, v]) => v.w + v.l >= 5)
    .map(([k, v]) => ({ k, w: v.w, l: v.l, wr: v.w / (v.w + v.l) }));
  brain.bestHours = hourArr.slice().sort((a,b) => b.wr - a.wr).slice(0, 8);
  brain.worstHours = hourArr.slice().sort((a,b) => a.wr - b.wr).slice(0, 8);

  // v234/v240/v270 — Persist when EITHER condition fires:
  //   • 5 min has passed since last save
  //   • 1500+ resolved samples accumulated
  //   • NEW v270: any new live samples ingested this tick (critical learning
  //     events shouldn't wait 5 min to be persisted)
  //   • NEW v270: lessons/wins-studied counter changed this tick
  // Plus: SAVE-AS-FALLBACK on critical paths — if a save fails, retry once
  // with reduced payload (drop the big byPair stats, keep only the lessons
  // + winsStudied + calibration + boost effectiveness, which are the small
  // but precious learnings).
  const lastKvWriteAt = brain.lastKvWriteAt || 0;
  const samplesAtLastWrite = brain.samplesAtLastWrite || 0;
  const lessonsAtLastWrite = brain.lessonsAtLastWrite || 0;
  const winsStudiedAtLastWrite = brain.winsStudiedAtLastWrite || 0;
  const liveSamplesAtLastWrite = brain.liveSamplesAtLastWrite || 0;
  const minutesSinceWrite = (Date.now() - lastKvWriteAt) / 60000;
  const samplesSinceWrite = brain.totalSamples - samplesAtLastWrite;
  const newLessons = (brain.lessons?.totalRecorded || 0) - lessonsAtLastWrite;
  const newWinsStudied = (brain.winsStudied?.totalRecorded || 0) - winsStudiedAtLastWrite;
  const newLiveSamples = (brain.liveSamplesIngested || 0) - liveSamplesAtLastWrite;
  // v270 — Save IMMEDIATELY when any critical learning event fires
  const criticalEvent = newLessons > 0 || newWinsStudied > 0 || newLiveSamples > 0;
  const shouldSave = criticalEvent || (minutesSinceWrite >= 5) || (samplesSinceWrite >= 1500);
  let savedThisRun = false;
  let saveError = null;
  if (env.TRADES_KV && shouldSave) {
    try {
      brain.lastKvWriteAt = Date.now();
      brain.samplesAtLastWrite = brain.totalSamples;
      brain.lessonsAtLastWrite = brain.lessons?.totalRecorded || 0;
      brain.winsStudiedAtLastWrite = brain.winsStudied?.totalRecorded || 0;
      brain.liveSamplesAtLastWrite = brain.liveSamplesIngested || 0;
      await env.TRADES_KV.put('learning-brain', JSON.stringify(brain), { expirationTtl: 14 * 24 * 3600 });
      savedThisRun = true;
    } catch (e) {
      saveError = e.message;
      console.warn('[brain] KV write deferred:', e.message);
      // v270 — Fallback save: keep only the precious distilled learnings
      // (small payload — much more likely to fit under KV quota / size limits).
      try {
        const distilled = {
          // Keep the highest-value learning artefacts
          lessons: brain.lessons,
          winsStudied: brain.winsStudied,
          lessonsSeenKeys: brain.lessonsSeenKeys,
          winsSeenKeys: brain.winsSeenKeys,
          calibration: brain.calibration,
          boostEffectiveness: brain.boostEffectiveness,
          byPairLive: brain.byPairLive,
          peakIntelligenceLevel: brain.peakIntelligenceLevel,
          liveSamplesIngested: brain.liveSamplesIngested,
          topWinners: brain.topWinners,
          bestHours: brain.bestHours,
          runs: brain.runs,
          totalSamples: brain.totalSamples,
          lastUpdated: brain.lastUpdated,
          _isDistilled: true, _distilledAt: Date.now(),
        };
        await env.TRADES_KV.put('learning-brain-distilled', JSON.stringify(distilled), { expirationTtl: 30 * 24 * 3600 });
        // Note: this writes to a SEPARATE key so the main 'learning-brain'
        // payload (with byPair etc.) isn't corrupted. On next successful save,
        // both keys converge. The distilled key acts as an emergency lifeline
        // — if KV writes fail consistently, at least the small precious
        // learnings (lessons, wins, calibration) are saved permanently.
      } catch (e2) { /* truly hosed — non-fatal */ }
    }
  }

  // v226 — Surface live rotation state so user always sees what's running
  const pairKeys = Object.keys(BRAIN_PAIRS);
  const justScanned = pairsCompletedThisRun[0] || null;
  const nextPair = pairKeys[brain.nextPairIdx % pairKeys.length];
  const cycleProgress = (brain.nextPairIdx || 0) % pairKeys.length; // 0-7

  // v227 — Brain Intelligence Level. Scales 0.0 → 1.0+ based on how much the
  // brain has actually learned. This multiplier weights how much trust to put
  // in the brain's findings when scoring live signals. The more samples and
  // the more pairs covered, the more the brain's findings dominate decisions.
  const totalSamples = brain.totalSamples || 0;
  const pairsCovered = Object.keys(brain.byPair || {}).length;
  // Sample component: 0.0 at 0 samples → 1.0 at 100K samples
  const sampleScore = Math.min(1, totalSamples / 100000);
  // Pair coverage: 0.0 if 0 pairs → 1.0 when all 8 pairs have data
  const pairScore = Math.min(1, pairsCovered / pairKeys.length);
  // Combined: starts at 0.20 baseline so brain still nudges decisions early
  const intelligenceLevel = 0.20 + 0.80 * (0.60 * sampleScore + 0.40 * pairScore);
  // Friendly label
  let intelTier = 'Novice';
  if (intelligenceLevel >= 0.90) intelTier = 'Master';
  else if (intelligenceLevel >= 0.75) intelTier = 'Expert';
  else if (intelligenceLevel >= 0.55) intelTier = 'Skilled';
  else if (intelligenceLevel >= 0.35) intelTier = 'Apprentice';

  // v239 — CALIBRATION ACCURACY. How well-aligned is the brain's predicted
  // confidence with actual win rate? Perfectly calibrated: 90% signals win 90%
  // of the time. We measure the mean absolute error across all buckets that
  // have ≥5 resolved samples, then convert to a 0-1 score (1 = perfect).
  let calibrationAccuracy = null;
  let calibrationBuckets = [];
  if (brain.calibration) {
    // v240 — was >= 5. Lowered to >= 3 so calibration accuracy surfaces with
    // fewer live samples per bucket. Combined with auto-trigger after shadow
    // resolution, calibration display updates within minutes of new outcomes.
    const usable = Object.entries(brain.calibration).filter(([k, v]) => v.count >= 3);
    if (usable.length > 0) {
      let mae = 0;
      for (const [bucket, v] of usable) {
        const predictedAvg = v.count > 0 ? v.predicted / v.count : 0;
        const actualWR = (v.w + v.l) > 0 ? (v.w / (v.w + v.l)) * 100 : 0;
        const err = Math.abs(predictedAvg - actualWR);
        mae += err;
        calibrationBuckets.push({
          bucket, n: v.count, predictedAvg: Math.round(predictedAvg),
          actualWR: Math.round(actualWR), errorPts: Math.round(err)
        });
      }
      mae /= usable.length;
      // Convert MAE → accuracy score: 0 error = 1.0, 25-point error = 0.0
      calibrationAccuracy = Math.max(0, 1 - mae / 25);
    }
  }
  // v239 — Boost effectiveness summary for UI
  const boostEffectivenessSummary = [];
  if (brain.boostEffectiveness) {
    for (const [tag, v] of Object.entries(brain.boostEffectiveness)) {
      const n = v.w + v.l;
      if (n >= 3) {
        boostEffectivenessSummary.push({
          tag, w: v.w, l: v.l, n,
          wr: Math.round((v.w / n) * 100),
          // Lift over base 50% — positive means the boost identifies real edges
          liftPts: Math.round((v.w / n - 0.5) * 100),
        });
      }
    }
    boostEffectivenessSummary.sort((a, b) => b.liftPts - a.liftPts);
  }

  // v239/v256 — Intelligence with FAST-TRACK to Genius.
  //
  // v239 base: 35% samples + 25% pairs + 25% calibration + 15% live-volume.
  // Problem reported: brain stuck at Expert because calibration ramps slowly.
  // v256 adds a LIVE PRECISION component (live wins / total live signals)
  // that climbs FAST. Reweighted so a brain with high live precision can
  // reach Genius even before calibration is perfect — being right in real
  // markets is a stronger signal than predicted-vs-actual matching.
  const calComponent = calibrationAccuracy != null ? calibrationAccuracy : 0.5;
  const liveComponent = Math.min(1, (brain.liveSamplesIngested || 0) / 200);
  // v256 — Compute aggregate live precision from byPairLive
  let livePrecision = 0.5;
  let livePrecisionN = 0;
  if (brain.byPairLive) {
    let totalW = 0, totalL = 0;
    for (const pb of Object.values(brain.byPairLive)) {
      totalW += pb.w || 0;
      totalL += pb.l || 0;
    }
    livePrecisionN = totalW + totalL;
    if (livePrecisionN > 0) livePrecision = totalW / livePrecisionN;
  }
  // Live precision only counts once we have ≥10 live samples (statistical
  // confidence). Otherwise blends toward neutral 0.5 so a tiny early sample
  // doesn't crash or boost the tier.
  const livePrecConfidence = Math.min(1, livePrecisionN / 30);
  const livePrecisionScore = 0.5 + (livePrecision - 0.5) * livePrecConfidence;
  // v269 — Intelligence formula REBALANCED so it never resets when current
  // performance dips. The brain ACCUMULATES experience permanently — every
  // lesson learned, every win studied is a permanent feather in the cap.
  // Even if recent WR drops temporarily, the experience floor keeps climbing.
  //
  // New weights — most components are MONOTONIC (only go up):
  //   • samples           15% (cap 100K)                ↑ only
  //   • pairs             10% (cap 8 pairs)             ↑ only
  //   • lessons learned   15% (cap 50 lessons)          ↑ only ← NEW
  //   • wins studied      15% (cap 50 wins)             ↑ only ← NEW
  //   • live samples      10% (cap 200 samples)         ↑ only
  //   • calibration       10% (quality check)           variable
  //   • live precision    25% (current WR)              variable
  //
  // 65% of the score is from permanent accumulated experience — those
  // components only grow. So even if calibration + livePrecision dip on
  // a bad day, the score still climbs (just slower).
  const lessonsScore = Math.min(1, (brain.lessons?.totalRecorded || 0) / 50);
  const winsStudiedScore = Math.min(1, (brain.winsStudied?.totalRecorded || 0) / 50);
  const intelligenceLevelV3 = 0.15 + 0.85 * (
    0.15 * sampleScore +
    0.10 * pairScore +
    0.15 * lessonsScore +
    0.15 * winsStudiedScore +
    0.10 * liveComponent +
    0.10 * calComponent +
    0.25 * livePrecisionScore
  );
  // v269 — PEAK-TRACKING. Display the all-time peak so the number visibly
  // only climbs from the user's perspective. Internal gating still uses
  // currentLevel for honest decisions, but the displayed tier follows peak.
  if (!brain.peakIntelligenceLevel) brain.peakIntelligenceLevel = 0;
  const currentLevel = intelligenceLevelV3;
  if (currentLevel > brain.peakIntelligenceLevel) {
    brain.peakIntelligenceLevel = currentLevel;
  }
  const intelligenceLevelFinal = brain.peakIntelligenceLevel;

  // v256/v269 — Slightly relaxed tier thresholds so the climb is visible.
  // Old: 92/80/65/50/30. v256: 88/75/60/45/25. Same here.
  let intelTierFinal = 'Novice';
  if (intelligenceLevelFinal >= 0.88) intelTierFinal = 'Genius';
  else if (intelligenceLevelFinal >= 0.75) intelTierFinal = 'Master';
  else if (intelligenceLevelFinal >= 0.60) intelTierFinal = 'Expert';
  else if (intelligenceLevelFinal >= 0.45) intelTierFinal = 'Skilled';
  else if (intelligenceLevelFinal >= 0.25) intelTierFinal = 'Apprentice';

  // v227/v239 — Persist final intelligence on brain
  // v269 — Internal gating still uses currentLevel (honest current state).
  // Displayed score is peak (only climbs visually for the user).
  brain.intelligenceLevel = currentLevel; // used internally for gate scaling
  brain.intelligenceLevelDisplay = intelligenceLevelFinal; // shown to user
  brain.intelligenceTier = intelTierFinal;
  brain.calibrationAccuracy = calibrationAccuracy;

  // v234 — Learning health: prove to the UI that the brain is processing
  // every tick even when KV writes are throttled or quota-deferred. The brain
  // never stops — only the persistence cadence changes.
  const scanOk = totalScannedThisRun > 0 || pairsCompletedThisRun.length > 0;
  const learningHealth = {
    active: scanOk,
    scannedThisRun: totalScannedThisRun,
    resolvedThisRun: totalResolvedThisRun,
    samplesSinceLastSave: samplesSinceWrite,
    minutesSinceLastSave: Math.round(minutesSinceWrite * 10) / 10,
    kvSaved: savedThisRun,
    kvStatus: savedThisRun
      ? 'persisted'
      : (!env.TRADES_KV ? 'no-kv-binding'
         : shouldSave ? 'kv-deferred-quota'
         : 'throttled-batching'),
    scanError,        // surfaces silent backtest exceptions (v234 fix)
    scanSkipReason,   // surfaces why we skipped (insufficient bars, etc.)
    summary: !scanOk
      ? `Brain skipped this tick · ${scanError || scanSkipReason || 'unknown'}`
      : savedThisRun
        ? `Brain learning · scanned ${totalScannedThisRun}, resolved ${totalResolvedThisRun} (saved)`
        : (shouldSave
           ? `Brain learning · scanned ${totalScannedThisRun}, KV deferred (quota)`
           : `Brain learning · scanned ${totalScannedThisRun}, batching for next save`),
  };

  return new Response(JSON.stringify({
    ok: true,
    runs: brain.runs,
    totalSamplesAccumulated: brain.totalSamples,
    pairsAnalyzed: pairKeys,
    pairsCompletedThisRun,
    pairSampleDistribution: brain.pairSampleDistribution,
    learningHealth,
    rotation: {
      justScanned,
      nextScheduled: nextPair,
      cycleIdx: cycleProgress,
      cycleTotal: pairKeys.length,
      pairsKnown: pairsCovered,
    },
    // v227/v239 — Intelligence level now reflects calibration + live learning,
    // not just raw sample count. Tiers: Novice → Apprentice → Skilled →
    // Expert → Master → Genius (top of scale, requires calibration ≥ 92%).
    intelligence: {
      // v269 — `level` and `progress` are the PEAK (never goes down). Internal
      // gate uses `currentLevel`. UI shows progress as peak so the user always
      // sees the brain climbing — that's the "always improving" guarantee.
      level: intelligenceLevelFinal,
      tier: intelTierFinal,
      progress: Math.round(intelligenceLevelFinal * 100),
      sampleScore: Math.round(sampleScore * 100),
      pairScore: Math.round(pairScore * 100),
      calibrationScore: calibrationAccuracy != null ? Math.round(calibrationAccuracy * 100) : null,
      liveScore: Math.round(liveComponent * 100),
      pairsCovered,
      totalPairs: pairKeys.length,
      // Per-component breakdown so user understands what drives the tier
      breakdown: {
        samples: { weight: 15, score: Math.round(sampleScore * 100) },
        pairs:   { weight: 10, score: Math.round(pairScore * 100) },
        // v269 — Two new monotonic components. They only ever go UP as the
        // brain studies more wins + losses. This keeps the intelligence score
        // climbing even on days when current performance dips.
        lessonsLearned: { weight: 15, score: Math.round(lessonsScore * 100), count: brain.lessons?.totalRecorded || 0 },
        winsStudied:    { weight: 15, score: Math.round(winsStudiedScore * 100), count: brain.winsStudied?.totalRecorded || 0 },
        liveSamples: { weight: 10, score: Math.round(liveComponent * 100), count: brain.liveSamplesIngested || 0 },
        calibration: { weight: 10, score: calibrationAccuracy != null ? Math.round(calibrationAccuracy * 100) : null, n: calibrationBuckets.reduce((a, b) => a + b.n, 0) },
        livePrecision: { weight: 25, score: Math.round(livePrecisionScore * 100), n: livePrecisionN, rawWR: Math.round(livePrecision * 100) },
      },
      // v269 — Peak-tracking transparency. Show user that the displayed
      // number is the all-time peak (only climbs) AND the current real number.
      peakLevel: Math.round(brain.peakIntelligenceLevel * 100),
      currentLevel: Math.round(currentLevel * 100),
    },
    // v239 — Real-time learning feedback. Counts only the NEW live samples
    // ingested this tick + the calibration table + boost effectiveness.
    selfImprovement: {
      liveSamplesIngestedThisRun: liveIngestedThisRun,
      totalLiveSamples: brain.liveSamplesIngested || 0,
      calibrationAccuracy: calibrationAccuracy != null ? Math.round(calibrationAccuracy * 100) : null,
      calibrationBuckets,
      boostEffectiveness: boostEffectivenessSummary,
      lastShadowSyncAt: brain.lastShadowSyncAt || null,
      // v258 — Lessons learned. Grows monotonically with every loss recorded.
      // Proof of endless learning — the brain never forgets a failure context.
      lessonsLearned: (brain.lessons && brain.lessons.totalRecorded) || 0,
      lessonsByCombo: (brain.lessons && brain.lessons.byCombo) || {},
      lastLessonAt: (brain.lessons && brain.lessons.lastLessonAt) || null,
      // v260 — Wins studied (symmetric). Every won signal contributes a
      // success context the brain references for future matches.
      winsStudied: (brain.winsStudied && brain.winsStudied.totalRecorded) || 0,
      winsByCombo: (brain.winsStudied && brain.winsStudied.byCombo) || {},
      lastWinAt: (brain.winsStudied && brain.winsStudied.lastWinAt) || null,
    },
    // v239 — Current market regime (used by check-signals for regime-aware
    // scoring) + history of last 100 scans' regime classifications.
    regime: brain.currentRegime || null,
    regimeStats: brain.regimeStats || {},
    lastScan: {
      scanned: totalScannedThisRun,
      resolved: totalResolvedThisRun,
      pairsCompleted: pairsCompletedThisRun.length,
    },
    topWinners: brain.topWinners.slice(0, 8),
    fastWinners: brain.fastWinners.slice(0, 6),
    bestHours: brain.bestHours.slice(0, 6),
    lastUpdated: brain.lastUpdated,
    savedThisRun,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
