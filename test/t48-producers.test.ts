// C7: things made from the conversation during or after a turn (a title, a fold, a summary, a skill
// draft, a second opinion, a side answer, the claim check) respect a delete, an edit or a forget
// made while their model call was running: what was made from the old text is not written.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerAside } from '../src/btw.ts';
import { runTurn, type ChatEvent, type TurnHooks } from '../src/chat.ts';
import { compactNow, currentFold } from '../src/compact.ts';
import { forgetMemory, summarizeConversation } from '../src/memory-worker.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { askSecondOpinion } from '../src/second-opinion.ts';
import { SkillLearner } from '../src/skill-learning.ts';
import { retitle } from '../src/titles.ts';
import type { Tool } from '../src/tools/types.ts';
import { UsageStore } from '../src/usage.ts';
import { FakeProvider, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-20T15:00:00Z');
const LOCAL: ProviderConfig = { id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'local-m' };
const LOCAL2: ProviderConfig = { id: 'l2', label: 'Local two', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11435/v1', local: true, defaultModel: 'other-m' };

function setup(t: { after: (fn: () => void) => void }): TestApp {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.settings.update({ providers: [LOCAL, LOCAL2], defaultProviderId: 'l', defaultModel: 'local-m', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: NOW.toISOString(), chats: { continuity: { enabled: false } } } as never);
  app.usage = new UsageStore(app.store.db);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}

/** The next model call runs `during` first (the owner acts while the model is thinking). */
function whileThinking(app: TestApp, during: () => void): void {
  let done = false;
  app.providerFactory = (config) => {
    const inner = new FakeProvider(config, app.script, app.requests);
    return Object.assign(Object.create(inner) as Provider, {
      config,
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        if (!done) {
          done = true;
          during();
        }
        yield* inner.stream(req);
      },
    });
  };
}

function chatAbout(app: TestApp) {
  const conv = app.store.createConversation();
  const said = app.store.addMessage(conv.id, 'user', 'My locker code is 4417 and I train on Tuesdays.');
  app.store.addMessage(conv.id, 'assistant', 'Tuesdays it is.');
  app.store.addMessage(conv.id, 'user', 'I also want a new training plan for the gym.');
  const reply = app.store.addMessage(conv.id, 'assistant', 'Let us build one around your Tuesdays.', { model: 'local-m', provider: 'Local' });
  return { conv: app.store.getConversation(conv.id)!, said, reply };
}

const hide = (app: TestApp, id: number) => app.store.updateMessageMeta(id, { forgotten: true });

test('C7 titles: forgotten lines are not sent; a forget during the call drops the title', async (t) => {
  const app = setup(t);
  const { conv, said } = chatAbout(app);
  hide(app, said.id);
  app.script.push(text('Gym training plan'));
  const r = await retitle(app, conv.id, { now: true });
  assert.equal(r.changed, true);
  assert.doesNotMatch(JSON.stringify(app.requests.at(-1)!.messages), /4417/);
  const other = chatAbout(app);
  whileThinking(app, () => hide(app, other.said.id));
  app.script.push(text('Locker 4417 Tuesdays'));
  const r2 = await retitle(app, other.conv.id, { now: true });
  assert.equal(r2.changed, false);
  assert.equal(r2.skipped, 'changed');
  assert.doesNotMatch(app.store.getConversation(other.conv.id)!.title, /4417/);
});

test('C7 summaries: an edit during the call is caught like a delete or a forget', async (t) => {
  const app = setup(t);
  const { conv, said } = chatAbout(app);
  whileThinking(app, () => app.store.updateMessageContent(said.id, 'I train on Tuesdays.'));
  app.script.push(text(JSON.stringify({ summary: 'Alex has locker 4417.', facts: [{ fact: "Alex's locker code is 4417.", message_id: said.id, quote: 'locker code is 4417' }] })));
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.match(r.error ?? '', /changed while it was being summarized/);
  assert.equal(app.memory!.list().length, 0);
});

test('C7 folds: a forget during the summary call writes no fold', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  const first = app.store.addMessage(conv.id, 'user', 'My locker code is 4417.');
  for (let i = 0; i < 14; i++) {
    app.store.addMessage(conv.id, 'user', `Question ${i}: ${'tell me more about the parser '.repeat(4)}`);
    app.store.addMessage(conv.id, 'assistant', `Answer ${i}: ${'the parser reads tokens one by one. '.repeat(4)}`);
  }
  whileThinking(app, () => hide(app, first.id));
  app.script.push(text('FOLDSUMMARY: locker code 4417.'));
  const r = await compactNow(app, conv, {});
  assert.deepEqual(r, { skipped: 'busy', reason: 'changed' });
  assert.equal(currentFold(app, conv.id), undefined);
  // Asked again, it is made from what is there now.
  app.providerFactory = (config) => new FakeProvider(config, app.script, app.requests);
  app.script.push(text('FOLDSUMMARY: questions about the parser.'));
  const again = await compactNow(app, conv, {});
  assert.ok('fold' in again);
  assert.doesNotMatch(JSON.stringify(app.requests.at(-1)!.messages), /4417/);
});

test('C7 skill drafts: a forgotten ask leaves the examples; one forgotten during the call drops the model draft', async (t) => {
  const app = setup(t);
  const learner = new SkillLearner(app);
  const ex = (convId: string, messageId: number, day: string) => ({ conversationId: convId, messageId, runId: null, day, at: `${day}T12:00:00Z` });
  const conv = app.store.createConversation();
  const asks = ['please put the weekly sales numbers into the sheet', 'put the weekly sales numbers into the sheet again', 'please put this week of sales numbers, locker 4417, into the sheet'].map((a) => app.store.addMessage(conv.id, 'user', a));
  const c = learner.store.insert({ kind: 'ask', signature: 'ask:writing:x', topic: 'writing', examples: asks.map((m, i) => ex(conv.id, m.id, `2026-11-1${i + 5}`)), days: 3, at: NOW.toISOString() });
  whileThinking(app, () => hide(app, asks[2]!.id));
  app.script.push(text(JSON.stringify({ name: 'weekly-sales-sheet', description: 'Puts the weekly sales numbers into the sheet with locker 4417. Use when asked.', body: '# Weekly sales\n\n## Steps\n\n1. Use locker 4417.\n' })));
  const draft = await learner.draft(c.id);
  assert.equal(draft?.by, 'plain');
  assert.doesNotMatch(JSON.stringify(draft), /4417/);
  assert.match(JSON.stringify(app.requests.at(-1)!.messages), /4417/, 'the model saw it before the forget');
  assert.equal(learner.material(learner.store.candidate(c.id)!).asks.length, 2);
});

test('C7 second opinions: forgotten lines are not sent; a forget during the calls stores nothing', async (t) => {
  const app = setup(t);
  const { conv, said, reply } = chatAbout(app);
  hide(app, said.id);
  app.script.push(text('Plan A.'), text('Plan B.'));
  await askSecondOpinion(app, conv, reply);
  for (const r of app.requests) assert.doesNotMatch(JSON.stringify(r.messages), /4417/);
  const other = chatAbout(app);
  whileThinking(app, () => hide(app, other.said.id));
  app.script.push(text('Plan A.'), text('Plan B.'));
  await assert.rejects(askSecondOpinion(app, other.conv, other.reply), /The chat changed while the other models were answering/);
  assert.equal(app.store.messageById(other.reply.id)!.meta?.secondOpinion, undefined);
});

test('C7 side questions: forgotten lines are not sent', async (t) => {
  const app = setup(t);
  const { conv, said } = chatAbout(app);
  hide(app, said.id);
  app.script.push(text('On Tuesdays.'));
  const r = await answerAside(app, conv, 'when do I train?');
  assert.equal(r.ok, true);
  assert.doesNotMatch(JSON.stringify(app.requests.at(-1)!.messages), /4417/);
});

test('C7 claim check: an earlier tool result forgotten mid-turn no longer backs her "I wrote it"', async (t) => {
  const app = setup(t);
  const write: Tool = { spec: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'write', async run() { return 'Wrote src/parser.ts'; } };
  app.tools.add(write);
  const run = async (forget: boolean) => {
    const conv = app.store.createConversation();
    app.store.addMessage(conv.id, 'user', 'write the parser to src/parser.ts');
    app.store.addMessage(conv.id, 'assistant', '', { toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'src/parser.ts' } }] });
    const tool = app.store.addMessage(conv.id, 'tool', 'Wrote src/parser.ts', { toolCallId: 'w1', name: 'write_file', args: { path: 'src/parser.ts' }, status: 'ok' });
    app.store.addMessage(conv.id, 'assistant', 'Done.');
    const hooks: TurnHooks = { beforeModelCall: (c) => void (forget && c.step === 0 && hide(app, tool.id)) };
    app.script.push(text('I wrote src/parser.ts.'), text('Sorry, I cannot see that I wrote it.'));
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(app, conv.id, 'did you save my plan?', undefined, { hooks })) evs.push(ev);
    app.script.length = 0;
    return evs.some((e) => e.type === 'claim_check');
  };
  assert.equal(await run(false), false, 'the earlier result backs the claim');
  assert.equal(await run(true), true, 'forgotten during the turn, it no longer does');
});
