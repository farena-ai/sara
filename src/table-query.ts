// E1 (docs/DATA.md): analyze_table. The person's CSV or Excel file from the library is read with
// the library's own readers (parseCsv, readXlsxCells) into rows, and a small, safe query engine
// answers a question the model writes as JSON: filters (text, numbers, date ranges), group by,
// sum/avg/count/min/max, sort and top N. No code runs, so it works without the sandbox; the numbers
// come from the engine, never from the model's arithmetic. Results are a small table plus the
// rows used, so the answer can say exactly what was counted.
import type { AppContext } from './chat.ts';
import { readXlsxCells } from './library/ooxml.ts';
import { decodeText, detectKind, parseCsv } from './library/read.ts';
import { openZip } from './library/zip.ts';
import { ToolError, type Tool } from './tools/types.ts';

export interface Table {
  name: string;
  sheet?: string;
  sheets?: string[];
  columns: string[];
  rows: string[][];
}

export type FilterOp = '=' | '!=' | 'contains' | 'not_contains' | '>' | '>=' | '<' | '<=' | 'between' | 'empty' | 'not_empty';
export interface Filter {
  column: string;
  op: FilterOp;
  value?: string | number;
  value2?: string | number;
}
export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max';
export interface Aggregate {
  fn: AggFn;
  column?: string;
  as?: string;
}
export interface TableQuery {
  filters?: Filter[];
  groupBy?: string[];
  aggregates?: Aggregate[];
  columns?: string[];
  sort?: { by: string; dir?: 'asc' | 'desc' };
  limit?: number;
}
export interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  matched: number;
  total: number;
  /** Cells that weren't numbers where a number was needed (skipped), per column. */
  skipped: Record<string, number>;
  truncated: boolean;
}

export class TableError extends Error {}

/** "$1,234.50", "(12)", "12%", "1.234,5" (when unambiguous) → number; otherwise null. */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$€£¥\s]|USD|EUR|GBP/gi, '').replace(/%$/, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** "2026-03-05", "2026-03-05T10:00", "3/5/2026" (US), "5 Mar 2026" → epoch ms (UTC midnight for dates); otherwise null. */
export function toDate(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return Date.UTC(y, +m[1] - 1, +m[2]);
  }
  if (/^\d{1,2} [A-Za-z]{3,9},? \d{4}$|^[A-Za-z]{3,9} \d{1,2},? \d{4}$/.test(s)) {
    const t = Date.parse(`${s} UTC`);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Rows of cells → a table: the first row with at least two filled cells is the header. */
export function tableFromGrid(name: string, grid: string[][], sheet?: string): Table {
  const start = grid.findIndex((r) => r.filter((c) => String(c ?? '').trim()).length >= 2);
  if (start < 0) throw new TableError(`${name}${sheet ? ` (sheet ${sheet})` : ''} has no table: no row with two or more filled cells.`);
  const head = grid[start].map((c, i) => String(c ?? '').trim() || `Column ${i + 1}`);
  const seen = new Map<string, number>();
  const columns = head.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} ${n}` : h;
  });
  const rows = grid.slice(start + 1).filter((r) => r.some((c) => String(c ?? '').trim())).map((r) => columns.map((_, i) => String(r[i] ?? '').trim()));
  return { name, ...(sheet ? { sheet } : {}), columns, rows };
}

/** Excel cells (sheet → "B3" → text) → grids per sheet. */
function gridsOf(cells: Map<string, Map<string, string>>): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const [sheet, m] of cells) {
    const grid: string[][] = [];
    for (const [addr, text] of m) {
      const a = /^([A-Z]+)(\d+)$/.exec(addr);
      if (!a) continue;
      let col = 0;
      for (const ch of a[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = Number(a[2]) - 1;
      (grid[row] ??= [])[col - 1] = text;
    }
    out.set(sheet, Array.from(grid, (r) => Array.from(r ?? [], (c) => c ?? '')));
  }
  return out;
}

/** A CSV or xlsx file's bytes → its table (the named sheet, else the first with a table). */
export function readTable(name: string, bytes: Buffer, sheet?: string): Table {
  const kind = detectKind(name, bytes);
  if (kind === 'csv' || (kind === 'text' && /\.(csv|tsv)$/i.test(name))) return tableFromGrid(name, parseCsv(decodeText(bytes), /\.tsv$/i.test(name) ? '\t' : undefined));
  if (kind !== 'xlsx') throw new TableError(`${name} isn't a CSV or Excel file. analyze_table reads .csv and .xlsx.`);
  const grids = gridsOf(readXlsxCells(openZip(bytes)));
  const names = [...grids.keys()];
  if (sheet) {
    const hit = names.find((n) => norm(n) === norm(sheet)) ?? names.find((n) => norm(n).includes(norm(sheet)));
    if (!hit) throw new TableError(`${name} has no sheet "${sheet}". Sheets: ${names.join(', ')}.`);
    return { ...tableFromGrid(name, grids.get(hit)!, hit), sheets: names };
  }
  for (const n of names) {
    try {
      return { ...tableFromGrid(name, grids.get(n)!, n), sheets: names };
    } catch {
      /* the next sheet */
    }
  }
  throw new TableError(`${name} has no sheet with a table.`);
}

function colIndex(t: Table, raw: string): number {
  const q = norm(String(raw ?? ''));
  let i = t.columns.findIndex((c) => norm(c) === q);
  if (i < 0) i = t.columns.findIndex((c) => norm(c).includes(q) && q.length >= 2);
  if (i < 0) throw new TableError(`No column "${String(raw).slice(0, 60)}". Columns: ${t.columns.join(', ')}.`);
  return i;
}

/** Compares a cell with a value: dates when both are dates, numbers when both are numbers, else text. */
function compare(cell: string, value: unknown): number | null {
  const dc = toDate(cell);
  const dv = toDate(value);
  if (dc !== null && dv !== null) return dc - dv;
  const nc = toNumber(cell);
  const nv = toNumber(value);
  if (nc !== null && nv !== null) return nc - nv;
  return null;
}

function keep(t: Table, f: Filter): (row: string[]) => boolean {
  const i = colIndex(t, f.column);
  const v = f.value;
  const text = norm(String(v ?? ''));
  switch (f.op) {
    case '=':
      return (r) => {
        const c = compare(r[i], v);
        return c !== null ? c === 0 : norm(r[i]) === text;
      };
    case '!=':
      return (r) => {
        const c = compare(r[i], v);
        return c !== null ? c !== 0 : norm(r[i]) !== text;
      };
    case 'contains':
      return (r) => norm(r[i]).includes(text);
    case 'not_contains':
      return (r) => !norm(r[i]).includes(text);
    case 'empty':
      return (r) => !r[i].trim();
    case 'not_empty':
      return (r) => Boolean(r[i].trim());
    case 'between':
      return (r) => {
        const a = compare(r[i], v);
        const b = compare(r[i], f.value2);
        return a !== null && b !== null && a >= 0 && b <= 0;
      };
    case '>':
    case '>=':
    case '<':
    case '<=':
      return (r) => {
        const c = compare(r[i], v);
        if (c === null) return false;
        return f.op === '>' ? c > 0 : f.op === '>=' ? c >= 0 : f.op === '<' ? c < 0 : c <= 0;
      };
    default:
      throw new TableError(`Unknown filter "${String(f.op)}". Use =, !=, contains, not_contains, >, >=, <, <=, between, empty, not_empty.`);
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function runQuery(t: Table, q: TableQuery): QueryResult {
  const skipped: Record<string, number> = {};
  let rows = t.rows;
  for (const f of q.filters ?? []) rows = rows.filter(keep(t, f));
  const matched = rows.length;
  const limit = Math.min(Math.max(1, Math.round(q.limit ?? 50)), 200);
  let columns: string[];
  let out: (string | number | null)[][];
  const aggs = q.aggregates ?? [];
  const groupBy = q.groupBy ?? [];
  if (aggs.length || groupBy.length) {
    const gi = groupBy.map((g) => colIndex(t, g));
    const list = aggs.length ? aggs : [{ fn: 'count' as const }];
    const ai = list.map((a) => {
      if (!['sum', 'avg', 'count', 'min', 'max'].includes(a.fn)) throw new TableError(`Unknown function "${String(a.fn)}". Use sum, avg, count, min, max.`);
      if (a.fn !== 'count' && !a.column) throw new TableError(`${a.fn} needs a column.`);
      return a.column ? colIndex(t, a.column) : -1;
    });
    const groups = new Map<string, { key: string[]; rows: string[][] }>();
    for (const r of rows) {
      const key = gi.map((i) => r[i]);
      const k = JSON.stringify(key.map(norm));
      const g = groups.get(k) ?? { key, rows: [] };
      g.rows.push(r);
      groups.set(k, g);
    }
    if (!gi.length && !groups.size) groups.set('[]', { key: [], rows: [] });
    columns = [...gi.map((i) => t.columns[i]), ...list.map((a, j) => a.as ?? (a.fn === 'count' && ai[j] < 0 ? 'count' : `${a.fn} of ${t.columns[ai[j]]}`))];
    out = [...groups.values()].map((g) => [
      ...g.key,
      ...list.map((a, j) => {
        const i = ai[j];
        if (a.fn === 'count') return i < 0 ? g.rows.length : g.rows.filter((r) => r[i].trim()).length;
        const nums: number[] = [];
        let dates = 0;
        for (const r of g.rows) {
          const n = toNumber(r[i]);
          if (n !== null) nums.push(n);
          else if ((a.fn === 'min' || a.fn === 'max') && toDate(r[i]) !== null) dates++;
          else if (r[i].trim()) skipped[t.columns[i]] = (skipped[t.columns[i]] ?? 0) + 1;
        }
        if ((a.fn === 'min' || a.fn === 'max') && !nums.length && dates) {
          const ds = g.rows.map((r) => r[i]).filter((c) => toDate(c) !== null).sort((x, y) => toDate(x)! - toDate(y)!);
          return a.fn === 'min' ? ds[0] : ds[ds.length - 1];
        }
        if (!nums.length) return null;
        if (a.fn === 'sum') return round(nums.reduce((s, n) => s + n, 0));
        if (a.fn === 'avg') return round(nums.reduce((s, n) => s + n, 0) / nums.length);
        return a.fn === 'min' ? Math.min(...nums) : Math.max(...nums);
      }),
    ]);
  } else {
    const ci = (q.columns?.length ? q.columns : t.columns).map((c) => colIndex(t, c));
    columns = ci.map((i) => t.columns[i]);
    out = rows.map((r) => ci.map((i) => r[i]));
  }
  if (q.sort?.by) {
    const si = columns.findIndex((c) => norm(c) === norm(q.sort!.by)) >= 0 ? columns.findIndex((c) => norm(c) === norm(q.sort!.by)) : columns.findIndex((c) => norm(c).includes(norm(q.sort!.by)));
    if (si < 0) throw new TableError(`Can't sort by "${q.sort.by}": the result's columns are ${columns.join(', ')}.`);
    const dir = q.sort.dir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = a[si];
      const y = b[si];
      const c = compare(String(x ?? ''), y ?? '');
      return dir * (c !== null ? c : String(x ?? '').localeCompare(String(y ?? '')));
    });
  }
  return { columns, rows: out.slice(0, limit), matched, total: t.rows.length, skipped, truncated: out.length > limit };
}

const cell = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? String(v) : v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 80));
export function markdownTable(r: { columns: string[]; rows: (string | number | null)[][] }): string {
  return [`| ${r.columns.map(cell).join(' | ')} |`, `|${r.columns.map(() => ' --- ').join('|')}|`, ...r.rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

/** The library file by name: this chat's shared files first, then the kept library. */
function findDoc(app: AppContext, name: string, conversationId?: string) {
  const lib = app.library;
  if (!lib) throw new ToolError('There is no library here: add the file on the Library page or with 📎 in the chat.');
  const all = [...(conversationId ? lib.list({ conversationId }) : []), ...lib.list()].filter((d) => /\.(csv|tsv|xlsx|xlsm)$/i.test(d.name));
  const q = name.trim().toLowerCase();
  const doc = all.find((d) => d.name.toLowerCase() === q) ?? all.find((d) => d.name.toLowerCase().includes(q) || (d.title ?? '').toLowerCase().includes(q));
  if (!doc) throw new ToolError(all.length ? `No CSV or Excel file called "${name.slice(0, 60)}". Files: ${all.slice(0, 15).map((d) => d.name).join(', ')}.` : 'There are no CSV or Excel files in the library or this chat yet. Ask them to add one with 📎.');
  const bytes = lib.file(doc);
  if (!bytes) throw new ToolError(`The file ${doc.name} is no longer on the server. Ask them to add it again.`);
  return { doc, bytes };
}

export function createAnalyzeTableTool(getApp: () => AppContext): Tool {
  return {
    defaultPermission: 'auto',
    interruptible: true,
    isAvailable: () => Boolean(getApp().library),
    spec: {
      name: 'analyze_table',
      description:
        "Answer questions about the person's own CSV or Excel file (from the library or shared in this chat) with exact numbers: totals, averages, counts, min/max, groups, filters by text, number or date range, sorting and top N. First call it with only document (and sheet) to see the columns and a few rows; then call it with a query. Every number in your answer must come from this tool's result; never estimate or add up numbers yourself.",
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'The file name (or part of it).' },
          sheet: { type: 'string', description: 'Optional: the Excel sheet.' },
          question: { type: 'string', description: 'Their question in their words (for the record).' },
          query: {
            type: 'object',
            description: 'What to compute. Example: {"filters":[{"column":"Date","op":"between","value":"2026-01-01","value2":"2026-03-31"}],"groupBy":["Category"],"aggregates":[{"fn":"sum","column":"Amount"}],"sort":{"by":"sum of Amount","dir":"desc"},"limit":5}',
            properties: {
              filters: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string', enum: ['=', '!=', 'contains', 'not_contains', '>', '>=', '<', '<=', 'between', 'empty', 'not_empty'] }, value: { type: 'string', description: 'A number, a date (YYYY-MM-DD) or text.' }, value2: { type: 'string', description: 'For between: the upper end.' } }, required: ['column', 'op'] } },
              groupBy: { type: 'array', items: { type: 'string' } },
              aggregates: { type: 'array', items: { type: 'object', properties: { fn: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'] }, column: { type: 'string' }, as: { type: 'string' } }, required: ['fn'] } },
              columns: { type: 'array', items: { type: 'string' }, description: 'Without aggregates: which columns to show.' },
              sort: { type: 'object', properties: { by: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['by'] },
              limit: { type: 'number', description: 'Top N rows (default 50, at most 200).' },
            },
          },
        },
        required: ['document'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Analyzing ${String(a.document ?? 'a table').slice(0, 60)}${a.question ? `: ${String(a.question).slice(0, 60)}` : ''}`,
    async run(args, ctx) {
      const app = getApp();
      const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
      if (conv?.partner) throw new ToolError("The person's files are private to them.");
      const { doc, bytes } = findDoc(app, String(args.document ?? ''), ctx.conversationId);
      try {
        const t = readTable(doc.name, bytes, args.sheet ? String(args.sheet) : undefined);
        const where = `${doc.name}${t.sheet ? `, sheet ${t.sheet}` : ''}`;
        const q = args.query && typeof args.query === 'object' ? (args.query as TableQuery) : undefined;
        if (!q || !Object.keys(q).length) {
          const sample = markdownTable({ columns: t.columns, rows: t.rows.slice(0, 5) });
          return `${where}: ${t.rows.length} rows. Columns: ${t.columns.join(', ')}.${t.sheets && t.sheets.length > 1 ? ` Sheets: ${t.sheets.join(', ')}.` : ''}\nFirst rows:\n${sample}\nNow call analyze_table again with a query to compute the answer.`;
        }
        const r = runQuery(t, q);
        const skipped = Object.entries(r.skipped).map(([c, n]) => `${n} cell(s) in ${c} weren't numbers and were left out`).join('; ');
        return `${markdownTable(r)}\n${r.truncated ? `Showing the first ${r.rows.length} rows of the result.\n` : ''}Computed by analyze_table from ${where}: ${r.matched} of ${r.total} rows matched the filters.${skipped ? ` Note: ${skipped}.` : ''}\nUse exactly these numbers and say which file and rows they came from. To give them a file of it, make_document can make a spreadsheet from this table.`;
      } catch (err) {
        if (err instanceof TableError) throw new ToolError(err.message);
        throw err;
      }
    },
  };
}
