// ForexSight Service Worker — required for iOS PWA notifications and offline shell.

const CACHE = 'forexsight-cf-v389';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  // v246 — Cache each shell file independently so ONE missing file (e.g. a
  // future icon rename) doesn't break the whole install. addAll() is
  // all-or-nothing; this loop keeps going even if some 404.
  event.waitUntil(
    caches.open(CACHE).then(async (c) => {
      await Promise.all(SHELL.map(async (url) => {
        try { await c.add(url); } catch (e) { /* swallow per-file */ }
      }));
    }).catch(() => {})
  );
  self.skipWaiting();
});
// v246 — Catch any unhandled error inside the SW so it doesn't get killed
// and forced to re-register. Same idea as the page-side error handlers.
self.addEventListener('error', (e) => {
  try { console.warn('[sw global error]', e.message || 'unknown'); } catch {}
});
self.addEventListener('unhandledrejection', (e) => {
  try { console.warn('[sw unhandled promise]', e.reason && e.reason.message || String(e.reason)); } catch {}
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// NETWORK-FIRST strategy with cache fallback.
//
// Why: cache-first kept iOS PWA users stuck on old code for days because the
// SW always served the cached app.js/style.css and never checked for updates.
// Network-first means online users get fresh code on every load (with the
// cache transparently updated as backup), and offline users still get the
// last cached shell so the app keeps working without internet.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // always go network for data
  if (url.pathname === '/reset.html') return;   // reset tool MUST be live, never cached
  if (url.pathname === '/signals.html' || url.pathname === '/signals') return; // standalone signals viewer
  if (event.request.method !== 'GET') return;

  // Only handle same-origin GETs we care about
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    // 1. Try network first with a short timeout — fresh code wins.
    try {
      const networkRes = await Promise.race([
        fetch(event.request),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sw-timeout')), 4500)),
      ]);
      if (networkRes && networkRes.ok) {
        // Update cache in the background for offline fallback
        try {
          const copy = networkRes.clone();
          const cache = await caches.open(CACHE);
          cache.put(event.request, copy);
        } catch {}
        return networkRes;
      }
      // Non-OK network response — fall through to cache
      const cached = await caches.match(event.request);
      return cached || networkRes;
    } catch (e) {
      // 2. Network failed (offline / timeout) → serve from cache
      const cached = await caches.match(event.request);
      return cached || new Response('offline', { status: 503 });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Build a deep-link URL with the pair + direction so the app can auto-open
  // that signal's modal. Was just '/' which dumped you on the home grid with
  // no way to find the signal that fired the alert.
  const data = event.notification.data || {};
  const pair = data.pair || '';
  const direction = data.direction || '';
  // URL-encode pair (it has '/') so the param survives intact: e.g. EUR%2FUSD
  let targetUrl = data.url || '/';
  if (pair) {
    const sep = targetUrl.includes('?') ? '&' : '?';
    targetUrl += `${sep}signal=${encodeURIComponent(pair)}${direction ? '&dir=' + direction : ''}`;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(self.location.host)) {
          w.focus();
          if ('navigate' in w) w.navigate(targetUrl);
          // Also post a message so the page can react immediately even if
          // navigate() is a no-op (some PWA contexts don't navigate).
          try { w.postMessage({ type: 'open-signal', pair, direction }); } catch {}
          return;
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

// Allow the page to trigger a notification via postMessage (path used when
// `new Notification()` is unavailable, e.g. inside an iOS PWA).
// Also supports SKIP_WAITING for the "Update now" banner — when the page
// detects a waiting SW and the user taps update, it tells us to activate.
self.addEventListener('message', (event) => {
  const t = event.data?.type;
  if (t === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (t === 'show-notification') {
    const { title, options } = event.data;
    self.registration.showNotification(title, options || {});
  }
});

// ════════════════════════════════════════════════════════════════════════
// PUSH EVENT — server-initiated Web Push delivery.
// This is THE mechanism that wakes up the SW when the user's phone is
// locked + app closed. iOS Safari (16.4+) supports Web Push only through
// the home-screen PWA, only with VAPID, and only after the user explicitly
// granted notification permission. The OS holds a persistent connection
// to our push service (APNs on iOS) so when our server sends an encrypted
// push payload, the OS wakes the SW briefly to display the notification.
// ════════════════════════════════════════════════════════════════════════
self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { title: 'ForexSight', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'ForexSight signal';
  // STRONGER default vibrate — was [30,50,30,50,30] (~150ms, 3 short buzzes
  // easy to miss). Now [200,80,80,60,100,60,120] (~720ms, long initial pulse
  // + 3 sharp follow-ups). Direction-aware if payload specifies it.
  const isBuy = (payload.data && payload.data.direction === 'BUY') ||
                (payload.direction === 'BUY');
  const defaultVibrate = isBuy
    ? [200, 80, 80, 60, 100, 60, 120]
    : [200, 80, 120, 60, 100, 60, 80];
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    tag: payload.tag || 'fxsight-signal',
    renotify: true,
    requireInteraction: payload.requireInteraction !== false,
    silent: false,
    vibrate: payload.vibrate || defaultVibrate,
    data: payload.data || { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// pushsubscriptionchange — fired when the browser invalidates the existing
// subscription (e.g. after a long offline period). We just notify the page
// next time it opens to re-subscribe.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open('forexsight-state');
      await cache.put(
        new Request('https://fxs.local/sub-needs-refresh'),
        new Response('1', { headers: { 'cache-control': 'max-age=86400' } })
      );
    } catch {}
  })());
});

// ========== Periodic Background Sync — "always checking" without server cron ==========
// When supported (Chrome Android PWA, desktop Chrome PWA), the OS wakes the SW
// periodically to run a check. iOS Safari doesn't support this — no harm done,
// the SW just never gets the event. Wrapped in try/catch so a failure here
// can never crash the SW or the app.
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'forexsight-check-signals') return;
  event.waitUntil(swCheckSignals().catch((err) => console.warn('[sw periodicsync]', err.message)));
});

// Also support manual one-shot sync (fired from the app on visibility change).
self.addEventListener('sync', (event) => {
  if (event.tag !== 'forexsight-check-once') return;
  event.waitUntil(swCheckSignals().catch((err) => console.warn('[sw sync]', err.message)));
});

// v193 — gold-only mode means we ALWAYS scan. The weekend skip from the
// previous version was for forex (Fri 22 UTC → Sun 22 UTC). User wants
// scanning never to stop. Function preserved but always returns false so
// the scan + notify path runs 24/7. Note: actual price data from Yahoo
// may not refresh over the weekend when COMEX is closed.
function _swForexClosed() {
  return false; // v193: always scan
}

async function swCheckSignals() {
  try {
    // v193: gold-only mode scans 24/7. Weekend guard disabled.
    if (_swForexClosed()) return;
    const res = await fetch('/api/latest-signals', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.signals) || data.signals.length === 0) return;
    // Bumped to v2 so old wrongly-stamped seen entries (from the previous
    // 6h-TTL window logic) get nuked on first activation of this SW.
    const cache = await caches.open('forexsight-alerts-seen-v2');
    const now = Date.now();
    const STALE_MINUTES = 90; // signal must have been detected within this window
    for (const s of data.signals) {
      try {
        if (!s || !s.pair || !s.direction) continue;
        // Stale-signal guard — don't notify if the signal was detected
        // more than 90 min ago. This is the main reason users were getting
        // alerts for "old signals they don't need".
        if (s.detectedAt) {
          const detectedMs = new Date(s.detectedAt).getTime();
          if (Number.isFinite(detectedMs)) {
            const ageMin = (now - detectedMs) / 60000;
            if (ageMin > STALE_MINUTES) continue;
            if (ageMin < -5) continue; // future timestamps = clock skew, ignore
          }
        }
        // v283/v284 — RAISED FLOORS. User asked for the brain to be much
        // pickier. SW gate mirrors the server-side push gate:
        //   • strategies ≥ 3 (was 2)
        //   • confidence ≥ 88 (was 85)
        //   • brain pWin ≥ 68 IF brain ran.
        // v317b — BTC gets a relaxed 2-strategy gate. BTC signals rarely
        // hit 3 concurrent strategy confluences because BTC's ADX regime
        // is naturally lower than gold. Compensated by requiring higher
        // confidence (≥92) + multiSource CONFIRM. That's still a strict
        // gate — just calibrated for the asset's actual volatility profile.
        const isBTC = s.pair === 'BTC/USD';
        const msVerdict = s.multiSourceCheck && s.multiSourceCheck.verdict;
        const btcOk = isBTC && s.strategies >= 2 && (s.confidence || 0) >= 92 && msVerdict === 'CONFIRM';
        if (!btcOk) {
          if (!s.strategies || s.strategies < 3) continue;
          if (!s.confidence || s.confidence < 88) continue;
        }
        const swPwin = (s.probabilityAnalysis && typeof s.probabilityAnalysis.pWin === 'number')
          ? s.probabilityAnalysis.pWin
          : (typeof s.pWin === 'number' ? s.pWin : null);
        // v317b — BTC pWin threshold 55% (matches server-side relaxation)
        const swPwinFloor = isBTC ? 55 : 68;
        if (swPwin != null && swPwin < swPwinFloor) continue;
        const key = `${s.pair}_${s.direction}_${(s.detectedAt || '').slice(0, 13)}`;
        const seenKey = new Request(`https://fxs.local/seen/${encodeURIComponent(key)}`);
        const seen = await cache.match(seenKey);
        if (seen) continue;
        // 48h TTL on dedup so the same signal can't re-fire days later
        await cache.put(seenKey, new Response('1', { headers: { 'cache-control': 'max-age=172800' } }));
        // Strategy-aware title (matches the push-fire pipeline format)
        const stratHint = s.inKillzone && s.strategies >= 2 ? '🎯 ICT-style'
          : s.strategies >= 3 ? '🏆 SUPER'
          : s.strategies === 2 ? '📐 Multi-strategy'
          : '⭐ Strategy';
        const title = `${stratHint} ${s.pair} ${s.direction} — ${s.confidence}%`;
        const body = `${s.strategies} pattern strategies confirm · Entry ${s.entry} · SL ${s.sl} · TP1 ${s.tp1}`;
        await self.registration.showNotification(title, {
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: key,
          renotify: true,
          requireInteraction: true, // always persistent so silent users see it
          data: { url: '/', pair: s.pair, direction: s.direction },
          // STRONGER vibrate pattern (was 5-buzz ultra-fast ~150ms — too
          // brief to feel through pocket). Now 7-buzz direction-aware
          // pattern ~720ms with strong initial pulse.
          vibrate: s.direction === 'BUY'
            ? [200, 80, 80, 60, 100, 60, 120]
            : [200, 80, 120, 60, 100, 60, 80],
          silent: false,
        });
      } catch (e) { /* swallow per-signal */ }
    }
  } catch (e) { /* swallow */ }
}
