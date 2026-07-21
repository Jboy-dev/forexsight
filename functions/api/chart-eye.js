// /api/chart-eye — v358 always-on chart monitor.
//
// Called by cron every scan cycle. For every pair, computes a snapshot
// containing price, momentum deltas, breakout signals, reversal signals,
// volume regime, and stores it to Cache API. Compares against the previous
// snapshot to spot LIVE changes: momentum ignition, structure breaks, key
// level touches. Emits an "alert" whenever a signal-worthy shift happens.
//
// Storage: Cache API (unlimited writes) — safe to hammer every 60s.
// Consumers: check-signals reads current snapshot for weighted evidence,
// UI reads /api/chart-eye directly for a live "market pulse" panel.

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

// ── Indicator helpers (compact) ──────────────────────────────────────────
function _emaSeries(arr, p) {
  const out = [];
  const k = 2 / (p + 1);
  let prev = null;
  for (const v of arr) {
    if (v == null || !isFinite(v)) { out.push(null); continue; }
    prev = prev == null ? v : (v * k + prev * (1 - k));
    out.push(prev);
  }
  return out;
}
function _ema(arr, p) {
  const s = _emaSeries(arr, p);
  return s.length ? s[s.length - 1] : null;
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
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const sliced = trs.slice(-period);
  return sliced.reduce((a, b) => a + b, 0) / sliced.length;
}

// ── Fetch bars ───────────────────────────────────────────────────────────
async function _fetchBars(origin, sym) {
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`);
    if (!res.ok) return null;
    const d = await res.json();
    return Array.isArray(d.ohlc) ? d.ohlc : null;
  } catch { return null; }
}

// ── Snapshot ─────────────────────────────────────────────────────────────
function _snapshot(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h != null ? b.h : b.high);
  const lows = bars.map(b => b.l != null ? b.l : b.low);
  const n = bars.length - 1;
  const price = closes[n];

  const ema20 = _ema(closes.slice(-40), 20);
  const ema50 = _ema(closes.slice(-100), 50);
  const rsi = _rsi(closes.slice(-30), 14);
  const atr = _atr(highs.slice(-30), lows.slice(-30), closes.slice(-30), 14);

  // Recent 5-bar high/low = short-term range
  const last5H = Math.max(...highs.slice(-5));
  const last5L = Math.min(...lows.slice(-5));

  // 20-bar range for breakout detection
  const range20H = Math.max(...highs.slice(-20));
  const range20L = Math.min(...lows.slice(-20));

  // Momentum: 3-bar close delta and 10-bar close delta as % of ATR
  const delta3pct = atr > 0 ? ((price - closes[n - 3]) / atr) : 0;
  const delta10pct = atr > 0 ? ((price - closes[n - 10]) / atr) : 0;

  return {
    ts: Date.now(),
    price: Math.round(price * 100000) / 100000,
    ema20: ema20 != null ? Math.round(ema20 * 100000) / 100000 : null,
    ema50: ema50 != null ? Math.round(ema50 * 100000) / 100000 : null,
    rsi: rsi != null ? Math.round(rsi * 10) / 10 : null,
    atr: atr != null ? Math.round(atr * 100000) / 100000 : null,
    last5H, last5L,
    range20H, range20L,
    delta3ATR: Math.round(delta3pct * 100) / 100,   // e.g. +1.35 = 1.35× ATR up in 3 bars
    delta10ATR: Math.round(delta10pct * 100) / 100,
    // Boolean signals
    aboveEma20: ema20 != null && price > ema20,
    ema20AboveEma50: ema20 != null && ema50 != null && ema20 > ema50,
    at20BarHigh: (range20H - price) / atr < 0.15,   // within 0.15 ATR of top
    at20BarLow: (price - range20L) / atr < 0.15,    // within 0.15 ATR of bottom
    // Alerts (compared to prev snapshot in _detectShifts)
    alerts: [],
  };
}

// ── Detect shifts between two snapshots ──────────────────────────────────
function _detectShifts(now, prev) {
  const alerts = [];
  if (!prev) return alerts;

  // MOMENTUM IGNITION — 3-bar delta jumped from flat to > 1 ATR
  if (Math.abs(prev.delta3ATR) < 0.5 && Math.abs(now.delta3ATR) > 1.0) {
    alerts.push({
      type: 'momentum-ignition',
      direction: now.delta3ATR > 0 ? 'BUY' : 'SELL',
      strength: Math.abs(now.delta3ATR),
      msg: `Momentum ignition: ${now.delta3ATR > 0 ? '+' : ''}${now.delta3ATR}× ATR in 3 bars`,
    });
  }

  // 20-BAR BREAKOUT — price just broke above or below 20-bar range
  if (!prev.at20BarHigh && now.at20BarHigh) {
    alerts.push({
      type: 'breakout-high',
      direction: 'BUY',
      msg: `Broke 20-bar high (${now.range20H})`,
    });
  }
  if (!prev.at20BarLow && now.at20BarLow) {
    alerts.push({
      type: 'breakout-low',
      direction: 'SELL',
      msg: `Broke 20-bar low (${now.range20L})`,
    });
  }

  // EMA CROSS — 20 EMA just crossed 50 EMA
  if (prev.ema20AboveEma50 === false && now.ema20AboveEma50 === true) {
    alerts.push({ type: 'golden-cross', direction: 'BUY', msg: 'EMA20 crossed above EMA50 (golden cross)' });
  }
  if (prev.ema20AboveEma50 === true && now.ema20AboveEma50 === false) {
    alerts.push({ type: 'death-cross', direction: 'SELL', msg: 'EMA20 crossed below EMA50 (death cross)' });
  }

  // RSI EXTREME REVERSAL — RSI was oversold and just crossed back over 30
  if (prev.rsi != null && now.rsi != null) {
    if (prev.rsi < 30 && now.rsi >= 30) {
      alerts.push({ type: 'rsi-oversold-exit', direction: 'BUY', msg: `RSI exited oversold (${prev.rsi} → ${now.rsi})` });
    }
    if (prev.rsi > 70 && now.rsi <= 70) {
      alerts.push({ type: 'rsi-overbought-exit', direction: 'SELL', msg: `RSI exited overbought (${prev.rsi} → ${now.rsi})` });
    }
  }

  // KEY LEVEL TOUCH — price came within 0.1 ATR of ema50 from opposite side
  if (now.atr > 0 && now.ema50 != null && prev.ema50 != null) {
    const distNow = Math.abs(now.price - now.ema50) / now.atr;
    const distPrev = Math.abs(prev.price - prev.ema50) / prev.atr;
    if (distPrev > 0.5 && distNow < 0.1) {
      alerts.push({
        type: 'ema50-touch',
        direction: now.price > now.ema50 ? 'BUY' : 'SELL',
        msg: `Price touched EMA50 from ${distPrev.toFixed(1)} ATR away`,
      });
    }
  }

  return alerts;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  const { cacheGet, cachePut } = await import('./_cache-store.js');

  const results = await Promise.all(Object.entries(PAIRS).map(async ([pair, sym]) => {
    const bars = await _fetchBars(origin, sym);
    if (!bars) return { pair, ok: false, error: 'no bars' };

    const snap = _snapshot(bars);
    if (!snap) return { pair, ok: false, error: 'snapshot fail' };

    const prev = await cacheGet(`chart-eye:${pair}`);
    snap.alerts = _detectShifts(snap, prev);

    // Store snapshot for next comparison
    await cachePut(`chart-eye:${pair}`, snap, 30 * 60); // 30-min TTL

    return { pair, ok: true, snapshot: snap, prevSnapshot: prev };
  }));

  // Aggregate alerts across all pairs — this is what user's UI shows
  const allAlerts = [];
  for (const r of results) {
    if (r.ok && r.snapshot && r.snapshot.alerts.length) {
      for (const a of r.snapshot.alerts) {
        allAlerts.push({ pair: r.pair, ...a });
      }
    }
  }

  // Save aggregate for cheap client fetch
  const aggregate = {
    ts: Date.now(),
    scanned: Object.keys(PAIRS).length,
    alertCount: allAlerts.length,
    alerts: allAlerts,
    snapshots: results.reduce((acc, r) => {
      if (r.ok) acc[r.pair] = r.snapshot;
      return acc;
    }, {}),
  };
  await cachePut('chart-eye:aggregate', aggregate, 90);

  return new Response(JSON.stringify({
    ok: true,
    version: 'v358-chart-eye',
    ...aggregate,
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=30',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
