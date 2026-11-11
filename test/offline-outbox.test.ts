// Feature 4 (works offline): what a device wrote while it couldn't reach the server is sent later
// from its outbox. Each item carries its own key (`clientKey`), so a reconnect, a retry after a cut
// connection or two tabs sending the same outbox never store it twice.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cleanClientKey } from '../src/offline-keys.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-11T16:42:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ disclosureAcceptedAt: '2026-10-24T00:00:00Z', timeZone: 'America/Chicago', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, body?: unknown) =>
  fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const users = (id: string) => app.store.messages(id).filter((m) => m.role === 'user');

test('client keys: letters, digits, - and _ only, 8-80 long; anything else is refused', () => {
  assert.equal(cleanClientKey(undefined), undefined);
  assert.equal(cleanClientKey('ob-1731343320000-a1b2c3'), 'ob-1731343320000-a1b2c3');
  for (const bad of ['short', 'has space in it', 'x'.repeat(81), 12345678, '<script>alert(1)</script>']) assert.throws(() => cleanClientKey(bad), /key/i);
});

test('a message sent twice with the same key is stored and answered once', async () => {
  const conv = app.store.createConversation({ title: 'Chat' });
  app.script.push(text('Got it, milk it is.'));
  const r1 = await call(`/api/conversations/${conv.id}/messages`, { content: 'Pick up milk', clientKey: 'ob-key-0001' });
  assert.equal(r1.status, 200);
  await r1.text(); // the streamed turn
  const stored = users(conv.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].meta?.clientKey, 'ob-key-0001');
  // The reconnect sends it again (the first answer was cut off on the way back): nothing new.
  const r2 = await call(`/api/conversations/${conv.id}/messages`, { content: 'Pick up milk', clientKey: 'ob-key-0001' });
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { duplicate: true, messageId: stored[0].id });
  assert.equal(users(conv.id).length, 1);
  assert.equal(app.store.messages(conv.id).filter((m) => m.role === 'assistant').length, 1);
  // A new key is a new message.
  app.script.push(text('And eggs.'));
  const r3 = await call(`/api/conversations/${conv.id}/messages`, { content: 'Eggs too', clientKey: 'ob-key-0002' });
  await r3.text();
  assert.deepEqual(users(conv.id).map((m) => m.content), ['Pick up milk', 'Eggs too']);
  // A key from another chat doesn't count here.
  const other = app.store.createConversation({ title: 'Other' });
  app.script.push(text('Sure.'));
  await (await call(`/api/conversations/${other.id}/messages`, { content: 'Pick up milk', clientKey: 'ob-key-0001' })).text();
  assert.equal(users(other.id).length, 1);
});

test('the same key twice at the same moment: one runs, the other is told it is already being sent', async () => {
  const conv = app.store.createConversation({ title: 'Race' });
  app.script.push(text('One answer.'));
  const [a, b] = await Promise.all([
    call(`/api/conversations/${conv.id}/messages`, { content: 'Hello', clientKey: 'ob-race-001' }),
    call(`/api/conversations/${conv.id}/messages`, { content: 'Hello', clientKey: 'ob-race-001' }),
  ]);
  const statuses = [a.status, b.status].sort();
  await Promise.all([a.text(), b.text()]);
  // 200 (sent or duplicate) and 200/409 (still sending): never two stored messages.
  assert.ok(statuses.every((s) => s === 200 || s === 409), String(statuses));
  assert.equal(users(conv.id).length, 1);
});

test('a background send with a key: 202 once, then a duplicate', async () => {
  const conv = app.store.createConversation({ title: 'Bg' });
  app.script.push(text('Later.'));
  const r1 = await call(`/api/conversations/${conv.id}/messages`, { content: 'From the outbox', clientKey: 'ob-bg-0001', background: true });
  assert.equal(r1.status, 202);
  for (let i = 0; i < 50 && !app.store.messages(conv.id).some((m) => m.role === 'assistant'); i++) await new Promise((res) => setTimeout(res, 20));
  const r2 = await call(`/api/conversations/${conv.id}/messages`, { content: 'From the outbox', clientKey: 'ob-bg-0001', background: true });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).duplicate, true);
  assert.equal(users(conv.id).length, 1);
});

test('notes written offline are added to the end (never overwrite), once per key', async () => {
  const pl = app.planner!;
  const note = pl.saveNote({ title: 'Blood pressure', body: '— 2026-11-01 09:00\n120/80' });
  // Meanwhile someone changed the note on the server: the offline add keeps both texts.
  pl.saveNote({ id: note.id, title: 'Blood pressure', body: '— 2026-11-01 09:00\n120/80\n\n— 2026-11-10 08:00\n118/79' });
  const add = { id: note.id, text: '125/82 after the walk', clientKey: 'ob-note-001', writtenAt: '2026-11-11T16:30:00Z' };
  const r1 = await call('/api/notes/add', add);
  assert.equal(r1.status, 200);
  const n1 = await r1.json();
  assert.equal(n1.id, note.id);
  assert.match(n1.body, /^— 2026-11-01 09:00\n120\/80\n\n— 2026-11-10 08:00\n118\/79\n\n— 2026-11-11 10:30 \(written offline\)\n125\/82 after the walk$/);
  const r2 = await call('/api/notes/add', add);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).body, n1.body, 'the second send adds nothing');
  // A note deleted meanwhile: the text becomes a new note with that title (nothing lost).
  pl.deleteNote(note.id);
  const r3 = await call('/api/notes/add', { id: note.id, title: 'Blood pressure', text: '130/85', clientKey: 'ob-note-002' });
  assert.equal(r3.status, 200);
  const n3 = await r3.json();
  assert.notEqual(n3.id, note.id);
  assert.match(n3.body, /130\/85$/);
  // A new note written offline.
  const r4 = await call('/api/notes/add', { title: 'Packing list', text: 'Charger', clientKey: 'ob-note-003' });
  assert.equal((await r4.json()).title, 'Packing list');
  // Bad input.
  assert.equal((await call('/api/notes/add', { title: 'x', text: '  ', clientKey: 'ob-note-004' })).status, 400);
  assert.equal((await call('/api/notes/add', { text: 'no title or id', clientKey: 'ob-note-005' })).status, 400);
});

test('the session says which household member is signed in (the offline copy is kept per person)', async () => {
  const s = await (await call('/api/session')).json();
  assert.equal(s.role, 'owner');
  assert.equal(typeof s.serverId, 'string');
  assert.ok(s.serverId.length >= 8);
});
