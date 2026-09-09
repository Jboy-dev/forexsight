import { readFileSync } from 'fs';
// v487 — THE STRATEGIES THAT ACTUALLY EARNED A PLACE.
//
// The engine's own strategy set measures reliably negative: -0.241R in a
// walk-forward backtest and -0.29R on the live tracked record, both intervals
// excluding zero. Its firing strategies — TREND, VWAP, ICHIMOKU, MOMENTUM —
// are all trend-following variants, and a twelve-strategy test over two years
// of hourly bars showed exactly that family losing worst:
//
//   Donchian 55 breakout   -0.373R out-of-sample
//   Donchian 20 breakout   -0.325R
//   Bollinger breakout     -0.263R
//   Trend pullback         -0.157R
//
// while mean reversion won:
//
//   RSI mean reversion     +0.236R out-of-sample, n=606, CI [0.151, 0.323]
//   MACD cross             +0.135R                n=935, CI [0.066, 0.208]
//   RSI trend filter       +0.108R                n=428, CI [0.005, 0.212]
//   Bollinger reversion    +0.098R                n=815, CI [0.027, 0.171]
//
// Twelve strategies were tested, so one crossing a 95% interval by chance was
// expected. Four did, all from the same family, which is a coherent finding
// rather than scattered noise. The leader was then checked harder and held:
// positive on 10 of 10 instruments and in 20 of 25 months.
//
// Only textbook parameter values are used — RSI 14 with 30/70, Bollinger 20
// with 2 standard deviations, MACD 12/26. Nothing was searched or tuned on
// this data, so a good result here cannot be an artefact of fitting.
//
// What this is NOT: a promise. Mean reversion sells volatility, which pays
// steadily and then loses badly in a dislocation. Two years is one regime. The
// signals these produce are labelled with exactly the evidence above so the
// claim is checkable rather than asserted.

export function rsiSeries(c, p = 14) {
  const o = []; let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (i <= p) {
      g += Math.max(d, 0); l += Math.max(-d, 0); o[i] = null;
      if (i === p) { g /= p; l /= p; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
    } else {
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      l = (l * (p - 1) + Math.max(-d, 0)) / p;
      o[i] = 100 - 100 / (1 + g / (l || 1e-9));
    }
  }
  return o;
}
export function emaSeries(a, p) {
  const k = 2 / (p + 1); const e = []; let pr = null;
  for (let i = 0; i < a.length; i++) { pr = pr == null ? a[i] : a[i] * k + pr * (1 - k); e[i] = i < p - 1 ? null : pr; }
  return e;
}
export function smaSeries(a, p) {
  const o = []; let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; o[i] = i >= p - 1 ? s / p : null; }
  return o;
}
export function stdevSeries(a, p) {
  const o = [];
  for (let i = p - 1; i < a.length; i++) {
    const w = a.slice(i - p + 1, i + 1);
    const m = w.reduce((x, y) => x + y, 0) / p;
    o[i] = Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / p);
  }
  return o;
}

// v489 — A STRATEGY ONLY SHIPS IF IT CLEARS ITS OWN CONTROL.
//
// Four strategies were originally published here on the strength of the lab's
// out-of-sample numbers alone. When the random-entry control was extended from
// one strategy to all four, RSI trend filter failed it: +0.054R with an
// interval of [-0.004, 0.114], which includes zero. Its evidence was on cards
// regardless, which is precisely the kind of unearned claim this project keeps
// having to remove.
//
// Rather than delete the rule and lose the record of why, the control result is
// read at run time and any strategy that does not pass is skipped. If a passing
// strategy later stops clearing random entries, it drops out on the next cycle
// without anyone having to notice.
function controlVerdicts() {
  try {
    const c = JSON.parse(readFileSync('data/control-test.json', 'utf8'));
    if (!c || !c.randomEntries || c.randomEntries.behavesAsNull !== true) return null;
    return c.perStrategy || null;
  } catch { return null; }
}

// Measured out-of-sample performance, carried on every signal so the card can
// state the evidence rather than assert quality.
export const PROVEN = {
  'RSI mean reversion': { avgR: 0.236, n: 606, ci: [0.151, 0.323], instruments: '10/10', months: '20/25' },
  'MACD cross':         { avgR: 0.135, n: 935, ci: [0.066, 0.208] },
  'RSI trend filter':   { avgR: 0.108, n: 428, ci: [0.005, 0.212] },
  'Bollinger reversion':{ avgR: 0.098, n: 815, ci: [0.027, 0.171] },
};

// Each returns 'BUY' | 'SELL' | null for the LAST closed bar.
export function evaluate(bars) {
  const n = bars.length - 1;
  if (n < 210) return [];
  const c = bars.map(b => b.c);
  const r = rsiSeries(c, 14);
  const e200 = emaSeries(c, 200);
  const s20 = smaSeries(c, 20);
  const sd20 = stdevSeries(c, 20);
  const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26);
  const hits = [];

  // RSI mean reversion — crossing back out of oversold/overbought.
  if (r[n] != null && r[n - 1] != null) {
    if (r[n - 1] < 30 && r[n] >= 30) hits.push({ strategy: 'RSI mean reversion', direction: 'BUY' });
    if (r[n - 1] > 70 && r[n] <= 70) hits.push({ strategy: 'RSI mean reversion', direction: 'SELL' });
  }
  // RSI pullback taken only with the 200 EMA.
  if (r[n] != null && r[n - 1] != null && e200[n]) {
    const up = c[n] > e200[n];
    if (up && r[n - 1] < 40 && r[n] >= 40) hits.push({ strategy: 'RSI trend filter', direction: 'BUY' });
    if (!up && r[n - 1] > 60 && r[n] <= 60) hits.push({ strategy: 'RSI trend filter', direction: 'SELL' });
  }
  // Bollinger reversion — price closing back inside the band.
  if (s20[n] && sd20[n]) {
    const up = s20[n] + 2 * sd20[n], dn = s20[n] - 2 * sd20[n];
    if (c[n - 1] < dn && c[n] >= dn) hits.push({ strategy: 'Bollinger reversion', direction: 'BUY' });
    if (c[n - 1] > up && c[n] <= up) hits.push({ strategy: 'Bollinger reversion', direction: 'SELL' });
  }
  // MACD line crossing its zero point.
  if (e12[n] && e26[n] && e12[n - 1] && e26[n - 1]) {
    const m = e12[n] - e26[n], mp = e12[n - 1] - e26[n - 1];
    if (m > 0 && mp <= 0) hits.push({ strategy: 'MACD cross', direction: 'BUY' });
    if (m < 0 && mp >= 0) hits.push({ strategy: 'MACD cross', direction: 'SELL' });
  }
  // Filter to strategies that currently clear the control, and carry that
  // verdict alongside the lab figure so the card states both.
  const verdicts = controlVerdicts();
  return hits
    .filter(h => {
      if (!verdicts) return false;            // no valid control -> publish nothing
      const v = verdicts[h.strategy];
      return !!(v && v.passes);
    })
    .map(h => ({
      ...h,
      evidence: PROVEN[h.strategy],
      control: verdicts[h.strategy],
    }));
}
