// /api/multi-source-check — v315 multi-source intelligence layer.
//
// Cross-validates a signal against independent free data sources:
//   • VIX (^VIX)          — risk-on/off proxy (Yahoo)
//   • Crypto Fear & Greed — alternative.me index (0-100)
//   • CoinGecko BTC price — independent BTC spot (cross-check vs Yahoo)
//   • Twelve Data forex   — secondary forex price (already configured)
//
// Each source votes CONFIRM / VETO / NEUTRAL for the pair+direction.
// Returns a consensus verdict + boost points that the signal gate can use.
//
// Free public endpoints only. No API keys required for VIX / F&G / CoinGecko.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';

async function _fetchJSON(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 ForexSight-MultiSource/1' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

// ── VIX (S&P 500 volatility index / "fear gauge") ─────────────────────
// Rules encoded from decades of cross-asset behaviour:
//   VIX > 25  → risk-off spike → gold BUY confirmed, BTC BUY vetoed
//   VIX < 14  → complacent risk-on → gold BUY discouraged, BTC BUY confirmed
//   Delta > +8% intraday → risk unwind (same as high VIX)
async function fetchVIX() {
  const d = await _fetchJSON(`${YAHOO}/^VIX?range=5d&interval=1d`);
  if (!d?.chart?.result?.[0]) return null;
  const q = d.chart.result[0].indicators?.quote?.[0];
  const closes = (q?.close || []).filter(x => Number.isFinite(x));
  if (closes.length < 2) return null;
  const latest = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const changePct = ((latest - prev) / prev) * 100;
  let regime = 'neutral';
  if (latest > 25) regime = 'risk-off';
  else if (latest > 20) regime = 'cautious';
  else if (latest < 14) regime = 'complacent';
  else if (latest < 17) regime = 'risk-on';
  return { value: Math.round(latest * 100) / 100, changePct: Math.round(changePct * 100) / 100, regime };
}

// ── Crypto Fear & Greed Index (alternative.me, updated daily) ─────────
// 0-24 = Extreme Fear (contrarian BUY), 25-49 = Fear, 50-54 = Neutral,
// 55-74 = Greed, 75-100 = Extreme Greed (contrarian SELL)
async function fetchCryptoFG() {
  const d = await _fetchJSON('https://api.alternative.me/fng/?limit=1');
  const latest = d?.data?.[0];
  if (!latest) return null;
  const v = parseInt(latest.value, 10);
  if (!Number.isFinite(v)) return null;
  let regime = 'neutral';
  if (v <= 24) regime = 'extreme-fear';
  else if (v <= 49) regime = 'fear';
  else if (v <= 54) regime = 'neutral';
  else if (v <= 74) regime = 'greed';
  else regime = 'extreme-greed';
  return { value: v, regime, label: latest.value_classification };
}

// ── CoinGecko independent BTC spot (cross-check vs Yahoo BTC-USD) ─────
async function fetchCoinGeckoBTC() {
  const d = await _fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
  const b = d?.bitcoin;
  if (!b?.usd) return null;
  return { price: b.usd, change24h: b.usd_24h_change || 0 };
}

// ── Yahoo BTC-USD (for cross-check comparison) ────────────────────────
async function fetchYahooBTC() {
  const d = await _fetchJSON(`${YAHOO}/BTC-USD?range=2d&interval=1h`);
  if (!d?.chart?.result?.[0]) return null;
  const q = d.chart.result[0].indicators?.quote?.[0];
  const closes = (q?.close || []).filter(x => Number.isFinite(x));
  if (!closes.length) return null;
  return { price: closes[closes.length - 1] };
}

// v332 — BITCOIN DOMINANCE (BTC's share of total crypto market cap).
// Rising dominance = money flowing from alts to BTC (bullish BTC).
// Falling dominance = alt season / risk-on crypto (BTC lagging).
async function fetchBtcDominance() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global', {
      headers: { 'User-Agent': 'Mozilla/5.0 ForexSight-MultiSource/1' },
      cf: { cacheTtl: 900, cacheEverything: true },  // 15min cache — daily data
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const btcDom = d?.data?.market_cap_percentage?.btc;
    if (typeof btcDom !== 'number') return null;
    return { value: Math.round(btcDom * 10) / 10, regime: btcDom >= 55 ? 'btc-dominant' : btcDom >= 45 ? 'balanced' : 'alt-season' };
  } catch { return null; }
}

// v332 — CRYPTO F&G MOMENTUM. Instead of just the current value, look at
// the 7-day trend. Rising fear = increasingly panic (contrarian buy zone
// getting deeper). Rising greed = topping process.
async function fetchCryptoFGMomentum() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=7', {
      cf: { cacheTtl: 3600, cacheEverything: true },  // 1h cache — daily data
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const data = d?.data || [];
    if (data.length < 3) return null;
    const values = data.map(x => parseInt(x.value, 10)).filter(v => Number.isFinite(v));
    const current = values[0];
    const avg7d = values.reduce((s, v) => s + v, 0) / values.length;
    const change7d = current - values[values.length - 1];
    return {
      current, avg7d: Math.round(avg7d),
      change7d,
      direction: change7d > 3 ? 'fear-easing' : change7d < -3 ? 'fear-deepening' : 'flat',
    };
  } catch { return null; }
}

// v346 — DXY (US Dollar Index) via Yahoo — real-time USD strength gauge.
// Rising DXY = USD strong = bearish for gold/BTC and inverse for USD pairs.
async function fetchDXY() {
  const d = await _fetchJSON(`${YAHOO}/DX-Y.NYB?range=5d&interval=1d`);
  if (!d?.chart?.result?.[0]) return null;
  const q = d.chart.result[0].indicators?.quote?.[0];
  const closes = (q?.close || []).filter(x => Number.isFinite(x));
  if (closes.length < 2) return null;
  const latest = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const changePct = ((latest - prev) / prev) * 100;
  let regime = 'neutral';
  if (changePct > 0.5) regime = 'strong-up';
  else if (changePct > 0.15) regime = 'up';
  else if (changePct < -0.5) regime = 'strong-down';
  else if (changePct < -0.15) regime = 'down';
  return { value: Math.round(latest * 100) / 100, changePct: Math.round(changePct * 100) / 100, regime };
}

// v346 — Gold/Silver ratio — historical economic-fear indicator. Above 80 =
// risk-off (gold outperforming silver = fear); below 60 = risk-on.
async function fetchGoldSilverRatio() {
  try {
    const [gRes, sRes] = await Promise.all([
      _fetchJSON(`${YAHOO}/GC=F?range=5d&interval=1d`),
      _fetchJSON(`${YAHOO}/SI=F?range=5d&interval=1d`),
    ]);
    const gCloses = (gRes?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(x => Number.isFinite(x));
    const sCloses = (sRes?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(x => Number.isFinite(x));
    if (!gCloses.length || !sCloses.length) return null;
    const gold = gCloses[gCloses.length - 1];
    const silver = sCloses[sCloses.length - 1];
    if (!silver) return null;
    const ratio = gold / silver;
    let regime = 'balanced';
    if (ratio > 90) regime = 'extreme-fear';
    else if (ratio > 80) regime = 'risk-off';
    else if (ratio < 60) regime = 'risk-on';
    else if (ratio < 50) regime = 'extreme-greed';
    return { ratio: Math.round(ratio * 10) / 10, regime, gold, silver };
  } catch { return null; }
}

// ── US 10Y treasury yield (^TNX) — real yield proxy for gold ──────────
async function fetchTNX() {
  const d = await _fetchJSON(`${YAHOO}/^TNX?range=5d&interval=1d`);
  if (!d?.chart?.result?.[0]) return null;
  const q = d.chart.result[0].indicators?.quote?.[0];
  const closes = (q?.close || []).filter(x => Number.isFinite(x));
  if (closes.length < 2) return null;
  const latest = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  return { value: Math.round(latest * 100) / 100, changePct: ((latest - prev) / prev) * 100 };
}

// ── Consensus evaluator: apply pair/direction-specific rules ─────────
// Returns { verdict: 'CONFIRM'|'VETO'|'NEUTRAL'|'MIXED', boost: -20..+15, notes: [] }
function evaluate(pair, direction, sources) {
  const isBuy = direction === 'BUY';
  const notes = [];
  let votes = 0;      // + confirms, - vetoes
  let confidence = 0; // 0-100 how strong the consensus is

  const isGold = pair === 'XAU/USD';
  const isBTC = pair === 'BTC/USD';
  const isForex = !isGold && !isBTC;

  // ── VIX-based rules ──
  if (sources.vix) {
    const v = sources.vix;
    if (isGold) {
      // Gold BUY loves risk-off, SELL loves complacent
      if (isBuy) {
        if (v.regime === 'risk-off') { votes += 2; notes.push(`VIX ${v.value} (risk-off) confirms gold BUY`); }
        else if (v.regime === 'cautious') { votes += 1; notes.push(`VIX ${v.value} (cautious) supports gold BUY`); }
        else if (v.regime === 'complacent') { votes -= 1; notes.push(`VIX ${v.value} (complacent) against gold BUY`); }
      } else {
        if (v.regime === 'complacent' || v.regime === 'risk-on') { votes += 1; notes.push(`VIX ${v.value} (complacent) supports gold SELL`); }
        else if (v.regime === 'risk-off') { votes -= 2; notes.push(`VIX ${v.value} (risk-off) vetoes gold SELL — flight-to-safety`); }
      }
    }
    if (isBTC) {
      // BTC has become a risk-asset; BUY loves risk-on, SELL loves risk-off spikes
      if (isBuy) {
        if (v.regime === 'risk-on' || v.regime === 'complacent') { votes += 1; notes.push(`VIX ${v.value} risk-on tape supports BTC BUY`); }
        else if (v.regime === 'risk-off') { votes -= 2; notes.push(`VIX ${v.value} (risk-off) vetoes BTC BUY`); }
      } else {
        if (v.regime === 'risk-off') { votes += 2; notes.push(`VIX ${v.value} (risk-off) confirms BTC SELL`); }
        else if (v.regime === 'complacent') { votes -= 1; notes.push(`VIX ${v.value} (complacent) against BTC SELL`); }
      }
    }
    if (isForex) {
      // USD-safe-haven trades: USD strengthens on VIX spikes → JPY/CHF pairs work in reverse
      const usdInBase = pair.startsWith('USD');
      const usdInQuote = pair.endsWith('USD');
      if (v.regime === 'risk-off') {
        if (isBuy && usdInBase) { votes += 1; notes.push(`VIX ${v.value} risk-off → USD strength → BUY ${pair}`); }
        if (!isBuy && usdInQuote) { votes += 1; notes.push(`VIX ${v.value} risk-off → USD strength → SELL ${pair}`); }
      }
    }
  }

  // ── Crypto Fear & Greed rules (BTC only) ──
  if (sources.cryptoFG && isBTC) {
    const c = sources.cryptoFG;
    if (isBuy) {
      // Contrarian: BUY when others are extremely fearful
      if (c.regime === 'extreme-fear') { votes += 2; notes.push(`F&G ${c.value} (extreme fear) — contrarian BUY setup`); }
      else if (c.regime === 'fear') { votes += 1; notes.push(`F&G ${c.value} (fear) supports contrarian BUY`); }
      else if (c.regime === 'extreme-greed') { votes -= 2; notes.push(`F&G ${c.value} (extreme greed) — top-heavy market, vetoes BUY`); }
      else if (c.regime === 'greed') { votes -= 1; notes.push(`F&G ${c.value} (greed) against BUY`); }
    } else {
      if (c.regime === 'extreme-greed') { votes += 2; notes.push(`F&G ${c.value} (extreme greed) confirms SELL`); }
      else if (c.regime === 'greed') { votes += 1; notes.push(`F&G ${c.value} (greed) supports SELL`); }
      else if (c.regime === 'extreme-fear') { votes -= 2; notes.push(`F&G ${c.value} (extreme fear) — panic bottom, vetoes SELL`); }
    }
  }

  // ── v346: DXY rules (all pairs) ──
  // Strong DXY = strong USD = bearish for gold/BTC/EUR/GBP/AUD, bullish
  // for USD/JPY, USD/CAD, USD/CHF (USD-base pairs).
  if (sources.dxy && sources.dxy.regime) {
    const d = sources.dxy;
    const strongUp = d.regime === 'strong-up' || d.regime === 'up';
    const strongDown = d.regime === 'strong-down' || d.regime === 'down';
    if (isGold) {
      if (strongUp && isBuy)   { votes -= 2; notes.push(`DXY ${d.value} (+${d.changePct}%) headwind for gold BUY`); }
      if (strongUp && !isBuy)  { votes += 1; notes.push(`DXY ${d.value} (+${d.changePct}%) supports gold SELL`); }
      if (strongDown && isBuy) { votes += 2; notes.push(`DXY ${d.value} (${d.changePct}%) tailwind for gold BUY`); }
    }
    if (isBTC) {
      if (strongUp && isBuy)   { votes -= 1; notes.push(`DXY ${d.value} (+${d.changePct}%) headwind for BTC BUY`); }
      if (strongDown && isBuy) { votes += 1; notes.push(`DXY ${d.value} (${d.changePct}%) tailwind for BTC BUY`); }
    }
    if (isForex) {
      const usdInBase = pair.startsWith('USD');
      const usdInQuote = pair.endsWith('USD');
      if (strongUp) {
        if (isBuy && usdInBase)   { votes += 1; notes.push(`DXY ${d.value} up → USD strength → BUY ${pair}`); }
        if (!isBuy && usdInQuote) { votes += 1; notes.push(`DXY ${d.value} up → USD strength → SELL ${pair}`); }
        if (isBuy && usdInQuote)  { votes -= 1; notes.push(`DXY ${d.value} up → USD strength → BUY ${pair} fights USD`); }
      }
      if (strongDown) {
        if (isBuy && usdInQuote)  { votes += 1; notes.push(`DXY ${d.value} down → USD weakness → BUY ${pair}`); }
        if (!isBuy && usdInBase)  { votes += 1; notes.push(`DXY ${d.value} down → USD weakness → SELL ${pair}`); }
      }
    }
  }

  // ── v346: Gold/Silver ratio rules (gold + BTC) ──
  // Extreme fear (>90) = flight to safety = gold BUY good, BTC BUY less good
  // Extreme greed (<50) = risk-on = BTC BUY good, gold BUY less good
  if (sources.goldSilverRatio) {
    const g = sources.goldSilverRatio;
    if (isGold) {
      if (g.regime === 'extreme-fear' && isBuy)  { votes += 2; notes.push(`Gold/Silver ${g.ratio} extreme fear — safe-haven flow supports gold BUY`); }
      if (g.regime === 'risk-off' && isBuy)      { votes += 1; notes.push(`Gold/Silver ${g.ratio} risk-off supports gold BUY`); }
      if (g.regime === 'extreme-greed' && isBuy) { votes -= 1; notes.push(`Gold/Silver ${g.ratio} extreme greed — risk-on hurts gold`); }
    }
    if (isBTC) {
      if (g.regime === 'extreme-fear' && isBuy)  { votes -= 1; notes.push(`Gold/Silver ${g.ratio} extreme fear — BTC BUY faces safe-haven headwind`); }
      if (g.regime === 'risk-on' && isBuy)       { votes += 1; notes.push(`Gold/Silver ${g.ratio} risk-on tape supports BTC BUY`); }
    }
  }

  // ── v332: BTC Dominance rules (BTC only) ──
  // Rising BTC dominance = money flowing INTO BTC from alts (bullish BTC).
  // Falling dominance = alt season / risk-on but not for BTC specifically.
  if (isBTC && sources.btcDominance) {
    const d = sources.btcDominance;
    if (d.regime === 'btc-dominant') {
      if (isBuy) { votes += 1; notes.push(`BTC dominance ${d.value}% (btc-dominant) supports BUY`); }
      // No penalty for SELL in btc-dominant regime — flow can reverse
    } else if (d.regime === 'alt-season') {
      // Alt season = BTC underperforming — BUY less likely to work
      if (isBuy) { votes -= 1; notes.push(`BTC dominance ${d.value}% (alt-season) headwind for BUY`); }
    }
  }

  // ── v332: Crypto F&G momentum (BTC only) ──
  // Fear deepening = smart-money accumulation phase (BUY contrarian setup)
  // Fear easing = topping process for the panic rally (SELL setup)
  if (isBTC && sources.cryptoFGMomentum) {
    const m = sources.cryptoFGMomentum;
    if (m.direction === 'fear-deepening') {
      if (isBuy) { votes += 1; notes.push(`F&G momentum: fear deepening (${m.change7d} pts over 7d) — contrarian BUY setup`); }
    } else if (m.direction === 'fear-easing') {
      if (!isBuy) { votes += 1; notes.push(`F&G momentum: fear easing (+${m.change7d} pts over 7d) — panic top forming`); }
    }
  }

  // ── CoinGecko cross-check (BTC only): price agreement between sources ──
  // Yahoo's BTC-USD spot can lag CoinGecko's real-time by 5-15 min, so
  // small spreads are normal source-lag, not disagreement. Only flag as
  // "bad tick" when spread exceeds 3% (a real fat-finger candle).
  if (isBTC && sources.coingeckoBTC && sources.yahooBTC) {
    const g = sources.coingeckoBTC.price;
    const y = sources.yahooBTC.price;
    const spreadPct = Math.abs(g - y) / y * 100;
    if (spreadPct < 1.0) {
      votes += 1;
      notes.push(`CoinGecko $${g.toFixed(0)} agrees with Yahoo $${y.toFixed(0)} (${spreadPct.toFixed(2)}% spread)`);
    } else if (spreadPct > 3.0) {
      votes -= 2;
      notes.push(`⚠ CoinGecko $${g.toFixed(0)} disagrees with Yahoo $${y.toFixed(0)} (${spreadPct.toFixed(2)}% spread) — bad tick`);
    }
    // 1-3% spread → no vote, just note the source-lag
    else {
      notes.push(`Source lag: CoinGecko $${g.toFixed(0)} vs Yahoo $${y.toFixed(0)} (${spreadPct.toFixed(2)}% spread)`);
    }
  }

  // ── US10Y yield rules (gold only): rising yields hurt gold BUY ──
  if (isGold && sources.tnx) {
    const t = sources.tnx;
    if (isBuy && t.changePct > 1.0) {
      votes -= 1;
      notes.push(`10Y yield +${t.changePct.toFixed(2)}% headwind for gold BUY`);
    }
    if (isBuy && t.changePct < -1.0) {
      votes += 1;
      notes.push(`10Y yield ${t.changePct.toFixed(2)}% tailwind for gold BUY`);
    }
    if (!isBuy && t.changePct > 1.0) {
      votes += 1;
      notes.push(`10Y yield +${t.changePct.toFixed(2)}% supports gold SELL`);
    }
  }

  // ── Consensus verdict ──
  let verdict = 'NEUTRAL';
  let boost = 0;
  if (votes >= 4)      { verdict = 'CONFIRM'; boost = 12; }
  else if (votes >= 3) { verdict = 'CONFIRM'; boost = 8; }
  else if (votes >= 2) { verdict = 'CONFIRM'; boost = 5; }
  else if (votes >= 1) { verdict = 'CONFIRM'; boost = 2; }
  else if (votes <= -4){ verdict = 'VETO';    boost = -20; }
  else if (votes <= -3){ verdict = 'VETO';    boost = -15; }
  else if (votes <= -2){ verdict = 'VETO';    boost = -10; }
  else if (votes <= -1){ verdict = 'MIXED';   boost = -3; }
  confidence = Math.min(100, Math.abs(votes) * 20);

  return { verdict, boost, votes, confidence, notes };
}

async function gatherAll(pair) {
  const isBTC = pair === 'BTC/USD';
  const isGold = pair === 'XAU/USD';
  const isForex = !isBTC && !isGold;
  // v346 — ALL pairs now get DXY (real-time USD strength). Gold + BTC also
  // get gold/silver ratio for risk-off/risk-on read.
  const tasks = [ fetchVIX(), fetchDXY() ];
  if (isBTC) tasks.push(fetchCryptoFG(), fetchCoinGeckoBTC(), fetchYahooBTC(), fetchBtcDominance(), fetchCryptoFGMomentum(), fetchGoldSilverRatio());
  if (isGold) tasks.push(fetchTNX(), fetchGoldSilverRatio());
  const settled = await Promise.allSettled(tasks);
  const [vixR, dxyR, ...rest] = settled;
  const sources = {
    vix: vixR?.status === 'fulfilled' ? vixR.value : null,
    dxy: dxyR?.status === 'fulfilled' ? dxyR.value : null,
  };
  if (isBTC) {
    sources.cryptoFG = rest[0]?.status === 'fulfilled' ? rest[0].value : null;
    sources.coingeckoBTC = rest[1]?.status === 'fulfilled' ? rest[1].value : null;
    sources.yahooBTC = rest[2]?.status === 'fulfilled' ? rest[2].value : null;
    sources.btcDominance = rest[3]?.status === 'fulfilled' ? rest[3].value : null;
    sources.cryptoFGMomentum = rest[4]?.status === 'fulfilled' ? rest[4].value : null;
    sources.goldSilverRatio = rest[5]?.status === 'fulfilled' ? rest[5].value : null;
  }
  if (isGold) {
    sources.tnx = rest[0]?.status === 'fulfilled' ? rest[0].value : null;
    sources.goldSilverRatio = rest[1]?.status === 'fulfilled' ? rest[1].value : null;
  }
  return sources;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pair = (url.searchParams.get('pair') || 'XAU/USD').toUpperCase();
  const direction = (url.searchParams.get('direction') || 'BUY').toUpperCase();
  // v317b — direction=both returns eval for both BUY and SELL from a single
  // source snapshot. Halves network traffic when the caller (check-signals)
  // needs both directions per pair.
  const wantBoth = direction === 'BOTH';

  try {
    const sources = await gatherAll(pair);
    const activeSources = Object.entries(sources)
      .filter(([, v]) => v !== null)
      .map(([k]) => k);

    if (wantBoth) {
      const buyResult = evaluate(pair, 'BUY', sources);
      const sellResult = evaluate(pair, 'SELL', sources);
      return new Response(JSON.stringify({
        ok: true,
        version: 'v317-multi-source',
        pair,
        activeSources,
        sources,
        BUY: { ...buyResult, activeSources, ok: true },
        SELL: { ...sellResult, activeSources, ok: true },
        timestamp: new Date().toISOString(),
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=180',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const result = evaluate(pair, direction, sources);
    return new Response(JSON.stringify({
      ok: true,
      version: 'v317-multi-source',
      pair,
      direction,
      activeSources,
      sources,
      ...result,
      timestamp: new Date().toISOString(),
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=180',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      pair,
      direction,
      verdict: 'NEUTRAL',
      boost: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}

// Exported for internal use (check-signals.js imports these):
export { gatherAll, evaluate };
