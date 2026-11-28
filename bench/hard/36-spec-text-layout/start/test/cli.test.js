import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';

function run(argv) {
  let out = '';
  let err = '';
  const code = main(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

function withFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'boxtext-'));
  try {
    const file = join(dir, 'table.json');
    writeFileSync(file, content);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cli: prints a table and overrides the style', () => {
  const table = JSON.stringify({ columns: [{ header: 'A' }, { header: 'B' }], rows: [['x', 'y']] });
  withFile(table, (file) => {
    const r = run([file, '--style', 'none']);
    assert.equal(r.code, 0);
    assert.equal(r.out, 'A  B\n-  -\nx  y\n');
  });
});

test('cli: exit codes', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['--help']).code, 0);
  withFile('{ not json', (file) => assert.equal(run([file]).code, 3));
  withFile(JSON.stringify({ columns: [] }), (file) => {
    const r = run([file]);
    assert.equal(r.code, 1);
    assert.match(r.err, /columns/);
  });
});
