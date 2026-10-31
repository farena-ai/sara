// Phase 105 (MI2, docs/design/MOVE_IN.md §8.1, §8.2, §8.5, §8.6): what a custom store holds.
// For every packed store (stores/<id>/) the server reads schema.json (never the SQL text for
// decisions), the ≤ 5 sample rows of every table and the first 1 000 rows of each data table, and
// builds a profile per table: observed column types, null share, distinct ratio, looks-like-date /
// looks-like-id, average text length, primary key, foreign keys (declared or inferred from values),
// row count and the newest timestamp. Tables are then grouped into families (foreign keys and
// shared name prefixes), and log/telemetry tables are recognised by the §8.2 score and skipped.
import { createHash } from 'node:crypto';
import type { Bundle } from './bundle.ts';
import { type Row, rows } from './readers/common.ts';

export interface ColumnInfo {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
}
export interface SchemaTable {
  name: string;
  /** Postgres: the schema the table lives in ("public", "app"…). */
  schema?: string;
  /** Postgres: "TABLE", "VIEW", "MATERIALIZED VIEW". */
  kind?: string;
  columns: ColumnInfo[];
  rows: number;
  verdict: string;
  why?: string;
  written?: number;
  foreignKeys?: { from: string; table: string; to: string }[];
  primaryKey?: string[];
  cats?: string[];
}
export interface StoreSchemaFile {
  id: string;
  source: string;
  kind: 'sqlite' | 'postgres';
  reader: string;
  bytes?: number;
  tables: SchemaTable[];
}

export type Observed = 'int' | 'float' | 'text' | 'date' | 'json' | 'blob' | 'bool' | 'null' | 'mixed';
export interface ColumnProfile {
  name: string;
  type: string;
  observed: Observed;
  nullShare: number;
  distinctRatio: number;
  /** epoch (seconds), ms, or iso: how a date in this column is written. */
  date?: 'epoch' | 'ms' | 'iso';
  looksId: boolean;
  avgLen: number;
  /** Share of values that read like a sentence (≥ 4 words with letters). */
  sentences: number;
  /** Few distinct short values (status, kind, role). */
  enumLike: boolean;
}

export type Verdict = 'data' | 'telemetry' | 'derived' | 'secret' | 'other' | 'view' | 'unreadable' | 'sensitive-unchosen';
export interface TableProfile {
  /** The name rows are stored under (Postgres: "schema.table"). */
  key: string;
  name: string;
  schema?: string;
  columns: ColumnProfile[];
  pk: string[];
  fks: { from: string; table: string; to: string; inferred?: boolean }[];
  rows: number;
  /** Rows the collector packed (0 for skipped tables: only their samples are in the bundle). */
  packed: number;
  newest: string | null;
  verdict: Verdict;
  why: string;
  /** §8.2: the signals that fired (name, shape, volume, no-owner-words). */
  telemetry: string[];
  cats: string[];
  /** ≤ 5 rows from the bundle (shown only after scrubbing; never sent anywhere unmasked). */
  samples: Row[];
}

export interface Family {
  /** Stable id inside the store ("people", "memories"…; suffixed when taken). */
  id: string;
  title: string;
  tables: string[];
  /** sha256 of the sorted table + column names (§8.5: saved mappings are reused by it). */
  fingerprint: string;
  /** Postgres schema other than public (§8.6: a family of its own). */
  schema?: string;
}

export interface StoreProfile {
  id: string;
  /** "stores/<id>/" in the bundle. */
  path: string;
  label: string;
  kind: 'sqlite' | 'postgres';
  tables: TableProfile[];
  families: Family[];
  /** Sorted table + column names of the whole store, hashed. */
  fingerprint: string;
}

const SCAN_ROWS = 1000;
/** §8.2 name signal (word-bounded). */
const TELE_WORD = /^(log|logs|event|events|trace|traces|span|spans|metric|metrics|telemetry|audit|audits|heartbeat|heartbeats|tick|ticks|run|runs|step|steps|attempt|attempts|debug|perf|usage|cost|costs|latency|latencies|queue|queues|cache|caches|checkpoint|checkpoints|snapshot|snapshots|lease|leases|outbox|stat|stats|ping|pings|poll|polls|sample|samples|reading|readings|loop|loops|autonomy|tokens?)$/;
const TELE_PHRASE = /(^|_)(decision_log|job_runs?|session_state|inbox_raw|tool_calls?|api_calls?)(_|$)|^(autonomy|loop|tokens?)_/;
/** Recognised Sara-irrelevant tables, each with its own reason (§8.2 last line). */
const DERIVED: [RegExp, string][] = [
  [/(^sqlite_|_fts$|_fts_(data|idx|docsize|config|content)$|_fts\d*$|^fts_|_segments$|_segdir$)/i, 'a search index (Sara builds her own)'],
  [/(^vec_|_vec$|_vectors?$|^vectors?$|_embeddings?$|^embeddings?$|_emb$)/i, 'embeddings (Sara makes her own with her model)'],
  [/(^|_)(schema_)?migrations?$|^alembic_version$|^knex_|^_prisma|^flyway|^__drizzle|^schema_version$/i, 'database migrations'],
  [/(^|_)(locks?|mutex|leases?)$/i, 'locks (internal)'],
];
const SECRET = /(^|_)(auth|oauth|tokens?|secrets?|credentials?|api_?keys?|sessions?_keys?|passwords?|cookies?)$/i;
const DATE_NAME = /(^|_)(at|on|date|time|ts|timestamp|created|updated|modified|when|day|observed|seen|started|ended|due)$|^(created|updated|modified|date|time|timestamp|ts)/i;
const UPDATED = /^(updated|modified|edited|changed)(_at|_on)?$|_updated_at$/i;

export const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** "persons" → "person", "facts" → "fact", "entries" → "entry". */
export function singular(w: string): string {
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(as|us|is|ss)es$/.test(w)) return w.slice(0, -2);
  if (/(ss|us|is|as)$/.test(w)) return w;
  if (/(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && w.length > 3) return w.slice(0, -1);
  if (w === 'people') return 'person';
  return w;
}

function isDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s.trim());
}
const epochKind = (n: number): 'epoch' | 'ms' | undefined => (n > 946_684_800 && n < 4_102_444_800 ? 'epoch' : n > 946_684_800_000 && n < 4_102_444_800_000 ? 'ms' : undefined);

function valueKind(v: unknown): Observed {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('$blob' in o || '$skipped' in o) return 'blob';
    if ('$date' in o) return 'date';
    return 'json';
  }
  const s = String(v);
  if (isDateString(s)) return 'date';
  if (/^-?\d+$/.test(s.trim()) && s.length < 16) return 'int';
  if (/^\s*[[{]/.test(s) && /[\]}]\s*$/.test(s)) return 'json';
  return 'text';
}

/** One column's profile from the scanned values. */
export function profileColumn(c: ColumnInfo, values: unknown[]): ColumnProfile {
  const n = values.length || 1;
  const kinds = new Map<Observed, number>();
  let nulls = 0;
  let textLen = 0;
  let texts = 0;
  let sentences = 0;
  const distinct = new Set<string>();
  let epoch: 'epoch' | 'ms' | undefined;
  for (const v of values) {
    const k = valueKind(v);
    if (k === 'null') {
      nulls++;
      continue;
    }
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
    if (distinct.size < 5000) distinct.add(typeof v === 'object' ? JSON.stringify(v) : String(v));
    if (k === 'text') {
      const s = String(v);
      textLen += s.length;
      texts++;
      if ((s.match(/\p{L}{2,}/gu) ?? []).length >= 4) sentences++;
    }
    if ((k === 'int' || k === 'float') && DATE_NAME.test(c.name)) epoch ??= epochKind(Number(v));
  }
  const present = values.length - nulls;
  let observed: Observed = 'null';
  if (present > 0 && kinds.size) {
    const [top, cnt] = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    observed = cnt / present >= 0.9 ? top : 'mixed';
  }
  const dateCol = observed === 'date' ? 'iso' : (observed === 'int' || observed === 'float') && epoch ? epoch : undefined;
  const t = c.type.toUpperCase();
  return {
    name: c.name,
    type: c.type,
    observed: observed === 'null' && /CHAR|TEXT|CLOB/.test(t) ? 'text' : observed,
    nullShare: nulls / n,
    distinctRatio: present ? distinct.size / present : 0,
    ...(dateCol ? { date: dateCol } : {}),
    looksId: Boolean(c.pk) || /^(id|uuid|guid|key)$|_(id|uuid|key|ref)$/i.test(c.name),
    avgLen: texts ? textLen / texts : 0,
    sentences: present ? sentences / present : 0,
    enumLike: present >= 5 && distinct.size <= Math.max(3, Math.ceil(present * 0.05)) && (observed === 'text' || observed === 'int'),
  };
}

/** §8.2: ≥ 2 of name, shape, volume, no owner words → telemetry. */
export function telemetrySignals(t: { name: string; rows: number; columns: ColumnProfile[]; dates: number[] }): string[] {
  const out: string[] = [];
  const w = wordsOf(t.name);
  if (w.some((x) => TELE_WORD.test(x)) || TELE_PHRASE.test(w.join('_'))) out.push('name');
  const cols = t.columns.filter((c) => !c.looksId || !c.name.match(/^id$/i));
  const machine = cols.filter((c) => c.observed === 'int' || c.observed === 'float' || c.observed === 'bool' || c.observed === 'json' || c.observed === 'blob' || c.observed === 'date' || c.date || c.enumLike || c.looksId).length;
  const humanText = cols.filter((c) => c.observed === 'text' && !c.enumLike && !c.looksId && !c.date);
  const avgHuman = humanText.length ? humanText.reduce((n, c) => n + c.avgLen, 0) / humanText.length : 0;
  // Logs are timestamped and never edited: append-only is required, plus machine-shaped columns or terse text.
  const appendOnly = t.columns.some((c) => c.date || /^(ts|timestamp|logged_at|at|time)$/i.test(c.name)) && !t.columns.some((c) => UPDATED.test(c.name));
  const shape = appendOnly && (cols.length > 0 && machine / cols.length >= 0.7 || avgHuman < 40);
  if (shape) out.push('shape');
  if (t.rows > 50_000) {
    // Busiest month > 1 000 rows a day (from the scanned dates; without dates the volume alone counts).
    const days = new Map<string, number>();
    for (const d of t.dates) days.set(new Date(d).toISOString().slice(0, 10), (days.get(new Date(d).toISOString().slice(0, 10)) ?? 0) + 1);
    const span = t.dates.length > 1 ? (Math.max(...t.dates) - Math.min(...t.dates)) / 86_400_000 : 0;
    const perDay = span > 0 ? t.dates.length / span : t.dates.length > 1 ? Infinity : 0;
    if (perDay > 1000 || !t.dates.length) out.push('volume');
  }
  if (!t.columns.some((c) => (c.observed === 'text' || c.observed === 'mixed') && c.sentences >= 0.3 && c.avgLen >= 20)) out.push('no-owner-words');
  return out;
}

function dateOf(c: ColumnProfile, v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (c.date === 'epoch') return Number(v) * 1000;
  if (c.date === 'ms') return Number(v);
  if (c.date === 'iso') {
    const d = Date.parse(typeof v === 'object' ? String((v as { $date?: string }).$date) : String(v));
    return Number.isNaN(d) ? undefined : d;
  }
  return undefined;
}

async function jsonl(b: Bundle, name: string, max: number): Promise<Row[]> {
  const out: Row[] = [];
  if (!b.has(name)) return out;
  for await (const line of b.lines(name)) {
    if (out.length >= max) break;
    try {
      const o = JSON.parse(line) as { r?: Row };
      if (o.r && typeof o.r === 'object') out.push(o.r);
    } catch {
      /* a damaged line */
    }
  }
  return out;
}
export const fileName = (key: string): string => key.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Reads a store's schema and builds its table profiles and families (§8.1). */
export async function profileStore(b: Bundle, path: string, signal?: AbortSignal): Promise<StoreProfile | undefined> {
  let schema: StoreSchemaFile;
  try {
    schema = JSON.parse(await b.text(`${path}schema.json`, 64 * 1024 * 1024)) as StoreSchemaFile;
  } catch {
    return undefined;
  }
  const isPg = schema.kind === 'postgres';
  const tables: TableProfile[] = [];
  const scanned = new Map<string, Row[]>();
  for (const t of schema.tables ?? []) {
    if (signal?.aborted) break;
    const key = isPg && t.schema ? `${t.schema}.${t.name}` : t.name;
    const samples = await jsonl(b, `${path}samples/${fileName(key)}.jsonl`, 5);
    const packed = t.written ?? 0;
    const scan: Row[] = [];
    if (packed > 0) {
      for await (const r of rows(b, path, key, signal)) {
        scan.push(r);
        if (scan.length >= SCAN_ROWS) break;
      }
    }
    const pool = scan.length ? scan : samples;
    scanned.set(key, pool);
    const columns = (t.columns ?? []).map((c) => profileColumn(c, pool.map((r) => r[c.name])));
    const dates: number[] = [];
    let newest: number | undefined;
    for (const c of columns.filter((x) => x.date)) {
      for (const r of pool) {
        const d = dateOf(c, r[c.name]);
        if (d === undefined) continue;
        dates.push(d);
        if (newest === undefined || d > newest) newest = d;
      }
    }
    const pk = t.primaryKey?.length ? t.primaryKey : (t.columns ?? []).filter((c) => c.pk).map((c) => c.name);
    const p: TableProfile = {
      key,
      name: t.name,
      ...(t.schema ? { schema: t.schema } : {}),
      columns,
      pk: pk.length ? pk : columns.filter((c) => /^(id|uuid)$/i.test(c.name)).map((c) => c.name).slice(0, 1),
      fks: (t.foreignKeys ?? []).map((f) => ({ from: f.from, table: f.table, to: f.to })),
      rows: Number(t.rows) || 0,
      packed,
      newest: newest !== undefined ? new Date(newest).toISOString() : null,
      verdict: 'data',
      why: '',
      telemetry: [],
      cats: t.cats ?? [],
      samples,
    };
    // The verdict: the collector's skips stand (secrets, derived, sensitive-unchosen); the rest is recomputed.
    const derived = DERIVED.find(([re]) => re.test(t.name));
    const kind = (t.kind ?? '').toUpperCase();
    if (t.verdict === 'secret' || SECRET.test(t.name)) [p.verdict, p.why] = ['secret', 'looks like sign-ins or keys: never collected'];
    else if (t.verdict === 'sensitive-unchosen') [p.verdict, p.why] = ['sensitive-unchosen', t.why || 'you said no at collection'];
    else if (kind === 'MATERIALIZED VIEW') [p.verdict, p.why] = ['derived', 'a materialized view (made from other tables)'];
    else if (kind === 'VIEW') [p.verdict, p.why] = ['view', 'a view: its tables are read instead'];
    else if (t.verdict === 'derived' || derived) [p.verdict, p.why] = ['derived', derived?.[1] ?? t.why ?? 'internal'];
    else if (t.verdict === 'unreadable') [p.verdict, p.why] = ['unreadable', t.why || "couldn't be read"];
    else if (t.verdict === 'other') [p.verdict, p.why] = ['other', t.why || 'not part of a move-in'];
    else {
      p.telemetry = telemetrySignals({ name: t.name, rows: p.rows, columns, dates });
      if (p.telemetry.length >= 2) [p.verdict, p.why] = ['telemetry', `a log or telemetry table (${p.telemetry.join(', ')})`];
      else if (t.verdict === 'telemetry') [p.verdict, p.why] = ['telemetry', 'the collector skipped it as a log or telemetry table'];
    }
    tables.push(p);
  }
  // A table other data tables point at (people, threads) is their parent, never a log of them.
  for (const t of tables) {
    if (t.verdict !== 'telemetry' || !t.telemetry.length) continue;
    if (tables.some((o) => o !== t && o.verdict === 'data' && o.fks.some((f) => f.table === t.key))) [t.verdict, t.why, t.telemetry] = ['data', '', []];
  }
  inferForeignKeys(tables, scanned);
  return {
    id: schema.id,
    path,
    // Postgres sources read "postgres://alex@host:5432/app?sslmode=prefer (password not stored)": the card says "app".
    label: String(schema.source ?? schema.id).replace(/ \(password not stored\)$/, '').replace(/\?.*$/, '').split('/').at(-1)!,
    kind: isPg ? 'postgres' : 'sqlite',
    tables,
    families: families(tables),
    fingerprint: fingerprint(tables.map((t) => ({ name: t.key, columns: t.columns.map((c) => c.name) }))),
  };
}

/** `<x>_id` columns whose values exist in table `<x>`/`<x>s` (or most of them, on the scanned rows). */
export function inferForeignKeys(tables: TableProfile[], scanned: Map<string, Row[]>): void {
  const byWord = new Map<string, TableProfile>();
  for (const t of tables) if (t.verdict === 'data') byWord.set(singular(wordsOf(t.name).join('_')), t);
  for (const t of tables) {
    if (t.verdict !== 'data') continue;
    for (const c of t.columns) {
      const m = /^(.+?)_?(id|uuid|key)$/i.exec(c.name);
      if (!m || t.pk.includes(c.name) || t.fks.some((f) => f.from === c.name)) continue;
      const parent = byWord.get(singular(wordsOf(m[1]).join('_')));
      if (!parent || parent === t || !parent.pk.length) continue;
      const ids = new Set((scanned.get(parent.key) ?? []).map((r) => String(r[parent.pk[0]])));
      const vals = (scanned.get(t.key) ?? []).map((r) => r[c.name]).filter((v) => v !== null && v !== undefined).map(String);
      const hit = vals.filter((v) => ids.has(v)).length;
      // Proof by values when the parent was scanned whole; otherwise the name has to do.
      if (!vals.length || hit / vals.length >= 0.8 || parent.packed > (scanned.get(parent.key)?.length ?? 0)) t.fks.push({ from: c.name, table: parent.key, to: parent.pk[0], inferred: true });
    }
  }
}

/** Sorted table + column names, hashed (no data inside: safe to share). */
export function fingerprint(tables: { name: string; columns: string[] }[]): string {
  const lines = tables.map((t) => `${t.name}:${[...t.columns].sort().join(',')}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Families: data tables joined by foreign keys and shared name prefixes (§8.1); Postgres schemas apart (§8.6). */
export function families(tables: TableProfile[]): Family[] {
  const data = tables.filter((t) => t.verdict === 'data');
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let x = k;
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const join = (a: string, b: string) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(y, x);
  };
  for (const t of data) parent.set(t.key, t.key);
  const schemaOf = (k: string) => data.find((t) => t.key === k)?.schema ?? '';
  // Foreign keys, except to hub tables many others point at (a "users" table would swallow everything).
  const children = new Map<string, number>();
  for (const t of data) for (const f of t.fks) children.set(f.table, (children.get(f.table) ?? 0) + 1);
  for (const t of data) for (const f of t.fks) if (parent.has(f.table) && (children.get(f.table) ?? 0) <= 4 && schemaOf(f.table) === (t.schema ?? '')) join(f.table, t.key);
  // Shared prefixes: person, person_fact, person_alias → one family.
  const head = (t: TableProfile) => singular(wordsOf(t.name)[0] ?? t.name);
  const byHead = new Map<string, string>();
  for (const t of data) {
    const h = `${t.schema ?? ''}|${head(t)}`;
    if (head(t).length < 3) continue;
    if (byHead.has(h)) join(byHead.get(h)!, t.key);
    else byHead.set(h, t.key);
  }
  const groups = new Map<string, TableProfile[]>();
  for (const t of data) {
    const r = find(t.key);
    groups.set(r, [...(groups.get(r) ?? []), t]);
  }
  const taken = new Set<string>();
  const out: Family[] = [];
  for (const list of [...groups.values()].sort((a, b) => b.reduce((n, t) => n + t.rows, 0) - a.reduce((n, t) => n + t.rows, 0))) {
    // Named after the table the others point at (or the biggest).
    const pointed = list.map((t) => ({ t, n: list.filter((o) => o.fks.some((f) => f.table === t.key)).length })).sort((a, b) => b.n - a.n || b.t.rows - a.t.rows);
    const main = pointed[0].t;
    let id = `${main.schema && main.schema !== 'public' ? `${main.schema}-` : ''}${singular(wordsOf(main.name).join('-')) || 'table'}`.slice(0, 60);
    for (let k = 2; taken.has(id); k++) id = `${id.replace(/-\d+$/, '')}-${k}`;
    taken.add(id);
    out.push({
      id,
      title: main.name,
      tables: list.sort((a, b) => (a === main ? -1 : b === main ? 1 : a.key.localeCompare(b.key))).map((t) => t.key),
      fingerprint: fingerprint(list.map((t) => ({ name: t.key, columns: t.columns.map((c) => c.name) }))),
      ...(main.schema && main.schema !== 'public' ? { schema: main.schema } : {}),
    });
  }
  return out;
}
