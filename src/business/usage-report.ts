// EC15 follow-up (docs/ops/EC1115_DESIGN.md, "Business instance"): the business spending ledger
// (`business_model_requests`, written by BusinessBudget for every admitted model call) as a
// read-only report per person, workspace and model, in the same shapes and CSV columns as the
// personal report (src/usage-report.ts). No second meter: every number is a ledger column.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { dayStartUtc } from '../planner.ts';
import { bucketOf, REPORT_PERIODS, reportCsv, type ReportNumbers, type ReportPeriod, type ReportRow, type UsageReport } from '../usage-report.ts';
import { appendAudit } from './audit.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessPrincipal } from './types.ts';

export type BusinessReportGroup = 'person' | 'workspace' | 'model';
export const BUSINESS_REPORT_GROUPS: readonly BusinessReportGroup[] = ['person', 'workspace', 'model'];
export interface BusinessReportNames { people: Map<string, string>; workspaces: Map<string, string> }
const DAY = 86_400_000;
const NANO = 1e9;

const zero = (): ReportNumbers => ({ calls: 0, input: 0, output: 0, cached: 0, tokens: 0, usd: 0, unpriced: 0 });
type Raw = { at: number; actor: string; workspace: string; model: string | null; input: number | null; output: number | null; charged: number | null };

function add(n: ReportNumbers, r: Raw): void {
  n.calls++;
  n.input += Number(r.input ?? 0);
  n.output += Number(r.output ?? 0);
  n.tokens += Number(r.input ?? 0) + Number(r.output ?? 0);
  // A held request has no settled charge: its usage is unknown until the operator reconciles it.
  if (r.charged === null) n.unpriced++;
  else n.usd += Number(r.charged) / NANO;
}
const rounded = <T extends ReportNumbers>(n: T): T => ({ ...n, usd: Math.round(n.usd * 1e6) / 1e6 });

/** Ledger rows in [from, to) grouped by bucket and the chosen groups. Turns refused before any model call are not calls. */
export function businessUsageReport(db: DatabaseSync, q: { period: ReportPeriod; by: readonly BusinessReportGroup[]; from: string; to: string; tz: string }, names: BusinessReportNames): UsageReport {
  const by = BUSINESS_REPORT_GROUPS.filter((g) => q.by.includes(g));
  const rows = db.prepare(`SELECT created_at AS at, actor_id AS actor, workspace_id AS workspace, model, input_usage AS input, output_usage AS output, charged
    FROM business_model_requests WHERE max_input > 0 AND created_at >= ? AND created_at < ?`).all(Date.parse(q.from), Date.parse(q.to)) as unknown as Raw[];
  const groups = new Map<string, ReportRow>();
  const totals = zero();
  for (const r of rows) {
    const row: Omit<ReportRow, keyof ReportNumbers> = {
      bucket: bucketOf(new Date(Number(r.at)).toISOString(), q.period, q.tz),
      person: by.includes('person') ? (names.people.get(r.actor) ?? r.actor) : '',
      workspace: by.includes('workspace') ? (names.workspaces.get(r.workspace) ?? r.workspace) : '',
      project: '',
      model: by.includes('model') ? (r.model ?? '') : '',
    };
    const k = JSON.stringify([row.bucket, by.includes('person') ? r.actor : '', by.includes('workspace') ? r.workspace : '', row.model]);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { ...row, ...zero() }));
    add(g, r);
    add(totals, r);
  }
  const out = [...groups.values()].map(rounded).sort((a, b) => a.bucket.localeCompare(b.bucket) || b.tokens - a.tokens || a.person.localeCompare(b.person));
  return { period: q.period, by: by as UsageReport['by'], from: q.from, to: q.to, rows: out, totals: rounded(totals) };
}

class ReportQueryError extends Error {}
function validZone(tz: string | null): string {
  if (!tz || tz.length > 64) return 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}
function parse(url: string, now: number) {
  const q = new URL(url, 'http://x').searchParams;
  const tz = validZone(q.get('tz'));
  const period = (q.get('period') || 'day') as ReportPeriod;
  if (!REPORT_PERIODS.includes(period)) throw new ReportQueryError('Pick daily, weekly or monthly.');
  const by = (q.get('by') || 'person').split(',').filter((g): g is BusinessReportGroup => (BUSINESS_REPORT_GROUPS as readonly string[]).includes(g));
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const fromDay = day(q.get('from'));
  const toDay = day(q.get('to'));
  const from = fromDay ? dayStartUtc(fromDay, tz).getTime() : now - 30 * DAY;
  const to = toDay ? dayStartUtc(toDay, tz).getTime() + DAY : now + 1;
  if (!(to > from) || to - from > 400 * DAY) throw new ReportQueryError('Pick up to 400 days, the start before the end.');
  return { period, by, tz, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export const BUSINESS_USAGE_PATHS = ['/api/business/usage/report', '/api/business/usage/report.csv'];

/** GET only, organization administrators only. The CSV download writes one `usage.export` audit row. */
export function handleBusinessUsage(o: { control: BusinessControlStore; req: IncomingMessage; res: ServerResponse; path: string; principal?: BusinessPrincipal; json: (res: ServerResponse, status: number, value: unknown) => void }): void {
  const { control, req, res, path, principal, json } = o;
  if (req.method !== 'GET') return json(res, 404, { error: 'Not found.' });
  if (!principal) return json(res, 401, { error: 'Sign-in required.' });
  try { control.policy.requireOrganizationAdmin(principal); } catch { return json(res, 403, { error: 'Request denied.' }); }
  let q: ReturnType<typeof parse>;
  try { q = parse(req.url ?? '/', Date.now()); } catch (error) { return json(res, 400, { error: error instanceof ReportQueryError ? error.message : 'Request denied.' }); }
  const db = control.database;
  const names: BusinessReportNames = {
    people: new Map(db.prepare('SELECT id,name FROM business_identities').all().map((r) => [String(r.id), String(r.name)])),
    workspaces: new Map(db.prepare('SELECT id,name FROM workspaces').all().map((r) => [String(r.id), String(r.name)])),
  };
  const report = businessUsageReport(db, q, names);
  if (path.endsWith('.csv')) {
    appendAudit(db, { action: 'usage.export', actorId: principal.identityId });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="sara-business-usage-${report.period}-${report.from.slice(0, 10)}.csv"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return void res.end(reportCsv(report));
  }
  return json(res, 200, report);
}
