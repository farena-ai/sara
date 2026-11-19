// V5.4 (docs/design/V5CARE.md): caregiver mode on top of the U4.22 health log.
//
// Consent lives with the person cared for (HealthLog.care(), sealed): per caregiver, "missed doses"
// and/or "daily check-ins". A caregiver is an adult in the same household (never a child, never
// yourself). The caregiver view is built here, in code, from the person's own log on every request:
// only the consented parts, never chats, symptoms, mood, readings, appointments or notes. So
// withdrawing consent hides everything at once (the next request is refused).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { type CareContact, type CareGrant, type CheckinStatus, HealthError, HealthLog, healthFor } from './health-log.ts';
import { en, trOwner } from './i18n.ts';
import { type CoachShare, coachShare, coachWeek } from './health-coach-week.ts';

const HOUR = 3_600_000;
/** A dose still open this long after its time counts as missed. */
export const MISSED_AFTER_MS = 2 * HOUR;

export interface CareView {
  id: string;
  name: string;
  doses?: { missed: { med: string; due: string }[]; today: { taken: number; skipped: number; open: number } };
  checkins?: { day: string; status: CheckinStatus }[];
  /** W4.4: the coach's weekly summary, when shared. */
  summary?: CoachShare;
}

const me = (app: AppContext): string | undefined => app.family?.person;
const peopleOf = (app: AppContext) => app.family?.people() ?? [];

/** Adults in the household this person may pick as a caregiver (never themselves, never a child). */
export function careCandidates(app: AppContext): { id: string; name: string }[] {
  const self = me(app);
  return peopleOf(app)
    .filter((p) => p.id !== self && !p.child)
    .map((p) => ({ id: p.id, name: p.name }));
}

/** Adds, changes or (both off) withdraws one caregiver's consent. Returns the grant, or undefined when withdrawn. */
export function setCareGrant(app: AppContext, b: Record<string, unknown>): CareGrant | undefined {
  const person = String(b.person ?? '');
  if (person && person === me(app)) throw new HealthError(400, en('You cannot be your own caregiver.'));
  const p = peopleOf(app).find((x) => x.id === person);
  if (!p) throw new HealthError(400, en('That person is not in this household.'));
  if (p.child) throw new HealthError(400, en('A caregiver must be an adult in this household.'));
  const h = healthFor(app);
  const c = h.care();
  const doses = b.doses === true;
  const checkins = b.checkins === true;
  const summary = b.summary === true;
  if (!doses && !checkins && !summary) {
    h.removeCareGrant(person);
    return undefined;
  }
  const old = c.grants.find((g) => g.person === person);
  const grant: CareGrant = { person, doses, checkins, ...(summary ? { summary } : {}), since: old?.since ?? app.now().toISOString(), ...(old?.told ? { told: old.told } : {}) };
  h.setCare({ ...c, grants: [...c.grants.filter((g) => g.person !== person), grant] });
  return grant;
}

/** People to call from Simple home: a name and a phone number each (at most 8). */
export function cleanContacts(v: unknown): CareContact[] {
  const out: CareContact[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const name = String((x as CareContact)?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const phone = String((x as CareContact)?.phone ?? '').trim().slice(0, 30);
    if (!name || !/^\+?[\d\s().-]{3,30}$/.test(phone) || (phone.match(/\d/g)?.length ?? 0) < 3) continue;
    out.push({ name, phone });
    if (out.length >= 8) break;
  }
  return out;
}

/** Someone else's log, only when it already exists (nothing is created by looking). */
function logOf(app: AppContext, id: string): HealthLog | undefined {
  const dir = app.family?.spaceDirOf?.(id);
  if (!dir || !existsSync(join(dir, 'health-log', 'health.db'))) return undefined;
  const h = HealthLog.open(dir);
  if (!h.bind.now) h.bind = { now: () => app.now(), tz: () => app.family?.tz() };
  return h;
}

/** The people who let this person see something (fresh on every call). */
export function caringFor(app: AppContext): { id: string; name: string }[] {
  const self = me(app);
  if (!self) return [];
  const out: { id: string; name: string }[] = [];
  for (const p of peopleOf(app)) {
    if (p.id === self || p.child) continue;
    const g = logOf(app, p.id)?.care().grants.find((x) => x.person === self);
    if (g && (g.doses || g.checkins || g.summary)) out.push({ id: p.id, name: p.name });
  }
  return out;
}

/** What a caregiver sees of one person: only the consented parts, read now. */
export function careViewOf(app: AppContext, id: string): CareView {
  const self = me(app);
  const p = peopleOf(app).find((x) => x.id === id && x.id !== self && !x.child);
  const h = p ? logOf(app, id) : undefined;
  const g = h?.care().grants.find((x) => x.person === self);
  if (!p || !h || !g || !(g.doses || g.checkins || g.summary)) throw new HealthError(403, en('This person has not shared this with you.'));
  const v: CareView = { id, name: p.name };
  const now = app.now();
  if (g.doses) v.doses = { missed: missedDoses(h, now).map((d) => ({ med: h.med(d.medId)?.name ?? '', due: d.due })), today: todayCounts(h, now) };
  if (g.checkins) v.checkins = h.checkins(7).map((c) => ({ day: c.day, status: c.status }));
  if (g.summary) v.summary = coachShare(coachWeek(h, now));
  return v;
}

function missedDoses(h: HealthLog, now: Date) {
  const from = new Date(now.getTime() - 7 * 24 * HOUR).toISOString();
  return h.doses({ status: 'due', from }).filter((d) => Date.parse(d.due) <= now.getTime() - MISSED_AFTER_MS);
}
function todayCounts(h: HealthLog, now: Date) {
  const day = h.today(now);
  const t = { taken: 0, skipped: 0, open: 0 };
  for (const d of h.doses({ from: new Date(now.getTime() - 36 * HOUR).toISOString() })) {
    if (h.today(new Date(d.due)) !== day) continue;
    if (d.status === 'taken') t.taken++;
    else if (d.status === 'skipped') t.skipped++;
    else t.open++;
  }
  return t;
}

const nameOf = (app: AppContext) => peopleOf(app).find((p) => p.id === me(app))?.name || app.settings.get().ownerName || '';

/** On the reminder tick in the person's own space: a missed dose tells each dose caregiver once. */
export function careTick(app: AppContext, now: Date): void {
  const f = app.family;
  if (!f?.notifyPerson) return;
  const h = healthFor(app);
  const c = h.care();
  const live = c.grants.filter((g) => g.doses);
  if (!live.length) return;
  const recent = missedDoses(h, now).filter((d) => Date.parse(d.due) > now.getTime() - 24 * HOUR);
  if (!recent.length) return;
  const top = Math.max(...recent.map((d) => d.id));
  let changed = false;
  for (const g of live) {
    if ((g.told ?? 0) >= top || f.quietFor?.(g.person)) continue;
    f.notifyPerson(g.person, trOwner('Health', app.settings.get()), trOwner(en('{name} has a dose not marked taken.'), app.settings.get(), { name: nameOf(app) }));
    g.told = top;
    changed = true;
  }
  if (changed) h.setCare(c);
}

/** "I need help" tells every caregiver with check-in consent right away (quiet hours or not). */
export function careCheckedIn(app: AppContext, status: CheckinStatus): void {
  if (status !== 'help') return;
  const f = app.family;
  if (!f?.notifyPerson) return;
  for (const g of healthFor(app).care().grants) {
    if (g.checkins) f.notifyPerson(g.person, trOwner('Health', app.settings.get()), trOwner(en('{name} pressed "I need help" in Sara.'), app.settings.get(), { name: nameOf(app) }));
  }
}
