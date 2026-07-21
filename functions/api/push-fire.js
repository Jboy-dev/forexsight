// Sends a Web Push notification to all stored subscriptions in KV.
// Called by the cron worker after fresh signals are detected, OR via
// direct HTTP request with a payload (e.g., for manual testing).
//
// Body schema (POST JSON):
//   {
//     "title": "📐 SMC A+ EUR/USD BUY — 87%",
//     "body":  "Entry 1.0823 · SL 1.0810 · TP1 1.0846",
//     "tag":   "smc-EUR/USD-2026-05-09T22",   (optional, dedup hint)
//     "url":   "/",                            (where tap should navigate)
//     "vibrate": [60, 40, 60, 40, 60]          (optional)
//   }
//
// Requires CRON_KEY env var to authenticate (so random people can't fire
// arbitrary pushes to your subscribers).

import { sendPush } from './_push-lib.js';

function bad(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return bad('POST only', 405);
  if (!env.TRADES_KV) return bad('KV not bound', 500);

  // Auth: same key as check-signals cron
  const auth = request.headers.get('x-cron-key') || new URL(request.url).searchParams.get('key');
  if (env.CRON_KEY && auth !== env.CRON_KEY) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let payload;
  try { payload = await request.json(); }
  catch (e) { return bad('JSON body required: ' + e.message); }
  if (!payload.title) return bad('payload must include title');

  // Apply unified vibrate pattern by default
  const pushPayload = {
    title: payload.title,
    body: payload.body || '',
    tag: payload.tag || ('signal-' + Date.now()),
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    vibrate: payload.vibrate || [30, 50, 30, 50, 30],
    url: payload.url || '/',
    requireInteraction: payload.requireInteraction !== false,
    silent: false,
    data: payload.data || { url: payload.url || '/' },
  };

  // Iterate all subscriptions and send
  const list = await env.TRADES_KV.list({ prefix: 'pushsub:' });
  let sent = 0, failed = 0, removed = 0;
  const errors = [];

  for (const k of list.keys) {
    let record;
    try { record = await env.TRADES_KV.get(k.name, 'json'); }
    catch (e) { errors.push(`read ${k.name}: ${e.message}`); continue; }
    if (!record || !record.subscription) continue;

    try {
      const res = await sendPush(record.subscription, pushPayload);
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 410) {
        // Subscription expired/invalid — remove it
        await env.TRADES_KV.delete(k.name).catch(() => {});
        removed++;
      } else {
        failed++;
        errors.push(`${k.name}: HTTP ${res.status}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${k.name}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, failed, removed, errors: errors.slice(0, 10) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
