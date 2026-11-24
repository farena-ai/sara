// T46: memory notes when the background model gives nothing usable. On the owner's server one
// conversation failed every hour ("Model did not return valid JSON: " and nothing after it): the
// background model answered with nothing, and no other model was ever asked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeConversation, summaryModels } from '../src/memory-worker.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const NOW = new Date('2026-11-24T15:00:00Z');

function setup(t: { after: (fn: () => void) => void }, adult: boolean) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'talk',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    routes: { background: { providerId: 'p', model: 'bg' }, adult: { providerId: 'p', model: 'grown' } },
    ...(adult ? { adultMode: { on: true, confirmedAt: NOW.toISOString(), confirmedFrom: 'test' } } : {}),
  } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation({ title: 'Evening' });
  const first = app.store.addMessage(conv.id, 'user', 'I moved to Lisbon in March and I love the trams here.');
  app.store.addMessage(conv.id, 'assistant', 'Lisbon suits you.');
  const good = text(JSON.stringify({ summary: 'Alex talked about living in Lisbon.', facts: [{ fact: 'Alex moved to Lisbon in March.', message_id: first.id, quote: 'I moved to Lisbon in March' }] }));
  return { app, conv, good };
}

test('T46 memory: the background model answers with nothing twice: the next model writes the notes', async (t) => {
  const { app, conv, good } = setup(t, true);
  const models = summaryModels(app, app.store.getConversation(conv.id)!).map((c) => c.model);
  assert.equal(models[0], 'bg');
  assert.ok(models.includes('grown'), `with adult mode on, the model her adult replies use is next: ${models.join(', ')}`);
  app.script.push(text(''), text(''), good);
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.equal(r.error, undefined);
  assert.equal(r.factIds.length, 1, 'the fact is kept');
  assert.deepEqual(app.requests.map((q) => q.model), ['bg', 'bg', models[1]], 'two tries for the first, then the next');
  assert.equal(app.memory!.state(conv.id).lastError, null);
});

test('T46 memory: without adult mode only the background chain is asked; a failure is still a failure', async (t) => {
  const { app, conv } = setup(t, false);
  const models = summaryModels(app, app.store.getConversation(conv.id)!).map((c) => c.model);
  assert.ok(!models.includes('grown'));
  for (let i = 0; i < models.length * 2; i++) app.script.push(text(''));
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.match(String(r.error), /did not return valid JSON/);
  assert.equal(app.requests.length, models.length * 2);
});

test('T46 memory: a first model that works is the only one asked', async (t) => {
  const { app, conv, good } = setup(t, true);
  app.script.push(good);
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.equal(r.factIds.length, 1);
  assert.deepEqual(app.requests.map((q) => q.model), ['bg']);
});

test('T47 memory: a conversation with a model of its own still has other models to ask', async (t) => {
  const { app, conv, good } = setup(t, true);
  app.store.updateConversation(conv.id, { providerId: 'p', model: 'pinned' });
  const models = summaryModels(app, app.store.getConversation(conv.id)!).map((c) => c.model);
  assert.deepEqual(models.slice(0, 3), ['pinned', 'bg', 'grown'], 'its own model first, then the jobs\' models');
  app.script.push(text(''), text(''), text(''), text(''), good);
  const r = await summarizeConversation(app, app.memory!, conv.id);
  assert.equal(r.factIds.length, 1);
  assert.deepEqual(app.requests.map((q) => q.model), ['pinned', 'pinned', 'bg', 'bg', 'grown']);
});
