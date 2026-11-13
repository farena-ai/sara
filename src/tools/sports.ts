// E4 (docs/SPORTS.md): sports and odds tools. Following teams (E1 game watches, calendar, news
// and injuries), comparing lines across books, the person's own bet log with its stats and limits,
// and an odds calculator. Information, tracking and math only: she never places a bet, never links
// to a sportsbook's sign-up offer, never calls a pick a lock. Numbers come from code and named
// sources with their time. Tools that reach outside (ESPN, The Odds API, a calendar) are off in
// private chats and in private local mode (chat.ts LIVE_DATA_TOOL); the log and the math are local.
import type { AppContext } from '../chat.ts';
import { DataError, LEAGUES, leagueOf, type BookLine, type OddsEvent } from '../data-sources.ts';
import { privateLocalOn } from '../net-guard.ts';
import { BetError, HELP_LINE, resultFromScore, type Bet, type Stats } from '../sports/bets.ts';
import { SportsError, type CalendarTarget } from '../sports/follow.ts';
import { americanText, expectedValue, fairMarket, kelly, money, OddsInputError, parlay, parseOdds, pctText, priceOf, probabilityOf } from '../sports/odds-math.ts';
import { whenText } from './data.ts';
import { ToolError, type Tool } from './types.ts';

export const SPORTS_TOOL_NAMES = ['team_follow', 'team_unfollow', 'teams_followed', 'schedule_to_calendar', 'team_news', 'odds_compare', 'odds_math', 'bet_add', 'bet_settle', 'bet_list', 'bet_stats', 'bet_limits'] as const;
/** The ones that reach outside (live data or a calendar): off in private chats. */
export const SPORTS_NET_TOOL = (name: string): boolean => /^(team_follow|schedule_to_calendar|team_news|odds_compare)$/.test(name);

const COOL_OFF = (until: string) => `You set a cool-off until ${until.slice(0, 10)}, so I'm not looking up lines or helping find bets until then. Your log, scores and schedules still work. ${HELP_LINE}`;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[,;]\s*|\s+(?=[+-]?\d)/).filter(Boolean) : v === undefined || v === null ? [] : [v]);

export function createSportsTools(getApp: () => AppContext): Tool[] {
  const sp = () => {
    const s = getApp().sports;
    if (!s) throw new ToolError('Sports tracking is not available here.');
    return s;
  };
  const tz = () => getApp().settings.get().timeZone;
  const net = () => Boolean(getApp().sports) && Boolean(getApp().dataSources) && !privateLocalOn();
  const local = () => Boolean(getApp().sports);
  const wrap = async (f: () => Promise<string> | string): Promise<string> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof DataError) throw new ToolError(`${err.message} Tell them plainly; don't guess a number.`);
      if (err instanceof SportsError || err instanceof BetError || err instanceof OddsInputError) throw new ToolError(err.message);
      throw err;
    }
  };
  const leagueEnum = Object.keys(LEAGUES);

  const betLine = (b: Bet) => `#${b.id} ${b.date} ${b.sport.toUpperCase()} · ${b.event} · ${b.market}: ${b.pick} @ ${b.odds} (${americanText(b.american)}, ${b.decimal.toFixed(2)}) · stake ${money(b.stake)}${b.book ? ` · ${b.book}` : ''} · ${b.status === 'open' ? 'open' : `${b.status} ${b.profit !== null ? (b.profit >= 0 ? `+${money(b.profit)}` : money(b.profit)) : ''}`}${b.closingDecimal ? ` · closed at ${b.closingDecimal.toFixed(2)} (CLV ${pctText(b.decimal / b.closingDecimal - 1)})` : ''}${b.warning ? ' · ⚠ limit note' : ''}`;
  const statsText = (s: Omit<Stats, 'groups'>) => `${s.bets} bets (${s.settled} settled: ${s.wins} won, ${s.losses} lost, ${s.pushes} pushed; ${s.open} open, ${money(s.openStakes)} at stake) · staked ${money(s.staked)} · profit ${s.profit >= 0 ? '+' : ''}${money(s.profit)} · ROI ${s.roi === null ? 'n/a' : pctText(s.roi)} · win rate ${s.winRate === null ? 'n/a' : pctText(s.winRate)} · average odds ${s.avgDecimal === null ? 'n/a' : `${s.avgDecimal.toFixed(2)} (${americanText(priceOf(s.avgDecimal).american)})`} · CLV ${s.clv === null ? 'n/a (no closing prices yet)' : `${pctText(s.clv)} on ${s.clvBets} bet(s)`}`;

  /** ESPN's game for a bet (date + team), to settle it from the final score later. */
  const findGame = async (league: string, date: string, team: string) => {
    const ds = getApp().dataSources;
    if (!ds || !team.trim()) return undefined;
    try {
      const r = await ds.scores(league, { date, team });
      const g = r.games[0];
      if (!g) return undefined;
      const t = await ds.team(league, team).catch(() => undefined);
      const side: 'home' | 'away' | null = t ? (g.home.id === t.id ? 'home' : g.away.id === t.id ? 'away' : null) : null;
      return { id: g.id, start: g.start, side };
    } catch {
      return undefined;
    }
  };
  const teamOfPick = (pick: string, event: string, market: string) => (market === 'total' ? event.split(/\s+(?:@|at|vs\.?|v)\s+/i)[0] : pick).replace(/\s*[+-]?\d+(\.\d+)?\s*$/, '').replace(/\b(ml|moneyline)\b/gi, '').trim();

  /** Lines compared across books: best price per outcome, average no-vig, each book's hold. */
  const compareBlock = (e: OddsEvent, market: string): { text: string; snaps: { eventId: string; market: string; outcome: string; point?: number; decimal: number; books: number; start?: string }[] } => {
    const lines = e.lines.filter((l) => l.market === market);
    if (!lines.length) return { text: `${e.away} @ ${e.home}: no ${market} lines.`, snaps: [] };
    const key = (o: { name: string; point?: number }) => `${o.name}${o.point !== undefined ? ` ${o.point > 0 ? '+' : ''}${o.point}` : ''}`;
    const best = new Map<string, { price: number; books: string[] }>();
    for (const l of lines) for (const o of l.outcomes) {
      const k = key(o);
      const d = priceOf(o.price > 0 ? 1 + o.price / 100 : 1 + 100 / -o.price).decimal;
      const cur = best.get(k);
      const curD = cur ? priceOf(cur.price > 0 ? 1 + cur.price / 100 : 1 + 100 / -cur.price).decimal : 0;
      if (!cur || d > curD + 1e-9) best.set(k, { price: o.price, books: [l.book] });
      else if (Math.abs(d - curD) < 1e-9) cur.books.push(l.book);
    }
    const names = [...new Set(lines.flatMap((l) => l.outcomes.map((o) => o.name)))];
    const fair = names.map((n) => {
      const fs = lines.map((l) => l.outcomes.find((o) => o.name === n)?.fair).filter((x): x is number => typeof x === 'number');
      return { name: n, fair: fs.length ? fs.reduce((a, b) => a + b, 0) / fs.length : null };
    });
    const hold = (l: BookLine) => 1 - 1 / (1 + l.vig);
    const rows = lines.slice(0, 15).map((l) => `  ${l.book}: ${l.outcomes.map((o) => `${key(o)} ${americanText(o.price)}${best.get(key(o))?.books.includes(l.book) ? ' ★best' : ''}`).join(' | ')} · hold ${pctText(hold(l))} · updated ${whenText(l.lastUpdate, tz())}`);
    // The market built from the best price of each side (same point), and its hold.
    const bestSides = names.map((n) => [...best.entries()].filter(([k]) => k === n || k.startsWith(`${n} `)).sort((a, b) => b[1].books.length - a[1].books.length)[0]).filter(Boolean) as [string, { price: number; books: string[] }][];
    const bestMarket = bestSides.length >= 2 ? fairMarket(bestSides.map(([, v]) => parseOdds(americanText(v.price)))) : undefined;
    const text = [
      `${e.away} @ ${e.home} · starts ${whenText(e.start, tz())} · ${market === 'h2h' ? 'moneyline' : market}`,
      ...rows,
      `  Best price: ${[...best.entries()].map(([k, v]) => `${k} ${americanText(v.price)} (${v.books.join(', ')})`).join(' | ')}${bestMarket ? ` · hold at the best prices ${pctText(bestMarket.hold)}` : ''}`,
      `  Fair (no-vig, average of ${lines.length} book${lines.length === 1 ? '' : 's'}): ${fair.map((f) => `${f.name} ${f.fair === null ? 'n/a' : pctText(f.fair)}`).join(' | ')}`,
    ].join('\n');
    const snaps = names.map((n) => {
      const ds = lines.map((l) => l.outcomes.find((o) => o.name === n)).filter(Boolean).map((o) => priceOf(o!.price > 0 ? 1 + o!.price / 100 : 1 + 100 / -o!.price).decimal).sort((a, b) => a - b);
      const pts = lines.map((l) => l.outcomes.find((o) => o.name === n)?.point).filter((x): x is number => typeof x === 'number');
      return { eventId: e.id, market, outcome: n, ...(pts.length ? { point: pts.sort((a, b) => a - b)[pts.length >> 1] } : {}), decimal: ds[ds.length >> 1], books: ds.length, start: e.start };
    });
    return { text, snaps };
  };

  return [
    {
      defaultPermission: 'auto',
      isAvailable: net,
      spec: {
        name: 'team_follow',
        description: "Follow a sports team (the person's team): she resolves it at ESPN and turns on alerts for its games (game starts and final score; optionally a close game late on, within close_margin points; optionally the point spread moving by line_move points, which needs a free odds key). Following again changes the alerts. Use for \"follow the Chiefs\", \"my team is…\", \"tell me if the Chiefs line moves 1.5 points\".",
        parameters: { type: 'object', properties: { league: { type: 'string', enum: leagueEnum }, team: { type: 'string', description: 'Team name, nickname or abbreviation (\"Chiefs\", \"KC\").' }, close_margin: { type: 'number', description: 'Optional: alert when the game is this close late on (4th quarter, last period, 7th inning). 0 turns it off.' }, line_move: { type: 'number', description: 'Optional: alert when the point spread moves this many points (The Odds API, free key). 0 turns it off.' } }, required: ['league', 'team'], additionalProperties: false },
      },
      summarize: (a) => `Follow ${String(a.team ?? '').slice(0, 30)} (${String(a.league ?? '')})`,
      run: (a, ctx) =>
        wrap(async () => {
          const r = await sp().follow({ league: String(a.league ?? ''), team: String(a.team ?? ''), ...(a.close_margin !== undefined ? { closeMargin: Number(a.close_margin) } : {}), ...(a.line_move !== undefined ? { lineMove: Number(a.line_move) } : {}), conversationId: ctx.conversationId ?? null });
          return `Following the ${r.follow.name} (${LEAGUES[r.follow.league]?.label ?? r.follow.league}, from ESPN). Alerts on: ${r.alerts.join('; ') || 'none'}.${r.notes.length ? ` ${r.notes.join(' ')}` : ''} Offer to put their games on the calendar (schedule_to_calendar). Confirm in a sentence.`;
        }),
    },
    {
      defaultPermission: 'auto',
      isAvailable: local,
      spec: { name: 'team_unfollow', description: 'Stop following a team: its game and line alerts are removed (games already on a calendar stay).', parameters: { type: 'object', properties: { team: { type: 'string' }, league: { type: 'string', enum: leagueEnum } }, required: ['team'], additionalProperties: false } },
      summarize: (a) => `Unfollow ${String(a.team ?? '').slice(0, 30)}`,
      run: (a) =>
        wrap(() => {
          const r = sp().unfollow(String(a.team ?? ''), a.league ? String(a.league) : undefined);
          return `Stopped following the ${r.follow.name}; ${r.removed} alert(s) removed. Games already on a calendar stay there.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: local,
      spec: { name: 'teams_followed', description: "The teams the person follows and each one's alerts, with the next game and last result (ESPN) when live data is on.", parameters: { type: 'object', properties: {}, additionalProperties: false } },
      summarize: () => 'Teams you follow',
      run: () =>
        wrap(async () => {
          const s = sp();
          const fs = s.list();
          if (!fs.length) return 'They follow no teams yet (team_follow).';
          const alertsById = new Map((getApp().liveWatches?.list() ?? []).map((w) => [w.id, w]));
          const st = net() ? await s.status().catch(() => undefined) : undefined;
          const lines = fs.map((f) => {
            const x = st?.items.find((i) => i.name === f.name);
            const ws = f.watchIds.map((id) => alertsById.get(id)).filter(Boolean).map((w) => `#${w!.id} ${w!.label}${w!.state !== 'active' ? ` (${w!.state})` : ''}`);
            const next = x?.next ? ` · next: ${x.next.home ? 'vs' : 'at'} ${x.next.opponent} ${x.next.tbd ? `${whenText(x.next.start, tz()).replace(/,? \d+:\d\d.*$/, '')} (time TBD)` : whenText(x.next.start, tz())}` : '';
            const last = x?.last?.result ? ` · last: ${x.last.result} ${x.last.me}-${x.last.them} ${x.last.home ? 'vs' : 'at'} ${x.last.opponent}` : '';
            const live = x?.live ? ` · LIVE ${x.live.me}-${x.live.them} ${x.live.detail}` : '';
            return `${f.name} (${LEAGUES[f.league]?.label ?? f.league})${live}${next}${last} · alerts: ${ws.join('; ') || 'none'}`;
          });
          return `${lines.join('\n')}${st ? `\nSource: ESPN, as of ${whenText(st.at, tz())}.` : ''}`;
        }),
    },
    {
      defaultPermission: 'auto',
      isAvailable: net,
      asksFirst: (a) => a.calendar === 'google' || a.calendar === 'outlook',
      spec: {
        name: 'schedule_to_calendar',
        description: "Put a followed team's upcoming games on a calendar: Sara's own planner by default (a \"Games\" list), or their Google or Outlook calendar only when the person asks for it and it's connected. Syncing again never duplicates a game and updates a changed start time.",
        parameters: { type: 'object', properties: { team: { type: 'string' }, days: { type: 'number', description: 'How many days ahead (default 30, at most 120).' }, calendar: { type: 'string', enum: ['planner', 'google', 'outlook'], description: 'Default planner.' } }, required: ['team'], additionalProperties: false },
      },
      summarize: (a) => `${String(a.team ?? '').slice(0, 30)} games → ${String(a.calendar ?? 'planner')}`,
      run: (a, ctx) =>
        wrap(async () => {
          const target = (['planner', 'google', 'outlook'].includes(String(a.calendar)) ? String(a.calendar) : 'planner') as CalendarTarget;
          const r = await sp().scheduleToCalendar(String(a.team ?? ''), { days: Number(a.days ?? 30), target, signal: ctx.signal });
          const where = target === 'planner' ? 'the planner (Games)' : target === 'google' ? 'Google Calendar' : 'the Outlook calendar';
          const added = r.added.map((x) => `+ ${x.title} · ${x.tbd ? `${whenText(x.start, tz()).replace(/,? \d+:\d\d.*$/, '')} (time not set yet)` : whenText(x.start, tz())}`);
          const moved = r.moved.map((x) => `↻ ${x.title}: moved from ${whenText(x.from, tz())} to ${whenText(x.to, tz())}`);
          if (!added.length && !moved.length) return `${r.team}: nothing new for ${where}${r.unchanged ? ` (${r.unchanged} game(s) already there, times unchanged)` : ' (no games in that window; the season may be over)'}. Source: ESPN, as of ${whenText(r.at, tz())}.`;
          return `${r.team} games on ${where}:\n${[...added, ...moved].join('\n')}${r.unchanged ? `\n${r.unchanged} already there, unchanged.` : ''}\nSource: ESPN schedule, as of ${whenText(r.at, tz())}. Syncing again updates changed times.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: net,
      spec: { name: 'team_news', description: "A team's latest news headlines and its injury report from ESPN (with times). For standings use sports_standings.", parameters: { type: 'object', properties: { league: { type: 'string', enum: leagueEnum }, team: { type: 'string' }, injuries_only: { type: 'boolean' } }, required: ['league', 'team'], additionalProperties: false } },
      summarize: (a) => `News: ${String(a.team ?? '').slice(0, 30)}`,
      run: (a) =>
        wrap(async () => {
          const ds = getApp().dataSources!;
          const league = leagueOf(a.league);
          const team = await ds.team(league, String(a.team ?? ''));
          const out: string[] = [];
          if (!a.injuries_only) {
            const n = await ds.news(league, team.id, 5);
            out.push(n.items.length ? `${team.name} news (ESPN):\n${n.items.map((x) => `- ${x.headline} (${whenText(x.published, tz())})${x.url ? ` ${x.url}` : ''}`).join('\n')}` : `ESPN has no recent ${team.name} news.`);
          }
          try {
            const inj = await ds.injuries(league, team.id);
            out.push(!inj.listed ? `ESPN has no ${LEAGUES[league].label} injury report right now.` : inj.items.length ? `Injury report (ESPN, as of ${whenText(inj.at, tz())}):\n${inj.items.slice(0, 15).map((x) => `- ${x.player}${x.position ? ` (${x.position})` : ''}: ${x.status}${x.detail ? ` · ${x.detail}` : ''}`).join('\n')}` : `No ${team.name} players on ESPN's injury report (as of ${whenText(inj.at, tz())}).`);
          } catch (err) {
            out.push(`Injury report: ${(err as Error).message}`);
          }
          return `${out.join('\n')}\nSay the source and time; headlines are information from ESPN.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: net,
      spec: {
        name: 'odds_compare',
        description: "Compare one game's lines across sportsbooks (The Odds API): each book's price with the best price marked, the fair (no-vig) probability, and each book's hold. Math and information only: never a pick, never a sure thing, never a sign-up link.",
        parameters: { type: 'object', properties: { sport: { type: 'string', description: 'A league (nfl, nba, mlb…) or an Odds API sport key.' }, team: { type: 'string', description: 'A team in the game.' }, event: { type: 'string', description: 'Or an event id from an earlier answer.' }, market: { type: 'string', enum: ['h2h', 'spreads', 'totals'], description: 'Default h2h (moneyline). One credit of the free allowance.' } }, required: ['sport'], additionalProperties: false },
      },
      summarize: (a) => `Compare odds: ${String(a.team ?? a.event ?? a.sport ?? '').slice(0, 30)}`,
      run: (a) =>
        wrap(async () => {
          const cool = sp().bets.coolingOff();
          if (cool) return COOL_OFF(cool);
          const market = ['h2h', 'spreads', 'totals'].includes(String(a.market)) ? String(a.market) : 'h2h';
          const r = await getApp().dataSources!.odds(String(a.sport ?? ''), { markets: [market], ...(a.team ? { team: String(a.team) } : {}), ...(a.event ? { event: String(a.event) } : {}) });
          if (!r.events.length) return `No upcoming games with ${market} odds${a.team ? ` for ${String(a.team)}` : ''} (The Odds API, as of ${whenText(r.at, tz())}).`;
          const blocks = r.events.slice(0, a.team || a.event ? 2 : 4).map((e) => compareBlock(e, market));
          sp().bets.snapshot(blocks.flatMap((b) => b.snaps));
          const quota = r.quota && r.quota.remaining !== null ? `\nThe Odds API credits left this month: ${r.quota.remaining}.` : '';
          return `${blocks.map((b) => b.text).join('\n')}\nSource: The Odds API, as of ${whenText(r.at, tz())}${r.cached ? ' (saved copy)' : ''}.${quota}\nHold is the book's cut; no-vig removes it. Best price is the most payout for the same side. Information and math, not a pick.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: local,
      spec: {
        name: 'odds_math',
        description: 'Odds calculator (code, exact): converts American/decimal/fractional odds, implied probability, the no-vig split and hold of a 2- or 3-way market, expected value for the person\'s own probability, the Kelly fraction (full and quarter, math not advice) and parlay odds and payout. Use it for any odds arithmetic instead of doing it yourself.',
        parameters: { type: 'object', properties: { odds: { type: 'array', items: { type: 'string' }, description: 'One or more prices: \"+150\", \"-110\", \"2.50\", \"6/4\".' }, stake: { type: 'number' }, my_probability: { type: 'number', description: 'Their own estimate for the first price, 0-1 or a percent.' }, mode: { type: 'string', enum: ['market', 'parlay'], description: 'With several prices: market (sides of one game: no-vig and hold, the default) or parlay (legs multiplied).' } }, required: ['odds'], additionalProperties: false },
      },
      summarize: (a) => `Odds math: ${list(a.odds).slice(0, 4).join(', ')}`,
      run: (a) =>
        wrap(() => {
          const prices = list(a.odds).slice(0, 12).map((x) => parseOdds(x));
          if (!prices.length) throw new OddsInputError('Give one or more prices, like +150 or 2.50.');
          const stake = a.stake === undefined || a.stake === null ? undefined : Number(a.stake);
          if (stake !== undefined && (!Number.isFinite(stake) || stake <= 0)) throw new OddsInputError('The stake is an amount above 0.');
          const out = prices.map((p) => `${p.input}: American ${americanText(p.american)} · decimal ${p.decimal.toFixed(3)} · fractional ${p.fractional} · implied ${pctText(p.implied, 2)}${stake ? ` · ${money(stake)} returns ${money(stake * p.decimal)} (profit ${money(stake * (p.decimal - 1))}) if it wins` : ''}`);
          if (prices.length >= 2 && a.mode === 'parlay') {
            const pl = parlay(prices);
            out.push(`Parlay of ${prices.length} legs: decimal ${pl.decimal.toFixed(3)} · American ${americanText(pl.american)} · implied ${pctText(pl.implied, 2)} (all legs must win; legs assumed independent)${stake ? ` · ${money(stake)} returns ${money(stake * pl.decimal)}` : ''}`);
          } else if (prices.length >= 2 && prices.length <= 3) {
            const m = fairMarket(prices);
            out.push(`As one ${prices.length}-way market: fair (no-vig) ${prices.map((p, i) => `${p.input} ${pctText(m.fair[i], 2)}`).join(' | ')} · overround ${pctText(m.overround, 2)} · hold ${pctText(m.hold, 2)}`);
          }
          if (a.my_probability !== undefined && a.my_probability !== null) {
            const p = probabilityOf(a.my_probability);
            const first = a.mode === 'parlay' && prices.length >= 2 ? parlay(prices) : prices[0];
            const ev = expectedValue(p, first.decimal, stake ?? 100);
            const k = kelly(p, first.decimal);
            out.push(`With your ${pctText(p)} for ${first.input} (break-even ${pctText(first.implied)}): expected value ${ev.ev >= 0 ? '+' : ''}${money(ev.ev)} per ${money(stake ?? 100)} (${ev.evPct >= 0 ? '+' : ''}${ev.evPct}%) · Kelly ${k.full > 0 ? `${pctText(k.full)} of bankroll, quarter Kelly ${pctText(k.quarter)}` : '0 (no edge by your number)'}.`);
            out.push('These follow from their probability, which is an estimate; Kelly is math, not advice.');
          }
          return out.join('\n');
        }),
    },
    {
      defaultPermission: 'auto',
      isAvailable: local,
      spec: {
        name: 'bet_add',
        description: "Log a bet the person already placed themselves (Sara never places bets). Odds in American, decimal or fractional. With the league she links the game at ESPN so it can be settled from the final score later. Warns plainly when a limit they set is crossed (it still logs).",
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD of the game (default today).' },
            sport: { type: 'string', description: 'nfl, nba, mlb… or any sport.' },
            event: { type: 'string', description: 'The game, e.g. \"Chiefs @ Bills\".' },
            market: { type: 'string', enum: ['moneyline', 'spread', 'total', 'prop', 'parlay'] },
            pick: { type: 'string', description: 'e.g. \"Chiefs\", \"Chiefs -3.5\", \"Over 47.5\".' },
            line: { type: 'number', description: 'Spread or total line, if not in the pick.' },
            odds: { type: 'string', description: '\"-110\", \"+150\", \"2.50\" or \"6/4\". For a parlay, its total odds or give legs.' },
            legs: { type: 'array', items: { type: 'string' }, description: 'Parlay legs\' odds (multiplied when odds is not given).' },
            stake: { type: 'number' },
            book: { type: 'string' },
            notes: { type: 'string' },
            league: { type: 'string', enum: leagueEnum, description: 'To link the ESPN game (for settling from the score).' },
            odds_event_id: { type: 'string', description: 'The Odds API event id from odds_compare (for the closing line).' },
          },
          required: ['sport', 'event', 'market', 'pick', 'stake'],
          additionalProperties: false,
        },
      },
      summarize: (a) => `Log bet: ${String(a.pick ?? '').slice(0, 30)} ${String(a.odds ?? '')} ${a.stake ?? ''}`,
      run: (a) =>
        wrap(async () => {
          const market = String(a.market ?? '').toLowerCase();
          let link: { id: string; start: string; side: 'home' | 'away' | null } | undefined;
          let league: string | null = null;
          if (a.league || LEAGUES[String(a.sport ?? '').toLowerCase()]) {
            try {
              league = leagueOf(a.league ?? a.sport);
            } catch {
              league = null;
            }
          }
          const date = a.date ? String(a.date).slice(0, 10) : getApp().now().toISOString().slice(0, 10);
          if (league && ['moneyline', 'spread', 'total'].includes(market) && net()) link = await findGame(league, date, teamOfPick(String(a.pick ?? ''), String(a.event ?? ''), market));
          const r = sp().bets.add({ ...(a.date ? { date: String(a.date) } : {}), sport: String(a.sport ?? ''), league, event: String(a.event ?? ''), market, pick: String(a.pick ?? ''), ...(a.line !== undefined ? { line: Number(a.line) } : {}), odds: a.odds, ...(Array.isArray(a.legs) ? { legs: a.legs } : {}), stake: a.stake, book: a.book ? String(a.book) : null, notes: a.notes ? String(a.notes) : null, eventId: link?.id ?? null, eventStart: link?.start ?? null, ...(link?.side && market !== 'total' ? { side: link.side } : {}), oddsEventId: a.odds_event_id ? String(a.odds_event_id) : null });
          const b = r.bet;
          const linked = b.eventId ? ` Linked to ESPN game ${b.eventId}${b.side ? ` (${b.side})` : ''}: when it's final she can settle it from the score (offer it; bet_settle with from_score).` : ' Not linked to a game, so settle it by hand when it ends.';
          const warn = r.warnings.length ? `\nLimit check: ${r.warnings.join(' ')} It's logged (it's a log); say this plainly and kindly, without lecturing. ${HELP_LINE}` : '';
          return `Logged ${betLine(b)}. To win ${money(b.stake * (b.decimal - 1))} (implied ${pctText(1 / b.decimal)}).${linked}${warn}`;
        }),
    },
    {
      defaultPermission: 'auto',
      isAvailable: local,
      spec: {
        name: 'bet_settle',
        description: 'Record how a logged bet ended: win, loss, push or void (payout optional: the whole amount returned). Or from_score: check the linked game\'s final score at ESPN (moneyline, spread, total) and settle it; offer this, don\'t do it unasked. Closing odds (optional) give the closing-line value.',
        parameters: { type: 'object', properties: { id: { type: 'number' }, result: { type: 'string', enum: ['win', 'loss', 'push', 'void'] }, payout: { type: 'number' }, closing_odds: { type: 'string' }, from_score: { type: 'boolean' } }, required: ['id'], additionalProperties: false },
      },
      summarize: (a) => `Settle bet #${String(a.id ?? '')}${a.result ? ` (${String(a.result)})` : a.from_score ? ' from the score' : ''}`,
      run: (a) =>
        wrap(async () => {
          const s = sp();
          const id = Number(a.id);
          const b = s.bets.get(id);
          if (!b) throw new BetError(`There is no bet #${String(a.id)}. Use bet_list.`);
          if (b.status !== 'open' && !a.result) return `Bet #${id} is already settled (${b.status}).`;
          let result = a.result ? (String(a.result) as Bet['status']) : undefined;
          let note = '';
          if (!result) {
            if (!a.from_score) throw new BetError('Give the result (win, loss, push, void), or from_score to check the final score.');
            if (!b.eventId || !b.league) throw new BetError(`Bet #${id} isn't linked to an ESPN game; ask how it ended.`);
            if (!net()) throw new BetError('Live data is off here (private chat or private local mode); ask how it ended.');
            if (b.market === 'prop' || b.market === 'parlay') throw new BetError('Props and parlays are settled by hand; ask how it ended.');
            const ds = getApp().dataSources!;
            const day = (off: number) => new Date(Date.parse(b.eventStart ?? b.date) + off * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            let g;
            for (const off of [0, -1, 1]) {
              g = (await ds.scores(b.league, { date: day(off), fresh: true })).games.find((x) => x.id === b.eventId);
              if (g) break;
            }
            if (!g) throw new BetError(`ESPN has no game ${b.eventId} on that day; ask how it ended.`);
            if (g.state !== 'post') return `Not final yet: ${g.away.abbr} ${g.away.score ?? ''} @ ${g.home.abbr} ${g.home.score ?? ''} · ${g.detail} (ESPN). Settle it after the game.`;
            const r = resultFromScore(b, g.home.score ?? 0, g.away.score ?? 0);
            if (!r) throw new BetError(`I can't tell how \"${b.pick}\" ended from the score; ask them.`);
            result = r;
            note = ` From the final score: ${g.away.abbr} ${g.away.score} @ ${g.home.abbr} ${g.home.score} (ESPN).`;
          }
          const closing = a.closing_odds ?? (s.bets.closingFor(b) ? String(s.bets.closingFor(b)) : undefined);
          const done = s.bets.settle(id, result as 'win', { ...(a.payout !== undefined ? { payout: Number(a.payout) } : {}), ...(closing ? { closingOdds: closing } : {}), by: a.from_score && !a.result ? 'score' : 'person' });
          const l = s.bets.limits();
          const st = s.bets.stats();
          const over = l.weeklyLossLimit !== null && s.bets.week().lost > l.weeklyLossLimit ? `\nThe last 7 days are down ${money(s.bets.week().lost)}, past the weekly loss limit they set (${money(l.weeklyLossLimit)}). Say it plainly and kindly. ${HELP_LINE}` : '';
          return `Settled ${betLine(done)}.${note}${st.bankroll !== null && st.bankroll !== undefined ? ` Bankroll now ${money(st.bankroll)}.` : ''}${over}`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: local,
      spec: { name: 'bet_list', description: "The person's logged bets (newest first): open, settled or all, with a date range.", parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'settled', 'all'] }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false } },
      summarize: () => 'Your bets',
      run: (a) =>
        wrap(() => {
          const bets = sp().bets.list({ status: (['open', 'settled', 'all'].includes(String(a.status)) ? String(a.status) : 'all') as 'all', ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}), limit: Math.min(Number(a.limit ?? 25) || 25, 100) });
          if (!bets.length) return 'No bets logged for that.';
          const now = getApp().now().getTime();
          const ready = bets.filter((b) => b.status === 'open' && b.eventId && b.eventStart && Date.parse(b.eventStart) + 3 * 3600_000 < now && ['moneyline', 'spread', 'total'].includes(b.market));
          return `${bets.map(betLine).join('\n')}${ready.length ? `\nGames likely over for ${ready.map((b) => `#${b.id}`).join(', ')}: offer to settle from the final score.` : ''}`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: local,
      spec: { name: 'bet_stats', description: "The person's betting record from their log, worked out in code: bankroll, total staked, profit, ROI, win rate, average odds and closing-line value; for a date range and by sport, market or book.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, by: { type: 'string', enum: ['sport', 'market', 'book'] } }, additionalProperties: false } },
      summarize: () => 'Your betting record',
      run: (a) =>
        wrap(() => {
          const st = sp().bets.stats({ ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}), ...(['sport', 'market', 'book'].includes(String(a.by)) ? { by: String(a.by) as 'sport' } : {}) });
          if (!st.bets) return 'No bets logged yet for that range.';
          const groups = st.groups ? Object.entries(st.groups).map(([k, g]) => `  ${k}: ${statsText(g)}`).join('\n') : '';
          const bank = st.bankroll !== null && st.bankroll !== undefined ? `Bankroll: ${money(st.bankroll)} (started at ${money(st.startingBankroll!)}).\n` : '';
          return `${bank}${statsText(st)}${groups ? `\nBy ${String(a.by)}:\n${groups}` : ''}\nFrom their own log (worked out in code). Past results don't predict future ones.`;
        }),
    },
    {
      defaultPermission: 'auto',
      isAvailable: local,
      spec: {
        name: 'bet_limits',
        description: 'Show or set the person\'s own betting limits and bankroll: a weekly loss limit, the most per bet, and cool-off days (no help finding bets until it ends; it can be made longer, not shorter). 0 turns a limit off. Call without arguments to show them.',
        parameters: { type: 'object', properties: { bankroll: { type: 'number' }, weekly_loss_limit: { type: 'number' }, max_stake: { type: 'number' }, cool_off_days: { type: 'number' } }, additionalProperties: false },
      },
      summarize: () => 'Betting limits',
      run: (a) =>
        wrap(() => {
          const b = sp().bets;
          const r = b.setLimits({ ...(a.bankroll !== undefined ? { bankroll: Number(a.bankroll) } : {}), ...(a.weekly_loss_limit !== undefined ? { weeklyLossLimit: Number(a.weekly_loss_limit) } : {}), ...(a.max_stake !== undefined ? { maxStake: Number(a.max_stake) } : {}), ...(a.cool_off_days !== undefined ? { coolOffDays: Number(a.cool_off_days) } : {}) });
          const l = r.limits;
          const w = b.week();
          return `Bankroll: ${l.bankroll === null ? 'not set' : money(l.bankroll)} · weekly loss limit: ${l.weeklyLossLimit === null ? 'off' : money(l.weeklyLossLimit)} (last 7 days: down ${money(w.lost)}, ${money(w.openStakes)} open) · most per bet: ${l.maxStake === null ? 'off' : money(l.maxStake)} · cool-off: ${l.coolOffUntil ? `until ${whenText(l.coolOffUntil, tz())}` : 'off'}.${r.note ? ` ${r.note}` : ''} These are their own limits; she warns when a bet would cross one and never blocks the log.`;
        }),
    },
  ];
}
