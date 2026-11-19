// W4.4 (docs/design/W4COACH.md): a private health coach. The week itself is computed in code
// (src/health-coach-week.ts); this file adds Accept / Not now for her small goals and the opt-in
// weekly check-in. The check-in goes through postAlert (W1.2 nudge gate, the person's chosen place)
// and never carries a value or a medicine name, so chat apps, phone notices and later model turns
// learn nothing private. Owner and adult members each from their own sealed log; kids never.
import type { AppContext } from './chat.ts';
import { postAlert } from './destinations.ts';
import { COACH_TEXTS, type CoachWeek, coachState, coachWeek, isKid } from './health-coach-week.ts';
import { HealthError, HealthLog, healthFor } from './health-log.ts';
import { trOwner } from './i18n.ts';
import { zonedParts } from './planner.ts';

export { coachShare, coachWeek, COACH_TEXTS, MAX_GOALS, RED_FLAG_TEXTS } from './health-coach-week.ts';
export type { CoachShare, CoachWeek } from './health-coach-week.ts';

/** The check-in slot: Sundays at 18:00 where the person lives. */
const SLOT_DAY = 0;
const SLOT_MIN = 18 * 60;
/** A slot found later than this (server was off) is remembered, not sent. */
const LATE_MIN = 24 * 60;

/** This person's coach card (403 for a child). */
export function coachFor(app: AppContext): CoachWeek {
  return coachWeek(healthFor(app), app.now(), app);
}

/** Accept or turn down one of this week's offered goals. */
export function coachGoalAction(app: AppContext, id: string, action: 'accept' | 'skip'): CoachWeek {
  const h = healthFor(app);
  const w = coachWeek(h, app.now(), app);
  const g = w.goals.find((x) => x.id === id && x.status === 'proposed');
  if (!g) throw new HealthError(404, COACH_TEXTS.noGoal);
  const st = coachState(h);
  st.goals = [...st.goals.filter((x) => x.id !== id), { id, kind: g.kind, target: g.target, n: g.n, status: action === 'accept' ? ('accepted' as const) : ('skipped' as const), day: w.to }].slice(-40);
  h.setCoachState(st);
  return coachWeek(h, app.now(), app);
}

function slotOf(now: Date, tz: string | undefined, today: string): { slot: string; lateMin: number } {
  const p = zonedParts(now, tz);
  const nowMin = p.h * 60 + p.mi;
  let back = (p.wd - SLOT_DAY + 7) % 7;
  if (back === 0 && nowMin < SLOT_MIN) back = 7;
  const slot = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  return { slot, lateMin: back * 1440 + nowMin - SLOT_MIN };
}

/** ReminderScheduler.tick: the weekly check-in, only when the person turned it on. Returns the chat it went to. */
export function coachTick(app: AppContext, now: Date = app.now()): string | undefined {
  try {
    if (isKid(app) || !HealthLog.exists(app)) return undefined;
    const h = healthFor(app);
    if (!h.settings().coach) return undefined;
    const { slot, lateMin } = slotOf(now, app.settings.get().timeZone || undefined, h.today(now));
    const st = coachState(h);
    if (st.slot === slot) return undefined;
    const first = st.slot === undefined;
    h.setCoachState({ ...st, slot });
    // A fresh look (just switched on, server was off) never sends an old week at once.
    if (first || lateMin > LATE_MIN) return undefined;
    const w = coachWeek(h, now, app);
    if (!w.metrics.length && !w.flags.length) return undefined;
    return postAlert(app, 'healthcoach', { role: 'assistant', reason: 'proactive', nudge: { kind: 'healthcoach', value: 0.6 }, content: trOwner(COACH_TEXTS.checkin, app.settings.get()), meta: { health: true, coach: { week: w.from } } });
  } catch {
    return undefined; // a broken log never stops the tick
  }
}
