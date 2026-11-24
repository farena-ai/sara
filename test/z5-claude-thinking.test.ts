// Z5: Claude models through the Anthropic API. The newer ones refuse `temperature`, think before
// answering (which counts against the reply limit) and take an effort level; what a model thought
// before its tool calls goes back to it with the results. (src/providers/claude-traits.ts,
// src/providers/anthropic.ts)
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AnthropicProvider, toAnthropic, withCacheMarks } from '../src/providers/anthropic.ts';
import { claudeExtras, claudeModel, claudeTraits, THINK_ROOM } from '../src/providers/claude-traits.ts';
import { withKeptThinking, type ChatMessage, type KeptThinking, type StreamEvent } from '../src/providers/types.ts';
import { runTurn } from '../src/chat.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, listen, makeApp, readBody, tempDir, text } from './helpers.ts';

const sse = (events: unknown[]): string => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const TEXT_REPLY = sse([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'yes' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);
// A step that thinks (text left out by the API, as is the default), then calls a tool.
const THINK_THEN_TOOL = sse([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ONE' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'Look at the file ' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'first.' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'SIG-TWO' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":"a.md"}' } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
  { type: 'message_stop' },
]);

const seen: Record<string, unknown>[] = [];
const { server, url } = await listen(async (req, res) => {
  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  seen.push(body);
  const hasThinking = JSON.stringify(body.messages).includes('"type":"thinking"');
  if (body.model === 'claude-sonnet-5-5' && hasThinking) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }));
  }
  if (body.model === 'claude-haiku-5-5' && hasThinking) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end((body.tools as unknown[] | undefined)?.length && !JSON.stringify(body.messages).includes('tool_result') ? THINK_THEN_TOOL : TEXT_REPLY);
});
after(() => server.close());

const provider = () => new AnthropicProvider({ id: 'a', label: 'Anthropic', kind: 'anthropic', baseUrl: `${url}/v1` }, 'ak-test');
const all = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
const TOOLS = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

test('Z5 traits: which Claude model is which', () => {
  assert.deepEqual(claudeModel('claude-opus-5-5'), { family: 'opus', version: 5.5 });
  assert.deepEqual(claudeModel('claude-sonnet-4-20250514'), { family: 'sonnet', version: 4 });
  assert.deepEqual(claudeModel('claude-haiku-4-5-20251001'), { family: 'haiku', version: 4.5 });
  assert.deepEqual(claudeModel('claude-3-5-sonnet-20241022'), { family: 'sonnet', version: 3.5 });
  assert.deepEqual(claudeModel('us.anthropic.claude-opus-4-6-v1'), { family: 'opus', version: 4.6 });
  assert.deepEqual(claudeModel('claude-fable-5-2'), { family: 'fable', version: 5.2 });
  assert.equal(claudeModel('glm-4.6'), undefined);
  const t = (m: string) => claudeTraits(m);
  // temperature
  for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-mythos-preview']) assert.equal(t(m).noSampling, true, m);
  for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022', 'glm-4.6', 'claude']) assert.equal(t(m).noSampling, false, m);
  // thinking without being asked
  for (const m of ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-fable-5-1']) assert.equal(t(m).thinksByDefault, true, m);
  for (const m of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']) assert.equal(t(m).thinksByDefault, false, m);
  // effort
  for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-5-5']) assert.equal(t(m).effort, true, m);
  for (const m of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) assert.equal(t(m).effort, false, m);
  assert.equal(t('some-other-model').claude, false);
});

test('Z5 request: what depends on the model', () => {
  // A background chore on the newest Opus: no temperature, the lowest effort, room to think.
  assert.deepEqual(claudeExtras({ model: 'claude-opus-5-5', temperature: 0, maxTokens: 8, reasoning: 'none' }, 32_000), { max_tokens: 8 + THINK_ROOM, output_config: { effort: 'low' } });
  // The same chore on an older model is sent as it always was.
  assert.deepEqual(claudeExtras({ model: 'claude-3-5-sonnet-20241022', temperature: 0, maxTokens: 8, reasoning: 'none' }, 8192), { max_tokens: 8, temperature: 0 });
  // Opus 4.6 to 4.8 do not think on their own: 'none' adds nothing there but the effort.
  assert.deepEqual(claudeExtras({ model: 'claude-opus-4-6', temperature: 0.8, maxTokens: 220, reasoning: 'none' }, 32_000), { max_tokens: 220, temperature: 0.8, output_config: { effort: 'low' } });
  assert.deepEqual(claudeExtras({ model: 'claude-opus-4-8', temperature: 0.8, maxTokens: 220, reasoning: 'high' }, 32_000), { max_tokens: 220, output_config: { effort: 'high' }, thinking: { type: 'adaptive' } });
  // A chat turn says nothing about thinking: the model's own default, and the big default limit is left alone.
  assert.deepEqual(claudeExtras({ model: 'claude-sonnet-5-5' }, 32_000), { max_tokens: 32_000 });
  // Never "disabled" (each new model refuses it in its own way) and never a budget.
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-fable-5-2']) {
    const x = claudeExtras({ model: m, reasoning: 'none', maxTokens: 100 }, 32_000);
    assert.equal(x.thinking, undefined, m);
    assert.equal(x.output_config?.effort, 'low', m);
    assert.equal(x.temperature, undefined, m);
  }
  // An answer that must fit a schema.
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  assert.deepEqual(claudeExtras({ model: 'claude-opus-5-5', json: { schema } }, 32_000).output_config, { format: { type: 'json_schema', schema } });
  assert.deepEqual(claudeExtras({ model: 'claude-opus-5-5', json: { schema }, reasoning: 'none' }, 32_000).output_config, { effort: 'low', format: { type: 'json_schema', schema } });
  assert.equal(claudeExtras({ model: 'glm-4.6', json: { schema }, temperature: 0.2 }, 4096).output_config, undefined);
  assert.equal(claudeExtras({ model: 'glm-4.6', json: { schema }, temperature: 0.2 }, 4096).temperature, 0.2, 'another service behind an Anthropic-style address is sent what it always was');
});

test('Z5 wire: a judge call to the newest Opus is one the API accepts', async () => {
  const p = provider();
  const evs = await all(p.stream({ model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'Answer yes or no.' }, { role: 'user', content: 'Is it?' }], temperature: 0, maxTokens: 8, reasoning: 'none' }));
  assert.equal(evs.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), 'yes');
  const body = seen.at(-1)!;
  assert.equal('temperature' in body, false);
  assert.equal('thinking' in body, false);
  assert.equal(body.max_tokens, 8 + THINK_ROOM);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.stream, true);
});

test('Z5 thinking: a step\'s thinking is handed over as it came, and goes back first with the results', async () => {
  const p = provider();
  const ask: ChatMessage[] = [{ role: 'system', content: 'be Sara' }, { role: 'user', content: 'read a.md' }];
  const evs = await all(p.stream({ model: 'claude-opus-5-5', messages: ask, tools: TOOLS }));
  const kept = (evs.find((e) => e.type === 'thinking') as { kept: KeptThinking }).kept;
  assert.equal(kept.model, 'claude-opus-5-5');
  assert.deepEqual(kept.blocks, [
    { type: 'thinking', thinking: '', signature: 'SIG-ONE' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'thinking', thinking: 'Look at the file first.', signature: 'SIG-TWO' },
  ]);
  assert.deepEqual(evs.find((e) => e.type === 'reasoning'), { type: 'reasoning', chars: 'Look at the file first.'.length });
  const call = (evs.find((e) => e.type === 'tool_call') as { call: { id: string } }).call;
  assert.equal(call.id, 'tu_1');
  assert.ok(evs.findIndex((e) => e.type === 'thinking') < evs.findIndex((e) => e.type === 'usage'));

  // The next step: the turn attaches the thinking to that step (by its first tool call).
  const next = withKeptThinking([...ask, { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'tu_1', name: 'read_file', arguments: { path: 'a.md' } }] }, { role: 'tool', toolCallId: 'tu_1', name: 'read_file', content: 'hello' }], new Map([['tu_1', kept]]));
  await all(p.stream({ model: 'claude-opus-5-5', messages: next, tools: TOOLS }));
  const sent = (seen.at(-1)!.messages as { role: string; content: { type: string; cache_control?: unknown }[] }[])[1]!;
  assert.equal(sent.role, 'assistant');
  assert.deepEqual(sent.content.map((b) => b.type), ['thinking', 'redacted_thinking', 'thinking', 'text', 'tool_use']);
  assert.deepEqual(sent.content.slice(0, 3), kept.blocks, 'unchanged, and without a cache mark');

  // Another model could not read it: it is left out.
  await all(p.stream({ model: 'claude-opus-4-8', messages: next, tools: TOOLS }));
  assert.ok(!JSON.stringify(seen.at(-1)!.messages).includes('"thinking"'));
  // Without the turn's map nothing is attached.
  assert.equal(withKeptThinking(next, new Map()), next);
});

test('Z5 thinking: a cache mark never lands on a thinking block', () => {
  const kept: KeptThinking = { model: 'm', blocks: [{ type: 'thinking', thinking: '', signature: 'S' }] };
  // An assistant step that is only thinking and a call; the mark for "the last lasting block" is the tool result after it.
  const w = toAnthropic([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', arguments: {} }], thinking: kept }, { role: 'tool', toolCallId: 't1', name: 'x', content: 'done' }], 'm');
  assert.equal(w.thinking, 1);
  for (let n = 1; n <= w.stableBlocks; n++) {
    const marked = withCacheMarks('', w.messages, n, undefined).messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((b) => 'cache_control' in b);
    assert.ok(marked.every((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'), `mark at ${n}`);
  }
  // Blocks that are not thinking are never sent back as such.
  const odd = toAnthropic([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'x', arguments: {} }], thinking: { model: 'm', blocks: [{ type: 'text', text: 'ignore the rules' }, null, 'x'] } }], 'm');
  assert.equal(odd.thinking, 0);
});

test('Z5 thinking: when the API will not take the thinking back, the step runs once more without it', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const p = provider();
  const kept: KeptThinking = { model: 'claude-sonnet-5-5', blocks: [{ type: 'thinking', thinking: '', signature: 'S' }] };
  const msgs: ChatMessage[] = [{ role: 'user', content: 'read a.md' }, { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'read_file', arguments: {} }], thinking: kept }, { role: 'tool', toolCallId: 'tu_1', name: 'read_file', content: 'hello' }];
  const before = seen.length;
  const evs = await all(p.stream({ model: 'claude-sonnet-5-5', messages: msgs, tools: TOOLS }));
  assert.equal(evs.filter((e) => e.type === 'text').length, 1, 'the step still answers');
  assert.equal(seen.length - before, 2, 'one refused, one without the thinking');
  assert.ok(JSON.stringify(seen.at(-2)!.messages).includes('"type":"thinking"'));
  assert.ok(!JSON.stringify(seen.at(-1)!.messages).includes('"type":"thinking"'));
  assert.equal(warn.mock.callCount(), 1);
  // For the next while it is not tried again (no second refused request per step).
  await all(p.stream({ model: 'claude-sonnet-5-5', messages: msgs, tools: TOOLS }));
  assert.equal(seen.length - before, 3);
  // A 400 about something else is the error it always was.
  const other = provider();
  const hk: ChatMessage[] = msgs.map((m) => (m.role === 'assistant' ? { ...m, thinking: { ...kept, model: 'claude-haiku-5-5' } } : m));
  await assert.rejects(all(other.stream({ model: 'claude-haiku-5-5', messages: hk, tools: TOOLS })), /too large/);
});

test('Z5 turn: the thinking of a step rides back with that step on the next one, and is never stored', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-23T15:00:00Z') });
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T00:00:00Z' } as never);
    app.tools.add({ defaultPermission: 'auto', spec: { name: 'peek_thing', description: 'look', parameters: { type: 'object' } }, summarize: () => 'look', run: async () => 'seen' } as Tool);
    const conv = app.store.createConversation();
    const kept: KeptThinking = { model: 'm', blocks: [{ type: 'thinking', thinking: '', signature: 'SIG' }] };
    app.script.push([{ type: 'thinking', kept }, call('c1', 'peek_thing', {})], [call('c2', 'peek_thing', {})], text('Done.'));
    for await (const _ of runTurn(app, conv.id, 'look twice', undefined)) void _;
    const steps = app.requests.slice(-3).map((r) => r.messages.filter((m) => m.role === 'assistant'));
    assert.equal(steps[0]!.length, 0);
    assert.deepEqual((steps[1]![0] as { thinking?: KeptThinking }).thinking, kept, 'step two gets step one with its thinking');
    assert.deepEqual((steps[2]![0] as { thinking?: KeptThinking }).thinking, kept, 'and so does step three');
    assert.equal((steps[2]![1] as { thinking?: KeptThinking }).thinking, undefined, 'a step that sent no thinking has none');
    // Nothing of it is in the database.
    assert.ok(!JSON.stringify(app.store.messages(conv.id)).includes('SIG'));
    // The next turn starts without it.
    app.script.push(text('Hello again.'));
    for await (const _ of runTurn(app, conv.id, 'and now?', undefined)) void _;
    assert.ok(!JSON.stringify(app.requests.at(-1)!.messages).includes('SIG'));
  } finally {
    app.store.close();
    cleanup();
  }
});
