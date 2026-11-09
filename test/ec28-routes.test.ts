// EC28 (docs/ops/EC1828_DESIGN.md): /api/readiness on a test server. Owner only; the drill runs in
// the background (202), is recorded in settings and the audit trail; the probe lists models only.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function serve(t: { after: (fn: () => Promise<void> | void) => void }, extra: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const trail = new AuditTrail(dir);
  setAuditTrail(trail);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    setAuditTrail(undefined);
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const owner = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  return { app, auth, trail, base, owner };
}

test('EC28 routes: owner only (401 signed out, 403 for an app with a device code)', async (t) => {
  const { auth, base } = await serve(t);
  assert.equal((await fetch(`${base}/readiness`)).status, 401);
  const device = auth.createDeviceToken('synthetic device');
  assert.equal((await fetch(`${base}/readiness`, { headers: { authorization: `Bearer ${device.token}` } })).status, 403);
  assert.equal((await fetch(`${base}/readiness/drill`, { method: 'POST', headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

test('EC28 routes: the demo and a household member get 404 / 403', async (t) => {
  const demo = await serve(t, { demo: true });
  assert.notEqual((await fetch(`${demo.base}/readiness`, { headers: demo.owner })).status, 200);
});

test('EC28 routes: the report has twelve areas; no model → not ready; a drill with no backup records a failure', async (t) => {
  const { app, trail, base, owner } = await serve(t);
  const r = await fetch(`${base}/readiness`, { headers: owner });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { verdict: string; areas: { id: string; status: string; reason: string }[]; drill: { running: boolean; last: unknown } };
  assert.equal(body.areas.length, 12);
  assert.equal(body.verdict, 'not-ready');
  assert.equal(body.areas.find((a) => a.id === 'model')?.reason, 'none');
  assert.equal(body.areas.find((a) => a.id === 'drill')?.reason, 'never');
  assert.deepEqual(body.drill, { running: false, last: null });
  assert.equal(app.providerCalls, 0, 'no model set up: nothing probed');
  const start = await fetch(`${base}/readiness/drill`, { method: 'POST', headers: owner, body: '{}' });
  assert.equal(start.status, 202);
  let last: { ok: boolean; step?: string } | null = null;
  for (let i = 0; i < 100 && !last; i++) {
    const d = ((await (await fetch(`${base}/readiness`, { headers: owner })).json()) as { drill: { running: boolean; last: { ok: boolean; step?: string } | null } }).drill;
    if (!d.running) last = d.last;
    else await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(last?.ok, false);
  assert.equal(last?.step, 'find');
  assert.equal((app.settings.get() as { readiness?: { drill?: { ok: boolean } } }).readiness?.drill?.ok, false);
  const rows = trail.list({ action: 'readiness.drill' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failed');
  assert.equal(rows[0].role, 'system');
});

test('EC28 routes: the probe lists the default provider\'s models (no chat call) and the model area turns ready', async (t) => {
  const { app, base, owner } = await serve(t);
  app.settings.update({ providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'fake-small' }], defaultProviderId: 'fake', defaultModel: 'fake-small' } as never);
  const r = await fetch(`${base}/readiness/probe`, { method: 'POST', headers: owner, body: '{}' });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { areas: { id: string; status: string }[] };
  assert.equal(body.areas.find((a) => a.id === 'model')?.status, 'ready');
  assert.equal(app.requests.length, 0, 'listing models is not a chat turn');
});
