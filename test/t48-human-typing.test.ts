// C6: typing that feels human, as an option (off by default). The web chat waits a little longer
// before a longer reply and pauses after a paragraph or two of a long one; Telegram and Discord send
// a long reply as two or three messages. Never in coding chats, calls or spoken replies, never for
// errors or safety replies, and what is stored stays one message.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafetyText, TYPING, typedParts, typingMs, typingPaced } from '../src/bridges/pace.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { CRISIS_RESOURCES, MINOR_BLOCK_REPLY } from '../src/safety.ts';
import { PAUSE, partBreaks, startPause, typingOn } from '../web/human-typing.js';
import { listen, makeApp, readBody, tempDir, text } from './helpers.ts';

const para = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join(' ') + '.';
const LONG = [para(40, 'First'), para(40, 'Second'), para(40, 'Third'), para(40, 'Fourth')].join('\n\n');

test('C6 web: the pause before she starts grows with the reply, a few seconds at most', () => {
  assert.equal(startPause(0), PAUSE.minMs);
  assert.ok(startPause(50) < startPause(300));
  assert.equal(startPause(100_000), PAUSE.maxMs);
  assert.ok(PAUSE.maxMs <= 3000);
});

test('C6 web: typed only when chosen, and never in coding chats, calls or spoken replies', () => {
  assert.equal(typingOn({ choice: null }), false, 'off by default');
  assert.equal(typingOn({ choice: 'instant' }), false);
  assert.equal(typingOn({ choice: 'human' }), true);
  assert.equal(typingOn({ choice: 'human', coding: true }), false);
  assert.equal(typingOn({ choice: 'human', voice: true }), false);
  assert.equal(typingOn({ choice: 'human', reducedMotion: true }), false);
});

test('C6 parts: a long reply breaks after paragraphs, at most twice, never inside code; short ones never', () => {
  assert.deepEqual(partBreaks('Short.\n\nAnother short one.'), []);
  const at = partBreaks(LONG);
  assert.equal(at.length, 2, 'three parts at most');
  for (const p of at) assert.equal(LONG.slice(p - 2, p), '\n\n', 'right after a blank line');
  // The places found stay put while the reply grows.
  assert.deepEqual(partBreaks(LONG + '\n\nMore.'), at);
  // A blank line inside a code block is not a paragraph end.
  const code = `${para(40, 'Intro')}\n\n\`\`\`js\n${'const a = 1;\n\n'.repeat(30)}\`\`\`\n${para(30, 'After')}`;
  for (const p of partBreaks(code)) assert.ok(p <= code.indexOf('```'), 'no break inside the code');
  // The pieces put together are the whole reply.
  const parts = typedParts(LONG);
  assert.equal(parts.length, 3);
  assert.equal(parts.join('\n\n'), LONG);
  assert.deepEqual(typedParts('Hi there.'), ['Hi there.']);
});

test('C6 bridges: a few seconds at most; never coding or work chats; safety replies are not paced', (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T12:00:00Z') });
  t.after(() => (app.store.close(), cleanup()));
  assert.ok(typingMs('x'.repeat(10_000)) <= 4000);
  const chat = { mode: 'chat', channel: 'telegram' };
  assert.equal(typingPaced(app, chat), false, 'off by default');
  app.settings.update({ persona: { typing: 'human' } });
  assert.equal(typingPaced(app, chat), true);
  assert.equal(typingPaced(app, { mode: 'coding', channel: 'telegram' }), false);
  assert.equal(typingPaced(app, { mode: 'chat', channel: 'telegram-work' }), false);
  assert.equal(isSafetyText(MINOR_BLOCK_REPLY), true);
  assert.equal(isSafetyText(`I'm here with you.\n\n${CRISIS_RESOURCES}`), true);
  assert.equal(isSafetyText('Nice to see you.'), false);
});

test('C6 Telegram: a long reply arrives as three messages and is stored as one; off, it is one', async (t) => {
  const keep = { ...TYPING };
  Object.assign(TYPING, { baseMs: 5, perChar: 0, maxMs: 5 });
  t.after(() => Object.assign(TYPING, keep));
  const TOKEN = '123456789:test';
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const srv = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : method === 'sendMessage' ? { message_id: sent.length } : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-24T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString() });
  app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: true, ownerChatId: 1001 }, persona: { typing: 'human' } });
  app.vault.set(TELEGRAM_VAULT, TOKEN);
  const bridge = new TelegramBridge(app, { apiBase: srv.url });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    srv.server.close();
    app.store.close();
    cleanup();
  });
  const said = () => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === 1001).map((s) => String(s.body.text));
  app.script.push(text(LONG));
  await bridge.handle({ update_id: 1, message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 1001, first_name: 'Alex' }, text: 'tell me a long story' } });
  const mine = said().filter((s) => /First|Second|Third|Fourth/.test(s));
  assert.equal(mine.length, 3, 'three messages');
  assert.equal(mine.join('\n\n'), LONG);
  assert.ok(sent.some((s) => s.method === 'sendChatAction' && s.body.action === 'typing'), '"typing…" shown');
  const stored = app.store.messages(app.store.listConversations().find((c) => c.channel.startsWith('telegram'))!.id).filter((m) => m.role === 'assistant');
  assert.equal(stored.at(-1)!.content, LONG, 'stored as one message, unchanged');
  // Turned off: the same reply is one message again.
  app.settings.update({ persona: { typing: 'instant' } });
  const before = said().length;
  app.script.push(text(LONG));
  await bridge.handle({ update_id: 2, message: { message_id: 2, chat: { id: 1001, type: 'private' }, from: { id: 1001, first_name: 'Alex' }, text: 'again please' } });
  assert.deepEqual(said().slice(before).filter((s) => /First/.test(s)), [LONG]);
});
