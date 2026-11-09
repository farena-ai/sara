import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoginLimiter } from '../auth.ts';
import type { BusinessAuth, BusinessSession } from './identity.ts';
import { BusinessAccessError, exactFields } from './policy.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessPrincipal } from './types.ts';

interface BusinessRouteDependencies {
  store: BusinessControlStore;
  auth: BusinessAuth;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, status: number, value: unknown) => void;
  cookie: (response: ServerResponse, session?: BusinessSession) => void;
  clientIp: (request: IncomingMessage) => string;
}

/** Cookie authentication and Origin checks belong to the outer business runtime. */
export function createBusinessManagementRouter(deps: BusinessRouteDependencies) {
  const invitations = new LoginLimiter(30);
  const issuance = new LoginLimiter(100);
  const matches = (path: string) => path === '/api/business/org' || path === '/api/business/org/users' || /^\/api\/business\/org\/users\/[^/]+$/.test(path) || path === '/api/business/org/invites' || path === '/api/business/workspaces' || /^\/api\/business\/workspaces\/[^/]+(?:\/members(?:\/[^/]+)?|\/invites)?$/.test(path) || path === '/api/business/invites/preview' || path === '/api/business/invites/join' || /^\/api\/business\/invites\/[^/]+\/revoke$/.test(path);
  return { matches, async handle(req: IncomingMessage, res: ServerResponse, path: string, principal?: BusinessPrincipal): Promise<void> {
    const send = (status: number, value: unknown) => deps.json(res, status, value);
    try {
      const invitation = path === '/api/business/invites/preview' || path === '/api/business/invites/join';
      if (!invitation && !principal) throw new BusinessAccessError(401);
      if (req.method === 'GET') {
        if (path === '/api/business/org/invites') return send(200, deps.store.listInvites(principal!));
        const workspaceInvites = /^\/api\/business\/workspaces\/([^/]+)\/invites$/.exec(path);
        if (workspaceInvites) return send(200, deps.store.listInvites(principal!, workspaceInvites[1]));
        if (path === '/api/business/org/users') return send(200, deps.store.listOrganizationUsers(principal!));
        if (path === '/api/business/workspaces') return send(200, deps.store.listWorkspaces(principal!).map(workspace => ({ ...workspace, role: deps.store.workspaceMembership(workspace.id, principal!.identityId)!.role })));
        const workspace = /^\/api\/business\/workspaces\/([^/]+)(\/members)?$/.exec(path);
        if (workspace) {
          if (workspace[2]) return send(200, deps.store.listWorkspaceMembers(principal!, workspace[1]).map(member => ({ ...member, name: deps.store.identities.get(member.identityId)!.name })));
          deps.store.policy.authorizeWorkspace(principal!, workspace[1], 'read');
          return send(200, deps.store.workspace(workspace[1]));
        }
        throw new BusinessAccessError(404);
      }
      if (req.method !== 'POST') throw new BusinessAccessError(404);
      const data = await deps.body(req);
      if (invitation) {
        const ip = deps.clientIp(req);
        if (invitations.blocked(ip)) return send(429, { error: 'Too many requests.' });
        invitations.fail(ip);
        if (path.endsWith('/preview')) { exactFields(data, ['code']); return send(200, deps.store.previewInvite(data.code)); }
        exactFields(data, ['code', 'name', 'confirm18']);
        const result = deps.store.redeemInvite(data.code, principal ? { principal, ...(data.name !== undefined ? { name: data.name as string } : {}), ...(data.confirm18 !== undefined ? { confirm18: data.confirm18 as boolean } : {}) } : { name: data.name as string, confirm18: data.confirm18 as boolean }, deps.auth);
        if (result.session) deps.cookie(res, result.session);
        return send(result.session ? 201 : 200, { principal: result.principal, ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}) });
      }
      if (path === '/api/business/org') return send(200, deps.store.setOrganizationName(principal!, data));
      if (path === '/api/business/workspaces') return send(201, deps.store.createWorkspace(principal!, data));
      const organizationMember = /^\/api\/business\/org\/users\/([^/]+)$/.exec(path);
      if (organizationMember) return send(200, deps.store.setOrganizationMember(principal!, organizationMember[1], data));
      const workspaceMember = /^\/api\/business\/workspaces\/([^/]+)\/members\/([^/]+)$/.exec(path);
      if (workspaceMember) return send(200, deps.store.setWorkspaceMember(principal!, workspaceMember[1], workspaceMember[2], data));
      const workspaceInvite = /^\/api\/business\/workspaces\/([^/]+)\/invites$/.exec(path);
      if (path === '/api/business/org/invites' || workspaceInvite) {
        if (issuance.blocked(principal!.identityId)) return send(429, { error: 'Too many requests.' });
        issuance.fail(principal!.identityId);
        exactFields(data, ['role', 'subject', 'expiresInSeconds']);
        return send(201, deps.store.createInvite(principal!, { ...data, scope: workspaceInvite ? 'workspace' : 'organization', ...(workspaceInvite ? { workspaceId: workspaceInvite[1] } : {}) }));
      }
      const revoke = /^\/api\/business\/invites\/([^/]+)\/revoke$/.exec(path);
      if (revoke) { exactFields(data, []); deps.store.revokeInvite(principal!, revoke[1]); return send(200, { ok: true }); }
      throw new BusinessAccessError(404);
    } catch (error) {
      if (error instanceof BusinessAccessError) return send(error.status, { error: error.message });
      return send(400, { error: 'Request denied.' });
    }
  } };
}
