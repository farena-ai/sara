// U5.31 (docs/BACKUPS.md): the monthly test restore. Proves backups work without anyone asking:
// once a month, at a quiet hour on the hourly maintenance tick, the newest local backup (and the
// newest off-server copy, when that is set up) is restored into a throwaway folder inside her own
// data root and checked read-only by the EC28 drill in checks-only mode (src/restore-drill.ts: every
// database integrity-checked, row counts against the counts at backup time, file hashes against the
// backup's own list, the vault opened with the copy's key; values are never read out). The copy is
// deleted; one result row per source is kept. A failure becomes a T1 self-repair problem
// (`backup:restore-test`, detectProblems in src/repair.ts) and one owner notice.
import { mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit-trail.ts';
import { listBackups } from './backup.ts';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { netFetch } from './net-guard.ts';
import { decryptBackup, downloadNewestOffsite, OFFSITE_PASS_VAULT, OFFSITE_S3_VAULT } from './offsite.ts';
import { offsiteSettings } from './offsite-run.ts';
import { zonedParts } from './planner.ts';
import { DRILL_DIR_PREFIX, type DrillRecord, runRestoreDrill } from './restore-drill.ts';

export interface RestoreTestRow {
  at: string;
  result: 'passed' | 'failed' | 'skipped';
  source: 'local' | 'offsite';
  backup?: string;
  /** Plain words: an English key with {params} (the web translates it). */
  reason: string;
  params?: Record<string, string | number>;
  /** Where a failed check stopped (the drill's step). */
  step?: string;
  durationMs: number;
  by: 'schedule' | 'owner';
}

export interface RestoreTestSettings {
  on: boolean;
  everyDays: number;
  /** Local hour it may start (a quiet hour); it can start in this hour or the two after it. */
  hour: number;
  /** Also test the newest off-server copy when off-server copies are set up. */
  offsite: boolean;
  history?: RestoreTestRow[];
}

export const DEFAULT_RESTORE_TEST: RestoreTestSettings = { on: true, everyDays: 30, hour: 3, offsite: true };
/** Rows kept (a run makes one or two). */
export const RESTORE_TEST_KEEP = 24;
const OFFSITE_DIR_PREFIX = 'restore-offsite-';
/** Throwaway folders this feature makes under <root>/tmp (tests check none are left). */
export const RESTORE_TEST_PREFIXES = [DRILL_DIR_PREFIX, OFFSITE_DIR_PREFIX];

export function restoreTestSettings(app: AppContext): RestoreTestSettings {
  return { ...DEFAULT_RESTORE_TEST, ...(app.settings.get() as { restoreTest?: Partial<RestoreTestSettings> }).restoreTest };
}

function save(app: AppContext, patch: Partial<RestoreTestSettings>): void {
  app.settings.update({ restoreTest: { ...restoreTestSettings(app), ...patch } } as never);
}

/** Saves the switches the owner can change (on/off, off-server part). */
export function setRestoreTest(app: AppContext, body: { on?: unknown; offsite?: unknown }): RestoreTestSettings {
  const patch: Partial<RestoreTestSettings> = {};
  if (typeof body.on === 'boolean') patch.on = body.on;
  if (typeof body.offsite === 'boolean') patch.offsite = body.offsite;
  save(app, patch);
  return restoreTestSettings(app);
}

const offsiteReady = (app: AppContext) => {
  const o = offsiteSettings(app);
  return o.kind !== 'off' && Boolean(o.last?.ok);
};

/** Due: on, a local backup exists, the last run is a month old (or none), and it is the quiet hour. */
export function restoreTestDue(app: AppContext, rootDir = app.rootDir ?? app.dataDir, now = app.now()): boolean {
  const s = restoreTestSettings(app);
  if (!s.on || !listBackups(rootDir).length) return false;
  const last = s.history?.find((r) => r.by === 'schedule' || r.result !== 'skipped');
  if (last && now.getTime() - Date.parse(last.at) < (s.everyDays - 0.5) * 86_400_000) return false;
  const h = zonedParts(now, app.settings.get().timeZone || undefined).h;
  return (h - s.hour + 24) % 24 < 3;
}

const running = new Set<string>();
export const restoreTestRunning = (rootDir: string) => running.has(rootDir);

export interface RestoreTestDeps {
  rootDir: string;
  by?: RestoreTestRow['by'];
  /** Free bytes where the throwaway copy goes (tests make it small). */
  freeBytes?: (dir: string) => number | null;
  fetchImpl?: typeof fetch;
  /** The owner notice on a failure (default: her push notification). */
  notify?: (title: string, text: string) => Promise<void>;
  drill?: typeof runRestoreDrill;
}

function freeAt(dir: string): number | null {
  try {
    const fs = statfsSync(dir);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

const gb = (n: number) => (n / 1e9).toFixed(1);

function rowOf(rec: DrillRecord, base: Pick<RestoreTestRow, 'at' | 'source' | 'by'>, durationMs: number): RestoreTestRow {
  const row: RestoreTestRow = { ...base, durationMs, ...(rec.backup ? { backup: rec.backup } : {}), result: rec.ok ? 'passed' : 'failed', reason: '' };
  if (rec.ok) {
    row.reason = en('All checks passed: {dbs} database(s), {files} files, {conversations} conversations.');
    row.params = { dbs: rec.databases ?? 0, files: rec.files ?? 0, conversations: rec.counts?.conversations ?? 0 };
  } else if (rec.step === 'space') {
    row.result = 'skipped';
    row.reason = en('Skipped: not enough free disk space for a throwaway copy.');
  } else if (rec.step === 'find') {
    row.result = 'skipped';
    row.reason = en('Skipped: there is no backup on this computer yet.');
  } else {
    row.step = rec.step ?? 'drill';
    row.reason = en('It did not restore: {error}');
    row.params = { error: (rec.error ?? 'unknown').slice(0, 240) };
  }
  return row;
}

async function testLocal(app: AppContext, d: RestoreTestDeps, by: RestoreTestRow['by']): Promise<RestoreTestRow> {
  const at = app.now().toISOString();
  const t0 = performance.now();
  const newest = listBackups(d.rootDir)[0];
  const base = { at, source: 'local' as const, by };
  if (!newest) return { ...base, result: 'skipped', reason: en('Skipped: there is no backup on this computer yet.'), durationMs: 0 };
  const free = (d.freeBytes ?? freeAt)(d.rootDir);
  const need = newest.size * 3 + 100e6;
  if (free !== null && free < need) return { ...base, backup: newest.name, result: 'skipped', reason: en('Skipped: not enough free disk space ({free} GB free, about {need} GB needed).'), params: { free: gb(free), need: gb(need) }, durationMs: 0 };
  const rec = await (d.drill ?? runRestoreDrill)({ rootDir: d.rootDir, now: app.now(), boot: false });
  return rowOf(rec, base, Math.round(performance.now() - t0));
}

async function testOffsiteCopy(app: AppContext, d: RestoreTestDeps, by: RestoreTestRow['by']): Promise<RestoreTestRow> {
  const at = app.now().toISOString();
  const t0 = performance.now();
  const base = { at, source: 'offsite' as const, by };
  const pass = app.vault.get(OFFSITE_PASS_VAULT);
  if (!pass) return { ...base, result: 'failed', step: 'download', reason: en('It did not restore: {error}'), params: { error: 'No backup passphrase is set.' }, durationMs: 0 };
  const tmpRoot = join(d.rootDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmpRoot, OFFSITE_DIR_PREFIX));
  try {
    let name: string;
    let file: string;
    try {
      const got = await downloadNewestOffsite(offsiteSettings(app), { s3Secret: app.vault.get(OFFSITE_S3_VAULT) }, d.fetchImpl ?? netFetch);
      name = got.name;
      const free = (d.freeBytes ?? freeAt)(d.rootDir);
      const need = got.data.length * 4 + 100e6;
      if (free !== null && free < need) return { ...base, backup: name, result: 'skipped', reason: en('Skipped: not enough free disk space ({free} GB free, about {need} GB needed).'), params: { free: gb(free), need: gb(need) }, durationMs: Math.round(performance.now() - t0) };
      file = join(dir, 'sara-offsite.tar.gz');
      writeFileSync(file, decryptBackup(got.data, pass), { mode: 0o600 });
    } catch (err) {
      return { ...base, result: 'failed', step: 'download', reason: en('It did not restore: {error}'), params: { error: (err as Error).message.slice(0, 240) }, durationMs: Math.round(performance.now() - t0) };
    }
    const rec = await (d.drill ?? runRestoreDrill)({ rootDir: d.rootDir, now: app.now(), file, boot: false });
    return { ...rowOf(rec, base, Math.round(performance.now() - t0)), backup: name };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

/**
 * One test restore (local, then off-server when set up and wanted). Never throws: every outcome
 * is a row. Rows are saved newest first; a failure sends one owner notice and shows up as a T1
 * problem until a later test passes.
 */
export async function runRestoreTest(app: AppContext, d: RestoreTestDeps): Promise<RestoreTestRow[]> {
  if (running.has(d.rootDir)) return [];
  running.add(d.rootDir);
  try {
    const by = d.by ?? 'schedule';
    const rows = [await testLocal(app, d, by)];
    if (restoreTestSettings(app).offsite && offsiteReady(app)) rows.push(await testOffsiteCopy(app, d, by));
    save(app, { history: [...rows.slice().reverse(), ...(restoreTestSettings(app).history ?? [])].slice(0, RESTORE_TEST_KEEP) });
    for (const r of rows) {
      try {
        audit({ action: 'backup.restore-test', who: by === 'owner' ? 'owner' : 'system', role: by === 'owner' ? 'owner' : 'system', channel: 'system', outcome: r.result === 'failed' ? 'failed' : 'ok', target: `${r.source}:${r.backup ?? '-'}` });
      } catch {
        /* the audit trail is optional here */
      }
    }
    const failed = rows.find((r) => r.result === 'failed');
    if (failed) {
      const s = app.settings.get();
      const title = trOwner('A test restore failed', s);
      const text = trOwner('Sara could not restore a backup in her monthly test. Open Settings → Privacy & system → Backups.', s);
      const notify = d.notify ?? ((a: string, b: string) => app.push?.notifyOwner(a, b, '', 'restore-test') ?? Promise.resolve());
      await notify(title, text).catch(() => undefined);
    }
    return rows;
  } finally {
    running.delete(d.rootDir);
  }
}

/** U5.34 dashboard and Settings: the state in one object. */
export function restoreTestSummary(app: AppContext, rootDir = app.rootDir ?? app.dataDir): {
  on: boolean;
  offsite: boolean;
  offsiteReady: boolean;
  everyDays: number;
  running: boolean;
  last?: RestoreTestRow;
  lastPassedAt?: string;
  nextAt?: string;
  history: RestoreTestRow[];
} {
  const s = restoreTestSettings(app);
  const history = s.history ?? [];
  const last = history.find((r) => r.result !== 'skipped') ?? history[0];
  const lastPassedAt = history.find((r) => r.result === 'passed')?.at;
  const from = last ? Date.parse(last.at) : app.now().getTime();
  return {
    on: s.on,
    offsite: s.offsite,
    offsiteReady: offsiteReady(app),
    everyDays: s.everyDays,
    running: running.has(rootDir),
    ...(last ? { last } : {}),
    ...(lastPassedAt ? { lastPassedAt } : {}),
    ...(s.on ? { nextAt: new Date(Math.max(from + s.everyDays * 86_400_000, app.now().getTime() + 3600_000)).toISOString() } : {}),
    history,
  };
}
