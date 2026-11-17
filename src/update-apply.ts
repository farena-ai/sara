// C9: the update runner on Windows and macOS. Sara starts it as a separate process (from a copy
// outside her install folder, see Updater.update) because the installer stops and replaces her:
//   node update-apply.ts <plan.json>
// It runs the new installer silently (Windows: Inno Setup /VERYSILENT; macOS: the signed app from
// the disk image swapped in place), waits for /api/health and the new version on disk, and when the
// new version doesn't come up within the time limit puts the previous one back (the previous
// installer on Windows, the kept app copy on macOS). The outcome lands in plan.resultFile, which
// Sara reads when she starts again. Node built-ins only: this file is copied and run alone.
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- HANKFIX: one Sara in Settings → Apps (src/install-scope.ts re-exports this; this file runs alone) ----------
// Setup (Inno, desktop/windows/installer/sara.iss) installs for all users (the service, HKLM) or for
// this user (the app only, or her server while signed in, HKCU) under one AppId; very old apps also
// listed themselves as "SaraDesktop" (HKCU). An update or reinstall must land on the install that is
// there: the scope comes from the install that owns the app folder. When two are listed anyway, the
// one not running is the stale one (desktop/windows/src/main.cpp removeDuplicateInstalls does the same).

/** The release AppId (sara.iss [Setup] AppId; the TestInstall build has its own). */
export const SARA_APP_ID = '6F0B2C1E-7A51-4C8B-9E2D-3B5A0C9D4E17';
export const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
export const STANDALONE_KEY = `${UNINSTALL_KEY}\\SaraDesktop`;

export type InstallScope = 'all' | 'user';
export interface InstallEntry {
  scope: InstallScope;
  /** 'setup': Sara-Setup.exe (Inno); 'standalone': a Sara.exe that listed itself (SaraDesktop). */
  kind: 'setup' | 'standalone';
  location: string;
  uninstall?: string;
  version?: string;
}
/** How a stale install goes: its uninstaller (silent, data kept), an administrator (all users), only its Apps entry, or its entry and its copy of Sara.exe. */
export interface Duplicate {
  entry: InstallEntry;
  how: 'uninstall' | 'admin' | 'entry' | 'files';
}

const norm = (p: string): string => p.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
const same = (a: string, b: string): boolean => Boolean(a) && norm(a) === norm(b);

/** Reads one `reg query <key>` answer (empty or an error: nothing installed there). */
function parseReg(out: string, scope: InstallScope, kind: InstallEntry['kind']): InstallEntry | undefined {
  const v = (name: string) => new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'mi').exec(out)?.[1];
  const location = v('InstallLocation');
  if (!location) return undefined;
  const uninstall = v('UninstallString');
  const version = v('DisplayVersion');
  return { scope, kind, location: location.replace(/[\\/]+$/, ''), ...(uninstall ? { uninstall } : {}), ...(version ? { version } : {}) };
}

/** Every Sara install listed in Settings → Apps (all users first). */
export function installsFromReg(o: { hklm: string; hkcu: string; standalone: string }): InstallEntry[] {
  return [parseReg(o.hklm, 'all', 'setup'), parseReg(o.hkcu, 'user', 'setup'), parseReg(o.standalone, 'user', 'standalone')].filter((x): x is InstallEntry => Boolean(x));
}

/** This computer's Sara installs (Windows; elsewhere none). */
export function readInstalls(appId = SARA_APP_ID): InstallEntry[] {
  if (process.platform !== 'win32') return [];
  const q = (key: string) => {
    try {
      return execFileSync('reg.exe', ['query', key, '/reg:64'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  return installsFromReg({ hklm: q(`HKLM\\${UNINSTALL_KEY}\\{${appId}}_is1`), hkcu: q(`HKCU\\${UNINSTALL_KEY}\\{${appId}}_is1`), standalone: q(`HKCU\\${STANDALONE_KEY}`) });
}

/** The scope Setup must run in to replace the install in `appDir` (undefined: no Setup install there). */
export function scopeFor(entries: InstallEntry[], appDir: string): InstallScope | undefined {
  const setups = entries.filter((e) => e.kind === 'setup');
  // Only the install in that very folder decides (a folder Setup doesn't own: the caller's default).
  return setups.find((e) => same(e.location, appDir))?.scope;
}

/** The stale installs next to the one running from `runningDir` (none when Sara runs from neither). */
export function duplicateInstalls(entries: InstallEntry[], runningDir: string): Duplicate[] {
  const setups = entries.filter((e) => e.kind === 'setup');
  const live = setups.find((e) => same(e.location, runningDir));
  const out: Duplicate[] = [];
  if (live) for (const e of setups) if (e !== live) out.push({ entry: e, how: e.scope === 'all' ? 'admin' : 'uninstall' });
  // The old self-installed entry: never needed once Setup owns Sara.
  if (setups.length)
    for (const e of entries.filter((x) => x.kind === 'standalone')) out.push({ entry: e, how: setups.some((s) => same(s.location, e.location)) || same(e.location, runningDir) ? 'entry' : 'files' });
  return out;
}

export interface UpdatePlan {
  platform: 'win32' | 'darwin';
  from: string;
  to: string;
  /** The verified new installer (Windows .exe, macOS .dmg). */
  installer: string;
  /** What puts the old version back: the previous installer (Windows) or the kept Sara.app (macOS). */
  previous: string;
  /** Sara's install folder ({app} on Windows, Sara.app on macOS). */
  appDir: string;
  port: number;
  /** How long the new version gets to answer its health check. */
  timeoutMs: number;
  resultFile: string;
  /** Where one previous installer / app copy is kept for the next time. */
  keepDir?: string;
}

export interface UpdateResult {
  state: 'updating' | 'updated' | 'rolledback' | 'failed';
  message: string;
  at: string;
  from: string;
  to: string;
}

/** The platform-specific steps (seams for the tests). */
export interface UpdateDriver {
  install(file: string): Promise<void>;
  restore(previous: string): Promise<void>;
  /** Sara answers /api/health and the given version is the one installed. */
  healthy(version: string): Promise<boolean>;
}

type Run = (cmd: string, args: string[]) => Promise<string>;

const realRun: Run = (cmd, args) =>
  new Promise((ok, fail) => {
    // .cmd/.bat files need cmd.exe (the scripted test installers); real installers run directly.
    const shell = /\.(cmd|bat)$/i.test(cmd);
    const [c, a] = shell ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}"`]] : [cmd, args];
    execFile(c, a, { timeout: 15 * 60_000, windowsHide: true, windowsVerbatimArguments: shell, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? fail(Object.assign(err, { output: `${stdout}${stderr}` })) : ok(`${stdout}${stderr}`)));
  });

async function healthAt(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

function versionIn(file: string): string {
  try {
    return String((JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version ?? '');
  } catch {
    return '';
  }
}

/** Windows: the Inno Setup installer, silent, for the signed-in user (the per-user install) or, from the service's update task, for all users.
 *  HANKFIX: without a scope given, the scope of the install that owns `appDir` (never the other one: that would list Sara twice). */
export function windowsDriver(plan: Pick<UpdatePlan, 'appDir' | 'port' | 'resultFile'>, run: Run = realRun, scope?: InstallScope, installs: () => InstallEntry[] = readInstalls): UpdateDriver {
  const go = async (file: string) => {
    const s = scope ?? scopeFor(installs(), plan.appDir) ?? 'user';
    await run(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...(s === 'all' ? ['/ALLUSERS', '/MODE=service'] : ['/CURRENTUSER']), `/LOG=${join(dirname(plan.resultFile), `install-${basename(file)}.log`)}`]);
  };
  return {
    install: go,
    restore: go,
    healthy: async (v) => (await healthAt(plan.port)) && versionIn(join(plan.appDir, 'server', 'package.json')) === v,
  };
}

export interface MacFs {
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** macOS: Sara.app from the signed disk image replaces the installed one; launchd restarts her server. */
export function macDriver(o: { appDir: string; keepDir: string; port: number; uid: number; run?: Run; fs?: MacFs; health?: () => Promise<boolean>; version?: () => Promise<string> }): UpdateDriver {
  const run = o.run ?? realRun;
  const fs: MacFs = o.fs ?? {
    copy: async (a, b) => void (await run('ditto', [a, b])),
    remove: async (p) => rmSync(p, { recursive: true, force: true }),
    rename: async (a, b) => renameSync(a, b),
  };
  const team = async (app: string) => /TeamIdentifier=(\S+)/.exec(await run('codesign', ['-dv', app]).catch(() => ''))?.[1] ?? '';
  const restart = async () => void (await run('launchctl', ['kickstart', '-k', `gui/${o.uid}/com.backstagecoding.sara.server`]));
  const swapIn = async (src: string) => {
    await fs.remove(`${o.appDir}.new`);
    await fs.copy(src, `${o.appDir}.new`);
    await fs.remove(`${o.appDir}.old`);
    await fs.rename(o.appDir, `${o.appDir}.old`);
    await fs.rename(`${o.appDir}.new`, o.appDir);
    await fs.remove(`${o.appDir}.old`);
  };
  return {
    async install(dmg) {
      const out = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', dmg]);
      const mount = /(\/Volumes\/[^\n\t]+)\s*$/m.exec(out)?.[1]?.trim();
      if (!mount) throw new Error("The disk image didn't open.");
      try {
        const app = `${mount}/Sara.app`;
        await run('codesign', ['--verify', '--deep', '--strict', app]);
        const [mine, theirs] = [await team(o.appDir), await team(app)];
        if (!mine || mine !== theirs) throw new Error('The new Sara.app is signed by someone else: not installed.');
        // One previous copy is kept (the old app), for going back.
        const keep = `${o.keepDir}/Sara.app`;
        await fs.remove(keep);
        await fs.copy(o.appDir, keep);
        await swapIn(app);
      } finally {
        await run('hdiutil', ['detach', '-quiet', mount]).catch(() => run('hdiutil', ['detach', '-force', '-quiet', mount]).catch(() => ''));
      }
      await restart();
    },
    async restore(previous) {
      await swapIn(previous);
      await restart();
    },
    healthy: async (v) => (await (o.health ?? (() => healthAt(o.port)))()) && (await (o.version ?? (async () => versionIn(join(o.appDir, 'Contents', 'Resources', 'server', 'package.json'))))()) === v,
  };
}

const within = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`);

/** Installs, health-checks and, when the new version doesn't come up, puts the previous one back. */
export async function applyUpdate(plan: UpdatePlan, driver: UpdateDriver, o: { sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}): Promise<UpdateResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => new Date());
  const write = (state: UpdateResult['state'], message: string): UpdateResult => {
    const r: UpdateResult = { state, message, at: now().toISOString(), from: plan.from, to: plan.to };
    mkdirSync(dirname(plan.resultFile), { recursive: true });
    writeFileSync(plan.resultFile, `${JSON.stringify(r, null, 2)}\n`);
    return r;
  };
  const comesUp = async (version: string) => {
    const end = Date.now() + plan.timeoutMs;
    do {
      if (await driver.healthy(version).catch(() => false)) return true;
      await sleep(2000);
    } while (Date.now() < end);
    return driver.healthy(version).catch(() => false);
  };
  write('updating', `Installing Sara ${plan.to}…`);
  let why = '';
  try {
    await driver.install(plan.installer);
    if (await comesUp(plan.to)) {
      keep(plan);
      return write('updated', `Sara was updated to ${plan.to}.`);
    }
    why = `Sara ${plan.to} didn't start within ${within(plan.timeoutMs)}`;
  } catch (err) {
    why = `Installing Sara ${plan.to} failed (${(err as Error).message.split('\n')[0]})`;
  }
  try {
    await driver.restore(plan.previous);
    if (await comesUp(plan.from)) return write('rolledback', `${why}, so she went back to ${plan.from}.`);
  } catch {
    /* reported below */
  }
  return write('failed', `${why}, and going back to ${plan.from} didn't work either. Run ${plan.previous} to put ${plan.from} back.`);
}

/** Windows: after a good update the new installer is the one kept (it puts this version back next time). */
function keep(plan: UpdatePlan): void {
  if (plan.platform !== 'win32' || !plan.keepDir) return;
  try {
    mkdirSync(plan.keepDir, { recursive: true });
    const dest = join(plan.keepDir, basename(plan.installer));
    if (resolve(dest) !== resolve(plan.installer)) copyFileSync(plan.installer, dest);
    for (const f of readdirSync(plan.keepDir)) if (f !== basename(dest)) rmSync(join(plan.keepDir, f), { force: true });
  } catch {
    /* a missing copy only means the next update downloads it again */
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8')) as UpdatePlan;
  // Let Sara answer the page that pressed Update before the installer stops her.
  await new Promise((r) => setTimeout(r, 1500));
  const driver =
    plan.platform === 'darwin'
      ? macDriver({ appDir: plan.appDir, keepDir: plan.keepDir ?? dirname(plan.previous), port: plan.port, uid: process.getuid?.() ?? 501 })
      : windowsDriver(plan);
  const r = await applyUpdate(plan, driver);
  if (existsSync(plan.installer) && r.state !== 'failed') rmSync(plan.installer, { force: true });
  process.exit(r.state === 'updated' || r.state === 'rolledback' ? 0 : 1);
}
