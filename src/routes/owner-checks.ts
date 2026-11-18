// U1.5 (docs/TRY_THESE.md): Help → Try these, the owner's guided checklist (src/owner-checks.ts).
// Owner only (members get 403, the demo 404). Sending uses the existing hub ticket path
// (fileTicket: proof of work, scrubbed, kept in My reports) and only after the owner turned it on.
//   GET  /api/owner-checks              the list, results, progress, groups, sendOn
//   PUT  /api/owner-checks              { sendOn }                 allow Send results (off by default)
//   PUT  /api/owner-checks/:id          { result: worked|failed|skipped|null, note? }
//   POST /api/owner-checks/seen         { ids }                    no longer New
//   GET  /api/owner-checks/preview      the exact report that Send results sends
//   POST /api/owner-checks/send         sends it as one report (Help → My reports shows it)
//   GET  /api/owner-checks/export       the results as Markdown (a download)
import { en } from '../i18n.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { fileTicket } from '../hub.ts';
import { checkById, checksView, CHECK_RESULTS, OwnerChecks, resultsMarkdown, resultsTicket, type CheckResult } from '../owner-checks.ts';
import { ticketError } from './hub.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const stores = new WeakMap<object, OwnerChecks>();

export function createOwnerCheckRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const store = () => {
    let s = stores.get(app);
    if (!s) stores.set(app, (s = new OwnerChecks(app.dataDir, () => app.now())));
    return s;
  };
  const version = () => app.hub?.facts().version || ctx.info.version || '';
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'owner-checks') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, en('Not available in the demo.'));
    }
    if (ctx.opts.member || app.hub?.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, en('Only the owner of this server can use this.'), { ownerOnly: true });
    }
    const body = method === 'GET' ? {} : ((await readJson(req, 16 * 1024)) as Record<string, unknown>);
    const s = store();
    if (!b && method === 'GET') return send(res, 200, checksView(s));
    if (!b && method === 'PUT') {
      if (typeof body.sendOn === 'boolean') s.setSendOn(body.sendOn);
      return send(res, 200, checksView(s));
    }
    if (b === 'seen' && !c && method === 'POST') {
      s.seen(Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : []);
      return send(res, 200, checksView(s));
    }
    if (b === 'preview' && !c && method === 'GET') {
      if (!app.hub) throw new HttpError(404, en('Reports are not available here.'));
      return send(res, 200, resultsTicket(s, { version: version(), scrub: app.hub.scrub }));
    }
    if (b === 'send' && !c && method === 'POST') {
      const hub = app.hub;
      if (!hub) throw new HttpError(404, en('Reports are not available here.'));
      if (!s.get().sendOn) throw new HttpError(409, en('Turn on “Let me send results to the developer” first.'));
      if (!checksView(s).done) throw new HttpError(400, en('Try at least one item first.'));
      const r = await fileTicket(hub, resultsTicket(s, { version: version(), scrub: hub.scrub }), app.now());
      if (!r.ok) throw ticketError(r.code, r.reason);
      s.sent(r.ticket);
      return send(res, 201, { ...checksView(s), ticket: r.ticket });
    }
    if (b === 'export' && !c && method === 'GET') {
      const md = Buffer.from(resultsMarkdown(s, { version: version() }), 'utf8');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="sara-try-these-${app.now().toISOString().slice(0, 10)}.md"`, 'content-length': md.length, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(md);
      return;
    }
    if (b && !c && method === 'PUT') {
      if (!checkById(b)) throw new HttpError(404, en('No such item.'));
      const result = body.result === null ? null : (body.result as CheckResult);
      if (result !== null && !CHECK_RESULTS.includes(result)) throw new HttpError(400, en('Pick Worked, Didn’t work or Skip.'));
      s.mark(b, result, typeof body.note === 'string' ? body.note : '');
      return send(res, 200, checksView(s));
    }
    throw new HttpError(404, 'Not found.');
  };
}
