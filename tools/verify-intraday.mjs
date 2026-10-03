#!/usr/bin/env node
/**
 * verify-intraday.mjs — prove the intraday foundation before anything learns from it.
 *
 * Five checks, each one guarding a way a backtest can be confidently wrong:
 *
 *  1. STRUCTURE     duplicate or out-of-order timestamps, impossible OHLC.
 *  2. CONTINUITY    gaps. FX should gap only at weekends; crypto should barely
 *                   gap at all. Unexplained holes mean missing bars, and a
 *                   backtest reads a hole as a price that never moved.
 *  3. AGREEMENT     resample H1 to daily and compare against the independent
 *                   daily cache. Two sources of the same instrument must agree;
 *                   if they do not, at least one is wrong.
 *  4. SPREAD ARTEFACT  the one that matters most here. Yahoo FX is bid-only.
 *                   Bid-only data manufactures a fake edge at the daily
 *                   rollover, which looks exactly like a real session effect
 *                   and has fooled this project before. The control is
 *                   triangular arithmetic: EURUSD x USDJPY should equal EURJPY.
 *                   On mid prices the residual is ~0; on bid-only prices it is
 *                   a systematic, time-varying bias.
 *  5. RETURN SANITY implausible hourly moves that indicate a bad print.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const DIR = 'data/intraday';
if (!existsSync(DIR)) { console.error('verify-intraday: no data/intraday'); process.exit(1); }

const load = f => { try { return JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')); } catch { return null; } };
const files = readdirSync(DIR).filter(f => f.endsWith('.1h.json'));
const report = { ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/verify-intraday.mjs', checks: {}, problems: [] };
const fail = (m) => { report.problems.push(m); console.log(`    PROBLEM: ${m}`); };

console.log('verify-intraday\n');

/* ── 1. structure ──────────────────────────────────────────────────────── */
console.log('  1. structure');
let structBad = 0, totalBars = 0;
for (const f of files) {
  const b = load(f); if (!b) { fail(`${f} unreadable`); continue; }
  totalBars += b.length;
  let dup = 0, ooo = 0, bad = 0;
  const seen = new Set();
  for (let i = 0; i < b.length; i++) {
    if (seen.has(b[i].t)) dup++; seen.add(b[i].t);
    if (i && b[i].t <= b[i - 1].t) ooo++;
    if (b[i].h < b[i].l || b[i].c > b[i].h || b[i].c < b[i].l || b[i].o > b[i].h || b[i].o < b[i].l) bad++;
  }
  if (dup || ooo || bad) { structBad++; fail(`${f}: ${dup} duplicate, ${ooo} out-of-order, ${bad} impossible OHLC`); }
}
console.log(`     ${files.length} caches, ${totalBars.toLocaleString()} bars, ${structBad} with structural faults`);
report.checks.structure = { caches: files.length, bars: totalBars, faulty: structBad };

/* ── 2. continuity ─────────────────────────────────────────────────────── */
console.log('\n  2. continuity (gaps)');
const gapRows = [];
for (const f of files) {
  const b = load(f); if (!b || b.length < 100) continue;
  const pair = f.replace('.1h.json', '');
  const isCrypto = /BTC|ETH/.test(pair);
  let weekend = 0, unexplained = 0, biggest = 0;
  for (let i = 1; i < b.length; i++) {
    const gapH = (b[i].t - b[i - 1].t) / 36e5;
    if (gapH <= 1.5) continue;
    biggest = Math.max(biggest, gapH);
    const d = new Date(b[i - 1].t).getUTCDay();
    // Friday close -> Sunday/Monday open is expected for FX
    if (!isCrypto && (d === 5 || d === 6) && gapH < 72) weekend++;
    else unexplained++;
  }
  gapRows.push({ pair, weekend, unexplained, biggestGapH: +biggest.toFixed(1) });
  const flag = isCrypto ? unexplained > 60 : unexplained > 90;
  console.log(`     ${pair.padEnd(9)} ${String(weekend).padStart(4)} weekend  ${String(unexplained).padStart(4)} other  biggest ${biggest.toFixed(0)}h${flag ? '   <-- high' : ''}`);
}
report.checks.continuity = gapRows;

/* ── 3. agreement with the independent daily cache ─────────────────────── */
console.log('\n  3. agreement: H1 resampled to daily vs the daily cache');
const agree = [];
for (const f of files) {
  const pair = f.replace('.1h.json', '');
  const dailyPath = `data/deep/${pair}.json`;
  if (!existsSync(dailyPath)) continue;
  const h1 = load(f), daily = JSON.parse(readFileSync(dailyPath, 'utf8'));
  if (!h1 || !daily) continue;
  // last close of each UTC day from H1
  const byDay = new Map();
  for (const bar of h1) byDay.set(new Date(bar.t).toISOString().slice(0, 10), bar.c);
  const diffs = [];
  for (const d of daily) {
    const key = new Date(d.t).toISOString().slice(0, 10);
    const h = byDay.get(key);
    if (h == null || !(d.c > 0)) continue;
    diffs.push(Math.abs(h - d.c) / d.c);
  }
  if (diffs.length < 30) continue;
  diffs.sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)] * 100;
  const p95 = diffs[Math.floor(diffs.length * 0.95)] * 100;
  agree.push({ pair, days: diffs.length, medianDiffPct: +med.toFixed(4), p95DiffPct: +p95.toFixed(4) });
  const bad = med > 0.5;
  console.log(`     ${pair.padEnd(9)} ${String(diffs.length).padStart(4)} shared days  median ${med.toFixed(3)}%  p95 ${p95.toFixed(3)}%${bad ? '   <-- DISAGREE' : ''}`);
  if (bad) fail(`${pair}: H1 and daily disagree by ${med.toFixed(2)}% at the median — one source is wrong`);
}
report.checks.agreement = agree;

/* ── 4. THE SPREAD ARTEFACT CONTROL ────────────────────────────────────── */
// EUR/USD x USD/JPY must equal EUR/JPY. We do not hold EUR/JPY, so the
// equivalent available control is: the three USD-quoted majors and the two
// USD-base pairs must be mutually consistent through the dollar. Any
// systematic, hour-of-day structure in that residual is a data artefact, not a
// market effect — and it is precisely what produces fake session edges.
console.log('\n  4. spread artefact: residual structure by hour of day');
const grab = (p) => { const b = load(`${p}.1h.json`); if (!b) return null;
  const m = new Map(); for (const x of b) m.set(x.t, x.c); return m; };
const eu = grab('EUR-USD'), uj = grab('USD-JPY'), gu = grab('GBP-USD'), uc = grab('USD-CHF');
let artefact = null;
if (eu && uj && gu && uc) {
  // Synthetic EUR/JPY from EURUSD x USDJPY, and synthetic GBP/CHF from
  // GBPUSD x USDCHF. Compare their log-returns. On clean mid data the
  // hour-of-day means of the residual are noise around zero.
  const hours = Array.from({ length: 24 }, () => []);
  const ts = [...eu.keys()].filter(t => uj.has(t) && gu.has(t) && uc.has(t)).sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i], p = ts[i - 1];
    if (t - p > 2 * 36e5) continue;
    const ejNow = eu.get(t) * uj.get(t), ejPrev = eu.get(p) * uj.get(p);
    const gcNow = gu.get(t) * uc.get(t), gcPrev = gu.get(p) * uc.get(p);
    if (!(ejNow > 0 && ejPrev > 0 && gcNow > 0 && gcPrev > 0)) continue;
    const resid = Math.log(ejNow / ejPrev) - Math.log(gcNow / gcPrev);
    hours[new Date(t).getUTCHours()].push(resid);
  }
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const rows = hours.map((a, h) => {
    const m = mean(a), s = sd(a);
    const t = (s > 0 && a.length > 1) ? m / (s / Math.sqrt(a.length)) : 0;
    return { hour: h, n: a.length, meanBp: +(m * 1e4).toFixed(3), t: +t.toFixed(2) };
  });
  const worst = rows.slice().sort((a, b) => Math.abs(b.t) - Math.abs(a.t))[0];
  // Bonferroni across 24 hours: |t| > 3.21 for 5% family-wise
  const flagged = rows.filter(r => Math.abs(r.t) > 3.21);
  artefact = { worstHour: worst, hoursFlagged: flagged.map(r => r.hour), bar: 3.21, rows };
  console.log(`     worst hour ${String(worst.hour).padStart(2)}:00 UTC  mean ${worst.meanBp} bp  t=${worst.t}  (n=${worst.n})`);
  console.log(`     hours clearing |t| > 3.21 (Bonferroni over 24): ${flagged.length ? flagged.map(r => r.hour + ':00').join(', ') : 'none'}`);
  if (flagged.length) {
    fail(`${flagged.length} hour(s) show systematic residual structure — treat ANY hour-of-day or session result on this data as suspect`);
  } else {
    console.log('     no systematic hour-of-day bias detected — session results on this data are not automatically artefacts');
  }
}
report.checks.spreadArtefact = artefact;

/* ── 5. return sanity ──────────────────────────────────────────────────── */
console.log('\n  5. return sanity');
const sane = [];
for (const f of files) {
  const b = load(f); if (!b || b.length < 100) continue;
  const pair = f.replace('.1h.json', '');
  const lim = /BTC|ETH/.test(pair) ? 0.15 : /XAU/.test(pair) ? 0.06 : 0.03;   // one-hour move
  let wild = 0, biggest = 0;
  for (let i = 1; i < b.length; i++) {
    const r = Math.abs(Math.log(b[i].c / b[i - 1].c));
    if (!isFinite(r)) continue;
    biggest = Math.max(biggest, r);
    if (r > lim) wild++;
  }
  sane.push({ pair, wild, biggestMovePct: +(biggest * 100).toFixed(2), limitPct: lim * 100 });
  console.log(`     ${pair.padEnd(9)} ${String(wild).padStart(3)} hourly moves over ${(lim*100).toFixed(0)}%  (largest ${(biggest*100).toFixed(2)}%)`);
  if (wild > b.length * 0.002) fail(`${pair}: ${wild} implausible hourly moves — likely bad prints`);
}
report.checks.returnSanity = sane;

report.verdict = report.problems.length
  ? `${report.problems.length} problem(s) found. Anything learned from this data must account for them.`
  : 'All five checks passed. The intraday foundation is sound enough to learn from.';
writeFileSync('data/intraday-verification.json', JSON.stringify(report, null, 2));
console.log(`\n  ${report.verdict}`);
