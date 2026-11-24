// Z7: tools picked by what a message means, on top of the word lists (src/tool-meaning.ts), and how
// a turn uses it (src/chat.ts): only adds, never waits long, never for a private chat unless the
// embedding model is on this computer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runTurn } from '../src/chat.ts';
import type { EmbedTarget } from '../src/embeddings.ts';
import { loadRows } from '../src/lean.ts';
import { MEANT, ToolMeaning } from '../src/tool-meaning.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, tempDir, text } from './helpers.ts';

// A stand-in embedding model: a text is the mix of the subjects its words belong to.
const SUBJECTS: Record<string, string[]> = {
  time: ['timer', 'hours', 'clock', 'time', 'track', 'worked'],
  money: ['bill', 'bills', 'pay', 'paid', 'spend', 'money', 'budget'],
  sport: ['game', 'score', 'team', 'win', 'league', 'match'],
  tone: ['formal', 'tone', 'personality', 'blunt', 'sugarcoating', 'straight'],
  ship: ['server', 'ssh', 'deploy', 'computer'],
};
const KEYS = Object.keys(SUBJECTS);
function vec(s: string): Float32Array {
  const words = s.toLowerCase().split(/[^a-z]+/);
  const v = new Float32Array(KEYS.length + 64);
  KEYS.forEach((k, i) => (v[i] = words.filter((w) => SUBJECTS[k]!.includes(w)).length));
  // Every other word gets a small place of its own, so two texts with no subject in common are far apart.
  for (const w of words) if (w && !KEYS.some((k) => SUBJECTS[k]!.includes(w))) v[KEYS.length + ([...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 64)] += 0.2;
  v[KEYS.length] += 0.01; // never a zero vector
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return v.map((x) => x / n);
}
const target: EmbedTarget = { config: { id: 'e', label: 'E', kind: 'openai-compatible', baseUrl: 'http://x/v1', local: true }, model: 'fake-embed' };
const tool = (name: string, description: string): Tool => ({ spec: { name, description, parameters: { type: 'object' } }, defaultPermission: 'auto', summarize: () => name, run: async () => 'ok' }) as Tool;
const TOOLS = [
  tool('time_start', 'Start a timer for work. Track hours.'),
  tool('time_stop', 'Stop the running timer; the time worked is kept.'),
  tool('time_report', 'Hours worked between two dates.'),
  tool('bill_add', 'Track a bill to pay each month.'),
  tool('bill_list', 'The bills to pay and when.'),
  tool('sports_scores', 'The score of a game for a team or league.'),
  tool('tune_personality', 'Change your personality: more formal, your tone, blunt.'),
  tool('ssh_run', 'Run a command on a server over ssh.'),
  tool('ssh_connect', 'Connect a server over ssh to deploy.'),
  tool('note', 'Notes you keep.'),
];

test('Z7 meaning: the nearest tools, best first; what is already offered takes no place', async () => {
  let calls = 0;
  const m = new ToolMeaning(() => target, async (_t, texts) => (calls++, texts.map(vec)));
  const got = await m.pick('I am starting on the kitchen job, track my hours', TOOLS);
  assert.deepEqual([...got].sort(), ['time_report', 'time_start', 'time_stop'], 'the tools about time, and only those');
  assert.ok(!got.includes('bill_add') && !got.includes('sports_scores'));
  assert.ok(got.length <= MEANT.tools + MEANT.familyTools);
  assert.deepEqual(await m.pick('stop sugarcoating things, be straight with me', TOOLS), ['tune_personality']);
  // Already offered: not returned, and the next ones move up.
  const skipped = await m.pick('track my hours', TOOLS, new Set(['time_start']));
  assert.ok(!skipped.includes('time_start') && skipped.includes('time_report'));
  // The tools were embedded once; each pick after that is one call for the message.
  const before = calls;
  await m.pick('which bills do I pay', TOOLS);
  assert.equal(calls - before, 1);
});

test('Z7 meaning: families that come whole (her computer, SSH) are never added on a guess', async () => {
  const m = new ToolMeaning(() => target, async (_t, texts) => texts.map(vec));
  assert.deepEqual(await m.pick('deploy to the server over ssh', TOOLS), []);
});

test('Z7 meaning: nothing far enough from everything is added', async () => {
  const m = new ToolMeaning(() => target, async (_t, texts) => texts.map(vec));
  assert.deepEqual(await m.pick('good morning, slept terribly', TOOLS), []);
});

test('Z7 meaning: no embedding model, a slow one or a failing one means no additions (and no waiting)', async () => {
  assert.deepEqual(await new ToolMeaning(() => undefined, async () => assert.fail('never called')).pick('track my hours', TOOLS), []);
  // Slow: the turn goes on without it; once the vectors are there a later turn gets them.
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  let first = true;
  const slow = new ToolMeaning(() => target, async (_t, texts) => {
    if (first) {
      first = false;
      await gate;
    }
    return texts.map(vec);
  });
  const t0 = Date.now();
  assert.deepEqual(await slow.pick('track my hours', TOOLS, new Set(), 60), []);
  assert.ok(Date.now() - t0 < 1000);
  release();
  await slow.warm(TOOLS);
  assert.ok((await slow.pick('track my hours', TOOLS)).includes('time_start'));
  // Failing: said in lastError, nothing added, nothing thrown.
  const bad = new ToolMeaning(() => target, async () => {
    throw new Error('embedding server is down');
  });
  assert.deepEqual(await bad.pick('track my hours', TOOLS), []);
  assert.match(bad.lastError ?? '', /down/);
});

test('Z7 turn: a tool the words missed is offered when the meaning finds it; a private chat only with a model on this computer', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-23T15:00:00Z') });
  try {
    // She talks through a model on this computer; the embedding model is either elsewhere or here too.
    const here = { id: 'p', label: 'P', kind: 'openai-compatible' as const, baseUrl: 'http://x', defaultModel: 'm', local: true };
    const away = { id: 'r', label: 'R', kind: 'openai-compatible' as const, baseUrl: 'http://y', defaultModel: 'e' };
    const set = (local: boolean) => app.settings.update({ providers: [here, away], defaultProviderId: 'p', defaultModel: 'm', routes: { embeddings: { providerId: local ? 'p' : 'r', model: 'fake-embed' } }, lean: { tools: { mode: 'always' } }, ownerName: 'Alex', disclosureAcceptedAt: '2026-11-22T00:00:00Z' } as never);
    set(false);
    app.tools.add(tool('zebra_count', 'Counts the stripes on a zebra.'));
    const asked: string[] = [];
    app.toolMeaning = { pick: async (said: string, tools: Tool[], skip: ReadonlySet<string>) => (asked.push(said), tools.some((t) => t.spec.name === 'zebra_count') && !skip.has('zebra_count') ? ['zebra_count', 'not_a_tool'] : []) } as never;
    const offered = async (conv: string, said: string): Promise<string[]> => {
      app.script.push(text('ok'));
      for await (const _ of runTurn(app, conv, said, undefined)) void _;
      return (app.requests.at(-1)!.tools ?? []).map((t) => t.name);
    };
    const conv = app.store.createConversation();
    const names = await offered(conv.id, 'how stripy is that horse');
    assert.ok(names.includes('zebra_count'), 'added by meaning');
    assert.ok(!names.includes('not_a_tool'), 'only tools she may use here');
    assert.deepEqual(asked, ['how stripy is that horse']);
    // A guess is for this turn: it is not kept the way a tool named by the person is.
    assert.ok(!loadRows(app.store.db, conv.id).some((r) => r.tool === 'zebra_count'));
    // A private chat with an embedding model that is not on this computer: the message is not sent to it.
    const priv = app.store.createConversation({ private: true } as never);
    assert.ok(!(await offered(priv.id, 'how stripy is that horse')).includes('zebra_count'));
    assert.equal(asked.length, 1, 'not asked for the private chat');
    // On this computer it is.
    set(true);
    const privLocal = app.store.createConversation({ private: true } as never);
    await offered(privLocal.id, 'how stripy is that horse');
    assert.equal(asked.length, 2);
  } finally {
    app.store.close();
    cleanup();
  }
});
