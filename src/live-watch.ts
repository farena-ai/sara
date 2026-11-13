// E1 (docs/DATA.md): "tell me when" on live data. A watch is a price crossing (or a day's % move),
// a game event (starts, final, score change) or an odds line move/crossing. Checks ride the
// reminder scheduler's 15-second tick (src/reminders.ts; no timer here) and share one budget per
// provider: due price watches are batched into one quote request, game watches into one
// scoreboard per league, odds watches into one request per sport and market (at most every 2 h,
// and never below a reserve of the free monthly credits kept for the person's own questions).
// A watch fires once per crossing (hysteresis: it re-arms only after the value moves back past
// the threshold by a band); each firing posts a card in the chat and, unless the person picked
// "chat" only, a notification (none in quiet hours; the card still lands). When a free quota is
// used up the provider's watches pause with one plain notice and resume when it resets.
// Tables in this companion's own store.db (each household member's space has its own).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { gatherThreads, type ThreadTip } from './biz/followups.ts';
import { DataError, leagueOf, teamMatch, type DataSources, type Game, type OddsEvent, type Quote } from './data-sources.ts';
import { quietNow } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { whenText } from './tools/data.ts';
import { ToolError, type Tool } from './tools/types.ts';

export const LIVE = {
  maxActive: 20,
  maxTotal: 40,
  defaultDays: 30,
  maxDays: 90,
  /** Minimum seconds between checks, per kind (the provider caches answer in between). */
  priceEveryMs: 60_000,
  gameLiveEveryMs: 60_000,
  gameIdleEveryMs: 10 * 60_000,
  oddsEveryMs: 2 * 3600_000,
  /** E3: mail watches read the connected mailboxes at most this often. */
  mailEveryMs: 10 * 60_000,
  /** Odds API credits kept for the person's own questions. */
  oddsReserve: 25,
  priceBand: 0.005,
} as const;

export type LiveKind = 'price' | 'game' | 'odds' | 'mail';
export type LiveWhen = 'above' | 'below' | 'moves_pct' | 'starts' | 'final' | 'score_change' | 'moves_by' | 'arrives' | 'close_late';
export type LiveHow = 'chat' | 'phone' | 'desktop';
const WHEN_BY_KIND: Record<LiveKind, LiveWhen[]> = { price: ['above', 'below', 'moves_pct'], game: ['starts', 'final', 'score_change', 'close_late'], odds: ['moves_by', 'above', 'below'], mail: ['arrives'] };

export interface LiveTarget {
  symbol?: string;
  league?: string;
  team?: string;
  sport?: string;
  market?: 'h2h' | 'spreads' | 'totals';
  book?: string;
  /** E3 mail: a sender (name or address, part of it) and/or words in the subject or preview. */
  from?: string;
  words?: string;
  /** E4: made by following a team (src/sports/follow.ts): renewed while the follow lasts; the label shows this name. */
  followId?: number;
  teamName?: string;
}

/** E4: when a game counts as "late" for a close-game alert (4th quarter, last period, 7th inning, 2nd half from 75'). */
export function lateInGame(g: Game): boolean {
  if (g.state !== 'in' || g.period === undefined) return false;
  const sport = g.league;
  if (sport === 'mlb') return g.period >= 7;
  if (sport === 'nhl') return g.period >= 3;
  if (sport === 'ncaab') return g.period >= 2 && clockMinutes(g.clock) <= 8;
  if (['mls', 'epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'ucl'].includes(sport)) return g.period >= 2 && (parseInt(String(g.clock ?? ''), 10) || 0) >= 75;
  return g.period >= 4; // NFL, college football, NBA, WNBA
}
const clockMinutes = (c: string | undefined): number => {
  const m = /^(\d+):(\d+)/.exec(String(c ?? ''));
  return m ? Number(m[1]) + Number(m[2]) / 60 : 99;
};
export interface LiveWatch {
  id: number;
  kind: LiveKind;
  target: LiveTarget;
  when: LiveWhen;
  value: number | null;
  how: LiveHow;
  conversationId: string | null;
  state: 'active' | 'paused' | 'done';
  reason: string | null;
  armed: boolean;
  lastValue: string | null;
  lastCheckAt: string | null;
  lastFiredAt: string | null;
  fired: number;
  lastError: string | null;
  until: string;
  pausedUntil: string | null;
  createdAt: string;
  /** Plain words: "AAPL above 400". */
  label: string;
}

interface Row {
  id: number;
  kind: LiveKind;
  target_json: string;
  when_kind: LiveWhen;
  value: number | null;
  how: LiveHow;
  conversation_id: string | null;
  state: 'active' | 'paused' | 'done';
  reason: string | null;
  armed: number;
  memo_json: string;
  last_value: string | null;
  last_check_at: string | null;
  last_fired_at: string | null;
  fired: number;
  last_error: string | null;
  until: string;
  paused_until: string | null;
  created_at: string;
}

export class LiveWatchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function ensureTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS live_watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_json TEXT NOT NULL, when_kind TEXT NOT NULL, value REAL,
    how TEXT NOT NULL DEFAULT 'chat', conversation_id TEXT, state TEXT NOT NULL DEFAULT 'active', reason TEXT,
    armed INTEGER NOT NULL DEFAULT 1, memo_json TEXT NOT NULL DEFAULT '{}', last_value TEXT, last_check_at TEXT, last_fired_at TEXT,
    fired INTEGER NOT NULL DEFAULT 0, last_error TEXT, until TEXT NOT NULL, paused_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

export function labelOf(kind: LiveKind, t: LiveTarget, when: LiveWhen, value: number | null): string {
  if (kind === 'mail') return `Email${t.from ? ` from ${t.from}` : ''}${t.words ? ` with “${t.words}”` : ''}`;
  if (kind === 'price') return when === 'moves_pct' ? `${t.symbol} moves ${value}% in a day` : `${t.symbol} ${when} ${value}`;
  if (kind === 'game') return `${t.teamName ?? t.team} (${String(t.league).toUpperCase()}) ${when === 'starts' ? 'game starts' : when === 'final' ? 'final score' : when === 'close_late' ? `close game late (within ${value})` : 'score changes'}`;
  const what = `${t.teamName ?? t.team} ${t.market === 'spreads' ? 'spread' : t.market === 'totals' ? 'total' : 'moneyline'}${t.book ? ` at ${t.book}` : ''}`;
  return when === 'moves_by' ? `${what} moves by ${value}` : `${what} ${when} ${value}`;
}

const upper = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/^\$/, '');

/** Reads the connected mailboxes' recent conversations (E6's follow-ups reader; tests pass a fake). */
export type MailReader = (app: AppContext, lookbackDays: number) => Promise<{ threads: ThreadTip[]; problems: string[] }>;

export class LiveWatches {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #readMail: MailReader;
  #running: Promise<number> | undefined;
  /** Last network check per group key (kind:group), for the per-kind minimum interval. */
  readonly #groupAt = new Map<string, number>();

  constructor(app: AppContext, db: DatabaseSync, readMail: MailReader = (a, days) => gatherThreads(a, days)) {
    this.#app = app;
    this.#db = db;
    this.#readMail = readMail;
    ensureTables(db);
  }

  #ds(): DataSources | undefined {
    return this.#app.dataSources;
  }

  #view(r: Row): LiveWatch {
    const target = JSON.parse(r.target_json) as LiveTarget;
    return { id: r.id, kind: r.kind, target, when: r.when_kind, value: r.value, how: r.how, conversationId: r.conversation_id, state: r.state, reason: r.reason, armed: Boolean(r.armed), lastValue: r.last_value, lastCheckAt: r.last_check_at, lastFiredAt: r.last_fired_at, fired: r.fired, lastError: r.last_error, until: r.until, pausedUntil: r.paused_until, createdAt: r.created_at, label: labelOf(r.kind, target, r.when_kind, r.value) };
  }

  #rows(where = '1 = 1', ...args: (string | number)[]): Row[] {
    return this.#db.prepare(`SELECT * FROM live_watches WHERE ${where} ORDER BY id`).all(...args) as unknown as Row[];
  }

  #set(id: number, patch: Record<string, string | number | null>): void {
    const keys = Object.keys(patch);
    this.#db.prepare(`UPDATE live_watches SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), this.#app.now().toISOString(), id);
  }

  list(): LiveWatch[] {
    return this.#rows().map((r) => this.#view(r));
  }

  get(id: number): LiveWatch | undefined {
    const r = this.#rows('id = ?', id)[0];
    return r ? this.#view(r) : undefined;
  }

  /** Today's small "Watching" card. */
  todayTile(): { items: { id: number; label: string; state: string; lastValue: string | null; lastCheckAt: string | null }[] } | undefined {
    const items = this.#rows("state != 'done'").map((r) => this.#view(r)).map((w) => ({ id: w.id, label: w.label, state: w.state, lastValue: w.lastValue, lastCheckAt: w.lastCheckAt }));
    return items.length ? { items: items.slice(0, 8) } : undefined;
  }

  add(input: { kind?: unknown; from?: unknown; words?: unknown; symbol?: unknown; league?: unknown; team?: unknown; sport?: unknown; market?: unknown; book?: unknown; when?: unknown; value?: unknown; until?: unknown; how?: unknown; conversationId?: string | null; followId?: number; teamName?: string }): LiveWatch {
    const kind = String(input.kind ?? '') as LiveKind;
    if (!WHEN_BY_KIND[kind]) throw new LiveWatchError(400, 'Kind is price, game, odds or mail.');
    const when = String(input.when ?? '') as LiveWhen;
    if (!WHEN_BY_KIND[kind].includes(when)) throw new LiveWatchError(400, `For a ${kind} watch, "when" is one of: ${WHEN_BY_KIND[kind].join(', ')}.`);
    const t: LiveTarget = {};
    let value: number | null = null;
    const needValue = !['starts', 'final', 'score_change', 'arrives'].includes(when);
    if (when === 'close_late' && (input.value === undefined || input.value === null || input.value === '')) input = { ...input, value: 3 };
    if (needValue) {
      value = Number(input.value);
      if (input.value === undefined || input.value === null || input.value === '' || !Number.isFinite(value)) throw new LiveWatchError(400, 'Give the number to watch for (value).');
      if ((when === 'moves_pct' || when === 'moves_by') && value <= 0) throw new LiveWatchError(400, 'The move must be more than 0.');
    }
    try {
      if (kind === 'price') {
        t.symbol = upper(input.symbol);
        if (!/^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/.test(t.symbol)) throw new LiveWatchError(400, 'Give a ticker symbol, like AAPL.');
      } else if (kind === 'mail') {
        // E3: email from someone / with words, from the person's own connected mailboxes (owner only:
        // household members and the demo have none, so they get the plain "connect a mailbox" answer).
        if (input.from) t.from = String(input.from).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
        if (input.words) t.words = String(input.words).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
        if (!t.from && !t.words) throw new LiveWatchError(400, 'Say who the email is from (from) or which words to look for (words).');
        if (!this.#app.mailAccounts?.list().some((a) => !a.problem)) throw new LiveWatchError(400, 'No mailbox is connected. Connect one in Settings → Email and calendar first.');
      } else if (kind === 'game') {
        t.league = leagueOf(input.league);
        t.team = String(input.team ?? '').trim().slice(0, 40);
        if (!t.team) throw new LiveWatchError(400, 'Which team?');
      } else {
        t.sport = String(input.sport ?? input.league ?? '').trim().toLowerCase().slice(0, 60);
        t.team = String(input.team ?? '').trim().slice(0, 40);
        const m = String(input.market ?? 'h2h');
        if (!['h2h', 'spreads', 'totals'].includes(m)) throw new LiveWatchError(400, 'Market is h2h, spreads or totals.');
        t.market = m as LiveTarget['market'];
        if (input.book) t.book = String(input.book).trim().toLowerCase().slice(0, 40);
        if (!t.sport || !t.team) throw new LiveWatchError(400, 'Odds watches need the sport and a team.');
      }
      if (typeof input.followId === 'number') t.followId = input.followId;
      if (input.teamName) t.teamName = String(input.teamName).slice(0, 60);
    } catch (err) {
      if (err instanceof DataError) throw new LiveWatchError(400, err.message);
      throw err;
    }
    const how = (['chat', 'phone', 'desktop'].includes(String(input.how)) ? String(input.how) : 'phone') as LiveHow;
    const now = this.#app.now();
    let until = new Date(now.getTime() + LIVE.defaultDays * 86_400_000);
    if (input.until) {
      const u = new Date(String(input.until));
      if (Number.isNaN(u.getTime()) || u.getTime() <= now.getTime()) throw new LiveWatchError(400, '"until" must be a future date (YYYY-MM-DD or a date and time).');
      until = new Date(Math.min(u.getTime(), now.getTime() + LIVE.maxDays * 86_400_000));
    }
    const total = this.#rows().length;
    if (total >= LIVE.maxTotal) throw new LiveWatchError(409, `You have ${LIVE.maxTotal} watches. Remove one first.`);
    if (this.#rows("state = 'active'").length >= LIVE.maxActive) throw new LiveWatchError(409, `${LIVE.maxActive} watches are already on. Remove one first.`);
    const iso = now.toISOString();
    const r = this.#db.prepare('INSERT INTO live_watches (kind, target_json, when_kind, value, how, conversation_id, until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(kind, JSON.stringify(t), when, value, how, input.conversationId ?? null, until.toISOString(), iso, iso);
    return this.get(Number(r.lastInsertRowid))!;
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM live_watches WHERE id = ?').run(id).changes) > 0;
  }

  /** From ReminderScheduler.tick(): starts one check pass if none is running. */
  due(now: Date = this.#app.now()): void {
    if (this.#running || privateLocalOn()) return;
    if (!this.#db.prepare("SELECT 1 FROM live_watches WHERE state != 'done' LIMIT 1").get()) return;
    this.#running = this.check(now)
      .catch((err: Error) => {
        console.warn(`live watches: ${err.message}`);
        return 0;
      })
      .finally(() => (this.#running = undefined));
  }

  /** One pass: ends expired watches, resumes paused ones whose quota reset, checks what's due. Returns watches fired. */
  async check(now: Date = this.#app.now()): Promise<number> {
    const t = now.getTime();
    const iso = now.toISOString();
    for (const r of this.#rows("state != 'done'")) {
      // E4: a followed team's watches last as long as the follow (renewed here, no timer).
      if (Date.parse(r.until) <= t && (JSON.parse(r.target_json) as LiveTarget).followId !== undefined) this.#set(r.id, { until: new Date(t + LIVE.defaultDays * 86_400_000).toISOString() });
      else if (Date.parse(r.until) <= t) this.#set(r.id, { state: 'done', reason: 'until' });
      else if (r.state === 'paused' && r.reason === 'quota' && r.paused_until && Date.parse(r.paused_until) <= t) this.#set(r.id, { state: 'active', reason: null, paused_until: null });
    }
    const active = this.#rows("state = 'active'");
    let fired = 0;
    // E3: mail, at most every 10 minutes, one read of the recent inbox for all mail watches.
    const mails = active.filter((r) => r.kind === 'mail');
    if (mails.length && this.#dueGroup('mail', t, LIVE.mailEveryMs)) {
      try {
        const res = await this.#readMail(this.#app, 2);
        for (const r of mails) fired += this.#evalMail(r, res.threads, res.problems, iso);
      } catch (err) {
        this.#failed(mails, err, iso);
      }
    }
    const ds = this.#ds();
    if (!ds) return fired;
    // Prices: every due symbol in one request.
    const prices = active.filter((r) => r.kind === 'price');
    if (prices.length && this.#dueGroup('price', t, LIVE.priceEveryMs)) {
      const syms = [...new Set(prices.map((r) => (JSON.parse(r.target_json) as LiveTarget).symbol!))];
      try {
        const res = await ds.quotes(syms);
        const by = new Map(res.quotes.map((q) => [q.symbol, q]));
        for (const r of prices) {
          const q = by.get((JSON.parse(r.target_json) as LiveTarget).symbol!);
          if (!q) this.#set(r.id, { last_check_at: iso, last_error: 'No price for this symbol.' });
          else if (this.#evalPrice(r, q, iso)) fired++;
        }
      } catch (err) {
        this.#failed(prices, err, iso);
      }
    }
    // Games: one scoreboard per league.
    const games = active.filter((r) => r.kind === 'game');
    for (const [league, rows] of group(games, (r) => (JSON.parse(r.target_json) as LiveTarget).league!)) {
      const live = rows.some((r) => {
        const m = JSON.parse(r.memo_json) as { next?: string; live?: boolean };
        return m.live || (m.next && Date.parse(m.next) - t < 15 * 60_000);
      });
      if (!this.#dueGroup(`game:${league}`, t, live ? LIVE.gameLiveEveryMs : LIVE.gameIdleEveryMs)) continue;
      try {
        const res = await ds.scores(league, { fresh: live });
        for (const r of rows) if (this.#evalGame(r, res.games, res.source, iso)) fired++;
      } catch (err) {
        this.#failed(rows, err, iso);
      }
    }
    // Odds: one request per sport and market, every 2 h, keeping a reserve of the monthly credits.
    const odds = active.filter((r) => r.kind === 'odds');
    for (const [key, rows] of group(odds, (r) => {
      const x = JSON.parse(r.target_json) as LiveTarget;
      return `${x.sport}|${x.market}`;
    })) {
      if (!this.#dueGroup(`odds:${key}`, t, LIVE.oddsEveryMs)) continue;
      const [sport, market] = key.split('|');
      const q = ds.quota(ds.provider('odds').id);
      if (q && q.remaining !== null && q.remaining <= LIVE.oddsReserve) {
        this.#pauseQuota(rows, Date.parse(q.pausedUntil ?? '') || nextMonth(t), `kept the last ${LIVE.oddsReserve} free credits for your own questions`);
        continue;
      }
      try {
        const res = await ds.odds(sport, { markets: [market] });
        for (const r of rows) if (this.#evalOdds(r, res.events, res.source, iso)) fired++;
      } catch (err) {
        this.#failed(rows, err, iso);
      }
    }
    return fired;
  }

  #dueGroup(key: string, t: number, every: number): boolean {
    const last = this.#groupAt.get(key);
    if (last !== undefined && t - last < every) return false;
    this.#groupAt.set(key, t);
    return true;
  }

  #failed(rows: Row[], err: unknown, iso: string): void {
    if (err instanceof DataError && err.code === 'quota') return this.#pauseQuota(rows, err.until ?? Date.parse(iso) + 3600_000, err.message);
    const msg = (err as Error).message.slice(0, 300);
    for (const r of rows) this.#set(r.id, { last_check_at: iso, last_error: msg });
  }

  /** The free quota is gone: pause these watches until it resets, with one plain notice per chat. */
  #pauseQuota(rows: Row[], until: number, why: string): void {
    const untilIso = new Date(until).toISOString();
    const told = new Set<string>();
    for (const r of rows) {
      if (r.state === 'paused') continue;
      this.#set(r.id, { state: 'paused', reason: 'quota', paused_until: untilIso, last_error: why.slice(0, 300) });
      const conv = this.#conversation(r);
      if (told.has(conv)) continue;
      told.add(conv);
      const text = `Paused ${rows.length === 1 ? 'a watch' : `${rows.length} watches`} (${labelOf(r.kind, JSON.parse(r.target_json), r.when_kind, r.value)}${rows.length > 1 ? ' and others' : ''}): ${why}. They start again ${whenText(untilIso, this.#app.settings.get().timeZone)}.`;
      this.#card(r, conv, text, { paused: true });
    }
  }

  #evalPrice(r: Row, q: Quote, iso: string): boolean {
    const v = r.value!;
    const shown = `${q.price}${q.currency ? ` ${q.currency}` : ''} (${q.changePct === null ? 'n/a' : `${q.changePct > 0 ? '+' : ''}${q.changePct}%`}) at ${whenText(q.at, this.#app.settings.get().timeZone)} from ${q.source}`;
    let met: boolean;
    let rearm: boolean;
    if (r.when_kind === 'moves_pct') {
      const move = Math.abs(q.changePct ?? 0);
      met = q.changePct !== null && move >= v;
      const memo = JSON.parse(r.memo_json) as { day?: string };
      const day = q.at.slice(0, 10);
      rearm = move < v * 0.8 || (memo.day !== undefined && memo.day !== day);
      this.#set(r.id, { memo_json: JSON.stringify({ day }) });
    } else {
      const band = Math.max(Math.abs(v) * LIVE.priceBand, 0.01);
      met = r.when_kind === 'above' ? q.price >= v : q.price <= v;
      rearm = r.when_kind === 'above' ? q.price < v - band : q.price > v + band;
    }
    return this.#settle(r, met, rearm, shown, iso, () => `${q.symbol} is ${r.when_kind === 'moves_pct' ? `${q.changePct! > 0 ? 'up' : 'down'} ${Math.abs(q.changePct!)}% today` : `${r.when_kind} ${v}`}: ${shown}.`);
  }

  /** Fire once per crossing: met while armed fires and disarms; re-arms only past the band. */
  #settle(r: Row, met: boolean, rearm: boolean, shown: string, iso: string, text: () => string): boolean {
    const patch: Record<string, string | number | null> = { last_value: shown.slice(0, 200), last_check_at: iso, last_error: null };
    let fire = false;
    if (met && r.armed) {
      fire = true;
      patch.armed = 0;
    } else if (!met && !r.armed && rearm) patch.armed = 1;
    this.#set(r.id, patch);
    if (fire) this.#fire(r, text(), iso);
    return fire;
  }

  #evalGame(r: Row, games: Game[], source: string, iso: string): boolean {
    const target = JSON.parse(r.target_json) as LiveTarget;
    const memo = JSON.parse(r.memo_json) as { seen?: Record<string, { state: string; score: string }>; fired?: string[]; next?: string; live?: boolean };
    memo.seen ??= {};
    memo.fired ??= [];
    const mine = games.filter((g) => teamMatch(g, target.team!));
    const tz = this.#app.settings.get().timeZone;
    let fired = false;
    for (const g of mine) {
      const score = `${g.away.score ?? '-'}-${g.home.score ?? '-'}`;
      const prev = memo.seen[g.id];
      const line = `${g.away.abbr || g.away.name} ${g.away.score ?? ''} @ ${g.home.abbr || g.home.name} ${g.home.score ?? ''}`.replace(/\s+/g, ' ').trim();
      let event: string | undefined;
      let text = '';
      if (r.when_kind === 'starts' && prev?.state === 'pre' && g.state === 'in') {
        event = `${g.id}:start`;
        text = `${g.name} has started (${g.detail}). Source: ${source}.`;
      } else if (r.when_kind === 'final' && prev && prev.state !== 'post' && g.state === 'post') {
        event = `${g.id}:final`;
        text = `Final: ${line}${g.detail && g.detail !== 'Final' ? ` (${g.detail})` : ''}. Source: ${source}.`;
      } else if (r.when_kind === 'score_change' && prev && g.state === 'in' && prev.score !== score) {
        event = `${g.id}:${score}`;
        text = `Score: ${line} (${g.detail}). Source: ${source}.`;
      } else if (r.when_kind === 'close_late' && g.state === 'in' && lateInGame(g) && g.home.score !== null && g.away.score !== null && Math.abs(g.home.score - g.away.score) <= (r.value ?? 3)) {
        event = `${g.id}:close`;
        text = `Close game late: ${line} (${g.detail}${g.situation ? `; ${g.situation}` : ''}). Source: ${source}.`;
      }
      memo.seen[g.id] = { state: g.state, score };
      if (event && !memo.fired.includes(event)) {
        memo.fired = [...memo.fired, event].slice(-50);
        this.#fire(r, text, iso);
        fired = true;
      }
    }
    const upcoming = mine.filter((g) => g.state === 'pre').map((g) => g.start).sort()[0];
    memo.live = mine.some((g) => g.state === 'in');
    if (upcoming) memo.next = upcoming;
    else delete memo.next;
    const g0 = mine.find((g) => g.state === 'in') ?? mine[0];
    const shown = g0 ? `${g0.away.abbr || g0.away.name} ${g0.away.score ?? ''} @ ${g0.home.abbr || g0.home.name} ${g0.home.score ?? ''} · ${g0.state === 'pre' ? `starts ${whenText(g0.start, tz)}` : g0.detail}`.replace(/\s+/g, ' ') : `No game today (${source})`;
    this.#set(r.id, { memo_json: JSON.stringify(memo), last_value: shown.slice(0, 200), last_check_at: iso, last_error: null });
    return fired;
  }

  /** The watched number of an odds line: h2h price, the team's spread, or the total. Median across books unless one is named. */
  static oddsValue(events: OddsEvent[], t: LiveTarget): { value: number; event: OddsEvent; books: number } | undefined {
    const team = (t.team ?? '').toLowerCase();
    const e = events.find((x) => x.home.toLowerCase().includes(team) || x.away.toLowerCase().includes(team));
    if (!e) return undefined;
    const vals: number[] = [];
    for (const l of e.lines) {
      if (l.market !== t.market) continue;
      if (t.book && !(l.bookKey.includes(t.book) || l.book.toLowerCase().includes(t.book))) continue;
      const o = t.market === 'totals' ? l.outcomes.find((x) => x.name.toLowerCase() === 'over') : l.outcomes.find((x) => x.name.toLowerCase().includes(team));
      if (!o) continue;
      const v = t.market === 'h2h' ? o.price : o.point;
      if (v !== undefined && Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return undefined;
    vals.sort((a, b) => a - b);
    const mid = vals.length >> 1;
    return { value: vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2, event: e, books: vals.length };
  }

  #evalOdds(r: Row, events: OddsEvent[], source: string, iso: string): boolean {
    const t = JSON.parse(r.target_json) as LiveTarget;
    const got = LiveWatches.oddsValue(events, t);
    if (!got) {
      this.#set(r.id, { last_check_at: iso, last_error: `No ${t.market} line for ${t.team} right now.` });
      return false;
    }
    const memo = JSON.parse(r.memo_json) as { baseline?: number; event?: string };
    const what = t.market === 'h2h' ? 'moneyline' : t.market === 'spreads' ? 'spread' : 'total';
    const shown = `${got.event.away} @ ${got.event.home}: ${what} ${got.value > 0 && t.market === 'h2h' ? '+' : ''}${got.value}${t.book ? ` at ${t.book}` : ` (median of ${got.books} books)`} from ${source}`;
    if (r.when_kind === 'moves_by') {
      if (memo.baseline === undefined || memo.event !== got.event.id) {
        this.#set(r.id, { memo_json: JSON.stringify({ baseline: got.value, event: got.event.id }), last_value: shown.slice(0, 200), last_check_at: iso, last_error: null });
        return false;
      }
      const moved = got.value - memo.baseline;
      if (Math.abs(moved) >= r.value!) {
        this.#set(r.id, { memo_json: JSON.stringify({ baseline: got.value, event: got.event.id }), last_value: shown.slice(0, 200), last_check_at: iso, last_error: null });
        this.#fire(r, `The ${what} moved ${moved > 0 ? '+' : ''}${Math.round(moved * 100) / 100} (from ${memo.baseline}): ${shown}.`, iso);
        return true;
      }
      this.#set(r.id, { last_value: shown.slice(0, 200), last_check_at: iso, last_error: null });
      return false;
    }
    const v = r.value!;
    const band = t.market === 'h2h' ? 5 : 0.5;
    const met = r.when_kind === 'above' ? got.value >= v : got.value <= v;
    const rearm = r.when_kind === 'above' ? got.value < v - band : got.value > v + band;
    return this.#settle(r, met, rearm, shown, iso, () => `The ${what} is ${r.when_kind} ${v}: ${shown}.`);
  }

  /** Fires once per new matching message that arrived after the watch was set. */
  #evalMail(r: Row, threads: ThreadTip[], problems: string[], iso: string): number {
    const t = JSON.parse(r.target_json) as LiveTarget;
    const memo = JSON.parse(r.memo_json) as { fired?: string[] };
    const done = new Set(memo.fired ?? []);
    const since = Date.parse(r.created_at);
    const from = (t.from ?? '').toLowerCase();
    const words = (t.words ?? '').toLowerCase().split(/\s*,\s*/).filter(Boolean);
    const tz = this.#app.settings.get().timeZone;
    let n = 0;
    const hits = threads
      .filter((m) => !m.fromMe && Date.parse(m.date) > since)
      .filter((m) => !from || m.from.toLowerCase().includes(from))
      .filter((m) => !words.length || words.some((w) => `${m.subject}\n${m.snippet}`.toLowerCase().includes(w)))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    for (const m of hits) {
      const key = `${m.account}:${m.latestId}`;
      if (done.has(key)) continue;
      done.add(key);
      // Only who and the subject: the message itself stays in the mailbox (and out of notifications).
      this.#fire(r, `New email from ${m.from.replace(/[\r\n]+/g, ' ').slice(0, 120)}: “${m.subject.replace(/[\r\n]+/g, ' ').slice(0, 160)}” (${m.account}, ${whenText(m.date, tz)}). Open your mail to read it.`, iso);
      n++;
    }
    this.#set(r.id, { memo_json: JSON.stringify({ fired: [...done].slice(-200) }), last_value: hits.length ? `${hits.length} matching since the watch began` : 'no new matching email', last_check_at: iso, last_error: problems.length ? problems.join('; ').slice(0, 300) : null });
    return n;
  }

  #ownChat(id: string): boolean {
    const c = this.#app.store.getConversation(id);
    return Boolean(c && !c.partner);
  }

  #conversation(r: Row): string {
    if (r.conversation_id && this.#ownChat(r.conversation_id)) return r.conversation_id;
    const store = this.#app.store;
    return (store.listConversations().find((c) => !c.partner && c.channel === 'web') ?? store.createConversation({ title: 'Watches' })).id;
  }

  #card(r: Row, conversationId: string, text: string, extra: Record<string, unknown> = {}): void {
    const msg = this.#app.store.addMessage(conversationId, 'notice', `livewatch:${text}`, { liveWatch: { id: r.id, kind: r.kind, label: labelOf(r.kind, JSON.parse(r.target_json), r.when_kind, r.value), ...extra } });
    this.#app.events?.publish({ type: 'message', conversationId, message: msg, reason: 'reply' });
    if (r.how !== 'chat' && !quietNow(this.#app, this.#app.now())) void this.#app.push?.notifyOwner(`Watch: ${labelOf(r.kind, JSON.parse(r.target_json), r.when_kind, r.value)}`.slice(0, 120), text.slice(0, 300), conversationId, `livewatch-${r.id}`).catch(() => {});
  }

  #fire(r: Row, text: string, iso: string): void {
    this.#db.prepare('UPDATE live_watches SET fired = fired + 1, last_fired_at = ? WHERE id = ?').run(iso, r.id);
    this.#card(r, this.#conversation(r), text);
  }
}

function group<T>(list: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}
const nextMonth = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** watch_add / watch_list / watch_remove: the person's "tell me when" on live data. */
export function createLiveWatchTools(getApp: () => AppContext): Tool[] {
  const lw = () => {
    const w = getApp().liveWatches;
    if (!w) throw new ToolError('Watches are not available here.');
    return w;
  };
  const wrap = (f: () => string): string => {
    try {
      return f();
    } catch (err) {
      if (err instanceof LiveWatchError) throw new ToolError(err.message);
      throw err;
    }
  };
  const avail = () => Boolean(getApp().liveWatches) && !privateLocalOn();
  const fmt = (w: LiveWatch) => `#${w.id} ${w.label} · ${w.state}${w.reason ? ` (${w.reason})` : ''}${w.lastValue ? ` · last: ${w.lastValue}` : ''}${w.lastCheckAt ? ` · checked ${whenText(w.lastCheckAt, getApp().settings.get().timeZone)}` : ' · not checked yet'}${w.lastError ? ` · problem: ${w.lastError}` : ''} · tells: ${w.how} · until ${whenText(w.until, getApp().settings.get().timeZone)}`;
  return [
    {
      defaultPermission: 'auto',
      isAvailable: avail,
      spec: {
        name: 'watch_add',
        description: 'Set a "tell me when" watch on live data: a stock price going above/below a number or moving a % in a day (kind price), a team\'s game starting, ending or the score changing (kind game), an odds line moving by X or crossing a number (kind odds), or a new email from someone or with certain words in their connected mail (kind mail, when arrives). She checks it in the background and tells the person with a chat card and a notification, once per crossing. Use it when they say "tell me when", "alert me if", "let me know when".',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['price', 'game', 'odds', 'mail'] },
            when: { type: 'string', enum: ['above', 'below', 'moves_pct', 'starts', 'final', 'score_change', 'close_late', 'moves_by', 'arrives'], description: 'price: above, below, moves_pct. game: starts, final, score_change, close_late (a close game late on: value = within how many points, default 3). odds: moves_by, above, below. mail: arrives.' },
            from: { type: 'string', description: 'mail: the sender (a name or address, or part of it).' },
            words: { type: 'string', description: 'mail: words or phrases (comma-separated) in the subject or preview.' },
            value: { type: 'number', description: 'The threshold (price, percent, line or points). Not used for game watches.' },
            symbol: { type: 'string', description: 'price: the ticker, e.g. AAPL.' },
            league: { type: 'string', description: 'game: nfl, nba, mlb, nhl, ncaaf, ncaab, mls, epl…' },
            sport: { type: 'string', description: 'odds: a league (nfl, nba…) or an Odds API sport key.' },
            team: { type: 'string', description: 'game and odds: the team.' },
            market: { type: 'string', enum: ['h2h', 'spreads', 'totals'], description: 'odds: which line (default h2h = moneyline).' },
            book: { type: 'string', description: 'odds: optional sportsbook (default: the median of all books).' },
            until: { type: 'string', description: 'Optional end date (YYYY-MM-DD). Default 30 days, at most 90.' },
            how: { type: 'string', enum: ['chat', 'phone', 'desktop'], description: 'chat: a card in this chat only. phone or desktop: the card plus a notification on their devices (default phone).' },
          },
          required: ['kind', 'when'],
          additionalProperties: false,
        },
      },
      summarize: (a) => `Watch: ${String(a.symbol ?? a.team ?? a.from ?? a.words ?? '')} ${String(a.when ?? '')} ${a.value ?? ''}`.trim(),
      run: async (a, ctx) =>
        wrap(() => {
          const w = lw().add({ ...a, conversationId: ctx.conversationId ?? null });
          return `Watch #${w.id} is on: ${w.label}. She checks ${w.kind === 'mail' ? 'their connected mail every 10 minutes (only new messages after now; the alert shows the sender and subject)' : w.kind === 'odds' ? 'every 2 hours (to save the free odds credits)' : w.kind === 'game' ? 'every minute while the game is on, every 10 minutes otherwise' : 'about every minute'} until ${whenText(w.until, getApp().settings.get().timeZone)}, and tells them ${w.how === 'chat' ? 'with a card in this chat' : 'with a card here and a notification'}, once per crossing. Confirm in a sentence; it's listed on Today and in Settings → Data sources.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: () => Boolean(getApp().liveWatches),
      spec: { name: 'watch_list', description: 'List the person\'s "tell me when" watches on live data (prices, games, odds, email): what each watches, its last value and time, and any problem.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      summarize: () => 'Listing watches',
      run: async () => {
        const list = lw().list();
        return list.length ? list.map(fmt).join('\n') : 'No watches yet.';
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(getApp().liveWatches),
      spec: { name: 'watch_remove', description: 'Remove one of the person\'s "tell me when" watches by its number (from watch_list).', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false } },
      summarize: (a) => `Remove watch #${String(a.id ?? '')}`,
      run: async (a) => {
        const id = Number(a.id);
        const w = lw().get(id);
        if (!w || !lw().remove(id)) throw new ToolError(`There is no watch #${String(a.id)}. Use watch_list.`);
        return `Removed watch #${id} (${w.label}).`;
      },
    },
  ];
}
