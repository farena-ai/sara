// Phase 101 (ST6, docs/design/STAPLES.md §9, docs/PEOPLE.md): people cards. A card per person in
// the owner's life, built from her memory and editable: who they are to him (his words), the facts
// she knows with their source (each fact points at the memory it came from: memories stay the
// source of truth, so editing or forgetting the memory updates or removes the fact), birthdays,
// when they were last mentioned. Recall uses it ("Jeff" vs "Jeff from work"). The tables live in
// the same database as the memories of each person's space, per companion (household-private).
//
// Never to outside: nothing here is ever offered to /v1, MCP, A2A, plugins, webhooks, group chats
// or partner conversations. `gate()` is the one check the outside paths use (a memory linked to a
// person, or a text that names one, stays in).
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';

export const CIRCLES = ['family', 'partner', 'friend', 'work', 'neighbour', 'other'] as const;
export type Circle = (typeof CIRCLES)[number];
export const FACT_CATEGORIES = ['health', 'intimate', 'money', 'legal'] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
/** rejected = "Not a person": only the name is kept, so it isn't proposed again. */
export type PersonStatus = 'proposed' | 'active' | 'merged' | 'forgotten' | 'rejected';

export interface Person {
  id: number;
  name: string;
  fullName: string | null;
  aliases: string[];
  relation: string;
  circle: Circle;
  birthday: string | null;
  notes: string;
  private: boolean;
  sensitive: boolean;
  status: PersonStatus;
  mergedInto: number | null;
  firstMentioned: string | null;
  lastMentioned: string | null;
  mentions: number;
  /** 'her' = she made it active on her own (mentioned in 3 conversations), 'owner' = he added or accepted it. */
  origin: 'her' | 'owner' | 'memory' | null;
  /** The photo he added (file name in the people folder), or null (initials). */
  photo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonFact {
  id: number;
  personId: number;
  content: string;
  memoryId: number | null;
  conversationId: string | null;
  messageId: number | null;
  happenedOn: string;
  evidence: string | null;
  sure: number;
  category: FactCategory | null;
  supersededBy: number | null;
  edited: boolean;
  /** Learned in a private conversation (or marked by him). */
  private: boolean;
  /** Held on several cards until the owner (or a later message) says which person it is about. */
  pending: string | null;
  createdAt: string;
}

export interface AboutItem {
  name: string;
  relation?: string | null;
  alias?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  full_name TEXT, aliases TEXT NOT NULL DEFAULT '[]',
  relation TEXT NOT NULL DEFAULT '',
  circle TEXT NOT NULL DEFAULT 'other',
  birthday TEXT,
  notes TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed',
  merged_into INTEGER,
  first_mentioned TEXT, last_mentioned TEXT, mentions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  memory_id INTEGER,
  conversation_id TEXT, message_id INTEGER, happened_on TEXT NOT NULL,
  evidence TEXT,
  sure REAL NOT NULL DEFAULT 0.7,
  category TEXT,
  superseded_by INTEGER, edited INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS person_facts_person ON person_facts(person_id);
CREATE INDEX IF NOT EXISTS person_facts_memory ON person_facts(memory_id);
CREATE TABLE IF NOT EXISTS person_links (
  a INTEGER NOT NULL, b INTEGER NOT NULL, relation TEXT NOT NULL, memory_id INTEGER,
  PRIMARY KEY (a, b, relation)
);
CREATE TABLE IF NOT EXISTS person_mentions (
  person_id INTEGER NOT NULL, conversation_id TEXT NOT NULL, message_id INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (person_id, message_id)
);
CREATE INDEX IF NOT EXISTS person_mentions_conv ON person_mentions(conversation_id, message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(name, full_name, aliases, relation, content='people', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS people_ai AFTER INSERT ON people BEGIN
  INSERT INTO people_fts(rowid, name, full_name, aliases, relation) VALUES (new.id, new.name, COALESCE(new.full_name, ''), new.aliases, new.relation);
END;
CREATE TRIGGER IF NOT EXISTS people_ad AFTER DELETE ON people BEGIN
  INSERT INTO people_fts(people_fts, rowid, name, full_name, aliases, relation) VALUES ('delete', old.id, old.name, COALESCE(old.full_name, ''), old.aliases, old.relation);
END;
CREATE TRIGGER IF NOT EXISTS people_au AFTER UPDATE OF name, full_name, aliases, relation ON people BEGIN
  INSERT INTO people_fts(people_fts, rowid, name, full_name, aliases, relation) VALUES ('delete', old.id, old.name, COALESCE(old.full_name, ''), old.aliases, old.relation);
  INSERT INTO people_fts(rowid, name, full_name, aliases, relation) VALUES (new.id, new.name, COALESCE(new.full_name, ''), new.aliases, new.relation);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS person_facts_fts USING fts5(content, content='person_facts', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS person_facts_ai AFTER INSERT ON person_facts BEGIN
  INSERT INTO person_facts_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS person_facts_ad AFTER DELETE ON person_facts BEGIN
  INSERT INTO person_facts_fts(person_facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS person_facts_au AFTER UPDATE OF content ON person_facts BEGIN
  INSERT INTO person_facts_fts(person_facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO person_facts_fts(rowid, content) VALUES (new.id, new.content);
END;
-- Memories stay the source of truth (STAPLES §9.2): editing a memory updates its facts, deleting
-- (forgetting) it removes them, superseding carries over.
CREATE TRIGGER IF NOT EXISTS people_memory_ad AFTER DELETE ON memories BEGIN
  DELETE FROM person_facts WHERE memory_id = old.id;
  DELETE FROM person_links WHERE memory_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS people_memory_au AFTER UPDATE OF content ON memories BEGIN
  UPDATE person_facts SET content = new.content WHERE memory_id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS people_memory_su AFTER UPDATE OF superseded_by ON memories BEGIN
  UPDATE person_facts SET superseded_by = new.superseded_by WHERE memory_id = new.id;
END;
`;

type Row = Record<string, string | number | null>;

/** Folds case and accents ("José" → "jose"), for matching names. */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A whole-word, case- and accent-insensitive pattern for a name (run on folded text). */
function wordRe(label: string, flags = 'u'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(fold(label)).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, flags);
}

const RELATION_WORDS =
  'wife|husband|partner|girlfriend|boyfriend|fiancee|fiance|spouse|mom|mum|mother|dad|father|parents?|brother|sister|sibling|son|daughter|kid|child|aunt|uncle|cousin|niece|nephew|grandma|grandpa|grandmother|grandfather|granddaughter|grandson|stepmom|stepdad|stepmother|stepfather|stepbrother|stepsister|twin|manager|boss|coworker|co-worker|colleague|teammate|client|mentor|supervisor|intern|neighbour|neighbor|friend|buddy|roommate|flatmate|landlord|teacher|coach|doctor|therapist|dentist|trainer|babysitter|nanny|godmother|godfather|goddaughter|godson|ex';
const REL_RE = new RegExp(`^(?:best |older |younger |little |big |old |new |step-?|ex-?)*(?:${RELATION_WORDS})(?:-in-law)?$`);

/** The circle a relation in his words belongs to. */
export function circleOf(relation: string | null | undefined): Circle {
  const r = fold(String(relation ?? ''));
  if (!r.trim()) return 'other';
  if (/\b(business partner|co-?founder)\b/.test(r)) return 'work';
  if (/\b(wife|husband|partner|girlfriend|boyfriend|fiancee?|spouse)\b/.test(r) && !/\bex\b|\bex-/.test(r)) return 'partner';
  if (/\b(mom|mum|mother|dad|father|parents?|brother|sister|sibling|son|daughter|kids?|child|children|aunt|uncle|cousin|niece|nephew|grand(?:ma|pa|mother|father|son|daughter|parents?)|step\w+|twin|in-law|god(?:mother|father|son|daughter))\b/.test(r)) return 'family';
  if (/\b(manager|boss|co-?workers?|colleagues?|team ?mates?|clients?|mentor|supervisor|intern|work|employee|report|ceo|cto)\b/.test(r)) return 'work';
  if (/\bneighbou?rs?\b/.test(r)) return 'neighbour';
  if (/\b(friend|buddy|pal|bestie|roommate|flatmate)\b/.test(r)) return 'friend';
  return 'other';
}

/** "brother", "Alex's brother", "his brother" → "my brother" (who they are to the owner, in his words). */
export function ownRelation(relation: string | null | undefined, ownerWords: string[] = []): string {
  let r = String(relation ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!r) return '';
  for (const w of ownerWords) if (w) r = r.replace(new RegExp(`^${esc(w)}'s\\s+`, 'i'), 'my ');
  r = r.replace(/^(his|her|their|our|the owner's)\s+/i, 'my ');
  if (REL_RE.test(fold(r))) r = `my ${r}`;
  return r;
}

/** Words that mean the same relation ("colleague" = "coworker", "mum" = "mother"). */
const SAME_REL: [RegExp, string][] = [
  [/\b(co-?workers?|colleagues?|team ?mates?|work friend)\b/g, 'coworker'],
  [/\b(mom|mum|mommy|mama|mother)\b/g, 'mother'],
  [/\b(dad|daddy|papa|father)\b/g, 'father'],
  [/\bneighbou?rs?\b/g, 'neighbour'],
  [/\b(boss|manager|supervisor)\b/g, 'manager'],
  [/\b(gf)\b/g, 'girlfriend'],
  [/\b(bf)\b/g, 'boyfriend'],
  [/\b(grandma|granny|grandmother)\b/g, 'grandmother'],
  [/\b(grandpa|grandfather)\b/g, 'grandfather'],
];
/** A relation without "my / his / Alex's" (for comparing two relations), synonyms made one. */
function relCore(r: string, ownerWords: string[] = []): string {
  let s = fold(r).trim();
  for (const w of ownerWords) if (w) s = s.replace(new RegExp(`^${esc(fold(w))}'s\\s+`), '');
  s = s.replace(/^(my|his|her|their|our|the)\s+/, '').trim();
  for (const [re, to] of SAME_REL) s = s.replace(re, to);
  return s;
}
function sameRelation(a: string, b: string, ownerWords: string[] = []): boolean {
  const x = relCore(a, ownerWords);
  const y = relCore(b, ownerWords);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** How a person is told apart in a sentence: "Jeff (your brother)". */
export function labelOf(p: Person): string {
  const rel = p.relation ? p.relation.replace(/^my\s+/i, 'your ') : '';
  const alias = p.aliases.find((a) => fold(a).startsWith(fold(p.name)) && fold(a) !== fold(p.name));
  const tail = rel || (alias ? alias.slice(p.name.length).trim() : '') || p.fullName || '';
  return tail ? `${p.name} (${tail})` : p.name;
}

/** Words that tell a sensitive fact's topic is being talked about (STAPLES §9.6). */
const TOPIC: Record<FactCategory, RegExp> = {
  health: /\b(health|sick|ill|illness|doctor|hospital|surgery|operation|medication|medicine|meds|pills?|therapy|therapist|diagnos\w*|cancer|pregnan\w*|injur\w*|recover\w*|treatment|symptoms?|mental|depress\w*|anxiety|clinic|appointment|condition|disease|healthy|get well)\b/i,
  intimate: /\b(sex|sexual|intimate|dating|relationship|affair|cheat\w*|breakup|broke up|divorce|romance|love life|crush|hook(?:ed)? up)\b/i,
  money: /\b(money|loan|debt|owe[sd]?|salary|pay|paid|broke|rent|bills?|finances?|financial|savings|bankrupt\w*|mortgage|lend|borrow\w*|cash)\b/i,
  legal: /\b(lawyer|attorney|court|lawsuit|sued|sue|arrest\w*|police|charges?|legal|trial|custody|divorce|visa|immigration|fine[sd]?|ticket)\b/i,
};

/** Capitalised words that are never a person's name on their own. */
const NOT_NAMES = new Set(
  'january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday the this that and but his her their our christmas easter halloween thanksgiving new year today tomorrow ai mom mum dad grandma grandpa uncle aunt god i im ive a an my me we he she they it its at in on to of for with from by'.split(' '),
);
const NAME = "\\p{Lu}[\\p{L}'’-]{1,30}";

/**
 * People named with a relation in a note or a message, found in code (no model): "his brother Jeff",
 * "Alex's manager Priya Shah", "Lea, his wife", "Jeff's wife Lea" (a link to another person).
 */
export function peopleInText(text: string, ownerWords: string[] = []): { name: string; relation: string; of?: string }[] {
  const own = new Set(ownerWords.map((w) => fold(w)));
  const okName = (n: string) => {
    const first = n.split(/\s+/)[0];
    return n.length >= 2 && !NOT_NAMES.has(fold(first)) && !own.has(fold(first)) && !own.has(fold(n));
  };
  const owners = ownerWords.filter(Boolean).map(esc).join('|');
  const poss = `(?:[Mm]y|[Hh]is|[Hh]er|[Tt]heir|[Oo]ur${owners ? `|(?:${owners})['’]s` : ''})`;
  const rel = `((?:best |older |younger |little |big |old |new |step-?|ex-?)*(?:${RELATION_WORDS})(?:-in-law)?)`;
  const out: { name: string; relation: string; of?: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, relation: string, of?: string) => {
    const n = name.replace(/['’]s$/, '').trim();
    if (!okName(n)) return;
    const key = `${fold(n)}|${fold(relation)}|${of ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, relation, ...(of ? { of } : {}) });
  };
  // "Jeff's wife Lea" (a link), checked first so Lea isn't taken as the owner's wife.
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])(${NAME})['’]s\\s+${rel}\\s*,?\\s+(${NAME}(?:\\s+${NAME})?)`, 'gu'))) {
    if (own.has(fold(m[1])) || !okName(m[1])) continue;
    add(m[3], `${m[1]}'s ${m[2].toLowerCase()}`, m[1]);
  }
  const linked = new Set(out.map((x) => fold(x.name)));
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])${poss}\\s+${rel}\\s*,?\\s+(${NAME}(?:\\s+${NAME})?)`, 'gu'))) {
    if (!/^\p{Lu}/u.test(m[2]) || linked.has(fold(m[2].replace(/['’]s$/, '')))) continue;
    add(m[2], `my ${m[1].toLowerCase()}`);
  }
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])(${NAME}(?:\\s+${NAME})?),\\s+${poss}\\s+${rel}\\b`, 'gu'))) add(m[1], `my ${m[2].toLowerCase()}`);
  return out;
}

const ymd = (iso: string) => iso.slice(0, 10);
const DAY = 86_400_000;

function toPerson(r: Row): Person {
  let aliases: string[] = [];
  try {
    const a = JSON.parse(String(r.aliases ?? '[]'));
    if (Array.isArray(a)) aliases = a.map(String).filter(Boolean);
  } catch {
    /* a hand-edited row: no aliases */
  }
  return {
    id: Number(r.id),
    name: String(r.name),
    fullName: (r.full_name as string | null) || null,
    aliases,
    relation: String(r.relation ?? ''),
    circle: (CIRCLES as readonly string[]).includes(String(r.circle)) ? (r.circle as Circle) : 'other',
    birthday: (r.birthday as string | null) || null,
    notes: String(r.notes ?? ''),
    private: Boolean(r.private),
    sensitive: Boolean(r.sensitive),
    status: String(r.status) as PersonStatus,
    mergedInto: r.merged_into === null || r.merged_into === undefined ? null : Number(r.merged_into),
    firstMentioned: (r.first_mentioned as string | null) ?? null,
    lastMentioned: (r.last_mentioned as string | null) ?? null,
    mentions: Number(r.mentions ?? 0),
    origin: ((r.origin as string | null) ?? null) as Person['origin'],
    photo: (r.photo as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
function toFact(r: Row): PersonFact {
  return {
    id: Number(r.id),
    personId: Number(r.person_id),
    content: String(r.content),
    memoryId: r.memory_id === null ? null : Number(r.memory_id),
    conversationId: (r.conversation_id as string | null) ?? null,
    messageId: r.message_id === null ? null : Number(r.message_id),
    happenedOn: String(r.happened_on),
    evidence: (r.evidence as string | null) ?? null,
    sure: Number(r.sure ?? 0.7),
    category: (FACT_CATEGORIES as readonly string[]).includes(String(r.category)) ? (r.category as FactCategory) : null,
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    edited: Boolean(r.edited),
    private: Boolean(r.private),
    pending: (r.pending as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export interface FindContext {
  conversationId?: string;
  /** Messages after this id don't count as context (the worker resolving an older message). */
  beforeMessageId?: number;
  /** A shared work channel (`-work`): circle work wins a tie. */
  work?: boolean;
  /** Proposed cards count too (mentions); recall only uses active ones. */
  includeProposed?: boolean;
}
export interface FindResult {
  found: Person[];
  ambiguous: { label: string; people: Person[] }[];
}

export interface SectionContext extends FindContext {
  owner: string;
  private: boolean;
  maxChars: number;
  today: string;
}

export interface PeopleOptions {
  now?: () => Date;
  /** Where his photos of people are kept (`<companion dir>/people`). */
  photoDir?: string;
  /** The owner's and her own name words (never a person card). */
  ownWords?: () => string[];
}

export interface BackfillStatus {
  state: 'never' | 'running' | 'done' | 'failed' | 'stopped';
  done: number;
  total: number;
  tokens: number;
  budget: number;
  proposed: number;
  usedModel: boolean;
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

/** The budget of the one-time backfill (STAPLES §9.3): tokens, batch size. */
export const BACKFILL_BUDGET = 200_000;
export const BACKFILL_BATCH = 40;
/** A proposed card becomes active on its own after this many conversations mention it. */
export const AUTO_ACTIVE_CONVERSATIONS = 3;

export class PeopleStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;
  readonly photoDir: string | undefined;
  readonly #ownWords: () => string[];
  #cache: { at: number; people: Person[] } | undefined;
  #rev = 0;

  constructor(db: DatabaseSync, opts: PeopleOptions = {}) {
    this.db = db;
    this.#now = opts.now ?? (() => new Date());
    this.photoDir = opts.photoDir;
    this.#ownWords = opts.ownWords ?? (() => []);
    db.exec(SCHEMA);
    // Additive columns beyond the design's table (STAPLES §9.11): where a card came from, his photo,
    // and per fact: private and "held on several cards until resolved".
    const has = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    const pc = has('people');
    for (const [c, type] of [['origin', 'TEXT'], ['photo', 'TEXT']]) if (!pc.has(c)) db.exec(`ALTER TABLE people ADD COLUMN ${c} ${type}`);
    const fc = has('person_facts');
    for (const [c, type] of [['private', 'INTEGER NOT NULL DEFAULT 0'], ['pending', 'TEXT']]) if (!fc.has(c)) db.exec(`ALTER TABLE person_facts ADD COLUMN ${c} ${type}`);
    db.exec('CREATE TABLE IF NOT EXISTS memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  #ts(): string {
    return this.#now().toISOString();
  }
  #changed(): void {
    this.#cache = undefined;
    this.#rev++;
  }
  /** Changes on every write (callers cache what they build from the cards). */
  get revision(): number {
    return this.#rev;
  }
  ownWords(): string[] {
    return this.#ownWords()
      .flatMap((n) => n.split(/[^\p{L}'-]+/u))
      .filter((w) => w.length >= 2);
  }

  // ---------------------------------------------------------------- cards

  /** Every card that is a person (not merged, not rejected), cached briefly. */
  all(): Person[] {
    if (this.#cache && Date.now() - this.#cache.at < 30_000) return this.#cache.people;
    const people = (this.db.prepare("SELECT * FROM people WHERE status IN ('proposed','active') ORDER BY name COLLATE NOCASE").all() as Row[]).map(toPerson);
    this.#cache = { at: Date.now(), people };
    return people;
  }

  get(id: number): Person | undefined {
    const r = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id) as Row | undefined;
    return r ? toPerson(r) : undefined;
  }

  /** The People page: search (names, aliases, relation, facts), circle filter, proposed or active. */
  list(opts: { q?: string; circle?: string; status?: 'proposed' | 'active' | 'all'; limit?: number } = {}): Person[] {
    const limit = Math.min(1000, opts.limit ?? 500);
    let rows = this.all();
    if (opts.status === 'proposed' || opts.status === 'active') rows = rows.filter((p) => p.status === opts.status);
    if (opts.circle && (CIRCLES as readonly string[]).includes(opts.circle)) rows = rows.filter((p) => p.circle === opts.circle);
    const q = opts.q?.trim();
    if (q) {
      const f = fold(q);
      const byFact = new Set<number>();
      const words = (f.match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 8);
      if (words.length) {
        try {
          for (const r of this.db.prepare('SELECT f.person_id AS pid FROM person_facts_fts x JOIN person_facts f ON f.id = x.rowid WHERE person_facts_fts MATCH ? LIMIT 500').all(words.map((w) => `"${w}"*`).join(' AND ')) as Row[]) byFact.add(Number(r.pid));
        } catch {
          /* odd characters: names only */
        }
      }
      rows = rows.filter((p) => byFact.has(p.id) || [p.name, p.fullName ?? '', ...p.aliases, p.relation].some((s) => fold(s).includes(f)));
    }
    return rows.slice(0, limit);
  }

  create(p: { name: string; fullName?: string | null; relation?: string; circle?: Circle; birthday?: string | null; notes?: string; status?: 'proposed' | 'active'; origin?: Person['origin']; aliases?: string[]; private?: boolean }): Person {
    const name = cleanName(p.name);
    if (!name) throw new Error('A person needs a name.');
    const ts = this.#ts();
    const relation = String(p.relation ?? '').trim().slice(0, 80);
    const r = this.db
      .prepare('INSERT INTO people (name, full_name, aliases, relation, circle, birthday, notes, private, status, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, p.fullName?.trim() || null, JSON.stringify(uniqAliases(p.aliases ?? [], name)), relation, p.circle ?? circleOf(relation), validBirthday(p.birthday) ?? null, String(p.notes ?? '').slice(0, 4000), p.private ? 1 : 0, p.status ?? 'proposed', p.origin ?? null, ts, ts);
    this.#changed();
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** His edits on the card. Only the fields given change. */
  update(id: number, patch: { name?: string; fullName?: string | null; aliases?: string[]; relation?: string; circle?: string; birthday?: string | null; notes?: string; private?: boolean; status?: 'active' | 'proposed' }): Person | undefined {
    const cur = this.get(id);
    if (!cur || cur.status === 'merged' || cur.status === 'rejected') return undefined;
    const name = patch.name !== undefined ? cleanName(patch.name) : cur.name;
    if (!name) throw new Error('A person needs a name.');
    const relation = patch.relation !== undefined ? String(patch.relation).trim().slice(0, 80) : cur.relation;
    const circle = patch.circle !== undefined && (CIRCLES as readonly string[]).includes(patch.circle) ? patch.circle : patch.relation !== undefined && cur.circle === circleOf(cur.relation) ? circleOf(relation) : cur.circle;
    if (patch.birthday !== undefined && patch.birthday !== null && patch.birthday !== '' && !validBirthday(patch.birthday)) throw new Error('Pick a real birthday (month and day).');
    const birthday = patch.birthday !== undefined ? (validBirthday(patch.birthday) ?? null) : cur.birthday;
    this.db
      .prepare('UPDATE people SET name = ?, full_name = ?, aliases = ?, relation = ?, circle = ?, birthday = ?, notes = ?, private = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(
        name,
        patch.fullName !== undefined ? patch.fullName?.trim() || null : cur.fullName,
        JSON.stringify(uniqAliases(patch.aliases ?? cur.aliases, name)),
        relation,
        circle,
        birthday,
        patch.notes !== undefined ? String(patch.notes).slice(0, 4000) : cur.notes,
        (patch.private ?? cur.private) ? 1 : 0,
        patch.status ?? cur.status,
        this.#ts(),
        id,
      );
    this.#changed();
    return this.get(id);
  }

  /** "Looks right": the card is used from now on. */
  accept(id: number): Person | undefined {
    const cur = this.get(id);
    if (!cur || (cur.status !== 'proposed' && cur.status !== 'active')) return undefined;
    this.db.prepare("UPDATE people SET status = 'active', origin = CASE WHEN origin = 'her' THEN 'her' ELSE 'owner' END, updated_at = ? WHERE id = ?").run(this.#ts(), id);
    this.#changed();
    return this.get(id);
  }

  /** "Not a person": facts, links and mentions go; only the name stays, so she doesn't propose it again. */
  reject(id: number): boolean {
    const cur = this.get(id);
    if (!cur || (cur.status !== 'proposed' && cur.status !== 'active')) return false;
    this.#wipe(id);
    this.db.prepare("UPDATE people SET status = 'rejected', notes = '', full_name = NULL, relation = '', birthday = NULL, aliases = '[]', photo = NULL, mentions = 0, first_mentioned = NULL, last_mentioned = NULL, updated_at = ? WHERE id = ?").run(this.#ts(), id);
    this.#changed();
    return true;
  }

  #wipe(id: number): void {
    this.db.prepare('DELETE FROM person_facts WHERE person_id = ?').run(id);
    this.db.prepare('DELETE FROM person_links WHERE a = ? OR b = ?').run(id, id);
    this.db.prepare('DELETE FROM person_mentions WHERE person_id = ?').run(id);
    this.#removePhoto(id);
  }

  /**
   * "Forget this person": the card, its facts, links, mentions and photo are deleted for real
   * (FTS segments merged so no trace stays in the index). Returns the memories the facts came from,
   * so the caller can forget those too when he ticks it.
   */
  forget(id: number): { memoryIds: number[] } | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const memoryIds = [...new Set((this.db.prepare('SELECT memory_id FROM person_facts WHERE person_id = ? AND memory_id IS NOT NULL').all(id) as Row[]).map((r) => Number(r.memory_id)))];
    this.db.exec('PRAGMA secure_delete = ON');
    try {
      this.db.exec('BEGIN');
      this.#wipe(id);
      // Cards merged into it go with it (they are the same person).
      for (const r of this.db.prepare('SELECT id FROM people WHERE merged_into = ?').all(id) as Row[]) {
        this.#wipe(Number(r.id));
        this.db.prepare('DELETE FROM people WHERE id = ?').run(Number(r.id));
      }
      this.db.prepare('DELETE FROM people WHERE id = ?').run(id);
      // Her "which one?" questions and the answers kept per conversation lose this person too.
      for (const r of this.db.prepare("SELECT key, value FROM memory_kv WHERE key LIKE 'people:alias:%' OR key LIKE 'people:ask:%'").all() as Row[]) {
        try {
          const v = JSON.parse(String(r.value)) as { ids?: number[] } & Record<string, unknown>;
          const refs = Array.isArray(v.ids) ? v.ids : Object.values(v);
          if (refs.includes(id)) this.db.prepare('DELETE FROM memory_kv WHERE key = ?').run(r.key);
        } catch {
          this.db.prepare('DELETE FROM memory_kv WHERE key = ?').run(r.key);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.db.exec('PRAGMA secure_delete = OFF');
    }
    this.purgeIndexes();
    this.#changed();
    return { memoryIds };
  }

  /** Merges the full-text indexes so deleted rows leave no trace in old segments. */
  purgeIndexes(): void {
    for (const t of ['people_fts', 'person_facts_fts', 'memories_fts']) {
      try {
        this.db.prepare(`INSERT INTO ${t}(${t}) VALUES ('optimize')`).run();
      } catch {
        /* the table isn't there (a bare test database) */
      }
    }
  }

  /** "Merge with…": the facts, mentions and links move to `into`; the name becomes an alias there. */
  merge(id: number, into: number): Person | undefined {
    const a = this.get(id);
    const b = this.get(into);
    if (!a || !b || id === into || !['proposed', 'active'].includes(a.status) || !['proposed', 'active'].includes(b.status)) return undefined;
    this.db.prepare('UPDATE person_facts SET person_id = ? WHERE person_id = ?').run(into, id);
    // A fact that was held on both cards is now about this one: one copy stays.
    for (const r of this.db.prepare('SELECT pending FROM person_facts WHERE person_id = ? AND pending IS NOT NULL GROUP BY pending HAVING COUNT(*) > 1').all(into) as Row[]) {
      const ids = (this.db.prepare('SELECT id FROM person_facts WHERE person_id = ? AND pending = ? ORDER BY id').all(into, r.pending) as Row[]).map((x) => Number(x.id));
      for (const extra of ids.slice(1)) this.db.prepare('DELETE FROM person_facts WHERE id = ?').run(extra);
    }
    this.db.prepare('UPDATE OR IGNORE person_mentions SET person_id = ? WHERE person_id = ?').run(into, id);
    this.db.prepare('DELETE FROM person_mentions WHERE person_id = ?').run(id);
    this.db.prepare('UPDATE OR IGNORE person_links SET a = ? WHERE a = ?').run(into, id);
    this.db.prepare('UPDATE OR IGNORE person_links SET b = ? WHERE b = ?').run(into, id);
    this.db.prepare('DELETE FROM person_links WHERE a = ? OR b = ? OR a = b').run(id, id);
    const aliases = uniqAliases([...b.aliases, a.name, ...a.aliases, ...(a.fullName ? [a.fullName] : [])], b.name);
    const mentions = Number((this.db.prepare('SELECT COUNT(*) AS n FROM person_mentions WHERE person_id = ?').get(into) as Row).n);
    const first = [a.firstMentioned, b.firstMentioned].filter(Boolean).sort()[0] ?? null;
    const last = [a.lastMentioned, b.lastMentioned].filter(Boolean).sort().at(-1) ?? null;
    this.db
      .prepare('UPDATE people SET aliases = ?, relation = ?, full_name = ?, birthday = ?, notes = ?, sensitive = MAX(sensitive, ?), mentions = ?, first_mentioned = ?, last_mentioned = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(aliases), b.relation || a.relation, b.fullName ?? a.fullName, b.birthday ?? a.birthday, [b.notes, a.notes].filter(Boolean).join('\n'), a.sensitive ? 1 : 0, Math.max(mentions, b.mentions + a.mentions), first, last, this.#ts(), into);
    this.db.prepare("UPDATE people SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(into, this.#ts(), id);
    this.#removePhoto(id);
    this.#changed();
    return this.get(into);
  }

  /** "Split": the chosen facts move to a new card (two people were taken for one). */
  split(id: number, factIds: number[], name?: string): Person | undefined {
    const cur = this.get(id);
    if (!cur || !factIds.length) return undefined;
    const mine = new Set(this.facts(id, { all: true }).map((f) => f.id));
    const move = factIds.filter((f) => mine.has(f));
    if (!move.length) return undefined;
    const fresh = this.create({ name: name?.trim() || cur.name, status: 'active', origin: 'owner', circle: 'other' });
    const st = this.db.prepare('UPDATE person_facts SET person_id = ? WHERE id = ?');
    for (const f of move) st.run(fresh.id, f);
    this.#changed();
    return fresh;
  }

  // ---------------------------------------------------------------- facts

  facts(personId: number, opts: { all?: boolean } = {}): PersonFact[] {
    return (this.db.prepare(`SELECT * FROM person_facts WHERE person_id = ? ${opts.all ? '' : 'AND superseded_by IS NULL'} ORDER BY happened_on DESC, id DESC`).all(personId) as Row[]).map(toFact);
  }
  fact(id: number): PersonFact | undefined {
    const r = this.db.prepare('SELECT * FROM person_facts WHERE id = ?').get(id) as Row | undefined;
    return r ? toFact(r) : undefined;
  }

  /** Links a memory to a person (one fact per person per memory). */
  addFact(personId: number, f: { content: string; memoryId?: number | null; conversationId?: string | null; messageId?: number | null; happenedOn: string; evidence?: string | null; sure?: number; category?: FactCategory | null; private?: boolean; pending?: string | null }): PersonFact | undefined {
    if (f.memoryId != null) {
      const have = this.db.prepare('SELECT id FROM person_facts WHERE person_id = ? AND memory_id = ?').get(personId, f.memoryId) as Row | undefined;
      if (have) return this.fact(Number(have.id));
    }
    const r = this.db
      .prepare('INSERT INTO person_facts (person_id, content, memory_id, conversation_id, message_id, happened_on, evidence, sure, category, private, pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(personId, f.content.slice(0, 2000), f.memoryId ?? null, f.conversationId ?? null, f.messageId ?? null, f.happenedOn, f.evidence ?? null, f.sure ?? 0.7, f.category ?? null, f.private ? 1 : 0, f.pending ?? null, this.#ts());
    if (f.category) this.db.prepare('UPDATE people SET sensitive = 1 WHERE id = ?').run(personId);
    this.#changed();
    return this.fact(Number(r.lastInsertRowid));
  }

  /** His edit of a fact (the caller updates the memory it came from too: memories are the truth). */
  updateFact(id: number, patch: { content?: string; category?: FactCategory | null; private?: boolean }): PersonFact | undefined {
    const cur = this.fact(id);
    if (!cur) return undefined;
    if (patch.content !== undefined) this.db.prepare('UPDATE person_facts SET content = ?, edited = 1 WHERE id = ?').run(patch.content.slice(0, 2000), id);
    if (patch.category !== undefined) this.db.prepare('UPDATE person_facts SET category = ? WHERE id = ?').run(patch.category, id);
    if (patch.private !== undefined) this.db.prepare('UPDATE person_facts SET private = ? WHERE id = ?').run(patch.private ? 1 : 0, id);
    if (patch.category) this.db.prepare('UPDATE people SET sensitive = 1 WHERE id = ?').run(cur.personId);
    this.#changed();
    return this.fact(id);
  }

  /** Takes a fact off the card (the memory stays: forget the memory itself to remove it everywhere). */
  deleteFact(id: number): boolean {
    const n = Number(this.db.prepare('DELETE FROM person_facts WHERE id = ?').run(id).changes);
    if (n) this.#changed();
    return n > 0;
  }

  /** A fact held on several cards (an unresolved "Jeff") is about this person: the other copies go. */
  resolvePending(factId: number): PersonFact | undefined {
    const f = this.fact(factId);
    if (!f?.pending) return f;
    this.db.prepare('DELETE FROM person_facts WHERE pending = ? AND id <> ?').run(f.pending, factId);
    this.db.prepare('UPDATE person_facts SET pending = NULL WHERE id = ?').run(factId);
    this.#changed();
    return this.fact(factId);
  }

  isPersonMemory(memoryId: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM person_facts WHERE memory_id = ? LIMIT 1').get(memoryId));
  }
  /** The person a memory is about (a date tile on Today names the person and opens the card). */
  personOfMemory(memoryId: number): Person | undefined {
    const r = this.db.prepare("SELECT p.* FROM person_facts f JOIN people p ON p.id = f.person_id WHERE f.memory_id = ? AND f.pending IS NULL AND p.status IN ('proposed','active') ORDER BY p.status = 'active' DESC LIMIT 1").get(memoryId) as Row | undefined;
    return r ? toPerson(r) : undefined;
  }
  /** Whether a memory's facts are in a sensitive category (never on Today or in notifications). */
  sensitiveMemory(memoryId: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM person_facts WHERE memory_id = ? AND category IS NOT NULL LIMIT 1').get(memoryId));
  }

  // ---------------------------------------------------------------- links

  links(id: number): { person: Person; relation: string; memoryId: number | null }[] {
    const rows = this.db.prepare('SELECT * FROM person_links WHERE a = ? OR b = ?').all(id, id) as Row[];
    const out: { person: Person; relation: string; memoryId: number | null }[] = [];
    for (const r of rows) {
      const other = this.get(Number(r.a) === id ? Number(r.b) : Number(r.a));
      if (!other || other.status === 'merged' || other.status === 'rejected') continue;
      out.push({ person: other, relation: String(r.relation), memoryId: r.memory_id === null ? null : Number(r.memory_id) });
    }
    return out;
  }
  /** "Lea is Jeff's wife": a = Lea, b = Jeff, relation "Jeff's wife". */
  addLink(a: number, b: number, relation: string, memoryId: number | null = null): void {
    if (a === b || !this.get(a) || !this.get(b)) return;
    this.db.prepare('INSERT OR IGNORE INTO person_links (a, b, relation, memory_id) VALUES (?, ?, ?, ?)').run(a, b, relation.slice(0, 80), memoryId);
  }
  removeLink(a: number, b: number): void {
    this.db.prepare('DELETE FROM person_links WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(a, b, b, a);
  }

  // ---------------------------------------------------------------- photos

  #removePhoto(id: number): void {
    if (!this.photoDir || !existsSync(this.photoDir)) return;
    for (const f of readdirSync(this.photoDir)) if (f.startsWith(`${id}.`)) rmSync(join(this.photoDir, f), { force: true });
  }
  setPhoto(id: number, data: Uint8Array | null, ext: 'jpg' | 'png' | 'webp' = 'jpg'): Person | undefined {
    if (!this.photoDir || !this.get(id)) return undefined;
    this.#removePhoto(id);
    if (data) {
      mkdirSync(this.photoDir, { recursive: true });
      writeFileAtomic(join(this.photoDir, `${id}.${ext}`), data);
    }
    this.db.prepare('UPDATE people SET photo = ?, updated_at = ? WHERE id = ?').run(data ? `${id}.${ext}` : null, this.#ts(), id);
    this.#changed();
    return this.get(id);
  }
  photo(id: number): { data: Buffer; type: string } | undefined {
    const p = this.get(id);
    if (!p?.photo || !this.photoDir) return undefined;
    const file = join(this.photoDir, p.photo);
    if (!existsSync(file)) return undefined;
    const ext = p.photo.split('.').pop();
    return { data: readFileSync(file), type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
  }

  // ---------------------------------------------------------------- building cards from memory

  #kv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  #kvSet(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM memory_kv WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO memory_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Cards whose name, full name or an alias is this name (any status but merged). */
  #byName(name: string, statuses = ['proposed', 'active', 'rejected']): Person[] {
    const f = fold(name.trim());
    const first = f.split(/\s+/)[0];
    const rows = (this.db.prepare(`SELECT * FROM people WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses) as Row[]).map(toPerson);
    return rows.filter((p) => {
      const labels = [p.name, p.fullName ?? '', ...p.aliases].filter(Boolean).map(fold);
      // "Jeff Miller" finds the card "Jeff" (and "Jeff" the card "Jeff Miller").
      return labels.includes(f) || (f.includes(' ') && labels.includes(first)) || (!f.includes(' ') && fold(p.name).split(/\s+/)[0] === f && !p.fullName);
    });
  }

  /**
   * One person a fact is about (STAPLES §9.3, §9.4): the card it belongs to, or a new proposed card.
   * Returns the cards the fact goes on (two or more = held on each until it's clear which one), or
   * none when the name was marked "Not a person" or is the owner's or her own.
   */
  resolveAbout(item: AboutItem, ctx: FindContext & { text?: string } = {}): { people: Person[]; created: boolean } {
    const name = cleanName(item.name);
    const own = new Set(this.ownWords().map(fold));
    if (!name || own.has(fold(name)) || own.has(fold(name.split(/\s+/)[0])) || NOT_NAMES.has(fold(name))) return { people: [], created: false };
    const ownerWords = this.ownWords();
    const relation = ownRelation(item.relation, ownerWords);
    const all = this.#byName(name);
    if (all.some((p) => p.status === 'rejected' && fold(p.name) === fold(name)) && !all.some((p) => p.status !== 'rejected')) return { people: [], created: false };
    let cands = all.filter((p) => p.status !== 'rejected');
    // An alias he used ("Jeff from work") picks the card that has it.
    if (item.alias) {
      const withAlias = cands.filter((p) => p.aliases.some((a) => fold(a) === fold(String(item.alias))));
      if (withAlias.length === 1) return { people: withAlias, created: false };
    }
    if (relation) {
      const same = cands.filter((p) => p.relation && sameRelation(p.relation, relation, ownerWords));
      if (same.length >= 1) return { people: [this.#touchAlias(same[0], item)], created: false };
      const blank = cands.filter((p) => !p.relation);
      if (blank.length === 1 && cands.length === 1) {
        this.update(blank[0].id, { relation, circle: circleOf(relation) });
        return { people: [this.#touchAlias(this.get(blank[0].id)!, item)], created: false };
      }
      // Every card with this name is someone else ("my brother Jeff" vs "my coworker Jeff"): a new card.
      if (cands.every((p) => p.relation)) cands = [];
    }
    if (cands.length === 1) return { people: [this.#touchAlias(cands[0], item)], created: false };
    if (cands.length > 1) {
      // Context decides (a qualifier in the message, who was just talked about); else held on each.
      const r = ctx.text ? this.find(ctx.text, { ...ctx, includeProposed: true }) : { found: [], ambiguous: [] };
      const pick = r.found.find((p) => cands.some((c) => c.id === p.id));
      return pick ? { people: [pick], created: false } : { people: cands, created: false };
    }
    const fresh = this.create({ name, relation, circle: circleOf(relation), status: 'proposed', origin: 'memory', aliases: item.alias ? [String(item.alias)] : [], ...(name.includes(' ') ? { fullName: name } : {}) });
    if (name.includes(' ')) this.update(fresh.id, { name: name.split(/\s+/)[0], fullName: name });
    return { people: [this.get(fresh.id)!], created: true };
  }

  #touchAlias(p: Person, item: AboutItem): Person {
    const extra = [item.alias, fold(item.name) !== fold(p.name) && !fold(item.name).startsWith(`${fold(p.name)} `) ? item.name : null].filter((x): x is string => Boolean(x && x.trim()));
    // A full name ("Jeff Miller") becomes the full name when there is none.
    if (!p.fullName && item.name.trim().includes(' ') && fold(item.name).startsWith(`${fold(p.name)} `)) return this.update(p.id, { fullName: cleanName(item.name) }) ?? p;
    const missing = extra.filter((a) => ![p.name, p.fullName ?? '', ...p.aliases].some((x) => fold(x) === fold(a)));
    return missing.length ? (this.update(p.id, { aliases: [...p.aliases, ...missing] }) ?? p) : p;
  }

  /**
   * Links one memory to the people it is about (the memory worker's `about`, or what code finds in
   * its text). Date memories about a birthday set the card's birthday when it has none.
   */
  linkMemory(m: { id: number; kind: string; content: string; conversationId: string | null; sourceMessageId: number | null; happenedOn: string; evidence: string | null; onDate?: string | null }, about: AboutItem[], opts: { category?: FactCategory | null; private?: boolean; text?: string } = {}): { personIds: number[]; created: number } {
    const ids: number[] = [];
    let created = 0;
    const byName = new Map<string, number>();
    for (const item of about.slice(0, 6)) {
      const ctx: FindContext & { text?: string } = { ...(m.conversationId ? { conversationId: m.conversationId } : {}), ...(m.sourceMessageId ? { beforeMessageId: m.sourceMessageId } : {}), ...(opts.text ? { text: opts.text } : {}) };
      const r = this.resolveAbout(item, ctx);
      if (r.created) created++;
      const pending = r.people.length > 1 ? `m${m.id}:${fold(item.name)}` : null;
      for (const p of r.people) {
        this.addFact(p.id, { content: m.content, memoryId: m.id, conversationId: m.conversationId, messageId: m.sourceMessageId, happenedOn: m.happenedOn, evidence: m.evidence, category: opts.category ?? null, private: Boolean(opts.private), pending });
        ids.push(p.id);
        byName.set(fold(item.name), p.id);
        // A birthday she learned as a date ("Jamie's birthday", 03-14) fills the card's birthday once.
        if (m.kind === 'date' && m.onDate && /birthday|b-?day/i.test(m.content) && !p.birthday && r.people.length === 1) this.db.prepare('UPDATE people SET birthday = ? WHERE id = ?').run(m.onDate, p.id);
      }
    }
    // "Lea is Jeff's wife": a link between two cards.
    for (const item of about) {
      const lm = /^(.+?)['’]s\s+(.+)$/.exec(String(item.relation ?? ''));
      if (!lm) continue;
      const a = byName.get(fold(item.name));
      const b = byName.get(fold(lm[1])) ?? (this.#byName(lm[1], ['active', 'proposed'])[0]?.id);
      if (a && b) this.addLink(a, b, `${lm[1]}'s ${lm[2]}`, m.id);
    }
    if (ids.length) this.#changed();
    return { personIds: [...new Set(ids)], created };
  }

  /** People found in a note by code alone (hand-added memories, the backfill without a model). */
  aboutFromText(text: string): AboutItem[] {
    const out: AboutItem[] = peopleInText(text, this.ownWords()).map((x) => ({ name: x.name, relation: x.relation }));
    // People who already have a card, named in the note ("Jamie Rivera's birthday").
    const r = this.find(text, { includeProposed: true });
    for (const p of r.found) if (!out.some((x) => fold(x.name).split(/\s+/)[0] === fold(p.name).split(/\s+/)[0])) out.push({ name: p.name });
    for (const a of r.ambiguous) if (!out.some((x) => fold(x.name) === fold(a.label))) out.push({ name: a.label });
    return out;
  }

  // ---------------------------------------------------------------- finding people in a message

  /** Who a message names (STAPLES §9.4): resolved people in order, and names that could be several. */
  find(text: string, ctx: FindContext = {}): FindResult {
    const folded = fold(text);
    const people = this.all().filter((p) => ctx.includeProposed || p.status === 'active');
    if (!people.length || !folded.trim()) return { found: [], ambiguous: [] };
    type Hit = { p: Person; start: number; end: number; label: string };
    const hits: Hit[] = [];
    for (const p of people) {
      for (const label of new Set([p.name, p.fullName ?? '', ...p.aliases].filter((l) => l.trim().length >= 2))) {
        for (const m of folded.matchAll(wordRe(label, 'gu'))) hits.push({ p, start: m.index, end: m.index + m[0].length, label });
      }
    }
    if (!hits.length) return { found: [], ambiguous: [] };
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    // Overlapping hits are one name in the text ("Jeff" and "Jeff from work" at the same place).
    const groups: Hit[][] = [];
    for (const h of hits) {
      const g = groups.at(-1);
      if (g && h.start < Math.max(...g.map((x) => x.end))) g.push(h);
      else groups.push([h]);
    }
    const found: Person[] = [];
    const ambiguous: { label: string; people: Person[] }[] = [];
    const recent = ctx.conversationId ? this.#recentInConversation(ctx.conversationId, ctx.beforeMessageId) : new Map<number, number>();
    const convAlias = ctx.conversationId ? this.#convAliases(ctx.conversationId) : {};
    for (const g of groups) {
      const longest = Math.max(...g.map((h) => h.end - h.start));
      const top = g.filter((h) => h.end - h.start === longest);
      let cands = [...new Map(top.map((h) => [h.p.id, h.p])).values()];
      const allCands = [...new Map(g.map((h) => [h.p.id, h.p])).values()];
      // A longer label ("Jeff from work", "Jeff Miller") only one card has wins on its own.
      if (cands.length === 1 && allCands.length > 1 && longest > Math.min(...g.map((h) => h.end - h.start))) {
        found.push(cands[0]);
        continue;
      }
      cands = allCands;
      if (cands.length === 1) {
        found.push(cands[0]);
        continue;
      }
      const start = Math.min(...g.map((h) => h.start));
      const end = Math.max(...g.map((h) => h.end));
      const pick = this.#decide(cands, folded, start, end, { recent, convAlias, label: fold(g[0].label), work: Boolean(ctx.work) });
      if (pick) found.push(pick);
      else ambiguous.push({ label: text.slice(start, end) || g[0].label, people: cands });
    }
    return { found: [...new Map(found.map((p) => [p.id, p])).values()], ambiguous };
  }

  #decide(cands: Person[], folded: string, start: number, end: number, c: { recent: Map<number, number>; convAlias: Record<string, number>; label: string; work: boolean }): Person | undefined {
    // 1. A qualifier next to the name ("my brother Jeff", "Jeff from work", a surname) wins.
    const near = folded.slice(Math.max(0, start - 40), Math.min(folded.length, end + 40));
    const qual = cands.filter((p) => qualifies(p, near));
    if (qual.length === 1) return qual[0];
    // The answer to her question earlier in this conversation ("your brother Jeff or Jeff from work?").
    const aliasId = c.convAlias[c.label];
    if (aliasId) {
      const p = cands.find((x) => x.id === aliasId);
      if (p) return p;
    }
    // 2. Context: the one talked about in the last 20 messages of this conversation (the latest wins).
    const inConv = cands.filter((p) => c.recent.has(p.id)).sort((a, b) => (c.recent.get(b.id) ?? 0) - (c.recent.get(a.id) ?? 0));
    if (inConv.length) return inConv[0];
    // A shared work channel prefers the work card.
    if (c.work) {
      const w = cands.filter((p) => p.circle === 'work');
      if (w.length === 1) return w[0];
    }
    // Then the one mentioned most lately, by a clear margin (more than 3× the others).
    const since = new Date(this.#now().getTime() - 30 * DAY).toISOString();
    const counts = cands.map((p) => ({ p, n: Number((this.db.prepare('SELECT COUNT(*) AS n FROM person_mentions WHERE person_id = ? AND at >= ?').get(p.id, since) as Row).n) })).sort((a, b) => b.n - a.n);
    // (At least 4 recent mentions: two or three aren't "clearly" the one he means.)
    if (counts[0].n >= 4 && counts.slice(1).every((x) => counts[0].n > 3 * x.n)) return counts[0].p;
    // 3. Otherwise no guess.
    return undefined;
  }

  #recentInConversation(conversationId: string, before?: number): Map<number, number> {
    const ids = this.db.prepare(`SELECT id FROM messages WHERE conversation_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT 20`).all(...(before ? [conversationId, before] : [conversationId])) as Row[];
    if (!ids.length) return new Map();
    const min = Math.min(...ids.map((r) => Number(r.id)));
    const max = before ? before - 1 : Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare('SELECT person_id, MAX(message_id) AS m FROM person_mentions WHERE conversation_id = ? AND message_id >= ? AND message_id <= ? GROUP BY person_id').all(conversationId, min, max) as Row[];
    return new Map(rows.map((r) => [Number(r.person_id), Number(r.m)]));
  }
  #convAliases(conversationId: string): Record<string, number> {
    try {
      return JSON.parse(this.#kv(`people:alias:${conversationId}`) ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  }

  /**
   * Each owner message (STAPLES §9.3 "Mentions"): matched cheaply against names and aliases; updates
   * last mentioned and mentions; a proposed card mentioned in 3 conversations becomes active on its
   * own (*added on her own*). An answer to her "which Jeff?" becomes this conversation's alias.
   */
  noteMessage(conversationId: string, messageId: number, text: string, at: string, opts: { work?: boolean } = {}): { found: Person[]; ambiguous: FindResult['ambiguous']; activated: Person[] } {
    const activated: Person[] = [];
    // Her question from the turn before: does this message say which one?
    const askKey = `people:ask:${conversationId}`;
    const asked = this.#kv(askKey);
    let answered: Person | undefined;
    if (asked) {
      try {
        const q = JSON.parse(asked) as { label: string; ids: number[] };
        const folded = fold(text);
        const cands = q.ids.map((id) => this.get(id)).filter((p): p is Person => Boolean(p && (p.status === 'active' || p.status === 'proposed')));
        const hit = cands.filter((p) => qualifies(p, folded));
        if (hit.length === 1) {
          answered = hit[0];
          const map = this.#convAliases(conversationId);
          map[fold(q.label)] = answered.id;
          this.#kvSet(`people:alias:${conversationId}`, JSON.stringify(map));
          this.#kvSet(askKey, null);
        }
      } catch {
        this.#kvSet(askKey, null);
      }
    }
    const r = this.find(text, { conversationId, beforeMessageId: messageId, includeProposed: true, work: Boolean(opts.work) });
    const found = answered && !r.found.some((p) => p.id === answered!.id) ? [...r.found, answered] : r.found;
    const ins = this.db.prepare('INSERT OR IGNORE INTO person_mentions (person_id, conversation_id, message_id, at) VALUES (?, ?, ?, ?)');
    for (const p of found) {
      if (!Number(ins.run(p.id, conversationId, messageId, at).changes)) continue;
      this.db.prepare('UPDATE people SET mentions = mentions + 1, last_mentioned = ?, first_mentioned = COALESCE(first_mentioned, ?) WHERE id = ?').run(at, at, p.id);
      if (p.status === 'proposed') {
        const convs = Number((this.db.prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM person_mentions WHERE person_id = ?').get(p.id) as Row).n);
        if (convs >= AUTO_ACTIVE_CONVERSATIONS) {
          this.db.prepare("UPDATE people SET status = 'active', origin = 'her', updated_at = ? WHERE id = ? AND status = 'proposed'").run(at, p.id);
          activated.push(this.get(p.id)!);
        }
      }
    }
    // A name that could be several active people: she may ask; the answer is caught above next time.
    const amb = r.ambiguous.map((a) => ({ ...a, people: a.people.filter((p) => p.status === 'active') })).filter((a) => a.people.length > 1);
    if (amb.length) this.#kvSet(askKey, JSON.stringify({ label: amb[0].label, ids: amb[0].people.map((p) => p.id), at: messageId }));
    if (found.length || activated.length) this.#changed();
    return { found, ambiguous: amb, activated };
  }

  /** How many different conversations named this card. */
  conversationsMentioning(id: number): number {
    return Number((this.db.prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM person_mentions WHERE person_id = ?').get(id) as Row).n);
  }
  /** The last few times he mentioned them (for the card: "recent mentions"). */
  recentMentions(id: number, limit = 5): { conversationId: string; messageId: number; at: string }[] {
    return (this.db.prepare('SELECT conversation_id, message_id, at FROM person_mentions WHERE person_id = ? ORDER BY message_id DESC LIMIT ?').all(id, limit) as Row[]).map((r) => ({ conversationId: String(r.conversation_id), messageId: Number(r.message_id), at: String(r.at) }));
  }

  // ---------------------------------------------------------------- recall (STAPLES §9.5)

  /**
   * The People section of a turn's notes: up to 3 active people the message names, each one line of
   * who they are plus up to 3 facts (ranked by relevance, how sure, how recent; each dated). Private
   * facts only in private conversations; sensitive facts only when the message is about that person
   * and the topic. A name that could be two people gives the ambiguity note instead of a guess.
   */
  section(text: string, ctx: SectionContext): { text: string; personIds: number[]; ambiguous: string[] } {
    const r = this.find(text, ctx);
    const lines: string[] = [];
    const ids: number[] = [];
    let chars = 0;
    const push = (line: string) => {
      if (chars + line.length + 1 > ctx.maxChars) return false;
      lines.push(line);
      chars += line.length + 1;
      return true;
    };
    const words = new Set((fold(text).match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((w) => w.replace(/s$/, '')));
    for (const p of r.found.slice(0, 3)) {
      const who = [p.relation ? p.relation.replace(/^my\s+/i, 'your ') : '', p.fullName && p.fullName !== p.name ? p.fullName : '', p.birthday ? `birthday ${fmtDay(p.birthday)}` : ''].filter(Boolean).join(', ');
      const facts = this.facts(p.id)
        .filter((f) => !f.pending && (!f.private || ctx.private) && (!f.category || TOPIC[f.category].test(text)))
        .map((f) => {
          const fw = new Set((fold(f.content).match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((w) => w.replace(/s$/, '')));
          const overlap = [...fw].filter((w) => words.has(w) && !fold(p.name).includes(w)).length;
          const age = Math.max(0, (Date.parse(`${ctx.today}T12:00:00Z`) - Date.parse(`${f.happenedOn}T12:00:00Z`)) / DAY);
          return { f, score: overlap * 2 + f.sure + Math.exp(-age / 180) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ f }) => `${f.content.replace(/\s+/g, ' ').trim().replace(/\.$/, '')} (${fmtDay(f.happenedOn)})`);
      const links = this.links(p.id).slice(0, 2).map((l) => `${l.person.name}: ${l.relation}`);
      const line = `- ${p.name}${who ? ` — ${who}` : ''}${facts.length ? `; ${facts.join('; ')}` : ''}${links.length ? ` [${links.join(', ')}]` : ''}`;
      if (push(line)) ids.push(p.id);
    }
    const amb: string[] = [];
    for (const a of r.ambiguous.slice(0, 2)) {
      const act = a.people.filter((p) => p.status === 'active');
      if (act.length < 2) continue;
      const opts = act.slice(0, 3).map(labelOf);
      const line = `- "${a.label}" could be ${opts.slice(0, -1).join(', ')} or ${opts.at(-1)}. Don't guess which: if it matters, ask ${ctx.owner} naturally ("${act.slice(0, 2).map((p) => quickLabel(p)).join(' or ')}?").`;
      if (push(line)) amb.push(a.label);
    }
    return { text: lines.join('\n'), personIds: ids, ambiguous: amb };
  }

  /** Birthdays on cards that aren't already a date memory (those come through the dates as before). */
  birthdays(today: string, days = 14): { person: Person; inDays: number; date: string }[] {
    const [y, mo, d] = today.split('-').map(Number);
    const base = Date.UTC(y, mo - 1, d);
    const out: { person: Person; inDays: number; date: string }[] = [];
    for (const p of this.all().filter((x) => x.status === 'active' && x.birthday)) {
      const md = /(\d{2})-(\d{2})$/.exec(p.birthday!);
      if (!md) continue;
      // Already a date memory linked to this card on the same day: Today shows it once (that one).
      const dup = this.db.prepare("SELECT 1 FROM person_facts f JOIN memories m ON m.id = f.memory_id WHERE f.person_id = ? AND m.kind = 'date' AND substr(m.on_date, -5) = ? LIMIT 1").get(p.id, `${md[1]}-${md[2]}`);
      if (dup) continue;
      for (const year of [y, y + 1]) {
        const at = Date.UTC(year, Number(md[1]) - 1, Number(md[2]));
        const inDays = Math.round((at - base) / DAY);
        if (inDays < 0 || inDays > days) continue;
        out.push({ person: p, inDays, date: `${year}-${md[1]}-${md[2]}` });
        break;
      }
    }
    return out.sort((a, b) => a.inDays - b.inDays);
  }

  // ---------------------------------------------------------------- never to outside

  /**
   * The one check for anything leaving her space (STAPLES §9.6): a memory linked to a person, or a
   * text naming any card (proposed or active, by name, full name or alias), is left out.
   */
  gate(): { memory: (m: { id?: number; content?: string }) => boolean; text: (s: string | undefined) => boolean } {
    const labels = [...new Set(this.all().flatMap((p) => [p.name, p.fullName ?? '', ...p.aliases]).filter((l) => l.trim().length >= 2).map(fold))];
    const re = labels.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${labels.sort((a, b) => b.length - a.length).map((l) => esc(l).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'u') : null;
    const linked = new Set((this.db.prepare('SELECT DISTINCT memory_id FROM person_facts WHERE memory_id IS NOT NULL').all() as Row[]).map((r) => Number(r.memory_id)));
    const text = (s: string | undefined) => !s || !re || !re.test(fold(s));
    return { memory: (m) => !(m.id !== undefined && linked.has(m.id)) && text(m.content), text };
  }

  /** Fact texts and his notes (for the A2A "quotes private material" check). */
  privateTexts(limit = 3000): string[] {
    const facts = (this.db.prepare("SELECT f.content FROM person_facts f JOIN people p ON p.id = f.person_id WHERE p.status IN ('proposed','active') ORDER BY f.id DESC LIMIT ?").all(limit) as Row[]).map((r) => String(r.content));
    const notes = this.all().map((p) => p.notes).filter(Boolean);
    return [...facts, ...notes];
  }

  // ---------------------------------------------------------------- the backfill (STAPLES §9.3)

  backfillStatus(): BackfillStatus {
    try {
      const s = JSON.parse(this.#kv('people:backfill') ?? '') as BackfillStatus;
      return s;
    } catch {
      return { state: 'never', done: 0, total: 0, tokens: 0, budget: BACKFILL_BUDGET, proposed: 0, usedModel: false };
    }
  }
  setBackfillStatus(s: BackfillStatus): void {
    this.#kvSet('people:backfill', JSON.stringify(s));
  }

  /** Counts for the page header (and Today): cards to check, people known. */
  counts(): { proposed: number; active: number } {
    const all = this.all();
    return { proposed: all.filter((p) => p.status === 'proposed').length, active: all.filter((p) => p.status === 'active').length };
  }
}

/** "Jeff (your brother)" → "your brother Jeff" for her question. */
function quickLabel(p: Person): string {
  const rel = p.relation ? p.relation.replace(/^my\s+/i, 'your ') : '';
  if (rel) return `${rel.charAt(0).toUpperCase()}${rel.slice(1)} ${p.name}`;
  const alias = p.aliases.find((a) => fold(a).startsWith(fold(p.name)) && fold(a) !== fold(p.name));
  return alias ?? p.fullName ?? p.name;
}

/** Whether the text around a name points at this person: relation words, circle words, surname, alias. */
function qualifies(p: Person, near: string): boolean {
  let foldedNear = near;
  for (const [re, to] of SAME_REL) foldedNear = foldedNear.replace(re, to);
  const core = relCore(p.relation);
  if (core && wordRe(core).test(foldedNear)) return true;
  if (core) {
    const lastWord = core.split(/\s+/).at(-1)!;
    if (lastWord.length >= 3 && wordRe(lastWord).test(foldedNear)) return true;
  }
  if (p.circle === 'work' && /\b(from work|at work|work|office|coworker|co-worker|colleague|my team|the team)\b/.test(foldedNear)) return true;
  if (p.circle === 'neighbour' && /\bneighbou?r\b/.test(foldedNear)) return true;
  if (p.fullName) {
    const last = fold(p.fullName).split(/\s+/).slice(1).join(' ');
    if (last && wordRe(last).test(foldedNear)) return true;
  }
  for (const a of p.aliases) {
    const extra = fold(a).replace(fold(p.name), '').trim();
    if (extra.length >= 3 && foldedNear.includes(extra)) return true;
  }
  return false;
}

function cleanName(n: unknown): string {
  return String(n ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
function uniqAliases(list: string[], name: string): string[] {
  const out: string[] = [];
  const seen = new Set([fold(name)]);
  for (const a of list.map(cleanName).filter(Boolean)) {
    if (seen.has(fold(a))) continue;
    seen.add(fold(a));
    out.push(a);
  }
  return out.slice(0, 20);
}
/** "MM-DD" or "YYYY-MM-DD" when it's a real day, else undefined. */
export function validBirthday(v: unknown): string | undefined {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return undefined;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(Number(m[1] ?? 2000), mo, 0)).getUTCDate()) return undefined;
  return m[0];
}
function fmtDay(iso: string): string {
  const m = /(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3]), 12)));
}
export { ymd };
