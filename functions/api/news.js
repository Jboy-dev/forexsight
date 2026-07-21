// Cloudflare Pages Function: GET /api/news?pair=EUR/USD
// Aggregates forex/macro RSS feeds. Tiered cache: 60s edge for breaking news,
// 5min for slow-moving sources. Returns timestamped items so client can show
// "X min ago" and a freshness banner.

// Tier 1 — FAST (central bank decisions, breaking market news). 60s cache.
const FAST_FEEDS = [
  ['Reuters Markets', 'https://feeds.reuters.com/reuters/businessNews', 60],
  ['Reuters Currencies', 'https://feeds.reuters.com/reuters/USdollarReport', 60],
  ['ForexLive', 'https://www.forexlive.com/feed/news', 60],
  ['FXStreet Breaking', 'https://www.fxstreet.com/rss/news', 60],
  ['Investing Forex', 'https://www.investing.com/rss/forex.rss', 90],
  ['MarketWatch Pulse', 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse', 90],
];

// Tier 2 — STANDARD (broader macro, analysis). 5min cache.
const STD_FEEDS = [
  ['DailyFX', 'https://www.dailyfx.com/feeds/market-news', 300],
  ['Investing News', 'https://www.investing.com/rss/news_25.rss', 300],
  ['CNBC Forex', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', 300],
  ['Trading Economics', 'https://tradingeconomics.com/calendar/rss', 300],
];

// Tier 3 — CENTRAL BANK FEEDS (highest signal). 2min cache.
const CB_FEEDS = [
  ['Fed Press', 'https://www.federalreserve.gov/feeds/press_all.xml', 120],
  ['ECB Press', 'https://www.ecb.europa.eu/rss/press.html', 120],
  ['BoE News', 'https://www.bankofengland.co.uk/-/rss/news', 120],
  ['BoJ', 'https://www.boj.or.jp/en/rss/whatsnew.xml', 120],
  ['RBA', 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml', 120],
];

const ALL_FEEDS = [...FAST_FEEDS, ...STD_FEEDS, ...CB_FEEDS];

const BULL = ['rally','surge','gain','gains','rise','rises','bullish','strong','boost','climb','jump','hike','growth','recover','recovery','upbeat','optimistic','beat','beats','upgrade','higher','hawkish','tighten','tightening','raise rates','rate hike'];
const BEAR = ['fall','falls','drop','drops','decline','declines','crash','bearish','weak','slump','plunge','cut','cuts','recession','negative','losses','miss','misses','downgrade','lower','slide','slides','dovish','ease','easing','rate cut','rate cuts'];

// Central bank → currency mapping for relevance boost
const CB_CURRENCY = {
  'fed': 'USD', 'federal reserve': 'USD', 'powell': 'USD',
  'ecb': 'EUR', 'lagarde': 'EUR', 'european central bank': 'EUR',
  'boe': 'GBP', 'bank of england': 'GBP', 'bailey': 'GBP',
  'boj': 'JPY', 'bank of japan': 'JPY', 'ueda': 'JPY', 'kuroda': 'JPY',
  'rba': 'AUD', 'reserve bank of australia': 'AUD', 'bullock': 'AUD',
  'rbnz': 'NZD', 'snb': 'CHF', 'boc': 'CAD',
};

function stripHtml(s) { return (s || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim(); }
function decodeCdata(s) { return (s || '').replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1'); }
function tag(content, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = content.match(re);
  return m ? decodeCdata(m[1]).trim() : '';
}
function sentiment(text) {
  const t = (text || '').toLowerCase();
  let b = 0, r = 0;
  for (const k of BULL) if (t.includes(k)) b++;
  for (const k of BEAR) if (t.includes(k)) r++;
  if (b > r + 1) return 'bullish';
  if (r > b + 1) return 'bearish';
  return 'neutral';
}
function detectCurrencies(text) {
  const t = (text || '').toLowerCase();
  const set = new Set();
  for (const [kw, ccy] of Object.entries(CB_CURRENCY)) {
    if (t.includes(kw)) set.add(ccy);
  }
  // Direct mentions
  const T = text.toUpperCase();
  for (const c of ['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF']) {
    if (T.includes(c)) set.add(c);
  }
  return Array.from(set);
}
function parseItems(xml, source, isCB) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = stripHtml(tag(block, 'title'));
    const link = stripHtml(tag(block, 'link'));
    const summary = stripHtml(tag(block, 'description')).slice(0, 400);
    const published = tag(block, 'pubDate') || tag(block, 'dc:date');
    if (!title) continue;
    const text = title + ' ' + summary;
    items.push({
      source, title, link, summary, published,
      sentiment: sentiment(text),
      currencies: detectCurrencies(text),
      isCB: !!isCB,
      // Recency score for sort: parse pubDate or fallback to "now"
      _ts: published ? Date.parse(published) : Date.now(),
    });
    if (items.length >= 20) break;
  }
  return items;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pair = (url.searchParams.get('pair') || '').toUpperCase();

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  let cached = await cache.match(cacheKey);
  if (cached) { const c = new Response(cached.body, cached); c.headers.set('x-cf-cache', 'HIT'); return c; }

  const cbFeedNames = new Set(CB_FEEDS.map(f => f[0]));
  const results = await Promise.allSettled(
    ALL_FEEDS.map(async ([name, feedUrl, ttl]) => {
      const res = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 ForexSight/1.0' },
        cf: { cacheTtl: ttl, cacheEverything: true },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
      const xml = await res.text();
      return parseItems(xml, name, cbFeedNames.has(name));
    })
  );

  let items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

  if (pair) {
    const currencies = pair.replace('/', ' ').split(' ').filter(Boolean);
    items = items.filter(it => {
      // Match if item's detected currencies include either side of the pair
      if (it.currencies && it.currencies.some(c => currencies.includes(c))) return true;
      const T = (it.title + ' ' + it.summary).toUpperCase();
      return currencies.some(c => T.includes(c)) || T.includes(pair) || T.includes(pair.replace('/', ''));
    });
  }

  // Sort: recency primary, central-bank items boosted
  items.sort((a, b) => {
    const aCB = a.isCB ? 1 : 0;
    const bCB = b.isCB ? 1 : 0;
    // CB items get a 30-min recency boost so they stay near top longer
    const aTs = a._ts + (aCB * 30 * 60 * 1000);
    const bTs = b._ts + (bCB * 30 * 60 * 1000);
    return bTs - aTs;
  });

  // Strip the internal _ts field before returning
  const clean = items.slice(0, 80).map(({ _ts, ...rest }) => rest);

  const response = new Response(
    JSON.stringify({
      news: clean,
      count: items.length,
      generated_at: new Date().toISOString(),
      freshness_sec: 60, // shortest tier
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        // Edge cache 90s (was 300s — half the staleness for breaking news).
        // Browser cache 60s (was 120). stale-while-revalidate keeps users
        // moving while the edge updates.
        'Cache-Control': 'public, s-maxage=90, max-age=60, stale-while-revalidate=3600',
        'x-cf-cache': 'MISS',
      },
    }
  );
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
