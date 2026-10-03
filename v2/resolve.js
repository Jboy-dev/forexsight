/* ============================================================================
   v2/resolve.js — Research, made open-ended.

   The topic list in knowledge.js only answers questions I thought of in
   advance. This answers questions I did not, by resolving whatever the question
   actually REFERS TO against live data:

     an instrument  "how has gold done"      -> that pair's real ledger record
     a field name   "what is maeR"           -> the glossary, with its live value
     a term         "what does spans zero mean"
     a count        "how many BTC signals"   -> counted from the book

   It never invents. Every answer is either a definition that is true by
   construction, or a figure read from a published file and labelled with it.
   When it genuinely cannot resolve something it says so and lists what it DID
   recognise in the question, which is more useful than a blank refusal.
   ========================================================================== */
'use strict';

const RS_ESC = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rsN = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const rsSign = (n) => (n == null ? '' : n > 0 ? '+' : '');

/* ── every instrument the site knows, and how people refer to them ──────── */
const RS_INSTRUMENTS = {
  'XAU/USD': ['gold', 'xau', 'xauusd', 'bullion'],
  'XAG/USD': ['silver', 'xag', 'xagusd'],
  'EUR/USD': ['eurusd', 'euro dollar', 'fiber', 'eur usd'],
  'GBP/USD': ['gbpusd', 'cable', 'pound dollar', 'sterling'],
  'USD/JPY': ['usdjpy', 'dollar yen', 'yen'],
  'AUD/USD': ['audusd', 'aussie'],
  'NZD/USD': ['nzdusd', 'kiwi'],
  'USD/CAD': ['usdcad', 'loonie'],
  'USD/CHF': ['usdchf', 'swissy', 'franc'],
  'EUR/GBP': ['eurgbp', 'euro pound'],
  'EUR/JPY': ['eurjpy', 'euro yen'],
  'GBP/JPY': ['gbpjpy', 'guppy', 'pound yen'],
  'AUD/JPY': ['audjpy', 'aussie yen'],
  'BTC/USD': ['bitcoin', 'btc', 'btcusd'],
  'ETH/USD': ['ethereum', 'eth', 'ethusd', 'ether'],
  'SOL/USD': ['solana', 'sol'],
  'XRP/USD': ['ripple', 'xrp'],
  'US30': ['dow', 'dow jones', 'us30', 'djia'],
  'NAS100': ['nasdaq', 'nas100', 'ndx', 'tech index'],
};

/* ── every field the published files contain, in plain words ───────────── */
const RS_GLOSSARY = {
  resultr: ['resultR', 'What the trade finally returned, in R. +1.5 means it made one and a half times what it risked; −1 means it lost the full stop.'],
  mae: ['maeR', 'Maximum Adverse Excursion — the furthest the trade went AGAINST you before it resolved, in R. A winner with −0.9R MAE was nearly stopped out first.'],
  mfe: ['mfeR', 'Maximum Favourable Excursion — the furthest it went IN YOUR FAVOUR. A loser with +0.9R MFE got close to TP1 and gave it all back.'],
  tpreached: ['tpReached', 'Which take-profit it actually touched: 1, 2, 3, or 0 for none. This is the difference between the two win rates on the Ledger.'],
  adx: ['adx', 'Trend strength, 0–100, with no direction in it. Under 20 is rangebound, over 25–30 is trending. It says how hard price is pushing, never which way.'],
  atr: ['atr', 'Average True Range — typical movement per bar, including gaps. A size measure with no direction. Used to place stops outside ordinary noise.'],
  confidence: ['confidence', 'The engine\'s internal structure score. NOT a probability — a confidence of 97 does not mean 97%.'],
  regime: ['regime', 'The market state the engine classified: TRENDING, RANGING, MIXED, BREAKOUT or QUIET. It selects which strategies get weighted.'],
  spansZero: ['spans zero', 'The confidence interval includes 0, so the true value could be positive OR negative. It means the result is not distinguishable from chance — not that it is bad.'],
  ci: ['confidence interval', 'The range the true value plausibly sits in. A result of +0.08R with an interval of [−0.03, +0.18] has not established anything, because zero is inside it.'],
  episode: ['episode', 'One market move. If the same setup republishes five times in a day that is five signals but ONE episode, and only the episode counts as independent evidence.'],
  inflation: ['inflation factor', 'How many raw publications there are per independent episode. Here it is about 3.7x — counting raw signals would overstate the evidence by that much.'],
  r: ['R / R-multiple', '1R is what you lose if the stop is hit. Everything else is a multiple of it, so a gold trade and a yen trade can be compared and added up.'],
  payoff: ['payoff ratio', 'Average win divided by average loss. Above 1 means winners are bigger than losers — which is how a sub-50% win rate can still make money.'],
  expectancy: ['expectancy', '(win% × average win) − (loss% × average loss). The only number that says whether a system makes money. Win rate alone cannot.'],
  drawdown: ['drawdown', 'Peak-to-trough fall. Recovery is asymmetric: −50% needs +100% to get back.'],
  slippage: ['slippage', 'The gap between the price you wanted and the price you got. Worse in fast markets and around news.'],
  spread: ['spread', 'The gap between buy and sell price, paid on every trade. On a 20-pip stop a 1-pip spread is 5% of your risk, gone before the trade starts.'],
  swap: ['swap', 'Overnight financing on a held position. Can run either way and compounds over multi-day holds.'],
  pip: ['pip', 'The standard small unit of an FX move — 0.0001 on most pairs, 0.01 on yen pairs.'],
  lot: ['lot', 'A standard position unit: 100,000 of the base currency. A mini lot is 10,000, a micro 1,000.'],
  leverage: ['leverage', 'Borrowed exposure. It multiplies both directions and changes nothing about whether the setup is any good.'],
  killzone: ['killzone', 'A session window some strategies trade. Note: this site found its FX feed produces fake hour-of-day effects, so it uses NO session rules.'],
  bonferroni: ['Bonferroni correction', 'Raising the significance bar because you tested many ideas. Test 72 at the usual 5% and about 4 pass by luck alone.'],
  sealed: ['sealed holdout', 'Data deliberately not looked at while choosing a rule, opened once at the end. It is the only honest test of whether something generalises.'],
  overfitting: ['overfitting', 'A rule that fits the data it was chosen on and nothing else. Here: t=5.26 in training, t=0.26 on unseen data.'],
};

/* ── live lookups ───────────────────────────────────────────────────────── */
function rsFindInstrument(q) {
  const t = q.toLowerCase();
  for (const [pair, names] of Object.entries(RS_INSTRUMENTS)) {
    if (t.includes(pair.toLowerCase())) return pair;
    for (const n of names) {
      if (new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(t)) return pair;
    }
  }
  return null;
}

function rsInstrumentAnswer(pair, S) {
  const L = S.ledger;
  const V = S.marketVoice;
  const rows = [];

  if (L && Array.isArray(L.byPair)) {
    const row = L.byPair.find(x => x.key === pair);
    if (row) {
      const ci = Array.isArray(row.ci) ? `[${row.ci.join(', ')}]` : '—';
      rows.push(`<table class="kb-t"><tr><th>its record here</th><th></th></tr>
        <tr><td>signals resolved</td><td>${RS_ESC(row.n)}</td></tr>
        <tr><td>won / lost</td><td>${RS_ESC(row.wins)} / ${RS_ESC(row.losses)} (${RS_ESC(row.winRate)}%)</td></tr>
        <tr><td>average per signal</td><td>${RS_ESC(rsSign(row.avgR) + row.avgR)}R</td></tr>
        <tr><td>total</td><td>${RS_ESC(rsSign(row.totalR) + row.totalR)}R</td></tr>
        <tr><td>interval</td><td>${RS_ESC(ci)}</td></tr></table>`);
      const spans = Array.isArray(row.ci) && row.ci[0] <= 0 && row.ci[1] >= 0;
      rows.push(`<p>${spans
        ? `That interval includes zero, so on ${RS_ESC(row.n)} trades this pair has not established an edge in either direction.`
        : `That interval excludes zero on ${RS_ESC(row.n)} trades.`} ${row.n < 30 ? '<strong>And with fewer than 30 trades, treat the number as barely more than noise.</strong>' : ''}</p>`);
    } else {
      rows.push(`<p>No resolved signals on ${RS_ESC(pair)} are in the ledger yet, so there is nothing measured to report for it.</p>`);
    }
  }

  if (V && V.volatility && V.volatility.all) {
    const key = pair.replace('/', '-');
    const v = V.volatility.all[key];
    if (v) rows.push(`<p><strong>Right now</strong> its range sits at the ${RS_ESC(v.yearPercentile)}th percentile of its own past year (${RS_ESC(v.atrPctOfPrice)}% of price per day).${v.yearPercentile < 25 ? ' Quiet — tight stops get hit by noise here.' : v.yearPercentile > 75 ? ' Unusually active.' : ''}</p>`);
  }

  const live = ((S.latestSignals && S.latestSignals.signals) || []).filter(s => String(s.pair) === pair);
  rows.push(live.length
    ? `<p><strong>There ${live.length === 1 ? 'is' : 'are'} ${live.length} live setup${live.length === 1 ? '' : 's'}</strong> on ${RS_ESC(pair)} right now — ${live.map(s => RS_ESC(String(s.direction).toUpperCase())).join(', ')}.</p>`
    : `<p>No live setup on ${RS_ESC(pair)} at the moment.</p>`);

  return { kind: 'measured', q: `What do you know about ${pair}?`,
    body: rows.join(''), source: 'data/ledger.json, data/market-voice.json and the live feed' };
}

function rsGlossaryAnswer(q) {
  const t = ' ' + q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best = null, bestLen = 0;

  // WHOLE-WORD matching, with a minimum length. The first version used plain
  // substring matching, so the single-letter key "r" matched inside "ratio" and
  // inside "france" — "what is the capital of france" came back with a
  // confident definition of the R-multiple. A wrong answer delivered
  // confidently is the worst output this can produce.
  const hit = (needle) => {
    const n = needle.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n) return 0;
    // One- and two-character keys only count as a standalone word.
    const re = new RegExp(`(^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
    if (!re.test(t)) return 0;
    return n.length < 3 ? 1 : n.length;   // short keys win only if nothing longer does
  };

  for (const [k, [term, def]] of Object.entries(RS_GLOSSARY)) {
    // The term can be written several ways: "mfeR", "mfe", "maximum favourable excursion"
    const forms = [term, k, term.split('/')[0].trim(), term.replace(/r$/i, '')];
    let score = 0;
    for (const f of forms) score = Math.max(score, hit(f));
    if (score > bestLen) { best = [term, def]; bestLen = score; }
  }
  if (!best) return null;
  return { kind: 'mechanical', q: `What is ${best[0]}?`,
    body: `<p><strong>${RS_ESC(best[0])}</strong> — ${RS_ESC(best[1])}</p>`,
    source: 'definitional' };
}

function rsCountAnswer(q, S) {
  if (!/how many|count|number of/i.test(q)) return null;
  const L = S.ledger; if (!L) return null;
  const pair = rsFindInstrument(q);
  if (pair && Array.isArray(L.byPair)) {
    const row = L.byPair.find(x => x.key === pair);
    return { kind: 'measured', q: `How many ${pair} signals have there been?`,
      body: row ? `<p><strong>${RS_ESC(row.n)}</strong> resolved signals on ${RS_ESC(pair)}: ${RS_ESC(row.wins)} won, ${RS_ESC(row.losses)} lost.</p>`
                : `<p>None recorded on ${RS_ESC(pair)} yet.</p>`,
      source: 'data/ledger.json' };
  }
  return { kind: 'measured', q: 'How many signals have there been?',
    body: `<p><strong>${RS_ESC(L.coverage.total)}</strong> recorded in total — ${RS_ESC(L.coverage.resolved)} resolved, ${RS_ESC(L.coverage.open)} still open, covering ${RS_ESC(String(L.coverage.from).slice(0, 10))} to ${RS_ESC(String(L.coverage.to).slice(0, 10))}.</p>`,
    source: 'data/ledger.json' };
}

/** The honest fallback: say what WAS recognised rather than nothing at all. */
function rsFallback(q, S) {
  const seen = [];
  const pair = rsFindInstrument(q);
  if (pair) seen.push(`the instrument <strong>${RS_ESC(pair)}</strong>`);
  const g = rsGlossaryAnswer(q);
  if (g) seen.push(`the term <strong>${RS_ESC(g.q.replace(/^What is /, '').replace(/\?$/, ''))}</strong>`);
  if (!seen.length) return null;
  return { kind: 'measured', q: 'Here is what I can tell you about that',
    body: `<p>I did not have a prepared answer for that exact question, but I recognised ${seen.join(' and ')} in it, so here is what I actually know:</p>`
        + (pair ? rsInstrumentAnswer(pair, S).body : '') + (g ? g.body : ''),
    source: 'resolved from the question against live data' };
}

/** Tried in order. The first that resolves wins. */
function rsResolve(q, S) {
  if (!q || !String(q).trim()) return null;
  return rsCountAnswer(q, S)
      || (rsFindInstrument(q) ? rsInstrumentAnswer(rsFindInstrument(q), S) : null)
      || rsGlossaryAnswer(q)
      || rsFallback(q, S);
}

window.FSRESOLVE = { resolve: rsResolve, INSTRUMENTS: RS_INSTRUMENTS, GLOSSARY: RS_GLOSSARY, findInstrument: rsFindInstrument };
