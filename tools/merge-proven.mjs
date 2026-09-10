// v491 — THE PROVEN STRATEGIES ONLY RAN WHEN CLOUDFLARE WAS BROKEN.
//
// They live in tools/generate-signals.mjs, and the mirror workflow runs that
// only when no deployment returns valid signals (SIGNALS_STALE=1). Cloudflare
// has been up, so the mirror took its output — `source: live-analysis`, zero
// proven strategies, and on this cycle zero signals of any kind — and the
// backtested rules never executed. The one part of this system with measured
// out-of-sample evidence behind it was reachable only while the rest was down.
//
// This runs unconditionally and MERGES. Whatever the mirror obtained is kept
// exactly as it is; proven-strategy signals are appended alongside, and only
// for strategies that currently clear the control test. Nothing overwrites the
// engine's output, so a healthy Cloudflare deployment loses nothing.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { evaluate as evaluateProven } from './proven-strategies.mjs';

const FILE = 'data/latest-signals.json';
let payload = { ts: Date.now(), isoTime: new Date().toISOString(), count: 0, signals: [] };
try { if (existsSync(FILE)) payload = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
if (!Array.isArray(payload.signals)) payload.signals = [];

function atr14(bars) {
  let a = null, s = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
    if (i <= 14) { s += tr; a = i === 14 ? s / 14 : null; } else a = (a * 13 + tr) / 14;
  }
  return a;
}

const added = [];
for (const f of readdirSync('data/ohlc').filter(x => x.endsWith('.json'))) {
  const pair = f.replace('.json', '').replace('-', '/');
  let bars;
  try {
    const raw = JSON.parse(readFileSync(`data/ohlc/${f}`, 'utf8'));
    bars = Array.isArray(raw) ? raw : (raw.bars || raw.ohlc || []);
  } catch { continue; }
  if (bars.length < 250) continue;
  const n = bars.length - 1;
  const ageMin = (Date.now() - bars[n].t) / 60000;
  if (ageMin > 240) continue;                 // same staleness rule as the engine
  const hits = evaluateProven(bars);          // already gated on the control
  if (!hits.length) continue;
  const a = atr14(bars);
  if (!a || !(a > 0)) continue;
  const entry = bars[n].c, slD = a * 1.75, r5 = v => Math.round(v * 1e5) / 1e5;
  for (const h of hits) {
    // Never duplicate a setup the engine already published on this pair+side.
    if (payload.signals.some(s => s.pair === pair && s.direction === h.direction && s.provenStrategy === h.strategy)) continue;
    const buy = h.direction === 'BUY';
    added.push({
      pair, direction: h.direction,
      entry: r5(entry),
      sl: r5(buy ? entry - slD : entry + slD),
      tp1: r5(buy ? entry + slD * 1.2 : entry - slD * 1.2),
      tp2: r5(buy ? entry + slD * 2.0 : entry - slD * 2.0),
      tp3: r5(buy ? entry + slD * 3.5 : entry - slD * 3.5),
      source: 'proven-strategy',
      provenStrategy: h.strategy,
      provenEvidence: h.evidence,
      control: h.control,
      namedStrategies: [h.strategy],
      comboKey: `${h.direction}_${h.strategy}`,
      strategies: 1,
      confidence: null,        // deliberately absent — that score measured inverted
      tier: 'proven',
      atrV: a,
      barAgeMinutes: Math.round(ageMin),
    });
  }
}

if (added.length) {
  payload.signals.push(...added);
  payload.count = payload.signals.length;
  payload.provenAdded = added.length;
  writeFileSync(FILE, JSON.stringify(payload, null, 2));
}
console.log(`proven merge: ${added.length} signal(s) added to ${payload.signals.length - added.length} existing`
  + (added.length ? ` — ${[...new Set(added.map(a => a.provenStrategy))].join(', ')}` : ''));
