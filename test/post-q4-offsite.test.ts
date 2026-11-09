import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBackupAsync } from '../src/backup-async.ts';
import { restoreBackup } from '../src/backup.ts';
import { deliveryFor } from '../src/delivery.ts';
import { decryptBackup, downloadNewestOffsite, isEncrypted, uploadOffsite } from '../src/offsite.ts';
import { makeApp, tempDir } from './helpers.ts';

test('encrypted folder-copy restore preserves all four spaces, keys and uncertainty; wrong key/tamper fail closed', async () => {
  const { dir, cleanup } = tempDir();
  const source = join(dir, 'source');
  const spaces = ['', 'companions/fixture', 'members/member', 'members/member/companions/fixture'];
  const expected: { id: string; key: Buffer }[] = [];
  const payload = randomBytes(4 * 1024 ** 2);
  const started = performance.now();
  let passed = false;
  try {
    for (const [i, space] of spaces.entries()) {
      const home = join(source, space);
      mkdirSync(home, { recursive: true });
      const app = makeApp(home, { now: new Date() });
      try {
        app.vault.set('offsite-fixture', `synthetic-offsite-value-${i}`);
        const deliveries = deliveryFor(app);
        const id = deliveries.enqueue({ bridge: 'discord', operation: 'sendMessage', destination: '888', logicalKey: `offsite-fixture-${i}`, review: { text: `Synthetic offsite uncertainty ${i}` } }).id;
        deliveries.attempt(id); deliveries.unknown(id);
        expected.push({ id, key: readFileSync(join(home, 'master.key')) });
      } finally { app.store.close(); }
    }
    writeFileSync(join(source, 'payload.bin'), payload);
    const archive = join(dir, 'sara-2026-11-04-12-00-00-auto.tar.gz');
    await createBackupAsync(source, archive, { saraVersion: 'post-q4-fixture' });
    const folder = join(dir, 'separate-folder');
    mkdirSync(folder);
    const cfg = { kind: 'folder' as const, path: folder, keep: 2, prefix: 'fixture/' };
    const passphrase = randomBytes(32).toString('hex');
    await uploadOffsite(archive, cfg, { passphrase });
    const downloaded = await downloadNewestOffsite(cfg, {});
    assert.ok(isEncrypted(downloaded.data));
    assert.throws(() => decryptBackup(downloaded.data, 'incorrect-fixture-passphrase'));
    const tampered = Buffer.from(downloaded.data);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptBackup(tampered, passphrase));
    const plain = decryptBackup(downloaded.data, passphrase);
    assert.deepEqual(plain, readFileSync(archive));
    const copiedArchive = join(dir, 'downloaded.tar.gz');
    writeFileSync(copiedArchive, plain);
    const restored = join(dir, 'restored');
    restoreBackup(copiedArchive, restored);
    assert.deepEqual(readFileSync(join(restored, 'payload.bin')), payload);
    for (const [i, space] of spaces.entries()) {
      const home = join(restored, space);
      const app = makeApp(home, { now: new Date() });
      try {
        assert.equal(Object.values(app.store.db.prepare('PRAGMA integrity_check').get()!)[0], 'ok');
        assert.deepEqual(readFileSync(join(home, 'master.key')), expected[i].key);
        assert.equal(app.vault.get('offsite-fixture'), `synthetic-offsite-value-${i}`);
        const deliveries = deliveryFor(app);
        assert.equal(deliveries.review(expected[i].id).text, `Synthetic offsite uncertainty ${i}`);
        const row = app.store.db.prepare('SELECT state,resolution,attempts,logical_key FROM deliveries WHERE id=?').get(expected[i].id)!;
        assert.equal(row.state, 'outcome_unknown'); assert.equal(row.resolution, null);
        assert.equal(row.attempts, 1); assert.equal(row.logical_key, `offsite-fixture-${i}`);
        assert.equal(app.providerCalls, 0);
      } finally { app.store.close(); }
    }
    console.log(`Post-Q4 encrypted folder-copy drill: four spaces, actual worker snapshot, 4MiB bytes, keys and uncertainty verified in ${(performance.now() - started).toFixed(1)}ms; no remote service.`);
    passed = true;
  } finally {
    if (passed) cleanup(); else console.error('Failed synthetic encrypted-copy fixture retained:', dir);
  }
});
