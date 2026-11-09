// C9 for the Windows SERVICE install: Update now without the download page. Sara's service runs as
// the virtual account NT SERVICE\Sara, which can't run an installer. Sara-Setup (an administrator, at
// service install) registers the scheduled task \Sara\Update: it runs THIS file, from the program
// folder only administrators can change, as SYSTEM, on demand only; the task's permissions let
// NT SERVICE\Sara start it and nothing else (sara-windows.ts `updater-task install`).
//
// Sara only leaves a request: `<data>\updates\service-request.json` = the signed update notice and the
// installer she downloaded. Nothing in it is trusted:
//   - the notice is verified again here with the keys in this file's own folder, must be newer than
//     the installed version, and names the installer's SHA-256;
//   - the installer is copied into `{app}\updater\` (administrators and SYSTEM only), hashed THERE and
//     must match the notice; only that copy ever runs, never a file in her data folder;
//   - the previous installer for going back is the one kept in `{app}\updater\keep\` by Setup or by the
//     last good update, never one from the request.
// Then the same steps as the per-user update (src/update-apply.ts): silent install for all users,
// health check, the previous version back if the new one doesn't answer. The outcome goes to
// `<data>\updates\update-result.json`, which Sara reads when she starts again.
//   node update-service.ts            (the task's action; no arguments are read)
//   node update-service.ts --dry-run  checks a waiting request and says what it would run
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyUpdate, windowsDriver, type UpdateDriver, type UpdatePlan, type UpdateResult } from './update-apply.ts';
import { assetKey, NOTICE_KEYS, verifyNotice } from './update-notice.ts';

export const TASK_PATH = '\\Sara\\';
export const TASK_NAME = 'Update';
export const TASK_FULL = `${TASK_PATH}${TASK_NAME}`;
export const REQUEST_FILE = 'service-request.json';

export interface ServiceRequest {
  /** The exact signed update notice Sara read (verified again here). */
  notice: unknown;
  /** The installer Sara downloaded (copied, hashed and only then run). */
  installer: string;
}

export interface ServiceUpdateOptions {
  /** The install folder ({app}); default: two levels above this file ({app}\server\src). */
  app?: string;
  keys?: Record<string, string>;
  arch?: string;
  /** Tests: the install / restore / health steps. */
  driver?: (plan: UpdatePlan) => UpdateDriver;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  dryRun?: boolean;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function envOf(app: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(app, 'sara.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const cmp = (a: string, b: string) => {
  const p = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** A regular file (not a link or junction) whose real path is inside dir. */
function inside(file: string, dir: string): boolean {
  try {
    if (!lstatSync(file).isFile()) return false;
    const rel = relative(realpathSync(dir), realpathSync(file));
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

export type ServiceOutcome = UpdateResult | { state: 'refused'; message: string } | { state: 'dry-run'; message: string; installer: string; previous: string; to: string };

/** One run of the task: take the waiting request (if any), check everything, update or refuse. */
export async function serviceUpdate(o: ServiceUpdateOptions = {}): Promise<ServiceOutcome | null> {
  const app = resolve(o.app ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const env = envOf(app);
  if (env.SARA_MODE !== 'service') return { state: 'refused', message: 'Sara is not installed as a Windows service here.' };
  const data = env.SARA_DATA;
  if (!data) return { state: 'refused', message: "Sara's settings name no data folder." };
  const dir = join(data, 'updates');
  const reqFile = join(dir, REQUEST_FILE);
  if (!existsSync(reqFile)) return null;
  const resultFile = join(dir, 'update-result.json');
  let req: ServiceRequest;
  try {
    req = JSON.parse(readFileSync(reqFile, 'utf8')) as ServiceRequest;
  } catch {
    req = { notice: null, installer: '' };
  }
  if (!o.dryRun) rmSync(reqFile, { force: true });
  const from = String((JSON.parse(readFileSync(join(app, 'server', 'package.json'), 'utf8')) as { version?: unknown }).version ?? '0.0.0');
  const refuse = (why: string): ServiceOutcome => {
    const r = { state: 'failed' as const, message: `${why} Nothing was installed.`, at: new Date().toISOString(), from, to: '' };
    if (!o.dryRun) {
      mkdirSync(dir, { recursive: true });
      writeResult(resultFile, r);
    }
    return { state: 'refused', message: r.message };
  };
  const v = verifyNotice(req.notice, { keys: o.keys ?? NOTICE_KEYS });
  if (!v.ok) return refuse(`The update notice didn't check out (${v.reason}).`);
  const to = v.notice.version;
  if (cmp(to, from) <= 0) return refuse(`Sara ${to} is not newer than ${from}.`);
  const asset = v.notice.assets[assetKey('win32', o.arch ?? process.arch)];
  if (!asset) return refuse('The release has no installer for this computer.');
  if (!inside(req.installer, join(dir, 'download'))) return refuse("The installer isn't the one Sara downloaded.");
  const safe = join(app, 'updater');
  const keepDir = join(safe, 'keep');
  const staged = join(safe, basename(asset.name).replace(/[^A-Za-z0-9._-]/g, '_'));
  // The installer of exactly the installed version (Setup keeps itself there; a good update keeps the new one).
  const previous = (existsSync(keepDir) ? readdirSync(keepDir) : []).filter((f) => f.toLowerCase() === `sara-setup-${from}.exe`).map((f) => join(keepDir, f))[0] ?? '';
  if (o.dryRun) return { state: 'dry-run', message: `Would install Sara ${to} from ${staged} (checked against the signed notice)${previous ? `, going back with ${previous}` : ' (no previous installer kept: no going back)'}.`, installer: staged, previous, to };
  mkdirSync(keepDir, { recursive: true });
  copyFileSync(req.installer, `${staged}.part`);
  if (sha256(`${staged}.part`) !== asset.sha256) {
    rmSync(`${staged}.part`, { force: true });
    return refuse(`The download of ${asset.name} didn't match the signed update notice.`);
  }
  renameSync(`${staged}.part`, staged);
  rmSync(req.installer, { force: true });
  const plan: UpdatePlan = { platform: 'win32', from, to, installer: staged, previous, appDir: app, port: Number(env.SARA_PORT) || 7860, timeoutMs: o.timeoutMs ?? 3 * 60_000, resultFile, keepDir };
  const driver = o.driver ? o.driver(plan) : windowsDriver(plan, undefined, 'all');
  const r = await applyUpdate(plan, driver, o.sleep ? { sleep: o.sleep } : {});
  if (existsSync(staged) && r.state !== 'failed' && dirname(staged) !== keepDir) rmSync(staged, { force: true });
  return r;
}

function writeResult(file: string, r: UpdateResult): void {
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(tmp, file);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  // Let Sara answer the page that pressed Update before the installer stops her.
  if (!dryRun) await new Promise((r) => setTimeout(r, 1500));
  const r = await serviceUpdate({ dryRun }).catch((err: Error) => ({ state: 'refused' as const, message: err.message }));
  console.log(r ? r.message : 'No update is waiting.');
  process.exit(!r || r.state === 'updated' || r.state === 'rolledback' || r.state === 'dry-run' ? 0 : 1);
}
