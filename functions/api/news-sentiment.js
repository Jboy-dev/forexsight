// /api/news-sentiment — Per-currency sentiment bias aggregated from the
// institutional RSS feeds that /api/news already pulls. Every signal the
// brain emits now gets a "does real financial news agree with this
// direction?" check based on real-world news flow.
//
// Output shape:
//   {
//     ts: 1737000000000,
//     ageSeconds: 42,
//     perCurrency: {
//       USD: { bias: -3, bullish: 4, bearish: 7, neutral: 12, articles: 23, samples: [...] },
//       EUR: { bias: +2, ... },
//       ...
//     },
//     summary: "USD-negative day (Fed dovish tone, weak jobs). EUR neutral. Gold-positive (risk-off)."
//   }
//
// Bias is bullish_count - bearish_count over the last N hours. Positive =
// currency is likely to strengthen. Negative = likely to weaken. Absolute
// value ≥ 3 is a strong signal; ≥ 5 is very strong.
//
// Caches to KV for 10 minutes so we don't hammer 15 RSS feeds on every
// scan tick.

// v293 — 24h window catches most institutional news moves. Central bank
// press releases (Fed, ECB, BoE) often have next-day market impact, so a
// short lookback loses signal. 24h + 10-min cache = fresh enough.
const LOOKBACK_HOURS = 24;
const CACHE_TTL_SECONDS = 600; // 10 min

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'XAU', 'BTC'];

// Gold-specific keywords — gold trades inversely to USD strength and rallies
// on risk-off flows, geopolitical tension, and inflation.
const GOLD_BULL = ['risk-off', 'safe haven', 'flight to safety', 'geopolitical', 'inflation up', 'stagflation', 'gold rally', 'gold surge', 'central bank buying gold', 'dollar falls', 'weak dollar'];
const GOLD_BEAR = ['risk-on', 'yields rise', 'strong dollar', 'gold falls', 'gold slump', 'gold drops', 'bond yields up', 'fed hikes', 'hawkish'];

function _bucketArticle(article, buckets) {
  const text = ((article.title || '') + ' ' + (article.summary || '')).toLowerCase();
  const currencies = article.currencies || [];
  const sentiment = article.sentiment || 'neutral';
  // Regular currency bucketing
  for (const ccy of currencies) {
    if (!buckets[ccy]) continue;
    if (sentiment === 'bullish') buckets[ccy].bullish++;
    else if (sentiment === 'bearish') buckets[ccy].bearish++;
    else buckets[ccy].neutral++;
    buckets[ccy].articles.push({
      title: article.title,
      source: article.source,
      sentiment,
      published: article.published,
      isCB: !!article.isCB,
    });
  }
  // XAU (gold) — needs its own keyword sniff because news items rarely
  // include "XAU" or "gold" as a tagged currency in the base detection.
  let goldBull = 0, goldBear = 0;
  for (const k of GOLD_BULL) if (text.includes(k)) goldBull++;
  for (const k of GOLD_BEAR) if (text.includes(k)) goldBear++;
  if (goldBull > goldBear) buckets.XAU.bullish++;
  else if (goldBear > goldBull) buckets.XAU.bearish++;
  else if (goldBull > 0 || goldBear > 0) buckets.XAU.neutral++;
  if (goldBull > 0 || goldBear > 0) {
    buckets.XAU.articles.push({
      title: article.title,
      source: article.source,
      sentiment: goldBull > goldBear ? 'bullish' : goldBear > goldBull ? 'bearish' : 'neutral',
      published: article.published,
    });
  }
}

function _finaliseBucket(b) {
  b.bias = b.bullish - b.bearish;
  b.total = b.bullish + b.bearish + b.neutral;
  // Top 3 most-recent articles for context
  b.samples = b.articles
    .sort((a, b) => new Date(b.published || 0).getTime() - new Date(a.published || 0).getTime())
    .slice(0, 3);
  delete b.articles;
  return b;
}

function _summarise(perCurrency) {
  // Human-readable one-line summary — surfaces the strongest biases
  const strong = Object.entries(perCurrency)
    .filter(([, v]) => Math.abs(v.bias) >= 3)
    .sort((a, b) => Math.abs(b[1].bias) - Math.abs(a[1].bias))
    .slice(0, 3);
  if (!strong.length) return 'No strong currency bias in the last few hours.';
  return strong
    .map(([ccy, v]) => `${ccy} ${v.bias > 0 ? 'positive' : 'negative'} (${v.bias > 0 ? '+' : ''}${v.bias})`)
    .join('; ');
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // KV cache check — 10 min TTL. Avoids re-fetching all RSS feeds on
  // every /api/check-signals tick (which fires every 60 s).
  if (env.TRADES_KV) {
    try {
      const raw = await env.TRADES_KV.get('news-sentiment-v1');
      if (raw) {
        const cached = JSON.parse(raw);
        const ageSec = Math.round((Date.now() - cached.ts) / 1000);
        if (ageSec < CACHE_TTL_SECONDS) {
          cached.ageSeconds = ageSec;
          return _json(cached, ageSec);
        }
      }
    } catch { /* cache miss OK */ }
  }

  // Fresh fetch — hit /api/news for the last 4 h of articles. The news
  // endpoint returns { news: [...], count } — read from `news`, not
  // `items`. Also articles carry `published` as a formatted string, not
  // a numeric _ts, so parse it manually.
  let articles = [];
  try {
    const res = await fetch(`${origin}/api/news?pair=all`);
    if (res.ok) {
      const data = await res.json();
      articles = Array.isArray(data.news) ? data.news
        : Array.isArray(data.items) ? data.items
        : Array.isArray(data.articles) ? data.articles
        : [];
    }
  } catch { /* handled below */ }

  // Filter to the LOOKBACK window. If a published date can't be parsed,
  // include the article (assume recent) rather than drop it — Yahoo Finance
  // dates and RSS pubDates come in many formats.
  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const recent = articles.filter(a => {
    if (!a.published) return true; // no date = assume recent
    const t = Date.parse(a.published);
    if (!Number.isFinite(t)) return true; // unparseable = keep
    return t >= cutoff;
  });

  // Initialise buckets
  const buckets = {};
  for (const c of CURRENCIES) {
    buckets[c] = { bullish: 0, bearish: 0, neutral: 0, articles: [] };
  }
  for (const a of recent) _bucketArticle(a, buckets);
  const perCurrency = {};
  for (const c of CURRENCIES) perCurrency[c] = _finaliseBucket(buckets[c]);

  const payload = {
    ts: Date.now(),
    lookbackHours: LOOKBACK_HOURS,
    articlesAnalysed: recent.length,
    perCurrency,
    summary: _summarise(perCurrency),
  };

  // v351 — Migrated to Cache API (unlimited writes) with KV fallback
  try {
    const { cachePut } = await import('./_cache-store.js');
    await cachePut('news-sentiment-v1', payload, 3600);
  } catch {
    if (env.TRADES_KV) {
      try { await env.TRADES_KV.put('news-sentiment-v1', JSON.stringify(payload), { expirationTtl: 3600 }); } catch {}
    }
  }

  payload.ageSeconds = 0;
  return _json(payload, 0);
}

function _json(payload, ageSec) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${Math.max(60, CACHE_TTL_SECONDS - ageSec)}`,
      'access-control-allow-origin': '*',
    },
  });
}
