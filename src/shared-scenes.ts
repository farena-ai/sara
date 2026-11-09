// R1B shared roleplay scenes: pure SQLite storage, triggers and compare-and-swap writes.
// No AppContext, chat or safety imports: eligibility, consent and safety live in
// shared-scenes-policy.ts. Reads never create schema or write; every write is one synchronous
// BEGIN IMMEDIATE transaction with no awaited work inside.
import type { DatabaseSync } from 'node:sqlite';

export const SCENE_LIMITS = {
  scenes: 20, seats: 4, ownerSeats: 3, roomSeats: 1, canonKeys: 40, versionsPerKey: 5,
  canonText: 400, key: 40, title: 80, premise: 1500, eventsPerScene: 200,
} as const;
export const CANON_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class SceneStoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type SceneStatus = 'active' | 'paused';
export type SceneActor = 'owner-ui' | 'owner-turn' | 'system';
export interface Scene {
  id: number; title: string; premise: string; adult: boolean; status: SceneStatus; revision: number;
  createdAt: string; updatedAt: string; lastUsedAt: string;
}
export interface SceneSummary extends Scene { seatCount: number; canonCount: number }
export interface SceneSeat {
  sceneId: number; conversationId: string; audience: 'owner' | 'room'; channel: string;
  channelKey: string | null; roomKind: string | null; roomAdult: boolean; linkedAt: string;
}
export interface CanonSource { conversationId: string; messageId: number; epoch: number }
export interface CanonEntry {
  id: number; sceneId: number; key: string; text: string; version: number; retired: boolean;
  author: 'owner-ui' | 'owner-turn'; source: CanonSource | null; createdAt: string;
}
export interface SceneEvent { id: number; kind: string; actor: SceneActor; conversationId: string | null; revision: number; createdAt: string }
export interface SeatInput { conversationId: string; audience: 'owner' | 'room'; channel: string; channelKey: string | null; roomKind?: string | null; roomAdult?: boolean }
export interface CanonInput { key: string; text: string; author: 'owner-ui' | 'owner-turn'; source?: CanonSource }

type Row = Record<string, string | number | null>;
const toScene = (r: Row): Scene => ({ id: Number(r.id), title: String(r.title), premise: String(r.premise), adult: Number(r.adult) === 1, status: r.status === 'paused' ? 'paused' : 'active', revision: Number(r.revision), createdAt: String(r.created_at), updatedAt: String(r.updated_at), lastUsedAt: String(r.last_used_at) });
const toSeat = (r: Row): SceneSeat => ({ sceneId: Number(r.scene_id), conversationId: String(r.conversation_id), audience: r.audience === 'room' ? 'room' : 'owner', channel: String(r.channel), channelKey: r.channel_key === null ? null : String(r.channel_key), roomKind: r.room_kind === null ? null : String(r.room_kind), roomAdult: Number(r.room_adult) === 1, linkedAt: String(r.linked_at) });
const toCanon = (r: Row): CanonEntry => ({ id: Number(r.id), sceneId: Number(r.scene_id), key: String(r.key), text: String(r.text), version: Number(r.version), retired: Number(r.retired) === 1, author: r.author === 'owner-turn' ? 'owner-turn' : 'owner-ui', source: r.source_conversation_id === null ? null : { conversationId: String(r.source_conversation_id), messageId: Number(r.source_message_id), epoch: Number(r.source_epoch) }, createdAt: String(r.created_at) });
const toEvent = (r: Row): SceneEvent => ({ id: Number(r.id), kind: String(r.kind), actor: String(r.actor) as SceneActor, conversationId: r.conversation_id === null ? null : String(r.conversation_id), revision: Number(r.revision), createdAt: String(r.created_at) });

const STAMP = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/** SQL that bumps the revision of the matched scenes and logs a text-free `revoked` event, then erases. */
function revoke(sceneIds: string, conversation: string, erase: string): string {
  return `UPDATE scenes SET revision=revision+1, updated_at=${STAMP} WHERE id IN (${sceneIds});
    INSERT INTO scene_events (scene_id,kind,actor,conversation_id,revision,created_at)
      SELECT id,'revoked','system',${conversation},revision,${STAMP} FROM scenes WHERE id IN (${sceneIds});
    ${erase}`;
}
const forgotten = (row: 'OLD' | 'NEW') => `coalesce(json_extract(CASE WHEN json_valid(${row}.meta) THEN ${row}.meta ELSE '{}' END,'$.forgotten'),0)`;

/** Called only by ordinary Store setup, after conversation, message and handoff schema. */
export function installSharedSceneSchema(db: DatabaseSync): void {
  const derived = `SELECT scene_id FROM scene_canon WHERE source_conversation_id=OLD.conversation_id AND source_message_id>=OLD.id`;
  const touched = (id: string) => `SELECT scene_id FROM scene_seats WHERE conversation_id=${id} UNION SELECT scene_id FROM scene_canon WHERE source_conversation_id=${id}`;
  db.exec(`CREATE TABLE IF NOT EXISTS scenes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 80),
    premise TEXT NOT NULL DEFAULT '' CHECK(length(premise) <= 1500),
    adult INTEGER NOT NULL DEFAULT 0 CHECK(adult IN (0,1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS scene_seats (
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    audience TEXT NOT NULL CHECK(audience IN ('owner','room')),
    channel TEXT NOT NULL, channel_key TEXT, room_kind TEXT, room_adult INTEGER NOT NULL DEFAULT 0,
    linked_at TEXT NOT NULL, PRIMARY KEY (scene_id, conversation_id));
  CREATE TABLE IF NOT EXISTS scene_canon (id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 40),
    text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 400),
    version INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
    author TEXT NOT NULL CHECK(author IN ('owner-ui','owner-turn')),
    source_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    source_message_id INTEGER, source_epoch INTEGER,
    created_at TEXT NOT NULL, UNIQUE (scene_id, key, version));
  CREATE TABLE IF NOT EXISTS scene_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, actor TEXT NOT NULL, conversation_id TEXT,
    revision INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS scene_canon_scene ON scene_canon(scene_id, key, version DESC);
  CREATE INDEX IF NOT EXISTS scene_canon_source ON scene_canon(source_conversation_id, source_message_id);
  CREATE INDEX IF NOT EXISTS scene_events_scene ON scene_events(scene_id, id DESC);
  CREATE TRIGGER IF NOT EXISTS scene_canon_source_edit AFTER UPDATE OF content, role, meta, conversation_id ON messages
  WHEN (OLD.role IN ('user','assistant') OR NEW.role IN ('user','assistant'))
    AND (OLD.content IS NOT NEW.content OR OLD.role IS NOT NEW.role OR OLD.conversation_id IS NOT NEW.conversation_id OR ${forgotten('OLD')} IS NOT ${forgotten('NEW')})
    AND EXISTS (${derived})
  BEGIN ${revoke(derived, 'OLD.conversation_id', 'DELETE FROM scene_canon WHERE source_conversation_id=OLD.conversation_id AND source_message_id>=OLD.id;')} END;
  CREATE TRIGGER IF NOT EXISTS scene_canon_source_delete AFTER DELETE ON messages
  WHEN OLD.role IN ('user','assistant') AND EXISTS (${derived})
  BEGIN ${revoke(derived, 'OLD.conversation_id', 'DELETE FROM scene_canon WHERE source_conversation_id=OLD.conversation_id AND source_message_id>=OLD.id;')} END;
  CREATE TRIGGER IF NOT EXISTS scene_seat_scope AFTER UPDATE OF workspace,private,channel,channel_key,partner,archived_at,ended_at,mode ON conversations
  WHEN (OLD.workspace IS NOT NEW.workspace OR OLD.private IS NOT NEW.private OR OLD.channel IS NOT NEW.channel
    OR OLD.channel_key IS NOT NEW.channel_key OR OLD.partner IS NOT NEW.partner OR OLD.archived_at IS NOT NEW.archived_at
    OR OLD.ended_at IS NOT NEW.ended_at OR OLD.mode IS NOT NEW.mode) AND EXISTS (${touched('OLD.id')})
  BEGIN ${revoke(touched('OLD.id'), 'OLD.id', 'DELETE FROM scene_canon WHERE source_conversation_id=OLD.id; DELETE FROM scene_seats WHERE conversation_id=OLD.id;')} END;
  CREATE TRIGGER IF NOT EXISTS scene_seat_conversation_delete BEFORE DELETE ON conversations
  WHEN EXISTS (${touched('OLD.id')})
  BEGIN ${revoke(touched('OLD.id'), 'OLD.id', '')} END;`);
  installSceneRoomInvalidation(db);
}

/** B3 creates `rooms` lazily; install only once it exists (rooms.ts and Store reopen), never from a read. */
export function installSceneRoomInvalidation(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scenes'").get()) return;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'").get()) return;
  const matching = (row: 'OLD' | 'NEW') => `SELECT id FROM conversations WHERE channel_key=${row}.key AND (channel=${row}.bridge OR channel=${row}.bridge||'-nsfw')`;
  const ids = (row: 'OLD' | 'NEW') => `SELECT scene_id FROM scene_seats WHERE conversation_id IN (${matching(row)}) UNION SELECT scene_id FROM scene_canon WHERE source_conversation_id IN (${matching(row)})`;
  const erase = (row: 'OLD' | 'NEW') => revoke(ids(row), 'NULL', `DELETE FROM scene_canon WHERE source_conversation_id IN (${matching(row)}); DELETE FROM scene_seats WHERE conversation_id IN (${matching(row)});`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS scene_seat_room_insert AFTER INSERT ON rooms
    WHEN NEW.kind<>'dm' OR NEW.adult<>0 BEGIN ${erase('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS scene_seat_room_update AFTER UPDATE OF bridge,key,kind,adult ON rooms
    WHEN OLD.bridge IS NOT NEW.bridge OR OLD.key IS NOT NEW.key OR OLD.kind IS NOT NEW.kind OR OLD.adult IS NOT NEW.adult
    BEGIN ${erase('OLD')} ${erase('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS scene_seat_room_delete AFTER DELETE ON rooms BEGIN ${erase('OLD')} END;`);
}

const bad = (message: string): never => { throw new SceneStoreError(400, message); };
const missing = (): never => { throw new SceneStoreError(404, 'Scene not found.'); };
const stale = (revision: number): never => { throw new SceneStoreError(409, `This scene changed (now revision ${revision}). Reload it to see the current canon.`); };
const full = (message: string): never => { throw new SceneStoreError(413, message); };

/** Construction and reads are schema-free and read-only. */
export class SharedSceneStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) { this.#db = db; this.#now = now; }

  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  list(): SceneSummary[] {
    return (this.#db.prepare(`SELECT s.*, (SELECT count(*) FROM scene_seats WHERE scene_id=s.id) AS seat_count FROM scenes s ORDER BY s.last_used_at DESC, s.id DESC`).all() as Row[])
      .map(r => ({ ...toScene(r), seatCount: Number(r.seat_count), canonCount: this.canon(Number(r.id)).length }));
  }
  scene(id: number): Scene | undefined {
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    const r = this.#db.prepare('SELECT * FROM scenes WHERE id=?').get(id) as Row | undefined;
    return r ? toScene(r) : undefined;
  }
  seats(sceneId: number): SceneSeat[] { return (this.#db.prepare('SELECT * FROM scene_seats WHERE scene_id=? ORDER BY linked_at, conversation_id').all(sceneId) as Row[]).map(toSeat); }
  seatOf(conversationId: string): SceneSeat | undefined {
    const r = this.#db.prepare('SELECT * FROM scene_seats WHERE conversation_id=?').get(conversationId) as Row | undefined;
    return r ? toSeat(r) : undefined;
  }
  /** Current canon: each key's newest version unless retired; most recently changed first. */
  canon(sceneId: number): CanonEntry[] {
    return (this.#db.prepare(`SELECT c.* FROM scene_canon c WHERE c.scene_id=? AND c.version=(SELECT max(version) FROM scene_canon WHERE scene_id=c.scene_id AND key=c.key) AND c.retired=0 ORDER BY c.created_at DESC, c.id DESC`).all(sceneId) as Row[]).map(toCanon);
  }
  history(sceneId: number, key: string): CanonEntry[] { return (this.#db.prepare('SELECT * FROM scene_canon WHERE scene_id=? AND key=? ORDER BY version DESC').all(sceneId, key) as Row[]).map(toCanon); }
  historyKeys(sceneId: number): string[] { return (this.#db.prepare('SELECT DISTINCT key FROM scene_canon WHERE scene_id=? ORDER BY key').all(sceneId) as Row[]).map(r => String(r.key)); }
  events(sceneId: number, limit: number): SceneEvent[] { return (this.#db.prepare('SELECT id,kind,actor,conversation_id,revision,created_at FROM scene_events WHERE scene_id=? ORDER BY id DESC LIMIT ?').all(sceneId, limit) as Row[]).map(toEvent); }

  // ----- writes (each one transaction; `guard` re-checks eligibility inside it) -----
  #at(): string { return this.#now().toISOString(); }
  #event(sceneId: number, kind: string, actor: SceneActor, conversationId: string | null = null): void {
    const revision = (this.#db.prepare('SELECT revision FROM scenes WHERE id=?').get(sceneId) as Row).revision;
    this.#db.prepare('INSERT INTO scene_events (scene_id,kind,actor,conversation_id,revision,created_at) VALUES (?,?,?,?,?,?)').run(sceneId, kind, actor, conversationId, revision, this.#at());
    this.#db.prepare(`DELETE FROM scene_events WHERE scene_id=? AND id NOT IN (SELECT id FROM scene_events WHERE scene_id=? ORDER BY id DESC LIMIT ${SCENE_LIMITS.eventsPerScene})`).run(sceneId, sceneId);
  }
  #bump(sceneId: number, used = true): Scene {
    const at = this.#at();
    this.#db.prepare(`UPDATE scenes SET revision=revision+1, updated_at=?${used ? ', last_used_at=?' : ''} WHERE id=?`).run(...(used ? [at, at, sceneId] : [at, sceneId]));
    return this.scene(sceneId)!;
  }
  #cas(sceneId: number, expectedRevision: number): Scene {
    const scene = this.scene(sceneId) ?? missing();
    if (!Number.isSafeInteger(expectedRevision) || scene.revision !== expectedRevision) stale(scene.revision);
    return scene;
  }
  #prune(sceneId: number, key: string): void {
    this.#db.prepare(`DELETE FROM scene_canon WHERE scene_id=? AND key=? AND id NOT IN (SELECT id FROM scene_canon WHERE scene_id=? AND key=? ORDER BY version DESC LIMIT ${SCENE_LIMITS.versionsPerKey})`).run(sceneId, key, sceneId, key);
  }
  static title(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > SCENE_LIMITS.title) bad('A scene title needs 1 to 80 characters.');
    return (value as string).trim();
  }
  static premise(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length > SCENE_LIMITS.premise) bad('A premise can have up to 1500 characters.');
    return (value as string).trim();
  }
  static key(value: unknown): string {
    if (typeof value !== 'string' || !CANON_KEY.test(value)) bad('A canon key uses 1 to 40 lower-case letters, digits and dashes, starting with a letter or digit.');
    return value as string;
  }
  static text(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > SCENE_LIMITS.canonText) bad('Canon text needs 1 to 400 characters.');
    return (value as string).trim();
  }

  create(input: { title: unknown; premise?: unknown; adult?: boolean }, guard?: () => void): Scene {
    const title = SharedSceneStore.title(input.title); const premise = SharedSceneStore.premise(input.premise ?? '');
    return this.transaction(() => {
      guard?.();
      if ((this.#db.prepare('SELECT count(*) AS n FROM scenes').get() as Row).n as number >= SCENE_LIMITS.scenes) full('You have 20 scenes, the most there can be. Delete one to start another.');
      const at = this.#at();
      const id = Number(this.#db.prepare('INSERT INTO scenes (title,premise,adult,status,revision,created_at,updated_at,last_used_at) VALUES (?,?,?,?,1,?,?,?)').run(title, premise, input.adult ? 1 : 0, 'active', at, at, at).lastInsertRowid);
      this.#event(id, 'created', 'owner-ui');
      return this.scene(id)!;
    });
  }
  update(id: number, expectedRevision: number, patch: { title?: unknown; premise?: unknown; adult?: boolean; status?: SceneStatus }, guard?: (scene: Scene) => void, actor: SceneActor = 'owner-ui'): Scene {
    const title = patch.title === undefined ? undefined : SharedSceneStore.title(patch.title);
    const premise = patch.premise === undefined ? undefined : SharedSceneStore.premise(patch.premise);
    if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'paused') bad('Status is active or paused.');
    return this.transaction(() => {
      const scene = this.#cas(id, expectedRevision);
      guard?.(scene);
      const next = { title: title ?? scene.title, premise: premise ?? scene.premise, adult: patch.adult ?? scene.adult, status: patch.status ?? scene.status };
      if (next.title === scene.title && next.premise === scene.premise && next.adult === scene.adult && next.status === scene.status) return scene;
      this.#db.prepare('UPDATE scenes SET title=?, premise=?, adult=?, status=? WHERE id=?').run(next.title, next.premise, next.adult ? 1 : 0, next.status, id);
      const bumped = this.#bump(id);
      if (next.adult !== scene.adult) this.#event(id, next.adult ? 'adult_on' : 'adult_off', actor);
      if (next.status !== scene.status) this.#event(id, next.status === 'paused' ? 'paused' : 'resumed', actor);
      if (next.title !== scene.title || next.premise !== scene.premise) this.#event(id, 'updated', actor);
      return bumped;
    });
  }
  /** The stop word: no revision check (it is the owner's own turn), pauses at once. */
  pause(id: number, actor: SceneActor, conversationId: string): boolean {
    return this.transaction(() => {
      const scene = this.scene(id);
      if (!scene || scene.status === 'paused') return false;
      this.#db.prepare("UPDATE scenes SET status='paused' WHERE id=?").run(id);
      this.#bump(id);
      this.#event(id, 'paused', actor, conversationId);
      return true;
    });
  }
  /** A refused canon write leaves a text-free `blocked` event (its own small transaction). */
  blocked(id: number, actor: SceneActor, conversationId: string | null = null): void {
    this.transaction(() => { if (this.scene(id)) this.#event(id, 'blocked', actor, conversationId); });
  }
  remove(id: number, expectedRevision: number, guard?: () => void): void {
    this.transaction(() => { this.#cas(id, expectedRevision); guard?.(); this.#db.prepare('DELETE FROM scenes WHERE id=?').run(id); });
  }
  link(id: number, expectedRevision: number, seat: SeatInput, guard?: (scene: Scene) => void): { scene: Scene; seat: SceneSeat } {
    return this.transaction(() => {
      const scene = this.#cas(id, expectedRevision);
      guard?.(scene);
      if (this.seatOf(seat.conversationId)) throw new SceneStoreError(409, 'That conversation is already in a scene. Remove it there first.');
      const seats = this.seats(id);
      if (seats.length >= SCENE_LIMITS.seats) full('A scene can have 4 linked conversations.');
      if (seat.audience === 'owner' && seats.filter(s => s.audience === 'owner').length >= SCENE_LIMITS.ownerSeats) full('A scene can have 3 of your own conversations.');
      if (seat.audience === 'room' && seats.some(s => s.audience === 'room')) throw new SceneStoreError(409, 'This scene already has its one shared room.');
      this.#db.prepare('INSERT INTO scene_seats (scene_id,conversation_id,audience,channel,channel_key,room_kind,room_adult,linked_at) VALUES (?,?,?,?,?,?,?,?)').run(id, seat.conversationId, seat.audience, seat.channel, seat.channelKey, seat.roomKind ?? null, seat.roomAdult ? 1 : 0, this.#at());
      const bumped = this.#bump(id);
      this.#event(id, 'linked', 'owner-ui', seat.conversationId);
      return { scene: bumped, seat: this.seatOf(seat.conversationId)! };
    });
  }
  /** Removing a seat erases canon taken from its lines (owner decision Q4); typed canon stays. */
  unlink(id: number, expectedRevision: number, conversationId: string, guard?: () => void): { scene: Scene; erasedCanon: number } {
    return this.transaction(() => {
      this.#cas(id, expectedRevision); guard?.();
      const seat = this.seatOf(conversationId);
      if (!seat || seat.sceneId !== id) missing();
      const erased = Number(this.#db.prepare('DELETE FROM scene_canon WHERE scene_id=? AND source_conversation_id=?').run(id, conversationId).changes);
      this.#db.prepare('DELETE FROM scene_seats WHERE scene_id=? AND conversation_id=?').run(id, conversationId);
      const bumped = this.#bump(id);
      this.#event(id, 'unlinked', 'owner-ui', conversationId);
      return { scene: bumped, erasedCanon: erased };
    });
  }
  setCanon(id: number, expectedRevision: number, input: CanonInput, guard?: (scene: Scene) => void): { scene: Scene; entry: CanonEntry; changed: boolean } {
    const key = SharedSceneStore.key(input.key); const text = SharedSceneStore.text(input.text);
    return this.transaction(() => {
      const scene = this.#cas(id, expectedRevision);
      guard?.(scene);
      const latest = this.history(id, key)[0];
      if (latest && !latest.retired && latest.text === text) return { scene, entry: latest, changed: false };
      if ((!latest || latest.retired) && this.canon(id).length >= SCENE_LIMITS.canonKeys) full('A scene can have 40 canon facts. Retire one first.');
      const source = input.source;
      this.#db.prepare('INSERT INTO scene_canon (scene_id,key,text,version,retired,author,source_conversation_id,source_message_id,source_epoch,created_at) VALUES (?,?,?,?,0,?,?,?,?,?)')
        .run(id, key, text, (latest?.version ?? 0) + 1, input.author, source?.conversationId ?? null, source?.messageId ?? null, source?.epoch ?? null, this.#at());
      this.#prune(id, key);
      const bumped = this.#bump(id);
      this.#event(id, 'canon_set', input.author, source?.conversationId ?? null);
      return { scene: bumped, entry: this.history(id, key)[0], changed: true };
    });
  }
  /** `author` is 'owner-turn' only for her approved `scene_canon` retire in the owner's own seat (R1B2). */
  retire(id: number, expectedRevision: number, key: string, guard?: () => void, author: 'owner-ui' | 'owner-turn' = 'owner-ui', conversationId: string | null = null): { scene: Scene } {
    return this.transaction(() => {
      this.#cas(id, expectedRevision); guard?.();
      const latest = this.history(id, key)[0];
      if (!latest || latest.retired) missing();
      this.#db.prepare("INSERT INTO scene_canon (scene_id,key,text,version,retired,author,created_at) VALUES (?,?,'(retired)',?,1,?,?)").run(id, key, latest.version + 1, author, this.#at());
      this.#prune(id, key);
      const bumped = this.#bump(id);
      this.#event(id, 'canon_retired', author, conversationId);
      return { scene: bumped };
    });
  }
  reset(id: number, expectedRevision: number, guard?: () => void): { scene: Scene } {
    return this.transaction(() => {
      this.#cas(id, expectedRevision); guard?.();
      this.#db.prepare('DELETE FROM scene_canon WHERE scene_id=?').run(id);
      const bumped = this.#bump(id);
      this.#event(id, 'reset', 'owner-ui');
      return { scene: bumped };
    });
  }
}
