// V5.6 (docs/design/V5_PHONE_MODEL.md): an answer the phone's own small model gave while the server
// was away comes back with the outbox message (`offlineAnswer`). It is stored right after the
// message, marked, and no second turn runs (nothing is answered twice). "Ask Sara again" (the retry
// route) has her answer it properly.
import { HttpError } from './http.ts';
import type { Store } from './store.ts';

export const OFFLINE_ANSWER_MAX = 4000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface OfflineAnswer {
  text: string;
  model: string;
  at: string;
}

/** The offline answer from a request body: undefined when none (or empty); a 400 when it isn't one. */
export function cleanOfflineAnswer(v: unknown): OfflineAnswer | undefined {
  if (v === undefined || v === null) return undefined;
  const bad = () => new HttpError(400, 'That offline answer is not valid.');
  if (typeof v !== 'object' || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  if (typeof o.text !== 'string' || typeof o.model !== 'string' || typeof o.at !== 'string') throw bad();
  if (o.text.length > OFFLINE_ANSWER_MAX || o.model.length > 80 || !ISO.test(o.at) || Number.isNaN(Date.parse(o.at))) throw bad();
  const text = o.text.trim();
  if (!text) return undefined;
  return { text, model: o.model.replace(/\s+/g, ' ').trim() || 'phone', at: o.at };
}

/**
 * Whether an offline answer may be kept in this chat: never for a child's account (her answer then
 * comes from a normal turn with the child's rules), off the record, or in someone else's chat.
 */
export function offlineAnswerAllowed(app: { member?: { child?: () => unknown } }, conv: { partner?: unknown }, o: { offRecord: boolean }): boolean {
  if (o.offRecord || conv.partner) return false;
  return !app.member?.child?.();
}

/** Stores the message written offline and the phone's answer to it. */
export function storeOfflineAnswer(store: Pick<Store, 'addMessage'>, conversationId: string, content: string, clientKey: string, answer: OfflineAnswer): { messageId: number; answerId: number } {
  const user = store.addMessage(conversationId, 'user', content, { clientKey, writtenOffline: true });
  const reply = store.addMessage(conversationId, 'assistant', answer.text, { offlineAnswer: { model: answer.model, at: answer.at } });
  return { messageId: user.id, answerId: reply.id };
}
