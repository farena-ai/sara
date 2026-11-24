// S6: what stages 1 to 5 left open. While meaning rests, the turn's other meaning searches rest
// too; bge-m3 is on the list of models to download; two more research asks, with no new false
// yes; the conversation cases of the crisis eval; the step's history as its own function.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runTurn } from '../src/chat.ts';
import { embedTarget, turnEmbedTarget } from '../src/embeddings.ts';
import { FREE_MODELS, recommendFor, validateList } from '../src/free-models.ts';
import { pickEmbedModel } from '../src/meaning-auto.ts';
import { NOT_RESEARCH, RESEARCH_ASKS } from '../src/tool-meaning.ts';
import { CRISIS_CASES } from '../scripts/eval-crisis-cases.ts';
import { CASES } from '../scripts/eval-tools-cases.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');

test('S6 rest: while meaning rests, a turn asks the embedding model for nothing', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm', local: true }], defaultProviderId: 'p', defaultModel: 'm', routes: { embeddings: { providerId: 'p', model: 'fake-embed' } }, ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T00:00:00Z' } as never);
    let resting = false;
    let related = 0;
    app.toolMeaning = { get resting() { return resting; }, pick: async () => [], research: async () => false } as never;
    app.vectors = { related: async () => (related++, []) } as never;
    assert.ok(embedTarget(app));
    assert.deepEqual(turnEmbedTarget(app), embedTarget(app));
    const conv = app.store.createConversation();
    const turn = async () => {
      app.script.push(text('ok'));
      for await (const _ of runTurn(app, conv.id, 'what was that place we talked about', undefined)) void _;
    };
    await turn();
    const before = related;
    assert.ok(before >= 1, "memory's meaning search ran");
    resting = true;
    assert.equal(turnEmbedTarget(app), undefined);
    assert.ok(embedTarget(app), 'indexing and Settings still see the model');
    await turn();
    assert.equal(related, before, 'not asked while resting');
    resting = false;
    await turn();
    assert.ok(related > before);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('S6 models: bge-m3 is on the list to download for Meaning search; the small one stays the first suggestion', () => {
  assert.deepEqual(validateList(FREE_MODELS), []);
  const bge = FREE_MODELS.models.find((m) => m.id === 'embed-bge-m3')!;
  assert.equal(bge.job, 'embeddings');
  assert.equal(bge.pull, 'bge-m3');
  assert.match(bge.why, /many languages/);
  assert.ok(readFileSync(join(ROOT, bge.quality!.file), 'utf8').length > 100, 'its result file is in the repo');
  const r = recommendFor('embeddings', { budgetGb: 8, basis: 'gpu', ramGb: 16 } as never);
  assert.equal(r.pick?.id, 'embed-nomic');
  assert.ok(r.others.some((m) => m.id === 'embed-bge-m3'));
  // Once it is there, she takes it over the small one (src/meaning-auto.ts).
  assert.equal(pickEmbedModel(['nomic-embed-text:latest', 'bge-m3:latest']), 'bge-m3:latest');
});

test('S6 research asks: two more ways of asking, and their look-alikes on the other side', () => {
  assert.ok(RESEARCH_ASKS.some((a) => /general consensus/.test(a)));
  assert.ok(RESEARCH_ASKS.some((a) => /Gather what is out there/.test(a)));
  assert.ok(NOT_RESEARCH.some((a) => /Sum up what we talked about/.test(a)), 'summing up a chat is not research');
  assert.equal(new Set([...RESEARCH_ASKS, ...NOT_RESEARCH]).size, RESEARCH_ASKS.length + NOT_RESEARCH.length, 'no line on both sides');
});

test('S6 cases: a second other-language set, and conversations in the crisis eval', () => {
  const y = CASES.filter((c) => c.id.startsWith('y-'));
  assert.equal(y.length, 20);
  for (const lang of ['es', 'fr', 'de', 'pt', 'it']) assert.equal(y.filter((c) => c.id.startsWith(`y-${lang}-`)).length, 4, lang);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  const m = CRISIS_CASES.filter((c) => c.history);
  assert.equal(m.length, 4);
  assert.deepEqual(m.map((c) => c.group).sort(), ['danger', 'hard', 'hard', 'sounds']);
  for (const c of m) assert.equal(c.history!.at(-1)!.role, 'assistant', `${c.id}: the message under test follows her last line`);
});

test('S6 turn function: the history of a step is its own function', () => {
  const src = readFileSync(join(ROOT, 'src', 'chat.ts'), 'utf8');
  // C7: it also says what it was read from (`source`), and the turn may build it again before a call.
  assert.match(src, /\nfunction stepHistory\(env: StepHistoryEnv\): ReturnType<typeof buildHistory> & \{ source: HistorySource \} \{/);
  assert.match(src, /let hist = stepHistory\(\{ app, store, conv, opts, userMsg, stepBudget, canSee: sees\(provider, model\), s, refsText, activeFold, clock: turnClock \}\);/);
  const inner = src.slice(src.indexOf('async function* runTurnInner('), src.indexOf('\nfunction stepHistory('));
  assert.ok(!/const hist = opts\.clientHistory/.test(inner), 'and no longer written out inside the turn');
});
