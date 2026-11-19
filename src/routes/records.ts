// W4.6 (docs/design/W4RECORDS.md): public-records reports, the owner's only. Household members,
// kids, the demo and device keys get 403. Every search is an audit row (src/records.ts).
//   GET    /api/records                    {reports, places, header, types, privateLocal}
//   POST   /api/records                    {name?, address?, phone?, email?, username?, city?, state?, age?} → {report}
//   GET    /api/records/:id                {report, sections}
//   POST   /api/records/:id/more           Find more sources → {report}
//   POST   /api/records/:id/stop           → {report}
//   DELETE /api/records/:id
//   GET    /api/records/:id/pdf            the PDF (the notice on every page)
//   GET    /api/records/places             {places}
//   POST   /api/records/places             {domain, types, region, holds, how, status?} → {place}
//   PUT    /api/records/places/:id         same fields → {place}
//   DELETE /api/records/places/:id
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { RECORD_TYPES, RECORDS_HEADER, recordsOf, RecordsError, TYPE_LABEL, type Records, type RecordsReport } from '../records.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createRecordsRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const view = (r: Records, rep: RecordsReport) => ({ report: rep, sections: r.sections(rep) });
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      if (err instanceof RecordsError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'records') return NEXT;
    const records = ctx.opts.demo || ctx.opts.member ? undefined : recordsOf(app);
    if (!records) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    if (!b) {
      if (method === 'GET') return send(res, 200, { reports: records.list().map((x) => ({ id: x.id, subject: x.subject, status: x.status, createdAt: x.createdAt, updatedAt: x.updatedAt, facts: x.facts.length, rounds: x.rounds })), places: records.places(), header: RECORDS_HEADER, types: RECORD_TYPES.map((t) => ({ id: t, label: TYPE_LABEL[t] })), privateLocal: privateLocalOn() });
      if (method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, view(records, wrap(() => records.start(body, { channel: 'web' }))));
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (b === 'places') {
      if (!c) {
        if (method === 'GET') return send(res, 200, { places: records.places() });
        if (method === 'POST') {
          const body = (await readJson(req)) as Record<string, unknown>;
          return send(res, 200, { place: wrap(() => records.savePlace({ ...body, domain: String(body.domain ?? ''), id: undefined } as never)) });
        }
        throw new HttpError(405, 'Method not allowed');
      }
      if (method === 'PUT') {
        const body = (await readJson(req)) as Record<string, unknown>;
        if (!records.places().some((p) => p.id === c)) throw new HttpError(404, 'That place is not on the list.');
        return send(res, 200, { place: wrap(() => records.savePlace({ ...body, domain: String(body.domain ?? ''), id: c } as never)) });
      }
      if (method === 'DELETE') {
        wrap(() => records.removePlace(c));
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    const rep = records.get(b);
    if (!rep) throw new HttpError(404, 'That report is gone.');
    if (!c) {
      if (method === 'GET') return send(res, 200, view(records, rep));
      if (method === 'DELETE') {
        wrap(() => records.remove(b));
        return send(res, 200, { ok: true });
      }
      throw new HttpError(405, 'Method not allowed');
    }
    if (c === 'more' && method === 'POST' && !d) {
      await readJson(req).catch(() => undefined);
      return send(res, 200, view(records, wrap(() => records.more(b, { channel: 'web' }))));
    }
    if (c === 'stop' && method === 'POST' && !d) {
      await readJson(req).catch(() => undefined);
      return send(res, 200, view(records, wrap(() => records.stop(b))));
    }
    if (c === 'pdf' && method === 'GET' && !d) {
      const pdf = wrap(() => records.pdf(b));
      const name = `public-records-${rep.subject.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || rep.id}.pdf`;
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/pdf', 'content-length': pdf.length, 'content-disposition': `${new URL(req.url ?? '/', 'http://x').searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename="${name}"`, 'cache-control': 'private, no-store' });
      res.end(pdf);
      return;
    }
    throw new HttpError(404, 'Not found');
  };
}
