// Gmail organizing: archive, read/unread, star, important, labels, trash and spam over a Gmail
// search or a list of ids, at any size, with an undo log. Never deletes anything for good (Gmail's
// own trash empties itself after 30 days; Sara has no permanent-delete path at all).
//
// How a change runs: the search is turned into ids by paging users.messages.list (500 a page; the
// API's resultSizeEstimate is unreliable, so the count IS the paged ids, stopped at the cap), then
// label changes go through users.messages.batchModify 1,000 ids at a time; trash/untrash (which
// batchModify can't do) go message by message, four at once. 429 and 5xx answers back off and try
// again. Every finished change is written to `gmail_actions` (which ids, which labels) so Undo
// reverses exactly those messages for 30 days.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { GoogleApiError, header, type GmailPart, type GoogleAccount } from './google.ts';
import { exactDates, gmailDates } from './gmail-dates.ts';
import type { JobManager } from './jobs.ts';
import type { ApprovalDetail } from './tools/types.ts';
import { cardFor } from './cards.ts';
import { forgetTodayMail } from './today.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const GMAIL_ACTIONS = ['archive', 'read', 'unread', 'star', 'unstar', 'important', 'not_important', 'label', 'unlabel', 'trash', 'untrash', 'spam', 'not_spam'] as const;
export type GmailAction = (typeof GMAIL_ACTIONS)[number];
/** The most messages one approved change touches; more needs another OK. */
export const ORGANIZE_CAP = 50_000;
/** Bigger changes run as a background task (progress above the chat, Stop). */
export const BACKGROUND_OVER = 2_000;
export const UNDO_DAYS = 30;
/** Trash and spam ask every time, even when the owner set the tool to run on its own. */
export const ALWAYS_ASK: ReadonlySet<string> = new Set(['trash', 'spam']);
export const RECONNECT_TEXT = 'Reconnect Google in Settings → Abilities → Gmail and Calendar ("Reconnect to allow organizing") to let me organize your mail. Your current sign-in only lets me read and draft. Nothing was changed.';

/** The verbs for messages and the card ("Archive 4,213 emails …"). */
export const ACTION_WORDS: Record<GmailAction, { verb: string; done: string; ing: string }> = {
  archive: { verb: 'Archive', done: 'archived', ing: 'Archiving' },
  read: { verb: 'Mark as read', done: 'marked as read', ing: 'Marking as read' },
  unread: { verb: 'Mark as unread', done: 'marked as unread', ing: 'Marking as unread' },
  star: { verb: 'Star', done: 'starred', ing: 'Starring' },
  unstar: { verb: 'Unstar', done: 'unstarred', ing: 'Unstarring' },
  important: { verb: 'Mark as important', done: 'marked as important', ing: 'Marking as important' },
  not_important: { verb: 'Mark as not important', done: 'marked as not important', ing: 'Marking as not important' },
  label: { verb: 'Add a label to', done: 'labelled', ing: 'Labelling' },
  unlabel: { verb: 'Remove a label from', done: 'unlabelled', ing: 'Removing the label' },
  trash: { verb: 'Move to trash', done: 'moved to trash', ing: 'Moving to trash' },
  untrash: { verb: 'Take out of trash', done: 'taken out of trash', ing: 'Taking out of trash' },
  spam: { verb: 'Mark as spam', done: 'marked as spam', ing: 'Marking as spam' },
  not_spam: { verb: 'Mark as not spam', done: 'marked as not spam', ing: 'Marking as not spam' },
};

/** What a change does to labels (or which per-message call it makes). */
export interface Change {
  add: string[];
  remove: string[];
  per?: 'trash' | 'untrash';
}

export function changeFor(action: GmailAction, labelId = ''): Change {
  switch (action) {
    case 'archive':
      return { add: [], remove: ['INBOX'] };
    case 'read':
      return { add: [], remove: ['UNREAD'] };
    case 'unread':
      return { add: ['UNREAD'], remove: [] };
    case 'star':
      return { add: ['STARRED'], remove: [] };
    case 'unstar':
      return { add: [], remove: ['STARRED'] };
    case 'important':
      return { add: ['IMPORTANT'], remove: [] };
    case 'not_important':
      return { add: [], remove: ['IMPORTANT'] };
    case 'label':
      return { add: [labelId], remove: [] };
    case 'unlabel':
      return { add: [], remove: [labelId] };
    case 'spam':
      return { add: ['SPAM'], remove: ['INBOX'] };
    case 'not_spam':
      return { add: ['INBOX'], remove: ['SPAM'] };
    case 'trash':
      return { add: [], remove: [], per: 'trash' };
    case 'untrash':
      return { add: [], remove: [], per: 'untrash' };
  }
}

/** The exact reverse of a change (undo). */
export const reverse = (c: Change): Change => (c.per ? { add: [], remove: [], per: c.per === 'trash' ? 'untrash' : 'trash' } : { add: [...c.remove], remove: [...c.add] });

/** Gmail's search name for a label ("Work/Clients" → work-clients). */
const labelSearch = (name: string) => (/^[\w-]+$/.test(name) ? name : name.toLowerCase().replace(/[\s/&]+/g, '-'));

/**
 * Search words added to the owner's search so only messages the change really changes are
 * counted (archive only what is in the inbox, read only unread ones…). That keeps the count honest
 * and Undo exact (it never adds INBOX back to something that wasn't there).
 */
export function narrowFor(action: GmailAction, labelName = ''): string {
  return {
    archive: 'in:inbox',
    read: 'is:unread',
    unread: 'is:read',
    star: '-is:starred',
    unstar: 'is:starred',
    important: '-is:important',
    not_important: 'is:important',
    label: labelName ? `-label:${labelSearch(labelName)}` : '',
    unlabel: labelName ? `label:${labelSearch(labelName)}` : '',
    trash: '',
    untrash: 'in:trash',
    spam: '',
    not_spam: 'in:spam',
  }[action];
}
/** Trash and spam are left out of searches unless the change is about them. */
const withSpamTrash = (a: GmailAction) => a === 'untrash' || a === 'not_spam';

export const gmailLink = (query: string) => `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;

export interface OrganizeArgs {
  action: GmailAction;
  query?: string;
  ids?: string[];
  dates?: string;
  label?: string;
  createLabel?: boolean;
}

export interface Plan {
  action: GmailAction;
  /** Readable search (what the card and the Gmail link show); '' for an id list. */
  query: string;
  /** What is sent to Gmail (dates as midnight in the owner's zone). */
  exact: string;
  dates?: string;
  label?: string;
  ids: string[];
  capped: boolean;
  samples: { from: string; subject: string; date?: string }[];
  at: number;
}

export interface Outcome {
  actionId?: string;
  action: GmailAction | 'undo';
  done: number;
  failed: number;
  total: number;
  query: string;
  stopped: boolean;
  label?: string;
  /** The first error Gmail gave, if any failed. */
  error?: string;
}

interface Row {
  id: string;
  created_at: string;
  conversation_id: string | null;
  action: string;
  query: string;
  add_labels: string;
  remove_labels: string;
  per: string | null;
  ids: string;
  done: number;
  failed: number;
  undone_at: string | null;
  undo_of: string | null;
}

export interface Opts {
  timeZone: () => string | undefined;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  cap?: number;
  backgroundOver?: number;
  /** First back-off wait (doubles each try). */
  backoffMs?: number;
  jobs?: () => JobManager | undefined;
  workspaceOf?: (conversationId: string) => string | undefined;
}

const ID_RE = /^[\w-]{6,64}$/;

export class GmailOrganizer {
  readonly #google: GoogleAccount;
  readonly #db: DatabaseSync;
  readonly #o: Required<Pick<Opts, 'timeZone' | 'now' | 'sleep' | 'cap' | 'backgroundOver' | 'backoffMs'>> & Opts;
  /** Plans counted for an approval card, used by the run that follows (10 minutes). */
  readonly #plans = new Map<string, Plan>();

  constructor(google: GoogleAccount, db: DatabaseSync, opts: Opts) {
    this.#google = google;
    this.#db = db;
    this.#o = { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), cap: ORGANIZE_CAP, backgroundOver: BACKGROUND_OVER, backoffMs: 1000, ...opts };
    db.exec(`CREATE TABLE IF NOT EXISTS gmail_actions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      conversation_id TEXT,
      action TEXT NOT NULL,
      query TEXT NOT NULL DEFAULT '',
      add_labels TEXT NOT NULL DEFAULT '[]',
      remove_labels TEXT NOT NULL DEFAULT '[]',
      per TEXT,
      ids TEXT NOT NULL,
      done INTEGER NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0,
      undone_at TEXT,
      undo_of TEXT
    )`);
    // Older than the undo window (and a day's grace): the ids aren't needed any more.
    db.prepare('DELETE FROM gmail_actions WHERE created_at < ?').run(new Date(this.#o.now().getTime() - (UNDO_DAYS + 1) * 86_400_000).toISOString());
  }

  get cap(): number {
    return this.#o.cap;
  }
  get backgroundOver(): number {
    return this.#o.backgroundOver;
  }
  canOrganize(): boolean {
    return this.#google.status().canOrganize;
  }
  timeZone(): string | undefined {
    return this.#o.timeZone();
  }

  /** One API call, again after a wait on 429 / 5xx (1 s, 2 s, 4 s … six tries). */
  async call(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    for (let i = 0; ; i++) {
      try {
        return await this.#google.api(url, init);
      } catch (err) {
        const st = err instanceof GoogleApiError ? err.status : 0;
        if (!(st === 429 || st >= 500) || i >= 5 || init.signal?.aborted) throw err;
        await this.#o.sleep(this.#o.backoffMs * 2 ** i);
      }
    }
  }

  /** Every id matching a search (paged, 500 at a time), stopped at `cap`. */
  async listIds(q: string, includeSpamTrash: boolean, cap: number, signal?: AbortSignal): Promise<{ ids: string[]; capped: boolean }> {
    const ids: string[] = [];
    let pageToken = '';
    do {
      const p = new URLSearchParams({ q, maxResults: '500', includeSpamTrash: String(includeSpamTrash) });
      if (pageToken) p.set('pageToken', pageToken);
      const r = (await this.call(`${GMAIL}/messages?${p}`, { ...(signal ? { signal } : {}) })) as { messages?: { id: string }[]; nextPageToken?: string };
      for (const m of r.messages ?? []) {
        if (ids.length >= cap) return { ids, capped: true };
        ids.push(m.id);
      }
      pageToken = r.nextPageToken ?? '';
    } while (pageToken && !signal?.aborted);
    return { ids, capped: false };
  }

  /** Sender, subject and date of a few messages (metadata only). */
  async samples(ids: string[], signal?: AbortSignal, n = 5): Promise<Plan['samples']> {
    const msgs = await Promise.all(
      ids.slice(0, n).map((id) => this.call(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { ...(signal ? { signal } : {}) }).catch(() => undefined) as Promise<{ payload?: GmailPart } | undefined>),
    );
    return msgs.filter((m): m is { payload?: GmailPart } => Boolean(m)).map((m) => ({ from: header(m.payload, 'From').slice(0, 120), subject: (header(m.payload, 'Subject') || '(no subject)').slice(0, 160), date: header(m.payload, 'Date').slice(0, 40) }));
  }

  async labels(signal?: AbortSignal): Promise<{ id: string; name: string; type?: string; messagesTotal?: number; messagesUnread?: number }[]> {
    const r = (await this.call(`${GMAIL}/labels`, { ...(signal ? { signal } : {}) })) as { labels?: { id: string; name: string; type?: string }[] };
    return r.labels ?? [];
  }

  /** A label by name or id; made when `create` (only when the change runs, never while counting). */
  async label(name: string, create: boolean, signal?: AbortSignal): Promise<{ id: string; name: string } | undefined> {
    const all = await this.labels(signal);
    const found = all.find((l) => l.id === name) ?? all.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (found || !create) return found;
    const made = (await this.call(`${GMAIL}/labels`, { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, ...(signal ? { signal } : {}) })) as { id: string; name: string };
    return made;
  }

  /** The search the change uses: the owner's words, the dates, and the narrowing words. */
  searchFor(a: OrganizeArgs): { query: string; exact: string; dates?: string } {
    const tz = this.#o.timeZone();
    const d = a.dates ? gmailDates(a.dates, tz, this.#o.now()) : undefined;
    if (a.dates && !d) throw new Error(`I couldn't read the dates "${a.dates}". Write them as Gmail words instead (before:YYYY/MM/DD is exclusive, after:YYYY/MM/DD inclusive).`);
    const base = (a.query ?? '').trim();
    const narrow = narrowFor(a.action, a.label);
    const query = [base && /\s(or|OR)\s|^-|\{/.test(base) ? `(${base})` : base, d?.readable, narrow].filter(Boolean).join(' ');
    const exact = [base ? exactDates(/\s(or|OR)\s|^-|\{/.test(base) ? `(${base})` : base, tz) : '', d?.exact, narrow].filter(Boolean).join(' ');
    return { query, exact, ...(d ? { dates: d.meaning } : {}) };
  }

  /** Counts what a change would touch (and a few samples); kept for the run that follows. */
  async plan(a: OrganizeArgs, key: string, signal?: AbortSignal): Promise<Plan> {
    if ((a.action === 'label' || a.action === 'unlabel') && !a.label?.trim()) throw new Error('Which label? Give its name in "label".');
    let ids: string[];
    let capped = false;
    let query = '';
    let exact = '';
    let dates: string | undefined;
    if (a.ids?.length) {
      const bad = a.ids.filter((i) => !ID_RE.test(i));
      if (bad.length) throw new Error(`These are not email ids: ${bad.slice(0, 3).join(', ')}`);
      ids = [...new Set(a.ids)];
      if (ids.length > this.#o.cap) {
        ids = ids.slice(0, this.#o.cap);
        capped = true;
      }
    } else {
      if (!a.query?.trim() && !a.dates?.trim()) throw new Error('Give a Gmail search (query) or a list of email ids.');
      ({ query, exact, dates } = this.searchFor(a));
      ({ ids, capped } = await this.listIds(exact, withSpamTrash(a.action), this.#o.cap, signal));
    }
    const plan: Plan = { action: a.action, query, exact, ...(dates ? { dates } : {}), ...(a.label ? { label: a.label } : {}), ids, capped, samples: ids.length ? await this.samples(ids, signal) : [], at: this.#o.now().getTime() };
    this.#plans.set(key, plan);
    for (const [k, p] of this.#plans) if (this.#o.now().getTime() - p.at > 10 * 60_000) this.#plans.delete(k);
    return plan;
  }

  /** The plan counted for this call's approval card (once), if still fresh. */
  takePlan(key: string): Plan | undefined {
    const p = this.#plans.get(key);
    this.#plans.delete(key);
    return p && this.#o.now().getTime() - p.at <= 10 * 60_000 ? p : undefined;
  }

  /** The card section for a plan. */
  detail(p: Plan, background: boolean): ApprovalDetail {
    return { kind: 'gmail', action: p.action, count: p.ids.length, capped: p.capped, cap: this.#o.cap, query: p.query, ...(p.dates ? { dates: p.dates } : {}), ...(p.label ? { label: p.label } : {}), samples: p.samples, background, alwaysAsks: ALWAYS_ASK.has(p.action) };
  }

  /** Applies a change to exact ids (label changes in chunks of 1,000; trash one by one, four at once). */
  async #apply(ids: string[], change: Change, signal: AbortSignal | undefined, progress: (done: number) => void): Promise<{ doneIds: string[]; failed: number; error?: string }> {
    const doneIds: string[] = [];
    let failed = 0;
    let error: string | undefined;
    if (!change.per) {
      for (let i = 0; i < ids.length && !signal?.aborted; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        try {
          // Not aborted mid-request: a Stop lets the call in flight finish (Gmail may already have
          // applied it), so every change that happened is in the undo record.
          await this.call(`${GMAIL}/messages/batchModify`, { method: 'POST', body: { ids: chunk, ...(change.add.length ? { addLabelIds: change.add } : {}), ...(change.remove.length ? { removeLabelIds: change.remove } : {}) } });
          doneIds.push(...chunk);
        } catch (err) {
          failed += chunk.length;
          error ??= (err as Error).message;
        }
        progress(doneIds.length + failed);
      }
      return { doneIds, failed, ...(error ? { error } : {}) };
    }
    let next = 0;
    const worker = async () => {
      while (next < ids.length && !signal?.aborted) {
        const id = ids[next++];
        try {
          await this.call(`${GMAIL}/messages/${id}/${change.per}`, { method: 'POST', body: {} });
          doneIds.push(id);
        } catch (err) {
          failed++;
          error ??= (err as Error).message;
        }
        if ((doneIds.length + failed) % 50 === 0) progress(doneIds.length + failed);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    progress(doneIds.length + failed);
    return { doneIds, failed, ...(error ? { error } : {}) };
  }

  #record(r: Omit<Row, 'id' | 'created_at' | 'undone_at'>): string {
    const id = `g_${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    this.#db
      .prepare('INSERT INTO gmail_actions (id, created_at, conversation_id, action, query, add_labels, remove_labels, per, ids, done, failed, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.#o.now().toISOString(), r.conversation_id, r.action, r.query, r.add_labels, r.remove_labels, r.per, r.ids, r.done, r.failed, r.undo_of);
    forgetTodayMail();
    return id;
  }

  /** Runs an approved plan; writes the undo record for the messages that changed. */
  async run(plan: Plan, opts: { signal?: AbortSignal; progress?: (line: string) => void; conversationId?: string; createLabel?: boolean } = {}): Promise<Outcome> {
    let labelId = '';
    let labelName: string | undefined;
    if (plan.action === 'label' || plan.action === 'unlabel') {
      const l = await this.label(plan.label ?? '', plan.action === 'label' && Boolean(opts.createLabel), opts.signal);
      if (!l) throw new Error(`There is no label called "${plan.label}". Pick one from gmail_labels, or set createLabel to make it.`);
      labelId = l.id;
      labelName = l.name;
    }
    const change = changeFor(plan.action, labelId);
    const words = ACTION_WORDS[plan.action];
    const total = plan.ids.length;
    const r = await this.#apply(plan.ids, change, opts.signal, (n) => opts.progress?.(`${words.ing}: ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} done`));
    const actionId = r.doneIds.length
      ? this.#record({ conversation_id: opts.conversationId ?? null, action: plan.action, query: plan.query, add_labels: JSON.stringify(change.add), remove_labels: JSON.stringify(change.remove), per: change.per ?? null, ids: JSON.stringify(r.doneIds), done: r.doneIds.length, failed: r.failed, undo_of: null })
      : undefined;
    return { ...(actionId ? { actionId } : {}), action: plan.action, done: r.doneIds.length, failed: r.failed, total, query: plan.query, stopped: Boolean(opts.signal?.aborted), ...(labelName ? { label: labelName } : {}), ...(r.error ? { error: r.error } : {}) };
  }

  get(id: string): { id: string; createdAt: string; conversationId: string | null; action: GmailAction; query: string; count: number; undoneAt: string | null; undoOf: string | null } | undefined {
    const r = this.#db.prepare('SELECT * FROM gmail_actions WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? { id: r.id, createdAt: r.created_at, conversationId: r.conversation_id, action: r.action as GmailAction, query: r.query, count: r.done, undoneAt: r.undone_at, undoOf: r.undo_of } : undefined;
  }

  /** The newest change in a conversation that can still be undone. */
  latest(conversationId: string | undefined): string | undefined {
    const since = new Date(this.#o.now().getTime() - UNDO_DAYS * 86_400_000).toISOString();
    const r = (conversationId
      ? this.#db.prepare('SELECT id FROM gmail_actions WHERE conversation_id = ? AND undone_at IS NULL AND undo_of IS NULL AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversationId, since)
      : this.#db.prepare('SELECT id FROM gmail_actions WHERE undone_at IS NULL AND undo_of IS NULL AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(since)) as { id: string } | undefined;
    return r?.id;
  }

  /** Why a change can't be undone, or undefined when it can. */
  undoProblem(id: string): string | undefined {
    const r = this.get(id);
    if (!r) return 'There is no Gmail change with that id to undo (changes can be undone for 30 days).';
    if (r.undoOf) return 'That was already an undo.';
    if (r.undoneAt) return 'That change was already undone.';
    if (this.#o.now().getTime() - Date.parse(r.createdAt) > UNDO_DAYS * 86_400_000) return 'That change is more than 30 days old: it can no longer be undone.';
    return undefined;
  }

  /** Reverses exactly the messages a change touched. */
  async undo(id: string, opts: { signal?: AbortSignal; progress?: (line: string) => void } = {}): Promise<Outcome> {
    const problem = this.undoProblem(id);
    if (problem) throw new Error(problem);
    const row = this.#db.prepare('SELECT * FROM gmail_actions WHERE id = ?').get(id) as unknown as Row;
    const change = reverse({ add: JSON.parse(row.add_labels) as string[], remove: JSON.parse(row.remove_labels) as string[], ...(row.per ? { per: row.per as 'trash' | 'untrash' } : {}) });
    const ids = JSON.parse(row.ids) as string[];
    const r = await this.#apply(ids, change, opts.signal, (n) => opts.progress?.(`Undoing: ${n.toLocaleString('en-US')} of ${ids.length.toLocaleString('en-US')} done`));
    if (!opts.signal?.aborted || r.doneIds.length === ids.length) this.#db.prepare('UPDATE gmail_actions SET undone_at = ? WHERE id = ?').run(this.#o.now().toISOString(), id);
    const undoId = r.doneIds.length
      ? this.#record({ conversation_id: row.conversation_id, action: row.action, query: row.query, add_labels: JSON.stringify(change.add), remove_labels: JSON.stringify(change.remove), per: change.per ?? null, ids: JSON.stringify(r.doneIds), done: r.doneIds.length, failed: r.failed, undo_of: id })
      : undefined;
    return { ...(undoId ? { actionId: undoId } : {}), action: 'undo', done: r.doneIds.length, failed: r.failed, total: ids.length, query: row.query, stopped: Boolean(opts.signal?.aborted), ...(r.error ? { error: r.error } : {}) };
  }

  /**
   * Runs a change inline, or as a background task when it's big (progress above the chat, Stop,
   * the result card with Undo on the job's notice). Returns the text the model (or button) gets.
   */
  async execute(label: string, total: number, conversationId: string | undefined, signal: AbortSignal | undefined, work: (signal: AbortSignal | undefined, progress: (line: string) => void) => Promise<Outcome>, undoOf?: { action: string }): Promise<{ text: string; job?: number }> {
    const jobs = this.#o.jobs?.();
    const ws = conversationId ? this.#o.workspaceOf?.(conversationId) : undefined;
    if (total > this.#o.backgroundOver && jobs && conversationId && ws) {
      const { job } = jobs.startTask({
        conversationId,
        workspace: ws,
        label,
        run: async (sig, progress) => {
          const o = await work(sig, progress);
          const text = outcomeText(o, undoOf);
          const card = cardFor({ name: 'gmail_organize', args: {}, status: 'ok', output: text });
          return { ok: o.failed === 0, output: text, result: { summary: text.split('\n')[0], ...(card ? { card } : {}) } };
        },
      });
      return { job: job.id, text: `Started background job #${job.id}: ${label}. Progress shows above the chat and the owner can stop it there; when it ends, the result (with Undo) appears in this chat. Tell the owner it's running; don't claim it's done.` };
    }
    return { text: outcomeText(await work(signal, () => {}), undoOf) };
  }

  /** How many messages an undo would touch. */
  undoCount(id: string): number {
    return this.get(id)?.count ?? 0;
  }
}

/** The result text the model reads (and the card is built from: the last line). */
export function outcomeText(o: Outcome, undoOf?: { action: string }): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const what = o.action === 'undo' ? `Undid the change${undoOf ? ` (${ACTION_WORDS[undoOf.action as GmailAction]?.done ?? undoOf.action})` : ''} on ${n(o.done)} of ${n(o.total)} emails` : `Done: ${n(o.done)} of ${n(o.total)} emails ${ACTION_WORDS[o.action].done}${o.label ? ` ("${o.label}")` : ''}`;
  const lines = [
    `${what}${o.failed ? `, ${n(o.failed)} failed${o.error ? ` (${o.error})` : ''}` : ''}${o.stopped ? ' (stopped before the end)' : ''}.${o.query ? ` Search: ${o.query}` : ''}`,
    o.action !== 'undo' && o.actionId ? `The owner can undo this for 30 days: the Undo button on the result card, or gmail_undo with id ${o.actionId}.` : '',
    `[gmail-result ${JSON.stringify({ id: o.actionId ?? '', action: o.action, done: o.done, failed: o.failed, total: o.total, query: o.query, ...(o.label ? { label: o.label } : {}), ...(o.stopped ? { stopped: true } : {}), ...(undoOf ? { undoOf: undoOf.action } : {}) })}]`,
  ];
  return lines.filter(Boolean).join('\n');
}
