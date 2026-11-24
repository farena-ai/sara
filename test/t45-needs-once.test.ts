// T45 E5: with the model down, Today's Needs you lists it once. The reply that failed because of
// it is covered by the model's own notice; a reply that failed for another reason still has a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/chat.ts';
import { ProviderError } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { buildToday } from '../src/today.ts';
import { todayLoaders } from '../src/today-parts.ts';
import { FakeProvider, makeApp, tempDir, text } from './helpers.ts';

type Needs = { trouble: { id: string }[]; failedRuns: { id: number }[] };

function rig() {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  app.runs = new RunStore(app.store.db, () => app.now());
  const state = { fail: '' };
  const real = app.providerFactory!;
  app.providerFactory = (config) => {
    const p = real(config) as FakeProvider;
    return {
      config: p.config,
      listModels: () => p.listModels(),
      async *stream(req) {
        if (state.fail) throw new ProviderError(state.fail);
        yield* p.stream(req);
      },
    };
  };
  const needs = async () => ((await buildToday(app, { parts: ['needs'], loaders: todayLoaders({ approvals: () => [] }) })) as unknown as { needs: Needs }).needs;
  return { app, state, needs, cleanup: () => (app.store.close(), cleanup()) };
}

test('T45 needs: a model that is down is one entry, not a notice plus a failed-reply row', async () => {
  const { app, state, needs, cleanup } = rig();
  try {
    const conv = app.store.createConversation();
    state.fail = "Couldn't reach Fake at 127.0.0.1:9. Is that computer on and its model server running?";
    for await (const _ of runTurn(app, conv.id, 'hi')) void _;
    for await (const _ of runTurn(app, conv.id, 'are you there?')) void _;
    const n = await needs();
    assert.deepEqual(n.trouble.map((x) => x.id), ['model:p'], 'the model is named once');
    assert.deepEqual(n.failedRuns, [], 'the replies it failed are not listed again');
  } finally {
    cleanup();
  }
});

test('T45 needs: a reply that failed for another reason keeps its own row', async () => {
  const { app, state, needs, cleanup } = rig();
  try {
    const conv = app.store.createConversation();
    // Not a service problem: no notice for it, so the row is the only place that says it.
    state.fail = 'The answer could not be read.';
    for await (const _ of runTurn(app, conv.id, 'hi')) void _;
    let n = await needs();
    assert.deepEqual(n.trouble, []);
    assert.equal(n.failedRuns.length, 1, 'the failed reply is listed');
    // She answers again, then the model goes down: the old row stays, the new failure folds into the notice.
    state.fail = '';
    app.script.push(text('Hello!'));
    for await (const _ of runTurn(app, conv.id, 'again')) void _;
    state.fail = "Couldn't reach Fake at 127.0.0.1:9. Is that computer on and its model server running?";
    for await (const _ of runTurn(app, conv.id, 'and now?')) void _;
    n = await needs();
    assert.deepEqual(n.trouble.map((x) => x.id), ['model:p']);
    assert.equal(n.failedRuns.length, 1, 'only the earlier, unrelated failure');
  } finally {
    cleanup();
  }
});
