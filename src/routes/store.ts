// Phase 124 (2.57.0, docs/store/SARA_STORE.md §6.2, §12.2): the Sara Store's reader for the owner.
// Owner only (`store` is not a member route family, like `plugins`); the demo refuses it. The page
// never talks to the store itself: everything comes from here.
//   GET  /api/store            the read model: items this Sara can run (with the reason when not),
//                              installed / update / yanked / blocked state, freshness, notices
//   POST /api/store/check      fetch the list now (Check now)
//   GET  /api/store/settings   { on, community }
//   PUT  /api/store/settings   { on?, community? }
//   POST /api/store/notices/:item/dismiss   a block or warn notice was read
// Installing, item pages, pictures, reports and submitting are Phase 125.
import { en } from '../i18n.ts';
import { HttpError, readJson, send } from '../http.ts';
import { SARA_VERSION } from '../plugins/manager.ts';
import { shelfView } from '../store/client.ts';
import { isStoreId } from '../store/format.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export interface StoreSettings {
  on: boolean;
  community: boolean;
}
export function storeSettings(s: { store?: { on?: unknown; community?: unknown } } | undefined): StoreSettings {
  return { on: s?.store?.on !== false, community: s?.store?.community === true };
}

export function createStoreRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'store') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Add-ons aren’t in the demo.'));
    }
    if (ctx.opts.member || app.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    const client = app.storeClient;
    const settings = () => storeSettings(app.settings.get() as never);
    const view = () => {
      if (!client) return { ...settings(), blocked: 'demo', freshness: 'none', items: [], held: [], notices: [] };
      return shelfView(client, { saraVersion: app.pluginManager?.version ?? SARA_VERSION, installs: app.storeInstalls, ...settings() });
    };

    if (!b && method === 'GET') return send(res, 200, view());
    if (b === 'check' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      if (!client) throw new HttpError(404, en('The Sara Store is not available here.'));
      const r = await client.check();
      return send(res, 200, { result: r, store: view() });
    }
    if (b === 'settings' && !c) {
      if (method === 'PUT') {
        const body = await readJson(req);
        const cur = settings();
        const next: StoreSettings = { on: typeof body.on === 'boolean' ? body.on : cur.on, community: typeof body.community === 'boolean' ? body.community : cur.community };
        app.settings.update({ store: next } as never);
        return send(res, 200, next);
      }
      if (method === 'GET') return send(res, 200, settings());
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'notices' && c && d === 'dismiss' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      if (!isStoreId(c)) throw new HttpError(400, 'Not a store id.');
      client?.dismiss(c);
      return send(res, 200, view());
    }
    if (method !== 'GET') await readJson(req).catch(() => undefined);
    throw new HttpError(404, 'Not found');
  };
}
