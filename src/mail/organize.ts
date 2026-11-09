// M1: organizing an Outlook or IMAP mailbox, the Gmail way (src/gmail-organize.ts): count first
// (only messages the change really changes), the same caps and background runs, trash and spam ask
// every time, and every change is recorded (`mail_actions`) so Undo reverses exactly those messages
// for 30 days. Never a permanent delete: the providers move to Deleted Items / Trash at most.
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { ACTION_WORDS, ALWAYS_ASK, BACKGROUND_OVER, ORGANIZE_CAP, UNDO_DAYS } from '../gmail-organize.ts';
import type { JobManager } from '../jobs.ts';
import type { ApprovalDetail } from '../tools/types.ts';
import { cardFor } from '../cards.ts';
import { emptyTerms, parseSearch, type SearchTerms } from './search.ts';
import type { Before, MailAccountInfo, MailAction, MailProvider } from './types.ts';

export const WORDS: Record<MailAction, { verb: string; done: string; ing: string }> = {
  ...ACTION_WORDS,
  move: { verb: 'Move', done: 'moved', ing: 'Moving' },
};

/** The plain name of a provider for cards and messages. */
export const providerName = (a: Pick<MailAccountInfo, 'kind' | 'provider'>): string => (a.kind === 'google' ? 'Gmail' : a.kind === 'microsoft' ? 'Outlook' : 'Mail');

export interface MailPlan {
  accountId: string;
  action: MailAction;
  query: string;
  dates?: string;
  target?: string;
  ids: string[];
  capped: boolean;
  samples: { from: string; subject: string; date?: string }[];
  at: number;
}

export interface MailOutcome {
  actionId?: string;
  action: MailAction | 'undo';
  done: number;
  failed: number;
  total: number;
  query: string;
  stopped: boolean;
  target?: string;
  error?: string;
  provider: string;
}

/** Narrowing so only messages the change changes are counted (and Undo stays exact). */
export function narrow(action: MailAction, t: SearchTerms, target?: string): SearchTerms {
  const n = { ...t };
  switch (action) {
    case 'archive':
      n.folder = 'inbox';
      break;
    case 'read':
      n.unread = true;
      break;
    case 'unread':
      n.unread = false;
      break;
    case 'star':
      n.flagged = false;
      break;
    case 'unstar':
      n.flagged = true;
      break;
    case 'important':
      n.important = false;
      break;
    case 'not_important':
      n.important = true;
      break;
    case 'label':
      if (target) n.notLabel = target;
      break;
    case 'unlabel':
      if (target) n.label = target;
      break;
    case 'untrash':
      n.folder = 'trash';
      break;
    case 'not_spam':
      n.folder = 'spam';
      break;
    default:
      break;
  }
  return n;
}

export interface MailOrganizerOpts {
  timeZone: () => string | undefined;
  now?: () => Date;
  cap?: number;
  backgroundOver?: number;
  jobs?: () => JobManager | undefined;
  workspaceOf?: (conversationId: string) => string | undefined;
  onChange?: () => void;
}

export class MailOrganizer {
  readonly #db: DatabaseSync;
  readonly #o: MailOrganizerOpts & { now: () => Date; cap: number; backgroundOver: number };
  readonly #plans = new Map<string, MailPlan>();

  constructor(db: DatabaseSync, opts: MailOrganizerOpts) {
    this.#db = db;
    this.#o = { now: () => new Date(), cap: ORGANIZE_CAP, backgroundOver: BACKGROUND_OVER, ...opts };
    db.exec(`CREATE TABLE IF NOT EXISTS mail_actions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      conversation_id TEXT,
      account_id TEXT NOT NULL,
      action TEXT NOT NULL,
      query TEXT NOT NULL DEFAULT '',
      target TEXT,
      before TEXT NOT NULL,
      done INTEGER NOT NULL,
      failed INTEGER NOT NULL DEFAULT 0,
      undone_at TEXT,
      undo_of TEXT
    )`);
    db.prepare('DELETE FROM mail_actions WHERE created_at < ?').run(new Date(this.#o.now().getTime() - (UNDO_DAYS + 1) * 86_400_000).toISOString());
  }

  get cap(): number {
    return this.#o.cap;
  }
  get backgroundOver(): number {
    return this.#o.backgroundOver;
  }

  terms(query: string, dates: string | undefined): SearchTerms {
    return parseSearch(query, { ...(dates ? { dates } : {}), tz: this.#o.timeZone(), now: this.#o.now() });
  }

  async plan(account: MailAccountInfo, p: MailProvider, a: { action: MailAction; query?: string; dates?: string; ids?: string[]; target?: string }, key: string, signal?: AbortSignal): Promise<MailPlan> {
    if ((a.action === 'label' || a.action === 'unlabel' || a.action === 'move') && !a.target?.trim()) throw new Error(a.action === 'move' ? 'Which folder? Give its name in "folder".' : 'Which label? Give its name in "label".');
    let ids: string[];
    let capped = false;
    let dates: string | undefined;
    const query = [a.query?.trim(), a.dates?.trim() ? `(${a.dates.trim()})` : ''].filter(Boolean).join(' ');
    if (a.ids?.length) {
      ids = [...new Set(a.ids)];
      if (ids.length > this.#o.cap) {
        ids = ids.slice(0, this.#o.cap);
        capped = true;
      }
    } else {
      const t = this.terms(a.query ?? '', a.dates);
      if (emptyTerms(t)) throw new Error('Give a search (query) or dates, or a list of email ids.');
      dates = t.dates;
      ({ ids, capped } = await p.searchIds(narrow(a.action, t, a.target), this.#o.cap, signal));
    }
    const samples = ids.length ? (await p.list(ids.slice(0, 5), signal).catch(() => [])).map((m) => ({ from: m.from.slice(0, 120), subject: (m.subject || '(no subject)').slice(0, 160), date: m.date.slice(0, 40) })) : [];
    const plan: MailPlan = { accountId: account.id, action: a.action, query, ...(dates ? { dates } : {}), ...(a.target ? { target: a.target } : {}), ids, capped, samples, at: this.#o.now().getTime() };
    this.#plans.set(key, plan);
    for (const [k, x] of this.#plans) if (this.#o.now().getTime() - x.at > 10 * 60_000) this.#plans.delete(k);
    return plan;
  }

  takePlan(key: string): MailPlan | undefined {
    const p = this.#plans.get(key);
    this.#plans.delete(key);
    return p && this.#o.now().getTime() - p.at <= 10 * 60_000 ? p : undefined;
  }

  detail(p: MailPlan, account: MailAccountInfo): ApprovalDetail {
    return { kind: 'gmail', action: p.action, count: p.ids.length, capped: p.capped, cap: this.#o.cap, query: p.query, ...(p.dates ? { dates: p.dates } : {}), ...(p.target ? { label: p.target } : {}), samples: p.samples, background: p.ids.length > this.#o.backgroundOver, alwaysAsks: ALWAYS_ASK.has(p.action), provider: providerName(account), account: account.address };
  }

  #record(r: { conversationId?: string; accountId: string; action: string; query: string; target?: string; before: Before[]; failed: number; undoOf?: string }): string {
    const id = `m_${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
    this.#db
      .prepare('INSERT INTO mail_actions (id, created_at, conversation_id, account_id, action, query, target, before, done, failed, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, this.#o.now().toISOString(), r.conversationId ?? null, r.accountId, r.action, r.query, r.target ?? null, JSON.stringify(r.before), r.before.length, r.failed, r.undoOf ?? null);
    this.#o.onChange?.();
    return id;
  }

  async run(plan: MailPlan, account: MailAccountInfo, p: MailProvider, opts: { signal?: AbortSignal; progress?: (line: string) => void; conversationId?: string; createLabel?: boolean } = {}): Promise<MailOutcome> {
    const words = WORDS[plan.action];
    const total = plan.ids.length;
    const r = await p.apply(plan.action, plan.ids, { ...(plan.target ? { target: plan.target } : {}), ...(opts.createLabel ? { createLabel: true } : {}), ...(opts.signal ? { signal: opts.signal } : {}), progress: (n) => opts.progress?.(`${words.ing}: ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} done`) });
    const actionId = r.done.length ? this.#record({ ...(opts.conversationId ? { conversationId: opts.conversationId } : {}), accountId: account.id, action: plan.action, query: plan.query, ...(r.target ?? plan.target ? { target: r.target ?? plan.target } : {}), before: r.done, failed: r.failed }) : undefined;
    return { ...(actionId ? { actionId } : {}), action: plan.action, done: r.done.length, failed: r.failed, total, query: plan.query, stopped: Boolean(opts.signal?.aborted), ...(plan.target ? { target: plan.target } : {}), ...(r.error ? { error: r.error } : {}), provider: providerName(account) };
  }

  get(id: string): { id: string; createdAt: string; conversationId: string | null; accountId: string; action: MailAction; query: string; target: string | null; count: number; undoneAt: string | null; undoOf: string | null } | undefined {
    const r = this.#db.prepare('SELECT * FROM mail_actions WHERE id = ?').get(id) as { id: string; created_at: string; conversation_id: string | null; account_id: string; action: string; query: string; target: string | null; done: number; undone_at: string | null; undo_of: string | null } | undefined;
    return r ? { id: r.id, createdAt: r.created_at, conversationId: r.conversation_id, accountId: r.account_id, action: r.action as MailAction, query: r.query, target: r.target, count: r.done, undoneAt: r.undone_at, undoOf: r.undo_of } : undefined;
  }

  latest(conversationId: string | undefined): string | undefined {
    const since = new Date(this.#o.now().getTime() - UNDO_DAYS * 86_400_000).toISOString();
    const r = (conversationId
      ? this.#db.prepare('SELECT id FROM mail_actions WHERE conversation_id = ? AND undone_at IS NULL AND undo_of IS NULL AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(conversationId, since)
      : this.#db.prepare('SELECT id FROM mail_actions WHERE undone_at IS NULL AND undo_of IS NULL AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(since)) as { id: string } | undefined;
    return r?.id;
  }
  /** When the newest change was made (to compare with Gmail's for "undo that"). */
  createdAt(id: string): string {
    return this.get(id)?.createdAt ?? '';
  }

  undoProblem(id: string): string | undefined {
    const r = this.get(id);
    if (!r) return 'There is no mail change with that id to undo (changes can be undone for 30 days).';
    if (r.undoOf) return 'That was already an undo.';
    if (r.undoneAt) return 'That change was already undone.';
    if (this.#o.now().getTime() - Date.parse(r.createdAt) > UNDO_DAYS * 86_400_000) return 'That change is more than 30 days old: it can no longer be undone.';
    return undefined;
  }

  async undo(id: string, account: MailAccountInfo, p: MailProvider, opts: { signal?: AbortSignal; progress?: (line: string) => void } = {}): Promise<MailOutcome> {
    const problem = this.undoProblem(id);
    if (problem) throw new Error(problem);
    const row = this.#db.prepare('SELECT * FROM mail_actions WHERE id = ?').get(id) as { action: string; query: string; target: string | null; before: string; conversation_id: string | null; account_id: string };
    const before = JSON.parse(row.before) as Before[];
    const r = await p.revert(row.action as MailAction, before, { ...(row.target ? { target: row.target } : {}), ...(opts.signal ? { signal: opts.signal } : {}), progress: (n) => opts.progress?.(`Undoing: ${n.toLocaleString('en-US')} of ${before.length.toLocaleString('en-US')} done`) });
    if (!opts.signal?.aborted || r.done.length === before.length) this.#db.prepare('UPDATE mail_actions SET undone_at = ? WHERE id = ?').run(this.#o.now().toISOString(), id);
    const undoId = r.done.length ? this.#record({ ...(row.conversation_id ? { conversationId: row.conversation_id } : {}), accountId: row.account_id, action: row.action, query: row.query, before: r.done, failed: r.failed, undoOf: id }) : undefined;
    return { ...(undoId ? { actionId: undoId } : {}), action: 'undo', done: r.done.length, failed: r.failed, total: before.length, query: row.query, stopped: Boolean(opts.signal?.aborted), ...(r.error ? { error: r.error } : {}), provider: providerName(account) };
  }

  /** Inline, or a background task when big (the same as Gmail's). */
  async execute(label: string, total: number, conversationId: string | undefined, signal: AbortSignal | undefined, work: (signal: AbortSignal | undefined, progress: (line: string) => void) => Promise<MailOutcome>, undoOf?: { action: string }): Promise<{ text: string; job?: number }> {
    const jobs = this.#o.jobs?.();
    const ws = conversationId ? this.#o.workspaceOf?.(conversationId) : undefined;
    if (total > this.#o.backgroundOver && jobs && conversationId && ws) {
      const { job } = jobs.startTask({
        conversationId,
        workspace: ws,
        label,
        run: async (sig, progress) => {
          const o = await work(sig, progress);
          const text = mailOutcomeText(o, undoOf);
          const card = cardFor({ name: 'mail_organize', args: {}, status: 'ok', output: text });
          return { ok: o.failed === 0, output: text, result: { summary: text.split('\n')[0], ...(card ? { card } : {}) } };
        },
      });
      return { job: job.id, text: `Started background job #${job.id}: ${label}. Progress shows above the chat and the owner can stop it there; when it ends, the result (with Undo) appears in this chat. Tell the owner it's running; don't claim it's done.` };
    }
    return { text: mailOutcomeText(await work(signal, () => {}), undoOf) };
  }
}

/** The result text (the card is built from its last line, like Gmail's). */
export function mailOutcomeText(o: MailOutcome, undoOf?: { action: string }): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const what =
    o.action === 'undo'
      ? `Undid the change${undoOf ? ` (${WORDS[undoOf.action as MailAction]?.done ?? undoOf.action})` : ''} on ${n(o.done)} of ${n(o.total)} emails`
      : `Done: ${n(o.done)} of ${n(o.total)} emails ${WORDS[o.action].done}${o.target ? ` ("${o.target}")` : ''} in ${o.provider}`;
  return [
    `${what}${o.failed ? `, ${n(o.failed)} failed${o.error ? ` (${o.error})` : ''}` : ''}${o.stopped ? ' (stopped before the end)' : ''}.${o.query ? ` Search: ${o.query}` : ''}`,
    o.action !== 'undo' && o.actionId ? `The owner can undo this for 30 days: the Undo button on the result card, or mail_undo with id ${o.actionId}.` : '',
    `[gmail-result ${JSON.stringify({ id: o.actionId ?? '', action: o.action, done: o.done, failed: o.failed, total: o.total, query: o.query, provider: o.provider, ...(o.target ? { label: o.target } : {}), ...(o.stopped ? { stopped: true } : {}), ...(undoOf ? { undoOf: undoOf.action } : {}) })}]`,
  ]
    .filter(Boolean)
    .join('\n');
}
