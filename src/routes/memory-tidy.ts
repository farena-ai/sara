// EC13 (docs/ops/EC1213_DESIGN.md): the overnight memory tidy of this space. The owner, or a
// household member in their own space (each tidies only their own notes); the demo gets 403. Every
// change is one audit row (the route group `memory-tidy` is audited in src/server.ts).
//   GET  /api/memory-tidy                         {settings, pinned, local, runs}
//   PUT  /api/memory-tidy                         {on, model: 'local' | 'any'} → {settings}
//   POST /api/memory-tidy/run                     Tidy now → {run}
//   GET  /api/memory-tidy/runs/:id                {run (with its changes)}
//   POST /api/memory-tidy/changes/:id/undo        Undo one change
//   POST /api/memory-tidy/changes/:id/newer|older|both   answer a proposal
import { HttpError, readJson, send } from '../http.ts';
import { TidyError } from '../memory-tidy.ts';
import { policy } from '../policy-profile.ts';
import { onThisComputer } from '../private-local.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMemoryTidyRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof TidyError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'memory-tidy') return NEXT;
    if (ctx.opts.demo || !app.memoryTidy) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const mt = app.memoryTidy;
    if (!b) {
      if (method === 'GET') {
        const local = (app.settings.get().providers ?? []).some((p) => onThisComputer(p));
        return send(res, 200, { settings: mt.settings(), pinned: policy().pins.memoryTidy ?? null, local, runs: mt.runs(5) });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        return send(res, 200, { settings: await wrap(() => mt.setSettings(body)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'run' && !c && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { run: await wrap(() => mt.run('now')) });
    }
    if (b === 'runs' && c && !d && method === 'GET') {
      const run = mt.view(Number(c));
      if (!run) throw new HttpError(404, 'Not found');
      return send(res, 200, { run });
    }
    if (b === 'changes' && c && d && method === 'POST') {
      await readJson(req).catch(() => ({}));
      const id = Number(c);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
      if (d === 'undo') await wrap(() => mt.undo(id));
      else if (d === 'newer' || d === 'older' || d === 'both') await wrap(() => mt.decide(id, d));
      else throw new HttpError(404, 'Not found');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
