// Feature 4 (works offline): the device's encrypted copy (web/offline-store.js), the outbox and its
// sending (web/offline-sync.js), against a real server for "a reconnect never sends twice".
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';
// @ts-expect-error plain browser module
import { LIMITS, keepable, memoryKV, openOfflineCopy } from '../web/offline-store.js';
// @ts-expect-error plain browser module
import { flushOutbox, keepByDefault, keepChoice, watchConnection } from '../web/offline-sync.js';

type Msg = { id: number; role: string; content: string; createdAt: string };
const conv = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, title: `Chat ${id}`, updatedAt: at, ...extra });
const msgs = (n: number, from = 1): Msg[] => Array.from({ length: n }, (_, i) => ({ id: from + i, role: i % 2 ? 'assistant' : 'user', content: `line ${from + i}`, createdAt: '2026-11-11T10:00:00Z' }));

test('the copy is sealed: nothing readable is stored, and another key cannot open it', async () => {
  const kv = memoryKV();
  const copy = await openOfflineCopy(kv);
  await copy.signedIn({ serverId: 's1', space: 'owner' });
  await copy.saveChat(conv('a', '2026-11-11T10:00:00Z'), [{ id: 1, role: 'user', content: 'my blood pressure is 120/80', createdAt: 'x' }]);
  await copy.saveNotes([{ id: 1, title: 'Medical', body: 'allergic to penicillin' }]);
  const raw = JSON.stringify(await kv.all('copy'), (_k, v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : v));
  for (const secret of ['120/80', 'penicillin', 'Medical']) assert.ok(!raw.includes(secret), `"${secret}" is readable in storage`);
  assert.equal((await copy.chat('a')).messages[0].content, 'my blood pressure is 120/80');
  // The key is the browser's and can't be taken out of it.
  const key = await kv.get('copy', 'key');
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
});

test('one person per device: another member or another server deletes the earlier copy and outbox', async () => {
  const kv = memoryKV();
  const copy = await openOfflineCopy(kv);
  assert.equal(await copy.signedIn({ serverId: 's1', space: 'owner' }), false);
  await copy.saveList([conv('a', '2026-11-11T10:00:00Z')]);
  await copy.saveChat(conv('a', '2026-11-11T10:00:00Z'), msgs(4));
  await copy.queue({ kind: 'chat', conversationId: 'a', text: 'owner only' });
  // The same person again: kept.
  assert.equal(await copy.signedIn({ serverId: 's1', space: 'owner' }), false);
  assert.equal((await copy.list()).length, 1);
  // A household member signs in on this browser: the owner's copy goes first.
  assert.equal(await copy.signedIn({ serverId: 's1', space: 'm-123' }), true);
  assert.deepEqual(await copy.list(), []);
  assert.equal(await copy.chat('a'), undefined);
  assert.deepEqual(await copy.outbox(), []);
  // The copy still works for the new person.
  await copy.saveList([conv('b', '2026-11-11T10:00:00Z')]);
  assert.equal((await copy.list())[0].id, 'b');
  // A fresh server at the same address.
  assert.equal(await copy.signedIn({ serverId: 's2', space: 'm-123' }), true);
  assert.deepEqual(await copy.list(), []);
});

test('which chats are kept: never off the record, private only when allowed, the newest 30, 200 messages each', async () => {
  assert.equal(keepable({ id: 'x', offRecord: true }, { allowPrivate: true }), false);
  assert.equal(keepable({ id: 'x', private: true }), false);
  assert.equal(keepable({ id: 'x', private: true }, { allowPrivate: true }), true);
  assert.equal(keepable({ id: 'x', channel: 'import-chatgpt' }), false);
  const copy = await openOfflineCopy(memoryKV());
  await copy.signedIn({ serverId: 's', space: 'owner' });
  const many = Array.from({ length: 40 }, (_, i) => conv(`c${i}`, `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`));
  many.push(conv('secret', '2026-11-30T00:00:00Z', { private: true }), conv('otr', '2026-11-30T00:00:00Z', { offRecord: true }));
  const list = await copy.saveList(many);
  assert.equal(list.length, LIMITS.chats);
  assert.ok(!list.some((c: { id: string }) => c.id === 'secret' || c.id === 'otr'));
  assert.deepEqual(list.map((c: { updatedAt: string }) => c.updatedAt), [...list.map((c: { updatedAt: string }) => c.updatedAt)].sort().reverse());
  // Private chats when allowed; and when it's turned off again, their messages go.
  await copy.saveList(many, { allowPrivate: true });
  await copy.saveChat(conv('secret', '2026-11-30T00:00:00Z', { private: true }), msgs(2), { allowPrivate: true });
  assert.ok(await copy.chat('secret'));
  await copy.saveList(many);
  assert.equal(await copy.chat('secret'), undefined);
  await copy.saveChat(conv('secret', '2026-11-30T00:00:00Z', { private: true }), msgs(2));
  assert.equal(await copy.chat('secret'), undefined);
  // Pages merge, the newest 200 stay, tool output isn't kept.
  const id = list[0].id;
  await copy.saveChat(conv(id, 'x'), [...msgs(150, 101), { id: 251, role: 'tool', content: 'ls output', createdAt: 'x' }]);
  await copy.saveChat(conv(id, 'x'), msgs(150, 1), { latest: false }); // scrolled up: an earlier page
  let kept = (await copy.chat(id)).messages;
  assert.equal(kept.length, LIMITS.messages);
  assert.equal(kept[0].id, 51);
  assert.equal(kept.at(-1).id, 250);
  // The newest page again, after the last reply was regenerated (250 is gone, 252 is new).
  await copy.saveChat(conv(id, 'x'), [...msgs(149, 101), { id: 252, role: 'assistant', content: 'again', createdAt: 'x' }]);
  kept = (await copy.chat(id)).messages;
  assert.deepEqual(kept.slice(-2).map((m: Msg) => m.id), [249, 252]);
  assert.ok(!kept.some((m: Msg) => m.role === 'tool'));
});

test('the outbox: in order, edited with a fresh key, deleted; a maybe-sent item cannot be edited', async () => {
  let t = Date.parse('2026-11-11T16:42:00Z');
  const copy = await openOfflineCopy(memoryKV(), { now: () => new Date(t++) });
  const a = await copy.queue({ kind: 'chat', conversationId: 'c1', text: ' first ' });
  const b = await copy.queue({ kind: 'chat', conversationId: 'c1', text: 'second' });
  const n = await copy.queue({ kind: 'note', noteId: 4, title: 'Groceries', text: 'oat milk' });
  assert.equal(a.text, 'first');
  assert.deepEqual((await copy.outbox()).map((x: { id: string }) => x.id), [a.id, b.id, n.id]);
  assert.match(a.key, /^[A-Za-z0-9_-]{8,80}$/);
  const e = await copy.edit(b.id, 'second, edited');
  assert.equal(e.text, 'second, edited');
  assert.notEqual(e.key, b.key);
  assert.match(e.key, /^[A-Za-z0-9_-]{8,80}$/);
  await copy.remove(a.id);
  assert.deepEqual((await copy.outbox()).map((x: { text: string }) => x.text), ['second, edited', 'oat milk']);
  await copy.mark(n.id, { tried: true });
  assert.equal(await copy.edit(n.id, 'changed'), null);
  await assert.rejects(copy.queue({ kind: 'chat', conversationId: 'c1', text: '   ' }));
});

test('sending the outbox: stops in order when there is no connection, keeps refused text', async () => {
  const copy = await openOfflineCopy(memoryKV());
  await copy.queue({ kind: 'chat', conversationId: 'c1', text: 'one' });
  await copy.queue({ kind: 'chat', conversationId: 'c1', text: 'two' });
  await copy.queue({ kind: 'note', title: 'N', text: 'three' });
  const sentPaths: string[] = [];
  // No connection at all.
  let r = await flushOutbox(copy, { post: async () => Promise.reject(new TypeError('Failed to fetch')) });
  assert.deepEqual(r, { sent: 0, notes: 0, refused: 0, waiting: 3, stopped: true });
  assert.equal((await copy.outbox()).length, 3);
  // She's busy in that chat: the first waits, so the second waits too (order).
  r = await flushOutbox(copy, { post: async () => new Response('{}', { status: 409 }) });
  assert.equal(r.sent, 0);
  assert.equal((await copy.outbox())[0].tried, false, 'a 409 was not stored: it can still be edited');
  // The first goes, the note is refused (kept, with the reason), the second goes.
  r = await flushOutbox(copy, {
    post: async (path: string, body: { content?: string }) => {
      sentPaths.push(`${path} ${body.content ?? ''}`);
      return path.includes('notes') ? new Response(JSON.stringify({ error: 'Note #9 is full' }), { status: 400 }) : new Response('event: done\n\n', { status: 200 });
    },
  });
  assert.deepEqual(r, { sent: 2, notes: 0, refused: 1, waiting: 0, stopped: false });
  assert.deepEqual(sentPaths, ['/api/conversations/c1/messages one', '/api/conversations/c1/messages two', '/api/notes/add ']);
  const left = await copy.outbox();
  assert.equal(left.length, 1);
  assert.equal(left[0].state, 'refused');
  assert.equal(left[0].error, 'Note #9 is full');
  assert.equal(left[0].text, 'three');
});

test('keep a copy by default in Sara apps and installed web apps, not in a plain browser tab', () => {
  assert.equal(keepByDefault({ ua: 'Mozilla/5.0 … Edg/130 SaraDesktop/3.4.5 (Windows)' }), true);
  assert.equal(keepByDefault({ ua: 'Mozilla/5.0 (Linux; Android 15) SaraPhone/2.1' }), true);
  assert.equal(keepByDefault({ ua: 'Mozilla/5.0 Chrome/130', standalone: true }), true);
  assert.equal(keepByDefault({ ua: 'Mozilla/5.0 Chrome/130' }), false);
  const store = new Map<string, string>();
  const ls = { getItem: (k: string) => store.get(k) ?? null };
  assert.equal(keepChoice(ls, { ua: 'Chrome' }), false);
  store.set('sara.offline.keep', '1');
  assert.equal(keepChoice(ls, { ua: 'Chrome' }), true);
  store.set('sara.offline.keep', '0');
  assert.equal(keepChoice(ls, { ua: 'SaraDesktop/1' }), false);
});

test('the connection watch: two misses mean offline, one good check means back', async () => {
  const timers = { q: [] as (() => void)[], setTimeout(fn: () => void) { this.q.push(fn); return this.q.length; }, clearTimeout() { this.q = []; } };
  const events: Record<string, () => void> = {};
  const win = { addEventListener: (n: string, f: () => void) => (events[n] = f), removeEventListener: () => {} };
  let up = true;
  const changes: boolean[] = [];
  const w = watchConnection({ check: async () => up, onChange: (on: boolean) => changes.push(on), win, timers });
  const tick = async () => {
    const fn = timers.q.pop();
    timers.q = [];
    await fn?.();
  };
  await tick();
  assert.equal(w.online, true);
  up = false;
  await tick();
  assert.deepEqual(changes, [], 'one miss is not offline yet');
  await tick();
  assert.deepEqual(changes, [false]);
  // The browser saying it's offline counts as one miss: one more failed check is enough.
  up = true;
  await tick();
  assert.deepEqual(changes, [false, true]);
  up = false;
  events.offline();
  await tick();
  assert.deepEqual(changes, [false, true, false]);
  await tick();
  up = true;
  events.online();
  await tick();
  assert.deepEqual(changes, [false, true, false, true]);
  w.stop();
});

// ---------- against a real server: a reconnect never sends twice ----------
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-11T16:42:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ disclosureAcceptedAt: '2026-10-24T00:00:00Z', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('real server: the answer is lost on the way back, the next flush finds it there (stored once)', async () => {
  const c = app.store.createConversation({ title: 'Trip' });
  const copy = await openOfflineCopy(memoryKV());
  await copy.queue({ kind: 'chat', conversationId: c.id, text: 'Book the train for Friday' });
  await copy.queue({ kind: 'chat', conversationId: c.id, text: 'And a seat by the window' });
  app.script.push(text('Booked.'), text('Window seat noted.'));
  // The first send reaches the server, but the connection drops before the answer comes back.
  let cut = true;
  const r1 = await flushOutbox(copy, {
    post: async (path: string, body: unknown) => {
      const res = await post(path, body);
      if (cut) {
        cut = false;
        await res.text();
        throw new TypeError('network changed');
      }
      return res;
    },
  });
  assert.equal(r1.sent, 0);
  assert.equal(r1.stopped, true);
  assert.equal(app.store.messages(c.id).filter((m) => m.role === 'user').length, 1, 'it did arrive');
  // Back online: both "sent", the first as a duplicate; the server has each exactly once, in order.
  const r2 = await flushOutbox(copy, { post });
  assert.equal(r2.sent, 2);
  assert.deepEqual(await copy.outbox(), []);
  assert.deepEqual(app.store.messages(c.id).filter((m) => m.role === 'user').map((m) => m.content), ['Book the train for Friday', 'And a seat by the window']);
  assert.deepEqual(app.store.messages(c.id).filter((m) => m.role === 'assistant').map((m) => m.content), ['Booked.', 'Window seat noted.']);
});
