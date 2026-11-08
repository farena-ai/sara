// EC11 (docs/ops/EC1115_DESIGN.md): share a conversation as a read-only, expiring, revocable link.
// A link is a frozen, scrubbed snapshot of what the owner approved in the preview: it can never
// show more, can't be written to, and needs no lookup into a companion's or member's database.
// Only the SHA-256 of the 256-bit token is stored. Revoking deletes the snapshot at once.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Redactor } from './redact.ts';
import { importedName, type Conversation, type StoredMessage } from './store.ts';

export const SHARE_EXPIRY = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type ShareExpiry = keyof typeof SHARE_EXPIRY;
export const DEFAULT_EXPIRY: ShareExpiry = '7d';
export const MAX_SHARE_PICTURES = 12;
const TOOL_TEXT_MAX = 2000;

export interface ShareOptions {
  /** Include tool results (scrubbed, cut to 2,000 characters). */
  tools: boolean;
  /** Include the pictures sent in the chat (copied into the share). */
  pictures: boolean;
}
export interface ShareMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
  /** Tool results: the tool's name. */
  name?: string;
  /** Picture numbers in this share (only when pictures were chosen). */
  pics?: number[];
}
export interface ShareSnapshot {
  title: string;
  companion: string;
  messages: ShareMessage[];
  /** What was left out or hidden (shown in the preview). */
  hidden: { tools: number; pictures: number; scrubbed: number };
}
export interface SharePicture {
  mime: string;
  data: Buffer;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A run of digits with phone punctuation; it counts as a phone number only with 9 to 15 digits
// (so dates, times, prices and short numbers stay).
const PHONE = /(?<![\w$])\+?\(?\d[\d ().-]{6,}\d(?![\w%])/g;
const marks = (s: string) => (s.match(/\[REDACTED|\[email\]|\[phone\]/g) ?? []).length;

/** The server's scrubber plus the share-only rules (e-mail addresses, phone numbers). */
export function scrubForShare(text: string, redactor: Pick<Redactor, 'redact'>): { text: string; n: number } {
  const before = marks(text);
  let out = redactor.redact(String(text ?? ''));
  out = out.replace(EMAIL, '[email]');
  out = out.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits >= 9 && digits <= 15 && /[\s().+-]/.test(m) ? '[phone]' : m;
  });
  return { text: out, n: Math.max(0, marks(out) - before) };
}

/** Why this conversation can't be shared, in plain words (undefined = it can). */
export function shareRefusal(c: Conversation, o: { offRecord?: boolean; privateLocal?: boolean; allowPrivate?: boolean }): string | undefined {
  if (o.offRecord) return 'Off-the-record chats are never shared.';
  if (c.partner) return 'Chats with someone else are never shared.';
  if (c.channel.endsWith('-nsfw')) return 'Adult chats are never shared.';
  if (c.channel.startsWith('group')) return 'Group chats are never shared.';
  if (importedName(c.channel)) return 'Imported chats are never shared.';
  if (c.private && !o.allowPrivate) return 'This chat is private. Allow sharing private chats first (Settings → Household → Shared links).';
  if (o.privateLocal && !o.allowPrivate) return 'Private local mode is on: nothing leaves this computer. Allow sharing private chats first.';
  return undefined;
}

const imagesOf = (m: StoredMessage): string[] => (Array.isArray(m.meta?.images) ? (m.meta!.images as unknown[]).map(String) : []);

/** Builds what a link shows (the preview is exactly this). */
export function buildSnapshot(
  conv: Conversation,
  messages: readonly StoredMessage[],
  opts: ShareOptions,
  deps: { redact: Pick<Redactor, 'redact'>; companion: string; picture?: (id: string) => { mime: string; data: string } | undefined },
): { snapshot: ShareSnapshot; pictures: SharePicture[] } {
  const hidden = { tools: 0, pictures: 0, scrubbed: 0 };
  const scrub = (s: string) => {
    const r = scrubForShare(s, deps.redact);
    hidden.scrubbed += r.n;
    return r.text;
  };
  const pictures: SharePicture[] = [];
  const out: ShareMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!opts.tools) {
        hidden.tools++;
        continue;
      }
      let text = scrub(m.content);
      if (text.length > TOOL_TEXT_MAX) text = text.slice(0, TOOL_TEXT_MAX) + '…';
      out.push({ role: 'tool', text, at: m.createdAt, name: String(m.meta?.name ?? 'tool').slice(0, 60) });
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue; // notices and system rows never
    const ids = imagesOf(m);
    const pics: number[] = [];
    for (const id of ids) {
      if (!opts.pictures || pictures.length >= MAX_SHARE_PICTURES) {
        hidden.pictures++;
        continue;
      }
      const p = deps.picture?.(id);
      if (!p || !/^image\/(png|jpeg|webp|gif)$/.test(p.mime)) {
        hidden.pictures++;
        continue;
      }
      pics.push(pictures.length);
      pictures.push({ mime: p.mime, data: Buffer.from(p.data, 'base64') });
    }
    const text = m.content ? scrub(m.content) : '';
    if (!text.trim() && !pics.length) continue;
    out.push({ role: m.role, text, at: m.createdAt, ...(pics.length ? { pics } : {}) });
  }
  return { snapshot: { title: scrub(conv.title).slice(0, 200), companion: deps.companion.slice(0, 60), messages: out, hidden }, pictures };
}

export interface ShareRow {
  id: string;
  space: string;
  companion: string;
  conversationId: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  views: number;
  lastViewAt: string | null;
  options: ShareOptions;
}
type Row = Record<string, string | number | null | Uint8Array>;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

export class ShareStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'shares.db'));
    this.#now = now;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, space TEXT NOT NULL, companion TEXT NOT NULL,
        conversation_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        revoked_at TEXT, views INTEGER NOT NULL DEFAULT 0, last_view_at TEXT, options TEXT NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shares_conv ON shares(space, companion, conversation_id);
      CREATE TABLE IF NOT EXISTS share_pics (share_id TEXT NOT NULL, n INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (share_id, n));
      CREATE TABLE IF NOT EXISTS share_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  close(): void {
    this.db.close();
  }

  create(i: { space: string; companion: string; conversationId: string; expires: ShareExpiry; options: ShareOptions; snapshot: ShareSnapshot; pictures: SharePicture[] }): { id: string; token: string; expiresAt: string } {
    const ms = SHARE_EXPIRY[i.expires];
    if (!ms) throw new Error('Pick an expiry: 1 hour, 1 day, 7 days or 30 days.');
    this.purge();
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(6).toString('hex');
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + ms).toISOString();
    this.db
      .prepare('INSERT INTO shares (id, token_hash, space, companion, conversation_id, title, created_at, expires_at, options, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, hashOf(token), i.space, i.companion, i.conversationId, i.snapshot.title, now.toISOString(), expiresAt, JSON.stringify({ tools: Boolean(i.options.tools), pictures: Boolean(i.options.pictures) }), JSON.stringify(i.snapshot));
    const add = this.db.prepare('INSERT INTO share_pics (share_id, n, mime, data) VALUES (?, ?, ?, ?)');
    i.pictures.slice(0, MAX_SHARE_PICTURES).forEach((p, n) => add.run(id, n, p.mime, p.data));
    return { id, token, expiresAt };
  }

  /** The live share for a token (not expired, not revoked), or undefined. */
  #live(token: string): Row | undefined {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const h = hashOf(token);
    const r = this.db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(h) as Row | undefined;
    if (!r || !timingSafeEqual(Buffer.from(String(r.token_hash)), Buffer.from(h))) return undefined;
    if (r.revoked_at || Date.parse(String(r.expires_at)) <= this.#now().getTime()) return undefined;
    return r;
  }

  /** Opens a link (counts a view). `first` = this was its first view (one audit row). */
  open(token: string): { share: ShareRow & { snapshot: ShareSnapshot }; first: boolean } | undefined {
    const r = this.#live(token);
    if (!r) return undefined;
    const at = this.#now().toISOString();
    this.db.prepare('UPDATE shares SET views = views + 1, last_view_at = ? WHERE id = ?').run(at, String(r.id));
    const views = Number(r.views) + 1;
    return { share: { ...this.#view({ ...r, views, last_view_at: at }), snapshot: JSON.parse(String(r.snapshot)) as ShareSnapshot }, first: views === 1 };
  }

  picture(token: string, n: number): SharePicture | undefined {
    const r = this.#live(token);
    if (!r) return undefined;
    const p = this.db.prepare('SELECT mime, data FROM share_pics WHERE share_id = ? AND n = ?').get(String(r.id), Math.floor(n)) as Row | undefined;
    return p ? { mime: String(p.mime), data: Buffer.from(p.data as Uint8Array) } : undefined;
  }

  #view(r: Row): ShareRow {
    return { id: String(r.id), space: String(r.space), companion: String(r.companion), conversationId: String(r.conversation_id), title: String(r.title), createdAt: String(r.created_at), expiresAt: String(r.expires_at), views: Number(r.views), lastViewAt: (r.last_view_at as string | null) ?? null, options: JSON.parse(String(r.options)) as ShareOptions };
  }

  /** Live links, newest first (optionally one space's only). */
  list(space?: string): ShareRow[] {
    this.purge();
    const rows = this.db.prepare(`SELECT * FROM shares WHERE revoked_at IS NULL AND expires_at > ?${space ? ' AND space = ?' : ''} ORDER BY created_at DESC`).all(this.#now().toISOString(), ...(space ? [space] : [])) as Row[];
    return rows.map((r) => this.#view(r));
  }

  get(id: string): ShareRow | undefined {
    const r = this.db.prepare('SELECT * FROM shares WHERE id = ? AND revoked_at IS NULL').get(String(id)) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  /** Revokes a link: its snapshot and pictures are deleted at once. */
  revoke(id: string): { views: number; title: string } | undefined {
    const r = this.get(id);
    if (!r) return undefined;
    this.db.prepare("UPDATE shares SET revoked_at = ?, snapshot = '{}' WHERE id = ?").run(this.#now().toISOString(), r.id);
    this.db.prepare('DELETE FROM share_pics WHERE share_id = ?').run(r.id);
    return { views: r.views, title: r.title };
  }

  /** A deleted conversation's links stop working. Returns how many were live. */
  revokeConversation(space: string, companion: string, conversationId: string): number {
    const ids = (this.db.prepare('SELECT id FROM shares WHERE space = ? AND companion = ? AND conversation_id = ? AND revoked_at IS NULL AND expires_at > ?').all(space, companion, conversationId, this.#now().toISOString()) as Row[]).map((r) => String(r.id));
    for (const id of ids) this.revoke(id);
    return ids.length;
  }

  /** Expired links lose their snapshot; revoked and expired rows go after 30 days. */
  purge(): void {
    const now = this.#now();
    const iso = now.toISOString();
    const old = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    this.db.prepare("UPDATE shares SET snapshot = '{}' WHERE expires_at <= ? AND snapshot <> '{}'").run(iso);
    this.db.prepare('DELETE FROM share_pics WHERE share_id IN (SELECT id FROM shares WHERE expires_at <= ? OR revoked_at IS NOT NULL)').run(iso);
    this.db.prepare('DELETE FROM shares WHERE expires_at <= ? OR revoked_at <= ?').run(old, old);
  }

  settings(): { allowPrivate: boolean } {
    const r = this.db.prepare("SELECT value FROM share_meta WHERE key = 'allowPrivate'").get() as Row | undefined;
    return { allowPrivate: r?.value === '1' };
  }
  setSettings(s: { allowPrivate: boolean }): void {
    this.db.prepare("INSERT INTO share_meta (key, value) VALUES ('allowPrivate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(s.allowPrivate ? '1' : '0');
  }
}

// ---- the server's one share store (set by main.ts; tests set their own). Unset = no sharing. ----
let current: ShareStore | undefined;
export function setShares(s: ShareStore | undefined): void {
  current = s;
}
export function shares(): ShareStore | undefined {
  return current;
}
