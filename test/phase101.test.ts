// Phase 101 (ST6, docs/design/STAPLES.md §9, docs/PEOPLE.md): people cards. Extraction (the memory
// worker's `about` → a proposed card with the fact linked to its memory; editing the memory updates
// the fact, forgetting it removes it), the backfill (300 seeded notes, 12 planted people), proposals
// first (nothing in recall until accepted or mentioned in 3 conversations), disambiguation ("Jeff"
// vs "Jeff from work"), the People section (budget, dates, private and sensitive rules), never to
// outside (/v1, MCP, A2A, plugins, outside requests, group chats, partner chats), merge / split /
// forget (with and without memories: vectors and FTS really gone), birthdays on Today once, the
// routes, the tools and the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateQuote } from '../src/a2a-client.ts';
import { OwnerAuth } from '../src/auth.ts';
import { PEOPLE_TOOLS, runTurn, type ChatEvent, type TurnOptions } from '../src/chat.ts';
import { MemoryVectors } from '../src/embeddings.ts';
import { forgetMemory, summarizeConversation } from '../src/memory-worker.ts';
import { backfillPrompt, parseBackfill, runBackfill } from '../src/people-backfill.ts';
import { createPeopleTools } from '../src/people-tools.ts';
import { circleOf, ownRelation, PeopleStore, peopleInText } from '../src/people.ts';
import { sharedNotesFor } from '../src/plugins/manager.ts';
import { createSaraServer } from '../src/server.ts';
import { buildToday } from '../src/today.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-20T15:00:00Z');

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: NOW.toISOString() });
  const people = new PeopleStore(app.store.db, { now: () => clock.now, photoDir: join(dir, 'people'), ownWords: () => ['Alex', app.persona.name] });
  app.people = people;
  for (const tl of createPeopleTools(() => app)) app.tools.add(tl);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, people, clock, dir };
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
const promptOf = (app: TestApp, i = -1) => JSON.stringify(app.requests.at(i)?.messages ?? '');

/** A fact memory about a person, linked through the code path (as the worker would). */
function plant(app: TestApp, people: PeopleStore, content: string, about: { name: string; relation?: string }[], opts: { conversationId?: string | null; category?: 'health' | 'money' | null; private?: boolean; day?: string } = {}) {
  const m = app.memory!.add({ kind: 'fact', content, conversationId: opts.conversationId ?? null, sourceMessageId: null, happenedOn: opts.day ?? '2026-10-12', evidence: content });
  people.linkMemory(m, about, { category: opts.category ?? null, private: Boolean(opts.private) });
  return m;
}

test('relations and circles: his words, normalised; code finds people with a relation', () => {
  assert.equal(ownRelation('brother'), 'my brother');
  assert.equal(ownRelation("Alex's manager", ['Alex']), 'my manager');
  assert.equal(ownRelation('his sister'), 'my sister');
  assert.equal(ownRelation("Jeff's wife"), "Jeff's wife");
  assert.equal(circleOf('my brother'), 'family');
  assert.equal(circleOf('my girlfriend'), 'partner');
  assert.equal(circleOf('my manager'), 'work');
  assert.equal(circleOf('my neighbour'), 'neighbour');
  assert.equal(circleOf('my best friend'), 'friend');
  assert.equal(circleOf('my business partner'), 'work');
  assert.equal(circleOf('the plumber'), 'other');
  const found = peopleInText("Alex's brother Jeff got a job; Jeff's wife Lea is a nurse. Priya Shah, his manager, moved to Denver in March.", ['Alex']);
  assert.deepEqual(found.map((x) => `${x.name}|${x.relation}`).sort(), ["Jeff|my brother", "Lea|Jeff's wife", 'Priya Shah|my manager']);
  assert.deepEqual(peopleInText('Alex went to Lisbon in May with his dog Biscuit.', ['Alex']), [], 'places, months and pets are not people');
});

test('extraction (fake model): "my brother Jeff got a job at the bakery" → a proposed card, the fact linked to its memory; editing / forgetting the memory follows', async (t) => {
  const { app, people } = setup(t);
  const conv = app.store.createConversation({ title: 'Chat' });
  const said = app.store.addMessage(conv.id, 'user', 'Big news: my brother Jeff got a job at the bakery!');
  app.store.addMessage(conv.id, 'assistant', 'That is great news for Jeff!');
  app.script.push(text(JSON.stringify({ summary: 'Alex told Sara his brother got a job.', facts: [{ fact: "Alex's brother Jeff got a job at the bakery.", message_id: said.id, quote: 'my brother Jeff got a job at the bakery', about: [{ name: 'Jeff', relation: 'brother' }], category: null }, { fact: 'Alex likes invented people.', message_id: said.id, quote: 'Big news', about: [{ name: 'Zorblax', relation: 'friend' }] }], sara: [], dates: [] })));
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.equal(r.factIds.length, 2);
  const list = people.list();
  assert.deepEqual(list.map((p) => p.name), ['Jeff'], 'a name that is not in his own words gets no card');
  const jeff = list[0];
  assert.equal(jeff.relation, 'my brother');
  assert.equal(jeff.circle, 'family');
  assert.equal(jeff.status, 'proposed', 'proposals first');
  const facts = people.facts(jeff.id);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].memoryId, r.factIds[0]);
  assert.equal(facts[0].messageId, said.id);
  assert.equal(facts[0].conversationId, conv.id);
  // Editing the memory updates the fact (memories are the source of truth).
  app.memory!.update(r.factIds[0], "Alex's brother Jeff got a job at the new bakery on Main Street.");
  assert.match(people.facts(jeff.id)[0].content, /new bakery on Main Street/);
  // Superseding carries over.
  app.memory!.supersede(r.factIds[0], 999);
  assert.equal(people.facts(jeff.id).length, 0);
  assert.equal(people.facts(jeff.id, { all: true })[0].supersededBy, 999);
  app.memory!.supersede(r.factIds[0], null);
  // Forgetting the memory removes the fact.
  forgetMemory(app, app.memory!, r.factIds[0]);
  assert.equal(people.facts(jeff.id, { all: true }).length, 0);
  // Without `about` from the model, code still finds "Alex's sister Ana" in the fact.
  const c2 = app.store.createConversation({ title: 'Two' });
  const m2 = app.store.addMessage(c2.id, 'user', 'my sister Ana is a nurse in Denver');
  app.script.push(text(JSON.stringify({ summary: 'Alex talked about his sister.', facts: [{ fact: "Alex's sister Ana is a nurse in Denver.", message_id: m2.id, quote: 'my sister Ana is a nurse' }], sara: [], dates: [] })));
  await summarizeConversation(app, app.memory!, c2.id);
  const ana = people.list().find((p) => p.name === 'Ana');
  assert.ok(ana, 'code fallback');
  assert.equal(ana.relation, 'my sister');
});

test('the extraction prompt asks for `about` and the sensitive category; a sensitive fact is tagged and marks the card', async (t) => {
  const { app, people } = setup(t);
  const { memoryPrompt } = await import('../src/memory-worker.ts');
  const p = memoryPrompt('Alex', '[#1 Alex] hi');
  assert.match(p, /"about": \[\{"name"/);
  assert.match(p, /category \(facts\): "health", "intimate", "money" or "legal"/);
  const conv = app.store.createConversation({ title: 'Chat', private: true });
  const said = app.store.addMessage(conv.id, 'user', 'my friend Jamie has surgery on her knee next week');
  app.script.push(text(JSON.stringify({ summary: 'Alex talked about Jamie.', facts: [{ fact: "Alex's friend Jamie has knee surgery next week.", message_id: said.id, quote: 'my friend Jamie has surgery on her knee', about: [{ name: 'Jamie', relation: 'my friend' }], category: 'health' }], sara: [], dates: [] })));
  // A private conversation needs a local model.
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }] });
  await summarizeConversation(app, app.memory!, conv.id);
  const jamie = people.list().find((x) => x.name === 'Jamie')!;
  assert.ok(jamie.sensitive);
  const f = people.facts(jamie.id)[0];
  assert.equal(f.category, 'health');
  assert.equal(f.private, true, 'learned in a private conversation');
});

/** 300 notes about Alex with 12 planted people (each named with a relation at least once) and distractors. */
function seedNotes(app: TestApp): string[] {
  const planted = [
    ['Jeff', 'brother'], ['Lea', 'sister-in-law'], ['Priya', 'manager'], ['Tomas', 'coworker'], ['Mia', 'niece'], ['Rosa', 'neighbour'],
    ['Dmitri', 'best friend'], ['Hana', 'girlfriend'], ['Oscar', 'dad'], ['Ines', 'mom'], ['Kofi', 'roommate'], ['Sven', 'cousin'],
  ];
  const fillers = ['Alex likes strong coffee in the morning.', 'Alex went to Lisbon in May.', 'Alex runs on Tuesdays and Thursdays.', 'Alex is learning Spanish on Duolingo.', 'Alex watched Dune at the cinema.', 'Alex has a dog called Biscuit.', 'Alex wants to visit Denver in December.', 'Alex reads before bed.', 'Alex prefers tea after lunch.', 'Alex fixed the bike in the garage.', 'Alex uses Linux at work.', 'Alex bought a new phone from Apple.'];
  let n = 0;
  const add = (content: string) => {
    app.memory!.add({ kind: n % 9 === 0 ? 'date' : 'fact', content, conversationId: null, sourceMessageId: null, happenedOn: `2026-0${1 + (n % 9)}-1${n % 9}`, evidence: content, ...(n % 9 === 0 ? { onDate: '03-14' } : {}) });
    n++;
  };
  for (const [name, rel] of planted) {
    add(`Alex's ${rel} ${name} loves hiking in the mountains.`);
    add(`${name} is coming over for dinner on Friday.`);
    add(`Alex talked to ${name} about the holidays.`);
  }
  for (let i = 0; n < 300; i++) add(fillers[i % fillers.length].replace('.', i >= fillers.length ? ` (${i}).` : '.'));
  return planted.map((p) => p[0]);
}

test('backfill: 300 seeded notes propose the planted 12 people (≥ 11 found, ≤ 1 false), within budget; nothing reaches recall until accepted or mentioned 3×', async (t) => {
  const { app, people } = setup(t);
  const planted = seedNotes(app);
  app.store.createConversation({ title: 'Chat' });
  // The model sees batches of 40 and answers (sometimes nothing, once a person who isn't in the note).
  let calls = 0;
  for (let i = 0; i < 8; i++) app.script.push(text(i === 1 ? JSON.stringify({ people: [{ name: 'Gandalf', relation: 'friend', notes: [1, 2] }] }) : '{"people": []}'));
  const st = await runBackfill(app, { budget: 200_000 });
  calls = app.requests.length;
  assert.equal(st.state, 'done');
  assert.equal(st.total, 300);
  assert.equal(calls, 8, 'one model call per batch of 40');
  assert.ok(st.tokens > 0 && st.tokens <= 200_000, `tokens ${st.tokens}`);
  const found = people.list({ status: 'proposed' }).map((p) => p.name);
  const hits = planted.filter((n) => found.includes(n));
  const falses = found.filter((n) => !planted.includes(n));
  assert.ok(hits.length >= 11, `found ${hits.length}/12: ${found.join(', ')}`);
  assert.ok(falses.length <= 1, `false people: ${falses.join(', ')}`);
  assert.ok(!found.includes('Gandalf'), 'a model name that is not in the cited note is dropped');
  assert.equal(st.proposed, found.length);
  // Every card has its facts with sources (3 per planted person: the relation note and the other two).
  const jeff = people.list().find((p) => p.name === 'Jeff')!;
  assert.equal(people.facts(jeff.id).length, 3);
  assert.equal(jeff.relation, 'my brother');
  // A tight budget stops the model calls (code still finds people).
  const { app: app2, people: p2 } = setup(t);
  seedNotes(app2);
  app2.store.createConversation({ title: 'Chat' });
  const st2 = await runBackfill(app2, { budget: 1000 });
  assert.ok(app2.requests.length >= 1 && app2.requests.length <= 2, `calls ${app2.requests.length}`);
  assert.ok(st2.tokens < 1000 + 700, `tokens ${st2.tokens}`);
  assert.ok(p2.list({ status: 'proposed' }).length >= 11);
  // Nothing in recall while proposed.
  const sec = (who: PeopleStore, s: string, conv?: string) => who.section(s, { owner: 'Alex', private: false, maxChars: 1500, today: '2026-10-20', ...(conv ? { conversationId: conv } : {}) }).text;
  assert.equal(sec(people, 'Jeff is visiting'), '');
  people.accept(jeff.id);
  assert.match(sec(people, 'Jeff is visiting'), /Jeff — your brother/);
  // Mentioned in 3 conversations without being rejected → active, marked as added on her own.
  const priya = people.list().find((p) => p.name === 'Priya')!;
  for (let i = 0; i < 3; i++) {
    const c = app.store.createConversation({ title: `C${i}` });
    const m = app.store.addMessage(c.id, 'user', `Priya asked me about the report again (${i})`);
    people.noteMessage(c.id, m.id, m.content, NOW.toISOString());
  }
  const after = people.get(priya.id)!;
  assert.equal(after.status, 'active');
  assert.equal(after.origin, 'her');
  assert.equal(after.mentions, 3);
  // The prompt and its parser.
  assert.match(backfillPrompt('Alex', [{ id: 4, content: 'x' }]), /4\. x/);
  assert.deepEqual(parseBackfill('```json\n{"people":[{"name":"Ana","relation":null,"notes":[3]}]}\n```'), [{ name: 'Ana', relation: null, notes: [3] }]);
  assert.deepEqual(parseBackfill('no'), []);
});

/** Two Jeffs: the brother and the one from work. */
function twoJeffs(app: TestApp, people: PeopleStore) {
  const bro = people.create({ name: 'Jeff', relation: 'my brother', status: 'active', origin: 'owner' });
  const work = people.create({ name: 'Jeff', relation: 'my coworker', aliases: ['Jeff from work'], status: 'active', origin: 'owner' });
  plant(app, people, "Alex's brother Jeff got a job at the bakery.", [{ name: 'Jeff', relation: 'my brother' }]);
  plant(app, people, "Alex's coworker Jeff is moving to the Berlin office.", [{ name: 'Jeff', relation: 'my coworker' }]);
  return { bro, work };
}

test('disambiguation: "Jeff from work" → the work card; "Jeff" after the brother → the brother; a cold "Jeff" → the note (no guess); the answer adds an alias', (t) => {
  const { app, people } = setup(t);
  const { bro, work } = twoJeffs(app, people);
  assert.equal(people.facts(bro.id).length, 1, 'each relation found its own card');
  assert.equal(people.facts(work.id).length, 1);
  assert.deepEqual(people.find('Jeff from work wants the slides').found.map((p) => p.id), [work.id]);
  assert.deepEqual(people.find('My brother Jeff called').found.map((p) => p.id), [bro.id], 'a relation next to the name');
  // Context: the brother was just talked about in this conversation.
  const c = app.store.createConversation({ title: 'Family' });
  const m1 = app.store.addMessage(c.id, 'user', 'My brother Jeff is visiting this weekend');
  people.noteMessage(c.id, m1.id, m1.content, NOW.toISOString());
  const m2 = app.store.addMessage(c.id, 'user', 'Jeff wants to go hiking');
  const r2 = people.noteMessage(c.id, m2.id, m2.content, NOW.toISOString());
  assert.deepEqual(r2.found.map((p) => p.id), [bro.id]);
  // A cold "Jeff" in a new conversation: no guess, the note asks.
  const cold = app.store.createConversation({ title: 'Cold' });
  const m3 = app.store.addMessage(cold.id, 'user', 'Jeff said hi today');
  const r3 = people.noteMessage(cold.id, m3.id, m3.content, NOW.toISOString());
  assert.equal(r3.found.length, 0);
  assert.equal(r3.ambiguous.length, 1);
  const sec = people.section(m3.content, { conversationId: cold.id, owner: 'Alex', private: false, maxChars: 1500, today: '2026-10-20' }).text;
  assert.match(sec, /"Jeff" could be Jeff \(your brother\) or Jeff \(your coworker\)/);
  assert.match(sec, /Don't guess/);
  assert.match(sec, /Your brother Jeff or/);
  // His answer: "my brother" → this conversation's alias; the next "Jeff" is the brother.
  const m4 = app.store.addMessage(cold.id, 'user', 'my brother, sorry');
  people.noteMessage(cold.id, m4.id, m4.content, NOW.toISOString());
  const m5 = app.store.addMessage(cold.id, 'user', 'Jeff also asked about Christmas');
  assert.deepEqual(people.find(m5.content, { conversationId: cold.id, beforeMessageId: m5.id }).found.map((p) => p.id), [bro.id]);
  // A shared work channel prefers the work card when nothing else says.
  const wc = app.store.createConversation({ title: 'Work' });
  assert.deepEqual(people.find('Jeff sent the slides', { conversationId: wc.id, work: true }).found.map((p) => p.id), [work.id]);
  // New facts about an unresolved "Jeff" wait on both cards until it's clear.
  const m = app.memory!.add({ kind: 'fact', content: 'Jeff is learning the guitar.', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-19', evidence: 'x' });
  people.linkMemory(m, [{ name: 'Jeff' }]);
  const held = [...people.facts(bro.id), ...people.facts(work.id)].filter((f) => f.memoryId === m.id);
  assert.equal(held.length, 2);
  assert.ok(held.every((f) => f.pending));
  people.resolvePending(held[0].id);
  assert.equal([...people.facts(bro.id), ...people.facts(work.id)].filter((f) => f.memoryId === m.id).length, 1);
});

test('recall: the People section is inside the memory budget, dated, private facts only in private chats, sensitive only on topic', async (t) => {
  const { app, people } = setup(t);
  const jamie = people.create({ name: 'Jamie', relation: 'my friend', birthday: '11-02', status: 'active', origin: 'owner' });
  plant(app, people, "Alex's friend Jamie started pottery classes.", [{ name: 'Jamie' }], { day: '2026-10-12' });
  plant(app, people, 'Jamie is secretly planning to propose to Sam.', [{ name: 'Jamie' }], { private: true, day: '2026-10-14' });
  plant(app, people, 'Jamie has a knee surgery coming up.', [{ name: 'Jamie' }], { category: 'health', day: '2026-10-15' });
  const s = (msg: string, priv = false, max = 1500) => people.section(msg, { owner: 'Alex', private: priv, maxChars: max, today: '2026-10-20' }).text;
  const normal = s('What should I get Jamie for her birthday?');
  assert.match(normal, /Jamie — your friend, birthday Nov 2; Alex's friend Jamie started pottery classes \(Oct 12\)/);
  assert.ok(!/propose/.test(normal), 'private facts stay out of normal conversations');
  assert.ok(!/surgery/.test(normal), 'sensitive facts only on topic');
  assert.match(s('Jamie is nervous, any idea?', true), /propose/);
  assert.match(s('How is Jamie doing after the doctor visit?'), /surgery/);
  assert.ok(s('What should I get Jamie for her birthday?', false, 60).length <= 60);
  assert.ok(s('anything new?') === '', 'nobody named: nothing');
  // In a real turn: the section is in the prompt and the notes + people stay within the budget.
  app.settings.update({ memory: { enabled: true, quietMinutes: 30, injectBudgetChars: 1000, budgetMoved: true } as never });
  for (let i = 0; i < 40; i++) app.memory!.add({ kind: 'fact', content: `Alex enjoys birthday gifts and long walks number ${i} with friends near the river.`, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-01', evidence: 'x' });
  const conv = app.store.createConversation({ title: 'Gifts' });
  app.script.push(text('Pottery tools!'));
  await drain(runTurn(app, conv.id, 'What should I get Jamie for her birthday?'));
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /### People in this message/);
  assert.match(sys, /Jamie — your friend/);
  const notes = sys.slice(sys.indexOf('### Your notes'), sys.indexOf('### People in this message'));
  const peopleBlock = sys.slice(sys.indexOf('### People in this message')).split('\n## ')[0];
  const lines = (blk: string) => blk.split('\n').filter((l) => l.startsWith('- ')).join('\n').length;
  assert.ok(lines(notes) + lines(peopleBlock) <= 1000 + 2, `budget: ${lines(notes)} + ${lines(peopleBlock)}`);
  assert.equal(people.get(jamie.id)!.mentions, 1, 'the owner message counts as a mention');
});

test('outside: /v1, MCP, A2A (shared notes), plugins, outside requests, group chats and partner chats get no people data; outgoing A2A text quoting a card is refused', async (t) => {
  const { app, people, dir } = setup(t);
  const conv = app.store.createConversation({ title: 'Plans' });
  const jamie = people.create({ name: 'Jamiesonne', relation: 'my friend', birthday: '10-22', status: 'active', origin: 'owner' });
  plant(app, people, "Alex's friend Jamiesonne collects vintage typewriters.", [{ name: 'Jamiesonne' }], { conversationId: conv.id });
  const dateMem = app.memory!.add({ kind: 'date', content: "Jamiesonne's birthday", onDate: '10-22', conversationId: conv.id, sourceMessageId: null, happenedOn: '2026-10-01', evidence: 'x' });
  people.linkMemory(dateMem, [{ name: 'Jamiesonne' }]);
  app.memory!.add({ kind: 'fact', content: 'Alex likes zebra-striped mugs.', conversationId: conv.id, sourceMessageId: null, happenedOn: '2026-10-01', evidence: 'x' });
  app.memory!.add({ kind: 'summary', content: 'Alex and Sara talked about Jamiesonne and typewriters.', conversationId: conv.id, sourceMessageId: 1, sourceFromId: 1, happenedOn: '2026-10-01' });
  app.store.addMessage(conv.id, 'user', 'Jamiesonne loves typewriters');
  const leaks = (s: string) => /Jamiesonne|typewriter/i.test(s);
  // Another app's turn (/v1, MCP ask_sara, Home Assistant).
  const api = app.store.createConversation({ title: 'API', channel: 'api' });
  app.script.push(text('ok'));
  await drain(runTurn(app, api.id, 'what do you know about my friends and mugs?', undefined, { externalApp: true }));
  assert.ok(!leaks(promptOf(app)), 'other apps: no people');
  assert.match(promptOf(app), /zebra-striped/, 'other notes still come');
  assert.ok(!(app.requests.at(-1)!.tools ?? []).some((x) => PEOPLE_TOOLS.has(x.name)), 'no people tools for other apps');
  // An outside request (A2A peer with shared notes; webhooks and plugin schedules use the same policy).
  const a2a = app.store.createConversation({ title: 'Agent', channel: 'a2a' });
  app.script.push(text('ok'));
  await drain(runTurn(app, a2a.id, 'Tell me about Alex and the people around them', undefined, { outside: { source: 'a2a:x', label: 'Helper', operator: 'my owner', tools: ['person_lookup', 'people_list'], approvals: 'deny', memory: 'shared' } } as TurnOptions));
  assert.ok(!leaks(promptOf(app)), 'A2A shared notes: no people');
  assert.ok(!(app.requests.at(-1)!.tools ?? []).some((x) => PEOPLE_TOOLS.has(x.name)), 'a peer is never offered people tools, even when listed');
  // A group chat.
  const group = app.store.createConversation({ title: 'Room', channel: 'group' });
  app.store.addMessage(group.id, 'user', 'what are we doing this weekend?');
  app.script.push(text('ok'));
  await drain(runTurn(app, group.id, 'what are we doing this weekend?', undefined, { group: { ownerTurn: true, crisis: false, adult: false, note: 'A group chat.', others: ['Mira'] } } as TurnOptions));
  assert.ok(!leaks(promptOf(app)), 'group chats: no people');
  // A partner chat (another person talking to her through a bridge).
  const partner = app.store.createConversation({ title: 'Sam', channel: 'telegram', partner: 'Sam' });
  app.script.push(text('hi'));
  await drain(runTurn(app, partner.id, 'hi, do you know Jamiesonne?'));
  const pp = String(app.requests.at(-1)!.messages[0].content);
  assert.ok(!/typewriter|### People in this message/.test(pp), 'partner turns never see the owner\'s cards');
  // Plugins (shared notes).
  const notes = sharedNotesFor(app).join('\n');
  assert.ok(!leaks(notes) && /zebra/.test(notes), notes);
  // A2A outgoing: quoting a card's fact is refused.
  assert.equal(privateQuote(app, 'FYI: Alex\'s friend Jamiesonne collects vintage typewriters, apparently.'), 'a people card');
  assert.equal(privateQuote(app, 'my friend Jamiesonne collects vintage typewriters'), 'a people card');
  assert.equal(privateQuote(app, 'Can you find a good price for a used bicycle?'), undefined);
  // /v1 and MCP over HTTP with an API key.
  const auth = new OwnerAuth(dir, () => NOW);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const key = auth.createApiKey('Other app').token;
  const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };
  const rpc = async (name: string, args: Record<string, unknown>) => (await fetch(`${base}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).text();
  for (const [name, args] of [['search_memory', { query: 'Jamiesonne typewriters' }], ['search_memory', { query: 'friend' }], ['list_facts', {}], ['list_recent_conversations', {}], ['get_today', {}]] as const) {
    // (Her "nothing about “…”" line repeats the query: that's the asker's own words.)
    const out = (await rpc(name, args)).replace(/“[^”]*”/g, '');
    assert.ok(!leaks(out), `MCP ${name}: ${out.slice(0, 300)}`);
  }
  assert.match(await rpc('list_facts', {}), /zebra/);
  app.script.push(text('Sure.'));
  const v1 = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model: 'sara', messages: [{ role: 'user', content: 'Who are my friends? Anything about typewriters?' }] }) });
  assert.equal(v1.status, 200);
  assert.ok(!leaks(promptOf(app).replace(/Anything about typewriters\?/g, '')), '/v1: no people in the prompt');
  // The people routes answer an API key nothing (they are the app's, not other apps').
  assert.notEqual((await fetch(`${base}/api/people`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
  void jamie;
});

test('merge, split, forget (with and without memories: FTS and vectors really gone), Not a person, birthdays on Today once', async (t) => {
  const { app, people } = setup(t);
  const a = people.create({ name: 'Ben', relation: 'my friend', status: 'active' });
  const b = people.create({ name: 'Benny', status: 'proposed' });
  const m1 = plant(app, people, "Alex's friend Ben plays chess on Sundays.", [{ name: 'Ben' }]);
  const m2 = plant(app, people, 'Benny loves sailing.', [{ name: 'Benny' }]);
  const merged = people.merge(b.id, a.id)!;
  assert.equal(merged.id, a.id);
  assert.ok(merged.aliases.includes('Benny'));
  assert.equal(people.get(b.id)!.status, 'merged');
  assert.equal(people.facts(a.id).length, 2);
  assert.deepEqual(people.find('Benny says hi').found.map((p) => p.id), [a.id], 'the old name is an alias now');
  // Split: the sailing fact belongs to someone else.
  const sailing = people.facts(a.id).find((f) => f.memoryId === m2.id)!;
  const fresh = people.split(a.id, [sailing.id], 'Benjamin')!;
  assert.equal(people.facts(fresh.id).length, 1);
  assert.equal(people.facts(a.id).length, 1);
  // Not a person: the name stays (not proposed again), nothing else.
  const nap = people.create({ name: 'Netflix' });
  people.reject(nap.id);
  const m3 = app.memory!.add({ kind: 'fact', content: "Alex's friend Netflix?", conversationId: null, sourceMessageId: null, happenedOn: '2026-10-01', evidence: 'x' });
  assert.equal(people.linkMemory(m3, [{ name: 'Netflix', relation: 'friend' }]).personIds.length, 0);
  // Forget without memories: the card goes, the memory stays.
  people.forget(fresh.id);
  assert.equal(people.get(fresh.id), undefined);
  assert.ok(app.memory!.get(m2.id));
  // Forget with memories, through the route: the memories, their vectors and every index entry go.
  app.vectors = new MemoryVectors(app.store.db, app.memory!, () => undefined);
  app.store.db.prepare('INSERT INTO memory_vectors (memory_id, model, sig, vec) VALUES (?, ?, ?, ?)').run(m1.id, 'm', 's', new Uint8Array(8));
  const auth = new OwnerAuth(app.dataDir, () => NOW);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const tok = auth.newToken!;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const del = await api('DELETE', `/people/${a.id}`, { memories: true });
  assert.equal(del.status, 200);
  assert.ok(del.json.memories >= 1);
  assert.equal(app.memory!.get(m1.id), undefined);
  assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE memory_id = ?').get(m1.id) as { n: number }).n, 0, 'vector gone');
  const fts = (sql: string, q: string) => (app.store.db.prepare(sql).all(q) as unknown[]).length;
  assert.equal(fts('SELECT rowid FROM people_fts WHERE people_fts MATCH ?', 'Ben'), 0, 'people index');
  assert.equal(fts('SELECT rowid FROM person_facts_fts WHERE person_facts_fts MATCH ?', 'chess'), 0, 'facts index');
  assert.equal(fts('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?', 'chess'), 0, 'memories index');
  // Birthdays: a date memory linked to the card and the card's own birthday on the same day → once.
  const jamie = people.create({ name: 'Jamie', relation: 'my friend', birthday: '10-25', status: 'active' });
  const d = app.memory!.add({ kind: 'date', content: "Jamie's birthday", onDate: '10-25', conversationId: null, sourceMessageId: null, happenedOn: '2026-09-01', evidence: 'x' });
  people.linkMemory(d, [{ name: 'Jamie' }]);
  const kim = people.create({ name: 'Kim', relation: 'my neighbour', birthday: '10-23', status: 'active' });
  const today = await buildToday(app);
  const rows = today.dates.filter((x) => /Jamie|Kim/.test(x.what));
  assert.equal(rows.filter((x) => x.personId === jamie.id).length, 1, 'once');
  assert.equal(rows.find((x) => x.personId === kim.id)?.inDays, 3, "a card's own birthday joins Today");
  // The routes: list, card, accept, put, facts, backfill status, photo.
  const list = await api('GET', '/people');
  assert.equal(list.status, 200);
  assert.ok((list.json.people as { name: string }[]).some((p) => p.name === 'Jamie'));
  const card = await api('GET', `/people/${jamie.id}`);
  assert.equal(card.json.person.name, 'Jamie');
  assert.equal(card.json.facts.length, 1);
  assert.equal((await api('PUT', `/people/${jamie.id}`, { notes: 'Likes green tea', aliases: ['Jay'], birthday: '02-30' })).status, 400, 'a real birthday');
  const put = await api('PUT', `/people/${jamie.id}`, { notes: 'Likes green tea', aliases: ['Jay'], links: [{ id: kim.id, relation: "Kim's friend" }] });
  assert.equal(put.json.person.notes, 'Likes green tea');
  assert.equal(put.json.links[0].name, 'Kim');
  const fid = card.json.facts[0].id;
  const fe = await api('PUT', `/person-facts/${fid}`, { content: "Jamie's birthday party", category: 'health' });
  assert.equal(fe.json.category, 'health');
  assert.equal(app.memory!.get(d.id)!.content, "Jamie's birthday party", 'editing the fact edits the memory');
  assert.equal((await api('GET', '/people/backfill')).json.state, 'never');
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString('base64');
  assert.equal((await api('PUT', `/people/${jamie.id}/photo`, { data: png })).json.person.photo, `${jamie.id}.png`);
  assert.equal((await api('PUT', `/people/${jamie.id}/photo`, { data: 'data:image/png;base64,AAAA' })).status, 400, 'not a picture');
  const made = await api('POST', '/people', { name: 'Ola', relation: 'my aunt' });
  assert.equal(made.status, 201);
  assert.equal(made.json.person.circle, 'family');
  assert.equal((await api('GET', '/people/99999')).status, 404);
  assert.equal((await api('DELETE', `/person-facts/${fid}`)).status, 200);
});

test('tools: person_lookup and people_list run on their own, person_note asks first and links the note', async (t) => {
  const { app, people } = setup(t);
  const tools = new Map(createPeopleTools(() => app).map((x) => [x.spec.name, x]));
  assert.equal(tools.get('person_lookup')!.defaultPermission, 'auto');
  assert.equal(tools.get('people_list')!.defaultPermission, 'auto');
  assert.equal(tools.get('person_note')!.defaultPermission, 'ask');
  const ctx = { workspaceDir: app.dataDir, signal: new AbortController().signal, sandbox: app.sandbox };
  people.create({ name: 'Jamie', relation: 'my friend', status: 'active' });
  const out = await tools.get('person_note')!.run({ person: 'Jamie', fact: "Alex's friend Jamie loves pottery." }, ctx);
  assert.match(out, /Saved on Jamie \(your friend\)'s card/);
  assert.match(await tools.get('person_lookup')!.run({ name: 'Jamie' }, ctx), /loves pottery/);
  assert.match(await tools.get('people_list')!.run({ circle: 'friend' }, ctx), /Jamie \(your friend\)/);
  // In a real turn the model can look a person up (owner's own turn).
  const conv = app.store.createConversation({ title: 'Chat' });
  app.script.push([call('c1', 'person_lookup', { name: 'Jamie' })], text('She loves pottery.'));
  const evs = await drain(runTurn(app, conv.id, 'What does Jamie like?'));
  assert.ok(evs.some((e) => e.type === 'tool_result' && /pottery/.test(String((e as { output?: string }).output ?? ''))) || /pottery/.test(promptOf(app)));
});

test('the page: Memory → People with cards, search, circles, review, the card, ? tips, strings through t(), theme tokens only', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'web', 'people.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'web', 'people.css'), 'utf8');
  assert.match(html, /data-tab="people"/);
  assert.match(html, /id="ppl-list"/);
  assert.match(html, /<link rel="stylesheet" href="\/people\.css/);
  for (const tip of ['ppl-tip-circles', 'ppl-tip-private', 'ppl-tip-sensitive', 'ppl-tip-backfill']) assert.match(html, new RegExp(`id="${tip}"[^>]*data-tip=`), tip);
  assert.match(js, /import \{ proposalCard \} from '\.\/proposal-card\.js'/, 'reuses the shared proposal card');
  assert.ok(!/style=/.test(html.slice(html.indexOf('data-panel="people"'), html.indexOf('data-panel="people"') + 6000)), 'no inline style');
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'colours only through theme tokens');
  assert.match(css, /var\(--safe-b/);
  assert.match(css, /min-height: 44px/);
  assert.ok(!/\binnerHTML\b/.test(js), 'card text is set as text');
  assert.ok(!/(?:id|class)="sk-/.test(html));
  assert.match(readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8'), /sara-shell-v35/);
});
