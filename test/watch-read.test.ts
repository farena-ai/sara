// E4 slice 1: the reader. New lines only, a partial line waits, rotation and truncation start the
// new file at 0 (no replay), the first enable starts at the end, a flood is skipped with a note and
// long lines are cut.
import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WATCH } from '../src/watch.ts';
import { watchRig } from './watch-fixture.ts';

test('watch read: the first enable starts at the end of the file; appended matching lines are found', (t) => {
  const r = watchRig(t);
  r.file('app.log', 'ERROR old one\nfine\n');
  const w = r.add('app.log');
  assert.equal(w.state, 'active');
  assert.deepEqual(r.w.check(w.id).matched, [], 'no backlog flood');
  r.append('app.log', 'all good\nERROR disk full\nerror lower case\n');
  assert.deepEqual(r.w.check(w.id).matched, ['ERROR disk full']);
  assert.deepEqual(r.w.check(w.id).matched, [], 'read once');
});

test('watch read: case-insensitive is optional; a partial last line waits for its newline', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  const w = r.add('app.log', ['disk full'], { caseIns: true });
  r.append('app.log', 'DISK FULL on /var\nERROR par');
  assert.deepEqual(r.w.check(w.id).matched, ['DISK FULL on /var']);
  r.append('app.log', 'tial disk full\n');
  assert.deepEqual(r.w.check(w.id).matched, ['ERROR partial disk full'], 'the held part joins the rest');
});

test('watch read: rotation (a new file) restarts at 0 with one note and no replay', (t) => {
  const r = watchRig(t);
  r.file('app.log', 'ERROR before\n');
  const w = r.add('app.log');
  renameSync(join(r.ws, 'app.log'), join(r.ws, 'app.log.1'));
  writeFileSync(join(r.ws, 'app.log'), 'ERROR fresh\n');
  const c = r.w.check(w.id);
  assert.equal(c.note, 'rotated');
  assert.deepEqual(c.matched, ['ERROR fresh']);
  assert.equal(r.w.check(w.id).note, undefined, 'one note');
});

test('watch read: truncation (size below the offset) restarts at 0', (t) => {
  const r = watchRig(t);
  r.file('app.log', `${'x'.repeat(500)}\n`);
  const w = r.add('app.log');
  writeFileSync(join(r.ws, 'app.log'), 'ERROR after truncate\n');
  const c = r.w.check(w.id);
  assert.equal(c.note, 'rotated');
  assert.deepEqual(c.matched, ['ERROR after truncate']);
});

test('watch read: more than 256 KB waiting is skipped to the last 256 KB with a note', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  const w = r.add('app.log');
  r.append('app.log', `ERROR too old\n${'noise line\n'.repeat(30_000)}ERROR newest\n`);
  const c = r.w.check(w.id);
  assert.equal(WATCH.readCap, 256 * 1024);
  assert.equal(c.note, 'skipped');
  assert.ok((c.skippedKb ?? 0) > 0);
  assert.deepEqual(c.matched, ['ERROR newest'], 'only what is inside the cap');
});

test('watch read: a line over 4 KB is cut; the kept alert line is 300 characters', (t) => {
  const r = watchRig(t);
  r.file('app.log');
  const w = r.add('app.log');
  r.append('app.log', `ERROR ${'y'.repeat(10_000)}\n`);
  const c = r.w.check(w.id);
  assert.equal(c.matched.length, 1);
  assert.equal(c.matched[0].length, WATCH.lineCap);
  assert.equal(WATCH.lineCap, 4096);
  const [a] = r.w.alerts(w.id);
  assert.ok(a.line.length <= 300, String(a.line.length));
});
