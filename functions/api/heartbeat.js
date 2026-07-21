// /api/heartbeat — Smallest possible always-on endpoint.
//
// The only thing this endpoint does is return 200 OK with the current time
// and version. No KV reads, no upstream fetches, no try/catch needed because
// there's nothing that can fail. Used by:
//   • The UI's "are we online?" check (so a degraded /api/check-signals
//     doesn't get misread as "site is down")
//   • External uptime monitors
//   • Future smoke-test harnesses
//
// If /api/heartbeat ever fails, the entire Cloudflare Pages deployment is
// broken — not just one endpoint. Keeping it microscopic is the point.
export function onRequest() {
  return new Response(JSON.stringify({
    ok: true,
    ts: Date.now(),
    iso: new Date().toISOString(),
    version: 'v246-crash-proof',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
