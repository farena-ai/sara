import type { BusinessWorkspaces } from './workspaces.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { BusinessControlStore } from './store.ts';
import { BUSINESS_UUID, type BusinessPrincipal, type WorkspaceContext } from './types.ts';
import { exactFields, validId } from './policy.ts';
import { createHash } from 'node:crypto';
import { csvCell } from '../audit-trail.ts';

export const AUDIT_ACTIONS = ['organization.settings', 'organization.bootstrap', 'organization.member', 'workspace.create', 'workspace.member', 'invite.create', 'invite.revoke', 'invite.redeem', 'identity.create', 'identity.epoch', 'identity.credential', 'identity.reenroll', 'identity.signin', 'identity.signin.attempt', 'identity.logout.attempt', 'content.send', 'content.document', 'model.resume', 'model.reserve', 'model.state', 'operator.configure.attempt', 'recovery.restore', 'recovery.reconcile', 'recovery.complete', 'backup.stage', 'sso.configure', 'sso.test', 'sso.signin', 'sso.refused', 'sso.revoked', 'sso.link', 'scim.configure', 'scim.token', 'scim.user.create', 'scim.user.update', 'scim.user.deactivate', 'scim.user.delete', 'scim.group', 'scim.refused', 'usage.export', 'page.create', 'page.edit', 'page.delete', 'page.comment', 'page.resolve', 'page.person.delete', 'content.hold', 'audit.export', 'team.role', 'team.settings', 'inbox.add', 'inbox.assign', 'inbox.reply', 'inbox.done', 'inbox.sent', 'approval.request', 'approval.decide'] as const;
export interface AuditRecord { action: typeof AUDIT_ACTIONS[number]; actorId?: string; workspaceId?: string; subjectId?: string; revision?: number }
export function initializeAudit(db: DatabaseSync): void {
  const previous = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='business_audit'").get();
  // Any action missing from the stored CHECK list (an older schema) rebuilds the table in place.
  if (previous && AUDIT_ACTIONS.some(action => !String(previous.sql).includes(`'${action}'`))) {
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
  /**
   * R7: the whole control audit (organization and workspace rows) for a date range, as CSV or JSON,
   * organization administrators only. Rows hold ids and action names only, never content. The
   * export itself is one `audit.export` row.
   */
  organizationExport(principal: BusinessPrincipal, query: { from?: string | null; to?: string | null; format: 'csv' | 'json'; actor?: string | null; action?: string | null; workspaces?: boolean }): { body: string; contentType: string; filename: string } {
    this.#control.policy.requireOrganizationAdmin(principal);
    const day = (value: string | null | undefined, end: boolean): number | undefined => {
      if (!value) return undefined;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error('Use dates like 2026-11-15.');
      return Date.parse(`${value}T00:00:00Z`) + (end ? 86_400_000 - 1 : 0);
    };
    const from = day(query.from, false) ?? 0; const to = day(query.to, true) ?? Number.MAX_SAFE_INTEGER;
    // W3.3: who (one account id) and what (an action, or its first word such as `inbox`).
    if (query.actor && !BUSINESS_UUID.test(query.actor)) throw new Error('Unknown audit filter.');
    const what = query.action ?? '';
    if (what && !AUDIT_ACTIONS.some(action => action === what || action.startsWith(`${what}.`))) throw new Error('Unknown audit filter.');
    const keep = (r: { action: string; actorId: string | null }) => (!query.actor || r.actorId === query.actor) && (!what || r.action === what || r.action.startsWith(`${what}.`));
    const db = this.#control.database;
    const names = new Map(db.prepare('SELECT id,name FROM business_identities').all().map(r => [String(r.id), String(r.name)]));
    const rows = db.prepare('SELECT id,at,action,actor_id AS actorId,workspace_id AS workspaceId,subject_id AS subjectId,revision FROM business_audit WHERE at>=? AND at<=? ORDER BY id LIMIT 50000').all(from, to)
      .map(r => ({ id: Number(r.id), at: new Date(Number(r.at)).toISOString(), action: String(r.action), actorId: r.actorId === null ? null : String(r.actorId), actorName: r.actorId === null ? null : names.get(String(r.actorId)) ?? null, workspaceId: r.workspaceId === null ? null : String(r.workspaceId), subjectId: r.subjectId === null ? null : String(r.subjectId), revision: r.revision === null ? null : Number(r.revision) }))
      .map(r => query.workspaces ? { ...r, source: 'control' } : r).filter(keep);
    // W3.3: workspace activity rows (team inbox, approvals, pages) on request; metadata only, never content.
    if (query.workspaces) for (const r of this.#workspaces?.exportAudit(from, to) ?? []) {
      const row = { id: r.id, at: new Date(r.at).toISOString(), action: r.action, actorId: r.actorId, actorName: r.actorId === null ? null : names.get(r.actorId) ?? null, workspaceId: r.workspaceId, subjectId: r.subjectId, revision: r.revision, source: 'workspace' };
      if (keep(row)) rows.push(row);
    }
    if (query.workspaces) rows.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    const cols = (query.workspaces ? ['id', 'at', 'action', 'actorId', 'actorName', 'workspaceId', 'subjectId', 'revision', 'source'] : ['id', 'at', 'action', 'actorId', 'actorName', 'workspaceId', 'subjectId', 'revision']) as (keyof typeof rows[number])[];
    const data = query.format === 'csv' ? [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n' : rows.map(r => JSON.stringify(r)).join('\n');
    const sha256 = createHash('sha256').update(data).digest('hex');
    appendAudit(db, { action: 'audit.export', actorId: principal.identityId });
    const stamp = new Date().toISOString().slice(0, 10);
    if (query.format === 'csv') return { body: data, contentType: 'text/csv; charset=utf-8', filename: `sara-business-audit-${stamp}.csv` };
    return { body: JSON.stringify({ kind: 'sara-business-audit-export', version: 1, createdAt: new Date().toISOString(), from: query.from ?? null, to: query.to ?? null, content: false, ...(query.actor ? { actor: query.actor } : {}), ...(what ? { action: what } : {}), ...(query.workspaces ? { workspaces: true } : {}), rows: rows.length, sha256OfJsonLines: sha256, entries: rows }, null, 2) + '\n', contentType: 'application/json; charset=utf-8', filename: `sara-business-audit-${stamp}.json` };
  }
}
