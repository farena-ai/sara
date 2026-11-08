import test from 'node:test';
import assert from 'node:assert/strict';
import { msysGroupWinPids } from '../src/tools/sandbox.ts';

// C2: on a busy Windows PC taskkill /T took 15-25 s (and often failed), so a stopped job kept
// running until it ended by itself. Stop now reads the shell's own process group from Git Bash's
// `ps` (no WMI) and ends each member directly; taskkill stays as the backstop for native grandchildren.
const PS = [
  '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
  '    15836       1   15836    1397952  ?         197609 03:47:17 /c/Program Files/nodejs/node',
  '    15901   15836   15836    1398001  ?         197609 03:47:18 /usr/bin/sleep',
  'S   15950   15836   15836    1398100  ?         197609 03:47:18 /usr/bin/cat',
  '    16002       1   16002    1399000  ?         197609 03:47:18 /usr/bin/bash',
  '  5607540       0       0    1413236  ?              0 03:47:18 C:\\Program Files\\Git\\bin\\bash.exe',
].join('\r\n');

test('msysGroupWinPids: the members of the shell\'s own process group, by Windows process id', () => {
  assert.deepEqual(msysGroupWinPids(PS, 15836, { self: 1, parent: 2 }), [1397952, 1398001, 1398100]);
  assert.deepEqual(msysGroupWinPids(PS, 16002, { self: 1, parent: 2 }), [1399000]);
});

test('msysGroupWinPids: never Sara herself or her parent, never group 0, nothing from junk', () => {
  assert.deepEqual(msysGroupWinPids(PS, 15836, { self: 1397952, parent: 2 }), [1398001, 1398100]);
  assert.deepEqual(msysGroupWinPids(PS, 15836, { self: 1, parent: 1398001 }), [1397952, 1398100]);
  assert.deepEqual(msysGroupWinPids(PS, 0, { self: 1, parent: 2 }), []);
  assert.deepEqual(msysGroupWinPids('', 15836, { self: 1, parent: 2 }), []);
  assert.deepEqual(msysGroupWinPids('garbage\nPID x y z\n', 15836, { self: 1, parent: 2 }), []);
});
