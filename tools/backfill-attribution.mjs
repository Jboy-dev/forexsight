// v464 — RECOVER ATTRIBUTION THAT WAS ALREADY PAID FOR.
//
// v463 fixed the watcher so new setups record WHICH strategies fired, not just
// how many. But that only helps going forward, and at a few setups a day the
// evaluator would have been blind for weeks before it could say anything about
// any individual strategy.
//
// It does not have to wait. Every mirrored snapshot of data/latest-signals.json
// is in git history, and the engine has emitted namedStrategies since v441. The
// information was captured all along — the watcher simply dropped it on the way
// into the book. This walks the history, rebuilds the watcher's own key from
// each snapshot's timestamp, and restores the fields onto setups already
// resolved.
//
// It only ever fills blanks: an existing value is never overwritten, so running
// this twice changes nothing the second time and it can never disagree with
// what the watcher recorded live.
//
//   node tools/backfill-attribution.mjs [--dry]
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

// Mirror of STRATEGY_FAMILY in check-signals.js. Kept here so history can be
// re-scored without importing the Worker bundle.
const FAMILY = {
  TREND:'moving-average', MOMENTUM:'moving-average', MACD:'moving-average',
  VWAP:'moving-average', ICHIMOKU:'moving-average', BOLLINGER:'moving-average',
  ICT:'structure', SMC:'structure', ORDER_BLOCK:'structure', SR:'structure',
  FIB:'structure', BREAKOUT_RETEST:'structure', TURTLE_SOUP:'structure',
  THREE_BAR:'candle-pattern', WYCKOFF:'candle-pattern', ORB:'candle-pattern',
  SILVER_BULLET:'candle-pattern', DIVERGENCE:'divergence',
};
const _families = (n) => new Set((n || []).map(x => FAMILY[x] || 'other'));
function _dominant(n) {
  const c = {};
  for (const x of (n || [])) { const f = FAMILY[x] || 'other'; c[f] = (c[f] || 0) + 1; }
  return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || null;
}

const DRY = process.argv.includes('--dry');
const BOOK = 'data/open-setups.json';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const revs = git('log', '--format=%H', '--follow', '--', 'data/latest-signals.json')
  .trim().split('\n').filter(Boolean);

// key -> recovered fields. Oldest revisions are visited last and do not
// overwrite, so the FIRST snapshot that carried a setup wins — that is the
// publication the watcher would have seen.
const found = new Map();
let scanned = 0;

for (const h of revs) {
  let d;
  try { d = JSON.parse(git('show', `${h}:data/latest-signals.json`)); }
  catch { continue; }
  scanned++;
  const hourStamp = new Date(d.ts || 0).toISOString().slice(0, 13);
  for (const s of (d.signals || [])) {
    if (!s.pair || !s.direction) continue;
    if (!Array.isArray(s.namedStrategies) || !s.namedStrategies.length) continue;
    const key = `${s.pair}_${s.direction}_${hourStamp}`;
    found.set(key, {
      namedStrategies: s.namedStrategies.slice(),
      comboKey: s.comboKey || `${s.direction}_${s.namedStrategies.slice().sort().join('+')}`,
      adx: typeof s.adx === 'number' ? s.adx : null,
      regime: s.regime && s.regime.label ? s.regime.label : null,
      htfAlignment: s.htfStudy && s.htfStudy.alignment ? s.htfStudy.alignment : null,
      inKillzone: s.inKillzone === true,
      // v465 — older snapshots predate the independence fields, so derive
      // them from the strategy names the same way the engine now does.
      independentFamilies: typeof s.independentFamilies === 'number'
        ? s.independentFamilies : _families(s.namedStrategies).size,
      dominantFamily: s.dominantFamily || _dominant(s.namedStrategies),
    });
  }
}

const book = JSON.parse(readFileSync(BOOK, 'utf8'));
let filled = 0, alreadyHad = 0, noMatch = 0, derived = 0;

for (const x of book) {
  if (Array.isArray(x.namedStrategies) && x.namedStrategies.length) {
    alreadyHad++;
    // v465 — a record restored by an earlier run has names but predates the
    // independence fields. Derive them here rather than leaving the newest
    // measurement blank on exactly the setups that already have attribution.
    if (x.independentFamilies == null) {
      x.independentFamilies = _families(x.namedStrategies).size;
      x.dominantFamily = x.dominantFamily || _dominant(x.namedStrategies);
      derived++;
    }
    continue;
  }
  const rec = found.get(x.key);
  if (!rec) { noMatch++; continue; }
  // Fill blanks only — never contradict what was recorded live.
  for (const [k, v] of Object.entries(rec)) {
    if (x[k] == null || (Array.isArray(x[k]) && !x[k].length)) x[k] = v;
  }
  x.attributionBackfilled = true;
  filled++;
}

console.log(`scanned ${scanned} snapshot(s), recovered ${found.size} attributed publication(s)`);
console.log(`book: ${book.length} setups`);
console.log(`  ${filled} backfilled`);
console.log(`  ${alreadyHad} already had names (${derived} gained independence scoring)`);
console.log(`  ${noMatch} no matching snapshot (published before v441, or by a deployment that did not emit names)`);

if (DRY) { console.log('\n--dry: nothing written'); process.exit(0); }
writeFileSync(BOOK, JSON.stringify(book, null, 2));
console.log(`\nwrote ${BOOK}`);
