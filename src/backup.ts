// Phase 6: backup and restore. A backup is one .tar.gz with a consistent copy of the database
// (VACUUM INTO, safe while Sara runs), settings, character, vault + master key, MCP config and
// workspaces. Undo snapshots and temp files are left out. Zero dependencies: a small ustar/pax
// writer and reader on top of node:zlib.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { constants } from 'node:buffer';

export const BACKUP_FORMAT = 'sara-backup';
export const BACKUP_VERSION = 1;
export const BACKUPS_DIR = 'backups';
/** Never inside a backup: live database files (a consistent copy is added), temp, old backups. */
// service: the Mac app's running state (how she starts, pid files, a stop switch); it belongs to
// this computer, not to her, so it is neither saved nor replaced by a restore.
const SKIP_TOP = new Set(['sara.db', 'sara.db-wal', 'sara.db-shm', 'tmp', BACKUPS_DIR, 'snapshots', 'update-request', 'update-status.json', 'cache', 'logs', 'downloads', 'first-token.txt', 'service']); // downloads: the desktop app files (rebuildable)
const isRestoreLeftover = (name: string) => name.startsWith('before-restore-');
/** Left where they are by a restore: her backups, this computer's service settings, the logs. */
const KEEP_IN_PLACE = new Set([BACKUPS_DIR, 'service', 'logs']);

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  saraVersion: string;
  files: number;
  includesWorkspaces: boolean;
}

interface Entry {
  path: string;
  data: Buffer;
  mode: number;
}

// ---- tar (ustar + pax for long names) ----------------------------------------
function octal(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`;
}

function header(name: string, size: number, mode: number, type: string, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(mtime, 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

/** One file as tar blocks (a pax header first for long names). */
function tarEntry(e: Entry, mtime: number): Buffer {
  const parts: Buffer[] = [];
  {
    if (Buffer.byteLength(e.path) > 100) {
      const rec = (k: string, v: string) => {
        const body = ` ${k}=${v}\n`;
        let len = Buffer.byteLength(body);
        len += String(len + String(len).length).length;
        return `${len}${body}`;
      };
      const pax = Buffer.from(rec('path', e.path));
      parts.push(header('PaxHeader', pax.length, 0o644, 'x', mtime), pax, pad(pax.length));
    }
    parts.push(header(e.path, e.data.length, e.mode, '0', mtime), e.data, pad(e.data.length));
  }
  return Buffer.concat(parts);
}

export function writeTar(entries: Entry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  return Buffer.concat([...entries.map((e) => tarEntry(e, mtime)), Buffer.alloc(1024)]);
}

export function readTar(buf: Buffer): Entry[] {
  const out: Entry[] = [];
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, l: number) => h.subarray(a, a + l).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(str(124, 12).trim() || '0', 8);
    const type = str(156, 1) || '0';
    const prefix = str(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const data = buf.subarray(off + 512, off + 512 + size);
    if (off + 512 + size > buf.length) throw new Error('Backup file is truncated');
    off += 512 + size + ((512 - (size % 512)) % 512);
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      longName = m?.[1];
      continue;
    }
    longName = undefined;
    if (type === '0' || type === '\0') out.push({ path: name, data: Buffer.from(data), mode: Number.parseInt(str(100, 8).trim() || '644', 8) });
  }
  return out;
}

// ---- backup ---------------------------------------------------------------------
/** Folders in her workspaces that are rebuilt from the project itself (npm ci, pip install…). */
const REBUILDABLE = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.npm', '.pnpm-store', '.gradle', '.tox']);

interface FileRef {
  path: string;
  full: string;
  mode: number;
}
function walk(root: string, dir: string, out: FileRef[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    if (dir === root && (SKIP_TOP.has(name) || isRestoreLeftover(name))) continue;
    // Phase 31: other companions' databases are snapshotted safely below, like the main one.
    if (dir !== root && /^companions\/[^/]+\/sara\.db(-wal|-shm)?$/.test(rel)) continue;
    // Phase 71: household members' databases (members/<id>/sara.db and their companions') too.
    if (/^members\/[^/]+\/(companions\/[^/]+\/)?sara\.db(-wal|-shm)?$/.test(rel)) continue;
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (REBUILDABLE.has(name) && /(^|\/)workspaces\//.test(rel)) continue;
      walk(root, full, out);
    } else if (st.isFile()) out.push({ path: rel, full, mode: st.mode });
  }
}

/** Creates a backup file; returns its manifest. The file holds keys: it is written mode 0600. */
export function createBackup(dataDir: string, outFile: string, opts: { saraVersion?: string; includeWorkspaces?: boolean; now?: Date } = {}): BackupManifest {
  const includeWorkspaces = opts.includeWorkspaces ?? true;
  const refs: FileRef[] = [];
  walk(dataDir, dataDir, refs);
  const files = refs.filter((e) => includeWorkspaces || !e.path.startsWith('workspaces/'));
  const dbs = ['sara.db'];
  const snaps: string[] = [];
  const cdir = join(dataDir, 'companions');
  if (existsSync(cdir)) for (const n of readdirSync(cdir)) if (existsSync(join(cdir, n, 'sara.db'))) dbs.push(`companions/${n}/sara.db`);
  const mdir = join(dataDir, 'members');
  if (existsSync(mdir)) {
    for (const m of readdirSync(mdir)) {
      if (existsSync(join(mdir, m, 'sara.db'))) dbs.push(`members/${m}/sara.db`);
      const mc = join(mdir, m, 'companions');
      if (existsSync(mc)) for (const n of readdirSync(mc)) if (existsSync(join(mc, n, 'sara.db'))) dbs.push(`members/${m}/companions/${n}/sara.db`);
    }
  }
  for (const [i, rel] of dbs.entries()) {
    const dbFile = join(dataDir, ...rel.split('/'));
    if (!existsSync(dbFile)) continue;
    const tmpDir = join(dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    // The index keeps two snapshots made in the same millisecond apart (VACUUM INTO refuses an existing file).
    const snap = join(tmpDir, `backup-${process.pid}-${Date.now()}-${i}.db`);
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('VACUUM INTO ?').run(snap);
    } finally {
      db.close();
    }
    files.push({ path: rel, full: snap, mode: 0o600 });
    snaps.push(snap);
  }
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    saraVersion: opts.saraVersion ?? 'unknown',
    files: files.length,
    includesWorkspaces: includeWorkspaces,
  };
  // Written one file at a time (each its own gzip member; a .tar.gz may hold several), so a big
  // data folder never has to fit in memory at once.
  mkdirSync(dirname(outFile), { recursive: true });
  // `sara backup <file>` makes an empty file for her to fill, in a folder she may not write to
  // (no temporary file there): write straight into it. Otherwise a temporary file, renamed at the end.
  const direct = existsSync(outFile) && statSync(outFile).isFile() && statSync(outFile).size === 0;
  const tmp = direct ? outFile : `${outFile}.partial`;
  const mtime = Math.floor(Date.now() / 1000);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, gzipSync(tarEntry({ path: 'sara-backup.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), mode: 0o600 }, mtime)));
    for (const f of files) {
      let data: Buffer;
      try {
        data = readFileSync(f.full);
      } catch {
        continue; // removed while the backup ran
      }
      writeSync(fd, gzipSync(tarEntry({ path: f.path, data, mode: f.mode }, mtime)));
    }
    writeSync(fd, gzipSync(Buffer.alloc(1024)));
  } catch (err) {
    closeSync(fd);
    if (!direct) rmSync(tmp, { force: true });
    throw err;
  } finally {
    for (const s of snaps) rmSync(s, { force: true });
  }
  closeSync(fd);
  if (!direct) renameSync(tmp, outFile);
  try {
    chmodSync(outFile, 0o600);
  } catch {
    // a file made by root for her: root sets its mode
  }
  return manifest;
}

/** Reads and checks a backup without writing anything. */
export function inspectBackup(file: string): { manifest: BackupManifest; entries: Entry[] } {
  let tar: Buffer;
  const packed = readFileSync(file);
  // A real backup unpacks to a few times its size; a file built to unpack to far more (planted in
  // an off-server folder, say) is refused before it can use up the server's memory.
  const limit = Math.min(constants.MAX_LENGTH, Math.max(2 * 1024 ** 3, packed.length * 64));
  try {
    tar = gunzipSync(packed, { maxOutputLength: limit });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Not a Sara backup (it unpacks to far more than any backup could).');
    throw new Error('Not a Sara backup (could not decompress).');
  }
  const entries = readTar(tar);
  const m = entries.find((e) => e.path === 'sara-backup.json');
  if (!m) throw new Error('Not a Sara backup (no sara-backup.json).');
  const manifest = JSON.parse(m.data.toString()) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) throw new Error('Not a Sara backup.');
  if (manifest.version > BACKUP_VERSION) throw new Error(`This backup is from a newer Sara (format ${manifest.version}). Update Sara first.`);
  for (const e of entries) {
    const norm = posix.normalize(e.path);
    if (norm.startsWith('../') || norm === '..' || posix.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm) || norm.includes('\\')) throw new Error(`Unsafe path in backup: ${e.path}`);
  }
  return { manifest, entries: entries.filter((e) => e.path !== 'sara-backup.json') };
}

/**
 * Restores a backup into dataDir. Sara must be stopped. Everything currently in dataDir (except
 * old backups, the logs and the Mac app's service folder) is first moved to `before-restore-<time>/`,
 * so a restore can itself be undone.
 */
export function restoreBackup(file: string, dataDir: string, now = new Date()): { manifest: BackupManifest; movedTo: string } {
  const { manifest, entries } = inspectBackup(file);
  mkdirSync(dataDir, { recursive: true });
  const aside = join(dataDir, `before-restore-${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(aside);
  for (const name of readdirSync(dataDir)) {
    if (KEEP_IN_PLACE.has(name) || isRestoreLeftover(name)) continue;
    renameSync(join(dataDir, name), join(aside, name));
  }
  try {
    for (const e of entries) {
      // An older backup may hold these; this computer's own copies stay.
      if (KEEP_IN_PLACE.has(posix.normalize(e.path).split('/')[0]!)) continue;
      const target = join(dataDir, ...posix.normalize(e.path).split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data, { mode: e.mode & 0o777 });
    }
  } catch (err) {
    // Half restored (a full disk): put back exactly what was there before.
    for (const name of readdirSync(dataDir)) {
      if (KEEP_IN_PLACE.has(name) || isRestoreLeftover(name)) continue;
      rmSync(join(dataDir, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(aside)) renameSync(join(aside, name), join(dataDir, name));
    rmSync(aside, { recursive: true, force: true });
    throw new Error(`The restore couldn't finish (${(err as Error).message}), so the data from before it was put back. Nothing was lost.`);
  }
  return { manifest, movedTo: aside };
}

// ---- automatic daily backups -----------------------------------------------------
export interface BackupSettings {
  /** Daily automatic backup into <data>/backups. */
  auto: boolean;
  keep: number;
}
export const DEFAULT_BACKUP: BackupSettings = { auto: true, keep: 7 };

export function listBackups(dataDir: string): { name: string; size: number; createdAt: string }[] {
  const dir = join(dataDir, BACKUPS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^sara-[\w-]+\.tar\.gz$/.test(n))
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function backupName(now: Date, kind: 'auto' | 'manual' = 'manual'): string {
  return `sara-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}${kind === 'auto' ? '-auto' : ''}.tar.gz`;
}

/** Runs one automatic backup when the last one is older than a day; prunes old automatic ones. */
export function autoBackupTick(dataDir: string, cfg: BackupSettings, now: Date, saraVersion: string): string | undefined {
  if (!cfg.auto) return undefined;
  const autos = listBackups(dataDir).filter((b) => b.name.endsWith('-auto.tar.gz'));
  if (autos[0] && now.getTime() - Date.parse(autos[0].createdAt) < 23 * 3600_000) return undefined;
  const name = backupName(now, 'auto');
  createBackup(dataDir, join(dataDir, BACKUPS_DIR, name), { saraVersion, now });
  for (const old of listBackups(dataDir).filter((b) => b.name.endsWith('-auto.tar.gz')).slice(Math.max(1, cfg.keep))) rmSync(join(dataDir, BACKUPS_DIR, old.name), { force: true });
  return name;
}
