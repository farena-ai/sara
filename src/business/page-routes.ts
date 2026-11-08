// C16 (docs/ops/C16_DESIGN.md): HTTP routes for team pages. The outer business runtime has already
// checked Origin and derived the principal from one live cookie; every route authorizes its own role.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { markdownToPdf } from '../doc-write.ts';
import type { BusinessEvents } from './events.ts';
import type { BusinessPages } from './pages.ts';
import { BusinessAccessError, exactFields } from './policy.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessPrincipal } from './types.ts';

interface Dependencies {
  control: BusinessControlStore; pages: BusinessPages; events: BusinessEvents;
  body: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, status: number, value: unknown) => void;
}
const workspacePattern = /^\/api\/business\/workspaces\/([^/]+)\/(pages(?:\/[^/]+(?:\/(?:delete|history|export|comments(?:\/[^/]+\/resolve)?))?)?|page-mentions(?:\/read)?|hold)$/;
const personPattern = /^\/api\/business\/org\/users\/([^/]+)\/(pages-export|pages-delete)$/;

/** An ASCII file name (the UTF-8 one goes in filename*). */
function disposition(title: string, extension: string): string {
  const safe = title.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 80).trim() || 'page';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}.${extension}"; filename*=UTF-8''${encodeURIComponent(safe)}.${extension}`;
}
function file(res: ServerResponse, type: string, name: string, bytes: Buffer | string): void {
  res.writeHead(200, { 'content-type': type, 'content-disposition': name, 'cache-control': 'no-store' });
  res.end(bytes);
}

export function createBusinessPagesRouter(deps: Dependencies) {
  return { matches: (path: string) => workspacePattern.test(path) || personPattern.test(path), async handle(req: IncomingMessage, res: ServerResponse, path: string, principal?: BusinessPrincipal): Promise<void> {
    const send = (status: number, value: unknown) => deps.json(res, status, value);
    try {
      if (!principal) throw new BusinessAccessError(401);
      const get = req.method === 'GET';
      if (!get && req.method !== 'POST') throw new BusinessAccessError(404);
      const data = get ? undefined : await deps.body(req);
      const person = personPattern.exec(path);
      if (person) {
        if (person[2] === 'pages-export') {
          if (!get) throw new BusinessAccessError(404);
          const value = deps.pages.exportPerson(principal, person[1]);
          return file(res, 'application/json; charset=utf-8', disposition(`pages-${value.person.name}`, 'json'), JSON.stringify(value, null, 2));
        }
        if (get) throw new BusinessAccessError(404);
        return send(200, deps.pages.deletePerson(principal, person[1], data));
      }
      const match = workspacePattern.exec(path)!; const workspaceId = match[1]; const tail = match[2].split('/');
      if (tail[0] === 'hold') return send(200, { held: get ? deps.pages.held(principal, workspaceId) : deps.pages.setHold(principal, workspaceId, data) });
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (tail[0] === 'page-mentions') {
        const context = deps.control.policy.authorizeWorkspace(principal, workspaceId, 'read');
        if (tail[1] === 'read' && !get) { exactFields(data, []); deps.pages.markMentionsRead(context); return send(200, { ok: true }); }
        if (tail.length === 1 && get) return send(200, deps.pages.mentions(context));
        throw new BusinessAccessError(404);
      }
      const [, pageId, action, commentId] = tail;
      // Viewers read and comment; contributors create and edit; managers delete. Each method re-checks.
      const needs = !get && (!pageId || (!action)) ? 'document' : !get && action === 'delete' ? 'manage' : 'read';
      const context = deps.control.policy.authorizeWorkspace(principal, workspaceId, needs);
      let result: unknown; let status = 200; let changed = !get;
      if (!pageId) { if (get) result = deps.pages.list(context, url.searchParams.get('q') ?? ''); else { result = deps.pages.create(context, data); status = 201; } }
      else if (!action) result = get ? deps.pages.get(context, pageId) : deps.pages.edit(context, pageId, data);
      else if (action === 'history' && get) result = deps.pages.history(context, pageId);
      else if (action === 'delete' && !get) { exactFields(data, []); deps.pages.delete(context, pageId); result = { ok: true }; }
      else if (action === 'comments' && !commentId) { if (get) result = deps.pages.comments(context, pageId); else { result = deps.pages.comment(context, pageId, data); status = 201; } }
      else if (action === 'comments' && commentId && !get) { deps.pages.resolve(context, pageId, commentId, data); result = { ok: true }; }
      else if (action === 'export' && get) {
        const format = url.searchParams.get('format') ?? 'md';
        if (format !== 'md' && format !== 'pdf') throw new BusinessAccessError(400);
        const page = deps.pages.markdown(context, pageId);
        deps.control.policy.revalidateWorkspace(context, 'read');
        return format === 'md' ? file(res, 'text/markdown; charset=utf-8', disposition(page.title, 'md'), page.markdown) : file(res, 'application/pdf', disposition(page.title, 'pdf'), markdownToPdf(page.markdown, page.title));
      } else { changed = false; throw new BusinessAccessError(404); }
      if (changed) deps.events.publish(workspaceId, { kind: 'content.changed' });
      return send(status, result);
    } catch (error) {
      const status = error instanceof BusinessAccessError ? error.status : 400;
      return send(status, { error: status === 404 ? 'Not found.' : status === 401 ? 'Sign-in required.' : error instanceof BusinessAccessError ? error.message : 'Request denied.' });
    }
  } };
}
