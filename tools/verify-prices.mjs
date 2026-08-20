// v475 — CHECK THE PRICES AGAINST SOMEONE ELSE.
//
// Every candle in this system comes from one place: Yahoo. The integrity
// checker (verify-data.mjs) proves the bars are internally consistent —
// ordered, no gaps, highs above lows — but a single source that is confidently
// wrong passes all of that. Wrong decimal placement, a stale feed, or the
// wrong instrument behind a ticker would produce a clean-looking file and a
// confident bad signal on top of it.
//
// This asks an unrelated provider what the price is and compares. It cannot
// make the data better; it can stop the system trading on data that is
// visibly wrong, which is the difference between a quiet failure and a caught
// one.
//
// Honest about its own limits:
//   • crypto has two live venues that normally agree inside 0.2%, so the
//     check there is tight and meaningful
//   • FX is compared against reference rates, which are not live spot — the
//     tolerance is wide and only catches gross errors
//   • gold has no free second source that works, so it is reported as
//     UNVERIFIED rather than quietly assumed correct
import { readFileSync, writeFileSync } from 'fs';

const UA = { 'User-Agent': 'Mozilla/5.0' };
const get = async (url, ms = 15000) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// tolerance is per-source-class, not per-pair, and reflects what the reference
// actually is rather than what we would like it to be.
const CHECKS = {
  'BTC/USD': { tol: 0.010, fetch: async () => {
    const [b, c] = await Promise.all([
      get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(d => +d.price).catch(() => null),
      get('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(d => +d.data.amount).catch(() => null),
    ]);
    const vals = [b, c].filter(v => Number.isFinite(v));
    return vals.length ? { price: vals.reduce((x, y) => x + y, 0) / vals.length, from: `${vals.length} venue(s)` } : null;
  }},
  'ETH/USD': { tol: 0.010, fetch: async () => {
    const [b, c] = await Promise.all([
      get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT').then(d => +d.price).catch(() => null),
      get('https://api.coinbase.com/v2/prices/ETH-USD/spot').then(d => +d.data.amount).catch(() => null),
    ]);
    const vals = [b, c].filter(v => Number.isFinite(v));
    return vals.length ? { price: vals.reduce((x, y) => x + y, 0) / vals.length, from: `${vals.length} venue(s)` } : null;
  }},
};

// FX majors against reference rates. Wide tolerance on purpose: these are
// daily reference fixings, not live spot, so a 1% gap is normal and only a
// gross error should trip it.
const FX = { 'EUR/USD': 'EUR', 'GBP/USD': 'GBP', 'AUD/USD': 'AUD', 'NZD/USD': 'NZD' };
const FX_INV = { 'USD/CAD': 'CAD', 'USD/CHF': 'CHF', 'USD/JPY': 'JPY' };
const FX_TOL = 0.015;

const report = { ts: Date.now(), isoTime: new Date().toISOString(), checked: [], problems: [] };

let refRates = null;
try { refRates = (await get('https://open.er-api.com/v6/latest/USD')).rates; } catch {}

for (const [pair, slug] of Object.entries({
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'EUR/USD': 'EUR-USD', 'GBP/USD': 'GBP-USD',
  'AUD/USD': 'AUD-USD', 'NZD/USD': 'NZD-USD', 'USD/CAD': 'USD-CAD', 'USD/CHF': 'USD-CHF',
  'USD/JPY': 'USD-JPY', 'XAU/USD': 'XAU-USD',
})) {
  let ours = null;
  try {
    const raw = JSON.parse(readFileSync(`data/ohlc/${slug}.json`, 'utf8'));
    const bars = Array.isArray(raw) ? raw : (raw.bars || raw.ohlc || []);
    ours = bars.length ? bars[bars.length - 1].c : null;
  } catch {}
  if (ours == null) { report.problems.push(`${pair}: no local bars to check`); continue; }

  let ref = null, tol = FX_TOL, from = null;
  if (CHECKS[pair]) {
    const r = await CHECKS[pair].fetch().catch(() => null);
    if (r) { ref = r.price; tol = CHECKS[pair].tol; from = r.from; }
  } else if (refRates && FX[pair] && refRates[FX[pair]]) {
    ref = 1 / refRates[FX[pair]]; from = 'er-api reference';
  } else if (refRates && FX_INV[pair] && refRates[FX_INV[pair]]) {
    ref = refRates[FX_INV[pair]]; from = 'er-api reference';
  }

  if (ref == null) {
    report.checked.push({ pair, ours, ref: null, status: 'UNVERIFIED',
      note: 'no independent free source available — this price is trusted, not checked' });
    continue;
  }
  const diff = Math.abs(ours - ref) / ref;
  const ok = diff <= tol;
  report.checked.push({
    pair, ours, ref: +ref.toFixed(6), from,
    diffPct: +(diff * 100).toFixed(3), tolerancePct: +(tol * 100).toFixed(2),
    status: ok ? 'OK' : 'MISMATCH',
  });
  if (!ok) report.problems.push(
    `${pair}: ours ${ours} vs ${from} ${ref.toFixed(5)} — ${(diff * 100).toFixed(2)}% apart (tolerance ${(tol * 100).toFixed(1)}%)`);
}

report.verifiedCount = report.checked.filter(c => c.status === 'OK').length;
report.unverifiedCount = report.checked.filter(c => c.status === 'UNVERIFIED').length;
report.mismatchCount = report.checked.filter(c => c.status === 'MISMATCH').length;
report.healthy = report.mismatchCount === 0;
report.verdict = report.healthy
  ? `${report.verifiedCount} price(s) agree with an independent source; ${report.unverifiedCount} could not be checked.`
  : `${report.mismatchCount} price(s) disagree with an independent source.`;

writeFileSync('data/price-verification.json', JSON.stringify(report, null, 2));
console.log(`price cross-check: ${report.verifiedCount} agree, ${report.unverifiedCount} unverified, ${report.mismatchCount} mismatched`);
for (const c of report.checked) {
  const d = c.diffPct != null ? `${c.diffPct}% vs ${c.from}` : c.note;
  console.log(`  ${c.status === 'OK' ? '✓' : c.status === 'UNVERIFIED' ? '?' : '✗'} ${c.pair.padEnd(9)} ${String(c.ours).padEnd(12)} ${d}`);
}
