// Unified cross-device sync endpoint. Same pattern as /api/trades but stores
// the FULL user state (trades + learning logs + preferences) under one code.
// Backward-compatible: /api/trades keeps working, new endpoint is additive.

const MIN_CODE = 4;
const MAX_CODE = 64;
const MAX_PAYLOAD = 2 * 1024 * 1024; // 2MB
const TTL = 60 * 60 * 24 * 365;       // 1 year, refreshed on every save

function isValidCode(c) {
  return c && c.length >= MIN_CODE && c.length <= MAX_CODE && /^[A-Za-z0-9_-]+$/.test(c);
}

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (!isValidCode(code)) return bad(`code must be ${MIN_CODE}-${MAX_CODE} chars, letters/numbers/-/_`);
  if (!env.TRADES_KV) return bad('KV not bound', 500);

  const key = `sync:${code}`;

  if (request.method === 'GET') {
    const data = await env.TRADES_KV.get(key);
    return new Response(data || '{"trades":[],"logs":[]}', {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    let body;
    try {
      body = await request.text();
      if (body.length > MAX_PAYLOAD) return bad('payload too large (>2MB)');
      const parsed = JSON.parse(body);
      // Light shape validation — anything else just passes through
      if (typeof parsed !== 'object' || parsed === null) return bad('payload must be a JSON object');
    } catch (e) { return bad('body must be valid JSON: ' + e.message); }
    try {
      await env.TRADES_KV.put(key, body, { expirationTtl: TTL });
      return new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return bad('KV write failed: ' + e.message, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
}
