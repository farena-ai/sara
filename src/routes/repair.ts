// ROADMAP_T T1/T2 (docs/SELF_REPAIR.md): the owner's self-repair API. Owner only: household members, kid mode
// and the demo get 403. Every POST/PUT is in the audit trail (AUDITED 'repair'), and the engine writes its own
// rows for each action.
//   GET  /api/repair                         {problems, checkedAt, runs, settings}
//   POST /api/repair/check                   {deep?} → {problems}       look now (deep: the doctor and the self-test too)
//   POST /api/repair/fix                     {problem: id | 'everything'} → {runs}   the person's click is the OK
//   POST /api/repair/decline                 {problem} → {run}          a growth idea: not now (quiet for two weeks)
//   POST /api/repair/learn                   {what, kind?: skill|automation|addon, body?, automation?} → {run}
//   POST /api/repair/runs/:id/undo           → {run}
//   PUT  /api/repair/settings                {permission?: auto1|ask, full?: boolean} → {settings}
import { runDoctor } from '../doctor.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { FULL_HOURS, fullOn, REPAIR_PERMISSIONS, repairSettings, RepairRefused, type Repair } from '../repair.ts';
import { repairOf } from '../repair-env.ts';
import { fixRecipesOf } from '../fix-recipes.ts';
import { runSelfTest } from '../self-test.ts';
import { selfTestDepsOf } from './self-test.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createRepairRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const engine = (): Repair | undefined => {
    if (ctx.opts.demo || ctx.opts.member || app.member) return undefined;
    return repairOf(app, {
      version: ctx.info?.version ?? '',
      doctor: () => runDoctor({ dataDir: ctx.rootDir, settings: app.settings, vault: app.vault, subscriptions: app.subscriptions, now: app.now(), sandbox: app.sandbox, tools: app.tools, providerTimeoutS: 10 }),
      selfTest: () => runSelfTest(selfTestDepsOf(ctx), {}),
    });
  };
  const view = (rep: Repair) => {
    const s = app.settings.get();
    const r = repairSettings(s);
    return { problems: rep.problems(), checkedAt: rep.checkedAt(), runs: rep.runs(50), settings: { ...r, fullOn: fullOn(s, app.now()) } };
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'repair') return NEXT;
    const rep = engine();
    if (!rep) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const body = method === 'GET' ? {} : await readJson(req, 64 * 1024);
    try {
      if (!b && method === 'GET') {
        if (!rep.checkedAt()) await rep.detect();
        return send(res, 200, view(rep));
      }
      if (b === 'check' && method === 'POST') return (await rep.detect({ deep: body.deep === true }), send(res, 200, view(rep)));
      if (b === 'fix' && method === 'POST') {
        const problem = String(body.problem ?? '');
        if (!problem) throw new HttpError(400, en('Pick a problem first.'));
        const runs = await rep.fix(problem, { by: 'owner' });
        app.events?.publish({ type: 'repair' });
        return send(res, 200, { ...view(rep), done: runs });
      }
      if (b === 'decline' && method === 'POST') return (rep.decline(String(body.problem ?? ''), 'owner'), send(res, 200, view(rep)));
      if (b === 'learn' && method === 'POST') {
        const run = await rep.learn({ what: String(body.what ?? ''), kind: String(body.kind ?? 'skill'), body: typeof body.body === 'string' ? body.body : undefined, automation: body.automation && typeof body.automation === 'object' ? (body.automation as Record<string, unknown>) : undefined }, 'owner');
        return send(res, 200, { ...view(rep), done: [run] });
      }
      if (b === 'runs' && c && d === 'undo' && method === 'POST') {
        await rep.undo(Number(c));
        app.events?.publish({ type: 'repair' });
        return send(res, 200, view(rep));
      }
      if (b === 'settings' && method === 'PUT') {
        const cur = repairSettings(app.settings.get());
        const next = { ...cur };
        if (body.permission !== undefined) {
          if (!REPAIR_PERMISSIONS.includes(body.permission as never)) throw new HttpError(400, en('Pick one of the choices.'));
          next.permission = body.permission as never;
        }
        if (body.full === true) next.fullUntil = new Date(app.now().getTime() + FULL_HOURS * 3_600_000).toISOString();
        if (body.full === false) next.fullUntil = null;
        // U3.17 "Share fixes that worked": off by default; only linked friends (direct links) can be picked.
        if (body.share !== undefined) next.share = body.share === true;
        if (body.shareLinks !== undefined) {
          const known = new Set((app.messages?.links() ?? []).filter((l) => l.kind === 'direct').map((l) => l.id));
          if (!Array.isArray(body.shareLinks) || !body.shareLinks.every((x) => typeof x === 'string' && known.has(x))) throw new HttpError(400, en('Pick linked friends from the list.'));
          next.shareLinks = [...new Set(body.shareLinks as string[])];
        }
        fixRecipesOf(app);
        // Only the person changes this, here; the engine never writes repair.* (src/repair.ts NEVER).
        app.settings.update({ repair: next });
        return send(res, 200, view(rep));
      }
    } catch (err) {
      if (err instanceof RepairRefused) throw new HttpError(409, err.message);
      throw err;
    }
    throw new HttpError(404, 'Not found.');
  };
}
