// R9 "Polish for everyone": offline improvements (docs/OFFLINE.md). Today's snapshot and the lists
// are kept on the device (encrypted like the chats); in shopping mode a list is ticked off offline,
// each change waits in the outbox and syncs item by item when the connection is back, last writer
// wins (a newer change from another device stays, with a note); an added item is never added twice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { boardFor } from '../src/board.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
// @ts-expect-error plain browser module
import { planListChange, slimBoard, withPending } from '../web/offline-lists.js';
// @ts-expect-error plain browser module
import { memoryKV, openOfflineCopy } from '../web/offline-store.js';
// @ts-expect-error plain browser module
import { flushOutbox } from '../web/offline-sync.js';

const VIEW = {
  board: { id: 3, name: 'Groceries' },
  columns: [{ id: 10, role: 'todo' }, { id: 11, role: 'done' }],
  cards: [
    { id: 1, title: 'Milk', columnId: 10, updatedAt: '2026-11-15T10:00:00.000Z' },
    { id: 2, title: 'Eggs', columnId: 11, updatedAt: '2026-11-15T10:00:00.000Z' },
    { id: 3, title: 'Bread', columnId: 10, updatedAt: '2026-11-15T12:30:00.000Z' },
  ],
};

test('R9.O1 a board becomes a slim list; waiting changes show on top', () => {
  const l = slimBoard(VIEW);
  assert.deepEqual(l.items.map((i: { title: string; done: boolean }) => [i.title, i.done]), [['Milk', false], ['Eggs', true], ['Bread', false]]);
  assert.equal(l.doneCol, 11);
  const shown = withPending(l, [{ kind: 'list', op: 'tick', boardId: '3', ref: '1', done: true }, { kind: 'list', op: 'add', boardId: '3', text: 'Apples', id: 'ob-1' }]);
  assert.equal(shown.items[0].done, true);
  assert.equal(shown.items[0].pending, true);
  assert.equal(shown.items.at(-1).title, 'Apples');
});

test('R9.O2 last writer wins per item', () => {
  const tick = (ref: string, done: boolean, writtenAt: string) => ({ kind: 'list', op: 'tick', ref, done, writtenAt });
  assert.deepEqual(planListChange(VIEW, tick('1', true, '2026-11-15T11:00:00.000Z')), { action: 'move', ref: '1', columnId: 11 });
  // Bread changed on another device at 12:30, after this device's 12:00 tick: the newer one stays.
  assert.equal(planListChange(VIEW, tick('3', true, '2026-11-15T12:00:00.000Z')).why, 'newer');
  assert.equal(planListChange(VIEW, tick('2', true, '2026-11-15T12:00:00.000Z')).why, 'same');
  assert.equal(planListChange(VIEW, tick('9', true, '2026-11-15T12:00:00.000Z')).why, 'gone');
  assert.deepEqual(planListChange(VIEW, { kind: 'list', op: 'add', text: 'Apples' }), { action: 'add', title: 'Apples', columnId: 10 });
  assert.equal(planListChange(VIEW, { kind: 'list', op: 'add', text: ' milk ' }).why, 'duplicate');
});

test('R9.O3 Today and lists are kept encrypted, and go with the copy', async () => {
  const kv = memoryKV();
  const copy = await openOfflineCopy(kv);
  await copy.saveToday({ greeting: 'Good morning, Alex', tiles: [{ title: 'Your day', lines: ['9:00 Dentist on Elm St'] }] });
  await copy.saveLists([slimBoard(VIEW)]);
  assert.equal((await copy.today()).tiles[0].lines[0], '9:00 Dentist on Elm St');
  assert.equal((await copy.lists())[0].name, 'Groceries');
  const raw = JSON.stringify([...(await kv.all('copy'))].map(([, v]: [string, { data?: ArrayBuffer }]) => (v?.data ? Buffer.from(v.data as ArrayBuffer).toString('latin1') : v)));
  assert.ok(!raw.includes('Dentist') && !raw.includes('Groceries'), 'nothing readable on disk');
  await copy.wipe();
  assert.equal(await copy.today(), undefined);
  assert.deepEqual(await copy.lists(), []);
});

test('R9.O4 the shell caches the lists file; the view has shopping mode and "will send when online"', () => {
  const sw = readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8');
  assert.match(sw, /'\/offline-lists\.js'/);
  const view = readFileSync(join(ROOT, 'web', 'offline-view.js'), 'utf8');
  for (const w of ['Shopping mode', 'Will sync when online', 'Will send when online', "Today, as it was at {time}"]) assert.ok(view.includes(w), w);
  const hook = readFileSync(join(ROOT, 'web', 'offline-hook.js'), 'utf8');
  assert.match(hook, /saveToday/);
  assert.match(hook, /saveLists/);
  assert.match(hook, /the newer change was kept/);
});

// ---------------- a real server: ticked offline, synced when back ----------------

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-15T10:00:00Z') };
const app = makeApp(dir, clock);
app.board = boardFor(app.planner!);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ disclosureAcceptedAt: '2026-10-24T00:00:00Z', timeZone: 'America/Chicago' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const get = (path: string) => fetch(base + path, { headers });
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

test('R9.O5 shopping mode offline: ticks and an added item sync; a newer change elsewhere stays', async () => {
  const made = await post('/api/boards', { name: 'Groceries' });
  const mb = (await made.json()) as { id?: number; board?: { id: number } };
  assert.equal(made.status, 201, JSON.stringify(mb));
  const b = { id: mb.board?.id ?? mb.id };
  for (const title of ['Milk', 'Bread', 'Coffee']) assert.equal((await post(`/api/boards/${b.id}/cards`, { title })).status, 201);
  const kept = slimBoard(await (await get(`/api/boards/${b.id}`)).json());
  assert.equal(kept.items.length, 3);
  const copy = await openOfflineCopy(memoryKV(), { now: () => clock.now });
  await copy.saveLists([kept]);
  const ref = (t: string) => kept.items.find((i: { title: string }) => i.title === t).ref;
  // Offline at 10:05: Milk and Bread ticked, Apples added, Coffee added again (already there).
  clock.now = new Date('2026-11-15T10:05:00Z');
  await copy.queue({ kind: 'list', op: 'tick', boardId: String(b.id), ref: ref('Milk'), done: true, text: 'Milk' });
  await copy.queue({ kind: 'list', op: 'tick', boardId: String(b.id), ref: ref('Bread'), done: true, text: 'Bread' });
  await copy.queue({ kind: 'list', op: 'add', boardId: String(b.id), text: 'Apples' });
  await copy.queue({ kind: 'list', op: 'add', boardId: String(b.id), text: 'coffee' });
  // Meanwhile (10:10) someone renamed Bread on another device: that change is newer than the tick.
  clock.now = new Date('2026-11-15T10:10:00Z');
  assert.equal((await post(`/api/tasks/${ref('Bread')}/card`, { title: 'Bread (rye)' })).status, 200);
  const r = await flushOutbox(copy, { post, get });
  assert.equal(r.refused, 0);
  assert.equal(r.lists, 4);
  assert.deepEqual(r.kept.map((k: { why: string }) => k.why).sort(), ['duplicate', 'newer']);
  assert.deepEqual(await copy.outbox(), []);
  const now = slimBoard(await (await get(`/api/boards/${b.id}`)).json());
  const state = Object.fromEntries(now.items.map((i: { title: string; done: boolean }) => [i.title, i.done]));
  assert.deepEqual(state, { Milk: true, 'Bread (rye)': false, Coffee: false, Apples: false });
  // Sent again (a second tab, a retry): nothing changes twice.
  await copy.queue({ kind: 'list', op: 'add', boardId: String(b.id), text: 'Apples' });
  await flushOutbox(copy, { post, get });
  assert.equal(slimBoard(await (await get(`/api/boards/${b.id}`)).json()).items.filter((i: { title: string }) => i.title === 'Apples').length, 1);
});
