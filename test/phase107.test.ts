// Phase 107 (CH1): chat commands in every channel (docs/design/CHATS.md §4.11 "Done when"), against
// a fake Telegram Bot API and a fake Discord gateway + REST, plus the app's own routes.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { commandAllowed, nearlyFullOffer, parseCommand, say } from '../src/bridges/commands.ts';
import { DISCORD_VAULT, DiscordBridge, type GatewaySocket } from '../src/bridges/discord.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { createSaraServer } from '../src/server.ts';
import { call, listen, makeApp, readBody, tempDir, text, type TestApp } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const TG_TOKEN = '123456789:***';
const OWNER = 1001;
let uid = 1;

async function fakeTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  return { sent, url, close: () => server.close(), texts: (chat: number) => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === chat).map((s) => String(s.body.text)) };
}

async function tgSetup(t: { after: (fn: () => void) => void }, telegram: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-31T20:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  const tg = await fakeTelegram();
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', telegram: { enabled: true, allowOthers: true, mirror: false, ownerChatId: OWNER, ...telegram } });
  app.vault.set(TELEGRAM_VAULT, TG_TOKEN);
  let nudges = 0;
  app.memoryNudge = () => void nudges++;
  const bridge = new TelegramBridge(app, { apiBase: tg.url });
  await bridge.restart();
  await bridge.menus;
  t.after(() => {
    bridge.stop();
    tg.close();
    app.store.close();
    cleanup();
  });
  return { app, bridge, tg, clock, nudges: () => nudges };
}

const dm = (chatId: number, txt: string, o: { name?: string; lang?: string } = {}) => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, first_name: o.name ?? 'Alex', ...(o.lang ? { language_code: o.lang } : {}) }, text: txt } });
const grp = (chatId: number, fromId: number, txt: string, o: { name?: string; lang?: string } = {}) => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'supergroup' as const, title: 'Crew' }, from: { id: fromId, first_name: o.name ?? 'Bob', ...(o.lang ? { language_code: o.lang } : {}) }, text: txt } });
const notices = (app: TestApp, convId: string) => app.store.messages(convId).filter((m) => m.role === 'notice' && m.content.startsWith('command:')).map((m) => m.content);
const until = async <T>(fn: () => T | undefined, ms = 3000): Promise<T> => {
  for (let i = 0; i < ms / 20; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for state');
};

test('parsing: typed, @bot, name form in six languages; questions and other bots stay messages', () => {
  const o = { herName: 'Sara', botUsername: 'sara_test_bot', namePrefix: true };
  assert.equal(parseCommand('/new', o)?.name, 'new');
  assert.equal(parseCommand('/New', o)?.name, 'new', 'phones capitalise');
  assert.equal(parseCommand('!status', o)?.name, 'status');
  assert.equal(parseCommand('/new@sara_test_bot', o)?.name, 'new');
  assert.equal(parseCommand('/new@otherbot', o), undefined, 'for another bot');
  assert.equal(parseCommand('/shrug', o), undefined, 'unknown words stay messages');
  assert.deepEqual(parseCommand('/remember I water the ferns on Sundays', o), { name: 'remember', args: 'I water the ferns on Sundays', form: 'typed' });
  assert.equal(parseCommand('Sara new', o)?.name, 'new');
  assert.equal(parseCommand('Sara, stop', o)?.name, 'stop');
  assert.equal(parseCommand('@Sara status', o)?.name, 'status');
  assert.equal(parseCommand('@sara_test_bot help', o)?.name, 'help');
  assert.equal(parseCommand('Sara neu', o)?.name, 'new', 'German');
  assert.equal(parseCommand('Sara nouveau', o)?.name, 'new', 'French');
  assert.equal(parseCommand('Sara aiuto', o)?.name, 'help', 'Italian');
  assert.equal(parseCommand('Sara réinitialiser', o)?.name, 'reset', 'accents folded');
  assert.equal(parseCommand('Sara, new idea for the garden', o), undefined, 'more than one word: a message');
  assert.equal(parseCommand('Sara, status?', o), undefined, 'a question is not a command');
  assert.equal(parseCommand('Sara remember', o), undefined, 'remember needs the slash form');
  assert.equal(parseCommand('Sara new', { ...o, namePrefix: false }), undefined, 'name form switched off');
  assert.equal(parseCommand('Sarah new', o), undefined, 'another name');
});

test('who may run what: the owner everywhere, others only a few, bots nothing', () => {
  for (const n of ['new', 'reset', 'stop', 'status', 'help', 'model', 'remember'] as const) assert.ok(commandAllowed('room', 'owner', n));
  assert.ok(commandAllowed('partner-dm', 'person', 'new') && commandAllowed('partner-dm', 'person', 'reset') && commandAllowed('partner-dm', 'person', 'stop'));
  assert.ok(!commandAllowed('partner-dm', 'person', 'model') && !commandAllowed('partner-dm', 'person', 'remember'));
  assert.ok(commandAllowed('room', 'person', 'help') && commandAllowed('room', 'person', 'status'));
  assert.ok(!commandAllowed('room', 'person', 'new') && !commandAllowed('room', 'person', 'stop') && !commandAllowed('work-room', 'person', 'reset'));
  assert.ok(!commandAllowed('owner-dm', 'bot', 'help'));
});

test('telegram /new in the owner DM: closes the session, opens a new one, nudges memory, notices in both', async (t) => {
  const { app, bridge, tg, nudges } = await tgSetup(t);
  app.script.push(text('Hi Alex.'));
  await bridge.handle(dm(OWNER, 'hello'));
  const first = app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!;
  const before = app.requests.length;
  const ownerAt = app.store.lastOwnerMessageAt()?.toISOString();
  const n0 = nudges();
  await bridge.handle(dm(OWNER, '/new'));
  assert.equal(app.requests.length, before, 'commands never go to a model');
  assert.match(tg.texts(OWNER).at(-1)!, /^New session started\. I kept the last one \("Telegram"\)\.$/);
  const old = app.store.getConversation(first.id)!;
  assert.ok(old.endedAt, 'the old session is ended');
  const cur = app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!;
  assert.notEqual(cur.id, first.id);
  assert.equal(cur.sessionOf, first.id);
  assert.equal(nudges(), n0 + 1, 'memory worker nudged for the old one');
  assert.deepEqual(notices(app, first.id), ['command:new']);
  assert.deepEqual(notices(app, cur.id), ['command:new']);
  assert.equal(app.store.lastOwnerMessageAt()?.toISOString(), ownerAt, 'a command is not "the owner spoke"');
  // The next message lands in the new session; the old one keeps its lines.
  app.script.push(text('Fresh start!'));
  await bridge.handle(dm(OWNER, 'next thing'));
  assert.ok(app.store.messages(cur.id).some((m) => m.role === 'user' && m.content === 'next thing'));
  assert.ok(!app.store.messages(first.id).some((m) => m.content === 'next thing'));
  assert.equal(app.store.findChannelConversation('telegram', String(OWNER), 'owner')!.id, cur.id, 'the old lookup finds the open session');
  assert.equal(app.store.firstChannelConversation('telegram', String(OWNER), 'owner')!.id, first.id, 'imports keep the first');
  assert.equal(app.store.sessionsOf(cur).length, 2);
  // /new@otherbot is for another bot: a normal message.
  app.script.push(text('Okay.'));
  await bridge.handle(dm(OWNER, '/new@otherbot'));
  assert.equal(app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!.id, cur.id);
  assert.equal(app.requests.length, before + 2);
  // Plain /start from the owner is /help.
  await bridge.handle(dm(OWNER, '/start'));
  assert.match(tg.texts(OWNER).at(-1)!, /^What you can do here:[\s\S]*\/new: [\s\S]*\/model: /);
});

test('telegram groups: /new@herbot works for the owner and is refused once, translated, for others', async (t) => {
  const { app, bridge, tg } = await tgSetup(t, { ownerWorkInGroups: true });
  app.script.push(text('On it.'));
  await bridge.handle(grp(-100500, OWNER, '@sara_test_bot check the build', { name: 'Alex' }));
  const work = app.store.currentChannelConversation('telegram-work', '-100500', 'owner')!;
  await bridge.handle(grp(-100500, OWNER, '/new@sara_test_bot', { name: 'Alex' }));
  assert.ok(app.store.getConversation(work.id)!.endedAt, "his work session is closed (the room's isn't)");
  assert.match(tg.texts(-100500).at(-1)!, /^New session started/);
  const before = app.requests.length;
  const sent = tg.texts(-100500).length;
  await bridge.handle(grp(-100500, 3003, '/new@sara_test_bot', { lang: 'de' }));
  assert.equal(tg.texts(-100500).length, sent + 1, 'one line');
  assert.equal(tg.texts(-100500).at(-1), say(app, 'de', 'Only the person who runs me can use that here.'));
  assert.notEqual(tg.texts(-100500).at(-1), 'Only the person who runs me can use that here.', 'German, not English');
  assert.equal(app.requests.length, before, 'no turn for a refused command');
  // /model refused for a partner in a group and in their DM; /remember too.
  await bridge.handle(grp(-100500, 3003, '/model@sara_test_bot'));
  assert.equal(tg.texts(-100500).at(-1), 'Only the person who runs me can change that.');
  await bridge.handle(dm(4004, '/model', { name: 'Cleo' }));
  assert.equal(tg.texts(4004).at(-1), 'Only the person who runs me can change that.');
  await bridge.handle(dm(4004, '/remember my birthday is in May', { name: 'Cleo' }));
  assert.equal(tg.texts(4004).at(-1), "I don't keep memories in this chat.");
  assert.equal(app.requests.length, before);
  // The partner /status in a room is the short one; the owner's goes to his DM.
  await bridge.handle(grp(-100500, 3003, '/status@sara_test_bot'));
  assert.match(tg.texts(-100500).at(-1)!, /^I'm Sara, an AI companion\. This chat is \d+% full\.$/);
  await bridge.handle(grp(-100500, OWNER, '/status@sara_test_bot', { name: 'Alex' }));
  assert.equal(tg.texts(-100500).at(-1), 'I sent you the details in our private chat.');
  assert.match(tg.texts(OWNER).at(-1)!, /Model: m \(P\)[\s\S]*Context used: \d+%[\s\S]*Budget per reply/);
  // /new room (owner only) also starts a new conversation for the room.
  app.script.push(text('Hi Bob.'));
  await bridge.handle(grp(-100500, 3003, '@sara_test_bot hi'));
  const room = app.store.currentChannelConversation('telegram', '-100500', 'partner')!;
  await bridge.handle(grp(-100500, OWNER, '/new@sara_test_bot room', { name: 'Alex' }));
  assert.ok(app.store.getConversation(room.id)!.endedAt);
  const room2 = app.store.currentChannelConversation('telegram', '-100500', 'partner')!;
  assert.equal(room2.sessionOf, room.id);
  assert.match(tg.texts(-100500).at(-1)!, /for you and for the room/);
});

test('telegram /stop mid-turn saves the partial reply; /reset denies approvals, empties the queue, marks the line skipped', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  app.settings.update({ toolPermissions: { write_file: 'ask' } });
  app.script.push([...text('Let me write that down. '), call('w', 'write_file', { path: 'a.txt', content: 'x' })], text('Never sent.'));
  const turn = bridge.handle(dm(OWNER, 'write a note'));
  const conv = await until(() => app.store.currentChannelConversation('telegram', String(OWNER), 'owner'));
  await until(() => app.approvals.pendingFor(conv.id).length > 0 || undefined);
  await bridge.handle(dm(OWNER, '/stop'));
  await turn;
  assert.equal(tg.texts(OWNER).filter((x) => x === 'Stopped.').length, 1);
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'assistant' && m.content.includes('Let me write that down')), 'the partial reply is saved');
  assert.ok(!tg.texts(OWNER).includes('Never sent.'));
  // /stop with nothing running says nothing.
  const n = tg.texts(OWNER).length;
  await bridge.handle(dm(OWNER, '/stop'));
  assert.equal(tg.texts(OWNER).length, n);

  // /reset: a turn waiting on approval, one more message queued behind it.
  app.script.length = 0;
  app.script.push([call('w2', 'write_file', { path: 'b.txt', content: 'y' })], text('Done anyway.'));
  const turn2 = bridge.handle(dm(OWNER, 'write another'));
  await until(() => app.approvals.pendingFor(conv.id).length > 0 || undefined);
  const queued = bridge.handle(dm(OWNER, 'and this one'));
  await bridge.handle(dm(OWNER, '/reset'));
  await Promise.all([turn2, queued]);
  assert.match(tg.texts(OWNER).at(-1)!, /^Cleared\. I'm listening\. 1 request was cancelled\.$|^Done anyway\.$/);
  assert.ok(tg.texts(OWNER).some((x) => x === "Cleared. I'm listening. 1 request was cancelled."));
  assert.ok(!app.store.messages(conv.id).some((m) => m.role === 'user' && m.content === 'and this one'), 'the queued message was dropped');
  assert.deepEqual(app.approvals.pendingFor(conv.id), []);
  // A trailing line with no answer (a crash) is marked skipped and not answered on Continue.
  const orphan = app.store.addMessage(conv.id, 'user', 'lost line');
  await bridge.handle(dm(OWNER, '/reset'));
  assert.equal(app.store.messageById(orphan.id)!.meta?.skipped, true);
  const evs: string[] = [];
  for await (const ev of runTurn(app, conv.id, 'x', undefined, { resume: true })) if (ev.type === 'error') evs.push(ev.message);
  assert.deepEqual(evs, ['Nothing to continue.']);
  assert.ok(!tg.texts(OWNER).includes('Done anyway.'), 'the stopped turn sent nothing more');
  // Messages after it are answered normally.
  app.script.length = 0;
  app.script.push(text('Back with you.'));
  await bridge.handle(dm(OWNER, 'hello again'));
  assert.equal(tg.texts(OWNER).at(-1), 'Back with you.');
});

test('telegram poll loop: an update is queued, not awaited, so /stop is read while she answers', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  app.settings.update({ toolPermissions: { write_file: 'ask' } });
  app.script.push([call('w', 'write_file', { path: 'q.txt', content: 'x' })], text('Not sent.'));
  // The way the poll loop calls it: returns once the turn is in the queue.
  await bridge.handle(dm(OWNER, 'write it'), { queued: true });
  const conv = await until(() => app.store.currentChannelConversation('telegram', String(OWNER), 'owner'));
  await until(() => app.approvals.pendingFor(conv.id).length > 0 || undefined);
  await bridge.handle(dm(OWNER, '/stop'), { queued: true });
  await until(() => tg.texts(OWNER).includes('Stopped.') || undefined);
  await until(() => !app.isBusy?.(conv.id) && app.approvals.pendingFor(conv.id).length === 0 || undefined);
  assert.ok(!tg.texts(OWNER).includes('Not sent.'));
});

test('telegram /model: a pick sets this session only; /remember follows the tool permission', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  app.script.push(text('Hi.'));
  await bridge.handle(dm(OWNER, 'hi'));
  const conv = app.store.currentChannelConversation('telegram', String(OWNER), 'owner')!;
  const other = app.store.createConversation();
  await bridge.handle(dm(OWNER, '/model'));
  const kb = tg.sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === OWNER).at(-1)!;
  const rows = (kb.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  const large = rows.find((r) => r[0].text.startsWith('fake-large'))![0];
  assert.match(large.callback_data, /^md:[\w-]+:\d+$/);
  // Someone else pressing it changes nothing.
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q0', from: { id: 4004 }, data: large.callback_data } });
  assert.equal(app.store.getConversation(conv.id)!.model, null);
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q1', from: { id: OWNER }, data: large.callback_data, message: { message_id: 9, chat: { id: OWNER, type: 'private' } } } });
  assert.equal(app.store.getConversation(conv.id)!.model, 'fake-large');
  assert.equal(app.store.getConversation(conv.id)!.providerId, 'p');
  assert.equal(app.store.getConversation(other.id)!.model, null, 'other sessions unchanged');
  assert.equal(app.settings.get().defaultModel, 'm', 'the default unchanged');
  assert.match(tg.texts(OWNER).at(-1)!, /^This session now uses fake-large \(P\)\.$/);
  await bridge.handle(dm(OWNER, '/model default'));
  assert.equal(app.store.getConversation(conv.id)!.model, null);
  // /remember: allowed by default → saved with his own words.
  await bridge.handle(dm(OWNER, '/remember I water the ferns on Sundays'));
  assert.equal(tg.texts(OWNER).at(-1), 'Got it: "I water the ferns on Sundays".');
  const fact = app.memory!.list({ kind: 'fact' }).find((m) => m.content === 'I water the ferns on Sundays')!;
  assert.equal(fact.evidence, 'I water the ferns on Sundays');
  // Set to ask: Allow / Deny first.
  app.settings.update({ toolPermissions: { remember_fact: 'ask' } });
  await bridge.handle(dm(OWNER, '/remember My sister is called Ana'));
  const ask = tg.sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === OWNER).at(-1)!;
  assert.equal(ask.body.text, 'Remember this? "My sister is called Ana"');
  assert.ok(!app.memory!.list({ kind: 'fact' }).some((m) => m.content === 'My sister is called Ana'), 'nothing saved before Allow');
  const allow = (ask.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0].callback_data;
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q2', from: { id: OWNER }, data: allow } });
  await until(() => app.memory!.list({ kind: 'fact' }).find((m) => m.content === 'My sister is called Ana'));
  await until(() => tg.texts(OWNER).at(-1) === 'Got it: "My sister is called Ana".' || undefined);
  app.settings.update({ toolPermissions: { remember_fact: 'never' } });
  await bridge.handle(dm(OWNER, '/remember nope'));
  assert.equal(tg.texts(OWNER).at(-1), 'Remembering on command is turned off in Settings.');
});

test('telegram menus: setMyCommands per scope and language, skipped on an unchanged hash', async (t) => {
  const { app, bridge, tg } = await tgSetup(t, { allowOthers: false });
  const calls = tg.sent.filter((s) => s.method === 'setMyCommands');
  // all_private_chats, all_group_chats, the owner's chat: each in the default + 5 languages.
  assert.equal(calls.length, 3 * 6);
  const scopes = calls.map((c) => `${(c.body.scope as { type: string }).type}:${c.body.language_code ?? '-'}`);
  for (const type of ['all_private_chats', 'all_group_chats', 'chat']) for (const l of ['-', 'es', 'fr', 'de', 'pt', 'it']) assert.ok(scopes.includes(`${type}:${l}`), `${type} ${l}`);
  const names = (c: { body: Record<string, unknown> }) => (c.body.commands as { command: string }[]).map((x) => x.command);
  assert.deepEqual(names(calls.find((c) => (c.body.scope as { type: string }).type === 'all_private_chats')!), ['help'], 'others only get help when they may not talk to her');
  assert.deepEqual(names(calls.find((c) => (c.body.scope as { type: string }).type === 'all_group_chats')!), ['help', 'status']);
  assert.deepEqual(names(calls.find((c) => (c.body.scope as { type: string; chat_id?: number }).chat_id === OWNER)!), ['new', 'reset', 'stop', 'status', 'help', 'model', 'remember', 'settings']);
  const de = calls.find((c) => c.body.language_code === 'de' && (c.body.scope as { type: string }).type === 'chat')!;
  assert.notEqual((de.body.commands as { description: string }[])[0].description, 'Start a fresh session (the last one is kept)', 'German descriptions');
  assert.equal((await bridge.registerMenus()).skipped, true, 'same lists: nothing sent');
  assert.equal(tg.sent.filter((s) => s.method === 'setMyCommands').length, 18);
  // Others allowed + owner work in a group: the private list grows and the group gets a chat_member scope.
  app.settings.update({ telegram: { ...app.settings.get().telegram!, allowOthers: true, ownerWorkInGroups: true } });
  app.store.createConversation({ title: 'w', channel: 'telegram-work', channelKey: '-100600' });
  const r = await bridge.registerMenus();
  assert.equal(r.calls, 4 * 6);
  const member = tg.sent.filter((s) => s.method === 'setMyCommands' && (s.body.scope as { type: string }).type === 'chat_member');
  assert.equal(member.length, 6);
  assert.deepEqual(member[0].body.scope, { type: 'chat_member', chat_id: -100600, user_id: OWNER });
  assert.ok(bridge.status().menu?.at, 'the card shows when the menu was set');
});

test('nearly full: offered once at 85 % or when older parts are left out, never in a room, never twice', async (t) => {
  const { app, bridge, tg } = await tgSetup(t, { ownerWorkInGroups: false });
  app.settings.update({ historyBudgetChars: 2000 });
  app.script.push(text('Sure.'));
  await bridge.handle(dm(OWNER, 'x'.repeat(1700)));
  const offer = "ℹ️ This chat is getting long. Send /new for a fresh start; I'll keep a summary of this one.";
  assert.equal(tg.texts(OWNER).filter((x) => x === offer).length, 1);
  app.script.push(text('Again.'));
  await bridge.handle(dm(OWNER, 'more'));
  assert.equal(tg.texts(OWNER).filter((x) => x === offer).length, 1, 'never twice');
  // A partner room: never.
  app.script.push(text('Hi all.'));
  await bridge.handle(grp(-100700, 3003, `@sara_test_bot ${'y'.repeat(1700)}`));
  assert.ok(!tg.texts(-100700).some((x) => x.includes('getting long')));
  // dropped > 0 counts too (a fresh session over the 60-message limit).
  app.settings.update({ historyBudgetChars: 48_000 });
  const conv = app.store.createConversation({ title: 'Long', channel: 'telegram', channelKey: '777', partner: null });
  for (let i = 0; i < 70; i++) app.store.addMessage(conv.id, i % 2 ? 'assistant' : 'user', `line ${i}`);
  assert.ok(nearlyFullOffer(app, conv, { used: 100, budget: 48_000, dropped: 10 }, 'en', 'owner-dm'));
  assert.equal(nearlyFullOffer(app, conv, { used: 100, budget: 48_000, dropped: 10 }, 'en', 'owner-dm'), undefined);
  // Switched off: nothing.
  app.settings.update({ chats: { offerNew: false } });
  const c2 = app.store.createConversation({ title: 'Long 2' });
  assert.equal(nearlyFullOffer(app, c2, { used: 1900, budget: 2000, dropped: 0 }, 'en', 'owner-dm'), undefined);
});

test('a partner /new is a clean start with its own disclosure', async (t) => {
  const { app, bridge, tg, nudges } = await tgSetup(t);
  const n0 = nudges();
  app.script.push(text('Hi Cleo!'));
  await bridge.handle(dm(4004, 'hey', { name: 'Cleo' }));
  assert.match(tg.texts(4004)[0], /^ℹ️ Sara is an AI companion/);
  const first = app.store.currentChannelConversation('telegram', '4004', 'partner')!;
  await bridge.handle(dm(4004, '/new', { name: 'Cleo', lang: 'es' }));
  assert.equal(tg.texts(4004).at(-1), say(app, 'es', 'New session started. I kept the last one ("{title}").', { title: first.title }), 'in her language');
  assert.equal(nudges(), n0, 'partner chats have no memory');
  app.script.push(text('Hello again.'));
  await bridge.handle(dm(4004, 'hi again', { name: 'Cleo' }));
  const texts = tg.texts(4004);
  assert.match(texts.at(-2)!, /^ℹ️ Sara is an AI companion/, 'the new session starts with the disclosure');
  const second = app.store.currentChannelConversation('telegram', '4004', 'partner')!;
  assert.ok(!app.requests.at(-1)!.messages.some((m) => typeof m.content === 'string' && m.content.includes('hey') && m.role === 'user'), 'nothing carried over');
  assert.notEqual(second.id, first.id);
});

// ---------------------------------------------------------------------------------------------
// Discord: the interaction router, the bulk overwrite, typed commands and the loop guard
// ---------------------------------------------------------------------------------------------

const DC_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const BOT = { id: '900', username: 'Sara', bot: true };
const DOWNER = { id: '100', username: 'alex', global_name: 'Alex' };
const BOB = { id: '7', username: 'bob', global_name: 'Bob' };

async function dcSetup(t: { after: (fn: () => void) => void }, discord: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-31T20:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  const sent: { method: string; path: string; body: unknown; at: number }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const raw = await readBody(req);
    const path = req.url ?? '';
    sent.push({ method: req.method ?? '', path, body: raw ? JSON.parse(raw) : {}, at: Date.now() });
    let result: unknown = {};
    if (path === '/users/@me') result = BOT;
    else if (/^\/channels\/\d+$/.test(path) && req.method === 'GET') result = { id: path.split('/')[2], nsfw: false };
    else if (path === '/users/@me/channels') result = { id: `dm-${(JSON.parse(raw || '{}') as { recipient_id?: string }).recipient_id}` };
    else if (path.endsWith('/typing') || path.includes('/callback')) return void res.writeHead(204).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', discord: { enabled: true, allowServers: true, mirror: false, ownerUserId: '100', ...discord } });
  app.vault.set(DISCORD_VAULT, DC_TOKEN);
  let sock: GatewaySocket | undefined;
  const bridge = new DiscordBridge(app, { api: url, connect: () => (sock = { send: () => undefined, close: () => undefined, onmessage: null, onclose: null }) });
  await bridge.restart();
  const gateway = (p: unknown) => sock!.onmessage!(JSON.stringify(p));
  gateway({ op: 0, t: 'READY', s: 1, d: { user: BOT, application: { id: 'app1' } } });
  await bridge.menus;
  t.after(() => {
    bridge.stop();
    server.close();
    app.store.close();
    cleanup();
  });
  const texts = (ch: string) => sent.filter((s) => s.method === 'POST' && s.path === `/channels/${ch}/messages`).map((s) => String((s.body as { content?: string }).content));
  return { app, bridge, sent, gateway, texts, clock };
}
const slash = (name: string, o: { user?: typeof DOWNER; guild?: string; channel?: string; options?: { name: string; value: unknown }[]; locale?: string; id?: string } = {}) => ({
  op: 0,
  t: 'INTERACTION_CREATE',
  s: 5,
  d: { id: o.id ?? `i-${uid++}`, token: 'tok', type: 2, application_id: 'app1', channel_id: o.channel ?? 'dm1', ...(o.guild ? { guild_id: o.guild, member: { user: o.user ?? DOWNER } } : { user: o.user ?? DOWNER }), ...(o.locale ? { locale: o.locale } : {}), data: { name, ...(o.options ? { options: o.options } : {}) } },
});
const dmsg = (o: { channel_id?: string; guild_id?: string; author?: typeof DOWNER & { bot?: boolean }; content: string; mentions?: { id: string; username: string }[] }) => ({ id: `${uid++}`, channel_id: 'dm1', author: DOWNER, ...o });

test('discord: one bulk overwrite per hash, with localisations and contexts', async (t) => {
  const { sent, gateway, bridge } = await dcSetup(t);
  const puts = sent.filter((s) => s.method === 'PUT' && s.path === '/applications/app1/commands');
  assert.equal(puts.length, 1);
  const cmds = puts[0].body as { name: string; contexts: number[]; name_localizations: Record<string, string>; description_localizations: Record<string, string>; default_member_permissions: unknown; options?: { name: string; autocomplete?: boolean }[] }[];
  assert.deepEqual(cmds.map((c) => c.name), ['new', 'reset', 'stop', 'status', 'help', 'model', 'remember']);
  for (const c of cmds) {
    assert.deepEqual(c.contexts, [0, 1]);
    assert.equal(c.default_member_permissions, null);
    assert.deepEqual(Object.keys(c.description_localizations).sort(), ['de', 'es-ES', 'fr', 'it', 'pt-BR']);
    assert.match(c.name, /^[-_\p{L}\p{N}]{1,32}$/u);
    for (const n of Object.values(c.name_localizations)) assert.match(n, /^[-_\p{L}\p{N}]{1,32}$/u);
  }
  assert.equal(cmds.find((c) => c.name === 'model')!.options![0].autocomplete, true);
  assert.equal(cmds.find((c) => c.name === 'new')!.options![0].name, 'for');
  // A reconnect (READY again): same list, nothing sent.
  gateway({ op: 0, t: 'READY', s: 2, d: { user: BOT, application: { id: 'app1' } } });
  await bridge.menus;
  assert.equal(sent.filter((s) => s.method === 'PUT').length, 1);
  assert.equal((await bridge.registerMenus(true)).calls, 1, '"Register menus now" forces it');
});

test('discord: /status answers "thinking…" first (inside 3 s), then edits @original; owner-only results are ephemeral', async (t) => {
  const { app, sent, gateway } = await dcSetup(t);
  app.script.push(text('Hey.'));
  const t0 = Date.now();
  gateway(slash('status'));
  const edit = await until(() => sent.find((s) => s.method === 'PATCH' && s.path === '/webhooks/app1/tok/messages/@original'));
  const first = sent.find((s) => s.path.startsWith('/interactions/'))!;
  assert.equal((first.body as { type: number }).type, 5, 'deferred');
  assert.equal((first.body as { data: { flags: number } }).data.flags, 64, 'ephemeral');
  assert.ok(first.at - t0 < 3000, 'inside 3 seconds');
  assert.ok(first.at <= edit.at, 'the edit comes after');
  assert.match((edit.body as { content: string }).content, /Context used: \d+%/);
  // A partner in a server: the short status only, and help is open; /new is refused, ephemeral.
  gateway(slash('status', { user: BOB, guild: 'g1', channel: '300' }));
  const e2 = await until(() => sent.filter((s) => s.method === 'PATCH').at(1));
  assert.match((e2.body as { content: string }).content, /^I'm Sara, an AI companion\. This chat is \d+% full\.$/);
  gateway(slash('new', { user: BOB, guild: 'g1', channel: '300', locale: 'fr' }));
  const refused = await until(() => sent.filter((s) => s.path.startsWith('/interactions/')).at(2));
  assert.equal((refused.body as { type: number }).type, 4);
  assert.equal((refused.body as { data: { flags: number; content: string } }).data.flags, 64);
  assert.equal((refused.body as { data: { content: string } }).data.content, say(app, 'fr', 'Only the person who runs me can use that here.'));
  // A button press still decides approvals.
  const req = app.approvals.request('c1', new AbortController().signal);
  gateway({ op: 0, t: 'INTERACTION_CREATE', s: 9, d: { id: 'i-btn', token: 'tok2', type: 3, user: DOWNER, data: { custom_id: `ap:${req.id}:1` } } });
  assert.equal(await req.decision, true);
  // /model autocomplete is the owner's only.
  gateway({ op: 0, t: 'INTERACTION_CREATE', s: 10, d: { id: 'i-ac', token: 'tok3', type: 4, user: DOWNER, data: { name: 'model', options: [{ name: 'name', value: 'large', focused: true }] } } });
  const ac = await until(() => sent.find((s) => s.path === '/interactions/i-ac/tok3/callback'));
  assert.deepEqual((ac.body as { type: number; data: { choices: { value: string }[] } }).data.choices.map((c) => c.value), ['fake-large']);
});

test('discord: /model select sets the session; typed commands need a mention in servers; /reset resets the bot guard', async (t) => {
  const { app, bridge, sent, gateway, texts } = await dcSetup(t, { answerBots: true, botTurnLimit: 1 });
  app.script.push(text('Hi.'));
  await bridge.handleMessage(dmsg({ content: 'hello' }));
  const conv = app.store.currentChannelConversation('discord', 'dm1', 'owner')!;
  gateway(slash('model'));
  const edit = await until(() => sent.find((s) => s.method === 'PATCH'));
  const select = (edit.body as { components: { components: { custom_id: string; options: { label: string; value: string }[] }[] }[] }).components[0].components[0];
  assert.equal(select.custom_id, `md:${conv.id}`);
  const v = select.options.find((o) => o.label === 'fake-large')!.value;
  gateway({ op: 0, t: 'INTERACTION_CREATE', s: 11, d: { id: 'i-pick', token: 'tok4', type: 3, user: BOB, data: { custom_id: select.custom_id, values: [v] } } });
  await until(() => sent.find((s) => s.path === '/interactions/i-pick/tok4/callback'));
  assert.equal(app.store.getConversation(conv.id)!.model, null, 'someone else: no change');
  gateway({ op: 0, t: 'INTERACTION_CREATE', s: 12, d: { id: 'i-pick2', token: 'tok5', type: 3, user: DOWNER, data: { custom_id: select.custom_id, values: [v] } } });
  const upd = await until(() => sent.find((s) => s.path === '/interactions/i-pick2/tok5/callback'));
  assert.equal((upd.body as { type: number }).type, 7);
  assert.equal(app.store.getConversation(conv.id)!.model, 'fake-large');
  // Typed /new in the owner DM.
  await bridge.handleMessage(dmsg({ content: '!new' }));
  assert.match(texts('dm1').at(-1)!, /^New session started/);
  // In a server a typed /status without a mention isn't for her; with one it is (others get the short one).
  const before = app.requests.length;
  await bridge.handleMessage(dmsg({ channel_id: '300', guild_id: 'g1', author: BOB, content: '/status' }));
  assert.equal(texts('300').length, 0);
  await bridge.handleMessage(dmsg({ channel_id: '300', guild_id: 'g1', author: BOB, content: '<@900> /status', mentions: [BOT] }));
  assert.match(texts('300').at(-1)!, /^I'm Sara, an AI companion/);
  assert.equal(app.requests.length, before, 'no model call');
  // The bot guard: one bot reply, then she waits; the owner's /reset in the channel lets her answer again.
  const robo = { id: '55', username: 'robo', bot: true } as typeof DOWNER & { bot: boolean };
  app.script.push(text('Beep to you.'));
  await bridge.handleMessage(dmsg({ channel_id: '300', guild_id: 'g1', author: robo, content: '<@900> beep', mentions: [BOT] }));
  await bridge.handleMessage(dmsg({ channel_id: '300', guild_id: 'g1', author: robo, content: '<@900> beep', mentions: [BOT] }));
  assert.match(texts('300').at(-1)!, /wait for a person/);
  await bridge.handleMessage(dmsg({ channel_id: '300', guild_id: 'g1', author: robo, content: '<@900> /reset', mentions: [BOT] }));
  assert.match(texts('300').at(-1)!, /wait for a person/, 'bots run no commands');
  app.script.push(text('Okay, beep.'));
  // The owner in the channel (others' side of the room): his /reset clears the guard.
  await bridge.handleMessage(dmsg({ channel_id: '300', guild_id: 'g1', author: DOWNER, content: 'Sara reset' }));
  assert.match(texts('300').at(-1)!, /^Cleared\. I'm listening\.$/);
});

// ---------------------------------------------------------------------------------------------
// The app: typed commands in the web composer, "Start a new session from here", the fill
// ---------------------------------------------------------------------------------------------

test('web: typed /new, /status and /help; POST …/new; GET …/fill and …/sessions', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-31T20:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: new Date().toISOString() });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '2.40.0', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: ['Bearer', token].join(' '), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'my garden plan');
  app.store.addMessage(conv.id, 'assistant', 'Tomatoes first.');
  const before = app.requests.length;
  const st = await api('POST', `/conversations/${conv.id}/command`, { text: '/status' });
  assert.equal(st.status, 200);
  assert.match(String(st.json.reply), /Model: m \(P\)[\s\S]*Context used: \d+%[\s\S]*This session: 0 min, 2 messages/);
  const help = await api('POST', `/conversations/${conv.id}/command`, { text: '/help' });
  assert.match(String(help.json.reply), /\/new: Start a fresh session/);
  const nw = await api('POST', `/conversations/${conv.id}/command`, { text: '/new' });
  const opened = nw.json.opened as { id: string; title: string; sessionOf: string };
  assert.equal(opened.title, 'New conversation', 'a web session gets its title from its first message');
  assert.equal(opened.sessionOf, conv.id);
  assert.ok(app.store.getConversation(conv.id)!.endedAt);
  assert.equal(app.requests.length, before, 'no model call');
  const bad = await api('POST', `/conversations/${conv.id}/command`, { text: '/shrug' });
  assert.equal(bad.status, 400);
  const fill = await api('GET', `/conversations/${conv.id}/fill`);
  assert.equal(typeof fill.json.percent, 'number');
  assert.equal(fill.json.budget, 48_000);
  const sessions = await api('GET', `/conversations/${opened.id}/sessions`);
  assert.deepEqual((sessions.json.sessions as { id: string }[]).map((s) => s.id), [conv.id, opened.id]);
  // A bridge session: "Start a new session from here".
  const tgc = app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '1001' });
  app.store.addMessage(tgc.id, 'user', 'hi');
  const r = await api('POST', `/conversations/${tgc.id}/new`, {});
  // Phase 109 (CH3): a /new session's placeholder carries the day, so sessions of one chat can be told apart.
  assert.equal((r.json.opened as { title: string }).title, 'Telegram · Oct 31');
  assert.equal(app.store.currentChannelConversation('telegram', '1001', 'owner')!.id, (r.json.opened as { id: string }).id);
  // The commands table is the owner's.
  const tab = await api('GET', '/chats/commands');
  assert.ok((tab.json.commands as { name: string }[]).some((c) => c.name === 'remember'));
  const put = await api('PUT', '/chats/commands', { namePrefix: false, offerNew: false });
  assert.deepEqual(put.json.settings, { native: true, namePrefix: false, offerNew: false });
});
