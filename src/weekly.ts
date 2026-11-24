// Phase 12: once a week she looks back.
// - Reflection: from the week's conversation notes she notices a few gentle patterns ("you've been
//   working late all week"), saved as memories she can bring up, and marks facts that newer facts
//   replace (kept for review, no longer used). Never invents: patterns must come from the notes.
// - Her life threads: a book she's reading, a hobby, a little project move on a step each week;
//   finished ones make room for new ones. Threads the owner gave her are never ended by her.
import { guard } from './log.ts';
import { everyJob, type EveryJob } from './tick-jobs.ts';
import type { AppContext } from './chat.ts';
import { innerEnabled } from './chat.ts';
import { complete, targetConversation, type LifeStore } from './life.ts';
import type { MemoryStore } from './memory.ts';
import { localDate, memorySettings } from './memory-worker.ts';
import { detectMinorSexualContent } from './safety.ts';
import { identityOf } from './persona.ts';
import { personalize } from './identity.ts';

const WEEK_MS = 7 * 86_400_000;
const MAX_ACTIVE_THREADS = 3;

function json<T>(text: string): T | null {
  const t = text.replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const unsafe = (s: string) => detectMinorSexualContent(s) || /\b(as an ai|language model)\b/i.test(s);

export function reflectionPrompt(owner: string, week: { day: string; text: string }[], facts: { id: number; day: string; text: string }[]): string {
  return `Look back over the past week of conversations between ${owner} and their companion.

This week's conversation notes (dated):
${week.map((w) => `- (${w.day}) ${w.text}`).join('\n')}

Facts kept about ${owner} (id, date learned):
${facts.map((f) => `[#${f.id} ${f.day}] ${f.text}`).join('\n') || '(none)'}

Return ONLY a JSON object:
{"noticed": ["..."], "outdated": [{"old": 12, "new": 30}]}

noticed: 0 to 3 gentle, specific things a caring friend would notice across SEVERAL days of these notes (a pattern or a change), each one sentence starting with "${owner}", e.g. "${owner} has been working late most nights this week." Each must be supported by notes from at least two different days; a single mention is not a pattern. Only what the notes show; no diagnoses, no judging, no guesses about health or feelings that weren't stated. [] if nothing stands out.
outdated: facts that a newer fact in the list clearly replaces (same topic, new information: moved, new job, changed plans). "old" is the older id, "new" the newer id. [] if none.`;
}

export function threadsPrompt(app: AppContext, active: { id: number; title: string; notes: string[]; weeks: number; byOwner: boolean }[], doneTitles: string[]): string {
  const p = app.persona;
  const t = (x: string) => personalize(x, identityOf(p));
  return `${p.name} is ${p.age}. ${p.summary}
Personality: ${p.personality.join(' ')}
${t("Her ongoing things (her own private life, not related to anyone she talks to)")}:
${active.map((a) => `#${a.id} ${a.title} (${a.weeks} week${a.weeks === 1 ? '' : 's'} so far${a.byOwner ? ', keep going' : ''}; so far: ${a.notes.slice(-3).join(' / ') || 'just started'})`).join('\n') || '(none yet)'}
${doneTitles.length ? `Finished before (don't repeat): ${doneTitles.join('; ')}\n` : ''}
${t(`A week has passed. Return ONLY a JSON object:
{"updates": [{"id": 3, "note": "...", "done": false}], "new": [{"title": "...", "note": "..."}]}

updates: one entry per ongoing thing above: a short note (under 20 words, plain, specific) of how it moved on this week, e.g. "got to the part where they reach the lighthouse; can't put it down". done: true only if it naturally ended (finished the book, completed the project) and it has gone on at least 3 weeks; never for ones marked "keep going".
new: only if fewer than 2 things are still going after this week, start 1 or 2 new ones that fit who she is (a real book with its author, a hobby, a small project, a show): title like 'Reading "Piranesi" by Susanna Clarke' or 'Learning to make sourdough', with a first note.
Ordinary and believable; nothing dramatic; no mention of AI, chats or anyone she talks to.`)}`;
}

export class WeeklyWorker {
  readonly #app: AppContext;
  readonly #mem: MemoryStore | undefined;
  readonly #life: LifeStore | undefined;
  readonly #random: () => number;
  #timer: EveryJob | undefined;
  #running = false;

  constructor(app: AppContext, mem: MemoryStore | undefined, life: LifeStore | undefined, random: () => number = Math.random) {
    this.#app = app;
    this.#mem = mem;
    this.#life = life;
    this.#random = random;
  }

  start(intervalMs = 60 * 60_000): void {
    this.#timer = everyJob('weekly review', intervalMs, () => this.tick());
    setTimeout(() => guard('weekly review', () => this.tick()), 5 * 60_000).unref();
  }

  stop(): void {
    this.#timer?.stop();
  }

  /** Runs whatever is due (each part at most once a week). */
  async tick(): Promise<{ reflection?: string; threads?: string }> {
    if (this.#running) return {};
    this.#running = true;
    try {
      const reflection = await this.reflect().catch((err: Error) => `failed: ${err.message}`);
      const threads = await this.moveThreads().catch((err: Error) => `failed: ${err.message}`);
      return { reflection, threads };
    } finally {
      this.#running = false;
    }
  }

  #due(last: string | undefined): boolean {
    return !last || this.#app.now().getTime() - Date.parse(last) >= WEEK_MS;
  }

  /** Weekly reflection over the conversation notes. */
  async reflect(force = false): Promise<string> {
    const app = this.#app;
    const mem = this.#mem;
    if (!mem || !memorySettings(app).enabled) return 'memory off';
    if (!force && !this.#due(mem.kvGet('reflection_at'))) return 'not due';
    const now = app.now();
    const tz = app.settings.get().timeZone;
    const since = localDate(new Date(now.getTime() - WEEK_MS).toISOString(), tz);
    const week = mem
      .list({ kind: 'summary', limit: 60 })
      .filter((m) => m.happenedOn >= since)
      .reverse()
      .map((m) => ({ day: m.happenedOn, text: m.content }));
    // A pattern needs a few conversations on different days.
    if (!force && (week.length < 3 || new Set(week.map((w) => w.day)).size < 3)) return 'not enough this week';
    const conv = targetConversation(app) ?? app.store.listConversations()[0];
    if (!conv) return 'no conversation';
    const owner = app.settings.get().ownerName?.trim() || 'The owner';
    const facts = mem
      .list({ kind: 'fact', limit: 120 })
      .filter((f) => f.supersededBy === null)
      .map((f) => ({ id: f.id, day: f.happenedOn, text: f.content }));
    const out = await complete(app, conv, [{ role: 'user', content: reflectionPrompt(owner, week, facts) }], 500);
    const j = json<{ noticed?: unknown; outdated?: unknown }>(out);
    if (!j) throw new Error(`no JSON: ${out.slice(0, 120)}`);
    const today = localDate(now.toISOString(), tz);
    let noticed = 0;
    for (const n of Array.isArray(j.noticed) ? j.noticed.slice(0, 3) : []) {
      const text = clean(n, 240);
      if (text.length < 10 || unsafe(text) || mem.hasFact(text, null)) continue;
      mem.add({ kind: 'reflection', content: app.redactor.redact(text), conversationId: null, sourceMessageId: null, happenedOn: today, evidence: `Looking back over ${since} to ${today}` });
      noticed++;
    }
    let replaced = 0;
    const byId = new Map(facts.map((f) => [f.id, f]));
    for (const o of Array.isArray(j.outdated) ? j.outdated.slice(0, 5) : []) {
      const oldId = Number((o as { old?: unknown }).old);
      const newId = Number((o as { new?: unknown }).new);
      // Only an older fact replaced by a newer one, both real facts still in use.
      if (!byId.has(oldId) || !byId.has(newId) || oldId >= newId) continue;
      mem.supersede(oldId, newId);
      replaced++;
    }
    mem.kvSet('reflection_at', now.toISOString());
    app.events?.publish({ type: 'memory', conversationId: '' });
    return `noticed ${noticed}, replaced ${replaced}`;
  }

  /** Her life threads move on a step each week. */
  async moveThreads(force = false): Promise<string> {
    const app = this.#app;
    const life = this.#life;
    if (!life || !innerEnabled(app)) return 'inner life off';
    if (!force && !this.#due(life.stateGet('threads_at'))) return 'not due';
    if (!app.store.firstOwnerMessageAt()) return 'never talked';
    const conv = targetConversation(app) ?? app.store.listConversations()[0];
    if (!conv) return 'no conversation';
    const now = app.now();
    const today = localDate(now.toISOString(), app.settings.get().timeZone);
    const active = life.threads('active');
    const weeks = (from: string) => Math.max(1, Math.round((Date.parse(today) - Date.parse(from)) / WEEK_MS));
    const done = life.threads('done').slice(0, 10).map((t) => t.title);
    const out = await complete(
      app,
      conv,
      [{ role: 'user', content: threadsPrompt(app, active.map((t) => ({ id: t.id, title: t.title, notes: t.notes.map((n) => n.text), weeks: weeks(t.startedOn), byOwner: t.byOwner })), done) }],
      500,
    );
    const j = json<{ updates?: unknown; new?: unknown }>(out);
    if (!j) throw new Error(`no JSON: ${out.slice(0, 120)}`);
    let moved = 0;
    let finished = 0;
    for (const u of Array.isArray(j.updates) ? j.updates : []) {
      const t = active.find((a) => a.id === Number((u as { id?: unknown }).id));
      const note = clean((u as { note?: unknown }).note, 200);
      if (!t || note.length < 3 || unsafe(note)) continue;
      const end = (u as { done?: unknown }).done === true && !t.byOwner && weeks(t.startedOn) >= 3;
      life.updateThread(t.id, { note: { day: today, text: note }, ...(end ? { status: 'done' as const } : {}) });
      moved++;
      if (end) finished++;
    }
    let started = 0;
    const stillActive = life.threads('active').length;
    for (const n of Array.isArray(j.new) ? j.new : []) {
      if (stillActive + started >= Math.min(MAX_ACTIVE_THREADS, 2)) break;
      const title = clean((n as { title?: unknown }).title, 120);
      const note = clean((n as { note?: unknown }).note, 200);
      if (title.length < 4 || unsafe(title) || unsafe(note) || done.includes(title)) continue;
      life.addThread(title, today, note ? { note } : {});
      started++;
    }
    // A little irregularity so her weeks don't all line up on the same hour.
    const jitter = Math.round(this.#random() * 6 * 3_600_000);
    life.stateSet('threads_at', new Date(now.getTime() - jitter).toISOString());
    return `moved ${moved}, finished ${finished}, started ${started}`;
  }
}
