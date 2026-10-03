/* ============================================================================
   ForexSight — base II
   Built in a separate directory so the old base keeps serving while this one
   is judged against it. Nothing from the old base is deleted or edited.

   WHAT IS DELIBERATELY DIFFERENT, and why — each of these is a bug the old
   base actually shipped, not a preference:

   · ONE RENDER FROM STATE. render(S) writes the whole page from a plain object
     and then stops. The old base's defining bug was a MutationObserver that
     re-patched cards in response to its own writes, ~8 rebuilds a second,
     forever. There is no observer here, so that bug cannot be written.

   · FRESHEST WINS, NOT FIRST. Every file has two sources — the git mirror
     (minutes old) and this deploy's own copy (only as new as the last manual
     deploy). The old base took whichever answered first and sometimes showed a
     copy 2.5 minutes staler. Here all sources race, then the newest ts wins,
     and a feed WITH signals outranks an empty one of the same age.

   · FIELD NAMES ARE READ FROM THE FEED, NEVER ASSUMED. The old base gated on
     six fields that were absent from 355 of 355 signals, so its best-setup
     filter could never pass anything. Every read here goes through pick(),
     which tries the known aliases and returns null rather than 0 — because
     `x || 0` is what rendered missing data as "0% win chance".

   · ABSENCE IS PRINTED AS ABSENCE. No placeholder number ever stands in for a
     measurement we do not have.
   ========================================================================== */
'use strict';

const MIRROR = 'https://raw.githubusercontent.com/Jboy-dev/forexsight/main/data/';
const LOCAL  = '/data/';
const FILES  = ['latest-signals', 'market-voice', 'learning-brain', 'shadow-tracker', 'self-evaluation'];

const S = { loaded: false, at: 0, errors: [] };   // the single source of truth

/* ───────────────────────────── helpers ───────────────────────────── */
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tries aliases in order. Returns null for missing — never a stand-in zero. */
function pick(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const sign = (n) => (n == null ? '' : n > 0 ? '+' : '');
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function ago(ts) {
  if (!ts) return 'unknown age';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function price(v, pair) {
  const n = num(v); if (n == null) return '—';
  const p = String(pair || '');
  const dp = /JPY/.test(p) ? 3 : /XAU|BTC|ETH|US30|SPX|NAS/.test(p) ? 2 : 5;
  return n.toFixed(dp);
}

/* ─────────────────────────── loading ─────────────────────────── */
/**
 * Race every source for one file, keep them all, then choose.
 * Choice order: a feed with signals beats an empty one; then newest ts wins.
 * Both rules are here because both failures happened on the old base.
 */
async function loadOne(name) {
  const bust = Date.now();
  const urls = [`${MIRROR}${name}.json?_b=${bust}`, `${LOCAL}${name}.json?_b=${bust}`];
  const got = [];
  await Promise.all(urls.map(async (u) => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(u, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j === 'object') got.push({ src: u.includes('raw.github') ? 'mirror' : 'deploy', j });
    } catch (_) { /* a dead source is not an error worth showing; an empty page is */ }
  }));
  if (!got.length) { S.errors.push(name); return null; }
  got.sort((a, b) => {
    const an = (a.j.signals || []).length > 0, bn = (b.j.signals || []).length > 0;
    if (an !== bn) return an ? -1 : 1;
    return (b.j.ts || 0) - (a.j.ts || 0);
  });
  got[0].j._src = got[0].src;
  return got[0].j;
}

async function load() {
  S.errors = [];
  const results = await Promise.all(FILES.map(loadOne));
  FILES.forEach((f, i) => { S[f.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = results[i]; });
  S.loaded = true; S.at = Date.now();
}

/* ───────────────────── what the market is doing ───────────────────── */
function renderVoice() {
  const v = S.marketVoice;
  const box = el('voice');
  if (!v) {
    box.innerHTML = `<div class="voice-label">What the market is doing</div>
      <div class="voice-head">The market read is not published yet.</div>
      <div class="voice-honest">tools/market-voice.mjs has not written data/market-voice.json to the mirror yet. Nothing is being guessed in its place.</div>`;
    return;
  }
  const reads = v.reads || {};
  const proven = (v.predictiveReads || []).length > 0;
  const card = (k, label) => {
    const r = reads[k] || {};
    const val = num(r.value);
    const isPred = (v.predictiveReads || []).includes(k);
    return `<div class="vr">
      <div class="vr-k">${esc(label)}${isPred ? ' ·&nbsp;predictive' : ''}</div>
      <div class="vr-v">${val == null ? '—' : esc(sign(val) + val + (k === 'breadth' ? '%' : '%'))}</div>
      <div class="vr-s">${esc(r.state || 'not measured')}</div>
    </div>`;
  };
  box.innerHTML = `
    <div class="voice-label">What the market is doing · ${esc(v.instruments || '?')} markets · ${esc((v.totalDailyBars || 0).toLocaleString())} daily bars</div>
    <div class="voice-head">${esc(v.headline || 'No read available.')}</div>
    <div class="voice-reads">
      ${card('dollar', 'Dollar')}${card('risk', 'Risk appetite')}${card('breadth', 'Breadth')}
    </div>
    <div class="voice-honest${proven ? ' proven' : ''}">${esc(v.honesty || '')}</div>`;
}

/* ───────────────── context strip: loud, quiet, calendar ───────────────── */
function renderContext() {
  const v = S.marketVoice, box = el('context');
  if (!v) { box.innerHTML = ''; return; }
  const loud = (v.volatility && v.volatility.loudest) || [];
  const quiet = (v.volatility && v.volatility.quietest) || [];
  const cal = v.calendar || [];
  const next = cal[0];

  const tiles = [];
  if (loud.length) tiles.push(`<div class="tile">
    <div class="tile-k">Moving most</div>
    <div class="tile-v" style="font-size:15px">${esc(loud[0].instrument)}</div>
    <div class="tile-n">${esc(loud[0].yearPercentile)}th percentile range vs its own past year</div></div>`);
  if (quiet.length) tiles.push(`<div class="tile">
    <div class="tile-k">Quietest</div>
    <div class="tile-v" style="font-size:15px">${esc(quiet[0].instrument)}</div>
    <div class="tile-n">${esc(quiet[0].yearPercentile)}th percentile — tight stops get hit by noise here</div></div>`);
  tiles.push(`<div class="tile">
    <div class="tile-k">Next scheduled release</div>
    <div class="tile-v" style="font-size:15px">${next ? esc(next.country + ' ' + next.title.slice(0, 22)) : 'none visible'}</div>
    <div class="tile-n">${next
      ? esc(`in ${next.hoursAway}h${next.forecast ? ` · forecast ${next.forecast}` : ''}`)
      : 'the calendar feed publishes the current week only, so nothing further ahead is visible'}</div></div>`);
  tiles.push(`<div class="tile">
    <div class="tile-k">Price data through</div>
    <div class="tile-v" style="font-size:15px">${esc(v.dataThrough || '—')}</div>
    <div class="tile-n">${esc(v.barAgeDays != null ? v.barAgeDays + ' days old' : 'age unknown')}</div></div>`);
  box.innerHTML = tiles.join('');
}

/* ─────────────────────────── signals ─────────────────────────── */
function renderCards() {
  const feed = S.latestSignals, box = el('cards');
  const sigs = (feed && feed.signals) || [];
  if (!sigs.length) {
    box.innerHTML = `<div class="empty"><strong>No setups published right now</strong>
      ${feed ? `The feed is live and ${esc(ago(feed.ts))}; it simply contains nothing that passed. An empty feed is a result, not a fault.` : 'The feed could not be read from either source.'}</div>`;
    return;
  }
  box.innerHTML = sigs.map(card).join('');
}

function card(s) {
  const dir = String(pick(s, 'direction', 'side') || '').toUpperCase();
  const buy = dir === 'BUY' || dir === 'LONG';
  const pair = pick(s, 'pair', 'symbol', 'instrument') || '—';
  const entry = num(pick(s, 'entry', 'price', 'entryPrice'));
  const sl = num(pick(s, 'sl', 'stopLoss', 'stop'));
  const tp1 = num(pick(s, 'tp1', 'takeProfit1'));
  const tp2 = num(pick(s, 'tp2'));
  const tp3 = num(pick(s, 'tp3'));

  // R geometry, computed here rather than trusted, so a bad ladder is visible.
  const risk = (entry != null && sl != null) ? Math.abs(entry - sl) : null;
  const rOf = (tp) => (risk && tp != null && risk > 0) ? (Math.abs(tp - entry) / risk) : null;
  const r1 = rOf(tp1), r2v = rOf(tp2), r3 = rOf(tp3);
  const perfect = (r1 != null && r2v != null && r3 != null) ? (r1 + r2v + r3) / 3 : null;

  const conf = num(pick(s, 'confidence', 'score'));
  const tier = pick(s, 'tier');
  const news = pick(s, 'newsCheck') || {};
  const mc = pick(s, 'monteCarloOutcome') || {};
  const regime = pick(s, 'regime') || {};
  const chart = pick(s, 'chartStudy') || {};
  const cost = pick(s, 'costProfile') || {};
  const weak = pick(s, 'weakSignal') === true;
  const barAge = num(pick(s, 'barAgeMinutes'));

  const chips = [];
  if (tier) chips.push(`<span class="chip ${tier === 'best' ? 'ok' : 'info'}">${esc(String(tier).toUpperCase())}</span>`);
  if (conf != null) chips.push(`<span class="chip">conf ${esc(conf)}</span>`);
  if (regime.label) chips.push(`<span class="chip">${esc(regime.label)}</span>`);
  if (perfect != null) chips.push(`<span class="chip ${perfect > 1 ? 'ok' : 'bad'}">full run ${esc(sign(perfect) + perfect.toFixed(2))}R</span>`);
  if (r1 != null) chips.push(`<span class="chip ${r1 > 1 ? 'ok' : 'bad'}">TP1 ${esc(r1.toFixed(2))}R</span>`);
  if (news.verdict === 'warn') chips.push(`<span class="chip warn">news nearby</span>`);
  if (news.verdict === 'uncovered') chips.push(`<span class="chip warn">news unverified</span>`);
  if (news.verdict === 'unknown') chips.push(`<span class="chip warn">news unchecked</span>`);
  if (weak) chips.push(`<span class="chip bad">weak</span>`);
  if (pick(s, 'generatedOffline') === true) chips.push(`<span class="chip info">offline engine</span>`);

  // The honest "why". Only claims the feed actually supports.
  const why = [];
  if (chart.score != null) why.push(`Chart structure scored ${chart.score}/100.`);
  if (regime.label) why.push(`Regime reads ${String(regime.label).toLowerCase()}${regime.adx != null ? ` (ADX ${regime.adx})` : ''}.`);
  const brainNote = pick(s, 'brainNote');
  if (brainNote) why.push(String(brainNote));
  else if (num(pick(s, 'eliteBrainWR')) != null) why.push(`Measured win rate for this combination: ${Math.round(num(pick(s, 'eliteBrainWR')) * 100)}%.`);
  else why.push('No measured win rate exists for this combination yet, so none is shown.');

  const lvl = (k, v, rr, cls) => `<div class="lvl ${cls}">
    <div class="lvl-k">${esc(k)}</div>
    <div class="lvl-v">${esc(price(v, pair))}</div>
    <div class="lvl-d">${rr != null ? esc(rr.toFixed(2) + 'R') : '&nbsp;'}</div></div>`;

  return `<article class="card ${buy ? 'buy' : 'sell'}">
    <div class="c-head">
      <div>
        <div class="c-pair">${esc(pair)}</div>
        <div class="c-sub">${esc(pick(s, 'detectedAt') ? ago(Date.parse(pick(s, 'detectedAt'))) : 'time unknown')}${barAge != null ? ` · bar ${esc(barAge)}m old` : ''}</div>
      </div>
      <span class="c-dir ${buy ? 'buy' : 'sell'}">${esc(dir || '?')}</span>
    </div>
    <div class="c-levels">
      ${lvl('Entry', entry, null, '')}
      ${lvl('Stop', sl, risk ? -1 : null, 'sl')}
      ${lvl('TP1', tp1, r1, 'tp')}
      ${lvl('TP3', tp3, r3, 'tp')}
    </div>
    <div class="c-body">
      <div class="chips">${chips.join('')}</div>
      <div class="c-why">${esc(why.join(' '))}</div>

      <details class="fold"><summary>The whole ladder and what it pays</summary><div class="fold-in">
        <dl class="kv">
          <dt>TP1</dt><dd>${esc(price(tp1, pair))} · ${r1 != null ? esc(r1.toFixed(2)) + 'R' : '—'} · bank a third</dd>
          <dt>TP2</dt><dd>${esc(price(tp2, pair))} · ${r2v != null ? esc(r2v.toFixed(2)) + 'R' : '—'} · bank a third, stop to entry</dd>
          <dt>TP3</dt><dd>${esc(price(tp3, pair))} · ${r3 != null ? esc(r3.toFixed(2)) + 'R' : '—'} · final third, stop to TP1</dd>
          <dt>Full run</dt><dd>${perfect != null ? esc(sign(perfect) + perfect.toFixed(3)) + 'R' : '—'}</dd>
          <dt>Full stop-out</dt><dd>&minus;1.000R</dd>
        </dl>
        <p style="margin-top:9px">${perfect != null && perfect > 1
          ? `A completed run pays ${esc(perfect.toFixed(2))}R against ${esc((1).toFixed(2))}R risked, so the geometry is the right way round. That is arithmetic about this ladder — not a claim about how often it completes.`
          : 'This ladder does not pay more than it risks on a full run. It should not have been published.'}</p>
      </div></details>

      <details class="fold"><summary>Costs, news and the modelled outcome</summary><div class="fold-in">
        <dl class="kv">
          ${cost.spreadPips != null ? `<dt>Spread</dt><dd>${esc(cost.spreadPips)} pips (${esc(cost.spreadAsPctOfRisk ?? '?')}% of risk)</dd>` : ''}
          ${cost.riskPips != null ? `<dt>Risk</dt><dd>${esc(cost.riskPips)} pips</dd>` : ''}
          ${cost.tp1NetR != null ? `<dt>TP1 after costs</dt><dd>${esc(cost.tp1NetR)}R</dd>` : ''}
          <dt>News</dt><dd>${esc(news.verdict || 'not checked')}</dd>
          ${mc.runs ? `<dt>Modelled</dt><dd>${esc(mc.expectedR)}R over ${esc(mc.runs)} runs</dd>` : ''}
          ${mc.hitTp1Pct != null ? `<dt>Reached TP1</dt><dd>${esc(mc.hitTp1Pct)}% of runs</dd>` : ''}
        </dl>
        ${news.note ? `<p style="margin-top:9px">${esc(news.note)}</p>` : ''}
        ${mc.runs ? `<p style="margin-top:9px">The modelled figure is a simulation of this ladder under measured volatility. It is a model of the exit rules, not evidence that the entry works.</p>` : ''}
      </div></details>
    </div>
  </article>`;
}

/* ─────────────────────── the honest record ───────────────────────
   The brain publishes three measures of the same book and they disagree in
   sign: every published signal reads +0.074R, the same trades collapsed to 59
   independent episodes read -0.045R. Quoting only the first is quoting the
   inflated one, because republications of the same move are not independent
   observations. All three are shown, with the episode figure given equal
   weight, which is what the brain's own note asks for.
   ---------------------------------------------------------------------- */
function renderRecord() {
  const b = S.learningBrain, box = el('record');
  if (!b) { box.innerHTML = `<div class="rec-note">The record file could not be read, so no record is shown. A missing file is not a zero.</div>`; return; }

  const m = b.measures || {};
  const everySignal = m.everySignal || b.headline || b.overall || {};
  const episode     = m.episodeAverage || null;
  const firstOf     = m.firstOfEpisode || null;

  const raw       = num(b.rawPublications);
  const collapsed = num(b.totalSamples);          // episodes — NOT headline.samples
  const factor    = num(b.inflationFactor);

  const block = (label, d, note) => {
    if (!d) return '';
    const avg = num(d.avgR), n = num(d.samples), wr = num(d.winRate), ci = d.ci;
    const spansZero = Array.isArray(ci) && ci[0] <= 0 && ci[1] >= 0;
    return `<div class="rec-i" style="min-width:184px">
      <div class="k">${esc(label)}</div>
      <div class="v" style="color:${avg == null ? 'var(--text)' : avg > 0 ? 'var(--up)' : 'var(--down)'}">${avg == null ? '—' : esc(sign(avg) + avg.toFixed(3)) + 'R'}</div>
      <div style="font:500 11px/1.5 var(--mono);color:var(--text-faint);margin-top:6px">
        ${n == null ? '—' : esc(n)} samples${wr == null ? '' : ` · ${esc(Math.round(wr * 100))}% won`}<br>
        ${Array.isArray(ci) ? esc(`[${sign(ci[0])}${ci[0]}, ${sign(ci[1])}${ci[1]}]`) : '—'}
        ${spansZero ? '<br><span style="color:var(--warn)">spans zero</span>' : ''}
      </div>
      <div style="font-size:11.5px;color:var(--text-dim);margin-top:7px;line-height:1.45;max-width:210px">${esc(note)}</div>
    </div>`;
  };

  const eAvg = num(episode && episode.avgR), sAvg = num(everySignal.avgR);
  const disagree = (eAvg != null && sAvg != null && (eAvg > 0) !== (sAvg > 0));

  box.innerHTML = `
    <div class="rec-row" style="gap:30px">
      ${block('Every published signal', everySignal, 'What taking every setup would have returned. Republications of one move are counted separately here.')}
      ${block('Collapsed to episodes', episode, 'The same trades, with republications of a single move counted once. This is the independent unit.')}
      ${block('First of each episode', firstOf, 'Only the first publication of each move. Fewest samples, widest interval.')}
    </div>
    <div class="rec-note">
      ${raw != null && collapsed != null
        ? `${esc(raw)} publications collapse to ${esc(collapsed)} independent moves — a factor of ${esc(factor ?? r2(raw / collapsed))}. Counting the raw number as the sample size would overstate the evidence by that much. `
        : ''}
      ${disagree
        ? `<strong style="color:var(--warn)">The first two measures disagree in sign.</strong> Per signal the book reads ${esc(sign(sAvg) + sAvg.toFixed(3))}R; collapsed to independent moves it reads ${esc(sign(eAvg) + eAvg.toFixed(3))}R. The second is the one that respects independence, so this book is not established as positive. `
        : ''}
      ${esc(b.verdict || '')}
    </div>`;
}

/* ───────────── every signal, judged — collapsible rows ───────────── */
function renderHist() {
  const t = S.shadowTracker, box = el('hist');
  const rows = (t && t.feed) || [];
  if (!rows.length) {
    box.innerHTML = `<div class="empty"><strong>No judged signals yet</strong>Resolved signals appear here with the result and the reason attached.</div>`;
    return;
  }
  const sorted = [...rows].sort((a, b) => (Date.parse(b.firedAt) || 0) - (Date.parse(a.firedAt) || 0));
  box.innerHTML = sorted.map(histRow).join('');
}

function histRow(x) {
  const R = num(x.resultR);
  const st = String(x.status || '').toLowerCase();
  const open = st === 'open' || st === 'running' || R == null;
  const cls = open ? 'open' : R > 0 ? 'win' : 'loss';
  const label = open ? 'OPEN' : R > 0 ? 'WIN' : 'LOSS';
  const mae = num(x.maeR), mfe = num(x.mfeR);

  return `<details class="hrow">
    <summary>
      <span class="h-caret">▸</span>
      <span class="h-res ${cls}">${esc(label)}</span>
      <span>
        <span class="h-pair">${esc(x.pair || '—')}</span>
        <span class="h-when"> ${esc(String(x.direction || '').toUpperCase())} · ${esc(x.firedAt ? ago(Date.parse(x.firedAt)) : '—')}</span>
      </span>
      <span class="h-r ${R == null ? '' : R > 0 ? 'pos' : 'neg'}">${R == null ? 'running' : esc(sign(R) + R.toFixed(2)) + 'R'}</span>
    </summary>
    <div class="h-body">
      <dl class="kv">
        <dt>Entry</dt><dd>${esc(price(x.entry, x.pair))}</dd>
        <dt>Stop</dt><dd>${esc(price(x.sl, x.pair))}</dd>
        <dt>TP1 / TP2 / TP3</dt><dd>${esc(price(x.tp1, x.pair))} · ${esc(price(x.tp2, x.pair))} · ${esc(price(x.tp3, x.pair))}</dd>
        <dt>Furthest reached</dt><dd>${x.tpReached ? esc('TP' + x.tpReached) : 'no target reached'}</dd>
        ${mfe != null ? `<dt>Best it went</dt><dd>${esc(sign(mfe) + mfe.toFixed(2))}R</dd>` : ''}
        ${mae != null ? `<dt>Worst it went</dt><dd>${esc(sign(mae) + mae.toFixed(2))}R</dd>` : ''}
        ${x.confidence != null ? `<dt>Confidence at entry</dt><dd>${esc(x.confidence)}</dd>` : ''}
        ${x.strategies != null ? `<dt>Strategies agreeing</dt><dd>${esc(x.strategies)}</dd>` : ''}
      </dl>
      <p style="margin-top:10px">${open
        ? 'Still running, so it counts for nothing yet. It is listed so the record cannot be read as only the resolved ones.'
        : R > 0
          ? `Closed ${esc(sign(R) + R.toFixed(2))}R.${mae != null && mae < -0.5 ? ` It first went ${esc(mae.toFixed(2))}R against the position, so this win was not comfortable.` : ''}`
          : `Closed ${esc(sign(R) + R.toFixed(2))}R.${mfe != null && mfe < 1 ? ` It never reached TP1 — peak was ${esc(sign(mfe) + mfe.toFixed(2))}R — so this was an entry that did not work, not an exit that gave profit back.` : mfe != null ? ` It reached ${esc(sign(mfe) + mfe.toFixed(2))}R before turning.` : ''}`}</p>
    </div>
  </details>`;
}

/* ─────────────────────────── chrome ─────────────────────────── */
function renderChrome() {
  const feed = S.latestSignals;
  const ts = feed && feed.ts;
  const mins = ts ? (Date.now() - ts) / 60000 : Infinity;
  const pulse = el('pulse');
  pulse.className = 'dot ' + (mins < 90 ? 'live' : mins < 600 ? 'stale' : 'dead');

  el('meta').innerHTML = ts
    ? `feed ${esc(ago(ts))} · ${esc((feed.signals || []).length)} published${feed._src ? ` · ${esc(feed._src)}` : ''}`
    : 'feed unreadable';

  el('foot').innerHTML = `
    <p>This is <strong>base II</strong>, a rebuilt front end running beside the original at
      <a href="/">forexsight-preview.pages.dev</a>. Both read the same published files, so the
      numbers cannot disagree — only the presentation differs.</p>
    <p style="margin-top:8px">Every figure here is read from <code>${esc(FILES.join('.json, '))}.json</code>.
      Where a measurement does not exist, this page says so instead of printing a zero.
      Nothing on this page is a promise about future results.</p>
    ${S.errors.length ? `<p style="margin-top:8px;color:var(--warn)">Could not read: ${esc(S.errors.join(', '))}. Those sections are blank rather than guessed.</p>` : ''}
    <p style="margin-top:8px">Rendered ${esc(new Date(S.at).toUTCString())}</p>`;
}

/* ─────────────────────────── render ───────────────────────────
   Called once per data load. Writes everything, then returns. No observers,
   no timers that touch the DOM, no post-paint patching.
   ----------------------------------------------------------------------- */
function render() {
  const steps = [
    ['voice', renderVoice], ['context', renderContext], ['cards', renderCards],
    ['record', renderRecord], ['hist', renderHist], ['chrome', renderChrome],
  ];
  for (const [name, fn] of steps) {
    // One failing panel must not blank the page — the old base learned this the
    // hard way when a single throw left everything below it empty.
    try { fn(); } catch (e) {
      console.error(`[base II] ${name} failed to render:`, e);
      if (name !== 'chrome') {
        const t = el(name);
        if (t) t.innerHTML = `<div class="empty"><strong>This panel failed to draw</strong>${esc(e.message || String(e))}</div>`;
      }
    }
  }
}

async function cycle() {
  try { await load(); } catch (e) { console.error('[base II] load failed', e); }
  render();
}

cycle();
setInterval(cycle, 120000);                       // 2 min, static files only — zero Cloudflare quota
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.at > 60000) cycle(); });

window.__baseII = S;                              // for verification from the console
