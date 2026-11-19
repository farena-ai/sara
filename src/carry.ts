// W5.3 (docs/design/W5BACKUP.md): backups you can carry. The recovery key (in the vault, shown once
// on a printed sheet), sealed copies to drives/folders and to a linked Sara on a schedule with
// retention, what this server holds for linked friends, and the guided restore on a new computer
// (open with the sheet → checks-only drill → staged → applied at the next start).
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BACKUPS_DIR, backupName, listBackups, restoreBackup } from './backup.ts';
import { createBackupAsync } from './backup-async.ts';
import { CARRY_EXT, CarryError, carryFingerprint, fingerprintHex, isCarry, keyFromWords, makeRecoveryKey, openCarryFile, qrTextOf, sealCarryFile, wordsOf } from './carry-key.ts';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { runRestoreDrill, type DrillRecord } from './restore-drill.ts';
import { signSupport, SupportError } from './support.ts';

export const RECOVERY_VAULT = 'backup:recovery';
export const STAGED_DIR = 'restore-staged';
export const HELD_DIR = 'carry-held';
export const CARRY_FOLDER = 'Sara backups';
/** One peer part: 4 MB of sealed bytes (base64 in a signed JSON body). */
export const PART = 4 * 1024 * 1024;
export const CARRY_PEER_MAX = Math.ceil((PART * 4) / 3) + 64 * 1024;
export const CARRY_OPS = ['begin', 'part', 'end', 'list', 'drop'] as const;
const NAME = /^sara-[\w-]{1,80}\.sara$/;
const DAY = 86_400_000;

export interface CarryTarget {
  id: string;
  kind: 'folder' | 'peer';
  /** folder: the drive or folder; copies go to `<path>/Sara backups/`. */
  path?: string;
  /** peer: the S9a link id. */
  link?: string;
  every: 'day' | 'week';
  keep: number;
  last?: { at: string; ok: boolean; name?: string; error?: string };
  /** The drive is not plugged in (since when). */
  waiting?: boolean;
  waitingSince?: string;
}
export interface CarrySettings {
  sheet?: { madeAt: string; confirmedAt?: string; fp: string };
  targets?: CarryTarget[];
  hold?: Record<string, { on: boolean; maxMb: number }>;
}

export class CarryHttp extends Error {
  readonly status: number;
  readonly params?: Record<string, unknown>;
  constructor(status: number, message: string, params?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (params) this.params = params;
  }
}

// ---- seams (tests) ------------------------------------------------------------------------------
export interface CarryDeps {
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  statfs: (p: string) => { free: number; total: number } | undefined;
  systemDrive: string;
  volumes: string;
  /** Linux: mount points to look at instead of /media, /run/media and /mnt. */
  mounts?: string[];
}
const realDeps = (): CarryDeps => ({
  platform: process.platform,
  exists: (p) => existsSync(p),
  statfs: (p) => {
    try {
      const s = statfsSync(p);
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch {
      return undefined;
    }
  },
  systemDrive: (process.env.SystemDrive ?? 'C:').toUpperCase(),
  volumes: '/Volumes',
});
let deps: CarryDeps = realDeps();
export function setCarryDeps(d: Partial<CarryDeps> = {}): void {
  deps = { ...realDeps(), ...d };
}

const settingsOf = (app: AppContext): CarrySettings => ((app.settings.get() as { carry?: CarrySettings }).carry ?? {});
const save = (app: AppContext, next: CarrySettings) => app.settings.update({ carry: next } as never);
const rootOf = (app: AppContext) => app.rootDir ?? app.dataDir;

// ---- drives ---------------------------------------------------------------------------------------
export interface Drive {
  path: string;
  name: string;
  system: boolean;
  free?: number;
  total?: number;
}
const subdirs = (d: string) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name));
  } catch {
    return [];
  }
};
/** Drives and mounted disks this computer can see (Windows letters, macOS volumes, Linux mounts). */
export function listDrives(): Drive[] {
  const out: Drive[] = [];
  const add = (path: string, name: string, system: boolean) => out.push({ path, name, system, ...(deps.statfs(path) ?? {}) });
  if (deps.platform === 'win32') {
    for (let c = 67; c <= 90; c++) {
      const L = `${String.fromCharCode(c)}:`;
      if (deps.exists(`${L}\\`)) add(`${L}\\`, L, L === deps.systemDrive);
    }
  } else if (deps.platform === 'darwin') {
    for (const p of subdirs(deps.volumes)) add(p, basename(p), basename(p) === 'Macintosh HD');
  } else {
    const roots = deps.mounts ?? [...subdirs('/media').flatMap((d) => [d, ...subdirs(d)]), ...subdirs('/run/media').flatMap(subdirs), ...subdirs('/mnt')];
    for (const p of [...new Set(roots)]) add(p, basename(p), false);
  }
  return out;
}

// ---- the recovery key + sheet -------------------------------------------------------------------
export function recoveryKey(app: AppContext): Buffer | undefined {
  const hex = app.vault.get(RECOVERY_VAULT);
  return hex && /^[0-9a-f]{32}$/.test(hex) ? Buffer.from(hex, 'hex') : undefined;
}
/** Makes a new key + sheet (not confirmed yet). A confirmed sheet is replaced only on purpose. */
export function newSheet(app: AppContext, again: boolean): { words: string[]; qrText: string; madeAt: string } {
  const cur = settingsOf(app);
  if (cur.sheet?.confirmedAt && recoveryKey(app) && !again) throw new CarryHttp(409, en('You already have a recovery sheet. Make a new one only if the old one is lost.'));
  const key = makeRecoveryKey();
  app.vault.set(RECOVERY_VAULT, key.toString('hex'));
  const madeAt = app.now().toISOString();
  save(app, { ...cur, sheet: { madeAt, fp: fingerprintHex(key) } });
  return { words: wordsOf(key), qrText: qrTextOf(key), madeAt };
}
/** The sheet while it is not confirmed yet; 410 afterwards (shown once). */
export function pendingSheet(app: AppContext): { words: string[]; qrText: string; madeAt: string } {
  const sh = settingsOf(app).sheet;
  const key = recoveryKey(app);
  if (!sh || !key) throw new CarryHttp(404, en('There is no recovery sheet yet.'));
  if (sh.confirmedAt) throw new CarryHttp(410, en('The recovery sheet was shown once and is not shown again. Make a new sheet if you lost it.'));
  return { words: wordsOf(key), qrText: qrTextOf(key), madeAt: sh.madeAt };
}
export function confirmSheet(app: AppContext): void {
  const cur = settingsOf(app);
  if (!cur.sheet || !recoveryKey(app)) throw new CarryHttp(404, en('There is no recovery sheet yet.'));
  save(app, { ...cur, sheet: { ...cur.sheet, confirmedAt: cur.sheet.confirmedAt ?? app.now().toISOString() } });
}
function readyKey(app: AppContext): Buffer {
  const key = recoveryKey(app);
  if (!key || !settingsOf(app).sheet?.confirmedAt) throw new CarryHttp(409, en('Make and print your recovery sheet first: carried copies are sealed with it.'));
  return key;
}

// ---- targets --------------------------------------------------------------------------------------
const fullPath = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
export function addTarget(app: AppContext, b: Record<string, unknown>): CarryTarget {
  readyKey(app);
  const cur = settingsOf(app);
  const t: CarryTarget = { id: randomUUID().slice(0, 8), kind: b.kind === 'peer' ? 'peer' : 'folder', every: b.every === 'week' ? 'week' : 'day', keep: clampKeep(b.keep) };
  if (t.kind === 'folder') t.path = checkFolder(b.path);
  else {
    const link = String(b.link ?? '');
    if (!app.messages?.peer(link)) throw new CarryHttp(400, en('Pick a linked Sara (Messages → link a server first).'));
    t.link = link;
  }
  if ((cur.targets ?? []).length >= 8) throw new CarryHttp(400, en('Up to 8 places to carry copies to.'));
  save(app, { ...cur, targets: [...(cur.targets ?? []), t] });
  return t;
}
const clampKeep = (v: unknown) => Math.max(1, Math.min(60, Math.round(Number(v) || 4)));
function checkFolder(v: unknown, allowMissing = false): string {
  const p = String(v ?? '').trim();
  if (!p || !fullPath(p)) throw new CarryHttp(400, en('Use a full folder path, like {example}.'), { example: process.platform === 'win32' ? 'E:\\' : process.platform === 'darwin' ? '/Volumes/USB' : '/media/usb' });
  if (!allowMissing && !existsSync(p)) throw new CarryHttp(400, en('That drive or folder is not there. Plug the drive in and try again.'));
  return p;
}
export function updateTarget(app: AppContext, id: string, b: Record<string, unknown>): void {
  const cur = settingsOf(app);
  const targets = (cur.targets ?? []).map((t) => {
    if (t.id !== id) return t;
    const n = { ...t };
    if (b.every !== undefined) n.every = b.every === 'week' ? 'week' : 'day';
    if (b.keep !== undefined) n.keep = clampKeep(b.keep);
    if (b.path !== undefined && t.kind === 'folder') n.path = checkFolder(b.path, b.allowMissing === true);
    return n;
  });
  if (!targets.some((t) => t.id === id)) throw new CarryHttp(404, en('No such place.'));
  save(app, { ...cur, targets });
}
export function removeTarget(app: AppContext, id: string): void {
  const cur = settingsOf(app);
  save(app, { ...cur, targets: (cur.targets ?? []).filter((t) => t.id !== id) });
}
function patchTarget(app: AppContext, id: string, p: Partial<CarryTarget>, drop: (keyof CarryTarget)[] = []): void {
  const cur = settingsOf(app);
  save(app, {
    ...cur,
    targets: (cur.targets ?? []).map((t) => {
      if (t.id !== id) return t;
      const n = { ...t, ...p };
      for (const k of drop) delete n[k];
      return n;
    }),
  });
}

/** Is a copy due? (the last good copy is older than its interval, less an hour of slack) */
export function carryDue(t: Pick<CarryTarget, 'every' | 'last'>, now: Date): boolean {
  if (!t.last?.ok) return true;
  const span = (t.every === 'week' ? 7 : 1) * DAY - 3600_000;
  return now.getTime() - Date.parse(t.last.at) >= span;
}

const sealedName = (backup: string) => `${backup.replace(/\.tar\.gz$/, '')}${CARRY_EXT}`;
const folderOf = (t: CarryTarget) => join(t.path!, CARRY_FOLDER);
function readme(dir: string): void {
  const f = join(dir, 'README.txt');
  if (existsSync(f)) return;
  writeFileSync(f, 'Sealed Sara backups (.sara files).\r\n\r\nThey open only with the recovery sheet you printed. To restore on a new computer: install Sara, then Settings -> Privacy & system -> Backups -> Restore on a new computer, and type the 18 words from the sheet.\r\n');
}

/** Seals `file` (a local backup) and puts it in the target; records the result. */
async function carryOne(app: AppContext, t: CarryTarget, file: string, name: string): Promise<string> {
  const key = readyKey(app);
  const root = rootOf(app);
  mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
  const sealed = join(root, 'tmp', `carry-${randomUUID()}${CARRY_EXT}`);
  const at = app.now().toISOString();
  try {
    await sealCarryFile(file, sealed, key);
    if (t.kind === 'folder') {
      if (!t.path || !existsSync(t.path)) {
        patchTarget(app, t.id, { waiting: true, waitingSince: t.waitingSince ?? at });
        throw new CarryHttp(409, en('The drive is not plugged in. Sara copies there as soon as it is back.'));
      }
      const dir = folderOf(t);
      mkdirSync(dir, { recursive: true });
      readme(dir);
      copyFileSync(sealed, join(dir, `${name}.partial`));
      renameSync(join(dir, `${name}.partial`), join(dir, name));
      const mine = readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse();
      for (const old of mine.slice(t.keep)) rmSync(join(dir, old), { force: true });
    } else await sendToPeer(app, t.link!, sealed, name, t.keep);
    patchTarget(app, t.id, { last: { at, ok: true, name } }, ['waiting', 'waitingSince']);
    return name;
  } catch (err) {
    if (!(err instanceof CarryHttp && err.status === 409 && t.kind === 'folder')) patchTarget(app, t.id, { last: { at, ok: false, error: (err as Error).message.slice(0, 300) } });
    throw err;
  } finally {
    rmSync(sealed, { force: true });
  }
}

/** Copy now: a fresh backup, sealed, straight to the target (no extra local backup is kept). */
export async function copyNow(app: AppContext, id: string, version?: string): Promise<string> {
  readyKey(app);
  const t = (settingsOf(app).targets ?? []).find((x) => x.id === id);
  if (!t) throw new CarryHttp(404, en('No such place.'));
  const root = rootOf(app);
  mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
  const base = backupName(app.now());
  const file = join(root, 'tmp', `carry-src-${randomUUID()}.tar.gz`);
  try {
    await createBackupAsync(root, file, { saraVersion: version, now: app.now() });
    return await carryOne(app, t, file, sealedName(base));
  } finally {
    rmSync(file, { force: true });
  }
}

export interface TickResult {
  id: string;
  copied?: string;
  waiting?: boolean;
  error?: string;
}
/** The hourly tick: each due target gets the newest local backup. Never throws. */
export async function carryTick(app: AppContext, root = rootOf(app)): Promise<TickResult[]> {
  const out: TickResult[] = [];
  if (!recoveryKey(app) || !settingsOf(app).sheet?.confirmedAt) return out;
  const now = app.now();
  for (const t of settingsOf(app).targets ?? []) {
    if (!carryDue(t, now)) continue;
    if (t.kind === 'folder' && (!t.path || !existsSync(t.path))) {
      patchTarget(app, t.id, { waiting: true, waitingSince: t.waitingSince ?? now.toISOString() });
      out.push({ id: t.id, waiting: true });
      continue;
    }
    const newest = listBackups(root)[0];
    if (!newest) continue;
    const name = sealedName(newest.name);
    if (t.last?.ok && t.last.name === name) continue;
    try {
      out.push({ id: t.id, copied: await carryOne(app, t, join(root, BACKUPS_DIR, newest.name), name) });
    } catch (err) {
      out.push({ id: t.id, error: (err as Error).message });
    }
  }
  return out;
}

// ---- another Sara (sender side) -------------------------------------------------------------------
async function peerCall(app: AppContext, link: string, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const m = app.messages;
  const p = m?.peer(link);
  const key = m?.privateKeyFor(link);
  if (!m || !p || !key) throw new CarryHttp(404, en('That link is gone. Link the servers again under Messages.'));
  const body = JSON.stringify({ v: 1, id: randomUUID(), ...payload });
  let res: Response;
  try {
    res = await m.peerFetch(`${p.url}/msg/v1/carry/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(link, op, body, key, app.now(), 'carry') }, body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new CarryHttp(502, en('The other server did not answer. Check its address and try again.'));
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 403) throw new CarryHttp(403, en("{name}'s Sara doesn't keep backups for you yet. Ask {name} to turn it on in Settings → Backups."), { name: p.name });
  if (res.status === 413) throw new CarryHttp(413, en("{name}'s Sara has no room left for your backups."), { name: p.name });
  if (!res.ok) throw new CarryHttp(502, en('The other server did not answer. Check its address and try again.'));
  return j;
}
async function sendToPeer(app: AppContext, link: string, sealed: string, name: string, keep: number): Promise<void> {
  const data = readFileSync(sealed);
  await peerCall(app, link, 'begin', { name, size: data.length, keep });
  for (let off = 0; off < data.length; off += PART) await peerCall(app, link, 'part', { name, offset: off, data: data.subarray(off, off + PART).toString('base64') });
  await peerCall(app, link, 'end', { name, sha256: createHash('sha256').update(data).digest('hex') });
}

// ---- holding for linked friends (receiver side) ------------------------------------------------
const linkDir = (link: string) => (/^[A-Za-z0-9_-]{1,64}$/.test(link) ? link : createHash('sha256').update(link).digest('hex').slice(0, 24));
export const heldDir = (root: string, link: string) => join(root, HELD_DIR, linkDir(link));
export function heldCopies(root: string, link: string): { name: string; size: number; at: string }[] {
  const d = heldDir(root, link);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => NAME.test(n))
    .map((name) => {
      const st = statSync(join(d, name));
      return { name, size: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}
export function setHold(app: AppContext, link: string, b: Record<string, unknown>): void {
  if (!app.messages?.peer(link)) throw new CarryHttp(404, en('That link is gone. Link the servers again under Messages.'));
  const cur = settingsOf(app);
  const was = cur.hold?.[link] ?? { on: false, maxMb: 20_000 };
  const next = { on: b.on === undefined ? was.on : b.on === true, maxMb: b.maxMb === undefined ? was.maxMb : Math.max(100, Math.min(2_000_000, Math.round(Number(b.maxMb) || 20_000))) };
  save(app, { ...cur, hold: { ...cur.hold, [link]: next } });
}
export function heldFile(app: AppContext, link: string, name: string): string {
  if (!NAME.test(name)) throw new CarryHttp(404, en('No such copy.'));
  const f = join(heldDir(rootOf(app), link), name);
  if (!existsSync(f)) throw new CarryHttp(404, en('No such copy.'));
  return f;
}

/** A peer op from a linked server (already verified). */
export function carryReceived(app: AppContext, link: string, op: string, b: Record<string, unknown>): Record<string, unknown> {
  const hold = settingsOf(app).hold?.[link];
  if (!hold?.on) throw new SupportError(403, 'not holding');
  const root = rootOf(app);
  const dir = heldDir(root, link);
  if (op === 'list') return { copies: heldCopies(root, link) };
  const name = String(b.name ?? '');
  if (!NAME.test(name)) throw new SupportError(400, 'bad name');
  const part = join(dir, `${name}.partial`);
  if (op === 'begin') {
    const size = Number(b.size);
    if (!Number.isSafeInteger(size) || size < 60) throw new SupportError(400, 'bad size');
    // W5.1: uploads still in progress count too (else many half-finished ones could fill the disk).
    const started = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.sara.partial.json') && n !== `${name}.partial.json`) : [];
    const pending = started.reduce((n, f) => {
      try {
        // An upload left for a day is given up (its room is free again).
        const p = join(dir, f.slice(0, -'.json'.length));
        if (Date.now() - statSync(existsSync(p) ? p : join(dir, f)).mtimeMs > 24 * 3600_000) {
          rmSync(p, { force: true });
          rmSync(join(dir, f), { force: true });
          return n;
        }
        return n + Math.max(0, Number((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { size?: number }).size) || 0);
      } catch {
        return n;
      }
    }, 0);
    const used = pending + heldCopies(root, link).filter((c) => c.name !== name).reduce((n, c) => n + c.size, 0);
    if (used + size > hold.maxMb * 1024 * 1024) throw new SupportError(413, 'full');
    mkdirSync(dir, { recursive: true });
    writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
    writeFileSync(`${part}.json`, JSON.stringify({ size, keep: Math.max(1, Math.min(30, Math.round(Number(b.keep) || 4))) }));
    return { ok: true };
  }
  if (op === 'part') {
    if (!existsSync(part)) throw new SupportError(400, 'no upload');
    const meta = JSON.parse(readFileSync(`${part}.json`, 'utf8')) as { size: number };
    const data = Buffer.from(String(b.data ?? ''), 'base64');
    if (Number(b.offset) !== statSync(part).size || statSync(part).size + data.length > meta.size) throw new SupportError(400, 'bad offset');
    appendFileSync(part, data);
    return { ok: true };
  }
  if (op === 'end') {
    if (!existsSync(part)) throw new SupportError(400, 'no upload');
    const meta = JSON.parse(readFileSync(`${part}.json`, 'utf8')) as { size: number; keep: number };
    const got = readFileSync(part);
    const bad = got.length !== meta.size || createHash('sha256').update(got).digest('hex') !== String(b.sha256 ?? '') || !isCarry(got.subarray(0, 8));
    if (bad) {
      rmSync(part, { force: true });
      rmSync(`${part}.json`, { force: true });
      throw new SupportError(400, 'not a sealed copy');
    }
    renameSync(part, join(dir, name));
    rmSync(`${part}.json`, { force: true });
    for (const old of heldCopies(root, link).slice(meta.keep)) rmSync(join(dir, old.name), { force: true });
    return { ok: true, copies: heldCopies(root, link).length };
  }
  if (op === 'drop') {
    rmSync(join(dir, name), { force: true });
    return { ok: true };
  }
  throw new SupportError(404, 'not found');
}

// ---- restore on a new computer ------------------------------------------------------------------
const restoreDir = (root: string, id: string) => {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new CarryHttp(404, en('Start the restore again: that one is gone.'));
  return join(root, 'tmp', `carry-restore-${id}`);
};
/** .sara files on the drives this computer sees (top level and `Sara backups/`). */
export function foundCopies(): { path: string; name: string; drive: string; size: number; at: string }[] {
  const out: { path: string; name: string; drive: string; size: number; at: string }[] = [];
  for (const d of listDrives()) {
    for (const dir of [d.path, join(d.path, CARRY_FOLDER)]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(CARRY_EXT));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const st = statSync(join(dir, name));
          if (st.isFile()) out.push({ path: join(dir, name), name, drive: d.name, size: st.size, at: st.mtime.toISOString() });
        } catch {
          /* gone */
        }
      }
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name)).slice(0, 50);
}
function startDir(app: AppContext): { id: string; dir: string } {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const dir = restoreDir(rootOf(app), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir };
}
export function restoreFromPath(app: AppContext, path: unknown): { id: string; name: string; size: number } {
  const p = String(path ?? '');
  if (!fullPath(p) || !existsSync(p) || !statSync(p).isFile()) throw new CarryHttp(400, en('That backup file is not there.'));
  try {
    carryFingerprint(p);
  } catch (err) {
    throw new CarryHttp(400, (err as Error & { key?: string }).key ?? (err as Error).message);
  }
  const { id, dir } = startDir(app);
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ path: p, name: basename(p) }));
  return { id, name: basename(p), size: statSync(p).size };
}
/** The upload route writes into this file, then calls `uploaded`. */
export function restoreUploadTarget(app: AppContext): { id: string; file: string } {
  const { id, dir } = startDir(app);
  return { id, file: join(dir, `upload${CARRY_EXT}`) };
}
export function uploaded(app: AppContext, id: string, name: string): { id: string; name: string; size: number } {
  const dir = restoreDir(rootOf(app), id);
  const file = join(dir, `upload${CARRY_EXT}`);
  try {
    carryFingerprint(file);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new CarryHttp(400, (err as Error & { key?: string }).key ?? (err as Error).message);
  }
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ path: file, name: basename(name || 'backup.sara') }));
  return { id, name: basename(name || 'backup.sara'), size: statSync(file).size };
}
/** Opens the copy with the sheet's words and checks it with the checks-only drill. */
export async function restoreCheck(app: AppContext, id: string, words: unknown): Promise<DrillRecord> {
  const root = rootOf(app);
  const dir = restoreDir(root, id);
  if (!existsSync(join(dir, 'source.json'))) throw new CarryHttp(404, en('Start the restore again: that one is gone.'));
  const src = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as { path: string };
  let key: Buffer;
  try {
    key = keyFromWords(String(words ?? ''));
    await openCarryFile(src.path, join(dir, 'backup.tar.gz'), key);
  } catch (err) {
    if (err instanceof CarryError) throw new CarryHttp(400, err.key, err.params);
    throw err;
  }
  const rec = await runRestoreDrill({ rootDir: root, now: app.now(), file: join(dir, 'backup.tar.gz'), boot: false });
  writeFileSync(join(dir, 'checked.json'), JSON.stringify(rec));
  if (!rec.ok) rmSync(join(dir, 'backup.tar.gz'), { force: true });
  return rec;
}
/** Puts a checked copy in place for the next start. */
export function restoreStage(app: AppContext, id: string): { staged: true; madeAt?: string } {
  const root = rootOf(app);
  const dir = restoreDir(root, id);
  const checked = existsSync(join(dir, 'checked.json')) ? (JSON.parse(readFileSync(join(dir, 'checked.json'), 'utf8')) as DrillRecord) : undefined;
  if (!checked?.ok || !existsSync(join(dir, 'backup.tar.gz'))) throw new CarryHttp(409, en('Check the backup with your recovery sheet first.'));
  const st = join(root, STAGED_DIR);
  rmSync(st, { recursive: true, force: true });
  mkdirSync(st, { recursive: true, mode: 0o700 });
  renameSync(join(dir, 'backup.tar.gz'), join(st, 'backup.tar.gz'));
  const src = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as { name: string };
  writeFileSync(join(st, 'staged.json'), JSON.stringify({ at: app.now().toISOString(), madeAt: checked.madeAt, from: src.name, counts: checked.counts }));
  rmSync(dir, { recursive: true, force: true });
  return { staged: true, ...(checked.madeAt ? { madeAt: checked.madeAt } : {}) };
}
export function stagedInfo(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, STAGED_DIR, 'staged.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
export function unstage(root: string): void {
  rmSync(join(root, STAGED_DIR), { recursive: true, force: true });
}
export function cancelRestore(app: AppContext, id: string): void {
  rmSync(restoreDir(rootOf(app), id), { recursive: true, force: true });
}
/**
 * At start, before anything opens the data folder: a staged restore replaces the data (what was
 * there moves to `before-restore-<time>/`, like `--restore`). Runs once.
 */
export function applyStagedRestore(dataDir: string, now = new Date()): { movedTo: string; madeAt: string } | undefined {
  const file = join(dataDir, STAGED_DIR, 'backup.tar.gz');
  if (!existsSync(file)) return undefined;
  const r = restoreBackup(file, dataDir, now);
  rmSync(join(r.movedTo, STAGED_DIR), { recursive: true, force: true });
  rmSync(join(dataDir, STAGED_DIR), { recursive: true, force: true });
  return { movedTo: r.movedTo, madeAt: r.manifest.createdAt };
}

// ---- the page's view ----------------------------------------------------------------------------
export function carryView(app: AppContext): Record<string, unknown> {
  const s = settingsOf(app);
  const root = rootOf(app);
  const links = app.messages?.links().filter((l) => l.kind === 'direct').map((l) => ({ id: l.id, name: l.name })) ?? [];
  const name = (link?: string) => links.find((l) => l.id === link)?.name ?? null;
  return {
    sheet: s.sheet && recoveryKey(app) ? { madeAt: s.sheet.madeAt, confirmedAt: s.sheet.confirmedAt ?? null } : null,
    targets: (s.targets ?? []).map((t) => ({ ...t, ...(t.kind === 'peer' ? { name: name(t.link) } : {}) })),
    drives: listDrives(),
    links,
    hold: links.map((l) => {
      const h = s.hold?.[l.id] ?? { on: false, maxMb: 20_000 };
      const copies = heldCopies(root, l.id);
      return { id: l.id, name: l.name, on: h.on, maxMb: h.maxMb, used: copies.reduce((n, c) => n + c.size, 0), copies };
    }),
    staged: stagedInfo(root),
  };
}
