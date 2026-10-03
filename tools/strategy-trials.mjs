#!/usr/bin/env node
/**
 * strategy-trials.mjs — the broad search, done so a result can be believed.
 *
 * Earlier searches tested single families one at a time and found nothing. This
 * tests the CROSS PRODUCT of entry rules and filters, which is where an edge
 * would plausibly hide — a rule that fails on average can still work inside one
 * regime. That is also exactly where false discoveries come from, so the whole
 * design is built around not fooling itself:
 *
 *  1. THREE-WAY SPLIT, and the test set is opened once.
 *       train     oldest 50%   — where rules are allowed to look good by luck
 *       validate  next  25%    — survivors must repeat here
 *       SEALED    newest 25%   — touched once, at the end, for survivors only
 *
 *  2. MULTIPLE TESTING IS PRICED IN. Testing N combinations and keeping the
 *     best is not the same as testing one. The bar is Bonferroni-corrected by
 *     the number of hypotheses actually tried, which is counted, not guessed.
 *
 *  3. NON-OVERLAPPING TRADES. A position is held to resolution and the next
 *     entry may not begin until it closes, so two observations never share an
 *     outcome. This is the fault that made momentum look like +2.74 ATR.
 *
 *  4. A RANDOM-ENTRY NULL at matched trade count and holding period, so
 *     "positive" is measured against the alternative of trading at random
 *     rather than against zero.
 *
 *  5. COSTS CHARGED on every trade, entry at the NEXT bar's open.
 *
 * Writes data/strategy-trials.json. Promotion is a separate step and never
 * happens here — see tools/strategy-promote.mjs.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const DEEP = 'data/deep';
const COST_R = 0.02;          // round-trip cost as a share of risk
const MIN_TRADES = 40;        // below this a slice says nothing

// ── the managed ladder the site actually uses, so a result transfers ──────
const SL_ATR = 1.5, TP1 = 1.2, TP2 = 2.0, TP3 = 3.5;

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };

/* ── indicators ─────────────────────────────────────────────────────────── */
function atrSeries(b, p = 14) {
  const out = Array(b.length).fill(null); let acc = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= p) { acc += tr; if (i === p) out[i] = acc / p; }
    else out[i] = (out[i - 1] * (p - 1) + tr) / p;
  }
  return out;
}
function sma(c, p) { const o = Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= p) s -= c[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function rsi(c, p = 14) {
  const o = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d >= 0 ? g += d : l -= d; }
  g /= p; l /= p; o[p] = 100 - 100 / (1 + g / (l || 1e-9));
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = 100 - 100 / (1 + g / (l || 1e-9));
  }
  return o;
}
function pctRank(arr, i, look) {
  const lo = Math.max(0, i - look); let below = 0, n = 0;
  for (let j = lo; j < i; j++) { if (arr[j] == null) continue; n++; if (arr[j] < arr[i]) below++; }
  return n ? below / n : 0.5;
}

/* ── ENTRY RULES — each returns 'BUY' | 'SELL' | null at bar i ──────────── */
const ENTRIES = {
  'momentum-60':   (d, i) => { const a = d.c[i - 60]; return a ? (d.c[i] > a ? 'BUY' : 'SELL') : null; },
  'momentum-120':  (d, i) => { const a = d.c[i - 120]; return a ? (d.c[i] > a ? 'BUY' : 'SELL') : null; },
  'ma-cross-20-50':(d, i) => { if (d.ma20[i] == null || d.ma50[i] == null || d.ma20[i-1] == null) return null;
                               const now = d.ma20[i] > d.ma50[i], was = d.ma20[i-1] > d.ma50[i-1];
                               return now !== was ? (now ? 'BUY' : 'SELL') : null; },
  'rsi-reversion': (d, i) => { const r = d.rsi[i]; if (r == null) return null;
                               return r < 30 ? 'BUY' : r > 70 ? 'SELL' : null; },
  'rsi-trend':     (d, i) => { const r = d.rsi[i]; if (r == null) return null;
                               return r > 60 ? 'BUY' : r < 40 ? 'SELL' : null; },
  'donchian-20':   (d, i) => { let hi = -Infinity, lo = Infinity;
                               for (let j = i - 20; j < i; j++) { if (d.b[j].h > hi) hi = d.b[j].h; if (d.b[j].l < lo) lo = d.b[j].l; }
                               return d.c[i] > hi ? 'BUY' : d.c[i] < lo ? 'SELL' : null; },
  'inside-break':  (d, i) => { const p = d.b[i-1], q = d.b[i-2]; if (!p || !q) return null;
                               if (!(p.h < q.h && p.l > q.l)) return null;
                               return d.c[i] > p.h ? 'BUY' : d.c[i] < p.l ? 'SELL' : null; },
  'pullback-trend':(d, i) => { if (d.ma50[i] == null || d.rsi[i] == null) return null;
                               const up = d.c[i] > d.ma50[i];
                               if (up && d.rsi[i] < 45) return 'BUY';
                               if (!up && d.rsi[i] > 55) return 'SELL';
                               return null; },
};

/* ── FILTERS — each returns true if the trade is allowed at bar i ───────── */
const FILTERS = {
  'none':          () => true,
  'vol-high':      (d, i) => pctRank(d.atr, i, 252) > 0.66,
  'vol-low':       (d, i) => pctRank(d.atr, i, 252) < 0.34,
  'above-200':     (d, i) => d.ma200[i] != null && d.c[i] > d.ma200[i],
  'below-200':     (d, i) => d.ma200[i] != null && d.c[i] < d.ma200[i],
  'with-200':      (d, i, dir) => d.ma200[i] != null && ((dir === 'BUY') === (d.c[i] > d.ma200[i])),
  'against-200':   (d, i, dir) => d.ma200[i] != null && ((dir === 'BUY') !== (d.c[i] > d.ma200[i])),
  'expanding':     (d, i) => d.atr[i] != null && d.atr[i - 5] != null && d.atr[i] > d.atr[i - 5],
  'contracting':   (d, i) => d.atr[i] != null && d.atr[i - 5] != null && d.atr[i] < d.atr[i - 5],
};

/* ── the trade: enter next open, managed ladder, held to resolution ─────── */
function runTrade(d, i, dir) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i + 1] && d.b[i + 1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1;
  const slDist = a * SL_ATR;
  const sl  = entry - sign * slDist;
  const t1 = entry + sign * slDist * TP1, t2 = entry + sign * slDist * TP2, t3 = entry + sign * slDist * TP3;

  let banked = 0, left = 1, stop = sl, hit = 0;
  for (let j = i + 1; j < Math.min(d.b.length, i + 1 + 120); j++) {
    const bar = d.b[j];
    // stop is checked first: within one daily bar the adverse touch cannot be
    // ruled out, and assuming the favourable one came first is how a backtest
    // manufactures returns it could never have taken.
    if ((dir === 'BUY' && bar.l <= stop) || (dir === 'SELL' && bar.h >= stop)) {
      banked += left * ((stop - entry) * sign / slDist);
      return { r: banked - COST_R, bars: j - i, hit };
    }
    const reach = (lvl) => dir === 'BUY' ? bar.h >= lvl : bar.l <= lvl;
    if (hit < 1 && reach(t1)) { banked += (1 / 3) * TP1; left -= 1 / 3; stop = entry;       hit = 1; }
    if (hit < 2 && reach(t2)) { banked += (1 / 3) * TP2; left -= 1 / 3; stop = t1;          hit = 2; }
    if (hit < 3 && reach(t3)) { banked += left * TP3;    left = 0;                           hit = 3;
      return { r: banked - COST_R, bars: j - i, hit }; }
  }
  const last = d.b[Math.min(d.b.length - 1, i + 120)];
  banked += left * ((last.c - entry) * sign / slDist);
  return { r: banked - COST_R, bars: 120, hit };
}

/** Non-overlapping: no new entry until the open one resolves. */
function backtest(sets, entryFn, filterFn, lo, hi) {
  const rs = [];
  for (const d of sets) {
    const a = Math.max(210, Math.floor(d.b.length * lo));
    const z = Math.min(d.b.length - 2, Math.floor(d.b.length * hi));
    let free = a;
    for (let i = a; i < z; i++) {
      if (i < free) continue;
      const dir = entryFn(d, i); if (!dir) continue;
      if (!filterFn(d, i, dir)) continue;
      const t = runTrade(d, i, dir); if (!t) continue;
      rs.push(t.r);
      free = i + t.bars + 1;
    }
  }
  return rs;
}

function randomNull(sets, lo, hi, nTrades, draws = 200) {
  const outs = [];
  for (let k = 0; k < draws; k++) {
    const rs = [];
    for (const d of sets) {
      const a = Math.max(210, Math.floor(d.b.length * lo));
      const z = Math.min(d.b.length - 2, Math.floor(d.b.length * hi));
      let guard = 0;
      while (rs.length < nTrades / sets.length && guard++ < nTrades * 4) {
        const i = a + Math.floor(Math.random() * Math.max(1, z - a));
        const t = runTrade(d, i, Math.random() < 0.5 ? 'BUY' : 'SELL');
        if (t) rs.push(t.r);
      }
    }
    outs.push(mean(rs));
  }
  outs.sort((x, y) => x - y);
  return { p95: outs[Math.floor(outs.length * 0.95)], mean: mean(outs) };
}

/* ── load ───────────────────────────────────────────────────────────────── */
if (!existsSync(DEEP)) { console.error('strategy-trials: no data/deep'); process.exit(1); }
const sets = [];
for (const f of readdirSync(DEEP).filter(x => x.endsWith('.json'))) {
  const b = JSON.parse(readFileSync(`${DEEP}/${f}`, 'utf8'))
    .filter(x => x && [x.o, x.h, x.l, x.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
  if (b.length < 900) continue;
  const c = b.map(x => x.c);
  sets.push({ pair: f.replace('.json', '').replace('-', '/'), b, c,
              atr: atrSeries(b), rsi: rsi(c), ma20: sma(c, 20), ma50: sma(c, 50), ma200: sma(c, 200) });
}
const totalBars = sets.reduce((s, d) => s + d.b.length, 0);
console.log(`strategy-trials: ${sets.length} instruments, ${totalBars.toLocaleString()} daily bars`);
console.log(`  split: train 0-50%, validate 50-75%, SEALED 75-100% (opened once, for survivors only)\n`);

/* ── 1. TRAIN ───────────────────────────────────────────────────────────── */
const combos = [];
for (const [en, ef] of Object.entries(ENTRIES))
  for (const [fn, ff] of Object.entries(FILTERS))
    combos.push({ name: `${en} × ${fn}`, entry: en, filter: fn, ef, ff });

const HYPOTHESES = combos.length;
// Bonferroni: testing this many and keeping the best is not one test.
const BAR_T = Math.abs(normInv(1 - 0.05 / (2 * HYPOTHESES)));
function normInv(p) { // Acklam approximation, good to ~1e-9
  const a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.3577518672690,-30.66479806614716,2.506628277459239];
  const b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
  const c=[-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
  const d=[0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
  const pl=0.02425;
  if (p<pl){const q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if (p<=1-pl){const q=p-0.5,r=q*q;return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
  const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

console.log(`  ${HYPOTHESES} combinations tested -> Bonferroni bar |t| > ${BAR_T.toFixed(2)}\n`);

const trained = [];
for (const c of combos) {
  const rs = backtest(sets, c.ef, c.ff, 0, 0.5);
  if (rs.length < MIN_TRADES) continue;
  trained.push({ ...c, train: { n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2) } });
}
trained.sort((a, b) => b.train.t - a.train.t);
console.log('  TRAIN — top 8 of ' + trained.length + ' testable:');
for (const c of trained.slice(0, 8))
  console.log(`    ${c.name.padEnd(30)} ${String(c.train.n).padStart(5)} trades  ${(c.train.avgR >= 0 ? '+' : '') + c.train.avgR.toFixed(4)}R  t=${c.train.t}`);

/* ── 2. VALIDATE — survivors must repeat ────────────────────────────────── */
const survivors = [];
for (const c of trained) {
  if (!(c.train.t > 1.5 && c.train.avgR > 0)) continue;       // only promising ones cost a validation
  const rs = backtest(sets, c.ef, c.ff, 0.5, 0.75);
  if (rs.length < MIN_TRADES / 2) continue;
  const v = { n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2) };
  if (v.avgR > 0 && v.t > 1.0) survivors.push({ ...c, validate: v });
}
console.log(`\n  VALIDATE — ${survivors.length} of ${trained.filter(c => c.train.t > 1.5 && c.train.avgR > 0).length} promising combos repeated:`);
for (const c of survivors)
  console.log(`    ${c.name.padEnd(30)} ${String(c.validate.n).padStart(5)} trades  ${(c.validate.avgR >= 0 ? '+' : '') + c.validate.avgR.toFixed(4)}R  t=${c.validate.t}`);
if (!survivors.length) console.log('    (none)');

/* ── 3. SEALED — opened once ────────────────────────────────────────────── */
const sealed = [];
for (const c of survivors) {
  const rs = backtest(sets, c.ef, c.ff, 0.75, 1.0);
  if (rs.length < MIN_TRADES / 2) { sealed.push({ ...c, sealed: { n: rs.length, tooFew: true } }); continue; }
  const nul = randomNull(sets, 0.75, 1.0, rs.length, 150);
  const s = { n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2),
              nullP95: +nul.p95.toFixed(4), beatsNull: mean(rs) > nul.p95,
              clearsBar: Math.abs(tstat(rs)) > BAR_T && mean(rs) > 0 };
  s.passes = s.clearsBar && s.beatsNull;
  sealed.push({ ...c, sealed: s });
}
console.log(`\n  SEALED (newest 25%, opened once) — bar |t| > ${BAR_T.toFixed(2)} AND beat the random-entry 95th percentile:`);
for (const c of sealed) {
  const s = c.sealed;
  if (s.tooFew) { console.log(`    ${c.name.padEnd(30)} only ${s.n} trades — too few to judge`); continue; }
  console.log(`    ${c.name.padEnd(30)} ${String(s.n).padStart(5)} trades  ${(s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(4)}R  t=${s.t}  null95=${s.nullP95}  ${s.passes ? 'PASSES' : 'fails'}`);
}
if (!sealed.length) console.log('    (nothing reached the sealed set)');

const passed = sealed.filter(c => c.sealed.passes);

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/strategy-trials.mjs',
  instruments: sets.length, totalDailyBars: totalBars,
  hypotheses: HYPOTHESES, bonferroniBarT: +BAR_T.toFixed(2),
  method: 'daily bars, entry at next open, v442 managed ladder, costs charged, NON-OVERLAPPING trades, '
        + 'three-way split with the newest 25% opened once, random-entry null at matched trade count',
  trainTop: trained.slice(0, 10).map(c => ({ name: c.name, ...c.train })),
  survivors: survivors.map(c => ({ name: c.name, train: c.train, validate: c.validate })),
  sealed: sealed.map(c => ({ name: c.name, entry: c.entry, filter: c.filter, train: c.train, validate: c.validate, sealed: c.sealed })),
  passed: passed.map(c => ({ name: c.name, entry: c.entry, filter: c.filter, sealed: c.sealed })),
  verdict: passed.length
    ? `${passed.length} combination(s) cleared the sealed test at a bar corrected for ${HYPOTHESES} hypotheses and beat a random-entry null.`
    : `Nothing cleared. ${trained.length} combinations tested, ${survivors.length} repeated on validation, `
      + `${sealed.length} reached the sealed set, 0 passed it. On this evidence no combination here earns a place in the signal path.`,
};
writeFileSync('data/strategy-trials.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
console.log(`\n  wrote data/strategy-trials.json`);
