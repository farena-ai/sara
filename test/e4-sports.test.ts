// E4 (docs/SPORTS.md): followed teams, calendar sync, briefing line, odds comparison, the bet log,
// the odds calculator and self-set limits. No network: ESPN answers are trimmed real samples saved
// on 2026-11-13 (test/fixtures/e4), the odds answer is E1's sample (test/fixtures/e1).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { plainBriefing } from '../src/briefing.ts';
import { LIVE_DATA_TOOL, OFFSERVER_TOOL } from '../src/chat.ts';
import { DataSources, findTeam, parseEspnEvents, parseEspnInjuries, parseEspnNews, parseEspnTeams, type FetchLike } from '../src/data-sources.ts';
import { DEFAULT_LEAN, eligibleFor, familyOf, FAMILY_WORDS, leanFor } from '../src/lean.ts';
import { lateInGame, LiveWatches } from '../src/live-watch.ts';
import { buildSystemPrompt, loadPersona } from '../src/persona.ts';
import { resultFromScore, statsOf, type Bet } from '../src/sports/bets.ts';
import { Sports } from '../src/sports/follow.ts';
import { americanOf, expectedValue, fairMarket, fractionalOf, kelly, parlay, parseOdds, probabilityOf } from '../src/sports/odds-math.ts';
import { createDataTools } from '../src/tools/data.ts';
import { createSportsTools, SPORTS_NET_TOOL, SPORTS_TOOL_NAMES } from '../src/tools/sports.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const FX = (dir: string, name: string) => readFileSync(join(ROOT, 'test', 'fixtures', dir, name), 'utf8');
const e4 = (name: string) => FX('e4', name);
const json = (name: string) => JSON.parse(e4(name)) as unknown;

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

/** ESPN and The Odds API from the saved samples. */
const espn = (over: { nflSchedule?: () => string; scoreboard?: () => string } = {}): Route => (u) => {
  if (/football\/nfl\/teams$/.test(u)) return { body: e4('espn-nfl-teams.json') };
  if (/baseball\/mlb\/teams$/.test(u)) return { body: e4('espn-mlb-teams.json') };
  if (/basketball\/nba\/teams$/.test(u)) return { body: e4('espn-nba-teams.json') };
  if (/football\/nfl\/teams\/12\/schedule$/.test(u)) return { body: over.nflSchedule?.() ?? e4('espn-nfl-kc-schedule.json') };
  if (/baseball\/mlb\/teams\/7\/schedule$/.test(u)) return { body: e4('espn-mlb-kc-schedule.json') };
  if (/football\/nfl\/news\?team=12/.test(u)) return { body: e4('espn-nfl-kc-news.json') };
  if (/football\/nfl\/injuries$/.test(u)) return { body: e4('espn-nfl-injuries.json') };
  if (/football\/nfl\/scoreboard/.test(u)) return { body: over.scoreboard?.() ?? FX('e1', 'espn-nfl-scoreboard.json') };
  if (/basketball\/nba\/scoreboard/.test(u)) return { body: e4('espn-nba-scoreboard.json') };
  if (u.includes('the-odds-api.com')) return { body: FX('e1', 'oddsapi-nba.json'), headers: { 'x-requests-remaining': '480', 'x-requests-used': '20' } };
  return undefined;
};

function rig(t: import('node:test').TestContext, route: Route = espn(), opts: { at?: string; tz?: string; oddsKey?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(opts.at ?? '2026-11-13T16:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: opts.tz ?? 'America/Chicago' });
  app.push = { notifyOwner: async () => {} } as never;
  const net = fakeFetch(route);
  app.dataSources = new DataSources({ choices: () => ({}), keys: { get: (n) => (opts.oddsKey !== false && n === 'data:theoddsapi' ? 'k-test' : undefined) }, fetch: net.f, now: () => clock.now.getTime() });
  app.liveWatches = new LiveWatches(app, app.store.db);
  app.sports = new Sports(app, app.store.db);
  const tools = createSportsTools(() => app);
  for (const x of tools) app.tools.add(x);
  const tool = (n: string) => tools.find((x) => x.spec.name === n)!;
  const run = (n: string, a: Record<string, unknown> = {}) => tool(n).run(a, { signal: AbortSignal.timeout(5000), conversationId: conv.id } as never);
  const conv = app.store.createConversation({ title: 'Chat' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, net, conv, run, tool, sports: app.sports };
}

// ---------------------------------------------------------------- ESPN samples

test('e4 parse: ESPN teams, team schedule (TBD times), news and injuries from saved samples', () => {
  const nfl = parseEspnTeams(json('espn-nfl-teams.json'));
  assert.equal(nfl.length, 32);
  for (const q of ['Chiefs', 'KC', 'kansas city chiefs', '12']) assert.equal(findTeam(nfl, q)?.name, 'Kansas City Chiefs', q);
  assert.equal(findTeam(parseEspnTeams(json('espn-mlb-teams.json')), 'KC')?.name, 'Kansas City Royals', 'KC in MLB is the Royals');
  assert.equal(findTeam(nfl, 'curlers'), undefined);
  const games = parseEspnEvents(json('espn-nfl-kc-schedule.json'), 'nfl');
  assert.equal(games.length, 17);
  const jets = games.find((g) => g.id === '401873045')!;
  assert.deepEqual([jets.state, jets.home.id, jets.home.score, jets.away.score, jets.winner], ['post', '12', 35, 12, 'home']);
  assert.equal(games.find((g) => g.id === '401873178')!.timeTbd, true, 'ESPN has no time yet');
  assert.equal(games.find((g) => g.id === '401873058')!.timeTbd, undefined);
  const news = parseEspnNews(json('espn-nfl-kc-news.json'));
  assert.equal(news.length, 3);
  assert.ok(news[0].headline && news[0].published && news[0].url?.startsWith('https://www.espn.com/'));
  const inj = parseEspnInjuries(json('espn-nfl-injuries.json'));
  assert.ok(inj['12'].every((x) => x.status !== 'Active'), '"Active" players are not injuries');
  assert.ok(inj['12'].some((x) => x.player === 'Jaydn Ott' && x.status === 'Questionable'));
});

test('e4 live situation: period and clock from ESPN; "late" per sport', () => {
  const board = JSON.parse(FX('e1', 'espn-nfl-scoreboard.json'));
  const c = board.events[0].competitions[0];
  c.status.type.state = 'in';
  c.status.period = 4;
  c.status.displayClock = '2:11';
  c.situation = { downDistanceText: '3rd & 7 at KC 35' };
  const g = parseEspnEvents(board, 'nfl')[0];
  assert.deepEqual([g.period, g.clock, g.situation], [4, '2:11', '3rd & 7 at KC 35']);
  assert.equal(lateInGame(g), true);
  assert.equal(lateInGame({ ...g, period: 3 }), false);
  assert.equal(lateInGame({ ...g, league: 'mlb', period: 7 }), true);
  assert.equal(lateInGame({ ...g, league: 'nhl', period: 2 }), false);
  assert.equal(lateInGame({ ...g, league: 'epl', period: 2, clock: "78'" }), true);
  assert.equal(lateInGame({ ...g, league: 'epl', period: 2, clock: "60'" }), false);
});

// ---------------------------------------------------------------- odds math

test('e4 odds math: every format, conversions, fractional, implied, no-vig and hold, EV, Kelly, parlay', () => {
  const a = parseOdds('+150');
  assert.deepEqual([a.decimal, a.american, a.fractional, a.implied], [2.5, 150, '3/2', 0.4]);
  const b = parseOdds('-110');
  assert.deepEqual([b.decimal, b.american, b.fractional], [1.9091, -110, '10/11']);
  assert.equal(parseOdds('2.50').american, 150);
  assert.equal(parseOdds('6/4').decimal, 2.5);
  assert.equal(parseOdds('evens').american, 100);
  assert.equal(parseOdds(150).decimal, 2.5, 'a bare number of 100 or more is American');
  assert.equal(parseOdds('1.5').american, -200);
  for (const bad of ['', '-50', '0.9', 'abc', '6-4']) assert.throws(() => parseOdds(bad), /price|odds/i, bad);
  assert.equal(americanOf(1.8), -125);
  assert.equal(fractionalOf(1.8), '4/5');
  assert.match(fractionalOf(2.37), /^(≈)?\d+\/\d+$/);
  // Two-way -110/-110: 50/50 fair, 4.55 % hold.
  const m = fairMarket([parseOdds('-110'), parseOdds('-110')]);
  assert.deepEqual(m.fair, [0.5, 0.5]);
  assert.equal(Math.round(m.hold * 10000) / 100, 4.55);
  // Three-way soccer market.
  const three = fairMarket([parseOdds('2.10'), parseOdds('3.40'), parseOdds('3.60')]);
  assert.equal(Math.round(three.fair.reduce((x, y) => x + y, 0) * 1e6) / 1e6, 1);
  assert.ok(three.hold > 0.03 && three.hold < 0.05);
  // EV and Kelly at +150 with a 45 % estimate: +12.5 % EV, Kelly 8.33 %, quarter 2.08 %.
  const ev = expectedValue(0.45, 2.5, 100);
  assert.deepEqual([ev.ev, ev.evPct], [12.5, 12.5]);
  const k = kelly(0.45, 2.5);
  assert.deepEqual([Math.round(k.full * 10000) / 100, Math.round(k.quarter * 10000) / 100], [8.33, 2.08]);
  assert.equal(kelly(0.3, 2.5).full, 0, 'no edge: Kelly 0');
  assert.equal(parlay([parseOdds('-110'), parseOdds('-110')]).american, 264);
  assert.equal(probabilityOf('55%'), 0.55);
  assert.equal(probabilityOf(55), 0.55);
  assert.equal(probabilityOf(0.55), 0.55);
  assert.throws(() => probabilityOf(0), /between 0 and 1/);
});

test('e4 odds_math tool: conversions, a market, EV and Kelly flagged as math; a parlay', async (t) => {
  const r = rig(t);
  const out = await r.run('odds_math', { odds: ['+150', '-180'], stake: 20, my_probability: 45 });
  assert.match(out, /\+150: American \+150 · decimal 2\.500 · fractional 3\/2 · implied 40\.00% · \$20\.00 returns \$50\.00 \(profit \$30\.00\)/);
  assert.match(out, /As one 2-way market: fair \(no-vig\) \+150 38\.36% \| -180 61\.64% · overround 4\.29% · hold 4\.11%/);
  assert.match(out, /expected value \+\$2\.50 per \$20\.00 \(\+12\.5%\) · Kelly 8\.3% of bankroll, quarter Kelly 2\.1%/);
  assert.match(out, /Kelly is math, not advice/);
  assert.match(await r.run('odds_math', { odds: ['-110', '-110', '+200'], mode: 'parlay', stake: 10 }), /Parlay of 3 legs: decimal 10\.934 · American \+993/);
  await assert.rejects(r.run('odds_math', { odds: ['nope'] }), /isn't a price/);
});

// ---------------------------------------------------------------- follows → E1 watches

test('e4 follow: resolves at ESPN, turns on E1 game watches; following again updates them; unfollow removes them', async (t) => {
  const r = rig(t);
  const out = await r.run('team_follow', { league: 'nfl', team: 'Chiefs', close_margin: 7, line_move: 1.5 });
  assert.match(out, /Following the Kansas City Chiefs \(NFL, from ESPN\)\. Alerts on: Chiefs \(NFL\) game starts; Chiefs \(NFL\) final score; Chiefs \(NFL\) close game late \(within 7\); Chiefs spread moves by 1\.5/);
  const ws = r.app.liveWatches!.list();
  assert.equal(ws.length, 4);
  assert.deepEqual(ws.map((w) => w.when), ['starts', 'final', 'close_late', 'moves_by']);
  assert.ok(ws.slice(0, 3).every((w) => w.target.team === 'id:12' && w.target.followId === 1), 'game watches match on ESPN team id');
  assert.equal(ws[3].target.market, 'spreads');
  // Again, without the extras: no duplicates, extras kept unless turned off.
  await r.run('team_follow', { league: 'nfl', team: 'KC', line_move: 0 });
  assert.deepEqual(r.app.liveWatches!.list().map((w) => w.when), ['starts', 'final', 'close_late']);
  assert.equal(r.sports.list().length, 1);
  await r.run('team_follow', { league: 'mlb', team: 'Royals' });
  assert.equal(r.sports.list().length, 2);
  assert.match(await r.run('teams_followed'), /Kansas City Chiefs \(NFL\) · next: at Falcons Nov 15, 12:00 PM CST · last: W 35-12 vs Jets · alerts: #\d+ Chiefs \(NFL\) game starts/);
  assert.match(await r.run('team_unfollow', { team: 'chiefs' }), /Stopped following the Kansas City Chiefs; 3 alert\(s\) removed/);
  assert.deepEqual(r.app.liveWatches!.list().map((w) => w.label), ['Royals (MLB) game starts', 'Royals (MLB) final score']);
  await assert.rejects(r.run('team_unfollow', { team: 'Chiefs' }), /You don't follow/);
  await assert.rejects(r.run('team_follow', { league: 'nfl', team: 'Curlers' }), /ESPN has no NFL team called "Curlers"/);
});

test('e4 follow: a line-move alert without an odds key says how to get the free key', async (t) => {
  const r = rig(t, espn(), { oddsKey: false });
  const out = await r.run('team_follow', { league: 'nfl', team: 'Chiefs', line_move: 1.5 });
  assert.match(out, /needs a free key from The Odds API \(https:\/\/the-odds-api\.com\/#get-access, 500 credits a month\)/);
});

test('e4 follow watches: a close game late fires once from the scoreboard; follow watches renew instead of ending', async (t) => {
  const board = JSON.parse(FX('e1', 'espn-nfl-scoreboard.json'));
  const ev = board.events[0];
  const c = ev.competitions[0];
  c.competitors[0].team.id = '12';
  const set = (state: string, period: number, home: string, away: string) => {
    c.status.type.state = state;
    c.status.type.shortDetail = state === 'pre' ? '1:00 PM' : `Q${period} 3:00`;
    c.status.period = period;
    c.status.displayClock = '3:00';
    c.competitors[0].score = home;
    c.competitors[1].score = away;
  };
  set('pre', 0, '0', '0');
  const r = rig(t, espn({ scoreboard: () => JSON.stringify(board) }));
  await r.run('team_follow', { league: 'nfl', team: 'Chiefs', close_margin: 3 });
  const lw = r.app.liveWatches!;
  await lw.check(r.clock.now);
  const later = async (s: number) => {
    r.clock.now = new Date(r.clock.now.getTime() + s * 1000);
    return lw.check(r.clock.now);
  };
  set('in', 3, '20', '19');
  assert.equal(await later(601), 1, 'game started (3rd quarter, close but not late: only the start)');
  set('in', 4, '20', '10');
  assert.equal(await later(61), 0, 'late but not close');
  set('in', 4, '20', '18');
  assert.equal(await later(61), 1);
  const cards = r.app.store.messages(r.conv.id).filter((m) => m.content.startsWith('livewatch:'));
  assert.match(cards.at(-1)!.content, /Close game late: .*Q4 3:00/);
  set('in', 4, '23', '21');
  assert.equal(await later(61), 0, 'once per game');
  // 31 days on: an E1 watch would end; a follow's watch is renewed.
  r.clock.now = new Date(r.clock.now.getTime() + 31 * 86_400_000);
  await lw.check(r.clock.now);
  assert.ok(lw.list().every((w) => w.state === 'active' && Date.parse(w.until) > r.clock.now.getTime()));
});

// ---------------------------------------------------------------- calendar

test('e4 schedule_to_calendar: planner entries keyed by ESPN id; again = no duplicates; a moved time is updated', async (t) => {
  let sched = e4('espn-nfl-kc-schedule.json');
  const r = rig(t, espn({ nflSchedule: () => sched }));
  await assert.rejects(r.run('schedule_to_calendar', { team: 'Chiefs' }), /Follow the team first/);
  await r.run('team_follow', { league: 'nfl', team: 'Chiefs' });
  const first = await r.run('schedule_to_calendar', { team: 'Chiefs', days: 30 });
  assert.match(first, /Chiefs games on the planner \(Games\):\n\+ Chiefs at Falcons · Nov 15, 12:00 PM CST\n\+ Chiefs vs Cardinals · Nov 22, 12:00 PM CST\n\+ Chiefs at Bills · Nov 26, 7:20 PM CST\n\+ Chiefs at Rams · Dec 3, 7:15 PM CST/);
  assert.match(first, /Source: ESPN schedule, as of/);
  const tasks = () => r.app.planner!.tasks({ status: 'all' }).filter((x) => x.project === 'Games');
  assert.equal(tasks().length, 4);
  assert.equal(Date.parse(tasks().find((x) => x.title === 'Chiefs at Bills')!.dueAt!), Date.parse('2026-11-27T01:20Z'));
  assert.match(await r.run('schedule_to_calendar', { team: 'Chiefs', days: 30 }), /nothing new for the planner \(Games\) \(4 game\(s\) already there, times unchanged\)/);
  // ESPN flexes the Bills game to Sunday afternoon.
  sched = sched.replace(/"2026-11-27T01:20Z"/g, '"2026-11-29T21:25Z"');
  r.app.dataSources = new DataSources({ choices: () => ({}), keys: { get: () => undefined }, fetch: fakeFetch(espn({ nflSchedule: () => sched })).f, now: () => r.clock.now.getTime() });
  const moved = await r.run('schedule_to_calendar', { team: 'Chiefs', days: 30 });
  assert.match(moved, /↻ Chiefs at Bills: moved from Nov 26, 7:20 PM CST to Nov 29, 3:25 PM CST/);
  assert.equal(tasks().length, 4, 'moved, not duplicated');
  // A longer window reaches a game with no time yet.
  const tbd = await r.run('schedule_to_calendar', { team: 'Chiefs', days: 60 });
  assert.match(tbd, /\+ Chiefs vs Raiders \(time TBD\) · Jan 9 \(time not set yet\)/);
});

test('e4 schedule_to_calendar: Google Calendar when asked (asks first), no duplicates, PATCH on a time change', async (t) => {
  const r = rig(t);
  await r.run('team_follow', { league: 'nfl', team: 'Chiefs' });
  const calls: { url: string; method: string; body?: Record<string, any> }[] = [];
  let n = 0;
  r.app.google = { status: () => ({ calendar: true }), api: async (url: string, init: { method?: string; body?: Record<string, any> } = {}) => (calls.push({ url, method: init.method ?? 'GET', ...(init.body ? { body: init.body } : {}) }), init.method === 'POST' ? { id: `g${++n}` } : { status: 'confirmed' }) } as never;
  assert.equal(r.tool('schedule_to_calendar').asksFirst!({ team: 'Chiefs', calendar: 'google' }), true);
  assert.equal(r.tool('schedule_to_calendar').asksFirst!({ team: 'Chiefs' }), false);
  await r.run('schedule_to_calendar', { team: 'Chiefs', days: 14, calendar: 'google' });
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 3, 'Nov 15, Nov 22 and the Nov 26 night game');
  assert.deepEqual(posts[0].body!.start, { dateTime: '2026-11-15T18:00Z', timeZone: 'America/Chicago' });
  assert.equal(posts[0].body!.extendedProperties.private.saraEspnGame, '401873058');
  await r.run('schedule_to_calendar', { team: 'Chiefs', days: 14, calendar: 'google' });
  assert.equal(calls.filter((c) => c.method === 'POST').length, 3, 'no duplicates');
  r.app.google = undefined;
  await assert.rejects(r.run('schedule_to_calendar', { team: 'Chiefs', calendar: 'google' }), /Google Calendar is not connected/);
});

// ---------------------------------------------------------------- briefing, Today, news

test('e4 briefing line and Today tile: tonight\'s game and a recent result; nothing when not following', async (t) => {
  const r = rig(t, espn(), { at: '2026-11-09T14:00:00Z' });
  assert.equal(await r.sports.briefingLine(), undefined);
  assert.equal(await r.sports.todayTile(), undefined);
  await r.run('team_follow', { league: 'nfl', team: 'Chiefs' });
  await r.run('team_follow', { league: 'mlb', team: 'Royals' });
  assert.equal(await r.sports.briefingLine(), 'Chiefs won 35-12 vs Jets (ESPN, as of 8:00 AM).');
  r.clock.now = new Date('2026-11-15T13:00:00Z');
  const line = (await r.sports.briefingLine())!;
  assert.equal(line, 'Chiefs play today 12:00 PM at Falcons (ESPN, as of 7:00 AM).');
  assert.match(plainBriefing({ date: 'Sunday', agenda: '', sports: line }), /Your teams: Chiefs play today 12:00 PM at Falcons/);
  const tile = (await r.sports.todayTile())!;
  assert.equal(tile.items.length, 2);
  assert.deepEqual([tile.items[0].team, tile.items[0].next?.opponent, tile.items[0].last?.result], ['Chiefs', 'Falcons', 'W']);
  assert.deepEqual([tile.items[1].team, tile.items[1].next?.opponent], ['Royals', 'Twins']);
  // Evening games say "tonight".
  r.clock.now = new Date('2026-11-26T15:00:00Z');
  assert.match((await r.sports.briefingLine())!, /^Chiefs play tonight 7:20 PM at Bills/);
});

test('e4 team_news: ESPN headlines and the injury report with times', async (t) => {
  const r = rig(t);
  const out = await r.run('team_news', { league: 'nfl', team: 'Chiefs' });
  assert.match(out, /Kansas City Chiefs news \(ESPN\):\n- .+ \(Nov \d+, /);
  assert.match(out, /Injury report \(ESPN, as of .*\):\n(- .+\n)*- Jaydn Ott \(RB\): Questionable/);
  assert.doesNotMatch(out, /Patrick Mahomes/, 'active players are not listed');
});

// ---------------------------------------------------------------- odds compare

test('e4 odds_compare: best price per side, no-vig fair, each book\'s hold; snapshots kept for the closing line', async (t) => {
  const r = rig(t);
  const out = await r.run('odds_compare', { sport: 'nba', team: 'Lakers' });
  assert.match(out, /Houston Rockets @ Los Angeles Lakers · starts .* · moneyline/);
  assert.match(out, /DraftKings: Houston Rockets \+120 ★best \| Los Angeles Lakers -140 · hold [\d.]+%/);
  assert.match(out, /FanDuel: Houston Rockets \+118 \| Los Angeles Lakers -138 ★best/);
  assert.match(out, /Best price: Houston Rockets \+120 \(DraftKings\) \| Los Angeles Lakers -138 \(FanDuel\) · hold at the best prices [\d.]+%/);
  assert.match(out, /Fair \(no-vig, average of 2 books\): Houston Rockets 4\d\.\d% \| Los Angeles Lakers 5\d\.\d%/);
  assert.match(out, /Source: The Odds API, as of .*\nThe Odds API credits left this month: 480\./);
  assert.match(out, /not a pick/);
  const sp = await r.run('odds_compare', { sport: 'nba', team: 'Lakers', market: 'spreads' });
  assert.match(sp, /Los Angeles Lakers -3\.5 -110 ★best/);
  const snaps = r.app.store.db.prepare('SELECT COUNT(*) AS n FROM sports_odds_snapshots').get() as { n: number };
  assert.equal(snaps.n, 4);
  // A bet on that event gets the closing price from the snapshots.
  const { bet } = r.sports.bets.add({ sport: 'nba', event: 'Rockets @ Lakers', market: 'moneyline', pick: 'Los Angeles Lakers', odds: '-130', stake: 26, oddsEventId: 'e1a2b3' });
  assert.ok(r.sports.bets.closingFor(bet)! > 1.7 && r.sports.bets.closingFor(bet)! < 1.73);
});

test('e4 odds_compare without a key says how to get the free one', async (t) => {
  const r = rig(t, espn(), { oddsKey: false });
  await assert.rejects(r.run('odds_compare', { sport: 'nfl', team: 'Chiefs' }), /needs a free key: get one at https:\/\/the-odds-api\.com/);
});

// ---------------------------------------------------------------- bet log

test('e4 bets: every odds format, profit on settle, ROI, win rate, average odds, CLV, by group', (t) => {
  const r = rig(t);
  const b = r.sports.bets;
  const w = b.add({ sport: 'nfl', event: 'Chiefs @ Bills', market: 'ml', pick: 'Chiefs', odds: '+150', stake: 20, book: 'DraftKings' }).bet;
  const l = b.add({ sport: 'nba', event: 'Rockets @ Lakers', market: 'spread', pick: 'Lakers -3.5', odds: '1.91', stake: 22, book: 'FanDuel' }).bet;
  const p = b.add({ sport: 'nfl', event: 'Jets @ Pats', market: 'total', pick: 'Over 41', odds: '10/11', stake: 11 }).bet;
  const v = b.add({ sport: 'mlb', event: 'Royals @ Twins', market: 'moneyline', pick: 'Royals', odds: 'evens', stake: 5 }).bet;
  const parl = b.add({ sport: 'nfl', event: '2-leg', market: 'parlay', pick: 'Chiefs ML + Over', legs: ['-110', '-110'], stake: 10 }).bet;
  assert.deepEqual([w.market, w.american, l.line, l.american, p.side, p.line, Math.round(parl.decimal * 1000) / 1000, parl.legs.length], ['moneyline', 150, -3.5, -110, 'over', 41, 3.645, 2]);
  assert.throws(() => b.add({ sport: 'nfl', event: 'x', market: 'teaser', pick: 'x', odds: '-110', stake: 5 }), /market is one of/);
  assert.throws(() => b.add({ sport: 'nfl', event: 'x', market: 'moneyline', pick: 'x', odds: '-110', stake: 0 }), /stake/);
  assert.equal(b.settle(w.id, 'win', { closingOdds: '+130' }).profit, 30);
  assert.equal(b.settle(l.id, 'loss').profit, -22);
  assert.equal(b.settle(p.id, 'push').profit, 0);
  assert.equal(b.settle(v.id, 'void').profit, 0);
  assert.equal(b.settle(parl.id, 'win', { payout: 36.45 }).profit, 26.45);
  const s = b.stats();
  assert.deepEqual([s.bets, s.settled, s.wins, s.losses, s.pushes, s.staked, s.profit], [5, 4, 2, 1, 1, 63, 34.45]);
  assert.equal(s.roi, 0.5468);
  assert.equal(s.winRate, 0.6667);
  assert.equal(s.clv, Math.round((2.5 / 2.3 - 1) * 10000) / 10000);
  assert.equal(s.clvBets, 1);
  b.setLimits({ bankroll: 500 });
  assert.equal(b.stats().bankroll, 534.45);
  const by = b.stats({ by: 'sport' }).groups!;
  assert.deepEqual(Object.keys(by).sort(), ['mlb', 'nba', 'nfl']);
  assert.equal(by.nfl.profit, 56.45);
  assert.equal(by.mlb.settled, 0, 'a void counts for nothing');
  assert.equal(statsOf([]).roi, null);
});

test('e4 bets: results from a final score (moneyline, spread, total, push)', () => {
  const bet = (market: Bet['market'], side: Bet['side'], line: number | null) => ({ market, side, line });
  assert.equal(resultFromScore(bet('moneyline', 'home', null), 24, 20), 'win');
  assert.equal(resultFromScore(bet('moneyline', 'away', null), 24, 20), 'loss');
  assert.equal(resultFromScore(bet('spread', 'home', -3.5), 24, 20), 'win');
  assert.equal(resultFromScore(bet('spread', 'home', -4), 24, 20), 'push');
  assert.equal(resultFromScore(bet('spread', 'away', 3.5), 24, 20), 'loss');
  assert.equal(resultFromScore(bet('total', 'over', 44.5), 24, 20), 'loss');
  assert.equal(resultFromScore(bet('total', 'under', 44), 24, 20), 'push');
  assert.equal(resultFromScore(bet('prop', 'home', null), 1, 0), undefined);
});

test('e4 bet_add links the ESPN game; bet_settle from the score is offered, then settles a final', async (t) => {
  const board = JSON.parse(FX('e1', 'espn-nfl-scoreboard.json'));
  const g = board.events[0];
  const home = g.competitions[0].competitors.find((x: any) => x.homeAway === 'home');
  home.team.id = '12';
  home.team.displayName = 'Kansas City Chiefs';
  home.team.abbreviation = 'KC';
  const state = { s: 'pre' };
  const r = rig(t, espn({ scoreboard: () => (g.competitions[0].status.type.state = state.s, JSON.stringify(board)) }));
  const add = await r.run('bet_add', { sport: 'nfl', league: 'nfl', event: 'Chiefs game', market: 'spread', pick: 'Chiefs -3.5', odds: '-110', stake: 22 });
  assert.match(add, /Logged #1 .* · spread: Chiefs -3\.5 @ -110 \(-110, 1\.91\) · stake \$22\.00 · open\. To win \$20\.00 \(implied 52\.4%\)\. Linked to ESPN game \d+ \(home\)/);
  r.clock.now = new Date(Date.parse(g.date) + 5 * 3600_000);
  assert.match(await r.run('bet_list'), /Games likely over for #1: offer to settle from the final score/);
  assert.match(await r.run('bet_settle', { id: 1, from_score: true }), /Not final yet/);
  state.s = 'post';
  const done = await r.run('bet_settle', { id: 1, from_score: true });
  const hs = Number(home.score);
  const as = Number(g.competitions[0].competitors.find((x: any) => x.homeAway === 'away').score);
  const want = hs - 3.5 > as ? 'win' : 'loss';
  assert.match(done, new RegExp(`Settled #1 .* · ${want} `));
  assert.match(done, /From the final score: .* \(ESPN\)/);
  assert.equal(r.sports.bets.get(1)!.settledBy, 'score');
  assert.match(await r.run('bet_settle', { id: 1, from_score: true }), /already settled/);
  await assert.rejects(r.run('bet_settle', { id: 9, result: 'win' }), /There is no bet #9/);
});

test('e4 limits: plain warnings on crossing, recorded on the bet, never blocking; cool-off stops odds look-ups and can only grow', async (t) => {
  const r = rig(t);
  assert.match(await r.run('bet_limits', { weekly_loss_limit: 100, max_stake: 50, bankroll: 1000 }), /Bankroll: \$1000\.00 · weekly loss limit: \$100\.00 \(last 7 days: down \$0\.00, \$0\.00 open\) · most per bet: \$50\.00 · cool-off: off/);
  const ok = await r.run('bet_add', { sport: 'nfl', event: 'A @ B', market: 'moneyline', pick: 'A', odds: '+120', stake: 40 });
  assert.doesNotMatch(ok, /Limit check|GAMBLER/, 'no help line unless a limit is crossed');
  r.sports.bets.settle(1, 'loss');
  const over = await r.run('bet_add', { sport: 'nfl', event: 'C @ D', market: 'moneyline', pick: 'C', odds: '-110', stake: 75 });
  assert.match(over, /Logged #2/);
  assert.match(over, /Limit check: This stake \(\$75\.00\) is over the most per bet you set \(\$50\.00\)\. If this and your open bets lose, the last 7 days would be down \$115\.00, past the weekly loss limit you set \(\$100\.00; down \$40\.00 so far\)\./);
  assert.match(over, /1-800-GAMBLER/);
  assert.match(r.sports.bets.get(2)!.warning!, /most per bet/);
  // Cool-off: no line look-ups (odds_compare and E1's odds_lines); the log and scores still work.
  assert.match(await r.run('bet_limits', { cool_off_days: 7 }), /cool-off: until Nov 20/);
  assert.match(await r.run('odds_compare', { sport: 'nba', team: 'Lakers' }), /cool-off until 2026-11-20, so I'm not looking up lines.*1-800-GAMBLER/);
  const oddsLines = createDataTools(() => r.app).find((x) => x.spec.name === 'odds_lines')!;
  assert.match(await oddsLines.run({ sport: 'nba' }, {} as never), /cool-off until 2026-11-20, so no lines/);
  assert.ok(!r.net.urls.some((u) => u.includes('the-odds-api')), 'no odds request during the cool-off');
  assert.match(await r.run('bet_limits', { cool_off_days: 1 }), /can be made longer, not shorter/);
  assert.match(await r.run('bet_add', { sport: 'nfl', event: 'E @ F', market: 'moneyline', pick: 'E', odds: '-110', stake: 10 }), /You set a cool-off until 2026-11-20/);
  assert.match(await r.run('odds_math', { odds: ['-110'] }), /implied 52\.38%/, 'the calculator still works');
});

// ---------------------------------------------------------------- isolation, private chats, lean, persona, i18n

test('e4 household isolation: each space has its own follows, bets and limits', async (t) => {
  const a = rig(t);
  const b = rig(t);
  await a.run('team_follow', { league: 'nfl', team: 'Chiefs' });
  a.sports.bets.add({ sport: 'nfl', event: 'x', market: 'moneyline', pick: 'x', odds: '-110', stake: 5 });
  a.sports.bets.setLimits({ coolOffDays: 3 });
  assert.equal(b.sports.list().length, 0);
  assert.equal(b.sports.bets.list().length, 0);
  assert.equal(b.sports.bets.coolingOff(), null);
  assert.equal(b.app.liveWatches!.list().length, 0);
});

test('e4 private chats and private local mode: the outside tools are off, the log and math stay', async (t) => {
  const r = rig(t);
  assert.equal(SPORTS_TOOL_NAMES.length, 12);
  for (const n of SPORTS_TOOL_NAMES) {
    assert.equal(familyOf(r.app.tools.get(n)!).id, 'sports', n);
    assert.equal(LIVE_DATA_TOOL(n), SPORTS_NET_TOOL(n), `${n}: chat.ts and tools/sports.ts agree`);
    assert.equal(OFFSERVER_TOOL(n), SPORTS_NET_TOOL(n), n);
  }
  const conv = r.app.store.createConversation({ title: 'p' });
  const names = (priv: boolean) => eligibleFor(r.app, { ...conv, private: priv }).map((x) => x.spec.name);
  assert.ok(names(false).includes('team_follow') && names(false).includes('odds_compare'));
  const priv = names(true);
  assert.ok(!priv.some((n) => SPORTS_NET_TOOL(n)), 'no outside sports tools in a private chat');
  assert.ok(priv.includes('bet_add') && priv.includes('odds_math') && priv.includes('bet_stats'));
  const { setPrivateLocal } = await import('../src/net-guard.ts');
  setPrivateLocal(true);
  try {
    assert.equal(r.tool('team_follow').isAvailable!(), false);
    assert.equal(r.tool('bet_add').isAvailable!(), true);
  } finally {
    setPrivateLocal(false);
  }
});

test('e4 lean: the words in six languages offer the sports tools', async (t) => {
  const r = rig(t);
  for (const w of ['my team', 'follow', 'game tonight', 'score', 'schedule', 'standings', 'injury', 'odds', 'line', 'spread', 'moneyline', 'over under', 'parlay', 'bet', 'wager', 'bankroll', 'roi', 'sportsbook', 'mi equipo', 'apuesta', 'mon equipe', 'pari', 'wette', 'quoten', 'aposta', 'scommessa']) assert.ok(FAMILY_WORDS.sports.includes(w), w);
  const list = SPORTS_TOOL_NAMES.map((n) => r.app.tools.get(n)!);
  const lean = { ...DEFAULT_LEAN.tools, mode: 'always' as const };
  for (const [msg, want] of [['what are the odds on the Chiefs game', 'odds_compare'], ['log my bet: Chiefs -3.5 at -110 for $22', 'bet_add'], ["what's my ROI this month", 'bet_stats'], ['follow the Royals', 'team_follow'], ['¿cuál es mi apuesta?', 'bet_list'], ['meine Wette auf Bayern', 'bet_add'], ['implied probability of +150', 'odds_math']] as const) {
    const tt = leanFor(lean, list, { text: msg, mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
    assert.ok(tt.offeredNames(list).includes(want), `${msg} → ${want}`);
  }
});

test('e4 persona: tracking and math, never picks or locks; the help line only when needed', () => {
  const p = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const base = { now: new Date('2026-11-13T12:00:00Z'), timeZone: 'UTC', ownerName: 'Alex' };
  const on = buildSystemPrompt(p, { ...base, tools: ['bet_add', 'odds_math', 'odds_compare'] } as never);
  assert.match(on, /## Sports and bets[\s\S]*never place bets[\s\S]*never call anything a lock or a sure thing[\s\S]*never link to a sportsbook[\s\S]*1-800-GAMBLER[\s\S]*During a cool-off they set, don't help find bets/);
  assert.doesNotMatch(buildSystemPrompt(p, { ...base, tools: ['todo'] } as never), /## Sports and bets/);
  const src = readFileSync(join(ROOT, 'src', 'tools', 'sports.ts'), 'utf8');
  assert.doesNotMatch(src, /https?:\/\/(?!the-odds-api|www\.espn)[a-z.]*(draftkings|fanduel|betmgm|caesars|bet365)/i, 'no sportsbook links');
});

test('e4 web: the My teams tile is registered, uses theme variables, and its strings are translated', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  assert.match(web('today.js'), /\{ id: 'td-teams', section: 'more'/);
  assert.match(web('index.html'), /id="td-teams"/);
  assert.match(web('today.css'), /\.td-teams-live \{ color: var\(--accent-solid\)/);
  const strings = ['My teams', 'Live', 'Next game', 'Last game', 'vs {team}', 'at {team}', 'time TBD', 'won {score}', 'lost {score}', 'tied {score}', 'ESPN did not answer; try again later.', 'From ESPN, {when}', 'The teams you follow: the next game, the last result and a live score, from ESPN. Shows once you follow a team.'];
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const dict = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const s of strings) assert.ok(dict[s] && dict[s] !== s, `${lang}: ${s}`);
  }
});
