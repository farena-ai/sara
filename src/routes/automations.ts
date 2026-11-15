// N2 (docs/AUTOMATIONS.md): Settings → You → Automations, each person's own (a household member's
// live in their own space; email and webhook triggers and the C4/E4 rows are the owner's). Never the
// demo. Keys: auto:<id> (an automation), trigger:<id>, live:<id>, product:<id>, file:<id>,
// routine:<rid>, elsewhere:<kind>:<key> (the existing rows, through their own stores).
//   GET    /api/automations                       {items, waiting, starters, tz}
//   POST   /api/automations/preview               {draft | words | starter} → the preview
//   POST   /api/automations/dry-run               {draft | words | starter} → {steps} (nothing is done)
//   POST   /api/automations                       {draft | words | starter} → {automation}
//   PATCH  /api/automations/:key                  {name?, trigger?} (automations only)
//   POST   /api/automations/:key/on · /off · /run · /dry-run
//   DELETE /api/automations/:key
//   GET    /api/automations/:key/history
//   POST   /api/automations/runs/:runId/allow · /decline
// R9 templates (src/automation-templates.ts):
//   GET    /api/automations/templates             {gallery}
//   POST   /api/automations/templates/read        {text} → {template, placeholders} (checked, scrubbed)
//   GET    /api/automations/:key/template         {template} (automations only; no personal data)
//   preview / dry-run / create also take {template, values} or {gallery, values}; create needs allow: true.
import { exportTemplate, fillTemplate, GALLERY, parseTemplate, TemplateError } from '../automation-templates.ts';
import { AutomationError, automationsFor, draftFromWords, STARTERS, type Draft } from '../automations.ts';
import { HttpError, readJson, send } from '../http.ts';
import { trOwner } from '../i18n.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createAutomationRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = async <R>(f: () => Promise<R> | R): Promise<R> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof AutomationError || err instanceof TemplateError) throw new HttpError(err.status, T(err.message));
      if (err instanceof HttpError) throw err;
      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) throw new HttpError(status, (err as Error).message);
      throw err;
    }
  };
  const draftOf = (body: Record<string, unknown>): Draft | Record<string, unknown> => {
    const values = body.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {};
    if (typeof body.gallery === 'string') {
      const g = GALLERY.find((x) => x.id === body.gallery);
      if (!g) throw new HttpError(404, T('Template not found.'));
      return { ...fillTemplate(g.template, values), name: T(g.name) };
    }
    if (body.template !== undefined) return fillTemplate(parseTemplate(body.template), values);
    const starter = STARTERS.find((s) => s.id === body.starter);
    if (starter) return { ...starter.draft, name: T(starter.name), ...(body.draft && typeof body.draft === 'object' ? (body.draft as object) : {}) };
    if (body.draft && typeof body.draft === 'object') return body.draft as Record<string, unknown>;
    if (typeof body.words === 'string' && body.words.trim()) return draftFromWords(body.words.slice(0, 1000));
    throw new HttpError(400, T('Pick when it runs.'));
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'automations') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const s = automationsFor(app);
    if (!b && method === 'GET') {
      return send(res, 200, { items: s.all(), waiting: s.waiting(), starters: STARTERS.map((x) => ({ id: x.id, name: T(x.name), pitch: T(x.pitch) })), tz: app.settings.get().timeZone ?? null });
    }
    if (!b && method === 'POST') {
      const body = await readJson(req);
      // A template (a file, pasted text or the gallery) is made only after its preview and Allow.
      if ((body.template !== undefined || body.gallery !== undefined) && body.allow !== true) throw new HttpError(400, T('Look at the preview, then tap Allow.'));
      return send(res, 200, { automation: await wrap(() => s.create(draftOf(body), { by: 'settings' })) });
    }
    if ((b === 'preview' || b === 'dry-run') && !c && method === 'POST') {
      const body = await readJson(req);
      if (b === 'preview') return send(res, 200, await wrap(() => s.preview(draftOf(body))));
      return send(res, 200, { steps: await wrap(() => s.dryDraft(draftOf(body))) });
    }
    if (b === 'templates' && !c && method === 'GET') {
      return send(res, 200, { gallery: GALLERY.map((g) => ({ id: g.id, name: T(g.name), pitch: T(g.pitch), placeholders: g.template.placeholders.map((p) => ({ ...p, label: T(p.label) })) })) });
    }
    if (b === 'templates' && c === 'read' && method === 'POST') {
      const body = await readJson(req);
      const template = await wrap(() => parseTemplate(typeof body.text === 'string' ? body.text : body.template));
      return send(res, 200, { template, placeholders: template.placeholders.map((p) => ({ ...p, label: T(p.label) })) });
    }
    if (b === 'runs' && c && (d === 'allow' || d === 'decline') && method === 'POST') {
      await readJson(req).catch(() => ({}));
      return send(res, 200, { run: await wrap(() => s.answer(Number(c), d === 'allow')) });
    }
    if (!b) throw new HttpError(404, 'Not found');
    const key = decodeURIComponent(b);
    const auto = /^auto:(\d+)$/.exec(key);
    if (!c && method === 'DELETE') {
      await wrap(() => s.removeKey(key));
      return send(res, 200, { ok: true });
    }
    if (!c && method === 'PATCH') {
      if (!auto) throw new HttpError(400, T('This one is turned on where it was set up.'));
      const body = await readJson(req);
      return send(res, 200, { automation: await wrap(() => s.patch(Number(auto[1]), { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.trigger ? { trigger: body.trigger } : {}) })) });
    }
    if (c === 'template' && method === 'GET') {
      if (!auto) throw new HttpError(400, T('This one is turned on where it was set up.'));
      const a = s.get(Number(auto[1]));
      if (!a) throw new HttpError(404, T('Automation not found.'));
      return send(res, 200, { template: exportTemplate(a) });
    }
    if (c === 'history' && method === 'GET') return send(res, 200, { runs: await wrap(() => s.historyKey(key)) });
    if (c && method === 'POST') {
      await readJson(req).catch(() => ({}));
      if (c === 'on' || c === 'off') {
        await wrap(() => s.toggle(key, c === 'on'));
        return send(res, 200, { ok: true });
      }
      if ((c === 'run' || c === 'dry-run') && auto) {
        const id = Number(auto[1]);
        if (!s.get(id)) throw new HttpError(404, T('Automation not found.'));
        // Run now answers at once; the run goes on (one at a time) and lands in the history.
        const p = s.fire(id, c === 'run' ? 'Run now' : 'Test run', { dry: c === 'dry-run', force: true });
        if (c === 'dry-run') return send(res, 200, { run: await wrap(() => p) });
        void p.catch(() => undefined);
        return send(res, 202, { ok: true });
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
