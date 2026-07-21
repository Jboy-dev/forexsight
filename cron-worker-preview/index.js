// forexsight-preview-cron — v384 always-on scanner for the preview URL.
//
// The main cron worker (forexsight-cron on the original account) only fires
// against forexsight-justice.pages.dev. This one targets the preview site
// on the school account.
//
// Every 5 minutes, fires the full scan chain against Pages Functions.
// Without this, the preview site only scans when the user has the app
// open — nothing fires overnight or when the tab is closed.
//
// Chain fired every tick (in parallel):
//   1. /api/check-signals   — main scanner
//   2. /api/shadow-tracker  — v381 tier stamping + outcome resolution
//   3. /api/tp-monitor      — TP/SL hit detection + push notifications
//   4. /api/chart-eye       — belt-and-braces chart-read
//   5. /api/pattern-match   — pattern library refresh
//   6. /api/self-trust      — trust recompute + auto-correction hint
//   7. Heartbeat write      — timestamp to Cache API for proof-of-run

const BASE = 'https://forexsight-preview.pages.dev';

const ENDPOINTS_TO_FIRE = [
  '/api/check-signals',
  '/api/shadow-tracker',
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
    await res.text().catch(() => '');
    return { path, status, ok: res.ok };
  } catch (e) {
    return { path, status: 0, ok: false, error: String(e.message || e).slice(0, 100) };
  }
}

async function writeHeartbeat(base, timestamp, results) {
  try {
    await fetch(`${base}/api/cron-heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: timestamp, results }),
    });
  } catch { /* non-fatal */ }
}

export default {
  async scheduled(event, env, ctx) {
    const startedAt = Date.now();
    const base = env.TARGET_BASE || BASE;
    const results = await Promise.all(
      ENDPOINTS_TO_FIRE.map(p => fireEndpoint(base, p, env))
    );
    const summary = results.map(r => `${r.path.replace('/api/', '')}:${r.status}`).join(' ');
    console.log(`[preview-cron v384] ${summary} · ${event.scheduledTime} · ${Date.now() - startedAt}ms`);
    ctx.waitUntil(writeHeartbeat(base, startedAt, results));
  },

  async fetch(request, env) {
    const startedAt = Date.now();
    const base = env.TARGET_BASE || BASE;
    const results = await Promise.all(
      ENDPOINTS_TO_FIRE.map(p => fireEndpoint(base, p, env))
    );
    return new Response(JSON.stringify({
      ok: true,
      version: 'v384-preview-cron',
      target: base,
      ranAt: new Date(startedAt).toISOString(),
      tookMs: Date.now() - startedAt,
      results,
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
