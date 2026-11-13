// E3 (docs/MONEY.md): the person's money store, in their space's first companion's store.db (like
// E6's business store: every companion of one person shares it; a household member's space is their
// own). Tables are additive (CREATE IF NOT EXISTS). Holdings are a snapshot per account: importing an
// account again replaces that account's holdings. Transactions are kept once: the same date, amount,
// merchant text and account (and the n-th such row in one file, so two equal coffees on one day both
// count) is a duplicate across imports.
import type { DatabaseSync } from 'node:sqlite';
import { categorize, merchantKey, ruleFor, type Rule, type Tx } from './budget.ts';
import type { HoldingIn, TxIn } from './parse.ts';

export interface Holding extends HoldingIn {
  id: number;
  importedAt: string;
}

export type BillRepeat = 'monthly' | 'yearly' | 'once';
export interface Bill {
  id: number;
  name: string;
  amountCents: number | null;
  repeat: BillRepeat;
  /** monthly: the day of the month (1-31). */
  dueDay: number | null;
  /** yearly and once: the next due date (YYYY-MM-DD). */
  dueDate: string | null;
  autopay: boolean;
  leadDays: number;
  reminderId: number | null;
  /** The due date the last payment was for (YYYY-MM-DD). */
  paidFor: string | null;
  paidAt: string | null;
  done: boolean;
  createdAt: string;
}

type Row = Record<string, unknown>;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** The dedupe key: date + amount + folded description + account (+ the n-th equal row in one file). */
export function txKey(t: Pick<TxIn, 'date' | 'amountCents' | 'description' | 'account'>, nth = 1): string {
  const desc = t.description.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${t.date}|${t.amountCents}|${desc}|${t.account.toLowerCase().trim()}|${nth}`;
}

const toTx = (r: Row): Tx => ({ id: Number(r.id), date: String(r.date), description: String(r.description), merchant: String(r.merchant), amountCents: Number(r.amount), account: String(r.account), category: String(r.category) });
const toBill = (r: Row): Bill => ({
  id: Number(r.id),
  name: String(r.name),
  amountCents: r.amount == null ? null : Number(r.amount),
  repeat: String(r.repeat) as BillRepeat,
  dueDay: r.due_day == null ? null : Number(r.due_day),
  dueDate: r.due_date == null ? null : String(r.due_date),
  autopay: Boolean(r.autopay),
  leadDays: Number(r.lead_days),
  reminderId: r.reminder_id == null ? null : Number(r.reminder_id),
  paidFor: r.paid_for == null ? null : String(r.paid_for),
  paidAt: r.paid_at == null ? null : String(r.paid_at),
  done: Boolean(r.done),
  createdAt: String(r.created_at),
});

export class MoneyStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS money_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', qty REAL NOT NULL,
      cost INTEGER, cash INTEGER, imported_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS money_tx (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, date TEXT NOT NULL, description TEXT NOT NULL, merchant TEXT NOT NULL,
      amount INTEGER NOT NULL, account TEXT NOT NULL, category TEXT NOT NULL, bank_category TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS money_tx_date ON money_tx(date);
    CREATE TABLE IF NOT EXISTS money_rules (merchant TEXT PRIMARY KEY, category TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS money_limits (category TEXT PRIMARY KEY, cents INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS money_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, amount INTEGER, repeat TEXT NOT NULL, due_day INTEGER, due_date TEXT,
      autopay INTEGER NOT NULL DEFAULT 0, lead_days INTEGER NOT NULL DEFAULT 3, reminder_id INTEGER, paid_for TEXT, paid_at TEXT,
      done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS money_state (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }

  state<T>(key: string): T | undefined {
    const r = this.#db.prepare('SELECT json FROM money_state WHERE key = ?').get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as T) : undefined;
  }
  setState(key: string, value: unknown): void {
    this.#db.prepare('INSERT INTO money_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(key, JSON.stringify(value));
  }

  // ---------- holdings ----------
  /** Replaces the holdings of every account in the import (an export is a snapshot). */
  importHoldings(list: HoldingIn[]): { accounts: string[]; count: number } {
    const iso = this.#now().toISOString();
    const accounts = [...new Set(list.map((h) => clip(h.account, 80) || 'Brokerage'))];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const a of accounts) this.#db.prepare('DELETE FROM money_holdings WHERE account = ?').run(a);
      const ins = this.#db.prepare('INSERT INTO money_holdings (account, symbol, name, qty, cost, cash, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const h of list) ins.run(clip(h.account, 80) || 'Brokerage', clip(h.symbol, 20), clip(h.name, 120), h.qty, h.costCents, h.cashCents, iso);
      // The last value was for the old holdings: Today and the briefing value the new ones afresh.
      this.#db.prepare("DELETE FROM money_state WHERE key = 'portfolio_last'").run();
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { accounts, count: list.length };
  }
  holdings(): Holding[] {
    return (this.#db.prepare('SELECT * FROM money_holdings ORDER BY account, symbol').all() as Row[]).map((r) => ({
      id: Number(r.id),
      account: String(r.account),
      symbol: String(r.symbol),
      name: String(r.name),
      qty: Number(r.qty),
      costCents: r.cost == null ? null : Number(r.cost),
      cashCents: r.cash == null ? null : Number(r.cash),
      importedAt: String(r.imported_at),
    }));
  }
  clearHoldings(account?: string): number {
    return Number((account ? this.#db.prepare('DELETE FROM money_holdings WHERE account = ?').run(account) : this.#db.prepare('DELETE FROM money_holdings').run()).changes);
  }

  // ---------- transactions ----------
  rules(): Rule[] {
    return (this.#db.prepare('SELECT merchant, category FROM money_rules').all() as Row[]).map((r) => ({ merchant: String(r.merchant), category: String(r.category) }));
  }

  /** Adds the new rows (duplicates of earlier imports are skipped), categorized. */
  importTransactions(rows: TxIn[]): { added: Tx[]; duplicates: number } {
    const rules = this.rules();
    const iso = this.#now().toISOString();
    const seen = new Map<string, number>();
    const added: Tx[] = [];
    let duplicates = 0;
    const ins = this.#db.prepare('INSERT OR IGNORE INTO money_tx (key, date, description, merchant, amount, account, category, bank_category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of rows) {
        const base = txKey(t, 0);
        const nth = (seen.get(base) ?? 0) + 1;
        seen.set(base, nth);
        const category = categorize(t, rules);
        const r = ins.run(txKey(t, nth), t.date, clip(t.description, 200), merchantKey(t.description), t.amountCents, clip(t.account, 80), category, clip(t.bankCategory, 60), iso);
        if (Number(r.changes)) added.push({ id: Number(r.lastInsertRowid), date: t.date, description: clip(t.description, 200), merchant: merchantKey(t.description), amountCents: t.amountCents, account: clip(t.account, 80), category });
        else duplicates++;
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { added, duplicates };
  }

  transactions(o: { from?: string; to?: string } = {}): Tx[] {
    return (this.#db.prepare('SELECT * FROM money_tx WHERE date >= ? AND date <= ? ORDER BY date, id').all(o.from ?? '0000-01-01', o.to ?? '9999-12-31') as Row[]).map(toTx);
  }
  hasTransactions(): boolean {
    return Boolean(this.#db.prepare('SELECT 1 FROM money_tx LIMIT 1').get());
  }

  /** The person's correction: this merchant is this category, now and from now on. Returns how many rows moved. */
  setRule(merchant: string, category: string): { merchant: string; changed: number } {
    const key = merchantKey(merchant);
    this.#db.prepare('INSERT INTO money_rules (merchant, category, created_at) VALUES (?, ?, ?) ON CONFLICT(merchant) DO UPDATE SET category = excluded.category').run(key, category, this.#now().toISOString());
    const rules = this.rules();
    let changed = 0;
    for (const t of this.transactions()) {
      if (ruleFor(t.merchant, rules)?.merchant !== key || t.category === category) continue;
      this.#db.prepare('UPDATE money_tx SET category = ? WHERE id = ?').run(category, t.id);
      changed++;
    }
    return { merchant: key, changed };
  }
  removeRule(merchant: string): boolean {
    return Number(this.#db.prepare('DELETE FROM money_rules WHERE merchant = ?').run(merchantKey(merchant)).changes) > 0;
  }

  limits(): { category: string; cents: number }[] {
    return (this.#db.prepare('SELECT category, cents FROM money_limits ORDER BY category').all() as Row[]).map((r) => ({ category: String(r.category), cents: Number(r.cents) }));
  }
  setLimit(category: string, cents: number): void {
    if (cents <= 0) this.#db.prepare('DELETE FROM money_limits WHERE category = ?').run(category);
    else this.#db.prepare('INSERT INTO money_limits (category, cents) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET cents = excluded.cents').run(category, cents);
  }

  // ---------- bills ----------
  addBill(b: { name: string; amountCents: number | null; repeat: BillRepeat; dueDay: number | null; dueDate: string | null; autopay: boolean; leadDays: number }): Bill {
    const r = this.#db
      .prepare('INSERT INTO money_bills (name, amount, repeat, due_day, due_date, autopay, lead_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(clip(b.name, 120), b.amountCents, b.repeat, b.dueDay, b.dueDate, b.autopay ? 1 : 0, b.leadDays, this.#now().toISOString());
    return this.bill(Number(r.lastInsertRowid))!;
  }
  bill(id: number): Bill | undefined {
    const r = this.#db.prepare('SELECT * FROM money_bills WHERE id = ?').get(id) as Row | undefined;
    return r ? toBill(r) : undefined;
  }
  bills(all = false): Bill[] {
    return (this.#db.prepare(`SELECT * FROM money_bills ${all ? '' : 'WHERE done = 0'} ORDER BY id`).all() as Row[]).map(toBill);
  }
  /** By number or (part of) its name. */
  findBill(ref: unknown): Bill | undefined {
    const s = String(ref ?? '').trim().replace(/^#/, '');
    if (!s) return undefined;
    if (/^\d+$/.test(s)) return this.bill(Number(s));
    const q = s.toLowerCase();
    const list = this.bills();
    return list.find((b) => b.name.toLowerCase() === q) ?? list.find((b) => b.name.toLowerCase().includes(q));
  }
  setBill(id: number, patch: Partial<Pick<Bill, 'reminderId' | 'paidFor' | 'paidAt' | 'done' | 'dueDate'>>): Bill | undefined {
    const cols: Record<string, string | number | null> = {};
    if (patch.reminderId !== undefined) cols.reminder_id = patch.reminderId;
    if (patch.paidFor !== undefined) cols.paid_for = patch.paidFor;
    if (patch.paidAt !== undefined) cols.paid_at = patch.paidAt;
    if (patch.done !== undefined) cols.done = patch.done ? 1 : 0;
    if (patch.dueDate !== undefined) cols.due_date = patch.dueDate;
    const keys = Object.keys(cols);
    if (keys.length) this.#db.prepare(`UPDATE money_bills SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
    return this.bill(id);
  }
  removeBill(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM money_bills WHERE id = ?').run(id).changes) > 0;
  }
}

const stores = new WeakMap<DatabaseSync, MoneyStore>();
/** This person's money store: their space's first companion's database (a household member's space is their own). */
export function moneyStore(app: { store: { db: DatabaseSync }; now: () => Date; companions?: { main: { app: { store: { db: DatabaseSync } } } } }): MoneyStore {
  let db = app.store.db;
  try {
    db = app.companions?.main.app.store.db ?? db;
  } catch {
    /* no companions here (tests, the demo) */
  }
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new MoneyStore(db, app.now)));
  return s;
}
