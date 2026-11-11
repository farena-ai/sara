// 3.4.1: the conversation memory follows the model's context window (src/model-context.ts).
// Fixtures in test/fixtures/model-windows/ are trimmed real responses (OpenRouter /models and a
// local Ollama 0.40 /api/tags and /api/show, taken 2026-11-11; the show fixture gained a Modelfile
// num_ctx line); the other shapes follow the vendors' API references.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { contextFill, historyBudgetFor, historyMode, HISTORY_BUDGET_CHARS, runTurn } from '../src/chat.ts';
import {
  autoHistory,
  BALANCED_HISTORY_TOKENS,
  charsPerToken,
  HARD_MAX_CHARS,
  localNumCtx,
  ModelContextStore,
  type DaemonHardware,
  noteOllamaDaemon,
  parseAnthropic,
  parseGemini,
  parseOllamaShow,
  parseOllamaTags,
  parseOpenAIList,
  parseOpenRouter,
  tableLimits,
  WINDOWS_FILE,
} from '../src/model-context.ts';
import { OpenAICompatibleProvider, resetOllamaContext } from '../src/providers/openai-compatible.ts';
import { ProviderError, type ChatRequest, type Provider, type ProviderConfig, type StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { FakeProvider, listen, makeApp, readBody, tempDir, text, type TestApp } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'model-windows', name), 'utf8')) as unknown;

async function drain(it: AsyncIterable<unknown>) {
  for await (const _ of it) {
    /* run to the end */
  }
}

// ---------------------------------------------------------------------------------------------
// Lookup parsing per provider
// ---------------------------------------------------------------------------------------------

test('OpenRouter /models: context_length and the top provider’s longest reply', () => {
  const got = parseOpenRouter(fixture('openrouter-models.json'));
  assert.deepEqual(got['openai/gpt-4.1'], { context: 1_047_576, maxOutput: 32_768, vision: true }, '3.4.3: input_modalities has image');
  assert.equal(got['anthropic/claude-sonnet-4.5'].context, 1_000_000);
  assert.equal(got['meta-llama/llama-3.1-8b-instruct'].context, 131_072);
});

test('Ollama /api/tags (details.context_length) and /api/show (model_info + Modelfile num_ctx)', () => {
  const tags = parseOllamaTags(fixture('ollama-tags.json'));
  assert.equal(tags['qwen3.5:9b'].context, 262_144);
  assert.equal(tags['gpt-oss:20b-cloud'].context, 131_072);
  assert.equal(tags['nomic-embed-text'].context, 2048, ':latest is also found without the tag');
  assert.deepEqual(parseOllamaShow(fixture('ollama-show.json')), { context: 262_144, numCtx: 16_384, vision: true }, '3.4.3: capabilities has vision');
  assert.equal(parseOllamaShow({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, parameters: '' })?.context, 131_072);
  assert.equal(parseOllamaShow({}), undefined);
});

test('Gemini, Anthropic, vLLM, LM Studio, plain OpenAI list shapes', () => {
  const gemini = parseGemini({ models: [{ name: 'models/gemini-2.5-pro', version: '2.5', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', inputTokenLimit: 2048, outputTokenLimit: 1 }] });
  assert.deepEqual(gemini['gemini-2.5-pro'], { context: 1_048_576, maxOutput: 65_536 });
  const anthropic = parseAnthropic({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-21T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 }, { type: 'model', id: 'claude-old', max_input_tokens: null, max_tokens: null }], has_more: false });
  assert.deepEqual(anthropic, { 'claude-opus-5-5': { context: 1_000_000, maxOutput: 128_000 } });
  const vllm = parseOpenAIList({ object: 'list', data: [{ id: 'Qwen/Qwen3-32B', object: 'model', owned_by: 'vllm', max_model_len: 32768 }] });
  assert.equal(vllm['Qwen/Qwen3-32B'].context, 32_768);
  const lm = parseOpenAIList({ object: 'list', data: [{ id: 'qwen2.5-7b-instruct', object: 'model', type: 'llm', state: 'loaded', max_context_length: 32768, loaded_context_length: 8192 }] });
  assert.equal(lm['qwen2.5-7b-instruct'].context, 8192, 'LM Studio: what is loaded now counts');
  assert.deepEqual(parseOpenAIList({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'system' }] }), {}, 'OpenAI says nothing: the table decides');
  assert.deepEqual(parseOpenAIList('nonsense'), {});
});

// ---------------------------------------------------------------------------------------------
// Table, unknown fallback, the auto math, the cost guard
// ---------------------------------------------------------------------------------------------

test('the dated table matches model families; unknown models get nothing', () => {
  assert.equal(tableLimits('gpt-4.1-mini')?.context, 1_047_576);
  assert.equal(tableLimits('gpt-5')?.context, 400_000);
  assert.equal(tableLimits('openai/gpt-5.5')?.context, 1_050_000);
  assert.equal(tableLimits('claude-sonnet-4-5')?.context, 200_000);
  assert.equal(tableLimits('claude-opus-5-5[1m]')?.context, 1_000_000, 'the opt-in 1M variant');
  assert.equal(tableLimits('gemini-2.5-flash')?.context, 1_048_576);
  assert.equal(tableLimits('llama3.1:8b')?.context, 131_072);
  assert.equal(tableLimits('qwen3:8b')?.context, 40_960);
  assert.equal(tableLimits('deepseek-chat')?.context, 163_840);
  assert.equal(tableLimits('m'), undefined);
  assert.equal(tableLimits('my-own-finetune'), undefined);
});

test('auto math: unknown stays at today’s 48,000 characters; known windows grow; cost guard', () => {
  assert.equal(autoHistory({ source: 'default', billing: 'api', mode: 'auto' }).chars, HISTORY_BUDGET_CHARS);
  assert.equal(autoHistory({ source: 'default', billing: 'local', mode: 'full' }).chars, HISTORY_BUDGET_CHARS, 'never larger by guess');
  // Pay-per-token, 1M window: Balanced stops at 128k tokens of history.
  const balanced = autoHistory({ limits: { context: 1_000_000, maxOutput: 32_768 }, source: 'table', billing: 'api', mode: 'auto' });
  assert.equal(balanced.tokens, BALANCED_HISTORY_TOKENS);
  assert.equal(balanced.capped, 'balanced');
  assert.equal(balanced.chars, BALANCED_HISTORY_TOKENS * 4);
  // "Full window": (1,000,000 - 16,000 reply - 12,000 prompt) × 0.85.
  const full = autoHistory({ limits: { context: 1_000_000, maxOutput: 32_768 }, source: 'table', billing: 'api', mode: 'full' });
  assert.equal(full.tokens, Math.floor((1_000_000 - 16_000 - 12_000) * 0.85));
  assert.equal(full.capped, undefined);
  // Subscriptions and local models cost nothing per token: up to the window.
  const sub = autoHistory({ limits: { context: 200_000, maxOutput: 32_000 }, source: 'table', billing: 'subscription', mode: 'auto' });
  assert.equal(sub.tokens, Math.floor((200_000 - 16_000 - 12_000) * 0.85));
  // Small windows keep room for the reply and the prompt.
  const small = autoHistory({ limits: { context: 8192 }, source: 'provider', billing: 'local', mode: 'auto' });
  assert.ok(small.tokens < 8192 * 0.6 && small.chars >= 8000, `${small.tokens}`);
  // Never past the app's hard limit.
  assert.equal(autoHistory({ limits: { context: 2_000_000 }, source: 'table', billing: 'subscription', mode: 'auto' }).chars, HARD_MAX_CHARS);
  // A cloud model through a local Ollama runs on ollama.com: cost-capped too.
  assert.equal(autoHistory({ limits: { context: 1_048_576 }, source: 'provider', billing: 'local', mode: 'auto', cloudThroughDaemon: true }).capped, 'balanced');
  // Fixed is fixed.
  assert.equal(autoHistory({ limits: { context: 1_000_000 }, source: 'table', billing: 'api', mode: 'fixed', fixedChars: 120_000 }).chars, 120_000);
});

test('chars per token: English 4, Japanese far fewer', () => {
  assert.equal(charsPerToken('The quick brown fox jumps over the lazy dog. '.repeat(20)), 4);
  assert.ok(charsPerToken('今日はとても良い天気ですね。散歩に行きましょう。'.repeat(20)) < 1.6);
});

test('Ollama num_ctx: 8k on the processor or not known yet; on a graphics card 32k (more on big cards), the model max with "full" (bounded by the card), enough for a fixed size', () => {
  const gpu = (vramGb?: number): DaemonHardware => ({ kind: 'gpu', basis: 'daemon', ...(vramGb ? { vramGb } : {}) });
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144 }), 8_192, '3.4.5: not known yet = small');
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: { kind: 'cpu', basis: 'daemon' } }), 8_192);
  assert.equal(localNumCtx({ mode: 'full', modelMax: 262_144, hw: { kind: 'cpu', basis: 'daemon' } }), 16_384, 'full on the processor: at most 16k');
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: gpu() }), 32_768);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: gpu(12) }), 32_768);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: gpu(32) }), 65_536, 'not less than Ollama itself picks on a 32 GB card');
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: gpu(80) }), 131_072);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 8192, hw: gpu() }), 8192, 'never past what the model holds');
  assert.equal(localNumCtx({ mode: 'full', modelMax: 262_144, hw: gpu(32) }), 131_072);
  assert.equal(localNumCtx({ mode: 'full', modelMax: 262_144, hw: gpu(8) }), 65_536);
  assert.equal(localNumCtx({ mode: 'full', modelMax: 262_144, hw: gpu(96) }), 262_144);
  assert.ok(localNumCtx({ mode: 'fixed', modelMax: 262_144, fixedChars: 400_000 }) >= 100_000 + 12_000);
});

// ---------------------------------------------------------------------------------------------
// Settings: Auto is the default; an explicit size stays
// ---------------------------------------------------------------------------------------------

test('migration: no setting or the old default is Auto; another saved size is kept', () => {
  assert.equal(historyMode({}), 'auto');
  assert.equal(historyMode({ historyBudgetChars: 48_000 }), 'auto', 'the old settings page always saved its default');
  assert.equal(historyMode({ historyBudgetChars: 120_000 }), 'fixed');
  assert.equal(historyMode({ historyBudgetChars: 16_000 }), 'fixed');
  assert.equal(historyMode({ historyBudgetMode: 'fixed', historyBudgetChars: 48_000 }), 'fixed');
  assert.equal(historyMode({ historyBudgetMode: 'full', historyBudgetChars: 16_000 }), 'full');
});

function setup(t: { after: (fn: () => void) => void }, providers: ProviderConfig[], extra: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-11T12:00:00Z') });
  app.settings.update({ providers, defaultProviderId: providers[0].id, ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', ...extra });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir };
}

test('the PUT /settings route: Auto, full window and a fixed size; an old client sending only a size is fixed', async (t) => {
  const { app, dir } = setup(t, [{ id: 'oa', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needsKey: true }], { defaultModel: 'gpt-4.1' });
  app.vault.set('provider:oa', 'sk-test');
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '3.4.1', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, body?: unknown) => {
    const res = await fetch(`${base}/api/settings`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return (await res.json()) as Record<string, unknown>;
  };
  let s = await api('GET');
  assert.equal(s.historyBudgetMode, 'auto');
  const view = s.historyBudget as { model: string; tokens: number; windowTokens: number; capped: string; billing: string };
  assert.equal(view.model, 'gpt-4.1');
  assert.equal(view.windowTokens, 1_047_576);
  assert.equal(view.tokens, BALANCED_HISTORY_TOKENS, 'pay-per-token: the balanced ceiling');
  assert.equal(view.capped, 'balanced');
  await api('PUT', { historyBudgetMode: 'full' });
  s = await api('GET');
  assert.ok((s.historyBudget as { tokens: number }).tokens > 800_000);
  await api('PUT', { historyBudgetChars: 120_000 });
  s = await api('GET');
  assert.equal(s.historyBudgetMode, 'fixed', 'an older app sending only a size chose that size');
  assert.equal((s.historyBudget as { chars: number }).chars, 120_000);
  await api('PUT', { historyBudgetMode: 'fixed', historyBudgetChars: 48_000 });
  assert.equal((await api('GET')).historyBudgetMode, 'fixed', 'chosen on purpose: kept');
  await api('PUT', { historyBudgetMode: 'auto' });
  assert.equal((await api('GET')).historyBudgetMode, 'auto');
});

// ---------------------------------------------------------------------------------------------
// The cache: provider lists first, kept on disk, offline keeps the last known
// ---------------------------------------------------------------------------------------------

test('a fake OpenRouter /models: looked up once, cached on disk, used offline; table and default behind it', async (t) => {
  let hits = 0;
  let up = true;
  const { server, url } = await listen((req, res) => {
    hits++;
    if (!up) return void res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fixture('openrouter-models.json')));
  });
  t.after(() => server.close());
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  // The real adapter decides by address; the fake server is "openrouter.ai" in a path segment.
  const config: ProviderConfig = { id: 'or', label: 'OpenRouter', kind: 'openai-compatible', baseUrl: `${url}/openrouter.ai/api/v1` };
  const p = new OpenAICompatibleProvider(config, 'k');
  const store = new ModelContextStore(dir, () => new Date('2026-11-11T12:00:00Z'));
  assert.equal(store.limits(config, 'openai/gpt-4.1').source, 'table', 'before the list: the table');
  await store.prime(p, 'openai/gpt-4.1', 5000);
  assert.deepEqual(store.limits(config, 'openai/gpt-4.1'), { limits: { context: 1_047_576, maxOutput: 32_768, vision: true }, source: 'provider' });
  await store.prime(p, 'openai/gpt-4.1', 5000);
  assert.equal(hits, 1, 'fresh for a day');
  up = false;
  const again = new ModelContextStore(dir, () => new Date('2026-11-13T12:00:00Z'));
  await again.prime(p, 'openai/gpt-4.1', 5000);
  assert.equal(again.limits(config, 'openai/gpt-4.1').source, 'provider', 'offline: the last known numbers from the file');
  assert.ok(readFileSync(join(dir, WINDOWS_FILE), 'utf8').includes('1047576'));
  assert.equal(again.limits(config, 'some/unknown-model').source, 'default');
});

// ---------------------------------------------------------------------------------------------
// Ollama: num_ctx goes with every call through /api/chat
// ---------------------------------------------------------------------------------------------

async function fakeOllama() {
  const chats: Record<string, unknown>[] = [];
  const v1: unknown[] = [];
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/tags') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fixture('ollama-tags.json')));
    if (req.url === '/api/show') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fixture('ollama-show.json')));
    // 3.4.5: where the models run (nothing loaded here).
    if (req.url === '/api/ps') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
    if (req.url === '/api/chat') {
      const j = JSON.parse(body) as Record<string, unknown>;
      chats.push(j);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: 'Hello' }, done: false })}\n`);
      if ((j.messages as unknown[]).length === 2 && j.tools) res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'clock', arguments: { zone: 'UTC' } } }] }, done: false })}\n`);
      res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: ' there.' }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 7 })}\n`);
      return void res.end();
    }
    v1.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"choices":[{"delta":{"content":"via v1"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  return { chats, v1, url, close: () => server.close() };
}

test('Ollama on your computer: options.num_ctx through /api/chat, remembered for later calls; tool calls and usage come back', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama();
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const p = new OpenAICompatibleProvider({ id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true });
  const events: StreamEvent[] = [];
  for await (const ev of p.stream({ model: 'qwen3.5:9b', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi', images: [{ mime: 'image/png', data: 'AAAA' }] }], tools: [{ name: 'clock', description: 'time', parameters: { type: 'object' } }], numCtx: 32_768, reasoning: 'none' })) events.push(ev);
  assert.equal(o.chats.length, 1);
  assert.deepEqual(o.chats[0].options, { num_ctx: 32_768 });
  assert.equal(o.chats[0].think, false);
  assert.deepEqual((o.chats[0].messages as { images?: string[] }[])[1].images, ['AAAA']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), 'Hello there.');
  const call = events.find((e) => e.type === 'tool_call') as { call: { name: string; arguments: unknown } };
  assert.deepEqual(call.call.arguments, { zone: 'UTC' });
  assert.deepEqual(events.at(-1), { type: 'usage', input: 321, output: 7 });
  // A background chore without numCtx asks for the same context (no model reload in Ollama).
  await drain(p.stream({ model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'title?' }] }));
  assert.deepEqual(o.chats[1].options, { num_ctx: 32_768 });
  // Cloud models through the daemon already get their full window: /v1 as before.
  await drain(p.stream({ model: 'gpt-oss:20b-cloud', messages: [{ role: 'user', content: 'hi' }], numCtx: 32_768 }));
  assert.equal(o.v1.length, 1);
  // The lookup reads /api/tags and /api/show.
  const lim = await p.modelLimits('qwen3.5:9b');
  assert.deepEqual(lim['qwen3.5:9b'], { context: 262_144, numCtx: 16_384, vision: true });
});

test('a turn on a local Ollama model sends num_ctx; the history budget follows the window Sara asks for', async (t) => {
  resetOllamaContext();
  const o = await fakeOllama();
  t.after(o.close);
  noteOllamaDaemon(`${o.url}/v1`);
  const { app, dir } = setup(t, [{ id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${o.url}/v1`, local: true }], { defaultModel: 'qwen3.5:9b' });
  app.modelContext = new ModelContextStore(dir, app.now);
  app.providerFactory = (config) => new OpenAICompatibleProvider(config);
  const conv = app.store.createConversation();
  // 3.4.5: this computer has a 12 GB card, so the Ollama on it runs on the card: 32k.
  app.modelContext.hardwareKnown = true;
  app.modelContext.vramGb = 12;
  await drain(runTurn(app, conv.id, 'hello', new AbortController().signal));
  assert.equal(o.chats.length >= 1, true);
  assert.equal((o.chats[0].options as { num_ctx: number }).num_ctx, 32_768);
  const b = historyBudgetFor(app, conv);
  assert.equal(b.numCtx, 32_768);
  assert.equal(b.hardware, 'gpu');
  assert.equal(b.windowTokens, 32_768);
  assert.equal(b.capped, 'local');
  assert.ok(b.chars > HISTORY_BUDGET_CHARS, `32k window: more than the old 12k (${b.chars})`);
  const fill = contextFill(app, conv);
  assert.equal(fill.budget, b.chars, 'the ring and /status measure against the same budget');
  assert.equal(fill.tokens.window, 32_768);
});

// ---------------------------------------------------------------------------------------------
// Per conversation: the model the turn uses; a smaller fallback gets a shorter history
// ---------------------------------------------------------------------------------------------

test('the budget follows the conversation’s own model; a fallback with a smaller window gets a trimmed history', async (t) => {
  const { app } = setup(t, [
    { id: 'big', label: 'Big', kind: 'openai-compatible', baseUrl: 'http://big.example/v1' },
    { id: 'small', label: 'Small', kind: 'openai-compatible', baseUrl: 'http://small.example/v1' },
  ], { defaultModel: 'gpt-4.1', defaultFallbacks: [{ providerId: 'small', model: 'llama3:8b' }], historyBudgetMode: 'full' });
  const sent: { model: string; chars: number }[] = [];
  app.providerFactory = (config): Provider => {
    const fake = new FakeProvider(config, app.script, app.requests);
    return {
      config,
      listModels: () => fake.listModels(),
      async *stream(req: ChatRequest) {
        sent.push({ model: req.model, chars: req.messages.filter((m) => m.role !== 'system').reduce((n, m) => n + m.content.length, 0) });
        if (config.id === 'big') throw new ProviderError('Big had a problem on its side (HTTP 500).', 500);
        yield* fake.stream(req);
      },
    };
  };
  const conv = app.store.createConversation();
  for (let i = 0; i < 40; i++) {
    app.store.addMessage(conv.id, 'user', `question ${i} ${'x'.repeat(2000)}`);
    app.store.addMessage(conv.id, 'assistant', `answer ${i} ${'y'.repeat(2000)}`);
  }
  // The conversation's own model wins over the default.
  const own = app.store.createConversation();
  app.store.updateConversation(own.id, { providerId: 'small', model: 'llama3:8b' });
  assert.equal(historyBudgetFor(app, own).windowTokens, 8192);
  assert.equal(historyBudgetFor(app, own).model, 'llama3:8b');
  assert.ok(historyBudgetFor(app, conv).chars > 1_000_000, 'GPT-4.1, full window');
  app.script.push(text('ok'));
  await drain(runTurn(app, conv.id, 'and now?', new AbortController().signal));
  assert.deepEqual(sent.map((s) => s.model), ['gpt-4.1', 'llama3:8b']);
  assert.ok(sent[0].chars > 150_000, `the big model got the whole chat (${sent[0].chars})`);
  const small = historyBudgetFor(app, conv, { provider: { config: app.settings.get().providers[1] }, model: 'llama3:8b' });
  assert.ok(sent[1].chars <= small.chars, `the 8k fallback got at most its own budget (${sent[1].chars} ≤ ${small.chars})`);
  assert.ok(sent[1].chars < sent[0].chars / 4);
});

test('nothing known about the model: exactly today’s budget, and contextFill agrees', (t) => {
  const { app } = setup(t, [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], { defaultModel: 'm' });
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'hello');
  assert.equal(historyBudgetFor(app, conv).chars, HISTORY_BUDGET_CHARS);
  const fill = contextFill(app, conv);
  assert.equal(fill.budget, HISTORY_BUDGET_CHARS);
  assert.equal(fill.kept, 60);
  assert.equal(fill.mode, 'auto');
  assert.equal(app.providerCalls, 0, 'measuring makes no provider');
});

test('a model server on your own hardware: the table never guesses its context (only what the server reports)', (t) => {
  const { app } = setup(t, [{ id: 'lm', label: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', local: true }], { defaultModel: 'qwen3.5-9b' });
  assert.equal(historyBudgetFor(app).source, 'default');
  assert.equal(historyBudgetFor(app).chars, HISTORY_BUDGET_CHARS);
});
