// The shared Windows process list (complete or empty, with a deadline a loaded PC still meets) and
// the tree kill that falls back to ending the process itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { killTreeWindows, parseWinProcesses, windowsProcesses } from '../src/win-processes.ts';

const WIN = process.platform === 'win32';

test('process list lines: pid and parent, with or without the creation time; noise skipped', () => {
  assert.deepEqual(parseWinProcesses('4 0\r\n\r\nGet-CimInstance : Call cancelled\r\n 812 4 \r\nx y\r\n', false), [
    { pid: 4, ppid: 0, createdMs: NaN },
    { pid: 812, ppid: 4, createdMs: NaN },
  ]);
  assert.deepEqual(parseWinProcesses('812 4 1762650000000\n900 812\n', true), [{ pid: 812, ppid: 4, createdMs: 1762650000000 }]);
});

test('the real list is complete (it has this process and its parent) or nothing at all', { skip: !WIN && 'Windows only', timeout: 180_000 }, async () => {
  const list = await windowsProcesses({ withCreation: true });
  const self = list.find((p) => p.pid === process.pid);
  assert.ok(self, 'this process is in the list');
  assert.equal(self.ppid, process.ppid);
  assert.ok(Number.isFinite(self.createdMs) && self.createdMs <= Date.now());
  const stopped = new AbortController();
  stopped.abort();
  assert.deepEqual(await windowsProcesses({ signal: stopped.signal }), [], 'a stopped ask answers nothing');
});

test('a tree kill ends the process and what it started', { skip: !WIN && 'Windows only', timeout: 180_000 }, async () => {
  // A parent that starts a child and prints the child's id; both would live 60 s.
  const parent = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log('CHILD '+c.pid);setTimeout(()=>{},60000)"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const child = await new Promise<number>((resolve, reject) => {
    let out = '';
    parent.stdout.on('data', (d: Buffer) => {
      out += String(d);
      const m = /CHILD (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    parent.on('exit', () => reject(new Error(`the parent ended early: ${out}`)));
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.ok(alive(child));
    await killTreeWindows(parent.pid!);
    const until = Date.now() + 30_000;
    while ((alive(parent.pid!) || alive(child)) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(parent.pid!), false, 'the parent is gone');
    assert.equal(alive(child), false, 'its child is gone');
  } finally {
    for (const pid of [child, parent.pid!]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});
