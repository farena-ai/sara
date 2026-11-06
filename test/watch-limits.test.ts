// E4 slices 1-2: the hard limits. 5 active / 10 total watches, 5 literal patterns of 2-80 characters
// (regex characters are plain text), a 5-minute floor, Check now at most every 10 s, at most one
// ping per watch per 10 minutes and 12 a day, a 6-hour dedupe window and a 14-day / 200-row sweep.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WATCH, WatchError } from '../src/watch.ts';
import { watchRig } from './watch-fixture.ts';

const status = (f: () => unknown): number => {
  try {
    f();
    return 200;
  } catch (e) {
    if (e instanceof WatchError) return e.status;
    throw e;
  }
};

test('watch limits: 5 active and 10 in all; 5 patterns of 2-80 characters; interval 5 min to 24 h', (t) => {
  const r = watchRig(t);
  for (let i = 0; i < 11; i++) r.file(`f${i}.log`);
  const made = [0, 1, 2, 3, 4].map((i) => r.add(`f${i}.log`));
  assert.equal(status(() => r.add('f5.log')), 409, '6th active');
  r.w.pause(made[0].id);
  assert.equal(status(() => r.w.resume(made[0].id)), 200);
  for (const m of made) r.w.pause(m.id);
  for (let i = 5; i < 10; i++) r.add(`f${i}.log`);
  for (const m of r.w.list().filter((x) => x.state === 'active')) r.w.pause(m.id);
  assert.equal(status(() => r.add('f10.log')), 409, '11th in all');
  assert.equal(status(() => r.w.resume(made[0].id)), 200);
  const r2 = watchRig(t);
  r2.file('a.log');
  assert.equal(status(() => r2.add('a.log', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])), 400, '6th pattern');
  assert.equal(status(() => r2.add('a.log', ['x'])), 400, 'too short');
  assert.equal(status(() => r2.add('a.log', ['x'.repeat(81)])), 400, 'too long');
  assert.equal(status(() => r2.add('a.log', [])), 400, 'none');
  assert.equal(status(() => r2.add('a.log', ['ERROR'], { everyMin: 2 })), 400, 'under the floor');
  assert.equal(status(() => r2.add('a.log', ['ERROR'], { everyMin: 24 * 60 + 1 })), 400, 'over a day');
  assert.equal(r2.add('a.log').everyMin, 15, 'default 15 minutes');
  assert.equal(WATCH.everyMinFloor, 5);
});

test('watch limits: regex characters are taken literally', (t) => {
  const r = watchRig(t);
  r.file('a.log');
  const w = r.add('a.log', ['a.b*', '(x|y)']);
  r.append('a.log', 'axbbb\nsaw a.b* here\nx\n(x|y) too\n');
  assert.deepEqual(r.w.check(w.id).matched, ['saw a.b* here', '(x|y) too']);
});

test('watch limits: Check now at most once per 10 seconds', (t) => {
  const r = watchRig(t);
  r.file('a.log', 'ERROR earlier\n');
  const w = r.add('a.log');
  const first = r.w.checkNow(w.id);
  assert.deepEqual(first.preview, ['ERROR earlier'], 'the preview reads the tail once');
  assert.equal(r.pushes.length, 0, 'a preview never pings');
  assert.equal(status(() => r.w.checkNow(w.id)), 429);
  r.clock.now = new Date(r.clock.now.getTime() + 11_000);
  assert.equal(status(() => r.w.checkNow(w.id)), 200);
});

test('watch limits: one ping per watch per 10 minutes (the rest fold into the next), 12 a day', (t) => {
  const r = watchRig(t);
  r.file('a.log');
  const w = r.add('a.log', ['ERROR'], { everyMin: 5 });
  r.append('a.log', 'ERROR one\n');
  r.later(5);
  assert.equal(r.pushes.length, 1);
  r.append('a.log', 'ERROR two\n');
  r.later(5);
  assert.equal(r.pushes.length, 1, 'inside 10 minutes: held');
  r.later(5);
  assert.equal(r.pushes.length, 2, 'then one ping for what was held');
  assert.match(r.pushes[1].text, /ERROR two/);
  for (let i = 0; i < 20; i++) {
    r.append('a.log', `ERROR kind ${'abcdefghijklmnopqrstuvwxyz'[i]}\n`);
    r.later(10);
  }
  const today = r.pushes.filter((p) => p.tag.startsWith(`watch-${w.id}`)).length;
  assert.equal(today, WATCH.pingsPerDay, 'daily cap across all watches');
});

test('watch limits: the same line inside 6 hours counts up instead of a new alert', (t) => {
  const r = watchRig(t);
  r.file('a.log');
  const w = r.add('a.log', ['ERROR'], { everyMin: 5 });
  r.append('a.log', 'ERROR timeout after 30s on 10.0.0.1\n');
  r.later(5);
  r.append('a.log', 'ERROR timeout after 45s on 10.0.0.2\n');
  r.later(15);
  let alerts = r.w.alerts(w.id);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 2);
  assert.equal(r.pushes.length, 1, 'no new ping for a repeat');
  r.later(6 * 60 + 5);
  r.append('a.log', 'ERROR timeout after 50s on 10.0.0.3\n');
  r.later(5);
  alerts = r.w.alerts(w.id);
  assert.equal(alerts.length, 2, 'after 6 hours it is new again');
});

test('watch limits: alerts are kept 14 days and at most 200 per watch', (t) => {
  const r = watchRig(t);
  r.file('a.log');
  const w = r.add('a.log', ['ERROR'], { everyMin: 5 });
  r.append('a.log', Array.from({ length: 210 }, (_, i) => `ERROR case ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}\n`).join(''));
  r.later(5);
  assert.equal(r.w.alerts(w.id).length, 200);
  r.later(15 * 24 * 60);
  assert.equal(r.w.alerts(w.id).length, 0);
});
