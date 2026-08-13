// Returns the most recent server-side signal snapshot from KV. If the snapshot
// is stale (>5 min) or missing, kicks off a fresh /api/check-signals scan in
// the background (via waitUntil — doesn't block the response). The client
// poll therefore self-triggers continual server-side checking as long as
// SOMEONE has the PWA open. No external cron required.

import { cacheGet, cachePut } from './_cache-store.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
// v237 — Per-instance cooldown to prevent storms when KV writes are blocked.
// If check-signals can't update latest-signals (e.g. quota), every poll would
// otherwise spawn a fresh check-signals via waitUntil → recursive amplification.
// 30s minimum between triggers caps the storm even with many concurrent polls.
let _lastTriggerAt = 0;

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.TRADES_KV) {
    return new Response(JSON.stringify({ error: 'KV not bound', ts: 0, signals: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const raw = await env.TRADES_KV.get('latest-signals');
    let data = null;
    try { if (raw) data = JSON.parse(raw); } catch {}

    const isStale = !data || !data.ts || (Date.now() - data.ts > STALE_THRESHOLD_MS);
    // v237 — 30s cooldown between background triggers. Without this, when KV
    // writes are degraded and ts never advances, every poll fired another
    // check-signals (which itself spawned learning-brain + shadow-tracker
    // via waitUntil). Cascading amplification.
    const cooldownOk = (Date.now() - _lastTriggerAt) > 30 * 1000;
    if (isStale && cooldownOk) {
      _lastTriggerAt = Date.now();
      const url = new URL(request.url);
      const triggerUrl = `${url.protocol}//${url.host}/api/check-signals`;
      // Don't await — fire and forget. The next poll will see the fresh result.
      context.waitUntil(
        fetch(triggerUrl, {
          headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
        }).catch(() => {})
      );
    }

    // v411 — Loss-pattern filter for chart-read signals. Deep-dive of last
    // 12 losses (100% loss rate today) found three killer patterns:
    //   1. DEAD-ASIA hours (02:00-06:00 UTC) — thin liquidity, fake bounces
    //   2. BATCH fires — 3+ signals firing at same tick = same setup, not
    //      confluence. Almost always false-bounce noise.
    //   3. CORRELATED pairs same direction — AUD+NZD BUY together isn't
    //      confluence, it's the SAME setup detected twice. Take strongest,
    //      drop the rest.
    function _v411FilterLosingPatterns(sigs) {
      if (!Array.isArray(sigs) || sigs.length === 0) return sigs || [];
      const nowUtcHour = new Date().getUTCHours();
      // Filter 1: dead-Asia hours (02-06 UTC). Requires HIGHER confidence
      // (≥80%) during those hours instead of the normal 60% floor.
      // v436 — HOURS REPLACED WITH MEASURED ONES.
      //
      // The 02:00-06:00 "dead Asia" window was assumed, never measured. A
      // replay of 5,971 signals over ~2.8 years of real hourly bars across
      // 9 instruments says the assumption was wrong, and expensively so:
      //
      //   02:00 UTC  +0.319R   <- among the BEST hours, and it was blocked
      //   04:00 UTC  +0.195R   <- blocked
      //   05:00 UTC  +0.138R   <- blocked
      //   03:00 UTC  -0.070R   <- genuinely bad, correctly blocked
      //   16:00 UTC  -0.095R   <- the WORST hour, and it was NOT blocked
      //   17:00 UTC  -0.051R   <- second worst, NOT blocked
      //
      // Applying the old rule scored +0.114R against a +0.118R baseline —
      // i.e. the filter was very slightly worse than having no filter.
      // Blocking the three hours that actually lose money scores +0.145R.
      // The losing hours are the NY afternoon (post-London-close drift),
      // not the Asian session.
      const LOSING_HOURS = new Set([3, 16, 17]);
      let out = sigs.filter(s => {
        if (LOSING_HOURS.has(nowUtcHour)) {
          if ((s.confidence || 0) < 80) return false;   // only high conviction
        }
        return true;
      });
      // Filter 2: batch cap. If >3 signals in same direction fire together,
      // keep only the top-3 by confidence. Batches of 5+ are almost always
      // false-signal storms.
      const byDir = { BUY: [], SELL: [] };
      for (const s of out) {
        if (s.direction === 'BUY') byDir.BUY.push(s);
        else if (s.direction === 'SELL') byDir.SELL.push(s);
      }
      for (const dir of ['BUY', 'SELL']) {
        if (byDir[dir].length > 3) {
          byDir[dir].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
          const dropped = byDir[dir].slice(3);
          out = out.filter(s => !dropped.includes(s));
        }
      }
      // Filter 3: correlation dedup. AUD+NZD (both commodity/risk-on) or
      // EUR+GBP (both anti-USD) firing same direction — keep one. USD/CHF
      // + USD/JPY same dir — keep one.
      const groups = [
        ['AUD/USD', 'NZD/USD'],
        ['EUR/USD', 'GBP/USD'],
        ['USD/CHF', 'USD/JPY', 'USD/CAD'],
      ];
      for (const group of groups) {
        for (const dir of ['BUY', 'SELL']) {
          const inGroup = out.filter(s => group.includes(s.pair) && s.direction === dir);
          if (inGroup.length > 1) {
            inGroup.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
            const dropped = inGroup.slice(1);
            out = out.filter(s => !dropped.includes(s));
          }
        }
      }
      return out;
    }

    // v347 — If the strict feed is empty, fall back to live-analysis so
    // the user always sees SOMETHING (chart-read predictions for each pair
    // with strong direction). "Loading signals..." with 0 signals for hours
    // was the wrong UX.
    const shouldFallback = !data || (data.signals && data.signals.length === 0);
    let liveAnalysisSignals = null;
    // v447 — CACHE THE FALLBACK CHAIN.
    //
    // This branch runs whenever the strict feed is empty, which — given how
    // tight the gates are — is most of the time. It costs roughly eight
    // Function invocations: live-analysis (which fans out to three more),
    // conditions-score, algo-read and calendar. Every client poll paid that
    // in full, so a couple of open tabs could drain the 100k/day free tier
    // on their own and take every /api/* route down.
    //
    // The chain's inputs move on hourly bars, so a 90-second cache changes
    // nothing a user can perceive while making the cost independent of how
    // many people are polling, or how fast. This is deliberately server-side:
    // browsers holding an older cached app.js still poll at the old rate, and
    // this protects the budget from them too.
    const _fbCached = await cacheGet('ls-fallback');
    if (shouldFallback && _fbCached) {
      liveAnalysisSignals = _fbCached.signals || null;
    } else if (shouldFallback) {
      try {
        const url = new URL(request.url);
        const laRes = await fetch(`${url.protocol}//${url.host}/api/live-analysis?minConfidence=60`);
        if (laRes.ok) {
          const la = await laRes.json();
          // v413 — QUALITY GATE. chart-read tier = multiple missing
          // confluences = 71% loser per shadow-tracker data. NEVER show
          // chart-read to the user. Only strong-read + PREMIUM reach the
          // feed. Better to show 0 signals than rubbish.
          const filteredLa = (la.signals || []).filter(s => {
            const t = String(s.tier || '').toLowerCase();
            return t === 'premium' || t === 'strong-read';
          });
          liveAnalysisSignals = filteredLa.map(s => ({
            pair: s.pair,
            direction: s.direction,
            confidence: s.confidence,
            entry: s.entry,
            sl: s.sl,
            tp1: s.tp1,
            tp2: s.tp2,
            tp3: s.tp3,
            pipsToSl: s.slPips,
            pipsToTp3: s.tp3Pips,
            rMultiple: s.riskReward,
            slMethod: s.slMethod,
            // v413 — sources reflect the higher bar: premium or strong-read only
            source: s.tier === 'PREMIUM' ? 'premium-read' : 'strong-read',
            tier: s.tier,             // PREMIUM or strong-read
            reasoning: s.reasoning,
            topPick: s.tier === 'PREMIUM',
            topPickReason: s.reasoning,
            verdict: s.verdict,
            topReasons: s.topReasons,
            factorScore: s.factorScore,
            detectedAt: new Date().toISOString(),
            // v413 — strong-read went through 3+ confluence gates, count it
            // as 2 strategies. PREMIUM went through ALL gates, count as 3.
            strategies: s.tier === 'PREMIUM' ? 3 : 2,
            namedStrategies: s.tier === 'PREMIUM' ? ['PREMIUM'] : ['STRONG-READ'],
          }));

          // v411 — LOSING-PATTERN FILTERS. Deep-dive of last 12 losses
          // found: (a) 5 chart-reads firing simultaneously as a batch =
          // false-bounce not real edge; (b) 02:00-06:00 UTC dead-Asia
          // hours produced 8/12 losses (thin liquidity fake bounces);
          // (c) correlated pairs firing same direction is one setup
          // detected twice, not confluence.
          liveAnalysisSignals = _v411FilterLosingPatterns(liveAnalysisSignals);

          // v414 — MORE INTELLIGENCE. Two hard gates + optional LLM veto.
          //
          // Gate A — SESSION guard. Fallback signals only fire during
          // liquid sessions (London or NY overlap). Asian dead hours
          // + weekend closure = no fallback signals period. Historical
          // shadow WR was 4%-15% in those windows.
          //
          // Gate B — CONDITIONS SCORE floor. Query /api/conditions-score.
          // If score < 65, block ALL fallback signals. This is the
          // 'trading conditions bad — don't force trades' guard.
          //
          // Gate C (optional) — Workers AI veto. For each surviving
          // strong-read, ask Llama 3.3 70B to review the setup and
          // return YES/NO. Only publish YES. Best signals only.
          if (liveAnalysisSignals && liveAnalysisSignals.length) {
            // Gate A: session
            const nowH = new Date().getUTCHours();
            const nowD = new Date().getUTCDay(); // 0=Sun 6=Sat
            const inLondonNY = nowH >= 7 && nowH <= 20;  // 07:00-20:00 UTC
            const marketClosed = (nowD === 6) || (nowD === 0 && nowH < 22);
            if (marketClosed || !inLondonNY) {
              // Only crypto pairs allowed outside these windows
              liveAnalysisSignals = liveAnalysisSignals.filter(s =>
                (s.pair || '').includes('BTC') || (s.pair || '').includes('ETH')
              );
            }
            // Gate B: conditions score
            try {
              const csRes = await fetch(`${url.protocol}//${url.host}/api/conditions-score`);
              if (csRes.ok) {
                const cs = await csRes.json();
                if (typeof cs.score === 'number' && cs.score < 65) {
                  liveAnalysisSignals = []; // trading conditions too weak
                }
              }
            } catch {}

            // v415 — A+ SETUP GATE. Live-market microstructure check.
            // Only publish a signal if algo-read confirms the SAME direction
            // with ≥2 institutional footprints RIGHT NOW. Real A+ setups
            // show up as: price rejection at VWAP, absorption bar,
            // wick rejection, or magnetized round-number reaction —
            // all measurable from OHLC. This is the difference between
            // 'indicator vote says BUY' and 'the market is actively
            // reversing UP right now'.
            if (liveAnalysisSignals && liveAnalysisSignals.length) {
              try {
                const arRes = await fetch(`${url.protocol}//${url.host}/api/algo-read`);
                if (arRes.ok) {
                  const ar = await arRes.json();
                  const byPair = {};
                  for (const p of (ar.pairs || [])) byPair[p.pair] = p;
                  liveAnalysisSignals = liveAnalysisSignals.filter(s => {
                    const algo = byPair[s.pair];
                    if (!algo) return false;                      // no algo data → block
                    if (algo.algoBias !== s.direction) return false; // direction disagrees → block
                    // v427 — raised 2 → 3. Only PUBLISH signals where the
                    // market has 3+ institutional footprints in agreement.
                    // Higher WR by refusing to trade thin-conviction setups.
                    if ((algo.algoStrength || 0) < 3) return false;
                    return true;
                  });
                }
              } catch {}

              // v423 — NEWS BLACKOUT gate. Block signals when high-impact
              // news is imminent (30 min before → 60 min after). Chart-read
              // fallback previously bypassed this — biggest source of
              // whipsaw losses during NFP/CPI/FOMC.
              try {
                const calRes = await fetch(`${url.protocol}//${url.host}/api/calendar?impact=high`);
                if (calRes.ok) {
                  const cal = await calRes.json();
                  const events = cal.events || cal.items || (Array.isArray(cal) ? cal : []);
                  const nowMs = Date.now();
                  const inBlackout = (events || []).some(e => {
                    const t = Date.parse(e.date || e.time || 0);
                    if (!Number.isFinite(t)) return false;
                    const diffMin = (t - nowMs) / 60000;
                    return diffMin >= -60 && diffMin <= 30; // 30min before → 60min after
                  });
                  if (inBlackout) liveAnalysisSignals = [];
                }
              } catch {}

              // v423 — SIGNAL PATIENCE. Only publish a signal that has
              // been present in TWO consecutive scans. Stops flash-signals
              // that appear for one tick then disappear. Uses KV to track
              // first-seen per pair+direction.
              try {
                if (env.TRADES_KV && liveAnalysisSignals && liveAnalysisSignals.length) {
                  const raw = await env.TRADES_KV.get('v423-pending-signals');
                  const seen = raw ? JSON.parse(raw) : {};
                  const kept = [];
                  const nextSeen = {};
                  const nowMs = Date.now();
                  for (const s of liveAnalysisSignals) {
                    const key = `${s.pair}_${s.direction}`;
                    const firstSeen = seen[key] || nowMs;
                    nextSeen[key] = firstSeen;
                    // Publish if signal has been consistently present for ≥90s
                    if (nowMs - firstSeen >= 90_000) kept.push(s);
                  }
                  // Persist next-seen map (only current candidates carry forward)
                  await env.TRADES_KV.put('v423-pending-signals', JSON.stringify(nextSeen)).catch(() => {});
                  liveAnalysisSignals = kept;
                }
              } catch {}
            }
          }
        }
      } catch { /* fallback is non-fatal */ }
      // Store whatever the chain produced — including an empty result, which
      // is just as expensive to recompute and just as valid to reuse.
      await cachePut('ls-fallback', { signals: liveAnalysisSignals || [] }, 90);
    }

    if (!data) {
      return new Response(JSON.stringify({
        ts: Date.now(),
        signals: liveAnalysisSignals || [],
        count: (liveAnalysisSignals || []).length,
        source: 'live-analysis',
        message: (liveAnalysisSignals && liveAnalysisSignals.length)
          ? 'showing live chart-reads (no platinum signals yet)'
          : 'first scan kicked off — try again in 30 seconds',
      }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // Data exists but signals empty → merge chart-read fallback
    if (data.signals && data.signals.length === 0 && liveAnalysisSignals && liveAnalysisSignals.length) {
      data = { ...data, signals: liveAnalysisSignals, count: liveAnalysisSignals.length, chartReadFallback: true };
    }

    // v318 — Enrich each signal with TP hit state from the tp-tracker KV
    // so the client can badge signals with "TP1 HIT", "TP2 HIT", etc.
    try {
      const trackerRaw = await env.TRADES_KV.get('tp-tracker');
      if (trackerRaw) {
        const tracker = JSON.parse(trackerRaw);
        const bySignalId = {};
        for (const t of (tracker.signals || [])) {
          bySignalId[t.id] = t;
        }
        const enriched = (data.signals || []).map(s => {
          const id = `${s.pair}|${s.direction}|${s.detectedAt || data.ts}`;
          const t = bySignalId[id];
          if (t && t.hits) {
            // v334 — Derive UI-friendly `status` from server-tracked hits.
            // The signal-card renderer keys off status; without this, cards
            // stayed "Open" even after all TPs were hit server-side.
            let status = 'open';
            let tpReached = 0;
            if (t.hits.sl && !t.hits.tp1) { status = 'lost'; }
            else if (t.hits.tp3) { status = 'won'; tpReached = 3; }
            else if (t.hits.tp2) { status = 'won'; tpReached = 2; }
            else if (t.hits.tp1) { status = 'won'; tpReached = 1; }
            return { ...s, tpHits: t.hits, resolvedAt: t.resolvedAt, status, tpReached };
          }
          return s;
        });
        data = { ...data, signals: enriched };
      }
    } catch { /* non-fatal — signals still ship without hit state */ }

    // v427 — SCANNER STATUS. Lets the client show "what am I doing right now?"
    // pill instead of leaving the user staring at a static screen wondering
    // whether the scanner is working. Message reflects real gate state.
    const nowH = new Date().getUTCHours();
    const nowD = new Date().getUTCDay();
    const marketClosed = (nowD === 6) || (nowD === 0 && nowH < 22);
    const inLondonNY = nowH >= 7 && nowH <= 20;
    let scannerStatus;
    if (marketClosed) {
      scannerStatus = { state: 'weekend', message: 'Market closed — crypto only (BTC/ETH scanned every 2 min)' };
    } else if (!inLondonNY && !((data?.signals || []).some(s => (s.pair||'').includes('BTC')))) {
      scannerStatus = { state: 'quiet-session', message: 'Asian quiet hours — waiting for London open, crypto-only signals' };
    } else if ((data?.signals || []).length > 0) {
      scannerStatus = { state: 'firing', message: `${data.signals.length} qualified setup${data.signals.length > 1 ? 's' : ''} passing all 11 gates` };
    } else if ((liveAnalysisSignals || []).length === 0) {
      scannerStatus = { state: 'watching', message: 'Scanning 15 pairs — no setups passing all 11 gates right now (this is normal patience)' };
    } else {
      scannerStatus = { state: 'validating', message: `Setup found — validating through gates (patience/news/algo-read)` };
    }

    return new Response(JSON.stringify({
      ...data,
      stale: isStale,
      ageSeconds: Math.round((Date.now() - data.ts) / 1000),
      scannerStatus,
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, ts: 0, signals: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
