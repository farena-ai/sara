// Phase 6: Telegram bridge against a fake Bot API: linking, owner chat, approvals by button,
// other people as partners (no tools, own disclosure), groups (mention only), mirroring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TELEGRAM_VAULT, TelegramBridge, splitMessage } from '../src/bridges/telegram.ts';
import { call, listen, makeApp, readBody, tempDir, text, type TestApp } from './helpers.ts';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function fakeTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    if (!req.url?.startsWith(`/bot${TOKEN}/`)) {
      res.writeHead(401).end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
      return;
    }
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  return { sent, url, close: () => server.close(), texts: (chat: number) => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === chat).map((s) => String(s.body.text)) };
}

async function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  const tg = await fakeTelegram();
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', telegram: { enabled: true, allowOthers: false, mirror: true } });
  app.vault.set(TELEGRAM_VAULT, TOKEN);
  const bridge = new TelegramBridge(app, { apiBase: tg.url });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    tg.close();
    app.store.close();
    cleanup();
  });
  return { app, bridge, tg };
}

let uid = 1;
const dm = (chatId: number, txt: string, name = 'Alex') => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' as const }, from: { id: chatId, first_name: name }, text: txt } });
const OWNER = 1001;

test('splitMessage keeps paragraphs and stays under the limit', () => {
  const parts = splitMessage(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`, 4000);
  assert.deepEqual(parts.map((p) => p.length), [3000, 3000]);
  assert.ok(splitMessage('x'.repeat(9000)).every((p) => p.length <= 4000));
});

test('telegram: strangers are told no; linking with a code makes the owner chat', async (t) => {
  const { app, bridge, tg } = await setup(t);
  assert.equal(bridge.status().bot, 'sara_test_bot');
  await bridge.handle(dm(555, 'hello?', 'Stranger'));
  await bridge.handle(dm(555, 'hello??', 'Stranger'));
  assert.deepEqual(tg.texts(555), ["Hi! I'm Sara, an AI companion. I only chat with the person who runs me here."], 'told once');
  await bridge.handle(dm(OWNER, '/start 000000'));
  assert.match(tg.texts(OWNER)[0], /wrong or expired/);
  const code = bridge.newLinkCode();
  await bridge.handle(dm(OWNER, `/start ${code}`));
  assert.match(tg.texts(OWNER).at(-1)!, /^Linked\. It's me, Sara\.[\s\S]*AI companion/);
  assert.equal(app.settings.get().telegram?.ownerChatId, OWNER);
  await bridge.handle(dm(OWNER, `/link ${code}`));
  assert.match(tg.texts(OWNER).at(-1)!, /wrong or expired/, 'codes are single use');
  // Five wrong guesses and the code is gone, even the right one after them.
  const code2 = bridge.newLinkCode();
  for (let i = 0; i < 5; i++) await bridge.handle(dm(777, `/start ${code2 === '123456' ? '654321' : '123456'}`, 'Guesser'));
  await bridge.handle(dm(777, `/start ${code2}`, 'Guesser'));
  assert.match(tg.texts(777).at(-1)!, /wrong or expired/);
  assert.equal(app.settings.get().telegram?.ownerChatId, OWNER, 'still linked to the owner');
});

test('telegram: owner chat runs full turns; approvals by button; reminders mirrored', async (t) => {
  const { app, bridge, tg } = await setup(t);
  app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: true, ownerChatId: OWNER }, toolPermissions: { write_file: 'ask' } });
  app.script.push(text('Hey you. Missed you.'));
  await bridge.handle(dm(OWNER, 'hi Sara'));
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  assert.equal(conv.partner, null);
  assert.equal(conv.title, 'Telegram');
  const msgs = tg.texts(OWNER);
  assert.match(msgs[0], /^ℹ️ Sara is an AI companion/, 'disclosure first');
  assert.equal(msgs.at(-1), 'Hey you. Missed you.');
  assert.ok(tg.sent.some((s) => s.method === 'sendChatAction'), 'typing indicator');
  assert.ok(app.requests.at(-1)!.tools?.some((x) => x.name === 'write_file'), 'owner gets tools');

  // Approval by inline button.
  app.script.push([call('w', 'write_file', { path: 'n.txt', content: 'x' })], text('Saved it.'));
  const turn = bridge.handle(dm(OWNER, 'save a note'));
  let kb: { body: Record<string, unknown> } | undefined;
  for (let i = 0; i < 100 && !kb; i++) {
    await new Promise((r) => setTimeout(r, 20));
    kb = tg.sent.find((s) => s.method === 'sendMessage' && (s.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard?.length);
  }
  assert.ok(kb, 'approval buttons sent');
  assert.match(String(kb!.body.text), /She wants to: write n\.txt|She wants to: .*n\.txt/);
  const data = ((kb!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0]).callback_data;
  // Someone else pressing the button does nothing.
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q0', from: { id: 555 }, data } });
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q1', from: { id: OWNER }, data, message: { message_id: 7, chat: { id: OWNER, type: 'private' } } } });
  await turn;
  assert.equal(tg.texts(OWNER).at(-1), 'Saved it.');
  assert.ok(tg.sent.some((s) => s.method === 'answerCallbackQuery' && s.body.text === 'Allowed'));

  // Reminder delivered in a web conversation is mirrored to Telegram.
  const web = app.store.createConversation();
  const m = app.store.addMessage(web.id, 'assistant', 'Reminder: stretch');
  app.events!.publish({ type: 'message', conversationId: web.id, message: m, reason: 'reminder' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tg.texts(OWNER).at(-1), '⏰ Reminder: stretch');
});

test('telegram: other people (when allowed) are partners: no tools, no memory, own disclosure; groups need a mention', async (t) => {
  const { app, bridge, tg } = await setup(t);
  app.settings.update({ telegram: { enabled: true, allowOthers: true, mirror: true, ownerChatId: OWNER } });
  app.script.push(text('Hi Alice! Nice to meet you.'));
  await bridge.handle(dm(777, 'hey who are you', 'Alice'));
  const conv = app.store.findChannelConversation('telegram', '777')!;
  assert.equal(conv.partner, 'Alice');
  const req = app.requests.at(-1)!;
  assert.equal(req.tools?.length ?? 0, 0, 'no tools for other people');
  const sys = req.messages[0].content as string;
  assert.match(sys, /You are talking with Alice\./);
  assert.match(sys, /talking with Alice on telegram, not with Alex[\s\S]*strictly non-romantic and non-sexual/);
  assert.doesNotMatch(sys, /What you remember|How you feel|Keeping track/);
  assert.match(tg.texts(777)[0], /^ℹ️ Sara is an AI companion/, 'their own disclosure');
  assert.equal(tg.texts(777).at(-1), 'Hi Alice! Nice to meet you.');
  assert.equal(app.inner!.get().lastOwnerAt, null, 'her mood ignores other people');

  // Group: ignored without a mention, answered with one.
  const group = (txt: string) => ({ update_id: uid++, message: { message_id: uid, chat: { id: -42, type: 'group' as const, title: 'BBQ crew' }, from: { id: 888, first_name: 'Bob' }, text: txt } });
  const before = app.requests.length;
  await bridge.handle(group('anyone up for ribs?'));
  assert.equal(app.requests.length, before);
  app.script.push(text('Always up for ribs.'));
  await bridge.handle(group('@sara_test_bot you in?'));
  assert.match(JSON.stringify(app.requests.at(-1)!.messages), /\[Bob\]: @sara_test_bot you in\?/);
  assert.equal(app.store.findChannelConversation('telegram', '-42')!.partner, 'the group "BBQ crew"');
  // Partner messages are not mirrored to the owner.
  const m = app.store.addMessage(conv.id, 'assistant', 'private to Alice');
  app.events!.publish({ type: 'message', conversationId: conv.id, message: m, reason: 'proactive' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!tg.texts(OWNER).includes('private to Alice'));
});

// ---------- Phase 43: more owners, owner work in groups, name and @all, adult groups ----------
const group = (chatId: number, fromId: number, txt: string, name = 'Bob') => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'supergroup' as const, title: 'Crew' }, from: { id: fromId, first_name: name }, text: txt } });

test('telegram: a second owner ID gets the owner chat (tools) in a private chat', async (t) => {
  const { app, bridge, tg } = await setup(t);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, ownerChatId: OWNER, ownerUserIds: [2002] } });
  app.script.push(text('Hi Ann.'));
  await bridge.handle(dm(2002, 'hello', 'Ann'));
  assert.equal(tg.texts(2002).at(-1), 'Hi Ann.');
  assert.ok((app.requests.at(-1)!.tools?.length ?? 0) > 0, 'owner tools');
  assert.equal(app.store.findChannelConversation('telegram', '2002')!.partner, null);
});

test('telegram: owners work with tools in a group when allowed; others there stay partners', async (t) => {
  const { app, bridge } = await setup(t);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, ownerChatId: OWNER, ownerWorkInGroups: true, allowOthers: true } });
  app.script.push(text('On it.'));
  await bridge.handle(group(-100777, OWNER, '@sara_test_bot check the build', 'Alex'));
  let req = app.requests.at(-1)!;
  assert.ok((req.tools?.length ?? 0) > 0);
  assert.match(req.messages[0].content as string, /working with Alex in a shared Telegram group/);
  assert.equal(app.store.findChannelConversation('telegram-work', '-100777')!.partner, null);
  app.script.push(text('Hi Bob.'));
  await bridge.handle(group(-100777, 3003, '@sara_test_bot hi'));
  req = app.requests.at(-1)!;
  assert.equal(req.tools?.length ?? 0, 0);
});

test('telegram: a group is one room: the owner sees what the others said, and the room hears him (2.35.1)', async (t) => {
  const { app, bridge } = await setup(t);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, ownerChatId: OWNER, ownerWorkInGroups: true, allowOthers: true } });
  app.script.push(text('Hi Bob.'));
  await bridge.handle(group(-100790, 3003, '@sara_test_bot the deploy broke again'));
  app.script.push(text('Looking.'));
  await bridge.handle(group(-100790, OWNER, '@sara_test_bot what did Bob say?', 'Alex'));
  assert.match(app.requests.at(-1)!.messages[0].content as string, /## The rest of this channel \(context only\)[\s\S]*the deploy broke again/);
  const room = app.store.findChannelConversation('telegram', '-100790', 'partner')!;
  assert.ok(app.store.messages(room.id).some((m) => (m.meta as { fromOwner?: boolean } | undefined)?.fromOwner && /what did Bob say/.test(m.content)));
});

test('telegram: owner work also answers in a group when others are not allowed', async (t) => {
  const { app, bridge, tg } = await setup(t);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, ownerChatId: OWNER, ownerWorkInGroups: true, allowOthers: false } });
  await bridge.handle(group(-100778, 3003, '@sara_test_bot hi'));
  assert.equal(app.requests.length, 0, 'others are not answered');
  app.script.push(text('Yes?'));
  await bridge.handle(group(-100778, OWNER, '@sara_test_bot status?', 'Alex'));
  assert.equal(tg.texts(-100778).at(-1), 'Yes?');
});

test('telegram: her name and @all only when switched on', async (t) => {
  const { app, bridge } = await setup(t);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, ownerChatId: OWNER, allowOthers: true } });
  await bridge.handle(group(-100779, 3003, 'sara, you there?'));
  await bridge.handle(group(-100779, 3003, '@all lunch?'));
  assert.equal(app.requests.length, 0);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, answerName: true, answerEveryone: true } });
  app.script.push(text('Here.'), text('Sure.'));
  await bridge.handle(group(-100779, 3003, 'sara, you there?'));
  await bridge.handle(group(-100779, 3003, '@all lunch?'));
  assert.equal(app.requests.length, 2);
});

test('telegram: groups listed as adult allow adult content (with Adult mode on)', async (t) => {
  const { app, bridge } = await setup(t);
  app.settings.update({ telegram: { ...app.settings.get().telegram!, ownerChatId: OWNER, allowOthers: true, nsfwChatIds: [-100780] }, routes: { adult: { providerId: 'p', model: 'adult-model' } }, adultMode: { on: true, confirmedAt: '2026-10-24T00:00:00Z' } });
  app.script.push(text('Mm.'), text('Hey.'));
  await bridge.handle(group(-100780, 3003, '@sara_test_bot you are so sexy'));
  assert.equal(app.requests.at(-1)!.model, 'adult-model');
  await bridge.handle(group(-100781, 3003, '@sara_test_bot you are so sexy'));
  assert.notEqual(app.requests.at(-1)!.model, 'adult-model', 'other groups stay non-sexual');
});
