#!/usr/bin/env node
/**
 * market-voice.mjs — "what the market is talking about", derived from measured price
 * action across every instrument we hold deep history for, plus the economic calendar.
 *
 * Two jobs, kept strictly apart:
 *
 *   1. DESCRIBE  — what the market is actually doing right now. This is arithmetic on
 *                  real bars. It is always honest and always shown.
 *   2. VALIDATE  — does each description predict anything? Every read is regressed
 *                  against forward 5-day returns across the whole history. A read is
 *                  only ever labelled predictive if it clears a width-corrected bar.
 *
 * The point of the split: the old base kept sliding descriptive colour into the
 * decision path. Here a read cannot influence a signal unless VALIDATE promoted it,
 * and VALIDATE publishes its t-stats so the claim can be checked.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';

const DEEP = 'data/deep';
const USD_LEGS = { 'EUR-USD': 1, 'GBP-USD': 1, 'AUD-USD': 1, 'NZD-USD': 1, 'USD-JPY': -1, 'USD-CHF': -1, 'USD-CAD': -1 };
const RISK_ON  = ['AUD-USD', 'NZD-USD', 'BTC-USD', 'ETH-USD'];
const HAVEN    = ['USD-CHF', 'USD-JPY', 'XAU-USD'];
const FWD = 5;           // forward horizon for validation, in daily bars
const MIN_OBS = 400;     // refuse to make a predictive claim on less

const load = (f) => { try { return JSON.parse(readFileSync(`${DEEP}/${f}`, 'utf8')); } catch (_) { return null; } };
const closes = (bars) => bars.map(b => b.c).filter(c => typeof c === 'number' && isFinite(c) && c > 0);

// ---------- small stats ----------
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function pct(arr, v) { const s = [...arr].sort((a, b) => a - b); let lo = 0; for (const x of s) { if (x < v) lo++; } return s.length ? lo / s.length : 0.5; }

/**
 * Correlation of x against forward return, with the t-stat corrected for the fact
 * that overlapping FWD-day windows are not independent observations. Dividing the
 * effective sample by the window width is the same correction the episode work
 * settled on; without it every one of these reads looks significant.
 */
function predictive(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < MIN_OBS) return { n, r: null, t: null, enough: false };
  const xs = x.slice(0, n), ys = y.slice(0, n);
  const mx = mean(xs), my = mean(ys), sx = sd(xs), sy = sd(ys);
  if (!sx || !sy) return { n, r: 0, t: 0, enough: true };
  let cov = 0; for (let i = 0; i < n; i++) cov += (xs[i] - mx) * (ys[i] - my);
  const r = (cov / (n - 1)) / (sx * sy);
  const nEff = n / FWD;                                     // overlap correction
  const t = r * Math.sqrt(Math.max(nEff - 2, 1) / Math.max(1e-9, 1 - r * r));
  return { n, nEff: Math.round(nEff), r: +r.toFixed(4), t: +t.toFixed(2), enough: true };
}

// ---------- per-instrument series ----------
const files = existsSync(DEEP) ? readdirSync(DEEP).filter(f => f.endsWith('.json')) : [];
if (!files.length) { console.error('market-voice: no deep caches in data/deep — run fetch-deep-history.mjs first'); process.exit(1); }

const inst = {};
for (const f of files) {
  const bars = load(f); if (!Array.isArray(bars) || bars.length < 300) continue;
  const key = f.replace('.json', '');
  const c = closes(bars);
  const ret = c.map((v, i) => i ? Math.log(v / c[i - 1]) : 0).slice(1);
  // true range as a share of price, so instruments are comparable
  const tr = bars.slice(1).map((b, i) => {
    const p = bars[i]; const hi = b.h ?? b.c, lo = b.l ?? b.c, pc = p.c;
    if (![hi, lo, pc].every(x => typeof x === 'number' && isFinite(x))) return null;
    return Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)) / pc;
  }).filter(x => x !== null);
  inst[key] = { bars, closes: c, ret, tr, lastT: bars[bars.length - 1]?.t || 0 };
}
const keys = Object.keys(inst);
if (!keys.length) { console.error('market-voice: caches present but all too short'); process.exit(1); }

// ---------- 1. DESCRIBE: the reads ----------
const W = 20;   // ~one trading month
const Y = 252;  // trailing year for percentiles

/** Dollar read: sign-corrected average 20-day move across every USD leg we hold. */
function dollarSeries() {
  const legs = Object.keys(USD_LEGS).filter(k => inst[k]);
  if (!legs.length) return [];
  const len = Math.min(...legs.map(k => inst[k].closes.length));
  const out = [];
  for (let i = W; i < len; i++) {
    let s = 0, m = 0;
    for (const k of legs) {
      const c = inst[k].closes, off = c.length - len;  // right-align the shorter series
      const a = c[off + i - W], b = c[off + i];
      if (a > 0 && b > 0) { s += USD_LEGS[k] * Math.log(b / a); m++; }
    }
    out.push(m ? -s / m : 0);   // positive = dollar strength
  }
  return out;
}

/** Risk appetite: risk-on basket 20-day move minus haven basket 20-day move. */
function riskSeries() {
  const on = RISK_ON.filter(k => inst[k]), hv = HAVEN.filter(k => inst[k]);
  if (!on.length || !hv.length) return [];
  const len = Math.min(...[...on, ...hv].map(k => inst[k].closes.length));
  const basket = (ks, i) => {
    let s = 0, m = 0;
    for (const k of ks) {
      const c = inst[k].closes, off = c.length - len;
      const a = c[off + i - W], b = c[off + i];
      if (a > 0 && b > 0) { s += Math.log(b / a); m++; }
    }
    return m ? s / m : 0;
  };
  const out = [];
  for (let i = W; i < len; i++) out.push(basket(on, i) - basket(hv, i));
  return out;
}

/** Breadth: share of instruments whose 20-day move is up. One number for "is this one story". */
function breadthSeries() {
  const len = Math.min(...keys.map(k => inst[k].closes.length));
  const out = [];
  for (let i = W; i < len; i++) {
    let up = 0, m = 0;
    for (const k of keys) {
      const c = inst[k].closes, off = c.length - len;
      const a = c[off + i - W], b = c[off + i];
      if (a > 0 && b > 0) { up += (b > a ? 1 : 0); m++; }
    }
    out.push(m ? up / m : 0.5);
  }
  return out;
}

const dollar = dollarSeries(), risk = riskSeries(), breadth = breadthSeries();

// ---------- 2. VALIDATE: does any read forecast the next week? ----------
/** Forward FWD-day return of an equal-weight basket of everything, right-aligned to `series`. */
function forwardBasket(seriesLen) {
  const len = Math.min(...keys.map(k => inst[k].closes.length));
  const fwd = [];
  for (let i = W; i < len - FWD; i++) {
    let s = 0, m = 0;
    for (const k of keys) {
      const c = inst[k].closes, off = c.length - len;
      const a = c[off + i], b = c[off + i + FWD];
      if (a > 0 && b > 0) { s += Math.log(b / a); m++; }
    }
    fwd.push(m ? s / m : 0);
  }
  // align: series may be longer than fwd by FWD
  return fwd.slice(Math.max(0, fwd.length - (seriesLen - FWD)));
}

const validation = {};
for (const [name, series] of Object.entries({ dollar, risk, breadth })) {
  if (!series.length) { validation[name] = { enough: false, n: 0 }; continue; }
  const fwd = forwardBasket(series.length);
  const x = series.slice(0, fwd.length);
  const v = predictive(x, fwd);
  // Bar: |t| > 2.45, the same width-corrected bar the entry-prediction work used.
  v.predictive = !!(v.enough && v.t !== null && Math.abs(v.t) > 2.45);
  v.bar = 2.45;
  validation[name] = v;
}

// ---------- current state, in words ----------
const last = (a) => a.length ? a[a.length - 1] : null;
const tail = (a, n) => a.slice(-n);

function band(series, v, labels) {
  if (v === null || !series.length) return labels[1];
  const p = pct(tail(series, Y * 4), v);
  return p > 0.75 ? labels[2] : p < 0.25 ? labels[0] : labels[1];
}

const dNow = last(dollar), rNow = last(risk), bNow = last(breadth);
const dollarState  = band(dollar,  dNow, ['dollar being sold', 'dollar going nowhere', 'dollar being bought']);
const riskState    = band(risk,    rNow, ['money moving to safety', 'no clear risk preference', 'money moving to risk']);
const breadthState = bNow === null ? 'unknown'
  : bNow > 0.7 ? 'nearly everything moving together'
  : bNow < 0.3 ? 'nearly everything moving down together'
  : 'markets moving on their own stories';

// volatility: where is each instrument's 20-day average range inside its trailing year
const vol = {};
for (const k of keys) {
  const tr = inst[k].tr; if (tr.length < Y + W) continue;
  const now = mean(tail(tr, W));
  const hist = [];
  for (let i = tr.length - Y; i < tr.length - W; i++) hist.push(mean(tr.slice(i, i + W)));
  vol[k] = { atrPctOfPrice: +(now * 100).toFixed(3), yearPercentile: Math.round(pct(hist, now) * 100) };
}
const loud = Object.entries(vol).sort((a, b) => b[1].yearPercentile - a[1].yearPercentile).slice(0, 3)
  .map(([k, v]) => ({ instrument: k.replace('-', '/'), yearPercentile: v.yearPercentile }));
const quiet = Object.entries(vol).sort((a, b) => a[1].yearPercentile - b[1].yearPercentile).slice(0, 3)
  .map(([k, v]) => ({ instrument: k.replace('-', '/'), yearPercentile: v.yearPercentile }));

// stretch: how far each instrument sits inside its own trailing-year range
const stretch = {};
for (const k of keys) {
  const c = inst[k].closes; if (c.length < Y) continue;
  const win = tail(c, Y), lo = Math.min(...win), hi = Math.max(...win), now = last(c);
  stretch[k] = { position: hi > lo ? Math.round(((now - lo) / (hi - lo)) * 100) : 50, last: now };
}

// ---------- calendar: what is actually scheduled ----------
let calendar = [];
try {
  const cal = JSON.parse(readFileSync('data/calendar-cache.json', 'utf8'));
  const now = Date.now();
  calendar = (cal.events || [])
    .filter(e => e.at && e.at > now - 36e5)
    .sort((a, b) => a.at - b.at).slice(0, 8)
    .map(e => ({
      title: e.title, country: e.country, at: e.at,
      hoursAway: +(((e.at - now) / 36e5)).toFixed(1),
      forecast: e.forecast ?? null, previous: e.previous ?? null
    }));
} catch (_) {}

// ---------- the narrative, assembled from measured parts only ----------
const freshestBar = Math.max(...keys.map(k => inst[k].lastT));
const barAgeDays = +(((Date.now() - freshestBar) / 864e5)).toFixed(1);

const headline = `${dollarState.charAt(0).toUpperCase()}${dollarState.slice(1)}, ${riskState}, ${breadthState}.`;
const anyPredictive = Object.entries(validation).filter(([, v]) => v.predictive).map(([k]) => k);

const out = {
  ts: Date.now(),
  isoTime: new Date().toISOString(),
  builtBy: 'tools/market-voice.mjs',
  dataThrough: new Date(freshestBar).toISOString().slice(0, 10),
  barAgeDays,
  instruments: keys.length,
  totalDailyBars: keys.reduce((s, k) => s + inst[k].closes.length, 0),

  headline,
  reads: {
    dollar:  { state: dollarState,  value: dNow === null ? null : +(dNow * 100).toFixed(2), unit: '% 20-day, sign-corrected across USD legs' },
    risk:    { state: riskState,    value: rNow === null ? null : +(rNow * 100).toFixed(2), unit: '% risk-on basket minus haven basket, 20-day' },
    breadth: { state: breadthState, value: bNow === null ? null : Math.round(bNow * 100),   unit: '% of instruments up over 20 days' }
  },

  volatility: { loudest: loud, quietest: quiet, all: vol },
  stretch,
  calendar,

  validation,
  predictiveReads: anyPredictive,
  honesty: anyPredictive.length
    ? `${anyPredictive.join(', ')} cleared the width-corrected bar (|t| > 2.45) against forward ${FWD}-day returns. Every other read below is description only.`
    : `None of these reads forecast the next ${FWD} days at the width-corrected bar (|t| > 2.45). They describe what is happening; they do not predict what happens next, and nothing here feeds a signal.`,
  method: `Reads computed on ${keys.length} instruments, daily bars. Each read regressed against forward ${FWD}-day equal-weight basket returns; t-stats divided by the ${FWD}-bar window overlap because consecutive windows are not independent observations.`
};

writeFileSync('data/market-voice.json', JSON.stringify(out, null, 2));

console.log(`market-voice: ${keys.length} instruments, ${out.totalDailyBars.toLocaleString()} daily bars, through ${out.dataThrough} (${barAgeDays}d old)`);
console.log(`  ${headline}`);
console.log(`  dollar ${out.reads.dollar.value}%  risk ${out.reads.risk.value}%  breadth ${out.reads.breadth.value}%`);
console.log('  validation (does the read forecast the next week?):');
for (const [k, v] of Object.entries(validation)) {
  if (!v.enough) { console.log(`    ${k.padEnd(9)} not enough data (n=${v.n})`); continue; }
  console.log(`    ${k.padEnd(9)} r=${String(v.r).padStart(7)}  t=${String(v.t).padStart(6)}  n=${v.n} (${v.nEff} independent)  ${v.predictive ? 'PREDICTIVE' : 'description only'}`);
}
console.log(`  loudest: ${loud.map(l => `${l.instrument} ${l.yearPercentile}th`).join(', ')}`);
console.log(`  calendar ahead: ${calendar.length} events`);
