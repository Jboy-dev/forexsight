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
import { fetchHighImpact, assess as assessNews, WINDOWS as NEWS_WINDOWS } from './news-gate.mjs';

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
    // v480 — refuse stale bars, but say WHY. Over a weekend every FX pair and
    // gold trips this because the market shut at 22:00 Friday, and the run log
    // filled with what looked like ten failures when nothing was wrong. Not
    // generating FX signals into a closed market is correct; reporting it as a
    // fault is not.
    if (ageMin > 240) {
      const d = new Date(), dow = d.getUTCDay(), hr = d.getUTCHours();
      const isCrypto = ['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(pair);
      const shut = !isCrypto && (dow === 6 || (dow === 0 && hr < 22) || (dow === 5 && hr >= 22));
      errors.push(shut
        ? `${pair}: market closed for the weekend (last bar ${Math.round(ageMin / 60)}h old) — not a fault`
        : `${pair}: last bar ${Math.round(ageMin)}min old`);
      return;
    }
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
// v470 — THE SORT WAS A TIE, SO THE FEED WAS ARBITRARY.
//
// rrOf is |tp3 - entry| / |entry - sl|, and the ladder sets tp3 at a fixed
// multiple of the stop — 3.5R for every signal since v467, 1.5R before that.
// So this comparator returned 0 for every pair and the order was whatever
// Promise.all happened to resolve first. The basket cap below then kept "the
// three strongest", which in practice meant the three that finished fetching
// first. Gold analysed at confidence 88 with six strategies and 1274 pips to
// TP3 and was dropped anyway, because three FX pairs won a race.
//
// R:R cannot rank these while the geometry is fixed, and nothing measured on
// this book predicts outcome, so the tie is broken on facts about the setup
// rather than a pretence of ranking: trend strength, then how much room the
// move has in its own terms, then the pair name so the order is at least
// stable between runs instead of changing on network timing.
const adxOf = (s) => (typeof s.adx === 'number' ? s.adx : 0);
const roomOf = (s) => {
  const risk = Math.abs(s.entry - s.sl);
  return risk > 0 && s.entry ? (risk / s.entry) : 0;   // stop as a share of price
};
signals.sort((a, b) =>
  (rrOf(b) - rrOf(a))
  || (adxOf(b) - adxOf(a))
  || (roomOf(b) - roomOf(a))
  || String(a.pair).localeCompare(String(b.pair)));

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
  // v470 — CAP WITHIN AN ASSET CLASS, NOT ACROSS ALL OF THEM.
  //
  // The cap existed because a book of same-direction FX majors is one bet on
  // the dollar wearing several names. That reasoning holds inside a class and
  // breaks across them: gold, crypto and the FX majors answer to different
  // things, so a long gold setup is not another copy of long EUR.
  //
  // Applied globally it removed gold whenever three FX pairs happened to point
  // the same way — which, with the dollar trending, is most of the time. The
  // instrument the user watches most was the one most often deleted.
  const CLASS_OF = (pair) => {
    if (pair === 'XAU/USD' || pair === 'XAG/USD') return 'metals';
    if (['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(pair)) return 'crypto';
    if (['US30', 'NAS100', 'SPX500'].includes(pair)) return 'indices';
    return 'fx';
  };
  const PER_CLASS_CAP = { fx: 3, crypto: 1, metals: 2, indices: 2 };
  for (const dir of ['BUY', 'SELL']) {
    for (const cls of ['fx', 'crypto', 'metals', 'indices']) {
      const inClass = out.filter(s => s.direction === dir && CLASS_OF(s.pair) === cls);
      const cap = PER_CLASS_CAP[cls] || 2;
      if (inClass.length > cap) {
        const drop = new Set(inClass.slice(cap));
        out = out.filter(s => !drop.has(s));
      }
    }
  }
  return out;
}

// ── v475 — GOLD IS QUOTED IN FUTURES; THE PAIR SAYS SPOT ───────────────────
//
// XAU/USD sources its candles from GC=F, which is COMEX gold futures. Futures
// carry a premium over spot for financing and storage, and it is not small.
// Measured across 46 matched hourly bars against PAXG (a token redeemable for
// London Good Delivery gold, so a clean spot proxy): mean premium 1.37%,
// sd 0.14%, currently about 68 points.
//
// The gold signals carry a stop of roughly 36 points. So the gap between the
// price we publish and the price on a spot broker's chart is nearly TWICE the
// whole trade's risk. Quoted as-is, an entry of 4551 is about 4483 on a spot
// chart and the stop sits below the current price — the setup is not merely
// slightly off, it is untradeable.
//
// Analysis still runs on the futures bars: the two series correlate almost
// perfectly (sd of the basis is 0.14%), so indicator readings are unaffected.
// Only the published LEVELS are converted, using a basis measured live each
// run rather than a constant, because the premium drifts with rates and time
// to expiry. If the spot reference is unavailable the levels are left in
// futures terms and clearly marked, rather than converted against a guess.
async function goldSpotBasis() {
  try {
    const [kl, ours] = await Promise.all([
      fetch('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1h&limit=48',
            { signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : null),
      Promise.resolve(JSON.parse(readFileSync('data/ohlc/XAU-USD.json', 'utf8'))),
    ]);
    if (!kl) return null;
    const bars = Array.isArray(ours) ? ours : (ours.bars || ours.ohlc || []);
    const spot = {};
    for (const k of kl) spot[k[0]] = +k[4];
    const ratios = [];
    for (const b of bars) if (spot[b.t] > 0) ratios.push(b.c / spot[b.t]);
    if (ratios.length < 6) return null;
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    // Refuse an implausible basis rather than mangle every level with it.
    if (!(median > 1.0 && median < 1.06)) return null;
    return { ratio: median, samples: ratios.length };
  } catch { return null; }
}

async function convertGoldToSpot(list) {
  const gold = list.filter(s => s.pair === 'XAU/USD');
  if (!gold.length) return;
  const basis = await goldSpotBasis();
  // v478 — REPORT SPOT, DO NOT SUBSTITUTE IT.
  //
  // v475 rewrote the gold levels into spot. That was wrong in a way that cost
  // real money: the levels moved but the CANDLES did not. watch-setups walks
  // every setup against data/ohlc/XAU-USD.json, which is GC=F futures, so a
  // spot-quoted setup was measured against a series ~1.4% above it. Caught in
  // the book: a SELL published at entry 4409 with a stop at 4444, walked
  // against futures bars at 4548 — 139 points above the stop on the very first
  // bar. It was recorded as a full loss before the market did anything at all.
  //
  // Two scales in one system is the defect, not which scale is chosen. Levels
  // now stay on the same scale as the bars that judge them, and the spot
  // equivalent rides alongside as information so the difference to a broker's
  // chart is visible without anything being silently rewritten.
  for (const s of gold) {
    if (!basis) {
      s.quotedIn = 'futures (GC=F)';
      s.spotNote = 'Spot reference unavailable this run. These are COMEX futures '
        + 'prices; a spot XAU/USD chart typically sits about 1.4% lower.';
      continue;
    }
    const f = 1 / basis.ratio;
    s.quotedIn = 'futures (GC=F)';
    s.futuresPremiumPct = +((basis.ratio - 1) * 100).toFixed(3);
    s.spotEquivalent = {
      entry: Math.round(s.entry * f * 100) / 100,
      sl: Math.round(s.sl * f * 100) / 100,
      tp1: Math.round(s.tp1 * f * 100) / 100,
      tp2: Math.round(s.tp2 * f * 100) / 100,
      tp3: Math.round(s.tp3 * f * 100) / 100,
    };
    s.spotNote = `Priced in COMEX futures, which ran ${((basis.ratio - 1) * 100).toFixed(2)}% above `
      + `spot across ${basis.samples} matched hours. On a spot XAU/USD chart these levels sit about `
      + `${Math.round(s.entry - s.spotEquivalent.entry)} points lower — the spot equivalents are shown `
      + `on the card. Tracking uses the futures levels, because the candles are futures.`;
  }
}

// ── v477 — WHAT YOU CAN CONTROL, SINCE YOU CANNOT PREDICT ─────────────────
//
// Every field knowable at entry has now been tested against this system's own
// record: confidence, strategy count, which strategies, the combination, ADX,
// regime, higher-timeframe alignment, killzone, independence. None separates
// winners from losers. Ranking signals by likelihood of winning would be
// invention, so this does not attempt it.
//
// What genuinely differs between two signals, and genuinely changes what you
// keep, is cost. Spread is charged on every trade whatever the outcome, and it
// is not uniform: measured live it runs about 2% of risk on GBP/USD and about
// 7% on NZD/USD and gold. If two setups are indistinguishable on evidence —
// and measurement says they are — the one that hands less away is strictly
// better. That is arithmetic, not forecasting.
//
// Typical retail spreads. Deliberately conservative: understating them would
// make the drag look smaller than it is.
// v482 — THESE ARE ESTIMATES, AND THE CODE NOW SAYS SO.
// Typical retail spreads, not measured from a feed. Yahoo's OHLC carries no
// bid/ask, so there is nothing here to derive a real spread from — every
// figure below is a broker-typical value chosen conservatively. The drag
// percentage computed from them is arithmetic, but its input is an assumption,
// and a number presented as measured when it is assumed is exactly the kind of
// thing this project has had to unpick repeatedly. Your broker's actual spread
// may be wider, especially outside London/NY hours.
const TYPICAL_SPREAD_PIPS = {
  'EUR/USD': 0.8, 'GBP/USD': 1.2, 'AUD/USD': 1.0, 'NZD/USD': 1.5,
  'USD/CAD': 1.5, 'USD/CHF': 1.4, 'USD/JPY': 0.9,
  'XAU/USD': 25, 'BTC/USD': 20, 'ETH/USD': 15,
};
const PIP_SIZE = (p) => p === 'XAU/USD' ? 0.1 : p.includes('JPY') ? 0.01
  : p === 'BTC/USD' ? 1 : p === 'ETH/USD' ? 0.1 : 0.0001;

function attachCostProfile(s) {
  const pip = PIP_SIZE(s.pair);
  const spreadPips = TYPICAL_SPREAD_PIPS[s.pair] ?? 1.5;
  const riskPips = Math.abs(s.entry - s.sl) / pip;
  if (!(riskPips > 0)) return;
  const dragPct = (spreadPips / riskPips) * 100;
  // Reward after paying the spread, over risk after paying it — what TP1
  // actually returns rather than its nominal multiple.
  const tp1Pips = Math.abs(s.tp1 - s.entry) / pip;
  s.costProfile = {
    spreadPips,
    riskPips: Math.round(riskPips * 10) / 10,
    spreadAsPctOfRisk: Math.round(dragPct * 10) / 10,
    tp1NetR: Math.round(((tp1Pips - spreadPips) / (riskPips + spreadPips)) * 100) / 100,
    grade: dragPct <= 3 ? 'low' : dragPct <= 6 ? 'moderate' : 'high',
    note: `The spread costs ${dragPct.toFixed(1)}% of what you are risking on this trade. `
        + `This is charged whether it wins or loses, and it is one of the few things `
        + `separating these setups that is actually measurable.`,
  };
}

// ── v478 — A REPUBLISHED SETUP IS NOT A NEW OPPORTUNITY ────────────────────
//
// While a setup's conditions hold, the engine republishes it on every scan and
// nothing marks the repeat. Measured on the book: ETH/USD BUY published 17
// separate times in one day, XAU/USD BUY 15 times, GBP/USD BUY 15. There is no
// cooldown anywhere — the `cooldownMinutesLeft` field the app checks is never
// populated by anything.
//
// On screen each republication looks like a fresh opportunity. When gold fell
// on the 19th it produced thirteen consecutive BUY signals into the decline,
// every one of which stopped out. Anyone treating those as separate setups took
// the same losing trade over and over.
//
// They are not suppressed — a repeat is still worth seeing if the first was
// missed, and silently dropping signals is its own kind of lie. They are
// LABELLED: how long the original has been open, and how it is currently doing.
// The decision stays with the user; what changes is that they can tell the
// difference between a second opportunity and the same one again.
// Published separately as data/repeats.json because the cards on screen are
// usually built by the in-browser scan, which never passes through this
// generator. Without a compact summary to fetch, the repeat warning would only
// appear on server-sourced cards — which is to say, rarely on the ones the
// user is actually looking at. Small file, one entry per pair+direction.
function publishRepeatSummary() {
  let book = [];
  try { book = JSON.parse(readFileSync('data/open-setups.json', 'utf8')); } catch { return; }
  const now = Date.now();
  const out = {};
  for (const x of book) {
    if (!x.pair || !x.direction || !x.firedAt) continue;
    const age = (now - Date.parse(x.firedAt)) / 3600000;
    if (!(age >= 0 && age <= 24)) continue;
    const k = `${x.pair}|${x.direction}`;
    const e = (out[k] ||= { pair: x.pair, direction: x.direction, count: 0, lost: 0, won: 0, open: 0, firstAt: x.firedAt });
    e.count++;
    if (x.status === 'open') e.open++;
    if (typeof x.resultR === 'number') { if (x.resultR < -0.02) e.lost++; else if (x.resultR > 0.02) e.won++; }
    if (String(x.firedAt) < String(e.firstAt)) e.firstAt = x.firedAt;
  }
  for (const e of Object.values(out)) {
    e.runningForHours = Math.round((now - Date.parse(e.firstAt)) / 360000) / 10;
  }
  writeFileSync('data/repeats.json', JSON.stringify({
    ts: now, isoTime: new Date().toISOString(),
    windowHours: 24,
    note: 'How many times each pair+direction has been published in the last 24h, '
        + 'and how those resolved. A republication is the same setup continuing while '
        + 'its conditions hold, not a new opportunity.',
    repeats: Object.values(out).sort((a, b) => b.count - a.count),
  }, null, 2));
}

function markRepeats(list) {
  let book = [];
  try { book = JSON.parse(readFileSync('data/open-setups.json', 'utf8')); } catch { return; }
  const now = Date.now();
  for (const s of list) {
    const prior = book
      .filter(x => x.pair === s.pair && x.direction === s.direction && x.firedAt)
      .filter(x => {
        const age = (now - Date.parse(x.firedAt)) / 3600000;
        return age >= 0 && age <= 24;
      })
      .sort((a, b) => String(b.firedAt).localeCompare(String(a.firedAt)));
    if (!prior.length) continue;

    const openOnes = prior.filter(x => x.status === 'open');
    const resolved = prior.filter(x => typeof x.resultR === 'number');
    const first = prior[prior.length - 1];
    const hours = Math.round((now - Date.parse(first.firedAt)) / 360000) / 10;
    const lost = resolved.filter(x => x.resultR < -0.02).length;

    s.repeatOf = {
      count: prior.length,
      runningForHours: hours,
      stillOpen: openOnes.length,
      alreadyResolved: resolved.length,
      alreadyLost: lost,
      note: openOnes.length
        ? `Same ${s.pair} ${s.direction} has been signalled ${prior.length} time(s) over the last `
          + `${hours}h and ${openOnes.length} is still open. This is that setup continuing, not a new one.`
        : `Same ${s.pair} ${s.direction} was signalled ${prior.length} time(s) in the last ${hours}h`
          + (resolved.length ? `, of which ${lost} stopped out.` : '.'),
    };
  }
}

// ── v482 — REFUSE TO TRADE INTO A SCHEDULED RELEASE ────────────────────────
//
// /api/calendar has existed since v300 and returns real Forex Factory data.
// Nothing consulted it: check-signals.js contains no calendar reference, and
// this generator had none, which matters more because it produces every signal
// whenever Cloudflare Functions are down.
//
// A high-impact release is the one market event whose TIMING is known exactly
// in advance. A stop placed on chart structure has no idea a rate decision is
// eleven minutes away. This is not a prediction of the number or the direction
// — only the arithmetic that a scheduled repricing is inside the window and a
// setup sized for normal conditions is not sized for it.
async function applyNewsGate(list) {
  const events = await fetchHighImpact();
  const kept = [];
  for (const s of list) {
    const a = assessNews(s.pair, events);
    s.newsCheck = {
      verdict: a.verdict,
      note: a.note || null,
      events: (a.events || []).slice(0, 3).map(e => ({
        title: e.title, country: e.country, minutesAway: e.minutesAway,
        forecast: e.forecast, previous: e.previous,
      })),
      windows: NEWS_WINDOWS,
    };
    if (a.verdict === 'block') {
      console.log(`  news-blocked ${s.pair} ${s.direction}: ${a.note}`);
      continue;
    }
    if (a.verdict === 'warn') console.log(`  news-warn ${s.pair} ${s.direction}: ${a.note}`);
    kept.push(s);
  }
  return { kept, feedOk: Array.isArray(events), eventCount: events ? events.length : 0 };
}

// Score before dedupe so every emitted signal carries whatever is known.
{
  const brain = loadBrain();
  for (const sig of signals) attachBrainScore(sig, brain);
  const scored = signals.filter(s => s.probabilityAnalysis).length;
  console.log(`brain scoring: ${scored}/${signals.length} signal(s) had enough episodes to quote a win chance`);
}

// Convert gold to spot BEFORE dedupe/validation so everything downstream —
// R:R checks, pip floors, the mirror gatekeeper — sees the tradeable numbers.
// News gate first: a setup that should not be published at all does not need
// costing, repeat-marking or scoring.
{
  const ng = await applyNewsGate(signals);
  const blocked = signals.length - ng.kept.length;
  signals.length = 0;
  signals.push(...ng.kept);
  console.log(`news gate: ${ng.feedOk ? ng.eventCount + ' high-impact event(s) loaded' : 'CALENDAR UNAVAILABLE — news risk unchecked'}`
    + (blocked ? `, ${blocked} signal(s) blocked` : ''));
}

await convertGoldToSpot(signals);
// Cost profile AFTER the gold conversion, so gold's drag is computed on the
// spot levels the user would actually trade.
for (const sig of signals) attachCostProfile(sig);
markRepeats(signals);
publishRepeatSummary();

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
