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
const FILES  = ['latest-signals', 'market-voice', 'learning-brain', 'shadow-tracker', 'self-evaluation', 'strategy-trials', 'active-strategy', 'ledger', 'fx-rates', 'per-chart-search', 'engine-sealed-test', 'exit-search', 'benchmark-vs-holding', 'adaptive-engine', 'cost-audit', 'cost-ceiling-test', 'trend-alignment-test', 'volatility-gradient-test', 'atr-method-test', 'hold-window-test'];

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
  // Decimals from the PRICE, not the symbol. Bucketing by instrument put XRP
  // (1.50) in the same bucket as BTC (85,000) and rounded its stop and entry
  // onto the same displayed number.
  const a = Math.abs(n);
  const dp = a >= 10000 ? 1 : a >= 1000 ? 2 : a >= 100 ? 3 : a >= 10 ? 4 : a >= 1 ? 5 : 6;
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
  let sigs = window.FS ? window.FS.apply(all, cfg, READ) : all;
  const closed = closedBook();
  const closedHere = sigs.filter((x) => closed[sigKey(x)]).length;
  sigs = sigs.filter((x) => !closed[sigKey(x)]);

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
  // ───────── why this is not just `box.innerHTML = …` ─────────
  // cycle() re-renders every two minutes. A plain innerHTML wipe throws away
  // two things the person was in the middle of using:
  //
  //   1. every <details> they opened — it slams shut under their finger;
  //   2. the input they are typing a balance into, along with its focus and
  //      caret, so a half-typed "15" of "1500" is what gets saved.
  //
  // Collapsing more of the card into folds (which is what makes it readable on
  // a phone) is only safe once both survive a refresh. So: if a field inside a
  // card has focus, the cards are left alone entirely until the next cycle —
  // nothing here is urgent enough to interrupt typing. Otherwise the open folds
  // are remembered by key and reopened after the rewrite.
  if (box.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    S.cardsDeferred = (S.cardsDeferred || 0) + 1;
    return;
  }
  S.cardsDeferred = 0;

  const open = new Set();
  box.querySelectorAll('details[data-fold]').forEach((d) => { if (d.open) open.add(d.dataset.fold); });
  // Folds opened before this render still count, so a card that briefly leaves
  // the feed and comes back does not forget.
  if (S.openFolds) S.openFolds.forEach((k) => open.add(k));
  S.openFolds = open;

  box.innerHTML = sigs.map(card).join('');
  box.querySelectorAll('details[data-fold]').forEach((d) => { if (open.has(d.dataset.fold)) d.open = true; });
  // Remember it the moment it is toggled, not at the next render, because the
  // card may be re-rendered by an event the toggle itself triggered.
  box.querySelectorAll('details[data-fold]').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!S.openFolds) S.openFolds = new Set();
      if (d.open) S.openFolds.add(d.dataset.fold); else S.openFolds.delete(d.dataset.fold);
    });
  });
  // Warm the chart cache for what is on screen, so the first tap paints
  // immediately instead of waiting on a fetch.
  if (window.FSCHART && window.FSCHART.prefetch) {
    try { window.FSCHART.prefetch(sigs.map(x => pick(x, 'pair')).filter(Boolean)); } catch (_) {}
  }
  if (all.length !== sigs.length) {
    const byOrders = all.length - sigs.length - closedHere;
    box.insertAdjacentHTML('beforeend',
      `<div class="empty" style="padding:16px"><strong>${esc(all.length - sigs.length)} not shown</strong>
       ${byOrders > 0 ? `${esc(byOrders)} hidden by your orders — type <code>reset</code> to see them. ` : ''}
       ${closedHere > 0 ? `${esc(closedHere)} closed by you, listed under History.` : ''}</div>`);
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
  if (conf != null) {
    // Measured across 21,143 engine signals: the high-confidence half averaged
    // -0.0097R and the low half +0.0033R, a difference with t = -0.75. It does
    // not separate winners from losers in EITHER direction. Showing it as a
    // bare number invited it to be read as quality, so it is labelled.
    const es = S.engineSealedTest;
    const n = es && es.signalsFired;
    chips.push(`<span class="chip" title="${n ? `Measured on ${n.toLocaleString()} signals: this score does not predict the outcome` : 'the engine\'s internal score'}">conf ${esc(conf)} <i style="font-style:normal;opacity:.6">· not predictive</i></span>`);
  }
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
      <button class="c-close" data-close="${esc(sigKey(s))}" title="Close this signal and record where it stood"
              aria-label="Close this signal">close</button>
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
      ${glanceLine(s)}

      <details class="fold" data-fold="${esc(sigKey(s))}|more" ${S.cfg && S.cfg.expand ? "open" : ""}>
        <summary>The full working</summary>
        <div class="fold-in">
          ${why.length > 1 ? `<p class="c-why" style="margin-bottom:12px">${esc(why.slice(1).join(' '))}</p>` : ''}

          <div class="sub-k">The whole ladder and what it pays</div>
          <dl class="kv">
            <dt>TP1</dt><dd>${cp(tp1, 'TP1', pair)} · ${r1 != null ? esc(r1.toFixed(2)) + 'R' : '—'} · bank a third</dd>
            <dt>TP2</dt><dd>${cp(tp2, 'TP2', pair)} · ${r2v != null ? esc(r2v.toFixed(2)) + 'R' : '—'} · bank a third, stop to entry</dd>
            <dt>TP3</dt><dd>${cp(tp3, 'TP3', pair)} · ${r3 != null ? esc(r3.toFixed(2)) + 'R' : '—'} · final third, stop to TP1</dd>
            <dt>Full run</dt><dd>${perfect != null ? esc(sign(perfect) + perfect.toFixed(3)) + 'R' : '—'}</dd>
            <dt>Full stop-out</dt><dd>&minus;1.000R</dd>
          </dl>
          <p style="margin-top:9px">${perfect != null && perfect > 1
            ? `A completed run pays ${esc(perfect.toFixed(2))}R against ${esc((1).toFixed(2))}R risked, so the geometry is the right way round. That is arithmetic about this ladder — not a claim about how often it completes.`
            : 'This ladder does not pay more than it risks on a full run. It should not have been published.'}</p>

          ${trackerBlock(s)}
          ${moneyBlock(s)}

          <div class="sub-k" style="margin-top:14px">Costs, news and the modelled outcome</div>
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
        </div>
      </details>
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
        <dt>Entry</dt><dd>${cp(x.entry, 'entry', x.pair)}</dd>
        <dt>Stop</dt><dd>${cp(x.sl, 'stop', x.pair)}</dd>
        <dt>TP1 / TP2 / TP3</dt><dd>${cp(x.tp1, 'TP1', x.pair)} · ${cp(x.tp2, 'TP2', x.pair)} · ${cp(x.tp3, 'TP3', x.pair)}</dd>
        <dt>Furthest reached</dt><dd>${x.tpReached ? esc('TP' + x.tpReached) : 'no target reached'}</dd>
        ${mfe != null ? `<dt>Best it went</dt><dd>${esc(sign(mfe) + mfe.toFixed(2))}R</dd>` : ''}
        ${mae != null ? `<dt>Went against it</dt><dd>${esc(mae.toFixed(2))}R${mae > 0 ? ' at its worst' : ''}</dd>` : ''}
        ${x.confidence != null ? `<dt>Confidence at entry</dt><dd>${esc(x.confidence)}</dd>` : ''}
        ${x.strategies != null ? `<dt>Strategies agreeing</dt><dd>${esc(x.strategies)}</dd>` : ''}
      </dl>
      <p style="margin-top:10px">${open
        ? 'Still running, so it counts for nothing yet. It is listed so the record cannot be read as only the resolved ones.'
        : st === 'expired'
          ? `It did not fail at a stop and it did not hit a target — it simply ran out of its watch window${dur ? ` after ${esc(dur)}` : ''}, closing ${esc(sign(R) + R.toFixed(2))}R wherever price happened to be. ${mfe != null && mfe < 1 ? `Its best moment was ${esc(sign(mfe) + mfe.toFixed(2))}R, so it never came close.` : mfe != null ? `It reached ${esc(sign(mfe) + mfe.toFixed(2))}R at best.` : ''} This is how most signals here end, which is why the win rate by outcome and the win rate by target differ.`
        : R > 0
          ? `Closed ${esc(sign(R) + R.toFixed(2))}R${ended ? ` at ${esc(ended)}` : ''}.${mae != null && mae > 0.5 ? ` It first went ${esc(mae.toFixed(2))}R against the position, so this win was not comfortable.` : ''}`
          : `Closed ${esc(sign(R) + R.toFixed(2))}R${ended ? ` at ${esc(ended)}` : ''}${dur ? `, ${esc(dur)} after it fired` : ''}.${mfe != null && mfe < 1 ? ` It never reached TP1 — peak was ${esc(sign(mfe) + mfe.toFixed(2))}R — so this was an entry that did not work, not an exit that gave profit back.` : mfe != null ? ` It reached ${esc(sign(mfe) + mfe.toFixed(2))}R before turning.` : ''}`}</p>
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

/* ─────────────── closing a signal yourself ───────────────
   The watcher decides when a setup is finished. This lets you decide instead,
   which is a different thing and is recorded as a different thing: the status is
   "closed by you", never merged into the engine's own won/lost/expired counts,
   because the engine's record has to stay a record of the ENGINE.

   The result is worked out at the live price the moment you close, by the same
   arithmetic the glance line uses, and the entry is kept rather than deleted so
   it can be reopened. A mis-tap costs one tap to undo.
   ------------------------------------------------------------------- */
function closedBook() {
  const c = S.cfg || {};
  if (!c.closedByMe || typeof c.closedByMe !== 'object') c.closedByMe = {};
  return c.closedByMe;
}

function closeSignal(key) {
  const feed = S.latestSignals, all = (feed && feed.signals) || [];
  const sig = all.find((x) => sigKey(x) === key);
  if (!sig) return;
  const entry = num(pick(sig, 'entry')), sl = num(pick(sig, 'sl'));
  const dirUp = /^(BUY|LONG)/i.test(String(pick(sig, 'direction') || ''));
  const live = livePrice(pick(sig, 'pair'));
  let r = null;
  if (entry != null && sl != null && Math.abs(entry - sl) > 0 && live) {
    r = ((live.price - entry) * (dirUp ? 1 : -1)) / Math.abs(entry - sl);
  }
  closedBook()[key] = {
    key, pair: pick(sig, 'pair'), direction: pick(sig, 'direction'),
    entry, sl, tp1: num(pick(sig, 'tp1')), tp2: num(pick(sig, 'tp2')), tp3: num(pick(sig, 'tp3')),
    firedAt: pick(sig, 'detectedAt') || null,
    closedAt: new Date().toISOString(),
    // null rather than 0 when no live price is known — a stand-in zero here
    // would read as "it broke even", which is a claim about money.
    closedPrice: live ? live.price : null,
    resultR: r == null ? null : +r.toFixed(3),
  };
  if (window.FS) window.FS.save(S.cfg);
  render();
}

function reopenSignal(key) {
  const b = closedBook();
  delete b[key];
  if (window.FS) window.FS.save(S.cfg);
  render();
}

function installClose() {
  if (S._closeBound) return;
  S._closeBound = true;
  // Delegated, because the cards are rewritten every two minutes.
  document.addEventListener('click', (e) => {
    const close = e.target.closest && e.target.closest('[data-close]');
    if (close) {
      // The whole card head opens the chart, so this must not reach it.
      e.preventDefault(); e.stopPropagation();
      closeSignal(close.dataset.close);
      return;
    }
    const open = e.target.closest && e.target.closest('[data-reopen]');
    if (open) { e.preventDefault(); e.stopPropagation(); reopenSignal(open.dataset.reopen); }
  }, true);
}

/* ─────────────── the one line that replaces four blocks ───────────────
   A phone showed one signal as 927px — taller than the screen — so nine of them
   was ten screens of scrolling. Almost all of that was secondary: a wrapped
   badge row, a tracker panel, a money panel and three separate fold headers,
   each costing 56px of chrome before it showed anything.

   None of it is deleted; it moved one tap down. What stays visible is the line
   below, which answers the only three questions worth asking at a glance: is it
   running, how far has it gone, and what is it worth to me. Everything else is
   detail you go looking for, not detail you scroll past nine times.
   ------------------------------------------------------------------- */
function glanceLine(sig) {
  const entry = num(pick(sig, 'entry')), sl = num(pick(sig, 'sl'));
  const dir = String(pick(sig, 'direction') || '').toUpperCase();
  const bits = [];

  if (entry != null && sl != null && Math.abs(entry - sl) > 0) {
    const live = livePrice(pick(sig, 'pair'));
    const sgn = (dir === 'BUY' || dir === 'LONG') ? 1 : -1;
    if (live) {
      const runR = ((live.price - entry) * sgn) / Math.abs(entry - sl);
      const cls = runR > 0.02 ? 'up' : runR < -0.02 ? 'dn' : '';
      bits.push(`<span class="g-run ${cls}">${esc(sign(runR) + runR.toFixed(2))}R<i>running</i></span>`);
    } else {
      // Never imply a position that cannot be seen. The chart fetches the bars.
      bits.push('<span class="g-run">—<i>price not loaded</i></span>');
    }
  }

  if (window.FSCALC) {
    const base = S.cfg || {};
    const ov = (base.perSignal || {})[sigKey(sig)];
    const o = (typeof ov === 'number') ? { balance: ov } : (ov || {});
    const r = window.FSCALC.calcSignal(sig, {
      ...base,
      balance: o.balance != null ? o.balance : base.balance,
      riskPct: o.riskPct != null ? o.riskPct : base.riskPct,
    }, S.fxRates);
    if (r && r.rateKnown) {
      const M = (v) => window.FSCALC.money(v, r.currency);
      bits.push(`<span class="g-win">${esc(M(r.best.money))}<i>to TP3</i></span>`);
      bits.push(`<span class="g-lose">${esc(M(r.worst.money))}<i>if stopped</i></span>`);
    }
  }

  return bits.length ? `<div class="c-glance">${bits.join('')}</div>` : '';
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
      <span class="trk-px">${cp(live.price, 'price', pair)}<i>${ageMin < 90 ? esc(ageMin) + 'm ago' : esc(Math.round(ageMin / 60)) + 'h ago'}</i></span>
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
        ? `<b class="trk-alert">About to hit ${esc(nearest.name)}</b> — ${esc(nearest.away.toFixed(2))}R away at ${cp(nearest.price, nearest.name, pair)}.`
        : `Nearest level is <b>${esc(nearest.name)}</b>, ${esc(nearest.away.toFixed(2))}R away at ${cp(nearest.price, nearest.name, pair)}.`}
      ${runR <= -1 ? ' <b class="trk-alert">Stop level reached.</b>' : ''}
    </div>
  </div>`;
}

/* ─────────── what this signal is worth, in your money ───────────
   Shown on every card, not hidden behind a fold, because "how much do I make
   and how much do I lose" is the first question and should not need a click.
   ----------------------------------------------------------------------- */
/** A stable id for a signal, so a per-signal balance survives a re-render. */
/**
 * An inline price you can tap to copy. The copied text is the bare number with
 * no currency mark or separators, because it is going into an order ticket
 * where anything else is a rejected order — the same rule the big level tiles
 * already follow. Returns a plain dash when there is nothing to copy, so a
 * missing level never renders as a tappable zero.
 */
function cp(v, label, pair) {
  const shown = price(v, pair);
  if (shown === '—') return '<span class="nocopy">—</span>';
  return `<span class="cpn" data-copy="${esc(shown)}" data-label="${esc(label)}" role="button" tabindex="0"`
       + ` title="Tap to copy ${esc(label)}">${esc(shown)}</span>`;
}

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

    <details class="fold mny-fold" data-fold="${esc(key)}|money"><summary>Change the amount, and see each target</summary>
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
            <span class="ms-p">${cp(st.price, st.name, pick(sig, 'pair'))}</span>
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

  // Categories come from the ledger's own status. Splitting on the sign of the
  // result instead put every expired signal into Won or Lost, which is the
  // distinction this panel is most often asked for: did it fail, or did it just
  // never finish? Four statuses, and they sum to the total.
  const stOf = (x) => String(x.status || (x.resultR == null ? 'open' : x.resultR > 0 ? 'won' : 'lost')).toLowerCase();
  const isWin = (x) => stOf(x) === 'won';
  const isLoss = (x) => stOf(x) === 'lost';
  const isExpired = (x) => stOf(x) === 'expired';
  const isOpen = (x) => stOf(x) === 'open';

  const counts = {
    all: rows.length,
    won: rows.filter(isWin).length,
    lost: rows.filter(isLoss).length,
    expired: rows.filter(isExpired).length,
    open: rows.filter(isOpen).length,
    target: rows.filter(x => (x.tpReached || 0) >= 1).length,
    mine: Object.keys(closedBook()).length,
  };

  let shown = rows;
  if (filter === 'won') shown = rows.filter(isWin);
  else if (filter === 'lost') shown = rows.filter(isLoss);
  else if (filter === 'expired') shown = rows.filter(isExpired);
  else if (filter === 'open') shown = rows.filter(isOpen);
  else if (filter === 'mine') shown = [];   // drawn from your own book, below
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
        <div class="rec-i"><div class="k">How they ended</div>
          <div class="v" style="font-size:20px"><span style="color:var(--up)">${esc(shown.filter(isWin).length)}</span>
            / <span style="color:var(--down)">${esc(shown.filter(isLoss).length)}</span>
            / <span style="color:var(--warn)">${esc(shown.filter(isExpired).length)}</span></div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">won / lost / ran out of time</div></div>
        <div class="rec-i"><div class="k">Total</div>
          <div class="v" style="color:${sumR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(sumR) + sumR.toFixed(1))}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">sum of every resolved result</div></div>
      </div>
    </div>

    <div class="hfilters">
      ${chip('all', 'Everything', counts.all)}
      ${chip('won', 'Won', counts.won, 'win')}
      ${chip('lost', 'Lost', counts.lost, 'loss')}
      ${chip('expired', 'Ran out of time', counts.expired, 'exp')}
      ${chip('target', 'Hit a target', counts.target)}
      ${chip('open', 'Still open', counts.open, 'open')}
      ${counts.mine ? chip('mine', 'Closed by you', counts.mine, 'exp') : ''}
    </div>

    ${filter === 'mine'
      ? (counts.mine
          ? `<div class="hist">${Object.values(closedBook())
              .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
              .map(myRow).join('')}</div>`
          : `<div class="empty"><strong>You have not closed any signals</strong>Use the close button on a card to finish one yourself.</div>`)
      : shown.length ? `<div class="hist">${shown.map(historyRow).join('')}</div>`
      : `<div class="empty"><strong>Nothing matches</strong>No signals in this view. Try Everything, or clear your orders.</div>`}

    <p style="font-size:11.5px;color:var(--text-faint);margin-top:14px;line-height:1.6">
      Covering ${esc(String(L.coverage.from).slice(0, 10))} to ${esc(String(L.coverage.to).slice(0, 10))}.
      Every row shows when it started, when it ended and how long it ran, on your own clock; the exact UTC stamps
      are inside each row. <strong>Won</strong> and <strong>lost</strong> mean it closed ahead or behind;
      <strong>ran out of time</strong> means the watch window closed before either a target or the stop was reached,
      which is how ${esc(counts.expired)} of ${esc(counts.all)} ended. Only ${esc(counts.target)} ever reached TP1
      or better, so that is the number to judge the entries by.</p>`;

  for (const b of box.querySelectorAll('[data-hfilter]')) {
    b.addEventListener('click', () => {
      S.cfg.histFilter = b.dataset.hfilter;
      if (window.FS) window.FS.save(S.cfg);
      renderHistory();
    });
  }
}

/* ─────────────── one line of history ───────────────
   "When did it start, when did it end, and did it fail" is the question this
   panel exists to answer, so all three are on the face of the row rather than
   behind a tap.

   The result word comes from the ledger's own `status`, not from the sign of
   the result. Deriving it printed WON or LOST for all 187 EXPIRED signals, which
   is the single most misleading thing this page could do: a setup that drifted
   to -0.3R and timed out is not the same event as one that was stopped out at
   -1R, and lumping them hides that most signals here end by running out of time.
   ------------------------------------------------------------------- */
function histTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!isFinite(t)) return null;
  const d = new Date(t);
  // The viewer's own clock. "When did it fail" is a question about the day they
  // were having, not about UTC. The exact UTC stamp stays in the detail below.
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function histDur(fromIso, toIso) {
  const a = Date.parse(fromIso), b = toIso ? Date.parse(toIso) : Date.now();
  if (!isFinite(a) || !isFinite(b) || b < a) return null;
  const m = Math.round((b - a) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/* A signal you closed yourself. Deliberately a different shape from
   historyRow: these are NOT part of the engine's record and must never be
   counted into its won/lost/expired totals, or the page would be grading the
   engine on decisions you made. */
function myRow(x) {
  const R = num(x.resultR);
  const cls = R == null ? 'open' : R > 0 ? 'win' : 'loss';
  const started = histTime(x.firedAt), ended = histTime(x.closedAt);
  const dur = x.firedAt ? histDur(x.firedAt, x.closedAt) : null;
  return `<details class="hrow">
    <summary>
      <span class="h-caret">&#9656;</span>
      <span class="h-res ${cls}">BY YOU</span>
      <span class="h-mid">
        <span class="h-top"><span class="h-pair">${esc(x.pair || '—')}</span>
          <span class="h-when">${esc(String(x.direction || '').toUpperCase())}</span></span>
        <span class="h-span">${started ? `<b>${esc(started)}</b> &rarr; ` : ''}<b>${esc(ended || '—')}</b>${dur ? ` &middot; held ${esc(dur)}` : ''}</span>
      </span>
      <span class="h-r ${R == null ? '' : R > 0 ? 'pos' : 'neg'}">${R == null ? 'no price' : esc(sign(R) + R.toFixed(2)) + 'R'}</span>
    </summary>
    <div class="h-body">
      <dl class="kv">
        <dt>Closed by</dt><dd>you, not the engine</dd>
        <dt>Closed at</dt><dd>${x.closedPrice != null ? cp(x.closedPrice, 'close price', x.pair) : 'no live price was loaded, so no result was recorded'}</dd>
        <dt>Entry</dt><dd>${cp(x.entry, 'entry', x.pair)}</dd>
        <dt>Stop</dt><dd>${cp(x.sl, 'stop', x.pair)}</dd>
        <dt>TP1 / TP2 / TP3</dt><dd>${cp(x.tp1, 'TP1', x.pair)} &middot; ${cp(x.tp2, 'TP2', x.pair)} &middot; ${cp(x.tp3, 'TP3', x.pair)}</dd>
      </dl>
      <p style="margin-top:10px">This is your decision, not the engine's, so it is kept out of the won / lost /
        ran-out-of-time figures above — otherwise the engine would be scored on when you chose to step in.
        ${R == null ? 'No live price was loaded when you closed it, so no result is claimed.' : ''}</p>
      <button class="hf" data-reopen="${esc(x.key)}" style="margin-top:10px">Reopen this signal</button>
    </div>
  </details>`;
}

function historyRow(x) {
  const R = num(x.resultR);
  // Trust the published status; fall back to the sign only when it is absent.
  const st = String(x.status || (R == null ? 'open' : R > 0 ? 'won' : 'lost')).toLowerCase();
  const open = st === 'open';
  const cls = open ? 'open' : st === 'won' ? 'win' : st === 'expired' ? 'exp' : 'loss';
  const label = open ? 'OPEN' : st === 'won' ? 'WON' : st === 'expired' ? 'EXPIRED' : 'LOST';
  const mae = num(x.maeR), mfe = num(x.mfeR);

  const started = histTime(x.firedAt);
  const ended = histTime(x.resolvedAt);
  const dur = x.firedAt ? histDur(x.firedAt, x.resolvedAt) : null;
  const span = started
    ? `<span class="h-span"><b>${esc(started)}</b>${open
        ? ` &rarr; <em>still running</em>` + (dur ? ` &middot; ${esc(dur)} so far` : '')
        : ended ? ` &rarr; <b>${esc(ended)}</b>` + (dur ? ` &middot; ran ${esc(dur)}` : '') : ' &rarr; end time not recorded'}</span>`
    : '<span class="h-span">start time not recorded</span>';

  const utc = (iso) => new Date(iso).toUTCString().slice(5, 22) + ' UTC';

  return `<details class="hrow">
    <summary>
      <span class="h-caret">&#9656;</span>
      <span class="h-res ${cls}">${esc(label)}</span>
      <span class="h-mid">
        <span class="h-top"><span class="h-pair">${esc(x.pair || '—')}</span>
          <span class="h-when">${esc(String(x.direction || '').toUpperCase())}${x.tpReached ? ' &middot; TP' + esc(x.tpReached) : ''}</span></span>
        ${span}
      </span>
      <span class="h-r ${open ? '' : R > 0 ? 'pos' : 'neg'}">${open ? 'running' : esc(sign(R) + R.toFixed(2)) + 'R'}</span>
    </summary>
    <div class="h-body">
      <dl class="kv">
        <dt>Started</dt><dd>${x.firedAt ? esc(utc(x.firedAt)) : 'not recorded'}</dd>
        <dt>Ended</dt><dd>${x.resolvedAt ? esc(utc(x.resolvedAt)) : (open ? 'still running' : 'not recorded')}</dd>
        <dt>How it ended</dt><dd>${open ? 'has not ended yet'
          : st === 'won' ? 'closed ahead' + (x.tpReached ? ` after reaching TP${esc(x.tpReached)}` : '')
          : st === 'lost' ? 'closed behind' + (x.tpReached ? ` after reaching TP${esc(x.tpReached)} first` : ', without reaching a target')
          : `ran out of time after ${dur ? esc(dur) : 'its watch window'}${x.tpReached ? `, having reached TP${esc(x.tpReached)}` : ', without reaching a target'}`}</dd>
        <dt>Entry</dt><dd>${cp(x.entry, 'entry', x.pair)}</dd>
        <dt>Stop</dt><dd>${cp(x.sl, 'stop', x.pair)}</dd>
        <dt>TP1 / TP2 / TP3</dt><dd>${cp(x.tp1, 'TP1', x.pair)} &middot; ${cp(x.tp2, 'TP2', x.pair)} &middot; ${cp(x.tp3, 'TP3', x.pair)}</dd>
        <dt>Furthest reached</dt><dd>${x.tpReached ? 'TP' + esc(x.tpReached) : 'no target reached'}</dd>
        ${mfe != null ? `<dt>Best it went</dt><dd>${esc(sign(mfe) + mfe.toFixed(2))}R</dd>` : ''}
        ${mae != null ? `<dt>Went against it</dt><dd>${esc(mae.toFixed(2))}R${mae > 0 ? ' at its worst' : ''}</dd>` : ''}
        ${x.confidence != null ? `<dt>Confidence</dt><dd>${esc(x.confidence)}</dd>` : ''}
        ${x.regime ? `<dt>Regime</dt><dd>${esc(x.regime)}</dd>` : ''}
      </dl>
      <p style="margin-top:10px">${open
        ? 'Still running, so it counts for nothing yet.'
        : R > 0
          ? `Closed ${esc(sign(R) + R.toFixed(2))}R.${!x.tpReached ? ' It never reached a target — it timed out while ahead, which is why the two win rates on the Ledger differ.' : ''}${mae != null && mae > 0.5 ? ` It first went ${esc(mae.toFixed(2))}R against you.` : ''}`
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





/** An engine that changes its mind — tested, because "it should adapt" is a
    hypothesis and not a plan until somebody measures it. */
function renderAdaptive() {
  const a = S.adaptiveEngine;
  if (!a) return '';
  const A = a.adaptive, B = a.staticBaseline;
  const worse = a.selectionGainR < 0;
  return `
    <h2 class="sec" style="margin-top:26px">An engine that adapts</h2>
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:26px">
        <div class="rec-i"><div class="k">Adaptive, sealed</div>
          <div class="v" style="color:${A.sealed.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(A.sealed.avgR) + A.sealed.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">${esc(A.sealed.n.toLocaleString())} trades · t=${esc(A.sealed.t)}</div></div>
        <div class="rec-i"><div class="k">No selection at all</div>
          <div class="v" style="color:${B.sealed.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(B.sealed.avgR) + B.sealed.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">${esc(B.sealed.n.toLocaleString())} trades · t=${esc(B.sealed.t)}</div></div>
        <div class="rec-i"><div class="k">What adapting bought</div>
          <div class="v" style="color:${worse ? 'var(--down)' : 'var(--up)'}">${esc(sign(a.selectionGainR) + a.selectionGainR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">per trade, on data it never saw</div></div>
      </div>
      <div class="rec-note">
        At every bar it looked at how each of its ${esc(a.rules)} rules had done on its last ${esc(a.lookback)}
        <strong>already-resolved</strong> trades, and traded only the ones currently paying. Nothing from the
        future was consulted, and the bar was absolute rather than relative — scoring rules against each other
        promotes the least-bad loser.
        ${worse ? `<strong style="color:var(--warn)"> Adapting made it worse.</strong> Choosing rules by their
        recent record did not predict their next trade.` : ''}
        ${esc(a.verdict)}
      </div>
    </div>`;
}

/** The comparison every strategy owes you: is it better than doing nothing?
    A strategy that loses while holding gains is not a strategy. */
function renderBenchmark() {
  const b = S.benchmarkVsHolding, e = S.engineSealedTest, x = S.exitSearch;
  if (!b) return '';
  const bk = b.basket, best = b.instruments && b.instruments[0];
  return `
    <h2 class="sec" style="margin-top:4px">Is any of it better than doing nothing?</h2>
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:26px">
        <div class="rec-i"><div class="k">Hold all ${esc(bk.instruments)} equally</div>
          <div class="v" style="color:var(--up)">+${esc(bk.cagrPct)}%</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">a year over ${esc(bk.years)} years</div></div>
        ${b.engine ? `<div class="rec-i"><div class="k">The engine, all history</div>
          <div class="v" style="color:${b.engine.atOnePercentRisk.annualPct > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(b.engine.atOnePercentRisk.annualPct) + b.engine.atOnePercentRisk.annualPct)}%</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">a year at 1% risk, ${esc(b.engine.atOnePercentRisk.tradesPerYear)} trades</div></div>
        <div class="rec-i"><div class="k">The engine, sealed quarter</div>
          <div class="v" style="color:var(--down)">${esc((b.engine.sealedAvgR * b.engine.atOnePercentRisk.tradesPerYear).toFixed(1))}%</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">a year, on data it never saw</div></div>` : ''}
      </div>
      <div class="rec-note"><strong>${esc(b.verdict)}</strong></div>
    </div>

    ${x ? `<div class="voice-honest" style="margin-top:12px">
      <strong>And the exits cannot rescue it.</strong> ${esc(x.schemesTested)} different stop and target
      schemes were tested on ${esc(x.entries.toLocaleString())} of the engine's own entries, held constant so
      only the exit varied. ${esc(x.verdict)}
    </div>` : ''}

    <details class="fold" style="margin-top:12px;border-top:0"><summary>What simply holding each market returned</summary>
      <div class="fold-in">
        <table class="kb-t"><tr><th>market</th><th>years</th><th>a year</th><th>worst fall</th><th>return ÷ risk</th></tr>
        ${(b.instruments || []).map(r => `<tr>
          <td>${esc(r.pair)}</td><td>${esc(r.years)}</td>
          <td class="${r.cagrPct > 0 ? 'pos' : 'neg'}">${esc(sign(r.cagrPct) + r.cagrPct)}%</td>
          <td class="neg">−${esc(r.maxDrawdownPct)}%</td>
          <td>${esc(r.sharpe)}</td></tr>`).join('')}</table>
        <p style="margin-top:10px">Holding is not free money — every one of these fell ${esc(Math.min(...(b.instruments||[{maxDrawdownPct:0}]).map(r => r.maxDrawdownPct)))}% to
        ${esc(Math.max(...(b.instruments||[{maxDrawdownPct:0}]).map(r => r.maxDrawdownPct)))}% from peak at some point, and five of the FX
        majors lost money over two decades. The point is narrower: <strong>no strategy tested here beat it.</strong></p>
      </div></details>`;
}

/** The single most important measurement here: the ACTUAL engine, replayed over
    years of bars and judged on data it never saw while deciding. */
function renderEngineTest() {
  const e = S.engineSealedTest;
  if (!e) return '';
  const S4 = e.sealed, O = e.overall;
  const spans = Array.isArray(S4.ci) && S4.ci[0] <= 0 && S4.ci[1] >= 0;
  const conf = e.confidenceSplit;
  return `
    <h2 class="sec" style="margin-top:4px">The engine itself, on data it never saw</h2>
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:24px">
        <div class="rec-i"><div class="k">Signals replayed</div><div class="v">${esc(e.signalsFired.toLocaleString())}</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">over ${esc(e.barsScanned.toLocaleString())} bars</div></div>
        <div class="rec-i"><div class="k">Train</div><div class="v" style="font-size:20px;color:${e.train.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(e.train.avgR) + e.train.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">t=${esc(e.train.t)}</div></div>
        <div class="rec-i"><div class="k">Validate</div><div class="v" style="font-size:20px;color:${e.validate.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(e.validate.avgR) + e.validate.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">t=${esc(e.validate.t)}</div></div>
        <div class="rec-i"><div class="k">SEALED</div><div class="v" style="font-size:20px;color:${S4.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(S4.avgR) + S4.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">t=${esc(S4.t)}${spans ? ' · spans zero' : ''}</div></div>
      </div>
      <div class="rec-note">${esc(e.verdict)}
        Win rate held at ${esc(S4.winRate)}% across every split, so the engine is consistent — consistently
        at the level you would get without it.</div>
    </div>
    ${conf ? `<div class="voice-honest" style="margin-top:12px">
      <strong>Its confidence score does not predict the outcome.</strong>
      The higher-scoring half of ${esc(e.signalsFired.toLocaleString())} signals averaged
      ${esc(sign(conf.high.avgR) + conf.high.avgR)}R and the lower half ${esc(sign(conf.low.avgR) + conf.low.avgR)}R —
      a difference with t = −0.75, which establishes nothing in either direction. The number is still shown
      because it is what the engine thought, but it is labelled, and it should not be used to pick between setups.
    </div>` : ''}`;
}

/** Every chart searched on its own, not pooled. A pooled null can hide a single
    instrument that genuinely works — and a trader trades one chart, not the pool. */
function renderPerChart() {
  const p = S.perChartSearch;
  if (!p) return '';
  const expectedByLuck = Math.round(p.hypotheses * 0.05);
  const asExpected = Math.abs(p.survivedTrainAndValidate - expectedByLuck) < expectedByLuck * 0.5;
  return `
    <h2 class="sec" style="margin-top:26px">Every chart, tested on its own</h2>
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:26px">
        <div class="rec-i"><div class="k">Charts tested</div><div class="v">${esc(p.chartsTested)}</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">instrument × timeframe</div></div>
        <div class="rec-i"><div class="k">Backtests run</div><div class="v">${esc(p.backtestsRun.toLocaleString())}</div></div>
        <div class="rec-i"><div class="k">Passed</div>
          <div class="v" style="color:${p.passedSealed ? 'var(--up)' : 'var(--down)'}">${esc(p.passedSealed)}</div></div>
        <div class="rec-i"><div class="k">Bar to clear</div><div class="v" style="font-size:19px">|t| &gt; ${esc(p.correctedBarT)}</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">corrected for ${esc(p.hypotheses.toLocaleString())} hypotheses</div></div>
      </div>
      <div class="rec-note">
        ${esc(p.survivedTrainAndValidate)} combinations looked good through training AND validation on their own chart.
        ${asExpected ? `<strong>Chance alone predicts about ${esc(expectedByLuck)}.</strong> The survivors are
          indistinguishable from luck, which is exactly what searching ${esc(p.hypotheses.toLocaleString())}
          hypotheses produces.` : ''}
        ${esc(p.verdict)}
      </div>
    </div>
    ${(p.top || []).length ? `<details class="fold" style="margin-top:12px;border-top:0">
      <summary>The best survivors, and how they decayed</summary>
      <div class="fold-in">
        <table class="kb-t"><tr><th>chart</th><th>strategy</th><th>train</th><th>validate</th><th>sealed</th></tr>
        ${p.top.slice(0, 12).map(r => `<tr>
          <td>${esc(r.pair)} <i style="font-style:normal;color:var(--text-faint)">${esc(r.tf)}</i></td>
          <td>${esc(r.combo)}</td>
          <td>t=${esc(r.train.t)}</td><td>t=${esc(r.validate.t)}</td>
          <td class="${r.sealed.avgR > 0 ? 'pos' : 'neg'}">${esc(sign(r.sealed.avgR) + r.sealed.avgR)}R <i style="font-style:normal;color:var(--text-faint)">t=${esc(r.sealed.t)}</i></td>
        </tr>`).join('')}</table>
        <p style="margin-top:10px">Some of those sealed figures look strong — +0.33R, +0.35R. But a t of 2 against a
        required ${esc(p.correctedBarT)} is precisely what you expect to see somewhere when you look
        ${esc(p.hypotheses.toLocaleString())} times. That is why the bar is where it is.</p>
      </div></details>` : ''}`;
}

/* ─────────────── where the money actually goes ───────────────
   Every hypothesis about WHICH trade to take has now failed a sealed test:
   288 entry/filter/stop combinations, a pre-specified trend-alignment family
   test, 120 exit schemes, the confidence score, the per-chart search. It is
   reasonable to conclude the entry is not the lever.

   The cost audit says why, and it is not a subtle statistical point. The
   strategy grosses +0.032R per trade on data it never saw and nets +0.0027R.
   The spread takes 91.6% of it. The edge is real and too small to survive
   being charged for.

   This panel exists because that single number explains more than any of the
   search results do, and because a site that shows a break-even engine without
   showing where the money went is hiding the only useful part.
   ------------------------------------------------------------------- */
function renderCostAudit() {
  const c = S.costAudit;
  if (!c || !c.pooled || !c.pooled.sealed) return '';
  const g = c.pooled.sealed.gross, n = c.pooled.sealed.net;
  const cost = g.avgR - n.avgR;
  const share = c.sealedCostShareOfGrossPct;
  const rows = (c.perInstrument || []).slice();
  const keeps = rows.filter(r => r.costAsPctOfGross != null && r.costAsPctOfGross < 20);

  const refused = [
    { d: S.trendAlignmentTest,     t: 'Trading with the 200-period trend' },
    { d: S.costCeilingTest,        t: 'Refusing the trades you cannot afford' },
    { d: S.volatilityGradientTest, t: 'Trading only when the market is moving' },
    { d: S.atrMethodTest,          t: 'Measuring volatility the other common way' },
    { d: S.holdWindowTest,         t: 'Watching a setup for longer before giving up' },
  ].filter(x => x.d);

  return `
    <h2 class="sec" style="margin-top:4px">Where the money goes</h2>
    <div class="record" style="margin-top:0">
      <div class="rec-row" style="gap:26px">
        <div class="rec-i"><div class="k">Gross, before costs</div>
          <div class="v" style="font-size:20px;color:${g.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(g.avgR) + g.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">per trade, sealed quarter</div></div>
        <div class="rec-i"><div class="k">Taken by the spread</div>
          <div class="v" style="font-size:20px;color:var(--down)">−${esc(cost.toFixed(4))}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">${share != null ? esc(share) + '% of the gross' : 'known before each trade'}</div></div>
        <div class="rec-i"><div class="k">What is left</div>
          <div class="v" style="font-size:20px;color:${n.avgR > 0 ? 'var(--up)' : 'var(--down)'}">${esc(sign(n.avgR) + n.avgR)}R</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:6px">t=${esc(n.t)}${Array.isArray(n.ci) && n.ci[0] <= 0 && n.ci[1] >= 0 ? ' · spans zero' : ''}, ${esc(n.n.toLocaleString())} trades</div></div>
      </div>
      <div class="rec-note"><strong>This is the finding that explains the others.</strong>
        The strategy does find an edge before costs. ${share != null ? `It then hands ${esc(share)}% of it to the
        broker` : 'It then hands almost all of it to the broker'}, which is why nothing measured here comes out
        reliably positive. Cost is <em>spread ÷ stop distance</em> — both numbers are known before the trade is
        taken, so unlike everything else on this page it is arithmetic rather than a prediction.</div>
    </div>

    <details class="fold" style="margin-top:12px;border-top:0"><summary>What each market charges to get in</summary>
      <div class="fold-in">
        <table class="kb-t"><tr><th>market</th><th>trades</th><th>gross</th><th>spread</th><th>net</th><th>spread ÷ stop</th><th>of gross eaten</th></tr>
        ${rows.map(r => `<tr>
          <td>${esc(r.pair)}</td><td>${esc(r.trades)}</td>
          <td class="${r.grossR > 0 ? 'pos' : 'neg'}">${esc(sign(r.grossR) + r.grossR)}</td>
          <td class="neg">−${esc(r.costR)}</td>
          <td class="${r.netR > 0 ? 'pos' : 'neg'}">${esc(sign(r.netR) + r.netR)}</td>
          <td>${esc(r.spreadAsPctOfStop)}%</td>
          <td class="${r.costAsPctOfGross == null ? '' : r.costAsPctOfGross > 40 ? 'neg' : 'pos'}">${r.costAsPctOfGross == null ? 'gross ≤ 0' : esc(r.costAsPctOfGross) + '%'}</td>
        </tr>`).join('')}</table>
        <p style="margin-top:10px">Sorted by what the spread costs relative to the stop, which is the number that
        matters — a wide spread on a wide stop is cheap, a tight spread on a tight stop is not.
        ${keeps.length ? `Only <strong>${keeps.map(r => esc(r.pair)).join(' and ')}</strong>
        ${keeps.length === 1 ? 'keeps' : 'keep'} more than 80% of what ${keeps.length === 1 ? 'it makes' : 'they make'}.` : ''}
        ${rows.filter(r => r.costAsPctOfGross == null).length} of these ${esc(rows.length)} markets lose money
        before any cost is charged at all, so for those the spread is not the problem.</p>
      </div></details>

    ${refused.length ? `<details class="fold" style="margin-top:12px;border-top:0">
      <summary>Four things that were tested, and what each measured</summary>
      <div class="fold-in">
        ${refused.map(x => `<div style="margin-bottom:14px">
          <div style="font-weight:600;margin-bottom:4px">${esc(x.t)}
            <span style="font-weight:500;color:${x.d.established ? 'var(--up)' : 'var(--down)'}">— ${x.d.established ? 'holds' : 'refused'}</span></div>
          <div style="font-size:12.5px;line-height:1.65;color:var(--text-dim)">${esc(x.d.verdict)}</div>
          ${x.d.falsifierStatedBeforeRunning ? `<div style="font-size:11.5px;color:var(--text-faint);margin-top:5px">
            Falsifier fixed before running: ${esc(x.d.falsifierStatedBeforeRunning)}</div>` : ''}
        </div>`).join('')}
        <p>Each was written with its own falsifier stated in advance. None cleared it, and they are kept here
        rather than deleted because a page showing only the tests that passed would imply some did. One of them
        changed the system anyway: the watch window, where the measurement is ambiguous but the mechanism is not
        — once a third is banked at TP1 the stop sits at entry, so waiting longer cannot lose.</p>
      </div></details>` : ''}

    <p style="font-size:11.5px;color:var(--text-faint);margin-top:12px;line-height:1.6">${esc(c.method || '')}</p>`;
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
    ${renderBenchmark()}
    ${renderEngineTest()}
    ${renderCostAudit()}
    ${renderAdaptive()}

    <h2 class="sec">Textbook strategies, searched</h2>
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

    ${renderPerChart()}

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
    // Anything carrying data-copy, wherever it is drawn. These numbers go
    // straight into a broker ticket, and having them copyable on the card but
    // not in History or inside a fold is the kind of inconsistency you only
    // discover at the moment you need it.
    const n = e.target.closest('[data-copy]');
    if (n) { e.preventDefault(); copyLevel(n); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const n = e.target.closest && e.target.closest('[data-copy]');
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
  installClose();
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
