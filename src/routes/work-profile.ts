// EC26 (docs/ops/EC26_DESIGN.md): Settings → Her → At work.
//   GET  /api/work-profile                       the profile, its choices and whether the admin pinned it
//   PUT  /api/work-profile                       known keys only; turning it off under the pin is 409
//   GET  /api/work-profile/memories?space=&q=    her notes of one space (newest 50, or matches)
//   POST /api/work-profile/copy {id}             a copy of one note in the other space (the original stays)
// Owner only: members and the demo get 404.
import { HttpError, readJson, send } from '../http.ts';
import { copyToOtherSpace, mergeWorkProfile, spaceView, WORK_CHANNELS, WORK_TONES, workProfile, type Space } from '../work-profile.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createWorkProfileRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'work-profile') return NEXT;
    if (ctx.opts.demo || ctx.opts.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (!b) {
      if (method === 'PUT') mergeWorkProfile(app, await readJson(req));
      else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return send(res, 200, { profile: workProfile(app), choices: { channels: WORK_CHANNELS, tones: WORK_TONES } });
    }
    if (b === 'memories' && method === 'GET') {
      const qs = new URL(req.url ?? '/', 'http://x').searchParams;
      const space: Space = qs.get('space') === 'work' ? 'work' : 'personal';
      const q = (qs.get('q') ?? '').trim().slice(0, 200);
      const v = spaceView(app);
      const list = (app.memory?.list({ ...(q ? { q } : {}), limit: 500 }) ?? []).filter((m) => !m.supersededBy && m.kind !== 'lesson' && v.ofMemory(m) === space).slice(0, 50);
      return send(res, 200, { space, memories: list.map((m) => ({ id: m.id, kind: m.kind, content: m.content, happenedOn: m.happenedOn, copied: m.space !== null && m.space !== undefined })) });
    }
    if (b === 'copy' && method === 'POST') {
      const body = (await readJson(req)) as { id?: unknown };
      const id = Number(body?.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Pick a note to copy.');
      const r = copyToOtherSpace(app, id);
      return send(res, 200, { id: r.memory.id, space: r.space });
    }
    throw new HttpError(404, 'Not found');
  };
}
