// U5.34 (docs/DASHBOARD.md): the server dashboard, the owner's only (members, kid mode and the demo: 403).
//   GET  /api/dashboard           {servers: [this server, ...linked servers read before], linked}
//   POST /api/dashboard/refresh   reads every linked server with an active help pass again (the S9b look)
// This server's card comes from the same report a helper sees (supportReport, without the self-test);
// a linked server's from its S9b support report, sent only while it gave this owner a help pass.
import { serverCard, type DashCard } from '../dashboard.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { supportOf } from '../support.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';
import { supportReport } from './support.ts';

/** Linked servers' last cards, per app (kept in memory: a restart reads them again at the next Refresh). */
const seen = new WeakMap<object, Map<string, DashCard>>();
const REMOTE_MS = 30_000;

export function createDashboardRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'dashboard') return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    if (method !== 'GET') await readJson(req, 4 * 1024).catch(() => ({}));
    const cache = seen.get(app) ?? new Map<string, DashCard>();
    seen.set(app, cache);
    const sp = supportOf(app);
    // Only links where the other owner gave a help pass that is still active.
    const active = sp ? sp.passes('held').filter((p) => p.active) : [];
    const ids = new Set(active.map((p) => p.link));
    for (const k of cache.keys()) if (!ids.has(k)) cache.delete(k);
    if (b === 'refresh' && method === 'POST' && sp) {
      await Promise.all(
        active.map(async (p) => {
          const now = app.now();
          try {
            const r = await Promise.race([sp.call(p.link, 'look', {}), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(en('No answer in 30 seconds.'))), REMOTE_MS).unref())]);
            sp.log(p.link, p.peer, 'helper', 'look');
            cache.set(p.link, serverCard((r.report ?? {}) as Record<string, unknown>, { name: p.peer, self: false, link: p.link, now }));
          } catch (err) {
            cache.set(p.link, serverCard(undefined, { name: p.peer, self: false, link: p.link, now, error: String((err as Error)?.message ?? err).slice(0, 200) }));
          }
        }),
      );
    } else if (b || method !== 'GET') throw new HttpError(404, 'Not found');
    const self = serverCard(await supportReport(ctx, { selfTest: false }), { name: en('This server'), self: true, now: app.now() });
    const servers = [self, ...active.map((p) => cache.get(p.link)).filter((c): c is DashCard => Boolean(c))];
    return send(res, 200, { servers, linked: active.map((p) => ({ link: p.link, peer: p.peer, expiresAt: p.expiresAt, read: cache.has(p.link) })) });
  };
}
