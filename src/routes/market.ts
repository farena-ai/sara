// U4.27 (docs/MARKETPLACE.md): the community marketplace's owner API and its peer endpoint.
// Owner only: household members, kid mode and the demo get 403 here and no peer endpoint at all.
//   GET    /api/market                         {places, installs, reports}
//   GET    /api/market/items                   {skill, automation, team}   the owner's own items to share
//   GET    /api/market/places/:place           {listings}   a community's shelf or a friend's (c:<chat> | f:<link>)
//   POST   /api/market/publish                 {place, kind, ref?, title?, text?, description, version, tools?, settings?, listing?} → {listing}
//   POST   /api/market/review                  {place, listing} → {listing, check}   nothing changes
//   POST   /api/market/install                 {place, listing, hash} → {installed} | {open}   only the reviewed hash
//   POST   /api/market/rate                    {place, listing, stars, comment?}
//   POST   /api/market/report                  {place, listing, why}
//   POST   /api/market/remove                  {place, listing}   keeper: remove; author: withdraw
//   DELETE /api/market/reports/:id             dismiss a report
// Peer: POST /msg/v1/market/<op>, signed (src/market.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import { MarketError, marketOf } from '../market.ts';
import { readPeerBody } from './support.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMarketRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'market') return NEXT;
    const mk = ctx.opts.demo || ctx.opts.member ? undefined : marketOf(app);
    if (!mk) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 128 * 1024);
    const place = String(body.place ?? '');
    const id = String(body.listing ?? '');
    try {
      if (!b && method === 'GET') return send(res, 200, { places: mk.places(), installs: mk.installs(), reports: mk.reports() });
      if (b === 'items' && method === 'GET') {
        // The owner's own items to share (names only; the item itself is read when it is shared).
        const skills = (app.skills?.list() ?? []).filter((s) => s.scope === 'companion' && s.enabled).map((s) => ({ ref: s.name, title: s.name }));
        const automations = (app.automations?.list() ?? []).map((x) => ({ ref: String(x.id), title: x.name }));
        const team = (app.teamRuns?.recipes.list() ?? []).map((x) => ({ ref: String(x.id), title: x.name }));
        const worker = (app.workers?.list() ?? []).map((x) => ({ ref: String(x.id), title: x.name }));
        return send(res, 200, { skill: skills, automation: automations, team, worker });
      }
      if (b === 'places' && c && method === 'GET') return send(res, 200, { listings: await mk.browse(decodeURIComponent(c)) });
      if (method === 'POST' && b === 'publish') return send(res, 200, { listing: await mk.publish(place, body as never) });
      if (method === 'POST' && b === 'review') return send(res, 200, await mk.review(place, id));
      if (method === 'POST' && b === 'install') return send(res, 200, await mk.install(place, id, body.hash));
      if (method === 'POST' && b === 'rate') return (await mk.rate(place, id, body.stars, body.comment), send(res, 200, { ok: true }));
      if (method === 'POST' && b === 'report') return (await mk.report(place, id, body.why), send(res, 200, { ok: true }));
      if (method === 'POST' && b === 'remove') return (await mk.remove(place, id), send(res, 200, { ok: true }));
      if (method === 'DELETE' && b === 'reports' && c) return (mk.dismissReport(c), send(res, 200, { ok: true }));
    } catch (err) {
      if (err instanceof MarketError) throw new HttpError(err.status === 401 ? 403 : err.status, err.message);
      if (err instanceof Error && 'status' in err && typeof (err as { status: unknown }).status === 'number') throw new HttpError((err as { status: number }).status, err.message);
      if (err instanceof Error && !(err instanceof HttpError)) throw new HttpError(400, err.message);
      throw err;
    }
    throw new HttpError(404, 'Not found');
  };
}

export async function handleMarketPeer(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const mk = marketOf(ctx.app);
  if (!mk) return reply(404, { error: 'not found' });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const op = path.slice('/msg/v1/market/'.length);
  if (!['list', 'get', 'publish', 'withdraw', 'rate', 'report', 'subscribe', 'notice'].includes(op)) return reply(404, { error: 'not found' });
  let raw = '';
  try {
    raw = await readPeerBody(req);
  } catch {
    return reply(413, { error: 'too big' });
  }
  try {
    const who = mk.verify(req.headers, op, raw);
    return reply(200, mk.serve(op, who, JSON.parse(raw) as Record<string, unknown>));
  } catch (err) {
    if (err instanceof MarketError) return reply(err.status, { error: err.message });
    return reply(400, { error: err instanceof Error ? err.message.slice(0, 300) : 'bad request' });
  }
}
