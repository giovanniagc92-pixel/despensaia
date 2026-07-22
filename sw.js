// MERI Service Worker — Push Notifications + Offline Cache
const CACHE = 'meri-v1';

// ── Install & Cache ──────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ── Push: recibir notificación del servidor ──────────────────
self.addEventListener('push', event => {
  let data = { title: 'MERI ⚠️', body: 'Tienes alimentos por vencer pronto' };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; } catch(e) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/despensaia/icons/icon-192.png',
      badge: '/despensaia/icons/icon-192.png',
      tag: 'meri-expiry',
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { url: '/despensaia/' }
    })
  );
});

// ── Periodic Sync: revisar vencimientos sin push del servidor ─
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-expiry') {
    event.waitUntil(checkExpiryBackground());
  }
});

async function checkExpiryBackground() {
  try {
    const cache = await caches.open(CACHE);
    const resp = await cache.match('meri-pantry');
    if (!resp) return;
    const pantry = await resp.json();
    const today = Date.now();
    const expiring = pantry.filter(item => {
      if (!item.exp) return false;
      const days = Math.round((new Date(item.exp) - today) / 86400000);
      return days >= 0 && days <= 2;
    });
    if (!expiring.length) return;
    const names = expiring.map(i => i.name).join(', ');
    const plural = expiring.length === 1;
    await self.registration.showNotification('MERI ⚠️ Alimentos por vencer', {
      body: `${names} ${plural ? 'vence' : 'vencen'} hoy o mañana. Úsalos pronto.`,
      icon: '/despensaia/icons/icon-192.png',
      badge: '/despensaia/icons/icon-192.png',
      tag: 'meri-expiry',
      vibrate: [200, 100, 200],
      data: { url: '/despensaia/' }
    });
  } catch(e) {}
}

// ── Clic en notificación ─────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/despensaia/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const win = list.find(w => w.url.includes('despensaia'));
      if (win) { win.focus(); return; }
      return clients.openWindow(url);
    })
  );
});
