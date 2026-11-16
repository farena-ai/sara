// S3 (docs/GOALS.md "Goals over days"): the Goals page, each person's own (a household member's live
// in their own space). Never the demo. Only here (and the Today tile) is a proposed new plan used.
//   GET    /api/goal-plans                      {goals, proposals}
//   POST   /api/goal-plans/preview              {title, due?, milestones?} → {plan, text}
//   POST   /api/goal-plans                      {title, due?, milestones?} → {goal}
//   GET    /api/goal-plans/:id                  {goal}
//   PATCH  /api/goal-plans/:id                  {title?, due?, note?, done?, undone?, skip?, addMilestone?, milestoneDue?}
//   POST   /api/goal-plans/:id/accept · /dismiss · /pause · /resume · /stop
//   DELETE /api/goal-plans/:id
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { GoalError, longGoalsFor, type GoalDraft, type MilestoneDraft } from '../long-goals.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createLongGoalRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof GoalError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  const draftOf = (b: Record<string, unknown>): GoalDraft => ({
    title: String(b.title ?? '').slice(0, 200),
    ...(typeof b.due === 'string' && b.due ? { due: b.due } : {}),
    ...(Array.isArray(b.milestones) ? { milestones: (b.milestones as MilestoneDraft[]).slice(0, 20) } : {}),
  });
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'goal-plans') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = longGoalsFor(app);
    const view = (g: ReturnType<typeof s.get>) => (g ? { ...g, progress: (({ next: _n, ...p }) => p)(s.progress(g)) } : g);
    if (!b && method === 'GET') {
      const goals = s.list();
      return send(res, 200, { goals: goals.map(view), proposals: goals.filter((g) => g.proposal).length });
    }
    if (b === 'preview' && !c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { plan: await wrap(() => s.plan(draftOf(body))), text: await wrap(() => s.planText(draftOf(body))) });
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { goal: view(await wrap(() => s.create(draftOf(body), { by: 'page' }))) });
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
    if (!c && method === 'GET') {
      const g = s.get(id);
      if (!g) throw new HttpError(404, T('Goal not found.'));
      return send(res, 200, { goal: view(g) });
    }
    if (!c && method === 'DELETE') {
      if (!s.remove(id)) throw new HttpError(404, T('Goal not found.'));
      return send(res, 200, { ok: true });
    }
    if (!c && method === 'PATCH') {
      const body = await readJson(req);
      const md = body.milestoneDue && typeof body.milestoneDue === 'object' ? (body.milestoneDue as Record<string, unknown>) : undefined;
      return send(res, 200, {
        goal: view(
          await wrap(() =>
            s.update(
              id,
              {
                ...(typeof body.title === 'string' ? { title: body.title } : {}),
                ...(body.due !== undefined ? { due: typeof body.due === 'string' ? body.due : null } : {}),
                ...(typeof body.note === 'string' ? { note: body.note } : {}),
                ...(int(body.done) !== undefined ? { done: int(body.done)! } : {}),
                ...(int(body.undone) !== undefined ? { undone: int(body.undone)! } : {}),
                ...(int(body.skip) !== undefined ? { skip: int(body.skip)! } : {}),
                ...(body.addMilestone && typeof body.addMilestone === 'object' ? { addMilestone: body.addMilestone as MilestoneDraft } : {}),
                ...(md && int(md.index) !== undefined ? { milestoneDue: { index: int(md.index)!, due: typeof md.due === 'string' ? md.due : null } } : {}),
              },
              { by: 'person' },
            ),
          ),
        ),
      });
    }
    if (c && method === 'POST') {
      await readJson(req).catch(() => ({}));
      if (c === 'accept') return send(res, 200, { goal: view(await wrap(() => s.accept(id, { by: 'person' }))) });
      if (c === 'dismiss') return send(res, 200, { goal: view(await wrap(() => s.dismiss(id))) });
      if (c === 'pause') return send(res, 200, { goal: view(await wrap(() => s.pause(id))) });
      if (c === 'resume') return send(res, 200, { goal: view(await wrap(() => s.resume(id))) });
      if (c === 'stop') return send(res, 200, { goal: view(await wrap(() => s.stop(id))) });
    }
    throw new HttpError(404, 'Not found');
  };
}
