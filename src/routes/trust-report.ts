// EC25 (docs/ops/EC2527_DESIGN.md): the trust report page and its downloads. Owner only: a report spans
// every companion's work on this server. Every download writes one audit row; viewing does not.
import type { IncomingMessage } from 'node:http';
import { audit, auditTrail } from '../audit-trail.ts';
import { markdownToDocx, markdownToPdf } from '../doc-write.ts';
import { HttpError, SECURITY_HEADERS, send } from '../http.ts';
import { dayStartUtc } from '../planner.ts';
import { trustMarkdown, trustReport, type TrustScope, type TrustSource } from '../trust-report.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const DAY = 86_400_000;
const TYPES = { md: 'text/markdown; charset=utf-8', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } as const;

export function createTrustReportRoutes(ctx: RouteCtx): RouteHandler {
  const { opts, app } = ctx;
  const ownerOnly = () => {
    if (opts.member || app.member || opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
  };
  const sources = (): TrustSource[] => {
    const apps = opts.companions?.all().map((c) => c.app) ?? [app];
    return apps.filter((a) => a.runs).map((a) => ({ db: a.store.db, runs: a.runs! }));
  };
  const scopeOf = (req: IncomingMessage): TrustScope => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const kind = q.get('scope') || 'week';
    if (kind === 'run' || kind === 'project') {
      const id = Number(q.get('id'));
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Pick a run or a project.');
      return { kind, id };
    }
    if (kind !== 'week') throw new HttpError(400, 'Pick a week, a run or a project.');
    const day = q.get('from');
    const tz = app.settings.get().timeZone || 'UTC';
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Pick the first day of the week.');
    // Default: the last seven days, today included (in the owner's time zone).
    const from = day ? dayStartUtc(day, tz).getTime() : dayStartUtc(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(app.now()), tz).getTime() - 6 * DAY;
    return { kind: 'week', from: new Date(from).toISOString(), to: new Date(from + 7 * DAY).toISOString() };
  };
  const build = (req: IncomingMessage) => {
    const scope = scopeOf(req);
    try {
      return trustReport(sources(), scope, auditTrail()?.list({ limit: 5000 }) ?? []);
    } catch (err) {
      if (/^No (run|project)/.test((err as Error).message)) throw new HttpError(404, (err as Error).message);
      throw err;
    }
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'trust' || c) return NEXT;
    if (method !== 'GET') return NEXT;
    if (b === 'projects') {
      ownerOnly();
      const out = new Map<string, { id: number; name: string }>();
      for (const s of sources()) {
        try {
          for (const p of s.db.prepare("SELECT id, name FROM projects WHERE status <> 'archived' ORDER BY name LIMIT 200").all() as { id: number; name: string }[]) out.set(`${p.id}`, { id: Number(p.id), name: String(p.name) });
        } catch {
          /* no planner tables in this space */
        }
      }
      return send(res, 200, { projects: [...out.values()] });
    }
    if (b === 'report') {
      ownerOnly();
      return send(res, 200, build(req));
    }
    const m = /^report\.(md|pdf|docx)$/.exec(b ?? '');
    if (!m) return NEXT;
    ownerOnly();
    const format = m[1] as keyof typeof TYPES;
    const r = build(req);
    const md = trustMarkdown(r, app.now().toISOString());
    const title = `Trust report: ${r.title}`;
    const bytes = format === 'md' ? Buffer.from(md, 'utf8') : format === 'docx' ? markdownToDocx(md, title) : markdownToPdf(md, title);
    const s = r.scope;
    audit({ action: 'trust.export', target: format, keys: [s.kind, s.kind === 'week' ? s.from.slice(0, 10) : String(s.id)] });
    const name = `sara-trust-${s.kind}-${s.kind === 'week' ? s.from.slice(0, 10) : s.id}.${format}`;
    res.writeHead(200, { 'content-type': TYPES[format], 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
    return void res.end(bytes);
  };
}
