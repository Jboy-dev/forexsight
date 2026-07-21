// _fetch-guard — v382 foundation
//
// Central fetch helper for internal + external requests. Replaces the
// scattered `fetch(...).catch(() => {})` pattern with:
//   • AbortController timeout (default 8s, configurable)
//   • 1 retry on 5xx / network error (jittered 300-800ms backoff)
//   • Per-host circuit breaker (3 consecutive failures → open 60s)
//   • Last-Known-Good cache fallback so a Yahoo blip doesn't zero out signals
//
// Circuit-breaker state lives in globalThis so it persists across calls
// within the same Worker isolate. LKG cache uses the Cache API keyed by URL.

const CB_STATE_KEY = '__fetchGuardCB';
const LKG_CACHE = 'lkg-v1';

function _getCBState() {
  if (!globalThis[CB_STATE_KEY]) globalThis[CB_STATE_KEY] = new Map();
  return globalThis[CB_STATE_KEY];
}

function _hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function _cbOpen(host) {
  const st = _getCBState();
  const rec = st.get(host);
  if (!rec) return false;
  if (rec.openUntil && Date.now() < rec.openUntil) return true;
  if (rec.openUntil && Date.now() >= rec.openUntil) {
    st.set(host, { fails: 0, openUntil: null });
    return false;
  }
  return false;
}

function _cbRecord(host, ok) {
  const st = _getCBState();
  const rec = st.get(host) || { fails: 0, openUntil: null };
  if (ok) {
    rec.fails = 0;
    rec.openUntil = null;
  } else {
    rec.fails += 1;
    if (rec.fails >= 3) {
      rec.openUntil = Date.now() + 60_000; // 60s cool-off
    }
  }
  st.set(host, rec);
}

async function _cacheLKG(url, response) {
  try {
    const cache = await caches.open(LKG_CACHE);
    const cloned = response.clone();
    // Force cacheable — LKG has no expiry, we manage it manually
    const withHeaders = new Response(await cloned.arrayBuffer(), {
      status: cloned.status,
      headers: { ...Object.fromEntries(cloned.headers), 'Cache-Control': 'max-age=86400' },
    });
    await cache.put(new Request(url), withHeaders);
  } catch {}
}

async function _lkgLookup(url) {
  try {
    const cache = await caches.open(LKG_CACHE);
    const hit = await cache.match(new Request(url));
    return hit || null;
  } catch { return null; }
}

/**
 * safeFetch(url, opts?) — hardened fetch.
 * Options:
 *   timeout (ms, default 8000)
 *   retries (default 1)
 *   cacheLKG (default true for GET) — persist good response for fallback
 *   useLKG   (default true) — on failure, return LKG if present
 *   parseJson (default false) — parse and return {ok, data, status, source}
 */
export async function safeFetch(url, opts = {}) {
  const {
    timeout = 8000,
    retries = 1,
    cacheLKG = true,
    useLKG = true,
    parseJson = false,
    ...fetchOpts
  } = opts;

  const host = _hostOf(url);
  const method = (fetchOpts.method || 'GET').toUpperCase();
  const isGET = method === 'GET';

  if (_cbOpen(host)) {
    if (useLKG && isGET) {
      const lkg = await _lkgLookup(url);
      if (lkg) return _wrap(lkg, parseJson, 'lkg-circuit-open');
    }
    return _wrap(null, parseJson, 'circuit-open');
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeout);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        _cbRecord(host, true);
        if (cacheLKG && isGET) await _cacheLKG(url, res);
        return _wrap(res, parseJson, 'live');
      }
      // 5xx = retry-worthy
      if (res.status >= 500 && attempt < retries) {
        await _backoff();
        continue;
      }
      _cbRecord(host, false);
      if (useLKG && isGET) {
        const lkg = await _lkgLookup(url);
        if (lkg) return _wrap(lkg, parseJson, `lkg-http-${res.status}`);
      }
      return _wrap(res, parseJson, `http-${res.status}`);
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) { await _backoff(); continue; }
    }
  }
  _cbRecord(host, false);
  if (useLKG && isGET) {
    const lkg = await _lkgLookup(url);
    if (lkg) return _wrap(lkg, parseJson, 'lkg-network-error');
  }
  return _wrap(null, parseJson, `error:${lastErr?.name || 'unknown'}`);
}

function _backoff() {
  const ms = 300 + Math.random() * 500;
  return new Promise(r => setTimeout(r, ms));
}

function _wrap(res, parseJson, source) {
  if (!res) return { ok: false, source, response: null, data: null, status: 0 };
  if (!parseJson) return { ok: res.ok, source, response: res, status: res.status };
  return res.json().then(
    data => ({ ok: res.ok, source, data, status: res.status }),
    () => ({ ok: false, source: source + ':json-parse', data: null, status: res.status })
  );
}

/** Snapshot the current circuit-breaker state (for /api/state-audit). */
export function circuitSnapshot() {
  const st = _getCBState();
  const out = {};
  for (const [host, rec] of st.entries()) {
    out[host] = {
      fails: rec.fails,
      isOpen: !!(rec.openUntil && Date.now() < rec.openUntil),
      openMsRemaining: rec.openUntil ? Math.max(0, rec.openUntil - Date.now()) : 0,
    };
  }
  return out;
}
