// EC12 slice 2: the crews routes are the owner's (members, the demo and signed-out callers get
// 403/401), every change is an audited route group, and the Team dialog's Crews section and the
// chat's crew card follow the web rules (no inline styles, ? tips within 260 characters, t()).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { boardFor } from '../src/board.ts';
import { Crews } from '../src/crews.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-04T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  app.team = new TeamManager(app, app.store.db);
  app.board = boardFor(app.planner!);
  app.crews = new Crews(app, app.store.db);
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
    return { status: res.status, headers: res.headers, body: (ct.includes('json') ? await res.json().catch(() => ({})) : await res.text()) as any };
  }
  return { app, api };
}

const CREW = { name: 'Desk', brief: 'A short brief on the week for Alex.', members: [{ helper: 'researcher', task: 'Look around the workspace' }, { helper: 'writer', task: 'Write the brief' }], schedule: { kind: 'manual' } };

test('crews routes: the owner makes, runs, reads the file of, stops and deletes a crew', async (t) => {
  const { app, api } = await rig(t);
  const list = await api('/api/crews');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.templates.map((x: { id: string }) => x.id).sort(), ['code-review-crew', 'research-desk', 'weekly-planner']);
  assert.ok(Array.isArray(list.body.helpers) && list.body.helpers.some((h: { id: string }) => h.id === 'writer'));
  const made = await api('/api/crews', 'POST', CREW);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.crew.id;
  assert.equal((await api('/api/crews', 'POST', { ...CREW, folder: '../x' })).status, 400);
  app.script.push(text('Looked around.'), text('Wrote the brief.'), text('The crew finished the brief.'));
  const run = await api(`/api/crews/${id}/run`, 'POST', {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  await app.crews!.finished(run.body.run.id);
  const runs = await api(`/api/crews/${id}/runs`);
  assert.equal(runs.body.runs[0].status, 'done');
  const file = await api(`/api/crews/runs/${run.body.run.id}/file`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename="\d{4}-\d\d-\d\d-\d{4}\.md"/);
  assert.match(file.body, /# Desk/);
  const patched = await api(`/api/crews/${id}`, 'PATCH', { state: 'paused' });
  assert.equal(patched.body.crew.state, 'paused');
  const stop = await api('/api/crews/stop-all', 'POST', {});
  assert.equal(stop.status, 200);
  assert.equal(typeof stop.body.paused, 'number');
  assert.equal((await api(`/api/crews/${id}`, 'DELETE')).status, 200);
  assert.equal((await api(`/api/crews/${id}`, 'PATCH', { state: 'on' })).status, 404);
});

test('crews routes: members, the demo and signed-out callers cannot use crews', async (t) => {
  for (const mode of ['member', 'demo'] as const) {
    const { api } = await rig(t, mode);
    assert.equal((await api('/api/crews')).status, 403, mode);
    assert.equal((await api('/api/crews', 'POST', CREW)).status, 403, mode);
    assert.equal((await api('/api/crews/stop-all', 'POST', {})).status, 403, mode);
  }
  const { api } = await rig(t);
  assert.equal((await api('/api/crews', 'GET', undefined, null)).status, 401);
});

test('crews routes: crews and the memory tidy are audited route groups, denied to device tokens', () => {
  const src = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  const audited = /const AUDITED = new Set\(\[([^\]]+)\]\)/.exec(src)![1];
  assert.match(audited, /'crews'/);
  assert.match(audited, /'memory-tidy'/);
  const denied = /const DEVICE_TOKEN_DENIED = new Set\(\[([^\]]+)\]\)/.exec(src)![1];
  assert.match(denied, /'crews'/);
});

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('crews ui: the Team dialog has Crews, the chat shows crew cards, web rules hold', () => {
  const html = web('index.html');
  const js = web('crews.js');
  const app = web('app.js');
  assert.match(html, /<h3 id="crews-h">Crews <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/h3>/);
  assert.match(html, /<div id="crews" aria-labelledby="crews-h"><\/div>/);
  assert.doesNotMatch(js, /style=|\.style\./);
  for (const m of js.matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) assert.ok(m[1].length <= 260, m[1]);
  assert.ok([...js.matchAll(/ field\(t\('/g)].length >= 10, 'each control of the form goes through field(label, input, ? tip)');
  assert.match(js, /btn\(t\('Stop all'\)/);
  assert.match(js, /\/crews\/stop-all/);
  assert.match(app, /m\.kind === 'crew'\) \{\s*\/\/[^\n]*\n\s*els\.push\(crewNotice\(m\)\)/);
  assert.match(app, /void loadCrews\(\)/);
});
