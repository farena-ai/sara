// 3.0.3 (docs/ops/V4_DESIGN.md → V4f): which new memories belong to which reply ("Saved n new
// memories" in the run card). Two writers: her tools during the turn (person_note, lessons…: notes
// in this conversation newer than the turn's start mark) and the memory worker after the chat goes
// quiet (each note cites a message: it goes on the last reply of that turn). Both end up in the
// reply's `meta.savedMemoryIds`; summaries are not counted (they are the chat's own diary).
import type { AppContext } from './chat.ts';

/** The newest memory id now (the turn's start mark); 0 without memory. */
export function memoryMark(app: AppContext): number {
  try {
    const r = app.store.db.prepare('SELECT MAX(id) AS id FROM memories').get() as { id: number | null } | undefined;
    return Number(r?.id ?? 0);
  } catch {
    return 0;
  }
}

/** Notes written in this conversation after `mark` (not summaries). */
export function savedSince(app: AppContext, conversationId: string, mark: number): number[] {
  try {
    return (app.store.db.prepare("SELECT id FROM memories WHERE id > ? AND conversation_id = ? AND kind <> 'summary' ORDER BY id").all(mark, conversationId) as { id: number }[]).map((r) => Number(r.id));
  } catch {
    return [];
  }
}

/** Adds ids to a reply's `savedMemoryIds` (no duplicates). */
export function addSaved(app: AppContext, replyId: number, ids: number[]): void {
  if (!ids.length) return;
  const m = app.store.messageById(replyId);
  if (!m) return;
  const have = Array.isArray(m.meta?.savedMemoryIds) ? (m.meta.savedMemoryIds as number[]) : [];
  const next = [...new Set([...have, ...ids])];
  if (next.length !== have.length) app.store.updateMessageMeta(replyId, { savedMemoryIds: next });
}

/**
 * The memory worker's notes, each on the last reply of the turn its source message is in (the last
 * assistant message from the source up to the next owner message). Returns how many found a reply.
 */
export function attachSaved(app: AppContext, conversationId: string, items: { id: number; sourceMessageId: number | null }[]): number {
  const withSource = items.filter((x) => x.sourceMessageId);
  if (!withSource.length) return 0;
  const msgs = app.store.messages(conversationId);
  const byReply = new Map<number, number[]>();
  for (const it of withSource) {
    const at = msgs.findIndex((m) => m.id === it.sourceMessageId);
    if (at < 0) continue;
    let reply = 0;
    for (let i = at; i < msgs.length; i++) {
      if (i > at && msgs[i].role === 'user') break;
      if (msgs[i].role === 'assistant') reply = msgs[i].id;
    }
    if (!reply) continue;
    byReply.set(reply, [...(byReply.get(reply) ?? []), it.id]);
  }
  let n = 0;
  for (const [reply, ids] of byReply) {
    addSaved(app, reply, ids);
    n += ids.length;
  }
  return n;
}
