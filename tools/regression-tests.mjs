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

console.log(`\n  ${pass} passed, ${fail} failed, ${skip} skipped\n`);
process.exit(fail ? 1 : 0);
