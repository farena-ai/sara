// EC18 (docs/ops/EC1828_DESIGN.md, docs/ops/SCALE.md): smoke test of the load script. A tiny run
// (2 users × 5 turns) against a throwaway Sara with the fake model and fake Telegram: every kind
// of operation happens, nothing fails, and the report has its numbers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKDOWN_HEAD, markdownRow, planTurn, runSize, summary } from '../scripts/load-test.ts';

test('EC18 the turn mix is fixed: tool every 3rd, upload every 4th, Telegram every 5th', () => {
  const plan = Array.from({ length: 10 }, (_, i) => planTurn(i));
  assert.deepEqual(plan.map((p) => p.tool), [false, false, true, false, false, true, false, false, true, false]);
  assert.deepEqual(plan.map((p) => p.upload), [false, false, false, true, false, false, false, true, false, false]);
  assert.deepEqual(plan.map((p) => p.telegram), [false, false, false, false, true, false, false, false, false, true]);
  assert.deepEqual(summary([]), { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  assert.deepEqual(summary([5, 1, 3, 2, 4]), { count: 5, p50Ms: 3, p95Ms: 5, maxMs: 5 });
});

test('EC18 smoke: a throwaway Sara takes chats, tool calls, uploads and Telegram messages with no errors', { timeout: 300_000 }, async () => {
  const r = await runSize({ concurrency: 2, turns: 5, modelMs: 20, log: () => {} });
  assert.equal(r.errors, 0, r.firstErrors.join('\n'));
  assert.equal(r.ops, 2 * 5 + 2, 'ten turns and two uploads');
  for (const k of ['turn', 'tool', 'upload', 'telegram'] as const) assert.ok(r.latency[k].count > 0, k);
  assert.ok(r.modelCalls >= 10);
  assert.equal(r.toolCalls, 2, 'one tool call per asking turn (turn 3 of each user)');
  assert.ok(Number.isFinite(r.cpuPercent) && r.cpuPercent >= 0);
  assert.ok(r.peakRssMb > 0);
  assert.equal(typeof r.sqliteBusy, 'number');
  assert.equal(MARKDOWN_HEAD.split('\n')[0].split('|').length, markdownRow(r).split('|').length);
});
