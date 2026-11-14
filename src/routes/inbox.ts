// N3 (docs/INBOX_HELPER.md): the inbox helper, each person's own (a household member's suggestions,
// packages and trips come from their own mailboxes in their own space). Never the demo.
//   GET    /api/inbox                         {settings, mailboxes, status, tile, packages, trips, rules}
//   PUT    /api/inbox/settings                {on?, model?, auto?:{kind:bool}, accounts?:[address]|null}
//   POST   /api/inbox/scan                    read new mail now
//   POST   /api/inbox/items/:id/accept        {folder?} · /dismiss · /undo · /always · /file {folder?}
//   POST   /api/inbox/rules                   {from, folder, ext?}
//   POST   /api/inbox/rules/:id/on · /off     DELETE /api/inbox/rules/:id
//   DELETE /api/inbox/packages/:id
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { InboxError, inboxFor } from '../inbox/helper.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createInboxRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof InboxError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  const num = (s: string | undefined) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
    return n;
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'inbox') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = inboxFor(app);
    if (!b && method === 'GET') return send(res, 200, { settings: s.settings(), mailboxes: s.mailboxes(), status: s.status(), tile: s.todayTile() ?? null, packages: s.packages(), trips: s.trips(), rules: s.rules() });
    if (b === 'settings' && !c && method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, { settings: await wrap(() => s.setSettings(body)) });
    }
    if (b === 'scan' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      return send(res, 200, await s.scan());
    }
    if (b === 'items' && c && method === 'POST') {
      const id = num(c);
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (d === 'accept') return send(res, 200, { item: await wrap(() => s.accept(id, typeof body.folder === 'string' && body.folder.trim() ? { folder: body.folder.trim().slice(0, 60) } : {})) });
      if (d === 'dismiss') return send(res, 200, { item: await wrap(() => s.dismiss(id)) });
      if (d === 'file') return send(res, 200, await wrap(() => s.fileNow(id, typeof body.folder === 'string' && body.folder.trim() ? body.folder.trim().slice(0, 60) : undefined)));
      if (d === 'undo') return send(res, 200, { item: await wrap(() => s.undo(id)) });
      if (d === 'always') return send(res, 200, { item: await wrap(() => s.always(id)), settings: s.settings() });
    }
    if (b === 'rules') {
      if (!c && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { rule: await wrap(() => s.addRule({ from: body.from, folder: body.folder, ext: body.ext })) });
      }
      if (c && (d === 'on' || d === 'off') && method === 'POST') {
        await readJson(req).catch(() => undefined);
        const r = s.setRule(num(c), d);
        if (!r) throw new HttpError(404, 'Not found');
        return send(res, 200, { rule: r });
      }
      if (c && !d && method === 'DELETE') return send(res, 200, { ok: s.removeRule(num(c)) });
    }
    if (b === 'packages' && c && !d && method === 'DELETE') return send(res, 200, { ok: s.removePackage(num(c)) });
    throw new HttpError(404, 'Not found');
  };
}
