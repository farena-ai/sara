// Phase 108 (CH2, docs/design/CHATS.md §5 and B3): channel projects and room identity.
//
// Every chat service she is reached on (Telegram, Discord, each plugin bridge such as WhatsApp or
// Signal) gets one built-in planner project that holds that channel's sessions, so the owner's own
// projects stay his. Web, desktop and phone app chats (all `web`), the API, MCP, Home Assistant,
// Alexa, A2A, webhooks, group chats and imports are never filed here.
//
// - `channelProjectFor(channel)` is the one table (§5.2): a new bridge adds one row.
// - `channelProjectId(app, channel)` is what a bridge passes as `projectId` for a chat's first
//   session (later sessions follow the previous one's project, so the owner's own filing sticks).
// - `fileChannelChats(app)` is the one-time filing of the bridge chats from before 2.41.0, kept in
//   `memory_kv` (`chats:filed`) for one Undo per project (`unfileChannelChats`).
// - B3 room identity: one `rooms` row per place she talks with others, with its real name
//   (Telegram `chat.title`, Discord `#channel · Server`). CH2 uses it for row chips and session
//   titles; CH4 hangs keep-up, the room log and room memory on the same row (schema of §7.3).
import type { AppContext } from '../chat.ts';
import type { PlannerStore, Project } from '../planner.ts';
import type { Conversation } from '../store.ts';

export type ChannelKind = 'telegram' | 'discord' | 'plugin';
export interface ChannelProject {
  /** `projects.builtin`: 'channel:telegram', 'channel:discord', 'channel:plugin-signal'. */
  builtin: string;
  /** The project's name when it is created (the owner may rename it). */
  name: string;
  kind: ChannelKind;
  /** `rooms.bridge`: 'telegram' | 'discord' | 'plugin-<name>'. */
  bridge: string;
}

/** Display names of the chat services plugins are expected to bring (§5.2); others use the plugin's name. */
const PLUGIN_NAMES: Readonly<Record<string, string>> = { whatsapp: 'WhatsApp', signal: 'Signal', line: 'LINE', imessage: 'iMessage', matrix: 'Matrix', slack: 'Slack', messenger: 'Messenger', sms: 'SMS', teams: 'Teams', wechat: 'WeChat', viber: 'Viber', threema: 'Threema', irc: 'IRC', xmpp: 'XMPP' };
const titleCase = (s: string) => s.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** §5.2: the channel project a channel's sessions belong to (undefined = not a bridge: they stay where the owner puts them). */
export function channelProjectFor(channel: string, label?: string): ChannelProject | undefined {
  const m = /^(telegram|discord)(-work)?(-nsfw)?$/.exec(channel);
  if (m) {
    const kind = m[1] as 'telegram' | 'discord';
    return { builtin: `channel:${kind}`, name: kind === 'telegram' ? 'Telegram' : 'Discord', kind, bridge: kind };
  }
  const p = /^plugin-([a-z0-9][a-z0-9-]{0,40})$/.exec(channel);
  if (p) return { builtin: `channel:plugin-${p[1]}`, name: PLUGIN_NAMES[p[1]] ?? (label?.trim().slice(0, 60) || titleCase(p[1])), kind: 'plugin', bridge: `plugin-${p[1]}` };
  return undefined;
}

/** The builtin key back to its channel (for the project page and the delete rule). */
export function channelOfBuiltin(builtin: string | null | undefined): { kind: ChannelKind; bridge: string } | undefined {
  if (!builtin?.startsWith('channel:')) return undefined;
  const bridge = builtin.slice(8);
  if (bridge === 'telegram' || bridge === 'discord') return { kind: bridge, bridge };
  return bridge.startsWith('plugin-') ? { kind: 'plugin', bridge } : undefined;
}

/** The channel's project, created on first use ("Telegram", or "Telegram chats" when he has a "Telegram" of his own). */
export function ensureChannelProject(planner: PlannerStore, channel: string, label?: string): Project | undefined {
  const cp = channelProjectFor(channel, label);
  if (!cp) return undefined;
  const have = planner.builtinProject(cp.builtin);
  if (have) {
    // A builtin can't be archived (§5.3); one archived by an older version comes back.
    if (have.status === 'archived') return planner.updateProject(have.id, { status: 'active' });
    return have;
  }
  return planner.createBuiltinProject(cp.builtin, cp.name);
}

/** The plugin's own name for a bridge it provides (for the project's first name). */
const pluginLabel = (app: AppContext, channel: string): string | undefined => (channel.startsWith('plugin-') ? app.pluginManager?.bridgeLabel(channel.slice(7)) : undefined);

/** What a bridge passes as `projectId` for a chat's first session (null when there is no planner). */
export function channelProjectId(app: AppContext, channel: string, label?: string): number | null {
  if (!app.planner) return null;
  try {
    return ensureChannelProject(app.planner, channel, label ?? pluginLabel(app, channel))?.id ?? null;
  } catch (err) {
    console.warn(`channel project for ${channel}: ${(err as Error).message}`);
    return null;
  }
}

/** Whether the channel behind a builtin project is switched on (then the project can't be deleted). */
export function channelOn(app: AppContext, builtin: string | null | undefined): boolean {
  const ch = channelOfBuiltin(builtin);
  if (!ch) return false;
  const s = app.settings.get() as { telegram?: { enabled?: boolean }; discord?: { enabled?: boolean } };
  if (ch.kind === 'telegram') return s.telegram?.enabled === true;
  if (ch.kind === 'discord') return s.discord?.enabled === true;
  return app.pluginManager?.bridgeOn(app, ch.bridge.slice(7)) === true;
}

/** The channel's own name for messages ("Telegram", "Discord", "WhatsApp"), whatever the project is called now. */
export function channelName(app: AppContext, builtin: string | null | undefined): string {
  const ch = channelOfBuiltin(builtin);
  if (!ch) return '';
  return channelProjectFor(ch.bridge, pluginLabel(app, ch.bridge))?.name ?? ch.bridge;
}

// ---------------------------------------------------------------------------------------------
// The one-time filing (§5.3 "Backfill once") and its Undo
// ---------------------------------------------------------------------------------------------

export const FILED_KEY = 'chats:filed';
interface FiledRecord {
  at: string;
  /** Each conversation moved, and the project it went to. Undo takes them out again (per project). */
  moved: { id: string; projectId: number }[];
}

function kv(app: AppContext): { get: (k: string) => string | undefined; set: (k: string, v: string) => void } {
  const db = app.store.db;
  db.exec('CREATE TABLE IF NOT EXISTS memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    get: (k) => (db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(k) as { value: string } | undefined)?.value,
    set: (k, v) => void db.prepare('INSERT INTO memory_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v),
  };
}

function filedRecord(app: AppContext): FiledRecord | undefined {
  const raw = kv(app).get(FILED_KEY);
  if (!raw) return undefined;
  try {
    const r = JSON.parse(raw) as FiledRecord;
    return Array.isArray(r.moved) ? r : { at: String(r.at ?? ''), moved: [] };
  } catch {
    return { at: '', moved: [] };
  }
}

/**
 * Files the bridge chats from before 2.41.0 into their channel projects, once. Only chats with no
 * project move (those he filed himself stay where he put them); web, API, MCP, Home Assistant,
 * Alexa, A2A, webhook, group and imported conversations never move. Runs at startup of the
 * owner's main companion; afterwards it does nothing.
 */
export function fileChannelChats(app: AppContext): { moved: number; already: boolean } {
  if (!app.planner) return { moved: 0, already: false };
  const store = kv(app);
  if (store.get(FILED_KEY)) return { moved: 0, already: true };
  const moved: FiledRecord['moved'] = [];
  const byProject = new Map<number, string[]>();
  const loose = app.store.db.prepare("SELECT id, channel FROM conversations WHERE project_id IS NULL AND (channel LIKE 'telegram%' OR channel LIKE 'discord%' OR channel LIKE 'plugin-%')").all() as { id: string; channel: string }[];
  for (const c of loose) {
    if (!channelProjectFor(c.channel)) continue;
    const pid = channelProjectId(app, c.channel);
    if (pid === null) continue;
    byProject.set(pid, [...(byProject.get(pid) ?? []), c.id]);
    moved.push({ id: c.id, projectId: pid });
  }
  for (const [pid, ids] of byProject) app.store.setProject(ids, pid);
  store.set(FILED_KEY, JSON.stringify({ at: app.now().toISOString(), moved } satisfies FiledRecord));
  if (moved.length) console.log(`chats: filed ${moved.length} Telegram/Discord/plugin chat${moved.length === 1 ? '' : 's'} into their channel projects (Undo: the project's page).`);
  return { moved: moved.length, already: false };
}

/** How many conversations the one-time filing put in this project that are still there (Undo offers them). */
export function filedCount(app: AppContext, projectId: number): number {
  const r = filedRecord(app);
  if (!r) return 0;
  const ids = r.moved.filter((m) => m.projectId === projectId).map((m) => m.id);
  return ids.filter((id) => app.store.getConversation(id)?.projectId === projectId).length;
}

/** Undo of the filing for one project: exactly the moved conversations still in it go back to "No project". */
export function unfileChannelChats(app: AppContext, projectId: number): number {
  const r = filedRecord(app);
  if (!r) return 0;
  const mine = r.moved.filter((m) => m.projectId === projectId);
  const back = mine.map((m) => m.id).filter((id) => app.store.getConversation(id)?.projectId === projectId);
  const n = app.store.setProject(back, null);
  // Undo happens once: the record forgets this project's moves.
  kv(app).set(FILED_KEY, JSON.stringify({ ...r, moved: r.moved.filter((m) => m.projectId !== projectId) } satisfies FiledRecord));
  return n;
}

// ---------------------------------------------------------------------------------------------
// B3: room identity
// ---------------------------------------------------------------------------------------------

export interface Room {
  id: number;
  bridge: string;
  key: string;
  kind: 'dm' | 'room';
  /** DMs: the person's name; Telegram groups: the group's title; Discord: the channel name (no #). */
  title: string;
  /** Discord: the server's name. */
  parentTitle: string | null;
  adult: boolean;
  checkedAt: string | null;
}

/** The B3 table, with the columns CH4 uses already in place (§7.3), so CH4 needs no ALTER of its own. */
function roomsTable(app: AppContext): void {
  app.store.db.exec(`CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bridge TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL, parent_title TEXT,
  adult INTEGER NOT NULL DEFAULT 0,
  keep_up INTEGER NOT NULL DEFAULT 0, keep_up_since TEXT, paused_reason TEXT,
  summary_every INTEGER NOT NULL DEFAULT 40, summary_minutes INTEGER NOT NULL DEFAULT 20,
  daily_tokens INTEGER NOT NULL DEFAULT 20000,
  her_last_line_id INTEGER, her_last_topic TEXT,
  sees_all TEXT,
  checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (bridge, key)
)`);
}

type Row = Record<string, string | number | null>;
const toRoom = (r: Row): Room => ({ id: Number(r.id), bridge: String(r.bridge), key: String(r.key), kind: r.kind === 'dm' ? 'dm' : 'room', title: String(r.title), parentTitle: (r.parent_title as string | null) ?? null, adult: Number(r.adult) === 1, checkedAt: (r.checked_at as string | null) ?? null });

const ready = new WeakSet<object>();
export function rooms(app: AppContext): AppContext["store"]["db"] {
  if (!ready.has(app.store.db)) {
    roomsTable(app);
    ready.add(app.store.db);
  }
  return app.store.db;
}

export function roomOf(app: AppContext, bridge: string, key: string): Room | undefined {
  const r = rooms(app).prepare('SELECT * FROM rooms WHERE bridge = ? AND key = ?').get(bridge, key) as Row | undefined;
  return r ? toRoom(r) : undefined;
}

/** Every room, by `bridge:key` (the conversation list adds each session's chip from it). */
export function roomsByKey(app: AppContext): Map<string, Room> {
  return new Map((rooms(app).prepare('SELECT * FROM rooms').all() as Row[]).map((r) => [`${r.bridge}:${r.key}`, toRoom(r)]));
}

/** A room's name is refreshed at most once a day (§3.1 B3). */
export const roomStale = (room: Room | undefined, now: Date): boolean => !room?.checkedAt || now.getTime() - Date.parse(room.checkedAt) > 24 * 3600_000;

/** Records (or updates) a room's name. Writes only when something changed or the name is a day old. */
export function noteRoom(app: AppContext, r: { bridge: string; key: string; kind: 'dm' | 'room'; title: string; parentTitle?: string | null; adult?: boolean }): Room {
  const title = r.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || r.key;
  const parent = r.parentTitle?.replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || null;
  const cur = roomOf(app, r.bridge, r.key);
  const now = app.now();
  if (cur && cur.title === title && cur.parentTitle === parent && cur.kind === r.kind && cur.adult === Boolean(r.adult) && !roomStale(cur, now)) return cur;
  const ts = now.toISOString();
  rooms(app)
    .prepare('INSERT INTO rooms (bridge, key, kind, title, parent_title, adult, checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bridge, key) DO UPDATE SET kind = excluded.kind, title = excluded.title, parent_title = excluded.parent_title, adult = excluded.adult, checked_at = excluded.checked_at, updated_at = excluded.updated_at')
    .run(r.bridge, r.key, r.kind, title, parent, r.adult ? 1 : 0, ts, ts, ts);
  return roomOf(app, r.bridge, r.key)!;
}

/** The room a conversation happens in (undefined for web and other non-bridge chats). */
export function roomOfConversation(app: AppContext, c: Pick<Conversation, 'channel' | 'channelKey'>, all?: Map<string, Room>): Room | undefined {
  const cp = channelProjectFor(c.channel);
  if (!cp || !c.channelKey) return undefined;
  return all ? all.get(`${cp.bridge}:${c.channelKey}`) : roomOf(app, cp.bridge, c.channelKey);
}

/** The row chip (§5.4): `{kind:'dm'}` → "DM"; a Telegram group → "Book club (group)"; Discord → "#general · My Server". */
export function roomChip(room: Room | undefined): { kind: 'dm' | 'group' | 'channel'; title: string; parent: string | null } | undefined {
  if (!room) return undefined;
  if (room.kind === 'dm') return { kind: 'dm', title: room.title, parent: null };
  if (room.bridge === 'discord') return { kind: 'channel', title: room.title, parent: room.parentTitle };
  return { kind: 'group', title: room.title, parent: room.parentTitle };
}

/** A Discord room's display name: "#general · My Server" (the session titles use it). */
export const discordRoomName = (room: Room | undefined): string | undefined => (room && room.kind === 'room' && room.title ? `#${room.title}${room.parentTitle ? ` · ${room.parentTitle}` : ''}` : undefined);
