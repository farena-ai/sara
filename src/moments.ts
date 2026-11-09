// Phase 70: "Our moments". A shared photo album grown from the scrapbook: every photo in your
// conversations (the ones you sent her and the ones she sent you) and the moments you pinned, each
// with a short caption she writes in her own voice. Per companion (it lives in her own database).
//
// - Photos enter by themselves (Settings → the album's "Add photos": all / only pinned / off) from
//   conversations that may be shared: never other people's chats, private conversations, imported
//   history, group chats, shared work channels or other apps' conversations. The owner can add a
//   photo from a private conversation or a group chat by hand.
// - Captions are written in the background, a few at a time, by her talking model (or the picture
//   model when the photo needs looking at). The minors block applies to every caption and to the
//   conversation lines sent to the model. Adults-only items stay hidden while Adult mode is off.
// - "Remove from moments" only hides the item (the message and the photo stay); "Delete photo
//   everywhere" takes the picture out of every message (their text stays) and deletes the file.
// - Nothing here is exposed to MCP or the OpenAI-compatible API: there are no such routes or tools,
//   and her `moments` tool is left out of other apps' turns, group chats and work channels.
import type { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import type { AppContext } from './chat.ts';
import { resolveChain } from './chat.ts';
import { complete } from './life.ts';
import { languageLine, talkLanguage } from './i18n.ts';
import { isForgotten, localDate } from './memory-worker.ts';
import { buildSystemPrompt } from './persona.ts';
import { detectExplicit, detectMinorSexualContent, isWorkChannel, minorSexualMatch } from './safety.ts';
import { adultModeOn, type SettingsStore } from './settings.ts';
import type { Conversation, Store, StoredMessage } from './store.ts';
import { isImportChannel } from './store.ts';
import type { Tool } from './tools/types.ts';
import { str, ToolError } from './tools/types.ts';
import { billingOf, costOf, findPrice, priceTable, usageScope } from './usage.ts';
import { modelSeesByName, ollamaSees } from './video.ts';

export type MomentsMode = 'all' | 'pinned' | 'off';
export const MOMENTS_MODES: readonly MomentsMode[] = ['all', 'pinned', 'off'];
export interface MomentsSettings {
  /** Which photos enter the album by themselves. */
  mode: MomentsMode;
}
export const DEFAULT_MOMENTS: MomentsSettings = { mode: 'all' };
export function momentsSettings(settings: SettingsStore): MomentsSettings {
  const m = settings.get().moments?.mode;
  return { mode: m && MOMENTS_MODES.includes(m) ? m : DEFAULT_MOMENTS.mode };
}

/** Captions written per background step, and how often the step runs. */
export const CAPTION_BATCH = 3;
export const TICK_MS = 60_000;
/** The one-time backfill captions only the newest this many by itself (the rest on request). */
export const BACKFILL_CAPTIONS = 40;
/** Tries before a caption counts as failed (the owner can still ask again). */
export const CAPTION_TRIES = 3;
export const MAX_CAPTION = 240;
/** Rough size of one caption job, for the cost note. */
const CAPTION_IN_TOKENS = 900;
const CAPTION_OUT_TOKENS = 90;
/** Channels of other apps' conversations (never in the album, never where her tool runs). */
const APP_CHANNELS = new Set(['api', 'mcp', 'home-assistant']);

export type CaptionState = 'pending' | 'done' | 'edited' | 'failed' | 'blocked' | 'none';
export type AutoAlbum = 'us' | 'places' | 'looks';
export const AUTO_ALBUMS: readonly AutoAlbum[] = ['us', 'places', 'looks'];

export interface Moment {
  id: number;
  kind: 'photo' | 'moment';
  image: string | null;
  conversationId: string | null;
  messageId: number | null;
  scrapId: number | null;
  /** Who sent the photo (or pinned / kept the moment). */
  from: 'owner' | 'sara';
  pinned: boolean;
  /** Added by the owner by hand (e.g. from a private conversation). */
  byHand: boolean;
  caption: string;
  captionState: CaptionState;
  /** The moment's own words (a pinned moment's text, or the message that came with the photo). */
  text: string;
  place: string;
  outfit: string;
  us: boolean;
  adult: boolean;
  takenAt: string;
  addedAt: string;
}

export interface AlbumInfo {
  id: string;
  name: string;
  auto: boolean;
  count: number;
  cover: string | null;
  coverId: number | null;
}

type Row = Record<string, unknown>;
const toMoment = (r: Row): Moment => ({
  id: Number(r.id),
  kind: r.kind === 'moment' ? 'moment' : 'photo',
  image: (r.image as string | null) ?? null,
  conversationId: (r.conversation_id as string | null) ?? null,
  messageId: r.message_id === null || r.message_id === undefined ? null : Number(r.message_id),
  scrapId: r.scrap_id === null || r.scrap_id === undefined ? null : Number(r.scrap_id),
  from: r.source === 'sara' ? 'sara' : 'owner',
  pinned: Number(r.pinned) === 1,
  byHand: Number(r.hand) === 1,
  caption: String(r.caption ?? ''),
  captionState: String(r.caption_state ?? 'none') as CaptionState,
  text: String(r.text ?? ''),
  place: String(r.place ?? ''),
  outfit: String(r.outfit ?? ''),
  us: Number(r.us) === 1,
  adult: Number(r.adult) === 1,
  takenAt: String(r.taken_at),
  addedAt: String(r.added_at),
});

/** May photos from this conversation enter the album by themselves? */
export function autoEligible(c: Pick<Conversation, 'partner' | 'private' | 'channel'> | undefined): boolean {
  if (!c) return false;
  return !c.partner && !c.private && !isImportChannel(c.channel) && c.channel !== 'group' && !isWorkChannel(c.channel) && !/-nsfw$/.test(c.channel) && !APP_CHANNELS.has(c.channel);
}

/** May the owner add a photo from this conversation by hand? (Never from other people's chats or other apps.) */
export function handEligible(c: Pick<Conversation, 'partner' | 'channel'> | undefined): boolean {
  return Boolean(c) && !c!.partner && !APP_CHANNELS.has(c!.channel) && !isImportChannel(c!.channel);
}

const IMG_RE = /^[0-9a-f]{32}\.(jpg|png|webp|gif)$/;
const imagesOf = (meta: unknown): string[] => {
  try {
    const m = (typeof meta === 'string' ? JSON.parse(meta) : meta) as { images?: unknown } | null;
    return Array.isArray(m?.images) ? (m.images as unknown[]).map(String).filter((x) => IMG_RE.test(x)) : [];
  } catch {
    return [];
  }
};

export interface SyncHints {
  /** Her outfit right now (words), for photos she sends from now on. */
  outfitNow?: () => { wear?: string; adult?: boolean } | undefined;
  /** The scene of a picture she took (take_photo), by upload id. */
  sceneOf?: (image: string) => string | undefined;
}

export class MomentsStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS moments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'photo',
      image TEXT,
      conversation_id TEXT,
      message_id INTEGER,
      scrap_id INTEGER,
      source TEXT NOT NULL DEFAULT 'owner',
      pinned INTEGER NOT NULL DEFAULT 0,
      hand INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      caption TEXT NOT NULL DEFAULT '',
      caption_state TEXT NOT NULL DEFAULT 'pending',
      caption_tries INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      place TEXT NOT NULL DEFAULT '',
      outfit TEXT NOT NULL DEFAULT '',
      us INTEGER NOT NULL DEFAULT 0,
      adult INTEGER NOT NULL DEFAULT 0,
      backfill INTEGER NOT NULL DEFAULT 0,
      taken_at TEXT NOT NULL,
      added_at TEXT NOT NULL
    )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS moments_photo ON moments(message_id, image) WHERE message_id IS NOT NULL AND image IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS moments_scrap ON moments(scrap_id) WHERE scrap_id IS NOT NULL AND image IS NULL');
    db.exec(`CREATE TABLE IF NOT EXISTS moment_albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cover INTEGER,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS moment_album_items (
      album_id INTEGER NOT NULL,
      moment_id INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (album_id, moment_id)
    )`);
    db.exec('CREATE TABLE IF NOT EXISTS moment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  meta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM moment_meta WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }
  setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare('DELETE FROM moment_meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO moment_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  #hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  /**
   * Brings the album up to date with the conversations and the scrapbook. The first run is the
   * one-time backfill (existing photos and pinned moments): only the newest BACKFILL_CAPTIONS get a
   * caption by themselves. Items the owner removed stay removed. Returns how many were added.
   */
  sync(store: Store, mode: MomentsMode, hints: SyncHints = {}): number {
    this.prune();
    // The first run (and a switch back to "all photos") is a backfill: captions only for the newest.
    const lastMode = this.meta('last_mode');
    const first = this.meta('scan_msg') === undefined || (mode === 'all' && lastMode !== undefined && lastMode !== 'all');
    this.setMeta('last_mode', mode);
    const lastMsg = Number(this.meta('scan_msg') ?? 0);
    const lastScrap = Number(this.meta('scan_scrap') ?? 0);
    const maxMsg = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages').get() as Row).n);
    const hasScrap = this.#hasTable('scrapbook');
    const maxScrap = hasScrap ? Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM scrapbook').get() as Row).n) : 0;
    let added = 0;
    const now = this.#now().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO moments (kind, image, conversation_id, message_id, scrap_id, source, pinned, hand, caption_state, text, outfit, adult, backfill, taken_at, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    // EC26: chats in the work space never feed her album.
    const hasWork = this.#hasTable('work_spaces');
    const workConv = (id: string) => hasWork && Boolean(this.db.prepare('SELECT 1 FROM work_spaces WHERE conversation_id = ?').get(id));
    const pinnedMsg = (id: number) => hasScrap && Boolean(this.db.prepare("SELECT 1 FROM scrapbook WHERE message_id = ? AND kind = 'moment'").get(id));
    const addPhotos = (m: Row, pinned: boolean) => {
      const conv = store.getConversation(String(m.conversation_id));
      if (!autoEligible(conv) || workConv(String(m.conversation_id))) return;
      const msg = { meta: m.meta ? JSON.parse(String(m.meta)) : undefined } as StoredMessage;
      if (isForgotten(msg)) return;
      const from = m.role === 'user' ? 'owner' : 'sara';
      const words = String(m.content ?? '').replace(/^\(photo\)$/, '').slice(0, 1000);
      const outfit = from === 'sara' && !first ? hints.outfitNow?.() : undefined;
      for (const image of imagesOf(m.meta)) {
        const scene = from === 'sara' ? (hints.sceneOf?.(image) ?? '') : '';
        const adult = /-nsfw$/.test(conv!.channel) || detectExplicit(words) || (scene ? detectExplicit(scene) : false) || outfit?.adult === true;
        const r = insert.run('photo', image, conv!.id, Number(m.id), null, from, pinned ? 1 : 0, 'pending', words, (outfit?.wear ?? '').slice(0, 120), adult ? 1 : 0, first ? 1 : 0, String(m.created_at), now);
        if (Number(r.changes)) added++;
        else if (pinned) this.db.prepare('UPDATE moments SET pinned = 1 WHERE message_id = ? AND image = ?').run(Number(m.id), image);
      }
    };
    // Photos in messages (every new one when mode is "all").
    if (mode === 'all' && maxMsg > lastMsg) {
      const rows = this.db
        .prepare(`SELECT id, conversation_id, role, content, meta, created_at FROM messages WHERE id > ? AND id <= ? AND role IN ('user', 'assistant') AND meta LIKE '%"images"%' ORDER BY id`)
        .all(lastMsg, maxMsg) as Row[];
      for (const m of rows) addPhotos(m, pinnedMsg(Number(m.id)));
    }
    // Pinned moments (📌 and the ones she kept): their photos, or the moment itself as words.
    if (hasScrap && mode !== 'off' && maxScrap > lastScrap) {
      const pins = this.db.prepare("SELECT * FROM scrapbook WHERE id > ? AND id <= ? AND kind = 'moment' ORDER BY id").all(lastScrap, maxScrap) as Row[];
      for (const p of pins) {
        const msgId = p.message_id === null || p.message_id === undefined ? null : Number(p.message_id);
        const m = msgId !== null ? (this.db.prepare('SELECT id, conversation_id, role, content, meta, created_at FROM messages WHERE id = ?').get(msgId) as Row | undefined) : undefined;
        if (m && imagesOf(m.meta).length) {
          addPhotos(m, true);
          continue;
        }
        const convId = (p.conversation_id as string | null) ?? null;
        if (convId && (!autoEligible(store.getConversation(convId)) || workConv(convId))) continue;
        const words = String(p.text ?? '').slice(0, 1000);
        const r = insert.run('moment', null, convId, msgId, Number(p.id), p.added_by === 'sara' ? 'sara' : 'owner', 1, 'pending', words, '', detectExplicit(words) ? 1 : 0, first ? 1 : 0, String(p.created_at), now);
        if (Number(r.changes)) added++;
      }
    }
    if (mode === 'all') this.setMeta('scan_msg', String(maxMsg));
    if (mode !== 'off') this.setMeta('scan_scrap', String(maxScrap));
    // The backfill writes only the newest captions by itself; the rest wait for the owner.
    if (first && mode === 'all') this.db.prepare(`UPDATE moments SET caption_state = 'none' WHERE backfill = 1 AND caption_state = 'pending' AND id NOT IN (SELECT id FROM moments WHERE backfill = 1 ORDER BY taken_at DESC, id DESC LIMIT ?)`).run(BACKFILL_CAPTIONS);
    return added;
  }

  /** Drops items whose message, photo or scrapbook entry is gone (deleting a conversation empties its moments). */
  prune(): void {
    this.db.exec('DELETE FROM moments WHERE message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)');
    if (this.#hasTable('scrapbook')) this.db.exec('DELETE FROM moments WHERE image IS NULL AND scrap_id IS NOT NULL AND scrap_id NOT IN (SELECT id FROM scrapbook)');
    this.db.exec('DELETE FROM moment_album_items WHERE moment_id NOT IN (SELECT id FROM moments WHERE hidden = 0)');
  }

  get(id: number, opts: { hidden?: boolean } = {}): Moment | undefined {
    const r = this.db.prepare(`SELECT * FROM moments WHERE id = ?${opts.hidden ? '' : ' AND hidden = 0'}`).get(id) as Row | undefined;
    return r ? toMoment(r) : undefined;
  }

  /** The album, newest first. Adults-only items are left out unless `adultOk`. */
  list(opts: { adultOk?: boolean; album?: string; limit?: number } = {}): Moment[] {
    const where = ['hidden = 0'];
    const args: (string | number)[] = [];
    if (!opts.adultOk) where.push('adult = 0');
    const a = opts.album;
    if (a === 'us') where.push('(pinned = 1 OR us = 1)');
    else if (a === 'places') where.push("place <> ''");
    else if (a === 'looks') where.push("source = 'sara' AND kind = 'photo'");
    else if (a && /^\d+$/.test(a)) {
      where.push('id IN (SELECT moment_id FROM moment_album_items WHERE album_id = ?)');
      args.push(Number(a));
    }
    args.push(opts.limit ?? 2000);
    return (this.db.prepare(`SELECT * FROM moments WHERE ${where.join(' AND ')} ORDER BY taken_at DESC, id DESC LIMIT ?`).all(...args) as Row[]).map(toMoment);
  }

  count(opts: { adultOk?: boolean } = {}): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM moments WHERE hidden = 0${opts.adultOk ? '' : ' AND adult = 0'}`).get() as Row).n);
  }

  /** Adds a message's photos (or the photo `image`) by hand. Brings back items removed earlier. */
  addByHand(store: Store, messageId: number, image?: string): Moment[] {
    const m = store.messageById(messageId);
    if (!m) throw new Error('Message not found');
    const conv = store.getConversation(m.conversationId);
    if (!handEligible(conv)) throw new Error("Photos from other people's chats or other apps can't go in your moments.");
    const imgs = imagesOf(m.meta).filter((x) => !image || x === image);
    if (!imgs.length) throw new Error('That message has no photo.');
    if (m.role !== 'user' && m.role !== 'assistant') throw new Error('That message has no photo.');
    const now = this.#now().toISOString();
    const words = m.content.replace(/^\(photo\)$/, '').slice(0, 1000);
    const out: Moment[] = [];
    for (const img of imgs) {
      const adult = /-nsfw$/.test(conv!.channel) || detectExplicit(words);
      this.db
        .prepare(
          `INSERT INTO moments (kind, image, conversation_id, message_id, source, hand, caption_state, text, adult, taken_at, added_at) VALUES ('photo', ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET hidden = 0, hand = 1`,
        )
        .run(img, conv!.id, m.id, m.role === 'user' ? 'owner' : 'sara', words, adult ? 1 : 0, m.createdAt, now);
      const r = this.db.prepare('SELECT * FROM moments WHERE message_id = ? AND image = ?').get(m.id, img) as Row;
      out.push(toMoment(r));
    }
    return out;
  }

  /** "Remove from moments": hidden from the album; the message and its photo stay. */
  remove(id: number): boolean {
    const ok = Number(this.db.prepare('UPDATE moments SET hidden = 1 WHERE id = ? AND hidden = 0').run(id).changes) > 0;
    if (ok) this.db.prepare('DELETE FROM moment_album_items WHERE moment_id = ?').run(id);
    return ok;
  }

  setCaption(id: number, caption: string): Moment | undefined {
    const c = cleanCaption(caption);
    if (detectMinorSexualContent(c)) throw new Error('That caption can’t be saved.');
    this.db.prepare("UPDATE moments SET caption = ?, caption_state = ? WHERE id = ? AND hidden = 0").run(c, c ? 'edited' : 'none', id);
    return this.get(id);
  }

  /** Asks for a new caption (the worker writes it in the background). */
  requestCaption(id: number): Moment | undefined {
    this.db.prepare("UPDATE moments SET caption_state = 'pending', caption_tries = 0 WHERE id = ? AND hidden = 0").run(id);
    return this.get(id);
  }

  /** Queues captions for up to `n` items that have none (older backfilled ones, failed ones). */
  requestMore(n = BACKFILL_CAPTIONS): number {
    return Number(
      this.db
        .prepare("UPDATE moments SET caption_state = 'pending', caption_tries = 0 WHERE id IN (SELECT id FROM moments WHERE hidden = 0 AND caption_state IN ('none', 'failed') ORDER BY taken_at DESC LIMIT ?)")
        .run(n).changes,
    );
  }

  pendingCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM moments WHERE hidden = 0 AND caption_state = 'pending'").get() as Row).n);
  }
  waitingCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM moments WHERE hidden = 0 AND caption_state IN ('none', 'failed')").get() as Row).n);
  }

  /** The next items to caption: new ones first, then the backfill (newest first). */
  nextPending(n = CAPTION_BATCH): Moment[] {
    return (this.db.prepare("SELECT * FROM moments WHERE hidden = 0 AND caption_state = 'pending' ORDER BY backfill ASC, taken_at DESC, id DESC LIMIT ?").all(n) as Row[]).map(toMoment);
  }

  saveCaption(id: number, r: { caption: string; place?: string; us?: boolean; adult?: boolean; state?: CaptionState }): void {
    this.db
      .prepare('UPDATE moments SET caption = ?, caption_state = ?, place = CASE WHEN ? <> \'\' THEN ? ELSE place END, us = CASE WHEN ? THEN 1 ELSE us END, adult = CASE WHEN ? THEN 1 ELSE adult END WHERE id = ?')
      .run(r.caption, r.state ?? 'done', r.place ?? '', (r.place ?? '').slice(0, 80), r.us ? 1 : 0, r.adult ? 1 : 0, id);
  }
  captionFailed(id: number): void {
    this.db.prepare(`UPDATE moments SET caption_tries = caption_tries + 1, caption_state = CASE WHEN caption_tries + 1 >= ? THEN 'failed' ELSE caption_state END WHERE id = ?`).run(CAPTION_TRIES, id);
  }

  /** Every item showing this photo (for "Delete photo everywhere"). */
  withImage(image: string): number[] {
    return (this.db.prepare('SELECT id FROM moments WHERE image = ?').all(image) as Row[]).map((r) => Number(r.id));
  }
  dropImage(image: string): void {
    this.db.prepare('DELETE FROM moment_album_items WHERE moment_id IN (SELECT id FROM moments WHERE image = ?)').run(image);
    this.db.prepare('DELETE FROM moments WHERE image = ?').run(image);
  }

  // ---- albums ----
  albums(opts: { adultOk?: boolean } = {}): AlbumInfo[] {
    const names: Record<AutoAlbum, string> = { us: 'Us', places: 'Places', looks: 'Her looks' };
    const coverOf = (id: string, items: Moment[], chosen: number | null) => {
      const pick = (chosen !== null && items.find((x) => x.id === chosen && x.image)) || items.find((x) => x.image);
      return { cover: pick?.image ?? null, coverId: pick?.id ?? null, count: items.length, id };
    };
    const out: AlbumInfo[] = AUTO_ALBUMS.map((a) => {
      const chosen = this.meta(`cover:${a}`);
      return { name: names[a], auto: true, ...coverOf(a, this.list({ adultOk: opts.adultOk, album: a }), chosen ? Number(chosen) : null) };
    });
    for (const r of this.db.prepare('SELECT * FROM moment_albums ORDER BY created_at, id').all() as Row[]) {
      const id = String(r.id);
      out.push({ name: String(r.name), auto: false, ...coverOf(id, this.list({ adultOk: opts.adultOk, album: id }), r.cover === null ? null : Number(r.cover)) });
    }
    return out;
  }

  createAlbum(name: string): AlbumInfo {
    const n = cleanName(name);
    if (!n) throw new Error('Give the album a name.');
    if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM moment_albums').get() as Row).n) >= 100) throw new Error('That’s a lot of albums: delete one first.');
    const r = this.db.prepare('INSERT INTO moment_albums (name, created_at) VALUES (?, ?)').run(n, this.#now().toISOString());
    return this.albums({ adultOk: true }).find((a) => a.id === String(r.lastInsertRowid))!;
  }

  #albumId(id: string): number {
    if (!/^\d+$/.test(id) || !this.db.prepare('SELECT 1 FROM moment_albums WHERE id = ?').get(Number(id))) throw new Error('Album not found');
    return Number(id);
  }

  updateAlbum(id: string, patch: { name?: string; cover?: number | null }): void {
    if ((AUTO_ALBUMS as readonly string[]).includes(id)) {
      if (patch.name !== undefined) throw new Error('The automatic albums keep their names.');
      if (patch.cover !== undefined) this.setMeta(`cover:${id}`, patch.cover === null ? undefined : String(patch.cover));
      return;
    }
    const a = this.#albumId(id);
    if (patch.name !== undefined) {
      const n = cleanName(patch.name);
      if (!n) throw new Error('Give the album a name.');
      this.db.prepare('UPDATE moment_albums SET name = ? WHERE id = ?').run(n, a);
    }
    if (patch.cover !== undefined) this.db.prepare('UPDATE moment_albums SET cover = ? WHERE id = ?').run(patch.cover, a);
  }

  /** Deletes an album of the owner's; its photos stay in the moments. */
  deleteAlbum(id: string): void {
    if ((AUTO_ALBUMS as readonly string[]).includes(id)) throw new Error('The automatic albums can’t be deleted.');
    const a = this.#albumId(id);
    this.db.prepare('DELETE FROM moment_album_items WHERE album_id = ?').run(a);
    this.db.prepare('DELETE FROM moment_albums WHERE id = ?').run(a);
  }

  addToAlbum(id: string, momentIds: number[]): number {
    const a = this.#albumId(id);
    let n = 0;
    for (const m of momentIds) {
      if (!this.get(m)) continue;
      n += Number(this.db.prepare('INSERT INTO moment_album_items (album_id, moment_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(a, m, this.#now().toISOString()).changes);
    }
    return n;
  }

  removeFromAlbum(id: string, momentId: number): boolean {
    const a = this.#albumId(id);
    return Number(this.db.prepare('DELETE FROM moment_album_items WHERE album_id = ? AND moment_id = ?').run(a, momentId).changes) > 0;
  }

  /** Albums of the owner's that hold an item. */
  albumsOf(momentId: number): string[] {
    return (this.db.prepare('SELECT album_id FROM moment_album_items WHERE moment_id = ?').all(momentId) as Row[]).map((r) => String(r.album_id));
  }

  /** "On this day": moments from this day a year (or more) ago, else from this day last month. */
  onThisDay(now: Date, timeZone: string | undefined, opts: { adultOk?: boolean } = {}): { kind: 'year' | 'month'; years?: number; items: Moment[] } | undefined {
    const today = localDate(now.toISOString(), timeZone);
    const [y, mo, d] = today.split('-').map(Number);
    const items = this.list({ adultOk: opts.adultOk, limit: 5000 });
    const dayOf = (m: Moment) => localDate(m.takenAt, timeZone);
    const yearAgo = items.filter((m) => {
      const x = dayOf(m);
      return x.slice(5) === today.slice(5) && Number(x.slice(0, 4)) < y;
    });
    if (yearAgo.length) return { kind: 'year', years: y - Math.max(...yearAgo.map((m) => Number(dayOf(m).slice(0, 4)))), items: yearAgo.slice(0, 6) };
    const prev = new Date(Date.UTC(y, mo - 2, d));
    if (prev.getUTCDate() !== d) return undefined; // the 31st has no "a month ago" in shorter months
    const monthAgo = prev.toISOString().slice(0, 10);
    const lastMonth = items.filter((m) => dayOf(m) === monthAgo);
    return lastMonth.length ? { kind: 'month', items: lastMonth.slice(0, 6) } : undefined;
  }
}

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60);

/** A caption as stored: one short paragraph, no wrapping quotes, no labels. */
export function cleanCaption(s: string): string {
  let c = s.replace(/\r/g, '').replace(/^\s*(caption|title)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  c = c.replace(/^["“”'«»]+|["“”'«»]+$/g, '').trim();
  if (c.length > MAX_CAPTION) c = `${c.slice(0, MAX_CAPTION - 1).replace(/\s+\S*$/, '')}…`;
  return c;
}

/** Reads the model's answer: CAPTION / PLACE / US lines (or just a caption). */
export function parseCaptionAnswer(raw: string): { caption: string; place: string; us: boolean } {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const line = (k: string) => new RegExp(`^\\s*\\**\\s*${k}\\s*\\**\\s*:\\s*\\**\\s*(.*)$`, 'im').exec(text)?.[1]?.trim() ?? '';
  let caption = line('CAPTION');
  if (!caption) caption = text.split('\n').filter((l) => !/^\s*\**\s*(PLACE|US)\s*\**\s*:/i.test(l)).join(' ');
  let place = line('PLACE').replace(/[.*"“”]+$/g, '').replace(/^["“*]+/, '').trim();
  if (/^(none|no|unknown|n\/a|-|nowhere|not clear)\b/i.test(place) || place.length > 60) place = '';
  const us = /^\**\s*yes/i.test(line('US'));
  return { caption: cleanCaption(caption), place, us };
}

/** The conversation around a photo (text only), for her caption. Forgotten lines are left out. */
export function contextLines(store: Store, m: Moment, owner: string, name: string): string[] {
  if (!m.messageId || !m.conversationId) return m.text ? [`${m.from === 'sara' ? name : owner}: ${m.text}`] : [];
  const rows = [
    ...(store.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id <= ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 7").all(m.conversationId, m.messageId) as Row[]).reverse(),
    ...(store.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND role IN ('user', 'assistant') ORDER BY id LIMIT 3").all(m.conversationId, m.messageId) as Row[]),
  ];
  const out: string[] = [];
  for (const r of rows) {
    const meta = r.meta ? (JSON.parse(String(r.meta)) as Record<string, unknown>) : undefined;
    if (meta?.forgotten === true) continue;
    const content = String(r.content ?? '').replace(/^\(photo\)$/, '').trim();
    const photo = imagesOf(meta).length ? (Number(r.id) === m.messageId ? ' [sends THE photo]' : ' [sends a photo]') : '';
    if (!content && !photo) continue;
    out.push(`${r.role === 'user' ? owner : name}${photo}: ${content.slice(0, 400)}`);
  }
  return out;
}

const routeConv = (c?: Conversation): Conversation =>
  c ?? ({ id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: false, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '', updatedAt: '' } as Conversation);

/** Which model writes captions, and what it costs (for the note in the album). */
export function captionModel(app: AppContext): { provider: string; model: string; billing: 'local' | 'api' | 'subscription'; usdPer100: number | null; sees: boolean } | null {
  try {
    const visionSet = Boolean(app.settings.get().routes?.vision);
    const { provider, model } = resolveChain(app, routeConv(), visionSet ? 'vision' : 'background')[0];
    const billing = billingOf(provider.config);
    const usd = costOf(billing, findPrice(priceTable(app.settings.get().prices), provider.config.id, model), { input: CAPTION_IN_TOKENS * 100, output: CAPTION_OUT_TOKENS * 100 });
    return { provider: provider.config.label, model, billing, usdPer100: usd === null ? null : Math.round(usd * 100) / 100, sees: visionSet || modelSeesByName(model) };
  } catch {
    return null;
  }
}

/** Does this provider's model take pictures? (Ollama says so itself; others by name.) */
async function canSee(p: { config: { kind: string; baseUrl: string } }, model: string): Promise<boolean> {
  if (/11434|ollama/i.test(p.config.baseUrl)) {
    const s = await ollamaSees(p.config.baseUrl, model).catch(() => undefined);
    if (s !== undefined) return s;
  }
  return modelSeesByName(model);
}

/** Writes one caption (or marks it blocked/failed). */
export async function writeCaption(app: AppContext, book: MomentsStore, m: Moment, hints: SyncHints = {}): Promise<CaptionState> {
  return usageScope.run({ purpose: 'moments', ...(m.conversationId ? { conversationId: m.conversationId } : {}) }, async () => {
    const s = app.settings.get();
    const owner = s.ownerName?.trim() || 'the owner';
    const name = app.persona.name;
    const conv = m.conversationId ? app.store.getConversation(m.conversationId) : undefined;
    const lines = contextLines(app.store, m, owner, name);
    // The minors block: nothing about it goes to a model, and no caption comes back.
    if (lines.some((l) => minorSexualMatch(l)) || detectMinorSexualContent(m.text)) {
      book.saveCaption(m.id, { caption: '', state: 'blocked' });
      return 'blocked';
    }
    const adultOn = adultModeOn(s);
    const day = localDate(m.takenAt, s.timeZone);
    const scene = m.from === 'sara' && m.image ? hints.sceneOf?.(m.image) : undefined;
    const what =
      m.kind === 'moment'
        ? `a moment ${m.from === 'sara' ? 'you' : owner} kept in your scrapbook ("${m.text.slice(0, 400)}")`
        : m.from === 'sara'
          ? `a picture of yourself you sent ${owner}${scene ? ` (it shows: ${scene.slice(0, 300)})` : m.outfit ? ` (you were wearing ${m.outfit})` : ''}`
          : `a photo ${owner} sent you`;
    // Photos from the owner may need looking at: the picture model when one can see it.
    let images: { mime: string; data: string }[] | undefined;
    let job: 'vision' | 'background' = 'background';
    if (m.kind === 'photo' && m.from === 'owner' && m.image && app.uploads) {
      try {
        const chain = resolveChain(app, routeConv(conv), 'vision');
        if (chain[0] && (await canSee(chain[0].provider, chain[0].model))) {
          const img = app.uploads.load(m.image);
          if (img) {
            images = [img];
            job = 'vision';
          }
        }
      } catch {
        /* no picture model: write it from the conversation */
      }
    }
    const system = buildSystemPrompt(app.persona, { now: app.now(), timeZone: s.timeZone, ownerName: s.ownerName, memory: false, language: languageLine(talkLanguage(s)) });
    const note = `[Note from the app, not from ${owner}: ${what} on ${day} is in your shared photo album with ${owner}, "Our moments". Write its caption: one or two short sentences (under 180 characters) in your own voice and personality, as your memory of that moment: what you two were talking about${images ? ' and what you see in the picture' : ''}. Talk to ${owner} as "you". Use only what is in the conversation below${images ? ' and the picture' : ''}; never invent events, places, people or feelings that aren't there (no "reminds me of home", no "we've been here before", no names of places that weren't said); a plain caption is better than an invented one. No hashtags, no quotation marks around it, at most one emoji.${adultOn ? '' : ' Keep it non-explicit.'} Never anything sexual involving minors.
Then add two lines: PLACE: where it was, only if the conversation${images ? ' or the picture' : ''} says or clearly shows it (otherwise "none"); and US: yes if it is a moment between you two or ${owner} is in the picture, otherwise no.
Answer exactly like this:
CAPTION: ...
PLACE: ...
US: ...

The conversation (oldest first):
${lines.length ? lines.join('\n') : '(no words came with it)'}]`;
    let raw = '';
    try {
      raw = await complete(app, routeConv(conv), [{ role: 'system', content: system }, { role: 'user', content: note, ...(images ? { images } : {}) }], 220, job);
    } catch (err) {
      console.warn(`moments: caption failed: ${(err as Error).message}`);
      book.captionFailed(m.id);
      return 'pending';
    }
    const ans = parseCaptionAnswer(raw);
    let caption = app.redactor.redact(ans.caption);
    if (!caption) {
      book.captionFailed(m.id);
      return 'pending';
    }
    if (detectMinorSexualContent(caption) || minorSexualMatch(caption)) {
      book.saveCaption(m.id, { caption: '', state: 'blocked' });
      return 'blocked';
    }
    const explicit = detectExplicit(caption);
    // Adults-only captions are only kept while Adult mode is on (and the item then counts as adults-only).
    if (explicit && !adultOn) caption = '';
    book.saveCaption(m.id, { caption, place: ans.place, us: ans.us, adult: explicit, state: caption ? 'done' : 'none' });
    return caption ? 'done' : 'none';
  });
}

/** The album's background work: keep it in sync, write a few captions each step. */
export class MomentsWorker {
  readonly #app: AppContext;
  readonly #book: MomentsStore;
  readonly hints: SyncHints;
  #timer: NodeJS.Timeout | undefined;
  #first: NodeJS.Timeout | undefined;
  #running = false;
  /** The step running now (tests await it). */
  work: Promise<unknown> | undefined;

  constructor(app: AppContext, book: MomentsStore, hints: SyncHints = {}) {
    this.#app = app;
    this.#book = book;
    this.hints = hints;
  }

  /** Starts after a delay so start-up never waits on it (the first step is the backfill). */
  start(firstDelayMs = 30_000, everyMs = TICK_MS): void {
    this.#first = setTimeout(() => this.nudge(), firstDelayMs);
    this.#first.unref();
    this.#timer = setInterval(() => this.nudge(), everyMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
  }

  /** Runs a step now (unless one is running). */
  nudge(): Promise<unknown> {
    if (this.#running) return this.work ?? Promise.resolve();
    this.#running = true;
    this.work = this.tick()
      .catch((err: Error) => console.warn(`moments: ${err.message}`))
      .finally(() => {
        this.#running = false;
      });
    return this.work;
  }

  async tick(): Promise<{ added: number; captioned: number }> {
    const app = this.#app;
    const added = this.#book.sync(app.store, momentsSettings(app.settings).mode, this.hints);
    let captioned = 0;
    for (const m of this.#book.nextPending(CAPTION_BATCH)) {
      const st = await writeCaption(app, this.#book, m, this.hints);
      if (st !== 'pending') captioned++;
    }
    if (added || captioned) app.events?.publish({ type: 'moments', added, captioned });
    return { added, captioned };
  }
}

/** Words in the owner's message that ask about photos or memories (then showing one isn't unprompted). */
export const ASKED_RE = /\b(photos?|pictures?|pics?|selfies?|album|moments?|remember|memor(y|ies)|fotos?|bilder?|souvenirs?|recuerd\w*|ricord\w*|lembr\w*|erinner\w*|imagens?|immagin\w*|images?)\b/i;

/** Her tool: look through the album and bring up a moment ("remember this?") with its photo. */
export function createMomentsTool(getApp: () => AppContext, book: MomentsStore): Tool {
  const allowedHere = (app: AppContext, conversationId: string | undefined): Conversation => {
    const c = conversationId ? app.store.getConversation(conversationId) : undefined;
    if (!c) throw new ToolError('Your album is only for your conversations with the owner.');
    if (c.partner || c.channel === 'group' || isWorkChannel(c.channel) || APP_CHANNELS.has(c.channel) || isImportChannel(c.channel)) throw new ToolError('Your album stays out of this conversation (others may read it, or it is another app’s).');
    return c;
  };
  /** Items she may use in this conversation: hand-added ones from private chats only inside private ones. */
  const usable = (app: AppContext, here: Conversation) => {
    const adultOk = adultModeOn(app.settings.get()) && !here.channel.endsWith('-work');
    return book.list({ adultOk, limit: 3000 }).filter((m) => {
      if (!m.conversationId || m.conversationId === here.id) return true;
      const c = app.store.getConversation(m.conversationId);
      return autoEligible(c) || (here.private && Boolean(c?.private));
    });
  };
  const line = (app: AppContext, m: Moment) => {
    const tz = app.settings.get().timeZone;
    const bits = [localDate(m.takenAt, tz), m.kind === 'moment' ? 'kept moment' : m.from === 'sara' ? 'a photo you sent' : 'a photo they sent'];
    if (m.place) bits.push(m.place);
    return `- #${m.id} (${bits.join(', ')}) ${m.caption || m.text.slice(0, 160) || '(no caption yet)'}`;
  };
  return {
    defaultPermission: 'auto',
    source: 'built-in',
    isAvailable: () => book.count({ adultOk: true }) > 0,
    spec: {
      name: 'moments',
      description:
        'Your shared photo album with the person you talk with ("Our moments"): photos you two shared and moments you kept, each with your own caption. action "find" looks through it (words like "beach", or "on this day"); action "show" with an id brings one up with its photo, like "remember this?". Bring one up without being asked only when it truly fits the conversation, at most once a day, never to fill silence.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['find', 'show'] },
          query: { type: 'string', description: 'For find: words to look for, or "on this day"' },
          id: { type: 'number', description: 'For show: the moment\'s number (#id) from find' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    summarize: (a) => (a.action === 'show' ? `Our moments: bring up #${String(a.id ?? '')}` : `Our moments: look for ${String(a.query ?? 'a moment')}`),
    async run(args, ctx) {
      const app = getApp();
      const here = allowedHere(app, ctx.conversationId);
      const action = str(args, 'action');
      const items = usable(app, here);
      if (action === 'find') {
        const q = String(args.query ?? '').trim().toLowerCase();
        let found = items;
        if (/on this day|this day|today/.test(q)) {
          const otd = book.onThisDay(app.now(), app.settings.get().timeZone, { adultOk: true });
          const ok = new Set(items.map((m) => m.id));
          found = (otd?.items ?? []).filter((m) => ok.has(m.id));
          if (!found.length) return 'Nothing in your album from this day a year or a month ago.';
        } else if (q) {
          const words = q.split(/\s+/).filter((w) => w.length > 1);
          found = items.filter((m) => {
            const hay = `${m.caption} ${m.text} ${m.place} ${m.outfit} ${m.takenAt.slice(0, 10)}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          });
        }
        if (!found.length) return items.length ? 'Nothing in your album matches that.' : 'Your album is empty so far.';
        return `${found.slice(0, 12).map((m) => line(app, m)).join('\n')}${found.length > 12 ? `\n(${found.length - 12} more)` : ''}`;
      }
      if (action !== 'show') throw new ToolError('action must be find or show.');
      const id = Number(args.id);
      const m = items.find((x) => x.id === id);
      if (!m) throw new ToolError('No moment with that number here. Use find first.');
      // At most once a day unprompted (when the owner didn't ask about photos or memories).
      const lastUser = (app.store.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(here.id) as Row | undefined)?.content;
      const asked = ASKED_RE.test(String(lastUser ?? ''));
      const today = localDate(app.now().toISOString(), app.settings.get().timeZone);
      if (!asked) {
        if (book.meta('unprompted_day') === today) throw new ToolError('You already brought up a moment today without being asked. Save the next one for another day, or for when they ask.');
        book.setMeta('unprompted_day', today);
      }
      if (m.image) ctx.attachImage?.(m.image);
      return `${m.image ? 'The photo appears with your reply. ' : ''}${line(app, m).slice(2)}${m.text && m.caption ? `\nWhat was said with it: ${m.text.slice(0, 300)}` : ''}\nMention it naturally, in your own words.`;
    },
  };
}

/**
 * "Delete photo everywhere": takes the picture out of every message (their words stay), the
 * scrapbook, the pictures she took and the album, then deletes the file if nothing else uses it.
 */
export function deletePhotoEverywhere(app: AppContext, book: MomentsStore, image: string): { messages: number } {
  if (!IMG_RE.test(image)) throw new Error('Not a photo');
  let messages = 0;
  const rows = app.store.db.prepare(`SELECT id, meta FROM messages WHERE meta LIKE ?`).all(`%${image}%`) as Row[];
  for (const r of rows) {
    const meta = JSON.parse(String(r.meta)) as Record<string, unknown>;
    const imgs = Array.isArray(meta.images) ? (meta.images as unknown[]).map(String) : [];
    if (!imgs.includes(image)) continue;
    app.store.updateMessageMeta(Number(r.id), { images: imgs.filter((x) => x !== image), photoDeleted: true });
    messages++;
  }
  if (app.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scrapbook'").get()) app.store.db.prepare('DELETE FROM scrapbook WHERE image = ?').run(image);
  const ph = app.settings.get().photos;
  if (ph?.taken?.some((x) => x.id === image)) app.settings.update({ photos: { ...ph, taken: ph.taken.filter((x) => x.id !== image) } });
  book.dropImage(image);
  if (!app.store.imagesInUse().has(image)) {
    const f = app.uploads?.get(image);
    if (f) rmSync(f.path, { force: true });
  }
  return { messages };
}
