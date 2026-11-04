import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { OwnerAuth } from '../src/auth.ts';
import { memberVault } from '../src/household.ts';
import { Vault } from '../src/vault.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

test('Q3 recovery routes: owner metadata allowed; unauthenticated and device-token recovery refused', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: 'q3-fixture', revision: 'fixture', startedAt: '2026-11-04T12:00:00Z' } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); app.store.close(); cleanup(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  assert.equal((await fetch(`${base}/deliveries`)).status, 401);
  const device = auth.createDeviceToken('Q3 fixture');
  const D = { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' };
  for (const path of ['/deliveries', '/jobs/999/recovery', '/jobs/999/continue', '/team/999/resume']) {
    const res = await fetch(`${base}${path}`, { method: path === '/deliveries' ? 'GET' : 'POST', headers: D, ...(path === '/deliveries' ? {} : { body: '{}' }) });
    assert.equal(res.status, 403, `device cannot recover through ${path}`);
  }
  const res = await fetch(`${base}/deliveries`, { headers: { authorization: `Bearer ${auth.newToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.deliveries, []);
  assert.equal(body.coverage, 'native-message-creation');
});

test('Q3 bootstrap never schedules automatic interrupted-team execution', () => {
  const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
  assert.equal(/setTimeout\(\(\) => app\.team\?\.resumeInterrupted\(\)/.test(main), false, 'bootstrap never auto-resumes interrupted team work');
});

test('Q3 member vault does not expose owner recovery encryption operations', () => {
  const { dir, cleanup } = tempDir();
  try {
    const base = new Vault(dir);
    const cipher = base.seal('owner recovery data', 'fixture-context');
    const restricted = memberVault(base, () => ({ models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false }));
    assert.throws(() => restricted.unseal(cipher, 'fixture-context'));
    assert.throws(() => restricted.seal('member input', 'fixture-context'));
  } finally { cleanup(); }
});
