import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { createProvider, PROVIDER_PRESETS, validateProviderConfig } from '../src/providers/registry.ts';
import { SUBSCRIPTION_KINDS, errorDetail, friendlyHttpError, isToolsUnsupported, ProviderError, type StreamEvent } from '../src/providers/types.ts';
import { collectText, listen, readBody } from './helpers.ts';

const seen: { path: string; headers: Record<string, unknown>; body: string }[] = [];
const { server, url } = await listen(async (req, res) => {
  const body = await readBody(req);
  seen.push({ path: req.url ?? '', headers: req.headers, body });
  if (req.url === '/v1/models' || req.url === '/v1/models?limit=100') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }] }));
  }
  if (req.url === '/v1/chat/completions') {
    const model = JSON.parse(body).model;
    if (model === 'bad') {
      res.writeHead(401);
      return res.end('{"error":"nope"}');
    }
    if (model === 'no-tools') {
      res.writeHead(400);
      return res.end('{"error":{"message":"registry.ollama.ai/library/x does not support tools"}}');
    }
    if (model === 'bigwrite') {
      // A long write_file call streamed in 1 KB pieces.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"w1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"big.md\\",\\"content\\":\\""}}]}}]}\n\n');
      for (let i = 0; i < 5; i++) res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${'x'.repeat(1024)}"}}]}}]}\n\n`);
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    if (model === 'tools') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Checking."}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"list_dir","arguments":"{}"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    return res.end('data: [DONE]\n\n');
  }
  if (req.url === '/v1/messages' && JSON.parse(body).model === 'tools') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On it."}}\n\n');
    res.write('data: {"type":"content_block_stop","index":0}\n\n');
    res.write('data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"shell","input":{}}}\n\n');
    res.write('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"ls"}}\n\n');
    res.write('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" -la\\"}"}}\n\n');
    res.write('data: {"type":"content_block_stop","index":1}\n\n');
    return res.end('data: {"type":"message_stop"}\n\n');
  }
  if (req.url === '/v1/messages') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi "}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"there"}}\n\n');
    return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  }
  res.writeHead(404);
  res.end();
});
after(() => server.close());

async function collect(it: AsyncIterable<StreamEvent>): Promise<string> {
  let s = '';
  for await (const t of it) if (t.type === 'text') s += t.text;
  return s;
}

const base = { label: 'Test', baseUrl: `${url}/v1/` };

test('OpenAI-compatible: streams text and sends bearer key', async () => {
  const p = new OpenAICompatibleProvider({ id: 'o', kind: 'openai-compatible', ...base }, 'sk-test');
  const text = await collect(p.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }));
  assert.equal(text, 'Hello');
  const req = seen.at(-1)!;
  assert.equal(req.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(req.body), { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true }, max_tokens: 50 });
});

test('OpenAI-compatible: no key means no auth header (local Ollama)', async () => {
  const p = new OpenAICompatibleProvider({ id: 'o', kind: 'openai-compatible', ...base });
  assert.deepEqual(await p.listModels(), ['a-model', 'b-model']);
  assert.equal(seen.at(-1)!.headers.authorization, undefined);
});

test('OpenAI-compatible: HTTP errors become ProviderError with status', async () => {
  const p = new OpenAICompatibleProvider({ id: 'o', kind: 'openai-compatible', ...base });
  await assert.rejects(collect(p.stream({ model: 'bad', messages: [] })), (e: unknown) => e instanceof ProviderError && e.status === 401);
});

test('Anthropic: moves system prompt out of messages and streams text deltas', async () => {
  const p = new AnthropicProvider({ id: 'a', kind: 'anthropic', ...base }, 'ak-test');
  const text = await collect(
    p.stream({ model: 'claude', messages: [{ role: 'system', content: 'be Sara' }, { role: 'user', content: 'hi' }] }),
  );
  assert.equal(text, 'Hi there');
  const req = seen.at(-1)!;
  assert.equal(req.headers['x-api-key'], 'ak-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(req.body);
  // X1: the system prompt and the last lasting block carry a cache mark; the default reply limit is the model's own.
  assert.deepEqual(body.system, [{ type: 'text', text: 'be Sara', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);
  assert.equal(body.max_tokens, 32_000);
  assert.deepEqual(await p.listModels(), ['a-model', 'b-model']);
});

const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

test('OpenAI-compatible: assembles streamed tool calls and sends tools + tool history in OpenAI format', async () => {
  const p = new OpenAICompatibleProvider({ id: 'o', kind: 'openai-compatible', ...base });
  const out = await collectText(
    p.stream({
      model: 'tools',
      tools,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'list_dir', arguments: { path: '.' } }] },
        { role: 'tool', toolCallId: 'c0', name: 'list_dir', content: 'a.txt' },
      ],
    }),
  );
  assert.equal(out.text, 'Checking.');
  assert.deepEqual(out.calls.filter((e) => e.type !== 'tool_delta'), [
    { type: 'tool_call', call: { id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } } },
    { type: 'tool_call', call: { id: 'call_2', name: 'list_dir', arguments: {} } },
  ]);
  const body = JSON.parse(seen.at(-1)!.body);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'read_file');
  assert.deepEqual(body.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] });
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'c0', content: 'a.txt' });
});

test('OpenAI-compatible: "does not support tools" is recognisable', async () => {
  const p = new OpenAICompatibleProvider({ id: 'o', kind: 'openai-compatible', ...base });
  await assert.rejects(collect(p.stream({ model: 'no-tools', tools, messages: [] })), (e: unknown) => isToolsUnsupported(e));
});

test('Anthropic: streams tool_use blocks and converts tool results to user tool_result blocks', async () => {
  const p = new AnthropicProvider({ id: 'a', kind: 'anthropic', ...base }, 'ak');
  const out = await collectText(
    p.stream({
      model: 'tools',
      tools,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'ok', toolCalls: [{ id: 't1', name: 'a', arguments: {} }, { id: 't2', name: 'b', arguments: { x: 1 } }] },
        { role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
        { role: 'tool', toolCallId: 't2', name: 'b', content: 'r2' },
      ],
    }),
  );
  assert.equal(out.text, 'On it.');
  assert.deepEqual(out.calls.filter((e) => e.type !== 'tool_delta'), [{ type: 'tool_call', call: { id: 'toolu_1', name: 'shell', arguments: { command: 'ls -la' } } }]);
  const body = JSON.parse(seen.at(-1)!.body);
  assert.deepEqual(body.tools[0], { name: 'read_file', description: 'read', input_schema: tools[0].parameters, cache_control: { type: 'ephemeral' } });
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'ok' },
    { type: 'tool_use', id: 't1', name: 'a', input: {} },
    { type: 'tool_use', id: 't2', name: 'b', input: { x: 1 } },
  ]);
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 't2', content: 'r2', cache_control: { type: 'ephemeral' } },
    ],
  });
});

test('registry: presets carry no credentials and build the right adapters', () => {
  for (const p of PROVIDER_PRESETS) {
    const fields = Object.keys(p).filter((k) => k !== 'needsKey');
    assert.ok(!fields.some((k) => /key|token|secret|password/i.test(k)), `${p.id} preset must not carry credential fields`);
    assert.ok(!/sk-|xai-|Bearer /.test(JSON.stringify(p)), `${p.id} preset must not carry credential values`);
    if (SUBSCRIPTION_KINDS.includes(p.kind)) {
      assert.throws(() => createProvider(p), /subscription service/);
      continue;
    }
    const inst = createProvider(p);
    assert.ok(p.kind === 'anthropic' ? inst instanceof AnthropicProvider : inst instanceof OpenAICompatibleProvider);
  }
});

test('registry: validates provider config input', () => {
  assert.throws(() => validateProviderConfig({ id: 'Bad Id', kind: 'anthropic', baseUrl: 'https://x' }));
  assert.throws(() => validateProviderConfig({ id: 'ok', kind: 'other', baseUrl: 'https://x' }));
  assert.throws(() => validateProviderConfig({ id: 'ok', kind: 'anthropic', baseUrl: 'file:///etc/passwd' }));
  assert.deepEqual(validateProviderConfig({ id: 'ok', kind: 'anthropic', baseUrl: 'https://x', apiKey: 'sk' }), {
    id: 'ok',
    kind: 'anthropic',
    baseUrl: 'https://x',
    label: 'ok',
    local: false,
    needsKey: false,
  });
});

test('old provider names are renamed to say where they run', async () => {
  const { migrateProviderLabels } = await import('../src/settings.ts');
  const out = migrateProviderLabels({ providers: [{ id: 'ollama-local', label: 'Ollama (this server)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }, { id: 'x', label: 'Mine', kind: 'anthropic', baseUrl: 'https://x' }] } as never);
  assert.deepEqual(out?.providers.map((p) => p.label), ['Ollama on the server', 'Mine']);
  assert.equal(migrateProviderLabels({ providers: [{ id: 'x', label: 'Mine', kind: 'anthropic', baseUrl: 'https://x' }] } as never), undefined);
});

test('an unreachable provider gives a plain message naming it', async () => {
  const { OpenAICompatibleProvider } = await import('../src/providers/openai-compatible.ts');
  const p = new OpenAICompatibleProvider({ id: 'ollama-pc', label: 'Ollama on my PC', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' });
  await assert.rejects(p.listModels(), /Couldn't reach Ollama on my PC at 127\.0\.0\.1:9\. Is that computer on/);
});

test('openai-compatible: long tool calls report progress before the call arrives', async () => {
  const p = new OpenAICompatibleProvider({ id: 'x', label: 'X', kind: 'openai-compatible', baseUrl: `${url}/v1` });
  const events: StreamEvent[] = [];
  for await (const ev of p.stream({ model: 'bigwrite', messages: [{ role: 'user', content: 'write it' }] })) events.push(ev);
  const progress = events.filter((e) => e.type === 'tool_progress');
  assert.deepEqual(progress.map((e) => (e as { chars: number }).chars > 0 && (e as { name: string }).name), ['write_file', 'write_file']);
  const last = events.at(-1)!;
  assert.equal(last.type, 'tool_call');
  assert.equal(String((last as Extract<StreamEvent, { type: 'tool_call' }>).call.arguments.content).length, 5 * 1024);
});

test('providers: errors a beginner hits are plain sentences with what to do, plus the provider\'s own words', () => {
  const openai = errorDetail('{"error":{"message":"Incorrect API key provided: sk-wro***00.","type":"invalid_request_error","code":"invalid_api_key"}}');
  assert.equal(openai, 'Incorrect API key provided: sk-wro***00.');
  assert.equal(friendlyHttpError('OpenAI', 401, openai), "OpenAI didn't accept the key or sign-in. Check it in Settings → Models & usage → OpenAI. (OpenAI said: Incorrect API key provided: sk-wro***00.)");
  const ollama = errorDetail('{"error":{"message":"model \'qwen9:7b\' not found","type":"not_found_error"}}');
  assert.match(friendlyHttpError('Ollama on my computer', 404, ollama, 'qwen9:7b'), /^Ollama on my computer doesn't have the model "qwen9:7b"\. Pick another one in Settings → Models & usage, or download it with: ollama pull qwen9:7b\./);
  assert.match(friendlyHttpError('OpenRouter', 429, 'Rate limit exceeded'), /busy or the usage limit is reached/);
  assert.match(friendlyHttpError('OpenAI', 429, 'You exceeded your current quota'), /busy or the usage limit/);
  assert.match(friendlyHttpError('xAI', 402, ''), /needs credit or a paid plan/);
  assert.match(friendlyHttpError('Anthropic', 529, errorDetail('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')), /problem on its side \(HTTP 529\)\. Try again in a minute\. \(Anthropic said: Overloaded\)/);
  assert.equal(errorDetail('<html><body>502 Bad Gateway</body></html>'), '');
  // Tool refusals keep the provider's words, so the no-tools retry still recognises them.
  assert.ok(isToolsUnsupported(new ProviderError(friendlyHttpError('Ollama', 400, errorDetail('{"error":{"message":"model does not support tools"}}')), 400)));
});
