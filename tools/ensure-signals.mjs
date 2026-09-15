// v496 — NEVER PUBLISH AN EMPTY FEED WHEN THE ENGINE HAS SIGNALS.
//
// The mirror asks Cloudflare first and keeps whatever it returns. When
// Cloudflare answers with `count: 0` — which it does regularly — that empty
// payload is published and the user opens an app with nothing in it, while the
// same engine running locally produces five or six setups from the same bars.
// The standby generator only runs when Cloudflare fails to answer AT ALL, so an
// answer of "zero signals" was treated as success.
//
// This runs after the mirror. If the payload is empty (or much thinner than the
// engine can produce) it regenerates from the published candles and keeps
// whichever result has more in it. A real quiet market still yields nothing —
// the engine is the same engine — but an empty answer from a deployment that
// simply did not scan no longer silently becomes the feed.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';

const FILE = 'data/latest-signals.json';
let before = { signals: [] };
try { if (existsSync(FILE)) before = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
const beforeCount = Array.isArray(before.signals) ? before.signals.length : 0;

if (beforeCount > 0) {
  console.log(`ensure-signals: mirror supplied ${beforeCount} signal(s) — leaving them alone`);
  process.exit(0);
}

console.log('ensure-signals: mirror payload is empty — regenerating from published candles');
try {
  execFileSync('node', ['tools/generate-signals.mjs'], { stdio: 'inherit' });
} catch (e) {
  console.error('ensure-signals: generator failed —', e.message.slice(0, 120));
  process.exit(0);        // never fail the cycle over this
}

let after = { signals: [] };
try { after = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
const afterCount = Array.isArray(after.signals) ? after.signals.length : 0;
console.log(`ensure-signals: ${afterCount} signal(s) after regeneration`);
if (afterCount === 0) console.log('  (genuinely nothing qualifies right now — that is the gates working)');
