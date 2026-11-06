// E4 (docs/ops/E4_DESIGN.md): bounded environment alerts. The owner picks a plain file inside one of
// his workspaces (or Sara's own SARA_LOG_FILE), a few literal words, and how often. On the reminder
// scheduler's existing 15-second tick (src/reminders.ts, no timer here) a due watch reads only the
// new bytes (at most READ_CAP), matches with includes() and, for a new line, posts one in-chat card
// and one notification. A check is a plain read: no model, no tool, no command, no "fix".
//
// Every check re-proves the path: lstat each part (no links), not a secret, a plain file, opened
// no-follow, fstat = lstat (no swap). Rotation (new file) or truncation restarts at 0 with one note;
// the first enable starts at the end. Lines are cut at 4 KB; what is kept or sent is 300 characters
// through the vault-secret scrub. Repeats inside 6 h count up (normalizeMessage); pings are at most
// one per watch per 10 minutes and 12 a day, quiet hours fold them into one later ping. Alerts are
// kept 14 days / 200 per watch. Watches end after 30 days unless renewed and come back paused after
// a restart. A watch may also send its ping to the owner's own linked Telegram or Discord chat
// ("Also send to", off unless he turns it on per watch; never a chat id, group or room), as part of
// the same ping, so every limit above is shared. Matched lines are app notices, which the model never reads (src/chat.ts history), so a
// line reaches a model only when the owner asks about that alert (ask()).
//
// Tables (additive, the companion's own store.db): env_watches, env_alerts, env_watch_pings.
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { quietNow } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { normalizeMessage } from './triggers.ts';
import { inside, isSecretPath, WORKSPACE_NAME_RE } from './tools/workspace.ts';

export const WATCH = {
  maxActive: 5,
  maxTotal: 10,
  maxPatterns: 5,
  patternMin: 2,
  patternMax: 80,
  readCap: 256 * 1024,
  lineCap: 4096,
  keepChars: 300,
  everyMinFloor: 5,
  everyMinDefault: 15,
  everyMinMax: 24 * 60,
  checkNowMs: 10_000,
  pingGapMs: 10 * 60_000,
  pingsPerDay: 12,
  dedupeMs: 6 * 3600_000,
  keepDays: 14,
  keepRows: 200,
  lifeDays: 30,
  missesToPause: 3,
} as const;

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const DAY_MS = 24 * 3600_000;

export class WatchError extends Error {
  readonly status: number;
  readonly params?: Record<string, unknown>;
  constructor(status: number, message: string, params?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (params) this.params = params;
  }
}

export type WatchState = 'active' | 'paused' | 'stopped';
export interface Watch {
  id: number;
  path: string;
  file: string;
  rootKind: 'workspace' | 'log';
  workspace: string | null;
  rel: string;
  patterns: string[];
  caseIns: boolean;
  everyMin: number;
  state: WatchState;
  reason: string | null;
  conversationId: string | null;
  /** Also send each ping to these bridges (the owner's own linked chat on each). Empty by default. */
  alsoTo: WatchBridge[];
  lastCheckAt: string | null;
  lastMatchAt: string | null;
  lastError: string | null;
  endsAt: string;
  createdAt: string;
}
export interface WatchAlert {
  id: number;
  watchId: number;
  pattern: string;
  line: string;
  firstAt: string;
  lastAt: string;
  count: number;
  notified: boolean;
}
export interface CheckResult {
  ok: boolean;
  matched: string[];
  error?: string;
  note?: 'rotated' | 'skipped';
  skippedKb?: number;
}

interface Row {
  id: number;
  path_abs: string;
  root_kind: 'workspace' | 'log';
  root_dir: string;
  workspace: string | null;
  patterns_json: string;
  case_ins: number;
  every_min: number;
  state: WatchState;
  reason: string | null;
  dev: string | null;
  ino: string | null;
  offset: number;
  misses: number;
  conversation_id: string | null;
  also_to: string;
  last_check_at: string | null;
  last_match_at: string | null;
  last_ping_at: string | null;
  last_error: string | null;
  ends_at: string;
  created_at: string;
  updated_at: string;
}

/** A refusal reason for the path checks (shown in the app as words; never a host detail). */
class PathRefused extends Error {}

function ensureTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path_abs TEXT NOT NULL, root_kind TEXT NOT NULL, root_dir TEXT NOT NULL,
      workspace TEXT, patterns_json TEXT NOT NULL, case_ins INTEGER NOT NULL DEFAULT 0, every_min INTEGER NOT NULL,
      state TEXT NOT NULL, reason TEXT, dev TEXT, ino TEXT, offset INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT, last_check_at TEXT, last_match_at TEXT, last_ping_at TEXT, last_error TEXT,
      ends_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS env_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id INTEGER NOT NULL, key TEXT NOT NULL, pattern TEXT NOT NULL,
      line_capped TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
      notified INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS env_alerts_watch ON env_alerts(watch_id, key);
    CREATE TABLE IF NOT EXISTS env_watch_pings (id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id INTEGER NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL);
  `);
  // E4 follow-up: the per-watch "Also send to" bridges (JSON list; empty = web push and the card only).
  const cols = (db.prepare('PRAGMA table_info(env_watches)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('also_to')) db.exec("ALTER TABLE env_watches ADD COLUMN also_to TEXT NOT NULL DEFAULT '[]'");
}

/** Bridges a watch may also ping: the owner's own linked chat on each, nothing else. */
export const WATCH_BRIDGES = ['telegram', 'discord'] as const;
export type WatchBridge = (typeof WATCH_BRIDGES)[number];

/** Sara's own log, when SARA_LOG_FILE is set (read live, so a changed setting is honoured). */
function saraLog(): string | undefined {
  const f = process.env.SARA_LOG_FILE?.trim();
  return f ? resolve(f) : undefined;
}

/**
 * Opens `abs` for reading after proving it is a plain, non-secret file inside `rootDir` reached
 * without any link. Throws PathRefused with a reason code.
 */
function openChecked(rootDir: string, abs: string, rootKind: 'workspace' | 'log'): { fd: number; st: BigIntStats } {
  const rel = relative(rootDir, abs);
  if (!rel || !inside(rootDir, abs)) throw new PathRefused('outside');
  if (rootKind === 'log' ? abs !== saraLog() || isSecretPath(basename(abs)) : isSecretPath(rel)) throw new PathRefused(rootKind === 'log' && abs !== saraLog() ? 'outside' : 'secret');
  let cur = rootDir;
  let pre: BigIntStats | undefined;
  try {
    if (lstatSync(rootDir).isSymbolicLink()) throw new PathRefused('link');
    for (const part of rel.split(sep)) {
      cur = join(cur, part);
      pre = lstatSync(cur, { bigint: true });
      if (pre.isSymbolicLink()) throw new PathRefused('link');
    }
  } catch (e) {
    if (e instanceof PathRefused) throw e;
    throw new PathRefused('missing');
  }
  if (!pre || !pre.isFile()) throw new PathRefused('not-file');
  let fd: number;
  try {
    if (!inside(realpathSync.native(rootDir), realpathSync.native(abs))) throw new PathRefused('link');
    fd = openSync(abs, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (e instanceof PathRefused) throw e;
    throw new PathRefused('missing');
  }
  const st = fstatSync(fd, { bigint: true });
  if (!st.isFile() || st.ino !== pre.ino || st.dev !== pre.dev) {
    closeSync(fd);
    throw new PathRefused('swapped');
  }
  return { fd, st };
}

function readAt(fd: number, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, start + off);
    if (n <= 0) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}

const toLines = (buf: Buffer, dropFirst: boolean): string[] => {
  const lines = buf.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '').slice(0, WATCH.lineCap));
  if (dropFirst) lines.shift();
  return lines.filter((l) => l.length);
};

function cleanPatterns(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map((p) => (typeof p === 'string' ? p.trim() : '')) : [];
  const uniq = [...new Set(list)];
  if (!uniq.length || uniq.length > WATCH.maxPatterns || uniq.some((p) => p.length < WATCH.patternMin || p.length > WATCH.patternMax || /[\r\n]/.test(p))) {
    throw new WatchError(400, en('Add 1 to 5 words to look for, each 2 to 80 characters.'));
  }
  return uniq;
}

function cleanEvery(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return WATCH.everyMinDefault;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < WATCH.everyMinFloor || n > WATCH.everyMinMax) throw new WatchError(400, en('How often: every 5 minutes to every 24 hours.'));
  return n;
}

const REFUSED: Record<string, string> = {
  outside: en('Pick a file inside one of your workspaces, or Sara’s own log.'),
  secret: en('That file can’t be watched: it holds keys or Sara’s own data.'),
  link: en('That isn’t a plain file (a folder, a link or a device).'),
  'not-file': en('That isn’t a plain file (a folder, a link or a device).'),
  swapped: en('That isn’t a plain file (a folder, a link or a device).'),
  missing: en('That file doesn’t exist.'),
};

export class Watches {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #checkNowAt = new Map<number, number>();
  #sweptAt = 0;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    ensureTables(db);
    // After a restart nothing runs by itself: the owner turns each watch back on.
    db.prepare("UPDATE env_watches SET state = 'paused', reason = 'restart' WHERE state = 'active'").run();
  }

  #now(): Date {
    return this.#app.now();
  }

  #row(id: number): Row | undefined {
    return this.#db.prepare('SELECT * FROM env_watches WHERE id = ?').get(id) as Row | undefined;
  }

  #view(r: Row): Watch {
    return {
      id: r.id,
      path: r.path_abs,
      file: basename(r.path_abs),
      rootKind: r.root_kind,
      workspace: r.workspace,
      rel: r.root_kind === 'log' ? basename(r.path_abs) : relative(r.root_dir, r.path_abs).split(sep).join('/'),
      patterns: JSON.parse(r.patterns_json) as string[],
      caseIns: Boolean(r.case_ins),
      everyMin: r.every_min,
      state: r.state,
      reason: r.reason,
      conversationId: r.conversation_id,
      alsoTo: JSON.parse(r.also_to || '[]') as WatchBridge[],
      lastCheckAt: r.last_check_at,
      lastMatchAt: r.last_match_at,
      lastError: r.last_error,
      endsAt: r.ends_at,
      createdAt: r.created_at,
    };
  }

  #set(id: number, patch: Record<string, string | number | null>): void {
    const keys = Object.keys(patch);
    this.#db.prepare(`UPDATE env_watches SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), this.#now().toISOString(), id);
  }

  get(id: number): Watch | undefined {
    const r = this.#row(id);
    return r ? this.#view(r) : undefined;
  }

  list(): Watch[] {
    return (this.#db.prepare('SELECT * FROM env_watches ORDER BY id').all() as unknown as Row[]).map((r) => this.#view(r));
  }

  /** Which bridges are linked to the owner's own chat right now (the "Also send to" choices). */
  #linked(): Record<WatchBridge, boolean> {
    const b = this.#app.bridges;
    return { telegram: Boolean(b?.telegram?.ownerLinked()), discord: Boolean(b?.discord?.ownerLinked()) };
  }

  /** "Also send to": only the names of bridges linked to the owner's own chat (no ids, groups, rooms). */
  #alsoTo(raw: unknown): WatchBridge[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !(WATCH_BRIDGES as readonly string[]).includes(x))) throw new WatchError(400, en('Alerts can only also go to your own linked Telegram or Discord chat.'));
    const list = [...new Set(raw as WatchBridge[])];
    const linked = this.#linked();
    if (list.some((b) => !linked[b])) throw new WatchError(400, en('Link your Telegram or Discord first (Settings → Chat apps), then pick it here.'));
    return list;
  }

  /** The owner's own chats can get the card: web chats and his private bridge chats, never guests or rooms. */
  #ownChat(id: string): boolean {
    const c = this.#app.store.getConversation(id);
    return Boolean(c && !c.partner && ['web', 'telegram', 'discord'].includes(c.channel));
  }

  #cardChat(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string' || !this.#ownChat(raw)) throw new WatchError(400, en('Pick one of your own chats for the alert cards.'));
    return raw;
  }

  /** The owner's own chats the card can go to (most recent first, at most 30). */
  chats(): { id: string; title: string }[] {
    return this.#app.store.listConversations().filter((c) => this.#ownChat(c.id)).slice(0, 30).map((c) => ({ id: c.id, title: c.title }));
  }

  /** What the picker offers: the owner's workspaces, whether Sara's own log is set, the linked bridges. */
  roots(): { workspaces: string[]; log: boolean; bridges: Record<WatchBridge, boolean> } {
    const dir = join(this.#app.dataDir, 'workspaces');
    let names: string[] = [];
    try {
      names = existsSync(dir) ? readdirSync(dir).filter((n) => WORKSPACE_NAME_RE.test(n) && !isSecretPath(n) && lstatSync(join(dir, n)).isDirectory()).sort() : [];
    } catch {
      names = [];
    }
    const log = saraLog();
    return { workspaces: names, log: Boolean(log && existsSync(log)), bridges: this.#linked() };
  }

  #activeCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM env_watches WHERE state = 'active'").get() as { n: number }).n;
  }

  /** The owner's tap on Turn on (never a model tool). Starts at the end of the file. */
  create(body: { root?: unknown; workspace?: unknown; path?: unknown; patterns?: unknown; caseIns?: unknown; everyMin?: unknown; conversationId?: unknown; alsoTo?: unknown }): Watch {
    const patterns = cleanPatterns(body.patterns);
    const everyMin = cleanEvery(body.everyMin);
    const alsoTo = this.#alsoTo(body.alsoTo);
    const conv = this.#cardChat(body.conversationId);
    let rootDir: string;
    let abs: string;
    let workspace: string | null = null;
    const rootKind = body.root === 'log' ? 'log' : body.root === 'workspace' ? 'workspace' : null;
    if (rootKind === 'log') {
      const log = saraLog();
      if (!log) throw new WatchError(400, REFUSED.outside);
      rootDir = dirname(log);
      abs = log;
    } else if (rootKind === 'workspace') {
      const name = typeof body.workspace === 'string' ? body.workspace : '';
      const rel = typeof body.path === 'string' ? body.path.trim() : '';
      if (!WORKSPACE_NAME_RE.test(name) || !rel || isAbsolute(rel) || /^[\\/]/.test(rel)) throw new WatchError(400, REFUSED.outside);
      const ws = join(this.#app.dataDir, 'workspaces', name);
      try {
        const st = lstatSync(ws);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('no');
        rootDir = realpathSync.native(ws);
      } catch {
        throw new WatchError(400, REFUSED.outside);
      }
      abs = resolve(rootDir, rel);
      workspace = name;
    } else throw new WatchError(400, REFUSED.outside);
    let opened: { fd: number; st: BigIntStats };
    try {
      opened = openChecked(rootDir, abs, rootKind);
    } catch (e) {
      if (e instanceof PathRefused) throw new WatchError(400, REFUSED[e.message] ?? REFUSED.outside);
      throw e;
    }
    closeSync(opened.fd);
    const total = (this.#db.prepare('SELECT COUNT(*) AS n FROM env_watches').get() as { n: number }).n;
    if (total >= WATCH.maxTotal) throw new WatchError(409, en('You have {n} watches. Delete one first.'), { n: WATCH.maxTotal });
    if (this.#activeCount() >= WATCH.maxActive) throw new WatchError(409, en('{n} watches are already on. Pause one first.'), { n: WATCH.maxActive });
    const now = this.#now();
    const iso = now.toISOString();
    const r = this.#db
      .prepare('INSERT INTO env_watches (path_abs, root_kind, root_dir, workspace, patterns_json, case_ins, every_min, state, dev, ino, offset, conversation_id, also_to, last_check_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(abs, rootKind, rootDir, workspace, JSON.stringify(patterns), body.caseIns ? 1 : 0, everyMin, 'active', String(opened.st.dev), String(opened.st.ino), Number(opened.st.size), conv, JSON.stringify(alsoTo), iso, new Date(now.getTime() + WATCH.lifeDays * DAY_MS).toISOString(), iso, iso);
    return this.get(Number(r.lastInsertRowid))!;
  }

  #must(id: number): Row {
    const r = this.#row(id);
    if (!r) throw new WatchError(404, en('Watch not found'));
    return r;
  }

  patch(id: number, body: { patterns?: unknown; caseIns?: unknown; everyMin?: unknown; alsoTo?: unknown; conversationId?: unknown }): Watch {
    const r = this.#must(id);
    if (r.state === 'stopped') throw new WatchError(409, en('This watch has stopped. Add it again to start over.'));
    const p: Record<string, string | number | null> = {};
    if (body.patterns !== undefined) p.patterns_json = JSON.stringify(cleanPatterns(body.patterns));
    if (body.everyMin !== undefined) p.every_min = cleanEvery(body.everyMin);
    if (body.caseIns !== undefined) p.case_ins = body.caseIns ? 1 : 0;
    if (body.alsoTo !== undefined) p.also_to = JSON.stringify(this.#alsoTo(body.alsoTo));
    if (body.conversationId !== undefined) p.conversation_id = this.#cardChat(body.conversationId);
    if (Object.keys(p).length) this.#set(id, p);
    return this.get(id)!;
  }

  pause(id: number, reason = 'owner'): Watch {
    const r = this.#must(id);
    if (r.state === 'active') this.#set(id, { state: 'paused', reason });
    return this.get(id)!;
  }

  /** Turn back on (also renews the 30 days). */
  resume(id: number): Watch {
    const r = this.#must(id);
    if (r.state === 'stopped') throw new WatchError(409, en('This watch has stopped. Add it again to start over.'));
    if (r.state !== 'paused') throw new WatchError(409, en('This watch isn’t paused.'));
    if (this.#activeCount() >= WATCH.maxActive) throw new WatchError(409, en('{n} watches are already on. Pause one first.'), { n: WATCH.maxActive });
    const now = this.#now();
    this.#set(id, { state: 'active', reason: null, misses: 0, ends_at: new Date(now.getTime() + WATCH.lifeDays * DAY_MS).toISOString() });
    return this.get(id)!;
  }

  /** Stop: no more checks from now on (the row stays, with its alerts, until forgotten). */
  stop(id: number, reason = 'owner'): Watch {
    const r = this.#must(id);
    if (r.state !== 'stopped') this.#set(id, { state: 'stopped', reason });
    return this.get(id)!;
  }

  /** Stop and forget: the watch and its alerts are deleted. */
  forget(id: number): void {
    this.#db.prepare('DELETE FROM env_alerts WHERE watch_id = ?').run(id);
    this.#db.prepare('DELETE FROM env_watch_pings WHERE watch_id = ?').run(id);
    this.#db.prepare('DELETE FROM env_watches WHERE id = ?').run(id);
    this.#checkNowAt.delete(id);
  }

  alerts(id: number): WatchAlert[] {
    const rows = this.#db.prepare('SELECT * FROM env_alerts WHERE watch_id = ? ORDER BY id DESC').all(id) as unknown as { id: number; watch_id: number; pattern: string; line_capped: string; first_at: string; last_at: string; count: number; notified: number }[];
    return rows.map((a) => ({ id: a.id, watchId: a.watch_id, pattern: a.pattern, line: a.line_capped, firstAt: a.first_at, lastAt: a.last_at, count: a.count, notified: Boolean(a.notified) }));
  }

  #keep(line: string): string {
    return this.#app.redactor.redact(line).replace(/\s+/g, ' ').trim().slice(0, WATCH.keepChars);
  }

  #matchOf(r: Row): (line: string) => string | undefined {
    const pats = JSON.parse(r.patterns_json) as string[];
    if (!r.case_ins) return (line) => pats.find((p) => line.includes(p));
    const low = pats.map((p) => p.toLowerCase());
    return (line) => {
      const l = line.toLowerCase();
      const i = low.findIndex((p) => l.includes(p));
      return i < 0 ? undefined : pats[i];
    };
  }

  /** One check: new lines since the stored offset, matched and recorded. */
  check(id: number): CheckResult {
    const r = this.#row(id);
    if (!r || r.state === 'stopped') return { ok: false, matched: [], error: 'stopped' };
    const now = this.#now();
    const iso = now.toISOString();
    let opened: { fd: number; st: BigIntStats };
    try {
      opened = openChecked(r.root_dir, r.path_abs, r.root_kind);
    } catch (e) {
      const code = e instanceof PathRefused ? e.message : 'missing';
      const misses = r.misses + 1;
      this.#set(id, { last_check_at: iso, last_error: code, misses });
      if (misses >= WATCH.missesToPause && r.state === 'active') this.#pausedNotice(r, code);
      return { ok: false, matched: [], error: code };
    }
    const { fd, st } = opened;
    let res: CheckResult;
    let offset: number;
    try {
      const size = Number(st.size);
      let start = r.offset;
      let note: CheckResult['note'];
      let skipped = 0;
      if (r.ino !== String(st.ino) || r.dev !== String(st.dev) || size < start) {
        start = 0;
        note = 'rotated';
      }
      if (size - start > WATCH.readCap) {
        skipped = size - WATCH.readCap - start;
        start = size - WATCH.readCap;
        note ??= 'skipped';
      }
      const buf = readAt(fd, start, size - start);
      const nl = buf.lastIndexOf(0x0a);
      let body: Buffer;
      if (nl >= 0) {
        body = buf.subarray(0, nl);
        offset = start + nl + 1;
      } else if (buf.length >= WATCH.readCap) {
        body = buf;
        offset = start + buf.length;
      } else {
        body = Buffer.alloc(0);
        offset = start;
      }
      const match = this.#matchOf(r);
      const matched: string[] = [];
      for (const line of toLines(body, skipped > 0)) {
        const p = match(line);
        if (!p) continue;
        matched.push(this.#app.redactor.redact(line));
        this.#record(r, p, line, iso, now.getTime());
      }
      res = { ok: true, matched, ...(note ? { note } : {}), ...(skipped ? { skippedKb: Math.ceil(skipped / 1024) } : {}) };
      this.#set(id, { dev: String(st.dev), ino: String(st.ino), offset, misses: 0, last_error: note === 'rotated' ? 'rotated' : skipped ? 'skipped' : null, last_check_at: iso, ...(matched.length ? { last_match_at: iso } : {}) });
    } finally {
      closeSync(fd);
    }
    if (res.matched.length) {
      this.#db.prepare('DELETE FROM env_alerts WHERE watch_id = ? AND id NOT IN (SELECT id FROM env_alerts WHERE watch_id = ? ORDER BY id DESC LIMIT ?)').run(id, id, WATCH.keepRows);
    }
    return res;
  }

  #record(r: Row, pattern: string, line: string, iso: string, at: number): void {
    const kept = this.#keep(line);
    const key = createHash('sha256').update(`${r.id}\n${pattern}\n${normalizeMessage(kept)}`).digest('hex');
    const prev = this.#db.prepare('SELECT id, first_at FROM env_alerts WHERE watch_id = ? AND key = ? ORDER BY id DESC LIMIT 1').get(r.id, key) as { id: number; first_at: string } | undefined;
    if (prev && at - Date.parse(prev.first_at) < WATCH.dedupeMs) {
      this.#db.prepare('UPDATE env_alerts SET count = count + 1, last_at = ? WHERE id = ?').run(iso, prev.id);
      return;
    }
    this.#db.prepare('INSERT INTO env_alerts (watch_id, key, pattern, line_capped, first_at, last_at, count, notified) VALUES (?, ?, ?, ?, ?, ?, 1, 0)').run(r.id, key, pattern, kept, iso, iso);
  }

  /** Check now (≤ 1 per 10 s): a check, plus a preview of matches in the last 256 KB (never a ping). */
  checkNow(id: number): { watch: Watch; result: CheckResult; preview: string[] } {
    const r = this.#must(id);
    if (r.state === 'stopped') throw new WatchError(409, en('This watch has stopped. Add it again to start over.'));
    const t = this.#now().getTime();
    const last = this.#checkNowAt.get(id);
    if (last !== undefined && t - last < WATCH.checkNowMs) throw new WatchError(429, en('Checked a moment ago. Try again in a few seconds.'));
    this.#checkNowAt.set(id, t);
    const preview: string[] = [];
    try {
      const { fd, st } = openChecked(r.root_dir, r.path_abs, r.root_kind);
      try {
        const size = Number(st.size);
        const start = Math.max(0, size - WATCH.readCap);
        const match = this.#matchOf(r);
        for (const line of toLines(readAt(fd, start, size - start), start > 0)) if (match(line)) preview.push(this.#keep(line));
      } finally {
        closeSync(fd);
      }
    } catch {
      /* the check below records why */
    }
    const result = this.check(id);
    this.#notify(this.#row(id)!, this.#now());
    return { watch: this.get(id)!, result, preview: preview.slice(-5) };
  }

  #day(now: Date): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: this.#app.settings.get().timeZone || undefined }).format(now);
    } catch {
      return now.toISOString().slice(0, 10);
    }
  }

  #conversation(r: Row): string {
    const store = this.#app.store;
    if (r.conversation_id && this.#ownChat(r.conversation_id)) return r.conversation_id;
    return (store.listConversations().find((c) => this.#ownChat(c.id)) ?? store.createConversation({ title: 'Watches' })).id;
  }

  /** The card and the ping for what is new (folded: one per watch per 10 min, 12 a day, none in quiet hours). */
  #notify(r: Row, now: Date): boolean {
    const pending = this.#db.prepare('SELECT id, pattern, line_capped FROM env_alerts WHERE watch_id = ? AND notified = 0 ORDER BY id').all(r.id) as unknown as { id: number; pattern: string; line_capped: string }[];
    if (!pending.length || quietNow(this.#app, now)) return false;
    if (r.last_ping_at && now.getTime() - Date.parse(r.last_ping_at) < WATCH.pingGapMs) return false;
    const day = this.#day(now);
    if ((this.#db.prepare('SELECT COUNT(*) AS n FROM env_watch_pings WHERE day = ?').get(day) as { n: number }).n >= WATCH.pingsPerDay) return false;
    const s = this.#app.settings.get();
    const file = basename(r.path_abs);
    const first = pending[0];
    const more = pending.length - 1;
    const conversationId = this.#conversation(r);
    const iso = now.toISOString();
    const msg = this.#app.store.addMessage(conversationId, 'notice', `watch:${first.line_capped}`, { watch: { id: r.id, alertId: first.id, file, pattern: first.pattern, more } });
    this.#app.events?.publish({ type: 'message', conversationId, message: msg, reason: 'reply' });
    const text = more ? `${first.line_capped} ${trOwner('(+{n} more)', s, { n: more })}` : first.line_capped;
    const title = trOwner('Watch: {file}', s, { file });
    void this.#app.push?.notifyOwner(title, text, conversationId, `watch-${r.id}`).catch(() => {});
    // "Also send to": the same ping, the same capped and scrubbed text, the owner's own chat only.
    const linked = this.#linked();
    for (const b of JSON.parse(r.also_to || '[]') as WatchBridge[]) {
      if (linked[b]) void this.#app.bridges?.[b]?.toOwner(`${title}\n${text}`).catch(() => false);
    }
    this.#db.prepare('UPDATE env_alerts SET notified = 1 WHERE watch_id = ? AND notified = 0').run(r.id);
    this.#db.prepare('INSERT INTO env_watch_pings (watch_id, day, at) VALUES (?, ?, ?)').run(r.id, day, iso);
    this.#set(r.id, { last_ping_at: iso });
    return true;
  }

  #pausedNotice(r: Row, code: string): void {
    this.#set(r.id, { state: 'paused', reason: 'missing' });
    const s = this.#app.settings.get();
    const file = basename(r.path_abs);
    const conversationId = this.#conversation(r);
    const text = trOwner('Paused watching {file}: it was missing or unreadable 3 checks running.', s, { file });
    const msg = this.#app.store.addMessage(conversationId, 'notice', `watch:${text}`, { watch: { id: r.id, paused: code, file } });
    this.#app.events?.publish({ type: 'message', conversationId, message: msg, reason: 'reply' });
    void this.#app.push?.notifyOwner(trOwner('Watch: {file}', s, { file }), text, conversationId, `watch-${r.id}-paused`).catch(() => {});
  }

  /** Called from ReminderScheduler.tick() (the same 15 s clock and guard). Returns checks run. */
  due(now: Date = this.#now()): number {
    const t = now.getTime();
    let checks = 0;
    for (const r of this.#db.prepare("SELECT * FROM env_watches WHERE state != 'stopped'").all() as unknown as Row[]) {
      if (Date.parse(r.ends_at) <= t) {
        this.#set(r.id, { state: 'stopped', reason: 'ended' });
        continue;
      }
      if (r.state !== 'active') continue;
      if (!r.last_check_at || t - Date.parse(r.last_check_at) >= r.every_min * 60_000) {
        this.check(r.id);
        checks++;
      }
    }
    // Held pings (rate limit, quiet hours) go out folded once allowed.
    for (const r of this.#db.prepare("SELECT * FROM env_watches WHERE state = 'active' AND id IN (SELECT watch_id FROM env_alerts WHERE notified = 0)").all() as unknown as Row[]) this.#notify(r, now);
    if (t - this.#sweptAt >= 10 * 60_000) {
      this.#sweptAt = t;
      this.#db.prepare('DELETE FROM env_alerts WHERE last_at < ?').run(new Date(t - WATCH.keepDays * DAY_MS).toISOString());
      this.#db.prepare('DELETE FROM env_watch_pings WHERE at < ?').run(new Date(t - 2 * DAY_MS).toISOString());
    }
    return checks;
  }

  /**
   * "Ask about this alert": the owner's own message about one capped line (he sends it as a normal
   * chat turn, with his normal approvals). `cloud` tells the app to say a cloud model would read it.
   */
  ask(alertId: number): { conversationId: string; text: string; cloud: boolean } {
    const a = this.#db.prepare('SELECT watch_id, line_capped FROM env_alerts WHERE id = ?').get(alertId) as { watch_id: number; line_capped: string } | undefined;
    const r = a ? this.#row(a.watch_id) : undefined;
    if (!a || !r) throw new WatchError(404, en('Alert not found'));
    const text = trOwner('About this line from {file}: “{line}”. What does it mean, and what should I check? Don’t change anything yet.', this.#app.settings.get(), { file: basename(r.path_abs), line: a.line_capped });
    return { conversationId: this.#conversation(r), text, cloud: !privateLocalOn() };
  }
}

