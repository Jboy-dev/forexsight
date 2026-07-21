// /api/conditions-score — v364
//
// A single 0-100 score that answers ONE question: "Should I even be trading
// right now?"
//
// The honest reality after 361 versions: retail loses money 90% of the time
// not because they miss winning signals, but because they take losing trades
// in bad conditions. This endpoint gives a single number so you can tell at
// a glance:
//
//   80-100 → GO      excellent conditions, take your proven setups
//   60-79  → OK      normal conditions, be selective
//   40-59  → CAUTION marginal conditions, cut size in half
//   20-39  → STAND ASIDE  bad conditions, don't trade unless elite setup
//   0-19   → STOP    dangerous conditions, close the app and touch grass
//
// Composed from six independent factors, weighted by real-world impact on
// retail losses:
//   1. Session quality (30pts)   — killzones win; dead hours lose
//   2. Volatility regime (20pts) — VIX + ATR alignment
//   3. News blackout (15pts)     — top-tier events in next 60 min
//   4. Recent WR (15pts)         — you were 5W/1L today = keep going
//   5. Correlation crowding (10pts) — many open trades = higher risk
//   6. Trust score (10pts)       — is the system currently calibrated

const HIGH_IMPACT_KEYWORDS = ['NFP', 'FOMC', 'CPI', 'ECB', 'BoE', 'BoJ', 'GDP', 'PPI', 'unemployment', 'rate decision'];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const dow = now.getUTCDay(); // 0=Sunday

  // ─── 1. SESSION QUALITY (30 pts) ────────────────────────────────────
  // London 07-16 GMT + NY overlap 12-16 GMT = best. Dead hours (21-06) = worst.
  const inLondon = utcHour >= 7 && utcHour < 16;
  const inNY = utcHour >= 12 && utcHour < 21;
  const inOverlap = utcHour >= 12 && utcHour < 16;
  const isWeekend = dow === 0 || dow === 6;
  const isSunOpen = dow === 0 && utcHour >= 22; // Sunday 22:00 UTC = FX open
  const isFriClose = dow === 5 && utcHour >= 21; // Friday 21:00 UTC = FX close
  let sessionPts, sessionNote;
  if (isWeekend && !isSunOpen) { sessionPts = 0; sessionNote = 'Weekend — FX closed, only BTC trades'; }
  else if (isFriClose) { sessionPts = 5; sessionNote = 'Friday close — thin liquidity, whipsaw risk'; }
  else if (inOverlap) { sessionPts = 30; sessionNote = 'London-NY overlap — peak liquidity, tightest spreads'; }
  else if (inLondon) { sessionPts = 25; sessionNote = 'London session — good liquidity'; }
  else if (inNY) { sessionPts = 22; sessionNote = 'NY session — good liquidity'; }
  else if (utcHour >= 0 && utcHour < 7) { sessionPts = 8; sessionNote = 'Asian session — thin for USD majors, OK for JPY/AUD'; }
  else { sessionPts = 3; sessionNote = 'Dead hours — extremely thin liquidity, avoid'; }

  // ─── 2. VOLATILITY REGIME (20 pts) ──────────────────────────────────
  // Fetch multi-source to get VIX
  let volPts = 10, volNote = 'Volatility data unavailable';
  try {
    const ms = await fetch(`${origin}/api/multi-source-check?pair=XAU/USD&direction=BOTH`).then(r => r.ok ? r.json() : null);
    const vix = ms?.sources?.vix?.value;
    if (vix != null) {
      if (vix < 15) { volPts = 20; volNote = `VIX ${vix} — calm, ideal for trend-following`; }
      else if (vix < 20) { volPts = 18; volNote = `VIX ${vix} — normal, most strategies work`; }
      else if (vix < 25) { volPts = 12; volNote = `VIX ${vix} — elevated, tighten stops`; }
      else if (vix < 35) { volPts = 6; volNote = `VIX ${vix} — stressed, mean-reversion only`; }
      else { volPts = 2; volNote = `VIX ${vix} — crisis mode, stand aside`; }
    }
  } catch {}

  // ─── 3. NEWS BLACKOUT (15 pts) ──────────────────────────────────────
  // Any tier-1 news event within ±60 min = huge whipsaw risk
  let newsPts = 15, newsNote = 'No tier-1 news in next 60 min';
  try {
    const cal = await fetch(`${origin}/api/calendar`).then(r => r.ok ? r.json() : null);
    const events = cal?.events || [];
    const nowMs = Date.now();
    const highImpactSoon = events.filter(e => {
      const t = Date.parse(e.date || e.time || '');
      if (!Number.isFinite(t)) return false;
      const minsAway = (t - nowMs) / 60000;
      if (minsAway < -15 || minsAway > 60) return false;
      const text = ((e.title || '') + ' ' + (e.impact || '')).toLowerCase();
      const isHigh = (e.impact || '').toLowerCase().includes('high') ||
        HIGH_IMPACT_KEYWORDS.some(k => text.includes(k.toLowerCase()));
      return isHigh;
    });
    if (highImpactSoon.length > 0) {
      newsPts = 0;
      const nearest = highImpactSoon[0];
      newsNote = `⚠️ ${nearest.title || 'High-impact event'} — DO NOT enter within 15min before/after`;
    }
  } catch {}

  // ─── 4. RECENT WR (15 pts) ──────────────────────────────────────────
  let wrPts = 8, wrNote = 'No recent trade data';
  try {
    const st = await fetch(`${origin}/api/self-trust`).then(r => r.ok ? r.json() : null);
    const recent = st?.liveTrades?.recentWinRate;
    if (recent != null) {
      if (recent >= 65) { wrPts = 15; wrNote = `You're on a hot streak — recent ${recent}% WR, keep pressing`; }
      else if (recent >= 55) { wrPts = 12; wrNote = `Recent ${recent}% WR — normal execution`; }
      else if (recent >= 45) { wrPts = 8; wrNote = `Recent ${recent}% WR — near coin-flip, be selective`; }
      else if (recent >= 35) { wrPts = 3; wrNote = `Recent ${recent}% WR — cold streak, cut size 50%`; }
      else { wrPts = 0; wrNote = `Recent ${recent}% WR — take a break, review journal before next trade`; }
    }
  } catch {}

  // ─── 5. CORRELATION CROWDING (10 pts) ───────────────────────────────
  // If user has multiple open trades in correlated pairs, portfolio heat is
  // already high. Read open trades from KV.
  let crowdPts = 10, crowdNote = 'No open trades — full risk budget available';
  try {
    const trades = await fetch(`${origin}/api/trades`).then(r => r.ok ? r.json() : null);
    const open = (trades?.trades || []).filter(t => t.status === 'open' || !t.status);
    if (open.length > 0) {
      const pairs = new Set(open.map(t => t.pair));
      // Simple correlation groups
      const usdMajors = ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD'];
      const yenPairs = ['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY'];
      const usdMajorCount = usdMajors.filter(p => pairs.has(p)).length;
      const yenCount = yenPairs.filter(p => pairs.has(p)).length;
      const totalOpen = open.length;
      if (totalOpen >= 5) { crowdPts = 0; crowdNote = `${totalOpen} open trades — portfolio HOT, no new entries`; }
      else if (usdMajorCount >= 3) { crowdPts = 2; crowdNote = `${usdMajorCount} USD major pairs open — highly correlated, avoid another`; }
      else if (yenCount >= 3) { crowdPts = 2; crowdNote = `${yenCount} JPY pairs open — highly correlated, avoid another`; }
      else if (totalOpen >= 3) { crowdPts = 5; crowdNote = `${totalOpen} open trades — moderate heat, be selective`; }
      else { crowdPts = 8; crowdNote = `${totalOpen} open trade(s) — capacity for 1-2 more`; }
    }
  } catch {}

  // ─── 6. TRUST SCORE (10 pts) ────────────────────────────────────────
  let trustPts = 5, trustNote = 'Trust score unavailable';
  try {
    const st = await fetch(`${origin}/api/self-trust`).then(r => r.ok ? r.json() : null);
    const trust = st?.trustScore;
    if (trust != null) {
      if (trust >= 70) { trustPts = 10; trustNote = `System trust ${trust}/100 — well calibrated, trust its verdicts`; }
      else if (trust >= 50) { trustPts = 7; trustNote = `System trust ${trust}/100 — moderate calibration`; }
      else if (trust >= 30) { trustPts = 4; trustNote = `System trust ${trust}/100 — low, verify signals manually`; }
      else { trustPts = 1; trustNote = `System trust ${trust}/100 — very low, treat all signals as "consider" not "take"`; }
    }
  } catch {}

  // ─── AGGREGATE ─────────────────────────────────────────────────────
  const score = sessionPts + volPts + newsPts + wrPts + crowdPts + trustPts;
  let verdict, action;
  if (score >= 80) { verdict = 'GO'; action = 'Excellent conditions — take proven setups with normal size'; }
  else if (score >= 60) { verdict = 'OK'; action = 'Normal conditions — be selective, prefer A+ setups'; }
  else if (score >= 40) { verdict = 'CAUTION'; action = 'Marginal — cut size in half, wait for cleanest setups only'; }
  else if (score >= 20) { verdict = 'STAND ASIDE'; action = 'Poor conditions — only trade truly elite setups (rare)'; }
  else { verdict = 'STOP'; action = 'Dangerous conditions — close app, wait for tomorrow'; }

  return new Response(JSON.stringify({
    ok: true,
    version: 'v364-conditions-score',
    timestamp: now.toISOString(),
    score,
    verdict,
    action,
    breakdown: {
      session: { points: sessionPts, max: 30, note: sessionNote },
      volatility: { points: volPts, max: 20, note: volNote },
      news: { points: newsPts, max: 15, note: newsNote },
      recentWR: { points: wrPts, max: 15, note: wrNote },
      correlationCrowding: { points: crowdPts, max: 10, note: crowdNote },
      systemTrust: { points: trustPts, max: 10, note: trustNote },
    },
    honestNote: 'Retail traders lose money mostly by taking BAD TRADES in poor conditions, not by missing good ones. Use this score as a first filter: if score < 40, do NOT trade regardless of how good a signal looks. This is the single most valuable rule in the app.',
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
