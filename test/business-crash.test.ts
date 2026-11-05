import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBusinessProfile } from '../src/business/profile.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';
import { acquireBusinessWriter } from '../src/business/lifecycle.ts';
import { configureBusinessModels } from '../src/business/model-config.ts';

test('real killed writer releases OS fence without stale lock deletion; live root refuses another runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sara-b1-crash-')); const profile = openBusinessProfile(dir);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/business-writer-crash.ts', import.meta.url)), dir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('exit', () => reject(new Error('Writer exited early'))); child.once('error', reject); });
    assert.throws(() => acquireBusinessWriter(profile), /active writer/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const runtime = createBusinessRuntime({ profile, origin: 'http://127.0.0.1:9987' });
    try {
      assert.throws(() => createBusinessRuntime({ profile, origin: 'http://127.0.0.1:9988' }), /active writer/);
      assert.throws(() => configureBusinessModels(profile, {}), /active writer/, 'Out-of-process operator path must acquire fence before mutation/validation');
    } finally { await runtime.close(); }
    const lease = acquireBusinessWriter(profile); lease.release();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('actual process death while backup waits for accepted work preserves held ledger and publishes no archive', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'sara-b1-backup-crash-')); const root = join(temp, 'profile'); const file = join(temp, 'backup.enc');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/business-backup-crash.ts', import.meta.url)), root, file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    const ready = await new Promise<any>((resolve, reject) => { child.stdout.once('data', chunk => resolve(JSON.parse(String(chunk)))); child.once('exit', () => reject(new Error('Fixture exited early'))); child.once('error', reject); });
    assert.equal(ready.state, 'paused');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(existsSync(file), false);
    const runtime = createBusinessRuntime({ profile: openBusinessProfile(root), origin: 'http://127.0.0.1:9990' });
    try { assert.equal(runtime.budget.lookup(ready.key)?.state, 'held'); assert.equal(runtime.budget.exposure().instanceNanoUsd, 200); }
    finally { await runtime.close(); }
  } finally { child.kill('SIGKILL'); rmSync(temp, { recursive: true, force: true }); }
});

test('actual main business status and encrypted backup CLI dispatch before personal initialization', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'sara-b1-cli-')); const root = join(temp, 'profile');
  const runtime = createBusinessRuntime({ profile: openBusinessProfile(root), origin: 'http://127.0.0.1:9991' });
  await runtime.close();
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const run = async (args: string[], dataRoot = root, profile = 'business') => {
    const child = spawn(process.execPath, [main, ...args], { env: { ...process.env, SARA_PROFILE: profile, SARA_DATA: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit'); return { code, stdout, stderr };
  };
  try {
    const status = await run(['--business-status']); assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).recovering, false);
    const secret = join(temp, 'passphrase.txt'); writeFileSync(secret, 'synthetic passphrase for recovery'); const file = join(temp, 'backup.enc');
    const backup = await run(['--business-backup', file, '--passphrase-file', secret]); assert.equal(backup.code, 0, backup.stderr); assert.ok(existsSync(file));
    const personal = join(temp, 'accidental-personal'); const refused = await run(['--restore', file], personal, 'personal');
    assert.notEqual(refused.code, 0); assert.equal(existsSync(personal), false, 'Personal initialization must not precede business archive refusal');
    const target = join(temp, 'restored'); const restore = await run(['--business-restore', file, '--target', target, '--passphrase-file', secret]); assert.equal(restore.code, 0, restore.stderr);
    assert.equal(JSON.parse(restore.stdout).recovery, 'reconciliation-required');
    for (const name of ['owner.json', 'sara.db', 'settings.json', 'master.key']) assert.equal(existsSync(join(root, name)), false, name);
    assert.ok(!backup.stdout.includes('synthetic passphrase')); assert.ok(!restore.stderr.includes('synthetic passphrase'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
