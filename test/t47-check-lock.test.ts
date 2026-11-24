// T47 D5: one `npm run check` at a time per folder (scripts/check.ts). In 3.41.0 a release gate ran
// twice in one worktree and into one log. The lock is outputs/check.lock with the process id.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pidAlive, readLock, refusal, releaseLock, takeLock } from '../scripts/check.ts';
import { ROOT, tempDir } from './helpers.ts';

const SCRIPT = join(ROOT, 'scripts', 'check.ts');
const run = (lock: string, steps: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, `--lock=${lock}`, `--steps=${steps}`], { encoding: 'utf8', timeout: 120_000 });
/** The id of a process that has ended. */
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

test('T47 check lock: package.json runs the check through the lock', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.check, 'node scripts/check.ts');
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /\['npm run typecheck', 'npm test'\]/, 'the same two steps as before');
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^outputs\/$/m, 'the lock is never committed');
});

test('T47 check lock: a live holder refuses a second check; the holder alone can release it', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const lock = join(dir, 'outputs', 'check.lock');
  assert.deepEqual(takeLock(lock, 1001, () => true), { ok: true });
  assert.equal(readLock(lock)!.pid, 1001);
  const second = takeLock(lock, 1002, () => true);
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.holder.pid, 1001);
  assert.equal(readLock(lock)!.pid, 1001, 'the refused one did not touch the lock');
  releaseLock(lock, 1002);
  assert.ok(existsSync(lock), 'only the holder removes it');
  releaseLock(lock, 1001);
  assert.equal(existsSync(lock), false);
  assert.match(refusal(lock, { pid: 1001, started: '2026-11-24T10:00:00.000Z' }), /^Another check is running in this folder \(process 1001, started 2026-11-24T10:00:00\.000Z\)\. Wait for it to end, or run this one in another worktree\./);
});

test('T47 check lock: a lock whose process is gone, or that can not be read, is ignored', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const lock = join(dir, 'outputs', 'check.lock');
  const gone = deadPid()!;
  assert.equal(pidAlive(gone), false);
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(Number.NaN), false);
  assert.deepEqual(takeLock(lock, gone), { ok: true });
  assert.deepEqual(takeLock(lock), { ok: true }, 'stale: taken over');
  assert.equal(readLock(lock)!.pid, process.pid);
  writeFileSync(lock, 'not json');
  assert.deepEqual(takeLock(lock), { ok: true }, 'unreadable: taken over');
  assert.equal(readLock(lock)!.pid, process.pid);
});

test('T47 check lock: the real command stops with one plain line while another holds the lock, runs its steps otherwise, and leaves no lock behind', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const lock = join(dir, 'outputs', 'check.lock');
  const marker = join(dir, 'ran.txt').replace(/\\/g, '/');
  const write = `node -e "require('fs').appendFileSync('${marker}','x')"`;
  // This test process holds it: the command must not start a step.
  assert.deepEqual(takeLock(lock), { ok: true });
  const refused = run(lock, write);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, new RegExp(`^Another check is running in this folder \\(process ${process.pid}, `));
  assert.equal(refused.stderr.trim().split('\n').length, 1);
  assert.equal(existsSync(marker), false, 'no step ran');
  assert.equal(readLock(lock)!.pid, process.pid, 'the lock is still the first one\'s');
  releaseLock(lock);
  // Free: both steps run in order; the lock is there during a step and gone after.
  const during = join(dir, 'during.txt').replace(/\\/g, '/');
  const copy = `node -e "require('fs').copyFileSync('${lock.replace(/\\/g, '/')}','${during}')"`;
  const ok = run(lock, `${write};;${copy};;${write}`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(marker, 'utf8'), 'xx');
  assert.equal(typeof (JSON.parse(readFileSync(during, 'utf8')) as { pid: number }).pid, 'number', 'held while the steps ran');
  assert.equal(existsSync(lock), false, 'removed at the end');
  // A failing step: its exit code, the later step is not run, the lock is removed.
  const bad = run(lock, `node -e "process.exit(7)";;${write}`);
  assert.equal(bad.status, 7);
  assert.equal(readFileSync(marker, 'utf8'), 'xx');
  assert.equal(existsSync(lock), false);
});
