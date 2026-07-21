// _cache-store.js — v351 unified cache helper.
//
// Wraps Cloudflare's Cache API for ephemeral state (unlimited writes)
// instead of KV (1,000 writes/day on free tier). Use this for anything
// that can be recomputed if lost — price snapshots, correlation baskets,
// news sentiment, pro consensus.
//
// KV should only be used for state that MUST persist across worker
// invocations even when Cache API entries evict: push subscriptions,
// user trades, learning brain accumulated stats, TP tracker.
//
// Usage:
//   import { cacheGet, cachePut } from './_cache-store.js';
//   const data = await cacheGet('news-sentiment');
//   if (!data) { ...compute...; await cachePut('news-sentiment', data, 3600); }

const CACHE_HOST = 'https://cache.forexsight.internal';

async function cacheGet(key) {
  try {
    const cache = caches.default;
    const req = new Request(`${CACHE_HOST}/${encodeURIComponent(key)}`);
    const res = await cache.match(req);
    if (!res) return null;
    // Check expiry stored in header
    const expires = res.headers.get('x-cache-expires');
    if (expires && Date.now() > parseInt(expires, 10)) {
      await cache.delete(req).catch(() => {});
      return null;
    }
    return await res.json();
  } catch { return null; }
}

async function cachePut(key, value, ttlSeconds = 300) {
  try {
    const cache = caches.default;
    const req = new Request(`${CACHE_HOST}/${encodeURIComponent(key)}`);
    const expiresAt = Date.now() + (ttlSeconds * 1000);
    const res = new Response(JSON.stringify(value), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, s-maxage=${ttlSeconds}`,
        'x-cache-expires': String(expiresAt),
      },
    });
    await cache.put(req, res);
    return true;
  } catch { return false; }
}

// Smart wrapper: try KV first (persistent), fall back to Cache API on failure.
// For state that ideally lives in KV but must not fail if quota exhausted.
async function smartPut(env, kvKey, cacheKey, value, ttlSeconds = 300) {
  if (env && env.TRADES_KV) {
    try {
      await env.TRADES_KV.put(kvKey, JSON.stringify(value), { expirationTtl: ttlSeconds });
      return { via: 'kv' };
    } catch (e) {
      // KV write failed (quota) — fall back to Cache API
      const ok = await cachePut(cacheKey, value, ttlSeconds);
      return { via: ok ? 'cache' : 'none', kvError: e.message };
    }
  }
  const ok = await cachePut(cacheKey, value, ttlSeconds);
  return { via: ok ? 'cache' : 'none' };
}

async function smartGet(env, kvKey, cacheKey) {
  // Try Cache API first (faster + unlimited)
  const cached = await cacheGet(cacheKey);
  if (cached !== null) return { data: cached, via: 'cache' };
  // Fall back to KV
  if (env && env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get(kvKey);
      if (raw) {
        try {
          const data = JSON.parse(raw);
          // Warm the cache for next request
          await cachePut(cacheKey, data, 300);
          return { data, via: 'kv' };
        } catch {}
      }
    } catch {}
  }
  return { data: null, via: 'none' };
}

export { cacheGet, cachePut, smartGet, smartPut };
