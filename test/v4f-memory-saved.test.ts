// 3.0.3 (docs/ops/V4_DESIGN.md → V4f): "Saved n new memories" in the run card under her reply. The
// reply's meta records the memories written during the turn (her tools: person_note, lessons…) and the
// ones the memory worker pulls out later (facts, dates, promises… cite the owner's message: they go on
// that turn's reply, and a `memory` event with `saved` redraws the open chat).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import type { HubEvent } from '../src/events.ts';
import { attachSaved } from '../src/memory-saved.ts';
import { summarizeConversation } from '../src/memory-worker.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }): TestApp {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-09T18:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago' });
  // A remember-like tool: writes one note in this conversation.
  app.tools.add({
    spec: { name: 'note_it', description: 'note', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: () => 'Note',
    async run(_a: unknown, ctx: { conversationId?: string }) {
      app.memory!.add({ kind: 'fact', content: 'Alex likes tea.', conversationId: ctx.conversationId ?? null, sourceMessageId: null, happenedOn: '2026-11-09' });
      app.memory!.add({ kind: 'fact', content: 'Elsewhere.', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-09' });
      return 'Saved.';
    },
  } as never);
  return app;
}

async function turn(app: TestApp, convId: string, msg: string, ...steps: ReturnType<typeof text>[]) {
  app.script.push(...steps);
  for await (const _ of runTurn(app, convId, msg)) void _;
}

test('V4f saved: memories her tools wrote during the turn go on the reply (this chat only)', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  await turn(app, conv.id, 'I like tea, remember that', [call('c1', 'note_it', {})], text('Noted!'));
  const reply = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  const ids = reply.meta?.savedMemoryIds as number[];
  assert.equal(ids.length, 1);
  assert.equal(app.memory!.get(ids[0])!.content, 'Alex likes tea.');
  // A turn that saved nothing has no list.
  await turn(app, conv.id, 'thanks', text('Any time.'));
  assert.equal(app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!.meta?.savedMemoryIds, undefined);
});

test('V4f saved: facts the memory worker pulls out later go on the reply of the turn they came from', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  await turn(app, conv.id, "My dog's name is Biscuit.", text('Cute!'));
  await turn(app, conv.id, "I'm building an app called SunnyWeather.", text('Nice.'));
  const users = app.store.messages(conv.id).filter((m) => m.role === 'user');
  const replies = app.store.messages(conv.id).filter((m) => m.role === 'assistant');
  const events: HubEvent[] = [];
  app.events!.subscribe((e) => events.push(e));
  app.script.push(text(JSON.stringify({ summary: 'Dog and app.', facts: [{ fact: "Alex's dog is named Biscuit.", message_id: users[0].id, quote: "dog's name is Biscuit" }, { fact: 'Alex is building SunnyWeather.', message_id: users[1].id, quote: 'app called SunnyWeather' }] })));
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.equal(r.factIds.length, 2);
  const after = (id: number) => app.store.messageById(id)!.meta?.savedMemoryIds as number[] | undefined;
  assert.deepEqual(after(replies[0].id), [r.factIds[0]]);
  assert.deepEqual(after(replies[1].id), [r.factIds[1]]);
  // The summary itself is not a "new memory" of a reply; the event says how many were saved.
  const ev = events.find((e) => e.type === 'memory') as { conversationId: string; saved?: number };
  assert.equal(ev.conversationId, conv.id);
  assert.equal(ev.saved, 2);
});

test('V4f saved: attachSaved merges without duplicates and finds the last reply of the turn', (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  const u = app.store.addMessage(conv.id, 'user', 'hi');
  app.store.addMessage(conv.id, 'assistant', 'step one');
  const last = app.store.addMessage(conv.id, 'assistant', 'final', { savedMemoryIds: [3] });
  app.store.addMessage(conv.id, 'user', 'next');
  assert.equal(attachSaved(app, conv.id, [{ id: 3, sourceMessageId: u.id }, { id: 5, sourceMessageId: u.id }, { id: 6, sourceMessageId: null }]), 2);
  assert.deepEqual(app.store.messageById(last.id)!.meta?.savedMemoryIds, [3, 5]);
});

test('V4f saved: the run card shows "Saved n new memories" linking to Memory with those highlighted', () => {
  const steps = readFileSync(join(ROOT, 'web', 'steps.js'), 'utf8');
  assert.match(steps, /export function savedStep\(box, count, \{ ids = \[\], open \} = \{\}\)/);
  assert.match(steps, /count === 1 \? t\('Saved 1 new memory'\) : t\('Saved \{n\} new memories', \{ n: count \}\)/);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /m\.meta\?\.savedMemoryIds\)\) for \(const id of m\.meta\.savedMemoryIds\) turn\.saved\.add\(id\)/);
  assert.match(app, /savedStep\(\(turn\.steps \?\?= newSteps\(\)\), turn\.saved\.size, \{ ids: \[\.\.\.turn\.saved\], open: \(ids\) => void openMemory\(\{ focusIds: ids \}\) \}\)/);
  // Late extraction: the open chat redraws when its memories land.
  assert.match(app, /es\.addEventListener\('memory', \(e\) => \{/);
  assert.match(app, /ev\.saved > 0 && ev\.conversationId === state\.currentId/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8');
    for (const s of ['Saved 1 new memory', 'Saved {n} new memories', 'New things she noted about you from this conversation.', 'See them in Memory']) assert.ok(tr.includes(`"${s}":`), `${lang}: ${s}`);
  }
});
