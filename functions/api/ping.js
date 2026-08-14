// v451 — minimal liveness probe. No imports, no bindings, no fetches.
//
// Exists to separate two very different failures that look identical from
// the outside: "the Functions runtime is not running my code at all" versus
// "my code is running but erroring". When /api/* returns the static HTML
// shell, this endpoint tells you which one it is — if THIS returns JSON the
// runtime is fine and the fault is in a specific handler; if even this
// returns HTML, nothing is being routed to Functions.
export async function onRequest() {
  return new Response(JSON.stringify({
    ok: true,
    pong: Date.now(),
    runtime: 'cloudflare-pages-functions',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
