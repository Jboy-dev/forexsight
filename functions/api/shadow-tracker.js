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
  let latestSignals = [];
  try {
    const raw = await env.TRADES_KV.get('latest-signals');
    if (raw) {
      const data = JSON.parse(raw);
      latestSignals = Array.isArray(data.signals) ? data.signals : [];
    }
  } catch {}

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
    if (!pathA && !pathB && !pathC) continue;
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
  // v237 — Parallelize OHLC fetches. Sequential = 8 pairs × up to 7s each =
  // 56s worst case. Promise.all = bounded by the slowest single fetch.
  const pairList = Object.keys(openByPair);
  const ohlcMap = {};
  await Promise.all(pairList.map(async (pair) => {
    const sym = PAIR_TO_SYMBOL[pair] || pair.replace('/', '') + '=X';
    try { ohlcMap[pair] = await fetchOHLC(origin, sym); }
    catch { ohlcMap[pair] = null; }
  }));
  for (const pair of pairList) {
    const ohlc = ohlcMap[pair];
    if (!ohlc || ohlc.length < 5) continue;
    for (const s of openByPair[pair]) {
      const firedMs = Date.parse(s.firedAt || '');
      if (!Number.isFinite(firedMs)) continue;
      // Bars AFTER the signal fired
      const relevantBars = ohlc.filter(b => b.t > firedMs);
      if (!relevantBars.length) continue;
      const isBuy = s.direction === 'BUY';
      let outcome = null, atBar = null;
      for (let i = 0; i < relevantBars.length; i++) {
        const bar = relevantBars[i];
        if (isBuy) {
          if (bar.l <= s.sl) { outcome = 'lost'; atBar = i + 1; break; }
          if (bar.h >= s.tp1) { outcome = 'won'; atBar = i + 1; break; }
        } else {
          if (bar.h >= s.sl) { outcome = 'lost'; atBar = i + 1; break; }
          if (bar.l <= s.tp1) { outcome = 'won'; atBar = i + 1; break; }
        }
      }
      if (outcome) {
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
      // Auto-expire signals older than 48h still open — they're stale
      const ageHrs = (Date.now() - firedMs) / 3600000;
      if (!outcome && ageHrs > 48) {
        s.status = 'expired';
        s.checkedAt = new Date().toISOString();
      }
    }
  }

  // Compute summary stats
  const resolved = shadow.filter(s => s.status === 'won' || s.status === 'lost');
  const wins = resolved.filter(s => s.status === 'won').length;
  const losses = resolved.filter(s => s.status === 'lost').length;
  const shadowWR = resolved.length ? (wins / resolved.length * 100) : null;
  const open = shadow.filter(s => s.status === 'open').length;
  const expired = shadow.filter(s => s.status === 'expired').length;

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
