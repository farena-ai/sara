// EC28 (docs/ops/EC1828_DESIGN.md): the restore drill. Proof, not a promise: the newest local
// backup is restored into a throwaway folder inside Sara's own data root (never the live folder,
// never the system temp: the copy holds her keys), every database is integrity-checked, the vault
// is opened with the copy's key, and the copy is booted in drill mode (SARA_RESTORE_DRILL=1 +
// private local mode: no workers, bridges, plugins, tool servers or backups, nothing leaves the
// computer) on a loopback port until /api/health answers. Then it is stopped and deleted.
// The live server only spawns `node src/restore-drill.ts <backup> <workdir>` and reads one JSON
// line, so a large restore never blocks its event loop.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { COUNTED_TABLES, listBackups, restoreBackup } from './backup.ts';
import { netFetch } from './net-guard.ts';
import { Vault } from './vault.ts';

export interface DrillRecord {
  at: string;
  ok: boolean;
  backup?: string;
  /** When the drilled backup was made. */
  madeAt?: string;
  restoreMs?: number;
  bootMs?: number;
  /** Restore + checks + boot: the measured recovery time. */
  totalMs?: number;
  /** Hours between the backup and the drill: what a restore now would lose. */
  dataLossHours?: number;
  counts?: Record<string, number>;
  databases?: number;
  vaultEntries?: number;
  /** R7: files written by the restore, and how many the backup's manifest lists. */
  files?: number;
  filesExpected?: number;
  /** U5.31: files whose sha256 matched the backup's own list, and the row counts taken at backup time. */
  hashed?: number;
  countsAtBackup?: Record<string, number>;
  /** Where a failed drill stopped: find | space | restore | files | hashes | databases | counts | vault | boot | drill. */
  step?: string;
  error?: string;
}

export const DRILL_DIR_PREFIX = 'restore-drill-';
/** The whole drill is stopped after this long. */
export const DRILL_TIMEOUT_MS = 10 * 60_000;
const BOOT_TIMEOUT_MS = 180_000;
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, '..', '..');

class Step extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

/** Every sara.db in the copy (main, companions, household members). */
function databasesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('before-restore-')) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (st.isFile() && name === 'sara.db') out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/** Every regular file in the copy (the restore's own before-restore-* folder left out). */
export function filesIn(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (d === dir && name.startsWith('before-restore-')) continue;
      const st = statSync(join(d, name));
      if (st.isDirectory()) walk(join(d, name));
      else if (st.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

const hasTable = (db: DatabaseSync, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));

/** Boots the restored copy in drill mode and waits for its health answer; always stops it. */
async function bootCopy(data: string): Promise<number> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_DATA: data, SARA_HOST: '127.0.0.1', SARA_PORT: String(port), SARA_PRIVATE_LOCAL: '1', SARA_RESTORE_DRILL: '1', SARA_SETUP: 'off', SARA_REPORT_TO: 'off', SARA_VOICE_DIR: join(data, 'voice-drill') };
  for (const k of ['NODE_TEST_CONTEXT', 'SARA_DEMO', 'SARA_STOP_ON_STDIN_END', 'SARA_INSTANCE', 'SARA_LOG_FILE']) delete env[k];
  const started = performance.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
  child.stderr!.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    const base = `http://127.0.0.1:${port}`;
    const until = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      const ok = await netFetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
      if (ok) break;
      if (child.exitCode !== null) throw new Step('boot', `The restored copy stopped while starting: ${out.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
      if (Date.now() > until) throw new Step('boot', 'The restored copy did not answer within 3 minutes.');
      await new Promise((r) => setTimeout(r, 250));
    }
    const bootMs = Math.round(performance.now() - started);
    // Her sign-in came back with the copy: without it the chats answer 401.
    const st = await netFetch(`${base}/api/conversations`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0);
    if (st !== 401) throw new Step('boot', `The restored copy did not ask for sign-in (HTTP ${st}).`);
    return bootMs;
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
}

/** The drill itself (runs in the child process). */
/** U5.31: a restored count may differ from the count at backup time by this much (rows written while it was copied). */
export function countsAgree(atBackup: number, restored: number): boolean {
  return Math.abs(atBackup - restored) <= Math.max(2, Math.ceil(atBackup * 0.01));
}

export async function drillCopy(backup: string, work: string, now: Date, o: { boot?: boolean } = {}): Promise<DrillRecord> {
  const name = backup.split(/[\\/]/).pop()!;
  const t0 = performance.now();
  const r: DrillRecord = { at: now.toISOString(), ok: false, backup: name };
  try {
    const size = statSync(backup).size;
    let free = Infinity;
    try {
      const fs = statfsSync(work);
      free = Number(fs.bavail) * Number(fs.bsize);
    } catch {
      /* unknown here: try anyway */
    }
    if (free < size * 2 + 100e6) throw new Step('space', `Not enough free space for a throwaway copy (${(free / 1e9).toFixed(1)} GB free, about ${((size * 2) / 1e9).toFixed(1)} GB needed).`);
    const data = join(work, 'data');
    let madeAt: string;
    let listed: number;
    let sums: Record<string, string> | undefined;
    try {
      const restored = restoreBackup(backup, data, now);
      const m = restored.manifest;
      madeAt = m.createdAt;
      listed = m.files;
      sums = restored.sums;
      if (m.counts) r.countsAtBackup = m.counts;
    } catch (err) {
      throw new Step('restore', (err as Error).message.slice(0, 300));
    }
    r.madeAt = madeAt;
    // R7: every file the backup lists came back (counted before the copy boots and writes its own).
    r.files = filesIn(data);
    r.filesExpected = listed;
    if (r.files !== listed) throw new Step('files', `The copy has ${r.files} files, but the backup lists ${listed}.`);
    // U5.31: every file is byte for byte what was backed up (older backups have no list: skipped).
    if (sums) {
      let hashed = 0;
      for (const [rel, want] of Object.entries(sums)) {
        const full = join(data, ...rel.split('/'));
        let got = '';
        try {
          got = createHash('sha256').update(readFileSync(full)).digest('hex');
        } catch {
          throw new Step('hashes', `A file the backup lists did not come back (${rel.slice(0, 120)}).`);
        }
        if (got !== want) throw new Step('hashes', `A file in it is not what was backed up (${rel.slice(0, 120)}).`);
        hashed++;
      }
      r.hashed = hashed;
    }
    r.dataLossHours = Math.max(0, Math.round(((now.getTime() - Date.parse(madeAt)) / 3600_000) * 10) / 10);
    r.restoreMs = Math.round(performance.now() - t0);
    const main = join(data, 'sara.db');
    const dbs = databasesIn(data);
    if (!dbs.includes(main)) throw new Step('databases', 'The backup has no main database.');
    const counts: Record<string, number> = {};
    for (const file of dbs) {
      let db: DatabaseSync;
      try {
        db = new DatabaseSync(file, { readOnly: true });
      } catch (err) {
        throw new Step('databases', `A database in it does not open (${file.slice(data.length + 1)}: ${(err as Error).message.slice(0, 120)}).`);
      }
      try {
        const check = String((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
        if (check !== 'ok') throw new Step('databases', `A database in it is damaged (${file.slice(data.length + 1)}: ${check.slice(0, 120)}).`);
        if (file === main) for (const t of COUNTED_TABLES) counts[t] = hasTable(db, t) ? Number((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n) : 0;
      } finally {
        db.close();
      }
    }
    r.counts = counts;
    r.databases = dbs.length;
    for (const [t, n] of Object.entries(r.countsAtBackup ?? {})) {
      if (!countsAgree(n, counts[t] ?? 0)) throw new Step('counts', `The copy has ${counts[t] ?? 0} ${t}, but there were ${n} when the backup was made.`);
    }
    try {
      // Opening the vault proves the key that came with the copy (or SARA_MASTER_KEY) still fits.
      // Only the number of entries is kept, never a name or a value.
      if (!existsSync(join(data, 'master.key')) && !process.env.SARA_MASTER_KEY) throw new Error('the backup has no vault key and SARA_MASTER_KEY is not set');
      r.vaultEntries = new Vault(data, process.env.SARA_MASTER_KEY).values().length;
    } catch (err) {
      throw new Step('vault', `The vault does not open with this copy's key: ${(err as Error).message.slice(0, 200)}`);
    }
    if (o.boot !== false) r.bootMs = await bootCopy(data);
    r.totalMs = Math.round(performance.now() - t0);
    r.ok = true;
  } catch (err) {
    r.step = err instanceof Step ? err.step : 'drill';
    r.error = (err as Error).message.slice(0, 300);
    r.totalMs = Math.round(performance.now() - t0);
  }
  return r;
}

/**
 * Runs one drill on the newest backup in <root>/backups. Never throws: a failure is a record.
 * The work folder is removed afterwards even when the child process died.
 */
export async function runRestoreDrill(o: { rootDir: string; now: Date; timeoutMs?: number; /** U5.31: this backup file instead of the newest local one. */ file?: string; /** U5.31: false = checks only, the copy is not started. */ boot?: boolean }): Promise<DrillRecord> {
  const at = o.now.toISOString();
  const newest = o.file ? { name: o.file.split(/[\\/]/).pop()! } : listBackups(o.rootDir)[0];
  if (!newest) return { at, ok: false, step: 'find', error: 'There is no backup on this computer yet.' };
  const tmpRoot = join(o.rootDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpRoot, DRILL_DIR_PREFIX));
  try {
    const args = ['--disable-warning=ExperimentalWarning', SELF, o.file ?? join(o.rootDir, 'backups', newest.name), work, at];
    if (o.boot === false) args.push('--no-boot');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs ?? DRILL_TIMEOUT_MS);
    await new Promise<void>((r) => child.once('exit', () => r()));
    clearTimeout(timer);
    try {
      const rec = JSON.parse(out.trim().split('\n').pop() ?? '') as DrillRecord;
      if (typeof rec.ok === 'boolean') return rec;
    } catch {
      /* no record: say why below */
    }
    return { at, ok: false, backup: newest.name, step: 'drill', error: (timedOut ? 'The drill took too long and was stopped.' : err.trim().split('\n').pop() || 'The drill stopped without a result.').slice(0, 300) };
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

// `node src/restore-drill.ts <backup> <workdir> [iso time] [--no-boot]`: one JSON line on stdout.
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [backup, work, when, flag] = process.argv.slice(2);
  const rec = await drillCopy(backup!, work!, when ? new Date(when) : new Date(), { boot: flag !== '--no-boot' });
  process.stdout.write(`${JSON.stringify(rec)}\n`);
}
