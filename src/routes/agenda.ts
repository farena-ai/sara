// Phase 103 (ST8, docs/design/STAPLES.md §11, docs/AGENDA.md): Planner → Her plans, Today's tile and
// the big off switch. For the owner and household members, each in their own space (the companion's
// own database): the owner's routes never read a member's plans. Never on the demo (not in
// DEMO_READS / DEMO_WRITES), never reached by /v1, MCP, A2A keys or webhooks.
//   GET    /api/agenda                      settings, today's count and budget, plans, goals, history
//   PUT    /api/agenda                      { enabled, goals, followUps, research, budgetTokens, budgetUsd, shared: { maxPerDay, quietStart, quietEnd, minGapHours } }
//   POST   /api/agenda/off                  the off switch: everything stops at once (planned items pause)
//   POST   /api/agenda/tick                 her planning tick now (the same caps, quiet hours and budget)
//   POST   /api/agenda/clear                Clear her plans (planned items go, goals are dropped)
//   POST   /api/agenda/items                { what, dueAt } a plan of his
//   PUT    /api/agenda/items/:id            { what?, dueAt?, cancel?, allow? } Edit time / Change what / Cancel / the research OK
//   POST   /api/agenda/goals                { title, checkEvery?, endsOn? } a goal of his
//   PUT    /api/agenda/goals/:id            { title?, status?, checkEvery?, endsOn? } Pause / Done / Resume
//   POST   /api/agenda/goals/:id/decide     { decision: use | not-now | never, title?, checkEvery?, endsOn? } a proposal card
import { CHECK_EVERY, type CheckEvery } from '../agenda.ts';
import { HttpError, readJson, send } from '../http.ts';
import { proactiveSettings } from '../life.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const checkEvery = (v: unknown): CheckEvery | undefined => ((CHECK_EVERY as readonly string[]).includes(String(v)) ? (v as CheckEvery) : undefined);
const dayOrNull = (v: unknown): string | null | undefined => (v === undefined ? undefined : v === null || v === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined);

export function createAgendaRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (!(a === 'agenda')) return NEXT;
    const ag = app.agenda;
    if (!ag || ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Her plans are not available here.');
    }
    const title = (id: string | null) => (id ? (app.store.getConversation(id)?.title ?? null) : null);
    const view = () => {
      const v = ag.view();
      const src = <T extends { sourceConversation: string | null; sourceMessage: number | null }>(x: T) => ({ ...x, source: x.sourceConversation && x.sourceMessage ? { conversationId: x.sourceConversation, messageId: x.sourceMessage, title: title(x.sourceConversation) } : null });
      return { ...v, items: v.items.map(src), history: v.history.map(src), goals: v.goals.map(src) };
    };

    if (!b && method === 'GET') return send(res, 200, view());
    if (!b && method === 'PUT') {
      const body = await readJson(req);
      const sh = body.shared as Record<string, unknown> | undefined;
      if (sh && typeof sh === 'object') {
        // The messages a day, quiet hours and minimum gap are her proactive settings: shared with her plans.
        const cur = proactiveSettings(app);
        const hour = (x: unknown, dflt: number) => (x === undefined ? dflt : Math.min(23, Math.max(0, Math.round(Number(x)))));
        app.settings.update({
          proactive: {
            ...cur,
            maxPerDay: sh.maxPerDay === undefined ? cur.maxPerDay : Math.min(10, Math.max(0, Math.round(Number(sh.maxPerDay) || 0))),
            quietStart: hour(sh.quietStart, cur.quietStart),
            quietEnd: hour(sh.quietEnd, cur.quietEnd),
            minGapHours: sh.minGapHours === undefined ? cur.minGapHours : Math.min(168, Math.max(1, Number(sh.minGapHours) || cur.minGapHours)),
          },
        });
      }
      const patch: Record<string, unknown> = {};
      for (const k of ['enabled', 'goals', 'followUps', 'research', 'budgetTokens', 'budgetUsd']) if (body[k] !== undefined) patch[k] = body[k];
      ag.update(patch);
      return send(res, 200, view());
    }
    if (b === 'off' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      ag.stop();
      return send(res, 200, view());
    }
    if (b === 'tick' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const result = await ag.tick();
      return send(res, 200, { result, ...view() });
    }
    if (b === 'clear' && !c && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const cleared = ag.clearAll();
      return send(res, 200, { cleared, ...view() });
    }
    if (b === 'items') {
      if (!c && method === 'POST') {
        const body = await readJson(req);
        const what = String(body.what ?? '').trim();
        if (what.length < 2) throw new HttpError(400, 'Say what the plan is.');
        try {
          const item = ag.addItemByOwner({ what, dueAt: new Date(String(body.dueAt ?? '')), goalId: body.goalId === undefined || body.goalId === null ? null : Number(body.goalId) });
          return send(res, 201, { item, ...view() });
        } catch {
          throw new HttpError(400, 'Pick a time that is still to come.');
        }
      }
      const id = Number(c);
      if (c && !d && method === 'PUT' && Number.isInteger(id)) {
        const body = await readJson(req);
        let item;
        try {
          item = ag.editItem(id, {
            ...(body.what !== undefined ? { what: String(body.what) } : {}),
            ...(body.dueAt !== undefined ? { dueAt: new Date(String(body.dueAt)) } : {}),
            ...(body.cancel ? { cancel: true } : {}),
            ...(body.allow !== undefined ? { allow: Boolean(body.allow) } : {}),
          });
        } catch {
          throw new HttpError(400, 'Pick a time that is still to come.');
        }
        if (!item) throw new HttpError(404, 'Not found.');
        return send(res, 200, { item, ...view() });
      }
    }
    if (b === 'goals') {
      if (!c && method === 'POST') {
        const body = await readJson(req);
        const t = String(body.title ?? '').trim();
        if (t.length < 2) throw new HttpError(400, 'Give the goal a name.');
        const ends = dayOrNull(body.endsOn);
        const goal = ag.addGoalByOwner({ title: t, ...(checkEvery(body.checkEvery) ? { checkEvery: checkEvery(body.checkEvery)! } : {}), ...(ends !== undefined ? { endsOn: ends } : {}), ...(body.why ? { why: String(body.why).slice(0, 300) } : {}) });
        return send(res, 201, { goal, ...view() });
      }
      const id = Number(c);
      if (c && !d && method === 'PUT' && Number.isInteger(id)) {
        const body = await readJson(req);
        const st = ['active', 'paused', 'done', 'dropped'].includes(String(body.status)) ? (String(body.status) as 'active' | 'paused' | 'done' | 'dropped') : undefined;
        const ends = dayOrNull(body.endsOn);
        const goal = ag.updateGoal(id, { ...(body.title ? { title: String(body.title) } : {}), ...(st ? { status: st } : {}), ...(checkEvery(body.checkEvery) ? { checkEvery: checkEvery(body.checkEvery)! } : {}), ...(ends !== undefined ? { endsOn: ends } : {}) });
        if (!goal) throw new HttpError(404, 'Not found.');
        return send(res, 200, { goal, ...view() });
      }
      if (c && d === 'decide' && method === 'POST' && Number.isInteger(id)) {
        const body = await readJson(req);
        const dec = String(body.decision);
        if (dec !== 'use' && dec !== 'not-now' && dec !== 'never') throw new HttpError(400, 'Bad request');
        const ends = dayOrNull(body.endsOn);
        const goal = ag.decideGoal(id, dec, { ...(body.title ? { title: String(body.title).trim().slice(0, 160) } : {}), ...(checkEvery(body.checkEvery) ? { checkEvery: checkEvery(body.checkEvery)! } : {}), ...(ends !== undefined ? { endsOn: ends } : {}) });
        if (!goal) throw new HttpError(404, 'Not found.');
        return send(res, 200, { goal, ...view() });
      }
    }
    throw new HttpError(404, 'Not found.');
  };
}
