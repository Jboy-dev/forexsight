// Stores the user's PushSubscription in KV so the cron can fire web pushes
// to it whenever a new strategy-confirmed signal is detected.
//
// Storage shape (keyed by random uuid):
//   key   = `pushsub:<uuid>`
//   value = JSON.stringify({ subscription, createdAt, lastSeen })
//
// Subscribers can pre-existing-deduplicate by sending their endpoint —
// if the same endpoint exists, we just update lastSeen instead of adding.

import { VAPID_PUBLIC } from './_push-lib.js';

const TTL = 60 * 60 * 24 * 90; // 90 days; refreshed on each request

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function ok(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.TRADES_KV) return bad('KV not bound', 500);

  // GET = return public VAPID key so client can subscribe
  if (request.method === 'GET') {
    return ok({ vapidPublic: VAPID_PUBLIC });
  }

  if (request.method !== 'POST') return bad('Method not allowed', 405);

  let sub;
  try {
    sub = await request.json();
  } catch (e) { return bad('Body must be valid JSON: ' + e.message); }

  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return bad('Subscription missing endpoint or keys');
  }

  // Look up existing subscriptions to avoid duplicates by endpoint
  const list = await env.TRADES_KV.list({ prefix: 'pushsub:' });
  let existingKey = null;
  for (const k of list.keys) {
    try {
      const v = await env.TRADES_KV.get(k.name, 'json');
      if (v && v.subscription && v.subscription.endpoint === sub.endpoint) {
        existingKey = k.name;
        break;
      }
    } catch {}
  }

  const now = new Date().toISOString();
  const record = {
    subscription: sub,
    createdAt: existingKey ? undefined : now,
    lastSeen: now,
    userAgent: request.headers.get('user-agent') || '',
  };
  // Preserve original createdAt if updating
  if (existingKey) {
    try {
      const old = await env.TRADES_KV.get(existingKey, 'json');
      if (old && old.createdAt) record.createdAt = old.createdAt;
    } catch {}
  }

  const key = existingKey || `pushsub:${crypto.randomUUID()}`;
  try {
    await env.TRADES_KV.put(key, JSON.stringify(record), { expirationTtl: TTL });
  } catch (e) { return bad('KV write failed: ' + e.message, 500); }

  return ok({ ok: true, key, refreshed: !!existingKey, vapidPublic: VAPID_PUBLIC });
}
