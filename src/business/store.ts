import { recoveryMode } from './recovery.ts';
import { appendAudit } from './audit.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BusinessAuth, BusinessIdentityDirectory, BusinessSession } from './identity.ts';
import { BusinessAccessError, BusinessPolicy, exactFields, validId } from './policy.ts';
import type { BusinessMutation, BusinessPrincipal, BusinessWorkspace, OrganizationMembership, WorkspaceMembership } from './types.ts';

interface InviteRow { id: string; scope: 'organization' | 'workspace'; workspaceId: string | null; role: string; subject: string; expiresAt: number; usedAt: number | null; revokedAt: number | null; issuedBy: string; issuerEpoch: number; issuerOrganizationRevision: number; issuerWorkspaceRevision: number | null }
export interface IssuedBusinessInvite { id: string; code: string; expiresAt: number }
export interface BusinessInvitePreview { scope: 'organization' | 'workspace'; role: string; inviter: string; workspace?: string; subject: 'new' | 'existing'; expiresAt: number }
export interface BusinessInviteMetadata { id: string; scope: 'organization' | 'workspace'; role: string; subject: 'new' | 'existing'; subjectLabel: string | null; inviterLabel: string | null; expiresAt: number; state: 'pending' | 'accepted' | 'revoked' | 'expired' | 'invalidated' }
const inviteColumns = 'id,scope,workspace_id AS workspaceId,role,subject,expires_at AS expiresAt,used_at AS usedAt,revoked_at AS revokedAt,issued_by AS issuedBy,issuer_epoch AS issuerEpoch,issuer_organization_revision AS issuerOrganizationRevision,issuer_workspace_revision AS issuerWorkspaceRevision';
const organizationRoles = ['orgadmin', 'user'];
const workspaceRoles = ['manager', 'contributor', 'viewer'];
const hash = (code: string) => createHash('sha256').update(code).digest('hex');

/** One control database, owned and closed by BusinessIdentityDirectory. */
export class BusinessControlStore {
  readonly identities: BusinessIdentityDirectory;
  readonly database: DatabaseSync;
  readonly policy: BusinessPolicy;
  readonly #onMutation?: (event: BusinessMutation) => void;
  #events: BusinessMutation[] | undefined;
  constructor(identities: BusinessIdentityDirectory, options: { principalActive: (principal: BusinessPrincipal) => boolean; onMutation?: (event: BusinessMutation) => void }) {
    this.identities = identities; this.database = identities.database; this.#onMutation = options.onMutation;
    this.policy = new BusinessPolicy(this, options.principalActive);
    this.database.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS organization_members (
        identity_id TEXT PRIMARY KEY REFERENCES business_identities(id), role TEXT NOT NULL CHECK(role IN ('orgadmin','user')),
        status TEXT NOT NULL CHECK(status IN ('active','disabled','removed')), revision INTEGER NOT NULL CHECK(revision>=1)
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility='shared'),
        status TEXT NOT NULL CHECK(status IN ('active','held')), policy_revision INTEGER NOT NULL CHECK(policy_revision>=1),
        created_by TEXT NOT NULL REFERENCES business_identities(id), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), identity_id TEXT NOT NULL REFERENCES business_identities(id),
        role TEXT NOT NULL CHECK(role IN ('manager','contributor','viewer')), status TEXT NOT NULL CHECK(status IN ('active','removed')),
        revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(workspace_id,identity_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_invites (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('organization','workspace')),
        workspace_id TEXT REFERENCES workspaces(id), role TEXT NOT NULL, subject TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER,
        issued_by TEXT NOT NULL REFERENCES business_identities(id), issuer_epoch INTEGER NOT NULL,
        issuer_organization_revision INTEGER NOT NULL, issuer_workspace_revision INTEGER,
        CHECK((scope='organization' AND workspace_id IS NULL AND role IN ('orgadmin','user') AND issuer_workspace_revision IS NULL)
          OR (scope='workspace' AND workspace_id IS NOT NULL AND role IN ('manager','contributor','viewer') AND issuer_workspace_revision IS NOT NULL))
      );
    `);
    if (!recoveryMode(this.database)) this.bootstrapAdministrator();
  }
  /** Synchronous write lock; all authority checks and invariant checks occur inside it. */
  transaction<T>(operation: () => T): T {
    this.identities.lifecycle.assertAdmission();
    if (this.#events) throw new Error('Nested business control transactions are not supported.');
    this.database.exec('BEGIN IMMEDIATE'); this.#events = [];
    let result: T; let events: BusinessMutation[];
    try {
      result = operation();
      if (result && typeof result === 'object' && 'then' in result) throw new Error('Business control transactions must be synchronous.');
      events = this.#events; this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    finally { this.#events = undefined; }
    for (const event of events) { try { this.#onMutation?.(event); } catch { /* The committed mutation must not be reported as rolled back. */ } }
    return result;
  }
  #event(event: BusinessMutation): void {
    if (!this.#events) throw new Error('Business mutation outside a transaction.');
    appendAudit(this.database, event);
    this.#events.push(Object.freeze(event));
  }
  bootstrapAdministrator(): void {
    if (recoveryMode(this.database)) throw new Error('Administration is closed during recovery.');
    this.transaction(() => {
      if (this.database.prepare("SELECT value FROM business_meta WHERE key='organization_bootstrap_granted'").get()) return;
      const id = this.identities.firstIdentityId(); if (!id) return;
      const identity = this.identities.get(id);
      if (!identity || identity.status !== 'active') throw new Error('Business bootstrap identity is unavailable.');
      this.database.prepare("INSERT INTO organization_members(identity_id,role,status,revision) VALUES (?,'orgadmin','active',1)").run(id);
      this.database.prepare("INSERT INTO business_meta(key,value) VALUES ('organization_bootstrap_granted',?)").run(id);
      this.#event({ action: 'organization.bootstrap', actorId: id, subjectId: id, revision: 1 });
    });
  }
  organizationMembership(identityId: string): OrganizationMembership | undefined {
    const row = this.database.prepare('SELECT identity_id AS identityId,role,status,revision FROM organization_members WHERE identity_id=?').get(identityId);
    return row ? { ...row } as unknown as OrganizationMembership : undefined;
  }
  organizationName(): string | null {
    const row = this.database.prepare("SELECT value FROM business_meta WHERE key='organization_name'").get();
    return row ? String(row.value) : null;
  }
  setOrganizationName(principal: BusinessPrincipal, input: unknown) {
    exactFields(input, ['name']);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f]/.test(input.name)) throw new BusinessAccessError(400);
    const name = input.name.trim();
    return this.transaction(() => {
      this.policy.requireOrganizationAdmin(principal);
      this.database.prepare("INSERT OR REPLACE INTO business_meta(key,value) VALUES ('organization_name',?)").run(name);
      this.#event({ action: 'organization.settings', actorId: principal.identityId });
      return { name };
    });
  }
  workspaceMembership(workspaceId: string, identityId: string): WorkspaceMembership | undefined {
    const row = this.database.prepare('SELECT workspace_id AS workspaceId,identity_id AS identityId,role,status,revision FROM workspace_members WHERE workspace_id=? AND identity_id=?').get(workspaceId, identityId);
    return row ? { ...row } as unknown as WorkspaceMembership : undefined;
  }
  workspace(id: string): BusinessWorkspace | undefined {
    const row = this.database.prepare('SELECT id,name,visibility,status,policy_revision AS policyRevision,created_by AS createdBy,created_at AS createdAt FROM workspaces WHERE id=?').get(id);
    return row ? { ...row } as unknown as BusinessWorkspace : undefined;
  }
  listOrganizationUsers(principal: BusinessPrincipal) {
    this.policy.requireOrganizationAdmin(principal);
    return this.database.prepare('SELECT i.id,i.name,i.status AS identityStatus,m.role,m.status,m.revision FROM organization_members m JOIN business_identities i ON i.id=m.identity_id ORDER BY i.created_at,i.id').all().map(row => ({ ...row }));
  }
  /** Purpose-specific manager pick-list, never the organization administration directory. */
  listInviteCandidates(principal: BusinessPrincipal, workspaceId: string, query = ''): { id: string; name: string }[] {
    const context = this.policy.authorizeWorkspace(principal, workspaceId, 'manage');
    if (typeof query !== 'string' || query.length > 80) throw new BusinessAccessError(400);
    const rows = this.database.prepare(`SELECT i.id,i.name FROM business_identities i JOIN organization_members o ON o.identity_id=i.id
      WHERE i.status='active' AND o.status='active' AND instr(lower(i.name),lower(?))>0
      AND NOT EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=? AND w.identity_id=i.id)
      ORDER BY i.name,i.id LIMIT 50`).all(query.trim(), workspaceId).map(row => ({ id: String(row.id), name: String(row.name) }));
    this.policy.revalidateWorkspace(context, 'manage'); return rows;
  }
  setOrganizationMember(principal: BusinessPrincipal, identityId: string, input: unknown): OrganizationMembership {
    exactFields(input, ['role', 'status']); validId(identityId);
    if ((!Object.hasOwn(input, 'role') && !Object.hasOwn(input, 'status')) || (Object.hasOwn(input, 'role') && (typeof input.role !== 'string' || !organizationRoles.includes(input.role))) || (Object.hasOwn(input, 'status') && (typeof input.status !== 'string' || !['active', 'disabled', 'removed'].includes(input.status)))) throw new BusinessAccessError(400);
    return this.transaction(() => {
      this.policy.requireOrganizationAdmin(principal);
      const member = this.organizationMembership(identityId); const identity = this.identities.get(identityId);
      if (!member || !identity) throw new BusinessAccessError(404);
      const role = input.role === undefined ? member.role : String(input.role);
      const status = input.status === undefined ? member.status : String(input.status);
      if (status === 'active' && (member.status !== 'active' || identity.status !== 'active')) {
        const fresh = this.database.prepare('SELECT epoch,registered FROM business_recovery_fresh WHERE identity_id=?').get(identityId);
        const enrollment = this.database.prepare('SELECT epoch,used_at FROM business_reenrollment WHERE identity_id=?').get(identityId);
        const credential = this.database.prepare('SELECT credential_id FROM business_credential_refs WHERE identity_id=? AND auth_epoch=? LIMIT 1').get(identityId, identity.authEpoch);
        if (identity.status !== 'active' || fresh?.epoch !== identity.authEpoch || fresh.registered !== 1 || !credential || enrollment && (enrollment.epoch !== identity.authEpoch || enrollment.used_at === null)) throw new BusinessAccessError(409, 'Access re-enrollment requires fresh authentication.');
        // Organization reapproval is not content reapproval. Preserve prior rows but close
        // every retained grant before enabling the organization; managers must grant again.
        const retained = this.database.prepare("SELECT workspace_id,revision FROM workspace_members WHERE identity_id=? AND status='active'").all(identityId);
        for (const grant of retained) {
          this.database.prepare("UPDATE workspace_members SET status='removed',revision=revision+1 WHERE workspace_id=? AND identity_id=?").run(grant.workspace_id, identityId);
          this.#event({ action: 'workspace.member', actorId: principal.identityId, workspaceId: String(grant.workspace_id), subjectId: identityId, revision: Number(grant.revision) + 1 });
        }
      }
      // Explicit suspension always wins; ordinary demotion/removal retains an active administrator.
      if (member.role === 'orgadmin' && member.status === 'active' && (role !== 'orgadmin' || status === 'removed') && !this.database.prepare("SELECT m.identity_id FROM organization_members m JOIN business_identities i ON i.id=m.identity_id WHERE m.role='orgadmin' AND m.status='active' AND i.status='active' AND m.identity_id<>? LIMIT 1").get(identityId)) throw new BusinessAccessError(409, 'An organization needs another active administrator.');
      if (status !== 'active') this.database.prepare("UPDATE business_identities SET status='disabled',auth_epoch=auth_epoch+1 WHERE id=?").run(identityId);
      this.database.prepare('UPDATE organization_members SET role=?,status=?,revision=revision+1 WHERE identity_id=?').run(role, status, identityId);
      const updated = this.organizationMembership(identityId)!;
      this.#event({ action: 'organization.member', actorId: principal.identityId, subjectId: identityId, revision: updated.revision }); return updated;
    });
  }
  /** EC2 just-in-time account: identity, organization membership and the caller's link/session in one transaction. */
  ssoCreateMember(name: string, role: 'orgadmin' | 'user', finish: (identity: import('./types.ts').BusinessIdentity) => BusinessSession): BusinessSession {
    if (!organizationRoles.includes(role)) throw new BusinessAccessError(400);
    return this.transaction(() => {
      const identity = this.identities.create(name);
      this.database.prepare("INSERT INTO organization_members(identity_id,role,status,revision) VALUES (?,?,'active',1)").run(identity.id, role);
      this.#event({ action: 'organization.member', actorId: identity.id, subjectId: identity.id, revision: 1 });
      return finish(identity);
    });
  }
  /** EC2 group mapping. Never changes the break-glass owner and never removes the last active administrator. */
  ssoSyncRole(identityId: string, role: 'orgadmin' | 'user'): boolean {
    validId(identityId);
    return this.transaction(() => {
      const member = this.organizationMembership(identityId);
      if (!member || member.status !== 'active' || member.role === role || identityId === this.identities.firstIdentityId()) return false;
      if (member.role === 'orgadmin' && !this.database.prepare("SELECT m.identity_id FROM organization_members m JOIN business_identities i ON i.id=m.identity_id WHERE m.role='orgadmin' AND m.status='active' AND i.status='active' AND m.identity_id<>? LIMIT 1").get(identityId)) return false;
      this.database.prepare('UPDATE organization_members SET role=?,revision=revision+1 WHERE identity_id=?').run(role, identityId);
      const updated = this.organizationMembership(identityId)!;
      this.#event({ action: 'organization.member', actorId: identityId, subjectId: identityId, revision: updated.revision });
      return true;
    });
  }
  createWorkspace(principal: BusinessPrincipal, input: unknown): BusinessWorkspace {
    exactFields(input, ['name', 'visibility']);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || (input.visibility !== undefined && input.visibility !== 'shared')) throw new BusinessAccessError(400);
    const name = input.name.trim();
    return this.transaction(() => {
      this.policy.requireOrganizationAdmin(principal);
      const id = randomUUID(); const at = new Date().toISOString();
      this.database.prepare("INSERT INTO workspaces(id,name,visibility,status,policy_revision,created_by,created_at) VALUES (?,?,'shared','active',1,?,?)").run(id, name, principal.identityId, at);
      this.database.prepare("INSERT INTO workspace_members(workspace_id,identity_id,role,status,revision) VALUES (?,?,'manager','active',1)").run(id, principal.identityId);
      this.#event({ action: 'workspace.create', actorId: principal.identityId, workspaceId: id, revision: 1 }); return this.workspace(id)!;
    });
  }
  listWorkspaces(principal: BusinessPrincipal): BusinessWorkspace[] {
    this.policy.requireOrganization(principal);
    const rows = this.database.prepare("SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id WHERE m.identity_id=? AND m.status='active' AND w.status='active' ORDER BY w.created_at,w.id").all(principal.identityId);
    return rows.map(row => { this.policy.authorizeWorkspace(principal, String(row.id), 'read'); return this.workspace(String(row.id))!; });
  }
  listWorkspaceMembers(principal: BusinessPrincipal, workspaceId: string): WorkspaceMembership[] {
    this.policy.authorizeWorkspace(principal, workspaceId, 'manage');
    return this.database.prepare('SELECT workspace_id AS workspaceId,identity_id AS identityId,role,status,revision FROM workspace_members WHERE workspace_id=? ORDER BY identity_id').all(workspaceId).map(row => ({ ...row } as unknown as WorkspaceMembership));
  }
  #activeSubject(identityId: string): void {
    const identity = this.identities.get(identityId); const member = this.organizationMembership(identityId);
    if (!identity || identity.status !== 'active' || !member || member.status !== 'active' || !organizationRoles.includes(member.role)) throw new BusinessAccessError(404);
  }
  #grantWorkspace(workspaceId: string, identityId: string, role: string, status: string): WorkspaceMembership {
    const previous = this.workspaceMembership(workspaceId, identityId);
    if (previous?.role === 'manager' && previous.status === 'active' && (role !== 'manager' || status !== 'active')) {
      const replacement = this.database.prepare("SELECT m.identity_id FROM workspace_members m JOIN organization_members o ON o.identity_id=m.identity_id JOIN business_identities i ON i.id=m.identity_id WHERE m.workspace_id=? AND m.role='manager' AND m.status='active' AND o.status='active' AND o.role IN ('orgadmin','user') AND i.status='active' AND m.identity_id<>? LIMIT 1").get(workspaceId, identityId);
      if (!replacement) throw new BusinessAccessError(409, 'A workspace needs an active manager.');
    }
    this.database.prepare('INSERT INTO workspace_members(workspace_id,identity_id,role,status,revision) VALUES (?,?,?,?,1) ON CONFLICT(workspace_id,identity_id) DO UPDATE SET role=excluded.role,status=excluded.status,revision=workspace_members.revision+1').run(workspaceId, identityId, role, status);
    return this.workspaceMembership(workspaceId, identityId)!;
  }
  setWorkspaceMember(principal: BusinessPrincipal, workspaceId: string, identityId: string, input: unknown): WorkspaceMembership {
    exactFields(input, ['role', 'status']); validId(identityId);
    if (typeof input.role !== 'string' || !workspaceRoles.includes(input.role) || typeof input.status !== 'string' || !['active', 'removed'].includes(input.status)) throw new BusinessAccessError(400);
    const role = input.role; const status = String(input.status);
    return this.transaction(() => {
      this.policy.authorizeWorkspace(principal, workspaceId, 'manage');
      this.#activeSubject(identityId);
      const updated = this.#grantWorkspace(workspaceId, identityId, role, status);
      this.#event({ action: 'workspace.member', actorId: principal.identityId, workspaceId, subjectId: identityId, revision: updated.revision }); return updated;
    });
  }
  createInvite(principal: BusinessPrincipal, input: unknown): IssuedBusinessInvite {
    exactFields(input, ['scope', 'workspaceId', 'role', 'subject', 'expiresInSeconds']);
    if (typeof input.scope !== 'string' || !['organization', 'workspace'].includes(input.scope) || typeof input.role !== 'string' || !(input.scope === 'organization' ? organizationRoles : workspaceRoles).includes(input.role) || typeof input.subject !== 'string') throw new BusinessAccessError(400);
    if (input.scope === 'workspace' && input.subject === 'new') throw new BusinessAccessError(400);
    if (input.subject !== 'new') validId(input.subject);
    if (input.scope === 'workspace') validId(input.workspaceId); else if (input.workspaceId !== undefined) throw new BusinessAccessError(400);
    const seconds = Object.hasOwn(input, 'expiresInSeconds') ? input.expiresInSeconds : 86_400;
    if (!Number.isSafeInteger(seconds) || Number(seconds) < 60 || Number(seconds) > 604_800) throw new BusinessAccessError(400);
    return this.transaction(() => {
      const organization = this.policy.requireOrganization(principal);
      const context = input.scope === 'workspace' ? this.policy.authorizeWorkspace(principal, String(input.workspaceId), 'manage') : undefined;
      if (!context) this.policy.requireOrganizationAdmin(principal);
      if (input.subject !== 'new') {
        const subject = this.identities.get(String(input.subject));
        if (!subject || subject.status !== 'active') throw new BusinessAccessError(404);
        if (context) this.#activeSubject(subject.id);
        else if (this.organizationMembership(subject.id)) throw new BusinessAccessError(409);
      }
      const id = randomUUID(); const code = `${id}.${randomBytes(32).toString('base64url')}`; const expiresAt = Date.now() + Number(seconds) * 1000;
      this.database.prepare('INSERT INTO workspace_invites(id,scope,workspace_id,role,subject,secret_hash,expires_at,issued_by,issuer_epoch,issuer_organization_revision,issuer_workspace_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, String(input.scope), context?.workspaceId ?? null, String(input.role), String(input.subject), hash(code), expiresAt, principal.identityId, principal.authEpoch, organization.revision, context?.workspaceMembershipRevision ?? null);
      this.#event({ action: 'invite.create', actorId: principal.identityId, ...(context ? { workspaceId: context.workspaceId } : {}) }); return { id, code, expiresAt };
    });
  }
  /** Shared, read-only eligibility for inventory, public preview and transactional redemption. */
  #eligibleInvite(row: InviteRow, now: number): boolean {
    if (row.usedAt !== null || row.revokedAt !== null || row.expiresAt <= now) return false;
    const issuer = this.identities.get(row.issuedBy); const organization = this.organizationMembership(row.issuedBy);
    if (!issuer || issuer.status !== 'active' || issuer.authEpoch !== row.issuerEpoch || !organization || organization.status !== 'active' || !organizationRoles.includes(organization.role) || organization.revision !== row.issuerOrganizationRevision) return false;
    if (row.scope === 'organization') { if (organization.role !== 'orgadmin' || !organizationRoles.includes(row.role) || row.workspaceId !== null) return false; }
    else if (row.scope === 'workspace') {
      const member = this.workspaceMembership(row.workspaceId!, row.issuedBy); const workspace = this.workspace(row.workspaceId!);
      if (!workspace || workspace.status !== 'active' || workspace.visibility !== 'shared' || !workspaceRoles.includes(row.role) || !member || member.status !== 'active' || member.role !== 'manager' || member.revision !== row.issuerWorkspaceRevision || row.subject === 'new') return false;
    } else return false;
    if (row.subject !== 'new') {
      const subject = this.identities.get(row.subject); const membership = this.organizationMembership(row.subject);
      if (!subject || subject.status !== 'active' || (membership && (membership.status !== 'active' || !organizationRoles.includes(membership.role))) || (row.scope === 'workspace' && (!membership || this.workspaceMembership(row.workspaceId!, row.subject))) || (row.scope === 'organization' && membership)) return false;
    }
    return true;
  }
  #invite(code: unknown): InviteRow {
    if (typeof code !== 'string' || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(code)) throw new BusinessAccessError(404);
    const row = this.database.prepare(`SELECT ${inviteColumns} FROM workspace_invites WHERE secret_hash=?`).get(hash(code)) as unknown as InviteRow | undefined;
    if (!row || !this.#eligibleInvite(row, Date.now())) throw new BusinessAccessError(404);
    return row;
  }
  listInvites(principal: BusinessPrincipal, workspaceId?: string): BusinessInviteMetadata[] {
    const names = new Map<string, string>();
    if (workspaceId === undefined) {
      this.policy.requireOrganizationAdmin(principal);
      for (const row of this.listOrganizationUsers(principal)) names.set(String(row.id), String(row.name));
    } else {
      this.policy.authorizeWorkspace(principal, workspaceId, 'manage');
      for (const row of this.listWorkspaceMembers(principal, workspaceId)) {
        const identity = this.identities.get(row.identityId); if (identity) names.set(identity.id, identity.name);
      }
      for (const row of this.listInviteCandidates(principal, workspaceId)) names.set(row.id, row.name);
    }
    // Insertion order is independent of random IDs and mutable expiration times. Scope precedes LIMIT.
    const rows = (workspaceId === undefined
      ? this.database.prepare(`SELECT ${inviteColumns} FROM workspace_invites WHERE scope='organization' ORDER BY rowid DESC LIMIT 100`).all()
      : this.database.prepare(`SELECT ${inviteColumns} FROM workspace_invites WHERE scope='workspace' AND workspace_id=? ORDER BY rowid DESC LIMIT 100`).all(workspaceId)) as unknown as InviteRow[];
    const now = Date.now();
    return rows.map(row => ({ id: row.id, scope: row.scope, role: row.role, subject: row.subject === 'new' ? 'new' : 'existing', subjectLabel: row.subject === 'new' ? null : names.get(row.subject) ?? null, inviterLabel: names.get(row.issuedBy) ?? null, expiresAt: row.expiresAt,
      state: row.usedAt !== null ? 'accepted' : row.revokedAt !== null ? 'revoked' : row.expiresAt <= now ? 'expired' : this.#eligibleInvite(row, now) ? 'pending' : 'invalidated' }));
  }
  previewInvite(code: unknown): BusinessInvitePreview {
    const invite = this.#invite(code);
    return { scope: invite.scope, role: invite.role, inviter: this.identities.get(invite.issuedBy)!.name, ...(invite.workspaceId ? { workspace: this.workspace(invite.workspaceId)!.name } : {}), subject: invite.subject === 'new' ? 'new' : 'existing', expiresAt: invite.expiresAt };
  }
  revokeInvite(principal: BusinessPrincipal, id: string): void {
    validId(id);
    this.transaction(() => {
      const invite = this.database.prepare('SELECT scope,workspace_id AS workspaceId FROM workspace_invites WHERE id=?').get(id);
      if (!invite) throw new BusinessAccessError(404);
      if (invite.scope === 'organization') this.policy.requireOrganizationAdmin(principal);
      else this.policy.authorizeWorkspace(principal, String(invite.workspaceId), 'manage');
      this.database.prepare('UPDATE workspace_invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(Date.now(), id);
      this.#event({ action: 'invite.revoke', actorId: principal.identityId, ...(invite.workspaceId ? { workspaceId: String(invite.workspaceId) } : {}) });
    });
  }
  redeemInvite(code: unknown, input: { principal?: BusinessPrincipal; name?: string; confirm18?: boolean }, auth?: Pick<BusinessAuth, 'createIdentity'>): { principal: BusinessPrincipal; session?: BusinessSession; workspaceId?: string } {
    exactFields(input, ['principal', 'name', 'confirm18']);
    return this.transaction(() => {
      const invite = this.#invite(code);
      let principal: BusinessPrincipal; let session: BusinessSession | undefined;
      if (input.principal) {
        if (input.name !== undefined || input.confirm18 !== undefined) throw new BusinessAccessError(400);
        this.policy.requireIdentity(input.principal); principal = input.principal;
        if (invite.subject !== principal.identityId) throw new BusinessAccessError(404);
      } else {
        if (invite.subject !== 'new' || invite.scope !== 'organization') throw new BusinessAccessError(404);
        if (!auth || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || input.confirm18 !== true) throw new BusinessAccessError(400, 'Adult confirmation (18+) is required.');
        session = auth.createIdentity(input.name, true); principal = session.principal;
      }
      const member = this.organizationMembership(principal.identityId);
      if (member && member.status !== 'active') throw new BusinessAccessError(404);
      if (invite.scope === 'organization') {
        if (member) throw new BusinessAccessError(404);
        this.database.prepare("INSERT INTO organization_members(identity_id,role,status,revision) VALUES (?,?,'active',1)").run(principal.identityId, invite.role);
      } else {
        if (!member) throw new BusinessAccessError(404);
        // An invite cannot overwrite a later grant/removal or act as a role-change shortcut.
        if (this.workspaceMembership(invite.workspaceId!, principal.identityId)) throw new BusinessAccessError(404);
        this.#grantWorkspace(invite.workspaceId!, principal.identityId, invite.role, 'active');
      }
      const claimed = this.database.prepare('UPDATE workspace_invites SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').run(Date.now(), invite.id);
      if (claimed.changes !== 1) throw new BusinessAccessError(404);
      this.#event({ action: 'invite.redeem', actorId: principal.identityId, ...(invite.workspaceId ? { workspaceId: invite.workspaceId } : {}), subjectId: principal.identityId });
      return { principal, ...(session ? { session } : {}), ...(invite.workspaceId ? { workspaceId: invite.workspaceId } : {}) };
    });
  }
}
