// MERI - Gemini API Proxy + Push Notifications Worker
// Secrets requeridos en Cloudflare:
//   GEMINI_API_KEY   → API key de Gemini
//   VAPID_PRIV_JWK   → JWK del private key VAPID (JSON string)
//   VAPID_PUBLIC     → Public key VAPID en base64url
// KV namespace requerido: PUSH_SUBS (binding name)

const VAPID_EMAIL = 'mailto:meriapp.soporte@gmail.com';

// ── Dominios permitidos (CORS) ───────────────────────────────
const ALLOWED_ORIGINS = [
  'https://giovanniagc92-pixel.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

// ── Rate limiting: máx llamadas a Gemini por IP por día ──────
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 86400; // segundos (24h)

async function checkRateLimit(env, ip) {
  if (!env.PUSH_SUBS) return true; // sin KV, permitir
  const key = `rl:${ip}:${new Date().toISOString().slice(0,10)}`;
  const raw = await env.PUSH_SUBS.get(key);
  const count = raw ? parseInt(raw) : 0;
  if (count >= RATE_LIMIT_MAX) return false;
  await env.PUSH_SUBS.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.find(o => origin.startsWith(o)) || ALLOWED_ORIGINS[0];
}

export default {
  // ── HTTP requests ────────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));

    if (request.method === 'OPTIONS') return corsResponse('', 204, getAllowedOrigin(request));

    // Bloquear orígenes no permitidos (excepto llamadas directas sin Origin, ej. cron)
    if (origin && !allowed) {
      return corsResponse(JSON.stringify({ error: 'Forbidden' }), 403, origin);
    }

    // ── Push: guardar suscripción ──
    if (url.pathname === '/push-subscribe' && request.method === 'POST') {
      try {
        const { subscription, uid, pantry } = await request.json();
        if (!subscription?.endpoint) return corsResponse(JSON.stringify({ error: 'No subscription' }), 400);
        const key = uid || subscription.endpoint.slice(-20);
        await env.PUSH_SUBS.put(key, JSON.stringify({ subscription, pantry: pantry || [], ts: Date.now() }));
        return corsResponse(JSON.stringify({ ok: true }));
      } catch(e) {
        return corsResponse(JSON.stringify({ error: e.message }), 500);
      }
    }

    // ── Push: actualizar datos de despensa ──
    if (url.pathname === '/push-data' && request.method === 'POST') {
      try {
        const { uid, pantry } = await request.json();
        if (!uid) return corsResponse(JSON.stringify({ error: 'No uid' }), 400);
        const existing = await env.PUSH_SUBS.get(uid);
        if (existing) {
          const data = JSON.parse(existing);
          data.pantry = pantry;
          await env.PUSH_SUBS.put(uid, JSON.stringify(data));
        }
        return corsResponse(JSON.stringify({ ok: true }));
      } catch(e) {
        return corsResponse(JSON.stringify({ error: e.message }), 500);
      }
    }

    // ── Gemini proxy ──
    if (request.method !== 'POST') return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405, getAllowedOrigin(request));
    let body;
    try { body = await request.json(); } catch { return corsResponse(JSON.stringify({ error: 'Invalid JSON' }), 400, getAllowedOrigin(request)); }

    // Rate limiting por IP
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const allowed2 = await checkRateLimit(env, ip);
    if (!allowed2) {
      return corsResponse(JSON.stringify({ error: 'rate_limit', message: 'Límite diario de IA alcanzado' }), 429, getAllowedOrigin(request));
    }

    const model = body.model || 'gemini-2.5-flash';
    delete body.model;
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      const data = await geminiRes.json();
      return corsResponse(JSON.stringify(data), geminiRes.status, getAllowedOrigin(request));
    } catch(e) {
      return corsResponse(JSON.stringify({ error: 'Gemini request failed', detail: e.message }), 500, getAllowedOrigin(request));
    }
  },

  // ── Cron: enviar push diario a las 8am Bogotá (13:00 UTC) ───
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDailyPush(env));
  }
};

// ── Enviar push a todos los suscriptores con items por vencer ──
async function sendDailyPush(env) {
  if (!env.PUSH_SUBS) return;
  const list = await env.PUSH_SUBS.list();
  const today = Date.now();
  const results = [];
  for (const key of list.keys) {
    try {
      const raw = await env.PUSH_SUBS.get(key.name);
      if (!raw) continue;
      const { subscription, pantry } = JSON.parse(raw);
      const expiring = (pantry || []).filter(item => {
        if (!item.exp) return false;
        const days = Math.round((new Date(item.exp) - today) / 86400000);
        return days >= 0 && days <= 2;
      });
      if (!expiring.length) continue;
      const names = expiring.map(i => i.name).join(', ');
      const body = expiring.length === 1
        ? `${names} vence hoy o mañana. Úsalo pronto.`
        : `${names} vencen hoy o mañana. Úsalos pronto.`;
      await sendWebPush(subscription, { title: 'MERI ⚠️ Alimentos por vencer', body }, env);
      results.push({ key: key.name, sent: true, items: expiring.length });
    } catch(e) {
      results.push({ key: key.name, error: e.message });
    }
  }
  console.log('Push diario:', JSON.stringify(results));
}

// ── Web Push con VAPID (sin payload cifrado — SW muestra notif) ──
async function sendWebPush(subscription, payload, env) {
  const endpoint = subscription.endpoint;
  const endpointUrl = new URL(endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const now = Math.floor(Date.now() / 1000);

  // Construir JWT VAPID
  const headerB64 = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payloadB64 = base64url(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_EMAIL }));
  const sigInput = `${headerB64}.${payloadB64}`;

  // Importar clave privada VAPID desde JWK
  const privJwk = JSON.parse(env.VAPID_PRIV_JWK);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk', privJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const jwt = `${sigInput}.${uint8ToBase64url(new Uint8Array(sig))}`;

  // Cifrar payload con AES-GCM usando clave pública del suscriptor
  const bodyBytes = await encryptPayload(subscription, payload);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${env.VAPID_PUBLIC}`,
      'TTL': '86400',
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
    },
    body: bodyBytes
  });
  if (!res.ok && res.status !== 201) {
    const text = await res.text();
    throw new Error(`Push failed ${res.status}: ${text}`);
  }
}

// ── Cifrado Web Push (RFC 8291 / aes128gcm) ─────────────────
async function encryptPayload(subscription, payload) {
  const keys = subscription.keys;
  if (!keys?.p256dh || !keys?.auth) throw new Error('No subscription keys');

  const authSecret = base64urlToUint8(keys.auth);
  const receiverPubKeyBytes = base64urlToUint8(keys.p256dh);

  // Generar ephemeral key pair
  const senderKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const senderPubKey = await crypto.subtle.exportKey('raw', senderKeyPair.publicKey);

  // Import receiver public key
  const receiverPubKey = await crypto.subtle.importKey('raw', receiverPubKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverPubKey }, senderKeyPair.privateKey, 256);

  // Salt (16 random bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF to derive content encryption key and nonce
  const ikm = await hkdf(authSecret, new Uint8Array(sharedBits), buildInfo('auth', new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)), 32);
  const prk = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits', 'deriveKey']);

  const senderPubKeyBytes = new Uint8Array(senderPubKey);
  const keyInfo = buildInfo('aesgcm', salt, senderPubKeyBytes, receiverPubKeyBytes);
  const nonceInfo = buildInfo('nonce', salt, senderPubKeyBytes, receiverPubKeyBytes);

  const cek = await hkdfFromKey(prk, salt, keyInfo, 16);
  const nonce = await hkdfFromKey(prk, salt, nonceInfo, 12);

  // Encrypt
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const padded = new Uint8Array([...plaintext, 0x02]); // RFC 8291 padding delimiter

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded);

  // Build aes128gcm content (salt + rs + keyid_len + keyid + ciphertext)
  const senderPubArr = new Uint8Array(senderPubKey);
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + senderPubArr.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = senderPubArr.length;
  header.set(senderPubArr, 21);

  const result = new Uint8Array(header.byteLength + ciphertext.byteLength);
  result.set(header, 0);
  result.set(new Uint8Array(ciphertext), header.byteLength);
  return result;
}

function buildInfo(type, salt, senderPub, receiverPub) {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(`Content-Encoding: ${type}\0`);
  // For 'auth' type use a simpler context
  if (type === 'auth') {
    const label = enc.encode('Content-Encoding: auth\0');
    return label;
  }
  // keyinfo = label || 0x00 || 0x41 || sender || 0x41 || receiver
  const result = new Uint8Array(typeBytes.length + 1 + 1 + senderPub.length + 1 + receiverPub.length);
  let off = 0;
  result.set(typeBytes, off); off += typeBytes.length;
  result[off++] = 0x00; // context delimiter
  result[off++] = 0x41; // uncompressed point prefix
  result.set(senderPub.slice(1), off); off += senderPub.length - 1; // skip 0x04
  result[off++] = 0x41;
  result.set(receiverPub.slice(1), off);
  return result;
}

async function hkdf(salt, ikm, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prkBytes = await crypto.subtle.sign('HMAC', saltKey, ikm);
  const prkKey = await crypto.subtle.importKey('raw', prkBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const infoWithCounter = new Uint8Array([...info, 0x01]);
  const okm = await crypto.subtle.sign('HMAC', prkKey, infoWithCounter);
  return new Uint8Array(okm).slice(0, length);
}

async function hkdfFromKey(prk, salt, info, length) {
  const infoWithCounter = new Uint8Array([...info, 0x01]);
  const okm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: infoWithCounter }, prk, length * 8);
  return new Uint8Array(okm);
}

// ── Utilidades ───────────────────────────────────────────────
function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function uint8ToBase64url(arr) {
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function base64urlToUint8(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function corsResponse(body, status = 200, origin = ALLOWED_ORIGINS[0]) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
