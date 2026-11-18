// ROADMAP_T T1/T2 (docs/SELF_REPAIR.md): the self-repair API and chat tools on a real in-process server with
// the real adapters (src/repair-env.ts): owner only (members and kid mode 403, no tools), audited, the
// permission setting with the 24-hour switch, fix + undo of a bad setting, the tool's card per permission.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { repairOf } from '../src/repair-env.ts';
import { createSaraServer } from '../src/server.ts';
import { createRepairTools } from '../src/tools/repair.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const clock = { now: new Date('2026-11-16T12:00:00Z') };

async function node(t: TestContext, opts: { member?: boolean; child?: boolean } = {}) {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  app.settings.update({ providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'small-1', needsKey: false }] as never, defaultProviderId: 'fake', defaultModel: 'small-1' });
  if (opts.member) (app as { member?: unknown }).member = { record: () => ({ id: 'mem0000001', name: 'Mo', child: Boolean(opts.child) }), child: () => (opts.child ? { age: 9 } : undefined) };
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const record = () => ({ id: 'mem0000001', name: 'Mo', status: 'active', child: Boolean(opts.child), limits: { voice: false, pictures: false } });
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(opts.member ? { spaceId: 'mem0000001', member: { record: () => record() as never, apps: () => [app], deleteSelf: async () => {} } } : {}) });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const raw = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()));
    app.store.close();
    tmp.cleanup();
  });
  return { app, req, raw };
}

test('T1 routes: owner sees problems, fixes a bad setting, undoes it; every action audited', async (t) => {
  const prev = auditTrail();
  const dir = tempDir();
  setAuditTrail(new AuditTrail(dir.dir));
  t.after(() => {
    setAuditTrail(prev);
    dir.cleanup();
  });
  const { app, req } = await node(t);
  app.settings.update({ fallbackAfterSec: 5000 });
  let v = await req('POST', '/api/repair/check', {});
  const p = v.problems.find((x: { id: string }) => x.id === 'setting:fallbackAfterSec');
  assert.ok(p, 'found the bad value');
  assert.equal(v.settings.permission, 'auto1');
  v = await req('POST', '/api/repair/fix', { problem: 'setting:fallbackAfterSec' });
  assert.equal(v.done[0].result, 'fixed');
  assert.equal(app.settings.get().fallbackAfterSec, undefined);
  assert.ok(!v.problems.some((x: { id: string }) => x.id === 'setting:fallbackAfterSec'));
  const run = v.runs.find((r: { problem: string }) => r.problem === 'setting:fallbackAfterSec');
  assert.ok(run.undoable);
  v = await req('POST', `/api/repair/runs/${run.id}/undo`, {});
  assert.equal(app.settings.get().fallbackAfterSec, 5000);
  assert.equal(v.runs.find((r: { id: number }) => r.id === run.id).undone, true);
  const rows = auditTrail()!.list({});
  const acts = rows.map((r) => r.action);
  assert.ok(acts.includes('repair.fix') && acts.includes('repair.undo'), acts.join(','));
  assert.ok(acts.includes('repair.do'), `the route is audited too: ${acts.join(',')}`);
  // A never-path is refused even when asked for by id.
  v = await req('POST', '/api/repair/fix', { problem: 'setting:toolPermissions' });
  assert.equal(v.done[0].result, 'refused');
});

test('T1 routes: the permission setting and the 24-hour full permission (expires)', async (t) => {
  const { app, req, raw } = await node(t);
  let v = await req('PUT', '/api/repair/settings', { permission: 'ask' });
  assert.equal(v.settings.permission, 'ask');
  assert.equal((await raw('PUT', '/api/repair/settings', { permission: 'everything' })).status, 400);
  v = await req('PUT', '/api/repair/settings', { full: true });
  assert.equal(v.settings.fullOn, true);
  assert.equal(Date.parse(v.settings.fullUntil) - clock.now.getTime(), 24 * 3600_000);
  clock.now = new Date(clock.now.getTime() + 25 * 3600_000);
  v = await req('GET', '/api/repair');
  assert.equal(v.settings.fullOn, false, 'runs out after 24 hours');
  v = await req('PUT', '/api/repair/settings', { full: false });
  assert.equal(v.settings.fullUntil, null);
  assert.deepEqual(app.settings.get().repair, { permission: 'ask', fullUntil: null, share: false, shareLinks: [] });
});

test('T1 tools: repair_status reads; repair_fix runs alone in auto1, asks in ask mode, always asks to grow', async (t) => {
  const { app } = await node(t);
  app.repair = repairOf(app);
  const [status, fix] = createRepairTools(() => app.repair);
  app.settings.update({ fallbackAfterSec: 5000 });
  const out = await status!.run({}, {} as never);
  assert.match(out, /setting:fallbackAfterSec/);
  const ctx = { signal: AbortSignal.timeout(5000) };
  let prep = await fix!.prepare!({ problem: 'setting:fallbackAfterSec' }, ctx);
  assert.equal(prep.auto, true, 'auto1: level 1 runs on its own');
  app.settings.update({ repair: { permission: 'ask' } });
  prep = await fix!.prepare!({ problem: 'setting:fallbackAfterSec' }, ctx);
  assert.ok(!prep.auto && prep.summary, 'ask: one card');
  app.settings.update({ repair: { permission: 'ask', fullUntil: new Date(clock.now.getTime() + 3600_000).toISOString() } });
  prep = await fix!.prepare!({ problem: 'everything' }, ctx);
  assert.equal(prep.auto, true, 'full permission covers the whole repair');
  prep = await fix!.prepare!({ learn: 'Check the shared calendar every Monday' }, ctx);
  assert.ok(!prep.auto, 'level 2 always asks');
  prep = await fix!.prepare!({ problem: 'setting:repair.permission' }, ctx);
  assert.ok(prep.refuse, 'never its own permission');
  const done = await fix!.run({ problem: 'everything' }, {} as never);
  assert.match(done, /fixed/);
  assert.equal(app.settings.get().fallbackAfterSec, undefined);
});

test('T1 owner only: household members and kid mode get 403 and no engine', async (t) => {
  for (const child of [false, true]) {
    const { app, raw } = await node(t, { member: true, child });
    assert.equal((await raw('GET', '/api/repair')).status, 403);
    assert.equal((await raw('POST', '/api/repair/fix', { problem: 'everything' })).status, 403);
    assert.equal((await raw('PUT', '/api/repair/settings', { full: true })).status, 403);
    assert.equal(repairOf(app), undefined);
    const [status, fix] = createRepairTools(() => repairOf(app));
    assert.equal(status!.isAvailable!(), false);
    assert.equal(fix!.isAvailable!(), false);
  }
});
