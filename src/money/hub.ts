// U4.20 (docs/MONEY.md): the Money place. Built on E3's store and math (src/money/*): imports with
// saved CSV mappings and duplicate checks across overlapping files, editable and learned categories
// (a model may suggest, only when the person turns it on), trends, budgets with gentle alerts on the
// 'money' alert feed, bills due (tracked bills + recurring charges), subscriptions from transactions
// and from mail (price changes, free trials ending, a how-to-cancel link), and net worth from
// balances the person types. Tracking only: nothing here logs in to a bank, pays, transfers or
// cancels anything, and nothing here uses the network (private local mode works fully).
import type { AppContext } from '../chat.ts';
import { fmtMoney, toCents } from '../biz/money.ts';
import { addDays, localDay, morningOf } from '../biz/store.ts';
import { postAlert } from '../destinations.ts';
import { en, trOwner } from '../i18n.ts';
import type { InboxMail } from '../inbox/classify.ts';
import { complete } from '../life.ts';
import { BUDGET_CATEGORIES, cleanBudgetCategory, findSubscriptions, monthPeriod, NOT_SPENDING, summarize, type Tx } from './budget.ts';
import { billStatus, newLimitWarnings, notifyLimits, refreshBills, type LastValue } from './core.ts';
import { headerSig, readTransactions, type CsvMapping } from './parse.ts';
import { moneyStore, type MoneyStore } from './store.ts';
import { noteNudgeReminder } from '../nudges.ts';

export class MoneyHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const TRACKING_ONLY = en('Tracking only: Sara never logs in to a bank, pays, transfers or cancels anything.');

type Row = Record<string, unknown>;
const tz = (app: AppContext) => app.settings.get().timeZone;
const todayOf = (app: AppContext) => localDay(app.now(), tz(app));
const T = (app: AppContext, s: string, p?: Record<string, unknown>) => trOwner(s, app.settings.get(), p);
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- preferences

export interface MoneyPrefs {
  /** Budget, trial and price-change alerts on the Money feed (gentle: once each). */
  gentle: boolean;
  /** "Getting close" at this % of a budget. */
  nearPct: number;
  /** A model may suggest categories for merchants nothing matched (merchant names only). */
  suggest: boolean;
}
const DEFAULT_PREFS: MoneyPrefs = { gentle: true, nearPct: 80, suggest: false };

export function prefsOf(app: AppContext): MoneyPrefs {
  return { ...DEFAULT_PREFS, ...(moneyStore(app).state<Partial<MoneyPrefs>>('prefs') ?? {}) };
}
export function setPrefs(app: AppContext, body: Record<string, unknown>): MoneyPrefs {
  const p = prefsOf(app);
  if (typeof body.gentle === 'boolean') p.gentle = body.gentle;
  if (typeof body.suggest === 'boolean') p.suggest = body.suggest;
  if (body.nearPct !== undefined) {
    const n = Math.round(Number(body.nearPct));
    if (![0, 50, 70, 80, 90].includes(n)) throw new MoneyHubError(400, en('Pick one of the offered levels.'));
    p.nearPct = n;
  }
  moneyStore(app).setState('prefs', p);
  return p;
}

// ---------------------------------------------------------------- imports

export interface SavedMapping extends CsvMapping {
  sig: string;
  columns: string[];
}
const mapsOf = (s: MoneyStore) => s.state<Record<string, SavedMapping>>('csv_maps') ?? {};

export interface ImportResult {
  needMapping?: true;
  columns?: string[];
  sample?: string[][];
  file: string;
  read: number;
  added: number;
  duplicates: number;
  skipped: number;
  flipped: boolean;
  from?: string;
  to?: string;
  accounts: string[];
  categories: { category: string; count: number }[];
  alerts: string;
}

const cleanMapping = (m: Record<string, unknown>): CsvMapping | undefined => {
  const n = (k: string) => (m[k] === undefined || m[k] === null || m[k] === '' ? undefined : Number(m[k]));
  const out: CsvMapping = { date: Number(m.date), description: Number(m.description) };
  for (const k of ['amount', 'debit', 'credit', 'category', 'account'] as const) {
    const v = n(k);
    if (v !== undefined) out[k] = v;
  }
  const ok = (v: number | undefined) => v === undefined || (Number.isInteger(v) && v >= 0 && v < 200);
  if (!ok(out.date) || !ok(out.description) || ![out.amount, out.debit, out.credit, out.category, out.account].every(ok)) return undefined;
  if (out.amount === undefined && out.debit === undefined && out.credit === undefined) return undefined;
  if (m.flip === true) out.flip = true;
  if (m.bank) out.bank = clip(m.bank, 60);
  return out;
};

/** One bank or card export (CSV/TSV/Excel/OFX/QFX/QIF) → new transactions; asks for a column mapping when needed. */
export async function importFile(app: AppContext, o: { name: string; bytes: Buffer; account?: string; mapping?: Record<string, unknown> }): Promise<ImportResult> {
  const s = moneyStore(app);
  const name = clip(o.name, 120) || 'export.csv';
  const maps = mapsOf(s);
  const mapping = o.mapping ? cleanMapping(o.mapping) : undefined;
  if (o.mapping && !mapping) throw new MoneyHubError(400, en('Pick the date, description and amount columns.'));
  const empty = { file: name, read: 0, added: 0, duplicates: 0, skipped: 0, flipped: false, accounts: [], categories: [], alerts: '' };
  let r: ReturnType<typeof readTransactions>;
  try {
    r = readTransactions(name, o.bytes, o.account, maps, mapping);
  } catch (err) {
    const e = err as { columns?: string[]; sample?: string[][] };
    if (e && Array.isArray(e.columns)) return { ...empty, needMapping: true, columns: e.columns, sample: e.sample ?? [] };
    throw err;
  }
  if (mapping && r.sig) {
    const grid = o.bytes.toString('utf8').split(/\r?\n/).find((l) => l.trim()) ?? '';
    s.setState('csv_maps', { ...maps, [r.sig]: { ...mapping, sig: r.sig, columns: grid.split(/[,;\t]/).map((c) => clip(c.replace(/^"|"$/g, ''), 40)).slice(0, 30) } });
  }
  const fallback = (o.account ?? '').trim() || name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60);
  const guessed = !(o.account ?? '').trim() && r.rows.every((x) => x.account === fallback);
  const { added, duplicates } = s.importTransactions(r.rows, { file: name, guessed });
  const cats = new Map<string, number>();
  for (const t of added) cats.set(t.category, (cats.get(t.category) ?? 0) + 1);
  const dates = r.rows.map((x) => x.date).sort();
  return {
    file: name,
    read: r.rows.length,
    added: added.length,
    duplicates,
    skipped: r.skipped,
    flipped: r.flipped,
    from: dates[0],
    to: dates.at(-1),
    accounts: [...new Set(r.rows.map((x) => x.account))],
    categories: [...cats].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    alerts: budgetAlerts(app, null),
  };
}

// ---------------------------------------------------------------- trends and budgets

export function trends(all: Tx[], endMonth: string, n = 6): { months: string[]; categories: { category: string; cents: number[] }[]; totals: number[] } {
  const months: string[] = [];
  let [y, m] = endMonth.split('-').map(Number);
  for (let i = 0; i < n; i++) {
    months.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--;
    if (!m) {
      m = 12;
      y--;
    }
  }
  const by = new Map<string, number[]>();
  for (const t of all) {
    const i = months.indexOf(t.date.slice(0, 7));
    if (i < 0 || NOT_SPENDING.has(t.category)) continue;
    const row = by.get(t.category) ?? months.map(() => 0);
    row[i] -= t.amountCents;
    by.set(t.category, row);
  }
  const categories = [...by].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents.reduce((x, c) => x + c, 0) - a.cents.reduce((x, c) => x + c, 0));
  return { months, categories, totals: months.map((_, i) => categories.reduce((x, c) => x + c.cents[i], 0)) };
}

export interface BudgetLine {
  category: string;
  limitCents: number;
  spentCents: number;
  pct: number;
  state: 'ok' | 'near' | 'over';
}
export function budgetStatus(s: MoneyStore, today: string, nearPct = 80): BudgetLine[] {
  const p = monthPeriod(today.slice(0, 7));
  const spent = new Map<string, number>();
  for (const t of s.transactions({ from: p.from, to: p.to })) if (!NOT_SPENDING.has(t.category)) spent.set(t.category, (spent.get(t.category) ?? 0) - t.amountCents);
  return s.limits().map((l) => {
    const spentCents = spent.get(l.category) ?? 0;
    const pct = Math.round((spentCents * 100) / l.cents);
    return { category: l.category, limitCents: l.cents, spentCents, pct, state: spentCents > l.cents ? 'over' : nearPct > 0 && pct >= nearPct ? 'near' : 'ok' };
  });
}

/**
 * Gentle budget alerts: "getting close" once a month per budget and "went past" once a month (the
 * E3 limit warning), posted on the Money alert feed (Settings → Automations → Where alerts go) and
 * as a phone notification. Returns the tool's line (E3 wording) for the over ones.
 */
export function budgetAlerts(app: AppContext, conversationId: string | null): string {
  const s = moneyStore(app);
  const prefs = prefsOf(app);
  const day = todayOf(app);
  const month = day.slice(0, 7);
  const over = newLimitWarnings(s, day);
  const near0 = budgetStatus(s, day, prefs.nearPct).filter((b) => b.state === 'near');
  const told = s.state<Record<string, string[]>>('limits_near') ?? {};
  const done = new Set(told[month] ?? []);
  const near = near0.filter((b) => !done.has(b.category));
  if (near.length) s.setState('limits_near', { [month]: [...done, ...near.map((b) => b.category)] });
  const label = monthPeriod(month).label;
  if (prefs.gentle) {
    const lines = [
      ...near.map((b) => T(app, en('{category} is at {spent} of your {limit} for {month} ({pct}%). Just so you know.'), { category: b.category, spent: fmtMoney(b.spentCents), limit: fmtMoney(b.limitCents), month: label, pct: b.pct })),
      ...over.map((w) => T(app, en('{category} went past your {limit} for {month}: {spent} so far.'), { category: w.category, spent: fmtMoney(w.spentCents), limit: fmtMoney(w.limitCents), month: label })),
    ];
    let conv: string | undefined;
    for (const content of lines) conv = postAlert(app, 'money', { role: 'assistant', content, origin: () => conversationId ?? undefined, reason: 'proactive', nudge: { value: 0.65 } }) ?? conv;
    const warn = notifyLimits(app, over, conv ?? conversationId);
    return [near.length ? `Getting close (told once this month): ${near.map((b) => `${b.category}: ${fmtMoney(b.spentCents)} of ${fmtMoney(b.limitCents)} (${b.pct}%)`).join('; ')}.` : '', warn].filter(Boolean).join('\n');
  }
  return notifyLimits(app, over, null);
}

// ---------------------------------------------------------------- bills, subscriptions, price changes

const SUB_LIKE = new Set(['subscriptions']);

export function billsDue(app: AppContext, today = todayOf(app)) {
  const s = moneyStore(app);
  refreshBills(app, s);
  const bills = s
    .bills()
    .map((b) => ({ b, st: billStatus(b, today) }))
    .filter((x) => x.st.due)
    .sort((a, b) => a.st.due!.localeCompare(b.st.due!))
    .map(({ b, st }) => ({ id: b.id, name: b.name, amountCents: b.amountCents, repeat: b.repeat, due: st.due!, days: st.days!, paid: st.paid, autopay: b.autopay, reminder: Boolean(b.reminderId), leadDays: b.leadDays }));
  const names = s.bills().map((b) => b.name.toLowerCase());
  const recurring = findSubscriptions(s.transactions(), today)
    .filter((x) => !SUB_LIKE.has(x.category) && x.every !== 'week' && !x.maybeStopped && !cancelKnown(x.merchant) && !names.some((n) => n.includes(x.merchant) || x.merchant.includes(n)))
    .map((x) => ({ merchant: x.merchant, amountCents: x.amountCents, every: x.every, next: x.next, category: x.category }));
  return { bills, recurring };
}

export interface PriceChange {
  merchant: string;
  fromCents: number;
  toCents: number;
  on: string;
}
/** A recurring charge whose amount changed: the latest amount, the one before it and the first day of the new one. */
export function priceChanges(all: Tx[], today: string): PriceChange[] {
  const out: PriceChange[] = [];
  for (const sub of findSubscriptions(all, today)) {
    const days = [...new Map(all.filter((t) => t.merchant === sub.merchant && t.amountCents < 0).sort((a, b) => a.date.localeCompare(b.date)).map((t) => [t.date, -t.amountCents])).entries()];
    let i = days.length - 1;
    while (i > 0 && days[i - 1][1] === days[i][1]) i--;
    if (i <= 0) continue;
    const from = days[i - 1][1];
    const to = days[i][1];
    if (Math.abs(to - from) < 50 || Math.abs(to - from) * 100 < from) continue;
    out.push({ merchant: sub.merchant, fromCents: from, toCents: to, on: days[i][0] });
  }
  return out;
}

/** Public account or help pages where a person cancels a service themselves (Sara never does). */
const CANCEL: [RegExp, string][] = [
  [/netflix/, 'https://www.netflix.com/cancelplan'],
  [/spotify/, 'https://www.spotify.com/account/subscription/'],
  [/hulu/, 'https://secure.hulu.com/account'],
  [/disney/, 'https://www.disneyplus.com/account'],
  [/apple|itunes|icloud/, 'https://support.apple.com/en-us/118428'],
  [/amazon prime|prime video|amzn prime/, 'https://www.amazon.com/mc'],
  [/audible/, 'https://www.audible.com/account/overview'],
  [/youtube/, 'https://www.youtube.com/paid_memberships'],
  [/adobe/, 'https://account.adobe.com/plans'],
  [/microsoft|xbox/, 'https://account.microsoft.com/services'],
  [/dropbox/, 'https://www.dropbox.com/account/plan'],
  [/google (one|storage)/, 'https://one.google.com/storage'],
  [/paramount/, 'https://www.paramountplus.com/account/'],
  [/peacock/, 'https://www.peacocktv.com/account/plans'],
  [/patreon/, 'https://www.patreon.com/settings/memberships'],
  [/nytimes|new york times/, 'https://myaccount.nytimes.com/seg/subscription'],
];
const cancelKnown = (merchant: string) => CANCEL.some(([re]) => re.test(merchant.toLowerCase()));
export function cancelLink(merchant: string): string {
  const m = merchant.toLowerCase();
  for (const [re, url] of CANCEL) if (re.test(m)) return url;
  return `https://duckduckgo.com/?q=${encodeURIComponent(`how to cancel ${m}`).replace(/%20/g, '+')}`;
}

export function subscriptionsOf(s: MoneyStore, today: string) {
  const all = s.transactions();
  const changes = new Map(priceChanges(all, today).map((p) => [p.merchant, p]));
  return findSubscriptions(all, today)
    .filter((x) => SUB_LIKE.has(x.category) || x.every === 'year' || cancelKnown(x.merchant))
    .map((x) => ({ ...x, priceChange: changes.get(x.merchant) ?? null, cancel: cancelLink(x.merchant) }));
}

// ---------------------------------------------------------------- subscriptions in mail

function ensureMail(s: MoneyStore): void {
  s.db.exec(`CREATE TABLE IF NOT EXISTS money_mailsubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE, merchant TEXT NOT NULL, kind TEXT NOT NULL, ends TEXT,
    from_cents INTEGER, to_cents INTEGER, subject TEXT NOT NULL, at TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0, reminder_id INTEGER)`);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** The first date written in a text: "November 20, 2026", "Nov 20 2026", "2026-11-20" or "11/20/2026". */
export function firstDate(text: string): string | undefined {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(text);
  const us = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(text);
  const found = [iso && { at: iso.index, d: `${iso[1]}-${iso[2]}-${iso[3]}` }, named && { at: named.index, d: `${named[3]}-${String(MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase().slice(0, 3))) + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}` }, us && { at: us.index, d: `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` }].filter(Boolean) as { at: number; d: string }[];
  return found.sort((a, b) => a.at - b.at)[0]?.d;
}

const TRIAL = /\bfree trial\b|\btrial (period )?(ends|ending|expires|will end|is ending|is about to end)\b/i;
const PRICE = /\bprice (increase|change|update)\b|\bnew price\b|\bprice (is|will be) (changing|going up)\b|\bprice will change\b|\bwe('| a)re raising\b/i;
const RENEW = /\b(subscription|membership|plan)\b.{0,60}\b(renews?|renewal|will be renewed)\b|\bauto-?renew/i;

/** Sender's display name, else the mail domain's first part. */
function senderName(from: string): string {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (name) return clip(name, 60);
  const dom = /@([^>\s]+)/.exec(from)?.[1] ?? from;
  return clip(dom.split('.').slice(-2, -1)[0] ?? dom, 60);
}

/**
 * A new email that is about a subscription: a free trial ending, a price change or a renewal. Kept
 * on the Money page (with a how-to-cancel link); a trial ending gets a Planner reminder two days
 * before and one gentle alert. Returns whether this mail was new and about a subscription.
 */
export function observeMoneyMail(app: AppContext, m: InboxMail): boolean {
  const blob = `${m.subject}\n${m.text ?? ''}`.slice(0, 6000);
  const kind = TRIAL.test(blob) ? 'trial' : PRICE.test(blob) ? 'price' : RENEW.test(blob) ? 'renewal' : undefined;
  if (!kind) return false;
  const s = moneyStore(app);
  ensureMail(s);
  const ref = `${m.account}|${m.id}`;
  if (s.db.prepare('SELECT 1 FROM money_mailsubs WHERE ref = ?').get(ref)) return false;
  const cents = [...blob.matchAll(/(?:US)?\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((x) => toCents(x[1])).filter((x): x is number => typeof x === 'number' && x > 0);
  const ends = firstDate(blob) ?? null;
  const merchant = senderName(m.from);
  const fromCents = kind === 'price' && cents.length >= 2 ? cents[0] : null;
  const toC = kind === 'price' ? (cents.length >= 2 ? cents[1] : (cents[0] ?? null)) : (cents[0] ?? null);
  const id = Number(s.db.prepare('INSERT INTO money_mailsubs (ref, merchant, kind, ends, from_cents, to_cents, subject, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(ref, merchant, kind, ends, fromCents, toC, clip(m.subject, 160), app.now().toISOString()).lastInsertRowid);
  const day = todayOf(app);
  const link = cancelLink(merchant);
  if (kind === 'trial' && ends && ends >= day) {
    const at = morningOf(addDays(ends, -2), tz(app));
    const when = new Date(`${ends}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (app.planner && at.getTime() > app.now().getTime()) {
      const r = app.planner.addReminder({ text: `${merchant}'s free trial ends ${when}. If you don't want to keep it, cancel it yourself before then: ${link}`, dueAt: at.toISOString(), conversationId: null });
      s.db.prepare('UPDATE money_mailsubs SET reminder_id = ? WHERE id = ?').run(r.id, id);
      noteNudgeReminder(app, r.id, 'trials', 0.75);
    }
    if (prefsOf(app).gentle) postAlert(app, 'money', { role: 'assistant', reason: 'proactive', nudge: { kind: 'trials', value: 0.7 }, content: T(app, en("{merchant}'s free trial ends on {day}{price}. If you don't want it, cancel it yourself before then ({link}). Sara never cancels or pays anything."), { merchant, day: when, price: toC ? ` (then ${fmtMoney(toC)})` : '', link }) });
  } else if (kind === 'price' && prefsOf(app).gentle) {
    postAlert(app, 'money', { role: 'assistant', reason: 'proactive', nudge: { value: 0.45 }, content: T(app, en('{merchant} is changing its price{change}. Tracking only: Sara never cancels or pays anything.'), { merchant, change: fromCents && toC ? ` from ${fmtMoney(fromCents)} to ${fmtMoney(toC)}` : toC ? ` to ${fmtMoney(toC)}` : '' }) });
  }
  return true;
}

export function mailSubs(s: MoneyStore) {
  ensureMail(s);
  return (s.db.prepare('SELECT * FROM money_mailsubs WHERE dismissed = 0 ORDER BY id').all() as Row[]).map((r) => ({
    id: Number(r.id),
    merchant: String(r.merchant),
    kind: String(r.kind) as 'trial' | 'price' | 'renewal',
    ends: r.ends == null ? null : String(r.ends),
    fromCents: r.from_cents == null ? null : Number(r.from_cents),
    toCents: r.to_cents == null ? null : Number(r.to_cents),
    subject: String(r.subject),
    at: String(r.at),
    cancel: cancelLink(String(r.merchant)),
  }));
}
export function dismissMailSub(app: AppContext, id: number): boolean {
  const s = moneyStore(app);
  ensureMail(s);
  const r = s.db.prepare('SELECT reminder_id FROM money_mailsubs WHERE id = ?').get(id) as Row | undefined;
  if (!r) return false;
  if (r.reminder_id != null) app.planner?.cancelReminder(Number(r.reminder_id));
  s.db.prepare('UPDATE money_mailsubs SET dismissed = 1 WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------- net worth

function ensureBalances(s: MoneyStore): void {
  s.db.exec(`CREATE TABLE IF NOT EXISTS money_balances (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, cents INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS money_networth (day TEXT PRIMARY KEY, assets INTEGER NOT NULL, debts INTEGER NOT NULL);`);
}
const balanceRows = (s: MoneyStore) => (s.db.prepare('SELECT * FROM money_balances ORDER BY kind, id').all() as Row[]).map((r) => ({ id: Number(r.id), name: String(r.name), kind: String(r.kind) as 'asset' | 'debt', cents: Number(r.cents), updatedAt: String(r.updated_at) }));

function cleanBalance(b: Record<string, unknown>): { name: string; kind: 'asset' | 'debt'; cents: number } {
  const name = clip(b.name, 80);
  if (!name) throw new MoneyHubError(400, en('Give the balance a name.'));
  const kind = b.kind === 'debt' ? 'debt' : 'asset';
  const cents = toCents(b.amount);
  if (cents === undefined || cents < 0 || cents > 1e14) throw new MoneyHubError(400, en('Type the amount as a number, like 2500.00.'));
  return { name, kind, cents };
}
function snapshot(app: AppContext, s: MoneyStore): void {
  const nw = totals(s);
  s.db.prepare('INSERT INTO money_networth (day, assets, debts) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET assets = excluded.assets, debts = excluded.debts').run(todayOf(app), nw.assets, nw.debts);
}
function totals(s: MoneyStore): { assets: number; debts: number; portfolio: LastValue | undefined } {
  ensureBalances(s);
  const rows = balanceRows(s);
  const portfolio = s.holdings().length || s.state<LastValue>('portfolio_last') ? s.state<LastValue>('portfolio_last') : undefined;
  return { assets: rows.filter((r) => r.kind === 'asset').reduce((n, r) => n + r.cents, 0) + (portfolio?.valueCents ?? 0), debts: rows.filter((r) => r.kind === 'debt').reduce((n, r) => n + r.cents, 0), portfolio };
}
export function addBalance(app: AppContext, b: Record<string, unknown>) {
  const s = moneyStore(app);
  ensureBalances(s);
  const v = cleanBalance(b);
  const id = Number(s.db.prepare('INSERT INTO money_balances (name, kind, cents, updated_at) VALUES (?, ?, ?, ?)').run(v.name, v.kind, v.cents, app.now().toISOString()).lastInsertRowid);
  snapshot(app, s);
  return balanceRows(s).find((r) => r.id === id)!;
}
export function updateBalance(app: AppContext, id: number, b: Record<string, unknown>) {
  const s = moneyStore(app);
  ensureBalances(s);
  const cur = balanceRows(s).find((r) => r.id === id);
  if (!cur) throw new MoneyHubError(404, en('That balance is gone.'));
  const v = cleanBalance({ name: b.name ?? cur.name, kind: b.kind ?? cur.kind, amount: b.amount ?? (cur.cents / 100).toFixed(2) });
  s.db.prepare('UPDATE money_balances SET name = ?, kind = ?, cents = ?, updated_at = ? WHERE id = ?').run(v.name, v.kind, v.cents, app.now().toISOString(), id);
  snapshot(app, s);
  return balanceRows(s).find((r) => r.id === id)!;
}
export function removeBalance(app: AppContext, id: number): boolean {
  const s = moneyStore(app);
  ensureBalances(s);
  const ok = Number(s.db.prepare('DELETE FROM money_balances WHERE id = ?').run(id).changes) > 0;
  if (ok) snapshot(app, s);
  return ok;
}
export function netWorth(app: AppContext) {
  const s = moneyStore(app);
  const t = totals(s);
  const history = (s.db.prepare('SELECT * FROM (SELECT * FROM money_networth ORDER BY day DESC LIMIT 24) ORDER BY day').all() as Row[]).map((r) => ({ day: String(r.day), netCents: Number(r.assets) - Number(r.debts) }));
  return { balances: balanceRows(s), assetsCents: t.assets, debtsCents: t.debts, netCents: t.assets - t.debts, portfolioCents: t.portfolio?.valueCents ?? null, portfolioAt: t.portfolio?.checkedAt ?? null, history };
}

// ---------------------------------------------------------------- categories

/** Merchants nothing matched (category "other", no rule), most frequent first. */
export function uncategorized(s: MoneyStore, max = 15): string[] {
  const rules = new Set(s.rules().map((r) => r.merchant));
  const n = new Map<string, number>();
  for (const t of s.transactions()) if (t.category === 'other' && t.amountCents < 0 && !rules.has(t.merchant)) n.set(t.merchant, (n.get(t.merchant) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, max).map(([m]) => m);
}

/** Optional: the person's model suggests categories for uncategorized merchants (names only, no amounts). They accept each. */
export async function suggestCategories(app: AppContext): Promise<{ merchant: string; category: string }[]> {
  if (!prefsOf(app).suggest) throw new MoneyHubError(400, en('Category suggestions are turned off. Turn them on below to let your model suggest.'));
  const s = moneyStore(app);
  const ask = uncategorized(s);
  if (!ask.length) return [];
  const cats = BUDGET_CATEGORIES.filter((c) => c !== 'other');
  const prompt = `Put each merchant in one spending category. Categories: ${cats.join(', ')}. Answer with a JSON object only, merchant → category; leave out any you are unsure of. Merchants:\n${ask.map((m) => `- ${m}`).join('\n')}`;
  const conv = { id: '', title: 'Money', private: false } as unknown as Parameters<typeof complete>[1];
  const out = await complete(app, conv, [{ role: 'user', content: prompt }], 400, 'quick');
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(/\{[\s\S]*\}/.exec(out)?.[0] ?? '{}') as Record<string, unknown>;
  } catch {
    return [];
  }
  return ask.filter((m) => typeof obj[m] === 'string').map((m) => ({ merchant: m, category: cleanBudgetCategory(obj[m]) ?? '' })).filter((x) => (cats as readonly string[]).includes(x.category));
}

// ---------------------------------------------------------------- the page

export function moneyOverview(app: AppContext, month?: string) {
  const s = moneyStore(app);
  const day = todayOf(app);
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : day.slice(0, 7);
  const prefs = prefsOf(app);
  const all = s.transactions();
  const sum = summarize(all, monthPeriod(m));
  const recent = s.transactions(monthPeriod(m)).slice(-80).reverse();
  const accounts = [...new Set(all.map((t) => t.account))];
  return {
    trackingOnly: T(app, TRACKING_ONLY),
    today: day,
    monthKey: m,
    month: { label: sum.period.label, spentCents: sum.spentCents, incomeCents: sum.incomeCents, previousSpentCents: sum.previousSpentCents, byCategory: sum.spending, topMerchants: sum.topMerchants, coverage: sum.coverage, count: sum.count },
    trends: trends(all, m, 6),
    budgets: budgetStatus(s, m === day.slice(0, 7) ? day : monthPeriod(m).to, prefs.nearPct),
    due: billsDue(app, day),
    subscriptions: subscriptionsOf(s, day),
    mailSubs: mailSubs(s),
    netWorth: netWorth(app),
    rules: s.rules().sort((a, b) => a.merchant.localeCompare(b.merchant)),
    uncategorized: uncategorized(s),
    mappings: Object.values(mapsOf(s)).map((x) => ({ sig: x.sig, bank: x.bank ?? '', columns: x.columns })),
    imports: s.imports(8),
    accounts,
    transactions: recent,
    categories: [...BUDGET_CATEGORIES],
    prefs,
    hasData: all.length > 0,
  };
}

/** Forget a saved column mapping (the next file of that layout asks again). */
export function forgetMapping(app: AppContext, sig: string): boolean {
  const s = moneyStore(app);
  const maps = mapsOf(s);
  if (!maps[sig]) return false;
  delete maps[sig];
  s.setState('csv_maps', maps);
  return true;
}

export { headerSig };
