// E4 slice 1: watches ride the reminder scheduler's existing tick (no timer, no fs.watch, no OS
// cron), come back paused after a restart, and Stop ends checks at once. A missing file pauses the
// watch after 3 checks with one notice; a watch ends after 30 days unless renewed.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ReminderScheduler } from '../src/reminders.ts';
import { Watches } from '../src/watch.ts';
import { ROOT } from './helpers.ts';
import { watchRig } from './watch-fixture.ts';

test('watch scheduler: the reminder tick runs due watches; watch.ts has no timer of its own', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  r.add('app.log', ['ERROR'], { everyMin: 5 });
  const sched = new ReminderScheduler(r.app, r.app.planner!);
  r.append('app.log', 'ERROR from the tick\n');
  sched.tick();
  assert.equal(r.pushes.length, 0, 'not due yet');
  r.clock.now = new Date(r.clock.now.getTime() + 5 * 60_000);
  sched.tick();
  assert.equal(r.pushes.length, 1);
  const src = readFileSync(join(ROOT, 'src', 'watch.ts'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout|fs\.watch|watchFile|\bwatch\(|crontab|schtasks/);
});

test('watch scheduler: after a restart every watch comes back paused', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  const w = r.add('app.log');
  const again = new Watches(r.app, r.app.store.db);
  const back = again.get(w.id)!;
  assert.equal(back.state, 'paused');
  assert.equal(back.reason, 'restart');
  r.append('app.log', 'ERROR while paused\n');
  r.clock.now = new Date(r.clock.now.getTime() + 60 * 60_000);
  assert.equal(again.due(r.clock.now), 0);
});

test('watch scheduler: Stop ends checks immediately; Stop and forget deletes its alerts', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  const w = r.add('app.log', ['ERROR'], { everyMin: 5 });
  r.append('app.log', 'ERROR one\n');
  r.later(5);
  assert.equal(r.w.alerts(w.id).length, 1);
  r.w.stop(w.id);
  const at = r.w.get(w.id)!.lastCheckAt;
  r.append('app.log', 'ERROR after stop\n');
  assert.equal(r.later(30), 0);
  assert.equal(r.w.get(w.id)!.lastCheckAt, at);
  assert.equal(r.pushes.length, 1);
  r.w.forget(w.id);
  assert.equal(r.w.get(w.id), undefined);
  assert.equal(r.w.alerts(w.id).length, 0);
});

test('watch scheduler: missing 3 checks running pauses with one notice; 30 days ends it', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  r.file('b.log');
  const w = r.add('app.log', ['ERROR'], { everyMin: 5 });
  const b = r.add('b.log', ['ERROR'], { everyMin: 5 });
  rmSync(join(r.ws, 'app.log'));
  r.later(5);
  r.later(5);
  assert.equal(r.w.get(w.id)!.state, 'active');
  r.later(5);
  assert.equal(r.w.get(w.id)!.state, 'paused');
  assert.equal(r.w.get(w.id)!.reason, 'missing');
  assert.equal(r.pushes.filter((p) => p.tag === `watch-${w.id}-paused`).length, 1);
  r.later(30 * 24 * 60);
  assert.equal(r.w.get(b.id)!.state, 'stopped');
  assert.equal(r.w.get(b.id)!.reason, 'ended');
});
