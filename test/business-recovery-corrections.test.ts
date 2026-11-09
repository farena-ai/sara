import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createCipheriv } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { contentFixture } from './helpers/business-content.ts';
import { BusinessAuthenticator } from './business-authenticator.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';
import { openBusinessProfile } from '../src/business/profile.ts';
import { issueBusinessReenrollment, businessRecoveryStatus, reconcileBusinessRecovery, completeBusinessRecovery, resumeBusinessSpending } from '../src/business/recovery.ts';
import { restoreBusinessBackup } from '../src/business/backup.ts';
import { configureBusinessModels } from '../src/business/model-config.ts';
import { readTar, writeTar } from '../src/backup.ts';
import { encryptBackup, decryptBackup } from '../src/offsite.ts';
import { Vault } from '../src/vault.ts';

const pass = 'synthetic review correction passphrase';
const config = (id: string, needsKey = true) => ({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 100000, maxConcurrent: 2,
  models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey }, model: 'fixture', cloud: false, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 2000, tone: 'professional' }],
  workspaces: { [id]: { modelId: 'local', allowanceNanoUsd: 100000 } } });
function enroll(runtime: ReturnType<typeof createBusinessRuntime>, session: ReturnType<typeof runtime.auth.reenroll>) {
  const key = new BusinessAuthenticator();
  const options = runtime.auth.options('register', session.principal.identityId, runtime.origin, session.principal);
  runtime.auth.finish('register', options.challenge, key.register(options.challenge, runtime.origin), runtime.origin, session.principal);
  return key;
}

test('individual recovery preserves enrolled coworker, current grants and policy; target must enroll fresh passkey', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Shared' });
    const coworker = f.add('Enrolled coworker'); f.grant(w.id, coworker, 'contributor');
    const coworkerKey = enroll(f.runtime, coworker); enroll(f.runtime, f.admin);
    f.runtime.configureModels(config(w.id), { local: 'SYNTHETIC_KEY' });
    const beforePolicy = readFileSync(join(f.profile.businessDir, 'model-policy.json'));
    const beforeMember = f.runtime.control.workspaceMembership(w.id, coworker.principal.identityId);
    await f.runtime.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const issued = issueBusinessReenrollment(f.profile, f.admin.principal.identityId);
      const status = businessRecoveryStatus(f.profile);
      assert.equal(status.recovering, false, 'One lost sign-in must not enter disaster recovery');
      assert.equal(status.spendingPaused, false); assert.equal(status.generation, undefined);
      const runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
      try {
        assert.equal(runtime.auth.principal(f.admin.value), undefined);
        assert.deepEqual(runtime.auth.principal(coworker.value), coworker.principal);
        assert.deepEqual(runtime.control.workspaceMembership(w.id, coworker.principal.identityId), beforeMember);
        const options = runtime.auth.options('login', undefined, runtime.origin);
        const signed = runtime.auth.finish('login', options.challenge, coworkerKey.assertion(options.challenge, runtime.origin), runtime.origin)!;
        assert.equal(runtime.policy.authorizeWorkspace(signed.principal, w.id, 'read').role, 'contributor');
        const session = runtime.auth.reenroll(issued.code, true);
        assert.throws(() => runtime.auth.reenroll(issued.code, true));
        assert.throws(() => runtime!.policy.authorizeWorkspace(session.principal, w.id, 'read'));
        assert.throws(() => runtime.control.createWorkspace(session.principal, { name: 'Before passkey' }));
        enroll(runtime, session);
        assert.equal(runtime.policy.authorizeWorkspace(session.principal, w.id, 'read').role, 'manager');
        assert.deepEqual(readFileSync(join(f.profile.businessDir, 'model-policy.json')), beforePolicy);
      } finally { await runtime.close(); }
    }
  } finally { await f.close(); }
});

test('explicit disabled-identity reenrollment does not reactivate removed organization/workspace grants', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Shared' });
    const target = f.add('Disabled target'); f.grant(w.id, target, 'contributor');
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, target.principal.identityId, { role: 'contributor', status: 'removed' });
    f.runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status: 'disabled' });
    await f.runtime.close();
    assert.throws(() => issueBusinessReenrollment(f.profile, target.principal.identityId));
    const issued = issueBusinessReenrollment(f.profile, target.principal.identityId, true);
    const runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    try {
      const session = runtime.auth.reenroll(issued.code, true); enroll(runtime, session);
      assert.equal(runtime.identities.get(target.principal.identityId)?.status, 'active');
      assert.equal(runtime.control.organizationMembership(target.principal.identityId)?.status, 'disabled');
      assert.equal(runtime.control.workspaceMembership(w.id, target.principal.identityId)?.status, 'removed');
      assert.throws(() => runtime!.policy.authorizeWorkspace(session.principal, w.id, 'read'));
      assert.deepEqual(runtime.auth.principal(f.admin.value), f.admin.principal);
    } finally { await runtime.close(); }
  } finally { await f.close(); }
});

test('freshly reactivated identity needs explicit organization approval then separate manager workspace grants', async () => {
  for (const status of ['disabled', 'removed'] as const) {
    const f = await contentFixture();
    try {
      const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Reapproval' });
      const otherWorkspace = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Still closed' });
      const target = f.add('Offboarded target'); f.grant(w.id, target, 'contributor'); f.grant(otherWorkspace.id, target, 'viewer');
      const viewer = f.add('Unaffected viewer'); f.grant(w.id, viewer, 'viewer');
      const viewerKey = enroll(f.runtime, viewer);
      const viewerGrant = f.runtime.control.workspaceMembership(w.id, viewer.principal.identityId);
      f.runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status });
      assert.equal(f.runtime.control.workspaceMembership(w.id, target.principal.identityId)?.status, 'active', 'Organization offboarding intentionally retains workspace records');
      assert.throws(() => f.runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status: 'active' }));
      await f.runtime.close();
      const issued = issueBusinessReenrollment(f.profile, target.principal.identityId, true);
      const runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
      try {
        assert.throws(() => runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status: 'active' }));
        const session = runtime.auth.reenroll(issued.code, true);
        assert.throws(() => runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status: 'active' }), 'Redeeming a code is not fresh passkey enrollment');
        enroll(runtime, session);
        assert.throws(() => runtime.control.setOrganizationMember(viewer.principal, target.principal.identityId, { status: 'active' }));
        assert.throws(() => runtime.control.setOrganizationMember(session.principal, target.principal.identityId, { status: 'active' }));
        runtime.control.database.exec("CREATE TRIGGER refuse_reapproval_audit BEFORE INSERT ON business_audit WHEN NEW.action='organization.member' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
        assert.throws(() => runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status: 'active' }));
        assert.equal(runtime.control.organizationMembership(target.principal.identityId)?.status, status);
        assert.equal(runtime.control.workspaceMembership(w.id, target.principal.identityId)?.status, 'active');
        runtime.control.database.exec('DROP TRIGGER refuse_reapproval_audit');
        const approved = runtime.control.setOrganizationMember(f.admin.principal, target.principal.identityId, { status: 'active' });
        assert.equal(approved.status, 'active');
        for (const workspace of [w, otherWorkspace]) {
          assert.equal(runtime.control.workspaceMembership(workspace.id, target.principal.identityId)?.status, 'removed');
          assert.throws(() => runtime.policy.authorizeWorkspace(session.principal, workspace.id, 'read'));
        }
        assert.throws(() => runtime.control.setWorkspaceMember(viewer.principal, w.id, target.principal.identityId, { role: 'contributor', status: 'active' }));
        runtime.control.setWorkspaceMember(f.admin.principal, w.id, target.principal.identityId, { role: 'contributor', status: 'active' });
        assert.equal(runtime.policy.authorizeWorkspace(session.principal, w.id, 'read').role, 'contributor');
        assert.throws(() => runtime.policy.authorizeWorkspace(session.principal, otherWorkspace.id, 'read'));
        assert.equal(runtime.auth.principal(target.value), undefined);
        assert.deepEqual(runtime.auth.principal(viewer.value), viewer.principal);
        assert.deepEqual(runtime.control.workspaceMembership(w.id, viewer.principal.identityId), viewerGrant);
        const options = runtime.auth.options('login', undefined, runtime.origin);
        assert.ok(runtime.auth.finish('login', options.challenge, viewerKey.assertion(options.challenge, runtime.origin), runtime.origin));
        const metadata = runtime.audit.workspace(runtime.policy.authorizeWorkspace(f.admin.principal, otherWorkspace.id, 'audit'));
        assert.ok(metadata.some(row => row.action === 'workspace.member' && row.subjectId === target.principal.identityId));
        assert.equal(runtime.budget.exposure().instanceNanoUsd, 0);
        assert.equal(runtime.control.database.prepare("SELECT value FROM business_model_state WHERE key='paused'").get(), undefined);
      } finally { await runtime.close(); }
    } finally { await f.close(); }
  }
});

test('backup refuses mismatched, malformed, missing operator keys and missing configured secret without repairing files', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-key-corrections-'));
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Keys' });
    f.runtime.configureModels(config(w.id), { local: 'SYNTHETIC_KEY' });
    const dir = join(f.profile.businessDir, 'operator'); const key = join(dir, 'master.key'); const enc = join(dir, 'secrets.enc');
    const originalKey = readFileSync(key); const originalEnc = readFileSync(enc);
    for (const kind of ['mismatch', 'malformed', 'missing-key', 'missing-secret', 'missing-vault', 'malformed-vault', 'decoded-shape']) {
      writeFileSync(key, originalKey); writeFileSync(enc, originalEnc);
      if (kind === 'mismatch') writeFileSync(key, randomBytes(32).toString('base64') + '\n');
      if (kind === 'malformed') writeFileSync(key, 'invalid');
      if (kind === 'missing-key') rmSync(key);
      if (kind === 'missing-secret') new Vault(dir).delete('business-provider:local');
      if (kind === 'missing-vault') rmSync(enc);
      if (kind === 'malformed-vault') writeFileSync(enc, Buffer.from('invalid'));
      if (kind === 'decoded-shape') {
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(originalKey.toString().trim(), 'base64'), iv);
        const ciphertext = Buffer.concat([cipher.update('[]'), cipher.final()]); writeFileSync(enc, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
      }
      const beforeKey = existsSync(key) ? readFileSync(key) : undefined;
      const beforeEnc = existsSync(enc) ? readFileSync(enc) : undefined;
      await assert.rejects(f.runtime.backup(join(temp, `${kind}.enc`), pass), kind);
      assert.deepEqual(existsSync(key) ? readFileSync(key) : undefined, beforeKey);
      assert.deepEqual(existsSync(enc) ? readFileSync(enc) : undefined, beforeEnc);
      assert.equal(existsSync(join(temp, `${kind}.enc`)), false);
    }
    writeFileSync(key, originalKey); writeFileSync(enc, originalEnc);
    f.runtime.configureModels(config(w.id, false)); rmSync(key); rmSync(enc);
    const keyless = join(temp, 'keyless.enc'); await f.runtime.backup(keyless, pass);
    const restored = join(temp, 'keyless'); await restoreBusinessBackup(keyless, restored, pass);
    assert.equal(existsSync(join(restored, 'business', 'operator', 'master.key')), false);
    assert.equal(existsSync(join(restored, 'business', 'operator', 'secrets.enc')), false);
  } finally { await f.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('semantically invalid but correctly rehashed and encrypted Vault archive is rejected before target publication', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-invalid-vault-'));
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Keys' }); f.runtime.configureModels(config(w.id), { local: 'SYNTHETIC_KEY' });
    const good = join(temp, 'good.enc'); await f.runtime.backup(good, pass);
    const entries = readTar(gunzipSync(decryptBackup(readFileSync(good).subarray(8), pass)));
    const key = entries.find(entry => entry.path === 'business/operator/master.key')!; key.data = Buffer.from(randomBytes(32).toString('base64') + '\n');
    const entry = entries.find(entry => entry.path === 'BUSINESS_BACKUP.json')!; const manifest = JSON.parse(entry.data.toString());
    const record = manifest.files.find((record: any) => record.path === key.path); record.sha256 = createHash('sha256').update(key.data).digest('hex'); record.size = key.data.length;
    entry.data = Buffer.from(JSON.stringify(manifest));
    const bad = join(temp, 'bad.enc'); writeFileSync(bad, Buffer.concat([Buffer.from('SARABUS1'), encryptBackup(gzipSync(writeTar(entries)), pass)]));
    const target = join(temp, 'target'); await assert.rejects(restoreBusinessBackup(bad, target, pass)); assert.equal(existsSync(target), false);
  } finally { await f.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('first and repeated actual disaster restore require fresh grants/passkeys and a new policy while retaining held exposure', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-disaster-corrections-'));
  let runtime: ReturnType<typeof createBusinessRuntime> | undefined;
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Restored' }); f.runtime.configureModels(config(w.id), { local: 'SYNTHETIC_KEY' });
    const request = { requestId: randomUUID(), actorId: f.admin.principal.identityId, workspaceId: w.id, conversationId: randomUUID(), payloadHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) };
    f.runtime.budget.reserve(request, { instanceAllowanceNanoUsd: 100000, workspaceAllowanceNanoUsd: 100000, maxConcurrent: 1, maxInputTokens: 100, maxOutputTokens: 100, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1 }); f.runtime.budget.hold(request.requestId);
    let source = join(temp, 'source.enc'); await f.runtime.backup(source, pass); await f.runtime.close();
    for (let cycle = 0; cycle < 2; cycle++) {
      const target = join(temp, `restored-${cycle}`); await restoreBusinessBackup(source, target, pass); const profile = openBusinessProfile(target);
      const status = businessRecoveryStatus(profile); assert.equal(status.recovering, true);
      const issued = issueBusinessReenrollment(profile, f.admin.principal.identityId);
      const plan = { generation: status.generation, organization: [{ identityId: f.admin.principal.identityId, role: 'orgadmin' }], workspaces: [{ workspaceId: w.id, identityId: f.admin.principal.identityId, role: 'manager' }], usage: 'keep-held', policy: 'disabled' };
      reconcileBusinessRecovery(profile, plan);
      assert.throws(() => completeBusinessRecovery(profile, status.generation!), /fresh individual passkey/);
      runtime = createBusinessRuntime({ profile, origin: f.runtime.origin });
      const session = runtime.auth.reenroll(issued.code, true); enroll(runtime, session);
      assert.throws(() => runtime!.policy.authorizeWorkspace(session.principal, w.id, 'read'));
      await runtime.close(); runtime = undefined;
      completeBusinessRecovery(profile, status.generation!);
      const accept = { generation: status.generation, policyHash: status.policyHash, acknowledgement: 'operator-accepted-uncertainty', unrecordedExposureNanoUsd: 50 };
      assert.throws(() => resumeBusinessSpending(profile, accept), /new model policy/);
      configureBusinessModels(profile, config(w.id));
      accept.policyHash = businessRecoveryStatus(profile).policyHash;
      resumeBusinessSpending(profile, accept);
      runtime = createBusinessRuntime({ profile, origin: f.runtime.origin });
      assert.equal(runtime.budget.lookup(request)?.state, 'held'); assert.equal(runtime.budget.exposure(w.id).instanceNanoUsd, 250 + cycle * 50);
      assert.equal(runtime.policy.authorizeWorkspace(session.principal, w.id, 'read').role, 'manager');
      source = join(temp, `next-${cycle}.enc`); await runtime.backup(source, pass); await runtime.close(); runtime = undefined;
    }
  } finally { await runtime?.close(); await f.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('packaged src subset configures business models without a checkout scripts directory or secret argv', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-b1-packaged-config-'));
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Packaged config' });
    await f.runtime.close();
    const subset = join(temp, 'package');
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(subset, 'src'), { recursive: true });
    cpSync(fileURLToPath(new URL('../web', import.meta.url)), join(subset, 'web'), { recursive: true });
    cpSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(subset, 'package.json'));
    assert.equal(existsSync(join(subset, 'scripts')), false);
    const input = join(temp, 'operator.json'); writeFileSync(input, JSON.stringify({ policy: config(w.id), keys: { local: 'SYNTHETIC_PACKAGED_KEY' } }));
    const run = spawnSync(process.execPath, [join(subset, 'src', 'main.ts'), '--business-configure', input], { env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: f.dir }, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr); assert.ok(!run.stdout.includes('SYNTHETIC_PACKAGED_KEY')); assert.ok(!run.stderr.includes('SYNTHETIC_PACKAGED_KEY'));
    assert.equal(new Vault(join(f.profile.businessDir, 'operator')).get('business-provider:local'), 'SYNTHETIC_PACKAGED_KEY');
    const runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    try {
      assert.equal(runtime.models.plan(w.id).model.model, 'fixture');
      const busy = spawnSync(process.execPath, [join(subset, 'src', 'main.ts'), '--business-configure', input], { env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: f.dir }, encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.notEqual(busy.status, 0);
    } finally { await runtime.close(); }
  } finally { await f.close(); rmSync(temp, { recursive: true, force: true }); }
});
