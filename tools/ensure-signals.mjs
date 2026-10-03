// NEVER PUBLISH AN EMPTY FEED WHEN A BETTER ONE EXISTS — AND NEVER GO BACKWARDS.
//
// The mirror asks Cloudflare first and writes whatever it returns straight over
// data/latest-signals.json. When Cloudflare answers `count: 0` — which it does
// regularly, and does all weekend — that empty payload destroys the committed
// feed before anything else gets a say.
//
// v604 — the fix that matters. The previous version fell back only to
// latest-signals.prev.json, so after the mirror had clobbered a newer committed
// feed the best it could do was restore an OLD snapshot. Measured on 2026-10-03:
//
//   my commit 21:05   ts 21:05   regime.adx [10, 14]
//   mirror    21:07   ts 14:44   regime.adx [0, 0]     <- went backwards 7h
//   watch     21:09   ts 21:09   regime.adx [10, 14]
//   mirror    21:39   ts 14:44   regime.adx [0, 0]     <- went backwards again
//
// The feed was oscillating between a fresh one and a seven-hour-old one, and the
// stale copy kept winning. Anything fixed in the engine was being reverted on
// screen within minutes of being published.
//
// So all candidates are now gathered and ranked by one rule, the same rule the
// front end applies: A FEED WITH SIGNALS BEATS AN EMPTY ONE; AMONG THOSE, THE
// NEWEST ts WINS. The committed version at git HEAD is included as a candidate,
// because that is the one the mirror just overwrote.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const FILE = 'data/latest-signals.json';
const PREV = 'data/latest-signals.prev.json';
const KEEP_HOURS = 12;

const read = (label, fn) => {
  try {
    const d = fn();
    if (!d || typeof d !== 'object') return null;
    const n = Array.isArray(d.signals) ? d.signals.length : 0;
    return { label, data: d, count: n, ts: Number(d.ts) || 0 };
  } catch (_) { return null; }
};

const candidates = [
  read('mirror payload', () => JSON.parse(readFileSync(FILE, 'utf8'))),
  read('previous snapshot', () => JSON.parse(readFileSync(PREV, 'utf8'))),
  // What was committed before this run overwrote it.
  read('committed at HEAD', () => JSON.parse(
    execFileSync('git', ['show', `HEAD:${FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))),
].filter(Boolean);

const ageH = (c) => (Date.now() - c.ts) / 3600000;

// Only candidates that are actually usable: they have signals and are recent
// enough to act on. A stale feed is not a safety net, it is a lie about now.
const usable = candidates.filter(c => c.count > 0 && ageH(c) < KEEP_HOURS);

// THE RULE: signals beat empty, then newest wins.
usable.sort((a, b) => (b.count > 0) - (a.count > 0) || b.ts - a.ts);

for (const c of candidates) {
  console.log(`ensure-signals:   ${c.label.padEnd(18)} ${String(c.count).padStart(2)} signal(s), ${ageH(c).toFixed(1)}h old${usable.includes(c) ? '' : '  (not usable)'}`);
}

const current = candidates.find(c => c.label === 'mirror payload');
const best = usable[0] || null;

if (best) {
  if (current && current.ts === best.ts && current.count === best.count) {
    console.log(`ensure-signals: the mirror payload is already the best available (${best.count} signal(s), ${ageH(best).toFixed(1)}h old)`);
  } else {
    writeFileSync(FILE, JSON.stringify(best.data, null, 2));
    console.log(`ensure-signals: published "${best.label}" — ${best.count} signal(s), ${ageH(best).toFixed(1)}h old`);
    if (current && best.ts < current.ts) {
      console.log('  NOTE: that is older than the payload it replaced, but the payload had no signals.');
    }
  }
} else {
  console.log('ensure-signals: no usable candidate — regenerating from published candles');
  try {
    execFileSync('node', ['tools/generate-signals.mjs'], { stdio: 'inherit' });
  } catch (e) {
    console.error('ensure-signals: generator failed —', e.message.slice(0, 120));
    process.exit(0);                       // never fail the cycle over this
  }
  let after = { signals: [] };
  try { after = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
  const n = Array.isArray(after.signals) ? after.signals.length : 0;
  console.log(`ensure-signals: ${n} signal(s) after regeneration`);
  if (n === 0) console.log('  (genuinely nothing qualifies right now — that is the gates working)');
}

// Snapshot the newest NON-EMPTY feed so the fallback above stays current. The
// old version snapshotted unconditionally, which is how a stale copy survived
// long enough to keep winning.
try {
  const now = JSON.parse(readFileSync(FILE, 'utf8'));
  if (Array.isArray(now.signals) && now.signals.length > 0) {
    let prevTs = 0;
    try { prevTs = Number(JSON.parse(readFileSync(PREV, 'utf8')).ts) || 0; } catch {}
    if ((Number(now.ts) || 0) >= prevTs) writeFileSync(PREV, JSON.stringify(now));
  }
} catch { /* nothing to snapshot */ }
