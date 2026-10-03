#!/usr/bin/env node
/**
 * build-rates.mjs — conversion rates, so money figures are in YOUR currency.
 *
 * Profit and loss lands in each instrument's QUOTE currency, not in yours:
 *   EUR/USD, XAU/USD, BTC/USD  -> USD
 *   USD/JPY -> JPY     USD/CHF -> CHF     USD/CAD -> CAD
 * Showing a USD/JPY result as if it were pounds would be out by a factor of
 * about 200, so every quote currency is converted explicitly.
 *
 * Everything is derived from prices this project already holds and verifies.
 * Nothing is hard-coded, because a stale hard-coded rate is a silently wrong
 * money figure, which is the worst kind.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

const last = (pair) => {
  for (const dir of ['data/deep', 'data/ohlc']) {
    try {
      const b = JSON.parse(readFileSync(`${dir}/${pair}.json`, 'utf8'));
      const bars = Array.isArray(b) ? b : (b.bars || b.ohlc || []);
      for (let i = bars.length - 1; i >= 0; i--) {
        const c = bars[i]?.c;
        if (typeof c === 'number' && isFinite(c) && c > 0) return { price: c, at: bars[i].t };
      }
    } catch { /* try the next source */ }
  }
  return null;
};

const gbpusd = last('GBP-USD');   // USD per GBP
const eurusd = last('EUR-USD');   // USD per EUR
const usdjpy = last('USD-JPY');   // JPY per USD
const usdchf = last('USD-CHF');   // CHF per USD
const usdcad = last('USD-CAD');   // CAD per USD

if (!gbpusd) { console.error('build-rates: no GBP/USD price — cannot convert to GBP'); process.exit(1); }

// Everything expressed as "how many USD is one unit of X"
const usdPer = {
  USD: 1,
  GBP: gbpusd.price,
  EUR: eurusd ? eurusd.price : null,
  JPY: usdjpy ? 1 / usdjpy.price : null,
  CHF: usdchf ? 1 / usdchf.price : null,
  CAD: usdcad ? 1 / usdcad.price : null,
};

const accounts = ['GBP', 'USD', 'EUR'];
const toAccount = {};
for (const acct of accounts) {
  if (!usdPer[acct]) continue;
  toAccount[acct] = {};
  for (const [ccy, u] of Object.entries(usdPer)) {
    if (u == null) continue;
    // one unit of `ccy` is worth this many units of `acct`
    toAccount[acct][ccy] = +(u / usdPer[acct]).toFixed(8);
  }
}

const freshest = Math.max(...[gbpusd, eurusd, usdjpy, usdchf, usdcad].filter(Boolean).map(x => x.at || 0));
const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/build-rates.mjs',
  pricedAt: new Date(freshest).toISOString(),
  ageHours: +(((Date.now() - freshest) / 36e5)).toFixed(1),
  usdPer,
  toAccount,
  // Which quote currency each instrument settles in.
  quoteOf: {
    'EUR/USD': 'USD', 'GBP/USD': 'USD', 'AUD/USD': 'USD', 'NZD/USD': 'USD',
    'XAU/USD': 'USD', 'XAG/USD': 'USD', 'BTC/USD': 'USD', 'ETH/USD': 'USD',
    'USD/JPY': 'JPY', 'USD/CHF': 'CHF', 'USD/CAD': 'CAD',
  },
  note: 'P&L lands in the instrument quote currency and is converted at these rates. '
      + 'Rates come from the same verified price caches the signals use.',
};
writeFileSync('data/fx-rates.json', JSON.stringify(out, null, 2));

console.log(`rates: priced ${out.pricedAt.slice(0, 16)} (${out.ageHours}h old)`);
for (const acct of accounts) {
  if (!toAccount[acct]) continue;
  const r = toAccount[acct];
  console.log(`  1 unit -> ${acct}:  ` + ['USD', 'EUR', 'JPY', 'CHF', 'CAD'].filter(c => r[c] != null)
    .map(c => `${c} ${r[c].toFixed(c === 'JPY' ? 6 : 4)}`).join('  '));
}
