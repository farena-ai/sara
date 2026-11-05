import type { BusinessAudit } from './audit.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusinessControlStore } from './store.ts';
import type { BusinessWorkspaces } from './workspaces.ts';
import type { BusinessRetrieval } from './retrieval.ts';
import type { BusinessEvents } from './events.ts';
import { BusinessEventLimitError } from './events.ts';
import type { BusinessPrincipal } from './types.ts';
import { BusinessAccessError, validId } from './policy.ts';

interface Dependencies { audit: BusinessAudit; control: BusinessControlStore; workspaces: BusinessWorkspaces; retrieval: BusinessRetrieval; events: BusinessEvents; json: (response: ServerResponse, status: number, value: unknown) => void }
const pattern = /^\/api\/business\/workspaces\/([^/]+)\/(conversations(?:\/[^/]+(?:\/(?:messages|recent-messages|requests\/[^/]+))?)?|messages\/[^/]+|documents(?:\/[^/]+)?|search|memories|citations\/[^/]+|uploads\/[^/]+|notifications|audience|invite-candidates|audit|events)$/;

/** This router exposes reads only. The outer runtime derives the principal from one live cookie. */
export function createBusinessContentRouter(deps: Dependencies) {
  return { matches: (path: string) => pattern.test(path), async handle(req: IncomingMessage, res: ServerResponse, path: string, principal?: BusinessPrincipal): Promise<void> {
    try {
      if (req.method !== 'GET') throw new BusinessAccessError(404);
      if (!principal) throw new BusinessAccessError(401);
      const match = pattern.exec(path)!; const workspaceId = match[1]; const tail = match[2];
      const context = deps.control.policy.authorizeWorkspace(principal, workspaceId, tail === 'invite-candidates' ? 'manage' : tail === 'audit' ? 'audit' : 'read');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (tail === 'events') { deps.events.subscribe(context, res); return; }
      let result: unknown;
      if (tail === 'audit') result = deps.audit.workspace(context);
      else if (tail === 'audience') result = deps.workspaces.audience(context);
      else if (tail === 'invite-candidates') result = deps.control.listInviteCandidates(principal, workspaceId, url.searchParams.get('q') ?? '');
      else result = await deps.retrieval.retrieve(context, async scope => {
        if (/^conversations\/[^/]+\/requests\/[^/]+$/.test(tail)) {
          const [, conversationId, , requestId] = tail.split('/'); validId(requestId);
          await scope.conversation(conversationId);
          deps.control.policy.revalidateWorkspace(context, 'read');
          const row = deps.control.database.prepare('SELECT actor_id,workspace_id,conversation_id,state FROM business_model_requests WHERE request_id=?').get(requestId);
          if (!row) return { requestId, state: 'not-admitted' };
          if (row.actor_id !== principal.identityId || row.workspace_id !== workspaceId || row.conversation_id !== conversationId) throw new BusinessAccessError(404);
          return { requestId, state: String(row.state) };
        }
        if (tail === 'conversations') return scope.conversations();
        if (/^conversations\/[^/]+\/recent-messages$/.test(tail)) return scope.recentHistory(tail.split('/')[1]);
        if (/^conversations\/[^/]+\/messages$/.test(tail)) return scope.messages(tail.split('/')[1]);
        if (tail.startsWith('conversations/')) return scope.conversation(tail.split('/')[1]);
        if (tail.startsWith('messages/')) return scope.message(tail.split('/')[1]);
        if (tail === 'documents') return scope.documents();
        if (tail.startsWith('documents/')) return scope.document(tail.split('/')[1]);
        if (tail === 'search') return scope.search(url.searchParams.get('q') ?? '');
        if (tail === 'memories') return scope.memories();
        if (tail.startsWith('citations/')) return scope.citation(tail.split('/')[1]);
        if (tail.startsWith('uploads/')) return scope.upload(tail.split('/')[1]);
        if (tail === 'notifications') return scope.notifications();
        throw new BusinessAccessError(404);
      });
      // The route owns the final asynchronous boundary and checks immediately before serialization.
      deps.control.policy.revalidateWorkspace(context, tail === 'invite-candidates' ? 'manage' : tail === 'audit' ? 'audit' : 'read');
      deps.json(res, 200, result);
    } catch (error) {
      const status = error instanceof BusinessEventLimitError ? 429 : error instanceof BusinessAccessError ? error.status : 404;
      deps.json(res, status, { error: status === 404 ? 'Not found.' : status === 401 ? 'Sign-in required.' : status === 429 ? 'Too many requests.' : 'Request denied.' });
    }
  } };
}
