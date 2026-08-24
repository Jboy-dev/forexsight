import { readFileSync, writeFileSync } from 'fs';
// v482 — NEWS AS AN INPUT, NOT AN ORNAMENT.
//
// The app has had /api/calendar since v300 and it returns real data — Forex
// Factory's weekly feed, with country, impact, forecast and previous. The
// engine never once consulted it. `check-signals.js` contains no reference to
// a calendar, and `tools/generate-signals.mjs` had none either, which matters
// more because the offline generator produces every signal whenever Cloudflare
// Functions are down.
//
// So signals could fire straight into a rate decision or a CPI print with
// nothing checking. That is not a subtle modelling gap; it is the single most
// predictable source of a stop being taken out by a move that had nothing to
// do with the setup.
//
// The rule here is arithmetic, not opinion: a scheduled high-impact release
// for a currency in the pair, at a known time, inside a known window. No
// forecasting of what the number will be or which way price will go — only
// that a violent repricing is scheduled and a stop placed on chart structure
// does not account for it.
//
//   within BLOCK_MIN of the release   -> refuse the signal
//   within WARN_MIN                   -> publish, labelled with the event
//
// Windows are deliberately conservative and symmetric. The release is the
// hazard; the minutes after it are usually worse than the minutes before.
const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const BLOCK_MIN = 30;
const WARN_MIN = 120;

// Which currencies a pair is exposed to. Metals and crypto price in dollars,
// so a USD release moves them whatever else is happening.
export function currenciesFor(pair) {
  const p = String(pair || '');
  if (!p.includes('/')) return [];
  const [base, quote] = p.split('/');
  const out = new Set();
  if (['XAU', 'XAG'].includes(base)) { out.add('USD'); }
  else if (['BTC', 'ETH', 'SOL'].includes(base)) { out.add('USD'); }
  else out.add(base);
  out.add(quote);
  return [...out];
}

// The feed is not reliable — it answered, then failed three times in a row
// minutes later. A calendar that is missing exactly when it is needed is worse
// than none, because the gate would fall back to "unknown" on every run and
// stop protecting anything. So a good fetch is written to disk and reused when
// the network fails. Events are dated, so a cached copy stays correct until the
// week rolls over; it is refused once it is older than that.
const CACHE = 'data/calendar-cache.json';
const CACHE_MAX_AGE_H = 24 * 8;

function readCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    if (!c || !Array.isArray(c.events)) return null;
    if ((Date.now() - (c.ts || 0)) / 3600000 > CACHE_MAX_AGE_H) return null;
    return c.events;
  } catch { return null; }
}

export async function fetchHighImpact() {
  const live = await fetchLive();
  if (live) {
    try { writeFileSync(CACHE, JSON.stringify({ ts: Date.now(), events: live }, null, 2)); } catch {}
    return live;
  }
  const cached = readCache();
  if (cached) return cached;
  return null;
}

// Two independent routes to the same calendar. The upstream feed refuses
// connections intermittently — it answered with 66 events, then failed three
// times a minute later — so the app's own /api/calendar is tried as well. That
// endpoint reads the same source but keeps its own edge cache, which means it
// frequently answers when the origin will not.
const SOURCES = [
  { name: 'faireconomy', url: FEED, pick: (j) => Array.isArray(j) ? j : null },
  { name: 'app-calendar', url: 'https://forexsight-preview.pages.dev/api/calendar',
    pick: (j) => Array.isArray(j?.events) ? j.events : null },
];

async function fetchLive() {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const src of SOURCES) {
      try {
        const r = await fetch(src.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 ForexSight/1.0', accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) continue;
        const raw = src.pick(await r.json());
        if (!Array.isArray(raw) || !raw.length) continue;
        const parsed = parse(raw);
        if (parsed.length) return parsed;
      } catch { /* next source */ }
    }
    await sleep(1500);
  }
  return null;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parse(all) {
  return all
      .filter(e => String(e.impact || '').toLowerCase() === 'high')
      .map(e => ({
        title: e.title, country: e.country,
        at: Date.parse(e.date),
        forecast: e.forecast || null, previous: e.previous || null,
      }))
      .filter(e => Number.isFinite(e.at));
}

// Returns { verdict: 'block'|'warn'|'clear', events: [...] } for one signal.
export function assess(pair, events, now = Date.now()) {
  if (!Array.isArray(events)) {
    // No feed is NOT the same as no events. Say so rather than treating an
    // outage as an all-clear, which is how a silent failure becomes a loss.
    return { verdict: 'unknown', events: [], note: 'calendar unavailable this run — news risk not checked' };
  }
  const ccys = currenciesFor(pair);
  const relevant = events
    .filter(e => ccys.includes(e.country))
    .map(e => ({ ...e, minutesAway: Math.round((e.at - now) / 60000) }))
    .filter(e => Math.abs(e.minutesAway) <= WARN_MIN)
    .sort((a, b) => Math.abs(a.minutesAway) - Math.abs(b.minutesAway));
  if (!relevant.length) return { verdict: 'clear', events: [] };
  const nearest = relevant[0];
  const verdict = Math.abs(nearest.minutesAway) <= BLOCK_MIN ? 'block' : 'warn';
  return {
    verdict, events: relevant,
    note: verdict === 'block'
      ? `${nearest.country} ${nearest.title} ${nearest.minutesAway >= 0
          ? `in ${nearest.minutesAway} min` : `${-nearest.minutesAway} min ago`}`
        + ` — high-impact release inside ${BLOCK_MIN} minutes, so this setup is not published`
      : `${nearest.country} ${nearest.title} ${nearest.minutesAway >= 0
          ? `in ${nearest.minutesAway} min` : `${-nearest.minutesAway} min ago`}`
        + ` — a scheduled high-impact release can move price further than this stop allows`,
  };
}

export const WINDOWS = { BLOCK_MIN, WARN_MIN };
