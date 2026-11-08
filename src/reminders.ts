// Delivers due reminders into chat. Runs every 15 s; late reminders (server was down) are still
// delivered, marked late. A conversation in the middle of a turn is skipped until the turn ends, so
// a reminder never lands between a tool call and its result.
import { guard } from './log.ts';
import type { AppContext } from './chat.ts';
import { formatLocal, nextOccurrence, type PlannerStore, type Reminder, zonedParts } from './planner.ts';

const LATE_MS = 5 * 60_000;

export function reminderText(r: Reminder, now: Date, timeZone?: string): string {
  const late = now.getTime() - new Date(r.dueAt).getTime() > LATE_MS;
  return `Reminder: ${r.text}${late ? ` (this was due ${formatLocal(r.dueAt, timeZone)}; sorry it's late)` : ''}`;
}

export class ReminderScheduler {
  readonly #app: AppContext;
  readonly #planner: PlannerStore;
  readonly #owns: (r: Reminder) => boolean;
  #timer: NodeJS.Timeout | undefined;

  /**
   * `owns`: Phase 31, with a planner shared by several companions, each delivers only the
   * reminders set in her own conversations (the first companion also takes orphaned ones).
   */
  constructor(app: AppContext, planner: PlannerStore, opts: { owns?: (r: Reminder) => boolean } = {}) {
    this.#app = app;
    this.#planner = planner;
    this.#owns = opts.owns ?? (() => true);
  }

  start(intervalMs = 15_000): void {
    guard('reminders', () => this.tick());
    this.#timer = setInterval(() => guard('reminders', () => this.tick()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Returns the number of reminders delivered. */
  tick(): number {
    const { store } = this.#app;
    const now = this.#app.now();
    const tz = this.#app.settings.get().timeZone;
    let delivered = 0;
    for (const r of this.#planner.dueReminders(now)) {
      if (!this.#owns(r)) continue;
      let conv = r.conversationId ? store.getConversation(r.conversationId) : undefined;
      conv ??= store.listConversations()[0] ?? store.createConversation({ title: 'Reminders' });
      if (this.#app.isBusy?.(conv.id)) continue;
      // Phase 26: ring instead, when the owner asked for a call (or wants every reminder as one).
      // Monthly: the day it was first set for (the 31st), kept from the first time it fires.
      const anchor = r.repeat === 'monthly' ? (r.anchorDay ?? zonedParts(new Date(r.dueAt), tz).d) : undefined;
      this.#deliver(r, conv.id, reminderText(r, now, tz), nextOccurrence(r.dueAt, r.repeat, now, tz, anchor), anchor);
      delivered++;
    }
    if (delivered) this.#app.events?.publish({ type: 'planner', what: 'reminders' });
    // Phase 118 (PERSIST §3.1 P4): the loops' clock is this tick (no new timer); goals' approval waits too.
    this.#app.loops?.due(now);
    this.#app.goals?.tick(now.getTime());
    // E4: file/log watches ride the same tick (a plain read; no model, no timer of their own).
    this.#app.watches?.due(now);
    // C6: due topic refreshes join the learning queue; a waiting "learned something new" goes out.
    this.#app.learnTopics?.due(now);
    // EC12/EC13: crews' slots and the overnight memory tidy ride the same tick.
    this.#app.crews?.due(now);
    // C10: workers' queues (time limits, the next job, held alerts).
    this.#app.workers?.tick(now);
    void this.#app.memoryTidy?.due(now).catch((err: Error) => console.warn(`memory tidy: ${err.message}`));
    // C12: the working-style night pass (fading, usual hours) on the same tick and quiet hours.
    try {
      this.#app.workingStyle?.due(now);
    } catch (err) {
      console.warn(`working style: ${(err as Error).message}`);
    }
    return delivered;
  }

  /** A call (if the owner wants one and it rings), otherwise a chat message and a notification. */
  #deliver(r: Reminder, conversationId: string, text: string, next: Date | null, anchor?: number): void {
    const calls = this.#app.calls;
    if (calls?.wants(r.call ? 'scheduled' : 'reminder', r.call)) {
      const out = calls.ring({ kind: r.call ? 'scheduled' : 'reminder', reason: text, conversationId });
      if ('ring' in out) {
        this.#planner.markFired(r.id, next, anchor);
        return;
      }
    }
    const msg = this.#app.store.addMessage(conversationId, 'assistant', text, { reminder: { id: r.id, dueAt: r.dueAt, repeat: r.repeat, ...(r.placeId ? { placeId: r.placeId } : {}) } });
    this.#planner.markFired(r.id, next, anchor);
    this.#app.events?.publish({ type: 'message', conversationId, message: msg, reason: 'reminder' });
  }

  /**
   * Phase 29: the phone says the owner arrived at (or left) a saved place. Only that event comes
   * from the phone, never the location. Returns the number of reminders delivered.
   */
  atPlace(placeId: number, event: 'arrive' | 'leave'): number {
    const place = this.#planner.place(placeId);
    if (!place) return 0;
    const { store } = this.#app;
    let delivered = 0;
    for (const r of this.#planner.placeReminders(placeId, event)) {
      if (!this.#owns(r)) continue;
      let conv = r.conversationId ? store.getConversation(r.conversationId) : undefined;
      conv ??= store.listConversations()[0] ?? store.createConversation({ title: 'Reminders' });
      this.#deliver(r, conv.id, `Reminder (${event === 'arrive' ? 'you’re at' : 'you just left'} ${place.name}): ${r.text}`, null);
      delivered++;
    }
    if (delivered) this.#app.events?.publish({ type: 'planner', what: 'reminders' });
    return delivered;
  }
}
