// E2 (docs/SHOPPING.md): "find X near me". One run: (a) a web search to pin the product down (model
// numbers, the retailers' own product pages, prices in snippets); (b) the stores near the person
// from OpenStreetMap, matched to the retailers she knows; (c) each retailer's product or search page
// opened one at a time (her browser, else the guarded reader), at most MAX_LOADS pages a search,
// read for structured data; (d) a ranked short list (in stock first, then price, then distance)
// with where each fact came from and when, plus the ones she couldn't check and why. A site that
// shows a bot check or refuses is recorded as blocked and left alone (never retried another way).
// A price seen only in a search snippet is labelled so. Nothing is invented: a missing price or
// stock state is said as missing.
import type { SearchResult } from '../tools/search.ts';
import { matchScore, parsePrice, readProductPage, type Availability, type Offer } from './extract.ts';
import type { GeoPlace, NearbyStore, OsmPlaces } from './places.ts';
import { GENERAL, isProductUrl, ONLINE_DEFAULT, RETAILERS, retailerByName, retailerForStore, retailerForUrl, type Retailer } from './retailers.ts';

export const FIND = { maxLoads: 8, maxRetailers: 6, nearbyChains: 4, minScore: 0.6, defaultRadius: 10, maxRadius: 25, pageTimeoutMs: 25_000, maxRows: 8 };

export type PageLoad = { ok: true; url: string; status: number; title: string; html: string; via: 'browser' | 'reader' } | { ok: false; reason: string; via: 'browser' | 'reader' };

export interface FinderDeps {
  loadPage(url: string, signal: AbortSignal): Promise<PageLoad>;
  /** Undefined: no web search available here. */
  search?: (q: string, signal: AbortSignal) => Promise<SearchResult[]>;
  places: Pick<OsmPlaces, 'stores'>;
  now: () => Date;
}

export interface FindInput {
  what: string;
  place?: GeoPlace;
  near: boolean;
  radiusMiles: number;
  maxPrice?: number;
  online: boolean;
  stores?: string[];
}

export interface StoreRef {
  name: string;
  miles: number;
  address?: string;
  phone?: string;
  hours?: string;
}

export interface FindRow {
  retailer: string;
  title: string;
  price?: number;
  currency?: string;
  shipping?: number;
  availability: Availability;
  availabilityText?: string;
  fulfillment?: string[];
  delivery?: string;
  url: string;
  checkedAt: string;
  /** Where the facts came from, in words ("walmart.com page data", "search result snippet"). */
  source: string;
  fromSearch?: boolean;
  store?: StoreRef;
  sponsored?: boolean;
}

export interface CouldNot {
  retailer: string;
  reason: string;
  url?: string;
  store?: StoreRef;
}

export interface FindResult {
  what: string;
  place?: GeoPlace;
  radiusMiles: number;
  checkedAt: string;
  rows: FindRow[];
  couldNot: CouldNot[];
  overMax: number;
  stores: NearbyStore[];
  storesNote?: string;
  searchNote?: string;
  models: string[];
  loads: number;
}

const AVAIL_ORDER: Record<Availability, number> = { in_stock: 0, limited: 1, preorder: 2, unknown: 3, out_of_stock: 4 };

/** In stock first, then the lower total (price + shipping when shown), then the nearer store; snippets after page facts. */
export function rankRows(rows: FindRow[]): FindRow[] {
  const total = (r: FindRow) => (r.price === undefined ? Infinity : r.price + (r.shipping ?? 0));
  return [...rows].sort((a, b) => AVAIL_ORDER[a.availability] - AVAIL_ORDER[b.availability] || Number(Boolean(a.fromSearch)) - Number(Boolean(b.fromSearch)) || total(a) - total(b) || (a.store?.miles ?? Infinity) - (b.store?.miles ?? Infinity));
}

const storeRef = (s: NearbyStore): StoreRef => ({ name: s.name, miles: s.miles, ...(s.address ? { address: s.address } : {}), ...(s.phone ? { phone: s.phone } : {}), ...(s.hours ? { hours: s.hours } : {}) });
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Model or part numbers in product titles ("49005", "MN1500B4"): what pins the product down. */
export function modelNumbers(titles: string[]): string[] {
  const out = new Map<string, number>();
  for (const t of titles) for (const m of t.matchAll(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])?[A-Z0-9][A-Z0-9-]{3,15}\b/g)) {
    const v = m[0].replace(/-+$/, '');
    if (/^\d{1,3}$/.test(v) || /^(19|20)\d\d$/.test(v) || /^\d+(OZ|PK|CT|LB|IN|MM)$/i.test(v) || /^WD-?40$/.test(v)) continue;
    out.set(v, (out.get(v) ?? 0) + 1);
  }
  return [...out.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 4);
}

function bestOffer(what: string, offers: Offer[]): Offer | undefined {
  const scored = offers.map((o) => ({ o, s: matchScore(what, o.title) })).filter((x) => x.s >= FIND.minScore);
  scored.sort((a, b) => Number(Boolean(a.o.sponsored)) - Number(Boolean(b.o.sponsored)) || Number(a.o.price === undefined) - Number(b.o.price === undefined) || b.s - a.s || (a.o.price ?? Infinity) - (b.o.price ?? Infinity));
  return scored[0]?.o;
}

const sourceWords = (o: Offer, url: string, via: 'browser' | 'reader') => `${hostOf(url)} ${o.how === 'json-ld' ? 'product data (schema.org)' : o.how === 'page-data' ? 'page data' : o.how === 'meta' ? 'page price tags' : 'page'}${via === 'browser' ? ', her browser' : ''}`;

/** Runs one product search (see the top of the file). */
export async function findProduct(deps: FinderDeps, input: FindInput, signal: AbortSignal): Promise<FindResult> {
  const what = input.what.replace(/\s+/g, ' ').trim().slice(0, 200);
  const radius = Math.min(FIND.maxRadius, Math.max(1, input.radiusMiles || FIND.defaultRadius));
  const stamp = () => deps.now().toISOString();
  const res: FindResult = { what, ...(input.place ? { place: input.place } : {}), radiusMiles: radius, checkedAt: stamp(), rows: [], couldNot: [], overMax: 0, stores: [], models: [], loads: 0 };

  // (b) stores near the person.
  const nearestOf = new Map<string, NearbyStore>();
  if (input.near && input.place) {
    try {
      const got = await deps.places.stores(input.place, radius, signal);
      res.stores = got.stores;
      for (const s of got.stores) {
        const r = retailerForStore(s);
        if (r && !nearestOf.has(r.id)) nearestOf.set(r.id, s);
      }
      if (got.cached) res.storesNote = `store list from OpenStreetMap, cached ${got.checkedAt}`;
    } catch (err) {
      if (signal.aborted) throw err;
      res.storesNote = `couldn't get the store list from OpenStreetMap: ${(err as Error).message}`;
    }
  }

  // (a) a web search to pin the product down and find the retailers' own product pages.
  const productUrl = new Map<string, string>();
  const snippets: SearchResult[] = [];
  if (deps.search) {
    try {
      const results = await deps.search(`${what} price`, signal);
      snippets.push(...results);
      res.models = modelNumbers(results.map((r) => r.title));
      for (const r of results) {
        const ret = retailerForUrl(r.url);
        if (ret && !productUrl.has(ret.id) && isProductUrl(ret, r.url) && matchScore(what, r.title) >= FIND.minScore) productUrl.set(ret.id, r.url);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      res.searchNote = `web search failed: ${(err as Error).message.slice(0, 160)}`;
    }
  } else res.searchNote = 'web search is not set up here, so the product was looked up on the retailers\u2019 own pages only';

  // Which retailers: the ones he named; else the nearest chains, then the big online ones.
  const picked: Retailer[] = [];
  const add = (r: Retailer | undefined) => {
    if (r && !picked.includes(r) && picked.length < FIND.maxRetailers) picked.push(r);
  };
  if (input.stores?.length) {
    for (const name of input.stores) {
      const r = retailerByName(name);
      if (r) add(r);
      else res.couldNot.push({ retailer: name.slice(0, 60), reason: 'not a store I know how to check online yet' });
    }
  } else {
    const near = [...nearestOf.entries()].sort((a, b) => GENERAL.indexOf(a[0]) - GENERAL.indexOf(b[0]) || a[1].miles - b[1].miles).slice(0, FIND.nearbyChains);
    for (const [id] of near) add(RETAILERS.find((r) => r.id === id));
    for (const id of productUrl.keys()) if (picked.length < FIND.maxRetailers - 1) add(RETAILERS.find((r) => r.id === id));
    if (input.online) for (const id of ONLINE_DEFAULT) add(RETAILERS.find((r) => r.id === id));
  }

  // (c) one page at a time, at most FIND.maxLoads.
  const load = async (url: string) => {
    res.loads++;
    const t = AbortSignal.any([signal, AbortSignal.timeout(FIND.pageTimeoutMs)]);
    try {
      return await deps.loadPage(url, t);
    } catch (err) {
      if (signal.aborted) throw err;
      return { ok: false as const, reason: /timed? ?out|abort/i.test((err as Error).message) ? 'the page took too long' : (err as Error).message.slice(0, 160), via: 'reader' as const };
    }
  };
  for (const r of picked) {
    const store = nearestOf.get(r.id);
    const sref = store ? storeRef(store) : undefined;
    if (res.loads >= FIND.maxLoads) {
      res.couldNot.push({ retailer: r.name, reason: 'not checked: this search already opened its limit of pages', url: r.search(what), ...(sref ? { store: sref } : {}) });
      continue;
    }
    let url = productUrl.get(r.id) ?? r.search(what);
    let page = await load(url);
    let offer: Offer | undefined;
    let reason: string | undefined;
    for (let step = 0; step < 2; step++) {
      if (!page.ok) {
        reason = page.reason;
        break;
      }
      const read = readProductPage({ url: page.url, status: page.status, title: page.title, html: page.html });
      if (read.blocked) {
        reason = read.blocked;
        break;
      }
      offer = bestOffer(what, read.offers);
      if (offer) {
        url = page.url;
        break;
      }
      const next = read.productLinks.find((l) => isProductUrl(r, l)) ?? read.productLinks[0];
      if (step === 0 && next && res.loads < FIND.maxLoads) {
        url = next;
        page = await load(next);
        continue;
      }
      reason = read.offers.length ? 'the page had products, but none matched closely enough' : 'the page didn\u2019t show a price I could read';
      break;
    }
    if (offer) {
      const row: FindRow = {
        retailer: r.name,
        title: offer.title,
        ...(offer.price !== undefined ? { price: offer.price } : {}),
        ...(offer.currency ? { currency: offer.currency } : {}),
        ...(offer.shipping !== undefined ? { shipping: offer.shipping } : {}),
        availability: offer.availability,
        ...(offer.availabilityText ? { availabilityText: offer.availabilityText } : {}),
        ...(offer.fulfillment ? { fulfillment: offer.fulfillment } : {}),
        ...(offer.delivery ? { delivery: offer.delivery } : {}),
        url: offer.url ?? url,
        checkedAt: stamp(),
        source: sourceWords(offer, url, page.ok ? page.via : 'reader'),
        ...(offer.sponsored ? { sponsored: true } : {}),
        ...(sref ? { store: sref } : {}),
      };
      if (input.maxPrice !== undefined && row.price !== undefined && row.price > input.maxPrice) res.overMax++;
      else res.rows.push(row);
      continue;
    }
    res.couldNot.push({ retailer: r.name, reason: reason ?? 'no answer', url, ...(sref ? { store: sref } : {}) });
    // A price a search result showed for this retailer, labelled as such.
    const snip = snippets.find((s) => retailerForUrl(s.url)?.id === r.id && matchScore(what, s.title) >= FIND.minScore && parsePrice(/\$\s?\d[\d,]*(?:\.\d{2})?/.exec(`${s.title} ${s.snippet}`)?.[0]) !== undefined);
    if (snip) {
      const price = parsePrice(/\$\s?\d[\d,]*(?:\.\d{2})?/.exec(`${snip.title} ${snip.snippet}`)?.[0]);
      if (price !== undefined && (input.maxPrice === undefined || price <= input.maxPrice)) res.rows.push({ retailer: r.name, title: snip.title.slice(0, 200), price, currency: 'USD', availability: 'unknown', url: snip.url, checkedAt: stamp(), source: 'search result snippet (may be out of date)', fromSearch: true, ...(sref ? { store: sref } : {}) });
    }
  }
  res.rows = rankRows(res.rows).slice(0, FIND.maxRows);
  res.checkedAt = stamp();
  return res;
}

// ---------- the answer as text (what the model reads; the chat card parses the numbered lines) ----------

const money = (n: number, cur = 'USD') => (cur === 'USD' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${cur}`);
const AVAIL_WORDS: Record<Availability, string> = { in_stock: 'in stock', limited: 'limited stock', preorder: 'pre-order / back-order', out_of_stock: 'out of stock', unknown: 'stock not shown' };

export function formatFind(r: FindResult, o: { id?: number; time: (iso: string) => string; canUsePc: boolean }): string {
  const lines: string[] = [];
  const where = r.place ? ` near ${r.place.name.split(',').slice(0, 2).join(',')} (within ${r.radiusMiles} mi)` : '';
  lines.push(`Product search: \u201c${r.what}\u201d${where}. Checked ${o.time(r.checkedAt)}.${o.id ? ` Result #${o.id} (product_watch_add can watch any line).` : ''}`);
  if (r.models.length) lines.push(`Model/part numbers seen for it: ${r.models.join(', ')}.`);
  if (!r.rows.length) lines.push('No price or stock I could confirm on the pages I could read.');
  r.rows.forEach((row, i) => {
    const said = row.availabilityText && row.availabilityText.replace(/[\s_]/g, '').toLowerCase() !== AVAIL_WORDS[row.availability].replace(/\s/g, '') ? ` (\u201c${row.availabilityText}\u201d)` : '';
    const bits = [row.retailer, row.price !== undefined ? money(row.price, row.currency) : 'price not shown', `${AVAIL_WORDS[row.availability]}${said}`];
    if (row.shipping !== undefined) bits.push(row.shipping === 0 ? 'free shipping' : `shipping ${money(row.shipping, row.currency)} (total ${money((row.price ?? 0) + row.shipping, row.currency)})`);
    if (row.fulfillment?.length && !(row.delivery && row.fulfillment.join() === 'delivery')) bits.push(row.fulfillment.join(' / '));
    if (row.delivery) bits.push(row.delivery);
    if (row.store) bits.push(`nearest store ${row.store.miles} mi${row.store.address ? ` (${row.store.address})` : ''}`);
    if (row.sponsored) bits.push('sponsored listing');
    lines.push(`${i + 1}. ${bits.join(' \u2014 ')}`);
    lines.push(`   ${row.url}`);
    lines.push(`   \u201c${row.title.slice(0, 140)}\u201d \u00b7 source: ${row.source} at ${o.time(row.checkedAt)}${row.store ? ' \u00b7 store stock for that store isn\u2019t confirmed unless the page said so' : ''}`);
  });
  if (r.overMax) lines.push(`${r.overMax} more found above the max price.`);
  if (r.couldNot.length) {
    lines.push('', 'Couldn\u2019t check:');
    for (const c of r.couldNot) lines.push(`- ${c.retailer}: ${c.reason}${c.store?.phone ? `. Call the store (${c.store.name}, ${c.store.miles} mi): ${c.store.phone}` : c.store ? `. Nearest store: ${c.store.name}, ${c.store.miles} mi${c.store.address ? `, ${c.store.address}` : ''}` : ''}${c.url ? ` \u00b7 ${c.url}` : ''}`);
    lines.push(o.canUsePc ? 'Offer: I can check these in your own browser on your computer (pc_browser_open; you approve it there).' : 'Offer: check these sites yourself, or call the store; with the Sara desktop app connected I can check them in your own browser.');
  }
  const near = r.stores.slice(0, 6);
  if (near.length) {
    lines.push('', `Stores nearby (OpenStreetMap${r.storesNote ? `; ${r.storesNote}` : ''}):`);
    for (const s of near) lines.push(`- ${s.name} (${s.kind}) ${s.miles} mi${s.address ? `, ${s.address}` : ''}${s.hours ? `, hours ${s.hours}` : ''}${s.phone ? `, ${s.phone}` : ''}`);
  } else if (r.storesNote) lines.push('', `Stores nearby: ${r.storesNote}.`);
  if (r.searchNote) lines.push(`Note: ${r.searchNote}.`);
  lines.push('Never buy for them: offer to open the page for them. Say every price with its store and time; don\u2019t add prices or stock that aren\u2019t above.');
  return lines.join('\n');
}
