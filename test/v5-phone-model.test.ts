// V5.6 (docs/design/V5_PHONE_MODEL.md): a small model on the phone answers while the server is away;
// the answer is marked "offline answer", kept with the outbox item and synced back once, with the
// message, without a second turn.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cleanOfflineAnswer, offlineAnswerAllowed } from '../src/offline-answer.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
// @ts-expect-error plain browser module
import { memoryKV, openOfflineCopy } from '../web/offline-store.js';
// @ts-expect-error plain browser module
import { flushOutbox } from '../web/offline-sync.js';
// @ts-expect-error plain browser module
import { answerOffline, offlinePrompt, phoneModel, OFFLINE_ANSWER_LIMITS } from '../web/offline-answer.js';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-18T16:42:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ disclosureAcceptedAt: '2026-10-24T00:00:00Z', timeZone: 'America/Chicago', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, body?: unknown) =>
  fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const answer = { text: 'Lasagna takes about 45 minutes at 375°F.', model: 'Qwen2.5 0.5B', at: '2026-11-18T16:30:00.000Z' };

test('the offline answer is checked: text, model name and time; anything else is refused', () => {
  assert.equal(cleanOfflineAnswer(undefined), undefined);
  assert.deepEqual(cleanOfflineAnswer(answer), answer);
  assert.equal(cleanOfflineAnswer({ ...answer, text: '  ' }), undefined, 'an empty answer is no answer');
  for (const bad of [{ ...answer, text: 'x'.repeat(OFFLINE_ANSWER_LIMITS.text + 1) }, { ...answer, model: 7 }, { ...answer, at: 'yesterday' }, 'just text', [answer]]) assert.throws(() => cleanOfflineAnswer(bad), /offline answer/i);
});

test('who gets one: never a child, an off-the-record chat or someone else\'s chat', () => {
  assert.equal(offlineAnswerAllowed({ member: undefined }, { partner: undefined }, { offRecord: false }), true);
  assert.equal(offlineAnswerAllowed({ member: { child: () => ({ band: '13-15' }) } }, {}, { offRecord: false }), false);
  assert.equal(offlineAnswerAllowed({ member: { child: () => undefined } }, {}, { offRecord: false }), true, 'an adult household member may');
  assert.equal(offlineAnswerAllowed({}, {}, { offRecord: true }), false);
  assert.equal(offlineAnswerAllowed({}, { partner: 'x' }, { offRecord: false }), false);
});

test('synced: the message and her offline answer are stored once, marked, with no second turn', async () => {
  const conv = app.store.createConversation({ title: 'Dinner' });
  // No scripted model reply: a turn would fail loudly (and add an error message).
  const r1 = await call(`/api/conversations/${conv.id}/messages`, { content: 'How long does lasagna bake?', clientKey: 'ob-v56-0001', offlineAnswer: answer });
  assert.equal(r1.status, 200);
  const j = (await r1.json()) as { ok: boolean; messageId: number; answerId: number; offlineAnswer: boolean };
  assert.equal(j.offlineAnswer, true);
  const msgs = app.store.messages(conv.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [['user', 'How long does lasagna bake?'], ['assistant', answer.text]]);
  assert.equal(msgs[0].meta?.clientKey, 'ob-v56-0001');
  assert.equal(msgs[0].meta?.writtenOffline, true);
  assert.deepEqual(msgs[1].meta?.offlineAnswer, { model: answer.model, at: answer.at });
  assert.equal(j.messageId, msgs[0].id);
  assert.equal(j.answerId, msgs[1].id);
  // The reconnect sends it again: a duplicate, nothing new.
  const r2 = await call(`/api/conversations/${conv.id}/messages`, { content: 'How long does lasagna bake?', clientKey: 'ob-v56-0001', offlineAnswer: answer });
  assert.deepEqual(await r2.json(), { duplicate: true, messageId: msgs[0].id });
  assert.equal(app.store.messages(conv.id).length, 2);
});

test('an offline answer needs the outbox key, and a bad one is refused before anything is stored', async () => {
  const conv = app.store.createConversation({ title: 'Keys' });
  const r1 = await call(`/api/conversations/${conv.id}/messages`, { content: 'Hi', offlineAnswer: answer });
  assert.equal(r1.status, 400);
  const r2 = await call(`/api/conversations/${conv.id}/messages`, { content: 'Hi', clientKey: 'ob-v56-0002', offlineAnswer: { ...answer, at: 'soon' } });
  assert.equal(r2.status, 400);
  assert.equal(app.store.messages(conv.id).length, 0);
});

test('the prompt: short, the last kept messages, the question last, in the chat language', () => {
  const kept = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `line ${i} ` + 'x'.repeat(900) }));
  const p = offlinePrompt({ messages: kept, question: 'What time is it in Rome?', her: 'Sara', lang: 'it' });
  assert.equal(p[0].role, 'system');
  assert.match(p[0].content, /Sara/);
  assert.match(p[0].content, /short|brief/i);
  assert.match(p[0].content, /Italian/);
  assert.match(p[0].content, /back online|server/i, 'says it waits for the server when it needs her tools');
  assert.equal(p.at(-1)?.role, 'user');
  assert.equal(p.at(-1)?.content, 'What time is it in Rome?');
  const middle = p.slice(1, -1);
  assert.ok(middle.length <= OFFLINE_ANSWER_LIMITS.history, `${middle.length} kept messages`);
  assert.match(middle.at(-1)?.content ?? '', /^line 11/, 'the newest kept message right before the question');
  assert.ok(p.reduce((n: number, m: { content: string }) => n + m.content.length, 0) <= OFFLINE_ANSWER_LIMITS.promptChars + 400, 'fits a small model');
});

/** A fake Android bridge: `localModel(op, json)` like MainActivity's, answering through window.saraLocalModel. */
function fakeBridge(opts: { ready?: boolean; on?: boolean; reply?: string; fail?: boolean } = {}) {
  const win: Record<string, unknown> = {};
  const asked: unknown[] = [];
  win.SaraPhone = {
    localModel(op: string, json: string) {
      if (op === 'status') return JSON.stringify({ engine: true, state: opts.ready === false ? 'none' : 'ready', on: opts.on !== false, name: 'Qwen2.5 0.5B', size: 491400032 });
      if (op === 'ask') {
        const req = JSON.parse(json);
        asked.push(req);
        setTimeout(() => (win.saraLocalModel as (id: string, r: string) => void)(req.id, JSON.stringify(opts.fail ? { error: 'out of memory' } : { text: opts.reply ?? 'About 45 minutes.' })), 5);
        return 'ok';
      }
      return '{}';
    },
  };
  return { win, asked };
}

test('the phone model: none without the Android bridge; ready and on asks it and resolves the answer', async () => {
  assert.equal(phoneModel({}), null);
  const { win, asked } = fakeBridge();
  const m = phoneModel(win)!;
  assert.equal(m.status().state, 'ready');
  assert.equal(m.usable(), true);
  const r = await m.ask([{ role: 'user', content: 'Hi' }]);
  assert.equal(r.text, 'About 45 minutes.');
  assert.equal((asked[0] as { maxTokens: number }).maxTokens, OFFLINE_ANSWER_LIMITS.tokens);
  assert.equal(phoneModel(fakeBridge({ on: false }).win)!.usable(), false, 'switched off');
  assert.equal(phoneModel(fakeBridge({ ready: false }).win)!.usable(), false, 'not downloaded');
  await assert.rejects(phoneModel(fakeBridge({ fail: true }).win)!.ask([{ role: 'user', content: 'Hi' }]), /out of memory/);
});

test('answered offline: kept with the outbox item, then sent with it once', async () => {
  const copy = await openOfflineCopy(memoryKV());
  await copy.saveChat({ id: 'c1', title: 'Dinner', updatedAt: '2026-11-18T16:00:00Z' }, [{ id: 1, role: 'user', content: 'We have pasta sheets.' }, { id: 2, role: 'assistant', content: 'Lasagna, then?' }]);
  const item = await copy.queue({ kind: 'chat', conversationId: 'c1', text: 'How long does lasagna bake?' });
  const { win } = fakeBridge({ reply: 'About 45 minutes at 375°F.' });
  const done = await answerOffline({ copy, item, model: phoneModel(win), her: 'Sara', lang: 'en', now: () => new Date('2026-11-18T16:30:00Z') });
  assert.equal(done?.text, 'About 45 minutes at 375°F.');
  const [kept] = await copy.outbox();
  assert.deepEqual(kept.offlineAnswer, { text: 'About 45 minutes at 375°F.', model: 'Qwen2.5 0.5B', at: '2026-11-18T16:30:00.000Z' });
  assert.equal(kept.key, item.key, 'the key is unchanged (nothing was sent yet)');
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const r = await flushOutbox(copy, { post: async (path: string, body: Record<string, unknown>) => (posts.push({ path, body }), new Response('{"ok":true}', { status: 200 })) });
  assert.equal(r.sent, 1);
  assert.deepEqual(posts[0].body, { content: 'How long does lasagna bake?', clientKey: item.key, offlineAnswer: kept.offlineAnswer });
  assert.equal((await copy.outbox()).length, 0);
});

test('a failed or switched-off phone model leaves the message waiting as before', async () => {
  const copy = await openOfflineCopy(memoryKV());
  const item = await copy.queue({ kind: 'chat', conversationId: 'c1', text: 'Hello?' });
  assert.equal(await answerOffline({ copy, item, model: phoneModel(fakeBridge({ fail: true }).win) }), null);
  assert.equal(await answerOffline({ copy, item, model: phoneModel(fakeBridge({ on: false }).win) }), null);
  assert.equal(await answerOffline({ copy, item, model: null }), null);
  const [kept] = await copy.outbox();
  assert.equal(kept.offlineAnswer, undefined);
  const posts: Record<string, unknown>[] = [];
  await flushOutbox(copy, { post: async (_p: string, body: Record<string, unknown>) => (posts.push(body), new Response('{}', { status: 200 })) });
  assert.deepEqual(posts[0], { content: 'Hello?', clientKey: item.key });
});

test('an edited message drops its old offline answer (it answered other words)', async () => {
  const copy = await openOfflineCopy(memoryKV());
  const item = await copy.queue({ kind: 'chat', conversationId: 'c1', text: 'Bake time?' });
  await answerOffline({ copy, item, model: phoneModel(fakeBridge().win) });
  const edited = await copy.edit(item.id, 'Bake time for lasagna?');
  assert.equal(edited?.offlineAnswer, undefined);
});

const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('Android: the bridge, the shim and the engine script', () => {
  const main = src('android/app/src/main/java/com/backstagecoding/sara/MainActivity.java');
  assert.match(main, /@JavascriptInterface\s+public String localModel\(String op, String json\)/);
  const lm = src('android/app/src/main/java/com/backstagecoding/sara/LocalModel.java');
  assert.match(lm, /74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db/, 'the model file is pinned by its SHA-256');
  assert.match(lm, /https:\/\/huggingface\.co\/Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF\/resolve\/main\/qwen2\.5-0\.5b-instruct-q4_k_m\.gguf/);
  assert.match(lm, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(lm, /Range/, 'a cut download resumes');
  const cmake = src('android/app/src/main/cpp/CMakeLists.txt');
  assert.match(cmake, /add_library\(saralm SHARED llm\.c\)/);
  assert.match(cmake, /SARA_NO_LLM=1/, 'builds as a stub without the engine header');
  const shim = src('android/app/src/main/cpp/llm.c');
  assert.match(shim, /dlopen\("libllama\.so"/);
  const fetch = src('android/fetch-llm-libs.sh');
  assert.match(fetch, /^TAG=b\d+$/m, 'one pinned llama.cpp release');
  assert.match(fetch, /bin-android-arm64\.tar\.gz/);
  assert.match(fetch, /SHA=[0-9a-f]{64}/);
  assert.match(fetch, /--emulator/);
  assert.match(src('.gitignore'), /android\/app\/src\/main\/cpp\/include\//);
  assert.ok(!existsSync(join(ROOT, 'android/app/src/main/jniLibs/arm64-v8a/libllama.so')) || src('.gitignore').includes('jniLibs'), 'engine binaries are never committed');
});

test('web: the offline view and the chat show it as an offline answer, with Ask Sara again', () => {
  const view = src('web/offline-view.js');
  assert.match(view, /offlineAnswer/);
  assert.match(src('web/offline-answer.js'), /Offline answer/);
  assert.match(src('web/app.js'), /offlineAnswerChip\(/);
  const html = src('web/index.html');
  for (const id of ['offans-on', 'offans-state', 'offans-get', 'offans-del']) assert.match(html, new RegExp(`id="${id}"`));
});
