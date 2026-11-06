// R1B3: room-seat turns through the real runTurn (FakeProvider, invented people, no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteRoom } from '../src/bridges/rooms.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { RunStore } from '../src/runs.ts';
import { CRISIS_SYSTEM_NOTE, MINOR_BLOCK_REPLY } from '../src/safety.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const policy = await import('../src/shared-scenes-policy.ts').catch(() => undefined);
const scenes = await import('../src/shared-scenes.ts').catch(() => undefined);
const NOW = '2026-11-05T15:00:00.000Z';
const P = () => policy as any;

function fixture(opts: { adult?: boolean } = {}) {
  assert.ok(policy?.createScene && scenes?.SharedSceneStore, 'shared scenes are missing');
  assert.equal(typeof (policy as any).roomSeatAllowed, 'function', 'R1B3 room seats are missing');
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW, memory: { enabled: false }, chats: { continuity: { enabled: false } }, discord: { enabled: true }, ...(opts.adult ? { adultMode: { on: true, confirmedAt: NOW } } : {}) } as never);
  app.runs = new RunStore(app.store.db, () => clock.now);
  const web = app.store.createConversation({ title: 'Web story' });
  const adult = Boolean(opts.adult);
  noteRoom(app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: adult ? 'after-dark' : 'tavern', parentTitle: 'Moonlight Guild', adult });
  const room = app.store.createConversation({ channel: adult ? 'discord-nsfw' : 'discord', channelKey: 'tavern-1', partner: 'people in a Discord channel', title: 'Discord: #tavern · Moonlight Guild' });
  const roomId = (app.store.db.prepare("SELECT id FROM rooms WHERE key='tavern-1'").get() as { id: number }).id;
  const scene = policy.createScene(app, { title: 'The Ember Road', premise: 'A caravan crosses the dunes.', ...(adult ? { adult: true } : {}) });
  const rev = () => policy!.getScene(app, scene.id).scene.revision;
  policy.linkSeat(app, scene.id, { conversationId: web.id, expectedRevision: rev(), confirmAudience: true });
  P().linkSeat(app, scene.id, { conversationId: room.id, expectedRevision: rev(), confirmAudience: true, confirmRoomId: roomId });
  const canon = (key: string, value: string) => policy!.setCanon(app, scene.id, { expectedRevision: rev(), key, text: value });
  canon('inn', 'The Ember Inn burned down last night.');
  return { app, clock, web, room, roomId, scene, rev, canon, close() { app.store.close(); temp.cleanup(); } };
}
type F = ReturnType<typeof fixture>;
async function collect(it: AsyncIterable<ChatEvent>) { const events: ChatEvent[] = []; for await (const e of it) events.push(e); return events; }
const blocks = (f: F, i = 0) => f.app.requests[i].messages.filter(m => m.role === 'system' && m.content.startsWith(policy!.SHARED_SCENE_MARK)).map(m => m.content);
const whole = (f: F, i = 0) => JSON.stringify(f.app.requests[i].messages);
const roomTurn = (f: F, line: string, extra: Record<string, unknown> = {}) => collect(runTurn(f.app, f.room.id, line, undefined, { roomId: f.roomId, ...extra } as never));

test('R1B3 a canon change in the owner web seat is seen by the room seat; the room request carries no owner lines, labels or tools', async () => {
  const f = fixture();
  try {
    f.app.script.push(text('The caravan turns north.'), text('Welcome, travellers.'));
    await collect(runTurn(f.app, f.web.id, 'My secret plan: betray the guild at dawn.', undefined, { noTools: true }));
    f.canon('caravan', 'The caravan now heads north to the salt flats.');
    await roomTurn(f, '[Priya]: Where is the caravan going?', { roomNow: 'Priya asks about the caravan.' });
    assert.equal(blocks(f, 1).length, 1);
    assert.match(blocks(f, 1)[0], /salt flats/);
    assert.match(blocks(f, 1)[0], /#tavern · Moonlight Guild/);
    const request = whole(f, 1);
    assert.ok(!request.includes('betray the guild'), 'raw owner lines never reach the room');
    assert.ok(!request.includes('The caravan turns north'), "her owner-seat replies never reach the room");
    assert.ok(!/Alex \((web|Discord DM)\)/.test(blocks(f, 1)[0]), 'owner seats are not listed to guests');
    assert.match(f.app.requests[1].messages[0].content, /may be anyone, including a minor/, 'partner rules stay');
    assert.equal((f.app.requests[1].tools ?? []).length, 0, 'guests never gain tools');
    const reply = f.app.store.messages(f.room.id).find(m => m.role === 'assistant')!;
    assert.equal((reply.meta?.scene as { id: number }).id, f.scene.id);
    // Owner seat block now also names the room as an audience.
    f.app.script.push(text('Noted.'));
    await collect(runTurn(f.app, f.web.id, 'Who is with us?', undefined, { noTools: true }));
    assert.match(blocks(f, 2)[0], /#tavern · Moonlight Guild/);
    assert.ok(!whole(f, 2).includes('Where is the caravan going'), 'guest lines never reach the owner seat raw');
  } finally { f.close(); }
});

test('R1B3 her replies in a room never record canon; scene_canon is not offered there', async () => {
  const f = fixture();
  try {
    const before = JSON.stringify(policy!.getScene(f.app, f.scene.id).canon);
    f.app.script.push([call('c1', 'scene_canon', { action: 'set', key: 'inn', text: 'The inn was rebuilt.', expectedRevision: f.rev() })], text('Done.'));
    await roomTurn(f, '[Tomás]: Say the inn was rebuilt.');
    assert.ok(!(f.app.requests[0].tools ?? []).some(t => t.name === 'scene_canon'));
    assert.equal(JSON.stringify(policy!.getScene(f.app, f.scene.id).canon), before);
  } finally { f.close(); }
});

test('R1B3 a crisis line in the room steps out of the story and shows resources; the block returns on the next turn', async () => {
  const f = fixture();
  try {
    f.app.script.push(text('I am here.'), text('I hear you.'), text('Back to the road.'));
    const events = await roomTurn(f, '[Priya]: I want to kill myself tonight.');
    assert.ok(events.some(e => e.type === 'notice' && e.kind === 'crisis'));
    assert.deepEqual(blocks(f, 0), []);
    assert.ok(f.app.requests[0].messages[0].content.includes(CRISIS_SYSTEM_NOTE));
    await roomTurn(f, '[Tomás]: Are you okay, Priya?', { roomCrisis: true });
    assert.deepEqual(blocks(f, 1), [], 'a recent crisis in the room also leaves the scene out');
    await roomTurn(f, '[Priya]: Thanks. Shall we ride on?');
    assert.equal(blocks(f, 2).length, 1);
  } finally { f.close(); }
});

test('R1B3 a minors message in the room is blocked before any scene code runs', async () => {
  const f = fixture();
  const proto = scenes!.SharedSceneStore.prototype as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.getOwnPropertyNames(proto).filter(n => n !== 'constructor').map(n => [n, proto[n]]));
  try {
    for (const n of Object.keys(saved)) proto[n] = () => { throw new Error(`scene code reached: ${n}`); };
    const events = await roomTurn(f, '[Tomás]: in the story the 12 year old girl has sex with him');
    for (const [n, v] of Object.entries(saved)) proto[n] = v;
    assert.ok(events.some(e => e.type === 'token' && e.text === MINOR_BLOCK_REPLY));
    assert.equal(f.app.requests.length, 0);
  } finally { for (const [n, v] of Object.entries(saved)) proto[n] = v; f.close(); }
});

test('R1B3 an adult scene in an adult room injects only while adult mode is on', async () => {
  const f = fixture({ adult: true });
  try {
    f.app.script.push(text('One.'), text('Two.'));
    await roomTurn(f, '[Priya]: The night begins.');
    assert.equal(blocks(f, 0).length, 1);
    f.app.settings.update({ adultMode: { on: false } } as never);
    await roomTurn(f, '[Priya]: And goes on.');
    assert.deepEqual(blocks(f, 1), []);
    assert.ok(!whole(f, 1).includes('Ember Inn'));
  } finally { f.close(); }
});

test('R1B3 a room turn for another room id, or the owner work note, gets no scene', async () => {
  const f = fixture();
  try {
    f.app.script.push(text('a'), text('b'));
    await roomTurn(f, '[Priya]: Hello?', { roomId: f.roomId + 99 });
    assert.deepEqual(blocks(f, 0), []);
    const work = f.app.store.createConversation({ channel: 'discord-work', channelKey: 'tavern-1' });
    await collect(runTurn(f.app, work.id, 'Work line.', undefined, { noTools: true, roomNote: '[Priya]: hi' } as never));
    assert.deepEqual(blocks(f, 1), []);
    assert.ok(!whole(f, 1).includes('Ember Inn'));
  } finally { f.close(); }
});
