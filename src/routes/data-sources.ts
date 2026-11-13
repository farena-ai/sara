// E1 (docs/DATA.md): Settings → Data sources, each person's own (the owner's, or a household
// member's own space: their choices, keys and watches). Keys are written to this space's vault and
// never sent back (only "has a key"). The demo gets 403.
//   GET    /api/data-sources                 {kinds: [{kind, provider, providers, ready, quota}], watches, limits}
//   PUT    /api/data-sources                 {providers?: {quote?, sports?, odds?}, keys?: {<provider>: key | ''}}
//   POST   /api/data-sources/test            {kind} → {ok, message, source}
//   DELETE /api/data-sources/watches/:id     remove a "tell me when" watch
import { DATA_KINDS, PROVIDERS, dataVaultKey, providerInfo, type DataKind } from '../data-sources.ts';
import { HttpError, readJson, send } from '../http.ts';
import { LIVE } from '../live-watch.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createDataSourceRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'data-sources') return NEXT;
    const ds = app.dataSources;
    if (ctx.opts.demo || !ds) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Live data is not available here.');
    }
    const view = () => ({
      kinds: DATA_KINDS.map((kind) => {
        const p = ds.provider(kind);
        return {
          kind,
          provider: p.id,
          ready: ds.ready(kind),
          quota: ds.quota(p.id) ?? null,
          providers: PROVIDERS.filter((x) => x.kind === kind).map((x) => ({ ...x, hasKey: ds.hasKey(x.id) })),
        };
      }),
      watches: app.liveWatches?.list() ?? [],
      limits: LIVE,
    });
    if (!b) {
      if (method === 'GET') return send(res, 200, view());
      if (method === 'PUT') {
        const body = await readJson(req);
        const choices = { ...(app.settings.get().dataSources ?? {}) };
        const want = (body.providers ?? {}) as Record<string, unknown>;
        for (const kind of DATA_KINDS) {
          if (want[kind] === undefined) continue;
          const p = providerInfo(String(want[kind]));
          if (!p || p.kind !== kind) throw new HttpError(400, 'Unknown provider');
          choices[kind] = p.id;
        }
        const keys = (body.keys ?? {}) as Record<string, unknown>;
        for (const [id, v] of Object.entries(keys)) {
          const p = providerInfo(id);
          if (!p || !(p.needsKey || p.keyOptional)) throw new HttpError(400, 'Unknown provider');
          if (typeof v !== 'string') continue;
          const k = v.trim();
          if (!k) app.vault.delete(dataVaultKey(p.id));
          else if (/^[\x21-\x7e]{4,200}$/.test(k)) app.vault.set(dataVaultKey(p.id), k);
          else throw new HttpError(400, 'That key has spaces or unusual characters. Paste only the key.');
        }
        app.settings.update({ dataSources: choices });
        return send(res, 200, view());
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'test' && method === 'POST') {
      const body = await readJson(req);
      const kind = String(body.kind ?? '') as DataKind;
      if (!DATA_KINDS.includes(kind)) throw new HttpError(400, 'Unknown kind');
      return send(res, 200, await ds.test(kind));
    }
    if (b === 'watches' && c && method === 'DELETE') {
      const id = Number(c);
      if (!app.liveWatches || !Number.isInteger(id) || !app.liveWatches.remove(id)) throw new HttpError(404, 'Not found');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
