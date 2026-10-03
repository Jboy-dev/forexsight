#!/usr/bin/env node
/**
 * build-ledger.mjs — the complete record of every signal this site has published.
 *
 * Reads the working book AND the archive, deduplicates by key, and computes the
 * record. Three things it refuses to do, each of which would flatter the number:
 *
 *  1. IT DOES NOT PICK A WIN RATE. There are two defensible definitions and
 *     they differ by fifteen points here:
 *       by outcome  — did it close positive? (expired-but-positive counts)
 *       by target   — did it actually reach a take-profit?
 *     Both are published. Quoting only the kinder one is how a 31% hit rate
 *     gets advertised as 47%.
 *
 *  2. IT DOES NOT HIDE OPEN TRADES. A record of only closed trades lets losers
 *     sit open indefinitely and never count.
 *
 *  3. IT COLLAPSES EPISODES ALONGSIDE THE RAW COUNT. Republications of one move
 *     are not independent evidence, and this project has been fooled by that.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const read = (p) => { try { const d = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } };

// Working book + archive, deduplicated. The archive holds what the 400-row cap
// used to delete outright.
const byKey = new Map();
for (const s of [...read('data/signal-archive.json'), ...read('data/open-setups.json')]) {
  if (s && s.key) byKey.set(s.key, s);           // later copy wins: it is more resolved
}
const all = [...byKey.values()].sort((a, b) => Date.parse(a.firedAt || 0) - Date.parse(b.firedAt || 0));
if (!all.length) { console.error('build-ledger: no setups found'); process.exit(1); }

const resolved = all.filter(s => typeof s.resultR === 'number' && isFinite(s.resultR));
const open = all.filter(s => s.status === 'open');

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const ci95 = a => { if (a.length < 2) return null; const se = sd(a) / Math.sqrt(a.length);
  return [+(mean(a) - 1.96 * se).toFixed(3), +(mean(a) + 1.96 * se).toFixed(3)]; };
const pct = (n, d) => d ? +((n / d) * 100).toFixed(1) : null;

/* ── the two win rates ──────────────────────────────────────────────────── */
const wonByOutcome = resolved.filter(s => s.resultR > 0);
const lostByOutcome = resolved.filter(s => s.resultR <= 0);
const hitTarget = resolved.filter(s => (s.tpReached || 0) >= 1);
const noTarget = resolved.filter(s => !(s.tpReached >= 1));

/* ── episode collapsing: same pair+direction inside 12h is one move ─────── */
function episodes(list) {
  const out = []; const last = new Map();
  for (const s of [...list].sort((a, b) => Date.parse(a.firedAt || 0) - Date.parse(b.firedAt || 0))) {
    const k = `${s.pair}|${s.direction}`;
    const t = Date.parse(s.firedAt || 0);
    const prev = last.get(k);
    if (prev && t - prev.t < 12 * 36e5) { prev.rs.push(s.resultR); prev.t = t; continue; }
    const e = { key: k, t, rs: [s.resultR] }; out.push(e); last.set(k, e);
  }
  return out.map(e => mean(e.rs));
}
const epR = episodes(resolved);

/* ── slices ─────────────────────────────────────────────────────────────── */
function slice(list, keyFn) {
  const g = new Map();
  for (const s of list) { const k = keyFn(s); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(s); }
  return [...g.entries()].map(([k, v]) => {
    const rs = v.map(x => x.resultR);
    const w = v.filter(x => x.resultR > 0).length;
    return { key: k, n: v.length, wins: w, losses: v.length - w, winRate: pct(w, v.length),
             avgR: +mean(rs).toFixed(3), totalR: +rs.reduce((a, b) => a + b, 0).toFixed(2), ci: ci95(rs) };
  }).sort((a, b) => b.n - a.n);
}
const confBand = (s) => { const c = s.confidence; if (typeof c !== 'number') return null;
  return c >= 90 ? '90+' : c >= 80 ? '80-89' : c >= 70 ? '70-79' : c >= 60 ? '60-69' : 'under 60'; };

/* ── streaks and the equity curve ───────────────────────────────────────── */
let curR = 0, peak = 0, maxDD = 0, curW = 0, curL = 0, bestW = 0, worstL = 0;
const curve = [];
for (const s of resolved) {
  curR += s.resultR;
  peak = Math.max(peak, curR);
  maxDD = Math.max(maxDD, peak - curR);
  if (s.resultR > 0) { curW++; curL = 0; bestW = Math.max(bestW, curW); }
  else { curL++; curW = 0; worstL = Math.max(worstL, curL); }
  curve.push(+curR.toFixed(2));
}

const rs = resolved.map(s => s.resultR);
const wAvg = mean(wonByOutcome.map(s => s.resultR));
const lAvg = mean(lostByOutcome.map(s => s.resultR));

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/build-ledger.mjs',
  coverage: {
    total: all.length, resolved: resolved.length, open: open.length,
    from: all[0]?.firedAt || null, to: all[all.length - 1]?.firedAt || null,
    archived: read('data/signal-archive.json').length,
    note: 'Working book plus archive, deduplicated by key. The archive exists because '
        + 'the book used to delete everything beyond the newest 400 outright.',
  },
  winRates: {
    byOutcome: { wins: wonByOutcome.length, losses: lostByOutcome.length, rate: pct(wonByOutcome.length, resolved.length),
                 definition: 'closed with a positive R, including setups that timed out while ahead' },
    byTarget:  { hit: hitTarget.length, missed: noTarget.length, rate: pct(hitTarget.length, resolved.length),
                 definition: 'actually reached TP1 or beyond' },
    note: 'These differ because a setup can time out slightly positive without ever reaching a '
        + 'target. Both are shown; quoting only the higher one would overstate the hit rate.',
  },
  returns: {
    avgR: +mean(rs).toFixed(4), totalR: +rs.reduce((a, b) => a + b, 0).toFixed(2),
    ci95: ci95(rs), stdDev: +sd(rs).toFixed(3),
    avgWin: +wAvg.toFixed(3), avgLoss: +lAvg.toFixed(3),
    payoff: lAvg !== 0 ? +Math.abs(wAvg / lAvg).toFixed(2) : null,
    expectancy: +(pct(wonByOutcome.length, resolved.length) / 100 * wAvg + (1 - pct(wonByOutcome.length, resolved.length) / 100) * lAvg).toFixed(4),
  },
  episodes: {
    count: epR.length, avgR: +mean(epR).toFixed(4), ci95: ci95(epR),
    inflation: +(resolved.length / Math.max(1, epR.length)).toFixed(2),
    note: 'Republications of the same move collapsed to one observation. This is the independent unit.',
  },
  risk: { maxDrawdownR: +maxDD.toFixed(2), longestWinStreak: bestW, longestLossStreak: worstL, peakR: +peak.toFixed(2) },
  byPair:      slice(resolved, s => s.pair),
  byDirection: slice(resolved, s => s.direction),
  byConfidence: slice(resolved, confBand),
  byRegime:    slice(resolved, s => (s.regime && s.regime.label) || s.regime || null),
  byOutcome:   slice(resolved, s => s.status),
  equityCurve: curve.length > 300 ? curve.filter((_, i) => i % Math.ceil(curve.length / 300) === 0) : curve,
  recent: all.slice(-120).reverse().map(s => ({
    key: s.key, pair: s.pair, direction: s.direction, firedAt: s.firedAt, status: s.status,
    resultR: typeof s.resultR === 'number' ? +s.resultR.toFixed(3) : null,
    tpReached: s.tpReached || 0, confidence: s.confidence ?? null,
    entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
    maeR: s.maeR ?? null, mfeR: s.mfeR ?? null, regime: (s.regime && s.regime.label) || s.regime || null,
  })),
};

const ciStr = out.returns.ci95 ? `[${out.returns.ci95.join(', ')}]` : '—';
out.verdict = out.returns.ci95 && out.returns.ci95[0] > 0
  ? `Positive and clear of zero: ${out.returns.avgR}R per signal, interval ${ciStr}.`
  : `${out.returns.avgR}R per signal with interval ${ciStr}, which includes zero — `
    + `the record does not establish an edge in either direction. Collapsed to `
    + `${out.episodes.count} independent episodes it reads ${out.episodes.avgR}R.`;

writeFileSync('data/ledger.json', JSON.stringify(out, null, 2));

console.log(`ledger: ${out.coverage.total} signals (${out.coverage.resolved} resolved, ${out.coverage.open} open)`);
console.log(`  ${String(out.coverage.from).slice(0,10)} -> ${String(out.coverage.to).slice(0,10)}`);
console.log(`  win rate by outcome : ${out.winRates.byOutcome.rate}%  (${out.winRates.byOutcome.wins}W / ${out.winRates.byOutcome.losses}L)`);
console.log(`  win rate by target  : ${out.winRates.byTarget.rate}%  (${out.winRates.byTarget.hit} reached TP1+)`);
console.log(`  avg ${out.returns.avgR}R  total ${out.returns.totalR}R  payoff ${out.returns.payoff}  CI ${ciStr}`);
console.log(`  episodes ${out.episodes.count} (inflation ${out.episodes.inflation}x) avg ${out.episodes.avgR}R`);
console.log(`  max drawdown ${out.risk.maxDrawdownR}R  longest loss streak ${out.risk.longestLossStreak}`);
console.log(`  ${out.verdict}`);
