// EC17 (docs/ops/EC1617_DESIGN.md, docs/DATA_RIGHTS.md): retention per data kind, legal hold (one
// person or the whole server) and per-person export and delete with a receipt. One file,
// `<data>/data-rights.json`. The hold itself is enforced at the bottom layer (src/legal-hold.ts);
// this module decides who is held, runs retention on the hourly household tick and builds exports.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { exportAll } from './export.ts';
import { writeFileAtomic } from './fs-util.ts';
import { HttpError } from './http.ts';
import { LegalHoldError, setDbHold, setHoldResolver } from './legal-hold.ts';
import { policy } from './policy-profile.ts';
import { zipStored, type ZipFileIn } from './zip-write.ts';

export const DATA_RIGHTS_FILE = 'data-rights.json';
export const RETENTION_KINDS = ['chats', 'memories', 'files'] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];
/** Days a kind is kept (0 = keep everything, the default: today's behaviour). */
export const KEEP_DAYS = [0, 30, 90, 365, 730] as const;
export const OWNER = 'owner';

/**
 * Every path that deletes a person's chats, memories, files or audit rows, and how a hold stops it.
 * test/ec17-data-rights.test.ts drives each id while held; a new id without a test fails there.
 */
export const DELETE_PATHS = [
  { id: 'chat.delete', kind: 'chats', where: 'Store.deleteConversation (Delete, bridges, imports, routines)', guard: 'assertNotHeld + trigger' },
  { id: 'chat.trim', kind: 'chats', where: 'Store.deleteMessagesFrom (edit, regenerate)', guard: 'assertNotHeld + trigger' },
  { id: 'chat.sql', kind: 'chats', where: 'any other DELETE FROM conversations/messages', guard: 'trigger' },
  { id: 'memory.forget', kind: 'memories', where: 'MemoryStore.delete (Forget, people cards, undo)', guard: 'assertNotHeld + trigger' },
  { id: 'memory.conversation', kind: 'memories', where: 'MemoryStore.deleteForConversation (delete and forget)', guard: 'assertNotHeld + trigger' },
  { id: 'memory.sql', kind: 'memories', where: 'any other DELETE FROM memories', guard: 'trigger' },
  { id: 'memory.tidy', kind: 'memories', where: 'MemoryTidy.run (overnight tidy, Tidy now)', guard: 'refused (409) while held' },
  { id: 'file.library', kind: 'files', where: 'LibraryStore.delete / deleteForConversation', guard: 'assertNotHeld + trigger' },
  { id: 'file.photo', kind: 'files', where: 'UploadStore.remove', guard: 'heldDir' },
  { id: 'file.photo-prune', kind: 'files', where: 'UploadStore.prune', guard: 'heldDir' },
  { id: 'retention.run', kind: 'all', where: 'DataRights.runRetention (hourly household tick)', guard: 'held spaces skipped' },
  { id: 'person.delete', kind: 'all', where: 'DataRights.deletePerson (Retention and legal hold → Delete)', guard: 'heldDir + pin' },
  { id: 'household.delete', kind: 'all', where: 'HouseholdStore.deleteMember (Delete now, Delete my account, leaving sweep)', guard: 'heldDir' },
  { id: 'audit.prune', kind: 'audit', where: 'AuditTrail.prune (retention, settings change)', guard: 'anyHold' },
] as const;

export interface Retention { chats: number; memories: number; files: number }
export interface Holds { instance: boolean; people: string[] }
interface DataRightsFile { version: 1; retention: Retention; holds: Holds; updatedAt: string | null }
/** One person's space: the owner (the data folder) or a household member (members/<id>). */
export interface PersonSpace { person: string; name: string; dir: string; apps: () => AppContext[] }
export interface DataRightsHost { spaces: () => PersonSpace[]; deleteMember: (id: string) => Promise<void> }
export interface DeletionReceipt { person: string; deletedAt: string; before: Counts; folderGone: boolean; recordGone: boolean }
interface Counts { conversations: number; messages: number; memories: number; files: number }

const DEFAULTS: DataRightsFile = { version: 1, retention: { chats: 0, memories: 0, files: 0 }, holds: { instance: false, people: [] }, updatedAt: null };
const PERSON_RE = /^(owner|[a-f0-9]{10})$/;
const count = (app: AppContext, sql: string): number => {
  try {
    return Number((app.store.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
};

export class DataRights {
  readonly root: string;
  readonly #file: string;
  readonly #host?: DataRightsHost;
  readonly #now: () => Date;
  #cur: DataRightsFile;

  constructor(root: string, host?: DataRightsHost, now: () => Date = () => new Date()) {
    this.root = resolve(root);
    this.#file = join(root, DATA_RIGHTS_FILE);
    this.#host = host;
    this.#now = now;
    this.#cur = structuredClone(DEFAULTS);
    if (existsSync(this.#file)) {
      try {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<DataRightsFile>;
        this.#cur = { version: 1, retention: { ...DEFAULTS.retention, ...raw.retention }, holds: { instance: raw.holds?.instance === true, people: (raw.holds?.people ?? []).filter((p) => PERSON_RE.test(p)) }, updatedAt: raw.updatedAt ?? null };
      } catch {
        // A damaged file must not quietly release a hold: hold everything until it is fixed.
        console.warn('data rights: the settings file is damaged; the whole server is on hold until it is saved again.');
        this.#cur = { ...structuredClone(DEFAULTS), holds: { instance: true, people: [] } };
      }
    }
  }

  get retention(): Retention {
    return { ...this.#cur.retention };
  }
  get holds(): Holds {
    return { instance: this.#cur.holds.instance || policy().pins.legalHold === true, people: [...this.#cur.holds.people] };
  }
  /** `owner` for the data folder and its companions; the member id for members/<id>/…; undefined outside. */
  personOf(dir: string): string | undefined {
    const rel = relative(this.root, resolve(dir));
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
    const parts = rel.split(sep).filter(Boolean);
    return parts[0] === 'members' && parts[1] ? parts[1] : OWNER;
  }
  held(dir: string): boolean {
    const h = this.holds;
    const person = this.personOf(dir);
    return person !== undefined && (h.instance || h.people.includes(person));
  }
  anyHeld(): boolean {
    const h = this.holds;
    return h.instance || h.people.length > 0;
  }
  /** Becomes the server's answer for heldDir()/anyHold(). */
  install(): this {
    setHoldResolver({ held: (d) => this.held(d), any: () => this.anyHeld() });
    return this;
  }
  #save(): void {
    this.#cur.updatedAt = this.#now().toISOString();
    writeFileAtomic(this.#file, JSON.stringify(this.#cur, null, 2) + '\n');
  }
  /** Brings every space's database in line with the holds (startup, a change, a new companion). */
  apply(apps?: { dir: string; app: AppContext }[]): void {
    const list = apps ?? (this.#host?.spaces() ?? []).flatMap((s) => s.apps().map((app) => ({ dir: app.dataDir, app })));
    for (const { dir, app } of list) setDbHold(app.store.db, this.held(dir), this.#now());
  }

  setRetention(input: unknown): Retention {
    const o = (input ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!(RETENTION_KINDS as readonly string[]).includes(k)) throw new HttpError(400, 'Unknown field {key}.', { params: { key: k } });
    const next = { ...this.#cur.retention };
    for (const k of RETENTION_KINDS) {
      if (o[k] === undefined) continue;
      if (!(KEEP_DAYS as readonly unknown[]).includes(o[k])) throw new HttpError(400, 'Pick 30, 90, 365 or 730 days, or keep everything.');
      next[k] = Number(o[k]);
    }
    const changed = RETENTION_KINDS.filter((k) => next[k] !== this.#cur.retention[k]);
    this.#cur.retention = next;
    this.#save();
    if (changed.length) audit({ action: 'data.retention', target: 'server', keys: changed.map((k) => `${k}_${next[k]}`) });
    return this.retention;
  }

  setHolds(input: unknown): Holds {
    const o = (input ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'instance' && k !== 'people') throw new HttpError(400, 'Unknown field {key}.', { params: { key: k } });
    const next: Holds = { ...this.#cur.holds, people: [...this.#cur.holds.people] };
    if (o.instance !== undefined) {
      if (typeof o.instance !== 'boolean') throw new HttpError(400, 'instance must be true or false.');
      if (!o.instance) policy().guard('legalHold', true);
      next.instance = o.instance;
    }
    if (o.people !== undefined) {
      if (!Array.isArray(o.people) || o.people.length > 50 || o.people.some((p) => typeof p !== 'string' || !PERSON_RE.test(p))) throw new HttpError(400, 'people must list owner or member ids.');
      const known = new Set([OWNER, ...(this.#host?.spaces() ?? []).map((s) => s.person)]);
      if (this.#host && o.people.some((p) => !known.has(p as string))) throw new HttpError(404, 'No such person.');
      next.people = [...new Set(o.people as string[])];
    }
    const before = this.#cur.holds;
    const keys = [...(before.instance !== next.instance ? [`instance_${next.instance ? 'on' : 'off'}`] : []), ...next.people.filter((p) => !before.people.includes(p)).map((p) => `on_${p}`), ...before.people.filter((p) => !next.people.includes(p)).map((p) => `off_${p}`)];
    this.#cur.holds = next;
    this.#save();
    this.apply();
    if (keys.length) audit({ action: 'data.hold', target: 'server', keys });
    return this.holds;
  }

  // ---- retention ----
  /** Deletes what is past each kind's window in every space that is not held. Returns the counts. */
  runRetention(spaces: PersonSpace[] = this.#host?.spaces() ?? []): { chats: number; memories: number; files: number; heldSpaces: number } {
    const r = this.#cur.retention;
    const out = { chats: 0, memories: 0, files: 0, heldSpaces: 0 };
    if (!r.chats && !r.memories && !r.files) return out;
    const now = this.#now().getTime();
    const cutoff = (days: number) => new Date(now - days * 86_400_000).toISOString();
    for (const space of spaces) {
      if (this.held(space.dir)) {
        out.heldSpaces++;
        continue;
      }
      for (const app of space.apps()) {
        if (this.held(app.dataDir)) continue;
        if (r.chats) {
          for (const row of app.store.db.prepare('SELECT id FROM conversations WHERE updated_at < ?').all(cutoff(r.chats)) as { id: string }[]) {
            app.library?.deleteForConversation(row.id);
            if (app.store.deleteConversation(row.id)) out.chats++;
          }
        }
        if (r.memories && app.memory) {
          for (const m of app.memory.listAll()) {
            if (m.pinned || m.updatedAt >= cutoff(r.memories)) continue;
            if (app.memory.delete(m.id)) {
              app.vectors?.forget(m.id);
              out.memories++;
            }
          }
        }
        if (r.files) {
          for (const doc of app.library?.list() ?? []) if (doc.addedAt < cutoff(r.files) && doc.origin !== 'room-archive' && app.library!.delete(doc.id)) out.files++;
          const dir = app.uploads?.dir;
          if (dir && existsSync(dir)) for (const name of readdirSync(dir)) if (statSync(join(dir, name)).mtimeMs < now - r.files * 86_400_000 && app.uploads!.remove(name)) out.files++;
        }
      }
    }
    if (out.chats || out.memories || out.files || out.heldSpaces) audit({ action: 'retention.run', role: 'system', who: 'system', channel: 'system', keys: [`chats_${out.chats}`, `memories_${out.memories}`, `files_${out.files}`, `held_${out.heldSpaces}`] });
    return out;
  }

  // ---- export and delete ----
  #space(person: unknown): PersonSpace {
    if (typeof person !== 'string' || !PERSON_RE.test(person)) throw new HttpError(400, 'Pick a person.');
    const space = (this.#host?.spaces() ?? []).find((s) => s.person === person);
    if (!space) throw new HttpError(404, 'No such person.');
    return space;
  }
  counts(space: PersonSpace): Counts {
    const c: Counts = { conversations: 0, messages: 0, memories: 0, files: 0 };
    for (const app of space.apps()) {
      c.conversations += count(app, 'SELECT COUNT(*) AS n FROM conversations');
      c.messages += count(app, 'SELECT COUNT(*) AS n FROM messages');
      c.memories += count(app, 'SELECT COUNT(*) AS n FROM memories');
      c.files += count(app, 'SELECT COUNT(*) AS n FROM library_docs') + (app.uploads && existsSync(app.uploads.dir) ? readdirSync(app.uploads.dir).length : 0);
    }
    return c;
  }
  /** A zip of one person's data: per companion export.json, photos and library files, and a manifest. */
  exportPerson(person: unknown): { zip: Buffer; name: string } {
    const space = this.#space(person);
    const files: ZipFileIn[] = [];
    const libraries = new Set<unknown>();
    const add = (path: string, data: Uint8Array) => files.push({ path, data });
    for (const app of space.apps()) {
      const rel = relative(space.dir, app.dataDir).split(sep).filter(Boolean);
      const base = rel.length ? `companions/${rel[rel.length - 1]}` : 'main';
      add(`${base}/export.json`, Buffer.from(JSON.stringify(exportAll(app), null, 2) + '\n'));
      const up = app.uploads?.dir;
      if (up && existsSync(up)) for (const name of readdirSync(up).sort()) add(`${base}/photos/${name}`, readFileSync(join(up, name)));
      // A companion that shares the main library is exported once.
      if (app.library && !libraries.has(app.library)) {
        libraries.add(app.library);
        for (const doc of app.library?.list() ?? []) {
          const path = app.library!.filePath(doc);
          if (path && existsSync(path)) add(`${base}/library/${doc.id}-${doc.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120)}`, readFileSync(path));
        }
      }
    }
    const at = this.#now().toISOString();
    const manifest = { format: 'sara-person-export', version: 1, person: space.person, exportedAt: at, files: files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex') })) };
    add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    audit({ action: 'data.person-export', target: space.person, keys: [`files_${files.length}`] });
    return { zip: zipStored(files), name: `sara-${space.person === OWNER ? 'owner' : 'member'}-${at.slice(0, 10)}.zip` };
  }
  /** Deletes a household member's whole space (never the owner's) and returns the proof. */
  async deletePerson(person: unknown, confirm: unknown): Promise<DeletionReceipt> {
    const space = this.#space(person);
    if (space.person === OWNER) throw new HttpError(400, 'The owner’s data goes only with the whole server.');
    if (confirm !== true) throw new HttpError(400, 'Confirm the deletion first.');
    if (policy().pins.personDelete === false) throw policy().refusal('personDelete');
    if (this.held(space.dir)) {
      audit({ action: 'data.person-delete', target: space.person, outcome: 'refused', keys: ['hold'] });
      throw new LegalHoldError();
    }
    const before = this.counts(space);
    await this.#host!.deleteMember(space.person);
    const receipt: DeletionReceipt = { person: space.person, deletedAt: this.#now().toISOString(), before, folderGone: !existsSync(space.dir), recordGone: !(this.#host?.spaces() ?? []).some((s) => s.person === space.person) };
    this.#cur.holds.people = this.#cur.holds.people.filter((p) => p !== space.person);
    this.#save();
    audit({ action: 'data.person-delete', target: space.person, outcome: receipt.folderGone && receipt.recordGone ? 'ok' : 'failed', keys: Object.entries(before).map(([k, v]) => `${k}_${v}`) });
    return receipt;
  }

  view() {
    const people = (this.#host?.spaces() ?? []).map((s) => ({ person: s.person, name: s.name, held: this.held(s.dir), counts: this.counts(s) }));
    return { retention: this.retention, holds: this.holds, choices: KEEP_DAYS, people, pinned: { legalHold: policy().pins.legalHold === true, personDelete: policy().pins.personDelete === false }, deletePaths: DELETE_PATHS.length, updatedAt: this.#cur.updatedAt };
  }
}

// ---- the server's one service (set by main.ts; tests set their own) ----
let current: DataRights | undefined;
export function setDataRights(d: DataRights | undefined): void {
  current = d;
  if (d) d.install();
  else setHoldResolver(undefined);
}
export function dataRights(): DataRights | undefined {
  return current;
}
