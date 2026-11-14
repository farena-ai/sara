// Phase 6: Web Push — RFC 8291 encryption round trip (decrypted as a browser would), VAPID JWT
// verified with the public key, delivery to a fake push service, expiry cleanup, event hook, API.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { PushService, encryptPayload } from '../src/push.ts';
import { createSaraServer } from '../src/server.ts';
import { listen, makeApp, ROOT, tempDir } from './helpers.ts';

/** A browser's side of a subscription: key pair + auth secret, and the decryption it does. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decrypt(msg: Buffer): string {
      const salt = msg.subarray(0, 16);
      assert.equal(msg.readUInt32BE(16), 4096);
      const idlen = msg[20];
      const asPublic = msg.subarray(21, 21 + idlen);
      const ct = msg.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain.at(-1), 2, 'last-record delimiter');
      return plain.subarray(0, -1).toString();
    },
  };
}

function verifyVapid(header: string, endpoint: string): Record<string, unknown> {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, `vapid header shape: ${header.slice(0, 40)}`);
  const pub = Buffer.from(m[4], 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), 'ES256 signature valid');
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString()) as Record<string, unknown>;
  assert.equal(claims.aud, new URL(endpoint).origin);
  return claims;
}

test('encryption: a browser can decrypt it; rejects bad keys', () => {
  const b = browser();
  const msg = encryptPayload(Buffer.from('{"body":"hi 💛"}'), Buffer.from(b.keys.p256dh, 'base64url'), Buffer.from(b.keys.auth, 'base64url'));
  assert.equal(b.decrypt(msg), '{"body":"hi 💛"}');
  assert.throws(() => encryptPayload(Buffer.from('x'), Buffer.alloc(10), Buffer.alloc(16)), /p256dh/);
});

test('push service: VAPID keys persist in the vault, delivery, expired subscriptions removed', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  const got: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url === '/gone' ? 410 : 201).end();
  });
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const push = new PushService(app.store.db, app.vault, app.settings, { now: app.now, allowInsecure: true });
  const pk = push.publicKey;
  assert.equal(Buffer.from(pk, 'base64url').length, 65);
  assert.equal(new PushService(app.store.db, app.vault, app.settings).publicKey, pk, 'same keys after restart');
  assert.ok(!JSON.stringify(app.settings.get()).includes(pk), 'keys live in the vault, not settings');

  const phone = browser();
  push.subscribe({ endpoint: `${url}/phone`, keys: phone.keys }, 'https://sara.example.com', 'Chrome on Android');
  push.subscribe({ endpoint: `${url}/gone`, keys: browser().keys }, 'https://sara.example.com');
  assert.throws(() => push.subscribe({ endpoint: 'ftp://x', keys: phone.keys }, 'x'), /endpoint|https/);
  assert.throws(() => new PushService(app.store.db, app.vault, app.settings).subscribe({ endpoint: 'http://push.example/x', keys: phone.keys }, 'x'), /https/);
  assert.throws(() => push.subscribe({ endpoint: `${url}/bad`, keys: { p256dh: 'AAAA', auth: 'BBBB' } }, 'x'), /keys/);

  const r = await push.sendAll({ title: 'Sara', body: 'Reminder: stretch', url: '/#c=abc', tag: 'c1' });
  assert.deepEqual(r, { sent: 1, failed: 0, removed: 1 });
  assert.deepEqual(push.list().map((d) => d.label), ['Chrome on Android']);
  const p = got.find((g) => g.path === '/phone')!;
  assert.equal(p.headers['content-encoding'], 'aes128gcm');
  assert.equal(p.headers.ttl, '86400');
  const claims = verifyVapid(String(p.headers.authorization), `${url}/phone`);
  assert.equal(claims.sub, 'https://sara.example.com');
  assert.ok(Number(claims.exp) > app.now().getTime() / 1000);
  assert.deepEqual(JSON.parse(phone.decrypt(p.body)), { title: 'Sara', body: 'Reminder: stretch', url: '/#c=abc', tag: 'c1' });

  // Event hook: reminders/proactive → notification; notices and partner chats → nothing; preview off hides text.
  got.length = 0;
  const msg = { id: 9, role: 'assistant', content: 'Reminder: call Mom  \n now  sk-abcdefghijklmnopqrstuvwxyz123', createdAt: '' };
  await push.onEvent({ type: 'message', conversationId: 'c1', message: msg, reason: 'reminder' }, 'Sara', () => false, (s) => s.replace(/sk-\w+/, '[secret]'));
  // N5b: her message carries a Reply button and its one-time action token (test/n5-phone.test.ts).
  const { act, actions, companion, ...plain } = JSON.parse(phone.decrypt(got[0].body));
  assert.deepEqual(plain, { title: '⏰ Sara', body: 'Reminder: call Mom now [secret]', url: '/#c=c1', tag: 'c9' });
  assert.match(act, /^sara_act\.owner\./);
  assert.equal(companion, 'main');
  assert.deepEqual(actions.map((a: { action: string }) => a.action), ['reply']);
  await push.onEvent({ type: 'message', conversationId: 'c1', message: { ...msg, role: 'notice' }, reason: 'proactive' }, 'Sara', () => false);
  await push.onEvent({ type: 'message', conversationId: 'p', message: msg, reason: 'proactive' }, 'Sara', () => true);
  assert.equal(got.length, 1);
  app.settings.update({ push: { preview: false } });
  await push.onEvent({ type: 'message', conversationId: 'c1', message: { ...msg, content: 'something private' }, reason: 'proactive' }, 'Sara', () => false);
  assert.equal(JSON.parse(phone.decrypt(got[1].body)).body, 'Sara sent you a message.');
  // Phase 26: her call → "is calling" (preview off: no reason shown); the end of a ring sends nothing.
  const ring = { id: 'r1', kind: 'test' as const, reason: 'Pizza is ready', conversationId: 'c1', state: 'ringing' as const, createdAt: '', expiresAt: '' };
  await push.onEvent({ type: 'ring', ring }, 'Sara', () => false);
  assert.deepEqual(JSON.parse(phone.decrypt(got[2].body)), { title: '📞 Sara is calling', body: 'Open the app to answer.', url: '/#c=c1', tag: 'ring' });
  await push.onEvent({ type: 'ring', ring: { ...ring, state: 'missed' } }, 'Sara', () => false);
  assert.equal(got.length, 3);
});

test('push API: public key, subscribe needs auth, test send, unsubscribe; manifest and service worker served', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  app.push = new PushService(app.store.db, app.vault, app.settings, { allowInsecure: true });
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123def456', keys: browser().keys };
  assert.equal((await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub }) })).status, 401);
  const g = await (await fetch(`${base}/api/push`, { headers: H })).json();
  assert.equal(Buffer.from(g.publicKey, 'base64url').length, 65);
  assert.equal((await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: JSON.stringify({ subscription: sub }) })).status, 403, 'cross-site blocked');
  const s = await (await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: { ...H, origin: base }, body: JSON.stringify({ subscription: sub, label: 'Safari on iPhone/iPad' }) })).json();
  assert.equal(s.devices.length, 1);
  assert.ok(!JSON.stringify(s).includes('abc123def456') || s.devices[0].id === 'abc123def456', 'only an endpoint suffix is shown');
  assert.equal((await fetch(`${base}/api/push/subscribe`, { method: 'POST', headers: H, body: JSON.stringify({ subscription: { endpoint: 'nope' } }) })).status, 400);
  const u = await (await fetch(`${base}/api/push/unsubscribe`, { method: 'POST', headers: H, body: JSON.stringify({ endpoint: sub.endpoint }) })).json();
  assert.equal(u.devices.length, 0);

  const mf = await fetch(`${base}/manifest.webmanifest`);
  assert.match(mf.headers.get('content-type') ?? '', /manifest\+json/);
  const m = await mf.json();
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable'));
  for (const f of ['/sw.js', '/offline.html', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) assert.equal((await fetch(`${base}${f}`)).status, 200, f);
});
