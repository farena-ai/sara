import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBackup, restoreBackup } from '../src/backup.ts';
import { Store } from '../src/store.ts';
import { RECOVERY_SPACES, seedRecoveryData } from './fixtures/q3-recovery-data.ts';
import { ROOT, tempDir } from './helpers.ts';

test('Q3 restored production entry point boots offline with interrupted work held in all spaces', { timeout: 45000 }, async () => {
  const { dir, cleanup } = tempDir();
  const source = join(dir, 'source');
  seedRecoveryData(source);
  const archive = join(dir, 'recovery.tar.gz');
  createBackup(source, archive, { saraVersion: 'q3-fixture' });
  const restored = join(dir, 'restored');
  restoreBackup(archive, restored);
  const isolatedHome = join(dir, 'isolated-home');
  mkdirSync(isolatedHome);
  const reserve = createServer();
  await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
  const port = (reserve.address() as AddressInfo).port;
  await new Promise<void>(r => reserve.close(() => r()));
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT', 'LD_LIBRARY_PATH']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedHome, LOCALAPPDATA: isolatedHome, SARA_DATA: restored, SARA_HOST: '127.0.0.1', SARA_PORT: String(port), SARA_PRIVATE_LOCAL: '1', SARA_TESTING: '1', SARA_SETUP: 'off', SARA_SANDBOX: 'none', SARA_STOP_ON_STDIN_END: '1', Q3_OUTBOUND_LOG: join(dir, 'blocked-network.log') });
  const started = Date.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'test/fixtures/q3-deny-outbound.mjs')).href, join(ROOT, 'src/main.ts')], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  let logs = '';
  child.stdout.on('data', b => { logs = (logs + b.toString()).slice(-10000); });
  child.stderr.on('data', b => { logs = (logs + b.toString()).slice(-10000); });
  let passed = false;
  try {
    const until = Date.now() + 20000;
    while (!logs.includes('Sara is listening on') && child.exitCode === null && Date.now() < until) await delay(25);
    assert.ok(logs.includes('Sara is listening on'), `production fixture booted: ${logs}`);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), { ok: true });
    await delay(16000);
    for (const [i, rel] of RECOVERY_SPACES.entries()) {
      const db = new Store(join(restored, rel, 'sara.db'));
      try {
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='attempted'").get()?.n, 0, rel);
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='outcome_unknown'").get()?.n, 1, rel);
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='queued'").get()?.n, 1, rel);
        if (i < 2) {
          assert.equal(db.db.prepare('SELECT status FROM jobs').get()?.status, 'interrupted', rel);
          assert.equal(db.db.prepare('SELECT status FROM team_tasks').get()?.status, 'interrupted', rel);
          assert.equal(db.db.prepare('SELECT state FROM chat_goals').get()?.state, 'paused', rel);
          assert.equal(db.db.prepare('SELECT status FROM team_steps').get()?.status, 'running', 'old in-flight receipt preserved');
        }
      } finally { db.close(); }
    }
    console.log(`Q3 isolated restored boot: ${Date.now() - started}ms; four spaces checked; outbound sockets blocked; no recovery dispatch.`);
    passed = true;
  } finally {
    child.stdin.end();
    const graceful = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
    if (!graceful) { child.kill('SIGKILL'); await exited; }
    if (passed) cleanup(); else console.error('Q3 failed boot fixture retained:', dir);
  }
});
