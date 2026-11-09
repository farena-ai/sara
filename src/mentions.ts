// Phase 119 part A (docs/design/RECALL.md §4): "when it comes up" reminders.
//
// A third kind of planner reminder next to time and place reminders: `trigger = 'mention'` on the
// same `reminders` row (with the place reminders' far-future due, so the 15-second scheduler never
// sees it). It waits for a person (a People card, its aliases count) or a topic (every word of one
// entry) to come up in HIS OWN message in HIS OWN chat, and then rides in the reply she was writing
// anyway: a note before her first model call, one line from the app if her reply leaves it out, and
// a ⏰ chip with Done / Again next time / Forget. Matching is code only: no model call, no
// embeddings, no network (R1–R4 of the design).
import type { AppContext } from './chat.ts';
import { queryWords, stem } from './memory-rank.ts';
import { dayStartUtc, PLACE_DUE, type PlannerStore, type Reminder } from './planner.ts';
import { localDate } from './memory-worker.ts';
import type { Person } from './people.ts';
import { isWorkChannel } from './safety.ts';
import { inWorkSpace } from './work-profile.ts';
import { sharedWithApps } from './recall.ts';
import type { Conversation } from './store.ts';
import { appLanguage, en, tr } from './i18n.ts';
import { identityOf } from './persona.ts';

// ---------------------------------------------------------------- settings (§3.3)

export interface MentionSettings {
  on: boolean;
  confirm: 'undo' | 'ask';
  perReply: number;
  perDay: number;
  /** 0 = never. */
  expiresDays: number;
  each: { gapHours: number; fires: number };
  calls: boolean;
  rooms: 'off' | 'dm';
}
export const MENTION_DEFAULTS: MentionSettings = { on: true, confirm: 'undo', perReply: 1, perDay: 5, expiresDays: 180, each: { gapHours: 24, fires: 3 }, calls: true, rooms: 'off' };
export const MENTION_CHOICES = { perReply: [1, 2, 3], perDay: [3, 5, 10], expiresDays: [30, 90, 180, 365, 0], gapHours: [4, 12, 24, 72], fires: [2, 3, 5, 10] } as const;
/** Armed mention reminders per companion (the 201st is refused). */
export const MAX_ARMED = 200;
const MAX_ALSO = 5;
const MAX_TERMS = 6;
const SAME_SESSION_MS = 30 * 60_000;

const pick = <T>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
export function mentionSettings(app: AppContext): MentionSettings {
  const m = ((app.settings.get() as { mentions?: Partial<MentionSettings> }).mentions ?? {}) as Partial<MentionSettings>;
  const d = MENTION_DEFAULTS;
  return {
    on: m.on !== false,
    confirm: m.confirm === 'ask' ? 'ask' : 'undo',
    perReply: pick(Number(m.perReply), MENTION_CHOICES.perReply, d.perReply),
    perDay: pick(Number(m.perDay), MENTION_CHOICES.perDay, d.perDay),
    expiresDays: pick(Number(m.expiresDays ?? d.expiresDays), MENTION_CHOICES.expiresDays, d.expiresDays),
    each: { gapHours: pick(Number(m.each?.gapHours), MENTION_CHOICES.gapHours, d.each.gapHours), fires: pick(Number(m.each?.fires), MENTION_CHOICES.fires, d.each.fires) },
    calls: m.calls !== false,
    rooms: m.rooms === 'dm' ? 'dm' : 'off',
  };
}
/** PUT /api/mentions: only known keys and values are kept. */
export function mergeMentionSettings(app: AppContext, body: Record<string, unknown>): MentionSettings {
  const cur = mentionSettings(app);
  const each = (body.each ?? {}) as Record<string, unknown>;
  const next: MentionSettings = {
    on: body.on === undefined ? cur.on : body.on === true,
    confirm: body.confirm === undefined ? cur.confirm : body.confirm === 'ask' ? 'ask' : 'undo',
    perReply: pick(Number(body.perReply ?? cur.perReply), MENTION_CHOICES.perReply, cur.perReply),
    perDay: pick(Number(body.perDay ?? cur.perDay), MENTION_CHOICES.perDay, cur.perDay),
    expiresDays: pick(Number(body.expiresDays ?? cur.expiresDays), MENTION_CHOICES.expiresDays, cur.expiresDays),
    each: { gapHours: pick(Number(each.gapHours ?? cur.each.gapHours), MENTION_CHOICES.gapHours, cur.each.gapHours), fires: pick(Number(each.fires ?? cur.each.fires), MENTION_CHOICES.fires, cur.each.fires) },
    calls: body.calls === undefined ? cur.calls : body.calls === true,
    rooms: body.rooms === undefined ? cur.rooms : body.rooms === 'dm' ? 'dm' : 'off',
  };
  app.settings.update({ mentions: next } as never);
  return next;
}

// ---------------------------------------------------------------- R3 · his own chat

/** Channels that can be his own chat (web, his DMs on linked bridges, plugin bridges' owner chats). */
export const OWN_CHANNEL = /^(web|telegram|telegram-nsfw|discord|discord-nsfw|plugin-[\w-]+)$/;
/**
 * R3: the one predicate both parts use. Not partner, private, archived, imported, a work room,
 * another app, a group or a speaker; off the record never counts (offApp carries `offRecord`).
 */
export function ownChat(app: AppContext, c: Conversation | undefined): boolean {
  if (!c || c.partner || c.private || c.archivedAt || app.offRecord) return false;
  if (isWorkChannel(c.channel) || !OWN_CHANNEL.test(c.channel)) return false;
  // EC26: a chat in the work space is not his own chat (no pickups, reminders or follow-ups there).
  if (inWorkSpace(app, c)) return false;
  // sharedWithApps also leaves out imports (adult channels are judged by the caller).
  return sharedWithApps({ ...c, channel: c.channel.replace(/-nsfw$/, '') });
}

// ---------------------------------------------------------------- R1 · keys

export type Term = { kind: 'person'; id: number } | { kind: 'word'; stem: string; name?: string } | { kind: 'phrase'; stems: string[]; text: string };
export interface MentionKeys {
  /** He said it about this person (cards; their aliases count). */
  personIds: number[];
  /** Alternatives; every term of one entry has to be in his message. */
  entries: Term[][];
  /** His words for it, as he said them (shown on the card). */
  topic: string;
  also: string[];
}
export interface MentionData extends MentionKeys {
  /** The message that set it (never fires it) and where. */
  messageId?: number;
  companion?: string;
  /** Per reminder: 'every time' gap and fires (lowered on its card, never past the setting). */
  gapHours?: number;
  fires?: number;
}

export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const TOKEN = /[\p{L}\p{N}$€£][\p{L}\p{N}'’.,$€£-]*/gu;
/** Folded words of a text, as stems (numbers and amounts kept exactly). */
export function stemsOf(text: string): string[] {
  return (fold(text).match(TOKEN) ?? []).map((w) => {
    const x = w.replace(/[.,]+$/, '').replace(/['’]s$/, '');
    return /\d/.test(x) ? x : stem(x.replace(/['’"-]/g, ''));
  });
}
/** Words that come up nearly every day (a single-word topic made of one of these is refused). */
const COMMON = new Set(['work', 'job', 'today', 'tomorrow', 'yesterday', 'it', 'thing', 'things', 'stuff', 'money', 'time', 'day', 'week', 'home', 'food', 'tired', 'good', 'bad', 'ok', 'okay', 'yes', 'no', 'lol', 'thanks', 'morning', 'night', 'sleep', 'people', 'life', 'love', 'fun', 'busy', 'help', 'need', 'want', 'feel', 'going', 'make', 'get', 'got', 'now', 'later', 'soon', 'call', 'text', 'message', 'chat', 'talk', 'say', 'said', 'see', 'look', 'nice', 'great', 'cool', 'sure', 'right', 'well', 'still', 'even', 'back', 'new', 'old', 'year', 'month', 'lunch', 'dinner', 'coffee', 'weekend']);
const COMMON_STEMS = new Set([...COMMON].map((w) => stem(w)));

const people = (app: AppContext) => app.people;
/** Active cards whose name, full name or an alias is exactly `name` (folded). */
function cardsNamed(app: AppContext, name: string): Person[] {
  const f = fold(name.trim());
  if (!f) return [];
  return (people(app)?.all() ?? []).filter((p) => p.status === 'active' && [p.name, p.fullName ?? '', ...p.aliases].some((l) => fold(l) === f || fold(l).split(/\s+/)[0] === f));
}
const label = (p: Person) => `${p.name}${p.relation ? ` (${p.relation.replace(/^my /, 'your ')})` : ''}`;

export type KeyError = { reason: 'too-common' | 'which-person' | 'no-words' | 'too-many'; message: string; labels?: string[] };

/** R1: his words → keys (or why not). `personName`: "when Dan comes up" (a card, or a word key for now). */
export function keysFor(app: AppContext, o: { topic?: string; person?: string; personId?: number; also?: string[] }): MentionKeys | KeyError {
  const personIds: number[] = [];
  const main: Term[] = [];
  const ppl = people(app);
  if (o.personId !== undefined) {
    const p = ppl?.get(o.personId);
    if (!p || p.status !== 'active') return { reason: 'which-person', message: 'That person card is not there any more.' };
    personIds.push(p.id);
    main.push({ kind: 'person', id: p.id });
  } else if (o.person?.trim()) {
    const cards = cardsNamed(app, o.person.replace(/^(?:my|the)\s+\p{L}+\s+/iu, '').replace(/\s+(?:from|at)\s+.*$/i, ''));
    // A qualifier in his words ("Dan from work", "my friend Dan") lets People decide; else both are named.
    const q = cards.length > 1 && ppl ? ppl.find(o.person).found.filter((p) => cards.some((c) => c.id === p.id)) : [];
    const found = cards.length > 1 ? (q.length === 1 ? q : cards) : cards;
    if (found.length > 1) return { reason: 'which-person', message: `Which one: ${found.map(label).join(' or ')}?`, labels: found.map(label) };
    if (found.length === 1) {
      personIds.push(found[0].id);
      main.push({ kind: 'person', id: found[0].id });
    } else {
      for (const w of queryWords(o.person).slice(0, MAX_TERMS)) main.push({ kind: 'word', stem: stem(w), name: w });
    }
  }
  const topic = (o.topic ?? '').trim();
  if (topic) {
    const hit = ppl ? ppl.find(topic) : { found: [] as Person[], ambiguous: [] as { label: string; people: Person[] }[] };
    if (hit.ambiguous.some((a) => a.people.filter((p) => p.status === 'active').length > 1)) {
      const a = hit.ambiguous.find((x) => x.people.filter((p) => p.status === 'active').length > 1)!;
      const ls = a.people.filter((p) => p.status === 'active').map(label);
      return { reason: 'which-person', message: `Which one: ${ls.join(' or ')}?`, labels: ls };
    }
    const named = new Set<string>();
    for (const p of hit.found.filter((x) => x.status === 'active')) {
      if (!personIds.includes(p.id)) {
        personIds.push(p.id);
        main.push({ kind: 'person', id: p.id });
      }
      for (const l of [p.name, p.fullName ?? '', ...p.aliases]) for (const w of fold(l).split(/\s+/)) if (w) named.add(stem(w));
    }
    for (const w of queryWords(fold(topic))) {
      const s = /\d/.test(w) ? w : stem(w);
      if (named.has(s) || main.some((t) => t.kind === 'word' && t.stem === s)) continue;
      main.push({ kind: 'word', stem: s });
    }
  }
  const entries: Term[][] = [];
  if (main.length) entries.push(main.slice(0, MAX_TERMS + personIds.length));
  const also = (o.also ?? []).map((a) => String(a).trim()).filter(Boolean).slice(0, MAX_ALSO);
  for (const a of also) {
    const stems = stemsOf(a).slice(0, MAX_TERMS);
    if (!stems.length) continue;
    entries.push(stems.length === 1 ? [{ kind: 'word', stem: stems[0] }] : [{ kind: 'phrase', stems, text: a.slice(0, 80) }]);
  }
  if (!entries.length) return { reason: 'no-words', message: 'Say who or what to listen for (a person, or a few words).' };
  return { personIds, entries, topic: topic || o.person?.trim() || (personIds[0] ? (ppl?.get(personIds[0])?.name ?? '') : ''), also };
}

/** How many of his last 200 messages hold this stem (code: an FTS count, then a word check). */
function ownCount(app: AppContext, s: string): number {
  const rows = app.store.db.prepare("SELECT content FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 200").all() as { content: string }[];
  let n = 0;
  for (const r of rows) if (stemsOf(r.content).includes(s)) n++;
  return n;
}
/** R1: an entry that would go off nearly every day (a built-in common word, or > 20 of his last 200 messages). */
export function tooCommon(app: AppContext, keys: MentionKeys): KeyError | undefined {
  for (const e of keys.entries) {
    if (e.some((t) => t.kind === 'person')) continue;
    if (e.length === 1 && e[0].kind === 'word' && (COMMON_STEMS.has(e[0].stem) || e[0].stem.length < 3)) return { reason: 'too-common', message: "That comes up nearly every day, so it would go off all the time. Something more specific? (e.g. 'the Henderson project')" };
    const words = e.filter((t): t is Extract<Term, { kind: 'word' }> => t.kind === 'word');
    if (words.length === e.length && words.length && words.every((t) => ownCount(app, t.stem) > 20)) return { reason: 'too-common', message: "That comes up nearly every day, so it would go off all the time. Something more specific? (e.g. 'the Henderson project')" };
  }
  return undefined;
}

// ---------------------------------------------------------------- R2 · the matcher

const termHit = (t: Term, stems: string[], found: Set<number>): boolean => {
  if (t.kind === 'person') return found.has(t.id);
  if (t.kind === 'word') return stems.includes(t.stem);
  // A phrase: its words in order, with at most one other word between two of them.
  for (let i = 0; i < stems.length; i++) {
    if (stems[i] !== t.stems[0]) continue;
    let at = i;
    let ok = true;
    for (const w of t.stems.slice(1)) {
      if (stems[at + 1] === w) at += 1;
      else if (stems[at + 2] === w) at += 2;
      else {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
};

export interface MentionHit {
  reminder: Reminder;
  data: MentionData;
  /** 'person:12' | 'words:release' (never his text). */
  why: string;
  /** Words for the note and the chip: "Dan" / "the release". */
  what: string;
}

/** The mention data of a row (undefined for time and place reminders). */
export function mentionOf(r: Reminder): MentionData | undefined {
  if (r.trigger !== 'mention' || !r.mention) return undefined;
  try {
    return JSON.parse(r.mention) as MentionData;
  } catch {
    return undefined;
  }
}

/** Follows merged cards to the card they live on now (undefined: forgotten or gone). */
function liveCard(app: AppContext, id: number): number | undefined {
  const db = people(app)?.db;
  if (!db) return id;
  for (let i = 0, cur = id; i < 5; i++) {
    const r = db.prepare('SELECT status, merged_into FROM people WHERE id = ?').get(cur) as { status: string; merged_into: number | null } | undefined;
    if (!r || r.status === 'rejected') return undefined;
    if (r.status !== 'merged') return cur;
    if (!r.merged_into) return undefined;
    cur = Number(r.merged_into);
  }
  return undefined;
}

/** Keeps a row's keys current with its cards: merged cards followed, forgotten ones end it, name words upgraded. */
function refreshKeys(app: AppContext, pl: PlannerStore, r: Reminder, d: MentionData): MentionData | undefined {
  let changed = false;
  for (const e of d.entries) {
    for (let i = 0; i < e.length; i++) {
      const t = e[i];
      if (t.kind === 'person') {
        const now = liveCard(app, t.id);
        if (now === undefined) {
          pl.endMention(r.id, 'forgot');
          return undefined;
        }
        if (now !== t.id) {
          e[i] = { kind: 'person', id: now };
          changed = true;
        }
      } else if (t.kind === 'word' && t.name) {
        // A word key for a name that is now one active card becomes a person key (its aliases count).
        const cards = cardsNamed(app, t.name);
        if (cards.length === 1) {
          e[i] = { kind: 'person', id: cards[0].id };
          changed = true;
        }
      }
    }
  }
  if (changed) {
    d.personIds = [...new Set(d.entries.flat().filter((t): t is Extract<Term, { kind: 'person' }> => t.kind === 'person').map((t) => t.id))];
    pl.updateMention(r.id, { mention: JSON.stringify(d) });
  }
  return d;
}

const whatOf = (app: AppContext, d: MentionData): string => {
  const p = d.personIds[0] !== undefined ? people(app)?.get(d.personIds[0]) : undefined;
  return d.topic || p?.name || d.also[0] || '';
};
const whyOf = (app: AppContext, e: Term[]): string => {
  const p = e.find((t) => t.kind === 'person');
  if (p && p.kind === 'person') return `person:${p.id}`;
  const w = e.map((t) => (t.kind === 'word' ? t.stem : t.kind === 'phrase' ? t.stems.join(' ') : '')).filter(Boolean);
  return `words:${w.join(' ')}`.slice(0, 120);
};

export interface MatchInput {
  conversation: Conversation;
  messageId: number;
  text: string;
  /** People's `found` for his message (no-guess already applied). */
  found: Person[];
}

/**
 * R2: which armed reminders his message sets off, oldest set first, within the per-reply and
 * per-day caps. Expired ones end on the way. Code only: < 1 ms for a few hundred rows.
 */
export function matchMentions(app: AppContext, m: MatchInput, now: Date): MentionHit[] {
  const pl = app.planner;
  if (!pl) return [];
  const st = mentionSettings(app);
  if (!st.on) return [];
  pl.expireMentions(now);
  const rows = pl.armedMentions(now);
  if (!rows.length) return [];
  const stems = stemsOf(m.text);
  const found = new Set(m.found.map((p) => p.id));
  const me = app.companionId ?? 'main';
  const left = st.perDay - pl.firesSince(dayStartUtc(localDate(now.toISOString(), app.settings.get().timeZone), app.settings.get().timeZone).toISOString());
  const hits: MentionHit[] = [];
  for (const r of rows) {
    if (hits.length >= Math.min(st.perReply, Math.max(0, left))) break;
    const d0 = mentionOf(r);
    if (!d0) continue;
    // Q8: with a shared planner, only the companion it was set with raises it.
    if (d0.companion && d0.companion !== me) continue;
    if (r.conversationId && !d0.companion && !app.store.getConversation(r.conversationId)) continue;
    // Not the message that set it, and not again in that session for 30 minutes ("next time").
    if (r.conversationId === m.conversation.id && ((d0.messageId ?? 0) >= m.messageId || now.getTime() - Date.parse(r.createdAt) < SAME_SESSION_MS)) continue;
    const d = refreshKeys(app, pl, r, d0);
    if (!d) continue;
    const entry = d.entries.find((e) => e.length && e.every((t) => termHit(t, stems, found)));
    if (!entry) continue;
    hits.push({ reminder: r, data: d, why: whyOf(app, entry), what: whatOf(app, d) });
  }
  return hits;
}

// ---------------------------------------------------------------- the note (§4.5)

const whenSet = (r: Reminder, tz?: string) => localDate(r.createdAt, tz);
const placeOf = (app: AppContext, r: Reminder): string => {
  const c = r.conversationId ? app.store.getConversation(r.conversationId) : undefined;
  if (!c) return 'the app';
  return c.channel.startsWith('telegram') ? 'Telegram' : c.channel.startsWith('discord') ? 'Discord' : c.channel.startsWith('plugin-') ? c.channel.slice(7) : 'the app';
};
const peopleLabel = (app: AppContext, why: string): string => {
  const id = /^person:(\d+)$/.exec(why)?.[1];
  const p = id ? people(app)?.get(Number(id)) : undefined;
  return p ? `${label(p)} named in this message` : `the words "${why.replace(/^words:/, '')}" in this message`;
};

/** The section for her instructions (persona `ctx.mentions`). Spoken turns get no bracket. */
export function mentionNote(app: AppContext, hits: MentionHit[], text: string, o: { owner: string; spoken?: boolean }): string {
  const tz = app.settings.get().timeZone;
  const quote = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return hits
    .map((h) => {
      const lines = [
        `On ${whenSet(h.reminder, tz)}, in ${placeOf(app, h.reminder)}, ${o.owner} asked you: when ${h.what} comes up, remind them: "${h.reminder.text}".`,
        `${h.what} came up just now ("${quote}"). After you answer what they said, bring it up once, briefly, in your own words. It is for ${o.owner} only: never put it in anything sent to anyone else.`,
      ];
      if (!o.spoken) lines.push(`[why: ${peopleLabel(app, h.why)}; sure: high]`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------- R4 · raised, in code

const AMOUNT = /[$€£]?\d[\d.,]*%?/g;
/** R4: her reply carries the reminder's own distinctive words (an amount or number, or half its other words, at least two). */
export function raised(reply: string, text: string): boolean {
  const amounts = (text.match(AMOUNT) ?? []).map((a) => a.replace(/[.,]+$/, ''));
  const r = fold(reply);
  if (amounts.length) return amounts.some((a) => r.includes(fold(a)));
  const words = queryWords(fold(text)).map((w) => stem(w));
  if (!words.length) return false;
  const have = new Set(stemsOf(reply));
  const n = words.filter((w) => have.has(w)).length;
  return words.length === 1 ? n === 1 : n >= Math.max(2, Math.ceil(words.length / 2));
}

/** The app's own line when her reply leaves it out (in the owner's language). */
export function appLine(app: AppContext, text: string): string {
  return tr(en('⏰ You asked me to remind you: {text}.'), appLanguage(app.settings.get()), { text: text.replace(/[.!?]+$/, '') }, identityOf(app.persona));
}

export interface ChipItem {
  fireId: number;
  reminderId: number;
  text: string;
  what: string;
  each: boolean;
  n: number;
  of: number;
  raised: 'her' | 'app';
  answer?: string | null;
}

/**
 * After her reply is saved (final step): R4, then the fire rows, the reminder's next state and
 * `meta.mentions` on the reply. Returns the new reply text when the app added its line.
 */
export function afterReply(app: AppContext, hits: MentionHit[], c: { conversationId: string; messageId: number; replyId: number; reply: string; now: Date }): { text?: string; chips: ChipItem[] } {
  const pl = app.planner;
  if (!pl || !hits.length) return { chips: [] };
  let text = c.reply;
  const chips: ChipItem[] = [];
  const st = mentionSettings(app);
  for (const h of hits) {
    const her = raised(text, h.reminder.text);
    if (!her) text = `${text.trimEnd()}\n\n${appLine(app, h.reminder.text)}`;
    const fireId = pl.addFire({ reminderId: h.reminder.id, conversationId: c.conversationId, messageId: c.messageId, replyId: c.replyId, why: h.why, raised: her ? 'her' : 'app', at: c.now.toISOString() });
    const of = Math.min(st.each.fires, h.data.fires ?? st.each.fires);
    const gap = Math.min(st.each.gapHours * 4, h.data.gapHours ?? st.each.gapHours);
    const n = h.reminder.fired + 1;
    pl.markMentionRaised(h.reminder.id, h.reminder.each && n < of ? new Date(c.now.getTime() + gap * 3_600_000) : null, c.now);
    chips.push({ fireId, reminderId: h.reminder.id, text: h.reminder.text, what: h.what, each: h.reminder.each, n, of: h.reminder.each ? of : 1, raised: her ? 'her' : 'app' });
  }
  app.store.updateMessageMeta(c.replyId, { mentions: chips });
  if (text !== c.reply) app.store.updateMessageContent(c.replyId, text);
  app.events?.publish({ type: 'planner', what: 'reminders' });
  return { ...(text !== c.reply ? { text } : {}), chips };
}

/** The chip's and the chat apps' buttons: done (nothing changes), again (armed now), forget (cancelled). */
export function answerFire(app: AppContext, fireId: number, answer: 'done' | 'again' | 'forget'): { ok: boolean; reminder?: Reminder } {
  const pl = app.planner;
  const f = pl?.fire(fireId);
  if (!pl || !f) return { ok: false };
  pl.setFireAnswer(fireId, answer);
  if (answer === 'again') pl.rearmMention(f.reminderId, app.now());
  if (answer === 'forget') pl.endMention(f.reminderId, 'forgot');
  // The reply's chip remembers the answer after a reload.
  if (f.replyId) {
    const msg = app.store.messageById(f.replyId);
    const list = Array.isArray(msg?.meta?.mentions) ? (msg!.meta!.mentions as ChipItem[]) : [];
    if (list.length) app.store.updateMessageMeta(f.replyId, { mentions: list.map((x) => (x.fireId === fireId ? { ...x, answer } : x)) });
  }
  app.events?.publish({ type: 'planner', what: 'reminders' });
  return { ok: true, reminder: pl.reminder(f.reminderId) };
}

// ---------------------------------------------------------------- outgoing tools (§4.4 path 3)

/** Tools that send something to someone else (email, bridge messages, invites, other agents). */
export const SENDING_TOOL = /(^|_)(send|email|mail|gmail|message|post|invite|share|forward|reply|a2a|calendar|event)(_|$)|^a2a_|^gmail_|^email_/i;
const NOT_SENDING = new Set(['send_file', 'remind', 'todo', 'note', 'recall', 'memory', 'calendar_list', 'gmail_search', 'gmail_read', 'mail_search', 'mail_read', 'mail_accounts', 'mail_folders']);
/** In a turn where a reminder fired: the reminder an outgoing call's text holds (the call then asks). */
export function outgoingHolds(hits: MentionHit[], name: string, args: unknown): MentionHit | undefined {
  if (!hits.length || NOT_SENDING.has(name) || !SENDING_TOOL.test(name)) return undefined;
  const body = JSON.stringify(args ?? {});
  return hits.find((h) => raised(body, h.reminder.text));
}

/** Her outside gate learns the reminders' texts (A2A's "quotes private material" check). */
export function mentionTexts(pl: PlannerStore | undefined): string[] {
  return pl ? pl.mentionReminders({ armedOnly: false }).filter((r) => r.status === 'pending').map((r) => r.text) : [];
}
export function wirePeople(app: AppContext): void {
  const p = people(app);
  if (p && !p.extraPrivate) p.extraPrivate = () => mentionTexts(app.planner);
}

// ---------------------------------------------------------------- setting one (§4.2)

export interface ReminderCard {
  id: number;
  kind: 'mention';
  what: string;
  personId?: number;
  text: string;
  each: boolean;
  until: string | null;
  armed: boolean;
}
/** Cards set in a turn, put on her final reply (`meta.reminderCard`) by the turn. */
const cards = new Map<string, ReminderCard[]>();
export function takeCards(conversationId: string): ReminderCard[] {
  const c = cards.get(conversationId) ?? [];
  cards.delete(conversationId);
  return c;
}
export function cardOf(app: AppContext, r: Reminder): ReminderCard | undefined {
  const d = mentionOf(r);
  if (!d) return undefined;
  return { id: r.id, kind: 'mention', what: whatOf(app, d), ...(d.personIds[0] !== undefined ? { personId: d.personIds[0] } : {}), text: r.text, each: r.each, until: r.expiresAt, armed: Boolean(r.armedAt) };
}

export type SetResult = { ok: true; reminder: Reminder; card: ReminderCard; line: string } | ({ ok: false } & KeyError) | { ok: false; reason: 'not-here' | 'off'; message: string };

/** Sets one from her tool, /when or Planner. `conversationId`: where he said it (null: Planner). */
export function setMention(app: AppContext, o: { text: string; topic?: string; person?: string; personId?: number; also?: string[]; each?: boolean; expiresDays?: number; conversationId?: string | null }): SetResult {
  const pl = app.planner;
  if (!pl) return { ok: false, reason: 'off', message: 'The planner is not available here.' };
  const st = mentionSettings(app);
  if (!st.on) return { ok: false, reason: 'off', message: 'When-it-comes-up reminders are off (Settings → Memory → When it comes up).' };
  const conv = o.conversationId ? app.store.getConversation(o.conversationId) : undefined;
  if (o.conversationId && !ownChat(app, conv)) {
    const work = conv && isWorkChannel(conv.channel);
    return { ok: false, reason: 'not-here', message: work ? 'Say it to me in our own chat: I keep those for our own chats.' : 'I keep those for our own chats.' };
  }
  const text = o.text.trim();
  if (!text || text.length > 500) return { ok: false, reason: 'no-words', message: 'Say what to remind about (up to 500 characters).' };
  if (pl.countArmed() >= MAX_ARMED) return { ok: false, reason: 'too-many', message: `You already have ${MAX_ARMED} of these waiting. Forget a few in Planner → Reminders → When it comes up first.` };
  const k = keysFor(app, o);
  if ('reason' in k) return { ok: false, ...k };
  const common = tooCommon(app, k);
  if (common) return { ok: false, ...common };
  const now = app.now();
  const days = o.expiresDays !== undefined && MENTION_CHOICES.expiresDays.includes(o.expiresDays as never) && (st.expiresDays === 0 || (o.expiresDays !== 0 && o.expiresDays <= st.expiresDays)) ? o.expiresDays : st.expiresDays;
  const lastUser = conv ? app.store.messagesPage(conv.id, { limit: 30 }).messages.filter((m) => m.role === 'user').at(-1) : undefined;
  const data: MentionData = { ...k, ...(lastUser ? { messageId: lastUser.id } : {}), companion: app.companionId ?? 'main' };
  const r = pl.addMention({ text, mention: JSON.stringify(data), conversationId: conv?.id ?? null, each: o.each === true, expiresAt: days ? new Date(now.getTime() + days * 86_400_000).toISOString() : null, armed: st.confirm !== 'ask' });
  const card = cardOf(app, r)!;
  if (conv) cards.set(conv.id, [...(cards.get(conv.id) ?? []), card]);
  app.events?.publish({ type: 'planner', what: 'reminders' });
  const p = card.personId !== undefined ? people(app)?.get(card.personId) : undefined;
  const who = p ? `${label(p)}${p.aliases.length ? ` · also "${p.aliases.slice(0, 2).join('", "')}"` : ''}` : `"${card.what}"`;
  const line = `Reminder #${r.id} set: when ${card.what} comes up (${who}), you'll bring up "${r.text}". ${r.each ? `Every time (at most once in ${st.each.gapHours} h, ${st.each.fires} times)` : 'Once'}.${r.expiresAt ? ` Until ${r.expiresAt.slice(0, 10)}.` : ''}${card.armed ? '' : ' It waits for Keep it on the card.'}`;
  return { ok: true, reminder: r, card, line };
}

/** One line per pending mention reminder (`remind list`, /when). */
export function mentionLines(app: AppContext): { id: number; line: string }[] {
  const st = mentionSettings(app);
  return (app.planner?.mentionReminders() ?? []).map((r) => {
    const d = mentionOf(r);
    const what = d ? whatOf(app, d) : '?';
    return { id: r.id, line: `#${r.id} ${what} → "${r.text}" (${r.each ? `every time, ${r.fired} of ${Math.min(st.each.fires, d?.fires ?? st.each.fires)}` : 'once'}${r.armedAt ? '' : ', waiting for Keep it'})` };
  });
}

/** What the remind tool asks of this module (planner.ts stays free of People and chats). */
export interface MentionToolDeps {
  set(args: Record<string, unknown>, conversationId: string | undefined): string;
  /** `remind list`: his own chats see them; elsewhere only how many are kept back. */
  list(conversationId: string | undefined): { lines: string[]; hidden: number };
}
export function mentionToolDeps(app: AppContext): MentionToolDeps {
  return {
    set(args, conversationId) {
      const also = Array.isArray(args.also) ? args.also.map(String) : typeof args.also === 'string' ? [args.also] : [];
      const r = setMention(app, { text: String(args.text ?? ''), ...(args.topic ? { topic: String(args.topic) } : {}), ...(args.person ? { person: String(args.person) } : {}), also, each: args.each === true || args.each === 'true', conversationId: conversationId ?? null });
      if (!r.ok) throw Object.assign(new Error(r.message), { toolError: true, reason: r.reason });
      return r.line;
    },
    list(conversationId) {
      const lines = mentionLines(app);
      const conv = conversationId ? app.store.getConversation(conversationId) : undefined;
      return ownChat(app, conv) ? { lines: lines.map((l) => l.line), hidden: 0 } : { lines: [], hidden: lines.length };
    },
  };
}

/** Forgetting a person: their reminders end (listed under Done). Returns how many. */
export function endForPerson(app: AppContext, personId: number): number {
  let n = 0;
  for (const r of app.planner?.mentionReminders() ?? []) if (mentionOf(r)?.personIds.includes(personId) && app.planner!.endMention(r.id, 'forgot')) n++;
  return n;
}
/** How many pending reminders are about this card (the Forget confirmation counts them). */
export function remindersAbout(app: AppContext, personId: number): Reminder[] {
  return (app.planner?.mentionReminders() ?? []).filter((r) => mentionOf(r)?.personIds.includes(personId));
}

// ---------------------------------------------------------------- /when (§4.2, §4.7)

export type WhenParsed = { sub: 'list' } | { sub: 'off' } | { sub: 'on' } | { sub: 'forget' | 'again' | 'keep'; n: number } | { sub: 'set'; topic: string; text: string; each: boolean } | { sub: 'help' };
/** `/when` · `/when Dan: he owes me $20` · `… , every time` · `/when forget 2` · `/when again 2` · `/when off`. */
export function parseWhenCommand(args: string): WhenParsed {
  const a = args.trim();
  if (!a) return { sub: 'list' };
  const m = /^(forget|again|keep|cancel)\s+#?(\d{1,6})$/i.exec(a);
  if (m) return { sub: m[1].toLowerCase() === 'cancel' ? 'forget' : (m[1].toLowerCase() as 'forget' | 'again' | 'keep'), n: Number(m[2]) };
  if (/^off$/i.test(a)) return { sub: 'off' };
  if (/^on$/i.test(a)) return { sub: 'on' };
  const sep = /\s*(?::|->|→|\bthen\b)\s*/i.exec(a);
  if (!sep || sep.index === 0) return { sub: 'help' };
  const topic = a.slice(0, sep.index).replace(/^(?:when|if|next time)\s+/i, '').replace(/\s+comes? up$/i, '').trim();
  let text = a.slice(sep.index + sep[0].length).trim();
  let each = false;
  const ev = /[,;]?\s*(every time|each time|each|always)\.?$/i.exec(text);
  if (ev) {
    each = true;
    text = text.slice(0, ev.index).trim();
  }
  text = text.replace(/^remind me (?:that |to )?/i, '').trim();
  return topic && text ? { sub: 'set', topic, text, each } : { sub: 'help' };
}
/** The numbers of the last /when list in each chat (`/when forget 2` works on them, or on #ids). */
const lastLists = new Map<string, number[]>();
export function rememberList(key: string, ids: number[]): void {
  lastLists.set(key, ids);
  if (lastLists.size > 200) lastLists.delete(lastLists.keys().next().value!);
}
export function idFromList(key: string, n: number): number {
  const ids = lastLists.get(key);
  return ids && n >= 1 && n <= ids.length ? ids[n - 1] : n;
}

// ---------------------------------------------------------------- rooms: 'dm' (§4.4)

/** The newest open owner DM conversation on the bridge a work room belongs to (undefined: none). */
function ownerDmOf(app: AppContext, room: Conversation): Conversation | undefined {
  const base = room.channel.replace(/-work(-nsfw)?$/, '');
  return app.store
    .listConversations()
    .filter((c) => c.channel === base && !c.partner && !c.endedAt && !c.archivedAt && !c.private)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
/**
 * His own line in a work room set one off (with `rooms: 'dm'`): nothing goes into the room's turn;
 * one line lands in his own DM on that bridge ("In #dev you mentioned the release: …"), sent by
 * the bridge like a reminder. Returns the hits it delivered.
 */
export function roomMentionToDm(app: AppContext, room: Conversation, m: { messageId: number; text: string; found: Person[] }, now: Date): MentionHit[] {
  const dm = ownerDmOf(app, room);
  if (!dm || !app.planner) return [];
  const hits = matchMentions(app, { conversation: room, messageId: m.messageId, text: m.text, found: m.found }, now);
  for (const h of hits) {
    const line = tr(en('In {room} you mentioned {what}: {text}'), appLanguage(app.settings.get()), { room: room.title.replace(/^(Telegram|Discord) work: /, ''), what: h.what, text: h.reminder.text }, identityOf(app.persona));
    const msg = app.store.addMessage(dm.id, 'assistant', line, { mentions: [], fromRoom: room.id });
    const res = afterReply(app, [h], { conversationId: dm.id, messageId: m.messageId, replyId: msg.id, reply: line, now });
    app.events?.publish({ type: 'message', conversationId: dm.id, message: { id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt, meta: { mentions: res.chips } }, reason: 'reminder' });
  }
  return hits;
}
