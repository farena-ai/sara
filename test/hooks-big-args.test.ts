// 2026-11-20 owner report: asked for a long build prompt, she called make_document with ~40 KB of
// content and the turn ended with "Unterminated string in JSON at position 16384". The plugin hook
// adapter cut the arguments' JSON text at 16 KB and parsed it. Big arguments must never end a turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginTurn, RESULT_MAX, fitJson } from '../src/hooks.ts';

const big = () => ({ format: 'md', title: 'PrimeSentry - Development Brief', content: `# Brief\n${'Every inmate record "quoted" and \\ escaped. '.repeat(1200)}` });

test('fitJson: a 50 KB argument object becomes valid, small JSON with every key kept', () => {
  const args = big();
  assert.ok(JSON.stringify(args).length > 40_000);
  const out = fitJson(args, RESULT_MAX);
  const text = JSON.stringify(out);
  assert.ok(text.length <= RESULT_MAX, `${text.length}`);
  assert.deepEqual(Object.keys(out), ['format', 'title', 'content']);
  assert.equal(out.title, args.title, 'short values are untouched');
  assert.ok(String(out.content).endsWith('…'));
  assert.deepEqual(fitJson({ a: 1, b: 'x' }, RESULT_MAX), { a: 1, b: 'x' }, 'small objects pass as they are');
  assert.deepEqual(fitJson({ list: Array.from({ length: 5000 }, (_, i) => ({ i, s: 'y'.repeat(40) })) }, 1000).truncated, true, 'what cannot fit keeps its keys');
});

test('tool.before with big arguments: no throw, plugins get parsed (shortened) arguments, scrub applies per value', async () => {
  let seen: unknown;
  const host = {
    companionId: 'main',
    scrub: (s: string) => s.replace(/SECRET-\w+/g, '[REDACTED]'),
    log: () => undefined,
    withHook: () => [{ id: 'a', name: 'A', tools: [], request: async (_t: string, body: Record<string, unknown>) => { seen = body; return { type: 'result' }; } }],
  };
  const pt = new PluginTurn(host as never, { id: 'c', channel: 'web' } as never, () => new Date());
  const args = { ...big(), token: 'SECRET-abc123' };
  const r = await pt.beforeTool({ id: 'x', name: 'make_document', args, permission: 'auto' });
  assert.equal(r.deny, undefined);
  const data = (seen as { data: { args: Record<string, unknown> } }).data;
  assert.equal(data.args.token, '[REDACTED]');
  assert.ok(JSON.stringify(data.args).length <= RESULT_MAX);
});

test('tool.before with no plugin hooks does no work and never throws', async () => {
  const host = { companionId: 'main', scrub: (s: string) => s, log: () => undefined, withHook: () => [] };
  const pt = new PluginTurn(host as never, { id: 'c', channel: 'web' } as never, () => new Date());
  const r = await pt.beforeTool({ id: 'x', name: 'make_document', args: big(), permission: 'auto' });
  assert.deepEqual(r.events, []);
});
