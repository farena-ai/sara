// The browser Sara gets for herself (docs/BROWSER.md). One download, shared by her own testing
// browser (src/browser.ts) and the Browser (Playwright) add-on: Playwright's Chromium headless shell
// at the exact Playwright version the add-on pins, fetched by Sara's own Node into her data folder
// (`<data>/cache/browsers`, PLAYWRIGHT_BROWSERS_PATH), then checked: on Linux the shared libraries it
// needs (ldd), then a real launch (about:blank and a picture of it). No system package, no root,
// no Google Chrome. On Windows and Mac the installed Chrome or Edge is used when there is one.
//
// When a Linux server lacks a few libraries, Sara first fetches them from the system's own signed
// package repositories into her folder (dnf download + rpm2cpio, no root: nothing on the system
// changes) and points the browser at them. Only if that fails does the card say exactly what the
// server's administrator would run.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { CdpClient } from './cdp.ts';
import { privateLocalOn } from './net-guard.ts';

/** What @playwright/mcp@0.0.84 (store/mcp/playwright.json) depends on: its browser build matches. */
export const PLAYWRIGHT_CORE = '1.65.0-alpha-2026-10-30';
export const SETUP_TIMEOUT_MS = 20 * 60_000;

export type SetupState = 'missing' | 'downloading' | 'checking' | 'ready' | 'needs-admin' | 'unsupported' | 'failed';
export type UnsupportedWhy = 'platform' | 'arch' | 'musl';
export interface SetupBrowser {
  kind: 'shell' | 'chrome' | 'edge';
  path: string;
  /** Where the libraries Sara fetched for it are (Linux; LD_LIBRARY_PATH). */
  libDir?: string;
  /** From the computer (installed Chrome/Edge) or Sara's own download. */
  source: 'system' | 'download';
}
export interface SetupStatus {
  state: SetupState;
  browser?: SetupBrowser;
  /** downloading: percent of the current file; checking: which check. */
  percent?: number;
  step?: 'browser' | 'libraries' | 'test';
  /** needs-admin: the missing libraries, their packages and the one command. */
  missing?: string[];
  packages?: string[];
  command?: string;
  why?: UnsupportedWhy | 'private';
  error?: string;
  /** The self-test only worked without Chrome's own sandbox (see docs/BROWSER.md). */
  noSandbox?: boolean;
  at?: string;
}

// ---- pure helpers (tested on every OS) ----

/** The headless shell inside a Playwright browsers folder (newest build first), if it is there. */
export function shellIn(dir: string, platform: NodeJS.Platform, list: (d: string) => string[] = readdirSync, exists: (f: string) => boolean = existsSync): string | undefined {
  let builds: string[];
  try {
    builds = list(dir).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  } catch {
    return undefined;
  }
  const exe = platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const subs = platform === 'win32' ? ['chrome-headless-shell-win64', 'chrome-headless-shell-win32'] : platform === 'darwin' ? ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64'] : ['chrome-headless-shell-linux64', 'chrome-headless-shell-linux-arm64', 'chrome-linux'];
  for (const b of builds) {
    if (!exists(join(dir, b, 'INSTALLATION_COMPLETE'))) continue;
    for (const s of subs) for (const name of [exe, 'headless_shell']) if (exists(join(dir, b, s, name))) return join(dir, b, s, name);
  }
  return undefined;
}

/** The libraries `ldd` could not find (sonames, sorted, once each). */
export function parseLdd(out: string): string[] {
  const libs = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+=>\s+not found\s*$/.exec(line);
    if (m) libs.add(m[1]);
  }
  return [...libs].sort();
}

/** Library → package, per package family (the libraries Chromium's headless shell links). */
const LIB_PACKAGES: Record<string, { rpm: string; deb: string }> = {
  'libasound.so.2': { rpm: 'alsa-lib', deb: 'libasound2' },
  'libatk-1.0.so.0': { rpm: 'atk', deb: 'libatk1.0-0' },
  'libatk-bridge-2.0.so.0': { rpm: 'at-spi2-atk', deb: 'libatk-bridge2.0-0' },
  'libatspi.so.0': { rpm: 'at-spi2-core', deb: 'libatspi2.0-0' },
  'libcups.so.2': { rpm: 'cups-libs', deb: 'libcups2' },
  'libdbus-1.so.3': { rpm: 'dbus-libs', deb: 'libdbus-1-3' },
  'libdrm.so.2': { rpm: 'libdrm', deb: 'libdrm2' },
  'libexpat.so.1': { rpm: 'expat', deb: 'libexpat1' },
  'libgbm.so.1': { rpm: 'mesa-libgbm', deb: 'libgbm1' },
  'libgio-2.0.so.0': { rpm: 'glib2', deb: 'libglib2.0-0' },
  'libglib-2.0.so.0': { rpm: 'glib2', deb: 'libglib2.0-0' },
  'libgobject-2.0.so.0': { rpm: 'glib2', deb: 'libglib2.0-0' },
  'libnspr4.so': { rpm: 'nspr', deb: 'libnspr4' },
  'libnss3.so': { rpm: 'nss', deb: 'libnss3' },
  'libnssutil3.so': { rpm: 'nss-util', deb: 'libnss3' },
  'libsmime3.so': { rpm: 'nss', deb: 'libnss3' },
  'libudev.so.1': { rpm: 'systemd-libs', deb: 'libudev1' },
  'libwayland-server.so.0': { rpm: 'libwayland-server', deb: 'libwayland-server0' },
  'libX11.so.6': { rpm: 'libX11', deb: 'libx11-6' },
  'libxcb.so.1': { rpm: 'libxcb', deb: 'libxcb1' },
  'libXcomposite.so.1': { rpm: 'libXcomposite', deb: 'libxcomposite1' },
  'libXdamage.so.1': { rpm: 'libXdamage', deb: 'libxdamage1' },
  'libXext.so.6': { rpm: 'libXext', deb: 'libxext6' },
  'libXfixes.so.3': { rpm: 'libXfixes', deb: 'libxfixes3' },
  'libxkbcommon.so.0': { rpm: 'libxkbcommon', deb: 'libxkbcommon0' },
  'libXrandr.so.2': { rpm: 'libXrandr', deb: 'libxrandr2' },
};
export type PkgFamily = 'dnf' | 'yum' | 'apt' | 'zypper' | 'pacman' | null;

/** The packages that hold these libraries here, and the libraries Sara has no package name for. */
export function packagesFor(libs: string[], pm: PkgFamily): { packages: string[]; unknown: string[] } {
  const fam = pm === 'apt' ? 'deb' : pm === 'dnf' || pm === 'yum' || pm === 'zypper' ? 'rpm' : null;
  const packages = new Set<string>();
  const unknown: string[] = [];
  for (const l of libs) {
    const p = fam ? LIB_PACKAGES[l]?.[fam] : undefined;
    if (p) packages.add(p);
    else unknown.push(l);
  }
  return { packages: [...packages].sort(), unknown };
}

/** The one line the server's administrator runs (shown with a copy button, owner only). */
export function adminCommand(pm: PkgFamily, packages: string[]): string | undefined {
  if (!packages.length) return undefined;
  if (pm === 'dnf' || pm === 'yum') return `sudo ${pm} install -y ${packages.join(' ')}`;
  if (pm === 'apt') return `sudo apt-get install -y ${packages.join(' ')}`;
  if (pm === 'zypper') return `sudo zypper --non-interactive install ${packages.join(' ')}`;
  return undefined;
}

/** Playwright's download progress (`|■■■   |  45% of 110.2 MiB`). */
export function parseProgress(line: string): number | undefined {
  const m = /(\d{1,3})% of /.exec(line);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n : undefined;
}

/** The Browser (Playwright) add-on, by its command (Store recipe or added by hand). */
export function isPlaywrightMcp(c: { command?: string; args?: string[] }): boolean {
  return [c.command ?? '', ...(c.args ?? [])].some((a) => /(^|\/)@playwright\/mcp(@|$)/.test(a) || /(^|[\\/])playwright-mcp(\.cmd|\.exe)?$/.test(a));
}

/**
 * How Sara starts the Playwright tool server with her browser: extra arguments, environment and the
 * read-only folder to show it inside bubblewrap. The owner's own browser choice (--browser,
 * --executable-path, --cdp-endpoint, --extension) is left alone.
 */
export function playwrightLaunch(args: readonly string[], b: SetupBrowser | undefined, dir: string | undefined): { args: string[]; env: Record<string, string>; binds: { src: string; dest: string; rw: boolean }[] } {
  const has = (f: string) => args.some((a) => a === f || a.startsWith(`${f}=`));
  const extra: string[] = [];
  const env: Record<string, string> = dir ? { PLAYWRIGHT_BROWSERS_PATH: dir } : {};
  const binds: { src: string; dest: string; rw: boolean }[] = [];
  if (b && !['--browser', '--executable-path', '--cdp-endpoint', '--extension'].some(has)) {
    if (b.source === 'system') extra.push('--browser', b.kind === 'edge' ? 'msedge' : 'chrome');
    else {
      extra.push('--browser', 'chromium', '--executable-path', b.path);
      if (!has('--headless')) extra.push('--headless');
      if (dir) binds.push({ src: dir, dest: dir, rw: false });
      if (b.libDir) env.LD_LIBRARY_PATH = b.libDir;
    }
  }
  if (!has('--isolated') && !has('--user-data-dir') && !has('--storage-state')) extra.push('--isolated');
  return { args: [...args, ...extra], env, binds };
}

/** Sara's own npx (beside the Node she runs on), so no system Node is ever needed. */
export function ownNpx(execPath = process.execPath, platform: NodeJS.Platform = process.platform, exists: (f: string) => boolean = existsSync): string[] | undefined {
  // Path rules follow the platform asked about, not the one this runs on.
  const p = platform === 'win32' ? win32 : posix;
  const dir = p.dirname(execPath);
  const cands = platform === 'win32' ? [p.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')] : [p.join(p.dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), p.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')];
  const cli = cands.find((f) => exists(f));
  return cli ? [execPath, cli] : undefined;
}

// ---- the service ----

export interface LineRun {
  code: number | null;
  out: string;
}
export interface SetupDeps {
  dataDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** An installed Chrome or Edge (Windows/Mac), or undefined. */
  systemBrowser?: () => { kind: 'chrome' | 'edge'; path: string } | undefined;
  /** Runs argv (shell:false); lines as they come. */
  run?: (argv: string[], o: { env: NodeJS.ProcessEnv; cwd: string; signal: AbortSignal; onLine?: (l: string) => void }) => Promise<LineRun>;
  /** Opens about:blank in the browser and takes a picture; resolves true when it worked. */
  selfTest?: (b: SetupBrowser, o: { noSandbox: boolean; signal: AbortSignal }) => Promise<{ ok: boolean; error?: string }>;
  /** Linux: /etc/os-release text and the package manager (from the PRQ detector). */
  linux?: () => { pm: PkgFamily; ids: string[]; musl: boolean };
  npx?: string[];
  privateLocal?: () => boolean;
}

const MAX_OUT = 64 * 1024;
/** Spawns with shell:false, keeps the last 64 KiB of output. */
export const runLines: NonNullable<SetupDeps['run']> = (argv, o) =>
  new Promise((resolve) => {
    let out = '';
    let rest = '';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, out: (err as Error).message });
    }
    const take = (d: Buffer) => {
      const s = d.toString('utf8');
      out = (out + s).slice(-MAX_OUT);
      const parts = (rest + s).split(/\r?\n|\r/);
      rest = parts.pop() ?? '';
      for (const l of parts) if (l.trim()) o.onLine?.(l);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const stop = () => child.kill('SIGKILL');
    o.signal.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => resolve({ code: null, out: `${out}\n${e.message}` }));
    child.on('close', (code) => {
      o.signal.removeEventListener('abort', stop);
      resolve({ code, out });
    });
  });

/** Starts the browser, opens about:blank over DevTools and takes a picture of it. */
export const launchSelfTest: NonNullable<SetupDeps['selfTest']> = async (b, o) => {
  const profile = mkdtempSync(join(tmpdir(), 'sara-browser-test-'));
  const args = [b.kind === 'shell' ? '--headless' : '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--disable-dev-shm-usage', ...(o.noSandbox ? ['--no-sandbox'] : []), 'about:blank'];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: profile, TMPDIR: profile, ...(b.libDir ? { LD_LIBRARY_PATH: b.libDir } : {}) };
  const child = spawn(b.path, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  child.on('error', () => {});
  child.stderr?.on('error', () => {});
  let err = '';
  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  try {
    const ws = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`It did not start within 30 seconds. ${err.trim().slice(-300)}`)), 30_000);
      o.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      child.stderr!.on('data', (d: Buffer) => {
        err = (err + d.toString('utf8')).slice(-8000);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once('error', (e) => reject(e));
      child.once('exit', (code) => reject(new Error(`It stopped right away (exit code ${code}). ${err.trim().slice(-300)}`)));
    });
    child.stderr!.resume();
    const cdp = await CdpClient.connect(ws);
    try {
      const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
      const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
      const ready = (await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId)) as { result?: { value?: string } };
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId, 30_000)) as { data?: string };
      if (!ready.result?.value || !shot.data || shot.data.length < 100) return { ok: false, error: 'It started but could not show a page.' };
      return { ok: true };
    } finally {
      cdp.close();
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 400) };
  } finally {
    kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 1000).unref();
  }
};

function linuxInfo(): { pm: PkgFamily; ids: string[]; musl: boolean } {
  const rel = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const field = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(rel)?.[1] ?? '').replace(/^["']|["']$/g, '').toLowerCase();
  const ids = [field('ID'), ...field('ID_LIKE').split(/\s+/)].filter(Boolean);
  const on = (c: string) => ['/usr/bin', '/bin', '/usr/sbin'].some((d) => existsSync(join(d, c)));
  const is = (...n: string[]) => ids.some((i) => n.includes(i));
  const pm: PkgFamily = is('debian', 'ubuntu') && on('apt-get') ? 'apt' : is('fedora', 'rhel', 'centos') && on('dnf') ? 'dnf' : is('fedora', 'rhel', 'centos') && on('yum') ? 'yum' : is('suse', 'opensuse', 'sles') && on('zypper') ? 'zypper' : is('arch') ? 'pacman' : null;
  const musl = is('alpine') || existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  return { pm, ids, musl };
}

/** Repositories `dnf download` may use: the distribution's own (signed) ones, nothing third-party. */
export function distroRepos(repolist: string): string[] {
  return repolist
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((id) => /^(baseos|appstream|powertools|crb|fedora|updates|ol\d+_(baseos_latest|appstream)|rhel-\d+-for-[\w-]+-(baseos|appstream)-rpms|centos-stream-\d+-(baseos|appstream))$/i.test(id));
}

export class BrowserSetup {
  readonly dir: string;
  readonly #d: SetupDeps;
  #status: SetupStatus = { state: 'missing' };
  #job: Promise<SetupStatus> | undefined;
  #ctl: AbortController | undefined;
  readonly #listeners = new Set<(s: SetupStatus) => void>();

  constructor(d: SetupDeps) {
    this.#d = d;
    // Under cache/: rebuildable, so backups leave its ~280 MB out (src/backup.ts SKIP_TOP).
    this.dir = join(d.dataDir, 'cache', 'browsers');
    this.#status = this.#look();
  }
  get #platform(): NodeJS.Platform {
    return this.#d.platform ?? process.platform;
  }
  get libDir(): string {
    // EL keeps 64-bit libraries in usr/lib64 on x86_64 and aarch64 alike.
    return join(this.dir, 'libs', 'root', 'usr', 'lib64');
  }
  #file(): string {
    return join(this.dir, 'status.json');
  }
  #save(s: SetupStatus): void {
    this.#status = { ...s, at: new Date().toISOString() };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.#file(), JSON.stringify(this.#status));
    } catch {
      /* status is also kept in memory */
    }
    for (const fn of this.#listeners) fn(this.#status);
  }
  onChange(fn: (s: SetupStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #unsupported(): UnsupportedWhy | undefined {
    const p = this.#platform;
    if (p !== 'win32' && p !== 'darwin' && p !== 'linux') return 'platform';
    const a = this.#d.arch ?? process.arch;
    if (a !== 'x64' && a !== 'arm64') return 'arch';
    if (p === 'win32' && a === 'arm64') return undefined;
    if (p === 'linux' && (this.#d.linux ?? linuxInfo)().musl) return 'musl';
    return undefined;
  }

  /** What is there now, without downloading (cheap: called by every status read). */
  #look(): SetupStatus {
    const why = this.#unsupported();
    if (why) return { state: 'unsupported', why };
    if (this.#platform !== 'linux') {
      const sys = this.#d.systemBrowser?.();
      if (sys) return { state: 'ready', browser: { ...sys, source: 'system' } };
    }
    let saved: SetupStatus | undefined;
    try {
      saved = JSON.parse(readFileSync(this.#file(), 'utf8')) as SetupStatus;
    } catch {
      saved = undefined;
    }
    const path = shellIn(this.dir, this.#platform);
    if (saved?.state === 'ready' && path && saved.browser?.path === path) return saved;
    if (saved && (saved.state === 'needs-admin' || saved.state === 'failed') && path) return saved;
    return { state: 'missing' };
  }

  status(): SetupStatus {
    return this.#job ? this.#status : (this.#status = this.#status.state === 'ready' || this.#status.state === 'unsupported' ? this.#status : this.#look());
  }

  /** The browser to use, when it is ready. */
  ready(): SetupBrowser | undefined {
    const s = this.status();
    return s.state === 'ready' ? s.browser : undefined;
  }

  /** Gets it (or looks again: *Try again*). Returns at once; `wait()` waits for the result. */
  ensure(o: { force?: boolean } = {}): SetupStatus {
    if (this.#job) return this.#status;
    const now = this.status();
    if (now.state === 'unsupported' || (now.state === 'ready' && !o.force)) return now;
    if ((this.#d.privateLocal ?? privateLocalOn)()) {
      this.#status = { state: 'missing', why: 'private' };
      return this.#status;
    }
    this.#ctl = new AbortController();
    const timer = setTimeout(() => this.#ctl?.abort(new Error('timeout')), SETUP_TIMEOUT_MS);
    timer.unref?.();
    this.#save({ state: 'downloading', step: 'browser', percent: 0 });
    this.#job = this.#run(this.#ctl.signal)
      .catch((e: Error) => ({ state: 'failed' as const, error: e.message.slice(0, 400) }))
      .then((s) => {
        clearTimeout(timer);
        this.#save(s);
        this.#job = undefined;
        return this.#status;
      });
    return this.#status;
  }

  async wait(timeoutMs = SETUP_TIMEOUT_MS): Promise<SetupStatus> {
    if (!this.#job) return this.status();
    let t: NodeJS.Timeout | undefined;
    const r = await Promise.race([this.#job, new Promise<SetupStatus>((res) => (t = setTimeout(() => res(this.#status), timeoutMs)))]);
    clearTimeout(t);
    return r;
  }

  stop(): void {
    this.#ctl?.abort(new Error('stopped'));
  }

  async #run(signal: AbortSignal): Promise<SetupStatus> {
    const plat = this.#platform;
    if (plat !== 'linux') {
      const sys = this.#d.systemBrowser?.();
      if (sys) return { state: 'ready', browser: { ...sys, source: 'system' } };
    }
    mkdirSync(this.dir, { recursive: true });
    const run = this.#d.run ?? runLines;
    const env: NodeJS.ProcessEnv = { ...(this.#d.env ?? process.env), PLAYWRIGHT_BROWSERS_PATH: this.dir, npm_config_cache: join(this.#d.dataDir, 'cache', 'npm'), npm_config_update_notifier: 'false', npm_config_fund: 'false' };
    let path = shellIn(this.dir, plat);
    if (!path) {
      const npx = this.#d.npx ?? ownNpx();
      if (!npx) return { state: 'failed', error: "Sara's own npx was not found beside her Node." };
      const r = await run([...npx, '-y', `playwright-core@${PLAYWRIGHT_CORE}`, 'install', 'chromium-headless-shell'], {
        env,
        cwd: this.dir,
        signal,
        onLine: (l) => {
          const p = parseProgress(l);
          // The browser comes first; a small helper download follows (keep showing 100%).
          if (p !== undefined && p !== this.#status.percent && !(this.#status.percent === 100 && p < 100)) this.#status = { state: 'downloading', step: 'browser', percent: p };
        },
      });
      if (signal.aborted) return { state: 'failed', error: String((signal.reason as Error)?.message ?? 'stopped') };
      path = shellIn(this.dir, plat);
      if (r.code !== 0 || !path) return { state: 'failed', error: (r.out.trim().split(/\r?\n/).slice(-3).join(' ') || `exit ${r.code}`).slice(0, 400) };
    }
    const browser: SetupBrowser = { kind: 'shell', path, source: 'download' };
    if (plat === 'linux') {
      this.#status = { state: 'checking', step: 'libraries' };
      const sys = (this.#d.linux ?? linuxInfo)();
      const ldd = async (lib?: string) => parseLdd((await run(['ldd', path], { env: { PATH: '/usr/bin:/bin', ...(lib ? { LD_LIBRARY_PATH: lib } : {}) }, cwd: this.dir, signal })).out);
      let missing = await ldd();
      // A fetched library can need another (libgbm needs libwayland-server): a few rounds.
      for (let round = 0; missing.length && round < 3 && (sys.pm === 'dnf' || sys.pm === 'yum'); round++) {
        const { packages } = packagesFor(missing, sys.pm);
        if (!packages.length) break;
        await this.#userLibs(packages, run, signal);
        if (!existsSync(this.libDir)) break;
        const still = await ldd(this.libDir);
        if (still.length >= missing.length && still.every((l) => missing.includes(l))) break;
        browser.libDir = this.libDir;
        missing = still;
      }
      if (missing.length) {
        const { packages, unknown } = packagesFor(missing, sys.pm);
        const command = adminCommand(sys.pm, packages);
        return { state: 'needs-admin', browser, missing, packages, ...(command ? { command } : {}), ...(unknown.length && !command ? { error: unknown.join(' ') } : {}) };
      }
    }
    this.#status = { state: 'checking', step: 'test' };
    const test = this.#d.selfTest ?? launchSelfTest;
    let r = await test(browser, { noSandbox: false, signal });
    let noSandbox = false;
    // A service user without unprivileged user namespaces can't start Chrome's own sandbox; the
    // consumers already run it without (Playwright's default; bubblewrap fences Sara's own).
    if (!r.ok && plat === 'linux' && !signal.aborted) {
      const again = await test(browser, { noSandbox: true, signal });
      if (again.ok) {
        r = again;
        noSandbox = true;
      }
    }
    if (!r.ok) return { state: 'failed', browser, error: r.error ?? 'The test did not pass.' };
    return { state: 'ready', browser, ...(noSandbox ? { noSandbox } : {}) };
  }

  /** dnf download + rpm2cpio into `<data>/cache/browsers/libs/root` (no root, nothing on the system changes). */
  async #userLibs(packages: string[], run: NonNullable<SetupDeps['run']>, signal: AbortSignal): Promise<void> {
    const base = join(this.dir, 'libs');
    const rpms = join(base, 'rpms');
    const root = join(base, 'root');
    mkdirSync(rpms, { recursive: true });
    mkdirSync(root, { recursive: true });
    const env = { PATH: '/usr/bin:/bin', HOME: base, TMPDIR: base, LANG: 'C' };
    const repos = distroRepos((await run(['dnf', '-q', 'repolist', '--enabled'], { env, cwd: base, signal })).out);
    if (!repos.length) return;
    const arch = (this.#d.arch ?? process.arch) === 'arm64' ? 'aarch64' : 'x86_64';
    // Non-root dnf still keeps its locks in /var/tmp (a service's PrivateTmp is fine); its cache, log
    // and state go into Sara's folder.
    await run(['dnf', 'download', '-q', '-y', '--disablerepo=*', ...repos.map((r) => `--enablerepo=${r}`), `--setopt=cachedir=${join(base, 'cache')}`, `--setopt=logdir=${base}`, `--setopt=persistdir=${join(base, 'persist')}`, `--arch=${arch}`, '--destdir', rpms, ...packages], { env, cwd: base, signal });
    let files: string[] = [];
    try {
      files = readdirSync(rpms).filter((f) => f.endsWith('.rpm'));
    } catch {
      return;
    }
    for (const f of files) {
      // The system's own keys check each package's signature before anything is unpacked.
      const sig = await run(['rpm', '-K', join(rpms, f)], { env, cwd: base, signal });
      if (sig.code !== 0 || !/\bsignatures OK\b/i.test(sig.out)) continue;
      await run(['/bin/sh', '-c', 'rpm2cpio "$1" | cpio -idm --quiet', 'sh', join(rpms, f)], { env, cwd: root, signal });
    }
    for (const d of ['cache', 'persist', 'rpms']) rmSync(join(base, d), { recursive: true, force: true });
  }
}

// One per server (main.ts makes it); null in tests and tools that don't run a server.
let current: BrowserSetup | undefined;
export function setBrowserSetup(s: BrowserSetup | undefined): void {
  current = s;
}
export const browserSetup = (): BrowserSetup | undefined => current;
