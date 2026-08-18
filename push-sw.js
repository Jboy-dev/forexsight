// v459 — PUSH-ONLY SERVICE WORKER.
//
// A service worker is the only way a web app installed to the home screen can
// raise a notification while it is closed. v394/v412 killed the old worker
// because it cached HTML and JS and kept serving stale builds — that fix was
// right, but it also removed the ability to notify at all.
//
// This worker deliberately has NO fetch handler. It cannot intercept a single
// request, so it cannot serve anything stale and cannot recreate the bug that
// caused the original one to be removed. It handles exactly two events:
// showing a pushed notification, and focusing the app when one is tapped.

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { 
    try { d = { body: event.data.text() }; } catch {}
  }
  const title = d.title || 'ForexSight — new setup';
  const opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'fxsight-signal',
    renotify: true,
    // A trade setup is time-sensitive: keep it on screen until acknowledged
    // rather than letting it disappear while the phone is in a pocket.
    requireInteraction: d.requireInteraction !== false,
    vibrate: d.vibrate || [200, 80, 120, 60, 200],
    data: { url: d.url || '/', ...(d.data || {}) },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(url); } catch {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
