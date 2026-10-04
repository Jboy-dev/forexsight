#!/usr/bin/env node
/**
 * benchmark-vs-holding.mjs — the question every strategy must answer.
 *
 * Not "is it positive" but "is it better than doing the simplest possible
 * thing". A strategy that makes money while buy-and-hold makes more is not a
 * strategy, it is an expensive way to underperform.
 *
 * Across years of daily bars on every instrument, this measures:
 *   · buy and hold, per instrument
 *   · an equal-weight basket of all of them, rebalanced never
 *   · the engine's own signals over the same period
 *
 * Everything is in the same unit — return on capital over the period — so the
 * comparison is honest rather than R-multiples against percentages.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const DIR = 'data/deep';
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

if (!existsSync(DIR)) { console.error('no data/deep'); process.exit(1); }

const rows = [];
const dailySeries = new Map();

for (const f of readdirSync(DIR).filter(x => x.endsWith('.json'))) {
  const pair = f.replace('.json', '').replace('-', '/');
  let bars;
  try {
    bars = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'))
      .filter(x => x && typeof x.c === 'number' && isFinite(x.c) && x.c > 0);
  } catch { continue; }
  if (bars.length < 500) continue;

  const first = bars[0].c, last = bars[bars.length - 1].c;
  const years = (bars[bars.length - 1].t - bars[0].t) / (365.25 * 864e5);
  const total = (last / first - 1) * 100;
  const cagr = years > 0 ? (Math.pow(last / first, 1 / years) - 1) * 100 : null;

  // daily log returns, for volatility and the worst drawdown
  const rets = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].c / bars[i - 1].c));
  const annVol = sd(rets) * Math.sqrt(252) * 100;
  let peak = bars[0].c, maxDD = 0;
  for (const b of bars) { if (b.c > peak) peak = b.c; const dd = (peak - b.c) / peak * 100; if (dd > maxDD) maxDD = dd; }

  dailySeries.set(pair, rets);
  rows.push({ pair, years: +years.toFixed(1), bars: bars.length,
              totalPct: +total.toFixed(1), cagrPct: cagr == null ? null : +cagr.toFixed(2),
              annVolPct: +annVol.toFixed(1), maxDrawdownPct: +maxDD.toFixed(1),
              sharpe: annVol > 0 && cagr != null ? +(cagr / annVol).toFixed(2) : null });
}

rows.sort((a, b) => (b.cagrPct ?? -99) - (a.cagrPct ?? -99));

console.log(`benchmark: buy and hold, ${rows.length} instruments, deepest history available\n`);
console.log('  instrument   years    total %     CAGR %   vol %   maxDD %   CAGR/vol');
for (const r of rows) {
  console.log(`  ${r.pair.padEnd(11)} ${String(r.years).padStart(5)} ${String(r.totalPct).padStart(10)} ${String(r.cagrPct).padStart(10)} ${String(r.annVolPct).padStart(7)} ${String(r.maxDrawdownPct).padStart(9)} ${String(r.sharpe).padStart(10)}`);
}

// An equal-weight basket, rebalanced never — the simplest portfolio there is.
const pairs = [...dailySeries.keys()];
const minLen = Math.min(...pairs.map(p => dailySeries.get(p).length));
const basket = [];
for (let i = 0; i < minLen; i++) {
  let s = 0;
  for (const p of pairs) { const r = dailySeries.get(p); s += r[r.length - minLen + i]; }
  basket.push(s / pairs.length);
}
const bYears = minLen / 252;
const bTotal = (Math.exp(basket.reduce((a, b) => a + b, 0)) - 1) * 100;
const bCagr = (Math.pow(1 + bTotal / 100, 1 / bYears) - 1) * 100;
const bVol = sd(basket) * Math.sqrt(252) * 100;

console.log(`\n  EQUAL-WEIGHT BASKET of all ${pairs.length}, held throughout:`);
console.log(`    ${bYears.toFixed(1)} years   total ${bTotal.toFixed(1)}%   CAGR ${bCagr.toFixed(2)}%   vol ${bVol.toFixed(1)}%   CAGR/vol ${(bCagr / bVol).toFixed(2)}`);

// What the engine did over the same window, converted to the same unit.
let engine = null;
try {
  const e = JSON.parse(readFileSync('data/engine-sealed-test.json', 'utf8'));
  // At 1% risk per trade, avg R per signal maps to percent of capital.
  const perTradePct = e.overall.avgR * 1;
  const tradesPerYear = e.signalsFired / Math.max(1, (e.barsScanned / 24 / 365));
  engine = {
    avgRPerSignal: e.overall.avgR, signals: e.signalsFired,
    sealedAvgR: e.sealed.avgR,
    atOnePercentRisk: {
      perTradePct: +perTradePct.toFixed(4),
      tradesPerYear: Math.round(tradesPerYear),
      annualPct: +(perTradePct * tradesPerYear).toFixed(2),
    },
  };
  console.log(`\n  THE ENGINE over the same history, at 1% risk per trade:`);
  console.log(`    ${e.signalsFired.toLocaleString()} signals, ${e.overall.avgR >= 0 ? '+' : ''}${e.overall.avgR}R each`);
  console.log(`    ~${Math.round(tradesPerYear)} trades a year  ->  ${engine.atOnePercentRisk.annualPct >= 0 ? '+' : ''}${engine.atOnePercentRisk.annualPct}% a year before slippage`);
  console.log(`    on the SEALED quarter it was ${e.sealed.avgR}R per signal, i.e. ${(e.sealed.avgR * tradesPerYear).toFixed(1)}% a year`);
} catch (_) {}

const beatHolding = engine && engine.atOnePercentRisk.annualPct > bCagr;
const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/benchmark-vs-holding.mjs',
  instruments: rows, basket: { instruments: pairs.length, years: +bYears.toFixed(1),
    totalPct: +bTotal.toFixed(1), cagrPct: +bCagr.toFixed(2), annVolPct: +bVol.toFixed(1),
    cagrOverVol: +(bCagr / bVol).toFixed(2) },
  engine,
  engineBeatsHolding: !!beatHolding,
  verdict: beatHolding
    ? `The engine's signals beat simply holding the basket.`
    : `Holding an equal-weight basket of all ${pairs.length} instruments returned ${bCagr.toFixed(2)}% a year `
      + `over ${bYears.toFixed(1)} years. The engine, at 1% risk per trade, produced `
      + `${engine ? engine.atOnePercentRisk.annualPct : '?'}% a year on all history and `
      + `${engine ? (engine.sealedAvgR * engine.atOnePercentRisk.tradesPerYear).toFixed(1) : '?'}% on the sealed quarter. `
      + `Doing nothing beat it.`,
};
writeFileSync('data/benchmark-vs-holding.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
