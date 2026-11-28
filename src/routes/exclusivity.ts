// 2026-11-28: Settings → Sara → Relationship → Romantic and sexual exclusivity (src/exclusivity.ts).
// The open companion's own setting (main's lives in the server settings, every other companion's in
// her folder: `exclusivity` is in COMPANION_KEYS). Never on the demo. A household member changes it
// for their own companion only (the request goes to their space, so `app` is theirs).
//   GET /api/exclusivity  → { adultOn, name, exclusivity, companions: [{id, name}], declined7d }
//   PUT /api/exclusivity  { mode?, companions?, discord?, telegram? } → the same view
import { declinedCount, EXCLUSIVITY_MODES, exclusivityOf, validCompanionId, validDiscordId, validTelegramId, type Exclusivity } from '../exclusivity.ts';
import { HttpError, readJson, send } from '../http.ts';
import { adultModeOn } from '../settings.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createExclusivityRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts } = ctx;
  const self = app.companionId ?? 'main';
  const others = () => (opts.member || app.member ? [] : ((opts.companions ?? app.companions)?.all() ?? []).filter((c) => c.id !== self).map((c) => ({ id: c.id, name: c.app.persona.name })));
  const view = () => ({
    adultOn: adultModeOn(app.settings.get()),
    name: app.persona.name,
    exclusivity: exclusivityOf(app.settings.get()),
    companions: others(),
    declined7d: declinedCount(app, 7),
  });
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'exclusivity' || b) return NEXT;
    if (opts.demo || app.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo server.');
    }
    if (method === 'GET') return send(res, 200, view());
    if (method !== 'PUT') throw new HttpError(405, 'Method not allowed');
    const body = await readJson(req);
    const next: Exclusivity = { ...exclusivityOf(app.settings.get()) };
    if (body.mode !== undefined) {
      if (!EXCLUSIVITY_MODES.includes(body.mode as Exclusivity['mode'])) throw new HttpError(400, 'Unknown field {key}.', { params: { key: 'mode' } });
      next.mode = body.mode as Exclusivity['mode'];
    }
    const ids = (key: 'discord' | 'telegram', ok: (s: string) => boolean) => {
      if (body[key] === undefined) return;
      if (!Array.isArray(body[key])) throw new HttpError(400, 'Unknown field {key}.', { params: { key } });
      const list = (body[key] as unknown[]).map((x) => String(x).trim()).filter(Boolean);
      if (list.some((x) => !ok(x))) throw new HttpError(400, 'An id is a number, not a name. Copy it from the app.');
      next[key] = [...new Set(list)].slice(0, 50);
    };
    ids('discord', validDiscordId);
    ids('telegram', validTelegramId);
    if (body.companions !== undefined) {
      if (!Array.isArray(body.companions)) throw new HttpError(400, 'Unknown field {key}.', { params: { key: 'companions' } });
      const known = new Set(others().map((c) => c.id));
      next.companions = [...new Set((body.companions as unknown[]).map(String))].filter((id) => validCompanionId(id) && known.has(id));
    }
    app.settings.update({ exclusivity: next });
    return send(res, 200, view());
  };
}
