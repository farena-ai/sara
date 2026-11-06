// R1B3: one room seat per scene (a Discord channel, a Telegram group or a partner DM), the adult
// rules and owner-only "Add to scene" for guest lines. Invented people only (Alex, Priya, Tomás).
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteRoom } from '../src/bridges/rooms.ts';
import { makeApp, tempDir } from './helpers.ts';

const policy = await import('../src/shared-scenes-policy.ts').catch(() => undefined);
const NOW = '2026-11-05T12:00:00.000Z';
const P = () => policy as any;

function fixture(opts: { adult?: boolean } = {}) {
  assert.ok(policy?.createScene, 'shared scene policy is missing');
  assert.equal(typeof (policy as any).roomSeatAllowed, 'function', 'R1B3 room seat rule is missing');
  const temp = tempDir(); const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ ownerName: 'Alex', discord: { enabled: true }, telegram: { enabled: true }, ...(opts.adult ? { adultMode: { on: true, confirmedAt: NOW } } : {}) } as never);
  const s = app.store;
  const web = s.createConversation({ title: 'Web story' });
  noteRoom(app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: 'tavern', parentTitle: 'Moonlight Guild' });
  const tavern = s.createConversation({ channel: 'discord', channelKey: 'tavern-1', partner: 'people in a Discord channel', title: 'Discord: #tavern · Moonlight Guild' });
  noteRoom(app, { bridge: 'discord', key: 'dark-1', kind: 'room', title: 'after-dark', parentTitle: 'Moonlight Guild', adult: true });
  const afterDark = s.createConversation({ channel: 'discord-nsfw', channelKey: 'dark-1', partner: 'people in a Discord channel', title: 'Discord: #after-dark · Moonlight Guild' });
  noteRoom(app, { bridge: 'telegram', key: '-100777', kind: 'room', title: 'Book club' });
  const bookClub = s.createConversation({ channel: 'telegram', channelKey: '-100777', partner: 'people in a Telegram group', title: 'Book club' });
  noteRoom(app, { bridge: 'discord', key: 'priya-dm', kind: 'dm', title: 'Priya' });
  const priyaDm = s.createConversation({ channel: 'discord', channelKey: 'priya-dm', partner: 'Priya', title: 'Priya' });
  return { app, clock, web, tavern, afterDark, bookClub, priyaDm, close() { app.store.close(); temp.cleanup(); } };
}
type F = ReturnType<typeof fixture>;
const status = (code: number) => (error: any) => error instanceof policy!.SceneError && error.status === code;
const rev = (f: F, id: number) => policy!.getScene(f.app, id).scene.revision;
const newScene = (f: F, extra: Record<string, unknown> = {}) => policy!.createScene(f.app, { title: 'The Ember Road', premise: 'A caravan crosses the dunes.', ...extra });
function roomId(f: F, sceneId: number, conversationId: string): number {
  const option = P().seatOptions(f.app, sceneId).options.find((o: any) => o.conversationId === conversationId);
  assert.ok(option?.room?.id, `no room option for ${conversationId}`);
  return option.room.id;
}
function linkRoom(f: F, sceneId: number, conversationId: string) {
  return P().linkSeat(f.app, sceneId, { conversationId, expectedRevision: rev(f, sceneId), confirmAudience: true, confirmRoomId: roomId(f, sceneId, conversationId) });
}
const linkOwner = (f: F, sceneId: number, conversationId: string) => policy!.linkSeat(f.app, sceneId, { conversationId, expectedRevision: rev(f, sceneId), confirmAudience: true });
const ownTables = (f: F) => (f.app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(r => r.name);

test('R1B3 room seats: a Discord channel, a Telegram group and a partner DM qualify; everything else is refused and hidden', () => {
  const f = fixture();
  try {
    const s = f.app.store;
    for (const c of [f.tavern, f.bookClub, f.priyaDm]) assert.equal(P().roomSeatAllowed(f.app, s.getConversation(c.id)!), true, c.title);
    noteRoom(f.app, { bridge: 'discord', key: 'work-1', kind: 'room', title: 'ops', parentTitle: 'Guild' });
    noteRoom(f.app, { bridge: 'discord', key: 'lie-1', kind: 'room', title: 'lie', parentTitle: 'Guild' });
    noteRoom(f.app, { bridge: 'telegram', key: '-100888', kind: 'dm', title: 'Spoofed DM' });
    noteRoom(f.app, { bridge: 'plugin-signal', key: 'sig-1', kind: 'room', title: 'Signal group' });
    noteRoom(f.app, { bridge: 'discord', key: 'archived-1', kind: 'room', title: 'old' });
    noteRoom(f.app, { bridge: 'discord', key: 'ended-1', kind: 'room', title: 'ended' });
    noteRoom(f.app, { bridge: 'discord', key: 'coding-1', kind: 'room', title: 'coding' });
    noteRoom(f.app, { bridge: 'discord', key: 'forgot-1', kind: 'room', title: 'forgot' });
    noteRoom(f.app, { bridge: 'discord', key: 'private-1', kind: 'room', title: 'private' });
    noteRoom(f.app, { bridge: 'discord', key: 'alex-dm', kind: 'dm', title: 'Alex' });
    const forbidden: Record<string, { id: string }> = {
      noRoomRow: s.createConversation({ channel: 'discord', channelKey: 'unknown-1', partner: 'people in a Discord channel' }),
      work: s.createConversation({ channel: 'discord-work', channelKey: 'work-1' }),
      adultMismatch: s.createConversation({ channel: 'discord-nsfw', channelKey: 'lie-1', partner: 'people in a Discord channel' }),
      telegramGroupAsDm: s.createConversation({ channel: 'telegram', channelKey: '-100888', partner: 'Somebody' }),
      plugin: s.createConversation({ channel: 'plugin-signal', channelKey: 'sig-1', partner: 'people in a Signal group' }),
      archived: s.createConversation({ channel: 'discord', channelKey: 'archived-1', partner: 'people' }),
      ended: s.createConversation({ channel: 'discord', channelKey: 'ended-1', partner: 'people' }),
      coding: s.createConversation({ channel: 'discord', channelKey: 'coding-1', partner: 'people', mode: 'coding' }),
      forgotten: s.createConversation({ channel: 'discord', channelKey: 'forgot-1', partner: 'people' }),
      private: s.createConversation({ channel: 'discord', channelKey: 'private-1', partner: 'people', private: true }),
      ownerDm: s.createConversation({ channel: 'discord', channelKey: 'alex-dm' }),
      group: s.createConversation({ channel: 'group', partner: 'Mira and June' }),
      web: f.web,
      voice: s.createConversation({ channel: 'alexa', partner: 'people' }),
      api: s.createConversation({ channel: 'api', partner: 'an app' }),
      nsfwAdultOff: f.afterDark,
    };
    s.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(NOW, forbidden.archived.id);
    s.db.prepare('UPDATE conversations SET ended_at=? WHERE id=?').run(NOW, forbidden.ended.id);
    const line = s.addMessage(forbidden.forgotten.id, 'user', '[Tomás]: forget this');
    s.updateMessageMeta(line.id, { forgotten: true });
    for (const [name, c] of Object.entries(forbidden)) assert.equal(P().roomSeatAllowed(f.app, s.getConversation(c.id)!), false, name);
    // A room conversation is never an owner seat, and an owner chat is never a room seat.
    for (const c of [f.tavern, f.bookClub, f.priyaDm]) assert.equal(policy!.ownerSeatAllowed(f.app, s.getConversation(c.id)!), false, c.title);
    const scene = newScene(f);
    const options = P().seatOptions(f.app, scene.id).options;
    const ids = new Set(options.map((o: any) => o.conversationId));
    for (const c of [f.web, f.tavern, f.bookClub, f.priyaDm]) assert.ok(ids.has(c.id), `${c.title} offered`);
    for (const [name, c] of Object.entries(forbidden)) if (name !== 'ownerDm' && name !== 'web') assert.equal(ids.has(c.id), false, `${name} hidden`);
    const tavern = options.find((o: any) => o.conversationId === f.tavern.id);
    assert.equal(tavern.seatAudience, 'room');
    assert.deepEqual({ kind: tavern.room.kind, name: tavern.room.name, bridge: tavern.room.bridge }, { kind: 'channel', name: '#tavern · Moonlight Guild', bridge: 'discord' });
    assert.match(tavern.audience, /everyone who can read #tavern · Moonlight Guild on Discord/i);
    assert.match(tavern.audience, /guests|everyone/i);
    assert.match(options.find((o: any) => o.conversationId === f.bookClub.id).audience, /Telegram group Book club/);
    assert.match(options.find((o: any) => o.conversationId === f.priyaDm.id).audience, /Priya/);
    assert.equal(options.find((o: any) => o.conversationId === f.web.id).seatAudience, 'owner');
  } finally { f.close(); }
});

test('R1B3 reading room eligibility never creates the rooms table', () => {
  const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date(NOW) });
  try {
    assert.equal(typeof (policy as any)?.roomSeatAllowed, 'function', 'R1B3 room seat rule is missing');
    app.settings.update({ ownerName: 'Alex', discord: { enabled: true } } as never);
    const room = app.store.createConversation({ channel: 'discord', channelKey: 'tavern-1', partner: 'people in a Discord channel' });
    const has = () => Boolean(app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'").get());
    assert.equal(has(), false);
    assert.equal(P().roomSeatAllowed(app, app.store.getConversation(room.id)!), false);
    const scene = policy!.createScene(app, { title: 'No rooms yet' });
    assert.equal(P().seatOptions(app, scene.id).options.some((o: any) => o.conversationId === room.id), false);
    assert.equal(P().sceneChipFor(app, room.id), undefined);
    assert.equal(has(), false, 'reads never create room tables');
  } finally { app.store.close(); temp.cleanup(); }
});

test('R1B3 linking a room needs the exact room confirmed; one room seat per scene; bridge off refuses', () => {
  const f = fixture();
  try {
    const scene = newScene(f);
    const id = roomId(f, scene.id, f.tavern.id);
    assert.throws(() => P().linkSeat(f.app, scene.id, { conversationId: f.tavern.id, expectedRevision: rev(f, scene.id), confirmAudience: true }), status(400), 'the room must be confirmed');
    assert.throws(() => P().linkSeat(f.app, scene.id, { conversationId: f.tavern.id, expectedRevision: rev(f, scene.id), confirmAudience: true, confirmRoomId: id + 1000 }), status(409), 'a different room than the one shown');
    assert.throws(() => P().linkSeat(f.app, scene.id, { conversationId: f.tavern.id, expectedRevision: rev(f, scene.id), confirmAudience: false, confirmRoomId: id }), status(400));
    assert.throws(() => P().linkSeat(f.app, scene.id, { conversationId: f.web.id, expectedRevision: rev(f, scene.id), confirmAudience: true, confirmRoomId: id }), status(400), 'a room id only belongs to a room seat');
    const linked = linkRoom(f, scene.id, f.tavern.id);
    assert.equal(linked.seat.audience, 'room');
    assert.match(linked.seat.label, /#tavern · Moonlight Guild/);
    assert.equal(linked.seat.room.name, '#tavern · Moonlight Guild');
    linkOwner(f, scene.id, f.web.id);
    // One room seat per scene: a second room means a second scene.
    assert.throws(() => linkRoom(f, scene.id, f.bookClub.id), status(409));
    assert.throws(() => linkRoom(f, scene.id, f.priyaDm.id), status(409));
    const second = newScene(f, { title: 'Book club mystery' });
    const bookId = roomId(f, second.id, f.bookClub.id);
    f.app.settings.update({ telegram: { enabled: false } } as never);
    assert.throws(() => P().linkSeat(f.app, second.id, { conversationId: f.bookClub.id, expectedRevision: rev(f, second.id), confirmAudience: true, confirmRoomId: bookId }), status(409), 'bridge off');
    assert.equal(P().seatOptions(f.app, second.id).options.some((o: any) => o.conversationId === f.bookClub.id), false);
    f.app.settings.update({ telegram: { enabled: true } } as never);
    linkRoom(f, second.id, f.bookClub.id);
    // A conversation sits in one scene at a time.
    const third = newScene(f, { title: 'Third' });
    assert.equal(P().seatOptions(f.app, third.id).options.some((o: any) => o.conversationId === f.tavern.id), false);
    const detail = policy!.getScene(f.app, scene.id);
    const room = detail.seats.find((s: any) => s.audience === 'room') as any;
    assert.match(room.label, /everyone who can read #tavern · Moonlight Guild on Discord/i);
    assert.ok(detail.events.some(e => e.kind === 'linked' && e.conversationId === f.tavern.id));
  } finally { f.close(); }
});

test('R1B3 adult matrix: an adult scene takes only an adult-eligible room while adult mode is on', () => {
  const f = fixture({ adult: true });
  try {
    const adult = newScene(f, { title: 'Velvet Night', adult: true });
    // Discord NSFW channel listed as adult: allowed.
    const darkOption = P().seatOptions(f.app, adult.id).options.find((o: any) => o.conversationId === f.afterDark.id);
    assert.equal(darkOption.adultEligible, true);
    assert.equal(P().seatOptions(f.app, adult.id).options.find((o: any) => o.conversationId === f.tavern.id).adultEligible, false);
    assert.equal(P().seatOptions(f.app, adult.id).options.find((o: any) => o.conversationId === f.priyaDm.id).adultEligible, false);
    for (const c of [f.tavern, f.priyaDm, f.bookClub]) assert.throws(() => linkRoom(f, adult.id, c.id), (e: any) => status(409)(e) && /adult/i.test(e.message), c.title);
    linkRoom(f, adult.id, f.afterDark.id);
    // Non-adult scene in an adult room: fine (no explicit canon there).
    const plain = newScene(f, { title: 'Daylight' });
    linkRoom(f, plain.id, f.tavern.id);
    // Turning a scene adult needs every current seat adult-eligible.
    assert.throws(() => policy!.updateScene(f.app, plain.id, { expectedRevision: rev(f, plain.id), adult: true }), (e: any) => status(409)(e) && /adult/i.test(e.message));
    const dmScene = newScene(f, { title: 'Priya DM' });
    linkRoom(f, dmScene.id, f.priyaDm.id);
    assert.throws(() => policy!.updateScene(f.app, dmScene.id, { expectedRevision: rev(f, dmScene.id), adult: true }), status(409), 'a guest DM is never adult-eligible');
    // Adult mode off: an NSFW room is not even a room seat for a new scene, and the adult scene injects nothing.
    f.app.settings.update({ adultMode: { on: false } } as never);
    const later = newScene(f, { title: 'Later' });
    assert.equal(P().seatOptions(f.app, later.id).options.some((o: any) => o.conversationId === f.afterDark.id), false);
    assert.equal(policy!.sceneContextForTurn(f.app, f.afterDark.id, {}, false), undefined);
    assert.equal(policy!.sceneContextForTurn(f.app, f.afterDark.id, {}, true), undefined, 'adult mode is re-read, not trusted from the turn');
    f.app.settings.update({ adultMode: { on: true, confirmedAt: NOW } } as never);
    assert.match(policy!.sceneContextForTurn(f.app, f.afterDark.id, {}, true) ?? '', /Velvet Night/);
    // The room's adult flag flips to 0: the seat is revoked by trigger; a round trip does not bring it back.
    f.app.store.db.prepare("UPDATE rooms SET adult=0 WHERE key='dark-1'").run();
    f.app.store.db.prepare("UPDATE rooms SET adult=1 WHERE key='dark-1'").run();
    assert.equal(policy!.getScene(f.app, adult.id).seats.length, 0);
    assert.equal(policy!.sceneContextForTurn(f.app, f.afterDark.id, {}, true), undefined);
  } finally { f.close(); }
});

test('R1B3 room seat turn options: room options match the current room; the owner work note and every other option deny', () => {
  const f = fixture();
  try {
    const scene = newScene(f);
    linkRoom(f, scene.id, f.tavern.id);
    linkOwner(f, scene.id, f.web.id);
    const conv = f.app.store.getConversation(f.tavern.id)!;
    const room = (f.app.store.db.prepare("SELECT id FROM rooms WHERE key='tavern-1'").get() as { id: number }).id;
    assert.ok(policy!.sceneSeatFor(f.app, conv, {}));
    assert.ok(policy!.sceneSeatFor(f.app, conv, { roomNow: 'the room is talking about dragons', roomId: room, roomCrisis: false } as never));
    assert.equal(policy!.sceneSeatFor(f.app, conv, { roomId: room + 1 } as never), undefined, 'room id of another room');
    assert.equal(policy!.sceneSeatFor(f.app, conv, { roomNote: 'owner work note' } as never), undefined);
    for (const key of ['externalApp', 'outside', 'clientHistory', 'clientNote', 'group', 'untrusted', 'replay', 'recorder', 'resume', 'voiceRoom', 'persist']) {
      for (const value of [false, null, undefined, true]) assert.equal(policy!.sceneSeatFor(f.app, conv, { [key]: value } as never), undefined, `${key}=${String(value)}`);
    }
    // Owner seats still refuse room options.
    assert.equal(policy!.sceneSeatFor(f.app, f.app.store.getConversation(f.web.id)!, { roomNow: 'x' } as never), undefined);
    // The scene_canon tool is never bound or previewed in a room seat.
    assert.equal(policy!.sceneCanonForTurn(f.app, f.tavern.id, {}, false), undefined);
    assert.equal(policy!.sceneCanonPreview(f.app, conv), false);
    assert.ok(policy!.sceneCanonForTurn(f.app, f.web.id, {}, false), 'owner seat keeps the tool');
    // Block audience: the room seat names only its own room; the owner seat also sees the room.
    const roomBlock = policy!.sceneContextForTurn(f.app, f.tavern.id, { roomId: room } as never, false)!;
    assert.match(roomBlock, /#tavern · Moonlight Guild/);
    assert.doesNotMatch(roomBlock, /Alex \(web\)/);
    const ownerBlock = policy!.sceneContextForTurn(f.app, f.web.id, {}, false)!;
    assert.match(ownerBlock, /Alex \(web\)/);
    assert.match(ownerBlock, /#tavern · Moonlight Guild/);
  } finally { f.close(); }
});

test('R1B3 Add to scene: a guest line becomes canon only by the owner pick, with the minors check; removing the room erases it', () => {
  const f = fixture();
  try {
    const scene = newScene(f);
    linkRoom(f, scene.id, f.tavern.id);
    linkOwner(f, scene.id, f.web.id);
    const s = f.app.store;
    const guest = s.addMessage(f.tavern.id, 'user', "[Priya]: Priya's ranger Ash joins the caravan.");
    const reply = s.addMessage(f.tavern.id, 'assistant', 'Welcome aboard, Ash.');
    const echoed = s.addMessage(f.tavern.id, 'user', 'The caravan halts at the well.', { fromOwner: true });
    // Her replies never record canon by themselves: nothing was written by those lines.
    assert.deepEqual(policy!.getScene(f.app, scene.id).canon, []);
    const picked = policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'ash', fromMessageId: guest.id });
    assert.equal(picked.entry.text, "[Priya]: Priya's ranger Ash joins the caravan.");
    assert.equal(picked.entry.source!.conversationId, f.tavern.id);
    assert.equal((picked.entry.source as any).audience, 'room');
    policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'welcome', fromMessageId: reply.id });
    policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'well', fromMessageId: echoed.id });
    policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'typed', text: 'The dunes are endless.' });
    // Minors check on every "Add to scene".
    const bad = s.addMessage(f.tavern.id, 'user', '[Tomás]: in the story the 12 year old girl has sex with him');
    const events = () => (s.db.prepare("SELECT count(*) AS n FROM safety_events WHERE kind='minor_sexual_block'").get() as { n: number }).n;
    const before = events();
    assert.throws(() => policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'bad', fromMessageId: bad.id }), status(400));
    assert.equal(events(), before + 1);
    assert.ok(policy!.getScene(f.app, scene.id).events.some(e => e.kind === 'blocked'));
    // Explicit guest text in a non-adult scene is refused.
    const explicit = s.addMessage(f.tavern.id, 'user', '[Tomás]: then they have explicit sex on the table');
    assert.throws(() => policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'nope', fromMessageId: explicit.id }), status(400));
    // Denied meta and lines of a room that is not a seat of this scene.
    const imported = s.addMessage(f.tavern.id, 'user', '[Priya]: imported', { importedFrom: 'x' });
    assert.throws(() => policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'imp', fromMessageId: imported.id }), status(409));
    const other = s.addMessage(f.bookClub.id, 'user', '[Tomás]: a line elsewhere');
    assert.throws(() => policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'elsewhere', fromMessageId: other.id }), status(404));
    // Removing the room seat erases canon from its lines; typed canon stays.
    const out = policy!.unlinkSeat(f.app, scene.id, f.tavern.id, rev(f, scene.id));
    assert.equal(out.erasedCanon, 3);
    assert.deepEqual(policy!.getScene(f.app, scene.id).canon.map(c => c.key), ['typed']);
  } finally { f.close(); }
});

test('R1B3 room seat triggers: kind/adult/bridge change revokes without resurrection; title refresh and new lines keep it', () => {
  const f = fixture();
  try {
    const scene = newScene(f);
    linkRoom(f, scene.id, f.tavern.id);
    const guest = f.app.store.addMessage(f.tavern.id, 'user', '[Priya]: The well is dry.');
    policy!.setCanon(f.app, scene.id, { expectedRevision: rev(f, scene.id), key: 'well', fromMessageId: guest.id });
    f.clock.now = new Date(Date.parse(NOW) + 2 * 86400000);
    noteRoom(f.app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: 'tavern-renamed', parentTitle: 'Moonlight Guild' });
    f.app.store.addMessage(f.tavern.id, 'user', '[Tomás]: Later line.');
    assert.equal(policy!.getScene(f.app, scene.id).seats.length, 1, 'title refresh keeps the room seat');
    assert.equal(policy!.getScene(f.app, scene.id).canon.length, 1);
    assert.match(policy!.getScene(f.app, scene.id).seats[0].label, /tavern-renamed/, 'labels follow the current room name');
    noteRoom(f.app, { bridge: 'discord', key: 'tavern-1', kind: 'dm', title: 'tavern-renamed' });
    noteRoom(f.app, { bridge: 'discord', key: 'tavern-1', kind: 'room', title: 'tavern-renamed', parentTitle: 'Moonlight Guild' });
    assert.equal(policy!.getScene(f.app, scene.id).seats.length, 0);
    assert.deepEqual(policy!.getScene(f.app, scene.id).canon, []);
    // Conversation scope changes revoke too (partner label, archive).
    linkRoom(f, scene.id, f.tavern.id);
    f.app.store.db.prepare("UPDATE conversations SET partner='someone else' WHERE id=?").run(f.tavern.id);
    assert.equal(policy!.getScene(f.app, scene.id).seats.length, 0);
  } finally { f.close(); }
});

test('R1B3 the In scene chip: owner only, seats only', () => {
  const f = fixture();
  try {
    const scene = newScene(f);
    linkRoom(f, scene.id, f.tavern.id);
    linkOwner(f, scene.id, f.web.id);
    const chip = P().sceneChipFor(f.app, f.tavern.id);
    assert.deepEqual({ id: chip.id, title: chip.title, status: chip.status, audience: chip.audience }, { id: scene.id, title: 'The Ember Road', status: 'active', audience: 'room' });
    assert.equal(P().sceneChipFor(f.app, f.web.id).audience, 'owner');
    assert.equal(P().sceneChipFor(f.app, f.bookClub.id), undefined);
    for (const flag of ['member', 'demo', 'offRecord']) assert.equal(P().sceneChipFor({ ...f.app, [flag]: flag === 'member' ? { id: 'm1' } : true }, f.web.id), undefined, flag);
  } finally { f.close(); }
});
