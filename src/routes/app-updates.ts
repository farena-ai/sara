// The Sara apps' versions and "Update it" (docs/desktop.md → How the app updates; src/app-installs.ts).
//   POST /api/app-updates/checkin               the app's page: its version and update state → { server, ask }
//   GET  /api/app-updates                        Settings → Devices: this space's apps (the owner: members' too)
//   POST /api/app-updates/<id>/update            Update it: one of this space's apps
//   POST /api/app-updates/member/<m>/<id>/update the owner only: a household member's app
import { appInstallView, AppInstalls, cannotAsk, CHECKIN_SECONDS, cleanCheckin } from '../app-installs.ts';
import { SESSION_COOKIE } from '../auth.ts';
import { cookies, HttpError, readJson, send } from '../http.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createAppUpdateRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, opts, info, rootDir } = ctx;
  const installs = new AppInstalls(rootDir, () => app.now());
  const serverVersion = () => info?.version ?? '';
  const alive = (id: string) => auth.devices().some((d) => d.id === id);
  const memberStore = (memberId: string) => {
    const h = opts.household;
    if (!h || opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    const m = h.store.members().find((x) => x.id === memberId);
    if (!m) throw new HttpError(404, 'No such member.');
    return { member: m, store: new AppInstalls(h.store.dirOf(m.id), () => app.now()) };
  };
  const ask = (store: AppInstalls, id: string, by: string) => {
    const a = store.get(id);
    if (!a) throw new HttpError(404, 'That app isn’t signed in here any more.');
    const why = cannotAsk(a);
    if (why) throw new HttpError(409, why);
    store.ask(id, by);
    return appInstallView(id, store.get(id)!, serverVersion());
  };

  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'app-updates') return NEXT;
    if (opts.demo) throw new HttpError(403, 'Not on the demo.');
    const sid = auth.sessionId(cookies(req)[SESSION_COOKIE]);
    if (b === 'checkin' && !c && method === 'POST') {
      // The app's own sign-in (its web view), never an API key or a token.
      if (!sid) throw new HttpError(401, 'Sign in in the app first.');
      let clean;
      try {
        clean = cleanCheckin(await readJson(req));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const label = auth.devices().find((x) => x.id === sid)?.label ?? '';
      const r = installs.checkin(sid, clean, label);
      return send(res, 200, { server: serverVersion(), every: CHECKIN_SECONDS, ask: r.ask, ...(r.askedBy ? { askedBy: r.askedBy } : {}) });
    }
    if (!b && method === 'GET') {
      const apps = installs.list(alive).map(([id, x]) => appInstallView(id, x, serverVersion(), sid));
      const h = opts.household;
      const members =
        h && !opts.member
          ? h.store
              .members()
              .map((m) => ({ id: m.id, name: m.name, apps: new AppInstalls(h.store.dirOf(m.id), () => app.now()).list().map(([id, x]) => appInstallView(id, x, serverVersion())) }))
              .filter((m) => m.apps.length)
          : undefined;
      return send(res, 200, { server: serverVersion(), apps, ...(members ? { members } : {}) });
    }
    if (b === 'member' && c && d && e === 'update' && method === 'POST' && parts.length === 5) {
      const { store } = memberStore(c);
      return send(res, 200, ask(store, d, 'owner'));
    }
    if (b && b !== 'member' && c === 'update' && !d && method === 'POST') {
      if (!alive(b)) throw new HttpError(404, 'That app isn’t signed in here any more.');
      return send(res, 200, ask(installs, b, opts.member ? 'you' : 'owner'));
    }
    throw new HttpError(404, 'Not found');
  };
}
