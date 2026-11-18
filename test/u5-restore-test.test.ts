// U5.31 (docs/BACKUPS.md): the monthly test restore. Real small backups made by the existing backup
// code are restored into a throwaway folder, every database is integrity-checked, row counts are
// compared with the counts taken at backup time, file hashes are checked against the backup's own
// list and the vault is opened; then the copy is deleted and one result row is kept per source.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { OwnerAuth } from '../src/auth.ts';
import { createBackup, inspectBackup, readTar, writeTar } from '../src/backup.ts';
import { MemoryStore } from '../src/memory.ts';
import { OFFSITE_PASS_VAULT, uploadOffsite } from '../src/offsite.ts';
import { detectProblems, type RepairEnv } from '../src/repair.ts';
import { runRestoreDrill } from '../src/restore-drill.ts';
import { RESTORE_TEST_PREFIXES, restoreTestDue, restoreTestSettings, restoreTestSummary, runRestoreTest } from '../src/restore-test.ts';
import { createSaraServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// Built at run time: never a realistic-looking secret in the source.
const SECRET = ['fake', 'vault', 'value', String(Date.now() % 997)].join('-');

/** A small real data folder (owner sign-in, a vault secret, a chat, a memory) and one backup. */
function seed(dir: string, name = 'sara-2026-11-01-00-00-00-auto.tar.gz'): string {
  new OwnerAuth(dir);
  new Vault(dir).set('provider:test', SECRET);
  const store = new Store(join(dir, 'sara.db'));
  const conv = store.createConversation({ title: 'Restore test chat' });
  store.addMessage(conv.id, 'user', 'hello before the backup');
  store.addMessage(conv.id, 'assistant', 'hi');
  new MemoryStore(store.db).add({ kind: 'fact', content: 'likes tea', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
  store.close();
  mkdirSync(join(dir, 'backups'), { recursive: true });
  const file = join(dir, 'backups', name);
  createBackup(dir, file, { saraVersion: 'test' });
  return file;
}

const leftovers = (dir: string) => {
  const tmp = join(dir, 'tmp');
  return existsSync(tmp) ? readdirSync(tmp).filter((n) => RESTORE_TEST_PREFIXES.some((p) => n.startsWith(p))) : [];
};

test('U5.31 backup: the manifest keeps row counts at backup time and a hash list the restore can check', () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = seed(dir);
    const { manifest, entries, sums } = inspectBackup(file);
    assert.deepEqual(manifest.counts, { conversations: 1, messages: 2, memories: 1 });
    assert.ok(sums && Object.keys(sums).length === entries.length, 'one hash per file');
    assert.ok(!entries.some((e) => e.path === 'sara-backup-sums.json'), 'the hash list is not restored as a file');
    assert.match(sums['sara.db'] ?? '', /^[0-9a-f]{64}$/);
  } finally {
    cleanup();
  }
});

test('U5.31 drill without boot: passes on a good backup and fails at "hashes" when a file was changed', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = seed(dir);
    const ok = await runRestoreDrill({ rootDir: dir, now: new Date(), boot: false });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.bootMs, undefined, 'the copy is not started');
    assert.ok((ok.hashed ?? 0) > 0);
    // Change one byte of a restored file inside the archive (the hash list stays as it was).
    const entries = readTar(gunzipSync(readFileSync(file)));
    const victim = entries.find((e) => e.path === 'settings.json' || e.path.endsWith('.json') && e.path !== 'sara-backup.json' && e.path !== 'sara-backup-sums.json')!;
    victim.data = Buffer.concat([victim.data, Buffer.from(' ')]);
    writeFileSync(file, gzipSync(writeTar(entries)));
    const bad = await runRestoreDrill({ rootDir: dir, now: new Date(), boot: false });
    assert.equal(bad.ok, false);
    assert.equal(bad.step, 'hashes', JSON.stringify(bad));
  } finally {
    cleanup();
  }
});

test('U5.31 run: a passed row with duration and a plain reason; the throwaway copy is gone and live data untouched', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-12-02T09:00:00Z') });
  try {
    seed(dir);
    const live = readFileSync(join(dir, 'sara.db'));
    const notes: string[] = [];
    const rows = await runRestoreTest(app, { rootDir: dir, by: 'owner', notify: async (t) => void notes.push(t) });
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.result, 'passed', JSON.stringify(r));
    assert.equal(r.source, 'local');
    assert.equal(r.by, 'owner');
    assert.ok(r.durationMs >= 0);
    assert.match(r.reason, /checks passed/);
    assert.equal(r.params?.conversations, 1);
    assert.ok(!JSON.stringify(app.settings.get()).includes(SECRET), 'never a vault value in the record');
    assert.deepEqual(leftovers(dir), []);
    assert.ok(readFileSync(join(dir, 'sara.db')).equals(live));
    assert.equal(restoreTestSettings(app).history?.[0]?.result, 'passed');
    assert.deepEqual(notes, [], 'no notice when it passed');
    const sum = restoreTestSummary(app);
    assert.equal(sum.last?.result, 'passed');
    assert.equal(sum.on, true);
    assert.ok(sum.nextAt && Date.parse(sum.nextAt) > Date.parse(r.at));
  } finally {
    app.store.close();
    cleanup();
  }
});

test('U5.31 run: a damaged backup gives a failed row, a T1 problem and one owner notice', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-12-02T09:00:00Z') });
  try {
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'sara-2026-12-01-00-00-00-auto.tar.gz'), Buffer.from('not a backup at all'));
    const notes: string[] = [];
    const [r] = await runRestoreTest(app, { rootDir: dir, notify: async (t, x) => void notes.push(`${t}|${x}`) });
    assert.equal(r?.result, 'failed', JSON.stringify(r));
    assert.equal(r?.step, 'restore');
    assert.equal(notes.length, 1);
    assert.deepEqual(leftovers(dir), []);
    const env = { now: () => app.now(), settings: app.settings, audit: () => {} } as unknown as RepairEnv;
    const p = (await detectProblems(env, { db: false })).find((x) => x.id === 'backup:restore-test');
    assert.ok(p, 'the failed test restore is a self-repair problem');
    assert.equal(p.level, 1);
    assert.equal(p.page, 'dh-backups');
  } finally {
    app.store.close();
    cleanup();
  }
});

test('U5.31 run: skipped with a reason when the disk is too full, or when there is no backup', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-12-02T09:00:00Z') });
  try {
    const none = await runRestoreTest(app, { rootDir: dir });
    assert.equal(none[0]?.result, 'skipped');
    assert.match(none[0]!.reason, /no backup/);
    seed(dir);
    const full = await runRestoreTest(app, { rootDir: dir, freeBytes: () => 1000 });
    assert.equal(full[0]?.result, 'skipped');
    assert.match(full[0]!.reason, /free disk space/);
    assert.deepEqual(leftovers(dir), []);
    const env = { now: () => app.now(), settings: app.settings, audit: () => {} } as unknown as RepairEnv;
    assert.equal((await detectProblems(env, { db: false })).some((x) => x.id === 'backup:restore-test'), false, 'a skip is not a failure');
  } finally {
    app.store.close();
    cleanup();
  }
});

test('U5.31 due: monthly by default, at the quiet hour only, never when off', () => {
  const { dir, cleanup } = tempDir();
  let now = new Date('2026-12-02T03:30:00Z');
  const app = makeApp(dir, { get now() { return now; } });
  try {
    app.settings.update({ timeZone: 'UTC' });
    seed(dir);
    assert.equal(restoreTestSettings(app).everyDays, 30);
    assert.equal(restoreTestDue(app), true, 'never tested, a backup exists, 3 AM');
    now = new Date('2026-12-02T14:00:00Z');
    assert.equal(restoreTestDue(app), false, 'not in the afternoon');
    now = new Date('2026-12-02T03:30:00Z');
    app.settings.update({ restoreTest: { ...restoreTestSettings(app), history: [{ at: '2026-11-20T03:10:00Z', result: 'passed', source: 'local', reason: 'x', durationMs: 1, by: 'schedule' }] } } as never);
    assert.equal(restoreTestDue(app), false, '12 days ago');
    now = new Date('2026-12-21T03:30:00Z');
    assert.equal(restoreTestDue(app), true, '31 days later');
    app.settings.update({ restoreTest: { ...restoreTestSettings(app), on: false } } as never);
    assert.equal(restoreTestDue(app), false, 'off');
  } finally {
    app.store.close();
    cleanup();
  }
});

test('U5.31 run: the newest off-server copy is downloaded, decrypted and checked too', { timeout: 120_000 }, async () => {
  const { dir, cleanup } = tempDir();
  const remote = tempDir();
  const app = makeApp(dir, { now: new Date('2026-12-02T09:00:00Z') });
  try {
    const file = seed(dir);
    const pass = ['fake', 'pass', 'phrase', '42'].join('-');
    const cfg = { kind: 'folder' as const, path: remote.dir, keep: 3, prefix: 'sara/' };
    await uploadOffsite(file, cfg, { passphrase: pass });
    app.vault.set(OFFSITE_PASS_VAULT, pass);
    app.settings.update({ offsite: { ...cfg, last: { at: new Date().toISOString(), ok: true } } } as never);
    const rows = await runRestoreTest(app, { rootDir: dir });
    assert.deepEqual(rows.map((r) => `${r.source}:${r.result}`), ['local:passed', 'offsite:passed'], JSON.stringify(rows));
    assert.deepEqual(leftovers(dir), []);
    app.settings.update({ restoreTest: { ...restoreTestSettings(app), offsite: false } } as never);
    assert.deepEqual((await runRestoreTest(app, { rootDir: dir })).map((r) => r.source), ['local'], 'off-server part can be turned off');
    assert.ok(statSync(file).size > 0);
  } finally {
    app.store.close();
    remote.cleanup();
    cleanup();
  }
});

test('U5.31 routes: GET/PUT settings and "Test a restore now" (202, then the row)', { timeout: 120_000 }, async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  seed(dir);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/backups/restore-test`;
  const owner = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base)).status, 401);
  const g = (await (await fetch(base, { headers: owner })).json()) as { on: boolean; history: unknown[]; running: boolean };
  assert.equal(g.on, true);
  assert.deepEqual(g.history, []);
  const put = (await (await fetch(base, { method: 'PUT', headers: owner, body: JSON.stringify({ on: false, offsite: false }) })).json()) as { on: boolean; offsite: boolean };
  assert.equal(put.on, false);
  assert.equal(put.offsite, false);
  const start = await fetch(base, { method: 'POST', headers: owner, body: '{}' });
  assert.equal(start.status, 202);
  let hist: { result: string; by: string }[] = [];
  for (let i = 0; i < 200 && !hist.length; i++) {
    const s = (await (await fetch(base, { headers: owner })).json()) as { running: boolean; history: { result: string; by: string }[] };
    if (!s.running) hist = s.history;
    else await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(hist[0]?.result, 'passed', JSON.stringify(hist));
  assert.equal(hist[0]?.by, 'owner');
});
