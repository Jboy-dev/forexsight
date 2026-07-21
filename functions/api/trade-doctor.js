// /api/trade-doctor — v364
//
// POST a proposed trade. Get back a HONEST second opinion.
//
// The pivot: instead of the site telling you WHAT to trade, this endpoint
// evaluates YOUR proposed trade against every source of truth we have:
//   - Trading conditions score
//   - Multi-source macro basket
//   - Veto status for your pair+direction
//   - Predict-next alignment
//   - Historical pattern match
//   - News blackout window
//   - Correlation with your open trades
//   - Risk sanity (R:R, SL distance, position size)
//
// Returns a verdict + concrete pass/fail list.
//
// POST body: { pair, direction, entry, sl, tp1, tp2, tp3, riskPct? }
// Returns:   { verdict, score/100, greenLights, redFlags, adjustments, wouldITradeIt }

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (request.method !== 'POST') {
    return _json({
      ok: true,
      version: 'v364-trade-doctor',
      usage: 'POST { pair, direction, entry, sl, tp1?, tp2?, tp3?, riskPct? }',
      example: {
        pair: 'XAU/USD',
        direction: 'SELL',
        entry: 3980.5,
        sl: 4005.0,
        tp1: 3960.0,
        tp2: 3935.0,
        tp3: 3900.0,
        riskPct: 1.0,
      },
      pitch: 'Second opinion on YOUR proposed trade. Cross-references 8 independent sources of truth. Tells you plainly if you should take it, adjust it, or skip it.',
    });
  }

  let body;
  try { body = await request.json(); }
  catch { return _json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const pair = String(body.pair || '').toUpperCase().trim();
  const direction = String(body.direction || '').toUpperCase().trim();
  const entry = Number(body.entry);
  const sl = Number(body.sl);
  const tp1 = Number(body.tp1) || null;
  const tp2 = Number(body.tp2) || null;
  const tp3 = Number(body.tp3) || (tp2 ? tp2 : tp1);
  const riskPct = Number(body.riskPct) || 1.0;

  if (!pair || !direction || !isFinite(entry) || !isFinite(sl)) {
    return _json({ ok: false, error: 'Missing required fields: pair, direction, entry, sl' }, 400);
  }
  if (direction !== 'BUY' && direction !== 'SELL') {
    return _json({ ok: false, error: 'direction must be BUY or SELL' }, 400);
  }

  const greenLights = [];
  const redFlags = [];
  const adjustments = [];
  let scoreDelta = 50;  // start at neutral

  // ─── 1. MATH SANITY ──────────────────────────────────────────────
  if (direction === 'BUY') {
    if (sl >= entry) redFlags.push(`SL ${sl} must be BELOW entry ${entry} for a BUY — geometry is broken`);
    if (tp3 && tp3 <= entry) redFlags.push(`TP3 ${tp3} must be ABOVE entry ${entry} for a BUY`);
  } else {
    if (sl <= entry) redFlags.push(`SL ${sl} must be ABOVE entry ${entry} for a SELL — geometry is broken`);
    if (tp3 && tp3 >= entry) redFlags.push(`TP3 ${tp3} must be BELOW entry ${entry} for a SELL`);
  }

  // R:R
  const slDist = Math.abs(entry - sl);
  const tpDist = tp3 ? Math.abs(tp3 - entry) : 0;
  const rr = slDist > 0 ? Math.round((tpDist / slDist) * 100) / 100 : 0;
  if (rr < 1.5) { redFlags.push(`R:R ${rr} < 1.5 — not worth the risk. Aim for 2R+ minimum`); scoreDelta -= 15; }
  else if (rr < 2.0) { adjustments.push(`R:R ${rr} is thin; consider extending TP3 or tightening SL to hit 2R+`); }
  else if (rr >= 2.5) { greenLights.push(`R:R ${rr} — excellent reward/risk`); scoreDelta += 8; }
  else { greenLights.push(`R:R ${rr} — solid`); scoreDelta += 4; }

  // ─── 2. TRADING CONDITIONS SCORE ─────────────────────────────────
  try {
    const cs = await fetch(`${origin}/api/conditions-score`).then(r => r.ok ? r.json() : null);
    if (cs) {
      if (cs.score >= 70) { greenLights.push(`Trading conditions ${cs.score}/100 (${cs.verdict})`); scoreDelta += 10; }
      else if (cs.score >= 50) { greenLights.push(`Conditions OK (${cs.score}/100)`); scoreDelta += 3; }
      else if (cs.score >= 30) { adjustments.push(`Conditions marginal (${cs.score}/100) — cut position size in half`); scoreDelta -= 5; }
      else { redFlags.push(`Conditions BAD (${cs.score}/100) — ${cs.action}`); scoreDelta -= 20; }
    }
  } catch {}

  // ─── 3. VETO STATUS ──────────────────────────────────────────────
  try {
    const vs = await fetch(`${origin}/api/veto-status`).then(r => r.ok ? r.json() : null);
    if (vs) {
      const vetoed = (vs.pairDirBlocks || []).find(b => b.pair === pair && b.direction === direction);
      if (vetoed) {
        redFlags.push(`⛔ ${pair} ${direction} is VETOED (${vetoed.recentLosses}L/${vetoed.recentTotal} in last 48h) — recent losing streak in this exact direction`);
        scoreDelta -= 25;
      } else {
        greenLights.push('No recent-loss veto on this pair+direction');
        scoreDelta += 3;
      }
    }
  } catch {}

  // ─── 4. PREDICT-NEXT DIRECTION ──────────────────────────────────
  try {
    const pn = await fetch(`${origin}/api/predict-next?pair=${encodeURIComponent(pair)}`).then(r => r.ok ? r.json() : null);
    if (pn?.prediction) {
      const systemDir = pn.prediction.direction;
      const systemConf = pn.prediction.confidence;
      if (systemDir === direction) {
        if (systemConf >= 80) { greenLights.push(`System agrees: ${systemDir} @ ${systemConf}% conviction`); scoreDelta += 15; }
        else if (systemConf >= 65) { greenLights.push(`System agrees: ${systemDir} @ ${systemConf}%`); scoreDelta += 8; }
        else { greenLights.push(`System weakly agrees: ${systemDir} @ ${systemConf}%`); scoreDelta += 3; }
      } else if (systemDir === 'HOLD') {
        adjustments.push(`System says HOLD (${systemConf}% conviction) — no strong edge either way`);
        scoreDelta -= 5;
      } else {
        redFlags.push(`⚠️ System says ${systemDir} @ ${systemConf}% — OPPOSITE of your trade. You may be fighting a real trend.`);
        scoreDelta -= 15;
      }
    }
  } catch {}

  // ─── 5. MULTI-SOURCE MACRO ──────────────────────────────────────
  try {
    const ms = await fetch(`${origin}/api/multi-source-check?pair=${encodeURIComponent(pair)}&direction=BOTH`).then(r => r.ok ? r.json() : null);
    if (ms) {
      const dirEval = direction === 'BUY' ? ms.BUY : ms.SELL;
      const oppEval = direction === 'BUY' ? ms.SELL : ms.BUY;
      if (dirEval?.verdict === 'CONFIRM') { greenLights.push(`Macro basket CONFIRMS ${direction} (+${dirEval.boost}pts)`); scoreDelta += 10; }
      else if (dirEval?.verdict === 'VETO') { redFlags.push(`Macro basket VETOES ${direction} (${dirEval.boost}pts) — VIX/DXY/gold-silver ratio disagree`); scoreDelta -= 15; }
      else { adjustments.push(`Macro neutral for ${direction} — no macro tailwind`); }
    }
  } catch {}

  // ─── 6. PATTERN MATCH ────────────────────────────────────────────
  try {
    const pm = await fetch(`${origin}/api/pattern-match?pair=${encodeURIComponent(pair)}`).then(r => r.ok ? r.json() : null);
    const match = pm?.fullMatches?.[0]?.match;
    if (match) {
      if (match.direction === direction) {
        greenLights.push(`🎯 Proven ${direction} pattern match (${match.matchType}, ${match.winRate}% WR over ${match.samples} historical instances)`);
        scoreDelta += 12;
      } else {
        redFlags.push(`Pattern library shows ${match.direction} setup right now — opposite of your trade`);
        scoreDelta -= 8;
      }
    }
  } catch {}

  // ─── 7. CORRELATION WITH OPEN TRADES ────────────────────────────
  try {
    const trades = await fetch(`${origin}/api/trades`).then(r => r.ok ? r.json() : null);
    const open = (trades?.trades || []).filter(t => (!t.status || t.status === 'open'));
    if (open.some(t => t.pair === pair)) {
      redFlags.push(`You already have an OPEN trade on ${pair} — do not stack`);
      scoreDelta -= 15;
    }
    // Correlation groups
    const usdMajors = ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD'];
    const isMajor = usdMajors.includes(pair);
    if (isMajor) {
      const openMajors = open.filter(t => usdMajors.includes(t.pair) && t.direction === direction);
      if (openMajors.length >= 2) {
        adjustments.push(`${openMajors.length} correlated ${direction} trades already open in USD majors — reduce this trade's size`);
        scoreDelta -= 5;
      }
    }
    if (open.length === 0) greenLights.push('No open trades — full risk budget available');
  } catch {}

  // ─── 8. RISK SANITY ─────────────────────────────────────────────
  if (riskPct > 2) { redFlags.push(`Risking ${riskPct}% is too high — 0.5-1% per trade is professional standard`); scoreDelta -= 10; }
  else if (riskPct > 1.5) { adjustments.push(`Risk ${riskPct}% is aggressive — consider dropping to 1%`); }
  else if (riskPct <= 1) { greenLights.push(`Risk ${riskPct}% — disciplined position sizing`); scoreDelta += 3; }

  // ─── FINAL VERDICT ──────────────────────────────────────────────
  const score = Math.max(0, Math.min(100, Math.round(scoreDelta)));
  let verdict, wouldITradeIt;
  if (redFlags.length >= 3 || score < 30) {
    verdict = 'DO NOT TAKE';
    wouldITradeIt = `No. ${redFlags.length} red flags — too many things pointing the wrong way. Wait for a cleaner setup.`;
  } else if (redFlags.length >= 1 || score < 50) {
    verdict = 'RECONSIDER';
    wouldITradeIt = `Maybe. Fix the red flags first: ${redFlags.slice(0, 2).join('; ')}. If you can't, skip.`;
  } else if (score < 70) {
    verdict = 'OK WITH ADJUSTMENTS';
    wouldITradeIt = `Yes, but reduce size or apply the adjustments below. Not a slam-dunk.`;
  } else if (score < 85) {
    verdict = 'GOOD TRADE';
    wouldITradeIt = `Yes. Solid setup with real edge. Standard position sizing.`;
  } else {
    verdict = 'EXCELLENT TRADE';
    wouldITradeIt = `Yes with conviction. Multiple independent sources agree. Consider full position size.`;
  }

  return _json({
    ok: true,
    version: 'v364-trade-doctor',
    timestamp: new Date().toISOString(),
    trade: { pair, direction, entry, sl, tp1, tp2, tp3, rr, riskPct },
    verdict,
    score,
    wouldITradeIt,
    greenLights,
    redFlags,
    adjustments,
    honestNote: 'This is a SECOND OPINION, not a signal. You still make the call. The best traders combine judgment WITH data — not one or the other.',
  });
}

function _json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
