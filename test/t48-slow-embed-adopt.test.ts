// T48: a slow embedding model is not offered. Meaning search used to adopt the best-named embedding
// model on this computer (bge-m3 first) without knowing its speed; on a server without a graphics
// card bge-m3 took 30 to 60 s a sentence and never finished its index. Now each candidate answers
// one short sentence first (after a warm-up call that loads it), and only a quick one is set.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { type EmbedTarget, embedPaced, PACE, resetEmbedPace } from '../src/embeddings.ts';
import { ADOPT_PACE, adoptMeaningSearchTimed, embedCandidates, meaningAdoptNote, meaningTooSlow } from '../src/meaning-auto.ts';
import { makeApp, tempDir } from './helpers.ts';

const HERE = { id: 'o', label: 'Ollama', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', local: true };

function setup(t: test.TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  app.settings.update({ providers: [HERE] } as never);
  const keep = { ...ADOPT_PACE };
  Object.assign(ADOPT_PACE, { limitMs: 60, warmMs: 1000 });
  t.after(() => (Object.assign(ADOPT_PACE, keep), app.store.close(), cleanup()));
  return app;
}

/** A stand-in embedding call: each model takes its own time (first call and later calls apart). */
function fakeEmbed(speeds: Record<string, { first: number; then: number }>) {
  const calls: string[] = [];
  const embed = (t: EmbedTarget, _texts: string[], signal: AbortSignal) =>
    new Promise<void>((ok, no) => {
      const n = calls.filter((m) => m === t.model).length;
      calls.push(t.model);
      const s = speeds[t.model] ?? { first: 0, then: 0 };
      const timer = setTimeout(ok, n ? s.then : s.first);
      signal.addEventListener('abort', () => (clearTimeout(timer), no(signal.reason)));
    });
  return { embed, calls };
}

test('T48 adopt: candidates best-named first, never a cloud name', () => {
  assert.deepEqual(embedCandidates(['qwen3:8b', 'nomic-embed-text:latest', 'bge-m3:latest', 'x-embed:cloud']), ['bge-m3:latest', 'nomic-embed-text:latest']);
  assert.deepEqual(embedCandidates(['llava:13b']), []);
});

test('T48 adopt: a slow bge-m3 is passed over for a quick nomic-embed-text', async (t) => {
  const app = setup(t);
  const { embed, calls } = fakeEmbed({ 'bge-m3:latest': { first: 100, then: 200 }, 'nomic-embed-text:latest': { first: 20, then: 5 } });
  const got = await adoptMeaningSearchTimed(app, () => ['qwen3:8b', 'nomic-embed-text:latest', 'bge-m3:latest'], { embed });
  assert.deepEqual(got, { providerId: 'o', model: 'nomic-embed-text:latest' });
  assert.deepEqual(app.settings.get().routes?.embeddings, { providerId: 'o', model: 'nomic-embed-text:latest' });
  assert.equal(app.settings.get().meaningAuto, 'done');
  assert.deepEqual(calls, ['bge-m3:latest', 'bge-m3:latest', 'nomic-embed-text:latest', 'nomic-embed-text:latest'], 'a warm-up call, then the timed one, each');
});

test('T48 adopt: a slow first call (loading the model) does not count; a quick second one does', async (t) => {
  const app = setup(t);
  const { embed } = fakeEmbed({ 'bge-m3:latest': { first: 200, then: 5 } });
  assert.deepEqual(await adoptMeaningSearchTimed(app, () => ['bge-m3:latest', 'nomic-embed-text:latest'], { embed }), { providerId: 'o', model: 'bge-m3:latest' });
});

test('T48 adopt: none quick enough, none set, and why is kept; not timed again until the models change or later', async (t) => {
  const app = setup(t);
  let clock = 1_000_000;
  const now = () => clock;
  const { embed, calls } = fakeEmbed({ 'bge-m3:latest': { first: 10, then: 200 }, 'nomic-embed-text:latest': { first: 10, then: 200 } });
  const models = ['bge-m3:latest', 'nomic-embed-text:latest'];
  assert.equal(await adoptMeaningSearchTimed(app, () => models, { embed, now }), undefined);
  assert.equal(app.settings.get().routes?.embeddings, undefined);
  assert.equal(app.settings.get().meaningAuto, undefined, 'still hers to set when a quicker one comes');
  assert.deepEqual(meaningAdoptNote(app)?.tooSlow, models);
  const tried = calls.length;
  assert.equal(await adoptMeaningSearchTimed(app, () => models, { embed, now }), undefined);
  assert.equal(calls.length, tried, 'not timed again right away');
  // A smaller model is pulled: timed now, and set.
  models.push('all-minilm:latest');
  assert.deepEqual(await adoptMeaningSearchTimed(app, () => models, { embed, now }), { providerId: 'o', model: 'all-minilm:latest' });
  assert.equal(meaningAdoptNote(app), undefined);
  // Later is later: a long while after, the same list is timed again.
  const other = setup(t);
  const slow = fakeEmbed({ 'bge-m3:latest': { first: 10, then: 200 } });
  await adoptMeaningSearchTimed(other, () => ['bge-m3:latest'], { embed: slow.embed, now });
  clock += ADOPT_PACE.retryMs + 1;
  const before = slow.calls.length;
  await adoptMeaningSearchTimed(other, () => ['bge-m3:latest'], { embed: slow.embed, now });
  assert.ok(slow.calls.length > before);
});

test('T48 adopt: a job set by hand is left alone (nothing timed)', async (t) => {
  const app = setup(t);
  app.settings.update({ routes: { embeddings: { providerId: 'o', model: 'nomic-embed-text' } } } as never);
  const { embed, calls } = fakeEmbed({});
  assert.equal(await adoptMeaningSearchTimed(app, () => ['bge-m3'], { embed }), undefined);
  assert.deepEqual(calls, []);
  assert.equal(app.settings.get().meaningAuto, 'done');
});

test('T48 Settings: a set model whose index rests for being too slow is said to be too slow', async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    const timer = setTimeout(() => res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })), 400);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const keep = { ...PACE };
  Object.assign(PACE, { limitMs: 100, slowMs: 50, quickMs: 20, restMs: 60_000 });
  resetEmbedPace();
  t.after(() => (Object.assign(PACE, keep), resetEmbedPace(), server.closeAllConnections(), server.close()));
  const app = setup(t);
  const port = (server.address() as AddressInfo).port;
  const slow = { id: 's', label: 'Slow', kind: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, local: true };
  app.settings.update({ providers: [HERE, slow], routes: { embeddings: { providerId: 's', model: 'bge-m3' } } } as never);
  assert.equal(meaningTooSlow(app), false, 'nothing known yet');
  await assert.rejects(embedPaced({ config: slow, model: 'bge-m3' }, ['one note']));
  assert.equal(meaningTooSlow(app), true, 'one note ran out of time: the index rests');
  // The last index error alone says so too.
  resetEmbedPace();
  assert.equal(meaningTooSlow(app), false);
  app.vectors = { lastError: 'bge-m3 is too slow on this computer for Meaning search: one note took over a minute.' } as never;
  assert.equal(meaningTooSlow(app), true);
});
