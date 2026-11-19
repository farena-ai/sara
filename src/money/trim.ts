// V2.8 (docs/TRIM.md): Subscription trimmer. A "Maybe cancel" list on the Money page, built from
// what Money already knows (src/money/hub.ts: repeating charges with price changes, and subscription
// mail: free trials ending, price changes, renewals) plus two mail signals read here: "we miss you /
// you haven't watched in 60 days" (unused) and subscription receipts (still paying). Reasons: unused
// (that mail, or you said so), the price went up, two or more of the same kind (video, music,
// storage…), a free trial ending soon. One tap opens a cancel errand (src/errands.ts template
// `cancel`) that waits on the Errands page for Start, and its final confirm asks again: nothing is
// cancelled without your OK. Once a month a short note goes to where Money alerts go (the reminder
// tick; no timer). Kept in the person's own money store (members have their own); no network.
import type { AppContext } from '../chat.ts';
import { fmtMoney, toCents } from '../biz/money.ts';
import { addDays, localDay } from '../biz/store.ts';
import { postAlert } from '../destinations.ts';
import { errandsFor, type Errand } from '../errands.ts';
import { en, trOwner } from '../i18n.ts';
import type { InboxMail } from '../inbox/classify.ts';
import { cancelLink, mailSubs, MoneyHubError, subscriptionsOf } from './hub.ts';
import { moneyStore, type MoneyStore } from './store.ts';

export type TrimGroup = 'video' | 'music' | 'storage' | 'news' | 'fitness' | 'books';
export type TrimReason =
  | { kind: 'unused'; from: 'mail' | 'you' }
  | { kind: 'price'; fromCents: number | null; toCents: number | null }
  | { kind: 'duplicate'; group: TrimGroup; with: string[] }
  | { kind: 'trial'; day: string };

export interface TrimRow {
  key: string;
  name: string;
  amountCents: number | null;
  every: 'week' | 'month' | 'year' | null;
  yearlyCents: number | null;
  reasons: TrimReason[];
  cancel: string;
  /** Where Sara saw it: your bank or card export, your email. */
  sources: ('bank' | 'mail')[];
  errandId: number | null;
  errandStatus: Errand['status'] | null;
}

export interface TrimPrefs {
  /** A short "maybe cancel" note once a month, where Money alerts go. */
  monthly: boolean;
}

type Mark = { unused?: boolean; keptSig?: string; errandId?: number; name?: string };
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const tz = (app: AppContext) => app.settings.get().timeZone;
const todayOf = (app: AppContext) => localDay(app.now(), tz(app));
const T = (app: AppContext, s: string, p?: Record<string, unknown>) => trOwner(s, app.settings.get(), p);

// ---------------------------------------------------------------- names

const GENERIC = new Set(['the', 'inc', 'llc', 'ltd', 'com', 'www', 'net', 'tv', 'premium', 'subscription', 'subscriptions', 'membership', 'plan', 'billing', 'team', 'storage', 'app', 'service', 'services', 'account', 'payments']);
/** One key per service, the same for "NETFLIX.COM", "Netflix" and "netflix"; "Disney+" = "disney plus". */
export function subKey(name: string): string {
  const words = String(name ?? '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/\.(com|net|tv|io|co)\b/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !GENERIC.has(w));
  return words.join('').slice(0, 40);
}
const sameKey = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Kinds of service where two at once are often one too many. */
const GROUPS: [TrimGroup, RegExp][] = [
  ['music', /spotify|apple music|youtube music|tidal|amazon music|pandora|deezer|sirius/],
  ['video', /netflix|hulu|disney|\bmax\b|hbo|paramount|peacock|prime video|apple tv|crunchyroll|discovery|espn|sling|fubo|youtube tv|starz|showtime|mubi/],
  ['storage', /dropbox|icloud|google one|onedrive|pcloud|backblaze|\bbox\b/],
  ['news', /nytimes|new york times|wsj|wall street journal|washington post|economist|the atlantic|substack/],
  ['fitness', /peloton|strava|apple fitness|classpass|beachbody|noom|myfitnesspal/],
  ['books', /audible|kindle unlimited|scribd|everand|storytel/],
];
export function serviceGroup(name: string): TrimGroup | null {
  const n = String(name ?? '').toLowerCase().replace(/\+/g, ' plus');
  return GROUPS.find(([, re]) => re.test(n))?.[0] ?? null;
}
/** A bank row's merchant key as a name: "spotify usa" → "Spotify". */
const title = (s: string) => s.replace(/\s+(?:usa|us|uk|inc|llc|com)$/i, '').replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());

// ---------------------------------------------------------------- mail signals

function ensure(s: MoneyStore): void {
  s.db.exec(`CREATE TABLE IF NOT EXISTS money_trim_mail (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE, key TEXT NOT NULL, name TEXT NOT NULL, signal TEXT NOT NULL,
    cents INTEGER, every TEXT, at TEXT NOT NULL)`);
}

const UNUSED = /\bwe miss you\b|\bhaven'?t (?:watched|listened|used|logged in|signed in|opened|visited|read|played)\b|\bhave not (?:watched|listened|used|logged in|signed in)\b|\bit'?s been a while since you\b|\bcome back (?:and|to) (?:watch|listen|enjoy)\b/i;
const SUBWORDS = /\b(?:subscriptions?|membership|premium|plan|renews?|renewal|monthly|billed)\b/i;
const CHARGE = /\b(?:receipt|payment|charged|billed|invoice)\b/i;
const PROMO = /\bfree for \d|\btry\b.{0,30}\bfree\b|\d+% off\b|\bspecial offer\b|\bget \d+ months?\b|\bfree trial\b/i;

function senderName(from: string): string {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (name) return clip(name, 60);
  const dom = /@([^>\s]+)/.exec(from)?.[1] ?? from;
  return clip(dom.split('.').slice(-2, -1)[0] ?? dom, 60);
}

/** A subscription's own receipt ("Thanks for your subscription payment of $13.99"): a charge, not a purchase to return. */
export function subscriptionCharge(m: Pick<InboxMail, 'subject' | 'text'>): boolean {
  const blob = `${m.subject}\n${m.text ?? ''}`.slice(0, 6000);
  return CHARGE.test(blob) && /\b(?:subscription|membership|premium|plan renews|renews monthly|renews yearly)\b/i.test(blob) && !PROMO.test(blob);
}

/**
 * A new email that says a subscription is unused ("we miss you", "you haven't watched in 60 days")
 * or that a subscription was charged (a receipt). Called by the inbox helper next to Money's own
 * reader (which keeps trials, price changes and renewals). Returns whether it was kept.
 */
export function observeTrimMail(app: AppContext, m: InboxMail): boolean {
  const blob = `${m.subject}\n${m.text ?? ''}`.slice(0, 6000);
  const name = senderName(m.from);
  const service = serviceGroup(`${name} ${m.from}`) !== null;
  const every = /\b(?:per year|a year|yearly|annual(?:ly)?)\b|\/\s?(?:yr|year)\b/i.test(blob) ? 'year' : /\b(?:per month|a month|monthly)\b|\/\s?mo(?:nth)?\b/i.test(blob) ? 'month' : null;
  let signal: 'unused' | 'charge' | 'info' | undefined;
  if (UNUSED.test(blob) && (SUBWORDS.test(blob) || service)) signal = 'unused';
  else if (CHARGE.test(blob) && SUBWORDS.test(blob) && !PROMO.test(blob) && /\$\s?\d/.test(blob)) signal = 'charge';
  // Money's own subscription mail (price change, trial, renewal): only how often it bills.
  else if (every && /\bprice\b|\btrial\b|\brenew/i.test(blob) && !/\bget \d+ months?\b|\bfree for \d/i.test(blob)) signal = 'info';
  if (!signal) return false;
  const key = subKey(name);
  if (!key) return false;
  const s = moneyStore(app);
  ensure(s);
  const ref = `${m.account}|${m.id}`;
  if (s.db.prepare('SELECT 1 FROM money_trim_mail WHERE ref = ?').get(ref)) return false;
  const cents = signal === 'info' ? null : [...blob.matchAll(/(?:US)?\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((x) => toCents(x[1])).find((x): x is number => typeof x === 'number' && x > 0) ?? null;
  s.db.prepare('INSERT INTO money_trim_mail (ref, key, name, signal, cents, every, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ref, key, name, signal, cents, every, (m.date && !Number.isNaN(Date.parse(m.date)) ? new Date(m.date) : app.now()).toISOString());
  return true;
}

// ---------------------------------------------------------------- prefs and marks

const DEFAULT_PREFS: TrimPrefs = { monthly: true };
export function trimPrefs(app: AppContext): TrimPrefs {
  return { ...DEFAULT_PREFS, ...(moneyStore(app).state<Partial<TrimPrefs>>('trim_prefs') ?? {}) };
}
function setTrimPrefs(app: AppContext, b: Record<string, unknown>): TrimPrefs {
  const p = trimPrefs(app);
  if (typeof b.monthly === 'boolean') p.monthly = b.monthly;
  moneyStore(app).setState('trim_prefs', p);
  return p;
}
const marksOf = (s: MoneyStore) => s.state<Record<string, Mark>>('trim_marks') ?? {};
function mark(s: MoneyStore, key: string, patch: Partial<Mark> | null): void {
  const all = marksOf(s);
  const cur = { ...(all[key] ?? {}), ...(patch ?? {}) };
  for (const k of Object.keys(cur) as (keyof Mark)[]) if (cur[k] === undefined) delete cur[k];
  if (Object.keys(cur).length) all[key] = cur;
  else delete all[key];
  s.setState('trim_marks', all);
}

// ---------------------------------------------------------------- the list

interface Known {
  key: string;
  name: string;
  /** The name came from a mail sender (proper case) rather than a bank row. */
  proper: boolean;
  amountCents: number | null;
  every: TrimRow['every'];
  sources: Set<'bank' | 'mail'>;
  price?: { fromCents: number | null; toCents: number | null; bank: boolean };
  trial?: string;
  unusedMail?: boolean;
}

const daysAgo = (iso: string, today: string) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) / 86_400_000);

/** Every subscription Money knows about, one per service. */
function knownSubs(app: AppContext): Map<string, Known> {
  const s = moneyStore(app);
  const today = todayOf(app);
  const out = new Map<string, Known>();
  const find = (name: string, proper: boolean): Known => {
    const key = subKey(name);
    for (const k of out.values()) if (sameKey(k.key, key)) {
      if (proper && !k.proper) Object.assign(k, { name: clip(name, 60), proper: true });
      return k;
    }
    const k: Known = { key, name: proper ? clip(name, 60) : title(clip(name, 60)), proper, amountCents: null, every: null, sources: new Set() };
    out.set(key, k);
    return k;
  };
  // 1. Repeating charges in bank and card exports (still running).
  if (s.hasTransactions()) {
    for (const x of subscriptionsOf(s, today)) {
      if (x.maybeStopped) continue;
      const k = find(x.merchant, false);
      k.sources.add('bank');
      k.amountCents = x.amountCents;
      k.every = x.every;
      if (x.priceChange && daysAgo(x.priceChange.on, today) <= 120) k.price = { fromCents: x.priceChange.fromCents, toCents: x.priceChange.toCents, bank: true };
    }
  }
  // 2. Subscription mail Money keeps (trials, price changes, renewals; hidden ones stay out).
  for (const x of mailSubs(s)) {
    if (daysAgo(x.at, today) > 180) continue;
    if (x.kind === 'trial' && (!x.ends || x.ends < today)) continue;
    const k = find(x.merchant, true);
    k.sources.add('mail');
    if (k.amountCents === null && x.toCents) k.amountCents = x.toCents;
    if (x.kind === 'price' && !k.price?.bank) {
      k.price = { fromCents: x.fromCents, toCents: x.toCents, bank: false };
      if (x.toCents && !k.sources.has('bank')) k.amountCents = x.toCents;
    }
    if (x.kind === 'trial' && x.ends && x.ends <= addDays(today, 14)) k.trial = x.ends;
  }
  // 3. This reader's mail: receipts (still paying) and "we miss you" (unused).
  ensure(s);
  for (const r of s.db.prepare('SELECT * FROM money_trim_mail ORDER BY at').all() as Record<string, unknown>[]) {
    const age = daysAgo(String(r.at), today);
    if (age > (r.signal === 'unused' ? 90 : r.signal === 'info' ? 180 : 100)) continue;
    const k = find(String(r.name), true);
    k.sources.add('mail');
    if (r.cents != null && !k.sources.has('bank')) k.amountCents = Number(r.cents);
    if (r.every && !k.every) k.every = String(r.every) as TrimRow['every'];
    if (r.signal === 'unused') k.unusedMail = true;
  }
  return out;
}

const WEIGHT: Record<TrimReason['kind'], number> = { unused: 3, price: 2, trial: 2, duplicate: 1 };
const sigOf = (reasons: TrimReason[]) => JSON.stringify(reasons.map((r) => (r.kind === 'duplicate' ? [r.kind, r.group] : r.kind === 'price' ? [r.kind, r.toCents] : r.kind === 'trial' ? [r.kind, r.day] : [r.kind])).sort());

function rowsOf(app: AppContext): { rows: (TrimRow & { sig: string })[]; known: Map<string, Known> } {
  const s = moneyStore(app);
  const known = knownSubs(app);
  const marks = marksOf(s);
  const groups = new Map<TrimGroup, Known[]>();
  for (const k of known.values()) {
    const g = serviceGroup(k.name);
    if (g) groups.set(g, [...(groups.get(g) ?? []), k]);
  }
  const errands = errandsFor(app);
  const rows: (TrimRow & { sig: string })[] = [];
  for (const k of known.values()) {
    const reasons: TrimReason[] = [];
    if (k.unusedMail) reasons.push({ kind: 'unused', from: 'mail' });
    else if (marks[k.key]?.unused) reasons.push({ kind: 'unused', from: 'you' });
    if (k.price && (k.price.toCents ?? 0) > (k.price.fromCents ?? 0)) reasons.push({ kind: 'price', fromCents: k.price.fromCents, toCents: k.price.toCents });
    const g = serviceGroup(k.name);
    const same = g ? (groups.get(g) ?? []).filter((x) => x !== k) : [];
    if (g && same.length) reasons.push({ kind: 'duplicate', group: g, with: same.map((x) => x.name).sort() });
    if (k.trial) reasons.push({ kind: 'trial', day: k.trial });
    if (!reasons.length) continue;
    const e = marks[k.key]?.errandId ? errands.get(marks[k.key]!.errandId!) : undefined;
    if (e?.status === 'done') continue; // cancelled through the errand
    const live = e && e.status !== 'stopped' ? e : undefined;
    const yearly = k.amountCents === null || !k.every ? null : k.every === 'week' ? k.amountCents * 52 : k.every === 'month' ? k.amountCents * 12 : k.amountCents;
    rows.push({ key: k.key, name: k.name, amountCents: k.amountCents, every: k.every, yearlyCents: yearly, reasons, cancel: cancelLink(k.name), sources: [...k.sources].sort(), errandId: live?.id ?? null, errandStatus: live?.status ?? null, sig: sigOf(reasons) });
  }
  const score = (r: TrimRow) => r.reasons.reduce((n, x) => n + WEIGHT[x.kind], 0);
  rows.sort((a, b) => score(b) - score(a) || (b.yearlyCents ?? 0) - (a.yearlyCents ?? 0) || a.name.localeCompare(b.name));
  return { rows, known };
}

/** The "Maybe cancel" list: subscriptions with a reason to look again, most reasons first. Kept ones stay off until something new is found. */
export function trimList(app: AppContext) {
  const marks = marksOf(moneyStore(app));
  const all = rowsOf(app).rows;
  const shown = all.filter((r) => marks[r.key]?.keptSig !== r.sig);
  const rows: TrimRow[] = shown.map(({ sig: _sig, ...r }) => r);
  const keptRows = all.filter((r) => marks[r.key]?.keptSig === r.sig).map((r) => ({ key: r.key, name: r.name }));
  return { rows, kept: keptRows.length, keptRows, yearlyCents: rows.reduce((n, r) => n + (r.yearlyCents ?? 0), 0), prefs: trimPrefs(app) };
}

export interface TrimResult {
  ok: true;
  key: string;
  errand?: Errand;
  prefs?: TrimPrefs;
}

/** cancel (opens a cancel errand that waits for Start) · keep · unkeep · unused · used · prefs. */
export function trimAction(app: AppContext, key: string, action: string, body: Record<string, unknown> = {}): TrimResult {
  const s = moneyStore(app);
  if (action === 'prefs') return { ok: true, key: '', prefs: setTrimPrefs(app, body) };
  const { rows, known } = rowsOf(app);
  // A key, or a name as the Subscriptions list shows it ("Not using it" there).
  const want = subKey(key);
  const k = [...known.values()].find((x) => x.key === key) ?? [...known.values()].find((x) => want && sameKey(x.key, want));
  if (k) key = k.key;
  const row = rows.find((r) => r.key === key);
  if (!k) throw new MoneyHubError(404, en('That subscription is not on your list.'));
  if (action === 'unused' || action === 'used') {
    mark(s, key, { unused: action === 'unused' ? true : undefined, keptSig: undefined });
    return { ok: true, key };
  }
  if (action === 'unkeep') {
    mark(s, key, { keptSig: undefined });
    return { ok: true, key };
  }
  if (!row) throw new MoneyHubError(404, en('That subscription is not on your list.'));
  if (action === 'keep') {
    mark(s, key, { keptSig: row.sig, name: row.name });
    return { ok: true, key };
  }
  if (action === 'cancel') {
    const errands = errandsFor(app);
    const old = row.errandId ? errands.get(row.errandId) : undefined;
    if (old && old.status !== 'stopped' && old.status !== 'done') return { ok: true, key, errand: old };
    const page = cancelLink(row.name);
    const e = errands.start(
      {
        goal: `Cancel my ${row.name} subscription`,
        template: 'cancel',
        facts: { merchant: row.name, ...(page.includes('duckduckgo.com') ? {} : { url: page }), ...(row.amountCents !== null ? { amount: fmtMoney(row.amountCents) } : {}) },
        ...(row.reasons.find((r) => r.kind === 'trial') ? { deadline: (row.reasons.find((r) => r.kind === 'trial') as { day: string }).day } : {}),
      },
      { by: 'page' },
    );
    mark(s, key, { errandId: e.id, name: row.name });
    return { ok: true, key, errand: e };
  }
  throw new MoneyHubError(404, 'Not found');
}

/** For the chat tool: one line per row, plain English (the model words it for the person). */
export function trimLines(app: AppContext): string {
  const l = trimList(app);
  if (!l.rows.length) return '';
  const why = (r: TrimReason) => (r.kind === 'unused' ? (r.from === 'mail' ? 'their email says it has not been used lately' : 'the person said they do not use it') : r.kind === 'price' ? `price went up${r.fromCents && r.toCents ? ` from ${fmtMoney(r.fromCents)} to ${fmtMoney(r.toCents)}` : ''}` : r.kind === 'duplicate' ? `another ${r.group} service too (${r.with.join(', ')})` : `free trial ends ${r.day}`);
  return `Maybe cancel (Money → Maybe cancel; a cancel errand starts only when the person taps it, and the final confirm asks again):\n${l.rows.map((r) => `- ${r.name}${r.amountCents !== null ? ` ${fmtMoney(r.amountCents)}${r.every ? ` a ${r.every}` : ''}` : ''}: ${r.reasons.map(why).join('; ')}`).join('\n')}`;
}

// ---------------------------------------------------------------- once a month

/** The reminder tick: on the 1st (from 9 AM local) a short note where Money alerts go. Never acts. */
export function trimTick(app: AppContext, now: Date): boolean {
  const s = moneyStore(app);
  const day = localDay(now, tz(app));
  const month = day.slice(0, 7);
  if (s.state<string>('trim_month') === month) return false;
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz(app) }).format(now));
  if (hour < 9) return false;
  s.setState('trim_month', month);
  if (!trimPrefs(app).monthly) return false;
  const l = trimList(app);
  if (!l.rows.length) return false;
  const names = l.rows.slice(0, 6).map((r) => r.name).join(', ');
  const content = l.yearlyCents
    ? T(app, en('Maybe cancel this month: {names} (about {amount} a year). Money → Maybe cancel starts a cancel errand for any of them; nothing is cancelled without your OK.'), { names, amount: fmtMoney(l.yearlyCents) })
    : T(app, en('Maybe cancel this month: {names}. Money → Maybe cancel starts a cancel errand for any of them; nothing is cancelled without your OK.'), { names });
  postAlert(app, 'money', { role: 'assistant', reason: 'proactive', nudge: { value: 0.5 }, content });
  return true;
}
