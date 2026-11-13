// E5 (docs/DECISIONS_HELPER.md): saved decisions, this space's own (a household member's are
// theirs; the demo gets 403). The chat card's buttons use the two POSTs.
//   GET  /api/decisions                 {decisions}
//   GET  /api/decisions/:id             {decision}
//   POST /api/decisions/:id/choose      {chosen, why?} → {decision}   (I chose this)
//   POST /api/decisions/:id/document    → {made: {id, name, title}}   (Save as document: Word)
import { decisionMarkdown, decisionsOf } from '../decisions.ts';
import { DocError, makeDocument } from '../documents/make.ts';
import { HttpError, readJson, send } from '../http.ts';
import { ToolError } from '../tools/types.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createDecisionRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'decisions') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const store = decisionsOf(app);
    if (!b) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { decisions: store.list({ limit: 100 }) });
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || d) throw new HttpError(404, 'Not found');
    const dec = store.get(id);
    if (!dec) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'That decision is not here.');
    }
    if (!c && method === 'GET') return send(res, 200, { decision: dec });
    if (c === 'choose' && method === 'POST') {
      const body = ((await readJson(req).catch(() => ({}))) ?? {}) as { chosen?: unknown; why?: unknown };
      const chosen = String(body.chosen ?? '').trim();
      if (!dec.input.options.some((o) => o === chosen)) throw new HttpError(400, 'Pick one of the options.');
      try {
        return send(res, 200, { decision: store.choose(id, chosen, typeof body.why === 'string' ? body.why : null) });
      } catch (err) {
        if (err instanceof ToolError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (c === 'document' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      try {
        const { made } = makeDocument(app, { format: 'docx', title: `Decision - ${dec.question}`.slice(0, 120), content: decisionMarkdown(dec), template: 'report' });
        return send(res, 200, { made: { id: made.id, name: made.name, title: made.title } });
      } catch (err) {
        if (err instanceof DocError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
