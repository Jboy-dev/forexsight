// Returns the most recent server-side signal snapshot from KV. If the snapshot
// is stale (>5 min) or missing, kicks off a fresh /api/check-signals scan in
// the background (via waitUntil — doesn't block the response). The client
// poll therefore self-triggers continual server-side checking as long as
// SOMEONE has the PWA open. No external cron required.

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
// v237 — Per-instance cooldown to prevent storms when KV writes are blocked.
// If check-signals can't update latest-signals (e.g. quota), every poll would
// otherwise spawn a fresh check-signals via waitUntil → recursive amplification.
// 30s minimum between triggers caps the storm even with many concurrent polls.
let _lastTriggerAt = 0;

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.TRADES_KV) {
    return new Response(JSON.stringify({ error: 'KV not bound', ts: 0, signals: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const raw = await env.TRADES_KV.get('latest-signals');
    let data = null;
    try { if (raw) data = JSON.parse(raw); } catch {}

    const isStale = !data || !data.ts || (Date.now() - data.ts > STALE_THRESHOLD_MS);
    // v237 — 30s cooldown between background triggers. Without this, when KV
    // writes are degraded and ts never advances, every poll fired another
    // check-signals (which itself spawned learning-brain + shadow-tracker
    // via waitUntil). Cascading amplification.
    const cooldownOk = (Date.now() - _lastTriggerAt) > 30 * 1000;
    if (isStale && cooldownOk) {
      _lastTriggerAt = Date.now();
      const url = new URL(request.url);
      const triggerUrl = `${url.protocol}//${url.host}/api/check-signals`;
      // Don't await — fire and forget. The next poll will see the fresh result.
      context.waitUntil(
        fetch(triggerUrl, {
          headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
        }).catch(() => {})
      );
    }

    // v347 — If the strict feed is empty, fall back to live-analysis so
    // the user always sees SOMETHING (chart-read predictions for each pair
    // with strong direction). "Loading signals..." with 0 signals for hours
    // was the wrong UX.
    const shouldFallback = !data || (data.signals && data.signals.length === 0);
    let liveAnalysisSignals = null;
    if (shouldFallback) {
      try {
        const url = new URL(request.url);
        const laRes = await fetch(`${url.protocol}//${url.host}/api/live-analysis?minConfidence=60`);
        if (laRes.ok) {
          const la = await laRes.json();
          liveAnalysisSignals = (la.signals || []).map(s => ({
            pair: s.pair,
            direction: s.direction,
            confidence: s.confidence,
            entry: s.entry,
            sl: s.sl,
            tp1: s.tp1,
            tp2: s.tp2,
            tp3: s.tp3,
            pipsToSl: s.slPips,
            pipsToTp3: s.tp3Pips,
            rMultiple: s.riskReward,
            slMethod: s.slMethod,
            source: s.tier === 'PREMIUM' ? 'premium-read' : 'chart-read',  // v350
            tier: s.tier,             // v350 — PREMIUM / strong-read / chart-read
            reasoning: s.reasoning,   // v350 — plain-English why
            topPick: s.tier === 'PREMIUM',  // top-pick for premium chart-reads
            topPickReason: s.reasoning,
            verdict: s.verdict,
            topReasons: s.topReasons,
            factorScore: s.factorScore,
            detectedAt: new Date().toISOString(),
            // v401 — was hardcoded to 0 which tanked self-trust activeQuality.
            // Chart-read consulted ≥1 leading indicator to produce this
            // directional bias — count that honestly.
            strategies: 1,
            namedStrategies: ['CHART-READ'],
          }));
        }
      } catch { /* fallback is non-fatal */ }
    }

    if (!data) {
      return new Response(JSON.stringify({
        ts: Date.now(),
        signals: liveAnalysisSignals || [],
        count: (liveAnalysisSignals || []).length,
        source: 'live-analysis',
        message: (liveAnalysisSignals && liveAnalysisSignals.length)
          ? 'showing live chart-reads (no platinum signals yet)'
          : 'first scan kicked off — try again in 30 seconds',
      }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // Data exists but signals empty → merge chart-read fallback
    if (data.signals && data.signals.length === 0 && liveAnalysisSignals && liveAnalysisSignals.length) {
      data = { ...data, signals: liveAnalysisSignals, count: liveAnalysisSignals.length, chartReadFallback: true };
    }

    // v318 — Enrich each signal with TP hit state from the tp-tracker KV
    // so the client can badge signals with "TP1 HIT", "TP2 HIT", etc.
    try {
      const trackerRaw = await env.TRADES_KV.get('tp-tracker');
      if (trackerRaw) {
        const tracker = JSON.parse(trackerRaw);
        const bySignalId = {};
        for (const t of (tracker.signals || [])) {
          bySignalId[t.id] = t;
        }
        const enriched = (data.signals || []).map(s => {
          const id = `${s.pair}|${s.direction}|${s.detectedAt || data.ts}`;
          const t = bySignalId[id];
          if (t && t.hits) {
            // v334 — Derive UI-friendly `status` from server-tracked hits.
            // The signal-card renderer keys off status; without this, cards
            // stayed "Open" even after all TPs were hit server-side.
            let status = 'open';
            let tpReached = 0;
            if (t.hits.sl && !t.hits.tp1) { status = 'lost'; }
            else if (t.hits.tp3) { status = 'won'; tpReached = 3; }
            else if (t.hits.tp2) { status = 'won'; tpReached = 2; }
            else if (t.hits.tp1) { status = 'won'; tpReached = 1; }
            return { ...s, tpHits: t.hits, resolvedAt: t.resolvedAt, status, tpReached };
          }
          return s;
        });
        data = { ...data, signals: enriched };
      }
    } catch { /* non-fatal — signals still ship without hit state */ }

    return new Response(JSON.stringify({
      ...data,
      stale: isStale,
      ageSeconds: Math.round((Date.now() - data.ts) / 1000),
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, ts: 0, signals: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
