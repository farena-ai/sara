// Pre-1.0 hardening (M2, M3, L9): device-code sign-in. Device tokens end after 30 days without use
// (3.49.1, owner: one rule for every sign-in; before, also 90 days after approval); start/poll have their own rate limit (they can't lock the owner out of
// signing in, and failed sign-ins don't block apps); approving needs proof it's the owner.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DEVICE_TOKEN_MAX_MS, OwnerAuth } from '../src/auth.ts';
import { DeviceFlow } from '../src/device-flow.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-27T15:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const post = (path: string, body: unknown, bearer?: string) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });

test('device tokens: 30 days unused ends them; used every day, they keep working past 90 days (3.49.1)', () => {
  const { token: dev } = auth.createDeviceToken('sara-chat');
  const start = clock.now.getTime();
  try {
    for (let day = 1; day * 86_400_000 < DEVICE_TOKEN_MAX_MS; day += 5) {
      clock.now = new Date(start + day * 86_400_000);
      assert.ok(auth.deviceTokenId(dev), `day ${day}`);
    }
    clock.now = new Date(start + DEVICE_TOKEN_MAX_MS + 60_000);
    assert.ok(auth.deviceTokenId(dev), 'past 90 days, used every few days');
    clock.now = new Date(start + DEVICE_TOKEN_MAX_MS + 31 * 86_400_000);
    assert.equal(auth.deviceTokenId(dev), undefined, '31 days unused');
    assert.equal(auth.deviceTokenReason(dev), 'idle');
  } finally {
    clock.now = new Date(start);
  }
});

test('device flow keeps the address and age of a request', () => {
  let now = 1_000_000;
  const f = new DeviceFlow(() => now);
  const r = f.start('VS Code', 'Script', '::ffff:203.0.113.9');
  now += 95_000;
  const p = f.find(r.code)!;
  assert.equal(p.ip, '203.0.113.9');
  assert.equal(p.ageSeconds, 95);
});

test('device start/poll have their own limit: failed sign-ins don\'t block apps; starts are limited on their own', async () => {
  for (let i = 0; i < 10; i++) await post('/api/login', { token: 'wrong' });
  assert.equal((await post('/api/login', { token: 'wrong' })).status, 429, 'sign-in is limited');
  assert.equal((await post('/api/device/start', { name: 'app' })).status, 200, 'apps can still ask');
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) limited = (await post('/api/device/start', { name: `app ${i}` })).status === 429;
  assert.ok(limited, 'starts are limited too');
  // Approving with a session/bearer still needs the proof; passkey confirm needs a passkey.
  assert.equal((await post('/api/passkey/confirm-options', {}, token)).status, 404);
});
