// N4 (docs/MY_DETAILS.md): Settings → You → My details, in each person's own space (the owner's, or a
// household member's own store.db; never the demo). Values shaped like a card number or an SSN are refused.
//   GET    /api/my-details    {details, updatedAt, leaveStoreTab}
//   PUT    /api/my-details    {…details, leaveStoreTab?} → {details, leaveStoreTab}   (400 {error, field} on a refused value)
//   DELETE /api/my-details    forget them all
//   POST   /api/my-details/copy  T62: a second companion with none of her own copies the main companion's once (owner only)
// V2.6 (docs/UPKEEP.md): Car and house upkeep, a section of the same page (src/upkeep.ts)
//   GET    /api/my-details/upkeep                    {cars, items, found, odometer, table}
//   POST   /api/my-details/upkeep/setup|add|miles|skip {…}  → {ok, added?, item?}
//   POST   /api/my-details/upkeep/:id/log|remind|book|remove {…} → {ok, item?, errand?}
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { DetailError, myDetailsFor } from '../my-details.ts';
import { upkeepAction, UpkeepError, upkeepList, UPKEEP_VERBS, type UpkeepVerb } from '../upkeep.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMyDetailsRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'my-details' || (b !== undefined && b !== 'upkeep' && b !== 'copy')) return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo.');
    }
    if (b === 'upkeep') {
      if (c === undefined && method === 'GET') return send(res, 200, upkeepList(app));
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const verb = (d ?? c) as UpkeepVerb;
      const byId = d !== undefined;
      if (!UPKEEP_VERBS.includes(verb) || byId !== ['log', 'remind', 'book', 'remove'].includes(verb) || (byId && !/^\d+$/.test(c!))) throw new HttpError(404, 'Not found');
      const body = ((await readJson(req).catch(() => ({}))) ?? {}) as Record<string, unknown>;
      try {
        return send(res, 200, upkeepAction(app, verb, byId ? { ...body, id: Number(c) } : body));
      } catch (err) {
        if (err instanceof UpkeepError) return send(res, err.status, { error: trOwner(err.message, app.settings.get()) });
        throw err;
      }
    }
    const store = app.myDetails ?? myDetailsFor(app.store.db);
    // T62: each companion keeps her own details; the main companion's, when a second one may copy them.
    const copyFrom = () => {
      const main = ctx.opts.companions?.main;
      if (!main || main.app === app || ctx.opts.member || app.member || Object.keys(store.get()).length) return undefined;
      const theirs = main.app.myDetails ?? myDetailsFor(main.app.store.db);
      return Object.keys(theirs.get()).length ? { name: main.app.persona.name, store: theirs } : undefined;
    };
    if (b === 'copy') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      await readJson(req).catch(() => undefined);
      const from = copyFrom();
      if (!from) throw new HttpError(404, 'Not found');
      const details = store.set(from.store.get() as Record<string, unknown>, app.now());
      return send(res, 200, { details, leaveStoreTab: store.leaveStoreTab() });
    }
    if (method === 'GET') {
      const from = copyFrom();
      return send(res, 200, { details: store.get(), updatedAt: store.updatedAt(), leaveStoreTab: store.leaveStoreTab(), copyFrom: from ? from.name : null });
    }
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
