// ════════════════════════════════════════════════════════════════════════
// Web Push protocol implementation for Cloudflare Pages Functions.
// RFC 8030 (Web Push) + RFC 8291 (encryption) + RFC 8292 (VAPID).
// Uses Web Crypto API only — no external dependencies.
//
// Exports:
//   sendPush(subscription, payload, vapid) → fetch Response
//   VAPID_PUBLIC, VAPID_PRIVATE — the keypair used by both sender and client
// ════════════════════════════════════════════════════════════════════════

// VAPID keys — public is shared with the client to create the subscription;
// private is server-side only and used to sign the JWT proving we own the
// public key. NEVER expose VAPID_PRIVATE to the client.
export const VAPID_PUBLIC  = 'BBN2wUW_dCHf0ua0mL5wpv7SGhRG1JUWa1juTLfAOBJz-dlUF4gEsSGfJDYTnhfIW_SAbeMa11e0ZSxLPI8gsV0';
export const VAPID_PRIVATE = 'W67yjfqrFl9sOLOzRLXJlc2CMcW8urRZGWF0BCrkLUw';
export const VAPID_SUBJECT = 'mailto:noreply@forexsight.app';

// ── Base64URL helpers ───────────────────────────────────────────────────
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function concat(...arrs) {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ── HKDF (RFC 5869) — extract + expand ──────────────────────────────────
async function hmacSign(key, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
async function hkdfKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function hkdf(salt, ikm, info, len) {
  const prk = await hmacSign(await hkdfKey(salt), ikm);
  const out = await hmacSign(await hkdfKey(prk), concat(info, new Uint8Array([1])));
  return out.slice(0, len);
}

// ── VAPID JWT (ES256) ──────────────────────────────────────────────────
async function buildVapidJwt(audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,  // 12h
    sub: VAPID_SUBJECT,
  };
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const message = `${enc(header)}.${enc(claims)}`;

  // Reconstruct the private key as a JWK
  const pub = b64uDecode(VAPID_PUBLIC);
  if (pub[0] !== 4 || pub.length !== 65) throw new Error('VAPID public key malformed');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
    d: VAPID_PRIVATE,
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    new TextEncoder().encode(message)
  ));
  return `${message}.${b64u(sig)}`;
}

// ── AES128GCM payload encryption (RFC 8291 + RFC 8188) ──────────────────
async function encryptPayload(payload, p256dh, auth) {
  // Generate ephemeral ECDH keypair
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveBits']
  );
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  // Import subscriber's public key
  const subKey = await crypto.subtle.importKey(
    'raw', p256dh,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH shared secret
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subKey },
    eph.privateKey,
    256
  ));

  // First HKDF: derive IKM using auth + custom info
  const wpInfo = concat(
    new TextEncoder().encode('WebPush: info\0'),
    p256dh, ephPub
  );
  const ikm = await hkdf(auth, ecdh, wpInfo, 32);

  // Second HKDF: derive CEK + nonce from random salt + IKM
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // Pad payload (record delimiter byte 0x02 = last record)
  const padded = concat(payload, new Uint8Array([2]));

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    aesKey, padded
  ));

  // Build aes128gcm header: salt(16) + record-size(4 BE) + idlen(1) + keyid
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false);
  const header = concat(salt, rsBytes, new Uint8Array([ephPub.length]), ephPub);
  return concat(header, cipher);
}

// ── Public API ─────────────────────────────────────────────────────────
export async function sendPush(subscription, payloadObj) {
  const url = subscription.endpoint;
  const audience = new URL(url).origin;
  const jwt = await buildVapidJwt(audience);
  const p256dh = b64uDecode(subscription.keys.p256dh);
  const auth   = b64uDecode(subscription.keys.auth);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(payloadBytes, p256dh, auth);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
      'TTL': '300',
      'Urgency': 'high',
    },
    body,
  });
  return res;
}
