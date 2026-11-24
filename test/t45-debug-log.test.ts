// T45 D8: the Debug log level says what a turn decided: which model and why, the history budget,
// how many tools were offered, each tool call (name, time, size), a fallback, the after-turn jobs
// with their durations, and how the turn ended. Never what was said: no message text, no tool
// arguments or results. At the default level none of these lines exist.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { debugLine, Log, logOptions } from '../src/log.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { makeApp, tempDir } from './helpers.ts';

const clock = { now: new Date('2026-11-24T15:00:00Z') };
const SECRET_SAID = 'my zebrafish password is hunter-walrus';
const SECRET_ARG = 'quokka-argument';
const SECRET_OUT = 'narwhal-result';
const SECRET_REPLY = 'ocelot-reply';

const closers: (() => void)[] = [];
after(() => {
  for (const c of closers) c();
});

/** A scripted model per provider id: 'fail' throws, else it plays its steps, then answers. */
function world(level: 'debug' | 'info') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, clock);
  closers.push(() => {
    app.store.close();
    cleanup();
  });
  const fail = new Set<string>();
  const steps: StreamEvent[][] = [];
  class P implements Provider {
    readonly config: ProviderConfig;
    constructor(config: ProviderConfig) {
      this.config = config;
    }
    async listModels(): Promise<string[]> {
      return ['big-chat', 'backup-model'];
    }
    async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
      if (fail.has(this.config.id)) throw new Error(`503 overloaded while reading ${SECRET_SAID}`);
      for (const ev of steps.shift() ?? [{ type: 'text', text: `All done, ${SECRET_REPLY}.` } as StreamEvent]) yield ev;
    }
  }
  app.providerFactory = (config) => new P(config);
  app.settings.update({
    providers: [
      { id: 'a', label: 'Alpha', kind: 'openai-compatible', baseUrl: 'http://a' },
      { id: 'b', label: 'Beta', kind: 'openai-compatible', baseUrl: 'http://b' },
    ],
    defaultProviderId: 'a',
    defaultModel: 'big-chat',
    defaultFallbacks: [{ providerId: 'b', model: 'backup-model' }],
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: clock.now.toISOString(),
  });
  app.tools.add({ spec: { name: 'echo_thing', description: 'Echoes.', parameters: { type: 'object', properties: { what: { type: 'string' } } } }, defaultPermission: 'auto', summarize: () => 'Echo', run: async () => `the result is ${SECRET_OUT}` });
  // The log with a console of its own, so the test sees exactly what would be printed and stored.
  const printed: { method: string; text: string }[] = [];
  const rec = (method: string) => (...a: unknown[]) => void printed.push({ method, text: a.map(String).join(' ') });
  const target = { log: rec('log'), info: rec('info'), debug: rec('debug'), warn: rec('warn'), error: rec('error') };
  app.log = new Log(dir, undefined, () => clock.now, logOptions({ SARA_LOG_LEVEL: level }));
  app.log.captureConsole(target);
  const real = { debug: console.debug, warn: console.warn };
  const turn = async (text: string) => {
    // The turn prints through the global console; send it to the captured one for this turn.
    console.debug = target.debug;
    console.warn = target.warn;
    try {
      const conv = app.store.createConversation();
      for await (const ev of runTurn(app, conv.id, text)) void ev;
      return conv.id;
    } finally {
      console.debug = real.debug;
      console.warn = real.warn;
    }
  };
  const debug = () => app.log!.recent({ limit: 500 }).filter((l) => l.level === 'debug').map((l) => l.msg).reverse();
  return { app, fail, steps, turn, debug, printed };
}

test('debugLine builds its text only when Debug is on, and a line that throws is dropped', () => {
  let built = 0;
  debugLine(undefined, () => String(++built));
  debugLine({ wants: () => false }, () => String(++built));
  assert.equal(built, 0);
  const real = console.debug;
  const got: string[] = [];
  console.debug = (...a: unknown[]) => void got.push(a.join(' '));
  try {
    debugLine({ wants: (l) => l === 'debug' }, () => `line ${++built}`);
    debugLine({ wants: () => true }, () => {
      throw new Error('boom');
    });
  } finally {
    console.debug = real;
  }
  assert.deepEqual(got, ['line 1']);
});

test('Debug level: a turn with a tool call says what it decided, with names, counts and times only', async () => {
  const w = world('debug');
  w.steps.push([{ type: 'tool_call', call: { id: 'c1', name: 'echo_thing', arguments: { what: SECRET_ARG } } }]);
  const id = await w.turn(SECRET_SAID);
  const lines = w.debug();
  const all = lines.join('\n');
  const tag = `turn ${id.slice(0, 8)}: `;
  assert.ok(lines.length >= 6, all);
  assert.ok(lines.every((l) => l.startsWith(tag)), 'every line carries the short conversation id');
  // Which model and why.
  assert.match(all, /job turn -> Alpha \(big-chat\), from default; chain of 2: big-chat \[default\], backup-model \[/);
  // The history budget of that model.
  assert.match(all, /history budget \d+ characters \(mode (auto|full|fixed), window (\d+|unknown) tokens/);
  // Tools offered, per model step (two steps: the call, then her answer).
  const offered = lines.filter((l) => /step \d+, Alpha \(big-chat\): \d+ tools offered of \d+ eligible/.test(l));
  assert.equal(offered.length, 2, all);
  assert.ok(Number(/: (\d+) tools offered/.exec(offered[0])![1]) >= 1);
  // The tool call: its name, how it ended, how long, how big.
  assert.match(all, /tool echo_thing ok in \d+ ms, result \d+ characters/);
  // The end of the turn.
  assert.match(all, /ended ok(?: \(\w+\))? in \d+ ms, 1 tool calls: echo_thing/);
  // Nothing that was said, asked for or returned.
  for (const secret of [SECRET_SAID, 'zebrafish', SECRET_ARG, SECRET_OUT, SECRET_REPLY]) assert.ok(!all.includes(secret), `leaked: ${secret}`);
  // They went to the console as debug lines too.
  assert.ok(w.printed.some((p) => p.method === 'debug' && p.text.includes('tools offered')));
});

test('Debug level: a fallback names both models and the kind of failure, not the error text', async () => {
  const w = world('debug');
  w.fail.add('a');
  await w.turn('hello there');
  const all = w.debug().join('\n');
  assert.match(all, /fallback at step 1: Alpha \(big-chat\) failed \(Error\); now Beta \(backup-model\), 2 of 2 in the chain/);
  assert.match(all, /step 1, Beta \(backup-model\): \d+ tools offered/);
  assert.ok(!w.debug().some((l) => l.includes('zebrafish')), 'the error text is not in a debug line');
});

test('Debug level: after-turn jobs say when they start and how long they took', async () => {
  const w = world('debug');
  let ran = 0;
  (w.app as unknown as { learning: unknown }).learning = { afterTurn: async () => void ran++ };
  (w.app as unknown as { agenda: unknown }).agenda = {
    afterTurn: () => {
      throw new Error('plans are closed');
    },
  };
  await w.turn('hello there');
  const all = w.debug().join('\n');
  assert.equal(ran, 1);
  assert.match(all, /after-turn job skill learning started/);
  assert.match(all, /after-turn job skill learning finished in \d+ ms/);
  assert.match(all, /after-turn job plans started/);
  assert.match(all, /after-turn job plans failed in \d+ ms/);
  // Started comes before finished, and the turn's own end line is there.
  assert.ok(all.indexOf('skill learning started') < all.indexOf('skill learning finished'));
  assert.match(all, /ended ok/);
});

test('the default level has none of these lines, on the console or in the file', async () => {
  const w = world('info');
  w.steps.push([{ type: 'tool_call', call: { id: 'c1', name: 'echo_thing', arguments: { what: SECRET_ARG } } }]);
  await w.turn(SECRET_SAID);
  assert.deepEqual(w.debug(), []);
  assert.ok(!w.printed.some((p) => p.method === 'debug'));
  assert.ok(!w.app.log!.recent({ limit: 500 }).some((l) => /tools offered|history budget|after-turn job/.test(l.msg)));
});
