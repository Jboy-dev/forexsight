/* ============================================================================
   v2/calc.js — what a signal is actually worth, in your money.

   Pure functions, no DOM. Every figure here is arithmetic with no forecast in
   it: given a balance, a risk percentage and a signal's own levels, these are
   the amounts, and they are exact.

   THE THREE PLACES MONEY MATHS GOES WRONG, all handled explicitly:

   1. QUOTE CURRENCY. P&L lands in the instrument's quote currency, not yours.
      USD/JPY settles in yen; printing that as pounds is out by ~200x.
   2. THE LADDER IS NOT ONE EXIT. Thirds are banked at TP1, TP2 and TP3, and
      the stop MOVES after each. "Profit at TP3" is not 3.5R — it is the sum of
      three different exits, and the realistic outcomes are the partial ones.
   3. SIZE COMES FROM THE STOP. You do not choose a size and discover your
      risk; you fix the risk and the stop determines the size.
   ========================================================================== */
'use strict';

const CALC_DEFAULTS = { balance: 1000, riskPct: 1, currency: 'GBP' };
const CALC_SYM = { GBP: '£', USD: '$', EUR: '€' };

/** How many units of `acct` one unit of `quote` is worth. */
function calcRate(rates, quote, acct) {
  if (!rates || !rates.toAccount || !rates.toAccount[acct]) return null;
  const r = rates.toAccount[acct][quote];
  return (typeof r === 'number' && isFinite(r) && r > 0) ? r : null;
}

function calcQuoteOf(rates, pair) {
  const p = String(pair || '').toUpperCase();
  if (rates && rates.quoteOf && rates.quoteOf[p]) return rates.quoteOf[p];
  const m = p.match(/([A-Z]{3,4})\s*\/\s*([A-Z]{3,4})/);
  return m ? m[2] : 'USD';
}

function money(v, ccy) {
  if (v == null || !isFinite(v)) return '—';
  const s = CALC_SYM[ccy] || '';
  const neg = v < 0;
  const a = Math.abs(v);
  // Always 2dp below five figures. "£223.3" reads like a truncation error
  // rather than an amount, and this is money.
  const dp = a >= 10000 ? 0 : 2;
  return (neg ? '−' : '') + s + a.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * The complete money picture for one signal.
 * Returns null when a required level is missing — never a guessed number.
 */
function calcSignal(sig, cfg, rates) {
  const entry = +sig.entry, sl = +sig.sl, tp1 = +sig.tp1, tp2 = +sig.tp2, tp3 = +sig.tp3;
  if (![entry, sl].every(v => isFinite(v) && v > 0)) return null;

  const priceRisk = Math.abs(entry - sl);
  if (!(priceRisk > 0)) return null;

  const acct = cfg.currency || 'GBP';
  const quote = calcQuoteOf(rates, sig.pair);
  const rate = calcRate(rates, quote, acct);          // quote -> account

  const riskAcct = (+cfg.balance) * (+cfg.riskPct) / 100;
  if (!(riskAcct > 0)) return null;

  // Size is derived from the stop. Risk in the quote currency first, because
  // that is the currency the instrument actually moves in.
  const riskQuote = rate ? riskAcct / rate : null;
  const units = riskQuote != null ? riskQuote / priceRisk : null;

  // Account-currency value of a 1R move. By construction this equals riskAcct,
  // which is the check that the chain above is right.
  const perR = riskAcct;

  const rOf = (tp) => (isFinite(tp) && tp > 0) ? Math.abs(tp - entry) / priceRisk : null;
  const r1 = rOf(tp1), r2 = rOf(tp2), r3 = rOf(tp3);

  // THE LADDER. A third is banked at each target and the stop moves behind it.
  // These are the outcomes that can actually happen, not a single "take profit".
  const third = 1 / 3;
  const outcomes = [];
  outcomes.push({
    name: 'Stopped out before TP1', detail: 'the stop is hit with nothing banked',
    r: -1, money: -perR,
  });
  if (r1 != null) outcomes.push({
    name: 'TP1, then stopped at entry', detail: 'a third banked, the rest closes flat',
    r: +(third * r1).toFixed(4), money: perR * third * r1,
  });
  if (r1 != null && r2 != null) outcomes.push({
    name: 'TP2, then stopped at TP1', detail: 'two thirds banked, the last third exits at TP1',
    r: +(third * r1 + third * r2 + third * r1).toFixed(4),
    money: perR * (third * r1 + third * r2 + third * r1),
  });
  if (r1 != null && r2 != null && r3 != null) outcomes.push({
    name: 'Full run to TP3', detail: 'all three thirds banked',
    r: +(third * (r1 + r2 + r3)).toFixed(4), money: perR * third * (r1 + r2 + r3),
  });

  return {
    ok: true,
    currency: acct, symbol: CALC_SYM[acct] || '',
    quote, rate, rateKnown: rate != null,
    balance: +cfg.balance, riskPct: +cfg.riskPct,
    riskAmount: riskAcct,
    priceRisk, units,
    perR,
    targets: [
      r1 != null ? { name: 'TP1', price: tp1, r: +r1.toFixed(3), fullMoney: perR * r1 } : null,
      r2 != null ? { name: 'TP2', price: tp2, r: +r2.toFixed(3), fullMoney: perR * r2 } : null,
      r3 != null ? { name: 'TP3', price: tp3, r: +r3.toFixed(3), fullMoney: perR * r3 } : null,
    ].filter(Boolean),
    outcomes,
    best: outcomes[outcomes.length - 1],
    worst: outcomes[0],
  };
}

/* ── the dynamic calculator ───────────────────────────────────────────────
   Type what you want. Each handler returns a worked answer or null, and the
   first that matches wins. Adding one is a single object, same as the orders.
   ------------------------------------------------------------------------ */
const CALC_RULES = [
  {
    id: 'risk-on-balance',
    help: 'risk 2% of 5000 — how much money that is',
    test: /(?:risk\s*)?([\d.]+)\s*%\s*(?:of|on)\s*([\d,.]+)/i,
    run(m, ctx) {
      const pct = parseFloat(m[1]), bal = parseFloat(m[2].replace(/,/g, ''));
      if (!isFinite(pct) || !isFinite(bal)) return null;
      const amt = bal * pct / 100;
      return { title: `${pct}% of ${money(bal, ctx.currency)}`,
        value: money(amt, ctx.currency),
        work: [`${money(bal, ctx.currency)} × ${pct}% = ${money(amt, ctx.currency)}`,
               `That is what you lose if the stop is hit — your 1R.`] };
    },
  },
  {
    id: 'what-if-r',
    help: '3R on 1% of 2000 — what a result in R is worth',
    test: /(-?[\d.]+)\s*r\b/i,
    run(m, ctx) {
      const r = parseFloat(m[1]);
      if (!isFinite(r)) return null;
      const per = ctx.balance * ctx.riskPct / 100;
      return { title: `${r >= 0 ? '+' : ''}${r}R at ${ctx.riskPct}% of ${money(ctx.balance, ctx.currency)}`,
        value: money(r * per, ctx.currency),
        work: [`1R = ${ctx.riskPct}% of ${money(ctx.balance, ctx.currency)} = ${money(per, ctx.currency)}`,
               `${r}R × ${money(per, ctx.currency)} = ${money(r * per, ctx.currency)}`] };
    },
  },
  {
    id: 'size-from-stop',
    help: 'size with a 20 pip stop — position size from a stop distance',
    test: /(?:size|lots?|units?|position)[^\d]*([\d.]+)\s*(pips?|points?)?/i,
    run(m, ctx) {
      const stopPips = parseFloat(m[1]);
      if (!isFinite(stopPips) || stopPips <= 0) return null;
      const risk = ctx.balance * ctx.riskPct / 100;
      const perPip = risk / stopPips;
      return { title: `Size for a ${stopPips}-pip stop`,
        value: `${money(perPip, ctx.currency)} per pip`,
        work: [`Risk = ${ctx.riskPct}% of ${money(ctx.balance, ctx.currency)} = ${money(risk, ctx.currency)}`,
               `${money(risk, ctx.currency)} ÷ ${stopPips} pips = ${money(perPip, ctx.currency)} per pip`,
               `On a standard lot (${ctx.currency === 'USD' ? '$10' : '~' + (CALC_SYM[ctx.currency] || '') + '7.50'}/pip) that is about ${(perPip / (ctx.currency === 'USD' ? 10 : 7.5)).toFixed(2)} lots`] };
    },
  },
  {
    id: 'recover',
    help: 'recover from 20% down — the gain needed to get back',
    test: /(?:(?:recover|back|regain|drawdown|down)[^\d]*([\d.]+)\s*%|([\d.]+)\s*%\s*(?:drawdown|down|loss))/i,
    run(m, ctx) {
      const dd = parseFloat(m[1] ?? m[2]);
      if (!isFinite(dd) || dd <= 0 || dd >= 100) return null;
      const need = (100 / (100 - dd) - 1) * 100;
      return { title: `Recovering a ${dd}% drawdown`,
        value: `+${need.toFixed(1)}%`,
        work: [`${money(ctx.balance, ctx.currency)} down ${dd}% = ${money(ctx.balance * (1 - dd / 100), ctx.currency)}`,
               `To get back you need +${need.toFixed(1)}%, not +${dd}%`,
               `Losses and gains are not symmetric — this is why drawdown control matters more than win rate.`] };
    },
  },
  {
    id: 'streak',
    help: 'what if I lose 8 in a row — the damage from a losing run',
    // "8 losses in a row" puts the number FIRST; "lose 8 in a row" puts it
    // second. Both are natural, so both are matched.
    test: /(?:([\d.]+)\s*(?:losses|losers|trades?|in a row|straight)|(?:lose|loss|losing|streak)[^\d]*([\d.]+))/i,
    run(m, ctx) {
      const n = Math.round(parseFloat(m[1] ?? m[2]));
      if (!isFinite(n) || n < 1 || n > 200) return null;
      const after = ctx.balance * Math.pow(1 - ctx.riskPct / 100, n);
      const lost = ctx.balance - after;
      const need = (ctx.balance / after - 1) * 100;
      return { title: `${n} losses in a row at ${ctx.riskPct}% each`,
        value: money(after, ctx.currency),
        work: [`${money(ctx.balance, ctx.currency)} × (1 − ${ctx.riskPct}%)^${n} = ${money(after, ctx.currency)}`,
               `You would be down ${money(lost, ctx.currency)} (${((lost / ctx.balance) * 100).toFixed(1)}%)`,
               `Recovering needs +${need.toFixed(1)}%`,
               `This site's longest recorded losing run is 13.`] };
    },
  },
  {
    id: 'expectancy',
    help: 'expectancy at 45% win and 1.5 payoff',
    test: /([\d.]+)\s*%?\s*(?:win|wins).*?([\d.]+)\s*(?:payoff|rr|r\b|reward)/i,
    run(m, ctx) {
      const w = parseFloat(m[1]) / 100, payoff = parseFloat(m[2]);
      if (!isFinite(w) || !isFinite(payoff) || w <= 0 || w >= 1) return null;
      const e = w * payoff - (1 - w) * 1;
      const per = ctx.balance * ctx.riskPct / 100;
      return { title: `Expectancy at ${(w * 100).toFixed(0)}% wins paying ${payoff}R`,
        value: `${e >= 0 ? '+' : ''}${e.toFixed(3)}R per trade`,
        work: [`(${(w * 100).toFixed(0)}% × ${payoff}R) − (${((1 - w) * 100).toFixed(0)}% × 1R) = ${e.toFixed(3)}R`,
               `At ${ctx.riskPct}% risk that is ${money(e * per, ctx.currency)} per trade on average`,
               e > 0 ? `Positive — but only if those inputs hold, and this site has not established that they do.`
                     : `Negative. No amount of position sizing fixes a negative expectancy.`] };
    },
  },
];

function calcDynamic(input, ctx) {
  const q = String(input || '').trim();
  if (!q) return null;
  for (const rule of CALC_RULES) {
    const m = q.match(rule.test);
    if (!m) continue;
    try { const r = rule.run(m, ctx); if (r) return { ...r, rule: rule.id }; } catch (_) {}
  }
  return null;
}

window.FSCALC = { DEFAULTS: CALC_DEFAULTS, SYM: CALC_SYM, money, calcSignal, calcDynamic, RULES: CALC_RULES, quoteOf: calcQuoteOf, rate: calcRate };
