import { recoveryMode } from './recovery.ts';
import type { BusinessControlStore } from './store.ts';
import { BUSINESS_UUID, type BusinessPrincipal, type OrganizationMembership, type WorkspaceAction, type WorkspaceContext } from './types.ts';

export class BusinessAccessError extends Error {
  readonly status: number;
  constructor(status: 400 | 401 | 403 | 404 | 409, message = status === 404 ? 'Not found.' : status === 401 ? 'Sign-in required.' : status === 409 ? 'Change refused.' : 'Request denied.') {
    super(message); this.status = status;
  }
}

/** Reject unexpected authority-bearing fields rather than silently ignoring them. */
export function exactFields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) throw new BusinessAccessError(400);
}
export function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !BUSINESS_UUID.test(value)) throw new BusinessAccessError(404);
}

const permissions: Record<string, readonly string[]> = Object.freeze({
  manager: Object.freeze(['read', 'send', 'document', 'manage', 'audit']),
  contributor: Object.freeze(['read', 'send', 'document']), viewer: Object.freeze(['read']),
});
const actions: readonly string[] = ['read', 'send', 'document', 'manage', 'audit'];

export class BusinessPolicy {
  readonly #store: BusinessControlStore;
  readonly #principalActive: (principal: BusinessPrincipal) => boolean;
  readonly #issued = new WeakSet<object>();
  constructor(store: BusinessControlStore, principalActive: (principal: BusinessPrincipal) => boolean) {
    if (typeof principalActive !== 'function') throw new Error('Live business principal validation is required.');
    this.#store = store; this.#principalActive = principalActive;
  }
  requireIdentity(principal: BusinessPrincipal): void {
    exactFields(principal, ['identityId', 'authEpoch', 'sessionId', 'expiresAt', 'credentialKind']);
    if (typeof principal.identityId !== 'string' || !BUSINESS_UUID.test(principal.identityId) || !Number.isSafeInteger(principal.authEpoch) || principal.authEpoch < 0 || !Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= Date.now() || typeof principal.sessionId !== 'string' || !principal.sessionId || principal.credentialKind !== 'browser') throw new BusinessAccessError(401);
    const identity = this.#store.identities.get(principal.identityId);
    if (!identity || identity.status !== 'active' || identity.authEpoch !== principal.authEpoch || !this.#principalActive(principal)) throw new BusinessAccessError(401);
  }
  requireOrganization(principal: BusinessPrincipal): OrganizationMembership {
    if (recoveryMode(this.#store.database)) throw new BusinessAccessError(403);
    this.requireIdentity(principal);
    const enrollment = this.#store.database.prepare('SELECT epoch FROM business_reenrollment WHERE identity_id=?').get(principal.identityId);
    if (enrollment) {
      const fresh = this.#store.database.prepare('SELECT epoch,registered FROM business_recovery_fresh WHERE identity_id=?').get(principal.identityId);
      if (enrollment.epoch !== principal.authEpoch || fresh?.epoch !== principal.authEpoch || fresh.registered !== 1) throw new BusinessAccessError(403);
    }
    const member = this.#store.organizationMembership(principal.identityId);
    if (!member || member.status !== 'active' || !['orgadmin', 'user'].includes(member.role) || !Number.isSafeInteger(member.revision) || member.revision < 1) throw new BusinessAccessError(403);
    return member;
  }
  requireOrganizationAdmin(principal: BusinessPrincipal): OrganizationMembership {
    const member = this.requireOrganization(principal);
    if (member.role !== 'orgadmin') throw new BusinessAccessError(403);
    return member;
  }
  authorizeWorkspace(principal: BusinessPrincipal, workspaceId: string, action: string): WorkspaceContext {
    try {
      validId(workspaceId);
      if (!actions.includes(action)) throw new BusinessAccessError(404);
      const organization = this.requireOrganization(principal);
      const workspace = this.#store.workspace(workspaceId);
      const membership = this.#store.workspaceMembership(workspaceId, principal.identityId);
      if (!workspace || workspace.visibility !== 'shared' || workspace.status !== 'active' || !membership || membership.status !== 'active' || !Object.hasOwn(permissions, membership.role) || !permissions[membership.role].includes(action) || !Number.isSafeInteger(membership.revision) || membership.revision < 1 || !Number.isSafeInteger(workspace.policyRevision) || workspace.policyRevision < 1) throw new BusinessAccessError(404);
      const context: WorkspaceContext = Object.freeze({ principal: Object.freeze({ ...principal }), workspaceId, role: membership.role, authEpoch: principal.authEpoch, organizationRevision: organization.revision, workspaceMembershipRevision: membership.revision, policyRevision: workspace.policyRevision });
      this.#issued.add(context); return context;
    } catch { throw new BusinessAccessError(404); }
  }
  revalidateWorkspace(context: WorkspaceContext, action: WorkspaceAction | string): void {
    if (!context || !this.#issued.has(context)) throw new BusinessAccessError(404);
    const current = this.authorizeWorkspace(context.principal, context.workspaceId, action);
    if (current.authEpoch !== context.authEpoch || current.organizationRevision !== context.organizationRevision || current.workspaceMembershipRevision !== context.workspaceMembershipRevision || current.policyRevision !== context.policyRevision || current.role !== context.role) throw new BusinessAccessError(404);
  }
}
