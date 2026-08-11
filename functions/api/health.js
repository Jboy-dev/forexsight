// /api/health — single-page system status. Use this to verify the website
// is fully operational from any browser.
//
// Visit https://forexsight-justice.pages.dev/api/health

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const checks = {};
  let allGreen = true;

  // 1) Signals snapshot in KV
  try {
    if (!env.TRADES_KV) {
      checks.kv = { ok: false, msg: 'KV not bound' }; allGreen = false;
    } else {
      const raw = await env.TRADES_KV.get('latest-signals');
      if (!raw) {
        checks.signals = { ok: false, msg: 'no snapshot yet — first scan pending' };
        allGreen = false;
      } else {
        const data = JSON.parse(raw);
        const ageSec = Math.round((Date.now() - (data.ts || 0)) / 1000);
        const isFresh = ageSec <= 600; // 10 min freshness window
        checks.signals = {
          ok: isFresh,
          count: data.count || 0,
          ageSeconds: ageSec,
          fresh: isFresh,
          msg: isFresh ? 'fresh' : `stale ${ageSec}s — open app to trigger rescan`,
        };
        if (!isFresh) allGreen = false;
      }
    }
  } catch (e) {
    checks.signals = { ok: false, error: e.message }; allGreen = false;
  }

  // v237 — Parallelize scan, prices, latest-signals checks. Was sequential —
  // each could take 10+ seconds, total /api/health latency was 30+ seconds.
  const [scanRes, pricesRes] = await Promise.allSettled([
    fetch(`${origin}/api/check-signals`, {
      headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
    }).then(async r => ({ r, data: await r.json() })),
    fetch(`${origin}/api/prices?symbol=EURUSD=X`).then(async r => ({ r, data: await r.json() })),
  ]);

  // 2) Live scan smoke test — for gold-only mode, 0 signals is valid
  // (nothing meeting criteria right now). Only failure if HTTP not OK.
  if (scanRes.status === 'fulfilled') {
    const { r, data } = scanRes.value;
    const withStrats = (data.signals || []).filter(s => (s.strategies || 0) >= 2).length;
    checks.scan = {
      ok: r.ok,
      status: r.status,
      count: data.count || 0,
      withStrategies2plus: withStrats,
      pushSent: data.pushSent || 0,
      msg: data.count > 0 ? 'signals firing' : 'no qualifying signals right now (normal in gold-only mode)',
    };
    if (!r.ok) allGreen = false;
  } else {
    checks.scan = { ok: false, error: scanRes.reason?.message || String(scanRes.reason) };
    allGreen = false;
  }

  // 3) Prices endpoint
  if (pricesRes.status === 'fulfilled') {
    const { r, data } = pricesRes.value;
    checks.prices = {
      ok: r.ok && Array.isArray(data.ohlc) && data.ohlc.length > 50,
      status: r.status,
      bars: data.ohlc ? data.ohlc.length : 0,
    };
    if (!checks.prices.ok) allGreen = false;
  } else {
    checks.prices = { ok: false, error: pricesRes.reason?.message || String(pricesRes.reason) };
    allGreen = false;
  }

  // v354 — Workers AI binding check
  checks.workersAI = {
    ok: !!(env.AI && typeof env.AI.run === 'function'),
    msg: (env.AI && typeof env.AI.run === 'function')
      ? 'AI binding attached — chart bot fallback via Llama 3.3 70B fp8-fast'
      : 'AI binding NOT attached — enable it in Cloudflare Pages dashboard: Settings → Functions → Bindings → Add binding → AI · Variable name: AI',
    anthropicKeySet: !!env.ANTHROPIC_API_KEY,
  };

  // 4) Push subscriptions count
  try {
    if (env.TRADES_KV) {
      const list = await env.TRADES_KV.list({ prefix: 'pushsub:' });
      checks.pushSubscriptions = { ok: true, count: list.keys.length };
    } else {
      checks.pushSubscriptions = { ok: false, msg: 'KV not bound' };
    }
  } catch (e) {
    checks.pushSubscriptions = { ok: false, error: e.message };
  }

  // 5) Math/version sanity — v404: updated ranges for v395 TP multipliers.
  //   v395 raised TP1 mult 1.5→2, TP2 3→4, TP3 5→7 (40% more pips)
  //   Real signals now show R:R ~4.5 on TP3. TP1 is ~1.5R+ on tight-SL
  //   setups (structure SL wins) or ~1.3R on ATR SL. Just require:
  //     TP1 ≥ 1R (break-even at ≥50% WR)
  //     TP3 ≥ 2R (real edge)
  //     TP1 < TP3 (correct ordering)
  try {
    const r = await fetch(`${origin}/api/latest-signals`);
    const data = await r.json();
    const s = (data.signals || [])[0];
    if (s && s.entry && s.sl && s.tp1) {
      const slDist = Math.abs(s.entry - s.sl);
      const tp1Dist = Math.abs(s.entry - s.tp1);
      const tp3Dist = s.tp3 ? Math.abs(s.entry - s.tp3) : null;
      const tp1Ratio = tp1Dist / slDist;
      const tp3Ratio = tp3Dist ? tp3Dist / slDist : null;
      const tp1Ok = tp1Ratio >= 1.0;
      const tp3Ok = tp3Ratio == null || tp3Ratio >= 2.0;
      const orderOk = tp3Dist == null || tp1Dist < tp3Dist;
      const correct = tp1Ok && tp3Ok && orderOk;
      checks.math = {
        ok: correct,
        sampleSignal: `${s.pair} ${s.direction}`,
        slDist: slDist.toFixed(5),
        tp1Dist: tp1Dist.toFixed(5),
        tp1Ratio: tp1Ratio.toFixed(2),
        tp3Ratio: tp3Ratio == null ? 'n/a' : tp3Ratio.toFixed(2),
        expected: 'TP1 ≥ 1R, TP3 ≥ 2R, TP1 < TP3',
      };
      if (!correct) allGreen = false;
    } else {
      checks.math = { ok: true, msg: 'no signals currently — math check skipped' };
    }
  } catch (e) {
    checks.math = { ok: false, error: e.message };
  }

  return new Response(JSON.stringify({
    status: allGreen ? 'GREEN' : 'YELLOW',
    timestamp: new Date().toISOString(),
    version: 'v433-classify-not-hide',
    summary: allGreen ? 'All systems operational' : 'Some checks need attention',
    checks,
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
