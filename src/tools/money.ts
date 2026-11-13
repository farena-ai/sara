// E3 (docs/MONEY.md): money. portfolio_import / portfolio_show, budget_import / budget_summary /
// budget_category / budget_subscriptions / budget_limit, bill_add / bill_list / bill_paid /
// bill_remove. The person's own exports are read by code (src/money/parse.ts), every number is
// worked out in code in whole cents, prices come from E1's quote source with its name and time, and
// bill reminders are ordinary Planner reminders. Information and math, never advice: nothing here
// buys, sells, moves or pays anything.
import type { AppContext } from '../chat.ts';
import { DataError } from '../data-sources.ts';
import { privateLocalOn } from '../net-guard.ts';
import { fmtMoney, toCents } from '../biz/money.ts';
import { localDay } from '../biz/store.ts';
import { addMonths, cleanBudgetCategory, findSubscriptions, merchantKey, monthPeriod, summarize, type Period } from '../money/budget.ts';
import { billStatus, newLimitWarnings, notifyLimits, refreshBills, scheduleBill, usDay, valueNow } from '../money/core.ts';
import { holdingsFromText, MoneyParseError, readHoldings, readTransactions } from '../money/parse.ts';
import { moneyStore, type Bill, type BillRepeat } from '../money/store.ts';
import { whenText } from './data.ts';
import { findDoc } from './biz.ts';
import { ToolError, type Tool, type ToolContext } from './types.ts';

export const MONEY_TOOLS = ['portfolio_import', 'portfolio_show', 'budget_import', 'budget_summary', 'budget_category', 'budget_subscriptions', 'budget_limit', 'bill_add', 'bill_list', 'bill_paid', 'bill_remove'] as const;
export const NOT_ADVICE = 'Information and math only, not financial advice: you never suggest buying or selling.';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tz = (app: AppContext) => app.settings.get().timeZone;
const today = (app: AppContext) => localDay(app.now(), tz(app));
const usd = (c: number) => fmtMoney(c);
const signed = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${fmtMoney(Math.abs(c))}`;
const signedPct = (p: number | null) => (p === null ? 'n/a' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(2)}%`);

function ownChat(app: AppContext, ctx: ToolContext) {
  const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
  if (conv?.partner) throw new ToolError("Money is private to the person: ask in your own chat with me.");
  return conv;
}

function fileOf(app: AppContext, ctx: ToolContext, q: string): { name: string; bytes: Buffer } {
  const doc = findDoc(app, ctx.conversationId, q, /\.(csv|tsv|xlsx|xlsm|ofx|qfx|qbo|txt|pdf)$/i);
  const bytes = app.library!.file(doc);
  if (!bytes) throw new ToolError(`The file ${doc.name} is no longer on the server. Ask them to add it again.`);
  return { name: doc.name, bytes };
}

const wrap = async (f: () => Promise<string> | string): Promise<string> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof MoneyParseError) throw new ToolError(err.message);
    if (err instanceof DataError) throw new ToolError(`${err.message} Say so plainly; don't guess a number.`);
    throw err;
  }
};

function periodOf(app: AppContext, a: Record<string, unknown>): Period {
  const from = String(a.from ?? '').trim();
  const to = String(a.to ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    if (to < from) throw new ToolError('"to" is before "from".');
    return { from, to, label: `${usDay(from)} to ${usDay(to)}` };
  }
  const m = String(a.month ?? '').trim();
  if (m && !/^\d{4}-\d{2}$/.test(m)) throw new ToolError('month is YYYY-MM, like 2026-10.');
  return monthPeriod(m || today(app).slice(0, 7));
}

function billLine(b: Bill, day: string): string {
  const st = billStatus(b, day);
  const when = st.due ? `${st.days! < 0 ? `was due ${usDay(st.due)} (${-st.days!} days ago)` : st.days === 0 ? 'due today' : `due ${usDay(st.due)} (in ${st.days} days)`}` : 'no date';
  return `- #${b.id} ${b.name}${b.amountCents === null ? '' : ` · ${usd(b.amountCents)}`} · ${b.repeat === 'monthly' ? `monthly on day ${b.dueDay}` : b.repeat} · ${when}${st.paid ? ' · paid' : ''}${b.autopay ? ' · autopay' : ''}${b.paidAt ? ` · last paid ${usDay(b.paidAt.slice(0, 10))}` : ''} · reminder ${b.reminderId ? `${b.leadDays} days before` : 'none'}`;
}

export function createMoneyTools(getApp: () => AppContext): Tool[] {
  const base = { defaultPermission: 'auto' as const, isAvailable: () => true };
  return [
    {
      ...base,
      spec: {
        name: 'portfolio_import',
        description: "Load the person's investment holdings from their brokerage's positions export (CSV or Excel from Fidelity, Schwab, Vanguard, Robinhood, E*TRADE and others, in the Library or shared in this chat) or from a plain list they type (\"AAPL 10 @ 150\"). Each account in the import replaces that account's earlier holdings. Then use portfolio_show.",
        parameters: obj({ document: { type: 'string', description: 'The export file (its name or Library number).' }, text: { type: 'string', description: 'Or a plain list, one holding per line: symbol, shares, and optionally @ price paid per share or "cost" total.' }, account: { type: 'string', description: 'Optional account name when the file has none (default: Brokerage).' } }),
      },
      summarize: (a) => `Loading holdings${a.document ? ` from ${String(a.document).slice(0, 40)}` : ''}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const account = a.account ? String(a.account).slice(0, 80) : undefined;
          let list;
          let from: string;
          if (a.text && String(a.text).trim()) {
            list = holdingsFromText(String(a.text), account ?? 'Brokerage');
            from = 'the list you gave';
          } else {
            const f = fileOf(app, ctx, String(a.document ?? ''));
            list = readHoldings(f.name, f.bytes, account);
            from = f.name;
          }
          const r = moneyStore(app).importHoldings(list);
          const noCost = list.filter((h) => h.symbol !== 'CASH' && h.costCents === null).map((h) => h.symbol);
          return `Loaded ${r.count} holdings from ${from} (accounts: ${r.accounts.join(', ')}; each replaces that account's earlier holdings):\n${list.map((h) => `- ${h.account}: ${h.symbol === 'CASH' ? `cash ${usd(h.cashCents ?? 0)}` : `${h.symbol} ${h.qty} shares${h.costCents !== null ? `, cost basis ${usd(h.costCents)}` : ''}`}`).join('\n')}${noCost.length ? `\nNo cost basis for ${noCost.join(', ')} (gain can't be worked out for those).` : ''}\nCall portfolio_show for today's value. Price alerts: watch_add (kind price).`;
        }),
    },
    {
      ...base,
      interruptible: true,
      // Prices go over the network: off in private chats and "Nothing leaves this computer" (LIVE_DATA_TOOL).
      isAvailable: () => Boolean(getApp().dataSources) && !privateLocalOn(),
      spec: {
        name: 'portfolio_show',
        description: "The person's portfolio now: total value from live prices (E1's quote source, with its name and time), today's change, total gain against the cost basis, and the allocation by holding. Use it for \"how are my stocks doing\". Information and math only, never advice.",
        parameters: obj({}),
      },
      summarize: () => 'Valuing the portfolio',
      run: (_a, ctx) =>
        wrap(async () => {
          const app = getApp();
          ownChat(app, ctx);
          if (!moneyStore(app).holdings().length) return 'No holdings yet. Ask them for their brokerage\'s positions export (CSV) or a list like "AAPL 10 @ 150", then portfolio_import.';
          const r = await valueNow(app);
          const { v } = r!;
          const rows = v.rows.map((x) => `- ${x.symbol}${x.name ? ` (${x.name})` : ''}: ${x.qty} × ${x.price === null ? 'no price' : x.price} = ${usd(x.valueCents)} · ${x.allocationPct}% · today ${signed(x.dayChangeCents)}${x.gainCents !== null ? ` · gain ${signed(x.gainCents)} on cost ${usd(x.costCents!)}` : ''}${x.accounts.length > 1 ? ` · in ${x.accounts.join(', ')}` : ''}`);
          if (v.cashCents) rows.push(`- Cash: ${usd(v.cashCents)} · ${v.valueCents ? Math.round((v.cashCents / v.valueCents) * 1000) / 10 : 0}%`);
          return [
            `Portfolio value: ${usd(v.valueCents)} · today ${signed(v.dayChangeCents)} (${signedPct(v.dayPct)})${v.gainCents !== null ? ` · total gain ${signed(v.gainCents)} (${signedPct(v.gainPct)}) on a cost basis of ${usd(v.costCents)}` : ''}.`,
            ...rows,
            v.missing.length ? `No price for ${v.missing.join(', ')}: left out of the total (say so).` : '',
            `Prices from ${v.source}, as of ${whenText(v.at, tz(app))} (may be delayed up to 15 minutes). Computed by portfolio_show; use exactly these numbers with the source and time. ${NOT_ADVICE} If they ask whether to buy or sell, show these numbers (and offer the decide tool to weigh it), and say plainly it isn't financial advice.`,
          ]
            .filter(Boolean)
            .join('\n');
        }),
    },
    {
      ...base,
      spec: {
        name: 'budget_import',
        description: "Load the person's bank or credit-card transactions from their export (CSV, Excel, OFX or QFX in the Library or shared in this chat). Rows already loaded before are skipped (same date, amount, description and account). Each is put in a category (their own corrections first). Then budget_summary or budget_subscriptions.",
        parameters: obj({ document: { type: 'string', description: 'The export file (its name or Library number).' }, account: { type: 'string', description: 'Optional: a name for the account (e.g. "Chase card"), used when the file has none. Use the same name each time for one account.' } }, ['document']),
      },
      summarize: (a) => `Loading transactions from ${String(a.document ?? '').slice(0, 40)}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const f = fileOf(app, ctx, String(a.document ?? ''));
          const r = readTransactions(f.name, f.bytes, a.account ? String(a.account) : undefined);
          const s = moneyStore(app);
          const { added, duplicates } = s.importTransactions(r.rows);
          const dates = r.rows.map((x) => x.date).sort();
          const cats = new Map<string, number>();
          for (const t of added) cats.set(t.category, (cats.get(t.category) ?? 0) + 1);
          const warn = notifyLimits(app, newLimitWarnings(s, today(app)), ctx.conversationId ?? null);
          return [
            `Read ${r.rows.length} transactions from ${f.name} (${usDay(dates[0])} to ${usDay(dates.at(-1)!)}; accounts: ${[...new Set(r.rows.map((x) => x.account))].join(', ')}). Added ${added.length}; ${duplicates} were already loaded.${r.skipped ? ` ${r.skipped} rows weren't transactions (totals, notes) and were skipped.` : ''}${r.flipped ? ' This export wrote charges as positive numbers; they were read as money out.' : ''}`,
            added.length ? `Categories: ${[...cats].sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} ${n}`).join(', ')}. If one is wrong, budget_category fixes it for that merchant from now on.` : '',
            warn,
          ]
            .filter(Boolean)
            .join('\n');
        }),
    },
    {
      ...base,
      interruptible: true,
      spec: {
        name: 'budget_summary',
        description: "Spending from the person's loaded transactions for a month (default this month) or a date range: totals by category, against the previous period, the biggest changes, top merchants and income. All math in code; use exactly these numbers.",
        parameters: obj({ month: { type: 'string', description: 'YYYY-MM (default: this month).' }, from: { type: 'string', description: 'Or a range: YYYY-MM-DD…' }, to: { type: 'string', description: '…to YYYY-MM-DD.' } }),
      },
      summarize: (a) => `Budget for ${String(a.month ?? a.from ?? 'this month')}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          if (!s.hasTransactions()) return "No transactions yet. Ask for their bank or card export (CSV, OFX or QFX from the bank's website), then budget_import.";
          const p = periodOf(app, a);
          const sum = summarize(s.transactions(), p);
          const limits = new Map(s.limits().map((l) => [l.category, l.cents]));
          const pct = (c: number, of: number) => (of ? ` (${Math.round((c / of) * 1000) / 10}%)` : '');
          const lines = [
            `${p.label}: spent ${usd(sum.spentCents)} over ${sum.count} transactions; ${sum.previous.label}: ${usd(sum.previousSpentCents)} (${signed(sum.spentCents - sum.previousSpentCents)}). Income ${usd(sum.incomeCents)}.`,
            'By category:',
            ...sum.spending.map((c) => `- ${c.category}: ${usd(c.cents)}${pct(c.cents, sum.spentCents)} · ${c.count} transactions${limits.has(c.category) ? ` · limit ${usd(limits.get(c.category)!)}${c.cents > limits.get(c.category)! ? ' (over)' : ''}` : ''}`),
            sum.changes.length ? `Biggest changes vs ${sum.previous.label}: ${sum.changes.map((c) => `${c.category} ${signed(c.deltaCents)} (${usd(c.previousCents)} → ${usd(c.cents)})`).join('; ')}.` : '',
            sum.topMerchants.length ? `Top merchants: ${sum.topMerchants.map((m) => `${m.merchant} ${usd(m.cents)} (${m.count})`).join('; ')}.` : '',
            sum.coverage ? `Loaded transactions cover ${usDay(sum.coverage.from)} to ${usDay(sum.coverage.to)}${sum.coverage.to < p.to ? ': this period is only partly covered, say so' : ''}.` : '',
            notifyLimits(app, newLimitWarnings(s, today(app)), ctx.conversationId ?? null),
            'Computed by budget_summary from their own bank exports (transfers and card payments left out of spending). Use exactly these numbers.',
          ];
          return lines.filter(Boolean).join('\n');
        }),
    },
    {
      ...base,
      spec: {
        name: 'budget_category',
        description: 'Fix the category of a merchant\'s transactions, remembered for future imports ("Costco is groceries"). Categories: groceries, dining, fuel, utilities, subscriptions, shopping, travel, health, income, transfers, other, or the person\'s own word. category "auto" forgets their rule.',
        parameters: obj({ merchant: { type: 'string' }, category: { type: 'string' } }, ['merchant', 'category']),
      },
      summarize: (a) => `${String(a.merchant ?? '').slice(0, 30)} → ${String(a.category ?? '')}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          const merchant = String(a.merchant ?? '').trim();
          if (!merchantKey(merchant)) throw new ToolError('Which merchant?');
          if (String(a.category ?? '').trim().toLowerCase() === 'auto') return s.removeRule(merchant) ? `Forgot the rule for ${merchantKey(merchant)}; new imports use the usual categories.` : `There was no rule for ${merchantKey(merchant)}.`;
          const category = cleanBudgetCategory(a.category);
          if (!category) throw new ToolError('Which category?');
          const r = s.setRule(merchant, category);
          return `From now on “${r.merchant}” is ${category}; ${r.changed} loaded transaction${r.changed === 1 ? '' : 's'} moved.`;
        }),
    },
    {
      ...base,
      interruptible: true,
      spec: {
        name: 'budget_subscriptions',
        description: "Find the person's recurring charges in their loaded transactions (the same merchant, about the same amount, every week, month or year): amount, how often, the next expected date and the yearly cost. Any can become a bill with a reminder (bill_add with subscription).",
        parameters: obj({}),
      },
      summarize: () => 'Finding subscriptions',
      run: (_a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          if (!s.hasTransactions()) return 'No transactions yet: budget_import their bank or card export first (a few months shows monthly charges; a year or more shows yearly ones).';
          const subs = findSubscriptions(s.transactions(), today(app));
          if (!subs.length) return 'No recurring charges found in the loaded transactions (at least two charges of about the same amount a week, a month or a year apart are needed).';
          const active = subs.filter((x) => !x.maybeStopped);
          const total = active.reduce((n, x) => n + x.yearlyCents, 0);
          return `${subs.length} recurring charge${subs.length === 1 ? '' : 's'}; the ${active.length} still running cost ${usd(total)} a year:\n${subs.map((x) => `- ${x.merchant}: ${usd(x.amountCents)} every ${x.every} (${x.count} charges, last ${usDay(x.last)}) · next expected ${usDay(x.next)} · ${usd(x.yearlyCents)} a year${x.maybeStopped ? ' · no charge since, may have stopped' : ''}`).join('\n')}\nWorked out by budget_subscriptions from their transactions; the next dates are expectations, not facts.`;
        }),
    },
    {
      ...base,
      spec: {
        name: 'budget_limit',
        description: "Set a monthly spending limit for a category (amount 0 removes it). When the month's spending passes it, she tells the person once that month. Without arguments it lists the limits.",
        parameters: obj({ category: { type: 'string' }, amount: { type: 'string', description: 'Monthly amount, like 400 or "$400".' } }),
      },
      summarize: (a) => `Limit ${String(a.category ?? '')} ${String(a.amount ?? '')}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          if (!a.category) {
            const l = s.limits();
            return l.length ? l.map((x) => `- ${x.category}: ${usd(x.cents)} a month`).join('\n') : 'No limits set.';
          }
          const category = cleanBudgetCategory(a.category)!;
          const cents = toCents(a.amount ?? '');
          if (cents === undefined || cents < 0) throw new ToolError('Give the monthly amount, like 400 (0 removes the limit).');
          s.setLimit(category, cents);
          const warn = notifyLimits(app, newLimitWarnings(s, today(app)), ctx.conversationId ?? null);
          return `${cents ? `Limit for ${category}: ${usd(cents)} a month. She tells them once a month when it's passed (checked when transactions are loaded).` : `Removed the ${category} limit.`}${warn ? `\n${warn}` : ''}`;
        }),
    },
    {
      ...base,
      spec: {
        name: 'bill_add',
        description: 'Track a bill with a Planner reminder N days before it is due (default 3): monthly on a day of the month, yearly or once on a date. Or from a recurring charge found by budget_subscriptions (subscription: the merchant). Tracking only: she never pays anything.',
        parameters: obj({
          name: { type: 'string' },
          amount: { type: 'string', description: 'Optional amount, like 89.99.' },
          due_day: { type: 'number', description: 'monthly: day of the month (1-31).' },
          due_date: { type: 'string', description: 'yearly or once: the next due date, YYYY-MM-DD.' },
          repeat: { type: 'string', enum: ['monthly', 'yearly', 'once'] },
          autopay: { type: 'boolean' },
          remind_days_before: { type: 'number', description: 'Default 3 (0 = on the day).' },
          subscription: { type: 'string', description: 'Instead: a merchant from budget_subscriptions; its amount, rhythm and next date are used.' },
        }),
      },
      summarize: (a) => `Bill: ${String(a.name ?? a.subscription ?? '').slice(0, 40)}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          const day = today(app);
          let name = String(a.name ?? '').trim();
          let amountCents = a.amount === undefined || a.amount === '' ? null : (toCents(a.amount) ?? null);
          let repeat = String(a.repeat ?? '') as BillRepeat;
          let dueDay: number | null = a.due_day === undefined ? null : Math.round(Number(a.due_day));
          let dueDate: string | null = a.due_date ? String(a.due_date).trim() : null;
          if (a.subscription) {
            const key = merchantKey(String(a.subscription));
            const sub = findSubscriptions(s.transactions(), day).find((x) => x.merchant === key || x.merchant.includes(key) || key.includes(x.merchant));
            if (!sub) throw new ToolError(`No recurring charge like “${String(a.subscription)}”. Use budget_subscriptions to see them.`);
            if (sub.every === 'week') throw new ToolError('That one is weekly; bills are monthly, yearly or once.');
            name ||= sub.merchant.replace(/\b\w/g, (c) => c.toUpperCase());
            amountCents ??= sub.amountCents;
            repeat = sub.every === 'month' ? 'monthly' : 'yearly';
            if (repeat === 'monthly') dueDay ??= Number(sub.next.slice(8));
            else dueDate ??= sub.next;
          }
          if (!name) throw new ToolError('What is the bill called?');
          if (!['monthly', 'yearly', 'once'].includes(repeat)) repeat = dueDay !== null && !dueDate ? 'monthly' : 'once';
          if (repeat === 'monthly') {
            if (dueDay === null && dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) dueDay = Number(dueDate.slice(8));
            if (dueDay === null || !(dueDay >= 1 && dueDay <= 31)) throw new ToolError('Monthly bills need due_day (1-31).');
            dueDate = null;
          } else {
            if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new ToolError(`${repeat === 'yearly' ? 'Yearly' : 'One-time'} bills need due_date (YYYY-MM-DD).`);
            if (repeat === 'once' && dueDate < day) throw new ToolError('That date has passed.');
            dueDay = null;
          }
          const lead = a.remind_days_before === undefined ? 3 : Math.max(0, Math.min(30, Math.round(Number(a.remind_days_before) || 0)));
          let b = s.addBill({ name, amountCents, repeat, dueDay, dueDate, autopay: a.autopay === true, leadDays: lead });
          if (repeat === 'yearly') refreshBills(app, s);
          b = scheduleBill(app, s, s.bill(b.id)!, ctx.conversationId ?? null);
          const st = billStatus(b, day);
          const r = b.reminderId ? app.planner?.reminder(b.reminderId) : undefined;
          return `Bill #${b.id} added: ${billLine(b, day).slice(2)}.${r ? ` Planner reminder #${r.id} on ${whenText(r.dueAt, tz(app))}${b.repeat === 'monthly' ? ', every month' : ''}.` : st.days !== null && st.days <= lead ? ` It's due in ${st.days} days, sooner than the reminder would be: tell them now.` : ''} Tracking only: she never pays bills.`;
        }),
    },
    {
      ...base,
      interruptible: true,
      spec: { name: 'bill_list', description: "The person's bills: amount, next due date and days to it, paid or not, autopay, and the reminder.", parameters: obj({}) },
      summarize: () => 'Listing bills',
      run: (_a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          refreshBills(app, s);
          const day = today(app);
          const list = s.bills().sort((x, y) => (billStatus(x, day).due ?? '9').localeCompare(billStatus(y, day).due ?? '9'));
          if (!list.length) return 'No bills yet. bill_add adds one (or budget_subscriptions finds recurring charges).';
          const week = list.filter((b) => {
            const st = billStatus(b, day);
            return !st.paid && st.days !== null && st.days <= 7;
          });
          const total = week.reduce((n, b) => n + (b.amountCents ?? 0), 0);
          return `${list.map((b) => billLine(b, day)).join('\n')}\nDue within 7 days: ${week.length}${total ? ` (${usd(total)})` : ''}. Today is ${usDay(day)}.`;
        }),
    },
    {
      ...base,
      spec: { name: 'bill_paid', description: 'Mark a bill paid (by its number or name): this due date is done; monthly and yearly bills move to the next one.', parameters: obj({ bill: { type: 'string' } }, ['bill']) },
      summarize: (a) => `Paid: ${String(a.bill ?? '').slice(0, 30)}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          const b = s.findBill(a.bill);
          if (!b) throw new ToolError(`No bill “${String(a.bill ?? '')}”. Use bill_list.`);
          const day = today(app);
          const st = billStatus(b, day);
          const due = st.due ?? day;
          let next = s.setBill(b.id, { paidFor: due, paidAt: app.now().toISOString() })!;
          if (b.repeat === 'once') {
            next = s.setBill(b.id, { done: true })!;
            if (b.reminderId) app.planner?.cancelReminder(b.reminderId);
            return `Marked ${b.name} paid (it was due ${usDay(due)}); it's done.`;
          }
          if (b.repeat === 'yearly') next = s.setBill(b.id, { dueDate: addMonths(due, 12) })!;
          next = scheduleBill(app, s, next, ctx.conversationId ?? null, due);
          const after = billStatus(next, day);
          return `Marked ${b.name} paid for ${usDay(due)}. Next due ${after.due ? usDay(after.due) : 'unknown'}${next.reminderId ? `, with a reminder ${next.leadDays} days before` : ''}.`;
        }),
    },
    {
      ...base,
      spec: { name: 'bill_remove', description: 'Stop tracking a bill (by its number or name); its reminder is removed.', parameters: obj({ bill: { type: 'string' } }, ['bill']) },
      summarize: (a) => `Remove bill ${String(a.bill ?? '').slice(0, 30)}`,
      run: (a, ctx) =>
        wrap(() => {
          const app = getApp();
          ownChat(app, ctx);
          const s = moneyStore(app);
          const b = s.findBill(a.bill);
          if (!b) throw new ToolError(`No bill “${String(a.bill ?? '')}”. Use bill_list.`);
          if (b.reminderId) app.planner?.cancelReminder(b.reminderId);
          s.removeBill(b.id);
          return `Stopped tracking ${b.name} and removed its reminder.`;
        }),
    },
  ];
}
