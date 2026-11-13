// E4 (docs/SPORTS.md): the person's own bet log. Sara never places bets: this is a record the
// person keeps (what they bet, at what odds, how it ended), with the math done in code: profit,
// ROI, win rate, average odds, closing-line value when the closing price is known, and a bankroll.
// Optional self-set limits (a weekly loss limit, a most-per-bet stake, cool-off days) are checked
// when a bet is logged: crossing one is said plainly and recorded on the bet, but logging is never
// blocked (it's a log). During a cool-off the person set, she doesn't help find bets (odds tools
// answer with the cool-off instead). Each person's log lives in their own space's store.db.
import type { DatabaseSync } from 'node:sqlite';
import { parseOdds, priceOf, parlay, type OddsPrice } from './odds-math.ts';

export type BetMarket = 'moneyline' | 'spread' | 'total' | 'prop' | 'parlay';
export const BET_MARKETS: readonly BetMarket[] = ['moneyline', 'spread', 'total', 'prop', 'parlay'];
export type BetResult = 'win' | 'loss' | 'push' | 'void';
export type BetStatus = 'open' | BetResult;
export const HELP_LINE = 'If betting stops being fun, free and confidential help is a call or text away: 1-800-GAMBLER (US, any time).';

export interface Bet {
  id: number;
  date: string;
  sport: string;
  league: string | null;
  event: string;
  market: BetMarket;
  pick: string;
  line: number | null;
  odds: string;
  decimal: number;
  american: number;
  stake: number;
  book: string | null;
  notes: string | null;
  status: BetStatus;
  profit: number | null;
  settledAt: string | null;
  settledBy: 'person' | 'score' | null;
  /** ESPN's game id, its start and which side the pick is on (for settling from the final score). */
  eventId: string | null;
  eventStart: string | null;
  side: 'home' | 'away' | 'over' | 'under' | null;
  /** The Odds API event id (for the closing line from saved odds). */
  oddsEventId: string | null;
  closingDecimal: number | null;
  warning: string | null;
  legs: string[];
  createdAt: string;
}

export interface Limits {
  bankroll: number | null;
  weeklyLossLimit: number | null;
  maxStake: number | null;
  coolOffUntil: string | null;
}

interface Row {
  [k: string]: unknown;
}

export class BetError extends Error {}

function ensure(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sports_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, sport TEXT NOT NULL, league TEXT, event TEXT NOT NULL, market TEXT NOT NULL,
    pick TEXT NOT NULL, line REAL, odds TEXT NOT NULL, decimal REAL NOT NULL, stake REAL NOT NULL, book TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'open', profit REAL, settled_at TEXT, settled_by TEXT, event_id TEXT, event_start TEXT, side TEXT,
    odds_event_id TEXT, closing_decimal REAL, warning TEXT, legs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS sports_prefs (key TEXT PRIMARY KEY, value TEXT)');
  db.exec(`CREATE TABLE IF NOT EXISTS sports_odds_snapshots (
    event_id TEXT NOT NULL, market TEXT NOT NULL, outcome TEXT NOT NULL, point REAL, decimal REAL NOT NULL, books INTEGER NOT NULL, start TEXT, at TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS sports_odds_snapshots_ev ON sports_odds_snapshots (event_id, market, at)');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AddInput {
  date?: string;
  sport: string;
  league?: string | null;
  event: string;
  market: string;
  pick: string;
  line?: number | null;
  odds?: unknown;
  legs?: unknown[];
  stake: unknown;
  book?: string | null;
  notes?: string | null;
  eventId?: string | null;
  eventStart?: string | null;
  side?: Bet['side'];
  oddsEventId?: string | null;
}

export class BetLog {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date) {
    this.#db = db;
    this.#now = now;
    ensure(db);
  }

  #view(r: Row): Bet {
    const dec = Number(r.decimal);
    const p = priceOf(dec);
    return {
      id: Number(r.id), date: String(r.date), sport: String(r.sport), league: (r.league as string | null) ?? null, event: String(r.event), market: r.market as BetMarket, pick: String(r.pick), line: r.line === null || r.line === undefined ? null : Number(r.line),
      odds: String(r.odds), decimal: dec, american: p.american, stake: Number(r.stake), book: (r.book as string | null) ?? null, notes: (r.notes as string | null) ?? null, status: r.status as BetStatus, profit: r.profit === null ? null : Number(r.profit),
      settledAt: (r.settled_at as string | null) ?? null, settledBy: (r.settled_by as Bet['settledBy']) ?? null, eventId: (r.event_id as string | null) ?? null, eventStart: (r.event_start as string | null) ?? null, side: (r.side as Bet['side']) ?? null,
      oddsEventId: (r.odds_event_id as string | null) ?? null, closingDecimal: r.closing_decimal === null || r.closing_decimal === undefined ? null : Number(r.closing_decimal), warning: (r.warning as string | null) ?? null, legs: JSON.parse(String(r.legs_json ?? '[]')) as string[], createdAt: String(r.created_at),
    };
  }

  get(id: number): Bet | undefined {
    const r = this.#db.prepare('SELECT * FROM sports_bets WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  list(opts: { status?: 'open' | 'settled' | 'all'; from?: string; to?: string; limit?: number } = {}): Bet[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.status === 'open') where.push("status = 'open'");
    else if (opts.status === 'settled') where.push("status != 'open'");
    if (opts.from) {
      where.push('date >= ?');
      args.push(opts.from.slice(0, 10));
    }
    if (opts.to) {
      where.push('date <= ?');
      args.push(opts.to.slice(0, 10));
    }
    const rows = this.#db.prepare(`SELECT * FROM sports_bets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY date DESC, id DESC LIMIT ?`).all(...args, Math.min(Math.max(1, opts.limit ?? 500), 2000)) as Row[];
    return rows.map((r) => this.#view(r));
  }

  // ------------------------------------------------------------ limits and bankroll

  limits(): Limits {
    const v = (k: string) => (this.#db.prepare('SELECT value FROM sports_prefs WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
    const n = (k: string) => {
      const x = v(k);
      return x === null || x === '' ? null : Number(x);
    };
    const cool = v('coolOffUntil');
    return { bankroll: n('bankroll'), weeklyLossLimit: n('weeklyLossLimit'), maxStake: n('maxStake'), coolOffUntil: cool && Date.parse(cool) > this.#now().getTime() ? cool : null };
  }

  #setPref(k: string, value: string | null): void {
    if (value === null) this.#db.prepare('DELETE FROM sports_prefs WHERE key = ?').run(k);
    else this.#db.prepare('INSERT INTO sports_prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, value);
  }

  /** Sets what's given (0 or null turns a limit off). A cool-off can be made longer, never shorter (that's the point of one). */
  setLimits(p: { bankroll?: number | null; weeklyLossLimit?: number | null; maxStake?: number | null; coolOffDays?: number | null }): { limits: Limits; note?: string } {
    const num = (x: number | null | undefined, what: string) => {
      if (x === null || x === 0) return null;
      if (!Number.isFinite(x) || x! < 0) throw new BetError(`${what} must be a positive amount (or 0 to turn it off).`);
      return String(round2(x!));
    };
    if (p.bankroll !== undefined) this.#setPref('bankroll', num(p.bankroll, 'The bankroll'));
    if (p.weeklyLossLimit !== undefined) this.#setPref('weeklyLossLimit', num(p.weeklyLossLimit, 'The weekly loss limit'));
    if (p.maxStake !== undefined) this.#setPref('maxStake', num(p.maxStake, 'The most per bet'));
    let note: string | undefined;
    if (p.coolOffDays !== undefined && p.coolOffDays !== null) {
      const days = Number(p.coolOffDays);
      if (!Number.isFinite(days) || days < 0 || days > 365) throw new BetError('Cool-off days are 1 to 365.');
      const cur = this.limits().coolOffUntil;
      const until = new Date(this.#now().getTime() + days * 86_400_000).toISOString();
      if (cur && Date.parse(cur) > Date.parse(until)) note = `The cool-off you set already runs until ${cur.slice(0, 10)}; it can be made longer, not shorter.`;
      else if (days > 0) this.#setPref('coolOffUntil', until);
    }
    return { limits: this.limits(), ...(note ? { note } : {}) };
  }

  coolingOff(): string | null {
    return this.limits().coolOffUntil;
  }

  /** Net loss (positive number) over the last 7 days from settled bets, and stakes still open from those days. */
  week(): { lost: number; openStakes: number } {
    const since = new Date(this.#now().getTime() - 7 * 86_400_000).toISOString();
    const settled = this.#db.prepare("SELECT COALESCE(SUM(profit), 0) AS p FROM sports_bets WHERE status != 'open' AND settled_at >= ?").get(since) as { p: number };
    const open = this.#db.prepare("SELECT COALESCE(SUM(stake), 0) AS s FROM sports_bets WHERE status = 'open' AND created_at >= ?").get(since) as { s: number };
    return { lost: round2(Math.max(0, -Number(settled.p))), openStakes: round2(Number(open.s)) };
  }

  /** The plain warnings a new stake would cross (empty: none). */
  warnings(stake: number): string[] {
    const l = this.limits();
    const out: string[] = [];
    if (l.coolOffUntil) out.push(`You set a cool-off until ${l.coolOffUntil.slice(0, 10)}.`);
    if (l.maxStake !== null && stake > l.maxStake) out.push(`This stake ($${stake.toFixed(2)}) is over the most per bet you set ($${l.maxStake.toFixed(2)}).`);
    if (l.weeklyLossLimit !== null) {
      const w = this.week();
      const worst = w.lost + w.openStakes + stake;
      if (worst > l.weeklyLossLimit) out.push(`If this and your open bets lose, the last 7 days would be down $${worst.toFixed(2)}, past the weekly loss limit you set ($${l.weeklyLossLimit.toFixed(2)}; down $${w.lost.toFixed(2)} so far).`);
    }
    return out;
  }

  // ------------------------------------------------------------ add and settle

  add(i: AddInput): { bet: Bet; warnings: string[] } {
    const market = String(i.market ?? '').toLowerCase().replace(/^(ml|h2h|money line)$/, 'moneyline').replace(/^(spreads|ats|point spread|handicap)$/, 'spread').replace(/^(totals|over\/under|over under|o\/u)$/, 'total') as BetMarket;
    if (!BET_MARKETS.includes(market)) throw new BetError(`The market is one of: ${BET_MARKETS.join(', ')}.`);
    const stake = Number(String(i.stake ?? '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1e7) throw new BetError('Give the stake as an amount, like 20.');
    const pick = String(i.pick ?? '').trim().slice(0, 120);
    const event = String(i.event ?? '').trim().slice(0, 160);
    const sport = String(i.sport ?? '').trim().toLowerCase().slice(0, 40);
    if (!pick || !event || !sport) throw new BetError('A bet needs the sport, the event and the pick.');
    let price: OddsPrice;
    let legs: string[] = [];
    if (market === 'parlay' && Array.isArray(i.legs) && i.legs.length >= 2 && (i.odds === undefined || i.odds === null || i.odds === '')) {
      const ps = i.legs.map((x) => parseOdds(x));
      price = parlay(ps);
      legs = ps.map((p) => p.input);
    } else {
      price = parseOdds(i.odds);
      if (Array.isArray(i.legs)) legs = i.legs.map((x) => String(x).slice(0, 60)).slice(0, 20);
    }
    let line = i.line === undefined || i.line === null || (i.line as unknown) === '' ? null : Number(i.line);
    if (line !== null && !Number.isFinite(line)) throw new BetError('The line is a number, like -3.5 or 47.5.');
    // "Chiefs -3.5", "Over 47.5": the line from the pick when it wasn't given.
    if (line === null && (market === 'spread' || market === 'total')) {
      const m = /([+-]?\d+(?:\.\d+)?)\s*$/.exec(pick);
      if (m) line = Number(m[1]);
    }
    const date = i.date ? String(i.date).slice(0, 10) : this.#now().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BetError('The date is like 2026-11-13.');
    const warnings = this.warnings(stake);
    const now = this.#now().toISOString();
    let side = i.side ?? null;
    if (!side && market === 'total') side = /^\s*o(ver)?\b/i.test(pick) ? 'over' : /^\s*u(nder)?\b/i.test(pick) ? 'under' : null;
    const r = this.#db
      .prepare('INSERT INTO sports_bets (date, sport, league, event, market, pick, line, odds, decimal, stake, book, notes, event_id, event_start, side, odds_event_id, warning, legs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(date, sport, i.league ?? null, event, market, pick, line, price.input.slice(0, 80), price.decimal, round2(stake), i.book ? String(i.book).slice(0, 60) : null, i.notes ? String(i.notes).slice(0, 500) : null, i.eventId ?? null, i.eventStart ?? null, side, i.oddsEventId ?? null, warnings.length ? warnings.join(' ') : null, JSON.stringify(legs), now);
    return { bet: this.get(Number(r.lastInsertRowid))!, warnings };
  }

  /** Records how a bet ended. Profit: a win pays stake × (decimal − 1) unless the payout (the whole return) is given. */
  settle(id: number, result: BetResult, opts: { payout?: number | null; closingOdds?: unknown; by?: 'person' | 'score' } = {}): Bet {
    const b = this.get(id);
    if (!b) throw new BetError(`There is no bet #${id}. Use bet_list.`);
    if (!['win', 'loss', 'push', 'void'].includes(result)) throw new BetError('The result is win, loss, push or void.');
    let profit: number;
    if (opts.payout !== undefined && opts.payout !== null) {
      const pay = Number(opts.payout);
      if (!Number.isFinite(pay) || pay < 0) throw new BetError('The payout is the whole amount returned, like 45.45.');
      profit = round2(pay - b.stake);
    } else profit = result === 'win' ? round2(b.stake * (b.decimal - 1)) : result === 'loss' ? -b.stake : 0;
    const closing = opts.closingOdds !== undefined && opts.closingOdds !== null && opts.closingOdds !== '' ? parseOdds(opts.closingOdds).decimal : null;
    this.#db.prepare('UPDATE sports_bets SET status = ?, profit = ?, settled_at = ?, settled_by = ?, closing_decimal = COALESCE(?, closing_decimal) WHERE id = ?').run(result, profit, this.#now().toISOString(), opts.by ?? 'person', closing, id);
    return this.get(id)!;
  }

  setClosing(id: number, decimal: number): void {
    this.#db.prepare('UPDATE sports_bets SET closing_decimal = ? WHERE id = ?').run(decimal, id);
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM sports_bets WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------------ odds snapshots (closing line)

  snapshot(rows: { eventId: string; market: string; outcome: string; point?: number; decimal: number; books: number; start?: string }[]): void {
    const at = this.#now().toISOString();
    const ins = this.#db.prepare('INSERT INTO sports_odds_snapshots (event_id, market, outcome, point, decimal, books, start, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows.slice(0, 200)) ins.run(r.eventId, r.market, r.outcome.toLowerCase(), r.point ?? null, r.decimal, r.books, r.start ?? null, at);
    this.#db.prepare('DELETE FROM sports_odds_snapshots WHERE at < ?').run(new Date(this.#now().getTime() - 120 * 86_400_000).toISOString());
  }

  /** The last saved price for a pick before the game started (the closing line), if any. */
  closingFor(b: Bet): number | null {
    if (!b.oddsEventId) return null;
    const market = b.market === 'moneyline' ? 'h2h' : b.market === 'spread' ? 'spreads' : b.market === 'total' ? 'totals' : null;
    if (!market) return null;
    const rows = this.#db.prepare('SELECT outcome, decimal, start, at FROM sports_odds_snapshots WHERE event_id = ? AND market = ? ORDER BY at DESC').all(b.oddsEventId, market) as { outcome: string; decimal: number; start: string | null; at: string }[];
    const pick = b.pick.toLowerCase();
    const hit = rows.find((r) => (!r.start || r.at <= r.start) && (pick.includes(r.outcome) || r.outcome.split(' ').some((w) => w.length > 3 && pick.includes(w))));
    return hit ? hit.decimal : null;
  }

  // ------------------------------------------------------------ stats

  stats(opts: { from?: string; to?: string; by?: 'sport' | 'market' | 'book' } = {}): Stats {
    const bets = this.list({ status: 'all', ...(opts.from ? { from: opts.from } : {}), ...(opts.to ? { to: opts.to } : {}), limit: 2000 });
    const all = statsOf(bets);
    const groups: Record<string, Omit<Stats, 'groups' | 'bankroll' | 'startingBankroll'>> = {};
    if (opts.by) {
      const key = (b: Bet) => (opts.by === 'book' ? b.book ?? '(no book)' : opts.by === 'market' ? b.market : b.sport);
      for (const k of [...new Set(bets.map(key))]) groups[k] = statsOf(bets.filter((b) => key(b) === k));
    }
    const l = this.limits();
    const lifetime = this.#db.prepare("SELECT COALESCE(SUM(profit), 0) AS p FROM sports_bets WHERE status != 'open'").get() as { p: number };
    return { ...all, startingBankroll: l.bankroll, bankroll: l.bankroll === null ? null : round2(l.bankroll + Number(lifetime.p)), ...(opts.by ? { groups } : {}) };
  }
}

export interface Stats {
  bets: number;
  open: number;
  openStakes: number;
  settled: number;
  wins: number;
  losses: number;
  pushes: number;
  staked: number;
  profit: number;
  /** profit / staked on settled bets (voids left out). */
  roi: number | null;
  winRate: number | null;
  avgDecimal: number | null;
  /** Average closing-line value: your decimal / the closing decimal − 1, on bets with a closing price. */
  clv: number | null;
  clvBets: number;
  startingBankroll?: number | null;
  bankroll?: number | null;
  groups?: Record<string, Omit<Stats, 'groups' | 'bankroll' | 'startingBankroll'>>;
}

export function statsOf(bets: Bet[]): Omit<Stats, 'groups' | 'bankroll' | 'startingBankroll'> {
  const settled = bets.filter((b) => b.status !== 'open' && b.status !== 'void');
  const open = bets.filter((b) => b.status === 'open');
  const wins = settled.filter((b) => b.status === 'win').length;
  const losses = settled.filter((b) => b.status === 'loss').length;
  const staked = round2(settled.reduce((a, b) => a + b.stake, 0));
  const profit = round2(settled.reduce((a, b) => a + (b.profit ?? 0), 0));
  const withClose = bets.filter((b) => b.closingDecimal && b.closingDecimal > 1);
  return {
    bets: bets.length,
    open: open.length,
    openStakes: round2(open.reduce((a, b) => a + b.stake, 0)),
    settled: settled.length,
    wins,
    losses,
    pushes: settled.filter((b) => b.status === 'push').length,
    staked,
    profit,
    roi: staked > 0 ? Math.round((profit / staked) * 10000) / 10000 : null,
    winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 10000) / 10000 : null,
    avgDecimal: bets.length ? Math.round((bets.reduce((a, b) => a + b.decimal, 0) / bets.length) * 1000) / 1000 : null,
    clv: withClose.length ? Math.round((withClose.reduce((a, b) => a + (b.decimal / b.closingDecimal! - 1), 0) / withClose.length) * 10000) / 10000 : null,
    clvBets: withClose.length,
  };
}

/** How a bet ended from a final score (moneyline, spread, total); undefined when it can't tell. */
export function resultFromScore(b: Pick<Bet, 'market' | 'line' | 'side'>, home: number, away: number): BetResult | undefined {
  if (b.side === null) return undefined;
  if (b.market === 'total') {
    if (b.line === null || (b.side !== 'over' && b.side !== 'under')) return undefined;
    const total = home + away;
    if (total === b.line) return 'push';
    return (total > b.line) === (b.side === 'over') ? 'win' : 'loss';
  }
  if (b.side !== 'home' && b.side !== 'away') return undefined;
  const mine = b.side === 'home' ? home : away;
  const theirs = b.side === 'home' ? away : home;
  if (b.market === 'moneyline') return mine > theirs ? 'win' : mine < theirs ? 'loss' : 'push';
  if (b.market === 'spread') {
    if (b.line === null) return undefined;
    const d = mine + b.line - theirs;
    return d > 0 ? 'win' : d < 0 ? 'loss' : 'push';
  }
  return undefined;
}
