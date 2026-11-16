// R8 (docs/FAMILY.md): Family. One household store, <data>/shared/family.db, next to the shared boards
// (never on the demo): chores (recurring, assigned to a person, worth points and/or money), the marks a
// kid makes ("done", photo optional) that a parent approves, the allowance ledger (earned, paid out,
// balance; paying is a record only, nothing moves money), the weekly summary, the kids' activity
// summary (topics and minutes, never their words), and the grocery list's extra columns (aisle and
// store) over a shared list (src/shared-boards.ts). Kid-safe member mode (the `child` profile on a
// household member, src/household.ts) is enforced here: routes, tools, bedtime, the daily time limit
// and the persona note. Every call names the person asking; only parents change chores and money.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { en, trOwner } from './i18n.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import { detectCrisis, detectExplicit } from './safety.ts';
import type { AppContext } from './chat.ts';
import type { SharedBoardStore } from './shared-boards.ts';
import type { Tool } from './tools/types.ts';

// ------------------------------------------------------------------------------------------------
// Kid-safe member mode: the profile and its checks
// ------------------------------------------------------------------------------------------------

export const AGE_BANDS = ['6-9', '10-12', '13-17'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
/** Pick-list values for the daily time limit (minutes; 0 = no limit). */
export const KID_MINUTES = [0, 30, 45, 60, 90, 120, 180] as const;

export interface ChildProfile {
  band: AgeBand;
  since: string;
  /** Bedtime: no chatting from `from` to `to` (HH:MM, the household's time zone). null = none. */
  bedtime: { from: string; to: string } | null;
  /** Minutes a day (0 = no limit). Counted in 5-minute blocks with a message in them. */
  minutesPerDay: number;
  /** A web search in strict safe-search mode (only providers with a safe-search switch). */
  safeSearch: boolean;
  /** Shop sites a search may still show (host names); everything else that sells is left out. */
  shopAllow: string[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export class FamilyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A profile from a request (checked); `base` keeps what isn't given. */
export function cleanChild(v: unknown, now: Date, base?: ChildProfile): ChildProfile {
  const r = (v ?? {}) as Record<string, unknown>;
  const band = (r.band ?? base?.band ?? '10-12') as AgeBand;
  if (!AGE_BANDS.includes(band)) throw new FamilyError(400, en('Pick an age band.'));
  let bedtime: ChildProfile['bedtime'] = base ? base.bedtime : { from: '20:30', to: '07:00' };
  if (r.bedtime === null || r.bedtime === false) bedtime = null;
  else if (r.bedtime !== undefined) {
    const b = r.bedtime as Record<string, unknown>;
    if (!HHMM.test(String(b.from ?? '')) || !HHMM.test(String(b.to ?? ''))) throw new FamilyError(400, en('Bedtime needs a start and an end time.'));
    bedtime = { from: String(b.from), to: String(b.to) };
  }
  const minutes = r.minutesPerDay === undefined ? (base?.minutesPerDay ?? 0) : Number(r.minutesPerDay);
  if (!(KID_MINUTES as readonly number[]).includes(minutes)) throw new FamilyError(400, en('Pick one of the offered limits.'));
  const allow = r.shopAllow === undefined ? (base?.shopAllow ?? []) : Array.isArray(r.shopAllow) ? r.shopAllow : String(r.shopAllow).split(/[\s,]+/);
  const shopAllow = [...new Set(allow.map((h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))].slice(0, 20);
  return { band, since: base?.since ?? now.toISOString(), bedtime, minutesPerDay: minutes, safeSearch: r.safeSearch === undefined ? (base?.safeSearch ?? false) : r.safeSearch === true, shopAllow };
}

const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** True while it is bedtime for this profile (the window may cross midnight). */
export function inBedtime(p: ChildProfile, now: Date, tz?: string): boolean {
  if (!p.bedtime) return false;
  const z = zonedParts(now, tz);
  const m = z.h * 60 + z.mi;
  const a = mins(p.bedtime.from);
  const b = mins(p.bedtime.to);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}

/**
 * Route families a child may not use at all, and those they may only read. Anything not listed
 * keeps the member rules (src/household.ts memberRouteCheck runs first).
 */
const CHILD_DENIED: ReadonlySet<string> = new Set(['hands', 'computer', 'mail', 'inbox', 'errands', 'shares', 'other-apps', 'alexa', 'shortcuts', 'automations', 'decisions', 'mentions', 'scrapbook-share']);
const CHILD_READ_ONLY: ReadonlySet<string> = new Set(['adult', 'persona', 'character', 'companions', 'gallery', 'groups', 'look', 'skills', 'sara', 'working-style', 'push-test']);
/** Talking routes that bedtime and the daily limit stop (reading old chats still works). */
const TALK = (a: string, method: string, parts: string[]) => (a === 'conversations' && method === 'POST' && (parts[2] === 'messages' || parts[2] === 'regenerate' || parts[2] === 'continue')) || a === 'live' || a === 'calls' || a === 'video';

/** The shared state the checks read (set once by main.ts; tests set their own). */
export interface FamilyRuntime {
  store?: FamilyStore;
  tz: () => string | undefined;
  now: () => Date;
}
let runtime: FamilyRuntime = { tz: () => undefined, now: () => new Date() };
export function setFamilyRuntime(r: Partial<FamilyRuntime>): void {
  runtime = { ...runtime, ...r };
}
export function familyRuntime(): FamilyRuntime {
  return runtime;
}

/** Why a child's talking stops now (bedtime, the daily limit), or undefined. */
export function kidPause(kidId: string, p: ChildProfile, now = runtime.now()): string | undefined {
  if (inBedtime(p, now, runtime.tz())) return en("It's bedtime on this server. Chat again in the morning.");
  if (p.minutesPerDay > 0 && (runtime.store?.minutesToday(kidId, now, runtime.tz()) ?? 0) >= p.minutesPerDay) return en("You've used today's time on this server. It starts again tomorrow.");
  return undefined;
}

/** Server-side route check for a child member (after the member checks). */
export function childRouteCheck(kidId: string, p: ChildProfile, method: string, parts: string[]): { status: number; message: string } | undefined {
  const [a] = parts;
  const refuse = { status: 403, message: en('A parent turned this off for you.') };
  if (CHILD_DENIED.has(a)) return refuse;
  if (CHILD_READ_ONLY.has(a) && method !== 'GET') return refuse;
  // Settings: a parent sets them (adult mode, models and her character stay off; the app's look is kept in the browser).
  if (a === 'settings' && method !== 'GET') return refuse;
  if (a === 'household' && parts[2] === 'delete') return refuse;
  if (TALK(a, method, parts)) {
    const why = kidPause(kidId, p);
    if (why) return { status: 403, message: why };
  }
  return undefined;
}

/** Settings a child can never have on (forced in MemberSettings.get, whatever their file says). */
export function childSettings<T extends Record<string, unknown>>(s: T): T {
  return { ...s, adultMode: { on: false }, otherApps: { ...((s.otherApps as Record<string, unknown>) ?? {}), tools: false, changes: false } };
}

/** The only tools a child's companion offers (an allowlist: new tools stay off for kids until listed). */
export const KID_TOOLS: ReadonlySet<string> = new Set(['todo', 'remind', 'note', 'recall', 'library', 'scrapbook', 'moments', 'make_document', 'settings_guide', 'household_lists', 'decide', 'compare', 'facts_list', 'fact_forget', 'board_list', 'card_add', 'card_move', 'card_comment', 'chore_list', 'chore_done', 'allowance_balance', 'kid_search', 'ask_choice', 'ask_everything', 'humanize_text']);

/**
 * Gates a child's tool registry: everything outside KID_TOOLS is unavailable while they are a child
 * (so it is neither offered nor run when a crafted call names it), including tools added later.
 */
export function gateKidTools(reg: { list(): Tool[]; add(t: Tool): void }, isKid: () => boolean): void {
  const wrap = (t: Tool): Tool => (KID_TOOLS.has(t.spec.name) ? t : new Proxy(t, { get: (target, prop) => (prop === 'isAvailable' ? () => !isKid() && (target.isAvailable?.() ?? true) : Reflect.get(target, prop, target)) }));
  for (const t of reg.list()) reg.add(wrap(t));
  const add = reg.add.bind(reg);
  reg.add = (t: Tool) => add(wrap(t));
}

/** Shops a kid's search leaves out unless a parent allowed the site. */
const SHOP_HOST = /(^|\.)(amazon|ebay|walmart|target|bestbuy|etsy|aliexpress|temu|shein|wish|homedepot|lowes|costco|newegg|wayfair|steampowered|store\.steampowered|roblox|epicgames|apps\.apple|play\.google)\.|shop|store\.|cart|checkout/i;
export function kidResultOk(url: string, text: string, p: ChildProfile): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  if (detectExplicit(`${url} ${text}`)) return false;
  if (p.shopAllow.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return !SHOP_HOST.test(`${host}/${new URL(url).pathname}`);
}

/** Asks a child gets a kind "not here" for, without the model (crisis words still get the crisis help). */
const KID_OFF = /\b(sex|porn|nude|naked|nsfw|hookup|onlyfans|dating app|buy (a )?(gun|vape|weed|alcohol|beer)|vape|weed|cocaine|meth|gamble|gambling|casino|bet on|kill (him|her|them)|how to make a (bomb|weapon))\b/i;
export function kidOffLimits(text: string): boolean {
  return KID_OFF.test(text) || detectExplicit(text);
}
export const KID_OFF_REPLY = en("That's not something I can help with here. A parent or another grown-up you trust is a great person to ask. Want to talk about something else?");

/** The persona note for a child (her tone and rules), by age band. */
export function kidNote(p: ChildProfile, name: string): string {
  const words = p.band === '6-9' ? 'very short sentences and easy words, like for a 7-year-old' : p.band === '10-12' ? 'clear, friendly words for a 10 to 12 year old' : 'plain, respectful words for a teenager';
  return `You are talking with ${name}, a child (age ${p.band}) in this household; a parent set this up. Use ${words}. Be warm, patient and encouraging, like a kind tutor or a friendly older cousin: never romantic, flirty or "partner"-like, no adult topics, no scary details. For homework, help them learn (hints, questions, one step at a time) instead of handing over the answer; for a book report, essay or other school assignment, coach (an outline, guiding questions, feedback on their own draft) and never write it for them. Never ask for or repeat personal details (address, school name, passwords, photos of themselves). Never suggest buying anything or give shopping links; never offer to email or contact anyone. For big worries, feelings that hurt, or anything unsafe, say kindly that a parent or a trusted grown-up should know, and give the crisis help when it is serious.`;
}

// ------------------------------------------------------------------------------------------------
// Activity summary: topics, never words
// ------------------------------------------------------------------------------------------------

const TOPICS: [string, RegExp][] = [
  ['homework', /\b(homework|assignment|worksheet|essay|project|study|test|quiz|exam)\b/i],
  ['math', /\b(math|fraction|multipl|divid|equation|algebra|geometry|number|plus|minus)\w*/i],
  ['reading', /\b(read|book|story|stories|poem|spelling|grammar|write|writing)\w*/i],
  ['science', /\b(science|planet|space|animal|dinosaur|volcano|chemistry|biology|physics|experiment)\w*/i],
  ['history', /\b(history|war|president|ancient|country|countries|geography|map)\w*/i],
  ['games', /\b(game|minecraft|roblox|fortnite|play|level|pokemon)\w*/i],
  ['music and art', /\b(music|song|draw|drawing|paint|art|piano|guitar|sing)\w*/i],
  ['sports', /\b(soccer|football|basketball|baseball|swim|sport|practice|team)\w*/i],
  ['feelings', /\b(sad|angry|scared|worried|lonely|upset|happy|friend|bully|feel)\w*/i],
  ['chores and money', /\b(chore|allowance|points|clean|room|dishes)\w*/i],
];
export function topicsOf(text: string): string[] {
  const out = TOPICS.filter(([, re]) => re.test(text)).map(([t]) => t);
  return out.length ? out.slice(0, 3) : ['other'];
}

// ------------------------------------------------------------------------------------------------
// Chores, marks, the ledger
// ------------------------------------------------------------------------------------------------

export type ChoreRepeat = 'once' | 'daily' | 'weekdays' | 'weekly';
export const CHORE_REPEATS: readonly ChoreRepeat[] = ['once', 'daily', 'weekdays', 'weekly'];

export interface Chore {
  id: number;
  title: string;
  assignee: string;
  points: number;
  cents: number;
  repeat: ChoreRepeat;
  dueAt: string;
  photo: boolean;
  active: boolean;
  createdBy: string;
  createdAt: string;
}
export interface ChoreMark {
  id: number;
  choreId: number;
  title: string;
  kid: string;
  dueAt: string;
  doneAt: string;
  note: string;
  photo: boolean;
  status: 'waiting' | 'approved' | 'rejected';
  points: number;
  cents: number;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface LedgerRow {
  id: number;
  kid: string;
  kind: 'earned' | 'paid' | 'adjust';
  cents: number;
  points: number;
  note: string;
  by: string;
  at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, assignee TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0,
  cents INTEGER NOT NULL DEFAULT 0, repeat TEXT NOT NULL DEFAULT 'weekly', due_at TEXT NOT NULL, photo INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chore_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chore_id INTEGER NOT NULL, title TEXT NOT NULL, kid TEXT NOT NULL, due_at TEXT NOT NULL,
  done_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', photo INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'waiting',
  points INTEGER NOT NULL DEFAULT 0, cents INTEGER NOT NULL DEFAULT 0, decided_by TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS allowance_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kid TEXT NOT NULL, kind TEXT NOT NULL, cents INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', mark_id INTEGER, by TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS family_parents (person TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS kid_topics (kid TEXT NOT NULL, day TEXT NOT NULL, topic TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kid, day, topic));
CREATE TABLE IF NOT EXISTS kid_minutes (kid TEXT NOT NULL, day TEXT NOT NULL, block INTEGER NOT NULL, PRIMARY KEY (kid, day, block));
CREATE TABLE IF NOT EXISTS grocery_lists (board_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grocery_items (ref TEXT PRIMARY KEY, board_id TEXT NOT NULL, category TEXT, store TEXT, price TEXT, checked_at TEXT);
CREATE TABLE IF NOT EXISTS family_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
type Row = Record<string, string | number | null>;
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** "$2.50", "2.5", 2.5 → 250 cents (refuses negatives and nonsense). */
export function centsOf(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new FamilyError(400, en('Type an amount like 2.50.'));
  return Math.round(n * 100);
}

/** The local day (YYYY-MM-DD) of an instant. */
export function localDay(at: Date, tz?: string): string {
  const z = zonedParts(at, tz);
  return `${z.y}-${String(z.mo).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
}

/** The next due time after `from` (same wall time; weekdays skip Saturday and Sunday). */
export function nextDue(dueIso: string, repeat: ChoreRepeat, from: Date, tz?: string): string | null {
  if (repeat === 'once') return null;
  const d = new Date(dueIso);
  const z = zonedParts(d, tz);
  for (let i = 1; i < 400; i++) {
    const cand = zonedToUtc(z.y, z.mo, z.d + i * (repeat === 'weekly' ? 7 : 1), z.h, z.mi, tz);
    const wd = zonedParts(cand, tz).wd;
    if (repeat === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (cand.getTime() > from.getTime()) return cand.toISOString();
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Grocery: aisles (categories) by words, in store order
// ------------------------------------------------------------------------------------------------

export const AISLES: { id: string; name: string; re: RegExp }[] = [
  { id: 'produce', name: en('Produce'), re: /\b(apple|banana|orange|lemon|lime|grape|berr|strawberr|blueberr|melon|lettuce|salad|spinach|kale|tomato|potato|onion|garlic|carrot|celery|pepper|cucumber|broccoli|avocado|mushroom|fruit|veg|herb|cilantro|basil|corn|zucchini|peach|pear)\w*/i },
  { id: 'bakery', name: en('Bakery'), re: /\b(bread|bagel|bun|roll|tortilla|muffin|croissant|cake|pita|baguette)s?\b/i },
  { id: 'dairy', name: en('Dairy and eggs'), re: /\b(milk|cheese|yogurt|yoghurt|butter|cream|egg|eggs|sour cream|cottage)\b/i },
  { id: 'meat', name: en('Meat and fish'), re: /\b(chicken|beef|pork|turkey|ham|bacon|sausage|steak|ground|fish|salmon|tuna|shrimp|meat|lamb|hot dog)s?\b/i },
  { id: 'frozen', name: en('Frozen'), re: /\b(frozen|ice cream|pizza|popsicle|waffles)\b/i },
  { id: 'pantry', name: en('Pantry'), re: /\b(rice|pasta|noodle|cereal|oat|oatmeal|flour|sugar|salt|oil|vinegar|sauce|soup|beans|can|canned|peanut butter|jam|honey|spice|coffee|tea|baking)s?\b/i },
  { id: 'snacks', name: en('Snacks'), re: /\b(chips|crackers|cookies|snack|popcorn|pretzel|granola|candy|chocolate|nuts)\b/i },
  { id: 'drinks', name: en('Drinks'), re: /\b(water|juice|soda|sparkling|lemonade|drink|beer|wine)s?\b/i },
  { id: 'household', name: en('Household'), re: /\b(paper towel|toilet paper|tissue|detergent|soap|dish|trash bag|foil|wrap|sponge|bleach|cleaner|batteries|light bulb)s?\b/i },
  { id: 'personal', name: en('Personal care'), re: /\b(shampoo|conditioner|toothpaste|toothbrush|deodorant|lotion|razor|floss|sunscreen|vitamin|medicine|bandage)s?\b/i },
  { id: 'baby', name: en('Baby'), re: /\b(diaper|wipes|formula|baby)s?\b/i },
  { id: 'pets', name: en('Pets'), re: /\b(dog food|cat food|litter|pet|kibble|treats)\b/i },
];
export const OTHER_AISLE = { id: 'other', name: en('Other') };
export function aisleOf(title: string): string {
  return AISLES.find((a) => a.re.test(title))?.id ?? 'other';
}
/** Staples worth a price check ("cheapest near me"): the first few items that are everyday groceries. */
export const STAPLES = /\b(milk|eggs?|bread|butter|bananas?|rice|coffee|cheese|chicken|paper towels?|toilet paper|diapers?)\b/i;

export interface GroceryItem {
  ref: string;
  title: string;
  done: boolean;
  aisle: string;
  store: string | null;
  price: string | null;
  checkedAt: string | null;
  assignee: string | null;
}

// ------------------------------------------------------------------------------------------------
// The store
// ------------------------------------------------------------------------------------------------

export class FamilyStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;
  readonly photoDir: string;
  /** Told when something changes (people whose Today/Family page should refresh). */
  readonly listeners = new Set<(ev: { people: string[]; what: string }) => void>();

  constructor(file: string, now: () => Date = () => new Date()) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    this.#now = now;
    this.photoDir = join(dirname(file), 'family-photos');
  }
  close(): void {
    this.db.close();
  }
  #iso(): string {
    return this.#now().toISOString();
  }
  #emit(people: string[], what: string): void {
    for (const fn of this.listeners) {
      try {
        fn({ people: [...new Set(people)], what });
      } catch {
        /* a listener never breaks a change */
      }
    }
  }
  #meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM family_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  #setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO family_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------------------------------------------------------------- parents
  parents(): string[] {
    return ['owner', ...(this.db.prepare('SELECT person FROM family_parents ORDER BY person').all() as { person: string }[]).map((r) => r.person).filter((p) => p !== 'owner')];
  }
  isParent(person: string): boolean {
    return person === 'owner' || Boolean(this.db.prepare('SELECT 1 FROM family_parents WHERE person = ?').get(person));
  }
  setParent(person: string, on: boolean): void {
    if (person === 'owner') return;
    if (on) this.db.prepare('INSERT OR IGNORE INTO family_parents (person) VALUES (?)').run(person);
    else this.db.prepare('DELETE FROM family_parents WHERE person = ?').run(person);
  }
  #mustParent(person: string): void {
    if (!this.isParent(person)) throw new FamilyError(403, en('Only a parent can do that.'));
  }

  // ---------------------------------------------------------------- chores
  #chore(r: Row): Chore {
    return { id: Number(r.id), title: String(r.title), assignee: String(r.assignee), points: Number(r.points), cents: Number(r.cents), repeat: String(r.repeat) as ChoreRepeat, dueAt: String(r.due_at), photo: Boolean(r.photo), active: Boolean(r.active), createdBy: String(r.created_by), createdAt: String(r.created_at) };
  }
  chore(id: number): Chore | undefined {
    const r = this.db.prepare('SELECT * FROM chores WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#chore(r) : undefined;
  }
  /** Chores a person sees: a parent sees all; a kid sees their own. */
  chores(person: string, o: { all?: boolean } = {}): Chore[] {
    const rows = (this.isParent(person) ? this.db.prepare('SELECT * FROM chores ORDER BY due_at, id').all() : this.db.prepare('SELECT * FROM chores WHERE assignee = ? ORDER BY due_at, id').all(person)) as Row[];
    return rows.map((r) => this.#chore(r)).filter((c) => o.all || c.active);
  }
  addChore(by: string, c: { title: unknown; assignee: unknown; points?: unknown; amount?: unknown; repeat?: unknown; dueAt?: unknown; photo?: unknown; tz?: string }, known: string[]): Chore {
    this.#mustParent(by);
    const title = clip(c.title, 100);
    if (!title) throw new FamilyError(400, en('Name the chore.'));
    const assignee = String(c.assignee ?? '');
    if (!known.includes(assignee)) throw new FamilyError(400, en('Pick who does it.'));
    const repeat = (c.repeat ?? 'weekly') as ChoreRepeat;
    if (!CHORE_REPEATS.includes(repeat)) throw new FamilyError(400, en('Pick how often.'));
    const points = Math.max(0, Math.min(1000, Math.floor(Number(c.points ?? 0)) || 0));
    const cents = centsOf(c.amount);
    // Default: tomorrow at 6 pm (the household's time).
    const z = zonedParts(this.#now(), c.tz);
    const due = c.dueAt ? new Date(String(c.dueAt)) : zonedToUtc(z.y, z.mo, z.d + 1, 18, 0, c.tz);
    if (Number.isNaN(due.getTime())) throw new FamilyError(400, en('That date doesn’t look right.'));
    const id = Number(this.db.prepare('INSERT INTO chores (title, assignee, points, cents, repeat, due_at, photo, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(title, assignee, points, cents, repeat, due.toISOString(), c.photo === true ? 1 : 0, by, this.#iso()).lastInsertRowid);
    this.#emit([assignee, ...this.parents()], 'chore');
    return this.chore(id)!;
  }
  updateChore(by: string, id: number, patch: { title?: unknown; points?: unknown; amount?: unknown; repeat?: unknown; dueAt?: unknown; photo?: unknown; active?: unknown; assignee?: unknown }, known: string[]): Chore {
    this.#mustParent(by);
    const c = this.chore(id);
    if (!c) throw new FamilyError(404, en('That chore is gone.'));
    const title = patch.title !== undefined ? clip(patch.title, 100) || c.title : c.title;
    const repeat = patch.repeat !== undefined ? (patch.repeat as ChoreRepeat) : c.repeat;
    if (!CHORE_REPEATS.includes(repeat)) throw new FamilyError(400, en('Pick how often.'));
    const assignee = patch.assignee !== undefined ? String(patch.assignee) : c.assignee;
    if (!known.includes(assignee)) throw new FamilyError(400, en('Pick who does it.'));
    const due = patch.dueAt !== undefined ? new Date(String(patch.dueAt)) : new Date(c.dueAt);
    if (Number.isNaN(due.getTime())) throw new FamilyError(400, en('That date doesn’t look right.'));
    this.db.prepare('UPDATE chores SET title = ?, assignee = ?, points = ?, cents = ?, repeat = ?, due_at = ?, photo = ?, active = ? WHERE id = ?').run(
      title, assignee,
      patch.points !== undefined ? Math.max(0, Math.min(1000, Math.floor(Number(patch.points)) || 0)) : c.points,
      patch.amount !== undefined ? centsOf(patch.amount) : c.cents,
      repeat, due.toISOString(),
      patch.photo !== undefined ? (patch.photo === true ? 1 : 0) : c.photo ? 1 : 0,
      patch.active !== undefined ? (patch.active === false ? 0 : 1) : c.active ? 1 : 0, id,
    );
    this.#emit([assignee, c.assignee, ...this.parents()], 'chore');
    return this.chore(id)!;
  }
  removeChore(by: string, id: number): boolean {
    this.#mustParent(by);
    const c = this.chore(id);
    if (!c) return false;
    this.db.prepare('DELETE FROM chores WHERE id = ?').run(id);
    this.#emit([c.assignee, ...this.parents()], 'chore');
    return true;
  }
  /** A chore by its number or (part of) its title, among the person's own (a parent: everyone's). */
  findChore(person: string, q: unknown): Chore | undefined {
    const s = String(q ?? '').trim().replace(/^#/, '');
    const list = this.chores(person);
    if (/^\d+$/.test(s)) return list.find((c) => c.id === Number(s));
    const l = s.toLowerCase();
    return l ? (list.find((c) => c.title.toLowerCase() === l) ?? list.find((c) => c.title.toLowerCase().includes(l))) : undefined;
  }

  // ---------------------------------------------------------------- marks (done, then approved)
  #mark(r: Row): ChoreMark {
    return { id: Number(r.id), choreId: Number(r.chore_id), title: String(r.title), kid: String(r.kid), dueAt: String(r.due_at), doneAt: String(r.done_at), note: String(r.note ?? ''), photo: Boolean(r.photo), status: String(r.status) as ChoreMark['status'], points: Number(r.points), cents: Number(r.cents), decidedBy: (r.decided_by as string | null) ?? null, decidedAt: (r.decided_at as string | null) ?? null };
  }
  mark(id: number): ChoreMark | undefined {
    const r = this.db.prepare('SELECT * FROM chore_marks WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#mark(r) : undefined;
  }
  marks(person: string, o: { status?: ChoreMark['status']; limit?: number } = {}): ChoreMark[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (!this.isParent(person)) {
      where.push('kid = ?');
      args.push(person);
    }
    if (o.status) {
      where.push('status = ?');
      args.push(o.status);
    }
    return (this.db.prepare(`SELECT * FROM chore_marks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, o.limit ?? 50) as Row[]).map((r) => this.#mark(r));
  }
  /**
   * "I did it": the person it's assigned to (or a parent for them) marks the chore done. The mark waits
   * for a parent's OK; a repeating chore moves on to its next time at once, a one-time chore rests.
   */
  markDone(person: string, choreId: number, o: { note?: unknown; photo?: Buffer; tz?: string } = {}): ChoreMark {
    const c = this.chore(choreId);
    if (!c || !c.active) throw new FamilyError(404, en('That chore is gone.'));
    if (c.assignee !== person && !this.isParent(person)) throw new FamilyError(403, en('That chore is someone else’s.'));
    if (this.db.prepare("SELECT 1 FROM chore_marks WHERE chore_id = ? AND due_at = ? AND status != 'rejected'").get(c.id, c.dueAt)) throw new FamilyError(409, en('Already marked done. It waits for a parent’s OK.'));
    if (o.photo && o.photo.length > 4 * 1024 * 1024) throw new FamilyError(413, en('That photo is too big (4 MB at most).'));
    const id = Number(this.db.prepare('INSERT INTO chore_marks (chore_id, title, kid, due_at, done_at, note, photo, points, cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(c.id, c.title, c.assignee, c.dueAt, this.#iso(), clip(o.note, 200), o.photo ? 1 : 0, c.points, c.cents).lastInsertRowid);
    if (o.photo) {
      mkdirSync(this.photoDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.photoDir, `${id}.jpg`), o.photo, { mode: 0o600 });
    }
    const next = nextDue(c.dueAt, c.repeat, this.#now(), o.tz);
    if (next) this.db.prepare('UPDATE chores SET due_at = ? WHERE id = ?').run(next, c.id);
    else this.db.prepare('UPDATE chores SET active = 0 WHERE id = ?').run(c.id);
    this.#emit([c.assignee, ...this.parents()], 'mark');
    return this.mark(id)!;
  }
  /** The photo of a mark, for the kid who made it and the parents. */
  photo(person: string, markId: number): Buffer | undefined {
    const m = this.mark(markId);
    if (!m || !m.photo || (m.kid !== person && !this.isParent(person))) return undefined;
    const f = join(this.photoDir, `${m.id}.jpg`);
    return existsSync(f) ? readFileSync(f) : undefined;
  }
  /** A parent's OK: the points and money go into the kid's ledger (once). */
  approve(by: string, markId: number): ChoreMark {
    this.#mustParent(by);
    const m = this.mark(markId);
    if (!m) throw new FamilyError(404, en('That one is gone.'));
    if (m.status === 'approved') return m;
    if (m.kid === by) throw new FamilyError(403, en('Someone else approves your own chores.'));
    const at = this.#iso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE chore_marks SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(by, at, m.id);
      if (m.cents || m.points) this.db.prepare("INSERT INTO allowance_ledger (kid, kind, cents, points, note, mark_id, by, at) VALUES (?, 'earned', ?, ?, ?, ?, ?, ?)").run(m.kid, m.cents, m.points, m.title, m.id, by, at);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.#emit([m.kid, ...this.parents()], 'approve');
    return this.mark(m.id)!;
  }
  /** "Not yet": nothing is earned; a one-time chore comes back to do. */
  reject(by: string, markId: number, note?: unknown): ChoreMark {
    this.#mustParent(by);
    const m = this.mark(markId);
    if (!m) throw new FamilyError(404, en('That one is gone.'));
    if (m.status === 'approved') throw new FamilyError(409, en('Already approved.'));
    this.db.prepare("UPDATE chore_marks SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ?").run(by, this.#iso(), clip(note ?? m.note, 200), m.id);
    const c = this.chore(m.choreId);
    if (c && !c.active && c.repeat === 'once') this.db.prepare('UPDATE chores SET active = 1 WHERE id = ?').run(c.id);
    this.#emit([m.kid, ...this.parents()], 'reject');
    return this.mark(m.id)!;
  }

  // ---------------------------------------------------------------- the allowance ledger
  ledger(person: string, kid: string, limit = 50): LedgerRow[] {
    if (kid !== person && !this.isParent(person)) throw new FamilyError(403, en('Only a parent can see that.'));
    return (this.db.prepare('SELECT * FROM allowance_ledger WHERE kid = ? ORDER BY id DESC LIMIT ?').all(kid, limit) as Row[]).map((r) => ({ id: Number(r.id), kid: String(r.kid), kind: String(r.kind) as LedgerRow['kind'], cents: Number(r.cents), points: Number(r.points), note: String(r.note), by: String(r.by), at: String(r.at) }));
  }
  balance(person: string, kid: string): { earnedCents: number; paidCents: number; balanceCents: number; points: number; waiting: number } {
    if (kid !== person && !this.isParent(person)) throw new FamilyError(403, en('Only a parent can see that.'));
    const r = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'earned' THEN cents WHEN kind = 'adjust' THEN cents ELSE 0 END), 0) AS earned, COALESCE(SUM(CASE WHEN kind = 'paid' THEN cents ELSE 0 END), 0) AS paid, COALESCE(SUM(points), 0) AS points FROM allowance_ledger WHERE kid = ?").get(kid) as { earned: number; paid: number; points: number };
    const waiting = Number((this.db.prepare("SELECT COUNT(*) AS n FROM chore_marks WHERE kid = ? AND status = 'waiting'").get(kid) as { n: number }).n);
    return { earnedCents: Number(r.earned), paidCents: Number(r.paid), balanceCents: Number(r.earned) - Number(r.paid), points: Number(r.points), waiting };
  }
  /** "Paid out": a record only (cash, a transfer they made themselves). Nothing here moves money. */
  pay(by: string, kid: string, amount: unknown, note?: unknown): LedgerRow {
    this.#mustParent(by);
    const cents = centsOf(amount);
    if (!cents) throw new FamilyError(400, en('Type an amount like 2.50.'));
    const bal = this.balance(by, kid).balanceCents;
    if (cents > bal) throw new FamilyError(400, en('That is more than the balance.'));
    const id = Number(this.db.prepare("INSERT INTO allowance_ledger (kid, kind, cents, points, note, by, at) VALUES (?, 'paid', ?, 0, ?, ?, ?)").run(kid, cents, clip(note, 120) || 'Paid out', by, this.#iso()).lastInsertRowid);
    this.#emit([kid, ...this.parents()], 'pay');
    return this.ledger(by, kid, 200).find((r) => r.id === id)!;
  }

  // ---------------------------------------------------------------- kids' activity (topics, minutes)
  noteTurn(kid: string, text: string, at: Date, tz?: string): string[] {
    const day = localDay(at, tz);
    const z = zonedParts(at, tz);
    const topics = topicsOf(text);
    for (const t of topics) this.db.prepare('INSERT INTO kid_topics (kid, day, topic, n) VALUES (?, ?, ?, 1) ON CONFLICT(kid, day, topic) DO UPDATE SET n = n + 1').run(kid, day, t);
    this.db.prepare('INSERT OR IGNORE INTO kid_minutes (kid, day, block) VALUES (?, ?, ?)').run(kid, day, Math.floor((z.h * 60 + z.mi) / 5));
    return topics;
  }
  noteBlocked(kid: string, at: Date, tz?: string): void {
    this.db.prepare("INSERT INTO kid_topics (kid, day, topic, n) VALUES (?, ?, 'kept off', 1) ON CONFLICT(kid, day, topic) DO UPDATE SET n = n + 1").run(kid, localDay(at, tz));
  }
  minutesToday(kid: string, at: Date, tz?: string): number {
    return 5 * Number((this.db.prepare('SELECT COUNT(*) AS n FROM kid_minutes WHERE kid = ? AND day = ?').get(kid, localDay(at, tz)) as { n: number }).n);
  }
  /** What a parent sees: topics and minutes a day for the last `days` days, never the words. */
  activity(by: string, kid: string, at: Date, tz?: string, days = 7): { days: { day: string; minutes: number; topics: { topic: string; n: number }[] }[] } {
    this.#mustParent(by);
    const out: { day: string; minutes: number; topics: { topic: string; n: number }[] }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = localDay(new Date(at.getTime() - i * 86_400_000), tz);
      const topics = (this.db.prepare('SELECT topic, n FROM kid_topics WHERE kid = ? AND day = ? ORDER BY n DESC, topic').all(kid, day) as { topic: string; n: number }[]).map((r) => ({ topic: r.topic, n: Number(r.n) }));
      const minutes = 5 * Number((this.db.prepare('SELECT COUNT(*) AS n FROM kid_minutes WHERE kid = ? AND day = ?').get(kid, day) as { n: number }).n);
      out.push({ day, minutes, topics });
    }
    return { days: out };
  }

  // ---------------------------------------------------------------- weekly summary and Today
  /** The week in chores and money, per kid (for the parents' Sunday summary). */
  weekly(kids: { id: string; name: string }[], at: Date): { kid: string; name: string; done: number; approved: number; waiting: number; earnedCents: number; points: number; paidCents: number; balanceCents: number }[] {
    const since = new Date(at.getTime() - 7 * 86_400_000).toISOString();
    return kids.map((k) => {
      const m = this.db.prepare("SELECT COUNT(*) AS done, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting FROM chore_marks WHERE kid = ? AND done_at >= ?").get(k.id, since) as { done: number; approved: number | null; waiting: number | null };
      const l = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN kind != 'paid' THEN cents ELSE 0 END), 0) AS earned, COALESCE(SUM(CASE WHEN kind = 'paid' THEN cents ELSE 0 END), 0) AS paid, COALESCE(SUM(points), 0) AS points FROM allowance_ledger WHERE kid = ? AND at >= ?").get(k.id, since) as { earned: number; paid: number; points: number };
      return { kid: k.id, name: k.name, done: Number(m.done), approved: Number(m.approved ?? 0), waiting: Number(m.waiting ?? 0), earnedCents: Number(l.earned), points: Number(l.points), paidCents: Number(l.paid), balanceCents: this.balance('owner', k.id).balanceCents };
    });
  }
  /** Once a week (Sunday from 6 pm, the household's time): the summary text, or undefined. */
  weeklyDue(kids: { id: string; name: string }[], at: Date, tz?: string): string | undefined {
    if (!kids.length) return undefined;
    const z = zonedParts(at, tz);
    if (z.wd !== 0 || z.h < 18) return undefined;
    const week = localDay(at, tz);
    if (this.#meta('weekly') === week) return undefined;
    this.#setMeta('weekly', week);
    const rows = this.weekly(kids, at);
    if (!rows.some((r) => r.done || r.earnedCents || r.paidCents || r.balanceCents)) return undefined;
    return rows.map((r) => `${r.name}: ${r.done} chore${r.done === 1 ? '' : 's'} done (${r.approved} approved${r.waiting ? `, ${r.waiting} waiting for you` : ''}), earned ${money(r.earnedCents)}${r.points ? ` and ${r.points} points` : ''}, paid out ${money(r.paidCents)}, balance ${money(r.balanceCents)}.`).join('\n');
  }
  /** The Family tile on Today: a parent's approvals and kids' balances, or a kid's own chores and balance. */
  todayTile(person: string, kids: { id: string; name: string }[], at: Date, tz?: string): { role: 'parent' | 'kid'; waiting: ChoreMark[]; due: Chore[]; kids: { id: string; name: string; balanceCents: number; points: number; waiting: number }[]; balance?: ReturnType<FamilyStore['balance']> } | undefined {
    const endOfDay = zonedToUtc(zonedParts(at, tz).y, zonedParts(at, tz).mo, zonedParts(at, tz).d + 1, 0, 0, tz).toISOString();
    if (this.isParent(person)) {
      if (!kids.length) return undefined;
      const waiting = this.marks(person, { status: 'waiting', limit: 8 });
      const due = this.chores(person).filter((c) => c.dueAt < endOfDay).slice(0, 8);
      return { role: 'parent', waiting, due, kids: kids.map((k) => ({ id: k.id, name: k.name, ...(({ balanceCents, points, waiting: w }) => ({ balanceCents, points, waiting: w }))(this.balance(person, k.id)) })) };
    }
    const mine = this.chores(person);
    if (!mine.length && !this.balance(person, person).earnedCents) return undefined;
    return { role: 'kid', waiting: this.marks(person, { status: 'waiting', limit: 8 }), due: mine.filter((c) => c.dueAt < endOfDay).slice(0, 8), kids: [], balance: this.balance(person, person) };
  }

  // ---------------------------------------------------------------- grocery (over a shared list)
  isGrocery(boardId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM grocery_lists WHERE board_id = ?').get(boardId));
  }
  groceryIds(): string[] {
    return (this.db.prepare('SELECT board_id FROM grocery_lists ORDER BY created_at').all() as { board_id: string }[]).map((r) => r.board_id);
  }
  markGrocery(boardId: string, by: string): void {
    this.db.prepare('INSERT OR IGNORE INTO grocery_lists (board_id, created_by, created_at) VALUES (?, ?, ?)').run(boardId, by, this.#iso());
  }
  itemMeta(ref: string): { aisle: string | null; store: string | null; price: string | null; checkedAt: string | null } {
    const r = this.db.prepare('SELECT category, store, price, checked_at FROM grocery_items WHERE ref = ?').get(ref) as Row | undefined;
    return { aisle: (r?.category as string | null) ?? null, store: (r?.store as string | null) ?? null, price: (r?.price as string | null) ?? null, checkedAt: (r?.checked_at as string | null) ?? null };
  }
  setItemMeta(boardId: string, ref: string, patch: { aisle?: unknown; store?: unknown; price?: string | null; checkedAt?: string | null }): void {
    const cur = this.itemMeta(ref);
    const aisle = patch.aisle === undefined ? cur.aisle : patch.aisle === null || patch.aisle === '' ? null : [...AISLES.map((a) => a.id), 'other'].includes(String(patch.aisle)) ? String(patch.aisle) : cur.aisle;
    const store = patch.store === undefined ? cur.store : clip(patch.store, 40) || null;
    this.db.prepare('INSERT INTO grocery_items (ref, board_id, category, store, price, checked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET category = excluded.category, store = excluded.store, price = excluded.price, checked_at = excluded.checked_at').run(ref, boardId, aisle, store, patch.price === undefined ? cur.price : patch.price, patch.checkedAt === undefined ? cur.checkedAt : patch.checkedAt);
  }
  /** A grocery list as the person sees it: items grouped by aisle in store order (only for its members). */
  groceryView(boards: SharedBoardStore, person: string, boardId: string): { id: string; name: string; members: number; aisles: { id: string; name: string; items: GroceryItem[] }[]; stores: string[]; open: number } | undefined {
    if (!this.isGrocery(boardId)) return undefined;
    const v = boards.view(person, boardId);
    if (!v) return undefined;
    const items: GroceryItem[] = v.cards.map((c) => {
      const m = this.itemMeta(c.ref);
      return { ref: c.ref, title: c.title, done: c.status === 'done', aisle: m.aisle ?? aisleOf(c.title), store: m.store, price: m.price, checkedAt: m.checkedAt, assignee: c.assignee };
    });
    const order = [...AISLES, OTHER_AISLE];
    const aisles = order.map((a) => ({ id: a.id, name: a.name, items: items.filter((i) => i.aisle === a.id).sort((x, y) => Number(x.done) - Number(y.done) || x.title.localeCompare(y.title)) })).filter((a) => a.items.length);
    return { id: boardId, name: v.board.name, members: v.board.members.filter((m) => m.status === 'member').length, aisles, stores: [...new Set(items.map((i) => i.store).filter((s): s is string => Boolean(s)))].sort(), open: items.filter((i) => !i.done).length };
  }
}

/** Reads find_product's text for the lowest price it confirmed ("1. Walmart — $3.48 — in stock …"). */
export function cheapestLine(out: string): { store: string; price: string } | undefined {
  let best: { store: string; price: string; n: number } | undefined;
  for (const m of out.matchAll(/^\d+\.\s+([^\u2014\n]+?)\s+\u2014\s+\$(\d[\d,]*(?:\.\d{2})?)/gm)) {
    const n = Number(m[2]!.replace(/,/g, ''));
    if (Number.isFinite(n) && (!best || n < best.n)) best = { store: m[1]!.trim(), price: `$${n.toFixed(2)}`, n };
  }
  return best ? { store: best.store, price: best.price } : undefined;
}

// ------------------------------------------------------------------------------------------------
// What a space gets (main.ts builds one per space; tests build their own)
// ------------------------------------------------------------------------------------------------

export interface FamilyPerson {
  id: string;
  name: string;
  child?: ChildProfile;
}
export interface FamilyAccess {
  store: FamilyStore;
  /** Who this space is: 'owner' or a member id. */
  person: string;
  /** Everyone in the household (the owner first), with their kid-safe profile when they are a child. */
  people: () => FamilyPerson[];
  /** The shared lists (grocery lists are shared lists with aisles and stores). */
  boards?: SharedBoardStore;
  tz: () => string | undefined;
  /** The owner only: kid-safe member mode on, changed or off for a member. */
  setChild?: (id: string, child: unknown) => void;
  /** Tells the parents (their phones and the Family chat line); quiet hours apply there. */
  notifyParents?: (title: string, body: string) => void;
}
export const kidsOf = (f: FamilyAccess): FamilyPerson[] => f.people().filter((p) => p.child);

/**
 * A child's turn, before the model (src/chat.ts): the topic is noted for the parent's summary (never
 * the words), and an off-limits ask gets a kind refusal without the model. Crisis words are left to
 * the crisis help (never refused here). Returns the reply to give instead, or undefined.
 */
export function kidTurn(app: AppContext, text: string): string | undefined {
  const child = app.member?.child?.();
  if (!child || !app.member) return undefined;
  const f = app.family;
  const at = app.now();
  const tz = f?.tz();
  try {
    if (!detectCrisis(text) && kidOffLimits(text)) {
      f?.store.noteBlocked(app.member.id, at, tz);
      return trOwner(KID_OFF_REPLY, app.settings.get());
    }
    f?.store.noteTurn(app.member.id, text, at, tz);
  } catch (err) {
    console.warn(`family: noting a turn failed: ${(err as Error).message}`);
  }
  return undefined;
}

/** The reminder tick (src/reminders.ts): the parents' weekly summary, once, Sunday evening. */
export function familyTick(app: AppContext, now: Date): void {
  const f = app.family;
  if (!f || f.person !== 'owner' || app.companionId && app.companionId !== 'main') return;
  try {
    const text = f.store.weeklyDue(kidsOf(f), now, f.tz());
    if (text) f.notifyParents?.(en('This week in chores'), text);
  } catch (err) {
    console.warn(`family: weekly summary failed: ${(err as Error).message}`);
  }
}
