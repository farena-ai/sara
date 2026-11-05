import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts', 'qualify-project-checkpoints.ts');
const run = (args: string[], env?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true, env,
});

test('checkpoint package probe rejects data/output arguments before touching their targets', () => {
  const result = run([root, '--data', join(tmpdir(), 'never-used-sara-data')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:.*source-payload/);
});

test('checkpoint package probe uses selected source and its own fixture despite inherited data settings', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sara-checkpoint-cli-test-'));
  console.error('Retained synthetic inherited-data sentinel fixture:', fixture);
  const owner = join(fixture, 'untouched-data');
  mkdirSync(owner);
  writeFileSync(join(owner, 'sentinel'), 'Synthetic data must remain untouched.');
  const result = run([root], { ...process.env, SARA_DATA: owner, SARA_PROFILE: 'business' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.spaces, 4);
  assert.equal(report.workspaceScopes, 4);
  assert.equal(report.eligibleCheckpointSpaces, 2);
  assert.equal(report.memberSpacesDenied, 2);
  assert.equal(report.historyRecordsPerScope, 5);
  assert.equal(report.checkpointRecordsRestored, 20);
  assert.deepEqual(report.physicalCheckpointRows.beforeBackup, [10, 10, 0, 0]);
  assert.deepEqual(report.physicalCheckpointRows.afterRestore, [10, 10, 0, 0]);
  assert.equal(report.encryptedFolderCopy, true);
  assert.equal(report.snapshotWorker, true);
  assert.equal(report.mutationPersistenceAfterSecondReopen, true);
  assert.equal(report.providerCalls, 0);
  assert.equal(readFileSync(join(owner, 'sentinel'), 'utf8'), 'Synthetic data must remain untouched.');
});

test('checkpoint package probe fails when selected payload loses a history revision', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sara-checkpoint-mutant-'));
  console.error('Retained synthetic mutated-payload fixture:', fixture);
  cpSync(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  const checkpoint = join(fixture, 'src', 'project-checkpoints.ts');
  const original = readFileSync(checkpoint, 'utf8');
  assert.ok(original.includes('ORDER BY id DESC LIMIT 5'));
  writeFileSync(checkpoint, original.replace('ORDER BY id DESC LIMIT 5', 'ORDER BY id DESC LIMIT 4'));
  const result = run([fixture]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checkpoint history must retain five records/);
});

test('checkpoint package probe rejects hidden extra editor rows despite a five-record view', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sara-checkpoint-pruning-mutant-'));
  console.error('Retained synthetic editor-pruning mutant fixture:', fixture);
  cpSync(join(root, 'src'), join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  const checkpoint = join(fixture, 'src', 'project-checkpoints.ts');
  const original = readFileSync(checkpoint, 'utf8');
  const pruning = "this.#db.prepare('DELETE FROM project_checkpoints WHERE workspace = ? AND path = ? AND id NOT IN";
  assert.ok(original.includes(pruning));
  writeFileSync(checkpoint, original.replace(pruning, `if (sourceConversationId !== null) ${pruning}`));
  const result = run([fixture]);
  assert.notEqual(result.status, 0, 'probe must reject editor-only pruning loss hidden by the view limit');
  assert.match(result.stderr, /physical checkpoint row count must match five-record history/);
});
