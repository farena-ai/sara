// E1 (docs/DATA.md): the read-only live-data tools. market_quote, sports_scores, sports_schedule,
// sports_standings and odds_lines read free sources through src/data-sources.ts and answer with the
// source's name and the time of the data in every result; a source that doesn't answer or needs a
// key is said plainly (never a guessed number). Information only: she never trades or bets.
import type { AppContext } from '../chat.ts';
import { DataError, LEAGUES, type DataSources, type Game, type OddsEvent, type Quote } from '../data-sources.ts';
import { privateLocalOn } from '../net-guard.ts';
import { ToolError, type Tool } from './types.ts';

export const DATA_TOOL_NAMES = ['market_quote', 'sports_scores', 'sports_schedule', 'sports_standings', 'odds_lines'] as const;

/** "Nov 13, 10:49 AM CST" in the person's time zone. */
export function whenText(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

const signed = (n: number | null, d = 2): string => (n === null ? 'n/a' : `${n > 0 ? '+' : ''}${n.toFixed(d)}`);
const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;

export function quoteLine(q: Quote, tz?: string): string {
  return `${q.symbol}${q.name ? ` (${q.name})` : ''}: ${q.price}${q.currency ? ` ${q.currency}` : ''}, ${signed(q.change)} (${q.changePct === null ? 'n/a' : `${signed(q.changePct)}%`}) · price at ${whenText(q.at, tz)} from ${q.source}${q.cached ? ' (saved copy under a minute old)' : ''}`;
}

export function gameLine(g: Game, tz?: string): string {
  const score = (s: Game['home']) => `${s.abbr || s.name}${s.score !== null ? ` ${s.score}` : ''}`;
  const status = g.state === 'pre' ? `starts ${whenText(g.start, tz)}` : g.state === 'in' ? `LIVE ${g.detail}` : g.detail || 'Final';
  return `${score(g.away)} @ ${score(g.home)} · ${status}${g.home.record || g.away.record ? ` · records ${g.away.record ?? '?'} / ${g.home.record ?? '?'}` : ''}`;
}

function stamp(r: { source: string; at: string; fetchedAt: string; cached?: boolean }, tz?: string): string {
  return `Source: ${r.source}, data as of ${whenText(r.at, tz)}${r.cached ? ' (saved copy)' : ''}. Say the source and time when you answer; use only these numbers.`;
}

function oddsBlock(e: OddsEvent, tz?: string): string {
  const head = `${e.away} @ ${e.home} · starts ${whenText(e.start, tz)}`;
  const lines = e.lines.slice(0, 24).map((l) => `  ${l.book} ${l.market}: ${l.outcomes.map((o) => `${o.name}${o.point !== undefined ? ` ${signed(o.point, 1)}` : ''} ${o.price > 0 ? '+' : ''}${o.price} (implied ${pct(o.implied)}, no-vig ${pct(o.fair)})`).join(' | ')} · margin ${pct(l.vig)} · updated ${whenText(l.lastUpdate, tz)}`);
  return [head, ...lines].join('\n');
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/[\s,]+/) : []);

export function createDataTools(getApp: () => AppContext): Tool[] {
  const ds = (): DataSources => {
    const d = getApp().dataSources;
    if (!d) throw new ToolError('Live data is not available here.');
    return d;
  };
  const tz = () => getApp().settings.get().timeZone;
  const available = () => Boolean(getApp().dataSources) && !privateLocalOn();
  const wrap = async (f: () => Promise<string>): Promise<string> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof DataError) throw new ToolError(`${err.message} Tell them plainly; don't guess a number.`);
      throw err;
    }
  };
  const leagueEnum = Object.keys(LEAGUES);
  const base = { defaultPermission: 'auto' as const, interruptible: true, isAvailable: available };
  return [
    {
      ...base,
      spec: {
        name: 'market_quote',
        description: 'Current stock, ETF, index or crypto prices (read-only): price, change, % change, the time of the price and the source. Use it for any price question; never estimate or remember a price. Information only: you never trade.',
        parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Ticker symbols, e.g. ["AAPL","MSFT"]; indexes like ^GSPC; crypto like BTC-USD.' } }, required: ['symbols'], additionalProperties: false },
      },
      summarize: (a) => `Price of ${asList(a.symbols).slice(0, 6).join(', ')}`,
      run: (a) =>
        wrap(async () => {
          const r = await ds().quotes(asList(a.symbols));
          const lines = r.quotes.map((q) => quoteLine(q, tz()));
          if (r.missing.length) lines.push(`No price found for: ${r.missing.join(', ')} (check the symbol).`);
          if (!r.quotes.length) return `${lines.join('\n')}\nNo prices: say so plainly.`;
          return `${lines.join('\n')}\nUse these exact numbers with the source and time; prices may be delayed. Information only, not advice.`;
        }),
    },
    {
      ...base,
      spec: {
        name: 'sports_scores',
        description: "Scores and game status (read-only) for a league today or on a date, optionally one team: live scores, finals and start times, with the source and time. Use it instead of guessing any score.",
        parameters: { type: 'object', properties: { league: { type: 'string', enum: leagueEnum }, team: { type: 'string', description: 'Optional: team name or abbreviation (e.g. "Lakers", "LAL").' }, date: { type: 'string', description: 'Optional: YYYY-MM-DD, "yesterday" or "tomorrow". Default today.' } }, required: ['league'], additionalProperties: false },
      },
      summarize: (a) => `Scores: ${String(a.league ?? '')}${a.team ? ` ${String(a.team).slice(0, 30)}` : ''}`,
      run: (a) =>
        wrap(async () => {
          const r = await ds().scores(String(a.league ?? ''), { ...(a.team ? { team: String(a.team) } : {}), ...(a.date ? { date: String(a.date) } : {}) });
          if (!r.games.length) return `No ${LEAGUES[r.league]?.label ?? r.league} games${a.team ? ` for ${String(a.team)}` : ''} on that day. ${stamp(r, tz())}`;
          return `${r.games.slice(0, 20).map((g) => gameLine(g, tz())).join('\n')}\n${stamp(r, tz())}`;
        }),
    },
    {
      ...base,
      spec: {
        name: 'sports_schedule',
        description: "A team's upcoming games (read-only) for the next days, with start times in the person's time zone and the source.",
        parameters: { type: 'object', properties: { league: { type: 'string', enum: leagueEnum }, team: { type: 'string' }, days: { type: 'number', description: 'How many days ahead (1-60, default 14).' } }, required: ['league', 'team'], additionalProperties: false },
      },
      summarize: (a) => `Schedule: ${String(a.team ?? '').slice(0, 30)} (${String(a.league ?? '')})`,
      run: (a) =>
        wrap(async () => {
          const r = await ds().schedule(String(a.league ?? ''), String(a.team ?? ''), Number(a.days ?? 14));
          if (!r.games.length) return `No games for ${String(a.team)} in the next ${Number(a.days ?? 14)} days. ${stamp(r, tz())}`;
          return `${r.games.map((g) => gameLine(g, tz())).join('\n')}\n${stamp(r, tz())}`;
        }),
    },
    {
      ...base,
      spec: {
        name: 'sports_standings',
        description: 'League standings (read-only): wins, losses, win %, games behind, by conference or division, with the source and time.',
        parameters: { type: 'object', properties: { league: { type: 'string', enum: leagueEnum } }, required: ['league'], additionalProperties: false },
      },
      summarize: (a) => `Standings: ${String(a.league ?? '')}`,
      run: (a) =>
        wrap(async () => {
          const r = await ds().standings(String(a.league ?? ''));
          const pts = /^(soccer|hockey)\//.test(LEAGUES[r.league]?.espn ?? '');
          const body = r.groups.map((g) => `${g.name}\n${g.rows.map((x, i) => `  ${i + 1}. ${x.team} ${x.wins ?? '?'}-${x.losses ?? '?'}${x.ties ? `-${x.ties}` : ''}${x.pct ? ` (${x.pct})` : ''}${x.gamesBehind && x.gamesBehind !== '-' ? ` GB ${x.gamesBehind}` : ''}${x.seed ? ` · seed ${x.seed}` : ''}${pts && x.points !== undefined && x.points !== null ? ` · ${x.points} pts` : ''}`).join('\n')}`).join('\n');
          return `${body}\n${stamp(r, tz())}`;
        }),
    },
    {
      ...base,
      spec: {
        name: 'odds_lines',
        description: "Betting lines (read-only) from The Odds API: moneyline (h2h), spreads and totals per sportsbook, each with its implied probability and the no-vig (fair) probability, the book's margin and the update time. Math and information only: you never place bets, and you don't call a bet a sure thing.",
        parameters: {
          type: 'object',
          properties: {
            sport: { type: 'string', description: 'A league (nfl, nba, mlb, nhl, ncaaf, ncaab, epl, mls…) or an Odds API sport key.' },
            team: { type: 'string', description: 'Optional: only games with this team.' },
            event: { type: 'string', description: 'Optional: an event id from an earlier answer.' },
            markets: { type: 'array', items: { type: 'string', enum: ['h2h', 'spreads', 'totals'] }, description: 'Default ["h2h"]. Each market costs one credit of the free allowance.' },
            books: { type: 'array', items: { type: 'string' }, description: 'Optional: only these books (e.g. ["draftkings","fanduel"]).' },
          },
          required: ['sport'],
          additionalProperties: false,
        },
      },
      summarize: (a) => `Odds: ${String(a.sport ?? '')}${a.team ? ` ${String(a.team).slice(0, 30)}` : ''}`,
      run: (a) =>
        wrap(async () => {
          // E4: during a cool-off the person set, she doesn't look up lines for them.
          const cool = getApp().sports?.bets.coolingOff();
          if (cool) return `They set a cool-off until ${cool.slice(0, 10)}, so no lines until then (their own limit). Scores and schedules still work. If they ask for help: 1-800-GAMBLER (US, call or text, free and confidential).`;
          const r = await ds().odds(String(a.sport ?? ''), { markets: asList(a.markets), books: asList(a.books), ...(a.team ? { team: String(a.team) } : {}), ...(a.event ? { event: String(a.event) } : {}) });
          const quota = r.quota && r.quota.remaining !== null ? `\nThe Odds API credits left this month: ${r.quota.remaining}.` : '';
          if (!r.events.length) return `No upcoming events with odds${a.team ? ` for ${String(a.team)}` : ''}. ${stamp(r, tz())}${quota}`;
          return `${r.events.slice(0, 6).map((e) => oddsBlock(e, tz())).join('\n')}\n${stamp(r, tz())}${quota}\nImplied probability includes the book's margin; no-vig removes it. Information only, not betting advice.`;
        }),
    },
  ];
}
