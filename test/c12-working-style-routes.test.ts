// C12: the "How she works with you" routes (the owner, or a household member in their own space;
// never the demo) and the Memory page section (tips, no inline styles, Confirm / Not true / Forget).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { WorkingStyle } from '../src/working-style.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-05T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  if (mode !== 'demo') app.workingStyle = new WorkingStyle(app, app.store.db);
  for (const line of ['Too long.', 'Too long.']) {
    const conv = app.store.createConversation();
    app.workingStyle?.learnFrom(conv, app.store.addMessage(conv.id, 'user', line), {});
  }
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
  return { app, api };
}

test('C12 routes: list with evidence counts and confidence, Confirm, Not true, Forget, the switch', async (t) => {
  const { api } = await rig(t);
  const got = await api('/api/working-style');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.settings, { on: true });
  assert.equal(got.body.pinned, false);
  const [b] = got.body.beliefs;
  assert.equal(b.trait, 'reply-length');
  assert.equal(b.value, 'short');
  assert.equal(b.status, 'held');
  assert.equal(b.evidenceFor, 2);
  assert.equal(typeof b.confidence, 'number');
  assert.equal('content' in b || 'quote' in b, false, 'no copied text');
  assert.equal((await api(`/api/working-style/${b.id}/confirm`, 'POST', {})).body.belief.status, 'confirmed');
  assert.equal((await api(`/api/working-style/${b.id}/deny`, 'POST', {})).body.belief.status, 'retired');
  assert.equal((await api(`/api/working-style/${b.id}`, 'DELETE')).status, 200);
  assert.equal((await api('/api/working-style')).body.beliefs.length, 0);
  assert.equal((await api('/api/working-style/999/confirm', 'POST', {})).status, 404);
  assert.equal((await api('/api/working-style', 'PUT', { on: false })).body.settings.on, false);
});

test('C12 routes: a household member has their own; the demo gets 403', async (t) => {
  const member = await rig(t, 'member');
  const got = await member.api('/api/working-style');
  assert.equal(got.status, 200);
  assert.equal(got.body.beliefs.length, 1);
  const demo = await rig(t, 'demo');
  assert.equal((await demo.api('/api/working-style')).status, 403);
});

test('C12 web: Memory page section with tips, its script and the policy pin row', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const at = html.indexOf('id="ws-h"');
  assert.ok(at > html.indexOf('id="mt-h"'), 'after Overnight tidy on the Memory page');
  const sec = html.slice(at, html.indexOf('<h3>Settings</h3>', at));
  assert.match(sec, /How she works with you/);
  assert.match(sec, /id="ws-on"/);
  assert.match(sec, /id="ws-list"/);
  assert.ok((sec.match(/class="tip"/g) ?? []).length >= 2);
  for (const tip of sec.matchAll(/data-tip="([^"]*)"/g)) assert.ok(tip[1].length <= 260, tip[1]);
  assert.doesNotMatch(sec, /style=/);
  assert.match(html, /id="po-workstyle"/);
  const js = readFileSync(join(ROOT, 'web', 'working-style.js'), 'utf8');
  for (const s of ["t('Confirm')", "t('Not true')", "t('Forget')"]) assert.ok(js.includes(s), s);
  assert.doesNotMatch(js, /style=|\.style\./);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /from '\.\/working-style\.js'/);
  assert.match(app, /loadWorkingStyle\(\)/);
});
