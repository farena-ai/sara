// S1 (docs/ROADMAP_AFTER_3.40.md): Meaning search sets itself once when an embedding model is on
// this computer (src/meaning-auto.ts); a research ask said without the usual words goes to the
// research model by what it means (src/tool-meaning.ts, src/chat.ts); the numbers depend on the
// embedding model; and she is told to look for a tool before answering without one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runTurn } from '../src/chat.ts';
import type { EmbedTarget } from '../src/embeddings.ts';
import { adoptMeaningSearch, pickEmbedModel } from '../src/meaning-auto.ts';
import { MEANT, meantFor, NOT_RESEARCH, RESEARCH_ASKS, ROUTE_MEANT, routeMeantFor, ToolMeaning } from '../src/tool-meaning.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, tempDir, text } from './helpers.ts';

test('S1 adopt: the best embedding model on this computer; never an Ollama Cloud name', () => {
  assert.equal(pickEmbedModel(['qwen3:8b', 'nomic-embed-text:latest', 'bge-m3:latest']), 'bge-m3:latest', 'the one that works in many languages first');
  assert.equal(pickEmbedModel(['qwen3:8b', 'mxbai-embed-large', 'nomic-embed-text:latest']), 'nomic-embed-text:latest');
  assert.equal(pickEmbedModel(['qwen3:8b', 'snowflake-arctic-embed:335m']), 'snowflake-arctic-embed:335m');
  assert.equal(pickEmbedModel(['qwen3:8b', 'llava:13b']), undefined);
  assert.equal(pickEmbedModel(['some-embed:cloud']), undefined);
});

test('S1 adopt: set once from a provider on this computer; the owner turning it off sticks', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  try {
    const here = { id: 'o', label: 'Ollama', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', local: true };
    const away = { id: 'c', label: 'Cloud', kind: 'openai-compatible' as const, baseUrl: 'https://example.com/v1' };
    app.settings.update({ providers: [away, here], routes: { background: { providerId: 'c', model: 'm' } } } as never);
    const lists: Record<string, string[]> = { c: ['text-embedding-3-small', 'big-model'], o: ['qwen3:8b'] };
    const adopt = () => adoptMeaningSearch(app, (id) => lists[id] ?? []);
    // No embedding model on this computer: nothing is set (one elsewhere is not used), and it is asked again later.
    assert.equal(adopt(), undefined);
    assert.equal(app.settings.get().routes?.embeddings, undefined);
    assert.equal(app.settings.get().meaningAuto, undefined);
    // One appears (ollama pull): set, with the other jobs left as they were.
    lists.o = ['qwen3:8b', 'nomic-embed-text:latest'];
    assert.deepEqual(adopt(), { providerId: 'o', model: 'nomic-embed-text:latest' });
    assert.deepEqual(app.settings.get().routes, { background: { providerId: 'c', model: 'm' }, embeddings: { providerId: 'o', model: 'nomic-embed-text:latest' } });
    assert.equal(app.settings.get().meaningAuto, 'done');
    // The owner turns Meaning search off: it stays off, also when a better model appears.
    app.settings.update({ routes: { background: { providerId: 'c', model: 'm' } } } as never);
    lists.o.push('bge-m3:latest');
    assert.equal(adopt(), undefined);
    assert.equal(app.settings.get().routes?.embeddings, undefined);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('S1 adopt: a job set by hand is left alone', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  try {
    const here = { id: 'o', label: 'Ollama', kind: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:11434/v1', local: true };
    app.settings.update({ providers: [here], routes: { embeddings: { providerId: 'o', model: 'nomic-embed-text' } } } as never);
    assert.equal(adoptMeaningSearch(app, () => ['bge-m3', 'nomic-embed-text']), undefined);
    assert.deepEqual(app.settings.get().routes?.embeddings, { providerId: 'o', model: 'nomic-embed-text' });
    assert.equal(app.settings.get().meaningAuto, 'done');
  } finally {
    app.store.close();
    cleanup();
  }
});

// A stand-in embedding model for routing: research asks point one way, their opposites another,
// and a message sits where the test puts it.
const unit = (a: number, b: number): Float32Array => {
  const n = Math.hypot(a, b, 0.1);
  return Float32Array.from([a / n, b / n, 0.1 / n]);
};
const strip = (s: string): string => s.replace(/^search_(query|document): /, '');
function routeEmbed(where: Record<string, [number, number]>, calls: string[][] = []) {
  return async (_t: EmbedTarget, texts: string[]) => {
    calls.push(texts.map(strip));
    return texts.map((raw) => {
      const s = strip(raw);
      if (RESEARCH_ASKS.includes(s)) return unit(1, 0);
      if (NOT_RESEARCH.includes(s)) return unit(0, 1);
      const at = where[s] ?? [0.5, 0.5];
      return unit(at[0], at[1]);
    });
  };
}
const target = (model = 'fake-embed'): EmbedTarget => ({ config: { id: 'e', label: 'E', kind: 'openai-compatible', baseUrl: 'http://x/v1', local: true }, model });

test('S1 routing: a research ask by what it means; in between, short, no model or a failing one is a no', async () => {
  const calls: string[][] = [];
  const where = { 'get to the bottom of whether robot vacuums are worth it': [1, 0.1], 'which do you like better, autumn or spring': [0.1, 1], 'tell me something about heat pumps maybe': [0.52, 0.5] } as Record<string, [number, number]>;
  const m = new ToolMeaning(() => target(), routeEmbed(where, calls));
  assert.equal(await m.research('get to the bottom of whether robot vacuums are worth it'), true);
  assert.equal(await m.research('which do you like better, autumn or spring'), false);
  assert.equal(await m.research('tell me something about heat pumps maybe'), false, 'nearer to research, but not by enough');
  assert.equal(await m.research('look it up'), false, 'too short to judge by meaning');
  // The asks were embedded once; after that one call per message.
  assert.equal(calls.filter((c) => c.includes(RESEARCH_ASKS[0]!)).length, 1);
  assert.equal(await new ToolMeaning(() => undefined, routeEmbed(where)).research('get to the bottom of whether robot vacuums are worth it'), false);
  const bad = new ToolMeaning(() => target(), async () => {
    throw new Error('down');
  });
  assert.equal(await bad.research('get to the bottom of whether robot vacuums are worth it'), false);
  assert.match(bad.lastError ?? '', /down/);
  // A slow model: the turn does not wait for it.
  const slow = new ToolMeaning(() => target(), () => new Promise<Float32Array[]>(() => undefined));
  const t0 = Date.now();
  assert.equal(await slow.research('get to the bottom of whether robot vacuums are worth it', 80), false);
  assert.ok(Date.now() - t0 < 1000);
});

test('S1 routing and tools share one call for the message', async () => {
  const calls: string[][] = [];
  const m = new ToolMeaning(() => target(), routeEmbed({}, calls));
  const tool = { spec: { name: 'zebra_count', description: 'Counts stripes.', parameters: { type: 'object' } } } as unknown as Tool;
  const said = 'how stripy is that horse over there';
  await m.research(said);
  await m.pick(said, [tool]);
  assert.equal(calls.filter((c) => c.includes(said)).length, 1);
});

test('S1 numbers: the floors and the routing margin belong to the embedding model', () => {
  assert.deepEqual(meantFor('nomic-embed-text:latest'), MEANT);
  assert.deepEqual(meantFor('some-other-embed'), MEANT);
  const bge = meantFor('bge-m3:latest');
  assert.ok(bge.toolFloor < MEANT.toolFloor && bge.familyFloor < MEANT.familyFloor, 'bge-m3 scores everything lower');
  assert.equal(bge.tools, MEANT.tools);
  assert.deepEqual(routeMeantFor('nomic-embed-text'), ROUTE_MEANT);
  assert.ok(routeMeantFor('bge-m3').margin < ROUTE_MEANT.margin);
  // With the lower floor, a tool at 0.5 is picked with bge-m3 and not with another model.
  const tool = { spec: { name: 'zebra_count', description: 'Counts stripes.', parameters: { type: 'object' } } } as unknown as Tool;
  const half = async (_t: EmbedTarget, texts: string[]) => texts.map((s) => (/zebra/.test(s) ? Float32Array.from([1, 0]) : Float32Array.from([0.5, Math.sqrt(0.75)])));
  return (async () => {
    assert.deepEqual(await new ToolMeaning(() => target('bge-m3'), half).pick('how stripy is that horse', [tool]), ['zebra_count']);
    assert.deepEqual(await new ToolMeaning(() => target('fake-embed'), half).pick('how stripy is that horse', [tool]), []);
  })();
});

test('S1 turn: a research ask found by meaning goes to the research model; not in a coding chat, not past a private chat', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  try {
    const here = { id: 'p', label: 'P', kind: 'openai-compatible' as const, baseUrl: 'http://x', defaultModel: 'm', local: true };
    const away = { id: 'r', label: 'R', kind: 'openai-compatible' as const, baseUrl: 'http://y', defaultModel: 'e' };
    const set = (embedHere: boolean) =>
      app.settings.update({ providers: [here, away], defaultProviderId: 'p', defaultModel: 'm', routes: { research: { providerId: 'p', model: 'deep' }, embeddings: { providerId: embedHere ? 'p' : 'r', model: 'fake-embed' } }, ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T00:00:00Z' } as never);
    set(false);
    const asked: string[] = [];
    app.toolMeaning = { research: async (said: string) => (asked.push(said), /vacuums/.test(said)), pick: async () => [] } as never;
    const modelFor = async (conv: string, said: string): Promise<string> => {
      app.script.push(text('ok'));
      for await (const _ of runTurn(app, conv, said, undefined)) void _;
      return app.requests.at(-1)!.model;
    };
    const conv = app.store.createConversation();
    assert.equal(await modelFor(conv.id, 'Can you get to the bottom of whether robot vacuums are worth it?'), 'deep');
    assert.equal(await modelFor(conv.id, 'Which do you like better, autumn or spring?'), 'm');
    assert.equal(asked.length, 2);
    // The words already say it: the meaning is not asked.
    assert.equal(await modelFor(conv.id, 'Research the best robot vacuums.'), 'deep');
    assert.equal(asked.length, 2);
    // A coding chat has no research job.
    const code = app.store.createConversation({ mode: 'coding' } as never);
    assert.equal(await modelFor(code.id, 'Can you get to the bottom of whether robot vacuums are worth it?'), 'm');
    assert.equal(asked.length, 2);
    // A private chat: the message is not sent to an embedding model that is not on this computer.
    const priv = app.store.createConversation({ private: true } as never);
    await modelFor(priv.id, 'Can you get to the bottom of whether robot vacuums are worth it?');
    assert.equal(asked.length, 2);
    set(true);
    const privHere = app.store.createConversation({ private: true } as never);
    await modelFor(privHere.id, 'Can you get to the bottom of whether robot vacuums are worth it?');
    assert.equal(asked.length, 3);
    // No research model and no Auto for it: nothing to route to, so nothing is asked.
    app.settings.update({ routes: { embeddings: { providerId: 'p', model: 'fake-embed' } } } as never);
    assert.equal(await modelFor(conv.id, 'Can you get to the bottom of whether robot vacuums are worth it?'), 'm');
    assert.equal(asked.length, 3);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('S1 instructions: with a short tool list she is told to look for a tool before answering without one', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-24T15:00:00Z') });
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', lean: { tools: { mode: 'always' } }, ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T00:00:00Z' } as never);
    const conv = app.store.createConversation();
    app.script.push(text('ok'));
    for await (const _ of runTurn(app, conv.id, 'hello there', undefined)) void _;
    const sent = JSON.stringify(app.requests.at(-1)!.messages);
    assert.match(sent, /When nothing in your list does what Alex asked, call find_tools before you answer/);
  } finally {
    app.store.close();
    cleanup();
  }
});
