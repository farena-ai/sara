// E2 (docs/SHOPPING.md): find it near me. Everything here runs on saved fixtures (test/fixtures/
// shopping/README.md); no test touches the network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cardFor } from '../src/cards.ts';
import { OFFSERVER_TOOL } from '../src/chat.ts';
import { eligibleFor, familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { isPrivateLocalError, setPrivateLocal } from '../src/net-guard.ts';
import { buildSystemPrompt, loadPersona } from '../src/persona.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { availabilityOf, blockedReason, matchScore, parsePrice, readProductPage } from '../src/shopping/extract.ts';
import { FIND, findProduct, formatFind, rankRows, type FindRow, type PageLoad } from '../src/shopping/find.ts';
import { milesBetween, OsmPlaces, overpassQuery, parseStores } from '../src/shopping/places.ts';
import { decide, ProductWatches } from '../src/shopping/watch.ts';
import { createShoppingTools, parseDuckDuckGo } from '../src/tools/shopping.ts';
import { makeApp, tempDir } from './helpers.ts';

const FX = join(import.meta.dirname, 'fixtures', 'shopping');
const fx = (n: string) => readFileSync(join(FX, n), 'utf8');
const KC = { name: 'Kansas City, Jackson County, Missouri, United States', lat: 39.0997, lon: -94.5786 };
const page = (url: string, file: string, status = 200): PageLoad => {
  const html = fx(file);
  return { ok: true, url, status, title: /<title[^>]*>([^<]*)</i.exec(html)?.[1] ?? '', html, via: 'browser' };
};

test('stores near: Overpass answer → named stores, nearest first, with address, hours and phone', () => {
  const stores = parseStores(JSON.parse(fx('overpass-kansas-city.json')), KC);
  assert.equal(stores.length, 10);
  for (let i = 1; i < stores.length; i++) assert.ok(stores[i].miles >= stores[i - 1].miles);
  const hd = stores.find((s) => s.brand === 'The Home Depot')!;
  assert.equal(hd.kind, 'doityourself');
  assert.match(hd.address!, /111 East Linwood Boulevard, Kansas City/);
  assert.match(hd.hours!, /^Mo-Sa 06:00-21:00/);
  assert.match(hd.phone!, /555/);
  assert.ok(hd.miles > 1.5 && hd.miles < 3, `${hd.miles}`);
  assert.ok(Math.abs(milesBetween({ lat: 39.0997, lon: -94.5786 }, { lat: 38.627, lon: -90.1994 }) - 237) < 5, 'KC to St. Louis is about 237 miles');
  const q = overpassQuery(39.0997, -94.5786, 10);
  assert.match(q, /around:16093,39\.09970,-94\.57860/);
  assert.match(q, /shop~"\^\(hardware\|doityourself\|electronics\|supermarket\|department_store\|chemist\|car_parts\|sports/);
  assert.match(q, /Academy Sports \\\\\+ Outdoors/, 'regex characters in brand names are escaped for Overpass');
  assert.match(overpassQuery(1, 2, 999), /around:40234,/, 'the radius is capped at 25 miles');
});

test('OSM lookups: a proper User-Agent, cached (stores a day, places a month), mirrors tried when one is busy', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-13T18:00:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => (app.store.close(), cleanup()));
  const calls: { url: string; ua: string }[] = [];
  let busy = 1;
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, ua: String((init?.headers as Record<string, string>)['user-agent']) });
    if (url.includes('nominatim')) return new Response(fx('nominatim-kansas-city.json'));
    if (busy-- > 0) return new Response('# 504 Gateway Timeout: at capacity', { status: 504 });
    return new Response(fx('overpass-kansas-city.json'));
  };
  const osm = new OsmPlaces(app.store.db, { fetch, now: () => clock.now.getTime(), paceMs: 0 });
  const p = await osm.geocode('Kansas City, MO');
  assert.equal(p?.lat, 39.100105);
  await osm.geocode('  kansas city, mo ');
  assert.equal(calls.filter((c) => c.url.includes('nominatim')).length, 1, 'the place is looked up once');
  const a = await osm.stores(p!, 5);
  assert.equal(a.cached, false);
  assert.equal(a.stores.length, 10);
  assert.equal(calls.filter((c) => c.url.includes('interpreter')).length, 2, 'the busy mirror is followed by the next one');
  assert.notEqual(calls[1].url, calls[2].url);
  assert.ok(calls.every((c) => /^Sara\/1 \(.+product finder/.test(c.ua)));
  assert.equal((await osm.stores(p!, 5)).cached, true);
  clock.now = new Date(clock.now.getTime() + 25 * 3600_000);
  assert.equal((await osm.stores(p!, 5)).cached, false, 'after a day the store list is fetched again');
  // Every mirror busy: a plain error, not a guess.
  const down = new OsmPlaces(app.store.db, { fetch: async () => new Response('busy', { status: 429 }), now: () => clock.now.getTime(), paceMs: 0 });
  await assert.rejects(down.stores({ lat: 1, lon: 1 }, 5), /busy right now \(HTTP 429\)/);
});

test('private local mode: the OpenStreetMap lookups are refused by the guard', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  setPrivateLocal(true);
  t.after(() => (setPrivateLocal(false), app.store.close(), cleanup()));
  const osm = new OsmPlaces(app.store.db, { paceMs: 0 });
  await assert.rejects(osm.geocode('Kansas City'), (e) => isPrivateLocalError(e));
  await assert.rejects(osm.stores(KC, 5), (e) => isPrivateLocalError(e));
});

test('page reading: JSON-LD Product/Offer first (price, currency, availability, shipping, ids); a broken block is skipped', () => {
  const r = readProductPage({ url: 'https://www.example-store.test/ip/38445998', status: 200, html: fx('product-jsonld.html') });
  assert.equal(r.blocked, undefined);
  assert.equal(r.offers.length, 1);
  const o = r.offers[0];
  assert.deepEqual([o.price, o.currency, o.availability, o.availabilityText, o.shipping, o.sku, o.gtin, o.model, o.brand, o.seller, o.how], [8.38, 'USD', 'in_stock', 'InStock', 0, '38445998', '079567490057', '490057', 'WD-40', 'Example Store', 'json-ld']);
  const g = readProductPage({ url: 'https://x.test/p', status: 200, html: fx('product-jsonld-graph-oos.html') }).offers[0];
  assert.deepEqual([g.price, g.availability], [9.47, 'out_of_stock'], '@graph and an array @type are read too');
  assert.deepEqual(['https://schema.org/InStock', 'LimitedAvailability', 'PreOrder', 'SoldOut', 'IN_STOCK', 'Out of stock', ''].map(availabilityOf), ['in_stock', 'limited', 'preorder', 'out_of_stock', 'in_stock', 'out_of_stock', 'unknown']);
  assert.deepEqual(['$1,234.50', '8.38', 8.384, 'free', 0].map(parsePrice), [1234.5, 8.38, 8.38, undefined, undefined]);
});

test('page reading: a search page\'s own data (Walmart __NEXT_DATA__), Amazon results, a JSON-LD item list', () => {
  const w = readProductPage({ url: 'https://www.walmart.com/search?q=wd-40+12+oz', status: 200, html: fx('walmart-search-next-data.html') });
  assert.equal(w.offers.length, 4);
  assert.equal(w.offers[0].title, 'WD-40 Multi-Use Product Lubricant Spray with Smart Straw, 12 oz.');
  assert.deepEqual([w.offers[0].price, w.offers[0].availability, w.offers[0].how], [8.38, 'in_stock', 'page-data']);
  assert.match(w.offers[0].url!, /^https:\/\/www\.walmart\.com\/ip\/WD-40-Multi-Use/);
  assert.ok(w.offers[0].fulfillment?.includes('delivery'));
  const a = readProductPage({ url: 'https://www.amazon.com/s?k=wd-40+12+oz', status: 200, html: fx('amazon-search.html') });
  assert.equal(a.offers.length, 4);
  assert.deepEqual([a.offers[0].sponsored, a.offers[1].sponsored], [true, undefined]);
  assert.equal(a.offers[3].price, 8.14, 'the struck-through list price is not the price');
  assert.equal(a.offers[3].url, 'https://www.amazon.com/dp/B01LZ1WS99');
  assert.equal(a.offers[3].delivery, 'FREE delivery Sun, Nov 15');
  assert.equal(a.offers[0].title, 'WD-40 Specialist Penetrant Spray, 11 OZ');
  const ap = readProductPage({ url: 'https://www.amazon.com/ACDelco/dp/B00CFPLI90?th=1', status: 200, html: fx('amazon-product.html') }).offers;
  assert.equal(ap.length, 1);
  assert.deepEqual([ap[0].price, ap[0].availability, ap[0].availabilityText, ap[0].url], [7.96, 'in_stock', 'In Stock', 'https://www.amazon.com/dp/B00CFPLI90'], 'an Amazon product page (for watches)');
  assert.match(ap[0].title, /^ACDelco 24-Count Double AA Batteries/);
  const h = readProductPage({ url: 'https://www.harborfreight.com/search?q=wd-40', status: 200, html: fx('harborfreight-search-itemlist.html') });
  assert.equal(h.offers.length, 0);
  assert.equal(h.productLinks[0], 'https://www.harborfreight.com/16-oz-multi-use-lubricant-62233.html');
});

test('blocked pages are recognised and read as nothing (never worked around)', () => {
  for (const [file, status, re] of [
    ['walmart-robot-or-human.html', 200, /bot check|refused/],
    ['cloudflare-just-a-moment.html', 403, /bot check/],
    ['homedepot-error-403.html', 403, /refused automated access/],
    ['homedepot-error-403.html', 200, /Error Page/],
  ] as const) {
    const html = fx(file);
    assert.match(blockedReason({ status, html }) ?? '', re, file);
    const r = readProductPage({ url: 'https://www.walmart.com/ip/1', status, html });
    assert.deepEqual([r.offers.length, r.productLinks.length], [0, 0]);
  }
  assert.match(blockedReason({ status: 429, html: '<p>slow</p>' })!, /429/);
  assert.equal(blockedReason({ status: 200, html: fx('product-jsonld.html') }), undefined);
});

test('matching: sizes and pack counts must agree', () => {
  assert.equal(matchScore('WD-40 12 oz', 'WD-40 Multi-Use Product Lubricant Spray with Smart Straw, 12 oz.'), 1);
  assert.equal(matchScore('WD-40 12 oz', 'WD 40 490057 Smart Straw Lubricant, 12 Ounce, Aerosol Can'), 1);
  assert.ok(matchScore('WD-40 12 oz', 'WD-40 Specialist Penetrant Spray, 11 OZ') < FIND.minScore);
  assert.ok(matchScore('AA batteries 24 pack', 'Energizer MAX AA Batteries, 24 Count') >= FIND.minScore);
  assert.ok(matchScore('AA batteries 24 pack', 'Duracell AA Batteries 8-Pack') < FIND.minScore);
  assert.equal(matchScore('', 'anything'), 0);
  // A combo or multi-pack he didn't ask for ranks below the single can.
  assert.ok(matchScore('WD-40 12 oz', 'WD-40 Multi-Use Product 12OZ [1-Pack] & Specialist Silicone 11 OZ [1-Pack]') < matchScore('WD-40 12 oz', 'WD-40 Multi-Use Product with Smart Straw, 12 OZ'));
  assert.ok(matchScore('WD-40 12 oz', 'WD-40 Classic Formula, 12 OZ [6-Pack]') < 1);
  assert.equal(matchScore('AA batteries 24 pack', 'ACDelco 24-Count AA Batteries'), 1);
});

test('free search fallback: DuckDuckGo HTML results are decoded; its bot check is an error, not results', () => {
  const r = parseDuckDuckGo(fx('duckduckgo-results.html'));
  assert.equal(r.length, 3);
  assert.match(r[0].url, /^https:\/\/www\.homedepot\.com\/p\/WD-40-12-oz-Classic-Formula/);
  assert.ok(r.every((x) => x.title && !/uddg=/.test(x.url)));
  assert.throws(() => parseDuckDuckGo(fx('duckduckgo-anomaly.html')), /bot check/);
});

/** A finder rig: OSM stores from the fixture; pages by host from fixtures; a scripted search. */
function rig(o: { search?: boolean } = {}) {
  const loads: string[] = [];
  const stores = parseStores(JSON.parse(fx('overpass-kansas-city.json')), KC);
  const loadPage = async (url: string): Promise<PageLoad> => {
    loads.push(url);
    const h = new URL(url).hostname;
    if (h.endsWith('walmart.com')) return page(url, 'walmart-search-next-data.html');
    if (h.endsWith('amazon.com')) return page(url, 'amazon-search.html');
    if (h.endsWith('homedepot.com')) return page(url, 'homedepot-error-403.html', 403);
    if (h.endsWith('walgreens.com')) return page(url, 'cloudflare-just-a-moment.html', 403);
    if (h.endsWith('target.com')) return { ok: false, reason: 'the page took too long', via: 'browser' };
    if (h.endsWith('harborfreight.com') && url.includes('search')) return page(url, 'harborfreight-search-itemlist.html');
    return page(url, 'product-jsonld.html');
  };
  const search = async () => [
    { title: 'WD-40 12 oz. Classic Formula Multi-Purpose Lubricant Spray with Smart Straw 49005', url: 'https://www.homedepot.com/p/WD-40-12-oz-Classic-Formula-Multi-Purpose-Lubricant-Spray-with-Smart-Straw-49005/204777420', snippet: 'WD-40 12 oz. ... $7.98 ... Free pickup today' },
    { title: 'WD-40 12 oz Smart Straw 49005 - review', url: 'https://example.test/review', snippet: 'model 49005' },
  ];
  const deps = { loadPage, ...(o.search === false ? {} : { search }), places: { stores: async () => ({ stores, cached: false, checkedAt: '2026-11-13T18:00:00.000Z' }) }, now: () => new Date('2026-11-13T18:00:00Z') };
  return { deps, loads };
}

test('find_product: nearby chains and online retailers, one page at a time, ranked, with sources and what couldn\'t be checked', async () => {
  const { deps, loads } = rig();
  const r = await findProduct(deps, { what: 'WD-40 12 oz', place: KC, near: true, radiusMiles: 10, online: true }, AbortSignal.timeout(5000));
  assert.ok(loads.length <= FIND.maxLoads);
  assert.equal(new Set(loads).size, loads.length, 'no page is opened twice');
  assert.ok(loads.includes('https://www.homedepot.com/p/WD-40-12-oz-Classic-Formula-Multi-Purpose-Lubricant-Spray-with-Smart-Straw-49005/204777420'), 'the product page the search found is opened, not the search page');
  assert.deepEqual(r.models, ['49005']);
  const walmart = r.rows.find((x) => x.retailer === 'Walmart')!;
  assert.deepEqual([walmart.price, walmart.availability, walmart.store?.name], [8.38, 'in_stock', 'Walmart Neighborhood Market']);
  assert.match(walmart.source, /walmart\.com page data, her browser/);
  const amazon = r.rows.find((x) => x.retailer === 'Amazon')!;
  assert.deepEqual([amazon.price, amazon.url, amazon.sponsored], [8.14, 'https://www.amazon.com/dp/B01LZ1WS99', undefined], 'the cheapest close match that isn\'t an ad');
  // Home Depot refused: listed, with the store's phone, and the search snippet's price labelled as such.
  const hd = r.couldNot.find((c) => c.retailer === 'The Home Depot')!;
  assert.match(hd.reason, /refused automated access \(Error Page\)/);
  assert.match(hd.store!.phone!, /555/);
  const snip = r.rows.find((x) => x.retailer === 'The Home Depot')!;
  assert.deepEqual([snip.price, snip.fromSearch, snip.availability], [7.98, true, 'unknown']);
  assert.match(snip.source, /search result snippet \(may be out of date\)/);
  assert.ok(r.couldNot.some((c) => c.retailer === 'Walgreens' && /bot check/.test(c.reason)));
  assert.ok(r.couldNot.some((c) => c.retailer === 'Target' && /too long/.test(c.reason)));
  // In stock and read from the page come before a snippet price, even a lower one.
  assert.equal(r.rows.at(-1)!.retailer, 'The Home Depot');
  assert.equal(r.rows[0].availability, 'in_stock');
  const text = formatFind(r, { id: 7, time: () => '12:00 PM', canUsePc: true });
  assert.match(text, /^Product search: “WD-40 12 oz” near Kansas City, Jackson County \(within 10 mi\)\. Checked 12:00 PM\. Result #7/);
  assert.match(text, /\n\d\. Walmart — \$8\.38 — in stock — delivery \/ pickup — nearest store [\d.]+ mi \(4701 Mill Road, Westwood, KS, 66205\)\n {3}https:\/\/www\.walmart\.com\/ip\//);
  assert.match(text, /\n\d\. Amazon — \$8\.14 — stock not shown — FREE delivery Sun, Nov 15\n/);
  assert.match(text, /Couldn’t check:\n- The Home Depot: the site refused automated access \(Error Page\)\. Call the store \(The Home Depot, [\d.]+ mi\): \+1 816-555-01\d\d/);
  assert.match(text, /I can check these in your own browser on your computer/);
  assert.match(text, /Never buy for them/);
  assert.doesNotMatch(formatFind(r, { time: () => 'x', canUsePc: false }), /pc_browser_open/);
  // The chat card: the ranked lines as a search card.
  const card = cardFor({ name: 'find_product', args: { what: 'WD-40 12 oz' }, status: 'ok', output: text });
  assert.equal(card?.kind, 'search');
  assert.ok((card as { results: { host: string }[] }).results.some((x) => x.host === 'walmart.com'));
});

test('find_product: max price, named stores, page budget, and no search set up', async () => {
  const { deps } = rig();
  const cheap = await findProduct(deps, { what: 'WD-40 12 oz', near: false, radiusMiles: 10, online: true, maxPrice: 8.2 }, AbortSignal.timeout(5000));
  assert.ok(cheap.rows.every((x) => (x.price ?? 0) <= 8.2));
  assert.ok(cheap.overMax >= 1);
  const named = await findProduct(deps, { what: 'WD-40 12 oz', near: false, radiusMiles: 10, online: false, stores: ['amazon', 'Joe\'s Corner Shop'] }, AbortSignal.timeout(5000));
  assert.deepEqual(named.rows.map((x) => x.retailer), ['Amazon']);
  assert.match(named.couldNot[0].reason, /not a store I know/);
  // Every retailer needs two pages (search page → product page): the budget stops at FIND.maxLoads.
  const loads: string[] = [];
  const budget = await findProduct({ ...deps, search: undefined, loadPage: async (url) => (loads.push(url), url.includes('-62') || url.includes('/p/') ? page(url, 'product-jsonld.html') : page(url, 'harborfreight-search-itemlist.html')) }, { what: 'WD-40 12 oz', near: false, radiusMiles: 10, online: false, stores: ['walmart', 'target', 'home depot', 'lowes', 'best buy', 'harbor freight'] }, AbortSignal.timeout(5000));
  assert.equal(loads.length, FIND.maxLoads);
  assert.ok(budget.couldNot.some((c) => /limit of pages/.test(c.reason)));
  assert.match(budget.searchNote!, /web search is not set up/);
});

test('ranking: in stock, then page facts over snippets, then total with shipping, then distance', () => {
  const base = { title: 't', url: 'https://x.test', checkedAt: 'now', source: 's' };
  const rows: FindRow[] = [
    { ...base, retailer: 'A', price: 5, availability: 'out_of_stock' },
    { ...base, retailer: 'B', price: 9, availability: 'in_stock', store: { name: 'b', miles: 4 } },
    { ...base, retailer: 'C', price: 8, shipping: 2, availability: 'in_stock' },
    { ...base, retailer: 'D', price: 9, availability: 'in_stock', store: { name: 'd', miles: 1 } },
    { ...base, retailer: 'E', price: 1, availability: 'in_stock', fromSearch: true },
    { ...base, retailer: 'F', availability: 'unknown' },
  ];
  assert.deepEqual(rankRows(rows).map((r) => r.retailer), ['D', 'B', 'C', 'E', 'F', 'A']);
});

test('product watches: fire once per change, every 6 hours at most, on the reminder tick; paused after repeated blocks', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-13T18:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'UTC' });
  const pushes: string[] = [];
  app.push = { notifyOwner: async (title: string) => void pushes.push(title) } as never;
  t.after(() => (app.store.close(), cleanup()));
  const conv = app.store.createConversation({ title: 'shop' });
  let next: PageLoad = page('https://www.example-store.test/ip/38445998', 'product-jsonld-graph-oos.html');
  let loads = 0;
  const w = new ProductWatches(app, app.store.db, async () => (loads++, next));
  app.productWatches = w;
  const watch = w.add({ url: 'https://www.example-store.test/ip/38445998', label: 'WD-40 12 oz', condition: 'back_in_stock', conversationId: conv.id });
  assert.equal(watch.retailer, 'example-store.test');
  const tick = async () => {
    new ReminderScheduler(app, app.planner!).tick();
    await new Promise((r) => setTimeout(r, 20));
  };
  await tick();
  assert.equal(loads, 1);
  assert.equal(w.get(watch.id)!.lastAvailability, 'out_of_stock');
  await tick();
  assert.equal(loads, 1, 'not checked again within 6 hours');
  next = page('https://www.example-store.test/ip/38445998', 'product-jsonld.html');
  clock.now = new Date(clock.now.getTime() + 6 * 3600_000);
  await tick();
  const msgs = () => app.store.messages(conv.id).filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.equal(msgs().length, 1);
  assert.match(msgs()[0], /^WD-40 12 oz is in stock at example-store\.test \(\$8\.38\)\. Checked 12:00 AM on example-store\.test’s page: .+ \(product watch #1\)\. I won’t buy anything/);
  assert.deepEqual(pushes, ['Product watch: WD-40 12 oz']);
  clock.now = new Date(clock.now.getTime() + 6 * 3600_000);
  await tick();
  assert.equal(msgs().length, 1, 'still in stock: no second alert');
  // Blocked four times in a row: paused, said once.
  next = page('https://www.example-store.test/ip/38445998', 'walmart-robot-or-human.html');
  for (let i = 0; i < 5; i++) {
    clock.now = new Date(clock.now.getTime() + 6 * 3600_000);
    await tick();
  }
  assert.equal(w.get(watch.id)!.state, 'paused');
  assert.equal(loads, 7, 'a paused watch is not checked');
  assert.match(msgs().at(-1)!, /is paused: 4 checks in a row couldn’t read the page \(the site showed a bot check\)\. I can check it in your own browser/);
  assert.equal(msgs().length, 2);
  assert.ok(w.remove(watch.id));
  assert.equal(w.list().length, 0);
  assert.throws(() => w.add({ url: 'ftp://x', label: 'x', condition: 'any_change' }), /web pages/);
  assert.throws(() => w.add({ url: 'https://x.test', label: 'x', condition: 'price_below' }), /needs a price/);
});

test('watch decisions: price below fires once until it goes back up; any change has a baseline', () => {
  const base = { label: 'AA 24', retailer: 'Target', lastPrice: null, lastAvailability: null, lastCheckedAt: null, firedKey: null };
  const pb = { ...base, condition: 'price_below' as const, threshold: 15 };
  let d = decide(pb, { price: 16, availability: 'in_stock' });
  assert.deepEqual(d, { firedKey: null });
  d = decide(pb, { price: 14.5, availability: 'in_stock' });
  assert.match(d.alert!, /AA 24 is \$14\.50 at Target, under your \$15\.00/);
  d = decide({ ...pb, firedKey: d.firedKey }, { price: 13, availability: 'in_stock' });
  assert.equal(d.alert, undefined, 'already below: no second alert for a further drop');
  d = decide({ ...pb, firedKey: d.firedKey }, { price: 15.5, availability: 'in_stock' });
  assert.equal(d.firedKey, null);
  assert.ok(decide({ ...pb, firedKey: null }, { price: 12, availability: 'in_stock' }).alert, 'back under after going up: fires again');
  const ac = { ...base, condition: 'any_change' as const, threshold: null };
  const first = decide(ac, { price: 10, availability: 'in_stock' });
  assert.equal(first.alert, undefined, 'the first look is the baseline');
  const again = decide({ ...ac, lastCheckedAt: 'x', lastPrice: 10, lastAvailability: 'in_stock', firedKey: first.firedKey }, { price: 11, availability: 'out_of_stock' });
  assert.match(again.alert!, /changed: price \$10\.00 → \$11\.00, in stock → out of stock/);
  const bis = { ...base, condition: 'back_in_stock' as const, threshold: null };
  assert.equal(decide({ ...bis, firedKey: 'in' }, { availability: 'unknown' }).firedKey, 'in', 'an unreadable stock state doesn\'t reset it');
  assert.equal(decide({ ...bis, firedKey: 'in' }, { availability: 'out_of_stock' }).firedKey, null);
});

test('tools: registered for the owner; product_watch_add from a find result; off in private chats; lean words', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-13T18:00:00Z') });
  t.after(() => (app.store.close(), cleanup()));
  const tools = createShoppingTools(app, app.store.db);
  for (const x of tools) app.tools.add(x);
  assert.deepEqual(tools.map((x) => x.spec.name), ['find_product', 'stores_near', 'product_watch_add', 'product_watch_list', 'product_watch_remove']);
  assert.match(tools[0].spec.description, /never buy/);
  for (const n of tools.map((x) => x.spec.name)) {
    assert.ok(OFFSERVER_TOOL(n), `${n} reaches outside: off in private chats`);
    assert.equal(familyOf(app.tools.get(n)!).id, 'shopping');
  }
  const conv = app.store.createConversation({ title: 'x' });
  const names = (c: Parameters<typeof eligibleFor>[1]) => eligibleFor(app, c).map((x) => x.spec.name);
  assert.ok(names({ ...conv, private: false }).includes('find_product'));
  assert.ok(!names({ ...conv, private: true }).some((n) => n === 'find_product' || n === 'stores_near' || n.startsWith('product_watch_')));
  for (const w of ['where can i buy', 'in stock', 'near me', 'price of', 'cheapest', 'store', 'amazon', 'walmart', 'target', 'home depot', 'best buy', 'buy', 'donde comprar', 'ou acheter', 'wo kaufen', 'onde comprar', 'dove comprare']) assert.ok(FAMILY_WORDS.shopping.includes(w), w);
  // No place saved and none named: she asks for it instead of guessing.
  await assert.rejects(tools[1].run({}, { signal: AbortSignal.timeout(1000) } as never), /ask for their city/);
  // A saved find result → a watch starting from what it saw.
  const { FindLog } = await import('../src/tools/shopping.ts');
  const log = new FindLog(app.store.db);
  const { deps } = rig();
  const id = log.save(await findProduct(deps, { what: 'WD-40 12 oz', near: false, radiusMiles: 10, online: false, stores: ['walmart'] }, AbortSignal.timeout(5000)), conv.id);
  const out = await tools[2].run({ result_id: id, line: 1, condition: 'back_in_stock' }, { signal: AbortSignal.timeout(1000), conversationId: conv.id } as never);
  assert.match(out, /Product watch #1 added: WD-40 12 oz at Walmart, back in stock\. .*starting from what the search just saw/);
  assert.equal(app.productWatches!.get(1)!.firedKey, 'in', 'in stock now: it waits for the next restock');
  assert.match(await tools[3].run({}, { signal: AbortSignal.timeout(1000) } as never), /#1 WD-40 12 oz — Walmart — back in stock — last: not checked yet/);
  assert.match(await tools[4].run({ id: 1 }, { signal: AbortSignal.timeout(1000) } as never), /removed/);
});

test('persona: with find_product she is the shopping assistant who compares, names sources and never buys', () => {
  const p = loadPersona(join(import.meta.dirname, '..', 'persona', 'sara.json'));
  const base = { now: new Date('2026-11-13T12:00:00Z'), timeZone: 'UTC', ownerName: 'Alex' };
  const on = buildSystemPrompt(p, { ...base, tools: ['find_product', 'product_watch_add'] } as never);
  assert.match(on, /## Shopping[\s\S]*call find_product[\s\S]*pickup today vs delivery date[\s\S]*total with shipping[\s\S]*never fill in a price[\s\S]*You never buy, add to a cart or check out/);
  assert.doesNotMatch(buildSystemPrompt(p, { ...base, tools: ['todo'] } as never), /## Shopping/);
});
