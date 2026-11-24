// P2 (docs/design/P2STOCKS.md): stock trackers and graphs on Today. A tracker is a live watch of
// kind price with when "track" (src/live-watch.ts): the same list the "tell me when" alerts use,
// so the Stocks tile shows every symbol someone tracks OR has an alert on, with the alert levels
// marked on its chart. Nothing here is checked in the background: the tile asks when it is open.
// Polite refresh: quotes are reused for a minute while the US market is open and 15 minutes when
// it is closed; after a failed fetch the next try waits (1, 2, 5, 15, 30 min) and the last good
// prices stay with their time. Private local mode: nothing is fetched and the tile says so.
// Per space (each household member has their own); never on a child's account.
// Order and "shown once" live in <dataDir>/stock-trackers.json (a view preference, not a list).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { CHART_RANGES, DataError, type ChartRange, type Quote, type StockChart, type SymbolHit } from './data-sources.ts';
import { LiveWatchError, type LiveWatch } from './live-watch.ts';
import { privateLocalOn } from './net-guard.ts';

export const STOCKS = {
  maxTrackers: 12,
  /** Quotes reused this long (ms): market open / closed. */
  openEveryMs: 60_000,
  closedEveryMs: 15 * 60_000,
  /** Waits after 1, 2, 3, 4, 5+ failed fetches in a row. */
  backoffMs: [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
} as const;

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
const LOCAL_ONLY = 'Private local mode is on ("Nothing leaves this computer"), so prices can\u2019t be fetched.';

/** The n-th (1-based) given weekday of a month, or the last one (n = -1). Month 1-12, weekday 0 = Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, days)).getUTCDay();
  return days - ((last - weekday + 7) % 7);
}
/** Easter Sunday (Gregorian), as [month, day]. */
function easter(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const g = Math.floor((8 * b + 13) / 25), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}
const key = (m: number, d: number) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** A fixed-date holiday on a weekend: Saturday is kept on Friday, Sunday on Monday. */
function observed(year: number, month: number, day: number, o: { saturday?: boolean } = {}): string | undefined {
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (wd === 6) return o.saturday === false ? undefined : key(month, day - 1);
  if (wd === 0) return key(month, day + 1);
  return key(month, day);
}

/**
 * T43 (C22): the days the US stock exchanges are closed (the NYSE's rules), as "MM-DD" for a year.
 * New Year's Day on a Saturday is not kept on the Friday before (the exchange's own exception).
 */
export function usMarketHolidays(year: number): Set<string> {
  const [em, ed] = easter(year);
  const goodFriday = new Date(Date.UTC(year, em - 1, ed - 2));
  const out = [
    observed(year, 1, 1, { saturday: false }),
    key(1, nthWeekday(year, 1, 1, 3)), // Martin Luther King Jr. Day
    key(2, nthWeekday(year, 2, 1, 3)), // Washington's Birthday
    key(goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()),
    key(5, nthWeekday(year, 5, 1, -1)), // Memorial Day
    observed(year, 6, 19), // Juneteenth
    observed(year, 7, 4),
    key(9, nthWeekday(year, 9, 1, 1)), // Labor Day
    key(11, nthWeekday(year, 11, 4, 4)), // Thanksgiving
    observed(year, 12, 25),
  ];
  return new Set(out.filter((x): x is string => Boolean(x)));
}
/** The two regular 1:00 pm closes: the day after Thanksgiving, and Christmas Eve on a weekday. */
function usEarlyClose(year: number): Set<string> {
  const out = new Set([key(11, nthWeekday(year, 11, 4, 4) + 1)]);
  const eve = new Date(Date.UTC(year, 11, 24)).getUTCDay();
  if (eve >= 1 && eve <= 5 && !usMarketHolidays(year).has(key(12, 24))) out.add(key(12, 24));
  return out;
}

/** US stock market hours: 9:30-16:00 New York time, Monday to Friday, closed on its holidays, 13:00 on its two short days. */
export function usMarketOpen(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  if (['Sat', 'Sun'].includes(get('weekday'))) return false;
  const year = Number(get('year'));
  const day = key(Number(get('month')), Number(get('day')));
  if (usMarketHolidays(year).has(day)) return false;
  const m = Number(get('hour')) * 60 + Number(get('minute'));
  return m >= 9 * 60 + 30 && m < (usEarlyClose(year).has(day) ? 13 : 16) * 60;
}

export interface StockAlert {
  id: number;
  when: LiveWatch['when'];
  value: number | null;
  label: string;
  state: LiveWatch['state'];
}
export interface StockRow {
  symbol: string;
  name?: string;
  /** Has a tracker (else it is on the list because of an alert). */
  tracked: boolean;
  alerts: StockAlert[];
  price?: number;
  change?: number | null;
  changePct?: number | null;
  currency?: string;
  /** The price's market time, ISO. */
  at?: string;
}
export interface StockView {
  trackers: StockRow[];
  /** The oldest price time shown, ISO. */
  asOf?: string;
  fetchedAt?: string;
  source?: string;
  /** Plain words when the last fetch failed or can't happen. */
  error?: string;
  /** Prices are from an earlier fetch (the last one failed). */
  stale: boolean;
  localOnly: boolean;
  market: { open: boolean };
  /** When the tile should ask again (ms). */
  nextMs: number;
  max: number;
}

interface Prefs {
  order: string[];
  introduced: boolean;
}

const engines = new WeakMap<AppContext, StockTrackers>();
/** The space's trackers; undefined on a child's account, in the demo, or without live data. */
export function stocksOf(app: AppContext): StockTrackers | undefined {
  if (app.member?.child?.() || !app.liveWatches || !app.dataSources) return undefined;
  let e = engines.get(app);
  if (!e) engines.set(app, (e = new StockTrackers(app)));
  return e;
}

export class StockError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class StockTrackers {
  readonly #app: AppContext;
  #quotes = new Map<string, Quote>();
  #lastAt = 0;
  #fails = 0;
  #retryAt = 0;
  #error: string | undefined;

  constructor(app: AppContext) {
    this.#app = app;
  }

  #now(): number {
    return this.#app.now().getTime();
  }
  #file(): string {
    return join(this.#app.dataDir, 'stock-trackers.json');
  }
  #prefs(): Prefs {
    try {
      const p = existsSync(this.#file()) ? (JSON.parse(readFileSync(this.#file(), 'utf8')) as Partial<Prefs>) : {};
      return { order: Array.isArray(p.order) ? p.order.filter((s) => typeof s === 'string').slice(0, 60) : [], introduced: p.introduced === true };
    } catch {
      return { order: [], introduced: false };
    }
  }
  #save(patch: Partial<Prefs>): void {
    writeFileSync(this.#file(), JSON.stringify({ ...this.#prefs(), ...patch }));
  }

  /** Every price watch that is not done, by symbol, in the person's order (new ones last). */
  #rows(): StockRow[] {
    const by = new Map<string, StockRow>();
    for (const w of this.#app.liveWatches?.list() ?? []) {
      if (w.kind !== 'price' || w.state === 'done' || !w.target.symbol) continue;
      const s = w.target.symbol;
      const row = by.get(s) ?? { symbol: s, tracked: false, alerts: [] };
      if (w.when === 'track') {
        row.tracked = true;
        if (w.target.name) row.name = w.target.name;
      } else row.alerts.push({ id: w.id, when: w.when, value: w.value, label: w.label, state: w.state });
      by.set(s, row);
    }
    const order = this.#prefs().order;
    const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : 1000);
    return [...by.values()].sort((a, b) => rank(a.symbol) - rank(b.symbol));
  }

  symbols(): string[] {
    return this.#rows().map((r) => r.symbol);
  }

  /** Adds a tracker. Checks the symbol has a price (not in private local mode: added unchecked). */
  async add(raw: string): Promise<StockRow> {
    const symbol = String(raw ?? '').trim().toUpperCase().replace(/^\$/, '');
    if (!SYMBOL.test(symbol)) throw new StockError(400, 'Give a ticker symbol, like AAPL.');
    const lw = this.#app.liveWatches!;
    if (lw.list().some((w) => w.kind === 'price' && w.when === 'track' && w.state !== 'done' && w.target.symbol === symbol)) throw new StockError(409, `${symbol} is already on your list.`);
    if (lw.list().filter((w) => w.when === 'track' && w.state !== 'done').length >= STOCKS.maxTrackers) throw new StockError(409, `You track ${STOCKS.maxTrackers} stocks. Remove one first.`);
    let name: string | undefined;
    if (!privateLocalOn()) {
      try {
        const r = await this.#app.dataSources!.quotes([symbol]);
        const q = r.quotes.find((x) => x.symbol === symbol);
        if (!q) throw new StockError(400, `No price found for ${symbol}. Check the symbol.`);
        this.#quotes.set(symbol, q);
        name = q.name;
      } catch (err) {
        if (err instanceof StockError) throw err;
        if (err instanceof DataError && err.code === 'bad-input') throw new StockError(400, err.message);
        /* the source is down: add it anyway; prices come when it answers */
      }
    }
    try {
      lw.add({ kind: 'price', symbol, when: 'track', how: 'chat', name, until: new Date(this.#now() + 90 * 86_400_000).toISOString() });
    } catch (err) {
      if (err instanceof LiveWatchError) throw new StockError(err.status, err.message);
      throw err;
    }
    const order = this.#prefs().order.filter((s) => s !== symbol);
    this.#save({ order: [...(order.length ? order : this.symbols().filter((s) => s !== symbol)), symbol] });
    return this.#rows().find((r) => r.symbol === symbol)!;
  }

  /** Removes a symbol from the list: its tracker and its alerts. Returns how many watches went. */
  remove(raw: string): number {
    const symbol = String(raw ?? '').trim().toUpperCase();
    const lw = this.#app.liveWatches!;
    let n = 0;
    for (const w of lw.list()) if (w.kind === 'price' && w.target.symbol === symbol && lw.remove(w.id)) n++;
    this.#save({ order: this.#prefs().order.filter((s) => s !== symbol) });
    this.#quotes.delete(symbol);
    return n;
  }

  setOrder(symbols: unknown): void {
    if (!Array.isArray(symbols)) throw new StockError(400, 'Give the symbols in order.');
    const want = symbols.map((s) => String(s).toUpperCase()).filter((s) => SYMBOL.test(s)).slice(0, 60);
    this.#save({ order: [...new Set(want)] });
  }

  /** Adds a price alert on a symbol from the big chart (the same \u201ctell me when\u201d watch the chat makes). */
  addAlert(input: { symbol?: unknown; when?: unknown; value?: unknown }): LiveWatch {
    const when = String(input.when ?? '');
    if (!['above', 'below', 'moves_pct'].includes(when)) throw new StockError(400, 'Choose above, below or a move in %.');
    try {
      return this.#app.liveWatches!.add({ kind: 'price', symbol: input.symbol, when, value: input.value, how: 'phone' });
    } catch (err) {
      if (err instanceof LiveWatchError) throw new StockError(err.status, err.message);
      throw err;
    }
  }

  #every(open: boolean): number {
    return open ? STOCKS.openEveryMs : STOCKS.closedEveryMs;
  }

  /** The tile's list with prices: cached, polite, and honest about errors and age. */
  async view(opts: { fresh?: boolean } = {}): Promise<StockView> {
    const rows = this.#rows();
    const now = this.#now();
    const open = usMarketOpen(new Date(now));
    const local = privateLocalOn();
    const syms = rows.map((r) => r.symbol);
    const missing = syms.filter((s) => !this.#quotes.has(s));
    const due = opts.fresh || missing.length > 0 || now - this.#lastAt >= this.#every(open);
    if (local) this.#error = LOCAL_ONLY;
    else if (syms.length && due && now >= this.#retryAt) {
      try {
        const r = await this.#app.dataSources!.quotes(syms.slice(0, 25), { fresh: opts.fresh });
        for (const q of r.quotes) this.#quotes.set(q.symbol, q);
        this.#lastAt = now;
        this.#fails = 0;
        this.#retryAt = 0;
        this.#error = undefined;
      } catch (err) {
        this.#fails++;
        this.#retryAt = now + STOCKS.backoffMs[Math.min(this.#fails, STOCKS.backoffMs.length) - 1];
        this.#error = err instanceof Error ? err.message : String(err);
      }
    } else if (local === false && this.#error === LOCAL_ONLY) this.#error = undefined;
    const out: StockRow[] = rows.map((r) => {
      const q = this.#quotes.get(r.symbol);
      if (!q) return r;
      return { ...r, name: r.name ?? q.name, price: q.price, change: q.change, changePct: q.changePct, ...(q.currency ? { currency: q.currency } : {}), at: q.at };
    });
    const times = out.map((r) => r.at).filter((x): x is string => Boolean(x)).sort();
    const any = [...this.#quotes.values()][0];
    const failing = Boolean(this.#error);
    const wait = failing && !local ? Math.max(this.#retryAt - now, 30_000) : this.#every(open);
    return {
      trackers: out,
      ...(times.length ? { asOf: times[0] } : {}),
      ...(this.#lastAt ? { fetchedAt: new Date(this.#lastAt).toISOString() } : {}),
      ...(any ? { source: any.source } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      stale: failing && times.length > 0,
      localOnly: local,
      market: { open },
      nextMs: wait,
      max: STOCKS.maxTrackers,
    };
  }

  /** One symbol's chart for a range, with its alert levels to mark. */
  async chart(raw: string, range: ChartRange): Promise<StockChart & { range: ChartRange; levels: { id: number; when: string; value: number }[] }> {
    if (!CHART_RANGES[range]) throw new StockError(400, 'The range is 1d, 1w, 1m or 1y.');
    const symbol = String(raw ?? '').trim().toUpperCase();
    if (privateLocalOn()) throw new StockError(503, LOCAL_ONLY);
    try {
      const c = await this.#app.dataSources!.chart(symbol, range);
      const row = this.#rows().find((r) => r.symbol === symbol);
      const levels = (row?.alerts ?? []).filter((a) => (a.when === 'above' || a.when === 'below') && typeof a.value === 'number').map((a) => ({ id: a.id, when: a.when, value: a.value as number }));
      return { ...c, range, levels };
    } catch (err) {
      if (err instanceof DataError) throw new StockError(err.code === 'bad-input' ? 400 : err.code === 'not-found' ? 404 : 502, err.message);
      throw err;
    }
  }

  async search(q: string): Promise<{ results: SymbolHit[]; error?: string }> {
    if (privateLocalOn()) return { results: [], error: LOCAL_ONLY };
    try {
      return { results: await this.#app.dataSources!.searchSymbols(q) };
    } catch (err) {
      return { results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Today's part: how many symbols, and whether the tile should show itself once (no network). */
  todayPart(): { count: number; symbols: string[]; intro: boolean } | undefined {
    const syms = this.symbols();
    if (!syms.length) return undefined;
    return { count: syms.length, symbols: syms.slice(0, 12), intro: !this.#prefs().introduced };
  }

  markIntroduced(): void {
    this.#save({ introduced: true });
  }
}
