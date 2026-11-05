// Phase 12: dates that matter, the weekly look back, and her own life threads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { LifeWorker, threadsNote } from '../src/life.ts';
import { datesNote, parseOnDate, selectMemories } from '../src/memory.ts';
import { summarizeConversation } from '../src/memory-worker.ts';
import { WeeklyWorker } from '../src/weekly.ts';
import { makeApp, tempDir, text, type TestApp } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, now = '2026-10-24T20:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(now) };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: now });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock };
}

test('dates: real calendar days only; upcoming wraps the new year; yearly vs one-time; anniversaries count years', (t) => {
  const { app } = setup(t);
  assert.deepEqual(parseOnDate('03-14'), { year: null, month: 3, day: 14 });
  assert.equal(parseOnDate('02-30'), null);
  assert.ok(parseOnDate('02-29'), 'yearly Feb 29 is allowed');
  assert.equal(parseOnDate('2026-02-29'), null, 'not in 2026');
  assert.equal(parseOnDate('13-01'), null);
  const mem = app.memory!;
  const add = (content: string, onDate: string) => mem.add({ kind: 'date', content, onDate, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-01' });
  add("Alex's mom's birthday", '01-02');
  add('Alex and Dana met', '2019-12-31');
  add('Trip to Lisbon', '2027-01-05');
  add('Exam (past)', '2026-12-29');
  const up = mem.upcoming('2026-12-30', 10);
  assert.deepEqual(up.map((u) => [u.memory.content, u.inDays, u.years]), [
    ['Alex and Dana met', 1, 7],
    ["Alex's mom's birthday", 3, null],
    ['Trip to Lisbon', 6, null],
  ]);
  const note = datesNote(mem, '2027-01-02')!;
  assert.match(note, /TODAY \(Saturday, January 2\): Alex's mom's birthday/);
  assert.equal(datesNote(mem, '2027-06-01'), undefined);
});

test('memory worker: dates come from the owner\'s own words (quote-checked)', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  const m1 = app.store.addMessage(conv.id, 'user', "my mom's birthday is March 14, don't let me forget");
  app.store.addMessage(conv.id, 'assistant', "I won't! March 14.");
  app.script.push(
    text(
      JSON.stringify({
        summary: 'Alex told Sara about his mom.',
        facts: [],
        sara: [],
        dates: [
          { what: "Alex's mom's birthday", date: '03-14', message_id: m1.id, quote: "mom's birthday is March 14" },
          { what: "Alex's dad's birthday", date: '05-02', message_id: m1.id, quote: 'dad was born in May' },
          { what: 'Nonsense day', date: '02-31', message_id: m1.id, quote: "mom's birthday" },
        ],
      }),
    ),
  );
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.equal(r.dateIds?.length, 1, 'only the verified, real date is kept');
  const d = app.memory!.get(r.dateIds![0])!;
  assert.equal(d.onDate, '03-14');
  assert.equal(d.evidence, "mom's birthday is March 14");
});

test('dates in her prompt; on the day she texts about it once, even off her usual timing', async (t) => {
  const { app, clock } = setup(t, '2027-03-14T15:00:00Z');
  app.memory!.addOwner({ kind: 'date', content: "Alex's mom's birthday", onDate: '03-14', happenedOn: '2026-10-01' });
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'hi');
  clock.now = new Date('2027-03-14T15:00:00Z');
  // Proactive: random gate would say no (0.99), but a date today goes through.
  app.store.db.prepare('UPDATE messages SET created_at = ?').run('2027-03-13T08:00:00Z');
  const worker = new LifeWorker(app, app.life!, app.inner!, () => 0.99);
  app.script.push(text("Isn't it your mom's birthday today? Tell her happy birthday from me."));
  const r = await worker.maybeProactive();
  assert.match(r.proactive ?? '', /birthday/);
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /## Coming up[\s\S]*TODAY[\s\S]*Alex's mom's birthday/);
  assert.match(String(app.requests.at(-1)!.messages.at(-1)!.content), /Today is a date that matters to Alex: Alex's mom's birthday/);
  assert.equal(app.memory!.list({ kind: 'date' })[0].mentionedOn, '2027-03-14');
  // Once mentioned, the random gate applies again (later the same day).
  clock.now = new Date('2027-03-14T21:30:00Z');
  app.store.addMessage(conv.id, 'user', 'thanks!');
  app.store.db.prepare('UPDATE messages SET created_at = ?').run('2027-03-13T08:00:00Z');
  assert.equal((await worker.maybeProactive()).skipped, 'not this time');
});

test('a generic sourceless date does not trigger a proactive message or get marked mentioned', async (t) => {
  const { app } = setup(t, '2027-03-14T15:00:00Z');
  const birthday = app.memory!.add({ kind: 'date', content: "Alex's mom's birthday", onDate: '03-14', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-01' });
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'hi');
  app.store.db.prepare('UPDATE messages SET created_at = ?').run('2027-03-13T08:00:00Z');
  const markMentioned = t.mock.method(app.memory!, 'markMentioned');
  const worker = new LifeWorker(app, app.life!, app.inner!, () => 0.99);
  app.script.push(text("Isn't it your mom's birthday today? Tell her happy birthday from me."));

  assert.equal(birthday.origin, 'derived');
  assert.deepEqual(await worker.maybeProactive(), { skipped: 'not this time' });
  assert.equal(app.requests.length, 0, 'an unauthenticated date cannot bypass the random gate');
  assert.equal(app.store.messages(conv.id).length, 1, 'no proactive message is delivered');
  assert.equal(markMentioned.mock.callCount(), 0);
  assert.equal(app.memory!.get(birthday.id)!.mentionedOn, null);
});

test('weekly look back: patterns from the notes; older facts replaced (kept, no longer used)', async (t) => {
  const { app } = setup(t);
  const mem = app.memory!;
  for (const day of ['2026-10-19', '2026-10-21', '2026-10-23']) mem.add({ kind: 'summary', content: `Alex worked until midnight again on ${day}.`, conversationId: null, sourceMessageId: null, happenedOn: day });
  const oldFact = mem.add({ kind: 'fact', content: 'Alex lives in Austin.', conversationId: null, sourceMessageId: null, happenedOn: '2026-09-01' });
  const newFact = mem.add({ kind: 'fact', content: 'Alex moved to Denver.', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  app.store.createConversation();
  const w = new WeeklyWorker(app, mem, app.life, () => 0);
  app.script.push(text(JSON.stringify({ noticed: ['Alex has been working until midnight most nights this week.'], outdated: [{ old: oldFact.id, new: newFact.id }, { old: newFact.id, new: oldFact.id }] })));
  assert.equal(await w.reflect(), 'noticed 1, replaced 1');
  assert.match(String(app.requests.at(-1)!.messages[0].content), /\[#\d+ 2026-09-01\] Alex lives in Austin/);
  assert.equal(mem.get(oldFact.id)!.supersededBy, newFact.id);
  assert.equal(mem.get(newFact.id)!.supersededBy, null, 'a newer fact is never replaced by an older one');
  const sel = selectMemories(mem, { userText: 'where do I live', conversationId: 'x', oldestHistoryId: 0, budgetChars: 4000 });
  assert.doesNotMatch(sel.text, /Austin/);
  assert.match(sel.text, /something you noticed looking back over the week\) Alex has been working until midnight/);
  assert.equal(await w.reflect(), 'not due', 'once a week');
});

test('her life threads: start, move on weekly, finish only after weeks; owner threads are kept', async (t) => {
  const { app, clock } = setup(t);
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'hi');
  const life = app.life!;
  const w = new WeeklyWorker(app, app.memory, life, () => 0);
  app.script.push(text(JSON.stringify({ updates: [], new: [{ title: 'Reading "Piranesi" by Susanna Clarke', note: 'started it on the bus' }, { title: 'Learning to make sourdough', note: 'fed the starter' }, { title: 'A third one', note: 'x' }] })));
  assert.equal(await w.moveThreads(), 'moved 0, finished 0, started 2');
  const owner = life.addThread('Learning the guitar', '2026-10-24', { byOwner: true });
  assert.match(threadsNote(life)!, /Piranesi.*started it on the bus/);
  const [book, bread] = life.threads('active');
  // A week later: the model wants to finish everything; only the book has run 3 weeks.
  clock.now = new Date('2026-11-15T20:00:00Z');
  life.updateThread(book.id, { title: book.title });
  app.store.db.prepare("UPDATE sara_threads SET started_on = '2026-10-20' WHERE id = ?").run(book.id);
  app.store.db.prepare("UPDATE sara_threads SET started_on = '2026-11-10' WHERE id = ?").run(bread.id);
  app.script.push(text(JSON.stringify({ updates: [{ id: book.id, note: 'finished it, loved the ending', done: true }, { id: bread.id, note: 'first loaf was flat', done: true }, { id: owner.id, note: 'learned three chords', done: true }], new: [] })));
  assert.equal(await w.moveThreads(), 'moved 3, finished 1, started 0');
  assert.equal(life.thread(book.id)!.status, 'done');
  assert.equal(life.thread(bread.id)!.status, 'active', 'too new to finish');
  assert.equal(life.thread(owner.id)!.status, 'active', 'owner-given threads are kept');
  assert.match(String(app.requests.at(-1)!.messages[0].content), /Learning the guitar \(\d+ weeks? so far, keep going/);
  // In a normal chat she knows what she's into.
  app.settings.update({ persona: { innerLife: true } });
  app.script.push(text('Mostly bread disasters.'));
  for await (const _ of runTurn(app, conv.id, 'what have you been up to?')) void _;
  assert.match(String(app.requests.at(-1)!.messages[0].content), /## What you're into lately[\s\S]*Learning to make sourdough \(lately: first loaf was flat\)/);
});
