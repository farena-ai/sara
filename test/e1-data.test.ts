// E1 (docs/DATA.md): live data sources, "tell me when" watches and table analysis. No network:
// every provider answer is a saved sample in test/fixtures/e1 served by a fake fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LIVE_DATA_TOOL, OFFSERVER_TOOL } from '../src/chat.ts';
import { DataError, DataSources, impliedFromAmerican, impliedFromDecimal, noVig, parseAlphaVantage, parseEspnEvents, parseEspnStandings, parseFinnhub, parseOddsApi, parseSportsDbEvents, parseStooqCsv, parseYahooSpark, type FetchLike } from '../src/data-sources.ts';
import { makeXlsx } from '../src/documents/xlsx.ts';
import { eligibleFor } from '../src/lean.ts';
import { LiveWatches, createLiveWatchTools } from '../src/live-watch.ts';
import { PrivateLocalError } from '../src/net-guard.ts';
import { interruptible } from '../src/pending.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { createAnalyzeTableTool, readTable, runQuery, tableFromGrid, toDate, toNumber } from '../src/table-query.ts';
import { createDataTools } from '../src/tools/data.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const FX = join(ROOT, 'test', 'fixtures', 'e1');
const fx = (name: string) => readFileSync(join(FX, name), 'utf8');
const json = (name: string) => JSON.parse(fx(name)) as unknown;

type Route = (url: string) => { status?: number; body: string; headers?: Record<string, string> } | undefined;
function fakeFetch(route: Route) {
  const urls: string[] = [];
  const f: FetchLike = async (url) => {
    urls.push(url);
    const r = route(url);
    if (!r) throw new TypeError('fetch failed');
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { f, urls };
}

const sparkFor = (prices: Record<string, number>) => JSON.stringify({ spark: { result: Object.entries(prices).map(([s, p]) => ({ symbol: s, response: [{ meta: { symbol: s, regularMarketPrice: p, chartPreviousClose: 100, regularMarketTime: 1794584978, currency: 'USD' } }] })) } });

function ds(route: Route, opts: { choices?: Record<string, string>; keys?: Record<string, string>; clock?: { t: number } } = {}) {
  const { f, urls } = fakeFetch(route);
  const clock = opts.clock ?? { t: Date.parse('2026-11-13T16:00:00Z') };
  const d = new DataSources({ choices: () => opts.choices ?? {}, keys: { get: (n) => opts.keys?.[n] }, fetch: f, now: () => clock.t });
  return { d, urls, clock };
}

// ---------------------------------------------------------------- parsing (saved samples)

test('e1 parse: Yahoo spark sample → quotes with source and market time', () => {
  const r = parseYahooSpark(json('yahoo-spark.json'), '2026-11-13T15:50:00.000Z');
  const aapl = r.quotes.find((q) => q.symbol === 'AAPL')!;
  assert.equal(r.quotes.length, 2);
  assert.ok(aapl.price > 0 && aapl.change !== null && aapl.changePct !== null);
  assert.equal(aapl.source, 'Yahoo Finance');
  assert.match(aapl.at, /^2026-11-13T/);
  assert.equal(aapl.name, 'Apple Inc.');
});

test('e1 parse: Stooq CSV, Finnhub and Alpha Vantage (documented formats); AV limit is a quota error', () => {
  const s = parseStooqCsv(fx('stooq-quote.csv'), '2026-11-13T00:00:00Z');
  assert.deepEqual(s.missing, ['ZZZZ']);
  assert.equal(s.quotes[0].symbol, 'AAPL');
  assert.equal(s.quotes[0].price, 354.88);
  assert.equal(s.quotes[0].at, '2026-11-12T22:00:09.000Z');
  assert.throws(() => parseStooqCsv('<html>not found</html>', 'x'), /Stooq didn't answer/);
  const f = parseFinnhub('aapl', json('finnhub-quote.json'), 'x')!;
  assert.deepEqual([f.symbol, f.price, f.change, f.changePct, f.source], ['AAPL', 359.12, 4.24, 1.19, 'Finnhub']);
  assert.equal(parseFinnhub('nope', { c: 0, d: null, dp: null, t: 0 }, 'x'), undefined);
  const a = parseAlphaVantage('MSFT', json('alphavantage-quote.json'), 'x')!;
  assert.deepEqual([a.price, a.change, a.changePct], [524.59, 1.59, 0.304]);
  assert.throws(() => parseAlphaVantage('MSFT', json('alphavantage-limit.json'), '2026-11-13T10:00:00Z'), (e: unknown) => e instanceof DataError && e.code === 'quota');
});

test('e1 parse: ESPN scoreboards, team schedule and standings (saved samples)', () => {
  const nba = parseEspnEvents(json('espn-nba-scoreboard.json'), 'nba');
  assert.equal(nba.length, 4);
  const det = nba.find((g) => g.away.abbr === 'DET')!;
  assert.deepEqual([det.state, det.away.score, det.home.score, det.winner], ['post', 144, 140, 'away']);
  const nfl = parseEspnEvents(json('espn-nfl-scoreboard.json'), 'nfl');
  assert.equal(nfl[0].state, 'post');
  assert.ok(nfl.some((g) => g.state === 'pre' && g.home.score === null), 'scheduled games have no score');
  const sched = parseEspnEvents(json('espn-nba-lal-schedule.json'), 'nba');
  assert.equal(sched.filter((g) => g.state === 'post').length, 2);
  assert.ok(sched.filter((g) => g.state === 'post').every((g) => typeof g.home.score === 'number'), 'schedule scores are {value} objects');
  const st = parseEspnStandings(json('espn-nba-standings.json'));
  assert.deepEqual(st.map((g) => g.name), ['Eastern Conference', 'Western Conference']);
  assert.deepEqual([st[0].rows[0].abbr, st[0].rows[0].wins, st[0].rows[0].losses, st[0].rows[0].pct], ['MIL', 1, 11, '.083']);
});

test('e1 parse: TheSportsDB events (saved samples, free test key)', () => {
  const last = parseSportsDbEvents(json('thesportsdb-eventslast.json'), 'epl');
  assert.equal(last[0].state, 'post');
  assert.match(last[0].name, /Arsenal/);
  const next = parseSportsDbEvents(json('thesportsdb-eventsnext.json'), 'epl');
  assert.equal(next[0].state, 'pre');
  assert.equal(next[0].home.score, null);
});

test('e1 odds math: implied probability and the no-vig (fair) probability', () => {
  assert.equal(impliedFromAmerican(100), 0.5);
  assert.equal(Math.round(impliedFromAmerican(150) * 1000), 400);
  assert.equal(Math.round(impliedFromAmerican(-200) * 1000), 667);
  assert.equal(impliedFromDecimal(2.5), 0.4);
  assert.throws(() => impliedFromAmerican(50));
  const fair = noVig([impliedFromAmerican(-110), impliedFromAmerican(-110)]);
  assert.deepEqual(fair.map((p) => Math.round(p * 1000)), [500, 500]);
  const ev = parseOddsApi(json('oddsapi-nba.json'), 'basketball_nba');
  const dk = ev[0].lines.find((l) => l.bookKey === 'draftkings' && l.market === 'h2h')!;
  assert.equal(dk.outcomes[0].implied, Math.round((100 / 220) * 10000) / 10000);
  assert.equal(Math.round((dk.outcomes[0].fair + dk.outcomes[1].fair) * 1000), 1000, 'fair probabilities add to 100 %');
  assert.ok(dk.vig > 0.03 && dk.vig < 0.05, `margin ${dk.vig}`);
  assert.equal(ev[0].lines.find((l) => l.market === 'spreads')!.outcomes[1].point, -3.5);
});

// ---------------------------------------------------------------- the service: cache, batching, errors, quota

test('e1 quotes: several symbols in one request, cached 60 s, then asked again', async () => {
  const { d, urls, clock } = ds((u) => (u.includes('finance.yahoo.com') ? { body: sparkFor({ AAPL: 110, MSFT: 95, NVDA: 100 }) } : undefined));
  const r = await d.quotes(['aapl', 'MSFT', '$NVDA']);
  assert.equal(urls.length, 1, 'one batched request');
  assert.match(urls[0], /symbols=AAPL,MSFT,NVDA/);
  assert.deepEqual(r.quotes.map((q) => q.symbol), ['AAPL', 'MSFT', 'NVDA']);
  assert.equal(r.quotes[0].changePct, 10);
  await d.quotes(['AAPL']);
  assert.equal(urls.length, 1, 'cached');
  clock.t += 61_000;
  const again = await d.quotes(['AAPL']);
  assert.equal(urls.length, 2);
  assert.equal(again.quotes[0].cached, undefined);
  await assert.rejects(d.quotes(['not a symbol!']), /isn't a ticker/);
});

test('e1 errors: a source that does not answer, a missing key, private local mode', async () => {
  const down = ds(() => undefined);
  await assert.rejects(down.d.quotes(['AAPL']), (e: unknown) => e instanceof DataError && e.code === 'no-answer' && /Yahoo Finance didn't answer/.test(e.message));
  const stooq = ds(() => ({ status: 404, body: 'nope' }), { choices: { quote: 'stooq' } });
  await assert.rejects(stooq.d.quotes(['AAPL']), /Stooq has nothing at that address/);
  const odds = ds(() => ({ body: '[]' }));
  await assert.rejects(odds.d.odds('nba'), (e: unknown) => e instanceof DataError && e.code === 'needs-key' && /needs a free key: get one at https:\/\/the-odds-api\.com.*Settings → Data sources/.test(e.message));
  assert.equal(odds.urls.length, 0, 'nothing sent without a key');
  const priv = new DataSources({ choices: () => ({}), keys: { get: () => undefined }, fetch: async () => { throw new PrivateLocalError('x'); } });
  await assert.rejects(priv.quotes(['AAPL']), (e: unknown) => e instanceof DataError && e.code === 'private-local');
  await assert.rejects(down.d.scores('curling'), /I don't know the league/);
});

test('e1 quota: The Odds API headers are read; at 0 the provider pauses without another request; 429 pauses too', async () => {
  let remaining = '2';
  const { d, urls, clock } = ds((u) => (u.includes('the-odds-api.com') ? { body: fx('oddsapi-nba.json'), headers: { 'x-requests-remaining': remaining, 'x-requests-used': '498' } } : undefined), { keys: { 'data:theoddsapi': 'k-test-123' } });
  const r = await d.odds('nba', { team: 'Lakers', markets: ['h2h', 'spreads'] });
  assert.equal(r.quota?.remaining, 2);
  assert.equal(r.source, 'The Odds API');
  assert.equal(r.at, '2026-11-13T15:41:02Z', 'time of the newest line');
  assert.match(urls[0], /markets=h2h,spreads&oddsFormat=american/);
  await d.odds('nba', { markets: ['spreads', 'h2h'] });
  assert.equal(urls.length, 1, 'cached 5 minutes (same markets in any order)');
  remaining = '0';
  clock.t += 5 * 60_000 + 1;
  await d.odds('nba', { markets: ['h2h', 'spreads'] });
  assert.ok(d.pausedUntil('theoddsapi'), 'paused until the month resets');
  clock.t += 5 * 60_000 + 1;
  await assert.rejects(d.odds('nba', { markets: ['h2h', 'spreads'] }), (e: unknown) => e instanceof DataError && e.code === 'quota');
  assert.equal(urls.length, 2, 'no request while paused');
  const busy = ds(() => ({ status: 429, body: '', headers: { 'retry-after': '120' } }));
  await assert.rejects(busy.d.quotes(['AAPL']), (e: unknown) => e instanceof DataError && e.code === 'quota');
  assert.ok(busy.d.pausedUntil('yahoo'));
});

test('e1 sports: live scores cached 30 s, others 10 min; team filter; standings from ESPN', async () => {
  const live = JSON.parse(fx('espn-nba-scoreboard.json'));
  live.events[0].competitions[0].status.type.state = 'in';
  const { d, urls, clock } = ds((u) => (u.includes('/scoreboard') ? { body: JSON.stringify(live) } : u.includes('/standings') ? { body: fx('espn-nba-standings.json') } : undefined));
  const r = await d.scores('NBA', { team: 'PHI' });
  assert.equal(r.games.length, 1);
  assert.equal(r.source, 'ESPN');
  clock.t += 31_000;
  await d.scores('nba');
  assert.equal(urls.length, 2, 'a live game is asked again after 30 s');
  const st = await d.standings('basketball');
  assert.equal(st.groups.length, 2);
  assert.match(urls.at(-1)!, /apis\/v2\/sports\/basketball\/nba\/standings/);
});

// ---------------------------------------------------------------- tools

test('e1 tools: read-only, named source and time, private chats and private local mode keep them off', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const clock = { now: new Date('2026-11-13T16:00:00Z') };
  const app = makeApp(dir, clock);
  t.after(() => app.store.close());
  app.settings.update({ timeZone: 'America/Chicago' });
  app.dataSources = new DataSources({ choices: () => ({}), keys: { get: () => undefined }, fetch: fakeFetch((u) => ({ body: u.includes('yahoo') ? fx('yahoo-spark.json') : fx('espn-nba-scoreboard.json') })).f });
  const tools = createDataTools(() => app);
  for (const tool of tools) {
    app.tools.add(tool);
    assert.ok(interruptible(tool.spec.name, tool), `${tool.spec.name} is read-only`);
    assert.ok(LIVE_DATA_TOOL(tool.spec.name) && OFFSERVER_TOOL(tool.spec.name), `${tool.spec.name} is off in private chats`);
  }
  const out = await tools.find((x) => x.spec.name === 'market_quote')!.run({ symbols: ['AAPL', 'MSFT'] }, {} as never);
  assert.match(out, /AAPL \(Apple Inc\.\): [\d.]+ USD, [+-][\d.]+ \([+-][\d.]+%\) · price at Nov 13, \d+:\d\d (AM|PM) CST from Yahoo Finance/);
  const sc = await tools.find((x) => x.spec.name === 'sports_scores')!.run({ league: 'nba', team: 'DET' }, {} as never);
  assert.match(sc, /DET 144 @ WSH 140 · Final/);
  assert.match(sc, /Source: ESPN, data as of/);
  for (const n of ['watch_add']) assert.ok(LIVE_DATA_TOOL(n));
  for (const tool of createLiveWatchTools(() => app)) app.tools.add(tool);
  const conv = app.store.createConversation({ title: 'p' });
  const priv = eligibleFor(app, { ...conv, private: true }).map((x) => x.spec.name);
  assert.ok(!priv.includes('market_quote') && !priv.includes('watch_add') && !priv.includes('odds_lines'));
  assert.ok(eligibleFor(app, conv).map((x) => x.spec.name).includes('market_quote'));
  const { setPrivateLocal } = await import('../src/net-guard.ts');
  setPrivateLocal(true);
  try {
    assert.equal(tools[0].isAvailable!(), false, 'private local mode: no live-data tools');
  } finally {
    setPrivateLocal(false);
  }
});

// ---------------------------------------------------------------- watches

function rig(t: import('node:test').TestContext, route: Route) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-13T16:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'UTC' });
  const pushes: { title: string; text: string }[] = [];
  app.push = { notifyOwner: async (title: string, text: string) => void pushes.push({ title, text }) } as never;
  const net = fakeFetch(route);
  app.dataSources = new DataSources({ choices: () => ({}), keys: { get: (n) => (n === 'data:theoddsapi' ? 'k-test' : undefined) }, fetch: net.f, now: () => clock.now.getTime() });
  const w = new LiveWatches(app, app.store.db);
  app.liveWatches = w;
  const conv = app.store.createConversation({ title: 'Chat' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const later = (sec: number) => {
    clock.now = new Date(clock.now.getTime() + sec * 1000);
    return w.check(clock.now);
  };
  const cards = () => app.store.messages(conv.id).filter((m) => m.role === 'notice' && m.content.startsWith('livewatch:'));
  return { app, w, clock, pushes, net, conv, later, cards };
}

test('e1 watches: a price crossing fires once (hysteresis), re-arms only past the band; batched quotes', async (t) => {
  let aapl = 390;
  const r = rig(t, () => ({ body: sparkFor({ AAPL: aapl, MSFT: 100, NVDA: 100 }) }));
  const a = r.w.add({ kind: 'price', symbol: 'aapl', when: 'above', value: 400, how: 'phone', conversationId: r.conv.id });
  r.w.add({ kind: 'price', symbol: 'MSFT', when: 'below', value: 50, conversationId: r.conv.id });
  r.w.add({ kind: 'price', symbol: 'NVDA', when: 'moves_pct', value: 5, how: 'chat', conversationId: r.conv.id });
  assert.equal(await r.w.check(r.clock.now), 0);
  assert.equal(r.net.urls.length, 1, 'three price watches, one request');
  aapl = 401;
  assert.equal(await r.later(61), 1);
  assert.equal(r.cards().length, 1);
  assert.match(r.cards()[0].content, /AAPL is above 400: 401 USD/);
  assert.match(r.cards()[0].content, /from Yahoo Finance/);
  assert.equal(r.pushes.length, 1);
  aapl = 399; // back under, but inside the 0.5 % band: stays disarmed
  await r.later(61);
  aapl = 402;
  assert.equal(await r.later(61), 0, 'no second alert without a real re-cross');
  aapl = 395; // past the band: re-armed
  await r.later(61);
  aapl = 405;
  assert.equal(await r.later(61), 1, 'fires again after re-crossing');
  assert.equal(r.w.get(a.id)!.fired, 2);
  assert.equal(await r.later(10), 0);
  assert.equal(r.net.urls.length, 6, 'not checked again inside the minute');
});

test('e1 watches: game starts and final from the scoreboard; one request per league', async (t) => {
  const board = JSON.parse(fx('espn-nba-scoreboard.json'));
  const phi = board.events[0];
  const setState = (state: string, detail: string) => {
    phi.competitions[0].status.type.state = state;
    phi.competitions[0].status.type.shortDetail = detail;
  };
  setState('pre', '7:00 PM');
  const r = rig(t, (u) => (u.includes('scoreboard') ? { body: JSON.stringify(board) } : undefined));
  r.w.add({ kind: 'game', league: 'nba', team: '76ers', when: 'starts', conversationId: r.conv.id });
  r.w.add({ kind: 'game', league: 'nba', team: 'PHI', when: 'final', how: 'chat', conversationId: r.conv.id });
  await r.w.check(r.clock.now);
  assert.equal(r.net.urls.length, 1);
  setState('in', '1st 10:12');
  assert.equal(await r.later(601), 1);
  assert.match(r.cards()[0].content, /has started/);
  setState('post', 'Final');
  assert.equal(await r.later(61), 1);
  assert.match(r.cards()[1].content, /Final: TOR 112 @ PHI 123.*Source: ESPN/);
  assert.equal(await r.later(61), 0, 'once per game');
});

test('e1 watches: odds line moves by X; quota reserve pauses odds watches with one notice', async (t) => {
  const odds = JSON.parse(fx('oddsapi-nba.json'));
  let remaining = '300';
  const r = rig(t, () => ({ body: JSON.stringify(odds), headers: { 'x-requests-remaining': remaining, 'x-requests-used': '200' } }));
  const w = r.w.add({ kind: 'odds', sport: 'nba', team: 'Lakers', market: 'spreads', when: 'moves_by', value: 1, conversationId: r.conv.id });
  await r.w.check(r.clock.now);
  assert.match(r.w.get(w.id)!.lastValue!, /spread -3\.5 \(median of 2 books\)/);
  for (const b of odds[0].bookmakers) b.markets[1].outcomes[1].point = -5;
  remaining = '20';
  assert.equal(await r.later(3600), 0, 'odds watches wait 2 hours between checks');
  assert.equal(await r.later(3601), 1);
  assert.match(r.cards()[0].content, /spread moved -1\.5 \(from -3\.5\)/);
  const before = r.net.urls.length;
  await r.later(7201);
  assert.equal(r.net.urls.length, before, 'reserve reached: no request');
  assert.equal(r.w.get(w.id)!.state, 'paused');
  assert.equal(r.w.get(w.id)!.reason, 'quota');
  assert.match(r.cards().at(-1)!.content, /Paused a watch .*kept the last 25 free credits/);
});

test('e1 watches: a quota error pauses price watches until it resets, then they resume', async (t) => {
  let status = 429;
  const r = rig(t, () => (status === 429 ? { status, body: '', headers: { 'retry-after': '600' } } : { body: sparkFor({ AAPL: 500 }) }));
  const w = r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 400, conversationId: r.conv.id });
  await r.w.check(r.clock.now);
  assert.equal(r.w.get(w.id)!.state, 'paused');
  assert.equal(r.cards().length, 1);
  status = 200;
  await r.later(601);
  assert.equal(r.w.get(w.id)!.state, 'active');
  assert.equal(r.cards().length, 2, 'fired after resuming');
});

test('e1 watches: ride the reminder tick (no timer of their own), end at "until", validate input', async (t) => {
  const r = rig(t, () => ({ body: sparkFor({ AAPL: 410 }) }));
  r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 400, until: '2026-11-14', conversationId: r.conv.id });
  const sched = new ReminderScheduler(r.app, r.app.planner!);
  sched.tick();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.cards().length, 1, 'the tick started the check');
  const src = readFileSync(join(ROOT, 'src', 'live-watch.ts'), 'utf8');
  assert.doesNotMatch(src, /setInterval|setTimeout\(/);
  r.clock.now = new Date('2026-11-15T00:00:00Z');
  await r.w.check(r.clock.now);
  assert.equal(r.w.list()[0].state, 'done');
  assert.throws(() => r.w.add({ kind: 'price', symbol: 'AAPL', when: 'starts' }), /"when" is one of/);
  assert.throws(() => r.w.add({ kind: 'game', league: 'curling', team: 'x', when: 'final' }), /don't know the league/);
  assert.throws(() => r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above' }), /Give the number/);
  const tools = createLiveWatchTools(() => r.app);
  const out = await tools[0].run({ kind: 'price', symbol: 'TSLA', when: 'below', value: 100 }, { conversationId: r.conv.id } as never);
  assert.match(out, /Watch #\d+ is on: TSLA below 100/);
  assert.match(await tools[1].run({}, {} as never), /TSLA below 100/);
  assert.equal(r.app.liveWatches!.todayTile()!.items.length, 1, 'Today lists the active one (the ended one is gone)');
});

test('e1 watches: household isolation — each space has its own watches', (t) => {
  const a = rig(t, () => undefined);
  const b = rig(t, () => undefined);
  a.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 1 });
  assert.equal(a.w.list().length, 1);
  assert.equal(b.w.list().length, 0);
  assert.equal(b.w.remove(a.w.list()[0].id), false);
});

// ---------------------------------------------------------------- tables

const CSV = 'Date,Category,Amount,Note\n2026-01-05,Food,"$1,200.50",groceries\n2026-01-20,Rent,1500,\n2026-02-03,Food,(20),refund\n2026-02-14,Fun,45.25,movies\n2026-03-30,Food,100,lunch\n2026-04-02,Rent,1500,\n';

test('e1 tables: numbers and dates are read the way people write them', () => {
  assert.equal(toNumber('$1,200.50'), 1200.5);
  assert.equal(toNumber('(20)'), -20);
  assert.equal(toNumber('12%'), 12);
  assert.equal(toNumber('1.234,5'), 1234.5);
  assert.equal(toNumber('abc'), null);
  assert.equal(toDate('3/5/2026'), Date.UTC(2026, 2, 5));
  assert.equal(toDate('2026-03-05'), Date.UTC(2026, 2, 5));
  assert.equal(toDate('Mar 5, 2026'), Date.UTC(2026, 2, 5));
});

test('e1 tables: group, sum, avg, count, filter by date range and text, sort, top N', () => {
  const t = readTable('budget.csv', Buffer.from(CSV));
  assert.deepEqual(t.columns, ['Date', 'Category', 'Amount', 'Note']);
  const g = runQuery(t, { groupBy: ['category'], aggregates: [{ fn: 'sum', column: 'Amount' }, { fn: 'count' }], sort: { by: 'sum of Amount', dir: 'desc' } });
  assert.deepEqual(g.columns, ['Category', 'sum of Amount', 'count']);
  assert.deepEqual(g.rows, [['Rent', 3000, 2], ['Food', 1280.5, 3], ['Fun', 45.25, 1]]);
  const q1 = runQuery(t, { filters: [{ column: 'Date', op: 'between', value: '2026-01-01', value2: '2026-03-31' }, { column: 'Category', op: '=', value: 'food' }], aggregates: [{ fn: 'avg', column: 'Amount', as: 'average' }] });
  assert.deepEqual(q1.rows, [[Math.round((1280.5 / 3) * 1e6) / 1e6]]);
  assert.equal(q1.matched, 3);
  const top = runQuery(t, { columns: ['Note', 'Amount'], filters: [{ column: 'Amount', op: '>', value: 100 }], sort: { by: 'Amount', dir: 'desc' }, limit: 2 });
  assert.deepEqual(top.rows, [['', '1500'], ['', '1500']]);
  assert.equal(top.truncated, true);
  const dates = runQuery(t, { aggregates: [{ fn: 'min', column: 'Date' }, { fn: 'max', column: 'Date' }] });
  assert.deepEqual(dates.rows, [['2026-01-05', '2026-04-02']]);
  const notes = runQuery(t, { filters: [{ column: 'note', op: 'contains', value: 'REF' }] });
  assert.equal(notes.matched, 1);
  const mixed = runQuery(t, { aggregates: [{ fn: 'sum', column: 'Note' }] });
  assert.equal(mixed.skipped.Note, 4, 'text cells are counted as left out, not guessed');
  assert.throws(() => runQuery(t, { groupBy: ['Nope'] }), /No column "Nope". Columns: Date, Category, Amount, Note/);
  assert.throws(() => tableFromGrid('x.csv', [['only one']]), /has no table/);
});

test('e1 tables: Excel through the library reader; the tool reads a library file and never runs code', async (t) => {
  const xlsx = makeXlsx({ format: 'xlsx', title: 'Sales', template: 'plain', content: '', sheets: [{ name: 'Notes', rows: [['just a note']] }, { name: 'Sales', rows: [['Region', 'Units'], ['East', 10], ['West', 5], ['East', 7]] }] });
  const tb = readTable('sales.xlsx', xlsx);
  assert.equal(tb.sheet, 'Sales', 'the first sheet with a table');
  assert.deepEqual(runQuery(tb, { groupBy: ['Region'], aggregates: [{ fn: 'sum', column: 'Units' }] }).rows, [['East', 17], ['West', 5]]);
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-13T16:00:00Z') });
  t.after(() => app.store.close());
  const docs = [{ id: 1, name: 'budget.csv', title: null, bytes: Buffer.from(CSV) }, { id: 2, name: 'sales.xlsx', title: null, bytes: xlsx }];
  app.library = { list: () => docs, file: (d: { bytes: Buffer }) => d.bytes } as never;
  const tool = createAnalyzeTableTool(() => app);
  assert.ok(interruptible('analyze_table', tool));
  const look = await tool.run({ document: 'budget' }, {} as never);
  assert.match(look, /budget\.csv: 6 rows\. Columns: Date, Category, Amount, Note/);
  const res = await tool.run({ document: 'sales', question: 'units by region', query: { groupBy: ['Region'], aggregates: [{ fn: 'sum', column: 'Units' }] } }, {} as never);
  assert.match(res, /\| East \| 17 \|/);
  assert.match(res, /Computed by analyze_table from sales\.xlsx, sheet Sales: 3 of 3 rows/);
  await assert.rejects(tool.run({ document: 'missing' }, {} as never), /No CSV or Excel file called "missing"/);
  const src = readFileSync(join(ROOT, 'src', 'table-query.ts'), 'utf8');
  assert.doesNotMatch(src, /\beval\(|new Function|child_process|sandbox-run/);
});

// ---------------------------------------------------------------- settings page, tips, i18n

test('e1 settings: the Data sources page has a tip for every control and its strings are translated', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const page = /<section class="settings-page" data-page="ab-data"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.ok(page, 'the page exists');
  for (const id of ['ds-quote', 'ds-sports', 'ds-odds', 'ds-key-finnhub', 'ds-key-alphavantage', 'ds-key-theoddsapi', 'ds-key-thesportsdb']) assert.match(page, new RegExp(`id="${id}"`));
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')).tips as Record<string, [string, string]>;
  for (const id of ['ds-quote', 'ds-sports', 'ds-odds', 'ds-keys']) {
    assert.ok(tips[id], `tip for ${id}`);
    assert.ok(tips[id][0].length <= 260);
  }
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const s of ['Data sources', 'Test', 'Watching', tips['ds-odds'][0]]) assert.ok(tr[s], `${lang}: ${s.slice(0, 40)}`);
  }
});

test('e1 route: /api/data-sources saves choices and keys (never returned), tests a source, removes a watch', async (t) => {
  const { createSaraServer } = await import('../src/server.ts');
  const { OwnerAuth } = await import('../src/auth.ts');
  const r = rig(t, (u) => (u.includes('yahoo') ? { body: sparkFor({ AAPL: 123 }) } : undefined));
  r.app.dataSources = new DataSources({ choices: () => r.app.settings.get().dataSources, keys: r.app.vault, fetch: r.net.f });
  const auth = new OwnerAuth(r.app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web'), info: { version: '0', revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise<void>((res) => server.close(() => res())));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api`;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const g = await api('GET', '/data-sources');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.kinds.map((k: { kind: string; provider: string }) => `${k.kind}:${k.provider}`), ['quote:yahoo', 'sports:espn', 'odds:theoddsapi']);
  const put = await api('PUT', '/data-sources', { providers: { odds: 'theoddsapi' }, keys: { theoddsapi: 'secret-odds-key-1' } });
  assert.equal(put.status, 200);
  assert.equal(r.app.vault.get('data:theoddsapi'), 'secret-odds-key-1');
  assert.doesNotMatch(JSON.stringify(put.body), /secret-odds-key-1/, 'the key never comes back');
  assert.equal(put.body.kinds[2].providers[0].hasKey, true);
  assert.equal((await api('PUT', '/data-sources', { providers: { quote: 'espn' } })).status, 400);
  const tst = await api('POST', '/data-sources/test', { kind: 'quote' });
  assert.equal(tst.body.ok, true);
  assert.match(tst.body.message, /AAPL 123 .* from Yahoo Finance/);
  const w = r.w.add({ kind: 'price', symbol: 'AAPL', when: 'above', value: 1 });
  assert.equal((await api('GET', '/data-sources')).body.watches.length, 1);
  assert.equal((await api('DELETE', `/data-sources/watches/${w.id}`)).status, 200);
  assert.equal(r.w.list().length, 0);
});
