// W1.1 (docs/design/W1KNOW.md, docs/WHAT_SARA_KNOWS.md): one "What I know about you" page you can see
// and steer. Built on N6 (src/facts.ts: memory facts + document facts with sources), it adds what the
// page needs to be the one place: topics with W0.6 ages, search, "Why do you think that?" (the source
// message), "That's wrong" and "Forget" with Undo on the V5.1 action timeline, duplicate merge
// suggestions, and counts of what else she keeps (people, notes, renewals, purchases, learned skills,
// how you like to work; the health log only as "kept private"). Everything is per space, so a household
// member sees only their own. Nothing is stored twice: merges use the memory's own `superseded_by`.
import type { AppContext } from './chat.ts';
import { FACT_GROUPS, FactsError, factsFor, maskCardsAndSsn, type FactGroup, type WorldFact } from './facts.ts';
import { HealthLog } from './health-log.ts';
import { en } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { queryWords, stem } from './memory-rank.ts';
import { renewalsOf } from './renewals.ts';
import { dayAge } from './time-sense.ts';
import { registerRevert, TimelineError, timelineOf } from './timeline.ts';

export interface KnowItem extends WorldFact {
  /** Days since she learned it (W0.6, the owner's own today). */
  ageDays: number | null;
  /** W0.6 words in English ("yesterday", "3 months ago"); the web words it in the page's language. */
  age: string;
  /** "Why do you think that?" has something to show (a chat message or a document page). */
  why: boolean;
}
export interface KnowTopic {
  id: FactGroup;
  items: KnowItem[];
}
export interface KnowPair {
  keep: KnowItem;
  drop: KnowItem;
}
export interface KnowAlso {
  id: 'people' | 'notes' | 'style' | 'renewals' | 'purchases' | 'skills' | 'health';
  /** null = not counted on purpose (the health log stays private). */
  count: number | null;
  /** Where it lives (a #view= link); null = on this page. */
  open: string | null;
}
export interface KnowView {
  today: string;
  total: number;
  topics: KnowTopic[];
  duplicates: KnowPair[];
  also: KnowAlso[];
}

const today = (app: AppContext) => localDate(app.now().toISOString(), app.settings.get().timeZone);
const DAY = 86_400_000;

function item(f: WorldFact, day: string): KnowItem {
  const a = Date.parse(`${f.learnedOn.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${day}T00:00:00Z`);
  const ageDays = Number.isFinite(a) && Number.isFinite(b) && a <= b ? Math.round((b - a) / DAY) : null;
  const why = (f.source.kind === 'chat' && Boolean(f.source.messageId)) || f.source.kind === 'document';
  return { ...f, ageDays, age: dayAge(f.learnedOn, day), why };
}

const stems = (s: string) => new Set(queryWords(s).map(stem));

function matches(f: WorldFact, words: string[]): boolean {
  const have = stems([f.text, f.value ?? '', f.label ?? '', f.quote ?? '', f.source.title ?? '', f.source.name ?? ''].join(' '));
  return words.every((w) => have.has(w) || [...have].some((h) => h.startsWith(w)));
}

/** Near-same memory facts (most words shared), newest kept. Document facts are left alone. */
export function duplicatePairs(facts: WorldFact[], o: { skip?: Set<string>; limit?: number } = {}): { keep: WorldFact; drop: WorldFact }[] {
  const mem = facts.filter((f) => f.id.startsWith('m') && f.source.kind !== 'document');
  const sets = mem.map((f) => stems(f.text));
  const out: { keep: WorldFact; drop: WorldFact }[] = [];
  const used = new Set<string>();
  for (let i = 0; i < mem.length; i++) {
    for (let j = i + 1; j < mem.length; j++) {
      const a = mem[i]!;
      const b = mem[j]!;
      if (used.has(a.id) || used.has(b.id) || a.group !== b.group || (a.date ?? '') !== (b.date ?? '')) continue;
      const sa = sets[i]!;
      const sb = sets[j]!;
      if (sa.size < 2 || sb.size < 2) continue;
      let both = 0;
      for (const w of sa) if (sb.has(w)) both++;
      if (both < 2 || both / (sa.size + sb.size - both) < 0.7) continue;
      const newer = b.learnedOn > a.learnedOn || (b.learnedOn === a.learnedOn && Number(b.id.slice(1)) > Number(a.id.slice(1)));
      const [keep, drop] = newer ? [b, a] : [a, b];
      if (o.skip?.has(pairKey(keep.id, drop.id))) continue;
      out.push({ keep, drop });
      used.add(a.id).add(b.id);
    }
  }
  return out.slice(0, o.limit ?? 10);
}

const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const KEEP_BOTH = 'know.keepBoth';
function keptBoth(app: AppContext): Set<string> {
  try {
    return new Set(JSON.parse(app.memory?.kvGet(KEEP_BOTH) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function count(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

function also(app: AppContext): KnowAlso[] {
  const mem = app.memory;
  const out: KnowAlso[] = [
    { id: 'people', count: count(() => app.people?.list({ status: 'active' }).length ?? 0), open: '#view=memory' },
    { id: 'notes', count: count(() => mem?.listAll().filter((m) => m.kind !== 'fact' && m.kind !== 'date' && m.supersededBy === null).length ?? 0), open: '#view=memory' },
    { id: 'style', count: count(() => app.workingStyle?.list().filter((b) => b.status !== 'retired').length ?? 0), open: '#view=memory' },
    { id: 'renewals', count: count(() => renewalsOf(app).length), open: null },
    { id: 'purchases', count: count(() => Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM money_purchases').get() as { n: number }).n)), open: '#view=money' },
    { id: 'skills', count: count(() => Number((app.store.db.prepare("SELECT COUNT(*) AS n FROM skill_candidates WHERE status = 'accepted'").get() as { n: number }).n)), open: '#view=settings:ab-skills' },
  ];
  // The health log is encrypted and kept out of memory: say only that it exists; it opens on its own page.
  if (HealthLog.exists(app)) out.push({ id: 'health', count: null, open: '#view=health' });
  return out;
}

/** The page: every fact grouped by topic (page order), newest first, with age; search by words. */
export function knowView(app: AppContext, o: { q?: string } = {}): KnowView {
  const day = today(app);
  const all = factsFor(app).list();
  const words = queryWords(String(o.q ?? '').slice(0, 200)).map(stem);
  const shown = words.length ? all.filter((f) => matches(f, words)) : all;
  const topics: KnowTopic[] = [];
  for (const g of FACT_GROUPS) {
    const items = shown.filter((f) => f.group === g).map((f) => item(f, day));
    if (items.length) topics.push({ id: g, items });
  }
  const duplicates = words.length ? [] : duplicatePairs(all, { skip: keptBoth(app) }).map((p) => ({ keep: item(p.keep, day), drop: item(p.drop, day) }));
  return { today: day, total: shown.length, topics, duplicates, also: also(app) };
}

export interface KnowWhy {
  id: string;
  kind: 'chat' | 'document' | 'you';
  text: string;
  quote: string | null;
  learnedOn: string;
  title?: string | null;
  conversationId?: string | null;
  messageId?: number | null;
  /** The message it came from (masked); null when there is none or it was forgotten. */
  message?: { role: string; text: string; at: string } | null;
  /** The source message was forgotten (Forget on a chat): it is never shown again. */
  gone?: boolean;
  docId?: number | null;
  name?: string | null;
  page?: number | null;
}

const MAX_SAID = 600;
function excerpt(text: string, quote: string | null): string {
  const t = maskCardsAndSsn(text).replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_SAID) return t;
  const at = quote ? t.toLowerCase().indexOf(maskCardsAndSsn(quote).toLowerCase().slice(0, 40)) : -1;
  const from = Math.max(0, Math.min(t.length - MAX_SAID, at - 200));
  return `${from ? '… ' : ''}${t.slice(from, from + MAX_SAID).trim()}${from + MAX_SAID < t.length ? ' …' : ''}`;
}

/** "Why do you think that?": the words it came from, and where. */
export function knowWhy(app: AppContext, id: string): KnowWhy {
  const f = factsFor(app).get(id);
  if (!f) throw new FactsError(404, 'Fact not found');
  const base = { id: f.id, text: f.text, quote: f.quote, learnedOn: f.learnedOn };
  const s = f.source;
  if (s.kind === 'document') return { ...base, kind: 'document', docId: s.docId ?? null, name: s.name ?? null, page: s.page ?? null };
  if (s.kind !== 'chat') return { ...base, kind: 'you' };
  const msg = s.messageId ? app.store.messageById(s.messageId) : undefined;
  const ok = msg && msg.conversationId === s.conversationId && !msg.meta?.forgotten;
  return {
    ...base,
    kind: 'chat',
    title: s.title ?? null,
    conversationId: s.conversationId ?? null,
    messageId: ok ? msg.id : null,
    message: ok ? { role: msg.role, text: excerpt(msg.content, f.quote), at: msg.createdAt } : null,
    gone: Boolean(msg?.meta?.forgotten),
  };
}

function parse(id: string): { kind: 'm' | 'd'; n: number } {
  const m = /^([md])(\d+)$/.exec(String(id));
  if (!m) throw new FactsError(404, 'Fact not found');
  return { kind: m[1] as 'm' | 'd', n: Number(m[2]) };
}

/** "Forget": gone from what she knows and uses, with Undo on the timeline (the exact row comes back). */
export function knowForget(app: AppContext, id: string, conversationId?: string): { timelineId: number } {
  const facts = factsFor(app);
  const f = facts.get(id);
  if (!f) throw new FactsError(404, 'Fact not found');
  const { kind, n } = parse(id);
  const row = kind === 'm' ? (app.store.db.prepare('SELECT * FROM memories WHERE id = ?').get(n) as Record<string, unknown> | undefined) : undefined;
  facts.remove(id);
  const text = f.text.slice(0, 120);
  const r = timelineOf(app).record({ tool: 'know_forget', kind: 'other', summary: `Forgot: ${text}`, conversationId: conversationId ?? null, title: en('Forgot: {text}'), params: { text }, undo: kind === 'm' ? { type: 'know_forget', memory: row } : { type: 'know_forget', doc: n } });
  return { timelineId: r.id };
}

/** "That's wrong": the corrected words replace hers (a memory fact edits the memory), with Undo. */
export function knowEdit(app: AppContext, id: string, text: string): { fact: WorldFact; timelineId: number } {
  const facts = factsFor(app);
  const { kind, n } = parse(id);
  const before = kind === 'm'
    ? (app.store.db.prepare('SELECT content, edited FROM memories WHERE id = ?').get(n) as { content: string; edited: number } | undefined)
    : (facts.db.prepare("SELECT edited FROM world_doc_facts WHERE id = ? AND status = 'active'").get(n) as { edited: string | null } | undefined);
  if (!before) throw new FactsError(404, 'Fact not found');
  const old = facts.get(id)?.text ?? '';
  const fact = facts.edit(id, text);
  const r = timelineOf(app).record({ tool: 'know_edit', kind: 'other', summary: `Corrected: ${fact.text.slice(0, 120)}`, title: en('Corrected: {text}'), params: { text: fact.text.slice(0, 120), was: old.slice(0, 120) }, undo: { type: 'know_edit', id, before } });
  return { fact, timelineId: r.id };
}

/** Merge two near-same facts: the dropped one is replaced by the kept one (kept for review), with Undo. */
export function knowMerge(app: AppContext, keep: string, drop: string): { timelineId: number } {
  if (keep === drop) throw new FactsError(400, en('Pick two different facts.'));
  const a = parse(keep);
  const b = parse(drop);
  if (a.kind !== 'm' || b.kind !== 'm') throw new FactsError(400, en('Only facts she learned from you can be merged.'));
  const facts = factsFor(app);
  const k = facts.get(keep);
  const d = facts.get(drop);
  if (!k || !d) throw new FactsError(404, 'Fact not found');
  app.memory!.supersede(b.n, a.n);
  const r = timelineOf(app).record({ tool: 'know_merge', kind: 'other', summary: `Merged: ${k.text.slice(0, 120)}`, title: en('Merged: {text}'), params: { text: k.text.slice(0, 120) }, undo: { type: 'know_merge', drop: b.n } });
  return { timelineId: r.id };
}

/** "Keep both": that pair is never suggested again. */
export function knowKeepBoth(app: AppContext, a: string, b: string): void {
  parse(a);
  parse(b);
  const set = keptBoth(app);
  set.add(pairKey(a, b));
  app.memory?.kvSet(KEEP_BOTH, JSON.stringify([...set].slice(-500)));
}

// ---- Undo on the action timeline (V5.1)

registerRevert('know_forget', (u, app) => {
  if (u.doc !== undefined) {
    const n = Number(u.doc);
    if (!Number(factsFor(app).db.prepare("UPDATE world_doc_facts SET status = 'active' WHERE id = ? AND status = 'deleted'").run(n).changes)) throw new TimelineError(409, en('That fact is no longer there to bring back.'));
    return;
  }
  const row = u.memory as Record<string, string | number | null> | undefined;
  if (!row || typeof row.id !== 'number' || !app.memory) throw new TimelineError(409, en('That fact is no longer there to bring back.'));
  if (app.memory.get(row.id)) throw new TimelineError(409, en('That fact is already back.'));
  const cols = Object.keys(row).filter((c) => /^[a-z_]+$/.test(c));
  app.store.db.prepare(`INSERT INTO memories (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c] ?? null));
});

registerRevert('know_edit', (u, app) => {
  const { kind, n } = parse(String(u.id));
  const before = u.before as { content?: string; edited?: number | string | null };
  if (kind === 'm') {
    if (!app.memory?.get(n)) throw new TimelineError(409, en('That fact is no longer there to bring back.'));
    app.memory.update(n, String(before.content ?? ''));
    app.store.db.prepare('UPDATE memories SET edited = ? WHERE id = ?').run(Number(before.edited ?? 0), n);
  } else if (!Number(factsFor(app).db.prepare("UPDATE world_doc_facts SET edited = ? WHERE id = ? AND status = 'active'").run((before.edited as string | null) ?? null, n).changes)) {
    throw new TimelineError(409, en('That fact is no longer there to bring back.'));
  }
});

registerRevert('know_merge', (u, app) => {
  const n = Number(u.drop);
  if (!app.memory?.get(n)) throw new TimelineError(409, en('That fact is no longer there to bring back.'));
  app.memory.supersede(n, null);
});
