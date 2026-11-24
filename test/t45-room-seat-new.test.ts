// C26: `/new` in a room linked to a shared scene keeps the room's seat, and the chat app's on/off
// switch is checked on every room turn, not only when the room was linked. Real runTurn with the
// scripted model, invented people, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextSession } from '../src/bridges/commands.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { RunStore } from '../src/runs.ts';
import { createScene, getScene, linkSeat, sceneSeatFor, setCanon, SHARED_SCENE_MARK } from '../src/shared-scenes-policy.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const NOW = '2026-11-24T15:00:00.000Z';

function fixture() {
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false }, chats: { continuity: { enabled: false } }, discord: { enabled: true } } as never);
  app.runs = new RunStore(app.store.db, () => clock.now);
  const web = app.store.createConversation({ title: 'Web story' });
  noteRoom(app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: 'tavern', parentTitle: 'Moonlight Guild', adult: false });
  const room = app.store.createConversation({ channel: 'discord', channelKey: 'tavern-1', partner: 'people in a Discord channel', title: 'Discord: #tavern · Moonlight Guild' });
  const roomId = (app.store.db.prepare("SELECT id FROM rooms WHERE key='tavern-1'").get() as { id: number }).id;
  const scene = createScene(app, { title: 'The Ember Road', premise: 'A caravan crosses the dunes.' });
  const rev = () => getScene(app, scene.id).scene.revision;
  linkSeat(app, scene.id, { conversationId: web.id, expectedRevision: rev(), confirmAudience: true });
  linkSeat(app, scene.id, { conversationId: room.id, expectedRevision: rev(), confirmAudience: true, confirmRoomId: roomId });
  setCanon(app, scene.id, { expectedRevision: rev(), key: 'inn', text: 'The Ember Inn burned down last night.' });
  const seats = () => getScene(app, scene.id).seats.map((s) => s.conversationId);
  /** One room turn; returns the shared-scene blocks its model request carried. */
  const roomTurn = async (conversationId: string, line: string) => {
    const before = app.requests.length;
    app.script.push(text('Welcome, travellers.'));
    const events: ChatEvent[] = [];
    for await (const e of runTurn(app, conversationId, line, undefined, { roomId, roomNow: 'Priya speaks.' } as never)) events.push(e);
    assert.equal(app.requests.length, before + 1, 'one model call');
    return app.requests[before].messages.filter((m) => m.role === 'system' && String(m.content).startsWith(SHARED_SCENE_MARK)).map((m) => String(m.content));
  };
  return { app, web, room, roomId, scene, rev, seats, roomTurn, close() { app.store.close(); temp.cleanup(); } };
}

test('C26: /new in a linked room keeps the seat: the new session is the seat and gets the canon', async () => {
  const f = fixture();
  try {
    assert.equal((await f.roomTurn(f.room.id, '[Priya]: Is the inn open?')).length, 1);
    const before = f.rev();
    const next = nextSession(f.app, f.app.store.getConversation(f.room.id)!);
    assert.ok(f.app.store.getConversation(f.room.id)!.endedAt, 'the old session is closed');
    assert.deepEqual(f.seats().sort(), [f.web.id, next.id].sort(), 'the room seat moved to the new session');
    assert.ok(f.rev() > before, 'the scene revision moved, so an open scene card reloads');
    assert.equal(getScene(f.app, f.scene.id).events[0].kind, 'moved');
    const blocks = await f.roomTurn(next.id, '[Priya]: And now?');
    assert.equal(blocks.length, 1, 'the new session still plays the scene');
    assert.match(blocks[0], /Ember Inn burned down/);
    // A second /new carries it again.
    const third = nextSession(f.app, f.app.store.getConversation(next.id)!);
    assert.ok(f.seats().includes(third.id));
    assert.equal(sceneSeatFor(f.app, f.app.store.getConversation(f.room.id)!), undefined, 'the closed session is no seat');
  } finally { f.close(); }
});

test('C26: canon picked from a line of the closed session is erased as before; typed canon and the seat stay', async () => {
  const f = fixture();
  try {
    await f.roomTurn(f.room.id, '[Priya]: The bridge is out.');
    const line = f.app.store.messages(f.room.id).find((m) => m.role === 'assistant')!;
    setCanon(f.app, f.scene.id, { expectedRevision: f.rev(), key: 'greeting', fromMessageId: line.id });
    assert.deepEqual(getScene(f.app, f.scene.id).canon.map((c) => c.key).sort(), ['greeting', 'inn']);
    const next = nextSession(f.app, f.app.store.getConversation(f.room.id)!);
    assert.deepEqual(getScene(f.app, f.scene.id).canon.map((c) => c.key), ['inn']);
    assert.ok(f.seats().includes(next.id));
  } finally { f.close(); }
});

test('C26: an owner seat is not carried by /new, and a room that stopped being eligible is not either', () => {
  const f = fixture();
  try {
    const tg = f.app.store.createConversation({ channel: 'telegram', channelKey: '4242', title: 'Telegram' });
    linkSeat(f.app, f.scene.id, { conversationId: tg.id, expectedRevision: f.rev(), confirmAudience: true });
    const nextOwner = nextSession(f.app, f.app.store.getConversation(tg.id)!);
    assert.ok(!f.seats().includes(tg.id) && !f.seats().includes(nextOwner.id), 'an owner seat still ends with its session');
    // The room became an adult room after linking: the old trigger revokes the seat; /new does not bring it back.
    f.app.store.db.prepare("UPDATE rooms SET adult=1 WHERE key='tavern-1'").run();
    const next = nextSession(f.app, f.app.store.getConversation(f.room.id)!);
    assert.ok(!f.seats().includes(next.id) && !f.seats().includes(f.room.id));
  } finally { f.close(); }
});

test('C26: the chat app switched off after linking: no scene in room turns, the seat stays, on again brings it back', async () => {
  const f = fixture();
  try {
    assert.equal((await f.roomTurn(f.room.id, '[Priya]: Hello?')).length, 1);
    f.app.settings.update({ discord: { enabled: false } } as never);
    assert.equal(sceneSeatFor(f.app, f.app.store.getConversation(f.room.id)!), undefined);
    assert.equal((await f.roomTurn(f.room.id, '[Priya]: Still there?')).length, 0, 'nothing of the scene reaches a room whose app is off');
    assert.ok(f.seats().includes(f.room.id), 'the room stays linked');
    assert.ok(sceneSeatFor(f.app, f.app.store.getConversation(f.web.id)!), 'the owner seat is not affected');
    f.app.settings.update({ discord: { enabled: true } } as never);
    assert.equal((await f.roomTurn(f.room.id, '[Priya]: Back?')).length, 1);
  } finally { f.close(); }
});
