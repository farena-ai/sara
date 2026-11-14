// N4 (docs/SHOPPING.md "Check in my browser"): a retailer that blocks Sara's own browser can be checked in
// the person's OWN browser on their computer, where they are already the store's customer (their session,
// their chosen store). Through the existing desktop actions only, each approved on that computer the usual
// way: a click on the browser's own New Tab button, the address typed into its address bar, Enter, then a
// read-only look at the page's text (price, stock, pickup), and the tab closed again (or left open, as the
// person chose). Nothing is ever bought, no cart, no sign-in. The page's text is data, never instructions.
// Never while the person is using the computer: a takeover pause, another task on it or a missing
// approval surface means "not now" (the caller says so), never a way around it.
import type { DesktopItem } from '../hands-desktop.ts';
import { blockedReason, availabilityOf, matchScore, parsePrice, type Availability, type Offer } from './extract.ts';

export interface TabWindow {
  id?: string;
  browser?: string;
  hidden?: string;
  tabs: { title?: string; url?: string; active?: boolean; hidden?: string }[];
}
export interface BrowserView {
  viewId: string;
  window: string;
  title?: string;
  items: DesktopItem[];
}
/** The desktop actions this needs (src/shopping/my-browser-port.ts gives the real one; tests a fake). */
export interface BrowserPort {
  tabs(): Promise<TabWindow[]>;
  look(window: string): Promise<BrowserView>;
  click(view: BrowserView, ref: string): Promise<void>;
  type(view: BrowserView, ref: string, text: string): Promise<void>;
  keys(view: BrowserView, ref: string, combo: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type BrowserCheck =
  | { ok: true; offer: Offer; title: string; url: string; pickup?: string; closed: boolean; closeWhy?: string }
  | { ok: false; reason: string; title?: string; url?: string; closed?: boolean };

export const MY_BROWSER = { loadWaitMs: 15_000, pollMs: 1_000 } as const;

const ADDRESS_BAR = /address and search bar|address bar|search or enter|search or type|location bar|barra de direcciones|barre d.adresse|adressleiste|barra de endere|barra degli indirizzi/i;
const NEW_TAB = /^(new tab|nueva pesta|nouvel onglet|neuer tab|nova guia|nuova scheda)/i;
const CLOSE_TAB = /^(close tab|close|cerrar pesta|fermer l.onglet|tab schlie|fechar guia|chiudi scheda)/i;

/** The browser chrome ends where the page's document starts; only the page's own text counts. */
function pageItems(items: DesktopItem[]): DesktopItem[] {
  const i = items.findIndex((x) => x.role === 'document');
  if (i < 0) return items.filter((x) => !['button', 'tab', 'tablist', 'toolbar', 'pane', 'titlebar', 'menubar'].includes(x.role));
  const doc = items[i];
  const inside = (x: DesktopItem) => !doc.box || !x.box || (x.box[1] >= doc.box[1] && x.box[1] <= doc.box[1] + doc.box[3] && x.box[0] >= doc.box[0] - 2 && x.box[0] <= doc.box[0] + doc.box[2]);
  return items.slice(i).filter(inside);
}

/**
 * Price, stock and pickup from what the page shows (its accessible text, as the computer reads it): the
 * first price after the product's name, stock words ("In stock", "Out of stock", "Only 3 left") and a
 * pickup line ("Pickup today at Round Rock"). Nothing is guessed: a missing price stays missing.
 */
export function offerFromScreen(items: DesktopItem[], o: { title?: string; what?: string; url?: string } = {}): { offer?: Offer; pickup?: string; blocked?: string } {
  const page = pageItems(items);
  const texts = page.map((x) => [x.name, x.value].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = texts.join('\n');
  const wall = blockedReason({ status: 200, ...(o.title ? { title: o.title } : {}), html: `<title>${o.title ?? ''}</title><body>${all.slice(0, 4000)}</body>` });
  if (wall) return { blocked: wall };
  // The product's name: a heading-like line that matches what was asked, else the page title.
  const what = o.what ?? '';
  const named = what ? texts.filter((t) => t.length >= 6 && t.length <= 200 && !/\$\s?\d/.test(t)).map((t) => ({ t, s: matchScore(what, t) })).sort((a, b) => b.s - a.s)[0] : undefined;
  const title = named && named.s >= 0.5 ? named.t : (o.title ?? '').replace(/\s[-|–]\s.*$/, '').trim();
  const start = named && named.s >= 0.5 ? texts.indexOf(named.t) : 0;
  const ordered = [...texts.slice(start), ...texts.slice(0, start)];
  let price: number | undefined;
  for (const t of ordered) {
    if (/was\s*\$|list price|reg\.?\s*\$|save\s*\$|\/\s?(oz|ct|count|each|lb)\b|per (oz|ounce|count)/i.test(t) && !/now\s*\$/i.test(t)) continue;
    const m = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/.exec(t);
    if (m) {
      price = parsePrice(m[1]);
      if (price !== undefined) break;
    }
  }
  const stockLine = ordered.find((t) => /\b(out of stock|sold out|unavailable|not available|in stock|only \d+ left|limited stock|low stock|back ?order|pre-?order|available (?:for|to) (?:pickup|ship|delivery)|ready (?:for pickup|today))\b/i.test(t));
  let availability: Availability = 'unknown';
  let said: string | undefined;
  if (stockLine) {
    said = /(out of stock|sold out|unavailable|not available|in stock|only \d+ left|limited stock|low stock|back ?order|pre-?order|available (?:for|to) (?:pickup|ship|delivery)|ready (?:for pickup|today))/i.exec(stockLine)![1];
    availability = /only \d+ left|limited|low stock/i.test(said) ? 'limited' : /available|ready/i.test(said) ? 'in_stock' : availabilityOf(said);
  }
  const pickupLine = ordered.find((t) => /\bpick ?up\b/i.test(t) && t.length <= 200);
  const fulfillment = [...new Set([pickupLine && !/not available|unavailable/i.test(pickupLine) ? 'pickup' : '', ordered.some((t) => /\b(delivery|ship(s|ping)? to)\b/i.test(t) && !/not available|unavailable/i.test(t)) ? 'delivery' : ''].filter(Boolean))];
  if (price === undefined && availability === 'unknown') return {};
  const offer: Offer = { title: title || what || 'the product', ...(price !== undefined ? { price, currency: 'USD' } : {}), availability, ...(said ? { availabilityText: said } : {}), ...(o.url ? { url: o.url } : {}), ...(fulfillment.length ? { fulfillment } : {}), how: 'page' };
  return { offer, ...(pickupLine ? { pickup: pickupLine.slice(0, 160) } : {}) };
}

/** A browser window's title without the browser's own suffix (“… - Profile 1 - Microsoft Edge”). */
export const pageTitle = (t: string): string =>
  t.replace(/\s[-|–]\s(Profile \d+|Personal|Work)\s[-|–].*$/i, '').replace(/\s[-|–]\s(Microsoft.? Edge|Google Chrome|Brave|Mozilla Firefox)$/i, '').replace(/\s+and \d+ more pages?$/i, '').trim();

/** The person's browser window to use: a shown window of Edge, Chrome or Brave (Firefox's tab strip is read-only here). */
export function pickWindow(wins: TabWindow[]): TabWindow | undefined {
  const shown = wins.filter((w) => !w.hidden && w.id);
  return shown.find((w) => /edge|chrome|brave/i.test(w.browser ?? '')) ?? shown[0];
}

/**
 * Opens `url` in a new tab of the person's own browser, waits for it, reads it, and closes the tab again
 * unless `leaveOpen`. Each action is approved on the computer as usual (the caller's port carries the task).
 */
export async function checkInMyBrowser(port: BrowserPort, url: string, o: { what?: string; leaveOpen?: boolean; loadWaitMs?: number } = {}): Promise<BrowserCheck> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'not a web address' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'only web pages can be checked' };
  const win = pickWindow(await port.tabs());
  if (!win?.id) return { ok: false, reason: 'none of your own browser windows (Edge, Chrome, Brave) is open on the computer' };
  let view = await port.look(win.id);
  const newTab = view.items.find((i) => i.role === 'button' && NEW_TAB.test(i.name ?? ''));
  if (!newTab) return { ok: false, reason: 'I couldn\u2019t find the browser\u2019s New Tab button' };
  await port.click(view, newTab.ref);
  view = await port.look(win.id);
  const bar = view.items.find((i) => (i.role === 'edit' || i.role === 'combobox') && ADDRESS_BAR.test(i.name ?? ''));
  if (!bar) return { ok: false, reason: 'I couldn\u2019t find the address bar of the new tab' };
  await port.type(view, bar.ref, u.href);
  view = await port.look(win.id);
  const bar2 = view.items.find((i) => (i.role === 'edit' || i.role === 'combobox') && ADDRESS_BAR.test(i.name ?? '')) ?? bar;
  await port.keys(view, bar2.ref, 'enter');
  // Wait for the page: its title is no longer the new tab's and it shows a price or stock words.
  const until = Date.now() + (o.loadWaitMs ?? MY_BROWSER.loadWaitMs);
  let read: ReturnType<typeof offerFromScreen> = {};
  do {
    await port.sleep(MY_BROWSER.pollMs);
    view = await port.look(win.id);
    const t = pageTitle(view.title ?? '');
    if (/^(new tab|nueva pesta|nouvel onglet|neuer tab|nova guia|nuova scheda)/i.test(t)) continue;
    read = offerFromScreen(view.items, { title: t, ...(o.what ? { what: o.what } : {}), url: u.href });
    if (read.offer || read.blocked) break;
  } while (Date.now() < until);
  const title = pageTitle(view.title ?? '');
  let closed = false;
  let closeWhy = '';
  if (!o.leaveOpen) {
    // The new tab's own Close button: right after its tab in the strip (a fresh look: the page changed while loading).
    const fresh = await port.look(win.id).catch(() => view);
    const at = fresh.items.findIndex((i) => i.role === 'tab' && title && (i.name ?? '').startsWith(title.slice(0, 30)));
    const close = at >= 0 ? fresh.items.slice(at + 1).find((i) => i.role === 'button' && CLOSE_TAB.test(i.name ?? '')) : undefined;
    if (close) await port.click(fresh, close.ref).then(() => (closed = true)).catch((err: Error) => (closeWhy = err.message.slice(0, 160)));
    else closeWhy = 'its Close button wasn\u2019t found';
  }
  if (read.blocked) return { ok: false, reason: `even in your browser the store showed: ${read.blocked}`, title, url: u.href, closed };
  if (!read.offer) return { ok: false, reason: 'the page didn\u2019t show a price or stock I could read', title, url: u.href, closed };
  return { ok: true, offer: read.offer, title, url: u.href, ...(read.pickup ? { pickup: read.pickup } : {}), closed, ...(closeWhy ? { closeWhy } : {}) };
}
