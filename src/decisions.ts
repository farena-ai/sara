// E5 (docs/DECISIONS_HELPER.md): the decision helper and side-by-side comparisons. She helps the
// person decide; she never decides for them. The math is here, in code: every score is a 1–10
// rating or a raw value with its unit (normalized min-max per criterion, direction aware), weights
// are 1–5, totals are weighted means out of 100, and a sensitivity check says whether the winner
// changes when one weight moves by one or the winner's narrowest lead is swapped. Every score
// carries where it came from ("you said", "from <source>", "my estimate", flagged). Decisions live
// in the space's own database (each household member has their own), are recorded when the person
// picks, can set a planner reminder to revisit, and keep the outcome so a later, similar decision
// can recall "last time you chose …". `compare` lays out given values side by side and marks
// what is missing; it never fills anything in.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { formatLocal, parseWhen } from './planner.ts';
import { ToolError, type Tool } from './tools/types.ts';

// ---------------------------------------------------------------------------------------------
// input and math (pure)
// ---------------------------------------------------------------------------------------------

export interface Criterion {
  name: string;
  weight: number;
  higher_is_better?: boolean;
  /** "rating" (1–10) or "raw" (values with units, min-max); auto when left out. */
  scale?: 'rating' | 'raw';
}
export type ScoreValue = number | string | { value: unknown; source?: string };
export type ScoreRow = { option: string; criterion: string; value: unknown; source?: string };
export interface DecisionInput {
  question: string;
  options: string[];
  criteria: Criterion[];
  scores?: Record<string, Record<string, ScoreValue>> | ScoreRow[];
  notes?: string;
}

export interface Cell {
  criterion: string;
  /** What was given ("$24,000", "7"), or null when missing. */
  shown: string | null;
  value: number | null;
  unit: string;
  kind: 'rating' | 'raw' | 'missing';
  /** 0..1, direction already applied. */
  norm: number;
  source: string;
  estimate: boolean;
  unsourced: boolean;
}
export interface Row {
  option: string;
  total: number;
  rank: number;
  cells: Cell[];
}
export interface Flip {
  kind: 'weight' | 'swap';
  criterion: string;
  delta?: number;
  weight?: number;
  winner: string;
}
export interface Factor {
  criterion: string;
  /** Points out of 100 the winner gains (+) or loses (−) against the runner-up on this criterion. */
  points: number;
}
export interface DecisionResult {
  question: string;
  criteria: { name: string; weight: number; higher_is_better: boolean }[];
  rows: Row[];
  tie: boolean;
  closeCall: boolean;
  robust: boolean;
  flips: Flip[];
  factors: Factor[];
  estimates: number;
  unsourced: number;
  missing: { option: string; criterion: string }[];
}

const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const key = (s: string): string => s.trim().toLowerCase();
const EPS = 0.005;

/** A number from what was given: 7, "7", "$24,000", "400 mi", "4.5 stars", "1.2k". Null when there is none. */
export function parseValue(v: unknown): { n: number; unit: string } | null {
  if (typeof v === 'number') return Number.isFinite(v) ? { n: v, unit: '' } : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(US\$|[$€£¥₹])?\s*([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+))\s*([kKmM](?![a-zA-Z]))?\s*(.*?)\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, '')) * (m[3] ? (m[3].toLowerCase() === 'k' ? 1e3 : 1e6) : 1);
  if (!Number.isFinite(n)) return null;
  return { n, unit: m[1] ?? clip(m[4], 20) };
}

function sourceLabel(s: unknown): { label: string; estimate: boolean; unsourced: boolean } {
  const v = clip(s, 80);
  const k = v.toLowerCase();
  if (!v) return { label: 'source not given', estimate: false, unsourced: true };
  if (/^(you|you said|person|user|owner|me|mine|their rating|your rating)$/.test(k)) return { label: 'you said', estimate: false, unsourced: false };
  if (/^(estimate|my estimate|estimated|guess|her estimate|sara)$/.test(k)) return { label: 'my estimate', estimate: true, unsourced: false };
  return { label: k.startsWith('from ') ? v : `from ${v}`, estimate: false, unsourced: false };
}

/** Checks and tidies the input (ToolError with what to fix). */
type CleanCriterion = { name: string; weight: number; higher_is_better: boolean; scale?: 'rating' | 'raw' };
export function cleanInput(input: DecisionInput): DecisionInput & { criteria: CleanCriterion[] } {
  const question = clip(input.question, 300);
  if (!question) throw new ToolError('Give the question being decided ("Which car should I buy?").');
  const options: string[] = [];
  for (const o of Array.isArray(input.options) ? input.options : []) {
    const name = clip(o, 120);
    if (name && !options.some((x) => key(x) === key(name))) options.push(name);
  }
  if (options.length < 2) throw new ToolError('Give at least two options to choose between.');
  if (options.length > 12) throw new ToolError('Up to 12 options; narrow it down first.');
  const raw = Array.isArray(input.criteria) ? input.criteria : [];
  if (!raw.length) throw new ToolError('Give the criteria that matter (name and weight 1–5). If you don\'t know them, ask the person what matters most.');
  if (raw.length > 12) throw new ToolError('Up to 12 criteria; keep the ones that matter most.');
  const criteria = raw.map((c): CleanCriterion => {
    const name = clip(c?.name, 80);
    if (!name) throw new ToolError('Every criterion needs a name.');
    const weight = Number(c.weight ?? 3);
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new ToolError(`The weight of "${name}" must be a whole number from 1 (matters a little) to 5 (matters most).`);
    const lower = c.higher_is_better === false || /^(lower|less|min)/i.test(String((c as { direction?: unknown }).direction ?? ''));
    return { name, weight, higher_is_better: !lower, ...(c.scale === 'rating' || c.scale === 'raw' ? { scale: c.scale } : {}) };
  });
  return { question, options, criteria, ...(input.scores ? { scores: input.scores } : {}), ...(input.notes ? { notes: clip(input.notes, 2000) } : {}) };
}

function lookup(input: DecisionInput, option: string, criterion: string): { value: unknown; source?: string } | undefined {
  const s = input.scores;
  if (!s) return undefined;
  if (Array.isArray(s)) {
    const r = s.find((x) => x && key(String(x.option ?? '')) === key(option) && key(String(x.criterion ?? '')) === key(criterion));
    return r ? { value: r.value, source: r.source } : undefined;
  }
  const byOpt = Object.entries(s).find(([k]) => key(k) === key(option))?.[1];
  if (!byOpt || typeof byOpt !== 'object') return undefined;
  const v = Object.entries(byOpt).find(([k]) => key(k) === key(criterion))?.[1];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'object' ? { value: (v as { value: unknown }).value, source: (v as { source?: string }).source } : { value: v };
}

function totals(rows: { cells: { norm: number }[] }[], weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  return rows.map((r) => (r.cells.reduce((a, c, i) => a + c.norm * weights[i], 0) / sum) * 100);
}
const leader = (t: number[]): number => t.reduce((best, v, i) => (v > t[best] + 1e-12 ? i : best), 0);

/** The whole calculation: normalized scores, weighted totals, ranks, close call, sensitivity, factors. */
export function scoreDecision(input: DecisionInput): DecisionResult {
  const d = cleanInput(input);
  const cells: Cell[][] = d.options.map(() => []);
  d.criteria.forEach((c) => {
    const given = d.options.map((o) => {
      const g = lookup(d, o, c.name);
      const p = g ? parseValue(g.value) : null;
      return { g, p };
    });
    const nums = given.filter((x) => x.p).map((x) => x.p!);
    const rating = c.scale ? c.scale === 'rating' : nums.length > 0 && nums.every((p) => p.n >= 1 && p.n <= 10 && (!p.unit || /^\/\s*10$|^(stars?|points?|pts)$/i.test(p.unit)));
    const min = Math.min(...nums.map((p) => p.n));
    const max = Math.max(...nums.map((p) => p.n));
    given.forEach(({ g, p }, i) => {
      const src = sourceLabel(g?.source);
      if (!p) {
        cells[i].push({ criterion: c.name, shown: null, value: null, unit: '', kind: 'missing', norm: 0, source: '', estimate: false, unsourced: false });
        return;
      }
      let n = rating ? (Math.min(10, Math.max(1, p.n)) - 1) / 9 : max === min ? 1 : (p.n - min) / (max - min);
      if (!c.higher_is_better) n = rating ? 1 - n : max === min ? 1 : 1 - n;
      cells[i].push({ criterion: c.name, shown: clip(typeof g!.value === 'number' ? String(g!.value) : g!.value, 40), value: p.n, unit: p.unit, kind: rating ? 'rating' : 'raw', norm: n, source: src.label, estimate: src.estimate, unsourced: src.unsourced });
    });
  });
  const weights = d.criteria.map((c) => c.weight);
  const t = totals(cells.map((c) => ({ cells: c })), weights);
  const order = d.options.map((o, i) => ({ option: o, total: t[i], cells: cells[i], i })).sort((a, b) => b.total - a.total || a.i - b.i);
  const rows: Row[] = [];
  order.forEach((r, k) => rows.push({ option: r.option, total: r.total, cells: r.cells, rank: k > 0 && Math.abs(order[k - 1].total - r.total) < EPS ? rows[k - 1].rank : k + 1 }));
  const [top, second] = rows;
  const tie = Math.abs(top.total - second.total) < EPS;
  const closeCall = tie || top.total <= 0 || (top.total - second.total) / top.total < 0.05;
  const flips: Flip[] = [];
  const factors: Factor[] = [];
  if (!tie) {
    const wi = order[0].i;
    const ri = order[1].i;
    const sum = weights.reduce((a, b) => a + b, 0);
    // One weight moved by one (kept within 1..5).
    d.criteria.forEach((c, ci) => {
      for (const delta of [-1, 1]) {
        const w = c.weight + delta;
        if (w < 1 || w > 5) continue;
        const ws = weights.map((x, j) => (j === ci ? w : x));
        const tt = totals(cells.map((x) => ({ cells: x })), ws);
        const l = leader(tt);
        if (l !== wi && tt[l] > tt[wi] + EPS / 10) flips.push({ kind: 'weight', criterion: c.name, delta, weight: w, winner: d.options[l] });
      }
    });
    // The winner's narrowest lead over the runner-up, swapped ("the closest scores").
    let best = -1;
    let gap = Infinity;
    d.criteria.forEach((_c, ci) => {
      const g = cells[wi][ci].norm - cells[ri][ci].norm;
      // Only a close pair (within a fifth of the scale) is a fair "what if these were the other way".
      if (g > 1e-9 && g < 0.2 && g < gap) {
        gap = g;
        best = ci;
      }
    });
    if (best >= 0) {
      const swapped = cells.map((row, j) => ({ cells: row.map((x, ci) => (ci !== best ? x : j === wi ? cells[ri][ci] : j === ri ? cells[wi][ci] : x)) }));
      const tt = totals(swapped, weights);
      if (tt[ri] > tt[wi] + EPS / 10) flips.push({ kind: 'swap', criterion: d.criteria[best].name, winner: d.options[ri] });
    }
    d.criteria.forEach((c, ci) => {
      const points = (c.weight * (cells[wi][ci].norm - cells[ri][ci].norm) * 100) / sum;
      if (Math.abs(points) > 0.05) factors.push({ criterion: c.name, points });
    });
    factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  }
  const all = cells.flat();
  const missing: { option: string; criterion: string }[] = [];
  cells.forEach((row, i) => row.forEach((c) => c.kind === 'missing' && missing.push({ option: d.options[i], criterion: c.criterion })));
  return { question: d.question, criteria: d.criteria.map(({ name, weight, higher_is_better }) => ({ name, weight, higher_is_better: higher_is_better !== false })), rows, tie, closeCall, robust: !tie && flips.length === 0, flips, factors, estimates: all.filter((c) => c.estimate).length, unsourced: all.filter((c) => c.unsourced).length, missing };
}

const pct = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
const esc = (s: string): string => s.replace(/\|/g, '/').replace(/\n/g, ' ');

/** The ranked list, the table with every score's source, the deciding factors and the checks, as text. */
export function resultText(r: DecisionResult): string {
  const out: string[] = [];
  out.push('Ranked (weighted score out of 100):');
  for (const row of r.rows) out.push(`${row.rank}. ${row.option} ${pct(row.total)}`);
  out.push('', `| Option | ${r.criteria.map((c) => esc(`${c.name} (weight ${c.weight}${c.higher_is_better ? '' : ', lower is better'})`)).join(' | ')} | Score |`, `|---|${r.criteria.map(() => '---').join('|')}|---|`);
  for (const row of r.rows) out.push(`| ${esc(row.option)} | ${row.cells.map((c) => (c.kind === 'missing' ? '— (missing)' : esc(`${c.shown} (${c.source}${c.estimate ? ' *' : ''})`))).join(' | ')} | ${pct(row.total)} |`);
  const [a, b] = r.rows;
  out.push('');
  if (r.tie) out.push(`Tie: ${a.option} and ${b.option} score the same. The numbers don't decide this one; ask what matters most to them.`);
  else {
    out.push(`${r.closeCall ? 'Close call' : 'Lead'}: ${a.option} ahead of ${b.option} by ${pct(a.total - b.total)} points${r.closeCall ? ' (within 5%). Say plainly that it is a close call.' : '.'}`);
    if (r.factors.length) out.push(`Deciding factors (${a.option} vs ${b.option}): ${r.factors.slice(0, 4).map((f) => `${f.criterion} ${f.points > 0 ? '+' : '−'}${pct(Math.abs(f.points))}`).join(', ')}.`);
    if (r.flips.length) out.push(`Sensitive: ${r.flips.map((f) => (f.kind === 'weight' ? `${f.criterion} weight ${f.weight} → ${f.winner} wins` : `swapping ${a.option}'s and ${b.option}'s ${f.criterion} scores → ${f.winner} wins`)).join('; ')}.`);
    else out.push('Robust: no single weight change of ±1 and no swap of the closest scores changes the winner.');
  }
  if (r.estimates) out.push(`${r.estimates} score(s) are my estimates (marked *): say so, and offer to check them.`);
  if (r.unsourced) out.push(`${r.unsourced} score(s) have no source: say where they came from or mark them as estimates.`);
  if (r.missing.length) out.push(`Missing (counted as zero): ${r.missing.map((m) => `${m.option} / ${m.criterion}`).join(', ')}. Fill them in or say they're unknown.`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// compare (pure)
// ---------------------------------------------------------------------------------------------

export interface CompareInput {
  title?: string;
  items: unknown[];
  attributes?: string[];
}
export interface CompareResult {
  title: string;
  attributes: string[];
  rows: { name: string; source?: string; cells: { attribute: string; value: string | null }[] }[];
  missing: number;
  text: string;
}
const NAME_KEYS = ['name', 'title', 'option', 'product', 'item', 'label'];

/** A side-by-side table of the values given; missing ones stay missing (—). */
export function compareTable(input: CompareInput): CompareResult {
  const items = Array.isArray(input.items) ? input.items.slice(0, 20) : [];
  if (items.length < 1) throw new ToolError('Give the items to compare (names, or rows with their values).');
  const parsed = items.map((it, i) => {
    if (typeof it === 'string' || typeof it === 'number') return { name: clip(it, 120), values: {} as Record<string, unknown> };
    const o = (it ?? {}) as Record<string, unknown>;
    const nameKey = Object.keys(o).find((k) => NAME_KEYS.includes(k.toLowerCase()));
    const values: Record<string, unknown> = o.values && typeof o.values === 'object' ? { ...(o.values as Record<string, unknown>) } : Object.fromEntries(Object.entries(o).filter(([k]) => !NAME_KEYS.includes(k.toLowerCase()) && k !== 'values' && k !== 'source'));
    return { name: clip(nameKey ? o[nameKey] : `Item ${i + 1}`, 120) || `Item ${i + 1}`, values, ...(o.source ? { source: clip(o.source, 80) } : {}) };
  });
  let attributes = (Array.isArray(input.attributes) ? input.attributes : []).map((a) => clip(a, 60)).filter(Boolean);
  if (!attributes.length) {
    for (const p of parsed) for (const k of Object.keys(p.values)) if (!attributes.some((a) => key(a) === key(k))) attributes.push(k);
  }
  attributes = attributes.slice(0, 20);
  if (!attributes.length) throw new ToolError('Give the attributes to compare (price, size, rating…) and their values.');
  let missing = 0;
  const rows = parsed.map((p) => ({
    name: p.name,
    ...(p.source ? { source: p.source } : {}),
    cells: attributes.map((a) => {
      const v = Object.entries(p.values).find(([k]) => key(k) === key(a))?.[1];
      const s = v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v)) ? '' : clip(Array.isArray(v) ? v.join(', ') : v, 120);
      if (!s) missing++;
      return { attribute: a, value: s || null };
    }),
  }));
  const title = clip(input.title, 120) || 'Comparison';
  const text = [
    `${title}:`,
    `| Item | ${attributes.map(esc).join(' | ')} |`,
    `|---|${attributes.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${esc(r.name)} | ${r.cells.map((c) => (c.value === null ? '—' : esc(c.value))).join(' | ')} |`),
    rows.some((r) => r.source) ? `Sources: ${rows.filter((r) => r.source).map((r) => `${r.name}: ${r.source}`).join('; ')}.` : '',
    missing ? `${missing} values missing (marked —); nothing was filled in. Say what's missing, or look it up and compare again.` : 'Every value was given.',
  ].filter(Boolean).join('\n');
  return { title, attributes, rows, missing, text };
}

// ---------------------------------------------------------------------------------------------
// store (the space's own database)
// ---------------------------------------------------------------------------------------------

export type DecisionStatus = 'open' | 'chosen' | 'reviewed';
export interface Decision {
  id: number;
  question: string;
  input: DecisionInput;
  status: DecisionStatus;
  chosen: string | null;
  why: string | null;
  revisitAt: string | null;
  reminderId: number | null;
  outcome: string | null;
  rating: number | null;
  conversationId: string | null;
  createdAt: string;
  decidedAt: string | null;
  reviewedAt: string | null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  chosen TEXT, why TEXT, revisit_at TEXT, reminder_id INTEGER,
  outcome TEXT, rating INTEGER,
  conversation_id TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS decisions_created ON decisions(created_at DESC);`;

type DbRow = Record<string, unknown>;

export class DecisionStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(SCHEMA);
  }
  #row(r: DbRow): Decision {
    const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
    return {
      id: Number(r.id),
      question: String(r.question),
      input: JSON.parse(String(r.input)) as DecisionInput,
      status: (['open', 'chosen', 'reviewed'].includes(String(r.status)) ? r.status : 'open') as DecisionStatus,
      chosen: s('chosen'),
      why: s('why'),
      revisitAt: s('revisit_at'),
      reminderId: r.reminder_id === null || r.reminder_id === undefined ? null : Number(r.reminder_id),
      outcome: s('outcome'),
      rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
      conversationId: s('conversation_id'),
      createdAt: String(r.created_at),
      decidedAt: s('decided_at'),
      reviewedAt: s('reviewed_at'),
    };
  }
  add(input: DecisionInput, conversationId: string | null = null): Decision {
    const id = this.#db.prepare('INSERT INTO decisions (question, input, conversation_id, created_at) VALUES (?, ?, ?, ?)').run(input.question, JSON.stringify(input), conversationId, this.#now().toISOString()).lastInsertRowid;
    return this.get(Number(id))!;
  }
  get(id: number): Decision | undefined {
    const r = this.#db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DbRow | undefined;
    return r ? this.#row(r) : undefined;
  }
  list(o: { status?: DecisionStatus | 'all'; limit?: number } = {}): Decision[] {
    const st = o.status && o.status !== 'all' ? o.status : null;
    return (this.#db.prepare(`SELECT * FROM decisions ${st ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(st ? [st, o.limit ?? 50] : [o.limit ?? 50])) as DbRow[]).map((r) => this.#row(r));
  }
  /** The person picked: the option's own spelling when it is one of the options. */
  choose(id: number, chosen: string, why?: string | null): Decision {
    const d = this.get(id);
    if (!d) throw new ToolError(`No decision #${id}.`);
    const c = clip(chosen, 120);
    if (!c) throw new ToolError('Say which option they chose.');
    const name = d.input.options.find((o) => key(o) === key(c)) ?? c;
    this.#db.prepare("UPDATE decisions SET chosen = ?, why = ?, status = CASE WHEN status = 'reviewed' THEN status ELSE 'chosen' END, decided_at = ? WHERE id = ?").run(name, why ? clip(why, 1000) : null, this.#now().toISOString(), id);
    return this.get(id)!;
  }
  setRevisit(id: number, at: string, reminderId: number | null): void {
    this.#db.prepare('UPDATE decisions SET revisit_at = ?, reminder_id = ? WHERE id = ?').run(at, reminderId, id);
  }
  review(id: number, outcome: string, rating: number): Decision {
    const d = this.get(id);
    if (!d) throw new ToolError(`No decision #${id}.`);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ToolError('The rating is a whole number from 1 (went badly) to 5 (went great).');
    this.#db.prepare("UPDATE decisions SET outcome = ?, rating = ?, status = 'reviewed', reviewed_at = ? WHERE id = ?").run(clip(outcome, 1000), rating, this.#now().toISOString(), id);
    return this.get(id)!;
  }
  /** Earlier decisions like this one that were made (shared question words and options). */
  similar(input: DecisionInput, limit = 2): Decision[] {
    const STOP = new Set(['which', 'what', 'should', 'would', 'could', 'the', 'and', 'for', 'with', 'between', 'this', 'that', 'get', 'one', 'two', 'or', 'vs', 'better', 'best', 'my', 'our', 'your']);
    const words = (s: string) => new Set(s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));
    const q = words(input.question);
    const opts = new Set(input.options.map(key));
    return this.list({ limit: 200 })
      .filter((d) => d.chosen)
      .map((d) => ({ d, score: [...words(d.question)].filter((w) => q.has(w)).length + 2 * d.input.options.filter((o) => opts.has(key(o))).length }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || b.d.id - a.d.id)
      .slice(0, limit)
      .map((x) => x.d);
  }
}

const stores = new WeakMap<DatabaseSync, DecisionStore>();
/** This space's decisions (in its own database). */
export function decisionsOf(app: AppContext): DecisionStore {
  const db = app.store.db;
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new DecisionStore(db, () => app.now())));
  return s;
}

function lastTime(d: Decision): string {
  return `Last time ("${d.question}", ${d.createdAt.slice(0, 10)}) they chose ${d.chosen}${d.why ? ` because ${d.why}` : ''}${d.outcome ? `; how it went: ${d.outcome}${d.rating ? ` (${d.rating}/5)` : ''}` : '; no outcome recorded yet'}.`;
}

function listLine(d: Decision): string {
  return `#${d.id} (${d.createdAt.slice(0, 10)}) ${d.question} — ${d.chosen ? `chose ${d.chosen}` : 'open'}${d.revisitAt ? ` — revisit ${d.revisitAt.slice(0, 10)}` : ''}${d.outcome ? ` — outcome: ${clip(d.outcome, 120)}` : ''}${d.rating ? ` (${d.rating}/5)` : ''}`;
}

/** The saved decision as Markdown (Save as document). */
export function decisionMarkdown(d: Decision): string {
  const r = scoreDecision(d.input);
  const lines = [`# ${d.question}`, '', `Decision #${d.id}, ${d.createdAt.slice(0, 10)}.`, '', '## Ranking', '', '| Rank | Option | Score (out of 100) |', '|---|---|---|', ...r.rows.map((x) => `| ${x.rank} | ${esc(x.option)} | ${pct(x.total)} |`), '', '## Scores and sources', '', resultText(r).split('\n').filter((l) => l.startsWith('|')).join('\n'), ''];
  if (r.closeCall) lines.push(r.tie ? 'It was a tie.' : 'It was a close call (top two within 5%).', '');
  if (r.factors.length) lines.push(`Deciding factors: ${r.factors.slice(0, 4).map((f) => `${f.criterion} ${f.points > 0 ? '+' : '−'}${pct(Math.abs(f.points))}`).join(', ')}.`, '');
  if (d.input.notes) lines.push('## Notes', '', d.input.notes, '');
  if (d.chosen) lines.push('## Chosen', '', `${d.chosen}${d.why ? `: ${d.why}` : ''}`, '');
  if (d.outcome) lines.push('## How it went', '', `${d.outcome}${d.rating ? ` (${d.rating}/5)` : ''}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

const DECIDE_DESC =
  "Help the person decide between options: weighs criteria and computes a ranked result in code (show them the math), with a sensitivity check and a 'close call' flag, and saves the decision. Help them decide; never decide for them. Before calling: get the options and what matters (if criteria aren't given, ask what matters most; at most two questions). Weights 1–5. Every score needs a source: \"you\" (their own rating), a named source (a site or a tool result) or \"estimate\" (yours; it is flagged). Scores are 1–10 ratings or raw values with units (\"$24,000\", \"400 mi\"); never make up facts: look them up (web_search, research) or ask. After it: give the ranked table and the deciding factors, say if it's a close call, then a short pre-mortem (what could go wrong with the leader, how to undo it) and ask which they choose; when they pick, call decision_record.";

export function createDecisionTools(getApp: () => AppContext): Tool[] {
  const store = () => decisionsOf(getApp());
  const idOf = (a: Record<string, unknown>): number => {
    const n = Number(a.id);
    if (!Number.isInteger(n) || n <= 0) throw new ToolError('Give the decision "id" (a number from decision_list).');
    return n;
  };
  const decide: Tool = {
    spec: {
      name: 'decide',
      description: DECIDE_DESC,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What is being decided ("Which car should I buy?").' },
          options: { type: 'array', items: { type: 'string' }, description: '2–12 options.' },
          criteria: {
            type: 'array',
            description: 'What matters, each with a weight 1 (a little) to 5 (most). higher_is_better: false for price, distance, risk…',
            items: { type: 'object', properties: { name: { type: 'string' }, weight: { type: 'number' }, higher_is_better: { type: 'boolean' }, scale: { type: 'string', enum: ['rating', 'raw'] } }, required: ['name', 'weight'] },
          },
          scores: {
            type: 'array',
            description: 'One row per option and criterion: value is a 1–10 rating or a raw value with its unit; source is "you", a named source, or "estimate". Leave out what is unknown (it shows as missing).',
            items: { type: 'object', properties: { option: { type: 'string' }, criterion: { type: 'string' }, value: { type: 'string', description: 'A 1–10 rating ("7") or a raw value with its unit ("$24,000").' }, source: { type: 'string' } }, required: ['option', 'criterion', 'value', 'source'] },
          },
          notes: { type: 'string', description: 'Optional context to keep with the decision.' },
        },
        required: ['question', 'options', 'criteria'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Decide: ${clip(a.question, 100)}`,
    async run(args, ctx) {
      const input = cleanInput(args as unknown as DecisionInput);
      const r = scoreDecision(input);
      const s = store();
      const before = s.similar(input);
      const d = s.add(input, ctx.conversationId ?? null);
      const top = r.rows[0].option;
      return [
        `Decision #${d.id} saved (open). ${r.question}`,
        resultText(r),
        ...before.map(lastTime),
        '',
        `Now: show the ranking and the deciding factors in a few lines${r.closeCall ? ' and say it is a close call' : ''}. Then a short pre-mortem in two parts: "What could go wrong" with ${r.tie ? 'the top options' : top} (2–3 concrete risks, one line each) and "How to undo it" (can it be reversed, and what would switching cost in money and time). Ask which they choose; the choice is theirs. When they pick, call decision_record with id ${d.id} (offer a date to revisit how it went).`,
      ].join('\n');
    },
  };
  const record: Tool = {
    spec: {
      name: 'decision_record',
      description: 'Record what the person chose for a saved decision (id from decide or decision_list), with why. Optional revisit: a date or time ("2027-05-01", "in 3 months") puts a reminder in the planner asking how it worked out.',
      parameters: { type: 'object', properties: { id: { type: 'number' }, chosen: { type: 'string' }, why: { type: 'string' }, revisit: { type: 'string', description: 'When to check how it went (optional).' } }, required: ['id', 'chosen'] },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Record decision #${String(a.id ?? '?')}: ${clip(a.chosen, 60)}`,
    async run(args, ctx) {
      const app = getApp();
      const d = store().choose(idOf(args), String(args.chosen ?? ''), args.why ? String(args.why) : null);
      const extra = d.input.options.some((o) => o === d.chosen) ? '' : ' (not one of the listed options)';
      let rem = '';
      if (args.revisit) {
        const tz = app.settings.get().timeZone;
        const at = parseWhen(String(args.revisit), app.now(), tz, { dateOnlyHour: 9 });
        if (!at) throw new ToolError(`Couldn't understand the revisit time "${String(args.revisit)}". Use "YYYY-MM-DD", "in 3 months" or "next friday".`);
        const reminder = app.planner?.addReminder({ text: `How did choosing ${d.chosen} work out? (decision #${d.id}: ${clip(d.question, 120)})`, dueAt: at.toISOString(), conversationId: ctx.conversationId ?? null });
        store().setRevisit(d.id, at.toISOString(), reminder?.id ?? null);
        rem = reminder ? ` Reminder #${reminder.id} set for ${formatLocal(at.toISOString(), tz)} to ask how it went.` : ' (No planner here, so no reminder was set.)';
      }
      return `Recorded: ${d.chosen}${extra} for decision #${d.id} "${d.question}".${d.why ? ` Why: ${d.why}.` : ''}${rem} When they tell you how it went, call decision_review.`;
    },
  };
  const review: Tool = {
    spec: {
      name: 'decision_review',
      description: 'Save how a decision worked out (outcome in their words, rating 1–5), so a later, similar decision can recall it.',
      parameters: { type: 'object', properties: { id: { type: 'number' }, outcome: { type: 'string' }, rating: { type: 'number', description: '1 went badly … 5 went great' } }, required: ['id', 'outcome', 'rating'] },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Review decision #${String(a.id ?? '?')}`,
    async run(args) {
      const outcome = clip(args.outcome, 1000);
      if (!outcome) throw new ToolError('Give the outcome in their words.');
      const d = store().review(idOf(args), outcome, Number(args.rating));
      return `Saved how decision #${d.id} went: ${d.outcome} (${d.rating}/5). It will come up next time they decide something similar.`;
    },
  };
  const list: Tool = {
    spec: {
      name: 'decision_list',
      description: "The person's saved decisions (newest first): status open|chosen|reviewed|all. With id: that decision's full table again.",
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'chosen', 'reviewed', 'all'] }, id: { type: 'number' } } },
    },
    defaultPermission: 'auto',
    summarize: () => 'List decisions',
    async run(args) {
      if (args.id !== undefined && args.id !== null && args.id !== '') {
        const d = store().get(idOf(args));
        if (!d) throw new ToolError(`No decision #${String(args.id)}.`);
        return `${listLine(d)}${d.why ? `\nWhy: ${d.why}` : ''}\n${resultText(scoreDecision(d.input))}`;
      }
      const status = ['open', 'chosen', 'reviewed', 'all'].includes(String(args.status)) ? (String(args.status) as DecisionStatus | 'all') : 'all';
      const all = store().list({ status });
      return all.length ? all.map(listLine).join('\n') : 'No decisions saved yet.';
    },
  };
  const compare: Tool = {
    spec: {
      name: 'compare',
      description: 'Put products, plans or options side by side as a table: items (names, or rows with their values, e.g. find_product results) and attributes (price, size, rating…). Uses only the values given; missing ones are marked, never filled in. For a weighted pick, use decide.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          items: { type: 'array', items: { type: 'object' }, description: '[{"name":"Plan A","values":{"Price":"$10/mo","Data":"5 GB"},"source":"a.com"}] or flat rows {"name":…, "price":…}.' },
          attributes: { type: 'array', items: { type: 'string' }, description: 'Columns, in order (default: every key the rows have).' },
        },
        required: ['items'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Compare ${Array.isArray(a.items) ? a.items.length : 0} items`,
    async run(args) {
      return compareTable(args as unknown as CompareInput).text;
    },
  };
  return [decide, record, review, list, compare];
}

// ---------------------------------------------------------------------------------------------
// chat cards (src/cards.ts → web/decision-card.js)
// ---------------------------------------------------------------------------------------------

export type DecisionCard = { kind: 'decision'; id: number; question: string; rows: { option: string; pct: number; rank: number; estimates: number; missing: number }[]; closeCall: boolean; tie: boolean; robust: boolean; estimates: number; factors: { criterion: string; points: number }[] };
export type CompareCard = { kind: 'compare'; title: string; attributes: string[]; rows: { name: string; cells: (string | null)[]; source?: string }[]; missing: number };

/** The decision card, computed again from the call's own arguments (the same pure math). */
export function decisionCardOf(args: Record<string, unknown>, output: string): DecisionCard | undefined {
  const m = /^Decision #(\d+) saved/.exec(output);
  if (!m) return undefined;
  const r = scoreDecision(args as unknown as DecisionInput);
  return {
    kind: 'decision',
    id: Number(m[1]),
    question: clip(r.question, 200),
    rows: r.rows.map((x) => ({ option: clip(x.option, 80), pct: Math.round(x.total * 10) / 10, rank: x.rank, estimates: x.cells.filter((c) => c.estimate).length, missing: x.cells.filter((c) => c.kind === 'missing').length })),
    closeCall: r.closeCall,
    tie: r.tie,
    robust: r.robust,
    estimates: r.estimates,
    factors: r.factors.slice(0, 3).map((f) => ({ criterion: clip(f.criterion, 60), points: Math.round(f.points * 10) / 10 })),
  };
}

export function compareCardOf(args: Record<string, unknown>): CompareCard {
  const t = compareTable(args as unknown as CompareInput);
  return { kind: 'compare', title: t.title, attributes: t.attributes, rows: t.rows.map((r) => ({ name: r.name, cells: r.cells.map((c) => c.value), ...(r.source ? { source: r.source } : {}) })), missing: t.missing };
}
