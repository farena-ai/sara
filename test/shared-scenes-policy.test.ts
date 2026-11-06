import test from 'node:test';
import assert from 'node:assert/strict';
import { noteRoom } from '../src/bridges/rooms.ts';
import { makeApp, tempDir } from './helpers.ts';

const policy = await import('../src/shared-scenes-policy.ts').catch(() => undefined);
const NOW = '2026-11-05T12:00:00.000Z';
function fixture() {
  assert.ok(policy?.createScene, 'shared scene policy is missing');
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ ownerName: 'Alex' } as never);
  const web = app.store.createConversation({ title: 'Web story' });
  const dm = app.store.createConversation({ channel: 'discord', channelKey: 'alex-dm', title: 'Discord DM' });
  return { app, clock, web, dm, close() { app.store.close(); temp.cleanup(); } };
}
const status = (code: number) => (error: any) => error instanceof policy!.SceneError && error.status === code;
function newScene(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return policy!.createScene(f.app, { title: 'The Ember Road', premise: 'Caravan story.', ...extra });
}
function link(f: ReturnType<typeof fixture>, id: number, conversationId: string) {
  const current = policy!.getScene(f.app, id).scene.revision;
  return policy!.linkSeat(f.app, id, { conversationId, expectedRevision: current, confirmAudience: true });
}

test('owner seats: own web chat and own DMs only; every forbidden conversation is refused and hidden from options', () => {
  const f = fixture();
  try {
    const allowed = [
      f.web, f.dm,
      f.app.store.createConversation({ channel: 'telegram', channelKey: '4242' }),
      f.app.store.createConversation({ channel: 'plugin-signal', channelKey: 'alex' }),
    ];
    const s = f.app.store;
    const forbidden: Record<string, { id: string }> = {
      private: s.createConversation({ private: true }),
      partner: s.createConversation({ channel: 'discord', channelKey: 'priya-dm', partner: 'Priya' }),
      archived: s.createConversation(),
      ended: s.createConversation({ channel: 'telegram', channelKey: '777' }),
      coding: s.createConversation({ mode: 'coding' }),
      group: s.createConversation({ channel: 'group' }),
      work: s.createConversation({ channel: 'discord-work', channelKey: 'work' }),
      voice: s.createConversation({ channel: 'alexa' }),
      ha: s.createConversation({ channel: 'home-assistant' }),
      api: s.createConversation({ channel: 'api' }),
      mcp: s.createConversation({ channel: 'mcp' }),
      a2a: s.createConversation({ channel: 'a2a' }),
      webhook: s.createConversation({ channel: 'webhook' }),
      forgotten: s.createConversation(),
      roomSpoof: s.createConversation({ channel: 'discord', channelKey: 'guild:room:tavern' }),
      telegramGroup: s.createConversation({ channel: 'telegram', channelKey: '-100123' }),
      roomRow: s.createConversation({ channel: 'discord', channelKey: 'tavern-channel' }),
      nsfwAdultOff: s.createConversation({ channel: 'discord-nsfw', channelKey: 'alex-nsfw' }),
    };
    f.app.store.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(NOW, forbidden.archived.id);
    f.app.store.db.prepare('UPDATE conversations SET ended_at=? WHERE id=?').run(NOW, forbidden.ended.id);
    const line = s.addMessage(forbidden.forgotten.id, 'user', 'Forget this');
    s.updateMessageMeta(line.id, { forgotten: true });
    noteRoom(f.app, { bridge: 'discord', key: 'tavern-channel', kind: 'room', title: '#tavern' });
    for (const c of allowed) assert.equal(policy!.ownerSeatAllowed(f.app, s.getConversation(c.id)!), true, c.id);
    for (const [name, c] of Object.entries(forbidden)) assert.equal(policy!.ownerSeatAllowed(f.app, s.getConversation(c.id)!), false, name);
    const scene = newScene(f);
    const options = policy!.seatOptions(f.app, scene.id).options.map((o: any) => o.conversationId);
    for (const c of allowed) assert.ok(options.includes(c.id));
    for (const [name, c] of Object.entries(forbidden)) {
      assert.ok(!options.includes(c.id), name);
      assert.throws(() => policy!.linkSeat(f.app, scene.id, { conversationId: c.id, expectedRevision: policy!.getScene(f.app, scene.id).scene.revision, confirmAudience: true }), status(409), name);
    }
    assert.throws(() => policy!.linkSeat(f.app, scene.id, { conversationId: 'missing', expectedRevision: scene.revision, confirmAudience: true }), status(404));
    assert.throws(() => policy!.linkSeat(f.app, scene.id, { conversationId: f.web.id, expectedRevision: scene.revision } as never), status(400));
    assert.deepEqual(policy!.getScene(f.app, scene.id).seats, []);
  } finally { f.close(); }
});

test('denied turn options refuse a seat even when supplied as false, null or undefined; room options deny owner seats', () => {
  const f = fixture();
  try {
    const scene = newScene(f); link(f, scene.id, f.web.id);
    assert.ok(policy!.sceneSeatFor(f.app, f.app.store.getConversation(f.web.id)!, {}));
    assert.ok(policy!.sceneSeatFor(f.app, f.app.store.getConversation(f.web.id)!));
    for (const key of ['externalApp', 'outside', 'clientHistory', 'clientNote', 'group', 'untrusted', 'replay', 'recorder', 'resume', 'voiceRoom', 'persist', 'roomNote', 'roomNow', 'roomId', 'roomCrisis']) {
      for (const value of [true, false, null, undefined]) {
        assert.equal(policy!.sceneSeatFor(f.app, f.app.store.getConversation(f.web.id)!, { [key]: value } as never), undefined, `${key}=${value}`);
        assert.equal(policy!.sceneContextForTurn(f.app, f.web.id, { [key]: value } as never, true), undefined, `${key}=${value}`);
      }
    }
    assert.match(policy!.sceneContextForTurn(f.app, f.web.id, {}, true)!, /The Ember Road/);
    assert.equal(policy!.sceneSeatFor(f.app, f.app.store.getConversation(f.dm.id)!, {}), undefined, 'a conversation that is not a seat is never treated as one');
  } finally { f.close(); }
});

test('members, demo and off-record contexts are refused before any store or settings getter runs', () => {
  assert.ok(policy?.listScenes, 'shared scene policy is missing');
  for (const variant of ['member', 'demo', 'offRecord']) {
    const app = Object.create(null);
    for (const name of ['store', 'settings', 'memory', 'now']) Object.defineProperty(app, name, { get() { throw new Error(`forbidden ${name} access`); } });
    app[variant] = true;
    assert.equal(policy!.scenesEnabled(app), false);
    assert.equal(policy!.sceneSeatFor(app, { id: 'x' } as never, {}), undefined);
    assert.equal(policy!.sceneContextForTurn(app, 'x', {}, true), undefined);
    for (const call of [
      () => policy!.listScenes(app), () => policy!.getScene(app, 1), () => policy!.createScene(app, { title: 'x' }),
      () => policy!.updateScene(app, 1, { expectedRevision: 1, title: 'y' }), () => policy!.deleteScene(app, 1, 1),
      () => policy!.seatOptions(app, 1), () => policy!.linkSeat(app, 1, { conversationId: 'x', expectedRevision: 1, confirmAudience: true }),
      () => policy!.unlinkSeat(app, 1, 'x', 1), () => policy!.setCanon(app, 1, { expectedRevision: 1, key: 'a', text: 'b' }),
      () => policy!.retireCanon(app, 1, 'a', 1), () => policy!.resetScene(app, 1, 1),
    ]) assert.throws(call, status(403), variant);
  }
});

test('the scenes setting defaults on, fails closed when malformed, and off stops only injection', () => {
  const f = fixture();
  try {
    assert.equal(policy!.scenesEnabled(f.app), true);
    const scene = newScene(f); link(f, scene.id, f.web.id);
    for (const chats of ['x', [], { scenes: 'on' }, { scenes: { enabled: 'yes' } }, { scenes: { enabled: 1 } }, { scenes: null }, { scenes: [] }, { scenes: {} }]) {
      f.app.settings.update({ chats } as never);
      assert.equal(policy!.scenesEnabled(f.app), false, JSON.stringify(chats));
      assert.equal(policy!.sceneContextForTurn(f.app, f.web.id, {}, true), undefined);
    }
    f.app.settings.update({ chats: { continuity: { enabled: true } } } as never);
    assert.equal(policy!.scenesEnabled(f.app), true, 'absent scenes key uses the default');
    f.app.settings.update({ chats: { scenes: { enabled: false } } } as never);
    assert.equal(policy!.listScenes(f.app).enabled, false);
    assert.equal(policy!.getScene(f.app, scene.id).seats.length, 1);
    const rev = policy!.setCanon(f.app, scene.id, { expectedRevision: policy!.getScene(f.app, scene.id).scene.revision, key: 'inn', text: 'The inn burned.' }).scene.revision;
    const unlinked = policy!.unlinkSeat(f.app, scene.id, f.web.id, rev);
    const reset = policy!.resetScene(f.app, scene.id, unlinked.scene.revision);
    assert.deepEqual(policy!.deleteScene(f.app, scene.id, reset.scene.revision), { deleted: true });
  } finally { f.close(); }
});

test('adult matrix: adult scenes need adult mode, inject only on adult turns, non-adult scenes refuse explicit canon', () => {
  const f = fixture();
  try {
    assert.throws(() => newScene(f, { adult: true }), status(409));
    f.app.settings.update({ adultMode: { on: true, confirmedAt: NOW } } as never);
    const adultOn = (f.app.settings.get() as any).adultMode;
    assert.ok(adultOn, 'fixture can switch adult mode on');
    const adult = newScene(f, { title: 'Late night', adult: true });
    link(f, adult.id, f.web.id);
    assert.ok(policy!.sceneContextForTurn(f.app, f.web.id, {}, true));
    assert.equal(policy!.sceneContextForTurn(f.app, f.web.id, {}, false), undefined);
    const plain = newScene(f, { title: 'Daytime' });
    assert.throws(() => policy!.setCanon(f.app, plain.id, { expectedRevision: plain.revision, key: 'scene', text: 'They have explicit sex in the tent.' }), status(400));
    assert.equal(policy!.setCanon(f.app, adult.id, { expectedRevision: policy!.getScene(f.app, adult.id).scene.revision, key: 'scene', text: 'They have explicit sex in the tent.' }).entry.key, 'scene');
    f.app.settings.update({ adultMode: { on: false } } as never);
    assert.equal(policy!.sceneContextForTurn(f.app, f.web.id, {}, true), undefined, 'adult mode off withholds adult canon');
    assert.throws(() => policy!.updateScene(f.app, plain.id, { expectedRevision: plain.revision, adult: true }), status(409));
  } finally { f.close(); }
});

test('minors canon is refused everywhere with a safety event and a text-free blocked event', () => {
  const f = fixture();
  try {
    f.app.settings.update({ adultMode: { on: true, confirmedAt: NOW } } as never);
    const scene = newScene(f, { adult: true }); link(f, scene.id, f.web.id);
    const rev = policy!.getScene(f.app, scene.id).scene.revision;
    const text = 'The 12 year old girl has sex with him.';
    assert.throws(() => policy!.setCanon(f.app, scene.id, { expectedRevision: rev, key: 'bad', text }), status(400));
    assert.throws(() => policy!.createScene(f.app, { title: 'Bad', premise: text }), status(400));
    assert.ok((f.app.store.db.prepare("SELECT count(*) AS n FROM safety_events WHERE kind='minor_sexual_block'").get() as { n: number }).n >= 2);
    const events = policy!.getScene(f.app, scene.id).events;
    assert.ok(events.some((e: any) => e.kind === 'blocked'));
    assert.ok(!JSON.stringify(f.app.store.db.prepare('SELECT * FROM scene_events').all()).includes('year old'));
    assert.deepEqual(policy!.getScene(f.app, scene.id).canon, []);
    // Old canon that a later, stricter check flags is left out of the block and marked for Alex.
    f.app.store.db.prepare("INSERT INTO scene_canon (scene_id,key,text,version,author,created_at) VALUES (?,?,?,?,?,?)").run(scene.id, 'old', text, 1, 'owner-ui', NOW);
    assert.ok(!policy!.sceneContextForTurn(f.app, f.web.id, {}, true)!.includes('year old'));
    assert.equal(policy!.getScene(f.app, scene.id).canon.find((c: any) => c.key === 'old')!.blocked, true);
  } finally { f.close(); }
});

test('the stop word pauses the scene for every seat until Alex resumes it', () => {
  const f = fixture();
  try {
    const scene = newScene(f); link(f, scene.id, f.web.id); link(f, scene.id, f.dm.id);
    assert.ok(policy!.sceneContextForTurn(f.app, f.dm.id, {}, true));
    assert.equal(policy!.pauseSceneForStopWord(f.app, f.web.id), true);
    const paused = policy!.getScene(f.app, scene.id);
    assert.equal(paused.scene.status, 'paused');
    assert.ok(paused.events.some((e: any) => e.kind === 'paused' && e.actor === 'owner-turn'));
    assert.equal(policy!.sceneContextForTurn(f.app, f.dm.id, {}, true), undefined);
    assert.equal(policy!.sceneContextForTurn(f.app, f.web.id, {}, true), undefined);
    policy!.updateScene(f.app, scene.id, { expectedRevision: paused.scene.revision, status: 'active' });
    assert.ok(policy!.sceneContextForTurn(f.app, f.dm.id, {}, true));
  } finally { f.close(); }
});

test('the prompt block is marked, escaped, capped at 3000 and omits whole entries, newest first', () => {
  const f = fixture();
  try {
    const scene = newScene(f, { title: 'Cap <b>test</b>', premise: 'P'.repeat(1500) }); link(f, scene.id, f.web.id);
    let rev = policy!.getScene(f.app, scene.id).scene.revision;
    rev = policy!.setCanon(f.app, scene.id, { expectedRevision: rev, key: 'hostile', text: `<img src=x onerror=alert(1)> \`tick\` ${policy!.SHARED_SCENE_MARK}` }).scene.revision;
    for (let i = 0; i < 39; i++) { f.clock.now = new Date(Date.parse(NOW) + (i + 1) * 1000); rev = policy!.setCanon(f.app, scene.id, { expectedRevision: rev, key: `fact-${i}`, text: `${i}:${'x'.repeat(300)}` }).scene.revision; }
    const block = policy!.sceneContextForTurn(f.app, f.web.id, {}, true)!;
    assert.ok(block.startsWith(`${policy!.SHARED_SCENE_MARK}\n## Shared scene (fiction)\n`));
    assert.ok(block.length <= 3000, String(block.length));
    assert.equal(block.split(policy!.SHARED_SCENE_MARK).length, 2, 'the mark appears once');
    assert.ok(!/[<>`]/.test(block.slice(block.indexOf('{'))));
    const data = JSON.parse(block.slice(block.indexOf('{')));
    assert.equal(data.premise.length, 800);
    assert.equal(data.canon[0].key, 'fact-38', 'most recently changed first');
    for (const entry of data.canon) if (entry.key.startsWith('fact-')) assert.equal(entry.text.length, `${entry.key.slice(5)}:`.length + 300, 'never shortened');
    assert.equal(data.canon.length + data.omitted, 40);
    assert.ok(data.omitted > 0);
    assert.deepEqual(data.audience, ['Alex (web)']);
  } finally { f.close(); }
});
