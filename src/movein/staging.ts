// Phase 104 (MI1, docs/design/MOVE_IN.md §7.1, §7.2, §7.5): findings wait in a staging database
// (<data>/movein/<id>.db) until the owner presses Import. The preview's counts and the batch's writes
// both come from `selection()`, so what the preview says is exactly what gets written.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { squash } from '../companion-import/learn.ts';
import type { Category, Finding, MemoryData, PersonaFinding, ScheduleData, Section, SkillData, Staged } from './types.ts';
import { CATEGORIES, DEFAULT_ON, SECTIONS } from './types.ts';

/** §15 Q5: at most this many imported notes are active; the rest arrive archived (searchable, never auto-injected). */
export const ACTIVE_NOTES = 2000;
/** §15 Q4: conversations newer than this many days are learned from (facts + style). */
export const LEARN_DAYS = 90;

const STOP = new Set('the and for with that this from have has had was were are you your his her their them they she him our ours about into over just very also when what which will would could should there here then than been being its it’s it\'s not but all any can does did doing done who whom whose how why'.split(' '));
export function words(s: string): Set<string> {
  return new Set(squash(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/u, '')));
}
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.max(a.size, b.size);
}

export interface Choices {
  /** Sections switched on (default: DEFAULT_ON). */
  sections?: Partial<Record<Section, boolean>>;
  /** Held categories the owner said yes to. */
  sensitive?: Partial<Record<Category, boolean>>;
  /** Intimate content also needs Adult mode on (as character cards do). */
  adultOn?: boolean;
}

export const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class Staging {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY AUTOINCREMENT, section TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, sha TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, held TEXT, state TEXT NOT NULL DEFAULT 'new', why TEXT);
      CREATE INDEX IF NOT EXISTS findings_section ON findings(section, state);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }

  clear(): void {
    this.db.exec('DELETE FROM findings; DELETE FROM meta;');
  }

  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
  meta<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  #ins?: ReturnType<DatabaseSync['prepare']>;
  #pending = 0;
  add(f: Finding): void {
    this.#ins ??= this.db.prepare('INSERT INTO findings (section, kind, ref, sha, title, data, held) VALUES (?, ?, ?, ?, ?, ?, ?)');
    if (!this.#pending) this.db.exec('BEGIN');
    this.#ins.run(f.section, f.kind, f.ref, sha(f.data), f.title.slice(0, 300), JSON.stringify(f.data), f.held ?? null);
    if (++this.#pending >= 5000) this.flush();
  }
  flush(): void {
    if (this.#pending) this.db.exec('COMMIT');
    this.#pending = 0;
  }

  setState(id: number, state: Staged['state'], why?: string): void {
    this.db.prepare('UPDATE findings SET state = ?, why = ? WHERE id = ?').run(state, why ?? null, id);
  }

  #row(r: Record<string, unknown>): Staged {
    return { id: Number(r.id), section: r.section as Section, kind: String(r.kind), ref: String(r.ref), sha: String(r.sha), title: String(r.title), data: JSON.parse(String(r.data)), ...(r.held ? { held: r.held as Category } : {}), state: r.state as Staged['state'], ...(r.why ? { why: String(r.why) } : {}) };
  }
  get(id: number): Staged | undefined {
    const r = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.#row(r) : undefined;
  }
  *all(section?: Section): Generator<Staged> {
    const it = (section ? this.db.prepare('SELECT * FROM findings WHERE section = ? ORDER BY id').iterate(section) : this.db.prepare('SELECT * FROM findings ORDER BY id').iterate()) as Iterable<Record<string, unknown>>;
    for (const r of it) yield this.#row(r);
  }

  /**
   * After the readers: duplicates inside the bundle and against her own notes, and what an earlier
   * move-in of the same agent already brought (§6.4 dedupe, §7.5 re-runs).
   */
  settle(opts: { already: (ref: string, sha: string) => boolean; alreadyRef: (ref: string) => boolean; existing: (text: string) => { id: number; content: string }[] }): void {
    this.flush();
    const seen = new Map<string, number>();
    const index = new Map<string, number[]>();
    const kept: { id: number; w: Set<string> }[] = [];
    this.db.exec('BEGIN');
    try {
      const heads = this.db.prepare("SELECT id, kind, ref, sha FROM findings WHERE section != 'later' ORDER BY id").all() as { id: number; kind: string; ref: string; sha: string }[];
      for (const f of heads) if (f.kind === 'conversation' ? opts.alreadyRef(f.ref) : opts.already(f.ref, f.sha)) this.setState(f.id, 'already', 'brought in by an earlier move-in');
      const notes = this.db.prepare("SELECT id, data FROM findings WHERE kind = 'memory' AND state = 'new' ORDER BY id").all() as { id: number; data: string }[];
      for (const f of notes) {
        const m = JSON.parse(f.data) as MemoryData;
        const key = `${m.superseded ? 's' : ''}${squash(m.content)}`;
        if (seen.has(key)) {
          this.setState(f.id, 'duplicate', 'the same as another note in the bundle');
          continue;
        }
        seen.set(key, f.id);
        if (m.superseded) continue;
        const w = words(m.content);
        // Near-duplicates (≥ 0.85 word overlap) inside the bundle, through a small word index.
        const cands = new Set<number>();
        for (const x of w) for (const i of index.get(x) ?? []) cands.add(i);
        if ([...cands].slice(0, 200).some((i) => overlap(w, kept[i].w) >= 0.85)) {
          this.setState(f.id, 'duplicate', 'nearly the same as another note in the bundle');
          continue;
        }
        // …and against the notes Sara already has.
        if (opts.existing(m.content).some((e) => squash(e.content) === squash(m.content) || overlap(w, words(e.content)) >= 0.85)) {
          this.setState(f.id, 'duplicate', 'Sara already has this note');
          continue;
        }
        const k = kept.push({ id: f.id, w }) - 1;
        for (const x of w) index.set(x, [...(index.get(x) ?? []), k].slice(-400));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * What an Import with these choices writes, section by section (the preview counts the same list).
   * Held items need their category chosen (intimate also needs Adult mode).
   */
  *selection(c: Choices): Generator<Staged> {
    const on = (s: Section) => c.sections?.[s] ?? DEFAULT_ON.has(s);
    const heldOk = (cat?: Category) => !cat || (c.sensitive?.[cat] === true && (cat !== 'intimate' || c.adultOn === true));
    for (const s of SECTIONS) {
      if (s === 'later' || !on(s)) continue;
      for (const f of this.all(s)) {
        if (f.state !== 'new' || !heldOk(f.held)) continue;
        if (f.kind === 'skill' && (f.data as SkillData).bundled) continue;
        if (f.kind === 'schedule' && !['task', 'reminder'].includes((f.data as ScheduleData).target)) continue;
        if (f.kind === 'persona' && ((f.data as PersonaFinding).refused || !(f.data as PersonaFinding).drafts.length)) continue;
        yield f;
      }
    }
  }

  /** Counts per section for the preview; `writes` = rows the batch will create. */
  counts(c: Choices): { sections: Record<string, { writes: number; found: number; duplicates: number; already: number; held: Record<string, number> }>; held: Record<string, number> } {
    const out: Record<string, { writes: number; found: number; duplicates: number; already: number; held: Record<string, number> }> = {};
    const held: Record<string, number> = {};
    for (const s of SECTIONS) out[s] = { writes: 0, found: 0, duplicates: 0, already: 0, held: {} };
    for (const r of this.db.prepare('SELECT section, state, held, COUNT(*) AS n FROM findings GROUP BY section, state, held').all() as { section: string; state: string; held: string | null; n: number }[]) {
      const o = out[r.section];
      if (!o) continue;
      o.found += r.n;
      if (r.state === 'duplicate') o.duplicates += r.n;
      if (r.state === 'already') o.already += r.n;
      if (r.held && r.state === 'new') {
        o.held[r.held] = (o.held[r.held] ?? 0) + r.n;
        held[r.held] = (held[r.held] ?? 0) + r.n;
      }
    }
    for (const f of this.selection(c)) out[f.section].writes += f.kind === 'board' ? (f.data as { cards: unknown[] }).cards.length : 1;
    for (const cat of CATEGORIES) held[cat] ??= 0;
    return { sections: out, held };
  }
}
