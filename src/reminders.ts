// Delivers due reminders into chat. Runs every 15 s; late reminders (server was down) are still
// delivered, marked late. A conversation in the middle of a turn is skipped until the turn ends, so
// a reminder never lands between a tool call and its result.
import { alertApps, alertPlace } from './destinations.ts';
import { familyTick } from './family.ts';
import { guard } from './log.ts';
import type { AppContext } from './chat.ts';
import { formatLocal, nextOccurrence, type PlannerStore, type Reminder, zonedParts } from './planner.ts';
import { healthTick } from './health-log.ts';
import { SharedProjects, sharedProjectsOf } from './shared-projects.ts';

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
      const conv = { id: this.#where(r) };
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
    // E1: "tell me when" on live data (prices, games, odds) on the same tick; the checks run async, one pass at a time.
    this.#app.liveWatches?.due(now);
    // N2: automations (schedules, calendar triggers) on the same tick.
    this.#app.automations?.due(now);
    // R3: errands take their next step, check follow-ups and deadlines on the same tick.
    this.#app.errands?.due(now);
    // S3: long-running goals check progress, nudge, propose new plans and send weekly summaries on the same tick.
    this.#app.longGoals?.due(now);
    // U4.23: one "cards due" reminder a day at the chosen time.
    this.#app.study?.due(now);
    // S4: last contact, waiting replies and promises from mail, calendars and rooms (at most every 30 minutes).
    void this.#app.peopleTies?.due(now);
    // S9a: messages to linked servers that are offline are retried, and old ones purged, on the same tick.
    void this.#app.messages?.due(now).catch(() => undefined);
    // U4.26: shared projects send what the friends have not acknowledged yet (offline catch-up).
    if (SharedProjects.exists(this.#app)) void sharedProjectsOf(this.#app)?.due(now).catch(() => undefined);
    // HANDSFREE 3a: calendars added by link are read again every 15 minutes (in the background).
    (this.#app.mailAccounts as { calendarLinks?: { tick(): void } } | undefined)?.calendarLinks?.tick();
    // R8 (docs/FAMILY.md): the parents' weekly chores summary (the owner's main companion, once a week).
    familyTick(this.#app, now);
    // U4.22: medicine dose reminders (only where a health log exists).
    healthTick(this.#app, now);
    // N3: from your inbox (new mail at most every 10 minutes, package alerts) on the same tick.
    this.#app.inbox?.due(now);
    // S6: travel: check-in, leave-by and flight status alerts on the same tick.
    this.#app.travel?.due(now);
    // E2: product watches (one due page check per tick, in the background; src/shopping/watch.ts).
    this.#app.productWatches?.due(now);
    // C6: due topic refreshes join the learning queue; a waiting "learned something new" goes out.
    this.#app.learnTopics?.due(now);
    // EC12/EC13: crews' slots and the overnight memory tidy ride the same tick.
    this.#app.crews?.due(now);
    // ROADMAP_T: self-repair looks for problems at most every 15 minutes (level 1 fixes per the permission).
    this.#app.repair?.due(now);
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
  /**
   * ALERTDEST: the chat it was set in (none given: her latest chat, as before), or where the person
   * chose for reminders; a chat named "Reminders" when the one it was set in is gone.
   */
  #where(r: Reminder): string {
    const { store } = this.#app;
    const origin = () => (r.conversationId ? store.getConversation(r.conversationId)?.id : (store.listConversations()[0] ?? store.createConversation({ title: 'Reminders' })).id);
    return alertPlace(this.#app, 'reminders', { origin }).conversationId ?? origin() ?? store.createConversation({ title: 'Reminders' }).id;
  }

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
    alertApps(this.#app, alertPlace(this.#app, 'reminders', { origin: () => conversationId, create: false }), text, false);
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
      const conv = { id: this.#where(r) };
      this.#deliver(r, conv.id, `Reminder (${event === 'arrive' ? 'you’re at' : 'you just left'} ${place.name}): ${r.text}`, null);
      delivered++;
    }
    if (delivered) this.#app.events?.publish({ type: 'planner', what: 'reminders' });
    return delivered;
  }
}
