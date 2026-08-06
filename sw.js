// MERI Service Worker — Push Notifications + Offline Cache
const CACHE = 'meri-v1';
const ICON = '/despensaia/icons/icon-192.png';

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
      icon: ICON,
      badge: ICON,
      tag: 'meri-push',
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { url: '/despensaia/' }
    })
  );
});

// ── Periodic Sync: revisar estado sin push del servidor ──────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-expiry') {
    event.waitUntil(checkStateBackground());
  }
});

function daysUntil(dateStr) {
  if (!dateStr) return 999;
  return Math.round((new Date(dateStr) - Date.now()) / 86400000);
}

async function checkStateBackground() {
  try {
    const cache = await caches.open(CACHE);
    const resp = await cache.match('meri-state');
    if (!resp) return;
    const state = await resp.json();
    const pantry = state.pantry || [];
    const shopping = state.shopping || [];
    const purchaseHistory = state.purchaseHistory || [];

    const notify = async (title, body, tag) => {
      const existing = await self.registration.getNotifications({tag});
      if (existing.length) return; // ya existe esa notificación
      await self.registration.showNotification(title, {
        body, icon: ICON, badge: ICON, tag,
        vibrate: [200, 100, 200],
        data: { url: '/despensaia/' }
      });
    };

    // 1. Vence hoy o mañana
    const hoyManana = pantry.filter(f => { const d=daysUntil(f.exp); return d>=0&&d<=1; });
    if (hoyManana.length) await notify(
      'MERI ⚠️ Vence hoy o mañana',
      hoyManana.map(f=>f.name).join(', ') + (hoyManana.length>1?' vencen':' vence') + ' pronto. Úsalos ya.',
      'expiry-1'
    );

    // 2. Vence en 3 días
    const en3 = pantry.filter(f => { const d=daysUntil(f.exp); return d>1&&d<=3; });
    if (en3.length) await notify(
      'MERI 📅 Alimentos por vencer',
      en3.map(f=>f.name).join(', ') + ' vence'+(en3.length>1?'n':'')+' en menos de 3 días',
      'expiry-3'
    );

    // 3. Stock bajo
    const stockBajo = pantry.filter(f => f.min>0 && f.qty<=f.min);
    if (stockBajo.length) await notify(
      'MERI 📦 Stock bajo',
      stockBajo.map(f=>`${f.name} (${f.qty} ${f.unit||''})`).join(', ') + ' está'+(stockBajo.length>1?'n':'')+' por acabarse',
      'stock-low'
    );

    // 4. Despensa casi vacía
    if (pantry.length > 0 && pantry.length <= 3) await notify(
      'MERI 🛒 Tu despensa está casi vacía',
      'Solo tienes ' + pantry.length + ' alimento(s). ¿Es hora de hacer mercado?',
      'pantry-empty'
    );

    // 5. Sugerencia de lista
    if (purchaseHistory.length >= 2 && shopping.length === 0) await notify(
      'MERI 💡 ¿Hora de hacer mercado?',
      'Abre MERI y genera tu lista personalizada con IA en un toque',
      'shop-suggest'
    );

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
