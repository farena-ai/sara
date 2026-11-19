// W3.3 team workspace (docs/design/W3_TEAM.md). Business mode only. Team roles sit on top of the
// existing organization roles (owner = the break-glass account that set the instance up, admin =
// organization administrator, member = organization user, guest = an organization user who may only
// read), one permission matrix, the organization's spend limit, and per-workspace team inbox and
// approvals stored in that workspace's own content database (shared projects = workspaces with their
// own membership). Every write re-checks the workspace role through BusinessWorkspaces and writes one
// metadata-only audit row; message text never reaches the audit.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appendAudit } from './audit.ts';
import { businessText } from './documents.ts';
import { BusinessAccessError, exactFields, validId } from './policy.ts';
import type { BusinessControlStore } from './store.ts';
import { teamGuest } from './team-schema.ts';
import type { BusinessPrincipal, WorkspaceContext } from './types.ts';
import type { BusinessWorkspaces } from './workspaces.ts';
import { en } from '../i18n.ts';

export const TEAM_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type TeamRole = typeof TEAM_ROLES[number];
export interface TeamMatrixRow { id: string; label: string; roles: readonly TeamRole[]; workspace?: string }

const ALL: readonly TeamRole[] = TEAM_ROLES;
const STAFF: readonly TeamRole[] = ['owner', 'admin', 'member'];
const ADMINS: readonly TeamRole[] = ['owner', 'admin'];
/** The one permission matrix: the routes below enforce exactly these rows (test/w3-team.test.ts). */
export const TEAM_MATRIX: readonly TeamMatrixRow[] = Object.freeze([
  { id: 'team.view', label: en('See your role and this table'), roles: ALL },
  { id: 'workspace.read', label: en('Read the workspaces you were added to'), roles: ALL },
  { id: 'workspace.write', label: en('Send messages, share documents and edit pages'), roles: STAFF, workspace: en('contributor or manager') },
  { id: 'inbox.read', label: en('Read the team inbox'), roles: STAFF },
  { id: 'inbox.work', label: en('Add, assign and draft replies in the team inbox'), roles: STAFF, workspace: en('contributor or manager') },
  { id: 'inbox.reply.direct', label: en('Reply as the team without waiting for approval'), roles: STAFF, workspace: en('manager') },
  { id: 'approval.request', label: en('Ask for an approval (spending)'), roles: STAFF, workspace: en('contributor or manager') },
  { id: 'approval.decide', label: en('Approve replies and spending up to the limit'), roles: STAFF, workspace: en('manager, or an admin in the workspace') },
  { id: 'approval.decide.over', label: en('Approve spending over the limit'), roles: ADMINS, workspace: en('any role except view only') },
  { id: 'workspace.create', label: en('Create workspaces and invite people'), roles: ADMINS },
  { id: 'team.roles', label: en('Change team roles'), roles: ADMINS },
  { id: 'team.settings', label: en('Set the spend limit'), roles: ADMINS },
  { id: 'audit.export', label: en('Export the audit (CSV or JSON)'), roles: ADMINS },
  { id: 'sso.configure', label: en('Set up company sign-in and map groups to roles'), roles: ADMINS },
].map(row => Object.freeze(row)));
export function teamCan(role: TeamRole | undefined, action: string): boolean {
  return !!role && !!TEAM_MATRIX.find(row => row.id === action)?.roles.includes(role);
}

/**
 * SSO group mapping. Administrator groups beat member groups beat guest groups. `null` = no group
 * rules (everyone passing the domain rule is a member); `undefined` = in no listed group (refused).
 */
export function ssoGroupRole(config: { adminGroups: string[]; memberGroups: string[]; guestGroups?: string[] }, groups: Iterable<string>): { role: 'orgadmin' | 'user'; guest: boolean } | null | undefined {
  const guests = config.guestGroups ?? [];
  if (!config.adminGroups.length && !config.memberGroups.length && !guests.length) return null;
  const set = new Set(groups);
  if (config.adminGroups.some(g => set.has(g))) return { role: 'orgadmin', guest: false };
  if (config.memberGroups.some(g => set.has(g))) return { role: 'user', guest: false };
  if (guests.some(g => set.has(g))) return { role: 'user', guest: true };
  return undefined;
}

/** SSO sign-in and session checks keep the guest mark in step with the provider's groups. Never the owner. */
export function syncTeamGuest(control: BusinessControlStore, identityId: string, guest: boolean): void {
  validId(identityId);
  if (identityId === control.identities.firstIdentityId()) return;
  if (guest && control.organizationMembership(identityId)?.role !== 'user') return;
  if (teamGuest(control.database, identityId) === guest) return;
  control.transaction(() => {
    if (guest) control.database.prepare('INSERT OR IGNORE INTO business_team_guests(identity_id,since) VALUES (?,?)').run(identityId, Date.now());
    else control.database.prepare('DELETE FROM business_team_guests WHERE identity_id=?').run(identityId);
    appendAudit(control.database, { action: 'team.role', actorId: identityId, subjectId: identityId });
  });
}

export const DEFAULT_SPEND_LIMIT_CENTS = 50_000;
const MAX_CENTS = 100_000_000_00;
const now = () => new Date().toISOString();
const cents = (value: unknown, min: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > MAX_CENTS) throw new BusinessAccessError(400);
  return value as number;
};

interface InboxRow { id: string; subject: string; sender: string; body: string; addedBy: string; addedAt: string; assigneeId: string | null; status: 'open' | 'done'; updatedAt: string; waiting: number }
interface ReplyRow { id: string; itemId: string; body: string; authorId: string; createdAt: string; status: 'pending' | 'approved' | 'refused' | 'sent'; approvalId: string | null; decidedBy: string | null; decidedAt: string | null; sentBy: string | null; sentAt: string | null }
interface ApprovalRow { id: string; kind: 'spend' | 'reply'; title: string; amountCents: number | null; refId: string | null; requestedBy: string; requestedAt: string; needs: 'manager' | 'admin'; status: 'pending' | 'approved' | 'refused'; decidedBy: string | null; decidedAt: string | null }
const all = <T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] => db.prepare(sql).all(...params).map(row => ({ ...row }) as T);
const INBOX_COLS = `id,subject,sender,body,added_by AS addedBy,added_at AS addedAt,assignee_id AS assigneeId,status,updated_at AS updatedAt,
  (SELECT count(*) FROM team_replies r WHERE r.item_id=team_inbox.id AND r.status='pending') AS waiting`;
const REPLY_COLS = 'id,item_id AS itemId,body,author_id AS authorId,created_at AS createdAt,status,approval_id AS approvalId,decided_by AS decidedBy,decided_at AS decidedAt,sent_by AS sentBy,sent_at AS sentAt';
const APPROVAL_COLS = 'id,kind,title,amount_cents AS amountCents,ref_id AS refId,requested_by AS requestedBy,requested_at AS requestedAt,needs,status,decided_by AS decidedBy,decided_at AS decidedAt';

export class BusinessTeam {
  readonly #control: BusinessControlStore;
  readonly #workspaces: BusinessWorkspaces;
  constructor(deps: { control: BusinessControlStore; workspaces: BusinessWorkspaces }) { this.#control = deps.control; this.#workspaces = deps.workspaces; }
  #name(id: string | null): string | null { return id ? this.#control.identities.get(id)?.name ?? null : null; }
  #db(): DatabaseSync { return this.#control.database; }

  roleOf(identityId: string): TeamRole | undefined {
    const member = this.#control.organizationMembership(identityId);
    if (!member || member.status !== 'active' || this.#control.identities.get(identityId)?.status !== 'active') return undefined;
    if (member.role === 'orgadmin') return identityId === this.#control.identities.firstIdentityId() ? 'owner' : 'admin';
    return teamGuest(this.#db(), identityId) ? 'guest' : 'member';
  }
  spendLimitCents(): number {
    const row = this.#db().prepare("SELECT value FROM business_team_settings WHERE key='spend_limit_cents'").get();
    const value = row ? Number(row.value) : DEFAULT_SPEND_LIMIT_CENTS;
    return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_SPEND_LIMIT_CENTS;
  }

  /** Everyone sees their role and the matrix; administrators also get the roster with team roles. */
  view(principal: BusinessPrincipal) {
    this.#control.policy.requireOrganization(principal);
    const role = this.roleOf(principal.identityId)!;
    const base = { role, roles: TEAM_ROLES, matrix: TEAM_MATRIX, settings: { spendLimitCents: this.spendLimitCents() } };
    if (!teamCan(role, 'team.roles')) return base;
    const people = (this.#control.listOrganizationUsers(principal) as { id: string; name: string; status: string }[])
      .filter(person => person.status === 'active').map(person => ({ id: String(person.id), name: String(person.name), role: this.roleOf(String(person.id)) ?? null }));
    return { ...base, people };
  }
  /** owner never changes; admin/member/guest reuse the organization role rules (last active admin stays). */
  setRole(principal: BusinessPrincipal, identityId: string, input: unknown): { id: string; role: TeamRole } {
    exactFields(input, ['role']); validId(identityId);
    const want = input.role;
    if (want !== 'admin' && want !== 'member' && want !== 'guest') throw new BusinessAccessError(400);
    this.#control.policy.requireOrganizationAdmin(principal);
    const current = this.roleOf(identityId);
    if (!current) throw new BusinessAccessError(404);
    if (current === 'owner') throw new BusinessAccessError(409, en('The owner set up this instance and keeps that role.'));
    const orgRole = want === 'admin' ? 'orgadmin' : 'user';
    if (this.#control.organizationMembership(identityId)!.role !== orgRole) this.#control.setOrganizationMember(principal, identityId, { role: orgRole });
    this.#control.transaction(() => {
      this.#control.policy.requireOrganizationAdmin(principal);
      if (want === 'guest') this.#db().prepare('INSERT OR IGNORE INTO business_team_guests(identity_id,since) VALUES (?,?)').run(identityId, Date.now());
      else this.#db().prepare('DELETE FROM business_team_guests WHERE identity_id=?').run(identityId);
      appendAudit(this.#db(), { action: 'team.role', actorId: principal.identityId, subjectId: identityId });
    });
    return { id: identityId, role: this.roleOf(identityId)! };
  }
  saveSettings(principal: BusinessPrincipal, input: unknown): { spendLimitCents: number } {
    exactFields(input, ['spendLimitCents']);
    const limit = cents(input.spendLimitCents, 0);
    this.#control.transaction(() => {
      this.#control.policy.requireOrganizationAdmin(principal);
      this.#db().prepare("INSERT INTO business_team_settings(key,value) VALUES ('spend_limit_cents',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(limit));
      appendAudit(this.#db(), { action: 'team.settings', actorId: principal.identityId });
    });
    return { spendLimitCents: this.spendLimitCents() };
  }

  // ---- Team inbox and approvals (per workspace) ----
  /** Guests never see the inbox or approvals: the same 404 as a workspace they are not in. */
  #staff(context: WorkspaceContext): TeamRole {
    const role = this.roleOf(context.principal.identityId);
    if (!role || role === 'guest') throw new BusinessAccessError(404);
    return role;
  }
  #item(db: DatabaseSync, id: string): InboxRow {
    validId(id);
    const row = db.prepare(`SELECT ${INBOX_COLS} FROM team_inbox WHERE id=?`).get(id);
    if (!row) throw new BusinessAccessError(404);
    return { ...row } as unknown as InboxRow;
  }
  #showItem(item: InboxRow) { return { ...item, addedByName: this.#name(item.addedBy), assignee: this.#name(item.assigneeId) }; }
  #showReply(reply: ReplyRow) { return { ...reply, author: this.#name(reply.authorId), decidedBy: this.#name(reply.decidedBy), sentBy: this.#name(reply.sentBy) }; }
  #showApproval(row: ApprovalRow) { return { ...row, requester: this.#name(row.requestedBy), decidedBy: this.#name(row.decidedBy), mine: false }; }

  inbox(context: WorkspaceContext) {
    this.#staff(context);
    return this.#workspaces.pages(context, 'read', db => all<InboxRow>(db, `SELECT ${INBOX_COLS} FROM team_inbox ORDER BY status='done', updated_at DESC, id LIMIT 200`)).map(item => this.#showItem(item));
  }
  /** Who an inbox item can be assigned to: active members of this workspace who are not guests. */
  assignable(context: WorkspaceContext): { id: string; name: string }[] {
    this.#staff(context); this.#workspaces.revalidate(context);
    const rows = this.#control.database.prepare(`SELECT i.id,i.name FROM workspace_members m JOIN business_identities i ON i.id=m.identity_id JOIN organization_members o ON o.identity_id=i.id
      WHERE m.workspace_id=? AND m.status='active' AND i.status='active' AND o.status='active' ORDER BY i.name,i.id LIMIT 500`).all(context.workspaceId)
      .map(row => ({ id: String(row.id), name: String(row.name) })).filter(person => this.roleOf(person.id) !== 'guest');
    this.#workspaces.revalidate(context); return rows;
  }
  thread(context: WorkspaceContext, id: string) {
    this.#staff(context);
    return this.#workspaces.pages(context, 'read', db => {
      const item = this.#item(db, id);
      return { ...this.#showItem(item), replies: all<ReplyRow>(db, `SELECT ${REPLY_COLS} FROM team_replies WHERE item_id=? ORDER BY created_at, id`, id).map(reply => this.#showReply(reply)) };
    });
  }
  add(context: WorkspaceContext, input: unknown) {
    this.#staff(context);
    exactFields(input, ['subject', 'sender', 'body']);
    const subject = businessText(input.subject, 200).trim(); const sender = businessText(input.sender, 320).trim(); const body = businessText(input.body, 32_000);
    const id = randomUUID(); const at = now();
    return this.#showItem(this.#workspaces.pages(context, 'document', db => {
      db.prepare("INSERT INTO team_inbox(id,subject,sender,body,added_by,added_at,assignee_id,status,updated_at) VALUES (?,?,?,?,?,?,NULL,'open',?)").run(id, subject, sender, body, context.principal.identityId, at, at);
      return this.#item(db, id);
    }, { action: 'inbox.add', subjectId: id }));
  }
  assign(context: WorkspaceContext, id: string, input: unknown) {
    this.#staff(context);
    exactFields(input, ['assigneeId']);
    const assignee = input.assigneeId;
    if (assignee !== null) {
      if (typeof assignee !== 'string') throw new BusinessAccessError(400);
      validId(assignee);
      const grant = this.#control.workspaceMembership(context.workspaceId, assignee);
      const role = this.roleOf(assignee);
      if (!grant || grant.status !== 'active' || !role || role === 'guest') throw new BusinessAccessError(400);
    }
    return this.#showItem(this.#workspaces.pages(context, 'document', db => {
      this.#item(db, id);
      db.prepare('UPDATE team_inbox SET assignee_id=?,updated_at=? WHERE id=?').run(assignee as string | null, now(), id);
      return this.#item(db, id);
    }, { action: 'inbox.assign', subjectId: id }));
  }
  /** Reply as the team: a manager's reply is ready at once; anyone else's waits for a manager's OK. */
  reply(context: WorkspaceContext, id: string, input: unknown) {
    this.#staff(context);
    exactFields(input, ['body']);
    const body = businessText(input.body, 32_000);
    const direct = context.role === 'manager';
    const replyId = randomUUID(); const approvalId = direct ? null : randomUUID(); const at = now(); const actor = context.principal.identityId;
    return this.#showReply(this.#workspaces.pages(context, 'document', db => {
      const item = this.#item(db, id);
      db.prepare('INSERT INTO team_replies(id,item_id,body,author_id,created_at,status,approval_id,decided_by,decided_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(replyId, id, body, actor, at, direct ? 'approved' : 'pending', approvalId, direct ? actor : null, direct ? at : null);
      if (approvalId) db.prepare("INSERT INTO team_approvals(id,kind,title,amount_cents,ref_id,requested_by,requested_at,needs,status) VALUES (?,'reply',?,NULL,?,?,?,'manager','pending')").run(approvalId, item.subject.slice(0, 200), replyId, actor, at);
      db.prepare('UPDATE team_inbox SET updated_at=? WHERE id=?').run(at, id);
      return { ...db.prepare(`SELECT ${REPLY_COLS} FROM team_replies WHERE id=?`).get(replyId) } as unknown as ReplyRow;
    }, { action: 'inbox.reply', subjectId: replyId }));
  }
  done(context: WorkspaceContext, id: string, input: unknown) {
    this.#staff(context);
    exactFields(input, ['open']);
    if (input.open !== undefined && typeof input.open !== 'boolean') throw new BusinessAccessError(400);
    return this.#showItem(this.#workspaces.pages(context, 'document', db => {
      this.#item(db, id);
      db.prepare('UPDATE team_inbox SET status=?,updated_at=? WHERE id=?').run(input.open ? 'open' : 'done', now(), id);
      return this.#item(db, id);
    }, { action: 'inbox.done', subjectId: id }));
  }
  /** Sara does not send mail from business mode: the person who sent the approved reply marks it sent. */
  sent(context: WorkspaceContext, id: string, replyId: string) {
    this.#staff(context); validId(replyId);
    return this.#showReply(this.#workspaces.pages(context, 'document', db => {
      this.#item(db, id);
      const reply = db.prepare(`SELECT ${REPLY_COLS} FROM team_replies WHERE id=? AND item_id=?`).get(replyId, id) as unknown as ReplyRow | undefined;
      if (!reply) throw new BusinessAccessError(404);
      if (reply.status !== 'approved') throw new BusinessAccessError(409, en('Only an approved reply can be marked as sent.'));
      db.prepare("UPDATE team_replies SET status='sent',sent_by=?,sent_at=? WHERE id=?").run(context.principal.identityId, now(), replyId);
      return { ...db.prepare(`SELECT ${REPLY_COLS} FROM team_replies WHERE id=?`).get(replyId) } as unknown as ReplyRow;
    }, { action: 'inbox.sent', subjectId: replyId }));
  }

  approvals(context: WorkspaceContext) {
    this.#staff(context);
    const me = context.principal.identityId;
    return this.#workspaces.pages(context, 'read', db => all<ApprovalRow>(db, `SELECT ${APPROVAL_COLS} FROM team_approvals ORDER BY status<>'pending', requested_at DESC, id LIMIT 200`))
      .map(row => ({ ...this.#showApproval(row), mine: row.requestedBy === me, canDecide: row.status === 'pending' && this.#mayDecide(context, row) }));
  }
  /** Spending up to the organization's limit needs a manager; over it, an administrator in this workspace. */
  request(context: WorkspaceContext, input: unknown) {
    this.#staff(context);
    exactFields(input, ['kind', 'title', 'amountCents']);
    if (input.kind !== 'spend') throw new BusinessAccessError(400);
    const title = businessText(input.title, 200).trim(); const amount = cents(input.amountCents, 1);
    const needs = amount > this.spendLimitCents() ? 'admin' : 'manager';
    const id = randomUUID();
    return this.#showApproval(this.#workspaces.pages(context, 'document', db => {
      db.prepare("INSERT INTO team_approvals(id,kind,title,amount_cents,ref_id,requested_by,requested_at,needs,status) VALUES (?,'spend',?,?,NULL,?,?,?,'pending')").run(id, title, amount, context.principal.identityId, now(), needs);
      return { ...db.prepare(`SELECT ${APPROVAL_COLS} FROM team_approvals WHERE id=?`).get(id) } as unknown as ApprovalRow;
    }, { action: 'approval.request', subjectId: id }));
  }
  #mayDecide(context: WorkspaceContext, row: ApprovalRow): boolean {
    if (row.requestedBy === context.principal.identityId) return false;
    const admin = teamCan(this.roleOf(context.principal.identityId), 'approval.decide.over') && context.role !== 'viewer';
    return row.needs === 'admin' ? admin : admin || context.role === 'manager';
  }
  decide(context: WorkspaceContext, id: string, input: unknown) {
    this.#staff(context); validId(id);
    exactFields(input, ['approve']);
    if (typeof input.approve !== 'boolean') throw new BusinessAccessError(400);
    const status = input.approve ? 'approved' : 'refused'; const at = now(); const actor = context.principal.identityId;
    return this.#showApproval(this.#workspaces.pages(context, 'read', db => {
      const row = db.prepare(`SELECT ${APPROVAL_COLS} FROM team_approvals WHERE id=?`).get(id) as unknown as ApprovalRow | undefined;
      if (!row) throw new BusinessAccessError(404);
      if (row.status !== 'pending') throw new BusinessAccessError(409, en('This request was already decided.'));
      if (!this.#mayDecide(context, row)) throw new BusinessAccessError(403, row.requestedBy === actor ? en('Someone else must decide your own request.') : row.needs === 'admin' ? en('Spending over the limit needs an administrator.') : en('A manager of this workspace decides this request.'));
      db.prepare('UPDATE team_approvals SET status=?,decided_by=?,decided_at=? WHERE id=?').run(status, actor, at, id);
      if (row.kind === 'reply' && row.refId) db.prepare("UPDATE team_replies SET status=?,decided_by=?,decided_at=? WHERE id=? AND status='pending'").run(status, actor, at, row.refId);
      return { ...db.prepare(`SELECT ${APPROVAL_COLS} FROM team_approvals WHERE id=?`).get(id) } as unknown as ApprovalRow;
    }, { action: 'approval.decide', subjectId: id }));
  }
}
