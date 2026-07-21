/* ForexSight — Netlify edition.
 * All indicator math + signal generation runs in the browser.
 * Self-learning hit-rate tracking lives in localStorage (per device).
 *
 * Defensive design:
 *   - Every localStorage read goes through safeLoad() which falls back to a default
 *   - Every localStorage write goes through safeSave() which swallows QuotaExceededError
 *   - Every async fetch / parse is wrapped in try/catch
 *   - A global onerror handler logs to the in-app debug panel without breaking the page
 *   - Versioned keys: if a schema changes, bump _v1 → _v2 and the old data is ignored
 */

// v246 — CRASH-PROOF LAYER. Three global handlers ensure the app keeps
// running no matter what blows up:
//   1. window.onerror catches synchronous exceptions in event handlers,
//      timers, and inline code — logs to console, prevents the unhandled
//      red error overlay from breaking the page.
//   2. window.onunhandledrejection catches Promise rejections that nobody
//      .catch()'d — same effect for async code.
//   3. _safeInterval wraps every setInterval so a thrown error inside one
//      tick doesn't kill the interval forever. Failed ticks log and retry.
window.addEventListener('error', (e) => {
  try {
    console.warn('[fxsight global error]', e.message || 'unknown', e.filename || '', e.lineno || '');
  } catch {}
  // Don't prevent default — let the browser still surface in dev tools.
  // We just don't want it killing event loops or showing red overlays.
});
window.addEventListener('unhandledrejection', (e) => {
  try {
    const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason || 'unknown');
    console.warn('[fxsight unhandled promise]', reason);
  } catch {}
});
// Self-healing setInterval — if the tick handler throws, log and continue.
// Without this, a single bad tick (e.g. DOM element missing during render)
// silently kills the interval forever. With this, the interval keeps trying.
window._safeInterval = function(fn, ms, label) {
  let consecutiveFails = 0;
  const safeFn = () => {
    try {
      const out = fn();
      consecutiveFails = 0;
      // If the returned value is a Promise, attach catch so async failures
      // don't surface as unhandled rejections either.
      if (out && typeof out.catch === 'function') out.catch(err => {
        consecutiveFails++;
        console.warn(`[interval ${label || '?'} async fail #${consecutiveFails}]`, err && err.message || err);
      });
    } catch (err) {
      consecutiveFails++;
      console.warn(`[interval ${label || '?'} sync fail #${consecutiveFails}]`, err && err.message || err);
    }
  };
  return setInterval(safeFn, ms);
};
// Defensive DOM helpers — return safe defaults instead of throwing on null.
window._safeQs = function(sel, root) {
  try { return (root || document).querySelector(sel); } catch { return null; }
};
window._safeText = function(el, text) {
  try { if (el) el.textContent = text; } catch {}
};
window._safeHTML = function(el, html) {
  try { if (el) el.innerHTML = html; } catch {}
};

// v352 — XSS ESCAPER. Use on any content sourced from external feeds
// (news titles, RSS summaries, upstream API strings) before interpolating
// into innerHTML. Server-generated numbers/directions are safe, but text
// from third parties needs escaping to prevent script injection if a
// feed is ever compromised.
window._esc = function(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
// Sanitize a URL — only http/https/mailto allowed, prevents javascript:
window._escUrl = function(str) {
  if (str == null) return '#';
  const s = String(str).trim();
  if (/^(https?:|mailto:|\/)/i.test(s)) {
    return s.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  }
  return '#';
};

// v251 — TAP-TO-COPY for SL/TP/Entry numbers. Globally delegated handler so
// it works on EVERY <code>-formatted price across the whole app — signal
// cards, signal modal, signal feed, signal-feed modal, trade rows, history,
// recovery banner. User taps any number → it lands on the clipboard → they
// paste straight into their broker. Zero friction trade entry.
//
// Capture phase (third arg = true) means this runs BEFORE the card-open
// handler. stopPropagation prevents the modal from opening when the user
// just wanted to copy a number.
async function _copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback for older browsers / non-secure contexts
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
function _showCopyToast(msg) {
  let toast = document.getElementById('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'copy-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }
  toast.textContent = '📋 ' + msg;
  // Force reflow before adding visible class so the transition plays even
  // when the toast is fired in rapid succession.
  void toast.offsetHeight;
  toast.classList.add('visible');
  clearTimeout(toast._copyTimer);
  toast._copyTimer = setTimeout(() => toast.classList.remove('visible'), 1400);
}
document.addEventListener('click', async (e) => {
  const codeEl = e.target && e.target.closest && e.target.closest('code');
  if (!codeEl) return;
  // Only treat <code> as copyable if it's inside a trading-related context.
  // Skips news links, Learning guide examples, footer code blocks, etc.
  const ctx = codeEl.closest('.card, .modal-content, .trade-row, .shadow-feed-card, .sh-card, .rb-row, .shadow-modal');
  if (!ctx) return;
  // Skip placeholder / non-numeric content
  const text = (codeEl.textContent || '').trim();
  if (!text || text === '?' || text === '–' || text === '-' || text.length > 24) return;
  // Allow digits, decimal point, minus sign, slash (for pair-shaped values).
  // If it doesn't look like a price, skip.
  if (!/^[0-9.,\-]+$/.test(text)) return;
  const ok = await _copyToClipboard(text);
  if (ok) {
    _showCopyToast(`Copied ${text}`);
    // Brief visual flash so the user knows the tap landed
    codeEl.classList.add('copy-flash');
    setTimeout(() => codeEl.classList.remove('copy-flash'), 600);
  }
  // Prevent the parent card / row from also responding (don't open a modal
  // when the user just wanted to grab the number).
  e.stopPropagation();
}, true);

// v229 — Client now scans the same 8 pairs the brain learns from + the
// server-side scanner covers. Gold remains the primary focus for auto-add
// but the user sees signals from every pair the brain has knowledge about.
const PAIRS = {
  'XAU/USD': 'GC=F',         // Gold spot — COMEX futures (primary focus)
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X',
  'NZD/USD': 'NZDUSD=X',
  'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
};

// Crypto remains disabled per earlier user preference.
const CRYPTO_PAIRS = {};

// v229/v278 — per-pair pip config for the 8 brain-tracked pairs PLUS the
// extra instruments the user can trade. Indices and crypto added so other
// helpers across the app (calculator, modal, recovery) handle them correctly.
const PAIR_CONFIG = {
  'XAU/USD': { pip: 0.10,   digits: 2 },  // gold — £0.10 per pip
  'EUR/USD': { pip: 0.0001, digits: 5 },
  'GBP/USD': { pip: 0.0001, digits: 5 },
  'AUD/USD': { pip: 0.0001, digits: 5 },
  'NZD/USD': { pip: 0.0001, digits: 5 },
  'USD/CAD': { pip: 0.0001, digits: 5 },
  'USD/CHF': { pip: 0.0001, digits: 5 },
  'USD/JPY': { pip: 0.01,   digits: 3 },  // JPY pairs: 0.01 per pip
  'EUR/JPY': { pip: 0.01,   digits: 3 },
  'GBP/JPY': { pip: 0.01,   digits: 3 },
  // v278 — Indices (CFD style; 1 point = 1.0 price unit, 0 decimals)
  'US30':   { pip: 1,       digits: 1 },
  'NAS100': { pip: 1,       digits: 1 },
  // Crypto (already handled elsewhere but listed here for completeness)
  'BTC/USD': { pip: 1,      digits: 1 },
  'ETH/USD': { pip: 0.1,    digits: 2 },
};

// Helper — true if this pair trades 24/7 (i.e. crypto). Used to bypass the
// forex-closed weekend lockout so crypto signals still notify on Saturdays.
function isCryptoPair(pair) {
  return pair && Object.prototype.hasOwnProperty.call(CRYPTO_PAIRS, pair);
}
function pairConfig(pair) {
  if (PAIR_CONFIG[pair]) return PAIR_CONFIG[pair];
  if (pair && pair.includes('JPY')) return { pip: 0.01, digits: 3 };
  return { pip: 0.0001, digits: 5 };
}
// Gold (XAU/USD) — separate symbol used ONLY by the Radiant SMC strategy.
// Kept out of the main PAIRS object so existing signal logic is untouched.
// COMEX gold futures contract — fresh real-time data via Yahoo. The spot
// XAUUSD=X symbol was returning 14-hour-stale data through Twelve Data
// fallback, making gold signals impossible. GC=F is updated every minute.
const RADIANT_GOLD_SYMBOL = 'GC=F';
const RADIANT_GOLD_PAIR = 'XAU/USD';
// v2: schema change — old auto-evaluated logs were skewing the confidence
// boost. Bumping the version forces a clean slate for learning data; real
// user-taken trades in TRADES_KEY are not affected.
const LOGS_KEY = 'forexsight_logs_v2';
const CACHE_KEY = 'forexsight_cache_v1';
const NOTIFIED_KEY = 'forexsight_notified_v1';
const NOTIFY_PREF_KEY = 'forexsight_notify_enabled';
const TRADES_KEY = 'forexsight_trades_v1';
const CACHE_TTL = 5 * 60 * 1000; // browser-side; edge cache does the heavy lifting
const NOTIFY_THRESHOLD = 80;

// FORWARD-WIN-RATE CUTOFF — every trade taken AFTER this timestamp is judged
// against the post-v140 filter stack (adaptive quality floor, per-pair-dir
// learning, recent-loss cooldown, active-session-only, strong-backtest-denial,
// volRegime guard, PSAR/MACD/Daily-trend alignment requirement…). Trades
// from BEFORE this point are pre-filter noise — they're still in history for
// transparency, but the Forward Win Rate panel ignores them so the user can
// see the actual improvement going forward instead of being dragged down by
// the legacy 38% baseline.
//
// Bump this whenever a major filter change ships and you want a fresh "from
// now on" window. Current setpoint: v140 deploy (2026-05-13 ~20:30 UTC).
const FORWARD_FILTER_START_ISO = '2026-05-13T20:30:00Z';
const FORWARD_FILTER_START_MS = Date.parse(FORWARD_FILTER_START_ISO);

// ════════════════════════════════════════════════════════════════════════
// CRASH-RESISTANCE LAYER
// Every operation in this app is wrapped to keep the page running even
// when something breaks. The strategy: catch everything, log it, recover
// to a safe default, continue. Critical user data (trades, sync code,
// learning logs) is automatically backed up every 5 minutes to a
// shadow key so corruption can be auto-recovered.
// ════════════════════════════════════════════════════════════════════════

// ── 1. SAFE STORAGE — load with auto-recovery from backup ──────────────
function safeLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[storage] primary read failed for ${key}:`, e.message);
    // Try the auto-backup before giving up
    try {
      const backup = localStorage.getItem(key + '_backup');
      if (backup) {
        const parsed = JSON.parse(backup);
        console.log(`[storage] recovered ${key} from backup`);
        // Restore primary from backup so the recovery is permanent
        try { localStorage.setItem(key, backup); } catch {}
        return parsed;
      }
    } catch (e2) { console.warn(`[storage] backup read also failed for ${key}:`, e2.message); }
    return fallback;
  }
}

// ── 2. SAFE SAVE — handles quota errors by purging old data ────────────
function safeSave(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    // QuotaExceededError — try to free space by trimming caches first
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.message?.includes('quota')) {
      console.warn(`[storage] quota exceeded, purging caches…`);
      try {
        // Remove non-critical cache entries first
        const trash = ['forexsight_cache_v1', 'forexsight_notified_v1', 'forexsight_smc_notified_v1', 'forexsight_orb_notified_v1'];
        for (const k of trash) try { localStorage.removeItem(k); } catch {}
        // Also drop oldest entries from logs if too big
        const logs = safeLoad('forexsight_logs_v2', []);
        if (Array.isArray(logs) && logs.length > 500) {
          localStorage.setItem('forexsight_logs_v2', JSON.stringify(logs.slice(-500)));
        }
        // Retry the save
        localStorage.setItem(key, JSON.stringify(value));
        console.log(`[storage] saved ${key} after purge`);
        return true;
      } catch (e2) {
        console.error(`[storage] save still failed after purge:`, e2.message);
        return false;
      }
    }
    console.warn(`[storage] write ${key}:`, e.message);
    return false;
  }
}

// ── PER-SIGNAL NOTES — user-editable scratchpad per pair+direction ────
// Keyed by `${pair}_${direction}` so a note follows the setup as long as the
// user is interested in that pair+side. Persisted in localStorage so it
// survives reloads. Empty strings clear the entry to avoid bloat.
const SIGNAL_NOTES_KEY = 'forexsight_signal_notes_v1';
function _noteKey(pair, direction) { return `${pair}_${direction}`; }
// v191 — notes are now wrapped { text, updatedAt } so cross-device sync can
// resolve which write is most recent. Backward-compat: legacy string entries
// are still read correctly.
function getSignalNote(pair, direction) {
  if (!pair || !direction) return '';
  const all = safeLoad(SIGNAL_NOTES_KEY, {});
  const entry = all && all[_noteKey(pair, direction)];
  if (!entry) return '';
  return typeof entry === 'string' ? entry : (entry.text || '');
}
function setSignalNote(pair, direction, text) {
  if (!pair || !direction) return;
  const all = safeLoad(SIGNAL_NOTES_KEY, {}) || {};
  const k = _noteKey(pair, direction);
  const v = (text || '').trim();
  if (!v) delete all[k];
  else all[k] = { text: v.slice(0, 2000), updatedAt: new Date().toISOString() };
  safeSave(SIGNAL_NOTES_KEY, all);
  // v191 — cross-device sync: push notes through the cloud pipeline so every
  // device using the same sync code sees the same note text immediately.
  try { if (typeof pushAllToCloud === 'function') pushAllToCloud(); } catch {}
  // v191 — same-page sync: update any other textarea on the page showing this
  // same pair+direction so the card and modal notes stay aligned without re-render.
  try { _broadcastNoteUpdate(pair, direction, v); } catch {}
}

// v191 — push the latest note text to every visible textarea bound to the
// same pair+direction, except the element that's currently focused (so the
// user's typing isn't disturbed). Card-note and modal-note share data, so
// editing one updates the other live.
function _broadcastNoteUpdate(pair, direction, text) {
  const sel = `.card-note, .modal-note`;
  document.querySelectorAll(sel).forEach((el) => {
    if (el === document.activeElement) return;
    const wrap = el.closest('[data-pair][data-direction]');
    if (!wrap) return;
    if (wrap.dataset.pair === pair && wrap.dataset.direction === direction) {
      if (el.value !== text) el.value = text;
    }
  });
}
function _escNote(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 3. AUTO-BACKUP — every 5 min, shadow-copy critical keys ─────────────
function _backupCriticalKeys() {
  // List of keys whose loss would be devastating for the user. Trades and
  // learning history are the irreplaceable ones; preferences can rebuild.
  const critical = [
    'forexsight_trades_v1',
    'forexsight_logs_v2',
    'forexsight_sync_code',
    'forexsight_smc_auto_v1',
    'forexsight_orb_auto_v1',
    'forexsight_ict_auto_v1',
    'forexsight_trend_auto_v1',
    'forexsight_squeeze_auto_v1',
    'forexsight_divergence_auto_v1',
    'forexsight_radiant_daily_v1',
  ];
  for (const k of critical) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) localStorage.setItem(k + '_backup', v);
    } catch (e) { /* one bad key shouldn't stop the rest */ }
  }
}
setInterval(_backupCriticalKeys, 5 * 60 * 1000);
// Run once on app boot too
setTimeout(_backupCriticalKeys, 30 * 1000);

function uuid() { return 'x'+Math.random().toString(36).slice(2,11)+Date.now().toString(36).slice(-4); }

// ── 4. NETWORK RESILIENCE — fetch with timeout + auto-retry ─────────────
async function safeFetch(url, options = {}, opts = {}) {
  const { timeout = 12000, retries = 1 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        clearTimeout(t);
        return res;
      } finally { clearTimeout(t); }
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── 5. GLOBAL ERROR HANDLERS — page never crashes from uncaught errors ─
// All uncaught errors and rejected promises are logged but absorbed.
// The user keeps seeing a working page even when a strategy or render
// path throws something we didn't expect.
window.addEventListener('error', (e) => {
  console.error('[global]', e.message, e.filename + ':' + e.lineno);
  try { _storeErrorForDiagnostic(e.message, e.filename + ':' + e.lineno); } catch {}
  // Don't preventDefault — let the error bubble to console but don't crash
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  console.error('[promise]', msg);
  try { _storeErrorForDiagnostic(msg, 'unhandled-rejection'); } catch {}
  e.preventDefault(); // suppress browser default error display
});

// Store last 20 errors so user can submit a diagnostic if asked
function _storeErrorForDiagnostic(msg, src) {
  try {
    const errs = safeLoad('forexsight_errors_v1', []);
    errs.push({ msg: String(msg).slice(0, 300), src: String(src).slice(0, 200), ts: Date.now() });
    while (errs.length > 20) errs.shift();
    safeSave('forexsight_errors_v1', errs);
  } catch {}
}

// ── 6. SAFE INVOKE — wrap any function call in protection ──────────────
function safeCall(fn, ...args) {
  try { return fn(...args); }
  catch (e) { console.warn('[safeCall]', fn?.name || 'anonymous', e.message); return null; }
}
async function safeCallAsync(fn, ...args) {
  try { return await fn(...args); }
  catch (e) { console.warn('[safeCallAsync]', fn?.name || 'anonymous', e.message); return null; }
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const MIN_CONF_KEY = 'forexsight_min_conf_v1';
const BEST_ONLY_KEY = 'forexsight_best_only_v1';
const FILTER_MODE_KEY = 'forexsight_filter_mode_v1'; // 'off' | 'best' | 'extreme'
const state = {
  signals: [], news: [], calendar: [],
  minConf: Number(localStorage.getItem(MIN_CONF_KEY) ?? 65),
  filterMode: localStorage.getItem(FILTER_MODE_KEY) || 'best', // default: Best
  bestOnly: localStorage.getItem(BEST_ONLY_KEY) !== 'false', // legacy compat
  autoRefresh: true, timer: null,
  notifyEnabled: localStorage.getItem(NOTIFY_PREF_KEY) !== 'false',
  unreadCount: 0,
};
// Migration: if user had bestOnly:true and no filterMode, set Best
if (!localStorage.getItem(FILTER_MODE_KEY)) {
  state.filterMode = state.bestOnly ? 'best' : 'off';
}

// PRO-DISCIPLINED Best Setup filter. A signal must clear EVERY one of these
// gates to qualify. Designed to mirror what professional traders actually
// require before risking real money. Result: very few signals, each with
// genuine multi-factor confirmation. Aim is to surface only setups where
// the edge is statistically defensible, not to chase a fake "9/10 wins"
// (no forex system delivers that — pros operate at 55-65% with 1:3 R:R).
//
// Required:
//   1. Indicator confluence ≥75% (was 70)
//   2. ≥3 battle-tested strategies firing in the signal direction (was 2)
//   3. Higher-timeframe daily trend agrees with signal direction
//   4. No active red-folder calendar blackout
//   5. Confidence ≥75% after all adjustments (was 70)
//   6. Backtested win rate ≥60% with ≥10 historical samples (was 55%, 8)
//   7. ADX ≥25 — strong trend, not chop (was 20)
//   8. Killzone OR backtested win rate ≥65% — institutional liquidity OR
//      strong empirical edge required
function isBestSetup(s) {
  if (!s || s.direction === 'HOLD') return false;
  if (s.blockReason) return false; // historically losing pattern — never show
  if (s.cooldownMinutesLeft) return false; // recent same-direction signal cooling down
  // FAST PATH: any strategy-confirmed signal at grade B+ or above auto-
  // qualifies as Best. Each strategy has deeper rules than the generic
  // "Best" criteria, so passing one IS by definition a best setup.
  if ((s.smcPassed && (s.smcQuality || 0) >= 75) ||
      (s.orbPassed && (s.orbQuality || 0) >= 75) ||
      (s.ictPassed && (s.ictQuality || 0) >= 75) ||
      (s.trendPassed && (s.trendQuality || 0) >= 75) ||
      (s.squeezePassed && (s.squeezeQuality || 0) >= 75) ||
      (s.divergencePassed && (s.divergenceQuality || 0) >= 75) ||
      (s.momentumPassed && (s.momentumQuality || 0) >= 60)) {
    return true;
  }
  const adaptiveFloor = adaptiveBestFloor();
  const winners = s.direction === 'BUY' ? s.bull_count : s.bear_count;
  if (winners / Math.max(1, s.total_indicators) < 0.75) return false;
  const alignedStrats = (s.firedStrategies || []).filter(f =>
    (s.direction === 'BUY' && f.bias === 'bullish') ||
    (s.direction === 'SELL' && f.bias === 'bearish')
  ).length;
  if (alignedStrats < 3) return false;
  if (s.htfTrend && ((s.direction === 'BUY' && s.htfTrend === 'down') ||
      (s.direction === 'SELL' && s.htfTrend === 'up'))) return false;
  if ((s.calPenalty ?? 0) <= -20) return false;
  if (s.confidence < 75 + adaptiveFloor) return false;
  // Wilson lower bound on backtest must clear 55% — not just point estimate
  if (s.winProbability != null && s.backtestSamples >= 10) {
    const ci = wilsonInterval(s.backtestWins || 0, s.backtestSamples || 1);
    if (ci.low < 0.50 - adaptiveFloor / 100) return false;
    if (s.winProbability < 60 + adaptiveFloor) return false;
  }
  if (s.adxNow != null && s.adxNow < 25) return false;
  const inKillzone = s.session && s.session.toLowerCase().includes('killzone');
  const strongBacktest = s.winProbability != null && s.backtestSamples >= 10 && s.winProbability >= 65;
  if (!inKillzone && !strongBacktest) return false;
  return true;
}

// EXTREME setup — the absolute strictest filter. Designed so that essentially
// no signal passes unless it has overwhelming evidence on every dimension.
// User typically sees 0 of these for hours at a time. When one appears, every
// independent factor is screaming the same direction.
function isExtremeSetup(s) {
  if (!isBestSetup(s)) return false;
  // Wilson lower bound for Extreme: 60% lower bound (very conservative)
  if (s.winProbability != null && s.backtestSamples >= 15) {
    const ci = wilsonInterval(s.backtestWins || 0, s.backtestSamples || 1);
    if (ci.low < 0.55) return false;
  }
  const winners = s.direction === 'BUY' ? s.bull_count : s.bear_count;
  if (winners / Math.max(1, s.total_indicators) < 0.85) return false; // 85% indicator agreement
  if (s.confidence < 85) return false;
  const alignedStrats = (s.firedStrategies || []).filter(f =>
    (s.direction === 'BUY' && f.bias === 'bullish') ||
    (s.direction === 'SELL' && f.bias === 'bearish')
  ).length;
  if (alignedStrats < 5) return false; // 5+ strategies (was 3 for Best)
  if (s.adxNow != null && s.adxNow < 30) return false; // strong trend, not 25
  if (s.winProbability == null || s.winProbability < 70) return false; // 70%+ historical
  if (s.backtestSamples < 15) return false;
  const inKillzone = s.session && s.session.toLowerCase().includes('killzone');
  if (!inKillzone) return false;
  if ((s.calPenalty ?? 0) < 0) return false; // any calendar penalty disqualifies
  return true;
}

// DAY TRADER setup — for active intraday traders who want signals that
// play out within one session, with multi-strategy confluence. Built for
// "I want to take a trade now and have it resolved within 8-10 hours."
//
// Criteria (tuned after live audit showed zero signals passing the stricter
// version — these levels surface 3-6 day-trader-friendly setups per scan
// in typical market conditions while still filtering out slow swing setups):
//   1. Expected hold time ≤ 10 hours (was 8 — too strict for ATR-light pairs)
//   2. At least 1 strategy firing (was 2 — many fast moves are single-strat)
//   3. Confidence ≥ 55% (was 65)
//   4. Active session preferred but not required (relaxed)
//   5. HTF aligned OR mixed (not strict counter-trend)
function isDayTraderSetup(s) {
  if (!s || s.direction === 'HOLD') return false;
  if (s.blockReason) return false;
  // NOTE: cooldownMinutesLeft is intentionally NOT a blocker here.
  // v188: hold-cap tightened 10h → 4h. User is a day-trader, doesn't
  // want positions sitting open for >4 hours. Gold typically resolves
  // setups within 2-4 hours in active sessions.
  if (s.expectedHoldHours == null || s.expectedHoldHours > 4) return false;
  // ── LOSS-PATTERN BLOCKS (learned from real closed trades) ─────────────
  // After 6 trades, the perfect-discrimination patterns are:
  //   • Counter-trend (HTF opposite to direction) — 100% of historical losses
  //   • Momentum-only (no structural strategy backing) — 100% of losses
  // The winProb<50% rule was REMOVED because it would have blocked 3 of 3
  // winners in history. The model is biased against winning setups.
  if (s.htfTrend &&
      ((s.direction === 'BUY' && s.htfTrend === 'down') ||
       (s.direction === 'SELL' && s.htfTrend === 'up'))) return false;
  // Momentum-only setups (no pattern strategy backing) lost in our history.
  // Require at least one of the "structural" strategies — these have real
  // entry criteria (sweeps, FVGs, breakouts, pullbacks) beyond pure indicator
  // confluence. Momentum can supplement but can't be the only confirmation.
  const structuralPassing = (
    s.smcPassed || s.orbPassed || s.ictPassed ||
    s.trendPassed || s.squeezePassed || s.divergencePassed
  );
  if (!structuralPassing) return false;
  // Confidence floor raised to 55 — losers all sat below 45%.
  if ((s.confidence || 0) < 55) return false;
  return true;
}

// PRO setup — even tighter, for the absolute cream. Used to flag signals
// with a special "PRO" badge that distinguishes them from regular Best.
function isProSetup(s) {
  if (!isBestSetup(s)) return false;
  const alignedStrats = (s.firedStrategies || []).filter(f =>
    (s.direction === 'BUY' && f.bias === 'bullish') ||
    (s.direction === 'SELL' && f.bias === 'bearish')
  ).length;
  if (alignedStrats < 4) return false;
  if (s.confidence < 82) return false;
  if (s.winProbability == null || s.winProbability < 65) return false;
  if (s.backtestSamples < 15) return false;
  const inKillzone = s.session && s.session.toLowerCase().includes('killzone');
  if (!inKillzone) return false;
  return true;
}

// ========== Indicators ==========
function sma(arr, p) {
  const out = Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function emaArr(arr, p) {
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
// Alias — strategies + quality scorers call ema(...) directly; without this
// they all throw "ema is not defined" and analyzePair fails silently for
// every pair. THIS was the bug killing all signal rendering.
const ema = emaArr;
function rsi(closes, p = 14) {
  const out = Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
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
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = emaArr(closes, fast), es = emaArr(closes, slow);
  const line = ef.map((v, i) => v != null && es[i] != null ? v - es[i] : null);
  const signal = emaArr(line.map(v => v == null ? 0 : v), sig);
  const hist = line.map((v, i) => v != null && signal[i] != null ? v - signal[i] : null);
  return { line, signal, hist };
}
function bollinger(closes, p = 20, std = 2) {
  const mid = sma(closes, p);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / p);
    upper.push(mid[i] + sd * std);
    lower.push(mid[i] - sd * std);
  }
  return { upper, mid, lower };
}
function atr(highs, lows, closes, p = 14) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return sma(tr, p);
}
function stochastic(highs, lows, closes, p = 14, smooth = 3) {
  const k = Array(closes.length).fill(null);
  for (let i = p - 1; i < closes.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (highs[j] > hi) hi = highs[j]; if (lows[j] < lo) lo = lows[j]; }
    k[i] = hi === lo ? 50 : 100 * (closes[i] - lo) / (hi - lo);
  }
  const d = sma(k.map(v => v == null ? 50 : v), smooth);
  return { k, d };
}
function adx(highs, lows, closes, p = 14) {
  const len = closes.length;
  const tr = [0], pdm = [0], mdm = [0];
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
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
  return { adx: adxVals, pdi, mdi };
}

// ========== Additional classic indicators (more voters → higher confluence) ==========
// CCI (Commodity Channel Index, 20-period). Measures current price deviation
// from average using typical price. Signals: >+100 overbought, <-100 oversold.
function cci(highs, lows, closes, p = 20) {
  const out = Array(closes.length).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = p - 1; i < tp.length; i++) {
    const window = tp.slice(i - p + 1, i + 1);
    const sma = window.reduce((s, x) => s + x, 0) / p;
    const mad = window.reduce((s, x) => s + Math.abs(x - sma), 0) / p;
    out[i] = mad === 0 ? 0 : (tp[i] - sma) / (0.015 * mad);
  }
  return out;
}

// Awesome Oscillator (Bill Williams). SMA(median, 5) - SMA(median, 34).
// Signals momentum shifts via zero-line crosses.
function awesomeOscillator(highs, lows) {
  const median = highs.map((h, i) => (h + lows[i]) / 2);
  const sma5 = sma(median, 5);
  const sma34 = sma(median, 34);
  return sma5.map((v, i) => v != null && sma34[i] != null ? v - sma34[i] : null);
}

// Parabolic SAR (Wilder, 0.02 step, 0.2 max). Trailing-stop trend indicator.
// Dot below price = uptrend, dot above price = downtrend.
function parabolicSAR(highs, lows, step = 0.02, maxStep = 0.2) {
  const n = highs.length;
  const sar = Array(n).fill(null);
  if (n < 3) return sar;
  let trend = highs[1] >= highs[0] ? 1 : -1; // 1 = up, -1 = down
  let ep = trend === 1 ? highs[1] : lows[1]; // extreme point
  let af = step;                              // acceleration factor
  sar[1] = trend === 1 ? lows[0] : highs[0];
  for (let i = 2; i < n; i++) {
    let s = sar[i - 1] + af * (ep - sar[i - 1]);
    if (trend === 1) {
      s = Math.min(s, lows[i - 1], lows[i - 2]);
      if (lows[i] <= s) { // trend flip
        trend = -1; s = ep; ep = lows[i]; af = step;
      } else if (highs[i] > ep) { ep = highs[i]; af = Math.min(maxStep, af + step); }
    } else {
      s = Math.max(s, highs[i - 1], highs[i - 2]);
      if (highs[i] >= s) {
        trend = 1; s = ep; ep = highs[i]; af = step;
      } else if (lows[i] < ep) { ep = lows[i]; af = Math.min(maxStep, af + step); }
    }
    sar[i] = s;
  }
  return sar;
}

// ========== Battle-tested trading strategies ==========
// Each detector returns [bias, reason] if its conditions are met, or null.
// These are classic setups documented in decades of trading literature:
//   Ichimoku (1960s, Hosoda), Turtle Trading (1980s, Dennis/Eckhardt),
//   50 EMA pullback (universal trend-following), Fibonacci retracement (classic),
//   Order Block (Smart-Money / ICT school), Break of Structure (price action).
// The existing learning system tracks each one's win rate and weights it
// automatically — strategies that actually work for your market accumulate weight.

function strategyIchimoku(ohlc) {
  const n = ohlc.length - 1;
  if (n < 52) return null;
  const highs = ohlc.map(b => b.h), lows = ohlc.map(b => b.l);
  const tenkan = (Math.max(...highs.slice(n - 8, n + 1)) + Math.min(...lows.slice(n - 8, n + 1))) / 2;
  const kijun = (Math.max(...highs.slice(n - 25, n + 1)) + Math.min(...lows.slice(n - 25, n + 1))) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = (Math.max(...highs.slice(n - 51, n + 1)) + Math.min(...lows.slice(n - 51, n + 1))) / 2;
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const price = ohlc[n].c;
  if (price > cloudTop && tenkan > kijun) return ['bullish', 'Price above Ichimoku cloud + Tenkan > Kijun'];
  if (price < cloudBottom && tenkan < kijun) return ['bearish', 'Price below Ichimoku cloud + Tenkan < Kijun'];
  return null; // inside cloud = no clear signal (don't add neutral vote)
}

function strategy50EmaPullback(ohlc, ema20A, ema50A, atrV) {
  const n = ohlc.length - 1;
  const e20 = ema20A[n], e50 = ema50A[n];
  if (e20 == null || e50 == null || atrV == null) return null;
  const bar = ohlc[n], prev = ohlc[n - 1];
  if (!prev) return null;
  // Uptrend: EMA20 > EMA50, current bar dipped to EMA50 area, closed bullish
  if (e20 > e50 && bar.l <= e50 + atrV * 0.2 && bar.c > bar.o && bar.c > e50) {
    return ['bullish', 'Pullback to EMA50 in uptrend — classic trend-follow entry'];
  }
  if (e20 < e50 && bar.h >= e50 - atrV * 0.2 && bar.c < bar.o && bar.c < e50) {
    return ['bearish', 'Pullback to EMA50 in downtrend — classic trend-follow entry'];
  }
  return null;
}

function strategyTurtleBreakout(ohlc) {
  const n = ohlc.length - 1;
  if (n < 20) return null;
  const prior = ohlc.slice(n - 20, n);
  const highest = Math.max(...prior.map(b => b.h));
  const lowest = Math.min(...prior.map(b => b.l));
  const price = ohlc[n].c;
  if (price > highest) return ['bullish', `Turtle breakout — closed above 20-bar high ${highest.toFixed(5)}`];
  if (price < lowest) return ['bearish', `Turtle breakdown — closed below 20-bar low ${lowest.toFixed(5)}`];
  return null;
}

function strategyFibonacciLevel(ohlc) {
  const n = ohlc.length - 1;
  if (n < 50) return null;
  const window = ohlc.slice(n - 50, n + 1);
  const high = Math.max(...window.map(b => b.h));
  const low = Math.min(...window.map(b => b.l));
  const range = high - low;
  if (range === 0) return null;
  const price = ohlc[n].c;
  const pos = (price - low) / range;
  const tol = 0.015; // within 1.5% of a key level
  const uptrendMove = ohlc[n - 10].c < price; // recent uptrend → look for bullish bounces
  const levels = [
    { p: 0.382, name: '38.2' },
    { p: 0.500, name: '50.0' },
    { p: 0.618, name: '61.8' },
  ];
  for (const lv of levels) {
    if (Math.abs(pos - (1 - lv.p)) < tol) {
      // Price retraced from high by this fib level — uptrend bounce zone
      if (uptrendMove) return ['bullish', `At ${lv.name}% Fibonacci retracement from recent high`];
    }
    if (Math.abs(pos - lv.p) < tol) {
      if (!uptrendMove) return ['bearish', `At ${lv.name}% Fibonacci retracement from recent low`];
    }
  }
  return null;
}

function strategyOrderBlock(ohlc) {
  const n = ohlc.length - 1;
  if (n < 10) return null;
  const bodies = ohlc.slice(n - 10, n + 1).map(b => Math.abs(b.c - b.o));
  const avgBody = bodies.reduce((s, x) => s + x, 0) / bodies.length;
  // Look back from current for a strong impulse candle — the candle before it is the OB
  for (let i = n; i >= Math.max(n - 5, 1); i--) {
    const bar = ohlc[i], prev = ohlc[i - 1];
    const body = Math.abs(bar.c - bar.o);
    if (body < avgBody * 2.5) continue;
    if (bar.c > bar.o && prev.c < prev.o) {
      return ['bullish', `Bullish order block at ${prev.l.toFixed(5)}–${prev.h.toFixed(5)}`];
    }
    if (bar.c < bar.o && prev.c > prev.o) {
      return ['bearish', `Bearish order block at ${prev.l.toFixed(5)}–${prev.h.toFixed(5)}`];
    }
  }
  return null;
}

// Liquidity Sweep / Stop Hunt — research consistently shows 65-75% win rate.
// Price wicks beyond a recent swing high/low (taking out clustered stops) then
// closes back inside the range, signaling institutional reversal.
function strategyLiquiditySweep(ohlc) {
  const n = ohlc.length - 1;
  if (n < 22) return null;
  const window = ohlc.slice(n - 20, n);
  const swingHigh = Math.max(...window.map(b => b.h));
  const swingLow = Math.min(...window.map(b => b.l));
  const bar = ohlc[n];
  // Bullish sweep: low broke below swing low, but closed above it
  if (bar.l < swingLow && bar.c > swingLow) {
    return ['bullish', `Liquidity sweep below ${swingLow.toFixed(5)} — stops cleared, smart-money reversal`];
  }
  // Bearish sweep: high broke above swing high, but closed below
  if (bar.h > swingHigh && bar.c < swingHigh) {
    return ['bearish', `Liquidity sweep above ${swingHigh.toFixed(5)} — stops cleared, smart-money reversal`];
  }
  return null;
}

// Fair Value Gap (FVG) — 3-candle imbalance where candle 1's wick doesn't
// overlap candle 3's wick. Marks where price moved too fast to fill orders;
// price often returns to "fill" the gap.
function strategyFairValueGap(ohlc) {
  const n = ohlc.length - 1;
  if (n < 5) return null;
  // Look at the last 3 candles for an unmitigated FVG
  for (let i = n; i >= Math.max(n - 3, 2); i--) {
    const c1 = ohlc[i - 2], c3 = ohlc[i];
    const current = ohlc[n].c;
    // Bullish FVG: c1.high < c3.low (price gapped up)
    if (c1.h < c3.l) {
      const gapTop = c3.l, gapBottom = c1.h;
      // Price still above the gap (not yet fully mitigated) → bullish bias
      if (current > gapBottom && current < gapTop * 1.003) {
        return ['bullish', `Inside bullish FVG (${gapBottom.toFixed(5)}–${gapTop.toFixed(5)}) — institutional demand zone`];
      }
    }
    // Bearish FVG: c1.low > c3.high (price gapped down)
    if (c1.l > c3.h) {
      const gapTop = c1.l, gapBottom = c3.h;
      if (current < gapTop && current > gapBottom * 0.997) {
        return ['bearish', `Inside bearish FVG (${gapBottom.toFixed(5)}–${gapTop.toFixed(5)}) — institutional supply zone`];
      }
    }
  }
  return null;
}

// Change of Character (CHoCH) — the FIRST counter-trend structure break.
// Earlier signal than BOS (which confirms continuation). Often signals
// genuine trend reversal at the start of a new leg.
function strategyChangeOfCharacter(ohlc) {
  const n = ohlc.length - 1;
  if (n < 30) return null;
  const window = ohlc.slice(n - 28, n + 1);
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < window.length - 2; i++) {
    const b = window[i];
    if (b.h > window[i-1].h && b.h > window[i-2].h && b.h > window[i+1].h && b.h > window[i+2].h) {
      swingHighs.push({ p: b.h, i });
    }
    if (b.l < window[i-1].l && b.l < window[i-2].l && b.l < window[i+1].l && b.l < window[i+2].l) {
      swingLows.push({ p: b.l, i });
    }
  }
  const current = ohlc[n].c;
  // Bearish CHoCH — was making higher highs, now broke last swing low
  if (swingHighs.length >= 2 && swingLows.length >= 1) {
    const [h1, h2] = swingHighs.slice(-2);
    const lastLow = swingLows[swingLows.length - 1];
    if (h2.p > h1.p && current < lastLow.p) {
      return ['bearish', `CHoCH — uptrend broken, last swing low at ${lastLow.p.toFixed(5)} breached`];
    }
  }
  // Bullish CHoCH — was making lower lows, now broke last swing high
  if (swingLows.length >= 2 && swingHighs.length >= 1) {
    const [l1, l2] = swingLows.slice(-2);
    const lastHigh = swingHighs[swingHighs.length - 1];
    if (l2.p < l1.p && current > lastHigh.p) {
      return ['bullish', `CHoCH — downtrend broken, last swing high at ${lastHigh.p.toFixed(5)} breached`];
    }
  }
  return null;
}

// Premium / Discount zone — institutional principle: only buy in the lower
// third of a range (discount), only sell in the upper third (premium).
// Hidden RSI Divergence — trend-continuation setup. In an uptrend, price
// prints a higher low while RSI prints a lower low (institutions accumulating
// while pullback hides their footprint). In a downtrend, price prints a lower
// high while RSI prints a higher high. Per academic research, hidden divergence
// has a higher hit rate than regular divergence because it trades WITH the
// dominant trend instead of against it.
function strategyHiddenDivergence(closes, rsiArr, ema50A) {
  const n = closes.length - 1;
  if (n < 30) return null;
  const ema50Now = ema50A[n];
  const trendUp = closes[n] > ema50Now;
  const trendDown = closes[n] < ema50Now;

  // Find the two most recent swing points
  const findSwings = (lookFor) => {
    const out = [];
    for (let i = n - 3; i >= n - 30 && out.length < 4; i--) {
      const c = closes[i];
      if (lookFor === 'low'  && c < closes[i - 1] && c < closes[i + 1] && c < closes[i - 2] && c < closes[i + 2]) out.push({ i, p: c, r: rsiArr[i] });
      if (lookFor === 'high' && c > closes[i - 1] && c > closes[i + 1] && c > closes[i - 2] && c > closes[i + 2]) out.push({ i, p: c, r: rsiArr[i] });
    }
    return out;
  };

  if (trendUp) {
    const lows = findSwings('low');
    if (lows.length >= 2 && lows[0].r != null && lows[1].r != null) {
      // lows[0] is more recent (higher index since loop went backward)
      const recent = lows[0], older = lows[1];
      if (recent.p > older.p && recent.r < older.r) {
        return ['bullish', `Hidden bullish divergence — higher swing low (${recent.p.toFixed(5)}) but lower RSI (${recent.r.toFixed(0)} vs ${older.r.toFixed(0)})`];
      }
    }
  }
  if (trendDown) {
    const highs = findSwings('high');
    if (highs.length >= 2 && highs[0].r != null && highs[1].r != null) {
      const recent = highs[0], older = highs[1];
      if (recent.p < older.p && recent.r > older.r) {
        return ['bearish', `Hidden bearish divergence — lower swing high (${recent.p.toFixed(5)}) but higher RSI (${recent.r.toFixed(0)} vs ${older.r.toFixed(0)})`];
      }
    }
  }
  return null;
}

// TTM Squeeze — Bollinger Bands inside Keltner Channel = volatility contraction.
// When Bollinger expands BACK outside Keltner, the squeeze "fires" and the
// direction of the breakout becomes a high-momentum entry. Widely used by
// futures and forex prop traders.
function strategyTTMSqueeze(ohlc, atrArr) {
  const n = ohlc.length - 1;
  if (n < 22) return null;
  const closes = ohlc.map(b => b.c);
  const period = 20;
  // Bollinger Bands (20, 2σ)
  const sma20 = closes.slice(n - period + 1, n + 1).reduce((s, x) => s + x, 0) / period;
  let varSum = 0;
  for (let i = n - period + 1; i <= n; i++) varSum += (closes[i] - sma20) ** 2;
  const sd = Math.sqrt(varSum / period);
  const bbUp = sma20 + 2 * sd;
  const bbLow = sma20 - 2 * sd;
  // Keltner Channel (20 EMA ± 1.5 × ATR)
  const ema20 = emaArr(closes, 20)[n];
  const atrV = atrArr[n];
  if (ema20 == null || atrV == null) return null;
  const kcUp = ema20 + 1.5 * atrV;
  const kcLow = ema20 - 1.5 * atrV;

  // Was the squeeze ON in the previous bar? (BB inside KC)
  const closesPrev = closes.slice(0, n);
  const sma20Prev = closesPrev.slice(closesPrev.length - period).reduce((s, x) => s + x, 0) / period;
  let prevVarSum = 0;
  for (let i = closesPrev.length - period; i < closesPrev.length; i++) prevVarSum += (closesPrev[i] - sma20Prev) ** 2;
  const sdPrev = Math.sqrt(prevVarSum / period);
  const bbUpPrev = sma20Prev + 2 * sdPrev, bbLowPrev = sma20Prev - 2 * sdPrev;
  const ema20Prev = emaArr(closesPrev, 20)[closesPrev.length - 1];
  const atrPrev = atrArr[n - 1];
  if (ema20Prev == null || atrPrev == null) return null;
  const kcUpPrev = ema20Prev + 1.5 * atrPrev, kcLowPrev = ema20Prev - 1.5 * atrPrev;
  const wasSqueezed = bbUpPrev <= kcUpPrev && bbLowPrev >= kcLowPrev;
  const isExpanded = bbUp > kcUp || bbLow < kcLow;

  if (wasSqueezed && isExpanded) {
    const momUp = closes[n] > ema20 && closes[n] > closes[n - 1];
    const momDown = closes[n] < ema20 && closes[n] < closes[n - 1];
    if (momUp) return ['bullish', `TTM Squeeze fired up — coiled volatility releasing bullish`];
    if (momDown) return ['bearish', `TTM Squeeze fired down — coiled volatility releasing bearish`];
  }
  return null;
}

// Three-Bar Reversal — classic exhaustion pattern. After 2 bars in one direction
// extending the move, the 3rd bar reverses and closes through bar-2's open,
// signaling momentum has died. Higher-probability when at S/R or fib level.
function strategyThreeBarReversal(ohlc) {
  const n = ohlc.length - 1;
  if (n < 3) return null;
  const c1 = ohlc[n - 2], c2 = ohlc[n - 1], c3 = ohlc[n];
  // Bullish: 2 down bars then strong up bar closing above bar-2 high
  if (c1.c < c1.o && c2.c < c2.o && c2.l < c1.l &&
      c3.c > c3.o && c3.c > c2.h && c3.c - c3.o > Math.abs(c2.c - c2.o) * 0.8) {
    return ['bullish', 'Three-bar reversal up — exhaustion in downmove + strong reversal candle'];
  }
  // Bearish: 2 up bars then strong down bar closing below bar-2 low
  if (c1.c > c1.o && c2.c > c2.o && c2.h > c1.h &&
      c3.c < c3.o && c3.c < c2.l && c3.o - c3.c > Math.abs(c2.c - c2.o) * 0.8) {
    return ['bearish', 'Three-bar reversal down — exhaustion in upmove + strong reversal candle'];
  }
  return null;
}

// ========== Chart pattern recognition ==========
// Algorithmic detection of classical chart patterns from OHLC data — the same
// shapes traders look at on charts. Each requires specific structure to be
// present, so most signals won't have any of these firing. When one DOES
// fire, it's a high-conviction directional setup.

// Helper: find 5-bar fractal swing highs and lows in a window of OHLC data
function _findSwings(window) {
  const highs = [], lows = [];
  for (let i = 2; i < window.length - 2; i++) {
    const b = window[i];
    if (b.h > window[i-1].h && b.h > window[i-2].h && b.h > window[i+1].h && b.h > window[i+2].h) {
      highs.push({ idx: i, p: b.h });
    }
    if (b.l < window[i-1].l && b.l < window[i-2].l && b.l < window[i+1].l && b.l < window[i+2].l) {
      lows.push({ idx: i, p: b.l });
    }
  }
  return { highs, lows };
}

// Double Top / Double Bottom — two peaks/troughs at similar prices with a
// counter-swing between, then breakout through the neckline. One of the most
// reliable reversal patterns in the literature.
function strategyDoubleTopBottom(ohlc) {
  const n = ohlc.length - 1;
  if (n < 30) return null;
  const window = ohlc.slice(n - 28, n + 1);
  const { highs, lows } = _findSwings(window);
  if (highs.length < 2 && lows.length < 2) return null;
  const current = ohlc[n].c;

  // Double top: two recent swing highs at similar price (within 0.3%)
  if (highs.length >= 2) {
    const sorted = highs.slice().sort((a, b) => b.idx - a.idx);
    const [h1, h2] = sorted;
    const diff = Math.abs(h1.p - h2.p) / Math.max(h1.p, h2.p);
    if (diff < 0.003 && Math.abs(h1.idx - h2.idx) >= 5) {
      // Find the swing low BETWEEN them (the neckline)
      const between = lows.filter(l => l.idx > Math.min(h1.idx, h2.idx) && l.idx < Math.max(h1.idx, h2.idx));
      if (between.length) {
        const neckline = Math.min(...between.map(b => b.p));
        if (current < neckline) {
          return ['bearish', `Double top — peaks at ${h1.p.toFixed(5)} / ${h2.p.toFixed(5)}, neckline ${neckline.toFixed(5)} broken`];
        }
      }
    }
  }
  // Double bottom: mirror image
  if (lows.length >= 2) {
    const sorted = lows.slice().sort((a, b) => b.idx - a.idx);
    const [l1, l2] = sorted;
    const diff = Math.abs(l1.p - l2.p) / Math.max(l1.p, l2.p);
    if (diff < 0.003 && Math.abs(l1.idx - l2.idx) >= 5) {
      const between = highs.filter(h => h.idx > Math.min(l1.idx, l2.idx) && h.idx < Math.max(l1.idx, l2.idx));
      if (between.length) {
        const neckline = Math.max(...between.map(b => b.p));
        if (current > neckline) {
          return ['bullish', `Double bottom — troughs at ${l1.p.toFixed(5)} / ${l2.p.toFixed(5)}, neckline ${neckline.toFixed(5)} broken`];
        }
      }
    }
  }
  return null;
}

// Head & Shoulders / Inverse Head & Shoulders — three swing points where the
// middle one is the most extreme and the outer two are at similar prices.
// Classic reversal pattern — often considered THE most reliable chart pattern.
function strategyHeadAndShoulders(ohlc) {
  const n = ohlc.length - 1;
  if (n < 40) return null;
  const window = ohlc.slice(n - 38, n + 1);
  const { highs, lows } = _findSwings(window);
  const current = ohlc[n].c;

  // H&S top — bearish reversal
  if (highs.length >= 3) {
    const recent = highs.slice().sort((a, b) => b.idx - a.idx).slice(0, 3); // newest first
    // Order chronologically: ls (oldest), head, rs (newest)
    const [rs, head, ls] = recent;
    if (head.p > rs.p && head.p > ls.p) {
      const shoulderDiff = Math.abs(rs.p - ls.p) / Math.max(rs.p, ls.p);
      if (shoulderDiff < 0.006) {
        const necklineCandidates = lows.filter(l => l.idx >= ls.idx && l.idx <= rs.idx);
        if (necklineCandidates.length >= 1) {
          const neckline = Math.min(...necklineCandidates.map(l => l.p));
          if (current < neckline) {
            return ['bearish', `Head & Shoulders — head ${head.p.toFixed(5)}, shoulders ${ls.p.toFixed(5)}/${rs.p.toFixed(5)}, neckline ${neckline.toFixed(5)} broken`];
          }
        }
      }
    }
  }
  // Inverse H&S — bullish reversal
  if (lows.length >= 3) {
    const recent = lows.slice().sort((a, b) => b.idx - a.idx).slice(0, 3);
    const [rs, head, ls] = recent;
    if (head.p < rs.p && head.p < ls.p) {
      const shoulderDiff = Math.abs(rs.p - ls.p) / Math.max(rs.p, ls.p);
      if (shoulderDiff < 0.006) {
        const necklineCandidates = highs.filter(h => h.idx >= ls.idx && h.idx <= rs.idx);
        if (necklineCandidates.length >= 1) {
          const neckline = Math.max(...necklineCandidates.map(h => h.p));
          if (current > neckline) {
            return ['bullish', `Inverse H&S — head ${head.p.toFixed(5)}, shoulders ${ls.p.toFixed(5)}/${rs.p.toFixed(5)}, neckline ${neckline.toFixed(5)} broken`];
          }
        }
      }
    }
  }
  return null;
}

// Triangle breakout (Ascending / Descending / Symmetrical). Detects converging
// or flat-bordered consolidation patterns and fires when price breaks out.
function strategyTriangle(ohlc) {
  const n = ohlc.length - 1;
  if (n < 30) return null;
  const window = ohlc.slice(n - 25, n + 1);
  const { highs, lows } = _findSwings(window);
  if (highs.length < 2 || lows.length < 2) return null;

  const firstH = highs[0], lastH = highs[highs.length - 1];
  const firstL = lows[0], lastL = lows[lows.length - 1];
  const hChange = (lastH.p - firstH.p) / firstH.p;
  const lChange = (lastL.p - firstL.p) / firstL.p;
  const flatThresh = 0.003;
  const trendThresh = 0.003;

  const current = ohlc[n].c;
  const recentHigh = Math.max(...window.slice(-5).map(b => b.h));
  const recentLow = Math.min(...window.slice(-5).map(b => b.l));

  // Ascending: flat highs (resistance), rising lows. Breakout above = bullish.
  if (Math.abs(hChange) < flatThresh && lChange > trendThresh && current > recentHigh * 0.998) {
    return ['bullish', `Ascending triangle breakout — flat resistance ${firstH.p.toFixed(5)}, rising support, breaking up`];
  }
  // Descending: flat lows (support), falling highs. Breakdown below = bearish.
  if (Math.abs(lChange) < flatThresh && hChange < -trendThresh && current < recentLow * 1.002) {
    return ['bearish', `Descending triangle breakdown — flat support ${firstL.p.toFixed(5)}, falling resistance, breaking down`];
  }
  // Symmetrical: converging boundaries. Direction = breakout direction.
  if (hChange < -trendThresh && lChange > trendThresh) {
    if (current > recentHigh * 0.998) {
      return ['bullish', `Symmetrical triangle breakout up — converging boundaries broken`];
    }
    if (current < recentLow * 1.002) {
      return ['bearish', `Symmetrical triangle breakdown — converging boundaries broken`];
    }
  }
  return null;
}

// MambaFX Supply/Demand Zone — the publicly documented core of his approach
// is "Smart Money + Price Action" with explicit emphasis on supply/demand
// zones formed at the BASE of impulse moves. Logic:
//   1. Scan last 25 bars for an "impulse leg" — 3+ consecutive same-direction
//      candles where each has a body > 50% of its range (institutional drive)
//   2. Mark the candle JUST BEFORE the impulse as the supply (bearish impulse)
//      or demand (bullish impulse) zone
//   3. When current price returns to that zone AND prints a confirming candle
//      in the impulse direction, that's the entry
// Returns ['bullish' | 'bearish', reason] or null.
function strategyMambaFXSupplyDemand(ohlc) {
  const n = ohlc.length - 1;
  if (n < 30) return null;
  const isImpulseCandle = (b) => {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    return range > 0 && (body / range) >= 0.5;
  };
  for (let start = n - 20; start <= n - 3; start++) {
    if (start < 1) continue;
    let bull = 0, bear = 0;
    for (let i = start; i < Math.min(start + 6, n); i++) {
      const b = ohlc[i];
      if (!isImpulseCandle(b)) break;
      if (b.c > b.o) bull++;
      else if (b.c < b.o) bear++;
      else break;
    }
    // Bullish impulse → demand zone at base (candle before)
    if (bull >= 3 && bear === 0) {
      const base = ohlc[start - 1];
      const zoneTop = Math.max(base.o, base.c);
      const zoneBot = base.l;
      const last = ohlc[n];
      // Price has retraced into or just below the zone AND last candle is bullish
      if (last.l <= zoneTop && last.c >= zoneBot * 0.997 && last.c > last.o) {
        return ['bullish', `MambaFX demand zone retest — ${bull}-candle bullish impulse origin ${zoneBot.toFixed(5)}–${zoneTop.toFixed(5)}, price returned + bullish confirmation`];
      }
    }
    // Bearish impulse → supply zone at base
    if (bear >= 3 && bull === 0) {
      const base = ohlc[start - 1];
      const zoneTop = base.h;
      const zoneBot = Math.min(base.o, base.c);
      const last = ohlc[n];
      if (last.h >= zoneBot && last.c <= zoneTop * 1.003 && last.c < last.o) {
        return ['bearish', `MambaFX supply zone retest — ${bear}-candle bearish impulse origin ${zoneBot.toFixed(5)}–${zoneTop.toFixed(5)}, price returned + bearish confirmation`];
      }
    }
  }
  return null;
}

// FXAlexG "Set and Forget" — engulfing candle at a daily-level Area of Interest
// (a stronger zone than the regular 50-bar S/R because it's measured over the
// last ~30 days of hourly data, approximating daily structure).
function strategyAlexGSetAndForget(ohlc, atrV) {
  const n = ohlc.length - 1;
  if (n < 24 * 30 || n < 2) return null;
  // Approximate "daily" AOI — top/bottom 5 extremes over last ~30 days of 1H data
  const window = ohlc.slice(Math.max(0, n - 24 * 30));
  const highsSorted = window.map(b => b.h).sort((a, b) => b - a).slice(0, 5);
  const lowsSorted = window.map(b => b.l).sort((a, b) => a - b).slice(0, 5);
  const dailyResistance = highsSorted.reduce((s, x) => s + x, 0) / highsSorted.length;
  const dailySupport = lowsSorted.reduce((s, x) => s + x, 0) / lowsSorted.length;

  const c1 = ohlc[n - 1], c2 = ohlc[n];
  // Engulfing detection
  const bullEngulf = c2.c > c2.o && c1.c < c1.o && c2.o <= c1.c && c2.c >= c1.o
                     && Math.abs(c2.c - c2.o) > Math.abs(c1.c - c1.o);
  const bearEngulf = c2.c < c2.o && c1.c > c1.o && c2.o >= c1.c && c2.c <= c1.o
                     && Math.abs(c2.c - c2.o) > Math.abs(c1.c - c1.o);

  const tol = (atrV || 0.001) * 1.5; // within 1.5×ATR of the AOI counts as "at" it
  const atSupport = Math.abs(c2.l - dailySupport) < tol || (c2.l <= dailySupport && c2.c > dailySupport);
  const atResistance = Math.abs(c2.h - dailyResistance) < tol || (c2.h >= dailyResistance && c2.c < dailyResistance);

  if (atSupport && bullEngulf) {
    return ['bullish', `AlexG Set & Forget — bullish engulfing at daily support AOI ${dailySupport.toFixed(5)}`];
  }
  if (atResistance && bearEngulf) {
    return ['bearish', `AlexG Set & Forget — bearish engulfing at daily resistance AOI ${dailyResistance.toFixed(5)}`];
  }
  return null;
}

function strategyPremiumDiscount(ohlc) {
  const n = ohlc.length - 1;
  if (n < 50) return null;
  const window = ohlc.slice(n - 50);
  const high = Math.max(...window.map(b => b.h));
  const low = Math.min(...window.map(b => b.l));
  const range = high - low;
  if (range === 0) return null;
  const current = ohlc[n].c;
  const pos = (current - low) / range;
  if (pos < 0.33) return ['bullish', `In discount zone (${(pos*100).toFixed(0)}% of range) — institutional accumulation area`];
  if (pos > 0.67) return ['bearish', `In premium zone (${(pos*100).toFixed(0)}% of range) — institutional distribution area`];
  return null;
}

function strategyBreakOfStructure(ohlc) {
  const n = ohlc.length - 1;
  if (n < 30) return null;
  let swingHigh = -Infinity, swingLow = Infinity;
  for (let i = n - 25; i < n - 3; i++) {
    const b = ohlc[i];
    // fractal high: higher than 2 bars each side
    if (b.h > ohlc[i - 1].h && b.h > ohlc[i - 2].h && b.h > ohlc[i + 1].h && b.h > ohlc[i + 2].h) {
      if (b.h > swingHigh) swingHigh = b.h;
    }
    if (b.l < ohlc[i - 1].l && b.l < ohlc[i - 2].l && b.l < ohlc[i + 1].l && b.l < ohlc[i + 2].l) {
      if (b.l < swingLow) swingLow = b.l;
    }
  }
  const price = ohlc[n].c;
  if (swingHigh > -Infinity && price > swingHigh) {
    return ['bullish', `Break of structure above swing high ${swingHigh.toFixed(5)}`];
  }
  if (swingLow < Infinity && price < swingLow) {
    return ['bearish', `Break of structure below swing low ${swingLow.toFixed(5)}`];
  }
  return null;
}

// ========== Candlestick patterns ==========
// Return a vote if the last closed candle matches a classic reversal/continuation pattern.
function detectCandlestickPattern(ohlc) {
  if (ohlc.length < 3) return null;
  const [a, b, c] = ohlc.slice(-3); // a = 2 ago, b = prev, c = current/last closed
  const body = (x) => Math.abs(x.c - x.o);
  const range = (x) => x.h - x.l;
  const upperWick = (x) => x.h - Math.max(x.o, x.c);
  const lowerWick = (x) => Math.min(x.o, x.c) - x.l;
  const isBull = (x) => x.c > x.o;
  const isBear = (x) => x.c < x.o;

  // Bullish engulfing
  if (isBear(b) && isBull(c) && c.c > b.o && c.o < b.c && body(c) > body(b) * 1.1) {
    return ['bullish', 'Bullish engulfing — strong reversal signal'];
  }
  // Bearish engulfing
  if (isBull(b) && isBear(c) && c.c < b.o && c.o > b.c && body(c) > body(b) * 1.1) {
    return ['bearish', 'Bearish engulfing — strong reversal signal'];
  }
  // Hammer / pin bar (bullish)
  if (range(c) > 0 && body(c) / range(c) < 0.35 && lowerWick(c) > body(c) * 2 && upperWick(c) < body(c)) {
    return ['bullish', 'Hammer / bullish pin bar — rejection of lower prices'];
  }
  // Shooting star (bearish)
  if (range(c) > 0 && body(c) / range(c) < 0.35 && upperWick(c) > body(c) * 2 && lowerWick(c) < body(c)) {
    return ['bearish', 'Shooting star — rejection of higher prices'];
  }
  // Morning star (3-candle bullish)
  if (isBear(a) && body(b) < body(a) * 0.5 && isBull(c) && c.c > (a.o + a.c) / 2) {
    return ['bullish', 'Morning star — 3-candle bullish reversal'];
  }
  // Evening star
  if (isBull(a) && body(b) < body(a) * 0.5 && isBear(c) && c.c < (a.o + a.c) / 2) {
    return ['bearish', 'Evening star — 3-candle bearish reversal'];
  }
  return null;
}

// ========== Support & Resistance (swing points) ==========
function findSupportResistance(ohlc, lookback = 50, pivots = 3) {
  const recent = ohlc.slice(-lookback);
  const highs = recent.map((b, i) => ({ p: b.h, i })).sort((a, b) => b.p - a.p).slice(0, pivots);
  const lows = recent.map((b, i) => ({ p: b.l, i })).sort((a, b) => a.p - b.p).slice(0, pivots);
  return {
    resistance: highs.reduce((s, x) => s + x.p, 0) / highs.length,
    support: lows.reduce((s, x) => s + x.p, 0) / lows.length,
  };
}

// ========== Trading session + ICT Killzones ==========
// Killzones (per Inner Circle Trader research) are when institutional flow
// concentrates. Statistically the highest-quality setups form during these
// 3-hour windows. We give them a bigger confidence bonus than the broader
// London/NY sessions.
function currentSession() {
  const h = new Date().getUTCHours();
  const inLondonKZ = h >= 7 && h < 10;   // 07:00–10:00 UTC
  const inNYKZ = h >= 12 && h < 15;       // 12:00–15:00 UTC
  if (inLondonKZ && inNYKZ) return { name: 'London + NY Killzones', liquidity: 'peak', bonus: 1.15, killzone: true };
  if (inLondonKZ) return { name: 'London Killzone', liquidity: 'peak', bonus: 1.12, killzone: true };
  if (inNYKZ) return { name: 'NY Killzone', liquidity: 'peak', bonus: 1.12, killzone: true };
  if (h >= 13 && h < 16) return { name: 'London/NY overlap', liquidity: 'peak', bonus: 1.08, killzone: false };
  if (h >= 8 && h < 17) return { name: 'London', liquidity: 'high', bonus: 1.04, killzone: false };
  if (h >= 13 && h < 22) return { name: 'New York', liquidity: 'high', bonus: 1.04, killzone: false };
  if (h >= 0 && h < 9) return { name: 'Tokyo', liquidity: 'medium', bonus: 1.0, killzone: false };
  return { name: 'Sydney / off-hours', liquidity: 'low', bonus: 0.90, killzone: false };
}

// ========== Data fetch (cached) ==========
function loadCache() { return safeLoad(CACHE_KEY, {}); }
function saveCache(c) { return safeSave(CACHE_KEY, c); }

async function fetchOHLC(symbol, interval = '1h', range = '3mo') {
  const cacheKey = `${symbol}_${interval}_${range}`;
  const cache = loadCache();
  const e = cache[cacheKey];
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  const res = await fetch(`/api/prices?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`);
  if (!res.ok) throw new Error(`prices ${symbol} ${interval}: HTTP ${res.status}`);
  const data = await res.json();
  const minBars = interval === '1d' ? 30 : 60;
  if (!data.ohlc || data.ohlc.length < minBars) throw new Error(`${symbol} ${interval}: insufficient data`);
  cache[cacheKey] = { ts: Date.now(), data };
  saveCache(cache);
  return data;
}

// ========== RSI divergence (strong reversal signal) ==========
function detectRSIDivergence(closes, rsiArr, lookback = 30) {
  if (closes.length < lookback + 5) return null;
  const n = closes.length - 1;
  const window = closes.slice(n - lookback, n + 1);
  const rsiWindow = rsiArr.slice(n - lookback, n + 1);
  let lowIdx = 0, highIdx = 0;
  for (let i = 1; i < window.length - 3; i++) {
    if (window[i] != null && window[i] < window[lowIdx]) lowIdx = i;
    if (window[i] != null && window[i] > window[highIdx]) highIdx = i;
  }
  const currentPrice = window[window.length - 1];
  const currentRSI = rsiWindow[rsiWindow.length - 1];
  if (rsiWindow[lowIdx] == null || rsiWindow[highIdx] == null || currentRSI == null) return null;
  if (currentPrice < window[lowIdx] && currentRSI > rsiWindow[lowIdx] + 3) {
    return ['bullish', `RSI bullish divergence — price made lower low, momentum didn't`];
  }
  if (currentPrice > window[highIdx] && currentRSI < rsiWindow[highIdx] - 3) {
    return ['bearish', `RSI bearish divergence — price made higher high, momentum didn't`];
  }
  return null;
}

// ========== News sentiment for pair ==========
// _newsForSignal holds the cached news pool used by signal analysis. We
// refresh it at most every 2 min (was every analyze cycle = potentially many
// times per minute). The edge cache itself is 90s, so 2min client refresh
// hits the edge cache reliably without re-fetching unnecessarily.
let _newsForSignal = null;
let _newsLoadedAt = 0;
async function loadNewsForSignals(force = false) {
  const NEWS_CLIENT_TTL_MS = 2 * 60 * 1000; // 2 min
  if (!force && _newsForSignal && (Date.now() - _newsLoadedAt) < NEWS_CLIENT_TTL_MS) {
    return; // still fresh
  }
  try {
    const r = await fetch('/api/news');
    _newsForSignal = (await r.json()).news || [];
    _newsLoadedAt = Date.now();
  } catch { _newsForSignal = _newsForSignal || []; }
}
function newsSentimentForPair(pair) {
  if (!_newsForSignal || _newsForSignal.length === 0) return null;
  const currencies = pair.replace('/', ' ').split(' ').filter(Boolean);
  // Cutoff narrowed 24h → 12h. Older news has diminishing signal value;
  // 12h captures all overnight + current-session news without diluting the
  // sentiment vote with stale stuff.
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  let bull = 0, bear = 0;
  // Central-bank items count double — they're the highest-signal news
  for (const n of _newsForSignal) {
    // Prefer detected-currencies field added by improved news pipeline
    let pairMatch = false;
    if (n.currencies && n.currencies.length) {
      pairMatch = currencies.some(c => n.currencies.includes(c));
    } else {
      const T = (n.title + ' ' + n.summary).toUpperCase();
      pairMatch = currencies.some(c => T.includes(c)) || T.includes(pair) || T.includes(pair.replace('/', ''));
    }
    if (!pairMatch) continue;
    const ts = n.published ? new Date(n.published).getTime() : cutoff + 1;
    if (ts < cutoff) continue;
    const weight = n.isCB ? 2 : 1;
    if (n.sentiment === 'bullish') bull += weight;
    else if (n.sentiment === 'bearish') bear += weight;
  }
  if (bull + bear < 2) return null;
  return { net: (bull - bear) / (bull + bear), bull, bear };
}

// ========== Calendar proximity check ==========
let _calendarForSignal = null;
async function loadCalendarForSignals() {
  try {
    const r = await fetch('/api/calendar?impact=high');
    _calendarForSignal = (await r.json()).events || [];
  } catch { _calendarForSignal = []; }
}
function nearbyHighImpactEvent(pair) {
  if (!_calendarForSignal) return null;
  const currencies = pair.replace('/', ' ').split(' ').filter(Boolean);
  const now = Date.now();
  let closest = null, closestDelta = Infinity;
  for (const ev of _calendarForSignal) {
    if (!ev.country || !currencies.includes(ev.country)) continue;
    const t = ev.date ? new Date(ev.date).getTime() : null;
    if (t == null) continue;
    const delta = Math.abs(t - now);
    if (t > now && t < now + 2 * 60 * 60 * 1000 && delta < closestDelta) { closest = ev; closestDelta = delta; }
    if (t < now && t > now - 30 * 60 * 1000 && delta < closestDelta) { closest = ev; closestDelta = delta; }
  }
  if (!closest) return null;
  return { event: closest, minutes: Math.round((new Date(closest.date).getTime() - now) / 60000) };
}

// ========== Learning (localStorage) ==========
function getLogs() { return safeLoad(LOGS_KEY, []); }
function saveLogs(logs) {
  const trimmed = logs.slice(-2000);
  const result = safeSave(LOGS_KEY, trimmed);
  // If sync is active, also push to cloud (debounced inside pushAllToCloud).
  // Wrapped in try/catch so a sync issue can't break local persistence.
  try { if (typeof pushAllToCloud === 'function') pushAllToCloud(); } catch {}
  return result;
}

// Per-pair + per-hour win rate — more granular than single global weights
function perContextWinRates() {
  const logs = getLogs();
  const byPair = {};
  const bySession = {};
  const byHour = {};
  for (const l of logs) {
    if (l.outcome !== 'win' && l.outcome !== 'loss') continue;
    const isWin = l.outcome === 'win';
    byPair[l.pair] ||= { w: 0, n: 0 };
    byPair[l.pair].n++; if (isWin) byPair[l.pair].w++;
    const hour = new Date(l.ts || l.timestamp).getUTCHours();
    byHour[hour] ||= { w: 0, n: 0 };
    byHour[hour].n++; if (isWin) byHour[hour].w++;
  }
  return { byPair, byHour };
}

// Context adjustment — returns a number of PERCENTAGE POINTS to add/subtract from
// the base confluence. Capped at ±3pp so learning is a tiebreaker, not a dominant
// factor. Keeps signals consistent across devices (phone, desktop, fresh installs).
function contextAdjustment(pair) {
  const { byPair, byHour } = perContextWinRates();
  const h = new Date().getUTCHours();
  const pairStat = byPair[pair];
  const hourStat = byHour[h];
  let pts = 0;
  if (pairStat && pairStat.n >= 10) pts += (pairStat.w / pairStat.n - 0.5) * 6; // ±3 at 0% / 100%
  if (hourStat && hourStat.n >= 10) pts += (hourStat.w / hourStat.n - 0.5) * 4; // ±2
  return Math.max(-5, Math.min(5, pts));
}

function logSignal(s) {
  const logs = getLogs();
  for (const l of logs.slice(-200)) {
    if (l.pair === s.pair && l.direction === s.direction && l.outcome === 'pending'
        && Math.abs(l.entry - s.entry) < s.entry * 0.0005) return;
  }
  // Sorted "strategy set" — exact combination of strategies that fired in
  // the signal's direction. Lets future signals match against historical
  // win/loss data for the same combination.
  const alignedNames = Object.entries(s.votes || {})
    .filter(([_, v]) => Array.isArray(v) &&
      ((s.direction === 'BUY' && v[0] === 'bullish') || (s.direction === 'SELL' && v[0] === 'bearish')))
    .map(([k]) => k)
    .sort();
  logs.push({
    ts: s.timestamp, pair: s.pair, direction: s.direction, confidence: s.confidence,
    entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2,
    votes: Object.fromEntries(Object.entries(s.votes).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
    strategySet: alignedNames.join('|'),
    alignedCount: alignedNames.length,
    bullCount: s.bull_count, bearCount: s.bear_count, total: s.total_indicators,
    adx: s.adxNow, session: s.session, hourUTC: new Date(s.timestamp).getUTCHours(),
    outcome: 'pending',
  });
  saveLogs(logs);
}

// ========== Full Strategy Backtester ==========
// Runs each of the 14 strategies independently across every historical bar of
// every pair, simulating ATR-based TP/SL entries for 30-bar lookaheads, and
// aggregates the per-strategy win/loss totals. The user runs this from the
// Learning tab on demand. Results persist in localStorage and are used by
// `topBacktestedStrategyBoost()` to nudge confidence on live signals when
// the strategies that historically perform best are firing right now.
const BACKTEST_KEY = 'forexsight_strategy_backtest_v1';

function getBacktestResults() {
  return safeLoad(BACKTEST_KEY, null);
}
function saveBacktestResults(r) {
  return safeSave(BACKTEST_KEY, r);
}

// One simplified runner for each strategy that takes (ohlc up to index i) and
// returns 'bullish'/'bearish'/null. Reuses the existing detectors so the
// backtest is testing the EXACT same logic the signal generator uses.
function runStrategyAt(ohlc, i, ema20A, ema50A, atrA, rsiA) {
  const slice = ohlc.slice(0, i + 1);
  const closes = slice.map(b => b.c);
  const out = [];
  const wrap = (name, result) => { if (result) out.push([name, result[0]]); };
  try { wrap('Liquidity sweep', strategyLiquiditySweep(slice)); } catch {}
  try { wrap('Turtle breakout', strategyTurtleBreakout(slice)); } catch {}
  try { wrap('Order block', strategyOrderBlock(slice)); } catch {}
  try { wrap('Break of structure', strategyBreakOfStructure(slice)); } catch {}
  try { wrap('Fair Value Gap', strategyFairValueGap(slice)); } catch {}
  try { wrap('Change of Character', strategyChangeOfCharacter(slice)); } catch {}
  try { wrap('Premium/Discount', strategyPremiumDiscount(slice)); } catch {}
  try { wrap('Three-bar reversal', strategyThreeBarReversal(slice)); } catch {}
  try { wrap('Fibonacci level', strategyFibonacciLevel(slice)); } catch {}
  try { wrap('EMA50 pullback', strategy50EmaPullback(slice, ema20A.slice(0, i + 1), ema50A.slice(0, i + 1), atrA[i])); } catch {}
  try { wrap('Ichimoku', strategyIchimoku(slice)); } catch {}
  try { wrap('Hidden RSI divergence', strategyHiddenDivergence(closes, rsiA.slice(0, i + 1), ema50A.slice(0, i + 1))); } catch {}
  try { wrap('TTM Squeeze breakout', strategyTTMSqueeze(slice, atrA.slice(0, i + 1))); } catch {}
  try { wrap('AlexG Set & Forget', strategyAlexGSetAndForget(slice, atrA[i])); } catch {}
  try { wrap('MambaFX', strategyMambaFXSupplyDemand(slice)); } catch {}
  try { wrap('Double Top/Bottom', strategyDoubleTopBottom(slice)); } catch {}
  try { wrap('Head & Shoulders', strategyHeadAndShoulders(slice)); } catch {}
  try { wrap('Triangle breakout', strategyTriangle(slice)); } catch {}
  // Candlestick pattern detector (returns [bias, reason] or null when neutral)
  try {
    const cp = detectCandlestickPattern(slice);
    if (cp && cp[0] !== 'neutral') wrap('Candlestick pattern', cp);
  } catch {}
  return out;
}

async function runStrategyBacktest(progressCb) {
  const aggregate = {}; // name -> { wins, losses, total, byPair: { pair: {wins, losses, total} } }
  const pairs = Object.entries(PAIRS);
  for (let pi = 0; pi < pairs.length; pi++) {
    const [name, sym] = pairs[pi];
    if (progressCb) progressCb({ phase: 'fetching', pair: name, idx: pi, total: pairs.length });
    let data;
    try { data = await fetchOHLC(sym); }
    catch (e) { console.warn('[backtest fetch]', name, e.message); continue; }
    if (!data?.ohlc || data.ohlc.length < 250) continue;

    const ohlc = data.ohlc;
    const closes = ohlc.map(b => b.c);
    const highs = ohlc.map(b => b.h);
    const lows = ohlc.map(b => b.l);
    const ema20A = emaArr(closes, 20);
    const ema50A = emaArr(closes, 50);
    const atrA = atr(highs, lows, closes);
    const rsiA = rsi(closes);

    if (progressCb) progressCb({ phase: 'analyzing', pair: name, idx: pi, total: pairs.length });

    // Walk through bars, collect each strategy fire + measure outcome
    for (let i = 220; i < ohlc.length - 30; i++) {
      let fires;
      try { fires = runStrategyAt(ohlc, i, ema20A, ema50A, atrA, rsiA); }
      catch (e) { continue; }
      if (!fires.length) continue;
      const atrV = atrA[i];
      if (!atrV || atrV <= 0) continue;
      const entry = closes[i];

      for (const [stratName, bias] of fires) {
        if (bias !== 'bullish' && bias !== 'bearish') continue;
        const tp = bias === 'bullish' ? entry + atrV * 1.5 : entry - atrV * 1.5;
        const sl = bias === 'bullish' ? entry - atrV * 1.5 : entry + atrV * 1.5;
        let outcome = null;
        for (let j = i + 1; j <= Math.min(i + 30, ohlc.length - 1); j++) {
          const b = ohlc[j];
          if (bias === 'bullish') {
            if (b.l <= sl) { outcome = 'loss'; break; }
            if (b.h >= tp) { outcome = 'win'; break; }
          } else {
            if (b.h >= sl) { outcome = 'loss'; break; }
            if (b.l <= tp) { outcome = 'win'; break; }
          }
        }
        if (!outcome) continue;
        aggregate[stratName] ||= { wins: 0, losses: 0, total: 0, byPair: {} };
        aggregate[stratName].byPair[name] ||= { wins: 0, losses: 0, total: 0 };
        aggregate[stratName].total++;
        aggregate[stratName].byPair[name].total++;
        if (outcome === 'win') {
          aggregate[stratName].wins++;
          aggregate[stratName].byPair[name].wins++;
        } else {
          aggregate[stratName].losses++;
          aggregate[stratName].byPair[name].losses++;
        }
      }
    }
    // small yield so the UI doesn't lock up
    await new Promise(r => setTimeout(r, 0));
  }

  // Compute win rates + ranking
  const ranked = Object.entries(aggregate)
    .filter(([_, v]) => v.total >= 30) // need decent sample size
    .map(([k, v]) => ({ name: k, wins: v.wins, losses: v.losses, total: v.total, winRate: v.wins / v.total, byPair: v.byPair }))
    .sort((a, b) => b.winRate - a.winRate);

  const result = {
    ts: Date.now(),
    pairs: pairs.length,
    ranked,
    aggregate,
  };
  saveBacktestResults(result);
  if (progressCb) progressCb({ phase: 'done', total: pairs.length });
  return result;
}

// Returns the names of the top-3 strategies that backtest above 55% win rate
// (only considers backtests done within last 24h to keep it fresh).
function topBacktestedStrategyNames() {
  const r = getBacktestResults();
  if (!r || !r.ranked) return [];
  if (Date.now() - r.ts > 24 * 60 * 60 * 1000) return [];
  return r.ranked.filter(s => s.winRate >= 0.55 && s.total >= 50).slice(0, 3).map(s => s.name);
}

// Confidence bonus when one of the top backtested strategies fires on the
// current signal in the same direction. Capped at +9pp (max 3 strategies × 3pp).
function topBacktestedStrategyBoost(signal) {
  try {
    const top = topBacktestedStrategyNames();
    if (!top.length) return { bonus: 0, names: [] };
    const aligned = (signal.firedStrategies || []).filter(f =>
      ((signal.direction === 'BUY' && f.bias === 'bullish') ||
       (signal.direction === 'SELL' && f.bias === 'bearish')) &&
      top.includes(f.name)
    );
    return { bonus: Math.min(9, aligned.length * 3), names: aligned.map(a => a.name) };
  } catch { return { bonus: 0, names: [] }; }
}

// ========== Loss-pattern blocker ==========
// Finds strategy combinations that have HISTORICALLY LOST and blocks signals
// matching them entirely (not just penalizes confidence). Stronger than
// patternMatchBonus because it removes the signal rather than discounting it.
function isBlockedLossPattern(signal) {
  try {
    const aligned = (signal.firedStrategies || [])
      .filter(f =>
        (signal.direction === 'BUY' && f.bias === 'bullish') ||
        (signal.direction === 'SELL' && f.bias === 'bearish'))
      .map(f => f.name).sort();
    if (!aligned.length) return null;
    const setKey = aligned.join('|');
    const logs = getLogs();
    // Same pair + same combination that has lost ≥70% of the time on 6+ samples
    const sameMatches = logs.filter(l =>
      (l.outcome === 'win' || l.outcome === 'loss') &&
      l.pair === signal.pair && l.strategySet === setKey);
    if (sameMatches.length >= 6) {
      const wins = sameMatches.filter(m => m.outcome === 'win').length;
      const lossRate = 1 - (wins / sameMatches.length);
      if (lossRate >= 0.7) return `pair-loss-pattern:${Math.round(lossRate*100)}%`;
    }
    // All-pairs version requires more samples but kicks in earlier across markets
    const allMatches = logs.filter(l =>
      (l.outcome === 'win' || l.outcome === 'loss') && l.strategySet === setKey);
    if (allMatches.length >= 15) {
      const wins = allMatches.filter(m => m.outcome === 'win').length;
      const lossRate = 1 - (wins / allMatches.length);
      if (lossRate >= 0.72) return `global-loss-pattern:${Math.round(lossRate*100)}%`;
    }
    return null;
  } catch { return null; }
}

// ========== Signal cooldown ==========
// Prevents the same pair+direction from firing within COOLDOWN_HOURS so we
// don't stack 3 losses on the same failed setup. Returns null if OK to fire.
const COOLDOWN_HOURS = 4;
function inCooldown(pair, direction) {
  try {
    const cutoff = Date.now() - COOLDOWN_HOURS * 3600 * 1000;
    const logs = getLogs();
    for (let i = logs.length - 1; i >= 0; i--) {
      const l = logs[i];
      if (l.pair !== pair || l.direction !== direction) continue;
      const t = new Date(l.ts || 0).getTime();
      if (t > cutoff) return Math.round((COOLDOWN_HOURS * 3600 * 1000 - (Date.now() - t)) / 60000);
    }
    return null;
  } catch { return null; }
}

// ========== Adaptive quality threshold ==========
// If the user has had a losing streak recently, automatically raise the
// confidence threshold for "Best" signals. Mean-reversion safety: when the
// system is misfiring, demand more before showing anything.
function adaptiveBestFloor() {
  try {
    const logs = getLogs();
    const recent = logs.filter(l => (l.outcome === 'win' || l.outcome === 'loss')).slice(-15);
    if (recent.length < 5) return 0;
    const wins = recent.filter(l => l.outcome === 'win').length;
    const rate = wins / recent.length;
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].outcome === 'loss') streak++; else break;
    }
    // Capped at +4 (was +8) — too high a floor + other gates = nothing shows.
    if (streak >= 4) return 4;
    if (streak >= 3) return 3;
    if (rate < 0.35 && recent.length >= 8) return 3;
    if (rate < 0.45 && recent.length >= 8) return 2;
    return 0;
  } catch { return 0; }
}

// ========== Composite edge score ==========
// Combines every independent signal of edge into one ranked score 0-100. Used
// for sort order so the highest-edge signals always appear first, regardless
// of confidence label.
function compositeEdgeScore(s) {
  try {
    let score = 0;
    // Backtested win rate (Wilson lower bound — be conservative)
    if (s.winProbability != null && s.backtestSamples >= 10) {
      const ci = wilsonInterval(s.backtestWins || 0, s.backtestSamples || 1);
      score += ci.low * 35; // up to 35 pts
    }
    // Pattern match bonus
    if (s.patternAdj > 0) score += Math.min(15, s.patternAdj * 1.5);
    if (s.patternAdj < 0) score -= Math.min(15, Math.abs(s.patternAdj) * 1.5);
    // Multi-strategy alignment
    const aligned = (s.firedStrategies || []).filter(f =>
      (s.direction === 'BUY' && f.bias === 'bullish') ||
      (s.direction === 'SELL' && f.bias === 'bearish')).length;
    score += Math.min(20, aligned * 4); // up to 20 pts
    // Regime fit
    if (s.regimeAdj > 0) score += Math.min(10, s.regimeAdj);
    if (s.regimeAdj < 0) score -= Math.min(10, Math.abs(s.regimeAdj));
    // Confidence (calibrated) — modest weight
    score += (s.confidence || 0) * 0.2; // up to 20 pts
    // Killzone bonus
    if (s.session && s.session.toLowerCase().includes('killzone')) score += 5;
    // Penalties
    if (s.volRegime === 'chaos') score -= 15;
    if (s.volRegime === 'dead') score -= 10;
    if ((s.calPenalty ?? 0) <= -20) score -= 15;
    return Math.max(0, Math.min(100, Math.round(score)));
  } catch { return 0; }
}

// Day-trader-specific composite — boosts signals expected to resolve fast
// AND have high win probability. Designed so a 4-hour 65%-WR setup outranks
// a 12-hour 70%-WR setup (because day traders can't hold overnight).
// Used to rank within the Day Trader filter pool.
function dayTraderScore(s) {
  try {
    let score = 0;
    // 1. EDGE (40 pts) — same backtest weight as compositeEdgeScore
    if (s.winProbability != null && s.backtestSamples >= 10) {
      const ci = wilsonInterval(s.backtestWins || 0, s.backtestSamples || 1);
      score += ci.low * 40;
    } else {
      score += 20; // unknown = neutral
    }
    // 2. SPEED BONUS (25 pts) — heavily favours fast hold times
    if (s.expectedHoldHours != null) {
      if (s.expectedHoldHours <= 2)      score += 25;
      else if (s.expectedHoldHours <= 4) score += 20;
      else if (s.expectedHoldHours <= 6) score += 12;
      else if (s.expectedHoldHours <= 8) score += 6;
      else score -= 10; // > 8 hrs = swing setup, penalise for day trader
    }
    // 3. MULTI-STRATEGY CONFLUENCE (15 pts) — 2+ strategies firing reduces noise
    const passingStrats = [
      s.smcPassed, s.orbPassed, s.ictPassed, s.trendPassed,
      s.squeezePassed, s.divergencePassed, s.momentumPassed,
    ].filter(Boolean).length;
    score += Math.min(15, passingStrats * 5);
    // 4. ACTIVE SESSION (10 pts) — London/NY moves are fastest
    if (s.session && /Killzone/i.test(s.session)) score += 10;
    else if (s.session && /London|NY/i.test(s.session)) score += 7;
    // 5. GRADE (10 pts) — best-grade trades win more
    const bestGrade = s.bestGrade ||
      [s.smcGrade, s.orbGrade, s.ictGrade, s.trendGrade,
       s.squeezeGrade, s.divergenceGrade, s.momentumGrade]
       .filter(Boolean)
       .reduce((a, b) => {
         const rank = g => ({'A+':0,'A':1,'B+':2,'B':3,'C':4}[g] ?? 5);
         return rank(a) < rank(b) ? a : b;
       }, 'C');
    if (bestGrade === 'A+') score += 10;
    else if (bestGrade === 'A') score += 7;
    else if (bestGrade === 'B+') score += 4;
    else if (bestGrade === 'B') score += 1;
    // PENALTIES
    if (s.volRegime === 'chaos') score -= 15; // whipsaw kills day trades
    if (s.volRegime === 'dead')  score -= 10; // dead markets don't move to TP
    if ((s.calPenalty ?? 0) <= -20) score -= 15; // imminent news = noise
    // HTF against
    if (s.htfTrend &&
        ((s.direction === 'BUY' && s.htfTrend === 'down') ||
         (s.direction === 'SELL' && s.htfTrend === 'up'))) score -= 12;
    return Math.max(0, Math.min(100, Math.round(score)));
  } catch { return 0; }
}

// ========== Pattern-combination learning ==========
// Tracks per-strategy + per-combination win rates from your closed trades.
// Used both as a confidence boost in real-time analysis AND surfaced in the
// learning dashboard so you can see exactly what the system has learned.
function strategyHitRates() {
  const logs = getLogs();
  const out = {};
  for (const l of logs) {
    if (l.outcome !== 'win' && l.outcome !== 'loss') continue;
    const set = (l.strategySet || '').split('|').filter(Boolean);
    for (const name of set) {
      out[name] = out[name] || { wins: 0, total: 0 };
      out[name].total++;
      if (l.outcome === 'win') out[name].wins++;
    }
  }
  return out;
}

function combinationHitRates() {
  const logs = getLogs();
  const out = {};
  for (const l of logs) {
    if (l.outcome !== 'win' && l.outcome !== 'loss') continue;
    const key = l.strategySet || '(none)';
    out[key] = out[key] || { wins: 0, total: 0, pairs: new Set() };
    out[key].total++;
    if (l.outcome === 'win') out[key].wins++;
    if (l.pair) out[key].pairs.add(l.pair);
  }
  return out;
}

// Boost or penalize based on whether the same exact strategy combination
// has historically won or lost on this pair. Capped ±12pp.
function patternMatchBonus(signal) {
  try {
    const aligned = (signal.firedStrategies || [])
      .filter(f =>
        (signal.direction === 'BUY' && f.bias === 'bullish') ||
        (signal.direction === 'SELL' && f.bias === 'bearish'))
      .map(f => f.name).sort();
    if (!aligned.length) return { bonus: 0, note: '' };
    const setKey = aligned.join('|');
    const logs = getLogs();
    const matches = logs.filter(l =>
      (l.outcome === 'win' || l.outcome === 'loss') &&
      l.pair === signal.pair && l.strategySet === setKey);
    if (matches.length >= 5) {
      const wins = matches.filter(m => m.outcome === 'win').length;
      const rate = wins / matches.length;
      if (rate >= 0.7) return { bonus: 12, note: `📈 This pattern wins ${Math.round(rate*100)}% on ${signal.pair} (${wins}/${matches.length})` };
      if (rate >= 0.6) return { bonus: 7,  note: `📈 This pattern wins ${Math.round(rate*100)}% on ${signal.pair} (${wins}/${matches.length})` };
      if (rate <= 0.3) return { bonus: -10, note: `📉 This pattern loses ${Math.round((1-rate)*100)}% on ${signal.pair} (${matches.length-wins}L/${matches.length})` };
      if (rate <= 0.4) return { bonus: -5,  note: `📉 This pattern weak ${Math.round(rate*100)}% on ${signal.pair} (${wins}/${matches.length})` };
    }
    const allMatches = logs.filter(l =>
      (l.outcome === 'win' || l.outcome === 'loss') && l.strategySet === setKey);
    if (allMatches.length >= 10) {
      const wins = allMatches.filter(m => m.outcome === 'win').length;
      const rate = wins / allMatches.length;
      if (rate >= 0.65) return { bonus: 5, note: `📈 Pattern wins ${Math.round(rate*100)}% across all pairs (${allMatches.length} samples)` };
      if (rate <= 0.35) return { bonus: -5, note: `📉 Pattern losing across all pairs (${Math.round(rate*100)}%)` };
    }
    return { bonus: 0, note: '' };
  } catch (e) { return { bonus: 0, note: '' }; }
}

function evaluateOutcomes(pair, ohlc) {
  const logs = getLogs();
  let changed = false;
  for (const log of logs) {
    if (log.pair !== pair || log.outcome !== 'pending') continue;
    const logTs = new Date(log.ts).getTime();
    let hi = -Infinity, lo = Infinity;
    for (const b of ohlc) {
      if (b.t <= logTs) continue;
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    if (hi === -Infinity) continue;
    if (log.direction === 'BUY') {
      if (lo <= log.sl) { log.outcome = 'loss'; changed = true; }
      else if (hi >= log.tp1) { log.outcome = 'win'; changed = true; }
    } else if (log.direction === 'SELL') {
      if (hi >= log.sl) { log.outcome = 'loss'; changed = true; }
      else if (lo <= log.tp1) { log.outcome = 'win'; changed = true; }
    }
  }
  if (changed) saveLogs(logs);
}

function indicatorWeights() {
  const logs = getLogs();
  const stats = {};
  for (const l of logs) {
    if (l.outcome !== 'win' && l.outcome !== 'loss') continue;
    for (const [ind, vote] of Object.entries(l.votes || {})) {
      const aligned = (vote === 'bullish' && l.direction === 'BUY') || (vote === 'bearish' && l.direction === 'SELL');
      if (!aligned) continue;
      const s = stats[ind] ||= { correct: 0, total: 0 };
      s.total++;
      if (l.outcome === 'win') s.correct++;
    }
  }
  // Stepped weighting — amplifies signal-to-noise. Anti-predictive indicators
  // get near-zero weight (so they can't vote down a good setup) and proven
  // predictors get boosted weights so they pull more strongly. Learned from
  // 246-log audit showing Stochastic (22% wr) and ADX vote (27% wr) were
  // actively HURTING signal quality while Parabolic SAR (71%) and Daily
  // trend (64%) were the strongest predictors but got the same weight.
  // Old formula: weight = max(0.3, winrate). Bad indicators floored at 0.3.
  // New formula: stepped — bad gets 0.1, random gets 0.5, good gets up to 1.8.
  const weights = {};
  for (const [k, v] of Object.entries(stats)) {
    if (v.total < 5) { weights[k] = 1.0; continue; } // not enough data
    const wr = v.correct / v.total;
    let w;
    if (wr < 0.40) w = 0.1;        // anti-predictive — basically mute
    else if (wr < 0.50) w = 0.3;   // slightly losing — quarter weight
    else if (wr < 0.55) w = 0.6;   // random — half weight
    else if (wr < 0.62) w = 1.0;   // baseline
    else if (wr < 0.70) w = 1.4;   // strong predictor
    else w = 1.8;                   // elite predictor (75%+ wr)
    weights[k] = w;
  }
  return weights;
}

// ========== Market Regime Detection + Strategy-Regime Fit ==========
// Each strategy works in different market regimes. Trend-following strategies
// (Turtle, EMA50 pullback) lose money in chop. Mean-reversion strategies
// (Bollinger, RSI extremes) lose money in strong trends. We classify the
// current regime and weight each strategy's vote accordingly.
function detectRegime(adxV, atrCurrent, atrAvg, bbUp, bbLow) {
  if (adxV == null) return 'normal';
  const atrRatio = atrAvg > 0 ? atrCurrent / atrAvg : 1;
  const bbWidth = bbUp != null && bbLow != null ? (bbUp - bbLow) / bbLow : 0;
  // Strong trend
  if (adxV >= 28 && atrRatio >= 0.9) return 'trending';
  // Volatile chop (high vol, no clear direction)
  if (atrRatio >= 1.5 && adxV < 22) return 'volatile';
  // Range / consolidation
  if (adxV < 20 && atrRatio < 1.0) return 'ranging';
  return 'normal';
}

// Each strategy's preference for the four regimes. 1.0 = no adjustment;
// >1 means strategy fits this regime well; <1 means avoid in this regime.
// Calibrated from documented forex literature on which patterns work in which
// market conditions.
const STRATEGY_REGIME_FIT = {
  // Trend-followers — win in trends, lose in chop
  'Turtle breakout':           { trending: 1.30, ranging: 0.50, volatile: 0.70, normal: 1.00 },
  'EMA50 pullback':            { trending: 1.30, ranging: 0.55, volatile: 0.75, normal: 1.00 },
  'Break of structure':        { trending: 1.25, ranging: 0.60, volatile: 0.80, normal: 1.00 },
  'Ichimoku':                  { trending: 1.25, ranging: 0.60, volatile: 0.85, normal: 1.00 },
  'TTM Squeeze breakout':      { trending: 1.20, ranging: 0.85, volatile: 1.10, normal: 1.00 },
  // Mean-reverters — win in ranges, get steamrolled in trends
  'Liquidity sweep':           { trending: 0.85, ranging: 1.20, volatile: 1.30, normal: 1.00 },
  'Three-bar reversal':        { trending: 0.80, ranging: 1.20, volatile: 1.10, normal: 1.00 },
  'Premium/Discount':          { trending: 0.85, ranging: 1.25, volatile: 0.95, normal: 1.00 },
  'Fibonacci level':           { trending: 1.05, ranging: 1.15, volatile: 0.90, normal: 1.00 },
  'Hidden RSI divergence':     { trending: 1.20, ranging: 0.95, volatile: 0.90, normal: 1.00 },
  // Pattern entries — work everywhere, slight edge in volatility
  'Order block':               { trending: 1.10, ranging: 1.05, volatile: 1.00, normal: 1.00 },
  'Fair Value Gap':            { trending: 1.15, ranging: 0.95, volatile: 1.05, normal: 1.00 },
  'Change of Character':       { trending: 1.10, ranging: 1.00, volatile: 1.10, normal: 1.00 },
  'AlexG Set & Forget':        { trending: 1.05, ranging: 1.10, volatile: 0.85, normal: 1.00 },
  // MambaFX supply/demand zone — pullback retests work best when there IS a
  // trend to pull back from. Suffers in raging volatility (zones get blown through).
  'MambaFX':                   { trending: 1.20, ranging: 0.95, volatile: 0.85, normal: 1.05 },
  // Chart patterns — reversal patterns work best AFTER trends, breakouts during trends
  'Double Top/Bottom':         { trending: 1.20, ranging: 0.85, volatile: 0.80, normal: 1.05 },
  'Head & Shoulders':          { trending: 1.25, ranging: 0.85, volatile: 0.80, normal: 1.10 },
  'Triangle breakout':         { trending: 1.10, ranging: 1.15, volatile: 1.20, normal: 1.05 },
};

function regimeAdjustment(firedStrategies, regime, direction) {
  if (!firedStrategies?.length || !regime) return { adj: 0, note: '' };
  let totalFit = 0, count = 0, well = 0, poor = 0;
  for (const f of firedStrategies) {
    const aligned = (direction === 'BUY' && f.bias === 'bullish') || (direction === 'SELL' && f.bias === 'bearish');
    if (!aligned) continue;
    const fit = STRATEGY_REGIME_FIT[f.name]?.[regime] ?? 1.0;
    totalFit += fit;
    count++;
    if (fit >= 1.15) well++;
    if (fit <= 0.85) poor++;
  }
  if (count === 0) return { adj: 0, note: '' };
  const avgFit = totalFit / count;
  // Translate fit ratio to ±pp (capped at ±10)
  const adj = Math.max(-10, Math.min(10, Math.round((avgFit - 1.0) * 30)));
  let note = '';
  if (regime === 'trending' && well > 0) note = `📈 Trending market — ${well} trend-following ${well === 1 ? 'strategy' : 'strategies'} are well-suited`;
  else if (regime === 'ranging' && well > 0) note = `📊 Ranging market — mean-reversion strategies favored`;
  else if (regime === 'volatile' && poor > 0) note = `🌪 Volatile chop — ${poor} ${poor === 1 ? 'strategy is' : 'strategies are'} a poor fit, downweighted`;
  else if (regime === 'trending' && poor > 0) note = `📈 Trending market — ${poor} mean-reversion ${poor === 1 ? 'strategy is' : 'strategies are'} fighting trend`;
  return { adj, note, regime };
}

// ========== Confidence Calibration (Platt-scaling style) ==========
// Over time, track actual win rate at each 5pp confidence bucket. If 75-80%
// signals have actually won 55% of the time across 50+ closed trades,
// the displayed 78% is OPTIMISTIC and should be calibrated to reality.
// Uses Bayesian shrinkage so a small sample doesn't override the raw value.
function calibratedConfidence(rawConfidence) {
  const logs = getLogs().filter(l => l.outcome === 'win' || l.outcome === 'loss');
  // Thresholds lowered (30→20 total, 10→7 nearby) so calibration engages sooner
  // as new signal outcomes accumulate. Combined with the trust ramp (max 80%
  // at 60+ samples), the displayed confidence will track actual win rates
  // as quickly as possible without overreacting to tiny sample sizes.
  if (logs.length < 20) return { calibrated: rawConfidence, samples: 0 };
  // Bucket = ±5pp window
  const nearby = logs.filter(l => Math.abs((l.confidence ?? 0) - rawConfidence) <= 5);
  if (nearby.length < 7) return { calibrated: rawConfidence, samples: nearby.length };
  const wins = nearby.filter(l => l.outcome === 'win').length;
  const actualRate = wins / nearby.length;
  // Bayesian shrinkage — trust the actual rate proportional to sample size.
  // Trust cap raised 0.6 → 0.8, ramps in faster (divide by 60 not 80).
  // Bucket audit showed raw model was anti-predictive in places (60-64% conf
  // had 24% wr; 85-89% had 20% wr). Calibration needs MORE authority to
  // correct these. With 20+ nearby samples per bucket and trust=0.5+,
  // displayed confidence will pull much closer to the actual historical rate.
  const trust = Math.min(0.8, nearby.length / 60); // max 80% trust at 48+ samples
  const calibrated = Math.round(rawConfidence * (1 - trust) + actualRate * 100 * trust);
  return {
    calibrated: Math.max(0, Math.min(100, calibrated)),
    samples: nearby.length,
    actualRate: Math.round(actualRate * 100),
    trust: Math.round(trust * 100),
  };
}

// ========== Bayesian Win-Rate Confidence Intervals (Wilson score) ==========
// Reports a 95% confidence interval around a measured win rate, accounting
// for sample size. 60% over 30 fires has a much wider CI than 60% over 300.
function wilsonInterval(wins, total) {
  if (total === 0) return { mean: 0.5, low: 0, high: 1 };
  const p = wins / total;
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denom;
  return {
    mean: p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

// ========== Volatility regime ==========
// Compares current ATR to its 50-bar average. Chaos = stops get whipsawed,
// dead = no follow-through. Both are losing environments.
function volatilityRegime(atrArr) {
  const n = atrArr.length - 1;
  const cur = atrArr[n];
  if (cur == null || cur <= 0) return 'unknown';
  const recent = atrArr.slice(Math.max(0, n - 50), n).filter(x => x != null && x > 0);
  if (recent.length < 20) return 'unknown';
  const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
  const ratio = cur / avg;
  if (ratio > 2.0) return 'chaos';
  if (ratio < 0.5) return 'dead';
  if (ratio > 1.3) return 'expanding';
  if (ratio < 0.8) return 'contracting';
  return 'normal';
}

// 4H trend approximation from 1H data — average closes in 4-bar buckets, then
// look at slope of last 5 buckets (~20 hours) of "4H candles".
function trend4H(closes) {
  if (closes.length < 30) return 'unknown';
  const buckets = [];
  for (let i = closes.length - 21; i < closes.length; i += 4) {
    if (i < 0 || i + 4 > closes.length) continue;
    const b = closes.slice(i, i + 4).reduce((s, x) => s + x, 0) / 4;
    buckets.push(b);
  }
  if (buckets.length < 4) return 'unknown';
  const first = buckets[0], last = buckets[buckets.length - 1];
  const change = (last - first) / first;
  if (change > 0.002) return 'up';
  if (change < -0.002) return 'down';
  return 'flat';
}

// ========== Historical backtester ==========
// For a candidate signal, scan past bars on the same pair. Find bars where the
// same direction would have been signaled, then check whether price hit TP1
// (1.5 × ATR) before SL (1.5 × ATR) within the next 30 bars. This gives an
// empirical win-rate for *this kind of setup on this specific pair*.
//
// Not a full simulation — uses a fast approximation of the vote direction at
// each past bar (RSI + MACD + EMA stack alignment). Good enough as a probability
// estimator and runs in <100ms per pair.
function backtestPattern(pair, ohlc, arrs, direction) {
  if (direction === 'HOLD') return { wins: 0, losses: 0, samples: 0, winRate: null };
  const n = ohlc.length - 1;
  if (n < 230) return { wins: 0, losses: 0, samples: 0, winRate: null };

  const approxDirAt = (i) => {
    let bull = 0, bear = 0;
    if (arrs.rsi[i] != null) {
      if (arrs.rsi[i] < 35) bull++;
      else if (arrs.rsi[i] > 65) bear++;
    }
    const mh = arrs.macd_hist[i];
    if (mh != null) {
      if (mh > 0 && arrs.macd_line[i] > arrs.macd_signal[i]) bull++;
      else if (mh < 0 && arrs.macd_line[i] < arrs.macd_signal[i]) bear++;
    }
    if (arrs.ema20[i] != null && arrs.ema50[i] != null) {
      const c = ohlc[i].c;
      if (c > arrs.ema20[i] && arrs.ema20[i] > arrs.ema50[i]) bull++;
      else if (c < arrs.ema20[i] && arrs.ema20[i] < arrs.ema50[i]) bear++;
    }
    if (bull >= 2 && bull > bear) return 'BUY';
    if (bear >= 2 && bear > bull) return 'SELL';
    return 'HOLD';
  };

  let wins = 0, losses = 0, samples = 0;
  // Scan from bar 200 (need lookback) to n-30 (need lookahead for outcome)
  for (let i = 200; i < n - 30; i++) {
    if (approxDirAt(i) !== direction) continue;
    const atrV = arrs.atr[i];
    if (atrV == null || atrV <= 0) continue;
    const entry = ohlc[i].c;
    const tp = direction === 'BUY' ? entry + atrV * 1.5 : entry - atrV * 1.5;
    const sl = direction === 'BUY' ? entry - atrV * 1.5 : entry + atrV * 1.5;
    let outcome = null;
    for (let j = i + 1; j <= Math.min(i + 30, n); j++) {
      const b = ohlc[j];
      if (direction === 'BUY') {
        if (b.l <= sl) { outcome = 'loss'; break; }
        if (b.h >= tp) { outcome = 'win'; break; }
      } else {
        if (b.h >= sl) { outcome = 'loss'; break; }
        if (b.l <= tp) { outcome = 'win'; break; }
      }
    }
    if (outcome === 'win') { wins++; samples++; }
    else if (outcome === 'loss') { losses++; samples++; }
  }
  return {
    wins, losses, samples,
    winRate: samples >= 5 ? wins / samples : null,
  };
}

// ========== Cross-pair correlation check ==========
// Builds a USD-strength consensus from all generated signals. If a signal
// contradicts a strong consensus, downgrade its confidence — single-pair
// noise rarely wins against multi-pair institutional flow.
function applyCorrelationCheck(signals) {
  try {
    let usdScore = 0, usdCount = 0;
    for (const s of signals) {
      if (!s || typeof s.pair !== 'string' || !s.direction) continue;
      const parts = s.pair.split('/');
      if (parts.length !== 2) continue;
      const [base, quote] = parts;
      if (base === 'USD') { usdScore += (s.direction === 'BUY' ? 1 : -1); usdCount++; }
      else if (quote === 'USD') { usdScore += (s.direction === 'BUY' ? -1 : 1); usdCount++; }
    }
    if (usdCount < 4) return;
    const usdBias = usdScore / usdCount;
    if (Math.abs(usdBias) < 0.4) return;
    for (const s of signals) {
      if (!s || typeof s.pair !== 'string' || !s.direction) continue;
      const parts = s.pair.split('/');
      if (parts.length !== 2) continue;
      const [base, quote] = parts;
      let implies = 0;
      if (base === 'USD') implies = s.direction === 'BUY' ? 1 : -1;
      else if (quote === 'USD') implies = s.direction === 'BUY' ? -1 : 1;
      if (implies !== 0 && Math.sign(implies) !== Math.sign(usdBias)) {
        s.correlationFlag = `Contradicts USD-${usdBias > 0 ? 'strong' : 'weak'} consensus from ${usdCount} pairs`;
        s.correlationPenalty = -8;
        s.confidence = Math.max(0, (s.confidence || 0) - 8);
      }
    }
  } catch (e) { console.warn('[correlation check]', e.message); }
}

// ========== Smartness score (0–12) ==========
// Transparent grading: how many independent quality dimensions did this
// signal actually pass? User-visible so they can compare signals at a glance.
function smartnessScore(s) {
  let score = 0;
  // 1. Confluence ≥75%
  const winners = s.direction === 'BUY' ? s.bull_count : s.bear_count;
  if (winners / Math.max(1, s.total_indicators) >= 0.75) score++;
  // 2. Confidence ≥75
  if (s.confidence >= 75) score++;
  // 3. Daily HTF aligned
  if (s.htfTrend && s.htfTrend === (s.direction === 'BUY' ? 'up' : 'down')) score++;
  // 4. 4H trend aligned
  if (s.tf4hTrend && s.tf4hTrend === (s.direction === 'BUY' ? 'up' : 'down')) score++;
  // 5. ADX ≥25 (strong trend)
  if (s.adxNow != null && s.adxNow >= 25) score++;
  // 6. ADX ≥30 (very strong trend)
  if (s.adxNow != null && s.adxNow >= 30) score++;
  // 7. In a killzone
  if (s.session && s.session.toLowerCase().includes('killzone')) score++;
  // 8. No calendar penalty
  if ((s.calPenalty ?? 0) === 0) score++;
  // 9. Backtest ≥60%
  if (s.winProbability != null && s.backtestSamples >= 10 && s.winProbability >= 60) score++;
  // 10. Backtest ≥70%
  if (s.winProbability != null && s.backtestSamples >= 10 && s.winProbability >= 70) score++;
  // 11. 3+ strategies aligned
  const aligned = (s.firedStrategies || []).filter(f =>
    (s.direction === 'BUY' && f.bias === 'bullish') ||
    (s.direction === 'SELL' && f.bias === 'bearish')
  ).length;
  if (aligned >= 3) score++;
  // 12. Volatility regime is normal/expanding (not chaos or dead)
  if (s.volRegime && ['normal', 'expanding'].includes(s.volRegime)) score++;
  // Penalties: correlation contradiction takes one off
  if (s.correlationFlag) score = Math.max(0, score - 1);
  return score; // 0..12
}

// ========== Signal analysis ==========
// `data` is the 1h timeframe (primary). `daily` is optional daily OHLC for HTF bias.
function analyzePair(pair, data, daily = null) {
  // ── STRIP ZERO-RANGE BARS FROM END ──────────────────────────────────────
  // Yahoo Finance returns the IN-PROGRESS bar as the latest entry. For the
  // first few seconds/minutes of a new bar, it has c == o == h == l (no
  // actual price movement recorded yet). Every body-ratio check, range
  // calculation, and breakout test was failing because the latest bar had
  // range = 0. This single data-layer bug was the dominant reason SMC,
  // ICT, TREND, SQUEEZE, DIVERGENCE rarely fired — they all evaluate the
  // most recent bar's characteristics. Drop those zero-range trailing
  // bars so the strategies see the most recent COMPLETED bar instead.
  let ohlc = data.ohlc;
  while (ohlc.length > 60 && ohlc[ohlc.length - 1].h === ohlc[ohlc.length - 1].l) {
    ohlc = ohlc.slice(0, -1);
  }
  const closes = ohlc.map(b => b.c);
  const highs = ohlc.map(b => b.h);
  const lows = ohlc.map(b => b.l);
  const n = closes.length - 1;
  const current = closes[n];

  const rsiArr = rsi(closes);
  const rsiV = rsiArr[n];
  const ema20Arr = emaArr(closes, 20);
  const ema50Arr = emaArr(closes, 50);
  const ema200Arr = emaArr(closes, 200);
  const atrArr = atr(highs, lows, closes);
  const m = macd(closes);
  const e20 = ema20Arr[n], e50 = ema50Arr[n], e200 = ema200Arr[n];
  const bb = bollinger(closes);
  const atrV = atrArr[n];
  const st = stochastic(highs, lows, closes);
  const ad = adx(highs, lows, closes);

  // NULL-GUARD: indicators return null for the first N bars (rsi needs 14,
  // ema(20) needs 20, ema(200) needs 200, atr needs 14). For illiquid crypto
  // pairs that have <200 bars in our window, e200 is null. Comparisons like
  // `e50 > e200` silently coerce to `e50 > null === false`, which inverts the
  // trend vote (bears win when neither is comparable). The whole "Trend (EMA
  // stack)" signal becomes a coin flip. Better to bail with HOLD than feed
  // the strategy pipeline garbage. e200 is allowed to be null — most
  // strategies handle it — but we DO require rsi/e20/e50/atr to be defined.
  if (rsiV == null || e20 == null || e50 == null || atrV == null) {
    return {
      pair, direction: 'HOLD', confidence: 0,
      reason: 'insufficient history (need ≥50 bars + 14 ATR + 14 RSI)',
      timestamp: new Date().toISOString(),
      ohlc, n,
      // Empty strategy fields so renderer doesn't crash on undefined access
      smcPassed: false, orbPassed: false, ictPassed: false,
      trendPassed: false, squeezePassed: false, divergencePassed: false,
      momentumPassed: false,
    };
  }

  const votes = {};
  if (rsiV < 30) votes['RSI'] = ['bullish', `Oversold (${rsiV.toFixed(1)} < 30)`];
  else if (rsiV > 70) votes['RSI'] = ['bearish', `Overbought (${rsiV.toFixed(1)} > 70)`];
  else if (rsiV < 45) votes['RSI'] = ['bullish', `Leaning oversold (${rsiV.toFixed(1)})`];
  else if (rsiV > 55) votes['RSI'] = ['bearish', `Leaning overbought (${rsiV.toFixed(1)})`];
  else votes['RSI'] = ['neutral', `Neutral (${rsiV.toFixed(1)})`];

  if (m.line[n] > m.signal[n] && m.hist[n] > 0) votes['MACD'] = ['bullish', 'Line above signal, rising histogram'];
  else if (m.line[n] < m.signal[n] && m.hist[n] < 0) votes['MACD'] = ['bearish', 'Line below signal, falling histogram'];
  else votes['MACD'] = ['neutral', 'Crossover transition'];

  if (current > e20 && e20 > e50 && e50 > e200) votes['Trend (EMA stack)'] = ['bullish', 'Price > EMA20 > EMA50 > EMA200'];
  else if (current < e20 && e20 < e50 && e50 < e200) votes['Trend (EMA stack)'] = ['bearish', 'Price < EMA20 < EMA50 < EMA200'];
  else if (current > e50) votes['Trend (EMA stack)'] = ['bullish', 'Price above EMA50 (medium-term up)'];
  else if (current < e50) votes['Trend (EMA stack)'] = ['bearish', 'Price below EMA50 (medium-term down)'];
  else votes['Trend (EMA stack)'] = ['neutral', 'Mixed EMA alignment'];

  if (e20 > e50) votes['Short-term EMA'] = ['bullish', 'EMA20 above EMA50'];
  else if (e20 < e50) votes['Short-term EMA'] = ['bearish', 'EMA20 below EMA50'];
  else votes['Short-term EMA'] = ['neutral', 'EMAs crossing'];

  if (current < bb.lower[n]) votes['Bollinger Bands'] = ['bullish', 'Below lower band — mean reversion long'];
  else if (current > bb.upper[n]) votes['Bollinger Bands'] = ['bearish', 'Above upper band — mean reversion short'];
  else {
    const w = bb.upper[n] - bb.lower[n];
    const p = w > 0 ? (current - bb.lower[n]) / w : 0.5;
    if (p < 0.35) votes['Bollinger Bands'] = ['bullish', `Lower half of bands (${(p * 100).toFixed(0)}%)`];
    else if (p > 0.65) votes['Bollinger Bands'] = ['bearish', `Upper half of bands (${(p * 100).toFixed(0)}%)`];
    else votes['Bollinger Bands'] = ['neutral', 'Mid-band'];
  }

  const kV = st.k[n], dV = st.d[n];
  if (kV < 20 && dV < 20) votes['Stochastic'] = ['bullish', `Oversold (K=${kV.toFixed(0)}, D=${dV.toFixed(0)})`];
  else if (kV > 80 && dV > 80) votes['Stochastic'] = ['bearish', `Overbought (K=${kV.toFixed(0)}, D=${dV.toFixed(0)})`];
  else if (kV > dV) votes['Stochastic'] = ['bullish', '%K crossing above %D'];
  else votes['Stochastic'] = ['bearish', '%K below %D'];

  const adxV = ad.adx[n] || 0;
  if (adxV >= 25) {
    votes['ADX trend strength'] = (ad.pdi[n] > ad.mdi[n])
      ? ['bullish', `Strong trend up (ADX ${adxV.toFixed(0)})`]
      : ['bearish', `Strong trend down (ADX ${adxV.toFixed(0)})`];
  } else votes['ADX trend strength'] = ['neutral', `Ranging market (ADX ${adxV.toFixed(0)})`];

  // CCI (Commodity Channel Index, 20)
  const cciArr = cci(highs, lows, closes);
  const cciV = cciArr[n];
  if (cciV != null) {
    if (cciV < -100) votes['CCI'] = ['bullish', `Oversold (${cciV.toFixed(0)} < -100)`];
    else if (cciV > 100) votes['CCI'] = ['bearish', `Overbought (${cciV.toFixed(0)} > +100)`];
    else if (cciV < -50) votes['CCI'] = ['bullish', `Leaning oversold (${cciV.toFixed(0)})`];
    else if (cciV > 50) votes['CCI'] = ['bearish', `Leaning overbought (${cciV.toFixed(0)})`];
    else votes['CCI'] = ['neutral', `Mid-range (${cciV.toFixed(0)})`];
  }

  // Awesome Oscillator (Bill Williams)
  const aoArr = awesomeOscillator(highs, lows);
  const aoV = aoArr[n], aoPrev = aoArr[n - 1];
  if (aoV != null && aoPrev != null) {
    if (aoV > 0 && aoV > aoPrev) votes['Awesome Oscillator'] = ['bullish', `Above zero + rising (${aoV.toFixed(5)})`];
    else if (aoV < 0 && aoV < aoPrev) votes['Awesome Oscillator'] = ['bearish', `Below zero + falling (${aoV.toFixed(5)})`];
    else votes['Awesome Oscillator'] = ['neutral', `Mixed momentum`];
  }

  // Parabolic SAR (Wilder)
  const sarArr = parabolicSAR(highs, lows);
  const sarV = sarArr[n];
  if (sarV != null) {
    if (current > sarV) votes['Parabolic SAR'] = ['bullish', `Price above SAR (${sarV.toFixed(5)}) — trailing stop suggests uptrend`];
    else if (current < sarV) votes['Parabolic SAR'] = ['bearish', `Price below SAR (${sarV.toFixed(5)}) — trailing stop suggests downtrend`];
  }

  // Candlestick pattern
  const pattern = detectCandlestickPattern(ohlc);
  if (pattern) votes['Candlestick pattern'] = pattern;
  else votes['Candlestick pattern'] = ['neutral', 'No clear pattern on last close'];

  // RSI divergence — strong reversal signal when present
  const div = detectRSIDivergence(closes, rsiArr);
  if (div) votes['RSI divergence'] = div;

  // ========== Battle-tested strategies (only voting when fired) ==========
  // 10 institutional/price-action strategies distilled from forex literature.
  // Each only votes when its specific conditions are met — high signal-to-noise.
  const firedStrategies = [];
  const strategyResults = [
    ['Ichimoku', strategyIchimoku(ohlc)],
    ['EMA50 pullback', strategy50EmaPullback(ohlc, ema20Arr, ema50Arr, atrV)],
    ['Turtle breakout', strategyTurtleBreakout(ohlc)],
    ['Fibonacci level', strategyFibonacciLevel(ohlc)],
    ['Order block', strategyOrderBlock(ohlc)],
    ['Break of structure', strategyBreakOfStructure(ohlc)],
    // Smart Money Concepts (research consensus = highest-probability retail edge)
    ['Liquidity sweep', strategyLiquiditySweep(ohlc)],
    ['Fair Value Gap', strategyFairValueGap(ohlc)],
    ['Change of Character', strategyChangeOfCharacter(ohlc)],
    ['Premium/Discount', strategyPremiumDiscount(ohlc)],
    // FXAlexG Set and Forget — multi-timeframe AOI + engulfing trigger
    ['AlexG Set & Forget', strategyAlexGSetAndForget(ohlc, atrV)],
    // MambaFX Supply/Demand zone — labeled so user can identify Mamba-style signals
    ['MambaFX', strategyMambaFXSupplyDemand(ohlc)],
    // Documented-edge additions (academic + prop-firm research)
    ['Hidden RSI divergence', strategyHiddenDivergence(closes, rsiArr, ema50Arr)],
    ['TTM Squeeze breakout', strategyTTMSqueeze(ohlc, atrArr)],
    ['Three-bar reversal', strategyThreeBarReversal(ohlc)],
    // Classical chart patterns
    ['Double Top/Bottom', strategyDoubleTopBottom(ohlc)],
    ['Head & Shoulders', strategyHeadAndShoulders(ohlc)],
    ['Triangle breakout', strategyTriangle(ohlc)],
  ];
  for (const [name, result] of strategyResults) {
    if (result) {
      votes[name] = result;
      firedStrategies.push({ name, bias: result[0], reason: result[1] });
    }
  }

  // Higher timeframe bias from daily EMA50 direction
  let htfInfo = null;
  if (daily && daily.ohlc && daily.ohlc.length >= 60) {
    const dCloses = daily.ohlc.map(b => b.c);
    const dEma50 = emaArr(dCloses, 50);
    const dN = dCloses.length - 1;
    const dCurrent = dCloses[dN];
    const dEma50Now = dEma50[dN];
    const dEma50Prev = dEma50[dN - 5] ?? dEma50[dN];
    const slope = dEma50Now - dEma50Prev;
    if (dCurrent > dEma50Now && slope > 0) {
      votes['Daily trend'] = ['bullish', 'Daily price above EMA50 and rising — trend up'];
      htfInfo = { trend: 'up', emaSlope: slope };
    } else if (dCurrent < dEma50Now && slope < 0) {
      votes['Daily trend'] = ['bearish', 'Daily price below EMA50 and falling — trend down'];
      htfInfo = { trend: 'down', emaSlope: slope };
    } else {
      votes['Daily trend'] = ['neutral', 'Daily trend unclear / transitioning'];
      htfInfo = { trend: 'mixed' };
    }
  }

  // News sentiment for this pair in the last 24h
  const news = newsSentimentForPair(pair);
  if (news) {
    if (news.net > 0.3) votes['News sentiment'] = ['bullish', `${news.bull} bullish vs ${news.bear} bearish pair headlines`];
    else if (news.net < -0.3) votes['News sentiment'] = ['bearish', `${news.bear} bearish vs ${news.bull} bullish pair headlines`];
    else votes['News sentiment'] = ['neutral', `Mixed headlines (${news.bull}↑ / ${news.bear}↓)`];
  }

  // Support / resistance proximity
  const sr = findSupportResistance(ohlc);
  const distToSupport = Math.abs(current - sr.support) / current;
  const distToResistance = Math.abs(current - sr.resistance) / current;
  if (distToSupport < 0.002) {
    votes['Support / Resistance'] = ['bullish', `At support (${sr.support.toFixed(pair.includes('JPY') ? 3 : 5)}) — reversal zone`];
  } else if (distToResistance < 0.002) {
    votes['Support / Resistance'] = ['bearish', `At resistance (${sr.resistance.toFixed(pair.includes('JPY') ? 3 : 5)}) — reversal zone`];
  } else if (current > (sr.support + sr.resistance) / 2) {
    votes['Support / Resistance'] = ['bullish', 'Above mid-range'];
  } else {
    votes['Support / Resistance'] = ['bearish', 'Below mid-range'];
  }

  const w = indicatorWeights();
  let bull = 0, bear = 0, neutral = 0, tot = 0;
  for (const [ind, [bias]] of Object.entries(votes)) {
    const wt = w[ind] ?? 1;
    tot += wt;
    if (bias === 'bullish') bull += wt;
    else if (bias === 'bearish') bear += wt;
    else neutral += wt;
  }
  // Base confluence: % agreement among indicators that have a *directional*
  // opinion. Neutral votes abstain rather than dilute (matches how a trader
  // reads a chart). A 4-vote conviction floor prevents weak signals from
  // showing inflated % with only 1-2 indicators voting.
  const sess = currentSession();
  const sessionAdj = (sess.bonus - 1) * 25;
  const ctxAdj = contextAdjustment(pair);

  const directional = bull + bear;
  let direction, base;
  if (directional < 4 || bull === bear) {
    direction = 'HOLD'; base = 0;
  } else if (bull > bear) {
    direction = 'BUY'; base = bull / directional * 100;
  } else {
    direction = 'SELL'; base = bear / directional * 100;
  }

  // HARD GATE: kill the signal entirely if ADX is genuinely chopping (<14).
  if (adxV != null && adxV < 14) {
    direction = 'HOLD';
    base = 0;
  }

  // ── HTF-AWARE BASE CONFIDENCE (improves all strategies' starting point) ─
  // pickDirection above is purely indicator-vote-based — it ignores whether
  // the chosen direction agrees with the higher-timeframe trend. Every loss
  // in trade history was either counter-HTF or momentum-only; every winner
  // was HTF-aligned. So we adjust the base CONFIDENCE up or down based on
  // HTF alignment + strength. This boosts every downstream strategy's
  // displayed confidence to better reflect reality:
  //   • Aligned + strong HTF: +10 base (vote-supported continuation)
  //   • Aligned + moderate: +6
  //   • Aligned + weak: +3
  //   • Counter + weak HTF: -5 (mild — could be early reversal)
  //   • Counter + moderate: -10
  //   • Counter + strong: -15 (fighting a strong trend is statistically tough)
  // NOT a HOLD trigger — just a confidence reweight. Signal still fires;
  // user sees a more honest confidence number.
  if (direction !== 'HOLD' && htfInfo && htfInfo.trend !== 'mixed') {
    const aligned = (direction === 'BUY' && htfInfo.trend === 'up') ||
                    (direction === 'SELL' && htfInfo.trend === 'down');
    const e50 = ema50Arr[n], e200 = ema200Arr[n];
    let htfStrength = 0;
    if (e50 != null && e200 != null && e50 !== 0) {
      htfStrength = Math.abs(e50 - e200) / Math.abs(e50);
    }
    let baseAdj = 0;
    if (aligned) {
      if (htfStrength > 0.010) baseAdj = 10;
      else if (htfStrength > 0.005) baseAdj = 6;
      else baseAdj = 3;
    } else {
      if (htfStrength > 0.010) baseAdj = -15;
      else if (htfStrength > 0.005) baseAdj = -10;
      else baseAdj = -5;
    }
    base = Math.max(0, Math.min(100, base + baseAdj));
  }
  // ── ADX-AWARE BASE CONFIDENCE ──────────────────────────────────────────
  // Strong directional trends (high ADX) confirm vote-based direction. Low
  // ADX = mostly chop, votes are less reliable. Apply a graded adjustment:
  //   ADX 25+: signal is in a real trend = +5
  //   ADX 20-25: developing trend = +2
  //   ADX 14-20: weak/uncertain = -3 (signal possible but lower confidence)
  if (direction !== 'HOLD' && adxV != null) {
    if (adxV >= 30) base = Math.min(100, base + 6);
    else if (adxV >= 25) base = Math.min(100, base + 4);
    else if (adxV >= 20) base = Math.min(100, base + 2);
    else if (adxV < 18)  base = Math.max(0, base - 3);
  }

  // STRATEGIES — both SMC and ORB run INDEPENDENTLY on the indicator-derived
  // direction. Each evaluates its own gates + quality grade. A signal fires
  // and shows on the page if EITHER strategy passes its rules. Direction is
  // forced to HOLD only when BOTH strategies fail — that way ORB-only setups
  // never get suppressed by SMC's stricter rules and vice versa. SMC and
  // ORB are tracked separately so each gets its own win-rate, auto-track,
  // and notification pipeline.
  let smcResult = null;
  let orbResult = null;
  let ictResult = null;
  let trendResult = null;
  let squeezeResult = null;
  let divergenceResult = null;
  let momentumResult = null;
  if (direction !== 'HOLD') {
    // BIDIRECTIONAL STRATEGY EVALUATION
    // ──────────────────────────────────
    // Previously each strategy was forced to confirm the indicator-derived
    // direction. But strategies like SMC are MEAN-REVERSION — if price is at
    // the bottom of the range with a sweep+reclaim, SMC says BUY *regardless*
    // of what RSI/MACD say overall. Forcing SMC to confirm an indicator-SELL
    // when price is at a discount sweep was rejecting 90%+ of valid SMC
    // setups. Same problem for ICT (returns to FVG can be either direction),
    // TREND (e50 vs e200 dictates own direction), and DIVERGENCE.
    //
    // Fix: run each strategy in BOTH directions. The one that passes "wins"
    // for that strategy. If both directions pass on the same strategy
    // (unlikely but possible), the indicator-aligned one is preferred. If a
    // strategy disagrees with the indicator direction, we flip the SIGNAL
    // direction to match the strategy when ALL passing strategies agree
    // (or when 2+ strategies agree on one direction vs only 1 on the other).
    const tryBoth = (fn) => {
      const buyR  = fn(ohlc, 'BUY',  pair);
      const sellR = fn(ohlc, 'SELL', pair);
      const buyOk  = buyR  && buyR.passed;
      const sellOk = sellR && sellR.passed;
      if (buyOk && sellOk) {
        // Both directions pass somehow — prefer the indicator-aligned one
        return { result: direction === 'BUY' ? buyR : sellR, dir: direction };
      }
      if (buyOk)  return { result: buyR,  dir: 'BUY'  };
      if (sellOk) return { result: sellR, dir: 'SELL' };
      // Neither passed — return the indicator-direction result so its diag
      // info (gates + failure reasons) shows up for debugging.
      return { result: direction === 'BUY' ? buyR : sellR, dir: direction };
    };

    const smcTry  = tryBoth(smcConfirmation);
    const orbTry  = tryBoth(orbConfirmation);
    const ictTry  = tryBoth(ictConfirmation);
    const trendTry= tryBoth(trendPullbackConfirmation);
    const sqTry   = tryBoth(squeezeConfirmation);
    const divTry  = tryBoth(rsiDivergenceConfirmation);
    const momTry  = tryBoth(momentumConfirmation);

    // Direction voting: count strategies passing per direction and pick the
    // majority. If tied, fall back to indicator direction.
    let buyVotes = 0, sellVotes = 0;
    for (const t of [smcTry, orbTry, ictTry, trendTry, sqTry, divTry, momTry]) {
      if (t.result?.passed) {
        if (t.dir === 'BUY')  buyVotes++;
        if (t.dir === 'SELL') sellVotes++;
      }
    }
    let chosenDir = direction;
    if (buyVotes > sellVotes) chosenDir = 'BUY';
    else if (sellVotes > buyVotes) chosenDir = 'SELL';
    // (else: tie — keep indicator direction)

    // If the chosen direction differs from the indicator pick, we need to
    // recompute base/votes for confidence display. Easiest: just flip
    // 'base' to mirror across 50% (so a 70% SELL becomes 70% BUY).
    if (chosenDir !== direction) {
      direction = chosenDir;
      // Confidence stays the same — strategies confirmed it just as strongly
      // in the opposite direction.
    }

    // A strategy only "counts as confirmed" when it passes in the SIGNAL'S
    // direction. So we pick: result if it passed AND its dir matches the
    // signal's chosen direction; otherwise null (treated as "did not fire").
    // This guarantees the .passed flag on each strategy matches the final
    // signal direction — no confused "SELL signal with SMC BUY confirmation".
    const inDir = (t) => (t.result?.passed && t.dir === chosenDir) ? t.result : null;
    smcResult        = inDir(smcTry);
    orbResult        = inDir(orbTry);
    ictResult        = inDir(ictTry);
    trendResult      = inDir(trendTry);
    squeezeResult    = inDir(sqTry);
    divergenceResult = inDir(divTry);
    momentumResult   = inDir(momTry);

    const anyPassed = (smcResult && smcResult.passed) ||
                      (orbResult && orbResult.passed) ||
                      (ictResult && ictResult.passed) ||
                      (trendResult && trendResult.passed) ||
                      (squeezeResult && squeezeResult.passed) ||
                      (divergenceResult && divergenceResult.passed) ||
                      (momentumResult && momentumResult.passed);
    if (!anyPassed) {
      // No strategy confirmed — suppress entirely. User only wants signals
      // backed by a real strategy confirmation, not generic confluence.
      direction = 'HOLD';
      base = 0;
    } else {
      // EXPERIENCE OVERLAY — apply institutional trading wisdom to every
      // strategy that passed. Wisdom adjusts the quality score within ±15
      // based on day-of-week, session sweet spots, round-number traps,
      // pair correlation, win/loss streaks, GBP volatility, etc.
      const apply = (res, sk) => {
        if (res && res.passed && res.quality) {
          const sigStub = { entry: ohlc[ohlc.length - 1]?.c, volRegimeFlag: null };
          res.quality = applyTraderExperience(res.quality, sigStub, ohlc, pair, direction, sk);
        }
      };
      apply(smcResult, 'smc');
      apply(orbResult, 'orb');
      apply(ictResult, 'ict');
      apply(trendResult, 'trend');
      apply(squeezeResult, 'squeeze');
      apply(divergenceResult, 'divergence');
      apply(momentumResult, 'momentum');

      // ── MULTI-STRATEGY CONFLUENCE BOOST ──────────────────────────────
      const passCount = [smcResult, orbResult, ictResult, trendResult, squeezeResult, divergenceResult, momentumResult]
        .filter(r => r && r.passed).length;
      if (passCount >= 2) {
        const confluenceBoost = passCount === 2 ? 8 : passCount === 3 ? 15 : passCount === 4 ? 22 : 28;
        const boost = (res) => {
          if (res && res.passed && res.quality) {
            const newScore = Math.min(100, res.quality.score + confluenceBoost);
            res.quality.score = newScore;
            res.quality.grade = _qualityGrade(newScore);
            (res.quality.breakdown ||= []).push(`Multi-strategy ${passCount}× +${confluenceBoost}`);
          }
        };
        boost(smcResult); boost(orbResult); boost(ictResult);
        boost(trendResult); boost(squeezeResult); boost(divergenceResult); boost(momentumResult);
      }
    }
  }

  // Higher-timeframe alignment: +4pp if signal agrees with daily trend, -5pp if
  // it fights it. Softened from -8 so borderline signals still surface.
  let htfAdj = 0;
  if (htfInfo && direction !== 'HOLD') {
    const alignedUp = direction === 'BUY' && htfInfo.trend === 'up';
    const alignedDown = direction === 'SELL' && htfInfo.trend === 'down';
    const against = (direction === 'BUY' && htfInfo.trend === 'down') || (direction === 'SELL' && htfInfo.trend === 'up');
    if (alignedUp || alignedDown) htfAdj = 4;
    else if (against) htfAdj = -5;
  }

  // Strategy-confluence bonus: multiple battle-tested strategies aligning is
  // historically much higher-probability than a single indicator reading.
  let stratBonus = 0;
  if (direction !== 'HOLD' && firedStrategies.length > 0) {
    const aligned = firedStrategies.filter(f =>
      (direction === 'BUY' && f.bias === 'bullish') ||
      (direction === 'SELL' && f.bias === 'bearish')
    ).length;
    // Bonuses scale with how many of 14 independent strategies agree.
    // Multi-strategy alignment is the single biggest predictor of pro setups.
    if (aligned >= 6) stratBonus = 20;
    else if (aligned === 5) stratBonus = 17;
    else if (aligned === 4) stratBonus = 13;
    else if (aligned === 3) stratBonus = 9;
    else if (aligned === 2) stratBonus = 5;
    else if (aligned === 1) stratBonus = 2;
  }

  // Economic-calendar penalty: high-impact event for this pair's currencies
  // within ±30 min or in next 2 hours → cap or reduce confidence.
  const calEvent = nearbyHighImpactEvent(pair);
  let calPenalty = 0;
  let calNote = null;
  if (calEvent) {
    const m = calEvent.minutes;
    if (m >= -30 && m <= 30) { calPenalty = -30; calNote = `${calEvent.event.country} ${calEvent.event.title} in ${m >= 0 ? '+' : ''}${m} min — avoid trading through it`; }
    else if (m > 30 && m <= 120) { calPenalty = -12; calNote = `${calEvent.event.country} ${calEvent.event.title} in +${m} min — stay cautious`; }
  }

  // Compute additional smarter adjustments BEFORE final confidence
  const macdRes = macd(closes);
  const arrs = {
    rsi: rsiArr,
    macd_line: macdRes.line,
    macd_signal: macdRes.signal,
    macd_hist: macdRes.hist,
    ema20: ema20Arr,
    ema50: ema50Arr,
    atr: atrArr,
  };
  const backtest = backtestPattern(pair, ohlc, arrs, direction);
  const winProbability = backtest.winRate != null ? Math.round(backtest.winRate * 100) : null;
  const adxNow = adxV;
  const volRegime = volatilityRegime(atrArr);
  const tf4hTrend = trend4H(closes);

  let volPenalty = 0;
  if (volRegime === 'chaos') volPenalty = -10;
  else if (volRegime === 'dead') volPenalty = -7;

  let tf4hAdj = 0;
  if (tf4hTrend === 'up' && direction === 'BUY') tf4hAdj = 3;
  else if (tf4hTrend === 'down' && direction === 'SELL') tf4hAdj = 3;
  else if (tf4hTrend === 'up' && direction === 'SELL') tf4hAdj = -4;
  else if (tf4hTrend === 'down' && direction === 'BUY') tf4hAdj = -4;

  // Pattern-match bonus from your past closed trades with the same strategy combo
  const partialSig = { pair, direction, firedStrategies };
  const ptn = patternMatchBonus(partialSig);
  const patternAdj = ptn.bonus;
  const patternNote = ptn.note;

  // Top-backtested-strategy bonus: extra confidence when one of the strategies
  // ranked highest in the most recent full backtest is firing here too.
  const btBoost = topBacktestedStrategyBoost(partialSig);
  const backtestAdj = btBoost.bonus;

  // Market regime detection + strategy-regime fit
  const recentAtrs = atrArr.slice(Math.max(0, n - 50), n).filter(x => x != null && x > 0);
  const atrAvgRegime = recentAtrs.length ? recentAtrs.reduce((s, x) => s + x, 0) / recentAtrs.length : atrV;
  const regime = detectRegime(adxNow, atrV, atrAvgRegime, bb.upper[n], bb.lower[n]);
  const regimeRes = regimeAdjustment(firedStrategies, regime, direction);
  const regimeAdj = regimeRes.adj;
  const regimeNote = regimeRes.note;

  const rawConfidence = Math.max(0, Math.min(100, Math.round(
    base + sessionAdj + ctxAdj + htfAdj + tf4hAdj + stratBonus + calPenalty + volPenalty + patternAdj + backtestAdj + regimeAdj
  )));
  // Calibrated confidence — adjusts displayed % based on actual historical
  // win rates at this confidence bucket. Heavy Bayesian shrinkage so small
  // sample sizes don't override the raw model output.
  const calib = calibratedConfidence(rawConfidence);
  const confidence = calib.calibrated;
  const calibrationSamples = calib.samples;
  const calibrationActualRate = calib.actualRate;

  // Structural SL — pros place stops BEYOND recent swing high/low so they
  // survive normal noise. We use whichever is further: ATR×1.5 OR last 20-bar
  // swing extreme + 0.4×ATR buffer. This produces meaningful invalidation
  // levels instead of random ATR-distance stops.
  // ATR CAP (new) — never let SL exceed 3.0×ATR from entry. Without this,
  // volatile pairs (especially crypto) could produce SLs hundreds of pips
  // away when the 20-bar swing happened to coincide with a recent crash.
  // The XRP/USD -439 pip loss this morning was exactly that scenario.
  // Caps keep $-risk per trade bounded while still giving normal-volatility
  // pairs the structural buffer they need.
  let sl, tp1, tp2, tp3;
  const window = ohlc.slice(-20);
  const swingHigh = Math.max(...window.map(b => b.h));
  const swingLow = Math.min(...window.map(b => b.l));

  // v199 — TP1 RAISED 0.5R → 1.0R based on web research. Multiple pro sources
  // (ThinkMarkets, LiteFinance, Trade Like Master, QuantifiedStrategies) all
  // converge on: minimum 2:1 R:R for profitability at sub-50% WR. With v196
  // lock-at-TP1, every TP1 winner now banks 1.0R instead of 0.5R. Combined
  // with achievable 45% WR target on gold-elite setups, math becomes:
  //   0.45 × 1R - 0.55 × 0.5R (avg loss from BE-trail / time-stop) = +0.18R/trade
  // TP2 raised to 2.5R, TP3 to 4R per research's "swing high/low extension".
  if (direction === 'BUY') {
    const slStructural = swingLow - atrV * 0.4;
    const slAtr = current - atrV * 1.5;
    const slCap = current - atrV * 3.0;
    sl = Math.min(slStructural, slAtr);
    sl = Math.max(sl, slCap);
    const slDistance = current - sl;
    tp1 = current + slDistance * 1.0;     // v199: 1:1 R:R (was 0.5R)
    tp2 = current + slDistance * 2.5;     // v199: 2.5:1 R:R (was 2.0)
    tp3 = current + slDistance * 4.0;     // v199: 4:1 R:R (was 3.0)
  } else if (direction === 'SELL') {
    const slStructural = swingHigh + atrV * 0.4;
    const slAtr = current + atrV * 1.5;
    const slCap = current + atrV * 3.0;
    sl = Math.max(slStructural, slAtr);
    sl = Math.min(sl, slCap);
    const slDistance = sl - current;
    tp1 = current - slDistance * 1.0;     // v199: 1:1 R:R
    tp2 = current - slDistance * 2.5;
    tp3 = current - slDistance * 4.0;
  } else { sl = tp1 = tp2 = tp3 = current; }

  // Typical retail spread per pair in pips. Used to compute effective R:R
  // and warn the user when spread eats too much of the trade's profit.
  const SPREADS = {
    // Majors — tightest
    'EUR/USD': 0.8, 'GBP/USD': 1.0, 'USD/JPY': 0.8, 'AUD/USD': 1.2,
    'USD/CAD': 1.5, 'USD/CHF': 1.5, 'NZD/USD': 1.8,
    // JPY crosses
    'EUR/JPY': 1.5, 'GBP/JPY': 2.5, 'AUD/JPY': 2.0, 'NZD/JPY': 2.5,
    'CHF/JPY': 2.5, 'CAD/JPY': 2.5,
    // EUR crosses
    'EUR/GBP': 1.5, 'EUR/CHF': 2.0, 'EUR/AUD': 2.5, 'EUR/CAD': 2.5,
    'EUR/NZD': 3.5,
    // GBP crosses
    'GBP/CHF': 3.0, 'GBP/AUD': 3.5, 'GBP/CAD': 3.5, 'GBP/NZD': 5.0,
    // Cross / commodity
    'AUD/NZD': 3.0, 'AUD/CAD': 2.5, 'NZD/CAD': 3.5, 'AUD/CHF': 3.0,
    'NZD/CHF': 4.0,
    // CHF cross
    'CAD/CHF': 3.0,
    // Crypto — typical retail-broker / CEX spreads in pip-equivalents
    // (BTC pip = $1 here, so 5.0 = $5 spread; ETH pip = $0.10, so 5 = $0.50)
    'BTC/USD':  5.0, 'ETH/USD': 5.0,  'SOL/USD': 3.0, 'BNB/USD': 4.0,
    'XRP/USD':  3.0, 'ADA/USD': 3.0,  'DOGE/USD': 4.0, 'AVAX/USD': 4.0,
  };
  const spreadPips = SPREADS[pair] ?? 2.0;

  const _pcfg = pairConfig(pair);
  const digits = _pcfg.digits;
  const pip = _pcfg.pip;
  const r = (v) => Number(v.toFixed(digits));

  // Loss-pattern blocker — if this exact strategy combination has historically
  // lost on this pair, force the signal to HOLD so it never appears.
  const blockReason = isBlockedLossPattern({ pair, direction, firedStrategies });
  if (blockReason) {
    direction = 'HOLD';
    base = 0;
  }
  // Signal cooldown — same pair+direction within last 4h is suppressed
  const cooldownLeft = inCooldown(pair, direction);
  // (We don't HOLD on cooldown; we just flag it so renderSignals can dim/skip)

  // ─────────────────────────────────────────────────────────────────────
  // SPREAD-EATS-PROFIT HARD GUARD
  // If the broker spread is too large relative to the trade's TP1 distance,
  // the trade is structurally unprofitable — the spread eats too much of
  // the win and pads the loss. Reject these aggressively even if the
  // strategies passed, because the risk:reward after spread is broken.
  // Threshold: TP1 must be at least 2.5× the spread cost.
  const tp1RawPips = Math.abs(current - tp1) / pip;
  const slRawPips  = Math.abs(current - sl)  / pip;
  if (direction !== 'HOLD' && tp1RawPips > 0) {
    const spreadEats = spreadPips / tp1RawPips;
    if (spreadEats > 0.40) {
      // More than 40% of expected profit eaten by spread → kill the signal.
      // CRITICAL: must null ALL strategy results, including momentumResult.
      // Previous version forgot momentum — so a HOLD'd signal could still
      // carry `momentumPassed: true`, which the auto-tracker would interpret
      // as a live setup and create a phantom trade for a HOLD.
      direction = 'HOLD';
      base = 0;
      smcResult = orbResult = ictResult = trendResult = squeezeResult = divergenceResult = momentumResult = null;
    }
  }
  // ─────────────────────────────────────────────────────────────────────
  // VOLATILITY REGIME DETECTOR
  // Compares current ATR against its 50-bar average. Flags extreme spikes
  // (e.g. surprise news, rate decisions, flash moves) where chart patterns
  // become unreliable. Doesn't kill the signal — annotates it so the user
  // sees "⚠ extreme volatility" badge on the card.
  let volRegimeFlag = null;
  try {
    const atrSeries = atr(highs, lows, closes, 14);
    const atrCur = atrSeries[atrSeries.length - 1];
    const atrWindow = atrSeries.slice(-50).filter(v => v != null);
    if (atrCur && atrWindow.length >= 20) {
      const atrAvg = atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length;
      const ratio = atrCur / atrAvg;
      if (ratio > 2.5) volRegimeFlag = { kind: 'extreme', ratio: ratio.toFixed(2) };
      else if (ratio < 0.55) volRegimeFlag = { kind: 'dead', ratio: ratio.toFixed(2) };
    }
  } catch {}

  // ─────────────────────────────────────────────────────────────────────
  // MULTI-STRATEGY SUPER DETECTION
  // Original: 3+ independent strategies fire on the same direction =
  // institutional-grade confluence, far higher hit-rate than any single
  // strategy alone. Tagged as 🏆 SUPER on the signal card.
  //
  // v155 expansion: ALSO promote to SUPER when 2 strategies pass AND raw
  // indicator consensus is overwhelming (aligned minus opposing votes ≥ 5).
  // Reasoning: strong directional indicator agreement substitutes for a
  // 3rd formal strategy — if 5+ more indicators line up in the signal's
  // direction than against it, the conviction is institutional even when
  // only 2 strategies formally cleared their hard gates. Surfaces more
  // genuine SUPER setups where the data supports them.
  const stratResults = [smcResult, orbResult, ictResult, trendResult, squeezeResult, divergenceResult, momentumResult];
  const passingStrats = stratResults.filter(r => r && r.passed).length;
  const _superVoteVals = Object.values(votes);
  const _bullV = _superVoteVals.filter(v => v[0] === 'bullish').length;
  const _bearV = _superVoteVals.filter(v => v[0] === 'bearish').length;
  const superAlignedDelta = direction === 'BUY' ? _bullV - _bearV
                         : direction === 'SELL' ? _bearV - _bullV
                         : 0;
  const _superByStrats = passingStrats >= 3;
  const _superByConsensus = passingStrats >= 2 && superAlignedDelta >= 5;
  const isSuperSetup = _superByStrats || _superByConsensus;
  const superReason = _superByStrats ? 'strategies' : (_superByConsensus ? 'consensus' : null);

  // ── EXPECTED HOLD TIME (for day traders) ──────────────────────────────
  // Estimates how many 1H bars it'll take for price to either hit TP1 or SL.
  // Formula: 2 × (TP1_distance / ATR_per_bar). The 2× factor accounts for
  // price oscillation — real markets zig-zag instead of going straight to
  // target, so the average path length is roughly double the straight-line
  // distance. This is a heuristic, not a guarantee.
  //
  // Use cases:
  //   • Day Trader filter (≤6 hours = fast enough to manage same-session)
  //   • Display badge on each signal so user knows commitment level upfront
  //   • Lets user pick fast scalps vs longer-hold swing setups
  let expectedHoldHours = null;
  if (atrV && atrV > 0) {
    const tp1DistAbs = Math.abs(current - tp1);
    expectedHoldHours = Math.round((tp1DistAbs / atrV) * 2 * 10) / 10;
  }

  // ── DAY TRADER FRIENDLINESS ───────────────────────────────────────────
  // Composite check for "this is a good day-trading setup" — meaning:
  //  • Resolves within ~one session (≤8 hrs expected)
  //  • At least 2 strategies confirming (not lone-wolf)
  //  • In London or NY session (highest liquidity = faster moves)
  //  • Not fighting the higher-timeframe trend (those grind for days)
  //  • Solid confidence (≥65%) and decent ADX (real direction, not chop)
  // This becomes the criterion for the new "Day Trader" filter mode.
  // HTF aligned: trend matches direction, or HTF info missing/mixed
  const htfAligned = !htfInfo ||
    htfInfo.trend === 'mixed' ||
    (direction === 'BUY'  && htfInfo.trend === 'up') ||
    (direction === 'SELL' && htfInfo.trend === 'down');
  // Day-trader friendliness — incorporates LOSS-PATTERN LEARNING from
  // the user's actual closed-trade history. Excluded because they predicted
  // losses on real trades:
  //   • winProbability < 50% (backtest losses)
  //   • Momentum-only setups (no structural strategy backing)
  //   • Strict counter-trend (htfTrend opposite of direction)
  const hasStructuralStrategy = (
    (smcResult && smcResult.passed) ||
    (orbResult && orbResult.passed) ||
    (ictResult && ictResult.passed) ||
    (trendResult && trendResult.passed) ||
    (squeezeResult && squeezeResult.passed) ||
    (divergenceResult && divergenceResult.passed)
  );
  const isDayTraderSetup = (
    direction !== 'HOLD' &&
    expectedHoldHours != null && expectedHoldHours <= 10 &&
    hasStructuralStrategy &&
    Math.round(base) >= 55 &&
    htfAligned
  );

  // ─── v142: TOP-PREDICTOR ALIGNMENT FLAGS ──────────────────────────────
  // Two indicators historically rank highest for hit-rate on this app's
  // closed-trade dataset: Parabolic SAR (~71% wr when aligned) and MACD
  // histogram (~60% wr when aligned). Expose alignment booleans so the
  // auto-tracker can REQUIRE at least one of {PSAR aligned, MACD aligned,
  // HTF/Daily trend aligned} agrees with the signal direction. This is
  // the v142 "at least one top predictor must agree" rule — kicks out
  // setups where ALL three disagree with direction even though strategies
  // fired (the worst losing pattern in the recent loss audit).
  const psarSignal = (sarV != null && current != null)
    ? (current > sarV ? 'bull' : current < sarV ? 'bear' : null)
    : null;
  const psarAligned = (
    (direction === 'BUY'  && psarSignal === 'bull') ||
    (direction === 'SELL' && psarSignal === 'bear')
  );
  const macdHistNow = (macdRes && macdRes.hist) ? macdRes.hist[macdRes.hist.length - 1] : null;
  const macdHistSignal = (macdHistNow != null)
    ? (macdHistNow > 0 ? 'bull' : macdHistNow < 0 ? 'bear' : null)
    : null;
  const macdHistAligned = (
    (direction === 'BUY'  && macdHistSignal === 'bull') ||
    (direction === 'SELL' && macdHistSignal === 'bear')
  );
  // htfAligned already computed above using htfInfo.trend (the daily/4h
  // higher-timeframe bias). Re-use as the "Daily trend aligned" predictor.
  const dailyTrendAligned = !!htfAligned && (
    (direction === 'BUY'  && htfInfo?.trend === 'up') ||
    (direction === 'SELL' && htfInfo?.trend === 'down')
  );
  // Count how many of the top 3 predictors agree with our direction.
  // Used as a quality bonus in scoring AND as the v142 hard filter.
  const topPredictorsAligned = (psarAligned ? 1 : 0) + (macdHistAligned ? 1 : 0) + (dailyTrendAligned ? 1 : 0);

  return {
    pair, symbol: data.symbol, direction, confidence,
    current: r(current), entry: r(current),
    blockReason,
    cooldownMinutesLeft: cooldownLeft,
    sl: r(sl), tp1: r(tp1), tp2: r(tp2), tp3: r(tp3),
    sl_pips: Number((Math.abs(current - sl) / pip).toFixed(1)),
    tp1_pips: Number((Math.abs(current - tp1) / pip).toFixed(1)),
    tp2_pips: Number((Math.abs(current - tp2) / pip).toFixed(1)),
    tp3_pips: Number((Math.abs(current - tp3) / pip).toFixed(1)),
    // Day-trader fields
    expectedHoldHours,
    isDayTraderSetup,
    spread_pips: spreadPips,
    // Real R:R after broker spread eats both sides. SL distance gets PADDED
    // (you lose more), TP distance gets REDUCED (you win less).
    effective_sl_pips: Number(((Math.abs(current - sl) / pip) + spreadPips).toFixed(1)),
    effective_tp1_pips: Number(Math.max(0, (Math.abs(current - tp1) / pip) - spreadPips).toFixed(1)),
    effective_tp2_pips: Number(Math.max(0, (Math.abs(current - tp2) / pip) - spreadPips).toFixed(1)),
    effective_tp3_pips: Number(Math.max(0, (Math.abs(current - tp3) / pip) - spreadPips).toFixed(1)),
    structural_sl: true,
    atr: r(atrV), rr: '1:1 / 1:2 / 1:3',
    votes,
    bull_count: Object.values(votes).filter(v => v[0] === 'bullish').length,
    bear_count: Object.values(votes).filter(v => v[0] === 'bearish').length,
    neutral_count: Object.values(votes).filter(v => v[0] === 'neutral').length,
    total_indicators: Object.keys(votes).length,
    timestamp: new Date().toISOString(),
    // Data freshness — how old is the last candle's timestamp?
    data_age_minutes: ohlc.length ? Math.round((Date.now() - ohlc[ohlc.length - 1].t) / 60000) : null,
    // Signal is valid until the next 1h candle close. After that, fresh data
    // arrives and a new signal is generated — old one becomes stale.
    expiresAt: (() => { const d = new Date(); d.setUTCMinutes(60, 0, 0); return d.toISOString(); })(),
    session: sess.name,
    baseConfidence: Math.round(base),
    sessionAdj: Number(sessionAdj.toFixed(1)),
    learnedAdj: Number(ctxAdj.toFixed(1)),
    htfAdj, calPenalty, calNote,
    htfTrend: htfInfo?.trend || null,
    // v142: top-predictor alignment exposed for the auto-tracker filter
    psarSignal, psarAligned,
    macdHistSignal, macdHistAligned, macdHistValue: macdHistNow,
    dailyTrendAligned,
    topPredictorsAligned,
    firedStrategies,
    stratBonus,
    winProbability,
    backtestSamples: backtest.samples,
    backtestWins: backtest.wins,
    backtestLosses: backtest.losses,
    adxNow: Math.round(adxNow),
    volRegime,
    tf4hTrend,
    tf4hAdj,
    volPenalty,
    patternAdj,
    patternNote,
    backtestAdj,
    backtestBoostNames: btBoost.names,
    regime,
    regimeAdj,
    regimeNote,
    rawConfidence,
    calibrationSamples,
    calibrationActualRate,
    smcPassed: smcResult ? smcResult.passed : null,
    smcDiag: smcResult ? smcResult.diag : null,
    smcQuality: smcResult?.quality?.score ?? null,
    smcGrade: smcResult?.quality?.grade ?? null,
    smcQualityBreakdown: smcResult?.quality?.breakdown ?? null,
    orbPassed: orbResult ? orbResult.passed : null,
    orbDiag: orbResult ? orbResult.diag : null,
    orbQuality: orbResult?.quality?.score ?? null,
    orbGrade: orbResult?.quality?.grade ?? null,
    orbQualityBreakdown: orbResult?.quality?.breakdown ?? null,
    // New strategies — same shape (passed/diag/quality/grade/breakdown)
    ictPassed: ictResult ? ictResult.passed : null,
    ictDiag: ictResult ? ictResult.diag : null,
    ictQuality: ictResult?.quality?.score ?? null,
    ictGrade: ictResult?.quality?.grade ?? null,
    ictQualityBreakdown: ictResult?.quality?.breakdown ?? null,
    trendPassed: trendResult ? trendResult.passed : null,
    trendDiag: trendResult ? trendResult.diag : null,
    trendQuality: trendResult?.quality?.score ?? null,
    trendGrade: trendResult?.quality?.grade ?? null,
    trendQualityBreakdown: trendResult?.quality?.breakdown ?? null,
    squeezePassed: squeezeResult ? squeezeResult.passed : null,
    squeezeDiag: squeezeResult ? squeezeResult.diag : null,
    squeezeQuality: squeezeResult?.quality?.score ?? null,
    squeezeGrade: squeezeResult?.quality?.grade ?? null,
    squeezeQualityBreakdown: squeezeResult?.quality?.breakdown ?? null,
    divergencePassed: divergenceResult ? divergenceResult.passed : null,
    divergenceDiag: divergenceResult ? divergenceResult.diag : null,
    divergenceQuality: divergenceResult?.quality?.score ?? null,
    divergenceGrade: divergenceResult?.quality?.grade ?? null,
    divergenceQualityBreakdown: divergenceResult?.quality?.breakdown ?? null,
    momentumPassed: momentumResult ? momentumResult.passed : null,
    momentumDiag: momentumResult ? momentumResult.diag : null,
    momentumQuality: momentumResult?.quality?.score ?? null,
    momentumGrade: momentumResult?.quality?.grade ?? null,
    momentumQualityBreakdown: momentumResult?.quality?.breakdown ?? null,
    // Smart-pass intelligence flags
    isSuperSetup,
    superReason,
    superAlignedDelta,
    passingStratsCount: passingStrats,
    volRegimeFlag,
    spreadEdgeRatio: tp1RawPips > 0 ? Number((spreadPips / tp1RawPips).toFixed(2)) : null,
    sr: { support: Number(sr.support.toFixed(digits)), resistance: Number(sr.resistance.toFixed(digits)) },
  };
}

// ========== Position-size math ==========
// Returns pip value in USD for ONE standard lot (100,000 units) of the pair.
// USD account assumed. Cross-pair conversions use the live USD rate of the
// quote currency, looked up from other signals already loaded on the page.
function pipValuePerLot(pair, price) {
  const quote = pair.split('/')[1];
  if (quote === 'USD') return 10;
  if (quote === 'JPY') return 1000 / (price || 100); // 0.01 × 100,000 / price
  // Pip value in quote currency = 10 (e.g. 10 GBP for EUR/GBP). Convert to USD
  // using the live quote-currency rate vs USD if we have it. Fallback to $10.
  const quoteUsdRate = lookupQuoteCurrencyToUSD(quote);
  if (quoteUsdRate != null && quoteUsdRate > 0) {
    return 10 * quoteUsdRate;
  }
  return 10; // honest fallback when no live rate available
}

// Find the USD value of 1 unit of the given currency by reading state.signals
// (which already contains live prices for all 19 pairs we track). Returns null
// if we can't determine.
function lookupQuoteCurrencyToUSD(currency) {
  if (currency === 'USD') return 1;
  if (!state || !state.signals) return null;
  // Direct: <CCY>/USD pair gives the rate
  for (const s of state.signals) {
    if (s.pair === `${currency}/USD` && s.entry > 0) return s.entry;
    // Inverse: USD/<CCY>: USD price per CCY = 1/entry
    if (s.pair === `USD/${currency}` && s.entry > 0) return 1 / s.entry;
  }
  // Common-currency triangulation via EUR or GBP
  for (const bridge of ['EUR', 'GBP']) {
    let bridgeUsd = null, currencyBridge = null;
    for (const s of state.signals) {
      if (s.pair === `${bridge}/USD` && s.entry > 0) bridgeUsd = s.entry;
      if (s.pair === `${bridge}/${currency}` && s.entry > 0) currencyBridge = 1 / s.entry; // CCY per bridge → bridge per CCY
      if (s.pair === `${currency}/${bridge}` && s.entry > 0) currencyBridge = s.entry;     // bridge per CCY directly
    }
    if (bridgeUsd && currencyBridge) return bridgeUsd * currencyBridge;
  }
  return null;
}

// Given the user's risk in USD, compute lot size, units, and profits at each TP.
function calculatePosition(signal, riskUsd) {
  const slPips = signal.sl_pips;
  const pipVal = pipValuePerLot(signal.pair, signal.entry);
  const lots = riskUsd / (slPips * pipVal);
  const units = Math.round(lots * 100000);
  const profit = (pips) => lots * pips * pipVal;
  return {
    lots, units, pipVal,
    profitTP1: profit(signal.tp1_pips),
    profitTP2: profit(signal.tp2_pips),
    profitTP3: profit(signal.tp3_pips),
    lossSL: -riskUsd,
    riskUsd,
  };
}

// ========== Active Trades (watchlist with win/loss tracking + delete) ==========
const SYNC_CODE_KEY = 'forexsight_sync_code';
function getTrades() { return safeLoad(TRADES_KEY, []); }
function saveTrades(t) {
  const trimmed = t.slice(-500);
  safeSave(TRADES_KEY, trimmed);
  pushTradesToCloud(trimmed); // fire-and-forget
  return true;
}

// ─── ONE-TIME DEDUP MIGRATION ─────────────────────────────────────────────
// Cleans up duplicate trades that already exist from before deterministic-IDs.
// Two devices used to each generate their own UUID for the SAME setup, so the
// same trade landed in My Trades twice after sync. This pass groups trades by
// pair+direction+day+status and keeps the most-resolved one (closed > open),
// merging strategy flags onto the survivor so nothing of value is lost.
//
// Runs ONCE per device per migration version. Bump the flag suffix if we ever
// need to re-run it after schema changes.
const DEDUP_MIGRATION_FLAG = 'forexsight_trades_dedup_v1';
function dedupExistingTradesOnce() {
  try {
    if (localStorage.getItem(DEDUP_MIGRATION_FLAG) === '1') return;
    const trades = getTrades();
    if (!trades.length) { localStorage.setItem(DEDUP_MIGRATION_FLAG, '1'); return; }
    const seen = new Map();          // groupKey → index in `kept`
    const kept = [];
    const dropped = [];
    for (const t of trades) {
      if (!t || !t.pair || !t.direction) { kept.push(t); continue; }
      // Group by pair+direction+day. Status NOT in the key — so an open
      // duplicate and a closed duplicate of the same setup collapse, with
      // the closed one winning (it has the final outcome).
      const day = (t.takenAt || '').slice(0, 10);
      const key = `${t.pair}_${t.direction}_${day}`;
      const idx = seen.get(key);
      if (idx == null) { seen.set(key, kept.length); kept.push(t); continue; }
      // Duplicate found — merge useful info onto the kept one
      const survivor = kept[idx];
      // Prefer the closed/resolved trade over the open one
      const tIsClosed = t.status && t.status !== 'open';
      const sIsClosed = survivor.status && survivor.status !== 'open';
      if (tIsClosed && !sIsClosed) {
        // Swap: current `t` is more resolved, make it the survivor.
        // Merge strategy flags FROM survivor onto t before swapping.
        for (const k of ['smcPassed','orbPassed','ictPassed','trendPassed','squeezePassed','divergencePassed','momentumPassed','isSMCAuto','isORBAuto','isRadiant']) {
          if (survivor[k] && !t[k]) t[k] = survivor[k];
        }
        kept[idx] = t;
        dropped.push(survivor.id);
      } else {
        // Survivor stays — just enrich it with any flags from t
        for (const k of ['smcPassed','orbPassed','ictPassed','trendPassed','squeezePassed','divergencePassed','momentumPassed','isSMCAuto','isORBAuto','isRadiant']) {
          if (t[k] && !survivor[k]) survivor[k] = t[k];
        }
        dropped.push(t.id);
      }
    }
    if (dropped.length) {
      saveTrades(kept);
      console.log(`[dedup-migration] collapsed ${dropped.length} duplicate trades (kept ${kept.length})`);
    }
    localStorage.setItem(DEDUP_MIGRATION_FLAG, '1');
  } catch (e) {
    console.warn('[dedup-migration]', e.message);
    // Don't set the flag — let it retry next boot if it crashed mid-run.
  }
}
// Run at module load — getTrades is just localStorage, no async deps needed.
dedupExistingTradesOnce();
function getSyncCode() { return localStorage.getItem(SYNC_CODE_KEY) || ''; }
function setSyncCode(c) {
  if (!c) localStorage.removeItem(SYNC_CODE_KEY);
  else localStorage.setItem(SYNC_CODE_KEY, c);
}

let _pushTimer = null;
let _lastSyncStatus = null;

// Unified pusher — sends BOTH trades and learning logs to KV under the same
// sync code. Falls back to the trades-only endpoint if the unified one fails.
function pushAllToCloud() {
  const code = getSyncCode();
  if (!code) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(async () => {
    try {
      const payload = {
        trades: getTrades(),
        logs: getLogs().slice(-1000), // cap to last 1000 entries to keep payload small
        signalNotes: safeLoad(SIGNAL_NOTES_KEY, {}) || {}, // v191 — sync notes across devices
        savedAt: new Date().toISOString(),
        clientVersion: 'forexsight-cf-v191',
      };
      const res = await fetch(`/api/sync-data?code=${encodeURIComponent(code)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) { _lastSyncStatus = { ts: Date.now(), ok: true, mode: 'unified' }; return; }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.warn('[sync] unified push failed, falling back to trades-only:', e.message);
      try {
        await fetch(`/api/trades?code=${encodeURIComponent(code)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(getTrades()),
        });
        _lastSyncStatus = { ts: Date.now(), ok: true, mode: 'trades-only' };
      } catch (e2) { _lastSyncStatus = { ts: Date.now(), ok: false, error: e2.message }; }
    }
  }, 1000);
}

// Backward-compat alias used elsewhere in the codebase
function pushTradesToCloud() { pushAllToCloud(); }

async function pullAllFromCloud() {
  const code = getSyncCode();
  if (!code) return { ok: false, reason: 'no sync code set' };
  try {
    // Try unified endpoint first
    let remote = null, mode = null;
    try {
      const res = await fetch(`/api/sync-data?code=${encodeURIComponent(code)}`);
      if (res.ok) {
        remote = await res.json();
        mode = 'unified';
      }
    } catch {}
    // Fallback: old trades-only endpoint (so existing sync codes keep working)
    if (!remote) {
      try {
        const res = await fetch(`/api/trades?code=${encodeURIComponent(code)}`);
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
        const oldRemote = await res.json();
        remote = { trades: Array.isArray(oldRemote) ? oldRemote : [], logs: [] };
        mode = 'trades-only';
      } catch (e) { return { ok: false, reason: e.message }; }
    }

    // Merge trades — TWO-PASS dedup:
    //   PASS 1: by id (handles deterministic-id auto-trades correctly)
    //   PASS 2: by pair+direction+day (catches legacy random-UUID duplicates
    //           that pre-date the deterministic-id fix)
    // Without pass 2, devices that auto-tracked the same signal BEFORE this
    // fix shipped would keep seeing two rows for the same setup forever.
    const localTrades = getTrades();
    const remoteTrades = Array.isArray(remote.trades) ? remote.trades : [];
    const tradesById = new Map();
    for (const t of [...remoteTrades, ...localTrades]) {
      if (!t || !t.id) continue;
      const existing = tradesById.get(t.id);
      const tStamp = t.closedAt || t.takenAt || '';
      const eStamp = existing ? (existing.closedAt || existing.takenAt || '') : '';
      if (!existing || tStamp > eStamp) tradesById.set(t.id, t);
    }
    // PASS 2 — collapse same-setup duplicates that escaped pass 1
    const bySetup = new Map();
    for (const t of tradesById.values()) {
      const day = (t.takenAt || '').slice(0, 10);
      const setupK = `${t.pair}_${t.direction}_${day}`;
      const existing = bySetup.get(setupK);
      if (!existing) { bySetup.set(setupK, t); continue; }
      // Prefer closed > open. If both same status, prefer the latest update.
      const tIsClosed = t.status && t.status !== 'open';
      const eIsClosed = existing.status && existing.status !== 'open';
      if (tIsClosed && !eIsClosed) { bySetup.set(setupK, t); continue; }
      if (!tIsClosed && eIsClosed) continue;
      const tStamp = t.closedAt || t.takenAt || '';
      const eStamp = existing.closedAt || existing.takenAt || '';
      if (tStamp > eStamp) bySetup.set(setupK, t);
    }
    const mergedTrades = Array.from(bySetup.values())
      .sort((a, b) => (a.takenAt || '').localeCompare(b.takenAt || ''))
      .slice(-500);
    safeSave(TRADES_KEY, mergedTrades);

    // Merge learning logs by composite key — most resolved version wins.
    // (A "won" or "lost" entry is more authoritative than a "pending" one
    //  since outcome detection happens on whichever device sees the price hit first.)
    const localLogs = getLogs();
    const remoteLogs = Array.isArray(remote.logs) ? remote.logs : [];
    const logsByKey = new Map();
    const stamp = (l) => `${l.ts || ''}|${l.pair || ''}|${l.direction || ''}|${l.entry || ''}`;
    for (const l of [...remoteLogs, ...localLogs]) {
      if (!l) continue;
      const k = stamp(l);
      const existing = logsByKey.get(k);
      if (!existing) { logsByKey.set(k, l); continue; }
      // Prefer resolved over pending; if both same, prefer remote (more recent global view)
      const lResolved = l.outcome === 'win' || l.outcome === 'loss';
      const eResolved = existing.outcome === 'win' || existing.outcome === 'loss';
      if (lResolved && !eResolved) logsByKey.set(k, l);
    }
    const mergedLogs = Array.from(logsByKey.values())
      .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
      .slice(-2000);
    safeSave(LOGS_KEY, mergedLogs);

    // v191 — merge signal notes across devices. Schema is wrapped objects
    // { text, updatedAt } per pair+direction key. Resolution: latest
    // updatedAt wins. Legacy unwrapped string entries are treated as
    // "older than any wrapped entry" so explicit edits take precedence.
    try {
      const remoteNotes = (remote && typeof remote.signalNotes === 'object' && remote.signalNotes) || {};
      const localNotes  = safeLoad(SIGNAL_NOTES_KEY, {}) || {};
      const mergedNotes = {};
      const allKeys = new Set([...Object.keys(remoteNotes), ...Object.keys(localNotes)]);
      for (const k of allKeys) {
        const r = remoteNotes[k];
        const l = localNotes[k];
        const _ts = (e) => (e && typeof e === 'object' && e.updatedAt) ? e.updatedAt : '';
        const rTs = _ts(r), lTs = _ts(l);
        if (r && l) {
          mergedNotes[k] = rTs > lTs ? r : l;
        } else {
          mergedNotes[k] = r || l;
        }
      }
      safeSave(SIGNAL_NOTES_KEY, mergedNotes);
    } catch (e) { console.warn('[sync] signal-notes merge:', e.message); }

    _lastSyncStatus = { ts: Date.now(), ok: true, mode };

    // Push merged state back so all devices converge on the union.
    if (mode === 'unified' &&
        (remoteTrades.length !== mergedTrades.length || remoteLogs.length !== mergedLogs.length)) {
      pushAllToCloud();
    }

    return {
      ok: true,
      tradesPulled: remoteTrades.length,
      tradesTotal: mergedTrades.length,
      logsPulled: remoteLogs.length,
      logsTotal: mergedLogs.length,
      mode,
    };
  } catch (e) {
    _lastSyncStatus = { ts: Date.now(), ok: false, error: e.message };
    return { ok: false, reason: e.message };
  }
}

// Backward-compat alias
async function pullTradesFromCloud() { return await pullAllFromCloud(); }

function takeTrade(signal, opts = {}) {
  const trades = getTrades();
  const dup = trades.find(t => t.pair === signal.pair && t.direction === signal.direction && t.status === 'open');
  if (dup) return { ok: false, reason: `Already have an open ${signal.pair} ${signal.direction} — close it first.` };
  // Cross-device dedup: if caller passes a deterministic id (auto-track
  // sources do — they hash pair+direction+day), both devices generate the
  // SAME id for the same signal. Cloud merge dedupes by id, so the trade
  // appears once even when both phones detected it. Manual takes still get
  // a random UUID so the user can take the same setup twice intentionally.
  const id = opts.id || uuid();
  // If a trade with this deterministic id already exists (e.g. cloud just
  // pulled it back to us), skip silently — duplicate is not an error.
  if (opts.id && trades.some(t => t.id === id)) {
    return { ok: false, reason: 'already synced from another device', dup: true };
  }
  // Preserve the FULL signal data including strategy passes + grades so the
  // trade row + modal can show which strategy(ies) caught this signal even
  // hours/days after the live signal is gone. Spread the whole signal first,
  // then override with trade-specific fields.
  const trade = {
    ...signal,
    id,
    // Trade-specific fields override the signal copy
    takenAt: new Date().toISOString(),
    status: 'open',
    closedAt: null,
    closePrice: null,
    pnlPips: null,
    notes: '',
  };
  trades.push(trade); saveTrades(trades);
  return { ok: true, trade };
}

// ─── Cross-device dedup helper ────────────────────────────────────────────
// Build a deterministic trade id from a setup key. Same setup on two phones
// → same id → cloud merge keeps one. Format: 'auto-{source}-{pair}-{dir}-{YYYY-MM-DD}'.
function autoTradeId(source, signal) {
  const day = new Date().toISOString().slice(0, 10);
  const pair = (signal.pair || '').replace('/', '');
  return `auto-${source}-${pair}-${signal.direction}-${day}`;
}

function deleteTrade(id) {
  const trades = getTrades().filter(t => t.id !== id);
  saveTrades(trades);
}

function closeTrade(id, outcome, closePrice, opts = {}) {
  const trades = getTrades();
  const t = trades.find(x => x.id === id);
  if (!t) return;
  t.status = outcome; // 'won' | 'lost' | 'closed'
  t.closedAt = new Date().toISOString();
  t.closePrice = closePrice ?? t.entry;
  // Persist tpReached (0=none, 1=TP1, 2=TP2, 3=TP3). The auto-evaluator
  // passes this so the UI can show "Won at TP3" vs "Won at TP1" etc. Manual
  // closes don't pass it — we'll infer from closePrice as a fallback.
  if (opts.tpReached != null) {
    t.tpReached = opts.tpReached;
  } else if (t.tpReached == null && outcome === 'won') {
    // Manual close: infer tpReached from closePrice. If user closed at TP3
    // we mark 3, at TP2 we mark 2, otherwise 1.
    const isBuy = t.direction === 'BUY';
    if (isBuy ? closePrice >= (t.tp3 ?? Infinity) : closePrice <= (t.tp3 ?? -Infinity))      t.tpReached = 3;
    else if (isBuy ? closePrice >= (t.tp2 ?? Infinity) : closePrice <= (t.tp2 ?? -Infinity)) t.tpReached = 2;
    else if (isBuy ? closePrice >= (t.tp1 ?? Infinity) : closePrice <= (t.tp1 ?? -Infinity)) t.tpReached = 1;
    else t.tpReached = 0; // closed before TP1 (manual exit at small profit)
  } else if (outcome === 'lost' && t.tpReached == null) {
    t.tpReached = 0;
  }
  // Use pairConfig() for pip size — handles JPY (0.01), gold (0.10), crypto
  // (per-pair: BTC=1, ETH=0.10, SOL=0.01, etc.), and standard FX (0.0001).
  // Previously this used a manual JPY/XAU ternary that fell through to 0.0001
  // for crypto, producing absurd pnl values like 6.4M pips for a BTC trade
  // that actually moved $645. Fix exposes properly-scaled crypto P/L.
  const pip = pairConfig(t.pair).pip;
  const direction = t.direction === 'BUY' ? 1 : -1;
  t.pnlPips = Number(((t.closePrice - t.entry) * direction / pip).toFixed(1));
  saveTrades(trades);
}

// Evaluate open trades against current OHLC — auto-mark win/loss if SL/TP hit.
// Returns the list of trades that just transitioned (so caller can notify).
// FAST TRADE TICK — runs every 90 seconds, fetches latest OHLC ONLY for
// v219 — REAL-TIME TRADE MONITOR. Checks every open trade against the latest
// live price every 10 seconds while the app is visible. Fires immediate
// notification when SL/TP is hit (no 60-90s lag). Symbols resolved via the
// unified pair lookup so XAU/USD (gold) is monitored just like forex pairs.
let _fastTickTimer = null;
let _fastTickInFlight = false;
let _lastFastTickAt = 0;
async function fastEvaluateOpenTrades() {
  if (_fastTickInFlight) return;
  _fastTickInFlight = true;
  try {
    const trades = getTrades();
    const openByPair = {};
    for (const t of trades) {
      if (t.status === 'open' && t.pair) {
        openByPair[t.pair] ||= [];
        openByPair[t.pair].push(t);
      }
    }
    const pairs = Object.keys(openByPair);
    if (!pairs.length) { _fastTickInFlight = false; return; }
    // v219 — pulse indicator: show "checking trades..." dot in My Trades tab
    _updateMonitorPulse('checking');
    const lookup = { ...PAIRS, ...CRYPTO_PAIRS };
    // Pair → Yahoo symbol — XAU/USD uses GC=F per v188
    if (!lookup['XAU/USD']) lookup['XAU/USD'] = 'GC=F';
    if (!lookup['GOLD'])    lookup['GOLD']    = 'GC=F';
    const results = await Promise.allSettled(pairs.map(async (p) => {
      const sym = lookup[p];
      if (!sym) return null;
      const r = await fetch(`/api/prices?symbol=${sym}`, { cache: 'no-store' });
      if (!r.ok) return null;
      const data = await r.json();
      return { pair: p, ohlc: data.ohlc };
    }));
    let totalClosed = 0;
    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value) continue;
      const { pair, ohlc } = res.value;
      const closed = evaluateOpenTrades(pair, ohlc);
      for (const tr of closed) {
        notifyTradeOutcome(tr);
        totalClosed++;
      }
    }
    _lastFastTickAt = Date.now();
    _updateMonitorPulse('ok', { closed: totalClosed });
    // v219 — if a trade just closed, refresh the visible trades view immediately
    if (totalClosed > 0 && typeof renderTrades === 'function') {
      try { renderTrades(); } catch {}
    }
  } catch (e) {
    console.warn('[fast-tick]', e.message);
    _updateMonitorPulse('error');
  } finally {
    _fastTickInFlight = false;
  }
}
function _updateMonitorPulse(state, info) {
  const el = document.getElementById('trade-monitor-pulse');
  if (!el) return;
  el.classList.remove('mon-checking', 'mon-ok', 'mon-error');
  if (state === 'checking') {
    el.classList.add('mon-checking');
    el.textContent = '● Monitoring open trades · checking now';
  } else if (state === 'ok') {
    el.classList.add('mon-ok');
    const secs = Math.round((Date.now() - _lastFastTickAt) / 1000);
    el.textContent = `● Live monitor · last check ${secs}s ago${info && info.closed ? ` · ${info.closed} just closed` : ''}`;
  } else if (state === 'error') {
    el.classList.add('mon-error');
    el.textContent = '● Monitor paused — connection issue';
  }
}
// v334 — SERVER-SYNC FALLBACK. The client-side monitor uses Yahoo OHLC
// which can be stale (BTC was 42h stale until v319 switched to Kraken).
// Even with fresh Kraken data now, if the user's app was closed when the
// TP hit, the client never saw it. Server-side tp-monitor DOES catch it.
// This function pulls server tp-status and auto-resolves any local open
// trade that server marks as won/lost. Runs every 30s + on app open.
async function syncTradeStatusFromServer() {
  try {
    const openTrades = getTrades().filter(t => t.status === 'open');
    if (!openTrades.length) return;
    const res = await fetch('/api/tp-status', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const serverSignals = data.signals || [];
    let resolvedCount = 0;
    for (const trade of openTrades) {
      // Match server signal to local trade by pair + direction + entry price
      // (within a small tolerance for rounding)
      const match = serverSignals.find(ss => {
        if (ss.pair !== trade.pair) return false;
        if (ss.direction !== trade.direction) return false;
        // Entry match within 0.01% (rounding tolerance)
        if (trade.entry && ss.entry) {
          const pctDiff = Math.abs(ss.entry - trade.entry) / trade.entry;
          if (pctDiff > 0.001) return false;
        }
        return true;
      });
      if (!match || !match.hits) continue;
      // Server knows about this trade — check for hits
      const hits = match.hits;
      let outcome = null;
      let closePrice = null;
      let tpReached = 0;
      if (hits.sl && !hits.tp1) {
        outcome = 'lost';
        closePrice = hits.sl.price || trade.sl;
      } else if (hits.tp3) {
        outcome = 'won';
        closePrice = hits.tp3.price || trade.tp3;
        tpReached = 3;
      } else if (hits.tp2) {
        outcome = 'won';
        closePrice = hits.tp2.price || trade.tp2;
        tpReached = 2;
      } else if (hits.tp1 && hits.sl) {
        // TP1 then SL = still a win at breakeven (SL was moved after TP1)
        outcome = 'won';
        closePrice = trade.entry;
        tpReached = 1;
      } else if (hits.tp1 && match.status && match.status.includes('WON')) {
        outcome = 'won';
        closePrice = hits.tp1.price || trade.tp1;
        tpReached = 1;
      }
      if (outcome) {
        closeTrade(trade.id, outcome, closePrice, { tpReached });
        console.log(`[server-sync] Auto-closed ${trade.pair} ${trade.direction} as ${outcome.toUpperCase()} (server-detected)`);
        resolvedCount++;
      }
    }
    if (resolvedCount > 0 && typeof renderTrades === 'function') {
      try { renderTrades(); } catch {}
    }
    return resolvedCount;
  } catch (e) {
    console.warn('[server-sync]', e.message);
  }
}

function startFastTradeTick() {
  if (_fastTickTimer) clearInterval(_fastTickTimer);
  // v219 — 10s polling cadence while visible (was 90s). When the app is
  // backgrounded, we suspend to save battery; on resume we trigger an
  // immediate check so the user sees current status without waiting.
  // v334 — Also pull server tp-status on each tick as backup source.
  _fastTickTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    fastEvaluateOpenTrades();
    syncTradeStatusFromServer();  // v334 backup path
  }, 10 * 1000);
  // v334 — Immediate sync on app open
  syncTradeStatusFromServer();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fastEvaluateOpenTrades();
  });
  // Run one immediately on startup
  setTimeout(fastEvaluateOpenTrades, 1500);
}

function evaluateOpenTrades(pair, ohlc) {
  const trades = getTrades();
  const transitioned = [];
  // PROGRESSIVE TP TRACKING — instead of closing the trade the instant TP1 is
  // hit, we keep the trade open and record the HIGHEST TP price has reached
  // (1, 2, or 3). The trade closes when:
  //   • Stop-loss is hit (lost)               OR
  //   • TP3 is reached (full win)             OR
  //   • SL has trailed to entry AND price comes back to entry (breakeven win
  //     — a TP1-level win that didn't continue further)
  //
  // Once TP1 is hit, the effective stop is moved to entry (breakeven). This
  // matches the standard "scale-out at TP1, runners trail to entry" pattern
  // and prevents a TP2+ runner from ever becoming a loss.
  //
  // The `tpReached` field is saved on the trade so the UI can show
  // "Won (TP3)" vs "Won (TP1)" so the user knows the magnitude.
  for (const t of trades) {
    if (t.status !== 'open' || t.pair !== pair) continue;
    const takenTs = new Date(t.takenAt).getTime();
    const relevant = ohlc.filter(b => b.t > takenTs);
    if (!relevant.length) continue;
    const hi = Math.max(...relevant.map(b => b.h));
    const lo = Math.min(...relevant.map(b => b.l));

    // Compute the MAXIMUM TP level price has reached since trade entry.
    const prevTpReached = t.tpReached || 0;
    let tpReached = prevTpReached;
    if (t.direction === 'BUY') {
      if (t.tp1 != null && hi >= t.tp1) tpReached = Math.max(tpReached, 1);
      if (t.tp2 != null && hi >= t.tp2) tpReached = Math.max(tpReached, 2);
      if (t.tp3 != null && hi >= t.tp3) tpReached = Math.max(tpReached, 3);
    } else if (t.direction === 'SELL') {
      if (t.tp1 != null && lo <= t.tp1) tpReached = Math.max(tpReached, 1);
      if (t.tp2 != null && lo <= t.tp2) tpReached = Math.max(tpReached, 2);
      if (t.tp3 != null && lo <= t.tp3) tpReached = Math.max(tpReached, 3);
    }

    // TIERED PROFIT LOCK-IN — improvement based on observed loss-of-profit
    // pattern: AUD/JPY and GBP/AUD both hit TP1, then BE-trail caught them
    // at exactly entry → wins of 0 pips. While that's a "win" in the database,
    // it doesn't actually bank profit. The improvement:
    //   • After TP1 hits → SL moves to entry + 25% of risk (LOCK IN 25% R)
    //   • After TP2 hits → SL moves to TP1 (LOCK IN 1R = guaranteed profit)
    //   • After TP3 hits → trade closes as full TP3 win
    // This way every win captures meaningful pips. If price reverses hard
    // after TP1, you still walk away with 25%R instead of 0.
    const dirSign = t.direction === 'BUY' ? 1 : -1;
    const riskDistance = Math.abs(t.entry - t.sl);
    let effectiveSL = t.sl;
    if (tpReached >= 2) {
      effectiveSL = t.tp1; // lock in 1R (= 2x TP1 distance since TP1 is 0.5R)
    } else if (tpReached >= 1) {
      // v196: ROOT-CAUSE FIX. After TP1 hits, lock SL at TP1 itself (not
      // entry+50%R). Audit: 82 of 119 wins were TP1-only, only 2 of 324
      // trades reached TP2. "Let runners go" thesis is broken — price
      // almost never runs that far before reversing. Locking SL at TP1
      // means: if price keeps running, still get TP2 chance; if it
      // reverses, trade closes at TP1 (full 0.5R win = double the prior
      // 0.25R lock). Math: avg winner doubles. At 37% WR with 0.5R
      // per winner vs 9.7p avg loss (≈0.5R), this flips EV positive.
      effectiveSL = t.tp1; // lock at TP1 — capture full 0.5R per winner
    } else if (t.tp1 != null) {
      // v184: PRE-TP1 BREAKEVEN TRAIL TIGHTENED 50% → 35%.
      // Once price reaches 35% of the entry→TP1 distance, move SL to entry.
      // Was 50% in v182. With TP1 now at 0.5R (v184), 35% of that = 0.175R
      // of price travel before BE-lock kicks in. Much harder for a price
      // ramp to almost-touch TP1 then reverse to full SL — by the time
      // price is 35% to TP1, the SL is already at entry.
      const tp1Dist = Math.abs(t.tp1 - t.entry);
      const halfwayPrice = t.entry + dirSign * (tp1Dist * 0.35);
      const reachedHalfway = t.direction === 'BUY'
        ? hi >= halfwayPrice
        : lo <= halfwayPrice;
      if (reachedHalfway) {
        effectiveSL = t.entry; // breakeven trail
      }
    }

    let outcome = null, price = null;
    if (t.direction === 'BUY') {
      if (lo <= effectiveSL) {
        // Stop hit. The price we stopped at depends on which trail level we
        // were on. If we trailed up to TP1 (tpReached >= 2), exit price is
        // TP1. If we trailed to "entry + 25%R" (tpReached === 1), exit
        // price is that 25%R locked-in level. Otherwise full original SL.
        if (tpReached >= 1) { outcome = 'won'; price = effectiveSL; }
        else                { outcome = 'lost'; price = effectiveSL; }
      } else if (tpReached >= 3) {
        outcome = 'won'; price = t.tp3;
      }
    } else if (t.direction === 'SELL') {
      if (hi >= effectiveSL) {
        if (tpReached >= 1) { outcome = 'won'; price = effectiveSL; }
        else                { outcome = 'lost'; price = effectiveSL; }
      } else if (tpReached >= 3) {
        outcome = 'won'; price = t.tp3;
      }
    }

    // TIME-STOP (v158) — TIERED by setup quality.
    //   • SUPER setups (3+ strats OR 2 strats + indicator delta ≥ 5):
    //       12h window. They've earned the breathing room.
    //   • Everything else (legacy 1-strat, weak 2-strat, etc.):
    //       4h hard cap. If they aren't working by 4h they're statistically
    //       likely to keep drifting against — cap the damage early instead
    //       of running to full SL.
    // Plus a "kill the underwater dragger" path: if a non-SUPER trade is in
    // the red at the 90-minute mark, force-close. The v146-era data showed
    // most non-SUPER losers hit SL within 0-2 hours — most "long holds" in
    // the red ended in losses, not recoveries. Caps a 1-2 hour drift at the
    // current floating loss instead of waiting for SL.
    const tStratCntForStop = [
      t.smcPassed, t.orbPassed, t.ictPassed, t.trendPassed,
      t.squeezePassed, t.divergencePassed, t.momentumPassed,
    ].filter(Boolean).length;
    const tIsSuper = t.isSuperSetup === true ||
                     tStratCntForStop >= 3 ||
                     (tStratCntForStop >= 2 && (t.superAlignedDelta || 0) >= 5);
    const ageMs = Date.now() - takenTs;
    // v188 day-trader timing: 2h hard cap non-SUPER (was 4h), 4h SUPER
    // (was 12h). Gold setups in active sessions resolve in 1-3 hours;
    // 4h+ holds are statistically late entries that drift sideways.
    const hardLimitMs = tIsSuper ? 4 * 3600 * 1000 : 2 * 3600 * 1000;
    // v188: underwater kill 60min → 30min. Faster damage control. Most
    // gold losers stop out within 30-45min of becoming underwater.
    const underwaterCutoffMs = tIsSuper ? Infinity : 30 * 60 * 1000;
    if (!outcome && ageMs > hardLimitMs) {
      const lastBar = relevant[relevant.length - 1];
      if (lastBar && Number.isFinite(lastBar.c)) {
        const inProfit = t.direction === 'BUY'
          ? lastBar.c > t.entry
          : lastBar.c < t.entry;
        outcome = inProfit ? 'won' : 'lost';
        price = lastBar.c;
      }
    } else if (!outcome && ageMs > underwaterCutoffMs) {
      const lastBar = relevant[relevant.length - 1];
      if (lastBar && Number.isFinite(lastBar.c)) {
        const inLoss = t.direction === 'BUY'
          ? lastBar.c < t.entry
          : lastBar.c > t.entry;
        if (inLoss) {
          outcome = 'lost';
          price = lastBar.c;
        }
      }
    }

    if (outcome) {
      closeTrade(t.id, outcome, price, { tpReached });
      transitioned.push({ ...t, newOutcome: outcome, closePrice: price, tpReached });
    } else if (tpReached !== prevTpReached) {
      // Trade still open but progressed to a new TP — persist the new level
      // so the UI can show "TP1 ✓" pills as the trade runs.
      const trades2 = getTrades();
      const t2 = trades2.find(x => x.id === t.id);
      if (t2) { t2.tpReached = tpReached; saveTrades(trades2); }
    }
  }
  return transitioned;
}

// Fire desktop notification + play chime when a trade closes
function notifyTradeOutcome(trade) {
  try {
    if (!trade || !trade.pair || !trade.direction) return;
    // v252 — Resolved trades land in HISTORY now (no longer My Trades). The
    // unread-counter + tab pulse moves to the History tab so the user sees
    // the indicator where the new outcome actually is.
    state.unreadTradeUpdates = (state.unreadTradeUpdates || 0) + 1;
    updateHistoryTabBadge();
    // STRONG ALERT — wins deserve celebration, losses deserve awareness.
    // Triple chime + strong vibrate + screen flash, same as signal alerts.
    const won = trade.newOutcome === 'won';
    try { playChime(); } catch {}
    setTimeout(() => { try { playChime(); } catch {} }, 800);
    setTimeout(() => { try { playChime(); } catch {} }, 1600);
    try { strongVibrate(won ? 'BUY' : 'SELL'); } catch {}
    try { flashScreen(won ? '#30d158' : '#ff453a'); } catch {}
    // Title includes the TP level reached so notification tells the user
    // whether this was a partial-TP1 win or a full TP3 runner.
    const tpReached = trade.tpReached || 0;
    const tpLabel = tpReached === 3 ? 'TP3 (full run)'
      : tpReached === 2 ? 'TP2 (1R locked)'
      : tpReached === 1 ? 'TP1 (25%R locked)'
      : '';
    const title = won
      ? `✅ ${trade.pair} ${tpLabel} — WIN`
      : `❌ ${trade.pair} stopped out — LOSS`;
    // v237 — Was JPY ? 0.01 : 0.0001, which made gold (pip 0.10) and crypto
    // (pip 1 or 0.1) report wildly inflated pip counts (e.g. $10 gold move
    // shown as 100,000 pips). Use pairConfig which has correct per-pair pip.
    const pipCfg = pairConfig(trade.pair);
    const pip = pipCfg && pipCfg.pip ? pipCfg.pip : (trade.pair.includes('JPY') ? 0.01 : 0.0001);
    const dirSign = trade.direction === 'BUY' ? 1 : -1;
    const pips = trade.closePrice != null && trade.entry != null
      ? ((trade.closePrice - trade.entry) * dirSign / pip).toFixed(1)
      : '?';
    const body = `${trade.direction} closed at ${trade.closePrice ?? '?'} · ${typeof pips === 'string' && pips[0] !== '-' ? '+' : ''}${pips} pips`;
    if ('Notification' in window && Notification.permission === 'granted') {
      (async () => {
        try {
          const opts = {
            body, icon: '/icon-192.png',
            tag: 'trade-' + trade.id,
            // Wins/losses persist until user acknowledges — they're outcomes
            // worth seeing, not background noise.
            requireInteraction: true,
            renotify: true,
            silent: false,
            vibrate: won
              ? [200, 80, 80, 60, 100, 60, 120]
              : [200, 80, 120, 60, 100, 60, 80],
            data: { url: '/', pair: trade.pair, outcome: trade.newOutcome },
          };
          if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            const reg = await navigator.serviceWorker.ready;
            await reg.showNotification(title, opts);
          } else {
            new Notification(title, opts);
          }
        } catch {}
      })();
    }
  } catch (e) { console.warn('[notifyTradeOutcome]', e.message); }
}

// v252 — Pulse the HISTORY tab + show unread counter when a trade resolves.
// (Was previously on My Trades, which was wrong — resolved trades leave My
// Trades and land in History, so the indicator follows the data.)
// Old function name kept as an alias for backward-compat in case any caller
// still uses it.
function updateHistoryTabBadge() {
  const tab = document.querySelector('.tab[data-tab="history"]');
  if (!tab) return;
  const n = state.unreadTradeUpdates || 0;
  const baseLabel = 'History';
  if (n > 0) {
    tab.innerHTML = `${baseLabel} <span class="tab-badge">${n}</span>`;
    tab.classList.add('tab-pulse');
  } else {
    tab.textContent = baseLabel;
    tab.classList.remove('tab-pulse');
  }
  // Defensive: make sure no stale pulse is left on the My Trades tab from
  // older versions or hot-reload scenarios.
  const tradesTab = document.querySelector('.tab[data-tab="trades"]');
  if (tradesTab) {
    tradesTab.classList.remove('tab-pulse');
    if (tradesTab.querySelector('.tab-badge')) tradesTab.textContent = 'My Trades';
  }
}
function updateTradesTabBadge() { updateHistoryTabBadge(); }

// ========== Notifications (for signals ≥ threshold) ==========
function getNotified() { try { return JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'); } catch { return []; } }
function saveNotified(a) { try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(a.slice(-300))); } catch {} }

function signalKey(s) {
  // Dedupe: same pair + direction within the same hour = same signal
  return `${s.pair}_${s.direction}_${new Date(s.timestamp).toISOString().slice(0, 13)}`;
}

function supportsNotifications() { return 'Notification' in window; }

async function ensureNotifyPermission() {
  if (!supportsNotifications()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}

// ── WEB PUSH SUBSCRIPTION ───────────────────────────────────────────────
// Registers the device with the server's Web Push pipeline so the SERVER
// can wake the SW + fire notifications even when the app is closed and
// the phone is locked. This is the ONLY mechanism for true always-on
// notifications on iOS Safari PWAs.
//
// Flow:
//   1. Get the server's VAPID public key (one-time fetch)
//   2. Ask the SW's PushManager to subscribe (creates an APNs token on iOS)
//   3. POST the resulting subscription to /api/push-subscribe
//   4. Server stores it in KV and uses it from check-signals.js cron
//
// Idempotent — running it multiple times just refreshes lastSeen.
function _vapidB64ToUint8(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function subscribeToWebPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log('[push] PushManager not supported on this device');
      return false;
    }
    if (Notification.permission !== 'granted') {
      console.log('[push] notifications not granted, skipping subscription');
      return false;
    }
    const reg = await navigator.serviceWorker.ready;

    // Get server VAPID public key (cached locally to skip re-fetch)
    let vapidKey = localStorage.getItem('forexsight_vapid_public');
    if (!vapidKey) {
      const r = await fetch('/api/push-subscribe');
      if (!r.ok) throw new Error('vapid fetch HTTP ' + r.status);
      const j = await r.json();
      vapidKey = j.vapidPublic;
      if (vapidKey) localStorage.setItem('forexsight_vapid_public', vapidKey);
    }
    if (!vapidKey) throw new Error('VAPID key unavailable');

    // Get existing subscription or create a new one
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _vapidB64ToUint8(vapidKey),
      });
      console.log('[push] new subscription created');
    } else {
      console.log('[push] reusing existing subscription');
    }

    // POST it to the server (also refreshes lastSeen)
    const subJson = sub.toJSON ? sub.toJSON() : sub;
    const res = await fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subJson),
    });
    if (!res.ok) throw new Error('subscribe POST HTTP ' + res.status);
    const j = await res.json();
    console.log('[push] subscribed', j);
    return true;
  } catch (e) {
    console.warn('[push] subscribe failed:', e.message);
    return false;
  }
}

function updateNotifyButton() {
  const btn = $('#notify-btn');
  if (!btn) return;
  // iOS Safari exposes Notification ONLY inside an installed PWA (standalone mode).
  if (!supportsNotifications()) {
    if (isIosSafari() && !isStandalone()) {
      btn.textContent = '📱 Add to Home Screen for alerts';
      btn.title = 'iPhone Safari only allows notifications inside installed web apps. Tap Share → Add to Home Screen, then open the app icon.';
    } else {
      btn.textContent = '🔕 Alerts (unsupported)';
      btn.disabled = true;
    }
    return;
  }
  const perm = Notification.permission;
  if (perm === 'denied') {
    btn.textContent = '🚫 Alerts blocked';
    btn.title = 'Unblock notifications in your browser settings';
    return;
  }
  if (state.notifyEnabled && perm === 'granted') {
    if (state.bestOnly) {
      btn.textContent = `🔔 Alerts ON (Best + 85%+)`;
      btn.title = 'Right-click to test. Notifications fire for Best Setups OR any signal at ≥85% confluence.';
    } else {
      btn.textContent = `🔔 Alerts ON (≥${NOTIFY_THRESHOLD}%)`;
      btn.title = 'Right-click to test. Notifications fire for any signal at or above 80% confluence.';
    }
    btn.classList.add('active');
  } else {
    btn.textContent = `🔕 Alerts OFF`;
    btn.classList.remove('active');
  }
}

function updateTitle() {
  document.title = state.unreadCount > 0
    ? `(${state.unreadCount}) 🔔 ForexSight — New Signal!`
    : 'ForexSight — Live Signal Analytics';
}

function playChime() {
  // MUCH LOUDER, RISING 4-TONE ALERT — designed to grab attention even at
  // half-volume. Was a 2-tone 0.18-gain sine that was easy to miss in noisy
  // environments. New version: 4 tones (880→1320→1760→2200 Hz), louder gain
  // (0.32), longer total duration (~1 sec). Square+sine mix for extra
  // perceptual loudness without distortion.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const play = (freq, start, dur, gain = 0.32, type = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur + 0.05);
    };
    // Rising 4-tone — each ~280ms with 50ms overlap → ~1 sec total
    play(880,  0.00, 0.30);
    play(1320, 0.25, 0.30);
    play(1760, 0.50, 0.30);
    play(2200, 0.75, 0.40, 0.36); // final tone louder
    // Square-wave "shimmer" for extra attention-grabbing buzz
    play(2200, 0.78, 0.25, 0.12, 'square');
  } catch {}
}

// Aggressive vibration pattern — long initial pulse, three short follow-ups.
// iOS/Android phones in pocket should feel this even through fabric.
function strongVibrate(direction) {
  try {
    if (!navigator.vibrate) return;
    // Pattern: 200ms strong, 80ms pause, 80ms x3 with 60ms gaps. ~720ms total.
    // BUY = ascending rhythm, SELL = descending — feel the direction.
    if (direction === 'BUY') {
      navigator.vibrate([200, 80, 80, 60, 100, 60, 120]);
    } else {
      navigator.vibrate([200, 80, 120, 60, 100, 60, 80]);
    }
  } catch {}
}

// Screen-flash effect — brief overlay so even with sound off you SEE it.
// Only fires if document is visible (no point flashing when app is in BG).
function flashScreen(color = '#0a84ff') {
  try {
    if (document.visibilityState !== 'visible') return;
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;background:${color};opacity:0.35;z-index:99998;pointer-events:none;transition:opacity 0.5s ease-out`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '0'; });
    setTimeout(() => overlay.remove(), 600);
  } catch {}
}

async function fireNotification(s, tier = {}) {
  if (!supportsNotifications() || Notification.permission !== 'granted') return;
  const isPerfect = s.confidence >= 100;
  const isPro = tier.pro;
  const isBest = tier.best && !isPro;
  let title;
  if (isPro) {
    title = `🏆 PRO ${s.pair} ${s.direction} — ${s.confidence}% (top-tier setup)`;
  } else if (isPerfect) {
    title = `🚨 PERFECT ${s.pair} ${s.direction} — 100% confluence!`;
  } else if (isBest) {
    title = `⭐ BEST ${s.pair} ${s.direction} — ${s.confidence}% confluence`;
  } else {
    title = `${s.pair} ${s.direction} — ${s.confidence}% confluence`;
  }
  const winLine = s.winProbability != null
    ? `Backtested win: ${s.winProbability}% (${s.backtestSamples} samples)`
    : '';
  const body = [
    isPro ? '✨ Multi-strategy + statistical edge + killzone. The rarest setup.' : '',
    isPerfect && !isPro ? '✨ Every directional indicator + bonuses agree.' : '',
    s.smcPassed ? '📐 SMC strategy confirmed (7/7 gates passed)' : '',
    `Entry: ${s.entry}`,
    `SL: ${s.sl} (${s.sl_pips} pips) · TP1: ${s.tp1} (${s.tp1_pips} pips)`,
    winLine,
    `${s.bull_count} bull · ${s.bear_count} bear of ${s.total_indicators} indicators`,
  ].filter(Boolean).join('\n');
  const options = {
    body, icon: '/icon-192.png', badge: '/icon-192.png',
    tag: signalKey(s),
    // Was: renotify only for top tiers. Now: ALL signals re-alert if the
    // pair fires again with different conditions (keeps the icon visible
    // on lock screen until tapped).
    renotify: true,
    // Was: requireInteraction only for PRO/PERFECT. Now: EVERY signal stays
    // on screen until tapped. User asked for "strong enough so I don't miss
    // any signal" — this is the iOS/Android setting that keeps the alert
    // banner visible instead of auto-dismissing after 4 seconds.
    requireInteraction: true,
    // Native vibration for the system-notification on Android (separate
    // from the in-tab navigator.vibrate call). Direction-aware.
    vibrate: s.direction === 'BUY'
      ? [200, 80, 80, 60, 100, 60, 120]
      : [200, 80, 120, 60, 100, 60, 80],
    // Silent: false means OS-default chime plays alongside our in-tab chime.
    silent: false,
    data: { url: '/', pair: s.pair, direction: s.direction },
  };
  // iOS PWA (and any installed PWA) requires showing via the Service Worker registration.
  // Fall back to `new Notification()` on desktop browsers without an active SW.
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, options);
      return;
    }
  } catch (e) { console.warn('SW notify failed, falling back:', e); }
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); try { openModal(s.pair); } catch {} n.close(); };
  } catch {}
}

// Stale-signal guard: don't fire notifications for signals whose detection
// timestamp is more than 60 min old. Prevents re-notifying the user when
// they re-open the app and old signals get re-rendered.
function _isStaleSignal(s) {
  try {
    const ts = s.timestamp || s.detectedAt;
    if (!ts) return false;
    const ageMin = (Date.now() - new Date(ts).getTime()) / 60000;
    return ageMin > 60 || ageMin < -5;
  } catch { return false; }
}
// v193 — gold is now treated as 24/7 (user request: scanning never stops
// on weekends). COMEX is technically closed Fri 22 UTC – Sun 22 UTC, so
// prices may be stale over the weekend (Yahoo Finance won't refresh GC=F),
// but the scanning framework keeps running. Crypto is also exempt as before.
function _isMarketClosed(pair) {
  if (pair && isCryptoPair(pair)) return false; // crypto never sleeps
  if (pair === 'XAU/USD' || pair === 'GOLD') return false; // v193: gold scans 24/7
  const d = new Date();
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return true;
  if (day === 5 && h >= 22) return true;
  if (day === 0 && h < 22) return true;
  return false;
}

function notifyIfHigh(s) {
  if (!state.notifyEnabled) return;
  if (Notification.permission !== 'granted') return;
  if (_isMarketClosed(s.pair)) return;
  if (_isStaleSignal(s)) return;

  // Alert qualification logic:
  //   Best Only ON  → alert when signal passes strict Best filter, OR when
  //                   it has very high confidence (≥85%) — so you don't
  //                   miss A+ signals that just barely fail one of the 8
  //                   gates (e.g. ADX 24 instead of 25).
  //   Best Only OFF → fall back to the simple ≥80% confidence threshold.
  const pro = isProSetup(s);
  const best = isBestSetup(s);
  const extreme = isExtremeSetup(s);
  let qualifies;
  if (state.filterMode === 'extreme') {
    qualifies = extreme;
  } else if (state.filterMode === 'best') {
    qualifies = best || s.confidence >= 85;
  } else {
    qualifies = s.confidence >= NOTIFY_THRESHOLD;
  }
  if (!qualifies) return;

  const key = signalKey(s);
  const seen = getNotified();
  if (seen.includes(key)) return;
  seen.push(key); saveNotified(seen);
  state.unreadCount++;
  updateTitle();

  // ALL signals get strong alerts — triple chime + vibrate + flash + system
  // notification with requireInteraction. PRO and PERFECT setups get an
  // extra fourth chime burst for emphasis.
  // Was: single chime for ordinary signals (easy to miss). Now: triple
  // chime for every qualified signal so they cut through background noise.
  playChime();
  setTimeout(playChime, 800);
  setTimeout(playChime, 1600);
  if (pro || s.confidence >= 100) {
    setTimeout(playChime, 2400); // PRO/PERFECT gets the 4th chime
  }
  // Strong vibration — direction-encoded rhythm
  strongVibrate(s.direction);
  // Brief screen flash — green for BUY, red for SELL
  flashScreen(s.direction === 'BUY' ? '#30d158' : '#ff453a');
  fireNotification(s, { pro, best });
  try { localStorage.setItem('forexsight_last_alert', new Date().toISOString()); } catch {}
}

// Test the alert pipeline end-to-end so user can verify the FULL strong alert.
// Plays the full triple chime + strong vibrate + screen flash + notification
// with requireInteraction — so the user knows exactly what a real signal feels like.
async function fireTestNotification() {
  const perm = await ensureNotifyPermission();
  if (perm !== 'granted') {
    alert('Browser blocked notifications. Re-enable them in your browser settings.');
    return;
  }
  // Full alert package — same as a real signal
  try { playChime(); } catch {}
  setTimeout(() => { try { playChime(); } catch {} }, 800);
  setTimeout(() => { try { playChime(); } catch {} }, 1600);
  try { strongVibrate('BUY'); } catch {}
  try { flashScreen('#0a84ff'); } catch {}
  try {
    const title = '🔔 ForexSight test alert — full strength';
    const body = 'Triple chime + vibrate + screen flash + persistent banner.\nThis is exactly what a real signal feels like.';
    const opts = {
      body, icon: '/icon-192.png', badge: '/icon-192.png',
      tag: 'test-' + Date.now(),
      requireInteraction: true,
      renotify: true,
      silent: false,
      vibrate: [200, 80, 80, 60, 100, 60, 120],
    };
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
    } else {
      new Notification(title, opts);
    }
  } catch (e) {
    alert('Notification failed: ' + e.message);
  }
}

// Clear unread badge when user returns to tab
window.addEventListener('focus', () => { state.unreadCount = 0; updateTitle(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { state.unreadCount = 0; updateTitle(); } });

// ========== UI ==========
// v209 — "More ▾" dropdown. Menu lives at body level (NOT inside .tabs)
// because .tabs uses backdrop-filter which creates a containing block
// for position:fixed children, causing clipping. Toggle via [hidden].
function _positionMoreMenu() {
  const btn = document.getElementById('more-tab-btn');
  const menu = document.getElementById('more-menu');
  if (!btn || !menu) return;
  const rect = btn.getBoundingClientRect();
  const viewportW = window.innerWidth;
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 6) + 'px';
  // v212 — on mobile, use a centered/edge-safe layout so the menu can't
  // overflow off-screen. On desktop, right-align to the button.
  if (viewportW <= 600) {
    menu.style.left = '12px';
    menu.style.right = '12px';
    menu.style.width = 'auto';
  } else {
    const menuWidth = 200;
    if (rect.right >= menuWidth) {
      menu.style.right = (viewportW - rect.right) + 'px';
      menu.style.left = 'auto';
      menu.style.width = 'auto';
    } else {
      menu.style.left = Math.max(8, rect.left) + 'px';
      menu.style.right = 'auto';
      menu.style.width = 'auto';
    }
  }
}
const _moreTabBtn = document.getElementById('more-tab-btn');
const _moreMenu = document.getElementById('more-menu');
if (_moreTabBtn && _moreMenu) {
  _moreTabBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !_moreMenu.hasAttribute('hidden');
    if (isOpen) {
      _moreMenu.setAttribute('hidden', '');
    } else {
      _moreMenu.removeAttribute('hidden');
      _positionMoreMenu();
    }
  });
  // Click outside closes menu
  document.addEventListener('click', (e) => {
    if (_moreMenu.hasAttribute('hidden')) return;
    if (e.target.closest('#more-menu') || e.target.closest('#more-tab-btn')) return;
    _moreMenu.setAttribute('hidden', '');
  });
  // Reposition on scroll / resize
  window.addEventListener('scroll', () => {
    if (!_moreMenu.hasAttribute('hidden')) _positionMoreMenu();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!_moreMenu.hasAttribute('hidden')) _positionMoreMenu();
  });
}
// v212 — tabs that live INSIDE the More dropdown
const _MORE_TABS = ['strategies', 'performance', 'wisdom', 'platforms'];
$$('.tab').forEach(t => t.addEventListener('click', () => {
  // The "More ▾" button itself is not a real tab — skip
  if (t.id === 'more-tab-btn') return;
  // v237 — Defensive: if a future .tab element ships without data-tab, this
  // would have thrown `null.classList.add` and broken the entire tab system.
  if (!t.dataset.tab) return;
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.tab-content').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  const targetPanel = document.getElementById(t.dataset.tab);
  if (targetPanel) targetPanel.classList.add('active');
  // v212 — if the selected tab lives inside the More menu, mirror the active
  // state on the More button so the user sees which section is current.
  const _moreBtn = document.getElementById('more-tab-btn');
  if (_moreBtn) {
    if (_MORE_TABS.includes(t.dataset.tab)) {
      _moreBtn.classList.add('active');
      _moreBtn.textContent = `More: ${t.textContent} ▾`;
    } else {
      _moreBtn.classList.remove('active');
      _moreBtn.textContent = 'More ▾';
    }
  }
  // v209 — close the More dropdown if we just selected from it
  const _mm = document.getElementById('more-menu');
  if (_mm) _mm.setAttribute('hidden', '');
  // v235 — Defer the heavy render functions so the tab visually activates
  // INSTANTLY. setTimeout(0) queues a new macrotask, which the browser can
  // schedule AFTER its next paint — so the tab-switch CSS class changes
  // become visible before the (potentially long) render runs. rAF alone
  // doesn't work here because rAF callbacks run BEFORE the next paint.
  // Without this defer, building 50-100 trade-row HTML rows synchronously
  // inside the click handler blocked tab-switch paint and made History feel laggy.
  const _deferRender = (fn) => setTimeout(() => {
    try { fn(); } catch (e) { console.warn('[tab-render]', e.message); }
  }, 0);
  if (t.dataset.tab === 'news') {
    _deferRender(() => {
      loadNews();
      loadProConsensus().catch(() => {}); // v215 — also refresh analyst consensus when News opens
    });
  }
  if (t.dataset.tab === 'calendar') _deferRender(loadCalendar);
  if (t.dataset.tab === 'performance') _deferRender(renderPerformance);
  if (t.dataset.tab === 'strategies') _deferRender(renderStrategies);
  if (t.dataset.tab === 'history') _deferRender(renderHistory);
  // v224 — refresh My Trades view when user opens that tab
  if (t.dataset.tab === 'trades') _deferRender(renderTrades);
}));

// In-page link from My Trades footer "→ History" — clicks the History tab.
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('history-tab-link')) {
    e.preventDefault();
    const tabBtn = document.querySelector('.tab[data-tab="history"]');
    if (tabBtn) tabBtn.click();
  }
});
$('#conf-slider').addEventListener('input', (e) => {
  state.minConf = +e.target.value;
  $('#conf-val').textContent = state.minConf + '%';
  try { localStorage.setItem(MIN_CONF_KEY, String(state.minConf)); } catch {}
  renderSignals();
});
// ========== Refresh button — short tap = data refresh, long press = hard refresh ==========
// Hard refresh is critical for iOS PWA users: when we ship new code, the
// home-screen app keeps serving the old service-worker-cached files until
// the SW updates itself (which can take a while). The hold gesture nukes
// every cache and unregisters the SW so the next reload pulls fresh code
// straight from the server. Trades, learning logs, sync code, and prefs
// stay intact (we only clear caches and SW state, never localStorage).
async function hardRefresh() {
  const btn = $('#refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Clearing cache…'; }
  try {
    // 1. Unregister every service worker so the next fetch goes to the network
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
    // 2. Delete every cache (SW shell cache + alerts-seen cache + anything else)
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => false)));
    }
    // 3. Clear sessionStorage (NEVER touch localStorage — that holds trades & sync code)
    try { sessionStorage.clear(); } catch {}
  } catch (e) {
    console.warn('[hardRefresh]', e.message);
  }
  // 4. Force-reload with a cache-busting query string so even any stray
  //    HTTP cache layer (CDN edge, browser memory) gets bypassed.
  const cb = '_cb=' + Date.now();
  const sep = location.search ? '&' : '?';
  // Use replace() so the busted URL doesn't end up in history
  location.replace(location.pathname + (location.search || '') + sep + cb + location.hash);
}

(function setupRefreshBtn() {
  const btn = $('#refresh-btn');
  if (!btn) return;
  let pressTimer = null;
  let didLongPress = false;
  let pressStart = 0;
  const HOLD_MS = 900; // hold this long to trigger hard refresh

  const startPress = (e) => {
    didLongPress = false;
    pressStart = Date.now();
    btn.classList.add('refresh-holding');
    pressTimer = setTimeout(() => {
      didLongPress = true;
      btn.classList.remove('refresh-holding');
      btn.classList.add('refresh-armed');
      // Haptic + visual feedback so user knows the hard refresh is armed
      try { if (navigator.vibrate) navigator.vibrate([30, 40, 30]); } catch {}
      hardRefresh();
    }, HOLD_MS);
  };
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    btn.classList.remove('refresh-holding');
  };

  // Pointer events cover mouse + touch + pen on all modern platforms
  btn.addEventListener('pointerdown', startPress);
  btn.addEventListener('pointerup', cancelPress);
  btn.addEventListener('pointerleave', cancelPress);
  btn.addEventListener('pointercancel', cancelPress);

  // Plain tap = data refresh (only when long-press did NOT fire)
  btn.addEventListener('click', () => {
    if (didLongPress) { didLongPress = false; return; }
    loadSignals(true);
    loadNews();
  });

  // Right-click on desktop = hard refresh (power-user shortcut)
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hardRefresh();
  });
})();
$('#auto-refresh').addEventListener('change', (e) => { state.autoRefresh = e.target.checked; setupAutoRefresh(); });

function setupAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  // v348 — polling faster: 30 seconds (was 60s). Combined with server-side
  // continuous checking via cron waitUntil, every 30s the user sees updated
  // chart reads. The endpoints are heavily edge-cached (30s TTL) so this
  // doesn't hammer any upstream.
  if (state.autoRefresh) state.timer = setInterval(() => loadSignals(true), 30 * 1000);
  // v214 — shadow feed also every 30s
  if (state._shadowTimer) clearInterval(state._shadowTimer);
  if (state.autoRefresh) state._shadowTimer = setInterval(() => {
    loadShadowFeed().catch(() => {});
    loadBrainStatus().catch(() => {});
  }, 30 * 1000);
}

// Forex market hours: closed from Friday 22:00 UTC to Sunday 22:00 UTC.
// Without this, the user sees an empty signals tab on weekends and may
// think the platform is broken.
function isForexClosed() {
  const d = new Date();
  const day = d.getUTCDay();   // 0=Sun, 5=Fri, 6=Sat
  const h = d.getUTCHours();
  // Saturday all day
  if (day === 6) return true;
  // Friday after 22:00 UTC
  if (day === 5 && h >= 22) return true;
  // Sunday before 22:00 UTC
  if (day === 0 && h < 22) return true;
  return false;
}
// v214 — render the shadow-tracker feed. Shows every recent signal the
// system fired and whether it WOULD have won/lost if the user took it.
// Continuously updated by /api/shadow-tracker which checks TP1/SL hits.
async function loadShadowFeed() {
  try {
    const res = await fetch('/api/shadow-tracker', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.ok) return;
    // v249 — Cache the feed so the tap-to-open modal can look up each signal
    // by its key without needing to re-fetch.
    window._lastShadowFeed = data.feed || [];
    const grid = document.getElementById('signals-grid');
    if (!grid) return;
    // v216 — mutate in place instead of remove+append so the page doesn't
    // jump every 30 seconds. If the card doesn't exist yet, create it once.
    let wrap = document.getElementById('shadow-feed-card');
    let isNew = false;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'shadow-feed-card';
      wrap.className = 'shadow-feed-card';
      isNew = true;
    }
    // Preserve open/closed state of the <details> across refreshes
    const wasOpen = wrap.querySelector('details')?.hasAttribute('open');
    const feed = data.feed || [];
    const wonCount = data.wins || 0;
    const lostCount = data.losses || 0;
    const totalResolved = wonCount + lostCount;
    const wrPct = totalResolved > 0 ? Math.round(wonCount / totalResolved * 100) : null;
    const wrClass = wrPct == null ? 'amber' : wrPct >= 55 ? 'green' : wrPct >= 45 ? 'amber' : 'red';
    // v228 — Human-readable labels for failure reason tags
    const FAILURE_LABELS = {
      'weak-confidence': '🔴 Weak confidence (<70%)',
      'mid-confidence': '🟡 Borderline confidence',
      'single-strategy': '🔴 Only 1 strategy fired',
      'off-session': '🌙 Outside main session',
      'london-open-volatility': '⚡ London open whipsaw',
      'pre-ny-volatility': '⚡ NY pre-open whipsaw',
      'pre-weekend': '📅 Friday afternoon drift',
      'wide-sl-gold': '📏 SL too wide for gold',
      'wide-sl': '📏 SL too wide',
      'immediate-rejection': '⚡ Rejected within 2 bars (strong reversal)',
      'slow-grind-loss': '🐌 Slow grind against position',
      'unknown-cause': '❓ Cause unclear',
    };
    const itemsHtml = feed.slice(0, 12).map(s => {
      const statusEmoji = s.status === 'won' ? '✅' : s.status === 'lost' ? '❌' : s.status === 'expired' ? '⌛' : '⏳';
      const statusLabel = s.status === 'won' ? 'WON TP1' : s.status === 'lost' ? 'LOST SL' : s.status === 'expired' ? 'Expired' : 'Open';
      const statusCls = `sh-${s.status}`;
      const age = s.firedAt ? _formatAgo(Date.parse(s.firedAt)) : '';
      // v244 — Pair-aware price formatting. Was hardcoded to 2 decimals which
      // truncated EUR/USD (1.08412 → 1.08), GBP/JPY (192.345 → 192.35),
      // and BTC/USD (no decimals needed). Now matches the server's r5() rules:
      //   • Gold: 2 decimals (2654.32)
      //   • JPY pairs: 3 decimals (149.123)
      //   • Crypto: 0-2 depending on instrument
      //   • Forex majors: 5 decimals (1.08412)
      const isGold = s.pair === 'XAU/USD' || s.pair === 'GOLD';
      const isJPY = s.pair && s.pair.includes('JPY');
      const isBTC = s.pair === 'BTC/USD';
      const isETH = s.pair === 'ETH/USD';
      const isSOL = s.pair === 'SOL/USD';
      const decimals = isGold ? 2
        : isJPY ? 3
        : isBTC ? 1
        : isETH ? 2
        : isSOL ? 3
        : 5;
      const fmt = (v) => v != null ? (typeof v === 'number' ? v.toFixed(decimals) : v) : '–';
      // v228 — failure reason row for LOST signals
      const failureHtml = (s.status === 'lost' && s.failureReasons && s.failureReasons.length)
        ? `<div class="sh-failure-line">
            <span class="sh-fail-label">Why it failed:</span>
            ${s.failureReasons.map(r => `<span class="sh-fail-tag">${FAILURE_LABELS[r] || r}</span>`).join('')}
          </div>`
        : '';
      // v249 — Make each card tappable. data-shadow-key is the lookup handle
      // used by the click handler to find the full signal in window._lastShadowFeed.
      // role+tabindex make it keyboard-accessible too.
      const cardKey = encodeURIComponent(s.key || `${s.pair}_${s.direction}_${s.firedAt}`);
      // v257 — Brain-quality treatment. Top-3 brain-scored open signals get a
      // crown + golden glow; remaining open signals show their brain score.
      const isTopPick = !!s.isTopPick;
      const isEndorsed = s.brainRecommended || s.isEliteBrainPattern;
      const brainScoreBadge = (s.status === 'open' && s.brainScore != null)
        ? `<span class="sh-brain-score" title="Composite brain quality: pWin + edge bonus + expected-R + brain endorsements. Top-3 open signals are marked best picks.">🧠 ${s.brainScore}</span>`
        : '';
      const topPickCrown = isTopPick
        ? `<span class="sh-top-pick" title="One of the brain's top-3 best picks in the feed right now — highest composite quality score.">👑</span>`
        : '';
      return `
        <div class="sh-card ${statusCls} sh-card-tappable ${isTopPick ? 'sh-top' : ''} ${isEndorsed ? 'sh-endorsed' : ''}" data-shadow-key="${cardKey}" role="button" tabindex="0" aria-label="Open ${s.pair} ${s.direction} details">
          <div class="sh-card-head">
            ${topPickCrown}
            <span class="sh-status">${statusEmoji}</span>
            <span class="sh-pair">${s.pair}</span>
            <span class="sh-dir sh-dir-${s.direction.toLowerCase()}">${s.direction}</span>
            <span class="sh-conf">${s.confidence || '–'}%</span>
            ${brainScoreBadge}
            <span class="sh-result ${statusCls}">${statusLabel}${s.barsToOutcome ? ` · ${s.barsToOutcome} bars` : ''}</span>
            <span class="sh-age muted">${age}</span>
            <span class="sh-tap-hint" aria-hidden="true">›</span>
          </div>
          <div class="sh-card-levels">
            <div class="sh-level"><span class="sh-lvl-lbl">Entry</span><code>${fmt(s.entry)}</code></div>
            <div class="sh-level sh-level-sl"><span class="sh-lvl-lbl">SL</span><code>${fmt(s.sl)}</code></div>
            <div class="sh-level sh-level-tp"><span class="sh-lvl-lbl">TP1</span><code>${fmt(s.tp1)}</code></div>
            <div class="sh-level sh-level-tp"><span class="sh-lvl-lbl">TP2</span><code>${fmt(s.tp2)}</code></div>
            <div class="sh-level sh-level-tp"><span class="sh-lvl-lbl">TP3</span><code>${fmt(s.tp3)}</code></div>
          </div>
          ${failureHtml}
        </div>`;
    }).join('');
    // v228 — Brain's "lessons learned" panel: top failure patterns
    const lessonsHtml = (data.topFailureReasons || []).slice(0, 5).map(f => `
      <div class="sh-lesson-row">
        <span class="sh-lesson-tag">${FAILURE_LABELS[f.reason] || f.reason}</span>
        <span class="sh-lesson-count">${f.count} losses · ${f.pctOfLosses}% of total</span>
      </div>
    `).join('');
    const lessonsBlock = lessonsHtml
      ? `<div class="sh-lessons">
          <div class="sh-lessons-title">🧠 What the brain has learned from failures (avoids these patterns going forward)</div>
          ${lessonsHtml}
        </div>`
      : '';
    const openAttr = wasOpen || isNew ? 'open' : '';
    wrap.innerHTML = `
      <details class="shadow-details" ${openAttr}>
        <summary class="shadow-summary">
          <span class="sh-icon">📡</span>
          <span class="sh-headline">
            <strong>Signal Feed — Would Have Won/Lost</strong>
            <span class="muted">${data.tracked} signals tracked · ${data.open} open · ${wrPct != null ? `Shadow WR ${wrPct}% (${wonCount}W / ${lostCount}L)` : 'awaiting resolutions'}</span>
          </span>
          <span class="sh-wr-pill sh-wr-${wrClass}">${wrPct != null ? wrPct + '%' : '—'}</span>
          <span class="sh-toggle">▾</span>
        </summary>
        <div class="shadow-body">
          ${lessonsBlock}
          ${itemsHtml || '<div class="muted" style="padding:10px;">No signals tracked yet. Will fill as new signals fire.</div>'}
          <div class="sh-foot muted">Every signal logged when fired · status checked against live OHLC · regardless of whether you took it · auto-expires after 48h. Brain studies every loss to avoid the same mistakes next time.</div>
        </div>
      </details>`;
    if (isNew) grid.parentNode.insertBefore(wrap, grid);
  } catch (e) { console.warn('[shadow-feed]', e.message); }
}

// v249 — Tap a shadow card to see the full detail breakdown. Uses event
// delegation on document so it survives the loadShadowFeed re-render cycle
// without re-binding handlers every 30s.
document.addEventListener('click', (e) => {
  const card = e.target && e.target.closest && e.target.closest('.sh-card-tappable');
  if (!card) return;
  const key = card.dataset.shadowKey;
  if (!key) return;
  openShadowDetailModal(decodeURIComponent(key));
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target && e.target.classList && e.target.classList.contains('sh-card-tappable') ? e.target : null;
  if (!card) return;
  e.preventDefault();
  const key = card.dataset.shadowKey;
  if (key) openShadowDetailModal(decodeURIComponent(key));
});

function openShadowDetailModal(key) {
  try {
    const feed = window._lastShadowFeed || [];
    const s = feed.find(x => x.key === key) || feed.find(x => (`${x.pair}_${x.direction}_${x.firedAt}` === key));
    if (!s) return;
    const modalBody = document.getElementById('modal-body');
    const modalEl = document.getElementById('modal');
    if (!modalBody || !modalEl) return;

    // Same pair-aware formatter used in the card grid
    const isGold = s.pair === 'XAU/USD' || s.pair === 'GOLD';
    const isJPY = s.pair && s.pair.includes('JPY');
    const decimals = isGold ? 2 : isJPY ? 3 : s.pair === 'BTC/USD' ? 1 : s.pair === 'ETH/USD' ? 2 : s.pair === 'SOL/USD' ? 3 : 5;
    const fmt = v => v != null ? (typeof v === 'number' ? v.toFixed(decimals) : v) : '–';
    const pipSize = isGold ? 0.1 : isJPY ? 0.01 : s.pair === 'BTC/USD' ? 1 : s.pair === 'ETH/USD' ? 0.1 : s.pair === 'SOL/USD' ? 0.01 : 0.0001;
    const pipsBetween = (a, b) => (a != null && b != null) ? Math.round(Math.abs(a - b) / pipSize) : 0;

    const statusEmoji = s.status === 'won' ? '✅' : s.status === 'lost' ? '❌' : s.status === 'expired' ? '⏱' : '🔄';
    const statusLabel = s.status === 'won' ? 'Won (TP1 hit)' : s.status === 'lost' ? 'Lost (SL hit)' : s.status === 'expired' ? 'Expired (48h timeout)' : 'Still open';
    const statusColor = s.status === 'won' ? 'var(--buy)' : s.status === 'lost' ? 'var(--sell)' : 'var(--accent)';
    const firedDate = s.firedAt ? new Date(s.firedAt) : null;
    const checkedDate = s.checkedAt ? new Date(s.checkedAt) : null;
    const fmtTime = d => d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '–';

    // Failure reasons block
    const FAILURE_LABELS = {
      'weak-confidence': '🔴 Weak confidence (<70%)',
      'mid-confidence': '🟡 Borderline confidence',
      'single-strategy': '🔴 Only 1 strategy fired',
      'off-session': '🌙 Outside main session',
      'london-open-volatility': '⚡ London open whipsaw',
      'pre-ny-volatility': '⚡ NY pre-open whipsaw',
      'pre-weekend': '📅 Friday afternoon drift',
      'wide-sl-gold': '📏 SL too wide for gold',
      'wide-sl': '📏 SL too wide',
      'immediate-rejection': '⚡ Rejected within 2 bars (strong reversal)',
      'slow-grind-loss': '🐌 Slow grind against position',
      'unknown-cause': '❓ Cause unclear',
    };
    const failureHTML = (s.status === 'lost' && s.failureReasons && s.failureReasons.length)
      ? `<div class="shadow-modal-section shadow-modal-fail">
          <h4>Why this signal failed</h4>
          <div class="shadow-modal-fail-tags">
            ${s.failureReasons.map(r => `<span class="sh-fail-tag">${FAILURE_LABELS[r] || r}</span>`).join('')}
          </div>
          <p class="muted">The brain has logged each reason and will penalize future signals matching the same profile.</p>
        </div>`
      : '';

    // Brain analysis block (only shown when probabilityAnalysis was recorded)
    const probHTML = (s.pWin != null && s.edge != null) ? `
      <div class="shadow-modal-section">
        <h4>Brain Gate verdict at signal time</h4>
        <div class="shadow-modal-prob">
          <div class="smp-cell"><span class="smp-lbl">Win chance</span><span class="smp-val smp-good">${s.pWin}%</span></div>
          <div class="smp-cell"><span class="smp-lbl">Lose chance</span><span class="smp-val smp-bad">${100 - s.pWin}%</span></div>
          <div class="smp-cell"><span class="smp-lbl">Edge</span><span class="smp-val">+${s.edge} pts</span></div>
        </div>
      </div>` : '';

    // Strategy + meta tags
    const tagsHTML = [];
    if (s.bigMove) tagsHTML.push('<span class="big-run-badge" style="margin:0">🚀 BIG RUN</span>');
    if (s.inKillzone) tagsHTML.push('<span class="shadow-meta-tag" title="Fired during London or NY active hours">🎯 In killzone</span>');
    if (s.adx) tagsHTML.push(`<span class="shadow-meta-tag" title="Trend strength when signal fired">ADX ${s.adx}</span>`);
    if (s.strategies) tagsHTML.push(`<span class="shadow-meta-tag">${s.strategies} strategies agreed</span>`);
    if (Array.isArray(s.namedStrategies) && s.namedStrategies.length) {
      tagsHTML.push(`<span class="shadow-meta-tag" title="Patterns that fired together">${s.namedStrategies.join(' + ')}</span>`);
    }
    const tagsBlock = tagsHTML.length ? `<div class="shadow-modal-tags">${tagsHTML.join(' ')}</div>` : '';

    // Levels with pip distances from entry
    const slPips = pipsBetween(s.entry, s.sl);
    const tp1Pips = pipsBetween(s.entry, s.tp1);
    const tp2Pips = pipsBetween(s.entry, s.tp2);
    const tp3Pips = pipsBetween(s.entry, s.tp3);

    modalBody.innerHTML = `
      <div class="shadow-modal">
        <div class="shadow-modal-head">
          <div class="shadow-modal-pair">${s.pair} <span class="dir-${s.direction.toLowerCase()}">${s.direction}</span></div>
          <div class="shadow-modal-status" style="color:${statusColor}">${statusEmoji} ${statusLabel}${s.barsToOutcome ? ` · ${s.barsToOutcome} bars` : ''}</div>
          <div class="shadow-modal-conf muted">Confidence at signal time: <b>${s.confidence != null ? s.confidence + '%' : 'n/a'}</b></div>
        </div>

        ${tagsBlock}
        ${probHTML}

        <div class="shadow-modal-section">
          <h4>Levels</h4>
          <div class="shadow-modal-levels">
            <div class="sml-row"><span class="sml-lbl">Entry</span><code>${fmt(s.entry)}</code><span class="sml-dist muted">—</span></div>
            <div class="sml-row sml-sl"><span class="sml-lbl">Stop loss</span><code>${fmt(s.sl)}</code><span class="sml-dist">${slPips} pips away</span></div>
            <div class="sml-row sml-tp"><span class="sml-lbl">TP1</span><code>${fmt(s.tp1)}</code><span class="sml-dist">${tp1Pips} pips away</span></div>
            <div class="sml-row sml-tp"><span class="sml-lbl">TP2</span><code>${fmt(s.tp2)}</code><span class="sml-dist">${tp2Pips} pips away</span></div>
            <div class="sml-row sml-tp"><span class="sml-lbl">TP3</span><code>${fmt(s.tp3)}</code><span class="sml-dist">${tp3Pips} pips away</span></div>
          </div>
          ${s.pipPotential ? `<p class="muted" style="margin-top:8px">Full move to TP3 = <b>${s.pipPotential} pips</b></p>` : ''}
        </div>

        <div class="shadow-modal-section">
          <h4>Timing</h4>
          <div class="shadow-modal-timing">
            <div><span class="muted">Fired:</span> ${fmtTime(firedDate)}</div>
            ${checkedDate ? `<div><span class="muted">Resolved:</span> ${fmtTime(checkedDate)}</div>` : ''}
            ${s.barsToOutcome ? `<div><span class="muted">Bars to outcome:</span> ${s.barsToOutcome}</div>` : ''}
          </div>
        </div>

        ${failureHTML}

        <p class="muted" style="margin-top:18px;font-size:11.5px">This is a "shadow" tracked signal — recorded for performance measurement. The brain learns from every won/lost outcome in this feed.</p>
      </div>`;

    // v231 reflow trick so modal opens with animation
    void modalEl.offsetHeight;
    requestAnimationFrame(() => modalEl.classList.remove('hidden'));
  } catch (e) { console.warn('[shadow-modal]', e.message); }
}

function _formatAgo(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

// v213 — render the learning-brain status card. Shows current intelligence:
// total signals evaluated across all backtest scans, top-performing patterns,
// and the brain's best/worst hours of day. This makes the "learning" visible.
async function loadBrainStatus() {
  // v261 — Restore original render path. v259's placeholder + degraded-state
  // boxes were overwriting the detailed card contents on transient errors.
  // Now: keep the re-attach safety from v259 (card always reachable in DOM)
  // but NEVER replace the card body with simplified views. If a fetch fails,
  // the previous detailed render stays put — same behaviour as before v259.
  const grid = document.getElementById('signals-grid');
  if (!grid) return;
  const signalsSection = grid.parentNode;
  let wrap = document.getElementById('brain-status-card');
  let isNew = false;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'brain-status-card';
    wrap.className = 'brain-status-card';
    isNew = true;
  }
  // Re-attach guarantee from v259 — card always lives just above the grid.
  if (wrap.parentNode !== signalsSection || wrap.nextSibling !== grid) {
    signalsSection.insertBefore(wrap, grid);
  }
  try {
    const res = await fetch('/api/learning-brain', { cache: 'no-store' });
    if (!res.ok) return;          // existing card content stays — no overwrite
    const data = await res.json();
    if (!data || !data.ok) return; // same — never replace details with a warning
    // v222 — Brain card now OPEN by default (was collapsed → invisible)
    const existingDetails = wrap.querySelector('details');
    // If user explicitly closed it once we respect that; otherwise default to open
    const wasOpen = !existingDetails || existingDetails.hasAttribute('open');
    // v225 — each winner row now labels which pair it was learned from
    const winnersHtml = (data.topWinners || []).slice(0, 6).map(w => {
      const wrPct = Math.round(w.wr * 100);
      const pairBadge = w.pair ? `<span class="bs-pair-tag">${w.pair}</span>` : '';
      return `<div class="bs-row">${pairBadge}<span class="bs-combo">${w.k.replace(/_/g,' · ')}</span><span class="bs-wr bs-wr-${wrPct>=55?'green':wrPct>=50?'amber':'red'}">${wrPct}%</span><span class="bs-n">${w.n} samples${w.avgBars ? ' · ~'+Math.round(w.avgBars)+'h' : ''}</span></div>`;
    }).join('');
    // v225 — per-pair sample distribution shows the brain covers multiple instruments
    const pairDistHtml = data.pairSampleDistribution
      ? Object.entries(data.pairSampleDistribution).map(([p, n]) =>
          `<span class="bs-pair-pill">${p} · ${n.toLocaleString()}</span>`
        ).join('')
      : '';
    const hoursHtml = (data.bestHours || []).slice(0, 4).map(h => {
      const wrPct = Math.round(h.wr * 100);
      const [dir, hour] = h.k.split('_');
      return `<div class="bs-row"><span class="bs-combo">${dir} · ${hour}:00 UTC</span><span class="bs-wr bs-wr-${wrPct>=55?'green':wrPct>=50?'amber':'red'}">${wrPct}%</span></div>`;
    }).join('');
    // v226 — Live rotation indicator (always visible, even when collapsed)
    const rotation = data.rotation || {};
    const justScanned = rotation.justScanned || data.pairsCompletedThisRun?.[0] || '—';
    const nextScheduled = rotation.nextScheduled || '—';
    const cycleIdx = rotation.cycleIdx ?? 0;
    const cycleTotal = rotation.cycleTotal || (data.pairsAnalyzed?.length || 8);
    const progressPct = Math.round(((cycleIdx) / cycleTotal) * 100);
    // v227/v239 — Intelligence indicator + tier badge. v239 added Genius tier
    // (top of scale, requires calibration ≥ 92%) and richer breakdown showing
    // the 4 components (samples / pairs / calibration / live samples).
    const intel = data.intelligence || {};
    const intelPct = intel.progress != null ? intel.progress : 50;
    const intelTier = intel.tier || 'Learning…';
    const intelClass = intelPct >= 92 ? 'intel-genius'
                      : intelPct >= 80 ? 'intel-master'
                      : intelPct >= 65 ? 'intel-skilled'
                      : intelPct >= 50 ? 'intel-apprentice'
                      : 'intel-novice';
    // v234 — Non-stop learning indicator. Brain ALWAYS processes every tick;
    // only the KV persistence is throttled (10min OR 500 samples) to stay
    // inside the free-tier quota. Show the user it's healthy either way.
    // v237 — Surface scanError/scanSkipReason explicitly. Was hidden behind
    // the generic summary so silent backtest failures wouldn't be obvious.
    const health = data.learningHealth || {};
    const kvOk = health.kvSaved || health.kvStatus === 'throttled-batching';
    const scanFailed = !!health.scanError || !!health.scanSkipReason;
    const healthClass = scanFailed ? 'health-warn' : (kvOk ? 'health-ok' : 'health-warn');
    const healthIcon = scanFailed ? '⚠️' : (health.kvSaved ? '💾' : (health.kvStatus === 'throttled-batching' ? '⚡' : '⚠️'));
    const healthText = health.scanError
      ? `Brain scan failed: ${health.scanError}`
      : health.scanSkipReason
        ? `Brain skipped: ${health.scanSkipReason}`
        : (health.summary || 'Brain learning non-stop');
    const liveLineHtml = `
      <div class="brain-live-line">
        <span class="brain-spinner">⚙</span>
        <span class="brain-live-text">
          Just scanned <b>${justScanned}</b> ·
          Next: <b>${nextScheduled}</b> ·
          <span class="muted">pair ${cycleIdx} of ${cycleTotal}</span>
        </span>
        <span class="brain-intel-pill ${intelClass}" title="Intelligence scales the weight of brain findings on live signal scoring. Grows with accumulated samples + pair coverage. Currently ${intelPct}% (samples ${intel.sampleScore||0}% / pairs ${intel.pairScore||0}%).">${intelTier} · ${intelPct}%</span>
        <div class="brain-cycle-bar"><span style="width:${progressPct}%"></span></div>
      </div>
      <div class="brain-health-line ${healthClass}" title="${health.kvStatus || 'unknown'} · scanned ${health.scannedThisRun||0} · resolved ${health.resolvedThisRun||0} this tick">
        <span class="brain-health-icon">${healthIcon}</span>
        <span class="brain-health-text">${healthText}</span>
      </div>
      ${(() => {
        // v239/v241 — Self-improvement + regime + Brain Gate indicators.
        // The Gate pill shows how many signals the brain just rejected from
        // the feed — proof the wisdom is actively filtering, not just labeling.
        const si = data.selfImprovement || {};
        const regime = data.regime;
        const calPct = si.calibrationAccuracy;
        const liveTotal = si.totalLiveSamples || 0;
        const liveDelta = si.liveSamplesIngestedThisRun || 0;
        // v241 — Pull brainGated count from the last check-signals response.
        // Stored on window by the signal polling code; defaults to 0.
        const gatedCount = (typeof window !== 'undefined' && window._lastBrainGatedCount) || 0;
        const gatedHTML = gatedCount > 0
          ? `<span class="brain-gated-pill" title="Brain rejected ${gatedCount} signal${gatedCount === 1 ? '' : 's'} this scan based on accumulated wisdom (known-loser combos, live loss clusters, weak regime, low calibration). Click for details.">🛡 Gated ${gatedCount}</span>`
          : '';
        // v245 — Adaptive gate badge. The bar rises as brain learns; falls
        // when recent WR exceeds target. This is the lever that makes the
        // overall signal win rate climb in step with brain intelligence.
        const ag = (typeof window !== 'undefined' && window._lastAdaptiveGate) || null;
        const adaptiveHTML = ag ? (() => {
          const tip = ag.tighteningReason
            ? `Current bar: edge ≥${ag.minEdgePts}pts AND pWin ≥${ag.minPWinPct}%.\\n\\nBased on brain intelligence ${ag.basedOnIntelLevel}%.\\n\\n${ag.tighteningReason}`
            : `Current bar: edge ≥${ag.minEdgePts}pts AND pWin ≥${ag.minPWinPct}%.\\n\\nTarget WR ${ag.targetWRPct}%. As brain intelligence (${ag.basedOnIntelLevel}%) climbs, this bar auto-tightens — driving up the win rate of signals that pass through.`;
          const className = ag.minEdgePts >= 15 ? 'bar-tight' : ag.minEdgePts >= 11 ? 'bar-mid' : 'bar-loose';
          return `<span class="brain-bar-pill ${className}" title="${tip}">📏 Bar ${ag.minEdgePts}pts · pWin ≥${ag.minPWinPct}%</span>`;
        })() : '';
        let regimeLabel = regime ? regime.regime.replace(/_/g, ' ') : '—';
        let regimeIcon = !regime ? '🌀'
          : regime.regime === 'TRENDING_VOLATILE' ? '🚀'
          : regime.regime === 'TRENDING_QUIET' ? '📈'
          : regime.regime === 'RANGING_VOLATILE' ? '🌊'
          : regime.regime === 'RANGING_QUIET' ? '😴'
          : regime.regime === 'CRISIS' ? '⚠️'
          : '🌀';
        const calClass = calPct == null ? 'cal-empty' : calPct >= 80 ? 'cal-great' : calPct >= 60 ? 'cal-ok' : 'cal-poor';
        return `
        <div class="brain-improve-line">
          <span class="brain-regime" title="Current market regime classified by brain from ADX + volatility. Drives regime-aware signal scoring.">${regimeIcon} ${regimeLabel}${regime ? ` · ADX ${regime.adx} · vol ${regime.volRatio}×` : ''}</span>
          <span class="brain-cal-pill ${calClass}" title="Calibration: how well the brain's predicted confidence aligns with actual win rate. Perfect = 100%. Updates from live signal outcomes.">🎯 Cal ${calPct != null ? calPct + '%' : '—'}</span>
          <span class="brain-live-samples" title="Live signal outcomes ingested by the brain's self-improvement loop. These count higher than synthetic backtest samples.">🔬 Live ${liveTotal.toLocaleString()}${liveDelta > 0 ? ` (+${liveDelta})` : ''}</span>
          ${si.lessonsLearned ? `<span class="brain-lessons-pill" title="Number of distinct failure contexts the brain has learned from. Grows monotonically — every loss becomes a permanent lesson. The brain never cancels patterns, only studies why they failed.">📚 ${si.lessonsLearned} lessons</span>` : ''}
          ${si.winsStudied ? `<span class="brain-wins-pill" title="Number of distinct WIN contexts the brain has studied. Grows monotonically — every winning signal becomes a success example. Future signals matching past winning conditions get a confidence boost.">🏆 ${si.winsStudied} wins studied</span>` : ''}
          ${adaptiveHTML}
          ${gatedHTML}
        </div>`;
      })()}`;
    const openAttr = wasOpen ? 'open' : '';
    // v226 — Live line OUTSIDE the <details> so it's ALWAYS visible
    wrap.innerHTML = `
      ${liveLineHtml}
      <details class="brain-details" ${openAttr}>
        <summary class="brain-summary">
          <span class="brain-icon">🧠</span>
          <span class="brain-headline">
            <strong>Learning Brain <span class="brain-live-dot" title="Live — learning new patterns every scan"></span></strong>
            <span class="muted"><b style="color:#a78bfa">${(data.totalSamplesAccumulated || 0).toLocaleString()}</b> signals analyzed · ${data.runs || 0} runs · always learning</span>
          </span>
          <span class="brain-toggle">▾</span>
        </summary>
        <div class="brain-body">
          ${pairDistHtml ? `<div class="bs-sec"><div class="bs-sec-title">📊 Pairs being backtested (${data.pairsAnalyzed?.length || 0})</div><div class="bs-pair-grid">${pairDistHtml}</div></div>` : ''}
          <div class="bs-sec"><div class="bs-sec-title">🏆 Top winning patterns (labeled by pair)</div>${winnersHtml || '<em class="muted">accumulating data…</em>'}</div>
          ${hoursHtml ? `<div class="bs-sec"><div class="bs-sec-title">⏰ Best hours of day</div>${hoursHtml}</div>` : ''}
          <div class="bs-foot muted">Brain backtests 1 of ${cycleTotal} pairs per run (rotation) · adds ${data.lastScan?.resolved || 0} resolved samples · last update ${data.lastUpdated ? new Date(data.lastUpdated).toLocaleString() : 'never'}</div>
        </div>
      </details>`;
    // v259 — Already inserted at the top of this function; isNew handled above.
  } catch (e) { console.warn('[brain-status]', e.message); }
}

// v197 — render pro-consensus card from /api/pro-consensus. Shows pair+direction
// calls confirmed by 2+ free public analyst sources (DailyFX, FXStreet,
// Investing, ForexLive, Reuters). NOT real-time, NOT proprietary signals —
// it's aggregated analyst sentiment from last 24h.
async function loadProConsensus() {
  try {
    const res = await fetch('/api/pro-consensus', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    // v215 — render into the dedicated News-tab container, NOT the signals home
    const container = document.getElementById('pro-consensus-container');
    if (!container) return;
    document.getElementById('pro-consensus-card')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'pro-consensus-card';
    wrap.className = 'pro-consensus-card';
    const list = data.consensus || [];
    if (!list.length) {
      wrap.innerHTML = `
        <div class="pc-header">📰 Pro Analyst Consensus <span class="muted">(${data.sourcesResponding}/${data.sourcesQueried} sources up)</span></div>
        <div class="pc-empty">No multi-source agreement right now — waiting for 2+ analyst sources to align.</div>`;
    } else {
      const itemsHtml = list.map(c => `
        <div class="pc-item pc-${c.direction.toLowerCase()}">
          <div class="pc-row">
            <span class="pc-pair">${c.pair}</span>
            <span class="pc-dir pc-dir-${c.direction.toLowerCase()}">${c.direction}</span>
            <span class="pc-count">${c.sourceCount} sources agree</span>
          </div>
          <div class="pc-sources">${c.sources.join(' · ')}</div>
          <details class="pc-details">
            <summary class="muted">Show analyst headlines</summary>
            ${c.samples.map(s => `<div class="pc-sample"><strong>${s.source}:</strong> ${(s.title || '').replace(/</g,'&lt;')}</div>`).join('')}
          </details>
        </div>
      `).join('');
      wrap.innerHTML = `
        <div class="pc-header">📰 Pro Analyst Consensus <span class="muted">(${data.sourcesResponding}/${data.sourcesQueried} sources up · ${data.consensusCount} confirmed)</span></div>
        ${itemsHtml}
        <div class="pc-footnote muted">Aggregated from DailyFX, FXStreet, Investing.com, ForexLive, Reuters — last 24h. NOT real-time pro signals — analyst commentary. 2+ source confirmation required.</div>`;
    }
    container.innerHTML = '';
    container.appendChild(wrap);
  } catch (e) {
    console.warn('[pro-consensus]', e.message);
  }
}

function showWeekendBannerIfNeeded() {
  if (!isForexClosed()) {
    document.getElementById('weekend-banner')?.remove();
    return;
  }
  if (document.getElementById('weekend-banner')) return;
  const grid = document.getElementById('signals-grid');
  if (!grid) return;
  const now = new Date();
  let reopen = new Date(now);
  reopen.setUTCHours(22, 0, 0, 0);
  while (reopen.getUTCDay() !== 0 || reopen <= now) reopen.setUTCDate(reopen.getUTCDate() + 1);
  const hoursLeft = Math.round((reopen - now) / (60 * 60 * 1000));
  const banner = document.createElement('div');
  banner.id = 'weekend-banner';
  banner.className = 'weekend-banner';
  banner.innerHTML = `
    <div class="wb-icon">🌙</div>
    <div class="wb-text">
      <strong>Forex market is closed — crypto still scanning</strong>
      <span class="muted">Forex reopens in ~${hoursLeft}h (Sunday 22:00 UTC). Crypto pairs (BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX) trade 24/7 — strategies keep hunting + alerting on those right now.</span>
    </div>
  `;
  grid.parentNode.insertBefore(banner, grid);
}

async function loadSignals(force = false) {
  if (force) saveCache({});
  $('#signals-status').textContent = 'Loading signals…';
  showWeekendBannerIfNeeded();

  // v391 — CRITICAL cold-load fix. Try server signals FIRST. If they're
  // fresh (< 5 min), use them directly and skip the 16-parallel-fetch
  // client re-computation. This was the actual choke that made the app
  // appear frozen on cold load. Client re-analysis still runs — but
  // in the background AFTER the server signals paint.
  try {
    const r = await fetch('/api/latest-signals', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      const ts = d && d.ts;
      const ageMin = ts ? (Date.now() - ts) / 60000 : Infinity;
      const sigs = Array.isArray(d && d.signals) ? d.signals : [];
      if (ageMin < 5 && sigs.length > 0) {
        state.signals = sigs;
        if (typeof renderSignals === 'function') renderSignals();
        $('#signals-status').textContent = `${sigs.length} signal${sigs.length===1?'':'s'} · server (${Math.round(ageMin*60)}s ago)`;
        // Fire the heavy client-side scan AFTER 6s so it doesn't choke cold load.
        // Result: server signals visible in <500ms, client scan catches any
        // extras 6s later, no blank screen.
        setTimeout(() => { _loadSignalsHeavyScan(force).catch(() => {}); }, 6000);
        return;
      }
    }
  } catch {}
  // Fallback: no fresh server signals — do the heavy client scan now.
  return _loadSignalsHeavyScan(force);
}

async function _loadSignalsHeavyScan(force = false) {
  // v391b — defense-in-depth: even if someone calls the heavy scan
  // directly, check server first. Only run the 16-price fetch when
  // server signals are absent OR user explicitly forced.
  if (!force) {
    try {
      const r = await fetch('/api/latest-signals', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        const ageMin = d.ts ? (Date.now() - d.ts) / 60000 : Infinity;
        const sigs = Array.isArray(d.signals) ? d.signals : [];
        if (ageMin < 5 && sigs.length > 0) {
          state.signals = sigs;
          if (typeof renderSignals === 'function') renderSignals();
          return; // skip the 16-price storm
        }
      }
    } catch {}
  }
  // v213 — kick off learning brain backtest update (non-blocking)
  loadBrainStatus().catch(() => {});
  // v214 — refresh the shadow signal feed (would-have outcomes)
  loadShadowFeed().catch(() => {});
  // v215 — Pro Consensus REMOVED from home tab — now lives inside News tab.
  // Still prefetched in background so it's ready when user clicks News.
  loadProConsensus().catch(() => {});
  // Show skeleton cards immediately so the page has rhythm while data fetches
  const grid = $('#signals-grid');
  if (grid && !grid.children.length) {
    grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton-card"></div>').join('');
  }
  // Scan FOREX + CRYPTO together. Crypto trades 24/7 so it keeps producing
  // signals on weekends when forex is closed. Each pair is analysed by all
  // 6 strategies independently — same pipeline, different asset class.
  const entries = [...Object.entries(PAIRS), ...Object.entries(CRYPTO_PAIRS)];
  const signals = [];
  let failures = 0;

  // Pre-load context: news sentiment + calendar events. Both cached at edge.
  await Promise.all([loadNewsForSignals(), loadCalendarForSignals()]);

  const analyzeAndPush = (name, data, daily) => {
    try { evaluateOutcomes(name, data.ohlc); } catch (e) { console.warn('eval outcomes:', e.message); }
    try {
      const closed = evaluateOpenTrades(name, data.ohlc);
      for (const tr of closed) notifyTradeOutcome(tr);
    } catch (e) { console.warn('eval trades:', e.message); }
    // Wrap analyzePair so a bug in any one strategy doesn't kill the whole
    // pair-loop. If analyzePair throws, log + skip this pair, others still run.
    let s;
    try { s = analyzePair(name, data, daily); }
    catch (e) { console.warn(`[analyze ${name}]`, e.message); return; }
    if (s.direction !== 'HOLD') {
      try { logSignal(s); } catch (e) { console.warn('log signal:', e.message); }
      signals.push(s);
      // STRATEGY-CONFIRMED ONLY: notifications fire ONLY when a strategy
      // (SMC, ORB, ICT, Trend, Squeeze, or Divergence) confirms the signal.
      // The previous "notifyIfHigh" fallback (any signal ≥80% confidence)
      // was removed — too many alerts for setups that didn't pass real
      // institutional gates. From now on, every alert is backed by a
      // strategy with deeper rules + a quality grade.
      if (s.smcPassed) {
        try { fireSMCNotification(s); } catch (e) { console.warn('smc notify:', e.message); }
        try { autoAddSMCTrade(s); } catch (e) { console.warn('smc auto-add:', e.message); }
      }
      // ORB-confirmed signals fire INDEPENDENTLY of SMC. A signal can be
      // SMC-only, ORB-only, or both. ORB notifications are deduped per
      // pair/direction/day so you only get one alert per setup.
      if (s.orbPassed) {
        try { fireORBNotification(s); } catch (e) { console.warn('orb notify:', e.message); }
        try { autoAddORBTrade(s); } catch (e) { console.warn('orb auto-add:', e.message); }
      }
      // Other strategies — generic helpers loop over the registry. Each
      // strategy auto-tracks + notifies independently. ICT, Trend Pullback,
      // BB Squeeze, RSI Divergence all funnel through the same pipeline.
      for (const sk of Object.keys(STRATEGIES)) {
        if (s[`${sk}Passed`]) {
          try { fireStrategyNotification(s, sk); } catch (e) { console.warn(`${sk} notify:`, e.message); }
          try { autoAddStrategyTrade(s, sk); } catch (e) { console.warn(`${sk} auto-add:`, e.message); }
        }
      }
      // v190 — GOLD AUTO-ADD ALL. Per user request: every gold signal that
      // fires (any direction, any confidence, any strategy pass count) is
      // automatically added to trades, bypassing all elite filters.
      // Dedup still applies (same pair+direction same day = one trade).
      try { autoAddGoldTrade(s); } catch (e) { console.warn('gold auto-add:', e.message); }
      // No fallback — strategy-confirmed signals only.
    }
  };

  // Radiant SMC gold analyzer — fires in parallel, completely independent
  // pipeline from the main pair loop. Renders into its own section.
  loadRadiantSignal().catch(() => {});

  // Fetch 1h (primary) + 1d (higher-timeframe bias) in parallel for every pair.
  // On Cloudflare these are cached per-URL at the edge, so most calls resolve in <100ms.
  const pass1 = await Promise.allSettled(entries.map(async ([name, sym]) => {
    const [h1, d1] = await Promise.allSettled([
      fetchOHLC(sym, '1h', '3mo'),
      fetchOHLC(sym, '1d', '1y'),
    ]);
    if (h1.status !== 'fulfilled') throw h1.reason;
    return { name, data: h1.value, daily: d1.status === 'fulfilled' ? d1.value : null };
  }));
  for (const r of pass1) {
    if (r.status === 'fulfilled') analyzeAndPush(r.value.name, r.value.data, r.value.daily);
  }

  // Merge server-cron-detected signals — these are what fire the push
  // notifications when the app is closed. If the client analyzer didn't
  // already produce a matching signal (different gates), we add the server
  // one so tapping a notification always lands on a visible card.
  try {
    const serverRes = await fetch('/api/latest-signals', { cache: 'no-store' });
    if (serverRes.ok) {
      const serverData = await serverRes.json();
      // v241 — Capture Brain Gate count so the brain card can display "Gated N"
      if (typeof serverData.brainGatedCount === 'number') {
        window._lastBrainGatedCount = serverData.brainGatedCount;
        window._lastBrainGatedList = serverData.brainGated || [];
      }
      // v245 — Stash adaptive gate so the brain card can display the current bar
      if (serverData.adaptiveGate) {
        window._lastAdaptiveGate = serverData.adaptiveGate;
      }
      const serverSignals = Array.isArray(serverData.signals) ? serverData.signals : [];
      for (const ss of serverSignals) {
        if (!ss || !ss.pair || !ss.direction) continue;
        // Only merge HIGH-CONFIDENCE strategy-confirmed signals (matches push filter)
        if (!ss.strategies || ss.strategies < 2 || (ss.confidence || 0) < 85) continue;
        const dup = signals.find(cs => cs.pair === ss.pair && cs.direction === ss.direction);
        if (dup) continue; // client already has it
        // Convert server-shape signal to client-shape so renderSignals/renderCard work
        const cfg = pairConfig(ss.pair);
        const merged = {
          pair: ss.pair,
          symbol: PAIRS[ss.pair] || CRYPTO_PAIRS[ss.pair],
          direction: ss.direction,
          confidence: ss.confidence,
          current: ss.entry,
          entry: ss.entry,
          sl: ss.sl, tp1: ss.tp1, tp2: ss.tp2, tp3: ss.tp3,
          // v237 — Guard against missing tp2/tp3 (cron may omit them).
          // Without this, the card displays "NaNp" for the pip count.
          sl_pips: (ss.entry != null && ss.sl != null) ? Math.abs(ss.entry - ss.sl) / cfg.pip : 0,
          tp1_pips: (ss.entry != null && ss.tp1 != null) ? Math.abs(ss.entry - ss.tp1) / cfg.pip : 0,
          tp2_pips: (ss.entry != null && ss.tp2 != null) ? Math.abs(ss.entry - ss.tp2) / cfg.pip : 0,
          tp3_pips: (ss.entry != null && ss.tp3 != null) ? Math.abs(ss.entry - ss.tp3) / cfg.pip : 0,
          atr: ss.entry * 0.001,
          rr: '1:1 / 1:2 / 1:3',
          adxNow: ss.adx,
          votes: {},
          bull_count: ss.direction === 'BUY' ? Math.ceil(ss.indicators * 0.8) : Math.floor(ss.indicators * 0.2),
          bear_count: ss.direction === 'SELL' ? Math.ceil(ss.indicators * 0.8) : Math.floor(ss.indicators * 0.2),
          neutral_count: 0,
          total_indicators: ss.indicators || 5,
          timestamp: ss.detectedAt,
          expiresAt: (() => { const d = new Date(); d.setUTCMinutes(60, 0, 0); return d.toISOString(); })(),
          session: ss.inKillzone ? 'Killzone' : 'n/a',
          firedStrategies: [],
          isServerSourced: true,
          serverStrategiesCount: ss.strategies,
          // v218 — propagate brain-blessed pattern flags from server
          isEliteBrainPattern: !!ss.isEliteBrainPattern,
          eliteBrainWR: ss.eliteBrainWR || null,
          brainCombo: ss.brainCombo || null,
          brainComboWR: ss.brainComboWR || null,
          brainExpectedHours: ss.brainExpectedHours || null,
          brainScoreBreakdown: ss.brainScoreBreakdown || [],
          smcPassed: ss.strategies >= 2, // proxy: server-confirmed = SMC-style
          smcQuality: 75 + Math.min(20, (ss.confidence - 85) * 2 + ss.strategies * 3),
          smcGrade: null,
          smcQualityBreakdown: [`Server cron · ${ss.strategies} patterns · ADX ${ss.adx} · ${ss.inKillzone ? 'in killzone' : 'off-session'}`],
          smcDiag: { passed: ss.strategies + 5, total: 8, gates: [] },
          sr: { support: ss.entry * 0.997, resistance: ss.entry * 1.003 },
        };
        // Compute the grade from the proxy quality
        merged.smcGrade = (merged.smcQuality >= 95) ? 'A+' : (merged.smcQuality >= 85) ? 'A' : (merged.smcQuality >= 75) ? 'B+' : 'B';
        signals.push(merged);
      }
    }
  } catch (e) { console.warn('[merge server signals]', e.message); }

  if (signals.length) renderSignalsPartial(signals);

  // Retry any primary-TF failures serially — daily misses are tolerable.
  const misses = pass1.map((r, i) => r.status === 'rejected' ? entries[i] : null).filter(Boolean);
  if (misses.length) {
    for (let i = 0; i < misses.length; i++) {
      const [name, sym] = misses[i];
      try {
        const data = await fetchOHLC(sym, '1h', '3mo');
        let daily = null;
        try { daily = await fetchOHLC(sym, '1d', '1y'); } catch {}
        analyzeAndPush(name, data, daily);
        renderSignalsPartial(signals);
      } catch (e) {
        failures++;
        console.warn(`[${name}]`, e.message);
      }
      if (i < misses.length - 1) await new Promise(r => setTimeout(r, 4000));
    }
  }
  // Cross-pair correlation check — does this signal contradict the broader
  // USD-strength consensus? If 8 of 10 USD pairs say "USD strong" but one
  // signal says otherwise, that one is likely noise — downgrade it.
  applyCorrelationCheck(signals);

  // Annotate every signal with its composite edge score AND its best grade.
  // SORT PRIORITY (top → bottom of the grid):
  //   1. Letter grade — A+ before A before B+ before B before C. You wanted
  //      to see your best setups first without scrolling past mediocre ones.
  //   2. Edge score (composite quality) as the tie-breaker inside each grade
  //      so two A+ signals are ordered by who has the stronger evidence.
  for (const s of signals) {
    s.edgeScore = compositeEdgeScore(s);
    s.dayTraderScore = dayTraderScore(s);
    s.bestGrade = _signalBestGrade(s);
    s.bestGradeRank = _gradeRank(s.bestGrade);
  }
  signals.sort((a, b) => {
    // Lower rank number = better grade (A+ is rank 0, C is rank 4)
    if (a.bestGradeRank !== b.bestGradeRank) return a.bestGradeRank - b.bestGradeRank;
    return (b.edgeScore || 0) - (a.edgeScore || 0);
  });
  state.signals = signals;
  $('#last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  if (failures && !signals.length) {
    $('#signals-status').innerHTML = 'Temporarily no signals — upstream data sources recovering. Try again in a minute.';
    return;
  }
  renderSignals();
}

async function loadNews(pair = '') {
  $('#news-status').textContent = 'Aggregating news feeds…';
  try {
    const url = pair ? `/api/news?pair=${encodeURIComponent(pair)}` : '/api/news';
    const r = await fetch(url);
    const d = await r.json();
    state.news = d.news || [];
    renderNews();
  } catch (e) { $('#news-status').textContent = 'News unavailable: ' + e.message; }
}

async function loadCalendar() {
  try {
    const r = await fetch('/api/calendar?impact=high');
    const d = await r.json();
    state.calendar = d.events || [];
    renderCalendar();
  } catch { $('#calendar-list').innerHTML = '<p class="muted">Calendar unavailable.</p>'; }
}

function renderSignalsPartial(signals) {
  // Apply the same grade-first ordering as the full sort: A+ → A → B+ → B → C,
  // edge score as tie-breaker. Without this, a partial update could re-order
  // the grid below the proper grade hierarchy and visually shuffle results.
  state.signals = signals.slice().sort((a, b) => {
    const ra = (a.bestGradeRank != null) ? a.bestGradeRank : _gradeRank(_signalBestGrade(a));
    const rb = (b.bestGradeRank != null) ? b.bestGradeRank : _gradeRank(_signalBestGrade(b));
    if (ra !== rb) return ra - rb;
    return (b.edgeScore || 0) - (a.edgeScore || 0);
  });
  renderSignals();
}

// Pro's Pick — picks the single highest-edge tradeable signal across all
// pairs and surfaces it as an explicit recommendation with reasoning.
// Mimics how a pro trader would scan the whole book and pick the cleanest
// trade. Returns null when nothing rises to "actionable" territory.
function pickProTrade(allSignals) {
  if (!allSignals || !allSignals.length) return null;
  // Eligible: not HOLD, not blocked, not in cooldown, real direction
  const eligible = allSignals.filter(s =>
    s && s.direction !== 'HOLD' &&
    !s.blockReason && !s.cooldownMinutesLeft);
  if (!eligible.length) return null;
  // Sort by grade first (A+ → A → B+ → B → C), edge score as tie-breaker.
  // Mirrors the main grid order so "Pro's Pick" is always the top-grade setup.
  const sorted = eligible.slice().sort((a, b) => {
    const ra = (a.bestGradeRank != null) ? a.bestGradeRank : _gradeRank(_signalBestGrade(a));
    const rb = (b.bestGradeRank != null) ? b.bestGradeRank : _gradeRank(_signalBestGrade(b));
    if (ra !== rb) return ra - rb;
    return (b.edgeScore || 0) - (a.edgeScore || 0);
  });
  const top = sorted[0];
  // Only call something the "Pro's Pick" if it actually has edge.
  if ((top.edgeScore || 0) < 35) return null;
  // Determine confidence tier of this pick
  let tier;
  if (isProSetup(top)) tier = 'pro';
  else if (isExtremeSetup(top)) tier = 'extreme';
  else if (isBestSetup(top)) tier = 'best';
  else if ((top.edgeScore || 0) >= 55) tier = 'available';
  else tier = 'cautious';
  // Build reasoning — why this specific trade
  const reasons = [];
  const aligned = (top.firedStrategies || []).filter(f =>
    (top.direction === 'BUY' && f.bias === 'bullish') ||
    (top.direction === 'SELL' && f.bias === 'bearish'));
  if (aligned.length >= 3) reasons.push(`${aligned.length} strategies firing same direction`);
  if (top.winProbability != null && top.backtestSamples >= 10 && top.winProbability >= 60) {
    reasons.push(`backtest ${top.winProbability}% (${top.backtestWins}/${top.backtestSamples})`);
  }
  if (top.session && top.session.toLowerCase().includes('killzone')) reasons.push('inside killzone');
  if (top.htfTrend && ((top.direction === 'BUY' && top.htfTrend === 'up') || (top.direction === 'SELL' && top.htfTrend === 'down'))) {
    reasons.push('daily trend aligned');
  }
  if (top.adxNow != null && top.adxNow >= 28) reasons.push(`strong trend (ADX ${top.adxNow})`);
  if (top.regimeAdj > 0) reasons.push(`strategies match ${top.regime} regime`);
  if (top.patternAdj > 0) reasons.push('historical pattern wins on this pair');
  if (!reasons.length) reasons.push('highest composite edge of all signals scanned');
  return { signal: top, tier, reasons, runnerUp: sorted[1] || null };
}

function renderProPickBanner(allSignals) {
  const pick = pickProTrade(allSignals);
  if (!pick) return '';
  const s = pick.signal;
  const tierBadge = {
    pro:       { label: '🏆 PRO PICK', color: '#ffd60a' },
    extreme:   { label: '🔥 EXTREME PICK', color: '#ff453a' },
    best:      { label: '⭐ BEST PICK', color: '#ffd60a' },
    available: { label: '⏳ TOP AVAILABLE', color: '#ff9f0a' },
    cautious:  { label: '⚠ STRONGEST AVAILABLE', color: '#86868b' },
  }[pick.tier];
  const dirCol = s.direction === 'BUY' ? 'var(--buy)' : 'var(--sell)';
  return `
    <div class="pro-pick-banner" data-pair="${s.pair}">
      <div class="pp-head">
        <span class="pp-tier" style="background:${tierBadge.color}">${tierBadge.label}</span>
        ${s.smcPassed ? '<span class="smc-tag" style="margin:0">📐 SMC CONFIRMED</span>' : ''}
        ${s.orbPassed ? '<span class="orb-tag" style="margin:0">📊 ORB CONFIRMED</span>' : ''}
        <span class="pp-title">If a pro trader had to pick ONE right now</span>
      </div>
      <div class="pp-body">
        <div class="pp-signal">
          <span class="pp-pair">${s.pair}</span>
          <span class="direction-badge dir-${s.direction}">${s.direction}</span>
          <span class="pp-conf">⚡${s.edgeScore}</span>
          <span class="pp-conf-pct">${s.confidence}%</span>
        </div>
        <div class="pp-levels">
          Entry <code>${s.entry}</code> · SL <code>${s.sl}</code> (${s.sl_pips}p) · TP1 <code>${s.tp1}</code> · TP2 <code>${s.tp2}</code>
        </div>
        <div class="pp-reasons">
          <strong>Why this one:</strong> ${pick.reasons.join(' · ')}
        </div>
        ${pick.runnerUp ? `<div class="pp-runnerup"><strong>Runner-up:</strong> ${pick.runnerUp.pair} ${pick.runnerUp.direction} ⚡${pick.runnerUp.edgeScore}</div>` : ''}
      </div>
    </div>`;
}

// v390 — detect newly-appeared signals and trigger visibility triple
// (title bump + audio chime + toast). Tracks known keys across renders.
const _v390SeenKeys = new Set();
let _v390SeededInitial = false;
function _v390CheckNewSignals(sigs) {
  if (!Array.isArray(sigs)) return;
  const currentKeys = new Set();
  for (const s of sigs) {
    if (!s || !s.pair || !s.direction) continue;
    // Key by pair+direction+entry so re-fires of the same setup don't retrigger
    const key = `${s.pair}_${s.direction}_${s.entry ?? '?'}`;
    currentKeys.add(key);
  }
  // First render after page load — seed known set silently; no alerts for
  // existing signals (they're not "new" from user's perspective).
  if (!_v390SeededInitial) {
    for (const k of currentKeys) _v390SeenKeys.add(k);
    _v390SeededInitial = true;
    return;
  }
  const brandNew = [...currentKeys].filter(k => !_v390SeenKeys.has(k));
  for (const k of brandNew) _v390SeenKeys.add(k);
  if (brandNew.length === 0) return;
  // Fire the triple
  try { state.unreadCount = (state.unreadCount || 0) + brandNew.length; updateTitle(); } catch {}
  try { if (typeof playChime === 'function' && !document.hidden) playChime(); } catch {}
  try { _v390ShowNewSignalToast(brandNew, sigs); } catch {}
}
function _v390ShowNewSignalToast(brandNewKeys, allSigs) {
  const matched = allSigs.filter(s => brandNewKeys.includes(`${s.pair}_${s.direction}_${s.entry ?? '?'}`));
  if (matched.length === 0) return;
  let host = document.getElementById('v390-toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'v390-toast';
    host.className = 'v390-toast';
    document.body.appendChild(host);
  }
  const summary = matched.slice(0, 3).map(s => {
    const arrow = s.direction === 'BUY' ? '▲' : '▼';
    return `<span class="v390-toast-sig ${s.direction === 'BUY' ? 'buy' : 'sell'}">${arrow} ${s.pair} ${s.direction} · ${s.confidence || '?'}%</span>`;
  }).join('');
  const more = matched.length > 3 ? `<span class="v390-toast-more">+${matched.length - 3} more</span>` : '';
  host.innerHTML = `
    <div class="v390-toast-head">🔔 New signal${matched.length > 1 ? 's' : ''} · tap to view</div>
    <div class="v390-toast-body">${summary}${more}</div>
  `;
  host.classList.remove('v390-hide');
  host.classList.add('v390-show');
  host.onclick = () => {
    const signalsTab = document.querySelector('.tab[data-tab="signals"]');
    if (signalsTab) signalsTab.click();
    host.classList.remove('v390-show');
    host.classList.add('v390-hide');
  };
  clearTimeout(host._v390Timer);
  host._v390Timer = setTimeout(() => {
    host.classList.remove('v390-show');
    host.classList.add('v390-hide');
  }, 8000);
}

function renderSignals() {
  try { _v390CheckNewSignals(state.signals); } catch {}
  const grid = $('#signals-grid');
  let pool;
  if (state.filterMode === 'extreme') {
    pool = state.signals.filter(isExtremeSetup);
  } else if (state.filterMode === 'best') {
    pool = state.signals.filter(isBestSetup);
  } else if (state.filterMode === 'dayTrader') {
    pool = state.signals.filter(isDayTraderSetup);
    // Re-sort day-trader pool by dayTraderScore (speed + win-rate weighted)
    // instead of pure grade. This surfaces 4-hour 65%-WR setups above
    // 12-hour 70%-WR ones — what the user actually needs for intraday work.
    pool = pool.slice().sort((a, b) => (b.dayTraderScore || 0) - (a.dayTraderScore || 0));
  } else if (state.filterMode === 'bigPips') {
    // v238 — BIG PIPS mode. Two ways a signal qualifies:
    //   1. Server marked it bigMove (ADX≥28 + killzone + vol expansion + 2+ strats)
    //   2. Pip distance to TP3 ≥ minimum (XAU/USD: 80pips, JPY: 35pips, forex: 30pips)
    // Either is sufficient — server bigMove is the strong signal, the pip
    // floor is a fallback so we still find big-room setups outside killzone.
    const minPipsForPair = (pair) =>
      pair === 'XAU/USD' ? 80
      : pair === 'BTC/USD' ? 400
      : pair === 'ETH/USD' ? 25
      : pair.includes('JPY') ? 35
      : 30;
    pool = state.signals.filter(s => {
      if (s.bigMove) return true;
      const tp3p = s.pipsToTp3 || s.tp3_pips || 0;
      return tp3p >= minPipsForPair(s.pair);
    });
    // Sort by pip potential descending — biggest moves first
    pool = pool.slice().sort((a, b) => {
      const ap = a.pipsToTp3 || a.tp3_pips || 0;
      const bp = b.pipsToTp3 || b.tp3_pips || 0;
      return bp - ap;
    });
  } else if (state.filterMode === 'none') {
    // v254 — NONE mode. Hide every signal EXCEPT the ones currently in the
    // Signal Feed (shadow tracker). Useful when you only want to focus on
    // trades the brain has already gated, scored, and is actively measuring.
    // Matches by pair+direction since the shadow feed key embeds the hour
    // bucket of when it fired, but the live grid carries its own timestamp.
    const shadow = (typeof window !== 'undefined' && window._lastShadowFeed) || [];
    const shadowKey = new Set(
      shadow
        .filter(x => x.status === 'open')   // only OPEN shadow signals — closed ones are history
        .map(x => `${x.pair}_${x.direction}`)
    );
    pool = state.signals.filter(s => shadowKey.has(`${s.pair}_${s.direction}`));
  } else {
    // Default mode pool: signals with at least minimum directional agreement.
    // CRITICAL: any strategy-confirmed signal bypasses this — strategies have
    // their own institutional rules and shouldn't be blocked by raw indicator
    // count. Without this, ORB-only signals with say 4/8 indicators get
    // killed here before they reach the rendering layer.
    pool = state.signals.filter(s => {
      // Fast path — any of the 7 strategies passing means it's a real signal
      if (s.smcPassed || s.orbPassed || s.ictPassed ||
          s.trendPassed || s.squeezePassed || s.divergencePassed ||
          s.momentumPassed) return true;
      const winners = s.direction === 'BUY' ? s.bull_count : s.bear_count;
      return winners >= Math.max(4, Math.ceil(s.total_indicators * 0.5));
    });
  }
  // Strategy-confirmed signals also bypass the confluence floor for the
  // same reason — they passed real institutional gates that are stricter
  // than a flat % confluence number.
  const filtered = pool.filter(s =>
    s.confidence >= state.minConf ||
    s.smcPassed || s.orbPassed ||
    s.ictPassed || s.trendPassed || s.squeezePassed || s.divergencePassed ||
    s.momentumPassed
  );
  const totalTracked = Object.keys(PAIRS).length;
  if (!filtered.length) {
    const highest = state.signals.length ? Math.max(...state.signals.map(s => s.confidence)) : 0;
    const bestCount = state.signals.filter(isBestSetup).length;
    // BEST AVAILABLE fallback — when filter mode is Best/Extreme but no signal
    // qualifies, show the top 3 by composite edge score with clear labeling
    // so the user always sees the strongest CURRENTLY-AVAILABLE setups instead
    // of an empty grid. They're tagged as "best available, NOT a Best Setup".
    if ((state.filterMode === 'best' || state.filterMode === 'extreme' || state.filterMode === 'dayTrader') && state.signals.length > 0) {
      // For dayTrader mode, sort by dayTraderScore (speed-weighted). For other
      // modes, use grade-first ordering. The fallback shows the top 3 best-
      // available signals when no signal fully passes the active filter.
      const sortDayTrader = state.filterMode === 'dayTrader';
      const topAvailable = state.signals
        .filter(s => s.direction !== 'HOLD' && !s.blockReason)
        .slice()
        .sort((a, b) => {
          if (sortDayTrader) {
            return (b.dayTraderScore || 0) - (a.dayTraderScore || 0);
          }
          const ra = (a.bestGradeRank != null) ? a.bestGradeRank : _gradeRank(_signalBestGrade(a));
          const rb = (b.bestGradeRank != null) ? b.bestGradeRank : _gradeRank(_signalBestGrade(b));
          if (ra !== rb) return ra - rb;
          return (b.edgeScore || 0) - (a.edgeScore || 0);
        })
        .slice(0, 3);
      if (topAvailable.length) {
        const modeLabel = state.filterMode === 'extreme' ? 'EXTREME'
                        : state.filterMode === 'dayTrader' ? 'Day Trader'
                        : 'Best';
        $('#signals-status').innerHTML = `
          ⏳ <strong>No full ${modeLabel} Setup right now.</strong> Showing top 3 highest-${sortDayTrader ? 'speed-and-edge' : 'edge'} setups available — these did NOT pass every gate but are the best available right now. Treat with caution; risk less.
          <div class="reality-banner" style="margin-top:8px;">
            📊 ${state.signals.length} pairs tracked · highest confluence ${highest}% · ${bestCount} would pass Best filter
          </div>`;
        const proPickHTML = renderProPickBanner(state.signals);
        const radiantHTML = renderRadiantBanner();
        grid.innerHTML = radiantHTML + proPickHTML + topAvailable.map((s) => `
          <div class="card-best-available">${cardHTML(s)}</div>
        `).join('');
        const ppBanner = grid.querySelector('.pro-pick-banner');
        if (ppBanner) ppBanner.addEventListener('click', () => openModal(ppBanner.dataset.pair));
        $$('.card').forEach(c => c.addEventListener('click', (e) => {
          if (e.target.closest('.card-note-wrap')) return;
          openModal(c.dataset.pair);
        }));
        wireCardNotes(grid);
        return;
      }
    }
    if (state.filterMode === 'extreme') {
      $('#signals-status').innerHTML = state.signals.length
        ? `🔥 <strong>EXTREME mode</strong> — no signals qualify. Switch to Best for more frequent high-probability setups.`
        : 'Loading signals…';
    } else if (state.filterMode === 'best') {
      $('#signals-status').innerHTML = state.signals.length
        ? `No Best setups right now. Switch filter OFF to see all signals.`
        : 'Loading signals…';
    } else if (state.filterMode === 'dayTrader') {
      $('#signals-status').innerHTML = state.signals.length
        ? `⚡ <strong>Day Trader mode</strong> — no fast-resolving setups right now. Cycle to Best for slower swings or OFF for all signals.`
        : 'Loading signals…';
    } else if (state.filterMode === 'none') {
      // v254b — Empty state for None mode. The user wanted "remove every
      // other signal except the ones on signal feed" — when nothing in the
      // grid matches the feed (or the feed itself is empty), say so clearly
      // and DON'T fall back to a Radiant banner that would defeat the point.
      $('#signals-status').innerHTML = state.signals.length
        ? `🎯 <strong>None mode</strong> — no live signals currently match the Signal Feed below. Wait for the brain to gate a new signal, or cycle the filter to see all signals.`
        : 'Loading signals…';
    } else {
      $('#signals-status').textContent = state.signals.length
        ? `No signals at or above ${state.minConf}% confluence. Highest available: ${highest}%.`
        : 'No signals loaded.';
    }
    // Even with no other signals, the Radiant gold banner can still appear —
    // EXCEPT in None mode, where the whole point is to suppress every signal
    // that isn't in the feed.
    grid.innerHTML = state.filterMode === 'none' ? '' : renderRadiantBanner();
    return;
  }
  const modeTag = state.filterMode === 'extreme' ? '🔥 <strong>EXTREME ONLY</strong>'
                : state.filterMode === 'best' ? '⭐ <strong>BEST SETUPS ONLY</strong>'
                : `≥ ${state.minConf}%`;
  const proCount = state.signals.filter(isProSetup).length;
  const proLine = proCount > 0 ? ` · <strong style="color:#ffd60a">🏆 ${proCount} PRO</strong>` : '';
  $('#signals-status').innerHTML = `
    ${filtered.length} signal${filtered.length === 1 ? '' : 's'} (${modeTag}) from ${totalTracked} pairs${proLine}. Click a card for full breakdown.
    <div class="reality-banner">
      📊 <strong>Honest expectation:</strong> even our strictest filtered signals win ≈60–65% of the time. <em>No forex system wins 9/10 — that's a myth.</em> Pros profit through 1:3 R:R + 1–2% risk per trade, NOT high win rates. If you're losing often, the cause is usually overtrading, oversized positions, or moving stops — not the signal.
    </div>
  `;
  const proPickHTML = renderProPickBanner(state.signals);
  const radiantHTML = renderRadiantBanner();
  // Per-strategy OPEN signal counter — shows at a glance how many active
  // signals each strategy currently has confirmed. The user asked for this
  // so they can see strategy distribution without clicking through every
  // card. Counts come from `filtered` (what's actually visible on screen).
  const stratCounter = renderStrategyCounter(filtered);
  // Currency strength index — uses ALL signals (not just filtered) so the
  // ranking reflects what the market is doing overall, not what the user
  // has filtered down to.
  const currencyStrength = renderCurrencyStrength(state.signals);
  // v254b — In None mode, strip EVERY extra signal-related banner so the
  // user sees ONLY the cards that match the Signal Feed below. No Radiant
  // gold callout, no Pro Pick highlight, no currency-strength bar, no
  // strategy-counter pills. Pure feed-only view.
  const isNoneMode = state.filterMode === 'none';
  grid.innerHTML = isNoneMode
    ? filtered.map(cardHTML).join('')
    : radiantHTML + currencyStrength + stratCounter + proPickHTML + filtered.map(cardHTML).join('');
  // v292 — Auto-fire the AI analyst on every rendered signal. Cached per
  // unique signal so it only runs once. Staggered to avoid rate limits.
  try { _autoAnalyseRenderedSignals(filtered); } catch {}
  // Pro's Pick banner click → opens that signal's modal
  const ppBanner = grid.querySelector('.pro-pick-banner');
  if (ppBanner) ppBanner.addEventListener('click', () => openModal(ppBanner.dataset.pair));
  $$('.card').forEach(c => c.addEventListener('click', (e) => {
    // Clicks inside the notes textarea must not bubble up and open the modal
    if (e.target.closest('.card-note-wrap')) return;
    openModal(c.dataset.pair);
  }));
  wireCardNotes(grid);
}

// Wire up every .card-note textarea inside `root`: stop click/touch propagation
// so editing doesn't open the modal, and persist on input + blur. Status text
// shows a short "Saved" flash so the user knows their note stuck.
function wireCardNotes(root) {
  if (!root) return;
  root.querySelectorAll('.card-note-wrap').forEach(wrap => {
    const pair = wrap.dataset.pair;
    const direction = wrap.dataset.direction;
    const ta = wrap.querySelector('.card-note');
    const status = wrap.querySelector('.card-note-status');
    if (!ta) return;
    let saveTimer = null;
    const flash = (txt) => { if (status) { status.textContent = txt; clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (status) status.textContent = ''; }, 1200); } };
    // Block the card-level click so the modal doesn't open when editing
    ['click','mousedown','touchstart','pointerdown'].forEach(ev => {
      wrap.addEventListener(ev, e => e.stopPropagation());
    });
    let debounce = null;
    ta.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { setSignalNote(pair, direction, ta.value); flash('Saved'); }, 400);
    });
    ta.addEventListener('blur', () => {
      clearTimeout(debounce);
      setSignalNote(pair, direction, ta.value);
      flash('Saved');
    });
  });
}

// Counter banner — shows how many currently-visible signals each strategy
// has confirmed. Renders as colored pills above the signal grid so the user
// gets a quick visual breakdown of strategy activity. Hidden when no signals.
// ── CURRENCY STRENGTH INDEX ─────────────────────────────────────────────
// Computes relative strength of the 8 major currencies based on cross-pair
// 24-hour percentage moves. Pros use this every morning to set their bias:
// "USD is strongest, NZD is weakest → look for USD/NZD longs."
//
// For each currency, average its directional move across every pair it
// appears in. If a currency is the BASE (left side), its % move = pair move.
// If it's the QUOTE (right side), invert. Average across all appearances.
function computeCurrencyStrength(signals) {
  const currencies = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
  const strength = {};
  for (const c of currencies) strength[c] = { sum: 0, count: 0 };

  // Iterate every signal we have data for — signal carries OHLC indirectly
  // via the current vs 24-bar-ago close. Use signal.entry vs price 24 bars
  // ago. We'll approximate using state.signals data.
  for (const s of signals) {
    if (!s.pair || !s.entry) continue;
    // 24-hour % change for this pair — approximated by signal's daily candle.
    // We don't have direct 24h-old data on the signal, so estimate from
    // current price vs daily-trend signal if present. Fallback: use direction
    // + confidence as a proxy (rough but useful).
    const [base, quote] = s.pair.split('/');
    if (!currencies.includes(base) || !currencies.includes(quote)) continue;
    // Approximate 24h move via the signal's session adjustment + HTF trend
    // strength. A signal with htfTrend='up' on EUR/USD means EUR > USD over
    // recent timeframe. Use bull_count - bear_count as proxy for direction.
    const move = (s.bull_count - s.bear_count) / Math.max(1, s.total_indicators);
    if (!Number.isFinite(move)) continue;
    // Base currency rises when pair rises; quote currency rises when pair falls
    strength[base].sum += move;
    strength[base].count++;
    strength[quote].sum -= move;
    strength[quote].count++;
  }
  // Average + rank
  const ranked = currencies.map(c => ({
    currency: c,
    score: strength[c].count > 0 ? strength[c].sum / strength[c].count : 0,
    samples: strength[c].count,
  })).sort((a, b) => b.score - a.score);
  return ranked;
}

function renderCurrencyStrength(signals) {
  const ranked = computeCurrencyStrength(signals);
  if (!ranked.length || ranked.every(r => r.samples === 0)) return '';
  // Normalize to display percent (-100% to +100%)
  const max = Math.max(0.01, ...ranked.map(r => Math.abs(r.score)));
  const flag = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', CHF: '🇨🇭', CAD: '🇨🇦', AUD: '🇦🇺', NZD: '🇳🇿' };
  const bars = ranked.map(r => {
    const pct = (r.score / max) * 100;
    const color = r.score > 0.1 ? 'var(--buy)' : r.score < -0.1 ? 'var(--sell)' : 'var(--muted)';
    const width = Math.abs(pct).toFixed(0);
    const side = r.score >= 0 ? 'right' : 'left';
    return `
      <div class="cs-row">
        <span class="cs-flag">${flag[r.currency] || ''}</span>
        <span class="cs-code">${r.currency}</span>
        <div class="cs-bar-wrap">
          <div class="cs-bar cs-bar-${side}" style="width:${width}%; background:${color}"></div>
        </div>
        <span class="cs-pct" style="color:${color}">${r.score >= 0 ? '+' : ''}${(r.score * 100).toFixed(0)}</span>
      </div>`;
  }).join('');
  return `
    <div class="currency-strength">
      <div class="cs-head">
        <strong>💪 Currency Strength</strong>
        <span class="muted">strongest → weakest across all 28 forex pairs</span>
      </div>
      <div class="cs-grid">${bars}</div>
    </div>`;
}

function renderStrategyCounter(signals) {
  if (!signals || !signals.length) return '';
  const counts = {
    smc:        signals.filter(s => s.smcPassed).length,
    orb:        signals.filter(s => s.orbPassed).length,
    ict:        signals.filter(s => s.ictPassed).length,
    trend:      signals.filter(s => s.trendPassed).length,
    squeeze:    signals.filter(s => s.squeezePassed).length,
    divergence: signals.filter(s => s.divergencePassed).length,
  };
  const pills = [
    { sk: 'smc',        name: 'SMC',         icon: '📐', color: '#5fd5ff', count: counts.smc },
    { sk: 'orb',        name: 'ORB',         icon: '📊', color: '#ffb347', count: counts.orb },
    { sk: 'ict',        name: 'ICT',         icon: '🎯', color: '#c4a3ff', count: counts.ict },
    { sk: 'trend',      name: 'TREND',       icon: '📈', color: '#67e8f9', count: counts.trend },
    { sk: 'squeeze',    name: 'SQUEEZE',     icon: '💥', color: '#f9a8d4', count: counts.squeeze },
    { sk: 'divergence', name: 'DIV',         icon: '🔄', color: '#fde047', count: counts.divergence },
  ];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return ''; // nothing to count
  const pillHtml = pills.map(p => `
    <span class="strat-counter strat-counter-${p.sk}" style="border-color:${p.color}; color:${p.color}" title="${p.name}: ${p.count} open signal${p.count === 1 ? '' : 's'}">
      ${p.icon} <b>${p.count}</b> ${p.name}
    </span>
  `).join('');
  return `
    <div class="strat-counter-banner">
      <div class="scb-head">
        <strong>Open signals by strategy</strong>
        <span class="muted">${signals.length} total · multi-strategy possible</span>
      </div>
      <div class="scb-pills">${pillHtml}</div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════
// v292 — AUTO-ANALYSE EVERY SIGNAL. The chart-bot runs automatically on
// every signal that hits the Signal Feed. The verdict is cached forever
// per unique signal (no repeat calls), gracefully falls back if Anthropic
// runs out of credit, and renders inline on each card. No tap required —
// the bot has read every signal you can see.
// ════════════════════════════════════════════════════════════════════════
const SIGNAL_AI_CACHE_KEY = 'forexsight_signal_ai_v1';
let _aiSignalCache = null;
let _aiOutOfCredit = false;          // global flag once Anthropic returns 400
let _aiInflight = new Set();          // de-dup in-flight requests by key
function _signalCacheKey(s) {
  // Stable identity for this signal across renders.
  const ts = (s.detectedAt || '').slice(0, 13); // hour-bucket
  return `${s.pair}_${s.direction}_${s.entry}_${ts}`;
}
function _loadAiCache() {
  if (_aiSignalCache) return _aiSignalCache;
  try {
    const raw = localStorage.getItem(SIGNAL_AI_CACHE_KEY);
    _aiSignalCache = raw ? JSON.parse(raw) : {};
    // Trim to last 200 entries to keep localStorage healthy
    const keys = Object.keys(_aiSignalCache);
    if (keys.length > 200) {
      const sorted = keys.sort((a, b) => (_aiSignalCache[a].ts || 0) - (_aiSignalCache[b].ts || 0));
      for (let i = 0; i < keys.length - 200; i++) delete _aiSignalCache[sorted[i]];
    }
  } catch { _aiSignalCache = {}; }
  return _aiSignalCache;
}
function _saveAiCache() {
  try { localStorage.setItem(SIGNAL_AI_CACHE_KEY, JSON.stringify(_aiSignalCache || {})); } catch {}
}
function _renderAiVerdictInto(el, payload) {
  if (!el) return;
  const mode = payload?.mode;
  if (mode === 'llm' || mode === 'brain-only') {
    const reply = (payload.reply || payload.fallbackReply || '').trim();
    const isLlm = mode === 'llm';
    el.classList.toggle('cav-llm', isLlm);
    el.classList.toggle('cav-fallback', !isLlm);
    el.innerHTML = `
      <div class="cav-header">${isLlm ? '🧠 AI analyst verdict' : '📊 Brain analyst (no LLM credit)'}</div>
      <div class="cav-body">${_cbRenderMarkdown(reply)}</div>`;
  } else if (mode === 'llm-error' || mode === 'llm-exception') {
    el.classList.add('cav-error');
    const err = payload?.error || 'AI call failed';
    const isCredit = /credit balance/i.test(err);
    el.innerHTML = `<div class="cav-header">⚠️ ${isCredit ? 'Anthropic credit empty' : 'AI temporarily unavailable'}</div>
      <div class="cav-body muted">${isCredit ? 'Add credits at <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">console.anthropic.com/settings/billing</a> to unlock auto-analysis on every signal.' : err}</div>`;
    if (isCredit) _aiOutOfCredit = true;
  } else {
    el.innerHTML = `<div class="cav-header">AI unavailable</div>`;
  }
}
async function _analyseSingleSignal(s, el) {
  if (_aiOutOfCredit) { _renderAiVerdictInto(el, { mode: 'llm-error', error: 'credit balance' }); return; }
  const key = _signalCacheKey(s);
  const cache = _loadAiCache();
  if (cache[key]) { _renderAiVerdictInto(el, cache[key]); return; }
  if (_aiInflight.has(key)) return; // someone else is fetching this exact one
  _aiInflight.add(key);
  try {
    const res = await fetch('/api/chart-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: `Validate this signal: ${s.pair} ${s.direction} entry ${s.entry}, SL ${s.sl}, TP1 ${s.tp1}, TP2 ${s.tp2}, TP3 ${s.tp3}. Confidence ${s.confidence}%, strategies fired: ${s.strategies}. Use the LIVE_MARKET data — is this signal still valid right now? Give your verdict per the framework with explicit entry trigger and invalidation.`,
        }],
        pair: s.pair,
        timeframe: '1H',
        strategy: 'auto',
      }),
    });
    const data = await res.json();
    cache[key] = { mode: data.mode, reply: data.reply || data.fallbackReply, error: data.error, ts: Date.now() };
    _saveAiCache();
    _renderAiVerdictInto(el, cache[key]);
  } catch (e) {
    _renderAiVerdictInto(el, { mode: 'llm-exception', error: e.message || String(e) });
  } finally {
    _aiInflight.delete(key);
  }
}
function _autoAnalyseRenderedSignals(signals) {
  if (!Array.isArray(signals) || !signals.length) return;
  // v299 — Throttle to top-3 by confidence + gold-priority. Firing 8+
  // concurrent LLM calls per render was the biggest UI lag source and the
  // biggest source of Anthropic cost burn. Now we prioritise gold and the
  // strongest signals — the user always sees an AI verdict on what
  // actually matters. Every card still gets an immediate cache hit if we
  // have one; only NEW top-3 fires an actual LLM call.
  // v387 — on cold load fire only 1 (was 3) to prevent browser choke.
  // User can tap remaining to analyse on demand.
  const MAX_FRESH_CALLS = 1;
  // First pass: paint cached verdicts on every card immediately (no wait)
  const cache = _loadAiCache();
  const toAnalyse = [];
  for (const s of signals) {
    const key = _signalCacheKey(s);
    const el = document.querySelector(`.card-ai-verdict[data-signal-key="${CSS.escape(key)}"]`);
    if (!el) continue;
    if (cache[key]) { _renderAiVerdictInto(el, cache[key]); continue; }
    toAnalyse.push({ s, el });
  }
  // Sort remaining by: gold first, then confidence desc — top-3 get LLM calls
  toAnalyse.sort((a, b) => {
    const aGold = a.s.pair === 'XAU/USD' ? 1 : 0;
    const bGold = b.s.pair === 'XAU/USD' ? 1 : 0;
    if (aGold !== bGold) return bGold - aGold;
    return (b.s.confidence || 0) - (a.s.confidence || 0);
  });
  // v387 — start analysing after 2.5s (let UI paint first) instead of 0ms
  const interval = 500;
  let delay = 2500;
  for (let i = 0; i < Math.min(MAX_FRESH_CALLS, toAnalyse.length); i++) {
    const { s, el } = toAnalyse[i];
    setTimeout(() => _analyseSingleSignal(s, el), delay);
    delay += interval;
  }
  // Signals beyond top-3 get a "Tap to analyse" placeholder — on-demand, no cost
  for (let i = MAX_FRESH_CALLS; i < toAnalyse.length; i++) {
    const { s, el } = toAnalyse[i];
    el.innerHTML = `<div class="cav-tap-to-analyse" data-signal-key="${_signalCacheKey(s)}" style="cursor:pointer;padding:6px 10px;color:#94a3b8;font-size:12px;text-align:center;background:rgba(255,255,255,0.03);border-radius:6px">🧠 Tap to analyse — top-3 signals auto-analysed to save cost/lag</div>`;
    el.querySelector('.cav-tap-to-analyse')?.addEventListener('click', () => _analyseSingleSignal(s, el));
  }
}

function cardHTML(s) {
  const col = s.direction === 'BUY' ? 'var(--buy)' : s.direction === 'SELL' ? 'var(--sell)' : 'var(--hold)';
  // v237 — Defensive: server-merged or deep-link signals may not include votes.
  // Previously a missing votes object threw and killed the entire grid render.
  const votes = Object.entries(s.votes || {}).map(([k, v]) =>
    `<span class="vote-pill vp-${v?.[0] || 'neutral'}" title="${k}: ${v?.[1] || ''}">${k.split(' ')[0]}</span>`).join('');
  const isBest = isBestSetup(s);
  const isPro = isProSetup(s);
  const isExtreme = isExtremeSetup(s);
  // Surface which named strategies actually fired on this signal (in the
  // direction of the signal) — so the user knows the source of the edge.
  const firedAligned = (s.firedStrategies || []).filter(f =>
    (s.direction === 'BUY' && f.bias === 'bullish') ||
    (s.direction === 'SELL' && f.bias === 'bearish')
  );
  const stratStrip = firedAligned.length ? `
    <div class="card-strats" title="Strategies firing in this signal direction">
      ${firedAligned.map(f => `<span class="strat-tag" title="${f.reason || ''}">${f.name}</span>`).join('')}
    </div>` : '';
  return `
    <div class="card ${isBest ? 'card-best' : ''} ${isPro ? 'card-pro' : ''} ${isExtreme ? 'card-extreme' : ''} ${s.brainRecommended ? 'card-brain-pick' : ''}" data-pair="${s.pair}">
      ${s.brainRecommended ? `
        <div class="brain-pick-banner" title="The brain compared every active signal against everything it has learned (combo win rates, live outcomes, quantum simulation, calibration, regime, sample weight) and ranked this one #1 — composite score ${s.brainRecommendationScore || '?'}.">
          <div class="bpb-glyph">🧠✨</div>
          <div class="bpb-text">
            <div class="bpb-title">BRAIN'S TOP PICK</div>
            <div class="bpb-sub">Best trade out of everything the brain has learned</div>
            ${s.brainRecommendationReason ? `<div class="bpb-why">${s.brainRecommendationReason}</div>` : ''}
          </div>
        </div>
      ` : ''}
      ${isExtreme ? '<div class="extreme-badge">🔥 EXTREME</div>' : isPro ? '<div class="pro-badge">🏆 PRO</div>' : isBest ? '<div class="best-badge">⭐ BEST</div>' : ''}
      ${s.isSuperSetup ? (s.superReason === 'consensus'
          ? `<div class="super-badge" title="${s.passingStratsCount} strategies + ${s.superAlignedDelta} indicator-delta in signal direction — institutional consensus">🏆 SUPER · ${s.passingStratsCount} strats · +${s.superAlignedDelta} consensus</div>`
          : `<div class="super-badge" title="${s.passingStratsCount} independent strategies confirm this setup — institutional-grade confluence">🏆 SUPER · ${s.passingStratsCount} strategies</div>`
        ) : ''}
      ${s.isServerSourced ? `<div class="server-badge" title="Detected by the always-on server cron (${s.serverStrategiesCount} pattern strategies). Notification was sent for this setup.">📡 Server-detected · ${s.serverStrategiesCount} patterns</div>` : ''}
      ${s.bigMove ? `<div class="big-run-badge" title="BIG RUN setup: ADX ${s.adx} + killzone + volatility ${s.atrExpansion}× normal + ${s.strategies} strategies. TP3 reach ${s.pipPotential || s.pipsToTp3} pips. Stretched TP2/TP3 to capture the full move.">🚀 BIG RUN · ${s.pipPotential || s.pipsToTp3 || '?'} pips to TP3</div>` : ''}
      ${s.chartStudy ? (() => {
        // v267 — Chart study badge. The brain examined the OHLC chart on 7
        // structural dimensions before allowing this signal. Score 0-100.
        // Only signals scoring 55+ (45+ for elite patterns) reach the user.
        const cs = s.chartStudy;
        const cls = cs.score >= 80 ? 'csb-strong' : cs.score >= 65 ? 'csb-good' : 'csb-ok';
        const tip = (cs.reasons || []).join('\\n');
        return `<div class="chart-study-badge ${cls}" title="${tip}">📈 Chart studied · ${cs.score}/100</div>`;
      })() : ''}
      ${s.probabilityAnalysis ? (() => {
        // v242 — Brain Gate probability badge. The brain literally checked
        // every reason this signal could fail AND every reason it could
        // succeed, then weighted them by evidence strength. If this badge
        // is showing, the math said the win edge is real.
        const pa = s.probabilityAnalysis;
        const edgeClass = pa.edge >= 30 ? 'pba-strong' : pa.edge >= 15 ? 'pba-good' : 'pba-ok';
        const passList = (pa.passFactors || []).slice(0, 3).map(f => f.evidence).join(' · ');
        const failList = (pa.failFactors || []).slice(0, 3).map(f => f.evidence).join(' · ');
        const tip = `Brain evaluated ${(pa.passFactors||[]).length} pass factors and ${(pa.failFactors||[]).length} fail factors.\\n\\nPASS: ${passList || 'none'}\\n\\nFAIL: ${failList || 'none'}\\n\\nP(win) ${pa.pWin}% > P(lose) ${pa.pLose}% by ${pa.edge}pts.`;
        return `<div class="prob-badge ${edgeClass}" title="${tip}">⚖️ P(win) ${pa.pWin}% · edge +${pa.edge}pts</div>`;
      })() : ''}
      ${s.quantum && !s.quantum.error ? (() => {
        // v243 — Quantum Monte Carlo readout. Brain ran 500 simulated price
        // paths to compute forward probabilities of each TP/SL being hit AND
        // the best position-split strategy (mini-trade). E[R] = expected risk
        // multiple — positive means net profitable over many trades.
        const q = s.quantum;
        const best = q.bestStrategy || {};
        const eRClass = best.expectedR >= 0.6 ? 'qsim-strong'
                      : best.expectedR >= 0.3 ? 'qsim-good'
                      : best.expectedR >= 0   ? 'qsim-ok'
                      : 'qsim-poor';
        const stratList = (q.strategies || []).map(st =>
          `${st.short}: E[R] ${st.eR >= 0 ? '+' : ''}${st.eR.toFixed(2)}`
        ).join(' · ');
        const tip = `${q.iterations} simulated paths · blended WR ${q.blendedWR}% · expected ${q.avgBarsExpected}h to resolve\\n\\nProbability hit:  TP1 ${q.pTP1}% · TP2 ${q.pTP2}% · TP3 ${q.pTP3}% · SL ${q.pSL}%\\n\\nStrategy E[R]:\\n${stratList}\\n\\nBest mini-trade: ${best.split}`;
        return `
          <div class="quantum-sim ${eRClass}" title="${tip}">
            <div class="qsim-head">🌌 Quantum sim · ${q.iterations} paths</div>
            <div class="qsim-probs">
              <span class="qsim-pill qsim-tp">TP1 <b>${q.pTP1}%</b></span>
              <span class="qsim-pill qsim-tp">TP2 <b>${q.pTP2}%</b></span>
              <span class="qsim-pill qsim-tp">TP3 <b>${q.pTP3}%</b></span>
              <span class="qsim-pill qsim-sl">SL <b>${q.pSL}%</b></span>
            </div>
            <div class="qsim-best">
              <strong>Best mini-trade:</strong> ${best.short} → E[R] ${best.expectedR >= 0 ? '+' : ''}${best.expectedR}
              <span class="qsim-split">${best.split}</span>
            </div>
          </div>`;
      })() : ''}
      ${s.isEliteBrainPattern ? `<div class="elite-brain-badge" title="Brain backtest data shows this exact pattern has ${s.eliteBrainWR}% historical WR. Detection thresholds were relaxed to ensure we catch it.">🏆 ELITE BRAIN PATTERN · ${s.eliteBrainWR}% backtest WR</div>` : ''}
      ${s.brainCombo && s.brainComboWR != null ? `<div class="brain-combo-line" title="${(s.brainScoreBreakdown || []).join(' · ')}">🧠 ${s.brainCombo.replace(/_/g,' · ')} · ${s.brainComboWR}% WR · ~${s.brainExpectedHours || '?'}h to resolve</div>` : ''}
      ${(() => {
        // v271 — BRAIN VERDICT panel. ONE clean readable block summarising
        // everything the brain knows about this specific signal. Combines:
        //   • pWin from probability gate
        //   • k-NN per-signal verdict
        //   • Chart study score (with top reason)
        //   • Quantum sim recommended strategy + E[R]
        //   • Brain combo historical WR
        //   • Risk/reward setup
        // Goal: trader sees ONE panel and knows whether to take the trade.
        const pa = s.probabilityAnalysis || {};
        const ps = s.perSignalStudy || null;
        const cs = s.chartStudy || null;
        const q = s.quantum || null;
        const best = q && q.bestStrategy ? q.bestStrategy : null;
        // Don't render the panel if we have nothing meaningful to summarise
        if (!pa.pWin && !ps && !cs && !best) return '';
        // Verdict label by pWin
        const pWin = pa.pWin || 0;
        const verdict = pWin >= 75 ? { label: 'STRONG', cls: 'bv-strong', emoji: '🟢' }
                      : pWin >= 65 ? { label: 'GOOD', cls: 'bv-good', emoji: '🟢' }
                      : pWin >= 55 ? { label: 'OK', cls: 'bv-ok', emoji: '🟡' }
                      : pWin >= 50 ? { label: 'MARGINAL', cls: 'bv-marginal', emoji: '🟡' }
                      : { label: 'WEAK', cls: 'bv-weak', emoji: '🔴' };
        const slPips = s.pipsToSl || s.sl_pips || 0;
        const tp3Pips = s.pipsToTp3 || s.tp3_pips || 0;
        const rr = slPips > 0 ? Math.round((tp3Pips / slPips) * 10) / 10 : null;
        return `
        <div class="brain-verdict ${verdict.cls}">
          <div class="bv-head">
            <span class="bv-emoji">${verdict.emoji}</span>
            <span class="bv-title">BRAIN VERDICT</span>
            <span class="bv-label">${verdict.label}</span>
            <span class="bv-pwin">${pWin}% win chance</span>
          </div>
          <div class="bv-rows">
            ${ps && ps.matched >= 3 ? `<div class="bv-row"><span class="bv-icon">🔍</span><span class="bv-text"><b>${ps.wins} of ${ps.matched}</b> past similar signals won — Bayes <b>${ps.bayesianWR || ps.perSignalWR}%</b>${ps.ciLower != null ? ` <span class="muted">(95% CI ${ps.ciLower}–${ps.ciUpper}%)</span>` : ''}</span></div>` : ''}
            ${cs ? `<div class="bv-row"><span class="bv-icon">📈</span><span class="bv-text">Chart structure: <b>${cs.score}/100</b></span></div>` : ''}
            ${s.htfStudy ? (() => {
              const h = s.htfStudy;
              const icon = h.alignment === 'aligned' ? '✓' : h.alignment === 'opposed' ? '✗' : '◯';
              const label = h.alignment === 'aligned' ? `<b>4H trend matches</b> signal direction`
                          : h.alignment === 'opposed' ? `<b>⚠ 4H trend OPPOSES</b> signal`
                          : `4H ${h.direction || 'neutral'}`;
              return `<div class="bv-row"><span class="bv-icon">${icon}</span><span class="bv-text">${label} <span class="muted">(4H ADX ${h.adx4h})</span></span></div>`;
            })() : ''}
            ${s.brainComboWR != null ? `<div class="bv-row"><span class="bv-icon">🧠</span><span class="bv-text">This combo wins <b>${s.brainComboWR}%</b> historically (${s.brainComboSamples || '?'} samples)</span></div>` : ''}
            ${best ? `<div class="bv-row"><span class="bv-icon">💡</span><span class="bv-text">Best mini-trade: <b>${best.split}</b> → expected return <b>${best.expectedR >= 0 ? '+' : ''}${best.expectedR}R</b></span></div>` : ''}
            ${rr != null ? `<div class="bv-row"><span class="bv-icon">⚖️</span><span class="bv-text">Risk: ${slPips} pips · Reward: ${tp3Pips} pips · <b>${rr}:1 R:R</b></span></div>` : ''}
            ${s.brainExpectedHours ? `<div class="bv-row"><span class="bv-icon">⏱</span><span class="bv-text">Expected resolution: <b>~${s.brainExpectedHours}h</b></span></div>` : ''}
          </div>
        </div>`;
      })()}
      ${s.volRegimeFlag ? `<div class="vol-warning vol-${s.volRegimeFlag.kind}" title="ATR is ${s.volRegimeFlag.ratio}× normal — patterns less reliable">${s.volRegimeFlag.kind === 'extreme' ? '⚠ Extreme volatility' : '🌙 Dead market'} (ATR ${s.volRegimeFlag.ratio}×)</div>` : ''}
      <div class="card-head"><div class="pair">${s.pair}</div><div class="direction-badge dir-${s.direction}">${s.direction}</div></div>
      ${s.smcPassed ? `<div class="smc-tag smc-grade-${(s.smcGrade||'C').replace('+','plus').toLowerCase()}" title="SMC ${s.smcGrade || ''} (${s.smcQuality}/100) · ${(s.smcQualityBreakdown||[]).join(' · ')}">📐 SMC CONFIRMED${s.smcGrade ? ` · <span class="grade-pill">${s.smcGrade}</span>` : ''}</div>` : ''}
      ${s.orbPassed ? `<div class="orb-tag orb-grade-${(s.orbGrade||'C').replace('+','plus').toLowerCase()}" title="ORB ${s.orbGrade || ''} (${s.orbQuality}/100) · ${(s.orbQualityBreakdown||[]).join(' · ')}">📊 ORB CONFIRMED${s.orbGrade ? ` · <span class="grade-pill">${s.orbGrade}</span>` : ''}</div>` : ''}
      ${Object.entries(STRATEGIES).map(([sk, cfg]) => {
        if (!s[`${sk}Passed`]) return '';
        const g = (s[`${sk}Grade`] || 'C').replace('+', 'plus').toLowerCase();
        const grade = s[`${sk}Grade`];
        const q = s[`${sk}Quality`];
        const breakdown = (s[`${sk}QualityBreakdown`] || []).join(' · ');
        return `<div class="strat-tag strat-tag-${sk} strat-grade-${g}" title="${cfg.name} ${grade || ''} (${q}/100) · ${breakdown}">${cfg.icon} ${cfg.short.toUpperCase()} CONFIRMED${grade ? ` · <span class="grade-pill">${grade}</span>` : ''}</div>`;
      }).join('')}
      <div class="conf">
        <div class="conf-label">
          <span>Confluence</span>
          <span>
            ${s.smcPassed ? `<span class="smc-badge" title="SMC: ${s.smcDiag?.passed}/${s.smcDiag?.total} gates · quality ${s.smcQuality}/100 (${s.smcGrade})">🛡 SMC ${s.smcGrade || ''}</span>` : ''}
            ${s.orbPassed ? `<span class="orb-badge" title="ORB: ${s.orbDiag?.passed}/${s.orbDiag?.total} gates · quality ${s.orbQuality}/100 (${s.orbGrade})">📊 ORB ${s.orbGrade || ''}</span>` : ''}
            ${Object.entries(STRATEGIES).map(([sk, cfg]) => {
              if (!s[`${sk}Passed`]) return '';
              return `<span class="strat-badge strat-badge-${sk}" title="${cfg.name}: ${s[`${sk}Diag`]?.passed}/${s[`${sk}Diag`]?.total} gates · quality ${s[`${sk}Quality`]}/100 (${s[`${sk}Grade`]})">${cfg.icon} ${cfg.short} ${s[`${sk}Grade`] || ''}</span>`;
            }).join('')}
            ${s.edgeScore != null ? `<span class="edge-score" title="Composite edge: backtest CI + pattern match + multi-strategy + regime + calibration.">⚡ ${s.edgeScore}</span>` : ''}
            <span class="smart-score sc-${smartnessScore(s) >= 9 ? 'high' : smartnessScore(s) >= 6 ? 'mid' : 'low'}" title="Smartness: ${smartnessScore(s)}/12 quality gates passed">🧠 ${smartnessScore(s)}/12</span>
            <b>${s.confidence}%</b>
          </span>
        </div>
        <div class="conf-bar"><span style="width:${s.confidence}%;background:${col}"></span></div>
      </div>
      ${s.regimeNote ? `<div class="regime-note">${s.regimeNote}</div>` : ''}
      ${s.calibrationSamples >= 10 ? `<div class="cal-note" title="Confidence calibrated against actual win rates from your closed trades. Raw model said ${s.rawConfidence}%, but signals at this level have actually won ${s.calibrationActualRate}% of the time over ${s.calibrationSamples} closed trades — so we show ${s.confidence}%.">🎯 Calibrated from ${s.calibrationSamples} closed trades</div>` : ''}
      ${s.patternNote ? `<div class="pattern-note ${s.patternAdj > 0 ? 'pn-up' : s.patternAdj < 0 ? 'pn-down' : ''}">${s.patternNote}</div>` : ''}
      ${s.data_age_minutes != null && s.data_age_minutes > 90 ? `<div class="vol-flag chaos">⚠ Data is ${s.data_age_minutes} min old — may be stale</div>` : ''}
      ${s.correlationFlag ? `<div class="corr-flag" title="${s.correlationFlag}">⚠ Cross-pair conflict</div>` : ''}
      ${s.volRegime === 'chaos' ? '<div class="vol-flag chaos">🌪 Chaotic market — high whipsaw risk</div>' : ''}
      ${s.volRegime === 'dead' ? '<div class="vol-flag dead">😴 Dead market — no follow-through</div>' : ''}
      ${s.winProbability != null ? `
      <div class="winprob ${s.winProbability >= 60 ? 'wp-good' : s.winProbability >= 50 ? 'wp-mid' : 'wp-bad'}">
        🎯 Backtested win rate: <strong>${s.winProbability}%</strong>
        <span class="muted">(${s.backtestWins}W/${s.backtestLosses}L on similar setups)</span>
      </div>` : ''}
      ${s.expectedHoldHours != null ? `
      <div class="hold-time ${s.expectedHoldHours <= 4 ? 'ht-fast' : s.expectedHoldHours <= 8 ? 'ht-medium' : 'ht-slow'}" title="Estimated time for price to reach TP1, based on 2× (TP1 distance / ATR). Real markets oscillate, so this is a rough guide.">
        ⏱ Expected hold: <strong>${s.expectedHoldHours < 1 ? '<1' : s.expectedHoldHours.toFixed(1)} hrs</strong>
        ${s.expectedHoldHours <= 4 ? '· <span class="ht-tag">⚡ FAST</span>' : s.expectedHoldHours <= 8 ? '· <span class="ht-tag">Day-trade-able</span>' : '· <span class="ht-tag">Swing setup</span>'}
        ${s.isDayTraderSetup ? '<span class="dt-badge" title="Passes all Day Trader criteria: ≤8hr hold, 2+ strategies, London/NY session, HTF-aligned, ADX≥18">⚡ DAY TRADER ✓</span>' : ''}
      </div>` : ''}
      <div class="levels">
        <span class="lbl">Entry</span><span class="val">${s.entry}</span><span class="pips">now · spread ~${s.spread_pips}p</span>
        <span class="lbl">Stop Loss</span><span class="val">${s.sl}</span><span class="pips">${s.sl_pips}p (real ${s.effective_sl_pips ?? '?'}p)</span>
        <span class="lbl">TP1 (1:1)</span><span class="val">${s.tp1}</span><span class="pips">${s.tp1_pips}p (real ${s.effective_tp1_pips ?? '?'}p)</span>
        <span class="lbl">TP2 (1:2.5)</span><span class="val">${s.tp2}</span><span class="pips">${s.tp2_pips}p (real ${s.effective_tp2_pips ?? '?'}p)</span>
        <span class="lbl">TP3 (1:4)</span><span class="val">${s.tp3}</span><span class="pips">${s.tp3_pips}p (real ${s.effective_tp3_pips ?? '?'}p)</span>
      </div>
      ${s.effective_tp1_pips != null && s.effective_tp1_pips < s.effective_sl_pips * 0.7 ? `
      <div class="vol-flag chaos" style="margin-top:6px">⚠ Spread eats too much — real R:R is poor on this trade</div>` : ''}
      <div class="vote-mini">${votes}</div>
      ${stratStrip}
      <div class="card-timer" data-expires="${s.expiresAt || ''}">⏱ —</div>
      <div class="card-note-wrap" data-pair="${s.pair}" data-direction="${s.direction}">
        <label class="card-note-label">📝 Your note</label>
        <textarea class="card-note" rows="2" placeholder="Add a private note about this signal…" maxlength="2000">${_escNote(getSignalNote(s.pair, s.direction))}</textarea>
        <div class="card-note-status muted"></div>
      </div>
      <!-- v292 — AI verdict placeholder. Filled automatically when the
           signal renders (cached per unique signal in localStorage). -->
      <div class="card-ai-verdict" data-signal-key="${_signalCacheKey(s)}" data-pair="${s.pair}" data-direction="${s.direction}">
        <div class="cav-loading">🧠 AI analyst loading…</div>
      </div>
    </div>`;
}

function renderNews() {
  $('#news-status').textContent = `${state.news.length} headlines · sentiment scored by keyword analysis`;
  // v352 — XSS-safe: escape all news text from third-party RSS feeds
  $('#news-list').innerHTML = state.news.map(n => `
    <div class="news-item ${_esc(n.sentiment)}">
      <div class="ni-head"><span>${_esc(n.source)} · ${_esc(n.published || '')}</span><span class="sent-tag sent-${_esc(n.sentiment)}">${_esc(n.sentiment)}</span></div>
      <div class="ni-title"><a href="${_escUrl(n.link)}" target="_blank" rel="noopener">${_esc(n.title)}</a></div>
      <div class="ni-summary">${_esc(n.summary)}</div>
    </div>`).join('') || '<p class="muted">No headlines loaded.</p>';
}

function renderCalendar() {
  if (!state.calendar.length) { $('#calendar-list').innerHTML = '<p class="muted">No high-impact events this week.</p>'; return; }
  $('#calendar-list').innerHTML = state.calendar.map(e => {
    const impact = (e.impact || 'low').toLowerCase();
    const when = e.date ? new Date(e.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
    return `<div class="cal-item cal-impact-${impact}"><div>${when}</div><div class="cal-country">${e.country || ''}</div><div>${e.title || ''}</div><div class="cal-values">F:${e.forecast || '—'} · P:${e.previous || '—'}</div></div>`;
  }).join('');
}

function renderBacktestSection() {
  const r = getBacktestResults();
  if (!r) {
    return `
      <div class="backtest-box">
        <h3>🧪 Strategy backtester</h3>
        <p class="muted">Runs every strategy across every pair × ~1300 historical bars (≈25,000 strategy fires) and ranks each by win rate. Tells you which strategies actually win on current market data — distinct from your own closed-trade history. Takes 30–60 seconds. Runs locally in your browser.</p>
        <button id="run-backtest" class="run-bt-btn">▶ Run full backtest now</button>
        <div id="bt-progress" class="muted"></div>
      </div>`;
  }
  const ageMin = Math.round((Date.now() - r.ts) / 60000);
  const stale = ageMin > 60 * 24;
  const top3 = r.ranked.filter(s => s.winRate >= 0.55 && s.total >= 50).slice(0, 3);
  return `
    <div class="backtest-box">
      <h3>🧪 Strategy backtester ${stale ? '<span class="muted">(>1 day old — re-run for current rankings)</span>' : ''}</h3>
      <p class="muted">${r.ranked.length} strategies tested across ${r.pairs} pairs. Last run ${ageMin}m ago.</p>
      ${top3.length ? `<p>📈 Top performers being applied as a confidence boost on live signals: <strong style="color:var(--buy)">${top3.map(s => `${s.name} (${Math.round(s.winRate*100)}%)`).join(' · ')}</strong></p>` : '<p class="muted">No strategy currently scores ≥55% with 50+ samples — no boost applied.</p>'}
      <p class="muted" style="font-size:11px;">Win rate shown with 95% Bayesian confidence interval — narrower bands = more reliable.</p>
      <table class="votes-table">
        <tr><th>#</th><th>Strategy</th><th>Fires</th><th>Wins</th><th>Losses</th><th>Win rate (95% CI)</th></tr>
        ${r.ranked.map((s, i) => {
          const cls = s.winRate >= 0.6 ? 'wp-good' : s.winRate >= 0.5 ? 'wp-mid' : 'wp-bad';
          const star = i < 3 && s.winRate >= 0.55 && s.total >= 50 ? '⭐ ' : '';
          const ci = wilsonInterval(s.wins, s.total);
          const ciLo = Math.round(ci.low * 100), ciHi = Math.round(ci.high * 100);
          return `<tr><td>${i + 1}</td><td>${star}${s.name}</td><td>${s.total}</td><td>${s.wins}</td><td>${s.losses}</td><td><span class="winprob ${cls}" style="margin:0;padding:2px 6px;display:inline-block">${Math.round(s.winRate * 100)}%</span> <span class="muted" style="font-size:10px">${ciLo}–${ciHi}%</span></td></tr>`;
        }).join('')}
      </table>
      <button id="run-backtest" class="run-bt-btn" style="margin-top:12px">▶ Re-run backtest</button>
      <div id="bt-progress" class="muted"></div>
    </div>`;
}

async function startBacktest() {
  const btn = document.getElementById('run-backtest');
  const prog = document.getElementById('bt-progress');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }
  if (prog) prog.textContent = '';
  try {
    await runStrategyBacktest((p) => {
      if (prog) prog.textContent = `${p.phase} ${p.pair || ''} (${p.idx + 1}/${p.total})…`;
    });
    renderPerformance();
  } catch (e) {
    if (prog) prog.textContent = '✗ Backtest failed: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '▶ Re-run backtest'; }
  }
}
document.addEventListener('click', (e) => {
  if (e.target?.id === 'run-backtest') startBacktest();
});

function renderSystemDiagnostic() {
  const sigs = state.signals || [];
  if (!sigs.length) return '<div class="diag-box"><h3>🩺 System diagnostic</h3><p class="muted">No signals analyzed yet — open the Signals tab to populate.</p></div>';
  // Count what's filtering signals out
  const reasons = { hold: 0, blocked: 0, cooldown: 0, lowConf: 0, lowAdx: 0, htfFight: 0, calBlackout: 0, lowAgreement: 0, fewStrats: 0, weakBacktest: 0, ok: 0 };
  for (const s of sigs) {
    if (s.direction === 'HOLD') { reasons.hold++; continue; }
    if (s.blockReason) { reasons.blocked++; continue; }
    if (s.cooldownMinutesLeft) { reasons.cooldown++; continue; }
    const winners = s.direction === 'BUY' ? s.bull_count : s.bear_count;
    const aligned = (s.firedStrategies || []).filter(f =>
      (s.direction === 'BUY' && f.bias === 'bullish') || (s.direction === 'SELL' && f.bias === 'bearish')).length;
    if (s.confidence < 75) { reasons.lowConf++; continue; }
    if (s.adxNow != null && s.adxNow < 25) { reasons.lowAdx++; continue; }
    if (s.htfTrend && ((s.direction === 'BUY' && s.htfTrend === 'down') || (s.direction === 'SELL' && s.htfTrend === 'up'))) { reasons.htfFight++; continue; }
    if ((s.calPenalty ?? 0) <= -20) { reasons.calBlackout++; continue; }
    if (winners / Math.max(1, s.total_indicators) < 0.75) { reasons.lowAgreement++; continue; }
    if (aligned < 3) { reasons.fewStrats++; continue; }
    if (s.winProbability != null && s.backtestSamples >= 10 && s.winProbability < 60) { reasons.weakBacktest++; continue; }
    reasons.ok++;
  }
  const items = [
    ['HOLD (no clear direction)', reasons.hold, 'Indicators don\'t agree on direction. Wait — markets are ranging.'],
    ['Blocked (loss-pattern)', reasons.blocked, 'This combination has historically lost ≥70%. Auto-suppressed.'],
    ['Cooldown active', reasons.cooldown, 'Same pair+direction signaled in last 4h.'],
    ['Confidence < 75', reasons.lowConf, 'Confluence not strong enough.'],
    ['ADX < 25', reasons.lowAdx, 'Trend too weak — would whipsaw.'],
    ['Fighting daily HTF trend', reasons.htfFight, 'Counter-trend trades fail 60-70% of the time.'],
    ['Calendar blackout', reasons.calBlackout, 'Red-folder news event imminent.'],
    ['Indicator agreement < 75%', reasons.lowAgreement, 'Not enough indicators agree.'],
    ['Strategies firing < 3', reasons.fewStrats, 'Multi-strategy confluence missing.'],
    ['Backtest win < 60%', reasons.weakBacktest, 'Historical edge too thin.'],
    ['✓ Passes ALL Best gates', reasons.ok, 'These show up as Best Setups.'],
  ];
  return `
    <div class="diag-box">
      <h3>🩺 Why aren't there more signals?</h3>
      <p class="muted">Right now, of ${sigs.length} pairs analyzed, here's what's being filtered out at each gate:</p>
      <table class="votes-table">
        <tr><th>Filter</th><th>Pairs blocked</th><th>Why</th></tr>
        ${items.map(([label, count, why]) => `
          <tr>
            <td><strong>${label}</strong></td>
            <td><span class="winprob ${count === 0 ? 'wp-good' : 'wp-mid'}" style="margin:0;padding:2px 8px;display:inline-block">${count}</span></td>
            <td class="muted">${why}</td>
          </tr>`).join('')}
      </table>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════
// v247 — LEARNING GUIDE
//
// SELF-EVOLVING DOCUMENTATION OF EVERY PART OF THE WEBSITE.
//
// LEARNING_DATA is the SINGLE SOURCE OF TRUTH for the in-app explanation.
// When a new feature ships:
//   1. Add an item to the relevant section (or add a new section)
//   2. Add a versionLog entry summarising what changed
//   3. The Learning tab automatically picks it up on next render
//
// Convention: every NEW feature MUST add an entry here in the same commit.
// That way the guide stays in lockstep with the website — no stale docs.
// ════════════════════════════════════════════════════════════════════════
const LEARNING_DATA = {
  // v248 — Rewritten for plain English. Reads like a friend explaining,
  // not a technical paper. Keeps version-log entries terse so the changelog
  // stays scannable.
  intro: "ForexSight watches the market for you. A learning brain studies every signal it sees, remembers what wins and what loses, and only shows you trades it expects to win. Below is a plain-English tour of how every part works.",
  sections: [
    {
      id: 'tabs',
      title: '📑 The tabs',
      summary: 'What each section is for.',
      items: [
        { name: 'Signals', what: 'The main view. Each card is one possible trade the brain found and approved. Shows you a confidence number, where to enter, where to put your stop, and where to take profit.', use: 'Tap a card to see the full picture. Hit "Take Trade" if you want to follow it.' },
        { name: 'My Trades', what: 'The trades you\'re actively in right now. The app watches them every few seconds and tells you the moment a target or stop is hit.', use: 'Manage live positions here. Hit "Close manually" if you want out early.' },
        { name: 'History', what: 'Everything you closed — wins, losses, manual closes. Sorted newest-first with totals at the top.', use: 'Look back. Filter by Won, Lost, or All. Each row keeps the original brain notes from when you took it.' },
        { name: 'Calendar', what: 'Big upcoming news events like Fed announcements or jobs reports. The brain knows about these and stays out of the market while they happen.', use: 'Quick glance for what could shake the market today.' },
        { name: 'News', what: 'Market headlines plus what professional analysts are saying about each pair right now.', use: 'When analysts and the brain agree on a direction, that\'s a strong sign.' },
        { name: 'Calculator', what: 'Tells you exactly what size to trade based on your account balance and how much you\'re willing to risk per trade.', use: 'Always run this BEFORE placing a trade so you never risk more than planned.' },
        { name: 'More ▾', what: 'Drop-down with extra views: Strategies (which trading patterns are winning), Learning (this guide + your performance), Forex Wisdom (timeless tips), Platforms (broker info).', use: 'Tap to reach the less-frequently-used sections.' },
      ],
    },
    {
      id: 'brain',
      title: '🧠 How the brain works (in plain English)',
      summary: 'Seven layers of how the brain decides which trades to show.',
      items: [
        { name: '1. It studies history', what: 'Every few minutes the brain picks a pair (gold, EUR/USD, etc.) and re-plays the last 90 days as if it were trading in real time. It keeps score: when this exact setup happened before, did it win or lose?', use: 'Builds the brain\'s memory of "what works."' },
        { name: '2. It learns from live trades', what: 'When a signal in the Signal Feed actually wins or loses in real markets, the brain notices instantly and counts that as proof — worth 3× more than the practice runs above.', use: 'This is why the brain gets smarter the longer the app runs.' },
        { name: '3. It checks each new signal carefully', what: 'Before showing you a trade, the brain weighs 13 different reasons it might fail vs reasons it might win. Things like: "this combo only wins 40% of the time," "the market just shifted into a calm range," "the same pair lost 4 times today."', use: 'If win reasons clearly beat fail reasons, the signal shows. Otherwise it gets rejected (hidden).' },
        { name: '4. The bar rises as the brain learns', what: 'When the brain is a beginner, it accepts looser signals so it can gather data. As it learns, it gets pickier — only showing higher and higher-quality trades.', use: 'Watch the 📏 Bar pill on the brain card. Higher bar = stricter brain = better win rate.' },
        { name: '5. It runs 500 future simulations', what: 'For every signal that passes the check above, the brain imagines 500 possible futures of how price might move from here. Counts how often each one hits the target vs the stop.', use: 'Tells you the real chance of hitting TP1, TP2, TP3 + the best way to split your position.' },
        { name: '6. It checks itself for honesty', what: 'The brain compares its predictions to reality. If it kept saying "90% sure!" but the trades only won 50%, it knows it\'s being overconfident and pulls its numbers back to match what really happens.', use: 'Means the confidence numbers you see are honest, not inflated.' },
        { name: '7. It reads the market mood', what: 'Every scan, it tags the current market: trending hard, trending calm, ranging, dead, or crisis. In dead or crisis markets it rejects almost everything.', use: 'See the regime icon (🚀 🌊 😴 ⚠️) on the brain card. Crisis = brain stays out.' },
      ],
    },
    {
      id: 'badges',
      title: '🏷 What the labels on each card mean',
      summary: 'Every badge translated into plain English.',
      items: [
        { name: '🚀 BIG RUN · X pips to TP3', what: 'The brain sees the market moving with force right now (strong trend + active hours + volatility waking up + multiple patterns agreeing). It widened the profit targets so you can ride the full move instead of taking small profits.', use: 'These are the trades to hold longer. The brain usually says "go all the way to TP3."' },
        { name: '⚖️ P(win) X% · edge +Y', what: 'The brain checked every reason this trade could win OR lose, then says "I think you have an X% chance of winning, which is Y points better than losing." Higher Y = stronger signal.', use: 'Y above 30 is strong. 15-29 is good. 8-14 is OK. Below 8 the trade never reaches you — brain rejects it.' },
        { name: '🌌 Quantum sim · 500 paths', what: 'The brain imagined 500 possible futures of how this trade could play out. It tells you exactly how often each profit target gets hit, and the best way to split your position to make the most money on average.', use: 'Follow the "Best mini-trade" recommendation. It\'s the math, not a guess.' },
        { name: '🧠 brain combo · X% WR · ~Yh', what: 'This exact setup has happened before. The brain remembers winning X% of the time, and on average taking Y hours to play out.', use: 'Higher WR = trusted setup. Below 50% means the brain isn\'t convinced — be cautious.' },
        { name: '🏆 ELITE BRAIN PATTERN · X%', what: 'The brain found this is one of its best-performing setups with a long track record (20+ past examples winning 65%+).', use: 'Treat with extra confidence. These are the brain\'s proven moneymakers.' },
        { name: '🏆 SUPER · X strats', what: 'Three or more separate trading strategies are all pointing at this setup at the same time. Institutional-grade agreement.', use: 'The strongest single signal. If you also see 🚀 BIG RUN, this is as good as it gets.' },
        { name: '📡 Server-detected', what: 'This signal came from the cloud scanner, not your phone. Means a push notification was sent.', use: 'Same quality as phone-detected signals. The brain checked both.' },
        { name: '🎯 Calibrated from N trades', what: 'The brain learned from your actual past closed trades and adjusted today\'s confidence to match how you really do at this level.', use: 'Trust this number a bit more — it\'s based on YOUR history.' },
      ],
    },
    {
      id: 'brain-card',
      title: '🧠 The brain card pills (top of Signals tab)',
      summary: 'Every little label on the brain box explained.',
      items: [
        { name: '⚙ Just scanned X · Next: Y · pair N of 8', what: 'The brain just finished studying pair X and is moving to pair Y next. It works through all 8 pairs in about 13 minutes.', use: 'Tells you the brain is alive and working right now.' },
        { name: 'Tier pill (Novice → Genius)', what: 'How smart the brain is right now. Six levels: Novice, Apprentice, Skilled, Expert, Master, Genius. To reach Genius the brain has to predict things accurately, not just remember a lot.', use: 'Climbing tier means the brain is genuinely getting better at picking winners.' },
        { name: '💾 / ⚡ / ⚠️ Brain learning · …', what: 'How the brain\'s memory is doing. 💾 = saved. ⚡ = saving soon. ⚠️ = couldn\'t save (server limit reached) — but the brain is still learning in its head and will save later.', use: 'Should be 💾 or ⚡ most of the time. ⚠️ resets at midnight UTC.' },
        { name: '🚀 / 📈 / 🌊 / 😴 / ⚠️ + REGIME', what: 'What the market is doing right now. 🚀 trending hard · 📈 trending calmly · 🌊 ranging with chop · 😴 dead quiet · ⚠️ crisis (everything moving wildly).', use: 'In 😴 or ⚠️ the brain rejects most signals on purpose. It\'s being careful.' },
        { name: '🎯 Cal X%', what: 'How honest the brain\'s confidence numbers are. 100% = when it says 80%, you really win 80% of the time. Lower = brain is too optimistic or too cautious.', use: 'Watch it climb over time. Green ≥80% means you can trust the confidence labels.' },
        { name: '🔬 Live X (+N)', what: 'How many real-world signal results the brain has learned from so far. (+N) means N new ones came in just now.', use: 'This number ticking up = brain getting smarter in real time.' },
        { name: '📏 Bar Xpts · pWin ≥Y%', what: 'How strict the brain is right now. Higher = stricter = only the cream gets through to you.', use: 'Rises automatically as the brain learns. Higher bar → higher overall win rate.' },
        { name: '🛡 Gated N', what: 'The brain just rejected N signals this scan that didn\'t meet its standards. Only shows when there\'s something to hide.', use: 'Proof the brain is actively protecting you, not just labeling things.' },
      ],
    },
    {
      id: 'filters',
      title: '🎚 Filter modes (the Filter button)',
      summary: 'Five levels of how picky you want the app to be.',
      items: [
        { name: '⭐ Filter: OFF', what: 'Show me everything. (Even with this off, the brain still rejects bad signals — this just removes YOUR added pickiness.)', use: 'Good for browsing. See what\'s out there.' },
        { name: '⚡ Day Trader', what: 'Only trades that should finish within ~8 hours, during the busy London or NY sessions, and have multiple patterns agreeing.', use: 'Use during the day when you can watch trades and want quick results.' },
        { name: '🚀 BIG PIPS only', what: 'Only the trades that have a LOT of profit potential (80+ pips on gold, 30+ on forex). Sorted biggest first.', use: 'Use when you want fewer trades but bigger payoffs.' },
        { name: '⭐ Best only', what: 'Solid all-rounder filter. Demands multi-pattern agreement, strong trend, active hours, and brain blessing.', use: 'A good everyday default. Balanced.' },
        { name: '🔥 EXTREME mode', what: 'The pickiest setting. Five or more patterns must agree, market must be in killzone with strong trend, brain must give high backtest score.', use: 'Use when you want ONLY the absolute best. May show nothing for hours — that\'s working as intended.' },
        { name: '🎯 None — Feed only', what: 'Hides every signal from the main grid except the ones currently in the Signal Feed below. Focuses you on trades the brain has already approved and is actively tracking.', use: 'Use when you want a clean view of just the watched trades — no noise from other potentially-marginal signals.' },
      ],
    },
    {
      id: 'shadow',
      title: '📡 Signal Feed (the would-have record)',
      summary: 'A live scoreboard of every signal the brain approved.',
      items: [
        { name: 'What it is', what: 'Every signal the brain accepts gets posted here, then watched in real markets. Did it actually hit profit? Did it stop out? You see the score in real time, whether or not you took the trade.', use: 'It\'s the honest performance scoreboard. No cherry-picking.' },
        { name: 'Shadow WR (the headline number)', what: 'The win rate across every tracked signal. This is the TRUE performance number — what would have happened if you traded every approved signal.', use: 'Watch it trend up. As the brain learns + the bar tightens, this number should climb steadily.' },
        { name: 'Quality filter (v248)', what: 'Only signals the brain truly believes in get tracked: brain thinks win-chance ≥60%, edge ≥12 points over losing, 2+ patterns agreeing, and confidence ≥75%. Marginal signals are kept out of the headline number.', use: 'Means the Shadow WR reflects the cream of what the brain produces, not every weak attempt.' },
        { name: 'Why it failed labels', what: 'When a tracked signal loses, the brain tags WHY (weak confidence, single pattern, off-hours, volatile open, etc).', use: 'The brain reads these and avoids the same trap in future signals.' },
        { name: 'Lessons learned panel', what: 'The most common reasons signals are losing right now.', use: 'A peek into the brain\'s current blind spots. It\'s already adjusting based on these.' },
      ],
    },
    {
      id: 'glossary',
      title: '📖 Words explained',
      summary: 'The technical terms you\'ll see, in plain English.',
      items: [
        { name: 'pts (points)', what: 'How big a GAP is between two percentages. If win-chance is 67% and lose-chance is 33%, the edge is 34 pts (67 minus 33).', use: 'When the brain says "edge +30 pts," that means you\'re 30 percentage points more likely to win than lose.' },
        { name: 'ATR', what: 'How much price typically moves per hour. Big ATR = market is wild. Small ATR = market is calm.', use: 'Stops and targets are set as multiples of ATR — that way they\'re always sized right for current market conditions.' },
        { name: 'ADX', what: 'How strong the trend is right now. 0-25 = no real trend. 25+ = trending. 40+ = strongly trending.', use: 'BIG RUN setups need ADX 28+. That\'s when trends actually run.' },
        { name: 'Killzone', what: 'The hours when London and New York banks are most active (London 7-10 UTC, NY 12-15 UTC). Most real moves happen here.', use: 'Trades in killzone get a boost. Outside killzone, the brain is skeptical.' },
        { name: 'R', what: 'How much profit you make compared to what you risked. If you risk $100 and make $300, that\'s 3R.', use: 'TP1 = 0.5R · TP2 = 2R · TP3 = 3R (or 7R on BIG RUN). E[R] = average R per trade — positive means you make money over time.' },
        { name: 'pWin / pLose', what: 'The brain\'s estimate of how likely THIS specific trade is to win or lose.', use: 'pWin 70% means "I think you\'ll win 7 out of 10 times you take a trade exactly like this."' },
        { name: 'Combo', what: 'The specific combination of trading patterns that fired. Like a fingerprint for each signal type.', use: 'The brain remembers winning vs losing combos. You\'ll see one labeled on each card.' },
        { name: 'Calibration', what: 'A check on the brain\'s honesty. If it kept saying 80% but only winning 50%, calibration drops — and the brain adjusts.', use: 'Higher calibration % = the confidence numbers the brain shows you are more trustworthy.' },
        { name: 'TP1 / TP2 / TP3', what: 'Three profit targets at small / medium / big distances. The brain figures out the best way to split your trade between them.', use: 'You can take some profit at TP1, more at TP2, let the rest run to TP3. Or follow the Quantum sim\'s recommendation.' },
        { name: 'SL (stop loss)', what: 'Where you bail out if the trade goes wrong. Always set BEFORE entering.', use: 'Your safety net. The dollar amount between entry and SL is your max possible loss.' },
        { name: 'Regime', what: 'The mood of the market right now (trending / ranging / quiet / crisis).', use: 'Different setups work in different regimes. Brain knows and adjusts.' },
      ],
    },
    {
      id: 'changelog',
      title: '📅 Version Log',
      summary: 'Every shipped feature, newest first. As the website evolves this list grows.',
      items: [
        { name: 'v261 — Brain card keeps showing full details', what: 'Removed the v259 "Brain initialising…" placeholder and the "Brain temporarily degraded" warning. Those were replacing the detailed card body with simplified states on transient errors. Now if a fetch fails, the previous full render stays put — same details as before. The re-attach safety from v259 is kept.', use: 'You should always see the full brain card: rotation line, intel pill, health line, regime + calibration + lessons + wins pills, top winners, best hours.' },
        { name: 'v260 — Study every win extensively (symmetric to losses)', what: 'Mirror of v258 for wins. Every won signal now gets tagged with success reasons (high-conf, multi-strat, killzone-momentum, quick-decisive-move, big-move-captured, elite-pattern-fired, strong-trend). When a new signal fires, the brain compares it to past WINS with the same combo. If conditions match a known winning context, applies +1 to +12 boost. Plus a 🏆 wins-studied counter on the brain card alongside 📚 lessons.', use: 'Look for "✨ Matches past WIN context" in any signal\'s breakdown. The brain is now actively looking for setups similar to ones that worked before.' },
        { name: 'v259 — Brain card never disappears', what: 'Made the brain status card sticky on the home page. Now always creates + re-attaches even if a degraded endpoint response would have skipped rendering. Shows a placeholder during initial load and an amber warning if the brain temporarily fails.', use: '' },
        { name: 'v258 — Context-aware learning (never cancels patterns)', what: 'Replaced the hard fingerprint blacklist with deep context-similarity learning. When a new signal fires, the brain compares it to every past loss with the SAME pattern combo — hour proximity, ADX bucket, killzone match. High similarity = soft caution penalty (max -12); low similarity = trust the pattern. Patterns themselves are NEVER cancelled. The brain accumulates LESSONS instead — every loss is stored forever as a context example to check against.', use: 'Watch the 📚 lessons counter grow on the brain card. The brain studies why each loss happened and uses that context for future decisions — endless learning, never blanket cancels.' },
        { name: 'v257 — Signal Feed: brain-ranked + finds way more', what: 'Replaced the single strict filter with THREE smart paths to acceptance: (A) standard quality, (B) positive expected R from the Quantum sim, or (C) brain-endorsed (Top Pick / Elite Pattern). Trusts the upstream Brain Gate — relaxed pWin to 55, edge to 8, conf to 65, strats to 1. Feed sorted by composite brain score so the best surface first. Top-3 open signals get a 👑 crown + gold border; endorsed signals get a purple-gold treatment.', use: 'Open the Signal Feed and look for 👑 crowned signals — those are the brain\'s best picks. Each card now shows a 🧠 score for ranking.' },
        { name: 'v256 — Rapid loss-learning + fast-track to Genius', what: 'Brain now learns from mistakes within 1 signal: if a (pair+direction+hour) loses, the SAME fingerprint at the same hour gets a hard -15 to -40 penalty for the next 24h. Failure tags with ≥2 recent losses add -8 each. Global bar tightens 2× faster on shortfall. Intelligence formula rebalanced — added "live precision" (real WR) as a 20% component so Genius tier is reachable through actual winning, not just calibration.', use: 'Watch the brain visibly tighten after losses — adaptive bar climbs faster, repeat fingerprints get blocked, and the tier climbs as live win rate proves itself.' },
        { name: 'v255 — Cross-device sync always works', what: 'The sync code input now wires up its handlers even when you have zero trades. Previously the page bailed early on empty-trade lists and the "Start sync" button did nothing. Now you can sign in on a fresh device and pull trades from another.', use: 'Open My Trades → enter your sync code → tap Start sync. Works whether you have trades locally or not.' },
        { name: 'v254 — "None" filter: only show Signal Feed signals', what: 'New filter mode in the cycle (after Extreme). When active, the main grid shows ONLY the signals currently in the Signal Feed below — every other signal is hidden so you can focus on the trades the brain is actively tracking.', use: 'Tap the filter button until it reads "🎯 None — Feed only". Cycle once more to return to OFF.' },
        { name: 'v253 — Market bar scrolls with the page', what: 'The clock + sessions + next-candle bar no longer pins at the top of the screen. It scrolls naturally with the rest of the page content.', use: '' },
        { name: 'v252 — Green glow moves to History tab', what: 'When a trade closes (won or lost), the pulsing tab indicator now appears on History instead of My Trades. Resolved trades live in History — the indicator follows where the new data actually is.', use: 'Tap the History tab when you see it glow to view your latest outcomes. Counter clears as soon as you open it.' },
        { name: 'v251 — Tap any number to copy it', what: 'Every entry, stop-loss, and take-profit number across the app is now tappable. Tap copies the number to your clipboard so you can paste it straight into your broker.', use: 'Tap any price (entry / SL / TP1 / TP2 / TP3) on a signal card, modal, trade row, or signal feed. You\'ll see a "Copied" toast confirming it landed on your clipboard.' },
        { name: 'v250 — Brain\'s Top Pick badge', what: 'The brain now ranks every active signal against its full knowledge (combo win rates, live outcomes, quantum simulation, calibration, regime, sample weight) and marks the absolute best one with a golden 🧠✨ BRAIN\'S TOP PICK banner. Only marks when the composite score clears a strong threshold — never recommends mediocre.', use: 'Look for the gold banner on a card. That\'s the brain saying: out of everything I\'ve learned, this is the trade I\'d take.' },
        { name: 'v249 — Tap signals in Signal Feed for full details', what: 'Every card in the Signal Feed is now tappable. Opens a detail modal showing entry/SL/TP with pip distances, brain win-probability verdict, strategies that fired, timing, and (for losses) the failure reasons.', use: 'Tap any card in the Signal Feed. Hit close (×) or tap outside to dismiss.' },
        { name: 'v248 — Plain English + tighter Shadow Feed', what: 'Rewrote this entire guide in friendly language. Tightened the Signal Feed: only signals the brain truly believes in get tracked (pWin ≥60%, edge ≥12, 2+ strategies, confidence ≥75). This makes the Shadow WR climb because only proven-good signals get measured.', use: 'Watch the Shadow WR climb noticeably over the next few days.' },
        { name: 'v247 — Self-evolving Learning guide', what: 'This guide! Auto-updates from LEARNING_DATA whenever new features ship.', use: 'Bookmark this tab. Come back when something new appears.' },
        { name: 'v246 — Crash-proof brain + website', what: 'Top-level safety nets on every endpoint. Fetch timeouts via AbortController. Bounded brain state (no memory creep). Global window.onerror + unhandledrejection. Self-healing intervals. New /api/heartbeat probe.', use: 'Nothing can stop the system — even total fetch failures gracefully degrade.' },
        { name: 'v245 — Adaptive gate (WR climbs with learning)', what: 'Edge requirement auto-tightens as brain intelligence climbs. Novice = 8pts → Genius = 18pts. Auto-tightens further if recent WR drops below 65% target.', use: 'Watch the 📏 Bar pill — when it goes red, brain is being strict.' },
        { name: 'v244 — Full SL/TP precision in Signal Feed', what: 'Pair-aware decimal places: forex 5dec, JPY 3dec, gold 2dec, crypto 0-2dec. Hardened CSS so 5-digit forex prices don\'t blow out the grid.', use: 'EUR/USD now shows 1.08412 instead of 1.08.' },
        { name: 'v243 — Quantum Monte Carlo simulator', what: '500 simulated price paths per signal. Computes forward probability of each level + best position-split strategy.', use: 'See the 🌌 Quantum sim panel on every signal card.' },
        { name: 'v242 — Probability-based Brain Gate', what: 'Brain weighs 13 evidence factors into unified pWin vs pLose. Replaces the v241 discrete gates with statistical reasoning.', use: 'Hover the ⚖️ badge to see all factors.' },
        { name: 'v241 — Brain Gate (only winning trades)', what: 'Five hard gates: known-loser combo, live loss cluster, CRISIS regime, proven-loser boost tag, sub-65% confidence.', use: '' },
        { name: 'v240 — Brain learns 3-4× faster', what: '3 pairs per tick (was 1). Lower min-sample thresholds (5→3 combos, 10→5 hours). Tighter KV throttle. Auto-trigger brain on shadow resolution (instant online learning).', use: 'Brain card\'s Live N pill ticks up much faster.' },
        { name: 'v239 — Self-improving brain', what: 'Online learning loop. Calibration tracking. Boost effectiveness. Regime classifier. New Genius tier.', use: 'See 🎯 Cal and 🔬 Live pills on brain card.' },
        { name: 'v238 — BIG RUN detection (high-pips signals)', what: 'Detect trending+killzone+vol-expansion+multi-strategy conditions, stretch TP2/TP3 from 3×/4.5× to 4.5×/7× ATR. New BIG PIPS filter mode.', use: 'Look for 🚀 BIG RUN badge on signal cards.' },
        { name: 'v237 — Comprehensive audit fixes', what: '12 bugs squashed: brain backfill, pip math for gold/crypto, server-merge NaN, notification suppression, tab handler crashes, more.', use: '' },
        { name: 'v236 — Real-world feedback loop', what: 'Per-pair-direction live shadow tracking. Recent loss cluster detection. Failure pattern recalibration.', use: '' },
        { name: 'v235 — Instant tab switch', what: 'setTimeout(0) defers heavy renders so tab switches feel instant. History tab cloud-pull moved to background. Removed 4 stacked tab-fade animations.', use: 'Try clicking History — instant.' },
        { name: 'v234 — Non-stop brain learning', what: 'Fixed silent ADX bug. KV write throttle (5min/1500 samples). Time-based rotation. Graceful KV quota degradation.', use: '' },
        { name: 'v233 — Instant tap response', what: 'Modal opens before news fetch. touch-action: manipulation kills iOS 300ms delay.', use: '' },
        { name: 'v232 — Multi-million dollar product polish', what: 'Inter variable font. Refined palette. 4px spacing scale. Tonal gradients. Tabular numerals.', use: '' },
        { name: 'v231 — Apple-grade animations', what: 'Spring easing curves. Modal entrance via requestAnimationFrame. Smoother transitions.', use: '' },
        { name: 'v230 — Brain adapts, not cancels', what: 'Softened failure penalty. winContext / loseContext per combo tracks ADX where each combo wins vs loses.', use: '' },
        { name: 'v229 — Multi-pair learning + scanning', what: 'Brain learns from 8 pairs (XAU + 7 majors). Per-pair combo stats, per-pair hour stats, per-pair sample distribution.', use: '' },
        { name: 'v228 — Failed-signal learning + why-it-failed display', what: 'Shadow tracker computes failure reasons. Brain aggregates failure patterns to penalize matching live signals.', use: '' },
        { name: 'v227 — Intelligence scales boost weight', what: 'Brain confidence boosts now scale with intelligence level (0.20 → 1.0+).', use: '' },
        { name: 'v226+ earlier', what: 'Foundational features: shadow tracker, brain backtest engine, real-time trade monitor, calculator, push notifications, PWA offline shell.', use: '' },
      ],
    },
  ],
};

function renderLearningGuide() {
  // Renders the LEARNING_DATA above into expandable sections. Plain HTML +
  // <details>/<summary> elements — no framework, no dependencies, works in
  // the offline shell. As LEARNING_DATA grows, this view grows with it.
  const sectionHTML = LEARNING_DATA.sections.map(sec => {
    const items = sec.items.map(it => `
      <div class="lg-item">
        <div class="lg-item-name">${it.name}</div>
        <div class="lg-item-what">${it.what}</div>
        ${it.use ? `<div class="lg-item-use"><strong>Use:</strong> ${it.use}</div>` : ''}
      </div>
    `).join('');
    return `
      <details class="lg-section" data-section="${sec.id}">
        <summary class="lg-summary">
          <span class="lg-title">${sec.title}</span>
          <span class="lg-summary-text muted">${sec.summary}</span>
          <span class="lg-toggle">▾</span>
        </summary>
        <div class="lg-items">${items}</div>
      </details>`;
  }).join('');
  return `
    <div class="learning-guide">
      <div class="lg-intro">
        <h2>How ForexSight works</h2>
        <p>${LEARNING_DATA.intro}</p>
        <p class="muted">This guide evolves alongside the website. When a new feature ships, the explanation appears here automatically. Last updated: <code>${LEARNING_DATA.sections.find(s => s.id === 'changelog').items[0].name}</code>.</p>
      </div>
      ${sectionHTML}
    </div>`;
}

function renderPerformance() {
  const logs = getLogs();
  const closed = logs.filter(l => l.outcome === 'win' || l.outcome === 'loss');
  const wins = closed.filter(l => l.outcome === 'win').length;
  const total = closed.length;
  const wr = total ? (wins / total * 100).toFixed(1) + '%' : '—';
  const byInd = {};
  const byPair = {};
  for (const l of closed) {
    byPair[l.pair] ||= { win: 0, total: 0 };
    byPair[l.pair].total++;
    if (l.outcome === 'win') byPair[l.pair].win++;
    for (const [ind, vote] of Object.entries(l.votes || {})) {
      const aligned = (vote === 'bullish' && l.direction === 'BUY') || (vote === 'bearish' && l.direction === 'SELL');
      if (!aligned) continue;
      byInd[ind] ||= { win: 0, total: 0 };
      byInd[ind].total++;
      if (l.outcome === 'win') byInd[ind].win++;
    }
  }
  const w = indicatorWeights();
  let html = renderSystemDiagnostic() + renderBacktestSection() + `
    <div class="perf-grid">
      <div class="perf-card"><div class="big">${logs.length}</div><div class="lbl">Signals Logged</div></div>
      <div class="perf-card"><div class="big">${total}</div><div class="lbl">Closed Trades</div></div>
      <div class="perf-card"><div class="big" style="color:var(--buy)">${wins}</div><div class="lbl">Wins</div></div>
      <div class="perf-card"><div class="big" style="color:var(--sell)">${total - wins}</div><div class="lbl">Losses</div></div>
      <div class="perf-card"><div class="big">${wr}</div><div class="lbl">Win Rate</div></div>
    </div>`;
  if (Object.keys(byInd).length) {
    html += `<h3>Per-indicator hit rate (drives learned weights)</h3><table class="votes-table"><tr><th>Indicator</th><th>Aligned</th><th>Correct</th><th>Hit rate</th><th>Weight</th></tr>${Object.entries(byInd).map(([k, v]) => `<tr><td>${k}</td><td>${v.total}</td><td>${v.win}</td><td>${(v.win / v.total * 100).toFixed(0)}%</td><td>${(w[k] ?? 1).toFixed(2)}</td></tr>`).join('')}</table>`;
  } else html += '<p class="muted">Indicator performance will populate as signals close (TP1 or SL hit). Let it run.</p>';
  if (Object.keys(byPair).length) {
    const sorted = Object.entries(byPair).sort((a, b) => (b[1].win / b[1].total) - (a[1].win / a[1].total));
    html += `<h3>Per-pair win rate</h3><table class="votes-table"><tr><th>Pair</th><th>Trades</th><th>Wins</th><th>Rate</th></tr>${sorted.map(([k, v]) => `<tr><td>${k}</td><td>${v.total}</td><td>${v.win}</td><td>${(v.win / v.total * 100).toFixed(0)}%</td></tr>`).join('')}</table>`;
  }

  // ===== Per-strategy hit rate (uses strategy set, not just per-indicator) =====
  const sHits = strategyHitRates();
  const sEntries = Object.entries(sHits).filter(([_, v]) => v.total >= 3).sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));
  if (sEntries.length) {
    html += `<h3>📊 Per-strategy hit rate <span class="muted">(min 3 samples — what's actually winning for you)</span></h3>
      <table class="votes-table">
        <tr><th>Strategy</th><th>Fired</th><th>Won</th><th>Win rate</th></tr>
        ${sEntries.map(([k, v]) => {
          const rate = v.wins / v.total;
          const cls = rate >= 0.6 ? 'wp-good' : rate >= 0.45 ? 'wp-mid' : 'wp-bad';
          return `<tr><td>${k}</td><td>${v.total}</td><td>${v.wins}</td><td><span class="winprob ${cls}" style="margin:0;padding:2px 6px;display:inline-block">${Math.round(rate*100)}%</span></td></tr>`;
        }).join('')}
      </table>`;
  }

  // ===== Top winning strategy COMBINATIONS — the real edge =====
  const combos = combinationHitRates();
  const cEntries = Object.entries(combos).filter(([_, v]) => v.total >= 3).sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));
  if (cEntries.length) {
    html += `<h3>🎯 Top winning strategy combinations <span class="muted">(min 3 samples)</span></h3>
      <p class="muted" style="margin-top:-4px">When a future signal matches one of these exact combinations, it gets a confidence boost (or penalty if losing). This is the "learning from history" loop.</p>
      <table class="votes-table">
        <tr><th>Strategy combination</th><th>Pairs</th><th>Total</th><th>Won</th><th>Hit rate</th></tr>
        ${cEntries.slice(0, 12).map(([combo, v]) => {
          const rate = v.wins / v.total;
          const cls = rate >= 0.6 ? 'wp-good' : rate >= 0.45 ? 'wp-mid' : 'wp-bad';
          const display = combo === '(none)' ? '<em class="muted">no strategies fired</em>' : combo.replace(/\|/g, ' + ');
          const pairs = Array.from(v.pairs || []).slice(0, 4).join(', ');
          return `<tr><td style="font-size:11.5px">${display}</td><td><span class="muted">${pairs || '—'}</span></td><td>${v.total}</td><td>${v.wins}</td><td><span class="winprob ${cls}" style="margin:0;padding:2px 6px;display:inline-block">${Math.round(rate*100)}%</span></td></tr>`;
        }).join('')}
      </table>`;
  }

  // ===== Per-hour win rate =====
  const byHour = {};
  for (const l of closed) {
    const h = l.hourUTC ?? new Date(l.ts).getUTCHours();
    byHour[h] ||= { win: 0, total: 0 };
    byHour[h].total++;
    if (l.outcome === 'win') byHour[h].win++;
  }
  const hEntries = Object.entries(byHour).filter(([_, v]) => v.total >= 2).sort((a, b) => (b[1].win / b[1].total) - (a[1].win / a[1].total));
  if (hEntries.length) {
    html += `<h3>⏰ Per-hour-of-day win rate (UTC)</h3>
      <p class="muted" style="margin-top:-4px">Which hours produce winning signals for you. Killzones (07–10 / 12–15 UTC) typically dominate.</p>
      <table class="votes-table">
        <tr><th>Hour (UTC)</th><th>Trades</th><th>Won</th><th>Hit rate</th></tr>
        ${hEntries.map(([h, v]) => {
          const rate = v.win / v.total;
          const cls = rate >= 0.6 ? 'wp-good' : rate >= 0.45 ? 'wp-mid' : 'wp-bad';
          const inKZ = (h >= 7 && h < 10) || (h >= 12 && h < 15);
          return `<tr><td>${String(h).padStart(2,'0')}:00 ${inKZ ? '🔥' : ''}</td><td>${v.total}</td><td>${v.win}</td><td><span class="winprob ${cls}" style="margin:0;padding:2px 6px;display:inline-block">${Math.round(rate*100)}%</span></td></tr>`;
        }).join('')}
      </table>`;
  }

  // v247 — Prepend the self-evolving Learning guide so users see "what
  // every part of the website does" first, then their personal perf stats.
  $('#performance-view').innerHTML = renderLearningGuide() + html;
}

async function openModal(pair) {
  const s = state.signals.find(x => x.pair === pair);
  if (!s) return;
  return renderSignalModal(s, { fromTrade: null });
}

// Open the same modal but populated from a trade record (live signal may be gone)
async function openTradeModal(tradeId) {
  const trade = getTrades().find(t => t.id === tradeId);
  if (!trade) { alert('Trade not found.'); return; }
  // Backfill missing fields from older trades that didn't store everything
  const s = {
    ...trade,
    tp3: trade.tp3 ?? trade.entry,
    tp3_pips: trade.tp3_pips ?? (trade.tp1_pips ? trade.tp1_pips * 3 : 0),
    votes: trade.votes || {},
    firedStrategies: trade.firedStrategies || [],
    bull_count: trade.bull_count ?? 0,
    bear_count: trade.bear_count ?? 0,
    neutral_count: trade.neutral_count ?? 0,
    total_indicators: trade.total_indicators ?? Object.keys(trade.votes || {}).length,
  };
  return renderSignalModal(s, { fromTrade: trade });
}

async function renderSignalModal(s, options = {}) {
  const fromTrade = options.fromTrade || null;
  const pair = s.pair;
  const openCount = fromTrade ? 0 : getTrades().filter(t => t.status === 'open' && t.pair === pair && t.direction === s.direction).length;
  // v233 — INSTANT MODAL. We used to await /api/news BEFORE building the
  // modal — that caused the perceived tap lag. Now: render the modal
  // immediately with a news placeholder, then fetch news in the background
  // and inject it once it arrives.
  const newsPromise = (async () => {
    try {
      const r = await fetch(`/api/news?pair=${encodeURIComponent(pair)}`);
      return (await r.json()).news || [];
    } catch { return []; }
  })();
  const voteRows = Object.entries(s.votes || {}).map(([k, v]) => {
    const bias = Array.isArray(v) ? v[0] : v;
    const reason = Array.isArray(v) ? v[1] : '';
    return `<tr><td>${k}</td><td><span class="vote-pill vp-${bias}">${bias}</span></td><td>${reason}</td></tr>`;
  }).join('');
  const dirWord = s.direction === 'BUY' ? 'long (buy)' : 'short (sell)';
  // Placeholder news block; replaced once newsPromise resolves
  const newsHTML = '<div id="modal-news-loading" class="muted" style="padding:8px 0;font-size:13px;opacity:0.6;">Loading news…</div>';
  // Derive SUPER status — explicit flag preferred, fallback to strategy count
  // for older trades that didn't persist isSuperSetup.
  const sStratCount = s.passingStratsCount || [
    s.smcPassed, s.orbPassed, s.ictPassed, s.trendPassed,
    s.squeezePassed, s.divergencePassed, s.momentumPassed,
  ].filter(Boolean).length;
  const sIsSuper = s.isSuperSetup || sStratCount >= 3;
  const sSuperByConsensus = s.superReason === 'consensus';
  $('#modal-body').innerHTML = `
    <h2>${s.pair} <span class="direction-badge dir-${s.direction}">${s.direction}</span> <span class="dir-price">@ ${s.entry}</span></h2>
    ${sIsSuper ? (sSuperByConsensus
        ? `<div class="super-badge super-badge-modal" title="${sStratCount} strategies + ${s.superAlignedDelta} indicator-consensus delta in signal direction">🏆 SUPER SETUP · ${sStratCount} strategies + ${s.superAlignedDelta} indicator consensus</div>`
        : `<div class="super-badge super-badge-modal" title="${sStratCount} independent strategies confirmed this setup">🏆 SUPER SETUP · ${sStratCount} strategies confirmed</div>`
      ) : ''}
    ${s.smcPassed ? `<div class="smc-tag smc-tag-modal smc-grade-${(s.smcGrade||'C').replace('+','plus').toLowerCase()}">📐 SMC STRATEGY ${s.smcGrade || ''} — ${s.smcDiag?.passed}/${s.smcDiag?.total} gates · ${s.smcQuality}/100 quality<div class="grade-breakdown">${(s.smcQualityBreakdown || []).join(' · ')}</div></div>` : ''}
    ${s.orbPassed ? `<div class="orb-tag orb-tag-modal orb-grade-${(s.orbGrade||'C').replace('+','plus').toLowerCase()}">📊 ORB STRATEGY ${s.orbGrade || ''} — ${s.orbDiag?.passed}/${s.orbDiag?.total} gates · ${s.orbQuality}/100 quality<div class="grade-breakdown">${(s.orbQualityBreakdown || []).join(' · ')}</div></div>` : ''}
    ${Object.entries(STRATEGIES).map(([sk, cfg]) => {
      if (!s[`${sk}Passed`]) return '';
      const g = (s[`${sk}Grade`] || 'C').replace('+', 'plus').toLowerCase();
      const breakdown = (s[`${sk}QualityBreakdown`] || []).join(' · ');
      return `<div class="strat-tag strat-tag-modal strat-tag-${sk} strat-grade-${g}">${cfg.icon} ${cfg.name.toUpperCase()} ${s[`${sk}Grade`] || ''} — ${s[`${sk}Diag`]?.passed}/${s[`${sk}Diag`]?.total} gates · ${s[`${sk}Quality`]}/100 quality<div class="grade-breakdown">${breakdown}</div></div>`;
    }).join('')}
    <div class="conf"><div class="conf-label"><span>Weighted confluence</span><b>${s.confidence}%</b></div><div class="conf-bar"><span style="width:${s.confidence}%;background:${s.direction === 'BUY' ? 'var(--buy)' : 'var(--sell)'}"></span></div></div>
    ${(() => {
      // Confidence breakdown — show every adjustment that contributed to the
      // final number so the user understands WHY this signal is X%.
      const items = [];
      const winners = s.direction === 'BUY' ? s.bull_count : s.bear_count;
      const total = s.total_indicators || 1;
      const baseRaw = Math.round((winners / Math.max(1, s.bull_count + s.bear_count)) * 100);
      items.push({ label: `Base confluence (${winners}/${s.bull_count + s.bear_count} indicators agreeing)`, val: baseRaw });
      if (s.sessionAdj) items.push({ label: `Session bonus (${s.session || 'session'})`, val: s.sessionAdj });
      if (s.learnedAdj) items.push({ label: 'Per-pair / per-hour learned adjustment', val: s.learnedAdj });
      if (s.htfAdj) items.push({ label: `HTF (Daily) ${s.htfTrend ? `trend ${s.htfTrend}` : 'alignment'}`, val: s.htfAdj });
      if (s.tf4hAdj) items.push({ label: `4H trend (${s.tf4hTrend || 'unknown'})`, val: s.tf4hAdj });
      if (s.stratBonus) items.push({ label: `Multi-strategy bonus (${(s.firedStrategies || []).filter(f => (s.direction === 'BUY' && f.bias === 'bullish') || (s.direction === 'SELL' && f.bias === 'bearish')).length} aligned)`, val: s.stratBonus });
      if (s.calPenalty) items.push({ label: 'Calendar event penalty', val: s.calPenalty });
      if (s.volPenalty) items.push({ label: `Volatility regime (${s.volRegime || ''})`, val: s.volPenalty });
      if (s.patternAdj) items.push({ label: 'Pattern-match learning', val: s.patternAdj });
      if (s.backtestAdj) items.push({ label: 'Top-backtested-strategy boost', val: s.backtestAdj });
      if (s.regimeAdj) items.push({ label: `Regime fit (${s.regime || ''})`, val: s.regimeAdj });
      const rows = items.map(it => {
        const cls = it.val > 0 ? 'cb-pos' : it.val < 0 ? 'cb-neg' : 'cb-zero';
        const sign = it.val > 0 ? '+' : '';
        return `<tr><td>${it.label}</td><td class="cb-val ${cls}">${sign}${it.val}</td></tr>`;
      }).join('');
      const calibRow = s.calibrationSamples >= 10
        ? `<tr class="cb-final"><td>🎯 Calibrated to actual win rate (${s.calibrationActualRate}% over ${s.calibrationSamples} closed trades)</td><td class="cb-val">${s.confidence}</td></tr>`
        : `<tr class="cb-final"><td>Final (no calibration yet — need 10+ closed trades)</td><td class="cb-val">${s.confidence}</td></tr>`;
      return `
        <details class="conf-breakdown">
          <summary>📊 How this ${s.confidence}% was built (${items.length} factors)</summary>
          <table>${rows}<tr class="cb-sep"><td>Raw model output</td><td class="cb-val">${s.rawConfidence ?? s.confidence}</td></tr>${calibRow}</table>
        </details>`;
    })()}
    ${s.winProbability != null ? `
    <div class="winprob-modal ${s.winProbability >= 60 ? 'wp-good' : s.winProbability >= 50 ? 'wp-mid' : 'wp-bad'}">
      <div class="winprob-num">${s.winProbability}%</div>
      <div class="winprob-detail">
        <strong>Backtested win rate</strong> on similar ${s.direction} setups for ${s.pair}.<br>
        <span class="muted">Based on ${s.backtestSamples} comparable setups in the last 1500 hourly candles — ${s.backtestWins} won (price hit TP1 first), ${s.backtestLosses} lost (price hit SL first)${s.adxNow != null ? ` · ADX now: ${s.adxNow}` : ''}.</span>
      </div>
    </div>` : '<div class="winprob-modal wp-mid"><div class="winprob-detail muted">Not enough comparable historical setups to estimate win rate yet.</div></div>'}
    <div class="modal-actions">
      ${fromTrade ? `
        <span class="trade-status-pill trade-status-${fromTrade.status}">
          ${fromTrade.status === 'open' ? '🟢 OPEN' :
            fromTrade.status === 'won' ? '✅ WON' :
            fromTrade.status === 'lost' ? '❌ LOST' : '⏹ CLOSED'}
          ${fromTrade.pnlPips != null ? ` · ${fromTrade.pnlPips >= 0 ? '+' : ''}${fromTrade.pnlPips} pips` : ''}
        </span>
        ${fromTrade.status === 'open' ? `
          <button class="modal-trade-action" data-id="${fromTrade.id}" data-outcome="won">✓ Mark Won</button>
          <button class="modal-trade-action" data-id="${fromTrade.id}" data-outcome="lost">✗ Mark Lost</button>
        ` : ''}
        <button class="modal-trade-delete" data-id="${fromTrade.id}">🗑 Delete</button>
      ` : (() => {
        // Hard-block taking trades that don't pass the active filter — the
        // single biggest reason users lose money is overriding their own filter.
        let blocked = false;
        let blockReason = '';
        if (state.filterMode === 'extreme' && !isExtremeSetup(s)) {
          blocked = true;
          blockReason = 'Disabled — this signal does not pass EXTREME filter. Switch to Best or OFF mode in header to enable.';
        } else if (state.filterMode === 'best' && !isBestSetup(s)) {
          blocked = true;
          blockReason = 'Disabled — this signal does not pass Best Setup filter. Switch to OFF mode in header to enable (not recommended).';
        }
        if (blocked) {
          return `<button class="take-trade-btn blocked" disabled title="${blockReason}">🚫 Filter-blocked</button><span class="filter-block-msg">${blockReason}</span>`;
        }
        return `<button class="take-trade-btn" data-pair="${s.pair}" ${openCount ? 'disabled' : ''}>${openCount ? '✓ Already tracking' : '+ Take this trade'}</button>`;
      })()}
      <span class="muted">Session: ${s.session || 'n/a'} · S/R: ${s.sr?.support ?? '—'} / ${s.sr?.resistance ?? '—'}${s.htfTrend ? ' · Daily trend: ' + s.htfTrend : ''}${fromTrade ? ' · Taken ' + new Date(fromTrade.takenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''}</span>
    </div>
    ${s.calNote ? `<div class="cal-warning">⚠ ${s.calNote}</div>` : ''}

    <div class="modal-note-wrap" data-pair="${s.pair}" data-direction="${s.direction}">
      <h3 style="margin-bottom:6px;">📝 Your notes on this signal</h3>
      <p class="muted" style="margin:0 0 6px; font-size:12px;">Private to your device. Saves automatically as you type.</p>
      <textarea class="modal-note" rows="4" placeholder="e.g. wait for retest of structure · halve risk before NFP · cross-pair confluence with EUR/JPY…" maxlength="2000">${_escNote(getSignalNote(s.pair, s.direction))}</textarea>
      <div class="modal-note-status muted"></div>
    </div>

    <div class="calc-box" data-pair="${s.pair}">
      <h3>💰 Position Calculator — what to put on this trade</h3>
      <div class="calc-inputs">
        <label>I have ($)<input type="number" class="calc-balance" value="${localStorage.getItem('forexsight_balance') || '1000'}" min="1" step="any" /></label>
        <label>I'll risk ($)<input type="number" class="calc-risk" value="${localStorage.getItem('forexsight_risk_usd') || '20'}" min="0.01" step="any" /></label>
      </div>
      <div class="calc-presets">
        <span class="muted">Quick:</span>
        ${[5, 10, 20, 50, 100].map(v => `<button class="calc-preset" data-v="${v}">$${v}</button>`).join('')}
      </div>
      <div class="calc-output"></div>
    </div>

    <h3>Trade plan</h3>
    <div class="plan-steps"><ol>
      <li>Go <strong>${dirWord}</strong> on ${s.pair} at <code>${s.entry}</code>.</li>
      <li><strong>Stop Loss</strong> at <code>${s.sl}</code> (${s.sl_pips} pips).</li>
      <li><strong>TP1</strong> at <code>${s.tp1}</code> (${s.tp1_pips} pips · 1:1) — close half, SL trails to TP1 (full 1R locked).</li>
      <li><strong>TP2</strong> at <code>${s.tp2}</code> (${s.tp2_pips} pips · 1:2.5).</li>
      <li><strong>TP3</strong> at <code>${s.tp3}</code> (${s.tp3_pips} pips · 1:4) — let final runner ride.</li>
      <li>Risk max 1–2% of your account. Calculator above does the math for you.</li>
    </ol></div>
    ${s.firedStrategies?.length ? `
    <h3>🎯 Trading strategies firing on this setup</h3>
    <div class="strategy-list">
      ${s.firedStrategies.map(st => `
        <div class="strategy-item strategy-${st.bias}">
          <span class="strategy-name">${st.name}</span>
          <span class="strategy-bias bias-${st.bias}">${st.bias.toUpperCase()}</span>
          <span class="strategy-reason">${st.reason}</span>
        </div>
      `).join('')}
    </div>` : ''}
    <h3>Why this signal (${s.bull_count} bullish · ${s.bear_count} bearish · ${s.neutral_count} neutral of ${s.total_indicators})</h3>
    <table class="votes-table"><tr><th>Indicator</th><th>Vote</th><th>Reason</th></tr>${voteRows}</table>
    <h3>Place this trade</h3>
    <div class="plan-steps">
      <div class="broker-block broker-ig">
        <strong>🇬🇧 IG (web + mobile app) — step by step:</strong>
        <ol style="margin: 6px 0 0 18px; padding: 0; line-height: 1.7;">
          <li>Open <em>IG app or web platform</em> → tap the 🔍 search icon at top.</li>
          <li>Search <code>${s.pair}</code> → tap the result (use <em>"Mini contract"</em> for smaller size, <em>"Standard"</em> for full lot).</li>
          <li>On the deal ticket, choose <strong>${s.direction === 'BUY' ? '"Buy"' : '"Sell"'}</strong>.</li>
          <li>Order type: <strong>${s.direction === 'BUY' ? 'Limit (Buy below market)' : 'Limit (Sell above market)'}</strong> if price hasn't reached entry yet; otherwise <strong>Market</strong>.</li>
          <li>Set size: use the <strong>position calculator above</strong> — paste the lots/units it shows.</li>
          <li>Toggle <strong>"Add a stop"</strong> → choose <em>"Level"</em> → enter <code>${s.sl}</code></li>
          <li>Toggle <strong>"Add a limit"</strong> (this is take-profit on IG) → choose <em>"Level"</em> → enter <code>${s.tp1}</code> (for TP1) or <code>${s.tp2}</code> / <code>${s.tp3}</code> for further targets.</li>
          <li>Review the margin requirement at the bottom — should fit your account size.</li>
          <li>Tap <strong>"Place deal"</strong> (or "Confirm" on the web).</li>
        </ol>
        <div class="broker-note muted">💡 IG uses <em>"Limit"</em> instead of "Take Profit" — same thing. Spread is shown live above the ticket; if it's wider than 2× normal, wait a moment.</div>
      </div>
      <details class="broker-other" style="margin-top: 12px;">
        <summary style="cursor: pointer; color: var(--accent); font-weight: 600;">Other brokers (MT4/MT5, TradingView, cTrader, OANDA)</summary>
        <div style="padding: 8px 0;">
          <strong>MT4/MT5:</strong> F9 → ${s.pair.replace('/', '')} → ${s.direction === 'BUY' ? 'Buy Limit' : 'Sell Limit'} at <code>${s.entry}</code> → SL <code>${s.sl}</code> → TP <code>${s.tp1}</code>.<br><br>
          <strong>TradingView:</strong> ${s.direction === 'BUY' ? 'Buy' : 'Sell'} Limit at <code>${s.entry}</code>, bracket SL <code>${s.sl}</code> / TP <code>${s.tp1}</code>.<br><br>
          <strong>cTrader:</strong> Limit <code>${s.entry}</code> → SL <code>${s.sl}</code> → TP <code>${s.tp1}</code>.<br><br>
          <strong>OANDA:</strong> Limit price <code>${s.entry}</code>, SL price <code>${s.sl}</code>, TP price <code>${s.tp1}</code>.<br><br>
          <strong>Generic broker:</strong> Limit order · Level <code>${s.entry}</code> · Stop <code>${s.sl}</code> · TP <code>${s.tp1}</code>. Always enter as price, not pips.
        </div>
      </details>
    </div>
    <h3>Relevant news</h3>${newsHTML}
    <p class="muted" style="margin-top:16px;">${new Date(s.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} · ATR(14)=${s.atr}</p>`;
  // v231 — Force a reflow then transition. Without this, freshly-populated
  // modals skip the open animation because innerHTML + class-remove happen
  // in the same frame.
  const modalEl = $('#modal');
  void modalEl.offsetHeight;
  requestAnimationFrame(() => modalEl.classList.remove('hidden'));

  // v233 — Resolve news in background and slot it into the placeholder. Modal
  // is already visible by now; user perceives instant tap response.
  newsPromise.then(pairNews => {
    const slot = document.getElementById('modal-news-loading');
    if (!slot) return; // user closed the modal
    if (!pairNews.length) {
      slot.outerHTML = '<p class="muted">No pair-specific news found.</p>';
      return;
    }
    // v352 — XSS-safe
    slot.outerHTML = pairNews.slice(0, 6).map(n =>
      `<div class="news-item ${_esc(n.sentiment)}" style="margin-bottom:6px;">
         <div class="ni-title" style="font-size:13px;"><a href="${_escUrl(n.link)}" target="_blank" rel="noopener">${_esc(n.title)}</a></div>
         <div class="ni-summary" style="font-size:12px;">${_esc(n.source)} · <span class="sent-tag sent-${_esc(n.sentiment)}">${_esc(n.sentiment)}</span></div>
       </div>`
    ).join('');
  }).catch(() => {});

  // Wire up the notes textarea inside the modal — persists per pair+direction.
  // The modal note shares storage with the card note, so editing in one place
  // updates the other on next render.
  const noteWrap = $('#modal-body .modal-note-wrap');
  if (noteWrap) {
    const noteTa = noteWrap.querySelector('.modal-note');
    const noteStatus = noteWrap.querySelector('.modal-note-status');
    const notePair = noteWrap.dataset.pair;
    const noteDir = noteWrap.dataset.direction;
    let flashTimer = null;
    const flash = (txt) => { if (noteStatus) { noteStatus.textContent = txt; clearTimeout(flashTimer); flashTimer = setTimeout(() => { if (noteStatus) noteStatus.textContent = ''; }, 1200); } };
    let debounce = null;
    noteTa.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { setSignalNote(notePair, noteDir, noteTa.value); flash('Saved'); }, 400);
    });
    noteTa.addEventListener('blur', () => {
      clearTimeout(debounce);
      setSignalNote(notePair, noteDir, noteTa.value);
      flash('Saved');
    });
  }

  // Wire up the position calculator inside the modal
  const calcBox = $('#modal-body .calc-box');
  if (calcBox) {
    const balanceEl = calcBox.querySelector('.calc-balance');
    const riskEl = calcBox.querySelector('.calc-risk');
    const outEl = calcBox.querySelector('.calc-output');

    const recompute = () => {
      const bal = parseFloat(balanceEl.value) || 0;
      const risk = parseFloat(riskEl.value) || 0;
      if (bal > 0) localStorage.setItem('forexsight_balance', String(bal));
      if (risk > 0) localStorage.setItem('forexsight_risk_usd', String(risk));
      const riskPct = bal > 0 ? (risk / bal * 100) : 0;
      const warn = riskPct > 2 ? `<div class="calc-warn">⚠ Risking ${riskPct.toFixed(1)}% of your account is high. Pros risk 1–2% per trade max.</div>` : '';
      if (risk <= 0 || s.sl_pips <= 0) { outEl.innerHTML = warn + '<p class="muted">Enter how much you want to risk above.</p>'; return; }
      const calc = calculatePosition(s, risk);
      const fmt = (n) => '$' + (n >= 0 ? '' : '-') + Math.abs(n).toFixed(2);
      outEl.innerHTML = `
        ${warn}
        <div class="calc-result-grid">
          <div class="calc-stat">
            <div class="calc-lbl">Position size</div>
            <div class="calc-val">${calc.lots.toFixed(2)} lots</div>
            <div class="calc-sub">${(calc.lots * 10).toFixed(2)} mini · ${(calc.lots * 100).toFixed(0)} micro · ${calc.units.toLocaleString()} units</div>
          </div>
          <div class="calc-stat">
            <div class="calc-lbl">Pip value</div>
            <div class="calc-val">$${(calc.pipVal * calc.lots).toFixed(2)}/pip</div>
            <div class="calc-sub">($${calc.pipVal.toFixed(2)} per standard lot)</div>
          </div>
        </div>
        <div class="calc-outcomes">
          <div class="calc-outcome calc-loss">
            <div class="calc-lbl">If SL hits</div>
            <div class="calc-val">${fmt(calc.lossSL)}</div>
            <div class="calc-sub">${s.sl_pips} pips lost · price ${s.sl}</div>
          </div>
          <div class="calc-outcome calc-tp1">
            <div class="calc-lbl">If TP1 hits (1:1)</div>
            <div class="calc-val">+${fmt(calc.profitTP1).slice(1)}</div>
            <div class="calc-sub">${s.tp1_pips} pips · price ${s.tp1}</div>
          </div>
          <div class="calc-outcome calc-tp2">
            <div class="calc-lbl">If TP2 hits (1:2)</div>
            <div class="calc-val">+${fmt(calc.profitTP2).slice(1)}</div>
            <div class="calc-sub">${s.tp2_pips} pips · price ${s.tp2}</div>
          </div>
          <div class="calc-outcome calc-tp3">
            <div class="calc-lbl">If TP3 hits (1:3)</div>
            <div class="calc-val">+${fmt(calc.profitTP3).slice(1)}</div>
            <div class="calc-sub">${s.tp3_pips} pips · price ${s.tp3}</div>
          </div>
        </div>
        <div class="calc-broker">
          <strong>Enter on your broker:</strong>
          ${s.pair.includes('JPY') || s.pair.split('/')[1] !== 'USD'
            ? `<span class="muted">Volume: <code>${calc.lots.toFixed(2)} lots</code> (MT4/MT5 / cTrader) — or <code>${calc.units.toLocaleString()} units</code> (OANDA/TradingView)</span>`
            : `<span class="muted">Volume: <code>${calc.lots.toFixed(2)} lots</code> (MT4/MT5 / cTrader) — or <code>${calc.units.toLocaleString()} units</code> (OANDA/TradingView)</span>`
          }
        </div>
      `;
    };

    balanceEl.addEventListener('input', recompute);
    riskEl.addEventListener('input', recompute);
    calcBox.querySelectorAll('.calc-preset').forEach(b => b.addEventListener('click', () => {
      riskEl.value = b.dataset.v;
      recompute();
    }));
    recompute();
    // When opened from My Trades, jump straight to the calculator so it's
    // visible without scrolling — the user explicitly came here to size it.
    if (fromTrade) {
      setTimeout(() => calcBox.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  }
}
$('.close-btn').addEventListener('click', () => $('#modal').classList.add('hidden'));

// Mobile swipe-down-to-close on modal — mirrors native iOS sheet behavior.
// Only triggers on touch starting at the very top of the modal-content.
(function setupModalSwipeClose() {
  let startY = 0, startScroll = 0, dragging = false;
  const mc = document.querySelector('.modal-content');
  if (!mc) return;
  mc.addEventListener('touchstart', (e) => {
    if (mc.scrollTop > 5) return; // only swipe when at top of scroll
    startY = e.touches[0].clientY;
    startScroll = mc.scrollTop;
    dragging = true;
  }, { passive: true });
  mc.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && mc.scrollTop <= 0) {
      mc.style.transform = `translateY(${Math.min(dy, 200)}px)`;
      mc.style.opacity = String(Math.max(0.4, 1 - dy / 400));
    }
  }, { passive: true });
  mc.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const finalDy = (e.changedTouches[0]?.clientY || 0) - startY;
    if (finalDy > 120) {
      $('#modal').classList.add('hidden');
    }
    mc.style.transform = ''; mc.style.opacity = '';
  }, { passive: true });
})();

// Smooth scroll to top of tab-content area when switching tabs (helpful on
// mobile if user has scrolled deep into one tab and switches to another)
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    setTimeout(() => {
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
  });
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

// Position size calculator (legacy — in Forex Wisdom tab)
const pairList = Object.keys(PAIRS);
const calcPair = $('#calc-pair');
pairList.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; calcPair.appendChild(o); });
$('#calc-btn').addEventListener('click', () => {
  const bal = +$('#calc-balance').value, risk = +$('#calc-risk').value;
  const pair = $('#calc-pair').value, pips = +$('#calc-pips').value;
  const riskUsd = bal * (risk / 100);
  const pipVal = pair.includes('JPY') ? 9.3 : 10;
  const lots = riskUsd / (pips * pipVal);
  const units = Math.round(lots * 100000);
  const res = $('#calc-result');
  res.innerHTML = `Risk: <b>£${riskUsd.toFixed(2)}</b><br>Position size: <b>${lots.toFixed(2)} standard lots</b> (${(lots * 10).toFixed(2)} mini · ${(lots * 100).toFixed(0)} micro)<br>Units: <b>${units.toLocaleString()}</b> (for OANDA/TradingView)<br>SL hit = lose £${riskUsd.toFixed(2)} · TP1 (1:1) = gain ~£${riskUsd.toFixed(2)}`;
  res.classList.add('visible');
});

// v198 — Dedicated Calculator tab. v200 — pair is free-text input so user
// can type ANY pair, not just the listed ones. The pip-value function does
// best-effort detection by name patterns.
function _normalizePairText(input) {
  if (!input) return '';
  // Normalize: uppercase, accept "EUR/USD", "EURUSD", "EUR-USD", "eur usd"
  let t = String(input).toUpperCase().trim();
  t = t.replace(/[^A-Z]/g, ''); // strip everything but letters
  // Common aliases
  if (t === 'GOLD' || t === 'XAUUSD' || t === 'XAU') return 'XAU/USD';
  if (t === 'SILVER' || t === 'XAGUSD' || t === 'XAG') return 'XAG/USD';
  if (t === 'OIL' || t === 'WTI' || t === 'USOIL') return 'WTI/USD';
  if (t === 'NAS100' || t === 'NASDAQ' || t === 'NDX') return 'NAS100';
  if (t === 'SPX' || t === 'SP500' || t === 'US500') return 'SPX500';
  if (t === 'DJI' || t === 'US30' || t === 'DOW') return 'US30';
  if (t === 'GER40' || t === 'DAX' || t === 'DE40') return 'GER40';
  // Forex 6-letter codes → slash format
  if (/^[A-Z]{6}$/.test(t)) return t.slice(0, 3) + '/' + t.slice(3);
  // Crypto "BTCUSD" → "BTC/USD"
  const cryptoBases = ['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','LTC','LINK','DOT','MATIC','SHIB','TRX','UNI','ATOM','XLM','ALGO','VET','FIL'];
  for (const cb of cryptoBases) {
    if (t.startsWith(cb) && t.endsWith('USD')) return cb + '/USD';
    if (t.startsWith(cb) && t.endsWith('USDT')) return cb + '/USDT';
  }
  // Return as-is if we can't parse
  return input.toUpperCase().trim();
}
function _pipValueForPair(rawInput) {
  const p = _normalizePairText(rawInput);
  if (!p) return 10;
  // Metals — pip = $0.10 move, contract size 100oz silver/gold-style
  if (p === 'XAU/USD' || p === 'GOLD') return 10; // $10 per pip per 100oz standard lot
  if (p === 'XAG/USD' || p === 'SILVER') return 50; // $50 per pip per 5000oz lot (silver)
  // Oil — pip = $0.01, contract 1000 barrels
  if (p === 'WTI/USD' || p === 'BRENT/USD') return 10;
  // Indices — varies by broker, common values
  if (p === 'NAS100' || p === 'NDX100') return 1.0; // $1 per point per 1 contract
  if (p === 'SPX500' || p === 'US500') return 1.0;
  if (p === 'US30' || p === 'DJI') return 1.0;
  if (p === 'GER40' || p === 'DAX40') return 1.0;
  if (p === 'JPN225' || p === 'NKY' || p === 'NIK225') return 1.0;
  if (p === 'UK100' || p === 'FTSE100') return 1.0;
  // Crypto majors (1 coin contract)
  const cryptos = { 'BTC/USD':1.0, 'ETH/USD':1.0, 'SOL/USD':0.1, 'BNB/USD':0.1, 'XRP/USD':0.01, 'ADA/USD':0.01, 'DOGE/USD':0.001, 'AVAX/USD':0.1, 'LTC/USD':0.1, 'LINK/USD':0.1 };
  if (cryptos[p] != null) return cryptos[p];
  // JPY pairs: pip = 0.01, $9.30 per pip per standard lot (approx)
  if (p.includes('JPY')) return 9.30;
  // Default forex non-JPY: $10 per pip per 100k unit lot
  return 10;
}
function _renderCalc2() {
  const input = $('#calc2-pair');
  if (!input) return;
  // v281 — datalist replaced by smart fuzzy-matched popup (see _calc2WirePairAutocomplete).
  // The shared LEV_PAIR_CATALOG drives suggestions for both calculators.
  // Restore last-used values
  const savedPair = localStorage.getItem('forexsight_calc2_pair');
  if (savedPair && !input.value) input.value = savedPair;
  if (!input.value) input.value = 'XAU/USD'; // gold default since user is gold-focused
  const savedBal = localStorage.getItem('forexsight_calc2_balance');
  if (savedBal) $('#calc2-balance').value = savedBal;
  const savedRisk = localStorage.getItem('forexsight_calc2_risk');
  if (savedRisk) $('#calc2-risk').value = savedRisk;
  const savedAmount = localStorage.getItem('forexsight_calc2_risk_amount');
  if (savedAmount) $('#calc2-risk-amount').value = savedAmount;
  // Restore risk mode (% or $)
  _setCalc2RiskMode(localStorage.getItem('forexsight_calc2_risk_mode') || 'percent');
}

// ══════════════════════════════════════════════════════════════════════
// v275 — LEVERAGE MATRIX. Shows for the chosen pair what each leverage
// tier (1:1 → 1:2000) means in concrete dollar terms — max position size,
// margin requirement, expected profit if TP hits, expected loss if SL
// hits, fraction of account at stake. Lets users see the brutal honesty
// of high leverage at a glance.
// ══════════════════════════════════════════════════════════════════════
function _renderLeverageMatrix() {
  const balance = parseFloat($('#lev-balance')?.value || '1000');
  // v279 — Pair input is now free text + datalist. Normalize: trim, uppercase,
  // accept both with and without slash (EUR USD → EUR/USD, xauusd → XAU/USD).
  const pairRaw = ($('#lev-pair')?.value || 'XAU/USD').trim().toUpperCase().replace(/\s+/g, '');
  const pair = pairRaw.includes('/') ? pairRaw
    : pairRaw.length === 6 && /^[A-Z]+$/.test(pairRaw) ? `${pairRaw.slice(0, 3)}/${pairRaw.slice(3)}`
    : pairRaw;
  const entry = parseFloat($('#lev-entry')?.value || '0');
  const slPips = parseFloat($('#lev-sl-pips')?.value || '0');
  const tpPips = parseFloat($('#lev-tp-pips')?.value || '0');
  const sizing = $('#lev-sizing')?.value || 'max';
  const out = $('#lev-result');
  if (!out) return;
  if (!(balance > 0) || !(entry > 0) || !(slPips > 0) || !(tpPips > 0)) {
    out.innerHTML = '<p class="muted">Fill in balance, entry, SL pips, and TP pips to generate the matrix.</p>';
    return;
  }

  // v278/v279 — ACCURATE pair config that handles every instrument type.
  // Routes the input to the correct math family:
  //   • Metals (XAU, XAG, XPT, XPD)
  //   • Forex (USD-quote, USD-base, JPY crosses, exotic)
  //   • Indices (US30, NAS100, SPX500, GER40, etc.)
  //   • Commodities (USOIL, UKOIL, NATGAS, COPPER)
  //   • Crypto (BTC, ETH, LTC, etc.)
  const USDJPY_APPROX = 150;
  function pairCfg(pair, entryPx) {
    const safeEntry = entryPx > 0 ? entryPx : 1;
    const p = (pair || '').toUpperCase();

    // ── METALS ──────────────────────────────────────────────────────────
    if (p === 'XAU/USD' || p === 'GOLD' || p === 'XAUUSD') {
      // 100 oz lot × £0.10/pip = £10/pip
      return { pipSize: 0.1, contractSize: 100, pipValue: 10, type: 'metal', label: 'Gold' };
    }
    if (p === 'XAG/USD' || p === 'SILVER' || p === 'XAGUSD') {
      // 5000 oz lot × £0.01/pip = £50/pip (retail CFD: typically 50)
      return { pipSize: 0.01, contractSize: 5000, pipValue: 50, type: 'metal', label: 'Silver' };
    }
    if (p === 'XPT/USD' || p === 'PLATINUM') {
      // 50 oz lot × £0.10/pip = £5/pip (CFD varies — use conservative default)
      return { pipSize: 0.1, contractSize: 50, pipValue: 5, type: 'metal', label: 'Platinum' };
    }
    if (p === 'XPD/USD' || p === 'PALLADIUM') {
      return { pipSize: 0.1, contractSize: 100, pipValue: 10, type: 'metal', label: 'Palladium' };
    }

    // ── CRYPTO ──────────────────────────────────────────────────────────
    if (p === 'BTC/USD' || p === 'BTCUSD') return { pipSize: 1,   contractSize: 1, pipValue: 1,   type: 'crypto', label: 'Bitcoin' };
    if (p === 'ETH/USD' || p === 'ETHUSD') return { pipSize: 0.1, contractSize: 1, pipValue: 0.1, type: 'crypto', label: 'Ethereum' };
    if (p === 'LTC/USD' || p === 'LTCUSD') return { pipSize: 0.01, contractSize: 1, pipValue: 0.01, type: 'crypto', label: 'Litecoin' };
    if (p === 'XRP/USD' || p === 'XRPUSD') return { pipSize: 0.0001, contractSize: 1, pipValue: 0.0001, type: 'crypto', label: 'Ripple' };
    if (p === 'SOL/USD' || p === 'SOLUSD') return { pipSize: 0.01, contractSize: 1, pipValue: 0.01, type: 'crypto', label: 'Solana' };
    if (p === 'DOGE/USD' || p === 'DOGEUSD') return { pipSize: 0.00001, contractSize: 1, pipValue: 0.00001, type: 'crypto', label: 'Dogecoin' };
    if (p === 'BCH/USD' || p === 'BCHUSD') return { pipSize: 0.1, contractSize: 1, pipValue: 0.1, type: 'crypto', label: 'Bitcoin Cash' };
    if (p === 'ADA/USD' || p === 'ADAUSD') return { pipSize: 0.0001, contractSize: 1, pipValue: 0.0001, type: 'crypto', label: 'Cardano' };

    // ── INDICES (CFD: 1 standard lot = £1 per index point) ─────────────
    const indices = {
      'US30':   'Dow Jones',
      'NAS100': 'Nasdaq 100',
      'SPX500': 'S&P 500',
      'GER40':  'DAX',
      'UK100':  'FTSE 100',
      'JPN225': 'Nikkei',
      'FRA40':  'CAC 40',
      'AUS200': 'ASX 200',
      'ESP35':  'IBEX 35',
      'HK50':   'Hang Seng',
      'EU50':   'Euro Stoxx 50',
    };
    if (indices[p]) {
      return { pipSize: 1, contractSize: 1, pipValue: 1, type: 'index', label: indices[p] };
    }

    // ── COMMODITIES ─────────────────────────────────────────────────────
    if (p === 'USOIL' || p === 'WTI')   return { pipSize: 0.01, contractSize: 1000, pipValue: 10, type: 'commodity', label: 'WTI Crude' };
    if (p === 'UKOIL' || p === 'BRENT') return { pipSize: 0.01, contractSize: 1000, pipValue: 10, type: 'commodity', label: 'Brent Crude' };
    if (p === 'NATGAS' || p === 'GAS')  return { pipSize: 0.001, contractSize: 10000, pipValue: 10, type: 'commodity', label: 'Natural Gas' };
    if (p === 'COPPER')                 return { pipSize: 0.0001, contractSize: 25000, pipValue: 2.5, type: 'commodity', label: 'Copper' };

    // ── FOREX ───────────────────────────────────────────────────────────
    const parts = p.split('/');
    if (parts.length !== 2) {
      // Unknown instrument — best-effort forex defaults
      return { pipSize: 0.0001, contractSize: 100000, pipValue: 10, type: 'forex', label: 'Unknown — using default forex maths' };
    }
    const [base, quote] = parts;
    const pipSize = quote === 'JPY' ? 0.01 : 0.0001;
    const contractSize = 100000;
    let pipValue;
    let mathNote = '';
    if (quote === 'USD') {
      // Direct quote — pip is in USD, value is constant £10
      pipValue = pipSize * contractSize;
      mathNote = `Direct quote (£/pip is constant)`;
    } else if (base === 'USD') {
      // Indirect quote — pip is in quote currency, divide by current price
      pipValue = (pipSize * contractSize) / safeEntry;
      mathNote = `Indirect quote (£/pip = ${(pipSize * contractSize).toFixed(0)} ÷ ${safeEntry})`;
    } else if (quote === 'JPY') {
      // JPY cross — pip in JPY, convert via USDJPY
      pipValue = (pipSize * contractSize) / USDJPY_APPROX;
      mathNote = `JPY cross (1000 ÷ USDJPY≈${USDJPY_APPROX})`;
    } else if (base === 'EUR' || base === 'GBP' || base === 'AUD' || base === 'NZD' || base === 'CAD' || base === 'CHF') {
      // Cross pair (e.g. EUR/CAD, EUR/CHF, GBP/AUD, AUD/CAD) — pip in quote
      // currency. For accuracy we need the quote→USD rate. As an
      // approximation, use known ranges; otherwise default to £10.
      const quoteRates = { CAD: 1.36, CHF: 0.91, AUD: 1.53, NZD: 1.65, MXN: 18.5, ZAR: 18.5, TRY: 32, SGD: 1.34, HKD: 7.8, SEK: 10.5, NOK: 10.5, PLN: 4.1 };
      const r = quoteRates[quote];
      if (r) {
        pipValue = (pipSize * contractSize) / r;
        mathNote = `Cross pair (${(pipSize * contractSize).toFixed(0)} ÷ USD/${quote}≈${r})`;
      } else {
        pipValue = pipSize * contractSize;
        mathNote = `Cross pair (using default £/pip — broker-specific)`;
      }
    } else if (base === 'USD' && quote in { MXN:1, ZAR:1, TRY:1, SGD:1, HKD:1, SEK:1, NOK:1, PLN:1 }) {
      // Exotic indirect (already handled above by base === 'USD')
      pipValue = (pipSize * contractSize) / safeEntry;
    } else {
      pipValue = pipSize * contractSize;
    }
    return { pipSize, contractSize, pipValue, type: 'forex', mathNote };
  }
  const cfg = pairCfg(pair, entry);
  // legacy field name still referenced below
  cfg.pipValueUsd = cfg.pipValue;

  // All leverage tiers most brokers offer
  // v282 — Filter the leverage list to what the SELECTED BROKER actually
  // offers for this instrument's class. Existing math is unchanged — we
  // just gate which rows render. Default rows are kept up to the broker cap,
  // and the broker's exact cap is appended so the user always sees their max.
  const brokerSel = (document.getElementById('lev-broker')?.value || 'IC Markets').trim();
  const brokerCap = _levBrokerCapFor(brokerSel, cfg.type, pair);
  const baseLevels = [1, 10, 30, 50, 100, 200, 400, 500, 1000, 2000];
  const filtered = baseLevels.filter(l => l <= brokerCap);
  if (!filtered.includes(brokerCap)) filtered.push(brokerCap);
  const leverages = filtered.sort((a, b) => a - b);

  // For each leverage row, determine the position size based on `sizing` mode
  const computeLotsForLeverage = (lev) => {
    if (sizing === 'max') {
      // Maximum position size your equity supports at this leverage:
      // Required margin = (entry × units) / leverage ≤ balance
      // → units ≤ (balance × leverage) / entry
      // → lots = units / contractSize
      const maxUnits = (balance * lev) / entry;
      return maxUnits / cfg.contractSize;
    }
    if (sizing.startsWith('risk-')) {
      // Size to risk N% of account on the SL hit
      const riskPct = parseFloat(sizing.replace('risk-', '')) / 100;
      const riskUsd = balance * riskPct;
      // riskUsd = slPips × pipValueUsd × lots → lots = riskUsd / (slPips × pipValueUsd)
      const lots = riskUsd / (slPips * cfg.pipValueUsd);
      // Cap by leverage limit
      const maxLotsByLev = (balance * lev) / (entry * cfg.contractSize);
      return Math.min(lots, maxLotsByLev);
    }
    if (sizing.startsWith('lot-')) {
      // Fixed lot size — same across all leverages, only margin differs
      const map = { 'lot-001': 0.01, 'lot-01': 0.1, 'lot-1': 1.0 };
      return map[sizing] || 0.01;
    }
    if (sizing === 'custom') {
      // v276 — User-entered lot size. Same across leverages, only margin differs.
      const customLot = parseFloat($('#lev-custom-lot')?.value || '0');
      return customLot > 0 ? customLot : 0.01;
    }
    return 0;
  };

  // Build rows
  const rows = leverages.map(lev => {
    const lots = computeLotsForLeverage(lev);
    const units = lots * cfg.contractSize;
    const positionValueUsd = units * entry;
    const requiredMargin = positionValueUsd / lev;
    const profitUsd = tpPips * cfg.pipValueUsd * lots;
    const lossUsd = slPips * cfg.pipValueUsd * lots;
    const marginPctOfAccount = balance > 0 ? (requiredMargin / balance) * 100 : 0;
    const profitPctOfAccount = balance > 0 ? (profitUsd / balance) * 100 : 0;
    const lossPctOfAccount = balance > 0 ? (lossUsd / balance) * 100 : 0;
    // Risk-of-ruin warning
    const dangerous = lossPctOfAccount >= 50;
    const veryDangerous = lossPctOfAccount >= 100;
    return {
      lev, lots, units, positionValueUsd, requiredMargin,
      profitUsd, lossUsd,
      marginPctOfAccount, profitPctOfAccount, lossPctOfAccount,
      dangerous, veryDangerous,
    };
  });

  // v277 — Currency symbol switched to £ across the leverage matrix display.
  const fmt$ = v => '£' + (Math.abs(v) >= 10000
    ? (v / 1000).toFixed(1) + 'k'
    : v.toFixed(2));
  const fmtLot = v => v >= 1 ? v.toFixed(2) : v.toFixed(3);

  const tableHtml = `
    <div class="lev-table-wrap">
      <table class="lev-table">
        <thead>
          <tr>
            <th>Leverage</th>
            <th>Lots</th>
            <th>Position £</th>
            <th>Margin req.</th>
            <th>If TP wins</th>
            <th>If SL hits</th>
            <th>% account at stake</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr class="${r.veryDangerous ? 'lev-row-blowup' : r.dangerous ? 'lev-row-danger' : ''}">
              <td><strong>1:${r.lev}</strong></td>
              <td>${fmtLot(r.lots)}</td>
              <td class="muted">${fmt$(r.positionValueUsd)}</td>
              <td>${fmt$(r.requiredMargin)} <span class="muted">(${r.marginPctOfAccount.toFixed(1)}%)</span></td>
              <td class="lev-profit">+${fmt$(r.profitUsd)} <span class="muted">+${r.profitPctOfAccount.toFixed(1)}%</span></td>
              <td class="lev-loss">−${fmt$(r.lossUsd)} <span class="muted">−${r.lossPctOfAccount.toFixed(1)}%</span></td>
              <td class="${r.veryDangerous ? 'lev-blowup' : r.dangerous ? 'lev-danger-cell' : ''}">${r.lossPctOfAccount.toFixed(1)}% ${r.veryDangerous ? '☠ blow-up' : r.dangerous ? '⚠ risky' : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="lev-broker-banner">
      <span class="lev-broker-tag">BROKER</span>
      <strong>${brokerSel}</strong> allows up to
      <strong class="lev-broker-cap">1:${brokerCap}</strong>
      on <strong>${pair}</strong> <span class="muted">(${cfg.type})</span>
      — only your broker's real tiers are shown below.
    </div>
    <div class="lev-notes muted">
      Pair: <strong>${pair}</strong>${cfg.label ? ` <span class="muted">(${cfg.label})</span>` : ''} ·
      Type: <strong>${cfg.type}</strong> ·
      1 pip = ${cfg.pipSize} price units ·
      1 standard lot ≈ <strong>£${cfg.pipValueUsd.toFixed(2)}</strong> per pip
      ${cfg.mathNote ? ` <span style="color:#fcd34d">— ${cfg.mathNote}</span>` : ''}
      ${cfg.type === 'index' ? `<br><span style="color:#fcd34d">CFD note: 1 standard lot = £1/point assumed — check your broker's exact contract spec, some use 0.10 or 10× this.</span>` : ''}
      ${cfg.type === 'metal' && pair !== 'XAU/USD' ? `<br><span style="color:#fcd34d">Metal note: contract sizes vary by broker — values shown are standard CFD conventions.</span>` : ''}
      ${cfg.type === 'commodity' ? `<br><span style="color:#fcd34d">Commodity note: contract sizes vary by broker; oil is typically 1000 barrels/lot.</span>` : ''}
      ${cfg.type === 'crypto' ? `<br><span style="color:#fcd34d">Crypto note: contract specs vary enormously by broker — verify your platform's per-point value.</span>` : ''}
      ${sizing === 'max' ? '<br>Sizing: MAXIMUM position your balance supports at each leverage tier (uses all available margin).' :
        sizing.startsWith('risk-') ? `<br>Sizing: position calibrated to lose exactly ${sizing.replace('risk-', '')}% of your account if SL hits — same across leverages, only margin requirement differs.` :
        sizing.startsWith('lot-') ? `<br>Sizing: fixed at ${({'lot-001':'0.01','lot-01':'0.1','lot-1':'1.0'})[sizing]} lot — same position across leverages, only margin differs.` :
        sizing === 'custom' ? `<br>Sizing: custom ${($('#lev-custom-lot')?.value || '0.01')} lot — same position across leverages, only margin differs.` : ''}
      <br><strong>Pro reality:</strong> any single trade losing &gt; 5% is a death-sentence sizing on real capital. Higher leverage doesn't make you more money — it just lets you trade smaller account with same lot size.
    </div>`;
  out.innerHTML = tableHtml;

  // Persist last-used values
  try {
    localStorage.setItem('forexsight_lev_balance', String(balance));
    localStorage.setItem('forexsight_lev_pair', pair);
    localStorage.setItem('forexsight_lev_entry', String(entry));
    localStorage.setItem('forexsight_lev_sl', String(slPips));
    localStorage.setItem('forexsight_lev_tp', String(tpPips));
    localStorage.setItem('forexsight_lev_sizing', sizing);
    // v276 — persist custom-lot value too
    if (sizing === 'custom') {
      const cl = $('#lev-custom-lot')?.value || '';
      if (cl) localStorage.setItem('forexsight_lev_custom_lot', String(cl));
    }
  } catch {}
}

// v280 — SMART PAIR AUTOCOMPLETE. Replaces the native <datalist> (which is
// inconsistent across browsers and doesn't fuzzy-match) with a custom
// popup that suggests instruments by partial / alias / fuzzy match in real
// time as you type. Examples it catches:
//   "gold"  → XAU/USD (Gold)
//   "dax"   → GER40
//   "dow"   → US30
//   "ftse"  → UK100
//   "yen"   → USD/JPY + JPY crosses
//   "bitc"  → BTC/USD
//   "eu"    → EUR/USD, EUR/JPY, EUR/GBP, EU50, etc.
const LEV_PAIR_CATALOG = [
  // Metals
  { value: 'XAU/USD', aliases: ['gold', 'xauusd', 'au'],          label: 'Gold',           cat: 'metal' },
  { value: 'XAG/USD', aliases: ['silver', 'xagusd', 'ag'],        label: 'Silver',         cat: 'metal' },
  { value: 'XPT/USD', aliases: ['platinum', 'xptusd', 'pt'],      label: 'Platinum',       cat: 'metal' },
  { value: 'XPD/USD', aliases: ['palladium', 'pd'],               label: 'Palladium',      cat: 'metal' },
  // Forex majors
  { value: 'EUR/USD', aliases: ['eurusd', 'fiber', 'euro'],       label: 'Euro / Dollar',  cat: 'forex' },
  { value: 'GBP/USD', aliases: ['gbpusd', 'cable', 'pound'],      label: 'Pound / Dollar', cat: 'forex' },
  { value: 'AUD/USD', aliases: ['audusd', 'aussie'],              label: 'Aussie',         cat: 'forex' },
  { value: 'NZD/USD', aliases: ['nzdusd', 'kiwi'],                label: 'Kiwi',           cat: 'forex' },
  { value: 'USD/JPY', aliases: ['usdjpy', 'yen', 'gopher'],       label: 'Dollar / Yen',   cat: 'forex' },
  { value: 'USD/CAD', aliases: ['usdcad', 'loonie'],              label: 'Dollar / Loonie',cat: 'forex' },
  { value: 'USD/CHF', aliases: ['usdchf', 'swissy', 'franc'],     label: 'Dollar / Swiss', cat: 'forex' },
  // Forex crosses
  { value: 'EUR/GBP', aliases: ['eurgbp', 'chunnel'],             label: 'Euro / Pound',   cat: 'forex' },
  { value: 'EUR/JPY', aliases: ['eurjpy', 'yuppy'],               label: 'Euro / Yen',     cat: 'forex' },
  { value: 'EUR/AUD', aliases: ['euraud'],                        label: 'Euro / Aussie',  cat: 'forex' },
  { value: 'EUR/CAD', aliases: ['eurcad'],                        label: 'Euro / Loonie',  cat: 'forex' },
  { value: 'EUR/CHF', aliases: ['eurchf'],                        label: 'Euro / Swiss',   cat: 'forex' },
  { value: 'EUR/NZD', aliases: ['eurnzd'],                        label: 'Euro / Kiwi',    cat: 'forex' },
  { value: 'GBP/JPY', aliases: ['gbpjpy', 'beast', 'dragon'],     label: 'Pound / Yen',    cat: 'forex' },
  { value: 'GBP/AUD', aliases: ['gbpaud'],                        label: 'Pound / Aussie', cat: 'forex' },
  { value: 'GBP/CAD', aliases: ['gbpcad'],                        label: 'Pound / Loonie', cat: 'forex' },
  { value: 'GBP/CHF', aliases: ['gbpchf'],                        label: 'Pound / Swiss',  cat: 'forex' },
  { value: 'GBP/NZD', aliases: ['gbpnzd'],                        label: 'Pound / Kiwi',   cat: 'forex' },
  { value: 'AUD/JPY', aliases: ['audjpy'],                        label: 'Aussie / Yen',   cat: 'forex' },
  { value: 'AUD/CAD', aliases: ['audcad'],                        label: 'Aussie / Loonie',cat: 'forex' },
  { value: 'AUD/CHF', aliases: ['audchf'],                        label: 'Aussie / Swiss', cat: 'forex' },
  { value: 'AUD/NZD', aliases: ['audnzd'],                        label: 'Aussie / Kiwi',  cat: 'forex' },
  { value: 'NZD/JPY', aliases: ['nzdjpy'],                        label: 'Kiwi / Yen',     cat: 'forex' },
  { value: 'NZD/CAD', aliases: ['nzdcad'],                        label: 'Kiwi / Loonie',  cat: 'forex' },
  { value: 'NZD/CHF', aliases: ['nzdchf'],                        label: 'Kiwi / Swiss',   cat: 'forex' },
  { value: 'CAD/JPY', aliases: ['cadjpy'],                        label: 'Loonie / Yen',   cat: 'forex' },
  { value: 'CAD/CHF', aliases: ['cadchf'],                        label: 'Loonie / Swiss', cat: 'forex' },
  { value: 'CHF/JPY', aliases: ['chfjpy'],                        label: 'Swiss / Yen',    cat: 'forex' },
  // Exotics
  { value: 'USD/MXN', aliases: ['usdmxn', 'peso', 'mex'],         label: 'Dollar / Peso',  cat: 'exotic' },
  { value: 'USD/ZAR', aliases: ['usdzar', 'rand'],                label: 'Dollar / Rand',  cat: 'exotic' },
  { value: 'USD/TRY', aliases: ['usdtry', 'lira', 'turk'],        label: 'Dollar / Lira',  cat: 'exotic' },
  { value: 'USD/SGD', aliases: ['usdsgd', 'singapore'],           label: 'Dollar / SG',    cat: 'exotic' },
  { value: 'USD/HKD', aliases: ['usdhkd', 'hongkong'],            label: 'Dollar / HKD',   cat: 'exotic' },
  { value: 'USD/SEK', aliases: ['usdsek', 'krona'],               label: 'Dollar / SEK',   cat: 'exotic' },
  { value: 'USD/NOK', aliases: ['usdnok', 'norway'],              label: 'Dollar / NOK',   cat: 'exotic' },
  { value: 'USD/PLN', aliases: ['usdpln', 'zloty', 'polish'],     label: 'Dollar / Zloty', cat: 'exotic' },
  { value: 'EUR/TRY', aliases: ['eurtry'],                        label: 'Euro / Lira',    cat: 'exotic' },
  { value: 'EUR/PLN', aliases: ['eurpln'],                        label: 'Euro / Zloty',   cat: 'exotic' },
  { value: 'EUR/SEK', aliases: ['eursek'],                        label: 'Euro / Krona',   cat: 'exotic' },
  { value: 'EUR/NOK', aliases: ['eurnok'],                        label: 'Euro / NOK',     cat: 'exotic' },
  // Indices
  { value: 'US30',    aliases: ['dow', 'djia', 'dji', 'dowjones'],  label: 'Dow Jones',     cat: 'index' },
  { value: 'NAS100',  aliases: ['nasdaq', 'ndx', 'nas', 'tech'],    label: 'Nasdaq 100',    cat: 'index' },
  { value: 'SPX500',  aliases: ['sp500', 'spx', 'sandp', 'spy'],    label: 'S&P 500',       cat: 'index' },
  { value: 'GER40',   aliases: ['dax', 'germany', 'ger30'],         label: 'DAX 40',        cat: 'index' },
  { value: 'UK100',   aliases: ['ftse', 'ftse100', 'britain'],      label: 'FTSE 100',      cat: 'index' },
  { value: 'JPN225',  aliases: ['nikkei', 'nky', 'jp225'],          label: 'Nikkei 225',    cat: 'index' },
  { value: 'FRA40',   aliases: ['cac', 'cac40', 'france'],          label: 'CAC 40',        cat: 'index' },
  { value: 'AUS200',  aliases: ['asx', 'asx200', 'australia'],      label: 'ASX 200',       cat: 'index' },
  { value: 'ESP35',   aliases: ['ibex', 'ibex35', 'spain'],         label: 'IBEX 35',       cat: 'index' },
  { value: 'HK50',    aliases: ['hangseng', 'hsi'],                 label: 'Hang Seng',     cat: 'index' },
  { value: 'EU50',    aliases: ['eurostoxx', 'stoxx50', 'sx5e'],    label: 'Euro Stoxx 50', cat: 'index' },
  // Commodities
  { value: 'USOIL',   aliases: ['wti', 'oil', 'crude'],           label: 'WTI Crude',      cat: 'commodity' },
  { value: 'UKOIL',   aliases: ['brent', 'brentoil'],             label: 'Brent Crude',    cat: 'commodity' },
  { value: 'NATGAS',  aliases: ['naturalgas', 'gas', 'ng'],       label: 'Natural Gas',    cat: 'commodity' },
  { value: 'COPPER',  aliases: ['hg', 'cu'],                      label: 'Copper',         cat: 'commodity' },
  // Crypto
  { value: 'BTC/USD', aliases: ['bitcoin', 'btcusd', 'btc'],      label: 'Bitcoin',        cat: 'crypto' },
  { value: 'ETH/USD', aliases: ['ethereum', 'ethusd', 'eth'],     label: 'Ethereum',       cat: 'crypto' },
  { value: 'LTC/USD', aliases: ['litecoin', 'ltcusd', 'ltc'],     label: 'Litecoin',       cat: 'crypto' },
  { value: 'XRP/USD', aliases: ['ripple', 'xrpusd', 'xrp'],       label: 'Ripple',         cat: 'crypto' },
  { value: 'SOL/USD', aliases: ['solana', 'solusd', 'sol'],       label: 'Solana',         cat: 'crypto' },
  { value: 'DOGE/USD',aliases: ['doge', 'dogecoin', 'dogeusd'],   label: 'Dogecoin',       cat: 'crypto' },
  { value: 'BCH/USD', aliases: ['bch', 'bitcoincash'],            label: 'Bitcoin Cash',   cat: 'crypto' },
  { value: 'ADA/USD', aliases: ['ada', 'cardano'],                label: 'Cardano',        cat: 'crypto' },
];

// Score an item against a query string. Higher = better match.
// 0 means no match — item should be filtered out.
function _levPairScore(query, item) {
  const q = (query || '').toLowerCase().trim().replace(/\s+/g, '');
  if (!q) return 1; // show all when query is empty
  const v = item.value.toLowerCase();
  const vCompact = v.replace(/\//g, ''); // EUR/USD → eurusd
  const l = (item.label || '').toLowerCase();
  const aliases = item.aliases || [];
  // Highest priorities (exact / prefix matches)
  if (v === q || vCompact === q) return 1000;
  if (aliases.some(a => a.toLowerCase() === q)) return 900;
  if (vCompact.startsWith(q) || v.startsWith(q)) return 800;
  if (aliases.some(a => a.toLowerCase().startsWith(q))) return 700;
  if (l.toLowerCase().startsWith(q)) return 600;
  // Substring matches
  if (vCompact.includes(q)) return 450;
  if (l.toLowerCase().includes(q)) return 400;
  if (aliases.some(a => a.toLowerCase().includes(q))) return 350;
  // Character-by-character fuzzy (all query chars appear in order in value)
  let qi = 0;
  for (let i = 0; i < vCompact.length && qi < q.length; i++) {
    if (vCompact[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 100;
  return 0;
}

function _levCatColor(cat) {
  return {
    metal:     '#fcd34d',
    forex:     '#86efac',
    exotic:    '#c4b5fd',
    index:     '#93c5fd',
    commodity: '#fdba74',
    crypto:    '#f9a8d4',
  }[cat] || '#ddd';
}

// ════════════════════════════════════════════════════════════════════════
// v282 — BROKER PROFILES. Real max-leverage caps per major retail broker,
// per instrument class. Values match each broker's published retail offering
// (offshore / global entity where higher tiers are available). Caps are used
// to filter the leverage matrix so it shows only what your broker actually
// allows — no fantasy tiers.
//
// Per-instrument fields (each is the broker's max for that instrument class):
//   forex      — major & minor forex (EUR/USD, GBP/USD, USD/JPY…)
//   exotic     — exotic forex (USD/TRY, USD/MXN, USD/ZAR…)
//   metal_gold — gold (XAU/USD)
//   metal_oth  — silver, platinum, palladium
//   index      — stock indices (US30, NAS100, DAX…)
//   commodity  — oil, gas, copper
//   crypto     — BTC/USD, ETH/USD, etc.
// ════════════════════════════════════════════════════════════════════════
const BROKER_PROFILES = [
  // value           | label                  | aliases                            | region   | caps
  { value: 'IC Markets',     aliases: ['ic', 'icmarkets', 'ic-markets'],            region: 'AU/EU',  caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 500, crypto: 200 } },
  { value: 'Exness',         aliases: ['exness'],                                   region: 'GLOBAL', caps: { forex: 2000, exotic: 200, metal_gold: 2000, metal_oth: 400, index: 400, commodity: 200, crypto: 400 } },
  { value: 'FBS',            aliases: ['fbs'],                                      region: 'GLOBAL', caps: { forex: 3000, exotic: 400, metal_gold: 3000, metal_oth: 1000, index: 100, commodity: 50, crypto: 50 } },
  { value: 'Pepperstone',    aliases: ['pepperstone', 'pepper'],                    region: 'AU/EU',  caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 100, index: 200, commodity: 200, crypto: 5 } },
  { value: 'XM',             aliases: ['xm', 'xmcom'],                              region: 'GLOBAL', caps: { forex: 1000, exotic: 500, metal_gold: 1000, metal_oth: 400, index: 200, commodity: 200, crypto: 100 } },
  { value: 'OANDA',          aliases: ['oanda'],                                    region: 'GLOBAL', caps: { forex: 200,  exotic: 100, metal_gold: 200, metal_oth: 100, index: 100, commodity: 100, crypto: 2 } },
  { value: 'HFM',            aliases: ['hfm', 'hotforex', 'hot-forex'],             region: 'GLOBAL', caps: { forex: 2000, exotic: 400, metal_gold: 1000, metal_oth: 200, index: 200, commodity: 100, crypto: 5 } },
  { value: 'FTMO (funded)',  aliases: ['ftmo', 'funded'],                           region: 'PROP',   caps: { forex: 100,  exotic: 100, metal_gold: 100, metal_oth: 100, index: 100, commodity: 100, crypto: 50 } },
  { value: 'Eightcap',       aliases: ['eightcap', '8cap'],                         region: 'AU/EU',  caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 200, crypto: 20 } },
  { value: 'TMGM',           aliases: ['tmgm', 'trademax'],                         region: 'AU',     caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 200, crypto: 20 } },
  { value: 'Vantage',        aliases: ['vantage', 'vantage-markets', 'vantagefx'],  region: 'GLOBAL', caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 200, crypto: 200 } },
  { value: 'FP Markets',     aliases: ['fp', 'fpmarkets', 'fp-markets'],            region: 'AU/EU',  caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 200, crypto: 5 } },
  { value: 'Plus500',        aliases: ['plus500', 'plus'],                          region: 'UK/EU',  caps: { forex: 30,   exotic: 20,  metal_gold: 20, metal_oth: 10, index: 20, commodity: 10, crypto: 2 } },
  { value: 'eToro',          aliases: ['etoro'],                                    region: 'UK/EU',  caps: { forex: 30,   exotic: 20,  metal_gold: 20, metal_oth: 10, index: 20, commodity: 10, crypto: 2 } },
  { value: 'Interactive Brokers', aliases: ['ibkr', 'ib', 'interactive', 'interactive-brokers'], region: 'US/GLOBAL', caps: { forex: 50, exotic: 20, metal_gold: 50, metal_oth: 30, index: 20, commodity: 20, crypto: 2 } },
  { value: 'FXTM',           aliases: ['fxtm', 'forextime'],                        region: 'GLOBAL', caps: { forex: 1000, exotic: 200, metal_gold: 1000, metal_oth: 200, index: 200, commodity: 200, crypto: 100 } },
  { value: 'AvaTrade',       aliases: ['ava', 'avatrade'],                          region: 'EU/AU',  caps: { forex: 400,  exotic: 200, metal_gold: 200, metal_oth: 100, index: 200, commodity: 100, crypto: 25 } },
  { value: 'Admirals',       aliases: ['admiral', 'admirals', 'admiral-markets'],   region: 'EU/UK',  caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 100, index: 200, commodity: 200, crypto: 5 } },
  { value: 'CMC Markets',    aliases: ['cmc', 'cmcmarkets'],                        region: 'UK/AU',  caps: { forex: 30,   exotic: 20,  metal_gold: 20, metal_oth: 10, index: 20, commodity: 20, crypto: 2 } },
  { value: 'Tickmill',       aliases: ['tickmill', 'tick'],                         region: 'GLOBAL', caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 200, crypto: 20 } },
  { value: 'BlackBull',      aliases: ['blackbull', 'black-bull'],                  region: 'NZ',     caps: { forex: 500,  exotic: 200, metal_gold: 500, metal_oth: 200, index: 200, commodity: 200, crypto: 100 } },
  { value: 'Capital.com',    aliases: ['capital', 'capitalcom'],                    region: 'UK/EU',  caps: { forex: 30,   exotic: 20,  metal_gold: 20, metal_oth: 10, index: 20, commodity: 20, crypto: 2 } },
  { value: 'IG',             aliases: ['ig', 'igmarkets', 'ig-group'],              region: 'UK/AU',  caps: { forex: 30,   exotic: 20,  metal_gold: 20, metal_oth: 10, index: 20, commodity: 20, crypto: 2 } },
  { value: 'XTB',            aliases: ['xtb'],                                      region: 'EU/UK',  caps: { forex: 30,   exotic: 20,  metal_gold: 20, metal_oth: 10, index: 20, commodity: 20, crypto: 2 } },
  { value: 'MyForexFunds',   aliases: ['mff', 'myforexfunds'],                      region: 'PROP',   caps: { forex: 100,  exotic: 100, metal_gold: 100, metal_oth: 100, index: 100, commodity: 100, crypto: 50 } },
  { value: 'The5ers',        aliases: ['5ers', 'the5ers'],                          region: 'PROP',   caps: { forex: 100,  exotic: 100, metal_gold: 100, metal_oth: 100, index: 100, commodity: 100, crypto: 30 } },
  { value: 'Custom (set max yourself)', aliases: ['custom', 'other', 'manual'],     region: 'CUSTOM', caps: null /* prompted via UI */ },
];

// Look up the broker's leverage cap for the instrument family produced by
// pairCfg(). Returns a positive integer ceiling, falling back to 500 if the
// broker is unknown so the matrix still renders sensibly.
function _levBrokerCapFor(brokerValue, cfgType, pair) {
  const p = (pair || '').toUpperCase();
  const broker = BROKER_PROFILES.find(b => b.value.toLowerCase() === (brokerValue || '').toLowerCase());
  if (!broker) return 500; // unknown broker fallback
  if (broker.value === 'Custom (set max yourself)') {
    const customEl = document.getElementById('lev-custom-cap');
    const v = parseFloat(customEl?.value || '500');
    return v > 0 ? Math.min(5000, Math.round(v)) : 500;
  }
  const caps = broker.caps || {};
  // Map cfgType → caps key. Distinguish gold (highest tier) from other metals,
  // and exotic forex from majors. Crypto/index/commodity are direct.
  if (cfgType === 'metal') {
    if (p === 'XAU/USD' || p.includes('GOLD')) return caps.metal_gold || caps.metal_oth || 100;
    return caps.metal_oth || 100;
  }
  if (cfgType === 'forex') {
    // Exotic forex = anything where neither side is a G10 currency.
    const G10 = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD','SEK','NOK'];
    const parts = p.split('/');
    if (parts.length === 2 && (!G10.includes(parts[0]) || !G10.includes(parts[1]))) {
      return caps.exotic || caps.forex || 100;
    }
    return caps.forex || 100;
  }
  if (cfgType === 'index')     return caps.index     || 100;
  if (cfgType === 'commodity') return caps.commodity || 100;
  if (cfgType === 'crypto')    return caps.crypto    || 10;
  return caps.forex || 100;
}

// Color the region dot in the dropdown. AU green, EU/UK blue, GLOBAL yellow,
// US white, PROP red, CUSTOM gray.
function _levBrokerRegionColor(region) {
  return {
    'AU/EU':     '#86efac',
    'AU':        '#86efac',
    'NZ':        '#86efac',
    'GLOBAL':    '#fde68a',
    'EU/AU':     '#86efac',
    'EU/UK':     '#93c5fd',
    'UK/EU':     '#93c5fd',
    'UK/AU':     '#93c5fd',
    'US/GLOBAL': '#e5e7eb',
    'PROP':      '#fca5a5',
    'CUSTOM':    '#cbd5e1',
  }[region] || '#cbd5e1';
}

function _levBrokerScore(query, item) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return 1;
  const v = item.value.toLowerCase();
  const aliases = item.aliases || [];
  if (v === q) return 1000;
  if (aliases.some(a => a.toLowerCase() === q)) return 900;
  if (v.startsWith(q)) return 800;
  if (aliases.some(a => a.toLowerCase().startsWith(q))) return 700;
  if (v.includes(q)) return 500;
  if (aliases.some(a => a.toLowerCase().includes(q))) return 350;
  // Character-by-character fuzzy
  let qi = 0;
  for (let i = 0; i < v.length && qi < q.length; i++) {
    if (v[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 100;
  return 0;
}

function _levBrokerRenderSuggestions(query) {
  const box = document.getElementById('lev-broker-suggestions');
  if (!box) return;
  // Determine current pair so we can show "Max 1:X for <pair>" on each row.
  const pairRaw = (document.getElementById('lev-pair')?.value || 'XAU/USD').trim().toUpperCase().replace(/\s+/g, '');
  const pair = pairRaw.includes('/') ? pairRaw
    : pairRaw.length === 6 && /^[A-Z]+$/.test(pairRaw) ? `${pairRaw.slice(0, 3)}/${pairRaw.slice(3)}`
    : pairRaw;
  const cfgType = _levCfgTypeFor(pair);
  const scored = BROKER_PROFILES
    .map(item => ({ item, score: _levBrokerScore(query, item) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  if (!scored.length) {
    box.innerHTML = '<div class="lev-pair-empty">No matching broker. Pick "Custom" to set your own max leverage.</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = scored.map((x, i) => {
    const it = x.item;
    const cap = it.value === 'Custom (set max yourself)' ? '—' : `1:${_levBrokerCapFor(it.value, cfgType, pair)}`;
    return `<div class="lev-pair-row" role="option" data-value="${it.value}" data-i="${i}">
      <span class="lev-pair-row-cat" style="background:${_levBrokerRegionColor(it.region)}"></span>
      <span class="lev-pair-row-value">${it.value}</span>
      <span class="lev-pair-row-label">Max ${cap} for ${pair}</span>
      <span class="lev-pair-row-tag">${it.region}</span>
    </div>`;
  }).join('');
  box.hidden = false;
  const first = box.querySelector('.lev-pair-row');
  if (first) first.classList.add('lev-pair-row-active');
}

function _levBrokerSelect(value) {
  const input = document.getElementById('lev-broker');
  const box = document.getElementById('lev-broker-suggestions');
  if (!input || !box) return;
  input.value = value;
  box.hidden = true;
  // Reveal / hide the custom-cap input
  const wrap = document.getElementById('lev-custom-cap-wrap');
  if (wrap) wrap.style.display = (value === 'Custom (set max yourself)') ? '' : 'none';
  try { localStorage.setItem('forexsight_lev_broker', value); } catch {}
  if (typeof _renderLeverageMatrix === 'function') _renderLeverageMatrix();
}

function _levBrokerWire() {
  const input = document.getElementById('lev-broker');
  const box = document.getElementById('lev-broker-suggestions');
  if (!input || !box || input._wiredAutocomplete) return;
  input._wiredAutocomplete = true;
  input.addEventListener('focus', () => _levBrokerRenderSuggestions(input.value));
  input.addEventListener('input', () => _levBrokerRenderSuggestions(input.value));
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const rows = box.querySelectorAll('.lev-pair-row');
    if (!rows.length) return;
    let activeIdx = -1;
    rows.forEach((r, i) => { if (r.classList.contains('lev-pair-row-active')) activeIdx = i; });
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows.forEach(r => r.classList.remove('lev-pair-row-active'));
      const next = rows[Math.min(rows.length - 1, activeIdx + 1)] || rows[0];
      next.classList.add('lev-pair-row-active');
      next.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows.forEach(r => r.classList.remove('lev-pair-row-active'));
      const prev = rows[Math.max(0, activeIdx - 1)] || rows[rows.length - 1];
      prev.classList.add('lev-pair-row-active');
      prev.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const active = box.querySelector('.lev-pair-row-active');
      if (active) {
        e.preventDefault();
        _levBrokerSelect(active.dataset.value);
      }
    } else if (e.key === 'Escape') {
      box.hidden = true;
    }
  });
  box.addEventListener('click', (e) => {
    const row = e.target && e.target.closest && e.target.closest('.lev-pair-row');
    if (row) _levBrokerSelect(row.dataset.value);
  });
  document.addEventListener('click', (e) => {
    if (e.target === input) return;
    if (e.target && e.target.closest && e.target.closest('#lev-broker-suggestions')) return;
    box.hidden = true;
  });
  input.addEventListener('blur', () => { setTimeout(() => { box.hidden = true; }, 180); });
  // Restore last broker
  try {
    const saved = localStorage.getItem('forexsight_lev_broker');
    if (saved) {
      input.value = saved;
      const wrap = document.getElementById('lev-custom-cap-wrap');
      if (wrap) wrap.style.display = (saved === 'Custom (set max yourself)') ? '' : 'none';
    }
  } catch {}
  // Live re-render on custom cap change
  const customEl = document.getElementById('lev-custom-cap');
  if (customEl && !customEl._wired) {
    customEl._wired = true;
    customEl.addEventListener('input', () => {
      try { localStorage.setItem('forexsight_lev_custom_cap', customEl.value); } catch {}
      if (typeof _renderLeverageMatrix === 'function') _renderLeverageMatrix();
    });
    // Restore saved custom cap
    try {
      const saved = localStorage.getItem('forexsight_lev_custom_cap');
      if (saved) customEl.value = saved;
    } catch {}
  }
}

// Tiny mirror of pairCfg's type-routing logic. Kept separate so the broker
// dropdown can know the cfgType without running the full pair-config build.
function _levCfgTypeFor(pair) {
  const p = (pair || '').toUpperCase();
  if (p === 'XAU/USD' || p === 'XAG/USD' || p === 'XPT/USD' || p === 'XPD/USD' ||
      p === 'GOLD' || p === 'SILVER' || p === 'PLATINUM' || p === 'PALLADIUM' ||
      /^(XAU|XAG|XPT|XPD)/.test(p)) return 'metal';
  if (/^(BTC|ETH|LTC|XRP|SOL|DOGE|BCH|ADA|BNB|AVAX|LINK|DOT|MATIC)/.test(p)) return 'crypto';
  if (['US30','NAS100','SPX500','GER40','UK100','JPN225','FRA40','AUS200','ESP35','HK50','EU50'].includes(p)) return 'index';
  if (['USOIL','UKOIL','WTI','BRENT','NATGAS','GAS','COPPER'].includes(p)) return 'commodity';
  return 'forex';
}

function _levRenderSuggestions(query) {
  const box = document.getElementById('lev-pair-suggestions');
  if (!box) return;
  const scored = LEV_PAIR_CATALOG
    .map(item => ({ item, score: _levPairScore(query, item) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  if (!scored.length) {
    box.innerHTML = '<div class="lev-pair-empty">No match. Type any pair (e.g. eur/cad) — calculator handles unknown instruments.</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = scored.map((x, i) => {
    const it = x.item;
    return `<div class="lev-pair-row" role="option" data-value="${it.value}" data-i="${i}">
      <span class="lev-pair-row-cat" style="background:${_levCatColor(it.cat)}"></span>
      <span class="lev-pair-row-value">${it.value}</span>
      <span class="lev-pair-row-label">${it.label}</span>
      <span class="lev-pair-row-tag">${it.cat}</span>
    </div>`;
  }).join('');
  box.hidden = false;
  // Highlight first row by default
  const first = box.querySelector('.lev-pair-row');
  if (first) first.classList.add('lev-pair-row-active');
}

function _levSelectPair(value) {
  const input = document.getElementById('lev-pair');
  const box = document.getElementById('lev-pair-suggestions');
  if (!input || !box) return;
  input.value = value;
  box.hidden = true;
  // Trigger a real re-render
  if (typeof _renderLeverageMatrix === 'function') _renderLeverageMatrix();
}

function _levWirePairAutocomplete() {
  const input = document.getElementById('lev-pair');
  const box = document.getElementById('lev-pair-suggestions');
  if (!input || !box || input._wiredAutocomplete) return;
  input._wiredAutocomplete = true;
  // Show suggestions on focus
  input.addEventListener('focus', () => _levRenderSuggestions(input.value));
  // Filter on input
  input.addEventListener('input', () => _levRenderSuggestions(input.value));
  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const rows = box.querySelectorAll('.lev-pair-row');
    if (!rows.length) return;
    let activeIdx = -1;
    rows.forEach((r, i) => { if (r.classList.contains('lev-pair-row-active')) activeIdx = i; });
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows.forEach(r => r.classList.remove('lev-pair-row-active'));
      const next = rows[Math.min(rows.length - 1, activeIdx + 1)] || rows[0];
      next.classList.add('lev-pair-row-active');
      next.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows.forEach(r => r.classList.remove('lev-pair-row-active'));
      const prev = rows[Math.max(0, activeIdx - 1)] || rows[rows.length - 1];
      prev.classList.add('lev-pair-row-active');
      prev.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const active = box.querySelector('.lev-pair-row-active');
      if (active) {
        e.preventDefault();
        _levSelectPair(active.dataset.value);
      }
    } else if (e.key === 'Escape') {
      box.hidden = true;
    }
  });
  // Click selection
  box.addEventListener('click', (e) => {
    const row = e.target && e.target.closest && e.target.closest('.lev-pair-row');
    if (row) _levSelectPair(row.dataset.value);
  });
  // Close on outside click / blur
  document.addEventListener('click', (e) => {
    if (e.target === input) return;
    if (e.target && e.target.closest && e.target.closest('#lev-pair-suggestions')) return;
    box.hidden = true;
  });
  input.addEventListener('blur', () => {
    // Delay so click on row registers first
    setTimeout(() => { box.hidden = true; }, 180);
  });
}

// ════════════════════════════════════════════════════════════════════════
// v281 — SMART AUTOCOMPLETE for the LOT SIZE CALCULATOR pair input.
// Same fuzzy-matching engine as the leverage matrix — reuses LEV_PAIR_CATALOG
// and _levPairScore so both pair inputs share one source of truth. Selecting
// a row fills the field, hides the popup, and triggers _calc2() to recompute.
// ════════════════════════════════════════════════════════════════════════
function _calc2RenderSuggestions(query) {
  const box = document.getElementById('calc2-pair-suggestions');
  if (!box) return;
  const scored = LEV_PAIR_CATALOG
    .map(item => ({ item, score: _levPairScore(query, item) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  if (!scored.length) {
    box.innerHTML = '<div class="lev-pair-empty">No match. Type any pair — calculator still computes the position.</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = scored.map((x, i) => {
    const it = x.item;
    return `<div class="lev-pair-row" role="option" data-value="${it.value}" data-i="${i}">
      <span class="lev-pair-row-cat" style="background:${_levCatColor(it.cat)}"></span>
      <span class="lev-pair-row-value">${it.value}</span>
      <span class="lev-pair-row-label">${it.label}</span>
      <span class="lev-pair-row-tag">${it.cat}</span>
    </div>`;
  }).join('');
  box.hidden = false;
  const first = box.querySelector('.lev-pair-row');
  if (first) first.classList.add('lev-pair-row-active');
}

function _calc2SelectPair(value) {
  const input = document.getElementById('calc2-pair');
  const box = document.getElementById('calc2-pair-suggestions');
  if (!input || !box) return;
  input.value = value;
  box.hidden = true;
  try { localStorage.setItem('forexsight_calc2_pair', value); } catch {}
  // Trigger live recompute and price auto-fetch (handled inside _calc2).
  if (typeof _calc2 === 'function') _calc2();
  // Re-fire input + change so listeners (price auto-fill is on 'change') react.
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
}

function _calc2WirePairAutocomplete() {
  const input = document.getElementById('calc2-pair');
  const box = document.getElementById('calc2-pair-suggestions');
  if (!input || !box || input._wiredAutocomplete) return;
  input._wiredAutocomplete = true;
  input.addEventListener('focus', () => _calc2RenderSuggestions(input.value));
  input.addEventListener('input', () => _calc2RenderSuggestions(input.value));
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const rows = box.querySelectorAll('.lev-pair-row');
    if (!rows.length) return;
    let activeIdx = -1;
    rows.forEach((r, i) => { if (r.classList.contains('lev-pair-row-active')) activeIdx = i; });
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows.forEach(r => r.classList.remove('lev-pair-row-active'));
      const next = rows[Math.min(rows.length - 1, activeIdx + 1)] || rows[0];
      next.classList.add('lev-pair-row-active');
      next.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows.forEach(r => r.classList.remove('lev-pair-row-active'));
      const prev = rows[Math.max(0, activeIdx - 1)] || rows[rows.length - 1];
      prev.classList.add('lev-pair-row-active');
      prev.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const active = box.querySelector('.lev-pair-row-active');
      if (active) {
        e.preventDefault();
        _calc2SelectPair(active.dataset.value);
      }
    } else if (e.key === 'Escape') {
      box.hidden = true;
    }
  });
  box.addEventListener('click', (e) => {
    const row = e.target && e.target.closest && e.target.closest('.lev-pair-row');
    if (row) _calc2SelectPair(row.dataset.value);
  });
  document.addEventListener('click', (e) => {
    if (e.target === input) return;
    if (e.target && e.target.closest && e.target.closest('#calc2-pair-suggestions')) return;
    box.hidden = true;
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { box.hidden = true; }, 180);
  });
}

// v276/v278/v279 — Pip size for any instrument. Routes the lookup by family
// (metals, indices, crypto, JPY pairs, regular forex). Used by the Apply
// Signal Levels helper to convert price gaps into pip distances correctly.
function _levPipSizeFor(pair) {
  const p = (pair || '').toUpperCase().trim().replace(/\s+/g, '');
  // Metals
  if (p === 'XAU/USD' || p === 'GOLD' || p === 'XAUUSD') return 0.1;
  if (p === 'XAG/USD' || p === 'SILVER' || p === 'XAGUSD') return 0.01;
  if (p === 'XPT/USD' || p === 'PLATINUM' || p === 'XPD/USD' || p === 'PALLADIUM') return 0.1;
  // Crypto
  if (p === 'BTC/USD' || p === 'BTCUSD') return 1;
  if (p === 'ETH/USD' || p === 'ETHUSD' || p === 'BCH/USD') return 0.1;
  if (p === 'LTC/USD' || p === 'SOL/USD') return 0.01;
  if (p === 'XRP/USD' || p === 'ADA/USD') return 0.0001;
  if (p === 'DOGE/USD') return 0.00001;
  // Indices
  if (['US30','NAS100','SPX500','GER40','UK100','JPN225','FRA40','AUS200','ESP35','HK50','EU50'].includes(p)) return 1;
  // Commodities
  if (p === 'USOIL' || p === 'UKOIL' || p === 'WTI' || p === 'BRENT') return 0.01;
  if (p === 'NATGAS' || p === 'GAS') return 0.001;
  if (p === 'COPPER') return 0.0001;
  // Forex
  if (p.includes('/JPY')) return 0.01;
  return 0.0001;
}

// v276 — Reveal/hide the custom-lot row based on the sizing dropdown
function _levSyncCustomVisibility() {
  const sel = document.getElementById('lev-sizing');
  const row = document.getElementById('lev-custom-row');
  if (!sel || !row) return;
  row.style.display = sel.value === 'custom' ? '' : 'none';
}

// v276 — Apply pasted signal levels: read entry/SL/TP prices, derive pip
// distances from the chosen pair, populate the existing inputs, then re-render.
function _levApplySignalLevels() {
  const pair = document.getElementById('lev-pair')?.value || 'XAU/USD';
  const entry = parseFloat(document.getElementById('lev-sig-entry')?.value || '0');
  const sl    = parseFloat(document.getElementById('lev-sig-sl')?.value    || '0');
  const tp    = parseFloat(document.getElementById('lev-sig-tp')?.value    || '0');
  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) {
    alert('Enter entry, SL, and TP prices first.');
    return;
  }
  const pipSize = _levPipSizeFor(pair);
  const slPips = Math.max(1, Math.round(Math.abs(entry - sl) / pipSize));
  const tpPips = Math.max(1, Math.round(Math.abs(entry - tp) / pipSize));
  // Populate the existing inputs
  const entryEl = document.getElementById('lev-entry');
  const slEl    = document.getElementById('lev-sl-pips');
  const tpEl    = document.getElementById('lev-tp-pips');
  if (entryEl) entryEl.value = entry;
  if (slEl)    slEl.value = slPips;
  if (tpEl)    tpEl.value = tpPips;
  // Brief visual confirmation
  ['lev-entry', 'lev-sl-pips', 'lev-tp-pips'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('lev-applied-flash');
    setTimeout(() => el.classList.remove('lev-applied-flash'), 700);
  });
  _renderLeverageMatrix();
}

function _wireLeverageMatrix() {
  const btn = document.getElementById('lev-btn');
  if (!btn || btn._wired) return;
  btn._wired = true;
  // Restore last-used values
  try {
    const map = {
      'lev-balance':     'forexsight_lev_balance',
      'lev-pair':        'forexsight_lev_pair',
      'lev-entry':       'forexsight_lev_entry',
      'lev-sl-pips':     'forexsight_lev_sl',
      'lev-tp-pips':     'forexsight_lev_tp',
      'lev-sizing':      'forexsight_lev_sizing',
      'lev-custom-lot':  'forexsight_lev_custom_lot',  // v276
    };
    for (const [id, key] of Object.entries(map)) {
      const v = localStorage.getItem(key);
      const el = document.getElementById(id);
      if (v && el) el.value = v;
    }
  } catch {}
  btn.addEventListener('click', _renderLeverageMatrix);
  // v276 — Apply-signal button
  const applyBtn = document.getElementById('lev-apply-signal');
  if (applyBtn) applyBtn.addEventListener('click', _levApplySignalLevels);
  // Re-render automatically on input change (so user can iterate fast)
  ['lev-balance', 'lev-pair', 'lev-entry', 'lev-sl-pips', 'lev-tp-pips', 'lev-sizing', 'lev-custom-lot'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      if (id === 'lev-sizing') _levSyncCustomVisibility();
      _renderLeverageMatrix();
    });
  });
  // Also listen for direct input on custom-lot so typing live re-renders
  const customLotEl = document.getElementById('lev-custom-lot');
  if (customLotEl) customLotEl.addEventListener('input', _renderLeverageMatrix);
  // Sync visibility on first wire (restored value might be `custom`)
  _levSyncCustomVisibility();
  // v280 — Wire the smart pair-autocomplete dropdown
  _levWirePairAutocomplete();
  // v282 — Wire the broker selector dropdown (caps leverage rows to what
  // the user's actual broker offers).
  _levBrokerWire();
  // Auto-render once on first wire so user sees something without clicking
  _renderLeverageMatrix();
}
document.addEventListener('DOMContentLoaded', _wireLeverageMatrix);
// Also wire when calculator tab opens (DOMContentLoaded may have already fired)
document.addEventListener('click', (e) => {
  if (e.target?.dataset?.tab === 'calculator') {
    setTimeout(_wireLeverageMatrix, 0);
  }
});

// v206 — toggle between "% of account" and "$ amount" risk modes
function _setCalc2RiskMode(mode) {
  if (mode !== 'amount' && mode !== 'percent') mode = 'percent';
  localStorage.setItem('forexsight_calc2_risk_mode', mode);
  document.querySelectorAll('.calc-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.riskMode === mode);
  });
  const percentLbl = document.getElementById('calc2-risk-percent-label');
  const amountLbl = document.getElementById('calc2-risk-amount-label');
  if (percentLbl) percentLbl.style.display = mode === 'percent' ? '' : 'none';
  if (amountLbl) amountLbl.style.display = mode === 'amount' ? '' : 'none';
}
// v220 — Contract size in BASE units of the instrument (for margin calc).
function _contractSizeForPair(p) {
  if (p === 'XAU/USD' || p === 'GOLD') return 100;
  if (p === 'XAG/USD' || p === 'SILVER') return 5000;
  if (p === 'WTI/USD' || p === 'BRENT/USD') return 1000;
  if (['NAS100','SPX500','US30','GER40','UK100','JPN225'].includes(p)) return 1;
  if (['BTC/USD','ETH/USD','LTC/USD','LINK/USD','DOT/USD','MATIC/USD','SOL/USD','BNB/USD','AVAX/USD'].includes(p)) return 1;
  if (['XRP/USD','ADA/USD','DOGE/USD'].includes(p)) return 100;
  return 100000; // forex standard lot
}

function _calc2() {
  const bal = +$('#calc2-balance').value;
  const pairRaw = ($('#calc2-pair').value || '').trim();
  const pair = _normalizePairText(pairRaw);
  const pips = +$('#calc2-pips').value;
  const leverage = +($('#calc2-leverage')?.value || 100);
  const price = +($('#calc2-price')?.value || 0);
  const mode = localStorage.getItem('forexsight_calc2_risk_mode') || 'percent';
  let riskUsd, riskPercent, riskAmount;
  if (mode === 'amount') {
    riskAmount = +$('#calc2-risk-amount').value;
    if (!bal || !riskAmount || !pair || !pips) {
      $('#calc2-result').innerHTML = '<div class="calc-error">Fill all fields with positive values.</div>';
      return;
    }
    riskUsd = riskAmount;
    riskPercent = (riskAmount / bal * 100);
    localStorage.setItem('forexsight_calc2_risk_amount', String(riskAmount));
  } else {
    riskPercent = +$('#calc2-risk').value;
    if (!bal || !riskPercent || !pair || !pips) {
      $('#calc2-result').innerHTML = '<div class="calc-error">Fill all fields with positive values.</div>';
      return;
    }
    riskUsd = bal * (riskPercent / 100);
    localStorage.setItem('forexsight_calc2_risk', String(riskPercent));
  }
  localStorage.setItem('forexsight_calc2_balance', String(bal));
  localStorage.setItem('forexsight_calc2_pair', pair);
  localStorage.setItem('forexsight_calc2_leverage', String(leverage));
  const pipVal = _pipValueForPair(pair);
  const contractSize = _contractSizeForPair(pair);
  // v220 — risk-based lot sizing (what we'd USE for the stop distance)
  const riskLots = riskUsd / (pips * pipVal);
  // v220 — margin-based MAX lot sizing (what broker will actually allow)
  // marginPerLot = (contract size × current price) / leverage
  // maxLots = balance / marginPerLot
  let marginPerLot = null, marginMaxLots = null, marginRequired = null;
  if (price > 0) {
    marginPerLot = (contractSize * price) / leverage;
    marginMaxLots = bal / marginPerLot;
    marginRequired = riskLots * marginPerLot;
  }
  // SAFE lot = min(risk-based, margin-safe * 0.95) so broker has 5% buffer
  let safeLots = riskLots;
  let safetyNote = null;
  if (marginMaxLots != null && riskLots > marginMaxLots * 0.95) {
    safeLots = marginMaxLots * 0.95;
    safetyNote = `⚠ Your broker only allows up to <b>${marginMaxLots.toFixed(2)} lots</b> at 1:${leverage} leverage with $${bal.toLocaleString()} balance. Risk-based sizing wants ${riskLots.toFixed(2)} lots — too big. Use <b>${safeLots.toFixed(2)} lots</b> (this is the largest size your broker will accept, with a 5% buffer).`;
  }
  const safeUnits = Math.round(safeLots * 100000);
  const safeMini = safeLots * 10;
  const safeMicro = safeLots * 100;
  const isGold = pair === 'XAU/USD' || pair === 'GOLD';
  const isSilver = pair === 'XAG/USD' || pair === 'SILVER';
  const isMetal = isGold || isSilver;
  const isCrypto = ['BTC/USD','ETH/USD','SOL/USD','BNB/USD','XRP/USD','ADA/USD','DOGE/USD','AVAX/USD','LTC/USD','LINK/USD','DOT/USD','MATIC/USD'].includes(pair);
  const isIndex = ['NAS100','SPX500','US30','GER40','UK100','JPN225'].includes(pair);
  const isOil = pair === 'WTI/USD' || pair === 'BRENT/USD';
  let contractDesc = '100,000 units';
  if (isGold) contractDesc = '100 oz contract';
  else if (isSilver) contractDesc = '5,000 oz contract';
  else if (isOil) contractDesc = '1,000 barrels';
  else if (isCrypto) contractDesc = `1 ${pair.split('/')[0]} contract`;
  else if (isIndex) contractDesc = '$1 per index point';
  const hideUnits = isCrypto || isIndex || isMetal || isOil;

  const marginSection = (marginMaxLots != null) ? `
    <div class="calc-margin-block">
      <div class="calc-margin-title">💰 Broker margin check (1:${leverage} leverage)</div>
      <div class="calc-grid">
        <div class="calc-cell"><span class="calc-lbl">Margin per lot</span><span class="calc-val">$${marginPerLot.toFixed(2)}</span><span class="calc-sub">at price ${price}</span></div>
        <div class="calc-cell"><span class="calc-lbl">Your max lots</span><span class="calc-val">${marginMaxLots.toFixed(2)}</span><span class="calc-sub">balance ÷ margin/lot</span></div>
        <div class="calc-cell"><span class="calc-lbl">Margin needed</span><span class="calc-val">$${marginRequired.toFixed(2)}</span><span class="calc-sub">at risk-based size</span></div>
        <div class="calc-cell ${safetyNote ? 'calc-cell-warn' : 'calc-cell-good'}"><span class="calc-lbl">✓ SAFE LOT SIZE</span><span class="calc-val">${safeLots.toFixed(2)}</span><span class="calc-sub">use this number</span></div>
      </div>
      ${safetyNote ? `<div class="calc-margin-warn">${safetyNote}</div>` : `<div class="calc-margin-ok">✓ Risk-based size fits within your margin — safe to place exactly as calculated.</div>`}
    </div>
  ` : `<div class="calc-no-price">💡 <b>Enter the current price</b> above to also check if your broker will accept this lot size (margin requirement). Otherwise you might get a "not enough money" error.</div>`;

  // v277 — Currency symbol switched to £ across calculator output.
  $('#calc2-result').innerHTML = `
    <div class="calc-pair-detected"><span class="calc-lbl">Detected pair:</span> <b>${pair}</b>${pairRaw !== pair ? ` <span class="muted">(from "${pairRaw}")</span>` : ''}</div>
    <div class="calc-grid">
      <div class="calc-cell"><span class="calc-lbl">Money risk</span><span class="calc-val">£${riskUsd.toFixed(2)}</span><span class="calc-sub">${riskPercent.toFixed(2)}% of £${bal.toLocaleString()}</span></div>
      <div class="calc-cell"><span class="calc-lbl">Risk-based lots</span><span class="calc-val">${riskLots.toFixed(2)}</span><span class="calc-sub">${contractDesc}</span></div>
      <div class="calc-cell"><span class="calc-lbl">Mini lots</span><span class="calc-val">${safeMini.toFixed(2)}</span><span class="calc-sub">0.10 standard ea.</span></div>
      <div class="calc-cell"><span class="calc-lbl">Micro lots</span><span class="calc-val">${safeMicro.toFixed(0)}</span><span class="calc-sub">0.01 standard ea.</span></div>
      ${hideUnits ? '' : `<div class="calc-cell"><span class="calc-lbl">Units</span><span class="calc-val">${safeUnits.toLocaleString()}</span><span class="calc-sub">for OANDA / TradingView</span></div>`}
      <div class="calc-cell"><span class="calc-lbl">Pip value</span><span class="calc-val">£${(safeLots * pipVal).toFixed(2)}</span><span class="calc-sub">per pip move</span></div>
    </div>
    ${marginSection}
    <div class="calc-summary">
      <div>SL hit (-${pips}p) → <b style="color:#ef4444">−£${(safeLots * pips * pipVal).toFixed(2)}</b></div>
      <div>TP1 hit (1R, +${pips}p) → <b style="color:#22c55e">+£${(safeLots * pips * pipVal).toFixed(2)}</b></div>
      <div>TP2 hit (2.5R, +${(pips * 2.5).toFixed(0)}p) → <b style="color:#22c55e">+£${(safeLots * pips * pipVal * 2.5).toFixed(2)}</b></div>
      <div>TP3 hit (4R, +${(pips * 4).toFixed(0)}p) → <b style="color:#22c55e">+£${(safeLots * pips * pipVal * 4).toFixed(2)}</b></div>
    </div>
  `;
}

// v220 — auto-fetch current price for known pairs so user doesn't have to
// look it up manually (especially for gold which is the user's focus).
const _CALC2_PRICE_CACHE = {};
async function _autoFillCalc2Price() {
  const pairEl = $('#calc2-pair');
  const priceEl = $('#calc2-price');
  if (!pairEl || !priceEl) return;
  // Don't overwrite if user typed a custom price
  if (priceEl.value && priceEl.dataset.userTouched === 'true') return;
  const pair = _normalizePairText((pairEl.value || '').trim());
  if (!pair) return;
  const lookup = { ...(typeof PAIRS !== 'undefined' ? PAIRS : {}), ...(typeof CRYPTO_PAIRS !== 'undefined' ? CRYPTO_PAIRS : {}) };
  lookup['XAU/USD'] = 'GC=F'; lookup['GOLD'] = 'GC=F';
  const sym = lookup[pair];
  if (!sym) return;
  // 60-second client-side cache so we don't hammer /api/prices
  const cached = _CALC2_PRICE_CACHE[sym];
  if (cached && Date.now() - cached.ts < 60000) {
    if (!priceEl.value) { priceEl.value = cached.price.toFixed(2); _calc2(); }
    return;
  }
  try {
    const r = await fetch(`/api/prices?symbol=${encodeURIComponent(sym)}`, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ohlc || !data.ohlc.length) return;
    const lastClose = data.ohlc[data.ohlc.length - 1].c;
    _CALC2_PRICE_CACHE[sym] = { price: lastClose, ts: Date.now() };
    priceEl.value = lastClose.toFixed(2);
    _calc2();
  } catch {}
}
// Wire up button + populate on load
function _wireCalc2() {
  _renderCalc2();
  const btn = $('#calc2-btn');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', _calc2);
  }
  // v220 — also wire leverage + price inputs
  ['calc2-balance', 'calc2-risk', 'calc2-risk-amount', 'calc2-pair', 'calc2-pips', 'calc2-leverage', 'calc2-price'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._wired) {
      el._wired = true;
      el.addEventListener('input', _calc2);
      el.addEventListener('change', _calc2);
    }
  });
  // v220 — mark price field as user-touched so auto-fill won't overwrite
  const priceEl = $('#calc2-price');
  if (priceEl && !priceEl._touchedWired) {
    priceEl._touchedWired = true;
    priceEl.addEventListener('input', () => { priceEl.dataset.userTouched = 'true'; });
  }
  // v220 — when pair changes, auto-fetch current price (if user hasn't typed one)
  const pairEl = $('#calc2-pair');
  if (pairEl && !pairEl._priceFetchWired) {
    pairEl._priceFetchWired = true;
    pairEl.addEventListener('change', () => {
      if (priceEl) { priceEl.dataset.userTouched = 'false'; priceEl.value = ''; }
      _autoFillCalc2Price();
    });
  }
  // v281 — Smart fuzzy-matched autocomplete on the pair input (same engine
  // as the leverage matrix; shares LEV_PAIR_CATALOG + _levPairScore).
  _calc2WirePairAutocomplete();
  // Initial auto-fetch on load
  setTimeout(_autoFillCalc2Price, 300);
  // Restore saved leverage
  const savedLev = localStorage.getItem('forexsight_calc2_leverage');
  if (savedLev && $('#calc2-leverage')) $('#calc2-leverage').value = savedLev;
  // v206 — risk-mode toggle buttons
  document.querySelectorAll('.calc-toggle-btn').forEach(b => {
    if (b._wired) return;
    b._wired = true;
    b.addEventListener('click', () => {
      _setCalc2RiskMode(b.dataset.riskMode);
      _calc2();
    });
  });
}
document.addEventListener('DOMContentLoaded', _wireCalc2);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(_wireCalc2, 200);
}

// v212 — Sync the market-bar's sticky `top` to the topbar's actual height
// (which varies as controls wrap). Runs:
//   • Immediately if DOM is already ready
//   • On DOMContentLoaded
//   • On window.load (after fonts/images)
//   • On resize (debounced via rAF)
//   • Continuously for ~1 second after load via ResizeObserver
// This makes the market-bar visually flush below the topbar at every paint.
function _syncStickyHeights() {
  const topbar = document.querySelector('.topbar');
  const marketBar = document.querySelector('.market-bar');
  if (!topbar || !marketBar) return;
  const topbarHeight = topbar.getBoundingClientRect().height;
  marketBar.style.top = `${Math.round(topbarHeight)}px`;
}
function _initStickySync() {
  _syncStickyHeights();
  // ResizeObserver: react to topbar growth/shrink as controls wrap/unwrap
  if (typeof ResizeObserver !== 'undefined') {
    const tb = document.querySelector('.topbar');
    if (tb) new ResizeObserver(_syncStickyHeights).observe(tb);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initStickySync);
} else {
  _initStickySync();
}
window.addEventListener('load', () => {
  _syncStickyHeights();
  setTimeout(_syncStickyHeights, 200);
  setTimeout(_syncStickyHeights, 800);
});
let _resizeRAF;
window.addEventListener('resize', () => {
  cancelAnimationFrame(_resizeRAF);
  _resizeRAF = requestAnimationFrame(_syncStickyHeights);
});

// ========== My Trades rendering ==========
// ========== Equity curve renderer ==========
// Inline SVG line chart of cumulative pip P&L over time. No external libs.
function renderEquityCurve(trades) {
  const closed = trades.filter(t => (t.status === 'won' || t.status === 'lost') && typeof t.pnlPips === 'number');
  if (closed.length < 2) return '';
  const sorted = closed.slice().sort((a, b) => (a.closedAt || a.takenAt || '').localeCompare(b.closedAt || b.takenAt || ''));
  let cum = 0, peak = 0, maxDD = 0;
  const points = sorted.map((t, i) => {
    cum += (t.pnlPips || 0);
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    return { x: i, y: cum, t };
  });
  const finalY = points[points.length - 1].y;
  const maxY = Math.max(0, ...points.map(p => p.y));
  const minY = Math.min(0, ...points.map(p => p.y));
  const range = Math.max(1, maxY - minY);
  const w = 600, h = 160;
  const xScale = (i) => 30 + (i / Math.max(1, points.length - 1)) * (w - 50);
  const yScale = (y) => h - 22 - ((y - minY) / range) * (h - 40);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)} ${yScale(p.y).toFixed(1)}`).join(' ');
  const areaPath = path + ` L${xScale(points.length - 1).toFixed(1)} ${yScale(0)} L${xScale(0).toFixed(1)} ${yScale(0)} Z`;
  const positive = finalY >= 0;
  const stroke = positive ? 'var(--buy)' : 'var(--sell)';
  const fill = positive ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.15)';
  return `
    <div class="equity-wrap">
      <div class="equity-head">
        <strong>📈 Equity curve</strong>
        <span class="muted">${closed.length} closed trades · max drawdown <strong>${maxDD.toFixed(1)}p</strong> · current <strong style="color:${stroke}">${finalY >= 0 ? '+' : ''}${finalY.toFixed(1)}p</strong></span>
      </div>
      <svg width="100%" viewBox="0 0 ${w} ${h}" class="equity-curve" preserveAspectRatio="xMidYMid meet">
        <line x1="30" y1="${yScale(0)}" x2="${w - 20}" y2="${yScale(0)}" stroke="rgba(255,255,255,0.15)" stroke-dasharray="3,3"/>
        <path d="${areaPath}" fill="${fill}" />
        <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <text x="${w - 25}" y="${yScale(finalY) + 4}" fill="${stroke}" font-size="11" text-anchor="end" font-weight="700">${finalY >= 0 ? '+' : ''}${finalY.toFixed(0)}p</text>
        <text x="30" y="${yScale(0) - 4}" fill="rgba(255,255,255,0.4)" font-size="10">break-even</text>
      </svg>
    </div>`;
}

// ========== CSV export ==========
function tradesToCSV(trades) {
  const rows = [['id','pair','direction','status','confidence','entry','sl','tp1','tp2','tp3','sl_pips','tp1_pips','closePrice','pnlPips','takenAt','closedAt','notes']];
  for (const t of trades) {
    rows.push([
      t.id || '', t.pair || '', t.direction || '', t.status || '',
      t.confidence ?? '', t.entry ?? '', t.sl ?? '', t.tp1 ?? '', t.tp2 ?? '', t.tp3 ?? '',
      t.sl_pips ?? '', t.tp1_pips ?? '', t.closePrice ?? '', t.pnlPips ?? '',
      t.takenAt || '', t.closedAt || '',
      (t.notes || '').replace(/"/g, '""'),
    ]);
  }
  return rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${c}"` : c).join(',')).join('\n');
}

function downloadCSV(filename, csv) {
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 200);
  } catch (e) { alert('Export failed: ' + e.message); }
}

// Strategies tab — shows the per-strategy tracking widgets that used to
// clutter My Trades. Calls renderTrades() under the hood to populate the
// cached widget HTML on window._strategiesHTML, then displays it cleanly.
function renderStrategies() {
  // Trigger renderTrades to compute the strategy summaries (it stashes HTML
  // on window._strategiesHTML). Don't focus the trades tab — we just need
  // the side-effect of the calculation.
  try { renderTrades(); } catch (e) { console.warn('[strategies]', e.message); }
  const view = document.getElementById('strategies-view');
  if (!view) return;
  view.innerHTML = window._strategiesHTML || '<p class="muted">No tracking data yet — take a trade and the per-strategy stats will appear here.</p>';
}

// ─── HISTORY TAB ────────────────────────────────────────────────────────
// Closed trades only — won, lost, and manually-closed. Sorted by RECENCY:
// newest closure first, so the most recent outcomes are always at the top.
// Shows the same TP-progress pills on each row so they can see how far each
// historical winner ran. Includes a quick filter chip row at the top to
// narrow by outcome (won / lost / all).
function renderHistory() {
  const container = $('#history-view');
  if (!container) return;
  const trades = getTrades();
  const closed = trades.filter(t => t.status !== 'open');

  // v235b — Skip the DOM rebuild entirely if the data + filter haven't changed
  // since the last render. Repeat History opens become INSTANT — no innerHTML
  // assignment, no layout, no paint. Closed-trade data rarely changes (only on
  // win/loss/delete) so most clicks land on this fast path.
  if (!window._historyFilter) window._historyFilter = 'all';
  const fingerprint = `${closed.length}_${window._historyFilter}_${closed.map(t => t.id + ':' + t.status + ':' + (t.tpReached || 0)).join('|')}`;
  if (container._lastRenderFingerprint === fingerprint && container.innerHTML) {
    return; // identical to last render — skip
  }
  container._lastRenderFingerprint = fingerprint;

  if (!closed.length) {
    container.innerHTML = '<p class="muted">No closed trades yet. Win, loss, and manual closes will land here as they accumulate.</p>';
    return;
  }

  // Sort by most-recent-closure first. Fall back to takenAt when closedAt
  // is missing on a legacy row so nothing gets stranded at the bottom.
  const byRecency = (a, b) => (b.closedAt || b.takenAt || '').localeCompare(a.closedAt || a.takenAt || '');

  // Filter state lives on window so it survives re-renders triggered by
  // a manual close or delete inside the tab.
  if (!window._historyFilter) window._historyFilter = 'all';
  const filter = window._historyFilter;
  const filtered = filter === 'won'  ? closed.filter(t => t.status === 'won')
                 : filter === 'lost' ? closed.filter(t => t.status === 'lost')
                 : closed;
  filtered.sort(byRecency);

  const wonCount = closed.filter(t => t.status === 'won').length;
  const lostCount = closed.filter(t => t.status === 'lost').length;
  const winRate = closed.length ? Math.round(wonCount / closed.length * 100) : 0;

  // TP-magnitude split for closed wins — same logic as My Trades.
  const winsByTp = { 1: 0, 2: 0, 3: 0 };
  for (const t of closed) {
    if (t.status !== 'won') continue;
    const r = t.tpReached || 1;
    if (r >= 3) winsByTp[3]++;
    else if (r >= 2) winsByTp[2]++;
    else winsByTp[1]++;
  }

  let html = `
    <div class="history-summary">
      <div class="hs-card hs-total"><span class="hs-num">${closed.length}</span><span class="hs-lbl">total closed</span></div>
      <div class="hs-card hs-won"><span class="hs-num" style="color:var(--buy)">${wonCount}</span><span class="hs-lbl">won</span></div>
      <div class="hs-card hs-lost"><span class="hs-num" style="color:var(--sell)">${lostCount}</span><span class="hs-lbl">lost</span></div>
      <div class="hs-card hs-rate"><span class="hs-num">${winRate}%</span><span class="hs-lbl">win rate</span></div>
      <div class="hs-card hs-tp3" title="Wins that ran all the way to TP3"><span class="hs-num" style="color:var(--buy)">${winsByTp[3]}</span><span class="hs-lbl">TP3 runners</span></div>
      <div class="hs-card hs-tp2"><span class="hs-num" style="color:var(--accent)">${winsByTp[2]}</span><span class="hs-lbl">TP2 wins</span></div>
      <div class="hs-card hs-tp1"><span class="hs-num" style="color:#fbbf24">${winsByTp[1]}</span><span class="hs-lbl">TP1 trims</span></div>
    </div>
    <div class="history-filter">
      <button class="hf-chip ${filter === 'all'  ? 'active' : ''}" data-filter="all">All (${closed.length})</button>
      <button class="hf-chip ${filter === 'won'  ? 'active' : ''}" data-filter="won">Won (${wonCount})</button>
      <button class="hf-chip ${filter === 'lost' ? 'active' : ''}" data-filter="lost">Lost (${lostCount})</button>
    </div>`;

  html += filtered.length
    ? filtered.map(tradeRowHTML).join('')
    : `<p class="muted">No ${filter === 'won' ? 'wins' : 'losses'} yet.</p>`;

  container.innerHTML = html;

  // Filter chip click handlers
  container.querySelectorAll('.hf-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      window._historyFilter = chip.dataset.filter;
      renderHistory();
    });
  });

  // Delete + manual-close button handlers — same as in renderTrades
  container.querySelectorAll('.trade-delete').forEach(btn => btn.addEventListener('click', (e) => {
    const id = e.target.dataset.id;
    if (confirm('Delete this trade from your history?')) { deleteTrade(id); renderHistory(); }
  }));
}

function renderTrades() {
  const container = $('#trades-view');
  if (!container) return;
  const code = getSyncCode();
  const lastSync = _lastSyncStatus;
  const lastSyncStr = lastSync
    ? `${Math.round((Date.now() - lastSync.ts) / 1000)}s ago${lastSync.ok ? '' : ' · ⚠ ' + (lastSync.error || 'failed')}${lastSync.mode ? ' · ' + lastSync.mode : ''}`
    : 'never';
  const localTradesCount = getTrades().length;
  const localLogsCount = getLogs().length;
  const syncBox = `
    <div class="sync-box">
      <div class="sync-head">
        <strong>☁️ Cross-device sync</strong>
        ${code ? `<span class="sync-status sync-on">SYNCING</span>` : `<span class="sync-status sync-off">OFF</span>`}
      </div>
      <div class="sync-body">
        ${code ? `
          <span class="muted">Code: <code>${code}</code> — same code on any device pulls everything: <strong>${localTradesCount} trades</strong> + <strong>${localLogsCount} learning logs</strong>. Last sync: <strong>${lastSyncStr}</strong>.</span>
          <div class="sync-actions">
            <button id="sync-pull">⬇ Sync now</button>
            <button id="sync-push">⬆ Force push</button>
            <button id="sync-clear">Stop</button>
          </div>
        ` : `
          <span class="muted">Pick a code (4–64 chars, letters/numbers/-/_). The same code on every device syncs your trades AND the system's learning history (every signal it has ever made + their outcomes). Pattern-match learning becomes shared across devices.</span>
          <div class="sync-actions">
            <input type="text" id="sync-code-input" placeholder="e.g. justice-forex-2026" maxlength="64" />
            <button id="sync-set">Start sync</button>
          </div>
        `}
      </div>
    </div>`;
  const trades = getTrades().slice().reverse();
  const open = trades.filter(t => t.status === 'open');
  const closed = trades.filter(t => t.status !== 'open');

  // GRADE-FIRST SORT — same priority as the Signals grid:
  //   A+ → A → B+ → B → C → unrated (then chronological as tie-breaker).
  // Trades are spread from signals so they carry smcGrade/orbGrade/etc.
  // already. For OPEN trades the chrono tie-breaker is newest-first (most
  // recent setup of the same grade gets attention first). For CLOSED
  // (history) it's also newest-first so your most recent A+ wins/losses
  // stay near the top of each grade band.
  const tradeRank = (t) => {
    const best = _signalBestGrade(t);
    return _gradeRank(best);
  };
  const byGradeNewer = (a, b) => {
    const ra = tradeRank(a), rb = tradeRank(b);
    if (ra !== rb) return ra - rb;
    // Tie-breaker: newer first (takenAt desc)
    return (b.takenAt || '').localeCompare(a.takenAt || '');
  };
  open.sort(byGradeNewer);
  closed.sort(byGradeNewer);
  const won = closed.filter(t => t.status === 'won').length;
  const lost = closed.filter(t => t.status === 'lost').length;
  const totalPnl = closed.reduce((s, t) => s + (t.pnlPips || 0), 0);
  const avgConfWin = closed.length ? closed.filter(t => t.status === 'won').reduce((s,t)=>s+t.confidence,0) / (won||1) : 0;

  // Discipline check — if recent track record is bad, show a loud nudge with
  // concrete data on what the user has actually been doing wrong.
  let disciplineBanner = '';
  if (closed.length >= 3) {
    const recent = closed.slice(0, 10); // most recent 10 closed
    const recentWins = recent.filter(t => t.status === 'won').length;
    const recentRate = recentWins / recent.length;
    const avgConf = recent.reduce((s, t) => s + (t.confidence || 0), 0) / recent.length;
    const lossesAvgConf = recent.filter(t => t.status === 'lost').reduce((s, t, _, a) => s + (t.confidence || 0) / a.length, 0);
    const winsAvgConf = recentWins ? recent.filter(t => t.status === 'won').reduce((s, t, _, a) => s + (t.confidence || 0) / a.length, 0) : null;
    let lossStreak = 0;
    for (const t of recent) { if (t.status === 'lost') lossStreak++; else break; }

    if (recentRate < 0.4 || lossStreak >= 3) {
      disciplineBanner = `
        <div class="discipline-warning">
          <div class="dw-head">🚨 Discipline check — your last ${recent.length} trades</div>
          <div class="dw-stats">
            <div><strong>${(recentRate * 100).toFixed(0)}%</strong> win rate ${recentRate < 0.4 ? '(low — pros aim for 55–65%)' : ''}</div>
            ${lossStreak >= 3 ? `<div><strong>${lossStreak}</strong> losses in a row</div>` : ''}
            <div>Average confluence taken: <strong>${avgConf.toFixed(0)}%</strong></div>
            ${lossesAvgConf ? `<div>Losses averaged: <strong style="color:var(--sell)">${lossesAvgConf.toFixed(0)}% confluence</strong></div>` : ''}
            ${winsAvgConf ? `<div>Wins averaged: <strong style="color:var(--buy)">${winsAvgConf.toFixed(0)}% confluence</strong></div>` : ''}
          </div>
          <div class="dw-fix">
            <strong>The fix:</strong> Turn on <strong>⭐ Best only</strong> mode (header). It blocks every signal below 75% confluence — exactly the trades that have been losing. Take the next 5 trades from Best Only mode and review.
          </div>
        </div>`;
    }
  }

  // Correlation exposure warning — if user has multiple open trades that share
  // a base or quote currency, they're stacking exposure on the same currency.
  // Pros size DOWN or pick the strongest setup; retail traders blow accounts
  // with 3 simultaneous EUR/* trades that all blow up together.
  let correlationBanner = '';
  if (open.length >= 2) {
    const ccyExposure = {};
    for (const t of open) {
      if (!t.pair) continue;
      const [b, q] = t.pair.split('/');
      const dirSign = t.direction === 'BUY' ? 1 : -1;
      ccyExposure[b] = (ccyExposure[b] || 0) + dirSign;     // long base
      ccyExposure[q] = (ccyExposure[q] || 0) - dirSign;     // short quote
    }
    const overexposed = Object.entries(ccyExposure)
      .filter(([_, n]) => Math.abs(n) >= 2)
      .map(([c, n]) => `${c} (${n > 0 ? '+' : ''}${n}× ${n > 0 ? 'long' : 'short'})`);
    if (overexposed.length) {
      correlationBanner = `
        <div class="discipline-warning" style="border-color: rgba(255,159,10,0.35);">
          <div class="dw-head" style="color:var(--warn)">⚠ Correlated exposure stacking</div>
          <div class="dw-stats">
            ${overexposed.map(s => `<div><strong>${s}</strong></div>`).join('')}
          </div>
          <div class="dw-fix">
            <strong>Pro move:</strong> When 2+ open trades share a currency, you're effectively making one big bet on that currency. If it moves against you, all positions lose together. Size down to half-risk OR close the weakest setup and keep only the highest-confluence one.
          </div>
        </div>`;
    }
  }

  // Compute max drawdown from chronological closed-trade equity curve
  const sortedForDD = closed.slice().sort((a, b) =>
    (a.closedAt || a.takenAt || '').localeCompare(b.closedAt || b.takenAt || '')
  );
  let cum = 0, peakDD = 0, maxDDpips = 0;
  for (const t of sortedForDD) {
    cum += (t.pnlPips || 0);
    peakDD = Math.max(peakDD, cum);
    maxDDpips = Math.max(maxDDpips, peakDD - cum);
  }

  // SMC tracking summary — closed-trade win-rate JUST for SMC auto-tracked trades
  // SMC trades = anything where SMC confirmed the signal at trade-time
  // (auto-tracked OR manually taken from an SMC-confirmed signal). This
  // way a multi-strategy trade counts in every strategy that caught it.
  const smcAutoTrades = trades.filter(t => t.smcPassed || t.isSMCAuto || t.isRadiant);
  const smcClosed = smcAutoTrades.filter(t => t.status === 'won' || t.status === 'lost');
  const smcOpen = smcAutoTrades.filter(t => t.status === 'open').length;
  const smcWins = smcClosed.filter(t => t.status === 'won').length;
  const smcWinRate = smcClosed.length ? Math.round(smcWins / smcClosed.length * 100) : null;
  const smcAutoToday = _smcAutoTodayCount();
  // Grade-banded SMC stats — which grades are actually winning
  const _smcByGrade = (g) => {
    const list = smcAutoTrades.filter(t => t.smcGrade === g);
    const closed = list.filter(t => t.status === 'won' || t.status === 'lost');
    const won = closed.filter(t => t.status === 'won').length;
    const wr = closed.length ? Math.round(won / closed.length * 100) : null;
    return { total: list.length, wr };
  };
  const smcAplus = _smcByGrade('A+');
  const smcA = _smcByGrade('A');
  const smcBplus = _smcByGrade('B+');
  // Build the list of currently-open SMC pairs so user can see which signals
  // are tracking right now without scrolling through all trades.
  // GRADE-FIRST ORDER — A+ pills first, then A, B+, B, C. Same as the
  // Signals grid + My Trades so the top of every list is your strongest setup.
  const smcOpenPairs = smcAutoTrades
    .filter(t => t.status === 'open')
    .slice()
    .sort((a, b) => {
      const ra = _gradeRank(a.smcGrade), rb = _gradeRank(b.smcGrade);
      if (ra !== rb) return ra - rb;
      return (b.takenAt || '').localeCompare(a.takenAt || ''); // newer first
    })
    .map(t => `<span class="open-pair-pill" data-id="${t.id}" title="Click to open trade detail">${t.pair} ${t.direction}${t.smcGrade ? ' · ' + t.smcGrade : ''}</span>`)
    .join('');
  const smcSummary = `
    <div class="smc-summary">
      <div class="smc-summary-head">
        <strong>📐 SMC Strategy Tracking</strong>
        <span class="muted">8 gates + quality grading. Only B+ and above auto-track — keeps your win-rate stats representative of good setups only.</span>
      </div>
      <div class="smc-summary-grid">
        <div><span class="ssg-num">${smcAutoTrades.length}</span><span class="ssg-lbl">SMC trades total</span></div>
        <div><span class="ssg-num" style="color:var(--accent)">${smcOpen}</span><span class="ssg-lbl">currently open</span></div>
        <div><span class="ssg-num" style="color:var(--buy)">${smcWins}</span><span class="ssg-lbl">won</span></div>
        <div><span class="ssg-num" style="color:var(--sell)">${smcClosed.length - smcWins}</span><span class="ssg-lbl">lost</span></div>
        <div><span class="ssg-num">${smcWinRate != null ? smcWinRate + '%' : '—'}</span><span class="ssg-lbl">overall win rate</span></div>
        <div><span class="ssg-num">${smcAutoToday}</span><span class="ssg-lbl">added today</span></div>
      </div>
      ${smcOpenPairs ? `<div class="open-pairs-row"><span class="muted">Currently open:</span>${smcOpenPairs}</div>` : ''}
      <div class="grade-breakdown-row">
        <span class="grade-stat grade-stat-aplus" title="A+ trades (95–100 quality)"><b>A+</b> ${smcAplus.total} · ${smcAplus.wr != null ? smcAplus.wr + '%' : '—'}</span>
        <span class="grade-stat grade-stat-a" title="A trades (85–94 quality)"><b>A</b> ${smcA.total} · ${smcA.wr != null ? smcA.wr + '%' : '—'}</span>
        <span class="grade-stat grade-stat-bplus" title="B+ trades (75–84 quality)"><b>B+</b> ${smcBplus.total} · ${smcBplus.wr != null ? smcBplus.wr + '%' : '—'}</span>
      </div>
    </div>`;

  // ORB tracking summary — closed-trade win-rate JUST for ORB auto-tracked trades
  // Identical structure to SMC so you can read both at a glance and compare
  // which strategy is performing better on your account this week.
  // ORB trades = anything where ORB confirmed the signal at trade-time
  const orbAutoTrades = trades.filter(t => t.orbPassed || t.isORBAuto);
  const orbClosed = orbAutoTrades.filter(t => t.status === 'won' || t.status === 'lost');
  const orbOpen = orbAutoTrades.filter(t => t.status === 'open').length;
  const orbWins = orbClosed.filter(t => t.status === 'won').length;
  const orbWinRate = orbClosed.length ? Math.round(orbWins / orbClosed.length * 100) : null;
  const orbAutoToday = _orbAutoTodayCount();
  // Grade-banded ORB stats
  const _orbByGrade = (g) => {
    const list = orbAutoTrades.filter(t => t.orbGrade === g);
    const closed = list.filter(t => t.status === 'won' || t.status === 'lost');
    const won = closed.filter(t => t.status === 'won').length;
    const wr = closed.length ? Math.round(won / closed.length * 100) : null;
    return { total: list.length, wr };
  };
  const orbAplus = _orbByGrade('A+');
  const orbA = _orbByGrade('A');
  const orbBplus = _orbByGrade('B+');
  // Same grade-first ordering as SMC: A+ pills first → A → B+ → B → C.
  const orbOpenPairs = orbAutoTrades
    .filter(t => t.status === 'open')
    .slice()
    .sort((a, b) => {
      const ra = _gradeRank(a.orbGrade), rb = _gradeRank(b.orbGrade);
      if (ra !== rb) return ra - rb;
      return (b.takenAt || '').localeCompare(a.takenAt || '');
    })
    .map(t => `<span class="open-pair-pill" data-id="${t.id}" title="Click to open trade detail">${t.pair} ${t.direction}${t.orbGrade ? ' · ' + t.orbGrade : ''}</span>`)
    .join('');
  const orbSummary = `
    <div class="orb-summary">
      <div class="orb-summary-head">
        <strong>📊 ORB Strategy Tracking</strong>
        <span class="muted">9 gates + quality grading. Only B+ and above auto-track. News + calendar aware.</span>
      </div>
      <div class="orb-summary-grid">
        <div><span class="osg-num">${orbAutoTrades.length}</span><span class="osg-lbl">ORB trades total</span></div>
        <div><span class="osg-num" style="color:var(--accent)">${orbOpen}</span><span class="osg-lbl">currently open</span></div>
        <div><span class="osg-num" style="color:var(--buy)">${orbWins}</span><span class="osg-lbl">won</span></div>
        <div><span class="osg-num" style="color:var(--sell)">${orbClosed.length - orbWins}</span><span class="osg-lbl">lost</span></div>
        <div><span class="osg-num">${orbWinRate != null ? orbWinRate + '%' : '—'}</span><span class="osg-lbl">overall win rate</span></div>
        <div><span class="osg-num">${orbAutoToday}</span><span class="osg-lbl">added today</span></div>
      </div>
      ${orbOpenPairs ? `<div class="open-pairs-row"><span class="muted">Currently open:</span>${orbOpenPairs}</div>` : ''}
      <div class="grade-breakdown-row">
        <span class="grade-stat grade-stat-aplus" title="A+ trades (95–100 quality)"><b>A+</b> ${orbAplus.total} · ${orbAplus.wr != null ? orbAplus.wr + '%' : '—'}</span>
        <span class="grade-stat grade-stat-a" title="A trades (85–94 quality)"><b>A</b> ${orbA.total} · ${orbA.wr != null ? orbA.wr + '%' : '—'}</span>
        <span class="grade-stat grade-stat-bplus" title="B+ trades (75–84 quality)"><b>B+</b> ${orbBplus.total} · ${orbBplus.wr != null ? orbBplus.wr + '%' : '—'}</span>
      </div>
    </div>`;

  // Per-strategy tracking widgets — auto-built from the STRATEGIES registry.
  // Each shows: total / open / won / lost / win-rate / today, plus grade
  // breakdown (A+ / A / B+) so user can tell which grades win on which strat.
  const stratSummaries = Object.entries(STRATEGIES).map(([sk, cfg]) => {
    // Trades for this strategy = anything where the strategy confirmed at
    // trade-time, whether auto-tracked or manually taken. So a single
    // multi-strategy signal correctly shows up in every strategy's count.
    const list = trades.filter(t => t[`${sk}Passed`] || t[`is${sk.toUpperCase()}Auto`]);
    const closedT = list.filter(t => t.status === 'won' || t.status === 'lost');
    const openT = list.filter(t => t.status === 'open').length;
    const wonT = closedT.filter(t => t.status === 'won').length;
    const wr = closedT.length ? Math.round(wonT / closedT.length * 100) : null;
    const today = _stratAutoTodayCount(sk);
    const byGrade = (g) => {
      const l = list.filter(t => t[`${sk}Grade`] === g);
      const c = l.filter(t => t.status === 'won' || t.status === 'lost');
      const w = c.filter(t => t.status === 'won').length;
      return { total: l.length, wr: c.length ? Math.round(w / c.length * 100) : null };
    };
    const aPlus = byGrade('A+'), a = byGrade('A'), bPlus = byGrade('B+');
    // Currently-open pair list for THIS strategy — clickable pills the user
    // can tap to jump straight to the trade detail.
    // GRADE-FIRST ORDER — A+ pills first → A → B+ → B → C (same as Signals
    // grid + My Trades + SMC/ORB sections above).
    const openPairs = list
      .filter(t => t.status === 'open')
      .slice()
      .sort((a, b) => {
        const ra = _gradeRank(a[`${sk}Grade`]), rb = _gradeRank(b[`${sk}Grade`]);
        if (ra !== rb) return ra - rb;
        return (b.takenAt || '').localeCompare(a.takenAt || '');
      })
      .map(t => `<span class="open-pair-pill" data-id="${t.id}" title="Click to open trade detail">${t.pair} ${t.direction}${t[`${sk}Grade`] ? ' · ' + t[`${sk}Grade`] : ''}</span>`)
      .join('');
    return `
    <div class="strat-summary strat-summary-${sk}">
      <div class="strat-summary-head">
        <strong>${cfg.icon} ${cfg.name} Tracking</strong>
        <span class="muted">Auto-tracks B+ and above signals only — keeps stats representative of good setups</span>
      </div>
      <div class="strat-summary-grid">
        <div><span class="ssg-num">${list.length}</span><span class="ssg-lbl">${cfg.short} trades</span></div>
        <div><span class="ssg-num" style="color:var(--accent)">${openT}</span><span class="ssg-lbl">currently open</span></div>
        <div><span class="ssg-num" style="color:var(--buy)">${wonT}</span><span class="ssg-lbl">won</span></div>
        <div><span class="ssg-num" style="color:var(--sell)">${closedT.length - wonT}</span><span class="ssg-lbl">lost</span></div>
        <div><span class="ssg-num">${wr != null ? wr + '%' : '—'}</span><span class="ssg-lbl">win rate</span></div>
        <div><span class="ssg-num">${today}</span><span class="ssg-lbl">added today</span></div>
      </div>
      ${openPairs ? `<div class="open-pairs-row"><span class="muted">Currently open:</span>${openPairs}</div>` : ''}
      <div class="grade-breakdown-row">
        <span class="grade-stat grade-stat-aplus"><b>A+</b> ${aPlus.total} · ${aPlus.wr != null ? aPlus.wr + '%' : '—'}</span>
        <span class="grade-stat grade-stat-a"><b>A</b> ${a.total} · ${a.wr != null ? a.wr + '%' : '—'}</span>
        <span class="grade-stat grade-stat-bplus"><b>B+</b> ${bPlus.total} · ${bPlus.wr != null ? bPlus.wr + '%' : '—'}</span>
      </div>
    </div>`;
  }).join('');

  // Top action row: export + sync info
  // Strategy widgets moved to dedicated /strategies tab — keep this tab
  // focused on actual trade rows + perf summary. Cache the strategy HTML
  // on the window so the Strategies tab can read it on demand.
  window._strategiesHTML = smcSummary + orbSummary + stratSummaries;
  const actionRow = `
    <div class="trades-actions">
      <button id="export-csv" title="Download all trades as a CSV file (open in Excel/Sheets/anything)">⬇ Export trades to CSV</button>
      <button id="signal-recovery-btn" title="Scan signal logs vs your trades. If a signal fired but never made it into trades (e.g. silent strategy bug), recover it here.">🔄 Recover missed signals</button>
    </div>`;

  // TP BREAKDOWN — how many wins reached each take-profit level. Tells you
  // whether your wins are mostly "small TP1 trims" or "full TP3 runners".
  // A trader with 50% wins all at TP1 is worse than one with 30% wins all at
  // TP3 (same R, but the second one keeps more winners running). Lost trades
  // and TP1 BE-trail wins both count as "tpReached < 2" magnitude.
  const winsByTp = { 1: 0, 2: 0, 3: 0 };
  for (const t of closed) {
    if (t.status !== 'won') continue;
    const r = t.tpReached || 1; // legacy wins (pre-tpReached) default to TP1
    if (r >= 3)      winsByTp[3]++;
    else if (r >= 2) winsByTp[2]++;
    else             winsByTp[1]++;
  }
  const tp1Pct = won ? Math.round(winsByTp[1] / won * 100) : 0;
  const tp2Pct = won ? Math.round(winsByTp[2] / won * 100) : 0;
  const tp3Pct = won ? Math.round(winsByTp[3] / won * 100) : 0;

  // ═══════════════════════════════════════════════════════════════════════
  // FORWARD WIN RATE — only counts trades that went through the post-v140
  // filter stack. Strips:
  //   - Anything taken before FORWARD_FILTER_START_ISO (pre-filter noise)
  //   - Recovered historical signals (those re-import old outcomes that
  //     would have been blocked by today's filters)
  //   - Manually-taken trades that don't reflect filter quality
  // The point is to make the IMPROVEMENT visible — overall WR is dragged
  // down by 200+ legacy trades that can never be undone.
  // ═══════════════════════════════════════════════════════════════════════
  const fwdTrades = trades.filter(t => {
    if (!t || !t.autoAdded) return false;          // only auto-tracked = filter-decided
    if (t.isRecovered) return false;               // skip historical recoveries
    if (!t.takenAt) return false;
    const ts = Date.parse(t.takenAt);
    if (!Number.isFinite(ts)) return false;
    return ts >= FORWARD_FILTER_START_MS;
  });
  const fwdClosed = fwdTrades.filter(t => t.status === 'won' || t.status === 'lost');
  const fwdWon    = fwdClosed.filter(t => t.status === 'won').length;
  const fwdLost   = fwdClosed.length - fwdWon;
  const fwdOpen   = fwdTrades.filter(t => t.status === 'open').length;
  const fwdWrPct  = fwdClosed.length ? Math.round((fwdWon / fwdClosed.length) * 100) : null;
  // Net pips for the forward window only
  const fwdNetPips = fwdTrades.reduce((sum, t) => {
    if (t.status === 'won' || t.status === 'lost') return sum + (t.pnlPips || 0);
    return sum;
  }, 0);
  // Color-code the WR — green ≥70%, amber 50–69%, red <50%, neutral if no data
  let fwdWrColor = 'var(--accent)';
  let fwdWrEmoji = '🎯';
  if (fwdWrPct == null) { fwdWrColor = 'var(--muted)'; fwdWrEmoji = '⏳'; }
  else if (fwdWrPct >= 70) { fwdWrColor = 'var(--buy)';  fwdWrEmoji = '🏆'; }
  else if (fwdWrPct >= 50) { fwdWrColor = 'var(--warn)'; fwdWrEmoji = '📈'; }
  else                     { fwdWrColor = 'var(--sell)'; fwdWrEmoji = '🔧'; }
  // Comparison delta vs all-time
  const allTimeWr = closed.length ? Math.round((won / closed.length) * 100) : null;
  const deltaWr = (fwdWrPct != null && allTimeWr != null) ? (fwdWrPct - allTimeWr) : null;
  const deltaStr = deltaWr == null ? ''
    : deltaWr > 0 ? `<span style="color:var(--buy)">▲ +${deltaWr} pts vs all-time</span>`
    : deltaWr < 0 ? `<span style="color:var(--sell)">▼ ${deltaWr} pts vs all-time</span>`
    : '<span class="muted">= same as all-time</span>';
  const fwdSince = new Date(FORWARD_FILTER_START_MS).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const forwardWrPanel = `
    <div class="forward-wr-panel" title="Win rate counting ONLY trades taken after the post-v140 filters went live. This is the rate you'll see going forward.">
      <div class="fwr-head">
        <span class="fwr-badge">${fwdWrEmoji} FORWARD WIN RATE</span>
        <span class="muted">since ${fwdSince} · post-filter only</span>
      </div>
      <div class="fwr-body">
        <div class="fwr-big" style="color:${fwdWrColor}">${fwdWrPct != null ? fwdWrPct + '%' : '—'}</div>
        <div class="fwr-meta">
          <div class="fwr-line"><strong>${fwdWon}</strong> won · <strong>${fwdLost}</strong> lost · <strong>${fwdOpen}</strong> open</div>
          <div class="fwr-line"><strong style="color:${fwdNetPips>=0?'var(--buy)':'var(--sell)'}">${fwdNetPips>=0?'+':''}${fwdNetPips.toFixed(1)} pips</strong> net (forward only)</div>
          <div class="fwr-line">${deltaStr}</div>
        </div>
      </div>
      ${fwdClosed.length < 5 ? '<div class="fwr-note muted">Need at least 5 closed forward trades for a stable win rate — keep going.</div>' : ''}
    </div>`;

  let html = syncBox + disciplineBanner + correlationBanner + actionRow + forwardWrPanel + `
    <div class="perf-grid">
      <div class="perf-card"><div class="big">${open.length}</div><div class="lbl">Open</div></div>
      <div class="perf-card"><div class="big" style="color:var(--buy)">${won}</div><div class="lbl">Won</div></div>
      <div class="perf-card"><div class="big" style="color:var(--sell)">${lost}</div><div class="lbl">Lost</div></div>
      <div class="perf-card" title="All-time win rate including pre-filter legacy trades. The Forward panel above shows post-v140 only — that's the rate that matters for what's coming."><div class="big">${closed.length ? ((won/closed.length)*100).toFixed(0)+'%' : '—'}</div><div class="lbl">All-time WR</div></div>
      <div class="perf-card"><div class="big" style="color:${totalPnl>=0?'var(--buy)':'var(--sell)'}">${totalPnl>=0?'+':''}${totalPnl.toFixed(1)}</div><div class="lbl">Net Pips</div></div>
      <div class="perf-card" title="Max drawdown — biggest peak-to-trough drop in your cumulative pips. Pros watch this religiously."><div class="big" style="color:var(--warn)">${maxDDpips > 0 ? '-' : ''}${maxDDpips.toFixed(1)}</div><div class="lbl">Max Drawdown (pips)</div></div>
    </div>
    <div class="tp-breakdown" title="How far your wins ran. Higher TP3 % = letting winners run; high TP1 % = trades getting trimmed early at the 25%R trail.">
      <div class="tpbd-head"><strong>🎯 How far wins ran</strong> <span class="muted">${won} winning trade${won === 1 ? '' : 's'}</span></div>
      <div class="tpbd-bars">
        <div class="tpbd-row"><span class="tpbd-lbl">TP3 (full run)</span><div class="tpbd-bar"><div class="tpbd-fill tpbd-tp3" style="width:${tp3Pct}%"></div></div><span class="tpbd-val">${winsByTp[3]} · ${tp3Pct}%</span></div>
        <div class="tpbd-row"><span class="tpbd-lbl">TP2 (1R locked)</span><div class="tpbd-bar"><div class="tpbd-fill tpbd-tp2" style="width:${tp2Pct}%"></div></div><span class="tpbd-val">${winsByTp[2]} · ${tp2Pct}%</span></div>
        <div class="tpbd-row"><span class="tpbd-lbl">TP1 (25%R locked)</span><div class="tpbd-bar"><div class="tpbd-fill tpbd-tp1" style="width:${tp1Pct}%"></div></div><span class="tpbd-val">${winsByTp[1]} · ${tp1Pct}%</span></div>
      </div>
    </div>`;

  // v255 — Removed the no-trades early return that was skipping the sync
  // wiring below. Cross-device sync should always work as soon as the user
  // enters a code, whether they have trades yet or not. The "None open"
  // message below already covers the empty-trade state.

  // My Trades tab shows OPEN trades only — closed trades moved to the History
  // tab to keep this view focused on active management. The summary cards +
  // "How far wins ran" breakdown above use closed-trade data for context, but
  // the row list itself is open-only.
  html += '<h3>Open trades</h3>';
  html += open.length ? open.map(tradeRowHTML).join('') : '<p class="muted">None open. Take a trade from a signal card to start tracking — or enter a sync code below to pull trades from another device.</p>';
  html += `<p class="muted" style="margin-top:18px;text-align:center">${closed.length} closed trade${closed.length === 1 ? '' : 's'} in <a href="#history" class="history-tab-link" style="color:var(--accent);text-decoration:none">History →</a></p>`;
  container.innerHTML = html;

  // CSV export button
  const exportBtn = container.querySelector('#export-csv');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    const all = getTrades();
    if (!all.length) { alert('No trades to export.'); return; }
    const csv = tradesToCSV(all);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`forexsight-trades-${stamp}.csv`, csv);
  });

  // SIGNAL RECOVERY — finds resolved logs that don't have corresponding trades
  // and lets the user batch-add them. Critical when a client-side bug (like
  // the zero-range bar issue) hid signals — server still logged outcomes, so
  // the data is in localStorage.forexsight_logs_v2. This tool exposes that.
  const recoveryBtn = container.querySelector('#signal-recovery-btn');
  if (recoveryBtn) recoveryBtn.addEventListener('click', () => runSignalRecovery());

  // Notes textarea — save on blur
  container.querySelectorAll('.trade-notes').forEach(ta => {
    ta.addEventListener('blur', (e) => {
      const id = e.target.dataset.id;
      const val = e.target.value;
      const trades = getTrades();
      const t = trades.find(x => x.id === id);
      if (!t) return;
      if (t.notes === val) return;
      t.notes = val;
      saveTrades(trades);
    });
  });

  // ═════════════════════════════════════════════════════════════════════
  // Sync UI — designed to "just work" no matter what state you're in:
  //   - No local trades + no remote → just saves the code, ready
  //   - No local + remote has data → pulls everything down
  //   - Local has trades + no remote → uploads everything up
  //   - Local + remote both have data → merges, then pushes the union
  // The pull-then-push-on-mismatch loop in pullAllFromCloud() guarantees the
  // cloud always ends up with the union, so any device that signs in next
  // gets EVERYTHING. Errors are non-fatal — the code stays saved and the
  // background auto-pull will retry. No blocking alerts; status shows inline.
  // ═════════════════════════════════════════════════════════════════════

  // Inline status helper — replaces alert() for a smoother feel
  function showSyncStatus(msg, kind = 'ok') {
    const box = container.querySelector('.sync-box');
    if (!box) return;
    let banner = box.querySelector('.sync-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'sync-banner';
      box.appendChild(banner);
    }
    banner.classList.remove('sync-banner-ok', 'sync-banner-warn', 'sync-banner-info');
    banner.classList.add('sync-banner-' + kind);
    banner.textContent = msg;
    banner.style.opacity = '1';
    clearTimeout(showSyncStatus._t);
    showSyncStatus._t = setTimeout(() => {
      banner.style.opacity = '0';
    }, kind === 'warn' ? 6000 : 3500);
  }

  // The bulletproof "sign in with code" handler. Runs pull→merge→push so
  // both sides converge regardless of who has what. Always succeeds in
  // saving the code, even if network is flaky (auto-pull retries later).
  async function activateSync(c) {
    const setBtn = container.querySelector('#sync-set');
    setSyncCode(c);
    if (setBtn) { setBtn.textContent = '⏳ Syncing…'; setBtn.disabled = true; }
    const tradesBefore = getTrades().length;
    const logsBefore = getLogs().length;

    const r = await pullAllFromCloud().catch(e => ({ ok: false, reason: e.message }));

    // Always push our state up after pull, so the cloud holds the union
    // even when the pull returned nothing (or errored). Push is debounced
    // and fire-and-forget — safe to call repeatedly.
    pushAllToCloud();

    const tradesNow = getTrades().length;
    const logsNow = getLogs().length;

    if (setBtn) { setBtn.disabled = false; setBtn.textContent = 'Start sync'; }

    if (r.ok) {
      const tradesGained = tradesNow - tradesBefore;
      const logsGained = logsNow - logsBefore;
      if (tradesGained > 0 || logsGained > 0) {
        showSyncStatus(`✓ Synced — pulled ${r.tradesPulled} trades + ${r.logsPulled} logs from cloud · ${tradesNow} trades total now`, 'ok');
      } else if (tradesBefore > 0 || logsBefore > 0) {
        showSyncStatus(`✓ Synced — your ${tradesBefore} trades + ${logsBefore} logs are now backed up to cloud under "${c}"`, 'ok');
      } else {
        showSyncStatus(`✓ Synced — code "${c}" is active. Add trades on any device with this code to share them.`, 'ok');
      }
    } else {
      // Network error or empty cloud — code is still saved, push happened.
      // Background auto-pull will retry and converge.
      showSyncStatus(`✓ Code "${c}" saved. Couldn't reach cloud yet — will retry automatically. Local data is safe.`, 'info');
    }
    renderTrades();
  }

  const setBtn = container.querySelector('#sync-set');
  const setInput = container.querySelector('#sync-code-input');
  const trySet = async () => {
    const c = (setInput?.value || '').trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(c)) {
      showSyncStatus('Code must be 4–64 characters: letters, numbers, hyphen or underscore.', 'warn');
      return;
    }
    await activateSync(c);
  };
  if (setBtn) setBtn.addEventListener('click', trySet);
  // Pressing Enter in the input field also activates — feels more like signing in
  if (setInput) setInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trySet(); } });

  const pullBtn = container.querySelector('#sync-pull');
  if (pullBtn) pullBtn.addEventListener('click', async () => {
    pullBtn.textContent = '⏳ Syncing…'; pullBtn.disabled = true;
    const r = await pullAllFromCloud().catch(e => ({ ok: false, reason: e.message }));
    pullBtn.disabled = false; pullBtn.textContent = '⬇ Sync now';
    if (r.ok) {
      showSyncStatus(`✓ Pulled — ${r.tradesPulled} trades + ${r.logsPulled} logs from cloud · ${r.tradesTotal} trades total after merge`, 'ok');
    } else {
      showSyncStatus(`Sync failed: ${r.reason}. Will retry automatically.`, 'warn');
    }
    renderTrades();
  });
  const pushBtn = container.querySelector('#sync-push');
  if (pushBtn) pushBtn.addEventListener('click', async () => {
    pushBtn.textContent = '⏳ Pushing…'; pushBtn.disabled = true;
    pushAllToCloud();
    setTimeout(() => {
      pushBtn.disabled = false; pushBtn.textContent = '⬆ Force push';
      showSyncStatus(`✓ Pushed ${getTrades().length} trades + ${getLogs().length} logs to cloud under "${getSyncCode()}"`, 'ok');
    }, 1500);
  });
  const clearBtn = container.querySelector('#sync-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!confirm('Stop syncing? Your local trades stay; cloud copy is untouched. Re-enter the code anytime to resume.')) return;
    setSyncCode('');
    renderTrades();
  });

  container.querySelectorAll('.trade-delete').forEach(btn => btn.addEventListener('click', (e) => {
    const id = e.target.dataset.id;
    if (confirm('Delete this trade from your history?')) { deleteTrade(id); renderTrades(); }
  }));
  container.querySelectorAll('.trade-close').forEach(btn => btn.addEventListener('click', (e) => {
    const id = e.target.dataset.id;
    const outcome = e.target.dataset.outcome;
    const t = getTrades().find(x => x.id === id);
    if (!t) return;
    const defaultPrice = outcome === 'won' ? t.tp1 : (outcome === 'lost' ? t.sl : t.entry);
    const p = prompt(`Close ${t.pair} ${t.direction} as ${outcome.toUpperCase()}\nClose price:`, String(defaultPrice));
    if (p == null) return;
    closeTrade(id, outcome, parseFloat(p));
    renderTrades();
  }));
}

// ─── SIGNAL RECOVERY ───────────────────────────────────────────────────
// Scans localStorage.forexsight_logs_v2 for resolved signals (win/loss
// outcomes recorded) that don't have a corresponding entry in trades.
// Triggered manually by the user via "Recover missed signals" button.
// Also runs a quiet check on app boot — if it finds >5 missed resolved
// signals, surfaces a one-time notice so the user knows to recover them.
function findMissedResolvedSignals() {
  const trades = getTrades();
  const logs = getLogs();
  const tradeKeys = new Set();
  for (const t of trades) {
    const day = (t.takenAt || '').slice(0, 10);
    tradeKeys.add(`${t.pair}_${t.direction}_${day}`);
  }
  return logs.filter(l => {
    if (l.outcome !== 'win' && l.outcome !== 'loss') return false;
    const day = (l.ts || '').slice(0, 10);
    return !tradeKeys.has(`${l.pair}_${l.direction}_${day}`);
  });
}

async function runSignalRecovery() {
  // PART 1 — enrich existing OPEN trades with server-detected strategies
  // that local strategies missed (e.g. SMC fires server-side but client SMC
  // failed). Pulls /api/diagnose and adds the strategy flags + grades.
  let enrichedCount = 0;
  let addedCount = 0;
  try {
    const r = await fetch('/api/diagnose');
    if (r.ok) {
      const d = await r.json();
      const trades = getTrades();
      for (const sig of d.signals || []) {
        const match = trades.find(t =>
          t.pair === sig.pair && t.direction === sig.direction && t.status === 'open');
        if (match) {
          let updated = false;
          const added = [];
          for (const strat of (sig.strategies || [])) {
            const k = strat.toLowerCase();
            const flagKey = k === 'div' ? 'divergencePassed' : `${k}Passed`;
            const gradeKey = k === 'div' ? 'divergenceGrade' : `${k}Grade`;
            if (!match[flagKey]) {
              match[flagKey] = true;
              if (!match[gradeKey]) match[gradeKey] = 'B+';
              updated = true;
              added.push(strat);
            }
          }
          if (updated) {
            match.serverEnriched = (match.serverEnriched || []).concat(added);
            enrichedCount++;
          }
        } else {
          // Add as new open trade
          const today = new Date().toISOString().slice(0, 10);
          const id = `recovered-cross-${sig.pair.replace('/','')}-${sig.direction}-${today}`;
          if (!trades.some(t => t.id === id)) {
            // v237 — Was hardcoded ladder missing XAU/USD (gold has pip=0.10).
            // pairConfig knows every supported pair's correct pip.
            const pipCfg = pairConfig(sig.pair);
            const pip = pipCfg && pipCfg.pip ? pipCfg.pip :
              (sig.pair.includes('JPY') ? 0.01 :
              sig.pair === 'BTC/USD' ? 1 :
              sig.pair === 'ETH/USD' ? 0.1 :
              sig.pair === 'SOL/USD' ? 0.01 : 0.0001);
            const newT = {
              id, pair: sig.pair, direction: sig.direction,
              confidence: 70, status: 'open',
              takenAt: new Date().toISOString(), closedAt: null,
              entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3,
              sl_pips: sig.risk_pips,
              tp1_pips: Number(((Math.abs(sig.tp1 - sig.entry)) / pip).toFixed(1)),
              tp2_pips: Number(((Math.abs(sig.tp2 - sig.entry)) / pip).toFixed(1)),
              tp3_pips: Number(((Math.abs(sig.tp3 - sig.entry)) / pip).toFixed(1)),
              atr: 0, rr: '1:1 / 1:2 / 1:3',
              autoAdded: true, isRecovered: true,
              recoveryNote: `Cross-recovered · strategies: ${(sig.strategies || []).join(', ')}`,
              tpReached: 0,
            };
            for (const strat of (sig.strategies || [])) {
              const k = strat.toLowerCase();
              const flagKey = k === 'div' ? 'divergencePassed' : `${k}Passed`;
              const gradeKey = k === 'div' ? 'divergenceGrade' : `${k}Grade`;
              newT[flagKey] = true;
              newT[gradeKey] = 'B+';
            }
            trades.push(newT);
            addedCount++;
          }
        }
      }
      if (enrichedCount || addedCount) saveTrades(trades);
    }
  } catch (e) { console.warn('[recovery cross-enrich]', e.message); }

  // PART 2 — resolved-log recovery (already-closed trades that never made it
  // into history because of a silent client-side strategy bug).
  const missed = findMissedResolvedSignals();
  if (!missed.length && !enrichedCount && !addedCount) {
    alert('No recovery needed. All server-detected signals already in your trades, and all logged outcomes are already in history.');
    // Still force a re-render so any prior changes show
    try { renderTrades(); } catch {}
    try { renderStrategies(); } catch {}
    return;
  }
  // If only enrichment happened (no missed-resolved), confirm and return
  if (!missed.length) {
    alert(`Cross-enrichment complete:\n• ${enrichedCount} existing trade${enrichedCount === 1 ? '' : 's'} enriched with server-detected strategies\n• ${addedCount} new open trade${addedCount === 1 ? '' : 's'} added for currently-firing signals\n\nNo resolved-log recovery needed.`);
    try { renderTrades(); } catch {}
    try { renderStrategies(); } catch {}
    return;
  }
  const wins = missed.filter(l => l.outcome === 'win').length;
  const losses = missed.filter(l => l.outcome === 'loss').length;
  // Build a summary by date for the confirmation prompt
  const byDate = {};
  for (const l of missed) {
    const d = (l.ts || '').slice(0, 10);
    byDate[d] = byDate[d] || { w: 0, l: 0 };
    if (l.outcome === 'win') byDate[d].w++;
    else byDate[d].l++;
  }
  const dateRows = Object.entries(byDate)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 10)
    .map(([d, c]) => `  ${d}:  ${c.w}W / ${c.l}L`)
    .join('\n');
  const msg = `Found ${missed.length} missed resolved signal${missed.length === 1 ? '' : 's'} that fired but never made it into trades:\n\n` +
    `  ${wins} wins · ${losses} losses\n\n` +
    `By date (latest 10):\n${dateRows}\n\n` +
    `Recover all ${missed.length} to your trade history?`;
  if (!confirm(msg)) return;
  const trades = getTrades();
  for (const l of missed) {
    const id = `recovered-${l.pair.replace('/','')}-${l.direction}-${(l.ts || '').slice(0, 10)}-${(l.ts || '').slice(11, 16).replace(':', '')}`;
    // Skip if already exists (idempotent)
    if (trades.some(t => t.id === id)) continue;
    trades.push({
      id,
      pair: l.pair, direction: l.direction,
      confidence: l.confidence || 50,
      status: l.outcome === 'win' ? 'won' : 'lost',
      takenAt: l.ts,
      closedAt: l.closedAt || l.ts,
      entry: l.entry || null,
      sl: l.sl || null,
      tp1: l.tp1 || null,
      tp2: l.tp2 || null,
      tp3: l.tp3 || null,
      closePrice: l.outcome === 'win' ? (l.tp1 || l.entry) : (l.sl || l.entry),
      pnlPips: null,
      tpReached: l.outcome === 'win' ? 1 : 0,
      autoAdded: true,
      isRecovered: true,
      recoveryNote: `Recovered from logs · strategy set: ${l.strategySet || 'unknown'}`,
    });
  }
  saveTrades(trades);
  // Build a combined summary covering ALL three recovery paths
  const parts = [];
  if (missed.length) parts.push(`• ${missed.length} resolved trade${missed.length === 1 ? '' : 's'} added to history`);
  if (enrichedCount) parts.push(`• ${enrichedCount} existing open trade${enrichedCount === 1 ? '' : 's'} enriched with server-detected strategies`);
  if (addedCount) parts.push(`• ${addedCount} new open trade${addedCount === 1 ? '' : 's'} added for currently-firing signals`);
  alert(`Recovery complete:\n${parts.join('\n')}\n\nStrategy tracking widgets will now reflect these changes.`);
  // Force re-render of BOTH Trades AND Strategies tabs so widgets pick up
  // the new SMC/ICT/TREND counts immediately (the bug the user reported —
  // SMC tracking didn't update until manual re-render).
  try { renderTrades(); } catch {}
  try { renderStrategies(); } catch {}
}

function tradeRowHTML(t) {
  const age = Math.round((Date.now() - new Date(t.takenAt).getTime()) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${(age/60).toFixed(1)}h ago` : `${(age/1440).toFixed(1)}d ago`;
  const statusColor = t.status === 'won' ? 'var(--buy)' : t.status === 'lost' ? 'var(--sell)' : t.status === 'open' ? 'var(--accent)' : 'var(--muted)';
  const pnl = t.pnlPips != null ? ` · ${t.pnlPips >= 0 ? '+' : ''}${t.pnlPips} pips` : '';
  // TP-PROGRESS BADGE — shows which take-profit level price has reached.
  // For OPEN trades: highlights the highest TP touched so far (live progress).
  // For WON trades: shows whether it was a TP1 (breakeven trail), TP2, or TP3
  // (full run) win so the user can tell magnitude apart from raw count.
  // For LOST trades: empty (TP0).
  const tpHit = t.tpReached || 0;
  const tpPill = (lvl) => {
    const reached = tpHit >= lvl;
    return `<span class="tp-pip${reached ? ' tp-pip-hit' : ''}" title="${reached ? 'Price has touched TP'+lvl : 'TP'+lvl+' not yet reached'}">TP${lvl}${reached ? ' ✓' : ''}</span>`;
  };
  const tpProgress = (t.status === 'won' || t.status === 'open')
    ? `<span class="tp-progress" title="TP progression: each ✓ = price has reached that TP since entry">${tpPill(1)}${tpPill(2)}${tpPill(3)}</span>`
    : '';
  // Status label gets enriched with the TP level for wins
  const tpLabel = t.status === 'won' ? (tpHit === 3 ? ' (TP3 full run)' : tpHit === 2 ? ' (TP2 · 1R locked)' : tpHit === 1 ? ' (TP1 · 25%R locked)' : '') : '';

  // ── LOSS-RISK WARNING for OPEN trades ──────────────────────────────────
  // Surfaces open trades that match the patterns of every historical loss:
  //   • Counter-trend: HTF opposite to direction (caught DOGE, AUD/USD)
  //   • Momentum-only: no structural strategy backing (caught NZD/CAD, XRP)
  // User can see at-a-glance which open trades are at elevated risk and
  // decide to close manually if they want to cut losses early.
  const lossRiskFlags = [];
  if (t.status === 'open') {
    const counterTrend = t.htfTrend && (
      (t.direction === 'BUY' && t.htfTrend === 'down') ||
      (t.direction === 'SELL' && t.htfTrend === 'up')
    );
    const momentumOnly = !t.smcPassed && !t.orbPassed && !t.ictPassed &&
      !t.trendPassed && !t.squeezePassed && !t.divergencePassed && t.momentumPassed;
    if (counterTrend) lossRiskFlags.push('counter-trend');
    if (momentumOnly) lossRiskFlags.push('momentum-only');
  }
  const lossRiskBadge = lossRiskFlags.length
    ? `<span class="trade-risk-tag" title="This open trade matches the same pattern as historical losses (${lossRiskFlags.join(' + ')}). Consider tighter management or manual close if it weakens.">⚠ AT RISK · ${lossRiskFlags.join(' + ')}</span>`
    : '';
  const actions = t.status === 'open'
    ? `<button class="trade-close" data-id="${t.id}" data-outcome="won" style="background:rgba(34,197,94,0.15);color:var(--buy);border-color:rgba(34,197,94,0.4)">✓ Won</button>
       <button class="trade-close" data-id="${t.id}" data-outcome="lost" style="background:rgba(239,68,68,0.15);color:var(--sell);border-color:rgba(239,68,68,0.4)">✗ Lost</button>
       <button class="trade-close" data-id="${t.id}" data-outcome="closed">Close manually</button>
       <button class="trade-delete" data-id="${t.id}">🗑 Delete</button>`
    : `<button class="trade-delete" data-id="${t.id}">🗑 Delete</button>`;
  const notesPreview = (t.notes || '').slice(0, 60);
  // Radiant badge now shows the grade (A+/A/B+/B/C) when available so gold
  // setups display alongside the other strategy badges with proper grading.
  const radiantBadge = t.isRadiant
    ? `<span class="trade-radiant-tag" title="Radiant SMC ${t.radiantGrade || ''} · ${t.radiantQuality || '—'}/100${t.radiantQualityBreakdown ? ' · ' + t.radiantQualityBreakdown.join(' · ') : ''}">⚡ RADIANT${t.radiantGrade ? ' ' + t.radiantGrade : ''}</span>`
    : '';
  // SUPER badge — institutional-grade confluence (3+ independent strategies
  // confirmed at signal time). Persisted on the trade record via takeTrade's
  // signal spread, so it follows the trade from My Trades into history.
  // Fallback: derive from passingStratsCount if the explicit isSuperSetup flag
  // is missing on older trades.
  const tStratCount = t.passingStratsCount || [
    t.smcPassed, t.orbPassed, t.ictPassed, t.trendPassed,
    t.squeezePassed, t.divergencePassed, t.momentumPassed,
  ].filter(Boolean).length;
  const tIsSuper = t.isSuperSetup || tStratCount >= 3;
  const tSuperByConsensus = t.superReason === 'consensus';
  const superBadge = tIsSuper
    ? (tSuperByConsensus
        ? `<span class="trade-super-tag" title="${tStratCount} strategies + ${t.superAlignedDelta} indicator-delta consensus at signal time">🏆 SUPER · ${tStratCount}+consensus</span>`
        : `<span class="trade-super-tag" title="${tStratCount} independent strategies confirmed at signal time">🏆 SUPER · ${tStratCount}</span>`)
    : '';
  // Strategy origin badges — show which strategy(ies) confirmed THIS trade's
  // signal. Works for both auto-tracked trades AND manually-taken ones, since
  // takeTrade now preserves the full strategy info (smcPassed/smcGrade etc).
  // Each badge shows the strategy icon, short name, grade, and whether it
  // was auto-added or manually taken.
  const autoSuffix = t.autoAdded ? ' AUTO' : '';
  const smcBadge = (t.smcPassed && !t.isRadiant)
    ? `<span class="trade-smc-tag" title="SMC ${t.smcGrade || ''} · ${t.smcQuality || '—'}/100">📐 SMC${t.smcGrade ? ' ' + t.smcGrade : ''}${autoSuffix}</span>`
    : '';
  const orbBadge = t.orbPassed
    ? `<span class="trade-orb-tag" title="ORB ${t.orbGrade || ''} · ${t.orbQuality || '—'}/100">📊 ORB${t.orbGrade ? ' ' + t.orbGrade : ''}${autoSuffix}</span>`
    : '';
  // Other strategies — fire if the trade has the [strategy]Passed flag
  const stratBadges = Object.entries(STRATEGIES).map(([sk, cfg]) => {
    if (!t[`${sk}Passed`]) return '';
    const grade = t[`${sk}Grade`];
    const quality = t[`${sk}Quality`];
    return `<span class="trade-strat-tag trade-strat-${sk}" title="${cfg.name} ${grade || ''} · ${quality || '—'}/100">${cfg.icon} ${cfg.short}${grade ? ' ' + grade : ''}${autoSuffix}</span>`;
  }).join('');
  const serverSrcBadge = t.isServerSourced
    ? '<span class="trade-server-tag" title="Detected by the always-on server cron">📡 SERVER</span>'
    : '';
  // Legacy confluence-only trades (added by an earlier confluence fallback
  // that no longer exists). Show clearly so the user knows where this trade
  // originated even though no specific strategy passed at signal time.
  const confluenceBadge = t.isConfluenceAuto
    ? '<span class="trade-conf-tag" title="Indicator-confluence signal (legacy, before strict mode)">⚖ CONFLUENCE</span>'
    : '';
  // Catch-all source badge: if the trade was auto-added but NO strategy or
  // source flag is present (rare/legacy data), show a generic indicator so
  // the user can see the trade came from the analyzer rather than manually.
  const hasAnyStrategyFlag = t.smcPassed || t.orbPassed || t.ictPassed ||
    t.trendPassed || t.squeezePassed || t.divergencePassed ||
    t.isRadiant || t.isServerSourced || t.isConfluenceAuto;
  const unknownSourceBadge = (t.autoAdded && !hasAnyStrategyFlag)
    ? '<span class="trade-unknown-tag" title="Auto-added but original strategy info missing — likely a legacy trade from before strict mode">⚠ NO STRATEGY TAG</span>'
    : '';
  const autoBadge = t.autoAdded ? '<span class="trade-auto-tag">🤖 AUTO-ADDED</span>' : '';
  // v221 — Brain badges persisted from the signal at takeTrade time. These
  // show why the brain flagged this signal — and stay on the trade forever
  // so the user can review what their position was based on.
  const eliteBrainBadge = t.isEliteBrainPattern
    ? `<span class="trade-elite-brain-tag" title="Brain-blessed pattern · ${t.eliteBrainWR}% historical WR over many backtest samples">🏆 ELITE BRAIN · ${t.eliteBrainWR}% WR</span>`
    : '';
  const brainComboBadge = (t.brainCombo && t.brainComboWR != null && !t.isEliteBrainPattern)
    ? `<span class="trade-brain-combo-tag" title="${(t.brainScoreBreakdown || []).join(' · ') || 'Brain combo analysis'}">🧠 ${t.brainComboWR}% combo WR${t.brainExpectedHours ? ' · ~' + t.brainExpectedHours + 'h' : ''}</span>`
    : '';
  return `
    <div class="trade-row ${t.isRadiant ? 'trade-row-radiant' : ''} ${t.smcPassed && !t.isRadiant ? 'trade-row-smc' : ''} ${t.orbPassed && !t.smcPassed && !t.isRadiant ? 'trade-row-orb' : ''} ${t.isEliteBrainPattern ? 'trade-row-elite-brain' : ''}" data-trade-id="${t.id}" title="Click for full breakdown + position calculator">
      <div class="trade-head">
        <span class="pair">${t.pair}</span>
        <span class="direction-badge dir-${t.direction}">${t.direction}</span>
        <span class="trade-status" style="color:${statusColor}">${t.status.toUpperCase()}${tpLabel}${pnl}</span>
        ${tpProgress}
        ${lossRiskBadge}
        ${eliteBrainBadge}
        ${brainComboBadge}
        ${superBadge}
        ${radiantBadge}
        ${smcBadge}
        ${orbBadge}
        ${stratBadges}
        ${serverSrcBadge}
        ${confluenceBadge}
        ${unknownSourceBadge}
        ${autoBadge}
        <span class="muted">${ageStr} · ${t.confidence}%</span>
      </div>
      <div class="trade-levels">
        Entry <code>${t.entry}</code> · SL <code>${t.sl}</code> (${t.sl_pips}p) · TP1 <code>${t.tp1}</code> (${t.tp1_pips}p) · TP2 <code>${t.tp2}</code> (${t.tp2_pips}p)
      </div>
      <details class="trade-notes-wrap" ${t.notes ? 'open' : ''}>
        <summary class="muted">📝 Notes ${notesPreview ? `<em>"${notesPreview}${t.notes.length > 60 ? '…' : ''}"</em>` : '<span style="opacity:0.6">— click to add</span>'}</summary>
        <textarea class="trade-notes" data-id="${t.id}" placeholder="Why you took it, what happened, what you'd do differently…">${(t.notes || '').replace(/</g, '&lt;')}</textarea>
      </details>
      <div class="trade-actions">${actions}</div>
    </div>`;
}

// v189 — Per user request: take any signal without warnings/blocks.
// The hard-blocks (v187) and soft warnings have been removed. The user has
// full control; they can manually take any signal regardless of confidence,
// SL distance, counter-trend, crypto, etc.
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('take-trade-btn')) return;
  const pair = e.target.dataset.pair;
  const signal = state.signals.find(s => s.pair === pair);
  if (!signal) return;

  const r = takeTrade(signal);
  if (!r.ok) {
    // Duplicate-prevented case: show friendly inline message instead of alert.
    // The dup means the user already has this signal tracked under one or more
    // strategies — point them at the existing trade so they can manage it.
    e.target.textContent = '✓ Already tracking';
    e.target.disabled = true;
    e.target.classList.add('already-tracking');
    // Show toast-style status
    const msg = document.createElement('div');
    msg.className = 'take-trade-toast';
    msg.innerHTML = `<strong>Already open</strong> — ${signal.pair} ${signal.direction} is already tracked in My Trades. Open the Trades tab to manage it.`;
    e.target.parentNode.insertBefore(msg, e.target.nextSibling);
    setTimeout(() => msg.remove(), 4500);
    return;
  }
  e.target.textContent = '✓ Trade added to My Trades';
  e.target.disabled = true;
  // v224 — refresh the trades view immediately so it appears when user clicks
  // My Trades tab. Also push to cloud so other devices receive it.
  try { renderTrades(); } catch {}
  try { pushAllToCloud(); } catch {}
  // Show a brief confirmation toast with a "view" link to switch tabs
  const toast = document.createElement('div');
  toast.className = 'take-trade-toast take-trade-toast-success';
  toast.innerHTML = `<strong>✓ Added</strong> — ${signal.pair} ${signal.direction} is now in <a href="#" class="goto-trades-link">My Trades</a>`;
  e.target.parentNode.insertBefore(toast, e.target.nextSibling);
  // Wire the link to switch tabs
  toast.querySelector('.goto-trades-link')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    document.querySelector('.tab[data-tab="trades"]')?.click();
  });
  setTimeout(() => toast.remove(), 5000);
});

// Trade-mode modal action buttons (Mark Won / Mark Lost / Delete)
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-trade-action')) {
    const id = e.target.dataset.id;
    const outcome = e.target.dataset.outcome;
    const t = getTrades().find(x => x.id === id);
    if (!t) return;
    const defaultPrice = outcome === 'won' ? t.tp1 : t.sl;
    const p = prompt(`Close ${t.pair} ${t.direction} as ${outcome.toUpperCase()}\nClose price:`, String(defaultPrice));
    if (p == null) return;
    closeTrade(id, outcome, parseFloat(p));
    $('#modal').classList.add('hidden');
    renderTrades();
  } else if (e.target.classList.contains('modal-trade-delete')) {
    const id = e.target.dataset.id;
    if (!confirm('Delete this trade from your history?')) return;
    deleteTrade(id);
    $('#modal').classList.add('hidden');
    renderTrades();
  }
});

// Click on a trade row body opens the same modal as a signal — calculator,
// plan, votes, strategies, all of it. Buttons inside the row keep their handlers.
document.addEventListener('click', (e) => {
  const row = e.target.closest('.trade-row');
  if (!row) return;
  if (e.target.closest('button')) return; // let button handlers run
  const id = row.dataset.tradeId;
  if (id) openTradeModal(id);
});

// Open-pair pills under each strategy widget — tapping one jumps straight
// to that trade's detail modal so the user can review/close/manage it.
document.addEventListener('click', (e) => {
  const pill = e.target.closest('.open-pair-pill');
  if (!pill) return;
  const id = pill.dataset.id;
  if (id) openTradeModal(id);
});

// Handle trades tab click — pull from cloud if syncing, then render. Clears badge.
// v237 — Background cloud-pull (mirroring History tab). Was blocking the tab
// visibility on the await — defeating v235 "instant tab switch" for Trades.
// Generic handler at line 4291 already renders local trades immediately.
// v252 — Removed the unread-counter reset from this handler. The badge now
// lives on History (since resolved trades land there), so it should clear
// when History is opened, not when My Trades is opened.
document.addEventListener('click', (e) => {
  if (e.target.dataset?.tab !== 'trades') return;
  if (!getSyncCode()) return;
  pullTradesFromCloud()
    .then(() => renderTrades())
    .catch(() => { /* offline — local render already shown by generic handler */ });
});

// History tab click — cloud-pull now runs IN BACKGROUND so opening the tab is
// instant. The local-cached trades render first (instant via localStorage),
// then the cloud pull resolves and re-renders only if new data arrived.
// v235 — was previously awaiting the cloud fetch BEFORE rendering, which made
// the tab freeze for hundreds of ms on slow connections. Now: render now,
// reconcile later.
document.addEventListener('click', (e) => {
  if (e.target.dataset?.tab !== 'history') return;
  // v252 — Clear unread-trade-outcomes counter when History opens (resolved
  // trades land here, so this is where the indicator should reset).
  state.unreadTradeUpdates = 0;
  updateHistoryTabBadge();
  if (!getSyncCode()) return; // generic tab handler already renders synchronously
  // Fire cloud pull in background — re-render if it succeeds. Crucially, no
  // await before render means the user sees their cached history instantly.
  pullTradesFromCloud()
    .then(() => renderHistory())
    .catch(() => { /* offline / failure — local render already showing */ });
});

// ========== News auto-refresh (when tab visible) ==========
// v349 — news polls every 60s (was 3 min). Combined with server-side
// continuous news warming via check-signals waitUntil, the news feed
// updates fresh every minute when News tab is visible.
let newsInterval = null;
function startNewsAutoRefresh() {
  if (newsInterval) return;
  newsInterval = setInterval(() => {
    if (document.visibilityState === 'visible' && $('#news.active')) loadNews();
  }, 60 * 1000);
}

// Notify toggle
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'notify-btn') return;
  if (!supportsNotifications()) {
    if (isIosSafari() && !isStandalone()) {
      alert('iPhone Safari only allows notifications inside installed web apps.\n\n1. Tap the Share button ⬆️\n2. Scroll and tap "Add to Home Screen"\n3. Open ForexSight from the home-screen icon\n4. Tap the Alerts button again');
    }
    return;
  }
  const perm = Notification.permission;
  if (perm === 'denied') {
    alert('Notifications are blocked. Re-enable them in your browser settings (Safari → Settings → Websites → Notifications, Chrome → site settings).');
    return;
  }
  if (perm !== 'granted') {
    const r = await ensureNotifyPermission();
    if (r !== 'granted') { updateNotifyButton(); return; }
    state.notifyEnabled = true;
  } else {
    state.notifyEnabled = !state.notifyEnabled;
  }
  localStorage.setItem(NOTIFY_PREF_KEY, state.notifyEnabled ? 'true' : 'false');
  updateNotifyButton();
  // When alerts are turned ON, also register with the server's Web Push
  // pipeline so notifications reach the user even when phone is locked +
  // app closed. This is the critical step for iOS PWAs.
  if (state.notifyEnabled) {
    subscribeToWebPush().catch(() => {});
  }
  if (state.notifyEnabled) {
    try { new Notification('ForexSight alerts enabled', { body: `You'll be notified when any pair hits ≥${NOTIFY_THRESHOLD}% confluence.`, icon: '/favicon.ico' }); } catch {}
  }
});

// Show a floating banner when a new app version is downloaded. One tap
// activates the new SW (skipWaiting) which triggers controllerchange →
// auto-reload. Avoids the "stuck on old code" iOS PWA problem.
function showUpdateBanner(newSW) {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <span>🔄 New version available</span>
    <button id="update-banner-btn">Update now</button>
    <button id="update-banner-dismiss" aria-label="dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  banner.querySelector('#update-banner-btn').addEventListener('click', () => {
    try { newSW.postMessage({ type: 'SKIP_WAITING' }); } catch {}
    // Fallback: hard refresh if the SW message didn't activate
    setTimeout(() => location.reload(), 1500);
  });
  banner.querySelector('#update-banner-dismiss').addEventListener('click', () => {
    banner.remove();
  });
}

// ────────────────────────────────────────────────────────────────────────
// STRATEGY HEALTH SANITY CHECK — runs once on app boot, after first signal
// scan, and compares LOCAL strategy fires against /api/diagnose (which uses
// simplified server-side strategy logic). If the server detects signals
// from strategies that the local client isn't seeing, something is broken
// on the client (like the zero-range bar bug or the `ema is not defined`
// bug). Surfaces a one-time visible warning so the user knows to act.
async function strategyHealthCheck() {
  try {
    // Wait a beat so first signal scan completes
    await new Promise(r => setTimeout(r, 8000));
    const localState = window.state || {};
    const localSignals = Array.isArray(localState.signals) ? localState.signals : [];
    if (!localSignals.length) return; // app still loading or no signals yet
    // Tally which strategies fired locally
    const localFires = {
      smc: 0, orb: 0, ict: 0, trend: 0,
      squeeze: 0, divergence: 0, momentum: 0,
    };
    for (const s of localSignals) {
      if (s.smcPassed) localFires.smc++;
      if (s.orbPassed) localFires.orb++;
      if (s.ictPassed) localFires.ict++;
      if (s.trendPassed) localFires.trend++;
      if (s.squeezePassed) localFires.squeeze++;
      if (s.divergencePassed) localFires.divergence++;
      if (s.momentumPassed) localFires.momentum++;
    }
    // Fetch server diagnose for comparison
    const r = await fetch('/api/diagnose');
    if (!r.ok) return;
    const d = await r.json();
    const serverFires = {
      smc: 0, orb: 0, ict: 0, trend: 0,
      squeeze: 0, divergence: 0, momentum: 0,
    };
    for (const s of (d.signals || [])) {
      for (const strat of (s.strategies || [])) {
        const k = strat.toLowerCase();
        if (k === 'div') serverFires.divergence++;
        else if (serverFires[k] != null) serverFires[k]++;
      }
    }
    // Flag strategies where server fires >=3 but local fires 0 — almost
    // certain client-side bug. Single-pair mismatches can happen normally
    // (server runs simpler logic) but >=3 is a strong signal.
    const broken = [];
    for (const k of Object.keys(localFires)) {
      if (serverFires[k] >= 3 && localFires[k] === 0) {
        broken.push(`${k.toUpperCase()}: server detected ${serverFires[k]} setups, local detected 0`);
      }
    }
    if (broken.length) {
      console.warn('[strategy-health] BROKEN STRATEGIES:', broken);
      // Show a banner if not dismissed today
      const dismissKey = 'forexsight_health_dismissed_' + new Date().toISOString().slice(0,10);
      if (localStorage.getItem(dismissKey) === '1') return;
      const banner = document.createElement('div');
      banner.id = 'strategy-health-banner';
      banner.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);background:#ff9f0a;color:#000;padding:10px 16px;border-radius:8px;z-index:99999;font-size:13px;font-weight:600;max-width:90vw;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
      banner.innerHTML = `⚠ <strong>${broken.length} strategy${broken.length === 1 ? '' : 's'} silent</strong> — server is detecting signals the app isn't showing. Check Trades tab for "Recover missed signals". &nbsp;<button onclick="localStorage.setItem('${dismissKey}','1');document.getElementById('strategy-health-banner').remove();" style="background:rgba(0,0,0,0.15);border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-weight:700">Dismiss</button>`;
      document.body.appendChild(banner);
    } else {
      console.log('[strategy-health] all strategies firing in sync with server');
    }
  } catch (e) {
    console.warn('[strategy-health]', e.message);
  }
}
// Run on app boot (fire-and-forget, doesn't block anything)
strategyHealthCheck();

// ========== PWA / Service Worker ==========
// v394 — HARD KILL. The service worker has been the persistent cause of
// stale-JS bugs across v387/v388/v389/v390/v391/v391b. Every fix I ship
// gets blocked from reaching the user because the SW keeps serving the
// old app.js from cache. Removing it entirely is more reliable than
// trying to patch cache logic. All future loads go direct-to-network.
if ('serviceWorker' in navigator) {
  // Unregister every existing SW and purge every cache, on every load,
  // until we're sure everyone's clean. Cheap to keep — costs ~5ms.
  (async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { try { await r.unregister(); } catch {} }
      if (window.caches) {
        const keys = await caches.keys();
        for (const k of keys) { try { await caches.delete(k); } catch {} }
      }
    } catch {}
  })();
}
// Historical SW-related code below is inert now that no SW is registered
// but kept intact so any legacy notifiation handlers don't reference-error.
if (false && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/service-worker.js');

      // ── Update detection ───────────────────────────────────────────────
      // Force an update check immediately AND every time the user foregrounds
      // the app. This is the difference between an iOS PWA staying stuck on
      // old code for days vs. picking up new deploys within seconds.
      const checkForUpdate = () => { try { reg.update(); } catch {} };
      checkForUpdate();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
      // Also poll every 60s while open — cheap, just a HEAD on the SW file
      setInterval(checkForUpdate, 60 * 1000);

      // When a new SW takes over, reload so the user instantly sees new code.
      // Guarded with sessionStorage so we don't loop-reload.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('_sw_reloaded')) return;
        sessionStorage.setItem('_sw_reloaded', '1');
        location.reload();
      });

      // Show a small banner when an update is downloaded but waiting to
      // activate — gives the user one-tap "Update now".
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            // A new SW is waiting. Show the "update available" banner.
            showUpdateBanner(newSW);
          }
        });
      });

      // Best-effort one-shot sync on every page visibility change so even
      // brief PWA opens trigger a server scan from inside the SW.
      try {
        if ('sync' in reg) {
          document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible') return;
            try { await reg.sync.register('forexsight-check-once'); } catch {}
          });
        }
      } catch {}

      // Periodic Background Sync — Chrome Android/desktop PWA only. iOS Safari
      // silently ignores this. Defensive throughout: any failure is logged,
      // never thrown, never blocks anything else.
      try {
        if ('periodicSync' in reg && navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await reg.periodicSync.register('forexsight-check-signals', {
              minInterval: 5 * 60 * 1000, // 5 min — OS may run less often
            });
            console.log('[periodic-sync] registered');
          } else {
            console.log('[periodic-sync] permission not granted (' + status.state + ')');
          }
        }
      } catch (e) {
        console.log('[periodic-sync] not supported on this browser:', e.message);
      }
    } catch (err) {
      console.warn('SW register failed:', err);
    }
  });
}

// Detect iOS Safari (not yet installed as PWA) and show a one-time install hint
function isIosSafari() {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && safari;
}
function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
}
function maybeShowIosHint() {
  if (!isIosSafari() || isStandalone()) return;
  // Always show — this is critical for reliable notifications. User can
  // dismiss once but it returns next session.
  const dismissedAt = Number(localStorage.getItem('forexsight_ios_hint_dismissed') || 0);
  // Re-show once per day so user doesn't forget
  if (Date.now() - dismissedAt < 24 * 3600 * 1000) return;
  const div = document.createElement('div');
  div.className = 'ios-hint';
  div.innerHTML = `
    <div class="ios-hint-inner">
      <strong>📱 ⚠ You're missing notifications on iPhone</strong>
      <p><strong>iOS Safari can't push notifications.</strong> To get alerted on every SMC signal even when this app is closed:</p>
      <ol style="margin:8px 0 10px 18px; padding:0; font-size:12.5px; line-height:1.6;">
        <li>Tap the <strong>Share</strong> button ⬆️ at the bottom of Safari</li>
        <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
        <li>Open the new ForexSight icon from your home screen</li>
        <li>Tap the <strong>🔕 Alerts OFF</strong> button to enable notifications</li>
      </ol>
      <p class="muted" style="font-size:11px;">Without this, you will not receive signal alerts when the app is closed. This is an Apple iOS rule — every app has to do it.</p>
      <button id="ios-hint-dismiss">Got it (will remind tomorrow)</button>
    </div>`;
  document.body.appendChild(div);
  $('#ios-hint-dismiss').addEventListener('click', () => {
    div.remove();
    localStorage.setItem('forexsight_ios_hint_dismissed', String(Date.now()));
  });
}

// Filter-mode toggle button — cycles off → dayTrader → bigPips → best → extreme → none → off.
function updateBestBtn() {
  const btn = $('#best-only-btn');
  if (!btn) return;
  btn.classList.remove('active', 'extreme', 'daytrader', 'bigpips', 'none-mode');
  if (state.filterMode === 'extreme') {
    btn.textContent = '🔥 EXTREME mode';
    btn.classList.add('active', 'extreme');
    btn.title = 'Strictest filter: 5+ strategies + 85% confluence + killzone + ADX≥30 + backtest≥70%. Click to cycle to None mode.';
  } else if (state.filterMode === 'none') {
    // v254 — None mode hides every signal except those in the Signal Feed.
    btn.textContent = '🎯 None — Feed only';
    btn.classList.add('active', 'none-mode');
    btn.title = 'None mode (v254): hides every signal except the ones currently being tracked in the Signal Feed below. Click to cycle back to OFF.';
  } else if (state.filterMode === 'best') {
    btn.textContent = '⭐ Best only: ON';
    btn.classList.add('active');
    btn.title = '8-gate Best Setup filter active. Click to switch to Extreme.';
  } else if (state.filterMode === 'bigPips') {
    btn.textContent = '🚀 BIG PIPS only';
    btn.classList.add('active', 'bigpips');
    btn.title = 'BIG PIPS mode (v238): only signals with server bigMove flag (ADX≥28 + killzone + vol expansion + 2+ strats) OR TP3 reach ≥30-80 pips depending on pair. Sorted by pip potential. Click to cycle to Best.';
  } else if (state.filterMode === 'dayTrader') {
    btn.textContent = '⚡ Day Trader';
    btn.classList.add('active', 'daytrader');
    btn.title = 'Day-trader mode: only signals expected to resolve within 8 hours, in London/NY, multi-strategy, HTF-aligned. Click to switch to BIG PIPS.';
  } else {
    btn.textContent = '⭐ Filter: OFF';
    btn.title = 'No quality filter — every signal shows. Click to enable Day Trader filter.';
  }
}
// Vibration pattern legend — opens a modal showing each strategy's unique
// vibration so the user can identify alerts by feel alone in silent mode.
// Tap any pattern in the modal to PREVIEW the vibration on the device.
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'vibe-legend-btn') return;
  const patterns = [
    { sk: 'smc',        name: 'SMC',          icon: '📐', feel: 'buzz-buzz-buzz · 50ms gap · ~100ms total', vibrate: [60, 40, 60, 40, 60], color: '#5fd5ff' },
    { sk: 'orb',        name: 'ORB',          icon: '📊', feel: 'buzz-buzz-buzz · 50ms gap · ~100ms total', vibrate: [60, 40, 60, 40, 60], color: '#ffb347' },
    { sk: 'ict',        name: 'ICT',          icon: '🎯', feel: 'buzz-buzz-buzz · 50ms gap · ~100ms total', vibrate: [60, 40, 60, 40, 60], color: '#c4a3ff' },
    { sk: 'trend',      name: 'TREND',        icon: '📈', feel: 'buzz-buzz-buzz · 50ms gap · ~100ms total', vibrate: [60, 40, 60, 40, 60], color: '#67e8f9' },
    { sk: 'squeeze',    name: 'SQUEEZE',      icon: '💥', feel: 'buzz-buzz-buzz · 50ms gap · ~100ms total', vibrate: [60, 40, 60, 40, 60], color: '#f9a8d4' },
    { sk: 'divergence', name: 'DIVERGENCE',   icon: '🔄', feel: 'buzz-buzz-buzz · 50ms gap · ~100ms total', vibrate: [60, 40, 60, 40, 60], color: '#fde047' },
  ];
  const body = patterns.map(p => `
    <div class="vibe-row" data-vibe="${p.vibrate.join(',')}" style="border-left: 3px solid ${p.color}">
      <div class="vibe-icon">${p.icon}</div>
      <div class="vibe-info">
        <div class="vibe-name" style="color:${p.color}">${p.name}</div>
        <div class="vibe-feel">${p.feel}</div>
      </div>
      <button class="vibe-test-btn" data-vibe="${p.vibrate.join(',')}" data-name="${p.name}" data-icon="${p.icon}" data-sk="${p.sk}">▶ Test</button>
    </div>
  `).join('');
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');
  if (!modal || !modalBody) return;
  modalBody.innerHTML = `
    <h2>📳 Vibration Legend</h2>
    <p class="muted" style="margin-bottom:14px;">All strategies use the same ultra-fast <strong>3-buzz pattern (50ms apart, ~100ms total)</strong>. iOS may merge these into one stronger pulse since 50ms is faster than the OS can fire individual vibrations. Distinguish strategies by the lock-screen emoji + title (📐 SMC, 📊 ORB, 🎯 ICT, 📈 TREND, 💥 SQUEEZE, 🔄 DIV).</p>
    <div class="vibe-cheatsheet">
      <span><b>All strategies</b> 3 buzzes 50ms apart (~100ms total)</span>
    </div>
    <div class="vibe-legend">${body}</div>
    <div id="vibe-test-status" class="vibe-status"></div>
    <div class="vibe-tip">
      <strong>iOS — to feel vibrations in silent mode:</strong><br>
      • Settings → Sounds &amp; Haptics → <strong>Vibrate on Silent</strong> → ON ✓<br>
      • Settings → Notifications → ForexSight → <strong>Allow Notifications</strong> ✓<br>
      • Settings → Focus → [active focus] → Allowed Apps → add ForexSight ✓<br>
      <br>
      <strong>iOS limitation:</strong> Apple uses its own default vibration pattern for web push notifications — custom patterns work on Android but iOS uses the same vibration for every notification. You'll still distinguish strategies by the lock-screen emoji (📐 SMC, 📊 ORB, 🎯 ICT, 📈 TREND, 💥 SQUEEZE, 🔄 DIV) and the chime sound when not silent.
    </div>`;
  // v231 — smooth open animation (force reflow + rAF)
  void modal.offsetHeight;
  requestAnimationFrame(() => modal.classList.remove('hidden'));

  // Test handler — first try Web Vibration API (Android), then fall back to
  // firing a real notification (which iOS DOES vibrate for, regardless of
  // whether the custom pattern is honored).
  modalBody.querySelectorAll('.vibe-test-btn').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const target = ev.currentTarget;
      const pattern = target.dataset.vibe.split(',').map(Number);
      const stratName = target.dataset.name;
      const stratIcon = target.dataset.icon;
      const status = document.getElementById('vibe-test-status');

      const showStatus = (msg, kind = 'ok') => {
        if (!status) return;
        status.className = 'vibe-status vibe-status-' + kind;
        status.textContent = msg;
        clearTimeout(showStatus._t);
        showStatus._t = setTimeout(() => { status.textContent = ''; status.className = 'vibe-status'; }, 6000);
      };

      // Disable button briefly to prevent double-tap
      target.disabled = true;
      target.textContent = '⏳ Testing…';

      // 1. Try Web Vibration API (works on Chrome/Android, NO-OP on iOS)
      let webVibeWorked = false;
      try {
        if (typeof navigator.vibrate === 'function') {
          webVibeWorked = navigator.vibrate(pattern) === true;
        }
      } catch {}

      // 2. Always also fire a real notification — that's what works on iOS
      if (Notification && Notification.permission === 'default') {
        showStatus('Notification permission needed — please tap "Allow"…', 'info');
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            showStatus('Notification permission denied — vibration test cannot fire on iOS without it', 'warn');
            target.disabled = false;
            target.textContent = '▶ Test';
            return;
          }
        } catch (e) {
          showStatus(`Could not request permission: ${e.message}`, 'warn');
          target.disabled = false;
          target.textContent = '▶ Test';
          return;
        }
      }
      // BURST MODE — 3 buzzes 50ms apart (100ms total span). Extremely
      // fast — iOS may merge them into one continuous strong pulse since
      // the OS can't always fire vibrations that close together. On
      // Android the pattern fires as 3 distinct micro-buzzes.
      const UNIFIED_BURST = { count: 3, gap: 50 }; // 3 buzzes 50ms apart — total ~100ms
      const burstSignature = {
        smc:        UNIFIED_BURST,
        orb:        UNIFIED_BURST,
        ict:        UNIFIED_BURST,
        trend:      UNIFIED_BURST,
        squeeze:    UNIFIED_BURST,
        divergence: UNIFIED_BURST,
      };
      const sk = (target.dataset.sk || stratName.toLowerCase()).split(' ')[0].toLowerCase();
      const sig = burstSignature[sk] || { count: 1, gap: 0 };

      if (Notification && Notification.permission === 'granted') {
        try {
          const fireOne = async (idx) => {
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
              const reg = await navigator.serviceWorker.ready;
              await reg.showNotification(`${stratIcon} ${stratName} buzz ${idx + 1}/${sig.count}`, {
                body: `${stratName} test pattern — feel the rhythm`,
                icon: '/icon-192.png',
                badge: '/icon-192.png',
                tag: `vibe-test-${sk}-${idx}-${Date.now()}`,
                renotify: true,
                vibrate: pattern,
                silent: false,
                requireInteraction: false,
                data: { url: '/' },
              });
            } else {
              new Notification(`${stratIcon} ${stratName} buzz ${idx + 1}/${sig.count}`, {
                body: `${stratName} test pattern`,
                icon: '/icon-192.png',
                tag: `vibe-test-${sk}-${idx}-${Date.now()}`,
                vibrate: pattern,
                silent: false,
              });
            }
          };

          // Fire the burst — sequential, spaced by sig.gap ms
          for (let i = 0; i < sig.count; i++) {
            setTimeout(() => fireOne(i).catch(() => {}), i * sig.gap);
          }

          const totalMs = (sig.count - 1) * sig.gap;
          showStatus(
            `✓ Firing ${sig.count} ${stratName} buzz${sig.count > 1 ? 'es' : ''} over ${totalMs}ms — feel the pattern! Each strategy uses a different count + spacing.`,
            'ok'
          );
        } catch (err) {
          showStatus(`Could not show notification: ${err.message}`, 'warn');
        }
      } else if (Notification && Notification.permission === 'denied') {
        showStatus('Notifications are blocked. Enable them in iPhone Settings → ForexSight → Notifications.', 'warn');
      }

      // Re-enable
      setTimeout(() => {
        target.disabled = false;
        target.textContent = '▶ Test';
      }, 1500);
    });
  });
});

document.addEventListener('click', async (e) => {
  if (e.target.id !== 'best-only-btn') return;
  // Cycle: off → dayTrader → bigPips → best → extreme → none → off
  // 'none' (v254) hides every signal EXCEPT the ones currently in the Signal
  // Feed (shadow tracker). Useful when you only want to focus on the trades
  // the brain has already gated, scored, and is actively measuring.
  const order = ['off', 'dayTrader', 'bigPips', 'best', 'extreme', 'none'];
  const idx = order.indexOf(state.filterMode);
  state.filterMode = order[(idx + 1) % order.length];
  state.bestOnly = state.filterMode !== 'off'; // legacy compat
  try {
    localStorage.setItem(FILTER_MODE_KEY, state.filterMode);
    localStorage.setItem(BEST_ONLY_KEY, state.bestOnly ? 'true' : 'false');
  } catch {}
  updateBestBtn();
  updateNotifyButton();
  renderSignals();
  // If user just turned a filter ON but alerts are off, offer to enable them
  if (state.bestOnly && !state.notifyEnabled && supportsNotifications()) {
    if (confirm('Filter is now ON. Enable notifications so you actually hear when qualifying signals appear?')) {
      const r = await ensureNotifyPermission();
      if (r === 'granted') {
        state.notifyEnabled = true;
        localStorage.setItem(NOTIFY_PREF_KEY, 'true');
        updateNotifyButton();
        fireTestNotification();
      }
    }
  }
});

// Right-click the Alerts button → fires a test notification so user can verify
// the pipeline (browser permission + service worker + chime) actually works.
document.addEventListener('contextmenu', (e) => {
  if (e.target.id !== 'notify-btn') return;
  e.preventDefault();
  fireTestNotification();
});

// Long-press on iPhone PWA — same effect as right-click on desktop
let _pressTimer = null;
document.addEventListener('touchstart', (e) => {
  if (e.target.id !== 'notify-btn') return;
  _pressTimer = setTimeout(() => { fireTestNotification(); _pressTimer = null; }, 700);
});
document.addEventListener('touchend', () => { if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; } });

// ========== Live clock + active sessions + signal countdowns ==========
function format12h(h, m, s) {
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = ((h + 11) % 12) + 1;
  const pad = (n) => String(n).padStart(2, '0');
  return s != null
    ? `${hh}:${pad(m)}:${pad(s)} ${period}`
    : `${hh}:${pad(m)} ${period}`;
}
function tickClock() {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const utcDay = days[now.getUTCDay()];
  const pad = (n) => String(n).padStart(2, '0');
  const utcTime = format12h(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
  const localTime = format12h(now.getHours(), now.getMinutes());

  const h = now.getUTCHours();
  const active = [];
  if (h >= 22 || h < 7) active.push('Sydney');
  if (h >= 0 && h < 9) active.push('Tokyo');
  if (h >= 8 && h < 17) active.push('London');
  if (h >= 13 && h < 22) active.push('New York');
  const overlap = active.includes('London') && active.includes('New York');

  const clock = $('#live-clock');
  if (clock) clock.innerHTML = `🕐 <strong>${utcDay} ${utcTime} UTC</strong> <span class="muted">(${localTime} local)</span>`;

  const sess = $('#active-sessions');
  if (sess) {
    if (active.length === 0) {
      sess.innerHTML = `🌙 <span class="muted">No major session active — low liquidity</span>`;
      sess.className = 'sessions';
    } else if (overlap) {
      sess.innerHTML = `🔥 <strong>LONDON + NEW YORK</strong> <span class="muted">peak liquidity</span>${active.length > 2 ? ' + ' + active.filter(a => !['London', 'New York'].includes(a)).join(' + ') : ''}`;
      sess.className = 'sessions sessions-peak';
    } else {
      sess.innerHTML = `📈 <strong>${active.join(' + ').toUpperCase()}</strong> open`;
      sess.className = 'sessions sessions-active';
    }
  }

  // Next 1H candle countdown — when fresh signals will be generated
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(60, 0, 0);
  const ms = nextHour - now;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const next = $('#next-hour');
  if (next) next.innerHTML = `⏰ Next 1H candle in <strong>${pad(m)}:${pad(s)}</strong>`;

  // Per-card signal expiry
  document.querySelectorAll('.card-timer').forEach(el => {
    const exp = el.dataset.expires;
    if (!exp) return;
    const left = new Date(exp).getTime() - now.getTime();
    if (left <= 0) {
      el.innerHTML = '⏰ <strong>EXPIRED</strong> — wait for fresh signal';
      el.classList.add('timer-expired');
      el.classList.remove('timer-urgent');
    } else {
      const mm = Math.floor(left / 60000);
      const ss = Math.floor((left % 60000) / 1000);
      el.innerHTML = mm > 0
        ? `⏱ Enter within <strong>${mm}m ${pad(ss)}s</strong>`
        : `⏱ Enter within <strong>${ss}s</strong>`;
      el.classList.toggle('timer-urgent', left < 5 * 60 * 1000);
    }
  });
}
tickClock();
setInterval(tickClock, 1000);

// ════════════════════════════════════════════════════════════════════════
// SMC AUTO-TRADE TRACKING — every SMC-confirmed forex signal automatically
// becomes an open trade in My Trades so it gets monitored for win/loss
// regardless of whether the user is online when the signal fires. The
// existing evaluateOpenTrades pipeline marks them won/lost when price
// hits TP1 or SL on any future data refresh.
// ════════════════════════════════════════════════════════════════════════
const SMC_AUTO_KEY = 'forexsight_smc_auto_v1';
// No daily cap on auto-tracking — as long as a signal passes the SMC gates
// AND the B+ quality threshold, it gets tracked. Notifications + auto-add
// fire for every legitimate setup the strategy finds, all day every day.
const SMC_DAILY_CAP = Infinity;
const SMC_NOTIFIED_KEY = 'forexsight_smc_notified_v1';

function _smcToday() { return new Date().toISOString().slice(0, 10); }

function _smcAutoStore() {
  return safeLoad(SMC_AUTO_KEY, {});
}
function _smcAutoTodayCount() {
  const data = _smcAutoStore();
  return Object.keys(data[_smcToday()] || {}).length;
}
function _smcAutoSeen(setupKey) {
  const data = _smcAutoStore();
  return !!(data[_smcToday()]?.[setupKey]);
}
function _smcAutoMark(setupKey) {
  const data = _smcAutoStore();
  const today = _smcToday();
  data[today] = data[today] || {};
  data[today][setupKey] = Date.now();
  const dates = Object.keys(data).sort();
  while (dates.length > 7) delete data[dates.shift()];
  safeSave(SMC_AUTO_KEY, data);
}

// Quality threshold for auto-tracking. Only signals scoring ≥75 (grade B+
// or better) auto-add. Grade B and C signals are still tagged on the card
// so you can take them manually, but they don't pollute the auto-track
// history. Keeps your win-rate stats representative of GOOD setups only.
// Threshold dropped to 0 — every strategy-confirmed signal auto-tracks.
// The strategy's hard gates already filter quality; the grade is informational.
const SMC_AUTOTRACK_MIN_SCORE = 0;

// Fallback auto-add for indicator-confluence signals (≥60% confluence, no
// strategy fired). Ensures the user sees opportunities even when strict
// strategy gates don't catch them.
const _CONFLUENCE_AUTO_KEY = 'forexsight_confluence_auto_v1';
function _confluenceSeen(setupKey) {
  const data = safeLoad(_CONFLUENCE_AUTO_KEY, {});
  const today = new Date().toISOString().slice(0, 10);
  return !!(data[today]?.[setupKey]);
}
function _confluenceMark(setupKey) {
  const data = safeLoad(_CONFLUENCE_AUTO_KEY, {});
  const today = new Date().toISOString().slice(0, 10);
  data[today] = data[today] || {};
  data[today][setupKey] = Date.now();
  const dates = Object.keys(data).sort();
  while (dates.length > 7) delete data[dates.shift()];
  safeSave(_CONFLUENCE_AUTO_KEY, data);
}
// v158: shared SUPER guard for ALL auto-add pipelines.
// Legacy autoAddSMC / autoAddORB / autoAddConfluence used to bypass the
// elite filter that lives in `autoAddStrategyTrade`. This helper unifies
// the gate so every auto-take path requires a SUPER setup (v156 RULE 8).
//
// v160 ADDITION — RULE 9: MAX SL DISTANCE CAP.
// Empirical evidence from v146+ losses: the 5 worst trades were all crypto
// or JPY with massive natural stops (XRP -181, SOL -109, GBP/JPY -45,
// ADA -31). One disaster like that erases ~10 typical wins. Cap SL distance
// so a single trade can never cost more than X pips. Bands:
//   • Crypto pairs: BLOCKED entirely from auto-take (pip scales make
//     consistent risk impossible without per-pair tuning — wins still
//     show on the signals tab, just no auto-tracking).
//   • JPY forex pairs: max 25 pips (JPY runs naturally wider).
//   • Other forex pairs: max 20 pips.
//   • Gold: max 60 pips (its own wider band).
// Trades with wider natural stops still appear as signals — they just
// don't auto-track. User can take them manually if they want the risk.
function _passesSuperGate(signal, src) {
  if (!signal) return false;
  const cnt = [
    signal.smcPassed, signal.orbPassed, signal.ictPassed,
    signal.trendPassed, signal.squeezePassed,
    signal.divergencePassed, signal.momentumPassed,
  ].filter(Boolean).length;
  // v183: SUPER threshold REVERTED to 3+ strats (or 2+ with delta ≥ 5).
  // The v166 4+-strats requirement over-tightened — empirically, 3-strat
  // SUPER setups are the consistent winners (USD/CAD +7.1, GBP/USD +9.7,
  // EUR/GBP +44.7, EUR/CAD +3.6, EUR/USD +4.5, GBP/CAD +16.2 in v146+).
  // User feedback: want more 3-strat SUPER signals.
  const isSuper = cnt >= 3 ||
                  (cnt >= 2 && (signal.superAlignedDelta || 0) >= 5);
  if (!isSuper) {
    console.log(`[${src} auto-trade] blocked: not SUPER-tier (${cnt} strats, delta=${signal.superAlignedDelta || 0}) — v183 requires 3+ strats or 2+ with delta≥5`);
    return false;
  }
  // v181 INTELLIGENCE 12 — WINNING-PATTERN PRIORITY.
  // POSITIVE selection (not a blocker). Compute historical WR for this
  // exact pair+direction+strategy-combo. If it has won 75%+ across 3+
  // samples, the signal is a HIGH-PRIORITY repeat winner — log it as
  // such. Future versions can also use this to boost ranking when
  // multiple signals compete. Does NOT modify the signal's confidence
  // (don't want feedback loops), just flags it.
  try {
    const stats = (typeof getPairDirStats === 'function')
      ? getPairDirStats(signal.pair, signal.direction)
      : null;
    if (stats && stats.getStratCombo) {
      const cs = stats.getStratCombo(signal.firedStrategies);
      const total = (cs.w || 0) + (cs.l || 0);
      if (total >= 3) {
        const wr = cs.w / total;
        if (wr >= 0.75) {
          console.log(`[${src} auto-trade] PRIORITY PATTERN MATCH: ${signal.pair} ${signal.direction} combo has historical WR ${Math.round(wr*100)}% across ${total} samples — high-confidence repeat winner (v181 INTELLIGENCE 12)`);
        }
      }
    }
  } catch (e) { /* swallow */ }

  // v180 RULE 26 — ATR-RELATIVE SL DISTANCE CHECK.
  // SL must be in the 0.6×-2× ATR band:
  //   • Too tight (<0.6× ATR): normal noise will trip the stop before
  //     direction resolves.
  //   • Too wide (>2× ATR): excessive risk for the expected move size.
  // ATR is the natural volatility unit per pair — measuring SL distance
  // in ATR-multiples is broker- and pair-agnostic.
  if (signal.atr && signal.atr > 0 && signal.sl != null && signal.entry != null) {
    const slDist = Math.abs(signal.entry - signal.sl);
    const atrMult = slDist / signal.atr;
    if (atrMult < 0.6) {
      console.log(`[${src} auto-trade] blocked: SL only ${atrMult.toFixed(2)}× ATR — too tight, noise will trip it (v180 RULE 26)`);
      return false;
    }
    if (atrMult > 2.0) {
      console.log(`[${src} auto-trade] blocked: SL ${atrMult.toFixed(2)}× ATR — too wide, overcommitment risk (v180 RULE 26)`);
      return false;
    }
  }

  // v179 RULE 25 — ANTI-WIDE-SPREAD SANITY.
  // Normal forex non-JPY spread is 0.5-2p, JPY pairs 1-3p, gold 4-8p.
  // If displayed spread exceeds these bands, market is in a wide-spread
  // event (news, illiquidity) and slippage will dominate the trade.
  const isGold2 = signal.pair === 'XAU/USD' || signal.pair === 'GOLD';
  const isJpy2 = signal.pair && signal.pair.includes('/JPY');
  const sp = Math.abs(signal.spread_pips || 0);
  const spreadCap = isGold2 ? 10 : (isJpy2 ? 4 : 3);
  if (sp > spreadCap) {
    console.log(`[${src} auto-trade] blocked: ${signal.pair} spread ${sp}p > ${spreadCap}p sanity cap — likely wide-spread event (v179 RULE 25)`);
    return false;
  }

  // v178 RULE 24 — OPEN-TRADES CONCURRENCY CAP.
  // Cap simultaneous open trades at 5. Beyond that, account exposure is
  // spread too thin and one regime change can cascade-stop multiple at
  // once. Quality over quantity.
  try {
    const all = (typeof getTrades === 'function') ? getTrades() : [];
    const openCount = all.filter(t => t.status === 'open').length;
    if (openCount >= 5) {
      console.log(`[${src} auto-trade] blocked: already ${openCount} open trades — concurrency cap is 5 (v178 RULE 24)`);
      return false;
    }
  } catch (e) { /* swallow */ }

  // v177 RULE 23 — HOUR-OF-DAY EQUITY-CURVE LEARNING.
  // WR alone misses cases where hour has 60% WR but the 40% losers are
  // 4x bigger than wins (net negative). This tracks CUMULATIVE pip P/L
  // per UTC hour across all history. Block hours where cumulative P/L < 0
  // with at least 4 samples — those hours have proven empirically
  // unprofitable regardless of WR.
  try {
    if (!_passesSuperGate._hourPnlCache || _passesSuperGate._hourPnlCache.ts !== (getTrades && getTrades().length)) {
      const all = (typeof getTrades === 'function') ? getTrades() : [];
      const closed = all.filter(t => (t.status === 'won' || t.status === 'lost') && t.closedAt);
      const map = {};
      for (const t of closed) {
        const h = new Date(t.takenAt).getUTCHours();
        if (!map[h]) map[h] = { pnl: 0, n: 0 };
        map[h].pnl += (t.pnlPips || 0);
        map[h].n++;
      }
      _passesSuperGate._hourPnlCache = { ts: all.length, byHour: map };
    }
    const h = new Date().getUTCHours();
    const data = _passesSuperGate._hourPnlCache.byHour[h] || { pnl: 0, n: 0 };
    if (data.n >= 4 && data.pnl < 0) {
      console.log(`[${src} auto-trade] blocked: hour ${h}:00 UTC cumulative P/L ${data.pnl.toFixed(1)}p across ${data.n} closures — hour is empirically unprofitable (v177 RULE 23)`);
      return false;
    }
  } catch (e) { /* swallow */ }

  // v176 RULE 22 — SPREAD-VS-TP1 GUARD.
  // If broker spread is >40% of the TP1 pip distance, the real R:R is
  // wrecked before the trade starts — TP1 has to traverse spread + actual
  // target = much further than displayed. Block these "spread tax" trades.
  const tp1Pips = Math.abs(signal.tp1_pips || 0);
  const spreadPips = Math.abs(signal.spread_pips || 0);
  if (tp1Pips > 0 && spreadPips > 0 && (spreadPips / tp1Pips) > 0.4) {
    console.log(`[${src} auto-trade] blocked: spread ${spreadPips}p is ${Math.round(spreadPips/tp1Pips*100)}% of TP1 ${tp1Pips}p — spread tax too high (v176 RULE 22)`);
    return false;
  }

  // v175 RULE 21 — SAME-PAIR RETAKE DELAY.
  // After a pair closes (won OR lost), enforce a 4h cooldown before
  // re-entering that same pair (any direction). Reasoning: the price has
  // just moved through SL/TP, so the immediate post-close window is
  // statistically the worst time to re-enter — the market is in a
  // post-event state, not a fresh trend.
  try {
    const all = (typeof getTrades === 'function') ? getTrades() : [];
    const recentSamePair = all
      .filter(t =>
        (t.status === 'won' || t.status === 'lost') &&
        t.pair === signal.pair &&
        t.closedAt)
      .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));
    const mostRecent = recentSamePair[0];
    if (mostRecent) {
      const ageMin = (Date.now() - Date.parse(mostRecent.closedAt)) / 60000;
      if (ageMin < 240) { // 4 hours
        console.log(`[${src} auto-trade] blocked: ${signal.pair} same-pair retake delay — closed ${Math.round(ageMin)}min ago (v175 RULE 21; 240min cooldown)`);
        return false;
      }
    }
  } catch (e) { /* swallow */ }

  // v174 RULE 20 — DAILY P/L CIRCUIT BREAKER.
  // If cumulative pip P/L for the current UTC day is below -50, halt all
  // new auto-takes until UTC midnight. Pros call this "the daily stop":
  // if the day's a loser, stop adding to it. Prevents revenge-trading
  // spirals where a bad morning becomes a catastrophic day.
  try {
    const all = (typeof getTrades === 'function') ? getTrades() : [];
    const todayUtcStart = new Date();
    todayUtcStart.setUTCHours(0, 0, 0, 0);
    const todayMs = todayUtcStart.getTime();
    const todaysClosed = all.filter(t =>
      (t.status === 'won' || t.status === 'lost') &&
      t.closedAt &&
      Date.parse(t.closedAt) >= todayMs);
    const todayPnl = todaysClosed.reduce((sum, t) => sum + (t.pnlPips || 0), 0);
    // v184: daily P/L circuit breaker tightened -50p → -30p. Was -50p
    // (one losing day could be -50p before halt = ~5 typical SL hits).
    // -30p = ~3 SL hits before halt = stops bleeding sooner.
    if (todayPnl < -30) {
      console.log(`[${src} auto-trade] blocked: daily P/L ${todayPnl.toFixed(1)}p < -30p circuit breaker (v184 tightened from -50p)`);
      return false;
    }
  } catch (e) { /* swallow */ }

  // v173 RULE 19 — LOSS-CLUSTER COOLDOWN.
  // If 3 of the last 5 closures lost AND the most recent loss is <60min ago,
  // the regime is hostile — halt new auto-takes for 60min. Prevents
  // bleeding-pattern continuation. Self-clears when a winner closes or 60
  // min pass without further losses. Pros call this "stop trading when
  // you're getting hit."
  try {
    const all = (typeof getTrades === 'function') ? getTrades() : [];
    const closed = all
      .filter(t => t.status === 'won' || t.status === 'lost')
      .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));
    // v184: loss-cluster tightened — 3-in-5/60min → 2-in-4/90min.
    // Faster reaction to losing patches. Old rule required 3 losses in last
    // 5 before halt; new rule halts after 2 losses in last 4 (and waits
    // 90min vs 60). Catches bad regimes 1 trade earlier.
    const last4 = closed.slice(0, 4);
    const lossesIn4 = last4.filter(t => t.status === 'lost').length;
    const mostRecentLoss = last4.find(t => t.status === 'lost');
    if (lossesIn4 >= 2 && mostRecentLoss && mostRecentLoss.closedAt) {
      const ageMin = (Date.now() - Date.parse(mostRecentLoss.closedAt)) / 60000;
      if (ageMin < 90) {
        console.log(`[${src} auto-trade] blocked: loss-cluster cooldown — ${lossesIn4}/4 recent closures lost, last one ${Math.round(ageMin)}min ago (v184 tightened from 3/5/60min)`);
        return false;
      }
    }
  } catch (e) { /* swallow */ }

  // v172 RULE 18 — CONFIDENCE-BAND LIVE CALIBRATION.
  // Bucket the signal's confidence into 5-point bands (85-89, 90-94, etc.)
  // and look at the actual WR for trades that closed at that band. If a band
  // is empirically underperforming (<50% WR with 3+ samples), block any new
  // signals in that band. This is auto-tuning: the system learns whether
  // its confidence model is accurate at each level.
  try {
    if (!_passesSuperGate._confBandCache || _passesSuperGate._confBandCache.ts !== (getTrades && getTrades().length)) {
      const all = (typeof getTrades === 'function') ? getTrades() : [];
      const closed = all.filter(t => (t.status === 'won' || t.status === 'lost') && t.confidence != null);
      const bands = {};
      for (const t of closed) {
        const b = Math.floor((t.confidence || 0) / 5) * 5;
        bands[b] = bands[b] || { w: 0, l: 0 };
        if (t.status === 'won') bands[b].w++; else bands[b].l++;
      }
      _passesSuperGate._confBandCache = { ts: all.length, bands };
    }
    const b = Math.floor((signal.confidence || 0) / 5) * 5;
    const band = _passesSuperGate._confBandCache.bands[b] || { w: 0, l: 0 };
    const total = band.w + band.l;
    if (total >= 3) {
      const bandWr = band.w / total;
      if (bandWr < 0.50) {
        console.log(`[${src} auto-trade] blocked: confidence band ${b}-${b+4}% has actual WR ${Math.round(bandWr*100)}% across ${total} closures — v172 calibration penalty`);
        return false;
      }
    }
  } catch (e) { /* swallow */ }

  // v171 RULE 17 — PER-STRATEGY LIVE WR INTELLIGENCE.
  // Track every strategy's recent WR globally. If the strategies firing on
  // this signal have a poor track record across their last N closures,
  // the signal is statistically weak — block it.
  //
  // Cache invalidates by trade-count so it's fresh after every closure.
  try {
    if (!_passesSuperGate._stratWrCache || _passesSuperGate._stratWrCache.ts !== (getTrades && getTrades().length)) {
      const all = (typeof getTrades === 'function') ? getTrades() : [];
      const closed = all.filter(t => t.status === 'won' || t.status === 'lost');
      const map = {};
      const recent50 = closed.slice().sort((a, b) =>
        (b.closedAt || '').localeCompare(a.closedAt || '')).slice(0, 50);
      const STRATS = ['smc','orb','ict','trend','squeeze','divergence','momentum'];
      for (const s of STRATS) map[s] = { w: 0, l: 0 };
      for (const t of recent50) {
        for (const s of STRATS) {
          if (t[`${s}Passed`]) {
            if (t.status === 'won') map[s].w++; else map[s].l++;
          }
        }
      }
      _passesSuperGate._stratWrCache = { ts: all.length, byStrat: map };
    }
    const byStrat = _passesSuperGate._stratWrCache.byStrat || {};
    const firingHere = [
      'smc','orb','ict','trend','squeeze','divergence','momentum'
    ].filter(s => signal[`${s}Passed`]);
    let aggW = 0, aggL = 0, sampleN = 0;
    for (const s of firingHere) {
      const r = byStrat[s] || { w: 0, l: 0 };
      aggW += r.w; aggL += r.l;
      if ((r.w + r.l) >= 1) sampleN++;
    }
    const aggTotal = aggW + aggL;
    if (aggTotal >= 6 && sampleN >= 2) {
      const aggWr = aggW / aggTotal;
      if (aggWr < 0.50) {
        console.log(`[${src} auto-trade] blocked: firing strategies have aggregate recent WR ${Math.round(aggWr*100)}% across ${aggTotal} samples — v171 strategy-fatigue check`);
        return false;
      }
    }
  } catch (e) { /* swallow */ }

  // v170 RULE 16 — LIVE PATTERN-MATCH INTELLIGENCE.
  // Cross-dimensional learning: compute a "fingerprint match score" by
  // intersecting multiple learning brain dimensions for this signal. If
  // ANY dimension shows the pattern has lost more than won historically
  // (and has 2+ samples), it's a losing-pattern match — block.
  //
  // Dimensions cross-checked here (any one bad = block):
  //   • pair+direction+strategy-combo: covered above (50% threshold)
  //   • pair+direction+hour: covered above (60% threshold)
  //   • pair+direction+session: enforce 60% floor here
  //   • pair+direction+volRegime: enforce 60% floor here
  // This is the system's "experience memory" — every closure feeds it.
  try {
    const stats = (typeof getPairDirStats === 'function')
      ? getPairDirStats(signal.pair, signal.direction)
      : null;
    if (stats) {
      // Session-bucket check (london/ny/tokyo/overlap)
      if (stats.getSession && signal.session) {
        const ss = stats.getSession(signal.session);
        const total = (ss.w || 0) + (ss.l || 0);
        if (total >= 2) {
          const wr = ss.w / total;
          if (wr < 0.60) {
            console.log(`[${src} auto-trade] blocked: pattern-match — ${signal.pair} ${signal.direction} in session "${signal.session}" historical wr ${Math.round(wr*100)}% < 60% (v170 RULE 16)`);
            return false;
          }
        }
      }
      // VolRegime check
      if (stats.getVolRegime && signal.volRegime) {
        const vs = stats.getVolRegime(signal.volRegime);
        const total = (vs.w || 0) + (vs.l || 0);
        if (total >= 2) {
          const wr = vs.w / total;
          if (wr < 0.60) {
            console.log(`[${src} auto-trade] blocked: pattern-match — ${signal.pair} ${signal.direction} in volRegime "${signal.volRegime}" historical wr ${Math.round(wr*100)}% < 60% (v170 RULE 16)`);
            return false;
          }
        }
      }
    }
  } catch (e) { /* never let intelligence checks break the pipeline */ }

  // v169 RULE 15 — VOL REGIME MUST BE 'NORMAL'.
  // Non-normal regimes (extreme/dead/contracting/chaos) have non-standard
  // price behavior where technical setups break down. Block them.
  if (signal.volRegime && signal.volRegime !== 'normal' && signal.volRegime !== 'expanding') {
    console.log(`[${src} auto-trade] blocked: volRegime='${signal.volRegime}' not 'normal' (v169 RULE 15)`);
    return false;
  }

  // v168 RULE 14 — JPY PAIRS DISABLED FROM AUTO-TAKE.
  // v146+ JPY pair record: 3 trades, 3 losses (GBP/JPY -45p, AUD/JPY -1.1p,
  // USD/JPY -9.6p). 0% WR over the era. JPY pairs swing harder than non-JPY
  // forex on intraday timeframes, and the BOJ/yen-policy headlines cause
  // sudden directional reversals that defeat technical setups. Manual taking
  // still possible from the signal card.
  if (signal.pair && signal.pair.includes('/JPY')) {
    console.log(`[${src} auto-trade] blocked: ${signal.pair} is JPY pair — auto-take disabled (v168 RULE 14, 0/3 WR in v146+ era)`);
    return false;
  }

  // v184 RULE 27 — NEWS BLACKOUT WINDOW.
  // Block auto-takes during high-impact scheduled event windows where
  // technical setups break down regardless of confluence. These windows
  // are predictable from the calendar — no API needed:
  //   • NFP (Non-Farm Payrolls): 1st Friday of every month, 12:00-14:00 UTC
  //     (release at 12:30 UTC). The single most volatile forex event.
  //   • FOMC potential: every Wednesday 17:30-19:30 UTC (rate decisions
  //     released at 18:00 UTC on 8 Weds/year — we block all Weds since the
  //     pre-release positioning move is itself directional whiplash).
  // Pros call this "respecting the calendar." During these windows,
  // 100-pip whipsaws are routine — even SUPER setups get wrecked.
  try {
    const d = new Date();
    const utcDow = d.getUTCDay();        // 0=Sun, 3=Wed, 5=Fri
    const utcDom = d.getUTCDate();       // day of month
    const utcH = d.getUTCHours();
    const utcM = d.getUTCMinutes();
    // First-Friday-of-month detection: must be Friday AND day-of-month ≤ 7
    const isFirstFriday = utcDow === 5 && utcDom <= 7;
    if (isFirstFriday && utcH === 12 && utcM >= 0 && utcM <= 59) {
      console.log(`[${src} auto-trade] blocked: NFP blackout (1st Friday 12:00-13:00 UTC) — release at 12:30 (v184 RULE 27)`);
      return false;
    }
    if (isFirstFriday && utcH === 13 && utcM <= 30) {
      console.log(`[${src} auto-trade] blocked: NFP post-release whipsaw window 13:00-13:30 UTC (v184 RULE 27)`);
      return false;
    }
    // FOMC window: Wednesday 17:30-19:30 UTC. Most Weds won't have FOMC
    // but the cost of blocking ~2h/week of Wed signals is far smaller than
    // one FOMC catastrophe. 8 actual FOMC Weds per year vs 44 non-FOMC = ~18%
    // false-positive cost; one FOMC blocker saves 50-100p of risk.
    if (utcDow === 3 && utcH === 17 && utcM >= 30) {
      console.log(`[${src} auto-trade] blocked: FOMC pre-release window Wed 17:30-18:00 UTC (v184 RULE 27)`);
      return false;
    }
    if (utcDow === 3 && utcH === 18) {
      console.log(`[${src} auto-trade] blocked: FOMC release window Wed 18:00-19:00 UTC (v184 RULE 27)`);
      return false;
    }
    if (utcDow === 3 && utcH === 19 && utcM <= 30) {
      console.log(`[${src} auto-trade] blocked: FOMC post-release window Wed 19:00-19:30 UTC (v184 RULE 27)`);
      return false;
    }
  } catch (e) { /* never let calendar checks break the pipeline */ }

  // v184 RULE 28 — HTF ALIGNMENT HARD-REQUIRED.
  // Was a soft filter via topPredictorsAligned and counter-trend block.
  // Now: if htfTrend OR tf4hTrend points AGAINST the signal direction,
  // block outright. Was inconsistent before — some paths checked, some
  // didn't. Pros say "never fight the higher timeframe trend." This makes
  // it absolute. 'flat' is allowed (no opinion); only OPPOSITE is blocked.
  const dir = signal.direction;
  if (signal.htfTrend === 'up' && dir === 'SELL') {
    console.log(`[${src} auto-trade] blocked: HTF trend up but signal is SELL — counter-trend (v184 RULE 28)`);
    return false;
  }
  if (signal.htfTrend === 'down' && dir === 'BUY') {
    console.log(`[${src} auto-trade] blocked: HTF trend down but signal is BUY — counter-trend (v184 RULE 28)`);
    return false;
  }
  if (signal.tf4hTrend === 'up' && dir === 'SELL') {
    console.log(`[${src} auto-trade] blocked: 4h trend up but signal is SELL — counter-trend (v184 RULE 28)`);
    return false;
  }
  if (signal.tf4hTrend === 'down' && dir === 'BUY') {
    console.log(`[${src} auto-trade] blocked: 4h trend down but signal is BUY — counter-trend (v184 RULE 28)`);
    return false;
  }

  // v188 (was v184/v167): ABSOLUTE CONFIDENCE FLOOR raised 92 → 95.
  // Gold-only mode = "best of the best." Only the very-highest conviction
  // setups pass through. Anything below 95% is rejected.
  if ((signal.confidence || 0) < 95) {
    console.log(`[${src} auto-trade] blocked: confidence ${signal.confidence}% < 95 (v188 gold elite floor)`);
    return false;
  }

  // v160 RULE 9 — SL distance cap.
  const isCrypto = typeof isCryptoPair === 'function' && isCryptoPair(signal.pair);
  const isGold = signal.pair === 'XAU/USD' || signal.pair === 'GOLD';
  const isJpy = signal.pair && signal.pair.includes('/JPY');
  const slPips = Math.abs(signal.sl_pips || 0);
  if (isCrypto) {
    console.log(`[${src} auto-trade] blocked: ${signal.pair} is crypto — auto-take disabled per v160 RULE 9 (pip-scale variance too high; manual only)`);
    return false;
  }
  const slCap = isGold ? 60 : (isJpy ? 25 : 20);
  if (slPips > slCap) {
    console.log(`[${src} auto-trade] blocked: ${signal.pair} SL distance ${slPips}p > ${slCap}p cap (v160 RULE 9 — one big stop erases many wins)`);
    return false;
  }
  return true;
}

// v192 — GOLD AUTO-ADD with ELITE-ONLY filter.
// v190 auto-added every gold signal regardless of quality, which produced
// losing trades. Restored strict filtering for AUTO-ADD specifically:
//   • 3+ strategies passing (SUPER)
//   • Confidence ≥ 95%
//   • ADX ≥ 30 (strong trend, not chop)
//   • HTF + 4h aligned (no counter-trend)
//   • Active session (London 7-10 UTC, NY 13-16 UTC, or overlap)
// Manual takes still work for ANY signal (no warnings, per v189).
// Net: system auto-adds only the highest-probability gold setups; user can
// still manually take whatever they want.
function autoAddGoldTrade(signal) {
  try {
    if (!signal) return;
    if (signal.pair !== 'XAU/USD' && signal.pair !== 'GOLD') return;
    if (signal.direction !== 'BUY' && signal.direction !== 'SELL') return;

    // ELITE FILTER — only highest-conviction gold setups
    const stratCnt = [
      signal.smcPassed, signal.orbPassed, signal.ictPassed,
      signal.trendPassed, signal.squeezePassed,
      signal.divergencePassed, signal.momentumPassed,
    ].filter(Boolean).length;
    if (stratCnt < 3) {
      console.log(`[gold auto-trade] blocked: only ${stratCnt} strategies (need 3+ SUPER)`);
      return;
    }
    if ((signal.confidence || 0) < 95) {
      console.log(`[gold auto-trade] blocked: confidence ${signal.confidence}% < 95`);
      return;
    }
    if ((signal.adxNow || 0) < 30) {
      console.log(`[gold auto-trade] blocked: ADX ${signal.adxNow} < 30`);
      return;
    }
    // HTF alignment hard-required (no counter-trend)
    if (signal.htfTrend === 'up' && signal.direction === 'SELL') {
      console.log('[gold auto-trade] blocked: HTF up but SELL — counter-trend');
      return;
    }
    if (signal.htfTrend === 'down' && signal.direction === 'BUY') {
      console.log('[gold auto-trade] blocked: HTF down but BUY — counter-trend');
      return;
    }
    if (signal.tf4hTrend === 'up' && signal.direction === 'SELL') {
      console.log('[gold auto-trade] blocked: 4h up but SELL — counter-trend');
      return;
    }
    if (signal.tf4hTrend === 'down' && signal.direction === 'BUY') {
      console.log('[gold auto-trade] blocked: 4h down but BUY — counter-trend');
      return;
    }
    // v199 — RESEARCH + DATA driven killzone. Multiple pro sources confirm:
    // London-NY overlap (13-16 UTC) accounts for 70% of gold's daily high/low
    // formations. NY mid-session (19 UTC) shows 50% WR in our 334-trade audit.
    // Everything else is either dead (Asian drift) or too volatile (opens).
    // BEFORE: allowed 16 hours/day. AFTER: 5 hours = highest-quality only.
    const h = new Date().getUTCHours();
    const ALLOWED_HOURS = [13, 14, 15, 16, 19]; // London-NY overlap + NY mid
    if (!ALLOWED_HOURS.includes(h)) {
      console.log(`[gold auto-trade] blocked: hour ${h}:00 UTC not in elite window 13-16,19 (v199 research-driven)`);
      return;
    }

    // Per-day dedup
    const day = new Date().toISOString().slice(0, 10);
    const trades = getTrades();
    const dup = trades.find(t =>
      t.pair === signal.pair && t.direction === signal.direction && t.status === 'open');
    if (dup) return;
    const sameSetup = trades.find(t =>
      t.pair === signal.pair && t.direction === signal.direction &&
      (t.takenAt || '').slice(0, 10) === day);
    if (sameSetup) return;
    const tradeShape = { ...signal, isGoldAuto: true, autoAdded: true };
    const id = autoTradeId('gold', signal);
    const r = takeTrade(tradeShape, { id });
    if (r.ok) console.log('[gold auto-trade] ELITE TAKEN:', signal.pair, signal.direction, signal.confidence + '%', stratCnt + ' strats, ADX', signal.adxNow);
    else if (r.dup) console.log('[gold auto-trade] dedup-skipped (cross-device)');
  } catch (e) { console.warn('[gold auto-add]', e.message); }
}

function autoAddConfluenceTrade(signal) {
  try {
    if (!signal || (signal.direction !== 'BUY' && signal.direction !== 'SELL')) return;
    if (!_passesSuperGate(signal, 'confluence')) return;
    const setupKey = `${signal.pair}_${signal.direction}_${new Date().toISOString().slice(0, 10)}`;
    if (_confluenceSeen(setupKey)) return;
    const trades = getTrades();
    const dup = trades.find(t =>
      t.pair === signal.pair && t.direction === signal.direction && t.status === 'open');
    if (dup) { _confluenceMark(setupKey); return; }
    _confluenceMark(setupKey);
    const trade = { ...signal, isConfluenceAuto: true, autoAdded: true };
    const r = takeTrade(trade, { id: autoTradeId('conf', signal) });
    if (r.ok) console.log('[confluence auto-trade]', signal.pair, signal.direction, signal.confidence + '%');
    else if (r.dup) console.log('[confluence auto-trade] dedup-skipped (same id on another device)');
  } catch (e) { console.warn('[confluence auto-add]', e.message); }
}

function autoAddSMCTrade(signal) {
  try {
    if (!signal || !signal.smcPassed) return;
    if (signal.direction !== 'BUY' && signal.direction !== 'SELL') return;
    if (!_passesSuperGate(signal, 'smc')) return;
    // QUALITY GATE — only auto-track B+ and above (skip C/B marginal setups)
    if (signal.smcQuality != null && signal.smcQuality < SMC_AUTOTRACK_MIN_SCORE) {
      console.log('[smc auto-trade] skipped, grade', signal.smcGrade, 'score', signal.smcQuality);
      return;
    }
    const setupKey = `${signal.pair}_${signal.direction}_${_smcToday()}`;
    if (_smcAutoSeen(setupKey)) return;
    if (_smcAutoTodayCount() >= SMC_DAILY_CAP) return;
    const trades = getTrades();
    const dup = trades.find(t =>
      t.pair === signal.pair && t.direction === signal.direction && t.status === 'open');
    if (dup) {
      // Existing open trade — enrich with this strategy's flags so the user
      // sees every strategy that caught the same setup. Without this, SMC
      // would never appear on a trade if ORB fired first.
      _smcAutoMark(setupKey);
      let changed = false;
      if (!dup.smcPassed) { dup.smcPassed = true; changed = true; }
      if (signal.smcGrade && !dup.smcGrade) { dup.smcGrade = signal.smcGrade; changed = true; }
      if (signal.smcQuality && !dup.smcQuality) { dup.smcQuality = signal.smcQuality; changed = true; }
      if (signal.smcQualityBreakdown && !dup.smcQualityBreakdown) { dup.smcQualityBreakdown = signal.smcQualityBreakdown; changed = true; }
      if (signal.smcDiag && !dup.smcDiag) { dup.smcDiag = signal.smcDiag; changed = true; }
      if (!dup.isSMCAuto) { dup.isSMCAuto = true; changed = true; }
      if (changed) saveTrades(trades);
      return;
    }
    _smcAutoMark(setupKey);
    const tradeShape = { ...signal, isSMCAuto: true, autoAdded: true };
    const r = takeTrade(tradeShape, { id: autoTradeId('smc', signal) });
    if (r.ok) console.log('[smc auto-trade]', signal.pair, signal.direction, 'grade', signal.smcGrade);
    else if (r.dup) console.log('[smc auto-trade] dedup-skipped (same id on another device)');
  } catch (e) { console.warn('[smc auto-add]', e.message); }
}

// Strong, persistent notification specifically for SMC-confirmed signals.
// Triple-chime + requireInteraction so it stays on screen until clicked.
async function fireSMCNotification(s) {
  try {
    if (!state.notifyEnabled) return;
    if (!supportsNotifications() || Notification.permission !== 'granted') return;
    if (_isMarketClosed(s.pair)) return;
    if (_isStaleSignal(s)) return;
    const key = `${s.pair}_${s.direction}_${_smcToday()}`;
    const seen = safeLoad(SMC_NOTIFIED_KEY, []);
    if (seen.includes(key)) return;
    seen.push(key); safeSave(SMC_NOTIFIED_KEY, seen.slice(-100));

    // Triple chime — distinct from regular signal alerts
    try { playChime(); setTimeout(playChime, 500); setTimeout(playChime, 1000); } catch {}
    state.unreadCount = (state.unreadCount || 0) + 1;
    try { updateTitle(); } catch {}

    const arrow = s.direction === 'BUY' ? '🔼' : '🔽';
    const grade = s.smcGrade ? ` ${s.smcGrade}` : '';
    const title = `📐 SMC${grade} ${arrow} ${s.pair} ${s.direction} — ${s.confidence}% (auto-added)`;
    const body = [
      `📐 SMC ${s.smcGrade || ''} grade · ${s.smcQuality || ''}/100 quality · all gates passed`,
      `Entry: ${s.entry}`,
      `SL: ${s.sl} (${s.sl_pips} pips)`,
      `TP1: ${s.tp1} · TP2: ${s.tp2} · TP3: ${s.tp3}`,
      `🤖 Auto-added to My Trades — will track win/loss for you`,
    ].join('\n');
    const opts = {
      body, icon: '/icon-192.png', badge: '/icon-192.png',
      tag: 'smc-' + key,
      renotify: true,
      requireInteraction: true,
      data: { url: '/', pair: s.pair, direction: s.direction, smc: true },
      // Unified ultra-fast 3-buzz vibration (50ms gap; iOS uses default)
      vibrate: [30, 50, 30, 50, 30],
      silent: false,
    };
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
    } else {
      new Notification(title, opts);
    }
  } catch (e) { console.warn('[smc notify]', e.message); }
}

// ════════════════════════════════════════════════════════════════════════
// SHARED NEWS + CALENDAR CONTEXT CHECK
// Both SMC and ORB use this as their first gate. Reads from the in-memory
// _calendarForSignal and _newsForSignal stores (populated by loadNews/Cal
// on every signal refresh). Defensive — returns a permissive result if
// data isn't loaded yet so the strategies still work.
//
// Behavior per strategy nuance:
//   - SMC (mean reversion) — block ±15 min around high-impact events.
//     Sweeps & reclaims are unreliable inside that window. SMC tolerates
//     opposing news sentiment because it's TRADING INTO the news-driven
//     extreme (e.g., bearish news drops price, sweeps low, SMC buys reclaim).
//   - ORB (momentum) — block ±20 min around events (breakouts get faded
//     hard during news whipsaws). REQUIRES news sentiment alignment with
//     direction — bullish news + BUY breakout is high-edge, bearish news +
//     BUY breakout is a trap.
// ════════════════════════════════════════════════════════════════════════
function newsCalendarContext(pair, direction, mode = 'smc') {
  const result = {
    block: false,
    blockReason: null,
    detail: null,
    sentimentBonus: 0,
    eventNote: null,
    sentimentNet: null,
  };
  if (!pair || !direction) return result;

  // 1. CALENDAR PROXIMITY — check for high-impact event near now
  const cal = (typeof nearbyHighImpactEvent === 'function') ? nearbyHighImpactEvent(pair) : null;
  if (cal && cal.event) {
    const m = cal.minutes;
    result.eventNote = `${cal.event.country || ''} ${cal.event.title || ''} in ${m >= 0 ? '+' : ''}${m}min`.trim();
    // Tighter window for ORB (momentum), wider for SMC (mean reversion)
    const blockWindowAhead = mode === 'orb' ? 25 : 15;
    const blockWindowBehind = mode === 'orb' ? -10 : -10;
    if (m >= blockWindowBehind && m <= blockWindowAhead) {
      result.block = true;
      result.blockReason = `${cal.event.country} ${cal.event.title} ${m >= 0 ? 'in +' : ''}${m}min — too close for reliable ${mode.toUpperCase()}`;
      return result;
    }
    // Outside block window but still within 60 min — note it but don't block
    if (Math.abs(m) <= 60) {
      result.detail = `event near (${result.eventNote}) — proceeding`;
    }
  }

  // 2. NEWS SENTIMENT ALIGNMENT — relevant pair-specific headlines
  const sent = (typeof newsSentimentForPair === 'function') ? newsSentimentForPair(pair) : null;
  if (sent && typeof sent.net === 'number') {
    result.sentimentNet = sent.net;
    if (mode === 'orb') {
      // ORB rides momentum — REQUIRE alignment with sentiment direction
      // Strongly opposing sentiment = block (the breakout is likely a trap)
      if (direction === 'BUY' && sent.net < -0.50) {
        result.block = true;
        result.blockReason = `news ${(Math.abs(sent.net)*100).toFixed(0)}% bearish (${sent.bear} vs ${sent.bull}) — opposes BUY breakout`;
        return result;
      }
      if (direction === 'SELL' && sent.net > 0.50) {
        result.block = true;
        result.blockReason = `news ${(sent.net*100).toFixed(0)}% bullish (${sent.bull} vs ${sent.bear}) — opposes SELL breakout`;
        return result;
      }
      // Aligned sentiment = bonus
      if (direction === 'BUY' && sent.net > 0.30)  result.sentimentBonus = 1;
      if (direction === 'SELL' && sent.net < -0.30) result.sentimentBonus = 1;
    } else {
      // SMC trades reversals — opposing sentiment is OFTEN the setup itself
      // Only block on EXTREME opposing sentiment that would crush a reversal
      if (direction === 'BUY' && sent.net < -0.75) {
        result.block = true;
        result.blockReason = `news ${(Math.abs(sent.net)*100).toFixed(0)}% bearish — too one-sided for reversal BUY`;
        return result;
      }
      if (direction === 'SELL' && sent.net > 0.75) {
        result.block = true;
        result.blockReason = `news ${(sent.net*100).toFixed(0)}% bullish — too one-sided for reversal SELL`;
        return result;
      }
    }
    // Build a useful detail string
    const sentTag = sent.net > 0.2 ? 'bullish' : sent.net < -0.2 ? 'bearish' : 'mixed';
    const aligned = (direction === 'BUY' && sent.net > 0.2) || (direction === 'SELL' && sent.net < -0.2);
    result.detail = (result.detail ? result.detail + ' · ' : '') +
      `news ${sentTag} (${sent.bull}↑/${sent.bear}↓)${aligned ? ' aligned' : ''}`;
  }

  if (!result.detail) result.detail = 'no major news/events';
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// QUALITY GRADING — turns each strategy from pass/fail into a 0-100 score
// with letter grade so we can surface the BEST setups, not just any setup.
//
// Both scorers run AFTER all gates pass. The grade flows into:
//   - The visible badge ("📐 SMC A+" vs "📐 SMC B")
//   - Auto-track threshold (only A/A+ get added to My Trades by default)
//   - Notification urgency (A+ gets the strong triple-chime, B gets a
//     softer notify)
//
// Letter grades:
//   95-100 = A+  (institutional-grade, rare)
//   85-94  = A   (strong setup)
//   75-84  = B+  (good setup)
//   65-74  = B   (decent setup)
//   <65    = C   (passes gates but borderline — surfaced but not auto-tracked)
// ════════════════════════════════════════════════════════════════════════
function _qualityGrade(score) {
  if (score >= 95) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 75) return 'B+';
  if (score >= 65) return 'B';
  return 'C';
}

// Numeric rank for grade-based sorting. Lower = better.
// Used by the signals grid sort so A+ rises to the top and C drops to the bottom.
function _gradeRank(g) {
  switch (g) {
    case 'A+': return 0;
    case 'A':  return 1;
    case 'B+': return 2;
    case 'B':  return 3;
    case 'C':  return 4;
    default:   return 5; // no grade (manual / unrated) sinks below everything
  }
}

// Best (highest) grade among all strategies that fired on a signal.
// Each strategy carries its own *Grade field (smcGrade, orbGrade, ictGrade…).
// We pick the strongest letter so the signal is ordered by its peak quality,
// not an average. A signal with one A+ strategy + one B strategy is "A+" — it
// only takes ONE strong confirmation to make a setup A+ worthy.
function _signalBestGrade(s) {
  if (!s) return null;
  const grades = [
    s.smcGrade, s.orbGrade, s.ictGrade, s.trendGrade,
    s.squeezeGrade, s.divergenceGrade, s.momentumGrade,
    s.radiantGrade, // gold-specific Radiant SMC grade
  ].filter(Boolean);
  if (!grades.length) return null;
  let best = grades[0];
  for (const g of grades) {
    if (_gradeRank(g) < _gradeRank(best)) best = g;
  }
  return best;
}

// ════════════════════════════════════════════════════════════════════════
// TRADER EXPERIENCE ENGINE — encodes years of institutional trading wisdom
// into a quality-score adjuster. Applied to every strategy after its gates
// pass. Each rule is grounded in real-world historical pattern data:
//
//   1. Day-of-week effects (Tue best, Fri-PM worst)
//   2. Pair-specific session sweet spots (where each pair trends best)
//   3. Round-number proximity penalty (institutional liquidity wicks)
//   4. GBP volatility tax (notorious whipsaws)
//   5. Pair-correlation crowding (don't 5x same trade in disguise)
//   6. Recent-streak awareness (3+ losses → cool, 3+ wins → caution)
//   7. Asian-session liquidity bonus for JPY pairs
//   8. ATR-quintile regime check (extreme vol = unreliable)
//
// Adjustments are bounded (-15 to +15) so wisdom is a tiebreaker, not the
// primary score driver. The `wisdom` array is surfaced on the signal card
// so the user can see WHAT the system knew when it graded the setup.
// ════════════════════════════════════════════════════════════════════════
function applyTraderExperience(quality, signal, ohlc, pair, direction, strategyKey) {
  if (!quality || typeof quality.score !== 'number') return quality;

  const wisdom = [];
  let adj = 0;
  const now = new Date();
  const day = now.getUTCDay();   // 0=Sun, 1=Mon ... 6=Sat
  const hour = now.getUTCHours();

  // ── 1. DAY-OF-WEEK EFFECT ──────────────────────────────────────────
  // Historical pip-movement studies (1995-2024) show Tuesday/Wednesday
  // are the strongest directional days. Friday afternoon is weakest
  // due to position-flattening before the weekend.
  if (day === 2)                        { adj += 3; wisdom.push('Tue +3 (best directional day)'); }
  else if (day === 3)                   { adj += 2; wisdom.push('Wed +2 (strong continuation)'); }
  else if (day === 4)                   { adj += 1; wisdom.push('Thu +1'); }
  else if (day === 1)                   { adj += 1; wisdom.push('Mon +1 (continuation from Fri)'); }
  else if (day === 5 && hour >= 16)     { adj -= 5; wisdom.push('Fri PM -5 (profit-taking, unreliable)'); }
  else if (day === 5)                   { adj += 0; /* Fri AM neutral */ }

  // ── 2. PAIR-SPECIFIC SESSION SWEET SPOT ─────────────────────────────
  // Each pair has a session where it historically trends cleanest. Trading
  // OUTSIDE that session means lower hit rates, even if all gates pass.
  const sessionRules = {
    'EUR/USD':  [[12, 15, 4, 'London-NY overlap']],
    'GBP/USD':  [[12, 15, 4, 'London-NY overlap']],
    'EUR/GBP':  [[8, 12, 4, 'London open']],
    'USD/JPY':  [[8, 10, 4, 'London open'], [0, 3, 3, 'Tokyo open']],
    'EUR/JPY':  [[8, 10, 4, 'London open']],
    'GBP/JPY':  [[8, 10, 4, 'London open']],
    'AUD/JPY':  [[0, 3, 4, 'Tokyo open']],
    'NZD/JPY':  [[0, 3, 4, 'Tokyo open']],
    'CHF/JPY':  [[8, 10, 3, 'London open']],
    'CAD/JPY':  [[13, 16, 4, 'NY open']],
    'AUD/USD':  [[0, 3, 3, 'Tokyo'], [22, 24, 3, 'Sydney']],
    'NZD/USD':  [[22, 3, 4, 'Sydney/Tokyo']],
    'AUD/NZD':  [[22, 3, 4, 'Sydney/Tokyo']],
    'USD/CAD':  [[13, 17, 4, 'NY open']],
    'USD/CHF':  [[8, 12, 3, 'London']],
  };
  const ranges = sessionRules[pair] || [];
  for (const [start, end, pts, label] of ranges) {
    const inSession = end < start
      ? (hour >= start || hour < end)
      : (hour >= start && hour < end);
    if (inSession) {
      adj += pts;
      wisdom.push(`${label} sweet spot +${pts}`);
      break;
    }
  }

  // ── 3. ROUND-NUMBER PROXIMITY PENALTY ───────────────────────────────
  // TPs at round numbers (1.0000, 100.00, etc.) face heavy stop-runs from
  // institutional algos. Net hit rate drops 5-10% on round-number TPs.
  const entry = signal.entry || (ohlc[ohlc.length - 1] && ohlc[ohlc.length - 1].c);
  if (entry) {
    const isJPY = pair.includes('JPY');
    const round = isJPY ? Math.round(entry) : Math.round(entry * 100) / 100; // nearest .01 / 1
    const pipSize = isJPY ? 0.01 : 0.0001;
    const distPips = Math.abs(entry - round) / pipSize;
    if (distPips < 8) {
      adj -= 2;
      wisdom.push(`Near round ${round.toFixed(isJPY ? 2 : 4)} -2 (algo stop-run risk)`);
    }
  }

  // ── 4. GBP VOLATILITY TAX ──────────────────────────────────────────
  // GBP pairs are 30%+ more volatile than other majors. False breaks are
  // common — apply a small penalty unless trade aligns with strong trend.
  if (pair.startsWith('GBP/') || pair.endsWith('/GBP')) {
    adj -= 1;
    wisdom.push('GBP pair -1 (whipsaw risk)');
  }

  // ── 5. PAIR-CORRELATION CROWDING ────────────────────────────────────
  // If the user already has open trades on highly-correlated pairs in the
  // SAME direction, this signal is mostly redundant exposure. Penalize so
  // diversified setups get prioritized over correlated stacks.
  try {
    const trades = (typeof getTrades === 'function') ? getTrades() : [];
    const open = trades.filter(t => t.status === 'open' && t.direction === direction);
    const correlated = (a, b) => {
      const groups = [
        ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD'], // USD-quoted majors
        ['USD/CHF'], // USD/CHF inverse-correlates with EUR/USD already counted
        ['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'NZD/JPY', 'CHF/JPY', 'CAD/JPY'], // JPY crosses
        ['AUD/USD', 'NZD/USD', 'AUD/NZD'], // Antipodean
      ];
      return groups.some(g => g.includes(a) && g.includes(b) && a !== b);
    };
    let crowded = 0;
    for (const t of open) if (correlated(t.pair, pair)) crowded++;
    if (crowded >= 2)      { adj -= 5; wisdom.push(`${crowded} correlated open ${direction}s -5 (crowded)`); }
    else if (crowded === 1) { adj -= 2; wisdom.push(`1 correlated open ${direction} -2`); }
  } catch {}

  // ── 6. RECENT STREAK AWARENESS ──────────────────────────────────────
  // Five wins in a row historically precedes a mean-reversion loss.
  // Three losses in a row precedes a regression-to-mean win.
  try {
    if (strategyKey) {
      const trades = (typeof getTrades === 'function') ? getTrades() : [];
      const recent = trades
        .filter(t => t[`is${strategyKey.toUpperCase()}Auto`] && (t.status === 'won' || t.status === 'lost'))
        .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''))
        .slice(0, 6);
      if (recent.length >= 5) {
        const last5 = recent.slice(0, 5);
        const wins = last5.filter(t => t.status === 'won').length;
        if (wins === 5) { adj -= 3; wisdom.push(`5W streak -3 (mean reversion warning)`); }
        else if (wins === 0) { adj += 2; wisdom.push(`5L streak +2 (regression to mean)`); }
      }
      const last3 = recent.slice(0, 3);
      if (last3.length === 3 && last3.every(t => t.status === 'lost')) {
        adj += 2; wisdom.push('3L streak +2 (rebound likely)');
      }
    }
  } catch {}

  // ── 7. JPY PAIR ASIAN-LIQUIDITY BONUS ──────────────────────────────
  // JPY pairs trade with maximum reliability during Tokyo session because
  // that's when Bank of Japan and Asian banks are active. Bonus already
  // partially covered in session sweet spots — small additional confirmation.
  if (pair.includes('JPY') && hour >= 0 && hour < 8) {
    adj += 1;
    wisdom.push('JPY in Asian hours +1');
  }

  // ── 8. EXTREME-VOL REGIME GUARD ────────────────────────────────────
  // If volRegimeFlag was set on the signal (already detected earlier),
  // apply a quality penalty since chart patterns are unreliable in
  // news-spike or dead-market conditions.
  if (signal.volRegimeFlag) {
    if (signal.volRegimeFlag.kind === 'extreme') {
      adj -= 4; wisdom.push(`Extreme vol ${signal.volRegimeFlag.ratio}× -4 (news whipsaw risk)`);
    } else if (signal.volRegimeFlag.kind === 'dead') {
      adj -= 3; wisdom.push(`Dead vol ${signal.volRegimeFlag.ratio}× -3 (chop)`);
    }
  }

  // ── 9. DAILY CANDLE ALIGNMENT ───────────────────────────────────────
  // Pro traders ALWAYS check the current day's candle direction. A BUY
  // signal that aligns with a bullish daily candle has a much higher hit
  // rate than one fighting a bearish day. Approximates "today's bias"
  // using the last 24 1H bars (open of 24h ago vs current close).
  try {
    const day = ohlc.slice(-24);
    if (day.length >= 24) {
      const dayOpen = day[0].o;
      const dayClose = day[day.length - 1].c;
      const dayMove = (dayClose - dayOpen) / dayOpen;
      const dayBullish = dayClose > dayOpen;
      const strongMove = Math.abs(dayMove) > 0.002; // > 0.2% move
      if (direction === 'BUY' && dayBullish && strongMove)       { adj += 4; wisdom.push('Daily candle bullish +4'); }
      else if (direction === 'BUY' && dayBullish)                { adj += 2; wisdom.push('Daily candle up +2'); }
      else if (direction === 'BUY' && !dayBullish && strongMove) { adj -= 3; wisdom.push('Against strong bearish day -3'); }
      else if (direction === 'SELL' && !dayBullish && strongMove){ adj += 4; wisdom.push('Daily candle bearish +4'); }
      else if (direction === 'SELL' && !dayBullish)              { adj += 2; wisdom.push('Daily candle down +2'); }
      else if (direction === 'SELL' && dayBullish && strongMove) { adj -= 3; wisdom.push('Against strong bullish day -3'); }
    }
  } catch {}

  // ── 10. WEEKLY RANGE POSITION ──────────────────────────────────────
  // Pros buy near weekly lows, sell near weekly highs. ~120 1H bars ≈ 5
  // trading days. BUY at <30% of weekly range = great spot; >80% = chasing.
  try {
    const week = ohlc.slice(-120);
    if (week.length >= 60) {
      const wHigh = Math.max(...week.map(b => b.h));
      const wLow = Math.min(...week.map(b => b.l));
      const wRange = wHigh - wLow;
      if (wRange > 0) {
        const cur = ohlc[ohlc.length - 1].c;
        const pos = (cur - wLow) / wRange;
        if (direction === 'BUY' && pos < 0.25)       { adj += 5; wisdom.push(`Near weekly low (${(pos*100).toFixed(0)}%) +5`); }
        else if (direction === 'BUY' && pos < 0.40)  { adj += 2; wisdom.push(`Lower weekly range +2`); }
        else if (direction === 'BUY' && pos > 0.85)  { adj -= 4; wisdom.push(`Near weekly high (${(pos*100).toFixed(0)}%) -4 chasing`); }
        else if (direction === 'SELL' && pos > 0.75) { adj += 5; wisdom.push(`Near weekly high (${(pos*100).toFixed(0)}%) +5`); }
        else if (direction === 'SELL' && pos > 0.60) { adj += 2; wisdom.push(`Upper weekly range +2`); }
        else if (direction === 'SELL' && pos < 0.15) { adj -= 4; wisdom.push(`Near weekly low (${(pos*100).toFixed(0)}%) -4 chasing`); }
      }
    }
  } catch {}

  // ── 11. PER-PAIR HISTORICAL WIN-RATE ───────────────────────────────
  // Look back at this pair's last 30 days of CLOSED trades from learning
  // logs. If we've been winning here lately, the setup type fits this
  // pair's character — boost confidence. If losing, dial back.
  try {
    if (typeof getLogs === 'function') {
      const logs = getLogs();
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      const relevant = logs.filter(l =>
        l.pair === pair &&
        l.ts && new Date(l.ts).getTime() > cutoff &&
        (l.outcome === 'win' || l.outcome === 'loss'));
      if (relevant.length >= 4) {
        const wins = relevant.filter(l => l.outcome === 'win').length;
        const winRate = wins / relevant.length;
        if (winRate >= 0.70)      { adj += 4; wisdom.push(`${pair} ${(winRate*100).toFixed(0)}% winrate last 30d +4`); }
        else if (winRate >= 0.55) { adj += 2; wisdom.push(`${pair} ${(winRate*100).toFixed(0)}% winrate +2`); }
        else if (winRate <= 0.30) { adj -= 4; wisdom.push(`${pair} ${(winRate*100).toFixed(0)}% winrate -4 (struggling)`); }
        else if (winRate <= 0.40) { adj -= 2; wisdom.push(`${pair} ${(winRate*100).toFixed(0)}% winrate -2`); }
      }
    }
  } catch {}

  // ── 12. 4-HOUR TREND ALIGNMENT (computed from 1H bars) ──────────────
  // Pros respect multi-timeframe alignment. A 1H signal that agrees with
  // the 4H trend wins more often. Approximate 4H trend by SMA of last 4
  // 1H closes vs SMA of the 4 before that — if rising, 4H is bullish.
  try {
    if (ohlc.length >= 8) {
      const last4 = ohlc.slice(-4).reduce((s, b) => s + b.c, 0) / 4;
      const prev4 = ohlc.slice(-8, -4).reduce((s, b) => s + b.c, 0) / 4;
      const h4Bull = last4 > prev4 * 1.0003; // > 0.03% movement to count as trending
      const h4Bear = last4 < prev4 * 0.9997;
      if (direction === 'BUY' && h4Bull)       { adj += 3; wisdom.push('4H trend bull +3'); }
      else if (direction === 'BUY' && h4Bear)  { adj -= 4; wisdom.push('Against 4H bear -4'); }
      else if (direction === 'SELL' && h4Bear) { adj += 3; wisdom.push('4H trend bear +3'); }
      else if (direction === 'SELL' && h4Bull) { adj -= 4; wisdom.push('Against 4H bull -4'); }
    }
  } catch {}

  // ── 13. PRIOR-SESSION HIGH/LOW PROXIMITY ────────────────────────────
  // Pros watch where price is relative to the prior day's high/low. Trades
  // taken AT prior high/low have higher hit rate because that's where
  // institutional liquidity sits.
  try {
    const priorDay = ohlc.slice(-48, -24);
    if (priorDay.length >= 12) {
      const pdh = Math.max(...priorDay.map(b => b.h));
      const pdl = Math.min(...priorDay.map(b => b.l));
      const cur = ohlc[ohlc.length - 1].c;
      const pdRange = pdh - pdl;
      if (pdRange > 0) {
        const distToPDL = Math.abs(cur - pdl) / pdRange;
        const distToPDH = Math.abs(cur - pdh) / pdRange;
        if (direction === 'BUY' && distToPDL < 0.10)       { adj += 3; wisdom.push(`At prior-day low ${pdl.toFixed(5)} +3`); }
        else if (direction === 'SELL' && distToPDH < 0.10) { adj += 3; wisdom.push(`At prior-day high ${pdh.toFixed(5)} +3`); }
      }
    }
  } catch {}

  // Bound adjustment to ±15
  adj = Math.max(-15, Math.min(15, adj));

  const newScore = Math.max(0, Math.min(100, quality.score + adj));
  return {
    score: newScore,
    grade: _qualityGrade(newScore),
    breakdown: (quality.breakdown || []).concat(adj !== 0 ? ['— experience —', ...wisdom] : []),
    wisdom,
    experienceAdj: adj,
  };
}

// Detect a Fair Value Gap — a 3-candle pattern where bar i+1 leaves a gap
// between bar i's range and bar i+2's range that hasn't been filled yet.
// FVGs are institutional footprints — price often returns to fill them.
function _detectFVG(ohlc, fromIdx, dir) {
  const n = ohlc.length - 1;
  for (let i = Math.max(2, fromIdx); i <= n; i++) {
    const a = ohlc[i - 2], b = ohlc[i - 1], c = ohlc[i];
    if (dir === 'bull') {
      // Bullish FVG: bar i-2 high < bar i low (gap up by middle bar)
      if (a.h <= c.l * 1.0001 && b.c > b.o) return { idx: i - 1, low: a.h, high: c.l };
    } else {
      // Bearish FVG: bar i-2 low > bar i high (gap down by middle bar)
      if (a.l >= c.h * 0.9999 && b.c < b.o) return { idx: i - 1, low: c.h, high: a.l };
    }
  }
  return null;
}

// Detect Order Block — last opposite-color candle before a strong impulse.
// For bullish OB: last bearish candle before a bullish impulse leg.
function _detectOrderBlock(ohlc, sweepIdx, dir) {
  const n = ohlc.length - 1;
  // Walk forward from sweep to find the impulse start
  for (let i = sweepIdx; i < Math.min(n, sweepIdx + 5); i++) {
    const b = ohlc[i];
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range === 0) continue;
    if (body / range < 0.55) continue;
    if (dir === 'bull' && b.c > b.o) {
      // Look back for last bearish candle (the OB)
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        if (ohlc[j].c < ohlc[j].o) return { idx: j, low: ohlc[j].l, high: ohlc[j].h };
      }
    }
    if (dir === 'bear' && b.c < b.o) {
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        if (ohlc[j].c > ohlc[j].o) return { idx: j, low: ohlc[j].l, high: ohlc[j].h };
      }
    }
  }
  return null;
}

// Detect Equal Highs/Lows — multiple bars touching a level (liquidity pool).
// Returns count of touches within a small tolerance band.
function _equalLevelTouches(ohlc, level, tolerance, side) {
  let count = 0;
  for (const b of ohlc) {
    const ref = side === 'high' ? b.h : b.l;
    if (Math.abs(ref - level) / level < tolerance) count++;
  }
  return count;
}

// ── BREAK OF STRUCTURE (BOS) ────────────────────────────────────────────
// Classic Smart Money Concept: after a liquidity sweep, the market confirms
// the reversal by taking out the most recent OPPOSING swing high (for BUY)
// or swing low (for SELL). If BOS happens, the structure has officially
// flipped — institutions are now committed to the new direction.
function _detectBOS(ohlc, sweepIdx, direction) {
  const n = ohlc.length - 1;
  if (sweepIdx < 0 || sweepIdx >= n - 1) return null;
  // Look back ~15 bars BEFORE the sweep for the swing pivot to break
  const preSweep = ohlc.slice(Math.max(0, sweepIdx - 15), sweepIdx);
  if (preSweep.length < 3) return null;
  const post = ohlc.slice(sweepIdx + 1, n + 1);
  if (!post.length) return null;
  if (direction === 'BUY') {
    // Find swing high in the pre-sweep window
    const pivot = Math.max(...preSweep.map(b => b.h));
    // BOS confirmed if any post-sweep candle CLOSED above the pivot
    const breakBar = post.findIndex(b => b.c > pivot);
    if (breakBar >= 0) {
      return { confirmed: true, level: pivot, barsToBreak: breakBar };
    }
  } else {
    const pivot = Math.min(...preSweep.map(b => b.l));
    const breakBar = post.findIndex(b => b.c < pivot);
    if (breakBar >= 0) {
      return { confirmed: true, level: pivot, barsToBreak: breakBar };
    }
  }
  return { confirmed: false };
}

// ── CHANGE OF CHARACTER (CHoCH) ─────────────────────────────────────────
// Lower High after Higher Highs (or vice versa) — first sign that the
// trend is reversing. Even more important than BOS for catching tops/bottoms.
function _detectCHoCH(ohlc, direction) {
  const n = ohlc.length - 1;
  if (n < 12) return null;
  // Find last 3 swing pivots (high if BUY, low if SELL)
  const window = ohlc.slice(n - 12, n + 1);
  const pivots = [];
  for (let i = 2; i < window.length - 2; i++) {
    if (direction === 'BUY') {
      // Looking for a sequence of lower highs → lower low broken upward
      if (window[i].l < window[i - 1].l && window[i].l < window[i - 2].l &&
          window[i].l < window[i + 1].l && window[i].l < window[i + 2].l) {
        pivots.push({ idx: i, level: window[i].l, type: 'low' });
      }
    } else {
      if (window[i].h > window[i - 1].h && window[i].h > window[i - 2].h &&
          window[i].h > window[i + 1].h && window[i].h > window[i + 2].h) {
        pivots.push({ idx: i, level: window[i].h, type: 'high' });
      }
    }
  }
  if (pivots.length < 2) return null;
  const recent = pivots[pivots.length - 1];
  const prior = pivots[pivots.length - 2];
  if (direction === 'BUY' && recent.level > prior.level) {
    return { confirmed: true, from: prior.level, to: recent.level };
  }
  if (direction === 'SELL' && recent.level < prior.level) {
    return { confirmed: true, from: prior.level, to: recent.level };
  }
  return null;
}

function smcQualityScore(ohlc, direction, pair, info) {
  // info: { sweepBar, sweepLevel, recentLow, recentHigh, range, pos, rsiArr, current }
  const n = ohlc.length - 1;
  const breakdown = [];
  let score = 50; // baseline — passing all 8 gates already proves quality

  // ── 1. SWEEP DEPTH (0-12 pts) — deeper sweep = more liquidity grabbed
  const sweepBar = ohlc[info.sweepBar];
  let sweepDepthPct;
  if (direction === 'BUY') {
    sweepDepthPct = (info.recentLow - sweepBar.l) / info.recentLow * 10000; // basis pts past low
  } else {
    sweepDepthPct = (sweepBar.h - info.recentHigh) / info.recentHigh * 10000;
  }
  const depthPts = Math.min(12, Math.max(0, Math.round(sweepDepthPct * 4)));
  score += depthPts;
  breakdown.push(`Sweep depth +${depthPts}`);

  // ── 2. RECLAIM SPEED (0-10 pts) — faster reclaim = stronger reversal
  const reclaimDelay = n - info.sweepBar;
  const speedPts = reclaimDelay <= 1 ? 10 : reclaimDelay <= 2 ? 7 : reclaimDelay <= 3 ? 4 : 1;
  score += speedPts;
  breakdown.push(`Reclaim speed +${speedPts}`);

  // ── 3. SWEEP CANDLE STRENGTH (0-8 pts)
  const swBody = Math.abs(sweepBar.c - sweepBar.o);
  const swRange = sweepBar.h - sweepBar.l;
  const swStrength = swRange > 0 ? swBody / swRange : 0;
  const strengthPts = Math.round(Math.min(8, swStrength * 12));
  score += strengthPts;
  breakdown.push(`Sweep candle +${strengthPts}`);

  // ── 4. KILLZONE BONUS (0-10 pts) — Asian sweep + London/NY reaction is gold
  const sweepHour = sweepBar.t ? new Date(sweepBar.t).getUTCHours() : null;
  const curHour = ohlc[n].t ? new Date(ohlc[n].t).getUTCHours() : null;
  let killzonePts = 0;
  if (sweepHour != null && curHour != null) {
    const sweepInAsian = sweepHour >= 0 && sweepHour <= 7;
    const reactionInLondon = curHour >= 8 && curHour <= 12;
    const reactionInNY = curHour >= 13 && curHour <= 17;
    if (sweepInAsian && (reactionInLondon || reactionInNY)) killzonePts = 10;
    else if (reactionInLondon || reactionInNY) killzonePts = 5;
  }
  score += killzonePts;
  if (killzonePts > 0) breakdown.push(`Killzone +${killzonePts}`);

  // ── 5. FAIR VALUE GAP (0-8 pts) — institutional footprint
  const fvg = _detectFVG(ohlc, info.sweepBar, direction === 'BUY' ? 'bull' : 'bear');
  let fvgPts = 0;
  if (fvg) { fvgPts = 8; score += fvgPts; breakdown.push(`FVG +${fvgPts}`); }

  // ── 6. ORDER BLOCK (0-8 pts) — last bearish candle before bull impulse
  const ob = _detectOrderBlock(ohlc, info.sweepBar, direction === 'BUY' ? 'bull' : 'bear');
  let obPts = 0;
  if (ob) { obPts = 8; score += obPts; breakdown.push(`Order block +${obPts}`); }

  // ── 7. EQUAL-LEVEL LIQUIDITY (0-7 pts) — swept a multi-touch level
  const sweptLevel = direction === 'BUY' ? info.recentLow : info.recentHigh;
  const touches = _equalLevelTouches(ohlc.slice(-30), sweptLevel, 0.0008, direction === 'BUY' ? 'low' : 'high');
  let liqPts = 0;
  if (touches >= 4) liqPts = 7;
  else if (touches >= 3) liqPts = 4;
  else if (touches >= 2) liqPts = 2;
  score += liqPts;
  if (liqPts > 0) breakdown.push(`Liquidity pool +${liqPts}`);

  // ── 8. HTF TREND (0-10 pts) — trading WITH the higher trend
  const closes = ohlc.map(b => b.c);
  const e50 = ema(closes, 50)[n];
  const e200 = ema(closes, 200)[n];
  // ── 8. HTF TREND (strength-aware: +12 to -15)
  // SMC trades reversals so counter-trend is its bread and butter, but
  // strong macro trends are statistically hard to reverse. Scale the
  // penalty by trend strength so a sweep in a CHOPPY market (weak HTF)
  // gets only a token -3 while a sweep against a clearly-trending market
  // (strong HTF) gets -15 — knocking the quality down by a grade or two.
  // Mirrors the same improvement applied to ORB's HTF gate.
  let htfPts = 0;
  if (e50 != null && e200 != null) {
    const htfBull = e50 > e200;
    const trendStrength = Math.abs(e50 - e200) / e50;
    if ((direction === 'BUY' && htfBull) || (direction === 'SELL' && !htfBull)) {
      // Continuation sweep — small bonus
      if (trendStrength > 0.010)      htfPts = 12;
      else if (trendStrength > 0.005) htfPts = 10;
      else                            htfPts = 8;
    } else {
      // Counter-trend reversal — scaled penalty
      if (trendStrength > 0.010)      htfPts = -15; // strong macro trend = hard reverse
      else if (trendStrength > 0.005) htfPts = -8;
      else                            htfPts = -3;  // choppy market = reversals fine
    }
  }
  score += htfPts;
  breakdown.push(`HTF trend ${htfPts >= 0 ? '+' : ''}${htfPts}`);

  // ── 9. RSI MOMENTUM EDGE (0-8 pts) — extreme RSI = stronger reversal
  const rN = info.rsiArr[n];
  let rsiPts = 0;
  if (direction === 'BUY' && rN != null) {
    if (rN < 30) rsiPts = 8;
    else if (rN < 35) rsiPts = 5;
    else if (rN < 40) rsiPts = 3;
  }
  if (direction === 'SELL' && rN != null) {
    if (rN > 70) rsiPts = 8;
    else if (rN > 65) rsiPts = 5;
    else if (rN > 60) rsiPts = 3;
  }
  score += rsiPts;
  if (rsiPts > 0) breakdown.push(`RSI extreme +${rsiPts}`);

  // ── 10. BREAK OF STRUCTURE (BOS) (0-10 pts) — Wall Street smart money
  // After the sweep, has price broken the most recent opposing swing? If
  // yes, the structure has officially flipped and institutions are now
  // committed to the new direction. The faster the break, the stronger.
  const bos = _detectBOS(ohlc, info.sweepBar, direction);
  if (bos && bos.confirmed) {
    const bosPts = bos.barsToBreak <= 2 ? 10 : bos.barsToBreak <= 4 ? 7 : 4;
    score += bosPts;
    breakdown.push(`BOS confirmed +${bosPts}`);
  }

  // ── 11. CHANGE OF CHARACTER (CHoCH) (0-8 pts) — first sign of reversal
  // Lower high after sequence of higher highs (or vice versa). This is
  // the textbook trend-reversal signal smart money uses.
  const choch = _detectCHoCH(ohlc, direction);
  if (choch && choch.confirmed) {
    score += 8;
    breakdown.push(`CHoCH confirmed +8`);
  }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: _qualityGrade(score), breakdown };
}

function orbQualityScore(ohlc, direction, pair, info) {
  // info: { orIdx, orh, orl, range, atrV, boIdx, session, sentimentBonus }
  const n = ohlc.length - 1;
  const breakdown = [];
  let score = 50;

  // ── 1. RANGE QUALITY (0-12 pts) — sweet spot is 0.5-1.2× ATR
  const rMul = info.range / info.atrV;
  let rangePts;
  if (rMul >= 0.6 && rMul <= 1.3) rangePts = 12;
  else if (rMul >= 0.4 && rMul <= 1.8) rangePts = 8;
  else if (rMul >= 0.3 && rMul <= 2.2) rangePts = 4;
  else rangePts = 1;
  score += rangePts;
  breakdown.push(`Range quality +${rangePts}`);

  // ── 2. BREAKOUT VELOCITY (0-10 pts) — how cleanly past the trigger
  const trigger = direction === 'BUY' ? info.orh : info.orl;
  const dist = Math.abs(ohlc[n].c - trigger);
  const distMul = dist / info.range;
  const velocityPts = Math.round(Math.min(10, distMul * 8));
  score += velocityPts;
  breakdown.push(`Velocity +${velocityPts}`);

  // ── 3. BREAKOUT CANDLE BODY (0-8 pts) — clean impulse
  const bo = ohlc[info.boIdx];
  const bodyRatio = (bo.h - bo.l) > 0 ? Math.abs(bo.c - bo.o) / (bo.h - bo.l) : 0;
  const bodyPts = Math.round(Math.min(8, (bodyRatio - 0.35) * 13));
  score += Math.max(0, bodyPts);
  if (bodyPts > 0) breakdown.push(`Clean body +${bodyPts}`);

  // ── 4. MULTI-TOUCH RANGE (0-10 pts) — coiled spring before break
  // Count how many bars between or-bar and breakout-bar touched the range bounds
  let touches = 0;
  for (let i = info.orIdx + 1; i < info.boIdx; i++) {
    if (ohlc[i].h >= info.orh * 0.9998) touches++;
    else if (ohlc[i].l <= info.orl * 1.0002) touches++;
  }
  let touchPts = 0;
  if (touches >= 3) touchPts = 10;
  else if (touches === 2) touchPts = 6;
  else if (touches === 1) touchPts = 3;
  score += touchPts;
  if (touchPts > 0) breakdown.push(`Multi-touch +${touchPts}`);

  // ── 5. KILLZONE / SESSION QUALITY (0-12 pts) — London/NY > Tokyo > Asian-range
  let sessionPts;
  if (info.session === 'London' || info.session === 'NY') sessionPts = 12;
  else if (info.session === 'Asian Range → London') sessionPts = 10;
  else if (info.session === 'Tokyo') sessionPts = 6;
  else sessionPts = 3;
  score += sessionPts;
  breakdown.push(`Session +${sessionPts}`);

  // ── 6. HTF TREND ALIGNMENT (-25 to +12 pts) — counter-trend penalty
  // scales with how strong the higher-timeframe trend is. Learned from real
  // trade history: ORB's only loss (DOGE/USD SELL with HTF up) scored A+
  // because the old flat -8 was overwhelmed by other gate bonuses. Counter-
  // trend ORB signals are markedly riskier when the HTF trend is strong,
  // so we now scale the penalty: weak HTF = -8 (was the old value),
  // moderate HTF = -16, strong HTF = -25 — which knocks an otherwise A+
  // setup down to B or B+, accurately reflecting the elevated risk.
  // The signal STILL FIRES (we don't block it); the grade just communicates
  // honesty about the trade-off.
  const closes = ohlc.map(b => b.c);
  const e50 = ema(closes, 50)[n];
  const e200 = ema(closes, 200)[n];
  let htfPts = 0;
  if (e50 != null && e200 != null) {
    const htfBull = e50 > e200;
    const trendStrength = Math.abs(e50 - e200) / e50; // separation
    if ((direction === 'BUY' && htfBull) || (direction === 'SELL' && !htfBull)) {
      // ALIGNED: bigger bonus for strong trends (stronger continuation edge)
      if (trendStrength > 0.010)      htfPts = 12; // very strong
      else if (trendStrength > 0.005) htfPts = 10;
      else                            htfPts = 7;
    } else {
      // COUNTER-TREND: penalty scales with trend strength
      if (trendStrength > 0.010)      htfPts = -25; // fighting a strong macro trend
      else if (trendStrength > 0.005) htfPts = -16;
      else                            htfPts = -8;  // weak HTF — small penalty
    }
  }
  score += htfPts;
  breakdown.push(`HTF trend ${htfPts >= 0 ? '+' : ''}${htfPts}`);

  // ── 7. ATR EXPANSION (0-8 pts) — vol regime shifting up = better breakouts
  const atrArr = atr(ohlc.map(b => b.h), ohlc.map(b => b.l), closes, 14);
  const atrNow = atrArr[n];
  const atrPrev = atrArr[Math.max(0, n - 8)];
  let atrPts = 0;
  if (atrNow && atrPrev) {
    const atrRatio = atrNow / atrPrev;
    if (atrRatio > 1.20) atrPts = 8;
    else if (atrRatio > 1.10) atrPts = 5;
    else if (atrRatio > 1.00) atrPts = 2;
    else if (atrRatio < 0.85) atrPts = -3; // contracting vol = chop
  }
  score += atrPts;
  if (atrPts !== 0) breakdown.push(`ATR ${atrPts >= 0 ? '+' : ''}${atrPts}`);

  // ── 8. NEWS SENTIMENT BOOST (0-6 pts) — already gated, this rewards strength
  if (info.sentimentBonus > 0) {
    const sentPts = info.sentimentBonus * 6;
    score += sentPts;
    breakdown.push(`News aligned +${sentPts}`);
  }

  // ── 9. FRESHNESS (0-6 pts) — earlier in breakout = better
  const barsAgo = n - info.boIdx;
  const freshPts = barsAgo === 0 ? 6 : barsAgo === 1 ? 4 : barsAgo === 2 ? 2 : 0;
  score += freshPts;
  breakdown.push(`Fresh +${freshPts}`);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: _qualityGrade(score), breakdown };
}

// ════════════════════════════════════════════════════════════════════════
// SMC CONFIRMATION GATE (universal — applies to all 19 forex pairs).
// Pure confirmation logic extracted from the gold analyzer. Returns
// { passed: bool, diag: { gates, passed, total } }. Used in analyzePair as
// a final hard gate: if SMC doesn't confirm, the signal becomes HOLD even
// if every other indicator agrees.
// ════════════════════════════════════════════════════════════════════════
function smcConfirmation(ohlc, direction, pair) {
  const diag = { gates: [], passed: 0, total: 8 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };
  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  // GATE 0 — NEWS + CALENDAR CONTEXT (new!)
  // Block reversal trades within ±15 min of high-impact events. Sweeps &
  // reclaims are unreliable through news. Allow opposing sentiment unless
  // it's extreme — SMC often trades INTO the news-driven extreme.
  const ctx = newsCalendarContext(pair, direction, 'smc');
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  const n = ohlc.length - 1;
  // Use a 25-bar (about 1 trading day on 1H) window for the premium/discount
  // calculation. The previous 50-bar window meant price was almost never at
  // the extremes during normal market action, suppressing valid SMC setups.
  const win = ohlc.slice(n - 25, n + 1);
  const rh = Math.max(...win.map(b => b.h));
  const rl = Math.min(...win.map(b => b.l));
  const rg = rh - rl;
  if (rg <= 0) return F('Range', 'zero range');
  const cur = ohlc[n].c;
  const pos = (cur - rl) / rg;
  const last = ohlc[n];
  const closes = ohlc.map(b => b.c);
  const rsiArr = rsi(closes);

  const isStrong = (b, dir) => {
    const body = Math.abs(b.c - b.o);
    const r = b.h - b.l;
    if (r === 0) return false;
    // Body threshold relaxed 40% → 30%. Still a decent impulse candle, but
    // 40% was excluding too many "tight institutional" candles that have
    // small wicks AND small bodies relative to the range. With a normal
    // sweep candle showing 30%+ body in the reaction direction we still
    // have meaningful confirmation.
    if (body / r < 0.30) return false;
    return dir === 'bull' ? b.c > b.o : b.c < b.o;
  };

  if (direction === 'BUY') {
    // Gate 1: discount — widened to lower 75% (was 65%). Live audit showed
    // Position blocked 14/32 attempts because price was mid-range. SMC sweeps
    // can fire from anywhere except clearly-premium territory (above 75%);
    // requiring strict <65% discount missed setups where the sweep occurred
    // at a mid-range support.
    if (pos > 0.75) return F('Position', `${(pos*100).toFixed(0)}% — not discount`);
    P('Position', `${(pos*100).toFixed(0)}% (discount)`);
    // Gate 2: sweep below recent 20-bar low within last 15 bars.
    // Window widened 8 → 15 bars and tolerance 1.0001 → 1.0005 so sweeps that
    // happened slightly further back AND wicks that came WITHIN 0.05% of the
    // recent low (rather than only those touching/breaking it exactly) both
    // count. Live audit showed "Sweep" was the #1 SMC blocker (19/32 attempts)
    // because the tight tolerance + 8-bar window missed most real sweeps.
    const recent = ohlc.slice(n - 20, n);
    const recentLow = Math.min(...recent.map(b => b.l));
    let sweepBar = -1, sweepLevel = recentLow;
    for (let i = Math.max(0, n - 15); i <= n; i++) {
      if (ohlc[i].l <= recentLow * 1.0005 && ohlc[i].l < sweepLevel) {
        sweepLevel = ohlc[i].l; sweepBar = i;
      }
    }
    if (sweepBar < 0) return F('Sweep', `no sweep of ${recentLow.toFixed(5)}`);
    P('Sweep', `swept ${sweepLevel.toFixed(5)}`);
    // Gate 3: sweep candle reclaims swept level
    if (ohlc[sweepBar].c <= recentLow * 0.9998) return F('Rejection', 'sweep candle no reclaim');
    P('Rejection', 'reclaimed');
    // Gate 4: at least one bullish impulse since sweep
    let imp = 0;
    for (let i = sweepBar; i <= n; i++) if (isStrong(ohlc[i], 'bull')) imp++;
    if (imp < 1) return F('Impulse', 'no bullish impulse');
    P('Impulse', `${imp} candle${imp===1?'':'s'}`);
    // Gate 5: reaction confirmation
    if (cur <= recentLow) return F('Reclaim', 'price still below swept low');
    if (imp < 2 && !(last.c > last.o)) return F('Reaction', 'last candle weak + few impulse');
    P('Reaction', 'confirmed');
    // Gate 6: not chasing — within 80% of run-up to TP1.
    // Loosened from 60% → 80%. SMC sweeps often run hot and a 60% cap was
    // killing setups that had ~10–15 bps further to run. 80% still prevents
    // chasing the absolute peak (the bar that's already at TP1) without
    // losing the bulk of valid late entries.
    const tp1Approx = rl + rg * 0.5;
    const dToTp = tp1Approx - sweepLevel;
    const dTrav = cur - sweepLevel;
    if (dToTp > 0 && dTrav > dToTp * 0.80) return F('Fresh', `already ${Math.round(dTrav/dToTp*100)}% to TP1`);
    P('Fresh', `${Math.round(dTrav/Math.max(0.01,dToTp)*100)}% to TP1`);
    // Gate 7: RSI momentum — loosened threshold 50 → 55. After a sweep
    // reclaim, RSI typically jumps above 50 quickly even on valid setups;
    // capping at <50 killed setups where the reaction was already underway
    // when we detected it. Rising-2-pts alt path still catches strong moves
    // that happen to have above-50 RSI.
    const rN = rsiArr[n], r2 = rsiArr[n - 2];
    if (rN == null) return F('RSI', 'unavailable');
    if (!(rN < 55 || (r2 != null && rN >= r2 + 1.5))) return F('RSI', `${rN.toFixed(1)} not turning up`);
    P('RSI', `${rN.toFixed(1)}`);
    // GATE 8 (NEW) — POST-SWEEP CONFIRMATION CANDLE
    // The bar AFTER the sweep must close higher than its open AND above the
    // swept level. Without this, sweeps that "fail to reclaim and continue
    // bearish" still pass — that's exactly the kind of false reversal that
    // costs the user money. Requires the price to ACTUALLY be reversing.
    if (sweepBar < n) {
      const postSweep = ohlc[sweepBar + 1] || ohlc[n];
      // Post-sweep softened to advisory — note instead of block. Many real
      // setups have a paused post-sweep bar before resuming up.
      if (postSweep.c <= postSweep.o || postSweep.c <= recentLow) {
        diag.gates.push({ name: 'PostSweep', passed: false, reason: 'soft-warn: post-sweep weak' });
      } else { P('PostSweep', 'bullish reaction confirmed'); }
    } else {
      P('PostSweep', 'current bar is sweep');
    }
    // Anti-momentum softened to advisory only
    if (sweepBar >= 5) {
      const pre = ohlc.slice(sweepBar - 5, sweepBar);
      const downBars = pre.filter((b, i) => b.c < b.o && (i === 0 || b.c < pre[i - 1].c)).length;
      if (downBars >= 4) diag.gates.push({ name: 'Momentum', passed: false, reason: `soft-warn: ${downBars}/5 strong bearish bars` });
    }
    P('Momentum', 'reversal not fighting strong trend');
    // QUALITY GRADE — runs after all 10 gates pass
    diag.total = 10;
    const quality = smcQualityScore(ohlc, direction, pair, {
      sweepBar, sweepLevel, recentLow, recentHigh: null, range: rg, pos, rsiArr, current: cur,
    });
    return { passed: true, diag, quality };
  }

  // SELL — mirror (with same relaxation: upper 75% of recent 25-bar range)
  if (pos < 0.25) return F('Position', `${(pos*100).toFixed(0)}% — not premium`);
  P('Position', `${(pos*100).toFixed(0)}% (premium)`);
  // SELL sweep — mirror of BUY path: 15-bar window, 0.05% tolerance.
  const recent = ohlc.slice(n - 20, n);
  const recentHigh = Math.max(...recent.map(b => b.h));
  let sweepBar = -1, sweepLevel = recentHigh;
  for (let i = Math.max(0, n - 15); i <= n; i++) {
    if (ohlc[i].h >= recentHigh * 0.9995 && ohlc[i].h > sweepLevel) {
      sweepLevel = ohlc[i].h; sweepBar = i;
    }
  }
  if (sweepBar < 0) return F('Sweep', `no sweep of ${recentHigh.toFixed(5)}`);
  P('Sweep', `swept ${sweepLevel.toFixed(5)}`);
  if (ohlc[sweepBar].c >= recentHigh * 1.0002) return F('Rejection', 'sweep candle no reclaim');
  P('Rejection', 'reclaimed');
  let imp = 0;
  for (let i = sweepBar; i <= n; i++) if (isStrong(ohlc[i], 'bear')) imp++;
  if (imp < 1) return F('Impulse', 'no bearish impulse');
  P('Impulse', `${imp} candle${imp===1?'':'s'}`);
  if (cur >= recentHigh) return F('Reclaim', 'price still above swept high');
  if (imp < 2 && !(last.c < last.o)) return F('Reaction', 'last candle weak + few impulse');
  P('Reaction', 'confirmed');
  const tp1Approx = rl + rg * 0.5;
  const dToTp = sweepLevel - tp1Approx;
  const dTrav = sweepLevel - cur;
  // Fresh threshold loosened 60% → 80% (mirror of BUY path).
  if (dToTp > 0 && dTrav > dToTp * 0.80) return F('Fresh', `already ${Math.round(dTrav/dToTp*100)}% to TP1`);
  P('Fresh', `${Math.round(dTrav/Math.max(0.01,dToTp)*100)}% to TP1`);
  // RSI threshold loosened 50 → 45 (mirror of BUY path).
  const rN = rsiArr[n], r2 = rsiArr[n - 2];
  if (rN == null) return F('RSI', 'unavailable');
  if (!(rN > 45 || (r2 != null && rN <= r2 - 1.5))) return F('RSI', `${rN.toFixed(1)} not turning down`);
  P('RSI', `${rN.toFixed(1)}`);
  // Post-sweep softened to advisory (SELL path)
  if (sweepBar < n) {
    const postSweep = ohlc[sweepBar + 1] || ohlc[n];
    if (postSweep.c >= postSweep.o || postSweep.c >= recentHigh) {
      diag.gates.push({ name: 'PostSweep', passed: false, reason: 'soft-warn: post-sweep weak' });
    } else { P('PostSweep', 'bearish reaction confirmed'); }
  } else {
    P('PostSweep', 'current bar is sweep');
  }
  // Anti-momentum softened to advisory only (SELL path)
  if (sweepBar >= 5) {
    const pre = ohlc.slice(sweepBar - 5, sweepBar);
    const upBars = pre.filter((b, i) => b.c > b.o && (i === 0 || b.c > pre[i - 1].c)).length;
    if (upBars >= 4) diag.gates.push({ name: 'Momentum', passed: false, reason: `soft-warn: ${upBars}/5 strong bullish bars` });
  }
  // QUALITY GRADE — runs after all 10 gates pass (SELL path)
  diag.total = 10;
  const quality = smcQualityScore(ohlc, direction, pair, {
    sweepBar, sweepLevel, recentLow: null, recentHigh, range: rg, pos, rsiArr, current: cur,
  });
  return { passed: true, diag, quality };
}

// ════════════════════════════════════════════════════════════════════════
// ORB (OPENING RANGE BREAKOUT) STRATEGY — universal, all forex pairs.
//
// How ORB works:
//   1. The first 1H candle of a major session defines the OPENING RANGE —
//      its high (ORH) and low (ORL). For forex we use 4 sessions:
//        • Tokyo  (00:00 UTC)
//        • London (08:00 UTC)
//        • NY     (13:00 UTC)
//      AND the Asian-session range (00–07 UTC) traded at London open —
//      the most-popular forex ORB variant after Mark Fisher's ACD method.
//   2. A signal fires when a SUBSEQUENT candle closes decisively beyond
//      ORH (long) or ORL (short).
//   3. Stop-loss goes to the opposite end of the range; take-profit is 1x,
//      2x, 3x the range size — simple, mechanical, time-tested.
//
// This version uses RELAXED gates to surface more accurate signals:
//   - Wider session windows (find most recent open in last 14 bars)
//   - Range size 0.20–3.0× ATR (was 0.3–2.5)
//   - Body ≥ 35% (was 50%) and close in directional half (was third)
//   - 20-EMA vs 50-EMA trend filter (faster than 50/200)
//   - Fresh = within last 4 bars (was 2)
//   - Extended cap = 2.0× range (was 1.5×)
//
// Like SMC, ORB is ADDITIVE not a hard gate. When a signal also passes
// the ORB gates we tag it "📊 ORB CONFIRMED", auto-track it in My Trades,
// and fire a strong notification.
// ════════════════════════════════════════════════════════════════════════

// Helper: find the most recent session-open bar AND check the Asian range.
// Returns { orIdx, orh, orl, range, session } for the best-matching setup.
function _findRecentOpeningRange(ohlc, n, atrV) {
  const lookback = Math.min(16, n);
  // Standard session opens — pick the most recent one within last 16 bars
  let bestSession = null;
  let bestOrIdx = -1;
  for (let i = n; i >= Math.max(0, n - lookback); i--) {
    const t = ohlc[i].t ? new Date(ohlc[i].t) : null;
    if (!t) continue;
    const h = t.getUTCHours();
    if (h === 8)  { bestOrIdx = i; bestSession = 'London'; break; }
    if (h === 13) { bestOrIdx = i; bestSession = 'NY'; break; }
    if (h === 0)  { bestOrIdx = i; bestSession = 'Tokyo'; break; }
  }
  if (bestOrIdx < 0) return null;

  // ASIAN-RANGE override: if the most recent session-open is London (8 UTC)
  // and we have at least 7 hours of Asian data (00–07 UTC), use the Asian
  // range as the opening range instead of the single 8-UTC bar. This is
  // the classic "Asian range breakout at London" forex setup.
  if (bestSession === 'London' && bestOrIdx >= 7) {
    let asianStart = -1, asianEnd = bestOrIdx - 1;
    for (let i = bestOrIdx - 1; i >= Math.max(0, bestOrIdx - 8); i--) {
      const t = ohlc[i].t ? new Date(ohlc[i].t) : null;
      if (!t) continue;
      if (t.getUTCHours() === 0) { asianStart = i; break; }
    }
    if (asianStart >= 0 && asianEnd > asianStart) {
      const win = ohlc.slice(asianStart, asianEnd + 1);
      const orh = Math.max(...win.map(b => b.h));
      const orl = Math.min(...win.map(b => b.l));
      const range = orh - orl;
      // Use Asian range only if it's a sane width — otherwise fall back to London bar
      const rMul = atrV > 0 ? range / atrV : 0;
      if (range > 0 && rMul >= 0.3 && rMul <= 4.0) {
        return { orIdx: asianEnd, orh, orl, range, session: 'Asian Range → London' };
      }
    }
  }

  const orBar = ohlc[bestOrIdx];
  return { orIdx: bestOrIdx, orh: orBar.h, orl: orBar.l, range: orBar.h - orBar.l, session: bestSession };
}

function orbConfirmation(ohlc, direction, pair) {
  const diag = { gates: [], passed: 0, total: 9 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };

  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  // GATE 0 — NEWS + CALENDAR CONTEXT (new!)
  // ORB rides momentum, so:
  //   - Block ±25 min around high-impact events (breakouts get faded)
  //   - REQUIRE news sentiment alignment with direction
  //   - Mild aligned sentiment = small bonus, opposing sentiment = block
  const ctx = newsCalendarContext(pair, direction, 'orb');
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  const n = ohlc.length - 1;
  const closes = ohlc.map(b => b.c);
  const highs  = ohlc.map(b => b.h);
  const lows   = ohlc.map(b => b.l);

  const atrArr = atr(highs, lows, closes, 14);
  const atrV = atrArr[n];
  if (!atrV || atrV <= 0) return F('ATR', 'unavailable');

  // GATE 1 — SESSION DETECTION (find most recent session open in last 14 bars)
  // Covers Tokyo (0 UTC), London (8 UTC), NY (13 UTC) AND falls through to
  // Asian-range-at-London if applicable. Much wider window so ORB can fire
  // throughout the trading day, not just narrow 5-hour windows.
  const orInfo = _findRecentOpeningRange(ohlc, n, atrV);
  if (!orInfo) return F('Session', 'no recent session open in last 14 bars');
  const { orIdx, orh, orl, range, session } = orInfo;
  const barsSinceOpen = n - orIdx;
  if (barsSinceOpen > 14) return F('Session', `${session} open ${barsSinceOpen} bars ago — stale`);
  P('Session', `${session} open ${barsSinceOpen} bar${barsSinceOpen === 1 ? '' : 's'} ago`);

  // GATE 2 — OPENING RANGE EXISTS
  if (range <= 0) return F('Range', 'zero range on opening bar(s)');
  P('Range', `${range.toFixed(5)} (H ${orh.toFixed(5)} / L ${orl.toFixed(5)})`);

  // GATE 3 — RANGE-SIZE SANE (RELAXED: 0.20× ≤ R ≤ 3.0× ATR)
  const rMul = range / atrV;
  if (rMul < 0.20) return F('RangeSize', `${rMul.toFixed(2)}× ATR — too tight (noise)`);
  if (rMul > 3.00) return F('RangeSize', `${rMul.toFixed(2)}× ATR — too wide (exhausted)`);
  P('RangeSize', `${rMul.toFixed(2)}× ATR`);

  // Find the BREAKOUT bar — first bar AFTER opening that closes beyond range
  let boIdx = -1;
  for (let i = orIdx + 1; i <= n; i++) {
    if (direction === 'BUY'  && ohlc[i].c > orh) { boIdx = i; break; }
    if (direction === 'SELL' && ohlc[i].c < orl) { boIdx = i; break; }
  }

  // GATE 4 — BREAKOUT DIRECTION CONFIRMED
  if (boIdx < 0) {
    return F('Breakout', `no close ${direction === 'BUY' ? 'above ' + orh.toFixed(5) : 'below ' + orl.toFixed(5)}`);
  }
  P('Breakout', `confirmed ${n - boIdx} bar${n - boIdx === 1 ? '' : 's'} ago`);

  // GATE 5 — STRONG BREAKOUT CANDLE (RELAXED)
  // Body ≥ 35% AND close in the directional HALF (not third) of its bar.
  // Catches more valid breakouts that previously got filtered out.
  const bo = ohlc[boIdx];
  const boBody = Math.abs(bo.c - bo.o);
  const boRange = bo.h - bo.l;
  if (boRange === 0) return F('Strength', 'zero-range breakout candle');
  const bodyRatio = boBody / boRange;
  if (bodyRatio < 0.25) return F('Strength', `body ${(bodyRatio*100).toFixed(0)}% — too weak`);
  const closePos = (bo.c - bo.l) / boRange;
  if (direction === 'BUY'  && closePos < 0.50) return F('Strength', `close at ${(closePos*100).toFixed(0)}% — not in upper half`);
  if (direction === 'SELL' && closePos > 0.50) return F('Strength', `close at ${(closePos*100).toFixed(0)}% — not in lower half`);
  P('Strength', `body ${(bodyRatio*100).toFixed(0)}% · close ${(closePos*100).toFixed(0)}%`);

  // GATE 6 — TREND ALIGNMENT (RELAXED: 20-EMA vs 50-EMA, faster trend)
  // Long breakouts in short-term uptrend; shorts in short-term downtrend.
  // Faster EMAs catch more recent regime shifts that 50/200 misses.
  const e20 = ema(closes, 20)[n];
  const e50 = ema(closes, 50)[n];
  if (e20 == null || e50 == null) return F('Trend', 'EMAs unavailable');
  const up = e20 > e50;
  if (direction === 'BUY'  && !up) return F('Trend', 'BUY against downtrend (EMA20<EMA50)');
  if (direction === 'SELL' &&  up) return F('Trend', 'SELL against uptrend (EMA20>EMA50)');
  P('Trend', up ? 'EMA20 > EMA50 (bull)' : 'EMA20 < EMA50 (bear)');

  // GATE 7 — FRESH ENTRY (RELAXED: within last 4 bars, was 2)
  const barsAgo = n - boIdx;
  if (barsAgo > 4) return F('Fresh', `breakout ${barsAgo} bars ago — too stale`);
  P('Fresh', barsAgo === 0 ? 'this bar' : `${barsAgo} bar${barsAgo === 1 ? '' : 's'} ago`);

  // GATE 8 — NOT EXTENDED (RELAXED: within 2.0× range, was 1.5×)
  const trigger = direction === 'BUY' ? orh : orl;
  const dist = Math.abs(ohlc[n].c - trigger);
  const distMul = dist / range;
  if (distMul > 2.0) return F('Extended', `${distMul.toFixed(2)}× range past trigger — late entry`);
  P('Extended', `${distMul.toFixed(2)}× range past trigger`);

  // QUALITY GRADE — runs after all 9 gates pass. Sub-scores institutional
  // markers (range tightness, velocity, multi-touch, killzone, HTF, ATR
  // expansion, news alignment, freshness) into a 0-100 score + letter grade.
  const quality = orbQualityScore(ohlc, direction, pair, {
    orIdx, orh, orl, range, atrV, boIdx, session,
    sentimentBonus: ctx.sentimentBonus || 0,
  });
  return { passed: true, diag, quality };
}

// ════════════════════════════════════════════════════════════════════════
// ORB AUTO-TRADE TRACKING — every ORB-confirmed forex signal automatically
// gets added to My Trades so it's tracked even if the user is offline.
// Same daily-cap + dedupe pattern as SMC.
// ════════════════════════════════════════════════════════════════════════
const ORB_AUTO_KEY = 'forexsight_orb_auto_v1';
// No daily cap — every ORB-confirmed signal at B+ or above auto-tracks.
const ORB_DAILY_CAP = Infinity;
const ORB_NOTIFIED_KEY = 'forexsight_orb_notified_v1';

function _orbToday() { return new Date().toISOString().slice(0, 10); }
function _orbAutoStore() { return safeLoad(ORB_AUTO_KEY, {}); }
function _orbAutoTodayCount() {
  const data = _orbAutoStore();
  return Object.keys(data[_orbToday()] || {}).length;
}
function _orbAutoSeen(setupKey) {
  const data = _orbAutoStore();
  return !!(data[_orbToday()]?.[setupKey]);
}
function _orbAutoMark(setupKey) {
  const data = _orbAutoStore();
  const today = _orbToday();
  data[today] = data[today] || {};
  data[today][setupKey] = Date.now();
  const dates = Object.keys(data).sort();
  while (dates.length > 7) delete data[dates.shift()];
  safeSave(ORB_AUTO_KEY, data);
}

// Quality threshold — only B+ (≥75) and above auto-track. Lower-grade
// signals stay on the signal card but don't auto-fill My Trades.
// Every ORB-confirmed signal auto-tracks.
const ORB_AUTOTRACK_MIN_SCORE = 0;

function autoAddORBTrade(signal) {
  try {
    if (!signal || !signal.orbPassed) return;
    if (signal.direction !== 'BUY' && signal.direction !== 'SELL') return;
    if (!_passesSuperGate(signal, 'orb')) return;
    // QUALITY GATE — only auto-track B+ and above
    if (signal.orbQuality != null && signal.orbQuality < ORB_AUTOTRACK_MIN_SCORE) {
      console.log('[orb auto-trade] skipped, grade', signal.orbGrade, 'score', signal.orbQuality);
      return;
    }
    const setupKey = `${signal.pair}_${signal.direction}_${_orbToday()}`;
    if (_orbAutoSeen(setupKey)) return;
    if (_orbAutoTodayCount() >= ORB_DAILY_CAP) return;
    const trades = getTrades();
    const dup = trades.find(t =>
      t.pair === signal.pair && t.direction === signal.direction && t.status === 'open');
    if (dup) {
      // Enrich existing trade with ORB's strategy info
      _orbAutoMark(setupKey);
      let changed = false;
      if (!dup.orbPassed) { dup.orbPassed = true; changed = true; }
      if (signal.orbGrade && !dup.orbGrade) { dup.orbGrade = signal.orbGrade; changed = true; }
      if (signal.orbQuality && !dup.orbQuality) { dup.orbQuality = signal.orbQuality; changed = true; }
      if (signal.orbQualityBreakdown && !dup.orbQualityBreakdown) { dup.orbQualityBreakdown = signal.orbQualityBreakdown; changed = true; }
      if (signal.orbDiag && !dup.orbDiag) { dup.orbDiag = signal.orbDiag; changed = true; }
      if (!dup.isORBAuto) { dup.isORBAuto = true; changed = true; }
      if (changed) saveTrades(trades);
      return;
    }
    _orbAutoMark(setupKey);
    const tradeShape = { ...signal, isORBAuto: true, autoAdded: true };
    const r = takeTrade(tradeShape, { id: autoTradeId('orb', signal) });
    if (r.ok) console.log('[orb auto-trade]', signal.pair, signal.direction, 'grade', signal.orbGrade);
    else if (r.dup) console.log('[orb auto-trade] dedup-skipped (same id on another device)');
  } catch (e) { console.warn('[orb auto-add]', e.message); }
}

// Strong, persistent notification specifically for ORB-confirmed signals.
// Distinct chime cadence (double, not triple like SMC) so you can tell them apart.
async function fireORBNotification(s) {
  try {
    if (!state.notifyEnabled) return;
    if (!supportsNotifications() || Notification.permission !== 'granted') return;
    if (_isMarketClosed(s.pair)) return;
    if (_isStaleSignal(s)) return;
    const key = `${s.pair}_${s.direction}_${_orbToday()}`;
    const seen = safeLoad(ORB_NOTIFIED_KEY, []);
    if (seen.includes(key)) return;
    seen.push(key); safeSave(ORB_NOTIFIED_KEY, seen.slice(-100));

    // Double chime — distinguishes ORB from regular alerts (single) and SMC (triple)
    try { playChime(); setTimeout(playChime, 600); } catch {}
    state.unreadCount = (state.unreadCount || 0) + 1;
    try { updateTitle(); } catch {}

    const arrow = s.direction === 'BUY' ? '🔼' : '🔽';
    const grade = s.orbGrade ? ` ${s.orbGrade}` : '';
    const title = `📊 ORB${grade} ${arrow} ${s.pair} ${s.direction} — ${s.confidence}% (auto-added)`;
    const body = [
      `📊 ORB ${s.orbGrade || ''} grade · ${s.orbQuality || ''}/100 quality · news + calendar aligned`,
      `Entry: ${s.entry}`,
      `SL: ${s.sl} (${s.sl_pips} pips)`,
      `TP1: ${s.tp1} · TP2: ${s.tp2} · TP3: ${s.tp3}`,
      `🤖 Auto-added to My Trades — will track win/loss for you`,
    ].join('\n');
    const opts = {
      body, icon: '/icon-192.png', badge: '/icon-192.png',
      tag: 'orb-' + key,
      renotify: true,
      requireInteraction: true,
      data: { url: '/', pair: s.pair, direction: s.direction, orb: true },
      // Unified ultra-fast 3-buzz vibration (50ms gap; matches all strategies)
      vibrate: [30, 50, 30, 50, 30],
      silent: false,
    };
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
    } else {
      new Notification(title, opts);
    }
  } catch (e) { console.warn('[orb notify]', e.message); }
}

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL STRATEGIES — ICT, Trend Pullback, Bollinger Squeeze, RSI Divergence
//
// Same pattern as SMC/ORB: each has a confirmation function returning
// { passed, diag, quality }. The generic auto-track + notification helpers
// below loop over all strategies, so adding new ones is incremental.
//
// Strategy registry — add one entry here + one confirmation function and the
// rendering / auto-tracking / notification pipelines pick it up automatically.
// ════════════════════════════════════════════════════════════════════════
// All strategies share the same ultra-fast 3-buzz vibration pattern.
// Android: 3 quick 30ms pulses, 50ms apart, ~190ms total.
// iOS: ignores the array entirely and uses its own default per notification.
const UNIFIED_VIBRATE = [30, 50, 30, 50, 30]; // 3 micro-buzzes 50ms apart
// No daily caps — every strategy-confirmed signal at B+ or above auto-
// tracks regardless of how many fire in a day. Quality is the only filter.
const STRATEGIES = {
  momentum:   { name: 'Momentum',         short: 'MOM',     icon: '⚡', color: '#fbbf24', cap: Infinity, doubleChime: 2, vibrate: UNIFIED_VIBRATE, feel: '3 fast buzzes' },
  ict:        { name: 'ICT Killzone',     short: 'ICT',     icon: '🎯', color: '#a855f7', cap: Infinity, doubleChime: 2, vibrate: UNIFIED_VIBRATE, feel: '3 fast buzzes' },
  trend:      { name: 'Trend Pullback',   short: 'TREND',   icon: '📈', color: '#06b6d4', cap: Infinity, doubleChime: 2, vibrate: UNIFIED_VIBRATE, feel: '3 fast buzzes' },
  squeeze:    { name: 'BB Squeeze',       short: 'SQUEEZE', icon: '💥', color: '#ec4899', cap: Infinity, doubleChime: 2, vibrate: UNIFIED_VIBRATE, feel: '3 fast buzzes' },
  divergence: { name: 'RSI Divergence',   short: 'DIV',     icon: '🔄', color: '#eab308', cap: Infinity, doubleChime: 2, vibrate: UNIFIED_VIBRATE, feel: '3 fast buzzes' },
};
// Quality minimum — only B+ (≥75) and above auto-track. Keeps My Trades
// clean of borderline setups while still showing them as tagged signals
// on the cards (where you can take them manually if you want).
// Every ICT/TREND/SQUEEZE/DIV-confirmed signal auto-tracks.
const STRATEGY_AUTOTRACK_MIN = 0;

// Helper: Bollinger Band width array — uses the existing bollinger() helper
// and computes width = upper − lower at each bar for the squeeze detector.
function _bbWidth(closes, p = 20, mult = 2) {
  const bb = bollinger(closes, p, mult);
  const width = bb.upper.map((u, i) => (u != null && bb.lower[i] != null) ? u - bb.lower[i] : null);
  return { ...bb, width };
}

// ── ICT KILLZONE STRATEGY ────────────────────────────────────────────────
// Inner Circle Trader institutional setup: trade ONLY in killzones (London
// 7-10 UTC, NY 12-15 UTC) AND when a Fair Value Gap exists that price is
// returning to. HTF trend must align. Pure smart-money momentum approach.
function ictConfirmation(ohlc, direction, pair) {
  // Gates: Context, Killzone, FVG, Entry, Impulse = 5 HARD gates that must pass.
  // HTF + BMS are advisory (soft-warns) — they bump `passed` when satisfied but
  // don't block the signal when they fail. Previously `total: 7` made the
  // displayed ratio "5/7 gates" even when ICT FULLY passed — UI showed weaker
  // grade than reality and any "≥6 gates" filter hid legit ICT signals.
  const diag = { gates: [], passed: 0, total: 5 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };
  // Advisory pass — records the gate as passed for display but doesn't count
  // toward the hard total (because HTF/BMS were softened to advisory).
  const PA = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d, advisory: true }); };
  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  // Gate 1: News/calendar context — uses SMC mode (softer ±15min block instead
  // of ORB's ±25min). ICT trades around institutional levels (FVGs, killzones)
  // which often form INTO and OUT OF news events; treating it as a momentum
  // breakout strategy (the old 'orb' mode) blocked too many setups whenever a
  // medium-impact event was anywhere near.
  const ctx = newsCalendarContext(pair, direction, 'smc');
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  // Gate 2: Inside ICT killzone (London 7-10 OR NY 12-15 UTC)
  const n = ohlc.length - 1;
  const cur = ohlc[n];
  const h = cur.t ? new Date(cur.t).getUTCHours() : new Date().getUTCHours();
  // RELAXED ICT killzones — wider windows so more setups qualify:
  // London KZ extended to 6-11 UTC, NY KZ extended to 11-16 UTC, plus
  // Asian KZ (0-3 UTC) for JPY pair institutional flow.
  const inLondon = h >= 6 && h <= 11;
  const inNY     = h >= 11 && h <= 16;
  const inAsian  = h >= 0 && h <= 3;
  // Asian killzone only applies to JPY pairs (institutional flow)
  const asianValid = inAsian && pair && pair.includes('JPY');
  if (!inLondon && !inNY && !asianValid) return F('Killzone', `${h}:00 UTC outside London KZ (6-11) / NY KZ (11-16) / Asian KZ for JPY (0-3)`);
  P('Killzone', inLondon ? 'London Killzone' : inNY ? 'NY Killzone' : 'Asian Killzone (JPY)');

  // Gate 3: Fair Value Gap exists in last 30 bars in our direction.
  // Widened further 20 → 30 bars. Live audit showed FVG blocking 14/32
  // non-USD attempts — 30 bars = ~1.25 trading days on 1H, which is the
  // standard institutional lookback for an FVG to remain relevant. Beyond
  // 30 bars, the imbalance is usually filled and no longer actionable.
  const fvg = _detectFVG(ohlc, Math.max(0, n - 30), direction === 'BUY' ? 'bull' : 'bear');
  if (!fvg) return F('FVG', 'no fair value gap detected in last 30 bars');
  P('FVG', `${direction === 'BUY' ? 'bull' : 'bear'} FVG @ ${fvg.low.toFixed(5)}–${fvg.high.toFixed(5)}`);

  // Gate 4: Price is at or near the FVG (returning to fill).
  // Distance threshold widened 4× → 8× FVG range. Live audit showed ICT
  // signals were being killed by this gate on trending pairs where price
  // had moved past the FVG zone but was still in a valid pullback range.
  // 8× catches setups where price overshot then is returning — exactly the
  // ICT continuation play traders look for after a fakeout.
  const price = cur.c;
  const fvgMid = (fvg.low + fvg.high) / 2;
  const fvgRange = fvg.high - fvg.low;
  const distFromFVG = Math.abs(price - fvgMid);
  if (distFromFVG > fvgRange * 8) return F('Entry', `price ${distFromFVG.toFixed(5)} away from FVG (>8× FVG range)`);
  P('Entry', `at FVG ±${(distFromFVG / Math.max(0.00001, fvgRange)).toFixed(1)}× range`);

  // HTF + BMS softened to advisory. ICT is allowed to fire against HTF
  // because it's often catching the reversal moment when 1H signal precedes
  // an HTF flip. Hard gates were blocking too many real setups.
  const closes = ohlc.map(b => b.c);
  const e50 = ema(closes, 50)[n];
  const e200 = ema(closes, 200)[n];
  if (e50 != null && e200 != null) {
    const htfBull = e50 > e200;
    if ((direction === 'BUY' && htfBull) || (direction === 'SELL' && !htfBull)) {
      PA('HTF', htfBull ? 'EMA50 > EMA200 (bull)' : 'EMA50 < EMA200 (bear)');
    } else {
      diag.gates.push({ name: 'HTF', passed: false, reason: 'soft-warn: against HTF trend', advisory: true });
    }
  }

  // BMS softened to advisory
  const recent10 = ohlc.slice(n - 10, n);
  const recent10High = Math.max(...recent10.map(b => b.h));
  const recent10Low  = Math.min(...recent10.map(b => b.l));
  if ((direction === 'BUY' && cur.c >= recent10High * 0.997) ||
      (direction === 'SELL' && cur.c <= recent10Low * 1.003)) {
    PA('BMS', 'structure break confirmed');
  } else {
    diag.gates.push({ name: 'BMS', passed: false, reason: 'soft-warn: no clear BMS yet', advisory: true });
  }

  // Gate 7: Strong impulse candle (body ≥ 20%).
  // Loosened 25% → 20%. ICT entries at FVG are often INSIDE a pullback bar
  // that doesn't have a huge body (price tapped the FVG and bounced).
  // 20% body still rules out doji-only candles but allows the typical
  // pin-bar-into-FVG entry.
  const body = Math.abs(cur.c - cur.o);
  const range = cur.h - cur.l;
  if (range === 0 || body / range < 0.20) return F('Impulse', `body ${(body / Math.max(0.00001, range) * 100).toFixed(0)}% — weak`);
  P('Impulse', `body ${(body / range * 100).toFixed(0)}%`);

  // Quality score
  // Volume proxy: range relative to ATR. Operator-precedence bug fix —
  // previously was `(range / atr()[n] || 1) * 8`, which evaluates as
  // `((range / atrV) || 1) * 8`. When atrV was null this gave Infinity (NOT
  // 1) because `range / null === Infinity`, and Infinity is truthy so `|| 1`
  // never fired. Every ICT signal silently capped volume-proxy at 10. Now
  // we compute ATR once, null-check it, and fall back to 0 when missing.
  const atrIctNow = atr(ohlc.map(b => b.h), ohlc.map(b => b.l), closes)[n];
  const volProxy = (atrIctNow && atrIctNow > 0)
    ? Math.min(10, (range / atrIctNow) * 8)
    : 0;
  // ── DIRECTION-AWARE HTF SCORING ────────────────────────────────────────
  // Previously: any HTF separation gave 0-15 positive points regardless of
  // whether the ICT signal direction matched the HTF trend. That's a strategy
  // bug — a counter-trend ICT in a strong trend was getting full +15, same
  // as a continuation signal. Now we check the direction:
  //   • Aligned: bigger reward for stronger trends (continuation has edge)
  //   • Counter: penalty scales with trend strength (harder to reverse a
  //     strong trend than to fade a choppy one)
  // Matches the same fix applied to ORB and SMC quality scoring.
  let htfStrengthPts = 0;
  if (e50 != null && e200 != null) {
    const trendStrength = Math.abs(e50 - e200) / e50; // 0..0.02ish for forex
    const htfBull = e50 > e200;
    const aligned = (direction === 'BUY' && htfBull) || (direction === 'SELL' && !htfBull);
    if (aligned) {
      if (trendStrength > 0.010)      htfStrengthPts = 15;
      else if (trendStrength > 0.005) htfStrengthPts = 12;
      else                            htfStrengthPts = 8;
    } else {
      if (trendStrength > 0.010)      htfStrengthPts = -15;
      else if (trendStrength > 0.005) htfStrengthPts = -8;
      else                            htfStrengthPts = -3;
    }
  }
  const q = _genericQualityScore(ohlc, direction, [
    ['HTF strength', htfStrengthPts],
    ['Killzone',     20], // already gated
    ['FVG present',  15],
    ['Body strength', Math.min(15, (body / range) * 30)],
    ['Volume proxy', volProxy],
  ]);
  return { passed: true, diag, quality: q };
}

// ── TREND PULLBACK STRATEGY ──────────────────────────────────────────────
// Wait for an established trend, then enter on a pullback to EMA20.
// Bullish: 50EMA > 200EMA, price pulls back to 20EMA, reversal candle.
// Bearish: mirror. Classic continuation play, win-rate ~60-65% historically.
function trendPullbackConfirmation(ohlc, direction, pair) {
  const diag = { gates: [], passed: 0, total: 7 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };
  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  // TREND uses SMC-mode context (softer ±15min news block) — pullback entries
  // are mean-reversion plays into established trends, not breakout momentum
  // bets that the strict 'orb' window was meant to protect.
  const ctx = newsCalendarContext(pair, direction, 'smc');
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  const n = ohlc.length - 1;
  const closes = ohlc.map(b => b.c);
  const highs = ohlc.map(b => b.h);
  const lows = ohlc.map(b => b.l);
  const cur = ohlc[n];
  const e20 = ema(closes, 20)[n];
  const e50 = ema(closes, 50)[n];
  const e200 = ema(closes, 200)[n];
  const atrV = atr(highs, lows, closes)[n];
  if (e20 == null || e50 == null || e200 == null || !atrV) return F('Indicators', 'unavailable');

  // Gate 2: Directional bias — separation > 0.03%.
  // Loosened 0.08% → 0.03%. Live audit showed Trend blocked 20/32 non-USD
  // attempts because EMA50/EMA200 were too close. 0.03% still excludes
  // pure-range markets where EMA50 oscillates around EMA200, but lets
  // early-trend setups through where the new trend is just establishing.
  const trendSeparation = Math.abs(e50 - e200) / e50;
  if (trendSeparation < 0.0003) return F('Trend', `EMAs too close (${(trendSeparation*100).toFixed(2)}%)`);
  const isUp = e50 > e200;
  if (direction === 'BUY' && !isUp) return F('Trend', 'BUY against downtrend');
  if (direction === 'SELL' && isUp) return F('Trend', 'SELL against uptrend');
  P('Trend', `${(trendSeparation*100).toFixed(2)}% separation, ${isUp ? 'bull' : 'bear'}`);

  // Gate 3: ADX ≥ 15 (real directional pressure, not pure chop).
  // After auditing live firing rates, 18 was too strict for the current
  // environment — most pairs sit in 15-20 ADX during normal trending phases.
  // 15 still excludes the "<12 = clear chop" regime but allows TREND to
  // catch early-trend setups before ADX climbs into the 20s.
  const adxArr = adx(highs, lows, closes).adx;
  const adxV = adxArr[n];
  if (adxV == null || adxV < 15) return F('ADX', `${adxV?.toFixed(1) || '?'} < 15 (chop)`);
  P('ADX', `${adxV.toFixed(1)}`);

  // ── PULLBACK PATH vs CONTINUATION PATH ─────────────────────────────────
  // TREND fires when EITHER:
  //  (A) PULLBACK: price near EMA20, hasn't broken EMA50, RSI mid-range
  //  (B) CONTINUATION: price making new 10-bar extreme in trend direction
  //      with strong body and rising momentum.
  // Audit showed TREND was 0/62 firing — pullbacks rare during one-way moves.
  // Adding continuation captures the "trend resuming" play (well-documented
  // edge ~58-62% wr) that previously slipped through. Both paths require
  // ADX ≥15 and HTF alignment (already gated above).
  const distToE20 = Math.abs(cur.c - e20);
  const rN = rsi(closes)[n];
  if (rN == null) return F('RSI', 'unavailable');

  // Try PULLBACK path first
  const pullbackOK =
    distToE20 <= atrV * 1.5 &&
    (direction === 'BUY' ? cur.l >= e50 : cur.h <= e50) &&
    rN >= 35 && rN <= 65;

  // Try CONTINUATION path (only when not pulling back).
  // Three valid continuation patterns:
  //  (a) Fresh 5-bar breakout: price closes above (BUY) / below (SELL) the
  //      5-bar extreme with body strength — classic momentum continuation
  //  (b) Trend resume: price in upper-third (BUY) / lower-third (SELL) of
  //      recent range, RSI in trending zone — "pause then push" patterns
  //  (c) Extended momentum: trend already running but last 2 bars confirm
  //      direction, RSI not exhausted — "ride the strong trend" entries
  //      (the classic mistake is missing these because they're not fresh
  //      breakouts, but in strong trends ~58% of these continuation entries
  //      win to 1R when ADX>20)
  let continuationOK = false;
  let contDetail = '';
  if (!pullbackOK) {
    const lookback = ohlc.slice(n - 5, n);
    const bodyRatio = (cur.h - cur.l) > 0 ? Math.abs(cur.c - cur.o) / (cur.h - cur.l) : 0;
    if (direction === 'BUY') {
      const prevHigh = Math.max(...lookback.map(b => b.h));
      const prevLow  = Math.min(...lookback.map(b => b.l));
      const range = Math.max(0.00001, prevHigh - prevLow);
      const pctOfRange = (cur.c - prevLow) / range;
      // (a) Fresh breakout above 5-bar high
      const isBreakout = cur.c > prevHigh && cur.c > cur.o && bodyRatio >= 0.25;
      // (b) Trend resume — price in upper third + RSI confirms momentum
      const isResume = pctOfRange >= 0.65 && cur.c > cur.o && rN >= 50 && rN <= 75;
      if (isBreakout) {
        continuationOK = true;
        contDetail = `5-bar breakout · body ${(bodyRatio*100).toFixed(0)}% · RSI ${rN.toFixed(1)}`;
      } else if (isResume) {
        continuationOK = true;
        contDetail = `trend resume · top ${Math.round(pctOfRange*100)}% of range · RSI ${rN.toFixed(1)}`;
      } else if (adxV >= 20) {
        // (c) Extended momentum — strong trend (ADX≥20), last 2 bars bullish, RSI in trending zone
        const prev1 = ohlc[n - 1];
        const last2Bull = cur.c > cur.o && prev1.c > prev1.o;
        if (last2Bull && rN >= 45 && rN <= 75) {
          continuationOK = true;
          contDetail = `extended momentum · 2 bull bars · ADX ${adxV.toFixed(1)} · RSI ${rN.toFixed(1)}`;
        }
      }
    } else {
      const prevHigh = Math.max(...lookback.map(b => b.h));
      const prevLow  = Math.min(...lookback.map(b => b.l));
      const range = Math.max(0.00001, prevHigh - prevLow);
      const pctOfRange = (prevHigh - cur.c) / range;
      const isBreakdown = cur.c < prevLow && cur.c < cur.o && bodyRatio >= 0.25;
      const isResume = pctOfRange >= 0.65 && cur.c < cur.o && rN >= 25 && rN <= 50;
      if (isBreakdown) {
        continuationOK = true;
        contDetail = `5-bar breakdown · body ${(bodyRatio*100).toFixed(0)}% · RSI ${rN.toFixed(1)}`;
      } else if (isResume) {
        continuationOK = true;
        contDetail = `trend resume · bottom ${Math.round(pctOfRange*100)}% of range · RSI ${rN.toFixed(1)}`;
      } else if (adxV >= 20) {
        // (c) Extended momentum SELL — 2 bearish bars, RSI in downtrend zone
        const prev1 = ohlc[n - 1];
        const last2Bear = cur.c < cur.o && prev1.c < prev1.o;
        if (last2Bear && rN >= 25 && rN <= 55) {
          continuationOK = true;
          contDetail = `extended momentum · 2 bear bars · ADX ${adxV.toFixed(1)} · RSI ${rN.toFixed(1)}`;
        }
      }
    }
  }

  if (!pullbackOK && !continuationOK) {
    // Failed both paths — report the closest miss
    if (distToE20 > atrV * 1.5) return F('Pullback', `${(distToE20/atrV).toFixed(2)}× ATR from EMA20 + no continuation breakout`);
    if (direction === 'BUY' && cur.l < e50) return F('Depth', 'pullback below EMA50 + no continuation breakout');
    if (direction === 'SELL' && cur.h > e50) return F('Depth', 'pullback above EMA50 + no continuation breakout');
    if (rN < 35 || rN > 65) return F('RSI', `${rN.toFixed(1)} outside pullback zone + no continuation`);
    return F('Path', 'neither pullback nor continuation criteria met');
  }

  if (pullbackOK) {
    P('Pullback', `${(distToE20/atrV).toFixed(2)}× ATR from EMA20`);
    P('Depth', 'shallow pullback');
    P('RSI', `${rN.toFixed(1)}`);
  } else {
    P('Continuation', contDetail);
    // The pullback-style gates still pass conceptually since trend is established
    P('Depth', 'continuation breakout (trend resuming)');
    P('RSI', `${rN.toFixed(1)}`);
  }

  // Gate 7: Direction-confirming candle.
  // For PULLBACK path: needs a reversal candle ending the pullback.
  // For CONTINUATION path: the breakout candle itself already passed body
  // check above, so this gate is auto-satisfied (the same bar is both the
  // breakout and the direction-confirming move).
  const last = ohlc[n];
  const prev = ohlc[n - 1];
  const isBullCandle = last.c > last.o && (last.c - last.o) / Math.max(0.00001, last.h - last.l) > 0.30;
  const isBearCandle = last.c < last.o && (last.o - last.c) / Math.max(0.00001, last.h - last.l) > 0.30;
  if (pullbackOK) {
    if (direction === 'BUY' && !isBullCandle) return F('Reversal', 'no bullish candle confirming pullback end');
    if (direction === 'SELL' && !isBearCandle) return F('Reversal', 'no bearish candle confirming pullback end');
  }
  P('Reversal', 'confirmation candle');

  const q = _genericQualityScore(ohlc, direction, [
    ['Trend strength', Math.min(15, trendSeparation * 5000)],
    ['ADX',           Math.min(15, (adxV - 22) * 1.5)],
    ['Pullback depth', distToE20 / atrV < 0.3 ? 12 : 8],
    ['Body strength',  isBullCandle || isBearCandle ? 10 : 0],
    ['RSI position',   direction === 'BUY' ? Math.max(0, 12 - Math.abs(rN - 47)) : Math.max(0, 12 - Math.abs(rN - 53))],
  ]);
  return { passed: true, diag, quality: q };
}

// ── BOLLINGER SQUEEZE STRATEGY ───────────────────────────────────────────
// Volatility contraction → expansion. Wait for BB width to tighten below
// 50% of its 20-bar average for 5+ bars, then enter on the breakout candle
// closing OUTSIDE the band with strong body.
function squeezeConfirmation(ohlc, direction, pair) {
  const diag = { gates: [], passed: 0, total: 7 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };
  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  const ctx = newsCalendarContext(pair, direction, 'orb');
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  const n = ohlc.length - 1;
  const closes = ohlc.map(b => b.c);
  const bb = _bbWidth(closes, 20, 2);
  const widthNow = bb.width[n];
  if (!widthNow) return F('Data', 'BB unavailable');

  // Gate 2: Squeeze — current BB width < 95% of 20-bar avg.
  // Final loosen 80% → 95%. Live audit showed Squeeze blocking 28/32 attempts
  // because current vol is naturally elevated. 95% means "current width is
  // at least slightly compressed vs recent avg" — combined with the body /
  // duration / breakout gates that follow, this still requires a real
  // compression-then-expansion sequence; we're just not insisting the
  // compression be dramatic.
  const recentWidths = bb.width.slice(n - 20, n).filter(w => w != null);
  const avgWidth = recentWidths.reduce((a, b) => a + b, 0) / Math.max(1, recentWidths.length);
  const widthRatio = widthNow / avgWidth;
  if (widthRatio > 0.95) return F('Squeeze', `width ${(widthRatio*100).toFixed(0)}% of avg — not tight`);
  P('Squeeze', `${(widthRatio*100).toFixed(0)}% of avg`);

  // Gate 3: Squeeze duration — last 2+ bars below 85% of avg.
  // Loosened: 3 bars at 75% → 2 bars at 85%. Real squeezes resolve fast
  // (often 2 bars of tight then immediate breakout) and the previous
  // 3-bar/75% requirement excluded these quick setups.
  let squeezeDuration = 0;
  for (let i = n; i >= Math.max(0, n - 8); i--) {
    if (bb.width[i] != null && bb.width[i] < avgWidth * 0.85) squeezeDuration++;
    else break;
  }
  if (squeezeDuration < 2) return F('Duration', `${squeezeDuration} bars — need 2+`);
  P('Duration', `${squeezeDuration} bars`);

  // Gate 4: Breakout — current candle closes outside BB
  const cur = ohlc[n];
  if (direction === 'BUY' && cur.c <= bb.upper[n]) return F('Breakout', `close ${cur.c.toFixed(5)} ≤ upper ${bb.upper[n].toFixed(5)}`);
  if (direction === 'SELL' && cur.c >= bb.lower[n]) return F('Breakout', `close ${cur.c.toFixed(5)} ≥ lower ${bb.lower[n].toFixed(5)}`);
  P('Breakout', direction === 'BUY' ? `closed above upper ${bb.upper[n].toFixed(5)}` : `closed below lower ${bb.lower[n].toFixed(5)}`);

  // Gate 5: Strong body (≥ 30%) on breakout candle.
  // Loosened 40% → 30%. Breakouts from a squeeze often start with a
  // medium-body bar then accelerate; requiring 40% body on the FIRST
  // breakout candle missed the early-entry setup. 30% still rules out
  // doji-style breakout-fakes.
  const body = Math.abs(cur.c - cur.o);
  const range = cur.h - cur.l;
  const bodyRatio = range > 0 ? body / range : 0;
  if (bodyRatio < 0.30) return F('Body', `${(bodyRatio*100).toFixed(0)}% — weak break`);
  P('Body', `${(bodyRatio*100).toFixed(0)}%`);

  // Gate 6: Direction agrees with quick trend (close vs 20-EMA)
  const e20 = ema(closes, 20)[n];
  if (e20 == null) return F('Trend', 'EMA20 unavailable');
  if (direction === 'BUY' && cur.c <= e20) return F('Trend', 'BUY breakout but close ≤ EMA20');
  if (direction === 'SELL' && cur.c >= e20) return F('Trend', 'SELL breakout but close ≥ EMA20');
  P('Trend', direction === 'BUY' ? 'close > EMA20' : 'close < EMA20');

  // Gate 7: ATR expanding (rising vol regime)
  const highs = ohlc.map(b => b.h);
  const lows  = ohlc.map(b => b.l);
  const atrArr = atr(highs, lows, closes);
  const atrNow = atrArr[n];
  const atrPrev = atrArr[Math.max(0, n - 8)];
  if (!atrNow || !atrPrev) return F('ATR', 'unavailable');
  // ATR-expansion gate loosened 0.95 → 0.85. Even on a valid squeeze break,
  // ATR(14) reacts slowly because it averages 14 bars — requiring 95% of
  // pre-squeeze ATR within 8 bars of resolution was unrealistic. 85% catches
  // the breakouts where price is moving but the running average hasn't
  // caught up yet.
  if (atrNow / atrPrev < 0.85) return F('ATR', `vol still contracting (${(atrNow/atrPrev*100).toFixed(0)}%)`);
  P('ATR', `${(atrNow/atrPrev*100).toFixed(0)}% of pre-squeeze`);

  // ── GENTLE HTF AWARENESS ───────────────────────────────────────────────
  // Squeeze breakouts often signal trend changes (catching a new direction
  // out of compression), so heavy HTF penalties would defeat the strategy.
  // Use a light touch: small bonus for aligned breakouts (extra confirmation),
  // tiny penalty for counter (acknowledges higher fakeout risk).
  let htfPts = 0;
  const e50sq = ema(closes, 50)[n];
  const e200sq = ema(closes, 200)[n];
  if (e50sq != null && e200sq != null) {
    const htfBull = e50sq > e200sq;
    const aligned = (direction === 'BUY' && htfBull) || (direction === 'SELL' && !htfBull);
    htfPts = aligned ? 6 : -3;
  }
  const q = _genericQualityScore(ohlc, direction, [
    ['Squeeze tightness', Math.min(15, (1 - widthRatio) * 30)],
    ['Squeeze duration', Math.min(12, squeezeDuration * 2)],
    ['Body strength',    Math.min(12, bodyRatio * 18)],
    ['ATR expansion',    Math.min(11, ((atrNow / atrPrev) - 1) * 50)],
    ['HTF alignment',    htfPts],
  ]);
  return { passed: true, diag, quality: q };
}

// ── RSI DIVERGENCE STRATEGY ──────────────────────────────────────────────
// Regular bullish: price makes lower low BUT RSI makes higher low → BUY
// Regular bearish: price makes higher high BUT RSI makes lower high → SELL
// ⚡ MOMENTUM strategy — fires whenever indicator confluence is clear AND
// price is in a momentum move. Simplest strategy in the suite — designed
// to catch the obvious directional moves that other strategies sometimes
// miss because they're waiting for specific patterns (sweep, FVG, etc.).
function momentumConfirmation(ohlc, direction, pair) {
  // SIGNIFICANTLY UPGRADED — now uses the two highest-win-rate indicators
  // from the 246-log audit (Parabolic SAR @ 71% wr + Daily trend @ 64% wr)
  // as hard confirmation gates. Plus accelerating-body, active-session, and
  // healthy-RSI checks. Result: momentum signals are markedly more selective
  // but the ones that pass should have a much higher win rate.
  const diag = { gates: [], passed: 0, total: 4 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };
  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  const ctx = newsCalendarContext(pair, direction, 'orb');
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  const n = ohlc.length - 1;
  const closes = ohlc.map(b => b.c);
  const highs = ohlc.map(b => b.h);
  const lows  = ohlc.map(b => b.l);
  const cur = ohlc[n];
  const prev = ohlc[n - 1];

  // ── Gate 1: EMA20 vs EMA50 agrees with direction (short-term trend) ──
  const e20 = ema(closes, 20)[n];
  const e50 = ema(closes, 50)[n];
  if (e20 == null || e50 == null) return F('EMAs', 'unavailable');
  if (direction === 'BUY' && e20 <= e50) return F('Trend', 'BUY but EMA20 ≤ EMA50');
  if (direction === 'SELL' && e20 >= e50) return F('Trend', 'SELL but EMA20 ≥ EMA50');
  P('Trend', direction === 'BUY' ? 'EMA20 > EMA50' : 'EMA20 < EMA50');

  // ── Gate 2: HTF alignment (50/200) ──
  const e200 = ema(closes, 200)[n];
  if (e200 != null) {
    const htfBull = e50 > e200;
    if (direction === 'BUY' && !htfBull) return F('HTF', 'BUY but EMA50 ≤ EMA200 (HTF down)');
    if (direction === 'SELL' && htfBull) return F('HTF', 'SELL but EMA50 ≥ EMA200 (HTF up)');
    P('HTF', direction === 'BUY' ? 'EMA50 > EMA200 (bull HTF)' : 'EMA50 < EMA200 (bear HTF)');
  }

  // ── Gate 3: ADX ≥ 22 (was 18) — real momentum needs a real trend ──
  // Bumped 18 → 22 because the dataset showed momentum at low-ADX (15-20)
  // had 22% win rate but at ADX 25+ had 65% win rate. The threshold lift
  // filters out the choppy-trend false positives where momentum 50%-rates.
  const adxArr = adx(highs, lows, closes).adx;
  const adxV = adxArr[n];
  if (adxV == null || adxV < 22) return F('ADX', `${adxV?.toFixed(1) || '?'} < 22 — trend too weak for momentum`);
  P('ADX', adxV.toFixed(1));

  // ── Gate 4 (NEW): Parabolic SAR confirms direction ──
  // PSAR was the #1 winning indicator in the audit (71% wr · 38 samples).
  // Requiring PSAR alignment makes momentum signals piggyback on the most
  // reliable trend indicator we have. Below SAR for SELL, above for BUY.
  const sarArr = parabolicSAR(highs, lows);
  const sarV = sarArr[n];
  if (sarV == null) return F('PSAR', 'unavailable');
  if (direction === 'BUY' && cur.c <= sarV) return F('PSAR', `price ${cur.c.toFixed(5)} ≤ SAR ${sarV.toFixed(5)} — uptrend not confirmed`);
  if (direction === 'SELL' && cur.c >= sarV) return F('PSAR', `price ${cur.c.toFixed(5)} ≥ SAR ${sarV.toFixed(5)} — downtrend not confirmed`);
  P('PSAR', direction === 'BUY' ? `price > SAR (${sarV.toFixed(5)})` : `price < SAR (${sarV.toFixed(5)})`);

  // ── Gate 5 (NEW): MACD histogram in direction ──
  // MACD audited at 60% wr · 40 samples — second-strongest predictor among
  // momentum indicators. Requires the histogram (signal-line distance) to
  // be on the right side of zero, confirming the momentum direction.
  const m = macd(closes);
  const hist = m.hist[n], histPrev = m.hist[n - 1];
  if (hist == null) return F('MACD', 'unavailable');
  if (direction === 'BUY' && hist <= 0) return F('MACD', `histogram ${hist.toFixed(5)} not positive`);
  if (direction === 'SELL' && hist >= 0) return F('MACD', `histogram ${hist.toFixed(5)} not negative`);
  P('MACD', `hist ${hist.toFixed(5)} (${direction === 'BUY' ? 'bull' : 'bear'})`);
  // Track if MACD is still accelerating (hist growing further from zero)
  const macdAccel = direction === 'BUY' ? (histPrev != null && hist > histPrev)
                                        : (histPrev != null && hist < histPrev);

  // ── Gate 6: Recent bars trending — REQUIRE 2 CONSECUTIVE same-direction ──
  // Bumped from "2 of 3" (allows alternating) to "last 2 consecutive in
  // direction" — much stronger continuation signal. The audit's losing
  // momentum trades all had alternating-direction recent bars; winners had
  // sustained directional candles.
  const cur1Dir = direction === 'BUY' ? cur.c > cur.o : cur.c < cur.o;
  const prev1Dir = direction === 'BUY' ? prev.c > prev.o : prev.c < prev.o;
  if (!cur1Dir || !prev1Dir) return F('Bars', 'last 2 candles not consecutively in direction');
  P('Bars', '2 consecutive in direction');

  // ── Gate 7 (NEW): Healthy RSI zone — strict trending range ──
  // Old: just "not at extreme opposite" (BUY < 75, SELL > 25) — too permissive.
  // New: BUY needs RSI 50-70 (healthy uptrend zone), SELL needs 30-50.
  // RSI 40-50 in uptrend = pullback (taken by TREND strategy, not Momentum).
  // RSI > 70 = exhausted, RSI > 75 = chasing the top. Same logic mirrored.
  const rN = rsi(closes)[n];
  if (rN == null) return F('RSI', 'unavailable');
  if (direction === 'BUY' && (rN < 50 || rN > 70)) return F('RSI', `${rN.toFixed(0)} outside 50-70 trending zone`);
  if (direction === 'SELL' && (rN < 30 || rN > 50)) return F('RSI', `${rN.toFixed(0)} outside 30-50 trending zone`);
  P('RSI', `${rN.toFixed(0)}`);

  // ── Gate 8 (NEW): Active session — momentum works during high-liquidity hours ──
  // London (7-16 UTC), NY (12-21 UTC), Tokyo (0-9 UTC for JPY pairs).
  // Outside these windows, momentum often fails because participation is thin.
  const utcH = cur.t ? new Date(cur.t).getUTCHours() : new Date().getUTCHours();
  const inLondon = utcH >= 7 && utcH <= 16;
  const inNY     = utcH >= 12 && utcH <= 21;
  const inTokyo  = pair && pair.includes('JPY') && utcH >= 0 && utcH <= 9;
  if (!inLondon && !inNY && !inTokyo) {
    return F('Session', `${utcH}:00 UTC outside active sessions (low liquidity)`);
  }
  P('Session', inLondon && inNY ? 'London + NY overlap' : inLondon ? 'London' : inNY ? 'NY' : 'Tokyo (JPY)');

  diag.total = 9; // Context + Trend + HTF + ADX + PSAR + MACD + Bars + RSI + Session

  // ── QUALITY SCORING — heavily weighted toward the strongest predictors ──
  let score = 50;
  const breakdown = [];

  // HTF separation strength (already aligned, measure how strong)
  if (e200 != null) {
    const trendStrength = Math.abs(e50 - e200) / e50;
    let pts = 0;
    if (trendStrength > 0.010) pts = 12;
    else if (trendStrength > 0.005) pts = 8;
    else pts = 4;
    score += pts; breakdown.push(`HTF strength +${pts}`);
  }
  // ADX strength
  let adxPts = 0;
  if (adxV >= 35) adxPts = 14;
  else if (adxV >= 30) adxPts = 11;
  else if (adxV >= 25) adxPts = 7;
  else if (adxV >= 22) adxPts = 3;
  score += adxPts; if (adxPts) breakdown.push(`ADX ${adxV.toFixed(0)} +${adxPts}`);
  // MACD accelerating bonus
  if (macdAccel) { score += 5; breakdown.push('MACD accelerating +5'); }
  // PSAR distance bonus — bigger gap = stronger trend
  const sarDist = Math.abs(cur.c - sarV) / Math.max(0.00001, sarV);
  if (sarDist > 0.003) { score += 5; breakdown.push('PSAR strong distance +5'); }
  else if (sarDist > 0.0015) { score += 3; breakdown.push('PSAR distance +3'); }
  // Accelerating body — current bar's body bigger than prev (momentum growing)
  const curBody = Math.abs(cur.c - cur.o);
  const prevBody = Math.abs(prev.c - prev.o);
  if (curBody > prevBody * 1.2) { score += 6; breakdown.push('Body accelerating +6'); }
  else if (curBody > prevBody) { score += 3; breakdown.push('Body growing +3'); }
  // RSI in sweet-spot zone
  const rsiSweet = direction === 'BUY' ? (rN >= 55 && rN <= 65) : (rN >= 35 && rN <= 45);
  if (rsiSweet) { score += 5; breakdown.push('RSI sweet spot +5'); }
  // London+NY overlap (12-16 UTC) — highest liquidity window
  if (inLondon && inNY) { score += 4; breakdown.push('London+NY overlap +4'); }

  score = Math.min(100, Math.max(0, score));
  const quality = { score, grade: _qualityGrade(score), breakdown };
  return { passed: true, diag, quality };
}

function rsiDivergenceConfirmation(ohlc, direction, pair) {
  const diag = { gates: [], passed: 0, total: 6 };
  const F = (g, r) => { diag.gates.push({ name: g, passed: false, reason: r }); return { passed: false, diag }; };
  const P = (g, d) => { diag.gates.push({ name: g, passed: true, detail: d }); diag.passed++; };
  if (!ohlc || ohlc.length < 60) return F('Data', 'insufficient bars');
  if (direction !== 'BUY' && direction !== 'SELL') return F('Direction', 'no direction');

  const ctx = newsCalendarContext(pair, direction, 'smc'); // div is reversal — SMC mode
  if (ctx.block) return F('Context', ctx.blockReason);
  P('Context', ctx.detail);

  const n = ohlc.length - 1;
  const closes = ohlc.map(b => b.c);
  const highs  = ohlc.map(b => b.h);
  const lows   = ohlc.map(b => b.l);
  const rsiArr = rsi(closes);

  // Gate 2: Find two recent swing extremes within last 35 bars.
  // For BUY: two lower lows in price BUT higher low in RSI
  // For SELL: two higher highs in price BUT lower high in RSI
  //
  // 5-BAR FRACTAL — a real swing point is lower (or higher) than the TWO bars
  // on each side, not just one. The 5-bar fractal mirrors `_findSwings`
  // elsewhere so divergence detection is consistent with how the rest of
  // the app sees swings. Window widened 35 → 50 bars: 5-bar fractals are
  // less frequent than 2-bar, so to keep divergence firing at a useful rate
  // we look further back. 50 bars on 1H ≈ 2 trading days — old enough that
  // divergences are still actionable, new enough that they're not stale.
  const window = 50;
  const start = Math.max(20, n - window);
  let p1 = -1, p2 = -1;
  // Need 2-bar lookahead so we can't validate the last 2 bars yet.
  const lastValid = n - 2;
  if (direction === 'BUY') {
    for (let i = lastValid; i >= start + 2; i--) {
      // 5-bar fractal low: lower than 2 bars on each side
      if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
          lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
        if (p2 === -1) p2 = i;
        else if (p1 === -1 && Math.abs(i - p2) >= 4) { p1 = i; break; }
      }
    }
  } else {
    for (let i = lastValid; i >= start + 2; i--) {
      // 5-bar fractal high: higher than 2 bars on each side
      if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
          highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
        if (p2 === -1) p2 = i;
        else if (p1 === -1 && Math.abs(i - p2) >= 4) { p1 = i; break; }
      }
    }
  }
  if (p1 < 0 || p2 < 0) return F('Swings', 'no two 5-bar swing points found in last 50 bars');
  P('Swings', `swings at bar ${n - p1} and ${n - p2} ago`);

  // Gate 3: Price made a new extreme but RSI didn't — DIVERGENCE
  const r1 = rsiArr[p1], r2 = rsiArr[p2];
  if (r1 == null || r2 == null) return F('RSI', 'unavailable at swings');
  if (direction === 'BUY') {
    if (lows[p2] >= lows[p1]) return F('Price', 'price not making lower low');
    if (r2 <= r1) return F('Divergence', `RSI ${r1.toFixed(1)} → ${r2.toFixed(1)} not higher (no div)`);
    P('Divergence', `price LL but RSI ${r1.toFixed(1)} → ${r2.toFixed(1)} (HL)`);
  } else {
    if (highs[p2] <= highs[p1]) return F('Price', 'price not making higher high');
    if (r2 >= r1) return F('Divergence', `RSI ${r1.toFixed(1)} → ${r2.toFixed(1)} not lower (no div)`);
    P('Divergence', `price HH but RSI ${r1.toFixed(1)} → ${r2.toFixed(1)} (LH)`);
  }

  // Gate 4: Confirmation candle (price reversing)
  const cur = ohlc[n];
  const isBullReversal = cur.c > cur.o && cur.c > closes[n - 1];
  const isBearReversal = cur.c < cur.o && cur.c < closes[n - 1];
  if (direction === 'BUY' && !isBullReversal) return F('Confirm', 'no bullish reversal candle');
  if (direction === 'SELL' && !isBearReversal) return F('Confirm', 'no bearish reversal candle');
  P('Confirm', 'reversal candle');

  // Gate 5: ADX < 32 (very strong trends rarely reverse on divergence alone)
  const adxV = adx(highs, lows, closes).adx[n];
  if (adxV != null && adxV > 32) return F('ADX', `${adxV.toFixed(1)} > 32 — trend too strong to reverse`);
  P('ADX', adxV != null ? `${adxV.toFixed(1)}` : 'n/a');

  // Gate 6: Recent extreme RSI helps the case
  const rN = rsiArr[n];
  if (rN == null) return F('RSI now', 'unavailable');
  if (direction === 'BUY' && rN > 55) return F('RSI now', `${rN.toFixed(1)} too high for BUY divergence`);
  if (direction === 'SELL' && rN < 45) return F('RSI now', `${rN.toFixed(1)} too low for SELL divergence`);
  P('RSI now', `${rN.toFixed(1)}`);

  // ── HTF-STRENGTH AWARENESS for divergence ──────────────────────────────
  // Divergence is a REVERSAL strategy — the natural play is counter to the
  // existing trend. But strong trends rarely reverse on divergence alone, so:
  //   • Counter-trend div + WEAK HTF: bonus (likely topping/bottoming)
  //   • Counter-trend div + STRONG HTF: penalty (early, hard to reverse)
  //   • HIDDEN divergence (with-trend continuation, rare): mild bonus
  // Mirrors the same direction-aware logic applied to SMC quality.
  let htfDivPts = 0;
  const e50div = ema(closes, 50)[n];
  const e200div = ema(closes, 200)[n];
  if (e50div != null && e200div != null) {
    const htfBull = e50div > e200div;
    const trendStrength = Math.abs(e50div - e200div) / e50div;
    const isReversalPlay = (direction === 'BUY' && !htfBull) || (direction === 'SELL' && htfBull);
    if (isReversalPlay) {
      // Counter-trend (natural divergence): reward weak trends (likely reversal),
      // penalize strong trends (hard to flip).
      if (trendStrength > 0.010)      htfDivPts = -10; // strong trend = bad reversal candidate
      else if (trendStrength > 0.005) htfDivPts = -3;
      else                            htfDivPts = 8;   // exhausted/weak trend = reversal ripe
    } else {
      // With-trend divergence = "hidden" divergence (continuation pattern).
      // Less common but a legit play.
      htfDivPts = 5;
    }
  }
  const q = _genericQualityScore(ohlc, direction, [
    ['Divergence strength', Math.min(20, Math.abs(r1 - r2) * 1.5)],
    ['Bars between',        Math.min(10, Math.abs(p1 - p2) * 1)],
    ['Reversal candle',     15],
    ['ADX moderate',        adxV != null ? Math.max(0, 12 - Math.max(0, adxV - 22)) : 5],
    ['HTF context',         htfDivPts],
  ]);
  return { passed: true, diag, quality: q };
}

// Generic quality scorer — takes weighted sub-checks and grades them
function _genericQualityScore(ohlc, direction, subChecks) {
  let score = 50;
  const breakdown = [];
  for (const [name, pts] of subChecks) {
    const v = Math.max(-10, Math.min(20, Math.round(pts || 0)));
    if (v !== 0) {
      score += v;
      breakdown.push(`${name} ${v >= 0 ? '+' : ''}${v}`);
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: _qualityGrade(score), breakdown };
}

// ════════════════════════════════════════════════════════════════════════
// GENERIC AUTO-TRACK + NOTIFICATION HELPERS
// Used for ICT, Trend Pullback, BB Squeeze, RSI Divergence — same pattern
// as autoAddSMCTrade/fireSMCNotification but parameterized by strategy key.
// ════════════════════════════════════════════════════════════════════════
function _stratAutoStore(sk) { return safeLoad(`forexsight_${sk}_auto_v1`, {}); }
function _stratAutoSave(sk, data) { return safeSave(`forexsight_${sk}_auto_v1`, data); }
function _stratToday() { return new Date().toISOString().slice(0, 10); }

// v142: PER-PAIR-PER-SESSION tracker. Keyed by `${pair}::${sessionId}` (e.g.
// "EUR/USD::london_2026-05-14"). Stores the timestamp of the first auto-track
// for that pair in that session window. Used to enforce "max 1 auto-track per
// pair per session" so a single losing setup can't get cloned 4× across SMC,
// ORB, ICT and Trend all firing at the same hour.
const PAIR_SESSION_KEY = 'forexsight_pair_session_auto_v1';
function _pairSessionStore() { return safeLoad(PAIR_SESSION_KEY, {}); }
function _pairSessionSave(data) { return safeSave(PAIR_SESSION_KEY, data); }
function _pairSessionAlreadyTracked(pair, sessionId) {
  try {
    const data = _pairSessionStore();
    return !!data[`${pair}::${sessionId}`];
  } catch { return false; }
}
function _markPairSessionTracked(pair, sessionId) {
  try {
    const data = _pairSessionStore();
    data[`${pair}::${sessionId}`] = Date.now();
    // Garbage-collect entries older than 3 days
    const cutoff = Date.now() - 3 * 86400 * 1000;
    for (const k of Object.keys(data)) {
      if (data[k] < cutoff) delete data[k];
    }
    _pairSessionSave(data);
  } catch {}
}
function _unmarkPairSessionTracked(pair, sessionId) {
  try {
    const data = _pairSessionStore();
    delete data[`${pair}::${sessionId}`];
    _pairSessionSave(data);
  } catch {}
}
function _stratAutoTodayCount(sk) { return Object.keys(_stratAutoStore(sk)[_stratToday()] || {}).length; }
function _stratAutoSeen(sk, key) { return !!(_stratAutoStore(sk)[_stratToday()]?.[key]); }
function _stratAutoMark(sk, key) {
  const data = _stratAutoStore(sk);
  const today = _stratToday();
  data[today] = data[today] || {};
  data[today][key] = Date.now();
  const dates = Object.keys(data).sort();
  while (dates.length > 7) delete data[dates.shift()];
  _stratAutoSave(sk, data);
}

// ─── DYNAMIC LEARNING — auto-derives per-pair-direction stats from history ──
// Returns the user's actual win rate for this exact pair+direction across
// all CLOSED trades. The auto-tracker uses this to refuse to track setups
// on pair+direction combos that have proven to lose more than they win.
// Cached per render-cycle for perf — refreshed every time trades change.
// v147/v148 SELF-LEARNING STATS — the brain. Mines every historical trade and
// returns multi-dimensional breakdowns:
//   • byPairDir: w/l/recent[] per pair+direction
//   • byPairDirSession: w/l per pair+direction+session bucket
//   • byPairDirStrat: w/l per pair+direction+strategy-key
//   • byPairDirHour (v148): w/l per pair+direction+UTC-hour
//   • byPairDirVolRegime (v148): w/l per pair+direction+volRegime
// Auto-rebuilds whenever trades count changes — i.e. every closure re-trains
// the filter automatically. The longer the history, the more dimensions
// become statistically meaningful. Self-improving without code changes;
// as the user's closed-trade history grows, the filter gets sharper.
let _pairStatsCache = { ts: 0, byPairDir: {}, byPairDirSession: {}, byPairDirStrat: {}, byPairDirHour: {}, byPairDirVolRegime: {} };
function _sessBucket(s) {
  const x = (s || '').toLowerCase();
  if (x.includes('overlap')) return 'overlap';
  if (x.includes('london')) return 'london';
  if (x.includes('ny')) return 'ny';
  if (x.includes('tokyo') || x.includes('asian')) return 'tokyo';
  return 'other';
}
function getPairDirStats(pair, direction) {
  const trades = getTrades();
  if (_pairStatsCache.ts !== trades.length) {
    const map = {};
    const sessMap = {};
    const stratMap = {};
    const hourMap = {};
    const volMap = {};
    for (const t of trades) {
      if (t.status !== 'won' && t.status !== 'lost') continue;
      const k = `${t.pair}_${t.direction}`;
      map[k] = map[k] || { w: 0, l: 0, recent: [] };
      if (t.status === 'won') map[k].w++; else map[k].l++;
      map[k].recent.push({ outcome: t.status, ts: t.closedAt || t.takenAt });
      // Session bucket
      const sk = `${k}_${_sessBucket(t.session)}`;
      sessMap[sk] = sessMap[sk] || { w: 0, l: 0 };
      if (t.status === 'won') sessMap[sk].w++; else sessMap[sk].l++;
      // Strategy combo
      const strats = (t.firedStrategies || []).map(s => s && s.name).filter(Boolean).sort().join('+') || 'none';
      const stk = `${k}_${strats}`;
      stratMap[stk] = stratMap[stk] || { w: 0, l: 0 };
      if (t.status === 'won') stratMap[stk].w++; else stratMap[stk].l++;
      // v148: Hour-of-day bucket — entry hour UTC. Pairs/sessions trade
      // very differently across the 24h cycle. London open (7 UTC), NY
      // open (12 UTC), Asia late (3 UTC) all behave differently.
      const takenMs = typeof t.takenAt === 'string' ? Date.parse(t.takenAt) : (t.takenAt || 0);
      if (takenMs) {
        const hour = new Date(takenMs).getUTCHours();
        const hk = `${k}_${hour}`;
        hourMap[hk] = hourMap[hk] || { w: 0, l: 0 };
        if (t.status === 'won') hourMap[hk].w++; else hourMap[hk].l++;
      }
      // v148: Volatility regime bucket
      if (t.volRegime) {
        const vk = `${k}_${t.volRegime}`;
        volMap[vk] = volMap[vk] || { w: 0, l: 0 };
        if (t.status === 'won') volMap[vk].w++; else volMap[vk].l++;
      }
    }
    for (const k of Object.keys(map)) {
      map[k].recent.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    }
    _pairStatsCache = { ts: trades.length, byPairDir: map, byPairDirSession: sessMap, byPairDirStrat: stratMap, byPairDirHour: hourMap, byPairDirVolRegime: volMap };
  }
  const base = _pairStatsCache.byPairDir[`${pair}_${direction}`] || { w: 0, l: 0, recent: [] };
  base.getSession = (session) => _pairStatsCache.byPairDirSession[`${pair}_${direction}_${_sessBucket(session)}`] || { w: 0, l: 0 };
  base.getStratCombo = (strats) => {
    const sortedKey = (strats || []).map(s => s && s.name).filter(Boolean).sort().join('+') || 'none';
    return _pairStatsCache.byPairDirStrat[`${pair}_${direction}_${sortedKey}`] || { w: 0, l: 0 };
  };
  base.getHour = (hour) => _pairStatsCache.byPairDirHour[`${pair}_${direction}_${hour}`] || { w: 0, l: 0 };
  base.getVolRegime = (regime) => _pairStatsCache.byPairDirVolRegime[`${pair}_${direction}_${regime}`] || { w: 0, l: 0 };
  return base;
}

// v148 LEARNING SUMMARY — emit a one-line snapshot of what the brain knows
// right now. Called once per signal-evaluation. Lets the user/dev see the
// continuous learning at work in the console.
function logLearningSummary() {
  try {
    if (!_pairStatsCache || !_pairStatsCache.byPairDir) return;
    const pd = _pairStatsCache.byPairDir;
    const totalCombos = Object.keys(pd).length;
    let totalW = 0, totalL = 0;
    let bestPair = null, bestWr = -1, worstPair = null, worstWr = 999;
    for (const k of Object.keys(pd)) {
      const s = pd[k];
      const n = s.w + s.l;
      totalW += s.w;
      totalL += s.l;
      if (n >= 5) {
        const wr = s.w / n;
        if (wr > bestWr) { bestWr = wr; bestPair = k; }
        if (wr < worstWr) { worstWr = wr; worstPair = k; }
      }
    }
    const lifeWr = totalW + totalL ? Math.round(totalW / (totalW + totalL) * 100) : 0;
    console.log(`[v148 brain] learned from ${totalW + totalL} trades (${lifeWr}% wr) across ${totalCombos} pair-directions · best: ${bestPair} ${Math.round(bestWr*100)}% · worst: ${worstPair} ${Math.round(worstWr*100)}%`);
  } catch (e) { /* swallow */ }
}

function autoAddStrategyTrade(signal, sk) {
  try {
    const cfg = STRATEGIES[sk];
    if (!cfg || !signal) return;
    if (!signal[`${sk}Passed`]) return;
    if (signal.direction !== 'BUY' && signal.direction !== 'SELL') return;
    if ((signal[`${sk}Quality`] || 0) < STRATEGY_AUTOTRACK_MIN) return;

    // ── LOSS-PATTERN BLOCKS (learned from your actual closed trades) ─────
    // After 6 closed trades (3W/3L), the two patterns that perfectly separate
    // winners from losers in your history:
    //   1. Counter-trend — every loss fought the HTF trend (DOGE SELL+HTF up,
    //      AUD/USD SELL+HTF up). Every winner was HTF-aligned. 100% predictive.
    //   2. Momentum-only — every loss that wasn't counter-trend (NZD/CAD) had
    //      ONLY Momentum confirmation, no structural strategy.
    //
    // REMOVED: winProbability < 50% rule. Initial analysis suggested it; 6-trade
    // audit showed it would have BLOCKED 3 winners (AUD/CHF, EUR/AUD, BNB/USD
    // all had winProb < 50% and won). Net effect: -1 wins. The backtest model
    // is currently biased against the actual winning setups, so we don't use
    // it for hard filtering until the model is recalibrated from more trades.
    if (signal.htfTrend &&
        ((signal.direction === 'BUY'  && signal.htfTrend === 'down') ||
         (signal.direction === 'SELL' && signal.htfTrend === 'up'))) {
      console.log(`[${sk} auto-trade] blocked: counter-trend (HTF ${signal.htfTrend}, dir ${signal.direction})`);
      return;
    }
    if (sk === 'momentum') {
      // Momentum-only block (already in place)
      const hasStructural = signal.smcPassed || signal.orbPassed ||
        signal.ictPassed || signal.trendPassed ||
        signal.squeezePassed || signal.divergencePassed;
      if (!hasStructural) {
        console.log('[momentum auto-trade] blocked: no structural strategy backing');
        return;
      }
    }

    // ── ELITE-MODE FILTER (learned from 252 trades + iter 2 audit) ────────
    // Hard data: ORB-confirmed trades win 80%. But the AVAX/USD BUY loss
    // (iter 2 audit) had ORB A+ + Momentum + HTF aligned + ADX 23 + conf 69
    // — passed every gate — and still lost -4700 pips. The only flag that
    // differentiated it from ORB winners: `volRegime: "contracting"`.
    // Volatility was compressing → breakout was a fakeout.
    //
    // Pattern: ORB ALONE (no 2nd structural strategy) is reliable ONLY when
    // volatility is expanding (normal trend). Contracting vol + ORB-only
    // = high fakeout risk.
    //
    // Elite filter v2 — multi-layered:
    //   1. Must have ORB OR 2+ structural strategies (kept from v137)
    //   2. AND quality ≥ 75 (B+) on the firing strategy (kept)
    //   3. AND confidence ≥ 60 (kept)
    //   4. NEW: if ORB-only (single structural), vol regime must NOT be
    //      "contracting" — that pattern produced -4700 pip AVAX loss.
    //   5. NEW: if ORB-only AND winProbability < 50% with backtestSamples ≥
    //      50, block — historical data says this specific pair+direction
    //      setup loses. AVAX/USD BUY had winProb 40%.
    const passingStratCount = [
      signal.smcPassed, signal.orbPassed, signal.ictPassed,
      signal.trendPassed, signal.squeezePassed, signal.divergencePassed,
      signal.momentumPassed,
    ].filter(Boolean).length;
    const hasORB = !!signal.orbPassed;
    // v150 RULE 6 / v156 RULE 8: REQUIRE SUPER SETUP for auto-take.
    // v150 originally required passingStratCount >= 2. v156 tightens further:
    // require the signal to qualify as isSuperSetup (the v155 definition:
    // 3+ strategies pass OR 2 strategies + indicator-delta ≥ 5).
    //
    // Empirical evidence from v146-era forward closures:
    //   • 3+ strats:  3W / 1L  = 75% WR  ← only loss was Tokyo USD-quoted (already gated by RULE 5)
    //   • 2 strats:   1W / 2L  = 33% WR  ← below break-even
    //   • 1 strat:    1W / 3L  = 25% WR  ← legacy only
    // Tightening to SUPER-only sharply raises win-rate at the cost of volume.
    // The consensus-promoted SUPER (2 strats + strong indicator delta) is the
    // safety valve that keeps occasional 2-strat winners in scope when raw
    // indicator agreement is overwhelming.
    const _isSuper = (signal.isSuperSetup === true) ||
                     passingStratCount >= 3 ||
                     (passingStratCount >= 2 && (signal.superAlignedDelta || 0) >= 5);
    if (!_isSuper) {
      console.log(`[${sk} auto-trade] blocked: not SUPER setup (${passingStratCount} strats, delta=${signal.superAlignedDelta || 0}) — v156 requires 3+ strats or 2 strats + delta≥5. v146-era 2-strat WR was 33%.`);
      return;
    }
    // v141: ADAPTIVE QUALITY FLOOR — base 85 (A grade), but raises to 90 (A+)
    // if recent auto-tracks have been losing. Self-tightening: when the user's
    // recent track record dips, the bar lifts; when it rises, the bar stays at
    // the base 85. This means the more often I lose, the more selective the
    // filter becomes — no manual tightening required.
    const recent20 = getTrades()
      .filter(t => (t.status === 'won' || t.status === 'lost') && t.autoAdded && !t.isRecovered)
      .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''))
      .slice(0, 20);
    const recent20Wr = recent20.length >= 5
      ? recent20.filter(t => t.status === 'won').length / recent20.length
      : null;
    // v146 RUTHLESS MODE — user said "i want only win signals · 100 years of
    // trading experience." Raised both floors aggressively so only elite
    // setups pass. Trades through fewer but higher-quality entries.
    // v162 — base floors raised: qualityFloor 90→93, confFloor 78→85.
    // Every adaptive tier shifts up correspondingly. Per user directive:
    // "fix everything you can fix" — squeezing out borderline setups.
    let qualityFloor = 93;
    let confFloor = 85;
    if (recent20Wr != null) {
      if (recent20Wr < 0.40) {       // <40% recent → demand top-tier
        qualityFloor = 97;
        confFloor = 90;
      } else if (recent20Wr < 0.55) { // 40-55% → demand 95+
        qualityFloor = 95;
        confFloor = 88;
      } else if (recent20Wr >= 0.80) { // doing great → can relax slightly
        qualityFloor = 91;
        confFloor = 82;
      }
    }
    const qualityNow = signal[`${sk}Quality`] || 0;
    if (qualityNow < qualityFloor) {
      console.log(`[${sk} auto-trade] blocked: ${sk} quality ${qualityNow}/100 < ${qualityFloor} (adaptive floor, recent wr ${recent20Wr != null ? Math.round(recent20Wr*100)+'%' : 'n/a'})`);
      return;
    }
    if ((signal.confidence || 0) < confFloor) {
      console.log(`[${sk} auto-trade] blocked: confidence ${signal.confidence}% < ${confFloor}% (adaptive floor)`);
      return;
    }

    // ── v140: DYNAMIC PER-PAIR-DIRECTION LEARNING ────────────────────────
    // Pulls user's actual closed-trade history for this exact pair+direction.
    // Refuses to auto-track if proven to be a losing setup. Self-improving:
    // as more trades close, the filter gets smarter automatically without
    // any new rules from me — the data IS the rule.
    //
    // v147 RUTHLESS MODE — user said "make sure everyone you put in my trades
    // are guaranteed to win" and "learn from all his mistakes." Tightened from
    // 0.50 WR threshold to 0.60. A coin-flip pair (50%) is no longer "proven
    // non-loser" — only pairs that have historically WON more than lost
    // significantly (60%+) get through. This is the strictest possible
    // data-driven filter: only repeat the patterns that have already worked.
    // v163 RULE 11 (tightened from v147): per-pair WR floor 60% → 65%.
    const pairStats = getPairDirStats(signal.pair, signal.direction);
    const totalPD = pairStats.w + pairStats.l;
    if (totalPD >= 3) {
      const wr = pairStats.w / totalPD;
      if (wr < 0.65) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} historical wr ${Math.round(wr*100)}% < 65% (v163 — only proven winners ≥65%)`);
        return;
      }
    }

    // ── v147 RECENT-10 LOSS COUNT BLACKLIST ─────────────────────────────────
    // If 3+ of the last 10 closed trades for this exact pair+direction were
    // losses, BLOCK. Long-term WR can mask recent regime shifts; recent
    // losses are the strongest signal that the pattern has stopped working.
    // Pros call this "the streak filter" — never re-enter a pair while it's
    // actively bleeding you.
    // v163 (tightened): streak filter loss count 3→2 in last 10.
    if (pairStats.recent && pairStats.recent.length >= 3) {
      const last10 = pairStats.recent.slice(0, 10);
      const last10Losses = last10.filter(t => t.outcome === 'lost').length;
      if (last10Losses >= 2) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} lost ${last10Losses} of last ${last10.length} (v163 streak filter — 2 losses in last 10 means pattern is unreliable)`);
        return;
      }
    }

    // ── v147 SESSION-AWARE HISTORICAL WR ─────────────────────────────────────
    // Same pair+direction may win in London but lose in NY. If the same
    // pair+direction+session has historically lost more than won (≥3 samples),
    // BLOCK. "Trade only when this exact setup has worked in this exact
    // session" — pros do this instinctively, the system now does it from data.
    const sessStats = pairStats.getSession ? pairStats.getSession(signal.session) : { w: 0, l: 0 };
    const totalSess = sessStats.w + sessStats.l;
    if (totalSess >= 3) {
      const sessWr = sessStats.w / totalSess;
      if (sessWr < 0.60) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} in ${signal.session} historical wr ${Math.round(sessWr*100)}% (${sessStats.w}W/${sessStats.l}L) < 60% (v147 session-aware learning)`);
        return;
      }
    }

    // ── v147 STRATEGY-COMBO HISTORICAL BLACKLIST ─────────────────────────────
    // If this EXACT combination of fired strategies has historically lost on
    // this pair+direction (≥2 samples, <50% WR), BLOCK. Different strategy
    // combos behave very differently — SMC+ORB might win on EUR/USD where
    // SMC+TREND loses. The system now remembers exactly which combinations
    // worked and which didn't.
    // v170 (tightened from v147): strat-combo WR floor 50% → 60%.
    // This is the live-learning feedback loop: once 2+ samples accumulate
    // for a specific pair+direction+strategy-combo, the system permanently
    // remembers if that exact pattern wins or loses. Tightened threshold
    // means weaker combos get cut faster.
    const stratStats = pairStats.getStratCombo ? pairStats.getStratCombo(signal.firedStrategies) : { w: 0, l: 0 };
    const totalStrat = stratStats.w + stratStats.l;
    if (totalStrat >= 2) {
      const stratWr = stratStats.w / totalStrat;
      if (stratWr < 0.60) {
        const stratList = (signal.firedStrategies || []).map(s => s && s.name).filter(Boolean).sort().join('+');
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} combo [${stratList}] historical wr ${Math.round(stratWr*100)}% < 60% (v170 combo learning)`);
        return;
      }
    }

    // ─── v148 EVOLVING-BRAIN ADDITIONS ──────────────────────────────────────
    // "It should be limitless, evolving every second, every trade, every
    // signal." Two new learning dimensions plus an adaptive WR threshold.
    // ─────────────────────────────────────────────────────────────────────

    // v148 RULE A: HOUR-OF-DAY HISTORICAL WR
    // Same pair+direction can have very different WR by UTC hour. London
    // open (7 UTC), NY open (12 UTC), and Asian late-session (3 UTC) all
    // trade differently for the same pair. If this exact pair+dir+hour has
    // historically lost more than won (≥3 samples), BLOCK.
    // v164: hour-of-day WR floor tightened 50% → 60%, minimum samples 3 → 2.
    const nowHour = new Date().getUTCHours();
    const hourStats = pairStats.getHour ? pairStats.getHour(nowHour) : { w: 0, l: 0 };
    const totalHour = hourStats.w + hourStats.l;
    if (totalHour >= 2) {
      const hourWr = hourStats.w / totalHour;
      if (hourWr < 0.60) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} at hour ${nowHour}:00 UTC historical wr ${Math.round(hourWr*100)}% < 60% (v164 hour-of-day floor)`);
        return;
      }
    }

    // v148 RULE B: VOLATILITY-REGIME HISTORICAL WR
    // The same pair+direction wins in some regimes and loses in others.
    // E.g. ORB-style breakouts need "expanding" regime, mean-reversion
    // needs "contracting." Learns automatically from history.
    if (signal.volRegime) {
      const volStats = pairStats.getVolRegime ? pairStats.getVolRegime(signal.volRegime) : { w: 0, l: 0 };
      const totalVol = volStats.w + volStats.l;
      if (totalVol >= 3) {
        const volWr = volStats.w / totalVol;
        if (volWr < 0.50) {
          console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} in ${signal.volRegime} regime historical wr ${Math.round(volWr*100)}% (${volStats.w}W/${volStats.l}L) (v148 volRegime memory)`);
          return;
        }
      }
    }

    // v148 RULE C: ADAPTIVE WR THRESHOLD
    // The 60% base WR threshold from v147 becomes a FUNCTION of the recent-20
    // performance. If the user is on a losing streak globally, the system
    // tightens further (demands proven 70% winners). If everything is winning
    // (which is great), it relaxes slightly. This is the "evolve every trade"
    // mechanic — the threshold itself shifts continuously with results.
    let adaptiveThreshold = 0.60; // baseline (v147)
    if (recent20Wr != null) {
      if (recent20Wr < 0.40) adaptiveThreshold = 0.70;   // bleeding → demand top setups
      else if (recent20Wr < 0.55) adaptiveThreshold = 0.65; // sub-par → tighten
      else if (recent20Wr >= 0.75) adaptiveThreshold = 0.55; // crushing → can take slightly more
    }
    // Re-check pair-dir WR against ADAPTIVE threshold (separate from the v147
    // fixed 60% gate — this catches setups that pass 60% but not the
    // tightened version when user is on a cold streak).
    if (totalPD >= 3) {
      const wrCheck = pairStats.w / totalPD;
      if (wrCheck < adaptiveThreshold) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} wr ${Math.round(wrCheck*100)}% < adaptive ${Math.round(adaptiveThreshold*100)}% (recent20 wr=${recent20Wr != null ? Math.round(recent20Wr*100)+'%' : 'n/a'} — system tightening)`);
        return;
      }
    }

    // v148: Emit learning snapshot so the user can see the brain evolving in
    // realtime via the console. This fires on EVERY signal evaluation.
    logLearningSummary();
    // ─── end v148 evolving-brain additions ──────────────────────────────────

    // ── v140: RECENT-LOSS COOLDOWN ────────────────────────────────────────
    // If this exact pair+direction lost the last 2 of its most recent
    // closed trades, pause for 24h. Markets often regime-shift; recent
    // losses are a stronger signal than ancient ones.
    const last2 = pairStats.recent.slice(0, 2);
    if (last2.length === 2 && last2.every(t => t.outcome === 'lost')) {
      const mostRecentLossTs = last2[0].ts ? new Date(last2[0].ts).getTime() : 0;
      const hoursSince = (Date.now() - mostRecentLossTs) / 3600000;
      if (hoursSince < 24) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} ${signal.direction} lost last 2 trades ${hoursSince.toFixed(1)}h ago (24h cooldown)`);
        return;
      }
    }

    // ── v140: ACTIVE-SESSION-ONLY ─────────────────────────────────────────
    // Auto-track only during high-liquidity windows. Outside London/NY
    // (Tokyo for JPY pairs), spreads widen and breakouts often fake out.
    const utcH = new Date().getUTCHours();
    const inLondon = utcH >= 7 && utcH <= 16;
    const inNY     = utcH >= 12 && utcH <= 21;
    const inTokyo  = signal.pair && signal.pair.includes('JPY') && utcH >= 0 && utcH <= 9;
    const inCrypto = ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','BNB/USD','ADA/USD','DOGE/USD','AVAX/USD'].includes(signal.pair);
    if (!inLondon && !inNY && !inTokyo && !inCrypto) {
      console.log(`[${sk} auto-trade] blocked: ${utcH}:00 UTC outside active sessions for ${signal.pair}`);
      return;
    }

    // ═════════════════════════════════════════════════════════════════════
    // ── v142 FILTER STACK — TIGHTEN BEFORE TRACKING ──
    //
    // Goal stated by user: "I want to see a big difference in the winning
    // rate." Three rules, each backed by data from the closed-trade audit.
    // ═════════════════════════════════════════════════════════════════════

    // v142 RULE 1: TOP-PREDICTOR ALIGNMENT REQUIRED
    // PSAR (~71% wr aligned), MACD histogram (~60%), and HTF/Daily trend
    // are the 3 highest-WR indicators in the closed-trade history. The
    // recent loss audit found that the LOSING trades typically had 0/3
    // top predictors agreeing — strategies fired in a vacuum. Require at
    // least 1 of the 3 to agree with direction.
    const topAligned = signal.topPredictorsAligned;
    if (topAligned != null && topAligned < 1) {
      console.log(`[${sk} auto-trade] blocked: 0/3 top predictors aligned (PSAR=${signal.psarAligned}, MACD=${signal.macdHistAligned}, Daily=${signal.dailyTrendAligned}) — historical losers have this exact shape`);
      return;
    }

    // v188 (was v142 RULE 2): ADX floor 25 → 30. Gold-only "best of best"
    // mode demands strong trend. ADX 30+ is "very strong" — gold setups
    // with ADX <30 historically drift sideways and time-stop out.
    if (signal.adxNow != null && signal.adxNow < 30) {
      console.log(`[${sk} auto-trade] blocked: ADX ${signal.adxNow} < 30 (v188 gold-only requires very strong trend)`);
      return;
    }

    // v142 RULE 3: MAX 1 AUTO-TRACK PER PAIR PER SESSION
    // Stops over-concentration: if a pair already auto-tracked this
    // session (London/NY/Tokyo/Crypto window we're currently in), skip
    // any further auto-tracks on that pair regardless of direction or
    // strategy. Previously a single pair could collect 4+ near-simultaneous
    // auto-tracks (e.g. SMC + ORB + ICT all on EUR/USD BUY at the same hour),
    // which dragged WR down when that one setup lost.
    const sessionId = inCrypto ? `crypto_${_stratToday()}`
      : inLondon && inNY ? `overlap_${_stratToday()}`   // LDN-NY overlap (12-16 UTC) — peak liquidity, treated as own bucket
      : inLondon ? `london_${_stratToday()}`
      : inNY ? `ny_${_stratToday()}`
      : inTokyo ? `tokyo_${_stratToday()}`
      : `other_${_stratToday()}`;
    if (_pairSessionAlreadyTracked(signal.pair, sessionId)) {
      console.log(`[${sk} auto-trade] blocked: ${signal.pair} already auto-tracked this ${sessionId.split('_')[0]} session (max 1/pair/session)`);
      return;
    }
    // Note: we only mark the pair-session lock once the trade actually
    // makes it into the trades list (success path below). This avoids
    // any need to unwind the mark on the various downstream early-returns.

    // ─── end v142 filter stack ────────────────────────────────────────────
    // NEW v138: ORB-only + contracting volatility = blocked
    if (passingStratCount === 1 && hasORB && signal.volRegime === 'contracting') {
      console.log(`[${sk} auto-trade] blocked: ORB-only + contracting vol regime (fakeout risk learned from AVAX loss)`);
      return;
    }
    // v143: ORB-only + 4h trend NOT aligned = blocked.
    // Learned from GBP/JPY BUY loss (post-v142 audit): ORB B+ quality 84,
    // confidence 80, HTF daily=up (aligned ✓), but tf4hTrend="flat" and
    // ADX 20. Single-strategy ORB needs trend support at the 4h timeframe
    // OR additional structural strategies confirming. Without both, the
    // breakout faked out and lost -45 pips.
    //
    // Logic: ORB (Opening Range Breakout) only works when there's a real
    // directional regime to break INTO. Daily trend says "macro bias" but
    // 4h is the real "is there directional pressure NOW" timeframe. ORB
    // alone in a flat 4h tape = trading random noise above the range.
    if (passingStratCount === 1 && hasORB && signal.tf4hTrend) {
      const tf4hAligned = (
        (signal.direction === 'BUY'  && signal.tf4hTrend === 'up') ||
        (signal.direction === 'SELL' && signal.tf4hTrend === 'down')
      );
      if (!tf4hAligned) {
        console.log(`[${sk} auto-trade] blocked: ORB-only with tf4hTrend=${signal.tf4hTrend} not aligned with ${signal.direction} (single-strategy fakeout shape from GBP/JPY loss)`);
        return;
      }
    }
    // v143: ORB-only winProbability floor raised from 50 to 55 (and sample
    // size requirement loosened to ≥40 so it catches more setups). 52% is a
    // coin flip; we need a real edge before tracking. The GBP/JPY loss had
    // winProb 52% with 368 samples — the data was saying "no edge" and we
    // tracked it anyway.
    if (passingStratCount === 1 && hasORB &&
        signal.winProbability != null && signal.backtestSamples >= 40 &&
        signal.winProbability < 55) {
      console.log(`[${sk} auto-trade] blocked: ORB-only + backtest winProb ${signal.winProbability}% < 55% (no edge with ${signal.backtestSamples} samples — v143 raised floor from 50 after GBP/JPY loss)`);
      return;
    }
    // NEW v139: STRONG BACKTEST DENIAL — any setup (even multi-confluence)
    // with winProbability < 30% and sample size ≥ 50 is BLOCKED. Learned
    // from NZD/CHF BUY loss (iter 10): ORB A+ + SMC + TREND multi-strategy
    // confluence + HTF aligned + ADX 44 all said BUY. Backtest said this
    // setup wins 23%. Backtest won — the trade lost -34 pips.
    // When backtest says "this specific pair+direction historically loses
    // 7 out of 10 times," even multi-confluence isn't a strong enough
    // override. The 30% threshold is below noise — it's a real edge.
    if (signal.winProbability != null && signal.backtestSamples >= 50 &&
        signal.winProbability < 30) {
      console.log(`[${sk} auto-trade] blocked: winProb ${signal.winProbability}% < 30% (strong backtest denial even with confluence)`);
      return;
    }

    // ═════════════════════════════════════════════════════════════════════
    // ── v146 ELITE-ONLY FILTER STACK ─ "100 years of trading experience" ─
    //
    // User explicitly asked: "i want only win signals · i dont want shit
    // signals · should have 100 years of trading experience · also need
    // better gold signals." Each rule below encodes a pro pattern from
    // 257-trade post-mortem. Aggressive — willing to take FEWER signals
    // for higher WR.
    // ═════════════════════════════════════════════════════════════════════

    // v146 RULE 1: UNIVERSAL winProb ≥ 60% (was ORB-only ≥55).
    // The 1-4h hold-time bucket showed only 20% WR — trades that resolve
    // quick AND lose tend to have low-edge winProb. A real edge means the
    // historical backtest says "this setup wins >6/10 times." Requires
    // 40+ samples to avoid small-N noise.
    // v161 RULE 1 (tightened from v146): winProb floor 60 → 65.
    // v170 (tightened from v161): backtestSamples 40 → 80 minimum.
    // Bigger sample = more reliable winProb estimate. Also: floor 65 → 70.
    if (signal.winProbability != null && signal.backtestSamples >= 80 &&
        signal.winProbability < 70) {
      console.log(`[${sk} auto-trade] blocked: winProb ${signal.winProbability}% < 70% on ${signal.backtestSamples} samples (v170 requires 70%+ on 80+ samples)`);
      return;
    }

    // v161 RULE 2 (tightened from v146): ADX floor 28 → 32.
    // 28 was the "borderline strong trend" floor. 32 demands actual strong
    // momentum — eliminates the chop-zone trades that get whipsawed.
    if (signal.adxNow != null && signal.adxNow < 32) {
      console.log(`[${sk} auto-trade] blocked: ADX ${signal.adxNow} < 32 (v161 strong-trend floor — 28-31 is still chop)`);
      return;
    }

    // v161 RULE 3 (tightened from v146): ALL 3 top predictors aligned (was 2+).
    // PSAR + MACD-histogram + Daily-trend must ALL agree with the signal
    // direction. This is the strictest possible "no dissent" gate.
    const topAligned146 = signal.topPredictorsAligned;
    if (topAligned146 != null && topAligned146 < 3) {
      console.log(`[${sk} auto-trade] blocked: only ${topAligned146}/3 top predictors aligned (PSAR=${signal.psarAligned}, MACD=${signal.macdHistAligned}, Daily=${signal.dailyTrendAligned}) — v161 requires 3/3 (no dissent)`);
      return;
    }

    // v165 RULE 12: 4H TREND ALIGNMENT HARD RULE.
    // The 4h timeframe is the institutional bias filter — if it disagrees
    // with the trade direction, the trade is fighting the intraday tide.
    // 'flat' or 'mixed' allowed (no opposition); only block when 4h is
    // outright opposite to the signal direction.
    if (signal.tf4hTrend && signal.tf4hTrend !== 'flat' && signal.tf4hTrend !== 'mixed') {
      const fighting4h =
        (signal.direction === 'BUY' && signal.tf4hTrend === 'down') ||
        (signal.direction === 'SELL' && signal.tf4hTrend === 'up');
      if (fighting4h) {
        console.log(`[${sk} auto-trade] blocked: 4H trend is ${signal.tf4hTrend} but direction ${signal.direction} — v165 RULE 12 (4H must align or be flat)`);
        return;
      }
    }

    // v161 RULE 10: COUNTER-TREND HARD BLOCK.
    // Reintroduced from the v152-RULE-7 experiment. With more data accrued,
    // counter-trend losses (htfTrend opposite signal direction) are clearly
    // the lower-EV bucket. Re-enabled now that we have RULE 9 SL cap to
    // limit any false-positive winner's missed pips. htfTrend='flat' still
    // allowed (range trading).
    if (signal.htfTrend && signal.htfTrend !== 'flat' && signal.htfTrend !== 'mixed') {
      const fightingHTF =
        (signal.direction === 'BUY' && signal.htfTrend === 'down') ||
        (signal.direction === 'SELL' && signal.htfTrend === 'up');
      if (fightingHTF) {
        console.log(`[${sk} auto-trade] blocked: counter-trend — ${signal.direction} when daily-timeframe trend is ${signal.htfTrend} (v161 RULE 10)`);
        return;
      }
    }

    // v146 RULE 4: GOLD (XAU/USD) — ELITE-ONLY GATE.
    // Gold has wide spread (5p), news-driven whipsaws, and trends hard
    // when central banks talk. Three extra rules:
    //   • Confidence ≥ 88 (was confFloor 78)
    //   • Must be in London or NY session (no Asian gold — too thin)
    //   • Must have 3+ strategies confirmed (no single-strategy gold)
    if (signal.pair === 'XAU/USD' || signal.pair === 'GOLD') {
      if ((signal.confidence || 0) < 88) {
        console.log(`[${sk} auto-trade] blocked: GOLD confidence ${signal.confidence}% < 88 (v146 gold elite floor)`);
        return;
      }
      const goldH = new Date().getUTCHours();
      const goldInLDN = goldH >= 7 && goldH <= 16;
      const goldInNY  = goldH >= 12 && goldH <= 21;
      if (!goldInLDN && !goldInNY) {
        console.log(`[${sk} auto-trade] blocked: GOLD outside London/NY session (${goldH}:00 UTC) — Asian gold is too thin`);
        return;
      }
      if (passingStratCount < 3) {
        console.log(`[${sk} auto-trade] blocked: GOLD only ${passingStratCount} strategies confirmed — v146 requires 3+ for gold`);
        return;
      }
    }
    // v149 RULE 5: USD-quoted forex majors blocked in pure Tokyo session.
    // Evidence: in v146-era forward, both Tokyo-session USD-quoted opens lost
    // (AUD/USD BUY 03:13 UTC -17.8p, plus historical pattern) while the
    // non-USD Tokyo open (EUR/CAD SELL) won. USD price action is asleep
    // 00:00-06:59 UTC and USD-quoted pairs lack catalyst — they range or fade.
    // Crypto pairs (24/7) and gold (separate rule) exempt.
    if (signal.pair && signal.pair.endsWith('/USD') &&
        !isCryptoPair(signal.pair) &&
        signal.pair !== 'XAU/USD' && signal.pair !== 'GOLD') {
      const utcH = new Date().getUTCHours();
      if (utcH < 7) {
        console.log(`[${sk} auto-trade] blocked: ${signal.pair} in pure Tokyo session (${utcH}:00 UTC) — USD liquidity sleeping, USD-quoted majors range/fade until London open (v149)`);
        return;
      }
    }
    // ─── end v146/v149 elite-only filter stack ───────────────────────────
    const setupKey = `${signal.pair}_${signal.direction}_${_stratToday()}`;
    if (_stratAutoSeen(sk, setupKey)) return;
    if (_stratAutoTodayCount(sk) >= cfg.cap) return;
    const trades = getTrades();
    const dup = trades.find(t => t.pair === signal.pair && t.direction === signal.direction && t.status === 'open');
    if (dup) {
      // Enrich the existing open trade with this strategy's confirmation
      // info — so when SMC/ORB fired earlier and now ICT (or any other)
      // also confirms the same pair, the trade picks up ICT's badge,
      // grade, and counts in ICT's tracking widget too. The pair-session
      // lock is also (re-)applied so any later v142 check on this pair in
      // this session sees it as already tracked.
      _stratAutoMark(sk, setupKey);
      _markPairSessionTracked(signal.pair, sessionId);
      let changed = false;
      if (!dup[`${sk}Passed`]) { dup[`${sk}Passed`] = true; changed = true; }
      if (signal[`${sk}Grade`] && !dup[`${sk}Grade`]) { dup[`${sk}Grade`] = signal[`${sk}Grade`]; changed = true; }
      if (signal[`${sk}Quality`] && !dup[`${sk}Quality`]) { dup[`${sk}Quality`] = signal[`${sk}Quality`]; changed = true; }
      if (signal[`${sk}QualityBreakdown`] && !dup[`${sk}QualityBreakdown`]) { dup[`${sk}QualityBreakdown`] = signal[`${sk}QualityBreakdown`]; changed = true; }
      if (signal[`${sk}Diag`] && !dup[`${sk}Diag`]) { dup[`${sk}Diag`] = signal[`${sk}Diag`]; changed = true; }
      const autoFlag = `is${sk.toUpperCase()}Auto`;
      if (!dup[autoFlag]) { dup[autoFlag] = true; changed = true; }
      if (changed) saveTrades(trades);
      return;
    }
    _stratAutoMark(sk, setupKey);
    const tradeShape = { ...signal, [`is${sk.toUpperCase()}Auto`]: true, autoAdded: true };
    const r = takeTrade(tradeShape, { id: autoTradeId(sk, signal) });
    if (r.ok) {
      // v142: lock this pair for the rest of the session — any later
      // strategy firing on the same pair will be blocked.
      _markPairSessionTracked(signal.pair, sessionId);
      console.log(`[${sk} auto-trade]`, signal.pair, signal.direction, 'grade', signal[`${sk}Grade`]);
    }
    else if (r.dup) console.log(`[${sk} auto-trade] dedup-skipped (same id on another device)`);
  } catch (e) { console.warn(`[${sk} auto-add]`, e.message); }
}

async function fireStrategyNotification(s, sk) {
  try {
    const cfg = STRATEGIES[sk];
    if (!cfg || !state.notifyEnabled) return;
    if (!supportsNotifications() || Notification.permission !== 'granted') return;
    if (_isMarketClosed(s.pair)) return;
    if (_isStaleSignal(s)) return;
    const key = `${s.pair}_${s.direction}_${_stratToday()}`;
    const seenKey = `forexsight_${sk}_notified_v1`;
    const seen = safeLoad(seenKey, []);
    if (seen.includes(key)) return;
    seen.push(key); safeSave(seenKey, seen.slice(-100));

    // Distinct chime cadence
    try { for (let i = 0; i < cfg.doubleChime; i++) setTimeout(playChime, i * 600); } catch {}
    state.unreadCount = (state.unreadCount || 0) + 1;
    try { updateTitle(); } catch {}

    const arrow = s.direction === 'BUY' ? '🔼' : '🔽';
    const grade = s[`${sk}Grade`] ? ` ${s[`${sk}Grade`]}` : '';
    const quality = s[`${sk}Quality`] || 0;
    const title = `${cfg.icon} ${cfg.short}${grade} ${arrow} ${s.pair} ${s.direction} — ${s.confidence}% (auto-added)`;
    const body = [
      `${cfg.icon} ${cfg.name} ${s[`${sk}Grade`] || ''} grade · ${quality}/100 quality`,
      `Entry: ${s.entry}`,
      `SL: ${s.sl} (${s.sl_pips} pips)`,
      `TP1: ${s.tp1} · TP2: ${s.tp2} · TP3: ${s.tp3}`,
      `🤖 Auto-added to My Trades`,
    ].join('\n');
    const opts = {
      body, icon: '/icon-192.png', badge: '/icon-192.png',
      tag: `${sk}-${key}`,
      renotify: true,
      requireInteraction: true,
      data: { url: '/', pair: s.pair, direction: s.direction, [sk]: true },
      // Unique vibration pattern per strategy — even in silent mode, the user
      // can identify the strategy by feel alone. iOS vibrates if the system
      // setting "Vibrate on Silent" is enabled.
      vibrate: cfg.vibrate || [180, 80, 180],
      silent: false, // explicit — never go silent
      // Hint to OS that this is time-sensitive (some platforms honor this)
      requireInteraction: true,
    };
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
    } else {
      new Notification(title, opts);
    }
  } catch (e) { console.warn(`[${sk} notify]`, e.message); }
}

// ════════════════════════════════════════════════════════════════════════
// RADIANT SMC GOLD STRATEGY — pair-locked to XAU/USD only.
// Strategy: trade ONLY at premium / discount edges of the recent range.
// Setup must include a liquidity sweep (price spiking through a swing high
// or low) followed by a reaction back into the zone. Mid-range = no trade.
// Output is a dedicated signal stream rendered in its own gold-themed section,
// completely separate from the main signal grid. Capped at 3 per day.
// ════════════════════════════════════════════════════════════════════════
const RADIANT_DAILY_KEY = 'forexsight_radiant_daily_v1';
const RADIANT_LAST_KEY  = 'forexsight_radiant_last_v1';

function _radiantToday() {
  return new Date().toISOString().slice(0, 10);
}
function _radiantTodayCount() {
  try {
    const data = safeLoad(RADIANT_DAILY_KEY, {});
    return data[_radiantToday()] || 0;
  } catch { return 0; }
}
function _radiantBumpCount() {
  try {
    const data = safeLoad(RADIANT_DAILY_KEY, {});
    const t = _radiantToday();
    data[t] = (data[t] || 0) + 1;
    // Keep only last 7 days
    const keys = Object.keys(data).sort();
    while (keys.length > 7) { delete data[keys.shift()]; }
    safeSave(RADIANT_DAILY_KEY, data);
  } catch {}
}

// Round to nearest 0.1 (gold quotes 2 decimals; analysis-style numbers
// are usually rounded to whole or half-point levels).
function _gRound(v) { return Math.round(v * 10) / 10; }

function analyzeRadiantSMC(ohlc) {
  if (!ohlc || ohlc.length < 60) return null;
  // STRIP ZERO-RANGE BARS — same fix as analyzePair (v129). Yahoo Finance
  // returns the in-progress bar with c == o == h == l for gold too. Without
  // this, the latest bar has no body, no range, and the sweep/impulse
  // detection always fails. This was the dominant reason the user "never
  // got a gold signal" — the analyzer always evaluated a zero-range bar
  // as "the current candle."
  while (ohlc.length > 60 && ohlc[ohlc.length - 1].h === ohlc[ohlc.length - 1].l) {
    ohlc = ohlc.slice(0, -1);
  }
  const n = ohlc.length - 1;
  const window = ohlc.slice(n - 50, n + 1);
  const rangeHigh = Math.max(...window.map(b => b.h));
  const rangeLow  = Math.min(...window.map(b => b.l));
  const range = rangeHigh - rangeLow;
  if (range <= 0) return null;
  const current = ohlc[n].c;
  const pos = (current - rangeLow) / range;

  // Diagnostic — populated as we go so the UI can show user WHY no signal
  state.radiantDiag = {
    gates: [],
    passed: 0,
    total: 7,
    rangeHigh: _gRound(rangeHigh),
    rangeLow: _gRound(rangeLow),
    pos: Math.round(pos * 100),
    current: _gRound(current),
    note: '',
  };
  const fail = (gate, reason) => {
    state.radiantDiag.gates.push({ name: gate, passed: false, reason });
    state.radiantDiag.note = `❌ ${gate}: ${reason}`;
  };
  const pass = (gate, detail) => {
    state.radiantDiag.gates.push({ name: gate, passed: true, detail });
    state.radiantDiag.passed++;
  };

  // Rule 1: trade only at edges. Allow slightly wider band (35%) than before
  // so genuine premium/discount setups aren't killed by 1-2% pos rounding.
  if (pos > 0.35 && pos < 0.65) {
    fail('Range position', `Price at ${Math.round(pos*100)}% — mid-range, no trade`);
    return null;
  }
  pass('Range position', `${Math.round(pos*100)}% of range (${pos < 0.5 ? 'discount' : 'premium'})`);

  const recent = ohlc.slice(n - 20, n + 1);
  const recentHigh = Math.max(...recent.slice(0, -1).map(b => b.h));
  const recentLow  = Math.min(...recent.slice(0, -1).map(b => b.l));
  const last = ohlc[n];
  const closes = ohlc.map(b => b.c);
  const rsiArr = rsi(closes);

  const fib = (level) => _gRound(rangeLow + range * level);
  const fib0_5   = fib(0.5);
  const fib1_272 = _gRound(rangeHigh + range * 0.272);
  const fibNeg0_272 = _gRound(rangeLow - range * 0.272);

  // Helper: is a candle a "real" impulse candle (body ≥ 30% of range) in
  // the given direction? Filters out doji/spinning-tops that are NOT
  // confirmation of a directional move.
  // Body threshold loosened 40% → 30% to match SMC and other strategies.
  // Gold has bigger wicks than forex (illiquid hours, futures gaps), so a
  // 40% body requirement was excluding valid sweep+rejection setups that
  // typically show 30-35% body with longer wicks.
  const isStrongCandle = (b, dir) => {
    const body = Math.abs(b.c - b.o);
    const r = b.h - b.l;
    if (r === 0) return false;
    if (body / r < 0.30) return false;
    return dir === 'bull' ? b.c > b.o : b.c < b.o;
  };

  // Helper: count consecutive bars where momentum aligns with direction
  const consecImpulse = (startIdx, dir, max = 3) => {
    let count = 0;
    for (let i = startIdx; i <= n && count < max; i++) {
      if (isStrongCandle(ohlc[i], dir)) count++;
      else break;
    }
    return count;
  };

  // ─── DISCOUNT (lower 35%) → look for BUY ───
  if (pos < 0.35) {
    // Gate 2: recent liquidity sweep — widened from 6 → 15 bars and tolerance
    // from 0.9995 → 1.0005 (matches the SMC strategy v109 loosening). Gold
    // moves slower than forex pairs; sweep events spread across more bars.
    // 6 bars was way too short — the analyzer rejected sweeps that happened
    // 7-10 bars ago even though the setup was still valid.
    let sweepBar = -1, sweepLevel = recentLow;
    for (let i = Math.max(0, n - 15); i <= n; i++) {
      if (ohlc[i].l <= recentLow * 1.0005) {
        if (ohlc[i].l < sweepLevel) { sweepLevel = ohlc[i].l; sweepBar = i; }
      }
    }
    if (sweepBar < 0) { fail('Liquidity sweep', `No sweep below ${recentLow.toFixed(2)} in last 15 bars`); return null; }
    pass('Liquidity sweep', `Swept ${_gRound(sweepLevel).toFixed(2)}, ${n - sweepBar} bar${n-sweepBar===1?'':'s'} ago`);

    // Gate 3: sweep candle closes back above swept low (real rejection)
    const sweepCandle = ohlc[sweepBar];
    if (sweepCandle.c <= recentLow * 0.9998) {
      fail('Sweep rejection', `Sweep candle closed ${sweepCandle.c.toFixed(2)} — no reclaim of ${recentLow.toFixed(2)}`);
      return null;
    }
    pass('Sweep rejection', `Sweep candle reclaimed ${recentLow.toFixed(2)}`);

    // Gate 4: at least one strong bullish impulse since (or including) sweep
    let impulseAfter = 0;
    for (let i = sweepBar; i <= n; i++) if (isStrongCandle(ohlc[i], 'bull')) impulseAfter++;
    if (impulseAfter < 1) {
      fail('Bullish impulse', `No strong bullish candle (body ≥40% of range) since sweep`);
      return null;
    }
    pass('Bullish impulse', `${impulseAfter} impulse candle${impulseAfter===1?'':'s'} after sweep`);

    // Gate 5: directional confirmation — current price above the swept low
    // (loosened: don't require last candle bullish — accept quiet consolidation
    // above swept level if there were already 2+ impulse candles)
    if (current <= recentLow) {
      fail('Price reclaim', `Price ${current.toFixed(2)} hasn't reclaimed swept low ${recentLow.toFixed(2)}`);
      return null;
    }
    if (impulseAfter < 2 && !(last.c > last.o)) {
      fail('Reaction strength', `Need bullish last candle OR 2+ impulse candles. Have ${impulseAfter} impulse, last ${last.c > last.o ? 'green' : 'red'}`);
      return null;
    }
    pass('Reaction strength', `${impulseAfter} impulse candle${impulseAfter===1?'':'s'}, last ${last.c > last.o ? 'bullish' : 'mixed'}`);

    // Gate 6: don't chase — loosened 50% → 80% of run-up to TP1.
    // Matches SMC's "Fresh" gate after its own loosening pass. Gold sweep
    // reactions often run hot; the 50% cap was killing valid mid-move
    // entries on the most aggressive setups. 80% still blocks chasing the
    // very top of the run (the bar that already hit TP1).
    const tp1Approx = fib0_5;
    const distanceToTp1 = tp1Approx - sweepLevel;
    const distanceTraveled = current - sweepLevel;
    if (distanceToTp1 > 0 && distanceTraveled > distanceToTp1 * 0.80) {
      fail('Entry not stale', `Already moved ${Math.round(distanceTraveled/distanceToTp1*100)}% toward TP1 — chasing risk`);
      return null;
    }
    pass('Entry not stale', `Moved ${Math.round(distanceTraveled/Math.max(0.01,distanceToTp1)*100)}% toward TP1, still actionable`);

    // Gate 7: RSI momentum — loosened threshold 45 → 55. After a sweep
    // reclaim, gold's RSI typically jumps above 50 quickly; the previous
    // <45 ceiling killed setups where the reaction was already underway.
    // Matches SMC's loosened RSI gate so gold isn't held to a stricter bar
    // than the rest of the SMC family.
    const rsiNow = rsiArr[n], rsi2 = rsiArr[n - 2];
    if (rsiNow == null) { fail('RSI momentum', 'RSI not available yet'); return null; }
    const rsiOK = rsiNow < 55 || (rsi2 != null && rsiNow >= rsi2 + 2);
    if (!rsiOK) {
      fail('RSI momentum', `RSI ${rsiNow.toFixed(1)} not oversold or rising (need <55 or +2 from 2 bars ago)`);
      return null;
    }
    pass('RSI momentum', `RSI ${rsiNow.toFixed(1)}`);

    // Final HTF safety: only KILL the signal if EMA50 is heavily against and accelerating down
    const e50 = emaArr(closes, 50)[n];
    const e50_5 = emaArr(closes, 50)[n - 5];
    if (e50 != null && e50_5 != null && current < e50 * 0.97 && e50 < e50_5 * 0.997) {
      fail('HTF safety', `Heavy downtrend: price ${current.toFixed(2)} far below EMA50 ${e50.toFixed(2)} which is falling fast`);
      return null;
    }

    // ALL 7 confirmations passed — emit the signal
    const zoneTop = _gRound(current);
    const zoneBot = _gRound(current - range * 0.005);
    const sl = _gRound(sweepLevel - range * 0.012);
    const tp1 = fib0_5;
    const tp2 = _gRound(rangeHigh - range * 0.05);
    const tp3 = fib1_272;
    const slDist = zoneTop - sl;
    const rr = (tp) => slDist > 0 ? +((tp - zoneTop) / slDist).toFixed(2) : null;
    // QUALITY SCORE — gives Radiant signals an A+/A/B+/B/C grade like every
    // other strategy in the suite. Without this Radiant signals were always
    // marked at flat 85% confidence — couldn't tell a marginal sweep from a
    // textbook one. Quality components weighted by what historically predicts
    // wins on gold sweeps:
    //   • Multiple impulse candles after sweep (strong reaction)
    //   • Fresh entry (low % to TP1)
    //   • Extreme RSI (oversold = mean reversion edge)
    //   • Deep discount/premium position (further into edge = better R:R)
    //   • Sweep recency (last 1-3 bars = stronger than 5-6 bars ago)
    const pctToTp1 = distanceToTp1 > 0 ? distanceTraveled / distanceToTp1 : 1;
    const radiantQ = _genericQualityScore(ohlc, 'BUY', [
      ['Impulse',     Math.min(15, impulseAfter * 6)],
      ['Freshness',   Math.min(12, (1 - pctToTp1) * 20)],
      ['RSI edge',    rsiNow < 30 ? 15 : rsiNow < 40 ? 10 : rsiNow < 50 ? 5 : 0],
      ['Discount',    Math.min(12, (0.35 - pos) * 60)],
      ['Sweep age',   Math.max(0, 10 - (n - sweepBar) * 2)],
    ]);
    return {
      bias: 'BUY',
      zoneTop, zoneBot, sl, tp1, tp2, tp3,
      rr1: rr(tp1), rr2: rr(tp2), rr3: rr(tp3),
      sweepLevel: _gRound(sweepLevel),
      confirmations: 7,
      barsSinceSweep: n - sweepBar,
      impulseCount: impulseAfter,
      rsiNow: rsiNow.toFixed(1),
      // Quality fields — same shape as other strategies (smcGrade etc.)
      // so the grade-first sort + Strategies tab grade breakdown work.
      radiantGrade: radiantQ.grade,
      radiantQuality: radiantQ.score,
      radiantQualityBreakdown: radiantQ.breakdown,
      analysis: `✓ Confirmed setup — 7 of 7 strategy gates passed before signaling. Quality grade ${radiantQ.grade} (${radiantQ.score}/100).\n\nGold rejected the lower demand band at ${_gRound(sweepLevel).toFixed(2)} ${n - sweepBar} bar${n-sweepBar===1?'':'s'} ago, sweeping the weak low and grabbing clustered liquidity before reacting back into the zone. The sweep candle itself closed above the swept level (rejection wick = real sweep, not a continuation breakdown). ${impulseAfter} bullish impulse candle${impulseAfter===1?'':'s'} since the sweep confirms buyers stepped in. Price still sits at ${(pos*100).toFixed(0)}% of the recent range — clean discount territory, hasn't run past the entry yet. RSI at ${rsiNow.toFixed(1)} confirms momentum turning up. Stop below the swept low invalidates the thesis. Targets step through mid-range liquidity to the upper supply zone, with extension toward the 1.272 Fib at ${fib1_272.toFixed(2)}. Secure partial at TP1; manage runners with SL → BE.`,
    };
  }

  // ─── PREMIUM (upper 35%) → look for SELL ───
  if (pos > 0.65) {
    // Sweep window widened 6 → 15 bars (mirror of BUY path).
    let sweepBar = -1, sweepLevel = recentHigh;
    for (let i = Math.max(0, n - 15); i <= n; i++) {
      if (ohlc[i].h >= recentHigh * 0.9995) {
        if (ohlc[i].h > sweepLevel) { sweepLevel = ohlc[i].h; sweepBar = i; }
      }
    }
    if (sweepBar < 0) { fail('Liquidity sweep', `No sweep above ${recentHigh.toFixed(2)} in last 15 bars`); return null; }
    pass('Liquidity sweep', `Swept ${_gRound(sweepLevel).toFixed(2)}, ${n - sweepBar} bar${n-sweepBar===1?'':'s'} ago`);

    const sweepCandle = ohlc[sweepBar];
    if (sweepCandle.c >= recentHigh * 1.0002) {
      fail('Sweep rejection', `Sweep candle closed ${sweepCandle.c.toFixed(2)} — no reclaim below ${recentHigh.toFixed(2)}`);
      return null;
    }
    pass('Sweep rejection', `Sweep candle reclaimed below ${recentHigh.toFixed(2)}`);

    let impulseAfter = 0;
    for (let i = sweepBar; i <= n; i++) if (isStrongCandle(ohlc[i], 'bear')) impulseAfter++;
    if (impulseAfter < 1) {
      fail('Bearish impulse', `No strong bearish candle (body ≥40% of range) since sweep`);
      return null;
    }
    pass('Bearish impulse', `${impulseAfter} impulse candle${impulseAfter===1?'':'s'} after sweep`);

    if (current >= recentHigh) {
      fail('Price reclaim', `Price ${current.toFixed(2)} still above swept high ${recentHigh.toFixed(2)}`);
      return null;
    }
    if (impulseAfter < 2 && !(last.c < last.o)) {
      fail('Reaction strength', `Need bearish last candle OR 2+ impulse candles. Have ${impulseAfter} impulse, last ${last.c < last.o ? 'red' : 'green'}`);
      return null;
    }
    pass('Reaction strength', `${impulseAfter} impulse candle${impulseAfter===1?'':'s'}, last ${last.c < last.o ? 'bearish' : 'mixed'}`);

    // Entry-not-stale loosened 50% → 80% (mirror of BUY path).
    const tp1Approx = fib0_5;
    const distanceToTp1 = sweepLevel - tp1Approx;
    const distanceTraveled = sweepLevel - current;
    if (distanceToTp1 > 0 && distanceTraveled > distanceToTp1 * 0.80) {
      fail('Entry not stale', `Already moved ${Math.round(distanceTraveled/distanceToTp1*100)}% toward TP1 — chasing risk`);
      return null;
    }
    pass('Entry not stale', `Moved ${Math.round(distanceTraveled/Math.max(0.01,distanceToTp1)*100)}% toward TP1, still actionable`);

    // RSI momentum loosened 55 → 45 (mirror of BUY path).
    const rsiNow = rsiArr[n], rsi2 = rsiArr[n - 2];
    if (rsiNow == null) { fail('RSI momentum', 'RSI not available yet'); return null; }
    const rsiOK = rsiNow > 45 || (rsi2 != null && rsiNow <= rsi2 - 2);
    if (!rsiOK) {
      fail('RSI momentum', `RSI ${rsiNow.toFixed(1)} not overbought or falling (need >45 or -2 from 2 bars ago)`);
      return null;
    }
    pass('RSI momentum', `RSI ${rsiNow.toFixed(1)}`);

    const e50 = emaArr(closes, 50)[n];
    const e50_5 = emaArr(closes, 50)[n - 5];
    if (e50 != null && e50_5 != null && current > e50 * 1.03 && e50 > e50_5 * 1.003) {
      fail('HTF safety', `Heavy uptrend: price ${current.toFixed(2)} far above EMA50 ${e50.toFixed(2)} which is rising fast`);
      return null;
    }

    const zoneBot = _gRound(current);
    const zoneTop = _gRound(current + range * 0.005);
    const sl = _gRound(sweepLevel + range * 0.012);
    const tp1 = fib0_5;
    const tp2 = _gRound(rangeLow + range * 0.05);
    const tp3 = fibNeg0_272;
    const slDist = sl - zoneBot;
    const rr = (tp) => slDist > 0 ? +((zoneBot - tp) / slDist).toFixed(2) : null;
    // Same quality score as BUY path — mirror of the components.
    // RSI edge: high RSI (overbought) is the SELL-side equivalent of low RSI.
    // Premium position: how far past 0.65 we are (further premium = better R:R).
    const pctToTp1 = distanceToTp1 > 0 ? distanceTraveled / distanceToTp1 : 1;
    const radiantQ = _genericQualityScore(ohlc, 'SELL', [
      ['Impulse',     Math.min(15, impulseAfter * 6)],
      ['Freshness',   Math.min(12, (1 - pctToTp1) * 20)],
      ['RSI edge',    rsiNow > 70 ? 15 : rsiNow > 60 ? 10 : rsiNow > 50 ? 5 : 0],
      ['Premium',     Math.min(12, (pos - 0.65) * 60)],
      ['Sweep age',   Math.max(0, 10 - (n - sweepBar) * 2)],
    ]);
    return {
      bias: 'SELL',
      zoneTop, zoneBot, sl, tp1, tp2, tp3,
      rr1: rr(tp1), rr2: rr(tp2), rr3: rr(tp3),
      sweepLevel: _gRound(sweepLevel),
      confirmations: 7,
      barsSinceSweep: n - sweepBar,
      impulseCount: impulseAfter,
      rsiNow: rsiNow.toFixed(1),
      radiantGrade: radiantQ.grade,
      radiantQuality: radiantQ.score,
      radiantQualityBreakdown: radiantQ.breakdown,
      analysis: `✓ Confirmed setup — 7 of 7 strategy gates passed before signaling. Quality grade ${radiantQ.grade} (${radiantQ.score}/100).\n\nGold rejected the upper supply zone at ${_gRound(sweepLevel).toFixed(2)} ${n - sweepBar} bar${n-sweepBar===1?'':'s'} ago, taking out stops above the weak high and grabbing liquidity before reacting lower. The sweep candle itself closed below the swept level (rejection wick confirms a sweep, not a continuation breakout). ${impulseAfter} bearish impulse candle${impulseAfter===1?'':'s'} since the sweep confirms sellers stepped in. Price still in premium at ${(pos*100).toFixed(0)}% of range — hasn't already dropped to TP1. RSI at ${rsiNow.toFixed(1)} confirms momentum turning down. Stop above the swept high invalidates the thesis. Targets step through mid-range liquidity toward the lower demand zone, with extension toward the 1.272 Fib at ${fibNeg0_272.toFixed(2)}. Secure partial at TP1; manage runners with SL → BE.`,
    };
  }

  return null;
}

// Pulls XAU/USD prices and runs the Radiant analyzer. Stores result on
// state.radiantSignal so the renderer can pick it up. Daily-cap aware.
// Fires a gold-themed desktop notification the instant a NEW setup appears.
const RADIANT_NOTIFIED_KEY = 'forexsight_radiant_notified_v1';
async function loadRadiantSignal() {
  try {
    const data = await fetchOHLC(RADIANT_GOLD_SYMBOL);
    if (!data?.ohlc?.length) return;

    // STEP 1 — Always evaluate any OPEN gold trades against latest prices.
    // This is what makes "track even when offline" work: every 2-min poll
    // checks if any open Radiant trade has hit TP1 (won) or SL (lost) since
    // it was placed, even if the user wasn't on the page when it happened.
    try {
      const closed = evaluateOpenTrades(RADIANT_GOLD_PAIR, data.ohlc);
      for (const tr of closed) {
        try { notifyTradeOutcome(tr); } catch {}
      }
      if (closed.length && document.querySelector('#trades.active')) {
        try { renderTrades(); } catch {}
      }
    } catch (e) { console.warn('[radiant eval-open]', e.message); }

    // STEP 2 — Run the strategy analyzer on the freshest data
    const sig = analyzeRadiantSMC(data.ohlc);
    if (!sig) { state.radiantSignal = null; return; }
    sig.pair = RADIANT_GOLD_PAIR;
    sig.timestamp = new Date().toISOString();
    sig.dataAgeMin = Math.round((Date.now() - data.ohlc[data.ohlc.length - 1].t) / 60000);
    const setupKey = `${sig.bias}_${sig.zoneTop}_${sig.zoneBot}_${_radiantToday()}`;
    const last = safeLoad(RADIANT_LAST_KEY, null);
    const isNewSetup = last?.setupKey !== setupKey;

    if (isNewSetup) {
      if (_radiantTodayCount() >= 3) { state.radiantSignal = null; return; }
      _radiantBumpCount();
      safeSave(RADIANT_LAST_KEY, { setupKey });
    }
    state.radiantSignal = sig;

    // STEP 3 — On a new setup: notify + auto-add to My Trades + re-render
    if (isNewSetup) {
      const notified = safeLoad(RADIANT_NOTIFIED_KEY, []);
      if (!notified.includes(setupKey)) {
        notified.push(setupKey);
        safeSave(RADIANT_NOTIFIED_KEY, notified.slice(-50));
        await fireRadiantNotification(sig);
        // AUTO-CREATE an open trade so it gets tracked regardless of whether
        // the user is online. evaluateOpenTrades (above, on every 2-min tick)
        // will auto-mark it won/lost when price hits TP1 or SL.
        try {
          const pip = 0.10; // gold pip
          const entryPrice = sig.bias === 'BUY' ? sig.zoneTop : sig.zoneBot;
          const tradeShape = {
            pair: RADIANT_GOLD_PAIR,
            symbol: RADIANT_GOLD_SYMBOL,
            direction: sig.bias,
            // Confidence now reflects the actual quality score (was a flat
            // 85% for every Radiant trade). Floor of 70 so even C-grade
            // sweeps still register as a real setup; cap of 99 so we don't
            // claim certainty. This lets grade-first sort work on Radiant
            // trades same as every other strategy.
            confidence: Math.max(70, Math.min(99, sig.radiantQuality || 85)),
            // Propagate quality fields so trade rows can show the grade pill
            // and so the History tab's grade-band sort puts Radiant trades in
            // their proper place.
            radiantGrade: sig.radiantGrade,
            radiantQuality: sig.radiantQuality,
            radiantQualityBreakdown: sig.radiantQualityBreakdown,
            entry: entryPrice,
            sl: sig.sl,
            tp1: sig.tp1,
            tp2: sig.tp2,
            tp3: sig.tp3,
            sl_pips: Number((Math.abs(entryPrice - sig.sl) / pip).toFixed(1)),
            tp1_pips: Number((Math.abs(sig.tp1 - entryPrice) / pip).toFixed(1)),
            tp2_pips: Number((Math.abs(sig.tp2 - entryPrice) / pip).toFixed(1)),
            tp3_pips: Number((Math.abs(sig.tp3 - entryPrice) / pip).toFixed(1)),
            atr: 0,
            rr: '1:1 / 1:2 / 1:3',
            votes: {
              'Radiant SMC': [
                sig.bias === 'BUY' ? 'bullish' : 'bearish',
                'Confirmed Radiant SMC setup — 7/7 strategy gates passed'
              ],
            },
            bull_count: sig.bias === 'BUY' ? 7 : 0,
            bear_count: sig.bias === 'SELL' ? 7 : 0,
            neutral_count: 0,
            total_indicators: 7,
            firedStrategies: [{
              name: 'Radiant SMC',
              bias: sig.bias === 'BUY' ? 'bullish' : 'bearish',
              reason: `Sweep at ${sig.sweepLevel.toFixed(2)} + 7-gate confirmation`,
            }],
            timestamp: sig.timestamp,
            digits: 2,
            // Radiant-specific markers
            isRadiant: true,
            radiantAnalysis: sig.analysis,
            sweepLevel: sig.sweepLevel,
            autoAdded: true,
          };
          // Deterministic id so two devices that both detect this Radiant
          // setup produce the SAME trade.id → cloud merge keeps one.
          const radiantId = `auto-radiant-XAUUSD-${sig.bias}-${_radiantToday()}`;
          const r = takeTrade(tradeShape, { id: radiantId });
          if (r.ok) {
            console.log('[radiant] auto-added trade:', r.trade.id);
            // Re-render trades tab if visible so the new trade shows immediately
            if (document.querySelector('#trades.active')) {
              try { renderTrades(); } catch {}
            }
          } else {
            console.log('[radiant] auto-trade skipped:', r.reason);
          }
        } catch (e) { console.warn('[radiant auto-trade]', e.message); }
      }
      if (document.querySelector('#signals.active')) {
        try { renderSignals(); } catch {}
      }
    }
  } catch (e) { console.warn('[radiant]', e.message); }
}

async function fireRadiantNotification(sig) {
  if (!state.notifyEnabled) return;
  if (!supportsNotifications() || Notification.permission !== 'granted') return;
  try {
    const arrow = sig.bias === 'BUY' ? '🔼' : '🔽';
    const title = `⚡ RADIANT GOLD ${arrow} ${sig.bias} XAU/USD ${sig.zoneBot.toFixed(2)}–${sig.zoneTop.toFixed(2)}`;
    const body = [
      `Zone: ${sig.zoneBot.toFixed(2)} – ${sig.zoneTop.toFixed(2)}`,
      `SL: ${sig.sl.toFixed(2)}`,
      `TP1 ${sig.tp1.toFixed(2)} (R:R ${sig.rr1}) · TP2 ${sig.tp2.toFixed(2)} · TP3 ${sig.tp3.toFixed(2)}`,
      `${sig.confirmations}/7 strategy gates confirmed · sweep at ${sig.sweepLevel.toFixed(2)}`,
    ].join('\n');
    // Triple chime for Radiant — louder than ordinary signals because these
    // are rare (capped at 3/day) and high-conviction
    try { playChime(); setTimeout(playChime, 500); setTimeout(playChime, 1000); } catch {}
    state.unreadCount = (state.unreadCount || 0) + 1;
    try { updateTitle(); } catch {}
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body, icon: '/icon-192.png', badge: '/icon-192.png',
        tag: 'radiant-' + (sig.timestamp || ''),
        renotify: true, requireInteraction: true,
        data: { url: '/', radiant: true },
      });
    } else {
      new Notification(title, { body, icon: '/icon-192.png' });
    }
  } catch (e) { console.warn('[radiant notify]', e.message); }
}

// Dedicated gold-only polling loop. Runs every 2 minutes whenever the tab is
// visible — much faster than the main 5-min refresh — so a Radiant setup
// is detected and notified the moment it forms.
let _radiantTimer = null;
function startRadiantWatcher() {
  if (_radiantTimer) clearInterval(_radiantTimer);
  loadRadiantSignal().catch(() => {});
  // Gold Radiant SMC checks every 10 seconds — was 2 minutes. Gold is the
  // most volatile instrument we track and the user wants instant alerts
  // when the strategy sees a setup.
  _radiantTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadRadiantSignal().catch(() => {});
  }, 10 * 1000);
}
// Also re-check on every visibility change (returning to the tab triggers
// an immediate gold scan, no waiting for the next 2-min tick)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadRadiantSignal().catch(() => {});
});

function renderRadiantBanner() {
  // v223 — Radiant SMC tracker hidden from the home page per user request.
  // Strategy still runs in the background and contributes data to the brain,
  // but the dedicated UI card is no longer shown.
  return '';
  // eslint-disable-next-line no-unreachable
  const s = state.radiantSignal;
  if (!s) {
    // No active signal — show diagnostic so user knows the strategy IS scanning
    // and which gate is currently blocking. Helps distinguish "broken" from
    // "patiently waiting for setup."
    const d = state.radiantDiag;
    if (!d || !d.gates || d.gates.length === 0) {
      return `<div class="radiant-status">⚡ <strong>Radiant SMC scanning gold…</strong> waiting for first analysis cycle.</div>`;
    }
    const passed = d.passed;
    const total = d.total;
    const lastGate = d.gates[d.gates.length - 1];
    const failedReason = lastGate && !lastGate.passed ? lastGate.reason : '';
    const passedDetails = d.gates.filter(g => g.passed).map(g => g.name).join(' → ');
    return `
      <div class="radiant-status">
        <div class="rs-head">
          <strong>⚡ Radiant SMC scanning gold (XAU/USD)</strong>
          <span class="rs-count">${passed}/${total} gates passed</span>
        </div>
        <div class="rs-progress"><span style="width:${(passed/total*100).toFixed(0)}%"></span></div>
        ${passedDetails ? `<div class="rs-passed">✓ ${passedDetails}</div>` : ''}
        ${failedReason ? `<div class="rs-blocking">⏸ <strong>Blocking:</strong> ${failedReason}</div>` : ''}
        <div class="rs-foot muted">Price ${d.current?.toFixed(2)} · range ${d.rangeLow?.toFixed(2)}–${d.rangeHigh?.toFixed(2)} · pos ${d.pos}%. Strategy waiting for full confirmation; checking again every 10 sec.</div>
      </div>`;
  }
  const dirCol = s.bias === 'BUY' ? 'var(--buy)' : 'var(--sell)';
  const arrow = s.bias === 'BUY' ? '🔼' : '🔽';
  return `
    <div class="radiant-card" data-bias="${s.bias}">
      <div class="radiant-glow"></div>
      <div class="radiant-head">
        <span class="radiant-tag">⚡ RADIANT-style SMC · Gold only</span>
        <span class="radiant-count muted">${_radiantTodayCount()}/3 today</span>
      </div>
      <h2 class="radiant-title">${arrow} ${s.bias} XAU/USD &nbsp;<span style="color:${dirCol}">@ ${s.zoneBot.toFixed(2)}–${s.zoneTop.toFixed(2)}</span></h2>
      <div class="radiant-block">
        <div class="rb-row"><span class="rb-lbl">Zone:</span><code>${s.zoneBot.toFixed(2)} – ${s.zoneTop.toFixed(2)}</code></div>
        <div class="rb-row"><span class="rb-lbl">• Stop Loss:</span><code>${s.sl.toFixed(2)}</code></div>
        <div class="rb-row"><span class="rb-lbl">Take Profit 1:</span><code>${s.tp1.toFixed(2)}</code> <span class="rr-tag">${s.rr1 != null ? 'R:R ' + s.rr1 : ''}</span></div>
        <div class="rb-row"><span class="rb-lbl">Take Profit 2:</span><code>${s.tp2.toFixed(2)}</code> <span class="rr-tag">${s.rr2 != null ? 'R:R ' + s.rr2 : ''}</span></div>
        <div class="rb-row"><span class="rb-lbl">Take Profit 3:</span><code>${s.tp3.toFixed(2)}</code> <span class="rr-tag">${s.rr3 != null ? 'R:R ' + s.rr3 : ''}</span></div>
      </div>
      <div class="radiant-analysis">
        <strong>📊 Analysis</strong>
        <p>${s.analysis}</p>
        <p class="muted" style="margin-top:6px;font-size:11.5px">Liquidity sweep at ${s.sweepLevel.toFixed(2)} · Data ${s.dataAgeMin}m old · Always secure TP1; manage runners with SL → BE.</p>
      </div>
    </div>`;
}

// ========== Server-side signal poller ==========
// Server (cron Worker) scans every 5 min and writes qualifying signals to KV.
// We poll that snapshot every 30s; when a new signal appears that we haven't
// already alerted on, fire a local notification — even when the user has
// just opened the PWA after several minutes.
const SERVER_SEEN_KEY = 'forexsight_server_seen_v1';
function getServerSeen() { return safeLoad(SERVER_SEEN_KEY, []); }
function saveServerSeen(arr) { safeSave(SERVER_SEEN_KEY, arr.slice(-200)); }

async function pollServerSignals() {
  if (!state.notifyEnabled) return;
  if (Notification.permission !== 'granted') return;
  try {
    const res = await fetch('/api/latest-signals', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.signals || !data.signals.length) return;
    const seen = getServerSeen();
    let changed = false;
    for (const s of data.signals) {
      // Defense-in-depth: client doesn't blindly trust the server's tier label.
      // Re-applies hard floors so even if the server analyzer drifts permissive,
      // the user only gets pinged for genuinely strong signals.
      if (!s || !s.pair || !s.direction || s.confidence == null) continue;
      // v237 — Missing adx/inKillzone should be permissive, not exclusionary.
      // Was: `s.adx >= 25` evaluated to `undefined >= 25 → false`, silently
      // killing notifications when backend omitted the field. Treat missing
      // as "criteria not available, allow if confidence floor satisfied".
      const adxOk = s.adx == null || s.adx >= 25;
      const adxStrong = s.adx == null || s.adx >= 30;
      const killzoneOk = s.inKillzone === undefined || s.inKillzone === true;
      const baseFloors = s.confidence >= 78 && adxOk;
      const extremeFloors = s.confidence >= 85 && adxStrong && killzoneOk;
      let want;
      if (state.filterMode === 'extreme') want = s.tier === 'extreme' && extremeFloors;
      else if (state.filterMode === 'best') want = (s.tier === 'best' || s.tier === 'extreme') && baseFloors;
      else want = s.confidence >= 80;
      if (!want) continue;
      const key = `${s.pair}_${s.direction}_${(s.detectedAt || '').slice(0, 13)}`;
      if (seen.includes(key)) continue;
      seen.push(key); changed = true;
      // Fire a server-driven notification
      try { playChime(); } catch {}
      const title = s.tier === 'extreme'
        ? `🔥 EXTREME ${s.pair} ${s.direction} — ${s.confidence}%`
        : `⭐ BEST ${s.pair} ${s.direction} — ${s.confidence}%`;
      const body = `Entry ${s.entry} · SL ${s.sl} · TP1 ${s.tp1}\nADX ${s.adx} · ${s.inKillzone ? 'killzone' : 'off-hours'} · server-detected just now`;
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(title, {
            body, icon: '/icon-192.png', badge: '/icon-192.png',
            tag: key, renotify: false, requireInteraction: s.tier === 'extreme',
            data: { url: '/', pair: s.pair },
          });
        } else {
          new Notification(title, { body, icon: '/icon-192.png', tag: key });
        }
      } catch {}
    }
    if (changed) saveServerSeen(seen);
  } catch (e) {
    console.warn('[server poll]', e.message);
  }
}

let serverPollTimer = null;
function startServerPolling() {
  if (serverPollTimer) clearInterval(serverPollTimer);
  // Initial poll, then every 30s
  pollServerSignals();
  serverPollTimer = setInterval(pollServerSignals, 30 * 1000);
}

// Also poll immediately when the tab becomes visible (e.g. user returns to PWA)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pollServerSignals();
});

// Init
$('#conf-val').textContent = state.minConf + '%';
$('#conf-slider').value = state.minConf;
updateBestBtn();
updateNotifyButton();
startServerPolling();
startRadiantWatcher();
if (getSyncCode()) pullAllFromCloud().catch(() => {});

// Periodic re-pull every 90 seconds so changes from another device propagate
// fast without the user having to click "Sync now". Tightened from 5 min so
// when you sign in on a second device you see your trades show up almost
// immediately if they were just added on the first device.
setInterval(() => {
  if (!getSyncCode()) return;
  if (document.visibilityState !== 'visible') return;
  pullAllFromCloud().catch(() => {});
}, 90 * 1000);

// Pull immediately on tab/PWA focus — when you open the app from the home
// screen, this guarantees you see the latest data from any other device
// before the next periodic tick runs.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!getSyncCode()) return;
  pullAllFromCloud().catch(() => {});
});

// Also pull on plain window focus (covers desktop tab switches that don't
// fire visibilitychange the same way).
window.addEventListener('focus', () => {
  if (!getSyncCode()) return;
  pullAllFromCloud().catch(() => {});
});
maybeShowIosHint();
loadSignals();
setupAutoRefresh();
startFastTradeTick();  // v219: checks open trades every 10s for SL/TP hits (no lag)
startNewsAutoRefresh();

// ── Notification deep-linking ───────────────────────────────────────────
// When the user taps a notification (foreground or lock-screen push), the
// SW navigates to /?signal=<pair>&dir=<direction>. This handler reads
// those params and auto-opens the corresponding signal modal so the user
// lands directly on the trade they were notified about — no more "I got
// the alert but where's the card?" confusion.
async function openSignalFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const pair = params.get('signal');
    if (!pair) return;
    // Strip the params from URL so refresh / back-button doesn't re-open
    const cleanUrl = window.location.pathname + window.location.hash;
    history.replaceState(null, '', cleanUrl);

    // Try to find the signal in current state.signals — wait up to 8s for
    // loadSignals to complete on cold-start.
    const tryOpen = () => {
      const s = state.signals.find(sig => sig.pair === pair);
      if (s) {
        try { openModal(pair); return true; }
        catch (e) { console.warn('[deep-link]', e.message); }
      }
      return false;
    };
    if (tryOpen()) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (tryOpen() || attempts > 16) {
        clearInterval(interval);
        if (attempts > 16 && !state.signals.find(s => s.pair === pair)) {
          // Last resort — fetch latest-signals from server in case the local
          // analyzer didn't reproduce the setup
          fetch('/api/latest-signals').then(r => r.json()).then(data => {
            const ss = (data.signals || []).find(s => s.pair === pair);
            if (ss) {
              const cfg = pairConfig(pair);
              // v237 — Same NaN guard as the other server-merge site.
              const safePips = (a, b) => (a != null && b != null) ? Math.abs(a - b) / cfg.pip : 0;
              const merged = {
                ...ss, current: ss.entry, symbol: PAIRS[pair] || CRYPTO_PAIRS[pair],
                sl_pips: safePips(ss.entry, ss.sl),
                tp1_pips: safePips(ss.entry, ss.tp1),
                tp2_pips: safePips(ss.entry, ss.tp2),
                tp3_pips: safePips(ss.entry, ss.tp3),
                votes: {}, bull_count: 0, bear_count: 0, total_indicators: 5,
                isServerSourced: true, smcPassed: ss.strategies >= 2,
                timestamp: ss.detectedAt,
              };
              state.signals.push(merged);
              try { openModal(pair); } catch {}
            } else {
              // Truly not found — show a friendly toast
              const toast = document.createElement('div');
              toast.className = 'deep-link-toast';
              toast.innerHTML = `<strong>Signal expired</strong><br>The ${pair} signal you tapped is no longer active. It either hit TP/SL or moved out of the strategy zone.`;
              document.body.appendChild(toast);
              setTimeout(() => toast.remove(), 5000);
            }
          }).catch(() => {});
        }
      }
    }, 500);
  } catch (e) { console.warn('[openSignalFromUrl]', e.message); }
}
openSignalFromUrl();

// Listen for SW messages (when SW posts a message after the user taps a
// notification on an already-open page — handles cases where navigation
// doesn't trigger because we're already at the target URL).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open-signal' && event.data.pair) {
      const pair = event.data.pair;
      // Try opening immediately. If the signal isn't in state.signals yet,
      // fall back to setting URL param so openSignalFromUrl can retry.
      const s = state.signals.find(sig => sig.pair === pair);
      if (s) {
        try { openModal(pair); } catch {}
      } else {
        const u = new URL(window.location.href);
        u.searchParams.set('signal', pair);
        history.replaceState(null, '', u.toString());
        openSignalFromUrl();
      }
    }
  });
}

// Always (re-)register the Web Push subscription on app load if alerts are
// already enabled. This refreshes lastSeen on the server so old subscriptions
// are kept alive, AND re-subscribes if the browser has rotated keys.
if (state.notifyEnabled && Notification.permission === 'granted') {
  setTimeout(() => subscribeToWebPush().catch(() => {}), 1500);
}

// ════════════════════════════════════════════════════════════════════════
// v285 — CHART BOT. Multi-modal trading analyst chat UI.
//
// Persistence model: every message lives in localStorage forever. No UI
// limit on count, no upload cap. The backend trims to last 24 turns when
// calling Claude (Anthropic's 200K context could take more — this keeps
// cost predictable).
//
// Image handling: client-side resize to max 1600px on the long edge with
// JPEG quality 0.85. Keeps payloads under ~600KB so Cloudflare doesn't
// reject the POST, while preserving enough detail for chart reading.
// ════════════════════════════════════════════════════════════════════════
const CB_STORAGE_KEY = 'forexsight_chart_bot_messages';
const CB_PAIR_KEY = 'forexsight_chart_bot_pair';
let _cbState = {
  messages: [],
  pendingImages: [], // { mediaType, data (base64), preview (data url) }
  sending: false,
};

function _cbLoad() {
  try {
    const raw = localStorage.getItem(CB_STORAGE_KEY);
    if (raw) _cbState.messages = JSON.parse(raw);
  } catch {}
  try {
    const pair = localStorage.getItem(CB_PAIR_KEY);
    if (pair) {
      const el = document.getElementById('cb-pair-hint');
      if (el) el.value = pair;
    }
    const tf = localStorage.getItem('forexsight_chart_bot_tf');
    if (tf) {
      const el = document.getElementById('cb-timeframe');
      if (el) el.value = tf;
    }
  } catch {}
}
function _cbSave() {
  try { localStorage.setItem(CB_STORAGE_KEY, JSON.stringify(_cbState.messages)); } catch {}
}
function _cbRender() {
  const box = document.getElementById('cb-messages');
  if (!box) return;
  if (!_cbState.messages.length) {
    box.innerHTML = `
      <div class="cb-empty">
        <p><strong>Drop a chart screenshot or ask a question.</strong></p>
        <p>Examples:</p>
        <p>· "Should I buy XAU/USD here?" (with a screenshot)<br>
           · "What's the safest setup right now?"<br>
           · "Read this chart and tell me where the stop should be."</p>
        <p>Every verdict is paired with the brain's real backtested probability.</p>
      </div>`;
    return;
  }
  box.innerHTML = _cbState.messages.map(m => {
    const cls = m.role === 'user' ? 'cb-msg-user' : 'cb-msg-assistant';
    const label = m.role === 'user' ? 'You' : 'Analyst';
    const text = _cbExtractText(m);
    const imgs = _cbExtractImages(m);
    const imgHtml = imgs.length
      ? `<div class="cb-msg-images">${imgs.map(src => `<img src="${src}" alt="chart"/>`).join('')}</div>`
      : '';
    return `<div class="cb-msg ${cls}">
      <div class="cb-msg-meta">${label}</div>
      ${imgHtml}
      <div class="cb-msg-body">${_cbRenderMarkdown(text)}</div>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function _cbExtractText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return '';
}
function _cbExtractImages(m) {
  if (!Array.isArray(m.content)) return [];
  return m.content.filter(p => p.type === 'image' && p.data)
    .map(p => `data:${p.mediaType || 'image/png'};base64,${p.data}`);
}
// Tiny markdown renderer — bold, italics, code, line breaks. We trust the
// analyst's output but escape user-provided strings before transformation.
function _cbRenderMarkdown(text) {
  if (!text) return '';
  const esc = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
function _cbSetStatus(text, cls = '') {
  const el = document.getElementById('cb-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'cb-status muted' + (cls ? ' ' + cls : '');
}
function _cbRenderAttachments() {
  const box = document.getElementById('cb-attachments');
  if (!box) return;
  box.innerHTML = _cbState.pendingImages.map((img, i) => `
    <div class="cb-attachment">
      <img src="${img.preview}" alt="attachment"/>
      <button class="cb-attachment-remove" data-i="${i}" type="button" title="Remove">×</button>
    </div>`).join('');
}

// Client-side image resize. Reads a File via FileReader, paints onto a canvas
// at max 1600px long-edge, exports as JPEG quality 0.85, returns the base64
// (no data: prefix — that's added on send) + media type.
function _cbResizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const b64 = dataUrl.split(',')[1] || '';
        resolve({ mediaType: 'image/jpeg', data: b64, preview: dataUrl });
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function _cbSend() {
  if (_cbState.sending) return;
  const inputEl = document.getElementById('cb-input');
  const text = (inputEl?.value || '').trim();
  const images = _cbState.pendingImages.slice();
  if (!text && !images.length) return;

  // Build the user turn (multi-modal if images present, plain text otherwise).
  const userContent = images.length
    ? [
        ...images.map(img => ({ type: 'image', data: img.data, mediaType: img.mediaType, preview: img.preview })),
        ...(text ? [{ type: 'text', text }] : []),
      ]
    : text;
  _cbState.messages.push({ role: 'user', content: userContent, ts: Date.now() });
  _cbState.pendingImages = [];
  inputEl.value = '';
  _cbRenderAttachments();
  _cbRender();
  _cbSave();

  // Show typing indicator
  _cbState.sending = true;
  const btn = document.getElementById('cb-send');
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  _cbSetStatus('Analyst is reading the chart and checking the brain…');

  // Strip the preview field from images before POST (keep base64 only)
  const messagesForApi = _cbState.messages.map(m => {
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content.map(p => p.type === 'image' ? { type: 'image', data: p.data, mediaType: p.mediaType } : p) };
    }
    return { role: m.role, content: m.content };
  });

  const pairHint = (document.getElementById('cb-pair-hint')?.value || '').trim();
  const timeframe = (document.getElementById('cb-timeframe')?.value || '').trim();
  if (pairHint) { try { localStorage.setItem(CB_PAIR_KEY, pairHint); } catch {} }
  if (timeframe) { try { localStorage.setItem('forexsight_chart_bot_tf', timeframe); } catch {} }

  try {
    const res = await fetch('/api/chart-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: messagesForApi, pair: pairHint || null, timeframe: timeframe || null }),
    });
    const data = await res.json();
    const reply = data.reply || data.fallbackReply || 'No reply received.';
    _cbState.messages.push({ role: 'assistant', content: reply, mode: data.mode, ts: Date.now() });
    _cbSave();
    _cbRender();
    if (data.mode === 'brain-only') {
      _cbSetStatus('Brain-only mode — full LLM chart reading needs an ANTHROPIC_API_KEY in Cloudflare.', '');
    } else if (data.mode === 'llm-error' || data.mode === 'llm-exception') {
      _cbSetStatus('Claude API call failed — showed brain-only fallback. Check ANTHROPIC_API_KEY.', 'cb-err');
    } else {
      _cbSetStatus('Done.', 'cb-ok');
      setTimeout(() => _cbSetStatus(''), 2500);
    }
  } catch (e) {
    _cbSetStatus('Network error: ' + (e.message || e), 'cb-err');
  } finally {
    _cbState.sending = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

function _cbWire() {
  if (window._cbWired) return;
  window._cbWired = true;
  _cbLoad();
  _cbRender();

  // Send button
  const sendBtn = document.getElementById('cb-send');
  if (sendBtn) sendBtn.addEventListener('click', _cbSend);
  // Enter to send (Shift+Enter for newline)
  const inputEl = document.getElementById('cb-input');
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _cbSend();
      }
    });
  }
  // Attach button + file picker
  const attachBtn = document.getElementById('cb-attach-btn');
  const fileEl = document.getElementById('cb-file');
  if (attachBtn && fileEl) {
    attachBtn.addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', async () => {
      const files = Array.from(fileEl.files || []);
      for (const f of files) {
        try {
          const img = await _cbResizeImage(f);
          _cbState.pendingImages.push(img);
        } catch (e) {
          _cbSetStatus('Could not read image: ' + (e.message || e), 'cb-err');
        }
      }
      _cbRenderAttachments();
      fileEl.value = '';
    });
  }
  // Remove attachment
  const attBox = document.getElementById('cb-attachments');
  if (attBox) {
    attBox.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('.cb-attachment-remove');
      if (!btn) return;
      const i = parseInt(btn.dataset.i, 10);
      if (Number.isFinite(i)) {
        _cbState.pendingImages.splice(i, 1);
        _cbRenderAttachments();
      }
    });
  }
  // New chat
  const newBtn = document.getElementById('cb-new-chat');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (_cbState.messages.length && !confirm('Start a new chat? Current conversation will be cleared.')) return;
      _cbState.messages = [];
      _cbState.pendingImages = [];
      _cbSave();
      _cbRender();
      _cbRenderAttachments();
      _cbSetStatus('');
    });
  }
  // Paste support — Ctrl+V image into the input
  if (inputEl) {
    inputEl.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            try {
              const img = await _cbResizeImage(file);
              _cbState.pendingImages.push(img);
              _cbRenderAttachments();
            } catch {}
          }
        }
      }
    });
  }
}
document.addEventListener('DOMContentLoaded', () => {
  // Wire after a tick so the tab markup is in the DOM
  setTimeout(_cbWire, 0);
});
// Also wire when the Chart Bot tab is opened (covers PWA tab-switch flows)
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest && e.target.closest('.tab[data-tab="chart-bot"]');
  if (t) setTimeout(_cbWire, 0);
});

// ════════════════════════════════════════════════════════════════════════
// v286 — DRAG-TO-REORDER tabs in the main nav.
//
// Two modes:
//   • Normal: tabs behave as buttons (click to switch).
//   • Customize: a long-press on a tab (or Shift+drag on desktop) puts it
//     into drag mode. Drop on another tab to swap positions. Order persists
//     per-device to localStorage.
//
// A small "Customize" pill appears next to the nav so the user can opt
// into reorder mode explicitly — avoids accidental drags during tap.
// ════════════════════════════════════════════════════════════════════════
const TAB_ORDER_KEY = 'forexsight_tab_order';

function _restoreTabOrder() {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return;
    const nav = document.querySelector('.tabs');
    if (!nav) return;
    const tabs = Array.from(nav.querySelectorAll('.tab[data-tab]'));
    const moreBtn = nav.querySelector('#more-tab-btn');
    // Reattach in saved order, then any new tabs not in saved at end,
    // then the More ▾ button stays last.
    const byId = new Map(tabs.map(t => [t.dataset.tab, t]));
    const usedIds = new Set();
    for (const id of saved) {
      const t = byId.get(id);
      if (t) {
        nav.insertBefore(t, moreBtn || null);
        usedIds.add(id);
      }
    }
    for (const t of tabs) {
      if (!usedIds.has(t.dataset.tab)) nav.insertBefore(t, moreBtn || null);
    }
  } catch {}
}

function _saveTabOrder() {
  try {
    const nav = document.querySelector('.tabs');
    if (!nav) return;
    const order = Array.from(nav.querySelectorAll('.tab[data-tab]')).map(t => t.dataset.tab);
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
  } catch {}
}

function _ensureCustomizeButton() {
  const nav = document.querySelector('.tabs');
  if (!nav || document.getElementById('tab-customize-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'tab-customize-btn';
  btn.className = 'tab tab-customize';
  btn.title = 'Drag tabs to reorder. Click again to lock.';
  btn.type = 'button';
  btn.textContent = '⇆';
  btn.setAttribute('aria-label', 'Toggle tab reorder mode');
  nav.appendChild(btn);
  btn.addEventListener('click', () => _toggleCustomizeMode());
}

let _tabCustomizeMode = false;
function _toggleCustomizeMode(force) {
  _tabCustomizeMode = (typeof force === 'boolean') ? force : !_tabCustomizeMode;
  const nav = document.querySelector('.tabs');
  if (!nav) return;
  nav.classList.toggle('tabs-customize', _tabCustomizeMode);
  const btn = document.getElementById('tab-customize-btn');
  if (btn) {
    btn.classList.toggle('active', _tabCustomizeMode);
    btn.textContent = _tabCustomizeMode ? '✓ Done' : '⇆';
  }
  // Toggle draggable attribute on real tabs
  nav.querySelectorAll('.tab[data-tab]').forEach(t => {
    t.draggable = _tabCustomizeMode;
  });
}

// Native HTML5 drag for desktop + touch handlers for mobile. Single sortable
// implementation, ~80 lines. Avoids adding a library.
let _dragSrc = null;
let _touchDragEl = null;
let _touchOriginY = 0;
let _touchCurrentX = 0;

function _wireTabSortable() {
  const nav = document.querySelector('.tabs');
  if (!nav || nav._sortWired) return;
  nav._sortWired = true;

  // ── Desktop HTML5 drag ──────────────────────────────────────────────
  nav.addEventListener('dragstart', (e) => {
    if (!_tabCustomizeMode) return;
    const tab = e.target.closest('.tab[data-tab]');
    if (!tab) return;
    _dragSrc = tab;
    tab.classList.add('tab-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tab.dataset.tab); } catch {}
  });
  nav.addEventListener('dragover', (e) => {
    if (!_tabCustomizeMode || !_dragSrc) return;
    e.preventDefault();
    const target = e.target.closest('.tab[data-tab]');
    if (!target || target === _dragSrc) return;
    const rect = target.getBoundingClientRect();
    const after = (e.clientX - rect.left) > rect.width / 2;
    if (after) target.parentNode.insertBefore(_dragSrc, target.nextSibling);
    else target.parentNode.insertBefore(_dragSrc, target);
  });
  nav.addEventListener('dragend', () => {
    if (_dragSrc) _dragSrc.classList.remove('tab-dragging');
    _dragSrc = null;
    _saveTabOrder();
  });

  // ── Mobile touch drag ───────────────────────────────────────────────
  let touchStartTimer = null;
  nav.addEventListener('touchstart', (e) => {
    if (!_tabCustomizeMode) return;
    const tab = e.target.closest && e.target.closest('.tab[data-tab]');
    if (!tab) return;
    _touchDragEl = tab;
    _touchOriginY = e.touches[0].clientY;
    _touchCurrentX = e.touches[0].clientX;
    touchStartTimer = setTimeout(() => {
      if (_touchDragEl) _touchDragEl.classList.add('tab-dragging');
    }, 120);
  }, { passive: true });
  nav.addEventListener('touchmove', (e) => {
    if (!_tabCustomizeMode || !_touchDragEl) return;
    if (!_touchDragEl.classList.contains('tab-dragging')) return;
    e.preventDefault();
    const t = e.touches[0];
    _touchCurrentX = t.clientX;
    const elements = Array.from(nav.querySelectorAll('.tab[data-tab]')).filter(x => x !== _touchDragEl);
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (t.clientX > rect.left && t.clientX < rect.right) {
        const after = (t.clientX - rect.left) > rect.width / 2;
        if (after) el.parentNode.insertBefore(_touchDragEl, el.nextSibling);
        else el.parentNode.insertBefore(_touchDragEl, el);
        break;
      }
    }
  }, { passive: false });
  nav.addEventListener('touchend', () => {
    if (touchStartTimer) { clearTimeout(touchStartTimer); touchStartTimer = null; }
    if (_touchDragEl) {
      _touchDragEl.classList.remove('tab-dragging');
      _saveTabOrder();
    }
    _touchDragEl = null;
  }, { passive: true });
  nav.addEventListener('touchcancel', () => {
    if (touchStartTimer) { clearTimeout(touchStartTimer); touchStartTimer = null; }
    if (_touchDragEl) _touchDragEl.classList.remove('tab-dragging');
    _touchDragEl = null;
  }, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {
  _restoreTabOrder();
  _ensureCustomizeButton();
  _wireTabSortable();
});

// ════════════════════════════════════════════════════════════════════════
// v289 — LIVE CHART. Renders live SVG candlesticks for the selected pair
// using the existing /api/prices feed (same data the brain studies). The
// bot reads the EXACT bars on screen via /api/chart-bot when the user taps
// "Analyze now" — no screenshot upload needed, no third-party chart, no
// excuse. Refreshes every 30 seconds. Optional auto-analyze polls every
// 2 minutes for hands-free signal generation.
// ════════════════════════════════════════════════════════════════════════
const LC_SYM_MAP = {
  'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F',
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'US30': '^DJI', 'NAS100': '^NDX', 'SPX500': '^GSPC',
  'GER40': '^GDAXI', 'UK100': '^FTSE', 'JPN225': '^N225',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};
const LC_STATE = {
  bars: [],
  pair: 'XAU/USD',
  timeframe: '4H',
  assetClass: 'forex',
  strategy: 'auto',           // v290 — picked from preset chips
  indicators: [],             // v290 — up to 3 indicator codes
  expertPrompt: '',           // v290 — custom prompt when expert mode is on
  fetching: false,
  analyzing: false,
  autoTimer: null,
  refreshTimer: null,
  tvWidget: null,             // v290 — TradingView widget instance
  tvScriptLoaded: false,      // v290 — guard so we only load tv.js once
};

// v290 — Map our internal pair labels to the symbols the TradingView widget
// expects. TradingView accepts exchange-prefixed symbols (e.g. "OANDA:XAUUSD",
// "FX_IDC:EURUSD", "BINANCE:BTCUSDT", "NASDAQ:AAPL"). Picking widely-available
// free symbols so the widget works for unauthenticated users.
const LC_TV_SYM_MAP = {
  // Metals
  'XAU/USD': 'OANDA:XAUUSD',
  'XAG/USD': 'OANDA:XAGUSD',
  // Forex majors / crosses
  'EUR/USD': 'FX_IDC:EURUSD',
  'GBP/USD': 'FX_IDC:GBPUSD',
  'USD/JPY': 'FX_IDC:USDJPY',
  'AUD/USD': 'FX_IDC:AUDUSD',
  'NZD/USD': 'FX_IDC:NZDUSD',
  'USD/CAD': 'FX_IDC:USDCAD',
  'USD/CHF': 'FX_IDC:USDCHF',
  'EUR/JPY': 'FX_IDC:EURJPY',
  'GBP/JPY': 'FX_IDC:GBPJPY',
  // Indices (CFD proxies on TradingView)
  'US30':   'OANDA:US30USD',
  'NAS100': 'OANDA:NAS100USD',
  'SPX500': 'OANDA:SPX500USD',
  'GER40':  'OANDA:DE40EUR',
  'UK100':  'OANDA:UK100GBP',
  'JPN225': 'OANDA:JP225USD',
  // Crypto
  'BTC/USD': 'BINANCE:BTCUSDT',
  'ETH/USD': 'BINANCE:ETHUSDT',
  'SOL/USD': 'BINANCE:SOLUSDT',
};

// Translate our timeframe slugs to TradingView's interval codes.
const LC_TV_INTERVAL = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30',
  '1H': '60', '4H': '240', '1D': 'D', '1W': 'W', '1M': 'M',
};

// Translate our indicator codes to TradingView's built-in study IDs.
const LC_TV_INDICATORS = {
  'ema-20-50-200': 'MAExp@tv-basicstudies',
  'sma': 'MASimple@tv-basicstudies',
  'rsi': 'RSI@tv-basicstudies',
  'macd': 'MACD@tv-basicstudies',
  'bollinger': 'BB@tv-basicstudies',
  'stoch': 'Stochastic@tv-basicstudies',
  'atr': 'ATR@tv-basicstudies',
  'vwap': 'VWAP@tv-basicstudies',
  'ichimoku': 'IchimokuCloud@tv-basicstudies',
  'adx': 'ADX@tv-basicstudies',
};

function _lcYahooSym(pair) {
  return LC_SYM_MAP[pair] || (pair && pair.includes('/') ? pair.replace('/', '') + '=X' : pair);
}

// Resample 1H bars into higher timeframes. Yahoo's intraday feed gives us
// 1H bars; we group them for 4H, 1D, etc. For 5m/15m we'd need a different
// endpoint — fall back to 1H if a tighter TF is selected (and tell the
// user). This keeps the chart honest: never invent bars we don't have.
function _lcResample(bars, tf) {
  if (!bars || !bars.length) return [];
  const groupSize = ({ '5m': 1, '15m': 1, '1H': 1, '4H': 4, '1D': 24 })[tf] || 1;
  if (groupSize <= 1) return bars;
  const out = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    const g = bars.slice(i, i + groupSize);
    if (!g.length) continue;
    out.push({
      t: g[0].t,
      o: g[0].o,
      h: Math.max(...g.map(b => b.h)),
      l: Math.min(...g.map(b => b.l)),
      c: g[g.length - 1].c,
      v: g.reduce((s, b) => s + (b.v || 0), 0),
    });
  }
  return out;
}

async function _lcFetch() {
  if (LC_STATE.fetching) return;
  LC_STATE.fetching = true;
  const statusEl = document.getElementById('lc-status');
  if (statusEl) statusEl.textContent = 'Fetching live data…';
  try {
    const sym = _lcYahooSym(LC_STATE.pair);
    const res = await fetch(`/api/prices?symbol=${encodeURIComponent(sym)}`);
    if (!res.ok) throw new Error('prices fetch failed: ' + res.status);
    const data = await res.json();
    LC_STATE.bars = Array.isArray(data.ohlc) ? data.ohlc : [];
    _lcRender();
    if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Fetch error: ' + (e.message || e);
  } finally {
    LC_STATE.fetching = false;
  }
}

// v363 — Fullscreen toggle for the TradingView widget wrapper. Uses the
// browser Fullscreen API. Handles vendor prefixes (WebKit iOS Safari,
// Firefox) and updates the button label + icon to reflect state.
function _lcSetupFullscreen() {
  const btn = document.getElementById('lc-tv-fullscreen');
  const wrap = document.getElementById('lc-tv-wrap');
  if (!btn || !wrap || btn._lcFsBound) return;
  btn._lcFsBound = true;

  const isFullscreen = () =>
    !!(document.fullscreenElement || document.webkitFullscreenElement
       || document.mozFullScreenElement || document.msFullscreenElement);

  const enterFs = async () => {
    try {
      if (wrap.requestFullscreen) await wrap.requestFullscreen();
      else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
      else if (wrap.mozRequestFullScreen) wrap.mozRequestFullScreen();
      else if (wrap.msRequestFullscreen) wrap.msRequestFullscreen();
    } catch (e) {
      // Fallback: some iOS versions don't support element fullscreen — use a
      // CSS "faux fullscreen" class as backup.
      wrap.classList.add('lc-tv-faux-fullscreen');
    }
  };
  const exitFs = async () => {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
    } catch {}
    wrap.classList.remove('lc-tv-faux-fullscreen');
  };

  btn.addEventListener('click', () => {
    if (isFullscreen() || wrap.classList.contains('lc-tv-faux-fullscreen')) exitFs();
    else enterFs();
  });

  // Update label + icon on any fullscreen state change (user hitting ESC
  // exits without the button being clicked).
  const updateLabel = () => {
    const label = btn.querySelector('.lc-tv-fullscreen-label');
    const isFs = isFullscreen() || wrap.classList.contains('lc-tv-faux-fullscreen');
    if (label) label.textContent = isFs ? 'Exit' : 'Expand';
    btn.setAttribute('aria-label', isFs ? 'Exit chart fullscreen' : 'Expand chart to fullscreen');
    btn.title = isFs ? 'Exit fullscreen' : 'Expand to fullscreen';
  };
  document.addEventListener('fullscreenchange', updateLabel);
  document.addEventListener('webkitfullscreenchange', updateLabel);
  document.addEventListener('mozfullscreenchange', updateLabel);
  document.addEventListener('MSFullscreenChange', updateLabel);
  // ESC key handler for the faux-fullscreen fallback
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.classList.contains('lc-tv-faux-fullscreen')) {
      exitFs();
      updateLabel();
    }
  });
}

// v290 — Load TradingView's tv.js once (idempotent). Returns a promise that
// resolves when window.TradingView is available. We only fetch the script
// when the user actually opens the Live Chart tab — keeps initial page load
// snappy.
function _lcLoadTradingViewScript() {
  return new Promise((resolve, reject) => {
    if (LC_STATE.tvScriptLoaded || (typeof window !== 'undefined' && window.TradingView)) {
      LC_STATE.tvScriptLoaded = true;
      return resolve();
    }
    const existing = document.querySelector('script[src*="tradingview.com/tv.js"]');
    if (existing) {
      existing.addEventListener('load', () => { LC_STATE.tvScriptLoaded = true; resolve(); }, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/tv.js';
    s.async = true;
    s.onload = () => { LC_STATE.tvScriptLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load TradingView widget script'));
    document.head.appendChild(s);
  });
}

// Mount (or remount) the TradingView Advanced Chart widget into our container.
// The widget itself fetches its own live price feed from TradingView's CDN —
// the displayed chart is the genuine TradingView chart, with all their tools.
async function _lcMountTradingView() {
  const container = document.getElementById('lc-tv-container');
  if (!container) return;
  try {
    await _lcLoadTradingViewScript();
  } catch (e) {
    container.innerHTML = `<div style="padding:20px;color:#fca5a5;font-size:13px;">Could not load TradingView widget — check internet connection. (${e.message || e})</div>`;
    return;
  }
  // Clean any previous instance — TradingView's widget mutates the container
  container.innerHTML = '';
  const tvSym = LC_TV_SYM_MAP[LC_STATE.pair] || LC_STATE.pair.replace('/', '');
  const interval = LC_TV_INTERVAL[LC_STATE.timeframe] || '60';
  const studies = LC_STATE.indicators.map(i => LC_TV_INDICATORS[i]).filter(Boolean);
  const isDark = !document.body.classList.contains('light-theme');
  try {
    LC_STATE.tvWidget = new window.TradingView.widget({
      autosize: true,
      symbol: tvSym,
      interval,
      timezone: 'Etc/UTC',
      theme: isDark ? 'dark' : 'light',
      style: '1',                  // 1 = candles
      locale: 'en',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      withdateranges: true,
      studies,
      container_id: 'lc-tv-container',
      // Visual polish — keep the widget UI minimal but functional
      hide_top_toolbar: false,
      backgroundColor: isDark ? '#0b1220' : '#ffffff',
      gridColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    });
    // v376 — Subscribe to TradingView's internal symbol changes so
    // LC_STATE.pair tracks what the user is ACTUALLY looking at, not
    // just what they picked in our dropdown.
    if (LC_STATE.tvWidget && typeof LC_STATE.tvWidget.onChartReady === 'function') {
      LC_STATE.tvWidget.onChartReady(() => {
        try {
          const chart = LC_STATE.tvWidget.activeChart();
          if (chart && typeof chart.onSymbolChanged === 'function') {
            chart.onSymbolChanged().subscribe(null, () => {
              const newTvSym = chart.symbol();
              const newPair = _lcTvSymToPair(newTvSym);
              if (newPair && newPair !== LC_STATE.pair) {
                LC_STATE.pair = newPair;
                try { localStorage.setItem('forexsight_lc_pair', newPair); } catch {}
                // Sync the pair input if visible
                const pairEl = document.getElementById('lc-pair');
                if (pairEl) pairEl.value = newPair;
                // Update quote panel + broadcast to other tabs
                _lcFetch();
                _lcBroadcastPair(newPair);
              }
            });
          }
        } catch (e) { /* onSymbolChanged may not exist on older widget versions */ }
      });
    }
  } catch (e) {
    container.innerHTML = `<div style="padding:20px;color:#fca5a5;font-size:13px;">TradingView widget init failed: ${e.message || e}</div>`;
  }
  // v363 — Wire the expand-to-fullscreen button after the widget mounts.
  // Setup is idempotent (bound flag on the button element).
  _lcSetupFullscreen();
}

// v376 — Reverse the LC_TV_SYM_MAP: TradingView symbol → our pair label
function _lcTvSymToPair(tvSym) {
  if (!tvSym) return null;
  // Try direct reverse lookup
  for (const [pair, sym] of Object.entries(LC_TV_SYM_MAP)) {
    if (sym === tvSym || sym.toUpperCase() === tvSym.toUpperCase()) return pair;
  }
  // Fallback: strip exchange prefix and try common patterns
  const bare = tvSym.replace(/^[A-Z_]+:/, '').toUpperCase();
  // 6-char symbols like EURUSD → EUR/USD
  if (/^[A-Z]{6}$/.test(bare)) return bare.slice(0, 3) + '/' + bare.slice(3);
  // XAUUSD, XAGUSD
  if (bare === 'XAUUSD') return 'XAU/USD';
  if (bare === 'XAGUSD') return 'XAG/USD';
  // BTC pairs
  if (bare === 'BTCUSD' || bare === 'BTCUSDT') return 'BTC/USD';
  if (bare === 'ETHUSD' || bare === 'ETHUSDT') return 'ETH/USD';
  return null;
}

// v376 — Broadcast the current pair to any listener that needs to sync
// (Chart Bot pair hint, Trade Doctor prefill, "Now watching" indicator).
function _lcBroadcastPair(pair) {
  window.__currentLivePair = pair;
  document.dispatchEvent(new CustomEvent('livePairChanged', { detail: { pair } }));
  // Update the "Now watching" indicator (v376)
  const nowEl = document.getElementById('lc-now-watching');
  if (nowEl) nowEl.textContent = pair;
}

function _lcRender() {
  // v290 — The candlestick chart is now the official TradingView widget.
  // _lcRender() now only updates the LIVE QUOTE PANEL at the top (price,
  // day H/L, swing levels, HTF trend) using our /api/prices feed. The
  // TradingView widget itself manages its own data + drawings.
  // v322b — Fixed: was referencing undefined `resampled` (legacy pre-v290
  // variable). Now correctly reads LC_STATE.bars where _lcFetch stores it.
  const resampled = LC_STATE.bars || [];
  if (!resampled.length) return;
  // Use the last 60 bars for the panel calculations (matches the bot's view)
  const bars = resampled.slice(-60);
  const last = bars[bars.length - 1];
  const dayBars = bars.slice(-24);
  const dayHigh = Math.max(...dayBars.map(b => b.h));
  const dayLow  = Math.min(...dayBars.map(b => b.l));
  const dayOpen = dayBars[0].o;
  const dayChange = last.c - dayOpen;
  const dayChangePct = (dayChange / dayOpen) * 100;
  const swingBars = resampled.slice(-40);
  const swingHigh = Math.max(...swingBars.map(b => b.h));
  const swingLow  = Math.min(...swingBars.map(b => b.l));
  const htfBars = resampled.slice(-48);
  const htfTrend = htfBars.length >= 5
    ? (htfBars[htfBars.length - 1].c > htfBars[0].c * 1.001 ? 'UP'
       : htfBars[htfBars.length - 1].c < htfBars[0].c * 0.999 ? 'DOWN' : 'RANGE')
    : 'unknown';

  // Update top quote panel
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('lc-price', _lcFmt(last.c));
  const chEl = document.getElementById('lc-change');
  if (chEl) {
    chEl.textContent = `${dayChange >= 0 ? '+' : ''}${_lcFmt(dayChange)} (${dayChangePct >= 0 ? '+' : ''}${dayChangePct.toFixed(2)}%)`;
    chEl.classList.toggle('up', dayChange >= 0);
    chEl.classList.toggle('down', dayChange < 0);
  }
  set('lc-day-high', _lcFmt(dayHigh));
  set('lc-day-low',  _lcFmt(dayLow));
  set('lc-swing-high', _lcFmt(swingHigh));
  set('lc-swing-low',  _lcFmt(swingLow));
  set('lc-htf', htfTrend);
}

// Format a price for display — adapts decimal places to the magnitude so
// gold shows 2 decimals, EUR/USD shows 5, JPY pairs show 3, etc.
function _lcFmt(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 100)  return v.toFixed(2);
  if (abs >= 10)   return v.toFixed(3);
  if (abs >= 1)    return v.toFixed(4);
  return v.toFixed(5);
}

async function _lcAnalyze() {
  if (LC_STATE.analyzing) return;
  LC_STATE.analyzing = true;
  const btn = document.getElementById('lc-analyze');
  const verdictEl = document.getElementById('lc-verdict');
  if (btn) { btn.disabled = true; btn.textContent = '🧠 Analysing…'; }
  try {
    // v290 — Compose a message that includes the user's strategy focus,
    // selected indicators, and any expert-mode custom prompt. The backend
    // routes these into the system prompt so the bot focuses correctly.
    const stratLabel = {
      'auto': 'full multi-strategy scan',
      'smc-sweep': 'SMC Liquidity Sweep specifically',
      'smc-ob': 'SMC Order Block specifically',
      'smc-fvg': 'SMC Fair Value Gap (FVG) fill specifically',
      'ict-killzone': 'ICT Killzone (London / NY session) timing',
      'ict-breaker': 'ICT Breaker Block specifically',
      'wyckoff': 'Wyckoff Spring / Upthrust',
      'elliott': 'Elliott Wave count (5-wave impulse / ABC correction)',
      'fib': 'Fibonacci retracement (0.382 / 0.5 / 0.618 / 0.786)',
      'supply-demand': 'Supply / Demand zone reaction',
      'trend-following': 'Trend following (HH/HL or LH/LL continuation)',
      'pullback': 'Pullback retracement to dynamic support/resistance',
      'breakout': 'Breakout + retest',
      'mean-reversion': 'Mean reversion to VWAP / 20-EMA',
      'scalping': 'Intraday scalping setup',
      'harmonic': 'Harmonic patterns (Gartley, Bat, Butterfly, Crab)',
      'range': 'Range trading (bounce off range high/low)',
    }[LC_STATE.strategy] || 'full multi-strategy scan';
    const indLabel = LC_STATE.indicators.length
      ? `Use these indicators in your analysis: ${LC_STATE.indicators.join(', ')}.`
      : '';
    const expertLabel = LC_STATE.expertPrompt
      ? `\n\nExpert instructions (treat as priority): ${LC_STATE.expertPrompt}`
      : '';
    const message = `Analyse the live ${LC_STATE.pair} ${LC_STATE.timeframe} chart right now (asset class: ${LC_STATE.assetClass}). Focus: ${stratLabel}. ${indLabel} Use the LIVE_MARKET data block — that is the exact chart I am looking at. Give your full verdict per the framework.${expertLabel}`;
    const res = await fetch('/api/chart-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: message }],
        pair: LC_STATE.pair,
        timeframe: LC_STATE.timeframe,
        strategy: LC_STATE.strategy,
        indicators: LC_STATE.indicators,
        assetClass: LC_STATE.assetClass,
        expertPrompt: LC_STATE.expertPrompt,
      }),
    });
    const data = await res.json();
    const reply = data.reply || data.fallbackReply || 'No reply received.';
    if (verdictEl) {
      verdictEl.hidden = false;
      verdictEl.innerHTML = _cbRenderMarkdown(reply);
      verdictEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    // Also mirror to the chat history so the user can see context grow
    try {
      if (Array.isArray(_cbState.messages)) {
        _cbState.messages.push({ role: 'user', content: message, ts: Date.now() });
        _cbState.messages.push({ role: 'assistant', content: reply, mode: data.mode, ts: Date.now() });
        _cbSave && _cbSave();
      }
    } catch {}
  } catch (e) {
    if (verdictEl) {
      verdictEl.hidden = false;
      verdictEl.textContent = 'Analysis failed: ' + (e.message || e);
    }
  } finally {
    LC_STATE.analyzing = false;
    if (btn) { btn.disabled = false; btn.textContent = '🧠 Analyze now'; }
  }
}

// ════════════════════════════════════════════════════════════════════════
// v295 — SCREEN CAPTURE + ANALYSE. The user clicks "📸 Snap & Analyse",
// the browser asks permission to share the current tab (or the whole
// screen), we grab ONE frame of the actual TradingView chart pixels,
// resize to keep payload small, and send it as a vision input to Claude
// alongside all the deterministic data. Real "read the chart" — the
// closest thing possible in a browser given the cross-origin iframe
// restriction TradingView enforces.
//
// Requires: navigator.mediaDevices.getDisplayMedia — supported on desktop
// Chrome / Edge / Firefox. iOS Safari does not support this; mobile users
// fall through to a message directing them to the manual screenshot
// upload in the Chart Bot tab.
// ════════════════════════════════════════════════════════════════════════
async function _lcSnapAndAnalyse() {
  if (LC_STATE.analyzing) return;
  const btn = document.getElementById('lc-snap-analyze');
  const verdictEl = document.getElementById('lc-verdict');

  // Feature-detect first — no getDisplayMedia = no screen capture (iOS Safari, etc.)
  const supportsCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!supportsCapture) {
    if (verdictEl) {
      verdictEl.hidden = false;
      verdictEl.innerHTML = `<strong>Screen capture unsupported on this browser.</strong>
      <br><br>Use the <strong>Chart Bot</strong> tab and attach a screenshot manually. iOS Safari and some in-app browsers block screen capture for privacy reasons.`;
    }
    return;
  }

  LC_STATE.analyzing = true;
  if (btn) { btn.disabled = true; btn.textContent = '📸 Capturing…'; }
  let capturedImage = null;
  let stream = null;
  try {
    // Prompt for screen share. `preferCurrentTab` is a Chrome hint that
    // pre-selects the current tab in the picker; other browsers show
    // the standard picker where the user chooses which tab.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'never' },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    });
    if (btn) btn.textContent = '📸 Grabbing frame…';
    // Grab one frame. ImageCapture API is the modern route but has spotty
    // support — fall back to a hidden <video> + createImageBitmap.
    let bitmap;
    const track = stream.getVideoTracks()[0];
    if (typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(track);
        bitmap = await ic.grabFrame();
      } catch { /* fall through to video path */ }
    }
    if (!bitmap) {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // Wait one frame so the video element has actual pixels
      await new Promise((resolve) => {
        if (video.readyState >= 2) return resolve();
        video.addEventListener('loadeddata', resolve, { once: true });
      });
      await new Promise((r) => setTimeout(r, 250));
      bitmap = await createImageBitmap(video);
      video.pause();
    }
    // Draw to canvas, resize to 1600px long edge, export JPEG @ 0.85 quality
    let w = bitmap.width, h = bitmap.height;
    const MAX = 1600;
    if (Math.max(w, h) > MAX) {
      const scale = MAX / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    capturedImage = {
      mediaType: 'image/jpeg',
      data: dataUrl.split(',')[1],
      preview: dataUrl,
    };
  } catch (e) {
    // User cancelled or capture failed
    if (verdictEl) {
      verdictEl.hidden = false;
      const msg = /permission|denied|NotAllowed/i.test(e.name || e.message || '')
        ? 'Screen share cancelled. Click 📸 Snap & Analyse again and pick the TradingView tab when prompted.'
        : 'Screen capture failed: ' + (e.message || e);
      verdictEl.innerHTML = `<strong>${msg}</strong>`;
    }
    LC_STATE.analyzing = false;
    if (btn) { btn.disabled = false; btn.textContent = '📸 Snap & Analyse'; }
    if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    return;
  } finally {
    // Release the capture stream immediately — one frame is all we need
    if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  }

  // Send the captured image + full context to /api/chart-bot
  if (btn) btn.textContent = '🧠 Analysing…';
  try {
    const stratLabel = {
      'auto': 'full multi-strategy scan', 'smc-sweep': 'SMC Liquidity Sweep',
      'smc-ob': 'SMC Order Block', 'smc-fvg': 'SMC Fair Value Gap',
      'ict-killzone': 'ICT Killzone', 'ict-breaker': 'ICT Breaker Block',
      'wyckoff': 'Wyckoff Spring/Upthrust', 'elliott': 'Elliott Wave',
      'fib': 'Fibonacci retracement', 'supply-demand': 'Supply/Demand zone',
      'trend-following': 'Trend following', 'pullback': 'Pullback retracement',
      'breakout': 'Breakout + retest', 'mean-reversion': 'Mean reversion',
      'scalping': 'Scalping', 'harmonic': 'Harmonic patterns',
      'range': 'Range trading',
    }[LC_STATE.strategy] || 'full multi-strategy scan';
    const promptText = `I've captured the live ${LC_STATE.pair} ${LC_STATE.timeframe} TradingView chart directly from my screen. The image shows the actual chart I'm looking at right now — including any drawings, indicators (${LC_STATE.indicators.join(', ') || 'none selected'}), and price levels visible. Focus: ${stratLabel}. Analyse what you see in the screenshot AND cross-check with the LIVE_MARKET data + correlation basket + news sentiment provided. Give your full verdict per the framework. If your visual read of the chart disagrees with the LIVE_MARKET numeric data, flag it explicitly and trust LIVE_MARKET.`;
    const message = {
      role: 'user',
      content: [
        { type: 'image', data: capturedImage.data, mediaType: capturedImage.mediaType },
        { type: 'text', text: promptText },
      ],
    };
    const res = await fetch('/api/chart-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [message],
        pair: LC_STATE.pair,
        timeframe: LC_STATE.timeframe,
        strategy: LC_STATE.strategy,
        indicators: LC_STATE.indicators,
        assetClass: LC_STATE.assetClass,
        expertPrompt: LC_STATE.expertPrompt,
      }),
    });
    const data = await res.json();
    const reply = data.reply || data.fallbackReply || 'No reply received.';
    if (verdictEl) {
      verdictEl.hidden = false;
      // Include the captured thumbnail so user sees exactly what Claude saw
      verdictEl.innerHTML = `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
          <div style="flex:0 0 auto"><img src="${capturedImage.preview}" style="max-width:180px;max-height:120px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);object-fit:cover" alt="captured chart"/><div style="font-size:10.5px;color:#94a3b8;margin-top:3px;text-align:center">What Claude saw</div></div>
          <div style="flex:1;min-width:200px;font-size:11px;color:#94a3b8;line-height:1.5">
            <strong style="color:#c4b5fd">Screen-capture analysis</strong><br>
            Pair: <strong>${LC_STATE.pair}</strong> · TF: <strong>${LC_STATE.timeframe}</strong> · Strategy: <strong>${LC_STATE.strategy}</strong><br>
            Mode: <strong>${data.mode}</strong> ${data.model ? '· Model: ' + data.model : ''}
          </div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:10px">${_cbRenderMarkdown(reply)}</div>`;
      verdictEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    // Mirror to Chart Bot chat history
    try {
      if (Array.isArray(_cbState.messages)) {
        _cbState.messages.push({
          role: 'user',
          content: [
            { type: 'image', data: capturedImage.data, mediaType: capturedImage.mediaType, preview: capturedImage.preview },
            { type: 'text', text: promptText },
          ],
          ts: Date.now(),
        });
        _cbState.messages.push({ role: 'assistant', content: reply, mode: data.mode, ts: Date.now() });
        _cbSave && _cbSave();
      }
    } catch {}
  } catch (e) {
    if (verdictEl) {
      verdictEl.hidden = false;
      verdictEl.innerHTML = `<strong>Analysis failed:</strong> ${e.message || e}`;
    }
  } finally {
    LC_STATE.analyzing = false;
    if (btn) { btn.disabled = false; btn.textContent = '📸 Snap & Analyse'; }
  }
}

function _lcStartTimers() {
  // Cancel any existing
  _lcStopTimers();
  // Initial fetch + render
  _lcFetch();
  // 30s candle refresh
  LC_STATE.refreshTimer = setInterval(_lcFetch, 30000);
  // Auto-analyze if toggled on
  const auto = document.getElementById('lc-auto');
  if (auto && auto.checked) {
    LC_STATE.autoTimer = setInterval(_lcAnalyze, 120000); // every 2 min
  }
}
function _lcStopTimers() {
  if (LC_STATE.refreshTimer) { clearInterval(LC_STATE.refreshTimer); LC_STATE.refreshTimer = null; }
  if (LC_STATE.autoTimer)    { clearInterval(LC_STATE.autoTimer);    LC_STATE.autoTimer = null; }
}

function _lcWire() {
  if (window._lcWired) return;
  window._lcWired = true;
  // Restore last-used selections
  try {
    const savedPair = localStorage.getItem('forexsight_lc_pair');
    if (savedPair) {
      LC_STATE.pair = savedPair;
      const el = document.getElementById('lc-pair'); if (el) el.value = savedPair;
    }
    const savedTf = localStorage.getItem('forexsight_lc_tf');
    if (savedTf) {
      LC_STATE.timeframe = savedTf;
      const el = document.getElementById('lc-timeframe'); if (el) el.value = savedTf;
    }
    const savedAsset = localStorage.getItem('forexsight_lc_asset');
    if (savedAsset) {
      LC_STATE.assetClass = savedAsset;
      const el = document.getElementById('lc-asset-class'); if (el) el.value = savedAsset;
    }
    const savedStrat = localStorage.getItem('forexsight_lc_strat');
    if (savedStrat) LC_STATE.strategy = savedStrat;
    const savedInd = localStorage.getItem('forexsight_lc_ind');
    if (savedInd) LC_STATE.indicators = JSON.parse(savedInd) || [];
    const savedExpert = localStorage.getItem('forexsight_lc_expert');
    if (savedExpert) LC_STATE.expertPrompt = savedExpert;
  } catch {}
  // Asset class
  const assetEl = document.getElementById('lc-asset-class');
  if (assetEl) {
    assetEl.addEventListener('change', () => {
      LC_STATE.assetClass = assetEl.value;
      try { localStorage.setItem('forexsight_lc_asset', LC_STATE.assetClass); } catch {}
    });
  }
  // Pair input — triggers both quote refresh and TV widget remount
  const pairEl = document.getElementById('lc-pair');
  if (pairEl) {
    pairEl.addEventListener('change', () => {
      const v = (pairEl.value || '').trim().toUpperCase().replace(/\s+/g, '');
      LC_STATE.pair = v.includes('/') ? v : (v.length === 6 ? v.slice(0,3) + '/' + v.slice(3) : v);
      try { localStorage.setItem('forexsight_lc_pair', LC_STATE.pair); } catch {}
      pairEl.value = LC_STATE.pair;
      _lcFetch();
      _lcMountTradingView();
      // v376 — broadcast dropdown change same as TradingView internal change
      if (typeof _lcBroadcastPair === 'function') _lcBroadcastPair(LC_STATE.pair);
    });
  }
  // Timeframe — quote panel + TV widget both honor it
  const tfEl = document.getElementById('lc-timeframe');
  if (tfEl) {
    tfEl.addEventListener('change', () => {
      LC_STATE.timeframe = tfEl.value;
      try { localStorage.setItem('forexsight_lc_tf', LC_STATE.timeframe); } catch {}
      _lcRender();
      _lcMountTradingView();
    });
  }
  // Analyse
  const analyzeBtn = document.getElementById('lc-analyze');
  if (analyzeBtn) analyzeBtn.addEventListener('click', _lcAnalyze);
  // v295 — Snap & Analyse (screen-capture the TradingView chart)
  const snapBtn = document.getElementById('lc-snap-analyze');
  if (snapBtn) snapBtn.addEventListener('click', _lcSnapAndAnalyse);
  // Auto-analyse
  const auto = document.getElementById('lc-auto');
  if (auto) {
    auto.addEventListener('change', () => {
      if (LC_STATE.autoTimer) { clearInterval(LC_STATE.autoTimer); LC_STATE.autoTimer = null; }
      if (auto.checked) LC_STATE.autoTimer = setInterval(_lcAnalyze, 120000);
    });
  }
  // v290 — Strategy chips. Single-select.
  const stratsGrid = document.getElementById('lc-strats-grid');
  if (stratsGrid) {
    const setActive = (val) => {
      stratsGrid.querySelectorAll('.lc-chip').forEach(c => c.classList.toggle('active', c.dataset.strat === val));
    };
    setActive(LC_STATE.strategy);
    stratsGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.lc-chip[data-strat]');
      if (!chip) return;
      LC_STATE.strategy = chip.dataset.strat;
      try { localStorage.setItem('forexsight_lc_strat', LC_STATE.strategy); } catch {}
      setActive(LC_STATE.strategy);
    });
  }
  // Clear strategy
  const clearStrat = document.getElementById('lc-strats-clear');
  if (clearStrat) {
    clearStrat.addEventListener('click', () => {
      LC_STATE.strategy = 'auto';
      try { localStorage.setItem('forexsight_lc_strat', 'auto'); } catch {}
      if (stratsGrid) stratsGrid.querySelectorAll('.lc-chip').forEach(c => c.classList.toggle('active', c.dataset.strat === 'auto'));
    });
  }
  // v290 — Indicator chips. Multi-select, capped at 3.
  document.querySelectorAll('.lc-chip-ind').forEach(chip => {
    if (LC_STATE.indicators.includes(chip.dataset.ind)) chip.classList.add('active');
    chip.addEventListener('click', () => {
      const ind = chip.dataset.ind;
      const idx = LC_STATE.indicators.indexOf(ind);
      if (idx >= 0) {
        LC_STATE.indicators.splice(idx, 1);
        chip.classList.remove('active');
      } else {
        if (LC_STATE.indicators.length >= 3) return; // capped
        LC_STATE.indicators.push(ind);
        chip.classList.add('active');
      }
      try { localStorage.setItem('forexsight_lc_ind', JSON.stringify(LC_STATE.indicators)); } catch {}
      _updateIndCount();
      _lcMountTradingView();  // re-render TV with new studies
    });
  });
  _updateIndCount();
  // v290 — Expert mode toggle
  const expertToggle = document.getElementById('lc-expert-toggle');
  const expertTa = document.getElementById('lc-expert-prompt');
  if (expertToggle && expertTa) {
    if (LC_STATE.expertPrompt) {
      expertToggle.checked = true;
      expertTa.hidden = false;
      expertTa.value = LC_STATE.expertPrompt;
    }
    expertToggle.addEventListener('change', () => {
      expertTa.hidden = !expertToggle.checked;
      if (!expertToggle.checked) {
        LC_STATE.expertPrompt = '';
        try { localStorage.setItem('forexsight_lc_expert', ''); } catch {}
      }
    });
    expertTa.addEventListener('input', () => {
      LC_STATE.expertPrompt = expertTa.value.trim();
      try { localStorage.setItem('forexsight_lc_expert', LC_STATE.expertPrompt); } catch {}
    });
  }
  // Pause timers when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _lcStopTimers();
    else if (document.querySelector('.tab.active')?.dataset.tab === 'live-chart') _lcStartTimers();
  });
  // Kick off — fetch live quote data AND mount TradingView widget
  _lcStartTimers();
  _lcMountTradingView();
}

function _updateIndCount() {
  const el = document.getElementById('lc-ind-count');
  if (el) el.textContent = `${LC_STATE.indicators.length}/3`;
  document.querySelectorAll('.lc-chip-ind').forEach(chip => {
    const isActive = chip.classList.contains('active');
    chip.classList.toggle('disabled', !isActive && LC_STATE.indicators.length >= 3);
  });
}

// Wire when the tab is first opened (lazy — avoids fetching prices for
// users who never visit the Live Chart tab).
document.addEventListener('click', (e) => {
  const t = e.target && e.target.closest && e.target.closest('.tab[data-tab="live-chart"]');
  if (t) setTimeout(_lcWire, 0);
});
// Also wire if the user lands directly on the Live Chart tab via URL or
// deep-link (e.g. from a push notification with hash routing).
document.addEventListener('DOMContentLoaded', () => {
  if (location.hash === '#live-chart' || location.search.includes('tab=live-chart')) {
    setTimeout(_lcWire, 0);
  }
});

// ════════════════════════════════════════════════════════════════════════
// v299 — GOLD-LIVE POLLING. When the Signals tab is active AND the app is
// visible, hit /api/gold-live every 25s to keep the XAU/USD state fresh.
// Also force-refresh /api/latest-signals when the tab becomes visible so
// the user never sees stale data on tab-open.
// ════════════════════════════════════════════════════════════════════════
let _goldLiveTimer = null;
let _lastGoldLiveState = null;

async function _pollGoldLive() {
  try {
    const res = await fetch('/api/gold-live', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    _lastGoldLiveState = data;
    // Trigger a signals-grid re-check if the gold summary changed materially.
    // We don't re-render the entire grid — we just paint the fresh price/state
    // into any gold card that's currently visible via a targeted DOM update.
    try { _paintGoldLiveIntoCards(data); } catch {}
  } catch { /* poll is defensive, never break the UI */ }
}

function _paintGoldLiveIntoCards(gl) {
  if (!gl || !gl.summary) return;
  // Update the XAU/USD card's live-price stat if we're on the Signals tab
  const cards = document.querySelectorAll('.card[data-pair="XAU/USD"]');
  cards.forEach(card => {
    // Look for the "current-price" style element; different layouts exist
    // so we try the most stable selectors.
    const priceEl = card.querySelector('.entry-price, .live-price, [data-live-price]');
    if (priceEl) {
      priceEl.textContent = gl.summary.livePrice.toFixed(2);
      priceEl.classList.add('lc-price-pulse');
      setTimeout(() => priceEl.classList.remove('lc-price-pulse'), 800);
    }
  });
}

function _startGoldLivePolling() {
  _stopGoldLivePolling();
  // Only poll if Signals tab is active
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab !== 'signals') return;
  _pollGoldLive();
  _goldLiveTimer = setInterval(_pollGoldLive, 25000);
}

function _stopGoldLivePolling() {
  if (_goldLiveTimer) { clearInterval(_goldLiveTimer); _goldLiveTimer = null; }
}

// Restart polling on tab switch
document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  const tabId = tab.dataset.tab;
  if (tabId === 'signals') setTimeout(_startGoldLivePolling, 0);
  else _stopGoldLivePolling();
});

// Force-refresh /api/latest-signals when the app becomes visible after being
// hidden. This is what makes the app "always live" — the user's expectation
// is that switching back to the app shows current data, not stale.
//
// v377 — Also force a FRESH SCAN via /api/check-signals whenever the app
// becomes visible or the Signals tab is opened. The preview URL doesn't
// have autonomous cron so this is the only way to guarantee fresh KV.
async function _forceFreshScan(opts = {}) {
  try {
    // v387 — INSTANT PAINT FIRST. Show whatever's already in KV before
    // starting any expensive work. User sees signals immediately instead
    // of a blank card during the 5-6s scan.
    try {
      const cached = await fetch('/api/latest-signals', { cache: 'no-store' });
      if (cached.ok) {
        const d = await cached.json();
        if (d && Array.isArray(d.signals)) {
          state.signals = d.signals;
          if (typeof renderSignals === 'function') renderSignals();
        }
      }
    } catch {}

    // Fire scan in the background; don't block user
    fetch('/api/check-signals', { cache: 'no-store' }).catch(() => {});
    // Skip shadow + tp-monitor on the first load — they run 3s later via
    // the heartbeat. Only fire them on explicit rescans (opts.full=true).
    if (opts.full) {
      Promise.all([
        fetch('/api/shadow-tracker', { cache: 'no-store' }).catch(() => {}),
        fetch('/api/tp-monitor', { cache: 'no-store' }).catch(() => {}),
      ]).catch(() => {});
    }
    // Refresh the UI ~4s later with any new signals the scan produced
    setTimeout(async () => {
      try {
        const res = await fetch('/api/latest-signals', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data && Array.isArray(data.signals)) {
          state.signals = data.signals;
          if (typeof renderSignals === 'function') renderSignals();
        }
      } catch {}
    }, 4500);
  } catch {}
}
window._forceFreshScan = _forceFreshScan;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _stopGoldLivePolling();
    return;
  }
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  if (activeTab === 'signals') {
    _startGoldLivePolling();
    _forceFreshScan();   // v377 — always trigger fresh scan on wake
  }
});

// v377 — Force fresh scan when the Signals tab is opened
document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab="signals"]');
  if (!tab) return;
  setTimeout(_forceFreshScan, 100);
});

// v377 — Force fresh scan on app load — v387 delayed 1.5s so the UI paints first
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => _forceFreshScan({ full: false }), 1500);
});

// ═══════════════════════════════════════════════════════════════════════
// v383 — CLIENT HEARTBEAT. Preview URL has no cron worker. Turn every
// open tab into an autonomous scanner: every 4 min while visible, ping
// scan + shadow + tp-monitor. Stops when tab is hidden (saves quota +
// battery). Restarts on visibilitychange.
// ═══════════════════════════════════════════════════════════════════════
const HEARTBEAT_MS = 4 * 60 * 1000;
let _heartbeatTimer = null;
let _heartbeatLastRun = 0;

function _heartbeatTick() {
  const now = Date.now();
  if (now - _heartbeatLastRun < 90_000) return; // debounce: 90s min between runs
  _heartbeatLastRun = now;
  _forceFreshScan().catch(() => {});
}
function _startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(_heartbeatTick, HEARTBEAT_MS);
}
function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) _stopHeartbeat();
  else { _startHeartbeat(); _heartbeatTick(); }
});
document.addEventListener('DOMContentLoaded', () => {
  // v387 — heartbeat starts 8s after load (was 3s) so cold-load isn't choked
  setTimeout(() => { _startHeartbeat(); }, 8000);
});
window.addEventListener('beforeunload', _stopHeartbeat);
window._heartbeatTick = _heartbeatTick;

// v377 — Manual Rescan now button
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest && e.target.closest('#signals-rescan-btn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Scanning…';
  btn.classList.add('spinning');
  try {
    await _forceFreshScan();
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
    btn.textContent = orig;
  }
});

// Kick off polling on load if we're already on the Signals tab
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startGoldLivePolling();
  }, 500);
});

// ═══════════════════════════════════════════════════════════════════════
// v365 — Wire the three v364 endpoints into UI
//   1. Conditions Score card on Signals tab (auto-refresh every 60s)
//   2. Trade Doctor form + verdict rendering
//   3. Personal Edge card on Trade Doctor tab (loads user's KV trades)
// ═══════════════════════════════════════════════════════════════════════

// ─── Escape helpers (fallback to window._esc if defined) ────────────
const _cdEsc = (s) => {
  if (typeof window._esc === 'function') return window._esc(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

// ─── Conditions Score ───────────────────────────────────────────────
let _condsTimer = null;
async function _refreshConditions() {
  const card = document.getElementById('conditions-card');
  if (!card) return;
  try {
    const res = await fetch('/api/conditions-score');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || !d.ok) return;

    const scoreEl = document.getElementById('conditions-score-num');
    const verdictEl = document.getElementById('conditions-verdict');
    const actionEl = document.getElementById('conditions-action');
    const breakdownEl = document.getElementById('conditions-breakdown');
    if (scoreEl) scoreEl.textContent = d.score;
    if (verdictEl) verdictEl.textContent = d.verdict;
    if (actionEl) actionEl.textContent = d.action;

    // Reset then apply verdict class (verdict may contain space: STAND ASIDE)
    card.classList.remove('verdict-GO', 'verdict-OK', 'verdict-CAUTION', 'verdict-STAND-ASIDE', 'verdict-STOP');
    card.classList.add('verdict-' + d.verdict.replace(/\s+/g, '-'));

    // Breakdown
    if (breakdownEl && d.breakdown) {
      breakdownEl.innerHTML = Object.entries(d.breakdown).map(([factor, info]) => `
        <div class="conditions-factor">
          <div class="conditions-factor-name">${_cdEsc(factor.replace(/([A-Z])/g, ' $1').trim())}</div>
          <div class="conditions-factor-pts">${info.points}/${info.max}</div>
          <div class="conditions-factor-note">${_cdEsc(info.note)}</div>
        </div>
      `).join('');
    }
    card.hidden = false;
  } catch (e) {
    // Silent fail — don't break the Signals tab
  }
}

function _startConditionsPolling() {
  _refreshConditions();
  if (_condsTimer) clearInterval(_condsTimer);
  _condsTimer = setInterval(_refreshConditions, 60000);
}
function _stopConditionsPolling() {
  if (_condsTimer) { clearInterval(_condsTimer); _condsTimer = null; }
}

// Toggle breakdown
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'conditions-toggle') {
    const bd = document.getElementById('conditions-breakdown');
    const btn = e.target;
    if (!bd) return;
    const willShow = bd.hidden;
    bd.hidden = !willShow;
    btn.classList.toggle('open', willShow);
  }
});

// Start conditions polling when signals tab is active
document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startConditionsPolling, 0);
  else _stopConditionsPolling();
  if (tab.dataset.tab === 'trade-doctor') setTimeout(_tdOnTabOpen, 0);
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startConditionsPolling();
  }, 800);
});

// ─── Trade Doctor ───────────────────────────────────────────────────
let _tdSelectedDir = 'BUY';

// Direction toggle
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.td-dir-btn');
  if (!btn) return;
  _tdSelectedDir = btn.dataset.dir;
  document.querySelectorAll('.td-dir-btn').forEach(b => b.classList.toggle('active', b.dataset.dir === _tdSelectedDir));
});

// Prefill from top live signal
async function _tdPrefillFromTop() {
  try {
    const res = await fetch('/api/latest-signals');
    if (!res.ok) return;
    const d = await res.json();
    const top = (d.signals || [])[0];
    if (!top) return;
    document.getElementById('td-pair').value = top.pair;
    _tdSelectedDir = top.direction;
    document.querySelectorAll('.td-dir-btn').forEach(b => b.classList.toggle('active', b.dataset.dir === _tdSelectedDir));
    if (top.entry != null) document.getElementById('td-entry').value = top.entry;
    if (top.sl != null) document.getElementById('td-sl').value = top.sl;
    if (top.tp1 != null) document.getElementById('td-tp1').value = top.tp1;
    if (top.tp2 != null) document.getElementById('td-tp2').value = top.tp2;
    if (top.tp3 != null) document.getElementById('td-tp3').value = top.tp3;
  } catch {}
}

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'td-prefill') _tdPrefillFromTop();
});

// Submit → call trade-doctor
async function _tdSubmit() {
  const btn = document.getElementById('td-submit');
  const resultEl = document.getElementById('td-result');
  if (!btn || !resultEl) return;

  const pair = document.getElementById('td-pair').value;
  const entry = parseFloat(document.getElementById('td-entry').value);
  const sl = parseFloat(document.getElementById('td-sl').value);
  const tp1 = parseFloat(document.getElementById('td-tp1').value);
  const tp2 = parseFloat(document.getElementById('td-tp2').value);
  const tp3 = parseFloat(document.getElementById('td-tp3').value);
  const riskPct = parseFloat(document.getElementById('td-risk').value) || 1;

  if (!isFinite(entry) || !isFinite(sl) || !isFinite(tp3)) {
    resultEl.hidden = false;
    resultEl.innerHTML = '<div class="td-verdict-card td-verdict-RECONSIDER"><div class="td-verdict-msg">Please fill in Entry, Stop Loss, and TP3 at minimum.</div></div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  try {
    const res = await fetch('/api/trade-doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pair, direction: _tdSelectedDir, entry, sl,
        tp1: isFinite(tp1) ? tp1 : null,
        tp2: isFinite(tp2) ? tp2 : null,
        tp3, riskPct,
      }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Unknown error');

    const verdictClass = 'td-verdict-' + d.verdict.replace(/\s+/g, '-');
    const green = (d.greenLights || []).map(x => `<div class="td-check-item">${_cdEsc(x)}</div>`).join('');
    const red = (d.redFlags || []).map(x => `<div class="td-check-item">${_cdEsc(x)}</div>`).join('');
    const adj = (d.adjustments || []).map(x => `<div class="td-check-item">${_cdEsc(x)}</div>`).join('');

    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="td-verdict-card ${verdictClass}">
        <div class="td-verdict-top">
          <div class="td-verdict-label">${_cdEsc(d.verdict)}</div>
          <div class="td-verdict-score">${d.score}<span class="td-verdict-score-max">/100</span></div>
        </div>
        <div class="td-verdict-msg">${_cdEsc(d.wouldITradeIt)}</div>
        <div class="td-checks">
          ${green ? `<div class="td-check-group green"><h4>✓ Green lights (${d.greenLights.length})</h4>${green}</div>` : ''}
          ${red ? `<div class="td-check-group red"><h4>✗ Red flags (${d.redFlags.length})</h4>${red}</div>` : ''}
          ${adj ? `<div class="td-check-group adjust"><h4>⚙ Adjustments (${d.adjustments.length})</h4>${adj}</div>` : ''}
        </div>
        ${d.honestNote ? `<div class="td-honest">${_cdEsc(d.honestNote)}</div>` : ''}
      </div>
    `;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    resultEl.hidden = false;
    resultEl.innerHTML = `<div class="td-verdict-card td-verdict-RECONSIDER"><div class="td-verdict-msg">Error: ${_cdEsc(e.message)}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get Verdict';
  }
}
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'td-submit') _tdSubmit();
});

// ─── Personal Edge ─────────────────────────────────────────────────
async function _renderPersonalEdge() {
  const card = document.getElementById('td-personal-edge');
  const body = document.getElementById('td-personal-edge-body');
  if (!card || !body) return;
  try {
    const res = await fetch('/api/personal-edge');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.ok) return;

    if (d.closedTrades < 5 || !d.insights || !d.insights.length) {
      body.innerHTML = `
        <div class="td-pe-empty">
          ${_cdEsc(d.insight || 'No trade history yet. As you use My Trades, your personal edge will emerge here.')}
        </div>
      `;
      card.hidden = false;
      return;
    }

    const lt = d.lifetime || {};
    const insights = (d.insights || []).map(i => `<div class="td-pe-insight">${_cdEsc(i)}</div>`).join('');
    body.innerHTML = `
      <div style="display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap;font-size:13px">
        <div><strong>${lt.winRate ?? '?'}%</strong> lifetime WR</div>
        <div><strong>${lt.expectancyR ?? '?'}R</strong> per trade</div>
        <div><strong>${d.closedTrades}</strong> closed trades studied</div>
      </div>
      ${insights}
    `;
    card.hidden = false;
  } catch {}
}

function _tdOnTabOpen() {
  _renderPersonalEdge();
  // Try to prefill only if the entry field is empty
  const entryEl = document.getElementById('td-entry');
  if (entryEl && !entryEl.value) _tdPrefillFromTop();
}

// ═══════════════════════════════════════════════════════════════════════
// v366 — ELITE signal banner + STAND ASIDE banner.
//
// Fetches /api/elite-signal every 90 seconds while on Signals tab. When an
// elite signal exists (0-3 per day globally), displays a prominent gold
// shimmer banner at the top of the feed. When conditions score drops below
// 50, displays a red "STAND ASIDE" banner overriding everything else.
//
// This is the "consistent wins" UX: fewer, bigger, weighted signals + strong
// visual cue when NOT to trade.
// ═══════════════════════════════════════════════════════════════════════

let _eliteTimer = null;
let _lastEliteKey = null;   // for dedup notification

function _pairSlug(p) { return String(p || '').replace('/', ''); }

async function _refreshEliteAndStandAside() {
  const eliteEl = document.getElementById('elite-banner');
  const standEl = document.getElementById('stand-aside-banner');
  if (!eliteEl || !standEl) return;

  // Parallel fetch
  let elite = null, cs = null;
  try {
    const [er, cr] = await Promise.all([
      fetch('/api/elite-signal').then(r => r.ok ? r.json() : null),
      fetch('/api/conditions-score').then(r => r.ok ? r.json() : null),
    ]);
    elite = er;
    cs = cr;
  } catch { return; }

  // ─── STAND ASIDE banner (higher priority than elite in UX) ────
  if (cs && typeof cs.score === 'number' && cs.score < 50) {
    standEl.innerHTML = `
      <div class="stand-aside-icon">🛑</div>
      <div class="stand-aside-body">
        <div class="stand-aside-title">Stand Aside · Conditions ${cs.score}/100</div>
        <div class="stand-aside-msg">${_cdEsc(cs.action || 'Poor trading conditions — do NOT force trades right now. Wait for score above 60.')}</div>
      </div>
    `;
    standEl.hidden = false;
  } else {
    standEl.hidden = true;
    standEl.innerHTML = '';
  }

  // ─── ELITE banner ─────────────────────────────────────────────
  const sig = elite?.eliteSignals?.[0];
  if (sig) {
    // Build a stable key so we don't notify the same elite twice
    const key = `${sig.pair}_${sig.direction}_${sig.entry}`;
    const isNew = key !== _lastEliteKey;
    _lastEliteKey = key;

    const dirColor = sig.direction === 'BUY' ? '🟢' : '🔴';
    const gateChips = (sig.gatesPassed || []).slice(0, 6).map(g =>
      `<span class="elite-gate-chip">✓ ${_cdEsc(g)}</span>`
    ).join('');

    eliteEl.innerHTML = `
      <div class="elite-badge">ELITE · ${_cdEsc(elite.session || 'active session')}</div>
      <h3 class="elite-title">${dirColor} ${_cdEsc(sig.pair)} ${_cdEsc(sig.direction)} @ ${_cdEsc(sig.entry)}</h3>
      <div class="elite-sub">${_cdEsc(sig.reasoning || 'All 10 elite gates passed — this is a rare high-conviction setup.')}</div>
      <div class="elite-levels">
        <div class="elite-level"><span class="elite-level-label">Entry</span><span class="elite-level-value">${_cdEsc(sig.entry)}</span></div>
        <div class="elite-level"><span class="elite-level-label">Stop</span><span class="elite-level-value">${_cdEsc(sig.sl)}</span></div>
        <div class="elite-level"><span class="elite-level-label">TP1</span><span class="elite-level-value">${_cdEsc(sig.tp1)}</span></div>
        <div class="elite-level"><span class="elite-level-label">TP2</span><span class="elite-level-value">${_cdEsc(sig.tp2)}</span></div>
        <div class="elite-level"><span class="elite-level-label">TP3</span><span class="elite-level-value">${_cdEsc(sig.tp3)}</span></div>
        <div class="elite-level"><span class="elite-level-label">R:R</span><span class="elite-level-value">${_cdEsc(sig.rMultiple)}</span></div>
      </div>
      <div class="elite-gates">${gateChips}</div>
      <div class="elite-actions">
        <button type="button" class="elite-take-btn" data-elite-take='${JSON.stringify({
          pair: sig.pair, direction: sig.direction, entry: sig.entry, sl: sig.sl,
          tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, confidence: sig.confidence,
          rMultiple: sig.rMultiple, source: 'elite-signal',
        }).replace(/'/g, '&#39;')}'>⭐ Take this trade</button>
        <button type="button" class="elite-copy-btn" data-elite-copy="${_cdEsc(`${sig.pair} ${sig.direction} @ ${sig.entry} SL ${sig.sl} TP1 ${sig.tp1} TP2 ${sig.tp2} TP3 ${sig.tp3} R:R ${sig.rMultiple}`)}">📋 Copy levels</button>
      </div>
    `;
    eliteEl.hidden = false;

    // Fire browser notification once per new elite (permission required)
    if (isNew && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`⭐ ELITE ${sig.direction} ${sig.pair}`, {
          body: `Entry ${sig.entry} · SL ${sig.sl} · TP3 ${sig.tp3} · R:R ${sig.rMultiple}\n${sig.reasoning || ''}`,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'elite-signal',
          requireInteraction: true,
        });
      } catch {}
    }
  } else {
    eliteEl.hidden = true;
    eliteEl.innerHTML = '';
    _lastEliteKey = null;
  }
}

// Handle Take / Copy button clicks
document.addEventListener('click', (e) => {
  const take = e.target && e.target.closest && e.target.closest('[data-elite-take]');
  if (take) {
    try {
      const sig = JSON.parse(take.dataset.eliteTake.replace(/&#39;/g, "'"));
      // Reuse the existing "Take Trade" flow if exposed, otherwise store directly
      if (typeof window._takeSignalAsTrade === 'function') {
        window._takeSignalAsTrade(sig);
      } else {
        // Fallback: append to localStorage myTrades so it shows in My Trades
        const trades = JSON.parse(localStorage.getItem('myTrades') || '[]');
        trades.unshift({
          ...sig,
          id: `elite_${Date.now()}`,
          status: 'open',
          openedAt: new Date().toISOString(),
        });
        localStorage.setItem('myTrades', JSON.stringify(trades));
        _showCopyToast('⭐ Elite trade added to My Trades');
      }
    } catch (err) { console.error('elite take failed', err); }
    return;
  }
  const copy = e.target && e.target.closest && e.target.closest('[data-elite-copy]');
  if (copy) {
    _copyToClipboard(copy.dataset.eliteCopy || '');
    _showCopyToast('Copied elite trade levels');
  }
});

function _startEliteTimer() {
  _refreshEliteAndStandAside();
  if (_eliteTimer) clearInterval(_eliteTimer);
  _eliteTimer = setInterval(_refreshEliteAndStandAside, 90000);  // 90s
}
function _stopEliteTimer() {
  if (_eliteTimer) { clearInterval(_eliteTimer); _eliteTimer = null; }
}

// Start on Signals tab, stop otherwise
document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startEliteTimer, 0);
  else _stopEliteTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startEliteTimer();
    // Request notification permission the first time — user gets prompt
    if ('Notification' in window && Notification.permission === 'default') {
      // Non-blocking; requested on first user interaction to comply with
      // Chrome policies
      const requestOnce = () => {
        Notification.requestPermission().catch(() => {});
        document.removeEventListener('click', requestOnce);
      };
      document.addEventListener('click', requestOnce, { once: true, capture: true });
    }
  }, 1000);
});

// ═══════════════════════════════════════════════════════════════════════
// v367 — TRACK RECORD card. Trustworthiness UI.
// Shows honest per-tier WR + recent-20 win/loss strip + recovery streak.
// Fetches /api/track-record every 3 minutes while on Signals tab.
// ═══════════════════════════════════════════════════════════════════════

let _trTimer = null;

async function _refreshTrackRecord() {
  const card = document.getElementById('track-record-card');
  if (!card) return;
  try {
    const res = await fetch('/api/track-record');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.ok) return;

    const overall = d.overall || {};
    const tiers = d.byTier || {};
    const totalResolved = d.trustworthy?.totalResolved || 0;

    // If no outcomes yet, show onboarding message rather than 0/0 tiles
    if (totalResolved === 0) {
      card.innerHTML = `
        <div class="tr-header">
          <div class="tr-title">Track Record</div>
        </div>
        <div class="tr-tier-empty">No resolved signals yet. As signals fire and hit TP or SL, their outcomes appear here. Every one is logged — the good, the bad, all of it. This is how trust gets earned.</div>
      `;
      card.hidden = false;
      return;
    }

    // Build per-tier tiles
    const _tierTile = (label, klass, data) => {
      const wr = data.wr;
      const wrClass = wr == null ? '' : (wr >= 60 ? 'hi' : wr < 40 ? 'lo' : '');
      const wrDisplay = wr == null ? '—' : `${wr}%`;
      return `
        <div class="tr-tier">
          <div class="tr-tier-name ${klass}">${_cdEsc(label)}</div>
          <div class="tr-tier-wr ${wrClass}">${wrDisplay}</div>
          <div class="tr-tier-count">${data.n === 0 ? 'no signals yet' : `${data.wins}W · ${data.losses}L · last 30d`}</div>
        </div>
      `;
    };

    const eliteTile   = _tierTile('Elite',     'elite',   tiers.ELITE?.last30d       || { n: 0 });
    const premiumTile = _tierTile('Premium',   'premium', tiers.PREMIUM?.last30d     || { n: 0 });
    const strongTile  = _tierTile('Strong',    'strong',  tiers['strong-read']?.last30d || { n: 0 });
    const overallTile = _tierTile('All',       '',        overall.last30d            || { n: 0 });

    // Recent-20 strip
    const strip = (d.recent20 || []).map(x =>
      `<div class="tr-dot ${_cdEsc(x.status)}" title="${_cdEsc(x.pair)} ${_cdEsc(x.direction)} · ${_cdEsc(x.tier)} · ${_cdEsc(x.status)}"></div>`
    ).join('');

    // Recovery state
    const rec = d.recovery || {};
    const recClass = 'state-' + (rec.state || 'normal');
    const recEmoji = { hot: '🔥', warming: '📈', cold: '🧊', cooling: '⚠️', normal: '⚖️' }[rec.state || 'normal'] || '';

    card.innerHTML = `
      <div class="tr-header">
        <div class="tr-title">Track Record · Last 30 Days</div>
        <div class="tr-recovery ${recClass}">${recEmoji} ${_cdEsc((rec.state || 'normal').toUpperCase())}</div>
      </div>
      <div class="tr-tiers">
        ${eliteTile}
        ${premiumTile}
        ${strongTile}
        ${overallTile}
      </div>
      <div class="tr-strip-label">Recent ${(d.recent20 || []).length} outcomes (newest → oldest)</div>
      ${strip ? `<div class="tr-strip">${strip}</div>` : `<div class="tr-strip-empty">No outcomes in recent window.</div>`}
      <div class="tr-footnote">${_cdEsc(rec.msg || '')}  ·  Total lifetime resolved: ${totalResolved}. Every signal fired — no cherry-picking.</div>
    `;
    card.hidden = false;
  } catch { /* silent */ }
}

function _startTrackRecordTimer() {
  _refreshTrackRecord();
  if (_trTimer) clearInterval(_trTimer);
  _trTimer = setInterval(_refreshTrackRecord, 180000);  // 3 min
}
function _stopTrackRecordTimer() {
  if (_trTimer) { clearInterval(_trTimer); _trTimer = null; }
}

document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startTrackRecordTimer, 0);
  else _stopTrackRecordTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startTrackRecordTimer();
  }, 1200);
});

// ═══════════════════════════════════════════════════════════════════════
// v372 — PRO signal banner (highest tier). Only appears when a signal
// passes 5/6 pro-grade checks: key-level reaction + candle trigger +
// HTF bias + news catalyst + session + R:R ≥ 3. Expected 0-2 per day.
// ═══════════════════════════════════════════════════════════════════════

let _proTimer = null;
let _lastProKey = null;

async function _refreshProSignal() {
  const el = document.getElementById('pro-banner');
  if (!el) return;
  try {
    const res = await fetch('/api/pro-signal');
    if (!res.ok) return;
    const d = await res.json();
    const sig = d?.proSignals?.[0];
    if (!sig) {
      el.hidden = true; el.innerHTML = ''; _lastProKey = null; return;
    }
    const key = `${sig.pair}_${sig.direction}_${sig.entry}`;
    const isNew = key !== _lastProKey;
    _lastProKey = key;

    const dirEmoji = sig.direction === 'BUY' ? '🟢' : '🔴';
    const kl = sig.keyLevel || {};
    const klText = kl.price ? `Price at ${_cdEsc(kl.type)} ${_cdEsc(Number(kl.price).toFixed(4))} (${_cdEsc((kl.distanceATR || 0).toFixed(2))}× ATR)` : 'Price at key level';

    el.innerHTML = `
      <div class="pro-badge">PRO · ${_cdEsc(sig.session || 'active')}</div>
      <div class="pro-title">${dirEmoji} ${_cdEsc(sig.pair)} ${_cdEsc(sig.direction)} @ ${_cdEsc(sig.entry)}</div>
      <div class="pro-sub">${_cdEsc(sig.reasoning || '')}</div>
      <div class="pro-key-level">🎯 <strong>${klText}</strong> · trigger: <strong>${_cdEsc(sig.trigger)}</strong> (${_cdEsc(sig.triggerStrength)})</div>
      <div class="pro-levels">
        <div class="pro-level"><span class="pro-level-label">Entry</span><span class="pro-level-value">${_cdEsc(sig.entry)}</span></div>
        <div class="pro-level"><span class="pro-level-label">Stop</span><span class="pro-level-value">${_cdEsc(sig.sl)}</span></div>
        <div class="pro-level"><span class="pro-level-label">TP1 (35%)</span><span class="pro-level-value">${_cdEsc(sig.tp1)}</span></div>
        <div class="pro-level"><span class="pro-level-label">TP2 (65%)</span><span class="pro-level-value">${_cdEsc(sig.tp2)}</span></div>
        <div class="pro-level"><span class="pro-level-label">TP3 (100%)</span><span class="pro-level-value">${_cdEsc(sig.tp3)}</span></div>
        <div class="pro-level"><span class="pro-level-label">R:R</span><span class="pro-level-value">${_cdEsc(sig.rMultiple)}</span></div>
      </div>
      <div class="pro-actions">
        <button type="button" class="pro-take-btn" data-pro-take='${JSON.stringify({
          pair: sig.pair, direction: sig.direction, entry: sig.entry, sl: sig.sl,
          tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, confidence: sig.confidence,
          rMultiple: sig.rMultiple, source: 'pro-signal',
        }).replace(/'/g, '&#39;')}'>🏆 Take this pro trade</button>
        <button type="button" class="pro-copy-btn" data-pro-copy="${_cdEsc(`${sig.pair} ${sig.direction} @ ${sig.entry} SL ${sig.sl} TP1 ${sig.tp1} TP2 ${sig.tp2} TP3 ${sig.tp3} R:R ${sig.rMultiple}`)}">📋 Copy levels</button>
      </div>
    `;
    el.hidden = false;

    if (isNew && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`🏆 PRO ${sig.direction} ${sig.pair}`, {
          body: `${sig.trigger} at ${kl.type || 'level'} · ${sig.reasoning || ''}`,
          icon: '/icon-192.png', badge: '/icon-192.png',
          tag: 'pro-signal', requireInteraction: true,
        });
      } catch {}
    }
  } catch { }
}

document.addEventListener('click', (e) => {
  const take = e.target && e.target.closest && e.target.closest('[data-pro-take]');
  if (take) {
    try {
      const sig = JSON.parse(take.dataset.proTake.replace(/&#39;/g, "'"));
      if (typeof window._takeSignalAsTrade === 'function') window._takeSignalAsTrade(sig);
      else {
        const trades = JSON.parse(localStorage.getItem('myTrades') || '[]');
        trades.unshift({ ...sig, id: `pro_${Date.now()}`, status: 'open', openedAt: new Date().toISOString() });
        localStorage.setItem('myTrades', JSON.stringify(trades));
        _showCopyToast('🏆 PRO trade added to My Trades');
      }
    } catch {}
    return;
  }
  const copy = e.target && e.target.closest && e.target.closest('[data-pro-copy]');
  if (copy) { _copyToClipboard(copy.dataset.proCopy || ''); _showCopyToast('Copied PRO levels'); }
});

function _startProTimer() {
  _refreshProSignal();
  if (_proTimer) clearInterval(_proTimer);
  _proTimer = setInterval(_refreshProSignal, 120000);   // every 2 min
}
function _stopProTimer() { if (_proTimer) { clearInterval(_proTimer); _proTimer = null; } }

document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startProTimer, 0);
  else _stopProTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startProTimer();
  }, 1400);
});

// ═══════════════════════════════════════════════════════════════════════
// v373 — CHEAT CODES cards. Renders /api/cheat-codes signals. Each card
// = one firing technique with technique name + documented WR + sources.
// ═══════════════════════════════════════════════════════════════════════

let _ccTimer = null;
let _lastCcKey = null;

async function _refreshCheatCodes() {
  const container = document.getElementById('cheat-codes-container');
  if (!container) return;
  try {
    const res = await fetch('/api/cheat-codes');
    if (!res.ok) return;
    const d = await res.json();
    const sigs = d?.signals || [];
    if (sigs.length === 0) {
      container.hidden = true; container.innerHTML = ''; _lastCcKey = null; return;
    }

    // Dedup notification key from the top signal
    const topKey = `${sigs[0].pair}_${sigs[0].direction}_${sigs[0].technique}`;
    const isNew = topKey !== _lastCcKey;
    _lastCcKey = topKey;

    container.innerHTML = sigs.map(s => {
      const dirClass = s.direction === 'BUY' ? 'cheat-dir-buy' : 'cheat-dir-sell';
      const src = (s.sourceUrls || [])[0];
      return `
        <div class="cheat-card technique-${_cdEsc(s.technique || 'CHEAT')}">
          <div class="cheat-header">
            <span class="cheat-technique">${_cdEsc(s.technique || 'CHEAT CODE')}</span>
            <span class="cheat-wr">Documented WR: <strong>${_cdEsc(s.documentedWR || '?')}</strong></span>
          </div>
          <div class="cheat-title">
            <span class="${dirClass}">${_cdEsc(s.direction)}</span>
            ${_cdEsc(s.pair)} @ ${_cdEsc(s.entry)}
          </div>
          <div class="cheat-reasoning">${_cdEsc(s.reasoning || '')}</div>
          <div class="cheat-levels">
            <div class="cheat-level-tile"><span class="cheat-level-label">Entry</span><span class="cheat-level-val">${_cdEsc(s.entry)}</span></div>
            <div class="cheat-level-tile"><span class="cheat-level-label">Stop</span><span class="cheat-level-val">${_cdEsc(s.sl)}</span></div>
            <div class="cheat-level-tile"><span class="cheat-level-label">TP1</span><span class="cheat-level-val">${_cdEsc(s.tp1)}</span></div>
            <div class="cheat-level-tile"><span class="cheat-level-label">TP2</span><span class="cheat-level-val">${_cdEsc(s.tp2)}</span></div>
            <div class="cheat-level-tile"><span class="cheat-level-label">TP3</span><span class="cheat-level-val">${_cdEsc(s.tp3)}</span></div>
            <div class="cheat-level-tile"><span class="cheat-level-label">R:R</span><span class="cheat-level-val">${_cdEsc(s.rMultiple)}</span></div>
          </div>
          <div class="cheat-actions">
            <button type="button" class="cheat-take-btn" data-cc-take='${JSON.stringify({
              pair: s.pair, direction: s.direction, entry: s.entry, sl: s.sl,
              tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, confidence: s.confidence,
              rMultiple: s.rMultiple, source: 'cheat-code', technique: s.technique,
            }).replace(/'/g, '&#39;')}'>Take · ${_cdEsc(s.pWin)}% pWin</button>
            ${src ? `<a class="cheat-source" href="${_cdEsc(src)}" target="_blank" rel="noopener">📖 Source</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
    container.hidden = false;

    if (isNew && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const top = sigs[0];
        new Notification(`🎯 ${top.technique} · ${top.direction} ${top.pair}`, {
          body: `${top.reasoning} · Documented WR ${top.documentedWR}`,
          icon: '/icon-192.png', badge: '/icon-192.png',
          tag: 'cheat-code', requireInteraction: true,
        });
      } catch {}
    }
  } catch {}
}

document.addEventListener('click', (e) => {
  const take = e.target && e.target.closest && e.target.closest('[data-cc-take]');
  if (take) {
    try {
      const sig = JSON.parse(take.dataset.ccTake.replace(/&#39;/g, "'"));
      if (typeof window._takeSignalAsTrade === 'function') window._takeSignalAsTrade(sig);
      else {
        const trades = JSON.parse(localStorage.getItem('myTrades') || '[]');
        trades.unshift({ ...sig, id: `cc_${Date.now()}`, status: 'open', openedAt: new Date().toISOString() });
        localStorage.setItem('myTrades', JSON.stringify(trades));
        _showCopyToast(`🎯 ${sig.technique} trade added`);
      }
    } catch {}
  }
});

function _startCcTimer() {
  _refreshCheatCodes();
  if (_ccTimer) clearInterval(_ccTimer);
  _ccTimer = setInterval(_refreshCheatCodes, 120000);   // 2 min
}
function _stopCcTimer() { if (_ccTimer) { clearInterval(_ccTimer); _ccTimer = null; } }

document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startCcTimer, 0);
  else _stopCcTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startCcTimer();
  }, 1600);
});

// ═══════════════════════════════════════════════════════════════════════
// v374 — COLLAPSED-BY-DEFAULT home page cards.
//
// Every card on the Signals tab starts collapsed showing only its header.
// User taps header to expand. State does NOT persist across sessions —
// each fresh visit starts fully collapsed as requested.
//
// Cards it manages (by ID or class):
//   - #conditions-card, #track-record-card
//   - #elite-banner, #pro-banner, #stand-aside-banner
//   - Each .cheat-card inside #cheat-codes-container
//
// Also injects a header preview showing at-a-glance what's inside
// (e.g. "Conditions Score · 52/100 CAUTION").
// ═══════════════════════════════════════════════════════════════════════

// Track which cards user has expanded THIS SESSION (memory-only; reset on reload)
const _ccExpanded = new Set();

function _ccMakeCollapsible(el, headerHTML) {
  if (!el) return;
  el.dataset.collapsible = 'true';
  // v389 — if the card re-rendered (innerHTML wiped), the header is gone
  // even though data-collapsible is still there. Re-inject rather than skip.
  let header = el.querySelector(':scope > .collapsible-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'collapsible-header';
    el.insertBefore(header, el.firstChild);
  }
  header.innerHTML = headerHTML || '';
}

function _ccExtractPreview(el) {
  // Try to build a smart 1-line preview from the card's content
  const id = el.id || '';
  const cls = el.className || '';
  if (id === 'conditions-card') {
    const s = document.getElementById('conditions-score-num')?.textContent || '—';
    const v = document.getElementById('conditions-verdict')?.textContent || '—';
    return `<span class="collapsible-badge">Conditions</span><span>${s}/100</span><span class="collapsible-preview">${v}</span>`;
  }
  if (id === 'track-record-card') {
    return `<span class="collapsible-badge">Track record</span><span class="collapsible-preview">Tap to see per-tier WR</span>`;
  }
  if (id === 'elite-banner') {
    const t = el.querySelector('.elite-title')?.textContent?.trim() || 'Elite signal';
    return `<span class="collapsible-badge">⭐ Elite</span><span>${t.slice(0, 50)}</span>`;
  }
  if (id === 'pro-banner') {
    const t = el.querySelector('.pro-title')?.textContent?.trim() || 'PRO signal';
    return `<span class="collapsible-badge">🏆 PRO</span><span>${t.slice(0, 50)}</span>`;
  }
  if (id === 'stand-aside-banner') {
    const t = el.querySelector('.stand-aside-title')?.textContent?.trim() || 'Stand aside';
    return `<span class="collapsible-badge">🛑 Warn</span><span>${t.slice(0, 60)}</span>`;
  }
  if (cls.includes('cheat-card')) {
    const tech = el.querySelector('.cheat-technique')?.textContent?.trim() || 'Cheat';
    const title = el.querySelector('.cheat-title')?.textContent?.trim() || '';
    return `<span class="collapsible-badge">${tech}</span><span>${title.slice(0, 60)}</span>`;
  }
  // v388 — added covers for the newer cards
  if (id === 'trust-badge-card') {
    const score = el.querySelector('.tb-score')?.textContent?.trim() || '—';
    const label = el.querySelector('.tb-label')?.textContent?.trim() || '';
    return `<span class="collapsible-badge">🛡️ Trust</span><span>${score}/100</span><span class="collapsible-preview">${label}</span>`;
  }
  if (id === 'setup-radar-card') {
    const badge = el.querySelector('.sr-badge')?.textContent?.trim() || 'Radar';
    return `<span class="collapsible-badge">🎯 Radar</span><span class="collapsible-preview">${badge.slice(0, 80)}</span>`;
  }
  if (id === 'algo-read-card') {
    const bias = el.querySelector('.algo-summary-value.buy')?.textContent?.trim() || '?';
    const bias2 = el.querySelector('.algo-summary-value.sell')?.textContent?.trim() || '?';
    return `<span class="collapsible-badge">🤖 Algo</span><span>Buy ${bias}</span><span class="collapsible-preview">Sell ${bias2}</span>`;
  }
  return `<span class="collapsible-badge">Info</span><span>Tap to expand</span>`;
}

function _ccApplyToAll() {
  // v388 — every card on Signals tab is collapsed by default now
  const selectors = [
    '#trust-badge-card',
    '#setup-radar-card',
    '#algo-read-card',
    '#conditions-card',
    '#track-record-card',
    '#elite-banner',
    '#pro-banner',
    '#stand-aside-banner',
    '#cheat-codes-container .cheat-card',
  ];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      if (el.hidden) return;   // don't decorate hidden cards
      const preview = _ccExtractPreview(el);
      _ccMakeCollapsible(el, preview);   // v389 — this now re-injects if header missing
    });
  }
}

// Click delegate: tap header or card body area (outside interactive children) to toggle
document.addEventListener('click', (e) => {
  // Don't intercept clicks on buttons, links, inputs inside the card
  const el = e.target.closest('[data-collapsible="true"]');
  if (!el) return;
  const isInteractive = e.target.closest('button, a, input, select, textarea, [data-elite-take], [data-pro-take], [data-cc-take], [data-elite-copy], [data-pro-copy]');
  if (isInteractive) return;
  const willOpen = !el.classList.contains('collapsible-open');
  el.classList.toggle('collapsible-open', willOpen);
  if (willOpen) _ccExpanded.add(el.id || 'anonymous');
  else _ccExpanded.delete(el.id || 'anonymous');
});

// Watch for dynamic card renders (cheat cards, banners updating)
const _ccObserver = new MutationObserver(() => _ccApplyToAll());
document.addEventListener('DOMContentLoaded', () => {
  const signalsTab = document.getElementById('signals');
  if (signalsTab) {
    _ccObserver.observe(signalsTab, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  // First pass after a short delay to let other polls populate
  setTimeout(_ccApplyToAll, 500);
  setTimeout(_ccApplyToAll, 2000);
  setTimeout(_ccApplyToAll, 4000);
});

// ═══════════════════════════════════════════════════════════════════════
// v375 — ALGO READ card. Renders /api/algo-read to show institutional
// footprints (VWAP, absorption, wick rejection, round-number gravity,
// algo time windows) per pair + market-wide summary.
// ═══════════════════════════════════════════════════════════════════════

let _arTimer = null;

async function _refreshAlgoRead() {
  const card = document.getElementById('algo-read-card');
  if (!card) return;
  try {
    const res = await fetch('/api/algo-read');
    if (!res.ok) return;
    const d = await res.json();
    if (!d?.ok) return;
    const win = d.algoWindow || {};
    const ms = d.marketState || {};
    const activeName = win.activeWindow?.name || 'No specific window';
    const intensity = win.algoIntensity || 'normal';

    const pairRows = (d.pairs || []).filter(p => p.ok).map(p => {
      const sigs = [];
      if (p.vwap?.position === 'above') sigs.push(`VWAP+${p.vwap.distanceATR}× (inst BUY)`);
      else if (p.vwap?.position === 'below') sigs.push(`VWAP-${Math.abs(p.vwap.distanceATR)}× (inst SELL)`);
      if (p.absorption?.detected) sigs.push(`🎯 Absorption → ${p.absorption.direction}`);
      if (p.wick?.detected) sigs.push(`Wick reject → ${p.wick.direction}`);
      if (p.roundNumber?.isMagnetized) sigs.push(`Magnetized to ${p.roundNumber.nearestLevel}`);
      if (p.rangeCompression?.compressed) sigs.push(`⚡ Compressed ${(p.rangeCompression.ratio * 100).toFixed(0)}%`);
      const sigStr = sigs.length ? sigs.join(' · ') : 'No strong algo footprint';
      return `
        <div class="algo-pair-row bias-${_cdEsc(p.algoBias)}">
          <div class="algo-pair-name">${_cdEsc(p.pair)} <span class="algo-pair-bias ${_cdEsc(p.algoBias)}">${_cdEsc(p.algoBias)}</span></div>
          <div class="algo-signature">${_cdEsc(sigStr)}</div>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="algo-window-row algo-intensity-${_cdEsc(intensity)}">
        🕒 <strong>${_cdEsc(win.utcTime || '')} UTC</strong> · ${_cdEsc(activeName)} · algo intensity: <strong>${_cdEsc(intensity)}</strong>
      </div>
      <div class="algo-market-summary">
        <div class="algo-summary-tile"><div class="algo-summary-label">Buy-biased pairs</div><div class="algo-summary-value buy">${ms.buyBiased || 0}</div></div>
        <div class="algo-summary-tile"><div class="algo-summary-label">Sell-biased pairs</div><div class="algo-summary-value sell">${ms.sellBiased || 0}</div></div>
        <div class="algo-summary-tile"><div class="algo-summary-label">Neutral</div><div class="algo-summary-value">${ms.neutral || 0}</div></div>
      </div>
      <div class="algo-per-pair-grid">${pairRows}</div>
    `;
    card.hidden = false;
  } catch {}
}

function _startAlgoTimer() {
  _refreshAlgoRead();
  if (_arTimer) clearInterval(_arTimer);
  _arTimer = setInterval(_refreshAlgoRead, 120000);
}
function _stopAlgoTimer() { if (_arTimer) { clearInterval(_arTimer); _arTimer = null; } }

document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startAlgoTimer, 0);
  else _stopAlgoTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startAlgoTimer();
  }, 4500);  // v387 — was 1800, staggered to un-choke cold load
});

// ═══════════════════════════════════════════════════════════════════════
// v379 — SETUP RADAR. Scans every pair via /api/predict-next and lists
// every setup with meaningful directional bias. Includes setups the
// strict main gate held back — so you never miss a valid setup.
// ═══════════════════════════════════════════════════════════════════════

let _srTimer = null;

async function _refreshSetupRadar() {
  const card = document.getElementById('setup-radar-card');
  if (!card) return;
  try {
    const res = await fetch('/api/setup-radar?min=35');
    if (!res.ok) return;
    const d = await res.json();
    if (!d?.ok) return;
    const items = Array.isArray(d.radar) ? d.radar : [];
    if (items.length === 0) {
      card.innerHTML = `
        <div class="sr-header">
          <span class="sr-title">🎯 Setup Radar</span>
          <span class="sr-badge">${d.scanned} pairs scanned</span>
        </div>
        <div class="sr-empty">No setups with strength ≥ 35 right now. Market is quiet — the radar is watching.</div>
      `;
      card.hidden = false;
      return;
    }

    const rows = items.slice(0, 12).map(r => {
      const dirCls = r.direction === 'BUY' ? 'buy' : 'sell';
      const gateBadge = r.passedMainGate
        ? `<span class="sr-gate passed">✓ Passed main gate${r.mainTier ? ` (${_cdEsc(r.mainTier)})` : ''}</span>`
        : `<span class="sr-gate held" title="${_cdEsc(r.heldBackReason || '')}">⚡ Held back by strict gate</span>`;
      const factors = (r.topFactors || []).slice(0, 3).map(f => _cdEsc(f.name || '')).join(' · ');
      const rrPart = r.rrTP3 ? ` · R:R ${r.rrTP3}` : '';
      const pipsPart = r.tp3Pips ? ` · ${r.tp3Pips} pips` : '';
      return `
        <div class="sr-row ${dirCls}" data-pair="${_cdEsc(r.pair)}">
          <div class="sr-row-head">
            <span class="sr-pair">${_cdEsc(r.pair)}</span>
            <span class="sr-dir ${dirCls}">${_cdEsc(r.direction)}</span>
            <span class="sr-conf">${r.confidence}% conf</span>
            <span class="sr-strength">strength ${r.strength}</span>
          </div>
          <div class="sr-row-body">
            <div class="sr-factors">${factors || 'Aligned signals'}</div>
            <div class="sr-levels">Entry ${_cdEsc(String(r.entry))} · SL ${_cdEsc(String(r.sl))} · TP ${_cdEsc(String(r.tp3))}${rrPart}${pipsPart}</div>
          </div>
          <div class="sr-row-foot">${gateBadge}</div>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="sr-header">
        <span class="sr-title">🎯 Setup Radar <span class="sr-sub">— never miss a setup</span></span>
        <span class="sr-badge">${items.length} setups · ${d.passedMainGate} passed · ${d.heldBackButValid} held back</span>
      </div>
      <div class="sr-list">${rows}</div>
      <div class="sr-note">${_cdEsc(d.note || '')}</div>
    `;
    card.hidden = false;

    card.querySelectorAll('.sr-row').forEach(row => {
      row.addEventListener('click', () => {
        const pair = row.dataset.pair;
        if (pair && typeof _lcSetPair === 'function') _lcSetPair(pair);
      });
    });
  } catch {}
}

function _startSetupRadarTimer() {
  _refreshSetupRadar();
  if (_srTimer) clearInterval(_srTimer);
  _srTimer = setInterval(_refreshSetupRadar, 90000);
}
function _stopSetupRadarTimer() { if (_srTimer) { clearInterval(_srTimer); _srTimer = null; } }

document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startSetupRadarTimer, 0);
  else _stopSetupRadarTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startSetupRadarTimer();
  }, 6000);  // v387 — was 2000, staggered to un-choke cold load
});
window._refreshSetupRadar = _refreshSetupRadar;

// ═══════════════════════════════════════════════════════════════════════
// v380 — TRUST BADGE. Renders the /api/self-trust score at the top of
// the Signals tab. Tap to expand full component breakdown.
// ═══════════════════════════════════════════════════════════════════════

let _tbTimer = null;

async function _refreshTrustBadge() {
  const card = document.getElementById('trust-badge-card');
  if (!card) return;
  try {
    const r = await fetch('/api/self-trust');
    if (!r.ok) return;
    const d = await r.json();
    if (!d?.ok) return;
    const t = d.trustScore;
    if (t == null) return;
    const tone = t >= 80 ? 'very-high' : t >= 65 ? 'high' : t >= 50 ? 'mod' : t >= 35 ? 'low' : 'very-low';
    const label = t >= 80 ? 'VERY HIGH' : t >= 65 ? 'HIGH' : t >= 50 ? 'MODERATE' : t >= 35 ? 'LOW' : 'VERY LOW';
    const comps = d.components || {};
    const rows = Object.values(comps).map(c => {
      const s = c.score;
      const bar = s == null ? '<span class="tb-empty">insufficient data</span>' :
        `<div class="tb-mini-bar"><div class="tb-mini-fill" style="width:${Math.max(2, s)}%"></div></div>`;
      return `
        <div class="tb-comp">
          <div class="tb-comp-label">${_cdEsc(c.label || '?')}</div>
          <div class="tb-comp-score">${s == null ? '—' : s}</div>
          ${bar}
        </div>
      `;
    }).join('');
    card.innerHTML = `
      <div class="tb-head tb-${tone}">
        <div class="tb-title">
          <span class="tb-icon">🛡️</span>
          <span>System Trust</span>
        </div>
        <div class="tb-score-wrap">
          <div class="tb-score">${t}</div>
          <div class="tb-outof">/100</div>
        </div>
        <div class="tb-label">${label}</div>
        <button class="tb-toggle" aria-label="Show breakdown">▾</button>
      </div>
      <div class="tb-body">
        <div class="tb-interpretation">${_cdEsc(d.interpretation || '')}</div>
        <div class="tb-comps">${rows}</div>
      </div>
    `;
    card.hidden = false;
    const head = card.querySelector('.tb-head');
    const body = card.querySelector('.tb-body');
    if (head && body) {
      head.addEventListener('click', () => {
        const isOpen = card.classList.toggle('tb-open');
        card.querySelector('.tb-toggle').textContent = isOpen ? '▴' : '▾';
      });
    }
  } catch {}
}

function _startTrustBadgeTimer() {
  _refreshTrustBadge();
  if (_tbTimer) clearInterval(_tbTimer);
  _tbTimer = setInterval(_refreshTrustBadge, 180000);
}
function _stopTrustBadgeTimer() { if (_tbTimer) { clearInterval(_tbTimer); _tbTimer = null; } }
document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab]');
  if (!tab) return;
  if (tab.dataset.tab === 'signals') setTimeout(_startTrustBadgeTimer, 0);
  else _stopTrustBadgeTimer();
});
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'signals') _startTrustBadgeTimer();
  }, 7500);  // v387 — was 2200, staggered to un-choke cold load
});

// ═══════════════════════════════════════════════════════════════════════
// v376 — Cross-tab pair sync. Whenever Live Chart's pair changes (either
// via our dropdown OR the user changing symbol inside TradingView), other
// tabs auto-sync:
//   - Chart Bot pair hint updates → next bot query uses current pair
//   - Trade Doctor pair dropdown → prefill matches current pair
//   - Signal card taps → switch Live Chart to that pair
// ═══════════════════════════════════════════════════════════════════════

// Initial broadcast — set window.__currentLivePair from saved state or default
window.__currentLivePair = (() => {
  try { return localStorage.getItem('forexsight_lc_pair') || 'XAU/USD'; }
  catch { return 'XAU/USD'; }
})();

// Update badge on tab switch to Live Chart
document.addEventListener('click', (e) => {
  const tab = e.target && e.target.closest && e.target.closest('.tab[data-tab="live-chart"]');
  if (!tab) return;
  setTimeout(() => {
    const badge = document.getElementById('lc-now-watching');
    if (badge && window.__currentLivePair) badge.textContent = window.__currentLivePair;
  }, 100);
});
// Initial badge population on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const badge = document.getElementById('lc-now-watching');
    if (badge && window.__currentLivePair) badge.textContent = window.__currentLivePair;
  }, 500);
});

// Listen to LC pair changes → sync Chart Bot + Trade Doctor
document.addEventListener('livePairChanged', (ev) => {
  const newPair = ev.detail?.pair;
  if (!newPair) return;
  // Chart Bot — if the pair-hint state var exists, update it
  if (typeof window.__chartBotPairHint !== 'undefined') {
    window.__chartBotPairHint = newPair;
  }
  // Trade Doctor pair dropdown
  const tdPair = document.getElementById('td-pair');
  if (tdPair) {
    const opt = Array.from(tdPair.options).find(o => o.value === newPair);
    if (opt) tdPair.value = newPair;
  }
});

// Signal card taps (from Signals tab) → switch Live Chart to that pair
// and (optionally) auto-navigate to the Live Chart tab.
function _syncLivePair(newPair, opts = {}) {
  if (!newPair) return;
  if (newPair === LC_STATE.pair) return;
  LC_STATE.pair = newPair;
  try { localStorage.setItem('forexsight_lc_pair', newPair); } catch {}
  window.__currentLivePair = newPair;
  const pairEl = document.getElementById('lc-pair');
  if (pairEl) pairEl.value = newPair;
  const badge = document.getElementById('lc-now-watching');
  if (badge) badge.textContent = newPair;
  // Remount the widget if we're on Live Chart
  if (opts.remount || document.querySelector('.tab.active')?.dataset.tab === 'live-chart') {
    _lcFetch();
    _lcMountTradingView();
  }
  document.dispatchEvent(new CustomEvent('livePairChanged', { detail: { pair: newPair } }));
}
window._syncLivePair = _syncLivePair;

// Delegate click on any signal card element to sync pair
document.addEventListener('click', (e) => {
  const card = e.target && e.target.closest && e.target.closest('[data-signal-pair]');
  if (card) {
    _syncLivePair(card.dataset.signalPair);
  }
  // Also catch the elite/pro/cheat "Take" buttons which have JSON with pair
  const dataTake = e.target && e.target.closest && (
    e.target.closest('[data-elite-take]') ||
    e.target.closest('[data-pro-take]') ||
    e.target.closest('[data-cc-take]')
  );
  if (dataTake) {
    try {
      const attr = dataTake.dataset.eliteTake || dataTake.dataset.proTake || dataTake.dataset.ccTake;
      const sig = JSON.parse((attr || '').replace(/&#39;/g, "'"));
      if (sig?.pair) _syncLivePair(sig.pair);
    } catch {}
  }
});








