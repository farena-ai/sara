// E1 (docs/DATA.md): live data from free sources. One small provider interface per kind (stock
// quotes, sports, odds), free providers only (no key, or a free-tier key the person pastes in
// Settings → Data sources; keys live in this space's vault as `data:<provider>`, never in chat or
// logs). Every request goes out through net-guard's netFetch (private local mode blocks it), with
// a timeout, a cache (quotes 60 s, live scores 30 s, other sports 10 min, odds 5 min) and a quota
// record (The Odds API's own headers; Alpha Vantage's daily allowance; any 429). Every answer
// carries the source's name and the time of the data; a source that doesn't answer is said
// plainly (DataError), never guessed. Places and shopping (E2) plug in as further kinds later.
import { netFetch, isPrivateLocalError } from './net-guard.ts';

export type DataKind = 'quote' | 'sports' | 'odds';
export const DATA_KINDS: readonly DataKind[] = ['quote', 'sports', 'odds'];
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderInfo {
  id: string;
  kind: DataKind;
  label: string;
  /** A key is required (needsKey), optional (a free default works), or not used. */
  needsKey: boolean;
  keyOptional?: boolean;
  /** Where to get a free key. */
  keyUrl?: string;
  /** The free allowance, in words (English; the app translates). */
  free: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'yahoo', kind: 'quote', label: 'Yahoo Finance', needsKey: false, free: 'No key. Prices can be delayed up to 15 minutes.' },
  { id: 'stooq', kind: 'quote', label: 'Stooq', needsKey: false, free: 'No key. End-of-day and delayed prices.' },
  { id: 'finnhub', kind: 'quote', label: 'Finnhub', needsKey: true, keyUrl: 'https://finnhub.io/register', free: 'Free key: 60 requests a minute, US stocks.' },
  { id: 'alphavantage', kind: 'quote', label: 'Alpha Vantage', needsKey: true, keyUrl: 'https://www.alphavantage.co/support/#api-key', free: 'Free key: 25 requests a day.' },
  { id: 'espn', kind: 'sports', label: 'ESPN', needsKey: false, free: 'No key. Scores, schedules and standings.' },
  { id: 'thesportsdb', kind: 'sports', label: 'TheSportsDB', needsKey: false, keyOptional: true, keyUrl: 'https://www.thesportsdb.com/pricing', free: 'Free test key built in (team results and next games).' },
  { id: 'theoddsapi', kind: 'odds', label: 'The Odds API', needsKey: true, keyUrl: 'https://the-odds-api.com/#get-access', free: 'Free key: 500 credits a month (one market in one region is one credit).' },
];
export const DEFAULT_PROVIDER: Record<DataKind, string> = { quote: 'yahoo', sports: 'espn', odds: 'theoddsapi' };
export const providerInfo = (id: string): ProviderInfo | undefined => PROVIDERS.find((p) => p.id === id);
export const dataVaultKey = (provider: string): string => `data:${provider}`;

/** Cache lifetimes (ms). */
export const TTL = { quote: 60_000, scoresLive: 30_000, sports: 10 * 60_000, odds: 5 * 60_000 } as const;
const TIMEOUT_MS = 10_000;
/** TheSportsDB's public test key (the old "3" was retired in 2026). */
export const THESPORTSDB_FREE_KEY = '123';

export type DataErrorCode = 'no-answer' | 'needs-key' | 'quota' | 'not-found' | 'private-local' | 'bad-input';
export class DataError extends Error {
  readonly code: DataErrorCode;
  readonly provider: string;
  /** For 'quota': when it may be tried again (ms since epoch). */
  readonly until?: number;
  constructor(code: DataErrorCode, provider: string, message: string, until?: number) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    this.provider = provider;
    if (until !== undefined) this.until = until;
  }
}

export interface Stamp {
  /** The provider's name, for the answer ("from Yahoo Finance"). */
  source: string;
  /** When the data is from (the market's last trade, the provider's last update), ISO. */
  at: string;
  /** When Sara fetched it, ISO. */
  fetchedAt: string;
  cached?: boolean;
}
export interface Quote extends Stamp {
  symbol: string;
  name?: string;
  price: number;
  change: number | null;
  changePct: number | null;
  currency?: string;
}
export interface QuoteResult {
  quotes: Quote[];
  missing: string[];
}
export interface Side {
  abbr: string;
  name: string;
  score: number | null;
  record?: string;
  /** E4: ESPN's team id (follows match on it). */
  id?: string;
}
export type GameState = 'pre' | 'in' | 'post';
export interface Game {
  id: string;
  league: string;
  name: string;
  start: string;
  state: GameState;
  detail: string;
  home: Side;
  away: Side;
  winner?: 'home' | 'away';
  /** E4: period/quarter/inning/half and the game clock while it's on (ESPN). */
  period?: number;
  clock?: string;
  /** E4: ESPN has no start time yet ("TBD"); the date is right. */
  timeTbd?: boolean;
  /** E4: ESPN's live situation line when it has one ("3rd & 7 at KC 35"). */
  situation?: string;
}
/** E4: a team in ESPN's list for a league. */
export interface EspnTeam {
  id: string;
  abbr: string;
  name: string;
  short: string;
  names: string[];
}
export interface NewsItem {
  headline: string;
  description?: string;
  published: string;
  url?: string;
}
export interface InjuryItem {
  player: string;
  position?: string;
  status: string;
  date?: string;
  detail?: string;
  returnDate?: string;
}
export interface Games extends Stamp {
  league: string;
  games: Game[];
}
export interface StandingRow {
  team: string;
  abbr: string;
  wins: number | null;
  losses: number | null;
  ties?: number | null;
  pct: string | null;
  gamesBehind: string | null;
  seed?: number | null;
  points?: number | null;
}
export interface Standings extends Stamp {
  league: string;
  groups: { name: string; rows: StandingRow[] }[];
}
export interface Outcome {
  name: string;
  /** American odds. */
  price: number;
  point?: number;
  /** Implied probability from the price (0-1). */
  implied: number;
  /** Fair (no-vig) probability: the implied ones of this market at this book scaled to 100 %. */
  fair: number;
}
export interface BookLine {
  book: string;
  bookKey: string;
  lastUpdate: string;
  market: string;
  outcomes: Outcome[];
  /** The book's margin on this market (sum of implied minus 1). */
  vig: number;
}
export interface OddsEvent {
  id: string;
  sport: string;
  start: string;
  home: string;
  away: string;
  lines: BookLine[];
}
export interface Quota {
  remaining: number | null;
  used: number | null;
  /** When the quota was read, ISO. */
  at: string;
  /** Paused until (ISO) after the quota ran out or a 429. */
  pausedUntil?: string;
  /** Requests counted today (providers with a daily allowance). */
  today?: number;
}
export interface OddsResult extends Stamp {
  sport: string;
  events: OddsEvent[];
  quota?: Quota;
}

// ------------------------------------------------------------------ odds math

/** Implied probability (0-1) of American odds: +150 → 0.4, -200 → 0.667. */
export function impliedFromAmerican(price: number): number {
  if (!Number.isFinite(price) || price === 0 || (price > -100 && price < 100)) throw new DataError('bad-input', 'odds', `${price} isn't an American price.`);
  return price > 0 ? 100 / (price + 100) : -price / (-price + 100);
}
/** Implied probability (0-1) of decimal odds: 2.5 → 0.4. */
export function impliedFromDecimal(d: number): number {
  if (!Number.isFinite(d) || d <= 1) throw new DataError('bad-input', 'odds', `${d} isn't a decimal price.`);
  return 1 / d;
}
/** No-vig (fair) probabilities: each implied probability divided by their sum. */
export function noVig(implied: number[]): number[] {
  const sum = implied.reduce((a, b) => a + b, 0);
  return sum > 0 ? implied.map((p) => p / sum) : implied.map(() => 0);
}

// ------------------------------------------------------------------ leagues

/** League words → ESPN's sport/league path and The Odds API's sport key. */
export const LEAGUES: Record<string, { espn: string; odds?: string; label: string; tsdb?: string }> = {
  nfl: { espn: 'football/nfl', odds: 'americanfootball_nfl', label: 'NFL', tsdb: 'NFL' },
  nba: { espn: 'basketball/nba', odds: 'basketball_nba', label: 'NBA', tsdb: 'NBA' },
  wnba: { espn: 'basketball/wnba', odds: 'basketball_wnba', label: 'WNBA', tsdb: 'WNBA' },
  mlb: { espn: 'baseball/mlb', odds: 'baseball_mlb', label: 'MLB', tsdb: 'MLB' },
  nhl: { espn: 'hockey/nhl', odds: 'icehockey_nhl', label: 'NHL', tsdb: 'NHL' },
  ncaaf: { espn: 'football/college-football', odds: 'americanfootball_ncaaf', label: 'College football' },
  ncaab: { espn: 'basketball/mens-college-basketball', odds: 'basketball_ncaab', label: "Men's college basketball" },
  mls: { espn: 'soccer/usa.1', odds: 'soccer_usa_mls', label: 'MLS', tsdb: 'American Major League Soccer' },
  epl: { espn: 'soccer/eng.1', odds: 'soccer_epl', label: 'Premier League', tsdb: 'English Premier League' },
  laliga: { espn: 'soccer/esp.1', odds: 'soccer_spain_la_liga', label: 'La Liga', tsdb: 'Spanish La Liga' },
  bundesliga: { espn: 'soccer/ger.1', odds: 'soccer_germany_bundesliga', label: 'Bundesliga', tsdb: 'German Bundesliga' },
  seriea: { espn: 'soccer/ita.1', odds: 'soccer_italy_serie_a', label: 'Serie A', tsdb: 'Italian Serie A' },
  ligue1: { espn: 'soccer/fra.1', odds: 'soccer_france_ligue_one', label: 'Ligue 1', tsdb: 'French Ligue 1' },
  ucl: { espn: 'soccer/uefa.champions', odds: 'soccer_uefa_champs_league', label: 'Champions League' },
};
const LEAGUE_WORDS: Record<string, string> = { football: 'nfl', 'premier league': 'epl', 'english premier league': 'epl', 'college football': 'ncaaf', 'college basketball': 'ncaab', 'champions league': 'ucl', 'la liga': 'laliga', 'serie a': 'seriea', 'ligue 1': 'ligue1', basketball: 'nba', baseball: 'mlb', hockey: 'nhl' };
export function leagueOf(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  const key = LEAGUES[s] ? s : LEAGUE_WORDS[s] ?? s.replace(/[\s_-]+/g, '');
  if (!LEAGUES[key]) throw new DataError('bad-input', 'sports', `I don't know the league "${String(raw ?? '').slice(0, 40)}". Leagues: ${Object.keys(LEAGUES).join(', ')}.`);
  return key;
}

// ------------------------------------------------------------------ parsing (pure; tested on saved samples)

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === 'N/D') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%+\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

/** Yahoo Finance spark (several symbols in one request). */
export function parseYahooSpark(json: unknown, fetchedAt: string): QuoteResult {
  const res = (json as { spark?: { result?: { symbol: string; response?: { meta?: Record<string, unknown> }[] }[] } })?.spark?.result ?? [];
  const quotes: Quote[] = [];
  for (const r of res) {
    const m = r.response?.[0]?.meta;
    const price = num(m?.regularMarketPrice);
    if (!m || price === null) continue;
    const prev = num(m.chartPreviousClose) ?? num(m.previousClose);
    const change = prev !== null ? round(price - prev, 4) : null;
    const t = num(m.regularMarketTime);
    quotes.push({ symbol: String(m.symbol ?? r.symbol).toUpperCase(), ...(typeof m.longName === 'string' || typeof m.shortName === 'string' ? { name: String(m.longName ?? m.shortName) } : {}), price, change: change === null ? null : round(change), changePct: prev ? round(((price - prev) / prev) * 100) : null, ...(typeof m.currency === 'string' ? { currency: m.currency } : {}), source: 'Yahoo Finance', at: t ? new Date(t * 1000).toISOString() : fetchedAt, fetchedAt });
  }
  return { quotes, missing: [] };
}

/** Stooq's quote CSV (Symbol,Date,Time,Open,High,Low,Close,Volume). Change is from the day's open (Stooq gives no previous close here). */
export function parseStooqCsv(csv: string, fetchedAt: string): QuoteResult {
  const lines = csv.trim().split(/\r?\n/);
  if (!/^symbol,/i.test(lines[0] ?? '')) throw new DataError('no-answer', 'stooq', "Stooq didn't answer with prices.");
  const head = lines[0].toLowerCase().split(',');
  const col = (name: string) => head.indexOf(name);
  const quotes: Quote[] = [];
  const missing: string[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const sym = (c[col('symbol')] ?? '').replace(/\.US$/i, '').toUpperCase();
    const close = num(c[col('close')]);
    if (!sym) continue;
    if (close === null) {
      missing.push(sym);
      continue;
    }
    const open = num(c[col('open')]);
    const date = c[col('date')];
    const time = c[col('time')];
    const at = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T${/^\d{2}:\d{2}:\d{2}$/.test(time ?? '') ? time : '00:00:00'}Z`).toISOString() : fetchedAt;
    quotes.push({ symbol: sym, price: close, change: open !== null ? round(close - open) : null, changePct: open ? round(((close - open) / open) * 100) : null, source: 'Stooq', at, fetchedAt });
  }
  return { quotes, missing };
}

/** Finnhub /quote: {c, d, dp, t}. */
export function parseFinnhub(symbol: string, json: unknown, fetchedAt: string): Quote | undefined {
  const j = json as { c?: number; d?: number | null; dp?: number | null; t?: number };
  if (!j || !j.c) return undefined; // Finnhub answers zeros for an unknown symbol
  return { symbol: symbol.toUpperCase(), price: j.c, change: j.d ?? null, changePct: j.dp === null || j.dp === undefined ? null : round(j.dp), source: 'Finnhub', at: j.t ? new Date(j.t * 1000).toISOString() : fetchedAt, fetchedAt };
}

/** Alpha Vantage GLOBAL_QUOTE (a "Note"/"Information" answer means the free allowance is used up). */
export function parseAlphaVantage(symbol: string, json: unknown, fetchedAt: string): Quote | undefined {
  const j = json as Record<string, unknown>;
  if (j && (typeof j.Note === 'string' || typeof j.Information === 'string')) throw new DataError('quota', 'alphavantage', "Alpha Vantage's free allowance for today is used up (25 requests a day).", nextUtcDay(Date.parse(fetchedAt)));
  const q = j?.['Global Quote'] as Record<string, string> | undefined;
  const price = num(q?.['05. price']);
  if (!q || price === null) return undefined;
  const day = q['07. latest trading day'];
  return { symbol: (q['01. symbol'] ?? symbol).toUpperCase(), price, change: num(q['09. change']), changePct: num(q['10. change percent']), source: 'Alpha Vantage', at: day ? new Date(`${day}T21:00:00Z`).toISOString() : fetchedAt, fetchedAt };
}

const scoreOf = (s: unknown): number | null => (s && typeof s === 'object' ? num((s as { value?: unknown }).value) : num(s));

/** ESPN scoreboard or team schedule events → games. */
export function parseEspnEvents(json: unknown, league: string): Game[] {
  const events = (json as { events?: unknown[] })?.events ?? [];
  const games: Game[] = [];
  for (const e of events as Record<string, any>[]) {
    const c = e.competitions?.[0];
    if (!c) continue;
    const st = (c.status ?? e.status)?.type ?? {};
    const state: GameState = st.state === 'in' ? 'in' : st.state === 'post' ? 'post' : 'pre';
    const side = (ha: string): Side => {
      const x = (c.competitors ?? []).find((k: any) => k.homeAway === ha) ?? {};
      const rec = x.records?.[0]?.summary ?? x.record?.[0]?.displayValue;
      return { abbr: String(x.team?.abbreviation ?? ''), name: String(x.team?.displayName ?? x.team?.name ?? ''), score: state === 'pre' ? null : scoreOf(x.score), ...(rec ? { record: String(rec) } : {}), ...(x.team?.id !== undefined ? { id: String(x.team.id) } : x.id !== undefined ? { id: String(x.id) } : {}) };
    };
    const home = side('home');
    const away = side('away');
    const winSide = (c.competitors ?? []).find((k: any) => k.winner === true)?.homeAway;
    const status = c.status ?? e.status ?? {};
    const period = num(status.period);
    const sit = c.situation?.downDistanceText ?? c.situation?.shortDownDistanceText ?? c.situation?.lastPlay?.text;
    games.push({ id: String(e.id), league, name: String(e.shortName ?? e.name ?? `${away.abbr} @ ${home.abbr}`), start: String(c.date ?? e.date), state, detail: String(st.shortDetail ?? st.detail ?? st.description ?? ''), home, away, ...(state === 'post' && (winSide === 'home' || winSide === 'away') ? { winner: winSide } : {}), ...(state === 'in' && period !== null ? { period } : {}), ...(state === 'in' && status.displayClock ? { clock: String(status.displayClock) } : {}), ...(c.timeValid === false || (state === 'pre' && /\bTBD\b/.test(String(st.shortDetail ?? ''))) ? { timeTbd: true } : {}), ...(state === 'in' && typeof sit === 'string' && sit ? { situation: sit.slice(0, 120) } : {}) });
  }
  return games;
}

/** ESPN standings (conferences/divisions as children). */
export function parseEspnStandings(json: unknown): { name: string; rows: StandingRow[] }[] {
  const j = json as Record<string, any>;
  const groups: { name: string; rows: StandingRow[] }[] = [];
  const walk = (node: Record<string, any>) => {
    if (node?.standings?.entries) {
      const rows = (node.standings.entries as Record<string, any>[]).map((e) => {
        const stat = (n: string) => (e.stats as Record<string, any>[] | undefined)?.find((s) => s.name === n);
        const v = (n: string) => num(stat(n)?.value);
        return { team: String(e.team?.displayName ?? ''), abbr: String(e.team?.abbreviation ?? ''), wins: v('wins'), losses: v('losses'), ...(stat('ties') ? { ties: v('ties') } : {}), pct: stat('winPercent')?.displayValue ?? null, gamesBehind: stat('gamesBehind')?.displayValue ?? null, ...(stat('playoffSeed') ? { seed: v('playoffSeed') } : {}), ...(stat('points') ? { points: v('points') } : {}) } as StandingRow;
      });
      groups.push({ name: String(node.name ?? node.abbreviation ?? ''), rows });
    }
    for (const ch of node?.children ?? []) walk(ch);
  };
  walk(j);
  return groups;
}

/** TheSportsDB events (eventslast "results", eventsnext "events"). */
export function parseSportsDbEvents(json: unknown, league: string): Game[] {
  const j = json as Record<string, any>;
  const list = (j?.results ?? j?.events ?? []) as Record<string, any>[];
  return list.map((e) => {
    const hs = num(e.intHomeScore);
    const as = num(e.intAwayScore);
    const done = hs !== null && as !== null && !/not started|ns/i.test(String(e.strStatus ?? ''));
    const start = e.strTimestamp ? new Date(`${String(e.strTimestamp).replace(/Z$/, '')}Z`).toISOString() : `${e.dateEvent}T${e.strTime ?? '00:00:00'}Z`;
    return { id: String(e.idEvent), league, name: String(e.strEvent ?? ''), start, state: done ? 'post' : 'pre', detail: done ? 'Final' : '', home: { abbr: '', name: String(e.strHomeTeam ?? ''), score: done ? hs : null }, away: { abbr: '', name: String(e.strAwayTeam ?? ''), score: done ? as : null }, ...(done && hs !== as ? { winner: (hs! > as! ? 'home' : 'away') as 'home' | 'away' } : {}) } as Game;
  });
}

/** The Odds API v4 /odds answer (American prices) → events with implied and no-vig probabilities. */
export function parseOddsApi(json: unknown, sport: string): OddsEvent[] {
  const list = Array.isArray(json) ? (json as Record<string, any>[]) : [];
  return list.map((e) => ({
    id: String(e.id),
    sport,
    start: String(e.commence_time ?? ''),
    home: String(e.home_team ?? ''),
    away: String(e.away_team ?? ''),
    lines: ((e.bookmakers ?? []) as Record<string, any>[]).flatMap((b) =>
      ((b.markets ?? []) as Record<string, any>[]).map((m) => {
        const outs = ((m.outcomes ?? []) as Record<string, any>[]).filter((o) => Number.isFinite(Number(o.price)) && Math.abs(Number(o.price)) >= 100);
        const implied = outs.map((o) => impliedFromAmerican(Number(o.price)));
        const fair = noVig(implied);
        return {
          book: String(b.title ?? b.key),
          bookKey: String(b.key),
          lastUpdate: String(m.last_update ?? b.last_update ?? ''),
          market: String(m.key),
          outcomes: outs.map((o, i) => ({ name: String(o.name), price: Number(o.price), ...(o.point !== undefined && o.point !== null ? { point: Number(o.point) } : {}), implied: round(implied[i], 4), fair: round(fair[i], 4) })),
          vig: round(implied.reduce((a, b2) => a + b2, 0) - 1, 4),
        } as BookLine;
      }),
    ),
  }));
}

export function nextUtcDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
export function nextUtcMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// ------------------------------------------------------------------ the service

export interface DataSourcesDeps {
  /** This space's choices: settings.dataSources ({quote, sports, odds} → provider id). */
  choices: () => Partial<Record<DataKind, string>> | undefined;
  /** This space's vault (keys as data:<provider>). */
  keys: { get(name: string): string | undefined };
  fetch?: FetchLike;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  ttl: number;
  value: unknown;
}

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;

export class DataSources {
  readonly #deps: DataSourcesDeps;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #quota = new Map<string, Quota>();
  /** Network requests per provider (tests and the settings page read it). */
  readonly calls = new Map<string, number>();

  constructor(deps: DataSourcesDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  provider(kind: DataKind): ProviderInfo {
    const id = this.#deps.choices()?.[kind];
    const p = id ? providerInfo(id) : undefined;
    return p && p.kind === kind ? p : providerInfo(DEFAULT_PROVIDER[kind])!;
  }

  #key(p: ProviderInfo): string | undefined {
    const k = this.#deps.keys.get(dataVaultKey(p.id))?.trim();
    return k || undefined;
  }

  hasKey(providerId: string): boolean {
    return Boolean(this.#deps.keys.get(dataVaultKey(providerId))?.trim());
  }

  /** Ready to answer: the provider needs no key, or has one. */
  ready(kind: DataKind): boolean {
    const p = this.provider(kind);
    return !p.needsKey || Boolean(this.#key(p));
  }

  quota(providerId: string): Quota | undefined {
    const q = this.#quota.get(providerId);
    return q ? { ...q } : undefined;
  }

  /** A paused provider (quota gone) refuses before any request. */
  pausedUntil(providerId: string): number | undefined {
    const u = this.#quota.get(providerId)?.pausedUntil;
    const t = u ? Date.parse(u) : NaN;
    return Number.isFinite(t) && t > this.#now() ? t : undefined;
  }

  #needKey(p: ProviderInfo): string {
    const k = this.#key(p);
    if (!k) throw new DataError('needs-key', p.id, `${p.label} needs a free key: get one at ${p.keyUrl}, then paste it in Settings → Data sources.`);
    return k;
  }

  #pause(p: ProviderInfo, until: number): never {
    const q = this.#quota.get(p.id) ?? { remaining: null, used: null, at: new Date(this.#now()).toISOString() };
    this.#quota.set(p.id, { ...q, remaining: q.remaining ?? 0, pausedUntil: new Date(until).toISOString() });
    throw new DataError('quota', p.id, `${p.label}'s free allowance is used up until ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC.`, until);
  }

  /** One request through the guard, with a timeout and clear errors. */
  async #get(p: ProviderInfo, url: string, init: RequestInit = {}): Promise<{ res: Response; body: string }> {
    const paused = this.pausedUntil(p.id);
    if (paused) throw new DataError('quota', p.id, `${p.label}'s free allowance is used up; Sara tries again after ${new Date(paused).toISOString().slice(0, 16).replace('T', ' ')} UTC.`, paused);
    const f = this.#deps.fetch ?? netFetch;
    this.calls.set(p.id, (this.calls.get(p.id) ?? 0) + 1);
    let res: Response;
    try {
      res = await f(url, { ...init, headers: { 'user-agent': 'Mozilla/5.0 (Sara assistant)', accept: 'application/json,text/csv,*/*', ...((init.headers as Record<string, string>) ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (isPrivateLocalError(err)) throw new DataError('private-local', p.id, 'Private local mode is on ("Nothing leaves this computer"), so live data is off.');
      const why = (err as Error).name === 'TimeoutError' ? 'no answer in 10 seconds' : 'no connection';
      throw new DataError('no-answer', p.id, `${p.label} didn't answer (${why}). Try again in a minute.`);
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      this.#pause(p, this.#now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15 * 60_000));
    }
    if (res.status === 401 || res.status === 403) throw new DataError('needs-key', p.id, p.needsKey || p.keyOptional ? `${p.label} refused the key. Check it in Settings → Data sources (get a free one at ${p.keyUrl}).` : `${p.label} refused the request (${res.status}).`);
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new DataError(res.status === 404 ? 'not-found' : 'no-answer', p.id, res.status === 404 ? `${p.label} has nothing at that address (404).` : `${p.label} didn't answer (HTTP ${res.status}). Try again in a minute.`);
    return { res, body };
  }

  #json(p: ProviderInfo, body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      throw new DataError('no-answer', p.id, `${p.label} didn't answer with data (it may be blocking automated readers right now).`);
    }
  }

  /** Cache + one request in flight per key. */
  async #cached<T extends object>(key: string, ttl: (v: T) => number, load: () => Promise<T>, fresh = false): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && !fresh && this.#now() - hit.at < hit.ttl) return { ...(hit.value as T), cached: true };
    const running = this.#inflight.get(key);
    if (running) return (await running) as T;
    const p = load().then((v) => {
      this.#cache.set(key, { at: this.#now(), ttl: ttl(v), value: v });
      if (this.#cache.size > 500) this.#cache.delete(this.#cache.keys().next().value!);
      return v;
    });
    this.#inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.#inflight.delete(key);
    }
  }

  // ---------------------------------------------------------------- quotes

  /** Several symbols; batched into one request where the provider allows it. Each symbol is cached 60 s. */
  async quotes(raw: string[], opts: { fresh?: boolean } = {}): Promise<QuoteResult> {
    const symbols = [...new Set(raw.map((s) => String(s).trim().toUpperCase().replace(/^\$/, '')).filter(Boolean))];
    if (!symbols.length) throw new DataError('bad-input', 'quote', 'Give one or more ticker symbols, like AAPL or MSFT.');
    if (symbols.length > 25) throw new DataError('bad-input', 'quote', 'At most 25 symbols at a time.');
    const bad = symbols.filter((s) => !SYMBOL.test(s));
    if (bad.length) throw new DataError('bad-input', 'quote', `"${bad[0].slice(0, 20)}" isn't a ticker symbol.`);
    const p = this.provider('quote');
    const out: Quote[] = [];
    const need: string[] = [];
    const now = this.#now();
    for (const s of symbols) {
      const hit = this.#cache.get(`q:${p.id}:${s}`);
      if (hit && !opts.fresh && now - hit.at < hit.ttl) out.push({ ...(hit.value as Quote), cached: true });
      else need.push(s);
    }
    let missing: string[] = [];
    if (need.length) {
      const r = await this.#fetchQuotes(p, need);
      for (const q of r.quotes) this.#cache.set(`q:${p.id}:${q.symbol}`, { at: this.#now(), ttl: TTL.quote, value: q });
      out.push(...r.quotes);
      const got = new Set(r.quotes.map((q) => q.symbol));
      missing = need.filter((s) => !got.has(s));
    }
    const order = new Map(symbols.map((s, i) => [s, i]));
    out.sort((a, b) => (order.get(a.symbol) ?? 99) - (order.get(b.symbol) ?? 99));
    return { quotes: out, missing };
  }

  async #fetchQuotes(p: ProviderInfo, symbols: string[]): Promise<QuoteResult> {
    const fetchedAt = () => new Date(this.#now()).toISOString();
    if (p.id === 'yahoo') {
      const { body } = await this.#get(p, `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(',')}&range=1d&interval=1d`);
      return parseYahooSpark(this.#json(p, body), fetchedAt());
    }
    if (p.id === 'stooq') {
      const { body } = await this.#get(p, `https://stooq.com/q/l/?s=${symbols.map((s) => encodeURIComponent(s.includes('.') ? s.toLowerCase() : `${s.toLowerCase()}.us`)).join('+')}&f=sd2t2ohlcv&h&e=csv`);
      return parseStooqCsv(body, fetchedAt());
    }
    // One symbol per request (free keys): the batch is still one call per symbol, cached.
    const key = this.#needKey(p);
    const quotes: Quote[] = [];
    for (const s of symbols) {
      if (p.id === 'finnhub') {
        const { body } = await this.#get(p, `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}`, { headers: { 'X-Finnhub-Token': key } });
        const q = parseFinnhub(s, this.#json(p, body), fetchedAt());
        if (q) quotes.push(q);
      } else {
        this.#countDay(p);
        const { body } = await this.#get(p, `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(s)}&apikey=${encodeURIComponent(key)}`);
        let q: Quote | undefined;
        try {
          q = parseAlphaVantage(s, this.#json(p, body), fetchedAt());
        } catch (err) {
          if (err instanceof DataError && err.code === 'quota') this.#pause(p, err.until ?? nextUtcDay(this.#now()));
          throw err;
        }
        if (q) quotes.push(q);
      }
    }
    return { quotes, missing: [] };
  }

  #countDay(p: ProviderInfo): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    const q = this.#quota.get(p.id);
    const today = q && q.at.slice(0, 10) === day ? (q.today ?? 0) + 1 : 1;
    this.#quota.set(p.id, { remaining: Math.max(0, 25 - today), used: today, at: new Date(this.#now()).toISOString(), today });
  }

  // ---------------------------------------------------------------- sports

  async scores(leagueRaw: string, opts: { team?: string; date?: string; fresh?: boolean } = {}): Promise<Games> {
    const league = leagueOf(leagueRaw);
    const p = this.provider('sports');
    const date = opts.date ? ymd(opts.date) : '';
    const r = await this.#cached<Games>(`s:${p.id}:${league}:${date}:${p.id === 'thesportsdb' ? (opts.team ?? '').toLowerCase() : ''}`, (v) => (v.games.some((g) => g.state === 'in') ? TTL.scoresLive : TTL.sports), async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      if (p.id === 'thesportsdb') return this.#sportsDb(p, league, opts.team, 'last', fetchedAt);
      const { body } = await this.#get(p, `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].espn}/scoreboard${date ? `?dates=${date}` : ''}`);
      return { league, games: parseEspnEvents(this.#json(p, body), league), source: 'ESPN', at: fetchedAt, fetchedAt };
    }, opts.fresh);
    return opts.team ? { ...r, games: r.games.filter((g) => teamMatch(g, opts.team!)) } : r;
  }

  async schedule(leagueRaw: string, team: string, days = 14, opts: { fresh?: boolean } = {}): Promise<Games> {
    const league = leagueOf(leagueRaw);
    const t = String(team ?? '').trim();
    if (!t) throw new DataError('bad-input', 'sports', 'Which team? Give its name or abbreviation (like LAL or Lakers).');
    const p = this.provider('sports');
    const span = Math.min(Math.max(1, Math.round(days) || 14), 60);
    const r = await this.#cached<Games>(`sch:${p.id}:${league}:${t.toLowerCase()}`, () => TTL.sports, async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      if (p.id === 'thesportsdb') return this.#sportsDb(p, league, t, 'next', fetchedAt);
      const abbr = await this.#espnTeam(p, league, t);
      const { body } = await this.#get(p, `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].espn}/teams/${encodeURIComponent(abbr)}/schedule`);
      return { league, games: parseEspnEvents(this.#json(p, body), league), source: 'ESPN', at: fetchedAt, fetchedAt };
    }, opts.fresh);
    const now = this.#now();
    const end = now + span * 86_400_000;
    return { ...r, games: r.games.filter((g) => g.state !== 'post' && Date.parse(g.start) <= end && Date.parse(g.start) >= now - 6 * 3600_000).slice(0, 20) };
  }

  /** ESPN's team id or abbreviation for a name ("Lakers" → "lal"). */
  async #espnTeam(p: ProviderInfo, league: string, team: string): Promise<string> {
    return (await this.team(league, team)).abbr.toLowerCase();
  }

  /** E4: ESPN's teams for a league (cached a day; college lists ask for every team). */
  async teams(leagueRaw: string): Promise<EspnTeam[]> {
    const league = leagueOf(leagueRaw);
    const espn = providerInfo('espn')!;
    const r = await this.#cached<{ teams: EspnTeam[] }>(`teams:${league}`, () => 24 * 3600_000, async () => {
      const { body } = await this.#get(espn, `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].espn}/teams${league.startsWith('ncaa') ? '?limit=1000' : ''}`);
      return { teams: parseEspnTeams(this.#json(espn, body)) };
    });
    return r.teams;
  }

  /** E4: one team by name, nickname, city or abbreviation ("Chiefs", "KC", "Kansas City Chiefs"). */
  async team(leagueRaw: string, team: string): Promise<EspnTeam> {
    const league = leagueOf(leagueRaw);
    const hit = findTeam(await this.teams(league), team);
    if (!hit) throw new DataError('not-found', 'espn', `ESPN has no ${LEAGUES[league].label} team called "${team.slice(0, 40)}".`);
    return hit;
  }

  /** E4: a team's whole season from ESPN (past and upcoming games), cached 10 minutes. */
  async teamSchedule(leagueRaw: string, teamId: string, opts: { fresh?: boolean } = {}): Promise<Games> {
    const league = leagueOf(leagueRaw);
    const espn = providerInfo('espn')!;
    return this.#cached<Games>(`tsch:${league}:${teamId}`, () => TTL.sports, async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      const { body } = await this.#get(espn, `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].espn}/teams/${encodeURIComponent(teamId)}/schedule`);
      return { league, games: parseEspnEvents(this.#json(espn, body), league), source: 'ESPN', at: fetchedAt, fetchedAt };
    }, opts.fresh);
  }

  /** E4: ESPN's news for a team (cached 30 minutes). */
  async news(leagueRaw: string, teamId: string, limit = 5): Promise<Stamp & { items: NewsItem[] }> {
    const league = leagueOf(leagueRaw);
    const espn = providerInfo('espn')!;
    return this.#cached(`news:${league}:${teamId}`, () => 30 * 60_000, async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      const { body } = await this.#get(espn, `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].espn}/news?team=${encodeURIComponent(teamId)}&limit=${Math.min(Math.max(1, limit), 10)}`);
      const items = parseEspnNews(this.#json(espn, body));
      return { items, source: 'ESPN', at: items[0]?.published ?? fetchedAt, fetchedAt };
    });
  }

  /** E4: ESPN's injury report for one team (the league's list, cached 3 hours: it is large). */
  async injuries(leagueRaw: string, teamId: string): Promise<Stamp & { items: InjuryItem[]; listed: boolean }> {
    const league = leagueOf(leagueRaw);
    const espn = providerInfo('espn')!;
    const all = await this.#cached<Stamp & { teams: Record<string, InjuryItem[]> }>(`inj:${league}`, () => 3 * 3600_000, async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      const { body } = await this.#get(espn, `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].espn}/injuries`);
      const j = this.#json(espn, body) as { timestamp?: string };
      return { teams: parseEspnInjuries(j), source: 'ESPN', at: typeof j?.timestamp === 'string' ? j.timestamp : fetchedAt, fetchedAt };
    });
    const { teams, ...stamp } = all;
    return { ...stamp, items: teams[teamId] ?? [], listed: Object.keys(teams).length > 0 };
  }

  async #sportsDb(p: ProviderInfo, league: string, team: string | undefined, which: 'last' | 'next', fetchedAt: string): Promise<Games> {
    if (!team) throw new DataError('bad-input', p.id, 'TheSportsDB needs a team for scores. Name the team, or switch Sports to ESPN in Settings → Data sources.');
    const key = this.#key(p) ?? THESPORTSDB_FREE_KEY;
    const base = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}`;
    const { body } = await this.#get(p, `${base}/searchteams.php?t=${encodeURIComponent(team)}`);
    const teams = ((this.#json(p, body) as { teams?: { idTeam: string; strLeague?: string }[] | null })?.teams ?? []) as { idTeam: string; strLeague?: string }[];
    const want = LEAGUES[league].tsdb;
    const t = teams.find((x) => !want || x.strLeague === want) ?? teams[0];
    if (!t) throw new DataError('not-found', p.id, `TheSportsDB has no team called "${team.slice(0, 40)}".`);
    const r = await this.#get(p, `${base}/events${which}.php?id=${encodeURIComponent(t.idTeam)}`);
    return { league, games: parseSportsDbEvents(this.#json(p, r.body), league), source: 'TheSportsDB', at: fetchedAt, fetchedAt };
  }

  async standings(leagueRaw: string, opts: { fresh?: boolean } = {}): Promise<Standings> {
    const league = leagueOf(leagueRaw);
    const p = this.provider('sports');
    // TheSportsDB's free key has no standings: ESPN answers them (no key either way).
    const espn = providerInfo('espn')!;
    return this.#cached<Standings>(`st:${league}`, () => TTL.sports, async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      const { body } = await this.#get(espn, `https://site.api.espn.com/apis/v2/sports/${LEAGUES[league].espn}/standings`);
      const groups = parseEspnStandings(this.#json(espn, body));
      if (!groups.length) throw new DataError('not-found', espn.id, `ESPN has no ${LEAGUES[league].label} standings right now${p.id !== 'espn' ? '' : ' (between seasons?)'}.`);
      return { league, groups, source: 'ESPN', at: fetchedAt, fetchedAt };
    }, opts.fresh);
  }

  // ---------------------------------------------------------------- odds

  /** Odds for a sport (one request per sport and market set, cached 5 min to save the free credits). */
  async odds(sportRaw: string, opts: { markets?: string[]; books?: string[]; team?: string; event?: string; fresh?: boolean; regions?: string } = {}): Promise<OddsResult> {
    const s = String(sportRaw ?? '').trim().toLowerCase();
    let sport = s;
    try {
      sport = LEAGUES[leagueOf(s)].odds ?? s;
    } catch {
      if (!/^[a-z0-9_]{3,60}$/.test(s)) throw new DataError('bad-input', 'odds', `I don't know the sport "${s.slice(0, 40)}". Use a league (nfl, nba, mlb, nhl, epl…) or The Odds API's sport key.`);
    }
    const markets = [...new Set((opts.markets?.length ? opts.markets : ['h2h']).map((m) => String(m).toLowerCase()))];
    if (markets.some((m) => !['h2h', 'spreads', 'totals'].includes(m))) throw new DataError('bad-input', 'odds', 'Markets are h2h (moneyline), spreads and totals.');
    const regions = opts.regions && /^[a-z,]{2,20}$/.test(opts.regions) ? opts.regions : 'us';
    const p = this.provider('odds');
    const key = this.#needKey(p);
    const r = await this.#cached<OddsResult>(`o:${sport}:${markets.sort().join(',')}:${regions}`, () => TTL.odds, async () => {
      const fetchedAt = new Date(this.#now()).toISOString();
      const { res, body } = await this.#get(p, `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds?regions=${regions}&markets=${markets.join(',')}&oddsFormat=american&apiKey=${encodeURIComponent(key)}`);
      const quota = this.#readOddsQuota(p, res);
      const events = parseOddsApi(this.#json(p, body), sport);
      const latest = events.flatMap((e) => e.lines.map((l) => l.lastUpdate)).filter(Boolean).sort().at(-1);
      return { sport, events, source: 'The Odds API', at: latest ?? fetchedAt, fetchedAt, ...(quota ? { quota } : {}) };
    }, opts.fresh);
    let events = r.events;
    const q = (opts.team ?? opts.event ?? '').trim().toLowerCase();
    if (q) events = events.filter((e) => e.id === q || `${e.home} ${e.away}`.toLowerCase().includes(q));
    const books = (opts.books ?? []).map((b) => b.toLowerCase());
    if (books.length) events = events.map((e) => ({ ...e, lines: e.lines.filter((l) => books.some((b) => l.bookKey.includes(b) || l.book.toLowerCase().includes(b))) }));
    return { ...r, events, ...(this.quota(p.id) ? { quota: this.quota(p.id) } : {}) };
  }

  #readOddsQuota(p: ProviderInfo, res: Response): Quota | undefined {
    const rem = num(res.headers.get('x-requests-remaining'));
    const used = num(res.headers.get('x-requests-used'));
    if (rem === null && used === null) return undefined;
    const q: Quota = { remaining: rem, used, at: new Date(this.#now()).toISOString(), ...(rem !== null && rem <= 0 ? { pausedUntil: new Date(nextUtcMonth(this.#now())).toISOString() } : {}) };
    this.#quota.set(p.id, q);
    return q;
  }

  /** Settings → Data sources → Test: one small real request. */
  async test(kind: DataKind): Promise<{ ok: boolean; message: string; source: string }> {
    const p = this.provider(kind);
    try {
      if (kind === 'quote') {
        const r = await this.quotes(['AAPL'], { fresh: true });
        const q = r.quotes[0];
        return q ? { ok: true, source: p.label, message: `AAPL ${q.price} at ${q.at} from ${q.source}.` } : { ok: false, source: p.label, message: `${p.label} answered but had no price for AAPL.` };
      }
      if (kind === 'sports') {
        if (p.id === 'thesportsdb') {
          const r = await this.scores('epl', { team: 'Arsenal', fresh: true });
          return { ok: true, source: p.label, message: `${r.games.length} recent Arsenal result(s) from ${r.source}.` };
        }
        const r = await this.scores('nba', { fresh: true });
        return { ok: true, source: p.label, message: `${r.games.length} NBA game(s) today from ${r.source}.` };
      }
      const r = await this.odds('nba', { fresh: true });
      return { ok: true, source: p.label, message: `${r.events.length} NBA event(s) with odds.${r.quota?.remaining !== null && r.quota?.remaining !== undefined ? ` ${r.quota.remaining} credits left this month.` : ''}` };
    } catch (err) {
      return { ok: false, source: p.label, message: (err as Error).message };
    }
  }
}

/** E4: ESPN's /teams answer → teams. */
export function parseEspnTeams(json: unknown): EspnTeam[] {
  const teams = (((json as Record<string, any>)?.sports?.[0]?.leagues?.[0]?.teams ?? []) as Record<string, any>[]).map((x) => x.team ?? x);
  return teams.filter((x) => x && x.id !== undefined).map((x) => ({ id: String(x.id), abbr: String(x.abbreviation ?? x.id), name: String(x.displayName ?? x.name ?? ''), short: String(x.shortDisplayName ?? x.name ?? x.displayName ?? ''), names: [x.abbreviation, x.displayName, x.shortDisplayName, x.name, x.location, x.nickname].filter(Boolean).map((n: string) => String(n).toLowerCase()) }));
}

/** E4: the best team for a name: exact name/abbreviation first, then a name that contains it. */
export function findTeam(teams: EspnTeam[], raw: string): EspnTeam | undefined {
  const q = String(raw ?? '').trim().toLowerCase();
  if (!q) return undefined;
  return teams.find((x) => x.id === q) ?? teams.find((x) => x.names.includes(q)) ?? teams.find((x) => x.name.toLowerCase().includes(q)) ?? teams.find((x) => x.names.some((n) => n.includes(q)));
}

/** E4: ESPN news articles (headline, short description, time, link). */
export function parseEspnNews(json: unknown): NewsItem[] {
  const list = ((json as Record<string, any>)?.articles ?? []) as Record<string, any>[];
  return list.filter((a) => a?.headline).map((a) => ({ headline: String(a.headline).slice(0, 200), ...(a.description ? { description: String(a.description).slice(0, 300) } : {}), published: String(a.published ?? a.lastModified ?? ''), ...(a.links?.web?.href ? { url: String(a.links.web.href) } : {}) }));
}

/** E4: ESPN's league injury list → per team id (players listed "Active" are left out). */
export function parseEspnInjuries(json: unknown): Record<string, InjuryItem[]> {
  const out: Record<string, InjuryItem[]> = {};
  for (const t of ((json as Record<string, any>)?.injuries ?? []) as Record<string, any>[]) {
    const items = ((t.injuries ?? []) as Record<string, any>[]).filter((x) => x?.athlete?.displayName && x.status && !/^active$/i.test(String(x.status))).map((x) => ({ player: String(x.athlete.displayName), ...(x.athlete.position?.abbreviation ? { position: String(x.athlete.position.abbreviation) } : {}), status: String(x.status), ...(x.date ? { date: String(x.date) } : {}), ...(x.shortComment ? { detail: String(x.shortComment).slice(0, 240) } : x.type?.description ? { detail: String(x.type.description) } : {}), ...(x.details?.returnDate ? { returnDate: String(x.details.returnDate) } : {}) }));
    out[String(t.id)] = items;
  }
  return out;
}

export function teamMatch(g: Game, team: string): boolean {
  const q = team.trim().toLowerCase();
  if (!q) return true;
  // E4: a follow matches on ESPN's team id ("id:12"), so two teams called "KC" never mix up.
  if (q.startsWith('id:')) return [g.home, g.away].some((s) => s.id === q.slice(3));
  return [g.home, g.away].some((s) => s.abbr.toLowerCase() === q || s.name.toLowerCase().includes(q));
}

/** "2026-11-12", "11/12/2026", "today" → YYYYMMDD for ESPN. */
function ymd(raw: string): string {
  const s = raw.trim().toLowerCase();
  const d = s === 'today' ? new Date() : s === 'yesterday' ? new Date(Date.now() - 86_400_000) : s === 'tomorrow' ? new Date(Date.now() + 86_400_000) : /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s) ? new Date(`${s.split('/')[2]}-${s.split('/')[0].padStart(2, '0')}-${s.split('/')[1].padStart(2, '0')}T12:00:00Z`) : new Date(`${s.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new DataError('bad-input', 'sports', `"${raw.slice(0, 20)}" isn't a date (use 2026-11-12).`);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
