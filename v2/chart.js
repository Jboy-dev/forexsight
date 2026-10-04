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

/**
 * Decimals from the PRICE, not from the symbol.
 *
 * Classing XRP with BTC gave it 2 decimals, so a stop of 1.49747 and an entry
 * of 1.49150 both rendered as "1.50" and "1.49" — two levels 0.6% apart looked
 * adjacent, on a chart whose entire job is showing you where they sit. Bucketing
 * by instrument cannot work when one bucket spans 85,000 and 1.50.
 */
function chDp(pair, price) {
  const p = String(pair || '');
  if (typeof price === 'number' && isFinite(price) && price > 0) {
    const a = Math.abs(price);
    if (a >= 10000) return 1;      // BTC, indices
    if (a >= 1000) return 2;       // gold, NAS100
    if (a >= 100) return 3;        // JPY pairs, SOL, silver
    if (a >= 10) return 4;
    if (a >= 1) return 5;          // XRP, EUR/USD, most FX
    return 6;                      // anything sub-1
  }
  return /JPY/.test(p) ? 3 : /XAU|XAG|BTC|ETH|US30|NAS/.test(p) ? 2 : 5;
}
const chFmt = (v, pair) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(chDp(pair, v)) : '—';

/* ── data ───────────────────────────────────────────────────────────────── */
// Bars are cached per instrument. Opening a chart used to wait on a network
// round trip every time, which is the whole of the perceived lag — the drawing
// itself measures 0.2ms. A cached open paints on the same frame as the tap.
const CH_CACHE = new Map();          // pair -> { bars, at }
const CH_TTL = 60000;

async function chLoadBars(pair, source = '1h', { allowStale = false } = {}) {
  const ck = pair + '|' + source;
  const hit = CH_CACHE.get(ck);
  if (hit && (allowStale || Date.now() - hit.at < CH_TTL)) {
    // Fresh enough to use now. If it is ageing, refresh behind the scenes so
    // the NEXT open is instant too, without blocking this one.
    if (Date.now() - hit.at >= CH_TTL) chFetchBars(pair, source).catch(() => {});
    return hit.bars;
  }
  return chFetchBars(pair, source);
}

async function chFetchBars(pair, source = '1h') {
  const slug = String(pair).replace('/', '-');
  const suffix = source === '15m' ? '.15m' : '';
  const bust = Date.now();
  const urls = [
    `https://raw.githubusercontent.com/Jboy-dev/forexsight/main/data/ohlc/${slug}${suffix}.json?_b=${bust}`,
    `/data/ohlc/${slug}${suffix}.json?_b=${bust}`,
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
  if (bars.length) CH_CACHE.set(pair + '|' + source, { bars, at: Date.now() });
  return bars;
}

/** Warm the cache for setups on screen, so the first tap is as fast as the second.
 *
 * It must ALSO announce when bars land. The live tracker on each card reads this
 * cache, and the cards render before any fetch completes — so without a signal
 * the tracker drew "live price not loaded" once and stayed that way until the
 * next two-minute cycle. On a phone opening the app cold that is all you ever
 * saw, which is exactly the bar going missing. */
function chPrefetch(pairs) {
  const wanted = pairs.slice(0, 8).filter(p => p && !CH_CACHE.has(p + '|1h'));
  if (!wanted.length) return;
  let landed = 0;
  for (const p of wanted) {
    chFetchBars(p, '1h')
      .then((bars) => { if (bars && bars.length) landed++; })
      .catch(() => {})
      .finally(() => {
        // Tell the page once the whole batch has settled, so it redraws with
        // real prices instead of waiting for the next cycle.
        if (--pending === 0 && landed > 0) {
          try { window.dispatchEvent(new CustomEvent('fs-bars-ready', { detail: { landed } })); } catch (_) {}
        }
      });
  }
  var pending = wanted.length;
}


/* ───────────────── timeframes ─────────────────
   1h is published; 15m is published separately because a lower timeframe
   cannot be invented from a higher one. 4h and 1D are AGGREGATED up from the
   hourly series, which is exact: open of the first bar, close of the last,
   the highest high, the lowest low, volume summed.
   ------------------------------------------------------------------- */
const CH_TFS = [
  { id: '15m', label: '15m', source: '15m', group: 1 },
  { id: '1h',  label: '1H',  source: '1h',  group: 1 },
  { id: '4h',  label: '4H',  source: '1h',  group: 4 },
  { id: '1d',  label: '1D',  source: '1h',  group: 24 },
];

function chAggregate(bars, n) {
  if (n <= 1) return bars;
  const out = [];
  for (let i = 0; i < bars.length; i += n) {
    const slice = bars.slice(i, i + n);
    if (!slice.length) continue;
    let hi = -Infinity, lo = Infinity, vol = 0, anyVol = false;
    for (const b of slice) {
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
      if (typeof b.v === 'number' && b.v > 0) { vol += b.v; anyVol = true; }
    }
    out.push({ t: slice[0].t, o: slice[0].o, h: hi, l: lo,
               c: slice[slice.length - 1].c, v: anyVol ? vol : null });
  }
  return out;
}

async function chLoadForTf(pair, tfId) {
  const tf = CH_TFS.find(x => x.id === tfId) || CH_TFS[1];
  const base = await chLoadBars(pair, tf.source);
  if (!base || !base.length) return null;
  return chAggregate(base, tf.group);
}

/* ── drawing ────────────────────────────────────────────────────────────── */
/** Gridlines on ROUND numbers, the way a price scale is actually read.
    Evenly dividing the range gives ticks like 2693.47, which no one reads. */
function chNiceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function chSMA(bars, period) {
  const out = Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function chDraw() {
  const cv = document.getElementById('chart-canvas');
  if (!cv || !CH.bars.length) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  CH.dpr = dpr;
  const W = cv.clientWidth, H = cv.clientHeight;
  const needW = Math.round(W * dpr), needH = Math.round(H * dpr);
  // Only resize when the size actually changed: assigning cv.width reallocates
  // the backing store and RELEASES POINTER CAPTURE, which fires pointercancel
  // and kills any gesture in progress.
  if (cv.width !== needW || cv.height !== needH) { cv.width = needW; cv.height = needH; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const padR = 76, padB = 24, padT = 26, padL = 6;
  const { from, to } = CH.view;
  const vis = CH.bars.slice(from, to);
  if (!vis.length) return;

  // Volume gets its own strip, but only where volume is real. Spot FX has no
  // central exchange and therefore no genuine volume; drawing an empty strip
  // there would imply data that does not exist.
  const hasVol = vis.some(b => typeof b.v === 'number' && b.v > 0);
  const volH = hasVol ? Math.round((H - padT - padB) * 0.18) : 0;
  const plotW = W - padR - padL;
  const plotH = H - padB - padT - volH;
  if (plotW <= 10 || plotH <= 10) return;

  let lo = Infinity, hi = -Infinity;
  for (const b of vis) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const sg = CH.sig;
  if (sg) for (const v of [sg.entry, sg.sl, sg.tp1, sg.tp2, sg.tp3]) {
    if (typeof v === 'number' && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const span0 = (hi - lo) || (hi * 0.001) || 1;
  lo -= span0 * 0.06; hi += span0 * 0.06;
  if (CH.yZoom !== 1 || CH.yCenter != null) {
    const c = CH.yCenter != null ? CH.yCenter : (lo + hi) / 2;
    const half = ((hi - lo) / 2) / CH.yZoom;
    lo = c - half; hi = c + half;
  }

  // A little room on the right, like TradingView, so the newest candle is not
  // jammed against the price axis.
  const slot = plotW / (vis.length + 2);
  const x = (i) => padL + (i + 0.5) * slot;
  const y = (p) => padT + (hi - p) / (hi - lo) * plotH;

  g.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  g.textBaseline = 'middle';

  // ── price grid on round numbers
  const step = chNiceStep(hi - lo, 7);
  const first = Math.ceil(lo / step) * step;
  for (let p = first; p <= hi; p += step) {
    const py = Math.round(y(p)) + 0.5;
    g.strokeStyle = CH_COL.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + plotW, py); g.stroke();
    g.fillStyle = CH_COL.axis; g.textAlign = 'left';
    g.fillText(chFmt(p, CH.pair), padL + plotW + 8, py);
  }

  // ── time axis, with the vertical gridlines TradingView draws
  const everyN = Math.max(1, Math.floor(vis.length / 7));
  g.textAlign = 'center';
  for (let i = 0; i < vis.length; i += everyN) {
    const px = Math.round(x(i)) + 0.5;
    g.strokeStyle = CH_COL.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, padT); g.lineTo(px, padT + plotH + volH); g.stroke();
    const d = new Date(vis[i].t);
    const daily = CH.tf === '1d';
    const lbl = daily
      ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      : `${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    g.fillStyle = CH_COL.axis;
    g.fillText(lbl, x(i), H - padB / 2);
  }

  // ── volume strip
  if (hasVol) {
    let vmax = 0;
    for (const b of vis) if (b.v > vmax) vmax = b.v;
    const vTop = padT + plotH, vBot = vTop + volH - 4;
    for (let i = 0; i < vis.length; i++) {
      const b = vis[i];
      if (!(b.v > 0)) continue;
      const h2 = Math.max(1, ((b.v / vmax) * (volH - 6)));
      g.fillStyle = (b.c >= b.o ? CH_COL.up : CH_COL.down) + '55';
      g.fillRect(x(i) - slot * 0.33, vBot - h2, Math.max(1, slot * 0.66), h2);
    }
  }

  // ── moving averages, drawn under the candles
  for (const [period, colour] of [[20, '#6b8cff88'], [50, '#ffb63d88']]) {
    if (CH.bars.length < period + 2) continue;
    const ma = chSMA(CH.bars, period);
    g.strokeStyle = colour; g.lineWidth = 1.4;
    g.beginPath();
    let started = false;
    for (let i = 0; i < vis.length; i++) {
      const v = ma[from + i];
      if (v == null) continue;
      const px = x(i), py = y(v);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    g.stroke();
  }

  // ── candles
  const cw = Math.max(1, slot * 0.66);
  for (let i = 0; i < vis.length; i++) {
    const b = vis[i], up = b.c >= b.o, cx = x(i);
    g.strokeStyle = up ? CH_COL.up : CH_COL.down;
    g.lineWidth = Math.max(1, Math.min(1.5, slot * 0.1));
    g.beginPath(); g.moveTo(Math.round(cx) + 0.5, y(b.h)); g.lineTo(Math.round(cx) + 0.5, y(b.l)); g.stroke();
    const yo = y(b.o), yc = y(b.c);
    g.fillStyle = up ? CH_COL.up : CH_COL.down;
    g.fillRect(cx - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
  }

  // ── the signal's levels
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
    g.fillStyle = '#070a12'; g.textAlign = 'left';
    g.fillText(txt, padL + 7, py);
    g.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  };
  if (sg) {
    const shade = (a, b2, colour) => {
      if (![a, b2].every(v => typeof v === 'number' && isFinite(v))) return;
      g.fillStyle = colour;
      g.fillRect(padL, Math.min(y(a), y(b2)), plotW, Math.abs(y(b2) - y(a)));
    };
    shade(sg.entry, sg.sl, '#ff5f6d12');
    shade(sg.entry, sg.tp3, '#2fd98a10');
    line(sg.sl, CH_COL.sl, 'SL', false);
    line(sg.entry, CH_COL.entry, 'ENTRY', false);
    line(sg.tp1, CH_COL.tp, 'TP1', true);
    line(sg.tp2, CH_COL.tp, 'TP2', true);
    line(sg.tp3, CH_COL.tp, 'TP3', true);
  }

  // ── last traded price, tagged on the axis
  const last = vis[vis.length - 1];
  if (last) {
    const py = Math.round(y(last.c)) + 0.5;
    g.save(); g.strokeStyle = CH_COL.now; g.lineWidth = 1; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + plotW, py); g.stroke(); g.restore();
    g.fillStyle = CH_COL.now;
    g.fillRect(padL + plotW + 2, py - 8, padR - 4, 16);
    g.fillStyle = '#070a12'; g.font = '600 9.5px ui-monospace, monospace'; g.textAlign = 'left';
    g.fillText(chFmt(last.c, CH.pair), padL + plotW + 6, py);
    g.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  }

  // ── OHLC legend, top-left, the way TradingView reads
  const shown = CH.hover ? vis[Math.max(0, Math.min(vis.length - 1,
                  Math.round((CH.hover.x - padL) / slot - 0.5)))] : last;
  if (shown) {
    const up = shown.c >= shown.o;
    const parts = [
      ['O', chFmt(shown.o, CH.pair)], ['H', chFmt(shown.h, CH.pair)],
      ['L', chFmt(shown.l, CH.pair)], ['C', chFmt(shown.c, CH.pair)],
    ];
    g.font = '600 10px ui-monospace, SF Mono, Menlo, monospace';
    g.textAlign = 'left'; g.textBaseline = 'middle';
    let lx = padL + 4;
    for (const [k, v] of parts) {
      g.fillStyle = CH_COL.axis; g.fillText(k, lx, 12); lx += g.measureText(k).width + 3;
      g.fillStyle = up ? CH_COL.up : CH_COL.down; g.fillText(v, lx, 12); lx += g.measureText(v).width + 9;
    }
    const chg = shown.o ? ((shown.c - shown.o) / shown.o) * 100 : 0;
    g.fillStyle = up ? CH_COL.up : CH_COL.down;
    g.fillText(`${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, lx, 12);
  }

  // ── crosshair, with the price and time LABELLED on the axes
  if (CH.hover) {
    const i = Math.max(0, Math.min(vis.length - 1, Math.round((CH.hover.x - padL) / slot - 0.5)));
    const b = vis[i];
    const hy = Math.max(padT, Math.min(padT + plotH, CH.hover.y));
    g.save(); g.strokeStyle = '#8fa8ff55'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(Math.round(x(i)) + 0.5, padT); g.lineTo(Math.round(x(i)) + 0.5, padT + plotH + volH); g.stroke();
    g.beginPath(); g.moveTo(padL, Math.round(hy) + 0.5); g.lineTo(padL + plotW, Math.round(hy) + 0.5); g.stroke();
    g.restore();

    // price label on the right axis
    const pAt = hi - ((hy - padT) / plotH) * (hi - lo);
    g.fillStyle = '#2b3a5e';
    g.fillRect(padL + plotW + 2, hy - 8, padR - 4, 16);
    g.fillStyle = CH_COL.bright; g.font = '600 9.5px ui-monospace, monospace'; g.textAlign = 'left';
    g.fillText(chFmt(pAt, CH.pair), padL + plotW + 6, hy);

    // time label on the bottom axis
    if (b) {
      const d = new Date(b.t);
      const lbl = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      g.font = '600 9.5px ui-monospace, monospace';
      const tw = g.measureText(lbl).width + 12;
      g.fillStyle = '#2b3a5e';
      g.fillRect(Math.min(padL + plotW - tw, Math.max(padL, x(i) - tw / 2)), H - padB + 1, tw, 16);
      g.fillStyle = CH_COL.bright; g.textAlign = 'center';
      g.fillText(lbl, Math.min(padL + plotW - tw / 2, Math.max(padL + tw / 2, x(i))), H - padB + 9);
    }
    g.font = '10px ui-monospace, SF Mono, Menlo, monospace';
  }
}

/* ── drawing ────────────────────────────────────────────────────────────── */
/* ───────────────── full screen ─────────────────
   Works for BOTH views: our canvas and the TradingView embed are inside the
   same panel, so the panel is what goes full screen and whichever view is
   showing fills it.

   The instrument name stays pinned at the top, because a chart filling a phone
   screen with no label on it is a chart you can misread — and on a page that
   can show nineteen instruments, which one you are looking at is not a detail.
   ----------------------------------------------------------------------- */
function chIsFull() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function chToggleFull() {
  const panel = document.querySelector('.ch-panel');
  if (!panel) return;
  try {
    if (chIsFull()) {
      await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
    } else if (panel.requestFullscreen) {
      await panel.requestFullscreen({ navigationUI: 'hide' });
    } else if (panel.webkitRequestFullscreen) {
      panel.webkitRequestFullscreen();
    } else {
      // iOS Safari refuses the Fullscreen API on a div. Fall back to filling
      // the viewport ourselves, which gets the same result without the API.
      panel.classList.toggle('ch-faux-full');
      chAfterFullChange();
      return;
    }
  } catch (_) {
    panel.classList.toggle('ch-faux-full');
  }
  chAfterFullChange();
}

function chAfterFullChange() {
  const panel = document.querySelector('.ch-panel');
  const btn = document.getElementById('chart-full');
  const on = chIsFull() || (panel && panel.classList.contains('ch-faux-full'));
  if (panel) panel.classList.toggle('is-full', !!on);
  if (btn) btn.innerHTML = on ? '&#10005; Exit full screen' : '&#9974; Full screen';
  // The canvas must be re-measured: its CSS box just changed size, and the
  // backing store is only resized when the dimensions differ.
  requestAnimationFrame(() => { chRequestDraw(); });
}

for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, chAfterFullChange);
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

  // ONE pointer state machine, not two listeners racing.
  //
  // The previous version had a pan handler and a pinch handler as separate
  // listeners, both mutating the same variables. Whether a pinch registered
  // depended on the order the two fired in, so the same gesture worked
  // sometimes and did nothing other times — which on a phone looked like the
  // chart ignoring you and snapping back. Everything below runs in one place
  // and the mode is decided explicitly.
  const live = new Map();              // pointerId -> {x, y}
  let mode = null;                     // null | 'pan' | 'axis' | 'pinch'
  let anchor = null;
  let pointersThisGesture = 0;         // how many fingers took part in this gesture

  const dist = () => {
    const [a, b] = [...live.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  cv.addEventListener('pointerdown', (e) => {
    if (!CH.bars.length) return;
    if (live.size === 0) pointersThisGesture = 0;       // a fresh gesture
    live.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pointersThisGesture = Math.max(pointersThisGesture, live.size);
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}

    if (live.size === 2) {
      // Two fingers always means pinch, whatever was happening before.
      mode = 'pinch';
      anchor = { dist: dist() || 1, view: { ...CH.view } };
      return;
    }
    if (live.size === 1) {
      const r = cv.getBoundingClientRect();
      const onAxis = (e.clientX - r.left) > cv.clientWidth - PAD_R;
      mode = onAxis ? 'axis' : 'pan';
      anchor = { x: e.clientX, y: e.clientY, view: { ...CH.view },
                 yZoom: CH.yZoom, yCenter: CH.yCenter, moved: false };
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (live.has(e.pointerId)) live.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Crosshair follows a hovering pointer when nothing is being dragged.
    if (!mode) {
      const r = cv.getBoundingClientRect();
      CH.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      chRequestDraw();
      return;
    }

    if (mode === 'pinch') {
      if (live.size < 2) return;
      e.preventDefault();
      const factor = dist() / anchor.dist;
      const w = anchor.view.to - anchor.view.from;
      const nw = w / Math.max(0.05, factor);
      const mid = (anchor.view.from + anchor.view.to) / 2;
      CH.view = chClampView(mid - nw / 2, mid + nw / 2);
      chSavePrefSoon();
      chRequestDraw();
      return;
    }

    const dx = e.clientX - anchor.x, dy = e.clientY - anchor.y;
    if (!anchor.moved && Math.abs(dx) + Math.abs(dy) < 4) return;   // still a tap
    anchor.moved = true;
    e.preventDefault();

    if (mode === 'axis') {
      chSetYZoom(anchor.yZoom * (1 + dy / 220), null, null, anchor.yCenter);
    } else {
      const w = anchor.view.to - anchor.view.from;
      const barsMoved = (dx / plotW()) * w;
      CH.view = chClampView(anchor.view.from - barsMoved, anchor.view.to - barsMoved);
      chSavePrefSoon();
      chRequestDraw();
    }
  }, { passive: false });

  let lastCleanTap = 0;
  const release = (e) => {
    live.delete(e.pointerId);
    try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
    if (live.size === 0) {
      if (mode) chSavePref();           // commit the final position immediately
      // Decide the tap here, where the whole gesture is still known: one finger
      // only, and nothing moved. Lifting two fingers off a pinch is NOT a tap,
      // which is what used to throw the zoom away.
      const cleanTap = e.pointerType === 'touch'
        && pointersThisGesture === 1
        && !(anchor && anchor.moved);
      mode = null; anchor = null;
      if (cleanTap) {
        const now = Date.now();
        if (now - lastCleanTap < 320) { lastCleanTap = 0; chResetView(); }
        else lastCleanTap = now;
      } else {
        lastCleanTap = 0;               // a real gesture clears the tap clock
      }
      cv.style.cursor = '';
      for (const b of document.querySelectorAll('.ch-z')) b.classList.remove('on');
    } else if (live.size === 1 && mode === 'pinch') {
      // One finger lifted mid-pinch: carry on as a pan from where it is.
      const [only] = [...live.values()];
      mode = 'pan';
      anchor = { x: only.x, y: only.y, view: { ...CH.view },
                 yZoom: CH.yZoom, yCenter: CH.yCenter, moved: true };
    }
  };
  cv.addEventListener('pointerup', release);
  // A cancel during an active gesture is usually the browser taking the pointer
  // away (a scroll starting, or a capture being lost). Keep whatever the user
  // had reached rather than discarding it.
  cv.addEventListener('pointercancel', release);
  cv.addEventListener('pointerleave', (e) => {
    if (!mode) { CH.hover = null; chRequestDraw();
      const rd = document.getElementById('chart-readout'); if (rd) rd.innerHTML = ''; }
  });

  // ── wheel: zoom the time window around the pointer
  cv.addEventListener('wheel', (e) => {
    if (!CH.bars.length) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const overAxis = (e.clientX - r.left) > cv.clientWidth - PAD_R;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    if (overAxis || e.shiftKey) chSetYZoom(CH.yZoom * factor, r, e.clientY - r.top);
    else chZoomAt(factor, Math.max(0, Math.min(1, (e.clientX - r.left - PAD_L) / plotW())));
  }, { passive: false });

  // ── double-click / double-tap: back to auto
  //
  // THIS IS WHAT RESET THE CHART ON EVERY PINCH. Lifting two fingers fires two
  // pointerup events milliseconds apart, which is indistinguishable from a
  // double-tap unless you check. So every pinch zoomed correctly — the trace
  // showed 120 -> 80 -> 60 -> 40 -> 30 bars — and was then thrown away by
  // chResetView() the instant the fingers came off. On a phone that looks
  // exactly like the zoom "not working", which is what you reported.
  //
  // A double-tap now has to be two SINGLE-finger taps that moved nothing.
  cv.addEventListener('dblclick', (e) => { e.preventDefault(); chResetView(); });
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
            ${CH_TFS.map(t => `<button class="ch-z" data-tf="${t.id}">${t.label}</button>`).join('')}
          </div>
          <button class="rs-x" data-chclose="1" aria-label="Close">&times;</button>
        </div>
        <div class="ch-modes">
          <button class="ch-mode on" data-mode="own">Our chart</button>
          <button class="ch-mode" data-mode="tv">TradingView</button>
          <button class="ch-full" id="chart-full" title="Full screen">&#9974; Full screen</button>
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
      const z = e.target.closest('[data-tf]');
      if (z) chSetTf(z.dataset.tf);
      const m = e.target.closest('[data-mode]');
      if (m) chSetView(m.dataset.mode);
      if (e.target.closest('#chart-full')) chToggleFull();
    });
    const cv = el0.querySelector('#chart-canvas');
    chInstallInteraction(cv);
    window.addEventListener('resize', () => chRequestDraw());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chClose(); });
  }
  el0.classList.add('open');
  if (typeof pushOverlayState === 'function') pushOverlayState('chart');

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
  try { CH.tf = localStorage.getItem('fs.chart.tf') || '1h'; } catch (_) { CH.tf = '1h'; }
  if (!CH_TFS.some(t => t.id === CH.tf)) CH.tf = '1h';
  for (const b of document.querySelectorAll('.ch-z')) b.classList.toggle('on', b.dataset.tf === CH.tf);
  const cached = CH_CACHE.get(CH.pair + '|1h');
  if (cached && cached.bars.length) {
    CH.bars = cached.bars;
    chSetBars(wantBars, { remember: false });
    if (pref && pref.yZoom && pref.yZoom !== 1) CH.yZoom = pref.yZoom;
    chRefreshMeta();
  }

  const bars = await chLoadForTf(CH.pair, CH.tf);
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
let _prefTimer = null;
/** Saves after the gesture settles rather than on every frame of it. */
function chSavePrefSoon() {
  clearTimeout(_prefTimer);
  _prefTimer = setTimeout(chSavePref, 250);
}

function chSavePref() {
  try {
    localStorage.setItem(CH_PREF, JSON.stringify({
      bars: CH.view.to - CH.view.from, yZoom: CH.yZoom, yCenter: CH.yCenter,
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


/** Switch timeframe. The chosen one is remembered, like the zoom. */
async function chSetTf(tfId) {
  if (!CH_TFS.some(t => t.id === tfId)) return;
  CH.tf = tfId;
  try { localStorage.setItem('fs.chart.tf', tfId); } catch (_) {}
  for (const b of document.querySelectorAll('.ch-z')) b.classList.toggle('on', b.dataset.tf === tfId);

  const sub = document.getElementById('chart-sub');
  if (sub) sub.textContent = 'loading ' + tfId + '…';

  const bars = await chLoadForTf(CH.pair, tfId);
  if (!bars || !bars.length) {
    if (sub) sub.textContent = `no ${tfId} bars published for ${CH.pair}`;
    return;
  }
  CH.bars = bars;
  // Keep roughly the same span on screen rather than snapping to a default,
  // so switching timeframe does not also throw away where you were looking.
  const pref = chLoadPref();
  const want = pref && pref.bars > 0 ? pref.bars : 120;
  CH.view = chClampView(bars.length - want, bars.length);
  CH.yZoom = 1; CH.yCenter = null;
  chRefreshMeta();
  chRequestDraw();
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
    const tfLabel = (CH_TFS.find(t => t.id === CH.tf) || {}).label || CH.tf;
    sub.textContent = `${tfLabel} · ${CH.bars.length} bars · last ${chFmt(last.c, CH.pair)} · ${ageMin < 90 ? ageMin + 'm ago' : Math.round(ageMin / 60) + 'h ago'}`;
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
  // Only follow the right edge if the view was ALREADY at it. If you have
  // panned back into history, a refresh that snaps you forward every 30 seconds
  // is the chart fighting you.
  const wasAtRightEdge = CH.view.to >= CH.bars.length - 1;
  CH.bars = bars;
  if (wasAtRightEdge) {
    CH.view = { from: Math.max(0, bars.length - windowSize), to: bars.length };
  } else {
    // Hold the same bars in view; new bars simply extend the series to the right.
    CH.view = chClampView(CH.view.from, CH.view.from + windowSize);
  }
  CH.lastFetch = Date.now();
  chRefreshMeta();
  chDraw();
}

function chClose(fromBack) {
  const e = document.getElementById('chart');
  if (!e || !e.classList.contains('open')) return;
  e.classList.remove('open');
  // Leave full screen with the panel, or the browser is left in a full-screen
  // state with nothing in it.
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
  const panel = document.querySelector('.ch-panel');
  if (panel) panel.classList.remove('ch-faux-full', 'is-full');
  if (!fromBack && typeof popOverlayState === 'function') popOverlayState();
  clearInterval(CH.timer);
  CH.timer = null;
}

window.FSCHART = { cached: (p) => (CH_CACHE.get(p + '|1h') || {}).bars || null,
                   open: chOpen, close: chClose, draw: chDraw, prefetch: chPrefetch,
                   tvSymbol: chTvSymbol, tvUrl: chTvUrl, TV_MAP: CH_TV, state: CH };
