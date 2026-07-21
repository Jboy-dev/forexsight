// /api/tp-monitor — v318 live TP/SL hit detector.
//
// Every cron tick, scans all recently-emitted signals against current live
// prices and records the first time each level (TP1/TP2/TP3/SL) is touched.
// When a level is newly hit, fires a push notification so the user knows
// on-time — even if the app is closed.
//
// Data model (in KV under key `tp-tracker`):
//   {
//     signals: [
//       {
//         id, pair, direction, entry, sl, tp1, tp2, tp3, detectedAt,
//         hits: { tp1: {t, price}|null, tp2: null, tp3: null, sl: null },
//         addedAt, resolvedAt
//       },
//       ...
//     ]
//   }
//
// Retention: kept 48h after detectedAt, or purged when SL or TP3 fires.

import { sendPush } from './_push-lib.js';

const TRACKER_KEY = 'tp-tracker';
const MAX_TRACKED = 200;         // hard cap on tracker size
const RETENTION_HOURS = 48;

// Pair → Yahoo symbol (mirrors PAIRS in check-signals.js)
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

async function _fetchLivePrice(origin, symbol) {
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(symbol)}&range=1d&interval=5m`);
    if (!res.ok) return null;
    const data = await res.json();
    const ohlc = data.ohlc;
    if (!Array.isArray(ohlc) || !ohlc.length) return null;
    // Get last bar's high + low + close to detect wicks that hit levels
    const last = ohlc[ohlc.length - 1];
    return { close: last.c, high: last.h, low: last.l, ts: last.t };
  } catch { return null; }
}

// v330 — Full recent bar history for RETROACTIVE hit detection.
// If TP-monitor missed a tick (KV quota, network fail, etc.), the next tick
// scans ALL bars since the signal was added, not just the last bar.
// This catches every hit even if the monitor was down when it happened.
async function _fetchRecentBars(origin, symbol) {
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const ohlc = data.ohlc;
    if (!Array.isArray(ohlc) || !ohlc.length) return null;
    return ohlc;
  } catch { return null; }
}

function _formatPrice(pair, price) {
  if (pair === 'XAU/USD' || pair === 'US30' || pair === 'NAS100') return price.toFixed(2);
  if (pair === 'BTC/USD') return price.toFixed(0);
  if (pair && pair.includes('JPY')) return price.toFixed(3);
  return price.toFixed(5);
}

// v320 — LEARNING FEEDBACK: When a real signal resolves (SL or TP3 hit),
// write the outcome directly to the brain's live combo stats. This is the
// critical missing link — TP monitor now feeds the machine learning loop.
async function _recordOutcomeToBrain(env, signal, outcome) {
  if (!env.TRADES_KV || !signal.comboKey || !signal.pair) return;
  try {
    const raw = await env.TRADES_KV.get('learning-brain');
    if (!raw) return;
    let brain;
    try { brain = JSON.parse(raw); } catch { return; }
    if (!brain.byPairLive) brain.byPairLive = {};
    if (!brain.byPairLive[signal.pair]) {
      brain.byPairLive[signal.pair] = { byCombo: {}, w: 0, l: 0 };
    }
    const pairLive = brain.byPairLive[signal.pair];
    if (!pairLive.byCombo) pairLive.byCombo = {};
    if (!pairLive.byCombo[signal.comboKey]) {
      pairLive.byCombo[signal.comboKey] = { w: 0, l: 0 };
    }
    if (outcome === 'won') {
      pairLive.byCombo[signal.comboKey].w = (pairLive.byCombo[signal.comboKey].w || 0) + 1;
      pairLive.w = (pairLive.w || 0) + 1;
    } else if (outcome === 'lost') {
      pairLive.byCombo[signal.comboKey].l = (pairLive.byCombo[signal.comboKey].l || 0) + 1;
      pairLive.l = (pairLive.l || 0) + 1;
    }
    // Also update cross-pair combo aggregate (helps universal-pattern learning)
    if (!brain.byCombo) brain.byCombo = {};
    if (!brain.byCombo[signal.comboKey]) {
      brain.byCombo[signal.comboKey] = { w: 0, l: 0, barSum: 0, barCount: 0 };
    }
    if (outcome === 'won') brain.byCombo[signal.comboKey].w++;
    else if (outcome === 'lost') brain.byCombo[signal.comboKey].l++;
    // Timestamp the update
    brain.lastLiveOutcomeAt = new Date().toISOString();
    if (!brain.liveOutcomeHistory) brain.liveOutcomeHistory = [];
    brain.liveOutcomeHistory.unshift({
      pair: signal.pair,
      direction: signal.direction,
      comboKey: signal.comboKey,
      outcome,
      resolvedAt: new Date().toISOString(),
      entry: signal.entry,
      exit: outcome === 'won' ? signal.tp3 : signal.sl,
    });
    // Keep only last 200 outcomes (memory management)
    if (brain.liveOutcomeHistory.length > 200) {
      brain.liveOutcomeHistory = brain.liveOutcomeHistory.slice(0, 200);
    }
    await env.TRADES_KV.put('learning-brain', JSON.stringify(brain));
  } catch (e) {
    // Non-fatal: TP fires still notify user even if brain update fails
    console.warn('[tp-monitor] brain update failed:', e.message);
  }
}

async function _pushNotification(env, subs, hitLevel, signal, price) {
  const emoji = hitLevel === 'sl' ? '🛑' :
                hitLevel === 'tp3' ? '🏆' :
                hitLevel === 'tp2' ? '🎯' : '🎯';
  const levelLabel = hitLevel.toUpperCase();
  const priceLabel = _formatPrice(signal.pair, price);
  const entryLabel = _formatPrice(signal.pair, signal.entry);
  const gain = hitLevel === 'sl'
    ? 'stopped out'
    : `${Math.abs(price - signal.entry).toFixed(signal.pair === 'BTC/USD' ? 0 : signal.pair === 'XAU/USD' ? 2 : 5)} pips`;
  // v328 — Include trailing-stop action in the push body so user knows to
  // move their SL immediately (locks in profits, eliminates loss risk).
  let action = '';
  if (hitLevel === 'tp1') {
    action = ` · MOVE SL TO ${_formatPrice(signal.pair, signal.entry)} (breakeven)`;
  } else if (hitLevel === 'tp2') {
    action = ` · MOVE SL TO ${_formatPrice(signal.pair, signal.tp1)} (lock 1R profit)`;
  } else if (hitLevel === 'tp3') {
    action = ` · CLOSE POSITION (max profit)`;
  }
  const payload = {
    title: `${emoji} ${levelLabel} HIT · ${signal.pair} ${signal.direction}`,
    body: `Price ${priceLabel} — ${gain} from entry ${entryLabel}${action}`,
    tag: `${signal.pair}-${signal.direction}-${hitLevel}`,
    data: { url: '/', pair: signal.pair, direction: signal.direction, hitLevel },
    direction: signal.direction,
  };
  let sent = 0;
  await Promise.all(subs.map(async ({ key, sub }) => {
    try {
      const r = await sendPush(sub, payload);
      if (r.ok) sent++;
      else if (r.status === 404 || r.status === 410) {
        await env.TRADES_KV.delete(key).catch(() => {});
      }
    } catch { /* ignore per-sub */ }
  }));
  return sent;
}

function _isBuy(dir) { return dir === 'BUY' || dir === 'LONG'; }

// Test whether the bar's high/low touched a level for this direction.
// v338 fix — CRITICAL BUG: this was using bar.high/bar.low but our OHLC
// bars use single-letter h/l. bar.high was always undefined → all hit
// detection silently failed since v318. Fixed to accept both h/high and
// l/low for defensive resilience (some code paths use full names).
function _touched(direction, level, bar) {
  if (level == null || !bar) return false;
  const barHigh = bar.h != null ? bar.h : bar.high;
  const barLow = bar.l != null ? bar.l : bar.low;
  return _isBuy(direction) ? barHigh >= level : barLow <= level;
}
function _touchedSl(direction, sl, bar) {
  if (sl == null || !bar) return false;
  const barHigh = bar.h != null ? bar.h : bar.high;
  const barLow = bar.l != null ? bar.l : bar.low;
  return _isBuy(direction) ? barLow <= sl : barHigh >= sl;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (!env.TRADES_KV) {
    return _json({ ok: false, error: 'KV not bound' }, 500);
  }

  // 1) Load current tracker + latest signals.
  // v357 — Use smartGet so both KV-persisted and Cache-fallback entries are
  // found. When KV quota is exhausted, writes go to Cache API; without this
  // read, the tracker would look empty and TP hits would be missed.
  const { smartGet } = await import('./_cache-store.js');
  const [trackerRes, latestRes, subListRaw] = await Promise.all([
    smartGet(env, TRACKER_KEY, TRACKER_KEY),
    smartGet(env, 'latest-signals', 'latest-signals'),
    env.TRADES_KV.list({ prefix: 'pushsub:' }).catch(() => ({ keys: [] })),
  ]);
  const trackerRaw = trackerRes.data;
  const latestRaw = latestRes.data;
  let tracker = { signals: [] };
  if (trackerRaw) {
    // smartGet parses JSON already; but legacy KV may return string
    tracker = typeof trackerRaw === 'string' ? (JSON.parse(trackerRaw) || { signals: [] }) : trackerRaw;
  }
  if (!Array.isArray(tracker.signals)) tracker.signals = [];

  // 2) Ingest any new signals from latest-signals into the tracker
  const now = Date.now();
  let added = 0;
  if (latestRaw) {
    try {
      const latest = JSON.parse(latestRaw);
      for (const s of (latest.signals || [])) {
        if (!s || !s.pair || !s.direction || !s.entry || !s.sl) continue;
        const id = `${s.pair}|${s.direction}|${s.detectedAt || latest.ts}`;
        if (tracker.signals.find(t => t.id === id)) continue;
        tracker.signals.push({
          id,
          pair: s.pair,
          direction: s.direction,
          entry: s.entry,
          sl: s.sl,
          tp1: s.tp1 || null,
          tp2: s.tp2 || null,
          tp3: s.tp3 || null,
          detectedAt: s.detectedAt || new Date(latest.ts || now).toISOString(),
          addedAt: now,
          hits: { tp1: null, tp2: null, tp3: null, sl: null },
          resolvedAt: null,
        });
        added++;
      }
    } catch { /* ignore malformed */ }
  }

  // 3) Prepare subs for push
  const subs = [];
  try {
    for (const k of (subListRaw.keys || [])) {
      const r = await env.TRADES_KV.get(k.name, 'json').catch(() => null);
      if (r && r.subscription) subs.push({ key: k.name, sub: r.subscription });
    }
  } catch { /* non-fatal */ }

  // 4) v330 — Fetch FULL recent bar history per pair, then check EACH open
  // signal against every bar since the signal was added. This catches TP
  // hits retroactively — if the monitor was down, the KV quota was
  // exhausted, or push failed, the next tick will still detect the hit.
  const uniquePairs = [...new Set(tracker.signals
    .filter(s => s.resolvedAt == null)
    .map(s => s.pair)
  )];
  const barsByPair = {};
  await Promise.all(uniquePairs.map(async (p) => {
    const sym = SYMBOLS[p];
    if (!sym) return;
    barsByPair[p] = await _fetchRecentBars(origin, sym);
  }));

  // v330c — Pre-flight KV write test. If daily quota exhausted, we can't
  // persist push-sent state, so firing pushes now = spamming user every tick.
  // Skip retrospective pushes entirely when we can't save state.
  // v357 — killed the ironic KV probe write. Previous code wrote a probe key
  // to KV on EVERY tp-monitor tick (12/hour = 288/day) just to check if KV
  // was writable — which itself burned the quota. Now we probe via Cache API
  // (unlimited) and use globalThis to remember the last probe result within
  // this isolate. If we hit a genuine KV write error, we'll flip the flag.
  let kvWritable = globalThis.__kvWritable !== false; // default true, sticky-false once we see an error
  let kvWriteError = globalThis.__kvWriteError || null;
  if (!env.TRADES_KV) {
    kvWritable = false;
    kvWriteError = 'TRADES_KV binding not attached';
  }

  // 5) For each signal (open OR resolved), scan bars + fire missed pushes.
  // Note: resolved signals still need pushSent check for retrospective pushes.
  const events = [];
  let pushSent = 0;
  const scanTrace = { openScanned: 0, barsAvail: 0, relevantBars: 0, hitsFound: 0, exceptions: [] };
  for (const s of tracker.signals) {
    // Resolved signals only need retrospective-push check (skip bar scan)
    if (s.resolvedAt) {
      // Only fire retrospective push if KV is writable (so we can persist state)
      if (subs.length && kvWritable) {
        for (const level of ['tp1', 'tp2', 'tp3', 'sl']) {
          const hit = s.hits && s.hits[level];
          if (hit && hit.pushSent !== true) {
            const price = hit.price != null ? hit.price : s[level];
            const ok = await _pushNotification(env, subs, level, s, price);
            if (ok > 0) {
              hit.pushSent = true;
              pushSent += ok;
              events.push({
                id: s.id, hit: level, price, at: new Date(hit.t).toISOString(),
                retrospective: true,
              });
            }
          }
        }
      }
      continue;
    }
    const bars = barsByPair[s.pair];
    if (!bars || !bars.length) continue;
    scanTrace.openScanned++;
    scanTrace.barsAvail += bars.length;

    // Filter to bars AFTER signal was added (added or -infinity if missing)
    const startTs = s.addedAt || 0;
    const relevantBars = bars.filter(b => b.t >= startTs - 3600000);  // include 1h buffer
    scanTrace.relevantBars += relevantBars.length;
    if (!relevantBars.length) continue;

    try {
    // Walk bars chronologically and detect the FIRST bar that touched each level.
    // Recording the actual hit time (not "now") so timing is accurate.
    for (const bar of relevantBars) {
      if (s.resolvedAt) break;
      const barTime = bar.t;

      // SL — if hit, resolve signal
      if (!s.hits.sl && _touchedSl(s.direction, s.sl, bar)) {
        s.hits.sl = { t: barTime, price: s.sl, pushSent: false };
        events.push({ id: s.id, hit: 'sl', price: s.sl, at: new Date(barTime).toISOString() });
        if (subs.length) {
          const ok = await _pushNotification(env, subs, 'sl', s, s.sl);
          pushSent += ok;
          if (ok > 0) s.hits.sl.pushSent = true;
        }
        s.resolvedAt = barTime;
        const partialWin = s.hits.tp1 != null;
        await _recordOutcomeToBrain(env, s, partialWin ? 'won' : 'lost');
        break;
      }
      // TP1
      if (!s.hits.tp1 && _touched(s.direction, s.tp1, bar)) {
        s.hits.tp1 = { t: barTime, price: s.tp1, pushSent: false };
        events.push({ id: s.id, hit: 'tp1', price: s.tp1, at: new Date(barTime).toISOString() });
        if (subs.length) {
          const ok = await _pushNotification(env, subs, 'tp1', s, s.tp1);
          pushSent += ok;
          if (ok > 0) s.hits.tp1.pushSent = true;
        }
      }
      // TP2
      if (!s.hits.tp2 && _touched(s.direction, s.tp2, bar)) {
        s.hits.tp2 = { t: barTime, price: s.tp2, pushSent: false };
        events.push({ id: s.id, hit: 'tp2', price: s.tp2, at: new Date(barTime).toISOString() });
        if (subs.length) {
          const ok = await _pushNotification(env, subs, 'tp2', s, s.tp2);
          pushSent += ok;
          if (ok > 0) s.hits.tp2.pushSent = true;
        }
      }
      // TP3 — resolves signal
      if (!s.hits.tp3 && _touched(s.direction, s.tp3, bar)) {
        s.hits.tp3 = { t: barTime, price: s.tp3, pushSent: false };
        events.push({ id: s.id, hit: 'tp3', price: s.tp3, at: new Date(barTime).toISOString() });
        if (subs.length) {
          const ok = await _pushNotification(env, subs, 'tp3', s, s.tp3);
          pushSent += ok;
          if (ok > 0) s.hits.tp3.pushSent = true;
        }
        s.resolvedAt = barTime;
        await _recordOutcomeToBrain(env, s, 'won');
        break;
      }
    }
    } catch (e) {
      scanTrace.exceptions.push({ signal: s.id, err: e.message });
    }

    // v330b — RETROSPECTIVE PUSH. If a hit was recorded earlier but push
    // never went out (KV write failed, service crash, no subscribers at time,
    // OR hit was recorded before v330b when pushSent tracking existed),
    // fire the push now. Catches both hit.pushSent === false AND undefined.
    if (subs.length) {
      for (const level of ['tp1', 'tp2', 'tp3', 'sl']) {
        const hit = s.hits[level];
        if (hit && hit.pushSent !== true) {
          const price = hit.price != null ? hit.price : s[level];
          const ok = await _pushNotification(env, subs, level, s, price);
          if (ok > 0) {
            hit.pushSent = true;
            pushSent += ok;
            events.push({
              id: s.id, hit: level, price, at: new Date(hit.t).toISOString(),
              retrospective: true,
            });
          }
        }
      }
    }
  }

  // 6) Retention — resolve or drop stale ones
  const cutoff = now - RETENTION_HOURS * 3600 * 1000;
  let expired = 0;
  for (const s of tracker.signals) {
    if (s.resolvedAt) continue;
    const detectedMs = new Date(s.detectedAt).getTime();
    if (Number.isFinite(detectedMs) && detectedMs < cutoff) {
      s.resolvedAt = now;
      s.expired = true;
      expired++;
    }
  }
  // Drop fully-resolved rows older than 48h
  tracker.signals = tracker.signals.filter(s => {
    if (!s.resolvedAt) return true;
    return (now - s.resolvedAt) < (RETENTION_HOURS * 3600 * 1000);
  });
  // Hard cap size
  if (tracker.signals.length > MAX_TRACKED) {
    tracker.signals = tracker.signals
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, MAX_TRACKED);
  }

  // 7) Save updated tracker — v320b: only write when something changed.
  // Cloudflare Free tier gives 1000 KV writes/day; tp-monitor runs every
  // 5min = 288 writes/day just for this endpoint. Skip writes when nothing
  // material happened (no new signals, no hits, no expirations, no pushes).
  const somethingChanged = added > 0 || events.length > 0 || expired > 0 || pushSent > 0;
  let kvWritten = false;
  let writeVia = 'skipped';
  if (somethingChanged) {
    try {
      // v357 — smartPut: KV first (durable across worker restarts), Cache API
      // fallback if quota exhausted. Marks kvWritable=false in globalThis so
      // subsequent same-isolate calls skip retrospective pushes automatically.
      const { smartPut } = await import('./_cache-store.js');
      const res = await smartPut(env, TRACKER_KEY, TRACKER_KEY, tracker, 14 * 24 * 3600);
      kvWritten = res.via === 'kv';
      writeVia = res.via;
      if (res.kvError) {
        globalThis.__kvWritable = false;
        globalThis.__kvWriteError = res.kvError;
      }
    } catch (e) {
      return _json({
        ok: true,
        version: 'v357-tp-monitor',
        warning: 'Both KV+Cache write failed: ' + e.message,
        tracked: tracker.signals.length,
        unresolved: tracker.signals.filter(s => !s.resolvedAt).length,
        added,
        events,
        pushSent,
        expired,
        kvWritten: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return _json({
    ok: true,
    version: 'v357-cache-fallback',
    tracked: tracker.signals.length,
    unresolved: tracker.signals.filter(s => !s.resolvedAt).length,
    added,
    events,
    pushSent,
    expired,
    kvWritten,
    writeVia,
    scanTrace,
    kvWritable,
    kvWriteError,
    timestamp: new Date().toISOString(),
  });
}

function _json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
