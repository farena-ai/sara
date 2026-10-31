import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyStarter, listStarters, STARTERS_DIR } from '../src/starters.ts';

const python = process.platform === 'win32' ? 'python' : 'python3';
// A real Python (on a Mac without the Xcode Command Line Tools, /usr/bin/python3 is only a stub).
const HAS_PYTHON = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;

function runPython(folder: string, args: string[], input?: string) {
  return spawnSync(python, args, {
    cwd: folder,
    encoding: 'utf8',
    input,
    maxBuffer: 1_000_000,
    timeout: 10_000,
  });
}

test('starter metadata uses the native Python command on Windows and keeps Node commands unchanged', () => {
  const windows = listStarters(STARTERS_DIR, 'win32');
  const pythonWindows = windows.find((starter) => starter.name === 'python-cli')!;
  assert.equal(pythonWindows.test, 'python -m unittest');
  assert.equal(pythonWindows.run, 'python cli.py --help');

  const unix = listStarters(STARTERS_DIR, 'darwin');
  const pythonUnix = unix.find((starter) => starter.name === 'python-cli')!;
  assert.equal(pythonUnix.test, 'python3 -m unittest');
  assert.equal(pythonUnix.run, 'python3 cli.py --help');
  assert.equal(windows.find((starter) => starter.name === 'cli-tool')!.test, 'node --test');
  assert.equal(windows.find((starter) => starter.name === 'cli-tool')!.run, 'node cli.js --help');
});

test('Python CLI starter: copies a tested dependency-free project and handles files, stdin, help and errors', { skip: !HAS_PYTHON && `${python} not installed` }, (t) => {
  assert.ok(listStarters().some((starter) => starter.name === 'python-cli'), 'python-cli is registered with the starter path');

  const root = mkdtempSync(join(tmpdir(), 'sara-python-starter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { folder, starter: metadata } = copyStarter(root, 'python-cli', 'Example_Project');
  assert.equal(metadata.language, 'Python');
  assert.equal(metadata.test, `${python} -m unittest`);
  assert.equal(metadata.run, `${python} cli.py --help`);
  assert.equal(existsSync(join(folder, 'starter.json')), false);

  assert.deepEqual(
    ['README.md', 'CUSTOMISE.md', 'cli.py', 'lib.py', 'test_lib.py'].map((name) => join(folder, name)).filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    }).map((path) => path.slice(folder.length + 1)),
    ['README.md', 'CUSTOMISE.md', 'cli.py', 'lib.py', 'test_lib.py'],
  );
  assert.match(readFileSync(join(folder, 'README.md'), 'utf8'), /^# Example_Project/);
  assert.equal(readFileSync(join(folder, 'cli.py'), 'utf8').includes('__PROJECT_NAME__'), false);
  assert.equal(readFileSync(join(folder, 'lib.py'), 'utf8').includes('__PROJECT_NAME__'), false);

  const unittest = runPython(folder, ['-m', 'unittest', 'discover']);
  assert.equal(unittest.status, 0, `${unittest.stdout}\n${unittest.stderr}`);

  writeFileSync(join(folder, 'notes.txt'), 'hello world\nhello\n');
  const file = runPython(folder, ['cli.py', '--json', 'notes.txt']);
  assert.equal(file.status, 0, `${file.stdout}\n${file.stderr}`);
  assert.deepEqual(JSON.parse(file.stdout), { file: 'notes.txt', lines: 2, words: 3, chars: 18 });

  const stdin = runPython(folder, ['cli.py', '--json'], 'one two\nthree\n');
  assert.equal(stdin.status, 0, `${stdin.stdout}\n${stdin.stderr}`);
  assert.deepEqual(JSON.parse(stdin.stdout), { file: '-', lines: 2, words: 3, chars: 14 });

  const help = runPython(folder, ['cli.py', '--help']);
  assert.equal(help.status, 0, `${help.stdout}\n${help.stderr}`);
  assert.match(help.stdout, /usage:.*cli\.py/i);
  assert.match(help.stdout, /--json/);

  const badUsage = runPython(folder, ['cli.py', '--not-a-real-option']);
  assert.equal(badUsage.status, 2, `${badUsage.stdout}\n${badUsage.stderr}`);
  assert.match(badUsage.stderr, /usage:|unrecognized|unknown/i);

  const missing = runPython(folder, ['cli.py', 'missing.txt']);
  assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
  assert.match(missing.stderr, /missing|no such file|not found/i);
});
