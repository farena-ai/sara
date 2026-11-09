// C10 (docs/ops/C10_DESIGN.md): workers that stay, the owner's only. Household members, the demo and
// device tokens get 403. Every change is one audit row (the route group `workers` is audited in
// src/server.ts; import, export, replay and drop also write their own).
//   GET    /api/workers                       {workers (each with queue counts, used today, needs you), failed, alerts, helpers, groups, crews, pinned}
//   POST   /api/workers                       {name, character, helper, toolGroups, skills, dailyTokens, timeLimitMin, maxAttempts, leadId} or {fromCrew} → {worker}
//   PATCH  /api/workers/:id                   the same fields, and state → {worker}
//   DELETE /api/workers/:id                   forget it (its thread and finished jobs stay)
//   POST   /api/workers/:id/stop              pause it and stop its running job
//   GET    /api/workers/:id/jobs              {jobs}
//   POST   /api/workers/:id/jobs              {title, input} → {job}
//   GET    /api/workers/:id/export?memories=1 the bundle JSON (a download)
//   POST   /api/workers/import/preview        {bundle} → {preview}
//   POST   /api/workers/import                {bundle, confirm: true} → {workers}
//   POST   /api/workers/jobs/:jid/replay      → {job}
//   POST   /api/workers/jobs/:jid/drop        → {ok}
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { policy } from '../policy-profile.ts';
import { teamHelpers } from '../team.ts';
import { TOOL_GROUPS, WorkerError } from '../workers.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createWorkerRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof WorkerError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'workers') return NEXT;
    if (ctx.opts.demo || ctx.opts.member || !app.workers) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    const wk = app.workers;
    if (!b) {
      if (method === 'GET') {
        const workers = wk.list().map((w) => {
          const jobs = wk.jobs(w.id, 50);
          return { ...w, queued: jobs.filter((j) => j.status === 'queued').length, running: jobs.find((j) => j.status === 'running') ?? null, last: jobs.find((j) => j.status === 'done') ?? null, usedToday: wk.usedToday(w.id), needsYou: wk.needsYou(w.id) ?? null };
        });
        const names = new Map(wk.list().map((w) => [w.id, w.name]));
        const failed = wk.failed().map((j) => ({ ...j, worker: names.get(j.workerId) ?? '' }));
        const helpers = teamHelpers(app, { workers: false }).map((h) => ({ id: h.id, name: h.name, emoji: h.emoji, role: h.role }));
        const crews = (app.crews?.list() ?? []).map((x) => ({ id: x.id, name: x.name, members: x.members }));
        return send(res, 200, { workers, failed, alerts: wk.alerts(20), helpers, groups: Object.keys(TOOL_GROUPS).map((id) => ({ id, tools: TOOL_GROUPS[id] })), crews, pinned: policy().pins.crews === 'off' });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { worker: wrap(() => wk.create(body)) });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'import' && method === 'POST') {
      const body = await readJson(req);
      if (c === 'preview') return send(res, 200, { preview: wrap(() => wk.previewImport(body.bundle)) });
      if (!c) return send(res, 200, { workers: wrap(() => wk.importBundle(body.bundle, { confirm: body.confirm === true })) });
      throw new HttpError(404, 'Not found');
    }
    if (b === 'jobs' && c && method === 'POST') {
      await readJson(req).catch(() => ({}));
      const jid = Number(c);
      if (d === 'replay') return send(res, 200, { job: wrap(() => wk.replay(jid)) });
      if (d === 'drop') {
        if (!wk.drop(jid)) throw new HttpError(404, 'Not found');
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Not found');
    }
    const id = Number(b);
    if (!Number.isInteger(id) || id <= 0 || !wk.get(id)) throw new HttpError(404, 'Not found');
    if (!c) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, { worker: wrap(() => wk.patch(id, body)) });
      }
      if (method === 'DELETE') {
        wk.remove(id);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'stop' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      wk.stop(id);
      return send(res, 200, { worker: wk.get(id) });
    }
    if (c === 'jobs') {
      if (method === 'GET') return send(res, 200, { jobs: wk.jobs(id) });
      if (method === 'POST') {
        const body = await readJson(req);
        const job = wrap(() => wk.enqueue(id, body));
        wk.tick();
        return send(res, 200, { job: wk.job(job.id) });
      }
    }
    if (c === 'export' && method === 'GET') {
      const bundle = wrap(() => wk.exportBundle(id, { memories: new URL(req.url ?? '/', 'http://x').searchParams.get('memories') === '1' }));
      const body = Buffer.from(JSON.stringify(bundle, null, 2));
      const file = `${bundle.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'worker'}.sara-worker.json`;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${file}"`, 'content-length': body.length, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(body);
      return;
    }
    throw new HttpError(404, 'Not found');
  };
}
