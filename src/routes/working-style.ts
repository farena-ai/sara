// C12 (docs/ops/C12_DESIGN.md): "How she works with you" for this space. The owner, or a household
// member in their own space (each has their own beliefs); the demo gets 403. Audited in src/server.ts.
//   GET    /api/working-style                 {settings, pinned, beliefs}
//   PUT    /api/working-style                 {on} → {settings}
//   POST   /api/working-style/:id/confirm     → {belief}  (he says it's right: never fades)
//   POST   /api/working-style/:id/deny        → {belief}  (Not true: retired, not learned again)
//   DELETE /api/working-style/:id             Forget (the belief and its evidence)
import { HttpError, readJson, send } from '../http.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createWorkingStyleRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'working-style') return NEXT;
    const ws = app.workingStyle;
    if (ctx.opts.demo || !ws) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    if (!b) {
      if (method === 'GET') return send(res, 200, { settings: ws.settings(), pinned: ws.pinnedOff(), beliefs: ws.list() });
      if (method === 'PUT') {
        const body = (await readJson(req)) as { on?: unknown };
        return send(res, 200, { settings: ws.setSettings(body) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || d) throw new HttpError(404, 'Not found');
    if (!c && method === 'DELETE') {
      ws.forget(id);
      return send(res, 200, { ok: true });
    }
    if ((c === 'confirm' || c === 'deny') && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { belief: ws.decide(id, c) });
    }
    throw new HttpError(404, 'Not found');
  };
}
