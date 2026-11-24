// P2 polish (docs/design/P2STOCKS.md): stock trackers and graphs on Today. Trackers are the same
// live watches the alerts use (kind price, when "track"), so there is one list. Charts are drawn
// locally from a free source (Yahoo Finance chart, no key). No network: a fake price source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DataSources, parseYahooChart, parseYahooSearch, type FetchLike } from '../src/data-sources.ts';
import { LiveWatches } from '../src/live-watch.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { STOCKS, stocksOf, usMarketHolidays, usMarketOpen } from '../src/stock-trackers.ts';
import { TILES as SERVER_TILES } from '../src/today-layout.ts';
import { TODAY_PARTS } from '../src/today.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';
// The web helpers have no imports, so they load in Node (no type file: typed loosely here).
const { chartGeom, changeParts, pollEveryMs } = (await import(new URL('../web/stock-chart.js', import.meta.url).href)) as Record<string, (...a: any[]) => any>;

const T0 = Date.parse('2026-11-18T16:00:00Z'); // a Wednesday, 11:00 in New York: market open

function chartJson(sym: string, closes: (number | null)[], prev = 100, start = T0 / 1000 - 3600) {
  return JSON.stringify({ chart: { result: [{ meta: { symbol: sym, currency: 'USD', regularMarketPrice: closes.at(-1), chartPreviousClose: prev, regularMarketTime: start + closes.length * 300, longName: `${sym} Corp` }, timestamp: closes.map((_, i) => start + i * 300), indicators: { quote: [{ close: closes }] } }], error: null } });
}
const sparkFor = (prices: Record<string, number>) => JSON.stringify({ spark: { result: Object.entries(prices).map(([s, p]) => ({ symbol: s, response: [{ meta: { symbol: s, regularMarketPrice: p, chartPreviousClose: 100, regularMarketTime: T0 / 1000 - 60, currency: 'USD', shortName: `${s} Inc.` } }] })) } });
const searchJson = JSON.stringify({ quotes: [
  { symbol: 'AAPL', shortname: 'Apple Inc.', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
  { symbol: 'APLE', longname: 'Apple Hospitality REIT', exchange: 'NYQ', quoteType: 'EQUITY' },
  { symbol: 'AAPL250117C00100000', shortname: 'an option', quoteType: 'OPTION' },
  { name: 'no symbol' },
] });

/** The fake price source: answers Yahoo spark/chart/search; `down` makes every request fail. */
function fakeSource(prices: Record<string, number>) {
  const urls: string[] = [];
  const state = { down: false };
  const f: FetchLike = async (url) => {
    urls.push(url);
    if (state.down) throw new TypeError('fetch failed');
    if (url.includes('/v7/finance/spark')) {
      const syms = decodeURIComponent(/symbols=([^&]+)/.exec(url)![1]).split(',');
      return new Response(sparkFor(Object.fromEntries(syms.filter((s) => prices[s]).map((s) => [s, prices[s]]))));
    }
    if (url.includes('/v8/finance/chart/')) {
      const sym = decodeURIComponent(/chart\/([^?]+)/.exec(url)![1]);
      return prices[sym] ? new Response(chartJson(sym, [101, 102, null, 99, prices[sym]])) : new Response('{"chart":{"result":null,"error":{"code":"Not Found"}}}', { status: 404 });
    }
    if (url.includes('/v1/finance/search')) return new Response(searchJson);
    throw new TypeError('fetch failed');
  };
  return { f, urls, state };
}

function rig(t: import('node:test').TestContext, prices: Record<string, number> = { AAPL: 120, MSFT: 95 }) {
  const tmp = tempDir();
  t.after(() => tmp.cleanup());
  const clock = { t: T0 };
  const app = makeApp(tmp.dir, { get now() { return new Date(clock.t); } });
  const net = fakeSource(prices);
  app.dataSources = new DataSources({ choices: () => ({ quote: 'yahoo' }), keys: { get: () => undefined }, fetch: net.f, now: () => clock.t });
  app.liveWatches = new LiveWatches(app, app.store.db);
  t.after(() => app.store.close());
  return { app, net, clock, w: app.liveWatches };
}

// ---------------------------------------------------------------- pure parts

test('p2stocks parse: Yahoo chart → points (gaps dropped), previous close, name; search keeps stocks/ETFs/indexes/crypto', () => {
  const c = parseYahooChart(JSON.parse(chartJson('AAPL', [101, 102, null, 99, 120])), '2026-11-18T16:00:00.000Z')!;
  assert.equal(c.symbol, 'AAPL');
  assert.equal(c.points.length, 4, 'a null close is a gap, not a zero');
  assert.equal(c.prevClose, 100);
  assert.equal(c.price, 120);
  assert.equal(c.name, 'AAPL Corp');
  assert.equal(c.source, 'Yahoo Finance');
  assert.equal(parseYahooChart({ chart: { result: null } }, 'x'), null);
  const s = parseYahooSearch(JSON.parse(searchJson));
  assert.deepEqual(s.map((x) => x.symbol), ['AAPL', 'APLE'], 'options and rows without a symbol are dropped');
  assert.equal(s[1].name, 'Apple Hospitality REIT');
});

test('p2stocks market hours: New York 9:30-16:00 on weekdays, daylight time included', () => {
  assert.equal(usMarketOpen(new Date('2026-11-18T16:00:00Z')), true, 'Wed 11:00 EST');
  assert.equal(usMarketOpen(new Date('2026-11-18T14:00:00Z')), false, 'Wed 9:00 EST');
  assert.equal(usMarketOpen(new Date('2026-11-18T21:30:00Z')), false, 'Wed 16:30 EST');
  assert.equal(usMarketOpen(new Date('2026-07-15T13:45:00Z')), true, 'Wed 9:45 EDT');
  assert.equal(usMarketOpen(new Date('2026-11-21T16:00:00Z')), false, 'Saturday');
  // T43 (C22): holidays and the two short days.
  assert.deepEqual([...usMarketHolidays(2026)].sort(), ['01-01', '01-19', '02-16', '04-03', '05-25', '06-19', '07-03', '09-07', '11-26', '12-25']);
  assert.deepEqual([...usMarketHolidays(2027)].sort(), ['01-01', '01-18', '02-15', '03-26', '05-31', '06-18', '07-05', '09-06', '11-25', '12-24']);
  assert.ok(!usMarketHolidays(2022).has('12-31'), "New Year's Day 2022 fell on a Saturday: the Friday before was a trading day");
  assert.equal(usMarketOpen(new Date('2026-11-26T16:00:00Z')), false, 'Thanksgiving');
  assert.equal(usMarketOpen(new Date('2026-11-27T16:00:00Z')), true, 'the day after, 11:00');
  assert.equal(usMarketOpen(new Date('2026-11-27T18:30:00Z')), false, 'the day after, 13:30: closed at 13:00');
  assert.equal(usMarketOpen(new Date('2026-04-03T15:00:00Z')), false, 'Good Friday');
  assert.equal(usMarketOpen(new Date('2026-07-03T15:00:00Z')), false, 'July 4 on a Saturday is kept on Friday');
  assert.equal(usMarketOpen(new Date('2026-12-24T16:00:00Z')), true, 'Christmas Eve 11:00');
  assert.equal(usMarketOpen(new Date('2026-12-24T19:00:00Z')), false, 'Christmas Eve 14:00');
});

test('p2stocks web helpers: the chart geometry, change words that are not color only, polite polling', () => {
  const g = chartGeom([[0, 10], [1, 20], [2, 15]], { w: 100, h: 40, levels: [25] });
  assert.match(g.line, /^M0(\.0)?,/);
  assert.ok(g.max >= 25, 'alert levels widen the scale so the line is visible');
  assert.ok(g.y(g.max) < g.y(g.min), 'higher prices are higher up');
  assert.equal(chartGeom([], { w: 100, h: 40 }).line, '');
  const up = changeParts(1.234, 0.56);
  assert.equal(up.dir, 'up');
  assert.match(up.text, /^\+1\.23 \(\+0\.56%\)$/);
  assert.equal(up.arrow, '▲');
  const down = changeParts(-2, -1.5);
  assert.equal(down.dir, 'down');
  assert.equal(down.arrow, '▼');
  assert.match(down.text, /^−2\.00 \(−1\.50%\)$/);
  assert.equal(changeParts(null, null).dir, 'flat');
  assert.equal(pollEveryMs(true, 0), 60_000);
  assert.ok(pollEveryMs(false, 0) >= 15 * 60_000, 'closed market: every 15 minutes or slower');
  assert.ok(pollEveryMs(true, 3) > pollEveryMs(true, 1), 'backs off after errors');
  assert.ok(pollEveryMs(true, 20) <= 30 * 60_000);
});

// ---------------------------------------------------------------- trackers = live watches

test('p2stocks trackers are live watches (one list): no alert, never fire, not in Watching or the limits; alerts show on their symbol', async (t) => {
  const { app, w, net, clock } = rig(t);
  const st = stocksOf(app)!;
  const added = await st.add('aapl');
  assert.equal(added.symbol, 'AAPL');
  assert.equal(added.name, 'AAPL Inc.', 'the name comes from the first quote');
  const rows = w.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'price');
  assert.equal(rows[0].when, 'track');
  assert.equal(w.todayTile(), undefined, 'trackers are not \u201ctell me when\u201d rows on Watching');
  await assert.rejects(st.add('AAPL'), /already/);
  await assert.rejects(st.add('ZZZZ'), /No price/);
  const alert = w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 150 });
  w.add({ kind: 'price', symbol: 'MSFT', when: 'below', value: 90 });
  const v = await st.view();
  assert.deepEqual(v.trackers.map((x) => x.symbol), ['AAPL', 'MSFT'], 'a symbol with only an alert is on the list too');
  assert.deepEqual(v.trackers[0].alerts.map((a) => [a.id, a.when, a.value]), [[alert.id, 'above', 150]]);
  assert.equal(v.trackers[0].price, 120);
  assert.equal(v.trackers[1].tracked, false);
  // A check pass fires alerts but never touches a tracker.
  const before = net.urls.length;
  clock.t += 120_000;
  await w.check(new Date(clock.t));
  assert.ok(net.urls.length > before);
  assert.equal(w.get(rows[0].id)!.lastCheckAt, null, 'trackers are not checked in the background');
  // Trackers do not count against the 20 active alerts.
  for (let i = 0; i < 25; i++) w.add({ kind: 'price', symbol: `T${i}`, when: 'track' });
  assert.ok(w.add({ kind: 'price', symbol: 'AAPL', when: 'below', value: 1 }));
  // Order, then remove (with the symbol's alerts).
  st.setOrder(['MSFT', 'AAPL']);
  assert.deepEqual((await st.view()).trackers.map((x) => x.symbol).slice(0, 2), ['MSFT', 'AAPL']);
  assert.equal(st.remove('AAPL'), 3, 'the tracker and its two alerts');
  assert.ok(!w.list().some((x) => x.target.symbol === 'AAPL'));
  // Trackers last: an expired tracker is renewed, not ended.
  for (let i = 0; i < 25; i++) st.remove(`T${i}`);
  const msft = await st.add('MSFT');
  const row = w.list().find((x) => x.target.symbol === 'MSFT' && x.when === 'track')!;
  app.store.db.prepare('UPDATE live_watches SET until = ? WHERE id = ?').run(new Date(T0 - 1000).toISOString(), row.id);
  clock.t += 10 * 60_000;
  await w.check(new Date(clock.t));
  assert.equal(w.get(row.id)!.state, 'active');
  assert.equal(msft.symbol, 'MSFT');
});

test('p2stocks view: cached politely, backs off on errors and keeps the last prices with their time', async (t) => {
  const { app, net, clock } = rig(t);
  const st = stocksOf(app)!;
  await st.add('AAPL');
  const a = await st.view();
  assert.equal(a.error, undefined);
  assert.equal(a.market.open, true);
  assert.ok(a.asOf, 'as of: the price time');
  const n = net.urls.length;
  await st.view();
  assert.equal(net.urls.length, n, 'a second look within a minute is served from the cache');
  net.state.down = true;
  clock.t += 2 * 60_000;
  const b = await st.view();
  assert.match(b.error!, /answer|connection/);
  assert.equal(b.trackers[0].price, 120, 'the last good price stays, marked by its time');
  assert.equal(b.stale, true);
  const m = net.urls.length;
  clock.t += 30_000;
  await st.view();
  assert.equal(net.urls.length, m, 'backing off: no new request right after a failure');
  net.state.down = false;
  clock.t += STOCKS.backoffMs[STOCKS.backoffMs.length - 1];
  const c = await st.view();
  assert.equal(c.error, undefined);
  assert.equal(c.stale, false);
});

test('p2stocks charts: ranges, cached per range, alert levels marked; search; private local mode says it cannot fetch', async (t) => {
  const { app, w, net } = rig(t);
  const st = stocksOf(app)!;
  await st.add('AAPL');
  w.add({ kind: 'price', symbol: 'AAPL', when: 'below', value: 90 });
  const c = await st.chart('AAPL', '1d');
  assert.equal(c.points.length, 4);
  assert.deepEqual(c.levels.map((l) => [l.when, l.value]), [['below', 90]]);
  assert.match(net.urls.at(-1)!, /range=1d&interval=5m/);
  await st.chart('AAPL', '1y');
  assert.match(net.urls.at(-1)!, /range=1y&interval=1d/);
  const n = net.urls.length;
  await st.chart('AAPL', '1y');
  assert.equal(net.urls.length, n);
  await assert.rejects(st.chart('AAPL', '5y' as never), /range/);
  const s = await st.search('apple');
  assert.deepEqual(s.results.map((x) => x.symbol), ['AAPL', 'APLE']);
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  const before = net.urls.length;
  const v = await st.view({ fresh: true });
  assert.equal(v.localOnly, true);
  assert.match(v.error!, /Private local mode/);
  assert.equal((await st.search('micro')).error !== undefined, true);
  assert.equal(net.urls.length, before, 'nothing leaves in private local mode');
  // Adding still works offline (no price check), so the list is ready when the mode is off.
  assert.equal((await st.add('MSFT')).symbol, 'MSFT');
});

test('p2stocks Today: a stocks part (no network), shown once for someone who already watches stocks; kids never', async (t) => {
  const { app, w, net } = rig(t);
  assert.ok((TODAY_PARTS as readonly string[]).includes('stocks'));
  const st = stocksOf(app)!;
  assert.equal(st.todayPart(), undefined, 'no watches: nothing to show');
  w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 150 });
  const n = net.urls.length;
  const p = st.todayPart()!;
  assert.equal(net.urls.length, n);
  assert.equal(p.count, 1);
  assert.equal(p.intro, true, 'already watches a stock: the tile shows itself once');
  st.markIntroduced();
  assert.equal(st.todayPart()!.intro, false);
  const kt = tempDir();
  const kid = makeApp(kt.dir, { now: new Date(T0) });
  t.after(() => {
    kid.store.close();
    kt.cleanup();
  });
  kid.member = { child: () => true } as never;
  kid.liveWatches = new LiveWatches(kid, kid.store.db);
  kid.dataSources = app.dataSources;
  assert.equal(stocksOf(kid), undefined, 'no stock trackers on a child\u2019s account');
});

test('p2stocks wiring: the tile in both lists (opt-in), its section, a closed chart dialog, strings translated', () => {
  const web = readFileSync(join(ROOT, 'web', 'today.js'), 'utf8');
  assert.match(web, /\{ id: 'td-stocks', section: 'day', sizes: \['M', 'L'\], size: 'M', hidden: true \}/);
  const s = SERVER_TILES.find((x) => x.id === 'td-stocks')!;
  assert.deepEqual([s.section, s.size, s.hidden], ['day', 'M', true]);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<section class="today-card td-tile td-stocks" id="td-stocks" hidden/);
  assert.match(html, /<dialog id="stock-chart"[^>]*>[\s\S]*?<\/dialog>/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'web', 'stock-chart.js'), 'utf8'), /^import /m, 'the pure helpers load in Node');
  assert.doesNotMatch(readFileSync(join(ROOT, 'web', 'stocks.js'), 'utf8'), /https?:\/\/(?!127|www\.w3\.org\/2000\/svg)/, 'no external chart service');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const k of ['Stocks', 'Add a stock tracker', 'as of {time}']) assert.ok(tr[k], `${lang}: ${k}`);
  }
});

test('p2stocks route: /api/data-sources/stocks lists, adds, orders, charts, searches and removes; a child gets 403', async (t) => {
  const { createSaraServer } = await import('../src/server.ts');
  const { OwnerAuth } = await import('../src/auth.ts');
  const { app } = rig(t);
  const auth = new OwnerAuth(app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '0', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise<void>((res) => server.close(() => res())));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  assert.equal((await api('POST', '/data-sources/stocks', { symbol: 'AAPL' })).status, 200);
  assert.equal((await api('POST', '/data-sources/stocks', { symbol: 'MSFT' })).status, 200);
  assert.equal((await api('POST', '/data-sources/stocks', { symbol: 'nope nope' })).status, 400);
  assert.equal((await api('PUT', '/data-sources/stocks/order', { symbols: ['MSFT', 'AAPL'] })).status, 200);
  const g = await api('GET', '/data-sources/stocks');
  assert.deepEqual(g.body.trackers.map((x: { symbol: string }) => x.symbol), ['MSFT', 'AAPL']);
  const c = await api('GET', '/data-sources/stocks/chart?symbol=AAPL&range=1w');
  assert.equal(c.status, 200);
  assert.equal(c.body.range, '1w');
  assert.equal((await api('GET', '/data-sources/stocks/search?q=app')).body.results[0].symbol, 'AAPL');
  const alert = await api('POST', '/data-sources/stocks/alert', { symbol: 'AAPL', when: 'above', value: 200 });
  assert.equal(alert.status, 200);
  assert.equal((await api('GET', '/data-sources/stocks')).body.trackers[1].alerts[0].value, 200);
  assert.equal((await api('POST', '/data-sources/stocks/intro', {})).status, 200);
  const del = await api('DELETE', '/data-sources/stocks/AAPL');
  assert.equal(del.body.removed, 2);
  app.member = { child: () => true } as never;
  assert.equal((await api('GET', '/data-sources/stocks')).status, 403);
});
