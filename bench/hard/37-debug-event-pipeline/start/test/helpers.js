import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli/main.js';

/** A temporary folder, removed by cleanup(). */
export function tempDir(prefix = 'relay-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Events e1..eN; key(i) gives each one's key (default: all different). */
export function events(n, key = (i) => `k${i}`, data = () => null) {
  return Array.from({ length: n }, (_, k) => ({ id: `e${k + 1}`, key: key(k + 1), data: data(k + 1) }));
}

export function cli(cwd, ...argv) {
  let out = '';
  let err = '';
  const code = run(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), cwd });
  return { code, out, err };
}
