// E4 (docs/ops/E4_DESIGN.md): file/log watches, the owner's only. Household members, the demo and
// anyone else get 403 (guests and other apps' keys never get past sign-in). Nothing here calls a
// model or runs a command; there is no model tool for this (she can only suggest a watch).
//   GET    /api/watches                       {watches, roots, limits}
//   POST   /api/watches                       {root, workspace, path, patterns, caseIns, everyMin, conversationId} → {watch}
//   PATCH  /api/watches/:id                   {patterns, caseIns, everyMin} → {watch}
//   POST   /api/watches/:id/check-now · /pause · /resume · /stop
//   DELETE /api/watches/:id                   Stop and forget (the watch and its alerts)
//   GET    /api/watches/:id/alerts            {alerts}
//   POST   /api/watches/alerts/:aid/ask       {conversationId, text, cloud}: the owner's own question
import { HttpError, readJson, send } from '../http.ts';
import { WATCH, WatchError } from '../watch.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createWatchRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof WatchError) throw new HttpError(err.status, err.message, err.params ? { params: err.params } : undefined);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'watches') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.watches) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const w = app.watches;
    if (!b) {
      if (method === 'GET') return send(res, 200, { watches: w.list(), roots: w.roots(), limits: WATCH });
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { watch: wrap(() => w.create(body)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'alerts' && c && d === 'ask' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, wrap(() => w.ask(Number(c))));
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
    if (!c) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, { watch: wrap(() => w.patch(id, body)) });
      }
      if (method === 'DELETE') {
        if (!w.get(id)) throw new HttpError(404, 'Not found');
        w.forget(id);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'alerts' && method === 'GET') {
      if (!w.get(id)) throw new HttpError(404, 'Not found');
      return send(res, 200, { alerts: w.alerts(id) });
    }
    if (method === 'POST' && !d) {
      await readJson(req).catch(() => ({}));
      if (c === 'check-now') return send(res, 200, wrap(() => w.checkNow(id)));
      if (c === 'pause') return send(res, 200, { watch: wrap(() => w.pause(id)) });
      if (c === 'resume') return send(res, 200, { watch: wrap(() => w.resume(id)) });
      if (c === 'stop') return send(res, 200, { watch: wrap(() => w.stop(id)) });
    }
    throw new HttpError(404, 'Not found');
  };
}
