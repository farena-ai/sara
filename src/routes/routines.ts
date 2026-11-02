// Phase 121 part A (docs/design/BEGIN.md §4.15): the routines gallery, the space's own. Members get
// the briefing, the weekly review, reminders and leave-by in their own space (403 for the rest);
// never on the demo. Turn on is the owner's tap on a preview (409 when the preview is stale, 412
// when a hard need is missing). Nothing here calls a model except *Run now* on the briefing, the
// review or a loop routine (its cost is on the button).
//   GET    /api/routines                         {catalog, mine}
//   POST   /api/routines/:id/preview             {answers} → the preview (400 with the field)
//   POST   /api/routines/:id/on                  {answers, sig} → {routine}
//   POST   /api/routines/mine/:rid/off · /on · /run-now
//   DELETE /api/routines/mine/:rid
//   POST   /api/routines/elsewhere/:kind/:key/off
import { geocode } from '../briefing.ts';
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { RoutineError, routinesFor, ROUTINES_DIR } from '../routines.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createRoutineRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const wrap = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof RoutineError) throw new HttpError(err.status, err.message, err.field ? { field: err.field } : undefined);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'routines') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const rs = routinesFor(app, ROUTINES_DIR);
    if (!b && method === 'GET') {
      const catalog = rs.catalog().map((r) => {
        const answers = (() => {
          try {
            return rs.clean(r, {});
          } catch {
            return {};
          }
        })();
        const T = (x: string) => trOwner(x, app.settings.get());
        const fields = r.fields.map((f) => ({ ...f, label: T(f.label), ...(f.kind === 'text' && typeof f.default === 'string' ? { default: T(f.default) } : {}), ...(f.choices ? { choices: f.choices.map((ch) => ({ ...ch, label: T(ch.label) })) } : {}) }));
        const defaults = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, typeof v === 'string' && r.fields.some((f) => f.key === k && f.kind === 'text') ? T(v) : v]));
        return { id: r.id, title: T(r.title), pitch: T(r.pitch), icon: r.icon ?? '', category: r.category, engine: r.engine, fields, defaults, needs: rs.needs(r), cost: rs.costLine(r, answers), when: rs.whenWords(r, answers), tools: r.tools ?? [], source: r.source ?? 'built-in', blocked: r.engine === 'loop' && (ctx.opts.member || !app.loops) ? 'member' : undefined };
      });
      return send(res, 200, { catalog, mine: rs.mine(), suggest: app.settings.get().routines?.suggest !== false });
    }
    if (b === 'mine' && c) {
      const rid = Number(c);
      if (method === 'DELETE' && !d) {
        await wrap(() => rs.remove(rid));
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && d && !e) {
        await readJson(req).catch(() => ({}));
        if (d === 'off') return send(res, 200, { routine: await wrap(() => rs.off(rid)) });
        if (d === 'on') return send(res, 200, { routine: await wrap(() => rs.on(rid)) });
        if (d === 'run-now') return send(res, 200, await wrap(() => rs.runNow(rid)));
      }
      throw new HttpError(404, 'Not found');
    }
    if (b === 'elsewhere' && c && d && e === 'off' && method === 'POST') {
      await readJson(req).catch(() => ({}));
      await wrap(() => rs.elsewhereOff(c, decodeURIComponent(d)));
      return send(res, 200, { ok: true });
    }
    if (b && (c === 'preview' || c === 'on') && !d && method === 'POST') {
      const body = await readJson(req);
      const answers = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>;
      if (c === 'preview') return send(res, 200, await wrap(() => rs.preview(b, answers)));
      return send(res, 200, { routine: await wrap(() => rs.turnOn(b, answers, body.sig, { geocode: (n) => geocode(n) })) });
    }
    throw new HttpError(404, 'Not found');
  };
}
