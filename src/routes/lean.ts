// Phase 123 (docs/design/LEAN.md §4.13, §5.13): the lean tool list and /compact.
//   GET  /api/lean · PUT /api/lean          the `lean` settings (both parts), owner only
//   GET  /api/lean/measure                  eligible tools and tokens for an everyday and a coding chat
//   POST /api/compactions/:id/undo          Undo on the divider (the owner, or a member in their own space)
// The conversation routes (compact, compactions, tools) live with the other conversation routes in
// server.ts. The demo gets 404 everywhere; members get 404 on the tool routes (they have no tools).
import { getFold, undoFold } from '../compact.ts';
import { HttpError, readJson, send } from '../http.ts';
import { LEAN_CHOICES, leanSettings, measure, mergeLean } from '../lean.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createLeanRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'lean' && a !== 'compactions') return NEXT;
    if (ctx.opts.demo || (ctx.opts.member && a === 'lean')) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (a === 'lean' && !b) {
      if (method === 'PUT') mergeLean(app, await readJson(req));
      else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { settings: leanSettings(app), choices: LEAN_CHOICES });
    }
    if (a === 'lean' && b === 'measure' && method === 'GET') return send(res, 200, measure(app));
    if (a === 'compactions' && b && c === 'undo' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const f = getFold(app, Number(b));
      if (!f) throw new HttpError(404, 'Not found');
      const r = undoFold(app, f.conversationId, f.id);
      if (!r) throw new HttpError(409, 'Already undone.');
      return send(res, 200, { fold: r });
    }
    throw new HttpError(404, 'Not found');
  };
}
