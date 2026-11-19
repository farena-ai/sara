// V2.1 (docs/RENEWALS.md): Renewals and paperwork, one list of what needs renewing (passport, driver's
// license, registration, insurance, warranties, subscriptions, a lease) built from the sources that
// already know the dates, never copied twice:
// - dates found in Library documents (src/facts.ts suggestions; a photo of a card is a Library photo,
//   read like any document),
// - renewal mail read by the same rules (src/facts.ts observeMail, called from the inbox helper),
// - the Money page's subscription renewals (mail it caught + yearly charges; src/money/hub.ts),
// - rows the person types in.
// The same date for the same kind of thing shows once (a document beats the mail about it). Each row:
// Remind me (a planner reminder at the existing DAYS_BEFORE), Fill the form (asks in chat; fill_document
// / pc_fill_form stop before Submit), Start a renewal errand (the `renew` template), Hide.
import type { AppContext } from './chat.ts';
import { errandsFor, type Errand } from './errands.ts';
import { DAYS_BEFORE, factsFor, FactsError, type DateKind } from './facts.ts';
import { en } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { mailSubs, subscriptionsOf } from './money/hub.ts';
import { moneyStore } from './money/store.ts';
import { noteNudgeReminder } from './nudges.ts';
import { looksLikeCard, looksLikeSsn } from './my-details.ts';

export const RENEWAL_WHATS = ['passport', 'license', 'registration', 'insurance', 'warranty', 'subscription', 'lease', 'other'] as const;
export type RenewalWhat = (typeof RENEWAL_WHATS)[number];

export interface Renewal {
  /** d12 (a document date), r3 (mail or typed in), m4 (Money mail), y<name> (a yearly charge). */
  id: string;
  what: RenewalWhat;
  title: string;
  date: string;
  kind: DateKind;
  daysLeft: number;
  daysBefore: number;
  source: { kind: 'document' | 'mail' | 'money' | 'you'; docId?: number; name?: string; page?: number | null; sender?: string | null };
  quote: string | null;
  /** The same date was also found here (shown once). */
  alsoIn: Renewal['source']['kind'] | null;
  reminder: { id: number; dueAt: string } | null;
  errandId: number | null;
}

export class RenewalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const RENEWAL_LINES = [en('Give it a name, like “Passport”.'), en('Pick the date, like 2027-03-31.'), en('Renewal not found.'), en('Reminders are not available here.')];

const KIND_WHAT: Partial<Record<DateKind, RenewalWhat>> = { passport_expiry: 'passport', license_expiry: 'license', warranty_end: 'warranty', lease_end: 'lease' };
const WHAT_KIND: Record<RenewalWhat, DateKind> = { passport: 'passport_expiry', license: 'license_expiry', registration: 'expiry', insurance: 'renewal', warranty: 'warranty_end', subscription: 'renewal', lease: 'lease_end', other: 'expiry' };
const WHAT_RE: [RegExp, RenewalWhat][] = [
  [/\bpassport\b/i, 'passport'],
  [/\bregistration\b|\b(?:license )?tags\b/i, 'registration'],
  [/\bdriver'?s?\s+licen[cs]e\b|\blicen[cs]e\b/i, 'license'],
  [/\bwarrant(?:y|ies)\b|\bguarantee\b/i, 'warranty'],
  [/\bsubscription\b|\bmembership\b/i, 'subscription'],
  [/\blease\b|\btenan(?:t|cy)\b/i, 'lease'],
  [/\binsur(?:ance|ed|er)\b|\bpolicy\b|\bpremium\b/i, 'insurance'],
];
const WHAT_NAME: Record<RenewalWhat, string> = { passport: 'passport', license: 'driver’s license', registration: 'registration', insurance: 'insurance policy', warranty: 'warranty', subscription: 'subscription', lease: 'lease', other: 'paperwork' };
const KIND_TEXT: Record<DateKind, string> = { renewal: 'renews', expiry: 'expires', due: 'due', lease_end: 'lease ends', warranty_end: 'warranty ends', passport_expiry: 'passport expires', license_expiry: 'license expires' };

/** What kind of paperwork a row is, from its date kind, then its words. */
export function whatOf(title: string, text: string, kind?: DateKind): RenewalWhat {
  const k = kind ? KIND_WHAT[kind] : undefined;
  if (k) return k;
  const s = `${title}\n${text}`;
  return WHAT_RE.find(([re]) => re.test(s))?.[1] ?? 'other';
}

const dayNum = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
const noExt = (n: string) => n.replace(/\.(?:pdf|docx?|xlsx?|jpe?g|png|webp|heic|txt|md)$/i, '');

/** A mail subject as a row name: "Your vehicle registration renewal notice" → "Vehicle registration renewal". */
export function mailTitle(subject: string): string {
  const t = subject
    .replace(/^\s*(?:(?:re|fwd?|aw|wg|tr)\s*:\s*)+/i, '')
    .replace(/^(?:important|reminder|action required)\s*[:\-–]\s*/i, '')
    .replace(/^your\s+/i, '')
    .replace(/\s+(?:notice|reminder|is coming up|coming up|soon)[.!]*$/i, '')
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : subject;
}

/** The person's renewals, soonest first, each date once. */
export function renewalsOf(app: AppContext): Renewal[] {
  const facts = factsFor(app);
  const today = localDate(app.now?.() ?? new Date(), app.settings.get().timeZone);
  const marks = facts.renewalMarks();
  const planner = app.planner;
  const reminderOf = (id: number | null | undefined) => {
    const r = id ? planner?.reminder(id) : undefined;
    return r && r.status !== 'cancelled' ? { id: r.id, dueAt: r.dueAt } : null;
  };
  const errandOf = (id: number | null | undefined) => (id && errandsFor(app).get(id) ? id : null);
  const out: Renewal[] = [];
  const seen = new Map<string, Renewal>();
  const push = (r: Omit<Renewal, 'daysLeft' | 'daysBefore' | 'alsoIn' | 'reminder' | 'errandId'> & { reminder?: Renewal['reminder'] }, ref?: string | null) => {
    if (r.date < today) return;
    const m = marks.get(r.id);
    if (m?.hidden) return;
    const key = `${r.date}|${r.what}`;
    const dup = seen.get(key) ?? (ref ? seen.get(`ref|${ref}`) : undefined);
    if (dup) {
      dup.alsoIn ??= r.source.kind;
      return;
    }
    const row: Renewal = { ...r, daysLeft: dayNum(r.date) - dayNum(today), daysBefore: DAYS_BEFORE[r.kind], alsoIn: null, reminder: r.reminder ?? reminderOf(m?.reminderId), errandId: errandOf(m?.errandId) };
    seen.set(key, row);
    if (ref) seen.set(`ref|${ref}`, row);
    out.push(row);
  };
  // 1. Dates in Library documents (bills' due dates are not renewals).
  for (const s of facts.suggestions({ status: 'all', limit: 500 })) {
    if (s.dateKind === 'due') continue;
    const title = noExt(s.name);
    push({ id: `d${s.id}`, what: whatOf(title, s.quote, s.dateKind), title, date: s.date, kind: s.dateKind, source: { kind: 'document', docId: s.docId, name: s.name, page: s.page }, quote: s.quote, reminder: s.status === 'accepted' ? reminderOf(s.reminderId) : null });
  }
  const own = facts.renewalRows();
  // 2. Renewal mail.
  for (const r of own.filter((x) => x.source === 'mail')) push({ id: `r${r.id}`, what: (RENEWAL_WHATS as readonly string[]).includes(r.what) ? (r.what as RenewalWhat) : whatOf(r.title, r.quote ?? '', r.kind), title: mailTitle(r.title), date: r.date, kind: r.kind, source: { kind: 'mail', sender: r.sender }, quote: r.quote }, r.ref);
  // 3. The Money page's subscriptions (the owner's household money; not a member's space).
  if (!app.member) {
    try {
      const ms = moneyStore(app);
      for (const x of mailSubs(ms)) if (x.kind === 'renewal' && x.ends) push({ id: `m${x.id}`, what: 'subscription', title: x.merchant, date: x.ends, kind: 'renewal', source: { kind: 'money', sender: x.merchant }, quote: x.subject });
      for (const x of subscriptionsOf(ms, today)) if (x.every === 'year' && x.next) push({ id: `y${encodeURIComponent(x.merchant).slice(0, 60)}`, what: 'subscription', title: x.merchant, date: x.next, kind: 'renewal', source: { kind: 'money', sender: x.merchant }, quote: null });
    } catch (err) {
      console.warn(`renewals: money: ${(err as Error).message}`);
    }
  }
  // 4. Typed in.
  for (const r of own.filter((x) => x.source === 'you')) push({ id: `r${r.id}`, what: (RENEWAL_WHATS as readonly string[]).includes(r.what) ? (r.what as RenewalWhat) : 'other', title: r.title, date: r.date, kind: r.kind, source: { kind: 'you' }, quote: null });
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** A new mail: renewals the Money page already took (subscriptions) are not read twice. */
export function takeRenewalMail(app: AppContext, m: { account: string; id: string; from: string; subject: string; text?: string }, takenByMoney: boolean): number {
  if (takenByMoney) return 0;
  return factsFor(app).observeMail(m);
}

const whenText = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));

export interface RenewalResult {
  ok: boolean;
  id?: string;
  reminderId?: number;
  dueAt?: string;
  errand?: Errand;
}

/** add · remind · hide · remove · errand. */
export function renewalAction(app: AppContext, action: 'add' | 'remind' | 'hide' | 'remove' | 'errand', args: Record<string, unknown>): RenewalResult {
  const facts = factsFor(app);
  if (action === 'add') {
    const title = String(args.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title || looksLikeCard(title) || looksLikeSsn(title)) throw new RenewalError(400, en('Give it a name, like “Passport”.'));
    const date = String(args.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new RenewalError(400, en('Pick the date, like 2027-03-31.'));
    // No kind picked: guessed from the name ("Boat registration" → registration).
    const what = (RENEWAL_WHATS as readonly string[]).includes(String(args.what)) ? (String(args.what) as RenewalWhat) : whatOf(title, '');
    return { ok: true, id: `r${facts.addRenewal({ what, title, date, kind: WHAT_KIND[what] })}` };
  }
  const id = String(args.id ?? '');
  const row = renewalsOf(app).find((r) => r.id === id);
  if (!row) throw new RenewalError(404, en('Renewal not found.'));
  if (action === 'remind') {
    if (row.reminder) return { ok: true, id, reminderId: row.reminder.id, dueAt: row.reminder.dueAt };
    if (row.source.kind === 'document') {
      try {
        const r = facts.accept(Number(id.slice(1)), row.daysBefore);
        return { ok: true, id, reminderId: r.reminder.id, dueAt: r.reminder.dueAt };
      } catch (err) {
        if (err instanceof FactsError) throw new RenewalError(err.status, err.message);
        throw err;
      }
    }
    if (!app.planner) throw new RenewalError(404, en('Reminders are not available here.'));
    const r = app.planner.addReminder({ text: `${row.title}: ${KIND_TEXT[row.kind]} ${whenText(row.date)}`, dueAt: facts.remindAt(row.date, row.daysBefore).toISOString() });
    facts.markRenewal(id, { reminderId: r.id, daysBefore: row.daysBefore });
    noteNudgeReminder(app, r.id, 'renewals', 0.9, 'reminder');
    return { ok: true, id, reminderId: r.id, dueAt: r.dueAt };
  }
  if (action === 'errand') {
    const name = WHAT_NAME[row.what];
    const e = errandsFor(app).start(
      { goal: `Renew my ${name}: ${row.title} (before ${whenText(row.date)})`.slice(0, 200), template: 'renew', deadline: row.date, facts: { what: name, title: row.title, date: row.date } },
      { by: 'page' },
    );
    facts.markRenewal(id, { errandId: e.id });
    return { ok: true, id, errand: e };
  }
  if (action === 'remove' && id.startsWith('r') && facts.removeRenewal(Number(id.slice(1)))) return { ok: true, id };
  // Hide (and remove for rows that came from elsewhere): it stays hidden when the source is read again.
  facts.markRenewal(id, { hidden: true });
  if (row.source.kind === 'document') {
    try {
      facts.dismiss(Number(id.slice(1)));
    } catch {
      /* already accepted or dismissed */
    }
  }
  return { ok: true, id };
}
