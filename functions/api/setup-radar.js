// /api/setup-radar — v379
//
// "Never miss a setup" scanner. Runs across every pair in the universe,
// reads the deterministic /api/predict-next verdict for each, and
// surfaces any pair with meaningful directional bias — even if the main
// /api/check-signals gate rejected it for tier reasons.
//
// The main scanner protects against bad signals. The radar's job is the
// opposite: show every setup that exists so nothing is missed. Each
// radar entry declares whether it passed the main gate or was held
// back, and why.

const PAIRS = [
  'XAU/USD', 'BTC/USD', 'ETH/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'NZD/USD',
  'USD/CAD', 'USD/CHF', 'EUR/JPY', 'GBP/JPY',
  'US30', 'NAS100', 'SPX500',
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const minStrength = parseInt(url.searchParams.get('min') || '30', 10);

  let mainSignals = [];
  let realDropReasons = new Map(); // pair → failReasons[]
  try {
    const r = await fetch(`${origin}/api/latest-signals`, { cf: { cacheTtl: 30 } });
    if (r.ok) {
      const d = await r.json();
      mainSignals = Array.isArray(d.signals) ? d.signals : [];
    }
  } catch {}
  // v380 — pull real drop reasons from check-signals pipelineDiag
  try {
    const r = await fetch(`${origin}/api/check-signals`);
    if (r.ok) {
      const d = await r.json();
      const drops = d?.pipelineDiag?.platinumGateDropped || [];
      for (const dr of drops) {
        if (dr.pair) realDropReasons.set(`${dr.pair}_${dr.direction}`, dr.failReasons || []);
      }
    }
  } catch {}
  const mainByPair = new Map();
  for (const s of mainSignals) mainByPair.set(s.pair, s);

  // v382 — safeFetch so one predict-next 500 doesn't take down the radar
  const { safeFetch } = await import('./_fetch-guard.js');
  const results = await Promise.allSettled(
    PAIRS.map(async (pair) => {
      const u = `${origin}/api/predict-next?pair=${encodeURIComponent(pair)}`;
      const r = await safeFetch(u, { timeout: 9000, retries: 1, parseJson: true });
      if (!r.ok || !r.data) throw new Error(`predict ${pair} (${r.source})`);
      return { pair, data: r.data };
    })
  );

  const radar = [];
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    const { pair, data } = res.value;
    const pred = data?.prediction;
    if (!pred || pred.direction === 'HOLD') continue;

    const conf = pred.confidence || 0;
    const bull = data.factors?.bullishTotal || 0;
    const bear = data.factors?.bearishTotal || 0;
    const totalWeight = bull + bear;
    const margin = Math.abs(bull - bear);
    const marginPct = totalWeight > 0 ? margin / totalWeight : 0;

    // Strength: confidence heavier, margin as tiebreaker
    const strength = Math.round(conf * 0.7 + marginPct * 30);
    if (strength < minStrength) continue;

    const winning = pred.direction === 'BUY' ? (data.factors?.bullish || []) : (data.factors?.bearish || []);
    const topFactors = [...winning]
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 5)
      .map(f => ({ name: f.name, weight: f.weight, note: f.note || '' }));

    const mainMatch = mainByPair.get(pair);
    const passedMainGate = !!(mainMatch && mainMatch.direction === pred.direction);
    let heldBackReason = null;
    if (!passedMainGate) {
      // v380 — prefer the real failReasons from platinum gate diagnostics
      const realReasons = realDropReasons.get(`${pair}_${pred.direction}`)
        || realDropReasons.get(`${pair}_${pred.direction === 'BUY' ? 'SELL' : 'BUY'}`);
      if (realReasons && realReasons.length) {
        heldBackReason = realReasons.slice(0, 3).join(' · ');
      } else if (!mainMatch) {
        heldBackReason = 'Not scanned by strict pipeline (or filtered before platinum gate)';
      } else if (mainMatch.direction !== pred.direction) {
        heldBackReason = `Strict scanner has opposite bias (${mainMatch.direction}) — divergence flag`;
      }
    }

    radar.push({
      pair,
      direction: pred.direction,
      confidence: conf,
      strength,
      verdict: pred.verdict,
      timeHorizon: pred.timeHorizon,
      entry: pred.entry,
      sl: pred.stopLoss,
      tp1: pred.takeProfit1,
      tp3: pred.takeProfit3,
      slPips: pred.slDistancePips,
      tp1Pips: pred.tp1DistancePips,
      tp3Pips: pred.tp3DistancePips,
      rrTP1: pred.riskRewardTP1,
      rrTP3: pred.riskRewardTP3,
      passedMainGate,
      mainTier: mainMatch ? mainMatch.tier : null,
      heldBackReason,
      topFactors,
      bullVsBear: { bull, bear, marginPct: Math.round(marginPct * 100) },
      reasoning: data.reasoning,
    });
  }

  radar.sort((a, b) => b.strength - a.strength);

  const passing = radar.filter(r => r.passedMainGate).length;
  const heldBack = radar.length - passing;

  return new Response(JSON.stringify({
    ok: true,
    version: 'v379-setup-radar',
    timestamp: new Date().toISOString(),
    scanned: PAIRS.length,
    setupsFound: radar.length,
    passedMainGate: passing,
    heldBackButValid: heldBack,
    minStrengthFilter: minStrength,
    radar,
    note: 'Every pair with meaningful directional bias appears here. mainTier is set if it passed the strict signal gate. Otherwise heldBackReason explains why — the setup is still real.',
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      // v422 — s-maxage 60 → 300. Edge caches setup-radar for 5min so
      // client polls get served from CDN, not Function invocations.
      // Cuts quota burn 5x on this endpoint (was 15-pair fanout per call).
      // CORS added so cross-origin fallback fetches work.
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
