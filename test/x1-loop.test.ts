// X1: the model-call path is cheaper and sturdier. Prompt caching for Anthropic (and a prompt that
// stays the same between steps for every provider), a real reply limit, retries when a server is
// briefly busy, a stall timeout mid-reply, and tool calls that were cut off never run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cutOffCall, runTurn, StalledModelError, streamWithin, type ChatEvent } from '../src/chat.ts';
import { APP_NOTE, defaultMaxTokens, toAnthropic, withCacheMarks } from '../src/providers/anthropic.ts';
import { toOpenAIMessages } from '../src/providers/openai-compatible.ts';
import { retryable, retryingStream } from '../src/providers/retry.ts';
import { moveClockToEnd } from '../src/time-sense.ts';
import { ProviderError, type ChatMessage } from '../src/providers/types.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const MARK = { cache_control: { type: 'ephemeral' } };

test('X1 caching: late system notes stay in place, so the system prompt and history are the same on the next step', () => {
  const base: ChatMessage[] = [
    { role: 'system', content: 'You are Sara.' },
    { role: 'system', content: 'Project notes.' },
    { role: 'user', content: 'list the files' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'list_files', arguments: {} }] },
    { role: 'tool', toolCallId: 't1', name: 'list_files', content: 'a.txt' },
  ];
  const step1 = toAnthropic([...base, { role: 'system', content: '[Now: Sun, Nov 22, 2026, 3:00 PM]' }]);
  const step2 = toAnthropic([...base, { role: 'system', content: '[Now: Sun, Nov 22, 2026, 3:01 PM]' }]);
  assert.equal(step1.system, 'You are Sara.\n\nProject notes.', 'only the notes before the conversation are the system prompt');
  assert.equal(step1.system, step2.system, 'the clock does not change the system prompt');
  const last = step1.messages.at(-1)!.content as { type: string; text?: string }[];
  assert.deepEqual(last.map((b) => b.type), ['tool_result', 'text']);
  assert.equal(last[1]!.text, `${APP_NOTE}\n[Now: Sun, Nov 22, 2026, 3:00 PM]`);
  assert.equal(step1.stableBlocks, 3, 'user, tool_use, tool_result: what the next step sends again unchanged');
  // The marks: last tool, system prompt, and the last lasting block (not the note after it).
  const tools = [{ name: 'a', description: 'a', input_schema: {} }, { name: 'b', description: 'b', input_schema: {} }];
  const c1 = withCacheMarks(step1.system, step1.messages, step1.stableBlocks, tools);
  const c2 = withCacheMarks(step2.system, step2.messages, step2.stableBlocks, tools);
  assert.deepEqual(c1.system, [{ type: 'text', text: step1.system, ...MARK }]);
  assert.deepEqual(c1.tools, [tools[0], { ...tools[1], ...MARK }]);
  const tail = c1.messages.at(-1)!.content as Record<string, unknown>[];
  assert.deepEqual(tail[0]!.cache_control, MARK.cache_control, 'the tool result is marked');
  assert.equal(tail[1]!.cache_control, undefined, 'the per-step note is not');
  // Everything up to and including the marked block is byte-identical between the two steps.
  const upTo = (c: typeof c1) => JSON.stringify([c.tools, c.system, c.messages.slice(0, -1), (c.messages.at(-1)!.content as unknown[])[0]]);
  assert.equal(upTo(c1), upTo(c2));
  assert.equal(JSON.stringify(c1).split('cache_control').length - 1, 3, 'three marks (the API allows four)');
});

test('X1 caching: a plain chat (no tools, text only) is marked too, and an empty request is left alone', () => {
  const w = toAnthropic([{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]);
  const c = withCacheMarks(w.system, w.messages, w.stableBlocks, undefined);
  assert.deepEqual(c.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi', ...MARK }] }]);
  assert.equal(c.tools, undefined);
  const none = toAnthropic([]);
  assert.deepEqual(withCacheMarks(none.system, none.messages, none.stableBlocks, []), { messages: [] });
});

test('X1 reply limit: current models get room for a long file; the old ones keep their real ceiling', () => {
  assert.equal(defaultMaxTokens('claude-opus-5-5'), 32_000);
  assert.equal(defaultMaxTokens('claude-sonnet-4-6'), 32_000);
  assert.equal(defaultMaxTokens('claude-3-5-sonnet-20241022'), 8192);
  assert.equal(defaultMaxTokens('claude-3-haiku-20240307'), 4096);
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test('X1 retries: a busy server gets two more tries before the first word; other errors and started replies do not', async () => {
  assert.equal(retryable(new ProviderError('busy', 429)), true);
  assert.equal(retryable(new ProviderError('overloaded', 529)), true);
  assert.equal(retryable(new ProviderError('bad key', 401)), false);
  assert.equal(retryable(new ProviderError('bad request', 400)), false);
  assert.equal(retryable(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  const fast = { baseMs: 1, maxMs: 2 };
  let n = 0;
  const flaky = async function* () {
    if (++n < 3) throw new ProviderError('busy', 503);
    yield 'hello';
  };
  const retries: number[] = [];
  assert.deepEqual(await collect(retryingStream(flaky, undefined, { ...fast, onRetry: (_e, a) => retries.push(a) })), ['hello']);
  assert.deepEqual(retries, [1, 2]);
  n = -10;
  await assert.rejects(collect(retryingStream(flaky, undefined, fast)), /busy/, 'gives up after two retries');
  assert.equal(n, -7, 'three tries in all');
  let m = 0;
  const midway = async function* () {
    m++;
    yield 'par';
    throw new ProviderError('busy', 503);
  };
  await assert.rejects(collect(retryingStream(midway, undefined, fast)), /busy/);
  assert.equal(m, 1, 'never started again once part of the reply arrived');
  let k = 0;
  await assert.rejects(collect(retryingStream(async function* () { k++; throw new ProviderError('no', 401); }, undefined, fast)), /no/);
  assert.equal(k, 1);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  let a = 0;
  await assert.rejects(collect(retryingStream(async function* () { a++; throw new ProviderError('busy', 503); }, stop.signal, fast)));
  assert.equal(a, 1, 'a stopped turn is not retried');
});

test('X1 stall: a reply that starts and then goes silent is given up (it used to hang until Stop)', async () => {
  const hang = (signal: AbortSignal) =>
    (async function* () {
      yield 'first';
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    })();
  const got: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const x of streamWithin(hang, undefined, 5000, 40)) got.push(x);
    })(),
    (e: unknown) => e instanceof StalledModelError,
  );
  assert.deepEqual(got, ['first']);
  // A steady stream is untouched, and so is everything when no idle limit is given.
  const steady = () => (async function* () { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 5)); yield i; } })();
  assert.deepEqual(await collect(streamWithin(steady, undefined, 5000, 200)), [0, 1, 2, 3, 4]);
  assert.deepEqual(await collect(streamWithin(steady, undefined, 5000)), [0, 1, 2, 3, 4]);
});

test('X1 cut-off calls: a tool call whose arguments never finished does not run and shows no card; she is told to send it again', async () => {
  assert.equal(cutOffCall({ _raw: '{"path":"a' }), '{"path":"a');
  assert.equal(cutOffCall({ path: 'a' }), undefined);
  assert.equal(cutOffCall({ _raw: 'x', other: 1 }), undefined, 'a real argument named _raw is not mistaken for it');
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-22T15:00:00Z') });
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T15:00:00Z' } as never);
    let ran = 0;
    app.tools.add({ defaultPermission: 'ask', changes: true, spec: { name: 'save_thing', description: 'save', parameters: { type: 'object' } }, summarize: () => 'save it', run: async () => { ran++; return 'saved'; } } as Tool);
    const conv = app.store.createConversation();
    app.script.push([call('c1', 'save_thing', { _raw: '{"text":"a very long text that was cu' })], text('Sorry, sending it again in parts.'));
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(app, conv.id, 'save this long text', undefined)) {
      evs.push(ev);
      if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true);
    }
    assert.equal(ran, 0, 'never run');
    assert.equal(evs.filter((e) => e.type === 'approval').length, 0, 'no card for a broken call');
    const res = evs.find((e) => e.type === 'tool_result') as { status: string; output: string };
    assert.equal(res.status, 'error');
    assert.match(res.output, /Not run: the arguments of this save_thing call .*Send the call again/);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('X1 clock: for Claude models the time line follows the conversation on the wire, so the instructions stay the same between steps', async () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-22T15:00:00Z') };
  const app = makeApp(dir, clock);
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: '2026-11-22T15:00:00Z' } as never);
    const conv = app.store.createConversation();
    app.script.push(text('Hi.'));
    for await (const _ of runTurn(app, conv.id, 'hello', undefined)) void _;
    const asked = app.requests.at(-1)!.messages;
    assert.match(asked[0]!.content, /\n\n\[Now: [^\n]*2026[^\n]*\]$/, 'her instructions still end with the clock line (W0.6)');
    // On the wire to Claude models the line follows the conversation.
    for (const sent of [moveClockToEnd(asked)]) {
      assert.doesNotMatch(String(sent[0]!.content), /\[Now: /, 'the first message carries no clock line');
      assert.equal(sent.at(-1)!.role, 'system');
      assert.match(String(sent.at(-1)!.content), /^\[Now: .*2026/);
      assert.equal(sent.length, asked.length + 1);
    }
    const a = toAnthropic(asked);
    assert.doesNotMatch(a.system, /\[Now: /);
    assert.match(JSON.stringify(a.messages.at(-1)), /Note from the app, not from the person\]\\n\[Now: /);
    // OpenAI-style servers get it where it was (a last system line is not safe with every local template).
    const open = toOpenAIMessages(asked) as { role: string; content: string }[];
    assert.match(String(open[0]!.content), /\[Now: /);
    assert.equal(open.length, asked.length);
    const plain = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
    assert.equal(moveClockToEnd(plain), plain);
  } finally {
    app.store.close();
    cleanup();
  }
});
