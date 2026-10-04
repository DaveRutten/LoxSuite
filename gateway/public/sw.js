// LoxSuite service worker: makes LoxSuite installable as an app (home screen) and shows web-push
// notifications. Pages are always loaded from the server (LoxSuite is a live app; nothing is
// cached for offline use) — only a small offline notice is shown when the server can't be reached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>LoxSuite</title>' +
    '<body style="font-family:system-ui;padding:2rem;text-align:center;color:#333"><h2>LoxSuite is not reachable</h2>' +
    '<p>Check the connection to your home network and try again.</p><button onclick="location.reload()">Retry</button></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'LoxSuite', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'LoxSuite', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    actions: (data.actions || []).slice(0, 2),
    data: { url: data.url || '/', extra: data.data || {} },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  if (event.action) {
    // A button: tell LoxSuite (snooze, not today, which car...). Cookies of the app go along.
    event.waitUntil(fetch('/app/action', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: event.action, data: event.notification.data && event.notification.data.extra }),
    }).catch(() => {}));
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
