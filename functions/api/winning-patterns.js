// /api/winning-patterns — v320 ML insights endpoint.
//
// Surfaces what the brain has actually learned: which strategy combinations,
// which hours, which regimes, and which pairs are producing wins vs losses
// from REAL live outcomes (not just backtest). This is the transparent
// window into the machine learning — you see exactly what patterns work.

export async function onRequest(context) {
  const { env } = context;
  if (!env.TRADES_KV) return _err('KV not bound');

  try {
    const raw = await env.TRADES_KV.get('learning-brain');
    if (!raw) return _err('brain not initialized');
    const brain = JSON.parse(raw);

    // Aggregate by combo across all pairs + live outcomes
    const combos = [];
    for (const [pair, pairData] of Object.entries(brain.byPairLive || {})) {
      for (const [comboKey, stats] of Object.entries(pairData.byCombo || {})) {
        const n = (stats.w || 0) + (stats.l || 0);
        if (n < 3) continue;
        const wr = stats.w / n;
        // Wilson lower bound for confidence interval (proper statistical WR)
        const wilson = _wilsonLowerBound(stats.w, n);
        combos.push({
          pair,
          combo: comboKey,
          samples: n,
          wins: stats.w,
          losses: stats.l,
          winRate: Math.round(wr * 100),
          wilsonLower: Math.round(wilson * 100),  // conservative WR estimate
          verdict: _classify(wr, n, wilson),
        });
      }
    }

    // Sort by Wilson lower bound (most statistically-confident winners first)
    combos.sort((a, b) => b.wilsonLower - a.wilsonLower);

    // Top winners (Wilson ≥55%) and top losers (Wilson ≤35%)
    const winners = combos.filter(c => c.wilsonLower >= 55).slice(0, 15);
    const losers = combos.filter(c => c.wilsonLower <= 35 && c.samples >= 5).slice(-10);

    // Cross-pair combo aggregates (universal patterns)
    const universalCombos = [];
    for (const [comboKey, stats] of Object.entries(brain.byCombo || {})) {
      const n = (stats.w || 0) + (stats.l || 0);
      if (n < 20) continue;
      const wr = stats.w / n;
      const wilson = _wilsonLowerBound(stats.w, n);
      universalCombos.push({
        combo: comboKey,
        samples: n,
        winRate: Math.round(wr * 100),
        wilsonLower: Math.round(wilson * 100),
      });
    }
    universalCombos.sort((a, b) => b.wilsonLower - a.wilsonLower);

    // Hourly performance (best/worst hours to trade)
    const hourStats = [];
    for (const [hour, stats] of Object.entries(brain.byHour || {})) {
      const n = (stats.w || 0) + (stats.l || 0);
      if (n < 10) continue;
      hourStats.push({
        hour: parseInt(hour, 10),
        samples: n,
        winRate: Math.round((stats.w / n) * 100),
      });
    }
    hourStats.sort((a, b) => b.winRate - a.winRate);

    // Recent live-outcome momentum (last 20)
    const recentOutcomes = (brain.liveOutcomeHistory || []).slice(0, 20);
    const recentWins = recentOutcomes.filter(o => o.outcome === 'won').length;
    const recentTotal = recentOutcomes.length;
    const recentWR = recentTotal ? Math.round((recentWins / recentTotal) * 100) : 0;

    // Learning stats
    const stats = {
      brainRuns: brain.runs || 0,
      totalSamples: brain.totalSamples || 0,
      lessonsLearned: brain.lessons?.totalRecorded || 0,
      winsStudied: brain.winsStudied?.totalRecorded || 0,
      pairsCovered: Object.keys(brain.byPair || {}).length,
      lastUpdated: brain.lastUpdated,
      lastLiveOutcomeAt: brain.lastLiveOutcomeAt,
    };

    return _json({
      ok: true,
      version: 'v320-winning-patterns',
      stats,
      recent: {
        outcomes: recentOutcomes.slice(0, 10),
        wins: recentWins,
        total: recentTotal,
        winRate: recentWR,
      },
      topWinners: winners,
      topLosers: losers,
      universalPatterns: universalCombos.slice(0, 10),
      bestHours: hourStats.slice(0, 5),
      worstHours: hourStats.slice(-5).reverse(),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return _err('failed: ' + e.message);
  }
}

// Wilson score lower bound (95% CI) — trustworthy WR estimate that
// accounts for sample size. Standard stat approach for proportions.
function _wilsonLowerBound(wins, n) {
  if (n === 0) return 0;
  const z = 1.96;  // 95% confidence
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const num = p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, num / denom);
}

function _classify(wr, n, wilson) {
  if (wilson >= 0.65) return 'PROVEN WINNER';
  if (wilson >= 0.55) return 'winner';
  if (wilson >= 0.45) return 'neutral';
  if (wilson >= 0.35) return 'weak';
  return 'AVOID';
}

function _json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function _err(msg) {
  return _json({ ok: false, error: msg }, 200);
}
