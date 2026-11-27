// Phase 53: "Your story together". One dated timeline merged from what the app already keeps:
// milestones, decisions and promises (kept / open / not kept, from the memory ledger), dates that
// matter, projects started and finished (planner projects, workspaces with their first commit, pull
// requests her team opened, finished team tasks), highlights learned from imported history
// (labelled), and scrapbook moments. Nothing here is written by a model.
// "Look back": a background model call writes a warm look back over a date range from these facts
// only (exact words for quotes; says so kindly when little happened). Saved as a reflection memory
// (evidence "lookback:<from>..<to>") and shown as a card. A yearly look back on the anniversary of
// the first owner message is optional (Settings → You, off by default) and arrives like her other
// messages (quiet hours respected).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { languageLine, talkLanguage, appLanguage } from './i18n.ts';
import { complete, proactiveSettings, targetConversation } from './life.ts';
import type { Memory } from './memory.ts';
import { localDate } from './memory-worker.ts';
import { buildSystemPrompt } from './persona.ts';
import { zonedParts } from './planner.ts';
import { everyJob, type EveryJob } from './tick-jobs.ts';
import { checkClaims } from './receipts.ts';
import { detectMinorSexualContent, disclosureDue, disclosureText } from './safety.ts';
import type { Conversation } from './store.ts';
import { importedName } from './store.ts';
import { usageScope } from './usage.ts';

export type StoryKind = 'milestone' | 'decision' | 'promise' | 'date' | 'project' | 'moment';
export type StoryFilter = 'all' | 'milestones' | 'promises' | 'projects' | 'moments';
export const STORY_FILTERS: readonly StoryFilter[] = ['all', 'milestones', 'promises', 'projects', 'moments'];

/** Where an item opens: a conversation (at a message), a project, a workspace, a memory note, a scrapbook entry, a link. */
export type StoryOpen =
  | { type: 'conversation'; conversationId: string; messageId?: number | null }
  | { type: 'project'; projectId: number }
  | { type: 'workspace'; workspace: string }
  | { type: 'memory'; id: number }
  | { type: 'scrapbook'; id: number }
  | { type: 'url'; url: string };

export interface StoryItem {
  /** Stable id: "<source>:<id>". */
  id: string;
  kind: StoryKind;
  /** Local date, YYYY-MM-DD. */
  date: string;
  title: string;
  /** Short extra line (the owner's or her exact words, a project description…). */
  detail?: string;
  /** What kind of project event: started, finished, first commit, pull request, team task done. */
  event?: 'started' | 'finished' | 'first-commit' | 'pull-request' | 'team-done';
  /** Dates that matter: the date itself ("1990-11-14", or "11-14" every year); promises: when due. */
  on?: string;
  /** Promises: kept, still open, or not kept (due date passed, still open). */
  status?: 'kept' | 'open' | 'broken';
  /** Who promised: the owner or her (from the ledger wording). */
  who?: 'owner' | 'sara';
  /** Learned from imported history: the other assistant's name ("ChatGPT"). */
  imported?: string;
  /** Moments: who added it. */
  by?: 'owner' | 'sara';
  open?: StoryOpen;
}

export interface Lookback {
  id: number;
  from: string;
  to: string;
  text: string;
  createdOn: string;
}

/** Which filter an item belongs to. */
export function inFilter(item: StoryItem, f: StoryFilter): boolean {
  if (f === 'all') return true;
  if (f === 'milestones') return item.kind === 'milestone' || item.kind === 'decision' || item.kind === 'date';
  if (f === 'promises') return item.kind === 'promise';
  if (f === 'projects') return item.kind === 'project';
  return item.kind === 'moment';
}

/** First commit (or clone) time of a workspace's git repository, from .git/logs/HEAD; else the folder's creation. */
export function workspaceStart(dir: string): { at: Date; how: 'commit' | 'folder' } | undefined {
  try {
    const log = join(dir, '.git', 'logs', 'HEAD');
    if (existsSync(log)) {
      const first = readFileSync(log, 'utf8').split('\n').find((l) => l.trim());
      const m = first && /\s(\d{9,11})\s[+-]\d{4}\t/.exec(first);
      if (m) return { at: new Date(Number(m[1]) * 1000), how: 'commit' };
    }
    const st = statSync(dir);
    const t = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return { at: new Date(t), how: 'folder' };
  } catch {
    return undefined;
  }
}

/** Builds the whole timeline (oldest first). `from`/`to` (YYYY-MM-DD, inclusive) narrow it. */
export function gatherStory(app: AppContext, opts: { from?: string; to?: string; filter?: StoryFilter } = {}): StoryItem[] {
  const s = app.settings.get();
  const tz = s.timeZone;
  const today = localDate(app.now().toISOString(), tz);
  const day = (iso: string) => localDate(iso, tz);
  const items: StoryItem[] = [];
  const convOf = (id: string | null) => (id ? app.store.getConversation(id) : undefined);

  // Memory ledger: milestones, decisions, promises, dates that matter. Never from other people's chats.
  const mem = app.memory;
  if (mem) {
    for (const m of mem.listAll()) {
      if (m.supersededBy !== null) continue;
      if (m.kind !== 'milestone' && m.kind !== 'decision' && m.kind !== 'promise' && m.kind !== 'date') continue;
      const conv = convOf(m.conversationId);
      if (conv?.partner) continue;
      const imported = importedName(conv?.channel);
      const item: StoryItem = {
        id: `memory:${m.id}`,
        kind: m.kind,
        date: m.happenedOn,
        title: m.content,
        ...(m.evidence && m.evidence !== 'You added this.' ? { detail: m.evidence } : {}),
        ...(imported ? { imported } : {}),
        ...(m.onDate && (m.kind === 'date' || m.kind === 'promise') ? { on: m.onDate } : {}),
        open: conv ? { type: 'conversation', conversationId: conv.id, messageId: m.sourceMessageId } : { type: 'memory', id: m.id },
      };
      if (m.kind === 'promise') {
        item.status = m.resolvedAt ? 'kept' : m.onDate && /^\d{4}-\d{2}-\d{2}$/.test(m.onDate) && m.onDate < today ? 'broken' : 'open';
        item.who = m.content.startsWith(app.persona.name) || /^(Sara|She|He|They)\b/.test(m.content) ? 'sara' : 'owner';
      }
      items.push(item);
    }
  }

  // Projects: planner projects (started; finished = archived).
  for (const p of app.planner?.projects(true) ?? []) {
    items.push({ id: `project:${p.id}:start`, kind: 'project', event: 'started', date: day(p.createdAt), title: p.name, ...(p.description ? { detail: p.description } : {}), open: { type: 'project', projectId: p.id } });
    if (p.status === 'archived') items.push({ id: `project:${p.id}:done`, kind: 'project', event: 'finished', date: day(p.updatedAt), title: p.name, open: { type: 'project', projectId: p.id } });
  }
  // Workspaces with a git repository: the first commit.
  const wsRoot = join(app.rootDir ?? app.dataDir, 'workspaces');
  if (existsSync(wsRoot)) {
    for (const d of readdirSync(wsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(wsRoot, d.name);
      if (!existsSync(join(dir, '.git'))) continue;
      const st = workspaceStart(dir);
      if (st) items.push({ id: `workspace:${d.name}`, kind: 'project', event: 'first-commit', date: day(st.at.toISOString()), title: d.name, open: { type: 'workspace', workspace: d.name } });
    }
  }
  // Team tasks: finished ones, and pull requests her team opened.
  for (const task of app.team?.list(500) ?? []) {
    const conv = convOf(task.conversationId);
    if (conv?.partner) continue;
    const when = day(task.endedAt ?? task.createdAt);
    if (task.status === 'done') items.push({ id: `team:${task.id}`, kind: 'project', event: 'team-done', date: when, title: task.goal.split('\n')[0].slice(0, 200), detail: task.workspace, open: conv ? { type: 'conversation', conversationId: conv.id } : { type: 'workspace', workspace: task.workspace } });
    if (task.workflow?.prUrl) items.push({ id: `pr:${task.id}`, kind: 'project', event: 'pull-request', date: when, title: task.workflow.issue?.title ?? task.goal.split('\n')[0].slice(0, 200), detail: task.workflow.prUrl, open: { type: 'url', url: task.workflow.prUrl } });
  }

  // Scrapbook: moments and inside jokes (photos stay in the scrapbook's own photo wall).
  for (const e of app.scrapbook?.list({ limit: 2000 }) ?? []) {
    if (e.kind === 'photo' && !e.text) continue;
    if (e.conversationId && convOf(e.conversationId)?.partner) continue;
    items.push({ id: `scrapbook:${e.id}`, kind: 'moment', date: day(e.createdAt), title: e.text || e.note, ...(e.note && e.text ? { detail: e.note } : {}), by: e.addedBy, open: e.conversationId && e.messageId ? { type: 'conversation', conversationId: e.conversationId, messageId: e.messageId } : { type: 'scrapbook', id: e.id } });
  }

  const f = opts.filter ?? 'all';
  return items
    .filter((i) => (!opts.from || i.date >= opts.from) && (!opts.to || i.date <= opts.to) && inFilter(i, f))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Look backs she wrote before (newest first). */
export function lookbacks(app: AppContext): Lookback[] {
  return (app.memory?.list({ kind: 'reflection', limit: 200 }) ?? [])
    .filter((m) => m.evidence?.startsWith('lookback:'))
    .map((m: Memory) => {
      const [from, to] = m.evidence!.slice(9).split('..');
      return { id: m.id, from, to, text: m.content, createdOn: m.happenedOn };
    });
}

const EVENT_WORDS: Record<NonNullable<StoryItem['event']>, string> = { started: 'project started', finished: 'project finished', 'first-commit': 'first commit in workspace', 'pull-request': 'pull request opened', 'team-done': 'team task finished' };

/** The facts for the model, one line each, with exact words where we have them. */
export function storyFacts(items: StoryItem[]): string {
  return items
    .map((i) => {
      const what =
        i.kind === 'project'
          ? `${EVENT_WORDS[i.event ?? 'started']}: ${i.title}`
          : i.kind === 'promise'
            ? `promise (${i.status === 'kept' ? 'kept' : i.status === 'broken' ? 'not kept by its date' : 'still open'}): ${i.title}`
            : i.kind === 'moment'
              ? `moment in the scrapbook${i.by === 'sara' ? ' (you added it)' : ''}: ${i.title}`
              : `${i.kind === 'date' ? 'date that matters (written down that day)' : i.kind}: ${i.title}`;
      // The day an item was noted isn't the date it is about (a birthday noted in October is still in November).
      const on = i.on ? (i.kind === 'date' ? ` (the date itself: ${i.on})` : ` (due ${i.on})`) : '';
      const words = i.detail && i.kind !== 'project' ? ` — exact words: "${i.detail.replace(/\s+/g, ' ').slice(0, 240)}"` : '';
      return `- ${i.date} ${what}${on}${i.imported ? ` (from the owner's imported ${i.imported} history, before you knew each other)` : ''}${words}`;
    })
    .join('\n');
}

/** Quoted passages (3+ words) in a text. */
const quotes = (text: string) => [...text.matchAll(/[“"«„]([^”"»“]{8,300})[”"»“]/g)].map((m) => m[1].trim()).filter((q) => q.split(/\s+/).length >= 3);
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Drops sentences whose quotes aren't word-for-word in the facts (the exact-words rule). */
export function keepTrueQuotes(text: string, facts: string): { text: string; dropped: number } {
  const hay = squash(facts);
  let dropped = 0;
  const paras = text.split(/\n+/).map((p) =>
    p
      .split(/(?<=[.!?…])\s+/)
      .filter((sentence) => {
        const bad = quotes(sentence).some((q) => !hay.includes(squash(q)));
        if (bad) dropped++;
        return !bad;
      })
      .join(' ')
      .trim(),
  );
  return { text: paras.filter(Boolean).join('\n\n'), dropped };
}

/** Empty range: no model call (nothing to invent from). */
export function emptyLookback(owner: string, from: string, to: string): string {
  return `Looking back from ${from} to ${to}, I don't have much written down for us yet: no milestones, promises, projects or saved moments in that time. That's okay. Quiet stretches count too, and I'd love to hear what that time was like for you, ${owner}.`;
}

function rangeWords(from: string, to: string): string {
  return `${from} to ${to}`;
}

/** Writes a look back over a range (facts only), saves it as a reflection memory and returns it. */
export async function writeLookback(app: AppContext, range: { from: string; to: string }, opts: { yearly?: boolean } = {}): Promise<Lookback> {
  return usageScope.run({ purpose: 'look-back' }, async () => {
    const s = app.settings.get();
    const tz = s.timeZone;
    const owner = s.ownerName?.trim() || 'you';
    const items = gatherStory(app, range);
    const facts = storyFacts(items);
    let text = '';
    if (!items.length) text = emptyLookback(owner, range.from, range.to);
    else {
      const conv: Conversation = targetConversation(app) ?? ({ id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: false, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null } as unknown as Conversation);
      const system = buildSystemPrompt(app.persona, { now: app.now(), timeZone: tz, ownerName: s.ownerName, memory: false, language: languageLine(talkLanguage(s)) });
      const few = items.length < 4;
      const note = `[Note from the app, not from ${owner}: ${opts.yearly ? `it's the anniversary of the first time you and ${owner} talked, and ${owner} asked for a yearly look back` : `${owner} asked you to look back over your time together`} (${rangeWords(range.from, range.to)}). Write it as a message from you to ${owner}: warm, personal and specific, in your own voice, a few short paragraphs, roughly in time order, ending with something you look forward to.
Rules:
- Use ONLY the facts below. Never invent events, places, feelings ${owner} had, people, numbers or details that aren't there. If a fact is short, keep it short.
- Quotes: only put words in quotation marks if they appear word for word in the facts ("exact words"); otherwise say it in your own words without quotation marks.
- Promises: celebrate kept ones; mention open ones gently; a promise not kept by its date gets no blame, just a kind word or an offer to pick it up again.
- Items from imported history happened before you knew each other: say so if you mention them.
${few ? `- Not much is written down for this time (${items.length} item${items.length === 1 ? '' : 's'}). Say so kindly and honestly, don't stretch it, and don't make the time sound empty or like a failure.\n` : ''}- Don't mention this note or "the facts".
Facts (oldest first):
${facts}]`;
      try {
        text = (await complete(app, conv, [{ role: 'system', content: system }, { role: 'user', content: note }], 900, 'planning')).trim();
      } catch (err) {
        console.warn(`look back: model failed: ${(err as Error).message}`);
      }
      if (text) text = keepTrueQuotes(text, facts).text;
      if (!text || text.length > 6000 || checkClaims(text, []).length || detectMinorSexualContent(text)) text = plainLookback(items, range);
    }
    const today = localDate(app.now().toISOString(), tz);
    const m = app.memory?.add({ kind: 'reflection', content: app.redactor.redact(text), conversationId: null, sourceMessageId: null, happenedOn: today, evidence: `lookback:${range.from}..${range.to}` });
    return { id: m?.id ?? 0, from: range.from, to: range.to, text, createdOn: today };
  });
}

/** Without a model: the facts as a short list (never invented). */
export function plainLookback(items: StoryItem[], range: { from: string; to: string }): string {
  const count = (k: StoryKind) => items.filter((i) => i.kind === k).length;
  const lines = [`Our time from ${range.from} to ${range.to}:`];
  const add = (label: string, k: StoryKind) => {
    const xs = items.filter((i) => i.kind === k).slice(0, 8);
    if (xs.length) lines.push(`${label} (${count(k)}):\n${xs.map((i) => `- ${i.date}: ${i.title}${i.status ? ` (${i.status === 'broken' ? 'not kept yet' : i.status})` : ''}`).join('\n')}`);
  };
  add('Milestones', 'milestone');
  add('Decisions', 'decision');
  add('Promises', 'promise');
  add('Projects', 'project');
  add('Moments', 'moment');
  return lines.join('\n\n');
}

/** The local date one year before `day` (Feb 29 → Feb 28). */
export function yearBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y - 1, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

/** Days between two local dates (b - a). */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Yearly look back: on the anniversary of the first owner message (up to 7 days late if missed), once a year. */
export class StoryWorker {
  readonly #app: AppContext;
  #timer: EveryJob | undefined;
  #running = false;
  /** The on-demand look back running now (one at a time). */
  pending: Promise<Lookback> | undefined;
  lastError: string | undefined;

  constructor(app: AppContext) {
    this.#app = app;
  }

  start(intervalMs = 30 * 60_000): void {
    this.#timer = everyJob('story', intervalMs, () => this.tick());
  }

  stop(): void {
    this.#timer?.stop();
  }

  /** Starts an on-demand look back in the background (or returns the running one). */
  request(range: { from: string; to: string }): Promise<Lookback> {
    if (this.pending) return this.pending;
    this.lastError = undefined;
    const run = writeLookback(this.#app, range)
      .then((lb) => {
        this.#app.events?.publish({ type: 'story', what: 'lookback', id: lb.id });
        return lb;
      })
      .catch((err: Error) => {
        this.lastError = err.message;
        this.#app.events?.publish({ type: 'story', what: 'lookback', error: err.message });
        throw err;
      })
      .finally(() => {
        this.pending = undefined;
      });
    run.catch(() => {});
    this.pending = run;
    return run;
  }

  /** Sends the yearly look back if it's the day (and not quiet hours). Returns the text when sent. */
  async tick(): Promise<string | undefined> {
    const app = this.#app;
    const s = app.settings.get();
    if (!s.story?.yearly || this.#running || s.companion?.on === false) return undefined;
    const first = app.store.firstOwnerMessageAt();
    if (!first) return undefined;
    const tz = s.timeZone;
    const now = app.now();
    const today = localDate(now.toISOString(), tz);
    const firstDay = localDate(first.toISOString(), tz);
    const year = Number(today.slice(0, 4));
    // This year's anniversary (Feb 29 → Feb 28 in other years).
    let anniversary = `${year}-${firstDay.slice(5)}`;
    if (Number.isNaN(Date.parse(`${anniversary}T00:00:00Z`)) || new Date(`${anniversary}T00:00:00Z`).getUTCMonth() + 1 !== Number(firstDay.slice(5, 7))) anniversary = `${year}-02-28`;
    const late = daysBetween(anniversary, today);
    if (year <= Number(firstDay.slice(0, 4)) || late < 0 || late > 7 || (s.story.lastYear ?? 0) >= year) return undefined;
    // Quiet hours: the same as her own messages.
    const q = proactiveSettings(app);
    const h = zonedParts(now, tz).h;
    const quiet = q.quietStart > q.quietEnd ? h >= q.quietStart || h < q.quietEnd : h >= q.quietStart && h < q.quietEnd;
    if (quiet) return undefined;
    this.#running = true;
    try {
      const lb = await writeLookback(app, { from: yearBefore(anniversary), to: today }, { yearly: true });
      app.settings.update({ story: { ...app.settings.get().story, lastYear: year } });
      const conv = targetConversation(app) ?? app.store.listConversations().find((c) => !c.partner) ?? app.store.createConversation({ title: 'Our year' });
      if (disclosureDue(app.store.lastDisclosureAt(), now)) {
        const text = disclosureText(app.persona.name, appLanguage(app.settings.get()));
        const n = app.store.addMessage(conv.id, 'notice', `disclosure:${text}`);
        app.events?.publish({ type: 'message', conversationId: conv.id, message: { ...n, content: text, meta: { kind: 'disclosure' } }, reason: 'proactive' });
      }
      const msg = app.store.addMessage(conv.id, 'assistant', lb.text, { lookback: { id: lb.id, from: lb.from, to: lb.to } });
      app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'proactive' });
      return lb.text;
    } finally {
      this.#running = false;
    }
  }
}
