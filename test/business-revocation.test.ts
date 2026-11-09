import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { contentFixture } from './helpers/business-content.ts';
import { issueBusinessReenrollment, reconcileBusinessRecovery, completeBusinessRecovery, businessRecoveryStatus } from '../src/business/recovery.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';
import { BusinessAuthenticator } from './business-authenticator.ts';
import * as recovery from '../src/business/recovery.ts';
import { configureBusinessModels } from '../src/business/model-config.ts';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

test('close waits for directly accepted chat retrieval before closing its control database', async () => {
  const f = await contentFixture();
  let release!: () => void;
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Drain' });
    const context = f.context(w.id);
    const conversation = f.runtime.chat.createConversation(context, { title: 'Synthetic' });
    const retrieve = f.runtime.retrieval.retrieve.bind(f.runtime.retrieval);
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.retrieval.retrieve = async (...args) => { await gate; return retrieve(...args); };
    const pending = f.runtime.chat.send(context, conversation.id, { requestId: randomUUID(), text: 'Hello' }).catch(() => {});
    let closed = false;
    const stopped = f.runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, false, 'Accepted direct work must settle before closing SQLite');
    release(); await pending; await stopped;
  } finally { release?.(); await f.close(); }
});

test('shutdown closes direct admission and drains accepted document work before database close', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Recovery fixture' });
    const context = f.context(w.id);
    const pending = f.runtime.documents.create(context, { title: 'Accepted', mime: 'text/plain', body: 'synthetic' });
    const stopped = f.runtime.close();
    await pending;
    await stopped;
    await assert.rejects(f.runtime.documents.create(context, { title: 'Late', mime: 'text/plain', body: 'synthetic' }));
  } finally { await f.close(); }
});

test('control audit is transactional fixed metadata and denies nonmember or viewer reads', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'SECRET TITLE' });
    const viewer = f.add('Synthetic viewer'); f.grant(w.id, viewer);
    const stranger = f.add('Synthetic stranger');
    assert.equal(typeof (f.runtime as any).audit?.workspace, 'function', 'Durable audit API required');
    assert.ok(f.runtime.audit.organization(f.admin.principal).some(row => row.action === 'identity.signin.attempt'), 'Filesystem session changes need conservative audit intent');
    const rows = (f.runtime as any).audit.workspace(f.context(w.id));
    assert.ok(rows.some((row: any) => row.action === 'workspace.create'));
    assert.ok(!JSON.stringify(rows).includes('SECRET TITLE'));
    assert.throws(() => (f.runtime as any).audit.workspace(f.context(w.id, viewer)));
    assert.throws(() => (f.runtime as any).audit.workspace({ ...f.context(w.id), principal: stranger.principal }));
    await f.runtime.documents.create(f.context(w.id), { title: 'SECRET FILE', mime: 'text/plain', body: 'SECRET CONTENT' });
    const endpoint = `/api/business/workspaces/${w.id}/audit`;
    const response = await f.request(endpoint); assert.equal(response.status, 200);
    const audit = await response.json(); assert.ok(audit.some((row: any) => row.action === 'content.document'));
    assert.ok(!JSON.stringify(audit).includes('SECRET'));
    assert.equal((await f.request(endpoint, viewer)).status, 404);
    assert.equal((await f.request(endpoint, stranger)).status, 404);
    const before = f.runtime.control.database.prepare('SELECT count(*) AS n FROM business_audit').get()!.n;
    assert.throws(() => f.runtime.control.transaction(() => { throw new Error('synthetic raw exception'); }));
    assert.equal(f.runtime.control.database.prepare('SELECT count(*) AS n FROM business_audit').get()!.n, before);
    const count = f.runtime.control.database.prepare('SELECT count(*) AS n FROM workspaces').get()!.n;
    f.runtime.control.database.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON business_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
    assert.throws(() => f.runtime.control.createWorkspace(f.admin.principal, { name: 'Must roll back' }));
    assert.equal(f.runtime.control.database.prepare('SELECT count(*) AS n FROM workspaces').get()!.n, count);
    f.runtime.control.database.exec('DROP TRIGGER deny_audit');
    const content = new DatabaseSync(join(f.profile.businessDir, 'workspaces', w.id, 'content.db'));
    try {
      const count = content.prepare('SELECT count(*) AS n FROM documents').get()!.n;
      content.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON business_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
      await assert.rejects(f.runtime.documents.create(f.context(w.id), { title: 'Must roll back', mime: 'text/plain', body: 'synthetic' }));
      assert.equal(content.prepare('SELECT count(*) AS n FROM documents').get()!.n, count);
    } finally { content.close(); }
  } finally { await f.close(); }
});

test('lost first browser requires offline individual reenrollment and fresh passkey while retaining live grants', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Retained' });
    const other = f.add('Not reconciled'); f.grant(w.id, other, 'contributor');
    const invite = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' });
    const originalEpoch = f.admin.principal.authEpoch;
    await f.runtime.close();
    const issued = issueBusinessReenrollment(f.profile, f.admin.principal.identityId);
    const state = businessRecoveryStatus(f.profile); assert.equal(state.recovering, false);
    const runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    try {
      assert.equal(runtime.auth.principal(f.admin.value), undefined);
      assert.throws(() => runtime.control.previewInvite(invite.code));
      const session = runtime.auth.reenroll(issued.code, true);
      assert.ok(session.principal.authEpoch > originalEpoch);
      assert.throws(() => runtime.auth.reenroll(issued.code, true));
      assert.throws(() => runtime.policy.authorizeWorkspace(session.principal, w.id, 'read'));
      const key = new BusinessAuthenticator();
      const options = runtime.auth.options('register', session.principal.identityId, runtime.origin, session.principal);
      runtime.auth.finish('register', options.challenge, key.register(options.challenge, runtime.origin), runtime.origin, session.principal);
    } finally { await runtime.close(); }
    const recovered = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    try {
      assert.equal(recovered.control.organizationMembership(other.principal.identityId)?.status, 'active');
      assert.equal(recovered.control.workspaceMembership(w.id, other.principal.identityId)?.status, 'active');
      assert.equal(recovered.control.database.prepare("SELECT value FROM business_model_state WHERE key='paused'").get()?.value, undefined);
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

test('operator resume preserves held idempotency/exposure and adds conservative unrecorded spend', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Spending' });
    const request = { requestId: randomUUID(), actorId: f.admin.principal.identityId, workspaceId: w.id, conversationId: randomUUID(), payloadHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) };
    const limits = { instanceAllowanceNanoUsd: 100000, workspaceAllowanceNanoUsd: 100000, maxConcurrent: 2, maxInputTokens: 100, maxOutputTokens: 100, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1 };
    f.runtime.budget.reserve(request, limits); f.runtime.budget.hold(request.requestId);
    const generation = randomUUID();
    f.runtime.control.database.prepare("INSERT OR REPLACE INTO business_meta(key,value) VALUES('recovery_generation',?)").run(generation);
    f.runtime.control.database.prepare("INSERT OR REPLACE INTO business_meta(key,value) VALUES('recovery_policy_generation',?)").run(generation);
    f.runtime.control.database.prepare("INSERT OR REPLACE INTO business_meta(key,value) VALUES('recovery_policy_hash','unconfigured')").run();
    await f.runtime.close();
    assert.equal(typeof (recovery as any).resumeBusinessSpending, 'function', 'Explicit accounting-preserving resume required');
    const policy = { version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 100000, maxConcurrent: 2,
      models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false }, model: 'fixture', cloud: false, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 2000, tone: 'professional' }],
      workspaces: { [w.id]: { modelId: 'local', allowanceNanoUsd: 100000 } } };
    configureBusinessModels(f.profile, policy);
    const input = { generation, acknowledgement: 'operator-accepted-uncertainty', unrecordedExposureNanoUsd: 500, policyHash: '' };
    const probe = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    try { input.policyHash = probe.models.plan(w.id).policyHash; } finally { await probe.close(); }
    (recovery as any).resumeBusinessSpending(f.profile, input);
    (recovery as any).resumeBusinessSpending(f.profile, input);
    assert.throws(() => (recovery as any).resumeBusinessSpending(f.profile, { ...input, unrecordedExposureNanoUsd: 0 }));
    const runtime = createBusinessRuntime({ profile: f.profile, origin: f.runtime.origin });
    try {
      assert.equal(runtime.budget.lookup(request)?.state, 'held');
      assert.equal(runtime.budget.exposure(w.id).instanceNanoUsd, 700);
      assert.equal(runtime.budget.exposure(w.id).workspaceNanoUsd, 700);
      assert.equal(runtime.budget.reserve(request, limits).existing, true);
    } finally { await runtime.close(); }
  } finally { await f.close(); }
});
