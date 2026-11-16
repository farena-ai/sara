// S9a (docs/MESSAGES.md): private messages between the PEOPLE who own linked Sara servers. One-to-one
// chats over a link, and communities hosted by their creator's server (fan-out to members).
//
// The agents are not involved: this module has its own database file (<data>/messages.db), its own
// keys, no model tool, no memory, no search index and no log line with what anyone wrote. Only the
// owner's own routes (src/routes/messages.ts) and the peer endpoint (/msg/v1, mounted in server.ts)
// reach it. Bodies and files are sealed with the vault key at rest.
//
// Wire (server to server, JSON over HTTPS):
//   POST /msg/v1/link   {v, token, url, key, name}       one-time code (or a community code) → {link, key, name, community?}
//   POST /msg/v1/inbox  {v, id, type, …}                 signed with the link's Ed25519 key:
//        headers sara-msg-link, sara-msg-time, sara-msg-sig = sign(`${link}\n${time}\n${sha256(body)}`)
// Event ids are remembered (a replay is 409); a time more than 5 minutes off is refused.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { en } from './i18n.ts';
import { isLanHost, isLoopbackHost, netFetch } from './net-guard.ts';
import { sniffImage } from './uploads.ts';
import type { Vault } from './vault.ts';

export const MSG = {
  textChars: 4000,
  fileBytes: 5 * 1024 * 1024,
  bodyBytes: 8 * 1024 * 1024,
  nameChars: 60,
  members: 50,
  linkCodeMinutes: 30,
  skewMs: 5 * 60_000,
  typingMs: 8_000,
  giveUpMs: 7 * 86_400_000,
  retentionDays: 30,
  perMinute: 240,
};
const RETRY = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const CODE_PREFIX = 'sara-msg:';

export class MsgError extends Error {
  readonly status: number;
  readonly params?: Record<string, unknown>;
  constructor(status: number, message: string, params?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (params) this.params = params;
  }
}

export interface MsgSettings {
  retentionDays: number;
  receipts: boolean;
  typing: boolean;
  url: string;
  name: string;
  /** T4: an in-app popup card for a new one-to-one message or mention. */
  popup: boolean;
  /** T4: a soft sound with the popup (off by default). */
  sound: boolean;
  /** T4: how communities notify unless a community picks its own. */
  communityNotify: NotifyLevel;
}
/** T4: a community's "Notify me": everything, when I'm mentioned (the default), nothing. */
export type NotifyLevel = 'all' | 'mentions' | 'none';
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['all', 'mentions', 'none'];
export interface ChatRow {
  id: string;
  kind: 'direct' | 'community';
  title: string;
  linkId: string | null;
  role: 'member' | 'mod' | 'host';
  status: 'active' | 'ended';
  muted: boolean;
  blocked: boolean;
  retentionDays: number | null;
  /** T4: a community's own "Notify me" (null: the server-wide default). */
  notify: NotifyLevel | null;
  lastAt: string | null;
  createdAt: string;
}
export interface MessageView {
  id: string;
  text: string;
  mine: boolean;
  author: string;
  authorId: string;
  at: string;
  editedAt: string | null;
  deleted: boolean;
  readAt: string | null;
  state: 'queued' | 'sent' | 'failed';
  file: { name: string; type: string; size: number } | null;
}
interface LinkRow {
  id: string;
  peer_url: string;
  peer_key: string;
  peer_name: string;
  kind: 'direct' | 'member' | 'host';
  community: string | null;
}
type Ev = Record<string, unknown> & { type: string };
type FileIn = { name?: unknown; data?: unknown };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pm_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pm_links (id TEXT PRIMARY KEY, peer_url TEXT NOT NULL, peer_key TEXT NOT NULL, peer_name TEXT NOT NULL, kind TEXT NOT NULL, community TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pm_invites (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, community TEXT, expires_at TEXT, used_at TEXT);
CREATE TABLE IF NOT EXISTS pm_chats (id TEXT PRIMARY KEY, kind TEXT NOT NULL, link_id TEXT, title TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'active',
  muted INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, retention INTEGER, last_at TEXT, created_at TEXT NOT NULL,
  roster TEXT NOT NULL DEFAULT '[]', reports TEXT NOT NULL DEFAULT '[]', hidden TEXT NOT NULL DEFAULT '[]', invite TEXT, me TEXT);
CREATE TABLE IF NOT EXISTS pm_messages (id TEXT NOT NULL, chat TEXT NOT NULL, mine INTEGER NOT NULL, author TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, file TEXT,
  at TEXT NOT NULL, edited_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, read_at TEXT, seen INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'sent', PRIMARY KEY (chat, id));
CREATE INDEX IF NOT EXISTS pm_messages_at ON pm_messages(chat, at);
CREATE TABLE IF NOT EXISTS pm_outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, link_id TEXT NOT NULL, chat TEXT, mid TEXT, body TEXT NOT NULL, once INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pm_seen (id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pm_members (community TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, url TEXT, PRIMARY KEY (community, id));
CREATE TABLE IF NOT EXISTS pm_bans (community TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (community, url));
CREATE TABLE IF NOT EXISTS pm_requests (id TEXT PRIMARY KEY, chat TEXT NOT NULL, from_name TEXT NOT NULL, code TEXT NOT NULL, at TEXT NOT NULL);
`;

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** T4: does the text @mention this name (the full name or its first word; any case; not inside a word)? */
export function isMention(text: string, name: string): boolean {
  const full = clip(name, MSG.nameChars);
  if (!full) return false;
  const first = full.split(' ')[0];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [...new Set([full, first])].filter((x) => x.length >= 2).map(esc).join('|');
  return names ? new RegExp(`(^|[^\\p{L}\\p{N}_@.])@(?:${names})(?![\\p{L}\\p{N}_])`, 'iu').test(text) : false;
}

/**
 * T4: where a new message's notice goes. `full` = push + toast + in-app popup; `quiet` = only the
 * small community count inside Messages; `none` = no notice at all (muted, blocked, "nothing").
 */
export function notifyRoute(o: { kind: ChatRow['kind']; muted: boolean; blocked: boolean; level: NotifyLevel; mention: boolean }): 'full' | 'quiet' | 'none' {
  if (o.muted || o.blocked) return 'none';
  if (o.kind === 'direct') return 'full';
  if (o.level === 'none') return 'none';
  return o.level === 'all' || o.mention ? 'full' : 'quiet';
}

/** A join code: `sara-msg:` + base64url JSON {u: server address, t: token, k: 'l' (one-time link) | 'c' (community)}. */
export function encodeCode(c: { u: string; t: string; k: 'l' | 'c' }): string {
  return CODE_PREFIX + Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeCode(code: string): { u: string; t: string; k: 'l' | 'c' } {
  const s = String(code ?? '').trim();
  if (!s.startsWith(CODE_PREFIX)) throw new MsgError(400, en('That is not a messages code. Ask for a new one.'));
  try {
    const j = JSON.parse(Buffer.from(s.slice(CODE_PREFIX.length), 'base64url').toString('utf8')) as { u: string; t: string; k: 'l' | 'c' };
    if (typeof j.u === 'string' && typeof j.t === 'string' && (j.k === 'l' || j.k === 'c')) return { u: peerUrl(j.u), t: j.t, k: j.k };
  } catch {
    /* below */
  }
  throw new MsgError(400, en('That is not a messages code. Ask for a new one.'));
}

/**
 * A server address for linking: https, or http only on this computer, the home network or Tailscale
 * (whose tunnel is already encrypted). No path, query or credentials.
 */
export function peerUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new MsgError(400, en('That server address is not valid.'));
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const okHttp = u.protocol === 'http:' && (isLoopbackHost(host) || isLanHost(host) || host.endsWith('.ts.net'));
  if ((u.protocol !== 'https:' && !okHttp) || u.username || u.password) throw new MsgError(400, en('That server address is not valid.'));
  return u.origin;
}

/** The headers of a signed envelope (exported for tests). */
export function signEnvelope(linkId: string, body: string, key: KeyObject, at: Date): Record<string, string> {
  const time = at.toISOString();
  const sig = sign(null, Buffer.from(`${linkId}\n${time}\n${sha(body)}`), key).toString('base64');
  return { 'sara-msg-link': linkId, 'sara-msg-time': time, 'sara-msg-sig': sig };
}

function fileFrom(f: FileIn): { name: string; type: string; bytes: Buffer } {
  const name = clip(f.name, 120).replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const data = typeof f.data === 'string' ? f.data : '';
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new MsgError(400, en('That file is empty.'));
  if (bytes.length > MSG.fileBytes) throw new MsgError(413, en('Files can be up to {n} MB.'), { n: MSG.fileBytes / 1024 / 1024 });
  // The upload checks: pictures by their first bytes (src/uploads.ts), PDF by its header, and plain
  // text only when it is valid UTF-8 without control bytes.
  let type = sniffImage(bytes);
  if (!type && bytes.subarray(0, 5).toString('latin1') === '%PDF-') type = 'application/pdf';
  if (!type && /\.(txt|md|csv)$/i.test(name)) {
    const s = bytes.toString('utf8');
    if (!s.includes('\uFFFD') && !/[\x00-\x08\x0e-\x1f]/.test(s)) type = 'text/plain';
  }
  if (!type) throw new MsgError(400, en('Only pictures (JPEG, PNG, WebP, GIF), PDF and text files can be sent.'));
  return { name, type, bytes };
}

export interface MessengerOptions {
  dataDir: string;
  vault: Vault;
  now?: () => Date;
  /** The owner's name as the other side sees it (settings.name overrides). */
  name?: () => string;
  /** The transport (netFetch by default: private local mode blocks links like any other outbound call). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export class Messenger {
  readonly #db: DatabaseSync;
  readonly #vault: Vault;
  readonly #now: () => Date;
  readonly #name: () => string;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly #files: string;
  readonly #typing = new Map<string, Map<string, number>>();
  readonly #rate = new Map<string, { min: number; n: number }>();
  #flushing: Promise<void> | undefined;
  #closed = false;
  /** A new message for the owner (not muted, not blocked): main.ts sends the phone/desktop notification. */
  onNotify: ((title: string, body: string, chatId: string, info?: { kind: ChatRow['kind']; mention: boolean }) => void) | undefined;
  /** Something changed in a chat (ids only): main.ts tells the open pages. */
  onChange: ((chatId: string) => void) | undefined;

  constructor(o: MessengerOptions) {
    this.#db = new DatabaseSync(join(o.dataDir, 'messages.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    // T4: columns added after S9a (older databases get them here).
    const has = (t: string, c: string) => (this.#db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((r) => r.name === c);
    if (!has('pm_chats', 'notify')) this.#db.exec('ALTER TABLE pm_chats ADD COLUMN notify TEXT');
    if (!has('pm_messages', 'mention')) this.#db.exec('ALTER TABLE pm_messages ADD COLUMN mention INTEGER NOT NULL DEFAULT 0');
    this.#vault = o.vault;
    this.#now = o.now ?? (() => new Date());
    this.#name = o.name ?? (() => '');
    this.#fetch = o.fetch ?? ((u, i) => netFetch(u, i));
    this.#files = join(o.dataDir, 'messages-files');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const f of this.#onClose.splice(0)) f();
    this.#db.close();
  }
  readonly #onClose: (() => void)[] = [];
  /** S9b: runs when the Messenger closes (the support link's own database closes with it). */
  whenClosed(f: () => void): void {
    this.#onClose.push(f);
  }
  /** S9b: the transport (netFetch, or the tests' seam) for the support link's signed calls. */
  peerFetch(url: string, init: RequestInit): Promise<Response> {
    return this.#fetch(url, init);
  }
  /** S9b: a one-to-one link's other side (address, public key, name); never a community's links. */
  peer(linkId: string): { id: string; url: string; key: KeyObject; name: string } | undefined {
    const l = this.#link(linkId);
    if (!l || l.kind !== 'direct') return undefined;
    try {
      return { id: l.id, url: l.peer_url, key: pubKey(l.peer_key), name: l.peer_name };
    } catch {
      return undefined;
    }
  }
  checkpoint(): void {
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  #iso(): string {
    return this.#now().toISOString();
  }

  // ---- settings ----------------------------------------------------------------------------------
  settings(): MsgSettings {
    const rows = this.#db.prepare('SELECT k, v FROM pm_settings').all() as { k: string; v: string }[];
    const m = Object.fromEntries(rows.map((r) => [r.k, JSON.parse(r.v)])) as Partial<MsgSettings>;
    return { retentionDays: m.retentionDays ?? MSG.retentionDays, receipts: m.receipts ?? true, typing: m.typing ?? true, url: m.url ?? '', name: m.name ?? '', popup: m.popup ?? true, sound: m.sound ?? false, communityNotify: NOTIFY_LEVELS.includes(m.communityNotify as NotifyLevel) ? (m.communityNotify as NotifyLevel) : 'mentions' };
  }
  setSettings(v: Record<string, unknown>): MsgSettings {
    const put = (k: string, val: unknown) => this.#db.prepare('INSERT INTO pm_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(val));
    if (v.retentionDays !== undefined) put('retentionDays', days(v.retentionDays));
    if (v.receipts !== undefined) put('receipts', Boolean(v.receipts));
    if (v.typing !== undefined) put('typing', Boolean(v.typing));
    if (v.url !== undefined) put('url', v.url ? peerUrl(v.url) : '');
    if (v.name !== undefined) put('name', clip(v.name, MSG.nameChars));
    if (v.popup !== undefined) put('popup', Boolean(v.popup));
    if (v.sound !== undefined) put('sound', Boolean(v.sound));
    if (v.communityNotify !== undefined) put('communityNotify', level(v.communityNotify));
    return this.settings();
  }
  name(): string {
    return this.settings().name || clip(this.#name(), MSG.nameChars) || 'Sara owner';
  }
  #myUrl(fallback?: string): string {
    const u = this.settings().url || fallback;
    if (!u) throw new MsgError(400, en('Set this server’s address first (Messages → Messages settings).'));
    return peerUrl(u);
  }

  // ---- keys and links ----------------------------------------------------------------------------
  privateKeyFor(linkId: string): KeyObject | undefined {
    const v = this.#vault.get(`pm:link:${linkId}`);
    return v ? createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' }) : undefined;
  }
  #newKeys(): { priv: string; pub: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  }
  #link(id: string): LinkRow | undefined {
    return this.#db.prepare('SELECT * FROM pm_links WHERE id = ?').get(id) as LinkRow | undefined;
  }
  #addLink(l: LinkRow, priv: string): void {
    this.#vault.set(`pm:link:${l.id}`, priv);
    this.#db.prepare('INSERT INTO pm_links (id, peer_url, peer_key, peer_name, kind, community, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(l.id, l.peer_url, l.peer_key, l.peer_name, l.kind, l.community, this.#iso());
  }
  /** Deletes a link's keys and row (the chat stays, ended, unless removed separately). */
  #dropLink(id: string): void {
    this.#vault.delete(`pm:link:${id}`);
    this.#db.prepare('DELETE FROM pm_links WHERE id = ?').run(id);
    this.#db.prepare('DELETE FROM pm_outbox WHERE link_id = ?').run(id);
  }
  links(): { id: string; name: string; kind: string; url: string; createdAt: string }[] {
    return (this.#db.prepare('SELECT * FROM pm_links ORDER BY created_at').all() as unknown as (LinkRow & { created_at: string })[]).map((l) => ({ id: l.id, name: l.peer_name, kind: l.kind, url: l.peer_url, createdAt: l.created_at }));
  }

  /** A one-time code another owner pastes to link (single use, 30 minutes). */
  invite(fallbackUrl?: string): { code: string; expiresAt: string } {
    const url = this.#myUrl(fallbackUrl);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.#now().getTime() + MSG.linkCodeMinutes * 60_000).toISOString();
    this.#db.prepare('INSERT INTO pm_invites (hash, kind, community, expires_at) VALUES (?, ?, NULL, ?)').run(sha(token), 'link', expiresAt);
    return { code: encodeCode({ u: url, t: token, k: 'l' }), expiresAt };
  }

  /** Pastes a code from another server: a link (one-to-one chat) or a community. */
  async join(code: string, fallbackUrl?: string): Promise<ChatRow> {
    const c = decodeCode(code);
    const me = this.#myUrl(fallbackUrl);
    if (c.u === me) throw new MsgError(400, en('That code is from this server.'));
    const keys = this.#newKeys();
    let res: Response;
    try {
      res = await this.#fetch(`${c.u}/msg/v1/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, token: c.t, url: me, key: keys.pub, name: this.name() }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new MsgError(502, en('The other server did not answer. Check its address and try again.'));
    }
    const j = (await res.json().catch(() => ({}))) as { link?: string; key?: string; name?: string; community?: { id?: string; name?: string }; error?: string };
    if (!res.ok || typeof j.link !== 'string' || typeof j.key !== 'string') throw new MsgError(400, en('That code did not work: it may be used, expired or replaced. Ask for a new one.'));
    pubKey(j.key);
    const linkId = clip(j.link, 64);
    if (this.#link(linkId)) throw new MsgError(409, en('Already linked.'));
    const cid = c.k === 'c' ? clip(j.community?.id, 64) : '';
    if (c.k === 'c' && !cid) throw new MsgError(400, en('That code did not work: it may be used, expired or replaced. Ask for a new one.'));
    this.#addLink({ id: linkId, peer_url: c.u, peer_key: j.key, peer_name: clip(j.name, MSG.nameChars) || '?', kind: c.k === 'c' ? 'member' : 'direct', community: cid || null }, keys.priv);
    const title = c.k === 'c' ? clip(j.community?.name, MSG.nameChars) || '?' : clip(j.name, MSG.nameChars) || '?';
    const id = c.k === 'c' ? cid : linkId;
    this.#db.prepare('DELETE FROM pm_chats WHERE id = ? AND status = ?').run(id, 'ended');
    this.#db.prepare('INSERT INTO pm_chats (id, kind, link_id, title, role, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, c.k === 'c' ? 'community' : 'direct', linkId, title, 'member', this.#iso(), this.#iso());
    this.onChange?.(id);
    return this.chat(id)!;
  }

  /** The other side of join(): checks the code and makes this side of the link. */
  #accept(b: Record<string, unknown>): Record<string, unknown> {
    const token = typeof b.token === 'string' ? b.token : '';
    const inv = this.#db.prepare('SELECT * FROM pm_invites WHERE hash = ?').get(sha(token)) as { kind: string; community: string | null; expires_at: string | null; used_at: string | null } | undefined;
    const bad = () => new MsgError(400, 'invalid code');
    if (!inv || inv.used_at || (inv.expires_at && inv.expires_at < this.#iso())) throw bad();
    const url = peerUrl(b.url);
    const key = String(b.key ?? '');
    pubKey(key);
    const name = clip(b.name, MSG.nameChars) || '?';
    const keys = this.#newKeys();
    const id = randomUUID();
    if (inv.kind === 'link') {
      this.#db.prepare('UPDATE pm_invites SET used_at = ? WHERE hash = ?').run(this.#iso(), sha(token));
      this.#addLink({ id, peer_url: url, peer_key: key, peer_name: name, kind: 'direct', community: null }, keys.priv);
      this.#db.prepare('INSERT INTO pm_chats (id, kind, link_id, title, role, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'direct', id, name, 'member', this.#iso(), this.#iso());
      this.onChange?.(id);
      return { v: 1, link: id, key: keys.pub, name: this.name() };
    }
    const cid = inv.community!;
    const chat = this.chat(cid);
    if (!chat || chat.role !== 'host' || chat.status !== 'active') throw bad();
    // The ban is the host's: a banned server's address can't come back with any code.
    if (this.#db.prepare('SELECT 1 FROM pm_bans WHERE community = ? AND url = ?').get(cid, url)) throw bad();
    if ((this.#db.prepare('SELECT COUNT(*) AS n FROM pm_members WHERE community = ?').get(cid) as { n: number }).n >= MSG.members) throw new MsgError(400, 'full');
    this.#addLink({ id, peer_url: url, peer_key: key, peer_name: name, kind: 'host', community: cid }, keys.priv);
    this.#db.prepare('INSERT INTO pm_members (community, id, name, role, url) VALUES (?, ?, ?, ?, ?)').run(cid, id, name, 'member', url);
    this.#roster(cid);
    this.onChange?.(cid);
    return { v: 1, link: id, key: keys.pub, name: this.name(), community: { id: cid, name: chat.title } };
  }

  /** Unlinks (one-to-one): the other side is told and drops its keys; ours go now. */
  async unlink(linkId: string, keepHistory: boolean): Promise<void> {
    const l = this.#link(linkId);
    if (!l) throw new MsgError(404, en('Not found'));
    if (l.kind !== 'direct') throw new MsgError(400, en('Leave the community instead.'));
    await this.#sendNow(l, { type: 'unlink' });
    this.#dropLink(linkId);
    this.#end(linkId, keepHistory);
  }
  #end(chatId: string, keep: boolean): void {
    if (keep) this.#db.prepare("UPDATE pm_chats SET status = 'ended' WHERE id = ?").run(chatId);
    else this.#removeChat(chatId);
    this.onChange?.(chatId);
  }
  #removeChat(chatId: string): void {
    for (const r of this.#db.prepare('SELECT id FROM pm_messages WHERE chat = ? AND file IS NOT NULL').all(chatId) as { id: string }[]) this.#dropFile(chatId, r.id);
    this.#db.prepare('DELETE FROM pm_messages WHERE chat = ?').run(chatId);
    this.#db.prepare('DELETE FROM pm_chats WHERE id = ?').run(chatId);
    this.#db.prepare('DELETE FROM pm_requests WHERE chat = ?').run(chatId);
  }

  /** Deletes a chat: an ended one's history; an active one-to-one is unlinked; a community is left (or closed by its host). */
  async removeChat(chatId: string): Promise<void> {
    const c = this.chat(chatId);
    if (!c) throw new MsgError(404, en('Not found'));
    if (c.status === 'ended') return void this.#end(chatId, false);
    if (c.kind === 'direct') return this.unlink(c.linkId!, false);
    return this.leave(chatId, false);
  }

  // ---- chats -------------------------------------------------------------------------------------
  chat(id: string): ChatRow | undefined {
    const r = this.#db.prepare('SELECT * FROM pm_chats WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? chatRow(r) : undefined;
  }
  chats(): (ChatRow & { unread: number; mentions: number; last: string })[] {
    const rows = this.#db.prepare('SELECT * FROM pm_chats ORDER BY COALESCE(last_at, created_at) DESC').all() as Record<string, unknown>[];
    const def = this.settings().communityNotify;
    return rows.map((r) => {
      const c = chatRow(r);
      const unread = (this.#db.prepare('SELECT COUNT(*) AS n FROM pm_messages WHERE chat = ? AND mine = 0 AND seen = 0 AND deleted = 0').get(c.id) as { n: number }).n;
      const mentions = c.kind === 'community' && (c.notify ?? def) !== 'none' ? (this.#db.prepare('SELECT COUNT(*) AS n FROM pm_messages WHERE chat = ? AND mine = 0 AND seen = 0 AND deleted = 0 AND mention = 1').get(c.id) as { n: number }).n : 0;
      const lastRow = this.#db.prepare('SELECT * FROM pm_messages WHERE chat = ? ORDER BY at DESC LIMIT 1').get(c.id) as Record<string, unknown> | undefined;
      const lv = lastRow ? this.#view(lastRow) : undefined;
      const last = lv ? (lv.deleted ? '' : lv.text ? clip(lv.text, 80) : lv.file ? `📎 ${lv.file.name}` : '') : '';
      const quiet = c.muted || c.blocked;
      return { ...c, unread: quiet ? 0 : unread, mentions: quiet ? 0 : mentions, last };
    });
  }
  /** T4: the sidebar badge: one-to-one unread plus community mentions (never plain community posts). */
  unread(): number {
    return this.counts().unread;
  }
  /** T4: `unread` = the badge; `community` = the quiet count inside Messages (communities not set to "nothing"). */
  counts(): { unread: number; community: number } {
    const def = this.settings().communityNotify;
    let unread = 0;
    let community = 0;
    for (const c of this.chats()) {
      if (c.kind === 'direct') unread += c.unread;
      else {
        unread += c.mentions;
        if ((c.notify ?? def) !== 'none') community += c.unread;
      }
    }
    return { unread, community };
  }
  patchChat(id: string, v: Record<string, unknown>): ChatRow {
    const c = this.chat(id);
    if (!c) throw new MsgError(404, en('Not found'));
    if (v.muted !== undefined) this.#db.prepare('UPDATE pm_chats SET muted = ? WHERE id = ?').run(v.muted ? 1 : 0, id);
    if (v.notify !== undefined && c.kind === 'community') this.#db.prepare('UPDATE pm_chats SET notify = ? WHERE id = ?').run(v.notify === null || v.notify === '' ? null : level(v.notify), id);
    if (v.blocked !== undefined && c.kind === 'direct') this.#db.prepare('UPDATE pm_chats SET blocked = ? WHERE id = ?').run(v.blocked ? 1 : 0, id);
    if (v.retentionDays !== undefined) this.#db.prepare('UPDATE pm_chats SET retention = ? WHERE id = ?').run(v.retentionDays === null || v.retentionDays === '' ? null : days(v.retentionDays), id);
    if (Array.isArray(v.hide) && c.kind === 'community') this.#db.prepare('UPDATE pm_chats SET hidden = ? WHERE id = ?').run(JSON.stringify(v.hide.map((x) => clip(x, 64)).slice(0, MSG.members)), id);
    this.onChange?.(id);
    return this.chat(id)!;
  }
  #hidden(chatId: string): string[] {
    const r = this.#db.prepare('SELECT hidden FROM pm_chats WHERE id = ?').get(chatId) as { hidden: string } | undefined;
    return r ? (JSON.parse(r.hidden) as string[]) : [];
  }
  members(chatId: string): { id: string; name: string; role: string }[] {
    const c = this.chat(chatId);
    if (!c || c.kind !== 'community') return [];
    if (c.role === 'host') return this.#db.prepare('SELECT id, name, role FROM pm_members WHERE community = ? ORDER BY name').all(chatId) as { id: string; name: string; role: string }[];
    return JSON.parse((this.#db.prepare('SELECT roster FROM pm_chats WHERE id = ?').get(chatId) as { roster: string }).roster) as { id: string; name: string; role: string }[];
  }
  /** My own id in a community's member list ('host' on the host). */
  me(chatId: string): string | null {
    const c = this.chat(chatId);
    if (c?.role === 'host') return 'host';
    return (this.#db.prepare('SELECT me FROM pm_chats WHERE id = ?').get(chatId) as { me: string | null } | undefined)?.me ?? null;
  }
  reports(chatId: string): { mid: string; by: string; why: string; at: string; text: string }[] {
    const c = this.chat(chatId);
    if (c?.role !== 'host') return [];
    const list = JSON.parse((this.#db.prepare('SELECT reports FROM pm_chats WHERE id = ?').get(chatId) as { reports: string }).reports) as { mid: string; by: string; why: string; at: string }[];
    return list.map((r) => ({ ...r, text: clip(this.messages(chatId).find((m) => m.id === r.mid)?.text, 200) }));
  }
  /** The community's current code, for its host and moderators. */
  inviteCode(chatId: string): string | null {
    const r = this.#db.prepare('SELECT invite FROM pm_chats WHERE id = ?').get(chatId) as { invite: string | null } | undefined;
    return r?.invite ? this.#vault.unseal(r.invite, `pm-invite:${chatId}`) : null;
  }
  typing(chatId: string): string[] {
    const m = this.#typing.get(chatId);
    if (!m) return [];
    const now = this.#now().getTime();
    return [...m].filter(([, until]) => until > now).map(([n]) => n);
  }
  requests(): { id: string; chat: string; fromName: string; at: string }[] {
    return (this.#db.prepare('SELECT id, chat, from_name, at FROM pm_requests ORDER BY at').all() as { id: string; chat: string; from_name: string; at: string }[]).map((r) => ({ id: r.id, chat: r.chat, fromName: r.from_name, at: r.at }));
  }

  // ---- messages ----------------------------------------------------------------------------------
  #view(r: Record<string, unknown>): MessageView {
    const chat = String(r.chat);
    const deleted = Boolean(r.deleted);
    const file = r.file && !deleted ? (JSON.parse(String(r.file)) as { name: string; type: string; size: number }) : null;
    return {
      id: String(r.id),
      text: deleted ? '' : this.#vault.unseal(String(r.body), `pm:${chat}`),
      mine: Boolean(r.mine),
      author: String(r.author),
      authorId: String(r.author_id),
      at: String(r.at),
      editedAt: (r.edited_at as string | null) ?? null,
      deleted,
      readAt: (r.read_at as string | null) ?? null,
      state: String(r.state) as MessageView['state'],
      file,
    };
  }
  messages(chatId: string, o: { before?: string; limit?: number } = {}): MessageView[] {
    const hidden = new Set(this.#hidden(chatId));
    const rows = this.#db.prepare('SELECT * FROM pm_messages WHERE chat = ? AND at < ? ORDER BY at DESC LIMIT ?').all(chatId, o.before ?? '9999', Math.min(o.limit ?? 200, 500)) as Record<string, unknown>[];
    return rows
      .reverse()
      .filter((r) => !hidden.has(String(r.author_id)))
      .map((r) => this.#view(r));
  }
  #store(chatId: string, m: { id: string; mine: boolean; author: string; authorId: string; text: string; file?: { name: string; type: string; bytes: Buffer } | null; at: string; state?: string }): boolean {
    if (this.#db.prepare('SELECT 1 FROM pm_messages WHERE chat = ? AND id = ?').get(chatId, m.id)) return false;
    const file = m.file ? JSON.stringify({ name: m.file.name, type: m.file.type, size: m.file.bytes.length }) : null;
    if (m.file) this.#putFile(chatId, m.id, m.file.bytes);
    this.#db
      .prepare('INSERT INTO pm_messages (id, chat, mine, author, author_id, body, file, at, state, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, chatId, m.mine ? 1 : 0, m.author, m.authorId, this.#vault.seal(m.text, `pm:${chatId}`), file, m.at, m.state ?? 'sent', m.mine ? 1 : 0);
    this.#db.prepare('UPDATE pm_chats SET last_at = ? WHERE id = ?').run(this.#iso(), chatId);
    return true;
  }
  #filePath(chatId: string, mid: string): string {
    return join(this.#files, `${sha(`${chatId}/${mid}`).slice(0, 40)}.bin`);
  }
  #putFile(chatId: string, mid: string, bytes: Buffer): void {
    mkdirSync(this.#files, { recursive: true, mode: 0o700 });
    writeFileSync(this.#filePath(chatId, mid), this.#vault.seal(bytes.toString('base64'), `pm-file:${chatId}/${mid}`), { mode: 0o600 });
  }
  #dropFile(chatId: string, mid: string): void {
    rmSync(this.#filePath(chatId, mid), { force: true });
  }
  file(chatId: string, mid: string): { name: string; type: string; bytes: Buffer } | undefined {
    const m = this.messages(chatId, { limit: 500 }).find((x) => x.id === mid);
    const p = this.#filePath(chatId, mid);
    if (!m?.file || !existsSync(p)) return undefined;
    return { name: m.file.name, type: m.file.type, bytes: Buffer.from(this.#vault.unseal(readFileSync(p, 'utf8'), `pm-file:${chatId}/${mid}`), 'base64') };
  }

  /** The owner sends a message (text and/or one file) to a chat. */
  send(chatId: string, body: { text?: unknown; file?: FileIn | null }): MessageView {
    const c = this.#active(chatId);
    const text = String(body.text ?? '').trim().slice(0, MSG.textChars);
    const file = body.file ? fileFrom(body.file) : null;
    if (!text && !file) throw new MsgError(400, en('Write something first.'));
    const mid = randomUUID();
    const at = this.#iso();
    const wire = { mid, text, at, ...(file ? { file: { name: file.name, data: file.bytes.toString('base64') } } : {}) };
    if (c.kind === 'direct') {
      this.#store(chatId, { id: mid, mine: true, author: this.name(), authorId: 'me', text, file, at, state: 'queued' });
      this.#enqueue(c.linkId!, { type: 'dm', ...wire }, { chat: chatId, mid });
    } else if (c.role === 'host') {
      this.#store(chatId, { id: mid, mine: true, author: this.name(), authorId: 'host', text, file, at, state: 'sent' });
      this.#fanout(chatId, { type: 'c.msg', ...wire, author: this.name(), authorId: 'host' });
    } else {
      this.#store(chatId, { id: mid, mine: true, author: this.name(), authorId: 'me', text, file, at, state: 'queued' });
      this.#enqueue(c.linkId!, { type: 'c.post', ...wire }, { chat: chatId, mid });
    }
    this.#kick();
    return this.messages(chatId).find((m) => m.id === mid)!;
  }
  #active(chatId: string): ChatRow {
    const c = this.chat(chatId);
    if (!c) throw new MsgError(404, en('Not found'));
    if (c.status !== 'active') throw new MsgError(409, en('This chat has ended.'));
    return c;
  }
  #mine(chatId: string, mid: string): Record<string, unknown> {
    const r = this.#db.prepare('SELECT * FROM pm_messages WHERE chat = ? AND id = ?').get(chatId, mid) as Record<string, unknown> | undefined;
    if (!r) throw new MsgError(404, en('Not found'));
    if (!r.mine) throw new MsgError(403, en('You can only change your own messages.'));
    return r;
  }
  edit(chatId: string, mid: string, text: unknown): MessageView {
    const c = this.#active(chatId);
    this.#mine(chatId, mid);
    const t = String(text ?? '').trim().slice(0, MSG.textChars);
    if (!t) throw new MsgError(400, en('Write something first.'));
    this.#db.prepare('UPDATE pm_messages SET body = ?, edited_at = ? WHERE chat = ? AND id = ?').run(this.#vault.seal(t, `pm:${chatId}`), this.#iso(), chatId, mid);
    this.#relay(c, { type: c.kind === 'direct' ? 'edit' : 'c.edit', mid, text: t });
    return this.messages(chatId).find((m) => m.id === mid)!;
  }
  remove(chatId: string, mid: string): void {
    const c = this.#active(chatId);
    this.#mine(chatId, mid);
    this.#delete(chatId, mid);
    this.#relay(c, { type: c.kind === 'direct' ? 'del' : 'c.del', mid });
  }
  #delete(chatId: string, mid: string): void {
    this.#dropFile(chatId, mid);
    this.#db.prepare('UPDATE pm_messages SET deleted = 1, body = ?, file = NULL WHERE chat = ? AND id = ?').run(this.#vault.seal('', `pm:${chatId}`), chatId, mid);
  }
  /** Sends a change of my own message: to the peer, to the host, or (as host) to every member. */
  #relay(c: ChatRow, ev: Ev): void {
    if (c.kind === 'community' && c.role === 'host') this.#fanout(c.id, { ...ev, authorId: 'host' });
    else this.#enqueue(c.linkId!, ev, {});
    this.#kick();
  }
  /** The owner opened the chat: unread clears, and a read receipt goes out (one-to-one, when on). */
  markRead(chatId: string): void {
    const c = this.chat(chatId);
    if (!c) throw new MsgError(404, en('Not found'));
    const last = this.#db.prepare('SELECT MAX(at) AS at FROM pm_messages WHERE chat = ? AND mine = 0 AND seen = 0').get(chatId) as { at: string | null };
    this.#db.prepare('UPDATE pm_messages SET seen = 1 WHERE chat = ? AND mine = 0').run(chatId);
    if (last.at && c.kind === 'direct' && c.status === 'active' && !c.blocked && this.settings().receipts) {
      this.#enqueue(c.linkId!, { type: 'read', upto: last.at }, { once: true });
      this.#kick();
    }
  }
  typingNow(chatId: string): void {
    const c = this.#active(chatId);
    if (!this.settings().typing || c.blocked) return;
    if (c.kind === 'community' && c.role === 'host') this.#fanout(chatId, { type: 'c.typing', name: this.name() }, { once: true });
    else this.#enqueue(c.linkId!, { type: c.kind === 'direct' ? 'typing' : 'c.typing' }, { once: true });
    this.#kick();
  }
  report(chatId: string, mid: string, why: unknown): void {
    const c = this.#active(chatId);
    if (c.kind !== 'community' || c.role === 'host') throw new MsgError(400, en('Reports go to the community’s creator.'));
    this.#enqueue(c.linkId!, { type: 'c.report', mid, why: clip(why, 300) }, {});
    this.#kick();
  }

  // ---- communities -------------------------------------------------------------------------------
  createCommunity(name: unknown, fallbackUrl?: string): ChatRow {
    const title = clip(name, MSG.nameChars);
    if (!title) throw new MsgError(400, en('Give the community a name.'));
    const id = randomUUID();
    this.#db.prepare('INSERT INTO pm_chats (id, kind, link_id, title, role, created_at, last_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(id, 'community', title, 'host', this.#iso(), this.#iso());
    this.#db.prepare('INSERT INTO pm_members (community, id, name, role, url) VALUES (?, ?, ?, ?, NULL)').run(id, 'host', this.name(), 'host');
    if (fallbackUrl || this.settings().url) this.rotateCode(id, fallbackUrl);
    this.onChange?.(id);
    return this.chat(id)!;
  }
  /** A new community code (the old one stops working for newcomers). Host only; a moderator asks the host. */
  rotateCode(chatId: string, fallbackUrl?: string): { code: string | null; pending?: boolean } {
    const c = this.#active(chatId);
    if (c.kind !== 'community') throw new MsgError(400, en('Not a community.'));
    if (c.role === 'mod') {
      this.#enqueue(c.linkId!, { type: 'c.mod', action: 'code' }, {});
      this.#kick();
      return { code: null, pending: true };
    }
    if (c.role !== 'host') throw new MsgError(403, en('Only the creator and moderators can do that.'));
    const token = randomBytes(24).toString('base64url');
    this.#db.prepare('DELETE FROM pm_invites WHERE community = ?').run(chatId);
    this.#db.prepare('INSERT INTO pm_invites (hash, kind, community, expires_at) VALUES (?, ?, ?, NULL)').run(sha(token), 'community', chatId);
    const code = encodeCode({ u: this.#myUrl(fallbackUrl), t: token, k: 'c' });
    this.#db.prepare('UPDATE pm_chats SET invite = ? WHERE id = ?').run(this.#vault.seal(code, `pm-invite:${chatId}`), chatId);
    return { code };
  }
  /** kick | ban | mod | unmod a member (host directly; a moderator's kick/ban goes to the host, who checks it). */
  async moderate(chatId: string, memberId: string, action: unknown): Promise<void> {
    const c = this.#active(chatId);
    const a = String(action);
    if (!['kick', 'ban', 'mod', 'unmod'].includes(a)) throw new MsgError(400, en('Unknown action.'));
    if (c.kind !== 'community') throw new MsgError(400, en('Not a community.'));
    if (c.role === 'mod' && (a === 'kick' || a === 'ban')) {
      this.#enqueue(c.linkId!, { type: 'c.mod', action: a, member: memberId }, {});
      return this.#kick();
    }
    if (c.role !== 'host') throw new MsgError(403, en('Only the creator and moderators can do that.'));
    await this.#hostModerate(chatId, memberId, a, 'host');
  }
  async #hostModerate(cid: string, memberId: string, action: string, by: string): Promise<void> {
    const target = this.#db.prepare('SELECT * FROM pm_members WHERE community = ? AND id = ?').get(cid, memberId) as { id: string; role: string; url: string | null } | undefined;
    if (!target || target.role === 'host') throw new MsgError(404, en('Not found'));
    // A moderator can't remove the host or another moderator.
    if (by !== 'host' && target.role !== 'member') throw new MsgError(403, en('Only the creator and moderators can do that.'));
    if (action === 'mod' || action === 'unmod') {
      this.#db.prepare('UPDATE pm_members SET role = ? WHERE community = ? AND id = ?').run(action === 'mod' ? 'mod' : 'member', cid, memberId);
    } else {
      if (action === 'ban' && target.url) this.#db.prepare('INSERT OR IGNORE INTO pm_bans (community, url) VALUES (?, ?)').run(cid, target.url);
      const l = this.#link(memberId);
      if (l) await this.#sendNow(l, { type: 'c.removed', banned: action === 'ban' });
      this.#db.prepare('DELETE FROM pm_members WHERE community = ? AND id = ?').run(cid, memberId);
      this.#dropLink(memberId);
    }
    this.#roster(cid);
    this.onChange?.(cid);
    this.#kick();
  }
  /** Leave a community (a member) or close it (its host: every member is told). */
  async leave(chatId: string, keepHistory: boolean): Promise<void> {
    const c = this.chat(chatId);
    if (!c || c.kind !== 'community') throw new MsgError(404, en('Not found'));
    if (c.role === 'host') {
      for (const m of this.#db.prepare("SELECT id FROM pm_members WHERE community = ? AND id != 'host'").all(chatId) as { id: string }[]) {
        const l = this.#link(m.id);
        if (l) await this.#sendNow(l, { type: 'c.closed' });
        this.#dropLink(m.id);
      }
      this.#db.prepare('DELETE FROM pm_members WHERE community = ?').run(chatId);
      this.#db.prepare('DELETE FROM pm_invites WHERE community = ?').run(chatId);
      this.#db.prepare('DELETE FROM pm_bans WHERE community = ?').run(chatId);
    } else if (c.linkId) {
      const l = this.#link(c.linkId);
      if (l) await this.#sendNow(l, { type: 'c.leave' });
      this.#dropLink(c.linkId);
    }
    this.#end(chatId, keepHistory);
  }
  /** Ask a community member for a private chat: a one-time link code goes to them through the host. */
  intro(chatId: string, memberId: string, fallbackUrl?: string): void {
    const c = this.#active(chatId);
    if (c.kind !== 'community') throw new MsgError(400, en('Not a community.'));
    const { code } = this.invite(fallbackUrl);
    if (c.role === 'host') {
      const l = this.#link(memberId);
      if (!l) throw new MsgError(404, en('Not found'));
      this.#enqueue(l.id, { type: 'c.intro', fromName: this.name(), code }, {});
    } else this.#enqueue(c.linkId!, { type: 'c.intro', member: memberId, code }, {});
    this.#kick();
  }
  async answerRequest(id: string, accept: boolean, fallbackUrl?: string): Promise<ChatRow | null> {
    const r = this.#db.prepare('SELECT * FROM pm_requests WHERE id = ?').get(id) as { code: string; chat: string } | undefined;
    if (!r) throw new MsgError(404, en('Not found'));
    this.#db.prepare('DELETE FROM pm_requests WHERE id = ?').run(id);
    if (!accept) return null;
    return this.join(this.#vault.unseal(r.code, `pm-req:${id}`), fallbackUrl);
  }
  #roster(cid: string): void {
    const members = this.#db.prepare('SELECT id, name, role FROM pm_members WHERE community = ? ORDER BY name').all(cid) as { id: string; name: string; role: string }[];
    for (const m of members) if (m.id !== 'host') this.#enqueue(m.id, { type: 'c.roster', members, you: m.id }, {});
  }
  #fanout(cid: string, ev: Ev, o: { except?: string; once?: boolean } = {}): void {
    for (const m of this.#db.prepare("SELECT id FROM pm_members WHERE community = ? AND id != 'host'").all(cid) as { id: string }[]) if (m.id !== o.except) this.#enqueue(m.id, ev, { once: o.once });
  }

  // ---- delivery ----------------------------------------------------------------------------------
  #enqueue(linkId: string, ev: Ev, o: { chat?: string; mid?: string; once?: boolean }): void {
    const body = JSON.stringify({ v: 1, id: randomUUID(), at: this.#iso(), ...ev });
    this.#db.prepare('INSERT INTO pm_outbox (link_id, chat, mid, body, once, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(linkId, o.chat ?? null, o.mid ?? null, this.#vault.seal(body, 'pm-out'), o.once ? 1 : 0, this.#iso(), this.#iso());
  }
  outboxSize(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM pm_outbox').get() as { n: number }).n;
  }
  #kick(): void {
    void this.flush().catch(() => undefined);
  }
  async #post(l: LinkRow, body: string): Promise<number> {
    const key = this.privateKeyFor(l.id);
    if (!key) return 410;
    try {
      const res = await this.#fetch(`${l.peer_url}/msg/v1/inbox`, { method: 'POST', headers: { 'content-type': 'application/json', ...signEnvelope(l.id, body, key, this.#now()) }, body, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      await res.arrayBuffer().catch(() => undefined);
      return res.status;
    } catch {
      return 0;
    }
  }
  /** Best effort, right now (unlink, leave, removed): the keys go right after. */
  async #sendNow(l: LinkRow, ev: Ev): Promise<void> {
    await this.#post(l, JSON.stringify({ v: 1, id: randomUUID(), at: this.#iso(), ...ev }));
  }
  /** Sends what is due, in order per link; a link that fails waits (back-off) with everything after it. */
  async flush(): Promise<void> {
    while (this.#flushing) await this.#flushing;
    if (this.#closed) return;
    this.#flushing = this.#pass().finally(() => (this.#flushing = undefined));
    return this.#flushing;
  }
  async #pass(): Promise<void> {
    for (let round = 0; round < 5 && !this.#closed; round++) {
      const rows = this.#db.prepare('SELECT * FROM pm_outbox WHERE next_at <= ? ORDER BY n').all(this.#iso()) as { n: number; link_id: string; chat: string | null; mid: string | null; body: string; once: number; tries: number; created_at: string }[];
      if (!rows.length) return;
      const stuck = new Set<string>();
      await Promise.all(
        [...new Set(rows.map((r) => r.link_id))].map(async (linkId) => {
          for (const r of rows.filter((x) => x.link_id === linkId)) {
            if (this.#closed || stuck.has(linkId)) return;
            const l = this.#link(linkId);
            const status = l ? await this.#post(l, this.#vault.unseal(r.body, 'pm-out')) : 410;
            if (this.#closed) return;
            if ((status >= 200 && status < 300) || status === 409 || status === 410 || r.once) {
              this.#db.prepare('DELETE FROM pm_outbox WHERE n = ?').run(r.n);
              if (r.mid && r.chat) this.#db.prepare('UPDATE pm_messages SET state = ? WHERE chat = ? AND id = ?').run(status >= 200 && status < 300 ? 'sent' : 'failed', r.chat, r.mid);
              if (r.mid && r.chat) this.onChange?.(r.chat);
              continue;
            }
            stuck.add(linkId);
            const now = this.#now().getTime();
            if (now - Date.parse(r.created_at) > MSG.giveUpMs) {
              this.#db.prepare('DELETE FROM pm_outbox WHERE n = ?').run(r.n);
              if (r.mid && r.chat) this.#db.prepare("UPDATE pm_messages SET state = 'failed' WHERE chat = ? AND id = ?").run(r.chat, r.mid);
            } else this.#db.prepare('UPDATE pm_outbox SET tries = tries + 1, next_at = ? WHERE n = ?').run(new Date(now + RETRY[Math.min(r.tries, RETRY.length - 1)]).toISOString(), r.n);
          }
        }),
      );
    }
  }

  /** The reminder tick: retries, retention, old replay ids and codes. */
  async due(now: Date): Promise<void> {
    if (this.#closed) return;
    const iso = now.toISOString();
    const def = this.settings().retentionDays;
    for (const c of this.#db.prepare('SELECT id, retention FROM pm_chats').all() as { id: string; retention: number | null }[]) {
      const d = c.retention ?? def;
      if (!d) continue;
      const cut = new Date(now.getTime() - d * 86_400_000).toISOString();
      const old = this.#db.prepare('SELECT id FROM pm_messages WHERE chat = ? AND at < ?').all(c.id, cut) as { id: string }[];
      for (const m of old) this.#dropFile(c.id, m.id);
      if (old.length) this.#db.prepare('DELETE FROM pm_messages WHERE chat = ? AND at < ?').run(c.id, cut);
    }
    this.#db.prepare('DELETE FROM pm_seen WHERE at < ?').run(new Date(now.getTime() - 86_400_000).toISOString());
    this.#db.prepare('DELETE FROM pm_invites WHERE expires_at IS NOT NULL AND expires_at < ?').run(iso);
    await this.flush();
  }

  // ---- the peer endpoint (/msg/v1/…) -------------------------------------------------------------
  async handlePeer(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return reply(405, { error: 'method' });
    let raw: Buffer;
    try {
      raw = await readBody(req, path === '/msg/v1/link' ? 64 * 1024 : MSG.bodyBytes);
    } catch {
      return reply(413, { error: 'too big' });
    }
    try {
      if (path === '/msg/v1/link') {
        const out = this.#accept(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
        // A community's roster goes out once the joiner has stored its side of the link.
        setTimeout(() => this.#kick(), 1_500).unref();
        return reply(200, out);
      }
      if (path !== '/msg/v1/inbox') return reply(404, { error: 'not found' });
      const body = raw.toString('utf8');
      const linkId = String(req.headers['sara-msg-link'] ?? '');
      const time = String(req.headers['sara-msg-time'] ?? '');
      const sig = String(req.headers['sara-msg-sig'] ?? '');
      const l = this.#link(linkId);
      const t = Date.parse(time);
      if (!l || !Number.isFinite(t) || Math.abs(t - this.#now().getTime()) > MSG.skewMs) return reply(401, { error: 'unsigned' });
      let ok = false;
      try {
        ok = verify(null, Buffer.from(`${linkId}\n${time}\n${sha(body)}`), pubKey(l.peer_key), Buffer.from(sig, 'base64'));
      } catch {
        ok = false;
      }
      if (!ok) return reply(401, { error: 'unsigned' });
      const minute = Math.floor(this.#now().getTime() / 60_000);
      const r = this.#rate.get(linkId);
      if (r && r.min === minute && r.n >= MSG.perMinute) return reply(429, { error: 'slow down' });
      this.#rate.set(linkId, r && r.min === minute ? { min: minute, n: r.n + 1 } : { min: minute, n: 1 });
      const ev = JSON.parse(body) as Ev & { id?: unknown };
      if (typeof ev.id !== 'string' || typeof ev.type !== 'string') return reply(400, { error: 'bad event' });
      const seenId = sha(`${linkId}/${ev.id}`);
      if (this.#db.prepare('SELECT 1 FROM pm_seen WHERE id = ?').get(seenId)) return reply(409, { error: 'replay' });
      this.#db.prepare('INSERT INTO pm_seen (id, at) VALUES (?, ?)').run(seenId, this.#iso());
      await this.#receive(l, ev);
      return reply(200, { ok: true });
    } catch (err) {
      return reply(err instanceof MsgError ? err.status : 400, { error: err instanceof MsgError ? err.message : 'bad request' });
    }
  }

  async #receive(l: LinkRow, ev: Ev): Promise<void> {
    const s = (k: string, n = 64) => clip(ev[k], n);
    if (['dm', 'edit', 'del', 'c.post', 'c.edit', 'c.del', 'c.msg', 'c.report'].includes(ev.type) && !s('mid')) throw new MsgError(400, 'bad event');
    const text = () => String(ev.text ?? '').slice(0, MSG.textChars);
    const file = () => (ev.file && typeof ev.file === 'object' ? fileFrom(ev.file as FileIn) : null);
    const at = () => (typeof ev.at === 'string' && Number.isFinite(Date.parse(ev.at)) ? new Date(Math.min(Date.parse(ev.at), this.#now().getTime())).toISOString() : this.#iso());
    if (l.kind === 'direct') {
      const chatId = l.id;
      const c = this.chat(chatId);
      if (!c) return;
      if (ev.type === 'unlink') {
        this.#dropLink(l.id);
        return this.#end(chatId, true);
      }
      if (c.blocked) return;
      if (ev.type === 'dm') {
        if (this.#store(chatId, { id: s('mid'), mine: false, author: l.peer_name, authorId: 'peer', text: text(), file: file(), at: at() })) this.#arrived(c, l.peer_name, text() || '📎', s('mid'));
      } else if (ev.type === 'edit') this.#applyEdit(chatId, s('mid'), 'peer', text());
      else if (ev.type === 'del') this.#applyDel(chatId, s('mid'), 'peer');
      else if (ev.type === 'read' && typeof ev.upto === 'string') {
        this.#db.prepare('UPDATE pm_messages SET read_at = ? WHERE chat = ? AND mine = 1 AND read_at IS NULL AND at <= ?').run(this.#iso(), chatId, ev.upto);
        this.onChange?.(chatId);
      } else if (ev.type === 'typing') this.#setTyping(chatId, l.peer_name);
      return;
    }
    if (l.kind === 'host') {
      // I host this community; the sender is a member.
      const cid = l.community!;
      const c = this.chat(cid);
      const me = this.#db.prepare('SELECT * FROM pm_members WHERE community = ? AND id = ?').get(cid, l.id) as { name: string; role: string } | undefined;
      if (!c || !me) throw new MsgError(403, 'not a member');
      if (ev.type === 'c.post') {
        const mid = s('mid');
        const f = file();
        if (this.#store(cid, { id: mid, mine: false, author: me.name, authorId: l.id, text: text(), file: f, at: at() })) {
          this.#fanout(cid, { type: 'c.msg', mid, text: text(), at: at(), author: me.name, authorId: l.id, ...(f ? { file: { name: f.name, data: f.bytes.toString('base64') } } : {}) }, { except: l.id });
          this.#arrived(c, me.name, text() || '📎', mid);
        }
      } else if (ev.type === 'c.edit') {
        if (this.#applyEdit(cid, s('mid'), l.id, text())) this.#fanout(cid, { type: 'c.edit', mid: s('mid'), text: text(), authorId: l.id }, { except: l.id });
      } else if (ev.type === 'c.del') {
        if (this.#applyDel(cid, s('mid'), l.id)) this.#fanout(cid, { type: 'c.del', mid: s('mid'), authorId: l.id }, { except: l.id });
      } else if (ev.type === 'c.typing') {
        this.#setTyping(cid, me.name);
        this.#fanout(cid, { type: 'c.typing', name: me.name }, { except: l.id, once: true });
      } else if (ev.type === 'c.leave') {
        this.#db.prepare('DELETE FROM pm_members WHERE community = ? AND id = ?').run(cid, l.id);
        this.#dropLink(l.id);
        this.#roster(cid);
        this.onChange?.(cid);
      } else if (ev.type === 'c.report') {
        const list = JSON.parse((this.#db.prepare('SELECT reports FROM pm_chats WHERE id = ?').get(cid) as { reports: string }).reports) as unknown[];
        list.push({ mid: s('mid'), by: me.name, why: s('why', 300), at: this.#iso() });
        this.#db.prepare('UPDATE pm_chats SET reports = ? WHERE id = ?').run(JSON.stringify(list.slice(-100)), cid);
        this.onNotify?.(c.title, en('A message was reported to you.'), cid);
        this.onChange?.(cid);
      } else if (ev.type === 'c.mod') {
        if (me.role !== 'mod') throw new MsgError(403, 'not a moderator');
        if (ev.action === 'code') {
          const { code } = this.rotateCode(cid);
          this.#enqueue(l.id, { type: 'c.code', code }, {});
        } else if (ev.action === 'kick' || ev.action === 'ban') await this.#hostModerate(cid, s('member'), String(ev.action), l.id);
      } else if (ev.type === 'c.intro') {
        const target = s('member');
        if (target === 'host') this.#request(cid, me.name, String(ev.code ?? ''));
        else if (this.#db.prepare('SELECT 1 FROM pm_members WHERE community = ? AND id = ?').get(cid, target)) this.#enqueue(target, { type: 'c.intro', fromName: me.name, code: String(ev.code ?? '') }, {});
      }
      this.#kick();
      return;
    }
    // I am a member; the sender is the community's host.
    const cid = l.community!;
    const c = this.chat(cid);
    if (!c) return;
    if (ev.type === 'c.msg') {
      const author = s('author', MSG.nameChars) || '?';
      if (this.#store(cid, { id: s('mid'), mine: false, author, authorId: s('authorId'), text: text(), file: file(), at: at() }) && !this.#hidden(cid).includes(s('authorId'))) this.#arrived(c, `${author} · ${c.title}`, text() || '📎', s('mid'));
    } else if (ev.type === 'c.edit') this.#applyEdit(cid, s('mid'), s('authorId'), text());
    else if (ev.type === 'c.del') this.#applyDel(cid, s('mid'), s('authorId'));
    else if (ev.type === 'c.typing') this.#setTyping(cid, s('name', MSG.nameChars));
    else if (ev.type === 'c.roster' && Array.isArray(ev.members)) {
      const members = (ev.members as Record<string, unknown>[]).slice(0, MSG.members + 1).map((m) => ({ id: clip(m.id, 64), name: clip(m.name, MSG.nameChars), role: ['host', 'mod', 'member'].includes(String(m.role)) ? String(m.role) : 'member' }));
      const mine = members.find((m) => m.id === s('you'));
      this.#db.prepare('UPDATE pm_chats SET roster = ?, role = ?, me = ? WHERE id = ?').run(JSON.stringify(members), mine?.role === 'mod' ? 'mod' : 'member', s('you'), cid);
      this.onChange?.(cid);
    } else if (ev.type === 'c.code' && typeof ev.code === 'string') {
      this.#db.prepare('UPDATE pm_chats SET invite = ? WHERE id = ?').run(this.#vault.seal(ev.code, `pm-invite:${cid}`), cid);
      this.onChange?.(cid);
    } else if (ev.type === 'c.intro') this.#request(cid, s('fromName', MSG.nameChars), String(ev.code ?? ''));
    else if (ev.type === 'c.removed' || ev.type === 'c.closed') {
      this.#dropLink(l.id);
      this.#end(cid, true);
    }
  }
  #request(chatId: string, fromName: string, code: string): void {
    decodeCode(code);
    const id = randomUUID();
    this.#db.prepare('INSERT INTO pm_requests (id, chat, from_name, code, at) VALUES (?, ?, ?, ?, ?)').run(id, chatId, fromName || '?', this.#vault.seal(code, `pm-req:${id}`), this.#iso());
    this.onNotify?.(fromName, en('Wants to chat with you privately.'), chatId);
    this.onChange?.(chatId);
  }
  #applyEdit(chatId: string, mid: string, authorId: string, text: string): boolean {
    if (!text) return false;
    const r = this.#db.prepare('UPDATE pm_messages SET body = ?, edited_at = ? WHERE chat = ? AND id = ? AND author_id = ? AND mine = 0 AND deleted = 0').run(this.#vault.seal(text, `pm:${chatId}`), this.#iso(), chatId, mid, authorId);
    this.onChange?.(chatId);
    return Number(r.changes) > 0;
  }
  #applyDel(chatId: string, mid: string, authorId: string): boolean {
    const r = this.#db.prepare('SELECT 1 FROM pm_messages WHERE chat = ? AND id = ? AND author_id = ? AND mine = 0').get(chatId, mid, authorId);
    if (!r) return false;
    this.#delete(chatId, mid);
    this.onChange?.(chatId);
    return true;
  }
  #setTyping(chatId: string, name: string): void {
    const m = this.#typing.get(chatId) ?? new Map<string, number>();
    m.set(name, this.#now().getTime() + MSG.typingMs);
    this.#typing.set(chatId, m);
    this.onChange?.(chatId);
  }
  #arrived(c: ChatRow, from: string, text: string, mid: string): void {
    this.#typing.get(c.id)?.delete(from);
    // T4: a community @mention of the owner is stored (the badge counts it) and notifies like a one-to-one message.
    const mention = c.kind === 'community' && isMention(text, this.name());
    if (mention) this.#db.prepare('UPDATE pm_messages SET mention = 1 WHERE chat = ? AND id = ?').run(c.id, mid);
    this.onChange?.(c.id);
    const route = notifyRoute({ kind: c.kind, muted: c.muted, blocked: c.blocked, level: c.notify ?? this.settings().communityNotify, mention });
    if (route === 'full') this.onNotify?.(from, text, c.id, { kind: c.kind, mention });
  }
}

function chatRow(r: Record<string, unknown>): ChatRow {
  return {
    id: String(r.id),
    kind: String(r.kind) as ChatRow['kind'],
    title: String(r.title),
    linkId: (r.link_id as string | null) ?? null,
    role: String(r.role) as ChatRow['role'],
    status: String(r.status) as ChatRow['status'],
    muted: Boolean(r.muted),
    blocked: Boolean(r.blocked),
    retentionDays: (r.retention as number | null) ?? null,
    notify: NOTIFY_LEVELS.includes(r.notify as NotifyLevel) ? (r.notify as NotifyLevel) : null,
    lastAt: (r.last_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}
function level(v: unknown): NotifyLevel {
  if (!NOTIFY_LEVELS.includes(v as NotifyLevel)) throw new MsgError(400, en('Pick everything, mentions or nothing.'));
  return v as NotifyLevel;
}
function days(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw new MsgError(400, en('Keep messages for 1 to 3650 days, or 0 for always.'));
  return n;
}
function pubKey(b64: string): KeyObject {
  try {
    const k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (k.asymmetricKeyType === 'ed25519') return k;
  } catch {
    /* below */
  }
  throw new MsgError(400, 'bad key');
}
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        fail(new Error('too big'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}
