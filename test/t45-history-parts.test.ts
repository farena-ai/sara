// C9: learning from history reads a long imported conversation in parts (not only its newest
// 30,000 characters), each line once, at most HISTORY_MAX_PARTS model calls, and goes on from where
// it stopped. Invented people, the scripted model, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryImporter } from '../src/history-import/index.ts';
import { HISTORY_MAX_PARTS, historyParts } from '../src/memory-worker.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const NOW = new Date('2026-11-24T15:00:00Z');
const mark = (i: number) => `mk${String(i).padStart(3, '0')}`;

/** One imported ChatGPT conversation of `pairs` long owner lines, each with its own marker word. */
function setup(t: { after: (fn: () => void) => void }, pairs: number) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago' });
  const importer = new HistoryImporter(() => app, { learnGapMs: 0 });
  t.after(() => {
    importer.stop();
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation({ title: 'Garden plans', channel: 'import-chatgpt', channelKey: 'c-1' });
  for (let i = 0; i < pairs; i++) {
    app.store.addMessage(conv.id, 'user', `${mark(i)} ${'I am planning the garden beds for spring. '.repeat(60)}`, { importedFrom: 'chatgpt' });
    app.store.addMessage(conv.id, 'assistant', 'That sounds like a good plan.', { importedFrom: 'chatgpt' });
  }
  // Like a real import: marked as read to its end, so only "learn" reads it.
  app.memory!.setState(conv.id, { summarizedThrough: app.store.lastMessageId(conv.id), lastError: null });
  const prompts = () => app.requests.map((r) => String(r.messages[1].content));
  const summary = (n: number, facts: unknown[] = []) => text(JSON.stringify({ summary: `Alex and ChatGPT planned the garden, part ${n}.`, facts }));
  return { app, importer, conv, prompts, summary };
}

test('C9: a long imported conversation is read in parts: every line once, oldest facts kept', async (t) => {
  const { app, importer, conv, prompts, summary } = setup(t, 30);
  const parts = historyParts(app, conv.id);
  assert.ok(parts.length >= 2 && parts.length <= HISTORY_MAX_PARTS, `parts: ${parts.length}`);
  // The parts sit side by side and end at the last message.
  assert.equal(parts[0].fromId, 0);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].fromId, parts[i - 1].throughId);
  assert.equal(parts.at(-1)!.throughId, app.store.lastMessageId(conv.id));

  const first = app.store.messages(conv.id)[0];
  app.script.push(summary(1, [{ fact: 'Alex is planning garden beds for spring.', message_id: first.id, quote: 'planning the garden beds for spring' }]));
  for (let i = 1; i < parts.length; i++) app.script.push(summary(i + 1));
  importer.learnRest();
  await importer.idle();

  const st = importer.status();
  assert.equal(st.state, 'done', JSON.stringify(st));
  assert.equal(st.learned, 1, 'one conversation, however many parts');
  assert.equal(st.failed, 0);
  const sent = prompts();
  assert.equal(sent.length, parts.length, 'one model call for each part');
  assert.ok(sent.every((p) => p.length < 40_000), 'each call stays within the size of one part');
  for (let i = 0; i < 30; i++) assert.equal(sent.filter((p) => p.includes(mark(i))).length, 1, `${mark(i)} is read exactly once`);
  assert.ok(sent[0].includes(mark(0)) && sent.at(-1)!.includes(mark(29)), 'oldest part first');
  // The fact from the very first line (far outside the newest 30,000 characters) is kept.
  assert.deepEqual(app.memory!.list({ kind: 'fact' }).map((f) => f.content), ['Alex is planning garden beds for spring.']);
  assert.equal(app.memory!.list({ kind: 'summary' }).length, parts.length);
  assert.equal(st.notes, parts.length + 1);
  assert.equal(app.memory!.state(conv.id).summarizedThrough, app.store.lastMessageId(conv.id), 'the read mark never moves back');
});

test('C9: a huge conversation costs at most HISTORY_MAX_PARTS calls; its oldest lines are the ones left out', async (t) => {
  const pairs = 120;
  const { app, importer, conv, prompts, summary } = setup(t, pairs);
  const parts = historyParts(app, conv.id);
  assert.equal(parts.length, HISTORY_MAX_PARTS);
  assert.ok(parts[0].fromId > 0, 'starts after the oldest lines');
  for (let i = 0; i < HISTORY_MAX_PARTS + 3; i++) app.script.push(summary(i + 1));
  importer.learnRest();
  await importer.idle();
  const sent = prompts();
  assert.equal(sent.length, HISTORY_MAX_PARTS);
  assert.ok(!sent.some((p) => p.includes(mark(0))), 'the oldest line is left out');
  assert.equal(sent.filter((p) => p.includes(mark(pairs - 1))).length, 1, 'the newest line is read once');
  assert.equal(importer.status().learned, 1);
});

test('C9: learning goes on from the saved place after a restart, without reading a part twice', async (t) => {
  const { app, importer, conv, prompts, summary } = setup(t, 30);
  const parts = historyParts(app, conv.id);
  assert.ok(parts.length >= 2);
  // Asking again from the end of a finished part gives exactly the parts that are left.
  assert.deepEqual(historyParts(app, conv.id, parts[0].throughId), parts.slice(1));
  // The queue as a stopped server left it: the first part of this conversation is done.
  app.memory!.kvSet('history-import:queue', JSON.stringify({ ids: [conv.id], total: 1, learned: 0, notes: 1, failed: 0, paused: false, part: { id: conv.id, through: parts[0].throughId } }));
  for (let i = 1; i < parts.length; i++) app.script.push(summary(i + 1));
  importer.start();
  await importer.idle();
  const sent = prompts();
  assert.equal(sent.length, parts.length - 1, 'only the parts that were left');
  assert.ok(!sent.some((p) => p.includes(mark(0))), 'the finished part is not read again');
  assert.equal(sent.filter((p) => p.includes(mark(29))).length, 1);
  const st = importer.status();
  assert.equal(st.state, 'done', JSON.stringify(st));
  assert.equal(st.learned, 1);
});

test('C9: a short imported conversation is still one call', async (t) => {
  const { app, importer, conv, prompts, summary } = setup(t, 2);
  assert.equal(historyParts(app, conv.id).length, 1);
  app.script.push(summary(1));
  importer.learnRest();
  await importer.idle();
  assert.equal(prompts().length, 1);
  assert.equal(importer.status().learned, 1);
});
