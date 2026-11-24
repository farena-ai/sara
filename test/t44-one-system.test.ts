// T44: a model server on the owner's own hardware gets one system message, first. Ollama 0.40.17 runs
// each model's own chat template, and the qwen family's raises "System message must be at the
// beginning" for any other system message: an HTTP 500 for the whole turn (owner report, 2026-11-24).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteOllamaDaemon, resetDaemonHardware } from '../src/model-context.ts';
import { oneSystemFirst, OpenAICompatibleProvider, resetOllamaContext } from '../src/providers/openai-compatible.ts';
import type { ChatMessage } from '../src/providers/types.ts';
import { listen, readBody } from './helpers.ts';

const convo: ChatMessage[] = [
  { role: 'system', content: 'You are Sara.' },
  { role: 'system', content: 'Notes for this step.' },
  { role: 'user', content: 'Hi.' },
  { role: 'assistant', content: 'Hello!' },
  { role: 'system', content: 'Your reply was cut off. Continue.' },
  { role: 'user', content: 'What is two plus two?' },
  { role: 'system', content: '[Now: Tue, Nov 24, 2026, 5:40 AM CST]' },
];

test('T44 one system message, first: the leading ones become one; later ones become marked notes in the person\'s turn', () => {
  const out = oneSystemFirst(convo);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'user']);
  assert.equal(out[0]!.content, 'You are Sara.\n\nNotes for this step.');
  assert.equal(out[3]!.content, '[Note from the app, not from the person you are talking with: Your reply was cut off. Continue.]', 'after her turn: a note of its own');
  assert.equal(out[4]!.content, 'What is two plus two?\n\n[Now: Tue, Nov 24, 2026, 5:40 AM CST]', 'after his message: joined to it; a bracketed note is kept as written');
  assert.equal(out.filter((m) => m.role === 'system').length, 1);
  // Nothing to do: the same array back.
  const plain: ChatMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
  assert.equal(oneSystemFirst(plain), plain);
  const none: ChatMessage[] = [{ role: 'user', content: 'u' }];
  assert.equal(oneSystemFirst(none), none);
  // Only system messages (a one-shot instruction): one message.
  assert.deepEqual(oneSystemFirst([{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }]), [{ role: 'system', content: 'a\n\nb' }]);
  // Tool calls and their results stay in order; pictures stay on their message.
  const tools: ChatMessage[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'look', images: [{ mime: 'image/png', data: 'AAAA' }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'note', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'note', content: 'ok' },
    { role: 'system', content: 'A correction.' },
  ];
  const t = oneSystemFirst(tools);
  assert.deepEqual(t.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal((t[1] as { images?: unknown[] }).images?.length, 1);
});

test('T44 on the wire: own hardware gets one system message on both Ollama paths; a hosted API gets them as they are', async (t) => {
  resetOllamaContext();
  resetDaemonHardware();
  const seen: { url: string; roles: string[] }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}') as { messages?: { role: string }[] };
    if (req.url === '/api/chat') {
      seen.push({ url: req.url, roles: (body.messages ?? []).map((m) => m.role) });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'four' }, done: false })}\n`);
      return void res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`);
    }
    if (req.url === '/v1/chat/completions') {
      seen.push({ url: req.url, roles: (body.messages ?? []).map((m) => m.role) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'four' } }] })}\n\n`);
      return void res.end('data: [DONE]\n\n');
    }
    if (req.url === '/api/ps') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [] }));
    res.writeHead(404).end('not found');
  });
  t.after(() => {
    server.close();
    resetOllamaContext();
    resetDaemonHardware();
  });
  const say = async (p: OpenAICompatibleProvider, extra: object = {}) => {
    for await (const _ of p.stream({ model: 'm', messages: convo, ...extra })) void _;
    return seen.at(-1)!;
  };
  // A model server marked as on the owner's hardware (LM Studio, vLLM, Ollama on another port).
  const local = new OpenAICompatibleProvider({ id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: `${url}/v1`, local: true });
  const v1 = await say(local);
  assert.equal(v1.url, '/v1/chat/completions');
  assert.deepEqual(v1.roles, ['system', 'user', 'assistant', 'user', 'user']);
  // An Ollama daemon, through its own endpoint.
  noteOllamaDaemon(`${url}/v1`);
  const native = await say(local, { numCtx: 4096 });
  assert.equal(native.url, '/api/chat');
  assert.deepEqual(native.roles, ['system', 'user', 'assistant', 'user', 'user']);
  // A hosted API (not marked local, never seen as an Ollama daemon; its own address): unchanged.
  const other = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}') as { messages?: { role: string }[] };
    seen.push({ url: String(req.url), roles: (body.messages ?? []).map((m) => m.role) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'four' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(() => other.server.close());
  const hosted = new OpenAICompatibleProvider({ id: 'h', label: 'Hosted', kind: 'openai-compatible', baseUrl: `${other.url}/v1` });
  assert.deepEqual((await say(hosted)).roles, ['system', 'system', 'user', 'assistant', 'system', 'user', 'system']);
});
