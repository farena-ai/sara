// S8 (docs/AGENT_TEAMS.md): team runs, the owner's only. Household members, the demo and device
// tokens get 403. Every change is one audit row (the route group `team-runs` is audited in src/server.ts).
//   GET    /api/team-runs                 {runs, models, tools}
//   POST   /api/team-runs                 {goal, conversationId?, deliver?, format?} → {run} (proposed)
//   GET    /api/team-runs/:id             {run, live, tools}
//   PUT    /api/team-runs/:id/plan        {plan} → {run} (only while proposed)
//   POST   /api/team-runs/:id/approve     the one plan approval → {run}
//   POST   /api/team-runs/:id/pause|resume|stop
//   POST   /api/team-runs/:id/decide      {approved, skip?: action numbers} the one final approval → {run}
import { HttpError, readJson, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { onThisComputer } from '../private-local.ts';
import { teamRunTools, TeamRunError } from '../team-runs.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createTeamRunRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof TeamRunError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
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
        return send(res, 200, { runs: tr.list(20), live: tr.live(), models, tools: teamRunTools(app, privateLocalOn()) });
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
    if (c === 'decide') return send(res, 200, { run: await wrap(() => tr.decide(id, { approved: body.approved === true, skip: Array.isArray(body.skip) ? body.skip.map(Number) : [] })) });
    throw new HttpError(404, 'Not found');
  };
}
