// R1B3 routes: the room seat link (exact room confirmed), "Add to scene" from a guest line and the
// "In scene" chip on the owner's conversation view. Invented people; isolated data dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OwnerAuth } from '../src/auth.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function fixture() {
  const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-05T12:00:00Z') });
  app.settings.update({ ownerName: 'Alex', discord: { enabled: true } } as never);
  const web = app.store.createConversation({ title: 'Web story' });
  noteRoom(app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: 'tavern', parentTitle: 'Moonlight Guild' });
  const room = app.store.createConversation({ channel: 'discord', channelKey: 'tavern-1', partner: 'people in a Discord channel', title: 'Discord: #tavern · Moonlight Guild' });
  const auth = new OwnerAuth(temp.dir); const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(origin + '/api' + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  return { app, web, room, call, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); temp.cleanup(); } };
}

test('R1B3 routes: room option shows the exact audience; link needs confirmRoomId; Add to scene from a guest line; In scene chip', async () => {
  const f = await fixture();
  try {
    const created = await f.call('/scenes', 'POST', { title: 'The Ember Road' });
    const id = created.body.scene.id; let rev = created.body.scene.revision;
    const options = await f.call(`/scenes/${id}/seat-options`);
    const room = options.body.options.find((o: any) => o.conversationId === f.room.id);
    assert.ok(room, 'the room is offered');
    assert.equal(room.seatAudience, 'room');
    assert.equal(room.room.name, '#tavern · Moonlight Guild');
    assert.match(room.audience, /everyone who can read #tavern · Moonlight Guild on Discord/i);
    assert.equal((await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.room.id, expectedRevision: rev, confirmAudience: true })).status, 400);
    assert.equal((await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.room.id, expectedRevision: rev, confirmAudience: true, confirmRoomId: room.room.id, extra: 1 })).status, 400, 'strict body');
    const linked = await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.room.id, expectedRevision: rev, confirmAudience: true, confirmRoomId: room.room.id });
    assert.equal(linked.status, 200); rev = linked.body.scene.revision;
    assert.equal(linked.body.seat.audience, 'room');
    rev = (await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.web.id, expectedRevision: rev, confirmAudience: true })).body.scene.revision;
    const guest = f.app.store.addMessage(f.room.id, 'user', "[Priya]: Priya's ranger Ash joins the caravan.");
    const added = await f.call(`/scenes/${id}/canon`, 'POST', { expectedRevision: rev, key: 'ash', fromMessageId: guest.id });
    assert.equal(added.status, 200);
    assert.equal(added.body.entry.source.audience, 'room');
    const view = await f.call(`/conversations/${f.room.id}?limit=50`);
    assert.equal(view.status, 200);
    assert.deepEqual({ id: view.body.scene?.id, title: view.body.scene?.title, audience: view.body.scene?.audience }, { id, title: 'The Ember Road', audience: 'room' });
    assert.equal((await f.call(`/conversations/${f.web.id}?limit=50`)).body.scene.audience, 'owner');
    const other = f.app.store.createConversation({ title: 'Not linked' });
    assert.equal((await f.call(`/conversations/${other.id}?limit=50`)).body.scene, undefined);
  } finally { await f.close(); }
});
