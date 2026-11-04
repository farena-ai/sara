import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createBackup, restoreBackup } from '../src/backup.ts';
import { deliveryFor } from '../src/delivery.ts';
import { makeApp, tempDir, ROOT } from './helpers.ts';
import { evaluateQualification, latencySummary, parseQualificationArgs } from '../scripts/qualify-operations.ts';

test('Q4 qualification CLI accepts an output file, never a target URL or data directory', () => {
  assert.deepEqual(parseQualificationArgs(['--output', 'outputs/lab/report.json']), { output: 'outputs/lab/report.json' });
  for (const args of [['--target', 'https://example.invalid'], ['--data', '/private'], ['--requests', '1'], ['--output'], ['--output', 'x', '--output', 'y']]) {
    assert.throws(() => parseQualificationArgs(args));
  }
});

test('Q4 archived deduplication and unresolved encrypted reviews survive a four-space restore', () => {
  const { dir, cleanup } = tempDir();
  const spaces = ['', 'companions/fixture-companion', 'members/fixture-member', 'members/fixture-member/companions/fixture-companion'];
  const source = join(dir, 'source');
  const expected: { id: string; unresolved: string; key: string }[] = [];
  try {
    for (const [i, rel] of spaces.entries()) {
      mkdirSync(join(source, rel), { recursive: true });
      const app = makeApp(join(source, rel), { now: new Date() });
      try {
        const store = deliveryFor(app);
        const key = `fixture-preserved-key-${i}`;
        const id = store.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '777', logicalKey: key }).id;
        store.attempt(id); store.acknowledge(id, ['9001']);
        app.store.db.prepare('UPDATE deliveries SET updated_at=?,created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', id);
        const unresolved = store.enqueue({ bridge: 'discord', operation: 'sendMessage', destination: '888', review: { text: `Synthetic uncertain review ${i}` } }).id;
        store.attempt(unresolved); store.unknown(unresolved);
        assert.equal(store.archive('2026-02-01T00:00:00.000Z').archived, 1);
        expected.push({ id, unresolved, key });
      } finally { app.store.close(); }
    }
    const archive = join(dir, 'restore-drill.tar.gz');
    createBackup(source, archive, { saraVersion: 'q4-fixture' });
    const restored = join(dir, 'restored');
    restoreBackup(archive, restored);
    for (const [i, rel] of spaces.entries()) {
      const app = makeApp(join(restored, rel), { now: new Date() });
      try {
        const store = deliveryFor(app);
        assert.equal(store.page({ filter: 'archived' }).deliveries[0].id, expected[i].id);
        assert.equal(store.page().deliveries.length, 1);
        assert.equal(store.review(expected[i].unresolved).text, `Synthetic uncertain review ${i}`);
        assert.throws(() => store.attempt(expected[i].id));
        assert.throws(() => store.enqueue({ bridge: 'telegram', operation: 'sendMessage', destination: '777', logicalKey: expected[i].key }));
        assert.equal(app.providerCalls, 0);
      } finally { app.store.close(); }
    }
  } finally { cleanup(); }
});

test('Q4 latency report uses nearest rank and refuses empty or invalid evidence', () => {
  assert.deepEqual(latencySummary([8, 1, 3, 2]), { count: 4, p50Ms: 2, p95Ms: 8, maxMs: 8 });
  assert.throws(() => latencySummary([]));
  for (const v of [NaN, Infinity, -1]) assert.throws(() => latencySummary([v]));
});

test('Q4 qualification records transport failures and settles clients before exiting', { timeout: 30000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const output = join(dir, 'failed-report.json');
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/q4-fetch-failure.mjs')).href, join(ROOT, 'scripts/qualify-operations.ts'), '--output', output], { cwd: ROOT, windowsHide: true, timeout: 25000, maxBuffer: 4 * 1024 * 1024 }));
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.failed, true);
    assert.ok(report.partial.unexpectedErrors > 0);
    assert.ok(report.failures.length > 0);
    assert.equal(report.failureStage, 'load');
    assert.equal(JSON.stringify(report).includes('Synthetic transport failure'), false);
  } finally { cleanup(); }
});

test('Q4 qualification saves failure evidence after an asynchronous bind error', { timeout: 15000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const output = join(dir, 'failed-listen.json');
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/q4-listen-failure.mjs')).href, join(ROOT, 'scripts/qualify-operations.ts'), '--output', output], { cwd: ROOT, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }));
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.failed, true);
    assert.equal(report.failureStage, 'listen');
    assert.equal(report.partial.requests, 0);
    assert.equal(report.partial.unexpectedErrors, 0);
  } finally { cleanup(); }
});

test('Q4 live measurement is captured before the separate offline restore drill', { timeout: 45000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const output = join(dir, 'window-report.json');
    // Resource gates are evaluated by the manual profile; a busy parallel test host may fail them.
    await promisify(execFile)(process.execPath, ['--import', pathToFileURL(join(ROOT, 'test/fixtures/q4-measurement-window.mjs')).href, join(ROOT, 'scripts/qualify-operations.ts'), '--output', output], { cwd: ROOT, windowsHide: true, timeout: 40000, maxBuffer: 4 * 1024 * 1024 }).catch(() => {});
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.failed, undefined, 'the fixture must complete every workload and restore phase');
    assert.equal(report.operations.fixtureRestoreSeen, false, 'offline restore must not enter the live histogram');
    assert.equal(report.profile, 'synthetic-loopback-v2-live');
    assert.equal(report.measurementWindow, 'live-upload-reads-backup-archive');
    assert.equal(report.evidence.requests, 400);
    assert.equal(report.evidence.backupVerified, true);
    assert.ok(Number.isFinite(report.restoreMs) && report.restoreMs >= 0);
  } finally { cleanup(); }
});

test('Q4 engineering gates fail missing samples, unexpected failures, resource excess and lost evidence', () => {
  const good = { requests: 400, unexpectedErrors: 0, p95Ms: 40, eventLoopSamples: 10, eventLoopP95Ms: 10, rssGrowthBytes: 1000, seededTerminal: 10000, archived: 10000, unresolvedBefore: 100, unresolvedAfter: 100, backupVerified: true, uploadVerified: true, providerCalls: 0 };
  assert.equal(evaluateQualification(good).passed, true);
  for (const patch of [{ requests: 399 }, { unexpectedErrors: 1 }, { p95Ms: 501 }, { eventLoopSamples: 0 }, { eventLoopP95Ms: 101 }, { rssGrowthBytes: 256 * 1024 * 1024 + 1 }, { seededTerminal: 9999 }, { archived: 9999 }, { unresolvedAfter: 99 }, { backupVerified: false }, { uploadVerified: false }, { providerCalls: 1 }, { p95Ms: NaN }]) {
    assert.equal(evaluateQualification({ ...good, ...patch }).passed, false, JSON.stringify(patch));
  }
});
