// 3.1 + 3.2: after a conversation goes quiet, the conversation's own model writes a dated summary
// and pulls out a few owner facts. Every fact must cite the owner's message and quote his exact
// words; anything that can't be verified against the transcript is dropped (receipts for memory).
import { guard } from './log.ts';
import type { MemoryKind } from './memory.ts';
import { resolveFor, type AppContext } from './chat.ts';
import { parseOnDate, type MemoryStore } from './memory.ts';
import { type DecayPolicy, type FadePreset, PRESET_HALF_LIFE } from './memory-rank.ts';
import { importedName, type StoredMessage } from './store.ts';
import { DEFAULT_IDENTITY, type Identity, personalize } from './identity.ts';
import { identityOf } from './persona.ts';
import { usageScope } from './usage.ts';
import { fold } from './people.ts';

export interface MemorySettings {
  enabled: boolean;
  quietMinutes: number;
  injectBudgetChars: number;
  /**
   * Phase 32: old notes come to mind only when something brings them up (like people).
   * Phase 76: the preset of the decay policy (half-life 0 / 365 / 120 days), or 'custom'.
   */
  fade?: FadePreset;
  /** Phase 76: the decay policy's own numbers (half-life for 'custom', reuse lift, min standing). */
  decay?: Partial<DecayPolicy>;
  /** Phase 85 (harness M10): "Recall on her own" (off / coding conversations only (default) / everywhere). */
  recall?: import('./triggers.ts').RecallMode;
}

/** Days before a note stops coming to mind on its own, by fade setting (Phase 76: the half-life of each preset). */
export const FADE_DAYS = PRESET_HALF_LIFE;
export { decayPolicy, explainPolicy, type DecayPolicy } from './memory-rank.ts';

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { enabled: true, quietMinutes: 30, injectBudgetChars: 2500 };

const MAX_TRANSCRIPT_CHARS = 30_000;
const MAX_FACTS = 5;
const MAX_SELF = 3;
const MAX_DATES = 6;
const MAX_DECISIONS = 3;
const MAX_PROMISES = 3;
const MAX_MILESTONES = 2;
const RETRY_AFTER_MS = 60 * 60 * 1000;
/** Phase 32: summarize a long conversation every this many new messages, even while it goes on. */
const ROLLING_MESSAGES = 40;
/** Phase 32: when a new conversation starts, the others count as quiet after this long. */
const EAGER_QUIET_MS = 2 * 60_000;
const SUMMARY_MAX_TOKENS = 900;
const SUMMARY_TIMEOUT_MS = 120_000;

export function memorySettings(app: AppContext): MemorySettings {
  const saved = app.settings.get().memory as (Partial<MemorySettings> & { budgetMoved?: boolean }) | undefined;
  const s = { ...DEFAULT_MEMORY_SETTINGS, ...saved };
  // Phase 32: 1500 was the old default (saved along with other memory settings); it's now 2500.
  // Moved once and remembered, so an owner who picks 1500 afterwards keeps it.
  if (saved && !saved.budgetMoved) {
    if (s.injectBudgetChars === 1500) s.injectBudgetChars = DEFAULT_MEMORY_SETTINGS.injectBudgetChars;
    try {
      app.settings.update({ memory: { ...saved, injectBudgetChars: s.injectBudgetChars, budgetMoved: true } as MemorySettings });
    } catch {
      // read-only settings (tests, a full disk): use the value anyway
    }
  }
  return s;
}

/**
 * The local day (YYYY-MM-DD) of a time in the owner's time zone. The one local-day formatter
 * (calls, daysKnown, notes, briefings): a zone this Node doesn't know (a hand-edited or restored
 * settings.json, a zone dropped by a newer ICU) falls back to the UTC day instead of throwing.
 */
export function localDate(when: string | Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(typeof when === 'string' ? new Date(when) : when);
  } catch {
    if (typeof when === 'string') return when.slice(0, 10);
    return Number.isNaN(when.getTime()) ? '' : when.toISOString().slice(0, 10);
  }
}

/** Messages Sara must not see or remember (forgotten by the owner). */
export const isForgotten = (m: StoredMessage) => m.meta?.forgotten === true;

function transcriptLine(m: StoredMessage, owner: string, tz?: string, name = 'Sara'): string | null {
  if (isForgotten(m)) return null;
  const when = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(m.createdAt));
  if (m.role === 'user') return `[#${m.id} ${owner} ${when}] ${m.content}`;
  // Phase 51: another assistant's reply in imported history is labelled as theirs.
  if (m.role === 'assistant' && typeof m.meta?.importedFrom === 'string') return m.content.trim() ? `[#${m.id} ${importedName(`import-${m.meta.importedFrom}`) ?? 'Other assistant'} (another AI assistant, not ${name}) ${when}] ${m.content}` : null;
  // Phase 66: another companion's line in a group chat is labelled as hers, never this companion's.
  if (m.role === 'assistant' && m.meta?.groupFrom && typeof m.meta.groupFrom === 'object') return m.content.trim() ? `[#${m.id} ${String((m.meta.groupFrom as { name?: unknown }).name ?? 'Another companion')} (another AI companion in this group chat, not ${name}) ${when}] ${m.content}` : null;
  if (m.role === 'assistant') return m.content.trim() ? `[#${m.id} ${name} ${when}] ${m.content}` : null;
  if (m.role === 'tool') return `[#${m.id} tool receipt] ${String(m.meta?.summary ?? m.meta?.name ?? 'tool')} → ${String(m.meta?.status ?? 'ok')}`;
  return null;
}

export function memoryPrompt(owner: string, transcript: string, id: Identity = DEFAULT_IDENTITY, open: { id: number; content: string }[] = [], related: { id: number; content: string }[] = []): string {
  // Written for Sara/she; the instructions are personalized, the transcript is inserted as is.
  const O = '\u0001'; // owner placeholder: the owner's name is never rewritten
  const [head, tail] = personalize(`You maintain Sara's long-term memory. Below is part of a conversation between ${O} and Sara (an AI companion). Lines start with a message id.

\u0002

Return ONLY a JSON object, no other text:
{"summary": "...", "facts": [{"fact": "...", "message_id": 123, "quote": "...", "about": [{"name": "...", "relation": "..."}], "category": null}], "sara": [{"fact": "...", "message_id": 124, "quote": "..."}], "dates": [{"what": "...", "date": "MM-DD", "message_id": 125, "quote": "...", "about": []}], "decisions": [{"what": "...", "message_id": 126, "quote": "..."}], "promises": [{"who": "owner", "what": "...", "due": null, "message_id": 127, "quote": "..."}], "milestones": [{"what": "...", "message_id": 128, "quote": "..."}], "kept": [{"promise": 5, "message_id": 129, "quote": "..."}], "outdated": [{"note": 7, "message_id": 130, "quote": "..."}]}

summary: 2 to 5 sentences, past tense, third person ("${O} and Sara ..."). What actually happened: topics, decisions, plans, open items, and work Sara did. Mention work as done only if a "tool receipt" line shows it with "ok". No guessing, no feelings you weren't told about.
facts: at most ${MAX_FACTS} lasting facts about ${O} that ${O} stated directly: preferences, people and pets (with names), projects, plans, important dates. Each fact is one short sentence starting with "${O}". message_id is the id of ${O}'s message that states it; quote is ${O}'s exact words from that message (a short phrase copied verbatim). Nothing about Sara, no small talk, no passing moods. Use [] when there are none.
sara: at most ${MAX_SELF} things Sara said about her own life (not about ${O}) that she should stay consistent with later: things she did or will do, places, people, tastes, opinions, plans (e.g. "Sara said she watched The Thing last night."). Each starts with "Sara". message_id is Sara's message that says it; quote is Sara's exact words from it. Skip anything about tools or ${O}'s work. Use [] when there are none.
dates: dates that matter to ${O} and come back every year or are coming up: birthdays, anniversaries, a wedding, a trip, an exam, an interview, an appointment, a race, a visit (e.g. what: "${O}'s mom's birthday", date: "03-14"). date is "MM-DD" for every year, or "YYYY-MM-DD" when the year is known or it happens once. Only when ${O} gave the actual day (not "next week"); a weekday like "on Thursday" counts: work out the date from when the message was sent. message_id and quote as for facts (${O}'s exact words). Use [] when there are none.
about (facts and dates): the people other than ${O} it is about (never ${O}, never Sara, never pets), each {"name": as ${O} says it, "relation": who they are to ${O} in ${O}'s words (\"my brother\", \"my manager\") or to another person (\"Jeff's wife\"), only when said; add \"alias\" when ${O} used another way to say who it is (\"Jeff from work\")}. Use [] when it is only about ${O}. category (facts): \"health\", \"intimate\", \"money\" or \"legal\" when the fact is about someone's health, sex life or relationship trouble, money trouble or legal trouble; otherwise null.
decisions: at most ${MAX_DECISIONS} things ${O} and Sara decided or agreed on together, or rules ${O} set for how Sara should act (e.g. "${O} and Sara agreed to try the new gym on Mondays", "${O} wants Sara to stop reminding him about water"). One short sentence each. message_id is the message where it was settled (either person's); quote is exact words from it. Use [] when there are none.
promises: at most ${MAX_PROMISES} commitments someone made: who is "owner" (${O} will do something, e.g. quit coffee for a month) or "sara" (Sara said she will do something, e.g. check in after the interview). what is one short sentence starting with ${O} or Sara. due is "YYYY-MM-DD" only if a day was given or clearly meant, else null. message_id and quote as above (the promiser's own message and words). Use [] when there are none.
milestones: at most ${MAX_MILESTONES} moments that matter in their story together: firsts, big news, a hard day, making up after a disagreement, an inside joke being born. One short sentence each, past tense. message_id and quote as above. Use [] for ordinary chats (most conversations have none).
kept: open promises (listed below with their numbers) that this part of the conversation shows were kept or are no longer wanted; promise is the number, with the message_id and exact quote that shows it. Use [] when none.
outdated: earlier notes (listed below as "Earlier notes" with their numbers) that this part of the conversation shows are no longer true or were changed (moved house, changed jobs, broke up, a decision reversed); note is the number, with the message_id and exact quote that shows the change. The new version goes in facts or decisions as usual. A one-time exception is not a change: when ${O} lets Sara do something "anyway" or "just this once" against a decision (or presses Do it anyway on a card), the decision still stands: don't mark it outdated and don't write the exception down as a new decision. Use [] when none.\u0003`, id).replaceAll(O, owner).replace('\u0003', `${open.length ? `\n\nOpen promises:\n${open.map((p) => `${p.id}. ${p.content}`).join('\n')}` : '\n\nOpen promises: none.'}${related.length ? `\n\nEarlier notes:\n${related.map((p) => `${p.id}. ${p.content}`).join('\n')}` : ''}`).split('\u0002');
  return `${head}${transcript}${tail}`;
}

type RawAbout = { name: string; relation?: string | null; alias?: string | null };
type RawFact = { fact: string; message_id: number; quote: string; about?: RawAbout[]; category?: string | null };

type RawDate = { what: string; date: string; message_id: number; quote: string; about?: RawAbout[] };
type RawItem = { what: string; message_id: number; quote: string; who?: string; due?: string | null; promise?: number };

/** Phase 101 (ST6): the people a fact or date is about, and its sensitive category (health, intimate, money, legal). */
function aboutOf(f: Record<string, unknown>): { about?: RawAbout[]; category?: string | null } {
  const about = Array.isArray(f.about)
    ? f.about
        .map((a) => (typeof a === 'string' ? { name: a } : a && typeof a === 'object' ? (a as Record<string, unknown>) : null))
        .filter((a): a is Record<string, unknown> => Boolean(a && typeof a.name === 'string' && a.name.trim()))
        .slice(0, 6)
        .map((a) => ({ name: String(a.name).trim().slice(0, 80), ...(typeof a.relation === 'string' && a.relation.trim() ? { relation: a.relation.trim().slice(0, 80) } : {}), ...(typeof a.alias === 'string' && a.alias.trim() ? { alias: a.alias.trim().slice(0, 80) } : {}) }))
    : [];
  const category = typeof f.category === 'string' && ['health', 'intimate', 'money', 'legal'].includes(f.category) ? f.category : null;
  return { ...(about.length ? { about } : {}), ...(category ? { category } : {}) };
}

export function parseMemoryJson(text: string): { summary: string; facts: RawFact[]; sara: RawFact[]; dates: RawDate[]; decisions: RawItem[]; promises: RawItem[]; milestones: RawItem[]; kept: RawItem[]; outdated: RawItem[] } | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1)) as { summary?: unknown; facts?: unknown; sara?: unknown; dates?: unknown; decisions?: unknown; promises?: unknown; milestones?: unknown; kept?: unknown; outdated?: unknown };
    const items = (v: unknown): RawItem[] =>
      Array.isArray(v)
        ? v
            .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
            .map((f) => ({
              what: String(f.what ?? '').trim(),
              message_id: Number(f.message_id),
              quote: String(f.quote ?? '').trim(),
              ...(f.who !== undefined ? { who: String(f.who) } : {}),
              ...(typeof f.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.due) ? { due: f.due } : {}),
              ...(f.promise !== undefined ? { promise: Number(f.promise) } : {}),
              ...(f.note !== undefined ? { promise: Number(f.note) } : {}),
            }))
        : [];
    if (typeof j.summary !== 'string' || !j.summary.trim()) return null;
    const list = (v: unknown): RawFact[] =>
      Array.isArray(v)
        ? v
            .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
            .map((f) => ({ fact: String(f.fact ?? '').trim(), message_id: Number(f.message_id), quote: String(f.quote ?? '').trim(), ...aboutOf(f) }))
        : [];
    const dates: RawDate[] = Array.isArray(j.dates)
      ? j.dates
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
          .map((f) => ({ what: String(f.what ?? '').trim(), date: String(f.date ?? '').trim(), message_id: Number(f.message_id), quote: String(f.quote ?? '').trim(), ...aboutOf(f) }))
      : [];
    return { summary: j.summary.trim(), facts: list(j.facts), sara: list(j.sara), dates, decisions: items(j.decisions), promises: items(j.promises), milestones: items(j.milestones), kept: items(j.kept), outdated: items(j.outdated) };
  } catch {
    return null;
  }
}

/**
 * Phase 101 (ST6, STAPLES §9.3): a fact's people go on their cards (a new card is proposed, never
 * active). A name must be in the owner's own message (no invented people); without `about` from the
 * model, code looks for "my brother Jeff" in the fact. Other assistants' imported history, group
 * chats and other agents never get here (only the owner's own lines are facts).
 */
function linkPeople(app: AppContext, m: import('./memory.ts').Memory, about: RawAbout[] | undefined, said: string, category: string | null, isPrivate: boolean): void {
  const people = app.people;
  if (!people) return;
  try {
    const saidF = fold(said);
    const items = (about?.length ? about : people.aboutFromText(m.content)).filter((a) => saidF.includes(fold(a.name.split(/\s+/)[0])));
    if (!items.length) return;
    const r = people.linkMemory(m, items, { category: (category as import('./people.ts').FactCategory | null) ?? null, private: isPrivate, text: said });
    if (r.personIds.length) app.events?.publish({ type: 'people', what: r.created ? 'proposed' : 'facts' });
  } catch (err) {
    console.warn(`people: ${(err as Error).message}`);
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();

export interface SummarizeResult {
  summaryId?: number;
  factIds: number[];
  selfIds?: number[];
  dateIds?: number[];
  droppedFacts: number;
  through: number;
  error?: string;
}

/** Phase 66: the note added to the memory prompt for a group chat: what she remembers is what was said there, in her presence, tagged with the room. */
export function groupChatNote(owner: string, name: string, title: string, others: string[]): string {
  const who = others.length ? others.join(', ') : 'other AI companions';
  return `\n\nIMPORTANT: this is a group chat called "${title}" with ${owner}, ${name} and other AI companions (${who}). Start the summary with: In the group chat "${title}". Lines marked as another AI companion are that companion's words, not ${name}'s and not ${owner}'s. facts, dates, promises by the owner and milestones come ONLY from ${owner}'s own lines; sara comes ONLY from ${name}'s own lines; what the other companions said is never a fact about ${owner} or ${name}.`;
}

/** Phase 66: the other companions who spoke in these lines. */
function groupNames(messages: StoredMessage[]): string[] {
  return [...new Set(messages.flatMap((m) => (m.meta?.groupFrom && typeof m.meta.groupFrom === 'object' ? [String((m.meta.groupFrom as { name?: unknown }).name ?? '')] : [])).filter(Boolean))];
}

/** Phase 51: the note added to the memory prompt for imported history (another assistant was there, not her). */
export function importedHistoryNote(owner: string, other: string, name: string): string {
  return `\n\nIMPORTANT: this is from ${owner}'s imported ${other} history. ${owner} was talking with ${other}, a different AI assistant, not with ${name}; lines marked ${other} are ${other}'s words, not ${name}'s. Write the summary about ${owner} and ${other} (e.g. "${owner} asked ${other} for help planning a trip to Lisbon"), never saying ${name} said, did or was there. facts, dates, promises, decisions and milestones come ONLY from ${owner}'s own lines (message_id of an ${owner} line, quote from it); what ${other} said is never a fact about ${owner}. sara must be [].`;
}

export async function summarizeConversation(app: AppContext, mem: MemoryStore, conversationId: string, opts: { signal?: AbortSignal; fromId?: number } = {}): Promise<SummarizeResult> {
  const conv = app.store.getConversation(conversationId);
  if (!conv) return { factIds: [], droppedFacts: 0, through: 0, error: 'Conversation not found' };
  // Phase 100 (STAPLES §8.2): another agent's words are untrusted text, never facts about the owner.
  if (conv.channel === 'a2a') return { factIds: [], droppedFacts: 0, through: app.store.lastMessageId(conversationId) };
  const s = app.settings.get();
  const owner = s.ownerName?.trim() || 'The owner';
  const state = mem.state(conversationId);
  // Phase 51: learning from imported history reads it from the start (fromId 0).
  const all = app.store.messages(conversationId).filter((m) => m.id > (opts.fromId ?? state.summarizedThrough));
  const other = importedName(conv.channel);
  /** Another assistant's line in imported history: never evidence for anything. */
  const theirs = (m: StoredMessage) => m.role === 'assistant' && (typeof m.meta?.importedFrom === 'string' || Boolean(m.meta?.groupFrom));
  const usable = all.filter((m) => !isForgotten(m));
  if (!usable.some((m) => m.role === 'user')) {
    if (all.length) mem.setState(conversationId, { summarizedThrough: all.at(-1)!.id, lastError: null });
    return { factIds: [], droppedFacts: 0, through: all.at(-1)?.id ?? state.summarizedThrough };
  }

  // Newest-first until the budget, then back into order.
  const lines: { m: StoredMessage; line: string }[] = [];
  let size = 0;
  for (const m of [...usable].reverse()) {
    const line = transcriptLine(m, owner, s.timeZone, app.persona.name);
    if (!line) continue;
    if (size + line.length > MAX_TRANSCRIPT_CHARS && lines.length) break;
    lines.push({ m, line: line.slice(0, 4000) });
    size += line.length;
  }
  lines.reverse();
  const first = lines[0].m;
  const last = all.at(-1)!;
  const byId = new Map(usable.map((m) => [m.id, m]));

  const attempt = app.now().toISOString();
  let related: { id: number; content: string }[] = [];
  let parsed: ReturnType<typeof parseMemoryJson> = null;
  let lastErr = '';
  try {
    const { provider, model } = resolveFor(app, conv, 'background');
    const transcript = lines.map((l) => l.line).join('\n');
    // Earlier facts and decisions on the same subjects, so changes replace them (Phase 32).
    related = relatedNotes(mem, lines.filter((l) => l.m.role === 'user').map((l) => l.m.content).join(' '));
    const prompt = memoryPrompt(owner, transcript, identityOf(app.persona), mem.openPromises(15).map((p) => ({ id: p.id, content: p.content })), related) + (other ? importedHistoryNote(owner, other, app.persona.name) : '') + (conv.channel === 'group' ? groupChatNote(owner, app.persona.name, conv.title, groupNames(usable)) : '');
    for (let tryNo = 0; tryNo < 2 && !parsed; tryNo++) {
      let out = '';
      const messages = [
        { role: 'system' as const, content: 'You write concise, factual memory notes. Output only valid JSON.' },
        { role: 'user' as const, content: tryNo ? `${prompt}\n\nYour previous answer was not valid JSON. Return only the JSON object.` : prompt },
      ];
      // Bounded: a rambling model must never stall the memory worker.
      const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      for await (const ev of provider.stream({ model, messages, temperature: 0.2, maxTokens: SUMMARY_MAX_TOKENS, reasoning: 'none', signal })) {
        if (ev.type === 'text') out += ev.text;
        if (out.length > SUMMARY_MAX_TOKENS * 6) break;
      }
      parsed = parseMemoryJson(out);
      if (!parsed) lastErr = `Model did not return valid JSON: ${out.slice(0, 200)}`;
    }
  } catch (err) {
    lastErr = (err as Error).message;
  }
  if (!parsed) {
    mem.setState(conversationId, { lastAttemptAt: attempt, lastError: lastErr || 'unknown error' });
    return { factIds: [], droppedFacts: 0, through: state.summarizedThrough, error: lastErr };
  }
  // The model call can take a minute or two: if the owner deleted the conversation or had her
  // forget something in it meanwhile, what was just written about it must not come back.
  const now = app.store.getConversation(conversationId) ? app.store.messages(conversationId) : [];
  const stillThere = new Set(now.filter((m) => !isForgotten(m)).map((m) => m.id));
  if (!now.length || lines.some((l) => !stillThere.has(l.m.id))) {
    return { factIds: [], droppedFacts: 0, through: state.summarizedThrough, error: 'The conversation changed while it was being summarized; it will be done again.' };
  }

  // Phase 51: a model that still wrote "Alex and Sara…" about imported history gets it put right
  // (unless the owner's own lines there name someone called that).
  const nameRe = new RegExp(`\\b${app.persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const summaryText = other && !usable.some((m) => m.role === 'user' && new RegExp(nameRe.source).test(m.content)) ? parsed.summary.replace(nameRe, other) : parsed.summary;
  const summary = mem.add({
    kind: 'summary',
    content: app.redactor.redact(summaryText).slice(0, 1500),
    conversationId,
    sourceFromId: first.id,
    sourceMessageId: last.id,
    happenedOn: localDate(last.createdAt, s.timeZone),
  });
  const factIds: number[] = [];
  let dropped = 0;
  for (const f of parsed.facts.slice(0, MAX_FACTS)) {
    const src = byId.get(f.message_id);
    const ok =
      f.fact.length >= 5 &&
      f.fact.length <= 300 &&
      src?.role === 'user' &&
      f.quote.length >= 3 &&
      squash(src.content).includes(squash(f.quote)) &&
      !mem.hasFact(f.fact, src.id);
    if (!ok || !src) {
      dropped++;
      continue;
    }
    const added = mem.add({ kind: 'fact', content: app.redactor.redact(f.fact), conversationId, sourceMessageId: src.id, happenedOn: localDate(src.createdAt, s.timeZone), evidence: app.redactor.redact(f.quote) });
    factIds.push(added.id);
    linkPeople(app, added, f.about, src.content, f.category ?? null, Boolean(conv.private));
  }
  dropped += Math.max(0, parsed.facts.length - MAX_FACTS);
  // Sara's own statements: same verification against her message.
  const selfIds: number[] = [];
  for (const f of parsed.sara.slice(0, MAX_SELF)) {
    const src = byId.get(f.message_id);
    const ok = f.fact.length >= 5 && f.fact.length <= 300 && src?.role === 'assistant' && !theirs(src) && f.quote.length >= 3 && squash(src.content).includes(squash(f.quote)) && !mem.hasFact(f.fact, src.id, 'self');
    if (!ok || !src) {
      dropped++;
      continue;
    }
    selfIds.push(mem.add({ kind: 'self', content: app.redactor.redact(f.fact), conversationId, sourceMessageId: src.id, happenedOn: localDate(src.createdAt, s.timeZone), evidence: app.redactor.redact(f.quote) }).id);
  }
  // Dates that matter (Phase 12): the owner's own words must contain them, and the day must be real.
  const dateIds: number[] = [];
  const known = mem.list({ kind: 'date', limit: 500 });
  for (const f of parsed.dates.slice(0, MAX_DATES)) {
    const src = byId.get(f.message_id);
    const ok =
      f.what.length >= 3 &&
      f.what.length <= 200 &&
      parseOnDate(f.date) !== null &&
      src?.role === 'user' &&
      f.quote.length >= 3 &&
      squash(src.content).includes(squash(f.quote)) &&
      !known.some((k) => squash(k.content) === squash(f.what) || (k.onDate === f.date && squash(k.content).split(' ')[0] === squash(f.what).split(' ')[0]));
    if (!ok || !src) {
      dropped++;
      continue;
    }
    const added = mem.add({ kind: 'date', content: app.redactor.redact(f.what), onDate: f.date, conversationId, sourceMessageId: src.id, happenedOn: localDate(src.createdAt, s.timeZone), evidence: app.redactor.redact(f.quote) });
    dateIds.push(added.id);
    linkPeople(app, added, f.about, src.content, null, Boolean(conv.private));
  }
  // Phase 32: decisions, promises and milestones, each checked against the exact words quoted.
  const quoted = (it: RawItem, roles: string[]) => {
    const src = byId.get(it.message_id);
    return src && roles.includes(src.role) && !theirs(src) && it.quote.length >= 3 && squash(src.content).includes(squash(it.quote)) ? src : undefined;
  };
  const existing = (kind: MemoryKind) => new Set(mem.list({ kind, limit: 300 }).map((m) => squash(m.content)));
  const ledgerIds: number[] = [];
  for (const [kind, list, max] of [['decision', parsed.decisions, MAX_DECISIONS], ['promise', parsed.promises, MAX_PROMISES], ['milestone', parsed.milestones, MAX_MILESTONES]] as const) {
    const seen = existing(kind);
    for (const it of list.slice(0, max)) {
      // A promise is checked against the promiser's own message.
      const roles = kind === 'promise' ? (it.who === 'owner' ? ['user'] : ['assistant']) : ['user', 'assistant'];
      const src = quoted(it, roles);
      if (!src || it.what.length < 5 || it.what.length > 300 || seen.has(squash(it.what))) {
        dropped++;
        continue;
      }
      seen.add(squash(it.what));
      ledgerIds.push(mem.add({ kind, content: app.redactor.redact(it.what), conversationId, sourceMessageId: src.id, happenedOn: localDate(src.createdAt, s.timeZone), evidence: app.redactor.redact(it.quote), ...(kind === 'promise' && it.due ? { onDate: it.due } : {}) }).id);
    }
  }
  // Promises kept (or called off) in this part of the conversation.
  const openIds = new Set(mem.openPromises(50).map((p) => p.id));
  for (const it of parsed.kept) {
    if (it.promise !== undefined && openIds.has(it.promise) && quoted(it, ['user', 'assistant'])) mem.resolve(it.promise, attempt);
  }
  // Earlier notes this conversation shows are no longer true: replaced (kept on the Memory page).
  const relatedIds = new Set(related.map((r) => r.id));
  const newest = [...factIds, ...ledgerIds].at(-1) ?? null;
  // Phase 77: a decision the owner overrode once on a plan-check card (\"Do it anyway\") still
  // stands: a one-time exception never retires it, whatever the summary model reads into it.
  const overridden = new Set<number>();
  for (const m of app.store.messages(conversationId)) {
    if (m.role !== 'assistant' || !Array.isArray(m.meta?.contradictions)) continue;
    for (const c of m.meta.contradictions as { memoryId?: unknown; answer?: unknown }[]) if (c?.answer === 'override' && typeof c.memoryId === 'number') overridden.add(c.memoryId);
  }
  for (const it of parsed.outdated) {
    if (it.promise !== undefined && relatedIds.has(it.promise) && !overridden.has(it.promise) && quoted(it, ['user', 'assistant'])) mem.supersede(it.promise, newest);
  }
  mem.setState(conversationId, { summarizedThrough: last.id, lastAttemptAt: attempt, lastError: null });
  app.events?.publish({ type: 'memory', conversationId });
  return { summaryId: summary.id, factIds, selfIds, dateIds, droppedFacts: dropped, through: last.id };
}

/** Owner "forget": removes the memory, hides its source turn(s) from Sara, and re-summarizes without them. */
/** Capitalized words that aren't names of anything (never used to find mentions to hide). */
const NOT_NAMES = new Set('january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday the this that and but his her their our christmas easter halloween thanksgiving new year today tomorrow ai'.split(' '));

/**
 * Words that are never "the thing being forgotten": every word of the owner's name and of the
 * companion's name ("Alex Smith": both "Alex" and "Smith"; nearly every note names the owner).
 */
function ownWords(app: AppContext): Set<string> {
  const words = `${app.settings.get().ownerName ?? ''} ${app.persona.name}`.toLowerCase().split(/[^\p{L}'-]+/u).filter(Boolean);
  return new Set(words.flatMap((w) => [w, w.replace(/'s$/, '')]));
}
/** The names in a note (capitalised words, not the first word, not the owner's or her own). */
export function namesIn(content: string, own: Set<string>): string[] {
  return [...new Set((content.match(/(?<!^)\b[A-Z][\p{L}'-]{2,}/gu) ?? []).map((w) => w.replace(/'s$/, '')))].filter((w) => !own.has(w.toLowerCase()) && !NOT_NAMES.has(w.toLowerCase()));
}

export function forgetMemory(app: AppContext, mem: MemoryStore, id: number): { removed: number[]; hiddenMessages: number[] } | undefined {
  const m = mem.get(id);
  if (!m) return undefined;
  const removed: number[] = [];
  const hidden: number[] = [];
  // Conversation → the earliest message hidden there (its summaries are rewritten from before it).
  const touched = new Map<string, number>();
  const hide = (convId: string, msgId: number) => {
    app.store.updateMessageMeta(msgId, { forgotten: true });
    hidden.push(msgId);
    touched.set(convId, Math.min(touched.get(convId) ?? Number.POSITIVE_INFINITY, msgId));
  };
  const conv = m.conversationId ? app.store.getConversation(m.conversationId) : undefined;
  if (conv && m.sourceMessageId) {
    const range = m.kind === 'summary' && m.sourceFromId ? [m.sourceFromId, m.sourceMessageId] : [m.sourceMessageId, m.sourceMessageId];
    for (const msg of app.store.messages(conv.id)) {
      if (msg.id >= range[0] && msg.id <= range[1] && (m.kind === 'summary' || msg.id === m.sourceMessageId) && !isForgotten(msg)) hide(conv.id, msg.id);
    }
  }
  // Phase 32: later messages that repeat it (her "Biscuit!" a week later) are hidden too, or she'd
  // still know it through "last time" and looking back. Matched by its names and its exact quote.
  const names = m.kind === 'summary' ? [] : namesIn(m.content, ownWords(app));
  if (m.kind !== 'summary') {
    const needles = [...names.map((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')), ...(m.evidence && m.evidence.length >= 8 && m.evidence !== 'You added this.' ? [new RegExp(m.evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i')] : [])];
    if (needles.length) {
      const rows = app.store.db.prepare("SELECT m.id, m.conversation_id, m.content, m.meta FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.partner IS NULL AND m.role IN ('user','assistant')").all() as { id: number; conversation_id: string; content: string; meta: string | null }[];
      for (const r of rows) {
        if (r.meta?.includes('"forgotten":true')) continue;
        if (needles.some((n) => n.test(r.content))) hide(r.conversation_id, r.id);
      }
    }
  }
  // Summaries that mention a hidden turn go too; those conversations are re-summarized without it.
  for (const [convId, firstHidden] of touched) {
    let rollback = Number.POSITIVE_INFINITY;
    for (const s of mem.summariesCovering(convId, firstHidden)) {
      mem.delete(s.id);
      removed.push(s.id);
      rollback = Math.min(rollback, (s.sourceFromId ?? 1) - 1);
    }
    // Later summaries in that conversation may repeat it as well.
    for (const s of mem.list({ kind: 'summary', limit: 500 }).filter((x) => x.conversationId === convId && (x.sourceMessageId ?? 0) >= firstHidden)) {
      if (mem.delete(s.id)) removed.push(s.id);
      rollback = Math.min(rollback, (s.sourceFromId ?? 1) - 1);
    }
    if (Number.isFinite(rollback)) mem.setState(convId, { summarizedThrough: Math.min(mem.state(convId).summarizedThrough, rollback), lastError: null });
  }
  // Other notes that carry the same names (a summary elsewhere, a duplicate fact) go too.
  if (names.length) {
    const res = names.map((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    for (const other of mem.list({ limit: 500 })) if (other.id !== m.id && res.some((re) => re.test(other.content)) && mem.delete(other.id)) removed.push(other.id);
  }
  if (mem.delete(m.id)) removed.push(m.id);
  return { removed: [...new Set(removed)], hiddenMessages: [...new Set(hidden)] };
}

/** Phase 32: current facts and decisions that share words with what the owner said (for "outdated"). */
export function relatedNotes(mem: MemoryStore, ownerText: string, limit = 10): { id: number; content: string }[] {
  if (!ownerText.trim()) return [];
  const out: { id: number; content: string }[] = [];
  for (const kind of ['fact', 'decision'] as const) {
    for (const m of mem.list({ kind, q: ownerText.slice(0, 2000), limit })) if (m.supersededBy === null && out.length < limit) out.push({ id: m.id, content: m.content });
  }
  return out;
}

/** Background job: summarizes conversations that have gone quiet. */
export class MemoryWorker {
  readonly #app: AppContext;
  readonly #mem: MemoryStore;
  readonly #isBusy: (conversationId: string) => boolean;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(app: AppContext, mem: MemoryStore, isBusy: (conversationId: string) => boolean = () => false) {
    this.#app = app;
    this.#mem = mem;
    this.#isBusy = isBusy;
  }

  start(intervalMs = 60_000): void {
    this.#timer = setInterval(() => guard('memory', () => this.tick()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer);
  }

  #nudgeTimer: NodeJS.Timeout | undefined;

  /**
   * Phase 32: a new conversation started (or the owner came back): summarize the ones that went
   * quiet a couple of minutes ago now, instead of after the usual quiet time.
   */
  nudge(delayMs = 5_000): void {
    if (this.#nudgeTimer) return;
    this.#nudgeTimer = setTimeout(() => {
      this.#nudgeTimer = undefined;
      guard('memory', () => this.tick({ eager: true }));
    }, delayMs);
    this.#nudgeTimer.unref?.();
  }

  /** Phase 52: calls made here count as 'memory' in the usage meter. */
  tick(opts: { eager?: boolean } = {}): Promise<number> {
    return usageScope.run({ purpose: 'memory' }, () => this.#tick(opts));
  }

  async #tick(opts: { eager?: boolean } = {}): Promise<number> {
    if (this.#running) return 0;
    const cfg = memorySettings(this.#app);
    if (!cfg.enabled) return 0;
    this.#running = true;
    let done = 0;
    try {
      const now = this.#app.now().getTime();
      const quietMs = opts.eager ? EAGER_QUIET_MS : cfg.quietMinutes * 60_000;
      const retry = new Date(now - RETRY_AFTER_MS);
      // Quiet conversations, plus long ones summarized as they go (Phase 32).
      const due = [...new Set([...this.#mem.dueConversations(new Date(now - quietMs), retry), ...this.#mem.rollingConversations(ROLLING_MESSAGES, retry)])];
      for (const id of due) {
        if (this.#isBusy(id) || this.#app.isBusy?.(id)) continue;
        const r = await summarizeConversation(this.#app, this.#mem, id);
        if (r.error) console.warn(`memory: summary for ${id} failed: ${r.error}`);
        else done++;
      }
    } finally {
      this.#running = false;
    }
    return done;
  }
}
