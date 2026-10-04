#!/usr/bin/env node
/**
 * push-new-signals.mjs — actually send the notification.
 *
 * The push infrastructure existed in full — VAPID key, subscribe endpoint, a
 * fire endpoint, and a push handler in the service worker — and NOTHING EVER
 * CALLED IT. Subscribers were registered and then never pushed to, so alerts
 * could not reach a closed app no matter what the user turned on.
 *
 * Runs after the feed is published. Sends one notification per genuinely NEW
 * signal, remembering what has already been sent so a republication of the same
 * setup does not buzz the phone again every cycle.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const ENDPOINT = process.env.PUSH_ENDPOINT || 'https://forexsight-preview.pages.dev/api/push-fire';
const SEEN = 'data/push-sent.json';

const feed = (() => {
  try { return JSON.parse(readFileSync('data/latest-signals.json', 'utf8')); } catch { return null; }
})();
if (!feed || !Array.isArray(feed.signals)) { console.log('push: no feed to read'); process.exit(0); }

let sent = [];
try { sent = JSON.parse(readFileSync(SEEN, 'utf8')); } catch {}
if (!Array.isArray(sent)) sent = [];
const seen = new Set(sent);

const key = (s) => [s.pair, s.direction, s.detectedAt || '', s.entry].join('|');
const fresh = feed.signals.filter(s => !seen.has(key(s)));

if (!fresh.length) {
  console.log(`push: ${feed.signals.length} signal(s) in the feed, none new since the last run`);
  process.exit(0);
}

const dp = (p) => /JPY/.test(p) ? 3 : /XAU|XAG|BTC|ETH|SOL|XRP|US30|NAS/.test(p) ? 2 : 5;

let ok = 0, failed = 0;
for (const s of fresh.slice(0, 3)) {          // never more than three at once
  const risk = Math.abs(s.entry - s.sl);
  const r1 = risk > 0 ? (Math.abs(s.tp1 - s.entry) / risk).toFixed(2) : '?';
  const body = [
    `Entry ${s.entry.toFixed(dp(s.pair))}`,
    `Stop ${s.sl.toFixed(dp(s.pair))}`,
    `TP1 ${s.tp1.toFixed(dp(s.pair))} (${r1}R)`,
  ].join(' · ');

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${s.pair} ${String(s.direction).toUpperCase()}`,
        body,
        tag: key(s),
        direction: String(s.direction).toUpperCase(),
        data: { url: '/', pair: s.pair, direction: s.direction },
      }),
    });
    const txt = await res.text();
    if (res.ok) { ok++; console.log(`  sent ${s.pair} ${s.direction} — ${txt.slice(0, 90)}`); }
    else { failed++; console.log(`  FAILED ${s.pair}: HTTP ${res.status} ${txt.slice(0, 90)}`); }
  } catch (e) { failed++; console.log(`  FAILED ${s.pair}: ${e.message}`); }
  seen.add(key(s));
}

// Keep the memory bounded; a few hundred keys is ample.
writeFileSync(SEEN, JSON.stringify([...seen].slice(-400)));
console.log(`push: ${ok} sent, ${failed} failed, ${fresh.length} new signal(s) seen`);
