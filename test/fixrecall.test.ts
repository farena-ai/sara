// Fix: her memory picks and auto-loaded skills matched on common words. Owner evidence
// ('Packing for Lisbon trip', 2026-11-19): memoryPicks chosen on "need", "get", "second" at
// sure: medium, and a World of Warcraft learned-topic skill loaded into a follow-up turn because
// "updated" ~ "talent updates" (plus "said", "two", "see" in its word search).
// Common words (six languages) never count as match words; a word-only memory match needs a
// distinctive word; a learned topic needs a real topic word in the question.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { COMMON_WORDS, distinctWords, isCommonWord, isGenericWord } from '../src/common-words.ts';
import { topicFits } from '../src/learn.ts';
import { MemoryStore, ftsQuery } from '../src/memory.ts';
import { queryWords, rankMemories } from '../src/memory-rank.ts';
import { SkillStore } from '../src/skill-store.ts';
import { Store } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const OWNER_FOLLOW_UP = "You said \"I went and read two proper guides and the checklist is updated with them.\", but I don't see that it happened. Please really do it now, or tell me why you can't.";
const WOW_SUBJECT = 'What are the specific class changes, talent updates and abilities in the next World of Warcraft patch';

test('fixrecall: common words in all six languages are never match words', () => {
  for (const w of ['need', 'get', 'second', 'see', 'said', 'two', 'went', 'really', 'dont', 'cant']) assert.ok(isCommonWord(w), w);
  for (const w of ['necesito', 'segundo', 'besoin', 'deuxième', 'brauche', 'zweite', 'preciso', 'bisogno', 'secondo', 'visto']) assert.ok(isCommonWord(w), w);
  for (const w of ['passport', 'lisbon', 'checklist', 'packing', 'warcraft', 'talent', 'biscuit', 'pasaporte', 'reisepass']) assert.ok(!isCommonWord(w), w);
  assert.ok(COMMON_WORDS.size > 600, 'one shared list (titles + memory + common verbs)');
  assert.deepEqual(queryWords('get a second opinion on the checklist'), ['opinion', 'checklist']);
  assert.deepEqual(queryWords('I need a packing checklist for Lisbon'), ['packing', 'checklist', 'lisbon']);
  assert.deepEqual(queryWords('Necesito ver la lista del segundo viaje'), ['lista', 'viaje']);
  assert.equal(ftsQuery('did you see what I said? need to get two'), null);
  // Still what it was for the old cases.
  assert.equal(ftsQuery('What is my dog called?'), '"dog" OR "called"');
});

test('fixrecall: "I need a packing checklist for Lisbon" picks no memory only because it says "need"', (t) => {
  const { dir, cleanup } = tempDir();
  const st = new Store(join(dir, 'sara.db'));
  t.after(() => {
    st.close();
    cleanup();
  });
  const mem = new MemoryStore(st.db);
  const add = (content: string) => mem.add({ kind: 'fact', content, conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  add('Alex said he needs to get the second car key cut.');
  add('Alex will need two weeks off in December.');
  add('Alex keeps his passport in the blue folder in the desk.');
  add('Alex and Sara planned a trip to Lisbon in spring.');
  const ctx = { conversationId: 'c-now', oldestHistoryId: 0, standing: false } as const;
  const picks = rankMemories(mem, { ...ctx, query: 'I need a packing checklist for Lisbon' });
  assert.deepEqual(picks.map((p) => p.memory.content), ['Alex and Sara planned a trip to Lisbon in spring.']);
  assert.deepEqual(picks[0].words, ['lisbon']);
  assert.equal(rankMemories(mem, { ...ctx, query: 'get a second opinion, I need to see it' }).length, 0, 'common words alone find nothing');
  // The good match still works.
  const pass = rankMemories(mem, { ...ctx, query: 'what did I say about my passport' });
  assert.equal(pass[0]?.memory.content, 'Alex keeps his passport in the blue folder in the desk.');
  assert.deepEqual(pass[0].words, ['passport']);
  assert.equal(pass[0].confidence, 'medium');
});

test('fixrecall: a word-only memory match on generic words only is a weak one (sure: low)', (t) => {
  const { dir, cleanup } = tempDir();
  const st = new Store(join(dir, 'sara.db'));
  t.after(() => {
    st.close();
    cleanup();
  });
  const mem = new MemoryStore(st.db);
  mem.add({ kind: 'fact', content: 'The router firmware was updated in October.', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  const [p] = rankMemories(mem, { query: 'the checklist is updated now', conversationId: 'c', oldestHistoryId: 0, standing: false });
  assert.ok(p, 'still listed');
  assert.equal(p.confidence, 'low');
  assert.ok(p.score < 0.5, `score ${p.score}`);
  assert.ok(isGenericWord('updated') && isGenericWord('changes') && !isGenericWord('router'));
  // A distinctive word with it: a real match again.
  const [q] = rankMemories(mem, { query: 'was the router updated?', conversationId: 'c', oldestHistoryId: 0, standing: false });
  assert.equal(q.confidence, 'medium');
  assert.ok(q.score >= 0.55, `score ${q.score}`);
});

test('fixrecall: a learned topic needs a real topic word; the WoW topic skips the owner follow-up', () => {
  assert.equal(topicFits(WOW_SUBJECT, null, OWNER_FOLLOW_UP), false);
  assert.equal(topicFits(WOW_SUBJECT, null, 'Get a second opinion on the checklist'), false);
  assert.equal(topicFits(WOW_SUBJECT, null, 'my yoga class changes next week'), false, 'generic words alone are not the topic');
  assert.equal(topicFits(WOW_SUBJECT, null, 'What talent changes came for warriors in World of Warcraft?'), true);
  assert.equal(topicFits(WOW_SUBJECT, null, 'any news on the warcraft patch?'), true);
  assert.equal(topicFits('heat pumps', null, 'Do heat pumps still work when it is really cold?'), true);
  assert.equal(topicFits('the Artemis program', null, 'Tell me about Artemis'), true);
  assert.equal(topicFits('Comet', 'http://comet.example/', 'how often does comet retry jobs?'), true);
  // A strong meaning match lets one generic topic word through.
  assert.equal(topicFits(WOW_SUBJECT, null, 'what were the talent updates', 0.4), true);
  assert.equal(topicFits(WOW_SUBJECT, null, 'what were the updates', 0.7), true);
  assert.equal(topicFits(WOW_SUBJECT, null, 'what were the updates', 0.3), false);
  assert.deepEqual([...distinctWords('Was ist mit dem Reisepass?').keys()], ['reise']);
});

test('fixrecall: her skill word search ignores common words (the follow-up finds no skill)', (t) => {
  const { dir, cleanup } = tempDir();
  const st = new Store(join(dir, 'sara.db'));
  const skills = new SkillStore(st.db, { companionDir: join(dir, 'skills'), now: () => new Date('2026-11-19T12:00:00Z') });
  t.after(() => {
    st.close();
    cleanup();
  });
  skills.save('companion', { name: 'topic-what-are-the-specific-class-changes-talent-updates-and-abi', description: `What she learned about: ${WOW_SUBJECT}.`, body: 'Two guides said the talent trees were updated. You can see the new abilities in the patch notes; players said they need time.' }, { create: true, source: 'learned' });
  assert.deepEqual(skills.searchWords(OWNER_FOLLOW_UP.replace(/checklist|proper|guides|updated|happened/g, '')).map((x) => x.view.name), []);
  assert.deepEqual(skills.searchWords('World of Warcraft talent trees').map((x) => x.view.name), ['topic-what-are-the-specific-class-changes-talent-updates-and-abi']);
});
