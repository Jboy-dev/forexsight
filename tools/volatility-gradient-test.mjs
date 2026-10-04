#!/usr/bin/env node
/**
 * volatility-gradient-test.mjs — does volatility at entry grade the outcome?
 *
 * PROVENANCE, stated plainly because it decides how much this is worth:
 * this was NOT a hypothesis I brought to the data. It appeared in the CONTROL
 * ARM of the cost-ceiling test, which admitted the highest-ATR trades purely to
 * rule out a confound, and which showed on the sealed quarter:
 *
 *     top  5% by ATR   +0.1515R        top 43%   +0.0708R
 *     top  9% by ATR   +0.1464R        top 58%   -0.0170R
 *     top 13% by ATR   +0.1357R        top 71%   -0.0343R
 *     top 27% by ATR   +0.0830R        all       +0.0027R
 *
 * Monotone across eight nested cuts. That is a much stronger shape than any one
 * threshold winning, and ATR is known at signal time, so it is not selection on
 * returns. But it was SEEN on the sealed set, which means the sealed set is spent
 * for this question and cannot also judge it.
 *
 * So the test is inverted on purpose: train and validate have never been looked
 * at for this hypothesis, and they are the holdout now. The statistic is
 * monotonicity itself — Spearman rank correlation between volatility decile and
 * mean return — not any single bucket, so there is one number per window and
 * nothing to tune.
 *
 * FALSIFIER, fixed before running: the correlation must be positive and
 * materially so in BOTH train and validate, independently. A gradient visible
 * only where it was discovered is a pattern in one quarter of one dataset.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';

const DIR = 'data/intraday', SUFFIX = '.1h.json';
const HOLD = 240, SL_MULT = 3.0, TPS = [1.2, 2.0, 3.5];
const DECILES = 10;

const SPREAD = {
  'EUR/USD': 0.00008, 'GBP/USD': 0.00011, 'AUD/USD': 0.00010, 'NZD/USD': 0.00014,
  'USD/CAD': 0.00012, 'USD/CHF': 0.00011, 'EUR/GBP': 0.00011,
  'USD/JPY': 0.009,   'EUR/JPY': 0.013,   'GBP/JPY': 0.018,   'AUD/JPY': 0.013,
  'XAU/USD': 0.28,    'XAG/USD': 0.018,
  'BTC/USD': 22,      'ETH/USD': 1.6,     'SOL/USD': 0.09,    'XRP/USD': 0.0016,
  'US30': 2.2,        'NAS100': 1.6,
};

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => { const s = sd(a); return s > 0 && a.length > 1 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const ci95 = a => { if (a.length < 2) return null; const se = sd(a) / Math.sqrt(a.length);
  return [+(mean(a) - 1.96 * se).toFixed(4), +(mean(a) + 1.96 * se).toFixed(4)]; };

function atrSeries(b, p = 14) {
  const out = Array(b.length).fill(null); let acc = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
    if (i <= p) { acc += tr; if (i === p) out[i] = acc / p; } else out[i] = (out[i-1]*(p-1)+tr)/p;
  }
  return out;
}
const sma = (c, p) => { const o = Array(c.length).fill(null); let s = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= p) s -= c[i-p]; if (i >= p-1) o[i] = s/p; } return o; };

function runTrade(d, i, dir) {
  const a = d.atr[i]; if (a == null || !(a > 0)) return null;
  const entry = d.b[i+1] && d.b[i+1].o; if (!entry) return null;
  const sign = dir === 'BUY' ? 1 : -1, slDist = a * SL_MULT;
  const cost = (SPREAD[d.pair] ?? entry * 0.00012) / slDist;
  const tps = TPS.map(r => entry + sign*slDist*r);
  let banked = 0, left = 1, stop = entry - sign*slDist, hit = 0, bars = HOLD;
  const done = g => ({ r: g - cost, atrPct: a / entry, bars });
  for (let j = i+1; j < Math.min(d.b.length, i+1+HOLD); j++) {
    const b = d.b[j]; bars = j - i;
    if ((sign>0&&b.l<=stop)||(sign<0&&b.h>=stop)) return done(banked + left*((stop-entry)*sign/slDist));
    for (let k = hit; k < 3; k++) {
      if (!(sign>0 ? b.h>=tps[k] : b.l<=tps[k])) break;
      banked += (1/3)*TPS[k]; left -= 1/3; hit = k+1;
      if (hit===1) stop = entry; else if (hit===2) stop = tps[0];
      if (hit>=3) return done(banked);
    }
  }
  bars = HOLD;
  const li = Math.min(d.b.length-1, i+HOLD);
  return done(banked + left*((d.b[li].c-entry)*sign/slDist));
}

const signal = (d, i) => {
  const a = d.c[i-60]; if (!a || d.ma200[i] == null) return null;
  const dir = d.c[i] > a ? 'BUY' : 'SELL';
  return (dir === 'BUY') === (d.c[i] > d.ma200[i]) ? dir : null;
};

if (!existsSync(DIR)) { console.error('no data/intraday'); process.exit(1); }

const all = [];
for (const f of readdirSync(DIR).filter(x => x.endsWith(SUFFIX))) {
  const pair = f.replace(SUFFIX,'').replace('-','/');
  let bars;
  try { bars = JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))
    .filter(x=>x&&[x.o,x.h,x.l,x.c].every(v=>typeof v==='number'&&isFinite(v)&&v>0)); } catch { continue; }
  if (bars.length < 1200) continue;
  const c = bars.map(x=>x.c);
  const d = { pair, b: bars, c, atr: atrSeries(bars), ma200: sma(c,200) };
  // Volatility must be ranked WITHIN an instrument. Gold's ATR% and EUR/USD's
  // are not comparable, and pooling them would rank instruments, not regimes.
  const rows = [];
  let free = 260;
  for (let i = 260; i < bars.length - HOLD - 2; i++) {
    if (i < free) continue;
    const dir = signal(d, i); if (!dir) continue;
    const t = runTrade(d, i, dir); if (!t) continue;
    const frac = i / bars.length;
    rows.push({ pair, r: t.r, atrPct: t.atrPct,
                win: frac < 0.5 ? 'train' : frac < 0.75 ? 'validate' : 'sealed' });
    free = i + t.bars + 1;
  }
  // Within-instrument, within-window percentile rank, so a decile means
  // "quiet or busy FOR THIS MARKET, IN THIS PERIOD" and carries no look-ahead.
  for (const w of ['train','validate','sealed']) {
    const g = rows.filter(x => x.win === w).sort((a,b)=>a.atrPct-b.atrPct);
    g.forEach((x, k) => { x.pct = g.length > 1 ? k / (g.length - 1) : 0.5; all.push(x); });
  }
}
console.log(`${all.length} trades, ${new Set(all.map(t=>t.pair)).size} instruments,`
  + ` volatility ranked within each instrument and window\n`);

function spearman(pairs) {               // pairs of [decile, meanR]
  const n = pairs.length; if (n < 3) return 0;
  const rank = arr => { const s = arr.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]); const r = Array(n);
    s.forEach(([,i],k)=>{ r[i]=k+1; }); return r; };
  const rx = rank(pairs.map(p=>p[0])), ry = rank(pairs.map(p=>p[1]));
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i]-mx)*(ry[i]-my); dx += (rx[i]-mx)**2; dy += (ry[i]-my)**2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx*dy) : 0;
}

const windows = {};
for (const w of ['train','validate','sealed']) {
  const pool = all.filter(t => t.win === w);
  const buckets = [];
  for (let k = 0; k < DECILES; k++) {
    const rs = pool.filter(t => t.pct >= k/DECILES && t.pct < (k+1)/DECILES + (k===DECILES-1?1e-9:0)).map(t=>t.r);
    buckets.push({ decile: k+1, n: rs.length, avgR: +mean(rs).toFixed(4), t: +tstat(rs).toFixed(2) });
  }
  const rho = spearman(buckets.filter(b=>b.n>20).map(b=>[b.decile, b.avgR]));
  // Top vs bottom third, as a plain-money reading of the same thing.
  const top = pool.filter(t=>t.pct>=2/3).map(t=>t.r), bot = pool.filter(t=>t.pct<1/3).map(t=>t.r);
  const se = Math.sqrt(sd(top)**2/top.length + sd(bot)**2/bot.length);
  windows[w] = { buckets, spearman: +rho.toFixed(3),
    topThird: { n: top.length, avgR: +mean(top).toFixed(4), t: +tstat(top).toFixed(2), ci: ci95(top) },
    bottomThird: { n: bot.length, avgR: +mean(bot).toFixed(4), t: +tstat(bot).toFixed(2), ci: ci95(bot) },
    topMinusBottomR: +(mean(top)-mean(bot)).toFixed(4), topMinusBottomT: se>0 ? +((mean(top)-mean(bot))/se).toFixed(2) : 0 };
}

for (const w of ['train','validate','sealed']) {
  const x = windows[w];
  console.log(`  ${w.toUpperCase()}   rank correlation decile -> return: rho=${x.spearman}`);
  console.log('    ' + x.buckets.map(b => `${b.n>20 ? ((b.avgR>=0?'+':'')+b.avgR.toFixed(3)) : '  n/a '}`).join(' '));
  console.log(`    top third ${(x.topThird.avgR>=0?'+':'')+x.topThird.avgR}R (n=${x.topThird.n}, t=${x.topThird.t})`
    + `   bottom third ${(x.bottomThird.avgR>=0?'+':'')+x.bottomThird.avgR}R (n=${x.bottomThird.n}, t=${x.bottomThird.t})`
    + `   difference ${(x.topMinusBottomR>=0?'+':'')+x.topMinusBottomR}R t=${x.topMinusBottomT}\n`);
}

// The falsifier, applied to the two windows that had not been looked at.
const holdout = ['train','validate'];
const rhoOK = holdout.every(w => windows[w].spearman > 0.3);
const diffOK = holdout.every(w => windows[w].topMinusBottomR > 0);
const established = rhoOK && diffOK;

console.log(`  FALSIFIER (fixed before running): positive, material gradient in BOTH train and validate,`);
console.log(`  the two windows never examined for this hypothesis.`);
console.log(`    train    rho=${windows.train.spearman}  top-minus-bottom ${(windows.train.topMinusBottomR>=0?'+':'')+windows.train.topMinusBottomR}R`);
console.log(`    validate rho=${windows.validate.spearman}  top-minus-bottom ${(windows.validate.topMinusBottomR>=0?'+':'')+windows.validate.topMinusBottomR}R`);
console.log(`    -> ${established ? 'HOLDS in both' : 'FAILS'}`);

const out = {
  ts: Date.now(), isoTime: new Date().toISOString(), builtBy: 'tools/volatility-gradient-test.mjs',
  hypothesis: 'Volatility at entry, ranked within instrument and period, grades trade outcome monotonically.',
  provenance: 'Seen in the control arm of tools/cost-ceiling-test.mjs on the SEALED quarter, so the sealed '
    + 'set is spent for this question. Train and validate had never been examined for it and are the holdout.',
  falsifierStatedBeforeRunning: 'Spearman rho > 0.3 and a positive top-minus-bottom-third difference in BOTH '
    + 'train and validate, independently.',
  statistic: 'Spearman rank correlation between volatility decile and mean return — one number per window, '
    + 'nothing to tune.',
  ranking: 'Percentile within each instrument and each window. Gold ATR% and EUR/USD ATR% are not comparable, '
    + 'so pooling raw values would rank instruments rather than regimes.',
  stopMultiple: SL_MULT, ladder: TPS, totalTrades: all.length, windows, established,
  verdict: established
    ? `The volatility gradient holds on data it was not found in: rho=${windows.train.spearman} in training `
      + `and rho=${windows.validate.spearman} in validation, with the top third beating the bottom third by `
      + `${windows.train.topMinusBottomR}R and ${windows.validate.topMinusBottomR}R respectively. On the `
      + `sealed quarter where it was discovered it was ${windows.sealed.topMinusBottomR}R `
      + `(t=${windows.sealed.topMinusBottomT}). Volatility at entry is known before the trade, so this is a `
      + `usable condition rather than a prediction.`
    : `The gradient does NOT survive the windows it was not found in. Training rho=${windows.train.spearman}, `
      + `validation rho=${windows.validate.spearman}, against a stated bar of 0.3 in both. Top third minus `
      + `bottom third was ${windows.train.topMinusBottomR}R in training and `
      + `${windows.validate.topMinusBottomR}R in validation. The clean monotone ladder on the sealed quarter `
      + `(${windows.sealed.topMinusBottomR}R, t=${windows.sealed.topMinusBottomT}) was a pattern in the one `
      + `window it was spotted in.`,
};
writeFileSync('data/volatility-gradient-test.json', JSON.stringify(out, null, 2));
console.log(`\n  ${out.verdict}`);
