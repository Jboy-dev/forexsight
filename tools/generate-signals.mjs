// v447 — INDEPENDENT SIGNAL GENERATION.
//
// Runs the real signal engine outside Cloudflare and writes the result to
// data/latest-signals.json, which the app already falls back to when the
// Functions runtime is unavailable (v426 mirror path).
//
// Why this exists: the Cloudflare free tier allows 100k Function
// invocations a day. When that runs out, every /api/* route stops returning
// JSON and the mirror — which sources its content from those same routes —
// freezes at whatever it last managed to fetch. On the day this was written
// the mirror was serving a snapshot seven hours old while reporting nothing
// unusual. A fallback that depends on the thing it is meant to be a fallback
// for is not a fallback.
//
// This path shares no infrastructure with Cloudflare: GitHub Actions runner,
// Yahoo bars, Node. It imports strictAnalyze from check-signals.js directly
// rather than reimplementing it, so the offline generator cannot drift into
// being a different algorithm from the live one.
//
//   node tools/generate-signals.mjs            # writes data/latest-signals.json
//   node tools/generate-signals.mjs --dry-run  # prints, writes nothing

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { strictAnalyze } from '../functions/api/check-signals.js';

const PAIR_SYMBOLS = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'NZD/USD': 'NZDUSD=X',
  'USD/CHF': 'USDCHF=X', 'XAU/USD': 'GC=F',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};

const DRY = process.argv.includes('--dry-run');

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
            + `?interval=1h&range=60d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`${symbol} no result`);
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some(v => v == null || !Number.isFinite(v))) continue;
    bars.push({ t: ts[i] * 1000, o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return bars;
}

// ── v469 — ATTACH WHAT THE BRAIN ACTUALLY KNOWS ────────────────────────────
//
// The win-chance figure used to come from a Cloudflare Function reading KV.
// That made the app's intelligence depend on Cloudflare being up, and when the
// KV key expired every signal arrived unscored and the card rendered it as
// "0% win chance". This reads the offline brain instead — same statistics,
// built in CI by tools/build-brain.mjs, no Function and no KV.
//
// It attaches an estimate ONLY where the brain has enough episodes to support
// one. Where it does not, nothing is attached and the card says "not scored",
// which is the truth. Inventing a number for a thin slice is how the previous
// version misled, and the sample floor is on episodes, not publications, so a
// single trending move cannot manufacture confidence.
function loadBrain() {
  try { return JSON.parse(readFileSync('data/learning-brain.json', 'utf8')); }
  catch { return null; }
}

function attachBrainScore(sig, brain) {
  if (!brain) return;
  const combo = brain.byCombo && sig.comboKey ? brain.byCombo[sig.comboKey] : null;
  const pair  = brain.byPair && sig.pair ? brain.byPair[sig.pair] : null;
  // Prefer the most specific slice that clears the sample floor.
  const src = (combo && combo.usable) ? { s: combo, basis: `combo ${sig.comboKey}` }
            : (pair && pair.usable)   ? { s: pair,  basis: `pair ${sig.pair}` }
            : null;
  if (!src) {
    sig.brainNote = brain.byCombo && sig.comboKey && brain.byCombo[sig.comboKey]
      ? `only ${brain.byCombo[sig.comboKey].samples} episode(s) for this combination `
        + `— below the ${brain.minSamplesForUse} needed to quote a win chance`
      : 'no resolved history for this setup yet';
    return;
  }
  const { s, basis } = src;
  sig.probabilityAnalysis = {
    pWin: Math.round((s.winRate || 0) * 100),
    samples: s.samples,
    avgR: s.avgR,
    ci: s.ci,
    proven: s.proven,
    basis,
    source: 'offline-brain',
    // Said on the object itself so nothing downstream can present this as
    // more than it is.
    caveat: s.proven
      ? 'Interval clears zero on this slice.'
      : 'Measured rate only. The interval includes zero, so this is not evidence of an edge.',
  };
}

const signals = [];
const errors = [];

await Promise.all(Object.entries(PAIR_SYMBOLS).map(async ([pair, sym]) => {
  try {
    const bars = await fetchBars(sym);
    if (bars.length < 120) { errors.push(`${pair}: only ${bars.length} bars`); return; }
    // Staleness guard — never emit a signal off a chart that stopped updating.
    const ageMin = (Date.now() - bars[bars.length - 1].t) / 60000;
    if (ageMin > 240) { errors.push(`${pair}: last bar ${Math.round(ageMin)}min old`); return; }
    const s = strictAnalyze(pair, bars, []);
    if (s && s.direction && s.entry != null && s.sl != null) {
      signals.push({ ...s, generatedOffline: true, barAgeMinutes: Math.round(ageMin) });
    }
  } catch (e) {
    errors.push(`${pair}: ${e.message}`);
  }
}));

// v448 — DO NOT RANK BY CONFIDENCE.
//
// This sorted by confidence descending, which put the measurably worst
// signals at the top of the feed. Replaying the live engine over 17,437
// signals: the 90-99 confidence band returned -0.046R and the 70-79 band
// +0.135R, and low-agreement signals beat high-agreement ones by +0.044R
// (95% CI [+0.006, +0.081]). correlation(confidence, outcome) = -0.010.
//
// Ordering ascending would be acting on the reverse of that finding, which
// the held-out split does not support strongly enough to bet on. So the list
// is ordered by something that is a FACT about the setup rather than a
// prediction about it: reward per unit of risk actually on offer at TP3.
// Confidence is still shown, but it no longer decides what you see first.
const rrOf = (s) => {
  const risk = Math.abs(s.entry - s.sl);
  if (!(risk > 0) || typeof s.tp3 !== 'number') return 0;
  return Math.abs(s.tp3 - s.entry) / risk;
};
signals.sort((a, b) => rrOf(b) - rrOf(a));

// The live path runs correlation dedup and a basket cap in latest-signals.js
// before anything reaches the user. This path bypasses that endpoint, so the
// same guards have to be applied here — otherwise the standby feed can hand
// over six "different" signals that are all the same USD bet, which is
// concentrated risk dressed up as confluence. The first run of this
// generator produced exactly that: six SELLs, every one of them long USD.
function dedupeCorrelated(list) {
  const GROUPS = [
    ['AUD/USD', 'NZD/USD'],                 // both commodity / risk-on
    ['EUR/USD', 'GBP/USD'],                 // both anti-USD
    ['USD/CHF', 'USD/JPY', 'USD/CAD'],      // all USD-major
    ['BTC/USD', 'ETH/USD'],                 // crypto beta
  ];
  let out = list.slice();
  for (const group of GROUPS) {
    for (const dir of ['BUY', 'SELL']) {
      const inGroup = out.filter(s => group.includes(s.pair) && s.direction === dir);
      if (inGroup.length > 1) {
        const keep = inGroup[0];   // sorted by reward-to-risk, not confidence
        out = out.filter(s => s === keep || !inGroup.includes(s));
      }
    }
  }
  // Whole-book cap: if everything points the same way it is one position,
  // not a portfolio. Keep the three strongest.
  for (const dir of ['BUY', 'SELL']) {
    const sameDir = out.filter(s => s.direction === dir);
    if (sameDir.length > 3) {
      const drop = new Set(sameDir.slice(3));
      out = out.filter(s => !drop.has(s));
    }
  }
  return out;
}

// Score before dedupe so every emitted signal carries whatever is known.
{
  const brain = loadBrain();
  for (const sig of signals) attachBrainScore(sig, brain);
  const scored = signals.filter(s => s.probabilityAnalysis).length;
  console.log(`brain scoring: ${scored}/${signals.length} signal(s) had enough episodes to quote a win chance`);
}

const beforeDedupe = signals.length;
const kept = dedupeCorrelated(signals);
signals.length = 0;
signals.push(...kept);

const payload = {
  ts: Date.now(),
  isoTime: new Date().toISOString(),
  count: signals.length,
  signals,
  source: 'offline-generator',
  correlationFiltered: beforeDedupe - signals.length,
  // Stated plainly so the app and anyone reading the file knows this came
  // from the standby path, not the live Cloudflare scan.
  note: 'Generated by tools/generate-signals.mjs (GitHub Actions) using the '
      + 'same strictAnalyze() the live endpoint uses. Produced independently '
      + 'of Cloudflare so signals stay current when Functions are unavailable.',
  errors: errors.length ? errors : undefined,
};

if (DRY) {
  console.log(JSON.stringify(payload, null, 2).slice(0, 3000));
  console.log(`\n${signals.length} signals, ${errors.length} errors`);
} else {
  mkdirSync('data', { recursive: true });
  writeFileSync('data/latest-signals.json', JSON.stringify(payload, null, 2));
  console.log(`wrote data/latest-signals.json — ${signals.length} signals`);
  if (errors.length) console.log('errors: ' + errors.join(' | '));
}
