// F6 (docs/HER_WEEK.md "How I did this week"): her weekly check-in says how she did for the owner:
// replies that failed and why (grouped), the tools that failed most, backup models and for which
// model, slow replies and on which model, the receipt check's corrections, memory notes that could
// not be written, and the no-model eval page of this version. Counts and names from this space's own
// database only; no message text; an empty week is one sentence.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { herWeekFacts, herWeekText } from '../src/her-week.ts';
import { evalPageOf, failReason, HOW_EMPTY, howSheDid, SLOW_TURN_MS } from '../src/how-she-did.ts';
import { RunStore } from '../src/runs.ts';
import { makeApp, tempDir } from './helpers.ts';

const SECRET = 'my sister Dana and the clinic on Elm Street';
const NOW = '2026-11-24T15:00:00Z';

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(NOW) };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' });
  new RunStore(app.store.db, () => clock.now);
  const chat = app.store.createConversation({ channel: 'web', title: 'Chat' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, chat, dir };
}
const week = (now = NOW) => ({ from: new Date(Date.parse(now) - 7 * 86_400_000).toISOString(), to: new Date(Date.parse(now) + 1000).toISOString() });

function run(app: ReturnType<typeof makeApp>, at: string, ms: number, model: string, kind = 'turn') {
  const id = Number(app.store.db.prepare("INSERT INTO runs (kind, title, started_at, status, ms) VALUES (?, '', ?, 'ok', ?)").run(kind, at, ms).lastInsertRowid);
  app.store.db.prepare('INSERT INTO run_steps (run_id, idx, at, model) VALUES (?, 0, ?, ?)').run(id, at, model);
}

function seed(app: ReturnType<typeof makeApp>, chatId: string) {
  const s = app.store;
  s.addMessage(chatId, 'user', SECRET);
  // Replies that failed: two slow, one unreachable, one too long, one other. The words are never shown.
  s.addMessage(chatId, 'notice', `turnerror:${SECRET}`, { error: `no answer within 90 seconds ${SECRET}`, errorClass: 'SlowModelError' });
  s.addMessage(chatId, 'notice', 'turnerror:x', { error: 'timed out', errorClass: 'TurnError' });
  s.addMessage(chatId, 'notice', 'turnerror:x', { error: 'fetch failed', errorClass: 'TypeError' });
  s.addMessage(chatId, 'notice', 'turnerror:x', { error: 'request exceeds the available context size', errorClass: 'ProviderError' });
  s.addMessage(chatId, 'notice', 'turnerror:x', { error: SECRET, errorClass: 'Error' });
  // A backup model took over three times, twice for one model.
  for (const was of ['Ollama (qwen3.8:27b)', 'Ollama (qwen3.8:27b)', 'Cloud (big)']) s.addMessage(chatId, 'notice', `fallback:${was} failed`, { key: '{was} failed: {error}, so {now} took over.', params: { was, now: 'Cloud (backup)', error: SECRET } });
  // Tools.
  for (const name of ['web_fetch', 'web_fetch', 'web_fetch', 'mail_send', 'calendar_add']) s.addMessage(chatId, 'tool', SECRET, { toolCallId: name, name, status: 'error' });
  s.addMessage(chatId, 'tool', 'ok', { toolCallId: 'ok', name: 'planner_add', status: 'ok' });
  // The receipt check: three sentences in two replies.
  const a = s.addMessage(chatId, 'assistant', SECRET);
  s.updateMessageMeta(a.id, { unverified: [{ kind: 'write', sentence: SECRET }, { kind: 'run', sentence: SECRET }] });
  const b = s.addMessage(chatId, 'assistant', SECRET);
  s.updateMessageMeta(b.id, { unverified: [{ kind: 'remind', sentence: SECRET }] });
  // Slow replies: two over the mark on one model, one on another, one fast, one a job (not a reply).
  const at = app.now().toISOString();
  run(app, at, SLOW_TURN_MS + 5000, 'qwen3.8:27b');
  run(app, at, SLOW_TURN_MS * 2, 'qwen3.8:27b');
  run(app, at, SLOW_TURN_MS + 1, 'gemma4:12b');
  run(app, at, 4000, 'gemma4:12b');
  run(app, at, SLOW_TURN_MS * 3, 'gemma4:12b', 'job');
  // Memory notes that could not be written: one chat this week.
  app.store.db.prepare('INSERT INTO memory_state (conversation_id, summarized_through, last_attempt_at, last_error) VALUES (?, 0, ?, ?)').run(chatId, at, SECRET);
}

test('F6: counts and plain sentences from the week, grouped, with the models and tools named', (t) => {
  const { app, chat } = rig(t);
  seed(app, chat.id);
  const { from, to } = week();
  const h = howSheDid(app, from, to, { root: join(app.dataDir, 'nowhere') });
  assert.deepEqual(h.failed, { n: 5, why: { slow: 2, unreachable: 1, context: 1, other: 1 } });
  assert.deepEqual(h.tools, [{ name: 'web_fetch', n: 3 }, { name: 'calendar_add', n: 1 }, { name: 'mail_send', n: 1 }]);
  assert.deepEqual(h.fallbacks, { n: 3, models: [{ name: 'Ollama (qwen3.8:27b)', n: 2 }, { name: 'Cloud (big)', n: 1 }] });
  assert.deepEqual(h.slow, { n: 3, seconds: 60, models: [{ name: 'qwen3.8:27b', n: 2 }, { name: 'gemma4:12b', n: 1 }] });
  assert.deepEqual(h.corrections, { claims: 3, replies: 2 });
  assert.deepEqual(h.memory, { chats: 1 });
  assert.equal(h.evals, undefined, 'no eval page there');
  const keys = h.lines.map((l) => l.key);
  assert.deepEqual(keys, [
    'Replies that failed because the model took too long: {n}.',
    'Replies that failed because the model server could not be reached: {n}.',
    'Replies that failed because the conversation was too long for the model: {n}.',
    'Replies that failed for another reason: {n}.',
    'Tools that failed most: {list}.',
    'Times a backup model had to take over: {n} (the model that failed or was slow: {list}).',
    'Replies that took longer than {seconds} seconds: {n} (on {list}).',
    'Corrections the receipt check added: {n} sentences no tool backed up, in {replies} of my replies.',
    'Chats whose memory notes could not be written: {n}.',
  ]);
  assert.equal(h.lines[5].params.list, 'Ollama (qwen3.8:27b) × 2, Cloud (big) × 1');
  assert.equal(h.lines[6].params.list, 'qwen3.8:27b × 2, gemma4:12b × 1');
  assert.ok(!JSON.stringify(h).includes('Dana') && !JSON.stringify(h).includes('Elm'), 'no message or error text in it');
});

test('F6: an empty week says so in one sentence; last week is not counted', (t) => {
  const { app, clock, chat } = rig(t);
  clock.now = new Date('2026-11-10T15:00:00Z');
  seed(app, chat.id);
  run(app, '2026-11-10T15:00:00Z', SLOW_TURN_MS * 2, 'old-model');
  clock.now = new Date(NOW);
  const { from, to } = week();
  const h = howSheDid(app, from, to, { root: join(app.dataDir, 'nowhere') });
  assert.equal(h.failed.n + h.tools.length + h.fallbacks.n + h.slow.n + h.corrections.claims + h.memory.chats, 0);
  assert.deepEqual(h.lines, [{ key: HOW_EMPTY, params: {} }]);
});

test('F6: the eval page of the version he runs, for the owner only', (t) => {
  const { app, dir } = rig(t);
  const root = join(dir, 'src-root');
  mkdirSync(join(root, 'docs', 'results'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.equal(evalPageOf(root), undefined, 'no page for this version');
  writeFileSync(join(root, 'docs', 'results', '9.9.8-evals.md'), '# Evals that need no model\n\nSara 9.9.8 · 2026-11-01T00:00:00Z · 8 of 8 ended well\n');
  assert.equal(evalPageOf(root), undefined, 'an older version’s page is not this one');
  writeFileSync(
    join(root, 'docs', 'results', '9.9.9-evals.md'),
    '# Evals that need no model\n\nSara 9.9.9 · 2026-11-24T11:49:16.831Z · 7 of 8 ended well\n\n| Eval | What it checks | Ended | Its own words | Time |\n|---|---|---|---|---|\n| tools | x | ok | y | 1 s |\n| threat | x | **FAILED** | y | 0 s |\n',
  );
  assert.deepEqual(evalPageOf(root), { version: '9.9.9', ok: 7, all: 8, failed: ['threat'] });
  const { from, to } = week();
  const h = howSheDid(app, from, to, { root });
  assert.deepEqual(h.lines.map((l) => l.key), [HOW_EMPTY, 'The checks for this version ({version}) that need no model: {ok} of {all} ended well.', 'Checks that failed: {list}.']);
  assert.deepEqual(h.lines[1].params, { version: '9.9.9', ok: 7, all: 8 });
  (app as unknown as { member: unknown }).member = { id: 'm1' };
  assert.equal(howSheDid(app, from, to, { root }).evals, undefined, 'a household member does not get the server’s eval page');
});

test('F6: part of her weekly check-in (the card data and her message)', (t) => {
  const { app, chat } = rig(t);
  seed(app, chat.id);
  const w = herWeekFacts(app);
  assert.ok(w.how, 'the check-in carries how she did');
  assert.equal(w.how!.slow.n, 3);
  const text = herWeekText(app, w);
  assert.match(text, /How I did this week:/);
  assert.match(text, /- Replies that failed because the model took too long: 2\./);
  assert.match(text, /- Times a backup model had to take over: 3 \(the model that failed or was slow: Ollama \(qwen3\.8:27b\) × 2, Cloud \(big\) × 1\)\./);
  assert.ok(!text.includes('Dana'), 'no message text in her message');
  // In the owner's language.
  app.settings.update({ language: 'es' } as never);
  assert.match(herWeekText(app, herWeekFacts(app)), /Respuestas que fallaron porque el modelo tardó demasiado: 2\./);
});

test('F6: why a reply failed, from the error class and words', () => {
  assert.equal(failReason('SlowModelError', ''), 'slow');
  assert.equal(failReason('Error', 'connect ECONNREFUSED 127.0.0.1:11434'), 'unreachable');
  assert.equal(failReason('ProviderError', 'HTTP 429 rate limit'), 'limit');
  assert.equal(failReason('ProviderError', 'HTTP 401 Unauthorized'), 'auth');
  assert.equal(failReason('ProviderError', 'HTTP 400: request exceeds the available context size'), 'context');
  assert.equal(failReason('ProviderError', 'HTTP 503 overloaded'), 'service');
  assert.equal(failReason('Error', 'something odd'), 'other');
});
