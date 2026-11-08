import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { continuityParallel } from '../src/session-continuity.ts';
import { PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function fixture() {
  const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-07T12:00:00Z') });
  const auth = new OwnerAuth(temp.dir); const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = 'GET', body?: unknown) => fetch(origin + '/api' + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, dir: temp.dir, call, async close() { setPolicy(new PolicyStore()); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); app.store.close(); temp.cleanup(); } };
}

test('mnt2: parallel replies default to 4, are saved without touching the on/off choice, and malformed values are refused', async () => {
  const f = await fixture();
  try {
    assert.equal(continuityParallel(f.app), 4);
    const got = await (await f.call('/chats/continuity')).json();
    assert.deepEqual([got.enabled, got.parallel, got.parallelMax], [true, 4, 8]);
    for (const parallel of [0, 9, 2.5, '3', null]) assert.equal((await f.call('/chats/continuity', 'PUT', { parallel })).status, 400, String(parallel));
    const saved = await (await f.call('/chats/continuity', 'PUT', { parallel: 2 })).json();
    assert.deepEqual([saved.enabled, saved.parallel], [true, 2]);
    assert.deepEqual(f.app.settings.get().chats?.continuity, { enabled: true, parallel: 2 });
    assert.equal((await f.call('/chats/continuity', 'PUT', { enabled: false })).status, 200);
    assert.deepEqual(f.app.settings.get().chats?.continuity, { enabled: false, parallel: 2 });
  } finally { await f.close(); }
});

test('mnt2: the parallelReplies pin is a ceiling: it caps the setting and refuses asking for more', async () => {
  assert.throws(() => validatePolicy({ pins: { parallelReplies: 0 } }), /1 to 8/);
  assert.throws(() => validatePolicy({ pins: { parallelReplies: 12 } }), /1 to 8/);
  assert.deepEqual(validatePolicy({ pins: { parallelReplies: 2 } }).pins, { parallelReplies: 2 });
  const f = await fixture();
  try {
    const pol = new PolicyStore(f.dir); setPolicy(pol);
    pol.set({ name: 'Team', pins: { parallelReplies: 2 } });
    assert.equal(continuityParallel(f.app), 2, 'the default of 4 is held to the pin');
    const refused = await f.call('/chats/continuity', 'PUT', { parallel: 3 });
    assert.equal(refused.status, 409);
    assert.equal((await f.call('/chats/continuity', 'PUT', { parallel: 1 })).status, 200);
    assert.equal(continuityParallel(f.app), 1);
    const got = await (await f.call('/chats/continuity')).json();
    assert.deepEqual([got.parallel, got.parallelMax], [1, 2]);
  } finally { await f.close(); }
});
