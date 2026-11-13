// E6 (docs/BUSINESS_TOOLS.md): Settings → Business details, in each person's own space (the owner's,
// or a household member's own store.db; never the demo).
//   GET /api/business        {details, currencies, pictures (Library pictures for the logo), moneyIn, followUps}
//   PUT /api/business        {name, address, email, phone, taxId, logoDocId, payment, currency, taxRatePct, dueDays} → {details}
import { HttpError, readJson, send } from '../http.ts';
import { bizStore, CURRENCIES, localDay } from '../biz/store.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const PICTURE = /\.(jpe?g|png|gif|webp)$/i;

export function createBizRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'business' || b !== undefined) return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo.');
    }
    const store = bizStore(app);
    if (method === 'GET') {
      const pictures = (app.library?.list() ?? []).filter((d) => PICTURE.test(d.name)).slice(0, 100).map((d) => ({ id: d.id, name: d.name }));
      return send(res, 200, { details: store.details(), currencies: CURRENCIES, pictures, moneyIn: store.moneyIn(localDay(app.now(), app.settings.get().timeZone)) ?? null, followUps: store.state('followups') ?? null });
    }
    if (method === 'PUT') {
      const body = (await readJson(req)) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send the business details as an object.');
      if (body.logoDocId !== undefined && body.logoDocId !== null && body.logoDocId !== '') {
        const doc = app.library?.get(Number(body.logoDocId));
        if (!doc || !PICTURE.test(doc.name)) throw new HttpError(400, 'The logo must be a picture in your Library.');
      }
      return send(res, 200, { details: store.saveDetails(body) });
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
