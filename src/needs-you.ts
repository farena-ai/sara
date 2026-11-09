// 3.0.3 (docs/ops/V4_DESIGN.md → V4f): which conversations need the person right now, for the
// sidebar's red "needs you" dot. Read from what already holds each state, never stored twice:
// - an approval waiting in that conversation (her tool approvals, a team task's step approvals);
// - her question waiting for an answer (a board card parked on card_ask, a team checkpoint);
// - a failed run there that the person hasn't opened the conversation since (RunStore.markSeen).
// Every source belongs to one space (each household member has their own app, database, approval
// broker and board worker; shared-board cards count only for the person whose space runs them), so
// the map never holds another person's conversations.
import type { AppContext } from './chat.ts';

export type NeedsReason = 'approval' | 'question' | 'failed';
export interface NeedsYou {
  reason: NeedsReason;
  /** How many things wait there (approvals + questions + failed runs). */
  count: number;
}

const RANK: Record<NeedsReason, number> = { approval: 0, question: 1, failed: 2 };

/** conversation id → what needs the person there (the most urgent reason first). Cheap: in-memory maps plus two small queries. */
export function needsYouMap(app: AppContext): Map<string, NeedsYou> {
  const out = new Map<string, NeedsYou>();
  const add = (id: string | null | undefined, reason: NeedsReason, n = 1) => {
    if (!id || n <= 0) return;
    const cur = out.get(id);
    if (!cur) out.set(id, { reason, count: n });
    else out.set(id, { reason: RANK[reason] < RANK[cur.reason] ? reason : cur.reason, count: cur.count + n });
  };
  try {
    for (const [id, n] of app.approvals.pendingByConversation()) add(id, 'approval', n);
  } catch {
    /* an older broker */
  }
  try {
    for (const t of app.team?.running() ?? []) add(t.conversationId, 'approval', app.team!.approvals(t.id).length);
    for (const id of app.team?.waitingConversations() ?? []) add(id, 'question');
  } catch {
    /* the team tables are optional */
  }
  try {
    for (const c of app.cardWork?.questions() ?? []) add(c.work?.conversationId, 'question');
  } catch {
    /* no board */
  }
  try {
    for (const id of app.runs?.failedUnseen(app.now()) ?? []) add(id, 'failed');
  } catch {
    /* the run store is optional */
  }
  return out;
}

const wired = new WeakSet<object>();
/** Live updates: a waiting approval starting or ending publishes `needs` (the sidebar reloads its list). Idempotent. */
export function wireNeedsYou(app: AppContext): void {
  const broker = app.approvals as AppContext['approvals'] | undefined;
  if (!broker || wired.has(broker) || typeof broker.onChange !== 'function') return;
  wired.add(broker);
  broker.onChange((conversationId) => app.events?.publish({ type: 'needs', conversationId }));
}
