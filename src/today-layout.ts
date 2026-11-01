// Phase 111 (TD1): Today's layout preferences and the daily mail snapshot (docs/design/TODAY.md
// §2.1 B5, §5.3, §10.1). Both live in the companion's own database (a view preference of one
// companion: never in settings.json, never shared through OWNER_SETTINGS). The registry below is
// the server's copy of the tile list (ids, sections, allowed sizes); web/today.js has the same
// list with the renderers. Unknown ids are dropped on write, so tiles added later get their
// designed slot.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { localDate } from './memory-worker.ts';

export type TileSize = 'S' | 'M' | 'L';
export const SECTIONS = ['day', 'needs', 'her', 'work', 'more'] as const;
export type SectionId = (typeof SECTIONS)[number];

export interface TileDef {
  id: string;
  section: SectionId;
  sizes: TileSize[];
  size: TileSize;
  /** Hidden until the owner shows it (folded tiles, opt-in tiles). */
  hidden?: boolean;
  ownerOnly?: boolean;
}

/** The designed layout (§3.2): sections in order, tiles in order, default sizes at 1440. */
export const TILES: readonly TileDef[] = [
  { id: 'td-calendar', section: 'day', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-weather', section: 'day', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-dates', section: 'day', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-needs', section: 'needs', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-mail', section: 'needs', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-memories', section: 'her', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-otd', section: 'her', sizes: ['M', 'L'], size: 'L' },
  { id: 'td-plans', section: 'her', sizes: ['S', 'M'], size: 'S' },
  // Owner decision 2026-11-01: the Rooms tile (keep-up rooms' summaries), off until switched on.
  { id: 'td-rooms', section: 'her', sizes: ['S', 'M', 'L'], size: 'M', hidden: true, ownerOnly: true },
  { id: 'td-jobs', section: 'work', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-board', section: 'work', sizes: ['S', 'M'], size: 'S' },
  { id: 'td-projects', section: 'work', sizes: ['S', 'M'], size: 'S', ownerOnly: true },
  { id: 'td-usage', section: 'work', sizes: ['S', 'M'], size: 'S', ownerOnly: true },
  { id: 'td-home', section: 'more', sizes: ['M', 'L'], size: 'L', ownerOnly: true },
  { id: 'td-models', section: 'more', sizes: ['S', 'M'], size: 'S' },
  // Folded into Needs you / Your day (§4.1, §4.6): still registered, hidden by default.
  { id: 'td-hooks', section: 'more', sizes: ['S', 'M'], size: 'M', hidden: true, ownerOnly: true },
  { id: 'td-agenda', section: 'more', sizes: ['S', 'M'], size: 'M', hidden: true },
  { id: 'td-setup', section: 'more', sizes: ['S', 'M', 'L'], size: 'S', ownerOnly: true },
];
const TILE_BY_ID = new Map(TILES.map((t) => [t.id, t]));

export const PHONE_OPEN = ['left', 'all', 'now'] as const;
/**
 * Phase 112 (TD2): what can be collapsed on a phone or a tablet. The sections, plus the phone's own
 * single-tile groups (Weather and Mail have their own headings there, §7.1).
 */
export const COLLAPSIBLE = [...SECTIONS, 'weather', 'mail'] as const;
export const COMING_DAYS = [7, 14, 30] as const;

export interface TodayPrefs {
  sections: SectionId[];
  /** Tile order inside each section. */
  order: Partial<Record<SectionId, string[]>>;
  tiles: Record<string, { size?: TileSize; hidden?: boolean }>;
  collapsed: { phone: string[]; tablet: string[] };
  notToday: { day: string; keys: string[] };
  home: { entities: string[]; scenes: string[] };
  setupHidden: string[];
  /** Since you were away: hours (0 = off). */
  awayHours: number;
  /** Phase 112 (TD2, §15 Q4): a one-sentence summary in her voice (a small model call), off by default. */
  awayVoice: boolean;
  /** Phase 112 (TD2, §15 Q5): the away note may count the rooms she answered in (titles only), off by default. */
  awayRooms: boolean;
  needsMail: boolean;
  usageCost: boolean;
  comingDays: number;
  phoneOpen: (typeof PHONE_OPEN)[number];
  /** Owner decision 2026-11-01: the Rooms tile (off by default; `ids` empty = every keep-up room). */
  rooms: { on: boolean; ids: number[] };
  /** The old per-device keys (sara.today.home / sara.today.setup) were brought over once. */
  migrated: boolean;
}

export function defaultPrefs(): TodayPrefs {
  const order: TodayPrefs['order'] = {};
  for (const t of TILES) (order[t.section] ??= []).push(t.id);
  return {
    sections: [...SECTIONS],
    order,
    tiles: {},
    collapsed: { phone: [], tablet: [] },
    notToday: { day: '', keys: [] },
    home: { entities: [], scenes: [] },
    setupHidden: [],
    awayHours: 8,
    awayVoice: false,
    awayRooms: false,
    needsMail: true,
    usageCost: true,
    comingDays: 7,
    phoneOpen: 'left',
    rooms: { on: false, ids: [] },
    migrated: false,
  };
}

export class LayoutError extends Error {}

const str64 = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const strList = (v: unknown, max = 64): string[] => (Array.isArray(v) ? [...new Set(v.filter(str64))].slice(0, max) : []);

/**
 * Cleans prefs from the app (§10.1): known tile ids only, allowed sizes only (a size a tile
 * doesn't allow is an error, not a silent change), at most 64 entries per list, strings ≤ 64.
 */
export function normalizePrefs(raw: unknown, base: TodayPrefs = defaultPrefs()): TodayPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: TodayPrefs = structuredClone(base);
  if (r.sections !== undefined) {
    const s = strList(r.sections).filter((x): x is SectionId => (SECTIONS as readonly string[]).includes(x));
    out.sections = [...s, ...SECTIONS.filter((x) => !s.includes(x))];
  }
  if (r.order && typeof r.order === 'object') {
    for (const sec of SECTIONS) {
      const want = strList((r.order as Record<string, unknown>)[sec]).filter((id) => TILE_BY_ID.get(id)?.section === sec);
      const all = TILES.filter((t) => t.section === sec).map((t) => t.id);
      out.order[sec] = [...want, ...all.filter((id) => !want.includes(id))];
    }
  }
  if (r.tiles && typeof r.tiles === 'object') {
    const entries = Object.entries(r.tiles as Record<string, unknown>);
    if (entries.length > 64) throw new LayoutError('Too many tiles.');
    const tiles: TodayPrefs['tiles'] = {};
    for (const [id, v] of entries) {
      const def = TILE_BY_ID.get(id);
      if (!def || !v || typeof v !== 'object') continue; // unknown ids are dropped
      const o = v as Record<string, unknown>;
      const cur: { size?: TileSize; hidden?: boolean } = {};
      if (o.size !== undefined && o.size !== null) {
        if (!def.sizes.includes(o.size as TileSize)) throw new LayoutError(`That tile can't be size ${String(o.size).slice(0, 4)}.`);
        cur.size = o.size as TileSize;
      }
      if (typeof o.hidden === 'boolean') cur.hidden = o.hidden;
      tiles[id] = cur;
    }
    out.tiles = tiles;
  }
  if (r.collapsed && typeof r.collapsed === 'object') {
    const c = r.collapsed as Record<string, unknown>;
    const ok = (x: string) => (COLLAPSIBLE as readonly string[]).includes(x);
    out.collapsed = { phone: c.phone === undefined ? out.collapsed.phone : strList(c.phone).filter(ok), tablet: c.tablet === undefined ? out.collapsed.tablet : strList(c.tablet).filter(ok) };
  }
  if (r.notToday && typeof r.notToday === 'object') {
    const n = r.notToday as Record<string, unknown>;
    out.notToday = { day: typeof n.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.day) ? n.day : '', keys: strList(n.keys) };
  }
  if (r.home && typeof r.home === 'object') {
    const h = r.home as Record<string, unknown>;
    const ent = (x: string) => /^[a-z_]{1,40}\.[\w-]{1,80}$/.test(x) || x.length <= 64;
    out.home = { entities: strList(h.entities, 6).filter(ent), scenes: strList(h.scenes, 4).filter((x) => x.startsWith('scene.')) };
  }
  if (r.setupHidden !== undefined) out.setupHidden = strList(r.setupHidden, 16);
  if (r.awayHours !== undefined) {
    const n = Number(r.awayHours);
    if (!Number.isFinite(n)) throw new LayoutError('Away hours must be a number.');
    out.awayHours = n <= 0 ? 0 : Math.min(24, Math.max(4, Math.round(n)));
  }
  if (typeof r.awayVoice === 'boolean') out.awayVoice = r.awayVoice;
  if (typeof r.awayRooms === 'boolean') out.awayRooms = r.awayRooms;
  if (typeof r.needsMail === 'boolean') out.needsMail = r.needsMail;
  if (typeof r.usageCost === 'boolean') out.usageCost = r.usageCost;
  if (r.comingDays !== undefined) {
    if (!(COMING_DAYS as readonly number[]).includes(Number(r.comingDays))) throw new LayoutError('Coming up looks 7, 14 or 30 days ahead.');
    out.comingDays = Number(r.comingDays);
  }
  if (r.phoneOpen !== undefined) {
    if (!(PHONE_OPEN as readonly string[]).includes(String(r.phoneOpen))) throw new LayoutError('Pick how Today opens on a phone.');
    out.phoneOpen = r.phoneOpen as TodayPrefs['phoneOpen'];
  }
  if (r.rooms && typeof r.rooms === 'object') {
    const ro = r.rooms as Record<string, unknown>;
    out.rooms = { on: ro.on === true, ids: Array.isArray(ro.ids) ? [...new Set(ro.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 64) : [] };
  }
  if (typeof r.migrated === 'boolean') out.migrated = r.migrated || base.migrated;
  return out;
}

// ---------- the tables ----------

const ready = new WeakSet<DatabaseSync>();
function db(app: AppContext): DatabaseSync {
  const d = app.store.db;
  if (!ready.has(d)) {
    d.exec(`CREATE TABLE IF NOT EXISTS today_layout (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      prefs TEXT NOT NULL,
      seen_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_daily (
      day TEXT NOT NULL,
      email TEXT NOT NULL,
      first_total INTEGER NOT NULL, first_unread INTEGER NOT NULL, first_at TEXT NOT NULL,
      last_total INTEGER NOT NULL, last_unread INTEGER NOT NULL, last_at TEXT NOT NULL,
      PRIMARY KEY (day, email)
    );`);
    ready.add(d);
  }
  return d;
}

/** This companion's prefs (the designed layout when nothing is saved), and when Today was last seen. */
export function getLayout(app: AppContext): { prefs: TodayPrefs; seenAt: string | null; saved: boolean } {
  const row = db(app).prepare('SELECT prefs, seen_at FROM today_layout WHERE id = 1').get() as { prefs: string; seen_at: string | null } | undefined;
  let prefs = defaultPrefs();
  if (row) {
    try {
      prefs = normalizePrefs(JSON.parse(row.prefs));
    } catch {
      /* a damaged row: the designed layout */
    }
  }
  // "Not today" keys last until local midnight.
  const day = localDate(app.now().toISOString(), app.settings.get().timeZone);
  if (prefs.notToday.day !== day) prefs.notToday = { day, keys: [] };
  return { prefs, seenAt: row?.seen_at ?? null, saved: Boolean(row) };
}

function write(app: AppContext, prefs: TodayPrefs, seenAt?: string | null): void {
  const now = app.now().toISOString();
  const cur = db(app).prepare('SELECT seen_at FROM today_layout WHERE id = 1').get() as { seen_at: string | null } | undefined;
  db(app)
    .prepare('INSERT INTO today_layout (id, prefs, seen_at, version, updated_at) VALUES (1, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET prefs = excluded.prefs, seen_at = excluded.seen_at, updated_at = excluded.updated_at')
    .run(JSON.stringify(prefs), seenAt === undefined ? (cur?.seen_at ?? null) : seenAt, now);
}

/** PUT /api/today/layout: a patch over what is saved; answers the normalised prefs. */
export function putLayout(app: AppContext, patch: unknown): TodayPrefs {
  const prefs = normalizePrefs(patch, getLayout(app).prefs);
  write(app, prefs);
  return prefs;
}

/** DELETE /api/today/layout: the designed layout again (the away time and Not today keys stay). */
export function resetLayout(app: AppContext): TodayPrefs {
  const cur = getLayout(app).prefs;
  // The phone's and tablet's open/closed sections are not part of the designed layout: they stay.
  const prefs = { ...defaultPrefs(), notToday: cur.notToday, migrated: cur.migrated, rooms: { on: false, ids: [] }, collapsed: cur.collapsed };
  write(app, prefs);
  return prefs;
}

/** PUT /api/today/seen (Since you were away). */
export function setSeen(app: AppContext, at = app.now().toISOString()): void {
  write(app, getLayout(app).prefs, at);
}

/** POST /api/today/needs/:key/not-today. */
export function addNotToday(app: AppContext, key: string): TodayPrefs {
  if (!str64(key)) throw new LayoutError('That item has no key.');
  const { prefs } = getLayout(app);
  if (!prefs.notToday.keys.includes(key)) prefs.notToday.keys = [...prefs.notToday.keys, key].slice(-64);
  write(app, prefs);
  return prefs;
}

// ---------- the daily mail snapshot (§5.3) ----------

/** Keeps the first and the latest reading of each local day (30 days); returns the change since yesterday's first. */
export function recordMail(app: AppContext, email: string, total: number, unread: number): { total: number; unread: number } | undefined {
  const d = db(app);
  const now = app.now();
  const tz = app.settings.get().timeZone;
  const day = localDate(now.toISOString(), tz);
  const at = now.toISOString();
  d.prepare(
    `INSERT INTO mail_daily (day, email, first_total, first_unread, first_at, last_total, last_unread, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, email) DO UPDATE SET last_total = excluded.last_total, last_unread = excluded.last_unread, last_at = excluded.last_at`,
  ).run(day, email, total, unread, at, total, unread, at);
  const cutoff = localDate(new Date(now.getTime() - 30 * 86_400_000).toISOString(), tz);
  d.prepare('DELETE FROM mail_daily WHERE day < ?').run(cutoff);
  const yesterday = localDate(new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString(), 'UTC');
  const y = d.prepare('SELECT first_total, first_unread FROM mail_daily WHERE day = ? AND email = ?').get(yesterday, email) as { first_total: number; first_unread: number } | undefined;
  return y ? { total: total - y.first_total, unread: unread - y.first_unread } : undefined;
}

export const tileDef = (id: string): TileDef | undefined => TILE_BY_ID.get(id);
