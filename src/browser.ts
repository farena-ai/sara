// Phase 49: a real browser she drives to test her own web apps (open, click, type, read, check,
// screenshot). A headless Chromium-family browser (Chrome for Testing's headless shell on Linux,
// Microsoft Edge on Windows, Chrome/Edge/Chromium on macOS) controlled over the DevTools protocol
// with Sara's own WebSocket client; no browser-automation packages.
//
// Each conversation gets its own browser with a throwaway profile in a temporary folder: no
// extensions, no sync or sign-in (Edge runs InPrivate, or a fresh profile signs into the Windows
// Microsoft account). It runs inside the same sandbox as her commands (bubblewrap on Linux), and
// all its traffic goes through a guard (src/browser-guard.ts) that lets it reach only previews,
// plus public sites when web access is allowed. It closes after the turn or 5 idle minutes.
import { spawn, type ChildProcess } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserGuard, PREVIEW_HOST } from './browser-guard.ts';
import { CdpClient, type CdpEvent } from './cdp.ts';
import type { PreviewManager } from './preview.ts';
import { bwrapArgs, SANDBOX_EXEC, seatbeltProfile, type SandboxInfo } from './tools/sandbox.ts';

export const IDLE_MS = 5 * 60_000;
const MAX_SESSIONS = 2;
/** The pinned Linux build the installer puts in /opt/sara-browser (deploy/install-browser.sh). */
export const LINUX_BROWSER_DIR = '/opt/sara-browser';

export interface BrowserInfo {
  found: boolean;
  path?: string;
  name?: string;
  kind?: 'edge' | 'chrome' | 'chromium' | 'shell';
  /** How to get one (when not found). */
  how: string;
}

const HOW: Record<string, string> = {
  linux: 'Install it with: sudo bash deploy/install-browser.sh (downloads the pinned Chrome for Testing headless shell, about 120 MB, checks its SHA-256 and unpacks it into /opt/sara-browser; nothing else is installed). Then restart Sara.',
  win32: 'Microsoft Edge comes with Windows; if it was removed, install it again from microsoft.com/edge and restart Sara.',
  darwin: 'Install Google Chrome, Microsoft Edge or Chromium into Applications, then restart Sara.',
};

/** Finds a browser for testing (SARA_BROWSER overrides). */
export function findBrowser(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): BrowserInfo {
  const how = HOW[platform] ?? 'Set SARA_BROWSER to the path of a Chromium-family browser.';
  const kindOf = (p: string): BrowserInfo['kind'] => (/msedge|Microsoft Edge/i.test(p) ? 'edge' : /headless-shell/i.test(p) ? 'shell' : /chromium/i.test(p) ? 'chromium' : 'chrome');
  const names: Record<string, string> = { edge: 'Microsoft Edge', shell: 'Chrome for Testing (headless shell)', chromium: 'Chromium', chrome: 'Google Chrome' };
  const cands: string[] = [];
  if (env.SARA_BROWSER) cands.push(env.SARA_BROWSER);
  if (platform === 'linux') cands.push(`${LINUX_BROWSER_DIR}/chrome-headless-shell-linux64/chrome-headless-shell`, `${LINUX_BROWSER_DIR}/chrome-linux64/chrome`);
  else if (platform === 'win32') {
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    cands.push(`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
    if (env.LOCALAPPDATA) cands.push(`${env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`);
    cands.push(`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', ...(env.HOME ? [`${env.HOME}/Applications`] : [])]) {
      cands.push(`${root}/Google Chrome.app/Contents/MacOS/Google Chrome`, `${root}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`, `${root}/Chromium.app/Contents/MacOS/Chromium`);
    }
  }
  for (const p of cands) {
    if (p && exists(p)) {
      const kind = kindOf(p);
      return { found: true, path: p, kind, name: names[kind!], how };
    }
  }
  return { found: false, how };
}

/** Command-line switches: headless, throwaway profile, nothing that phones home, all traffic through the guard. */
export function browserArgs(info: BrowserInfo, profile: string, guardPort: number, opts: { inSandbox?: boolean } = {}): string[] {
  return [
    info.kind === 'shell' ? '--headless' : '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--disable-breakpad',
    '--metrics-recording-only',
    '--no-pings',
    '--mute-audio',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,msEdgeSync,msImplicitSignin,msSignInFRE,EdgeCollections,msShopping',
    `--proxy-server=http://127.0.0.1:${guardPort}`,
    // No exceptions, not even 127.0.0.1: the guard decides everything.
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--window-size=1280,800',
    // Edge: InPrivate, so a fresh profile never signs into the Windows Microsoft account.
    ...(info.kind === 'edge' ? ['--inprivate'] : []),
    // Inside bubblewrap the browser's own sandbox can't make namespaces; bubblewrap is the sandbox.
    ...(opts.inSandbox ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    'about:blank',
  ];
}

export interface LaunchedBrowser {
  wsUrl: string;
  kill: () => void;
  exited: Promise<void>;
}

export type Launcher = (info: BrowserInfo, sandbox: SandboxInfo, guardPort: number) => Promise<LaunchedBrowser>;

/** Starts the browser (in the command sandbox where there is one) and waits for its DevTools address. */
export const launchBrowser: Launcher = async (info, sandbox, guardPort) => {
  if (!info.found || !info.path) throw new Error(`No browser for testing on this server. ${info.how}`);
  const profile = mkdtempSync(join(tmpdir(), 'sara-browser-'));
  let file = info.path;
  let args: string[];
  const extra: { uid?: number; gid?: number } = {};
  if (sandbox.mode === 'bwrap') {
    // The browser's folder read-only, the throwaway profile as the (only) writable folder.
    const root = info.path.startsWith(`${LINUX_BROWSER_DIR}/`) ? LINUX_BROWSER_DIR : dirname(info.path);
    file = 'bwrap';
    args = [...bwrapArgs(profile, true, [{ src: root, dest: root }]), info.path, ...browserArgs(info, '/workspace', guardPort, { inSandbox: true })];
  } else if (sandbox.mode === 'seatbelt') {
    file = SANDBOX_EXEC;
    const app = info.path.includes('.app/') ? info.path.slice(0, info.path.indexOf('.app/') + 4) : dirname(info.path);
    args = ['-p', seatbeltProfile({ workspace: profile, tmp: profile, binds: [{ src: app, dest: app }], ...(sandbox.dataDir ? { dataDir: sandbox.dataDir } : {}) }, true), info.path, ...browserArgs(info, profile, guardPort)];
  } else if (sandbox.mode === 'user') {
    if (sandbox.uid !== undefined && sandbox.gid !== undefined) {
      try {
        chownSync(profile, sandbox.uid, sandbox.gid);
      } catch {
        /* not root */
      }
      extra.uid = sandbox.uid;
      extra.gid = sandbox.gid;
    }
    args = browserArgs(info, profile, guardPort, { inSandbox: true });
  } else {
    args = browserArgs(info, profile, guardPort);
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: profile, TMPDIR: profile, LANG: 'en_US.UTF-8' };
  if (process.platform === 'win32') for (const k of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.platform === 'win32') {
    env.TEMP = profile;
    env.TMP = profile;
  }
  const child: ChildProcess = spawn(file, args, { env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], ...extra });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.on('error', () => {});
  child.stderr?.on('error', () => {});
  const cleanup = () => {
    // Windows holds files a moment after the browser exits.
    setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 500).unref();
  };
  void exited.then(cleanup);
  const kill = () => {
    try {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`The browser didn't start within 20 seconds. ${err.trim().slice(-400)}`));
    }, 20_000);
    child.stderr!.on('data', (d: Buffer) => {
      err = (err + d.toString('utf8')).slice(-8000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't start the browser: ${e.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`The browser stopped right away (exit code ${code}). ${err.trim().slice(-400)}`));
    });
  });
  // Nothing else reads its error output: keep the pipe drained.
  child.stderr!.resume();
  return { wsUrl, kill, exited };
};

export const VIEWPORTS = { desktop: { width: 1280, height: 800, mobile: false }, phone: { width: 390, height: 844, mobile: true } } as const;

// ---- The page agent: Sara's one fixed script for reading pages (desktop/shared/page-agent.js) ----
// Phase 87: the scripts that used to live here moved into the shared page agent, the same file the
// Windows and Mac apps' Sara browser and the reference hands run, so there is one implementation.
// It only reads the page or finds an element and its position; clicks and typing are real input
// events sent through the DevTools protocol. Arguments go in as JSON; nothing else is evaluated.
export const PAGE_AGENT_PATH = join(import.meta.dirname, '..', 'desktop', 'shared', 'page-agent.js');
let pageAgentText: string | undefined;
/** The page agent's source (one expression; read once). */
export function pageAgentSource(): string {
  return (pageAgentText ??= readFileSync(PAGE_AGENT_PATH, 'utf8').trim().replace(/;\s*$/, ''));
}
/** The one expression evaluated in a page: the agent, then one of its named functions with JSON arguments. */
export function pageAgentCall(fn: 'find' | 'read' | 'check' | 'snapshot' | 'text' | 'target' | 'focusFor' | 'choose' | 'scroll' | 'keys' | 'fileInput' | 'mark' | 'state' | (string & {}), args: unknown): string {
  return `(${pageAgentSource()}).call(${JSON.stringify(fn)}, ${JSON.stringify(args ?? {})})`;
}

export const CHECK_TYPES = ['text_visible', 'text_absent', 'element_exists', 'element_visible', 'element_hidden', 'count_at_least', 'title_contains', 'url_contains', 'no_horizontal_scroll', 'input_value', 'no_errors'] as const;
export type Check = { type: (typeof CHECK_TYPES)[number]; text?: string; selector?: string; count?: number };

export interface Viewport {
  width: number;
  height: number;
  mobile: boolean;
}

/** One browser with one page, for one conversation. */
export class BrowserSession {
  readonly cdp: CdpClient;
  readonly sessionId: string;
  readonly guard: BrowserGuard;
  readonly #launched: LaunchedBrowser;
  /** Page problems seen since the last look (script errors, failed loads, console errors). */
  readonly errors: string[] = [];
  viewport: Viewport = { ...VIEWPORTS.desktop };
  lastUsed = Date.now();
  webAllowed = false;
  closed = false;
  #status = 0;

  constructor(cdp: CdpClient, sessionId: string, guard: BrowserGuard, launched: LaunchedBrowser) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.guard = guard;
    this.#launched = launched;
    cdp.on((ev) => this.#event(ev));
  }

  static async start(info: BrowserInfo, sandbox: SandboxInfo, previews: PreviewManager, launcher: Launcher = launchBrowser): Promise<BrowserSession> {
    let session: BrowserSession | undefined;
    const guard = new BrowserGuard({ preview: (req, res, raw) => previews.handle(req, res, raw), webAllowed: () => session?.webAllowed ?? false });
    const port = await guard.listen();
    let launched: LaunchedBrowser | undefined;
    try {
      launched = await launcher(info, sandbox, port);
      const cdp = await CdpClient.connect(launched.wsUrl);
      const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
      const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
      session = new BrowserSession(cdp, sessionId, guard, launched);
      for (const d of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await cdp.send(d, {}, sessionId);
      await session.setViewport(VIEWPORTS.desktop);
      return session;
    } catch (err) {
      launched?.kill();
      guard.close();
      throw err;
    }
  }

  #event(ev: CdpEvent): void {
    if (ev.sessionId !== this.sessionId) return;
    const add = (s: string) => {
      if (this.errors.length < 30) this.errors.push(s.replaceAll('http://sara-preview.test', '').replace(/\s+/g, ' ').slice(0, 300));
    };
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      add(`script error: ${shortUrl(d?.exception?.description?.split('\n')[0] ?? d?.text ?? 'unknown')}`);
    } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      add(`console.error: ${((ev.params.args as { value?: unknown; description?: string }[]) ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' ')}`);
    } else if (ev.method === 'Log.entryAdded') {
      const e = ev.params.entry as { level?: string; text?: string; url?: string } | undefined;
      // The browser asks every site for /favicon.ico by itself: not the app's problem.
      if (e?.level === 'error' && !/\/favicon\.ico$/.test(e.url ?? '')) add(`${e.text ?? 'error'}${e.url ? ` (${shortUrl(e.url)})` : ''}`);
    } else if (ev.method === 'Network.responseReceived' && ev.params.type === 'Document') {
      this.#status = Number((ev.params.response as { status?: number })?.status ?? 0);
    }
  }

  async #eval<T>(fn: 'find' | 'read' | 'check' | 'info', arg: unknown): Promise<T> {
    const expression = fn === 'info' ? '({ title: document.title, url: location.href })' : pageAgentCall(fn, arg);
    const r = (await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, this.sessionId)) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(`The page couldn't be read: ${r.exceptionDetails.text ?? 'script error'}`);
    return r.result?.value as T;
  }

  async setViewport(v: Viewport): Promise<void> {
    this.viewport = { ...v };
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile }, this.sessionId);
    await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: v.mobile, maxTouchPoints: v.mobile ? 5 : 1 }, this.sessionId).catch(() => {});
  }

  /** Opens an address; waits for the page to load (up to 20 s). */
  async open(url: string): Promise<{ url: string; title: string; status: number; error?: string }> {
    this.errors.length = 0;
    this.#status = 0;
    const loaded = this.cdp.waitFor((ev) => ev.sessionId === this.sessionId && ev.method === 'Page.loadEventFired', 20_000);
    const nav = (await this.cdp.send('Page.navigate', { url }, this.sessionId)) as { errorText?: string };
    if (nav.errorText) return { url, title: '', status: 0, error: nav.errorText };
    await loaded;
    await settle(400);
    const info = await this.#eval<{ title: string; url: string }>('info', null);
    return { url: info.url, title: info.title, status: this.#status };
  }

  async screenshot(v: Viewport, full = false): Promise<{ data: string; mime: string; width: number; height: number }> {
    if (v.width !== this.viewport.width || v.height !== this.viewport.height || v.mobile !== this.viewport.mobile) {
      await this.setViewport(v);
      await settle(500);
    }
    let clip: Record<string, number> | undefined;
    let height = v.height;
    if (full) {
      const m = (await this.cdp.send('Page.getLayoutMetrics', {}, this.sessionId)) as { cssContentSize?: { height: number } };
      height = Math.min(4000, Math.max(v.height, Math.ceil(m.cssContentSize?.height ?? v.height)));
      clip = { x: 0, y: 0, width: v.width, height, scale: 1 };
    }
    let shot = (await this.cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, this.sessionId, 60_000)) as { data: string };
    let mime = 'image/png';
    // Uploads are capped at 8 MB: a very large page goes as JPEG.
    if (shot.data.length * 0.75 > 7 * 1024 * 1024) {
      shot = (await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, ...(clip ? { clip, captureBeyondViewport: true } : {}) }, this.sessionId, 60_000)) as { data: string };
      mime = 'image/jpeg';
    }
    return { data: shot.data, mime, width: v.width, height };
  }

  async #find(a: Record<string, unknown>): Promise<{ found?: boolean; x?: number; y?: number; desc?: string; covered?: string; disabled?: boolean; error?: string; selected?: string }> {
    return this.#eval('find', a);
  }

  /** Clicks an element (CSS selector, or its visible text) with real mouse events. */
  async click(target: { selector?: string; text?: string }): Promise<string> {
    const f = await this.#find({ ...target });
    if (f.error) throw new Error(f.error);
    if (!f.found || f.x === undefined || f.y === undefined) throw new Error(`Nothing on the page matches ${target.selector ? `"${target.selector}"` : `the text "${target.text}"`}.`);
    const nav = this.cdp.waitFor((ev) => ev.sessionId === this.sessionId && ev.method === 'Page.frameStartedLoading', 600);
    const base = { x: f.x, y: f.y, button: 'left', clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: f.x, y: f.y }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, this.sessionId);
    if (await nav) await this.cdp.waitFor((ev) => ev.sessionId === this.sessionId && ev.method === 'Page.loadEventFired', 15_000);
    await settle(300);
    return `Clicked ${f.desc}${f.disabled ? ' (it is disabled)' : ''}${f.covered ? ` (careful: ${f.covered} was on top of it at that spot)` : ''}.`;
  }

  /** Types into a field (CSS selector, or its label/placeholder text); a list picks the option. */
  async type(target: { selector?: string; text?: string }, value: string, submit = false): Promise<string> {
    const f = await this.#find({ ...target, field: true, focus: true, value });
    if (f.error) throw new Error(f.error);
    if (!f.found) throw new Error(`No field matches ${target.selector ? `"${target.selector}"` : `"${target.text}"`}.`);
    if (f.selected) return `Picked "${f.selected}" in ${f.desc}.`;
    await this.cdp.send('Input.insertText', { text: value }, this.sessionId);
    if (submit) {
      const nav = this.cdp.waitFor((ev) => ev.sessionId === this.sessionId && ev.method === 'Page.frameStartedLoading', 600);
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key }, this.sessionId);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, this.sessionId);
      if (await nav) await this.cdp.waitFor((ev) => ev.sessionId === this.sessionId && ev.method === 'Page.loadEventFired', 15_000);
    }
    await settle(250);
    return `Typed ${value.length} characters into ${f.desc}${submit ? ' and pressed Enter' : ''}.`;
  }

  read(selector?: string, max = 6000): Promise<{ title: string; url: string; text: string; more: boolean; controls: string[]; width: number; scrollWidth: number; error?: string }> {
    return this.#eval('read', { selector: selector || '', max });
  }

  async check(checks: Check[]): Promise<{ ok: boolean; detail?: string }[]> {
    const page = checks.filter((c) => c.type !== 'no_errors');
    const results = page.length ? await this.#eval<{ ok: boolean; detail?: string }[]>('check', page) : [];
    let i = 0;
    return checks.map((c) => (c.type === 'no_errors' ? { ok: this.errors.length === 0, detail: this.errors.length ? this.errors.slice(0, 5).join(' | ') : 'none' } : results[i++]));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.cdp.send('Browser.close', {}, undefined, 3000);
    } catch {
      /* already gone */
    }
    this.cdp.close();
    this.guard.close();
    // Make sure every process of it is gone.
    await Promise.race([this.#launched.exited, settle(2000)]);
    this.#launched.kill();
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Addresses as she knows them: "/preview/<token>/x" (not the browser's internal host name). */
const shortUrl = (u: string) => u.replace(/^http:\/\/sara-preview\.test/, '');

/** One testing browser per conversation (at most two at once), closed when idle. */
export class BrowserManager {
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #starting = new Map<string, Promise<BrowserSession>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #opts: { info: () => BrowserInfo; sandbox: () => SandboxInfo; previews: PreviewManager; idleMs?: number; launcher?: Launcher };
  #info: BrowserInfo | undefined;

  constructor(opts: { info?: () => BrowserInfo; sandbox: () => SandboxInfo; previews: PreviewManager; idleMs?: number; launcher?: Launcher; sweep?: boolean }) {
    this.#opts = { ...opts, info: opts.info ?? (() => findBrowser()) };
    if (opts.sweep) sweepLeftovers();
  }

  /** Found / not found (looked up once; Settings shows it). */
  status(): BrowserInfo {
    return (this.#info ??= this.#opts.info());
  }

  /** Looks again (after installing one). */
  refresh(): BrowserInfo {
    this.#info = undefined;
    return this.status();
  }

  has(conversationId: string): boolean {
    return this.#sessions.has(conversationId);
  }

  async session(conversationId: string, webAllowed: boolean): Promise<BrowserSession> {
    let s = this.#sessions.get(conversationId);
    if (s && (s.closed || s.cdp.closed)) {
      this.#sessions.delete(conversationId);
      s = undefined;
    }
    if (!s) {
      const pending = this.#starting.get(conversationId);
      if (pending) s = await pending;
      else {
        if (this.#sessions.size + this.#starting.size >= MAX_SESSIONS) throw new Error(`Already ${MAX_SESSIONS} testing browsers open (other conversations); try again in a few minutes.`);
        const info = this.status();
        if (!info.found) throw new Error(`No browser for testing on this server. ${info.how}`);
        const p = BrowserSession.start(info, this.#opts.sandbox(), this.#opts.previews, this.#opts.launcher);
        this.#starting.set(conversationId, p);
        try {
          s = await p;
        } finally {
          this.#starting.delete(conversationId);
        }
        this.#sessions.set(conversationId, s);
        s.cdp.onClose = () => {
          if (this.#sessions.get(conversationId) === s) this.#sessions.delete(conversationId);
        };
      }
    }
    s.webAllowed = webAllowed;
    s.lastUsed = Date.now();
    this.#arm(conversationId);
    return s;
  }

  #arm(conversationId: string): void {
    clearTimeout(this.#timers.get(conversationId));
    const t = setTimeout(() => void this.close(conversationId), this.#opts.idleMs ?? IDLE_MS);
    t.unref();
    this.#timers.set(conversationId, t);
  }

  async close(conversationId: string): Promise<boolean> {
    clearTimeout(this.#timers.get(conversationId));
    this.#timers.delete(conversationId);
    const s = this.#sessions.get(conversationId);
    if (!s) return false;
    this.#sessions.delete(conversationId);
    await s.close();
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }

  open(): string[] {
    return [...this.#sessions.keys()];
  }
}

/** The address the testing browser uses for a preview link ("/preview/<t>/x" or a full Sara address). */
export function browserAddress(url: string): { kind: 'preview'; token: string; address: string } | { kind: 'web'; address: string } | undefined {
  const s = url.trim();
  const m = /^(?:https?:\/\/[^/]+)?\/preview\/([0-9a-f]{32})(\/[^\s#]*)?(#\S*)?$/i.exec(s);
  if (m) return { kind: 'preview', token: m[1].toLowerCase(), address: `http://${PREVIEW_HOST}/preview/${m[1].toLowerCase()}${m[2] ?? '/'}${m[3] ?? ''}` };
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'web', address: u.toString() };
  } catch {
    /* not an address */
  }
  return undefined;
}

/**
 * Throwaway profiles left behind when Sara was stopped hard (a crash, a power cut): removed at
 * start once they are 6 hours old (a live one never gets that old: browsers close after a turn).
 */
export function sweepLeftovers(dir = tmpdir(), now = Date.now()): number {
  let n = 0;
  for (const name of leftoverProfiles(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs < 6 * 3600_000) continue;
      rmSync(p, { recursive: true, force: true, maxRetries: 2 });
      n++;
    } catch {
      /* in use or gone */
    }
  }
  return n;
}

/** For tests and the doctor: leftover throwaway profiles in the temp folder. */
export function leftoverProfiles(dir = tmpdir()): string[] {
  try {
    return readdirSync(dir).filter((n) => n.startsWith('sara-browser-'));
  } catch {
    return [];
  }
}
