// V3.2 (docs/AUTOMATIONS.md "Steps and replay"): the step list editor (reorder, add a step between,
// remove, edit its words) saves through the existing PATCH; each run keeps what every step was
// ("does") and its outcome; "Run again with this input" replays a finished run ONCE with the same
// trigger detail on the same runner (no new engine). Fake turns, fake clock, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { Automations, type AutomationOptions } from '../src/automations.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

function rig(t: TestContext, task?: AutomationOptions['runTask']) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-13T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  const asked: string[] = [];
  const auto = new Automations(app, app.store.db, {
    runTask: task ?? (async (r) => (asked.push(r.content), { reply: 'Done.' })),
    notify: async () => undefined,
    quiet: () => false,
  });
  app.automations = auto;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, auto, dir, asked };
}

const DRAFT = {
  name: 'Invoice mail',
  trigger: { kind: 'webhook', hook: 'billing' },
  actions: [
    { kind: 'notify', text: 'Got it: {detail}', how: 'chat' },
    { kind: 'task', prompt: 'File the invoice from {detail}' },
    { kind: 'notify', text: 'Filed.', how: 'chat' },
  ],
};
/** A run parked on an OK at step 2, as the runner leaves it. */
function waitingRun(app: ReturnType<typeof makeApp>, automationId: number): number {
  const held = JSON.stringify({ index: 1, ctx: { files: [], detail: 'Run now' } });
  return Number(app.store.db.prepare("INSERT INTO automation_runs (automation_id, at, trigger_detail, outcome, steps_json, held_json) VALUES (?, ?, 'Run now', 'waiting', '[]', ?)").run(automationId, new Date().toISOString(), held).lastInsertRowid);
}
const SCHEDULE = { name: 'Morning', trigger: { kind: 'schedule', every: 'day', time: '08:00' }, actions: DRAFT.actions };

test('V3.2 a failed run replays once with the same input, on the same runner', async (t) => {
  let calls = 0;
  const seen: string[] = [];
  const { auto } = rig(t, async (r) => {
    seen.push(r.content);
    calls++;
    return calls === 1 ? { reply: '', error: 'The model timed out.' } : { reply: 'Filed it.' };
  });
  const a = auto.create(SCHEDULE, { by: 'settings' });
  const first = await auto.fire(a.id, 'Mail from billing: March invoice');
  assert.equal(first.outcome, 'failed');
  // Every step says what it was, so the run reads on its own after the steps change.
  assert.equal(first.steps.length, 2);
  assert.match(first.steps[0]!.does ?? '', /Got it/);
  assert.equal(first.steps[1]!.status, 'failed');
  const again = await auto.replay(first.id);
  assert.equal(again.outcome, 'done');
  assert.equal(again.trigger, 'Mail from billing: March invoice');
  assert.equal(again.replayOf, first.id);
  assert.equal(again.steps.length, 3);
  assert.equal(calls, 2);
  assert.ok(seen.every((s) => s.includes('Mail from billing: March invoice')), seen.join('\n'));
  // Once: the same run can't be replayed again (a double tap makes no second run).
  assert.throws(() => auto.replay(first.id), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(auto.history(a.id).length, 2);
  const h = auto.historyKey(`auto:${a.id}`);
  assert.equal(h.find((r) => r.runId === first.id)?.replayedBy, again.id);
  assert.equal(h.find((r) => r.runId === again.id)?.replayOf, first.id);
  // The newer run can be replayed in turn; an unknown run is a 404.
  await auto.replay(again.id);
  assert.equal(auto.history(a.id).length, 3);
  assert.throws(() => auto.replay(99999), (e: Error & { status?: number }) => e.status === 404);
});

test('V3.2 a test run replays as a test; a run still waiting for an OK is not replayed', async (t) => {
  const { app, auto, asked } = rig(t);
  const a = auto.create(SCHEDULE, { by: 'settings' });
  const dry = await auto.fire(a.id, 'Test run', { dry: true, force: true });
  const r = await auto.replay(dry.id);
  assert.equal(r.dry, true);
  assert.equal(asked.length, 0, 'a test replay does nothing');
  const w = waitingRun(app, a.id);
  assert.throws(() => auto.replay(w), (e: Error & { status?: number }) => e.status === 409);
});

test('V3.2 steps: reorder, add between and remove save through patch; refused while a run waits', async (t) => {
  const { app, auto } = rig(t);
  const a = auto.create(SCHEDULE, { by: 'settings' });
  const [n1, task, n2] = a.actions;
  const moved = auto.patch(a.id, { actions: [task, n1, { kind: 'notify', text: 'In between', how: 'chat' }, n2] });
  assert.deepEqual(moved.actions.map((x) => x.text ?? x.prompt), ['File the invoice from {detail}', 'Got it: {detail}', 'In between', 'Filed.']);
  assert.deepEqual(auto.get(a.id)!.actions.map((x) => x.kind), ['task', 'notify', 'notify', 'notify']);
  auto.patch(a.id, { actions: [n2] });
  assert.equal(auto.get(a.id)!.actions.length, 1);
  assert.throws(() => auto.patch(a.id, { actions: [] }), (e: Error & { status?: number }) => e.status === 400);
  // The list item carries one plain line per step for the editor.
  const item = auto.all().find((x) => x.key === `auto:${a.id}`)!;
  assert.deepEqual(item.steps, [auto.doesWords(n2!)]);
  // A run held at step 2 for an OK would go on with a different step: the order is locked until answered.
  const b = auto.create(SCHEDULE, { by: 'settings' });
  waitingRun(app, b.id);
  const cur = auto.get(b.id)!.actions;
  assert.throws(() => auto.patch(b.id, { actions: [cur[1], cur[0], cur[2]] }), (e: Error & { status?: number }) => e.status === 409);
  auto.patch(b.id, { name: 'Morning run' });
  assert.equal(auto.get(b.id)!.name, 'Morning run');
});

test('V3.2 routes: PATCH actions persists the new order; replay answers at once and only once', async (t) => {
  let n = 0;
  const { app, auto, dir } = rig(t, async () => (++n === 1 ? { reply: '', error: 'boom' } : { reply: 'ok' }));
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const a = auto.create(SCHEDULE, { by: 'settings' });
  const acts = a.actions;
  const p = await call('PATCH', `/automations/auto:${a.id}`, { actions: [acts[2], acts[0], acts[1]] });
  assert.equal(p.status, 200);
  const list = await call('GET', '/automations');
  const row = list.body.items.find((x: { key: string }) => x.key === `auto:${a.id}`);
  assert.deepEqual(row.actions.map((x: { kind: string }) => x.kind), ['notify', 'notify', 'task']);
  assert.equal(row.steps.length, 3);
  const failed = await auto.fire(a.id, 'Webhook: order 77');
  assert.equal(failed.outcome, 'failed');
  const r1 = await call('POST', `/automations/runs/${failed.id}/replay`, {});
  assert.equal(r1.status, 202);
  assert.equal(r1.body.runId > failed.id, true);
  await auto.settled();
  const r2 = await call('POST', `/automations/runs/${failed.id}/replay`, {});
  assert.equal(r2.status, 409);
  const h = await call('GET', `/automations/auto:${a.id}/history`);
  assert.equal(h.body.runs.length, 2);
  assert.equal(h.body.runs[0].trigger, 'Webhook: order 77');
  assert.equal(h.body.runs[0].outcome, 'done');
  assert.equal(h.body.runs[0].replayOf, failed.id);
  // Another space's run id is just not found here.
  assert.equal((await call('POST', '/automations/runs/424242/replay', {})).status, 404);
});

test('V3.2 web: step editor (drag + keyboard moves, add between) and per-run steps with Run again', () => {
  const js = readFileSync(join(ROOT, 'web', 'automations.js'), 'utf8');
  assert.match(js, /draggable = true/);
  assert.match(js, /'dragstart'/);
  assert.match(js, /t\('Move up'\)/);
  assert.match(js, /t\('Add a step here'\)/);
  assert.match(js, /t\('Run again with this input'\)/);
  assert.match(js, /\/automations\/runs\/\$\{r\.runId\}\/replay/);
  assert.match(js, /atm-run-steps/);
  const css = readFileSync(join(ROOT, 'web', 'begin.css'), 'utf8');
  assert.match(css, /\.atm-step\b/);
  assert.ok(!/\.atm-step[^{]*\{[^}]*#[0-9a-f]{3,6}\b/i.test(css), 'theme variables only');
});
