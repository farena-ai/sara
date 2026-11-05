import { en } from './i18n.ts';

/** An in-process provider-step lease. No durable state or work is started by this queue. */
export interface SessionStepTicket { waiting: boolean; ready: Promise<() => void> }
interface Waiter { conversationId: string; grant: () => void; cancel: () => void }
interface Queue { owner: string | undefined; waiting: Waiter[] }
const queues = new WeakMap<object, Queue>();

export function acquireSessionStep(database: object, conversationId: string, signal: AbortSignal): SessionStepTicket {
  const stopped = () => signal.reason instanceof Error ? signal.reason : new Error('Stopped.');
  if (signal.aborted) return { waiting: false, ready: Promise.reject(stopped()) };
  let queue = queues.get(database);
  if (!queue) { queue = { owner: undefined, waiting: [] }; queues.set(database, queue); }
  const state = queue;
  const waiting = state.owner !== undefined;
  if (waiting && state.waiting.length >= 20) return { waiting: true, ready: Promise.reject(new Error(en('Twenty steps are already waiting. Retry after one finishes.'))) };
  const ready = new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const ticket: Waiter = {
      conversationId,
      grant() {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', ticket.cancel);
        state.owner = conversationId;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          state.owner = undefined;
          const next = state.waiting.shift();
          if (next) next.grant();
          else queues.delete(database);
        });
      },
      cancel() {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', ticket.cancel);
        const index = state.waiting.indexOf(ticket);
        if (index >= 0) state.waiting.splice(index, 1);
        reject(stopped());
      },
    };
    if (waiting) { state.waiting.push(ticket); signal.addEventListener('abort', ticket.cancel, { once: true }); }
    else ticket.grant();
  });
  return { waiting, ready };
}

/** Only actual granted provider steps are active; queued requests are not speculative work. */
export function sessionStepBusy(database: object, conversationId: string): boolean {
  return queues.get(database)?.owner === conversationId;
}
