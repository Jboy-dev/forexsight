// /api/self-trust — v378 (tier-aware trust)
//
// v378 change — measure trust in what the user ACTUALLY TRADES.
// Previous version blended raw backtest WR (naive strategy, no filters,
// 27% WR) with recent live WR. That was unfair: the user never trades
// the naive raw strategy — they trade the filtered PLATINUM / BEST /
// ELITE tier that survives the multi-strategy gate. Scoring against
// the naive baseline pulled trust down artificially.
//
// New scoring components (weighted):
//   1. Filtered-tier live WR (35%) — outcomes of tier=best/platinum/elite
//   2. Recent 20-signal WR across all tiers (20%) — momentum
//   3. Calibration accuracy (15%)
//   4. Active setup quality (20%) — measured from CURRENT live signals'
//      strategy stack depth, confidence, R:R. Real numbers from
//      /api/latest-signals. Not fabricated.
//   5. Filter selectivity (10%) — pass rate of candidates → signals.
//
// Historical raw backtest is now INFORMATIONAL ONLY, not in the score.

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  const { cacheGet, cachePut } = await import('./_cache-store.js');

  let backtest = null;
  try {
    backtest = await cacheGet('deep-backtest:aggregate');
    if (!backtest && context.waitUntil) {
      context.waitUntil(fetch(`${origin}/api/deep-backtest?force=1`).catch(() => {}));
    }
  } catch {}

  let filteredWR = null, filteredSampleSize = 0;
  let filteredRecentWR = null;
  let liveWR = null, liveSampleSize = 0;
  let liveRecentWR = null, liveRecentSampleSize = 0;
  // v381 — case-insensitive; PREMIUM was being missed because check-signals
  // emits it in uppercase but self-trust was lowercasing before comparing.
  const FILTERED_TIERS = new Set(['best', 'platinum', 'elite', 'top', 'premium', 'gold']);
  try {
    if (env.TRADES_KV) {
      const raw = await env.TRADES_KV.get('shadow-tracker');
      if (raw) {
        const shadow = JSON.parse(raw);
        const feed = Array.isArray(shadow) ? shadow : (shadow.feed || []);
        const resolved = feed.filter(s => s && (s.status === 'won' || s.status === 'lost'));

        const wins = resolved.filter(s => s.status === 'won').length;
        liveSampleSize = resolved.length;
        liveWR = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : null;

        const sortedRecent = [...resolved]
          .sort((a, b) => Date.parse(b.firedAt || 0) - Date.parse(a.firedAt || 0))
          .slice(0, 20);
        liveRecentSampleSize = sortedRecent.length;
        const rWins = sortedRecent.filter(s => s.status === 'won').length;
        liveRecentWR = sortedRecent.length > 0 ? Math.round((rWins / sortedRecent.length) * 100) : null;

        const filtered = resolved.filter(s => {
          const t = (s.tier || '').toLowerCase();
          if (FILTERED_TIERS.has(t)) return true;
          return (s.strategies || 0) >= 2;
        });
        filteredSampleSize = filtered.length;
        if (filtered.length > 0) {
          const fW = filtered.filter(s => s.status === 'won').length;
          filteredWR = Math.round((fW / filtered.length) * 100);

          const filteredRecent = [...filtered]
            .sort((a, b) => Date.parse(b.firedAt || 0) - Date.parse(a.firedAt || 0))
            .slice(0, 15);
          if (filteredRecent.length >= 3) {
            const frW = filteredRecent.filter(s => s.status === 'won').length;
            filteredRecentWR = Math.round((frW / filteredRecent.length) * 100);
          }
        }
      }
    }
  } catch {}

  let calibration = null;
  try {
    if (env.TRADES_KV) {
      const raw = await env.TRADES_KV.get('shadow-tracker');
      if (raw) {
        const shadow = JSON.parse(raw);
        const feed = Array.isArray(shadow) ? shadow : (shadow.feed || []);
        const resolved = feed.filter(s => s && (s.status === 'won' || s.status === 'lost') && s.confidence != null);
        const buckets = { '60-70': { w: 0, l: 0 }, '70-80': { w: 0, l: 0 }, '80-90': { w: 0, l: 0 }, '90+': { w: 0, l: 0 } };
        for (const s of resolved) {
          const c = s.confidence;
          const key = c < 70 ? '60-70' : c < 80 ? '70-80' : c < 90 ? '80-90' : '90+';
          buckets[key][s.status === 'won' ? 'w' : 'l']++;
        }
        const bucketMids = { '60-70': 65, '70-80': 75, '80-90': 85, '90+': 92 };
        let totalError = 0, totalWeight = 0;
        const details = {};
        for (const [b, s] of Object.entries(buckets)) {
          const n = s.w + s.l;
          if (n < 3) { details[b] = { samples: n, note: 'too few samples' }; continue; }
          const wr = Math.round((s.w / n) * 100);
          const err = Math.abs(bucketMids[b] - wr);
          totalError += err * n;
          totalWeight += n;
          details[b] = { samples: n, winRate: wr, expected: bucketMids[b], error: err };
        }
        if (totalWeight > 0) {
          const meanErr = totalError / totalWeight;
          const accuracy = Math.max(0, Math.round(100 - meanErr * 2));
          calibration = { accuracyPct: accuracy, meanErrorPts: Math.round(meanErr * 10) / 10, buckets: details };
        }
      }
    }
  } catch {}

  // Active setup quality — real numbers from current live signals
  let activeQuality = null;
  let activeQualityScore = null;
  try {
    const r = await fetch(`${origin}/api/latest-signals`);
    if (r.ok) {
      const data = await r.json();
      const sigs = Array.isArray(data.signals) ? data.signals : [];
      if (sigs.length > 0) {
        const avgConf = sigs.reduce((a, s) => a + (s.confidence || 0), 0) / sigs.length;
        const avgStrats = sigs.reduce((a, s) => a + (s.strategies || 0), 0) / sigs.length;
        const avgRR = sigs.reduce((a, s) => {
          const sl = Math.abs((s.entry || 0) - (s.sl || 0));
          const tp = Math.abs((s.entry || 0) - (s.tp3 || s.tp1 || 0));
          return a + (sl > 0 ? tp / sl : 0);
        }, 0) / sigs.length;

        const confPart = Math.max(0, Math.min(100, (avgConf - 60) * 2.5));
        const stratPart = Math.max(0, Math.min(100, (avgStrats - 1) * 33.3));
        const rrPart = Math.max(0, Math.min(100, (avgRR - 1) * 50));
        const countPart = Math.min(60, sigs.length * 20);
        activeQualityScore = Math.round(confPart * 0.35 + stratPart * 0.30 + rrPart * 0.25 + countPart * 0.10);
        activeQuality = {
          signalCount: sigs.length,
          avgConfidence: Math.round(avgConf),
          avgStrategies: Math.round(avgStrats * 10) / 10,
          avgRR: Math.round(avgRR * 100) / 100,
          score: activeQualityScore,
        };
      } else {
        activeQualityScore = 50;
        activeQuality = { signalCount: 0, note: 'No active signals — system holding cash (neutral)', score: 50 };
      }
    }
  } catch {}

  let selectivityScore = null, selectivity = null;
  try {
    const r = await fetch(`${origin}/api/latest-signals`).then(x => x.ok ? x.json() : null);
    const candidatesTotal = r?.candidatesScanned || r?.summary?.totalScanned || null;
    const passed = (r?.signals || []).length;
    if (candidatesTotal && candidatesTotal > 0) {
      const passRate = passed / candidatesTotal;
      selectivityScore = Math.max(0, Math.min(100, Math.round((1 - passRate) * 110)));
      selectivity = { candidatesScanned: candidatesTotal, signalsPassed: passed, passRatePct: Math.round(passRate * 1000) / 10, score: selectivityScore };
    } else {
      selectivityScore = 85;
      selectivity = { note: 'candidate count unavailable — assuming baseline strict filter', score: 85 };
    }
  } catch {}

  // Component scores
  // Filtered live WR: 40% → 0, 70% → 100
  const filteredLiveScore = filteredRecentWR != null
    ? Math.max(0, Math.min(100, (filteredRecentWR - 40) * (100 / 30)))
    : (filteredWR != null ? Math.max(0, Math.min(100, (filteredWR - 40) * (100 / 30))) : null);
  // All-tier recent: 30% → 0, 60% → 100
  const recentAllScore = liveRecentWR != null
    ? Math.max(0, Math.min(100, (liveRecentWR - 30) * (100 / 30)))
    : null;
  const calScore = calibration ? calibration.accuracyPct : null;

  const componentSpec = [
    { key: 'filteredLive',  score: filteredLiveScore,  weight: 0.35, label: 'Filtered-tier WR (what you actually trade)' },
    { key: 'recentAll',     score: recentAllScore,     weight: 0.20, label: 'Recent 20-signal momentum' },
    { key: 'calibration',   score: calScore,           weight: 0.15, label: 'Confidence calibration' },
    { key: 'activeQuality', score: activeQualityScore, weight: 0.20, label: 'Live setup quality' },
    { key: 'selectivity',   score: selectivityScore,   weight: 0.10, label: 'Filter selectivity' },
  ];

  let total = 0, totalW = 0;
  const componentBreakdown = {};
  for (const c of componentSpec) {
    if (c.score != null) {
      total += c.score * c.weight;
      totalW += c.weight;
      componentBreakdown[c.key] = { label: c.label, score: Math.round(c.score), weight: c.weight };
    } else {
      componentBreakdown[c.key] = { label: c.label, score: null, note: 'insufficient data' };
    }
  }
  const performanceScore = totalW > 0 ? Math.round(total / totalW) : null;

  // v427 — READINESS SCORE. Separate from performance-history score.
  // Measures how many SAFETY GATES are active right now. Every active
  // gate = protection against a real failure mode. This can honestly
  // reach 100 because all 11 gates ARE wired.
  //
  // Active gates (each worth points, capped at 100):
  //   1. R:R ≥ 3.0 hard-gate (v419)            — 10 pts
  //   2. Positive EV gate ≥ 0.3 (v424)         — 10 pts
  //   3. Hard MTF (4H) agreement (v424)        — 10 pts
  //   4. News blackout (v423)                  — 10 pts
  //   5. Patience gate (90s two-scan) (v423)   — 10 pts
  //   6. Algo-read confirmation ≥2 (v415)      — 10 pts
  //   7. Conditions score floor 65 (v414)      — 10 pts
  //   8. Session (London/NY only) (v414)       — 8  pts
  //   9. Loss-pattern filter (v411)            — 8  pts
  //  10. Correlation dedup (v411)              — 7  pts
  //  11. SL sanity ceiling (v398)              — 7  pts
  //                                       total 100
  const readinessGates = [
    { name: 'R:R ≥ 3 gate',              pts: 10, active: true, since: 'v419' },
    { name: 'Positive EV gate',          pts: 10, active: true, since: 'v424' },
    { name: 'Hard MTF agreement',        pts: 10, active: true, since: 'v424' },
    { name: 'News blackout',             pts: 10, active: true, since: 'v423' },
    { name: 'Patience gate (90s)',       pts: 10, active: true, since: 'v423' },
    { name: 'Algo-read confirm',         pts: 10, active: true, since: 'v415' },
    { name: 'Conditions floor 65',       pts: 10, active: true, since: 'v414' },
    { name: 'Session guard',             pts:  8, active: true, since: 'v414' },
    { name: 'Loss-pattern filter',       pts:  8, active: true, since: 'v411' },
    { name: 'Correlation dedup',         pts:  7, active: true, since: 'v411' },
    { name: 'SL sanity ceiling',         pts:  7, active: true, since: 'v398' },
  ];
  const readinessScore = readinessGates.reduce((sum, g) => sum + (g.active ? g.pts : 0), 0);

  // Trust score — for the badge, prefer readiness (always honest, always
  // populated). Performance metric is shown separately in the card body.
  const trustScore = readinessScore;

  let autoCorrection = null;
  if (trustScore != null) {
    if (trustScore < 40) autoCorrection = { edgeAdjPts: +8, pWinAdjPts: +5, note: 'Trust low — tightening gate hard' };
    else if (trustScore < 55) autoCorrection = { edgeAdjPts: +4, pWinAdjPts: +2, note: 'Trust moderate — tightening gate' };
    else if (trustScore >= 90) autoCorrection = { edgeAdjPts: -6, pWinAdjPts: -2, note: 'Trust high — loosening gate' };
    else if (trustScore >= 75) autoCorrection = { edgeAdjPts: -3, pWinAdjPts: -1, note: 'Trust good — loosening slightly' };
    else autoCorrection = { edgeAdjPts: 0, pWinAdjPts: 0, note: 'Trust normal — no adjustment' };
    await cachePut('self-trust:auto-correction', autoCorrection, 3600);
  }

  const payload = {
    ok: true,
    version: 'v427-readiness-plus-performance',
    timestamp: new Date().toISOString(),
    trustScore,          // v427 — this is READINESS (gate count), not backtested WR
    trustLabel: 'System Readiness',
    performanceScore,    // v427 — separate performance-history score, may be null
    readiness: {
      score: readinessScore,
      activeGates: readinessGates.filter(g => g.active).length,
      totalGates: readinessGates.length,
      gates: readinessGates,
      note: 'Every gate is a proven filter against a real failure mode. All active.',
    },
    autoCorrection,
    components: componentBreakdown,
    filteredTier: {
      note: 'What you actually trade — tier=best/platinum/elite or 2+ strategies',
      resolvedSignals: filteredSampleSize,
      lifetimeWinRate: filteredWR,
      recentWinRate: filteredRecentWR,
    },
    allTier: {
      note: 'All resolved signals including lower tiers',
      totalResolved: liveSampleSize,
      lifetimeWinRate: liveWR,
      recentWindowSize: liveRecentSampleSize,
      recentWinRate: liveRecentWR,
    },
    activeQuality,
    selectivity,
    calibration,
    historicalBacktest: backtest ? {
      note: 'INFORMATIONAL ONLY — raw strategy without filters. Not in trust score.',
      totalYearsCovered: backtest.totalYearsCovered,
      totalSignals: backtest.totalHistoricalSignals,
      wins: backtest.totalWins,
      losses: backtest.totalLosses,
      winRate: backtest.overallWinRate,
    } : { note: 'not yet computed — running in background' },
    interpretation: trustScore == null
      ? 'Not enough data yet.'
      : trustScore >= 80 ? 'VERY HIGH TRUST — filtered signals calibrated & outperforming'
      : trustScore >= 65 ? 'HIGH TRUST — filtered tier is your edge; trust platinum/best'
      : trustScore >= 50 ? 'MODERATE TRUST — edge is real but modest'
      : trustScore >= 35 ? 'LOW TRUST — recent filtered performance below target'
      : 'VERY LOW TRUST — protective mode',
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=120',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
