// W3.3 team workspace routes (docs/design/W3_TEAM.md). The outer business runtime already checked
// Origin and derived the principal from one live cookie; each handler authorizes its own role.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusinessEvents } from './events.ts';
import { BusinessAccessError } from './policy.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessTeam } from './team.ts';
import type { BusinessPrincipal } from './types.ts';

interface Dependencies {
  control: BusinessControlStore; team: BusinessTeam; events: BusinessEvents;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, status: number, value: unknown) => void;
}
const teamPattern = /^\/api\/business\/team(?:\/(settings|people\/[^/]+))?$/;
const workspacePattern = /^\/api\/business\/workspaces\/([^/]+)\/(inbox(?:\/[^/]+(?:\/(?:assign|reply|done|replies\/[^/]+\/sent))?)?|approvals(?:\/[^/]+\/decide)?|team-people)$/;

export function createBusinessTeamRouter(deps: Dependencies) {
  return { matches: (path: string) => teamPattern.test(path) || workspacePattern.test(path), async handle(req: IncomingMessage, res: ServerResponse, path: string, principal?: BusinessPrincipal): Promise<void> {
    const send = (status: number, value: unknown) => deps.json(res, status, value);
    try {
      if (!principal) throw new BusinessAccessError(401);
      const get = req.method === 'GET';
      if (!get && req.method !== 'POST') throw new BusinessAccessError(404);
      const data = get ? undefined : await deps.body(req);
      const top = teamPattern.exec(path);
      if (top) {
        if (!top[1]) { if (!get) throw new BusinessAccessError(404); return send(200, deps.team.view(principal)); }
        if (get) throw new BusinessAccessError(404);
        if (top[1] === 'settings') return send(200, deps.team.saveSettings(principal, data));
        return send(200, deps.team.setRole(principal, top[1].slice('people/'.length), data));
      }
      const match = workspacePattern.exec(path)!; const workspaceId = match[1]; const tail = match[2].split('/');
      // Each method re-checks the exact workspace action (read, or document for contributors).
      const context = deps.control.policy.authorizeWorkspace(principal, workspaceId, get ? 'read' : tail[0] === 'approvals' && tail[2] === 'decide' ? 'read' : 'document');
      let result: unknown; let status = 200;
      if (tail[0] === 'team-people') { if (!get) throw new BusinessAccessError(404); return send(200, deps.team.assignable(context)); }
      if (tail[0] === 'inbox') {
        const [, id, action, replyId] = tail;
        if (!id) { if (get) result = deps.team.inbox(context); else { result = deps.team.add(context, data); status = 201; } }
        else if (!action && get) result = deps.team.thread(context, id);
        else if (get) throw new BusinessAccessError(404);
        else if (action === 'assign') result = deps.team.assign(context, id, data);
        else if (action === 'reply') { result = deps.team.reply(context, id, data); status = 201; }
        else if (action === 'done') result = deps.team.done(context, id, data);
        else if (action === 'replies' && replyId) result = deps.team.sent(context, id, replyId);
        else throw new BusinessAccessError(404);
      } else if (!tail[1]) { if (get) result = deps.team.approvals(context); else { result = deps.team.request(context, data); status = 201; } }
      else if (!get) result = deps.team.decide(context, tail[1], data);
      else throw new BusinessAccessError(404);
      if (!get) deps.events.publish(workspaceId, { kind: 'content.changed' });
      return send(status, result);
    } catch (error) {
      const status = error instanceof BusinessAccessError ? error.status : 400;
      return send(status, { error: status === 404 ? 'Not found.' : status === 401 ? 'Sign-in required.' : error instanceof BusinessAccessError ? error.message : 'Request denied.' });
    }
  } };
}
