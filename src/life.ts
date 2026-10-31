// Phase 4: Sara's own life between conversations.
// - Her day: once per local day she "has" a small, ordinary day consistent with who she is and
//   with what she said before (one short background model call per day, not per message).
// - Proactive messages: now and then she texts first, like a person would. Rate-limited, quiet
//   hours, never double-texts, owner-tunable, AI disclosure still applies.
import { guard } from './log.ts';
import { appLanguage, languageLine, talkLanguage } from './i18n.ts';
import type { DatabaseSync } from 'node:sqlite';
import { bondContext, fallbackAfterMs, promptChars, historyFrom, innerEnabled, resolveChain, streamWithin, type AppContext } from './chat.ts';
import type { RoutePurpose } from './settings.ts';
import { awayLine, CONFLICT } from './bond.ts';
import { lifeLines } from './traits.ts';
import { describeInner, type InnerStore } from './inner.ts';
import { followUps, datesNote, selectMemories } from './memory.ts';
import { isForgotten, localDate } from './memory-worker.ts';
import { buildSystemPrompt } from './persona.ts';
import { dayStartUtc, zonedParts } from './planner.ts';
import type { ChatMessage } from './providers/types.ts';
import { checkClaims } from './receipts.ts';
import { detectMinorSexualContent, disclosureDue, disclosureText } from './safety.ts';
import { personalize } from './identity.ts';
import { identityOf } from './persona.ts';
import type { Conversation } from './store.ts';
import { usageScope } from './usage.ts';

export interface ProactiveSettings {
  enabled: boolean;
  maxPerDay: number;
  /** Local hours; no messages from quietStart until quietEnd (wraps midnight). */
  quietStart: number;
  quietEnd: number;
  /** Minimum hours since the owner's last message (and since her last proactive message). */
  minGapHours: number;
}

export const DEFAULT_PROACTIVE: ProactiveSettings = { enabled: true, maxPerDay: 2, quietStart: 22, quietEnd: 9, minGapHours: 6 };

export function proactiveSettings(app: AppContext): ProactiveSettings {
  return { ...DEFAULT_PROACTIVE, ...app.settings.get().proactive };
}

const DAY_MAX_TOKENS = 350;
const MSG_MAX_TOKENS = 220;
const CALL_TIMEOUT_MS = 90_000;

/**
 * One background-model call (her day, proactive messages, briefings). Phase 38: `job` picks the
 * model (planning, quick, writing…; each falls back to the background model), and if it fails or
 * is slow before answering, the next model in its chain takes over.
 */
export async function complete(app: AppContext, conv: Conversation, messages: ChatMessage[], maxTokens: number, job: RoutePurpose = 'background', stop?: AbortSignal): Promise<string> {
  const chain = resolveChain(app, conv, job);
  let lastErr: unknown;
  for (const [i, { provider, model }] of chain.entries()) {
    let out = '';
    try {
      // Phase 103: her plans' off switch stops a call that is running (`stop`).
      const signal = stop ? AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), stop]) : AbortSignal.timeout(CALL_TIMEOUT_MS);
      for await (const ev of streamWithin((sig) => provider.stream({ model, messages, temperature: 0.8, maxTokens, reasoning: 'none', signal: sig }), signal, fallbackAfterMs(app, { provider, promptChars: promptChars(messages) }))) {
        if (ev.type === 'text') out += ev.text;
        if (out.length > maxTokens * 8) break;
      }
      return out.trim();
    } catch (err) {
      if (out) return out.trim();
      lastErr = err;
      if (i < chain.length - 1) console.warn(`fallback (${job}): ${provider.config.label} (${model}) failed: ${(err as Error).message}; trying ${chain[i + 1].provider.config.label} (${chain[i + 1].model})`);
    }
  }
  throw lastErr;
}

export type ThreadStatus = 'active' | 'done';
export interface ThreadNote {
  day: string;
  text: string;
}
export interface LifeThread {
  id: number;
  title: string;
  notes: ThreadNote[];
  status: ThreadStatus;
  /** Added by the owner (personalization), not invented by her. */
  byOwner: boolean;
  startedOn: string;
  updatedOn: string;
}

/** Her active threads as prompt lines. */
export function threadsNote(life: LifeStore | undefined): string | undefined {
  const active = life?.threads('active') ?? [];
  if (!active.length) return undefined;
  return active.map((t) => `- ${t.title}${t.notes.length ? ` (lately: ${t.notes.at(-1)!.text})` : ''}`).join('\n');
}

export class LifeStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS sara_days (day TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL)');
    // Phase 12: her ongoing life threads (a book, a hobby, a little project), progressing over weeks.
    db.exec(`CREATE TABLE IF NOT EXISTS sara_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      by_owner INTEGER NOT NULL DEFAULT 0,
      started_on TEXT NOT NULL,
      updated_on TEXT NOT NULL
    )`);
    db.exec('CREATE TABLE IF NOT EXISTS sara_life_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  threads(status?: ThreadStatus): LifeThread[] {
    const rows = (status ? this.#db.prepare('SELECT * FROM sara_threads WHERE status = ? ORDER BY id').all(status) : this.#db.prepare('SELECT * FROM sara_threads ORDER BY status, id DESC').all()) as Record<string, string | number>[];
    return rows.map((r) => ({ id: Number(r.id), title: String(r.title), notes: JSON.parse(String(r.notes)) as ThreadNote[], status: r.status as ThreadStatus, byOwner: Boolean(r.by_owner), startedOn: String(r.started_on), updatedOn: String(r.updated_on) }));
  }

  thread(id: number): LifeThread | undefined {
    return this.threads().find((t) => t.id === id);
  }

  addThread(title: string, day: string, opts: { note?: string; byOwner?: boolean } = {}): LifeThread {
    const notes: ThreadNote[] = opts.note ? [{ day, text: opts.note }] : [];
    const r = this.#db.prepare('INSERT INTO sara_threads (title, notes, by_owner, started_on, updated_on) VALUES (?, ?, ?, ?, ?)').run(title.slice(0, 200), JSON.stringify(notes), opts.byOwner ? 1 : 0, day, day);
    return this.thread(Number(r.lastInsertRowid))!;
  }

  updateThread(id: number, patch: { title?: string; note?: { day: string; text: string }; status?: ThreadStatus }): LifeThread | undefined {
    const t = this.thread(id);
    if (!t) return undefined;
    const notes = patch.note ? [...t.notes, { day: patch.note.day, text: patch.note.text.slice(0, 400) }].slice(-12) : t.notes;
    this.#db
      .prepare('UPDATE sara_threads SET title = ?, notes = ?, status = ?, updated_on = ? WHERE id = ?')
      .run((patch.title ?? t.title).slice(0, 200), JSON.stringify(notes), patch.status ?? t.status, patch.note?.day ?? t.updatedOn, id);
    return this.thread(id);
  }

  deleteThread(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM sara_threads WHERE id = ?').run(id).changes) > 0;
  }

  /** Small saved values (e.g. when her threads last moved on). */
  stateGet(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM sara_life_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  stateSet(key: string, value: string): void {
    this.#db.prepare('INSERT INTO sara_life_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  get(day: string): string | undefined {
    return (this.#db.prepare('SELECT content FROM sara_days WHERE day = ?').get(day) as { content: string } | undefined)?.content;
  }

  set(day: string, content: string, at: Date): void {
    this.#db.prepare('INSERT INTO sara_days (day, content, created_at) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET content = excluded.content').run(day, content, at.toISOString());
  }

  recent(limit = 7): { day: string; content: string }[] {
    return this.#db.prepare('SELECT day, content FROM sara_days ORDER BY day DESC LIMIT ?').all(limit) as { day: string; content: string }[];
  }

  delete(day: string): boolean {
    return Number(this.#db.prepare('DELETE FROM sara_days WHERE day = ?').run(day).changes) > 0;
  }
}

/** Most recent chat conversation (where she'd text him). */
export function targetConversation(app: AppContext): Conversation | undefined {
  return app.store.listConversations().find((c) => c.mode === 'chat' && !c.partner);
}

export function dayPrompt(app: AppContext, recentDays: { day: string; content: string }[], selfFacts: string[], weekday: string, weekend: boolean, threads = ''): string {
  const p = app.persona;
  const id = identityOf(p);
  // Built-in wording is written for she/her; the character's own text is inserted after.
  const t = (x: string) => personalize(x, id);
  return `Write ${p.name}'s day for today, ${weekday} (${weekend ? 'the weekend' : 'a weekday'}). ${p.name} is ${p.age}. ${p.summary}
${t('Who she is')}:
${p.background.map((x) => `- ${x}`).join('\n')}
Personality: ${p.personality.join(' ')}
${lifeLines(p.life).length ? `${t('Her life')} (stay consistent: same job, people, places and hobbies):\n${lifeLines(p.life).map((x) => `- ${x}`).join('\n')}\n` : ''}${recentDays.length ? `${t('Her')} last few days (do NOT repeat them; today needs new specifics, and continue one small thing from them, like how something from yesterday turned out):\n${recentDays.map((d) => `- ${d.day}: ${d.content}`).join('\n')}\n` : ''}${selfFacts.length ? `${t('Things she has said about her life')} (stay consistent):\n${selfFacts.map((x) => `- ${x}`).join('\n')}\n` : ''}${threads ? `${t('Her ongoing things')} (she may spend a little time on one today; keep them consistent):\n${threads}\n` : ''}
${t(`Write 3 to 5 short sentences in her own voice, first person, about her ordinary day: what she did this morning and what she plans for the afternoon and evening. Small, specific, believable things that fit who she is and the day of the week: errands, cooking something, a friend or family member by name, a run or a walk, a song or show, a little project, a small annoyance. Vary it: pick things she didn't do recently.
Rules: this is her private life only. Do not mention conversations, chats, messages, "we", or anyone she talks to online, and no work she does with or for someone else. Nothing dramatic. Never mention AI or software about herself. Plain text only.`)}`;
}

export class LifeWorker {
  readonly #app: AppContext;
  readonly #life: LifeStore;
  readonly #inner: InnerStore;
  readonly #random: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  /** No proactive retry before this time (after a SKIP or an error). */
  #holdUntil = 0;

  constructor(app: AppContext, life: LifeStore, inner: InnerStore, random: () => number = Math.random) {
    this.#app = app;
    this.#life = life;
    this.#inner = inner;
    this.#random = random;
  }

  start(intervalMs = 10 * 60_000): void {
    this.#timer = setInterval(() => guard('her life', () => this.tick()), intervalMs);
    this.#timer.unref();
    setTimeout(() => guard('her life', () => this.tick()), 30_000).unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  tick(): Promise<{ day?: string; proactive?: string; skipped?: string; agenda?: import('./agenda.ts').TickResult }> {
    return usageScope.run({ purpose: 'her-life' }, () => this.#tick());
  }

  async #tick(): Promise<{ day?: string; proactive?: string; skipped?: string; agenda?: import('./agenda.ts').TickResult }> {
    // Phase 103 (ST8): with her plans on, one agenda step per tick (before her spontaneous message,
    // under the same daily cap). With them off nothing here runs and the old behaviour is unchanged.
    const agendaOn = Boolean(this.#app.agenda?.enabled());
    if (this.#running || (!innerEnabled(this.#app) && !agendaOn)) return {};
    this.#running = true;
    try {
      const agenda = agendaOn
        ? await this.#app.agenda!.tick().catch((err: Error): import('./agenda.ts').TickResult => {
            console.warn(`life: her plans failed: ${err.message}`);
            return { skipped: `error: ${err.message}` };
          })
        : undefined;
      if (!innerEnabled(this.#app)) return { ...(agenda ? { agenda } : {}) };
      const day = await this.ensureToday().catch((err: Error) => {
        console.warn(`life: day note failed: ${err.message}`);
        return undefined;
      });
      if (agenda?.sent) return { ...(day ? { day } : {}), agenda };
      const pro = await this.maybeProactive().catch((err: Error) => {
        console.warn(`life: proactive message failed: ${err.message}`);
        this.#holdUntil = this.#app.now().getTime() + 60 * 60_000;
        return { skipped: `error: ${err.message}` };
      });
      return { ...(day ? { day } : {}), ...pro, ...(agenda ? { agenda } : {}) };
    } finally {
      this.#running = false;
    }
  }

  /** Her day note for today (generated once, after 6 am local). */
  async ensureToday(): Promise<string | undefined> {
    const app = this.#app;
    const tz = app.settings.get().timeZone;
    const now = app.now();
    const today = localDate(now.toISOString(), tz);
    const existing = this.#life.get(today);
    if (existing) return existing;
    if (zonedParts(now, tz).h < 6) return undefined;
    const conv = targetConversation(app) ?? app.store.listConversations()[0];
    if (!conv || !app.store.firstOwnerMessageAt()) return undefined;
    const recentDays = this.#life.recent(3).reverse();
    const selfFacts = app.memory?.list({ kind: 'self', limit: 8 }).map((m) => m.content) ?? [];
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(now);
    const wd = zonedParts(now, tz).wd;
    const text = await complete(app, conv, [{ role: 'user', content: dayPrompt(app, recentDays, selfFacts, weekday, wd === 0 || wd === 6, threadsNote(this.#life) ?? '') }], DAY_MAX_TOKENS, 'writing');
    const clean = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\n{3,}/g, '\n\n').slice(0, 1200).trim();
    if (clean.length < 20 || /\b(as an ai|language model)\b/i.test(clean)) return undefined;
    // Her day is her own: drop sentences that invent shared history with the owner.
    const owner = app.settings.get().ownerName?.trim();
    const own = clean
      .split(/(?<=[.!?])\s+/)
      .filter((x) => !/\b(we|us|our)\b|\b(talked|chatted|messaged|texted) about\b/i.test(x) && !(owner && new RegExp(`\\b${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(x)))
      .join(' ');
    if (own.length < 20) return undefined;
    this.#life.set(today, own, now);
    return own;
  }

  /** Sends one proactive message if everything lines up. */
  async maybeProactive(): Promise<{ proactive?: string; skipped?: string }> {
    const app = this.#app;
    const cfg = proactiveSettings(app);
    if (!cfg.enabled) return { skipped: 'off' };
    const s = app.settings.get();
    const tz = s.timeZone;
    const now = app.now();
    if (now.getTime() < this.#holdUntil) return { skipped: 'hold' };
    const h = zonedParts(now, tz).h;
    const quiet = cfg.quietStart > cfg.quietEnd ? h >= cfg.quietStart || h < cfg.quietEnd : h >= cfg.quietStart && h < cfg.quietEnd;
    if (quiet) return { skipped: 'quiet hours' };
    const state = this.#inner.get(now);
    const today = localDate(now.toISOString(), tz);
    const sentToday = state.proactiveDay === today ? state.proactiveCount : 0;
    if (sentToday >= cfg.maxPerDay) return { skipped: 'daily limit' };
    const lastOwner = app.store.lastOwnerMessageAt();
    if (!lastOwner) return { skipped: 'never talked' };
    const gapH = (now.getTime() - lastOwner.getTime()) / 3_600_000;
    if (gapH < cfg.minGapHours) return { skipped: 'talked recently' };
    if (state.lastProactiveAt && (now.getTime() - new Date(state.lastProactiveAt).getTime()) / 3_600_000 < cfg.minGapHours) return { skipped: 'texted recently' };
    const conv = targetConversation(app);
    if (!conv) return { skipped: 'no chat' };
    if (app.isBusy?.(conv.id)) return { skipped: 'busy' };
    const msgs = app.store.messages(conv.id).filter((m) => !isForgotten(m) && m.role !== 'notice');
    const last = msgs.at(-1);
    // Never double-text: if her last proactive message is still unanswered, wait.
    if (last?.role === 'assistant' && last.meta?.proactive) return { skipped: 'unanswered' };
    // Phase 12: a date that matters is today and she hasn't brought it up yet.
    const dateToday = app.memory?.upcoming(today, 0).find((u) => u.memory.mentionedOn !== today)?.memory;
    // Phase 37: something that just happened in the owner's life, not followed up yet (she asks how it went).
    const followUp = dateToday ? undefined : app.memory ? followUps(app.memory, today, (day) => app.store.ownerMessagesSince(dayStartUtc(day, app.settings.get().timeZone).toISOString())).find((p) => !p.memory.mentionedOn || p.memory.mentionedOn < p.date) : undefined;
    // Don't fire the instant she becomes eligible; feel less like a timer.
    if (!dateToday && !followUp && this.#random() > 0.25) return { skipped: 'not this time' };

    const owner = s.ownerName?.trim() || 'the owner';
    const agenda = app.planner?.agenda(now, tz) ?? '';
    const reason = dateToday
      ? `Today is a date that matters to ${owner}: ${dateToday.content}.`
      : followUp
        ? `${followUp.daysAgo === 1 ? 'Yesterday' : `${followUp.daysAgo} days ago`} ${owner} had this coming up: ${followUp.memory.content}. You remember, and you want to know how it went.`
        : h < 12 && agenda.includes('due today')
        ? `It's morning and ${owner} has things due today.`
        : gapH >= 24
          ? `You haven't heard from ${owner} in ${Math.round(gapH / 24)} day${gapH >= 48 ? 's' : ''}.`
          : `${owner} has been quiet for a few hours and something made you think of them.`;
    const lastSummary = app.memory?.list({ kind: 'summary', limit: 1 })[0]?.content ?? '';
    const injection = app.memory ? selectMemories(app.memory, { userText: `${lastSummary} ${agenda}`, conversationId: '', oldestHistoryId: Number.MAX_SAFE_INTEGER, budgetChars: 1200, notes: false }) : undefined;
    const system = buildSystemPrompt(app.persona, {
      now,
      timeZone: tz,
      ownerName: s.ownerName,
      memories: injection?.text,
      agenda: agenda || undefined,
      inner: describeInner(state, now, tz, owner, { gapHours: gapH, daysKnown: null, away: awayLine(app.persona.away), conflict: app.persona.conflict ? CONFLICT[app.persona.conflict]?.line : undefined }),
      day: this.#life.get(today),
      dates: app.memory ? datesNote(app.memory, today) : undefined,
      threads: threadsNote(this.#life),
      ...bondContext(app, state.closeness),
      language: languageLine(talkLanguage(s, app.store.ownerMessagesSince(new Date(now.getTime() - 7 * 86_400_000).toISOString())[0])),
    });
    const note = `[Note from the app, not from ${owner}: ${owner} hasn't written for ${gapH < 48 ? `${Math.round(gapH)} hours` : `${Math.round(gapH / 24)} days`}. ${reason} You decide to text ${owner} first, the way someone close would. Write only the message: 1 to 3 short, natural sentences, specific to something real (your day, something from your memories, or the list). No greeting card tone, no questions stacked up, don't mention this note. If nothing feels natural to send right now, reply with exactly SKIP.]`;
    const history = historyFrom(msgs.slice(-20)).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content.trim())).map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
    const text = (await complete(app, conv, [{ role: 'system', content: system }, ...history, { role: 'user', content: note }], MSG_MAX_TOKENS, 'quick')).replace(/^["']|["']$/g, '').trim();

    if (!text || /^skip\b/i.test(text) || text.length > 1200) {
      this.#holdUntil = now.getTime() + 2 * 60 * 60_000;
      return { skipped: 'model chose not to' };
    }
    // Same honesty and safety rules as any reply: no unbacked action claims, no minor content.
    if (checkClaims(text, []).length || detectMinorSexualContent(text, { fromHer: true })) {
      this.#holdUntil = now.getTime() + 2 * 60 * 60_000;
      return { skipped: 'failed checks' };
    }
    if (disclosureDue(app.store.lastDisclosureAt(), now)) {
      const n = app.store.addMessage(conv.id, 'notice', `disclosure:${disclosureText(app.persona.name, appLanguage(app.settings.get()))}`);
      app.events?.publish({ type: 'message', conversationId: conv.id, message: { ...n, content: disclosureText(app.persona.name, appLanguage(app.settings.get())), meta: { kind: 'disclosure' } }, reason: 'proactive' });
    }
    const msg = app.store.addMessage(conv.id, 'assistant', app.redactor.redact(text), { proactive: { reason } });
    if (dateToday) app.memory?.markMentioned(dateToday.id, today);
    if (followUp) app.memory?.markMentioned(followUp.memory.id, today);
    this.#inner.save({ ...this.#inner.get(now), lastProactiveAt: now.toISOString(), proactiveDay: today, proactiveCount: sentToday + 1 });
    app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'proactive' });
    return { proactive: msg.content };
  }
}
