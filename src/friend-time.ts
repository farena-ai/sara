// V2.10 (docs/design/V2SCHEDULE.md): "find a time with Sam". Two owners' Saras on an S9a link trade
// busy blocks only (never event titles, places or people), the asker's server proposes up to 3 times,
// and the slot is agreed when both people pick the same one; both planners then get it.
//
// Wire: POST /msg/v1/ftime/<op>, signed like S9b with the scope word 'ftime' (src/support.ts). Ops are
// data only: ask (what, how long, part of day, range), busy (the friend's blocks, after the friend said
// yes; the reply carries the proposed times), pick, cancel. The asker's own blocks never leave its
// server, and neither side stores the other's blocks.
import { randomUUID, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import type { Messenger } from './messages.ts';
import { privateLocalOn } from './net-guard.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import { signSupport, SupportError, supportOf, type SupportScope } from './support.ts';
import { calendarEvents, hasCalendar } from './today.ts';

export const FT_OPS = ['ask', 'busy', 'pick', 'cancel'] as const;
export const FT_PARTS = ['day', 'evening', 'any'] as const;
export const FT_MINUTES = [15, 30, 45, 60, 90, 120] as const;
export type FtPart = (typeof FT_PARTS)[number];
/** Local hours each part of day covers (on each person's own clock). */
const HOURS: Record<FtPart, [number, number]> = { day: [9, 17], evening: [17, 21], any: [9, 21] };
const GRID = 15 * 60_000;
const STEP = 30 * 60_000;
const NOTICE = 2 * 3600_000;
const DAY = 86_400_000;
const MAX_BLOCKS = 600;
export const FT_PEER_MAX = 256 * 1024;

export type FtStatus = 'asked' | 'proposed' | 'agreed' | 'none' | 'declined' | 'cancelled';
export interface FtRequest {
  id: string;
  /** 'asker' started it; 'friend' was asked. */
  side: 'asker' | 'friend';
  link: string;
  friend: string;
  title: string;
  minutes: number;
  part: FtPart;
  from: string;
  to: string;
  status: FtStatus;
  times: string[];
  myPick: string | null;
  theirPick: string | null;
  agreed: string | null;
  createdAt: string;
}
export interface Block {
  start: string;
  end: string;
}
/** A calendar event as the calendars give it; only start/end/allDay are ever looked at. */
export type FtEvent = { start: string; end?: string; allDay?: boolean } & Record<string, unknown>;

const SCHEMA = `CREATE TABLE IF NOT EXISTS ft_requests (id TEXT PRIMARY KEY, side TEXT NOT NULL, link TEXT NOT NULL, friend TEXT NOT NULL, title TEXT NOT NULL, minutes INTEGER NOT NULL, part TEXT NOT NULL, range_from TEXT NOT NULL, range_to TEXT NOT NULL, status TEXT NOT NULL, times TEXT NOT NULL DEFAULT '[]', my_pick TEXT, their_pick TEXT, agreed TEXT, task_id INTEGER, created_at TEXT NOT NULL);`;
const SCOPE: SupportScope = 'ftime';
const PEER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const bad = (why: string, status = 400) => new SupportError(status, why);
const iso = (ms: number) => new Date(ms).toISOString();
const up = (ms: number) => Math.ceil(ms / GRID) * GRID;
const down = (ms: number) => Math.floor(ms / GRID) * GRID;

/** Re-exported for tests: the S9b signer with a scope word. */
export const signFt = signSupport;

/**
 * Busy blocks from calendar events: only start and end survive, all-day events are skipped, every block
 * is widened to the 15-minute grid, clipped to the range and merged with its neighbours.
 */
export function busyBlocks(events: FtEvent[], from: Date, to: Date): Block[] {
  const raw: [number, number][] = [];
  for (const e of events) {
    if (e.allDay || !e.end) continue;
    const s = Date.parse(String(e.start));
    const f = Date.parse(String(e.end));
    if (!Number.isFinite(s) || !Number.isFinite(f) || f <= s) continue;
    const a = Math.max(down(s), from.getTime());
    const b = Math.min(up(f), to.getTime());
    if (b > a) raw.push([a, b]);
  }
  return merge(raw);
}
function merge(raw: [number, number][]): Block[] {
  raw.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of raw) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out.map(([a, b]) => ({ start: iso(a), end: iso(b) }));
}
/** The hours outside the chosen part of day on this person's own clock, as busy blocks. */
export function offHours(part: FtPart, from: Date, to: Date, tz?: string): Block[] {
  const [h0, h1] = HOURS[part];
  const raw: [number, number][] = [];
  const p = zonedParts(new Date(from.getTime() - DAY), tz);
  for (let i = 0; i < 40; i++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i, 12));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const open = zonedToUtc(y, mo, d, h0, 0, tz).getTime();
    if (open - DAY > to.getTime()) break;
    const close = zonedToUtc(y, mo, d, h1, 0, tz).getTime();
    const nextOpen = zonedToUtc(y, mo, d + 1, h0, 0, tz).getTime();
    raw.push([Math.max(close, from.getTime()), Math.min(nextOpen, to.getTime())]);
  }
  return merge(raw.filter(([a, b]) => b > a));
}
/**
 * Up to 3 free start times (half-hour steps, at least 2 hours from now): the first free one on different
 * days first (days on the asker's clock), then the next free ones. Sorted by time.
 */
export function pickTimes(busy: Block[], minutes: number, now: Date, to: Date, tz?: string): string[] {
  const dur = minutes * 60_000;
  const bs = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const);
  const free = (t: number) => !bs.some(([s, e]) => t < e && t + dur > s);
  const starts: number[] = [];
  for (let t = Math.ceil((now.getTime() + NOTICE) / STEP) * STEP; t + dur <= to.getTime() && starts.length < 2000; t += STEP) if (free(t)) starts.push(t);
  const dayOf = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return `${p.y}-${p.mo}-${p.d}`;
  };
  const picked: number[] = [];
  const days = new Set<string>();
  for (const t of starts) {
    if (picked.length >= 3) break;
    if (days.has(dayOf(t))) continue;
    days.add(dayOf(t));
    picked.push(t);
  }
  for (const t of starts) {
    if (picked.length >= 3) break;
    if (!picked.some((p) => t < p + dur && t + dur > p)) picked.push(t);
  }
  return picked.sort((a, b) => a - b).map(iso);
}

type Row = Record<string, unknown>;

export class FriendTime {
  readonly #db: DatabaseSync;
  readonly #m: Messenger;
  readonly #app: AppContext;
  #closed = false;
  /** Tests and the live check: where this owner's calendar events come from (default: every connected calendar + timed to-dos). */
  events: ((from: Date, to: Date) => Promise<FtEvent[]>) | undefined;
  /** Something changed (the open Messages page reloads). */
  onChange: ((id: string) => void) | undefined;
  /** A notice for the owner (a friend asked, times are ready, a time was agreed). */
  onNotice: ((title: string, body: string, id: string) => void) | undefined;

  static exists(app: Pick<AppContext, 'dataDir' | 'messages'>): boolean {
    return Boolean(app.messages) && existsSync(join(app.dataDir, 'friend-time.db'));
  }

  constructor(app: AppContext & { messages: Messenger }) {
    this.#app = app;
    this.#m = app.messages;
    this.#db = new DatabaseSync(join(app.dataDir, 'friend-time.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#m.whenClosed(() => this.close());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
  #now(): Date {
    return this.#app.now();
  }
  #tz(): string | undefined {
    return this.#app.settings.get().timeZone || undefined;
  }

  // ---- reading ---------------------------------------------------------------------------------
  #row(id: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM ft_requests WHERE id = ?').get(id) as Row | undefined;
  }
  #need(id: string): Row {
    const r = this.#row(id);
    if (!r) throw bad(en('Not found'), 404);
    return r;
  }
  #view(r: Row): FtRequest {
    return {
      id: String(r.id),
      side: r.side === 'asker' ? 'asker' : 'friend',
      link: String(r.link),
      friend: String(r.friend),
      title: String(r.title),
      minutes: Number(r.minutes),
      part: cleanPart(r.part),
      from: String(r.range_from),
      to: String(r.range_to),
      status: String(r.status) as FtStatus,
      times: JSON.parse(String(r.times)) as string[],
      myPick: r.my_pick ? String(r.my_pick) : null,
      theirPick: r.their_pick ? String(r.their_pick) : null,
      agreed: r.agreed ? String(r.agreed) : null,
      createdAt: String(r.created_at),
    };
  }
  list(): FtRequest[] {
    return (this.#db.prepare('SELECT * FROM ft_requests ORDER BY created_at DESC LIMIT 100').all() as Row[]).map((r) => this.#view(r));
  }
  get(id: string): FtRequest {
    return this.#view(this.#need(id));
  }
  friends(): { id: string; name: string }[] {
    return this.#m.links().filter((l) => l.kind === 'direct').map((l) => ({ id: l.id, name: l.name, aliases: l.aliases ?? [] }));
  }
  #set(id: string, v: Record<string, string | number | null>): void {
    const keys = Object.keys(v);
    this.#db.prepare(`UPDATE ft_requests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
    this.onChange?.(id);
  }

  /** This owner's busy blocks for a range: calendars + timed to-dos + the hours outside the part of day. */
  async #blocks(from: Date, to: Date, part: FtPart): Promise<Block[]> {
    const evs: FtEvent[] = this.events ? await this.events(from, to) : await this.#ownEvents(from, to);
    const all = [...busyBlocks(evs, from, to), ...offHours(part, from, to, this.#tz())];
    return merge(all.map((b) => [Date.parse(b.start), Date.parse(b.end)]));
  }
  async #ownEvents(from: Date, to: Date): Promise<FtEvent[]> {
    const out: FtEvent[] = [];
    if (hasCalendar(this.#app)) for (const e of await calendarEvents(this.#app, from, to, 500, 20_000)) out.push({ start: e.start, end: e.end, allDay: e.allDay });
    // Same rule as the booking page: a to-do due at a set time keeps that half hour busy.
    for (const t of this.#app.planner?.tasks({ status: 'open' }) ?? []) {
      if (!t.dueAt) continue;
      const at = Date.parse(t.dueAt);
      const p = zonedParts(new Date(at), this.#tz());
      if (p.h === 0 && p.mi === 0) continue;
      out.push({ start: iso(at), end: iso(at + 30 * 60_000) });
    }
    return out;
  }

  // ---- the owner's actions -----------------------------------------------------------------------
  /** Asks a linked friend to find a time (only the request itself crosses). */
  async ask(link: string, title: unknown, minutes: unknown, part: unknown, days: unknown): Promise<FtRequest> {
    const friend = this.friends().find((f) => f.id === link);
    if (!friend) throw bad(en('Pick a linked friend first.'));
    const what = clip(title, 80) || en('Meet');
    const mins = (FT_MINUTES as readonly number[]).includes(Number(minutes)) ? Number(minutes) : 30;
    const p = cleanPart(part);
    const n = Math.max(1, Math.min(21, Math.round(Number(days) || 7)));
    const now = this.#now();
    const from = iso(now.getTime());
    const to = iso(now.getTime() + n * DAY);
    const id = randomUUID();
    await this.#call(link, 'ask', { req: id, title: what, minutes: mins, part: p, from, to });
    this.#db.prepare("INSERT INTO ft_requests (id, side, link, friend, title, minutes, part, range_from, range_to, status, created_at) VALUES (?, 'asker', ?, ?, ?, ?, ?, ?, ?, 'asked', ?)").run(id, link, friend.name, what, mins, p, from, to, iso(now.getTime()));
    this.onChange?.(id);
    return this.get(id);
  }
  /** The friend says yes: its busy blocks go to the asker, whose answer is the proposed times. */
  async share(id: string): Promise<FtRequest> {
    const r = this.#need(id);
    if (r.side !== 'friend' || r.status !== 'asked') throw bad(en('This request is not waiting for you.'));
    const busy = await this.#blocks(new Date(String(r.range_from)), new Date(String(r.range_to)), cleanPart(r.part));
    const res = await this.#call(String(r.link), 'busy', { req: id, busy });
    const times = cleanTimes(res.times, []);
    this.#set(id, { status: times.length ? 'proposed' : 'none', times: JSON.stringify(times) });
    return this.get(id);
  }
  /** "Not now" (friend, before sharing) or "Call it off" (either side). The other side is told when it answers. */
  async cancel(id: string): Promise<FtRequest> {
    const r = this.#need(id);
    if (!['asked', 'proposed'].includes(String(r.status))) throw bad(en('This request is already closed.'));
    const declined = r.side === 'friend' && r.status === 'asked';
    this.#set(id, { status: declined ? 'declined' : 'cancelled' });
    await this.#call(String(r.link), 'cancel', { req: id, declined }).catch(() => undefined);
    return this.get(id);
  }
  /** This owner picks one of the proposed times; agreed when the friend picked the same one. */
  async pick(id: string, time: unknown): Promise<FtRequest> {
    const r = this.#need(id);
    const v = this.#view(r);
    if (v.status !== 'proposed') throw bad(en('This request is not waiting for a pick.'));
    const t = String(time ?? '');
    if (!v.times.includes(t)) throw bad(en('Pick one of the proposed times.'));
    const res = await this.#call(v.link, 'pick', { req: id, time: t });
    const theirs = typeof res.pick === 'string' && v.times.includes(res.pick) ? res.pick : null;
    this.#set(id, { my_pick: t, their_pick: theirs });
    if (theirs === t) this.#agree(id, t);
    return this.get(id);
  }
  /** Removes a request from this server (an open one is called off first). */
  async forget(id: string): Promise<void> {
    const r = this.#need(id);
    if (['asked', 'proposed'].includes(String(r.status))) await this.cancel(id);
    this.#db.prepare('DELETE FROM ft_requests WHERE id = ?').run(id);
    this.onChange?.(id);
  }
  #agree(id: string, time: string): void {
    const v = this.get(id);
    if (v.status === 'agreed') return;
    let task: number | null = null;
    try {
      task = this.#app.planner?.addTask({ title: `${v.title} with ${v.friend}`.slice(0, 200), dueAt: time, notes: trOwner('Agreed with {name} through Messages.', this.#app.settings.get(), { name: v.friend }) }).id ?? null;
    } catch {
      task = null;
    }
    this.#set(id, { status: 'agreed', agreed: time, task_id: task });
    this.onNotice?.(trOwner('Time agreed', this.#app.settings.get()), `${v.title} · ${v.friend}`, id);
  }

  // ---- receiving -------------------------------------------------------------------------------
  /** One verified peer request (the route checked the signature). Returns the reply or throws SupportError. */
  async received(linkId: string, name: string, op: string, b: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = clip(b.req, 64);
    if (!PEER_ID.test(id)) throw bad('bad request');
    const r = this.#row(id);
    if (op === 'ask') {
      if (r) throw bad('bad request');
      const from = Date.parse(String(b.from));
      const to = Date.parse(String(b.to));
      const now = this.#now().getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 22 * DAY || Math.abs(from - now) > DAY) throw bad('bad request');
      const mins = (FT_MINUTES as readonly number[]).includes(Number(b.minutes)) ? Number(b.minutes) : 30;
      const count = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM ft_requests WHERE link = ? AND status IN ('asked', 'proposed')").get(linkId) as Row).n);
      if (count >= 20) throw bad('too many', 429);
      this.#db.prepare("INSERT INTO ft_requests (id, side, link, friend, title, minutes, part, range_from, range_to, status, created_at) VALUES (?, 'friend', ?, ?, ?, ?, ?, ?, ?, 'asked', ?)").run(id, linkId, name, clip(b.title, 80) || en('Meet'), mins, cleanPart(b.part), iso(from), iso(to), iso(now));
      this.onChange?.(id);
      const st = this.#app.settings.get();
      this.onNotice?.(trOwner('Find a time', st), trOwner('{name} wants to find a time: {what}', st, { name, what: clip(b.title, 80) }), id);
      return { ok: true };
    }
    if (!r || String(r.link) !== linkId) throw bad('not allowed', 403);
    const v = this.#view(r);
    if (op === 'busy') {
      // Only the asker takes busy blocks, once, while it waits for them.
      if (v.side !== 'asker') throw bad('not allowed', 403);
      if (v.status !== 'asked') throw bad('not open', 409);
      const from = new Date(v.from);
      const to = new Date(v.to);
      const theirs = cleanBlocks(b.busy, from, to);
      const mine = await this.#blocks(from, to, v.part);
      const all = merge([...mine, ...theirs].map((x) => [Date.parse(x.start), Date.parse(x.end)]));
      const times = pickTimes(all, v.minutes, this.#now(), to, this.#tz());
      this.#set(id, { status: times.length ? 'proposed' : 'none', times: JSON.stringify(times) });
      const st = this.#app.settings.get();
      this.onNotice?.(trOwner('Find a time', st), times.length ? trOwner('{name} shared free/busy: pick a time.', st, { name }) : trOwner('No common free time with {name}.', st, { name }), id);
      return { ok: true, times };
    }
    if (op === 'pick') {
      if (v.status !== 'proposed') throw bad('not open', 409);
      const t = String(b.time ?? '');
      if (!v.times.includes(t)) throw bad('bad request');
      this.#set(id, { their_pick: t });
      if (v.myPick === t) this.#agree(id, t);
      return { ok: true, pick: v.myPick };
    }
    if (op === 'cancel') {
      if (['asked', 'proposed', 'none'].includes(v.status)) this.#set(id, { status: b.declined === true && v.side === 'asker' ? 'declined' : 'cancelled' });
      return { ok: true };
    }
    throw bad('bad request');
  }

  async #call(linkId: string, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (privateLocalOn()) throw new SupportError(503, en('Private local mode is on: nothing leaves this server.'));
    const p = this.#m.peer(linkId);
    const key: KeyObject | undefined = this.#m.privateKeyFor(linkId);
    if (!p || !key) throw new SupportError(404, en('That link is gone. Link the servers again under Messages.'));
    const body = JSON.stringify({ v: 1, id: randomUUID(), ...payload });
    let res: Response;
    try {
      res = await this.#m.peerFetch(`${p.url}/msg/v1/ftime/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(linkId, op, body, key, this.#now(), SCOPE) }, body, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new SupportError(502, en('The other server did not answer. Check its address and try again.'));
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 403) throw new SupportError(403, en('The other server said no (not allowed).'));
    if (!res.ok) throw new SupportError(res.status === 409 ? 409 : 502, res.status === 409 ? en('This request is already closed.') : en('The other server did not answer. Check its address and try again.'));
    return j;
  }
  /** Tests: one signed call as this server. */
  callForTest(linkId: string, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#call(linkId, op, payload);
  }
  /** Verifies a peer request (link, time, 'ftime' signature for this op, replay). */
  verify(headers: import('node:http').IncomingHttpHeaders, op: string, body: string): { linkId: string; name: string } {
    const sup = supportOf(this.#app);
    if (!sup) throw new SupportError(401, 'unsigned');
    return sup.verify(headers, op, body, SCOPE);
  }
}

function cleanPart(v: unknown): FtPart {
  return (FT_PARTS as readonly string[]).includes(String(v)) ? (String(v) as FtPart) : 'any';
}
function cleanTimes(v: unknown, _: string[]): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 3).map(String).filter((x) => Number.isFinite(Date.parse(x))).map((x) => new Date(x).toISOString());
}
/** A friend's busy list rebuilt from start/end only (anything else is dropped), inside the range. */
function cleanBlocks(v: unknown, from: Date, to: Date): Block[] {
  if (!Array.isArray(v) || v.length > MAX_BLOCKS) throw bad('bad request');
  const raw: [number, number][] = [];
  for (const x of v) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const s = Date.parse(String(o.start));
    const e = Date.parse(String(o.end));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw bad('bad request');
    const a = Math.max(s, from.getTime());
    const b = Math.min(e, to.getTime());
    if (b > a) raw.push([a, b]);
  }
  return merge(raw);
}

const cache = new WeakMap<Messenger, FriendTime>();
/** The owner's friend scheduling (undefined for members, kid mode and the demo: they have no Messenger). */
export function friendTimeOf(app: AppContext): FriendTime | undefined {
  const m = app.messages;
  if (!m) return undefined;
  let f = cache.get(m);
  if (!f) cache.set(m, (f = new FriendTime(app as AppContext & { messages: Messenger })));
  return f;
}
