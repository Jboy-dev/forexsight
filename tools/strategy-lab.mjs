// v486 — TESTING REAL, PUBLISHED STRATEGIES ON TWO YEARS OF REAL BARS.
//
// The engine's own strategy set measures reliably negative: -0.241R in a
// walk-forward backtest and -0.29R on the live tracked record, both intervals
// excluding zero. Rather than keep tuning a losing set, this tests a spread of
// well-known strategies — the kind published in trading literature and used
// openly — under identical conditions, on 12,000-17,000 hourly bars per
// instrument covering two years.
//
// Every strategy gets exactly the same treatment so the comparison is fair:
// the same ATR-based stop, the same v442 managed ladder, the same holding
// limit, the same costs. What differs is only the entry rule.
//
// The methodology matters more than the results, because with a dozen
// strategies and ten instruments it is trivially easy to find something that
// looks brilliant and is noise:
//
//   NO LOOKAHEAD      decisions use bars[0..i], outcomes use bars[i+1..]
//   TRAIN/TEST SPLIT  rules are examined on the first 65% of history; the
//                     final 35% is held back and scored once
//   EPISODES          overlapping same-direction entries collapse into one
//   COSTS CHARGED     spread is deducted from entry, every trade
//   MULTIPLE TESTING  with N strategies tested, one clearing a 95% interval by
//                     chance is expected; the out-of-sample column is what
//                     counts, not the best in-sample number
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const MAX_HOLD = 48;
const ATR_STOP = 1.75;
const LADDER = [1.2, 2.0, 3.5];
const W = [1 / 3, 1 / 3, 1 / 3];
const SPLIT = 0.65;
const SPREAD_PIPS = { 'EUR/USD': 0.8, 'GBP/USD': 1.2, 'AUD/USD': 1.0, 'NZD/USD': 1.5,
  'USD/CAD': 1.5, 'USD/CHF': 1.4, 'USD/JPY': 0.9, 'XAU/USD': 25, 'BTC/USD': 20, 'ETH/USD': 15 };
const PIP = (p) => p === 'XAU/USD' ? 0.1 : p.includes('JPY') ? 0.01 : p === 'BTC/USD' ? 1 : p === 'ETH/USD' ? 0.1 : 0.0001;

// ── indicators, computed once per instrument ──────────────────────────────
function ema(a, p) { const k = 2 / (p + 1); let e = [], pr = null; for (let i = 0; i < a.length; i++) { pr = pr == null ? a[i] : a[i] * k + pr * (1 - k); e[i] = i < p - 1 ? null : pr; } return e; }
function sma(a, p) { const o = []; let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; o[i] = i >= p - 1 ? s / p : null; } return o; }
function rsi(c, p = 14) {
  const o = []; let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (i <= p) { g += Math.max(d, 0); l += Math.max(-d, 0); o[i] = null; if (i === p) { g /= p; l /= p; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
    else { g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return o;
}
function atr(b, p = 14) {
  const o = []; let s = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if (i <= p) { s += tr; o[i] = i === p ? s / p : null; }
    else { o[i] = (o[i - 1] * (p - 1) + tr) / p; }
  }
  return o;
}
function stdev(a, p) { const o = []; for (let i = p - 1; i < a.length; i++) { const w = a.slice(i - p + 1, i + 1); const m = w.reduce((x, y) => x + y, 0) / p; o[i] = Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / p); } return o; }

function indicators(bars) {
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l);
  return { c, h, l,
    ema20: ema(c, 20), ema50: ema(c, 50), ema200: ema(c, 200),
    sma20: sma(c, 20), sd20: stdev(c, 20),
    rsi14: rsi(c, 14), atr14: atr(bars, 14),
    ema12: ema(c, 12), ema26: ema(c, 26) };
}

// ── the strategies. Each returns 'BUY' | 'SELL' | null for bar i ──────────
// All are standard, published rules — no parameter searching, values are the
// conventional textbook defaults so that a good result cannot be an artefact
// of tuning on this data.
const STRATEGIES = {
  'EMA cross 20/50': (b, i, x) => {
    if (!x.ema20[i] || !x.ema50[i] || !x.ema20[i - 1] || !x.ema50[i - 1]) return null;
    const up = x.ema20[i] > x.ema50[i], upPrev = x.ema20[i - 1] > x.ema50[i - 1];
    return up && !upPrev ? 'BUY' : (!up && upPrev ? 'SELL' : null);
  },
  'Golden cross 50/200': (b, i, x) => {
    if (!x.ema50[i] || !x.ema200[i] || !x.ema50[i - 1] || !x.ema200[i - 1]) return null;
    const up = x.ema50[i] > x.ema200[i], upPrev = x.ema50[i - 1] > x.ema200[i - 1];
    return up && !upPrev ? 'BUY' : (!up && upPrev ? 'SELL' : null);
  },
  'MACD cross': (b, i, x) => {
    if (!x.ema12[i] || !x.ema26[i] || !x.ema12[i - 1] || !x.ema26[i - 1]) return null;
    const m = x.ema12[i] - x.ema26[i], mp = x.ema12[i - 1] - x.ema26[i - 1];
    return m > 0 && mp <= 0 ? 'BUY' : (m < 0 && mp >= 0 ? 'SELL' : null);
  },
  'RSI mean reversion': (b, i, x) => {
    if (x.rsi14[i] == null || x.rsi14[i - 1] == null) return null;
    if (x.rsi14[i - 1] < 30 && x.rsi14[i] >= 30) return 'BUY';
    if (x.rsi14[i - 1] > 70 && x.rsi14[i] <= 70) return 'SELL';
    return null;
  },
  'RSI trend filter': (b, i, x) => {
    if (x.rsi14[i] == null || !x.ema200[i]) return null;
    const upTrend = x.c[i] > x.ema200[i];
    if (upTrend && x.rsi14[i - 1] < 40 && x.rsi14[i] >= 40) return 'BUY';
    if (!upTrend && x.rsi14[i - 1] > 60 && x.rsi14[i] <= 60) return 'SELL';
    return null;
  },
  'Bollinger reversion': (b, i, x) => {
    if (!x.sma20[i] || !x.sd20[i]) return null;
    const up = x.sma20[i] + 2 * x.sd20[i], dn = x.sma20[i] - 2 * x.sd20[i];
    if (x.c[i - 1] < dn && x.c[i] >= dn) return 'BUY';
    if (x.c[i - 1] > up && x.c[i] <= up) return 'SELL';
    return null;
  },
  'Bollinger breakout': (b, i, x) => {
    if (!x.sma20[i] || !x.sd20[i]) return null;
    const up = x.sma20[i] + 2 * x.sd20[i], dn = x.sma20[i] - 2 * x.sd20[i];
    if (x.c[i - 1] <= up && x.c[i] > up) return 'BUY';
    if (x.c[i - 1] >= dn && x.c[i] < dn) return 'SELL';
    return null;
  },
  'Donchian 20 breakout': (b, i, x) => {
    if (i < 21) return null;
    let hh = -Infinity, ll = Infinity;
    for (let k = i - 20; k < i; k++) { hh = Math.max(hh, b[k].h); ll = Math.min(ll, b[k].l); }
    if (b[i].c > hh) return 'BUY';
    if (b[i].c < ll) return 'SELL';
    return null;
  },
  'Donchian 55 breakout': (b, i, x) => {
    if (i < 56) return null;
    let hh = -Infinity, ll = Infinity;
    for (let k = i - 55; k < i; k++) { hh = Math.max(hh, b[k].h); ll = Math.min(ll, b[k].l); }
    if (b[i].c > hh) return 'BUY';
    if (b[i].c < ll) return 'SELL';
    return null;
  },
  'Trend pullback to EMA20': (b, i, x) => {
    if (!x.ema20[i] || !x.ema50[i] || !x.ema200[i]) return null;
    const up = x.ema50[i] > x.ema200[i], dn = x.ema50[i] < x.ema200[i];
    if (up && x.l[i] <= x.ema20[i] && x.c[i] > x.ema20[i]) return 'BUY';
    if (dn && x.h[i] >= x.ema20[i] && x.c[i] < x.ema20[i]) return 'SELL';
    return null;
  },
  'Inside bar breakout': (b, i, x) => {
    if (i < 3) return null;
    const m = b[i - 1], p = b[i - 2];
    const inside = m.h <= p.h && m.l >= p.l;
    if (!inside) return null;
    if (b[i].c > m.h) return 'BUY';
    if (b[i].c < m.l) return 'SELL';
    return null;
  },
  'Three-bar reversal': (b, i, x) => {
    if (i < 4) return null;
    const d = (k) => b[k].c > b[k].o;
    if (!d(i - 3) && !d(i - 2) && d(i - 1) && d(i)) return 'BUY';
    if (d(i - 3) && d(i - 2) && !d(i - 1) && !d(i)) return 'SELL';
    return null;
  },
};

// ── one common simulator, identical for every strategy ────────────────────
function outcome(bars, i, dir, atrV, pair) {
  const spread = (SPREAD_PIPS[pair] ?? 1.5) * PIP(pair);
  const buy = dir === 'BUY';
  // Enter at the next bar's open, paying the spread. Never at this bar's close,
  // which would be a decision made with the bar's own outcome already known.
  const nxt = bars[i + 1];
  if (!nxt) return null;
  const entry = buy ? nxt.o + spread / 2 : nxt.o - spread / 2;
  const slD = atrV * ATR_STOP;
  if (!(slD > 0)) return null;
  const stopInit = buy ? entry - slD : entry + slD;
  const tps = LADDER.map(m => buy ? entry + slD * m : entry - slD * m);
  let stop = stopInit, reached = 0, banked = 0;
  for (let k = i + 1; k < Math.min(bars.length, i + 1 + MAX_HOLD); k++) {
    const b = bars[k];
    if (buy ? b.l <= stop : b.h >= stop) {
      const rem = 1 - W.slice(0, reached).reduce((a, c) => a + c, 0);
      const exitR = reached === 0 ? -1 : (reached === 1 ? 0 : LADDER[0]);
      return { r: banked + rem * exitR, at: bars[i].t, reached };
    }
    while (reached < 3 && (buy ? b.h >= tps[reached] : b.l <= tps[reached])) {
      banked += W[reached] * LADDER[reached];
      reached++;
      if (reached === 1) stop = entry; else if (reached === 2) stop = tps[0];
    }
    if (reached === 3) return { r: banked, at: bars[i].t, reached };
  }
  const last = bars[Math.min(bars.length, i + 1 + MAX_HOLD) - 1];
  const rem = 1 - W.slice(0, reached).reduce((a, c) => a + c, 0);
  const openR = (buy ? last.c - entry : entry - last.c) / slD;
  return { r: banked + rem * openR, at: bars[i].t, reached };
}

function episodes(trades) {
  trades.sort((a, b) => a.at - b.at);
  const eps = [];
  for (const t of trades) {
    const open = eps.find(e => e.pair === t.pair && e.dir === t.dir && (t.at - e.lastAt) / 3600000 <= MAX_HOLD);
    if (open) { open.rs.push(t.r); open.lastAt = t.at; }
    else eps.push({ pair: t.pair, dir: t.dir, lastAt: t.at, rs: [t.r] });
  }
  return eps.map(e => e.rs.reduce((a, b) => a + b, 0) / e.rs.length);
}

const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
function ci(v, n = 3000) {
  if (v.length < 10) return null;
  const s = [];
  for (let i = 0; i < n; i++) { let t = 0; for (let j = 0; j < v.length; j++) t += v[Math.floor(Math.random() * v.length)]; s.push(t / v.length); }
  s.sort((a, b) => a - b);
  return [+s[Math.floor(0.025 * n)].toFixed(3), +s[Math.floor(0.975 * n)].toFixed(3)];
}

// ── run ───────────────────────────────────────────────────────────────────
const data = {};
for (const f of readdirSync('data/bt').filter(x => x.endsWith('.json'))) {
  const pair = f.replace('.json', '').replace('-', '/');
  const bars = JSON.parse(readFileSync(`data/bt/${f}`, 'utf8'));
  if (bars.length > 300) data[pair] = { bars, ind: indicators(bars) };
}

const results = [];
for (const [name, rule] of Object.entries(STRATEGIES)) {
  const inSample = [], outSample = [];
  for (const [pair, { bars, ind }] of Object.entries(data)) {
    const cut = Math.floor(bars.length * SPLIT);
    for (let i = 210; i < bars.length - MAX_HOLD - 2; i++) {
      let dir = null;
      try { dir = rule(bars, i, ind); } catch { continue; }
      if (!dir) continue;
      const a = ind.atr14[i];
      if (!a || !(a > 0)) continue;
      const o = outcome(bars, i, dir, a, pair);
      if (!o) continue;
      (i < cut ? inSample : outSample).push({ pair, dir, ...o });
    }
  }
  const inR = episodes(inSample), outR = episodes(outSample);
  results.push({
    name,
    inSample: { n: inR.length, avgR: +mean(inR).toFixed(3), ci: ci(inR) },
    outSample: { n: outR.length, avgR: +mean(outR).toFixed(3), ci: ci(outR) },
  });
}

results.sort((a, b) => b.outSample.avgR - a.outSample.avgR);
const survivors = results.filter(r => r.outSample.ci && r.outSample.ci[0] > 0 && r.outSample.n >= 30);

const report = {
  ts: Date.now(), isoTime: new Date().toISOString(),
  method: 'walk-forward, entry at next bar open with spread charged, v442 managed ladder, '
        + 'episodes not signals, 65/35 train-test split, textbook parameters only',
  barsPerInstrument: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.bars.length])),
  strategiesTested: results.length,
  results,
  survivors: survivors.map(s => s.name),
  verdict: survivors.length
    ? `${survivors.length} strategy(ies) held a positive interval out of sample.`
    : 'No strategy held a positive interval on the held-out data.',
  caveat: `${results.length} strategies were tested. At a 95% interval, roughly one in twenty `
        + `looks significant by chance, so a single survivor is not yet evidence — it is a candidate.`,
};
writeFileSync('data/strategy-lab.json', JSON.stringify(report, null, 2));

console.log(`tested ${results.length} strategies on ${Object.keys(data).length} instruments, ~2 years hourly\n`);
console.log('  ' + 'strategy'.padEnd(24) + 'IN-SAMPLE'.padEnd(26) + 'OUT-OF-SAMPLE (held back)');
console.log('  ' + '-'.repeat(78));
for (const r of results) {
  const f = (s) => `${String(s.n).padStart(4)}  ${(s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(3)} ${s.ci ? `[${s.ci[0]},${s.ci[1]}]`.padEnd(17) : '—'.padEnd(17)}`;
  const win = r.outSample.ci && r.outSample.ci[0] > 0 ? ' <<' : '';
  console.log('  ' + r.name.padEnd(24) + f(r.inSample) + f(r.outSample) + win);
}
console.log(`\n  ${report.verdict}`);
console.log(`  ${report.caveat}`);
