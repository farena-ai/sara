import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, tempDir } from './helpers.ts';
import { deliveryFor } from '../src/delivery.ts';
import { makeApp } from './helpers.ts';
import { assertSoakRecovery, evaluateSoak, parseSoakArgs } from '../scripts/qualify-soak.ts';

test('soak CLI cannot select installed data, a target, or a reduced duration', () => {
  assert.deepEqual(parseSoakArgs([]), { output: 'outputs/qualification/soak.json' });
  assert.deepEqual(parseSoakArgs(['--output', 'outputs/lab.json']), { output: 'outputs/lab.json' });
  for (const args of [['--target', 'https://example.invalid'], ['--data', '/private'], ['--seconds', '1'], ['--output'], ['--output', '--data'], ['--output', 'x', '--output', 'y']]) assert.throws(() => parseSoakArgs(args));
});

const good = () => ({ durationMs: 600001, windows: Array.from({ length: 10 }, () => ({ requests: 2000, p95Ms: 25 })), unexpectedErrors: 0, eventLoopSamples: 100, eventLoopP95Ms: 20, rssGrowthBytes: 8 * 1024 ** 2, backups: 10, restored: 10, unresolvedPreserved: true, payloadVerified: true, providerCalls: 0 });

test('soak requires actual duration, every time window and complete independent recovery evidence', () => {
  assert.equal(evaluateSoak(good()).passed, true);
  const failures = [
    { durationMs: 599999 }, { windows: good().windows.slice(1) },
    { windows: [...good().windows.slice(1), { requests: 99, p95Ms: 1 }] },
    { windows: [...good().windows.slice(1), { requests: 2000, p95Ms: 501 }] },
    { windows: [...good().windows.slice(1), { requests: 2000, p95Ms: NaN }] },
    { unexpectedErrors: 1 }, { eventLoopSamples: 0 }, { eventLoopP95Ms: 101 },
    { eventLoopP95Ms: Infinity }, { rssGrowthBytes: 257 * 1024 ** 2 },
    { rssGrowthBytes: -1 }, { backups: 9 }, { restored: 9 },
    { unresolvedPreserved: false }, { payloadVerified: false }, { providerCalls: 1 },
  ];
  for (const changed of failures) assert.equal(evaluateSoak({ ...good(), ...changed }).passed, false, JSON.stringify(changed));
});

test('soak seeds real fresh data and preserves a sanitized failed receipt on asynchronous bind failure', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const output = join(dir, 'failed.json');
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/q4-listen-failure.mjs')).href, join(ROOT, 'scripts/qualify-soak.ts'), '--output', output], { cwd: ROOT, windowsHide: true, timeout: 20000 }));
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.failureStage, 'listen');
    assert.equal(report.completedBackups, 0);
    assert.equal(JSON.stringify(report).includes('Bearer'), false);
    assert.equal(JSON.stringify(report).includes(dir), false);
  } finally { cleanup(); }
});

test('soak restoration rejects changed uncertainty, identity, resolution and retry metadata', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  try {
    const deliveries = deliveryFor(app);
    for (let i = 0; i < 100; i++) {
      const id = deliveries.enqueue({ bridge: 'discord', operation: 'sendMessage', destination: '888', logicalKey: `soak-unknown-${i}`, review: { text: 'Synthetic uncertainty' } }).id;
      deliveries.attempt(id); deliveries.unknown(id);
    }
    const expected = app.store.db.prepare("SELECT * FROM deliveries WHERE logical_key LIKE 'soak-unknown-%' ORDER BY id").all();
    assertSoakRecovery(app.store.db, expected);
    const changes = ["state='acknowledged'", "state='queued'", "resolution='dismissed'", 'held=1', 'attempts=9', "nonce='changed'", "logical_key='foreign'", "archived_at='2020-01-01T00:00:00.000Z'", 'payload=NULL'];
    for (const change of changes) {
      app.store.db.exec('BEGIN');
      try {
        app.store.db.prepare(`UPDATE deliveries SET ${change} WHERE id=?`).run(expected[0].id);
        assert.throws(() => assertSoakRecovery(app.store.db, expected), change);
      } finally { app.store.db.exec('ROLLBACK'); }
    }
  } finally { app.store.close(); cleanup(); }
});

test('soak cancels its next minute sleep and writes a failed receipt after a post-backup read failure', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const output = join(dir, 'failed.json');
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/soak-after-backup-failure.mjs')).href, join(ROOT, 'scripts/qualify-soak.ts'), '--output', output], { cwd: ROOT, windowsHide: true, timeout: 15000 }));
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.failureStage, 'live');
    assert.ok(report.completedBackups >= 1);
    assert.ok(report.unexpectedErrors > 0);
  } finally { cleanup(); }
});

test('soak waits for an accepted worker exit before writing the failed HTTP-abort receipt', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const output = join(dir, 'failed.json');
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/soak-worker-abort.mjs')).href, join(ROOT, 'scripts/qualify-soak.ts'), '--output', output], { cwd: ROOT, windowsHide: true, timeout: 15000 }));
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.failureStage, 'live');
    assert.equal(report.fixtureWorkerOnline, true, 'a real backup worker was accepted');
    assert.equal(report.fixtureWorkerExitObserved, true, 'receipt cannot precede the accepted worker exit');
  } finally { cleanup(); }
});
