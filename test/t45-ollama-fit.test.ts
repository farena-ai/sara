// T45: a call to Ollama on the owner's hardware must fit the context it asks for (owner report,
// 2026-11-24: "request (20776 tokens) exceeds the available context size (8192 tokens)", and replies
// cut off because a 32,768 context was full of her instructions, the tools and the history).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteOllamaDaemon, resetDaemonHardware } from '../src/model-context.ts';
import { fitOllamaCall, OLLAMA_FIT, OpenAICompatibleProvider, resetOllamaContext, resetOllamaFit } from '../src/providers/openai-compatible.ts';
import type { ChatMessage } from '../src/providers/types.ts';
import { listen, readBody } from './helpers.ts';

const text = (tokens: number): string => 'x'.repeat(tokens * OLLAMA_FIT.charsPerToken);
/** Her instructions, then `turns` exchanges of about `each` tokens a message, then a new message. */
function convo(systemTokens: number, turns: number, each: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: text(systemTokens) }];
  for (let i = 0; i < turns; i++) out.push({ role: 'user', content: `u${i} ${text(each)}` }, { role: 'assistant', content: `a${i} ${text(each)}` });
  out.push({ role: 'user', content: 'and now?' });
  return out;
}

test('T45 fit: a call that fits is sent as it is', () => {
  const m = convo(2_000, 4, 200);
  const fit = fitOllamaCall(m, 3_000, 32_768);
  assert.equal(fit.messages, m);
  assert.equal(fit.numCtx, 32_768);
  assert.equal(fit.dropped, 0);
});

test('T45 fit: her instructions and the tools alone do not fit: the context is raised, never refused', () => {
  // The owner's case: about 17,000 tokens before any history, sized 8,192 because the card was not known yet.
  const m = convo(12_000, 6, 300);
  const fit = fitOllamaCall(m, 5_000 * OLLAMA_FIT.charsPerToken, 8_192);
  assert.equal(fit.numCtx, 32_768, 'the next step up that holds it, with a reply and some history');
  assert.equal(fit.dropped, 0);
});

test('T45 fit: a full context: the oldest exchanges are left out so the reply has room', () => {
  const m = convo(12_000, 40, 500);
  const fit = fitOllamaCall(m, 5_000 * OLLAMA_FIT.charsPerToken, 32_768);
  assert.equal(fit.numCtx, 32_768, 'history alone never raises the context past what was asked');
  assert.ok(fit.dropped > 0 && fit.dropped % 2 === 0, 'whole exchanges');
  assert.equal(fit.messages[0], m[0], 'her instructions stay');
  assert.equal(fit.messages[1]!.role, 'user', 'and the history starts with the person');
  assert.equal(fit.messages.at(-1), m.at(-1), 'the newest message stays');
  const tokens = fit.messages.reduce((n, x) => n + Math.ceil(x.content.length / OLLAMA_FIT.charsPerToken) + OLLAMA_FIT.perMessage, 0) + 5_000;
  assert.ok(tokens + 4_096 <= 32_768, `room for a reply (${tokens})`);
  assert.ok(tokens > 24_000, 'and no more is dropped than needed');
});

test('T45 fit: a tool call is never separated from its result; the newest turn is never touched', () => {
  const m: ChatMessage[] = [
    { role: 'system', content: text(1_000) },
    { role: 'user', content: text(6_000) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'note', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'note', content: text(3_000) },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'note', arguments: {} }] },
    { role: 'tool', toolCallId: 'c2', name: 'note', content: text(6_000) },
  ];
  const fit = fitOllamaCall(m, 0, 16_384);
  assert.deepEqual(fit.messages.map((x) => x.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(fit.dropped, 4);
  // More than even the raised context holds: sent as far as it can be cut, at the largest size.
  const huge = fitOllamaCall([{ role: 'system', content: text(90_000) }, { role: 'user', content: 'hi' }], 0, 8_192);
  assert.equal(huge.numCtx, OLLAMA_FIT.raiseTo);
  assert.equal(huge.dropped, 0);
});

test('T45 fit: a model that makes more tokens of a character is given more room', () => {
  const m = convo(6_000, 20, 400);
  const plain = fitOllamaCall(m, 0, 32_768);
  const dense = fitOllamaCall(m, 0, 32_768, { tokensPerChar: 0.6 });
  assert.equal(plain.dropped, 0);
  assert.ok(dense.dropped > 0);
  assert.equal(fitOllamaCall(m, 0, 32_768, { tokensPerChar: 0.1 }).dropped, 0, 'never sized looser than the default');
});

test('T45 on the wire: the call carries the raised context and the trimmed history, and keeps the raise', async (t) => {
  resetOllamaContext();
  resetOllamaFit();
  resetDaemonHardware();
  const seen: { ctx: number; messages: number }[] = [];
  const { server, url } = await listen(async (req, res) => {
    if (req.url === '/api/chat') {
      const body = JSON.parse((await readBody(req)) || '{}') as { messages: unknown[]; options: { num_ctx: number } };
      seen.push({ ctx: body.options.num_ctx, messages: body.messages.length });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return void res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, prompt_eval_count: 900 })}\n`);
    }
    if (req.url === '/api/ps') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [] }));
    res.writeHead(404).end('not found');
  });
  t.after(() => {
    server.close();
    resetOllamaContext();
    resetOllamaFit();
    resetDaemonHardware();
  });
  noteOllamaDaemon(`${url}/v1`);
  const p = new OpenAICompatibleProvider({ id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: `${url}/v1`, local: true });
  const say = async (messages: ChatMessage[], numCtx: number) => {
    for await (const _ of p.stream({ model: 'm', messages, numCtx })) void _;
    return seen.at(-1)!;
  };
  const big = convo(12_000, 60, 500);
  const first = await say(big, 8_192);
  assert.equal(first.ctx, 32_768, 'raised to hold her instructions');
  assert.ok(first.messages < big.length, 'and the oldest exchanges left out');
  const small = await say(convo(500, 1, 50), 8_192);
  assert.equal(small.ctx, 32_768, 'the raise is kept, so the model is not loaded again for a small call');
  assert.equal(small.messages, 4);
});
