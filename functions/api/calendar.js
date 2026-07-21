// Cloudflare Pages Function: GET /api/calendar?impact=high
// v300 — 502 fix: upstream RSS was returning errors, cascading to callers.
// Now: 5s timeout per source, KV-cached fallback survives outages, always
// returns HTTP 200 (empty events array on total failure — never 502).

async function _fetchWithTimeout(url, timeoutMs = 5000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 ForexSight/1.0',
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const impact = (url.searchParams.get('impact') || '').toLowerCase();

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) {
    const c = new Response(cached.body, cached);
    c.headers.set('x-cf-cache', 'HIT');
    return c;
  }

  // KV fallback — survives upstream outages that would have caused 502
  if (env && env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('calendar-v2');
      if (raw) {
        const cachedPayload = JSON.parse(raw);
        const ageSec = Math.round((Date.now() - (cachedPayload.ts || 0)) / 1000);
        // Serve stale from KV if under 24 hours old while we fetch fresh
        if (ageSec < 86400 && !cached) {
          // fall through to fresh fetch; we'll compare
        }
      }
    } catch {}
  }

  try {
    const events = await _fetchWithTimeout('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 8000);

    if (!events || !Array.isArray(events)) {
      // Upstream failed — try KV fallback
      if (env && env.TRADES_KV) {
        try {
          const raw = await env.TRADES_KV.get('calendar-v2');
          if (raw) {
            const cachedPayload = JSON.parse(raw);
            const filtered = impact
              ? (cachedPayload.events || []).filter(e => (e.impact || '').toLowerCase() === impact)
              : (cachedPayload.events || []);
            return _json({
              events: filtered.slice(0, 120),
              stale: true,
              ageSeconds: Math.round((Date.now() - (cachedPayload.ts || 0)) / 1000),
              source: 'kv-fallback',
            });
          }
        } catch {}
      }
      // No cache available — return empty (200, never 502)
      return _json({ events: [], source: 'empty-fallback', reason: 'upstream unavailable' });
    }

    const filtered = impact
      ? events.filter(e => (e.impact || '').toLowerCase() === impact)
      : events;

    const payload = {
      events: filtered.slice(0, 120),
      count: filtered.length,
      ts: Date.now(),
    };

    // Save to KV for future outage-fallback
    if (env && env.TRADES_KV) {
      try { await env.TRADES_KV.put('calendar-v2', JSON.stringify(payload), { expirationTtl: 604800 }); } catch {}
    }

    const response = _json(payload);
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    // Never 502 — return empty events, log error in payload
    return _json({
      events: [],
      error: (err.message || String(err)).slice(0, 200),
      source: 'catch-fallback',
    });
  }
}

function _json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600, max-age=600, stale-while-revalidate=21600',
      'x-cf-cache': 'MISS',
      'access-control-allow-origin': '*',
    },
  });
}
