// Phase 3.1–3.5: dated summaries after quiet, verified facts, FTS, inject budget, edit/delete/forget.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { ftsQuery, selectMemories } from '../src/memory.ts';
import { forgetMemory, MemoryWorker, parseMemoryJson, summarizeConversation } from '../src/memory-worker.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, clock = { now: new Date('2026-10-24T20:00:00Z') }): { app: TestApp; clock: { now: Date } } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
  });
  return { app, clock };
}

async function say(app: TestApp, convId: string, msg: string, reply = 'Got it.'): Promise<ChatEvent[]> {
  app.script.push(text(reply));
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, msg)) out.push(ev);
  return out;
}

const memJson = (summary: string, facts: { fact: string; message_id: number; quote: string }[]) => text(JSON.stringify({ summary, facts }));

test('3.1/3.2: quiet conversation → dated summary + facts that quote the owner; unverifiable facts are dropped', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation();
  await say(app, conv.id, "My dog's name is Biscuit, he's a beagle.");
  await say(app, conv.id, "I'm building a weather app called SunnyWeather.");
  const userIds = app.store.messages(conv.id).filter((m) => m.role === 'user').map((m) => m.id);

  const worker = new MemoryWorker(app, app.memory!);
  assert.equal(await worker.tick(), 0, 'not quiet yet');
  clock.now = new Date(clock.now.getTime() + 31 * 60_000);
  app.script.push(
    memJson('Alex and Sara talked about his dog and his weather app.', [
      { fact: "Alex's dog is a beagle named Biscuit.", message_id: userIds[0], quote: 'dog\'s name is Biscuit' },
      { fact: 'Alex is building SunnyWeather.', message_id: userIds[1], quote: 'weather app called SunnyWeather' },
      { fact: 'Alex has a sister named Ann.', message_id: userIds[0], quote: 'sister named Ann' }, // not in his words
      { fact: 'Sara likes coffee.', message_id: userIds[1] + 1, quote: 'Got it' }, // not an owner message
    ]),
  );
  assert.equal(await worker.tick(), 1);
  const facts = app.memory!.list({ kind: 'fact' });
  assert.deepEqual(facts.map((f) => f.content).sort(), ['Alex is building SunnyWeather.', "Alex's dog is a beagle named Biscuit."]);
  assert.ok(facts.every((f) => f.sourceMessageId && userIds.includes(f.sourceMessageId) && f.evidence && f.happenedOn === '2026-10-24'));
  const [summary] = app.memory!.list({ kind: 'summary' });
  assert.equal(summary.happenedOn, '2026-10-24');
  assert.equal(summary.sourceFromId, app.store.messages(conv.id).find((m) => m.role === 'user')!.id);
  // The summary request was made with the conversation's model, without tools.
  const req = app.requests.at(-1)!;
  assert.equal(req.tools, undefined);
  assert.match(req.messages[1].content as string, /\[#\d+ Alex .*\] My dog's name is Biscuit/);
  assert.equal(await worker.tick(), 0, 'nothing new to summarize');
});

test('3.1: invalid JSON is retried once, then backs off without losing the position', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation();
  await say(app, conv.id, 'I like brisket.');
  clock.now = new Date(clock.now.getTime() + 40 * 60_000);
  app.script.push(text('not json'), text('still not json'));
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.match(r.error ?? '', /valid JSON/);
  assert.equal(app.memory!.state(conv.id).summarizedThrough, 0);
  assert.deepEqual(app.memory!.dueConversations(new Date(clock.now.getTime()), new Date(clock.now.getTime() - 3_600_000)), [], 'backs off for an hour');
  assert.deepEqual(parseMemoryJson('```json\n{"summary":"x","facts":[{"fact":"a","message_id":"3","quote":"q"}]}\n```'), { summary: 'x', facts: [{ fact: 'a', message_id: 3, quote: 'q' }], sara: [], dates: [], decisions: [], promises: [], milestones: [], kept: [], outdated: [] });
});

test('3.3/3.4: FTS retrieval + fixed budget; injected into the prompt; ids recorded on the reply', async (t) => {
  const { app } = setup(t);
  const mem = app.memory!;
  const add = (kind: 'fact' | 'summary', content: string, on: string, conversationId: string | null = null) => mem.add({ kind, content, conversationId, sourceMessageId: null, happenedOn: on });
  add('fact', "Alex's dog is a beagle named Biscuit.", '2026-10-20');
  add('fact', 'Alex is building SunnyWeather, a weather app.', '2026-10-21');
  add('fact', 'Alex prefers tea in the morning.', '2026-10-22');
  add('summary', 'Alex and Sara fixed the practice-shop cart bugs together.', '2026-10-23', 'old-conv');
  for (let i = 0; i < 30; i++) add('fact', `Alex filler fact number ${i} about nothing important at all.`, '2026-10-01');

  assert.equal(ftsQuery('What is my dog called?'), '"dog" OR "called"');
  assert.equal(ftsQuery('the and you'), null);
  assert.equal(ftsQuery('"); DROP TABLE memories; --'), '"drop" OR "table" OR "memories"');

  const inj = selectMemories(mem, { userText: "what's my dog's name again?", conversationId: 'now', oldestHistoryId: 0, budgetChars: 300 });
  assert.match(inj.text.split('\n')[0], /Biscuit/, 'best match first');
  assert.ok(inj.chars <= 300);
  assert.ok(inj.ids.length >= 2);

  const conv = app.store.createConversation();
  await say(app, conv.id, "what's my dog's name again?", 'Biscuit!');
  const sys = app.requests.at(-1)!.messages[0].content as string;
  assert.match(sys, /## What you remember from before[\s\S]*\(2026-10-20(?:, (?:today|yesterday|\d+ \w+ ago))?\) Alex's dog is a beagle named Biscuit/);
  assert.match(sys, /don't deny it happened: say it's fuzzy for you and ask/);
  const last = app.store.messages(conv.id).at(-1)!;
  assert.ok(Array.isArray(last.meta?.memoryIds) && (last.meta!.memoryIds as number[]).length > 0, 'reply records which memories it saw');

  app.settings.update({ memory: { enabled: false } });
  await say(app, conv.id, 'dog?', 'hm');
  assert.doesNotMatch(app.requests.at(-1)!.messages[0].content as string, /What you remember/);
});

test('3.5: forget removes the fact, hides the source turn from Sara, drops covering summaries and re-summarizes', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation();
  await say(app, conv.id, 'My ex is called Dana, please never bring her up.');
  await say(app, conv.id, 'Anyway, I love trail maps.');
  const [dana, maps] = app.store.messages(conv.id).filter((m) => m.role === 'user');
  clock.now = new Date(clock.now.getTime() + 31 * 60_000);
  app.script.push(memJson('Alex mentioned Dana and trail maps.', [{ fact: "Alex's ex is Dana.", message_id: dana.id, quote: 'ex is called Dana' }]));
  await summarizeConversation(app, app.memory!, conv.id);
  const fact = app.memory!.list({ kind: 'fact' })[0];

  const r = forgetMemory(app, app.memory!, fact.id)!;
  assert.deepEqual(r.hiddenMessages, [dana.id]);
  assert.equal(app.memory!.list().length, 0, 'fact and covering summary removed');
  // Sara no longer sees the turn in that conversation either.
  await say(app, conv.id, 'what did I say earlier?', 'Something about trail maps.');
  const seen = JSON.stringify(app.requests.at(-1)!.messages);
  assert.doesNotMatch(seen, /Dana/);
  assert.match(seen, /trail maps/);
  // Re-summarized later without the forgotten turn.
  clock.now = new Date(clock.now.getTime() + 31 * 60_000);
  app.script.push(memJson('Alex talked about trail maps.', [{ fact: 'Alex loves trail maps.', message_id: maps.id, quote: 'love trail maps' }]));
  await summarizeConversation(app, app.memory!, conv.id);
  const summaryReq = app.requests.at(-1)!.messages[1].content as string;
  assert.doesNotMatch(summaryReq, /Dana/);
  assert.deepEqual(app.memory!.list({ kind: 'fact' }).map((f) => f.content), ['Alex loves trail maps.']);
});

test('3.5 API: list/search with source link, edit, delete, forget, remember-now, settings', async (t) => {
  const { app } = setup(t);
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const j = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers: H });
    return { status: res.status, body: await res.json() };
  };
  const conv = app.store.createConversation({ title: 'Dog talk' });
  await say(app, conv.id, 'My cat is named Pixel.');
  const uid = app.store.messages(conv.id).find((m) => m.role === 'user')!.id;
  app.script.push(memJson('Alex told Sara about his cat.', [{ fact: "Alex's cat is named Pixel.", message_id: uid, quote: 'cat is named Pixel' }]));
  const now = await j(`/conversations/${conv.id}/remember`, { method: 'POST', body: '{}' });
  assert.equal(now.status, 200);
  assert.equal(now.body.factIds.length, 1);

  const list = await j('/memories?kind=fact');
  assert.equal(list.body[0].source.title, 'Dog talk');
  assert.equal(list.body[0].source.messageId, uid);
  assert.equal((await j('/memories?q=cat')).body.length, 2, 'FTS search across facts and summaries');
  assert.equal((await j('/memories?q=pixel')).body.length, 1);
  const id = list.body[0].id;
  assert.equal((await j(`/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content: "Alex's cat Pixel is grey." }) })).body.edited, true);
  assert.equal((await j(`/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content: '' }) })).status, 400);
  assert.deepEqual((await j(`/memories/${id}/forget`, { method: 'POST', body: '{}' })).body.hiddenMessages, [uid]);
  assert.equal((await j('/memories')).body.length, 0);
  assert.equal((await j('/memory/settings')).body.quietMinutes, 30);
  assert.equal((await j('/memory/settings', { method: 'PUT', body: JSON.stringify({ quietMinutes: 5, injectBudgetChars: 99999 }) })).body.injectBudgetChars, 6000);
  const c = await j(`/conversations/${conv.id}`);
  assert.equal(c.body.messages.find((m: { id: number }) => m.id === uid).meta.forgotten, true);
});

test('forget with a two-word owner name removes only that note, not every note with the surname', (t) => {
  const { app } = setup(t);
  app.settings.update({ ownerName: 'Alex Smith' });
  const mem = app.memory!;
  const add = (content: string) => mem.add({ kind: 'fact', content, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-26' });
  const ex = add("Alex Smith's ex is Dana.");
  const job = add('Alex Smith works as a nurse at Mercy.');
  const dog = add('Alex Smith has a dog called Biscuit.');
  const danaToo = add('Dana moved to Ohio.');
  const r = forgetMemory(app, mem, ex.id)!;
  assert.deepEqual(r.removed.sort(), [ex.id, danaToo.id].sort(), 'the note and other notes about Dana go; the owner\'s own name is not a reason');
  assert.deepEqual(
    mem.list().map((m) => m.id).sort(),
    [job.id, dog.id].sort(),
  );
});

test('a conversation deleted while she is summarizing it leaves no notes behind', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation();
  await say(app, conv.id, 'My sister Priya lives in Leeds.');
  const [msg] = app.store.messages(conv.id).filter((m) => m.role === 'user');
  clock.now = new Date(clock.now.getTime() + 31 * 60_000);
  // The model answers only after the owner has deleted the conversation.
  const real = app.providerFactory!;
  app.providerFactory = (config) => {
    const p = real(config);
    return {
      ...p,
      config: p.config,
      listModels: p.listModels.bind(p),
      async *stream(req) {
        app.store.deleteConversation(conv.id);
        yield* p.stream(req);
      },
    };
  };
  app.script.push(memJson('Alex talked about Priya.', [{ fact: "Alex's sister Priya lives in Leeds.", message_id: msg.id, quote: 'sister Priya lives in Leeds' }]));
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.match(r.error ?? '', /changed while it was being summarized/);
  assert.equal(app.memory!.list().length, 0);
});

test('forgetting: a conversation with something forgotten is left out of "lately in your other conversations"', async (t) => {
  const { app } = setup(t);
  const { elsewhereNote } = await import('../src/elsewhere.ts');
  const b = app.store.createConversation({ title: 'B' });
  app.store.addMessage(b.id, 'user', "What's my dog's name?");
  const named = app.store.addMessage(b.id, 'assistant', 'Biscuit! The little beagle.');
  app.store.addMessage(b.id, 'assistant', 'That beagle who howls at everything kept you up, right?');
  const c = app.store.createConversation({ title: 'C' });
  const now = new Date(Date.parse(app.store.getConversation(b.id)!.updatedAt) + 60_000);
  assert.match(elsewhereNote(app, app.store.getConversation(c.id)!, now, 'Alex') ?? '', /beagle/);
  app.store.updateMessageMeta(named.id, { forgotten: true });
  assert.doesNotMatch(elsewhereNote(app, app.store.getConversation(c.id)!, now, 'Alex') ?? '', /beagle|Biscuit/);
});
