// R2 (src/get-started.ts, docs/GETTING_STARTED.md): the guided setup, the sample space and the
// starter packs. Each person's own (a household member's live in their own data folder); the demo
// server answers none of it (not in DEMO_READS / DEMO_WRITES of src/server.ts).
//   GET    /api/get-started                 {guide, samples, packs}
//   POST   /api/get-started/step            {id, action: skip|resume|go}
//   POST   /api/get-started/mark            {offered?, finished?}
//   POST   /api/get-started/restart         every skip forgotten, back at step 1
//   POST   /api/get-started/samples         load the examples into the sample space
//   DELETE /api/get-started/samples         remove every example
//   PUT    /api/get-started/pack            {id: household|business|sales|student|null}
import { HttpError, readJson, send } from '../http.ts';
import { localDate } from '../memory-worker.ts';
import { applyPack, guideView, isPack, isStep, loadSamples, markGuide, PACK_DEFS, PACKS, readProgress, readSamples, removeSamples, restartGuide, revertPack, stepAction, type Connected } from '../get-started.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createGetStartedRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, opts } = ctx;
  const member = Boolean(opts.member);
  const connected = (): Connected => ({
    devices: auth.devices().map((d) => d.label),
    pushDevices: (app.push?.list().length ?? 0) + (app.push?.apns?.devices().length ?? 0),
    member,
  });
  const packs = () => {
    const p = readProgress(app).pack;
    return {
      current: p?.id ?? null,
      automations: p?.automations ?? [],
      list: PACKS.map((id) => ({ id, tryCards: PACK_DEFS[id].tryCards, sections: PACK_DEFS[id].sections, routines: PACK_DEFS[id].routines.map((r) => r.name ?? '') })),
    };
  };
  const view = () => ({ guide: guideView(app, connected()), samples: readSamples(app), packs: packs() });
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'get-started') return NEXT;
    if (opts.demo) throw new HttpError(404, 'Not found');
    if (!b && method === 'GET') return send(res, 200, view());
    if (b === 'step' && method === 'POST') {
      const body = await readJson(req);
      const action = String(body.action ?? '');
      if (!isStep(body.id) || !['skip', 'resume', 'go'].includes(action)) throw new HttpError(400, 'Pick a step and what to do with it.');
      try {
        stepAction(app, body.id, action as 'skip', member);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      return send(res, 200, view());
    }
    if (b === 'mark' && method === 'POST') {
      const body = await readJson(req);
      markGuide(app, { ...(typeof body.offered === 'boolean' ? { offered: body.offered } : {}), ...(typeof body.finished === 'boolean' ? { finished: body.finished } : {}) });
      return send(res, 200, view());
    }
    if (b === 'restart' && method === 'POST') {
      await readJson(req).catch(() => undefined);
      restartGuide(app);
      return send(res, 200, view());
    }
    if (b === 'samples' && (method === 'POST' || method === 'DELETE')) {
      await readJson(req).catch(() => undefined);
      if (method === 'POST') loadSamples(app, localDate(app.now().toISOString(), app.settings.get().timeZone));
      else removeSamples(app);
      app.events?.publish({ type: 'today', part: 'samples' });
      return send(res, 200, view());
    }
    if (b === 'pack' && method === 'PUT') {
      const body = await readJson(req);
      if (body.id !== null && !isPack(body.id)) throw new HttpError(400, 'Pick household, small business, sales or student (or none).');
      const result = body.id === null ? revertPack(app) : applyPack(app, body.id);
      return send(res, 200, { ...view(), result });
    }
    throw new HttpError(404, 'Not found');
  };
}
