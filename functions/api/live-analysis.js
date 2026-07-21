// /api/live-analysis — v347 always-firing chart reads · v356 stricter PREMIUM
//
// Runs predict-next on every pair and returns signal-shaped objects with
// direction/entry/SL/TP. Not filtered by strict signal gates — this is the
// system's honest current chart read for each pair, always visible.
//
// v356 — PREMIUM tier now requires REAL cross-confirmation:
//   1. predict-next confidence ≥85 AND margin ≥30
//   2. multi-source verdict = CONFIRM for that direction (macro basket agrees)
//   3. NO pair-dir veto active for that direction (no recent losing streak)
//   4. ADX ≥ 20 (real trend, not chop)
// Anything missing → downgrade to strong-read or chart-read.
// This makes PREMIUM tier actually mean "all independent sources agree" —
// the label the user can trust for their trades.

const PAIRS = ['XAU/USD', 'BTC/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF'];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const minConfidence = parseInt(url.searchParams.get('minConfidence') || '60', 10);

  // v356 — Fetch veto-status ONCE upfront. This tells us which pair+direction
  // combos are currently blocked by recent losses. Used to downgrade signals
  // in the wrong direction so PREMIUM tier never fights a losing streak.
  let vetoBlocks = new Set();
  try {
    const vRes = await fetch(`${origin}/api/veto-status`);
    if (vRes.ok) {
      const vData = await vRes.json();
      for (const b of (vData.pairDirBlocks || [])) {
        vetoBlocks.add(`${b.pair}_${b.direction}`);
      }
    }
  } catch { /* non-fatal */ }

  const results = await Promise.all(PAIRS.map(async (pair) => {
    try {
      // v356 — Fetch predict-next AND multi-source in parallel per pair.
      const [pnRes, msRes] = await Promise.all([
        fetch(`${origin}/api/predict-next?pair=${encodeURIComponent(pair)}`),
        fetch(`${origin}/api/multi-source-check?pair=${encodeURIComponent(pair)}&direction=BOTH`).catch(() => null),
      ]);
      if (!pnRes.ok) return { pair, ok: false, error: `HTTP ${pnRes.status}` };
      const d = await pnRes.json();
      const p = d.prediction || {};
      const f = d.factors || {};
      const ms = msRes && msRes.ok ? await msRes.json().catch(() => null) : null;
      // Only include if direction is not HOLD
      if (p.direction === 'HOLD' || !p.entry) {
        return { pair, ok: true, direction: 'HOLD', confidence: p.confidence || 50 };
      }
      const bullWeight = (f.bullish || []).reduce((s, x) => s + (x.weight || 0), 0);
      const bearWeight = (f.bearish || []).reduce((s, x) => s + (x.weight || 0), 0);
      const totalWeight = bullWeight + bearWeight;
      const margin = Math.abs(bullWeight - bearWeight);

      // v356 — Cross-confirmation checks. Each is a gate. All must pass for
      // PREMIUM. Track which fail so the client can show why a signal isn't
      // premium yet (transparency).
      const confluences = [];
      const missing = [];
      let msDirVerdict = null;
      let msDirBoost = 0;
      if (ms && (p.direction === 'BUY' ? ms.BUY : ms.SELL)) {
        const evalDir = p.direction === 'BUY' ? ms.BUY : ms.SELL;
        msDirVerdict = evalDir.verdict;
        msDirBoost = evalDir.boost || 0;
        if (msDirVerdict === 'CONFIRM') confluences.push(`multi-source CONFIRM (+${msDirBoost}pts)`);
        else if (msDirVerdict === 'VETO') missing.push(`multi-source VETO (${msDirBoost}pts)`);
        else missing.push(`multi-source ${msDirVerdict || 'unknown'} (needs CONFIRM)`);
      } else {
        missing.push('multi-source data unavailable');
      }

      const isVetoed = vetoBlocks.has(`${pair}_${p.direction}`);
      if (isVetoed) missing.push(`${pair} ${p.direction} blocked by recent-loss veto`);
      else confluences.push('no active veto');

      // Extract ADX from adxNote (e.g., "ADX 24.5")
      let adxValue = null;
      if (f.adxNote) {
        const m = /ADX\s+([\d.]+)/i.exec(f.adxNote);
        if (m) adxValue = parseFloat(m[1]);
      }
      if (adxValue != null && adxValue >= 20) confluences.push(`ADX ${adxValue.toFixed(1)} — real trend`);
      else if (adxValue != null) missing.push(`ADX ${adxValue.toFixed(1)} < 20 (choppy)`);
      else missing.push('ADX unavailable');

      // v363/v368 — HIGH-PIPS DETECTION.
      // v368 FIX: use predict-next's tp3DistancePips (computed from unrounded
      // values) as authoritative pip count. Falling back to Math.abs(tp3-entry)
      // gave 0 pips for pairs where entry rounds to a whole number (USD/CAD
      // at 1.4 rounds both entry AND TP3 to 1.4 → 0 pip display).
      const rawPipsFromPredictNext = p.tp3DistancePips;
      const tp3Dist = Math.abs((p.takeProfit3 || 0) - (p.entry || 0));
      let bigPipsThreshold, bigPipsDisplay;
      if (pair === 'BTC/USD') {
        bigPipsThreshold = 500;              // 500 USD move on BTC
        bigPipsDisplay = rawPipsFromPredictNext != null ? Math.round(rawPipsFromPredictNext) : Math.round(tp3Dist);
      } else if (pair === 'XAU/USD') {
        bigPipsThreshold = 20;               // 20 USD = 200 pips on gold
        bigPipsDisplay = rawPipsFromPredictNext != null ? Math.round(rawPipsFromPredictNext) : Math.round(tp3Dist * 10);
      } else if (pair.includes('JPY')) {
        bigPipsThreshold = 0.80;             // 80 JPY pips
        bigPipsDisplay = rawPipsFromPredictNext != null ? Math.round(rawPipsFromPredictNext) : Math.round(tp3Dist * 100);
      } else {
        bigPipsThreshold = 0.0080;           // 80 pips FX majors
        bigPipsDisplay = rawPipsFromPredictNext != null ? Math.round(rawPipsFromPredictNext) : Math.round(tp3Dist * 10000);
      }
      const isHighPips = tp3Dist >= bigPipsThreshold;
      if (isHighPips) confluences.push(`🎯 HIGH PIPS: ${bigPipsDisplay}pip target`);

      // Base direction-consensus gates from predict-next
      if (p.confidence >= 85) confluences.push(`predict-next ${p.confidence}% conviction`);
      else missing.push(`predict-next ${p.confidence}% < 85% (need higher conviction)`);
      if (margin >= 30) confluences.push(`${margin}pt factor margin`);
      else missing.push(`only ${margin}pt margin (need ≥30)`);
      if (totalWeight >= 40) confluences.push(`${totalWeight}pt total evidence`);
      else missing.push(`only ${totalWeight}pt evidence (need ≥40)`);

      // v356 — PREMIUM only if EVERYTHING lines up. This is the honest
      // "all sources agree" label. Anything less = strong-read (some signal
      // but partial confirmation) or chart-read (just a direction guess).
      let tier;
      if (missing.length === 0) tier = 'PREMIUM';
      else if (p.confidence >= 75 && missing.length <= 2) tier = 'strong-read';
      else tier = 'chart-read';

      // Build plain-English reasoning — includes confluences + missing so
      // user can see BOTH what's supporting AND what's missing.
      const reasoningParts = [];
      // v363 — Lead with HIGH PIPS badge if applicable (user-requested)
      if (isHighPips) {
        reasoningParts.push(`🎯 HIGH PIPS SETUP · ${bigPipsDisplay}pip target to TP3`);
      }
      if (tier === 'PREMIUM') {
        reasoningParts.push(`✅ PREMIUM ${p.direction} — all confluences aligned (${confluences.length}/6)`);
      } else if (tier === 'strong-read') {
        reasoningParts.push(`⚡ Strong ${p.direction} setup (${confluences.length}/6 confluences · ${missing.length} missing)`);
      } else {
        reasoningParts.push(`📊 Chart read: ${p.direction} direction (${confluences.length}/6 confluences)`);
      }
      const topBull = (f.bullish || []).slice(0, 2).map(x => x.name);
      const topBear = (f.bearish || []).slice(0, 2).map(x => x.name);
      if (p.direction === 'BUY' && topBull.length) reasoningParts.push(`Drivers: ${topBull.join(', ')}`);
      if (p.direction === 'SELL' && topBear.length) reasoningParts.push(`Drivers: ${topBear.join(', ')}`);
      if (missing.length && tier !== 'PREMIUM') {
        reasoningParts.push(`Missing: ${missing.slice(0, 2).join(', ')}`);
      }

      return {
        pair,
        ok: true,
        direction: p.direction,
        confidence: p.confidence,
        tier,
        verdict: p.verdict,
        entry: p.entry,
        sl: p.stopLoss,
        tp1: p.takeProfit1,
        tp2: p.takeProfit2,
        tp3: p.takeProfit3,
        slPips: p.slDistancePips,
        tp3Pips: p.tp3DistancePips,
        slMethod: p.slMethod,
        riskReward: p.riskRewardTP3,
        livePrice: d.livePrice,
        timeHorizon: p.timeHorizon,
        reasoning: reasoningParts.join(' · '),
        // v363 — HIGH PIPS flags for UI badging + ranking
        highPips: isHighPips,
        pipsToTp3: bigPipsDisplay,
        bigPipsThreshold: pair === 'BTC/USD' ? 500
          : pair === 'XAU/USD' ? 200
          : pair.includes('JPY') ? 80 : 80,
        factorScore: { bullWeight, bearWeight, margin, total: totalWeight },
        // v356 — expose the actual confluence + missing checks so UI can
        // render "why PREMIUM" or "what's needed for PREMIUM"
        confluences,
        missing,
        crossCheck: {
          multiSourceVerdict: msDirVerdict,
          multiSourceBoost: msDirBoost,
          vetoActive: isVetoed,
          adx: adxValue,
        },
        topReasons: [
          ...(f.bullish || []).slice(0, 3).map(x => ({ side: 'bull', name: x.name, weight: x.weight })),
          ...(f.bearish || []).slice(0, 3).map(x => ({ side: 'bear', name: x.name, weight: x.weight })),
        ],
        adx: f.adxNote,
      };
    } catch (e) {
      return { pair, ok: false, error: e.message };
    }
  }));

  const active = results.filter(r => r.direction && r.direction !== 'HOLD' && r.confidence >= minConfidence);
  const tierRank = { PREMIUM: 3, 'strong-read': 2, 'chart-read': 1 };
  // v363 — HIGH PIPS get preference WITHIN their tier. Ranking:
  //   1. tier (PREMIUM > strong-read > chart-read)
  //   2. highPips flag (big-target setups first — user priority)
  //   3. confidence
  active.sort((a, b) => {
    const ta = tierRank[a.tier] || 0;
    const tb = tierRank[b.tier] || 0;
    if (ta !== tb) return tb - ta;
    if ((a.highPips ? 1 : 0) !== (b.highPips ? 1 : 0)) return (b.highPips ? 1 : 0) - (a.highPips ? 1 : 0);
    return (b.confidence || 0) - (a.confidence || 0);
  });
  const bestPick = active[0];
  const premiumCount = active.filter(s => s.tier === 'PREMIUM').length;
  const strongCount = active.filter(s => s.tier === 'strong-read').length;
  const highPipsCount = active.filter(s => s.highPips).length;

  return new Response(JSON.stringify({
    ok: true,
    version: 'v363-high-pips-priority',
    minConfidence,
    scanned: PAIRS.length,
    activeSignals: active.length,
    tiers: { PREMIUM: premiumCount, strong: strongCount, standard: active.length - premiumCount - strongCount },
    bestPick,
    highPipsCount,
    signals: active,
    all: results,
    timestamp: new Date().toISOString(),
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=45',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
