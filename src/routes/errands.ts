// R3 (docs/ERRANDS.md): the Errands page, each person's own (a household member's live in their own
// space). Never the demo. Only here can the person turn on "send without asking" for one errand.
//   GET    /api/errands                         {errands, templates, needYou}
//   POST   /api/errands/preview                 {goal, template?, deadline?, budget?} → {plan}
//   POST   /api/errands                         {goal, template?, deadline?, budget?, facts?} → {errand} (planning)
//   GET    /api/errands/:id                     {errand}
//   PATCH  /api/errands/:id                     {note?, deadline?, budget?, sendWithoutAsking?, facts?}
//   POST   /api/errands/:id/start · /next · /skip · /stop
//   POST   /api/errands/:id/approve             {choice?, to?, note?, amount?}
//   DELETE /api/errands/:id
//   W4.1 Handle it: /api/errands/handle and /api/errands/:id/handle[/…] (src/routes/handle-it.ts)
import { ErrandError, errandsFor, TEMPLATES, type ErrandDraft } from '../errands.ts';
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';
import { handleRoute } from './handle-it.ts';

export function createErrandRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof ErrandError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  const draftOf = (b: Record<string, unknown>): ErrandDraft => ({
    goal: String(b.goal ?? '').slice(0, 300),
    ...(typeof b.template === 'string' && b.template ? { template: b.template } : {}),
    ...(typeof b.deadline === 'string' && b.deadline ? { deadline: b.deadline } : {}),
    ...(typeof b.budget === 'number' ? { budget: b.budget } : {}),
    ...(b.facts && typeof b.facts === 'object' ? { facts: b.facts as Record<string, unknown> } : {}),
  });
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'errands') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (b === 'handle' || c === 'handle') return handleRoute(req, res, method, parts, wrap, app);
    const s = errandsFor(app);
    if (!b && method === 'GET') {
      const errands = s.list();
      return send(res, 200, { errands, needYou: errands.filter((e) => e.status === 'waiting_you').length, templates: TEMPLATES.map((t) => ({ id: t.id, name: T(t.name), pitch: T(t.pitch) })) });
    }
    if (b === 'preview' && !c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { plan: await wrap(() => s.plan(draftOf(body))), text: await wrap(() => s.planText(draftOf(body))) });
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { errand: await wrap(() => s.start(draftOf(body), { by: 'page' })) });
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
    if (!c && method === 'GET') {
      const e = s.get(id);
      if (!e) throw new HttpError(404, T('Errand not found.'));
      return send(res, 200, { errand: e });
    }
    if (!c && method === 'DELETE') {
      if (!s.remove(id)) throw new HttpError(404, T('Errand not found.'));
      return send(res, 200, { ok: true });
    }
    if (!c && method === 'PATCH') {
      const body = await readJson(req);
      return send(res, 200, {
        errand: await wrap(() =>
          s.update(
            id,
            {
              ...(typeof body.note === 'string' ? { note: body.note } : {}),
              ...(body.deadline !== undefined ? { deadline: typeof body.deadline === 'string' ? body.deadline : null } : {}),
              ...(body.budget !== undefined ? { budget: typeof body.budget === 'number' ? body.budget : null } : {}),
              ...(typeof body.sendWithoutAsking === 'boolean' ? { sendWithoutAsking: body.sendWithoutAsking } : {}),
              ...(body.facts && typeof body.facts === 'object' ? { facts: body.facts as Record<string, unknown> } : {}),
            },
            { by: 'person' },
          ),
        ),
      });
    }
    if (c && method === 'POST') {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (c === 'start') return send(res, 200, { errand: await wrap(() => s.confirm(id)) });
      if (c === 'stop') return send(res, 200, { errand: await wrap(() => s.stop(id)) });
      if (c === 'skip') return send(res, 200, { errand: await wrap(() => s.skip(id)) });
      if (c === 'next') return send(res, 200, { errand: await wrap(() => s.advance(id)) });
      if (c === 'approve') {
        const x = body as Record<string, unknown>;
        return send(res, 200, { errand: await wrap(() => s.approve(id, { ...(typeof x.choice === 'string' ? { choice: x.choice } : {}), ...(typeof x.to === 'string' ? { to: x.to } : {}), ...(typeof x.note === 'string' ? { note: x.note } : {}), ...(typeof x.amount === 'number' ? { amount: x.amount } : {}) })) });
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
