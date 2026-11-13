// E2 (docs/SHOPPING.md): product watches. "Tell me when it's back in stock / under $X / changes."
// Self-contained on purpose (its own table, its own small class) so it can fold into E1's watches
// later: a watch is a product page address plus a condition; on the reminder scheduler's existing
// tick (src/reminders.ts; no timer here) at most one due watch is checked per tick, each at most
// every 6 hours, with the same page reading as the product finder (src/shopping/extract.ts). A
// watch fires once per change (a back-in-stock fires again only after it went out of stock; a
// price-below fires again only after the price went back up), as a chat message and a phone or
// desktop notification. A page that blocks her four checks in a row pauses the watch, said once.
// Never buys, never signs in, never touches a cart.
//
// Table (additive, the companion's own store.db): product_watches.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { en, fill, trOwner } from '../i18n.ts';
import { matchScore, readProductPage, type Availability, type Offer } from './extract.ts';
import type { PageLoad } from './find.ts';
import { retailerForUrl } from './retailers.ts';

export const PRODUCT_WATCH = { everyMs: 6 * 3600_000, maxActive: 20, maxFails: 4, pageTimeoutMs: 30_000 };
export type WatchCondition = 'back_in_stock' | 'price_below' | 'any_change';
export const WATCH_CONDITIONS: readonly WatchCondition[] = ['back_in_stock', 'price_below', 'any_change'];

export interface ProductWatch {
  id: number;
  createdAt: string;
  conversationId: string | null;
  label: string;
  url: string;
  retailer: string;
  condition: WatchCondition;
  threshold: number | null;
  state: 'active' | 'paused';
  lastPrice: number | null;
  lastAvailability: Availability | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  fails: number;
  firedKey: string | null;
}

interface Row {
  id: number;
  created_at: string;
  conversation_id: string | null;
  label: string;
  url: string;
  retailer: string;
  condition: string;
  threshold: number | null;
  state: string;
  last_price: number | null;
  last_availability: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  fails: number;
  fired_key: string | null;
}

const toWatch = (r: Row): ProductWatch => ({
  id: r.id,
  createdAt: r.created_at,
  conversationId: r.conversation_id,
  label: r.label,
  url: r.url,
  retailer: r.retailer,
  condition: r.condition as WatchCondition,
  threshold: r.threshold,
  state: r.state === 'paused' ? 'paused' : 'active',
  lastPrice: r.last_price,
  lastAvailability: (r.last_availability as Availability | null) ?? null,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  fails: r.fails,
  firedKey: r.fired_key,
});

export class ProductWatchError extends Error {}

/**
 * What one check means for a watch: the alert text (undefined = nothing to say) and the new
 * "fired" key (fires once per change). Pure, for tests.
 */
export type Say = (text: string, params?: Record<string, unknown>) => string;
const english: Say = (text, params) => fill(text, params);

export function decide(w: Pick<ProductWatch, 'condition' | 'threshold' | 'lastPrice' | 'lastAvailability' | 'lastCheckedAt' | 'firedKey' | 'label' | 'retailer'>, now: { price?: number; availability: Availability }, say: Say = english): { alert?: string; firedKey: string | null } {
  const price = now.price;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const stock = (a: Availability | null) => say(a === 'in_stock' ? en('in stock') : a === 'out_of_stock' ? en('out of stock') : a === 'limited' ? en('limited stock') : a === 'preorder' ? en('pre-order') : en('stock not shown'));
  const p = { label: w.label, store: w.retailer };
  if (w.condition === 'back_in_stock') {
    const inNow = now.availability === 'in_stock' || now.availability === 'limited';
    if (!inNow) return { firedKey: now.availability === 'out_of_stock' ? null : w.firedKey };
    if (w.firedKey === 'in') return { firedKey: 'in' };
    // The first look finds it in stock already: that is news too (he asked to know).
    return { alert: price !== undefined ? say(en('{label} is in stock at {store} ({price}).'), { ...p, price: money(price) }) : say(en('{label} is in stock at {store}.'), p), firedKey: 'in' };
  }
  if (w.condition === 'price_below') {
    if (price === undefined || w.threshold === null) return { firedKey: w.firedKey };
    if (price >= w.threshold) return { firedKey: null };
    if (w.firedKey === `below:${price}`) return { firedKey: w.firedKey };
    if (w.firedKey?.startsWith('below:')) return { firedKey: `below:${price}` };
    return { alert: say(en('{label} is {price} at {store}, under your {limit}.'), { ...p, price: money(price), limit: money(w.threshold) }), firedKey: `below:${price}` };
  }
  // any_change: the first check is the baseline.
  if (!w.lastCheckedAt) return { firedKey: `${price ?? '-'}|${now.availability}` };
  const key = `${price ?? '-'}|${now.availability}`;
  if (key === w.firedKey) return { firedKey: key };
  const parts: string[] = [];
  const shown = (n: number | null | undefined) => (n === null || n === undefined ? say(en('not shown')) : money(n));
  if (price !== (w.lastPrice ?? undefined)) parts.push(say(en('price {from} → {to}'), { from: shown(w.lastPrice), to: shown(price) }));
  if (now.availability !== w.lastAvailability) parts.push(`${stock(w.lastAvailability)} → ${stock(now.availability)}`);
  return parts.length ? { alert: say(en('{label} at {store} changed: {what}.'), { ...p, what: parts.join(', ') }), firedKey: key } : { firedKey: key };
}

/** The offer on a product page that is this watch's product (the closest match to its label). */
export function watchedOffer(label: string, offers: Offer[]): Offer | undefined {
  if (offers.length === 1) return offers[0];
  return [...offers].map((o) => ({ o, s: matchScore(label, o.title) })).sort((a, b) => b.s - a.s || Number(a.o.price === undefined) - Number(b.o.price === undefined))[0]?.o;
}

export class ProductWatches {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #load: (url: string, signal: AbortSignal) => Promise<PageLoad>;
  #running = false;

  constructor(app: AppContext, db: DatabaseSync, load: (url: string, signal: AbortSignal) => Promise<PageLoad>) {
    this.#app = app;
    this.#db = db;
    this.#load = load;
    db.exec(`CREATE TABLE IF NOT EXISTS product_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, conversation_id TEXT, label TEXT NOT NULL, url TEXT NOT NULL,
      retailer TEXT NOT NULL, condition TEXT NOT NULL, threshold REAL, state TEXT NOT NULL DEFAULT 'active',
      last_price REAL, last_availability TEXT, last_checked_at TEXT, last_error TEXT, fails INTEGER NOT NULL DEFAULT 0, fired_key TEXT)`);
  }

  list(): ProductWatch[] {
    return (this.#db.prepare('SELECT * FROM product_watches ORDER BY id').all() as unknown as Row[]).map(toWatch);
  }

  get(id: number): ProductWatch | undefined {
    const r = this.#db.prepare('SELECT * FROM product_watches WHERE id = ?').get(id) as Row | undefined;
    return r ? toWatch(r) : undefined;
  }

  add(w: { url: string; label: string; condition: WatchCondition; threshold?: number; conversationId?: string; price?: number; availability?: Availability }): ProductWatch {
    let u: URL;
    try {
      u = new URL(w.url);
    } catch {
      throw new ProductWatchError('That is not a web address.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ProductWatchError('Only web pages (http or https) can be watched.');
    if (!WATCH_CONDITIONS.includes(w.condition)) throw new ProductWatchError('condition: back_in_stock, price_below or any_change.');
    if (w.condition === 'price_below' && !(typeof w.threshold === 'number' && w.threshold > 0)) throw new ProductWatchError('price_below needs a price (below), like 9.99.');
    const active = (this.#db.prepare("SELECT COUNT(*) AS n FROM product_watches WHERE state = 'active'").get() as { n: number }).n;
    if (active >= PRODUCT_WATCH.maxActive) throw new ProductWatchError(`Already ${PRODUCT_WATCH.maxActive} product watches; remove one first.`);
    const retailer = retailerForUrl(u.href)?.name ?? u.hostname.replace(/^www\./, '');
    const now = this.#app.now().toISOString();
    // What the finder just saw is the starting point (a back-in-stock watch on an item in stock now waits for the next restock).
    const known = w.price !== undefined || w.availability !== undefined;
    const inNow = w.availability === 'in_stock' || w.availability === 'limited';
    const fired = !known ? null : w.condition === 'back_in_stock' && inNow ? 'in' : w.condition === 'any_change' ? `${w.price ?? '-'}|${w.availability ?? 'unknown'}` : null;
    const r = this.#db
      .prepare('INSERT INTO product_watches (created_at, conversation_id, label, url, retailer, condition, threshold, last_price, last_availability, last_checked_at, fired_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .get(now, w.conversationId ?? null, w.label.replace(/\s+/g, ' ').trim().slice(0, 160) || retailer, u.href, retailer, w.condition, w.threshold ?? null, w.price ?? null, w.availability ?? null, known && w.condition === 'any_change' ? now : null, fired) as { id: number };
    return this.get(r.id)!;
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM product_watches WHERE id = ?').run(id).changes) > 0;
  }

  /** The reminder tick: at most one due watch per tick, checked in the background (never blocks the tick). */
  due(now: Date): void {
    if (this.#running) return;
    const before = new Date(now.getTime() - PRODUCT_WATCH.everyMs).toISOString();
    const r = this.#db.prepare("SELECT * FROM product_watches WHERE state = 'active' AND (last_checked_at IS NULL OR last_checked_at <= ?) ORDER BY COALESCE(last_checked_at, '') LIMIT 1").get(before) as Row | undefined;
    if (!r) return;
    this.#running = true;
    void this.check(r.id)
      .catch((err: Error) => console.warn(`product watch #${r.id}: ${err.message}`))
      .finally(() => (this.#running = false));
  }

  /** Checks one watch now; returns the alert text when it fired. */
  async check(id: number): Promise<string | undefined> {
    const w = this.get(id);
    if (!w) return undefined;
    const at = this.#app.now().toISOString();
    let page: PageLoad;
    try {
      page = await this.#load(w.url, AbortSignal.timeout(PRODUCT_WATCH.pageTimeoutMs));
    } catch (err) {
      page = { ok: false, reason: (err as Error).message.slice(0, 160), via: 'reader' };
    }
    const read = page.ok ? readProductPage({ url: page.url, status: page.status, title: page.title, html: page.html }) : undefined;
    const offer = read && !read.blocked ? watchedOffer(w.label, read.offers) : undefined;
    if (!offer) {
      const why = !page.ok ? page.reason : read?.blocked ?? 'the page didn’t show the product’s price or stock';
      const fails = w.fails + 1;
      const pause = fails >= PRODUCT_WATCH.maxFails;
      this.#db.prepare('UPDATE product_watches SET last_checked_at = ?, last_error = ?, fails = ?, state = ? WHERE id = ?').run(at, why, fails, pause ? 'paused' : 'active', id);
      if (pause) this.#post(w, trOwner('Product watch #{id} ({label}, {store}) is paused: {n} checks in a row couldn’t read the page ({why}). I can check it in your own browser, or you can check {url}.', this.#app.settings.get(), { id: w.id, label: w.label, store: w.retailer, n: fails, why, url: w.url }), 'paused');
      return undefined;
    }
    const say: Say = (text, params) => trOwner(text, this.#app.settings.get(), params);
    const d = decide(w, { ...(offer.price !== undefined ? { price: offer.price } : {}), availability: offer.availability }, say);
    this.#db.prepare('UPDATE product_watches SET last_checked_at = ?, last_error = NULL, fails = 0, last_price = ?, last_availability = ?, fired_key = ? WHERE id = ?').run(at, offer.price ?? null, offer.availability, d.firedKey, id);
    if (!d.alert) return undefined;
    const time = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(this.#app.settings.get().timeZone ? { timeZone: this.#app.settings.get().timeZone } : {}) });
    const text = `${d.alert} ${say(en('Checked {time} on {store}’s page: {url} (product watch #{id}). I won’t buy anything; say the word and I’ll open the page for you.'), { time, store: w.retailer, url: offer.url ?? w.url, id: w.id })}`;
    this.#post(w, text, 'fired');
    return text;
  }

  #post(w: ProductWatch, text: string, kind: 'fired' | 'paused'): void {
    const store = this.#app.store;
    let conv = w.conversationId ? store.getConversation(w.conversationId) : undefined;
    conv ??= store.listConversations()[0] ?? store.createConversation({ title: 'Product watches' });
    const msg = store.addMessage(conv.id, 'assistant', text, { productWatch: { id: w.id, kind, url: w.url } });
    this.#app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'reply' });
    const s = this.#app.settings.get();
    void this.#app.push?.notifyOwner(kind === 'fired' ? trOwner('Product watch: {label}', s, { label: w.label.slice(0, 60) }) : trOwner('Product watch paused', s), text, conv.id, `product-watch-${w.id}`).catch(() => {});
  }
}
