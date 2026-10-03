/* ============================================================================
   v2/chart.js — the signal, drawn on its own chart.

   Canvas, no library. The bars are the SAME hourly OHLC the engine reads, so
   what you see is what the signal was computed from — not a lookalike from a
   different feed, which would quietly disagree at the edges.

   What it refuses to do: draw anything it does not have. A missing bar is a
   gap, not an interpolated line, because a smoothed-over gap on a price chart
   is a lie about where price went.
   ========================================================================== */
'use strict';

const CH = {
  bars: [], pair: null, sig: null, tf: '1h',
  view: { from: 0, to: 0 },          // index window into bars
  hover: null, dpr: 1, timer: null, lastFetch: 0,
};

const CH_COL = {
  up: '#2fd98a', down: '#ff5f6d', wick: '#5c6884',
  grid: '#1a2238', axis: '#5c6884', text: '#9aa6c2', bright: '#eef2fb',
  entry: '#6b8cff', sl: '#ff5f6d', tp: '#2fd98a', now: '#ffb63d',
};

const chDp = (pair) => /JPY/.test(pair) ? 3 : /XAU|XAG|BTC|ETH|SOL|XRP|US30|NAS/.test(pair) ? 2 : 5;
const chFmt = (v, pair) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(chDp(pair)) : '—';

/* ── data ───────────────────────────────────────────────────────────────── */
// Bars are cached per instrument. Opening a chart used to wait on a network
// round trip every time, which is the whole of the perceived lag — the drawing
// itself measures 0.2ms. A cached open paints on the same frame as the tap.
const CH_CACHE = new Map();          // pair -> { bars, at }
const CH_TTL = 60000;

async function chLoadBars(pair, { allowStale = false } = {}) {
  const hit = CH_CACHE.get(pair);
  if (hit && (allowStale || Date.now() - hit.at < CH_TTL)) {
    // Fresh enough to use now. If it is ageing, refresh behind the scenes so
    // the NEXT open is instant too, without blocking this one.
    if (Date.now() - hit.at >= CH_TTL) chFetchBars(pair).catch(() => {});
    return hit.bars;
  }
  return chFetchBars(pair);
}

async function chFetchBars(pair) {
  const slug = String(pair).replace('/', '-');
  const bust = Date.now();
  const urls = [
    `https://raw.githubusercontent.com/Jboy-dev/forexsight/main/data/ohlc/${slug}.json?_b=${bust}`,
    `/data/ohlc/${slug}.json?_b=${bust}`,
  ];
  const got = [];
  await Promise.all(urls.map(async (u) => {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      const bars = Array.isArray(j) ? j : (j.bars || j.ohlc || []);
      if (bars.length) got.push({ bars, ts: j.ts || bars[bars.length - 1].t });
    } catch (_) {}
  }));
  if (!got.length) return null;
  // Freshest wins, same rule the rest of the app uses.
  got.sort((a, b) => b.ts - a.ts);
  const bars = got[0].bars.filter(b => b && [b.o, b.h, b.l, b.c].every(v => typeof v === 'number' && isFinite(v) && v > 0));
  if (bars.length) CH_CACHE.set(pair, { bars, at: Date.now() });
  return bars;
}

/** Warm the cache for setups on screen, so the first tap is as fast as the second. */
function chPrefetch(pairs) {
  for (const p of pairs.slice(0, 6)) {
    if (CH_CACHE.has(p)) continue;
    chFetchBars(p).catch(() => {});
  }
}

/* ── drawing ────────────────────────────────────────────────────────────── */
function chDraw() {
  const cv = document.getElementById('chart-canvas');
  if (!cv || !CH.bars.length) return;
  // Render at the panel's true pixel density so lines and type are sharp on a
  // retina or OLED screen rather than upscaled. Capped at 3: beyond that the
  // buffer grows quadratically for no visible gain, and on a large phone that
  // is the difference between a smooth chart and a stuttering one.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  CH.dpr = dpr;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const padR = 72, padB = 26, padT = 10, padL = 6;
  const plotW = W - padR - padL, plotH = H - padB - padT;
  if (plotW <= 10 || plotH <= 10) return;

  const { from, to } = CH.view;
  const vis = CH.bars.slice(from, to);
  if (!vis.length) return;

  // Scale must include every level we are about to draw, or a stop sitting off
  // the top of the chart looks like it does not exist.
  let lo = Infinity, hi = -Infinity;
  for (const b of vis) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const s = CH.sig;
  if (s) for (const v of [s.entry, s.sl, s.tp1, s.tp2, s.tp3]) {
    if (typeof v === 'number' && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const span = (hi - lo) || (hi * 0.001) || 1;
  lo -= span * 0.08; hi += span * 0.08;

  const x = (i) => padL + (i + 0.5) * (plotW / vis.length);
  const y = (p) => padT + (hi - p) / (hi - lo) * plotH;

  // grid + price axis
  g.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  g.textBaseline = 'middle';
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const p = lo + (hi - lo) * (i / ticks), py = y(p);
    g.strokeStyle = CH_COL.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, Math.round(py) + 0.5); g.lineTo(padL + plotW, Math.round(py) + 0.5); g.stroke();
    g.fillStyle = CH_COL.axis; g.textAlign = 'left';
    g.fillText(chFmt(p, CH.pair), padL + plotW + 7, py);
  }

  // time axis
  const everyN = Math.max(1, Math.floor(vis.length / 6));
  g.textAlign = 'center'; g.fillStyle = CH_COL.axis;
  for (let i = 0; i < vis.length; i += everyN) {
    const d = new Date(vis[i].t);
    const lbl = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    g.fillText(lbl, x(i), H - padB / 2);
  }

  // candles
  const cw = Math.max(1, (plotW / vis.length) * 0.66);
  for (let i = 0; i < vis.length; i++) {
    const b = vis[i], up = b.c >= b.o;
    const cx = x(i);
    g.strokeStyle = up ? CH_COL.up : CH_COL.down;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(cx) + 0.5, y(b.h)); g.lineTo(Math.round(cx) + 0.5, y(b.l)); g.stroke();
    const yo = y(b.o), yc = y(b.c);
    const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
    g.fillStyle = up ? CH_COL.up : CH_COL.down;
    g.fillRect(cx - cw / 2, top, cw, hgt);
  }

  // the signal's levels
  const line = (price, colour, label, dashed) => {
    if (typeof price !== 'number' || !isFinite(price)) return;
    const py = Math.round(y(price)) + 0.5;
    if (py < padT - 2 || py > padT + plotH + 2) return;
    g.save();
    g.strokeStyle = colour; g.lineWidth = 1.25;
    if (dashed) g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + plotW, py); g.stroke();
    g.restore();
    const txt = `${label} ${chFmt(price, CH.pair)}`;
    g.font = '600 9.5px ui-monospace, SF Mono, Menlo, monospace';
    const tw = g.measureText(txt).width + 10;
    g.fillStyle = colour;
    g.fillRect(padL + 2, py - 8, tw, 16);
    g.fillStyle = '#070a12'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(txt, padL + 7, py);
    g.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  };

  if (s) {
    line(s.sl, CH_COL.sl, 'SL', false);
    line(s.entry, CH_COL.entry, 'ENTRY', false);
    line(s.tp1, CH_COL.tp, 'TP1', true);
    line(s.tp2, CH_COL.tp, 'TP2', true);
    line(s.tp3, CH_COL.tp, 'TP3', true);

    // shade risk and reward so the geometry is visible, not just numeric
    const shade = (a, b2, colour) => {
      if (![a, b2].every(v => typeof v === 'number' && isFinite(v))) return;
      const ya = y(a), yb = y(b2);
      g.fillStyle = colour;
      g.fillRect(padL, Math.min(ya, yb), plotW, Math.abs(yb - ya));
    };
    shade(s.entry, s.sl, '#ff5f6d12');
    shade(s.entry, s.tp3, '#2fd98a10');
  }

  // last traded price
  const last = vis[vis.length - 1];
  if (last) {
    const py = Math.round(y(last.c)) + 0.5;
    g.save(); g.strokeStyle = CH_COL.now; g.lineWidth = 1; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + plotW, py); g.stroke(); g.restore();
    g.fillStyle = CH_COL.now;
    g.fillRect(padL + plotW + 2, py - 8, padR - 4, 16);
    g.fillStyle = '#070a12'; g.font = '600 9.5px ui-monospace, monospace'; g.textAlign = 'left';
    g.fillText(chFmt(last.c, CH.pair), padL + plotW + 6, py);
  }

  // crosshair
  if (CH.hover) {
    const i = Math.max(0, Math.min(vis.length - 1, Math.round((CH.hover.x - padL) / (plotW / vis.length) - 0.5)));
    const b = vis[i];
    if (b) {
      g.save(); g.strokeStyle = '#8fa8ff66'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(x(i)) + 0.5, padT); g.lineTo(Math.round(x(i)) + 0.5, padT + plotH); g.stroke();
      g.beginPath(); g.moveTo(padL, Math.round(CH.hover.y) + 0.5); g.lineTo(padL + plotW, Math.round(CH.hover.y) + 0.5); g.stroke();
      g.restore();
      const rd = document.getElementById('chart-readout');
      if (rd) {
        const d = new Date(b.t);
        rd.innerHTML = `<b>${d.toISOString().slice(0, 16).replace('T', ' ')} UTC</b>`
          + `<span>O ${chFmt(b.o, CH.pair)}</span><span>H ${chFmt(b.h, CH.pair)}</span>`
          + `<span>L ${chFmt(b.l, CH.pair)}</span><span class="${b.c >= b.o ? 'up' : 'dn'}">C ${chFmt(b.c, CH.pair)}</span>`;
      }
    }
  }
}

/* ── open / refresh ─────────────────────────────────────────────────────── */
async function chOpen(sig, pickFn) {
  const pick = pickFn || ((o, ...k) => k.reduce((a, kk) => a ?? o[kk], null));
  CH.pair = pick(sig, 'pair', 'symbol');
  CH.sig = {
    entry: +pick(sig, 'entry', 'price'), sl: +pick(sig, 'sl', 'stopLoss'),
    tp1: +pick(sig, 'tp1'), tp2: +pick(sig, 'tp2'), tp3: +pick(sig, 'tp3'),
    direction: String(pick(sig, 'direction', 'side') || '').toUpperCase(),
    detectedAt: pick(sig, 'detectedAt'),
  };

  let el0 = document.getElementById('chart');
  if (!el0) {
    el0 = document.createElement('div');
    el0.id = 'chart'; el0.className = 'ch';
    el0.innerHTML = `
      <div class="ch-back" data-chclose="1"></div>
      <div class="ch-panel" role="dialog" aria-modal="true" aria-label="Signal chart">
        <div class="ch-top">
          <div><div class="ch-pair" id="chart-pair"></div><div class="ch-sub" id="chart-sub"></div></div>
          <div class="ch-zoom">
            ${[60, 120, 240, 500].map(n => `<button class="ch-z" data-bars="${n}">${n}</button>`).join('')}
          </div>
          <button class="rs-x" data-chclose="1" aria-label="Close">&times;</button>
        </div>
        <div class="ch-readout" id="chart-readout"></div>
        <div class="ch-wrap"><canvas id="chart-canvas"></canvas></div>
        <div class="ch-legend" id="chart-legend"></div>
      </div>`;
    document.body.appendChild(el0);

    el0.addEventListener('click', (e) => {
      if (e.target.dataset.chclose) chClose();
      const z = e.target.closest('[data-bars]');
      if (z) { chSetBars(+z.dataset.bars); }
    });
    const cv = el0.querySelector('#chart-canvas');
    let rafPending = false;
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      CH.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      // Coalesce to one redraw per frame. A 120Hz pointer can fire faster than
      // the display refreshes, and redrawing more often than that is work the
      // screen throws away.
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; chDraw(); });
    }, { passive: true });
    cv.addEventListener('pointerleave', () => { CH.hover = null; chDraw(); const rd = document.getElementById('chart-readout'); if (rd) rd.innerHTML = ''; });
    window.addEventListener('resize', () => chDraw());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chClose(); });
  }
  el0.classList.add('open');

  document.getElementById('chart-pair').textContent = `${CH.pair} ${CH.sig.direction}`;
  document.getElementById('chart-sub').textContent = 'loading bars…';
  document.getElementById('chart-legend').innerHTML = '';

  // Paint whatever is cached on this frame, however old, then reconcile. A
  // chart that appears instantly and corrects itself a moment later is far
  // better than a blank panel that waits for the network.
  const cached = CH_CACHE.get(CH.pair);
  if (cached && cached.bars.length) {
    CH.bars = cached.bars;
    chSetBars(120);
    chRefreshMeta();
  }

  const bars = await chLoadBars(CH.pair);
  if (!bars || !bars.length) {
    if (!cached) document.getElementById('chart-sub').textContent = 'no published bars for this instrument';
    return;
  }
  CH.bars = bars;
  CH.lastFetch = Date.now();
  chSetBars(120);
  chRefreshMeta();

  clearInterval(CH.timer);
  // The published bars refresh on the mirror cycle; polling faster than that
  // would just re-download the same file.
  CH.timer = setInterval(chTick, 30000);
}

function chSetBars(n) {
  const total = CH.bars.length;
  CH.view = { from: Math.max(0, total - n), to: total };
  for (const b of document.querySelectorAll('.ch-z')) b.classList.toggle('on', +b.dataset.bars === n);
  chDraw();
}

function chRefreshMeta() {
  const last = CH.bars[CH.bars.length - 1];
  const sub = document.getElementById('chart-sub');
  if (sub && last) {
    const ageMin = Math.round((Date.now() - last.t) / 60000);
    sub.textContent = `hourly · ${CH.bars.length} bars · last ${chFmt(last.c, CH.pair)} · ${ageMin < 90 ? ageMin + 'm ago' : Math.round(ageMin / 60) + 'h ago'}`;
  }
  const lg = document.getElementById('chart-legend');
  const s = CH.sig;
  if (lg && s) {
    const risk = Math.abs(s.entry - s.sl);
    const rOf = (tp) => (risk > 0 && isFinite(tp)) ? (Math.abs(tp - s.entry) / risk).toFixed(2) + 'R' : '—';
    lg.innerHTML = [
      ['ENTRY', s.entry, CH_COL.entry, ''],
      ['STOP', s.sl, CH_COL.sl, '−1.00R'],
      ['TP1', s.tp1, CH_COL.tp, rOf(s.tp1)],
      ['TP2', s.tp2, CH_COL.tp, rOf(s.tp2)],
      ['TP3', s.tp3, CH_COL.tp, rOf(s.tp3)],
    ].map(([k, v, c, r]) => `<span class="ch-lg"><i style="background:${c}"></i>${k} ${chFmt(v, CH.pair)}${r ? ` <b>${r}</b>` : ''}</span>`).join('');
  }
}

async function chTick() {
  if (!document.getElementById('chart') || !document.getElementById('chart').classList.contains('open')) return;
  const bars = await chLoadBars(CH.pair);
  if (!bars || !bars.length) return;
  const grew = bars.length - CH.bars.length;
  const windowSize = CH.view.to - CH.view.from;
  CH.bars = bars;
  // Keep the same window width anchored to the right edge, so a new bar slides
  // in rather than the chart jumping.
  CH.view = { from: Math.max(0, bars.length - windowSize), to: bars.length };
  CH.lastFetch = Date.now();
  chRefreshMeta();
  chDraw();
}

function chClose() {
  const e = document.getElementById('chart');
  if (e) e.classList.remove('open');
  clearInterval(CH.timer);
  CH.timer = null;
}

window.FSCHART = { open: chOpen, close: chClose, draw: chDraw, prefetch: chPrefetch, state: CH };
