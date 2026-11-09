// EC15 (docs/ops/EC1115_DESIGN.md): usage and cost reports and monthly budgets. The owner's space
// reads every person (main.ts hands it `usageSources`); a household member's space only ever reads
// that member's own companions. Budgets are the owner's only.
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from '../audit-trail.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { dayStartUtc } from '../planner.ts';
import { reportCsv, REPORT_GROUPS, REPORT_PERIODS, UsageBudgets, usageReport, type ReportGroup, type ReportPeriod, type ReportSource } from '../usage-report.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const DAY = 86_400_000;

export function createUsageReportRoutes(ctx: RouteCtx): RouteHandler {
  const { opts, app, rootDir, spaceId } = ctx;
  let own: UsageBudgets | undefined;
  const budgets = () => opts.usageBudgets ?? (own ??= new UsageBudgets(rootDir));
  const isOwner = () => !opts.member && !app.member && !opts.demo && !app.demo;
  const sources = (): ReportSource[] => {
    if (opts.member) {
      const rec = opts.member.record();
      return opts.member.apps().map((a) => ({ person: rec?.id ?? spaceId, personName: rec?.name ?? '', db: a.store.db }));
    }
    if (opts.usageSources && isOwner()) return opts.usageSources();
    const name = app.settings.get().ownerName || 'Owner';
    return (opts.companions?.all().map((c) => c.app) ?? [app]).map((a) => ({ person: 'owner', personName: name, db: a.store.db }));
  };
  const query = (req: IncomingMessage) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const tz = app.settings.get().timeZone || 'UTC';
    const period = (q.get('period') || 'day') as ReportPeriod;
    if (!REPORT_PERIODS.includes(period)) throw new HttpError(400, 'Pick daily, weekly or monthly.');
    const by = (q.get('by') || 'person').split(',').filter((g): g is ReportGroup => (REPORT_GROUPS as readonly string[]).includes(g));
    const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const now = app.now().getTime();
    const fromDay = day(q.get('from'));
    const toDay = day(q.get('to'));
    const from = fromDay ? dayStartUtc(fromDay, tz).getTime() : now - 30 * DAY;
    const to = toDay ? dayStartUtc(toDay, tz).getTime() + DAY : now + 1;
    if (!(to > from) || to - from > 400 * DAY) throw new HttpError(400, 'Pick up to 400 days, the start before the end.');
    return { period, by, tz, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  };
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a !== 'usage' || c) return NEXT;
    if (b === 'report' && method === 'GET') return send(res, 200, { ...usageReport(sources(), query(req)), canSeeOthers: isOwner() && Boolean(opts.usageSources) });
    if (b === 'report.csv' && method === 'GET') {
      const r = usageReport(sources(), query(req));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="sara-usage-${r.period}-${r.from.slice(0, 10)}.csv"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end(reportCsv(r));
    }
    if (b === 'budgets') {
      if (!isOwner()) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      if (method === 'PUT') {
        const body = await readJson(req);
        try {
          budgets().set(body.budgets);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        audit({ action: 'usage.budgets', keys: ['budgets'] });
      } else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const src = sources();
      const people = [...new Map(src.map((s) => [s.person, { id: s.person, name: s.personName }])).values()];
      const ws = new Set<string>();
      const seen = new Set<DatabaseSync>();
      for (const s of src) {
        if (seen.has(s.db)) continue;
        seen.add(s.db);
        for (const r of s.db.prepare("SELECT DISTINCT workspace FROM conversations WHERE workspace <> '' LIMIT 200").all() as { workspace: string }[]) ws.add(r.workspace);
      }
      return send(res, 200, { ...budgets().get(), status: budgets().status(src, app.settings.get().timeZone || 'UTC'), people, workspaces: [...ws].sort() });
    }
    return NEXT;
  };
}
