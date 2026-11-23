// X0: one job of the reminder tick that throws no longer stops the jobs after it, and each job
// keeps a record. Written first: before, a throw from loops.due skipped automations, errands, inbox ...
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReminderScheduler } from '../src/reminders.ts';
import { resetTickJobs, tickJob, tickJobsFailing, tickJobStatus } from '../src/tick-jobs.ts';
import { makeApp, tempDir } from './helpers.ts';

test('X0 tick: a job that throws does not stop the jobs after it, on any tick', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-22T12:00:00Z') });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: unknown) => void warned.push(String(m));
  try {
    resetTickJobs();
    const ran: string[] = [];
    Object.assign(app, {
      loops: { due: () => { throw new Error('database is locked'); } },
      automations: { due: () => void ran.push('automations') },
      errands: { due: () => Promise.reject(new Error('mail server said no')) },
      workers: { tick: () => void ran.push('workers') },
    });
    const s = new ReminderScheduler(app, app.planner!);
    s.tick();
    s.tick();
    assert.deepEqual(ran, ['automations', 'workers', 'automations', 'workers']);
    const loops = tickJobStatus().find((j) => j.name === 'loops')!;
    assert.equal(loops.runs, 2);
    assert.equal(loops.failing, 2);
    assert.match(loops.lastError ?? '', /database is locked/);
    assert.equal(tickJobStatus().find((j) => j.name === 'automations')!.failing, 0);
    assert.ok(warned.some((w) => /^loops: database is locked/.test(w)), 'the failure is logged under the job’s name');
  } finally {
    console.warn = warn;
    app.store.close();
    cleanup();
  }
});

test('X0 tick: a reminder that cannot be delivered does not stop the other jobs', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-22T12:00:00Z') });
  try {
    resetTickJobs();
    let ran = 0;
    Object.assign(app, { automations: { due: () => void ran++ } });
    const planner = { dueReminders: () => { throw new Error('bad row'); } };
    const s = new ReminderScheduler(app, planner as never);
    assert.throws(() => s.tick(), /bad row/);
    assert.equal(ran, 1);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('X0 tick: a rejected promise is a failure too; a good run clears it; repeats are not logged every time', async () => {
  resetTickJobs();
  const warn = console.warn;
  let lines = 0;
  console.warn = () => void lines++;
  try {
    for (let i = 0; i < 20; i++) tickJob('flaky', () => Promise.reject(new Error('no')));
    await new Promise((r) => setImmediate(r));
    assert.equal(tickJobsFailing()[0]?.failing, 20);
    assert.ok(lines <= 6, `20 failures in a row logged ${lines} times`);
    tickJob('flaky', () => 'fine');
    assert.deepEqual(tickJobsFailing(), []);
  } finally {
    console.warn = warn;
  }
});
