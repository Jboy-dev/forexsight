// /api/tp-status — v330 full TP tracker inspection endpoint.
//
// Returns every tracked signal with its complete hit state so the user can
// see WHY a TP wasn't notified. If a signal shows TP1/TP2/TP3 all HIT but
// no push arrived, the push subscription is the problem, not the detection.
//
// Also forces a fresh tp-monitor tick so any missed hits get caught NOW.

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (!env.TRADES_KV) {
    return _json({ ok: false, error: 'KV not bound' }, 500);
  }

  // Force a fresh tp-monitor tick FIRST so any pending hits get detected + pushed
  let monitorResult = null;
  try {
    const res = await fetch(`${origin}/api/tp-monitor`, {
      headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
    });
    if (res.ok) monitorResult = await res.json();
  } catch { /* non-fatal */ }

  // Now read the tracker
  const raw = await env.TRADES_KV.get('tp-tracker').catch(() => null);
  let tracker = { signals: [] };
  try { if (raw) tracker = JSON.parse(raw); } catch {}

  // Enrich each signal with human-readable status
  const enriched = (tracker.signals || []).map(s => {
    const hits = s.hits || {};
    const status = hits.sl ? 'LOST'
      : hits.tp3 ? 'WON BIG'
      : hits.tp2 ? 'WON (TP2)'
      : hits.tp1 ? 'IN PROFIT (TP1)'
      : s.resolvedAt ? 'EXPIRED'
      : 'OPEN';
    return {
      id: s.id,
      pair: s.pair,
      direction: s.direction,
      status,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      tp3: s.tp3,
      detectedAt: s.detectedAt,
      addedAt: s.addedAt ? new Date(s.addedAt).toISOString() : null,
      resolvedAt: s.resolvedAt ? new Date(s.resolvedAt).toISOString() : null,
      hits: {
        sl: hits.sl ? { at: new Date(hits.sl.t).toISOString(), price: hits.sl.price } : null,
        tp1: hits.tp1 ? { at: new Date(hits.tp1.t).toISOString(), price: hits.tp1.price } : null,
        tp2: hits.tp2 ? { at: new Date(hits.tp2.t).toISOString(), price: hits.tp2.price } : null,
        tp3: hits.tp3 ? { at: new Date(hits.tp3.t).toISOString(), price: hits.tp3.price } : null,
      },
    };
  });

  // Group by status for at-a-glance view
  const summary = {
    open: enriched.filter(s => s.status === 'OPEN').length,
    inProfit: enriched.filter(s => s.status === 'IN PROFIT (TP1)').length,
    wonTp2: enriched.filter(s => s.status === 'WON (TP2)').length,
    wonBig: enriched.filter(s => s.status === 'WON BIG').length,
    lost: enriched.filter(s => s.status === 'LOST').length,
    expired: enriched.filter(s => s.status === 'EXPIRED').length,
    total: enriched.length,
  };

  // Count push subscribers so user can debug delivery
  let subCount = 0;
  try {
    const list = await env.TRADES_KV.list({ prefix: 'pushsub:' });
    subCount = (list.keys || []).length;
  } catch {}

  return _json({
    ok: true,
    version: 'v330-tp-status',
    summary,
    signals: enriched,
    pushSubscribers: subCount,
    lastMonitorRun: monitorResult,
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
