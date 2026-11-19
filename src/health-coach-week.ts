// W4.4 (docs/design/W4COACH.md): the health coach's week, computed in code from the person's own
// sealed log (U4.22 entries and doses + V4.3 imported days). No model ever sees any of it. Kept free
// of server imports so src/caregiver.ts can build a shared summary from it.
//
// Wording rules (test/w4-coach.test.ts): every line she shows lives in COACH_TEXTS or RED_FLAG_TEXTS.
// Goals are small habits (mark doses, a little more sleep, a few more steps, log mood), never weight
// and never anything about medicines beyond marking them. A measurement with a red-flag value shows
// only "Talk to your doctor about …": no number, no comparison and no goal.
import type { AppContext } from './chat.ts';
import { type Entry, HealthError, type HealthLog } from './health-log.ts';
import { en } from './i18n.ts';

export const COACH_TEXTS = {
  notAdvice: en('Your own log, not medical advice. Ask a doctor or pharmacist about anything here.'),
  meds: en('Mark each dose taken or skipped on {n} days this week.'),
  sleep: en('Sleep about {h} hours on {n} nights this week.'),
  steps: en('Walk about {steps} steps on {n} days this week.'),
  mood: en('Log your mood on {n} days this week.'),
  checkin: en('Your week in Health is ready: a short summary and small goals you can accept or skip. Open Health to see it.'),
  adults: en('The health coach is for adults.'),
  noGoal: en('That goal is not on offer this week.'),
  doctor: en('Something this week is worth a word with a doctor.'),
} as const;

/** One line per kind of red flag; the person's own card shows these and nothing else about it. */
export const RED_FLAG_TEXTS = {
  'blood pressure': en('Talk to your doctor about your blood pressure readings this week.'),
  'heart rate': en('Talk to your doctor about your heart rate readings this week.'),
  glucose: en('Talk to your doctor about your glucose readings this week.'),
  temperature: en('Talk to your doctor about your temperature readings this week.'),
  sleep: en('Talk to your doctor about how you have been sleeping.'),
  weight: en('Talk to your doctor about the change in your weight.'),
  mood: en('Talk to your doctor about how you have been feeling.'),
  symptom: en('Talk to your doctor about the symptoms you logged this week.'),
} as const;
export type FlagName = keyof typeof RED_FLAG_TEXTS;

export type MetricName = 'sleep' | 'steps' | 'weight' | 'mood' | 'meds';
export interface CoachMetric {
  name: MetricName;
  /** Days with a value this week (meds: doses counted). */
  days: number;
  value?: number;
  prev?: number;
  /** Percent against the week before. */
  change?: number;
  unit: string;
  flag?: true;
}
export type GoalKind = 'meds' | 'sleep' | 'steps' | 'mood';
export interface CoachGoal {
  id: string;
  kind: GoalKind;
  key: string;
  /** Hours (sleep) or steps; 0 for meds and mood. */
  target: number;
  /** Days (or nights) to reach it. */
  n: number;
  status: 'proposed' | 'accepted';
  /** Accepted: days reached so far in its 7 days, and when those 7 days end. */
  done?: number;
  of?: number;
  until?: string;
}
export interface StoredGoal {
  id: string;
  kind: GoalKind;
  target: number;
  n: number;
  status: 'accepted' | 'skipped';
  /** Local day it was accepted or skipped. */
  day: string;
}
export interface CoachState {
  slot?: string;
  goals: StoredGoal[];
}
export interface CoachWeek {
  from: string;
  to: string;
  metrics: CoachMetric[];
  flags: { name: FlagName; key: string }[];
  goals: CoachGoal[];
  notAdvice: string;
  checkin: boolean;
}
/** What a caregiver sees when the person shared their weekly summary (V5.4 consent). */
export interface CoachShare {
  from: string;
  to: string;
  metrics: CoachMetric[];
  goals: { kind: GoalKind; key: string; target: number; n: number; done: number; of: number }[];
  doctor: boolean;
}

const DAY = 86_400_000;
const MISSED_MS = 2 * 3_600_000;
/** A goal that was turned down is not offered again for four weeks. */
const SKIP_DAYS = 28;
export const MAX_GOALS = 2;

export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const r1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const pct = (a?: number, b?: number) => (a !== undefined && b ? Math.round(((a - b) / b) * 100) : undefined);

export function isKid(app?: AppContext): boolean {
  return Boolean(app?.member?.child?.());
}

export function coachState(h: HealthLog): CoachState {
  const s = h.coachState<Partial<CoachState>>() ?? {};
  return { ...(s.slot ? { slot: s.slot } : {}), goals: Array.isArray(s.goals) ? s.goals : [] };
}

/** The coach's week: the 7 days up to today against the 7 before, plus goals and red flags. */
export function coachWeek(h: HealthLog, now: Date, app?: AppContext): CoachWeek {
  if (isKid(app)) throw new HealthError(403, COACH_TEXTS.adults);
  const to = h.today(now);
  const from = addDays(to, -6);
  const pFrom = addDays(to, -13);
  const dayOf = (e: Entry) => (e.imp && e.name !== 'weight' ? e.imp.slice(e.imp.indexOf('@') + 1) : h.today(new Date(e.at)));
  const all = h.entries({ from: new Date(Date.parse(`${addDays(to, -21)}T00:00:00Z`) - DAY).toISOString() });
  const inWeek = (d: string) => d >= from && d <= to;
  const inPrev = (d: string) => d >= pFrom && d < from;
  // Per-day values (rows come newest first: the day's latest value).
  const perDay = (name: string) => {
    const m = new Map<string, number>();
    for (const e of all) if (e.name === name && typeof e.value === 'number' && !m.has(dayOf(e))) m.set(dayOf(e), e.value);
    return m;
  };
  const steps = perDay('steps');
  const sleep = perDay('sleep');
  const moodDays = new Map<string, number[]>();
  for (const e of all) if (e.type === 'mood' && typeof e.value === 'number') moodDays.set(dayOf(e), [...(moodDays.get(dayOf(e)) ?? []), e.value]);
  const weekVals = (m: Map<string, number>, f: (d: string) => boolean) => [...m].filter(([d]) => f(d)).map(([, v]) => v);

  const metrics: CoachMetric[] = [];
  const daily = (name: 'steps' | 'sleep', m: Map<string, number>, unit: string, round: (x: number) => number) => {
    const w = weekVals(m, inWeek);
    if (!w.length) return;
    const value = round(mean(w)!);
    const p = weekVals(m, inPrev);
    const prev = p.length ? round(mean(p)!) : undefined;
    const change = pct(value, prev);
    metrics.push({ name, days: w.length, value, unit, ...(prev !== undefined ? { prev } : {}), ...(change !== undefined ? { change } : {}) });
  };
  daily('sleep', sleep, 'h', r1);
  daily('steps', steps, 'steps', Math.round);
  // Weight: the newest weighing this week against the newest the week before.
  const weights = all.filter((e) => e.name === 'weight' && typeof e.value === 'number');
  const wNow = weights.find((e) => inWeek(dayOf(e)));
  const wPrev = weights.find((e) => inPrev(dayOf(e)));
  if (wNow) {
    const change = pct(wNow.value, wPrev?.value);
    metrics.push({ name: 'weight', days: weights.filter((e) => inWeek(dayOf(e))).length, value: r1(wNow.value!), unit: wNow.unit ?? '', ...(wPrev ? { prev: r1(wPrev.value!) } : {}), ...(change !== undefined ? { change } : {}) });
  }
  const moodWeek = [...moodDays].filter(([d]) => inWeek(d)).flatMap(([, v]) => v);
  if (moodWeek.length) {
    const prev = mean([...moodDays].filter(([d]) => inPrev(d)).flatMap(([, v]) => v));
    metrics.push({ name: 'mood', days: [...moodDays.keys()].filter(inWeek).length, value: r1(mean(moodWeek)!), unit: '/10', ...(prev !== undefined ? { prev: r1(prev) } : {}) });
  }
  // Medicines marked taken: taken / (taken + skipped + missed) for doses due this week.
  const doses = h.doses({ from: new Date(Date.parse(`${addDays(to, -21)}T00:00:00Z`) - DAY).toISOString() });
  const counted = (f: (d: string) => boolean) => doses.filter((d) => f(h.today(new Date(d.due))) && (d.status !== 'due' || Date.parse(d.due) <= now.getTime() - MISSED_MS));
  const dw = counted(inWeek);
  if (dw.length) {
    const dp = counted(inPrev);
    const rate = (xs: typeof dw) => Math.round((xs.filter((d) => d.status === 'taken').length / xs.length) * 100);
    metrics.push({ name: 'meds', days: dw.length, value: rate(dw), unit: '%', ...(dp.length ? { prev: rate(dp) } : {}) });
  }

  // Red flags (fixed thresholds, this week only).
  const flagged = new Set<FlagName>();
  for (const e of all) {
    if (!inWeek(dayOf(e)) || typeof e.value !== 'number') continue;
    const v = e.value;
    if (e.name === 'blood pressure' && (v >= 140 || v < 90 || (e.value2 ?? 0) >= 90)) flagged.add('blood pressure');
    if ((e.name === 'pulse' || e.name === 'heart rate') && (v > 120 || v < 40)) flagged.add('heart rate');
    if (e.name === 'resting heart rate' && (v > 100 || v < 40)) flagged.add('heart rate');
    if (e.name === 'glucose' && (e.unit === 'mmol/L' ? v >= 13.9 || v < 3.9 : v >= 250 || v < 70)) flagged.add('glucose');
    if (e.name === 'temperature' && (e.unit === '°C' ? v >= 38 : v >= 100.4)) flagged.add('temperature');
    if (e.type === 'symptom' && v >= 8 && (e.scale ?? 10) === 10) flagged.add('symptom');
  }
  const sl = metrics.find((m) => m.name === 'sleep');
  if (sl && sl.days >= 3 && sl.value! < 4) flagged.add('sleep');
  const wt = metrics.find((m) => m.name === 'weight');
  if (wt && wt.prev && Math.abs((wt.value! - wt.prev) / wt.prev) >= 0.05) flagged.add('weight');
  const md = metrics.find((m) => m.name === 'mood');
  if ((md && moodWeek.length >= 2 && md.value! <= 2) || h.checkins(14).some((c) => c.status === 'help' && inWeek(c.day))) flagged.add('mood');
  for (const m of metrics) {
    if (!flagged.has(m.name as FlagName)) continue;
    delete m.value;
    delete m.prev;
    delete m.change;
    m.flag = true;
  }

  // Goals: accepted ones with their progress, then at most two in all with new small ones.
  const st = coachState(h);
  const reached = (g: Pick<StoredGoal, 'kind' | 'target'>, d: string) => {
    if (g.kind === 'steps') return (steps.get(d) ?? 0) >= g.target;
    if (g.kind === 'sleep') return (sleep.get(d) ?? 0) >= g.target;
    if (g.kind === 'mood') return moodDays.has(d);
    const ds = doses.filter((x) => h.today(new Date(x.due)) === d);
    return ds.length > 0 && ds.every((x) => x.status !== 'due');
  };
  const goals: CoachGoal[] = [];
  for (const g of st.goals) {
    if (g.status !== 'accepted') continue;
    const until = addDays(g.day, 6);
    if (until < addDays(to, -7)) continue; // its result stays one more week, then it goes
    let done = 0;
    for (let i = 0; i < 7; i++) if (addDays(g.day, i) <= to && reached(g, addDays(g.day, i))) done++;
    goals.push({ id: g.id, kind: g.kind, key: COACH_TEXTS[g.kind], target: g.target, n: g.n, status: 'accepted', done, of: g.n, until });
  }
  const active = goals.filter((g) => g.until! >= to);
  // A goal turned down this week still takes its place: Not now never brings a new one in.
  const declined = st.goals.filter((g) => g.status === 'skipped' && g.id.endsWith(`@${from}`)).length;
  const quiet = (k: GoalKind) => active.some((g) => g.kind === k) || st.goals.some((g) => g.kind === k && ((g.status === 'skipped' && g.day >= addDays(to, -SKIP_DAYS)) || g.id === `${k}@${from}`));
  const m = (n: MetricName) => metrics.find((x) => x.name === n && !x.flag);
  const offer: CoachGoal[] = [];
  const meds = m('meds');
  if (meds && meds.days >= 3 && meds.value! < 90) offer.push({ id: `meds@${from}`, kind: 'meds', key: COACH_TEXTS.meds, target: 0, n: 5, status: 'proposed' });
  const sp = m('sleep');
  if (sp && sp.days >= 3 && sp.value! < 7) offer.push({ id: `sleep@${from}`, kind: 'sleep', key: COACH_TEXTS.sleep, target: Math.min(7.5, Math.round((sp.value! + 0.25) * 2) / 2), n: 4, status: 'proposed' });
  const stp = m('steps');
  if (stp && stp.days >= 3 && stp.value! < 8000) offer.push({ id: `steps@${from}`, kind: 'steps', key: COACH_TEXTS.steps, target: Math.min(8000, Math.ceil((stp.value! + 500) / 500) * 500), n: 4, status: 'proposed' });
  const anyLogged = all.some((e) => inWeek(dayOf(e))) || dw.length > 0;
  if (anyLogged && !flagged.has('mood') && [...moodDays.keys()].filter(inWeek).length < 3) offer.push({ id: `mood@${from}`, kind: 'mood', key: COACH_TEXTS.mood, target: 0, n: 3, status: 'proposed' });
  for (const g of offer) if (active.length + declined + goals.filter((x) => x.status === 'proposed').length < MAX_GOALS && !quiet(g.kind)) goals.push(g);

  return { from, to, metrics, flags: [...flagged].map((name) => ({ name, key: RED_FLAG_TEXTS[name] })), goals, notAdvice: COACH_TEXTS.notAdvice, checkin: h.settings().coach };
}

/** The caregiver's copy: no mood, no proposed goals, red flags reduced to one plain line. */
export function coachShare(w: CoachWeek): CoachShare {
  return {
    from: w.from,
    to: w.to,
    metrics: w.metrics.filter((m) => m.name !== 'mood' && !m.flag),
    goals: w.goals.filter((g) => g.status === 'accepted').map((g) => ({ kind: g.kind, key: g.key, target: g.target, n: g.n, done: g.done ?? 0, of: g.of ?? g.n })),
    doctor: w.flags.length > 0,
  };
}
