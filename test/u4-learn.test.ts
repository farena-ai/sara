// U4.23 (docs/LEARNING.md "Learning coach"): study sets from a Library document, a chapter or pasted
// text: flashcards (front/back, cloze), quizzes (multiple choice shown as S10 choice cards, short
// answers graded against a rubric with kind feedback) and a summary sheet; SM-2 spaced repetition with
// a daily "cards due" Today tile and reminder; progress per set; kid mode (age-appropriate wording,
// hints before answers, never the answers to their homework, a parent view); CSV / Anki TSV export
// and import; a generation cost cap (one model call per set, capped text and cards). Fake clock and
// scripted model; no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { FamilyStore } from '../src/family.ts';
import { familyOf } from '../src/lean.ts';
import { LibraryStore } from '../src/library/store.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { STUDY, Study, fromAnki, fromCsv, localCards, sm2, toAnki, toCsv, type StudyOptions } from '../src/study.ts';
import { createStudyTools, takeQuizChoice } from '../src/tools/study.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const TEXT = `Photosynthesis is the process plants use to turn light into chemical energy. It happens in the chloroplasts of leaf cells.

Chlorophyll is the green pigment that absorbs light. Plants take in carbon dioxide through small pores called stomata.

The process releases oxygen as a by-product. In 1779 Jan Ingenhousz showed that light is needed for plants to make oxygen.`;

const MODEL_JSON = JSON.stringify({
  title: 'Photosynthesis',
  summary: ['Plants turn light into chemical energy.', 'It happens in chloroplasts.', 'Oxygen is released.'],
  cards: [
    { type: 'basic', front: 'What is photosynthesis?', back: 'Turning light into chemical energy', hint: 'Think about light and food.' },
    { type: 'cloze', text: '{{c1::Chlorophyll}} is the green pigment that absorbs light.', hint: 'It starts with C.' },
    { type: 'choice', front: 'Where does photosynthesis happen?', choices: ['Chloroplasts', 'Mitochondria', 'Roots', 'Nucleus'], answer: 'Chloroplasts', hint: 'A green part of the cell.' },
    { type: 'short', front: 'Why do plants need stomata?', back: 'To take in carbon dioxide', rubric: 'Mentions taking in carbon dioxide (CO2) through pores.', hint: 'What gas goes in?' },
  ],
});

function rig(t: TestContext, o: { now?: string; model?: (system: string, user: string) => string; child?: '6-9' | '10-12' | '13-17'; quiet?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(o.now ?? '2026-11-18T15:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  if (o.child) (app as { member?: unknown }).member = { child: () => ({ band: o.child, name: 'Kim' }) };
  const calls: { system: string; user: string }[] = [];
  const pushed: { title: string; body: string }[] = [];
  const opts: StudyOptions = {
    model: async (system, user) => {
      calls.push({ system, user });
      return o.model ? o.model(system, user) : MODEL_JSON;
    },
    notify: async (title, body) => void pushed.push({ title, body }),
    quiet: () => o.quiet ?? false,
  };
  const study = new Study(app, app.store.db, opts);
  app.study = study;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const at = (iso: string) => (clock.now = new Date(iso));
  return { app, clock, study, calls, pushed, at, dir };
}

test('U4.23 sm2: Again resets, Good grows the interval 1 → 6 → ×ease, ease never below 1.3', () => {
  let s = { ease: 2.5, interval: 0, reps: 0, lapses: 0 };
  s = sm2(s, 4);
  assert.deepEqual([s.interval, s.reps], [1, 1]);
  s = sm2(s, 4);
  assert.deepEqual([s.interval, s.reps], [6, 2]);
  s = sm2(s, 4);
  assert.equal(s.interval, 15);
  s = sm2(s, 1);
  assert.deepEqual([s.interval, s.reps, s.lapses], [1, 0, 1]);
  for (let i = 0; i < 20; i++) s = sm2(s, 1);
  assert.equal(s.ease, 1.3);
  assert.ok(sm2({ ease: 2.5, interval: 6, reps: 2, lapses: 0 }, 5).ease > 2.5, 'Easy raises the ease');
});

test('U4.23 make from pasted text: one model call, four card kinds + a summary sheet, all due today', async (t) => {
  const r = rig(t);
  const set = await r.study.make({ text: TEXT });
  assert.equal(r.calls.length, 1, 'the generation cost cap: one model call per set');
  assert.equal(set.title, 'Photosynthesis');
  assert.deepEqual(set.summary.length, 3);
  const cards = r.study.cards(set.id);
  assert.deepEqual(cards.map((c) => c.kind), ['basic', 'cloze', 'choice', 'short']);
  const cloze = cards[1];
  assert.equal(cloze.front, '[…] is the green pigment that absorbs light.');
  assert.equal(cloze.back, 'Chlorophyll');
  assert.deepEqual(cards[2].choices, ['Chloroplasts', 'Mitochondria', 'Roots', 'Nucleus']);
  assert.equal(r.study.dueCount(), 4);
  const p = r.study.progress(set.id);
  assert.deepEqual([p.cards, p.due, p.learned], [4, 4, 0]);
});

test('U4.23 cost cap: the text sent is capped and cards beyond the per-set cap are dropped', async (t) => {
  const many = { title: 'Big', summary: ['x'], cards: Array.from({ length: 80 }, (_, i) => ({ type: 'basic', front: `Q${i}`, back: `A${i}` })) };
  const r = rig(t, { model: () => JSON.stringify(many) });
  r.study.setPrefs({ maxCards: 10 });
  const set = await r.study.make({ text: 'word '.repeat(40_000) });
  assert.ok(r.calls[0].user.length <= STUDY.maxChars + 200, 'the text is capped');
  assert.equal(r.study.cards(set.id).length, 10);
});

test('U4.23 works with small local models: bad JSON falls back to local cloze cards and a summary', async (t) => {
  const r = rig(t, { model: () => 'Sure! Here are some cards: photosynthesis is cool.' });
  const set = await r.study.make({ text: TEXT, title: 'Plants' });
  const cards = r.study.cards(set.id);
  assert.ok(cards.length >= 3, `local cards: ${cards.length}`);
  assert.ok(cards.every((c) => c.kind === 'cloze' || c.kind === 'choice'));
  assert.ok(set.summary.length >= 2);
  assert.equal(set.made, 'local');
  // Also without any model at all.
  const local = localCards(TEXT, 10);
  assert.ok(local.cards.some((c) => c.kind === 'cloze' && c.front.includes('[…]')));
});

test('U4.23 from a Library chapter: the section pages are read, the set links back to the document', async (t) => {
  const r = rig(t);
  const lib = new LibraryStore(r.app.store.db, r.dir, () => r.clock.now);
  r.app.library = lib;
  const doc = lib.add({ name: 'biology.txt', bytes: Buffer.from(TEXT), keep: true });
  lib.setRead(doc.id, { title: 'Biology', kind: 'text', parts: [{ where: 'page 1', heading: 'Plants', text: TEXT }, { where: 'page 2', heading: 'Animals', text: 'Animals breathe oxygen.' }], warnings: [] });
  const secs = lib.setSections(doc.id, [{ level: 1, title: 'Plants', page: 1, pageEnd: 1, source: 'heading' }, { level: 1, title: 'Animals', page: 2, pageEnd: 2, source: 'heading' }]);
  const set = await r.study.make({ docId: doc.id, section: secs[0].id });
  assert.match(r.calls[0].user, /chloroplasts/);
  assert.doesNotMatch(r.calls[0].user, /Animals breathe/);
  assert.equal(set.source.docId, doc.id);
  assert.equal(set.source.label, 'Biology · Plants');
  await assert.rejects(r.study.make({ docId: 999 }), /not found/i);
});

test('U4.23 review: grades move the due date, progress counts learned cards, the Today tile counts due cards', async (t) => {
  const r = rig(t);
  const set = await r.study.make({ text: TEXT });
  const [a, b] = r.study.cards(set.id);
  r.study.review(a.id, 4);
  r.study.review(b.id, 1);
  assert.equal(r.study.card(a.id)!.due, '2026-11-19');
  assert.equal(r.study.card(b.id)!.due, '2026-11-18', 'Again: still due today');
  assert.equal(r.study.dueCount(), 3);
  const tile = r.study.todayTile()!;
  assert.equal(tile.due, 3);
  assert.equal(tile.sets[0].title, 'Photosynthesis');
  r.at('2026-11-19T15:00:00Z');
  assert.equal(r.study.dueCount(), 4);
  const p = r.study.progress(set.id);
  assert.equal(p.reviewedToday, 0);
  assert.equal(p.streak, 1, 'studied yesterday');
  assert.throws(() => r.study.review(a.id, 9), /grade/i);
});

test('U4.23 quiz: multiple choice answers grade themselves; short answers use the rubric with kind feedback', async (t) => {
  let grade = '{"score": 2, "feedback": "Yes! Plants take in carbon dioxide through their stomata."}';
  const r = rig(t, { model: (sys) => (/grade a learner/i.test(sys) ? grade : MODEL_JSON) });
  const set = await r.study.make({ text: TEXT });
  const cards = r.study.cards(set.id);
  const mc = cards.find((c) => c.kind === 'choice')!;
  const short = cards.find((c) => c.kind === 'short')!;
  const right = await r.study.answer(mc.id, 'chloroplasts');
  assert.equal(right.correct, true);
  const wrong = await r.study.answer(mc.id, 'Roots');
  assert.equal(wrong.correct, false);
  assert.match(wrong.feedback, /Chloroplasts/);
  const ok = await r.study.answer(short.id, 'They let carbon dioxide in');
  assert.equal(ok.score, 2);
  assert.match(ok.feedback, /carbon dioxide/);
  assert.match(r.calls.at(-1)!.system, /Mentions taking in carbon dioxide/);
  // A model that says nothing useful: the local grader still answers kindly.
  grade = 'hmm';
  const local = await r.study.answer(short.id, 'no idea');
  assert.equal(local.score, 0);
  assert.ok(local.feedback.length > 10);
});

test('U4.23 kid mode: age wording and hints in the prompt, hints before answers, never homework answers', async (t) => {
  const r = rig(t, { child: '6-9' });
  await r.study.make({ text: TEXT });
  assert.match(r.calls[0].system, /6-9/);
  assert.match(r.calls[0].system, /hint/i);
  // A worksheet: questions only; the cards coach and never carry the answers.
  const sheet = 'Homework worksheet\n1. What is 7 x 8?\n2. Name the capital of France?\n3. What gas do plants release?';
  const r2 = rig(t, { child: '10-12', model: () => JSON.stringify({ title: 'Worksheet', summary: ['56'], cards: [{ type: 'basic', front: 'What is 7 x 8?', back: '56', hint: 'Count by 8s.' }] }) });
  const set = await r2.study.make({ text: sheet });
  assert.equal(set.coach, true);
  assert.match(r2.calls[0].system, /never (give|write) the answers/i);
  const card = r2.study.cards(set.id)[0];
  assert.notEqual(card.back, '56', 'the answer is never stored on a homework card');
  assert.deepEqual(set.summary, [], 'no summary sheet of their homework');
  // Hints before answers on the quiz: the first reveal is the hint.
  const kidSet = (await r.study.list())[0];
  const first = r.study.cards(kidSet.id)[0];
  const shown = r.study.reveal(first.id, 0);
  assert.equal(shown.step, 'hint');
  assert.equal(shown.text, 'Think about light and food.');
  assert.equal(r.study.reveal(first.id, 1).step, 'answer');
});

test('U4.23 parent view: a kid’s study progress reaches the family store (titles and counts, never answers)', async (t) => {
  const r = rig(t, { child: '10-12' });
  const fam = new FamilyStore(join(r.dir, 'shared', 'family.db'), () => r.clock.now);
  t.after(() => fam.db.close());
  (r.app as { family?: unknown }).family = { store: fam, person: 'm1', people: () => [], tz: () => 'America/Chicago', notifyParents: () => undefined };
  const set = await r.study.make({ text: TEXT });
  const [c] = r.study.cards(set.id);
  r.study.review(c.id, 4);
  const rows = fam.study('owner', 'm1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Photosynthesis');
  assert.deepEqual([rows[0].cards, rows[0].reviewedToday], [4, 1]);
  assert.ok(!JSON.stringify(rows).includes('chemical energy'), 'never card text');
  assert.throws(() => fam.study('m1', 'm1'), /parent/i);
});

test('U4.23 export and import: CSV and Anki-compatible TSV round trip (cloze kept as {{c1::…}})', async (t) => {
  const r = rig(t);
  const set = await r.study.make({ text: TEXT });
  const cards = r.study.cards(set.id);
  const tsv = toAnki(cards);
  assert.match(tsv, /^#separator:tab/m);
  assert.match(tsv, /\{\{c1::Chlorophyll\}\} is the green pigment/);
  const csv = toCsv(cards);
  assert.match(csv.split('\n')[0], /^front,back,kind,hint/);
  assert.equal(fromCsv(csv).length, 4);
  assert.equal(fromAnki(tsv).length, 4);
  const imported = r.study.importCards('Imported', fromAnki(tsv));
  assert.equal(r.study.cards(imported.id).length, 4);
  assert.equal(r.study.cards(imported.id)[1].kind, 'cloze');
  assert.equal(fromCsv('front,back\n"A, with comma","B ""quoted"""\n')[0].back, 'B "quoted"');
});

test('U4.23 reminder: once a day at the chosen time when cards are due; never pushed in private local mode', async (t) => {
  const r = rig(t, { now: '2026-11-18T13:00:00Z' }); // 7:00 in Chicago
  await r.study.make({ text: TEXT });
  r.study.setPrefs({ remind: true, remindAt: '08:00' });
  assert.equal(r.study.due(r.clock.now), 0, 'not yet 8:00');
  r.at('2026-11-18T14:05:00Z');
  assert.equal(r.study.due(r.clock.now), 1);
  assert.equal(r.pushed.length, 1);
  assert.match(r.pushed[0].body, /4 cards/);
  assert.equal(r.study.due(r.clock.now), 0, 'once a day');
  r.at('2026-11-19T14:05:00Z');
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  r.study.due(r.clock.now);
  assert.equal(r.pushed.length, 1, 'no push in private local mode');
  r.study.setPrefs({ remind: false });
  r.at('2026-11-20T14:05:00Z');
  assert.equal(r.study.due(r.clock.now), 0);
});

test('U4.23 tools: study_quiz asks through an S10 choice card, study_answer grades, study_make makes a set', async (t) => {
  const r = rig(t);
  const tools = createStudyTools(() => r.app);
  const by = (n: string) => tools.find((x) => x.spec.name === n)!;
  const ctx = { signal: new AbortController().signal, conversationId: 'c1' } as never;
  const made = await by('study_make').run({ text: TEXT }, ctx);
  assert.match(String(made), /Photosynthesis/);
  const set = r.study.list()[0];
  const mcId = r.study.cards(set.id).find((c) => c.kind === 'choice')!.id;
  // Bring the choice card first: mark the two earlier cards studied.
  for (const c of r.study.cards(set.id).slice(0, 2)) r.study.review(c.id, 4);
  const args: Record<string, unknown> = { set: set.id };
  const out = String(await by('study_quiz').run(args, ctx));
  assert.match(out, new RegExp(`card ${mcId}`));
  const choice = takeQuizChoice(args)!;
  assert.equal(choice.question, 'Where does photosynthesis happen?');
  assert.equal(choice.options.length, 4);
  assert.equal(takeQuizChoice(args), undefined, 'taken once');
  const graded = String(await by('study_answer').run({ card: mcId, answer: 'Chloroplasts' }, ctx));
  assert.match(graded, /right/i);
  assert.equal(familyOf(by('study_quiz')).id, 'study', 'lean family');
});

test('U4.23 wiring: kid tools, lean words, Today tile, settings section, i18n, household isolation', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  assert.match(read('src/family.ts'), /'study_quiz'/);
  assert.match(read('src/main.ts'), /new Study\(/);
  assert.match(read('src/chat.ts'), /takeQuizChoice/);
  assert.match(read('src/today-layout.ts'), /td-study/);
  assert.match(read('web/today.js'), /td-study/);
  assert.match(read('web/index.html'), /id="lib-study-open"/);
  assert.match(read('web/index.html'), /id="sy-remind"/);
  assert.match(read('src/household.ts'), /'study'/);
  const tips = JSON.parse(read('web/tips.json'));
  for (const id of ['sy-remind', 'sy-remind-at', 'sy-new', 'sy-max']) assert.ok(tips[id] ?? tips.tips?.[id], `tip for ${id}`);
});
