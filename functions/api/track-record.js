// /api/track-record — v367
//
// The trustworthiness endpoint: every signal ever fired, every outcome,
// grouped by tier so you can see EXACTLY how the system performs. No
// aggregate averages that hide the truth — separate WR for:
//
//   1. ELITE tier (v366, all-10-gate signals) — the ones we tell you to take
//   2. Strong-read (multi-source CONFIRM + 5/6 confluences)
//   3. Chart-read (direction predictions only)
//   4. Overall (everything)
//
// Also: last 30 days rolling · last 7 days rolling · last 24h.
//
// A trading system earns trust by SHOWING its work, not by claiming to be
// smart. This endpoint is the "show your work" for the whole app.

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);

  // Fetch shadow-tracker (all signals fired with outcomes)
  let shadow = [];
  try {
    if (env.TRADES_KV) {
      const raw = await env.TRADES_KV.get('shadow-tracker');
      if (raw) {
        const parsed = JSON.parse(raw);
        shadow = Array.isArray(parsed) ? parsed : (parsed.feed || []);
      }
    }
  } catch { }

  const resolved = shadow.filter(s =>
    s && (s.status === 'won' || s.status === 'lost' || s.status === 'expired')
  );

  const now = Date.now();
  const _hoursAgo = (h) => now - h * 3600 * 1000;
  const _tierOf = (s) => {
    // Prefer explicit tier field; fall back to inferring from source/confidence
    if (s.tier === 'ELITE' || s.source === 'elite-signal') return 'ELITE';
    if (s.tier === 'PREMIUM') return 'PREMIUM';
    if (s.tier === 'strong-read') return 'strong-read';
    if (s.tier === 'chart-read') return 'chart-read';
    // Legacy signals without tier: infer from strategies count
    if ((s.strategies || 0) >= 2 && (s.confidence || 0) >= 65) return 'PREMIUM';
    return 'chart-read';
  };

  const _statsFor = (arr) => {
    const n = arr.length;
    if (n === 0) return { n: 0, wins: 0, losses: 0, wr: null };
    const wins = arr.filter(s => s.status === 'won').length;
    const losses = arr.filter(s => s.status === 'lost').length;
    return {
      n,
      wins,
      losses,
      wr: Math.round((wins / n) * 100),
    };
  };

  const _withinLastHours = (arr, hours) => arr.filter(s => {
    const t = Date.parse(s.firedAt || s.detectedAt || s.timestamp || 0);
    return Number.isFinite(t) && t >= _hoursAgo(hours);
  });

  // ─── Per-tier breakdown ────────────────────────────────────────
  const byTier = { ELITE: [], PREMIUM: [], 'strong-read': [], 'chart-read': [] };
  for (const s of resolved) {
    const t = _tierOf(s);
    if (byTier[t]) byTier[t].push(s);
  }

  const tiers = {};
  for (const [tier, arr] of Object.entries(byTier)) {
    tiers[tier] = {
      lifetime: _statsFor(arr),
      last30d: _statsFor(_withinLastHours(arr, 30 * 24)),
      last7d: _statsFor(_withinLastHours(arr, 7 * 24)),
      last24h: _statsFor(_withinLastHours(arr, 24)),
    };
  }

  // ─── Recent 20 outcomes across ALL tiers (audit trail) ────────
  const recent20 = resolved
    .slice()
    .sort((a, b) => Date.parse(b.firedAt || 0) - Date.parse(a.firedAt || 0))
    .slice(0, 20)
    .map(s => ({
      pair: s.pair,
      direction: s.direction,
      tier: _tierOf(s),
      status: s.status,
      firedAt: s.firedAt,
      confidence: s.confidence,
      pips: s.pipsResult || s.pipsToTp3 || null,
    }));

  // ─── Recovery mechanism: streak detection ────────────────────
  const lastN = resolved
    .slice()
    .sort((a, b) => Date.parse(b.firedAt || 0) - Date.parse(a.firedAt || 0))
    .slice(0, 10);
  const lastNStatuses = lastN.map(s => s.status);
  const winStreak = _streak(lastNStatuses, 'won');
  const lossStreak = _streak(lastNStatuses, 'lost');

  let recoveryStatus = null;
  if (winStreak >= 5) {
    recoveryStatus = { state: 'hot', streak: winStreak, msg: `🔥 ${winStreak} wins in a row — system is dialed in. Consider slightly larger size on next elite signal.` };
  } else if (winStreak >= 3) {
    recoveryStatus = { state: 'warming', streak: winStreak, msg: `📈 ${winStreak} recent wins — trust rebuilding.` };
  } else if (lossStreak >= 4) {
    recoveryStatus = { state: 'cold', streak: lossStreak, msg: `🧊 ${lossStreak} recent losses — system auto-pausing elite mode. Stand aside for next 3+ signals.` };
  } else if (lossStreak >= 2) {
    recoveryStatus = { state: 'cooling', streak: lossStreak, msg: `⚠️ ${lossStreak} recent losses — cut size in half until next win.` };
  } else {
    recoveryStatus = { state: 'normal', msg: 'Neither hot nor cold — normal execution.' };
  }

  // Overall
  const overall = {
    lifetime: _statsFor(resolved),
    last30d: _statsFor(_withinLastHours(resolved, 30 * 24)),
    last7d: _statsFor(_withinLastHours(resolved, 7 * 24)),
    last24h: _statsFor(_withinLastHours(resolved, 24)),
  };

  return new Response(JSON.stringify({
    ok: true,
    version: 'v367-track-record',
    timestamp: new Date().toISOString(),
    overall,
    byTier: tiers,
    recovery: recoveryStatus,
    recent20,
    trustworthy: {
      totalResolved: resolved.length,
      firstOutcomeAt: resolved.length > 0 ? _firstFiredAt(resolved) : null,
      auditPolicy: 'EVERY signal fired, EVERY outcome — no cherry-picking. If it fired, it counts. Losses stay visible. This is how trust is earned.',
    },
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function _streak(statuses, target) {
  let n = 0;
  for (const s of statuses) {
    if (s === target) n++;
    else break;
  }
  return n;
}

function _firstFiredAt(arr) {
  let minTs = Infinity;
  for (const s of arr) {
    const t = Date.parse(s.firedAt || 0);
    if (Number.isFinite(t) && t < minTs) minTs = t;
  }
  return minTs === Infinity ? null : new Date(minTs).toISOString();
}
