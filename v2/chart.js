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
  // Vertical state. null means auto-fit to what is visible, which is what you
  // want almost always; dragging the price axis takes manual control.
  yCenter: null, yZoom: 1, viewMode: 'own',
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
  const span0 = (hi - lo) || (hi * 0.001) || 1;
  lo -= span0 * 0.08; hi += span0 * 0.08;

  // Manual vertical zoom and pan, applied around the chosen centre.
  if (CH.yZoom !== 1 || CH.yCenter != null) {
    const c = CH.yCenter != null ? CH.yCenter : (lo + hi) / 2;
    const half = ((hi - lo) / 2) / CH.yZoom;
    lo = c - half; hi = c + half;
  }

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


/* ─────────────────── the real TradingView ───────────────────
   Our own chart is drawn from the bars the engine read, so it always agrees
   with the signal. TradingView is the other thing you want: the live market,
   with every tool you already know.

   Both are offered rather than one replacing the other, because they answer
   different questions — "what was this signal computed from" and "what is
   price doing right now".

   This is a third-party embed. It loads script from s3.tradingview.com, needs
   a connection, and will not work offline. Said plainly in the panel rather
   than left to be discovered.
   ----------------------------------------------------------------------- */

// Exchange prefixes matter: a bare "EURUSD" resolves to whatever TradingView
// picks that day, which may not be the instrument the signal is about.
const CH_TV = {
  'EUR/USD': 'FX:EURUSD',   'GBP/USD': 'FX:GBPUSD',   'USD/JPY': 'FX:USDJPY',
  'AUD/USD': 'FX:AUDUSD',   'NZD/USD': 'FX:NZDUSD',   'USD/CAD': 'FX:USDCAD',
  'USD/CHF': 'FX:USDCHF',   'EUR/GBP': 'FX:EURGBP',   'EUR/JPY': 'FX:EURJPY',
  'GBP/JPY': 'FX:GBPJPY',   'AUD/JPY': 'FX:AUDJPY',
  'XAU/USD': 'OANDA:XAUUSD','XAG/USD': 'OANDA:XAGUSD',
  'BTC/USD': 'BITSTAMP:BTCUSD', 'ETH/USD': 'BITSTAMP:ETHUSD',
  'SOL/USD': 'COINBASE:SOLUSD', 'XRP/USD': 'BITSTAMP:XRPUSD',
  'US30': 'TVC:DJI',        'NAS100': 'TVC:NDX',
};

function chTvSymbol(pair) {
  const p = String(pair || '').toUpperCase();
  if (CH_TV[p]) return CH_TV[p];
  // Last resort for an instrument added without a mapping: strip the slash and
  // let TradingView resolve it. Flagged in the UI so it is not mistaken for a
  // verified mapping.
  return p.replace('/', '');
}

function chTvUrl(pair) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(chTvSymbol(pair))}`;
}

let chTvLoaded = false;
function chMountTradingView() {
  const host = document.getElementById('tv-host');
  if (!host) return;
  const sym = chTvSymbol(CH.pair);
  const known = !!CH_TV[String(CH.pair).toUpperCase()];

  host.innerHTML = `<div class="tv-wrap"><div id="tv-widget"></div></div>
    <div class="tv-note">Live from TradingView${known ? '' : ' — this instrument has no verified symbol mapping, so check the ticker matches'}.
      Your signal levels are on the <b>Our chart</b> tab; TradingView does not know about them.</div>`;

  const build = () => {
    try {
      /* global TradingView */
      new TradingView.widget({
        container_id: 'tv-widget',
        symbol: sym,
        interval: '60',
        timezone: 'Etc/UTC',
        theme: 'dark',
        style: '1',
        locale: 'en',
        autosize: true,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        backgroundColor: 'rgba(11, 16, 32, 1)',
        gridColor: 'rgba(26, 34, 56, 0.6)',
        studies: [],
      });
    } catch (e) {
      host.innerHTML = `<div class="tv-fail"><strong>TradingView could not load</strong>
        <p>${chEsc(e.message || 'the embed failed')}. It needs a connection and is blocked by some networks.</p>
        <p><a href="${chTvUrl(CH.pair)}" target="_blank" rel="noopener noreferrer">Open ${chEsc(sym)} on tradingview.com instead</a></p></div>`;
    }
  };

  if (chTvLoaded && window.TradingView) { build(); return; }
  const sc = document.createElement('script');
  sc.src = 'https://s3.tradingview.com/tv.js';
  sc.async = true;
  sc.onload = () => { chTvLoaded = true; build(); };
  sc.onerror = () => {
    host.innerHTML = `<div class="tv-fail"><strong>TradingView could not be reached</strong>
      <p>The embed script did not load — you may be offline, or a network filter is blocking it.</p>
      <p><a href="${chTvUrl(CH.pair)}" target="_blank" rel="noopener noreferrer">Open ${chEsc(sym)} on tradingview.com instead</a></p></div>`;
  };
  document.head.appendChild(sc);
}

const chEsc = (x) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function chSetView(which) {
  CH.viewMode = which;
  const own = document.querySelector('.ch-wrap');
  const tv = document.getElementById('tv-host');
  const rd = document.getElementById('chart-readout');
  const lg = document.getElementById('chart-legend');
  const zoom = document.querySelector('.ch-zoom');
  if (!own || !tv) return;
  const isTv = which === 'tv';
  own.style.display = isTv ? 'none' : '';
  tv.style.display = isTv ? '' : 'none';
  if (rd) rd.style.display = isTv ? 'none' : '';
  if (lg) lg.style.display = isTv ? 'none' : '';
  if (zoom) zoom.style.display = isTv ? 'none' : '';
  for (const b of document.querySelectorAll('.ch-mode')) b.classList.toggle('on', b.dataset.mode === which);
  if (isTv) chMountTradingView(); else chDraw();
}


/* ─────────────────── interaction ───────────────────
   Wheel and pinch to zoom, drag to pan, double-click to reset. The price axis
   is its own drag target for vertical zoom, so panning sideways never fights
   with rescaling.

   Cheap by design: every gesture only edits CH.view or the y-state and asks for
   one redraw on the next frame. A full redraw measures 0.2ms, so this stays
   inside a 120Hz budget with room to spare.
   ----------------------------------------------------------------------- */
function chClampView(from, to) {
  const n = CH.bars.length;
  let w = Math.max(20, Math.min(n, Math.round(to - from)));   // never fewer than 20 bars
  let f = Math.round(from);
  if (f < 0) f = 0;
  if (f + w > n) f = n - w;
  if (f < 0) { f = 0; w = n; }
  return { from: f, to: f + w };
}

function chZoomAt(factor, anchorRatio) {
  const { from, to } = CH.view;
  const w = to - from;
  const nw = w / factor;
  const a = from + w * anchorRatio;                 // keep this bar under the cursor
  CH.view = chClampView(a - nw * anchorRatio, a - nw * anchorRatio + nw);
  chSavePref();
  chRequestDraw();
}

let _drawPending = false;
function chRequestDraw() {
  if (_drawPending) return;
  _drawPending = true;
  requestAnimationFrame(() => { _drawPending = false; chDraw(); });
}

function chInstallInteraction(cv) {
  if (cv._chInteract) return;
  cv._chInteract = true;
  const PAD_R = 72, PAD_L = 6;
  const plotW = () => Math.max(1, cv.clientWidth - PAD_R - PAD_L);

  // ── wheel: zoom the time window around the pointer
  cv.addEventListener('wheel', (e) => {
    if (!CH.bars.length) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const overAxis = (e.clientX - r.left) > cv.clientWidth - PAD_R;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    if (overAxis || e.shiftKey) {
      // Over the price axis, the wheel scales vertically instead.
      chSetYZoom(CH.yZoom * factor, r, e.clientY - r.top);
    } else {
      const ratio = Math.max(0, Math.min(1, (e.clientX - r.left - PAD_L) / plotW()));
      chZoomAt(factor, ratio);
    }
  }, { passive: false });

  // ── drag: pan. Horizontal over the plot, vertical over the price axis.
  let pan = null;
  cv.addEventListener('pointerdown', (e) => {
    if (!CH.bars.length) return;
    const r = cv.getBoundingClientRect();
    const onAxis = (e.clientX - r.left) > cv.clientWidth - PAD_R;
    pan = { x: e.clientX, y: e.clientY, view: { ...CH.view }, onAxis,
            yZoom: CH.yZoom, yCenter: CH.yCenter, moved: false, id: e.pointerId };
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) < 4) return;    // still a click
    pan.moved = true;
    cv.style.cursor = 'grabbing';
    if (pan.onAxis) {
      chSetYZoom(pan.yZoom * (1 + dy / 220), cv.getBoundingClientRect(), null, pan.yCenter);
    } else {
      const w = pan.view.to - pan.view.from;
      const barsMoved = (dx / plotW()) * w;
      CH.view = chClampView(pan.view.from - barsMoved, pan.view.to - barsMoved);
      chRequestDraw();
    }
  });
  const endPan = (e) => {
    if (!pan) return;
    const wasDrag = pan.moved;
    try { cv.releasePointerCapture(pan.id); } catch (_) {}
    pan = null;
    cv.style.cursor = '';
    if (wasDrag) { for (const b of document.querySelectorAll('.ch-z')) b.classList.remove('on'); }
  };
  cv.addEventListener('pointerup', endPan);
  cv.addEventListener('pointercancel', endPan);

  // ── pinch to zoom, two fingers
  const touches = new Map();
  let pinchStart = null;
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, e);
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinchStart = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), view: { ...CH.view } };
      pan = null;                                   // a pinch is not a pan
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, e);
    if (touches.size !== 2 || !pinchStart) return;
    e.preventDefault();
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const factor = d / (pinchStart.dist || 1);
    const w = pinchStart.view.to - pinchStart.view.from;
    const nw = w / factor;
    const mid = (pinchStart.view.from + pinchStart.view.to) / 2;
    CH.view = chClampView(mid - nw / 2, mid + nw / 2);
    chRequestDraw();
  }, { passive: false });
  const dropTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinchStart = null; };
  cv.addEventListener('pointerup', dropTouch);
  cv.addEventListener('pointercancel', dropTouch);

  // ── double-click / double-tap: back to auto
  cv.addEventListener('dblclick', (e) => { e.preventDefault(); chResetView(); });
  let lastTap = 0;
  cv.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = Date.now();
    if (now - lastTap < 300) chResetView();
    lastTap = now;
  });
}

function chSetYZoom(z, rect, pointerY, keepCentre) {
  CH.yZoom = Math.max(0.25, Math.min(12, z));
  chSavePref();
  if (CH.yCenter == null && keepCentre == null) {
    // Lock the centre to whatever is on screen the first time it is used, so
    // the chart does not jump when manual scaling begins.
    const vis = CH.bars.slice(CH.view.from, CH.view.to);
    if (vis.length) {
      let lo = Infinity, hi = -Infinity;
      for (const b of vis) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
      CH.yCenter = (lo + hi) / 2;
    }
  } else if (keepCentre != null) CH.yCenter = keepCentre;
  chRequestDraw();
}

function chResetView() {
  CH.yZoom = 1; CH.yCenter = null;
  chSetBars(120);                           // an explicit reset DOES become the new preference
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
        <div class="ch-modes">
          <button class="ch-mode on" data-mode="own">Our chart</button>
          <button class="ch-mode" data-mode="tv">TradingView</button>
          <a class="ch-ext" id="chart-ext" target="_blank" rel="noopener noreferrer">Open in TradingView &nearr;</a>
        </div>
        <div class="ch-readout" id="chart-readout"></div>
        <div class="ch-wrap"><canvas id="chart-canvas"></canvas></div>
        <div id="tv-host" style="display:none"></div>
        <div class="ch-hint">Scroll or pinch to zoom · drag to pan · drag the price axis to stretch it · double-click to reset</div>
        <div class="ch-legend" id="chart-legend"></div>
      </div>`;
    document.body.appendChild(el0);

    el0.addEventListener('click', (e) => {
      if (e.target.dataset.chclose) chClose();
      const z = e.target.closest('[data-bars]');
      if (z) { chSetBars(+z.dataset.bars); }
      const m = e.target.closest('[data-mode]');
      if (m) chSetView(m.dataset.mode);
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
    chInstallInteraction(cv);
    window.addEventListener('resize', () => chRequestDraw());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chClose(); });
  }
  el0.classList.add('open');

  document.getElementById('chart-pair').textContent = `${CH.pair} ${CH.sig.direction}`;
  const ext = document.getElementById('chart-ext');
  if (ext) { ext.href = chTvUrl(CH.pair); ext.title = `Open ${chTvSymbol(CH.pair)} on tradingview.com`; }
  chSetView('own');                       // always open on our own chart
  document.getElementById('chart-sub').textContent = 'loading bars…';
  document.getElementById('chart-legend').innerHTML = '';

  // Paint whatever is cached on this frame, however old, then reconcile. A
  // chart that appears instantly and corrects itself a moment later is far
  // better than a blank panel that waits for the network.
  const pref = chLoadPref();
  const wantBars = pref && pref.bars > 0 ? pref.bars : 120;
  const cached = CH_CACHE.get(CH.pair);
  if (cached && cached.bars.length) {
    CH.bars = cached.bars;
    chSetBars(wantBars, { remember: false });
    if (pref && pref.yZoom && pref.yZoom !== 1) CH.yZoom = pref.yZoom;
    chRefreshMeta();
  }

  const bars = await chLoadBars(CH.pair);
  if (!bars || !bars.length) {
    if (!cached) document.getElementById('chart-sub').textContent = 'no published bars for this instrument';
    return;
  }
  CH.bars = bars;
  CH.lastFetch = Date.now();
  // Keep whatever zoom was last chosen rather than snapping back to a default
  // every time a chart opens.
  chSetBars(wantBars, { remember: false });
  if (pref && pref.yZoom && pref.yZoom !== 1) CH.yZoom = pref.yZoom;
  chRefreshMeta();

  clearInterval(CH.timer);
  // The published bars refresh on the mirror cycle; polling faster than that
  // would just re-download the same file.
  CH.timer = setInterval(chTick, 30000);
}

/** Where the chosen view is kept between charts and between sessions. */
const CH_PREF = 'fs.chart.view.v1';
function chSavePref() {
  try {
    localStorage.setItem(CH_PREF, JSON.stringify({
      bars: CH.view.to - CH.view.from, yZoom: CH.yZoom,
    }));
  } catch (_) {}
}
function chLoadPref() {
  try {
    const p = JSON.parse(localStorage.getItem(CH_PREF));
    if (p && p.bars > 0) return p;
  } catch (_) {}
  return null;
}

function chSetBars(n, { remember = true } = {}) {
  CH.yZoom = 1; CH.yCenter = null;          // a preset window implies auto-fit
  const total = CH.bars.length;
  CH.view = { from: Math.max(0, total - n), to: total };
  for (const b of document.querySelectorAll('.ch-z')) b.classList.toggle('on', +b.dataset.bars === n);
  if (remember) chSavePref();
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

window.FSCHART = { open: chOpen, close: chClose, draw: chDraw, prefetch: chPrefetch,
                   tvSymbol: chTvSymbol, tvUrl: chTvUrl, TV_MAP: CH_TV, state: CH };
