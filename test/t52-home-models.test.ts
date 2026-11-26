// T52: models on the owner's own computer answer without the long silent waits. Found on his PC
// (2026-11-26, Ollama's own log): (1) each chat title was written by another model on the same
// computer, which holds one model at a time, so every turn loaded 13 GB again; (2) the chat model
// thought for about 1,700 tokens before a 220-token reply, with nothing on screen meanwhile; (3) the
// quick thinking level sent think: true to Ollama, the same as thorough.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeChatThink, runTurn, type ChatEvent } from '../src/chat.ts';
import { cheapRoute, warmInstead, WARM_MS } from '../src/cheap.ts';
import { ModelContextStore, noteOllamaDaemon, noteOllamaPs, resetDaemonHardware } from '../src/model-context.ts';
import { ollamaThink, OpenAICompatibleProvider, resetOllamaContext, THINK_REPORT_CHARS } from '../src/providers/openai-compatible.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { listen, makeApp, readBody, tempDir, type TestApp } from './helpers.ts';

const GB = 1024 ** 3;
const ps = (...names: string[]) => ({ models: names.map((name) => ({ name, model: name, size: 13 * GB, size_vram: 13 * GB, context_length: 32_768 })) });

async function fakeOllama(o: { thinking?: string[] } = {}) {
  const chats: Record<string, unknown>[] = [];
  const state = { ps: { models: [] } as unknown };
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    const json = (x: unknown) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(x));
    if (req.url === '/api/ps') return json(state.ps);
    if (req.url === '/api/tags') return json({ models: [] });
    if (req.url === '/api/show') return json({ model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 131_072 }, capabilities: ['completion', 'tools', 'thinking'] });
    if (req.url === '/api/chat') {
      const j = JSON.parse(body) as Record<string, unknown>;
      chats.push(j);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (j.think !== false) for (const piece of o.thinking ?? []) res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: '', thinking: piece }, done: false })}\n`);
      res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: 'Hi.' }, done: false })}\n`);
      return void res.end(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 })}\n`);
    }
    res.writeHead(404).end('not found');
  });
  return { chats, state, url, close: () => server.close() };
}

function setup(t: { after: (fn: () => void) => void }, baseUrl: string, routes: Record<string, { providerId: string; model: string }> = {}) {
  resetOllamaContext();
  resetDaemonHardware();
  noteOllamaDaemon(baseUrl);
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-26T12:00:00Z') });
  const config: ProviderConfig = { id: 'pc', label: 'Ollama on my PC', kind: 'openai-compatible', baseUrl, local: true };
  app.settings.update({ providers: [config], defaultProviderId: 'pc', defaultModel: 'chat-model:12b', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', routes });
  app.modelContext = new ModelContextStore(dir, () => new Date());
  app.modelContext.hardwareKnown = true;
  app.modelContext.vramGb = 32;
  app.providerFactory = (c) => new OpenAICompatibleProvider(c);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, config };
}

async function drain(gen: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('T52: the quick level is no thinking on a model that takes only on or off; gpt-oss keeps its levels', () => {
  assert.equal(ollamaThink('gemma4:12b', 'low'), false);
  assert.equal(ollamaThink('gemma4:12b', 'none'), false);
  assert.equal(ollamaThink('gemma4:12b', 'high'), true);
  assert.equal(ollamaThink('gemma4:12b', undefined), undefined);
  assert.equal(ollamaThink('gpt-oss:20b', 'low'), 'low');
  assert.equal(ollamaThink('gpt-oss:20b', 'none'), false);
});

test('T52: Balanced on a model at home skips thinking in an ordinary chat only', () => {
  const home = { local: true };
  assert.equal(homeChatThink(home, 'gemma4-heretic:12b-q8', { mode: 'chat' }), 'low');
  assert.equal(homeChatThink(home, 'gemma4-heretic:12b-q8', { mode: 'coding' }), undefined, 'coding keeps the model default');
  assert.equal(homeChatThink(home, 'gemma4:31b-cloud', { mode: 'chat' }), undefined, 'a cloud model through the same Ollama is not at home');
  assert.equal(homeChatThink({ local: false }, 'gpt-x', { mode: 'chat' }), undefined);
  assert.equal(homeChatThink(home, 'gemma4-heretic:12b-q8', { mode: 'chat', thinking: 'balanced' }), undefined, "a chat's own level is the owner's word");
});

test('T52: an ordinary chat turn on the home model asks for no thinking; Thorough asks for it and the chat hears about it as it grows', async (t) => {
  const piece = 'x'.repeat(THINK_REPORT_CHARS);
  const srv = await fakeOllama({ thinking: [piece, piece, 'tail'] });
  t.after(srv.close);
  const { app } = setup(t, srv.url);
  const conv = app.store.createConversation({ title: 'hello' });
  const evs = await drain(runTurn(app, conv.id, 'Hi there'));
  assert.equal(srv.chats.at(-1)!.think, false, 'Balanced at home: think false');
  assert.equal(evs.some((e) => e.type === 'reasoning'), false);
  assert.ok(evs.some((e) => e.type === 'token'));

  app.settings.update({ thinking: 'thorough' });
  const evs2 = await drain(runTurn(app, conv.id, 'Now a hard one'));
  assert.equal(srv.chats.at(-1)!.think, true);
  const said = evs2.filter((e): e is Extract<ChatEvent, { type: 'reasoning' }> => e.type === 'reasoning');
  assert.ok(said.length >= 2, 'reported while it grows, not once at the end');
  assert.deepEqual(said.map((e) => e.chars), [...said.map((e) => e.chars)].sort((a, b) => a - b), 'the count only grows');
  assert.equal(said.at(-1)!.chars, THINK_REPORT_CHARS * 2, "the last few characters come with the reply and need no line");
  assert.ok(evs2.findIndex((e) => e.type === 'reasoning') < evs2.findIndex((e) => e.type === 'token'), 'before the first word');
});

test('T52: a small call uses the model already on the card, not another one on the same computer', async (t) => {
  const srv = await fakeOllama();
  t.after(srv.close);
  const { app, config } = setup(t, srv.url, { chat: { providerId: 'pc', model: 'chat-model:12b' }, private: { providerId: 'pc', model: 'private-model:9b' } });
  const conv = app.store.createConversation({ title: 'hello' });
  // Nothing known about the daemon: the Private route's model, as before.
  assert.equal(cheapRoute(app, conv, 'local', 'titles').some((c) => c.model === 'private-model:9b'), true);
  // The chat model is loaded (what /api/ps says right after a reply starts).
  noteOllamaPs(config.baseUrl, ps('chat-model:12b'));
  const route = cheapRoute(app, conv, 'local', 'titles');
  assert.ok(route.length);
  assert.deepEqual([...new Set(route.map((c) => c.model))], ['chat-model:12b']);
  assert.equal(route[0]!.provider.config.id, 'pc');
  // The asked-for model is the loaded one: nothing changes.
  noteOllamaPs(config.baseUrl, ps('private-model:9b'));
  const direct = cheapRoute(app, conv, 'local', 'titles').find((c) => c.from === 'private');
  assert.equal(direct?.model, 'private-model:9b');
  // An old answer no longer counts, a cloud model through the daemon is not the owner's own, an embedding model can't write.
  const priv = direct!;
  noteOllamaPs(config.baseUrl, ps('chat-model:12b'), Date.now() - WARM_MS - 1_000);
  assert.equal(warmInstead(app, priv, { purpose: 'titles' }).model, 'private-model:9b');
  noteOllamaPs(config.baseUrl, ps('big:cloud'));
  assert.equal(warmInstead(app, priv, { purpose: 'titles' }).model, 'private-model:9b');
  noteOllamaPs(config.baseUrl, ps('nomic-embed-text:latest'));
  assert.equal(warmInstead(app, priv, { purpose: 'titles' }).model, 'private-model:9b');
  noteOllamaPs(config.baseUrl, ps('nomic-embed-text:latest', 'chat-model:12b'));
  assert.equal(warmInstead(app, priv, { purpose: 'titles' }).model, 'chat-model:12b');
});
