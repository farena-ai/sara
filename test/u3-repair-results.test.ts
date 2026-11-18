// ROADMAP_U U3.18 (docs/REMOTE_REPAIR.md "Code change results"): a code-change step in a remote fix plan no
// longer ends at "handed over". The helped Sara sends signed status events for the step's whole life
// (preparing → prepared with its test results → approved → applied / rolled back / undone, or not
// prepared / discarded) back to the helper over the link; the helper's plan view and final report show
// them, and both help logs record them. Two in-process servers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { codePhase, reportOf } from '../src/remote-repair.ts';
import { checksOk, clock, fixPass, linkPair, pairNode, until } from './helpers-repair-pair.ts';

const helperPlan = async (b: any, id: string) => (await b.req('GET', '/api/remote-repair')).plans.find((q: any) => q.id === id);
const helpedPlan = async (a: any) => (await a.req('GET', '/api/remote-repair')).plans.find((p: any) => p.side === 'in');

test('U3.18: code phases from T3 change states', () => {
  assert.equal(codePhase('working'), 'preparing');
  assert.equal(codePhase('proposed'), 'prepared');
  for (const s of ['refused', 'failed', 'stopped'] as const) assert.equal(codePhase(s), 'not-prepared');
  assert.equal(codePhase('failed', 'approved'), 'failed', 'a failure after the OK is not "not prepared"');
  assert.equal(codePhase('applying'), 'approved');
  assert.equal(codePhase('applied'), 'applied');
  assert.equal(codePhase('rolledback'), 'rolledback');
  assert.equal(codePhase('undoing'), 'applied');
  assert.equal(codePhase('undone'), 'undone');
  assert.equal(codePhase('discarded'), 'discarded');
  assert.equal(codePhase('parked'), 'parked');
});

test('U3.18: a code step reports its whole life to the helper (prepared + tests, approved, applied, undone); report and help logs show it', async (t) => {
  const a = await pairNode(t, 'Hank');
  const b = await pairNode(t, 'Sam');
  const { aLink, bLink } = await linkPair(a, b);
  const bNotices: string[] = [];
  b.m.onNotify = (title, body) => bNotices.push(`${title}: ${body}`);
  await fixPass(a, b, aLink, 'each');
  const text = 'make the weather add-on retry twice before it gives up';
  const sent = await b.req('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'code', request: text }] });
  let p = await helpedPlan(a);
  await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/0`, { approve: true });
  p = await until(async () => {
    const x = await helpedPlan(a);
    return x.status === 'done' && x;
  }, 'handed over');
  assert.deepEqual(a.code.requests, [text]);
  assert.equal(p.steps[0].change, 1);
  assert.equal(p.steps[0].code.phase, 'preparing', 'handing over is not the outcome');
  // The helper sees "preparing", and the report says the code change is still being prepared.
  let out = await until(async () => {
    const x = await helperPlan(b, sent.plan.id);
    return x?.steps[0]?.code?.phase === 'preparing' && x;
  }, 'helper: preparing');
  assert.match(out.report, /being prepared/);
  // Prepared, with its test results: they cross (names and pass/fail only, never the details).
  a.code.move(1, 'proposed', { checks: { ...checksOk, steps: checksOk.steps.map((s) => ({ ...s, detail: `${s.detail} (C:/Users/hank/private)` })) }, files: ['src/plugins.ts'] });
  out = await until(async () => {
    const x = await helperPlan(b, sent.plan.id);
    return x.steps[0].code.phase === 'prepared' && x;
  }, 'helper: prepared');
  assert.deepEqual(out.steps[0].code.checks, [{ name: 'typecheck', ok: true }, { name: 'related', ok: true }, { name: 'full', ok: true, skipped: true }]);
  assert.doesNotMatch(JSON.stringify(out), /hank\/private/, 'check details never leave');
  assert.match(out.report, /prepared and tested/);
  // The owner's OK, then applied after the restart and health check.
  a.code.move(1, 'applying');
  await until(async () => (await helperPlan(b, sent.plan.id)).steps[0].code.phase === 'approved', 'helper: approved');
  clock.now = new Date(clock.now.getTime() + 60_000);
  a.code.move(1, 'applied', { appliedAt: clock.now.toISOString() });
  out = await until(async () => {
    const x = await helperPlan(b, sent.plan.id);
    return x.steps[0].code.phase === 'applied' && x;
  }, 'helper: applied');
  assert.match(out.report, /applied/);
  assert.ok(bNotices.some((n) => /Hank/.test(n) && /applied/i.test(n)), 'the helper is told when it is applied');
  // Undone later: that reaches the helper too.
  a.code.move(1, 'undoing');
  a.code.move(1, 'undone');
  out = await until(async () => {
    const x = await helperPlan(b, sent.plan.id);
    return x.steps[0].code.phase === 'undone' && x;
  }, 'helper: undone');
  assert.deepEqual(out.steps[0].code.events.map((e: any) => e.phase), ['preparing', 'prepared', 'approved', 'applied', 'undone']);
  assert.match(out.report, /undone/);
  // Both help logs record each phase.
  for (const n of [a, b]) {
    const log = (await n.req('GET', '/api/support')).log.filter((r: any) => r.kind === 'repair-code').map((r: any) => r.detail);
    for (const ph of ['prepared', 'approved', 'applied', 'undone']) assert.ok(log.some((d: string) => d.includes(ph)), `${ph} in the log: ${log.join(' | ')}`);
  }
  // Events about a change that is not part of a plan never cross.
  const before = (await helperPlan(b, sent.plan.id)).updatedAt;
  a.code.start('an unrelated local change');
  a.code.move(2, 'proposed');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal((await helperPlan(b, sent.plan.id)).updatedAt, before);
});

test('U3.18: not prepared and rolled back reach the helper; a missed event is caught up when the plan list is read', async (t) => {
  const a = await pairNode(t, 'Hank');
  const b = await pairNode(t, 'Sam');
  const { aLink, bLink } = await linkPair(a, b);
  await fixPass(a, b, aLink, 'pass');
  const sent = await b.req('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'code', request: 'retry the weather add-on twice' }, { kind: 'code', request: 'log the weather add-on errors' }] });
  let p = await helpedPlan(a);
  await a.req('POST', `/api/remote-repair/plans/${p.id}/approve`, { approve: true });
  for (const n of [0, 1]) await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/${n}`, { approve: true });
  p = await until(async () => {
    const x = await helpedPlan(a);
    return x.status === 'done' && x.steps.every((s: any) => s.change) && x;
  }, 'both handed over');
  a.code.move(1, 'refused', { noteKey: 'It would change hard limits (src/budget.ts), which she may never change.' });
  const out = await until(async () => {
    const x = await helperPlan(b, sent.plan.id);
    return x.steps[0].code?.phase === 'not-prepared' && x;
  }, 'helper: not prepared');
  assert.match(out.report, /not prepared/);
  // A restart in between: the status hook was not there (the change went live and back without it).
  const sc = a.code as any;
  const c2 = sc.get(2);
  sc.get = (id: number) => (id === 2 ? { ...c2, status: 'rolledback', updatedAt: clock.now.toISOString() } : undefined);
  await a.req('GET', '/api/remote-repair');
  const back = await until(async () => {
    const x = await helperPlan(b, sent.plan.id);
    return x.steps[1].code?.phase === 'rolledback' && x;
  }, 'helper: rolled back (caught up)');
  assert.match(back.report, /went back/);
});

test('U3.18: reportOf mentions code outcomes in plain words', () => {
  const base = { id: 'p', peerId: 'q', link: 'l', peer: 'Hank', side: 'out' as const, pass: 'x', scope: 'each' as const, note: '', status: 'done' as const, approved: true, reason: '', report: '', createdAt: '', updatedAt: '' };
  const step = (phase: string) => ({ n: 0, kind: 'code' as const, title: 't', status: 'done' as const, undoable: false, undone: false, change: 3, code: { phase, events: [] } });
  assert.match(reportOf({ ...base, steps: [step('applied') as never] }, 'helper'), /code change #3 was applied/i);
  assert.match(reportOf({ ...base, steps: [step('rolledback') as never] }, 'helper'), /went back/);
  assert.doesNotMatch(reportOf({ ...base, steps: [{ ...step('applied'), kind: 'fix', code: undefined } as never] }, 'helper'), /code/i);
});
