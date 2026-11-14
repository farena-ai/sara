// N4 (docs/MY_DETAILS.md): Settings → You → My details, in each person's own space (the owner's, or a
// household member's own store.db; never the demo). Values shaped like a card number or an SSN are refused.
//   GET    /api/my-details    {details, updatedAt, leaveStoreTab}
//   PUT    /api/my-details    {…details, leaveStoreTab?} → {details, leaveStoreTab}   (400 {error, field} on a refused value)
//   DELETE /api/my-details    forget them all
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { DetailError, myDetailsFor } from '../my-details.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMyDetailsRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'my-details' || b !== undefined) return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo.');
    }
    const store = app.myDetails ?? myDetailsFor(app.store.db);
    if (method === 'GET') return send(res, 200, { details: store.get(), updatedAt: store.updatedAt(), leaveStoreTab: store.leaveStoreTab() });
    if (method === 'PUT') {
      const body = (await readJson(req)) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send your details as an object.');
      try {
        const { leaveStoreTab, ...rest } = body;
        const details = store.set(rest, app.now());
        if (typeof leaveStoreTab === 'boolean') store.setLeaveStoreTab(leaveStoreTab);
        return send(res, 200, { details, leaveStoreTab: store.leaveStoreTab() });
      } catch (err) {
        if (err instanceof DetailError) return send(res, 400, { error: trOwner(err.message, app.settings.get()), field: err.field });
        throw err;
      }
    }
    if (method === 'DELETE') {
      store.clear();
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
