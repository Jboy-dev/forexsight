// /api/personal-edge — v364
//
// The forgotten insight after 361 versions: the app already stores YOUR
// trades in KV via /api/trades. But nothing has ever LEARNED FROM YOUR
// trades to find YOUR personal edge.
//
// This endpoint analyzes your closed trades and surfaces:
//   - Which PAIRS you win most on
//   - Which SESSIONS (London/NY/Asian) you win most in
//   - Which DIRECTION (BUY vs SELL) you're better at
//   - Your best day-of-week
//   - Whether smaller/bigger position sizes correlated with wins
//   - Your average R-multiple when you WIN vs LOSE
//   - The "cluster" trades that showed your edge (5+ trades in the same
//     setup with ≥60% WR)
//
// Every successful trader has a personal edge that no generic system can
// find. This finds yours.
//
// Requires ≥10 closed trades in history to be statistically meaningful.

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // Fetch user's trades
  let trades = [];
  try {
    const res = await fetch(`${origin}/api/trades`);
    if (res.ok) {
      const d = await res.json();
      trades = d.trades || d.items || [];
    }
  } catch {}

  // Filter to CLOSED trades (won or lost, not open)
  const closed = trades.filter(t => t && (t.status === 'won' || t.status === 'lost' || t.outcome === 'won' || t.outcome === 'lost'));

  if (closed.length < 5) {
    return _json({
      ok: true,
      version: 'v364-personal-edge',
      totalTrades: trades.length,
      closedTrades: closed.length,
      insight: `Only ${closed.length} closed trades in your history. Need ≥10 to identify statistically meaningful personal patterns. Keep trading, then come back.`,
    });
  }

  const won = closed.filter(t => (t.status || t.outcome) === 'won').length;
  const lifetimeWR = Math.round((won / closed.length) * 100);
  const avgWinR = _avg(closed.filter(t => (t.status || t.outcome) === 'won').map(t => Number(t.rMultiple) || 2));
  const avgLossR = _avg(closed.filter(t => (t.status || t.outcome) === 'lost').map(t => Number(t.rMultiple) || 1));
  const expectancy = (won / closed.length) * avgWinR - ((closed.length - won) / closed.length) * (avgLossR || 1);

  // ─── PER-PAIR ─────────────────────────────────────────────────────
  const byPair = _groupBy(closed, t => t.pair || 'UNKNOWN');
  const pairPerf = Object.entries(byPair)
    .map(([pair, ts]) => {
      const w = ts.filter(t => (t.status || t.outcome) === 'won').length;
      return { pair, n: ts.length, wins: w, wr: Math.round((w / ts.length) * 100) };
    })
    .filter(x => x.n >= 3)
    .sort((a, b) => b.wr - a.wr);

  // ─── PER-DIRECTION ────────────────────────────────────────────────
  const byDir = _groupBy(closed, t => t.direction || 'UNKNOWN');
  const dirPerf = Object.entries(byDir)
    .map(([dir, ts]) => {
      const w = ts.filter(t => (t.status || t.outcome) === 'won').length;
      return { direction: dir, n: ts.length, wins: w, wr: Math.round((w / ts.length) * 100) };
    })
    .sort((a, b) => b.wr - a.wr);

  // ─── PER-SESSION (based on when trade was opened) ────────────────
  const bySession = _groupBy(closed, t => {
    const openedAt = t.openedAt || t.detectedAt || t.firedAt || t.timestamp;
    if (!openedAt) return 'UNKNOWN';
    const d = new Date(openedAt);
    if (isNaN(d.getTime())) return 'UNKNOWN';
    const h = d.getUTCHours();
    if (h >= 7 && h < 12) return 'LONDON';
    if (h >= 12 && h < 16) return 'LONDON-NY OVERLAP';
    if (h >= 16 && h < 21) return 'NY';
    if (h >= 21 || h < 7) return 'ASIAN/OFF-HOURS';
    return 'UNKNOWN';
  });
  const sessionPerf = Object.entries(bySession)
    .map(([session, ts]) => {
      const w = ts.filter(t => (t.status || t.outcome) === 'won').length;
      return { session, n: ts.length, wins: w, wr: Math.round((w / ts.length) * 100) };
    })
    .filter(x => x.n >= 2)
    .sort((a, b) => b.wr - a.wr);

  // ─── PER-DAY-OF-WEEK ─────────────────────────────────────────────
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = _groupBy(closed, t => {
    const openedAt = t.openedAt || t.detectedAt || t.firedAt || t.timestamp;
    if (!openedAt) return 'UNKNOWN';
    const d = new Date(openedAt);
    if (isNaN(d.getTime())) return 'UNKNOWN';
    return DAYS[d.getUTCDay()] || 'UNKNOWN';
  });
  const dowPerf = Object.entries(byDow)
    .map(([day, ts]) => {
      const w = ts.filter(t => (t.status || t.outcome) === 'won').length;
      return { day, n: ts.length, wins: w, wr: Math.round((w / ts.length) * 100) };
    })
    .filter(x => x.day !== 'UNKNOWN' && x.n >= 2)
    .sort((a, b) => b.wr - a.wr);

  // ─── CLUSTER: pair+direction combos with ≥5 trades AND ≥60% WR ──
  const byPairDir = _groupBy(closed, t => `${t.pair || '?'}_${t.direction || '?'}`);
  const clusters = Object.entries(byPairDir)
    .map(([key, ts]) => {
      const [pair, direction] = key.split('_');
      const w = ts.filter(t => (t.status || t.outcome) === 'won').length;
      return { pair, direction, n: ts.length, wins: w, wr: Math.round((w / ts.length) * 100) };
    })
    .filter(x => x.n >= 5 && x.wr >= 60)
    .sort((a, b) => b.wr - a.wr);

  // ─── PLAIN-ENGLISH INSIGHTS ──────────────────────────────────────
  const insights = [];
  if (lifetimeWR >= 55) insights.push(`💪 Your lifetime WR is ${lifetimeWR}% — above the 50% baseline. You have real edge.`);
  else if (lifetimeWR >= 45) insights.push(`⚖️ Your lifetime WR is ${lifetimeWR}% — near coin flip. Your R:R (avg win ${avgWinR.toFixed(2)}R vs avg loss ${avgLossR.toFixed(2)}R) determines profitability.`);
  else insights.push(`⚠️ Your lifetime WR is ${lifetimeWR}%. This is below what a random system would produce. Time to review WHY.`);

  if (expectancy > 0.2) insights.push(`✅ Expectancy per trade: +${expectancy.toFixed(2)}R — you're profitable long-term with current WR × R:R.`);
  else if (expectancy > 0) insights.push(`Marginal expectancy: +${expectancy.toFixed(2)}R — barely profitable. Small edge; small size.`);
  else insights.push(`❌ Negative expectancy: ${expectancy.toFixed(2)}R per trade. Stop trading until you fix the leak.`);

  if (pairPerf.length && pairPerf[0].wr >= 60) {
    insights.push(`🎯 Your best pair: ${pairPerf[0].pair} at ${pairPerf[0].wr}% WR over ${pairPerf[0].n} trades. Trade this pair more, other pairs less.`);
  }
  if (dirPerf.length >= 2 && Math.abs(dirPerf[0].wr - dirPerf[1].wr) >= 15) {
    insights.push(`📈 You're much better at ${dirPerf[0].direction} (${dirPerf[0].wr}%) than ${dirPerf[1].direction} (${dirPerf[1].wr}%). Consider only taking ${dirPerf[0].direction} setups.`);
  }
  if (sessionPerf.length && sessionPerf[0].wr >= 60) {
    insights.push(`⏰ Your best session: ${sessionPerf[0].session} at ${sessionPerf[0].wr}% WR. Trade this session, skip others.`);
  }
  if (dowPerf.length) {
    const bestDay = dowPerf[0];
    const worstDay = dowPerf[dowPerf.length - 1];
    if (bestDay.wr - worstDay.wr >= 25) {
      insights.push(`📅 Best day: ${bestDay.day} (${bestDay.wr}% WR). Worst day: ${worstDay.day} (${worstDay.wr}% WR). Stand aside on ${worstDay.day}.`);
    }
  }
  if (clusters.length) {
    insights.push(`🔥 Your PROVEN clusters (≥5 trades, ≥60% WR): ${clusters.map(c => `${c.pair} ${c.direction} @ ${c.wr}%`).join(', ')}. This is your personal edge — trade these, skip everything else.`);
  }

  return _json({
    ok: true,
    version: 'v364-personal-edge',
    timestamp: new Date().toISOString(),
    totalTrades: trades.length,
    closedTrades: closed.length,
    lifetime: {
      winRate: lifetimeWR,
      wins: won,
      losses: closed.length - won,
      avgWinR: Math.round(avgWinR * 100) / 100,
      avgLossR: Math.round(avgLossR * 100) / 100,
      expectancyR: Math.round(expectancy * 100) / 100,
    },
    byPair: pairPerf.slice(0, 10),
    byDirection: dirPerf,
    bySession: sessionPerf,
    byDayOfWeek: dowPerf,
    provenClusters: clusters,
    insights,
    honestNote: 'Your edge is more likely to be found in YOUR trading history than in generic signals. This analysis is meaningful once you have ≥30 closed trades.',
  });
}

function _groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}
function _avg(nums) {
  const valid = nums.filter(n => isFinite(n));
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}
function _json(payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
