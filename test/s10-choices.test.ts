// S10 (docs/CHOICES.md): pick-an-answer cards. ask_choice ends her turn with a card; a pick is sent
// as the person's own message; Telegram/Discord get buttons, everything else a numbered list with
// "reply with a number or type your own". The model is the scripted fake from helpers.ts; Telegram
// and Discord are local fake servers (no real tokens: fake ones are built at run time).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { afterTurnExtras } from '../src/bridges/commands.ts';
import { DISCORD_VAULT, DiscordBridge, type GatewaySocket } from '../src/bridges/discord.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { ASK_CHOICE, choiceButton, choiceText, createAskChoiceTool, openChoice, parseChoice, pickText } from '../src/choices.ts';
import { KID_TOOLS } from '../src/family.ts';
import { CORE_CHAT, familyOf } from '../src/lean.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import { call, listen, makeApp, readBody, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const START = new Date('2026-11-16T15:00:00Z');
const ARGS = { question: 'Which day works for the dentist?', options: [{ label: 'Tuesday 9 AM' }, { label: 'Thursday 2 PM', detail: 'after your call' }, { label: 'Friday 11 AM' }], recommended: 'Thursday 2 PM' };

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date(START) });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: START.toISOString() } as never);
  app.tools.add(createAskChoiceTool());
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}
async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
async function askTurn(app: TestApp, convId: string, args: Record<string, unknown> = ARGS) {
  app.script.push([call('c1', ASK_CHOICE, args)]);
  const before = app.requests.length;
  const evs = await drain(runTurn(app, convId, 'when should I book the dentist?'));
  return { evs, calls: app.requests.length - before };
}

test('tool schema: question, 2-8 options {label, detail?}, multi, recommended; never approvals', () => {
  const tool = createAskChoiceTool();
  assert.equal(tool.spec.name, 'ask_choice');
  assert.equal(tool.defaultPermission, 'auto');
  const p = tool.spec.parameters as { required: string[]; properties: Record<string, { type: string; items?: { properties: Record<string, unknown>; required: string[] }; maxItems?: number; minItems?: number }> };
  assert.deepEqual(p.required, ['question', 'options']);
  assert.equal(p.properties.options.type, 'array');
  assert.deepEqual(Object.keys(p.properties.options.items!.properties).sort(), ['detail', 'label']);
  assert.equal(p.properties.options.minItems, 2);
  assert.equal(p.properties.options.maxItems, 8);
  assert.equal(p.properties.multi.type, 'boolean');
  assert.equal(p.properties.recommended.type, 'string');
  assert.match(tool.spec.description, /never for approvals/i);
  assert.ok(tool.spec.description.length < 600, 'small schema: it is offered every turn');
  // In every chat (core), the kids' list, its own family.
  assert.ok((CORE_CHAT as readonly string[]).includes('ask_choice'));
  assert.ok(KID_TOOLS.has('ask_choice'));
  assert.equal(familyOf(tool).id, 'choices');
});

test('parseChoice: recommended first and marked; plain strings; limits and duplicates refused', () => {
  const c = parseChoice(ARGS);
  assert.ok(!('error' in c));
  if ('error' in c) return;
  assert.deepEqual(c.options.map((o) => o.label), ['Thursday 2 PM', 'Tuesday 9 AM', 'Friday 11 AM']);
  assert.equal(c.recommended, 0);
  assert.equal(c.options[0].detail, 'after your call');
  assert.equal(c.multi, false);
  // A number (1-based) also names the recommended option; strings are labels.
  const n = parseChoice({ question: 'Which?', options: ['a', 'b', 'c'], recommended: '3' });
  assert.ok(!('error' in n) && n.options[0].label === 'c' && n.recommended === 0);
  const none = parseChoice({ question: 'Which?', options: ['a', 'b'], multi: true });
  assert.ok(!('error' in none) && none.recommended === undefined && none.multi);
  for (const bad of [{ question: '', options: ['a', 'b'] }, { question: 'Q?', options: ['a'] }, { question: 'Q?', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }, { question: 'Q?', options: ['a', 'A '] }, { question: 'Q?', options: ['a', ''] }]) {
    assert.ok('error' in parseChoice(bad), JSON.stringify(bad));
  }
  const long = parseChoice({ question: 'q'.repeat(400), options: ['x'.repeat(200), 'y'], recommended: 'nope' });
  assert.ok(!('error' in long) && long.question.length <= 300 && long.options[0].label.length <= 80 && long.recommended === undefined);
});

test('the turn ends with the card: one model call, the fallback text, meta.choice, a choice event', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation({ title: 'Chat' });
  const { evs, calls } = await askTurn(app, conv.id);
  assert.equal(calls, 1, 'no model call after ask_choice');
  const ch = evs.find((e) => e.type === 'choice') as Extract<ChatEvent, { type: 'choice' }>;
  assert.ok(ch);
  const reply = evs.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
  assert.equal(reply, ['Which day works for the dentist?', '1. Thursday 2 PM (recommended): after your call', '2. Tuesday 9 AM', '3. Friday 11 AM', 'Reply with a number or type your own.'].join('\n'));
  const msgs = app.store.messages(conv.id);
  const last = msgs.findLast((m) => m.role === 'assistant')!;
  assert.equal(last.id, ch.messageId);
  assert.equal(last.content, reply, 'history reads naturally (the model and memory see the list)');
  assert.equal((last.meta?.choice as { question: string }).question, 'Which day works for the dentist?');
  assert.equal(openChoice(app.store, conv.id)?.message.id, last.id);
  const tool = msgs.findLast((m) => m.role === 'tool')!;
  assert.equal(tool.meta?.status, 'ok');
  // A bad call is an error she can fix (no card, the turn goes on).
  app.script.push([call('c2', ASK_CHOICE, { question: 'Q?', options: ['only one'] })], text('Sorry, which one?'));
  const bad = await drain(runTurn(app, conv.id, 'hm'));
  assert.ok(!bad.some((e) => e.type === 'choice'));
  assert.equal(app.store.messages(conv.id).findLast((m) => m.role === 'assistant')!.content, 'Sorry, which one?');
});

test('a pick is the person\'s own message; a number maps to the label; typing something else expires it', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation({ title: 'Chat' });
  await askTurn(app, conv.id);
  app.script.push(text('Thursday it is.'));
  await drain(runTurn(app, conv.id, 'Thursday 2 PM'));
  const user = app.store.messages(conv.id).findLast((m) => m.role === 'user')!;
  assert.equal(user.content, 'Thursday 2 PM');
  const asked = app.store.messages(conv.id).find((m) => m.meta?.choice)!;
  assert.equal((asked.meta!.choice as { answered: string }).answered, 'Thursday 2 PM');
  assert.equal(openChoice(app.store, conv.id), undefined, 'closed after an answer');
  // A number on a plain bridge.
  await askTurn(app, conv.id);
  app.script.push(text('ok'));
  await drain(runTurn(app, conv.id, '3'));
  const second = app.store.messages(conv.id).filter((m) => m.meta?.choice).at(-1)!;
  assert.equal((second.meta!.choice as { answered: string }).answered, 'Friday 11 AM');
  // Something else typed: the card expires (answered with what they wrote, marked typed).
  await askTurn(app, conv.id);
  app.script.push(text('ok'));
  await drain(runTurn(app, conv.id, 'actually, can we skip it?'));
  const third = app.store.messages(conv.id).filter((m) => m.meta?.choice).at(-1)!;
  assert.deepEqual([(third.meta!.choice as { typed: boolean }).typed, openChoice(app.store, conv.id)], [true, undefined]);
  // Multi-select pick text.
  const multi = parseChoice({ question: 'Which?', options: ['a', 'b', 'c'], multi: true });
  assert.ok(!('error' in multi));
  if (!('error' in multi)) assert.equal(pickText(multi, [2, 0]), 'a, c');
});

test('fallback text: numbered, recommended marked, multi says "one or more"; translated hint', () => {
  const c = parseChoice({ question: 'Toppings?', options: ['cheese', 'olives'], multi: true });
  assert.ok(!('error' in c));
  if ('error' in c) return;
  assert.equal(choiceText(c, (s) => s), 'Toppings?\n1. cheese\n2. olives\nReply with one or more numbers (like 1, 3) or type your own.');
  assert.match(choiceText(c, (s) => (s.startsWith('Reply') ? 'Responde con…' : s)), /Responde con…$/);
});

test('web card: buttons in order, recommended marked, Other last; aria; pick sends; multi toggles; closed = disabled', async () => {
  const doc = fakeDocument();
  const { choiceCard } = (await import('../web/choice-card.js')) as unknown as { choiceCard: (c: unknown, ctx: Record<string, unknown>) => FakeEl };
  const sent: string[] = [];
  let focused = 0;
  const c = parseChoice(ARGS);
  if ('error' in c) throw new Error(c.error);
  const card = choiceCard(c, { open: true, t: (s: string) => s, send: (s: string) => sent.push(s), other: () => focused++, doc });
  assert.equal(card.getAttribute('role'), 'group');
  assert.equal(card.getAttribute('aria-label'), 'Which day works for the dentist?');
  const btns = card.all('button');
  assert.deepEqual(btns.map((b) => b.text()), ['Thursday 2 PM (recommended)after your call', 'Tuesday 9 AM', 'Friday 11 AM', 'Other, type it out']);
  assert.ok(btns.every((b) => b.type === 'button'));
  btns[1].click();
  assert.deepEqual(sent, ['Tuesday 9 AM']);
  assert.ok(btns.every((b) => b.disabled), 'one pick only');
  const card2 = choiceCard(c, { open: true, t: (s: string) => s, send: (s: string) => sent.push(s), other: () => focused++, doc });
  card2.all('button').at(-1)!.click();
  assert.equal(focused, 1, 'Other opens the composer');
  assert.ok(!card2.all('button')[0].disabled, 'Other keeps the card open until they send');
  // Multi: toggles (aria-pressed) and a Send button that stays off until one is picked.
  const m = parseChoice({ question: 'Toppings?', options: ['cheese', 'olives', 'ham'], multi: true });
  if ('error' in m) throw new Error(m.error);
  const card3 = choiceCard(m, { open: true, t: (s: string) => s, send: (s: string) => sent.push(s), other: () => undefined, doc });
  const b3 = card3.all('button');
  const sendBtn = b3.find((b) => b.text() === 'Send')!;
  assert.ok(sendBtn.disabled);
  b3[2].click();
  b3[0].click();
  assert.deepEqual([b3[0].getAttribute('aria-pressed'), b3[1].getAttribute('aria-pressed'), b3[2].getAttribute('aria-pressed')], ['true', 'false', 'true']);
  sendBtn.click();
  assert.equal(sent.at(-1), 'cheese, ham');
  // Closed (answered or a later message): every button disabled, the answer shown.
  const done = choiceCard({ ...c, answered: 'Friday 11 AM' }, { open: false, t: (s: string) => s, send: () => assert.fail('closed'), other: () => assert.fail('closed'), doc });
  assert.ok(done.all('button').every((b) => b.disabled));
  assert.ok(done.all('button').find((b) => b.text() === 'Friday 11 AM')!.classList.contains('picked'));
});

test('web wiring: app.js draws it, choice.css uses theme variables, strings translated', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /import \{ choiceCard \} from '\.\/choice-card\.js';/);
  assert.match(app, /m\.meta\?\.choice/);
  const js = readFileSync(join(ROOT, 'web', 'choice-card.js'), 'utf8');
  assert.doesNotMatch(js, /style=|\.style\./);
  const css = readFileSync(join(ROOT, 'web', 'choice.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b|rgb\(/i, 'theme variables only');
  assert.match(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'), /<link rel="stylesheet" href="\/choice\.css">/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8');
    for (const k of ['Other, type it out', '(recommended)', 'Reply with a number or type your own.', 'Reply with one or more numbers (like 1, 3) or type your own.', 'Type your answer.']) assert.ok(tr.includes(`"${k}":`), `${lang}: ${k}`);
  }
});

test('persona: guidance only when the tool is there; sparingly, never approvals', (t) => {
  const app = setup(t);
  const withTool = buildSystemPrompt(app.persona, { now: START, tools: ['ask_choice', 'todo'], ownerName: 'Alex' });
  assert.match(withTool, /ask_choice/);
  assert.match(withTool, /sparingly/);
  assert.match(withTool, /never .*approv/i);
  assert.doesNotMatch(buildSystemPrompt(app.persona, { now: START, tools: ['todo'], ownerName: 'Alex' }), /ask_choice/);
});

test('chat-app extras: buttons for the owner DM replace the list; plain bridges and partners keep the list', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '1' });
  await askTurn(app, conv.id);
  const ex = afterTurnExtras(app, conv.id, 'owner-dm');
  assert.ok(ex.drop?.startsWith('Which day works for the dentist?\n1. '));
  const row = ex.rows.at(-1)!;
  assert.equal(row.text, 'Which day works for the dentist?');
  assert.deepEqual(row.buttons.map((b) => b.label), ['Thursday 2 PM (recommended)', 'Tuesday 9 AM', 'Friday 11 AM', 'Other, type it out']);
  assert.ok(row.buttons.every((b) => /^ch:\d+:(\d|o)$/.test(b.data) && b.data.length <= 64));
  assert.equal(afterTurnExtras(app, conv.id, 'owner-dm', { plain: true }).drop, undefined, 'plain bridges: the list stays');
  assert.equal(afterTurnExtras(app, conv.id, 'partner-dm').rows.length, 0);
  // The button answers: a pick to send as theirs, Other a hint, stale ones no longer waiting.
  assert.equal(choiceButton(app, row.buttons[3].data)?.text, 'Type your answer.');
  const pick = choiceButton(app, row.buttons[1].data);
  assert.equal(pick?.send, 'Tuesday 9 AM');
  assert.equal(choiceButton(app, row.buttons[0].data)?.text, 'No longer waiting', 'one pick');
  assert.equal(choiceButton(app, 'ch:999999:1')?.text, 'No longer waiting');
});

// ---------------------------------------------------------------------------------------------
// bridges against fake servers
// ---------------------------------------------------------------------------------------------

const fakeTgToken = () => `${'7'.repeat(9)}:${'test'.repeat(4)}`;
async function fakeTelegram(token: string) {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    if (!req.url?.startsWith(`/bot${token}/`)) return void res.writeHead(401).end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : method === 'sendMessage' ? { message_id: sent.length } : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  return { sent, url, close: () => server.close() };
}

test('telegram: inline keyboard instead of the list; a tap runs her turn with the pick as his message; others refused', async (t) => {
  const app = setup(t);
  const OWNER = 1001;
  const token = fakeTgToken();
  const tg = await fakeTelegram(token);
  app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: false, ownerChatId: OWNER } } as never);
  app.vault.set(TELEGRAM_VAULT, token);
  const bridge = new TelegramBridge(app, { apiBase: tg.url });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    tg.close();
  });
  let uid = 1;
  app.script.push([call('c1', ASK_CHOICE, ARGS)]);
  await bridge.handle({ update_id: uid++, message: { message_id: 50, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Alex' }, text: 'when should I book the dentist?' } });
  const msgs = tg.sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === OWNER);
  assert.ok(!msgs.some((s) => /Reply with a number/.test(String(s.body.text))), 'no numbered list where buttons show');
  const card = msgs.find((s) => (s.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard?.length)!;
  assert.equal(card.body.text, 'Which day works for the dentist?');
  const kb = (card.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.deepEqual(kb.map((r) => r[0].text), ['Thursday 2 PM (recommended)', 'Tuesday 9 AM', 'Friday 11 AM', 'Other, type it out']);
  // Someone else taps: refused, nothing sent as a message.
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q0', from: { id: 555, first_name: 'X' }, data: kb[2][0].callback_data, message: { message_id: 60, chat: { id: OWNER, type: 'private' } } } } as never);
  // Find the refusal itself (under load another call, e.g. a typing notice, can land after it).
  let refusal: { body: Record<string, unknown> } | undefined;
  for (let i = 0; i < 100 && !(refusal = tg.sent.find((s) => /Only the owner/.test(String(s.body.text)))); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(refusal, 'someone else gets "Only the owner…"');
  // He taps Friday: the card shows his pick, his message is "Friday 11 AM", she answers.
  app.script.push(text('Friday it is.'));
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q1', from: { id: OWNER, first_name: 'Alex' }, data: kb[2][0].callback_data, message: { message_id: 60, chat: { id: OWNER, type: 'private' } } } } as never);
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  for (let i = 0; i < 100 && app.store.messages(conv.id).findLast((m) => m.role === 'assistant')?.content !== 'Friday it is.'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.store.messages(conv.id).findLast((m) => m.role === 'user')!.content, 'Friday 11 AM');
  assert.equal(app.store.messages(conv.id).findLast((m) => m.role === 'assistant')!.content, 'Friday it is.');
  const edit = tg.sent.find((s) => s.method === 'editMessageText' && s.body.message_id === 60)!;
  assert.match(String(edit.body.text), /Which day works for the dentist\?\n✓ Friday 11 AM/);
  // A second tap on the old card: no longer waiting, no new turn.
  const before = app.requests.length;
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q2', from: { id: OWNER, first_name: 'Alex' }, data: kb[0][0].callback_data, message: { message_id: 60, chat: { id: OWNER, type: 'private' } } } } as never);
  assert.equal(app.requests.length, before);
  assert.match(String(tg.sent.filter((s) => s.method === 'answerCallbackQuery').at(-1)!.body.text), /No longer waiting/);
});

test('telegram multi-select: taps toggle ✓ in place, Send sends them as one message', async (t) => {
  const app = setup(t);
  const OWNER = 1002;
  const token = fakeTgToken();
  const tg = await fakeTelegram(token);
  app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: false, ownerChatId: OWNER } } as never);
  app.vault.set(TELEGRAM_VAULT, token);
  const bridge = new TelegramBridge(app, { apiBase: tg.url });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    tg.close();
  });
  let uid = 1;
  app.script.push([call('c1', ASK_CHOICE, { question: 'Toppings?', options: ['cheese', 'olives', 'ham'], multi: true })], text('x'));
  await bridge.handle({ update_id: uid++, message: { message_id: 50, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Alex' }, text: 'pizza?' } });
  const card = tg.sent.find((s) => s.method === 'sendMessage' && (s.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard?.length)!;
  const kb = (card.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.deepEqual(kb.map((r) => r[0].text), ['cheese', 'olives', 'ham', 'Other, type it out', 'Send']);
  const tap = async (data: string) => bridge.handle({ update_id: uid++, callback_query: { id: `q${uid}`, from: { id: OWNER, first_name: 'Alex' }, data, message: { message_id: 61, chat: { id: OWNER, type: 'private' } } } } as never);
  await tap(kb[0][0].callback_data);
  await tap(kb[2][0].callback_data);
  const marks = tg.sent.filter((s) => s.method === 'editMessageReplyMarkup').at(-1)!;
  assert.deepEqual((marks.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.map((r) => r[0].text).slice(0, 3), ['✓ cheese', 'olives', '✓ ham']);
  app.script.push(text('Cheese and ham, got it.'));
  await tap(kb[4][0].callback_data);
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  for (let i = 0; i < 100 && app.store.messages(conv.id).findLast((m) => m.role === 'assistant')?.content !== 'Cheese and ham, got it.'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.store.messages(conv.id).findLast((m) => m.role === 'user')!.content, 'cheese, ham');
});

test('discord: buttons (components) for the owner DM; a press runs her turn with the pick as his message', async (t) => {
  const app = setup(t);
  const token = ['fake', 'discord', 'x'.repeat(8)].join('.');
  const OWNER = { id: '100', username: 'alex', global_name: 'Alex' };
  const sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    const path = req.url ?? '';
    if (req.headers.authorization !== `Bot ${token}`) return void res.writeHead(401).end('{"message":"401: Unauthorized"}');
    sent.push({ method: req.method ?? '', path, body });
    let result: unknown = {};
    if (path === '/users/@me') result = { id: '900', username: 'Sara', bot: true };
    else if (path === '/users/@me/channels') result = { id: 'dm-owner' };
    else if (path.endsWith('/messages') && req.method === 'POST') result = { id: String(sent.length) };
    else if (path.endsWith('/typing')) return void res.writeHead(204).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  app.settings.update({ discord: { enabled: true, allowServers: false, mirror: false, ownerUserId: OWNER.id } } as never);
  app.vault.set(DISCORD_VAULT, token);
  let sock: GatewaySocket | undefined;
  const bridge = new DiscordBridge(app, { api: url, connect: () => (sock = { send: () => undefined, close: () => undefined, onmessage: null, onclose: null }) });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    server.close();
  });
  app.script.push([call('c1', ASK_CHOICE, ARGS)]);
  await bridge.handleMessage({ id: '1', channel_id: 'dm1', author: OWNER, content: 'when should I book the dentist?' } as never);
  const posts = sent.filter((s) => s.method === 'POST' && s.path === '/channels/dm1/messages');
  assert.ok(!posts.some((s) => /Reply with a number/.test(String(s.body.content))));
  const card = posts.find((s) => Array.isArray(s.body.components) && (s.body.components as unknown[]).length)!;
  assert.equal(card.body.content, 'Which day works for the dentist?');
  const buttons = (card.body.components as { components: { label: string; custom_id: string; style: number }[] }[]).flatMap((r) => r.components);
  assert.deepEqual(buttons.map((b) => b.label), ['Thursday 2 PM (recommended)', 'Tuesday 9 AM', 'Friday 11 AM', 'Other, type it out']);
  assert.equal(buttons[0].style, 1, 'recommended is the primary button');
  app.script.push(text('Tuesday then.'));
  sock!.onmessage!(JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', s: 3, d: { id: 'i1', token: 'tok', type: 3, channel_id: 'dm1', user: OWNER, message: { id: '77' }, data: { custom_id: buttons[1].custom_id } } }));
  const conv = app.store.findChannelConversation('discord', 'dm1')!;
  for (let i = 0; i < 150 && app.store.messages(conv.id).findLast((m) => m.role === 'assistant')?.content !== 'Tuesday then.'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.store.messages(conv.id).findLast((m) => m.role === 'user')!.content, 'Tuesday 9 AM');
  const cb = sent.find((s) => s.path.startsWith('/interactions/i1/'))!;
  assert.equal(cb.body.type, 7, 'the card is updated in place');
  assert.match(String((cb.body.data as { content: string }).content), /✓ Tuesday 9 AM/);
});

// ---------------------------------------------------------------------------------------------
// a tiny DOM for the web card (createElement, attributes, classList, click listeners)
// ---------------------------------------------------------------------------------------------

type FakeEl = {
  tag: string;
  type?: string;
  disabled: boolean;
  className: string;
  textContent: string;
  children: FakeEl[];
  classList: { add: (...c: string[]) => void; remove: (...c: string[]) => void; toggle: (c: string, on?: boolean) => void; contains: (c: string) => boolean };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  append: (...n: (FakeEl | string)[]) => void;
  addEventListener: (ev: string, fn: () => void) => void;
  click: () => void;
  focus: () => void;
  text: () => string;
  all: (tag: string) => FakeEl[];
};
function fakeDocument() {
  const make = (tag: string): FakeEl => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const handlers: (() => void)[] = [];
    const e: FakeEl = {
      tag,
      disabled: false,
      textContent: '',
      children: [],
      get className() {
        return [...classes].join(' ');
      },
      set className(v: string) {
        classes.clear();
        for (const c of v.split(/\s+/).filter(Boolean)) classes.add(c);
      },
      classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
      setAttribute: (k, v) => void attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k) ?? null,
      append: (...n) => {
        for (const x of n) e.children.push(typeof x === 'string' ? Object.assign(make('#text'), { textContent: x }) : x);
      },
      addEventListener: (ev, fn) => void (ev === 'click' && handlers.push(fn)),
      click: () => {
        if (!e.disabled) for (const h of handlers) h();
      },
      focus: () => undefined,
      text: () => e.textContent + e.children.map((c) => c.text()).join(''),
      all: (t) => e.children.flatMap((c) => [...(c.tag === t ? [c] : []), ...c.all(t)]),
    } as FakeEl;
    return e;
  };
  return { createElement: make };
}
