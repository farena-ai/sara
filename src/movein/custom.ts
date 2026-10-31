// Phase 105 (MI2, docs/design/MOVE_IN.md §8.3, §8.4): the mapper. A confirmed card's mapping runs
// over the store's row parts in the bundle, one table after another, streamed (never a whole table
// in memory). Joins (facts → people, messages → conversations, lookups) happen in SQLite temp tables
// with an index on the join key; rows land in the staging database as findings in transactions of
// 5 000, so the preview counts them and the one batch (MI1) imports them; Undo removes them.
// The same code renders the three sample cards (on a small in-memory database), so "Looks right"
// is judged on what the mapper really makes, not on column names.
import type { DatabaseSync } from 'node:sqlite';
import { detectMinorSexualContent } from '../safety.ts';
import { NO_GOAL_TOPIC } from '../agenda.ts';
import type { MemoryKind } from '../memory.ts';
import type { Bundle } from './bundle.ts';
import { note, type Row, rows } from './readers/common.ts';
import { evalExpr, type FamilyMapping, keepRow, newestOf, plain, type TableMapping, type Target, toDate } from './mapping.ts';
import type { Family, StoreProfile, TableProfile } from './schema.ts';
import { categoryOf } from './text.ts';
import type { Category, ConversationData, Finding, GoalData, PersonData, TaskData } from './types.ts';

/** §15 Q5: facts per person that stay active; the rest arrive as archived notes. */
export const FACTS_PER_PERSON = 200;
/** §8.4: opinions and self-narrative notes that stay active. */
export const SELF_NOTES_ACTIVE = 500;
const KINDS: ReadonlySet<string> = new Set(['fact', 'decision', 'lesson', 'promise', 'date', 'summary', 'self', 'reflection', 'milestone']);
const ORDER: Record<Target, number> = { person: 0, conversation: 0, person_alias: 1, person_fact: 1, message: 1, memory: 2, owner_fact: 2, goal: 2, opinion: 2, diary: 2, task: 2, skip: 9 };

export interface MapContext {
  scrub: (s: string) => string;
  now: Date;
  /** The old agent's name for her role in messages. */
  agentWords?: string[];
}
export interface MapRun {
  b: Bundle;
  store: StoreProfile;
  family: Family;
  mapping: FamilyMapping;
  /** Where the joins happen: a scratch database of its own (never the staging one), or :memory: for the sample cards. */
  db: DatabaseSync;
  emit: (f: Finding) => void;
  ctx: MapContext;
  /** Rows per table (the sample cards read only the first few hundred). */
  limit?: number;
  signal?: AbortSignal;
  progress?: (table: string, done: number, total: number) => void;
}
export interface MapResult {
  /** Findings made, by target. */
  made: Record<string, number>;
  /** Rows dropped, by reason (minors check, no person, empty, not a goal topic…). */
  dropped: Record<string, number>;
  /** People facts checked against their person (the §14 "500-row check"). */
  joinCheck: { checked: number; matched: number };
  rowsRead: number;
}

export const cardKey = (store: string, family: string): string => `${store}/${family}`;
const day = (iso: string | null | undefined, fallback: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : fallback);
const bump = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** One table's rows from the bundle (or its samples when the collector packed none), newest-N applied. */
async function* source(run: MapRun, t: TableProfile, tm: TableMapping): AsyncGenerator<{ row: Row; n: number }> {
  const newest = newestOf(tm.filter);
  const limit = run.limit ?? Infinity;
  const it = t.packed > 0 ? rows(run.b, run.store.path, t.key, run.signal) : (async function* () {
    for (const r of t.samples) yield r;
  })();
  if (!newest) {
    let n = 0;
    for await (const row of it) {
      if (n >= limit) break;
      yield { row, n: n++ };
    }
    return;
  }
  // Newest N by a column: kept in a temp table (sorted there, never in memory).
  run.db.exec('DROP TABLE IF EXISTS temp.mi_newest; CREATE TEMP TABLE mi_newest (s TEXT, j TEXT); CREATE INDEX temp.mi_newest_s ON mi_newest(s)');
  const ins = run.db.prepare('INSERT INTO temp.mi_newest (s, j) VALUES (?, ?)');
  let k = 0;
  // Inside the caller's transaction (a temp table: nothing reaches the disk file).
  for await (const row of it) {
    if (k++ >= limit) break;
    const v = row[newest.col];
    ins.run(typeof v === 'number' ? String(Math.round(v)).padStart(20, '0') : plain(v), JSON.stringify(row));
  }
  let n = 0;
  for (const r of run.db.prepare('SELECT j FROM temp.mi_newest ORDER BY s DESC LIMIT ?').iterate(newest.n) as Iterable<{ j: string }>) yield { row: JSON.parse(r.j) as Row, n: n++ };
  run.db.exec('DROP TABLE IF EXISTS temp.mi_newest');
}

/** Runs one card's mapping (§8.4). */
export async function runMapping(run: MapRun): Promise<MapResult> {
  const { db, store, family, mapping, ctx } = run;
  const card = cardKey(store.id, family.id);
  const res: MapResult = { made: {}, dropped: {}, joinCheck: { checked: 0, matched: 0 }, rowsRead: 0 };
  const byKey = new Map(store.tables.map((t) => [t.key, t]));
  const today = ctx.now.toISOString().slice(0, 10);
  db.exec(`DROP TABLE IF EXISTS temp.mi_lookup; DROP TABLE IF EXISTS temp.mi_person; DROP TABLE IF EXISTS temp.mi_alias; DROP TABLE IF EXISTS temp.mi_fact; DROP TABLE IF EXISTS temp.mi_conv; DROP TABLE IF EXISTS temp.mi_msg; DROP TABLE IF EXISTS temp.mi_self;
    CREATE TEMP TABLE mi_lookup (tbl TEXT, k TEXT, col TEXT, v TEXT); CREATE INDEX temp.mi_lookup_k ON mi_lookup(tbl, col, k);
    CREATE TEMP TABLE mi_person (k TEXT PRIMARY KEY, name TEXT, ref TEXT, j TEXT, held TEXT); CREATE INDEX temp.mi_person_name ON mi_person(name);
    CREATE TEMP TABLE mi_alias (k TEXT, alias TEXT, UNIQUE(k, alias));
    CREATE TEMP TABLE mi_fact (k TEXT, norm TEXT, day TEXT, content TEXT, source TEXT, conf REAL, held TEXT, ref TEXT, UNIQUE(k, norm, day)); CREATE INDEX temp.mi_fact_k ON mi_fact(k, day);
    CREATE TEMP TABLE mi_conv (k TEXT PRIMARY KEY, title TEXT, started TEXT, channel TEXT, ref TEXT);
    CREATE TEMP TABLE mi_msg (k TEXT, at TEXT, seq INTEGER, role TEXT, text TEXT); CREATE INDEX temp.mi_msg_k ON mi_msg(k, at, seq);
    CREATE TEMP TABLE mi_self (target TEXT, day TEXT, j TEXT); CREATE INDEX temp.mi_self_t ON mi_self(target, day);`);
  const tx = (() => {
    let n = 0;
    return {
      begin: () => db.exec('BEGIN'),
      tick: () => {
        if (++n % 5000 === 0) {
          db.exec('COMMIT');
          db.exec('BEGIN');
        }
      },
      end: () => db.exec('COMMIT'),
    };
  })();

  // ---- lookups first: the referenced table's key → value, indexed ----
  const lookups = new Map<string, Set<string>>();
  for (const tm of mapping.tables) {
    if (tm.target === 'skip') continue;
    for (const e of Object.values(tm.fields)) {
      const walk = (x: unknown): void => {
        if (!x || typeof x !== 'object') return;
        const o = x as Record<string, unknown>;
        if (o.lookup) {
          const l = o.lookup as { table: string; key: string; value: string };
          lookups.set(`${l.table}\u0000${l.key}`, new Set([...(lookups.get(`${l.table}\u0000${l.key}`) ?? []), l.value]));
        }
        for (const v of Object.values(o)) if (Array.isArray(v)) v.forEach(walk);
      };
      walk(e);
    }
  }
  const insL = db.prepare('INSERT INTO temp.mi_lookup (tbl, k, col, v) VALUES (?, ?, ?, ?)');
  for (const [tk, values] of lookups) {
    const [table, key] = tk.split('\u0000');
    const t = byKey.get(table);
    if (!t) continue;
    tx.begin();
    for await (const { row } of source(run, t, { table, target: 'skip', fields: {}, reason: '', confidence: 0 })) {
      for (const v of values) insL.run(table, plain(row[key]), v, plain(row[v]));
      tx.tick();
    }
    tx.end();
  }
  const getL = db.prepare('SELECT v FROM temp.mi_lookup WHERE tbl = ? AND col = ? AND k = ? LIMIT 1');
  const lookup = (table: string, _key: string, value: string, id: unknown) => (getL.get(table, value, plain(id)) as { v: string } | undefined)?.v ?? null;

  const field = (tm: TableMapping, name: string, row: Row): unknown => (tm.fields[name] ? evalExpr(tm.fields[name], row, lookup) : undefined);
  const text = (tm: TableMapping, name: string, row: Row, max = 2000): string => ctx.scrub(plain(field(tm, name, row)).replace(/\s+/g, ' ').trim()).slice(0, max);
  const dateField = (tm: TableMapping, name: string, row: Row): string | null => {
    const v = field(tm, name, row);
    return v === undefined || v === null || v === '' ? null : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : toDate(v, 'iso');
  };
  const heldOf = (t: TableProfile, ...texts: string[]): Category | undefined => (t.cats.includes('medical') ? 'medical' : t.cats.includes('intimate') ? 'intimate' : undefined) ?? texts.map((x) => categoryOf(x)).find(Boolean);
  const refOf = (t: TableProfile, row: Row, n: number) => `${store.path}${t.key}#${t.pk.length ? t.pk.map((k) => plain(row[k])).join('|') : n}`;
  const minors = (s: string) => {
    if (!detectMinorSexualContent(s)) return false;
    bump(res.dropped, 'minors-check');
    return true;
  };

  const ordered = [...mapping.tables].filter((x) => x.target !== 'skip').sort((a, b) => ORDER[a.target] - ORDER[b.target]);
  // The column a child's join value is compared with: the people/conversation table's FK target (else its key).
  const parentKey = (parentTable: string, child: TableProfile, col: string): string => child.fks.find((f) => f.from === col && f.table === parentTable)?.to ?? byKey.get(parentTable)?.pk[0] ?? 'id';
  const personTables = ordered.filter((x) => x.target === 'person').map((x) => x.table);
  const convTables = ordered.filter((x) => x.target === 'conversation').map((x) => x.table);
  const insP = db.prepare('INSERT OR IGNORE INTO temp.mi_person (k, name, ref, j, held) VALUES (?, ?, ?, ?, ?)');
  const insA = db.prepare('INSERT OR IGNORE INTO temp.mi_alias (k, alias) VALUES (?, ?)');
  const insF = db.prepare('INSERT OR IGNORE INTO temp.mi_fact (k, norm, day, content, source, conf, held, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insC = db.prepare('INSERT OR IGNORE INTO temp.mi_conv (k, title, started, channel, ref) VALUES (?, ?, ?, ?, ?)');
  const insM = db.prepare('INSERT INTO temp.mi_msg (k, at, seq, role, text) VALUES (?, ?, ?, ?, ?)');
  const insS = db.prepare('INSERT INTO temp.mi_self (target, day, j) VALUES (?, ?, ?)');
  const hasP = db.prepare('SELECT k FROM temp.mi_person WHERE k = ?');
  const byName = db.prepare('SELECT k FROM temp.mi_person WHERE name = ? LIMIT 1');
  const keyFor = new Map<string, string>();

  for (const tm of ordered) {
    const t = byKey.get(tm.table);
    if (!t) continue;
    const total = run.limit ? Math.min(run.limit, t.packed || t.samples.length) : t.packed || t.samples.length;
    const pcol = tm.target === 'person' ? personTables.length ? (() => {
      // The people table is keyed by the column the facts point at.
      for (const o of ordered) {
        const e = o.fields.person;
        if ((o.target === 'person_fact' || o.target === 'person_alias') && e && 'col' in e) {
          const child = byKey.get(o.table);
          if (child) return parentKey(t.key, child, e.col);
        }
      }
      return t.pk[0] ?? 'id';
    })() : 'id' : tm.target === 'conversation' ? (() => {
      for (const o of ordered) {
        const e = o.fields.conversation;
        if (o.target === 'message' && e && 'col' in e) {
          const child = byKey.get(o.table);
          if (child) return parentKey(t.key, child, e.col);
        }
      }
      return t.pk[0] ?? 'id';
    })() : '';
    keyFor.set(t.key, pcol);
    tx.begin();
    try {
      for await (const { row, n } of source(run, t, tm)) {
        res.rowsRead++;
        if (n % 2000 === 0) run.progress?.(t.key, n, total);
        tx.tick();
        if (!keepRow(tm.filter, row)) {
          bump(res.dropped, 'filtered');
          continue;
        }
        const ref = refOf(t, row, n);
        switch (tm.target) {
          case 'person': {
            const name = text(tm, 'name', row, 80);
            if (!name || minors(name)) {
              bump(res.dropped, 'empty');
              break;
            }
            const aliases = plain(field(tm, 'aliases', row)).split(/[,;|]/).map((x) => ctx.scrub(x.trim()).slice(0, 60)).filter((x) => x && x !== name);
            const bday = dateField(tm, 'birthday', row);
            const data = { name, aliases, relation: text(tm, 'relation', row, 60), birthday: bday ? bday.slice(0, 10) : null, notes: text(tm, 'notes', row, 1000) };
            insP.run(plain(row[pcol]) || `#${n}`, norm(name), ref, JSON.stringify(data), heldOf(t, data.notes) ?? null);
            for (const a of aliases) insA.run(plain(row[pcol]) || `#${n}`, a);
            break;
          }
          case 'person_alias':
          case 'person_fact': {
            const pv = plain(field(tm, 'person', row));
            const e = tm.fields.person;
            const k = pv && (hasP.get(pv) as { k: string } | undefined)?.k;
            const viaName = !k && pv ? (byName.get(norm(pv)) as { k: string } | undefined)?.k : undefined;
            const key = k || viaName;
            if (tm.target === 'person_fact') {
              res.joinCheck.checked++;
              if (key) res.joinCheck.matched++;
            }
            if (!key) {
              bump(res.dropped, tm.target === 'person_fact' ? 'no-person' : 'empty');
              break;
            }
            void e;
            if (tm.target === 'person_alias') {
              const a = text(tm, 'alias', row, 60);
              if (a) insA.run(key, a);
              break;
            }
            const content = text(tm, 'content', row);
            if (content.length < 3 || minors(content)) {
              bump(res.dropped, 'empty');
              break;
            }
            const d = day(dateField(tm, 'happenedOn', row), today);
            const conf = Number(plain(field(tm, 'confidence', row)));
            insF.run(key, norm(content), d, content, text(tm, 'source', row, 200) || null, Number.isFinite(conf) && plain(field(tm, 'confidence', row)) !== '' ? conf : null, heldOf(t, content) ?? null, ref);
            break;
          }
          case 'conversation': {
            const title = text(tm, 'title', row, 200);
            insC.run(plain(row[pcol]) || `#${n}`, title, dateField(tm, 'startedAt', row), text(tm, 'channel', row, 40) || null, ref);
            break;
          }
          case 'message': {
            const cv = plain(field(tm, 'conversation', row));
            const body = text(tm, 'text', row, 20_000);
            if (!cv || !body) {
              bump(res.dropped, 'empty');
              break;
            }
            const role = plain(field(tm, 'role', row)).toLowerCase();
            if (/^(tool|function|system|developer)/.test(role)) {
              bump(res.dropped, 'tool');
              break;
            }
            insM.run(cv, dateField(tm, 'at', row) ?? '', n, role, body);
            break;
          }
          case 'memory':
          case 'owner_fact': {
            const content = text(tm, 'content', row);
            const kindV = plain(field(tm, 'kind', row)).toLowerCase();
            const pin = field(tm, 'pinned', row);
            const ev = text(tm, 'evidence', row, 200);
            const before = Object.values(res.made).reduce((a, b) => a + b, 0);
            let made = false;
            note((f) => {
              made = true;
              run.emit(f);
            }, res.dropped, ctx, { section: tm.target === 'owner_fact' ? 'profile' : 'memories', ref, text: content, kind: tm.target === 'owner_fact' ? 'fact' : ((KINDS.has(kindV) ? kindV : classify(content)) as MemoryKind), happenedOn: day(dateField(tm, 'happenedOn', row), today), ...(pin === true || pin === 1 || plain(pin) === 'true' || plain(pin) === '1' ? { pinned: true } : {}), ...(ev ? { evidence: ev } : {}), tag: `from ${t.name}`, ...(heldOf(t, content) ? { held: heldOf(t, content) } : {}), card });
            if (made) bump(res.made, tm.target);
            else bump(res.dropped, 'empty');
            void before;
            break;
          }
          case 'opinion':
          case 'diary': {
            const content = text(tm, 'content', row);
            if (content.length < 3) {
              bump(res.dropped, 'empty');
              break;
            }
            insS.run(tm.target, day(dateField(tm, 'happenedOn', row), today), JSON.stringify({ content, ref, held: heldOf(t, content) ?? null, table: t.name }));
            break;
          }
          case 'goal': {
            const title = text(tm, 'title', row, 200);
            const why = text(tm, 'why', row, 600);
            if (!title || minors(`${title} ${why}`)) {
              bump(res.dropped, 'empty');
              break;
            }
            const happened = day(dateField(tm, 'happenedOn', row), today);
            // Goals about weight, food, medication or self-harm are never her goals (ST8): kept as a note.
            if (NO_GOAL_TOPIC.test(`${title} ${why}`)) {
              note(run.emit, res.dropped, ctx, { section: 'memories', ref, text: `My old agent had this as a goal: ${title}${why ? ` (${why})` : ''}`, kind: 'self', happenedOn: happened, tag: 'old goal (not one of her goals)', card, ...(heldOf(t, title) ? { held: heldOf(t, title) } : {}) });
              bump(res.made, 'goal-note');
              break;
            }
            const data: GoalData = { title, why, happenedOn: happened };
            const held = heldOf(t, title, why);
            run.emit({ section: 'agenda', kind: 'goal', ref, title, data, card, ...(held ? { held } : {}) });
            bump(res.made, 'goal');
            break;
          }
          case 'task': {
            const title = text(tm, 'title', row, 200);
            if (!title || minors(title)) {
              bump(res.dropped, 'empty');
              break;
            }
            const doneV = field(tm, 'done', row);
            const done = doneV === true || doneV === 1 || /^(1|true|yes|done|completed|finished|closed)$/i.test(plain(doneV).trim());
            const data: TaskData = { title, notes: text(tm, 'notes', row, 2000), dueAt: dateField(tm, 'dueAt', row), done };
            const held = heldOf(t, title, data.notes);
            run.emit({ section: 'tasks', kind: 'task', ref, title, data, card, ...(held ? { held } : {}) });
            bump(res.made, 'task');
            break;
          }
        }
      }
    } finally {
      tx.end();
    }
    run.progress?.(t.key, total, total);
    if (run.signal?.aborted) break;
  }

  await finishPeople(run, card, res, today);
  finishConversations(run, card, res);
  finishSelfNotes(run, card, res);
  db.exec('DROP TABLE IF EXISTS temp.mi_lookup; DROP TABLE IF EXISTS temp.mi_person; DROP TABLE IF EXISTS temp.mi_alias; DROP TABLE IF EXISTS temp.mi_fact; DROP TABLE IF EXISTS temp.mi_conv; DROP TABLE IF EXISTS temp.mi_msg; DROP TABLE IF EXISTS temp.mi_self;');
  return res;
}

function classify(text: string): MemoryKind {
  if (/\b(promised|i will|i'll|we agreed)\b/i.test(text)) return 'promise';
  if (/\b(decided|we chose|going with)\b/i.test(text)) return 'decision';
  if (/\b(learned|lesson|next time)\b/i.test(text)) return 'lesson';
  return 'fact';
}

/** People with their facts, joined in the temp tables (§8.4: deduped, 200 active per person). */
async function finishPeople(run: MapRun, card: string, res: MapResult, today: string): Promise<void> {
  const { db } = run;
  const aliases = db.prepare('SELECT alias FROM temp.mi_alias WHERE k = ?');
  const facts = db.prepare('SELECT content, day, source, conf, held, ref FROM temp.mi_fact WHERE k = ? ORDER BY day DESC, rowid DESC');
  for (const p of db.prepare('SELECT k, ref, j, held FROM temp.mi_person ORDER BY rowid').iterate() as Iterable<{ k: string; ref: string; j: string; held: string | null }>) {
    const base = JSON.parse(p.j) as Omit<PersonData, 'facts' | 'archivedFacts'>;
    const all = facts.all(p.k) as { content: string; day: string; source: string | null; conf: number | null; held: string | null; ref: string }[];
    // Held facts (medical, intimate) wait apart for the owner's yes, as notes about the person.
    for (const f of all.filter((x) => x.held)) {
      note(run.emit, res.dropped, run.ctx, { section: 'memories', ref: f.ref, text: `${base.name}: ${f.content}`, kind: 'fact', happenedOn: f.day || today, held: f.held as Category, card, tag: `about ${base.name}` });
      bump(res.made, 'held-fact');
    }
    const open = all.filter((x) => !x.held);
    const data: PersonData = {
      ...base,
      aliases: [...new Set([...base.aliases, ...(aliases.all(p.k) as { alias: string }[]).map((a) => a.alias)])].slice(0, 20),
      facts: open.slice(0, FACTS_PER_PERSON).map((f) => ({ content: f.content, happenedOn: f.day || today, ...(f.source ? { source: f.source } : {}), ...(f.conf !== null ? { confidence: f.conf } : {}) })),
      archivedFacts: open.slice(FACTS_PER_PERSON).map((f) => ({ content: f.content, happenedOn: f.day || today })),
    };
    run.emit({ section: 'people', kind: 'person', ref: p.ref, title: data.name, data, card, ...(p.held ? { held: p.held as Category } : {}) });
    bump(res.made, 'person');
    bump(res.made, 'person_fact', open.length);
    if (data.archivedFacts.length) bump(res.made, 'archived-facts', data.archivedFacts.length);
    await new Promise((r) => setImmediate(r));
  }
}

/** Messages grouped per conversation (ordered by time, then by row), with their conversation's title. */
function finishConversations(run: MapRun, card: string, res: MapResult): void {
  const { db, ctx } = run;
  const conv = db.prepare('SELECT title, started, channel, ref FROM temp.mi_conv WHERE k = ?');
  const msgs = db.prepare('SELECT at, role, text FROM temp.mi_msg WHERE k = ? ORDER BY at, seq');
  const keys = (db.prepare('SELECT DISTINCT k FROM temp.mi_msg').all() as { k: string }[]).map((r) => r.k);
  const agent = new RegExp(`^(assistant|ai|bot|agent|companion|model|her|she${(ctx.agentWords ?? []).map((w) => `|${w.toLowerCase().replace(/[^a-z0-9]+/g, '')}`).join('')})`);
  for (const k of keys) {
    const c = conv.get(k) as { title: string; started: string | null; channel: string | null; ref: string } | undefined;
    const list = msgs.all(k) as { at: string; role: string; text: string }[];
    const fallback = c?.started ?? ctx.now.toISOString();
    let last = fallback;
    const messages: ConversationData['messages'] = [];
    let i = 0;
    for (const m of list) {
      const role: 'user' | 'assistant' = m.role ? (agent.test(m.role.replace(/[^a-z0-9]+/g, '')) ? 'assistant' : 'user') : i % 2 ? 'assistant' : 'user';
      const at = m.at || last;
      last = at;
      i++;
      if (detectMinorSexualContent(m.text)) {
        bump(res.dropped, 'minors-check');
        continue;
      }
      messages.push({ role, text: m.text, at });
    }
    if (!messages.length) continue;
    const data: ConversationData = { sourceId: `movein:${card}:${k}`.slice(0, 280), title: c?.title || `Conversation ${k}`.slice(0, 120), createdAt: c?.started ?? messages[0].at, updatedAt: messages.at(-1)!.at, ...(c?.channel ? { channel: c.channel } : {}), messages };
    const held = messages.map((m) => categoryOf(m.text)).find(Boolean);
    run.emit({ section: 'conversations', kind: 'conversation', ref: c?.ref ?? `${run.store.path}#conversation:${k}`, title: data.title, data, card, ...(held ? { held } : {}) });
    bump(res.made, 'conversation');
    bump(res.made, 'message', messages.length);
  }
}

/** Opinions and self-narrative: the newest 500 of each active, the rest archived (§8.4). */
function finishSelfNotes(run: MapRun, card: string, res: MapResult): void {
  for (const target of ['opinion', 'diary'] as const) {
    let n = 0;
    for (const r of run.db.prepare('SELECT day, j FROM temp.mi_self WHERE target = ? ORDER BY day DESC, rowid DESC').iterate(target) as Iterable<{ day: string; j: string }>) {
      const x = JSON.parse(r.j) as { content: string; ref: string; held: Category | null; table: string };
      const content = target === 'opinion' && !/^(i|i'm|i’m|my)\b/i.test(x.content) ? `I think ${x.content.charAt(0).toLowerCase()}${x.content.slice(1)}` : x.content;
      let made = false;
      note((f) => {
        made = true;
        run.emit(f);
      }, res.dropped, run.ctx, { section: 'memories', ref: x.ref, text: content, kind: target === 'opinion' ? 'self' : 'reflection', happenedOn: r.day, tag: target === 'opinion' ? 'her opinion' : 'self-narrative', ...(n >= SELF_NOTES_ACTIVE ? { archived: true } : {}), ...(x.held ? { held: x.held } : {}), card });
      if (made) {
        n++;
        bump(res.made, target);
      }
    }
  }
}

/** The three sample cards per table, made by the real mapper on the first rows (§8.3). */
export async function previewMapping(b: Bundle, store: StoreProfile, family: Family, mapping: FamilyMapping, db: DatabaseSync, ctx: MapContext): Promise<{ samples: Record<string, { title: string; lines: string[]; section: string }[]>; made: Record<string, number>; dropped: Record<string, number>; joinCheck: MapResult['joinCheck'] }> {
  const out: Finding[] = [];
  const r = await runMapping({ b, store, family, mapping, db, emit: (f) => out.push(f), ctx, limit: 500 });
  const samples: Record<string, { title: string; lines: string[]; section: string }[]> = {};
  for (const f of out) {
    const k = f.section;
    samples[k] ??= [];
    if (samples[k].length >= 3) continue;
    // Health and intimate items wait for the owner's yes: their text is not shown on the card either.
    const held = (f as { held?: string }).held;
    samples[k].push(held ? { title: `«held: ${held}»`, section: f.section, lines: [] } : { title: f.title, section: f.section, lines: linesOf(f) });
  }
  return { samples, made: r.made, dropped: r.dropped, joinCheck: r.joinCheck };
}

function linesOf(f: Finding): string[] {
  const d = f.data as unknown as Record<string, unknown>;
  if (f.kind === 'person') {
    const p = f.data as PersonData;
    return [[p.relation, p.birthday ? `born ${p.birthday}` : '', p.aliases.length ? `also ${p.aliases.join(', ')}` : ''].filter(Boolean).join(' · '), ...p.facts.slice(0, 3).map((x) => `• ${x.content.slice(0, 160)} (${x.happenedOn})`), ...(p.facts.length > 3 ? [`+ ${p.facts.length - 3} more facts`] : [])].filter(Boolean);
  }
  if (f.kind === 'conversation') return (f.data as ConversationData).messages.slice(0, 3).map((m) => `${m.role === 'user' ? '›' : '‹'} ${m.text.slice(0, 160)}`);
  if (f.kind === 'memory') return [`${String(d.kind)} · ${String(d.happenedOn)}${d.archived ? ' · archived' : ''}`, String(d.content).slice(0, 300)];
  if (f.kind === 'goal') return [String(d.why || '').slice(0, 300)].filter(Boolean);
  if (f.kind === 'task') return [[d.dueAt ? `due ${String(d.dueAt).slice(0, 10)}` : '', d.done ? 'done' : ''].filter(Boolean).join(' · '), String(d.notes || '').slice(0, 200)].filter(Boolean);
  return [];
}
