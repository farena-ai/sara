// U5.32 (docs/WHATS_NEW.md): "What's new in 3.x" after an update (src/whats-new.ts).
//   GET  /api/whats-new[?all=1]   {version, seen, auto, show, releases}: after an update `show` is true once
//                                 with the releases since the last seen version; all=1 = Help → What's new
//   POST /api/whats-new/seen      Got it: seen = this version
//   PUT  /api/whats-new           { auto }   show it by itself after updates (on by default)
// Per person (each member's own data folder); members get the members' subset, kid mode nothing.
import { join } from 'node:path';
import { en } from '../i18n.ts';
import { HttpError, readJson, send } from '../http.ts';
import { cmpVersion, loadWhatsNew, WhatsNewSeen, whatsNewView } from '../whats-new.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const ROOT_WEB = join(import.meta.dirname, '..', '..', 'web');

export function createWhatsNewRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const data = () => loadWhatsNew(ctx.opts.webDir ?? ROOT_WEB);
  // A source checkout without a version ('dev') counts as the newest release in the file.
  const version = () => /^\d+\.\d+\.\d+/.exec(String(ctx.info.version ?? ''))?.[0] ?? data().releases[0]?.version ?? '0.0.0';
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'whats-new') return NEXT;
    if (ctx.opts.demo) throw new HttpError(404, en('Not available in the demo.'));
    const store = new WhatsNewSeen(app.dataDir);
    const member = Boolean(ctx.opts.member);
    const kid = Boolean(app.member?.child?.());
    const view = (all: boolean) => whatsNewView(data(), { version: version(), state: store.get(), member, kid, all });
    if (!b && method === 'GET') {
      // A new install (or the first look since this existed) only remembers the version.
      if (!store.get().seen) store.set({ seen: version() });
      return send(res, 200, view(new URL(req.url ?? '/', 'http://x').searchParams.get('all') === '1'));
    }
    const body = (await readJson(req, 4 * 1024).catch(() => ({}))) as Record<string, unknown>;
    if (b === 'seen' && method === 'POST') {
      const seen = store.get().seen;
      if (!seen || cmpVersion(version(), seen) > 0) store.set({ seen: version() });
      return send(res, 200, view(false));
    }
    if (!b && method === 'PUT') {
      if (typeof body.auto !== 'boolean') throw new HttpError(400, en('Choose on or off.'));
      store.set({ auto: body.auto });
      return send(res, 200, view(false));
    }
    throw new HttpError(404, en('Not available here.'));
  };
}
