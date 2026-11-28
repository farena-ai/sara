// 3.49.1: a sign-in that is used stays signed in. Found on the owner's server (2026-11-27): the cookie
// carried a fixed end 30 days after the sign-in, so every device he used daily was signed out on its
// 30th day, while the Devices list promised "30 days unused".
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;

test('3.49.1: a cookie in use gets a fresh 30 days once a day; an unused one still ends', () => {
  const { dir, cleanup } = tempDir();
  try {
    const clock = { now: new Date('2026-10-28T01:16:55Z') };
    const auth = new OwnerAuth(dir, () => clock.now);
    const first = auth.createSession('Sara app on Windows');
    // The same day: nothing to renew.
    clock.now = new Date(clock.now.getTime() + 2 * 60 * 60 * 1000);
    assert.equal(auth.renewSession(first.value), undefined);
    // Used every day for 29 days, renewing as it goes: still signed in on day 45.
    let cookie = first.value;
    for (let d = 1; d <= 45; d++) {
      clock.now = new Date(Date.parse('2026-10-28T01:16:55Z') + d * DAY);
      assert.ok(auth.verifySession(cookie), `day ${d}`);
      const r = auth.renewSession(cookie);
      assert.ok(r, `renewed on day ${d}`);
      assert.equal(r.maxAgeSeconds, 400 * 24 * 3600, 'the browser keeps it; the server ends it');
      assert.equal(auth.sessionId(r.value), auth.sessionId(cookie), 'the same device');
      cookie = r.value;
    }
    // Without the renewal the first cookie ends on day 30, as before.
    assert.equal(auth.verifySession(first.value), false);
    // Not used for 31 days: no renewal brings it back.
    clock.now = new Date(clock.now.getTime() + 31 * DAY);
    assert.equal(auth.verifySession(cookie), false);
    assert.equal(auth.renewSession(cookie), undefined);
    // Signed out under Devices: no renewal.
    const s = auth.createSession('Browser');
    clock.now = new Date(clock.now.getTime() + 2 * DAY);
    auth.signOut(s.id);
    assert.equal(auth.renewSession(s.value), undefined);
    assert.equal(auth.renewSession('nonsense.cookie'), undefined);
    assert.equal(auth.renewSession(undefined), undefined);
  } finally {
    cleanup();
  }
});

test('3.49.1: the server sends the renewed cookie with a signed-in request (not with a token, not twice a day)', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-02T10:00:00Z') };
  const app = makeApp(dir, clock);
  const auth = new OwnerAuth(dir, () => clock.now);
  const http = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '3.49.1', revision: null, startedAt: new Date().toISOString() } } as never);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    http.closeAllConnections?.();
    await new Promise<void>((r) => http.close(() => r()));
    app.store.close();
    cleanup();
  });
  const s = auth.createSession('Chrome on Windows');
  const get = (cookie: string) => fetch(`${base}/api/conversations`, { headers: { Cookie: `sara_session=${encodeURIComponent(cookie)}` } });
  // Within the first day: no new cookie.
  let r = await get(s.value);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('set-cookie'), null);
  // Day 20: a new cookie for 30 days, HttpOnly and SameSite=Strict as always.
  clock.now = new Date(clock.now.getTime() + 20 * DAY);
  r = await get(s.value);
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie') ?? '';
  assert.match(set, /^sara_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=34560000/);
  const fresh = decodeURIComponent(/^sara_session=([^;]+)/.exec(set)![1]!);
  // Day 40: the old cookie is past its end, the renewed one still works.
  clock.now = new Date(clock.now.getTime() + 20 * DAY);
  assert.equal((await get(s.value)).status, 401);
  assert.equal((await get(fresh)).status, 200);
});

test('3.49.1: the reason a sign-in ended: 30 days unused, or signed out under Devices', () => {
  const { dir, cleanup } = tempDir();
  try {
    const clock = { now: new Date('2026-11-01T10:00:00Z') };
    const auth = new OwnerAuth(dir, () => clock.now);
    const a = auth.createSession('Phone');
    const b = auth.createSession('Laptop');
    assert.equal(auth.signedOutReason(a.value), undefined, 'still signed in');
    auth.signOut(b.id);
    assert.equal(auth.signedOutReason(b.value), 'removed');
    clock.now = new Date(clock.now.getTime() + 31 * DAY);
    assert.equal(auth.verifySession(a.value), false);
    assert.equal(auth.signedOutReason(a.value), 'idle');
    assert.equal(auth.signedOutReason('123.abc.forged'), undefined, 'not a cookie of this server');
    assert.equal(auth.signedOutReason(undefined), undefined);
  } finally {
    cleanup();
  }
});

test('3.49.1: the sign-in page and the 401 say why the device was signed out', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-02T10:00:00Z') };
  const app = makeApp(dir, clock);
  const auth = new OwnerAuth(dir, () => clock.now);
  const http = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '3.49.1', revision: null, startedAt: new Date().toISOString() } } as never);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    http.closeAllConnections?.();
    await new Promise<void>((r) => http.close(() => r()));
    app.store.close();
    cleanup();
  });
  const s = auth.createSession('Chrome on Windows');
  const h = { Cookie: `sara_session=${encodeURIComponent(s.value)}` };
  clock.now = new Date(clock.now.getTime() + 31 * DAY);
  const session = (await (await fetch(`${base}/api/session`, { headers: h })).json()) as { authenticated: boolean; signedOut?: string };
  assert.equal(session.authenticated, false);
  assert.equal(session.signedOut, 'idle');
  const r = await fetch(`${base}/api/conversations`, { headers: h });
  assert.equal(r.status, 401);
  const body = (await r.json()) as { error: string; signedOut?: string };
  assert.equal(body.signedOut, 'idle');
  assert.match(body.error, /not used for 30 days/);
  // No cookie at all: the plain message, no reason.
  const plain = (await (await fetch(`${base}/api/session`)).json()) as { signedOut?: string };
  assert.equal(plain.signedOut, undefined);
  const r2 = await fetch(`${base}/api/conversations`);
  assert.equal(((await r2.json()) as { error: string }).error, 'Sign in first.');
  // The page has the place for it, and the app's words.
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'), /id="login-why"/);
  assert.match(readFileSync(join(ROOT, 'web', 'app.js'), 'utf8'), /session\.signedOut === 'idle'/);
});
