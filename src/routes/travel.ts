// S6 (docs/TRAVEL.md): the Trips page, each person's own (a household member's live in their own
// space). Never the demo. Calendar and packing list happen only here, on the person's tap.
//   GET    /api/trips                     {trips, settings, past}
//   PUT    /api/trips/settings            {provider?, key?, alerts?, checkin?, leaveBy?} → {settings}
//   GET    /api/trips/:id                 {trip}
//   PATCH  /api/trips/:id                 {title} → {trip}
//   POST   /api/trips/:id/calendar        → {added, text, trip}
//   POST   /api/trips/:id/packing         → {packing, trip}
//   POST   /api/trips/:id/check           → {trip}
//   DELETE /api/trips/:id
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { TravelError, travelFor } from '../travel.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createTravelRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof TravelError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'trips') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = travelFor(app);
    if (!b && method === 'GET') {
      const all = s.trips({ all: true });
      const now = app.now().getTime();
      return send(res, 200, { trips: s.trips(), past: all.filter((t) => t.endsAt && Date.parse(t.endsAt) < now - 48 * 3600_000).slice(0, 10), settings: s.settings() });
    }
    if (b === 'settings' && !c && method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, { settings: await wrap(() => s.setSettings(body)) });
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
    const must = () => {
      const t = s.trip(id);
      if (!t) throw new HttpError(404, T('Trip not found.'));
      return t;
    };
    if (!c && method === 'GET') return send(res, 200, { trip: must() });
    if (!c && method === 'DELETE') {
      if (!s.remove(id)) throw new HttpError(404, T('Trip not found.'));
      return send(res, 200, { ok: true });
    }
    if (!c && method === 'PATCH') {
      const body = await readJson(req);
      return send(res, 200, { trip: await wrap(() => s.rename(id, String(body.title ?? ''))) });
    }
    if (c && method === 'POST') {
      await readJson(req).catch(() => ({}));
      must();
      if (c === 'calendar') {
        const r = await wrap(() => s.addToCalendar(id));
        return send(res, 200, { ...r, trip: must() });
      }
      if (c === 'packing') return send(res, 200, { packing: await wrap(() => s.packingList(id)), trip: must() });
      if (c === 'check') return send(res, 200, { trip: await wrap(() => s.checkNow(id)) });
    }
    throw new HttpError(404, 'Not found');
  };
}
