import { en } from './i18n.ts';

/**
 * An in-process provider-step lease. No durable state or work is started by this queue.
 * mnt2: one step at a time per key (a conversation, or one shared scene) and at most `parallel`
 * granted steps per database (owner-wide). Waiters are served in arrival order; a free slot skips a
 * waiter whose own key is still busy, so one long chat does not hold the others back.
 */
export interface SessionStepTicket { waiting: boolean; ready: Promise<() => void> }
export interface SessionStepOptions { parallel?: number; key?: string }
interface Waiter { key: string; conversationId: string; parallel: number; grant: () => void; cancel: () => void }
interface Queue { active: Map<string, string>; waiting: Waiter[] }
const queues = new WeakMap<object, Queue>();
/** Waiting steps allowed per parallel step (twenty when one step runs at a time, as before). */
const WAITING_PER_STEP = 20;
export const PARALLEL_MAX = 8;
export const PARALLEL_DEFAULT = 4;
export function clampParallel(n: unknown, fallback = 1): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(PARALLEL_MAX, Math.max(1, v));
}

function pump(database: object, state: Queue): void {
  for (let i = 0; i < state.waiting.length;) {
    const w = state.waiting[i];
    if (state.active.has(w.key) || state.active.size >= w.parallel) { i++; continue; }
    state.waiting.splice(i, 1);
    w.grant();
  }
  if (!state.active.size && !state.waiting.length && queues.get(database) === state) queues.delete(database);
}

export function acquireSessionStep(database: object, conversationId: string, signal: AbortSignal, opts: SessionStepOptions = {}): SessionStepTicket {
  const stopped = () => signal.reason instanceof Error ? signal.reason : new Error('Stopped.');
  if (signal.aborted) return { waiting: false, ready: Promise.reject(stopped()) };
  const parallel = clampParallel(opts.parallel);
  const key = opts.key ?? conversationId;
  let queue = queues.get(database);
  if (!queue) { queue = { active: new Map(), waiting: [] }; queues.set(database, queue); }
  const state = queue;
  const free = !state.active.has(key) && state.active.size < parallel;
  if (!free && state.waiting.length >= WAITING_PER_STEP * parallel) return { waiting: true, ready: Promise.reject(new Error(en('Too many replies are waiting. Retry after one finishes.'))) };
  let granted = false;
  const ready = new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const ticket: Waiter = {
      key, conversationId, parallel,
      grant() {
        if (settled) return;
        settled = true;
        granted = true;
        signal.removeEventListener('abort', ticket.cancel);
        state.active.set(key, conversationId);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          state.active.delete(key);
          pump(database, state);
        });
      },
      cancel() {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', ticket.cancel);
        const index = state.waiting.indexOf(ticket);
        if (index >= 0) state.waiting.splice(index, 1);
        reject(stopped());
        pump(database, state);
      },
    };
    // Earlier arrivals keep their place: the newcomer joins the line, then the line is served.
    state.waiting.push(ticket);
    signal.addEventListener('abort', ticket.cancel, { once: true });
    pump(database, state);
  });
  return { waiting: !granted, ready };
}

/** Only actual granted provider steps are active; queued requests are not speculative work. */
export function sessionStepBusy(database: object, conversationId: string): boolean {
  const q = queues.get(database);
  if (!q) return false;
  for (const id of q.active.values()) if (id === conversationId) return true;
  return false;
}
