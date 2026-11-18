// V1.2 (docs/WAITING.md): Waiting on you, one queue. A READ-ONLY aggregator over the stores that
// already hold each waiting thing: no second store, no copies. Every row carries the key its own
// place uses (Today's Needs you keys, so "Later" here and "Not today" there are the same snooze),
// where it opens, and whether a one-tap answer is allowed.
//
// Sources (each appears once):
//   approval  her tool approvals waiting in a running turn (server's active turns)
//   team      a team task's step approvals
//   device    another device asking the owner's OK (owner only; the code is on that device)
//   question  a board card parked on her question
//   errand    an errand step waiting on you (a draft email, a choice, an address…)
//   inbox     an inbox helper suggestion not yet done
//   overdue   open to-dos past their due time
//   failed    a chat whose run failed and that you haven't opened since
//   followup  a mail thread someone is waiting on you to answer (injected: reads mail, memoised)
//
// Order: urgent first (something is blocked until you answer), then oldest first.
// One tap (phone swipe right / Approve) only where the card already allows a one-tap answer AND
// it is not about money or passwords (src/phone-actions.ts voiceMayApprove, inbox money kinds,
// errand purchases). Everything else opens its own card.
import type { AppContext, ChatEvent } from './chat.ts';
import { en } from './i18n.ts';
import { voiceMayApprove } from './phone-actions.ts';
import { addNotToday, getLayout } from './today-layout.ts';

export const WAIT_SOURCES = ['approval', 'team', 'device', 'question', 'errand', 'inbox', 'overdue', 'failed', 'followup'] as const;
export type WaitSource = (typeof WAIT_SOURCES)[number];

/** Where a row opens: its own card. */
export type WaitOpen =
  | { kind: 'chat'; conversationId: string }
  | { kind: 'card'; boardId: number; cardId: number }
  | { kind: 'errand'; id: number }
  | { kind: 'inbox'; id: number }
  | { kind: 'task'; id: number }
  | { kind: 'device' }
  | { kind: 'ask'; text: string };

export interface WaitItem {
  key: string;
  source: WaitSource;
  title: string;
  why: string;
  /** When it started waiting (ISO), null when unknown. */
  at: string | null;
  urgent: boolean;
  open: WaitOpen;
  /** A one-tap yes is allowed (swipe right on a phone, the row's Approve button). */
  oneTap: boolean;
  /** Why there is no one-tap yes (shown as a hint): money, password, needs a look. */
  noTap?: 'money' | 'look';
}

type ApprovalEv = Extract<ChatEvent, { type: 'approval' }>;
export interface WaitDeps {
  /** Approvals waiting in this space's running turns (the server's active map). */
  approvals?: () => (ApprovalEv & { conversationId: string; since: string })[];
  /** Mail threads waiting on a reply (reads mail: the route memoises it). */
  followups?: () => Promise<{ threadId: string; subject: string; from: string; date: string; ageDays: number }[]>;
  /** The person is a household member (owner-only sources are skipped). */
  member?: boolean;
}

/** Inbox kinds that touch money: never answered by one tap. */
export const MONEY_INBOX = new Set(['bill', 'receipt', 'invoice_paid']);
/** Errand steps a one-tap OK may answer: an email draft she wrote (send / follow-up). */
const ERRAND_TAP = new Set(['send', 'follow_up']);
const ERRAND_MONEY = new Set(['purchase']);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const safe = <T>(f: () => T, d: T): T => {
  try {
    return f();
  } catch {
    return d;
  }
};

/** The whole queue for this space, ranked, without the ones put off until tomorrow. */
export async function waitingList(app: AppContext, deps: WaitDeps = {}, now: Date = app.now()): Promise<WaitItem[]> {
  const out: WaitItem[] = [];
  const owner = !deps.member && !app.member;
  const convTitle = (id: string | null | undefined) => (id ? (safe(() => app.store.getConversation(id)?.title, undefined) ?? '') : '');

  for (const a of safe(() => deps.approvals?.() ?? [], [])) {
    const tap = voiceMayApprove(a as never);
    out.push({ key: `approval:${a.approvalId}`, source: 'approval', title: clip(a.summary || a.name, 200), why: convTitle(a.conversationId), at: a.since ?? null, urgent: true, open: { kind: 'chat', conversationId: a.conversationId }, oneTap: tap, ...(tap ? {} : { noTap: /pay|purchase|buy|checkout|wallet|transfer|password|passkey|vault|secret|credential|login|signin|otp/.test(a.name) || (a as { spend?: unknown }).spend || (a as { price?: unknown }).price ? ('money' as const) : ('look' as const) }) });
  }
  for (const task of safe(() => app.team?.running() ?? [], [])) {
    for (const ap of safe(() => app.team!.approvals(task.id), [])) {
      out.push({ key: `team:${task.id}:${ap.id}`, source: 'team', title: clip(ap.summary || ap.tool, 200), why: clip(`${ap.helper} · ${task.goal}`, 160), at: null, urgent: true, open: { kind: 'chat', conversationId: task.conversationId }, oneTap: false, noTap: 'look' });
    }
  }
  if (owner) {
    for (const r of safe(() => app.deviceApprovals?.pending() ?? [], [])) {
      out.push({ key: `device:${r.createdAt}`, source: 'device', title: r.label || en('A device asks for your OK'), why: r.ip ?? '', at: r.createdAt ?? null, urgent: true, open: { kind: 'device' }, oneTap: false, noTap: 'look' });
    }
  }
  const board = safe(() => app.board?.today(), undefined);
  for (const c of board?.waiting ?? []) {
    out.push({ key: `card:${c.id}`, source: 'question', title: c.title, why: clip(c.question ?? '', 200), at: null, urgent: true, open: { kind: 'card', boardId: c.boardId, cardId: c.id }, oneTap: false, noTap: 'look' });
  }
  for (const e of safe(() => app.errands?.list({ open: true }) ?? [], [])) {
    if (e.status !== 'waiting_you') continue;
    const step = e.steps.find((s) => s.status === 'waiting_you');
    const pending = step?.pending ?? '';
    const tap = ERRAND_TAP.has(pending) && Boolean(step?.draft);
    const soon = e.deadline ? Date.parse(e.deadline) - now.getTime() < 2 * 86_400_000 : false;
    out.push({ key: `errand:${e.id}`, source: 'errand', title: clip(e.goal, 200), why: clip((e.needs ?? '').split('\n')[0] ?? '', 200), at: e.updatedAt ?? null, urgent: soon, open: { kind: 'errand', id: e.id }, oneTap: tap, ...(tap ? {} : { noTap: ERRAND_MONEY.has(pending) ? ('money' as const) : ('look' as const) }) });
  }
  for (const it of safe(() => app.inbox?.list({ status: 'pending', limit: 30 }) ?? [], [])) {
    const money = MONEY_INBOX.has(it.kind);
    const f = it.finding as { due?: string; payee?: string; vendor?: string };
    const soon = f.due ? Date.parse(f.due) - now.getTime() < 3 * 86_400_000 : false;
    out.push({ key: `inbox:${it.id}`, source: 'inbox', title: clip(it.subject || it.sender, 200), why: clip(it.sender || it.from, 120), at: it.createdAt, urgent: soon, open: { kind: 'inbox', id: it.id }, oneTap: !money, ...(money ? { noTap: 'money' as const } : {}) });
  }
  for (const x of safe(() => app.planner?.tasks({ status: 'open' }) ?? [], [])) {
    if (!x.dueAt || Date.parse(x.dueAt) >= now.getTime()) continue;
    out.push({ key: `task:${x.id}`, source: 'overdue', title: clip(x.title, 200), why: x.project ?? '', at: x.dueAt, urgent: false, open: { kind: 'task', id: x.id }, oneTap: false, noTap: 'look' });
  }
  for (const id of safe(() => app.runs?.failedUnseen(now) ?? [], [])) {
    out.push({ key: `failed:${id}`, source: 'failed', title: convTitle(id) || en('A chat'), why: '', at: null, urgent: false, open: { kind: 'chat', conversationId: id }, oneTap: false, noTap: 'look' });
  }
  if (deps.followups) {
    const list = await deps.followups().catch(() => []);
    for (const f of list.slice(0, 10)) {
      out.push({ key: `followup:${clip(f.threadId, 50)}`, source: 'followup', title: clip(f.subject, 200), why: clip(f.from, 120), at: f.date || null, urgent: false, open: { kind: 'ask', text: `Draft a reply to the email "${clip(f.subject, 120)}" from ${clip(f.from, 80)}.` }, oneTap: false, noTap: 'look' });
    }
  }
  const later = new Set(safe(() => getLayout(app).prefs.notToday.keys, [] as string[]));
  const seen = new Set<string>();
  return out
    .filter((x) => !later.has(x.key) && !seen.has(x.key) && seen.add(x.key))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));
}

export class WaitError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Answer a row: `approve` (one tap; refused where the row doesn't allow it) or `later` (put off
 * until tomorrow: the same "Not today" list Today uses). Runs the row's own action, never a new one.
 */
export async function waitingAct(app: AppContext, deps: WaitDeps, key: string, action: 'approve' | 'later'): Promise<{ ok: true; item: WaitItem }> {
  const item = (await waitingList(app, deps)).find((x) => x.key === key);
  if (!item) throw new WaitError(404, en('That is no longer waiting on you.'));
  if (action === 'later') {
    addNotToday(app, key);
    return { ok: true, item };
  }
  if (!item.oneTap) throw new WaitError(409, item.noTap === 'money' ? en('Money and passwords never go by one tap: open it to answer.') : en('This one needs a look: open it to answer.'));
  const id = key.slice(key.indexOf(':') + 1);
  if (item.source === 'approval') {
    if (!app.approvals.decide(id, true)) throw new WaitError(404, en('That is no longer waiting on you.'));
  } else if (item.source === 'errand') {
    await app.errands!.approve(Number(id));
  } else if (item.source === 'inbox') {
    const r = await app.inbox!.accept(Number(id));
    if (r.status === 'failed') throw new WaitError(409, r.result ?? en('That did not work: open it to see why.'));
  } else throw new WaitError(409, en('This one needs a look: open it to answer.'));
  return { ok: true, item };
}
