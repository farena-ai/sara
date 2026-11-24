// Delivers due reminders into chat. Runs every 15 s; late reminders (server was down) are still
// delivered, marked late. A conversation in the middle of a turn is skipped until the turn ends, so
// a reminder never lands between a tool call and its result.
import { ownChat } from './home-chat.ts';
import { alertApps, alertPlace } from './destinations.ts';
import { legacyTick } from './legacy.ts';
import { familyTick } from './family.ts';
import { giftsTick } from './gifts.ts';
import { trimTick } from './money/trim.ts';
import { guard } from './log.ts';
import { everyJob, tickJob, type EveryJob } from './tick-jobs.ts';
import type { AppContext } from './chat.ts';
import { formatLocal, nextOccurrence, type PlannerStore, type Reminder, zonedParts } from './planner.ts';
import { healthTick } from './health-log.ts';
import { photoLibraryTick } from './photo-library.ts';
import { SharedProjects, sharedProjectsOf } from './shared-projects.ts';
import { nudgeTick, reminderMayGo } from './nudges.ts';
import { herWeekTick } from './her-week.ts';
import { coachTick } from './health-coach.ts';

const LATE_MS = 5 * 60_000;

export function reminderText(r: Reminder, now: Date, timeZone?: string): string {
  const late = now.getTime() - new Date(r.dueAt).getTime() > LATE_MS;
  return `Reminder: ${r.text}${late ? ` (this was due ${formatLocal(r.dueAt, timeZone)}; sorry it's late)` : ''}`;
}

export class ReminderScheduler {
  readonly #app: AppContext;
  readonly #planner: PlannerStore;
  readonly #owns: (r: Reminder) => boolean;
  #timer: EveryJob | undefined;

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
    this.#timer = everyJob('reminders', intervalMs, () => this.tick());
  }

  stop(): void {
    this.#timer?.stop();
  }

  /** Returns the number of reminders delivered. */
  tick(): number {
    const { store } = this.#app;
    const now = this.#app.now();
    const tz = this.#app.settings.get().timeZone;
    let delivered = 0;
    try {
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
    } finally {
      // X0 (src/tick-jobs.ts): the jobs below run even when a reminder could not be delivered, each on its own.
      this.#jobs(now);
    }
    return delivered;
  }

  /** Everything else that rides this tick. One job failing never stops the next (src/tick-jobs.ts). */
  #jobs(now: Date): void {
    // W1.2 (docs/NUDGES.md): the day's one roundup of smaller nudges, after quiet hours.
    tickJob('nudges', () => nudgeTick(this.#app, now));
    tickJob('herweek', () => herWeekTick(this.#app, now)); // W1.5: the weekly check-in
    tickJob('healthcoach', () => coachTick(this.#app, now)); // W4.4: weekly health check-in (opt-in)
    // Phase 118 (PERSIST §3.1 P4): the loops' clock is this tick (no new timer); goals' approval waits too.
    tickJob('loops', () => this.#app.loops?.due(now));
    tickJob('goals', () => this.#app.goals?.tick(now.getTime()));
    tickJob('legacy', () => legacyTick(this.#app)); // V5.3: reminders, waiting period, the page opening
    // E4: file/log watches ride the same tick (a plain read; no model, no timer of their own).
    tickJob('watches', () => this.#app.watches?.due(now));
    // E1: "tell me when" on live data (prices, games, odds) on the same tick; the checks run async, one pass at a time.
    tickJob('live watches', () => this.#app.liveWatches?.due(now));
    // N2: automations (schedules, calendar triggers) on the same tick.
    tickJob('automations', () => this.#app.automations?.due(now));
    // R3: errands take their next step, check follow-ups and deadlines on the same tick.
    tickJob('errands', () => this.#app.errands?.due(now));
    // S3: long-running goals check progress, nudge, propose new plans and send weekly summaries on the same tick.
    tickJob('long goals', () => this.#app.longGoals?.due(now));
    // U4.23: one "cards due" reminder a day at the chosen time.
    tickJob('study', () => this.#app.study?.due(now));
    // S4: last contact, waiting replies and promises from mail, calendars and rooms (at most every 30 minutes).
    tickJob('people ties', () => this.#app.peopleTies?.due(now));
    // V2.7: gift reminders ahead of birthdays and yearly dates on People cards.
    tickJob('gifts', () => giftsTick(this.#app, now));
    // S9a: messages to linked servers that are offline are retried, and old ones purged, on the same tick.
    tickJob('messages', () => this.#app.messages?.due(now));
    // U4.26: shared projects send what the friends have not acknowledged yet (offline catch-up).
    if (SharedProjects.exists(this.#app)) tickJob('shared projects', () => sharedProjectsOf(this.#app)?.due(now));
    // HANDSFREE 3a: calendars added by link are read again every 15 minutes (in the background).
    tickJob('calendar links', () => (this.#app.mailAccounts as { calendarLinks?: { tick(): void } } | undefined)?.calendarLinks?.tick());
    // R8 (docs/FAMILY.md): the parents' weekly chores summary (the owner's main companion, once a week).
    tickJob('family', () => familyTick(this.#app, now));
    // U4.22: medicine dose reminders (only where a health log exists).
    tickJob('health', () => healthTick(this.#app, now));
    // V2.8 (docs/TRIM.md): the monthly "maybe cancel" note (once a month, where Money alerts go).
    tickJob('trim', () => trimTick(this.#app, now));
    // N3: from your inbox (new mail at most every 10 minutes, package alerts) on the same tick.
    tickJob('inbox', () => this.#app.inbox?.due(now));
    // V4.1: the photo folder is looked through every few hours and a couple of photos described (local model only).
    tickJob('photo library', () => photoLibraryTick(this.#app));
    // S6: travel: check-in, leave-by and flight status alerts on the same tick.
    tickJob('travel', () => this.#app.travel?.due(now));
    // E2: product watches (one due page check per tick, in the background; src/shopping/watch.ts).
    tickJob('product watches', () => this.#app.productWatches?.due(now));
    // C6: due topic refreshes join the learning queue; a waiting "learned something new" goes out.
    tickJob('learn topics', () => this.#app.learnTopics?.due(now));
    // EC12/EC13: crews' slots and the overnight memory tidy ride the same tick.
    tickJob('crews', () => this.#app.crews?.due(now));
    // ROADMAP_T: self-repair looks for problems at most every 15 minutes (level 1 fixes per the permission).
    tickJob('repair', () => this.#app.repair?.due(now));
    // C10: workers' queues (time limits, the next job, held alerts).
    tickJob('workers', () => this.#app.workers?.tick(now));
    tickJob('memory tidy', () => this.#app.memoryTidy?.due(now));
    // C12: the working-style night pass (fading, usual hours) on the same tick and quiet hours.
    tickJob('working style', () => this.#app.workingStyle?.due(now));
  }

  /** A call (if the owner wants one and it rings), otherwise a chat message and a notification. */
  /**
   * ALERTDEST: the chat it was set in (none given: her latest chat, as before), or where the person
   * chose for reminders; a chat named "Reminders" when the one it was set in is gone.
   */
  #where(r: Reminder): string {
    const { store } = this.#app;
    // Y5: a reminder set outside any chat (Planner, a tool on a schedule) goes to her home chat, not to
    // whichever chat is first in the list.
    const origin = () => (r.conversationId ? store.getConversation(r.conversationId)?.id : (ownChat(this.#app) ?? store.listConversations()[0] ?? store.createConversation({ title: 'Reminders' })).id);
    return alertPlace(this.#app, 'reminders', { origin }).conversationId ?? origin() ?? store.createConversation({ title: 'Reminders' }).id;
  }

  #deliver(r: Reminder, conversationId: string, text: string, next: Date | null, anchor?: number): void {
    // W1.2: a reminder she made herself (renewals, gifts, upkeep, trials) asks the nudge gate;
    // held ones wait for the roundup. Reminders the person set never ask.
    const gate = reminderMayGo(this.#app, r.id, r.text);
    if (!gate.go) {
      this.#planner.markFired(r.id, next, anchor);
      return;
    }
    const calls = this.#app.calls;
    if (calls?.wants(r.call ? 'scheduled' : 'reminder', r.call)) {
      const out = calls.ring({ kind: r.call ? 'scheduled' : 'reminder', reason: text, conversationId });
      if ('ring' in out) {
        this.#planner.markFired(r.id, next, anchor);
        return;
      }
    }
    const msg = this.#app.store.addMessage(conversationId, 'assistant', text, { reminder: { id: r.id, dueAt: r.dueAt, repeat: r.repeat, ...(r.placeId ? { placeId: r.placeId } : {}) }, ...(gate.kind ? { nudge: { kind: gate.kind, why: gate.why } } : {}) });
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
