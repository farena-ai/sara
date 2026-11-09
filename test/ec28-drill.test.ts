// EC28 (docs/ops/EC1828_DESIGN.md): the restore drill end to end on a temporary backup. The drill
// restores into a throwaway folder inside the data root, checks every database and the vault,
// boots the copy in drill mode on a loopback port, then removes it. The live folder is untouched.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createBackup } from '../src/backup.ts';
import { MemoryStore } from '../src/memory.ts';
import { DRILL_DIR_PREFIX, runRestoreDrill } from '../src/restore-drill.ts';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';

/** A small but real data folder: owner sign-in, a vault secret, a chat, a memory note, a backup. */
function seed(dir: string): { backup: string; liveDb: string } {
  new OwnerAuth(dir);
  new Vault(dir).set('provider:test', 'sk-drill-secret');
  const store = new Store(join(dir, 'sara.db'));
  const conv = store.createConversation({ title: 'Drill chat' });
  store.addMessage(conv.id, 'user', 'hello before the backup');
  store.addMessage(conv.id, 'assistant', 'hi');
  new MemoryStore(store.db).add({ kind: 'fact', content: 'likes tea', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-07' });
  store.close();
  mkdirSync(join(dir, 'backups'), { recursive: true });
  const backup = join(dir, 'backups', 'sara-2026-11-07-manual.tar.gz');
  createBackup(dir, backup, { saraVersion: 'test' });
  return { backup, liveDb: join(dir, 'sara.db') };
}

test('EC28 drill: restores the newest backup into a throwaway copy, checks it, boots it, removes it', { timeout: 240_000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { liveDb } = seed(dir);
    const before = statSync(liveDb).mtimeMs;
    const liveBytes = readFileSync(liveDb);
    const r = await runRestoreDrill({ rootDir: dir, now: new Date() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.backup, 'sara-2026-11-07-manual.tar.gz');
    assert.equal(r.counts?.conversations, 1);
    assert.equal(r.counts?.messages, 2);
    assert.equal(r.counts?.memories, 1);
    assert.ok((r.databases ?? 0) >= 1);
    assert.equal(r.vaultEntries, 1, 'the vault opened with the copy\'s own key');
    assert.ok((r.bootMs ?? 0) > 0 && (r.totalMs ?? 0) >= (r.bootMs ?? 0), JSON.stringify(r));
    assert.equal(typeof r.dataLossHours, 'number');
    assert.ok(!JSON.stringify(r).includes('sk-drill-secret'), 'never a vault value in the record');
    // The throwaway folder is gone and the live data was not touched.
    const tmp = join(dir, 'tmp');
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith(DRILL_DIR_PREFIX)) : [], []);
    assert.equal(statSync(liveDb).mtimeMs, before);
    assert.ok(readFileSync(liveDb).equals(liveBytes));
  } finally {
    cleanup();
  }
});

test('EC28 drill: no backup or a damaged one gives a failed record with the step, and still cleans up', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const none = await runRestoreDrill({ rootDir: dir, now: new Date() });
    assert.equal(none.ok, false);
    assert.equal(none.step, 'find');
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'sara-2026-11-07-manual.tar.gz'), Buffer.from('not a backup at all'));
    const bad = await runRestoreDrill({ rootDir: dir, now: new Date() });
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.equal(bad.step, 'restore');
    assert.ok(bad.error && bad.error.length > 0);
    const tmp = join(dir, 'tmp');
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith(DRILL_DIR_PREFIX)) : [], []);
  } finally {
    cleanup();
  }
});
