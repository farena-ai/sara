import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('integrated operator fixture proves real CLI no-write, scoped API denial and fresh encrypted closed restore', () => {
  const checkout = resolve(import.meta.dirname, '..');
  assert.ok(existsSync(join(checkout, 'test/fixtures/business-operations.ts')), 'The synthetic operator integration fixture must exist');
  const output = mkdtempSync(join(realpathSync(tmpdir()), 'sara-operator-integration-'));
  try {
    const child = spawnSync(process.execPath, ['test/fixtures/business-operations.ts'], { cwd: checkout,
      env: { ...process.env, SARA_B4_OUTPUT: output }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stdout + child.stderr);
    const report = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8'));
    assert.equal(report.pass, true);
    assert.deepEqual(report.checks.map((check: { id: string }) => check.id), ['readonly-cli', 'scoped-invites', 'encrypted-restore']);
    const before = readFileSync(join(output, 'before-tree.json'));
    assert.deepEqual(readFileSync(join(output, 'after-tree.json')), before);
    assert.ok(report.checks[0].entries > 10); assert.equal(report.checks[1].denied, 6);
    assert.equal(report.checks[2].closed, true);
    assert.equal(readFileSync(join(output, 'generation.enc')).subarray(0, 8).toString(), 'SARABUS1');
  } finally { rmSync(output, { recursive: true, force: true }); }
});
