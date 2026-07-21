// forexsight-cron — v386 double-target scanner (5-min cron trigger).
//
// Runs on the ORIGINAL Cloudflare account (flashesuperman). Fires the
// full scan chain against BOTH Pages sites in parallel every 5 min:
//   • https://forexsight-justice.pages.dev  (original / legacy)
//   • https://forexsight-preview.pages.dev  (school account / current)
//
// With v385 GitHub Actions cron ALSO hitting the preview URL every 15
// min, the preview URL now has redundant coverage (belt & braces).
// If one path fails, the other keeps the scanner alive.
//
// Chain fired every tick against each target (in parallel):
//   1. /api/check-signals   — main signal scanner
//   2. /api/shadow-tracker  — v381 tier stamping + outcome resolution
//   3. /api/tp-monitor      — TP/SL hit detection + push notifications
//   4. /api/chart-eye       — chart-read
//   5. /api/pattern-match   — pattern library refresh
//   6. /api/self-trust      — trust recompute + auto-correction hint

const ENDPOINTS_TO_FIRE = [
  '/api/check-signals',
  '/api/shadow-tracker',
  '/api/tp-monitor',
  '/api/chart-eye',
  '/api/pattern-match',
  '/api/self-trust',
];

const TARGETS = [
  'https://forexsight-justice.pages.dev',
  'https://forexsight-preview.pages.dev',
];

async function fireEndpoint(base, path, env) {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_KEY ? { 'x-cron-key': env.CRON_KEY } : {},
    });
    const status = res.status;
    await res.text().catch(() => '');
    return { target: base, path, status, ok: res.ok };
  } catch (e) {
    return { target: base, path, status: 0, ok: false, error: String(e.message || e).slice(0, 100) };
  }
}

async function writeHeartbeat(base, timestamp, results) {
  try {
    await fetch(`${base}/api/cron-heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: timestamp, results: results.filter(r => r.target === base) }),
    });
  } catch { /* non-fatal */ }
}

export default {
  async scheduled(event, env, ctx) {
    const startedAt = Date.now();
    // env.TARGETS_JSON overrides default TARGETS if set (comma-separated in wrangler.toml)
    const targets = env.TARGETS_JSON
      ? env.TARGETS_JSON.split(',').map(s => s.trim()).filter(Boolean)
      : TARGETS;

    // Fire every endpoint against every target — flat parallel fan-out.
    const jobs = [];
    for (const base of targets) {
      for (const path of ENDPOINTS_TO_FIRE) {
        jobs.push(fireEndpoint(base, path, env));
      }
    }
    const results = await Promise.all(jobs);

    // Compact summary per target
    const byTarget = {};
    for (const r of results) {
      const key = r.target.replace('https://', '').replace('.pages.dev', '');
      if (!byTarget[key]) byTarget[key] = [];
      byTarget[key].push(`${r.path.replace('/api/', '')}:${r.status}`);
    }
    for (const [t, list] of Object.entries(byTarget)) {
      console.log(`[cron v386] ${t} ${list.join(' ')} · ${event.scheduledTime} · ${Date.now() - startedAt}ms`);
    }

    // Heartbeat to each target
    for (const base of targets) {
      ctx.waitUntil(writeHeartbeat(base, startedAt, results));
    }
  },

  async fetch(request, env) {
    const startedAt = Date.now();
    const targets = env.TARGETS_JSON
      ? env.TARGETS_JSON.split(',').map(s => s.trim()).filter(Boolean)
      : TARGETS;
    const jobs = [];
    for (const base of targets) {
      for (const path of ENDPOINTS_TO_FIRE) {
        jobs.push(fireEndpoint(base, path, env));
      }
    }
    const results = await Promise.all(jobs);
    return new Response(JSON.stringify({
      ok: true,
      version: 'v386-double-target',
      targets,
      ranAt: new Date(startedAt).toISOString(),
      tookMs: Date.now() - startedAt,
      resultsByTarget: targets.reduce((acc, t) => {
        acc[t] = results.filter(r => r.target === t);
        return acc;
      }, {}),
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
