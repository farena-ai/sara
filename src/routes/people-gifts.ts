// V2.7 (docs/design/GIFTS.md): gifts and occasions, under /api/people (same owner/member rules as
// the cards: each person's own space, never /v1, MCP or A2A).
//   GET  /people/gifts-prefs                 PUT {on, days, budget}
//   GET  /people/:id/gifts                   PUT {budget, remind}
//   POST /people/:id/gifts/ideas {occasion?} POST /people/:id/gifts/card {occasion?, gift?}
//   POST /people/:id/gifts/list {idea}       (index of the idea → a Planner to-do in Gifts)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { giftsOf } from '../gifts.ts';
import { HttpError, readJson, send } from '../http.ts';
import type { RouteCtx } from './context.ts';

/** Returns true when it answered. */
export async function peopleGiftsRoute(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<boolean> {
  const [, b, c, d] = parts;
  const app = ctx.app;
  if (!(b === 'gifts-prefs' && !c) && c !== 'gifts') return false;
  if (!app.people) throw new HttpError(404, 'People cards are not available here.');
  const g = giftsOf(app);
  const ok = (status: number, body: unknown): true => {
    send(res, status, body);
    return true;
  };
  if (b === 'gifts-prefs') {
    if (method === 'GET') return ok(200, g.prefs());
    if (method === 'PUT') return ok(200, g.setPrefs(await readJson(req)));
    throw new HttpError(405, 'Method not allowed');
  }
  const id = Number(b);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'That person is gone.');
  const view = () => g.view(id);
  if (!d) {
    if (method === 'GET') return ok(200, view());
    if (method === 'PUT') {
      const body = await readJson(req);
      g.setPlan(id, { ...(body.budget !== undefined ? { budget: body.budget } : {}), ...(body.remind !== undefined ? { remind: body.remind } : {}) });
      return ok(200, view());
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readJson(req);
  const occasion = typeof body.occasion === 'string' ? body.occasion : undefined;
  if (d === 'ideas') {
    await g.ideas(id, { occasion });
    return ok(200, view());
  }
  if (d === 'card') {
    await g.card(id, occasion, { gift: typeof body.gift === 'string' ? body.gift : undefined });
    return ok(200, view());
  }
  if (d === 'list') {
    const task = g.toList(id, Number(body.idea));
    return ok(200, { ...view(), task });
  }
  throw new HttpError(404, 'Not found');
}
