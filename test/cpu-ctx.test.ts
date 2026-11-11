// 3.4.5: num_ctx and the history follow the Ollama DAEMON's hardware (src/model-context.ts
// daemonHardware): its own /api/ps says whether the model runs on the graphics card; a daemon on
// this computer has this computer's card; another computer's daemon is unknown (small) until its
// /api/ps answers. A slow first word gets a plain notice (src/trouble.ts slowTrouble); a local
// summary for tidying never holds things up for long (src/compact.ts compactTiming.localMs).
// The fake Ollama answers /api/ps, /api/show and /api/chat like Ollama 0.40 (shapes from its API
// reference; size_vram 0 = on the processor, as the owner's GPU-less server showed live).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextFill, historyBudgetFor, runTurn, slowNoticeTiming, type ChatEvent } from '../src/chat.ts';
import { autoFold, compactNow, compactTiming } from '../src/compact.ts';
import { daemonHardware, localNumCtx, ModelContextStore, noteOllamaDaemon, noteOllamaPs, resetDaemonHardware } from '../src/model-context.ts';
import { OpenAICompatibleProvider, resetOllamaContext } from '../src/providers/openai-compatible.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { SLOW_CPU } from '../src/trouble.ts';
import { FakeProvider, listen, makeApp, readBody, tempDir, text, type TestApp } from './helpers.ts';

const GB = 1024 ** 3;
const ps = (...models: { name: string; size: number; vram: number; ctx?: number }[]) => ({ models: models.map((m) => ({ name: m.name, model: m.name, size: m.size * GB, size_vram: m.vram * GB, ...(m.ctx ? { context_length: m.ctx } : {}) })) });

async function fakeOllama(o: { ps?: unknown; delayMs?: number } = {}) {
  const chats: Record<string, unknown>[] = [];
  const state = { ps: o.ps ?? { models: [] }, delayMs: o.delayMs ?? 0, psCalls: 0 };
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    const json = (x: unknown) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(x));
    if (req.url === '/api/ps') return (state.psCalls++, json(state.ps));
    if (req.url === '/api/tags') return json({ models: [{ name: 'qwen3.5:4b', model: 'qwen3.5:4b', details: { family: 'qwen35' } }] });
    if (req.url === '/api/show') return json({ model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262_144 }, capabilities: ['completion', 'tools'] });
    if (req.url === '/api/chat') {
      const j = JSON.parse(body) as Record<string, unknown>;
      chats.push(j);
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: 'Hi.' }, done: false })}\n`);
      return void res.end(`${JSON.stringify({ model: j.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 })}\n`);
    }
    res.writeHead(404).end('not found');
  });
  return { chats, state, url, close: () => server.close() };
}

function setup(t: { after: (fn: () => void) => void }, baseUrl: string, here?: { vramGb?: number }) {
  resetOllamaContext();
  resetDaemonHardware();
  noteOllamaDaemon(baseUrl);
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-11T12:00:00Z') });
  const config: ProviderConfig = { id: 'srv', label: 'Ollama on the server', kind: 'openai-compatible', baseUrl, local: true };
  app.settings.update({ providers: [config], defaultProviderId: 'srv', defaultModel: 'qwen3.5:4b', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z' });
  app.modelContext = new ModelContextStore(dir, () => new Date());
  if (here) {
    app.modelContext.hardwareKnown = true;
    app.modelContext.vramGb = here.vramGb;
  }
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

function longChat(app: TestApp, id: string, n: number, size = 600) {
  for (let i = 0; i < n; i++) {
    app.store.addMessage(id, 'user', `Question ${i}: ${'about the parser and the tests '.repeat(Math.ceil(size / 30)).slice(0, size)}`);
    app.store.addMessage(id, 'assistant', `Answer ${i}: ${'here is what I found in the code '.repeat(Math.ceil(size / 33)).slice(0, size)}`);
  }
}

test('a daemon that runs the model on the processor (/api/ps size_vram 0): 8k, and the history the turn, the ring and /status use follows the 8k', async (t) => {
  const o = await fakeOllama({ ps: ps({ name: 'qwen3.5:4b', size: 4.2, vram: 0, ctx: 32_768 }) });
  t.after(o.close);
  const { app } = setup(t, `${o.url}/v1`, {});
  const conv = app.store.createConversation();
  longChat(app, conv.id, 60);
  await drain(runTurn(app, conv.id, 'hello', new AbortController().signal));
  assert.ok(o.state.psCalls >= 1, 'Sara asked the daemon where its models run');
  assert.equal((o.chats[0].options as { num_ctx: number }).num_ctx, 8_192, 'not the 32k of 3.4.1');
  const b = historyBudgetFor(app, conv);
  assert.equal(b.numCtx, 8_192);
  assert.equal(b.hardware, 'cpu');
  assert.equal(b.windowTokens, 8_192);
  assert.ok(b.tokens < 8_192, `the history fits in the num_ctx (${b.tokens} tokens)`);
  const sentChars = (o.chats[0].messages as { content: string }[]).filter((m) => m.content && !/^You are|^#/.test(m.content)).reduce((n, m) => n + m.content.length, 0);
  assert.ok(sentChars < 60 * 1200, `older messages were left out (${sentChars} chars sent)`);
  const fill = contextFill(app, conv);
  assert.equal(fill.budget, b.chars, 'ring and /status: the same budget');
  assert.equal(fill.tokens.window, 8_192);
  // The long chat was tidied at the start of the turn against that same, smaller budget.
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && m.content.startsWith('compact:')), 'tidied against the 8k budget');
  assert.ok(fill.used <= fill.budget);
  // "Full window" on the processor: at most 16k.
  app.settings.update({ historyBudgetMode: 'full' });
  assert.equal(historyBudgetFor(app, conv).numCtx, 16_384);
});

test('the same computer: no graphics card here = processor (8k); a card here = its tiers; Sara’s card never counts for another computer', () => {
  resetDaemonHardware();
  const local = 'http://127.0.0.1:11434/v1';
  const remote = 'http://100.71.2.3:11434/v1';
  assert.equal(daemonHardware(local, 'm', { known: true }).kind, 'cpu', 'GPU-less server, Ollama on it');
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: daemonHardware(local, 'm', { known: true }) }), 8_192);
  const here = daemonHardware(local, 'm', { known: true, vramGb: 32 });
  assert.deepEqual([here.kind, here.basis, here.vramGb], ['gpu', 'this-machine', 32]);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: here }), 65_536);
  // Another computer (over Tailscale): unknown, so small, even with a big card here.
  const far = daemonHardware(remote, 'm', { known: true, vramGb: 32 });
  assert.deepEqual([far.kind, far.vramGb], ['unknown', undefined]);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: far }), 8_192);
  assert.equal(localNumCtx({ mode: 'full', modelMax: 262_144, hw: far }), 16_384);
  // This computer not checked yet: unknown too.
  assert.equal(daemonHardware(local, 'm', { known: false }).kind, 'unknown');
});

test('the daemon’s /api/ps decides: the model on the card = GPU tiers (also for another computer); split or on the processor = 8k; other models tell whether it has a card', () => {
  resetDaemonHardware();
  const remote = 'http://100.71.2.3:11434/v1';
  noteOllamaPs(remote, ps({ name: 'gemma4:31b', size: 20.7, vram: 20.7, ctx: 65_536 }));
  const g = daemonHardware(remote, 'gemma4:31b');
  assert.deepEqual([g.kind, g.basis, g.loadedCtx], ['gpu', 'daemon', 65_536]);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 131_072, hw: g }), 32_768, 'card size unknown there: the 32k tier');
  // Another model on the same daemon: it has a card.
  assert.equal(daemonHardware(remote, 'qwen3.5:9b').kind, 'gpu');
  // Split between card and processor: as slow as the processor.
  noteOllamaPs(remote, ps({ name: 'gemma4:31b', size: 24, vram: 12 }));
  assert.equal(daemonHardware(remote, 'gemma4:31b').kind, 'cpu');
  noteOllamaPs(remote, ps({ name: 'other:7b', size: 5, vram: 0 }));
  assert.equal(daemonHardware(remote, 'gemma4:31b').kind, 'cpu', 'everything there runs on the processor');
  // ":latest" names match.
  noteOllamaPs(remote, ps({ name: 'llama3:latest', size: 5, vram: 5 }));
  assert.equal(daemonHardware(remote, 'llama3').kind, 'gpu');
});

test('a nearly full graphics card (other models loaded): no more than the model already has or Ollama’s own default', () => {
  resetDaemonHardware();
  const local = 'http://127.0.0.1:11434/v1';
  // 32 GB card with 31 GB taken by another model: this one isn't loaded.
  noteOllamaPs(local, ps({ name: 'gemma4-ortenzya-31b', size: 31, vram: 31, ctx: 65_536 }));
  const full = daemonHardware(local, 'qwen3.5:9b', { known: true, vramGb: 32 }, 4_096);
  assert.equal(full.kind, 'gpu');
  assert.equal(full.freeGb, 1);
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: full }), 4_096, 'the Modelfile default');
  assert.equal(localNumCtx({ mode: 'full', modelMax: 262_144, hw: { ...full, defaultCtx: undefined } }), 8_192);
  // The loaded model itself keeps the context it has (no reload, no crash).
  const self = daemonHardware(local, 'gemma4-ortenzya-31b', { known: true, vramGb: 32 });
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 131_072, hw: self }), 65_536);
  // Room left: the 32 GB tier.
  noteOllamaPs(local, ps({ name: 'small:4b', size: 4, vram: 4 }));
  assert.equal(localNumCtx({ mode: 'auto', modelMax: 262_144, hw: daemonHardware(local, 'qwen3.5:9b', { known: true, vramGb: 32 }) }), 65_536);
});

test('slow first word on a processor daemon: one plain notice (Fix it → Which model does what), the turn goes on and answers', async (t) => {
  const o = await fakeOllama({ ps: ps({ name: 'qwen3.5:4b', size: 4.2, vram: 0, ctx: 8_192 }), delayMs: 400 });
  t.after(o.close);
  const { app } = setup(t, `${o.url}/v1`, {});
  const was = { ...slowNoticeTiming };
  slowNoticeTiming.cpuMs = 100;
  slowNoticeTiming.anyMs = 5_000;
  t.after(() => Object.assign(slowNoticeTiming, was));
  const conv = app.store.createConversation();
  const evs = await drain(runTurn(app, conv.id, 'hello', new AbortController().signal));
  const slow = evs.filter((e) => e.type === 'slow') as Extract<ChatEvent, { type: 'slow' }>[];
  assert.equal(slow.length, 1, 'said once');
  assert.equal(slow[0].trouble.key, SLOW_CPU);
  assert.equal(slow[0].trouble.text, 'qwen3.5:4b on Ollama on the server runs on the processor and is very slow for a chat this long. Fix it: pick a faster model.');
  assert.equal(slow[0].trouble.fix.page, 'models-routes');
  assert.ok(evs.findIndex((e) => e.type === 'slow') < evs.findIndex((e) => e.type === 'token'), 'before the first word');
  assert.ok(evs.some((e) => e.type === 'done'), 'the reply still came');
  assert.equal(evs.filter((e) => e.type === 'error').length, 0);
});

test('a fast model gets no notice; a GPU daemon waits the longer 90 s', async (t) => {
  const o = await fakeOllama({ ps: ps({ name: 'qwen3.5:4b', size: 4.2, vram: 4.2 }), delayMs: 250 });
  t.after(o.close);
  const { app } = setup(t, `${o.url}/v1`, {});
  const was = { ...slowNoticeTiming };
  slowNoticeTiming.cpuMs = 100;
  t.after(() => Object.assign(slowNoticeTiming, was));
  assert.equal(was.cpuMs, 45_000);
  assert.equal(was.anyMs, 90_000);
  const conv = app.store.createConversation();
  const evs = await drain(runTurn(app, conv.id, 'hello', new AbortController().signal));
  assert.equal(evs.filter((e) => e.type === 'slow').length, 0, 'on the card: the 90 s rule, not 45');
});

test('tidying: a local summary that hangs gives way to the quick model after compactTiming.localMs, tried once', async (t) => {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-11T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const LOCAL: ProviderConfig = { id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'local-m' };
  const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };
  app.settings.update({ providers: [CLOUD, LOCAL], defaultProviderId: 'c', defaultModel: 'cloud-m', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', routes: { quick: { providerId: 'c', model: 'cloud-m' } }, historyBudgetChars: 48_000 });
  let localCalls = 0;
  app.providerFactory = (config): Provider => {
    if (config.id !== 'l') return new FakeProvider(config, app.script, app.requests);
    return {
      config,
      async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
        localCalls++;
        // A crashed/overloaded llama-server: nothing comes until the call is given up.
        await new Promise<void>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')), { once: true }));
      },
      async listModels() {
        return ['local-m'];
      },
    } as Provider;
  };
  const was = { ...compactTiming };
  assert.equal(was.localMs, 30_000, 'a local summary gets at most 30 s');
  compactTiming.localMs = 150;
  t.after(() => Object.assign(compactTiming, was));
  const conv = app.store.createConversation();
  longChat(app, conv.id, 35);
  app.script.push(text('Alex is building a parser.'));
  const start = Date.now();
  const r = await compactNow(app, conv, { trigger: 'command' });
  const ms = Date.now() - start;
  assert.ok('fold' in r, JSON.stringify(r));
  assert.equal(localCalls, 1, 'the hanging local model is not tried a second time');
  assert.equal(r.fold.local, false, 'the quick model wrote it');
  assert.ok(ms < 2_000, `fell back quickly (${ms} ms)`);
  assert.equal(typeof autoFold, 'function');
});
