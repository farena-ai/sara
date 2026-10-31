// Phase 38 exit check: every job routes to its model; a fallback takes over on a forced failure and
// on a slow model; photos go to the vision model while talking stays on the text model; meaning
// search finds notes said in other words (and falls back to words when it can't be reached).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { resolveChain, runTurn, streamWithin, SlowModelError, type ChatEvent } from '../src/chat.ts';
import { complete } from '../src/life.ts';
import { cosine, MemoryVectors } from '../src/embeddings.ts';
import { recommend, isCloudModel, costHint } from '../src/modelpicks.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import type { RoutePurpose } from '../src/settings.ts';
import { listen, makeApp, readBody, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-28T15:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';

/** Per-provider behaviour: 'ok' answers with its own name, 'fail' throws, 'slow' never answers. */
const mode: Record<string, 'ok' | 'fail' | 'slow'> = {};
const seen: { provider: string; model: string; images: number }[] = [];
class JobProvider implements Provider {
  readonly config: ProviderConfig;
  constructor(config: ProviderConfig) {
    this.config = config;
  }
  async listModels(): Promise<string[]> {
    return { a: ['big-chat', 'gemma4:31b', 'tiny-flash', 'qwen3-coder:30b', 'nomic-embed-text', 'glm-5.3:cloud'], b: ['backup-model'], loc: ['llama-local:8b'] }[this.config.id] ?? [];
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const images = req.messages.reduce((n, m) => n + (m.role === 'user' && m.images ? m.images.length : 0), 0);
    seen.push({ provider: this.config.id, model: req.model, images });
    const m = mode[this.config.id] ?? 'ok';
    if (m === 'fail') throw new Error('503 overloaded');
    if (m === 'slow') {
      await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true }));
    }
    yield { type: 'text', text: `${this.config.id}/${req.model} here.` };
  }
}

before(async () => {
  app.providerFactory = (config) => new JobProvider(config);
  app.settings.update({
    providers: [
      { id: 'a', label: 'Alpha', kind: 'openai-compatible', baseUrl: 'http://a' },
      { id: 'b', label: 'Beta', kind: 'openai-compatible', baseUrl: 'http://b' },
      { id: 'loc', label: 'Home', kind: 'openai-compatible', baseUrl: 'http://loc', local: true },
    ],
    defaultProviderId: 'a',
    defaultModel: 'big-chat',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: clock.now.toISOString(),
    routes: {
      coding: { providerId: 'a', model: 'qwen3-coder:30b' },
      vision: { providerId: 'a', model: 'gemma4:31b' },
      planning: { providerId: 'b', model: 'backup-model' },
      quick: { providerId: 'a', model: 'tiny-flash' },
      writing: { providerId: 'a', model: 'big-chat' },
      research: { providerId: 'b', model: 'backup-model' },
      private: { providerId: 'loc', model: 'llama-local:8b' },
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, method = 'GET', body?: unknown) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
async function turn(convId: string, text: string, images?: string[]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, text, undefined, images ? { images } : {})) out.push(ev);
  return out;
}

test('every job routes to its model, and jobs without one inherit (background → chat, planning → background…)', () => {
  const conv = app.store.createConversation();
  const pick = (job: RoutePurpose | 'turn') => `${resolveChain(app, conv, job)[0].provider.config.id}/${resolveChain(app, conv, job)[0].model}`;
  assert.equal(pick('turn'), 'a/big-chat');
  assert.equal(pick('chat'), 'a/big-chat');
  assert.equal(pick('vision'), 'a/gemma4:31b');
  assert.equal(pick('planning'), 'b/backup-model');
  assert.equal(pick('quick'), 'a/tiny-flash');
  assert.equal(pick('writing'), 'a/big-chat');
  assert.equal(pick('research'), 'b/backup-model');
  assert.equal(pick('background'), 'a/big-chat', 'background inherits the default when unset');
  const coding = app.store.createConversation({ mode: 'coding' });
  assert.equal(`${resolveChain(app, coding, 'turn')[0].model}`, 'qwen3-coder:30b');
  assert.equal(`${resolveChain(app, coding, 'background')[0].model}`, 'qwen3-coder:30b', 'coding background uses the coding model as before');
  const priv = app.store.createConversation({ private: true });
  assert.equal(`${resolveChain(app, priv, 'turn')[0].provider.config.id}`, 'loc');
  // Per companion: her own model stands in for talking only.
  app.settings.update({ companionModel: { providerId: 'b', model: 'backup-model' } });
  assert.equal(pick('turn'), 'b/backup-model');
  assert.equal(pick('quick'), 'a/tiny-flash');
  assert.equal(`${resolveChain(app, coding, 'turn')[0].model}`, 'qwen3-coder:30b');
  app.settings.update({ companionModel: undefined });
});

test('private conversations never use an Ollama cloud model, even through a local Ollama', () => {
  const priv = app.store.createConversation({ private: true, providerId: 'loc', model: 'glm-5.3:cloud' });
  assert.throws(() => resolveChain(app, priv, 'turn'), /only uses models on your own hardware/);
  assert.equal(isCloudModel('glm-5.3:cloud'), true);
  assert.equal(isCloudModel('gemma4:31b-cloud'), true);
  assert.equal(isCloudModel('gemma4:31b'), false);
});

test('a fallback takes over on a forced failure, and the owner is told plainly', async () => {
  app.settings.update({ defaultFallbacks: [{ providerId: 'b', model: 'backup-model' }] });
  mode.a = 'fail';
  const conv = app.store.createConversation();
  const evs = await turn(conv.id, 'hi there');
  const notice = evs.find((e) => e.type === 'notice' && e.kind === 'fallback');
  assert.ok(notice && notice.type === 'notice');
  assert.match(notice.text, /^Alpha \(big-chat\) failed: 503 overloaded, so Beta \(backup-model\) took over\.$/);
  assert.equal(evs.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join(''), 'b/backup-model here.');
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && m.content.startsWith('fallback:')));
  // Background work falls back too (no notice, just the next model).
  assert.equal(await complete(app, conv, [{ role: 'user', content: 'x' }], 50), 'b/backup-model here.');
  mode.a = 'ok';
});

test('a slow model (no first word in time) is replaced; Stop still stops', async () => {
  app.settings.update({ fallbackAfterSec: 10 });
  const slowStart = Date.now();
  // The helper itself, with a short wait.
  mode.s = 'slow';
  await assert.rejects(
    (async () => {
      for await (const _ of streamWithin((sig) => new JobProvider({ id: 's', label: 'S', kind: 'openai-compatible', baseUrl: 'http://s' }).stream({ model: 'm', messages: [], signal: sig }), undefined, 150)) void _;
    })(),
    SlowModelError,
  );
  assert.ok(Date.now() - slowStart < 2000);
  mode.a = 'slow';
  const conv = app.store.createConversation();
  const t0 = Date.now();
  const evs = await turn(conv.id, 'are you there?');
  const notice = evs.find((e) => e.type === 'notice');
  assert.match((notice as { text: string }).text, /Alpha \(big-chat\) gave no answer within 10 seconds, so Beta \(backup-model\) took over/);
  assert.ok(Date.now() - t0 >= 9_500 && Date.now() - t0 < 20_000);
  mode.a = 'ok';
  app.settings.update({ fallbackAfterSec: 60, defaultFallbacks: [] });
});

test('vision: a photo goes to the vision model with the photo; the next message is back on the text model without it', async () => {
  const conv = app.store.createConversation();
  const up = app.uploads!.save(`data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`);
  seen.length = 0;
  await turn(conv.id, "what's in this picture?", [up.id]);
  assert.deepEqual(seen.at(-1), { provider: 'a', model: 'gemma4:31b', images: 1 });
  await turn(conv.id, 'cool. how was your day?');
  assert.deepEqual(seen.at(-1), { provider: 'a', model: 'big-chat', images: 0 }, 'talking stays on the text model, no photos sent to it');
  const hist = app.requests.length; // (scripted provider not used here)
  void hist;
});

test('research asks go to the research model', async () => {
  const conv = app.store.createConversation();
  seen.length = 0;
  await turn(conv.id, 'Can you research the best e-bikes under $2000?');
  assert.equal(seen.at(-1)!.provider, 'b');
  await turn(conv.id, 'thanks!');
  assert.equal(seen.at(-1)!.model, 'big-chat');
});

test('recommended picks come from what is connected; talking stays your choice; private is local only', () => {
  const cands = [
    { providerId: 'a', provider: 'Alpha', model: 'big-chat', local: false },
    { providerId: 'a', provider: 'Alpha', model: 'gemma4:31b', local: false },
    { providerId: 'a', provider: 'Alpha', model: 'tiny-flash', local: false },
    { providerId: 'a', provider: 'Alpha', model: 'qwen3-coder:30b', local: false },
    { providerId: 'a', provider: 'Alpha', model: 'kimi-k3:cloud', local: false },
    { providerId: 'loc', provider: 'Home', model: 'nomic-embed-text', local: true },
    { providerId: 'loc', provider: 'Home', model: 'llama-local:8b', local: true },
  ];
  const r = recommend(cands, { providerId: 'a', model: 'big-chat' });
  assert.equal(r.chat, undefined);
  assert.equal(r.vision?.model, 'gemma4:31b');
  assert.equal(r.coding?.model, 'qwen3-coder:30b');
  assert.equal(r.quick?.model, 'tiny-flash');
  assert.equal(r.planning?.model, 'kimi-k3:cloud');
  assert.equal(r.embeddings?.model, 'nomic-embed-text');
  assert.equal(r.private?.model, 'llama-local:8b');
  // When the talking model can see, vision uses it (one model).
  assert.equal(recommend(cands, { providerId: 'a', model: 'gemma4:31b' }).vision?.why, 'Your talking model can see pictures too.');
  assert.equal(costHint({ id: 'x', label: 'x', kind: 'openai-compatible', baseUrl: 'http://x', local: true }, 'kimi-k3:cloud'), 'Ollama cloud: part of your Ollama plan');
});

test('settings: backups, switch time and her own model are saved and checked', async () => {
  let r = await call('/api/settings', 'PUT', { routes: { chat: { providerId: 'a', model: 'big-chat', fallbacks: [{ providerId: 'b', model: 'backup-model' }, { providerId: 'a', model: 'tiny-flash' }, { providerId: 'a', model: 'x' }] } }, fallbackAfterSec: 30, companionModel: { providerId: 'b', model: 'backup-model' } });
  assert.equal(r.status, 200);
  const s = await (await call('/api/settings')).json();
  assert.equal(s.routes.chat.fallbacks.length, 2, 'two backups at most');
  assert.equal(s.fallbackAfterSec, 30);
  assert.equal(s.companionModel.model, 'backup-model');
  r = await call('/api/settings', 'PUT', { routes: { private: { providerId: 'loc', model: 'glm-5.3:cloud' } } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Ollama cloud model/);
  assert.equal((await call('/api/settings', 'PUT', { fallbackAfterSec: 5 })).status, 400);
  await call('/api/settings', 'PUT', { routes: {}, companionModel: null, fallbackAfterSec: 60 });
  const jobs = await (await call('/api/model-jobs')).json();
  assert.deepEqual(jobs.jobs.map((j: { id: string }) => j.id), ['chat', 'coding', 'vision', 'planning', 'writing', 'research', 'review', 'quick', 'background', 'embeddings', 'private', 'adult', 'screen']); // Phase 81: + Reviewing; Phase 92: + Seeing your screen (advanced)
  const t = await (await call('/api/model-jobs/test', 'POST', { job: 'quick', providerId: 'a', model: 'tiny-flash' })).json();
  assert.equal(t.ok, true);
  assert.equal(t.sample, 'a/tiny-flash here.');
  const c = await (await call('/api/model-jobs/compare', 'POST', { job: 'writing', candidates: [{ providerId: 'a', model: 'big-chat' }, { providerId: 'b', model: 'backup-model' }] })).json();
  assert.equal(c.results.length, 2);
  assert.match(c.prompt, /diary entry/);
});

test('meaning search: finds a note said in other words; falls back to words when the model is unreachable', async () => {
  // A toy embedding model: words map onto a few "meaning" axes.
  const AXES = [/lake|cabin|pine|trip|fishing/i, /tax|forms|irs|april/i, /sister|lena|family/i, /dentist|teeth/i];
  const vec = (s: string) => AXES.map((re) => (s.match(new RegExp(re.source, 'gi')) ?? []).length + 0.01);
  const { server: emb, url } = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { input: string[] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map((s, index) => ({ index, embedding: vec(s) })) }));
  });
  try {
    app.settings.update({ providers: [...app.settings.get().providers, { id: 'emb', label: 'Embedder', kind: 'openai-compatible', baseUrl: `${url}/v1`, local: true }], routes: { embeddings: { providerId: 'emb', model: 'toy-embed' } } });
    const mem = app.memory!;
    const cabin = mem.add({ kind: 'fact', content: 'Alex booked the Pine cabin for fishing on the 14th', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
    mem.add({ kind: 'fact', content: 'Alex needs to file his IRS forms by April', conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
    const vectors = new MemoryVectors(app.store.db, mem, () => ({ config: app.settings.get().providers.find((p) => p.id === 'emb')!, model: 'toy-embed' }));
    assert.equal(await vectors.index(), 2);
    assert.equal(await vectors.index(), 0, 'nothing left to do');
    assert.deepEqual(vectors.status(), { model: 'toy-embed', indexed: 2, total: 2 });
    // "lake trip" shares no word with the note, so word search misses it…
    assert.equal(mem.list({ q: 'how was the lake trip?' }).length, 0);
    // …and meaning search finds it.
    const near = await vectors.related('how was the lake trip?');
    assert.equal(near[0]?.memory.id, cabin.id);
    assert.equal(near.length, 1, 'tax note is not close');
    // In a turn, it reaches her instructions.
    app.vectors = vectors;
    const conv = app.store.createConversation();
    seen.length = 0;
    let sys = '';
    app.providerFactory = (config) => {
      const p = new JobProvider(config);
      return { config, listModels: () => p.listModels(), stream: (req: ChatRequest) => ((sys = String(req.messages[0].content)), p.stream(req)) };
    };
    await turn(conv.id, 'how was the lake trip?');
    assert.match(sys, /Alex booked the Pine cabin for fishing/);
    // An edit redoes the note's vector.
    mem.update(cabin.id, 'Alex booked the Pine cabin for fishing with Lena on the 14th');
    assert.equal(await vectors.index(), 1);
    // Unreachable: nothing found by meaning, the turn still works on words.
    emb.close();
    emb.closeAllConnections();
    assert.deepEqual(await vectors.related('how was the lake trip?', 6, 0.6, 500), []);
    assert.ok(vectors.status().error);
    const evs = await turn(conv.id, 'and the IRS forms?');
    assert.ok(evs.some((e) => e.type === 'token'));
    assert.match(sys, /IRS forms by April/, 'word search still works');
    assert.ok(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])) > 0.99);
  } finally {
    app.vectors = undefined;
    app.providerFactory = (config) => new JobProvider(config);
    emb.close();
  }
});
