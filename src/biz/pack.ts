// U4.29 (docs/BUSINESS_PACK.md): the business pack's small records next to E6 (src/biz/store.ts)
// and N7 (src/work/*): which invoice a quote became, which expenses were billed on an invoice,
// and which Money transactions became business expenses. All in the person's own biz_state, so a
// household member's are their own. A void invoice frees its quote and expenses again (worked out
// on read, like "overdue").
import type { AppContext } from '../chat.ts';
import { moneyStore } from '../money/store.ts';
import { bizStore, type Expense } from './store.ts';

/** Money place categories (U4.20) → business expense categories (E6). */
export const MONEY_TO_BIZ: Record<string, string> = {
  groceries: 'Meals',
  dining: 'Meals',
  fuel: 'Fuel',
  utilities: 'Phone and internet',
  subscriptions: 'Software',
  shopping: 'Office supplies',
  travel: 'Travel',
  health: 'Other',
  income: 'Other',
  transfers: 'Other',
  other: 'Other',
};

type IdMap = Record<string, number>;
const live = (app: AppContext, invoiceId: number) => {
  const inv = bizStore(app).invoice(invoiceId);
  return Boolean(inv && inv.status !== 'void');
};

/** The invoice a quote became (undefined: none, or it was voided). */
export function quoteInvoiceOf(app: AppContext, quoteId: number): number | undefined {
  const id = bizStore(app).state<IdMap>('quote-invoices')?.[String(quoteId)];
  return id !== undefined && live(app, id) ? id : undefined;
}
export function setQuoteInvoice(app: AppContext, quoteId: number, invoiceId: number): void {
  const b = bizStore(app);
  b.setState('quote-invoices', { ...(b.state<IdMap>('quote-invoices') ?? {}), [String(quoteId)]: invoiceId });
}

/** Expense id → the (not void) invoice it was billed on. */
export function billedExpenses(app: AppContext): Map<number, number> {
  const all = bizStore(app).state<IdMap>('billed-expenses') ?? {};
  return new Map(
    Object.entries(all)
      .filter(([, inv]) => live(app, inv))
      .map(([e, inv]) => [Number(e), inv]),
  );
}
export function billExpenses(app: AppContext, ids: number[], invoiceId: number): void {
  const b = bizStore(app);
  const all = { ...(b.state<IdMap>('billed-expenses') ?? {}) };
  for (const id of ids) all[String(id)] = invoiceId;
  b.setState('billed-expenses', all);
}

/** A Money transaction (money out) → a business expense, once per transaction. */
export function expenseFromMoney(app: AppContext, txId: number): Expense {
  const b = bizStore(app);
  const tx = moneyStore(app).tx(txId);
  if (!tx) throw new Error('That transaction is not in Money any more.');
  if (tx.amountCents >= 0) throw new Error('Only money going out can be a business expense.');
  const done = b.state<IdMap>('from-money') ?? {};
  const prev = done[String(txId)];
  if (prev !== undefined && b.expense(prev)) throw new Error('That transaction is already a business expense.');
  const e = b.addExpense({
    vendor: (tx.merchant || tx.description).slice(0, 160),
    date: tx.date,
    totalCents: -tx.amountCents,
    taxCents: 0,
    category: MONEY_TO_BIZ[tx.category] ?? 'Other',
    currency: b.details().currency,
    docId: null,
    docName: '',
    note: `From Money${tx.account ? ` (${tx.account})` : ''}`,
  });
  b.setState('from-money', { ...done, [String(txId)]: e.id });
  return e;
}

/** Money transaction ids already taken as business expenses. */
export function takenFromMoney(app: AppContext): Set<number> {
  const b = bizStore(app);
  return new Set(
    Object.entries(b.state<IdMap>('from-money') ?? {})
      .filter(([, e]) => b.expense(e))
      .map(([t]) => Number(t)),
  );
}
