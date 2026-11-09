// EC13 slice 4: the memory tidy routes (the owner, or a member in their own space; never the demo)
// and the Memory page's Overnight tidy section and morning card (web rules: no inline styles, tips
// within 260 characters, Undo per change, the three answers per proposal).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { MemoryTidy } from '../src/memory-tidy.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-05T23:30:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'here', label: 'Here', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }], defaultProviderId: 'here', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  const conv = app.store.createConversation({ title: 'Chat' });
  app.store.addMessage(conv.id, 'user', 'hi');
  const add = (content: string, on: string) => app.memory!.add({ kind: 'fact', content, conversationId: conv.id, sourceMessageId: null, happenedOn: on });
  const a = add('Alex drinks coffee every day', '2026-08-01');
  const b = add('Alex no longer drinks coffee every day', '2026-10-01');
  const c = add('Alex likes green tea in the morning', '2026-09-01');
  const d = add('Alex likes green tea in the morning.', '2026-10-02');
  app.memoryTidy = new MemoryTidy(app, app.store.db);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex', status: 'active', limits: { voice: true, pictures: true } }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  return { app, api, notes: { a, b, c, d } };
}

test('memory tidy routes: settings, Tidy now, the card\'s changes, Undo and the answers', async (t) => {
  const { app, api, notes } = await rig(t);
  const got = await api('/api/memory-tidy');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.settings, { on: false, model: 'local' });
  assert.equal(got.body.local, true, 'a model on this computer is set up');
  assert.equal((await api('/api/memory-tidy', 'PUT', { on: true })).body.settings.on, true);
  app.script.push(text('YES'));
  const run = await api('/api/memory-tidy/run', 'POST', {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const view = await api(`/api/memory-tidy/runs/${run.body.run.id}`);
  assert.equal(view.status, 200);
  const merge = view.body.run.changes.find((c: { kind: string }) => c.kind === 'merge');
  const conflict = view.body.run.changes.find((c: { kind: string }) => c.kind === 'contradiction');
  assert.ok(merge && conflict);
  assert.equal((await api(`/api/memory-tidy/changes/${merge.id}/undo`, 'POST', {})).status, 200);
  assert.equal(app.memory!.get(notes.d.id)!.supersededBy, null);
  assert.equal((await api(`/api/memory-tidy/changes/${merge.id}/undo`, 'POST', {})).status, 409);
  assert.equal((await api(`/api/memory-tidy/changes/${conflict.id}/newer`, 'POST', {})).status, 200);
  assert.equal(app.memory!.get(notes.a.id)!.supersededBy, notes.b.id);
  assert.equal((await api(`/api/memory-tidy/changes/${conflict.id}/sideways`, 'POST', {})).status, 404);
});

test('memory tidy routes: a member tidies their own space; the demo cannot', async (t) => {
  const m = await rig(t, 'member');
  const mg = await m.api('/api/memory-tidy');
  assert.equal(mg.status, 200, JSON.stringify(mg.body));
  m.app.script.push(text('YES'));
  assert.equal((await m.api('/api/memory-tidy/run', 'POST', {})).status, 200);
  const demo = await rig(t, 'demo');
  assert.equal((await demo.api('/api/memory-tidy')).status, 403);
  assert.equal((await demo.api('/api/memory-tidy/run', 'POST', {})).status, 403);
});

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('memory tidy ui: the Memory page section and the morning card', () => {
  const html = web('index.html');
  const js = web('memory-tidy.js');
  const app = web('app.js');
  assert.match(html, /<h3 id="mt-h">Overnight tidy <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/h3>/);
  assert.match(html, /<label class="row"><input id="mt-on" type="checkbox"> Tidy her memory at night <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/label>/);
  assert.match(html, /<select id="mt-model">/);
  assert.doesNotMatch(js, /style=|\.style\./);
  for (const m of js.matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) assert.ok(m[1].length <= 260, m[1]);
  assert.match(js, /\/undo`/);
  for (const a of ['newer', 'older', 'both']) assert.match(js, new RegExp(`/${a}\``));
  assert.match(app, /m\.kind === 'tidy'\) \{\s*\/\/[^\n]*\n\s*els\.push\(memoryTidyNotice\(m\)\)/);
  assert.match(app, /void loadMemoryTidy\(\)/);
});
