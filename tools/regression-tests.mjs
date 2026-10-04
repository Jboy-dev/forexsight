#!/usr/bin/env node
/**
 * regression-tests.mjs — one test per bug that has actually shipped here.
 *
 * The rule each test obeys: it must FAIL if the fix is reverted. A test that
 * passes either way proves nothing and is worse than no test, because it buys
 * false confidence. Where a test could pass for the wrong reason, it asserts
 * the specific wrong value the bug produced, not merely "something sensible".
 */
import { readFileSync, readdirSync, existsSync } from 'fs';

let pass = 0, fail = 0, skip = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${name}`); pass++; }
    // A test that cannot run is not a test that failed. data/deep is gitignored,
    // so the regime tests legitimately have nothing to read on a fresh checkout;
    // counting that as a failure would block every publish for the wrong reason.
    else if (typeof r === 'string' && r.startsWith('skipped:')) { console.log(`  SKIP  ${name} (${r.slice(8).trim()})`); skip++; }
    else { console.log(`  FAIL  ${name}\n        ${r}`); fail++; }
  } catch (e) { console.log(`  FAIL  ${name}\n        threw: ${e.message}`); fail++; }
};

const src = readFileSync('functions/api/check-signals.js', 'utf8');
const grab = (n) => { const i = src.indexOf(`function ${n}(`); const r = src.slice(i); return r.slice(0, r.indexOf('\n}\n') + 3); };

console.log('\nregression tests\n');

/* ── BUG: adx() returns {adx:[...]}, but _detectRegime read adxSer[n], which is
   undefined on an object, so `|| 0` pinned the value at 0 forever. TRENDING
   (adx >= 30) was unreachable for the engine's whole life. ───────────────── */
t('regime detector reads a real ADX, not a stand-in zero', () => {
  if (!existsSync('data/deep')) return 'skipped: needs data/deep';
  const fn = new Function(grab('adx') + grab('_detectRegime') + '; return _detectRegime;')();
  const bars = JSON.parse(readFileSync('data/deep/EUR-USD.json', 'utf8')).slice(-300);
  const r = fn(bars);
  if (r.adx === 0) return 'adx came back exactly 0 — the object/array read has been reverted';
  if (r.adx == null) return 'adx is null on bars where it is computable';
  if (!(r.adx > 5)) return `adx ${r.adx} is implausibly low for real bars`;
  return true;
});

t('TRENDING is reachable across the instrument set', () => {
  if (!existsSync('data/deep')) return 'skipped: needs data/deep';
  const fn = new Function(grab('adx') + grab('_detectRegime') + '; return _detectRegime;')();
  const regimes = readdirSync('data/deep').filter(f => f.endsWith('.json')).map(f => {
    try { return fn(JSON.parse(readFileSync(`data/deep/${f}`, 'utf8')).slice(-300)).regime; } catch { return null; }
  }).filter(Boolean);
  const distinct = new Set(regimes);
  // Asserting "at least two labels" is NOT enough: with adx pinned at 0 the
  // atrRatio and compression branches still produce several labels, so that
  // weaker assertion passed with the bug in place and proved nothing. TRENDING
  // is the branch that adx >= 30 made unreachable, so TRENDING is what this
  // test has to demand.
  if (!distinct.has('TRENDING')) {
    return `no instrument classified TRENDING across ${regimes.length} markets (saw: ${[...distinct].join(', ')})`
         + ' — the adx >= 30 branch is unreachable again';
  }
  if (distinct.size < 2) return `only one regime label across ${regimes.length} instruments`;
  return true;
});

t('an uncomputable ADX yields unknown, never a quiet-regime label', () => {
  const fn = new Function(grab('adx') + grab('_detectRegime') + '; return _detectRegime;')();
  // 80 bars of exactly flat price: ADX is genuinely undefined (no directional movement)
  const flat = Array.from({ length: 80 }, (_, i) => ({ t: i * 864e5, o: 1, h: 1, l: 1, c: 1 }));
  const r = fn(flat);
  if (r.regime !== 'unknown' && r.adx === 0) return 'a missing ADX was reported as 0 and classified anyway';
  return true;
});

/* ── BUG: the calendar feed publishes the current week only. Once its last
   high-impact event passed, assess() returned a confident 'clear' — every
   Friday through Sunday the gate silently protected nothing. ─────────────── */
const news = await import('../tools/news-gate.mjs');
t('news gate: expired feed -> uncovered', () => {
  const now = Date.now();
  const r = news.assess('EUR/USD', [{ title: 'NFP', country: 'USD', at: now - 30 * 36e5 }], now);
  if (r.verdict === 'clear') return "returned 'clear' with no forward visibility — the fix is reverted";
  if (r.verdict !== 'uncovered') return `expected 'uncovered', got '${r.verdict}'`;
  return true;
});
t('news gate: a genuinely covered quiet period still reads clear', () => {
  const now = Date.now();
  const r = news.assess('EUR/USD', [{ title: 'CPI', country: 'USD', at: now + 8 * 36e5 }], now);
  return r.verdict === 'clear' ? true : `expected 'clear', got '${r.verdict}' — the fix is over-firing`;
});
t('news gate: an event inside the window still blocks', () => {
  const now = Date.now();
  const r = news.assess('EUR/USD', [{ title: 'Rate Decision', country: 'USD', at: now + 12 * 6e4 }], now);
  return r.verdict === 'block' ? true : `expected 'block', got '${r.verdict}'`;
});
t('news gate: a feed outage stays unknown, not uncovered', () => {
  const r = news.assess('EUR/USD', null, Date.now());
  return r.verdict === 'unknown' ? true : `expected 'unknown', got '${r.verdict}'`;
});

/* ── BUG: the ladder once paid +0.900R on a full run against -1.000R risked. ── */
t('ladder geometry: a full run pays more than a full stop-out', () => {
  const m = src.match(/const tp1Dist = slDist \* ([\d.]+)[\s\S]{0,200}?const tp2Dist = slDist \* ([\d.]+)[\s\S]{0,200}?const tp3Dist = slDist \* ([\d.]+)/);
  if (!m) return 'could not find the ladder constants in check-signals.js';
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  const perfect = (a + b + c) / 3;
  if (!(a > 1)) return `TP1 is ${a}R, which is not larger than the 1R stop`;
  if (!(perfect > 1)) return `a full run pays ${perfect.toFixed(3)}R against 1.000R risked`;
  return true;
});

/* ── BUG: candidate-tracker threw ENOENT on gitignored data/deep and took the
   whole scheduled workflow down, recording nothing for weeks. ───────────── */
t('candidate tracker guards a missing data/deep', () => {
  const s = readFileSync('tools/candidate-tracker.mjs', 'utf8');
  return /existsSync\('data\/deep'\)/.test(s) ? true
    : 'no existsSync guard before readdirSync — it will crash the workflow again';
});

/* ── The market-voice validator must be able to detect a real signal, or its
   "none of these predict" verdicts are worthless. ───────────────────────── */
t('market-voice validator detects a leaked future', () => {
  const FWD = 5;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const f = (x, y) => { const n = x.length, mx = mean(x), my = mean(y), sx = sd(x), sy = sd(y);
    let c = 0; for (let i = 0; i < n; i++) c += (x[i] - mx) * (y[i] - my);
    const r = (c / (n - 1)) / (sx * sy), nEff = n / FWD;
    return r * Math.sqrt(Math.max(nEff - 2, 1) / Math.max(1e-9, 1 - r * r)); };
  const y = Array.from({ length: 3000 }, () => Math.random() - 0.5);
  if (!(Math.abs(f(y, y)) > 2.45)) return 'a perfectly leaked future was not flagged — the validator is blind';
  const noise = Array.from({ length: 3000 }, () => Math.random() - 0.5);
  if (Math.abs(f(noise, y)) > 2.45) return 'pure noise was flagged as predictive — the bar is too loose';
  return true;
});

/* ── The published record must never present an interval that includes zero as
   an established edge. ──────────────────────────────────────────────────── */
t('published record does not claim an unproven edge', () => {
  if (!existsSync('data/learning-brain.json')) return 'skipped: no brain file';
  const b = JSON.parse(readFileSync('data/learning-brain.json', 'utf8'));
  const h = b.headline || b.overall || {};
  if (!Array.isArray(h.ci)) return true;
  const includesZero = h.ci[0] <= 0 && h.ci[1] >= 0;
  if (includesZero && h.proven === true) return 'an interval spanning zero is marked proven';
  return true;
});

/* ── BUG: base II's record printed "387 publications collapsed to 387
   independent moves — a factor of 6.47", because it read headline.samples
   (the per-signal count) as the collapsed count instead of totalSamples (the
   episode count, 59). It also led with the per-signal figure alone, which is
   the inflated one: per signal this book reads +0.074R, collapsed to episodes
   it reads -0.045R. Those disagree in sign. ──────────────────────────────── */
t('record panel reads the episode count, not the per-signal count', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (/collapsed\s*=\s*num\(b\.headline/.test(js)) return 'collapsed count is read from headline — that is the raw per-signal number';
  if (!/collapsed\s*=\s*num\(b\.totalSamples\)/.test(js)) return 'collapsed count is not read from b.totalSamples';
  return true;
});

t('record panel shows the episode measure, not only the per-signal one', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (!/episodeAverage/.test(js)) return 'the episode-collapsed measure is not rendered at all';
  if (!/firstOfEpisode/.test(js)) return 'the first-of-episode measure is not rendered';
  return true;
});

t('inflation arithmetic in the published brain is self-consistent', () => {
  if (!existsSync('data/learning-brain.json')) return 'skipped: no brain file';
  const b = JSON.parse(readFileSync('data/learning-brain.json', 'utf8'));
  const raw = b.rawPublications, ep = b.totalSamples, f = b.inflationFactor;
  if (raw == null || ep == null || f == null) return 'one of rawPublications / totalSamples / inflationFactor is missing';
  const expect = raw / Math.max(1, ep);
  if (Math.abs(expect - f) > 0.05) return `inflationFactor ${f} does not equal ${raw}/${ep} = ${expect.toFixed(2)}`;
  if (raw === ep && f > 1.05) return `raw equals collapsed (${raw}) yet the factor is ${f} — these cannot both be true`;
  return true;
});

/* ── The order layer. These exist because an order system that silently does
   the wrong thing is worse than none: "make me rich" once parsed as an
   instrument filter and blanked the page without saying anything. ──────── */
function loadFS() {
  const code = readFileSync('v2/commands.js', 'utf8');
  const sandbox = { window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
  new Function('window', 'localStorage', code)(sandbox.window, sandbox.localStorage);
  return sandbox.window.FS;
}
const FS = loadFS();
const SIGS = [
  { pair: 'XAU/USD', d: 'BUY',  c: 88, w: false, n: 'clear',     r: 1.4, t: 3 },
  { pair: 'EUR/USD', d: 'SELL', c: 52, w: true,  n: 'uncovered', r: 1.2, t: 4 },
  { pair: 'BTC/USD', d: 'BUY',  c: 97, w: false, n: 'uncovered', r: 1.2, t: 2 },
  { pair: 'GBP/USD', d: 'BUY',  c: 71, w: false, n: 'clear',     r: 1.2, t: 1 },
];
const RD = { pair: s => s.pair, dir: s => s.d, conf: s => s.c, weak: s => s.w,
             news: s => s.n, at: s => s.t, r1: s => s.r };
const after = (order) => { const cfg = { ...FS.DEFAULTS }; const res = FS.run(order, cfg);
  return { res, out: FS.apply(SIGS, cfg, RD).map(x => x.pair) }; };

t('order layer: nonsense is refused, never obeyed into a blank page', () => {
  for (const junk of ['make me rich', 'do something', 'guarantee profit', 'only banana', 'win every trade']) {
    const { res, out } = after(junk);
    if (res.ok) return `"${junk}" was accepted as a real order`;
    if (out.length !== SIGS.length) return `"${junk}" was refused but still filtered the list to ${out.length}`;
  }
  return true;
});

t('order layer: instrument orders filter correctly in every spelling', () => {
  const want = { 'only gold': 'XAU/USD', 'gold': 'XAU/USD', 'eurusd': 'EUR/USD',
                 'eur/usd': 'EUR/USD', 'xauusd': 'XAU/USD', 'btc': 'BTC/USD' };
  for (const [order, pair] of Object.entries(want)) {
    const { res, out } = after(order);
    if (!res.ok) return `"${order}" was refused`;
    if (out.length !== 1 || out[0] !== pair) return `"${order}" gave [${out}], expected [${pair}]`;
  }
  return true;
});

t('order layer: direction, confidence, weak and news orders each bite', () => {
  if (after('only buy').out.length !== 3) return 'only buy did not filter to the three BUYs';
  if (after('only sell').out.length !== 1) return 'only sell did not filter to the one SELL';
  if (after('confidence 70').out.length !== 3) return 'confidence 70 did not drop the 52';
  if (after('hide weak').out.length !== 3) return 'hide weak did not drop the weak one';
  if (after('news strict').out.length !== 2) return 'news strict did not keep only the two clear ones';
  // 'risk' now means account risk percent, which is what a person typing it
  // means. The reward filter was renamed to 'minr' to free the word up.
  if (after('minr 1.3').out.length !== 1) return 'minr 1.3 did not keep only the 1.4R';
  if (after('risk 2%').out.length !== SIGS.length) return 'risk 2% filtered signals — it should only set account risk';
  return true;
});

t('order layer: orders stack and sort rather than replacing each other', () => {
  const cfg = { ...FS.DEFAULTS };
  FS.run('only buy', cfg); FS.run('confidence 70', cfg); FS.run('sort by confidence', cfg);
  const out = FS.apply(SIGS, cfg, RD).map(x => x.pair);
  if (out.length !== 3) return `stacking gave ${out.length}, expected 3`;
  if (out[0] !== 'BTC/USD') return `sort by confidence put ${out[0]} first, expected BTC/USD (97)`;
  if (FS.chips(cfg).length !== 3) return `expected 3 standing-order chips, got ${FS.chips(cfg).length}`;
  return true;
});

t('order layer: reset clears every standing order', () => {
  const cfg = { ...FS.DEFAULTS };
  FS.run('only gold', cfg); FS.run('confidence 90', cfg); FS.run('compact', cfg);
  FS.run('reset', cfg);
  if (FS.chips(cfg).length) return `reset left ${FS.chips(cfg).length} orders in force`;
  if (FS.apply(SIGS, cfg, RD).length !== SIGS.length) return 'reset did not restore the full list';
  return true;
});

t('order layer: every command is self-describing, so help cannot drift', () => {
  for (const c of FS.COMMANDS) {
    if (!c.name || typeof c.run !== 'function') return `command ${c.name || '?'} is malformed`;
    if (!c.help || c.help.length < 4) return `command ${c.name} has no usable help text`;
  }
  return true;
});

/* ── BUG: the published feed was going BACKWARDS in time. The mirror writes
   Cloudflare's payload straight over latest-signals.json; when that payload is
   empty (every weekend) the newer committed feed was already destroyed, and the
   only fallback considered was a snapshot that could be hours older. Measured
   on 2026-10-03 the feed oscillated between 21:05 (fixed ADX) and 14:44 (ADX 0)
   every few minutes, reverting engine fixes on screen minutes after release. ─ */
t('ensure-signals considers the committed feed, not just the old snapshot', () => {
  const src = readFileSync('tools/ensure-signals.mjs', 'utf8');
  if (!/HEAD:\$\{FILE\}|HEAD:.*latest-signals/.test(src)) {
    return 'the committed-at-HEAD candidate is gone — an empty mirror payload can clobber a newer feed again';
  }
  if (!/b\.ts - a\.ts/.test(src)) return 'candidates are no longer ranked newest-first';
  return true;
});

t('ensure-signals never republishes a feed older than the one it replaces, when both have signals', () => {
  const src = readFileSync('tools/ensure-signals.mjs', 'utf8');
  // The usable filter must require signals AND recency; dropping either is how
  // a stale copy wins.
  if (!/c\.count > 0 && ageH\(c\) < KEEP_HOURS/.test(src)) {
    return 'the usability filter no longer requires both signals and recency';
  }
  return true;
});

t('alerts respect the same filters the page shows', () => {
  const cfg = { ...FS.DEFAULTS };
  FS.run('alerts on', cfg);
  if (!cfg.alerts) return 'the alerts order did not take';
  FS.run('only buy', cfg);
  const shown = FS.apply(SIGS, cfg, RD).map(x => x.pair);
  if (shown.length !== 3) return 'alerts path does not reuse the same filter as the page';
  FS.run('alerts off', cfg);
  if (cfg.alerts) return 'alerts off did not take';
  return true;
});

t('tap-to-copy is bound on document, not on cards that get replaced', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (!/document\.addEventListener\('click'/.test(js)) return 'copy is not delegated from document';
  if (/\.lvl\.copyable'\)\.forEach\(.*addEventListener/.test(js)) {
    return 'listeners are attached per-card — renderCards replaces innerHTML, so they die every cycle';
  }
  if (!/_fsCopyInstalled/.test(js)) return 'no install guard — listeners would stack on every render';
  return true;
});

t('every level on a card is copyable, entry included', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  for (const k of ["'Entry'", "'Stop'", "'TP1'", "'TP2'", "'TP3'"]) {
    if (!js.includes(`lvl(${k}`)) return `${k} is not rendered as a level, so it cannot be copied`;
  }
  if (!/data-copy=/.test(js)) return 'levels carry no data-copy attribute';
  return true;
});

t('the intraday search excludes session filters, per the artefact finding', () => {
  const src = readFileSync('tools/strategy-trials.mjs', 'utf8');
  if (/'session'|hourOfDay|getUTCHours/.test(src)) {
    return 'a session or hour-of-day filter is present — the triangular control found '
         + 'systematic residual structure at 4 hours, so any such result is a feed artefact';
  }
  return true;
});

t('intraday verification ran and its spread-artefact control is recorded', () => {
  if (!existsSync('data/intraday-verification.json')) return 'skipped: no verification file';
  const v = JSON.parse(readFileSync('data/intraday-verification.json', 'utf8'));
  if (!v.checks || !v.checks.spreadArtefact) return 'the spread-artefact control is missing from the report';
  const a = v.checks.spreadArtefact;
  if (!Array.isArray(a.rows) || a.rows.length !== 24) return 'the hour-of-day residual table is incomplete';
  return true;
});

/* ── Research. The failure mode here is not a crash, it is a confident wrong
   answer — which in a trading tool is worse than no answer at all. ──────── */
function loadKB() {
  const code = readFileSync('v2/knowledge.js', 'utf8');
  const w = { FS: { COMMANDS: [{ help: 'only gold' }] } };
  new Function('window', code)(w);
  return w.FSKB;
}
const KB = loadKB();
const KBS = {
  learningBrain:  existsSync('data/learning-brain.json')  ? JSON.parse(readFileSync('data/learning-brain.json', 'utf8')) : null,
  strategyTrials: existsSync('data/strategy-trials.json') ? JSON.parse(readFileSync('data/strategy-trials.json', 'utf8')) : null,
  activeStrategy: existsSync('data/active-strategy.json') ? JSON.parse(readFileSync('data/active-strategy.json', 'utf8')) : null,
  marketVoice:    existsSync('data/market-voice.json')    ? JSON.parse(readFileSync('data/market-voice.json', 'utf8')) : null,
};

t('research: every topic renders without undefined or NaN leaking out', () => {
  for (const topic of KB.TOPICS) {
    let a;
    try { a = topic.answer(KBS); } catch (e) { return `${topic.id} threw: ${e.message}`; }
    if (!a || typeof a.body !== 'string' || a.body.length < 120) return `${topic.id} produced no usable answer`;
    if (/undefined|NaN|\[object Object\]/.test(a.body)) return `${topic.id} leaked undefined/NaN into the answer`;
    if (!a.source) return `${topic.id} has no source attribution`;
  }
  return true;
});

t('research: off-topic questions return nothing rather than a wrong answer', () => {
  for (const q of ['what is the weather in paris', 'who won the football', 'tell me a joke',
                   'asdfghjkl', 'my cat is ill', 'book me a flight']) {
    const r = KB.search(q);
    if (r.length) return `"${q}" matched ${r[0].id} — a confident answer to a question it cannot answer`;
  }
  return true;
});

t('research: questions route to the right topic', () => {
  const want = {
    'is this website profitable': 'record', 'what is your win rate': 'record',
    'what strategies have you tested': 'strategies', 'explain tp1 tp2 tp3': 'ladder',
    'why is this signal weak': 'weak', 'what is an r multiple': 'r-multiple',
    'why can a 70% win rate lose money': 'expectancy', 'how much should i risk per trade': 'sizing',
    'what is adx': 'atr', 'how do i handle nfp': 'news',
    'why do backtests look better than live': 'overfitting',
  };
  const misses = [];
  for (const [q, id] of Object.entries(want)) {
    const top = KB.search(q)[0];
    if (!top || top.id !== id) misses.push(`"${q}" -> ${top ? top.id : 'none'} (wanted ${id})`);
  }
  return misses.length ? `${misses.length} misrouted: ${misses.join('; ')}` : true;
});

t('research: prediction questions are REFUSED, never answered', () => {
  for (const q of ['will this trade win', 'should i buy gold', 'what should i trade today',
                   'can you guarantee profit', 'will price go up']) {
    const top = KB.search(q)[0];
    if (!top) return `"${q}" matched nothing — it must reach the refusal, not fall through`;
    if (top.kind !== 'refusal') return `"${q}" routed to ${top.id} (${top.kind}) instead of a refusal`;
  }
  return true;
});

t('research: no topic claims a guaranteed or predicted result', () => {
  const banned = /\b(guarantee[ds]?|will win|sure thing|risk[- ]free|100% accurate|cannot lose|always profit)\b/i;
  for (const topic of KB.TOPICS) {
    const a = topic.answer(KBS);
    // The refusal topic quotes these words in order to reject them.
    if (topic.kind === 'refusal') continue;
    if (banned.test(a.body.replace(/<[^>]+>/g, ' '))) return `${topic.id} contains a guarantee-style claim`;
  }
  return true;
});

t('the app icon set is complete, including a separate maskable', () => {
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    if (!existsSync(f)) return `${f} is missing`;
  }
  const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const purposes = (m.icons || []).map(i => i.purpose);
  if (!purposes.includes('maskable')) return 'no maskable icon declared — Android will crop the mark itself';
  if (!purposes.includes('any')) return 'no "any" purpose icon declared';
  // A single icon serving both purposes gets cropped on Android; they must differ.
  const mask = (m.icons || []).find(i => i.purpose === 'maskable');
  const any = (m.icons || []).find(i => i.purpose === 'any' && i.sizes === '512x512');
  if (mask && any && mask.src === any.src) return 'the maskable and standard icons are the same file — the mark will be cropped';
  return true;
});

/* ── Tabs. Pane words and filter words share a namespace, and they collided:
   "open market" matched expand's 'open' alias, "show me the ledger" matched
   only's 'show', and "signals" was being stripped as filler. ───────────── */
t('tabs: pane words route to the pane, not to a filter', () => {
  const want = { 'ledger': 'ledger', 'market': 'market', 'tested': 'tested', 'signals': 'signals',
                 'open market': 'market', 'go to tested': 'tested', 'show me the ledger': 'ledger',
                 'record': 'ledger', 'view trials': 'tested' };
  for (const [order, pane] of Object.entries(want)) {
    const cfg = { ...FS.DEFAULTS };
    const r = FS.run(order, cfg);
    if (!r.ok) return `"${order}" was refused`;
    if (cfg.tab !== pane) return `"${order}" opened ${cfg.tab}, expected ${pane}`;
  }
  return true;
});

t('tabs: filter orders still filter and do not change pane', () => {
  for (const order of ['only gold', 'hide weak', 'confidence 70', 'sort by r', 'expand', 'reset']) {
    const cfg = { ...FS.DEFAULTS };
    const r = FS.run(order, cfg);
    if (!r.ok) return `"${order}" was refused`;
    if (cfg.tab !== 'signals') return `"${order}" changed the pane to ${cfg.tab}`;
  }
  return true;
});

/* ── The ledger. The book used to delete everything beyond 400 outright. ── */
t('the signal book archives instead of deleting history', () => {
  const src = readFileSync('tools/watch-setups.mjs', 'utf8');
  if (/book\.splice\(0, book\.length - 400\)/.test(src)) {
    return 'the plain splice is back — history beyond the newest 400 is being destroyed again';
  }
  if (!/signal-archive\.json/.test(src)) return 'no archive is written before trimming';
  return true;
});

t('the ledger publishes BOTH win-rate definitions', () => {
  if (!existsSync('data/ledger.json')) return 'skipped: ledger not built yet';
  const L = JSON.parse(readFileSync('data/ledger.json', 'utf8'));
  if (!L.winRates || !L.winRates.byOutcome || !L.winRates.byTarget) {
    return 'only one win-rate definition is published — quoting the kinder one alone overstates the hit rate';
  }
  for (const k of ['byOutcome', 'byTarget']) {
    if (typeof L.winRates[k].rate !== 'number') return `${k} has no rate`;
    if (!L.winRates[k].definition) return `${k} has no stated definition`;
  }
  // They genuinely differ on this book; if they ever converge that is fine,
  // but both must still be present.
  if (!L.episodes || typeof L.episodes.inflation !== 'number') {
    return 'the ledger does not collapse episodes — republications would be counted as independent evidence';
  }
  if (!L.risk || typeof L.risk.maxDrawdownR !== 'number' || typeof L.risk.longestLossStreak !== 'number') {
    return 'drawdown and losing-streak figures are missing — a record without them flatters itself';
  }
  return true;
});

/* ── The calculator. Wrong money maths is the worst failure this site can
   have, so these check the arithmetic end to end rather than that it runs. ── */
function loadCALC() {
  const w = {};
  new Function('window', readFileSync('v2/calc.js', 'utf8'))(w);
  return w.FSCALC;
}
const CALC = loadCALC();
const RATES = existsSync('data/fx-rates.json') ? JSON.parse(readFileSync('data/fx-rates.json', 'utf8')) : null;

t('calculator: a stop-out costs EXACTLY the risked amount, in every quote currency', () => {
  if (!RATES) return 'skipped: no fx-rates.json';
  const cfg = { balance: 1000, riskPct: 1, currency: 'GBP' };      // 1R = £10
  const cases = [
    { pair: 'EUR/USD', entry: 1.10000, sl: 1.09800, tp1: 1.10240, tp2: 1.10400, tp3: 1.10700 },
    { pair: 'USD/JPY', entry: 157.00,  sl: 156.50,  tp1: 157.60,  tp2: 158.00,  tp3: 158.75  },
    { pair: 'XAU/USD', entry: 4160,    sl: 4130,    tp1: 4196,    tp2: 4220,    tp3: 4265    },
    { pair: 'USD/CAD', entry: 1.42000, sl: 1.41500, tp1: 1.42600, tp2: 1.43000, tp3: 1.43750 },
    { pair: 'BTC/USD', entry: 84000,   sl: 83000,   tp1: 85200,   tp2: 86000,   tp3: 87500   },
  ];
  for (const c of cases) {
    const r = CALC.calcSignal(c, cfg, RATES);
    if (!r) return `${c.pair} produced no result`;
    // The whole chain must close: units x price-risk x rate == the risked amount.
    const realised = r.units * r.priceRisk * r.rate;
    if (Math.abs(realised - r.riskAmount) > 1e-6) {
      return `${c.pair}: a stop-out works out to ${realised.toFixed(6)} but ${r.riskAmount} was risked`;
    }
    if (Math.abs(r.worst.money + r.riskAmount) > 1e-6) return `${c.pair}: worst case is not −1R`;
  }
  return true;
});

t('calculator: USD/JPY is settled in YEN, not dollars', () => {
  if (!RATES) return 'skipped: no fx-rates.json';
  if (CALC.quoteOf(RATES, 'USD/JPY') !== 'JPY') return 'USD/JPY quote currency is wrong';
  if (CALC.quoteOf(RATES, 'EUR/USD') !== 'USD') return 'EUR/USD quote currency is wrong';
  if (CALC.quoteOf(RATES, 'USD/CHF') !== 'CHF') return 'USD/CHF quote currency is wrong';
  // Treating yen as the account currency is ~200x wrong; make sure the rate is tiny.
  const jpy = CALC.rate(RATES, 'JPY', 'GBP');
  if (!(jpy > 0 && jpy < 0.02)) return `JPY→GBP rate is ${jpy}, which cannot be right`;
  return true;
});

t('calculator: the ladder outcomes match the engine invariants', () => {
  if (!RATES) return 'skipped: no fx-rates.json';
  const r = CALC.calcSignal({ pair: 'EUR/USD', entry: 1.1, sl: 1.098, tp1: 1.1024, tp2: 1.104, tp3: 1.107 },
                            { balance: 1000, riskPct: 1, currency: 'GBP' }, RATES);
  const full = r.outcomes[r.outcomes.length - 1];
  if (Math.abs(full.r - 2.2333) > 0.01) return `full run is ${full.r}R, engine invariant says +2.233R`;
  if (r.outcomes[0].r !== -1) return `full stop-out is ${r.outcomes[0].r}R, must be exactly -1`;
  // The partial outcomes must sit between the two extremes.
  for (const o of r.outcomes) {
    if (o.r < -1 || o.r > full.r + 1e-9) return `outcome "${o.name}" at ${o.r}R is outside the possible range`;
  }
  return true;
});

t('calculator: risk scales linearly and never silently exceeds the stated percent', () => {
  if (!RATES) return 'skipped: no fx-rates.json';
  const sig = { pair: 'GBP/USD', entry: 1.32, sl: 1.315, tp1: 1.326, tp2: 1.33, tp3: 1.3375 };
  const a = CALC.calcSignal(sig, { balance: 1000, riskPct: 1, currency: 'GBP' }, RATES);
  const b = CALC.calcSignal(sig, { balance: 2000, riskPct: 1, currency: 'GBP' }, RATES);
  const c = CALC.calcSignal(sig, { balance: 1000, riskPct: 2, currency: 'GBP' }, RATES);
  if (Math.abs(b.riskAmount - 2 * a.riskAmount) > 1e-9) return 'doubling the balance did not double the risk';
  if (Math.abs(c.riskAmount - 2 * a.riskAmount) > 1e-9) return 'doubling the percent did not double the risk';
  if (Math.abs(b.units - 2 * a.units) > 1e-6) return 'position size did not scale with balance';
  if (a.riskAmount !== 10) return `1% of 1000 should risk exactly 10, got ${a.riskAmount}`;
  return true;
});

t('calculator: a missing rate refuses rather than guessing', () => {
  const noRates = { toAccount: { GBP: {} }, quoteOf: { 'USD/JPY': 'JPY' } };
  const r = CALC.calcSignal({ pair: 'USD/JPY', entry: 157, sl: 156.5, tp1: 157.6 },
                            { balance: 1000, riskPct: 1, currency: 'GBP' }, noRates);
  if (r && r.rateKnown) return 'it claimed to know a rate it does not have';
  if (r && r.units != null) return 'it produced a position size with no conversion rate';
  return true;
});

t('calculator: the typed forms all resolve, and nonsense does not', () => {
  const ctx = { balance: 5000, riskPct: 2, currency: 'GBP' };
  const want = ['2% of 5000', '3R', '8 losses in a row', 'lose 8 in a row',
                'recover from 20%', '20% drawdown', 'size with a 20 pip stop', '45% win 1.5 payoff'];
  for (const q of want) {
    const r = CALC.calcDynamic(q, ctx);
    if (!r) return `"${q}" was not understood`;
    if (!r.value || !Array.isArray(r.work) || !r.work.length) return `"${q}" produced no worked answer`;
  }
  for (const q of ['banana sandwich', '', 'hello there']) {
    if (CALC.calcDynamic(q, ctx)) return `"${q}" was answered when it should not have been`;
  }
  // hand-checked: 5000 x 0.98^8 = 4253.81
  const streak = CALC.calcDynamic('8 losses in a row', ctx);
  const n = parseFloat(String(streak.value).replace(/[^\d.]/g, ''));
  if (Math.abs(n - 5000 * Math.pow(0.98, 8)) > 1) return `8-loss streak gave ${n}, expected ${(5000 * Math.pow(0.98, 8)).toFixed(2)}`;
  return true;
});

/* ── The dynamic resolver. Its failure mode is the dangerous one: answering a
   question it cannot answer. The first version matched the single-letter key
   "r" inside "france", so "what is the capital of france" came back with a
   confident definition of the R-multiple. ──────────────────────────────── */
const RES = (() => { const w = {}; new Function('window', readFileSync('v2/resolve.js', 'utf8'))(w); return w.FSRESOLVE; })();
const RS_STATE = {
  ledger: existsSync('data/ledger.json') ? JSON.parse(readFileSync('data/ledger.json', 'utf8')) : null,
  marketVoice: existsSync('data/market-voice.json') ? JSON.parse(readFileSync('data/market-voice.json', 'utf8')) : null,
  latestSignals: existsSync('data/latest-signals.json') ? JSON.parse(readFileSync('data/latest-signals.json', 'utf8')) : null,
};

t('resolver: off-topic questions get NO answer, never a confident wrong one', () => {
  for (const q of ['what is the capital of france', 'who is the prime minister', 'tell me a joke',
                   'asdfgh', 'what is the weather', 'book me a table for two']) {
    const a = RES.resolve(q, RS_STATE);
    if (a) return `"${q}" was answered with "${a.q}" — it should have returned nothing`;
  }
  return true;
});

t('resolver: instrument questions resolve to that instrument', () => {
  const want = { 'how has gold done': 'XAU/USD', 'is bitcoin any good': 'BTC/USD',
                 'what about cable': 'GBP/USD', 'tell me about silver': 'XAG/USD',
                 'guppy': 'GBP/JPY', 'how is the nasdaq': 'NAS100' };
  for (const [q, pair] of Object.entries(want)) {
    const found = RES.findInstrument(q);
    if (found !== pair) return `"${q}" resolved to ${found}, expected ${pair}`;
  }
  return true;
});

t('resolver: field and term questions resolve to the right definition', () => {
  const want = { 'what is maeR': 'maeR', 'explain mfe': 'mfeR', 'what does spans zero mean': 'spans zero',
                 'what is the payoff ratio': 'payoff ratio', 'what is expectancy': 'expectancy',
                 'what is an episode': 'episode' };
  for (const [q, term] of Object.entries(want)) {
    const a = RES.resolve(q, RS_STATE);
    if (!a) return `"${q}" resolved to nothing`;
    if (!a.q.toLowerCase().includes(term.toLowerCase())) return `"${q}" gave "${a.q}", expected ${term}`;
  }
  return true;
});

t('resolver: every answer carries a source and no undefined', () => {
  for (const q of ['how has gold done', 'what is maeR', 'how many signals in total', 'is bitcoin any good']) {
    const a = RES.resolve(q, RS_STATE);
    if (!a) return `"${q}" resolved to nothing`;
    if (!a.source) return `"${q}" has no source attribution`;
    if (/undefined|NaN|\[object Object\]/.test(a.body)) return `"${q}" leaked undefined/NaN`;
  }
  return true;
});

/* ── Per-signal money. The ladder breakdown must not double-count. ─────── */
t('calculator: the per-target ladder sums to the full-run figure', () => {
  if (!RATES) return 'skipped: no fx-rates.json';
  const r = CALC.calcSignal({ pair: 'EUR/USD', entry: 1.1, sl: 1.098, tp1: 1.1024, tp2: 1.104, tp3: 1.107 },
                            { balance: 1000, riskPct: 1, currency: 'GBP' }, RATES);
  if (!r.ladder || r.ladder.length !== 3) return 'the per-target ladder is missing or incomplete';
  const summed = r.ladder.reduce((s2, st) => s2 + st.bankedMoney, 0);
  const full = r.best.money;
  if (Math.abs(summed - full) > 1e-6) {
    return `the three banked amounts sum to ${summed.toFixed(6)} but the full run says ${full.toFixed(6)}`;
  }
  // The running total on the last step must equal the full run too.
  if (Math.abs(r.ladder[2].runningMoney - full) > 1e-6) return 'the running total does not close on the full-run figure';
  return true;
});

t('a per-signal balance override is persisted, not just displayed', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (!/perSignal/.test(js)) return 'no per-signal override exists';
  if (!/window\.FS\.save\(S\.cfg\)/.test(js)) return 'the override is never saved — it would vanish on reload';
  const cmd = readFileSync('v2/commands.js', 'utf8');
  if (!/perSignal/.test(cmd)) return 'perSignal is not in the persisted defaults, so it will not round-trip';
  return true;
});

/* ── iPhone. The zoom-on-focus bug is the most visible failure a page like
   this can ship: iOS Safari zooms the whole viewport when a focused input is
   under 16px and leaves you scrolled sideways. ─────────────────────────── */
t('iOS: every input is 16px on touch, so focusing one does not zoom the page', () => {
  const css = readFileSync('v2/base.css', 'utf8');
  if (/@supports \(-webkit-touch-callout: none\)[\s\S]{0,400}?font-size: 16px/.test(css)) {
    return 'the 16px rule is gated on an iOS-only @supports query — it cannot be verified anywhere '
         + 'and silently did nothing when measured';
  }
  const m = css.match(/@media \(pointer: coarse\)[^{]*\{([\s\S]{0,700}?)\n\}/);
  if (!m || !/font-size: 16px !important/.test(m[1])) return 'no coarse-pointer rule setting inputs to 16px';
  for (const sel of ['#cmd-input', '#calc-in', '#rs-q', '.mny-bal', '.mny-pct', '.mny-amt']) {
    if (!m[1].includes(sel)) return `${sel} is not covered by the 16px rule`;
  }
  return true;
});

t('iOS: safe-area insets are respected, so nothing hides under the notch or home bar', () => {
  const css = readFileSync('v2/base.css', 'utf8');
  for (const need of ['safe-area-inset-top', 'safe-area-inset-bottom', 'safe-area-inset-left']) {
    if (!css.includes(need)) return `${need} is never used — content will sit under the ${need.includes('top') ? 'Dynamic Island' : 'home indicator'}`;
  }
  const html = readFileSync('index.html', 'utf8');
  if (!/viewport-fit=cover/.test(html)) return 'viewport-fit=cover is missing, so the insets are always zero';
  // Blocking pinch-zoom is an accessibility failure and is not the right fix.
  if (/maximum-scale=1|user-scalable=no/.test(html)) return 'pinch-zoom is disabled — that is an accessibility failure';
  return true;
});

/* ── The installed app must not sit on an old build. ───────────────────── */
t('the service worker is build-stamped on every deploy', () => {
  const sw = readFileSync('service-worker.js', 'utf8');
  if (!/const BUILD = '__BUILD__'/.test(sw)) {
    return 'the BUILD placeholder is missing or has a stamped value committed — deploys would stop changing this file';
  }
  if (!/const CACHE = 'forexsight-' \+ BUILD/.test(sw)) return 'the cache name is not derived from the build';
  if (!/skipWaiting/.test(sw) || !/clients\.claim/.test(sw)) {
    return 'without skipWaiting and clients.claim a new worker waits for every tab to close';
  }
  const deploy = readFileSync('tools/deploy.sh', 'utf8');
  if (!/__BUILD__/.test(deploy)) return 'deploy.sh does not stamp the build';
  return true;
});

t('both shells register the service worker', () => {
  for (const f of ['index.html', 'v2/index.html']) {
    if (!/serviceWorker\.register/.test(readFileSync(f, 'utf8'))) {
      return `${f} never registers the worker — the installed app would have no offline shell and no update route`;
    }
  }
  const js = readFileSync('v2/base.js', 'utf8');
  if (!/controllerchange/.test(js)) return 'the page never listens for a new worker taking control';
  return true;
});

/* ── Currencies. The picker must follow the published rates, not a list. ── */
t('account currencies come from the rates file, not a hard-coded list', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (/\['GBP', 'USD', 'EUR'\]\.map\(c => `<option/.test(js)) {
    return 'the picker is hard-coded to three currencies — adding a rate would not surface it';
  }
  if (!/S\.fxRates && S\.fxRates\.toAccount/.test(js)) return 'the picker does not read the published rate list';
  if (!existsSync('data/fx-rates.json')) return 'skipped: no rates file';
  const r = JSON.parse(readFileSync('data/fx-rates.json', 'utf8'));
  const accts = Object.keys(r.toAccount || {});
  if (accts.length < 4) return `only ${accts.length} account currencies are published`;
  // Every account currency must be able to convert every quote currency it meets.
  const quotes = [...new Set(Object.values(r.quoteOf || {}))];
  for (const a of accts) {
    for (const q of quotes) {
      if (r.toAccount[a][q] == null) return `no ${q} -> ${a} rate, so signals quoted in ${q} cannot be priced in ${a}`;
    }
  }
  return true;
});

t('every v2 script file is actually loaded by both shells', () => {
  const scripts = readdirSync('v2').filter(f => f.endsWith('.js'));
  for (const shell of ['index.html', 'v2/index.html']) {
    const html = readFileSync(shell, 'utf8');
    for (const f of scripts) {
      // A file that exists and is served but is never referenced is dead code
      // that looks alive — exactly how chart.js shipped without being loaded.
      if (!html.includes(`/v2/${f}`)) return `${shell} never loads v2/${f}`;
    }
  }
  return true;
});

/* ── The chart. It must draw from the SAME bars the engine reads, or it is a
   lookalike that quietly disagrees with the signal it is illustrating. ──── */
t('the chart reads the published OHLC the engine uses', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  if (!/data\/ohlc\//.test(js)) return 'the chart does not read the published OHLC files';
  if (!/raw\.githubusercontent/.test(js)) return 'no mirror source — it would go stale between deploys';
  if (!/got\.sort\(\(a, b\) => b\.ts - a\.ts\)/.test(js)) return 'it does not take the freshest source';
  return true;
});

t('published OHLC covers every instrument that can produce a signal', () => {
  if (!existsSync('data/ohlc')) return 'skipped: no published OHLC';
  const charted = new Set(readdirSync('data/ohlc').filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));
  const gen = readFileSync('tools/generate-signals.mjs', 'utf8');
  const m = gen.match(/const PAIR_SYMBOLS = \{([\s\S]*?)\};/);
  if (!m) return 'could not read the generator pair list';
  const pairs = [...m[1].matchAll(/'([A-Z0-9]{2,6}(?:\/[A-Z]{3})?)'\s*:/g)].map(x => x[1].replace('/', '-'));
  const missing = pairs.filter(p => !charted.has(p));
  // A signal with no chart is a signal you cannot check before taking.
  if (missing.length) return `${missing.length} instrument(s) can signal but have no chart: ${missing.join(', ')}`;
  return true;
});

t('the chart scales to include every level it draws', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  // A stop outside the visible range would silently look like it does not exist.
  if (!/for \(const v of \[s\.entry, s\.sl, s\.tp1, s\.tp2, s\.tp3\]\)/.test(js)) {
    return 'the price scale is computed from bars only — a level outside the bar range would be invisible';
  }
  return true;
});

t('the chart is cached and prefetched, so opening it does not wait on the network', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  if (!/CH_CACHE/.test(js)) return 'no bar cache — every open would re-fetch';
  if (!/function chPrefetch/.test(js)) return 'no prefetch — the first open would always be slow';
  // Redraws must be coalesced to one per frame: a 120Hz pointer fires faster
  // than the display refreshes, and the extra draws are thrown away.
  if (!/function chRequestDraw\(\)[\s\S]{0,200}requestAnimationFrame/.test(js)) {
    return 'redraws are not frame-coalesced; a 120Hz pointer would redraw faster than the screen refreshes';
  }
  if (/chDraw\(\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(mode === 'pinch'/.test(js)) {
    return 'a gesture path calls chDraw directly instead of chRequestDraw';
  }
  if (!/Math\.min\(window\.devicePixelRatio \|\| 1, 3\)/.test(js)) {
    return 'device pixel ratio is not capped — the buffer grows quadratically on a high-density screen';
  }
  const base = readFileSync('v2/base.js', 'utf8');
  if (!/FSCHART\.prefetch/.test(base)) return 'the signal list never warms the chart cache';
  return true;
});

/* ── Drag to rearrange. The failure that matters is not "drag does not work" —
   it is a drag implementation that eats ordinary taps, or one built on an API
   that silently does nothing on a phone. ──────────────────────────────── */
/** Strips comments and strings so a test examines CODE, not prose. The first
    version of the check below matched the words "after the drop" in a comment
    and failed a file that was entirely correct. */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
  .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");

t('reorder uses pointer events, not HTML5 drag-and-drop', () => {
  const js = codeOnly(readFileSync('v2/reorder.js', 'utf8'));
  if (/addEventListener\(\s*'?(dragstart|dragover|dragend|drop)|draggable\s*=/.test(js)) {
    return 'HTML5 drag-and-drop is in use — it does not fire on iOS at all, so this would work on '
         + 'a desktop and silently do nothing on the phone, which is where it is most wanted';
  }
  const raw = readFileSync('v2/reorder.js', 'utf8');
  if (!/pointerdown/.test(raw) || !/pointermove/.test(raw)) return 'no pointer handlers';
  return true;
});

t('a drag requires a deliberate hold, so brushing past does not pick things up', () => {
  const js = readFileSync('v2/reorder.js', 'utf8');
  // Movement alone used to start a drag, so scrolling past a heading could lift
  // a section — it read as the page glitching rather than responding.
  if (!/RO_HOLD_MS\s*=\s*2000/.test(js)) return 'the hold is not 2 seconds';
  if (!/if \(!drag\.armed\)/.test(js)) return 'a drag can still begin without the hold completing';
  if (!/Math\.abs\(dx\) > RO_SLOP \|\| Math\.abs\(dy\) > RO_SLOP\) cleanup\(\)/.test(js)) {
    return 'movement during the hold does not cancel it, so a scroll would still arm a drag';
  }
  if (!/ro-holding/.test(js)) return 'no visible feedback while holding — a 2s wait with no indication reads as broken';
  const base = readFileSync('v2/base.js', 'utf8');
  if (!/ro-dragging.*\)\s*return|querySelector\('\.ro-dragging'\)/.test(base)) {
    return 'a click synthesised at the end of a drag is not suppressed — dropping a tab would also switch pane';
  }
  return true;
});

t('every tab and section carries a stable id, and the order is persisted', () => {
  for (const shell of ['index.html', 'v2/index.html']) {
    const html = readFileSync(shell, 'utf8');
    const ids = [...html.matchAll(/data-roid="([^"]+)"/g)].map(m => m[1]);
    if (ids.length < 10) return `${shell} has only ${ids.length} draggable ids`;
    // Tabs and panes must line up, or a reordered tab would point at nothing.
    const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
    const panes = [...html.matchAll(/data-pane="([^"]+)"/g)].map(m => m[1]);
    for (const t2 of tabs) if (!panes.includes(t2)) return `${shell}: tab "${t2}" has no matching pane`;
    for (const p2 of panes) if (!tabs.includes(p2)) return `${shell}: pane "${p2}" has no tab`;
  }
  const cmd = readFileSync('v2/commands.js', 'utf8');
  if (!/tabOrder/.test(cmd) || !/segOrder/.test(cmd)) return 'the order is not in the persisted defaults, so it would not survive a reload';
  return true;
});

t('an unknown section is kept, not dropped, when a saved order is applied', () => {
  const js = readFileSync('v2/reorder.js', 'utf8');
  // Adding a new section later must not make it vanish for anyone with a saved order.
  if (!/if \(!order\.includes\(it\.dataset\.roid\)\)/.test(js)) {
    return 'applyOrder drops items the saved order does not mention — a newly added section '
         + 'would disappear for every existing user';
  }
  return true;
});

/* ── TradingView. A wrong exchange prefix shows a different instrument, which
   is worse than showing nothing. ──────────────────────────────────────── */
t('every signalling instrument has an explicit TradingView symbol', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  const m = js.match(/const CH_TV = \{([\s\S]*?)\};/);
  if (!m) return 'no TradingView symbol map';
  const mapped = new Set([...m[1].matchAll(/'([^']+)'\s*:/g)].map(x => x[1]));
  const gen = readFileSync('tools/generate-signals.mjs', 'utf8');
  const g = gen.match(/const PAIR_SYMBOLS = \{([\s\S]*?)\};/);
  if (!g) return 'could not read the generator pair list';
  const pairs = [...g[1].matchAll(/'([A-Z0-9]{2,6}(?:\/[A-Z]{3})?)'\s*:/g)].map(x => x[1]);
  const missing = pairs.filter(p2 => !mapped.has(p2));
  if (missing.length) return `${missing.length} instrument(s) would fall back to a guessed ticker: ${missing.join(', ')}`;
  // Every mapping must carry an exchange prefix, or TradingView picks for us.
  for (const [k, v] of [...m[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map(x => [x[1], x[2]])) {
    if (!v.includes(':')) return `${k} maps to "${v}" with no exchange prefix — TradingView would resolve it to whatever it likes`;
  }
  return true;
});

t('the chart opens on our own chart, not the third-party embed', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  if (!/chSetView\('own'\)/.test(js)) {
    return 'it does not force our own chart on open — the embed needs a network round trip and '
         + 'would leave the panel blank, and it does not know the signal levels';
  }
  if (!/tv-fail/.test(js)) return 'no fallback when the embed cannot load';
  return true;
});

/* ── Chart interaction. Both charts must be directly manipulable. ──────── */
t('our chart supports zoom, pan, pinch and reset', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  const need = {
    "wheel zoom": /addEventListener\('wheel'/,
    "drag to pan": /chClampView\(anchor\.view\.from - barsMoved/,
    "pinch": /mode === 'pinch'/,
    "vertical scale": /function chSetYZoom/,
    "double-click reset": /addEventListener\('dblclick'/,
    "frame-coalesced redraw": /function chRequestDraw/,
  };
  for (const [what, re] of Object.entries(need)) if (!re.test(js)) return `no ${what}`;
  // A zoom must not be able to collapse the window to nothing.
  if (!/Math\.max\(20, Math\.min\(n, Math\.round\(to - from\)\)\)/.test(js)) {
    return 'the view window is not clamped — zooming in far enough would show zero bars';
  }
  return true;
});

t('no source file is broken by a comment that closes itself early', () => {
  // Writing a cron expression inside a block comment terminates it at the */
  // and turns the rest of the comment into code. This shipped once.
  for (const f of readdirSync('v2').filter(x => x.endsWith('.js'))) {
    const src = readFileSync(`v2/${f}`, 'utf8');
    try { new Function(src); }
    catch (e) { return `v2/${f} does not parse: ${e.message}`; }
  }
  for (const f of ['service-worker.js']) {
    if (!existsSync(f)) continue;
    try { new Function(readFileSync(f, 'utf8')); }
    catch (e) { return `${f} does not parse: ${e.message}`; }
  }
  return true;
});

/* ── Backend. Every check here is one that reported a healthy system as broken,
   or a broken one as healthy. ─────────────────────────────────────────── */
t('asset classification is by pattern, not a list that goes stale', () => {
  const src = readFileSync('tools/verify-data.mjs', 'utf8');
  if (/\['BTC\/USD', 'ETH\/USD', 'SOL\/USD'\]\.includes/.test(src)) {
    return 'crypto is matched against a hard-coded list — XRP was missing from it and 27 good '
         + 'bars were reported as a feed splice';
  }
  if (!/\^\(BTC\|ETH\|SOL\|XRP/.test(src)) return 'no pattern-based crypto classification';
  if (!/indexClosure/.test(src)) {
    return 'an index trades one session a day, so every night is a gap — without this US30 and '
         + 'NAS100 are reported with 16 unexplained gaps each while being intact';
  }
  // The closure test must check an actual SESSION BOUNDARY, not just a duration.
  // A flat "under 20x the spacing" tolerance excused a genuine 4-hour hole torn
  // out of the middle of a session; a control with three bars removed proved it.
  if (!/sessionEnd && sessionOpen/.test(src)) {
    return 'a closure is excused by duration alone — a real mid-session hole would pass as clean';
  }
  return true;
});

t('price staleness knows the market can be closed', () => {
  const src = readFileSync('functions/api/prices.js', 'utf8');
  if (!/_staleAllowance/.test(src)) {
    return 'a flat staleness threshold is in use — it rejected FX as "stale 1593min" on a Saturday, '
         + 'and 1593 minutes was exactly the time since Friday\'s close';
  }
  if (!/day === 6 \|\| \(day === 0 && hour < 21\)/.test(src)) return 'the weekend is not detected';
  return true;
});

t('every instrument has enough bars for the strategies that read them', () => {
  if (!existsSync('data/ohlc')) return 'skipped: no published OHLC';
  const thin = [];
  for (const f of readdirSync('data/ohlc').filter(x => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(`data/ohlc/${f}`, 'utf8'));
      const bars = d.ohlc || d.bars || (Array.isArray(d) ? d : []);
      // Several strategies need 200 bars before they will run at all.
      if (bars.length < 200) thin.push(`${f.replace('.json', '')} (${bars.length})`);
    } catch (_) {}
  }
  if (thin.length) return `${thin.length} instrument(s) have under 200 bars: ${thin.join(', ')}`;
  return true;
});

t('the chart keeps the zoom you chose', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  if (!/fs\.chart\.view/.test(js)) return 'the chosen view is not persisted';
  if (!/chSetBars\(wantBars, \{ remember: false \}\)/.test(js)) {
    return 'opening a chart snaps back to a default instead of honouring the saved zoom';
  }
  if (!/chSavePref\(\)/.test(js)) return 'zooming never saves the preference';
  return true;
});

t('lifting a pinch cannot be mistaken for a double-tap', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  // Two fingers coming off fire two pointerups milliseconds apart. Treating
  // that as a double-tap threw away every pinch the instant it finished.
  if (!/pointersThisGesture/.test(js)) {
    return 'the number of fingers in a gesture is not tracked, so a two-finger release can read as a double-tap';
  }
  if (!/const cleanTap = [\s\S]{0,200}pointersThisGesture === 1/.test(js)) {
    return 'a tap is not required to be single-finger';
  }
  if (!/!\(anchor && anchor\.moved\)/.test(js)) return 'a tap is not required to have moved nothing';
  return true;
});

t('pan and pinch both persist the view, not just wheel zoom', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  // A wheel event never fires on touch. If only wheel-zoom saved, a phone would
  // always reopen at the default width however far it had been zoomed.
  // Greedy to the closing brace: a non-greedy match stopped at the first
  // `return` two lines in, before the save, and failed correct code.
  const pinchBlock = (js.match(/if \(mode === 'pinch'\) \{[\s\S]*?\n    \}/) || [''])[0];
  if (!/chSavePref/.test(pinchBlock)) return 'pinch does not persist the view — the phone would reset every time';
  const panBlock = (js.match(/const barsMoved[\s\S]{0,300}/) || [''])[0];
  if (!/chSavePref/.test(panBlock)) return 'pan does not persist the view';
  return true;
});

t('a live refresh does not yank the view back to the right edge', () => {
  const js = readFileSync('v2/chart.js', 'utf8');
  if (!/wasAtRightEdge/.test(js)) {
    return 'the 30-second refresh re-anchors the view unconditionally, so panning back into history '
         + 'is undone every half minute';
  }
  return true;
});

t('the live tracker reads price from the same bars the chart and engine use', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (!/function trackerBlock/.test(js)) return 'no live position tracker';
  if (!/FSCHART[\s\S]{0,60}cached/.test(js)) {
    return 'the tracker does not read the chart cache — it would show a price that disagrees with the chart';
  }
  // Running R must be computed, never read from the feed, so it is always current.
  if (!/\(\(live\.price - entry\) \* sign\) \/ risk/.test(js)) return 'running R is not computed from the live price';
  if (!/NEAR_R/.test(js)) return 'no proximity threshold — nothing would flag a level about to be hit';
  // Absence must be stated, not implied.
  if (!/trk-none/.test(js)) return 'a missing live price is not disclosed';
  return true;
});

t('History publishes the WHOLE book, not a recent window', () => {
  if (!existsSync('data/ledger.json')) return 'skipped: no ledger';
  const L = JSON.parse(readFileSync('data/ledger.json', 'utf8'));
  if (!Array.isArray(L.history)) return 'no history array is published';
  if (L.history.length !== L.coverage.total) {
    return `history has ${L.history.length} rows but ${L.coverage.total} signals exist — a History `
         + 'segment that silently stops is not a history';
  }
  // The three outcome buckets must account for every row, or a filter hides something.
  const won = L.history.filter(x => typeof x.resultR === 'number' && x.resultR > 0).length;
  const lost = L.history.filter(x => typeof x.resultR === 'number' && x.resultR <= 0).length;
  const open = L.history.filter(x => x.resultR == null).length;
  if (won + lost + open !== L.history.length) {
    return `buckets do not reconcile: ${won} + ${lost} + ${open} != ${L.history.length}`;
  }
  if (won !== L.winRates.byOutcome.wins) {
    return `History counts ${won} wins but the ledger headline says ${L.winRates.byOutcome.wins}`;
  }
  return true;
});

t('the live tracker redraws when prefetched bars arrive', () => {
  const ch = readFileSync('v2/chart.js', 'utf8');
  const base = readFileSync('v2/base.js', 'utf8');
  // Cards render before any fetch completes. Without an event the tracker drew
  // "live price not loaded" once and stayed that way for a full cycle — which on
  // a phone opening cold is all you ever saw.
  if (!/fs-bars-ready/.test(ch)) return 'the prefetch never announces that bars landed';
  if (!/addEventListener\('fs-bars-ready'/.test(base)) return 'the page never listens for bars landing';
  return true;
});

/* ── Push. Every piece existed and nothing called it. ─────────────────── */
t('something actually SENDS push notifications', () => {
  if (!existsSync('tools/push-new-signals.mjs')) return 'no sender exists — subscribers would never be pushed to';
  const wf = readFileSync('.github/workflows/mirror-signals.yml', 'utf8');
  if (!/push-new-signals/.test(wf)) return 'the sender is never run by CI, so it would never fire';
  const src = readFileSync('tools/push-new-signals.mjs', 'utf8');
  if (!/push-sent\.json/.test(src)) return 'no memory of what was sent — a republished setup would buzz every cycle';
  return true;
});

t('the client subscribes to real push, not just the page-only API', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  if (!/pushManager\.subscribe/.test(js)) {
    return 'no pushManager subscription — Notification alone only fires while the page is OPEN, '
         + 'which is useless on a closed phone app';
  }
  if (!/applicationServerKey/.test(js)) return 'no VAPID key is applied';
  // The server validates sub.endpoint at the top level; wrapping it is rejected.
  if (/body: JSON\.stringify\(\{ subscription: sub/.test(js)) {
    return 'the subscription is wrapped in an object — the server validates endpoint/keys at the top level and rejects it';
  }
  if (!/standalone/.test(js)) return 'no iOS install check — iOS silently refuses push from an uninstalled site';
  return true;
});

t('an overlay can be left without leaving the app', () => {
  const js = readFileSync('v2/base.js', 'utf8');
  // With nothing listening, the phone back gesture exits the whole PWA to
  // dismiss a dialog, which is the worst possible outcome.
  if (!/addEventListener\('popstate'/.test(js)) return 'nothing listens for back, so the gesture would exit the app';
  if (!/pushOverlayState/.test(js)) return 'overlays do not push a history entry for back to pop';
  const ch = readFileSync('v2/chart.js', 'utf8');
  if (!/pushOverlayState/.test(ch)) return 'the chart overlay is not on the history stack';
  return true;
});

t('both charts can fill the screen with the instrument still labelled', () => {
  const ch = readFileSync('v2/chart.js', 'utf8');
  if (!/chToggleFull/.test(ch)) return 'no full-screen control';
  if (!/ch-faux-full/.test(ch)) return 'no fallback — iOS Safari refuses the Fullscreen API on a div';
  const css = readFileSync('v2/base.css', 'utf8');
  if (!/\.ch-panel\.is-full \.ch-top[\s\S]{0,120}sticky/.test(css)) {
    return 'the instrument name is not pinned in full screen — a full-screen chart with no label can be misread';
  }
  return true;
});

t('grid children can shrink, so nothing is pushed past the right edge', () => {
  const css = readFileSync('v2/base.css', 'utf8');
  // A number input has an intrinsic minimum width and a grid track will not go
  // below its content without this. Measured at 390px it pushed 10 elements off.
  if (!/\.acct-in input, \.acct-in select \{ min-width: 0/.test(css)) {
    return 'account inputs have no min-width:0 — the grid overflows on a phone';
  }
  return true;
});

console.log(`\n  ${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);
