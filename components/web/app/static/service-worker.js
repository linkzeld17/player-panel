const CACHE_NAME = 'player-panel-static-v1.10.19';
const APP_SHELL = [
  '/',
  '/styles.css?v=1.10.19',
  '/app.js?v=1.10.19',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('player-panel-static-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Player Panel', body: 'There is a new alert.', url: '/', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_) {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil((async () => {
    const rawTimestamp = Number(payload.timestamp || Date.now());
    const notificationTimestamp = rawTimestamp < 1000000000000 ? rawTimestamp * 1000 : rawTimestamp;

    // iOS can keep a Home Screen web app client marked as visible for a short
    // period after leaving or locking it. Never suppress the system notification
    // based on client visibility; always display it through the service worker.
    await self.registration.showNotification(payload.title || 'Player Panel', {
      body: payload.body || '',
      icon: payload.icon || '/icons/icon-192.png',
      badge: payload.badge || '/icons/icon-192.png',
      tag: payload.tag || `player-panel-${Date.now()}`,
      data: { url: payload.url || '/', type: payload.type || 'alert', alertId: payload.alertId || null },
      timestamp: notificationTimestamp,
      renotify: false,
      silent: false,
      requireInteraction: payload.severity === 'critical'
    });

    // Keep an open panel synchronized, but do not replace the system notification.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'PUSH_ALERT', payload });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          if ('navigate' in client) await client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  if (['style', 'script', 'image', 'manifest'].includes(request.destination) || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
