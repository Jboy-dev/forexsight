// /api/brain-context — Returns a single snapshot of everything the brain
// "knows" about the current site state. Used by check-signals.js to make
// context-aware scoring decisions, and rendered on the dashboard so the user
// can see what the brain is paying attention to.
//
// Aggregates from existing KV stores + endpoints:
//   • Brain stats (top patterns, best hours)
//   • Pro consensus (analyst direction)
//   • Shadow tracker (last 20 signal outcomes)
//   • Calendar events (next high-impact event time)
//   • Recent market state (last gold OHLC bar)

async function safeFetch(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // 1) Brain stats
  let brain = null;
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('learning-brain');
      if (raw) brain = JSON.parse(raw);
    } catch {}
  }

  // 2) Pro consensus
  const consensus = await safeFetch(`${origin}/api/pro-consensus`);

  // 3) Shadow tracker
  let shadow = null;
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('shadow-tracker');
      if (raw) shadow = JSON.parse(raw);
    } catch {}
  }

  // 4) Calendar / news blackout window — basic heuristic from current time
  // Mirror v184 NEWS BLACKOUT rules so the brain knows what the auto-take
  // gate is currently doing.
  const now = new Date();
  const utcDow = now.getUTCDay();
  const utcDom = now.getUTCDate();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const isFirstFriday = utcDow === 5 && utcDom <= 7;
  let newsBlackout = null;
  if (isFirstFriday && utcH === 12) newsBlackout = 'NFP release window (12:00-13:00 UTC)';
  else if (isFirstFriday && utcH === 13 && utcM <= 30) newsBlackout = 'NFP post-release whipsaw (13:00-13:30 UTC)';
  else if (utcDow === 3 && utcH === 17 && utcM >= 30) newsBlackout = 'FOMC pre-release (Wed 17:30-18:00 UTC)';
  else if (utcDow === 3 && utcH === 18) newsBlackout = 'FOMC release (Wed 18:00-19:00 UTC)';
  else if (utcDow === 3 && utcH === 19 && utcM <= 30) newsBlackout = 'FOMC post-release whipsaw (Wed 19:00-19:30 UTC)';

  // 5) Compute current "regime read" from brain
  let regimeRead = null;
  if (brain && brain.topWinners && brain.topWinners.length > 0) {
    const top = brain.topWinners[0];
    regimeRead = `Top pattern: ${top.k} · ${Math.round(top.wr * 100)}% WR over ${top.n} samples · avg ${Math.round(top.avgBars || 0)} bars to resolve`;
  }

  // 6) Recent shadow performance (last 10 resolved signals overall)
  let shadowRecent = null;
  if (shadow && Array.isArray(shadow)) {
    const resolved = shadow.filter(s => s.status === 'won' || s.status === 'lost').slice(0, 10);
    const w = resolved.filter(s => s.status === 'won').length;
    const l = resolved.filter(s => s.status === 'lost').length;
    shadowRecent = {
      last10: { w, l, wr: (w + l) ? Math.round(w / (w + l) * 100) : null },
      sample: resolved.slice(0, 5).map(s => ({
        pair: s.pair, direction: s.direction, status: s.status, firedAt: s.firedAt,
      })),
    };
  }

  // 7) Pro consensus summary — direction the analysts collectively favor for gold
  let goldAnalystView = null;
  if (consensus && Array.isArray(consensus.consensus)) {
    const goldRow = consensus.consensus.find(c => c.pair === 'XAU/USD' || c.pair === 'GOLD');
    if (goldRow) {
      goldAnalystView = {
        direction: goldRow.direction,
        sources: goldRow.sourceCount,
        headlines: (goldRow.samples || []).slice(0, 2).map(s => s.title),
      };
    }
  }

  // 8) Active session for context
  const inLondon = utcH >= 8 && utcH < 17;
  const inNY = utcH >= 13 && utcH < 22;
  const overlap = inLondon && inNY;
  const activeSession = overlap ? 'LONDON+NY overlap (peak)' :
                        inLondon ? 'LONDON open' :
                        inNY ? 'NEW YORK open' :
                        utcH >= 0 && utcH < 9 ? 'Asian session' : 'Off-session';

  const payload = {
    ok: true,
    ts: Date.now(),
    isoTime: now.toISOString(),
    brainContext: {
      // What the brain knows from backtests
      backtestSamples: brain ? brain.totalSamples : 0,
      backtestRuns: brain ? brain.runs : 0,
      topPattern: brain && brain.topWinners ? brain.topWinners[0] : null,
      fastWinners: brain && brain.fastWinners ? brain.fastWinners.slice(0, 5) : [],
      slowPatternsBlocked: brain && brain.slowPatterns ? brain.slowPatterns.length : 0,
      regimeRead,
      // What's happening on the website right now
      currentTimeUTC: now.toISOString(),
      activeSession,
      newsBlackout,
      goldAnalystView,
      shadowRecent,
      // System awareness
      systemFlags: {
        autoTakeAllowed: !newsBlackout && (utcH >= 13 && utcH <= 16 || utcH === 19),
        killzoneActive: (utcH >= 13 && utcH <= 16) || utcH === 19,
        consensusAligned: !!goldAnalystView,
      },
    },
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
