#!/usr/bin/env node
/**
 * verify-chart-reading.mjs — does the engine read the chart correctly?
 *
 * This is a CONTROL, not a test of the strategy. It recomputes every indicator
 * the engine publishes, from the same bars the engine published, using an
 * implementation written independently here. If the two disagree, the engine is
 * misreading the chart — which has happened before: the regime detector indexed
 * an ADX *object* as if it were an array, got undefined, fell through a `|| 0`,
 * and reported ADX 0 forever. TRENDING was unreachable for the life of that bug
 * and nothing failed loudly.
 *
 * Agreement here does not mean the signals are good. It means the arithmetic
 * describing the chart is the arithmetic it claims to be.
 */
const MIRROR = 'https://raw.githubusercontent.com/Jboy-dev/forexsight/main/data';

const sma = (v, p) => { const o = Array(v.length).fill(null); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; };

function ema(v, p) {
  const o = Array(v.length).fill(null), k = 2 / (p + 1);
  let acc = 0;
  for (let i = 0; i < v.length; i++) {
    if (i < p) { acc += v[i]; if (i === p - 1) o[i] = acc / p; continue; }
    o[i] = v[i] * k + o[i - 1] * (1 - k);
  }
  return o;
}

// Wilder's ATR: the smoothing is (prev*(n-1) + tr)/n, NOT a simple mean.
function atrWilder(b, p = 14) {
  const out = Array(b.length).fill(null); let seed = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
    if (i <= p) { seed += tr; if (i === p) out[i] = seed / p; }
    else out[i] = (out[i-1] * (p - 1) + tr) / p;
  }
  return out;
}

function rsiWilder(c, p = 14) {
  const o = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= p && i < c.length; i++) { const d = c[i] - c[i-1]; d >= 0 ? g += d : l -= d; }
  g /= p; l /= p;
  if (c.length > p) o[p] = 100 - 100 / (1 + g / (l || 1e-12));
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i-1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = 100 - 100 / (1 + g / (l || 1e-12));
  }
  return o;
}

// Wilder's ADX, written out fully so a mistake here is visible rather than hidden
// behind a helper that might have the same bug as the engine's.
function adxWilder(b, p = 14) {
  const n = b.length;
  const tr = Array(n).fill(0), pDM = Array(n).fill(0), mDM = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = b[i].h - b[i-1].h, dn = b[i-1].l - b[i].l;
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= p; i++) { trS += tr[i]; pS += pDM[i]; mS += mDM[i]; }
  const dx = Array(n).fill(null);
  for (let i = p; i < n; i++) {
    if (i > p) {
      trS = trS - trS / p + tr[i];
      pS  = pS  - pS  / p + pDM[i];
      mS  = mS  - mS  / p + mDM[i];
    }
    const pDI = trS ? 100 * pS / trS : 0, mDI = trS ? 100 * mS / trS : 0;
    const sum = pDI + mDI;
    dx[i] = sum ? 100 * Math.abs(pDI - mDI) / sum : 0;
  }
  const adx = Array(n).fill(null);
  let first = 0, cnt = 0;
  for (let i = p; i < n; i++) {
    if (dx[i] == null) continue;
    if (cnt < p) { first += dx[i]; cnt++; if (cnt === p) adx[i] = first / p; }
    else adx[i] = (adx[i-1] * (p - 1) + dx[i]) / p;
  }
  return adx;
}

const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / Math.abs(b) * 100);

const feed = await get(`${MIRROR}/latest-signals.json`);
const sigs = feed.signals || [];
console.log(`checking ${sigs.length} live signals against independently recomputed indicators\n`);

let bad = 0, checked = 0;
const rows = [];

for (const s of sigs) {
  const file = String(s.pair).replace('/', '-');
  let data;
  try { data = await get(`${MIRROR}/ohlc/${file}.json`); }
  catch { rows.push({ pair: s.pair, note: 'no published bars to check against' }); continue; }
  const b = (data.ohlc || []).filter(x => x && [x.o, x.h, x.l, x.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
  if (b.length < 250) { rows.push({ pair: s.pair, note: `only ${b.length} bars` }); continue; }

  const c = b.map(x => x.c), i = b.length - 1;
  const mine = {
    atr: atrWilder(b)[i],
    adx: adxWilder(b)[i],
    rsi: rsiWilder(c)[i],
    ema20: ema(c, 20)[i], ema50: ema(c, 50)[i], ema200: ema(c, 200)[i],
    close: c[i],
  };
  const theirs = { atr: s.atrV, adx: s.adx != null ? s.adx : (s.regime && s.regime.adx) };

  // ── bar integrity, which no indicator can survive being wrong about ──
  const faults = [];
  for (let k = 1; k < b.length; k++) {
    if (b[k].t <= b[k-1].t) { faults.push(`bars out of order or duplicated at ${k}`); break; }
  }
  for (let k = 0; k < b.length; k++) {
    const x = b[k];
    if (x.h < x.l || x.h < x.o || x.h < x.c || x.l > x.o || x.l > x.c) { faults.push(`impossible OHLC at bar ${k}`); break; }
  }

  const dAtr = theirs.atr != null ? pct(mine.atr, theirs.atr) : null;
  // ADX is published rounded to a whole number, so compare in absolute points.
  const dAdx = theirs.adx != null ? Math.abs(mine.adx - theirs.adx) : null;

  const atrOk = dAtr == null || dAtr < 5;        // 5% — different seeding, same method
  const adxOk = dAdx == null || dAdx < 2;        // 2 points of a 0-100 scale
  if (!atrOk || !adxOk || faults.length) bad++;
  checked++;

  rows.push({
    pair: s.pair, faults,
    atrEngine: theirs.atr, atrMine: mine.atr != null ? +mine.atr.toPrecision(6) : null, atrDiffPct: dAtr != null ? +dAtr.toFixed(2) : null, atrOk,
    adxEngine: theirs.adx, adxMine: mine.adx != null ? +mine.adx.toFixed(1) : null, adxDiff: dAdx != null ? +dAdx.toFixed(1) : null, adxOk,
    rsiMine: mine.rsi != null ? +mine.rsi.toFixed(1) : null,
    trendMine: (mine.ema50 != null && mine.ema200 != null) ? (mine.ema50 > mine.ema200 ? 'up' : 'down') : null,
    direction: s.direction,
    regimeEngine: s.regime && s.regime.label,
  });
}

console.log('  pair        ATR engine / mine        diff    ADX engine / mine   diff   regime     dir   EMA50vs200');
for (const r of rows) {
  if (r.note) { console.log(`  ${r.pair.padEnd(10)} ${r.note}`); continue; }
  console.log(`  ${r.pair.padEnd(10)} ${String(r.atrEngine).padStart(9)} / ${String(r.atrMine).padStart(9)} `
    + `${(r.atrDiffPct + '%').padStart(7)}${r.atrOk ? ' ' : '!'}  ${String(r.adxEngine).padStart(5)} / ${String(r.adxMine).padStart(5)} `
    + `${String(r.adxDiff).padStart(5)}${r.adxOk ? ' ' : '!'}  ${String(r.regimeEngine).padEnd(9)} ${String(r.direction).padEnd(5)} ${String(r.trendMine)}`
    + (r.faults.length ? `  <-- ${r.faults.join('; ')}` : ''));
}

console.log(`\n  ${checked - bad} of ${checked} signals agree with an independent reading of the same bars.`);
if (bad) console.log(`  ${bad} DISAGREE — the engine is not reading the chart the way it says it is.`);

// Does the published regime label follow from the published ADX?
console.log('\n  regime label against its own ADX:');
for (const r of rows.filter(x => !x.note && x.adxEngine != null)) {
  const a = r.adxEngine;
  const expect = a >= 25 ? 'trending-ish' : a < 20 ? 'ranging/mixed-ish' : 'borderline';
  const label = String(r.regimeEngine || '').toLowerCase();
  const odd = (a >= 25 && /rang|mixed/.test(label)) || (a < 18 && /trend/.test(label));
  console.log(`    ${r.pair.padEnd(10)} ADX ${String(a).padStart(4)} -> ${String(r.regimeEngine).padEnd(9)} ${odd ? '<-- label does not follow from the ADX' : '(' + expect + ')'}`);
}
process.exit(bad ? 1 : 0);
