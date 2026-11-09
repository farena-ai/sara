// EC12 (docs/ops/EC1213_DESIGN.md): crews, the owner's only. Household members, the demo and
// device tokens get 403 (guests never get past sign-in). Every change is one audit row (the route
// group `crews` is audited in src/server.ts).
//   GET    /api/crews                    {crews (each with its last run), templates, helpers, telegram, pinned}
//   POST   /api/crews                    {name, brief, members, limits, schedule, mail, folder, alsoTo, template} → {crew}
//   PATCH  /api/crews/:id                the same fields, and state ('on' | 'paused') → {crew}
//   DELETE /api/crews/:id                forget the crew (its chat, board, runs and files stay)
//   POST   /api/crews/:id/run            Run now → {run}
//   GET    /api/crews/:id/runs           {runs}
//   POST   /api/crews/stop-all           {stopped, paused}
//   GET    /api/crews/runs/:rid          {run}
//   GET    /api/crews/runs/:rid/file     the run's deliverable (Markdown, as a download)
import { readFileSync } from 'node:fs';
import { CrewError } from '../crews.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { policy } from '../policy-profile.ts';
import { teamHelpers } from '../team.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createCrewRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof CrewError) throw new HttpError(err.status, err.message, err.params ? { params: err.params } : undefined);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'crews') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.crews) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const cr = app.crews;
    const id = Number(b);
    if (!b) {
      if (method === 'GET') {
        const crews = cr.list().map((x) => ({ ...x, last: cr.runs(x.id, 1)[0] ?? null }));
        const helpers = teamHelpers(app).map((h) => ({ id: h.id, name: h.name, emoji: h.emoji, role: h.role }));
        return send(res, 200, { crews, templates: cr.templates(), helpers, telegram: Boolean(app.bridges?.telegram?.ownerLinked()), pinned: policy().pins.crews === 'off' });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { crew: wrap(() => cr.create(body)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'stop-all' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, cr.stopAll());
    }
    if (b === 'runs' && c) {
      const run = cr.run_(Number(c));
      if (!run) throw new HttpError(404, 'Not found');
      if (!d && method === 'GET') return send(res, 200, { run });
      if (d === 'file' && method === 'GET') {
        const f = cr.file(run.id);
        if (!f) throw new HttpError(404, 'Not found');
        const body = readFileSync(f.path);
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${f.name}"`, 'content-length': body.length, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        res.end(body);
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
    if (!c) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, { crew: wrap(() => cr.patch(id, body)) });
      }
      if (method === 'DELETE') {
        if (!cr.get(id)) throw new HttpError(404, 'Not found');
        cr.remove(id);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'runs' && method === 'GET') {
      if (!cr.get(id)) throw new HttpError(404, 'Not found');
      return send(res, 200, { runs: cr.runs(id) });
    }
    if (c === 'run' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { run: wrap(() => cr.run(id, 'manual')) });
    }
    throw new HttpError(404, 'Not found');
  };
}
