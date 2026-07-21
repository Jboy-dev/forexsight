// /api/cron-heartbeat — v362
//
// Cron worker POSTs here on every tick. Stores last-fire timestamp + results
// to Cache API so anyone can check /api/cron-heartbeat (GET) to see when the
// cron last fired — proves the always-on scanner is actually running even
// during periods when signal set doesn't change (which would otherwise leave
// latest-signals looking stale).

export async function onRequest(context) {
  const { request } = context;
  const { cacheGet, cachePut } = await import('./_cache-store.js');
  const KEY = 'cron-heartbeat:latest';

  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch {}
    const record = {
      ts: (body && body.ts) || Date.now(),
      isoTime: new Date((body && body.ts) || Date.now()).toISOString(),
      results: (body && body.results) || [],
    };
    // Also append to a rolling history (last 20 fires)
    const history = (await cacheGet('cron-heartbeat:history')) || [];
    history.unshift(record);
    history.length = Math.min(history.length, 20);
    await cachePut(KEY, record, 24 * 3600);
    await cachePut('cron-heartbeat:history', history, 24 * 3600);
    return _json({ ok: true, stored: record });
  }

  // GET — return latest + history
  const latest = await cacheGet(KEY);
  const history = (await cacheGet('cron-heartbeat:history')) || [];
  if (!latest) {
    return _json({
      ok: true,
      note: 'No heartbeat received yet. Either cron worker not deployed, or cron has not fired since v362 heartbeat was added.',
      history: [],
    });
  }
  const ageSec = Math.round((Date.now() - latest.ts) / 1000);
  return _json({
    ok: true,
    version: 'v362-cron-heartbeat',
    lastFired: latest.isoTime,
    ageSeconds: ageSec,
    ageMinutes: Math.round(ageSec / 60),
    isFresh: ageSec < 10 * 60,          // fresh if < 10 min (2× cron interval)
    expectedIntervalSec: 300,           // 5 min
    lastResults: latest.results,
    history: history.slice(0, 10).map(h => ({
      isoTime: h.isoTime,
      ageMinutes: Math.round((Date.now() - h.ts) / 60000),
      results: h.results ? h.results.map(r => `${r.path.replace('/api/', '')}:${r.status}`).join(' ') : '',
    })),
  });
}

function _json(payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
