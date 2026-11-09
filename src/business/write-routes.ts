import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BusinessPrincipal } from './types.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessChat } from './chat.ts';
import { BusinessDisclosureRequired } from './chat.ts';
import type { BusinessDocuments } from './documents.ts';
import type { BusinessModels } from './model-config.ts';
import type { BusinessEvents } from './events.ts';
import { BusinessAccessError } from './policy.ts';
import { BusinessAdmissionError } from './budget.ts';

interface Dependencies {
  control: BusinessControlStore; chat: BusinessChat; documents: BusinessDocuments; models: BusinessModels; events: BusinessEvents;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, status: number, value: unknown) => void;
}
const pattern = /^\/api\/business\/workspaces\/([^/]+)\/(conversations|conversations\/([^/]+)\/messages|documents|uploads|model-policy)$/;
// These fixed errors are raised only before reserve succeeds; held and payload-binding errors are excluded.
const notAdmitted = new Set([
  'Budget allowance exhausted.', 'Business model configuration is unavailable or disallowed.', 'Business model policy changed.',
  'Acknowledge the selected model destination before sending.', 'Another model request is in progress.',
  'Conversation context exceeds the configured input bound. Start a new shared conversation or select fewer documents.',
]);

/** Every POST derives authority before reading a body, constructing prompts or reserving spend. */
export function createBusinessWriteRouter(deps: Dependencies) {
  return { matches: (path: string) => pattern.test(path), async handle(req: IncomingMessage, res: ServerResponse, path: string, principal?: BusinessPrincipal): Promise<void> {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', disconnect); req.once('aborted', disconnect);
    try {
      if (!principal) throw new BusinessAccessError(401);
      const match = pattern.exec(path)!; const workspaceId = match[1]; const tail = match[2];
      if (tail === 'model-policy' ? req.method !== 'GET' : req.method !== 'POST') throw new BusinessAccessError(404);
      const action = tail === 'model-policy' ? 'read' : tail === 'documents' || tail === 'uploads' ? 'document' : 'send';
      const context = deps.control.policy.authorizeWorkspace(principal, workspaceId, action);
      const guard = () => { deps.control.policy.revalidateWorkspace(context, action); if (abort.signal.aborted || res.destroyed) throw new BusinessAccessError(404); };
      if (tail === 'model-policy') { const result = deps.models.describe(workspaceId); guard(); deps.json(res, 200, result); return; }
      const data = await deps.body(req); guard();
      let result: unknown; let status = 201;
      if (tail === 'conversations') result = deps.chat.createConversation(context, data, guard);
      else if (tail === 'documents') result = await deps.documents.create(context, data, guard);
      else if (tail === 'uploads') result = await deps.documents.upload(context, data, guard);
      else { result = await deps.chat.send(context, match[3], data, { signal: abort.signal, guard }); status = 200; }
      guard();
      deps.events.publish(workspaceId, { kind: 'content.changed' });
      guard(); deps.json(res, status, result);
    } catch (error) {
      if (res.destroyed || abort.signal.aborted) return;
      if (error instanceof BusinessDisclosureRequired) { deps.json(res, error.status, { ...error.response, admission: 'not-admitted' }); return; }
      const status = error instanceof BusinessAccessError || error instanceof BusinessAdmissionError ? error.status : 400;
      deps.json(res, status, { error: status === 404 ? 'Not found.' : status === 401 ? 'Sign-in required.' : error instanceof BusinessAdmissionError ? error.message : 'Request denied.', ...(error instanceof BusinessAdmissionError && notAdmitted.has(error.message) ? { admission: 'not-admitted' } : {}) });
    } finally { res.off('close', disconnect); req.off('aborted', disconnect); }
  } };
}
