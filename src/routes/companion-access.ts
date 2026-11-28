// T62: what another companion may use of the server's mailboxes, Google and Spotify (her allow list,
// src/companion-access.ts). Owner only, never the demo or a household member. The request goes to
// the companion that is open (src/server.ts pickCompanion), so `app` is hers.
//   GET /api/companion-access  → { main, name, access, mail: [{id, address, kind}], google, spotify }
//   PUT /api/companion-access  { mail?: string[], google?: boolean, spotify?: boolean }
import { accessFor, realOf, type CompanionAccess } from '../companion-access.ts';
import { HttpError, readJson, send } from '../http.ts';
import { clearTodayCache } from '../today.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createCompanionAccessRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  const main = !app.companionId || app.companionId === 'main';
  const view = () => {
    const mail = realOf(app.mailAccounts);
    const google = realOf(app.google)?.status();
    const spotify = realOf(app.spotify)?.status();
    return {
      main,
      name: app.persona.name,
      // The first companion uses everything (null: no list of her own).
      access: main ? null : accessFor(app.dataDir).get(),
      mail: (mail?.list() ?? []).map((x) => ({ id: x.id, address: x.address, kind: x.kind })),
      google: { connected: Boolean(google?.connected) || (realOf(app.googleAccounts)?.all().length ?? 0) > 0 },
      spotify: { connected: Boolean(spotify?.connected) },
    };
  };
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'companion-access' || b) return NEXT;
    if (opts.demo || app.demo || opts.member || app.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    if (method === 'GET') return send(res, 200, view());
    if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
    const body = await readJson(req);
    if (main) throw new HttpError(400, 'The first companion can use every connected account.');
    const patch: Partial<CompanionAccess> = {};
    if (body.mail !== undefined) {
      if (!Array.isArray(body.mail)) throw new HttpError(400, 'Say which mailboxes.');
      patch.mail = body.mail.map(String);
    }
    if (body.google !== undefined) patch.google = body.google === true;
    if (body.spotify !== undefined) patch.spotify = body.spotify === true;
    accessFor(app.dataDir).set(patch);
    // Her Today and briefing read her mail and calendars again.
    clearTodayCache(app);
    return send(res, 200, view());
  };
}
