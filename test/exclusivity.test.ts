// 2026-11-28: her romantic and sexual exclusivity (src/exclusivity.ts): the decision for every
// combination, the turn's adult rule and notes (per message author in an NSFW channel), the legal
// lines unchanged, the declined-attempt count and the once-a-day note, the route, and one path
// through each bridge.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { DISCORD_VAULT, DiscordBridge, type GatewaySocket } from '../src/bridges/discord.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { turnScope, type GroupTurn } from '../src/chat.ts';
import { committedNote, countDeclinedAttempt, declinedCount, DEFAULT_EXCLUSIVITY, exclusivityDecision, exclusivityOf, type Exclusivity, type ExclusivityMode } from '../src/exclusivity.ts';
import { ADULT_OFF_NOTE, CRISIS_SYSTEM_NOTE, MINOR_BLOCK_REPLY, partnerNote } from '../src/safety.ts';
import { createSaraServer } from '../src/server.ts';
import { listen, makeApp, readBody, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const ADULT = { on: true, confirmedAt: '2026-10-24T00:00:00Z' };

function rigApp(t: TestContext, clock = { now: new Date('2026-11-28T12:00:00Z') }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock };
}

const ex = (mode: ExclusivityMode, o: Partial<Exclusivity> = {}): Exclusivity => ({ ...DEFAULT_EXCLUSIVITY, mode, ...o });

test('exclusivity: the default is only the owner; broken values fall back', () => {
  assert.deepEqual(exclusivityOf({}), { mode: 'owner', companions: [], discord: [], telegram: [] });
  assert.deepEqual(exclusivityOf({ exclusivity: { mode: 'weird' as never, discord: ['123456', 'bob', 123456 as never], telegram: ['-1001', '7x'], companions: ['mira', '../x'] } }), { mode: 'owner', companions: ['mira'], discord: ['123456'], telegram: ['-1001'] });
});

test('exclusivity: the decision for every combination', () => {
  const modes: ExclusivityMode[] = ['owner', 'allowed', 'anyone'];
  const list = ex('allowed', { discord: ['111111'], telegram: ['2222'], companions: ['mira'] });
  for (const mode of modes) {
    const e = mode === 'allowed' ? list : ex(mode, { discord: ['111111'], telegram: ['2222'], companions: ['mira'] });
    for (const adultMode of [true, false]) {
      for (const placeAdult of [true, false]) {
        const today = adultMode && placeAdult;
        // The owner's own chats: today's rule, never declined.
        assert.deepEqual(exclusivityDecision({ adultMode, placeAdult, kind: 'owner', ex: e }), { adult: today, declined: false });
        for (const [author, onList] of [
          [{ platform: 'discord', id: '111111' }, true],
          [{ platform: 'discord', id: '999999' }, false],
          [{ platform: 'telegram', id: '2222' }, true],
          [{ platform: 'telegram', id: '111111' }, false],
          [undefined, false],
        ] as const) {
          const ok = mode === 'anyone' || (mode === 'allowed' && onList);
          const d = exclusivityDecision({ adultMode, placeAdult, kind: 'partner', ...(author ? { author } : {}), ex: e });
          assert.deepEqual(d, { adult: today && ok, declined: today && !ok }, `${mode} adult=${adultMode} place=${placeAdult} ${JSON.stringify(author)}`);
        }
        // The owner's own id in a partner chat is always allowed.
        assert.equal(exclusivityDecision({ adultMode, placeAdult, kind: 'partner', author: { platform: 'telegram', id: '5', owner: true }, ex: e }).adult, today);
        for (const [others, allOnList] of [[['mira'], true], [['mira', 'zoe'], false], [['zoe'], false], [[], true]] as const) {
          const ok = mode === 'anyone' || others.length === 0 || (mode === 'allowed' && allOnList);
          const d = exclusivityDecision({ adultMode, placeAdult, kind: 'group', otherIds: others, ex: e });
          assert.deepEqual(d, { adult: today && ok, declined: today && !ok }, `group ${mode} adult=${adultMode} place=${placeAdult} ${others.join(',')}`);
        }
      }
    }
  }
});

test('exclusivity: the turn in an NSFW partner chat is decided per author; the legal lines stay', (t) => {
  const { app } = rigApp(t);
  app.settings.update({ adultMode: ADULT, exclusivity: { mode: 'allowed', discord: ['111111'] } });
  const conv = app.store.createConversation({ channel: 'discord-nsfw', channelKey: '300', partner: 'people in a Discord channel' });
  const allowed = turnScope(app, conv, { partnerAuthor: { platform: 'discord', id: '111111', name: 'Bob' }, text: '[Bob]: hi' });
  assert.equal(allowed.adultOn, true);
  assert.match(allowed.sections.safetyNotes.join('\n'), /age-restricted \(NSFW\) channel on discord/);
  assert.doesNotMatch(allowed.sections.safetyNotes.join('\n'), /committed to Alex/);
  const other = turnScope(app, conv, { partnerAuthor: { platform: 'discord', id: '222222', name: 'Eve' }, text: '[Eve]: hi' });
  assert.equal(other.adultOn, false);
  const notes = other.sections.safetyNotes;
  // Exactly the strict conduct of a non-NSFW channel, then her commitment in her own voice.
  assert.equal(notes[0], partnerNote('people in a Discord channel', 'Alex', 'discord', true, false));
  assert.equal(notes[1], committedNote('Alex', 'partner'));
  assert.match(notes[1], /committed to Alex[\s\S]*in your own voice[\s\S]*stay friendly/);
  // The legal lines are word for word as before: minors forbidden in the adult note, AI disclosure in both.
  assert.match(allowed.sections.safetyNotes[0], /anything involving minors is still absolutely forbidden/);
  for (const n of [allowed.sections.safetyNotes[0], notes[0]]) assert.match(n, /If anyone sincerely asks whether you're an AI, say plainly that you are an AI companion\./);
  assert.equal(MINOR_BLOCK_REPLY, "No. I won't do anything sexual involving minors, ever. Let's talk about something else.");
  assert.match(CRISIS_SYSTEM_NOTE, /^The owner may be in crisis or thinking about self-harm\./);
  // No author known (an old queued item): strict.
  assert.equal(turnScope(app, conv, {}).adultOn, false);
  // Mode anyone: today's behaviour, no commitment note.
  app.settings.update({ exclusivity: { mode: 'anyone' } });
  const any = turnScope(app, conv, { partnerAuthor: { platform: 'discord', id: '222222' } });
  assert.equal(any.adultOn, true);
  assert.equal(any.sections.safetyNotes.length, 1);
});

test('exclusivity: no change with Adult mode off, outside NSFW places, or in the owner\'s own chats', (t) => {
  const { app } = rigApp(t);
  const nsfw = app.store.createConversation({ channel: 'discord-nsfw', channelKey: '300', partner: 'people in a Discord channel' });
  const plain = app.store.createConversation({ channel: 'discord', channelKey: '200', partner: 'people in a Discord channel' });
  const own = app.store.createConversation();
  const who = { partnerAuthor: { platform: 'discord' as const, id: '222222' } };
  // Adult mode off: as before (strict partner note, Adult-off note in the owner's chat).
  assert.deepEqual(turnScope(app, nsfw, who).sections.safetyNotes, [partnerNote('people in a Discord channel', 'Alex', 'discord-nsfw', false, false)]);
  assert.ok(turnScope(app, own).sections.safetyNotes.includes(ADULT_OFF_NOTE));
  app.settings.update({ adultMode: ADULT });
  // Default (only the owner): his own chats keep adult content; a non-NSFW partner chat is as before.
  assert.equal(turnScope(app, own).adultOn, true);
  assert.ok(!turnScope(app, own).sections.safetyNotes.includes(ADULT_OFF_NOTE));
  assert.deepEqual(turnScope(app, plain, who).sections.safetyNotes, [partnerNote('people in a Discord channel', 'Alex', 'discord', true, false)]);
});

test('exclusivity: in-app groups need every other companion on her list (the owner always counts)', (t) => {
  const { app } = rigApp(t);
  app.settings.update({ adultMode: ADULT, exclusivity: { mode: 'allowed', companions: ['mira'] } });
  const conv = app.store.createConversation({ channel: 'group' });
  const g = (otherIds: string[], adult = true): GroupTurn => ({ ownerTurn: true, crisis: false, adult, others: otherIds, otherIds, note: 'You are in a group chat.' });
  assert.equal(turnScope(app, conv, { group: g(['mira']) }).adultOn, true);
  const no = turnScope(app, conv, { group: g(['mira', 'zoe']) });
  assert.equal(no.adultOn, false);
  assert.ok(no.sections.safetyNotes.includes(committedNote('Alex', 'group')));
  assert.ok(!no.sections.safetyNotes.includes(ADULT_OFF_NOTE));
  // The room doesn't allow it today: the usual note, nothing about her commitment.
  const off = turnScope(app, conv, { group: g(['mira'], false) });
  assert.equal(off.adultOn, false);
  assert.ok(off.sections.safetyNotes.includes(ADULT_OFF_NOTE));
  app.settings.update({ exclusivity: { mode: 'owner' } });
  assert.equal(turnScope(app, conv, { group: g(['mira']) }).adultOn, false);
  app.settings.update({ exclusivity: { mode: 'anyone' } });
  assert.equal(turnScope(app, conv, { group: g(['mira', 'zoe']) }).adultOn, true);
});

test('exclusivity: declined attempts are counted; 3 in 24 hours make one note a day, without the words', (t) => {
  const { app, clock } = rigApp(t);
  app.settings.update({ adultMode: ADULT });
  const home = app.store.createConversation();
  app.store.addMessage(home.id, 'user', 'hello');
  const conv = app.store.createConversation({ title: 'Discord: #lounge', channel: 'discord-nsfw', channelKey: '300', partner: 'people in a Discord channel' });
  const eve = { platform: 'discord' as const, id: '222222', name: 'Eve' };
  const words = '[Eve]: lets have sex right now';
  assert.equal(countDeclinedAttempt(app, conv, eve, '[Eve]: how are you?'), false, 'not explicit');
  assert.equal(countDeclinedAttempt(app, app.store.createConversation(), eve, words), false, 'not a partner chat');
  const notes = () => app.store.listConversations().flatMap((c) => app.store.messages(c.id)).filter((m) => m.meta?.exclusivity);
  assert.equal(countDeclinedAttempt(app, conv, eve, words), true);
  assert.equal(countDeclinedAttempt(app, conv, eve, words), true);
  assert.equal(notes().length, 0);
  assert.equal(countDeclinedAttempt(app, conv, eve, words), true);
  assert.equal(notes().length, 1);
  const note = notes()[0];
  assert.match(note.content, /^Eve \(Discord 222222\) tried to make things sexual with me 3 times in the last day, in Discord: #lounge\. I kept it friendly/);
  assert.doesNotMatch(note.content, /sex right now/);
  countDeclinedAttempt(app, conv, eve, words);
  assert.equal(notes().length, 1, 'once per person per day');
  // Someone else has their own count.
  const bob = { platform: 'telegram' as const, id: '3333', name: 'Bob' };
  for (let i = 0; i < 3; i++) countDeclinedAttempt(app, conv, bob, '[Bob]: lets have sex right now');
  assert.equal(notes().length, 2);
  assert.equal(declinedCount(app, 7), 7);
  // The next day, three more: one more note.
  clock.now = new Date('2026-11-29T13:00:00Z');
  for (let i = 0; i < 3; i++) countDeclinedAttempt(app, conv, eve, words);
  assert.equal(notes().length, 3);
  // Allowed people, mode anyone and Adult mode off are never counted.
  app.settings.update({ exclusivity: { mode: 'allowed', discord: ['222222'] } });
  assert.equal(countDeclinedAttempt(app, conv, eve, words), false);
  app.settings.update({ exclusivity: { mode: 'anyone' } });
  assert.equal(countDeclinedAttempt(app, conv, bob, '[Bob]: lets have sex right now'), false);
  app.settings.update({ exclusivity: { mode: 'owner' }, adultMode: { on: false } });
  assert.equal(countDeclinedAttempt(app, conv, bob, '[Bob]: lets have sex right now'), false);
  clock.now = new Date('2026-12-10T13:00:00Z');
  assert.equal(declinedCount(app, 7), 0);
});

async function routeRig(t: TestContext, mode: 'owner' | 'member' | 'demo') {
  const { app } = rigApp(t);
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Sam', status: 'active', limits: {} }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const api = async (path: string, method = 'GET', body?: unknown, token: string | null = auth.newToken ?? null) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  return { app, api };
}

test('exclusivity route: the owner reads and saves at once; ids are checked; signed out refused', async (t) => {
  const { app, api } = await routeRig(t, 'owner');
  let r = await api('/api/exclusivity');
  assert.equal(r.status, 200);
  assert.equal(r.body.adultOn, false);
  assert.deepEqual(r.body.exclusivity, DEFAULT_EXCLUSIVITY);
  assert.equal(r.body.declined7d, 0);
  r = await api('/api/exclusivity', 'PUT', { mode: 'allowed', discord: ['111111', '111111'], telegram: ['2222'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.exclusivity, { mode: 'allowed', companions: [], discord: ['111111'], telegram: ['2222'] });
  assert.deepEqual(app.settings.get().exclusivity, { mode: 'allowed', companions: [], discord: ['111111'], telegram: ['2222'] });
  assert.equal((await api('/api/exclusivity', 'PUT', { discord: ['Bob#1234'] })).status, 400, 'names are refused');
  assert.equal((await api('/api/exclusivity', 'PUT', { mode: 'everyone' })).status, 400);
  assert.deepEqual((await api('/api/exclusivity', 'PUT', { companions: ['nobody'] })).body.exclusivity.companions, [], 'only companions on this server');
  assert.equal((await api('/api/exclusivity', 'GET', undefined, null)).status, 401);
  assert.equal((await api('/api/exclusivity', 'PUT', { mode: 'anyone' }, null)).status, 401);
  assert.equal(app.settings.get().exclusivity?.mode, 'allowed');
});

test('exclusivity route: never on the demo; a household member sets it for their own companion', async (t) => {
  const demo = await routeRig(t, 'demo');
  assert.equal((await demo.api('/api/exclusivity')).status, 403);
  assert.equal((await demo.api('/api/exclusivity', 'PUT', { mode: 'anyone' })).status, 403);
  assert.equal(demo.app.settings.get().exclusivity, undefined);
  const member = await routeRig(t, 'member');
  const r = await member.api('/api/exclusivity', 'PUT', { mode: 'anyone' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.companions, []);
  assert.equal(member.app.settings.get().exclusivity?.mode, 'anyone');
});

// ------------------------------------------------------------------ one path through each bridge

const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const BOT = { id: '900', username: 'Sara', bot: true };

test('exclusivity via Discord: in one NSFW channel the allowed person gets adult content, the other does not', async (t) => {
  const { app } = rigApp(t, { now: new Date('2026-10-24T20:00:00Z') });
  const { server, url } = await listen(async (req, res) => {
    await readBody(req);
    const path = req.url ?? '';
    let result: unknown = {};
    if (path === '/users/@me') result = BOT;
    else if (/^\/channels\/\d+$/.test(path) && req.method === 'GET') result = { id: path.split('/')[2], nsfw: true };
    else if (path.endsWith('/messages') && req.method === 'POST') result = { id: '1' };
    else if (path.endsWith('/typing')) return void res.writeHead(204).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  app.settings.update({ discord: { enabled: true, allowServers: true, mirror: false, ownerUserId: '100' }, routes: { adult: { providerId: 'p', model: 'adult-model' } }, adultMode: ADULT, exclusivity: { mode: 'allowed', discord: ['111111'] } });
  app.vault.set(DISCORD_VAULT, TOKEN);
  const bridge = new DiscordBridge(app, { api: url, connect: () => ({ send: () => undefined, close: () => undefined, onmessage: null, onclose: null }) as GatewaySocket });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    server.close();
  });
  const say = (id: string, name: string, n: string) => bridge.handleMessage({ id: n, channel_id: '300', guild_id: 'g', author: { id, username: name.toLowerCase(), global_name: name }, content: '<@900> you are so sexy', mentions: [BOT] } as never);
  app.script.push(text('Mm, hi Bob.'), text('Ha, flattering, but I’m with Alex.'));
  await say('111111', 'Bob', '1');
  let req = app.requests.at(-1)!;
  assert.equal(req.model, 'adult-model');
  assert.match(req.messages[0].content as string, /age-restricted \(NSFW\) channel on discord/);
  await say('222222', 'Eve', '2');
  req = app.requests.at(-1)!;
  assert.notEqual(req.model, 'adult-model');
  assert.match(req.messages[0].content as string, /strictly non-romantic and non-sexual[\s\S]*committed to Alex/);
  assert.equal(declinedCount(app), 1, 'Eve\'s attempt is counted, Bob\'s is not');
});

test('exclusivity via Telegram: an adult group follows the list by user id', async (t) => {
  const { app } = rigApp(t, { now: new Date('2026-10-24T20:00:00Z') });
  const T = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const { server, url } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    await readBody(req);
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : method === 'sendMessage' ? { message_id: 1 } : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  app.settings.update({ telegram: { enabled: true, allowOthers: true, mirror: false, ownerChatId: 1001, nsfwChatIds: [-100780] }, routes: { adult: { providerId: 'p', model: 'adult-model' } }, adultMode: ADULT, exclusivity: { mode: 'allowed', telegram: ['3003'] } });
  app.vault.set(TELEGRAM_VAULT, T);
  const bridge = new TelegramBridge(app, { apiBase: url });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    server.close();
  });
  let uid = 1;
  const group = (fromId: number, name: string) => ({ update_id: uid++, message: { message_id: uid, chat: { id: -100780, type: 'supergroup' as const, title: 'Crew' }, from: { id: fromId, first_name: name }, text: '@sara_test_bot you are so sexy' } });
  app.script.push(text('Mm.'), text('I’m with Alex, but hi!'));
  await bridge.handle(group(3003, 'Bob'));
  assert.equal(app.requests.at(-1)!.model, 'adult-model');
  await bridge.handle(group(4004, 'Eve'));
  assert.notEqual(app.requests.at(-1)!.model, 'adult-model');
  assert.match(app.requests.at(-1)!.messages[0].content as string, /committed to Alex/);
});
