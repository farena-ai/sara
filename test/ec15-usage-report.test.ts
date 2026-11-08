// EC15: usage and cost reports per person, workspace, project and model; CSV; budgets with one
// alert per level (docs/ops/EC1115_DESIGN.md). Built on the Phase 52 meter's own rows.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlannerStore } from '../src/planner.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { Store } from '../src/store.ts';
import { bucketOf, reportCsv, UsageBudgets, usageReport, type ReportSource } from '../src/usage-report.ts';
import { UsageStore } from '../src/usage.ts';
import { tempDir } from './helpers.ts';

const API: ProviderConfig = { id: 'p', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-luna' };
const LOCAL: ProviderConfig = { id: 'o', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama' };

function space(dir: string, name: string, clock: { now: Date }) {
  const store = new Store(join(dir, `${name}.db`), () => clock.now);
  const usage = new UsageStore(store.db, () => clock.now);
  const planner = new PlannerStore(store.db, () => clock.now);
  return { store, usage, planner };
}

test('EC15 buckets: local days, ISO weeks starting Monday and months in the owner\'s time zone', () => {
  // 2026-11-09 03:00 UTC is still Sunday 8 November in Chicago.
  assert.equal(bucketOf('2026-11-09T03:00:00Z', 'day', 'America/Chicago'), '2026-11-08');
  assert.equal(bucketOf('2026-11-09T03:00:00Z', 'week', 'America/Chicago'), '2026-11-02');
  assert.equal(bucketOf('2026-11-09T15:00:00Z', 'week', 'America/Chicago'), '2026-11-09');
  assert.equal(bucketOf('2026-12-01T03:00:00Z', 'month', 'America/Chicago'), '2026-11');
  assert.equal(bucketOf('2026-12-01T03:00:00Z', 'month', 'UTC'), '2026-12');
});

test('EC15 report: per person, workspace, project and model; totals match the meter and the run records', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-02T12:00:00Z') };
  const owner = space(dir, 'owner', clock);
  const sam = space(dir, 'sam', clock);
  try {
    const projectId = owner.planner.projectId('Garden')!;
    const c1 = owner.store.createConversation({ title: 'a', workspace: 'site', projectId });
    const c2 = owner.store.createConversation({ title: 'b' });
    owner.usage.record(API, 'gpt-6-luna', { input: 1_000_000, output: 100_000 }, { purpose: 'chat', conversationId: c1.id, runId: 7 });
    clock.now = new Date('2026-11-03T12:00:00Z');
    owner.usage.record(API, 'gpt-6-luna', { input: 500_000, output: 0 }, { purpose: 'chat', conversationId: c2.id, runId: 7 });
    owner.usage.record(LOCAL, 'llama', { input: 2000, output: 300 }, { purpose: 'memory' });
    owner.usage.record(API, 'unknown-model', { input: 10, output: 10 }, { purpose: 'chat', conversationId: c1.id, runId: 8 });
    const sc = sam.store.createConversation({ title: 'sam' });
    sam.usage.record(API, 'gpt-6-luna', { input: 200_000, output: 20_000 }, { purpose: 'chat', conversationId: sc.id });
    const sources: ReportSource[] = [
      { person: 'owner', personName: 'You', db: owner.store.db },
      { person: 'm1', personName: 'Sam', db: sam.store.db },
      { person: 'owner', personName: 'You', db: owner.store.db }, // a second companion sharing a DB is counted once
    ];
    const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' };
    const byPerson = usageReport(sources, { period: 'week', by: ['person'], tz: 'UTC', ...window });
    const meter = owner.usage.summary(window.from).total;
    const samMeter = sam.usage.summary(window.from).total;
    assert.equal(byPerson.totals.calls, meter.calls + samMeter.calls);
    assert.equal(byPerson.totals.tokens, meter.tokens + samMeter.tokens);
    assert.equal(byPerson.totals.usd, Math.round((meter.usd + samMeter.usd) * 1e6) / 1e6);
    assert.equal(byPerson.totals.unpriced, 1);
    const you = byPerson.rows.find((r) => r.person === 'You')!;
    assert.equal(you.calls, 4);
    // The run records' rows (run_id 7 and 8) are the same rows the report sums.
    const runs = owner.store.db.prepare('SELECT COALESCE(SUM(input + output), 0) AS t FROM usage WHERE run_id IN (7, 8)').get() as { t: number };
    const daily = usageReport([sources[0]], { period: 'day', by: ['project', 'workspace', 'model'], tz: 'UTC', ...window });
    const garden = daily.rows.filter((r) => r.project === 'Garden');
    assert.deepEqual(garden.map((r) => [r.bucket, r.workspace, r.model]), [['2026-11-02', 'site', 'gpt-6-luna'], ['2026-11-03', 'site', 'unknown-model']]);
    const none = daily.rows.filter((r) => r.project === '');
    assert.equal(none.reduce((n, r) => n + r.tokens, 0) + garden.reduce((n, r) => n + r.tokens, 0), daily.totals.tokens);
    assert.equal(runs.t + 2300, daily.totals.tokens, 'run rows + the memory call without a run');
    assert.equal(usageReport(sources, { period: 'month', by: ['model'], tz: 'UTC', ...window }).rows.find((r) => r.model === 'llama')?.usd, 0);
  } finally {
    owner.store.close();
    sam.store.close();
    cleanup();
  }
});

test('EC15 CSV: one header, a row per group, formula-looking cells defused', () => {
  const csv = reportCsv({ period: 'day', by: ['person', 'workspace'], from: 'a', to: 'b', rows: [{ bucket: '2026-11-02', person: '=HYPERLINK("x")', workspace: 'main', project: '', model: '', calls: 1, input: 2, output: 3, cached: 0, tokens: 5, usd: 0.25, unpriced: 0 }], totals: { calls: 1, input: 2, output: 3, cached: 0, tokens: 5, usd: 0.25, unpriced: 0 } });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'period,person,workspace,calls,input_tokens,output_tokens,cached_tokens,tokens,usd,unpriced_calls');
  assert.equal(lines[1], `2026-11-02,"'=HYPERLINK(""x"")",main,1,2,3,0,5,0.25,0`);
  assert.equal(lines.length, 2);
});

test('EC15 budgets: monthly per person and workspace, one alert per level per month, local calls never cost dollars', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-02T12:00:00Z') };
  const owner = space(dir, 'owner', clock);
  try {
    const c = owner.store.createConversation({ title: 'a', workspace: 'site' });
    const sources: ReportSource[] = [{ person: 'owner', personName: 'You', db: owner.store.db }];
    const b = new UsageBudgets(dir, () => clock.now);
    assert.throws(() => b.set([{ scope: 'team', key: 'x', usd: 1 }]), /person or a workspace/);
    assert.throws(() => b.set([{ scope: 'person', key: 'owner' }]), /dollars or tokens/);
    b.set([{ scope: 'person', key: 'owner', usd: 1, alertAt: 0.8 }, { scope: 'workspace', key: 'site', tokens: 10_000_000 }]);
    assert.equal(b.get().budgets[1].alertAt, 0.8, 'default alert at 80%');
    owner.usage.record(API, 'gpt-6-luna', { input: 7_000_000, output: 0 }, { purpose: 'chat', conversationId: c.id }); // $0.70
    assert.deepEqual(b.alerts(sources, 'UTC'), []);
    owner.usage.record(API, 'gpt-6-luna', { input: 1_500_000, output: 0 }, { purpose: 'chat', conversationId: c.id }); // $0.85, 8.5M tokens
    const first = b.alerts(sources, 'UTC');
    assert.deepEqual(first.map((a) => [a.scope, a.key, a.level]), [['person', 'owner', 'near'], ['workspace', 'site', 'near']]);
    assert.deepEqual(b.alerts(sources, 'UTC'), [], 'each level alerts once a month');
    owner.usage.record(API, 'gpt-6-luna', { input: 2_000_000, output: 0 }, { purpose: 'chat', conversationId: c.id }); // $1.05
    assert.deepEqual(b.alerts(sources, 'UTC').map((a) => a.level), ['reached', 'reached']);
    owner.usage.record(LOCAL, 'llama', { input: 9_000_000, output: 0 }, { purpose: 'chat' });
    const st = b.status(sources, 'UTC');
    assert.equal(st[0].spent.usd, 1.05);
    clock.now = new Date('2026-12-01T00:00:01Z');
    assert.equal(b.status(sources, 'UTC')[0].level, 'ok', 'a new month starts at zero');
  } finally {
    owner.store.close();
    cleanup();
  }
});
