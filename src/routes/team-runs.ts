// S8 (docs/AGENT_TEAMS.md): team runs, the owner's only. Household members, the demo and device
// tokens get 403. Every change is one audit row (the route group `team-runs` is audited in src/server.ts).
//   GET    /api/team-runs                 {runs, models, tools}
//   POST   /api/team-runs                 {goal, conversationId?, deliver?, format?} → {run} (proposed)
//   GET    /api/team-runs/:id             {run, live, tools}
//   PUT    /api/team-runs/:id/plan        {plan} → {run} (only while proposed)
//   POST   /api/team-runs/:id/approve     the one plan approval → {run}
//   POST   /api/team-runs/:id/pause|resume|stop
//   POST   /api/team-runs/:id/decide      {approved, skip?: action numbers} the one final approval → {run}
// U3.16 team recipes (the plan's shape, {job} for the job text; never results or secrets):
//   POST   /api/team-runs/:id/recipe      {name, description?} → {recipe} (a finished run only)
//   GET    /api/team-runs/recipes         {recipes}
//   PUT    /api/team-runs/recipes/:rid    {name?, description?, plan?} → {recipe}
//   DELETE /api/team-runs/recipes/:rid
//   POST   /api/team-runs/recipes/:rid/duplicate → {recipe}
//   GET    /api/team-runs/recipes/:rid/export   the shareable JSON
//   POST   /api/team-runs/recipes/import  {recipe: <the JSON>} → {recipe}
//   POST   /api/team-runs/recipes/:rid/run {goal, conversationId?} → {run} (proposed: still approved once)
import { HttpError, readJson, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { onThisComputer } from '../private-local.ts';
import { TeamRecipeError } from '../team-recipes.ts';
import { teamRunTools, TeamRunError } from '../team-runs.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createTeamRunRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof TeamRunError || err instanceof TeamRecipeError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'team-runs') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.teamRuns) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const tr = app.teamRuns;
    const priv = (convId: string) => Boolean(app.store.getConversation(convId)?.private) || privateLocalOn();
    if (!b) {
      if (method === 'GET') {
        const s = app.settings.get();
        const models = (s.providers ?? []).flatMap((p) => {
          const m = p.id === s.defaultProviderId ? (s.defaultModel ?? (p as { defaultModel?: string }).defaultModel) : (p as { defaultModel?: string }).defaultModel;
          return m ? [{ providerId: p.id, model: m, label: `${p.label} · ${m}`, local: onThisComputer(p, m) }] : [];
        });
        return send(res, 200, { runs: tr.list(20), live: tr.live(), models, tools: teamRunTools(app, privateLocalOn()), recipes: tr.recipes.list() });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        let convId = typeof body.conversationId === 'string' ? body.conversationId : '';
        if (!convId) convId = app.store.createConversation({ title: `Team: ${String(body.goal ?? '').replace(/\s+/g, ' ').slice(0, 50)}` }).id;
        const deliver = body.deliver === 'document' || body.deliver === 'message' ? body.deliver : undefined;
        return send(res, 200, { run: await wrap(() => tr.propose(convId, String(body.goal ?? ''), { ...(deliver ? { deliver } : {}), ...(typeof body.format === 'string' ? { format: body.format } : {}) })) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'recipes') {
      const rs = tr.recipes;
      if (!c) {
        if (method === 'GET') return send(res, 200, { recipes: rs.list() });
        throw new HttpError(405, 'Method not allowed');
      }
      if (c === 'import' && !d && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { recipe: await wrap(() => rs.importJson(body.recipe)) });
      }
      const rid = Number(c);
      if (!rid || !rs.get(rid)) {
        if (method !== 'GET') await readJson(req).catch(() => undefined);
        throw new HttpError(404, 'No such team recipe.');
      }
      if (!d && method === 'PUT') {
        const body = await readJson(req);
        return send(res, 200, { recipe: await wrap(() => rs.update(rid, { name: body.name, description: body.description, plan: body.plan })) });
      }
      if (!d && method === 'DELETE') return send(res, 200, { ok: rs.remove(rid) });
      if (d === 'export' && method === 'GET') return send(res, 200, rs.exportJson(rid));
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (d === 'duplicate') return send(res, 200, { recipe: await wrap(() => rs.duplicate(rid)) });
      if (d === 'run') {
        const goal = String(body.goal ?? '');
        let convId = typeof body.conversationId === 'string' ? body.conversationId : '';
        if (!convId) convId = app.store.createConversation({ title: `Team: ${goal.replace(/\s+/g, ' ').slice(0, 50)}` }).id;
        return send(res, 200, { run: await wrap(() => tr.propose(convId, goal, { recipe: rid })) });
      }
      throw new HttpError(404, 'Not found');
    }
    const id = Number(b);
    const run = tr.get(id);
    if (!id || !run) throw new HttpError(404, 'No such team run.');
    if (!c && method === 'GET') return send(res, 200, { run, live: tr.live().includes(id), tools: teamRunTools(app, priv(run.conversationId)) });
    if (c === 'plan' && method === 'PUT') {
      const body = await readJson(req);
      return send(res, 200, { run: await wrap(() => tr.edit(id, body.plan)) });
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
    if (c === 'approve') return send(res, 200, { run: await wrap(() => tr.approve(id)) });
    if (c === 'pause') return send(res, 200, { ok: tr.pause(id) });
    if (c === 'resume') return send(res, 200, { ok: tr.resume(id) });
    if (c === 'stop') return send(res, 200, { ok: tr.stop(id) });
    if (c === 'recipe') return send(res, 200, { recipe: await wrap(() => tr.recipes.saveFromRun(id, { name: body.name, description: body.description })) });
    if (c === 'decide') return send(res, 200, { run: await wrap(() => tr.decide(id, { approved: body.approved === true, skip: Array.isArray(body.skip) ? body.skip.map(Number) : [] })) });
    throw new HttpError(404, 'Not found');
  };
}
