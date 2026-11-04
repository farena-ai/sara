// Phase 61: server-made text the owner sees comes out in the owner's app language (push
// notifications, bot system messages, setup errors); partners and unknown languages get English.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { FirstClaim } from '../src/claim.ts';
import type { HubEvent } from '../src/events.ts';
import { tr, trOwner } from '../src/i18n.ts';
import { PushService, type PushPayload } from '../src/push.ts';
import { listen, makeApp, readBody, tempDir } from './helpers.ts';

test('i18n server: tr() translates, fills values, names the companion, falls back to English', () => {
  assert.equal(tr('Open the app to answer.', 'de'), 'Öffne die App, um anzunehmen.');
  assert.equal(tr('Open the app to answer.', 'es'), 'Abre la app para contestar.');
  assert.equal(tr('{name} is calling', 'de', { name: 'Mia' }), 'Mia ruft an');
  assert.equal(tr('Sara needs your OK', 'es', undefined, { name: 'Mia', pronouns: 'she' }), 'Mia necesita tu visto bueno');
  assert.equal(tr('Sara needs your OK', 'en', undefined, { name: 'Leo', pronouns: 'he' }), 'Leo needs your OK');
  assert.equal(tr('Open the app to answer.', 'xx'), 'Open the app to answer.', 'unknown language → English');
  assert.equal(tr('Not a known text {x}', 'de', { x: 1 }), 'Not a known text 1', 'unknown key → English, values filled');
  assert.equal(trOwner('Done.', { language: 'auto', languageDetected: 'es-MX' }), 'Hecho.');
});

test('i18n server: a wrong setup code reads in German and Spanish (the app shows it with t())', () => {
  const c = new FirstClaim({ pending: () => true, mode: 'code', code: 'ABCDEFGH' });
  const r = c.check('192.168.1.5', 'ABCDEFGX');
  assert.equal(r.ok, false);
  const msg = !r.ok ? r.message : '';
  assert.match(msg, /setup code is wrong/, 'the API stays English');
  assert.match(tr(msg, 'de'), /^Dieser Einrichtungscode ist falsch\./);
  assert.match(tr(msg, 'es'), /^Ese código de configuración no es correcto\./);
});

test('i18n server: push notifications use the owner language', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-28T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const push = new PushService(app.store.db, app.vault, app.settings, { allowInsecure: true });
  const sent: PushPayload[] = [];
  push.sendAll = async (p: PushPayload) => {
    sent.push(p);
    return { sent: 1, failed: 0, removed: 0 } as Awaited<ReturnType<PushService['sendAll']>>;
  };
  const message = (reason: 'reminder' | 'reply'): HubEvent => ({ type: 'message', conversationId: 'c1', message: { id: 1, role: 'assistant', content: 'secret', createdAt: '' }, reason });
  app.settings.update({ language: 'de', push: { preview: false } });
  await push.onEvent(message('reply'), 'Mia', () => false);
  await push.onEvent(message('reminder'), 'Mia', () => false);
  await push.notifyOwner('t', 'x', 'c1', 'ok-1');
  assert.deepEqual(sent.map((p) => p.body), ['Mia hat dir eine Nachricht geschickt.', 'Du hast eine Erinnerung.', 'Öffne die App, um es zu sehen.']);
  sent.length = 0;
  app.settings.update({ language: 'es' });
  await push.onEvent(message('reply'), 'Mia', () => false);
  assert.deepEqual(sent.map((p) => p.body), ['Mia te ha enviado un mensaje.']);
});

test('i18n server: Telegram system messages to the owner use the owner language; strangers get English', async (t) => {
  const TOKEN = '123456789:***';
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const method = (req.url ?? '').split('/').pop()!;
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 999, is_bot: true, username: 'sara_test_bot' } : method === 'getUpdates' ? await new Promise((r) => setTimeout(() => r([]), 50)) : method === 'sendMessage' ? { message_id: sent.length } : true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-28T12:00:00Z') });
  app.settings.update({ language: 'de', telegram: { enabled: true, allowOthers: false, mirror: false } });
  app.vault.set(TELEGRAM_VAULT, TOKEN);
  const bridge = new TelegramBridge(app, { apiBase: url });
  await bridge.restart();
  t.after(() => {
    bridge.stop();
    server.close();
    app.store.close();
    cleanup();
  });
  const texts = (chat: number) => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === chat).map((s) => String(s.body.text));
  let uid = 1;
  const dm = (chat: number, text: string) => ({ update_id: uid++, message: { message_id: uid, chat: { id: chat, type: 'private' as const }, from: { id: chat, first_name: 'Alex' }, text } });
  await bridge.handle(dm(1001, '/start 000000'));
  assert.equal(texts(1001)[0], 'Dieser Code ist falsch oder abgelaufen. Hol dir einen neuen unter Einstellungen → Telegram.');
  app.settings.update({ language: 'es' });
  await bridge.handle(dm(1001, '/start 000000'));
  assert.equal(texts(1001)[1], 'Ese código es incorrecto o ha caducado. Consigue uno nuevo en Ajustes → Telegram.');
  await bridge.handle(dm(555, 'hola?'));
  assert.match(texts(555)[0], /^Hi! I'm Sara/, 'the fixed partner-facing text is not the owner language');
});
