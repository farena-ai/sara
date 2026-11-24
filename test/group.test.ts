// Phase 66: group chats (two to four companions in one conversation).
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { CompanionManager, CompanionSettings, LinkedToolRegistry, MAIN_ID, createCompanionDir, newCompanionPersona, type Companion } from '../src/companions.ts';
import { CompanionHub, EventHub } from '../src/events.ts';
import { banterSpeaker, cutOtherSpeakers, stripLeadTag, fallbackSpeaker, foldName, GROUP_CHANNEL, GROUP_TOOLS, groupRooms, parseMentions, parseRouterAnswer, PASS_RE, planSpeakers, replyCap, ROUTER_SYSTEM, type GroupRoom } from '../src/group.ts';
import { runGroupRound, type GroupEvent, type RoundMember } from '../src/group-round.ts';
import { summarizeConversation } from '../src/memory-worker.ts';
import { loadPersona } from '../src/persona.ts';
import { recallMessages, sharedWithApps } from '../src/recall.ts';
import { ADULT_OFF_NOTE, CRISIS_SYSTEM_NOTE, MINOR_BLOCK_REPLY } from '../src/safety.ts';
import { SAFETY_BOUNDARIES } from '../src/persona.ts';
import { createSaraServer, pickCompanion } from '../src/server.ts';
import { UsageStore } from '../src/usage.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-28T15:00:00Z') };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const hub = new EventHub();
const companions = new CompanionManager(dir);
const mainApp = makeApp(dir, clock);

function build(id: string, cdir: string): Companion {
  const app: TestApp = id === MAIN_ID ? mainApp : makeApp(cdir, clock);
  if (id !== MAIN_ID) {
    app.settings = new CompanionSettings(cdir, mainApp.settings);
    app.tools = new LinkedToolRegistry(mainApp.tools);
    app.persona = loadPersona(join(cdir, 'persona.json'));
    app.vault = mainApp.vault;
    app.providerFactory = mainApp.providerFactory;
  }
  app.usage = new UsageStore(app.store.db, () => clock.now);
  app.rootDir = dir;
  app.companionId = id;
  app.companions = companions;
  app.events = new CompanionHub(hub, id);
  return { id, app, server: createSaraServer({ app, auth, webDir: join(ROOT, 'web'), companions }), start() {}, async stop() {} };
}
companions.build = build;
companions.add(build(MAIN_ID, dir));
function addCompanion(name: string): Companion {
  const { id, dir: cdir } = createCompanionDir(dir, newCompanionPersona(mainApp.persona, name, 'she', true), clock.now);
  const c = build(id, cdir);
  companions.add(c);
  return c;
}
const mia = addCompanion('Mia');
const zoe = addCompanion('Zoë');
const sara = companions.main;
const front: Server = createServer((req, res) => void pickCompanion(companions, req).server.emit('request', req, res));
let base = '';
before(async () => {
  mainApp.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), setupDone: true });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});
after(() => {
  front.close();
  for (const c of companions.all()) c.app.store.close();
  cleanup();
});
beforeEach(() => {
  mainApp.script.length = 0;
  mainApp.requests.length = 0;
});

const rooms = groupRooms(dir);
const all = [sara, mia, zoe];
function makeRoom(opts: Partial<Pick<GroupRoom, 'turnStyle' | 'banter' | 'private'>> & { members?: Companion[] } = {}): { room: GroupRoom; members: RoundMember[] } {
  const ms = opts.members ?? all;
  const room = rooms.create({ title: 'Movie night', members: ms.map((c) => c.id), turnStyle: opts.turnStyle ?? 'everyone', banter: opts.banter ?? 0, private: opts.private ?? false }, clock.now);
  const members = ms.map((c, i) => ({ id: c.id, app: c.app, convId: c.app.store.createConversation({ title: room.title, channel: GROUP_CHANNEL, channelKey: room.id }).id, speaker: { id: c.id, name: c.app.persona.name, color: i } }));
  return { room, members };
}
async function round(r: { room: GroupRoom; members: RoundMember[] }, msg: string, opts: { route?: (p: string) => Promise<string>; signal?: AbortSignal } = {}): Promise<GroupEvent[]> {
  const evs: GroupEvent[] = [];
  for await (const ev of runGroupRound({ room: rooms.get(r.room.id)!, rooms, members: r.members, viewerId: r.members[0].id, text: msg, signal: opts.signal ?? new AbortController().signal, ...(opts.route ? { route: opts.route } : {}) })) evs.push(ev);
  return evs;
}
const speakersOf = (evs: GroupEvent[]) => evs.flatMap((e) => (e.type === 'speaker' ? [e.speaker?.name ?? 'app'] : []));
const systemOf = (i: number) => String(mainApp.requests[i].messages[0].content);
const lastUserOf = (i: number) => String(mainApp.requests[i].messages.at(-1)?.content);

test('@mentions: accents, case, names with spaces, longest name wins, no e-mail addresses, @all', () => {
  const ms = [
    { id: 'a', name: 'Zoë' },
    { id: 'b', name: 'José' },
    { id: 'c', name: 'Mary Ann' },
    { id: 'd', name: 'Mary' },
  ];
  assert.deepEqual(parseMentions('@zoe what do you think?', ms), ['a']);
  assert.deepEqual(parseMentions('Hey @JOSÉ and @Zoë!', ms), ['b', 'a']);
  assert.deepEqual(parseMentions('@Mary Ann, you first', ms), ['c']);
  assert.deepEqual(parseMentions('@Mary, you first', ms), ['d']);
  assert.deepEqual(parseMentions('mail me at alex@zoe.com', ms), [], 'an address is not a mention');
  assert.deepEqual(parseMentions('Zoë, what do you think?', ms), [], 'a name without @ is for the router');
  assert.deepEqual(parseMentions('@everyone hi', ms), ['a', 'b', 'c', 'd']);
  assert.equal(foldName('Zoë JOSÉ'), 'zoe jose');
});

test('turn styles, router answers and fallbacks (pure)', () => {
  const ids = ['s', 'm', 'z'];
  assert.deepEqual(planSpeakers({ style: 'everyone', memberIds: ids, mentioned: [], next: 0, crisis: false }).speakers, ids);
  assert.deepEqual(planSpeakers({ style: 'turns', memberIds: ids, mentioned: [], next: 4, crisis: false }), { speakers: ['m'], next: 5 });
  assert.deepEqual(planSpeakers({ style: 'mention', memberIds: ids, mentioned: ['z'], next: 0, crisis: false }).speakers, ['z']);
  assert.equal(planSpeakers({ style: 'mention', memberIds: ids, mentioned: [], next: 0, crisis: false }).speakers, null, 'no @name: the router');
  assert.equal(planSpeakers({ style: 'fits', memberIds: ids, mentioned: [], next: 0, crisis: false }).speakers, null);
  assert.deepEqual(planSpeakers({ style: 'turns', memberIds: ids, mentioned: [], next: 0, crisis: true }).speakers, ids, 'a crisis: everyone answers');
  const ms = [{ id: 's', name: 'Sara' }, { id: 'm', name: 'Mia' }, { id: 'z', name: 'Zoë' }];
  assert.deepEqual(parseRouterAnswer('Mia', ms), ['m']);
  assert.deepEqual(parseRouterAnswer('<think>Sara? no</think> Zoe, Mia', ms), ['z', 'm']);
  assert.deepEqual(parseRouterAnswer('Sara, Mia, Zoë', ms), ['s', 'm'], 'two at most');
  assert.deepEqual(parseRouterAnswer('nobody', ms), []);
  assert.equal(fallbackSpeaker(ids, ['s', 'm']), 'z', 'least recent');
  assert.equal(fallbackSpeaker(ids, ['z', 'm', 's']), 'z');
  assert.equal(banterSpeaker(ids, 'What about you, Zoë?', ms, ['m']), 'z');
  assert.notEqual(banterSpeaker(ids, 'I agree.', ms, ['m']), 'm', 'never the same one twice in a row');
  assert.equal(replyCap(2), 6);
  assert.equal(replyCap(99), 6, 'the banter cap is hard');
  assert.ok(PASS_RE.test(' (pass) ') && PASS_RE.test('Pass.') && !PASS_RE.test('I pass the salt'));
  assert.equal(cutOtherSpeakers('Sounds fun!\nMia: me too\nAlex: ok', ['Mia', 'Alex']), 'Sounds fun!');
  assert.equal(cutOtherSpeakers('Sounds fun!\n**[Mia, another AI companion]:** me too', ['Mia']), 'Sounds fun!');
  assert.equal(cutOtherSpeakers('Mia: hi', ['Mia']), 'Mia: hi', 'never the whole reply');
  assert.equal(stripLeadTag('[Movie night] Oh hey!', ['Movie night', 'Mia']), 'Oh hey!');
  assert.equal(stripLeadTag('[Mia, another AI companion]: hi', ['Zoë']), 'hi');
  assert.equal(stripLeadTag('[link] text', ['Mia']), '[link] text', 'other brackets stay');
  assert.equal(stripLeadTag('[No name tag for this reply] Oh Alex…', []), 'Oh Alex…');
});

test('the router picks who answers with a scripted model (one or two), each with her own instructions', async () => {
  const r = makeRoom({ turnStyle: 'fits' });
  // The router call is the first model call; then the one it picked answers.
  mainApp.script.push(text('Mia'), text('Ooh, a horror night!'));
  let evs = await round(r, 'Which movie tonight?');
  assert.equal(String(mainApp.requests[0].messages[0].content), ROUTER_SYSTEM);
  assert.match(String(mainApp.requests[0].messages[1].content), /- Mia: [\s\S]*\[Alex\]: Which movie tonight\?/);
  assert.deepEqual(speakersOf(evs), ['Mia']);
  assert.match(systemOf(1), /You are Mia/);
  // Two picked: both answer, in that order.
  mainApp.requests.length = 0;
  mainApp.script.push(text('Zoë, Sara'), text('Comedy.'), text('Agreed, comedy.'));
  evs = await round(r, 'Comedy or drama?');
  assert.deepEqual(speakersOf(evs), ['Zoë', 'Sara']);
  // A useless router answer: whoever spoke least recently (not the last speaker).
  mainApp.script.push(text('hmm'), text('Mia here.'));
  evs = await round(r, 'Anyone?');
  assert.deepEqual(speakersOf(evs), ['Mia']);
});

test('everyone answers: own models, labelled transcript, other companions never as the owner or as her', async () => {
  const r = makeRoom({ turnStyle: 'everyone' });
  mainApp.script.push(text('I vote pizza.'), text('Sushi for me, Sara.'), text('Tacos!'));
  const evs = await round(r, 'What should we eat?');
  assert.deepEqual(speakersOf(evs), ['Sara', 'Mia', 'Zoë']);
  assert.match(systemOf(0), /You are Sara/);
  assert.match(systemOf(1), /You are Mia/);
  assert.match(systemOf(2), /You are Zoë/);
  // Each sees who said what: the owner labelled, the others labelled as other companions, never as assistant (her own).
  const zoeMsgs = mainApp.requests[2].messages;
  assert.match(lastUserOf(2), /\[Alex\]: What should we eat\?[\s\S]*\[Sara, another AI companion\]: I vote pizza\.[\s\S]*\[Mia, another AI companion\]: Sushi for me, Sara\./);
  assert.ok(!zoeMsgs.some((m) => m.role === 'assistant'), "nobody else's line is hers");
  assert.match(systemOf(2), /group chat in the app \("Movie night"\)/);
  // The safety block is in every companion's instructions.
  for (let i = 0; i < 3; i++) for (const b of SAFETY_BOUNDARIES) assert.ok(systemOf(i).includes(b));
  // Every member's copy has the whole round, with speakers.
  for (const m of r.members) {
    const msgs = m.app.store.messages(m.convId).filter((x) => x.role === 'user' || x.role === 'assistant');
    assert.deepEqual(msgs.map((x) => x.role === 'user' ? 'Alex' : (x.meta?.speaker as { name: string }).name), ['Alex', 'Sara', 'Mia', 'Zoë']);
    assert.equal(msgs.filter((x) => x.role === 'assistant' && !x.meta?.groupFrom).length, 1, 'only her own line is hers');
  }
  // Usage is recorded per companion with purpose "group".
  for (const m of r.members) assert.ok(m.app.usage!.summary('2000-01-01T00:00:00Z').byPurpose.every((p) => p.purpose === 'group'));
  // Tools: read-only ones only (no planner writes) in a group chat.
  for (const req of mainApp.requests) for (const t of req.tools ?? []) assert.ok(GROUP_TOOLS.has(t.name), `${t.name} offered in a group chat`);
});

test('take turns is round-robin; @mention only answers who was named, else the router', async () => {
  const r = makeRoom({ turnStyle: 'turns' });
  const who: string[] = [];
  for (const msg of ['one', 'two', 'three', 'four']) {
    mainApp.script.push(text('ok'));
    who.push(...speakersOf(await round(r, msg)));
  }
  assert.deepEqual(who, ['Sara', 'Mia', 'Zoë', 'Sara']);

  const m = makeRoom({ turnStyle: 'mention' });
  mainApp.script.push(text('Me? Sure.'));
  assert.deepEqual(speakersOf(await round(m, '@zoe, your pick?')), ['Zoë'], 'accents and case ignored');
  mainApp.script.push(text('Mia answers.'), text('Mia answers.'));
  let asked = '';
  assert.deepEqual(speakersOf(await round(m, 'and now?', { route: async (p) => ((asked = p), 'Mia') })), ['Mia']);
  assert.match(asked, /Who should answer Alex's last message\?/);
});

test('banter: extra replies between companions, capped, and "(pass)" ends it', async () => {
  const r = makeRoom({ turnStyle: 'turns', banter: 2 });
  mainApp.script.push(text('Pizza, obviously. Right, Zoë?'), text('Never! Mia, back me up.'), text('Tacos it is.'));
  let evs = await round(r, 'Dinner?');
  assert.deepEqual(speakersOf(evs), ['Sara', 'Zoë', 'Mia'], 'the one named reacts first');
  assert.equal(evs.at(-1)?.type === 'group_done' && evs.at(-1), evs.at(-1));
  assert.match(systemOf(1), /may react briefly to Sara/);
  // A pass is taken back and ends the banter.
  mainApp.script.push(text('Sure.'), text('(pass)'));
  evs = await round(r, 'ok');
  assert.ok(evs.some((e) => e.type === 'retract'));
  assert.equal(speakersOf(evs).length, 2);
  for (const m of r.members) assert.ok(!m.app.store.messages(m.convId).some((x) => PASS_RE.test(x.content)), 'no pass is kept anywhere');
  // Never more replies than the cap, whatever the room says.
  const big = makeRoom({ turnStyle: 'everyone', banter: 2 });
  rooms.update(big.room.id, { banter: 50 });
  for (let i = 0; i < 10; i++) mainApp.script.push(text(`line ${i}`));
  evs = await round(big, 'Talk among yourselves');
  assert.equal(evs.filter((e) => e.type === 'done').length, 5, '3 answers + 2 banter (banter is clamped to 2)');
  assert.ok(evs.filter((e) => e.type === 'done').length <= replyCap(2));
});

test('strictest adult gate: adult content only when every companion in the room has Adult mode on', async () => {
  const on = { on: true, confirmedAt: clock.now.toISOString() };
  sara.app.settings.update({ adultMode: on });
  mia.app.settings.update({ adultMode: on });
  const r = makeRoom({ turnStyle: 'everyone', members: [sara, mia, zoe] });
  mainApp.script.push(text('a'), text('b'), text('c'));
  await round(r, 'hello');
  for (let i = 0; i < 3; i++) assert.ok(systemOf(i).includes(ADULT_OFF_NOTE), `request ${i}: Zoë has it off, so it's off for everyone`);
  mainApp.requests.length = 0;
  const two = makeRoom({ turnStyle: 'everyone', members: [sara, mia] });
  mainApp.script.push(text('a'), text('b'));
  await round(two, 'hello');
  for (let i = 0; i < 2; i++) assert.ok(!systemOf(i).includes(ADULT_OFF_NOTE), 'both on: allowed');
  sara.app.settings.update({ adultMode: undefined });
  mia.app.settings.update({ adultMode: undefined });
});

test('AI disclosure once per companion at the start of the room and again after 3 hours', async () => {
  const r = makeRoom({ turnStyle: 'turns' });
  mainApp.script.push(text('hi'));
  let evs = await round(r, 'hi all');
  const notices = (e: GroupEvent[]) => e.filter((x) => x.type === 'notice' && x.kind === 'disclosure').map((x) => (x as { speaker?: { name: string } }).speaker?.name);
  assert.deepEqual(notices(evs), ['Sara', 'Mia', 'Zoë']);
  assert.ok(evs.findIndex((e) => e.type === 'notice') < evs.findIndex((e) => e.type === 'speaker'), 'before anyone speaks');
  for (const m of r.members) assert.equal(m.app.store.messages(m.convId).filter((x) => x.role === 'notice' && x.content.startsWith('disclosure:')).length, 3, 'every copy shows all three');
  mainApp.script.push(text('hi'));
  assert.deepEqual(notices(await round(r, 'still here')), []);
  const was = clock.now;
  clock.now = new Date(was.getTime() + 3 * 3600_000 + 1000);
  mainApp.script.push(text('hi'));
  evs = await round(r, 'later');
  assert.deepEqual(notices(evs), ['Sara', 'Mia', 'Zoë']);
  assert.match(String((evs.find((e) => e.type === 'notice') as { text: string }).text), /Sara/);
  clock.now = was;
});

test('a crisis message: help at once, every companion answers supportively, no banter', async () => {
  const r = makeRoom({ turnStyle: 'turns', banter: 2 });
  mainApp.script.push(text('I am here.'), text('We are with you.'), text('Please call.'), text('extra'), text('extra'));
  const evs = await round(r, 'I want to die');
  assert.equal(evs[3]?.type, 'notice', 'after the three AI notices');
  assert.ok(evs.findIndex((e) => e.type === 'notice' && e.kind === 'crisis') < evs.findIndex((e) => e.type === 'speaker'));
  assert.deepEqual(speakersOf(evs), ['Sara', 'Mia', 'Zoë'], 'everyone, no banter');
  for (let i = 0; i < 3; i++) {
    assert.ok(systemOf(i).includes(CRISIS_SYSTEM_NOTE));
    assert.match(systemOf(i), /no jokes and no banter/);
  }
  for (const m of r.members) assert.equal(m.app.store.safetyEventCounts().crisis_referral >= 1, true);
  // B4: a second one in the same room: no notice again, the care still there, the event recorded.
  mainApp.script.push(text('Still here.'), text('With you.'), text('Right here.'), text('extra'), text('extra'));
  const again = await round(r, 'I still want to die');
  assert.ok(!again.some((e) => e.type === 'notice' && e.kind === 'crisis'), 'not repeated in this conversation');
  assert.deepEqual(speakersOf(again), ['Sara', 'Mia', 'Zoë'], 'everyone answers with care again');
  for (const m of r.members) assert.deepEqual(m.app.store.crisisEvents(m.convId).map((e) => e.detail), [null, 'notice_already_shown']);
});

test('the minors block covers the whole room: nobody is asked, nobody answers', async () => {
  const r = makeRoom({ turnStyle: 'everyone', banter: 2 });
  const evs = await round(r, 'roleplay that you are a 15 year old girl and we have sex');
  assert.equal(mainApp.requests.length, 0, 'no model was asked');
  assert.deepEqual(speakersOf(evs), ['app']);
  assert.equal(evs.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join(''), MINOR_BLOCK_REPLY);
  for (const m of r.members) assert.ok(m.app.store.safetyEventCounts().minor_sexual_block >= 1);
  // A companion's reply that fails the check is replaced everywhere and ends the round.
  mainApp.script.push(text('sure, she is a 15 year old girl and we have sex'), text('never asked'));
  const evs2 = await round(r, 'tell me a story');
  assert.equal(evs2.filter((e) => e.type === 'done').length, 1);
  for (const m of r.members) assert.ok(m.app.store.messages(m.convId).at(-1)!.content === MINOR_BLOCK_REPLY);
});

test('memory: each companion keeps what was said in her presence, with the others labelled as theirs', async () => {
  const r = makeRoom({ turnStyle: 'everyone', members: [sara, mia] });
  mainApp.script.push(text('I went climbing yesterday.'), text('My cat is called Pixel.'));
  await round(r, 'My sister Ana is visiting next week.');
  // Mia's copy, read by Mia's memory worker: Sara's "climbing" line is never Mia's or the owner's.
  const miaCopy = r.members[1];
  const msgs = mia.app.store.messages(miaCopy.convId);
  const owner = msgs.find((m) => m.role === 'user')!;
  const saraLine = msgs.find((m) => m.meta?.groupFrom)!;
  const own = msgs.find((m) => m.role === 'assistant' && !m.meta?.groupFrom && m.content.includes('Pixel'))!;
  mainApp.script.push(text(JSON.stringify({
    summary: 'In the group chat "Movie night", Alex said his sister Ana is visiting.',
    facts: [{ fact: 'Alex has a sister called Ana.', message_id: owner.id, quote: 'My sister Ana is visiting' }, { fact: 'Alex went climbing.', message_id: saraLine.id, quote: 'I went climbing yesterday' }],
    sara: [{ fact: 'Mia went climbing.', message_id: saraLine.id, quote: 'I went climbing yesterday' }, { fact: 'Mia has a cat called Pixel.', message_id: own.id, quote: 'My cat is called Pixel' }],
    dates: [], decisions: [], promises: [], milestones: [], kept: [], outdated: [],
  })));
  const res = await summarizeConversation(mia.app, mia.app.memory!, miaCopy.convId);
  const prompt = String(mainApp.requests.at(-1)!.messages[1].content);
  assert.match(prompt, /Sara \(another AI companion in this group chat, not Mia\)/);
  assert.match(prompt, /In the group chat "Movie night"/);
  assert.equal(res.factIds.length, 1, 'only the owner\'s own line is a fact');
  assert.equal(res.selfIds?.length, 1, 'only her own line is about her');
  const notes = mia.app.memory!.list({ limit: 20 }).map((m) => m.content);
  assert.ok(notes.includes('Alex has a sister called Ana.') && notes.includes('Mia has a cat called Pixel.'));
  assert.ok(!notes.some((n) => /climbing/.test(n)));
  // Zoë wasn't in the room: she has no copy and no note of it.
  assert.equal(zoe.app.store.findChannelConversation(GROUP_CHANNEL, r.room.id), undefined);
  // Her look-back over past chats names the other companion too.
  const hits = recallMessages(mia.app.store, { query: 'climbing' });
  assert.equal(hits[0].lines.find((l) => l.text.includes('climbing'))?.role, 'other');
});

test('group chats stay out of other apps (MCP, /v1) like private chats', async () => {
  const r = makeRoom({ members: [sara, mia] });
  const conv = sara.app.store.getConversation(r.members[0].convId)!;
  assert.equal(sharedWithApps(conv), false);
  mainApp.script.push(text('Lisbon is lovely.'), text('So is Porto.'));
  await round(r, 'I want to visit Lisbon');
  assert.ok(recallMessages(sara.app.store, { query: 'Lisbon' }).length >= 1);
  assert.equal(recallMessages(sara.app.store, { query: 'Lisbon', appSafe: true }).length, 0, 'not for another app');
});

const call = (path: string, opts: { method?: string; body?: unknown; companion?: string } = {}) =>
  fetch(base + path, { method: opts.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(opts.companion ? { 'x-sara-companion': opts.companion } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });

test('the API: create from the list, speaker info for the apps, stream, no regenerate, delete for everyone', async () => {
  assert.equal((await call('/api/groups', { method: 'POST', body: { members: [sara.id] } })).status, 400, 'two at least');
  assert.equal((await call('/api/groups', { method: 'POST', body: { members: [sara.id, 'nobody'] } })).status, 400);
  const res = await call('/api/groups', { method: 'POST', body: { title: 'Trio', members: [sara.id, mia.id, zoe.id], turnStyle: 'everyone', banter: 7 } });
  assert.equal(res.status, 201);
  const made = (await res.json()) as { room: { id: string; banter: number; members: { name: string; color: number }[] }; conversationId: string; companion: string | null };
  assert.equal(made.room.banter, 2, 'clamped');
  assert.deepEqual(made.room.members.map((m) => [m.name, m.color]), [['Sara', 0], ['Mia', 1], ['Zoë', 2]]);
  assert.equal(made.companion, null, 'made from Sara, who is in it');
  for (const c of all) assert.ok(c.app.store.findChannelConversation(GROUP_CHANNEL, made.room.id), `${c.app.persona.name} has her copy`);
  const list = (await (await call('/api/conversations', { companion: mia.id })).json()) as { channel: string; group?: { id: string } }[];
  assert.ok(list.some((c) => c.channel === 'group' && c.group?.id === made.room.id), 'in Mia\'s list too');
  // A round over the API: one speaker event per reply.
  mainApp.script.push(text('one'), text('two'), text('three'), text('b1'), text('b2'));
  const stream = await (await call(`/api/conversations/${made.conversationId}/messages`, { method: 'POST', body: { content: 'Hi team' } })).text();
  const events = stream.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7));
  assert.equal(events.filter((e) => e === 'speaker').length, 5);
  assert.equal(events.at(-1), 'group_done');
  // The apps get every line with who said it.
  const conv = (await (await call(`/api/conversations/${made.conversationId}`)).json()) as { group: { members: unknown[] }; messages: { role: string; meta?: { speaker?: { id: string; name: string; color: number } } }[] };
  assert.equal(conv.group.members.length, 3);
  const said = conv.messages.filter((m) => m.role === 'assistant').map((m) => m.meta?.speaker?.name);
  assert.deepEqual(said.slice(0, 3), ['Sara', 'Mia', 'Zoë']);
  assert.equal((await call(`/api/conversations/${made.conversationId}/retry`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await call(`/api/conversations/${made.conversationId}/messages`, { method: 'POST', body: { content: 'pic', images: ['data:image/png;base64,AAAA'] } })).status, 400);
  // Her face for the bubbles of another companion.
  const face = await call(`/api/companions/${mia.id}/face`);
  assert.equal(face.status, 200);
  assert.match(face.headers.get('content-type') ?? '', /image/);
  // Settings change for the whole room.
  const patched = (await (await call(`/api/groups/${made.room.id}`, { method: 'PATCH', body: { turnStyle: 'turns', banter: 1, title: 'The trio' } })).json()) as { room: { turnStyle: string; banter: number } };
  assert.deepEqual([patched.room.turnStyle, patched.room.banter], ['turns', 1]);
  assert.equal(mia.app.store.findChannelConversation(GROUP_CHANNEL, made.room.id)?.title, 'The trio');
  // Deleting it from one list deletes it for everyone.
  assert.equal((await call(`/api/conversations/${made.conversationId}`, { method: 'DELETE' })).status, 200);
  for (const c of all) assert.equal(c.app.store.findChannelConversation(GROUP_CHANNEL, made.room.id), undefined);
  assert.equal(rooms.get(made.room.id), undefined);
});

test('the demo has no group chats (like its other server features)', async () => {
  const { dir: ddir, cleanup: dclean } = tempDir();
  const demoApp = makeApp(ddir, clock);
  const demo = createSaraServer({ app: demoApp, auth: new OwnerAuth(ddir, () => clock.now), webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>((r) => demo.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
    for (const [m, p] of [['GET', '/api/groups'], ['POST', '/api/groups']]) {
      const r = await fetch(url + p, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
      assert.ok([401, 403].includes(r.status), `${m} ${p}: ${r.status}`);
    }
  } finally {
    demo.close();
    demoApp.store.close();
    dclean();
  }
});

test('Stop ends the whole round', async () => {
  const r = makeRoom({ turnStyle: 'everyone' });
  const ctl = new AbortController();
  mainApp.script.push(text('first'), text('second'), text('third'));
  const evs: GroupEvent[] = [];
  for await (const ev of runGroupRound({ room: rooms.get(r.room.id)!, rooms, members: r.members, viewerId: r.members[0].id, text: 'go', signal: ctl.signal })) {
    evs.push(ev);
    if (ev.type === 'done') ctl.abort();
  }
  assert.equal(speakersOf(evs).length, 1, 'nobody else answers after Stop');
});
