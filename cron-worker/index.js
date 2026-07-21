// forexsight-cron — v362 always-on scanner (5-min cron trigger).
//
// Every 5 minutes, this Worker fires the full scan chain against the Pages
// Functions. Without this Worker, the Pages site only scans when a user has
// the app open — nothing fires overnight or when you close the tab.
//
// Chain fired every tick (in parallel where safe):
//   1. /api/check-signals   — main signal scanner (also cascades to chart-eye,
//                             pattern-match, self-trust via its waitUntil chain)
//   2. /api/tp-monitor      — TP/SL hit detection + push notifications
//   3. /api/chart-eye       — explicit fire (belt-and-braces if check-signals
//                             throttles or fails)
//   4. /api/pattern-match   — same reasoning
//   5. /api/self-trust      — self-trust recompute + auto-correction hint
//   6. Heartbeat write      — timestamp to Cache API so we can prove cron ran
//
// v362 additions: explicit heartbeat, parallel fetches, all-scanner coverage.

const BASE = 'https://forexsight-justice.pages.dev';

const ENDPOINTS_TO_FIRE = [
  '/api/check-signals',
  '/api/tp-monitor',
  '/api/chart-eye',
  '/api/pattern-match',
  '/api/self-trust',
];

async function fireEndpoint(base, path, env) {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
    });
    const status = res.status;
    // We don't need the body — just fire the endpoint. Reading body avoids
    // subrequest hang on some CF edge nodes.
    await res.text().catch(() => '');
    return { path, status, ok: res.ok };
  } catch (e) {
    return { path, status: 0, ok: false, error: String(e.message || e).slice(0, 100) };
  }
}

async function writeHeartbeat(base, timestamp, results) {
  // Cache API heartbeat write — proves cron ran. Written to the Pages'
  // Cache API via a special heartbeat endpoint.
  try {
    await fetch(`${base}/api/cron-heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: timestamp, results }),
    });
  } catch { /* non-fatal — heartbeat is best-effort */ }
}

export default {
  async scheduled(event, env, ctx) {
    const startedAt = Date.now();
    const base = env.TARGET_BASE || BASE;

    // Fire ALL endpoints in parallel (each takes <2s) — faster + heartbeat
    // sees them all complete before writing.
    const results = await Promise.all(
      ENDPOINTS_TO_FIRE.map(p => fireEndpoint(base, p, env))
    );

    // Log to Cloudflare Worker Logs
    const summary = results.map(r => `${r.path.replace('/api/', '')}:${r.status}`).join(' ');
    console.log(`[cron v362] ${summary} · scheduled ${event.scheduledTime} · took ${Date.now() - startedAt}ms`);

    // Heartbeat write — user can check /api/cron-heartbeat to see when
    // the cron last fired even if signals didn't change.
    ctx.waitUntil(writeHeartbeat(base, startedAt, results));
  },

  // Manual trigger endpoint — useful for verification (visit workers.dev URL)
  async fetch(request, env) {
    const startedAt = Date.now();
    const base = env.TARGET_BASE || BASE;
    const results = await Promise.all(
      ENDPOINTS_TO_FIRE.map(p => fireEndpoint(base, p, env))
    );
    return new Response(JSON.stringify({
      ok: true,
      version: 'v362-full-cron',
      ranAt: new Date(startedAt).toISOString(),
      tookMs: Date.now() - startedAt,
      results,
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
