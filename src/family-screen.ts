// W4.5 (docs/FAMILY_SCREEN.md): the Family screen, a tablet on the wall or in the kitchen.
//
// Pairing: the owner makes a one-time code in Settings → Household → People on this server → Family
// screen; the tablet opens /family-screen and types it. It gets its own token ("fs_…", saved here only
// as a SHA-256 hash) that only the /api/family-screen routes below accept: it is not a sign-in, so the
// rest of the API (chats, memory, settings, money) answers 401 to it. Removing the screen ends it.
//
// What it shows (screenBoard): today's family calendar (approved family events only, never anyone's
// private ones), chores due today per person with tap-to-done (the mark waits for a parent's OK as
// usual), dinners for the next seven days, the shared shopping list (tap to add, tick, or say it),
// reminders due (family events still to come today, and the owner's own reminders only if he turns
// that on for this screen), and a big kid-safe Talk button. It dims at night (the screen's hours).
//
// Talk (screenTalk): never any tools (no computer use, no shopping, no money, no mail). Picking a kid
// runs the turn in that kid's own space, so their limits, bedtime and her tone for them apply as in
// their own app. "Everyone" runs off the record in the owner's space (an in-memory chat, no memory,
// no tools, adult mode off, the kid-safe note for ages 6-9). Off-limits or money asks get a kind no
// without any model. Talk rests during the night hours.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runTurn, type AppContext } from './chat.ts';
import { cleanChild, FamilyError, KID_OFF_REPLY, kidOffLimits, kidsOf, localDay, type ChildProfile, type FamilyAccess } from './family.ts';
import { planOf } from './family-plan.ts';
import { HttpError, readJson, readRaw, send } from './http.ts';
import { en, trOwner } from './i18n.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import { detectCrisis } from './safety.ts';
import { Store } from './store.ts';
import { ToolRegistry } from './tools/registry.ts';

/** The header the screen sends its token in (never Authorization, so no other route reads it). */
export const SCREEN_HEADER = 'x-family-screen';
export const SCREEN_CODE_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_SCREENS = 10;
const MAX_CODES = 10;
const MAX_WRONG = 10;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ScreenPrefs {
  /** Dim from/to (HH:MM, the household's time zone); both empty = never dims. */
  dimFrom: string;
  dimTo: string;
  /** The kid-safe Talk button. */
  talk: boolean;
  /** The owner's own reminders due today on this screen (off unless he turns it on). */
  myReminders: boolean;
}
export interface Screen {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string | null;
  prefs: ScreenPrefs;
}
interface Saved extends Screen {
  tokenHash: string;
  /** Talk conversations this screen made, by person (in that person's own space). */
  convs?: Record<string, string>;
}
export const DEFAULT_PREFS: ScreenPrefs = { dimFrom: '21:00', dimTo: '06:30', talk: true, myReminders: false };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
/** "abc def" / "abcdef" / "ABC-DEF" → "ABC-DEF". */
export const screenCode = (raw: unknown) => {
  const c = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
};

export class FamilyScreens {
  readonly #file: string;
  readonly #now: () => Date;
  readonly #codes = new Map<string, { name: string; expires: number }>();
  readonly #wrong = new Map<string, { n: number; until: number }>();
  constructor(file: string, now: () => Date = () => new Date()) {
    this.#file = file;
    this.#now = now;
  }
  #load(): Saved[] {
    if (!existsSync(this.#file)) return [];
    try {
      const v = JSON.parse(readFileSync(this.#file, 'utf8')) as { screens?: Saved[] };
      return Array.isArray(v.screens) ? v.screens : [];
    } catch {
      return [];
    }
  }
  #save(list: Saved[]): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ screens: list }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }
  #view(s: Saved): Screen {
    return { id: s.id, name: s.name, createdAt: s.createdAt, lastSeen: s.lastSeen, prefs: { ...DEFAULT_PREFS, ...s.prefs } };
  }
  #sweep(): void {
    const t = this.#now().getTime();
    for (const [k, c] of this.#codes) if (c.expires <= t) this.#codes.delete(k);
    for (const [k, w] of this.#wrong) if (w.until <= t) this.#wrong.delete(k);
  }
  list(): Screen[] {
    return this.#load().map((s) => this.#view(s));
  }
  /** A new one-time code for a tablet (the owner's Settings). */
  code(name: unknown): { code: string; expiresAt: string } {
    this.#sweep();
    if (this.#load().length >= MAX_SCREENS) throw new FamilyError(409, en('You have the most family screens this server keeps. Remove one first.'));
    if (this.#codes.size >= MAX_CODES) throw new FamilyError(429, en('Too many codes are waiting. Wait a few minutes.'));
    let code = '';
    do code = screenCode([...randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join(''));
    while (this.#codes.has(code));
    const expires = this.#now().getTime() + SCREEN_CODE_MS;
    this.#codes.set(code, { name: clip(name, 40) || en('Family screen'), expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  /** The tablet typed a code: its own token, once (undefined for a wrong, used or expired code). */
  pair(raw: unknown, ip: string): { token: string; screen: Screen } | undefined {
    this.#sweep();
    const t = this.#now().getTime();
    const w = this.#wrong.get(ip);
    if (w && w.n >= MAX_WRONG) return undefined;
    const code = screenCode(raw);
    const c = this.#codes.get(code);
    if (!c) {
      this.#wrong.set(ip, { n: (w?.n ?? 0) + 1, until: w?.until ?? t + SCREEN_CODE_MS });
      return undefined;
    }
    this.#codes.delete(code);
    const token = `fs_${randomBytes(32).toString('base64url')}`;
    const s: Saved = { id: randomBytes(6).toString('hex'), name: c.name, createdAt: this.#now().toISOString(), lastSeen: null, prefs: { ...DEFAULT_PREFS }, tokenHash: sha(token) };
    this.#save([...this.#load(), s]);
    return { token, screen: this.#view(s) };
  }
  #find(token: unknown): Saved | undefined {
    const tok = String(token ?? '');
    if (!tok.startsWith('fs_') || tok.length > 100) return undefined;
    const h = Buffer.from(sha(tok), 'hex');
    return this.#load().find((s) => timingSafeEqual(Buffer.from(s.tokenHash, 'hex'), h));
  }
  byToken(token: unknown): Screen | undefined {
    const s = this.#find(token);
    return s ? this.#view(s) : undefined;
  }
  /** Seen now (at most once a minute on disk). */
  touch(id: string): void {
    const list = this.#load();
    const s = list.find((x) => x.id === id);
    const now = this.#now();
    if (!s || (s.lastSeen && now.getTime() - Date.parse(s.lastSeen) < 60_000)) return;
    s.lastSeen = now.toISOString();
    this.#save(list);
  }
  update(id: string, patch: Record<string, unknown>): Screen | undefined {
    const list = this.#load();
    const s = list.find((x) => x.id === id);
    if (!s) return undefined;
    const p = { ...DEFAULT_PREFS, ...s.prefs };
    for (const k of ['dimFrom', 'dimTo'] as const) {
      if (patch[k] === undefined) continue;
      const v = String(patch[k] ?? '');
      if (v && !HHMM.test(v)) throw new FamilyError(400, en('Use a time like 21:00.'));
      p[k] = v;
    }
    if (patch.talk !== undefined) p.talk = patch.talk === true;
    if (patch.myReminders !== undefined) p.myReminders = patch.myReminders === true;
    if (patch.name !== undefined) s.name = clip(patch.name, 40) || s.name;
    s.prefs = p;
    this.#save(list);
    return this.#view(s);
  }
  remove(id: string): boolean {
    const list = this.#load();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    this.#save(next);
    return true;
  }
  conv(id: string, person: string): string | undefined {
    return this.#load().find((s) => s.id === id)?.convs?.[person];
  }
  setConv(id: string, person: string, conv: string): void {
    const list = this.#load();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    s.convs = { ...(s.convs ?? {}), [person]: conv };
    this.#save(list);
  }
}

const screensBy = new WeakMap<object, FamilyScreens>();
/** The owner's screens (one per owner space; undefined for members). */
export function screensOf(app: AppContext): FamilyScreens | undefined {
  if (app.member || app.demo || !app.family || app.family.person !== 'owner') return undefined;
  const key = app.settings as object;
  let s = screensBy.get(key);
  if (!s) screensBy.set(key, (s = new FamilyScreens(join(app.rootDir ?? app.dataDir, 'family-screens.json'), () => app.now())));
  return s;
}

const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** True during the screen's night hours (they may cross midnight). */
export function inDim(p: ScreenPrefs, at: Date, tz?: string): boolean {
  if (!HHMM.test(p.dimFrom) || !HHMM.test(p.dimTo)) return false;
  const z = zonedParts(at, tz);
  const m = z.h * 60 + z.mi;
  const a = mins(p.dimFrom);
  const b = mins(p.dimTo);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}

const pad = (n: number) => String(n).padStart(2, '0');
const addDay = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface ScreenBoard {
  screen: { name: string };
  now: string;
  day: string;
  dim: boolean;
  people: { id: string; name: string; child: boolean }[];
  today: { events: { title: string; start: string; allDay: boolean }[]; dinner: { title: string | null; time: string } };
  chores: { person: string; name: string; child: boolean; items: { id: number; title: string; points: number; done: false | 'waiting' | 'approved' }[] }[];
  meals: { day: string; title: string | null }[];
  shopping: { id: string; name: string; items: { ref: string; title: string; done: boolean }[] } | null;
  /** Due soon (the next three hours): family events and, when turned on, the owner's own reminders. */
  reminders: { text: string; at: string; kind: 'event' | 'mine'; inMin: number }[];
  talk: { on: boolean; resting: boolean; kids: { id: string; name: string }[]; voice: boolean };
}

/**
 * What the screen shows. Only household things: approved family events (who = 'family'), chores and
 * points (never money), dinners, the first shared grocery list, and reminders. `mine` = the owner's
 * reminders, passed only when he turned them on for this screen.
 */
export function screenBoard(f: FamilyAccess, at: Date, screen: Screen, o: { mine?: { text: string; dueAt: string }[]; voice?: boolean }): ScreenBoard {
  const tz = f.tz();
  const plan = planOf(f.store);
  const z = zonedParts(at, tz);
  const day = `${z.y}-${pad(z.mo)}-${pad(z.d)}`;
  const nowLocal = `${day}T${pad(z.h)}:${pad(z.mi)}`;
  const end = zonedToUtc(z.y, z.mo, z.d + 1, 0, 0, tz).toISOString();
  const people = f.people();
  // A person id that is never anyone, so events() gives the family's events only.
  const events = plan.events('\u0000screen', day, day).map((e) => ({ title: e.title, start: e.start, allDay: e.allDay }));
  const due = f.store.chores('owner').filter((c) => c.dueAt < end);
  const doneToday = f.store.marks('owner', { limit: 300 }).filter((m) => m.status !== 'rejected' && localDay(new Date(m.doneAt), tz) === day);
  const chores = people
    .map((p) => ({
      person: p.id,
      name: p.name,
      child: Boolean(p.child),
      items: [
        ...due.filter((c) => c.assignee === p.id).map((c) => ({ id: c.id, title: c.title, points: c.points, done: false as const })),
        ...doneToday.filter((m) => m.kid === p.id).map((m) => ({ id: m.choreId, title: m.title, points: m.points, done: m.status as 'waiting' | 'approved' })),
      ],
    }))
    .filter((p) => p.items.length);
  const meals = plan.meals(day, addDay(day, 6));
  const mealDays = Array.from({ length: 7 }, (_, i) => addDay(day, i)).map((d) => ({ day: d, title: meals.find((m) => m.day === d)?.title ?? null }));
  let shopping: ScreenBoard['shopping'] = null;
  if (f.boards) {
    for (const id of f.store.groceryIds()) {
      const v = f.store.groceryView(f.boards, 'owner', id);
      if (!v) continue;
      shopping = { id: v.id, name: v.name, items: v.aisles.flatMap((a) => a.items).map((i) => ({ ref: i.ref, title: i.title, done: i.done })).sort((a, b) => Number(a.done) - Number(b.done)) };
      break;
    }
  }
  const nowMin = z.h * 60 + z.mi;
  const SOON = 180;
  const reminders: ScreenBoard['reminders'] = [
    ...events.filter((e) => !e.allDay && e.start >= nowLocal).map((e) => ({ text: e.title, at: e.start, kind: 'event' as const, inMin: Number(e.start.slice(11, 13)) * 60 + Number(e.start.slice(14, 16)) - nowMin })),
    ...(o.mine ?? []).map((r) => ({ text: r.text, at: r.dueAt, kind: 'mine' as const, inMin: Math.round((Date.parse(r.dueAt) - at.getTime()) / 60_000) })),
  ].filter((r) => r.inMin <= SOON).sort((a, b) => a.inMin - b.inMin).slice(0, 6);
  const dim = inDim(screen.prefs, at, tz);
  return {
    screen: { name: screen.name },
    now: at.toISOString(),
    day,
    dim,
    people: people.map((p) => ({ id: p.id, name: p.name, child: Boolean(p.child) })),
    today: { events, dinner: { title: meals.find((m) => m.day === day)?.title ?? null, time: plan.settings().dinnerTime } },
    chores,
    meals: mealDays,
    shopping,
    reminders,
    talk: { on: screen.prefs.talk, resting: dim, kids: kidsOf(f).map((k) => ({ id: k.id, name: k.name })), voice: Boolean(o.voice) },
  };
}

/** Money, shopping and account asks are never for the wall screen (on top of the kid rules). */
const SCREEN_OFF = /\b(buy|order|purchase|pay|payment|credit card|debit card|card number|bank|robux|v-?bucks|gift ?cards?|venmo|paypal|password|passcode)\b/i;
export function screenOffLimits(text: string): boolean {
  return !detectCrisis(text) && (kidOffLimits(text) || SCREEN_OFF.test(text));
}
export const SCREEN_RESTING = en('Talk is resting for the night. See you in the morning!');

const GUEST_CHILD = (now: Date): ChildProfile => cleanChild({ band: '6-9', bedtime: null }, now);
const guests = new WeakMap<object, { app: AppContext; store: Store; convs: Map<string, string> }>();
/** "Everyone" on the screen: the owner's app off the record (in-memory chat, no tools, no memory). */
function guestOf(app: AppContext) {
  const key = app.settings as object;
  let g = guests.get(key);
  if (!g) {
    const store = new Store(':memory:', app.now);
    // W5.1 (docs/security/W5_REVIEW.md): and none of the owner's own things (people cards, library,
    // planner, agenda, life notes, recall, projects, skills, learned topics, files in his folder).
    const guestDir = join(app.dataDir, 'family-screen-guest');
    mkdirSync(guestDir, { recursive: true });
    const over: Partial<AppContext> = { offRecord: true, runs: undefined, store, memory: undefined, inner: undefined, tools: new ToolRegistry([]), uploads: undefined, moments: undefined, momentsWorker: undefined, together: undefined, people: undefined, library: undefined, planner: undefined, agenda: undefined, life: undefined, recall: undefined, vectors: undefined, projects: undefined, skills: undefined, learnTopics: undefined, learning: undefined, findings: undefined, research: undefined, recipes: undefined, workingStyle: undefined, readTogether: undefined, scrapbook: undefined, codemap: undefined, worktrees: undefined, drift: undefined, driftWork: undefined, memoryNudge: undefined, subscriptions: undefined, dataDir: guestDir } as Partial<AppContext>;
    const proxy = new Proxy(app, { get: (t, k: string) => (k in over ? over[k as keyof AppContext] : t[k as keyof AppContext]) }) as AppContext;
    guests.set(key, (g = { app: proxy, store, convs: new Map() }));
  }
  return g;
}

async function collect(app: AppContext, conv: string, text: string, child: ChildProfile): Promise<string> {
  let reply = '';
  let error = '';
  for await (const ev of runTurn(app, conv, text, AbortSignal.timeout(90_000), { talk: true, noTools: true, kidSafe: child })) {
    if (ev.type === 'token') reply += ev.text;
    else if (ev.type === 'replace') reply = (ev as { text?: string }).text ?? reply;
    else if (ev.type === 'error') error = ev.message;
  }
  return reply.trim() || error;
}

/** One Talk turn from the screen (see the file header). */
export async function screenTalk(owner: AppContext, screens: FamilyScreens, screen: Screen, person: unknown, raw: unknown): Promise<string> {
  const f = owner.family!;
  const T = (s: string) => trOwner(s, owner.settings.get());
  if (!screen.prefs.talk) throw new FamilyError(403, en('Talk is off on this screen. A parent can turn it on in Settings.'));
  const text = clip(raw, 500);
  if (!text) throw new FamilyError(400, en('Say or type something first.'));
  const who = person ? String(person) : '';
  const kid = who ? kidsOf(f).find((k) => k.id === who) : undefined;
  if (who && !kid?.child) throw new FamilyError(403, en('Only a kid account can talk from the family screen.'));
  if (inDim(screen.prefs, owner.now(), f.tz())) return T(SCREEN_RESTING);
  if (screenOffLimits(text)) return T(KID_OFF_REPLY);
  if (kid?.child) {
    const app = f.appOf?.(who);
    if (!app) throw new FamilyError(404, en('That person’s space is not available right now.'));
    const had = screens.conv(screen.id, who);
    let conv: string;
    if (had && app.store.getConversation(had)) conv = had;
    else {
      conv = app.store.createConversation({ title: en('Family screen'), channel: 'family-screen' }).id;
      screens.setConv(screen.id, who, conv);
    }
    return collect(app, conv, text, kid.child);
  }
  const g = guestOf(owner);
  const conv = g.convs.get(screen.id) ?? g.store.createConversation({ title: en('Family screen'), channel: 'family-screen' }).id;
  g.convs.set(screen.id, conv);
  return collect(g.app, conv, text, GUEST_CHILD(owner.now()));
}

const MAX_WAV = 3 * 1024 * 1024;

/**
 * The screen's own routes, answered before sign-in (the screen token is its credential):
 *   POST  /api/family-screen/pair           {code} → {token, screen}
 *   GET   /api/family-screen/board          → ScreenBoard
 *   POST  /api/family-screen/chores/:id/done {person}
 *   POST  /api/family-screen/shopping       {title}       PATCH /api/family-screen/shopping/:ref {done}
 *   POST  /api/family-screen/talk           {person?, text} → {reply}
 *   POST  /api/family-screen/hear           raw WAV → {text} (this server's own hearing only)
 */
export async function familyScreenRoutes(app: AppContext, req: IncomingMessage, res: ServerResponse, method: string, parts: string[], ip: string): Promise<void> {
  const [, b, c, d] = parts;
  const T = (s: string) => trOwner(s, app.settings.get());
  const screens = screensOf(app);
  const f = app.family;
  try {
    // A household member's own space: family screens belong to the owner's space only.
    if (app.member) {
      if (method !== 'GET') await readRaw(req, MAX_WAV).catch(() => undefined);
      throw new HttpError(403, T(en('Only the owner of this server can change this.')), { ownerOnly: true });
    }
    if (!screens || !f) {
      if (method !== 'GET') await readRaw(req, MAX_WAV).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    if (b === 'pair' && !c && method === 'POST') {
      const body = await readJson(req);
      const got = screens.pair(body.code, ip);
      if (!got) throw new HttpError(400, T(en('That code is not right or has run out. Make a new one in Settings.')));
      return send(res, 200, { token: got.token, screen: got.screen });
    }
    const screen = screens.byToken(req.headers[SCREEN_HEADER]);
    if (!screen) throw new HttpError(401, T(en('This screen is not paired. Pair it again with a code from Settings.')));
    screens.touch(screen.id);
    const tz = f.tz();
    const board = () => {
      let mine: { text: string; dueAt: string }[] | undefined;
      if (screen.prefs.myReminders && app.planner) {
        const now = app.now();
        const z = zonedParts(now, tz);
        const end = zonedToUtc(z.y, z.mo, z.d + 1, 0, 0, tz).toISOString();
        const from = new Date(now.getTime() - 60 * 60_000).toISOString();
        mine = app.planner.reminders({ status: 'pending', kind: 'timed' }).filter((r) => r.dueAt < end && r.dueAt >= from).map((r) => ({ text: r.text, dueAt: r.dueAt }));
      }
      return screenBoard(f, app.now(), screen, { ...(mine ? { mine } : {}), voice: Boolean(app.voice?.available.stt) });
    };
    if (b === 'board' && !c && method === 'GET') return send(res, 200, board());
    if (b === 'chores' && c && d === 'done' && method === 'POST') {
      const body = await readJson(req);
      const person = String(body.person ?? '');
      const chore = f.store.chore(Number(c));
      if (!chore || !chore.active) throw new HttpError(404, T(en('That chore is gone.')));
      if (chore.assignee !== person) throw new HttpError(403, T(en('That chore is someone else’s.')));
      if (!board().chores.some((p) => p.person === person && p.items.some((i) => i.id === chore.id && i.done === false))) throw new HttpError(409, T(en('Already done for today. Nice work!')));
      f.store.markDone(person, chore.id, { tz });
      return send(res, 200, { chores: board().chores });
    }
    if (b === 'shopping') {
      const boards = f.boards;
      const list = board().shopping;
      if (!boards || !list) throw new HttpError(404, T(en('Make a grocery list in Family first.')));
      if (!c && method === 'POST') {
        const body = await readJson(req);
        const title = clip(body.title, 120);
        if (!title) throw new HttpError(400, T(en('Type what to buy.')));
        boards.addCard('owner', list.id, { title });
        return send(res, 200, { shopping: board().shopping });
      }
      if (c && !d && method === 'PATCH') {
        const body = await readJson(req);
        if (!list.items.some((i) => i.ref === c)) throw new HttpError(404, T(en('That item is gone.')));
        boards.update('owner', c, { status: body.done === true ? 'done' : 'open' });
        return send(res, 200, { shopping: board().shopping });
      }
    }
    if (b === 'talk' && !c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { reply: await screenTalk(app, screens, screen, body.person, body.text) });
    }
    if (b === 'hear' && !c && method === 'POST') {
      const wav = await readRaw(req, MAX_WAV);
      if (!app.voice?.available.stt) throw new HttpError(404, T(en('Hearing is not set up on this server.')));
      return send(res, 200, { text: clip(await app.voice.transcribe(wav), 300) });
    }
    if (method !== 'GET') await readJson(req).catch(() => undefined);
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof FamilyError) throw new HttpError(err.status, T(err.message));
    throw err;
  }
}
