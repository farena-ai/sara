import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('manual aggregate preserves nonzero, missing, malformed and failed child receipts and continues', async () => {
  const entry = new URL('../scripts/qualify-business-operations.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'The manual qualification aggregate must exist');
  const { runSteps } = await import(entry.href);
  const scratch = mkdtempSync(join(tmpdir(), 'sara-qualification-receipts-'));
  try {
    const child = join(scratch, 'child.mjs');
    writeFileSync(child, `import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const mode = process.argv[2];
      console.log('exact child stdout ' + mode); console.error('exact child stderr ' + mode);
      if (mode !== 'missing') writeFileSync(join(process.env.SARA_B2_OUTPUT, 'results.json'),
        mode === 'malformed' ? '{bad json' : JSON.stringify({ results: [{ name: 'fixture', pass: mode !== 'failed' }], errors: [], limits: 'synthetic' }));
      if (mode === 'nonzero') process.exitCode = 7;`);
    const modes = ['nonzero', 'missing', 'malformed', 'failed', 'valid'];
    const output = join(scratch, 'run');
    const report = await runSteps(output, modes.map(id => ({ id, args: [child, id], envName: 'SARA_B2_OUTPUT', receipts: [{ file: 'results.json', kind: 'b2' }] })));
    assert.equal(report.pass, false); assert.equal(report.steps.length, 5);
    assert.deepEqual(report.steps.map((step: { pass: boolean }) => step.pass), [false, false, false, false, true]);
    assert.equal(report.steps[0].exitCode, 7);
    assert.equal(report.steps[1].receipts[0].exists, false);
    assert.match(report.steps[2].receipts[0].error, /JSON/);
    assert.match(report.steps[3].receipts[0].error, /pass/);
    for (const [index, step] of report.steps.entries()) {
      assert.deepEqual(step.command, [process.execPath, child, modes[index]]);
      assert.equal(readFileSync(join(output, step.stdout.file), 'utf8'), `exact child stdout ${modes[index]}\n`);
      assert.equal(readFileSync(join(output, step.stderr.file), 'utf8'), `exact child stderr ${modes[index]}\n`);
      if (step.receipts[0].exists) assert.equal(step.receipts[0].sha256, createHash('sha256').update(readFileSync(join(output, step.receipts[0].file))).digest('hex'));
    }
    assert.equal(readFileSync(join(output, 'malformed', 'results.json'), 'utf8'), '{bad json');
    const before = readFileSync(join(output, 'report.json'));
    await assert.rejects(runSteps(output, []), /exist/i);
    assert.deepEqual(readFileSync(join(output, 'report.json')), before, 'An existing receipt directory must never be overwritten');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('receipt validation rejects empty, page-error and invented success shapes', async () => {
  const entry = new URL('../scripts/qualify-business-operations.mjs', import.meta.url);
  assert.ok(existsSync(entry), 'The manual qualification aggregate must exist');
  const { validateReceipt } = await import(entry.href);
  assert.throws(() => validateReceipt('b2', { results: [], errors: [] }));
  assert.throws(() => validateReceipt('b2', { results: [{ name: 'x', pass: true }], errors: ['page error'] }));
  assert.throws(() => validateReceipt('b3', { results: [{ name: 'x', pass: true }], errors: [], isolated: true, closed: false }));
  assert.throws(() => validateReceipt('onboarding', { results: ['x'], pageErrors: ['page error'], limits: 'fixture' }));
  assert.throws(() => validateReceipt('anonymous', { initialFailures: [{}] }));
  assert.throws(() => validateReceipt('integration', { version: 1, pass: true, checks: [] }));
  assert.throws(() => validateReceipt('made-up', { pass: true }));
  assert.equal(validateReceipt('onboarding', { results: ['real check'], pageErrors: [], limits: 'fixture' }), 1);
  assert.equal(validateReceipt('anonymous', { initialFailures: [] }), 0);
});
