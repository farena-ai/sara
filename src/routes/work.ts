// N7 (docs/WORK_AND_TEAMS.md): Today's "Clients and hours" tile, in each person's own space (never the demo).
//   GET  /api/work               {worktime, shared}   (what the Today tiles show)
//   POST /api/work/timer/stop    stops the running timer → {entry, worktime}
import { HttpError, readJson, send } from '../http.ts';
import { todayChanged } from '../today.ts';
import { timeOf, workTile } from '../tools/work.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createWorkRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'work') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Not on the demo.');
    }
    if (b === undefined && method === 'GET') {
      const sb = app.sharedBoards;
      return send(res, 200, { worktime: workTile(app) ?? null, shared: sb ? sb.store.sharedWith(sb.person) : null });
    }
    if (b === 'timer' && c === 'stop' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      const ts = timeOf(app);
      const run = ts.running();
      if (!run) throw new HttpError(409, 'No timer is running.');
      if (run.reminderId) app.planner?.cancelReminder(run.reminderId);
      const entry = ts.stop();
      todayChanged(app, 'worktime');
      return send(res, 200, { entry, worktime: workTile(app) ?? null });
    }
    throw new HttpError(404, 'Not found');
  };
}
