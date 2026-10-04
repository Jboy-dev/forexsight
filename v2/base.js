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
const FILES  = ['latest-signals', 'market-voice', 'learning-brain', 'shadow-tracker', 'self-evaluation', 'strategy-trials', 'active-strategy', 'ledger', 'fx-rates'];

const S = { loaded: false, at: 0, errors: [], cfg: null, lastMsg: null };   // the single source of truth

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
/** How fsApply reads a signal. Kept here so the order layer never has to know
    the feed's field names, and so both stay fixed in one place. */
const READ = {
  pair: s => pick(s, 'pair', 'symbol', 'instrument'),
  dir:  s => pick(s, 'direction', 'side'),
  conf: s => num(pick(s, 'confidence', 'score')),
  weak: s => pick(s, 'weakSignal') === true,
  news: s => (pick(s, 'newsCheck') || {}).verdict,
  at:   s => { const d = pick(s, 'detectedAt'); return d ? Date.parse(d) : 0; },
  r1:   s => {
    const e = num(pick(s, 'entry', 'price')), sl = num(pick(s, 'sl', 'stopLoss')), t1 = num(pick(s, 'tp1'));
    if (e == null || sl == null || t1 == null) return null;
    const risk = Math.abs(e - sl);
    return risk > 0 ? Math.abs(t1 - e) / risk : null;
  },
};

function renderCards() {
  const feed = S.latestSignals, box = el('cards');
  const all = (feed && feed.signals) || [];
  const cfg = S.cfg || {};
  const sigs = window.FS ? window.FS.apply(all, cfg, READ) : all;

  document.body.dataset.density = cfg.density || 'normal';

  if (!all.length) {
    box.innerHTML = `<div class="empty"><strong>No setups published right now</strong>
      ${feed ? `The feed is live and ${esc(ago(feed.ts))}; it simply contains nothing that passed. An empty feed is a result, not a fault.` : 'The feed could not be read from either source.'}</div>`;
    return;
  }
  if (!sigs.length) {
    // Filtered to nothing is a different thing from published nothing, and
    // saying so is the difference between "it is broken" and "your orders are
    // strict". The feed count is shown so the distinction is checkable.
    box.innerHTML = `<div class="empty"><strong>Your orders filtered out all ${esc(all.length)} setups</strong>
      Nothing published right now matches what you asked for. Type <code>reset</code> to see everything again.</div>`;
    return;
  }
  box.innerHTML = sigs.map(card).join('');
  // Warm the chart cache for what is on screen, so the first tap paints
  // immediately instead of waiting on a fetch.
  if (window.FSCHART && window.FSCHART.prefetch) {
    try { window.FSCHART.prefetch(sigs.map(x => pick(x, 'pair')).filter(Boolean)); } catch (_) {}
  }
  if (all.length !== sigs.length) {
    box.insertAdjacentHTML('beforeend',
      `<div class="empty" style="padding:16px"><strong>${esc(all.length - sigs.length)} hidden by your orders</strong>
       ${esc(sigs.length)} of ${esc(all.length)} shown. Type <code>reset</code> to see them all.</div>`);
  }
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

  // Levels are tap-to-copy. The copied text is the plain number with no
  // thousands separators or currency marks, because it is going straight into a
  // broker ticket where anything else is a rejected order.
  const lvl = (k, v, rr, cls) => {
    const shown = price(v, pair);
    const copyable = shown !== '—';
    return `<div class="lvl ${cls}${copyable ? ' copyable' : ''}"${copyable ? ` data-copy="${esc(shown)}" data-label="${esc(k)}" role="button" tabindex="0" title="Tap to copy ${esc(k)}"` : ''}>
      <div class="lvl-k">${esc(k)}</div>
      <div class="lvl-v">${esc(shown)}</div>
      <div class="lvl-d">${rr != null ? esc(rr.toFixed(2) + 'R') : '&nbsp;'}</div></div>`;
  };

  return `<article class="card ${buy ? 'buy' : 'sell'}" data-sigkey="${esc(sigKey(s))}">
    <div class="c-head c-chart" role="button" tabindex="0" title="Open the chart for this setup">
      <div>
        <div class="c-pair">${esc(pair)}</div>
        <div class="c-sub">${esc(pick(s, 'detectedAt') ? ago(Date.parse(pick(s, 'detectedAt'))) : 'time unknown')}${barAge != null ? ` · bar ${esc(barAge)}m old` : ''}</div>
      </div>
      <span class="c-dir ${buy ? 'buy' : 'sell'}">${esc(dir || '?')}</span>
      <span class="c-chart-i" aria-hidden="true">chart</span>
    </div>
    <div class="c-levels five">
      ${lvl('Entry', entry, null, '')}
      ${lvl('Stop', sl, risk ? -1 : null, 'sl')}
      ${lvl('TP1', tp1, r1, 'tp')}
      ${lvl('TP2', tp2, r2v, 'tp')}
      ${lvl('TP3', tp3, r3, 'tp')}
    </div>
    <div class="c-body">
      <div class="chips">${chips.join('')}</div>
      <div class="c-why">${esc(why[0] || '')}</div>
      ${why.length > 1 ? `<details class="fold why-fold"><summary>Why this setup</summary>
        <div class="fold-in">${esc(why.slice(1).join(' '))}</div></details>` : ''}

      <details class="fold" ${S.cfg && S.cfg.expand ? "open" : ""}><summary>The whole ladder and what it pays</summary><div class="fold-in">
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

      ${trackerBlock(s)}
      ${moneyBlock(s)}

      <details class="fold" ${S.cfg && S.cfg.expand ? "open" : ""}><summary>Costs, news and the modelled outcome</summary><div class="fold-in">
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

  return `<details class="hrow" ${S.cfg && S.cfg.expand ? "open" : ""}>
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









/* ──────────── staying fresh when the mirror falls behind ────────────
   The feed is published by GitHub Actions. Measured over 56 hours, the
   COMBINED gap between publishes across both workflows has a median of 188
   minutes and a worst case of 400 — GitHub throttles scheduled workflows hard
   on a free account, whatever the cron says. A quarter-hourly cron does not
   mean every quarter hour.

   So when the published feed goes stale the page asks the live endpoint
   directly, which computes from current bars on demand. That endpoint is the
   expensive path — it is what the static-first work moved away from — so it is
   used only when it is actually needed:

     · only when the mirror is older than STALE_MIN
     · at most once every LIVE_COOLDOWN
     · only while the tab is visible
     · never on a weekend, when the market is shut and nothing has changed

   At worst that is a handful of requests per session against a 100,000/day
   limit, instead of the 51,504 a single always-polling tab once used.
   ------------------------------------------------------------------- */
const STALE_MIN = 45;
const LIVE_COOLDOWN = 10 * 60 * 1000;
let _lastLive = 0;

function marketLikelyOpen() {
  const d = new Date();
  const day = d.getUTCDay(), h = d.getUTCHours();
  if (day === 6) return false;                       // Saturday
  if (day === 0 && h < 21) return false;             // Sunday before the open
  if (day === 5 && h >= 21) return false;            // after Friday's close
  return true;
}

async function refreshIfStale() {
  const feed = S.latestSignals;
  if (!feed || !feed.ts) return;
  const ageMin = (Date.now() - feed.ts) / 60000;
  if (ageMin < STALE_MIN) return;
  if (document.hidden) return;
  if (Date.now() - _lastLive < LIVE_COOLDOWN) return;
  // Crypto trades at weekends; everything else does not. If the only thing
  // that could have changed is shut, a live call buys nothing.
  const cryptoOnly = !marketLikelyOpen();
  _lastLive = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch('/api/check-signals?_b=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!r.ok) return;
    const j = await r.json();
    if (!j || typeof j !== 'object') return;
    // The same rule as everywhere else: a feed with signals beats an empty one,
    // then newest wins. A live call returning nothing must not wipe the board.
    const haveNow = (feed.signals || []).length;
    const haveNew = (j.signals || []).length;
    if (haveNew === 0 && haveNow > 0) {
      S.liveNote = `Checked live ${cryptoOnly ? '(weekend — crypto only)' : ''}: nothing new qualifies, so the published setups are kept.`;
      render();
      return;
    }
    if ((j.ts || 0) > (feed.ts || 0)) {
      j._src = 'live';
      S.latestSignals = j;
      S.liveNote = 'Refreshed from the live engine because the published feed had gone stale.';
      render();
    }
  } catch (_) { /* offline or blocked — the published feed is still shown */ }
}

/* ──────────────── staying up to date ────────────────
   An installed app must not sit on an old build. The worker claims control as
   soon as it activates and posts a message; the page reloads once when that
   happens, and checks for a new worker whenever it is brought back to the
   foreground — which is the moment a phone app is actually looked at.
   ----------------------------------------------------------------------- */
function installUpdates() {
  if (window._fsUpdInstalled || !('serviceWorker' in navigator)) return;
  window._fsUpdInstalled = true;
  let reloading = false;

  const refresh = () => {
    if (reloading) return;
    reloading = true;
    // A reload here is safe: orders, balances and per-signal amounts all live
    // in localStorage, so nothing the person set is lost.
    setTimeout(() => location.reload(), 300);
  };

  navigator.serviceWorker.addEventListener('controllerchange', refresh);
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'sw-updated') refresh();
  });

  const check = () => {
    navigator.serviceWorker.getRegistration().then(r => { if (r) r.update().catch(() => {}); }).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  setInterval(check, 15 * 60 * 1000);
  check();
}

/* ──────────────── answers clear themselves ────────────────
   An answer you have finished with is clutter. Each one gets an explicit
   close button AND a timer, and the timer restarts on any real interaction
   with the page — so nothing disappears while it is being read.
   ----------------------------------------------------------------------- */
// How long an answer stays before clearing itself. ?answerLife=3 shortens it
// so the behaviour can actually be tested rather than assumed — the first
// version of this was gated on an idle timer that re-armed for a FULL window on
// every touch, so it could postpone forever and never fired at all.
const ANSWER_LIFE_MS = (() => {
  const q = new URLSearchParams(location.search).get('answerLife');
  const n = q ? parseFloat(q) * 1000 : NaN;
  return isFinite(n) && n >= 500 ? n : 45000;
})();

let _msgTimer = null, _calcTimer = null;

/**
 * Clears an answer a set time after it APPEARED. Interacting with the thing
 * that produced it restarts the clock; anything else does not. Deterministic,
 * so "it should go away on its own" is a claim that can be checked.
 */
function armAutoDismiss() {
  clearTimeout(_msgTimer);
  if (!S.lastMsg) return;
  const shownFor = S.lastMsg;                       // identity, not a timestamp
  _msgTimer = setTimeout(() => {
    if (S.lastMsg !== shownFor) return;             // a newer answer replaced it
    S.lastMsg = null;
    try { render(); } catch (_) {}
  }, ANSWER_LIFE_MS);
}

function armCalcDismiss() {
  clearTimeout(_calcTimer);
  _calcTimer = setTimeout(() => {
    const o = el('calc-out');
    if (!o || !o.innerHTML) return;
    // Do not clear while the person is actually typing in the box.
    if (document.activeElement && document.activeElement.id === 'calc-in') { armCalcDismiss(); return; }
    o.innerHTML = '';
  }, ANSWER_LIFE_MS);
}

function installIdle() {
  if (window._fsIdleInstalled) return;
  window._fsIdleInstalled = true;
  // Typing a new order restarts the clock on whatever is currently shown,
  // because you are plainly still using it.
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.id === 'cmd-input' || e.target.id === 'calc-in')) {
      armAutoDismiss(); armCalcDismiss();
    }
  }, { passive: true });
}


/** Per-signal balance edits. Delegated from document because renderCards()
    replaces innerHTML, so a listener bound to a card dies on the next cycle. */
function installSignalBalance() {
  if (window._fsSigBalInstalled) return;
  window._fsSigBalInstalled = true;

  const put = (key, patch) => {
    S.cfg.perSignal = S.cfg.perSignal || {};
    const cur = S.cfg.perSignal[key];
    const base = (typeof cur === 'number') ? { balance: cur } : (cur || {});
    const next = { ...base, ...patch };
    // Anything matching the account defaults is not an override; drop it so the
    // signal follows the account again rather than silently pinning itself.
    if (next.balance === S.cfg.balance) delete next.balance;
    if (next.riskPct === S.cfg.riskPct) delete next.riskPct;
    if (Object.keys(next).length) S.cfg.perSignal[key] = next;
    else delete S.cfg.perSignal[key];
    if (window.FS) window.FS.save(S.cfg);
    render();
  };

  document.addEventListener('change', (e) => {
    const el0 = e.target;
    if (!el0 || !el0.classList) return;
    const key = el0.dataset && el0.dataset.sigkey;
    if (!key) return;
    const v = parseFloat(el0.value);

    if (el0.classList.contains('mny-bal')) {
      if (v > 0) put(key, { balance: v });
    } else if (el0.classList.contains('mny-pct')) {
      if (v > 0 && v <= 100) put(key, { riskPct: v });
    } else if (el0.classList.contains('mny-amt')) {
      // Cash at risk is the most direct way to say it. The percent is derived
      // from whatever balance this signal is using, so the three stay consistent.
      const cur = (S.cfg.perSignal || {})[key];
      const o = (typeof cur === 'number') ? { balance: cur } : (cur || {});
      const bal = o.balance != null ? o.balance : S.cfg.balance;
      if (v > 0 && bal > 0) put(key, { riskPct: +((v / bal) * 100).toFixed(4) });
    }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.mny-reset');
    if (!b) return;
    if (S.cfg.perSignal) delete S.cfg.perSignal[b.dataset.sigkey];
    if (window.FS) window.FS.save(S.cfg);
    render();
  });

  document.addEventListener('keydown', (e) => {
    const c = e.target && e.target.classList;
    if (c && (c.contains('mny-bal') || c.contains('mny-pct') || c.contains('mny-amt')) && e.key === 'Enter') e.target.blur();
  });
}


/* ─────────── open a signal's chart ───────────
   Delegated from document: renderCards() replaces innerHTML every cycle, so a
   listener bound to a card would be destroyed two minutes later.
   ----------------------------------------------------------------------- */
function installChart() {
  if (window._fsChartInstalled || !window.FSCHART) return;
  window._fsChartInstalled = true;

  // When prefetched bars land, redraw so the live tracker on each card shows a
  // real price instead of the "not loaded" placeholder it rendered with.
  window.addEventListener('fs-bars-ready', () => { try { render(); } catch (_) {} });

  const openFor = (card) => {
    const key = card.dataset.sigkey;
    const all = (S.latestSignals && S.latestSignals.signals) || [];
    const sig = all.find(x => sigKey(x) === key);
    if (sig) window.FSCHART.open(sig, pick);
  };

  document.addEventListener('click', (e) => {
    // A tap on a copyable level copies it; it must not also open the chart.
    if (e.target.closest('.lvl.copyable') || e.target.closest('details') || e.target.closest('input') || e.target.closest('button')) return;
    const head = e.target.closest('.c-chart');
    if (!head) return;
    const card = head.closest('.card');
    if (card) openFor(card);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest && e.target.closest('.c-chart');
    if (!head) return;
    e.preventDefault();
    const card = head.closest('.card');
    if (card) openFor(card);
  });
}


/* ─────────────── where price is NOW, against the levels ───────────────
   The card showed what a setup pays and risks, but never where price had
   actually got to. That is the thing you look at most: is it running, is it
   about to take a target, is it about to stop out.

   The live price comes from the same published bars the chart draws, so this
   agrees with the chart and with the engine. When no bar is available it says
   so rather than implying a position it cannot see.
   ----------------------------------------------------------------------- */
const NEAR_R = 0.25;          // within a quarter of the risk counts as "about to hit"

function livePrice(pair) {
  const c = window.FSCHART && window.FSCHART.cached && window.FSCHART.cached(pair);
  if (!c || !c.length) return null;
  const last = c[c.length - 1];
  return last && typeof last.c === 'number' ? { price: last.c, at: last.t } : null;
}

function trackerBlock(sig) {
  const pair = pick(sig, 'pair');
  const live = livePrice(pair);
  const entry = num(pick(sig, 'entry')), sl = num(pick(sig, 'sl'));
  const tp1 = num(pick(sig, 'tp1')), tp2 = num(pick(sig, 'tp2')), tp3 = num(pick(sig, 'tp3'));
  const dir = String(pick(sig, 'direction') || '').toUpperCase();
  if (entry == null || sl == null) return '';

  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return '';
  const sign = (dir === 'BUY' || dir === 'LONG') ? 1 : -1;

  if (!live) {
    return `<div class="trk trk-none">Live price not loaded for ${esc(pair)} yet — open the chart to fetch it.</div>`;
  }

  // Running R: how far price has travelled in your favour, in units of risk.
  const runR = ((live.price - entry) * sign) / risk;
  const toLevel = (lvl) => (lvl == null ? null : ((lvl - live.price) * sign) / risk);

  // Which level is closest in the direction it would be hit.
  const cands = [
    { name: 'stop', price: sl, r: -1, away: Math.abs(((sl - live.price) * sign) / risk), bad: true },
    tp1 != null ? { name: 'TP1', price: tp1, r: toLevel(tp1), away: Math.abs(toLevel(tp1)) } : null,
    tp2 != null ? { name: 'TP2', price: tp2, r: toLevel(tp2), away: Math.abs(toLevel(tp2)) } : null,
    tp3 != null ? { name: 'TP3', price: tp3, r: toLevel(tp3), away: Math.abs(toLevel(tp3)) } : null,
  ].filter(Boolean).sort((a, b) => a.away - b.away);
  const nearest = cands[0];
  const imminent = nearest && nearest.away <= NEAR_R;

  // Position along the whole ladder, stop at 0 and TP3 at 100.
  const lo = -1, hi = tp3 != null ? toLevel(tp3) + runR : 3.5;
  const span = hi - lo;
  const atPct = span > 0 ? Math.max(0, Math.min(100, ((runR - lo) / span) * 100)) : 50;
  const markPct = (lvl) => {
    const r = lvl == null ? null : ((lvl - entry) * sign) / risk;
    return r == null || span <= 0 ? null : Math.max(0, Math.min(100, ((r - lo) / span) * 100));
  };

  const ageMin = Math.round((Date.now() - live.at) / 60000);
  const cls = runR > 0 ? 'up' : runR < 0 ? 'dn' : '';

  return `<div class="trk${imminent ? ' trk-near' : ''}">
    <div class="trk-top">
      <span class="trk-state ${cls}">${esc(dir)} &middot; ${esc(sign > 0 ? 'running' : 'running')} ${esc((runR >= 0 ? '+' : '') + runR.toFixed(2))}R</span>
      <span class="trk-px">${esc(price(live.price, pair))}<i>${ageMin < 90 ? esc(ageMin) + 'm ago' : esc(Math.round(ageMin / 60)) + 'h ago'}</i></span>
    </div>
    <div class="trk-bar">
      ${[['sl', sl], ['t1', tp1], ['t2', tp2], ['t3', tp3]].map(([k, v]) => {
        const p2 = markPct(v);
        return p2 == null ? '' : `<span class="trk-mark trk-${k}" style="left:${p2}%"></span>`;
      }).join('')}
      <span class="trk-fill" style="width:${atPct}%"></span>
      <span class="trk-now" style="left:${atPct}%"></span>
    </div>
    <div class="trk-foot">
      ${imminent
        ? `<b class="trk-alert">About to hit ${esc(nearest.name)}</b> — ${esc(nearest.away.toFixed(2))}R away at ${esc(price(nearest.price, pair))}.`
        : `Nearest level is <b>${esc(nearest.name)}</b>, ${esc(nearest.away.toFixed(2))}R away at ${esc(price(nearest.price, pair))}.`}
      ${runR <= -1 ? ' <b class="trk-alert">Stop level reached.</b>' : ''}
    </div>
  </div>`;
}

/* ─────────── what this signal is worth, in your money ───────────
   Shown on every card, not hidden behind a fold, because "how much do I make
   and how much do I lose" is the first question and should not need a click.
   ----------------------------------------------------------------------- */
/** A stable id for a signal, so a per-signal balance survives a re-render. */
function sigKey(sig) {
  return [pick(sig, 'pair'), pick(sig, 'direction'), num(pick(sig, 'entry')) ?? ''].join('|');
}

function moneyBlock(sig) {
  if (!window.FSCALC) return '';
  const base = S.cfg || {};
  const C = window.FSCALC;
  // A signal may carry its own balance. Everything else — risk percent,
  // currency — still comes from the account, so only the amount differs.
  const key = sigKey(sig);
  const ov = (base.perSignal || {})[key];
  // An override may be a bare number (an older saved balance) or an object
  // carrying balance and/or risk. Both are read, so nothing saved earlier breaks.
  const o = (typeof ov === 'number') ? { balance: ov } : (ov || {});
  const cfg = {
    ...base,
    balance: o.balance != null ? o.balance : base.balance,
    riskPct: o.riskPct != null ? o.riskPct : base.riskPct,
  };
  const own = o.balance != null || o.riskPct != null;
  const r = C.calcSignal(sig, cfg, S.fxRates);
  if (!r) return '';
  const M = (v) => C.money(v, r.currency);

  if (!r.rateKnown) {
    return `<div class="mny"><div class="mny-k">Your money</div>
      <p class="mny-warn">This pair settles in ${esc(r.quote)}, and I have no ${esc(r.quote)}→${esc(r.currency)} rate right now, so I will not show you a converted figure. It would be a guess.</p></div>`;
  }

  const best = r.best, worst = r.worst;
  return `<div class="mny">
    <div class="mny-k">Your money${own ? ' <em class="mny-own">just this signal</em>' : ''}
      <em class="mny-at">${esc(C.SYM[r.currency] || '')}${esc(Number(r.balance).toLocaleString())} at ${esc(+r.riskPct)}%</em></div>
    <div class="mny-two">
      <div class="mny-win"><span>if it runs to TP3</span><b>${esc(M(best.money))}</b></div>
      <div class="mny-lose"><span>if the stop is hit</span><b>${esc(M(worst.money))}</b></div>
    </div>

    <details class="fold mny-fold"><summary>Change the amount, and see each target</summary>
      <div class="fold-in">
        <div class="mny-edits">
          <span class="mny-edit" title="Balance used for this signal">
            <i>${esc(C.SYM[r.currency] || '')}</i>
            <input class="mny-bal" type="number" inputmode="decimal" min="1" step="any"
                   value="${esc(r.balance)}" data-sigkey="${esc(key)}" aria-label="Balance for this signal">
            <em>balance</em>
          </span>
          <span class="mny-edit" title="Percent of that balance risked here">
            <input class="mny-pct" type="number" inputmode="decimal" min="0.01" max="100" step="0.1"
                   value="${esc(+r.riskPct)}" data-sigkey="${esc(key)}" aria-label="Risk percent for this signal">
            <i>%</i><em>risk</em>
          </span>
          <span class="mny-edit" title="Or set the cash you are willing to lose; the percent follows">
            <i>${esc(C.SYM[r.currency] || '')}</i>
            <input class="mny-amt" type="number" inputmode="decimal" min="0.01" step="any"
                   value="${esc(+r.riskAmount.toFixed(2))}" data-sigkey="${esc(key)}" aria-label="Risk amount for this signal">
            <em>at risk</em>
          </span>
          ${own ? `<button class="mny-reset" data-sigkey="${esc(key)}" title="Use the account defaults again">reset</button>` : ''}
        </div>
        ${r.ladder && r.ladder.length ? `<div class="mny-steps">
          ${r.ladder.map(st => `<div class="mny-step">
            <span class="ms-n">${esc(st.name)}</span>
            <span class="ms-p">${esc(price(st.price, pick(sig, 'pair')))}</span>
            <span class="ms-b">+${esc(M(st.bankedMoney))}<i>banked</i></span>
            <span class="ms-r">${esc(M(st.runningMoney))}<i>total so far</i></span>
          </div>`).join('')}
          <div class="mny-note">A third closes at each target. These are what you take at each one, and the running total once you have.</div>
        </div>` : ''}
      </div></details>
  </div>`;
}

/* ───────────────────── the calculator pane ───────────────────── */
function renderCalc() {
  const box = el('calc');
  if (!box || !window.FSCALC) return;
  const C = window.FSCALC, cfg = S.cfg || {};
  const ctx = { balance: +cfg.balance, riskPct: +cfg.riskPct, currency: cfg.currency };
  const M = (v) => C.money(v, ctx.currency);
  const perR = ctx.balance * ctx.riskPct / 100;

  const sigs = (S.latestSignals && S.latestSignals.signals) || [];
  const rows = sigs.map(sg => {
    const r = C.calcSignal(sg, cfg, S.fxRates);
    if (!r) return '';
    return `<tr><td>${esc(pick(sg, 'pair'))} ${esc(String(pick(sg, 'direction') || '').toUpperCase())}</td>
      <td class="pos">${esc(M(r.best.money))}</td>
      <td class="neg">${esc(M(r.worst.money))}</td>
      <td>${esc(M(r.outcomes[1] ? r.outcomes[1].money : null))}</td></tr>`;
  }).join('');

  box.innerHTML = `
    <div class="record" style="margin-top:0">
      <div class="acct">
        <label class="acct-f"><span>Account balance</span>
          <div class="acct-in"><i>${esc(C.SYM[ctx.currency] || '')}</i>
            <input id="in-balance" type="number" inputmode="decimal" min="1" step="any" value="${esc(ctx.balance)}" aria-label="Account balance"></div>
        </label>
        <label class="acct-f"><span>Risk per trade</span>
          <div class="acct-in"><input id="in-risk" type="number" inputmode="decimal" min="0.01" max="100" step="0.1" value="${esc(ctx.riskPct)}" aria-label="Risk percent"><i>%</i></div>
        </label>
        <label class="acct-f"><span>Or cash at risk</span>
          <div class="acct-in"><i>${esc(C.SYM[ctx.currency] || '')}</i>
            <input id="in-riskamt" type="number" inputmode="decimal" min="0.01" step="any" value="${esc(+perR.toFixed(2))}" aria-label="Risk amount"></div>
        </label>
        <label class="acct-f"><span>Currency</span>
          <div class="acct-in"><select id="in-ccy" aria-label="Account currency">
            ${(S.fxRates && S.fxRates.toAccount ? Object.keys(S.fxRates.toAccount) : ['GBP', 'USD', 'EUR'])
                .map(c => `<option value="${c}"${c === ctx.currency ? ' selected' : ''}>${c}</option>`).join('')}
          </select></div>
        </label>
        <div class="acct-r"><span>That is your 1R</span><b>${esc(M(perR))}</b>
          <i>what one stop-out costs</i></div>
      </div>
      <input id="in-risk-range" type="range" min="0.1" max="5" step="0.1" value="${esc(Math.min(5, ctx.riskPct))}" aria-label="Risk percent slider">
      <div class="acct-hint">Drag for risk, or type <code>balance 5000</code> in the order bar. Every money figure on every signal updates immediately.</div>
    </div>

    <div class="cmd" style="margin-top:14px">
      <form id="calc-form" autocomplete="off">
        <span class="cmd-caret">=</span>
        <input id="calc-in" type="text" spellcheck="false" placeholder="type a calculation — 2% of 5000 · 3R · 8 losses in a row · recover from 20% · size with a 20 pip stop" aria-label="Calculate">
        <button type="submit" class="cmd-go">Work it out</button>
      </form>
      <div id="calc-out"></div>
    </div>

    ${rows ? `<h2 class="sec">Every live signal, in ${esc(ctx.currency)}</h2>
    <div class="record" style="margin-top:0">
      <table class="kb-t"><tr><th>signal</th><th>runs to TP3</th><th>stopped out</th><th>TP1 then flat</th></tr>${rows}</table>
      <div class="rec-note">At ${esc(ctx.riskPct)}% of ${esc(M(ctx.balance))}, every stop-out costs the same ${esc(M(perR))} — that is the point of sizing from the stop. What differs is the upside.</div>
    </div>` : `<div class="empty" style="margin-top:14px"><strong>No live signals to price</strong>The calculator above still works on any numbers you type.</div>`}

    <h2 class="sec">What you can type</h2>
    <div class="record" style="margin-top:0"><ul class="kb-l">
      ${C.RULES.map(r => `<li><code>${esc(r.help.split('—')[0].trim())}</code> — ${esc(r.help.split('—')[1] || '')}</li>`).join('')}
    </ul></div>`;

  const form = el('calc-form'), input = el('calc-in');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); runCalc(input.value, ctx); });
  if (input) input.addEventListener('input', () => runCalc(input.value, ctx));

  // Editing any of these rewrites every money figure on the site, including the
  // per-signal amounts on the Signals pane, because they all read the same cfg.
  const commit = (patch) => {
    Object.assign(S.cfg, patch);
    if (window.FS) window.FS.save(S.cfg);
    render();
    const f = el('calc-in'); if (f && input) f.value = input.value;
  };
  const bal = el('in-balance'), rsk = el('in-risk'), ccy = el('in-ccy'), rng = el('in-risk-range');
  if (bal) bal.addEventListener('change', () => { const v = parseFloat(bal.value); if (v > 0) commit({ balance: v }); });
  if (rsk) rsk.addEventListener('change', () => { const v = parseFloat(rsk.value); if (v > 0 && v <= 100) commit({ riskPct: v }); });
  if (ccy) ccy.addEventListener('change', () => commit({ currency: ccy.value }));
  const amt = el('in-riskamt');
  if (amt) amt.addEventListener('change', () => {
    // Setting the cash you are willing to lose sets the percent, because the
    // percent is the thing the rest of the maths actually uses.
    const v = parseFloat(amt.value);
    const b = parseFloat(bal ? bal.value : ctx.balance) || ctx.balance;
    if (v > 0 && b > 0) commit({ riskPct: +((v / b) * 100).toFixed(4) });
  });
  if (rng) {
    // Live preview while dragging, committed on release — so the page is not
    // re-rendered on every pixel of the drag.
    rng.addEventListener('input', () => {
      const v = parseFloat(rng.value);
      const live = el('in-risk'); if (live) live.value = v;
      const r1 = document.querySelector('.acct-r b');
      if (r1) r1.textContent = window.FSCALC.money(ctx.balance * v / 100, ctx.currency);
    });
    rng.addEventListener('change', () => commit({ riskPct: parseFloat(rng.value) }));
  }
}

function runCalc(text, ctx) {
  const out = el('calc-out'); if (!out) return;
  if (!String(text || '').trim()) { out.innerHTML = ''; return; }
  const r = window.FSCALC.calcDynamic(text, ctx);
  if (!r) {
    armCalcDismiss();
    out.innerHTML = `<pre class="cmd-msg bad">I cannot work that one out. Try one of the forms listed below — or ask Research for the arithmetic behind it.</pre>`;
    return;
  }
  out.innerHTML = `<div class="calc-ans">
    <button class="ans-x" data-dismiss="calc" aria-label="Clear this answer" title="Clear">&times;</button>
    <div class="calc-t">${esc(r.title)}</div>
    <div class="calc-v">${esc(r.value)}</div>
    <ol class="calc-w">${r.work.map(w => `<li>${esc(w)}</li>`).join('')}</ol>
  </div>`;
  const x = out.querySelector('[data-dismiss="calc"]');
  if (x) x.addEventListener('click', () => { out.innerHTML = ''; const i = el('calc-in'); if (i) { i.value = ''; i.focus(); } });
  armCalcDismiss();
}


/* ─────────────────── drag to rearrange ───────────────────
   Tabs reorder along the bar; sections reorder within their pane. Both persist.
   Bound once: the panes are shown and hidden rather than rebuilt, so the
   handlers survive — and renderCards() only ever replaces the INSIDE of a
   segment, never the segment itself, so the drag targets are stable.
   ----------------------------------------------------------------------- */
function installReorder() {
  if (window._fsRoInstalled || !window.FSREORDER) return;
  window._fsRoInstalled = true;

  const tabsIn = document.getElementById('tabs-in');
  if (tabsIn) {
    window.FSREORDER.make(tabsIn, {
      itemSelector: '.tab',
      axis: 'x',
      onSave: (ids) => {
        S.cfg.tabOrder = ids;
        if (window.FS) window.FS.save(S.cfg);
        S.lastMsg = { ok: true, msg: 'Tab order saved: ' + ids.join(' · ') };
        render();
      },
    });
  }

  for (const segs of document.querySelectorAll('.segs')) {
    const pane = segs.dataset.segs;
    window.FSREORDER.make(segs, {
      itemSelector: '.seg',
      handleSelector: '.seg-grip, h2.sec',   // drag by the heading, not the content
      axis: 'y',
      onSave: (ids) => {
        S.cfg.segOrder = S.cfg.segOrder || {};
        S.cfg.segOrder[pane] = ids;
        if (window.FS) window.FS.save(S.cfg);
        S.lastMsg = { ok: true, msg: `Layout saved for ${pane}: ` + ids.join(' · ') };
        render();
      },
    });
  }
}

/** Re-applies saved orders. Safe to call on every render — appendChild of an
    element already in position is a no-op, so this does not thrash layout. */
function applySavedOrder() {
  if (!window.FSREORDER) return;
  const tabsIn = document.getElementById('tabs-in');
  if (tabsIn && Array.isArray(S.cfg && S.cfg.tabOrder)) {
    window.FSREORDER.apply(tabsIn, '.tab', S.cfg.tabOrder);
  }
  const so = (S.cfg && S.cfg.segOrder) || {};
  for (const segs of document.querySelectorAll('.segs')) {
    const order = so[segs.dataset.segs];
    if (Array.isArray(order)) window.FSREORDER.apply(segs, '.seg', order);
  }
}

/* ─────────────────────────── tabs ───────────────────────────
   Four panes instead of one long scroll. The active pane is part of the
   persisted config, so it survives a reload and a reopen — and it is an order
   too, so "ledger" or "tab market" works from the command bar.

   Panes are shown and hidden with a class, never unmounted. Unmounting would
   mean re-rendering on every switch and would throw away the open/closed state
   of every <details> inside — which is the same mistake the old base made.
   ----------------------------------------------------------------------- */
const PANES = ['signals', 'market', 'calc', 'history', 'ledger', 'tested'];

function applyTab() {
  const want = PANES.includes(S.cfg && S.cfg.tab) ? S.cfg.tab : 'signals';
  for (const p of document.querySelectorAll('.pane')) {
    p.classList.toggle('on', p.dataset.pane === want);
  }
  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === want;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

function installTabs() {
  if (window._fsTabsInstalled) return;
  window._fsTabsInstalled = true;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    // A click synthesised at the end of a drag must not also switch pane.
    if (document.querySelector('.ro-dragging')) return;
    S.cfg.tab = b.dataset.tab;
    if (window.FS) window.FS.save(S.cfg);
    applyTab();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  });
}

/** Counts on the tabs, so you can see where something is without opening it. */
function renderTabCounts() {
  const n = (S.latestSignals && S.latestSignals.signals) || [];
  const shown = window.FS ? window.FS.apply(n, S.cfg || {}, READ).length : n.length;
  const a = el('tab-n-signals'); if (a) a.textContent = shown ? String(shown) : '';
  const L = S.ledger;
  const b = el('tab-n-ledger');
  if (b) b.textContent = L && L.coverage ? String(L.coverage.total) : '';
  const h = el('tab-n-history');
  if (h) h.textContent = L && Array.isArray(L.history) ? String(L.history.length) : '';
  applyTab();
}


/* ─────────────────────── History ───────────────────────
   Every signal this site has ever published and what became of it, filterable
   by outcome. Not a window of the most recent few — the whole book, which is
   why the archive exists.
   ----------------------------------------------------------------------- */
function renderHistory() {
  const L = S.ledger, box = el('history');
  if (!box) return;
  if (!L || !Array.isArray(L.history)) {
    box.innerHTML = `<div class="empty"><strong>History not published yet</strong>The ledger has not been built with a full history.</div>`;
    return;
  }

  const rows = L.history;
  const cfg = S.cfg || {};
  const filter = cfg.histFilter || 'all';

  const isWin = (x) => typeof x.resultR === 'number' && x.resultR > 0;
  const isLoss = (x) => typeof x.resultR === 'number' && x.resultR <= 0;
  const isOpen = (x) => x.resultR == null;

  const counts = {
    all: rows.length,
    won: rows.filter(isWin).length,
    lost: rows.filter(isLoss).length,
    open: rows.filter(isOpen).length,
    target: rows.filter(x => (x.tpReached || 0) >= 1).length,
  };

  let shown = rows;
  if (filter === 'won') shown = rows.filter(isWin);
  else if (filter === 'lost') shown = rows.filter(isLoss);
  else if (filter === 'open') shown = rows.filter(isOpen);
  else if (filter === 'target') shown = rows.filter(x => (x.tpReached || 0) >= 1);

  // Respect the pair/direction orders already in force, so "only gold" narrows
  // the history too rather than the page disagreeing with itself.
  if (cfg.pairs && cfg.pairs.length) {
    shown = shown.filter(x => {
      const p = String(x.pair || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return cfg.pairs.some(t => p.includes(String(t).toUpperCase().replace(/[^A-Z0-9]/g, '')));
    });
  }
  if (cfg.direction) shown = shown.filter(x => String(x.direction || '').toUpperCase().startsWith(cfg.direction[0]));

  const resolved = shown.filter(x => typeof x.resultR === 'number');
  const sumR = resolved.reduce((a, b) => a + b.resultR, 0);
  const wins = resolved.filter(x => x.resultR > 0).length;

  const chip = (k, label, n, cls) =>
    `<button class="hf${filter === k ? ' on' : ''}${cls ? ' ' + cls : ''}" data-hfilter="${k}">${esc(label)} <span>${esc(n)}</span></button>`;

  box.innerHTML = `
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:26px">
        <div class="rec-i"><div class="k">Signals in view</div><div class="v">${esc(shown.length)}</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">of ${esc(rows.length)} ever published</div></div>
        <div class="rec-i"><div class="k">Won / lost</div>
          <div class="v" style="font-size:22px"><span style="color:var(--up)">${esc(wins)}</span> / <span style="color:var(--down)">${esc(resolved.length - wins)}</span></div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">${resolved.length ? esc(Math.round((wins / resolved.length) * 100)) + '% of resolved' : 'none resolved'}</div></div>
        <div class="rec-i"><div class="k">Total</div>
          <div class="v" style="color:${sumR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(sumR) + sumR.toFixed(1))}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">sum of every resolved result</div></div>
      </div>
    </div>

    <div class="hfilters">
      ${chip('all', 'Everything', counts.all)}
      ${chip('won', 'Won', counts.won, 'win')}
      ${chip('lost', 'Lost', counts.lost, 'loss')}
      ${chip('target', 'Hit a target', counts.target)}
      ${chip('open', 'Still open', counts.open, 'open')}
    </div>

    ${shown.length ? `<div class="hist">${shown.map(historyRow).join('')}</div>`
      : `<div class="empty"><strong>Nothing matches</strong>No signals in this view. Try Everything, or clear your orders.</div>`}

    <p style="font-size:11.5px;color:var(--text-faint);margin-top:14px;line-height:1.6">
      Covering ${esc(String(L.coverage.from).slice(0, 10))} to ${esc(String(L.coverage.to).slice(0, 10))}.
      A signal counts as <strong>won</strong> if it closed positive — which includes setups that timed out
      slightly ahead without reaching a target. ${esc(counts.target)} of ${esc(counts.all)} actually reached TP1 or better.</p>`;

  for (const b of box.querySelectorAll('[data-hfilter]')) {
    b.addEventListener('click', () => {
      S.cfg.histFilter = b.dataset.hfilter;
      if (window.FS) window.FS.save(S.cfg);
      renderHistory();
    });
  }
}

function historyRow(x) {
  const R = num(x.resultR);
  const open = R == null;
  const cls = open ? 'open' : R > 0 ? 'win' : 'loss';
  const label = open ? 'OPEN' : R > 0 ? 'WON' : 'LOST';
  const mae = num(x.maeR), mfe = num(x.mfeR);

  return `<details class="hrow">
    <summary>
      <span class="h-caret">&#9656;</span>
      <span class="h-res ${cls}">${esc(label)}</span>
      <span>
        <span class="h-pair">${esc(x.pair || '—')}</span>
        <span class="h-when"> ${esc(String(x.direction || '').toUpperCase())} &middot; ${esc(x.firedAt ? ago(Date.parse(x.firedAt)) : '—')}${x.tpReached ? ' &middot; TP' + esc(x.tpReached) : ''}</span>
      </span>
      <span class="h-r ${open ? '' : R > 0 ? 'pos' : 'neg'}">${open ? 'running' : esc(sign(R) + R.toFixed(2)) + 'R'}</span>
    </summary>
    <div class="h-body">
      <dl class="kv">
        <dt>Entry</dt><dd>${esc(price(x.entry, x.pair))}</dd>
        <dt>Stop</dt><dd>${esc(price(x.sl, x.pair))}</dd>
        <dt>TP1 / TP2 / TP3</dt><dd>${esc(price(x.tp1, x.pair))} &middot; ${esc(price(x.tp2, x.pair))} &middot; ${esc(price(x.tp3, x.pair))}</dd>
        <dt>Furthest reached</dt><dd>${x.tpReached ? 'TP' + esc(x.tpReached) : 'no target reached'}</dd>
        ${mfe != null ? `<dt>Best it went</dt><dd>${esc(sign(mfe) + mfe.toFixed(2))}R</dd>` : ''}
        ${mae != null ? `<dt>Worst it went</dt><dd>${esc(sign(mae) + mae.toFixed(2))}R</dd>` : ''}
        ${x.confidence != null ? `<dt>Confidence</dt><dd>${esc(x.confidence)}</dd>` : ''}
        ${x.regime ? `<dt>Regime</dt><dd>${esc(x.regime)}</dd>` : ''}
        ${x.firedAt ? `<dt>Fired</dt><dd>${esc(new Date(x.firedAt).toUTCString().slice(5, 22))} UTC</dd>` : ''}
        ${x.resolvedAt ? `<dt>Resolved</dt><dd>${esc(new Date(x.resolvedAt).toUTCString().slice(5, 22))} UTC</dd>` : ''}
      </dl>
      <p style="margin-top:10px">${open
        ? 'Still running, so it counts for nothing yet.'
        : R > 0
          ? `Closed ${esc(sign(R) + R.toFixed(2))}R.${!x.tpReached ? ' It never reached a target — it timed out while ahead, which is why the two win rates on the Ledger differ.' : ''}${mae != null && mae < -0.5 ? ` It first went ${esc(mae.toFixed(2))}R against you.` : ''}`
          : `Closed ${esc(sign(R) + R.toFixed(2))}R.${mfe != null && mfe < 1 ? ` It never reached TP1 — peak was ${esc(sign(mfe) + mfe.toFixed(2))}R — so this was an entry that did not work, not an exit that gave profit back.` : ''}`}</p>
    </div>
  </details>`;
}

/* ───────────────────── the signal ledger ─────────────────────
   Every signal this site has published, and what became of it. Two win rates
   are shown because there are two defensible definitions and they differ by
   fourteen points — quoting only the kinder one is how a 33% hit rate gets
   advertised as 47%.
   ----------------------------------------------------------------------- */
function renderLedger() {
  const L = S.ledger, box = el('ledger');
  if (!box) return;
  if (!L) { box.innerHTML = `<div class="empty">The ledger has not been published yet.</div>`; return; }

  const wo = L.winRates.byOutcome, wt = L.winRates.byTarget, r = L.returns, ep = L.episodes, rk = L.risk;
  const ciStr = Array.isArray(r.ci95) ? `[${sign(r.ci95[0])}${r.ci95[0]}, ${sign(r.ci95[1])}${r.ci95[1]}]` : '—';
  const spansZero = Array.isArray(r.ci95) && r.ci95[0] <= 0 && r.ci95[1] >= 0;

  const bar = (p) => `<div class="lg-bar"><span style="width:${Math.max(0, Math.min(100, p || 0))}%"></span></div>`;
  const tbl = (rows, label) => !rows || !rows.length ? '' : `
    <table class="kb-t lg-tbl"><tr><th>${esc(label)}</th><th>n</th><th>win %</th><th>avg R</th><th>total R</th></tr>
    ${rows.slice(0, 10).map(x => `<tr>
      <td>${esc(x.key)}</td><td>${esc(x.n)}</td>
      <td>${esc(x.winRate)}%</td>
      <td class="${x.avgR > 0 ? 'pos' : 'neg'}">${esc(sign(x.avgR) + x.avgR)}</td>
      <td class="${x.totalR > 0 ? 'pos' : 'neg'}">${esc(sign(x.totalR) + x.totalR)}</td></tr>`).join('')}</table>`;

  box.innerHTML = `
    <div class="record" style="margin-top:0">
      <div class="lg-rates">
        <div class="lg-rate">
          <div class="k">Win rate — by outcome</div>
          <div class="v" style="color:var(--up)">${esc(wo.rate)}%</div>
          ${bar(wo.rate)}
          <div class="lg-sub">${esc(wo.wins)} closed positive · ${esc(wo.losses)} closed negative</div>
          <div class="lg-def">${esc(wo.definition)}</div>
        </div>
        <div class="lg-rate">
          <div class="k">Win rate — by target reached</div>
          <div class="v" style="color:var(--warn)">${esc(wt.rate)}%</div>
          ${bar(wt.rate)}
          <div class="lg-sub">${esc(wt.hit)} reached TP1 or better · ${esc(wt.missed)} never did</div>
          <div class="lg-def">${esc(wt.definition)}</div>
        </div>
      </div>
      <div class="rec-note"><strong>These are both true.</strong> ${esc(wo.note || L.winRates.note)}</div>
    </div>

    <div class="strip" style="margin-top:12px">
      <div class="tile"><div class="tile-k">Signals recorded</div><div class="tile-v">${esc(L.coverage.total)}</div>
        <div class="tile-n">${esc(L.coverage.resolved)} resolved · ${esc(L.coverage.open)} still open</div></div>
      <div class="tile"><div class="tile-k">Average per signal</div>
        <div class="tile-v" style="color:${r.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(r.avgR) + r.avgR)}R</div>
        <div class="tile-n">${esc(ciStr)}${spansZero ? ' — spans zero' : ''}</div></div>
      <div class="tile"><div class="tile-k">Total</div>
        <div class="tile-v" style="color:${r.totalR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(r.totalR) + r.totalR)}R</div>
        <div class="tile-n">avg win ${esc(sign(r.avgWin) + r.avgWin)}R · avg loss ${esc(r.avgLoss)}R</div></div>
      <div class="tile"><div class="tile-k">Payoff ratio</div><div class="tile-v">${esc(r.payoff ?? '—')}</div>
        <div class="tile-n">winners are ${esc(r.payoff ?? '?')}x the size of losers</div></div>
      <div class="tile"><div class="tile-k">Worst drawdown</div>
        <div class="tile-v" style="color:var(--down)">&minus;${esc(rk.maxDrawdownR)}R</div>
        <div class="tile-n">peak to trough, in risk units</div></div>
      <div class="tile"><div class="tile-k">Longest losing run</div>
        <div class="tile-v" style="color:var(--down)">${esc(rk.longestLossStreak)}</div>
        <div class="tile-n">best winning run ${esc(rk.longestWinStreak)}</div></div>
    </div>

    <div class="voice-honest" style="margin-top:12px">${esc(L.verdict)}
      Collapsed to ${esc(ep.count)} independent episodes (an inflation factor of ${esc(ep.inflation)}x),
      it reads ${esc(sign(ep.avgR) + ep.avgR)}R${Array.isArray(ep.ci95) ? ` with interval [${esc(ep.ci95.join(', '))}]` : ''}.</div>

    <details class="fold" style="margin-top:14px;border-top:0"><summary>Where the wins and losses actually came from</summary>
      <div class="fold-in">
        ${tbl(L.byPair, 'by pair')}
        ${tbl(L.byDirection, 'by direction')}
        ${tbl(L.byConfidence, 'by confidence band')}
        ${tbl(L.byRegime, 'by regime')}
        <p style="margin-top:10px">Each row is a slice of the same book. With ${esc(L.coverage.resolved)} resolved signals spread across this many slices, individual rows carry few trades — a pair showing a strong number on 12 trades is not evidence, and the intervals will tell you so.</p>
      </div></details>

    <details class="fold"><summary>Every recorded signal (${esc((L.recent || []).length)} most recent)</summary>
      <div class="fold-in">
        <div class="lg-head"><span>signal</span><span>fired</span><span>reached</span><span>result</span></div>
        ${(L.recent || []).map(x => {
          const rr = num(x.resultR);
          const st = rr == null ? 'open' : rr > 0 ? 'win' : 'loss';
          return `<div class="lg-row">
            <span class="lg-p"><b>${esc(x.pair)}</b> ${esc(String(x.direction || '').toUpperCase())}${x.confidence != null ? ` <i>conf ${esc(x.confidence)}</i>` : ''}</span>
            <span class="lg-t">${esc(x.firedAt ? ago(Date.parse(x.firedAt)) : '—')}</span>
            <span class="lg-t">${x.tpReached ? 'TP' + esc(x.tpReached) : (rr == null ? 'running' : 'no target')}</span>
            <span class="lg-r ${st}">${rr == null ? '—' : esc(sign(rr) + rr.toFixed(2)) + 'R'}</span>
          </div>`;
        }).join('')}
      </div></details>

    <p style="font-size:11.5px;color:var(--text-faint);margin-top:12px;line-height:1.6">
      ${esc(L.coverage.note)} Covering ${esc(String(L.coverage.from).slice(0, 10))} to ${esc(String(L.coverage.to).slice(0, 10))}.</p>`;
}

/* ──────────────── what has been tested, and what survived ────────────────
   The search runs continuously and almost always concludes that nothing works.
   That conclusion is the product, so it is shown rather than buried: a page
   that only displayed winners would imply there were some.
   ----------------------------------------------------------------------- */
function renderTrials() {
  const t = S.strategyTrials, a = S.activeStrategy, box = el('trials');
  if (!box) return;
  if (!t) { box.innerHTML = `<div class="empty">The strategy search has not published results yet.</div>`; return; }

  const sealed = t.sealed || [];
  const active = a && a.active;

  box.innerHTML = `
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:28px">
        <div class="rec-i"><div class="k">Combinations tested</div><div class="v">${esc(t.hypotheses ?? '—')}</div></div>
        <div class="rec-i"><div class="k">Reached the sealed set</div><div class="v">${esc(sealed.length)}</div></div>
        <div class="rec-i"><div class="k">Passed it</div>
          <div class="v" style="color:${(t.passed || []).length ? 'var(--up)' : 'var(--down)'}">${esc((t.passed || []).length)}</div></div>
        <div class="rec-i"><div class="k">Bar to clear</div><div class="v" style="font-size:19px">|t| &gt; ${esc(t.bonferroniBarT ?? '—')}</div></div>
      </div>
      <div class="rec-note">${esc(t.verdict || '')}</div>
    </div>

    ${active ? `<div class="voice-honest proven" style="margin-top:12px">
        <strong>Active strategy: ${esc(active.name)}</strong> — sealed ${esc(sign(active.sealed.avgR) + active.sealed.avgR)}R over ${esc(active.sealed.n)} trades.
        ${esc(active.note || '')}
      </div>`
      : `<div class="voice-honest" style="margin-top:12px">${esc((a && a.verdict) || 'No strategy is active.')}</div>`}

    ${sealed.length ? `<details class="fold" style="margin-top:14px;border-top:0">
      <summary>How each survivor decayed from training to the sealed set</summary>
      <div class="fold-in">
        <div class="trial-head"><span>combination</span><span>train</span><span>validate</span><span>sealed</span><span>random null</span></div>
        ${sealed.map(c => `<div class="trial-row">
          <span class="tr-name">${esc(c.name)}</span>
          <span class="tr-n ${c.train && c.train.avgR > 0 ? 'pos' : 'neg'}">${c.train ? esc(sign(c.train.avgR) + c.train.avgR.toFixed(3)) + 'R <i>t=' + esc(c.train.t) + '</i>' : '—'}</span>
          <span class="tr-n ${c.validate && c.validate.avgR > 0 ? 'pos' : 'neg'}">${c.validate ? esc(sign(c.validate.avgR) + c.validate.avgR.toFixed(3)) + 'R <i>t=' + esc(c.validate.t) + '</i>' : '—'}</span>
          <span class="tr-n ${c.sealed && c.sealed.avgR > 0 ? 'pos' : 'neg'}">${c.sealed && !c.sealed.tooFew ? esc(sign(c.sealed.avgR) + c.sealed.avgR.toFixed(3)) + 'R <i>t=' + esc(c.sealed.t) + '</i>' : 'too few'}</span>
          <span class="tr-n">${c.sealed && c.sealed.nullP95 != null ? esc('+' + c.sealed.nullP95.toFixed(3)) + 'R' : '—'}</span>
        </div>`).join('')}
        <p style="margin-top:12px">The pattern in every row is the same: strong in training, weaker on validation, gone by the sealed set. That is what choosing a rule on the data you are measuring it with produces. The last column is the 95th percentile of entering at random with the same ladder and trade count — where it exceeds the sealed column, the rule did not beat chance.</p>
      </div>
    </details>` : ''}

    <p style="font-size:11.5px;color:var(--text-faint);margin-top:12px;line-height:1.6">${esc(t.method || '')}</p>`;
}



/* ─────────────── leaving an overlay ───────────────
   On a phone the Research and chart panels fill the screen, so the backdrop
   you would tap on a desktop is not reachable. That leaves the small x, and
   the back gesture — which, with nothing listening, EXITS THE WHOLE APP
   instead of closing the panel. On an installed PWA that is the worst possible
   outcome: you lose the page to dismiss a dialog.

   So each overlay pushes a history entry when it opens. Back then pops that
   entry and closes the overlay, which is what the gesture means. Swiping down
   from the header does the same, because that is the other thing people try.
   ------------------------------------------------------------------- */
function installDismiss() {
  if (window._fsDismissInstalled) return;
  window._fsDismissInstalled = true;

  const openOverlay = () => document.querySelector('#research.open, #chart.open');

  // One history entry per overlay opening, marked so a genuine navigation is
  // not mistaken for one.
  window.addEventListener('popstate', (e) => {
    const o = openOverlay();
    if (!o) return;
    if (o.id === 'research') closeResearch(true);
    else if (window.FSCHART) window.FSCHART.close(true);
  });

  // Swipe down from the top of an overlay to dismiss it.
  let sy = null, target = null;
  document.addEventListener('pointerdown', (e) => {
    const o = openOverlay();
    if (!o || e.pointerType !== 'touch') { sy = null; return; }
    const head = e.target.closest('.rs-top, .ch-top');
    if (!head) { sy = null; return; }
    if (e.target.closest('input, button, select, a')) { sy = null; return; }
    sy = e.clientY; target = o;
  }, { passive: true });
  document.addEventListener('pointerup', (e) => {
    if (sy == null || !target) return;
    const dy = e.clientY - sy;
    sy = null;
    if (dy > 70) {                       // a deliberate downward swipe
      if (target.id === 'research') closeResearch();
      else if (window.FSCHART) window.FSCHART.close();
      history.back();
    }
    target = null;
  });
}

/** Call when an overlay opens, so Back closes it instead of leaving the app. */
function pushOverlayState(name) {
  try {
    if (history.state && history.state.fsOverlay) return;   // already stacked
    history.pushState({ fsOverlay: name }, '', location.href);
  } catch (_) {}
}
/** Call when an overlay closes by any other route, to keep history balanced. */
function popOverlayState() {
  try { if (history.state && history.state.fsOverlay) history.back(); } catch (_) {}
}

/* ─────────────────────── Research ───────────────────────
   Ask anything about this site or about trading. Answers come from
   v2/knowledge.js: measured ones are computed from the files already loaded
   and carry their source; mechanical ones are true by construction. Anything
   requiring a forecast is refused explicitly rather than invented.
   ----------------------------------------------------------------------- */
function openResearch(prefill) {
  let el0 = document.getElementById('research');
  if (!el0) {
    el0 = document.createElement('div');
    el0.id = 'research'; el0.className = 'rs';
    el0.innerHTML = `
      <div class="rs-back" data-close="1"></div>
      <div class="rs-panel" role="dialog" aria-modal="true" aria-label="Research">
        <div class="rs-top">
          <input id="rs-q" type="text" spellcheck="false" placeholder="Ask anything — is this profitable? what is an R-multiple? why is this weak?" aria-label="Ask a question">
          <button class="rs-x" data-close="1" aria-label="Close">&times;</button>
        </div>
        <div class="rs-body" id="rs-body"></div>
      </div>`;
    document.body.appendChild(el0);
    el0.addEventListener('click', (e) => {
      if (e.target.dataset.close) closeResearch();
      if (e.target.dataset.clearq) {
        const q = document.getElementById('rs-q');
        q.value = ''; answerResearch(''); q.focus();
        return;
      }
      const chip = e.target.closest('[data-topic]');
      if (chip) { const q = document.getElementById('rs-q'); q.value = chip.dataset.topic; answerResearch(chip.dataset.topic); }
    });
    document.getElementById('rs-q').addEventListener('input', (e) => answerResearch(e.target.value));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeResearch(); });
  }
  el0.classList.add('open');
  pushOverlayState('research');
  const q = document.getElementById('rs-q');
  q.value = prefill || '';
  answerResearch(q.value);
  setTimeout(() => q.focus(), 60);
}
function closeResearch(fromBack) {
  const e = document.getElementById('research');
  if (!e || !e.classList.contains('open')) return;
  e.classList.remove('open');
  if (!fromBack) popOverlayState();
}

function answerResearch(query) {
  const body = document.getElementById('rs-body');
  if (!body || !window.FSKB) return;
  const KB = window.FSKB;
  const hits = KB.search(query);

  if (!String(query || '').trim()) {
    body.innerHTML = `<p class="rs-lead">Ask in your own words. Everything below is answered from this site's own measured data, or from arithmetic that is true by construction — never from a guess.</p>
      <div class="rs-chips">${KB.TOPICS.map(t => `<button class="rs-chip" data-topic="${KB.esc(t.q)}">${KB.esc(t.q)}</button>`).join('')}</div>`;
    return;
  }
  // No prepared topic matched. Before refusing, try to RESOLVE whatever the
  // question refers to — an instrument, a field name, a term, a count — against
  // live data. The prepared list only covers questions I thought of; this
  // covers the ones I did not.
  if (!hits.length && window.FSRESOLVE) {
    const dyn = window.FSRESOLVE.resolve(query, S);
    if (dyn) {
      const badge = dyn.kind === 'measured' ? 'measured from live data' : 'mechanical — true by construction';
      body.innerHTML = `<div class="rs-ans">
        <div class="rs-kind rs-${KB.esc(dyn.kind)}">${KB.esc(badge)}</div>
        <h3>${KB.esc(dyn.q)}</h3>
        ${dyn.body}
        <div class="rs-src">Source: ${KB.esc(dyn.source)}</div>
        <button class="rs-clear" data-clearq="1">Clear this answer</button>
      </div>`;
      return;
    }
  }
  if (!hits.length) {
    body.innerHTML = `<div class="rs-ans"><h3>I do not know that one</h3>
      <p>I answer questions about this site and about trading mechanics. I will not guess at something outside that, because a confident wrong answer in a trading tool is worse than no answer.</p>
      <p>Try one of these:</p>
      <div class="rs-chips">${KB.TOPICS.slice(0, 8).map(t => `<button class="rs-chip" data-topic="${KB.esc(t.q)}">${KB.esc(t.q)}</button>`).join('')}</div></div>`;
    return;
  }
  const top = hits[0];
  let a;
  try { a = top.answer(S); }
  catch (e) { body.innerHTML = `<div class="rs-ans"><h3>That answer failed to build</h3><p>${KB.esc(e.message)}</p></div>`; return; }

  const badge = top.kind === 'measured' ? 'measured from live data'
              : top.kind === 'refusal' ? 'this is a refusal' : 'mechanical — true by construction';
  body.innerHTML = `
    <div class="rs-ans">
      <div class="rs-kind rs-${KB.esc(top.kind)}">${KB.esc(badge)}</div>
      <h3>${KB.esc(top.q)}</h3>
      ${a.body}
      <div class="rs-src">Source: ${KB.esc(a.source)}</div>
      <button class="rs-clear" data-clearq="1">Clear this answer</button>
    </div>
    ${hits.length > 1 ? `<div class="rs-more"><span>Related</span>
      <div class="rs-chips">${hits.slice(1, 5).map(t => `<button class="rs-chip" data-topic="${KB.esc(t.q)}">${KB.esc(t.q)}</button>`).join('')}</div></div>` : ''}`;
}

/* ─────────────────────── the order bar ───────────────────────
   One line you talk to. Rendered once like everything else; the input keeps
   its own value across re-renders because it is only written when absent.
   ----------------------------------------------------------------------- */
function renderCommand() {
  const box = el('command');
  if (!box) return;
  const cfg = S.cfg || {};
  const chips = window.FS ? window.FS.chips(cfg) : [];
  const existing = box.querySelector('#cmd-input');
  const keep = existing ? existing.value : '';

  box.innerHTML = `
    <form id="cmd-form" autocomplete="off">
      <span class="cmd-caret">&rsaquo;</span>
      <input id="cmd-input" type="text" spellcheck="false"
             placeholder="tell it what to do — try: only gold · confidence 70 · hide weak · sort by r · help"
             aria-label="Give the site an order">
      <button type="submit" class="cmd-go">Run</button>
    </form>
    ${chips.length ? `<div class="cmd-chips">
      <span class="cmd-chips-k">standing orders</span>
      ${chips.map(([label, key]) => `<button class="cmd-chip" data-clear="${esc(key)}" title="Click to cancel this order">${esc(label)} <span>&times;</span></button>`).join('')}
      <button class="cmd-chip clear-all" data-clear="__all">clear all</button>
    </div>` : ''}
    ${S.lastMsg ? `<div class="ans-wrap"><button class="ans-x" data-dismiss="msg" aria-label="Clear this answer" title="Clear">&times;</button>
      <pre class="cmd-msg${S.lastMsg.ok ? '' : ' bad'}">${esc(S.lastMsg.msg)}</pre></div>` : ''}`;

  const input = box.querySelector('#cmd-input');
  if (keep) input.value = keep;

  box.querySelector('#cmd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    S.lastMsg = window.FS.run(v, S.cfg);
    input.value = '';
    render();
    el('command').querySelector('#cmd-input').focus();
  });

  const dx = box.querySelector('[data-dismiss="msg"]');
  if (dx) dx.addEventListener('click', () => { S.lastMsg = null; clearTimeout(_msgTimer); render(); });
  // An answer you have stopped looking at is clutter, so it clears itself.
  // The timer is reset on any interaction, so it never vanishes mid-read.
  armAutoDismiss();

  box.querySelectorAll('.cmd-chip').forEach(btn => btn.addEventListener('click', () => {
    const k = btn.dataset.clear;
    if (k === '__all') Object.assign(S.cfg, window.FS.DEFAULTS);
    else S.cfg[k] = window.FS.DEFAULTS[k];
    window.FS.save(S.cfg);
    S.lastMsg = { ok: true, msg: k === '__all' ? 'Cleared every order.' : 'Cancelled that order.' };
    render();
  }));
}




/* ──────────────────── real push notifications ────────────────────
   The Notification API alone only fires while the page is OPEN. On a phone
   with the app closed — which is the entire point of being notified — it does
   nothing. Base II shipped using only that, so alerts were silently useless on
   the installed app.

   Web Push works through the service worker and arrives with the app shut.
   The infrastructure already existed (VAPID key, /api/push-subscribe,
   /api/push-fire, and a push handler in service-worker.js); base II simply
   never connected to any of it.
   ------------------------------------------------------------------- */
const PUSH_KEY_URL = '/api/push-subscribe';

function b64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { supported: false, reason: 'this browser has no Push support' };
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { supported: true, subscribed: false, reason: 'no service worker yet' };
  const sub = await reg.pushManager.getSubscription();
  return { supported: true, subscribed: !!sub, permission: Notification.permission, sub };
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, msg: 'This browser cannot do push notifications. On iPhone the site has to be added to the Home Screen first.' };
  }
  // iOS only allows push from an INSTALLED app, and says nothing useful if it
  // is not, so check and explain rather than failing silently.
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (iOS && !standalone) {
    return { ok: false, msg: 'On iPhone, notifications only work once the site is added to your Home Screen. Share -> Add to Home Screen, open it from there, then turn alerts on again.' };
  }

  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch (_) { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    return { ok: false, msg: 'Notifications are blocked for this site. Allow them in your browser or iPhone settings, then try again.' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    let key;
    try {
      const r = await fetch(PUSH_KEY_URL, { cache: 'no-store' });
      key = (await r.json()).vapidPublic;
    } catch (_) { return { ok: false, msg: 'Could not reach the notification server.' }; }
    if (!key) return { ok: false, msg: 'The notification server has no key configured.' };
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
    } catch (e) { return { ok: false, msg: 'Subscribing failed: ' + (e.message || 'unknown') }; }
  }

  try {
    // The server validates sub.endpoint and sub.keys at the TOP level, so the
    // raw subscription is what goes in the body. Wrapping it in an object was
    // rejected with "Subscription missing endpoint or keys" — silently, because
    // nothing surfaced the response.
    const r = await fetch(PUSH_KEY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!r.ok) return { ok: false, msg: 'The server refused the subscription (' + r.status + ').' };
  } catch (_) { return { ok: false, msg: 'Could not register with the notification server.' }; }

  return { ok: true, msg: 'Push notifications on. You will be told about a new setup even with the app closed.' };
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await fetch(PUSH_KEY_URL, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch (_) {}
  return { ok: true, msg: 'Push notifications off.' };
}

/* ───────────────────────── alerts ─────────────────────────
   Notifies on a NEW setup that passes the SAME standing orders the page is
   filtered by. That equivalence is the point: an alert you cannot reproduce on
   screen is an alert you stop trusting. Signals already seen never re-fire, so
   a two-minute refresh cycle does not become a two-minute alarm.
   ----------------------------------------------------------------------- */
const SEEN_KEY = 'fs.seen.v1';
function loadSeen() {
  try { const a = JSON.parse(localStorage.getItem(SEEN_KEY)); return new Set(Array.isArray(a) ? a : []); }
  catch (_) { return new Set(); }
}
function saveSeen(set) {
  // Keep the list bounded or it grows forever in storage.
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-400))); } catch (_) {}
}
function signalKey(s) {
  return [pick(s, 'pair'), pick(s, 'direction'), pick(s, 'detectedAt') || '', num(pick(s, 'entry')) ?? ''].join('|');
}

async function maybeAlert() {
  const cfg = S.cfg || {};
  if (!cfg.alerts) return;
  if (typeof Notification === 'undefined') return;

  const all = (S.latestSignals && S.latestSignals.signals) || [];
  let passing = window.FS ? window.FS.apply(all, cfg, READ) : all;
  if (cfg.alertMinConf != null) {
    passing = passing.filter(s => { const c = READ.conf(s); return c != null && c >= cfg.alertMinConf; });
  }

  const seen = loadSeen();
  const fresh = passing.filter(s => !seen.has(signalKey(s)));

  // First run after switching alerts on: record what is already there rather
  // than firing a notification for every setup that was published hours ago.
  if (!S.alertsPrimed) {
    for (const s of all) seen.add(signalKey(s));
    saveSeen(seen); S.alertsPrimed = true;
    return;
  }
  if (!fresh.length) return;

  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (_) { return; }
  }
  if (Notification.permission !== 'granted') return;

  for (const s of fresh.slice(0, 3)) {
    const pair = pick(s, 'pair'), dir = String(pick(s, 'direction') || '').toUpperCase();
    const r1 = READ.r1(s), conf = READ.conf(s);
    const body = [
      `Entry ${price(num(pick(s, 'entry')), pair)}`,
      `Stop ${price(num(pick(s, 'sl')), pair)}`,
      r1 != null ? `TP1 ${price(num(pick(s, 'tp1')), pair)} (${r1.toFixed(2)}R)` : null,
      conf != null ? `confidence ${conf}` : null,
    ].filter(Boolean).join(' · ');
    try {
      const n = new Notification(`${pair} ${dir}`, {
        body, tag: signalKey(s), icon: '/icon-192.png', badge: '/icon-192.png',
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (_) { /* some browsers refuse outside a gesture; silence is correct */ }
    seen.add(signalKey(s));
  }
  for (const s of all) seen.add(signalKey(s));
  saveSeen(seen);
}

/* ─────────────────────── tap a level to copy it ───────────────────────
   Bound ONCE on document, not on the cards. renderCards() replaces innerHTML
   every cycle, so any listener attached to a card is destroyed two minutes
   later and the feature silently stops working — the kind of bug that looks
   like "it worked when you tested it".
   ----------------------------------------------------------------------- */
let _copyTimer = null;
async function copyLevel(node) {
  const val = node.dataset.copy, label = node.dataset.label || 'level';
  if (!val) return;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(val); ok = true; }
  } catch (_) { /* denied or unavailable — fall through */ }
  if (!ok) {
    // Fallback for non-secure contexts and older iOS Safari, where
    // navigator.clipboard is simply absent.
    try {
      const ta = document.createElement('textarea');
      ta.value = val; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, val.length);
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (_) { ok = false; }
  }
  node.classList.remove('copied', 'copyfail');
  void node.offsetWidth;                       // restart the animation
  node.classList.add(ok ? 'copied' : 'copyfail');
  const tip = document.getElementById('copy-tip');
  if (tip) {
    tip.textContent = ok ? `${label} ${val} copied` : `could not copy — select ${val} manually`;
    tip.className = 'copy-tip show' + (ok ? '' : ' bad');
    clearTimeout(_copyTimer);
    _copyTimer = setTimeout(() => { tip.className = 'copy-tip'; }, 1800);
  }
  setTimeout(() => node.classList.remove('copied', 'copyfail'), 900);
}
function installCopy() {
  if (window._fsCopyInstalled) return;
  window._fsCopyInstalled = true;
  document.addEventListener('click', (e) => {
    const n = e.target.closest('.lvl.copyable');
    if (n) { e.preventDefault(); copyLevel(n); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const n = e.target.closest && e.target.closest('.lvl.copyable');
    if (n) { e.preventDefault(); copyLevel(n); }
  });
  if (!document.getElementById('copy-tip')) {
    const t = document.createElement('div');
    t.id = 'copy-tip'; t.className = 'copy-tip';
    t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
}

/* ─────────────────────────── chrome ─────────────────────────── */
function renderChrome() {
  const feed = S.latestSignals;
  const ts = feed && feed.ts;
  const mins = ts ? (Date.now() - ts) / 60000 : Infinity;
  const pulse = el('pulse');
  pulse.className = 'dot ' + (mins < 90 ? 'live' : mins < 600 ? 'stale' : 'dead');

  const rb = document.getElementById('research-btn');
  if (rb && !rb._wired) { rb._wired = true; rb.addEventListener('click', () => openResearch('')); }

  const stale = ts && (Date.now() - ts) / 60000 > STALE_MIN;
  el('meta').innerHTML = ts
    ? `feed ${esc(ago(ts))}${stale ? ' <b class="meta-stale">stale</b>' : ''} · ${esc((feed.signals || []).length)} published${feed._src ? ` · ${esc(feed._src)}` : ''}`
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
    ['command', renderCommand], ['voice', renderVoice], ['context', renderContext], ['cards', renderCards],
    ['record', renderRecord], ['ledger', renderLedger], ['history', renderHistory], ['calc', renderCalc], ['trials', renderTrials], ['hist', renderHist], ['chrome', renderChrome], ['tabs', renderTabCounts], ['order', applySavedOrder],
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

function bootConfig() {
  installCopy();
  installIdle();
  installSignalBalance();
  installUpdates();
  installDismiss();
  installChart();
  installReorder();
  installTabs(); if (!S.cfg) S.cfg = window.FS ? window.FS.load() : {}; }

async function cycle() {
  bootConfig();
  try { await load(); } catch (e) { console.error('[base II] load failed', e); }
  render();
  try { await maybeAlert(); } catch (e) { console.error('[base II] alert check failed', e); }
  try { await refreshIfStale(); } catch (e) { console.error('[base II] live refresh failed', e); }
}

cycle();
setInterval(cycle, 120000);                       // 2 min, static files only — zero Cloudflare quota
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.at > 60000) cycle(); });

window.__baseII = S;                              // for verification from the console
