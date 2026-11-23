// Y6: read-only tool calls of one step run at the same time (src/parallel-calls.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { PARALLEL_READS, runsTogether, runTogether } from '../src/parallel-calls.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Y6 together: which steps run their calls at once', () => {
  assert.equal(runsTogether([{ name: 'web_fetch' }, { name: 'web_search' }, { name: 'read_file' }]), true);
  assert.equal(runsTogether([{ name: 'web_fetch' }]), false, 'one call has nothing to run beside');
  assert.equal(runsTogether([{ name: 'web_fetch' }, { name: 'write_file' }]), false, 'a call that changes something keeps the whole step in order');
  assert.equal(runsTogether([{ name: 'read_file' }, { name: 'pc_run' }]), false);
  assert.equal(runsTogether([]), false);
  for (const n of ['write_file', 'run_command', 'pc_run', 'mail_send', 'note', 'ask_choice', 'browser_open']) assert.equal(PARALLEL_READS.has(n), false, n);
});

test('Y6 together: events come as they happen, results in the order of the calls, at most four at a time', async () => {
  let running = 0;
  let most = 0;
  const gen = async function* (i: number, ms: number): AsyncGenerator<string, number> {
    running++;
    most = Math.max(most, running);
    yield `start ${i}`;
    await wait(ms);
    yield `end ${i}`;
    running--;
    return i * 10;
  };
  const times = [40, 5, 20, 5, 5, 5];
  const seen: string[] = [];
  const it = runTogether(times.length, (i) => gen(i, times[i]!));
  let step = await it.next();
  while (!step.done) {
    seen.push(step.value);
    step = await it.next();
  }
  assert.deepEqual(step.value, [0, 10, 20, 30, 40, 50], 'results are in call order whatever finished first');
  assert.equal(most, 4, 'four at a time');
  assert.ok(seen.indexOf('end 1') < seen.indexOf('end 0'), 'a quick call does not wait for a slow one before it');
  assert.equal(seen.length, 12);
});

test('Y6 together: an error in one closes the others; stopping early closes all', async () => {
  let closed = 0;
  const slow = async function* (): AsyncGenerator<string, string> {
    try {
      yield 'a';
      await wait(200);
      return 'never';
    } finally {
      closed++;
    }
  };
  const bad = async function* (): AsyncGenerator<string, string> {
    yield 'b';
    throw new Error('boom');
  };
  await assert.rejects(async () => {
    for await (const _ of runTogether(2, (i) => (i === 0 ? slow() : bad()))) void _;
  }, /boom/);
  // The other one is closed as soon as the wait it is in ends (a generator can't be cut mid-await).
  await wait(260);
  assert.equal(closed, 1);
  const it = runTogether(2, () => slow());
  await it.next();
  await it.return([]);
  await wait(260);
  assert.equal(closed, 3);
});

function reader(name: string, ms: number, log: string[]): Tool {
  return {
    defaultPermission: 'auto',
    changes: false,
    spec: { name, description: name, parameters: { type: 'object' } },
    summarize: () => `read with ${name}`,
    run: async (args: Record<string, unknown>) => {
      log.push(`start ${name} ${String(args.q ?? '')}`);
      await wait(ms);
      log.push(`end ${name} ${String(args.q ?? '')}`);
      return `${name} says ${String(args.q ?? '')}`;
    },
  } as Tool;
}

test('Y6 together: in a real turn, three reads overlap; every result is stored and reaches the model; a step with a change stays in order', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-23T12:00:00Z') });
  try {
    app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-23T12:00:00Z' } as never);
    const log: string[] = [];
    app.tools.add(reader('web_search', 60, log));
    app.tools.add(reader('recall', 60, log));
    app.tools.add(reader('weather', 60, log));
    app.tools.add({ ...reader('note_thing', 10, log), defaultPermission: 'auto', changes: true } as Tool);
    const conv = app.store.createConversation();
    app.script.push([call('a', 'web_search', { q: '1' }), call('b', 'recall', { q: '2' }), call('c', 'weather', { q: '3' })], text('All three read.'));
    const evs: ChatEvent[] = [];
    const t0 = Date.now();
    for await (const ev of runTurn(app, conv.id, 'look these up', undefined)) evs.push(ev);
    const took = Date.now() - t0;
    assert.deepEqual(log.slice(0, 3).map((l) => l.split(' ')[0]), ['start', 'start', 'start'], 'all three started before any ended');
    assert.ok(took < 60 * 3 + 400, `overlapping, not one after another (${took} ms)`);
    const results = evs.filter((e) => e.type === 'tool_result') as { id: string; status: string; output: string }[];
    assert.deepEqual(results.map((r) => r.id).sort(), ['a', 'b', 'c']);
    assert.ok(results.every((r) => r.status === 'ok'));
    const stored = app.store.messages(conv.id).filter((m) => m.role === 'tool');
    assert.deepEqual(stored.map((m) => String(m.meta?.toolCallId)).sort(), ['a', 'b', 'c']);
    const second = app.requests.at(-1)!.messages.filter((m) => m.role === 'tool');
    assert.equal(second.length, 3, 'the model gets all three results');
    // A step with a call that changes something: strictly in the order written.
    log.length = 0;
    app.script.push([call('d', 'web_search', { q: '4' }), call('e', 'note_thing', { q: '5' })], text('Done.'));
    for await (const _ of runTurn(app, conv.id, 'search then note', undefined)) void _;
    assert.deepEqual(log, ['start web_search 4', 'end web_search 4', 'start note_thing 5', 'end note_thing 5']);
  } finally {
    app.store.close();
    cleanup();
  }
});
