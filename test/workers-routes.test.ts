// C10 slice 2: the workers routes are the owner's (members, the demo and signed-out callers get
// 403/401), every change is an audited route group, export is a download without secrets, import
// needs the preview's confirmation, and the Team dialog's Workers section follows the web rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import { Workers, type WorkerOutcome } from '../src/workers.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', apiKey: 'sk-live-ROUTESECRET123456789' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() } as never);
  app.team = new TeamManager(app, app.store.db);
  app.workers = new Workers(app, app.store.db, { runner: () => {
      let end!: (o: WorkerOutcome) => void;
      return { done: new Promise<WorkerOutcome>((r) => (end = r)), stop: () => end({ status: 'stopped', result: '', tokens: 0 }), waiting: () => false };
    }, alert: async () => true, quiet: () => false });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex' }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown, token: string | null = auth.newToken ?? null) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: (ct.includes('json') && !(res.headers.get('content-disposition') ?? '').includes('attachment') ? await res.json().catch(() => ({})) : await res.text()) as any };
  }
  return { app, api };
}

const DANA = { name: 'Docs Dana', character: 'Precise. Key sk-live-ROUTESECRET123456789 is not for you.', helper: 'writer', toolGroups: ['read', 'write'] };

test('workers routes: make, queue, stop, fail, replay, drop, export and import', async (t) => {
  const { app, api } = await rig(t);
  const made = await api('/api/workers', 'POST', DANA);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.worker.id;
  assert.equal((await api('/api/workers', 'POST', { ...DANA, helper: 'nobody' })).status, 400);
  const job = await api(`/api/workers/${id}/jobs`, 'POST', { title: 'Tidy the README', input: '' });
  assert.equal(job.status, 200);
  assert.equal(job.body.job.status, 'running', 'queued and started on the spot');
  const list = await api('/api/workers');
  assert.equal(list.body.workers[0].running.id, job.body.job.id);
  assert.ok(list.body.groups.some((g: { id: string }) => g.id === 'shell'));
  assert.ok(list.body.helpers.every((h: { id: string }) => !h.id.startsWith('worker-')));
  // Stop: the job goes to Failed jobs (stopped by you); replay makes a copy; drop hides the old one.
  assert.equal((await api(`/api/workers/${id}/stop`, 'POST', {})).body.worker.state, 'paused');
  await app.workers!.finished(job.body.job.id);
  const failed = (await api('/api/workers')).body.failed;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].worker, 'Docs Dana');
  assert.match(failed[0].error, /stopped by you/);
  const copy = await api(`/api/workers/jobs/${failed[0].id}/replay`, 'POST', {});
  assert.equal(copy.body.job.replayOf, failed[0].id);
  assert.equal((await api(`/api/workers/jobs/${failed[0].id}/drop`, 'POST', {})).status, 200);
  assert.equal((await api('/api/workers')).body.failed.length, 0);
  // Export: a download, no secret in it.
  const exp = await api(`/api/workers/${id}/export`);
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') ?? '', /attachment; filename="docs-dana\.sara-worker\.json"/);
  assert.ok(!exp.body.includes('ROUTESECRET'));
  const bundle = JSON.parse(exp.body);
  const prev = await api('/api/workers/import/preview', 'POST', { bundle });
  assert.equal(prev.status, 200);
  assert.deepEqual(prev.body.preview.workers[0].risky.sort(), ['edit_file', 'write_file']);
  assert.equal((await api('/api/workers/import', 'POST', { bundle })).status, 400, 'confirmation needed');
  const imp = await api('/api/workers/import', 'POST', { bundle, confirm: true });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.workers[0].name, 'Docs Dana (2)');
  assert.equal(imp.body.workers[0].state, 'paused');
  assert.equal((await api('/api/workers/import/preview', 'POST', { bundle: { kind: 'x' } })).status, 400);
  assert.equal((await api(`/api/workers/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(`/api/workers/${id}`, 'PATCH', { state: 'on' })).status, 404);
});

test('workers routes: members, the demo and signed-out callers cannot use workers', async (t) => {
  for (const mode of ['member', 'demo'] as const) {
    const { api } = await rig(t, mode);
    assert.equal((await api('/api/workers')).status, 403, mode);
    assert.equal((await api('/api/workers', 'POST', DANA)).status, 403, mode);
    assert.equal((await api('/api/workers/import', 'POST', { bundle: {}, confirm: true })).status, 403, mode);
  }
  const { api } = await rig(t);
  assert.equal((await api('/api/workers', 'GET', undefined, null)).status, 401);
  const src = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(/const AUDITED = new Set\(\[([^\]]+)\]\)/.exec(src)![1], /'workers'/);
  assert.match(/const DEVICE_TOKEN_DENIED = new Set\(\[([^\]]+)\]\)/.exec(src)![1], /'workers'/);
});

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('workers ui: the Team dialog has Workers that stay with Failed jobs and import, web rules hold', () => {
  const html = web('index.html');
  const js = web('workers.js');
  const app = web('app.js');
  assert.match(html, /<h3 id="workers-h">Workers that stay <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/h3>/);
  assert.match(html, /<div id="workers" aria-labelledby="workers-h"><\/div>/);
  assert.doesNotMatch(js, /style=|\.style\./);
  for (const m of js.matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) assert.ok(m[1].length <= 260, m[1]);
  assert.match(js, /t\('Failed jobs'\)/);
  assert.match(js, /\/workers\/import\/preview/);
  assert.match(js, /t\('Replay'\)/);
  assert.match(app, /void loadWorkers\(\)/);
});
