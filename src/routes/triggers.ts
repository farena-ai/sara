// C4 (docs/ops/C4_DESIGN.md, docs/TRIGGERS.md): "When this happens" event triggers, the owner's
// only. Household members, the demo and device tokens get 403. Every change is one audit row (the
// route group `triggers` is audited in src/server.ts).
//   GET    /api/triggers               {triggers (each with today and its last run), runs, hooks, servers, crews, tools, pinned}
//   POST   /api/triggers               {name, source, filter, action, limits, state} → {trigger}
//   PATCH  /api/triggers/:id           the same fields (state 'on' | 'paused' pauses/resumes) → {trigger}
//   DELETE /api/triggers/:id           forget the trigger and its runs (its conversation stays)
//   GET    /api/triggers/:id/runs      {runs}
import { subscribeWanted, TriggerError } from '../event-triggers.ts';
import { HttpError, readJson, send } from '../http.ts';
import { policy } from '../policy-profile.ts';
import { HOOK_TOOLS } from '../webhooks.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createTriggerRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof TriggerError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  const resubscribe = (server?: string) => {
    const conn = server ? app.mcp?.get(server) : undefined;
    if (conn) subscribeWanted(conn);
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'triggers') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.eventTriggers) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const tr = app.eventTriggers;
    if (!b) {
      if (method === 'GET') {
        const triggers = tr.list().map((x) => ({ ...x, today: tr.today(x.id), last: tr.runs(x.id, 1)[0] ?? null }));
        const hooks = (app.hooks?.store.all() ?? []).filter((h) => !h.ownerPlugin).map((h) => ({ id: h.id, name: h.name }));
        const servers = (app.settings.get().mcpServers ?? []).map((s) => s.name);
        const crews = (app.crews?.list() ?? []).map((x) => ({ id: x.id, name: x.name }));
        return send(res, 200, { triggers, runs: tr.runs(undefined, 30), hooks, servers, crews, tools: Object.keys(HOOK_TOOLS), pinned: policy().pins.triggers === false });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const trigger = wrap(() => tr.create(body));
        resubscribe(trigger.filter.server);
        return send(res, 200, { trigger });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || !tr.get(id)) throw new HttpError(404, 'Not found');
    if (!c) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        const trigger = wrap(() => tr.patch(id, body));
        resubscribe(trigger.filter.server);
        return send(res, 200, { trigger });
      }
      if (method === 'DELETE') {
        tr.remove(id);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'runs' && method === 'GET') return send(res, 200, { runs: tr.runs(id, 50) });
    throw new HttpError(404, 'Not found');
  };
}
