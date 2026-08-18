// v448 — ALWAYS WATCHING, EVEN WHEN CLOUDFLARE IS NOT.
//
// The outcome watcher (shadow-tracker) is a Cloudflare Function, so when the
// Function budget runs out it stops watching entirely: signals fire, and
// nothing records what happened to them. The app then shows a feed of open
// setups that nobody is following, which is worse than showing none — it
// looks like it is watching when it is not.
//
// This watches from the GitHub Actions runner instead, so a setup is tracked
// to its conclusion regardless of Cloudflare's state.
//
// It is deliberately gap-proof. GitHub throttles this repo's `*/15` cron to
// roughly hourly in practice (measured: 46-72 min between runs), so a
// watcher that only looked at "what happened since I last ran" would miss
// hits. Instead every run re-walks each setup from the bar it fired on,
// using the full bar history. Outcomes are therefore identical whether the
// runner fires every 15 minutes or once a day — the only thing cadence
// affects is how quickly a result is published, not whether it is correct.
//
// The ladder matches shadow-tracker._walkTrade and the v442 plan on every
// card exactly: a third banked at each target, stop to entry after TP1.
//
//   node tools/watch-setups.mjs            # updates data/shadow-tracker.json
//   node tools/watch-setups.mjs --dry-run

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const DRY = process.argv.includes('--dry-run');
const BOOK = 'data/open-setups.json';
const OUT = 'data/shadow-tracker.json';
const EXPIRY_HOURS = 48;

const PAIR_SYMBOLS = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'NZD/USD': 'NZDUSD=X',
  'USD/CHF': 'USDCHF=X', 'XAU/USD': 'GC=F',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&range=60d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error('no result');
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some(v => v == null || !Number.isFinite(v))) continue;
    out.push({ t: ts[i] * 1000, o, h, l, c });
  }
  return out;
}

// Identical to shadow-tracker._walkTrade. Kept in step deliberately — if the
// two ever disagree, the same setup would resolve differently depending on
// which system happened to be up, and the history would be meaningless.
function walk(s, bars) {
  const isBuy = s.direction === 'BUY';
  const slDist = Math.abs(s.entry - s.sl);
  if (!(slDist > 0)) return null;
  const rOf = px => (typeof px === 'number' && Number.isFinite(px)) ? Math.abs(px - s.entry) / slDist : null;
  const r1 = rOf(s.tp1), r2 = rOf(s.tp2), r3 = rOf(s.tp3);
  let tp = 0, banked = 0, open = 1, stop = s.sl, mae = 0, mfe = 0, lastClose = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    lastClose = b.c;
    const adv = isBuy ? s.entry - b.l : b.h - s.entry;
    const fav = isBuy ? b.h - s.entry : s.entry - b.l;
    if (adv > mae) mae = adv;
    if (fav > mfe) mfe = fav;

    const stopHit = isBuy ? b.l <= stop : b.h >= stop;
    let reached = 0;
    if (r1 != null && (isBuy ? b.h >= s.tp1 : b.l <= s.tp1)) reached = 1;
    if (r2 != null && (isBuy ? b.h >= s.tp2 : b.l <= s.tp2)) reached = 2;
    if (r3 != null && (isBuy ? b.h >= s.tp3 : b.l <= s.tp3)) reached = 3;

    // A bar spanning both stop and target is ambiguous at this resolution —
    // read it as the stop, and credit only targets banked on earlier bars.
    if (stopHit) {
      banked += open * (tp === 0 ? -1 : 0);
      return { status: tp > 0 ? 'won' : 'lost', tpReached: tp, resultR: banked,
               maeR: mae / slDist, mfeR: mfe / slDist, bars: i + 1 };
    }
    while (reached > tp) {
      const nx = tp + 1, rh = nx === 1 ? r1 : nx === 2 ? r2 : r3;
      if (rh == null) break;
      tp = nx; banked += rh / 3; open = Math.max(0, open - 1 / 3);
      if (tp === 1) stop = s.entry;          // from here the trade cannot lose
    }
    if (tp === 3) {
      return { status: 'won', tpReached: 3, resultR: banked,
               maeR: mae / slDist, mfeR: mfe / slDist, bars: i + 1 };
    }
  }

  const ageH = (Date.now() - Date.parse(s.firedAt)) / 3600000;
  if (ageH >= EXPIRY_HOURS && lastClose != null) {
    const moved = isBuy ? lastClose - s.entry : s.entry - lastClose;
    banked += open * (moved / slDist);
    return { status: 'expired', tpReached: tp, resultR: banked,
             maeR: mae / slDist, mfeR: mfe / slDist, bars: bars.length,
             closedAtMarket: true };
  }
  return { status: 'open', tpReached: tp, resultR: null,
           maeR: mae / slDist, mfeR: mfe / slDist, bars: bars.length };
}

// ── Add any newly published signals to the book ────────────────────────────
const book = readJson(BOOK, []);
const known = new Set(book.map(s => s.key));
const latest = readJson('data/latest-signals.json', { signals: [] });
let added = 0;
for (const s of (latest.signals || [])) {
  if (!s.pair || !s.direction || s.entry == null || s.sl == null) continue;
  // One entry per pair+direction+hour: re-publishing the same setup on the
  // next scan must not create a second position to track.
  const hourStamp = new Date(latest.ts || Date.now()).toISOString().slice(0, 13);
  const key = `${s.pair}_${s.direction}_${hourStamp}`;
  if (known.has(key)) continue;
  book.push({
    key, pair: s.pair, direction: s.direction,
    entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
    confidence: s.confidence, strategies: s.strategies,
    // v463 — capture WHICH strategies fired, not just how many, plus the
    // conditions at entry. Without these the record can say a setup lost but
    // never which part of the system produced it, so nothing can be held
    // responsible and nothing can be learned. This is the difference between
    // keeping score and actually evaluating.
    namedStrategies: Array.isArray(s.namedStrategies) ? s.namedStrategies : [],
    comboKey: s.comboKey || null,
    // v465 — how many genuinely different kinds of evidence agreed, as
    // opposed to how many indicators restated the same one.
    independentFamilies: typeof s.independentFamilies === 'number' ? s.independentFamilies : null,
    dominantFamily: s.dominantFamily || null,
    adx: typeof s.adx === 'number' ? s.adx : null,
    regime: s.regime && s.regime.label ? s.regime.label : null,
    htfAlignment: s.htfStudy && s.htfStudy.alignment ? s.htfStudy.alignment : null,
    inKillzone: s.inKillzone === true,
    firedAt: new Date(latest.ts || Date.now()).toISOString(),
    status: 'open',
  });
  known.add(key);
  added++;
}

// Keep the book bounded — 400 setups is far more history than the UI shows.
if (book.length > 400) book.splice(0, book.length - 400);

// ── Re-walk every setup that is still open ────────────────────────────────
const pairs = [...new Set(book.filter(s => s.status === 'open').map(s => s.pair))];
const barsByPair = {};
await Promise.all(pairs.map(async p => {
  const sym = PAIR_SYMBOLS[p];
  if (!sym) return;
  try { barsByPair[p] = await fetchBars(sym); } catch (e) { console.error(`  bars ${p}: ${e.message}`); }
}));

let resolvedNow = 0;
for (const s of book) {
  if (s.status !== 'open') continue;
  const bars = barsByPair[s.pair];
  const firedMs = Date.parse(s.firedAt);
  if (!bars || !Number.isFinite(firedMs)) continue;
  const after = bars.filter(b => b.t > firedMs);
  if (!after.length) continue;
  const r = walk(s, after);
  if (!r) continue;
  s.tpReached = r.tpReached;
  s.maeR = Math.round(r.maeR * 100) / 100;
  s.mfeR = Math.round(r.mfeR * 100) / 100;
  s.barsWatched = r.bars;
  s.checkedAt = new Date().toISOString();
  if (r.status !== 'open') {
    s.status = r.status;
    s.resultR = Math.round(r.resultR * 100) / 100;
    s.resolvedAt = new Date().toISOString();
    if (r.closedAtMarket) s.expiryClosedAtMarket = true;
    resolvedNow++;
  }
}

// ── Summarise in the shape the app already reads ──────────────────────────
const open = book.filter(s => s.status === 'open').length;
const wins = book.filter(s => s.status === 'won').length;
const losses = book.filter(s => s.status === 'lost').length;
const expired = book.filter(s => s.status === 'expired').length;
const resolved = wins + losses;
const accounted = book.filter(s => typeof s.resultR === 'number');
const totalR = accounted.reduce((a, s) => a + s.resultR, 0);

const payload = {
  ts: Date.now(),
  isoTime: new Date().toISOString(),
  source: 'offline-watcher',
  tracked: book.length,
  open, wins, losses, expired,
  shadowWinRate: resolved ? (wins / resolved * 100).toFixed(1) + '%' : 'n/a (need resolved signals)',
  accounting: {
    n: accounted.length,
    countedWins: accounted.filter(s => s.resultR > 0).length,
    totalR: Math.round(totalR * 100) / 100,
    expectancyR: accounted.length ? Math.round((totalR / accounted.length) * 1000) / 1000 : null,
    basis: 'managed — a third banked at each target, stop to entry after TP1',
  },
  note: 'Watched by tools/watch-setups.mjs on the GitHub Actions runner. Every '
      + 'run re-walks each setup from the bar it fired on, so a slow cron '
      + 'delays publication but never changes the result.',
  feed: book.slice().reverse().slice(0, 30).map(s => ({
    key: s.key, pair: s.pair, direction: s.direction,
    entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
    confidence: s.confidence, strategies: s.strategies,
    firedAt: s.firedAt, status: s.status,
    resultR: s.resultR ?? null, tpReached: s.tpReached ?? null,
    maeR: s.maeR ?? null, mfeR: s.mfeR ?? null,
    checkedAt: s.checkedAt,
  })),
};

console.log(`watching ${book.length} setup(s): ${open} open, ${wins}W ${losses}L ${expired} expired`);
console.log(`  +${added} new this run, ${resolvedNow} resolved this run`);
if (accounted.length) {
  console.log(`  net ${payload.accounting.totalR >= 0 ? '+' : ''}${payload.accounting.totalR}R `
            + `over ${accounted.length} closed (${payload.accounting.expectancyR}R each)`);
}

if (!DRY) {
  mkdirSync('data', { recursive: true });
  writeFileSync(BOOK, JSON.stringify(book, null, 2));
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`  wrote ${BOOK} and ${OUT}`);
}
