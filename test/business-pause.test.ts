import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { contentFixture } from './helpers/business-content.ts';
import { BusinessAuthenticator } from './business-authenticator.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';
import { BusinessBudget } from '../src/business/budget.ts';
import { setNetTransport } from '../src/net-guard.ts';
import * as recovery from '../src/business/recovery.ts';
import { openBusinessProfile } from '../src/business/profile.ts';
import { restoreBusinessBackup } from '../src/business/backup.ts';
import { configureBusinessModels } from '../src/business/model-config.ts';

const config = (id: string) => ({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 1000000, maxConcurrent: 3,
  models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false }, model: 'fixture', cloud: false, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 2000, tone: 'professional' }],
  workspaces: { [id]: { modelId: 'local', allowanceNanoUsd: 1000000 } } });
const limits = { instanceAllowanceNanoUsd: 1000000, workspaceAllowanceNanoUsd: 1000000, maxConcurrent: 3, maxInputTokens: 100, maxOutputTokens: 100, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1 };
const key = () => ({ requestId: randomUUID(), actorId: randomUUID(), workspaceId: randomUUID(), conversationId: randomUUID(), payloadHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
function authHashes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string, prefix: string) { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const name = prefix + entry.name; if (entry.isDirectory()) walk(join(path, entry.name), name + '/');
    else result[name] = createHash('sha256').update(readFileSync(join(path, entry.name))).digest('hex');
  } }
  walk(root, ''); return result;
}

test('unknown provider usage resumes only new admission after offline pause acceptance, preserving credentials and held idempotency', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-pause-')); let runtime: ReturnType<typeof createBusinessRuntime> | undefined;
  let calls = 0; let known = false;
  setNetTransport(async () => { calls++; return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic response' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], ...(known ? { usage: { prompt_tokens: 20, completion_tokens: 5 } } : {}) })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }); });
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Pause fixture' });
    const coworker = f.add('Coworker'); f.grant(w.id, coworker, 'viewer');
    const credential = new BusinessAuthenticator(); const registration = f.runtime.auth.options('register', coworker.principal.identityId, f.runtime.origin, coworker.principal);
    f.runtime.auth.finish('register', registration.challenge, credential.register(registration.challenge, f.runtime.origin), f.runtime.origin, coworker.principal);
    f.runtime.configureModels(config(w.id));
    const context = f.context(w.id); const conversation = f.runtime.chat.createConversation(context, { title: 'Unknown usage' });
    const payload = { requestId: randomUUID(), text: 'Synthetic request', modelPolicy: f.runtime.models.plan(w.id).policyHash, acknowledgeDisclosure: true };
    await assert.rejects(f.runtime.chat.send(context, conversation.id, payload)); assert.equal(calls, 1);
    assert.equal(f.runtime.budget.exposure(w.id).instanceNanoUsd, 24100);
    const pauseId = f.runtime.control.database.prepare("SELECT value FROM business_model_state WHERE key='pause_id'").get()?.value;
    assert.equal(typeof pauseId, 'string', 'Uncertainty needs a durable pause identity');
    f.runtime.budget.hold(payload.requestId);
    assert.equal(f.runtime.control.database.prepare("SELECT value FROM business_model_state WHERE key='pause_id'").get()?.value, pauseId, 'Same held request must not churn pause IDs');
    const accept = { pauseId, policyHash: payload.modelPolicy, acknowledgement: 'operator-accepted-uncertainty', unrecordedExposureNanoUsd: 50 };
    assert.throws(() => (recovery as any).resumeBusinessPause(f.profile, accept), /active writer/);
    await f.runtime.close();
    const beforeAuth = authHashes(join(f.profile.businessDir, 'auth')); const beforePolicy = readFileSync(join(f.profile.businessDir, 'model-policy.json'));
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [main, ...args], { env: { ...process.env, SARA_PROFILE: 'business', SARA_DATA: f.dir }, encoding: 'utf8', timeout: 15000, windowsHide: true });
    const status = run(['--business-status']); assert.equal(status.status, 0, status.stderr);
    const info = JSON.parse(status.stdout); assert.equal(info.pause.pauseId, pauseId); assert.equal(info.pause.heldRequests, 1); assert.equal(info.pause.unknownRequests, 1);
    assert.equal(info.pause.exposureNanoUsd, 24100); assert.ok(!status.stdout.includes('Synthetic request'));
    const input = join(temp, 'accept.json'); writeFileSync(input, JSON.stringify(accept));
    const auditDb = new DatabaseSync(join(f.profile.businessDir, 'business.db'));
    try { auditDb.exec("CREATE TRIGGER reject_pause_resume BEFORE INSERT ON business_audit WHEN NEW.action='model.resume' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;"); } finally { auditDb.close(); }
    const refused = run(['--business-resume-pause', input]); assert.notEqual(refused.status, 0);
    assert.equal((recovery.businessRecoveryStatus(f.profile) as any).pause.pauseId, pauseId);
    const repaired = new DatabaseSync(join(f.profile.businessDir, 'business.db')); try { repaired.exec('DROP TRIGGER reject_pause_resume'); } finally { repaired.close(); }
    const resumed = run(['--business-resume-pause', input]); assert.equal(resumed.status, 0, resumed.stderr);
    (recovery as any).resumeBusinessPause(f.profile, accept);
    assert.throws(() => (recovery as any).resumeBusinessPause(f.profile, { ...accept, unrecordedExposureNanoUsd: 0 }));
    assert.throws(() => (recovery as any).resumeBusinessPause(f.profile, { ...accept, policyHash: 'c'.repeat(64) }));
    assert.deepEqual(authHashes(join(f.profile.businessDir, 'auth')), beforeAuth); assert.deepEqual(readFileSync(join(f.profile.businessDir, 'model-policy.json')), beforePolicy);
    runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    assert.deepEqual(runtime.auth.principal(coworker.value), coworker.principal);
    const login = runtime.auth.options('login', undefined, runtime.origin); assert.ok(runtime.auth.finish('login', login.challenge, credential.assertion(login.challenge, runtime.origin), runtime.origin));
    assert.equal(runtime.control.workspaceMembership(w.id, coworker.principal.identityId)?.role, 'viewer');
    const current = runtime.policy.authorizeWorkspace(f.admin.principal, w.id, 'send');
    assert.equal((await runtime.chat.send(current, conversation.id, payload)).state, 'held'); assert.equal(calls, 1);
    known = true;
    const next = { ...payload, requestId: randomUUID(), text: 'New explicit request' };
    assert.equal((await runtime.chat.send(current, conversation.id, next)).state, 'completed'); assert.equal(calls, 2);
    runtime.budget.hold(next.requestId); assert.equal(runtime.budget.pauseStatus(), null, 'Completed work cannot invent another uncertainty pause');
    assert.equal(runtime.budget.exposure(w.id).instanceNanoUsd, 24175);
    known = false; await assert.rejects(runtime.chat.send(current, conversation.id, { ...payload, requestId: randomUUID(), text: 'Another uncertain request' }));
    const newer = runtime.control.database.prepare("SELECT value FROM business_model_state WHERE key='pause_id'").get()?.value; assert.notEqual(newer, pauseId);
    await runtime.close(); runtime = undefined;
    assert.throws(() => (recovery as any).resumeBusinessPause(f.profile, accept));
    assert.equal((recovery.businessRecoveryStatus(f.profile) as any).pause.pauseId, newer);
  } finally { setNetTransport(undefined); await runtime?.close(); await f.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('only new pending-to-held transitions rotate pause identity, never terminal or duplicate holds', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const budget = new BusinessBudget(db); const completed = key(); const blocked = key();
    budget.reserve(completed, limits); budget.settle(completed.requestId, { input: 2, output: 1 }); budget.finish(completed.requestId, randomUUID(), 'answer');
    budget.recordNoCall(blocked, 'minor'); budget.hold(completed.requestId); budget.hold(blocked.requestId); budget.hold(randomUUID());
    assert.equal(budget.pauseStatus(), null);
    const first = key(); const second = key(); budget.reserve(first, limits); budget.reserve(second, limits);
    budget.hold(first.requestId); const original = budget.pauseStatus()!.pauseId;
    budget.hold(second.requestId); const current = budget.pauseStatus()!.pauseId; assert.notEqual(current, original);
    budget.hold(first.requestId); budget.hold(second.requestId); budget.interruptPending();
    assert.equal(budget.pauseStatus()!.pauseId, current); assert.equal(budget.exposure().instanceNanoUsd, 403);
  } finally { db.close(); }
});

test('legacy pause and interrupted requests get stable conservative identities without rewriting accounting', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'sara-pause-legacy-')); const path = join(temp, 'ledger.db');
  const db = new DatabaseSync(path);
  try {
    let budget = new BusinessBudget(db); const unknown = key(); const known = key();
    budget.reserve(unknown, limits); budget.reserve(known, limits); budget.settle(known.requestId, { input: 20, output: 5 });
    budget.interruptPending();
    const rows = db.prepare('SELECT * FROM business_model_requests ORDER BY request_id').all();
    db.exec("DELETE FROM business_model_state WHERE key='pause_id';");
    budget = new BusinessBudget(db);
    const pauseId = db.prepare("SELECT value FROM business_model_state WHERE key='pause_id'").get()?.value;
    assert.equal(typeof pauseId, 'string');
    budget.interruptPending(); new BusinessBudget(db);
    assert.equal(db.prepare("SELECT value FROM business_model_state WHERE key='pause_id'").get()?.value, pauseId);
    assert.deepEqual(db.prepare('SELECT * FROM business_model_requests ORDER BY request_id').all(), rows);
    assert.equal(budget.exposure().instanceNanoUsd, 225);
  } finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('ordinary pause approval cannot bypass a closed or completed-but-unaccepted disaster restore', async () => {
  const f = await contentFixture(); const temp = mkdtempSync(join(tmpdir(), 'sara-pause-restore-')); let runtime: ReturnType<typeof createBusinessRuntime> | undefined;
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Restore guard' }); f.runtime.configureModels(config(w.id));
    const request = { ...key(), actorId: f.admin.principal.identityId, workspaceId: w.id }; f.runtime.budget.reserve(request, limits); f.runtime.budget.hold(request.requestId);
    const archive = join(temp, 'snapshot.enc'); await f.runtime.backup(archive, 'synthetic pause restore passphrase');
    const target = join(temp, 'restore'); await restoreBusinessBackup(archive, target, 'synthetic pause restore passphrase'); const profile = openBusinessProfile(target);
    const status = recovery.businessRecoveryStatus(profile) as any;
    const accept = { pauseId: status.pause?.pauseId, policyHash: status.policyHash, acknowledgement: 'operator-accepted-uncertainty' };
    assert.equal(typeof accept.pauseId, 'string');
    assert.throws(() => (recovery as any).resumeBusinessPause(profile, accept));
    const issued = recovery.issueBusinessReenrollment(profile, f.admin.principal.identityId);
    recovery.reconcileBusinessRecovery(profile, { generation: status.generation, organization: [{ identityId: f.admin.principal.identityId, role: 'orgadmin' }], workspaces: [{ workspaceId: w.id, identityId: f.admin.principal.identityId, role: 'manager' }], usage: 'keep-held', policy: 'disabled' });
    runtime = createBusinessRuntime({ profile, origin: f.runtime.origin });
    const session = runtime.auth.reenroll(issued.code, true); const authenticator = new BusinessAuthenticator(); const options = runtime.auth.options('register', session.principal.identityId, runtime.origin, session.principal);
    runtime.auth.finish('register', options.challenge, authenticator.register(options.challenge, runtime.origin), runtime.origin, session.principal);
    await runtime.close(); runtime = undefined;
    recovery.completeBusinessRecovery(profile, status.generation);
    assert.throws(() => (recovery as any).resumeBusinessPause(profile, accept));
    assert.equal(recovery.businessRecoveryStatus(profile).spendingPaused, true);
    configureBusinessModels(profile, config(w.id));
    const approvedPolicy = recovery.businessRecoveryStatus(profile).policyHash;
    const initial = { generation: status.generation, policyHash: approvedPolicy, acknowledgement: 'operator-accepted-uncertainty', unrecordedExposureNanoUsd: 10 };
    recovery.resumeBusinessSpending(profile, initial);
    runtime = createBusinessRuntime({ profile, origin: f.runtime.origin });
    const later = { ...key(), actorId: f.admin.principal.identityId, workspaceId: w.id }; runtime.budget.reserve(later, limits); runtime.budget.hold(later.requestId);
    const laterId = runtime.budget.pauseStatus()!.pauseId;
    await runtime.close(); runtime = undefined;
    recovery.resumeBusinessSpending(profile, initial); assert.equal(recovery.businessRecoveryStatus(profile).pause!.pauseId, laterId, 'Replaying restore acceptance cannot clear later uncertainty');
    recovery.resumeBusinessPause(profile, { pauseId: laterId, policyHash: approvedPolicy, acknowledgement: 'operator-accepted-uncertainty' });
    assert.equal(recovery.businessRecoveryStatus(profile).spendingPaused, false);
    const copied = join(temp, 'accepted.enc'); runtime = createBusinessRuntime({ profile, origin: f.runtime.origin });
    assert.equal(runtime.budget.exposure(w.id).instanceNanoUsd, 410);
    await runtime.backup(copied, 'synthetic pause restore passphrase'); await runtime.close(); runtime = undefined;
    const copyRoot = join(temp, 'accepted-restored'); await restoreBusinessBackup(copied, copyRoot, 'synthetic pause restore passphrase');
    const copiedStatus = recovery.businessRecoveryStatus(openBusinessProfile(copyRoot));
    assert.equal(copiedStatus.pause!.exposureNanoUsd, 410); assert.equal(copiedStatus.recovering, true);
  } finally { await runtime?.close(); await f.close(); rmSync(temp, { recursive: true, force: true }); }
});
