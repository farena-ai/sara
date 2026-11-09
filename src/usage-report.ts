// EC15 (docs/ops/EC1115_DESIGN.md): usage and cost reports per person, workspace, project and model,
// by day, week or month, with CSV export and monthly budgets that warn before a limit. Everything is
// summed from the Phase 52 meter's own `usage` rows (src/usage.ts), the same rows the run records
// point to; no second meter. Budgets are checked with src/budget.ts (subscription/local $ ignored).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { audit, csvCell } from './audit-trail.ts';
import { budgetCheck } from './budget.ts';
import { writeFileAtomic } from './fs-util.ts';
import { tr } from './i18n.ts';
import { dayStartUtc } from './planner.ts';
import { hub } from './telemetry/hub.ts';
import type { Billing } from './usage.ts';

export type ReportPeriod = 'day' | 'week' | 'month';
export type ReportGroup = 'person' | 'workspace' | 'project' | 'model';
export const REPORT_PERIODS: readonly ReportPeriod[] = ['day', 'week', 'month'];
export const REPORT_GROUPS: readonly ReportGroup[] = ['person', 'workspace', 'project', 'model'];

/** One companion's database and whose it is (a person's companions each have one). */
export interface ReportSource {
  person: string;
  personName: string;
  db: DatabaseSync;
}
export interface ReportNumbers {
  calls: number;
  input: number;
  output: number;
  cached: number;
  tokens: number;
  usd: number;
  /** Paid calls with no price (their cost isn't in usd). */
  unpriced: number;
}
export interface ReportRow extends ReportNumbers {
  bucket: string;
  person: string;
  workspace: string;
  project: string;
  model: string;
}
export interface UsageReport {
  period: ReportPeriod;
  by: ReportGroup[];
  from: string;
  to: string;
  rows: ReportRow[];
  totals: ReportNumbers;
}

function localDay(iso: string, tz: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** The bucket a moment falls in: local day, the Monday of its ISO week, or its month. */
export function bucketOf(iso: string, period: ReportPeriod, tz: string): string {
  const day = localDay(iso, tz);
  if (period === 'day') return day;
  if (period === 'month') return day.slice(0, 7);
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

const zero = (): ReportNumbers => ({ calls: 0, input: 0, output: 0, cached: 0, tokens: 0, usd: 0, unpriced: 0 });
type Raw = { at: string; model: string; billing: string; input: number; output: number; cached: number; usd: number | null; workspace: string | null; project: string | null };

/** Each source's rows in the window (a database shared by two companions is read once). */
function rowsOf(sources: readonly ReportSource[], from: string, to: string): { src: ReportSource; rows: Raw[] }[] {
  const seen = new Set<DatabaseSync>();
  const out: { src: ReportSource; rows: Raw[] }[] = [];
  for (const src of sources) {
    if (seen.has(src.db)) continue;
    seen.add(src.db);
    const has = (t: string) => Boolean(src.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (!has('usage')) continue;
    const conv = has('conversations');
    const proj = conv && has('projects');
    const sql = `SELECT u.at, u.model, u.billing, u.input, u.output, u.cached, u.usd, ${conv ? 'c.workspace' : 'NULL'} AS workspace, ${proj ? 'p.name' : 'NULL'} AS project
      FROM usage u ${conv ? 'LEFT JOIN conversations c ON c.id = u.conversation_id' : ''} ${proj ? 'LEFT JOIN projects p ON p.id = c.project_id' : ''}
      WHERE u.at >= ? AND u.at < ?`;
    out.push({ src, rows: src.db.prepare(sql).all(from, to) as unknown as Raw[] });
  }
  return out;
}

function add(n: ReportNumbers, r: Raw): void {
  n.calls++;
  n.input += Number(r.input);
  n.output += Number(r.output);
  n.cached += Number(r.cached);
  n.tokens += Number(r.input) + Number(r.output);
  if (r.usd === null) n.unpriced++;
  else n.usd += Number(r.usd);
}
const rounded = <T extends ReportNumbers>(n: T): T => ({ ...n, usd: Math.round(n.usd * 1e6) / 1e6 });

/** The report: one row per bucket and chosen group (other group columns stay empty). */
export function usageReport(sources: readonly ReportSource[], q: { period: ReportPeriod; by: readonly ReportGroup[]; from: string; to: string; tz: string }): UsageReport {
  const by = REPORT_GROUPS.filter((g) => q.by.includes(g));
  const groups = new Map<string, ReportRow>();
  const totals = zero();
  for (const { src, rows } of rowsOf(sources, q.from, q.to)) {
    for (const r of rows) {
      const row: Omit<ReportRow, keyof ReportNumbers> = {
        bucket: bucketOf(r.at, q.period, q.tz),
        person: by.includes('person') ? src.personName : '',
        workspace: by.includes('workspace') ? (r.workspace ?? '') : '',
        project: by.includes('project') ? (r.project ?? '') : '',
        model: by.includes('model') ? r.model : '',
      };
      const k = JSON.stringify([row.bucket, by.includes('person') ? src.person : '', row.workspace, row.project, row.model]);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { ...row, ...zero() }));
      add(g, r);
      add(totals, r);
    }
  }
  const rows = [...groups.values()].map(rounded).sort((a, b) => a.bucket.localeCompare(b.bucket) || b.tokens - a.tokens || a.person.localeCompare(b.person));
  return { period: q.period, by, from: q.from, to: q.to, rows, totals: rounded(totals) };
}

const NUM_COLS: (keyof ReportNumbers)[] = ['calls', 'input', 'output', 'cached', 'tokens', 'usd', 'unpriced'];
const NUM_NAMES: Record<keyof ReportNumbers, string> = { calls: 'calls', input: 'input_tokens', output: 'output_tokens', cached: 'cached_tokens', tokens: 'tokens', usd: 'usd', unpriced: 'unpriced_calls' };

/** The report as CSV (the chosen groups only; formula-looking cells defused). */
export function reportCsv(r: UsageReport): string {
  const head = ['period', ...r.by, ...NUM_COLS.map((c) => NUM_NAMES[c])];
  const lines = r.rows.map((row) => [row.bucket, ...r.by.map((g) => row[g]), ...NUM_COLS.map((c) => row[c])].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

// ---- budgets (monthly, per person or workspace) ----

export type BudgetScope = 'person' | 'workspace';
export interface UsageBudget {
  scope: BudgetScope;
  key: string;
  usd?: number;
  tokens?: number;
  /** Warn at this share of the budget (0.5 to 0.95). */
  alertAt: number;
}
export type BudgetLevel = 'ok' | 'near' | 'reached';
export interface BudgetStatus extends UsageBudget {
  id: string;
  month: string;
  spent: { tokens: number; usd: number; unpriced: number };
  frac: number;
  level: BudgetLevel;
  usdIgnored?: boolean;
}
interface BudgetFile {
  budgets: UsageBudget[];
  alerted: Record<string, { month: string; level: BudgetLevel }>;
}
const RANK: Record<BudgetLevel, number> = { ok: 0, near: 1, reached: 2 };
const idOf = (b: Pick<UsageBudget, 'scope' | 'key'>) => `${b.scope}:${b.key}`;

export function cleanBudgets(v: unknown): UsageBudget[] {
  if (!Array.isArray(v)) throw new Error('budgets must be a list.');
  if (v.length > 100) throw new Error('Up to 100 budgets.');
  const out: UsageBudget[] = [];
  for (const raw of v) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.scope !== 'person' && r.scope !== 'workspace') throw new Error('A budget is for a person or a workspace.');
    const key = String(r.key ?? '').trim().slice(0, 80);
    if (!key) throw new Error('A budget needs a person or a workspace.');
    const usd = Number(r.usd);
    const tokens = Number(r.tokens);
    const b: UsageBudget = { scope: r.scope, key, alertAt: 0.8 };
    if (r.usd !== undefined && r.usd !== null && r.usd !== '' && Number.isFinite(usd) && usd > 0) b.usd = Math.min(100_000, Math.round(usd * 100) / 100);
    if (r.tokens !== undefined && r.tokens !== null && r.tokens !== '' && Number.isFinite(tokens) && tokens > 0) b.tokens = Math.min(10_000_000_000, Math.max(1000, Math.round(tokens)));
    if (!b.usd && !b.tokens) throw new Error('A budget needs dollars or tokens.');
    const at = Number(r.alertAt);
    if (r.alertAt !== undefined && Number.isFinite(at)) b.alertAt = Math.min(0.95, Math.max(0.5, Math.round(at * 100) / 100));
    if (out.some((o) => idOf(o) === idOf(b))) continue;
    out.push(b);
  }
  return out;
}

export class UsageBudgets {
  readonly #file: string;
  readonly #now: () => Date;
  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#file = join(dataDir, 'usage-budgets.json');
    this.#now = now;
  }
  #read(): BudgetFile {
    try {
      if (existsSync(this.#file)) {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<BudgetFile>;
        return { budgets: cleanBudgets(raw.budgets ?? []), alerted: raw.alerted && typeof raw.alerted === 'object' ? raw.alerted : {} };
      }
    } catch (err) {
      console.warn(`usage budgets: ${(err as Error).message}`);
    }
    return { budgets: [], alerted: {} };
  }
  #write(f: BudgetFile): void {
    writeFileAtomic(this.#file, JSON.stringify(f, null, 2) + '\n');
  }
  get(): { budgets: UsageBudget[] } {
    return { budgets: this.#read().budgets };
  }
  set(v: unknown): UsageBudget[] {
    const budgets = cleanBudgets(v);
    const f = this.#read();
    const keep = new Set(budgets.map(idOf));
    this.#write({ budgets, alerted: Object.fromEntries(Object.entries(f.alerted).filter(([k]) => keep.has(k))) });
    return budgets;
  }

  /** This month's spending against each budget (local month in the owner's time zone). */
  status(sources: readonly ReportSource[], tz: string): BudgetStatus[] {
    const now = this.#now();
    const month = bucketOf(now.toISOString(), 'month', tz);
    const from = dayStartUtc(`${month}-01`, tz).toISOString();
    const to = new Date(now.getTime() + 1).toISOString();
    const data = rowsOf(sources, from, to);
    return this.#read().budgets.map((b) => {
      const spent = { tokens: 0, usd: 0, unpriced: 0 };
      const billing = new Set<Billing>();
      for (const { src, rows } of data) {
        if (b.scope === 'person' && src.person !== b.key) continue;
        for (const r of rows) {
          if (b.scope === 'workspace' && (r.workspace ?? '') !== b.key) continue;
          spent.tokens += Number(r.input) + Number(r.output);
          if (r.usd === null) spent.unpriced++;
          else spent.usd += Number(r.usd);
          billing.add(r.billing as Billing);
        }
      }
      spent.usd = Math.round(spent.usd * 1e6) / 1e6;
      const chk = budgetCheck({ ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.usd ? { usd: b.usd } : {}) }, { ...spent, billing: [...billing] });
      const level: BudgetLevel = chk.reached ? 'reached' : chk.frac >= b.alertAt ? 'near' : 'ok';
      return { ...b, id: idOf(b), month, spent, frac: Math.round(chk.frac * 1000) / 1000, level, ...(chk.usdIgnored ? { usdIgnored: true } : {}) };
    });
  }

  /** Budgets that just went up a level this month (each level alerts once a month); remembered. */
  alerts(sources: readonly ReportSource[], tz: string): BudgetStatus[] {
    const st = this.status(sources, tz);
    const f = this.#read();
    const fresh: BudgetStatus[] = [];
    for (const s of st) {
      if (s.level === 'ok') continue;
      const had = f.alerted[s.id];
      const before = had && had.month === s.month ? RANK[had.level] : 0;
      if (RANK[s.level] <= before) continue;
      f.alerted[s.id] = { month: s.month, level: s.level };
      fresh.push(s);
    }
    if (fresh.length) this.#write(f);
    return fresh;
  }
}

/**
 * Budget alerts: after model calls (the EC3 telemetry hub), a debounced check; each budget that
 * goes up a level this month writes one audit row and tells the owner (a push notification).
 */
export function budgetAlerter(o: { budgets: UsageBudgets; sources: () => ReportSource[]; tz: () => string; lang: () => string; notify: (title: string, line: string) => void; debounceMs?: number }): { check: () => BudgetStatus[]; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): BudgetStatus[] => {
    let fresh: BudgetStatus[] = [];
    try {
      const src = o.sources();
      fresh = o.budgets.alerts(src, o.tz());
      for (const b of fresh) {
        const name = b.scope === 'person' ? (src.find((x) => x.person === b.key)?.personName ?? b.key) : b.key;
        audit({ action: 'usage.budget.alert', target: `budget:${b.id} ${b.level}`, who: 'system', role: 'system', channel: 'system' });
        const line = b.level === 'reached' ? tr("{name} has reached this month's budget.", o.lang(), { name }) : tr("{name} has used {pct}% of this month's budget.", o.lang(), { name, pct: Math.round(b.frac * 100) });
        o.notify(tr('Usage budget', o.lang()), line);
      }
    } catch (err) {
      console.warn(`usage budgets: ${(err as Error).message}`);
    }
    return fresh;
  };
  const off = hub.onModelCall(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      check();
    }, o.debounceMs ?? 5000);
    timer.unref?.();
  });
  return {
    check,
    stop: () => {
      off();
      if (timer) clearTimeout(timer);
    },
  };
}
