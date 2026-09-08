// v485 — WALK-FORWARD BACKTEST OF THE REAL ENGINE.
//
// Not a replay of some proxy strategy. This imports the same strictAnalyze()
// that produces live signals, steps through history one bar at a time, and at
// each step shows it ONLY the bars that existed at that moment. Anything it
// produces is then walked forward against the bars that came next, using the
// v442 managed ladder exactly as the app instructs: a third banked at each
// target, stop to entry after TP1, stop to TP1 after TP2.
//
// Two rules make the difference between a backtest and a flattering story:
//
//   NO LOOKAHEAD. The engine sees history[0..i]; the outcome is decided by
//   history[i+1..]. It cannot see a single bar of its own future.
//
//   EPISODES, NOT PUBLICATIONS. A trending market re-fires the same setup on
//   consecutive bars. Counting those as separate trades is what turned a
//   -0.221R record into an apparent -0.005R earlier in this project. Overlapping
//   same-direction signals on a pair collapse into one episode.
//
// The honest limits, stated because they bound everything below: roughly one
// month of hourly bars per instrument is available, which is a small sample and
// one market regime. A result here is evidence about this month, not proof of
// an edge.
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { strictAnalyze } from '../functions/api/check-signals.js';

const STEP = Number(process.env.BT_STEP || 1);
const MIN_HISTORY = 250;
const MAX_HOLD = 48;

function walkOutcome(sig, future) {
  const buy = sig.direction === 'BUY';
  const slD = Math.abs(sig.entry - sig.sl);
  if (!(slD > 0)) return null;
  const rOf = (p) => (buy ? p - sig.entry : sig.entry - p) / slD;
  const tps = [sig.tp1, sig.tp2, sig.tp3];
  const W = [1 / 3, 1 / 3, 1 / 3];
  let stop = sig.sl, reached = 0, banked = 0;
  let mae = 0, mfe = 0;

  for (let i = 0; i < Math.min(future.length, MAX_HOLD); i++) {
    const b = future[i];
    mae = Math.max(mae, -Math.min(rOf(buy ? b.l : b.h), 0));
    mfe = Math.max(mfe, Math.max(rOf(buy ? b.h : b.l), 0));
    // Stop checked first — the conservative ordering when a bar spans both.
    if (buy ? b.l <= stop : b.h >= stop) {
      const remaining = 1 - W.slice(0, reached).reduce((a, c) => a + c, 0);
      const exitR = reached === 0 ? -1 : (reached === 1 ? 0 : rOf(tps[0]));
      return { r: banked + remaining * exitR, tpReached: reached, bars: i + 1, mae, mfe };
    }
    while (reached < 3 && (buy ? b.h >= tps[reached] : b.l <= tps[reached])) {
      banked += W[reached] * rOf(tps[reached]);
      reached++;
      if (reached === 1) stop = sig.entry;
      else if (reached === 2) stop = tps[0];
    }
    if (reached === 3) return { r: banked, tpReached: 3, bars: i + 1, mae, mfe };
  }
  // Timed out: whatever is open closes at the last price seen.
  const last = future[Math.min(future.length, MAX_HOLD) - 1];
  if (!last) return null;
  const remaining = 1 - W.slice(0, reached).reduce((a, c) => a + c, 0);
  return { r: banked + remaining * rOf(last.c), tpReached: reached, bars: MAX_HOLD, mae, mfe, timedOut: true };
}

const trades = [];
let evaluated = 0;

for (const f of readdirSync('data/ohlc').filter(x => x.endsWith('.json'))) {
  const pair = f.replace('.json', '').replace('-', '/');
  const raw = JSON.parse(readFileSync(`data/ohlc/${f}`, 'utf8'));
  const bars = Array.isArray(raw) ? raw : (raw.bars || raw.ohlc || []);
  if (bars.length < MIN_HISTORY + 60) continue;

  for (let i = MIN_HISTORY; i < bars.length - MAX_HOLD; i += STEP) {
    evaluated++;
    let sig = null;
    try { sig = strictAnalyze(pair, bars.slice(0, i + 1), []); } catch { continue; }
    if (!sig || !sig.direction || sig.entry == null || sig.sl == null) continue;
    const out = walkOutcome(sig, bars.slice(i + 1));
    if (!out) continue;
    trades.push({
      pair, direction: sig.direction, at: bars[i].t,
      confidence: sig.confidence, strategies: sig.strategies,
      namedStrategies: sig.namedStrategies || [], comboKey: sig.comboKey || null,
      adx: sig.adx, inKillzone: sig.inKillzone,
      independentFamilies: sig.independentFamilies,
      dailyAligned: sig.dailyHtf ? sig.dailyHtf.aligned : null,
      ...out,
    });
  }
}

// Collapse overlapping same-direction signals into episodes.
trades.sort((a, b) => a.at - b.at);
const episodes = [];
for (const t of trades) {
  const open = episodes.find(e => e.pair === t.pair && e.direction === t.direction
    && (t.at - e.lastAt) / 3600000 <= Math.max(e.bars, 6));
  if (open) { open.members.push(t); open.lastAt = t.at; open.bars = Math.max(open.bars, t.bars); }
  else episodes.push({ pair: t.pair, direction: t.direction, lastAt: t.at, bars: t.bars, members: [t] });
}
const eps = episodes.map(e => {
  const m = e.members;
  const avg = (k) => m.reduce((a, x) => a + (x[k] || 0), 0) / m.length;
  return { ...m[0], r: avg('r'), size: m.length };
});

const mean = (v) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
function ci(v, n = 4000) {
  if (v.length < 5) return null;
  const s = [];
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (let j = 0; j < v.length; j++) t += v[Math.floor(Math.random() * v.length)];
    s.push(t / v.length);
  }
  s.sort((a, b) => a - b);
  return [+s[Math.floor(0.025 * n)].toFixed(3), +s[Math.floor(0.975 * n)].toFixed(3)];
}

const all = eps.map(e => e.r);
const overall = { n: eps.length, avgR: +mean(all).toFixed(3), ci: ci(all),
  winRate: +(eps.filter(e => e.r > 0.02).length / Math.max(1, eps.length)).toFixed(3) };

function group(keyFn) {
  const bag = {};
  for (const e of eps) for (const k of [].concat(keyFn(e) || [])) if (k != null) (bag[k] ||= []).push(e.r);
  return Object.entries(bag).map(([k, v]) => ({ key: k, n: v.length, avgR: +mean(v).toFixed(3), ci: ci(v) }))
    .filter(x => x.n >= 5).sort((a, b) => b.avgR - a.avgR);
}

const report = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  method: 'walk-forward, no lookahead, real strictAnalyze, v442 managed ladder, episodes not publications',
  barPositionsEvaluated: evaluated,
  rawSignals: trades.length,
  episodes: eps.length,
  overall,
  byStrategy: group(e => e.namedStrategies),
  byCombo: group(e => e.comboKey),
  byPair: group(e => e.pair),
  byStrategyCount: group(e => `${e.strategies} strategies`),
  byKillzone: group(e => e.inKillzone ? 'in killzone' : 'outside'),
  byDailyAlignment: group(e => e.dailyAligned),
  caveat: 'About one month of hourly bars per instrument — a small sample in a single '
        + 'market regime. Evidence about this period, not proof of an edge.',
};
writeFileSync('data/backtest.json', JSON.stringify(report, null, 2));

console.log(`evaluated ${evaluated} bar positions -> ${trades.length} signals -> ${eps.length} episodes`);
console.log(`overall ${overall.avgR >= 0 ? '+' : ''}${overall.avgR}R  win rate ${(overall.winRate*100).toFixed(1)}%  CI[${overall.ci}]`);
for (const [name, rows] of [['strategy', report.byStrategy], ['pair', report.byPair],
                            ['strategy count', report.byStrategyCount], ['daily alignment', report.byDailyAlignment]]) {
  console.log(`\n  by ${name}:`);
  for (const r of rows.slice(0, 6)) {
    const sig = r.ci && r.ci[0] > 0 ? '  <- clears zero' : '';
    console.log(`    ${String(r.key).padEnd(26)} n=${String(r.n).padEnd(4)} ${r.avgR >= 0 ? '+' : ''}${r.avgR}R  CI[${r.ci}]${sig}`);
  }
}
