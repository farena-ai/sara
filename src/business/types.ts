/** Business identities carry no organization or workspace authority implicitly. */
export interface BusinessIdentity {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  authEpoch: number;
  createdAt: string;
}

export interface BusinessPrincipal {
  identityId: string;
  authEpoch: number;
  sessionId: string;
  /** Absolute expiry from the HMAC-verified browser session payload. */
  expiresAt: number;
  credentialKind: 'browser';
}

export const BUSINESS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type OrganizationRole = 'orgadmin' | 'user';
export type WorkspaceRole = 'manager' | 'contributor' | 'viewer';
export type WorkspaceAction = 'read' | 'send' | 'document' | 'manage' | 'audit';
export interface OrganizationMembership { identityId: string; role: OrganizationRole; status: 'active' | 'disabled' | 'removed'; revision: number }
export interface WorkspaceMembership { workspaceId: string; identityId: string; role: WorkspaceRole; status: 'active' | 'removed'; revision: number }
export interface BusinessWorkspace { id: string; name: string; visibility: 'shared'; status: 'active' | 'held'; policyRevision: number; createdBy: string; createdAt: string }

/** Issued by BusinessPolicy; consumers must revalidate after every asynchronous boundary. */
export interface WorkspaceContext {
  readonly principal: Readonly<BusinessPrincipal>;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly authEpoch: number;
  readonly organizationRevision: number;
  readonly workspaceMembershipRevision: number;
  readonly policyRevision: number;
}

/** Fixed metadata only: no invitation secret, title, request body or content. */
export interface BusinessMutation {
  readonly action: 'organization.settings' | 'organization.bootstrap' | 'organization.member' | 'workspace.create' | 'workspace.member' | 'invite.create' | 'invite.revoke' | 'invite.redeem';
  readonly actorId: string;
  readonly workspaceId?: string;
  readonly subjectId?: string;
  readonly revision?: number;
}
