// Fred fix B (shelton runs 147/148): beam:cloud through "Ollama on this computer" answered
// (ok:true, 273 and 219 tokens out) with only its private reasoning, no words and no tool call.
// The turn ended as "The model returned an empty reply." with no saved notice and no log line.
// Every turn error is now logged (class + redacted message) and saved as a notice with Try again
// and Report it; a reasoning-only / think-tags-only / tool-call-as-text answer gets one more go.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import type { ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { listen, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const OLLAMA: ProviderConfig = { id: 'ollama-local', label: 'Ollama on this computer', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'beam:cloud' };

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-12T08:06:08Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [OLLAMA], defaultProviderId: OLLAMA.id, defaultModel: OLLAMA.defaultModel, ownerName: 'Fred', disclosureAcceptedAt: clock.now.toISOString() } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return app;
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Captures console.warn / console.error lines while fn runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const w = console.warn;
  const e = console.error;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = w;
    console.error = e;
  }
}

const reasoningOnly = (chars: number): StreamEvent[] => [{ type: 'reasoning', chars }, { type: 'usage', input: 16915, output: 219 }];

test('B: a reasoning-only answer (beam:cloud) gets one more go with a plain note, and her reply is saved', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  app.script.push(reasoningOnly(900), text('No coding needed: it is in Settings → Connections.'));
  const evs = await drain(runTurn(app, conv.id, 'Is this a tool that I can enable for you to do this?'));
  assert.ok(!evs.some((e) => e.type === 'error'), JSON.stringify(evs.filter((e) => e.type === 'error')));
  assert.ok(evs.some((e) => e.type === 'done'));
  assert.equal(app.requests.length, 2);
  const last = app.requests[1].messages.at(-1);
  assert.equal(last?.role, 'user');
  assert.match(String(last?.content), /no words/i);
  assert.equal(app.requests[1].reasoning, 'none', 'the second go asks for no thinking');
  const msgs = app.store.messages(conv.id);
  assert.ok(msgs.some((m) => m.role === 'assistant' && /Settings → Connections/.test(m.content)));
});

test('B: twice empty: the error is logged with its class, saved as a notice with the error, and the event carries its id', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  app.script.push(reasoningOnly(900), reasoningOnly(700));
  const { value: evs, lines } = await logged(() => drain(runTurn(app, conv.id, 'Is this a tool that I can enable?')));
  const err = evs.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }> | undefined;
  assert.ok(err, 'an error event');
  assert.match(err.message, /only its private reasoning|no words/i);
  assert.ok(typeof err.messageId === 'number' && err.messageId > 0, 'the saved notice id rides on the event');
  const notice = app.store.messages(conv.id).find((m) => m.id === err.messageId);
  assert.equal(notice?.role, 'notice');
  assert.ok(notice?.content.startsWith('turnerror:'), notice?.content);
  assert.equal((notice?.meta as { errorClass?: string })?.errorClass, 'EmptyReply');
  const line = lines.find((l) => /turn error/.test(l));
  assert.ok(line, `logged: ${lines.join(' | ')}`);
  assert.match(line, /EmptyReply/);
  assert.match(line, /beam:cloud/);
});

test('B: a reply that is only <think>…</think> counts as empty (one more go), and think tags never stay in a saved reply', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  app.script.push(text('<think>The user asks whether', ' I can do it.</think>'), text('<think>short</think>Yes: turn it on in Settings.'));
  const evs = await drain(runTurn(app, conv.id, 'Can you?'));
  assert.ok(!evs.some((e) => e.type === 'error'));
  assert.equal(app.requests.length, 2);
  const saved = app.store.messages(conv.id).filter((m) => m.role === 'assistant' && m.content.trim());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, 'Yes: turn it on in Settings.');
});

test('B: a tool call written as text (JSON) for an offered tool runs as a real call', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  const ran: unknown[] = [];
  app.tools.add({ spec: { name: 'look_up', description: 'Look something up.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }, defaultPermission: 'auto', source: 'built-in', summarize: () => 'look up', run: async (args: unknown) => (ran.push(args), 'found it') } as never);
  app.script.push(text('```json\n{"name": "look_up", "arguments": {"query": "browser extensions"}}\n```'), text('Here is what I found.'));
  const evs = await drain(runTurn(app, conv.id, 'look it up'));
  assert.deepEqual(ran, [{ query: 'browser extensions' }]);
  assert.ok(evs.some((e) => e.type === 'tool_call' && e.name === 'look_up'), JSON.stringify(evs.map((e) => e.type)));
  assert.ok(!app.store.messages(conv.id).some((m) => m.role === 'assistant' && m.content.includes('"arguments"')), 'the JSON is not saved as her words');
});

test('B: JSON text naming a tool she was not offered stays her words (never runs)', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  app.script.push(text('{"name": "rm_everything", "arguments": {}}'));
  const evs = await drain(runTurn(app, conv.id, 'show me json'));
  assert.ok(!evs.some((e) => e.type === 'tool_call'));
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'assistant' && m.content.includes('rm_everything')));
});

test('B: a provider failure is logged and saved as a notice too (never silent)', async (t) => {
  const app = setup(t);
  const conv = app.store.createConversation();
  app.providerFactory = (config) => ({
    config,
    listModels: async () => [],
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('upstream said 500 with key sk-abcdefghijklmnop1234');
    },
  });
  const { value: evs, lines } = await logged(() => drain(runTurn(app, conv.id, 'hi')));
  const err = evs.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }> | undefined;
  assert.ok(err?.messageId);
  const line = lines.find((l) => /turn error/.test(l));
  assert.ok(line);
  assert.match(line, /Error: upstream said 500/);
  assert.doesNotMatch(line, /sk-abcdefghijklmnop1234/, 'redacted');
});

test('B: the OpenAI-compatible stream reports reasoning-only answers (Ollama "reasoning" / "reasoning_content")', async (t) => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"The user is asking"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"","reasoning_content":" whether Fred can"},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":219}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  const p = new OpenAICompatibleProvider({ id: 'x', label: 'X', kind: 'openai-compatible', baseUrl: `${url}/v1`, defaultModel: 'beam:cloud' });
  const evs: StreamEvent[] = [];
  for await (const ev of p.stream({ model: 'beam:cloud', messages: [{ role: 'user', content: 'hi' }] })) evs.push(ev);
  const r = evs.find((e) => e.type === 'reasoning') as Extract<StreamEvent, { type: 'reasoning' }> | undefined;
  assert.equal(r?.chars, 'The user is asking whether Fred can'.length);
  assert.ok(!evs.some((e) => e.type === 'text'), 'reasoning never becomes her words');
});
