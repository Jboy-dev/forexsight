// /api/veto-status — v337 transparency endpoint.
//
// Shows exactly which pair+direction and combo patterns are currently
// blocked from producing signals. Lets the user verify at any moment
// that the autopsy-driven veto is doing its job.
//
// Combines shadow-tracker outcomes with the same rules used in
// check-signals so what you see here is EXACTLY what the scan enforces.

export async function onRequest(context) {
  const { env } = context;
  if (!env.TRADES_KV) return _json({ ok: false, error: 'KV not bound' }, 500);

  const raw = await env.TRADES_KV.get('shadow-tracker').catch(() => null);
  if (!raw) return _json({ ok: true, blocks: [], reason: 'no shadow data yet' });

  let shadow;
  try { shadow = JSON.parse(raw); } catch { return _json({ ok: false, error: 'shadow parse fail' }, 500); }

  const feed = Array.isArray(shadow) ? shadow : (shadow.feed || []);
  const resolved = feed.filter(s => s && (s.status === 'won' || s.status === 'lost'));

  // Same derivation as check-signals v335
  const deriveCombo = (s) => {
    if (s.comboKey) return s.comboKey;
    if (Array.isArray(s.namedStrategies) && s.namedStrategies.length) {
      return `${s.direction}_${s.namedStrategies.slice().sort().join('+')}`;
    }
    return 'ANY';
  };

  // Group and sort by timestamp
  const byCombo = {};
  const byPairDir = {};
  for (const s of resolved) {
    const combo = deriveCombo(s);
    const cKey = `${s.pair}_${s.direction}_${combo}`;
    const pKey = `${s.pair}_${s.direction}`;
    if (!byCombo[cKey]) byCombo[cKey] = [];
    if (!byPairDir[pKey]) byPairDir[pKey] = [];
    const rec = { status: s.status, firedAt: s.firedAt };
    byCombo[cKey].push(rec);
    byPairDir[pKey].push(rec);
  }
  const sortByTs = (arr) => arr.sort((a, b) => {
    const ta = a.firedAt ? Date.parse(a.firedAt) : 0;
    const tb = b.firedAt ? Date.parse(b.firedAt) : 0;
    return ta - tb;
  });
  // v355 — 48h recency filter: mirror the check-signals veto so this
  // endpoint shows exactly what the scanner enforces. Old losses in a
  // different market regime no longer count toward blocking.
  const VETO_RECENCY_MS = 48 * 3600 * 1000;
  const recentOnly = (arr) => {
    const cutoff = Date.now() - VETO_RECENCY_MS;
    return arr.filter(x => {
      if (!x.firedAt) return false;
      const t = Date.parse(x.firedAt);
      return Number.isFinite(t) && t >= cutoff;
    });
  };

  const comboBlocks = [];
  for (const [key, arr] of Object.entries(byCombo)) {
    const outcomes = sortByTs(recentOnly(arr));
    const last4 = outcomes.slice(-4);
    const losses = last4.filter(o => o.status === 'lost').length;
    const shouldVeto =
      (last4.length === 2 && losses === 2) ||
      (last4.length === 3 && losses >= 2) ||
      (last4.length >= 3 && losses >= 3);
    if (shouldVeto) {
      const [pair, direction, combo] = key.split('_', 3);
      comboBlocks.push({
        key,
        pair,
        direction,
        combo: key.replace(`${pair}_${direction}_`, ''),
        recentLosses: losses,
        recentTotal: last4.length,
        lastOutcomes: last4.map(o => o.status),
      });
    }
  }

  const pairDirBlocks = [];
  for (const [key, arr] of Object.entries(byPairDir)) {
    const outcomes = sortByTs(recentOnly(arr));
    const last4 = outcomes.slice(-4);
    const losses = last4.filter(o => o.status === 'lost').length;
    if ((last4.length === 3 && losses >= 3) || (last4.length >= 4 && losses >= 3)) {
      const [pair, direction] = key.split('_');
      pairDirBlocks.push({
        key,
        pair,
        direction,
        recentLosses: losses,
        recentTotal: last4.length,
        lastOutcomes: last4.map(o => o.status),
      });
    }
  }

  return _json({
    ok: true,
    version: 'v337-veto-status',
    summary: {
      comboLevelBlocks: comboBlocks.length,
      pairDirLevelBlocks: pairDirBlocks.length,
      totalPatternsBlocked: comboBlocks.length + pairDirBlocks.length,
    },
    comboBlocks,
    pairDirBlocks,
    explanation: {
      comboBlock: 'Blocks any signal on this exact pair+direction+strategy combo',
      pairDirBlock: 'Blocks ANY signal on this pair+direction (safety net, catches losing streaks across different combos)',
      autoHeals: 'When a real win happens, that resolution updates the last-4 window and the block lifts automatically',
    },
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
