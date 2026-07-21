// Cloudflare Pages Function: GET/POST /api/trades?code=<sync-code>
// Stores trades for a user-chosen sync code in Cloudflare KV.
// Same code on different devices = same trades. No password — the code IS the
// access key. User picks something hard-to-guess if they want privacy.

const MIN_CODE = 4;
const MAX_CODE = 64;
const TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year, refreshed on every save

function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isValidCode(code) {
  return code && code.length >= MIN_CODE && code.length <= MAX_CODE && /^[A-Za-z0-9_-]+$/.test(code);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();

  if (!isValidCode(code)) {
    return badRequest(`code must be ${MIN_CODE}-${MAX_CODE} characters, letters/numbers/-/_`);
  }
  if (!env.TRADES_KV) {
    return new Response(JSON.stringify({ error: 'KV binding not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const key = `trades:${code}`;

  if (request.method === 'GET') {
    const data = await env.TRADES_KV.get(key);
    return new Response(data || '[]', {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    let body;
    try {
      body = await request.text();
      if (body.length > 1024 * 1024) return badRequest('payload too large (>1MB)');
      JSON.parse(body); // validate JSON
    } catch (e) { return badRequest('body must be valid JSON'); }
    // v237 — Catch KV write failures (e.g. quota exhausted) instead of
    // letting them surface as HTML 500. Returning JSON lets the client UI
    // show a meaningful "save failed, retrying" instead of breaking sync.
    try {
      await env.TRADES_KV.put(key, body, { expirationTtl: TTL_SECONDS });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: 'KV write failed: ' + e.message }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}
