// V2.2 (docs/PURCHASES.md): Purchases. What you bought (item, store, price, date, return-by,
// warranty-until), from receipt mail (the inbox helper's reader, src/inbox/classify.ts) and receipt
// photos or PDFs in the Library (the picture model's read text, like any document), or added by hand.
// The return-by date comes from the receipt itself ("return by Dec 20", "within 30 days"), else a
// small table of usual store windows; warranty dates from the receipt or facts.ts's warranty facts.
// A Planner reminder comes N days before a window closes, and "Start a return" opens an errand
// (src/errands.ts template `return`) that asks before anything is sent. Not src/receipts.ts: that is
// the claims checker for tool receipts. Kept in the person's own money store (members have their own).
import type { AppContext } from '../chat.ts';
import { fmtMoney, toCents } from '../biz/money.ts';
import { parseReceipt, receiptDate } from '../biz/expenses.ts';
import { addDays, localDay, morningOf } from '../biz/store.ts';
import { errandsFor, type Errand } from '../errands.ts';
import { DATE_RE, extractFacts, isoDate } from '../facts.ts';
import { en, trOwner } from '../i18n.ts';
import type { InboxMail, Finding } from '../inbox/classify.ts';
import { MoneyHubError } from './hub.ts';
import { subscriptionCharge } from './trim.ts';
import { moneyStore, type MoneyStore } from './store.ts';

export type PurchaseSource = 'mail' | 'photo' | 'hand';
export type PurchaseStatus = 'open' | 'kept' | 'returned';
/** Where a date came from: the receipt's own words, the store's usual window, a document, or you. */
export type TermFrom = 'receipt' | 'store' | 'document' | 'you';

export interface Purchase {
  id: number;
  item: string;
  store: string;
  priceCents: number | null;
  date: string;
  returnBy: string | null;
  returnFrom: TermFrom | null;
  warrantyUntil: string | null;
  warrantyFrom: TermFrom | null;
  source: PurchaseSource;
  order: string | null;
  docId: number | null;
  reminderId: number | null;
  errandId: number | null;
  status: PurchaseStatus;
  createdAt: string;
}

export interface PurchasePrefs {
  /** A Planner reminder before a return window closes. */
  remind: boolean;
  /** How many days before. */
  days: number;
}
const DEFAULT_PREFS: PurchasePrefs = { remind: true, days: 3 };
export const REMIND_DAYS = [1, 2, 3, 5, 7] as const;

/**
 * Usual return windows for common US stores (most items, with a receipt; some items differ, and the
 * receipt's own words always win). Shown on the page so the person can check them.
 */
export const STORE_POLICIES: { store: string; match: RegExp; days: number }[] = [
  { store: 'Amazon', match: /\bamazon\b/i, days: 30 },
  { store: 'Walmart', match: /\bwal-?mart\b/i, days: 90 },
  { store: 'Target', match: /\btarget\b/i, days: 90 },
  { store: 'Best Buy', match: /\bbest ?buy\b/i, days: 15 },
  { store: 'Costco', match: /\bcostco\b/i, days: 90 },
  { store: 'The Home Depot', match: /\bhome ?depot\b/i, days: 90 },
  { store: "Lowe's", match: /\blowe'?s\b/i, days: 90 },
  { store: 'Apple', match: /\bapple(?: store)?\b/i, days: 14 },
  { store: 'IKEA', match: /\bikea\b/i, days: 365 },
];

type Row = Record<string, unknown>;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const tz = (app: AppContext) => app.settings.get().timeZone;
const todayOf = (app: AppContext) => localDay(app.now(), tz(app));
const T = (app: AppContext, s: string, p?: Record<string, unknown>) => trOwner(s, app.settings.get(), p);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const usDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS money_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  date TEXT NOT NULL,
  return_by TEXT,
  return_from TEXT,
  warranty_until TEXT,
  warranty_from TEXT,
  source TEXT NOT NULL,
  order_no TEXT,
  doc_id INTEGER,
  reminder_id INTEGER,
  errand_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS money_purchase_seen (ref TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
const ready = new WeakSet<MoneyStore>();
function store(app: AppContext): MoneyStore {
  const s = moneyStore(app);
  if (!ready.has(s)) {
    s.db.exec(SCHEMA);
    ready.add(s);
  }
  return s;
}

function toPurchase(r: Row): Purchase {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return { id: Number(r.id), item: String(r.item), store: String(r.store), priceCents: n(r.price_cents), date: String(r.date), returnBy: s(r.return_by), returnFrom: s(r.return_from) as TermFrom | null, warrantyUntil: s(r.warranty_until), warrantyFrom: s(r.warranty_from) as TermFrom | null, source: String(r.source) as PurchaseSource, order: s(r.order_no), docId: n(r.doc_id), reminderId: n(r.reminder_id), errandId: n(r.errand_id), status: String(r.status) as PurchaseStatus, createdAt: String(r.created_at) };
}

// ---------------------------------------------------------------- reading the terms

const DATE = DATE_RE.source;
const NO_RETURN = /\b(final sale|no returns|non-?returnable|all sales (?:are )?final|cannot be returned)\b/i;
const RETURN_DATE = [
  new RegExp(`\\b(?:return(?:s|ed|able)?|exchange)\\b[^.\\n]{0,50}?\\b(?:by|until|through|before|no later than|on or before)\\s+(${DATE})`, 'i'),
  new RegExp(`\\b(?:return window (?:closes|ends)|last day (?:to|for) returns?)\\b[^.\\n]{0,15}?(${DATE})`, 'i'),
];
const RETURN_DAYS = [/\b(\d{1,3})[- ]day (?:return|returns|money[- ]back|refund|exchange)/i, /\breturn(?:s|ed| it| items?)?\b[^.\n]{0,60}?\bwithin (\d{1,3}) days\b/i];
const WARRANTY_DATE = new RegExp(`\\bwarranty\\b[^.\\n]{0,40}?\\b(?:until|through|ends?|expires?|to)\\s*:?\\s*(${DATE})`, 'i');
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10 };
const WARRANTY_LEN = [/\b(\d{1,2}|one|two|three|four|five|ten)[- ](year|yr|month)s?\b[^.\n]{0,30}?\bwarranty\b/i, /\bwarranty\b[^.\n]{0,20}?:?\s*(\d{1,2}) (year|month)s?\b/i];

function addMonthsDay(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

export function policyFor(storeName: string): { store: string; days: number } | undefined {
  const p = STORE_POLICIES.find((x) => x.match.test(storeName));
  return p ? { store: p.store, days: p.days } : undefined;
}

export interface ReceiptTerms {
  returnBy?: string | null;
  returnFrom?: TermFrom;
  warrantyUntil?: string;
  warrantyFrom?: TermFrom;
}

/**
 * The return-by and warranty dates a receipt's text gives (by code). The receipt's own words win
 * ("return by Dec 20, 2026", "within 30 days", "final sale" = no return); else the store's usual
 * window when the store is known. Nothing found = nothing set (the page says to check the store).
 */
export function readReceiptTerms(text: string, o: { date: string; store?: string }): ReceiptTerms {
  const out: ReceiptTerms = {};
  const t = text.slice(0, 20_000);
  if (NO_RETURN.test(t)) {
    out.returnBy = null;
    out.returnFrom = 'receipt';
  } else {
    for (const re of RETURN_DATE) {
      const d = re.exec(t)?.[1];
      const day = d ? isoDate(d) : null;
      if (day) {
        out.returnBy = day;
        out.returnFrom = 'receipt';
        break;
      }
    }
    if (!out.returnFrom)
      for (const re of RETURN_DAYS) {
        const n = Number(re.exec(t)?.[1]);
        if (n > 0 && n <= 730) {
          out.returnBy = addDays(o.date, n);
          out.returnFrom = 'receipt';
          break;
        }
      }
    const pol = !out.returnFrom && o.store ? policyFor(o.store) : undefined;
    if (pol) {
      out.returnBy = addDays(o.date, pol.days);
      out.returnFrom = 'store';
    }
  }
  const wd = WARRANTY_DATE.exec(t)?.[1];
  const wday = wd ? isoDate(wd) : null;
  if (wday) {
    out.warrantyUntil = wday;
    out.warrantyFrom = 'receipt';
  } else
    for (const re of WARRANTY_LEN) {
      const m = re.exec(t);
      if (!m) continue;
      const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (!(n > 0 && n <= 25)) continue;
      out.warrantyUntil = addMonthsDay(o.date, /^m/i.test(m[2]) ? n : n * 12);
      out.warrantyFrom = 'receipt';
      break;
    }
  return out;
}

/** Item lines on a receipt (a name followed by a price), without totals, tax or payment lines. */
export function receiptItems(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s+/g, ' ').trim();
    const m = /^(?:\d+\s*[x×]\s*)?(\p{L}[^$\n]{1,60}?)\s+\$?\d[\d,]*[.,]\d{2}\s*$/u.exec(l);
    if (!m) continue;
    if (/\b(total|subtotal|sub-total|tax|vat|change|cash|visa|mastercard|amex|debit|credit|balance|tip|discount|savings|shipping|tender|paid)\b/i.test(m[1])) continue;
    out.push(clip(m[1], 60));
    if (out.length >= max + 1) break;
  }
  return out;
}
function itemText(items: string[] | undefined, fallback: string): string {
  const list = (items ?? []).filter(Boolean);
  if (!list.length) return clip(fallback, 120);
  const shown = list.slice(0, 3).join(', ');
  return clip(list.length > 3 ? `${shown} +${list.length - 3}` : shown, 160);
}

// ---------------------------------------------------------------- prefs

export function purchasePrefs(app: AppContext): PurchasePrefs {
  return { ...DEFAULT_PREFS, ...(moneyStore(app).state<Partial<PurchasePrefs>>('purchases') ?? {}) };
}
export function setPurchasePrefs(app: AppContext, body: Record<string, unknown>): PurchasePrefs {
  const p = purchasePrefs(app);
  if (typeof body.remind === 'boolean') p.remind = body.remind;
  if (body.days !== undefined) {
    const n = Math.round(Number(body.days));
    if (!(REMIND_DAYS as readonly number[]).includes(n)) throw new MoneyHubError(400, en('Pick one of the offered levels.'));
    p.days = n;
  }
  moneyStore(app).setState('purchases', p);
  // Reminders follow the new choice.
  for (const x of purchases(app)) schedule(app, x);
  return p;
}

// ---------------------------------------------------------------- the list

export function purchases(app: AppContext): Purchase[] {
  return (store(app).db.prepare('SELECT * FROM money_purchases ORDER BY date DESC, id DESC').all() as Row[]).map(toPurchase);
}
export function purchase(app: AppContext, id: number): Purchase | undefined {
  const r = store(app).db.prepare('SELECT * FROM money_purchases WHERE id = ?').get(id) as Row | undefined;
  return r ? toPurchase(r) : undefined;
}

/** The return reminder for one purchase, set or moved or cleared to match it and the prefs. */
function schedule(app: AppContext, p: Purchase): Purchase {
  const planner = app.planner;
  if (!planner) return p;
  if (p.reminderId) planner.cancelReminder(p.reminderId);
  const prefs = purchasePrefs(app);
  let id: number | null = null;
  if (prefs.remind && p.status === 'open' && p.returnBy) {
    const at = morningOf(addDays(p.returnBy, -prefs.days), tz(app));
    if (at.getTime() > app.now().getTime()) {
      const text = T(app, en('Last chance to return {item} to {store}: the window closes {day}. Keep it, or start a return in Money → Purchases.'), { item: p.item, store: p.store || T(app, en('the store')), day: shortDay(p.returnBy) });
      id = planner.addReminder({ text, dueAt: at.toISOString(), conversationId: null }).id;
    }
  }
  store(app).db.prepare('UPDATE money_purchases SET reminder_id = ? WHERE id = ?').run(id, p.id);
  return { ...p, reminderId: id };
}

/** The same receipt seen another way (a photo and its email): same store, same total, within 3 days. */
function duplicateOf(app: AppContext, storeName: string, cents: number | null, date: string): Purchase | undefined {
  if (cents === null) return undefined;
  const f = fold(storeName);
  return purchases(app).find((p) => {
    if (p.priceCents !== cents) return false;
    const g = fold(p.store);
    if (!f || !g || !(f.startsWith(g) || g.startsWith(f))) return false;
    return Math.abs(Date.parse(`${p.date}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) <= 3 * 86_400_000;
  });
}

interface NewPurchase {
  item: string;
  store: string;
  priceCents: number | null;
  date: string;
  source: PurchaseSource;
  terms: ReceiptTerms;
  order?: string | null;
  docId?: number | null;
}
function insert(app: AppContext, n: NewPurchase): Purchase {
  const s = store(app);
  const id = Number(
    s.db
      .prepare('INSERT INTO money_purchases (item, store, price_cents, date, return_by, return_from, warranty_until, warranty_from, source, order_no, doc_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(clip(n.item, 160), clip(n.store, 80), n.priceCents, n.date, n.terms.returnBy ?? null, n.terms.returnFrom ?? null, n.terms.warrantyUntil ?? null, n.terms.warrantyFrom ?? null, n.source, n.order ? clip(n.order, 40) : null, n.docId ?? null, 'open', app.now().toISOString()).lastInsertRowid,
  );
  return schedule(app, purchase(app, id)!);
}
function seen(app: AppContext, ref: string): boolean {
  return Boolean(store(app).db.prepare('SELECT 1 FROM money_purchase_seen WHERE ref = ?').get(ref));
}
function markSeen(app: AppContext, ref: string): void {
  store(app).db.prepare('INSERT OR IGNORE INTO money_purchase_seen (ref, at) VALUES (?, ?)').run(ref, app.now().toISOString());
}

const day = (v: unknown, what: string): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!DAY.test(s) || !isoDate(s)) throw new MoneyHubError(400, en('Use a date like 2026-12-01.'));
  void what;
  return s;
};

/** A purchase added by hand (the page, or the model with purchase_add). `text` = a receipt's words, read for its terms. */
export function addPurchase(app: AppContext, b: Record<string, unknown>, source: PurchaseSource = 'hand'): Purchase {
  const item = clip(b.item, 160);
  if (!item) throw new MoneyHubError(400, en('Say what you bought.'));
  const storeName = clip(b.store, 80);
  const date = day(b.date, 'date') ?? todayOf(app);
  const cents = b.price === undefined || b.price === null || b.price === '' ? null : (toCents(b.price) ?? null);
  const terms = readReceiptTerms(String(b.text ?? ''), { date, store: storeName });
  const rb = day(b.returnBy ?? b.return_by, 'returnBy');
  if (rb) Object.assign(terms, { returnBy: rb, returnFrom: 'you' });
  const wu = day(b.warrantyUntil ?? b.warranty_until, 'warrantyUntil');
  if (wu) Object.assign(terms, { warrantyUntil: wu, warrantyFrom: 'you' });
  return insert(app, { item, store: storeName, priceCents: cents, date, source, terms, order: b.order ? String(b.order) : null });
}

/** Change what you know better: item, store, price, date, return-by, warranty-until. */
export function updatePurchase(app: AppContext, id: number, b: Record<string, unknown>): Purchase | undefined {
  const p = purchase(app, id);
  if (!p) return undefined;
  const set: Record<string, unknown> = {};
  if (b.item !== undefined) {
    const item = clip(b.item, 160);
    if (!item) throw new MoneyHubError(400, en('Say what you bought.'));
    set.item = item;
  }
  if (b.store !== undefined) set.store = clip(b.store, 80);
  if (b.price !== undefined) set.price_cents = b.price === null || b.price === '' ? null : (toCents(b.price) ?? null);
  if (b.date !== undefined) set.date = day(b.date, 'date') ?? p.date;
  if (b.returnBy !== undefined) {
    set.return_by = day(b.returnBy, 'returnBy');
    set.return_from = set.return_by ? 'you' : null;
  }
  if (b.warrantyUntil !== undefined) {
    set.warranty_until = day(b.warrantyUntil, 'warrantyUntil');
    set.warranty_from = set.warranty_until ? 'you' : null;
  }
  const keys = Object.keys(set);
  if (keys.length) store(app).db.prepare(`UPDATE money_purchases SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => set[k]) as (string | number | null)[]), id);
  return schedule(app, purchase(app, id)!);
}

/** Keep it (the reminder goes), returned, or open again. */
export function setPurchaseStatus(app: AppContext, id: number, status: string): Purchase | undefined {
  if (!['open', 'kept', 'returned'].includes(status)) throw new MoneyHubError(400, en('Pick one of the offered levels.'));
  const p = purchase(app, id);
  if (!p) return undefined;
  store(app).db.prepare('UPDATE money_purchases SET status = ? WHERE id = ?').run(status, id);
  return schedule(app, { ...p, status: status as PurchaseStatus });
}

export function removePurchase(app: AppContext, id: number): boolean {
  const p = purchase(app, id);
  if (!p) return false;
  if (p.reminderId) app.planner?.cancelReminder(p.reminderId);
  store(app).db.prepare('DELETE FROM money_purchases WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------- from mail and photos

function senderName(from: string): string {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (name) return clip(name, 60);
  const dom = /@([^>\s]+)/.exec(from)?.[1] ?? from;
  return clip(dom.split('.').slice(-2, -1)[0] ?? dom, 60);
}

/**
 * A new email the inbox helper read: a receipt finding becomes a purchase (once per mail, and once
 * per receipt when its photo is already on the list). Returns the new purchase, if any.
 */
export function observePurchaseMail(app: AppContext, m: InboxMail, findings: Finding[]): Purchase | undefined {
  const f = findings.find((x) => x.kind === 'receipt');
  if (!f) return undefined;
  // V2.8 (docs/TRIM.md): a subscription's receipt is a charge (Money → Maybe cancel), not something to return.
  if (subscriptionCharge(m)) return undefined;
  const ref = `mail:${m.account}|${m.id}`;
  if (seen(app, ref)) return undefined;
  markSeen(app, ref);
  const date = f.date && DAY.test(f.date) ? f.date : m.date.slice(0, 10);
  const storeName = clip(f.vendor || senderName(m.from), 80);
  const cents = f.amount ? (toCents(f.amount) ?? null) : null;
  if (duplicateOf(app, storeName, cents, date)) return undefined;
  const terms = readReceiptTerms(`${m.subject}\n${m.text}`, { date, store: storeName });
  return insert(app, { item: itemText(f.items, f.order ? `Order ${f.order}` : m.subject), store: storeName, priceCents: cents, date, source: 'mail', terms, order: f.order ?? null });
}

const RECEIPT_WORDS = /\b(receipt|subtotal|sub-total|order (?:#|no\.?|number)|thank you for (?:shopping|your (?:order|purchase))|total)\b/i;
const NOT_RECEIPT = /\b(statement|invoice|policy|lease|contract|payslip|pay stub|tax return)\b/i;

/**
 * Library documents (receipt photos read by the picture model, receipt PDFs) not looked at yet. A
 * document is a purchase when its text reads like a receipt with a total and a date. Warranty dates
 * that facts.ts finds in the document count too. Returns how many purchases were added.
 */
export function scanPurchaseDocs(app: AppContext): number {
  const lib = app.library;
  if (!lib) return 0;
  let added = 0;
  for (const d of lib.list()) {
    if (!d.keep || d.status !== 'ready' || d.readOnly) continue;
    const ref = `doc:${d.id}|${d.readAt ?? ''}`;
    if (seen(app, ref)) continue;
    markSeen(app, ref);
    if (NOT_RECEIPT.test(d.name)) continue;
    const passages = lib.passages(d.id, { limit: 60 });
    const text = passages.map((p) => p.text).join('\n').slice(0, 20_000);
    if (!RECEIPT_WORDS.test(text) || NOT_RECEIPT.test(text.slice(0, 400))) continue;
    const g = parseReceipt(text);
    const date = g.date ?? receiptDate(text);
    if (!g.totalCents || !date) continue;
    if (purchases(app).some((p) => p.docId === d.id)) continue;
    const storeName = clip(g.vendor ?? '', 80);
    if (duplicateOf(app, storeName, g.totalCents, date)) continue;
    const terms = readReceiptTerms(text, { date, store: storeName });
    if (!terms.warrantyUntil) {
      const w = extractFacts(d, passages.map((p) => ({ text: p.text, page: p.page, place: p.place }))).find((x) => x.dateKind === 'warranty_end' && x.date);
      if (w?.date) Object.assign(terms, { warrantyUntil: w.date, warrantyFrom: 'document' });
    }
    const photo = /\.(jpe?g|png|webp|heic)$/i.test(d.name) || d.kind === 'image';
    insert(app, { item: itemText(receiptItems(text), d.title || d.name), store: storeName, priceCents: g.totalCents, date, source: photo ? 'photo' : 'hand', terms, docId: d.id });
    added++;
  }
  return added;
}

// ---------------------------------------------------------------- start a return

/** "Start a return": one errand per purchase (planning: nothing is sent until you start it). */
export function startReturn(app: AppContext, id: number): Errand {
  const p = purchase(app, id);
  if (!p) throw new MoneyHubError(404, en('That purchase is not on your list.'));
  const errands = errandsFor(app);
  const old = p.errandId ? errands.get(p.errandId) : undefined;
  if (old && old.status !== 'stopped') return old;
  const e = errands.start(
    {
      goal: `Return ${p.item} to ${p.store || 'the store'}`,
      template: 'return',
      facts: { merchant: p.store, item: p.item, ...(p.order ? { order: p.order } : {}), ...(p.priceCents !== null ? { amount: fmtMoney(p.priceCents) } : {}), date: usDay(p.date), ...(p.returnBy ? { returnBy: usDay(p.returnBy) } : {}) },
      ...(p.returnBy ? { deadline: p.returnBy } : {}),
    },
    { by: 'page' },
  );
  store(app).db.prepare('UPDATE money_purchases SET errand_id = ? WHERE id = ?').run(e.id, id);
  return e;
}

// ---------------------------------------------------------------- the page

export type PurchaseState = 'open' | 'closing' | 'closed' | 'kept' | 'returned' | 'unknown';
export function purchasesOverview(app: AppContext) {
  scanPurchaseDocs(app);
  const today = todayOf(app);
  const prefs = purchasePrefs(app);
  const list = purchases(app).map((p) => {
    const daysLeft = p.returnBy ? Math.round((Date.parse(`${p.returnBy}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : null;
    const state: PurchaseState = p.status !== 'open' ? p.status : daysLeft === null ? 'unknown' : daysLeft < 0 ? 'closed' : daysLeft <= Math.max(prefs.days, 3) ? 'closing' : 'open';
    return { ...p, daysLeft, state, policy: policyFor(p.store)?.days ?? null, warrantyLeft: p.warrantyUntil && p.warrantyUntil >= today };
  });
  return { purchases: list, prefs, policies: STORE_POLICIES.map((x) => ({ store: x.store, days: x.days })), today, days: [...REMIND_DAYS] };
}

/** One line per purchase for the model (purchases_list). */
export function purchaseLine(p: Purchase, today: string): string {
  const parts = [`#${p.id} ${p.item}`, p.store || 'store unknown', p.priceCents !== null ? fmtMoney(p.priceCents) : 'price unknown', `bought ${usDay(p.date)}`];
  if (p.status !== 'open') parts.push(p.status === 'kept' ? 'kept' : 'returned');
  else if (p.returnBy) parts.push(p.returnBy < today ? `return window closed ${usDay(p.returnBy)}` : `return by ${usDay(p.returnBy)}${p.returnFrom === 'store' ? ` (${p.store}'s usual window)` : ''}`);
  else parts.push('return window unknown');
  if (p.warrantyUntil) parts.push(`warranty until ${usDay(p.warrantyUntil)}`);
  return parts.join(' · ');
}
export { usDay as purchaseDay };
