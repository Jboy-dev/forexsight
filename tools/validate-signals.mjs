// v447 — GATEKEEPER FOR THE MIRROR.
//
// The mirror used to write whatever the first responding deployment
// returned. Two deployments answer on this account and one of them,
// forexsight-justice, still runs v365 — roughly eighty versions behind. It
// was the FIRST entry in the base list, so it won every race and the app has
// been showing its output. What that meant in practice, caught live:
//
//   USD/CHF  BUY  entry 0.81  sl 0.81      <- zero risk. Untradeable, and it
//                                             divides by zero in lot sizing.
//   USD/CAD  SELL entry 1.39  tp3 1.39     <- target equal to entry, tier
//                                             "chart-read", which v413 banned
//                                             from the feed as a 71% loser.
//
// Both had prices rounded to two decimals on 5-decimal FX pairs (the v401
// bug, fixed in current code, still live there).
//
// A mirror that copies faithfully is only as good as what it copies. This
// validates the payload before it is allowed to become the fallback: if a
// deployment returns malformed signals, it is treated as unhealthy and the
// caller moves on to the next source, or to the offline generator.
//
//   node tools/validate-signals.mjs <file>   # exit 0 = usable, 1 = reject
//
// Reads the file, prints the reason on rejection.

import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: validate-signals.mjs <file>'); process.exit(1); }

let d;
try { d = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`REJECT: not valid JSON (${e.message})`); process.exit(1); }

const signals = d.signals || [];
const problems = [];

// v413 — tiers that must never reach the user.
const BANNED_TIERS = new Set(['chart-read']);
// v441/v444 — the reward floor the current engine guarantees.
// v458 — matches the measured ladder (TP3 at 1.5R). The old 2.5R floor was
// written for targets that were never actually reached.
// v466 — TP3 is now 2.5R, so the floor rises with it.
// v467 — TP3 is 3.5R; floor raised again.
const MIN_TP3_R = 3.0;

// v466 — THE INVARIANT THAT MATTERS MOST.
//
// Under the managed ladder a third is banked at each target, so a trade that
// reaches all three pays (tp1+tp2+tp3)/3. If that is not greater than 1R, the
// best possible outcome is smaller than a full stop-out and the setup loses
// money at any win rate. The v458 ladder paid +0.900R against -1.000R and was
// served for weeks, so this is checked here as well as in the engine: the
// mirror must never republish a losing geometry from a stale deployment.
const MIN_PERFECT_RUN_R = 1.0;

// v467 — the first target must clear the stop. Taking profit smaller than the
// risk means the first exit can never pay for the loss that follows it, so a
// ladder whose TP1 sits inside the stop is rejected outright.
const MIN_TP1_R = 1.0;

for (const s of signals) {
  const id = `${s.pair} ${s.direction}`;
  const { entry, sl, tp1, tp2, tp3 } = s;

  if (![entry, sl, tp1].every(v => typeof v === 'number' && Number.isFinite(v))) {
    problems.push(`${id}: missing or non-numeric entry/sl/tp1`);
    continue;
  }
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) {
    problems.push(`${id}: entry equals stop (${entry}) — zero risk, untradeable`);
    continue;
  }
  if (BANNED_TIERS.has(String(s.tier || '').toLowerCase())) {
    problems.push(`${id}: tier "${s.tier}" is banned from the feed`);
    continue;
  }
  // Targets must sit on the correct side of entry, and in order.
  const isBuy = s.direction === 'BUY';
  const ordered = [tp1, tp2, tp3].filter(v => typeof v === 'number' && Number.isFinite(v));
  for (const tp of ordered) {
    if (isBuy ? tp <= entry : tp >= entry) {
      problems.push(`${id}: target ${tp} is on the wrong side of entry ${entry}`);
      break;
    }
  }
  if (isBuy ? sl >= entry : sl <= entry) {
    problems.push(`${id}: stop ${sl} is on the wrong side of entry ${entry}`);
    continue;
  }
  if (typeof tp3 === 'number' && Number.isFinite(tp3)) {
    const r = Math.abs(tp3 - entry) / risk;
    if (r < MIN_TP3_R) {
      problems.push(`${id}: tp3 is only ${r.toFixed(2)}R (floor is ${MIN_TP3_R}R)`);
    }
  }
  {
    const r1 = Math.abs(tp1 - entry) / risk;
    if (!(r1 > MIN_TP1_R)) {
      problems.push(`${id}: tp1 is ${r1.toFixed(2)}R — it must exceed the stop (${MIN_TP1_R}R), `
        + `otherwise the first target banks less than the trade risks`);
    }
  }
  if ([tp1, tp2, tp3].every(v => typeof v === 'number' && Number.isFinite(v))) {
    const perfect = (Math.abs(tp1 - entry) + Math.abs(tp2 - entry) + Math.abs(tp3 - entry)) / (3 * risk);
    if (perfect <= MIN_PERFECT_RUN_R) {
      problems.push(`${id}: a perfect run pays only ${perfect.toFixed(3)}R against a -1.000R loss `
        + `— the best outcome is smaller than the worst, so this cannot win at any strike rate`);
    }
  }
}

if (problems.length) {
  console.error(`REJECT: ${problems.length} malformed signal(s) of ${signals.length}`);
  for (const p of problems.slice(0, 8)) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`OK: ${signals.length} signal(s) passed validation`);
process.exit(0);
