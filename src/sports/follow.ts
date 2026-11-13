// E4 (docs/SPORTS.md): the person's teams. Following a team (resolved through ESPN's team list)
// turns on E1 game watches for it (game starts, final score, and an optional close-game alert late
// on; an optional line-move odds watch), all in E1's engine on the reminder tick (no timer here);
// unfollowing removes them. Upcoming games go into a calendar on request: Sara's own planner
// (tasks in a "Games" project) or, when the person asks and it's connected, their Google or
// Outlook calendar; each game is keyed by ESPN's event id, so syncing again never duplicates and
// moves an entry whose time changed. The briefing gets one line about today's games and recent
// results, Today a "My teams" tile. The bet log (bets.ts) lives in the same store. Each household
// member's follows, calendar keys and bets live in their own space's store.db.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { LEAGUES, leagueOf, type EspnTeam, type Game } from '../data-sources.ts';
import { zonedParts } from '../planner.ts';
import { BetLog } from './bets.ts';

export interface Follow {
  id: number;
  league: string;
  teamId: string;
  abbr: string;
  name: string;
  short: string;
  closeMargin: number | null;
  lineMove: number | null;
  watchIds: number[];
  createdAt: string;
}

export type CalendarTarget = 'planner' | 'google' | 'outlook';

export interface CalendarResult {
  team: string;
  target: CalendarTarget;
  added: { title: string; start: string; tbd: boolean }[];
  moved: { title: string; from: string; to: string }[];
  unchanged: number;
  source: string;
  at: string;
}

export class SportsError extends Error {}

interface Row {
  [k: string]: unknown;
}

function ensure(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sports_follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, league TEXT NOT NULL, team_id TEXT NOT NULL, abbr TEXT NOT NULL, name TEXT NOT NULL, short TEXT NOT NULL,
    close_margin REAL, line_move REAL, watch_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE (league, team_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS sports_calendar (
    event_id TEXT NOT NULL, target TEXT NOT NULL, team_key TEXT NOT NULL, ref TEXT NOT NULL, start TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (event_id, target))`);
}

const GCAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
/** How many teams one person follows (each is 2-4 watches in E1's shared limit of 20). */
export const MAX_FOLLOWS = 6;

export class Sports {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly bets: BetLog;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    ensure(db);
    this.bets = new BetLog(db, () => app.now());
  }

  #view(r: Row): Follow {
    return { id: Number(r.id), league: String(r.league), teamId: String(r.team_id), abbr: String(r.abbr), name: String(r.name), short: String(r.short), closeMargin: r.close_margin === null ? null : Number(r.close_margin), lineMove: r.line_move === null ? null : Number(r.line_move), watchIds: JSON.parse(String(r.watch_ids)) as number[], createdAt: String(r.created_at) };
  }

  list(): Follow[] {
    return (this.#db.prepare('SELECT * FROM sports_follows ORDER BY id').all() as Row[]).map((r) => this.#view(r));
  }

  isFollowing(id: number): boolean {
    return Boolean(this.#db.prepare('SELECT 1 FROM sports_follows WHERE id = ?').get(id));
  }

  #ds() {
    const d = this.#app.dataSources;
    if (!d) throw new SportsError('Live sports data is not available here.');
    return d;
  }

  /** A followed team by name ("Chiefs", "KC", "Royals"), optionally in a league. */
  find(team: string, league?: string): Follow | undefined {
    const q = String(team ?? '').trim().toLowerCase();
    if (!q) return undefined;
    const l = league ? leagueOf(league) : undefined;
    const all = this.list().filter((f) => !l || f.league === l);
    return all.find((f) => [f.abbr, f.name, f.short].some((n) => n.toLowerCase() === q)) ?? all.find((f) => f.name.toLowerCase().includes(q) || f.short.toLowerCase().includes(q));
  }

  /** Follow a team: resolve it at ESPN, then turn on its E1 watches. Following again updates the alerts. */
  async follow(input: { league: string; team: string; closeMargin?: number | null; lineMove?: number | null; conversationId?: string | null }): Promise<{ follow: Follow; alerts: string[]; notes: string[] }> {
    const league = leagueOf(input.league);
    const team = await this.#ds().team(league, input.team);
    const existing = this.list().find((f) => f.league === league && f.teamId === team.id);
    if (!existing && this.list().length >= MAX_FOLLOWS) throw new SportsError(`You follow ${MAX_FOLLOWS} teams already. Unfollow one first.`);
    const closeMargin = input.closeMargin === undefined ? existing?.closeMargin ?? null : input.closeMargin && input.closeMargin > 0 ? Math.min(input.closeMargin, 30) : null;
    const lineMove = input.lineMove === undefined ? existing?.lineMove ?? null : input.lineMove && input.lineMove > 0 ? Math.min(input.lineMove, 50) : null;
    const now = this.#app.now().toISOString();
    let id: number;
    if (existing) {
      this.#removeWatches(existing);
      id = existing.id;
      this.#db.prepare('UPDATE sports_follows SET close_margin = ?, line_move = ?, abbr = ?, name = ?, short = ? WHERE id = ?').run(closeMargin, lineMove, team.abbr, team.name, team.short, id);
    } else {
      id = Number(this.#db.prepare('INSERT INTO sports_follows (league, team_id, abbr, name, short, close_margin, line_move, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(league, team.id, team.abbr, team.name, team.short, closeMargin, lineMove, now).lastInsertRowid);
    }
    const notes: string[] = [];
    const ids: number[] = [];
    const labels: string[] = [];
    const lw = this.#app.liveWatches;
    if (!lw) notes.push('Game alerts are not available here, so only the schedule and scores work.');
    else {
      const base = { kind: 'game', league, team: `id:${team.id}`, teamName: team.short, followId: id, how: 'phone', conversationId: input.conversationId ?? null };
      const wants: Record<string, unknown>[] = [{ ...base, when: 'starts' }, { ...base, when: 'final' }];
      if (closeMargin) wants.push({ ...base, when: 'close_late', value: closeMargin });
      if (lineMove) {
        wants.push({ kind: 'odds', sport: league, team: team.name, teamName: team.short, market: 'spreads', when: 'moves_by', value: lineMove, followId: id, how: 'phone', conversationId: input.conversationId ?? null });
        if (!this.#ds().ready('odds')) notes.push('The line-move alert needs a free key from The Odds API (https://the-odds-api.com/#get-access, 500 credits a month), pasted in Settings → Data sources. Until then it waits.');
      }
      for (const w of wants) {
        try {
          const made = lw.add(w);
          ids.push(made.id);
          labels.push(made.label);
        } catch (err) {
          notes.push(`Couldn't turn on "${String(w.when)}": ${(err as Error).message}`);
        }
      }
    }
    this.#db.prepare('UPDATE sports_follows SET watch_ids = ? WHERE id = ?').run(JSON.stringify(ids), id);
    return { follow: this.list().find((f) => f.id === id)!, alerts: labels, notes };
  }

  #removeWatches(f: Follow): number {
    let n = 0;
    for (const w of f.watchIds) if (this.#app.liveWatches?.remove(w)) n++;
    // Also any watch made for this follow whose id was lost (a restart mid-change).
    for (const w of this.#app.liveWatches?.list() ?? []) if (w.target.followId === f.id && this.#app.liveWatches?.remove(w.id)) n++;
    return n;
  }

  unfollow(team: string, league?: string): { follow: Follow; removed: number } {
    const f = this.find(team, league);
    if (!f) throw new SportsError(`You don't follow "${String(team).slice(0, 40)}". Use teams_followed.`);
    const removed = this.#removeWatches(f);
    this.#db.prepare('DELETE FROM sports_follows WHERE id = ?').run(f.id);
    return { follow: f, removed };
  }

  // ------------------------------------------------------------ schedule and calendar

  async #shortNames(league: string): Promise<Map<string, string>> {
    try {
      return new Map((await this.#ds().teams(league)).map((t: EspnTeam) => [t.id, t.short]));
    } catch {
      return new Map();
    }
  }

  /** A team's games from ESPN (past and upcoming). */
  async games(f: Follow, fresh = false) {
    return this.#ds().teamSchedule(f.league, f.teamId, { fresh });
  }

  static title(f: Follow, g: Game, shorts: Map<string, string>): string {
    const home = g.home.id === f.teamId;
    const opp = home ? g.away : g.home;
    const oppName = (opp.id && shorts.get(opp.id)) || opp.name || opp.abbr;
    return `${f.short} ${home ? 'vs' : 'at'} ${oppName}${g.timeTbd ? ' (time TBD)' : ''}`;
  }

  /** Puts the next `days` of games in a calendar; keyed by ESPN's event id (no duplicates; moved times are updated). */
  async scheduleToCalendar(teamName: string, opts: { days?: number; target?: CalendarTarget; signal?: AbortSignal } = {}): Promise<CalendarResult> {
    const f = this.find(teamName);
    if (!f) throw new SportsError(`Follow the team first (team_follow), then I can put its games on a calendar. You follow: ${this.list().map((x) => x.short).join(', ') || 'no teams yet'}.`);
    const target = opts.target ?? 'planner';
    const days = Math.min(Math.max(1, Math.round(opts.days ?? 30)), 120);
    const sched = await this.games(f, true);
    const now = this.#app.now().getTime();
    const upcoming = sched.games.filter((g) => g.state === 'pre' && Date.parse(g.start) >= now - 3600_000 && Date.parse(g.start) <= now + days * 86_400_000);
    const shorts = await this.#shortNames(f.league);
    const out: CalendarResult = { team: f.short, target, added: [], moved: [], unchanged: 0, source: sched.source, at: sched.at };
    const writer = this.#writer(target, f);
    for (const g of upcoming) {
      const title = Sports.title(f, g, shorts);
      const row = this.#db.prepare('SELECT * FROM sports_calendar WHERE event_id = ? AND target = ?').get(g.id, target) as Row | undefined;
      const stamp = this.#app.now().toISOString();
      if (row && (await writer.exists(String(row.ref), opts.signal))) {
        if (String(row.start) === g.start && String(row.title) === title) {
          out.unchanged++;
          continue;
        }
        await writer.update(String(row.ref), g, title, opts.signal);
        this.#db.prepare('UPDATE sports_calendar SET start = ?, title = ?, updated_at = ? WHERE event_id = ? AND target = ?').run(g.start, title, stamp, g.id, target);
        out.moved.push({ title, from: String(row.start), to: g.start });
        continue;
      }
      const ref = await writer.add(g, title, opts.signal);
      this.#db.prepare('INSERT INTO sports_calendar (event_id, target, team_key, ref, start, title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, target) DO UPDATE SET ref = excluded.ref, start = excluded.start, title = excluded.title, updated_at = excluded.updated_at').run(g.id, target, `${f.league}:${f.teamId}`, ref, g.start, title, stamp);
      out.added.push({ title, start: g.start, tbd: Boolean(g.timeTbd) });
    }
    return out;
  }

  #writer(target: CalendarTarget, f: Follow): { exists(ref: string, signal?: AbortSignal): Promise<boolean>; add(g: Game, title: string, signal?: AbortSignal): Promise<string>; update(ref: string, g: Game, title: string, signal?: AbortSignal): Promise<void> } {
    const tz = this.#app.settings.get().timeZone || 'UTC';
    const notes = (g: Game) => `${LEAGUES[f.league]?.label ?? f.league} · ESPN game ${g.id}. Time from ESPN${g.timeTbd ? ' (not set yet)' : ''}; Sara updates it when you sync again.`;
    // A game without a time yet is put on its local date (all day / a dated task).
    const localDate = (g: Game) => {
      const p = zonedParts(new Date(g.start), tz);
      return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    };
    if (target === 'planner') {
      const planner = this.#app.planner;
      if (!planner) throw new SportsError('The planner is not available here.');
      const project = () => planner.createBuiltinProject('sports', 'Games').name;
      return {
        exists: async (ref) => Boolean(planner.task(Number(ref))),
        add: async (g, title) => String(planner.addTask({ title, project: project(), notes: notes(g), dueAt: g.start }).id),
        update: async (ref, g, title) => void planner.updateTask(Number(ref), { title, dueAt: g.start, notes: notes(g) }),
      };
    }
    const hours = f.league === 'mlb' ? 3 : f.league.startsWith('nc') || f.league === 'nfl' ? 3.5 : 2.5;
    const span = (g: Game) => (g.timeTbd ? { allDay: true, start: localDate(g), end: undefined as string | undefined } : { allDay: false, start: g.start, end: new Date(Date.parse(g.start) + hours * 3600_000).toISOString() });
    if (target === 'google') {
      const google = this.#app.google;
      if (!google?.status().calendar) throw new SportsError('Google Calendar is not connected (Settings → Email and calendar). Sara\'s own planner works without it.');
      const body = (g: Game, title: string) => {
        const s = span(g);
        const at = (v: string) => (s.allDay ? { date: v } : { dateTime: v, timeZone: tz });
        const end = s.allDay ? new Date(Date.parse(`${s.start}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : s.end!;
        return { summary: title, description: notes(g), start: at(s.start), end: at(end), extendedProperties: { private: { saraEspnGame: g.id } } };
      };
      return {
        exists: async (ref, signal) => {
          try {
            const e = (await google.api(`${GCAL}/${encodeURIComponent(ref)}`, { ...(signal ? { signal } : {}) })) as { status?: string };
            return e?.status !== 'cancelled';
          } catch {
            return false;
          }
        },
        add: async (g, title, signal) => String(((await google.api(GCAL, { method: 'POST', body: body(g, title), ...(signal ? { signal } : {}) })) as { id: string }).id),
        update: async (ref, g, title, signal) => void (await google.api(`${GCAL}/${encodeURIComponent(ref)}`, { method: 'PATCH', body: body(g, title), ...(signal ? { signal } : {}) })),
      };
    }
    const accounts = this.#app.mailAccounts;
    const acct = accounts?.list().find((a) => a.kind === 'microsoft' && a.calendar && !a.problem);
    const cal = acct ? accounts!.provider(acct.id).calendar : undefined;
    if (!cal) throw new SportsError('No Outlook calendar is connected (Settings → Email and calendar). Sara\'s own planner works without it.');
    const ev = (g: Game, title: string) => {
      const s = span(g);
      return { title, start: s.allDay ? s.start : toLocalIso(s.start, tz), ...(s.end ? { end: toLocalIso(s.end, tz) } : {}), allDay: s.allDay, notes: notes(g), guests: [], timeZone: tz };
    };
    return {
      exists: async (ref, signal) => {
        try {
          const list = await cal.events(new Date(this.#app.now().getTime() - 86_400_000), new Date(this.#app.now().getTime() + 130 * 86_400_000), undefined, signal);
          return list.some((e) => e.id === ref);
        } catch {
          return false;
        }
      },
      add: async (g, title, signal) => (await cal.add(ev(g, title), signal)).id,
      update: async (ref, g, title, signal) => void (await cal.update(ref, ev(g, title), signal)),
    };
  }

  // ------------------------------------------------------------ briefing and Today

  /** Today's games and results from the last day and a half, for each followed team. */
  async status(now: Date = this.#app.now()): Promise<{ items: TeamStatus[]; source: string; at: string } | undefined> {
    const follows = this.list();
    if (!follows.length || !this.#app.dataSources) return undefined;
    const tz = this.#app.settings.get().timeZone;
    const items: TeamStatus[] = [];
    let at = '';
    for (const f of follows) {
      try {
        const sched = await this.games(f);
        at = at && at > sched.at ? at : sched.at;
        const shorts = await this.#shortNames(f.league);
        const opp = (g: Game) => {
          const home = g.home.id === f.teamId;
          const o = home ? g.away : g.home;
          return { home, name: (o.id && shorts.get(o.id)) || o.name || o.abbr };
        };
        const t = now.getTime();
        const live = sched.games.find((g) => g.state === 'in');
        const next = sched.games.filter((g) => g.state === 'pre' && Date.parse(g.start) >= t - 3 * 3600_000).sort((a, b) => a.start.localeCompare(b.start))[0];
        const last = sched.games.filter((g) => g.state === 'post').sort((a, b) => b.start.localeCompare(a.start))[0];
        const side = (g: Game) => (g.home.id === f.teamId ? { me: g.home.score, them: g.away.score } : { me: g.away.score, them: g.home.score });
        const s: TeamStatus = { team: f.short, name: f.name, league: f.league };
        if (live) s.live = { opponent: opp(live).name, home: opp(live).home, me: side(live).me, them: side(live).them, detail: live.detail };
        if (next) s.next = { opponent: opp(next).name, home: opp(next).home, start: next.start, tbd: Boolean(next.timeTbd), today: sameDay(next.start, now, tz) };
        if (last) {
          const { me, them } = side(last);
          s.last = { opponent: opp(last).name, home: opp(last).home, me, them, result: me === null || them === null ? '' : me > them ? 'W' : me < them ? 'L' : 'T', start: last.start, recent: t - Date.parse(last.start) < 36 * 3600_000 };
        }
        items.push(s);
      } catch (err) {
        items.push({ team: f.short, name: f.name, league: f.league, error: (err as Error).message.slice(0, 160) });
      }
    }
    return { items, source: 'ESPN', at: at || now.toISOString() };
  }

  /** The briefing's one line: "Chiefs play tonight 7:20 PM vs Bills; Royals won 5-3 vs Twins (ESPN, 7:02 AM)." */
  async briefingLine(now: Date = this.#app.now()): Promise<string | undefined> {
    const st = await this.status(now);
    if (!st) return undefined;
    const tz = this.#app.settings.get().timeZone;
    const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const parts: string[] = [];
    for (const s of st.items) {
      if (s.live) parts.push(`${s.team} ${s.live.me ?? 0}-${s.live.them ?? 0} ${s.live.home ? 'vs' : 'at'} ${s.live.opponent} (${s.live.detail})`);
      else if (s.next?.today) {
        const evening = zonedParts(new Date(s.next.start), tz).h >= 17;
        parts.push(`${s.team} play ${evening ? 'tonight' : 'today'}${s.next.tbd ? '' : ` ${time(s.next.start)}`} ${s.next.home ? 'vs' : 'at'} ${s.next.opponent}`);
      }
      if (s.last?.recent && s.last.result) parts.push(`${s.team} ${s.last.result === 'W' ? 'won' : s.last.result === 'L' ? 'lost' : 'tied'} ${Math.max(s.last.me ?? 0, s.last.them ?? 0)}-${Math.min(s.last.me ?? 0, s.last.them ?? 0)} ${s.last.home ? 'vs' : 'at'} ${s.last.opponent}`);
    }
    if (!parts.length) return undefined;
    return `${parts.join('; ')} (ESPN, as of ${time(st.at)}).`;
  }

  /** Today's "My teams" tile (only when following someone). */
  async todayTile(now: Date = this.#app.now()): Promise<{ items: TeamStatus[]; source: string; at: string } | undefined> {
    return this.status(now);
  }
}

export interface TeamStatus {
  team: string;
  name: string;
  league: string;
  live?: { opponent: string; home: boolean; me: number | null; them: number | null; detail: string };
  next?: { opponent: string; home: boolean; start: string; tbd: boolean; today: boolean };
  last?: { opponent: string; home: boolean; me: number | null; them: number | null; result: string; start: string; recent: boolean };
  error?: string;
}

function sameDay(iso: string, now: Date, tz?: string): boolean {
  const a = zonedParts(new Date(iso), tz);
  const b = zonedParts(now, tz);
  return a.y === b.y && a.mo === b.mo && a.d === b.d;
}

/** A UTC time as the wall clock in a zone (\"2026-11-15T12:00\"), for calendars that take a zone. */
function toLocalIso(iso: string, tz: string): string {
  const p = zonedParts(new Date(iso), tz);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${two(p.mo)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}
