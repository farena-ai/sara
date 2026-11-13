// E3 (docs/MONEY.md): portfolio value from E1's quotes, bill reminders through the Planner, budget
// limits, the briefing's portfolio line and Today's Money tile. No new timer: quotes come from E1's
// DataSources (one batched request, its 60-second cache), bill reminders are ordinary Planner
// reminders (the reminder tick delivers them), and limits are checked when transactions arrive.
import type { AppContext } from '../chat.ts';
import { roundHalf } from '../biz/money.ts';
import { addDays, daysBetween, localDay, morningOf } from '../biz/store.ts';
import type { QuoteResult } from '../data-sources.ts';
import { privateLocalOn } from '../net-guard.ts';
import type { PartCtx } from '../today.ts';
import { addMonths, monthPeriod, NOT_SPENDING } from './budget.ts';
import { moneyStore, type Bill, type Holding, type MoneyStore } from './store.ts';

// ---------------------------------------------------------------- portfolio

export interface ValuedRow {
  symbol: string;
  name: string;
  qty: number;
  price: number | null;
  valueCents: number;
  dayChangeCents: number;
  costCents: number | null;
  gainCents: number | null;
  /** Share of the whole portfolio, in % (one decimal). */
  allocationPct: number;
  accounts: string[];
}
export interface Valuation {
  valueCents: number;
  dayChangeCents: number;
  /** Today's move as a % of yesterday's value (two decimals), null without a change from the source. */
  dayPct: number | null;
  /** Gain against the cost basis, over the holdings that have one. */
  costCents: number;
  gainCents: number | null;
  gainPct: number | null;
  cashCents: number;
  rows: ValuedRow[];
  missing: string[];
  source: string;
  /** The oldest price time used (the data is at least this old). */
  at: string;
  currency: string;
}

const pct2 = (n: number) => Math.round(n * 100) / 100;

/** Values the holdings with one batched quote request (at most 25 symbols per request). */
export async function valuePortfolio(holdings: Holding[], quotes: (symbols: string[]) => Promise<QuoteResult>): Promise<Valuation> {
  const symbols = [...new Set(holdings.filter((h) => h.symbol !== 'CASH').map((h) => h.symbol))];
  const got = new Map<string, QuoteResult['quotes'][number]>();
  const missing: string[] = [];
  for (let i = 0; i < symbols.length; i += 25) {
    const r = await quotes(symbols.slice(i, i + 25));
    for (const q of r.quotes) got.set(q.symbol, q);
    missing.push(...r.missing);
  }
  const by = new Map<string, ValuedRow>();
  let cashCents = 0;
  for (const h of holdings) {
    if (h.symbol === 'CASH') {
      cashCents += h.cashCents ?? 0;
      continue;
    }
    const q = got.get(h.symbol);
    const row = by.get(h.symbol) ?? { symbol: h.symbol, name: h.name || q?.name || '', qty: 0, price: q?.price ?? null, valueCents: 0, dayChangeCents: 0, costCents: null, gainCents: null, allocationPct: 0, accounts: [] };
    row.qty = Math.round((row.qty + h.qty) * 10_000) / 10_000;
    if (!row.accounts.includes(h.account)) row.accounts.push(h.account);
    if (h.costCents !== null) row.costCents = (row.costCents ?? 0) + h.costCents;
    by.set(h.symbol, row);
  }
  const rows = [...by.values()];
  for (const r of rows) {
    const q = got.get(r.symbol);
    if (!q) continue;
    r.valueCents = roundHalf(r.qty * q.price * 100);
    r.dayChangeCents = q.change === null ? 0 : roundHalf(r.qty * q.change * 100);
    r.gainCents = r.costCents === null ? null : r.valueCents - r.costCents;
  }
  const valued = rows.filter((r) => got.has(r.symbol));
  const valueCents = valued.reduce((n, r) => n + r.valueCents, 0) + cashCents;
  for (const r of rows) r.allocationPct = valueCents ? Math.round((r.valueCents / valueCents) * 1000) / 10 : 0;
  const dayChangeCents = valued.reduce((n, r) => n + r.dayChangeCents, 0);
  const anyChange = valued.some((r) => got.get(r.symbol)!.change !== null);
  const withCost = valued.filter((r) => r.costCents !== null);
  const costCents = withCost.reduce((n, r) => n + (r.costCents ?? 0), 0);
  const gainCents = withCost.length ? withCost.reduce((n, r) => n + (r.gainCents ?? 0), 0) : null;
  const qs = [...got.values()];
  const at = qs.map((q) => q.at).sort()[0] ?? new Date(0).toISOString();
  const before = valueCents - dayChangeCents;
  return {
    valueCents,
    dayChangeCents,
    dayPct: anyChange && before > 0 ? pct2((dayChangeCents / before) * 100) : null,
    costCents,
    gainCents,
    gainPct: gainCents !== null && costCents > 0 ? pct2((gainCents / costCents) * 100) : null,
    cashCents,
    rows: rows.sort((a, b) => b.valueCents - a.valueCents),
    missing: [...new Set(missing)],
    source: [...new Set(qs.map((q) => q.source))].join(', ') || 'no source',
    at,
    currency: qs.find((q) => q.currency)?.currency ?? 'USD',
  };
}

export interface LastValue {
  valueCents: number;
  dayChangeCents: number;
  dayPct: number | null;
  source: string;
  at: string;
  checkedAt: string;
  currency: string;
}

/** Values the person's portfolio now (and keeps the result for Today and the briefing). */
export async function valueNow(app: AppContext): Promise<{ v: Valuation; holdings: Holding[] } | undefined> {
  const s = moneyStore(app);
  const holdings = s.holdings();
  if (!holdings.length) return undefined;
  const ds = app.dataSources;
  if (!ds) throw new Error('Live prices are not available here.');
  const v = await valuePortfolio(holdings, (syms) => ds.quotes(syms));
  s.setState('portfolio_last', { valueCents: v.valueCents, dayChangeCents: v.dayChangeCents, dayPct: v.dayPct, source: v.source, at: v.at, checkedAt: app.now().toISOString(), currency: v.currency } satisfies LastValue);
  return { v, holdings };
}

export const timeText = (iso: string, tz?: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
};
const money0 = (cents: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
  } catch {
    return `${Math.round(cents / 100)} ${currency}`;
  }
};
const signedPct = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}%`;

/** The briefing's line: \"Portfolio: $48,210, +0.8% today (Yahoo Finance, 9:31 AM)\". Undefined without holdings. */
export async function portfolioLine(app: AppContext): Promise<string | undefined> {
  const s = moneyStore(app);
  if (!s.holdings().length) return undefined;
  const tz = app.settings.get().timeZone;
  try {
    if (privateLocalOn()) throw new Error('private local mode');
    const r = await valueNow(app);
    if (!r) return undefined;
    const { v } = r;
    return `Portfolio: ${money0(v.valueCents, v.currency)}${v.dayPct === null ? '' : `, ${signedPct(v.dayPct)} today`} (${v.source}, ${timeText(v.at, tz)})${v.missing.length ? `; no price for ${v.missing.join(', ')}` : ''}`;
  } catch {
    const last = s.state<LastValue>('portfolio_last');
    if (!last) return 'Portfolio: no prices right now (the price source did not answer).';
    return `Portfolio: ${money0(last.valueCents, last.currency)} at the last check (${last.source}, ${localDay(new Date(last.at), tz)} ${timeText(last.at, tz)}); no fresh prices right now.`;
  }
}

// ---------------------------------------------------------------- bills

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
export const usDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A monthly due date in a month: the due day, or the month's last day when it is shorter. */
function dueIn(month: string, dueDay: number): string {
  return addMonths(`${month}-01`, 0).slice(0, 8) + String(Math.min(dueDay, Number(monthPeriod(month).to.slice(8)))).padStart(2, '0');
}

/** The bill's next due date on or after `from` (strictly after `after`, when given). */
export function nextDue(b: Pick<Bill, 'repeat' | 'dueDay' | 'dueDate'>, from: string, after?: string): string | null {
  if (b.repeat !== 'monthly') {
    if (!b.dueDate) return null;
    if (b.repeat === 'once') return b.dueDate;
    let d = b.dueDate;
    while (d < from || (after && d <= after)) d = addMonths(d, 12);
    return d;
  }
  let month = from.slice(0, 7);
  for (let i = 0; i < 26; i++) {
    const d = dueIn(month, b.dueDay ?? 1);
    if (d >= from && (!after || d > after)) return d;
    month = addMonths(`${month}-01`, 1).slice(0, 7);
  }
  return null;
}

const amountText = (b: Pick<Bill, 'amountCents'>) => (b.amountCents === null ? '' : ` (${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(b.amountCents / 100)})`);

/** The reminder for a bill: lead days before the next due date, 9 AM local; monthly bills repeat monthly. */
export function billReminder(b: Bill, tz: string | undefined, now: Date, after?: string): { text: string; dueAt: string; repeat: 'monthly' | 'none'; due: string } | undefined {
  const today = localDay(now, tz);
  let due = nextDue(b, today, after);
  for (let i = 0; due && i < 3; i++) {
    const at = morningOf(addDays(due, -b.leadDays), tz);
    if (at.getTime() > now.getTime()) {
      const when = b.repeat === 'monthly' ? `on the ${ordinal(b.dueDay ?? 1)}` : `on ${usDay(due)}`;
      const text = `${b.name}${amountText(b)} is due ${when}, in ${b.leadDays} day${b.leadDays === 1 ? '' : 's'}.${b.autopay ? ' Autopay is on: just check that it went through.' : ''} Tell me when it's paid (bill_paid).`;
      return { text, dueAt: at.toISOString(), repeat: b.repeat === 'monthly' ? 'monthly' : 'none', due };
    }
    if (b.repeat === 'once') return undefined;
    due = nextDue(b, today, due ?? undefined);
  }
  return undefined;
}

/** (Re)sets the bill's Planner reminder. */
export function scheduleBill(app: AppContext, s: MoneyStore, b: Bill, conversationId: string | null, after?: string): Bill {
  const planner = app.planner;
  if (!planner) return b;
  if (b.reminderId) planner.cancelReminder(b.reminderId);
  const plan = b.done ? undefined : billReminder(b, app.settings.get().timeZone, app.now(), after);
  const id = plan ? planner.addReminder({ text: plan.text, dueAt: plan.dueAt, repeat: plan.repeat, conversationId }).id : null;
  return s.setBill(b.id, { reminderId: id })!;
}

/** Yearly bills roll to next year once their date passes; one-time bills that were paid are done. */
export function refreshBills(app: AppContext, s: MoneyStore = moneyStore(app)): void {
  const today = localDay(app.now(), app.settings.get().timeZone);
  for (const b of s.bills()) {
    if (b.repeat === 'yearly' && b.dueDate && b.dueDate < today) {
      const next = nextDue(b, today)!;
      scheduleBill(app, s, s.setBill(b.id, { dueDate: next })!, null);
    } else if (b.repeat === 'once' && b.paidFor) s.setBill(b.id, { done: true });
  }
}

/** Where the bill stands: its next due date, days to it, and whether that one is paid. */
export function billStatus(b: Bill, today: string): { due: string | null; days: number | null; paid: boolean } {
  // The current cycle: a monthly bill's due date this month (even if a few days past), else the next one.
  let due = nextDue(b, today);
  if (b.repeat === 'monthly') {
    const thisMonth = dueIn(today.slice(0, 7), b.dueDay ?? 1);
    if (thisMonth < today && b.paidFor !== thisMonth && daysBetween(thisMonth, today) <= 7) due = thisMonth;
  }
  if (b.repeat === 'once') due = b.dueDate;
  const paid = Boolean(due && b.paidFor === due);
  if (paid && due && b.repeat !== 'once') due = nextDue(b, today, due);
  return { due, days: due ? daysBetween(today, due) : null, paid: paid && b.repeat === 'once' };
}

// ---------------------------------------------------------------- limits

/** Categories over their monthly limit this month that weren't reported yet (each is reported once a month). */
export function newLimitWarnings(s: MoneyStore, today: string): { category: string; spentCents: number; limitCents: number }[] {
  const limits = s.limits();
  if (!limits.length) return [];
  const month = today.slice(0, 7);
  const p = monthPeriod(month);
  const spent = new Map<string, number>();
  for (const t of s.transactions({ from: p.from, to: p.to })) if (!NOT_SPENDING.has(t.category)) spent.set(t.category, (spent.get(t.category) ?? 0) - t.amountCents);
  const warned = s.state<Record<string, string[]>>('limits_warned') ?? {};
  const done = new Set(warned[month] ?? []);
  const out = limits.filter((l) => (spent.get(l.category) ?? 0) > l.cents && !done.has(l.category)).map((l) => ({ category: l.category, spentCents: spent.get(l.category) ?? 0, limitCents: l.cents }));
  if (out.length) s.setState('limits_warned', { [month]: [...done, ...out.map((o) => o.category)] });
  return out;
}

/** Tells the person once (a notification; the tool's answer carries it into the chat too). */
export function notifyLimits(app: AppContext, warnings: ReturnType<typeof newLimitWarnings>, conversationId: string | null): string {
  if (!warnings.length) return '';
  const fmt = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);
  const text = warnings.map((w) => `${w.category}: ${fmt(w.spentCents)} this month, over your ${fmt(w.limitCents)} limit`).join('; ');
  if (conversationId) void app.push?.notifyOwner('Budget limit', text.slice(0, 300), conversationId, `budget-${warnings.map((w) => w.category).join('-')}`).catch(() => {});
  return `Over the limit (told once this month): ${text}.`;
}

// ---------------------------------------------------------------- Today

export interface MoneyTile {
  portfolio: { valueCents: number; dayChangeCents: number; dayPct: number | null; source: string; at: string; currency: string } | null;
  bills: { count: number; totalCents: number; next: { name: string; due: string; autopay: boolean } } | null;
  month: { spentCents: number; label: string; over: number; through: string } | null;
}

/** Today's Money tile: only once the person has holdings, bills or transactions. */
export async function moneyPart(c: PartCtx): Promise<MoneyTile | undefined> {
  if (c.demo) return undefined;
  const s = moneyStore(c.app);
  const hasHoldings = s.holdings().length > 0;
  const bills = s.bills();
  const hasTx = s.hasTransactions();
  if (!hasHoldings && !bills.length && !hasTx) return undefined;
  let portfolio: MoneyTile['portfolio'] = null;
  if (hasHoldings) {
    let last = s.state<LastValue>('portfolio_last');
    const stale = !last || c.app.now().getTime() - Date.parse(last.checkedAt) > 5 * 60_000;
    if (stale && c.app.dataSources && !privateLocalOn()) {
      await Promise.race([valueNow(c.app), new Promise((r) => setTimeout(r, 5000).unref?.())]).catch(() => undefined);
      last = s.state<LastValue>('portfolio_last');
    }
    if (last) portfolio = { valueCents: last.valueCents, dayChangeCents: last.dayChangeCents, dayPct: last.dayPct, source: last.source, at: last.at, currency: last.currency };
  }
  let billsOut: MoneyTile['bills'] = null;
  if (bills.length) {
    refreshBills(c.app, s);
    const soon = s
      .bills()
      .map((b) => ({ b, st: billStatus(b, c.day) }))
      .filter((x) => x.st.due && !x.st.paid && x.st.days !== null && x.st.days >= -7 && x.st.days <= 7)
      .sort((a, b) => a.st.due!.localeCompare(b.st.due!));
    if (soon.length) billsOut = { count: soon.length, totalCents: soon.reduce((n, x) => n + (x.b.amountCents ?? 0), 0), next: { name: soon[0].b.name, due: soon[0].st.due!, autopay: soon[0].b.autopay } };
  }
  let month: MoneyTile['month'] = null;
  if (hasTx) {
    const p = monthPeriod(c.day.slice(0, 7));
    const list = s.transactions({ from: p.from, to: c.day });
    const spent = new Map<string, number>();
    for (const t of list) if (!NOT_SPENDING.has(t.category)) spent.set(t.category, (spent.get(t.category) ?? 0) - t.amountCents);
    const over = s.limits().filter((l) => (spent.get(l.category) ?? 0) > l.cents).length;
    const through = list.map((t) => t.date).sort().at(-1) ?? '';
    month = { spentCents: [...spent.values()].reduce((n, x) => n + x, 0), label: p.label, over, through };
  }
  return { portfolio, bills: billsOut, month };
}
