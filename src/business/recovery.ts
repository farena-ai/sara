import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BusinessIdentityDirectory } from './identity.ts';
import { type BusinessProfile } from './profile.ts';
import { withBusinessWriter } from './lifecycle.ts';
import { appendAudit } from './audit.ts';
import { exactFields, validId } from './policy.ts';
import { BusinessBudget, boundedInteger } from './budget.ts';

export const recoveryHash = (code: string) => createHash('sha256').update(code).digest('hex');
export function recoveryMode(db: DatabaseSync): boolean { return !!db.prepare("SELECT value FROM business_meta WHERE key='recovery_mode'").get(); }
export function initializeRecovery(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS business_reenrollment(identity_id TEXT PRIMARY KEY REFERENCES business_identities(id),secret_hash TEXT UNIQUE NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER,allow_reactivate INTEGER NOT NULL CHECK(allow_reactivate IN (0,1)));
    CREATE TABLE IF NOT EXISTS business_recovery_fresh(identity_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,registered INTEGER NOT NULL CHECK(registered IN (0,1)));
    CREATE TABLE IF NOT EXISTS business_recovery_plan(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL,body TEXT NOT NULL);`);
}
function operator<T>(profile: BusinessProfile, work: (directory: BusinessIdentityDirectory) => T): T {
  return withBusinessWriter(profile, () => {
    const directory = new BusinessIdentityDirectory(profile);
    try { initializeRecovery(directory.database); return work(directory); } finally { directory.close(); }
  });
}
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** Trusted local operator action, never an organization-admin API or a bearer team token. */
export function issueBusinessReenrollment(profile: BusinessProfile, identityId: string, reactivate = false): { identityId: string; code: string; expiresAt: number } {
  validId(identityId);
  return operator(profile, directory => transaction(directory.database, () => {
    const db = directory.database; const identity = directory.get(identityId);
    if (!identity || identity.status !== 'active' && !reactivate) throw new Error('Explicit reactivation is required for a disabled identity.');
    // Routine credential recovery changes only this identity. Disaster restore has already
    // closed the instance globally; issuing its individual enrollment code adds no grants.
    db.prepare('UPDATE business_identities SET auth_epoch=auth_epoch+1 WHERE id=?').run(identityId);
    db.prepare('DELETE FROM business_credential_refs WHERE identity_id=?').run(identityId);
    db.prepare('DELETE FROM business_recovery_fresh WHERE identity_id=?').run(identityId);
    const epoch = directory.get(identityId)!.authEpoch;
    const code = `${identityId}.${randomBytes(32).toString('base64url')}`; const expiresAt = Date.now() + 30 * 60_000;
    db.prepare('INSERT OR REPLACE INTO business_reenrollment VALUES (?,?,?,?,NULL,?)').run(identityId, recoveryHash(code), epoch, expiresAt, Number(reactivate));
    appendAudit(db, { action: 'identity.reenroll', subjectId: identityId, revision: epoch });
    return { identityId, code, expiresAt };
  }));
}
export interface RecoveryPlan { generation: string; organization: { identityId: string; role: 'orgadmin' | 'user' }[]; workspaces: { workspaceId: string; identityId: string; role: 'manager' | 'contributor' | 'viewer' }[]; usage: 'keep-held'; policy: 'disabled' }
export function recoveryGeneration(db: DatabaseSync): string {
  const generation = db.prepare("SELECT value FROM business_meta WHERE key='recovery_generation'").get()?.value ?? db.prepare('SELECT generation FROM business_snapshot WHERE singleton=1').get()?.generation;
  validId(generation); return generation;
}
export function reconcileBusinessRecovery(profile: BusinessProfile, input: unknown): void {
  operator(profile, directory => transaction(directory.database, () => {
    const db = directory.database;
    exactFields(input, ['generation', 'organization', 'workspaces', 'usage', 'policy']);
    if (!recoveryMode(db) || input.generation !== recoveryGeneration(db) || input.usage !== 'keep-held' || input.policy !== 'disabled' || !Array.isArray(input.organization) || !Array.isArray(input.workspaces) || input.organization.length > 1000 || input.workspaces.length > 10000) throw new Error('Invalid recovery reconciliation.');
    const selected = new Set<string>(); const grants = new Set<string>();
    for (const entry of input.organization) {
      exactFields(entry, ['identityId', 'role']); validId(entry.identityId);
      if (selected.has(entry.identityId) || !['orgadmin', 'user'].includes(String(entry.role))) throw new Error('Invalid organization reconciliation.');
      const prior = db.prepare('SELECT role,status FROM recovery_prior_organization WHERE identity_id=?').get(entry.identityId);
      const explicit = db.prepare('SELECT allow_reactivate FROM business_reenrollment WHERE identity_id=?').get(entry.identityId);
      if (!prior || entry.role === 'orgadmin' && prior.role !== 'orgadmin' || prior.status !== 'active' && explicit?.allow_reactivate !== 1) throw new Error('Reconciliation cannot invent or silently reactivate authority.');
      selected.add(entry.identityId);
    }
    if (!input.organization.some(entry => entry.role === 'orgadmin')) throw new Error('Select an existing organization administrator.');
    for (const entry of input.workspaces) {
      exactFields(entry, ['workspaceId', 'identityId', 'role']); validId(entry.workspaceId); validId(entry.identityId);
      if (!selected.has(entry.identityId) || !['manager', 'contributor', 'viewer'].includes(String(entry.role)) || grants.has(entry.workspaceId + entry.identityId)) throw new Error('Invalid workspace reconciliation.');
      const prior = db.prepare('SELECT role,status FROM recovery_prior_workspace WHERE workspace_id=? AND identity_id=?').get(entry.workspaceId, entry.identityId);
      const rank = ['viewer', 'contributor', 'manager'];
      if (!prior || prior.status !== 'active' || rank.indexOf(String(entry.role)) > rank.indexOf(String(prior.role))) throw new Error('Recovery cannot create new content grants.');
      grants.add(entry.workspaceId + entry.identityId);
    }
    for (const workspaceId of new Set(input.workspaces.map(entry => entry.workspaceId))) if (!input.workspaces.some(entry => entry.workspaceId === workspaceId && entry.role === 'manager')) throw new Error('A recovered workspace needs an explicitly reconciled manager.');
    db.prepare('INSERT OR REPLACE INTO business_recovery_plan VALUES(1,?,?)').run(input.generation as string, JSON.stringify(input));
    appendAudit(db, { action: 'recovery.reconcile' });
  }));
}
export function completeBusinessRecovery(profile: BusinessProfile, generation: string): void {
  operator(profile, directory => transaction(directory.database, () => {
    const db = directory.database;
    if (!recoveryMode(db) || generation !== recoveryGeneration(db)) throw new Error('Recovery generation mismatch.');
    const row = db.prepare('SELECT body,generation FROM business_recovery_plan WHERE singleton=1').get();
    if (!row || row.generation !== generation) throw new Error('Explicit grant reconciliation required.');
    const plan = JSON.parse(String(row.body)) as RecoveryPlan;
    for (const entry of plan.organization) {
      const identity = directory.get(entry.identityId); const fresh = db.prepare('SELECT epoch,registered FROM business_recovery_fresh WHERE identity_id=?').get(entry.identityId);
      if (!identity || identity.status !== 'active' || fresh?.epoch !== identity.authEpoch || fresh.registered !== 1 || !db.prepare('SELECT credential_id FROM business_credential_refs WHERE identity_id=? AND auth_epoch=?').get(entry.identityId, identity.authEpoch)) throw new Error('Every selected identity needs fresh individual passkey enrollment.');
      db.prepare("UPDATE organization_members SET status='active',role=?,revision=revision+1 WHERE identity_id=?").run(entry.role, entry.identityId);
    }
    for (const entry of plan.workspaces) {
      db.prepare("UPDATE workspace_members SET status='active',role=?,revision=revision+1 WHERE workspace_id=? AND identity_id=?").run(entry.role, entry.workspaceId, entry.identityId);
      db.prepare("UPDATE workspaces SET status='active',policy_revision=policy_revision+1 WHERE id=?").run(entry.workspaceId);
    }
    db.exec("DELETE FROM business_meta WHERE key='recovery_mode'; DELETE FROM business_reenrollment; DELETE FROM business_recovery_plan;");
    appendAudit(db, { action: 'recovery.complete' });
  }));
}
export function businessRecoveryStatus(profile: BusinessProfile) {
  return operator(profile, directory => {
    const db = directory.database; const recovering = recoveryMode(db);
    const budget = new BusinessBudget(db); budget.interruptPending();
    const configured = join(profile.businessDir, 'model-policy.json');
    const policyHash = existsSync(configured) ? createHash('sha256').update(readFileSync(configured)).digest('hex') : null;
    const storedGeneration = db.prepare("SELECT value FROM business_meta WHERE key='recovery_generation'").get()?.value;
    const generation = typeof storedGeneration === 'string' ? storedGeneration : undefined;
    return { recovering, ...(generation ? { generation } : {}), policyHash, spendingPaused: !!db.prepare("SELECT value FROM business_model_state WHERE key='paused'").get(), pause: budget.pauseStatus(), identities: db.prepare('SELECT id,status,auth_epoch AS authEpoch FROM business_identities ORDER BY id').all(),
      organization: db.prepare('SELECT identity_id AS identityId,role,status FROM organization_members ORDER BY identity_id').all(),
      workspaces: db.prepare('SELECT workspace_id AS workspaceId,identity_id AS identityId,role,status FROM workspace_members ORDER BY workspace_id,identity_id').all(),
      fresh: db.prepare('SELECT identity_id AS identityId,epoch,registered FROM business_recovery_fresh').all() };
  });
}

/** Explicit operator acceptance adds exposure; it never settles, refunds or replays a request. */
export function resumeBusinessSpending(profile: BusinessProfile, input: unknown): void {
  operator(profile, directory => transaction(directory.database, () => {
    const db = directory.database;
    exactFields(input, ['generation', 'acknowledgement', 'unrecordedExposureNanoUsd', 'policyHash']);
    if (recoveryMode(db) || input.generation !== recoveryGeneration(db) || input.acknowledgement !== 'operator-accepted-uncertainty') throw new Error('Explicit completed recovery acceptance required.');
    const amount = boundedInteger(input.unrecordedExposureNanoUsd);
    const baseline = db.prepare("SELECT value FROM business_meta WHERE key='recovery_policy_hash'").get()?.value;
    const baselineGeneration = db.prepare("SELECT value FROM business_meta WHERE key='recovery_policy_generation'").get()?.value;
    if (baselineGeneration !== input.generation || typeof baseline !== 'string' || baseline !== 'unconfigured' && !/^[a-f0-9]{64}$/.test(baseline)) throw new Error('Restore policy baseline is unavailable.');
    const policyHash = createHash('sha256').update(readFileSync(join(profile.businessDir, 'model-policy.json'))).digest('hex');
    if (input.policyHash !== policyHash || baseline === policyHash) throw new Error('Reapprove a new model policy and its exact hash.');
    const previous = db.prepare('SELECT amount,policy_hash FROM business_operator_exposure WHERE generation=?').get(input.generation as string);
    if (previous && (previous.amount !== amount || previous.policy_hash !== policyHash)) throw new Error('Recovery exposure cannot be rewritten.');
    if (previous) return;
    db.prepare('INSERT OR IGNORE INTO business_operator_exposure VALUES (?,?,?)').run(input.generation as string, amount, policyHash);
    db.exec("DELETE FROM business_model_state WHERE key='paused';");
    appendAudit(db, { action: 'model.resume' });
  }));
}

/** Offline acceptance for a current runtime pause; no restore, refunds, replay or identity changes. */
export function resumeBusinessPause(profile: BusinessProfile, input: unknown): void {
  operator(profile, directory => {
    const db = directory.database;
    const budget = new BusinessBudget(db); budget.interruptPending();
    transaction(db, () => {
      exactFields(input, ['pauseId', 'policyHash', 'acknowledgement', 'unrecordedExposureNanoUsd']); validId(input.pauseId);
      if (recoveryMode(db) || input.acknowledgement !== 'operator-accepted-uncertainty') throw new Error('Ordinary pause acceptance is unavailable during disaster recovery.');
      const generation = db.prepare("SELECT value FROM business_meta WHERE key='recovery_generation'").get()?.value;
      if (generation && !db.prepare('SELECT generation FROM business_operator_exposure WHERE generation=?').get(generation)) throw new Error('Complete initial restore policy and usage acceptance first.');
      const amount = input.unrecordedExposureNanoUsd === undefined ? 0 : boundedInteger(input.unrecordedExposureNanoUsd);
      const policyHash = createHash('sha256').update(readFileSync(join(profile.businessDir, 'model-policy.json'))).digest('hex');
      if (input.policyHash !== policyHash) throw new Error('Review the exact current model policy before accepting this pause.');
      const pause = db.prepare('SELECT accepted_at,policy_hash,additional_exposure FROM business_spending_pauses WHERE id=?').get(input.pauseId);
      if (!pause) throw new Error('Unknown spending pause.');
      const active = budget.pauseStatus();
      if (pause.accepted_at !== null) {
        if (pause.policy_hash !== policyHash || pause.additional_exposure !== amount || active) throw new Error('A previous acceptance cannot change exposure or clear a new pause.');
        return;
      }
      if (!active || active.pauseId !== input.pauseId) throw new Error('The spending pause changed; review the current pause.');
      db.prepare('INSERT INTO business_operator_exposure(generation,amount,policy_hash) VALUES (?,?,?)').run(`pause:${input.pauseId}`, amount, policyHash);
      db.prepare('UPDATE business_spending_pauses SET accepted_at=?,policy_hash=?,additional_exposure=? WHERE id=? AND accepted_at IS NULL').run(Date.now(), policyHash, amount, input.pauseId);
      db.exec("DELETE FROM business_model_state WHERE key IN ('paused','pause_id');");
      appendAudit(db, { action: 'model.resume', subjectId: input.pauseId });
    });
  });
}
