// E2 (docs/SHOPPING.md): the shopping assistant's tools. find_product checks stores near the person
// (OpenStreetMap) and the retailers' own pages (her browser, else the guarded reader) for price and
// stock; stores_near lists the shops around them; product_watch_add / _list / _remove watch a
// product page for back in stock, a price below a number, or any change (src/shopping/watch.ts).
// She never buys: checkout and payment stay with the person. The owner's own spaces only (not
// household members) and never in private chats (they reach outside; chat.ts OFFSERVER_TOOL).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { searchConfig } from '../integrations.ts';
import { formatLocal } from '../planner.ts';
import { FIND, findProduct, formatFind, type FindResult, type PageLoad } from '../shopping/find.ts';
import { OsmPlaces, type GeoPlace } from '../shopping/places.ts';
import { PRODUCT_WATCH, ProductWatchError, ProductWatches, WATCH_CONDITIONS, type WatchCondition } from '../shopping/watch.ts';
import { guardedGet } from './builtin.ts';
import { runSearch, type SearchResult } from './search.ts';
import { clip, ToolError, type Tool, type ToolContext } from './types.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const MAX_HTML = 2_500_000;

/** Finder results kept for watches ("watch line 2 of result #7"); the last 50. */
export class FindLog {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS product_finds (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, conversation_id TEXT, what TEXT NOT NULL, result TEXT NOT NULL)');
  }
  save(r: FindResult, conversationId?: string): number {
    const row = this.#db.prepare('INSERT INTO product_finds (at, conversation_id, what, result) VALUES (?, ?, ?, ?) RETURNING id').get(r.checkedAt, conversationId ?? null, r.what, JSON.stringify(r)) as { id: number };
    this.#db.prepare('DELETE FROM product_finds WHERE id <= ?').run(row.id - 50);
    return row.id;
  }
  get(id: number): FindResult | undefined {
    const r = this.#db.prepare('SELECT result FROM product_finds WHERE id = ?').get(id) as { result: string } | undefined;
    return r ? (JSON.parse(r.result) as FindResult) : undefined;
  }
}

/** One page: her browser when this server has one (a real page, scripts and all), else the guarded reader. */
export function pageLoader(app: AppContext, sessionKey: () => string): (url: string, signal: AbortSignal) => Promise<PageLoad> {
  return async (url, signal) => {
    const browsers = app.browsers;
    if (browsers && browsers.status().found) {
      const s = await browsers.session(sessionKey(), true);
      const opened = await Promise.race([s.open(url), new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('the page took too long')), { once: true }))]);
      if (opened.error) return { ok: false, reason: opened.error.replace(/^net::ERR_/, '').toLowerCase().replace(/_/g, ' '), via: 'browser' };
      // Many stores draw prices with scripts after the page loads: give them a moment.
      await new Promise((r) => setTimeout(r, 1500));
      const r = (await s.cdp.send('Runtime.evaluate', { expression: `document.documentElement ? document.documentElement.outerHTML.slice(0, ${MAX_HTML}) : ''`, returnByValue: true }, s.sessionId)) as { result?: { value?: string } };
      return { ok: true, url: opened.url || url, status: opened.status || 200, title: opened.title, html: String(r.result?.value ?? ''), via: 'browser' };
    }
    const g = await guardedGet(new URL(url), { signal, allowPrivate: false, keepHtml: true, timeoutMs: FIND.pageTimeoutMs });
    return { ok: true, url: g.url.href, status: g.status, title: g.title ?? '', html: g.html ?? g.raw ?? g.text, via: 'reader' };
  };
}

/** DuckDuckGo's plain HTML results (free, no key), when no web search is set up. Empty on a bot check. */
export async function freeSearch(q: string, signal: AbortSignal): Promise<SearchResult[]> {
  const g = await guardedGet(new URL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`), { signal, allowPrivate: false, keepHtml: true, timeoutMs: 15_000 });
  return parseDuckDuckGo(g.html ?? '');
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  if (/anomaly\.js|anomaly-modal/.test(html)) throw new Error('the free search (DuckDuckGo) showed a bot check');
  const out: SearchResult[] = [];
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    const u = /[?&]uddg=([^&]+)/.exec(raw)?.[1];
    const url = u ? decodeURIComponent(u) : raw.startsWith('//') ? `https:${raw}` : raw;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: strip(m[2]), url, snippet: strip(m[3] ?? '') });
    if (out.length >= 10) break;
  }
  return out;
}

/** The person's place: the one named in the call, else their saved briefing place. */
async function placeFor(app: AppContext, osm: OsmPlaces, named: unknown, signal: AbortSignal): Promise<GeoPlace | undefined> {
  if (typeof named === 'string' && named.trim()) {
    const p = await osm.geocode(named.trim().slice(0, 120), signal);
    if (!p) throw new ToolError(`OpenStreetMap doesn't know the place \u201c${named.trim().slice(0, 60)}\u201d; ask for their city and state, or a ZIP code.`);
    return p;
  }
  const saved = app.settings.get().briefing?.place;
  return saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) ? { name: saved.name, lat: saved.lat, lon: saved.lon } : undefined;
}

const canUsePc = (app: AppContext) => Boolean(app.hands && app.hands.allowed() && app.hands.devices().some((d) => d.connected && d.optIn?.browser));

export function createShoppingTools(app: AppContext, db: DatabaseSync): Tool[] {
  const osm = new OsmPlaces(db);
  const finds = new FindLog(db);
  const time = (iso: string) => formatLocal(iso, app.settings.get().timeZone);
  const search = (): ((q: string, s: AbortSignal) => Promise<SearchResult[]>) => {
    const cfg = searchConfig(app.settings, app.vault);
    return cfg ? (q, s) => runSearch(cfg, q, 8, s) : freeSearch;
  };
  const watches = new ProductWatches(app, db, pageLoader(app, () => 'product-watch'));
  app.productWatches = watches;

  const findTool: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'find_product',
      description:
        "Be their shopping assistant: find where to buy a product, nearby and online, with price and stock. Checks the stores near them (OpenStreetMap; their saved place, or `place`) and the retailers' own pages (Walmart, Target, Home Depot, Lowe's, Best Buy, Walgreens, CVS, AutoZone, Amazon…) one at a time, and returns a ranked list: store, price, in stock / pickup / delivery when the page says, distance to the nearest store, link, the time it was checked and where each fact came from, plus the sites that couldn't be checked and why. Ask about size, model or pack count only when it really matters. Compare in your answer (pickup vs delivery, total with shipping when shown), name each source and time, and never add a price or stock state that isn't in the result. You never buy or check out: offer to open the page for them. For a site that blocked you, offer to check it in their own browser (computer use) or give the store's phone number.",
      parameters: obj(
        {
          what: { type: 'string', description: 'The product as they said it, with size/model/pack count when known (\u201cWD-40 12 oz\u201d, \u201cAA batteries 24 pack\u201d).' },
          near: { type: 'boolean', description: 'Check stores near them (default true).' },
          place: { type: 'string', description: 'A city, address or ZIP code, when it isn\u2019t their saved place.' },
          radius_miles: { type: 'number', description: `How far to look for stores (default ${FIND.defaultRadius}, at most ${FIND.maxRadius}).` },
          max_price: { type: 'number', description: 'Leave out offers above this price.' },
          online: { type: 'boolean', description: 'Also check the big online retailers (default true).' },
          stores: { type: 'array', items: { type: 'string' }, description: 'Only these retailers (\u201cHome Depot\u201d, \u201cAmazon\u201d).' },
        },
        ['what'],
      ),
    },
    summarize: (a) => `find \u201c${String(a.what ?? '').slice(0, 80)}\u201d`,
    async run(args, ctx: ToolContext) {
      const what = typeof args.what === 'string' ? args.what.trim() : '';
      if (!what) throw new ToolError('what: the product to look for.');
      const near = args.near !== false;
      const place = near ? await placeFor(app, osm, args.place, ctx.signal) : undefined;
      if (near && !place && args.online === false) throw new ToolError('Their place isn\u2019t known: ask for their city and state or ZIP code (or save it in Settings \u2192 Morning briefing), then call again with place.');
      const result = await findProduct(
        { loadPage: pageLoader(app, () => ctx.conversationId ?? 'product-finder'), search: search(), places: osm, now: () => app.now() },
        {
          what,
          near: Boolean(place),
          ...(place ? { place } : {}),
          radiusMiles: typeof args.radius_miles === 'number' ? args.radius_miles : FIND.defaultRadius,
          ...(typeof args.max_price === 'number' && args.max_price > 0 ? { maxPrice: args.max_price } : {}),
          online: args.online !== false,
          ...(Array.isArray(args.stores) ? { stores: args.stores.filter((s): s is string => typeof s === 'string').slice(0, 6) } : {}),
        },
        ctx.signal,
      );
      const id = finds.save(result, ctx.conversationId);
      ctx.webTurn?.noteFound(result.rows.map((r) => r.url));
      const noPlace = near && !place ? '\nTheir place isn\u2019t saved, so no nearby stores were checked: ask for their city or ZIP to check stores near them.' : '';
      return clip(formatFind(result, { id, time, canUsePc: canUsePc(app) }) + noPlace, 12_000);
    },
  };

  const storesTool: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'stores_near',
      description: 'List shops near them from OpenStreetMap (hardware, home improvement, electronics, supermarkets, department stores, pharmacies, auto parts, sporting goods and the big chains): name, distance, address, opening hours and phone when mapped. For price and stock of a product use find_product.',
      parameters: obj({ kind: { type: 'string', description: 'Optional: a kind or chain to keep (\u201chardware\u201d, \u201cpharmacy\u201d, \u201cWalmart\u201d).' }, place: { type: 'string', description: 'A city, address or ZIP, when it isn\u2019t their saved place.' }, radius_miles: { type: 'number' } }),
    },
    summarize: (a) => `stores near${a.kind ? ` (${String(a.kind).slice(0, 40)})` : ''}`,
    async run(args, ctx) {
      const place = await placeFor(app, osm, args.place, ctx.signal);
      if (!place) throw new ToolError('Their place isn\u2019t known: ask for their city and state or ZIP code, then call again with place.');
      const radius = typeof args.radius_miles === 'number' ? Math.min(FIND.maxRadius, Math.max(1, args.radius_miles)) : FIND.defaultRadius;
      const got = await osm.stores(place, radius, ctx.signal);
      const kind = typeof args.kind === 'string' ? args.kind.toLowerCase().trim() : '';
      const alias: Record<string, string> = { pharmacy: 'chemist', drugstore: 'chemist', 'home improvement': 'doityourself', grocery: 'supermarket', 'auto parts': 'car_parts' };
      const k = alias[kind] ?? kind;
      const list = k ? got.stores.filter((s) => s.kind.includes(k.replace(/ /g, '_')) || `${s.name} ${s.brand ?? ''}`.toLowerCase().includes(k)) : got.stores;
      if (!list.length) return `No ${kind || 'stores'} mapped within ${radius} mi of ${place.name} on OpenStreetMap (checked ${time(got.checkedAt)}). The map can miss shops; a web search may find more.`;
      return clip(`Stores within ${radius} mi of ${place.name} (OpenStreetMap, checked ${time(got.checkedAt)}${got.cached ? ', from the day\u2019s cache' : ''}):\n${list.slice(0, 25).map((s) => `- ${s.name} (${s.kind}) ${s.miles} mi${s.address ? `, ${s.address}` : ''}${s.hours ? `, hours ${s.hours}` : ''}${s.phone ? `, ${s.phone}` : ''}${s.website ? `, ${s.website}` : ''}`).join('\n')}${list.length > 25 ? `\n(${list.length - 25} more)` : ''}\nOpening hours are as mapped by volunteers; holiday hours may differ.`, 8_000);
    },
  };

  const watchAdd: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'product_watch_add',
      description: `Watch a product page and tell them when it changes: back_in_stock, price_below (a price), or any_change. Give a product page address, or a find_product result number and line. Checked at most every ${PRODUCT_WATCH.everyMs / 3600_000} hours; they get one message and a notification per change. It never buys anything.`,
      parameters: obj({
        url: { type: 'string', description: 'The product page address.' },
        result_id: { type: 'integer', description: 'A find_product result number (instead of url).' },
        line: { type: 'integer', description: 'The line of that result (default 1).' },
        condition: { type: 'string', enum: [...WATCH_CONDITIONS] },
        below: { type: 'number', description: 'For price_below: the price to beat.' },
        label: { type: 'string', description: 'A short name for it (default: the product name).' },
      }, ['condition']),
    },
    summarize: (a) => `watch a product (${String(a.condition ?? '')})`,
    async run(args, ctx) {
      let url = typeof args.url === 'string' ? args.url.trim() : '';
      let label = typeof args.label === 'string' ? args.label.trim() : '';
      let seen: { price?: number; availability?: import('../shopping/extract.ts').Availability } = {};
      if (!url && typeof args.result_id === 'number') {
        const r = finds.get(args.result_id);
        const row = r?.rows[(typeof args.line === 'number' ? args.line : 1) - 1];
        if (!row) throw new ToolError(`No line ${typeof args.line === 'number' ? args.line : 1} in find_product result #${args.result_id}.`);
        if (row.fromSearch) throw new ToolError('That line came from a search snippet, not the store\u2019s page; give the product page address instead.');
        url = row.url;
        label ||= r!.what;
        seen = { ...(row.price !== undefined ? { price: row.price } : {}), availability: row.availability };
      }
      if (!url) throw new ToolError('Give url (a product page) or result_id from find_product.');
      try {
        const w = watches.add({ url, label: label || url, condition: args.condition as WatchCondition, ...(typeof args.below === 'number' ? { threshold: args.below } : {}), ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), ...seen });
        return `Product watch #${w.id} added: ${w.label} at ${w.retailer}, ${w.condition.replace(/_/g, ' ')}${w.threshold !== null ? ` $${w.threshold.toFixed(2)}` : ''}. First check within the next few minutes${seen.availability ? ' (starting from what the search just saw)' : ''}, then every ${PRODUCT_WATCH.everyMs / 3600_000} hours; one message and a notification per change.`;
      } catch (err) {
        if (err instanceof ProductWatchError) throw new ToolError(err.message);
        throw err;
      }
    },
  };

  const watchList: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'product_watch_list', description: 'List the product watches: what, where, condition, the last price and stock seen and when.', parameters: obj({}) },
    summarize: () => 'list product watches',
    async run() {
      const all = watches.list();
      if (!all.length) return 'No product watches.';
      return all.map((w) => `#${w.id} ${w.label} \u2014 ${w.retailer} \u2014 ${w.condition.replace(/_/g, ' ')}${w.threshold !== null ? ` $${w.threshold.toFixed(2)}` : ''}${w.state === 'paused' ? ' \u2014 paused' : ''} \u2014 last: ${w.lastCheckedAt ? `${w.lastPrice !== null ? `$${w.lastPrice.toFixed(2)}` : 'price not shown'}, ${(w.lastAvailability ?? 'unknown').replace(/_/g, ' ')}, ${time(w.lastCheckedAt)}` : 'not checked yet'}${w.lastError ? ` (last check: ${w.lastError})` : ''}\n   ${w.url}`).join('\n');
    },
  };

  const watchRemove: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'product_watch_remove', description: 'Stop a product watch by its number.', parameters: obj({ id: { type: 'integer' } }, ['id']) },
    summarize: (a) => `stop product watch #${String(a.id ?? '')}`,
    async run(args) {
      const id = Number(args.id);
      return watches.remove(id) ? `Product watch #${id} removed.` : `No product watch #${id}.`;
    },
  };

  return [findTool, storesTool, watchAdd, watchList, watchRemove];
}

