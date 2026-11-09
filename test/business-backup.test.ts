import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { contentFixture } from './helpers/business-content.ts';
import { restoreBackup } from '../src/backup.ts';
import { openBusinessProfile } from '../src/business/profile.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readTar, writeTar } from '../src/backup.ts';
import { decryptBackup, encryptBackup } from '../src/offsite.ts';
import { restoreBusinessBackup } from '../src/business/backup.ts';
import { Vault } from '../src/vault.ts';

test('business generation snapshots all four stores including unopened workspace, restores closed and preserves audit', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-backup-'));
  try {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const w = f.runtime.control.createWorkspace(f.admin.principal, { name: `Workspace ${i}` }); ids.push(w.id);
      if (i < 3) await f.runtime.documents.create(f.context(w.id), { title: 'synthetic', mime: 'text/plain', body: `canary-${i}` });
    }
    const removed = f.add('Later revoked'); f.grant(ids[0], removed, 'contributor');
    const invite = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' });
    f.runtime.configureModels({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 100000, maxConcurrent: 2,
      models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: true }, model: 'fixture', cloud: false, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 2000, tone: 'professional' }],
      workspaces: { [ids[0]]: { modelId: 'local', allowanceNanoUsd: 100000 } } }, { local: 'SYNTHETIC_OPERATOR_KEY' });
    const held = { requestId: randomUUID(), actorId: f.admin.principal.identityId, workspaceId: ids[0], conversationId: randomUUID(), payloadHash: 'c'.repeat(64), policyHash: 'd'.repeat(64) };
    f.runtime.budget.reserve(held, { instanceAllowanceNanoUsd: 100000, workspaceAllowanceNanoUsd: 100000, maxConcurrent: 2, maxInputTokens: 100, maxOutputTokens: 100, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1 });
    assert.equal(typeof (f.runtime as any).backup, 'function', 'Business snapshot adapter required');
    const file = join(temp, 'generation.enc');
    const manifest = await (f.runtime as any).backup(file, 'synthetic passphrase for recovery');
    f.runtime.control.setOrganizationMember(f.admin.principal, removed.principal.identityId, { status: 'disabled' });
    assert.equal(manifest.workspaceIds.length, 4);
    assert.ok(!manifest.files.some((e: any) => /-wal|-shm|writer-fence/.test(e.path)));
    const backup = await import('../src/business/backup.ts');
    const target = join(temp, 'restored');
    await backup.restoreBusinessBackup(file, target, 'synthetic passphrase for recovery');
    const recoveryRuntime = createBusinessRuntime({ profile: openBusinessProfile(target), origin: 'http://127.0.0.1:9986' });
    try {
      assert.equal(recoveryRuntime.auth.principal(f.admin.value), undefined);
      assert.equal(recoveryRuntime.auth.principal(removed.value), undefined);
      assert.throws(() => recoveryRuntime.control.previewInvite(invite.code));
      assert.equal(recoveryRuntime.budget.lookup(held)?.state, 'held');
      assert.equal(recoveryRuntime.budget.exposure(ids[0]).instanceNanoUsd, 200);
      assert.throws(() => recoveryRuntime.models.plan(ids[0]), /recovery/);
      assert.throws(() => recoveryRuntime.auth.createIdentity('Unapproved', true), /recovery/i, 'Recovery forbids creation of unrelated identities');
      assert.throws(() => recoveryRuntime.control.bootstrapAdministrator(), /recovery/i, 'Recovery cannot silently mint bootstrap authority');
    } finally { await recoveryRuntime.close(); }
    assert.equal(new Vault(join(target, 'business', 'operator')).get('business-provider:local'), 'SYNTHETIC_OPERATOR_KEY');
    const db = new DatabaseSync(join(target, 'business', 'business.db'));
    try {
      assert.equal(db.prepare("SELECT value FROM business_meta WHERE key='recovery_mode'").get()?.value, 'reconcile');
      assert.equal(db.prepare("SELECT count(*) AS n FROM workspace_members WHERE status='active'").get()?.n, 0);
      assert.equal(db.prepare('SELECT auth_epoch FROM business_identities WHERE id=?').get(f.admin.principal.identityId)?.auth_epoch, 1);
      assert.ok(Number(db.prepare('SELECT count(*) AS n FROM business_audit').get()?.n) > 4);
    } finally { db.close(); }
    for (const [i, id] of ids.entries()) {
      const content = new DatabaseSync(join(target, 'business', 'workspaces', id, 'content.db'));
      try { assert.equal(content.prepare('SELECT count(*) AS n FROM documents').get()?.n, i < 3 ? 1 : 0); } finally { content.close(); }
    }
    const personal = join(temp, 'personal');
    assert.throws(() => restoreBackup(file, personal)); assert.equal(existsSync(personal), false);
    await assert.rejects(backup.restoreBusinessBackup(file, join(temp, 'wrong'), 'wrong passphrase'));
    assert.equal(existsSync(join(temp, 'wrong')), false);
    await assert.rejects(backup.restoreBusinessBackup(file, target, 'synthetic passphrase for recovery'));
    assert.ok(readFileSync(file).length > 100);
  } finally { await f.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('authenticated archives with mixed DB generations, missing files or hash tamper never promote access', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-tamper-')); const pass = 'synthetic passphrase for recovery';
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Tamper' });
    const file = join(temp, 'original.enc'); await f.runtime.backup(file, pass);
    await f.runtime.close();
    const original = readTar(gunzipSync(decryptBackup(readFileSync(file).subarray(8), pass)));
    for (const kind of ['missing', 'hash', 'generation', 'duplicate', 'escape']) {
      const entries = original.map(entry => ({ ...entry, data: Buffer.from(entry.data) }));
      const path = `business/workspaces/${w.id}/content.db`; const content = entries.find(entry => entry.path === path)!;
      if (kind === 'missing') entries.splice(entries.indexOf(content), 1);
      if (kind === 'hash') content.data[100] ^= 1;
      if (kind === 'duplicate') entries.push(content);
      if (kind === 'escape') content.path = '../outside';
      if (kind === 'generation') {
        const dbPath = join(temp, 'changed.db'); writeFileSync(dbPath, content.data);
        const db = new DatabaseSync(dbPath); try { db.prepare('UPDATE business_snapshot SET generation=?').run(randomUUID()); } finally { db.close(); }
        content.data = readFileSync(dbPath);
        const manifestEntry = entries.find(entry => entry.path === 'BUSINESS_BACKUP.json')!; const manifest = JSON.parse(manifestEntry.data.toString());
        const info = manifest.files.find((entry: any) => entry.path === path); info.sha256 = createHash('sha256').update(content.data).digest('hex'); info.size = content.data.length;
        manifestEntry.data = Buffer.from(JSON.stringify(manifest));
      }
      const corrupted = join(temp, `${kind}.enc`); writeFileSync(corrupted, Buffer.concat([Buffer.from('SARABUS1'), encryptBackup(gzipSync(writeTar(entries)), pass)]));
      const target = join(temp, `restore-${kind}`); await assert.rejects(restoreBusinessBackup(corrupted, target, pass)); assert.equal(existsSync(target), false, kind);
    }
  } finally { await f.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('shutdown waits for generation seal and snapshot barrier rejects every late direct writer', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-drain-backup-'));
  let pending: Promise<unknown> | undefined;
  try {
    f.runtime.control.createWorkspace(f.admin.principal, { name: 'Snapshot' });
    pending = f.runtime.backup(join(temp, 'archive.enc'), 'synthetic passphrase for recovery');
    assert.equal(f.runtime.lifecycle.state, 'paused');
    assert.throws(() => f.runtime.auth.createIdentity('Late', true));
    assert.throws(() => f.runtime.budget.acknowledgeDisclosure('late-session', f.admin.principal.identityId), /admission/);
    assert.throws(() => f.runtime.configureModels({}), /admission/);
    const stopping = f.runtime.close();
    await pending; await stopping;
  } finally { await pending?.catch(() => {}); await f.close(); rmSync(temp, { recursive: true, force: true }); }
});


test('business backup accepts a system temporary-directory alias without relaxing generation link checks', async () => {
  const f = await contentFixture();
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'sara-b1-temp-alias-'));
  const alias = join(temp, 'alias');
  symlinkSync(realpathSync(tmpdir()), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const prior = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  try {
    process.env.TMPDIR = alias; process.env.TMP = alias; process.env.TEMP = alias;
    f.runtime.control.createWorkspace(f.admin.principal, { name: 'Temporary alias fixture' });
    const file = join(temp, 'generation.enc');
    const manifest = await f.runtime.backup(file, 'synthetic temporary alias passphrase');
    assert.equal(manifest.workspaceIds.length, 1);
    const restored = join(temp, 'restored');
    await restoreBusinessBackup(file, restored, 'synthetic temporary alias passphrase');
    assert.equal(openBusinessProfile(restored).profile, 'business');
    const { checkedFiles } = await import('../src/business/backup.ts');
    assert.throws(() => checkedFiles(alias), /Unsafe generation directory/);
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.close();
    rmSync(alias);
    rmSync(temp, { recursive: true, force: true });
  }
});
