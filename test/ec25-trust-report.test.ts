// EC25 (docs/ops/EC2527_DESIGN.md): the trust report: what Sara said against what actually ran, for a
// run, a project or a week, from records that already exist (runs, receipts flags, research sources,
// the audit trail).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AuditRow } from '../src/audit-trail.ts';
import { PlannerStore } from '../src/planner.ts';
import { RunStore, type ToolStep } from '../src/runs.ts';
import { Store } from '../src/store.ts';
import { TRUST_CAP, trustMarkdown, trustReport, type TrustScope } from '../src/trust-report.ts';
import { tempDir } from './helpers.ts';

const tool = (p: Partial<ToolStep> & { name: string }): ToolStep => ({ id: p.name, summary: p.summary ?? p.name, args: p.args ?? {}, status: p.status ?? 'ok', output: p.output ?? 'done', outputChars: 4, ms: 5, ...p });

function world() {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-05T12:00:00Z') };
  const store = new Store(join(dir, 'sara.db'), () => clock.now);
  new PlannerStore(store.db, () => clock.now);
  const runs = new RunStore(store.db, () => clock.now);
  store.db.exec(`INSERT INTO projects (name, description, status, created_at, updated_at) VALUES ('Garden site', '', 'active', '2026-11-01', '2026-11-01')`);
  const projectId = Number((store.db.prepare(`SELECT id FROM projects WHERE name = 'Garden site'`).get() as { id: number }).id);
  const inProject = store.createConversation({ title: 'site work', projectId });
  const other = store.createConversation({ title: 'chat' });
  const reply = store.addMessage(inProject.id, 'assistant', 'I wrote the file and all tests pass.', { unverified: [{ kind: 'tests_pass', sentence: 'all tests pass', problem: 'contradicted' }] });
  const r1 = runs.open({ kind: 'turn', conversationId: inProject.id, title: 'Fix the gallery' });
  runs.writeStep(r1, 0, { model: 'm' }, clock.now.toISOString(), null, {
    calls: [{ model: 'm', provider: 'p', providerId: 'p', in: 100, out: 20, cached: 0, usd: 0.25, reported: true, ms: 900, ok: true }],
    tools: [
      tool({ name: 'write_file', approval: 'allowed', files: ['gallery.ts'] }),
      tool({ name: 'shell', status: 'error', output: 'npm test: 2 failing', approval: 'auto', sandbox: { isolation: 'bwrap', choice: 'apply' } }),
      tool({ name: 'web_fetch', args: { url: 'https://example.org/guide' }, approval: 'auto' }),
      tool({ name: 'delete_file', status: 'denied', approval: 'refused', output: 'Refused by the policy' }),
      tool({ name: 'shell', status: 'denied', guard: { kind: 'loop', key: 'k', quote: 'the same call again' } }),
    ],
    files: ['gallery.ts'], contradictions: [], replyMessageId: reply.id,
  });
  runs.close(r1, 'ok', 0, Date.now(), { replyMessageId: reply.id });
  const r2 = runs.open({ kind: 'turn', conversationId: other.id, title: 'Weather' });
  runs.writeStep(r2, 0, {}, clock.now.toISOString(), null, { calls: [{ model: 'm', provider: 'p', providerId: 'p', in: 10, out: 5, cached: 0, usd: null, reported: false, ms: 100, ok: true }], tools: [tool({ name: 'web_search', args: { query: 'rain' } })], files: [], contradictions: [] });
  runs.close(r2, 'ok', 0, Date.now());
  // A run long before the week.
  clock.now = new Date('2026-10-01T12:00:00Z');
  const old = runs.open({ kind: 'job', title: 'Old job' });
  runs.close(old, 'error', 0, Date.now());
  clock.now = new Date('2026-11-05T12:00:00Z');
  store.db.exec(`CREATE TABLE IF NOT EXISTS research_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, status TEXT NOT NULL, plan TEXT NOT NULL, searched TEXT NOT NULL DEFAULT '[]', report TEXT, report_doc INTEGER, cut TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, n INTEGER, step INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, detail TEXT, chars INTEGER NOT NULL DEFAULT 0, text TEXT, at TEXT NOT NULL);
    INSERT INTO research_runs (question, status, plan, created_at, updated_at) VALUES ('Which hedge?', 'done', '{}', '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z');
    INSERT INTO research_sources (run_id, n, step, url, title, status, at) VALUES (1, 1, 0, 'https://example.org/hedges', 'Hedges', 'read', '2026-11-04T10:01:00Z');
    INSERT INTO research_sources (run_id, n, step, url, title, status, reason, at) VALUES (1, NULL, 0, 'https://example.net/paywall', 'Paywalled', 'failed', 'blocked', '2026-11-04T10:02:00Z');`);
  const auditRows: AuditRow[] = [
    { seq: 1, at: '2026-11-05T11:00:00Z', action: 'approval.answer', who: 'owner', role: 'owner', channel: 'web', outcome: 'ok', target: 'write_file', policyRev: 0, prev: '0', hash: 'a' },
    { seq: 2, at: '2026-11-05T11:05:00Z', action: 'settings.update', who: 'm1', role: 'member', channel: 'web', outcome: 'refused', keys: ['adultMode'], policyRev: 1, prev: 'a', hash: 'b', content: 'secret text' },
    { seq: 3, at: '2026-10-01T11:05:00Z', action: 'login', who: 'owner', role: 'owner', channel: 'web', outcome: 'ok', policyRev: 0, prev: 'b', hash: 'c' },
  ];
  return { store, runs, r1, r2, projectId, auditRows, cleanup, clock };
}

const week: TrustScope = { kind: 'week', from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' };

test('EC25 week: summary, claims, tool outcomes, approvals, refusals, sandbox, sources and audit rows', () => {
  const w = world();
  try {
    const r = trustReport([{ db: w.store.db, runs: w.runs }], week, w.auditRows);
    assert.equal(r.summary.runs, 2, 'the October job is outside the week');
    assert.equal(r.summary.toolCalls, 6);
    assert.equal(r.summary.failedTools, 1);
    assert.equal(r.summary.usd, 0.25);
    assert.equal(r.summary.unpricedCalls, 1);
    assert.equal(r.claims.length, 1);
    assert.deepEqual({ kind: r.claims[0]!.kind, problem: r.claims[0]!.problem, run: r.claims[0]!.run }, { kind: 'tests_pass', problem: 'contradicted', run: w.r1 });
    const shell = r.tools.find((x) => x.name === 'shell')!;
    assert.deepEqual({ ok: shell.ok, error: shell.error, denied: shell.denied }, { ok: 0, error: 1, denied: 1 });
    assert.deepEqual(r.approvals, { auto: 2, allowed: 1, denied: 0, refused: 1 });
    assert.equal(r.failed[0]!.name, 'shell');
    assert.match(r.failed[0]!.output, /2 failing/);
    assert.deepEqual(r.refusals.map((x) => x.why).sort(), ['loop', 'policy']);
    assert.equal(r.sandbox.length, 1);
    assert.deepEqual(r.sources.map((s) => s.url).sort(), ['https://example.net/paywall', 'https://example.org/guide', 'https://example.org/hedges']);
    assert.equal(r.sources.find((s) => s.url.endsWith('paywall'))!.status, 'failed');
    assert.deepEqual(r.audit.map((a) => a.seq), [2, 1], 'audit rows in the window, newest first');
    assert.equal((r.audit[0] as unknown as Record<string, unknown>).content, undefined, 'never content');
    assert.equal(r.auditRefused, 1);
  } finally {
    w.store.close();
    w.cleanup();
  }
});

test('EC25 run and project scopes keep to their runs; research sources only for a week', () => {
  const w = world();
  try {
    const one = trustReport([{ db: w.store.db, runs: w.runs }], { kind: 'run', id: w.r2 }, w.auditRows);
    assert.equal(one.summary.runs, 1);
    assert.equal(one.claims.length, 0);
    assert.deepEqual(one.sources, []);
    assert.deepEqual(one.searches, ['rain']);
    const proj = trustReport([{ db: w.store.db, runs: w.runs }], { kind: 'project', id: w.projectId }, w.auditRows);
    assert.equal(proj.summary.runs, 1);
    assert.equal(proj.title, 'Project: Garden site');
    assert.equal(proj.claims.length, 1);
    assert.ok(!proj.sources.some((s) => s.url.includes('hedges')));
    assert.throws(() => trustReport([{ db: w.store.db, runs: w.runs }], { kind: 'run', id: 9999 }, []), /no run/i);
  } finally {
    w.store.close();
    w.cleanup();
  }
});

test('EC25 lists are capped with a count of the rest', () => {
  const w = world();
  try {
    const id = w.runs.open({ kind: 'job', title: 'Busy' });
    w.runs.writeStep(id, 0, {}, w.clock.now.toISOString(), null, { calls: [], tools: Array.from({ length: TRUST_CAP + 5 }, (_, i) => tool({ name: 'shell', status: 'error', output: `fail ${i}` })), files: [], contradictions: [] });
    w.runs.close(id, 'error', 0, Date.now());
    const r = trustReport([{ db: w.store.db, runs: w.runs }], week, []);
    assert.equal(r.failed.length, TRUST_CAP);
    assert.equal(r.more.failed, 6);
  } finally {
    w.store.close();
    w.cleanup();
  }
});

test('EC25 markdown: one document with every section, no audit content', () => {
  const w = world();
  try {
    const md = trustMarkdown(trustReport([{ db: w.store.db, runs: w.runs }], week, w.auditRows));
    for (const h of ['# Trust report', '## Summary', '## Claims checked', '## Tool calls', '## Failed tools', '## Approvals', '## Policy refusals', '## Sandbox', '## Sources cited', '## Audit trail']) assert.ok(md.includes(h), h);
    assert.match(md, /all tests pass/);
    assert.match(md, /contradicted/);
    assert.ok(!md.includes('secret text'));
  } finally {
    w.store.close();
    w.cleanup();
  }
});
