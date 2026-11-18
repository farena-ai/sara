// U4.26 (docs/SHARED_PROJECTS.md): shared projects between linked friends, built on an S9a link
// (src/messages.ts). The owner who shares a project (the host) invites one or more linked friends as
// viewer or contributor and picks what is shared: notes, the task list, files (uploads or Library
// items) and, off by default, chats of that project (never private, adult or other-app chats).
//
// The shared items live in their own space (shared-projects.db + a files folder) on both servers: the
// host's own planner notes are copied in when a kind is turned on, never linked, so nothing else of
// either owner ever leaves. Every change is an event with a version; the host keeps the event log and
// relays to every friend, each friend pushes its own changes to the host. Last writer wins per item
// (version, then time, then name); a file edited on both sides while apart keeps the losing edit as a
// conflict copy, made by the side that held the losing edit (so there is exactly one). Unsent events
// wait in the log until the other side acknowledges them (offline catch-up on the reminder tick).
//
// Wire: POST /msg/v1/sproj/<op>, signed like S9b with the scope word 'sproj' (src/support.ts
// signSupport/verify: a message, support or repair signature never passes here). Ops are data only:
// invite, answer, leave, remove, events. Nothing reads, asks or runs anything on the other server.
// Roles are enforced where events ARRIVE: the host refuses a viewer's events, kinds that are off, and
// anyone removed or gone.
import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import type { Messenger } from './messages.ts';
import { privateLocalOn } from './net-guard.ts';
import { signSupport, SupportError, supportOf } from './support.ts';

export const SP_ROLES = ['viewer', 'contributor'] as const;
export const SP_KINDS = ['notes', 'tasks', 'files', 'chats'] as const;
export const SP_NOTIFY = ['quiet', 'all', 'none'] as const;
export type SpRole = (typeof SP_ROLES)[number];
export type SpKinds = (typeof SP_KINDS)[number];
export type ItemKind = 'note' | 'task' | 'file' | 'chat';
const KIND_OF: Record<ItemKind, SpKinds> = { note: 'notes', task: 'tasks', file: 'files', chat: 'chats' };
export const SP_FILE_MAX = 2 * 1024 * 1024;
export const SP_PEER_MAX = 8 * 1024 * 1024;
const BATCH_BYTES = 5 * 1024 * 1024;
const TITLE = 200;
const BODY = 50_000;
const ACTIVITY_KEEP = 300;
export const SP_OPS = ['invite', 'answer', 'leave', 'remove', 'events'] as const;

export interface SpEvent {
  item: string;
  kind: ItemKind;
  title: string;
  body: string;
  done: boolean;
  sha?: string | null;
  size?: number;
  version: number;
  base: number;
  at: string;
  by: string;
  deleted: boolean;
  /** File bytes (base64), only on the wire. */
  data?: string;
}
export interface SpItem extends Omit<SpEvent, 'data' | 'base' | 'item'> {
  id: string;
}
export interface SpMember {
  link: string;
  name: string;
  role: SpRole;
  status: 'invited' | 'active' | 'declined' | 'left' | 'removed';
}
export interface SpShare {
  id: string;
  side: 'host' | 'guest';
  name: string;
  projectId: number | null;
  from: string;
  role: SpRole | 'owner';
  kinds: SpKinds[];
  status: 'invited' | 'active' | 'declined' | 'ended';
  notify: (typeof SP_NOTIFY)[number];
  createdAt: string;
  members: SpMember[];
  unseen: number;
}
export interface SpActivity {
  at: string;
  who: string;
  what: 'added' | 'changed' | 'removed' | 'conflict' | 'invited' | 'joined' | 'declined' | 'left' | 'removed-member';
  kind: string;
  title: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, side TEXT NOT NULL, name TEXT NOT NULL, project_id INTEGER, host_link TEXT, host_name TEXT NOT NULL DEFAULT '', my_role TEXT NOT NULL DEFAULT 'viewer', kinds TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, notify TEXT NOT NULL DEFAULT 'quiet', seen_n INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (share TEXT NOT NULL, link TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (share, link));
CREATE TABLE IF NOT EXISTS items (share TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, sha TEXT, size INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, src TEXT, PRIMARY KEY (share, id));
CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, share TEXT NOT NULL, ev TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (n INTEGER PRIMARY KEY AUTOINCREMENT, share TEXT NOT NULL, at TEXT NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '');
`;

const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const SHA_RE = /^[a-f0-9]{64}$/;
const bad = (why: string, status = 400) => new SupportError(status, why);
/** Last writer wins: a higher version, then a later time, then the larger name (the same answer on both sides). */
export function newer(a: { version: number; at: string; by: string }, b: { version: number; at: string; by: string }): boolean {
  if (a.version !== b.version) return a.version > b.version;
  if (a.at !== b.at) return a.at > b.at;
  return a.by > b.by;
}
/** A chat whose words may never be shared: private, someone else's (partner), adult channels, agent-to-agent. */
export function unshareableChat(c: { private: boolean; partner: string | null; channel: string }): boolean {
  return Boolean(c.private || c.partner || c.channel.endsWith('-nsfw') || c.channel === 'a2a');
}

type Row = Record<string, unknown>;
type Deps = Pick<AppContext, 'dataDir' | 'now' | 'messages' | 'planner' | 'store' | 'library' | 'redactor'>;

export class SharedProjects {
  readonly #db: DatabaseSync;
  readonly #m: Messenger;
  readonly #app: Deps;
  readonly #dir: string;
  #closed = false;
  #busy: Promise<void> = Promise.resolve();
  /** share/link pairs whose role or kinds changed: the host sends them even with no new events. */
  readonly #meta = new Set<string>();
  /** Tests: the link is down (nothing is sent; events wait in the log). */
  hold = false;
  /** Something changed (the open pages reload). */
  onChange: ((shareId: string) => void) | undefined;
  /** A T4 notice for changes from a friend (only when this share's notices are set to "all"). */
  onNotice: ((title: string, body: string, shareId: string) => void) | undefined;

  static exists(app: Pick<AppContext, 'dataDir' | 'messages'>): boolean {
    return Boolean(app.messages) && existsSync(join(app.dataDir, 'shared-projects.db'));
  }

  constructor(app: Deps & { messages: Messenger }) {
    this.#app = app;
    this.#m = app.messages;
    this.#dir = join(app.dataDir, 'shared-projects');
    this.#db = new DatabaseSync(join(app.dataDir, 'shared-projects.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#m.whenClosed(() => this.close());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
  #iso(): string {
    return this.#app.now().toISOString();
  }
  #me(): string {
    return this.#m.name();
  }

  // ---- reading ---------------------------------------------------------------------------------
  #row(id: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as Row | undefined;
  }
  #need(id: string): Row {
    const r = this.#row(id);
    if (!r) throw bad(en('Not found'), 404);
    return r;
  }
  #members(share: string): SpMember[] {
    return (this.#db.prepare('SELECT link, name, role, status FROM members WHERE share = ? ORDER BY name').all(share) as Row[]).map((r) => ({ link: String(r.link), name: String(r.name), role: r.role === 'contributor' ? 'contributor' : 'viewer', status: String(r.status) as SpMember['status'] }));
  }
  #view(r: Row): SpShare {
    const id = String(r.id);
    const host = r.side === 'host';
    const unseen = Number((this.#db.prepare('SELECT COUNT(*) AS n FROM activity WHERE share = ? AND n > ? AND who != ?').get(id, Number(r.seen_n), this.#me()) as Row).n);
    return {
      id,
      side: host ? 'host' : 'guest',
      name: String(r.name),
      projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id),
      from: host ? this.#me() : String(r.host_name),
      role: host ? 'owner' : r.my_role === 'contributor' ? 'contributor' : 'viewer',
      kinds: JSON.parse(String(r.kinds)) as SpKinds[],
      status: String(r.status) as SpShare['status'],
      notify: (SP_NOTIFY as readonly string[]).includes(String(r.notify)) ? (String(r.notify) as SpShare['notify']) : 'quiet',
      createdAt: String(r.created_at),
      members: host ? this.#members(id) : [],
      unseen,
    };
  }
  list(): SpShare[] {
    return (this.#db.prepare("SELECT * FROM shares WHERE status != 'declined' ORDER BY created_at DESC").all() as Row[]).map((r) => this.#view(r));
  }
  get(id: string): SpShare {
    return this.#view(this.#need(id));
  }
  /** The share a local project belongs to (host: the shared project; guest: the project made on accept). */
  forProject(projectId: number): SpShare | undefined {
    const r = this.#db.prepare("SELECT * FROM shares WHERE project_id = ? AND status IN ('active', 'ended') ORDER BY created_at DESC LIMIT 1").get(projectId) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }
  items(share: string): SpItem[] {
    this.#need(share);
    return (this.#db.prepare('SELECT * FROM items WHERE share = ? AND deleted = 0 ORDER BY kind, title').all(share) as Row[]).map((r) => this.#item(r));
  }
  #item(r: Row): SpItem {
    return { id: String(r.id), kind: String(r.kind) as ItemKind, title: String(r.title), body: String(r.body), done: Boolean(r.done), sha: (r.sha as string | null) ?? null, size: Number(r.size), version: Number(r.version), at: String(r.at), by: String(r.by), deleted: Boolean(r.deleted) };
  }
  activity(share: string, limit = 50): SpActivity[] {
    return this.#db.prepare('SELECT at, who, what, kind, title FROM activity WHERE share = ? ORDER BY n DESC LIMIT ?').all(share, limit) as unknown as SpActivity[];
  }
  seen(share: string): void {
    this.#need(share);
    this.#db.prepare('UPDATE shares SET seen_n = (SELECT COALESCE(MAX(n), 0) FROM activity) WHERE id = ?').run(share);
  }
  /** Every event this server keeps for sending (what can ever leave it). */
  outgoing(share: string): SpEvent[] {
    return (this.#db.prepare('SELECT ev FROM log WHERE share = ? ORDER BY seq').all(share) as Row[]).map((r) => JSON.parse(String(r.ev)) as SpEvent);
  }
  file(share: string, item: string): { name: string; bytes: Buffer } | undefined {
    const r = this.#db.prepare('SELECT title, sha FROM items WHERE share = ? AND id = ? AND deleted = 0').get(share, item) as Row | undefined;
    if (!r?.sha) return undefined;
    const p = join(this.#dir, String(r.sha));
    return existsSync(p) ? { name: String(r.title), bytes: readFileSync(p) } : undefined;
  }
  #log(share: string, who: string, what: SpActivity['what'], kind = '', title = ''): void {
    this.#db.prepare('INSERT INTO activity (share, at, who, what, kind, title) VALUES (?, ?, ?, ?, ?, ?)').run(share, this.#iso(), clip(who, 80), what, kind, clip(title, TITLE));
    this.#db.prepare('DELETE FROM activity WHERE share = ? AND n <= (SELECT MAX(n) FROM activity WHERE share = ?) - ?').run(share, share, ACTIVITY_KEEP);
  }
  #putBytes(bytes: Buffer): string {
    const sha = sha256(bytes);
    mkdirSync(this.#dir, { recursive: true });
    const p = join(this.#dir, sha);
    if (!existsSync(p)) writeFileSync(p, bytes);
    return sha;
  }

  // ---- membership ------------------------------------------------------------------------------
  /** Host: share a project with a linked friend (a second friend joins the same share). */
  async invite(projectId: number, linkId: string, role: unknown, kinds: unknown): Promise<SpShare> {
    const p = this.#app.planner?.projects(true).find((x) => x.id === projectId && !x.builtin);
    if (!p) throw bad(en('Project not found'), 404);
    const peer = this.#m.peer(linkId);
    if (!peer) throw bad(en('That link is gone. Link the servers again under Messages.'), 404);
    const r = cleanRole(role);
    let row = this.#db.prepare("SELECT * FROM shares WHERE side = 'host' AND project_id = ? AND status = 'active'").get(projectId) as Row | undefined;
    if (!row) {
      const id = randomUUID();
      this.#db.prepare('INSERT INTO shares (id, side, name, project_id, kinds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'host', p.name, projectId, JSON.stringify(cleanKinds(kinds ?? ['notes', 'tasks'])), 'active', this.#iso());
      row = this.#row(id)!;
      this.#seed(id, [], cleanKinds(kinds ?? ['notes', 'tasks']));
    }
    const id = String(row.id);
    this.#db.prepare('INSERT INTO members (share, link, name, role, status, acked) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT (share, link) DO UPDATE SET role = excluded.role, status = excluded.status, acked = 0, name = excluded.name').run(id, linkId, peer.name, r, 'invited');
    this.#log(id, this.#me(), 'invited', '', peer.name);
    const s = this.get(id);
    await this.#call(linkId, 'invite', { share: id, name: s.name, role: r, kinds: s.kinds });
    this.onChange?.(id);
    return this.get(id);
  }
  /** Guest: accept (a project of her own appears for chats inside it) or decline. */
  async answer(share: string, accept: boolean): Promise<SpShare> {
    const r = this.#need(share);
    if (r.side !== 'guest' || r.status !== 'invited') throw bad(en('Already answered.'), 409);
    if (accept) {
      const pid = this.#newProject(String(r.name), String(r.host_name));
      this.#db.prepare("UPDATE shares SET status = 'active', project_id = ? WHERE id = ?").run(pid, share);
      this.#db.prepare("UPDATE members SET status = 'active', acked = 0 WHERE share = ?").run(share);
      this.#log(share, this.#me(), 'joined');
    } else this.#db.prepare("UPDATE shares SET status = 'declined' WHERE id = ?").run(share);
    await this.#call(String(r.host_link), 'answer', { share, accept }).catch(() => null);
    this.onChange?.(share);
    return this.get(share);
  }
  #newProject(name: string, host: string): number | null {
    const pl = this.#app.planner;
    if (!pl) return null;
    const taken = new Set(pl.projects(true).map((p) => p.name.toLowerCase()));
    let n = name.slice(0, 80);
    if (taken.has(n.toLowerCase())) n = `${name} (${host})`.slice(0, 80);
    for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} (${host} ${i})`.slice(0, 80);
    return pl.projectId(n);
  }
  /** Guest: leave (the host is told; the copy stays here, read-only, until deleted). */
  async leave(share: string): Promise<void> {
    const r = this.#need(share);
    if (r.side !== 'guest') throw bad(en('Not found'), 404);
    this.#db.prepare("UPDATE shares SET status = 'ended' WHERE id = ?").run(share);
    this.#log(share, this.#me(), 'left');
    await this.#call(String(r.host_link), 'leave', { share }).catch(() => null);
    this.onChange?.(share);
  }
  /** Host: remove a friend (sync to them stops at once; they are told). */
  async removeMember(share: string, linkId: string): Promise<void> {
    const r = this.#need(share);
    if (r.side !== 'host') throw bad(en('Not found'), 404);
    const m = this.#db.prepare('SELECT name FROM members WHERE share = ? AND link = ?').get(share, linkId) as Row | undefined;
    if (!m) throw bad(en('Not found'), 404);
    this.#db.prepare("UPDATE members SET status = 'removed' WHERE share = ? AND link = ?").run(share, linkId);
    this.#log(share, this.#me(), 'removed-member', '', String(m.name));
    await this.#call(linkId, 'remove', { share }).catch(() => null);
    this.onChange?.(share);
  }
  setRole(share: string, linkId: string, role: unknown): void {
    const r = this.#need(share);
    if (r.side !== 'host') throw bad(en('Not found'), 404);
    if (!Number(this.#db.prepare('UPDATE members SET role = ? WHERE share = ? AND link = ?').run(cleanRole(role), share, linkId).changes)) throw bad(en('Not found'), 404);
    // The new role travels with the next events (and an empty push now, or on the next tick).
    this.#meta.add(`${share}/${linkId}`);
    this.#kick();
    this.onChange?.(share);
  }
  /** Notices (either side); the host also changes the name and what is shared. */
  patch(share: string, v: Record<string, unknown>): SpShare {
    const r = this.#need(share);
    if (v.notify !== undefined) {
      if (!(SP_NOTIFY as readonly string[]).includes(String(v.notify))) throw bad(en('Pick quiet, all or none.'));
      this.#db.prepare('UPDATE shares SET notify = ? WHERE id = ?').run(String(v.notify), share);
    }
    if (v.kinds !== undefined) {
      if (r.side !== 'host') throw bad(en('Only the owner of the project can change what is shared.'), 403);
      const before = JSON.parse(String(r.kinds)) as SpKinds[];
      const after = cleanKinds(v.kinds);
      this.#db.prepare('UPDATE shares SET kinds = ? WHERE id = ?').run(JSON.stringify(after), share);
      this.#seed(share, before, after);
      // Kinds turned off: their items are removed on every side.
      for (const k of before.filter((x) => !after.includes(x))) {
        const kind = (Object.keys(KIND_OF) as ItemKind[]).find((x) => KIND_OF[x] === k)!;
        for (const it of this.#db.prepare('SELECT id FROM items WHERE share = ? AND kind = ? AND deleted = 0').all(share, kind) as Row[]) this.#change(share, String(it.id), { deleted: true }, true);
      }
      for (const m of this.#members(share)) this.#meta.add(`${share}/${m.link}`);
      this.#kick();
    }
    this.onChange?.(share);
    return this.get(share);
  }
  /** Guest: forget an ended or declined share here. Host: stop sharing with everyone. */
  async drop(share: string): Promise<void> {
    const r = this.#need(share);
    if (r.side === 'host') for (const m of this.#members(share).filter((x) => x.status === 'active' || x.status === 'invited')) await this.removeMember(share, m.link);
    else if (r.status === 'active') await this.leave(share);
    for (const t of ['items', 'log', 'activity', 'members']) this.#db.prepare(`DELETE FROM ${t} WHERE share = ?`).run(share);
    this.#db.prepare('DELETE FROM shares WHERE id = ?').run(share);
  }
  /** Copies the host project's own notes/tasks in when those kinds are turned on (once each). */
  #seed(share: string, before: SpKinds[], after: SpKinds[]): void {
    const pl = this.#app.planner;
    const r = this.#need(share);
    if (!pl || r.project_id === null) return;
    const pid = Number(r.project_id);
    const has = (src: string) => this.#db.prepare('SELECT 1 FROM items WHERE share = ? AND src = ? AND deleted = 0').get(share, src);
    if (after.includes('notes') && !before.includes('notes')) for (const n of pl.notes(undefined, 500).filter((x) => x.projectId === pid)) if (!has(`note:${n.id}`)) this.#add(share, { kind: 'note', title: n.title, body: n.body }, `note:${n.id}`);
    if (after.includes('tasks') && !before.includes('tasks')) for (const t of pl.tasks({ status: 'all', projectId: pid })) if (!has(`task:${t.id}`)) this.#add(share, { kind: 'task', title: t.title, body: t.notes, done: t.status === 'done' }, `task:${t.id}`);
  }

  // ---- local changes ---------------------------------------------------------------------------
  /** Checks that this owner may change items of this kind here now. */
  #mayEdit(r: Row, kind: ItemKind): void {
    if (r.status !== 'active') throw bad(en('This project is no longer shared.'), 409);
    if (r.side === 'guest' && r.my_role !== 'contributor') throw bad(en('You can look at this shared project but not change it.'), 403);
    if (!(JSON.parse(String(r.kinds)) as string[]).includes(KIND_OF[kind])) throw bad(en('That kind of item is not shared in this project.'), 403);
  }
  /** Adds an item (note, task, file from an upload or the Library, a chat of this project). */
  add(share: string, v: Record<string, unknown>): SpItem {
    const r = this.#need(share);
    const kind = String(v.kind) as ItemKind;
    if (!(kind in KIND_OF)) throw bad(en('Pick a note, a to-do, a file or a chat.'));
    this.#mayEdit(r, kind);
    if (kind === 'file') {
      const f = this.#fileIn(v);
      return this.#add(share, { kind, title: clip(v.title, TITLE) || f.name, body: '', sha: f.sha, size: f.size });
    }
    if (kind === 'chat') {
      const c = this.#app.store.getConversation(String(v.conversation ?? ''));
      if (!c || unshareableChat(c) || r.project_id === null || c.projectId !== Number(r.project_id)) throw bad(en('Only a chat of this project can be shared, never a private or adult one.'));
      return this.#add(share, { kind, title: clip(c.title, TITLE), body: this.#transcript(c.id) }, `chat:${c.id}`);
    }
    const title = clip(v.title, TITLE);
    if (!title) throw bad(en('Give it a title.'));
    return this.#add(share, { kind, title, body: clip(v.body, BODY), done: v.done === true });
  }
  #fileIn(v: Record<string, unknown>): { name: string; sha: string; size: number } {
    let bytes: Buffer | undefined;
    let name = '';
    if (v.libraryDoc !== undefined) {
      const doc = this.#app.library?.get(Number(v.libraryDoc));
      bytes = doc ? this.#app.library!.file(doc) : undefined;
      name = doc?.name ?? '';
    } else if (v.file && typeof v.file === 'object') {
      const f = v.file as Record<string, unknown>;
      bytes = Buffer.from(String(f.data ?? ''), 'base64');
      name = clip(f.name, TITLE);
    }
    if (!bytes || !bytes.length) throw bad(en('Pick a file.'));
    if (bytes.length > SP_FILE_MAX) throw bad(en('Files in a shared project can be up to 2 MB.'));
    return { name: name || 'file', sha: this.#putBytes(bytes), size: bytes.length };
  }
  #transcript(convId: string): string {
    const lines = this.#app.store.messages(convId).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-200).map((m) => `${m.role === 'user' ? this.#me() : 'Sara'}: ${m.content}`);
    return clip(this.#app.redactor ? this.#app.redactor.redact(lines.join('\n\n')) : lines.join('\n\n'), BODY);
  }
  #add(share: string, it: { kind: ItemKind; title: string; body: string; done?: boolean; sha?: string; size?: number }, src: string | null = null): SpItem {
    const id = randomUUID();
    const ev: SpEvent = { item: id, kind: it.kind, title: it.title, body: it.body, done: Boolean(it.done), sha: it.sha ?? null, size: it.size ?? 0, version: 1, base: 0, at: this.#iso(), by: this.#me(), deleted: false };
    this.#write(share, ev, src);
    this.#db.prepare('INSERT INTO log (share, ev) VALUES (?, ?)').run(share, JSON.stringify(ev));
    this.#log(share, this.#me(), 'added', it.kind, it.title);
    this.#kick();
    this.onChange?.(share);
    return this.#item(this.#db.prepare('SELECT * FROM items WHERE share = ? AND id = ?').get(share, id) as Row);
  }
  /** Changes or removes an item (a new version on top of the one this owner saw). */
  change(share: string, item: string, v: Record<string, unknown>): SpItem {
    const r = this.#need(share);
    const cur = this.#db.prepare('SELECT * FROM items WHERE share = ? AND id = ? AND deleted = 0').get(share, item) as Row | undefined;
    if (!cur) throw bad(en('Not found'), 404);
    this.#mayEdit(r, String(cur.kind) as ItemKind);
    const p: Partial<SpEvent> = {};
    if (v.deleted === true) p.deleted = true;
    if (v.title !== undefined) p.title = clip(v.title, TITLE) || String(cur.title);
    if (v.body !== undefined && cur.kind !== 'chat') p.body = clip(v.body, BODY);
    if (v.done !== undefined) p.done = v.done === true;
    if (cur.kind === 'file' && (v.file || v.libraryDoc !== undefined)) {
      const f = this.#fileIn(v);
      p.sha = f.sha;
      p.size = f.size;
    }
    if (cur.kind === 'chat' && v.refresh === true && String(cur.src ?? '').startsWith('chat:')) p.body = this.#transcript(String(cur.src).slice(5));
    this.#change(share, item, p);
    this.#kick();
    this.onChange?.(share);
    return this.#item(this.#db.prepare('SELECT * FROM items WHERE share = ? AND id = ?').get(share, item) as Row);
  }
  #change(share: string, item: string, p: Partial<SpEvent>, quiet = false): void {
    const cur = this.#item(this.#db.prepare('SELECT * FROM items WHERE share = ? AND id = ?').get(share, item) as Row);
    const { id: _i, ...rest } = cur;
    const ev: SpEvent = { ...rest, ...p, item, version: cur.version + 1, base: cur.version, at: this.#iso(), by: this.#me() };
    this.#write(share, ev);
    this.#db.prepare('INSERT INTO log (share, ev) VALUES (?, ?)').run(share, JSON.stringify(ev));
    if (!quiet) this.#log(share, this.#me(), ev.deleted ? 'removed' : 'changed', ev.kind, ev.title);
  }
  #write(share: string, e: SpEvent, src: string | null = null): void {
    this.#db
      .prepare('INSERT INTO items (share, id, kind, title, body, done, sha, size, version, at, by, deleted, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (share, id) DO UPDATE SET kind = excluded.kind, title = excluded.title, body = excluded.body, done = excluded.done, sha = excluded.sha, size = excluded.size, version = excluded.version, at = excluded.at, by = excluded.by, deleted = excluded.deleted')
      .run(share, e.item, e.kind, e.title, e.body, e.done ? 1 : 0, e.sha ?? null, e.size ?? 0, e.version, e.at, e.by, e.deleted ? 1 : 0, src);
  }

  // ---- receiving -------------------------------------------------------------------------------
  /** One verified peer request (the route checked the signature). Returns the reply body or throws SupportError. */
  received(linkId: string, name: string, op: string, b: Record<string, unknown>): Record<string, unknown> {
    const share = clip(b.share, 64);
    if (!share) throw bad('bad request');
    const r = this.#row(share);
    if (op === 'invite') {
      if (r && r.side === 'host') throw bad('bad request');
      const kinds = cleanKinds(b.kinds);
      if (r && r.status === 'active') return { ok: true };
      if (r) this.#db.prepare("UPDATE shares SET status = 'invited', my_role = ?, kinds = ?, name = ? WHERE id = ?").run(cleanRole(b.role), JSON.stringify(kinds), clip(b.name, 80) || 'Project', share);
      else this.#db.prepare('INSERT INTO shares (id, side, name, host_link, host_name, my_role, kinds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(share, 'guest', clip(b.name, 80) || 'Project', linkId, name, cleanRole(b.role), JSON.stringify(kinds), 'invited', this.#iso());
      this.#db.prepare("INSERT INTO members (share, link, name, role, status) VALUES (?, ?, ?, 'contributor', 'invited') ON CONFLICT (share, link) DO UPDATE SET status = 'invited', acked = 0").run(share, linkId, name);
      this.#log(share, name, 'invited', '', this.#me());
      this.onChange?.(share);
      this.onNotice?.(en('Shared project'), `${name}: ${clip(b.name, 80)}`, share);
      return { ok: true };
    }
    if (!r) throw bad('not shared', 403);
    if (r.side === 'host') {
      const m = this.#db.prepare('SELECT * FROM members WHERE share = ? AND link = ?').get(share, linkId) as Row | undefined;
      if (!m) throw bad('not shared', 403);
      if (op === 'answer') {
        if (m.status !== 'invited') return { ok: true };
        const yes = b.accept === true;
        this.#db.prepare('UPDATE members SET status = ?, acked = 0 WHERE share = ? AND link = ?').run(yes ? 'active' : 'declined', share, linkId);
        this.#log(share, name, yes ? 'joined' : 'declined');
        if (yes) this.#kick();
        this.onChange?.(share);
        return { ok: true };
      }
      if (op === 'leave') {
        this.#db.prepare("UPDATE members SET status = 'left' WHERE share = ? AND link = ?").run(share, linkId);
        this.#log(share, name, 'left');
        this.onChange?.(share);
        return { ok: true };
      }
      if (op !== 'events') throw bad('bad request');
      // Roles on the receiving side: only an active contributor's events, only kinds that are shared.
      if (r.status !== 'active' || m.status !== 'active' || m.role !== 'contributor') throw bad('not allowed', 403);
      const kinds = JSON.parse(String(r.kinds)) as string[];
      const evs = cleanEvents(b.events);
      if (evs.some((e) => !kinds.includes(KIND_OF[e.kind]))) throw bad('not allowed', 403);
      const last = Number(b.last) || 0;
      this.#apply(share, evs, name, true);
      return { ok: true, ack: last };
    }
    // Guest side: only the host of this share.
    if (String(r.host_link) !== linkId) throw bad('not shared', 403);
    if (op === 'remove') {
      this.#db.prepare("UPDATE shares SET status = 'ended' WHERE id = ?").run(share);
      this.#log(share, name, 'removed-member', '', this.#me());
      this.onChange?.(share);
      return { ok: true };
    }
    if (op !== 'events' || r.status !== 'active') throw bad('not shared', 403);
    // The host's events carry the current role and kinds (offline catch-up includes changes to them).
    if (b.role !== undefined) this.#db.prepare('UPDATE shares SET my_role = ? WHERE id = ?').run(cleanRole(b.role), share);
    if (b.kinds !== undefined) this.#db.prepare('UPDATE shares SET kinds = ? WHERE id = ?').run(JSON.stringify(cleanKinds(b.kinds)), share);
    if (typeof b.name === 'string' && b.name.trim()) this.#db.prepare('UPDATE shares SET name = ? WHERE id = ?').run(clip(b.name, 80), share);
    this.#apply(share, cleanEvents(b.events), name, false);
    return { ok: true, ack: Number(b.last) || 0 };
  }
  /** Applies events (last writer wins; a lost concurrent file edit held here becomes a conflict copy). */
  #apply(share: string, evs: (SpEvent & { bytes?: Buffer })[], from: string, relay: boolean): void {
    let changed = 0;
    let lastTitle = '';
    for (const e of evs) {
      if (e.bytes && e.sha && sha256(e.bytes) === e.sha) this.#putBytes(e.bytes);
      const { bytes: _b, ...ev } = e;
      const row = this.#db.prepare('SELECT * FROM items WHERE share = ? AND id = ?').get(share, ev.item) as Row | undefined;
      const cur = row ? this.#item(row) : undefined;
      if (cur && !newer(ev, cur)) continue; // ours wins (or it is our own event coming back)
      const conflict = cur && ev.kind === 'file' && !cur.deleted && !ev.deleted && ev.base < cur.version && cur.sha !== ev.sha;
      this.#write(share, ev);
      if (relay) this.#db.prepare('INSERT INTO log (share, ev) VALUES (?, ?)').run(share, JSON.stringify(ev));
      this.#log(share, from, !cur ? 'added' : ev.deleted ? 'removed' : 'changed', ev.kind, ev.title);
      if (conflict) {
        const copy = `${cur.title} (conflict copy, ${cur.by})`.slice(0, TITLE);
        this.#add(share, { kind: 'file', title: copy, body: '', sha: cur.sha ?? undefined, size: cur.size });
        this.#log(share, this.#me(), 'conflict', 'file', copy);
      }
      changed++;
      lastTitle = ev.title;
    }
    if (!changed) return;
    this.onChange?.(share);
    const s = this.#row(share)!;
    if (s.notify === 'all') this.onNotice?.(String(s.name), changed === 1 ? `${from}: ${lastTitle}` : `${from}: ${changed}`, share);
    if (relay) this.#kick();
  }

  // ---- sending ---------------------------------------------------------------------------------
  /** Sends what each side has not acknowledged yet (after a change, and on every reminder tick). */
  #kick(): void {
    this.#busy = this.#busy.then(() => this.#pushAll()).catch(() => undefined);
  }
  flush(): Promise<void> {
    this.#kick();
    return this.#busy;
  }
  async due(_now: Date): Promise<void> {
    await this.flush();
  }
  async #pushAll(): Promise<void> {
    if (this.#closed || this.hold || privateLocalOn()) return;
    const rows = this.#db.prepare("SELECT m.share, m.link, m.acked, m.role, s.side, s.kinds, s.name FROM members m JOIN shares s ON s.id = m.share WHERE m.status = 'active' AND s.status = 'active'").all() as Row[];
    for (const m of rows) {
      const share = String(m.share);
      const host = m.side === 'host';
      for (let round = 0; round < 20; round++) {
        let acked = Number(m.acked);
        const evs = this.#db.prepare('SELECT seq, ev FROM log WHERE share = ? AND seq > ? ORDER BY seq LIMIT 200').all(share, acked) as Row[];
        const key = `${share}/${String(m.link)}`;
        if (!evs.length && !(host && round === 0 && this.#meta.has(key))) break;
        const out: SpEvent[] = [];
        let bytes = 0;
        let last = acked;
        for (const x of evs) {
          const ev = JSON.parse(String(x.ev)) as SpEvent;
          if (ev.kind === 'file' && ev.sha && !ev.deleted) {
            const p = join(this.#dir, ev.sha);
            if (existsSync(p)) ev.data = readFileSync(p).toString('base64');
          }
          bytes += JSON.stringify(ev).length;
          if (out.length && bytes > BATCH_BYTES) break;
          out.push(ev);
          last = Number(x.seq);
        }
        const extra = host ? { role: String(m.role), kinds: JSON.parse(String(m.kinds)), name: String(m.name) } : {};
        let res: Record<string, unknown> | null;
        try {
          res = await this.#call(String(m.link), 'events', { share, events: out, last, ...extra });
        } catch (err) {
          // Refused: removed there, or the share ended there. Stop sending until something changes.
          if (err instanceof SupportError && err.status === 403) {
            if (host) this.#db.prepare("UPDATE members SET status = 'removed' WHERE share = ? AND link = ? AND status = 'active'").run(share, String(m.link));
            else this.#db.prepare("UPDATE shares SET status = 'ended' WHERE id = ?").run(share);
            this.onChange?.(share);
          }
          break;
        }
        this.#meta.delete(key);
        acked = Math.max(acked, Number(res?.ack) || 0);
        this.#db.prepare('UPDATE members SET acked = ? WHERE share = ? AND link = ? AND acked < ?').run(acked, share, String(m.link), acked);
        m.acked = acked;
        if (evs.length < 200 && last === Number(evs.at(-1)?.seq ?? last)) break;
      }
    }
  }
  async #call(linkId: string, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (privateLocalOn()) throw new SupportError(503, en('Private local mode is on: nothing leaves this server.'));
    const p = this.#m.peer(linkId);
    const key: KeyObject | undefined = this.#m.privateKeyFor(linkId);
    if (!p || !key) throw new SupportError(404, en('That link is gone. Link the servers again under Messages.'));
    const body = JSON.stringify({ v: 1, id: randomUUID(), ...payload });
    let res: Response;
    try {
      res = await this.#m.peerFetch(`${p.url}/msg/v1/sproj/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(linkId, op, body, key, this.#app.now(), 'sproj') }, body, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new SupportError(502, en('The other server did not answer. Check its address and try again.'));
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new SupportError(res.status === 403 ? 403 : 502, en('The other server did not answer. Check its address and try again.'));
    return j;
  }
  /** Verifies a peer request (link, time, 'sproj' signature for this op, replay). */
  verify(headers: import('node:http').IncomingHttpHeaders, op: string, body: string): { linkId: string; name: string } {
    const sup = supportOf(this.#app as AppContext);
    if (!sup) throw new SupportError(401, 'unsigned');
    return sup.verify(headers, op, body, 'sproj');
  }
}

function cleanRole(v: unknown): SpRole {
  return v === 'contributor' ? 'contributor' : 'viewer';
}
function cleanKinds(v: unknown): SpKinds[] {
  const a = Array.isArray(v) ? v.map(String) : [];
  return SP_KINDS.filter((k) => a.includes(k));
}
function cleanEvents(v: unknown): (SpEvent & { bytes?: Buffer })[] {
  if (!Array.isArray(v) || v.length > 200) throw bad('bad request');
  return v.map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const kind = String(o.kind) as ItemKind;
    const item = clip(o.item, 64);
    const version = Number(o.version);
    if (!(kind in KIND_OF) || !item || !Number.isInteger(version) || version < 1 || !Number.isFinite(Date.parse(String(o.at)))) throw bad('bad request');
    const sha = typeof o.sha === 'string' && SHA_RE.test(o.sha) ? o.sha : null;
    const bytes = typeof o.data === 'string' && sha ? Buffer.from(o.data, 'base64') : undefined;
    if (bytes && bytes.length > SP_FILE_MAX) throw bad('too big');
    return { item, kind, title: clip(o.title, TITLE), body: clip(o.body, BODY), done: o.done === true, sha, size: Math.max(0, Number(o.size) || 0), version, base: Math.max(0, Number(o.base) || 0), at: new Date(String(o.at)).toISOString(), by: clip(o.by, 80), deleted: o.deleted === true, ...(bytes ? { bytes } : {}) };
  });
}

const cache = new WeakMap<Messenger, SharedProjects>();
/** The owner's shared projects (undefined for members, kid mode and the demo: they have no Messenger). */
export function sharedProjectsOf(app: Deps): SharedProjects | undefined {
  const m = app.messages;
  if (!m) return undefined;
  let s = cache.get(m);
  if (!s) cache.set(m, (s = new SharedProjects({ ...pick(app), messages: m })));
  return s;
}
// A live view of the app (its planner/library may be set after the engine is made).
function pick(app: Deps): Deps {
  return {
    get dataDir() { return app.dataDir; },
    now: () => app.now(),
    get messages() { return app.messages; },
    get planner() { return app.planner; },
    get store() { return app.store; },
    get library() { return app.library; },
    get redactor() { return app.redactor; },
  } as Deps;
}
