// C6 (docs/ops/C6_DESIGN.md, docs/LEARN.md): Learn a topic, the owner's only. Household members,
// the demo and anyone else get 403. Every POST/PUT/DELETE writes audit rows (src/learn.ts).
//   GET    /api/learn                {topics, ready, why, budget, depths, refreshes}
//   POST   /api/learn                {subject?, site?, scope: web|site, depth, refresh, notify} → {topic}
//   PUT    /api/learn/settings       {monthlyTokens} → {budget}
//   GET    /api/learn/:id            {topic, skill: {name, body, versions} | null}
//   PUT    /api/learn/:id            {refresh?, depth?, notify?} → {topic}
//   POST   /api/learn/:id/refresh    refresh now → {topic}
//   DELETE /api/learn/:id            forget the topic, its skill and every version
import { HttpError, readJson, send } from '../http.ts';
import { LEARN, LearnError } from '../learn.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createLearnRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof LearnError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'learn') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.learnTopics) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const L = app.learnTopics;
    if (!b) {
      if (method === 'GET') {
        const why = L.refusal('topic');
        const siteWhy = L.refusal('site');
        return send(res, 200, { topics: L.list(), ready: !siteWhy, why, siteWhy, budget: L.budget(), depths: LEARN.depths, refreshes: Object.keys(LEARN.refreshDays) });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { topic: wrap(() => L.create(body as Record<string, unknown>)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'settings' && method === 'PUT') {
      const body = await readJson(req);
      wrap(() => L.setSettings(body as { monthlyTokens?: unknown }));
      return send(res, 200, { budget: L.budget() });
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || !L.get(id)) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (!c) {
      if (method === 'GET') {
        const topic = L.get(id)!;
        const d = topic.skill ? app.skills?.detail('companion', topic.skill) : undefined;
        return send(res, 200, { topic, skill: d ? { name: d.name, body: d.body, versions: d.versions } : null });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        return send(res, 200, { topic: wrap(() => L.update(id, body as Record<string, unknown>)) });
      }
      if (method === 'DELETE') return send(res, 200, { ok: L.delete(id) });
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'refresh' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { topic: wrap(() => L.refresh(id)) });
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
