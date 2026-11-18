// V0.10 (docs/design/ROADMAP_V.md): backlog items. Trip rename in the Trips page (the route existed),
// the same document kept twice in the Library (a finder + one-tap cleanup), and stock prices from
// Nasdaq's own keyless quotes with Yahoo Finance as the fallback. No network: saved samples.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { DataSources, DEFAULT_PROVIDER, parseNasdaqWatchlist, providerInfo, type FetchLike } from '../src/data-sources.ts';
import { LibraryStore } from '../src/library/store.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const FX = join(ROOT, 'test', 'fixtures', 'e1');
const fx = (name: string) => readFileSync(join(FX, name), 'utf8');

// ---------------------------------------------------------------- trips: rename in the page

test('V0.10 trip rename: a Rename button on each trip card edits the name in place (PATCH {title}); empty = her name again', () => {
  const js = readFileSync(join(ROOT, 'web', 'trips.js'), 'utf8');
  assert.match(js, /btn\(t\('Rename'\), 'ghost small', \(\) => renameTrip\(trip, head\)\)/);
  const fn = js.slice(js.indexOf('function renameTrip('));
  assert.match(fn, /ctx\.api\(`\/trips\/\$\{trip\.id\}`, \{ method: 'PATCH', body: \{ title: input\.value \} \}\)/);
  assert.match(fn, /e\.key === 'Enter'/);
  assert.match(fn, /e\.key === 'Escape'/);
  assert.match(fn, /t\('Leave it empty to go back to the name she gave it\.'\)/);
  assert.match(fn, /aria-label', t\('Trip name'\)/);
});

// ---------------------------------------------------------------- Library: the same document twice

test('V0.10 Library duplicates: listed by the API, cleaned up in one tap (the best copy stays, its collection kept)', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-18T18:00:00Z') };
  const app = makeApp(dir, clock);
  const lib = new LibraryStore(app.store.db, dir, () => clock.now);
  app.library = lib;
  const owner = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth: owner, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: `Bearer ${owner.newToken}`, 'content-type': 'application/json' };
  const bytes = Buffer.from('# Lease\n\nRent is due on the first.');
  const a = lib.add({ name: 'lease.md', bytes, keep: true });
  const b = lib.add({ name: 'lease (1).md', bytes, keep: true });
  const c = lib.add({ name: 'lease copy.md', bytes, keep: true });
  lib.setRead(b.id, { kind: 'text', parts: [{ where: 'page 1', text: 'Rent is due on the first.' }], warnings: [] });
  lib.setCollection(c.id, 'Home');
  const other = lib.add({ name: 'other.md', bytes: Buffer.from('other'), keep: true });
  // A read-once copy in a chat is not a duplicate of the Library one.
  lib.add({ name: 'lease.md', bytes, keep: false, conversationId: null });
  assert.deepEqual(lib.duplicates(), [{ ids: [a.id, b.id, c.id], name: 'lease.md', keep: b.id }]);
  let r = await fetch(`${base}/api/library`, { headers: auth });
  const list = (await r.json()) as { duplicates: { ids: number[]; keep: number }[] };
  assert.deepEqual(list.duplicates.map((d) => d.ids), [[a.id, b.id, c.id]]);
  r = await fetch(`${base}/api/library/duplicates`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { removed: 2, groups: 1 });
  assert.ok(lib.get(b.id), 'the copy she already read stays');
  assert.equal(lib.get(a.id), undefined);
  assert.equal(lib.get(c.id), undefined);
  assert.equal(lib.get(b.id)!.collection, 'Home', 'a collection the extra copy was in moves to the one kept');
  assert.ok(lib.file(lib.get(b.id)!), 'the shared original file is still there');
  assert.ok(lib.get(other.id));
  assert.deepEqual(lib.duplicates(), []);
  // Nothing to do: still a clean answer.
  r = await fetch(`${base}/api/library/duplicates`, { method: 'POST', headers: auth, body: '{}' });
  assert.deepEqual(await r.json(), { removed: 0, groups: 0 });
  const js = readFileSync(join(ROOT, 'web', 'library.js'), 'utf8');
  assert.match(js, /t\('\{n\} documents are in the Library more than once\.', \{ n \}\)/);
  assert.match(js, /api\('\/library\/duplicates', \{ method: 'POST', body: \{\} \}\)/);
});

// ---------------------------------------------------------------- stocks: Nasdaq first, Yahoo behind it

type Route = (url: string) => { status?: number; body: string } | undefined;
function ds(route: Route, choices: Record<string, string> = {}) {
  const urls: string[] = [];
  const f: FetchLike = async (url) => {
    urls.push(url);
    const r = route(url);
    if (!r) throw new TypeError('fetch failed');
    return new Response(r.body, { status: r.status ?? 200 });
  };
  const d = new DataSources({ choices: () => choices, keys: { get: () => undefined }, fetch: f, now: () => Date.parse('2026-11-18T17:05:00Z') });
  return { d, urls };
}
const spark = (prices: Record<string, number>) => JSON.stringify({ spark: { result: Object.entries(prices).map(([s, p]) => ({ symbol: s, response: [{ meta: { symbol: s, regularMarketPrice: p, chartPreviousClose: 100, regularMarketTime: 1794584978, currency: 'USD' } }] })) } });

test('V0.10 Nasdaq sample → quotes with the exchange as the source and the trade time; unknown symbols listed', () => {
  const r = parseNasdaqWatchlist(JSON.parse(fx('nasdaq-watchlist-stocks.json')), '2026-11-18T17:05:00.000Z');
  assert.deepEqual(r.quotes.map((q) => q.symbol), ['AAPL', 'MSFT']);
  const aapl = r.quotes[0];
  assert.equal(aapl.source, 'Nasdaq');
  assert.equal(aapl.currency, 'USD');
  assert.ok(aapl.price > 100 && Number.isFinite(aapl.change) && Number.isFinite(aapl.changePct));
  assert.match(aapl.at, /^2026-11-18T1\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(r.missing, ['SPY']);
  const e = parseNasdaqWatchlist(JSON.parse(fx('nasdaq-watchlist-etf.json')), 'x');
  assert.ok(e.quotes.some((q) => q.symbol === 'SPY'));
  assert.deepEqual(parseNasdaqWatchlist({ data: null, status: { rCode: 400 } }, 'x'), { quotes: [], missing: [] });
});

test('V0.10 default source is Nasdaq (no key): stocks, then ETFs, then Yahoo Finance for what is left or when Nasdaq fails', async () => {
  assert.equal(DEFAULT_PROVIDER.quote, 'nasdaq');
  assert.equal(providerInfo('nasdaq')?.needsKey, false);
  assert.ok(providerInfo('yahoo'), 'Yahoo stays a choice');
  const etf = fx('nasdaq-watchlist-etf.json');
  const { d, urls } = ds((u) => {
    if (u.includes('api.nasdaq.com') && u.includes('%7Cetf')) return { body: etf };
    if (u.includes('api.nasdaq.com')) return { body: fx('nasdaq-watchlist-stocks.json') };
    if (u.includes('finance.yahoo.com')) return { body: spark({ 'EURUSD=X': 1.08 }) };
    return undefined;
  });
  const r = await d.quotes(['AAPL', 'MSFT', 'SPY', 'EURUSD=X']);
  assert.deepEqual(r.quotes.map((q) => `${q.symbol}:${q.source}`), ['AAPL:Nasdaq', 'MSFT:Nasdaq', 'SPY:Nasdaq', 'EURUSD=X:Yahoo Finance']);
  assert.deepEqual(r.missing, []);
  assert.equal(urls.length, 3, 'one batch per kind, then one Yahoo batch');
  assert.match(urls[0], /symbol=AAPL%7Cstocks&symbol=MSFT%7Cstocks&symbol=SPY%7Cstocks/);
  assert.ok(!urls[0].includes('EURUSD'), 'a currency pair goes to Yahoo directly');
  assert.match(urls[1], /symbol=SPY%7Cetf/);
  // Nasdaq down or refusing: Yahoo answers everything.
  const down = ds((u) => (u.includes('finance.yahoo.com') ? { body: spark({ AAPL: 110 }) } : { status: 403, body: 'denied' }));
  const r2 = await down.d.quotes(['AAPL']);
  assert.equal(r2.quotes[0].source, 'Yahoo Finance');
  // Picking Yahoo in Settings asks Yahoo only.
  const y = ds((u) => (u.includes('finance.yahoo.com') ? { body: spark({ AAPL: 110 }) } : undefined), { quote: 'yahoo' });
  await y.d.quotes(['AAPL']);
  assert.ok(y.urls.every((u) => u.includes('finance.yahoo.com')));
});
