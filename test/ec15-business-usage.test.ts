// EC15 follow-up (docs/ops/EC1115_DESIGN.md, "Business instance"): the business spending ledger
// (business_model_requests) as a read-only usage report for organization administrators, in the
// same shapes and CSV columns as src/usage-report.ts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BusinessBudget } from '../src/business/budget.ts';
import { businessUsageReport } from '../src/business/usage-report.ts';
import { contentFixture } from './helpers/business-content.ts';

const bounds = { instanceAllowanceNanoUsd: 10 ** 15, workspaceAllowanceNanoUsd: 10 ** 15, maxConcurrent: 4, maxInputTokens: 1000, maxOutputTokens: 1000, inputNanoUsdPerToken: 1000, outputNanoUsdPerToken: 2000 };
const key = (actorId: string, workspaceId: string) => ({ requestId: randomUUID(), actorId, workspaceId, conversationId: randomUUID(), payloadHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });

function ledger(db: DatabaseSync, actor: string, workspace: string, model: string, input: number, output: number, at?: number) {
  const budget = new BusinessBudget(db);
  const k = key(actor, workspace);
  budget.reserve(k, { ...bounds, modelName: model });
  budget.settle(k.requestId, { input, output });
  budget.finish(k.requestId, randomUUID(), 'answer');
  if (at) db.prepare('UPDATE business_model_requests SET created_at=? WHERE request_id=?').run(at, k.requestId);
  return k;
}

test('business usage: the ledger records the model and sums per person, workspace and model', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const [alex, blake, w1, w2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const now = Date.parse('2026-11-04T12:00:00Z');
    ledger(db, alex, w1, 'gpt-x', 100, 50, now);
    ledger(db, alex, w1, 'gpt-x', 10, 5, now);
    ledger(db, blake, w2, 'llama', 200, 100, now - 7 * 86_400_000);
    assert.equal(db.prepare('SELECT model FROM business_model_requests LIMIT 1').get()!.model, 'gpt-x');
    // A held request with unknown usage counts as an unpriced call; a refused turn with no model call is no call.
    const budget = new BusinessBudget(db);
    const held = key(blake, w2); budget.reserve(held, { ...bounds, modelName: 'llama' }); budget.hold(held.requestId);
    db.prepare('UPDATE business_model_requests SET created_at=? WHERE request_id=?').run(now, held.requestId);
    budget.recordNoCall(key(alex, w1), 'crisis');
    const names = { people: new Map([[alex, 'Alex'], [blake, 'Blake']]), workspaces: new Map([[w1, 'Sales'], [w2, '=Ops']]) };
    const q = { period: 'week' as const, by: ['person', 'workspace', 'model'] as const, from: '2026-10-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', tz: 'UTC' };
    const r = businessUsageReport(db, { ...q, by: [...q.by] }, names);
    assert.deepEqual(r.by, ['person', 'workspace', 'model']);
    const alexRow = r.rows.find(x => x.person === 'Alex')!;
    assert.deepEqual([alexRow.bucket, alexRow.workspace, alexRow.model, alexRow.calls, alexRow.input, alexRow.output, alexRow.tokens], ['2026-11-02', 'Sales', 'gpt-x', 2, 110, 55, 165]);
    // 110 * 1000 + 55 * 2000 nano-dollars.
    assert.equal(alexRow.usd, 0.00022);
    assert.equal(alexRow.project, '');
    const blakeRows = r.rows.filter(x => x.person === 'Blake');
    assert.deepEqual(blakeRows.map(x => x.bucket).sort(), ['2026-10-26', '2026-11-02']);
    assert.equal(blakeRows.find(x => x.bucket === '2026-11-02')!.unpriced, 1);
    assert.equal(r.totals.calls, 4);
    assert.equal(r.totals.unpriced, 1);
    assert.equal(r.totals.tokens, 165 + 300);
    const month = businessUsageReport(db, { ...q, period: 'month', by: ['model'] }, names);
    assert.deepEqual(month.rows.map(x => [x.bucket, x.model, x.calls]).sort(), [['2026-10', 'llama', 1], ['2026-11', 'gpt-x', 2], ['2026-11', 'llama', 1]]);
    // The window is half-open and respected.
    assert.equal(businessUsageReport(db, { ...q, from: '2026-11-05T00:00:00.000Z' }, names).totals.calls, 0);
  } finally { db.close(); }
});

test('business usage: routes are organization-admin only, CSV keeps the report columns, defuses formulas and is audited', async () => {
  const f = await contentFixture();
  try {
    const user = f.add('Blake');
    const workspace = f.runtime.control.createWorkspace(f.admin.principal, { name: '=HYPERLINK("x")' });
    ledger(f.runtime.control.database, f.admin.principal.identityId, workspace.id, 'gpt-x', 100, 50);
    assert.equal((await f.request('/api/business/usage/report', user)).status, 403);
    assert.equal((await f.request('/api/business/usage/report.csv', user)).status, 403);
    assert.equal((await fetch(f.runtime.origin + '/api/business/usage/report')).status, 401);
    const bad = await f.request('/api/business/usage/report?period=year');
    assert.equal(bad.status, 400);
    const r = await f.request('/api/business/usage/report?period=day&by=person,workspace,model&tz=America/Chicago');
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json() as { rows: { person: string; workspace: string; model: string; calls: number }[]; totals: { calls: number } };
    assert.deepEqual([body.rows[0].person, body.rows[0].workspace, body.rows[0].model, body.totals.calls], ['Alex', '=HYPERLINK("x")', 'gpt-x', 1]);
    assert.equal(f.runtime.control.database.prepare("SELECT count(*) AS n FROM business_audit WHERE action='usage.export'").get()!.n, 0);
    const csv = await f.request('/api/business/usage/report.csv?period=month&by=person,workspace,model');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attachment/);
    const text = await csv.text();
    const [head, line] = text.split('\r\n');
    assert.equal(head, 'period,person,workspace,model,calls,input_tokens,output_tokens,cached_tokens,tokens,usd,unpriced_calls');
    assert.match(line, /,"'=HYPERLINK\(""x""\)",gpt-x,1,100,50,0,150,/);
    const row = f.runtime.control.database.prepare("SELECT actor_id AS actor FROM business_audit WHERE action='usage.export'").get();
    assert.equal(row?.actor, f.admin.principal.identityId);
    // The page's script is served (the business shell serves an allowlist of files).
    const script = await fetch(f.runtime.origin + '/business-usage.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    // Writes are refused: the report is read-only.
    assert.equal((await f.request('/api/business/usage/report', f.admin, {})).status, 404);
  } finally { await f.close(); }
});
