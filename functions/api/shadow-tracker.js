// /api/shadow-tracker — Tracks EVERY live signal that fires, then checks
// what would have happened if you took it.
//
// Each call:
//   1. Pulls latest-signals from KV
//   2. For each signal not already in the shadow list, adds it as "open"
//   3. For each "open" shadow signal, fetches recent OHLC and checks if
//      price has hit TP1 or SL since the signal fired
//   4. Marks signals "won"/"lost"/"open"
//   5. Trims to last 60 entries
//   6. Returns the rolling feed + summary stats (shadow WR, total tracked)
//
// This gives the user a continuous "would-have" feed regardless of whether
// they actually took the trade. The brain in v213 learns from synthetic
// backtests; this learns from LIVE signals as they unfold in real time.

const SHADOW_KEY = 'shadow-tracker';
const SHADOW_MAX = 200;  // v392 — 3.3x capacity so brain has more history

// v246 — Fetch with 8s timeout via AbortController so a hung upstream can't
// freeze the shadow update loop.
async function fetchOHLC(origin, sym, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, timeoutMs);
  try {
    const r = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`, { signal: ctl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return d.ohlc || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// v445 — WALK A TRADE BAR BY BAR AND RECORD WHAT ACTUALLY HAPPENED.
//
// The old resolver broke the moment TP1 was touched, so a trade that ran on
// to TP3 was written to history identically to one that tagged TP1 and
// reversed. The record carried no size at all — no R value, no which-target,
// no drawdown. A history of W/L counts tells you how often the system is
// right, not whether it makes money, and at a ~21% strike rate that is the
// less useful half.
//
// This walks every bar and resolves the trade the way the app TELLS you to
// trade it (the v442 plan printed on every card): a third out at TP1 with
// the stop moved to break-even, a third at TP2, the last third running to
// TP3. Scoring the whole position at the furthest target would overstate
// every partial winner, so `bankedR` is the managed figure and `holdR`
// records hold-it-all for comparison.
//
// Returns { outcome, atBar, tpReached, mae, mfe, bankedR, openFraction,
//           holdR, slDist, lastClose } — outcome null means still running.
function _walkTrade(s, bars) {
  const isBuy = s.direction === 'BUY';
  const slDist = Math.abs(s.entry - s.sl);
  const rOf = (px) => (slDist > 0 && typeof px === 'number')
    ? Math.abs(px - s.entry) / slDist : null;
  const r1 = rOf(s.tp1), r2 = rOf(s.tp2), r3 = rOf(s.tp3);

  let outcome = null, atBar = null, tpReached = 0;
  let mae = 0, mfe = 0;
  let bankedR = 0;        // R already taken off the table
  let openFraction = 1;   // how much of the position is still running
  let stopPx = s.sl;      // moves to entry once TP1 is banked
  let holdR = null;       // hold-the-whole-position comparison
  let lastClose = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    lastClose = bar.c;
    const adverse = isBuy ? (s.entry - bar.l) : (bar.h - s.entry);
    const favour  = isBuy ? (bar.h - s.entry) : (s.entry - bar.l);
    if (adverse > mae) mae = adverse;
    if (favour  > mfe) mfe = favour;

    const stopHit = isBuy ? bar.l <= stopPx : bar.h >= stopPx;
    let reached = 0;
    if (r1 != null && (isBuy ? bar.h >= s.tp1 : bar.l <= s.tp1)) reached = 1;
    if (r2 != null && (isBuy ? bar.h >= s.tp2 : bar.l <= s.tp2)) reached = 2;
    if (r3 != null && (isBuy ? bar.h >= s.tp3 : bar.l <= s.tp3)) reached = 3;

    // A single bar spanning both the stop and a target is ambiguous at this
    // resolution — there is no way to know which filled first. Take the
    // pessimistic read: the stop went first, and nothing reached on THIS bar
    // counts. Only targets banked on strictly earlier bars do.
    if (stopHit) {
      // Remaining size exits at stopPx: the original stop (−1R of whatever
      // is still open) before TP1, or break-even (0R) after it.
      bankedR += openFraction * (tpReached === 0 ? -1 : 0);
      openFraction = 0;
      holdR = tpReached === 0 ? -1
            : tpReached === 3 ? r3 : tpReached === 2 ? r2 : r1;
      outcome = tpReached > 0 ? 'won' : 'lost';
      atBar = i + 1;
      break;
    }

    // Bank each newly reached third and protect the rest.
    while (reached > tpReached) {
      const next = tpReached + 1;
      const rHere = next === 1 ? r1 : next === 2 ? r2 : r3;
      if (rHere == null) break;   // target not defined — nothing to bank
      tpReached = next;
      bankedR += (1 / 3) * rHere;
      openFraction = Math.max(0, openFraction - 1 / 3);
      if (tpReached === 1) stopPx = s.entry; // from here the trade cannot lose
    }

    if (tpReached === 3) {
      holdR = r3;
      outcome = 'won';
      atBar = i + 1;
      break;
    }
  }

  return { outcome, atBar, tpReached, mae, mfe, bankedR, openFraction, holdR, slDist, lastClose };
}

// Write the excursion figures from a walk onto the signal record.
function _recordExcursion(s, w) {
  s.tpReached = w.tpReached;
  s.maePips = w.slDist > 0 ? Math.round((w.mae / w.slDist) * 100) / 100 : null; // in R
  s.mfeR    = w.slDist > 0 ? Math.round((w.mfe / w.slDist) * 100) / 100 : null;
  s.resultR = Math.round(w.bankedR * 100) / 100;   // managed — what you'd bank
  s.resultRHold = w.holdR != null ? Math.round(w.holdR * 100) / 100 : null;
}

// v260 — Analyze a WON signal to determine WHY it won. Returns an array of
// success tags symmetric to _computeFailureReasons. Brain aggregates these
// into a winsByTag store so future signals matching successful profiles get
// a positive bias. Symmetric learning — wins matter as much as losses.
function _computeWinReasons(s) {
  const reasons = [];
  const firedDate = new Date(s.firedAt || Date.now());
  const h = firedDate.getUTCHours();
  // Confidence strength
  if (s.confidence != null && s.confidence >= 90) reasons.push('high-confidence-90plus');
  else if (s.confidence != null && s.confidence >= 80) reasons.push('strong-confidence-80plus');
  // Strategy confluence
  if (s.strategies != null && s.strategies >= 3) reasons.push('multi-strategy-3plus');
  else if (s.strategies != null && s.strategies === 2) reasons.push('multi-strategy-2');
  // Killzone timing
  if (h >= 7 && h <= 9) reasons.push('london-open-momentum');
  if (h === 12 || h === 13 || h === 14 || h === 15) reasons.push('ny-session-strength');
  // Speed of resolution — quick TP1 hits are clean signals
  if (s.barsToOutcome != null && s.barsToOutcome <= 2) reasons.push('quick-decisive-move');
  else if (s.barsToOutcome != null && s.barsToOutcome <= 5) reasons.push('clean-follow-through');
  // BIG MOVE captured (server-side flag)
  if (s.bigMove) reasons.push('big-move-captured');
  // High brain endorsement
  if (s.brainRecommended) reasons.push('brain-top-pick');
  if (s.isEliteBrainPattern) reasons.push('elite-pattern-fired');
  // Strong ADX (trending market that delivered)
  if (s.adx != null && s.adx >= 30) reasons.push('strong-trend-30plus');
  return reasons.length ? reasons : ['standard-win'];
}

// v228 — Analyze a lost signal to determine WHY it failed. Returns an array
// of failure tags. These get displayed in the feed AND aggregated into the
// brain's failure-pattern store so future signals matching the same profile
// get a negative bias automatically.
function _computeFailureReasons(s) {
  const reasons = [];
  const firedDate = new Date(s.firedAt || Date.now());
  const h = firedDate.getUTCHours();
  const dow = firedDate.getUTCDay();
  // Confidence weakness
  if (s.confidence != null && s.confidence < 70) reasons.push('weak-confidence');
  if (s.confidence != null && s.confidence >= 70 && s.confidence < 85) reasons.push('mid-confidence');
  // Strategy count
  if (s.strategies != null && s.strategies < 2) reasons.push('single-strategy');
  // Time-based
  if (h < 7 || h > 21) reasons.push('off-session');
  if (h === 7 || h === 8 || h === 9) reasons.push('london-open-volatility');
  if (h === 12 || h === 14) reasons.push('pre-ny-volatility');
  // Weekend approach (Friday afternoon often choppy)
  if (dow === 5 && h >= 17) reasons.push('pre-weekend');
  // SL distance heuristic (if available)
  if (s.entry && s.sl) {
    const slDist = Math.abs(s.entry - s.sl);
    const slPctOfPrice = slDist / s.entry;
    if (s.pair === 'XAU/USD' && slDist > 50) reasons.push('wide-sl-gold');
    else if (slPctOfPrice > 0.012) reasons.push('wide-sl');
  }
  // Resolved fast — likely a strong adverse move (not a slow drift)
  if (s.barsToOutcome != null && s.barsToOutcome <= 2) reasons.push('immediate-rejection');
  if (s.barsToOutcome != null && s.barsToOutcome >= 20) reasons.push('slow-grind-loss');
  return reasons.length ? reasons : ['unknown-cause'];
}

const PAIR_TO_SYMBOL = {
  'XAU/USD': 'GC=F', 'GOLD': 'GC=F',
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
};

export async function onRequest(context) {
  // v246 — Top-level safety net so any unhandled exception returns valid
  // JSON instead of 500. Shadow update may skip a tick but never crashes
  // the brain's online-learning trigger (it tolerates this endpoint failing).
  try {
    return await _shadowInner(context);
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'shadow-tracker safety-net caught: ' + e.message,
      ts: Date.now(),
      tracked: 0, open: 0, wins: 0, losses: 0, expired: 0,
      shadowWinRate: 'n/a (error)',
      topFailureReasons: [],
      feed: [],
      persisted: false, dirty: false, newResolutions: 0,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
async function _shadowInner(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (!env.TRADES_KV) {
    return new Response(JSON.stringify({ ok: false, error: 'KV not bound' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Load existing shadow list
  let shadow = [];
  try {
    const raw = await env.TRADES_KV.get(SHADOW_KEY);
    if (raw) shadow = JSON.parse(raw);
  } catch {}

  // v234 — Snapshot initial state so we can detect whether anything actually
  // changed this call. Without this we were writing to KV on EVERY request and
  // burning through the 1000 writes/day free-tier quota in a few hours, which
  // broke shadow learning entirely. Now we only persist when new signals are
  // added or an open signal resolves to won/lost/expired.
  const initialKeysCount = shadow.length;
  const initialStatusByKey = new Map(shadow.map(s => [s.key, s.status]));

  // Load latest signals to find new entries
  // v402b — read via /api/latest-signals ENDPOINT (not KV directly) so
  // the fallback chart-read/PREMIUM signals also get tracked. Reading KV
  // directly missed all fallback signals → 0 tracked today despite 9
  // signals visible to the user.
  let latestSignals = [];
  try {
    const lsRes = await fetch(`${origin}/api/latest-signals`);
    if (lsRes.ok) {
      const data = await lsRes.json();
      latestSignals = Array.isArray(data.signals) ? data.signals : [];
    }
  } catch {}
  // Fallback to KV if HTTP failed (rare)
  if (latestSignals.length === 0) {
    try {
      const raw = await env.TRADES_KV.get('latest-signals');
      if (raw) {
        const data = JSON.parse(raw);
        latestSignals = Array.isArray(data.signals) ? data.signals : [];
      }
    } catch {}
  }

  // Dedupe: signal key = pair+direction+detectedAt hour
  // v257 — RELAXED QUALITY FILTER. The previous v248 thresholds (pWin≥60,
  // edge≥12, conf≥75, strats≥2) were too restrictive — only the absolute
  // cream passed, so the feed was sparse. New approach: TRUST THE BRAIN GATE
  // (already applied upstream) and accept any of THREE smart paths:
  //
  //   • Path A — Standard quality: pWin≥55, edge≥8, conf≥65, strats≥1
  //   • Path B — Positive expected return: Quantum E[R] ≥ 0.30
  //   • Path C — Brain's Top Pick OR Elite Pattern
  //
  // A signal needs to pass ANY ONE path to be tracked. Result: the feed
  // finds A LOT of signals while every one of them carries some form of
  // brain endorsement. Then we sort the feed by a composite brain-quality
  // score so the very best appear first.
  const SHADOW_MIN_PWIN_A = 55;
  const SHADOW_MIN_EDGE_A = 8;
  const SHADOW_MIN_CONF_A = 65;
  const SHADOW_MIN_STRATS_A = 1;
  const SHADOW_GOOD_E_R = 0.30;
  // Helper: compute a composite "brain quality" score for ranking.
  const computeBrainScore = (sig) => {
    const pa = sig.probabilityAnalysis || {};
    const q = sig.quantum || {};
    let sc = 0;
    sc += (pa.pWin || 50);                                      // base: win probability
    sc += (pa.edge || 0) * 0.5;                                 // edge bonus
    if (q.bestStrategy) sc += (q.bestStrategy.expectedR || 0) * 30; // E[R] heavy weight
    if (sig.bigMove) sc += 8;
    if (sig.isEliteBrainPattern) sc += 12;
    if (sig.brainRecommended) sc += 20;
    if (sig.strategies >= 3) sc += 5;
    if (sig.inKillzone) sc += 3;
    return sc;
  };
  // v382 — backfill tier + source on existing entries. Shadow was only
  // insert-once; existing records missed the v381 tier-copy fix. This
  // patch closes the loop.
  const shadowByKey = new Map(shadow.map(s => [s.key, s]));
  for (const sig of latestSignals) {
    if (!sig || !sig.pair || !sig.direction) continue;
    const hourBucket = (sig.detectedAt || new Date().toISOString()).slice(0, 13);
    const key = `${sig.pair}_${sig.direction}_${hourBucket}`;
    const existing = shadowByKey.get(key);
    if (existing) {
      if (sig.tier && !existing.tier) existing.tier = sig.tier;
      if (sig.source && !existing.source) existing.source = sig.source;
      if (sig.topPick && existing.topPick == null) existing.topPick = true;
    }
  }
  const existingKeys = new Set(shadow.map(s => s.key));
  for (const sig of latestSignals) {
    if (!sig || !sig.pair || !sig.direction || !sig.entry) continue;
    const pa = sig.probabilityAnalysis || {};
    const q = sig.quantum || {};
    const qER = q.bestStrategy ? q.bestStrategy.expectedR : null;
    // PATH A — Standard quality bar
    const pathA =
      (pa.pWin || 0) >= SHADOW_MIN_PWIN_A &&
      (pa.edge || 0) >= SHADOW_MIN_EDGE_A &&
      (sig.strategies || 0) >= SHADOW_MIN_STRATS_A &&
      (sig.confidence || 0) >= SHADOW_MIN_CONF_A;
    // PATH B — Positive expected return per the Quantum simulation
    const pathB = qER != null && qER >= SHADOW_GOOD_E_R;
    // PATH C — Endorsed picks (Top Pick or Elite Pattern)
    const pathC = sig.brainRecommended === true || sig.isEliteBrainPattern === true;
    // v402 — PATH D: chart-read / strong-read / PREMIUM tier signals.
    // These come from live-analysis, not the strict scanner, so they
    // don't have pWin/edge/quantum. They ARE what users see and click,
    // and shadow needs to track them so the brain learns from real
    // outcomes. Without this, today's 9 signals never got tracked →
    // brain got 0 learning input today.
    const tier = String(sig.tier || '').toLowerCase();
    const isTrackableTier = ['premium','strong-read','chart-read','best','platinum','elite','top','gold'].includes(tier);
    const hasReasonableConf = (sig.confidence || 0) >= 65;
    const pathD = isTrackableTier && hasReasonableConf;
    if (!pathA && !pathB && !pathC && !pathD) continue;
    const hourBucket = (sig.detectedAt || new Date().toISOString()).slice(0, 13); // YYYY-MM-DDTHH
    const key = `${sig.pair}_${sig.direction}_${hourBucket}`;
    if (existingKeys.has(key)) continue;
    shadow.push({
      key,
      pair: sig.pair,
      direction: sig.direction,
      entry: sig.entry,
      sl: sig.sl,
      tp1: sig.tp1,
      tp2: sig.tp2,
      tp3: sig.tp3,
      confidence: sig.confidence,
      strategies: sig.strategies,
      // v381 — CRITICAL FIX. tier was missing → self-trust filteredTier
      // WR was always null → trust score computed without its 35%-weight
      // component. Also copy source so we can distinguish premium-read
      // signals from strict-scanner signals in analytics.
      tier: sig.tier || null,
      source: sig.source || null,
      topPick: !!sig.topPick,
      // v239 — Preserve named strategies + bigMove + inKillzone so the brain's
      // online-learning loop can correctly link this resolved signal back to
      // the right combo cell and boost-effectiveness bucket.
      namedStrategies: sig.namedStrategies || [],
      bigMove: !!sig.bigMove,
      inKillzone: !!sig.inKillzone,
      adx: sig.adx,
      pipPotential: sig.pipPotential,
      // v248 — Persist the brain-gate verdict so we can later audit WHY each
      // signal was accepted. Useful when reviewing wins vs losses by quality.
      pWin: pa.pWin,
      edge: pa.edge,
      // v257 — Composite brain quality score + which acceptance path it took.
      // Used to rank the feed (best surfaces first) and to badge top picks.
      brainScore: Math.round(computeBrainScore(sig)),
      acceptancePath: pathC ? 'endorsed' : pathB ? 'positive-er' : 'standard',
      expectedR: qER,
      brainRecommended: !!sig.brainRecommended,
      isEliteBrainPattern: !!sig.isEliteBrainPattern,
      firedAt: sig.detectedAt || new Date().toISOString(),
      status: 'open',
      checkedAt: null,
      barsToOutcome: null,
    });
  }

  // Trim to most recent SHADOW_MAX
  shadow.sort((a, b) => (b.firedAt || '').localeCompare(a.firedAt || ''));
  shadow = shadow.slice(0, SHADOW_MAX);

  // For each "open" signal, check if TP1/SL hit
  // Batch by pair to minimize OHLC fetches
  const openByPair = {};
  for (const s of shadow) {
    if (s.status !== 'open') continue;
    if (!openByPair[s.pair]) openByPair[s.pair] = [];
    openByPair[s.pair].push(s);
  }
  // v445 — expired signals that still carry no R need bars too, otherwise the
  // expiry sweep below silently no-ops whenever nothing is open (which is most
  // of the time) and every expiry stays missing from the ledger forever.
  const needBars = new Set(Object.keys(openByPair));
  for (const s of shadow) {
    if (s.status === 'expired' && s.resultR == null && s.pair) needBars.add(s.pair);
  }
  // v237 — Parallelize OHLC fetches. Sequential = 8 pairs × up to 7s each =
  // 56s worst case. Promise.all = bounded by the slowest single fetch.
  const pairList = [...needBars];
  const ohlcMap = {};
  await Promise.all(pairList.map(async (pair) => {
    const sym = PAIR_TO_SYMBOL[pair] || pair.replace('/', '') + '=X';
    try { ohlcMap[pair] = await fetchOHLC(origin, sym); }
    catch { ohlcMap[pair] = null; }
  }));
  // v409 — REAL BUG FIX. Expiry check was nested inside OHLC loop. When
  // OHLC fetch failed OR bars didn't cover post-signal window, the whole
  // pair got `continue`d and expiry check never ran. Result: 4-day-old
  // ETH/USD signals stuck 'open' forever. Now expire ALL over-48h open
  // signals regardless of OHLC availability, THEN do TP/SL resolution.
  const EXPIRY_HRS = 48;
  for (const s of shadow) {
    if (s.status !== 'open') continue;
    const firedMs = Date.parse(s.firedAt || '');
    if (!Number.isFinite(firedMs)) continue;
    const ageHrs = (Date.now() - firedMs) / 3600000;
    if (ageHrs > EXPIRY_HRS) {
      s.status = 'expired';
      s.checkedAt = new Date().toISOString();
      if (!s.resolvedAt) s.resolvedAt = new Date().toISOString();
    }
  }

  for (const pair of pairList) {
    const ohlc = ohlcMap[pair];
    if (!ohlc || ohlc.length < 5) continue;
    for (const s of (openByPair[pair] || [])) {
      if (s.status !== 'open') continue; // v409 — skip if already expired above
      const firedMs = Date.parse(s.firedAt || '');
      if (!Number.isFinite(firedMs)) continue;
      // Bars AFTER the signal fired
      const relevantBars = ohlc.filter(b => b.t > firedMs);
      if (!relevantBars.length) continue;
      const isBuy = s.direction === 'BUY';
      // v445 — RECORD WHAT ACTUALLY HAPPENED, NOT JUST WON/LOST.
      //
      // This loop used to break the moment TP1 was touched, so a trade that
      // ran on to TP3 was written to history identically to one that tagged
      // TP1 and reversed. The record carried no size at all: no R value, no
      // which-target-was-reached, no drawdown. A history of W/L counts
      // cannot tell you whether the strategy makes money, only how often it
      // is right — and at a ~21% strike rate that is the less useful half.
      //
      // Now it walks every bar to resolution, tracking:
      //   • the furthest take-profit reached (1/2/3)
      //   • MAE — how far the trade went against you before resolving
      //   • MFE — how far it went in your favour
      //   • resultR — the realised R multiple
      // It also resolves the trade the way the app TELLS you to trade it —
      // the v442 plan on every card: a third out at TP1 with the stop to
      // break-even, a third at TP2, the last third running to TP3. Scoring
      // the whole position at the furthest target would have overstated
      // every partial winner. resultRHold records the hold-it-all figure
      // alongside, so the plan can be judged against doing nothing.
      const walk = _walkTrade(s, relevantBars);
      const outcome = walk.outcome;
      const atBar = walk.atBar;
      // No resolution inside the window — leave it open; the expiry sweep
      // above deals with it once 48h passes.
      if (outcome) {
        _recordExcursion(s, walk);
        s.status = outcome;
        s.barsToOutcome = atBar;
        s.checkedAt = new Date().toISOString();
        // v331 fix — timestamp when resolved so WR windows can compute correctly
        if (!s.resolvedAt) s.resolvedAt = new Date().toISOString();
        // v228 — When a signal LOSES, compute the human-readable failure
        // reasons. These get displayed in the feed AND aggregated by the
        // brain so future signals matching the failure profile get a
        // negative bias.
        if (outcome === 'lost') {
          s.failureReasons = _computeFailureReasons(s);
        }
        // v260 — Symmetric: when a signal WINS, compute the success reasons.
        // Brain studies these as deeply as failure reasons — same purpose,
        // opposite polarity. Future signals matching past winning profiles
        // get a positive bias.
        if (outcome === 'won') {
          s.winReasons = _computeWinReasons(s);
        }
      }
      // v409 — expiry check moved to top of function so it runs even when
      // OHLC fetch fails. This block previously duplicated it.
    }
  }

  // v445 — EXPIRED TRADES ARE NO LONGER INVISIBLE.
  //
  // A signal that drifts against you for 48 hours and expires without
  // tagging the stop was previously excluded from every statistic: the win
  // rate counted only won/lost, so a trade sitting at -0.8R simply vanished
  // from the record. That flatters the numbers — in a real account that
  // position is either still open and losing, or you closed it at a loss.
  //
  // Expiries now run through the same bar walk as everything else. Anything
  // still open at the cut-off is closed at the last price — the honest
  // equivalent of flattening the position when you give up on it — so an
  // expiry carries a real signed R and shows up in the ledger.
  for (const s of shadow) {
    if (s.status !== 'expired' || s.resultR != null) continue;
    const ohlc = ohlcMap[s.pair];
    const firedMs = Date.parse(s.firedAt || '');
    if (!ohlc || !Number.isFinite(firedMs)) continue;
    const after = ohlc.filter(b => b.t > firedMs);
    if (!after.length) continue;
    const w = _walkTrade(s, after);
    if (!(w.slDist > 0) || w.lastClose == null) continue;
    if (!w.outcome && w.openFraction > 0) {
      // Still running at expiry — mark the remaining size out at last price.
      const moved = s.direction === 'BUY' ? (w.lastClose - s.entry) : (s.entry - w.lastClose);
      w.bankedR += w.openFraction * (moved / w.slDist);
      w.holdR = moved / w.slDist;
    }
    _recordExcursion(s, w);
    s.expiredInProfit = s.resultR > 0;
    s.expiryClosedAtMarket = true;   // this R is a mark-to-market, not a fill
  }

  // v445 — RECONSTRUCT R FOR SIGNALS RESOLVED BEFORE THIS VERSION.
  //
  // The old resolver stopped at the first target and stored no magnitude, so
  // ~180 historical rows carry a won/lost flag and nothing else. Both cases
  // are recoverable from what WAS stored, without inventing anything:
  //   • lost — the stop was hit with no target reached, which is −1R exactly.
  //   • won  — the old loop broke at TP1, so a legacy win means precisely
  //            "TP1 was touched" and nothing more. Under the trade plan that
  //            banks a third at TP1 and moves the stop to entry, so the
  //            conservative reconstruction is a third of TP1's R with the
  //            remainder at break-even. Some of these may really have run to
  //            TP2 or TP3, so this reconstruction understates rather than
  //            flatters, which is the right direction to be wrong in.
  // Reconstructed rows are flagged so nothing presents them as measured.
  for (const s of shadow) {
    if (s.resultR != null) continue;
    if (s.status !== 'won' && s.status !== 'lost') continue;
    const slDist = Math.abs(s.entry - s.sl);
    if (!(slDist > 0)) continue;
    if (s.status === 'lost') {
      s.resultR = -1;
      s.tpReached = 0;
    } else {
      if (typeof s.tp1 !== 'number') continue;
      s.resultR = Math.round(((Math.abs(s.tp1 - s.entry) / slDist) / 3) * 100) / 100;
      s.tpReached = 1;
    }
    s.rReconstructed = true;
  }

  // Compute summary stats
  const resolved = shadow.filter(s => s.status === 'won' || s.status === 'lost');
  const wins = resolved.filter(s => s.status === 'won').length;
  const losses = resolved.filter(s => s.status === 'lost').length;
  const shadowWR = resolved.length ? (wins / resolved.length * 100) : null;
  const open = shadow.filter(s => s.status === 'open').length;
  const expiredList = shadow.filter(s => s.status === 'expired');
  const expired = expiredList.length;

  // Honest accounting: every signal that carries a real R, expiries included.
  // Rows without an R are excluded rather than counted as zero — a missing
  // figure is not a break-even result.
  const accounted = [...resolved, ...expiredList].filter(s => typeof s.resultR === 'number');
  const accountedWins = accounted.filter(s => s.resultR > 0).length;
  const totalR = accounted.reduce((sum, s) => sum + s.resultR, 0);
  const expectancyR = accounted.length ? totalR / accounted.length : null;
  const expiredNegative = expiredList.filter(s => typeof s.resultR === 'number' && s.resultR < 0).length;
  const reconstructedCount = accounted.filter(s => s.rReconstructed).length;

  // Split measured from reconstructed. Reconstructed wins were floored at
  // "TP1 touched, rest at break-even" because that is all the old resolver
  // recorded — some of them really ran further, so their total is a lower
  // bound, not an estimate. Reporting one blended number would present that
  // floor as if it were measured. Report the bound instead.
  const measured = accounted.filter(s => !s.rReconstructed);
  const measuredTotalR = measured.reduce((sum, s) => sum + s.resultR, 0);
  const measuredWins = measured.filter(s => s.resultR > 0).length;
  // Upper bound on the legacy portion: every legacy win having run to TP3.
  let legacyCeilingR = 0;
  for (const s of accounted) {
    if (!s.rReconstructed) continue;
    if (s.resultR <= 0) { legacyCeilingR += s.resultR; continue; }
    const slD = Math.abs(s.entry - s.sl);
    const best = [s.tp1, s.tp2, s.tp3].filter(v => typeof v === 'number');
    legacyCeilingR += (slD > 0 && best.length)
      ? best.reduce((acc, px) => acc + (Math.abs(px - s.entry) / slD), 0) / 3
      : s.resultR;
  }

  // v331 — RECENT-ERA WR windows. Shows WR trajectory since major algo
  // improvements landed (v323 anti-fake guards, v325 regime weighting,
  // v326 EV ranking). Older shadows include pre-improvement signals so
  // they drag down the lifetime WR. Recent windows show ACTUAL current
  // signal quality.
  const now = Date.now();
  const _wrWindow = (windowMs) => {
    const cutoff = now - windowMs;
    const win = resolved.filter(s => {
      const ts = s.resolvedAt ? new Date(s.resolvedAt).getTime() : 0;
      return ts >= cutoff;
    });
    const w = win.filter(s => s.status === 'won').length;
    const l = win.filter(s => s.status === 'lost').length;
    const n = w + l;
    return { n, wins: w, losses: l, wr: n ? Math.round(w / n * 1000) / 10 : null };
  };
  const recentWindows = {
    last24h: _wrWindow(24 * 3600 * 1000),
    last7d:  _wrWindow(7 * 24 * 3600 * 1000),
    last30d: _wrWindow(30 * 24 * 3600 * 1000),
    lifetime: { n: resolved.length, wins, losses, wr: shadowWR != null ? Math.round(shadowWR * 10) / 10 : null },
  };

  // v228 — Aggregate failure-pattern frequency across all lost signals.
  // Brain reads this to penalize live signals matching common-failure profiles.
  // v237 — Don't mutate s.failureReasons during aggregation. The mutation
  // would never persist (dirty-check only watches status changes), so we
  // were re-deriving every tick. Just compute locally and discard.
  const failureCounts = {};
  const lostSignals = shadow.filter(s => s.status === 'lost');
  for (const s of lostSignals) {
    const reasons = s.failureReasons || _computeFailureReasons(s);
    for (const r of reasons) {
      failureCounts[r] = (failureCounts[r] || 0) + 1;
    }
  }
  const topFailureReasons = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count, pctOfLosses: losses ? Math.round(count / losses * 100) : 0 }));

  // v260 — Aggregate WIN reasons symmetric to failure reasons. Brain studies
  // both — what made signals lose AND what made signals win. Stored under
  // topWinReasons so the UI can surface "winning patterns" alongside lessons.
  const winCounts = {};
  const wonSignals = shadow.filter(s => s.status === 'won');
  for (const s of wonSignals) {
    const reasons = s.winReasons || _computeWinReasons(s);
    for (const r of reasons) {
      winCounts[r] = (winCounts[r] || 0) + 1;
    }
  }
  const topWinReasons = Object.entries(winCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count, pctOfWins: wins ? Math.round(count / wins * 100) : 0 }));

  // v234 — Only write to KV if something actually changed. Compared against
  // the snapshot taken at load time so a no-op call doesn't burn a write.
  // v240 — Track NEW resolutions specifically so we can auto-trigger the
  // brain's online-learning loop only when there's actually new data.
  let dirty = shadow.length !== initialKeysCount;
  let newResolutions = 0;
  if (!dirty) {
    for (const s of shadow) {
      if (initialStatusByKey.get(s.key) !== s.status) { dirty = true; break; }
    }
  }
  for (const s of shadow) {
    const prev = initialStatusByKey.get(s.key);
    if (prev === 'open' && (s.status === 'won' || s.status === 'lost')) newResolutions++;
  }
  // v240 — INSTANT online learning. Whenever shadow resolves a new signal,
  // immediately fire the brain in the background so it ingests the outcome
  // before the next polling tick. Without this, the brain only learned from
  // new resolutions on its own ~5-min schedule — losing minutes of relevance.
  if (newResolutions > 0 && context.waitUntil) {
    context.waitUntil(
      fetch(`${origin}/api/learning-brain`, {
        headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
      }).catch(() => {})
    );
  }
  let savedThisRun = false;
  if (dirty) {
    try {
      await env.TRADES_KV.put(SHADOW_KEY, JSON.stringify(shadow), { expirationTtl: 14 * 24 * 3600 });
      savedThisRun = true;
    } catch (e) {
      // KV quota exhausted — DON'T 500 out. Return the freshly-computed feed
      // anyway so the brain + UI can still learn from in-memory state. The
      // next call will retry the write naturally.
      console.warn('[shadow] KV write deferred:', e.message);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    ts: Date.now(),
    isoTime: new Date().toISOString(),
    tracked: shadow.length,
    open, wins, losses, expired,
    shadowWinRate: shadowWR != null ? shadowWR.toFixed(1) + '%' : 'n/a (need resolved signals)',
    // v445 — the honest ledger, alongside the strict won/lost rate above.
    // shadowWinRate counts only signals that tagged a target or a stop.
    // These figures also count expiries at their unrealised R, so a trade
    // that spent 48h underwater without touching the stop can no longer
    // disappear from the record.
    accounting: {
      n: accounted.length,
      countedWins: accountedWins,
      winRateInclExpired: accounted.length
        ? Math.round((accountedWins / accounted.length) * 1000) / 10 : null,
      totalR: Math.round(totalR * 100) / 100,
      expectancyR: expectancyR != null ? Math.round(expectancyR * 1000) / 1000 : null,
      expiredCounted: expiredList.filter(s => typeof s.resultR === 'number').length,
      expiredUnderwater: expiredNegative,
      reconstructed: reconstructedCount,
      basis: 'managed — a third banked at each target with the stop at entry after TP1, matching the plan shown on every signal card',
      // The only figures actually measured bar by bar. Everything else in
      // this block is bounded, not observed. Trust this row first, and note
      // how small n is before drawing anything from it.
      measured: {
        n: measured.length,
        wins: measuredWins,
        totalR: Math.round(measuredTotalR * 100) / 100,
        expectancyR: measured.length
          ? Math.round((measuredTotalR / measured.length) * 1000) / 1000 : null,
      },
      // The legacy rows cannot be pinned to a single number, so they are
      // reported as the range they could occupy.
      legacyBounds: reconstructedCount ? {
        n: reconstructedCount,
        floorTotalR: Math.round((totalR - measuredTotalR) * 100) / 100,
        ceilingTotalR: Math.round(legacyCeilingR * 100) / 100,
      } : null,
      note: 'expectancyR is the average R per signal, expiries included at the R '
          + 'they actually carried. A low strike rate with a positive expectancy '
          + 'is the intended shape: most signals do not reach a target, and the '
          + 'ones that do have to run further than the losers cost.'
          + (reconstructedCount
              ? ` IMPORTANT: ${reconstructedCount} of these ${accounted.length} were resolved `
                + 'before outcome sizes were recorded. The old resolver stopped at TP1, so a '
                + 'legacy win means only that TP1 was touched — whether it went on to TP2 or '
                + 'TP3 was never stored and cannot be recovered. Those rows are floored at the '
                + 'TP1-only value, which makes totalR and expectancyR above a LOWER BOUND, not '
                + 'a measurement. See legacyBounds for the range, and measured for the only '
                + 'figures observed bar by bar. Treat the headline as unproven either way until '
                + 'enough signals resolve under the new accounting.'
              : ''),
    },
    // v331 — Recent-era WR windows so UI can show "24h WR: X%" and users
    // see the improvement trajectory since post-v323 pipeline changes.
    winRateWindows: recentWindows,
    topFailureReasons,
    topWinReasons, // v260 — symmetric "what's working" alongside what isn't
    // v234 — visibility into KV throttle so we can see learning is healthy
    persisted: savedThisRun,
    dirty,
    newResolutions, // v240 — surfaces how many signals resolved this tick
    feed: (() => {
      // v257 — Sort feed by composite quality (open first → highest brainScore,
      // then resolved newest-first). The OPEN signals are actionable, so they
      // sit at the top; closed ones provide outcome history below.
      const openSorted = shadow.filter(s => s.status === 'open')
        .slice()
        .sort((a, b) => (b.brainScore || 0) - (a.brainScore || 0));
      const resolvedSorted = shadow.filter(s => s.status !== 'open')
        .slice()
        .sort((a, b) => (b.firedAt || '').localeCompare(a.firedAt || ''));
      // Mark the top-3 OPEN entries by brainScore as "🌟 best picks"
      openSorted.forEach((s, i) => { s._isTopPick = i < 3 && (s.brainScore || 0) >= 70; });
      // Combine: open (best first) → resolved (newest first), cap 30
      const ordered = [...openSorted, ...resolvedSorted].slice(0, 30);
      return ordered.map(s => ({
        key: s.key, // v249 — needed for tap-to-open detail modal
        pair: s.pair,
        direction: s.direction,
        entry: s.entry,
        sl: s.sl,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        confidence: s.confidence,
        strategies: s.strategies,
        firedAt: s.firedAt,
        status: s.status,
        barsToOutcome: s.barsToOutcome,
        checkedAt: s.checkedAt,
        // v228 — surface failure reasons for lost signals
        failureReasons: s.failureReasons || null,
        // v260 — surface win reasons for won signals (symmetric)
        winReasons: s.winReasons || null,
        // v257 — brain quality fields used by the UI to rank/badge
        brainScore: s.brainScore || null,
        acceptancePath: s.acceptancePath || null,
        expectedR: s.expectedR != null ? s.expectedR : null,
        brainRecommended: !!s.brainRecommended,
        isEliteBrainPattern: !!s.isEliteBrainPattern,
        isTopPick: !!s._isTopPick,
        bigMove: !!s.bigMove,
        inKillzone: !!s.inKillzone,
        // v249 — also forward namedStrategies + adx + pipPotential for the modal
        namedStrategies: s.namedStrategies || [],
        adx: s.adx,
        pipPotential: s.pipPotential,
        pWin: s.pWin,
        edge: s.edge,
        // v445 — outcome magnitude, not just won/lost. resultR is the actual
        // R-multiple (−1 for a stopped-out trade, +2.5/+5/+9 for TP1/2/3, and
        // the unrealised figure for an expiry). tpReached says which target
        // was actually tagged. maeR is worst drawdown in R — how deep the
        // trade went against you before it worked, which is what tells you
        // whether the stop was doing real work.
        resultR: s.resultR != null ? s.resultR : null,
        resultRHold: s.resultRHold != null ? s.resultRHold : null,
        tpReached: s.tpReached != null ? s.tpReached : null,
        maeR: s.maePips != null ? s.maePips : null,
        mfeR: s.mfeR != null ? s.mfeR : null,
        expiredInProfit: s.expiredInProfit === true ? true
                       : (s.status === 'expired' && s.resultR != null ? false : null),
        expiryClosedAtMarket: !!s.expiryClosedAtMarket,
        rReconstructed: !!s.rReconstructed,
      }));
    })(),
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
