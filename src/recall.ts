// Phase 32: she can look through her own past conversations (the real messages, not only her
// notes): by words, and by time ("yesterday", "last Tuesday", "in March"). Used by the `recall`
// tool and, automatically, when the owner refers to the past ("remember when…").
import type { AppContext } from './chat.ts';
import { ftsQuery, type MemoryStore } from './memory.ts';
import { localDate } from './memory-worker.ts';
import { importedName, isImportChannel, NOT_IMPORTED, type Store } from './store.ts';
import type { Tool } from './tools/types.ts';
import { ToolError } from './tools/types.ts';

/**
 * Hardening M3: conversations whose notes and lines may reach another app (the OpenAI-compatible
 * API, MCP ask_sara and read tools, Home Assistant): the owner's own, never other people's, private,
 * imported or adult-channel ones. `undefined` (a deleted conversation, or a note with none) is fine.
 */
export function sharedWithApps(c: { partner: string | null; private: boolean; channel: string } | undefined): boolean {
  if (!c) return true;
  // Phase 66: group chats stay in the app (like private ones), never shared with other apps.
  // Phase 100: conversations with other agents (A2A) never reach other apps either (and vice versa).
  return !c.partner && !c.private && !isImportChannel(c.channel) && !/-nsfw$/.test(c.channel) && c.channel !== 'group' && c.channel !== 'a2a';
}
/** Phase 66: the companion who said a group-chat line (its meta as stored). */
function groupFromName(meta: string | null): string {
  try {
    return String((JSON.parse(meta ?? '{}') as { groupFrom?: { name?: unknown } }).groupFrom?.name ?? 'Another companion');
  } catch {
    return 'Another companion';
  }
}
/** The SQL form of sharedWithApps for a conversation row `c`. */
const APP_SAFE_SQL = `c.partner IS NULL AND c.private = 0 AND c.channel NOT LIKE 'import-%' AND c.channel NOT LIKE '%-nsfw' AND c.channel <> 'group' AND c.channel <> 'a2a'`;

/** Everyday words that say nothing about what a memory is about. */
const COMMON = new Set('went go going goes gone got get gets getting did does done make made making had have having was were been said say says tell told know knew want wanted really just like yeah okay good great nice fun thing things stuff time night day lot little bit'.split(' '));

export interface Span {
  /** ISO instants, from inclusive, to exclusive. */
  from: string;
  to: string;
  /** How it was said, for her answer ("yesterday"). */
  label: string;
}

const DAY = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };

/** Midnight of a local calendar day in the owner's time zone, as a Date. */
/** The zone's offset from UTC at an instant, in ms (independent of the machine's own zone). */
function zoneOffset(at: number, timeZone?: string): number {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
  } catch {
    return 0;
  }
}

function localMidnight(day: string, timeZone?: string): Date {
  // The instant whose local time is `day` 00:00 (checked twice, for days when the clocks change).
  const utc = Date.parse(`${day}T00:00:00Z`);
  let t = utc - zoneOffset(utc, timeZone);
  t = utc - zoneOffset(t, timeZone);
  return new Date(t);
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function span(fromDay: string, toDayExcl: string, label: string, tz?: string): Span {
  return { from: localMidnight(fromDay, tz).toISOString(), to: localMidnight(toDayExcl, tz).toISOString(), label };
}

/** A time phrase in the owner's words → a span of local days. Undefined when there is none. */
export function parseWhen(text: string, now: Date, timeZone?: string): Span | undefined {
  const t = text.toLowerCase();
  const today = localDate(now.toISOString(), timeZone);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  let m: RegExpExecArray | null;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t))) return span(`${m[1]}-${m[2]}-${m[3]}`, addDays(`${m[1]}-${m[2]}-${m[3]}`, 1), `on ${m[0]}`, timeZone);
  // "October 2nd", "Oct 2", "2 October" (this year, or last year if that day is still ahead).
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  if ((m = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t)) || (m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}`).exec(t))) {
    const monthWord = /^\d/.test(m[1]) ? m[2] : m[1];
    const dayNum = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
    const mi = MONTHS.findIndex((x) => x.startsWith(monthWord.slice(0, 3)));
    if (mi >= 0 && dayNum >= 1 && dayNum <= 31) {
      let y = Number(today.slice(0, 4));
      const md = `${String(mi + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      if (md > today.slice(5)) y--;
      const day = `${y}-${md}`;
      return span(day, addDays(day, 1), `on ${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${dayNum}`, timeZone);
    }
  }
  if (/\b(earlier today|this morning|today|tonight|this afternoon|this evening)\b/.test(t)) return span(today, addDays(today, 1), 'today', timeZone);
  if (/\blast night\b/.test(t)) return span(addDays(today, -1), addDays(today, 1), 'last night', timeZone);
  if (/\byesterday\b/.test(t)) return span(addDays(today, -1), today, 'yesterday', timeZone);
  if (/\b(the )?day before yesterday\b/.test(t)) return span(addDays(today, -2), addDays(today, -1), 'the day before yesterday', timeZone);
  if ((m = /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple(?: of)?|few|\d+)\s+(day|week|month)s?\s+ago\b/.exec(t))) {
    const n = NUM[m[1].replace(' of', '')] ?? Number(m[1]);
    const days = m[2] === 'day' ? n : m[2] === 'week' ? n * 7 : n * 30;
    // "A week ago" means around then: a window either side.
    const pad = m[2] === 'day' ? 1 : m[2] === 'week' ? 3 : 10;
    return span(addDays(today, -days - pad), addDays(today, -days + pad + 1), m[0], timeZone);
  }
  if (/\bthe other day\b|\brecently\b|\blately\b/.test(t)) return span(addDays(today, -7), addDays(today, 1), 'the last few days', timeZone);
  if (/\bthis week\b/.test(t)) return span(addDays(today, -dow), addDays(today, 1), 'this week', timeZone);
  if (/\blast week\b/.test(t)) return span(addDays(today, -dow - 7), addDays(today, -dow), 'last week', timeZone);
  if (/\bthis month\b/.test(t)) return span(`${today.slice(0, 8)}01`, addDays(today, 1), 'this month', timeZone);
  if (/\blast month\b/.test(t)) {
    const d = new Date(`${today.slice(0, 8)}01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return span(d.toISOString().slice(0, 10), `${today.slice(0, 8)}01`, 'last month', timeZone);
  }
  if ((m = new RegExp(`\\b(last |on |this past )?(${WEEKDAYS.join('|')})\\b`).exec(t))) {
    const want = WEEKDAYS.indexOf(m[2]);
    let back = (dow - want + 7) % 7;
    if (back === 0) back = 7;
    const day = addDays(today, -back);
    return span(day, addDays(day, 1), `${m[1] ?? 'on '}${m[2]}`.replace(/\s+/g, ' ').trim(), timeZone);
  }
  if ((m = new RegExp(`\\b(in|back in|during|last) (${MONTHS.join('|')})\\b`).exec(t))) {
    const mi = MONTHS.indexOf(m[2]);
    const y = Number(today.slice(0, 4)) - (mi > Number(today.slice(5, 7)) - 1 ? 1 : 0);
    const from = `${y}-${String(mi + 1).padStart(2, '0')}-01`;
    const next = mi === 11 ? `${y + 1}-01-01` : `${y}-${String(mi + 2).padStart(2, '0')}-01`;
    return span(from, next, `in ${m[2][0].toUpperCase()}${m[2].slice(1)}`, timeZone);
  }
  return undefined;
}

/** The topic words of a message: without the "remember / yesterday" cue and time words. */
export function topicOf(text: string): string {
  return text
    .replace(new RegExp(PAST_CUE.source, 'gi'), ' ')
    .replace(new RegExp(`\\b(${[...WEEKDAYS, ...MONTHS].join('|')}|today|tonight|morning|afternoon|evening|night|week|weeks|month|months|day|days|time|times|last|ago|earlier|other|talk|talked|talking|said|told|tell|chat|chatted|conversation|thing|things|stuff)\\b`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words in an owner message that point at the shared past. */
export const PAST_CUE =
  /\b(remember|recall|forgot|forget|last time|the other day|yesterday|last night|last week|last month|earlier today|this morning|ago|before|we talked|we spoke|we discussed|you said|you told me|i told you|i said|i mentioned|did i (?:tell|mention)|we were (?:talking|saying)|what were we|we decided|we agreed|you promised|like i said|as i said|back when)\b/i;

export interface RecallHit {
  conversationId: string;
  title: string;
  /** Local date-time of the matching message. */
  when: string;
  /** Phase 51: set when it comes from imported history ("ChatGPT"): those replies weren't hers. */
  from?: string;
  lines: { role: 'you' | 'owner' | 'other'; text: string; id: number; name?: string }[];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function localStamp(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

/**
 * Searches past messages of this companion's conversations with the owner (never chats with
 * other people, never forgotten messages). Words are matched by stem (porter); results are ranked
 * by relevance, then recency. With only a time span, returns what was talked about then.
 */
export function recallMessages(
  store: Store,
  opts: { query?: string; span?: Span; exclude?: { conversationId: string; fromId: number }; limit?: number; timeZone?: string; appSafe?: boolean },
): RecallHit[] {
  const limit = opts.limit ?? 5;
  const q = opts.query ? ftsQuery(opts.query) : null;
  const where: string[] = ["m.role IN ('user','assistant')", 'c.partner IS NULL', `(m.meta IS NULL OR m.meta NOT LIKE '%"forgotten":true%')`];
  // Hardening M3: another app's turn: nothing from private, imported or adult-channel conversations.
  if (opts.appSafe) where.push(APP_SAFE_SQL);
  const args: (string | number)[] = [];
  if (opts.span) {
    where.push('m.created_at >= ? AND m.created_at < ?');
    args.push(opts.span.from, opts.span.to);
  }
  if (opts.exclude) {
    where.push('NOT (m.conversation_id = ? AND m.id >= ?)');
    args.push(opts.exclude.conversationId, opts.exclude.fromId);
  }
  type Row = { id: number; conversation_id: string; created_at: string; title: string; channel: string };
  let rows: Row[];
  if (q) {
    rows = store.db
      .prepare(`SELECT m.id, m.conversation_id, m.created_at, c.title, c.channel FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conversation_id WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(messages_fts), m.id DESC LIMIT ?`)
      .all(q, ...args, limit * 4) as Row[];
  } else if (opts.span) {
    // No words: the owner's messages from then, spread over the conversations of that time.
    rows = store.db
      .prepare(`SELECT m.id, m.conversation_id, m.created_at, c.title, c.channel FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND ${where.join(' AND ')} ORDER BY m.id LIMIT 400`)
      .all(...args) as Row[];
    const perConv = new Map<string, Row[]>();
    for (const r of rows) perConv.set(r.conversation_id, [...(perConv.get(r.conversation_id) ?? []), r]);
    rows = [...perConv.values()].flatMap((rs) => (rs.length <= 2 ? rs : [rs[0], rs[Math.floor(rs.length / 2)], rs.at(-1)!]));
  } else return [];
  // A hit must share enough of the meaningful words (one common word like "went" isn't a match).
  if (q) {
    const terms = (q.match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1)).filter((w) => !COMMON.has(w));
    const need = terms.length >= 3 ? 2 : 1;
    const content = store.db.prepare('SELECT content FROM messages WHERE id = ?');
    rows = rows.filter((r) => {
      const text = String((content.get(r.id) as { content: string }).content).toLowerCase();
      return terms.filter((w) => text.includes(w.length > 5 ? w.slice(0, w.length - 2) : w)).length >= need;
    });
  }
  const hits: RecallHit[] = [];
  const used = new Set<number>();
  const msg = store.db.prepare(`SELECT id, role, content, meta FROM messages WHERE conversation_id = ? AND id BETWEEN ? AND ? AND role IN ('user','assistant') AND (meta IS NULL OR meta NOT LIKE '%"forgotten":true%') ORDER BY id`);
  for (const r of rows) {
    if (used.has(r.id) || hits.length >= limit) continue;
    // One message either side, for context.
    const around = msg.all(r.conversation_id, r.id - 3, r.id + 3) as { id: number; role: string; content: string; meta: string | null }[];
    const i = around.findIndex((x) => x.id === r.id);
    const pick = around.slice(Math.max(0, i - 1), i + 2);
    for (const p of pick) used.add(p.id);
    const from = importedName(r.channel);
    hits.push({
      conversationId: r.conversation_id,
      title: r.title,
      when: localStamp(r.created_at, opts.timeZone),
      ...(from ? { from } : {}),
      // Phase 51: another assistant's replies in imported history are never "you".
      // Phase 66: another companion's line in a group chat is hers, with her name.
      lines: pick.map((p) => ({ role: p.role === 'user' ? 'owner' : (p.meta?.includes('"importedFrom"') && !p.meta.includes('"herPast"')) || p.meta?.includes('"groupFrom"') ? 'other' : 'you', text: clip(p.content, p.id === r.id ? 600 : 240), id: p.id, ...(p.meta?.includes('"groupFrom"') ? { name: groupFromName(p.meta) } : {}) })),
    });
  }
  return hits;
}

/** Hits as plain text for her (the owner's name, and "you" for her own words). */
export function formatHits(hits: RecallHit[], owner: string): string {
  return hits
    .map((h) => {
      const other = h.from ?? 'another assistant';
      const where = h.from ? `in ${owner}'s imported ${h.from} history ("${h.title}"; ${h.from} said these replies, not you)` : `in "${h.title}"`;
      const who = (l: RecallHit['lines'][number]) => (l.role === 'owner' ? (h.from ? `${owner} (to ${h.from})` : owner) : l.role === 'other' ? (l.name ? `${l.name} (another AI companion) said` : `${other} said`) : 'You');
      return `• ${h.when}, ${where}:\n${h.lines.map((l) => `  ${who(l)}: ${l.text}`).join('\n')}`;
    })
    .join('\n');
}

/** Summaries she wrote of conversations in a time span (what happened then, in short). */
export function summariesIn(mem: MemoryStore, span: Span, limit = 4, store?: Store, appSafe = false): string[] {
  // Phase 51: notes learned from imported history were written now about long ago: they count
  // for the day it happened, and say where they came from.
  const from = (m: { conversationId: string | null }) => (store && m.conversationId ? importedName(store.getConversation(m.conversationId)?.channel) : undefined);
  return mem
    .list({ kind: 'summary', limit: 200 })
    .filter((m) => {
      if (m.supersededBy !== null) return false;
      if (appSafe && (!store || (m.conversationId && !sharedWithApps(store.getConversation(m.conversationId))))) return false;
      if (from(m)) return m.happenedOn >= span.from.slice(0, 10) && m.happenedOn < span.to.slice(0, 10);
      return m.createdAt >= span.from && m.createdAt < new Date(Date.parse(span.to) + 2 * DAY).toISOString();
    })
    .slice(0, limit)
    .map((m) => `• (${m.happenedOn}${from(m) ? `, from your ${from(m)} history` : ''}) ${clip(m.content, 500)}`);
}

/**
 * "Last time": the most recent other conversation with the owner, for the start of a new one.
 * Her summary of it (if written) plus its last few messages that the summary doesn't cover yet,
 * so a session that ended a minute ago is remembered too.
 */
export function lastTimeNote(app: AppContext, currentId: string, owner: string, maxDays = 21, appSafe = false): string | undefined {
  const store = app.store;
  // Hardening M3: for another app's turn, the last conversation it may know about.
  const row = store.db
    .prepare(
      `SELECT c.id, c.title, MAX(m.created_at) AS last FROM conversations c JOIN messages m ON m.conversation_id = c.id
       WHERE c.id != ? AND c.partner IS NULL AND m.role = 'user' AND ${NOT_IMPORTED}${appSafe ? ` AND ${APP_SAFE_SQL}` : ''} GROUP BY c.id ORDER BY last DESC LIMIT 1`,
    )
    .get(currentId) as { id: string; title: string; last: string } | undefined;
  if (!row || app.now().getTime() - Date.parse(row.last) > maxDays * DAY) return undefined;
  const tz = app.settings.get().timeZone;
  const summary = app.memory?.list({ kind: 'summary', limit: 50 }).find((m) => m.conversationId === row.id && m.supersededBy === null);
  const through = app.memory?.state(row.id).summarizedThrough ?? 0;
  const tail = (store.db
    .prepare(`SELECT id, role, content, meta FROM messages m WHERE conversation_id = ? AND id > ? AND role IN ('user','assistant') AND (meta IS NULL OR meta NOT LIKE '%"forgotten":true%') AND ${NOT_IMPORTED} ORDER BY id DESC LIMIT 8`)
    .all(row.id, through) as { id: number; role: string; content: string; meta: string | null }[]).reverse();
  if (!summary && !tail.length) return undefined;
  const parts = [`Your last conversation with ${owner} was "${row.title}" (${localStamp(row.last, tz)}).`];
  if (summary) parts.push(`What happened: ${clip(summary.content, 700)}`);
  if (tail.length) parts.push(`${summary ? 'How it ended' : 'How it went'}:\n${tail.map((m) => `  ${m.role === 'user' ? owner : m.meta?.includes('"groupFrom"') ? `${groupFromName(m.meta)} (another AI companion)` : 'You'}: ${clip(m.content, 300)}`).join('\n')}`);
  return parts.join('\n');
}

/**
 * Found automatically for this turn: when the owner refers to the past, the best passages from
 * earlier conversations (and her summaries from the time they name).
 */
export function autoRecall(app: AppContext, text: string, exclude: { conversationId: string; fromId: number }, owner: string, appSafe = false): string | undefined {
  if (!PAST_CUE.test(text)) return undefined;
  const tz = app.settings.get().timeZone;
  const span = parseWhen(text, app.now(), tz);
  const topic = topicOf(text);
  if (!ftsQuery(topic) && !span) return undefined;
  const hits = recallMessages(app.store, { query: topic, ...(span ? { span } : {}), exclude, limit: 4, timeZone: tz, appSafe });
  // Nothing in that time window with those words: try the words alone (dates are often off).
  const more = !hits.length && span && ftsQuery(topic) ? recallMessages(app.store, { query: topic, exclude, limit: 3, timeZone: tz, appSafe }) : [];
  const sums = span && app.memory ? summariesIn(app.memory, span, 3, app.store, appSafe) : [];
  const out: string[] = [];
  if (sums.length) out.push(`Your notes from ${span!.label}:\n${sums.join('\n')}`);
  if (hits.length || more.length) out.push(`From your past conversations (this is what really was said; rely on it over vague impressions):\n${formatHits(hits.length ? hits : more, owner)}`);
  // Looked and found nothing: say so, so she neither denies it nor pretends to remember details.
  if (!out.length && ftsQuery(topic)) out.push(`You looked through your past conversations for this and found nothing about it. It may have happened somewhere you can't see, so don't deny it. But you don't remember it, so don't add a single detail of your own (where, when, who was there, what you did, said or felt, how it went), not even as a joke: say honestly it isn't coming back to you and ask ${owner} to tell you about it.`);
  return out.length ? out.join('\n') : undefined;
}

/** The recall tool: she looks things up herself. */
export function createRecallTool(app: () => AppContext): Tool {
  return {
    spec: {
      name: 'recall',
      description:
        "Look through your past conversations with the owner (their real messages and yours). Use it whenever the owner refers to something from before that isn't in this conversation or your notes, BEFORE saying you don't remember. Search by words (names, places, topics) and/or a time like 'yesterday', 'last Tuesday', 'two weeks ago', 'in March' or a date.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Words to look for, e.g. 'lake trip Jenna' or 'job interview'." },
          when: { type: 'string', description: "Optional time, e.g. 'yesterday', 'last week', '3 days ago', 'in June', '2026-10-01'." },
        },
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `Looking back${a.query ? ` for “${String(a.query).slice(0, 60)}”` : ''}${a.when ? ` (${String(a.when).slice(0, 30)})` : ''}`,
    async run(args, ctx) {
      const a = app();
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const whenText = typeof args.when === 'string' ? args.when.trim() : '';
      if (!query && !whenText) throw new ToolError('Give words to look for, a time, or both.');
      const tz = a.settings.get().timeZone;
      const span = whenText ? parseWhen(whenText, a.now(), tz) : undefined;
      if (whenText && !span && !query) throw new ToolError(`I couldn't understand the time "${whenText}". Try "yesterday", "last week", "3 days ago", "in March" or a date like 2026-10-01.`);
      const owner = a.settings.get().ownerName?.trim() || 'the owner';
      const exclude = ctx.conversationId ? { conversationId: ctx.conversationId, fromId: 0 } : undefined;
      let hits = recallMessages(a.store, { query, ...(span ? { span } : {}), ...(exclude ? { exclude } : {}), limit: 6, timeZone: tz });
      let note = '';
      if (!hits.length && span && query) {
        hits = recallMessages(a.store, { query, ...(exclude ? { exclude } : {}), limit: 4, timeZone: tz });
        if (hits.length) note = `Nothing with those words ${span.label}; these are from other times:\n`;
      }
      const sums = span && a.memory ? summariesIn(a.memory, span, 4, a.store) : [];
      const out: string[] = [];
      if (sums.length) out.push(`Your notes from ${span!.label}:\n${sums.join('\n')}`);
      if (hits.length) out.push(`${note}${formatHits(hits, owner)}`);
      // Phase 38: your notes close in meaning (when the embeddings job is set), for other wording.
      const near = query && a.vectors ? await a.vectors.related(query, 5).catch(() => []) : [];
      if (near.length) out.push(`Your notes that are close in meaning:\n${near.map((r) => `- (${r.memory.happenedOn}) ${r.memory.content}`).join('\n')}`);
      if (!out.length) return `Nothing found${query ? ` for “${query}”` : ''}${span ? ` ${span.label}` : ''} in your past conversations. It may have been said somewhere you can't see (a call before transcripts, another app), or put differently: try other words. If ${owner} says it happened, believe them and ask about it.`;
      return out.join('\n\n');
    },
  };
}

/**
 * Phase 31/32: with "share what they know about you" on, facts about the owner (and dates) that
 * the other companions learned come to mind too. Only facts about the owner: never their
 * conversations, summaries or what they said about themselves.
 */
export function sharedOwnerFacts(app: AppContext, text: string, appSafe = false): string[] {
  if (app.settings.get().memorySharing !== 'shared' || !app.companions) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of app.companions.all()) {
    if (c.app === app || !c.app.memory) continue;
    const mine = [...c.app.memory.list({ kind: 'fact', q: text, limit: 4 }), ...c.app.memory.list({ kind: 'fact', limit: 3 })];
    for (const m of mine) {
      const key = m.content.toLowerCase();
      if (m.supersededBy !== null || seen.has(key) || out.length >= 6) continue;
      if (appSafe && m.conversationId && !sharedWithApps(c.app.store.getConversation(m.conversationId))) continue;
      seen.add(key);
      out.push(`- (${m.happenedOn}) ${m.content.replace(/\s+/g, ' ').trim()}`);
    }
  }
  return out;
}
