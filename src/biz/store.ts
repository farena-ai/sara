// E6 (docs/BUSINESS_TOOLS.md): invoices and quotes, expenses and the person's business details, in
// each person's own store.db (a household member's space has its own database, so numbers, invoices
// and expenses are theirs alone). Tables are additive (CREATE IF NOT EXISTS), like the other stores.
//
// Numbers: INV-2026-0001 and Q-2026-0001, one series per kind per year per space. Status is kept as
// draft / sent / paid / void (quotes: draft / sent / accepted / void); "overdue" is worked out from
// the due date on read, never stored, so it can't go stale.
import type { DatabaseSync } from 'node:sqlite';
import { zonedParts, zonedToUtc } from '../planner.ts';
import { totals, type Line, type LineIn } from './money.ts';

export type InvoiceKind = 'invoice' | 'quote';
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'accepted' | 'void';
export type ShownStatus = InvoiceStatus | 'overdue';

export interface Invoice {
  id: number;
  kind: InvoiceKind;
  number: string;
  clientName: string;
  clientEmail: string;
  clientAddress: string;
  lines: Line[];
  taxRatePct: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  /** Local dates, YYYY-MM-DD. */
  issued: string;
  due: string | null;
  notes: string;
  status: InvoiceStatus;
  sentAt: string | null;
  paidAt: string | null;
  docIds: number[];
  reminderIds: number[];
  createdAt: string;
}

export interface Expense {
  id: number;
  vendor: string;
  /** YYYY-MM-DD */
  date: string;
  totalCents: number;
  taxCents: number;
  category: string;
  currency: string;
  /** The receipt in the Library (picture or PDF), when there is one. */
  docId: number | null;
  docName: string;
  note: string;
  createdAt: string;
}

export interface BusinessDetails {
  name: string;
  address: string;
  email: string;
  phone: string;
  taxId: string;
  /** A picture in the Library (its number), shown at the top of invoices. */
  logoDocId: number | null;
  payment: string;
  currency: string;
  /** Default tax rate in % and payment terms in days. */
  taxRatePct: number;
  dueDays: number;
}

export const DEFAULT_DETAILS: BusinessDetails = { name: '', address: '', email: '', phone: '', taxId: '', logoDocId: null, payment: '', currency: 'USD', taxRatePct: 0, dueDays: 30 };
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN', 'BRL', 'CHF', 'JPY', 'INR'] as const;
export const EXPENSE_CATEGORIES = ['Meals', 'Travel', 'Lodging', 'Fuel', 'Office supplies', 'Software', 'Equipment', 'Phone and internet', 'Advertising', 'Professional services', 'Shipping', 'Other'] as const;

type Row = Record<string, unknown>;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** YYYY-MM-DD of a moment in a time zone. */
export function localDay(at: Date, timeZone?: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
/** A local day plus n days (calendar arithmetic, no time zone shifts). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}
/** 9:00 local on a day, as a Date. */
export function morningOf(day: string, timeZone?: string): Date {
  const [y, mo, d] = day.split('-').map(Number);
  return zonedToUtc(y, mo, d, 9, 0, timeZone);
}

/** What a list shows: an unpaid invoice past its due date is overdue. */
export function shownStatus(inv: Pick<Invoice, 'kind' | 'status' | 'due'>, today: string): ShownStatus {
  if (inv.kind === 'invoice' && inv.status === 'sent' && inv.due && inv.due < today) return 'overdue';
  return inv.status;
}

const toInvoice = (r: Row): Invoice => {
  const lines = JSON.parse(String(r.lines)) as Line[];
  return {
    id: Number(r.id),
    kind: String(r.kind) as InvoiceKind,
    number: String(r.number),
    clientName: String(r.client_name),
    clientEmail: String(r.client_email),
    clientAddress: String(r.client_address),
    lines,
    taxRatePct: Number(r.tax_rate),
    subtotalCents: Number(r.subtotal),
    taxCents: Number(r.tax),
    totalCents: Number(r.total),
    currency: String(r.currency),
    issued: String(r.issued),
    due: r.due == null ? null : String(r.due),
    notes: String(r.notes),
    status: String(r.status) as InvoiceStatus,
    sentAt: r.sent_at == null ? null : String(r.sent_at),
    paidAt: r.paid_at == null ? null : String(r.paid_at),
    docIds: JSON.parse(String(r.doc_ids)) as number[],
    reminderIds: JSON.parse(String(r.reminder_ids)) as number[],
    createdAt: String(r.created_at),
  };
};
const toExpense = (r: Row): Expense => ({
  id: Number(r.id),
  vendor: String(r.vendor),
  date: String(r.date),
  totalCents: Number(r.total),
  taxCents: Number(r.tax),
  category: String(r.category),
  currency: String(r.currency),
  docId: r.doc_id == null ? null : Number(r.doc_id),
  docName: String(r.doc_name),
  note: String(r.note),
  createdAt: String(r.created_at),
});

export class BizStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS biz_details (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS biz_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, year INTEGER NOT NULL, seq INTEGER NOT NULL, number TEXT NOT NULL,
      client_name TEXT NOT NULL, client_email TEXT NOT NULL DEFAULT '', client_address TEXT NOT NULL DEFAULT '',
      lines TEXT NOT NULL, tax_rate REAL NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL, tax INTEGER NOT NULL, total INTEGER NOT NULL,
      currency TEXT NOT NULL, issued TEXT NOT NULL, due TEXT, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      sent_at TEXT, paid_at TEXT, doc_ids TEXT NOT NULL DEFAULT '[]', reminder_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE (kind, year, seq));
    CREATE TABLE IF NOT EXISTS biz_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, vendor TEXT NOT NULL, date TEXT NOT NULL, total INTEGER NOT NULL, tax INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL, currency TEXT NOT NULL, doc_id INTEGER, doc_name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS biz_expenses_date ON biz_expenses(date);
    CREATE TABLE IF NOT EXISTS biz_state (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }

  // ---------- business details ----------
  details(): BusinessDetails {
    const r = this.#db.prepare('SELECT json FROM biz_details WHERE id = 1').get() as Row | undefined;
    return r ? { ...DEFAULT_DETAILS, ...(JSON.parse(String(r.json)) as Partial<BusinessDetails>) } : { ...DEFAULT_DETAILS };
  }
  saveDetails(input: Record<string, unknown>): BusinessDetails {
    const cur = this.details();
    const has = (k: string) => Object.hasOwn(input, k);
    const num = (v: unknown, lo: number, hi: number, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    const next: BusinessDetails = {
      name: has('name') ? clip(input.name, 120) : cur.name,
      address: has('address') ? clip(input.address, 400) : cur.address,
      email: has('email') ? clip(input.email, 200) : cur.email,
      phone: has('phone') ? clip(input.phone, 60) : cur.phone,
      taxId: has('taxId') ? clip(input.taxId, 60) : cur.taxId,
      logoDocId: has('logoDocId') ? (Number.isInteger(Number(input.logoDocId)) && Number(input.logoDocId) > 0 ? Number(input.logoDocId) : null) : cur.logoDocId,
      payment: has('payment') ? clip(input.payment, 600) : cur.payment,
      currency: has('currency') && (CURRENCIES as readonly string[]).includes(String(input.currency)) ? String(input.currency) : cur.currency,
      taxRatePct: has('taxRatePct') ? roundRate(num(input.taxRatePct, 0, 50, cur.taxRatePct)) : cur.taxRatePct,
      dueDays: has('dueDays') ? Math.round(num(input.dueDays, 0, 365, cur.dueDays)) : cur.dueDays,
    };
    this.#db.prepare('INSERT INTO biz_details (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(JSON.stringify(next));
    return next;
  }

  /** Small remembered facts (the last follow-ups count for Today). */
  state<T>(key: string): T | undefined {
    const r = this.#db.prepare('SELECT json FROM biz_state WHERE key = ?').get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as T) : undefined;
  }
  setState(key: string, value: unknown): void {
    this.#db.prepare('INSERT INTO biz_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(key, JSON.stringify(value));
  }

  // ---------- invoices and quotes ----------
  /** The next number for a kind in a year (INV-2026-0001, Q-2026-0001). */
  nextNumber(kind: InvoiceKind, year: number): { seq: number; number: string } {
    const r = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM biz_invoices WHERE kind = ? AND year = ?').get(kind, year) as Row;
    const seq = Number(r.n) + 1;
    return { seq, number: `${kind === 'quote' ? 'Q' : 'INV'}-${year}-${String(seq).padStart(4, '0')}` };
  }

  createInvoice(i: { kind: InvoiceKind; clientName: string; clientEmail?: string; clientAddress?: string; items: LineIn[]; taxRatePct?: number; currency?: string; issued: string; dueDays?: number | null; notes?: string }): Invoice {
    const t = totals(i.items, i.taxRatePct ?? 0);
    const year = Number(i.issued.slice(0, 4));
    const due = i.dueDays === null || i.dueDays === undefined ? null : addDays(i.issued, i.dueDays);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const { seq, number } = this.nextNumber(i.kind, year);
      const r = this.#db
        .prepare('INSERT INTO biz_invoices (kind, year, seq, number, client_name, client_email, client_address, lines, tax_rate, subtotal, tax, total, currency, issued, due, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(i.kind, year, seq, number, clip(i.clientName, 160), clip(i.clientEmail, 200), clip(i.clientAddress, 400), JSON.stringify(t.lines), i.taxRatePct ?? 0, t.subtotalCents, t.taxCents, t.totalCents, i.currency ?? 'USD', i.issued, due, clip(i.notes, 2000), 'draft', this.#now().toISOString());
      this.#db.exec('COMMIT');
      return this.invoice(Number(r.lastInsertRowid))!;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  invoice(id: number): Invoice | undefined {
    const r = this.#db.prepare('SELECT * FROM biz_invoices WHERE id = ?').get(id) as Row | undefined;
    return r ? toInvoice(r) : undefined;
  }
  /** By number ("INV-2026-0003", "inv 3", "3") or id. */
  find(ref: unknown): Invoice | undefined {
    const s = String(ref ?? '').trim();
    if (!s) return undefined;
    const exact = this.#db.prepare('SELECT * FROM biz_invoices WHERE upper(number) = upper(?)').get(s) as Row | undefined;
    if (exact) return toInvoice(exact);
    const m = /^(?:#|inv(?:oice)?\s*#?|q(?:uote)?\s*#?)?\s*(\d+)$/i.exec(s);
    if (m) {
      const kind = /^q/i.test(s) ? 'quote' : /^inv/i.test(s) ? 'invoice' : undefined;
      const rows = (this.#db.prepare('SELECT * FROM biz_invoices WHERE seq = ? ORDER BY year DESC, id DESC').all(Number(m[1])) as Row[]).map(toInvoice).filter((x) => !kind || x.kind === kind);
      if (rows.length) return rows[0];
      return this.invoice(Number(m[1]));
    }
    return undefined;
  }
  invoices(): Invoice[] {
    return (this.#db.prepare('SELECT * FROM biz_invoices ORDER BY id DESC').all() as Row[]).map(toInvoice);
  }
  setInvoice(id: number, patch: Partial<Pick<Invoice, 'status' | 'sentAt' | 'paidAt' | 'docIds' | 'reminderIds'>>): Invoice | undefined {
    const cols: Record<string, unknown> = {};
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.sentAt !== undefined) cols.sent_at = patch.sentAt;
    if (patch.paidAt !== undefined) cols.paid_at = patch.paidAt;
    if (patch.docIds !== undefined) cols.doc_ids = JSON.stringify(patch.docIds);
    if (patch.reminderIds !== undefined) cols.reminder_ids = JSON.stringify(patch.reminderIds);
    const keys = Object.keys(cols);
    if (keys.length) this.#db.prepare(`UPDATE biz_invoices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => cols[k]) as never[]), id);
    return this.invoice(id);
  }

  /** Unpaid invoices (sent, not paid or void): their total and how many are overdue. */
  moneyIn(today: string): { unpaidCents: number; unpaid: number; overdue: number; currency: string } | undefined {
    const all = this.invoices().filter((i) => i.kind === 'invoice');
    if (!all.length) return undefined;
    const open = all.filter((i) => i.status === 'sent');
    return { unpaidCents: open.reduce((n, i) => n + i.totalCents, 0), unpaid: open.length, overdue: open.filter((i) => shownStatus(i, today) === 'overdue').length, currency: open[0]?.currency ?? all[0].currency };
  }

  // ---------- expenses ----------
  addExpense(e: Omit<Expense, 'id' | 'createdAt'>): Expense {
    const r = this.#db
      .prepare('INSERT INTO biz_expenses (vendor, date, total, tax, category, currency, doc_id, doc_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(clip(e.vendor, 160), e.date, e.totalCents, e.taxCents, clip(e.category, 60), e.currency, e.docId, clip(e.docName, 200), clip(e.note, 500), this.#now().toISOString());
    return this.expense(Number(r.lastInsertRowid))!;
  }
  expense(id: number): Expense | undefined {
    const r = this.#db.prepare('SELECT * FROM biz_expenses WHERE id = ?').get(id) as Row | undefined;
    return r ? toExpense(r) : undefined;
  }
  expenses(o: { from?: string; to?: string; category?: string } = {}): Expense[] {
    return (this.#db.prepare('SELECT * FROM biz_expenses WHERE date >= ? AND date <= ? ORDER BY date, id').all(o.from ?? '0000-01-01', o.to ?? '9999-12-31') as Row[]).map(toExpense).filter((x) => !o.category || x.category.toLowerCase() === o.category.toLowerCase());
  }
  /** The same receipt again: same vendor (folded), same day, same total. */
  duplicateOf(e: Pick<Expense, 'vendor' | 'date' | 'totalCents'>): Expense | undefined {
    const v = foldVendor(e.vendor);
    return this.expenses({ from: e.date, to: e.date }).find((x) => x.totalCents === e.totalCents && foldVendor(x.vendor) === v);
  }
  deleteExpense(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM biz_expenses WHERE id = ?').run(id).changes) > 0;
  }
}

export const foldVendor = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|store|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const roundRate = (n: number) => Math.round(n * 1000) / 1000;

const stores = new WeakMap<DatabaseSync, BizStore>();
/**
 * This person's business store: their space's first companion's database, so every companion of the
 * same person sees the same invoices, numbers and expenses (a household member's space is their own).
 */
export function bizStore(app: { store: { db: DatabaseSync }; now: () => Date; companions?: { main: { app: { store: { db: DatabaseSync } } } } }): BizStore {
  let db = app.store.db;
  try {
    db = app.companions?.main.app.store.db ?? db;
  } catch {
    /* no companions here (tests, the demo) */
  }
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new BizStore(db, app.now)));
  return s;
}
