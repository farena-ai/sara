import type { BusinessWorkspaces } from './workspaces.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { BusinessControlStore } from './store.ts';
import type { BusinessPrincipal, WorkspaceContext } from './types.ts';
import { exactFields, validId } from './policy.ts';

export const AUDIT_ACTIONS = ['organization.settings', 'organization.bootstrap', 'organization.member', 'workspace.create', 'workspace.member', 'invite.create', 'invite.revoke', 'invite.redeem', 'identity.create', 'identity.epoch', 'identity.credential', 'identity.reenroll', 'identity.signin', 'identity.signin.attempt', 'identity.logout.attempt', 'content.send', 'content.document', 'model.resume', 'model.reserve', 'model.state', 'operator.configure.attempt', 'recovery.restore', 'recovery.reconcile', 'recovery.complete', 'backup.stage'] as const;
export interface AuditRecord { action: typeof AUDIT_ACTIONS[number]; actorId?: string; workspaceId?: string; subjectId?: string; revision?: number }
export function initializeAudit(db: DatabaseSync): void {
  const previous = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='business_audit'").get();
  if (previous && !String(previous.sql).includes("'organization.settings'")) {
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND instr(sql,'business_audit')>0").all();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const trigger of triggers) db.exec('DROP TRIGGER "' + String(trigger.name).replaceAll('"', '""') + '"');
      createAuditTable(db, 'business_audit_with_settings');
      db.exec('INSERT INTO business_audit_with_settings SELECT * FROM business_audit; DROP TABLE business_audit; ALTER TABLE business_audit_with_settings RENAME TO business_audit');
      for (const trigger of triggers) db.exec(String(trigger.sql));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } else createAuditTable(db);
}
function createAuditTable(db: DatabaseSync, table: 'business_audit' | 'business_audit_with_settings' = 'business_audit'): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN (${AUDIT_ACTIONS.map(action => `'${action}'`).join(',')})),
    actor_id TEXT, workspace_id TEXT, subject_id TEXT, revision INTEGER CHECK(revision>=0)
  );`);
}
/** Caller owns the mutation transaction. Only validated, bounded metadata is persisted. */
export function appendAudit(db: DatabaseSync, record: AuditRecord): void {
  exactFields(record, ['action', 'actorId', 'workspaceId', 'subjectId', 'revision']);
  if (!AUDIT_ACTIONS.includes(record.action)) throw new Error('Invalid business audit action.');
  for (const id of [record.actorId, record.workspaceId, record.subjectId]) if (id !== undefined) validId(id);
  if (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 0)) throw new Error('Invalid business audit revision.');
  db.prepare('INSERT INTO business_audit(at,action,actor_id,workspace_id,subject_id,revision) VALUES (?,?,?,?,?,?)').run(Date.now(), record.action, record.actorId ?? null, record.workspaceId ?? null, record.subjectId ?? null, record.revision ?? null);
}
export interface AuditRow { id: number; at: number; action: string; actorId: string | null; workspaceId: string | null; subjectId: string | null; revision: number | null }
export function readAudit(db: DatabaseSync, workspaceId?: string) {
  return db.prepare(`SELECT id,at,action,actor_id AS actorId,workspace_id AS workspaceId,subject_id AS subjectId,revision FROM business_audit WHERE workspace_id ${workspaceId ? '= ?' : 'IS NULL'} ORDER BY id DESC LIMIT 100`).all(...(workspaceId ? [workspaceId] : [])).map(row => ({ ...row } as unknown as AuditRow));
}
export class BusinessAudit {
  readonly #control: BusinessControlStore;
  readonly #workspaces?: BusinessWorkspaces;
  constructor(control: BusinessControlStore, workspaces?: BusinessWorkspaces) { this.#control = control; this.#workspaces = workspaces; }
  workspace(context: WorkspaceContext) {
    this.#control.policy.revalidateWorkspace(context, 'audit');
    const control = readAudit(this.#control.database, context.workspaceId).map(row => ({ ...row, source: 'control' }));
    const content = (this.#workspaces?.audit(context) ?? []).map(row => ({ ...row, source: 'content' }));
    this.#control.policy.revalidateWorkspace(context, 'audit');
    return [...control, ...content].sort((a, b) => Number(b.at) - Number(a.at) || b.source.localeCompare(a.source) || Number(b.id) - Number(a.id)).slice(0, 100);
  }
  organization(principal: BusinessPrincipal) { this.#control.policy.requireOrganizationAdmin(principal); return readAudit(this.#control.database); }
}
