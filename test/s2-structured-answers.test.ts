// S2 (docs/ROADMAP_AFTER_3.40.md, stage 2): an answer that must fit a JSON Schema (ChatRequest.json)
// is sent to Ollama on both of its paths and to no other OpenAI-compatible server, and the security
// review is the first judge that asks for one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteOllamaDaemon, resetDaemonHardware } from '../src/model-context.ts';
import { OpenAICompatibleProvider, resetOllamaContext } from '../src/providers/openai-compatible.ts';
import type { ChatRequest, Provider, StreamEvent } from '../src/providers/types.ts';
import { askModel, jsonIn, REVIEW_SCHEMA } from '../src/security/pass.ts';
import { listen, readBody } from './helpers.ts';

async function fakeServer() {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const { server, url } = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/chat') {
      seen.push({ url: req.url, body: JSON.parse(body) as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '{"findings":[]}' }, done: false })}\n`);
      return void res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`);
    }
    if (req.url === '/v1/chat/completions') {
      seen.push({ url: req.url, body: JSON.parse(body) as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' } }] })}\n\n`);
      return void res.end('data: [DONE]\n\n');
    }
    if (req.url === '/api/ps') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [] }));
    res.writeHead(404).end('not found');
  });
  return { seen, url, close: () => server.close() };
}
const said = async (p: Provider, req: Partial<ChatRequest>): Promise<string> => {
  let out = '';
  for await (const ev of p.stream({ model: 'm', messages: [{ role: 'user', content: 'review this' }], ...req })) if (ev.type === 'text') out += ev.text;
  return out;
};
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

test('S2 structured answers: Ollama gets the schema on both paths; another server gets the prompt alone', async (t) => {
  resetOllamaContext();
  resetDaemonHardware();
  const ollama = await fakeServer();
  const other = await fakeServer();
  t.after(() => {
    ollama.close();
    other.close();
    resetOllamaContext();
    resetDaemonHardware();
  });
  noteOllamaDaemon(`${ollama.url}/v1`);
  const o = new OpenAICompatibleProvider({ id: 'o', label: 'Ollama', kind: 'openai-compatible', baseUrl: `${ollama.url}/v1`, local: true });
  // With a context size she goes through /api/chat: `format` is the schema.
  assert.equal(await said(o, { numCtx: 4096, json: { schema } }), '{"findings":[]}');
  const native = ollama.seen.at(-1)!;
  assert.equal(native.url, '/api/chat');
  assert.deepEqual(native.body.format, schema);
  // Without a schema nothing is added.
  await said(o, { numCtx: 4096 });
  assert.equal('format' in ollama.seen.at(-1)!.body, false);
  // The /v1 path of a fresh provider (no context size known): response_format.
  resetOllamaContext();
  await said(o, { json: { schema } });
  const v1 = ollama.seen.at(-1)!;
  assert.equal(v1.url, '/v1/chat/completions');
  assert.deepEqual(v1.body.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema } });
  await said(o, {});
  assert.equal('response_format' in ollama.seen.at(-1)!.body, false);
  // Some other OpenAI-compatible server: what it accepts is unknown, so it is not sent.
  const x = new OpenAICompatibleProvider({ id: 'x', label: 'Other', kind: 'openai-compatible', baseUrl: `${other.url}/v1` });
  await said(x, { json: { schema } });
  assert.equal(other.seen.at(-1)!.url, '/v1/chat/completions');
  assert.equal('response_format' in other.seen.at(-1)!.body, false);
});

test('S2 structured answers: the security review asks for its shape, and still reads a loose answer', async () => {
  const reqs: ChatRequest[] = [];
  const provider = {
    config: { id: 'p', label: 'P', kind: 'openai-compatible' },
    async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
      reqs.push(req);
      yield { type: 'text', text: 'Sure! ```json\n{"findings":[{"file":"a.js","line":3,"quote":"x","rule":"r","severity":"high","title":"t","advice":"a"}]}\n```' };
    },
  } as unknown as Provider;
  const got = await askModel([{ provider, model: 'm' }], [{ role: 'user', content: 'u' }], 200, AbortSignal.timeout(5000), { schema: REVIEW_SCHEMA });
  assert.deepEqual(reqs[0]!.json, { schema: REVIEW_SCHEMA });
  assert.equal(reqs[0]!.reasoning, 'none');
  assert.equal((jsonIn(got.text) as { findings: unknown[] }).findings.length, 1, 'a provider that ignored the schema is still read');
  // No schema asked: none sent (the other judges, until they are moved over one at a time).
  await askModel([{ provider, model: 'm' }], [{ role: 'user', content: 'u' }], 200, AbortSignal.timeout(5000));
  assert.equal(reqs[1]!.json, undefined);
  // The shape is the one the review's prompt describes.
  const item = (REVIEW_SCHEMA.properties as { findings: { items: { required: string[]; additionalProperties: boolean } } }).findings.items;
  assert.deepEqual([...item.required].sort(), ['advice', 'file', 'line', 'quote', 'rule', 'severity', 'title']);
  assert.equal(item.additionalProperties, false);
});
