// EC14 (docs/ops/EC14_DESIGN.md): editors (ACP). `POST /api/editor/sessions` makes the coding chat
// an editor session talks in; `POST /api/editor/calls/:id` is the editor's answer to a file or
// command call of an editor-linked turn. The owner's only (members and the demo are refused); the
// policy can pin editors off.
import { audit } from '../audit-trail.ts';
import { cleanEditorLink, editorCalls, folderWorkspace } from '../editor-link.ts';
import { HttpError, readJson, send } from '../http.ts';
import { policy } from '../policy-profile.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createEditorRoutes(ctx: RouteCtx): RouteHandler {
  const { opts, app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'editor') return NEXT;
    if (opts.member || app.member || opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    if (b === 'sessions' && !c && method === 'POST') {
      if (!policy().editorsOn) throw policy().refusal('editors');
      const body = await readJson(req);
      const link = cleanEditorLink({ label: body.editor })!;
      const workspace = folderWorkspace(String(body.folder ?? ''));
      const conv = app.store.createConversation({ title: `${link.label}: ${workspace}`.slice(0, 80), mode: 'coding', workspace });
      audit({ action: 'editor.session', target: `conversation:${conv.id}`, keys: [`editor:${link.label}`] });
      return send(res, 201, { conversationId: conv.id, workspace, title: conv.title });
    }
    if (b === 'calls' && c && !parts[3] && method === 'POST') {
      const body = await readJson(req);
      if (!editorCalls.answer(c, { ok: body.ok === true, output: typeof body.output === 'string' ? body.output : '' })) throw new HttpError(404, 'That call is no longer waiting.');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
