// /api/pro-consensus — aggregates public analyst commentary from multiple
// free RSS feeds (DailyFX, FXStreet, Investing.com, ForexLive, Reuters)
// and returns pair+direction calls confirmed by 2+ independent sources.
//
// Honest caveats:
//   • RSS feeds update on a delay (minutes to hours), so this is NOT
//     real-time "about to take" — it's aggregated analyst sentiment.
//   • Free sources don't have hard entry/SL/TP — we infer direction
//     from headlines and snippets using simple sentiment parsing.
//   • A pair is only shown if 2+ sources independently agree.

const SOURCES = [
  { name: 'DailyFX',     url: 'https://www.dailyfx.com/feeds/all' },
  { name: 'FXStreet',    url: 'https://www.fxstreet.com/rss/news' },
  { name: 'Investing',   url: 'https://www.investing.com/rss/forex.rss' },
  { name: 'ForexLive',   url: 'https://www.forexlive.com/feed' },
  { name: 'Reuters-FX',  url: 'https://www.reuters.com/markets/currencies/rss' },
];

// Currency pairs we care about — supports any combination user might trade
const PAIRS_TO_DETECT = [
  'XAU/USD', 'GOLD',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF',
  'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/GBP', 'EUR/AUD',
  'BTC/USD', 'ETH/USD',
];

// Normalize text variants: "EURUSD", "EUR-USD", "EUR/USD" → "EUR/USD"
function normalizePair(text) {
  const t = text.toUpperCase();
  const flat = t.replace(/[^A-Z]/g, '');
  for (const p of PAIRS_TO_DETECT) {
    const pFlat = p.replace(/[^A-Z]/g, '');
    if (flat.includes(pFlat)) return p;
    // Gold special: "GOLD" or "XAU" → XAU/USD
    if (p === 'XAU/USD' && (flat.includes('GOLD') || flat.includes('XAU'))) return 'XAU/USD';
  }
  return null;
}

// Sentiment dictionary — words that imply bullish vs bearish direction
const BULLISH = [
  'bullish', 'buy', 'long', 'rally', 'rise', 'rises', 'higher', 'climb',
  'climbing', 'surge', 'soar', 'breakout', 'upside', 'uptrend', 'support holds',
  'recovery', 'rebound', 'gains', 'advance', 'jump', 'rally', 'bid',
];
const BEARISH = [
  'bearish', 'sell', 'short', 'fall', 'falls', 'drop', 'lower', 'decline',
  'plunge', 'tumble', 'crash', 'breakdown', 'downside', 'downtrend',
  'resistance holds', 'reject', 'rejected', 'losses', 'retreat', 'pressure',
  'offer', 'weakness',
];

function detectDirection(text) {
  const t = text.toLowerCase();
  let bull = 0, bear = 0;
  for (const w of BULLISH) {
    if (t.includes(w)) bull++;
  }
  for (const w of BEARISH) {
    if (t.includes(w)) bear++;
  }
  if (bull > bear && bull >= 1) return 'BUY';
  if (bear > bull && bear >= 1) return 'SELL';
  return null;
}

// Crude RSS parser — extracts <item> blocks with title + description + pubDate.
// Cloudflare Workers don't have DOMParser; regex is sufficient for RSS 2.0.
function parseRSS(xml) {
  const items = [];
  const re = /<item[\s\S]*?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 30) {
    const body = m[1];
    const grab = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const mm = r.exec(body);
      if (!mm) return '';
      // strip CDATA
      return mm[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
    };
    const title = grab('title');
    const desc = grab('description') || grab('summary') || grab('content:encoded');
    const pub = grab('pubDate') || grab('published') || grab('updated');
    if (title) items.push({ title, desc, pub });
  }
  return items;
}

async function fetchAndParse(source, signal) {
  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'ForexSight-Consensus/1.0',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal,
    });
    if (!res.ok) return { source: source.name, ok: false, status: res.status, items: [] };
    const xml = await res.text();
    const items = parseRSS(xml);
    return { source: source.name, ok: true, items };
  } catch (e) {
    return { source: source.name, ok: false, error: e.message, items: [] };
  }
}

export async function onRequest(context) {
  const { env } = context;
  // 30-second cache via KV to avoid hammering RSS feeds
  if (env.TRADES_KV) {
    try {
      const cached = await env.TRADES_KV.get('pro-consensus-cache');
      if (cached) {
        const data = JSON.parse(cached);
        if (Date.now() - data.ts < 30 * 60 * 1000) { // 30 min cache
          return new Response(JSON.stringify({ ...data, fromCache: true }), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          });
        }
      }
    } catch {}
  }

  // Parallel fetch with 8-second total timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const results = await Promise.allSettled(
    SOURCES.map(s => fetchAndParse(s, ctrl.signal))
  );
  clearTimeout(timer);

  // Aggregate: for each pair+direction, count how many distinct sources mention it
  // within the last 24h.
  const agg = {}; // key: pair_direction → { sources: Set, samples: [{source, title, when}] }
  const since = Date.now() - 24 * 3600 * 1000;
  const sourcesUp = [];

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    sourcesUp.push(r.value.source);
    for (const item of r.value.items) {
      const ts = Date.parse(item.pub || '');
      if (Number.isFinite(ts) && ts < since) continue; // skip stale
      const combined = `${item.title} ${item.desc}`;
      const pair = normalizePair(combined);
      if (!pair) continue;
      const dir = detectDirection(combined);
      if (!dir) continue;
      const k = `${pair}_${dir}`;
      if (!agg[k]) agg[k] = { pair, direction: dir, sources: new Set(), samples: [] };
      agg[k].sources.add(r.value.source);
      if (agg[k].samples.length < 5) {
        agg[k].samples.push({ source: r.value.source, title: item.title.slice(0, 140), pub: item.pub });
      }
    }
  }

  // Only return pair+direction calls with 2+ source confirmations
  const consensus = Object.values(agg)
    .filter(x => x.sources.size >= 2)
    .map(x => ({
      pair: x.pair,
      direction: x.direction,
      sourceCount: x.sources.size,
      sources: Array.from(x.sources),
      samples: x.samples,
    }))
    .sort((a, b) => b.sourceCount - a.sourceCount);

  const payload = {
    ts: Date.now(),
    isoTime: new Date().toISOString(),
    sourcesQueried: SOURCES.length,
    sourcesResponding: sourcesUp.length,
    sourcesUp,
    consensusCount: consensus.length,
    consensus,
    note: 'Free public RSS aggregation. NOT real-time pro signals — analyst commentary within last 24h. Direction inferred from sentiment in titles + descriptions. 2+ source confirmation required.',
  };

  // v351 — Migrated to Cache API (unlimited writes)
  try {
    const { cachePut } = await import('./_cache-store.js');
    await cachePut('pro-consensus-cache', payload, 30 * 60);
  } catch {
    if (env.TRADES_KV) {
      try { await env.TRADES_KV.put('pro-consensus-cache', JSON.stringify(payload), { expirationTtl: 30 * 60 }); } catch {}
    }
  }

  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
