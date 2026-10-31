// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §10.2): the reference hands device in
// TypeScript. It speaks the hands protocol (src/hands.ts) to a Sara server with a `hands` token and
// drives its own Chromium-family browser (its own profile, DevTools over a pipe, never a port), so
// the server's tests, evals and the conformance script (scripts/hands-conformance.ts) run without a
// desktop, and it is what the Linux hands become later (CU8). The Windows and Mac apps implement the
// same protocol and command set natively; all three run the one page agent
// (desktop/shared/page-agent.js) for reading pages.
//
// What it does on its own, whatever the server asks (§2, §4.1, §7.7):
// - only its own command set (CU1: look, read, navigate, pictures, logs; Phase 88 / CU2: find, click,
//   type, select, keys, scroll, upload, downloads); anything else is refused with `unsupported`;
// - Phase 88: never types into password fields or text shaped like a key or a Sara sign-in; only the
//   keys on the page agent's list; at most 4 actions a second and 120 a minute, 2,000 characters per
//   action; uploads only from its own Downloads/Sara folder; when the person takes over ("Pause Sara",
//   the default) nothing acts until they resume; a local log of what she did (no pictures);
// - only http(s) addresses; never the Sara server's own origin (except its /preview/<token>/ links),
//   chrome://, edge://, file://, devtools or extension pages, even when a page redirects there;
// - at most 20 tab opens a minute and one live-view picture per 500 ms;
// - password fields never give their value (the page agent), and text that looks like a secret is
//   masked in what goes back;
// - Phase 90 (CU4): saved logins stay here (a test vault: src/hands-logins.ts). b.login fills one only on
//   a page whose current origin is exactly a saved site, through DevTools input, and answers only
//   filled / not found / site doesn't match; b.saveLogin saves only what the consent window gave with
//   "I understand" ticked (the `consent` option stands in for the apps' native window); a sign-in the
//   person typed is caught in memory for "Use what I just typed" and never sent anywhere; b.yourTurn
//   hands the browser to the person until they press Continue.
// - Phase 91 (CU4b): the owner's password managers (src/hands-managers.ts): each off until turned on here
//   (setManager), unlocked only by the person in the manager's own prompt (the `managers.opts.prompt`
//   stand-in in tests), used only for the page's exact origin after this computer's saved logins, and
//   locked again on b.relock (after the task), after the idle minutes, on Stop, on disconnect and when turned off.
//
// - Phase 94 (CU7): check-ups on a fixture computer (src/hands-checkup.ts TestSystem): s.check reads only;
//   s.apply makes one change of the fixed kinds, for a target its own latest check found, after the
//   `checkupConsent` stand-in for the computer's card says yes (every time, at every level).
//
// Run by hand: node src/hands-ref.ts --server http://127.0.0.1:7881 --token-file <file> [--name X] [--visible] [--local-only]
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { findBrowser, pageAgentCall, type BrowserInfo } from './browser.ts';
import { CdpClient, type CdpEvent } from './cdp.ts';
import { HANDS_OPS, HANDS_PROTOCOL, packBinary, parseBinary } from './hands.ts';
import { DesktopConsent, type DesktopPrompt } from './hands-desktop-consent.ts';
import { CU5_OPS, CU6_OPS, DESKTOP_INPUT_OPS, TestDesktop } from './hands-desktop.ts';
import { applyAllowed, applyCardText, CheckupError, CU7_OPS, TestSystem } from './hands-checkup.ts';
import { CAUGHT_KEEP_MS, cleanLoginName, defaultLoginName, LoginError, loginOrigin, SAVE_LOGIN_WARNING, siteMatches, TestVault, type ConsentAnswer, type ConsentRequest } from './hands-logins.ts';
import { managerName, ManagerError, MANAGER_IDS, type ManagerId, type ManagerSessions } from './hands-managers.ts';
import { connectWebSocket, type WsConnection } from './ws.ts';

export const REF_VERSION = 'hands-ref 8';
/** Phase 89 (CU3): the device's own dev-tunnel limits (loopback only, whatever the server says). */
export const TUNNEL_DEVICE_LIMITS = { tunnels: 4, streams: 64, chunk: 64 * 1024, highWater: 4 * 1024 * 1024 };
/** Phase 92: the desktop ops are in the command set only with a (fixture) desktop to look at. */
const OPS = new Set<string>(HANDS_OPS.filter((o) => !(CU5_OPS as readonly string[]).includes(o) && !(CU6_OPS as readonly string[]).includes(o) && !(CU7_OPS as readonly string[]).includes(o)));
const DESKTOP_OP = new Set<string>([...CU5_OPS, ...CU6_OPS]);
const DESKTOP_INPUT = new Set<string>(DESKTOP_INPUT_OPS);
/** §7.7: the device's own input limits. */
export const INPUT_LIMITS = { perSecond: 4, perMinute: 120, chars: 2000 };
const INPUT_OPS = new Set(['b.click', 'b.type', 'b.select', 'b.keys', 'b.scroll', 'b.upload', 'b.login']);
/** Phase 90: ops that wait for the person (the consent window, "Your turn"): up to 10 minutes. */
const WAITING = new Set(['b.saveLogin', 'b.yourTurn', 'b.unlock']);
const BACKOFF_S = [1, 2, 5, 10, 30];
const MAX_LOGS = 500;
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/g, /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bxai-[A-Za-z0-9]{20,}/g, /\bsara_(?:dev|hands|m)\.[\w-]+\.[\w-]+/g, /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g];
export const maskSecrets = (s: string): string => SECRET_SHAPES.reduce((t, re) => t.replace(re, '[hidden]'), s);

class OpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Whether the Sara browser may load an address (the device's own rule, §4.1). */
export function addressAllowed(raw: string, serverOrigin: string): { ok: true; url: URL } | { ok: false; why: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, why: 'That is not a web address.' };
  }
  if (u.href === 'about:blank') return { ok: true, url: u };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: `The Sara browser doesn't open ${u.protocol} addresses.` };
  if (u.username || u.password) return { ok: false, why: 'Addresses with a user name or password are not opened.' };
  if (serverOrigin && u.origin === serverOrigin && !/^\/preview\/[0-9a-f]{32}(\/|$)/.test(u.pathname)) return { ok: false, why: "Sara's own server is never opened in the Sara browser." };
  return { ok: true, url: u };
}

// ---- DevTools over a pipe (--remote-debugging-pipe: the browser reads fd 3, writes fd 4, NUL-separated) ----
class PipeConnection implements WsConnection {
  onMessage?: (data: string | Buffer) => void;
  onClose?: (code: number) => void;
  #open = true;
  #buf = '';
  readonly #out: Writable;
  constructor(out: Writable, inp: Readable) {
    this.#out = out;
    inp.setEncoding('utf8');
    inp.on('data', (chunk: string) => {
      this.#buf += chunk;
      let i: number;
      while ((i = this.#buf.indexOf('\0')) >= 0) {
        const msg = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 1);
        this.onMessage?.(msg);
      }
    });
    const end = () => {
      if (!this.#open) return;
      this.#open = false;
      this.onClose?.(1006);
    };
    inp.on('end', end);
    inp.on('error', end);
    out.on('error', end);
  }
  get open(): boolean {
    return this.#open;
  }
  send(data: string | Buffer): void {
    if (this.#open) this.#out.write(`${String(data)}\0`);
  }
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#out.end();
    this.onClose?.(1000);
  }
}

interface Tab {
  id: string;
  targetId: string;
  sessionId: string;
  frameId: string;
  logs: Record<string, unknown>[];
  /** Phase 88: the last page dialog (alert/confirm), closed with Cancel. */
  dialog?: string;
  consoleErrors: number;
  failedRequests: number;
  status: number;
  methods: Map<string, { method: string; url: string }>;
}

/** The Sara browser on this computer: own profile, launched on first use, driven over a pipe. */
export class SaraBrowser {
  readonly info: BrowserInfo;
  readonly headless: boolean;
  readonly serverOrigin: string;
  #profile: string;
  readonly #tempProfile: boolean;
  #child?: ChildProcess;
  cdp?: CdpClient;
  readonly tabs = new Map<string, Tab>();
  #active = '';
  #tabN = 0;
  #seq = 0;
  readonly #opens: number[] = [];

  /** Phase 88: where downloads go and uploads come from (Downloads/Sara on a real computer). */
  readonly folder: string;
  readonly #tempFolder: boolean;

  /** Phase 90: a sign-in the person just typed (memory only, for "Use what I just typed"). */
  caught?: { origin: string; username: string; password: string; at: number };
  readonly #extraArgs: string[];

  constructor(opts: { info?: BrowserInfo; headless?: boolean; profileDir?: string; serverOrigin: string; folder?: string; extraArgs?: string[] }) {
    this.#extraArgs = opts.extraArgs ?? [];
    this.info = opts.info ?? findBrowser();
    this.#tempFolder = !opts.folder;
    this.folder = opts.folder ?? mkdtempSync(join(tmpdir(), 'sara-hands-files-'));
    mkdirSync(this.folder, { recursive: true });
    this.headless = opts.headless !== false;
    this.serverOrigin = opts.serverOrigin;
    this.#tempProfile = !opts.profileDir;
    this.#profile = opts.profileDir ?? mkdtempSync(join(tmpdir(), 'sara-hands-'));
  }

  get running(): boolean {
    return Boolean(this.cdp && !this.cdp.closed);
  }

  args(): string[] {
    return [
      ...(this.headless ? ['--headless=new'] : []),
      `--user-data-dir=${this.#profile}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-breakpad',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain',
      // Never the browser account: no implicit sign-in to the computer's Microsoft/Google account, no sync.
      '--disable-features=Translate,MediaRouter,OptimizationHints,msEdgeSync,msImplicitSignin,msSignInFRE,EdgeCollections,msShopping,msEdgeShoppingUI',
      '--window-size=1280,800',
      ...this.#extraArgs,
      ...(this.headless && this.info.kind === 'edge' ? ['--inprivate'] : []),
      // Edge's launcher may start a second copy of itself and exit (its "compat layer" relaunch),
      // which would drop the DevTools pipe: ask it not to.
      ...(this.info.kind === 'edge' ? ['--edge-skip-compat-layer-relaunch'] : []),
      'about:blank',
    ];
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.info.found || !this.info.path) throw new OpError('perm_missing', `No Chromium-family browser on this computer. ${this.info.how}`);
    const child = spawn(this.info.path, this.args(), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: this.headless });
    this.#child = child;
    child.on('error', () => {});
    const conn = new PipeConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    this.cdp = new CdpClient(conn);
    this.cdp.on((ev) => this.#event(ev));
    // The first page may take a moment to appear.
    let pages: { targetId: string; type: string; url: string }[] = [];
    for (let i = 0; i < 40 && !pages.length; i++) {
      const r = (await this.cdp.send('Target.getTargets', {}, undefined, 10_000)) as { targetInfos: { targetId: string; type: string; url: string }[] };
      pages = r.targetInfos.filter((t) => t.type === 'page');
      if (!pages.length) await new Promise((r2) => setTimeout(r2, 150));
    }
    for (const p of pages) await this.#attach(p.targetId);
    if (!this.tabs.size) await this.newTab();
    // Downloads land in the Sara folder (never anywhere else).
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.folder }).catch(() => {});
  }

  async #attach(targetId: string): Promise<Tab> {
    const cdp = this.cdp!;
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    const tab: Tab = { id: `t${++this.#tabN}`, targetId, sessionId, frameId: '', logs: [], consoleErrors: 0, failedRequests: 0, status: 0, methods: new Map() };
    this.tabs.set(tab.id, tab);
    for (const d of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await cdp.send(d, {}, sessionId);
    // §4.1: the server's own origin is refused even when a page sends the browser there.
    if (this.serverOrigin) await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${this.serverOrigin}/*` }] }, sessionId);
    // Phase 90: "Use what I just typed": the page agent's catcher in its own world, reporting to a
    // binding only that world has (DevTools on the pipe: it never reaches the hands channel).
    await cdp.send('Runtime.addBinding', { name: 'saraLoginCaught', executionContextName: 'sara-login-catch' }, sessionId).catch(() => {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageAgentCall('catchLogins', {}), worldName: 'sara-login-catch', runImmediately: true }, sessionId).catch(() => {});
    const tree = (await cdp.send('Page.getFrameTree', {}, sessionId)) as { frameTree: { frame: { id: string } } };
    tab.frameId = tree.frameTree.frame.id;
    this.#active = tab.id;
    return tab;
  }

  async newTab(): Promise<Tab> {
    const { targetId } = (await this.cdp!.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    return this.#attach(targetId);
  }

  tab(id?: unknown): Tab {
    const want = String(id ?? '');
    // The current tab, or (after it was closed) the newest one left.
    const t = this.tabs.get(want || this.#active) ?? (want ? undefined : [...this.tabs.values()].at(-1));
    if (!t) throw new OpError('not_found', id ? `No tab ${String(id)} (pc_browser_tabs lists them).` : 'No tab is open.');
    return t;
  }

  activate(t: Tab): void {
    this.#active = t.id;
  }

  /** §7.7: at most 20 tab opens or page loads a minute. */
  countOpen(): void {
    const now = Date.now();
    while (this.#opens.length && now - this.#opens[0] > 60_000) this.#opens.shift();
    if (this.#opens.length >= 20) throw new OpError('rate_limited', 'At most 20 pages a minute in the Sara browser.');
    this.#opens.push(now);
  }

  #tabOf(sessionId?: string): Tab | undefined {
    for (const t of this.tabs.values()) if (t.sessionId === sessionId) return t;
    return undefined;
  }

  #log(t: Tab, e: Record<string, unknown>): void {
    t.logs.push({ seq: ++this.#seq, at: new Date().toISOString(), ...e });
    if (t.logs.length > MAX_LOGS) t.logs.splice(0, t.logs.length - MAX_LOGS);
  }

  #event(ev: CdpEvent): void {
    if (ev.method === 'Target.detachedFromTarget') {
      for (const [id, t] of this.tabs) if (t.sessionId === ev.params.sessionId) this.tabs.delete(id);
      return;
    }
    const t = this.#tabOf(ev.sessionId);
    if (!t) return;
    const p = ev.params;
    const short = (s: unknown) => maskSecrets(String(s ?? '')).replace(/\s+/g, ' ').slice(0, 500);
    switch (ev.method) {
      case 'Runtime.bindingCalled': {
        // Phase 90: a sign-in the person typed in the Sara browser (kept here, in memory, 10 minutes).
        if (p.name !== 'saraLoginCaught') return;
        try {
          const c = JSON.parse(String(p.payload ?? '')) as { origin?: unknown; username?: unknown; password?: unknown };
          const origin = loginOrigin(String(c.origin ?? ''));
          if (origin && typeof c.password === 'string' && c.password) this.caught = { origin, username: String(c.username ?? '').slice(0, 200), password: c.password.slice(0, 500), at: Date.now() };
        } catch {
          /* not ours */
        }
        return;
      }
      case 'Fetch.requestPaused': {
        const url = String((p.request as { url?: string })?.url ?? '');
        const ok = addressAllowed(url, this.serverOrigin).ok;
        void this.cdp!.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }, t.sessionId).catch(() => {});
        if (!ok) this.#log(t, { kind: 'network', method: 'GET', url: short(url), error: 'blocked by the Sara browser (Sara\u2019s own server)', type: String((p as { resourceType?: string }).resourceType ?? '') });
        return;
      }
      case 'Page.javascriptDialogOpening': {
        // A page dialog would block everything: it is closed with Cancel (the safe answer) and reported.
        t.dialog = short(p.message);
        void this.cdp!.send('Page.handleJavaScriptDialog', { accept: false }, t.sessionId).catch(() => {});
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const type = String(p.type);
        if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
        const args = (p.args as { value?: unknown; description?: string }[]) ?? [];
        const frame = ((p.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] })?.callFrames ?? [])[0];
        if (type !== 'warning') t.consoleErrors++;
        this.#log(t, { kind: 'console', level: type === 'warning' ? 'warning' : 'error', text: short(args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ')), ...(frame?.url ? { url: short(frame.url), line: Number(frame.lineNumber ?? 0) + 1 } : {}) });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as { text?: string; url?: string; lineNumber?: number; exception?: { description?: string } } | undefined;
        t.consoleErrors++;
        this.#log(t, { kind: 'exception', text: short(d?.exception?.description?.split('\n')[0] ?? d?.text ?? 'error'), ...(d?.url ? { url: short(d.url), line: Number(d.lineNumber ?? 0) + 1 } : {}) });
        return;
      }
      case 'Log.entryAdded': {
        const e = p.entry as { level?: string; text?: string; url?: string; source?: string } | undefined;
        if (!e || (e.level !== 'error' && e.level !== 'warning') || /\/favicon\.ico$/.test(e.url ?? '')) return;
        // Failed requests are reported once, from the network events.
        if (e.source === 'network') return;
        if (e.level === 'error') t.consoleErrors++;
        this.#log(t, { kind: 'console', level: e.level, text: short(e.text), ...(e.url ? { url: short(e.url) } : {}) });
        return;
      }
      case 'Network.requestWillBeSent': {
        const rq = p.request as { method?: string; url?: string } | undefined;
        t.methods.set(String(p.requestId), { method: String(rq?.method ?? 'GET'), url: short(rq?.url) });
        if (t.methods.size > 2000) t.methods.delete(t.methods.keys().next().value!);
        return;
      }
      case 'Network.responseReceived': {
        const r = p.response as { status?: number; url?: string } | undefined;
        const status = Number(r?.status ?? 0);
        if (p.type === 'Document' && p.frameId === t.frameId) t.status = status;
        if (status >= 400 && !/\/favicon\.ico$/.test(r?.url ?? '')) {
          t.failedRequests++;
          this.#log(t, { kind: 'network', method: t.methods.get(String(p.requestId))?.method ?? 'GET', url: short(r?.url), status, type: String(p.type ?? ''), requestId: String(p.requestId) });
        }
        return;
      }
      case 'Network.loadingFailed': {
        if (p.canceled || p.blockedReason === 'inspector') return;
        t.failedRequests++;
        const was = t.methods.get(String(p.requestId));
        this.#log(t, { kind: 'network', method: was?.method ?? 'GET', url: was?.url ?? '', error: short(p.errorText), type: String(p.type ?? ''), requestId: String(p.requestId) });
        return;
      }
    }
  }

  /** Runs one page-agent function in an isolated world (the page's own scripts can't touch it). */
  async agent<T>(t: Tab, fn: string, args: Record<string, unknown>): Promise<T> {
    const tree = (await this.cdp!.send('Page.getFrameTree', {}, t.sessionId)) as { frameTree: { frame: { id: string } } };
    t.frameId = tree.frameTree.frame.id;
    const w = (await this.cdp!.send('Page.createIsolatedWorld', { frameId: t.frameId, worldName: 'sara-page-agent' }, t.sessionId)) as { executionContextId: number };
    const r = (await this.cdp!.send('Runtime.evaluate', { expression: pageAgentCall(fn, args), contextId: w.executionContextId, returnByValue: true }, t.sessionId)) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new OpError('error', `The page couldn't be read: ${r.exceptionDetails.text ?? 'script error'}`);
    return r.result?.value as T;
  }

  /** Phase 88: a page-agent function that returns an element (for DOM.setFileInputFiles): its object id, or ''. */
  async agentNode(t: Tab, fn: string, args: Record<string, unknown>): Promise<string> {
    const w = (await this.cdp!.send('Page.createIsolatedWorld', { frameId: t.frameId, worldName: 'sara-page-agent' }, t.sessionId)) as { executionContextId: number };
    const r = (await this.cdp!.send('Runtime.evaluate', { expression: pageAgentCall(fn, args), contextId: w.executionContextId, returnByValue: false }, t.sessionId)) as { result?: { objectId?: string; subtype?: string } };
    return r.result?.subtype === 'node' && r.result.objectId ? r.result.objectId : '';
  }

  /** Phase 88: a real left click at a page point (mouse moved, pressed, released). */
  async click(t: Tab, x: number, y: number): Promise<void> {
    await this.cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, t.sessionId);
    await this.cdp!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, t.sessionId);
    await this.cdp!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, t.sessionId);
  }

  /** Phase 88: after an action, waits for a page load it started (if any). */
  async settle(t: Tab): Promise<void> {
    const started = await this.cdp!.waitFor((ev) => ev.sessionId === t.sessionId && (ev.method === 'Page.frameStartedLoading' || ev.method === 'Page.frameRequestedNavigation'), 500).then((ev) => Boolean(ev), () => false);
    if (started) await this.cdp!.waitFor((ev) => ev.sessionId === t.sessionId && ev.method === 'Page.loadEventFired', 15_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }

  async info2(t: Tab): Promise<{ url: string; title: string }> {
    const r = (await this.cdp!.send('Target.getTargetInfo', { targetId: t.targetId })) as { targetInfo: { url: string; title: string } };
    return { url: r.targetInfo.url, title: maskSecrets(r.targetInfo.title) };
  }

  /** A JPEG of the visible page, scaled to at most `maxWidth` pixels wide. */
  async shot(t: Tab, maxWidth: number, quality: number): Promise<{ data: Buffer; w: number; h: number }> {
    const m = (await this.cdp!.send('Page.getLayoutMetrics', {}, t.sessionId)) as { cssVisualViewport?: { clientWidth: number; clientHeight: number } };
    const vw = Math.max(1, Math.round(m.cssVisualViewport?.clientWidth ?? 1280));
    const vh = Math.max(1, Math.round(m.cssVisualViewport?.clientHeight ?? 800));
    const scale = Math.min(1, maxWidth / vw);
    const r = (await this.cdp!.send('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: 0, y: 0, width: vw, height: vh, scale } }, t.sessionId, 30_000)) as { data: string };
    return { data: Buffer.from(r.data, 'base64'), w: Math.round(vw * scale), h: Math.round(vh * scale) };
  }

  async waitLoad(t: Tab, start: () => Promise<unknown>, ms = 30_000): Promise<void> {
    const loaded = this.cdp!.waitFor((ev) => ev.sessionId === t.sessionId && ev.method === 'Page.loadEventFired', ms);
    await start();
    await loaded;
    await new Promise((r) => setTimeout(r, 250));
  }

  nextSeq(): number {
    return this.#seq;
  }

  async close(): Promise<void> {
    try {
      await this.cdp?.send('Browser.close', {}, undefined, 3000);
    } catch {
      /* gone */
    }
    this.cdp?.close();
    const child = this.#child;
    if (child?.pid && child.exitCode === null) {
      await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    this.tabs.clear();
    if (this.#tempProfile) setTimeout(() => rmSync(this.#profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 800).unref();
    if (this.#tempFolder) rmSync(this.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface HandsRefOptions {
  /** The Sara server, e.g. http://127.0.0.1:7881. */
  server: string;
  token: string;
  name?: string;
  info?: BrowserInfo;
  headless?: boolean;
  profileDir?: string;
  localOnly?: boolean;
  optIn?: { browser: boolean; desktop?: boolean };
  /** Phase 92: a desktop to look at (the fixture desktop: known windows, a fixture KeePass, Sara's own window). */
  desktop?: TestDesktop;
  /** Phase 88/93: "When you move the mouse": pause Sara (default) or let her keep control. */
  takeover?: 'pause' | 'keep';
  /** Phase 88: Downloads/Sara (a temporary folder when not given). */
  folder?: string;
  /** Phase 88: "What Sara did on this computer": one JSON line per action (no pictures), kept 30 days. */
  logFile?: string;
  /** Phase 88: a fresh token arrived over the connection (keep it instead of the old one). */
  onToken?: (token: string, expiresAt: string) => void;
  /** Phase 88: when the token ends (ISO); with under 30 days left it is renewed on connect. */
  renewBefore?: string;
  /** Tests: reconnect after a dropped connection (default true). */
  reconnect?: boolean;
  /** Phase 90: the saved logins on this "computer" (a fresh empty test vault when not given). */
  vault?: TestVault;
  /** Phase 90: the consent window (the person's answer). Without it nothing can be saved. */
  consent?: (req: ConsentRequest) => Promise<ConsentAnswer>;
  /** Phase 90: "Ask for Windows Hello / Touch ID before Sara uses a saved login" (off by default) and its answer. */
  verify?: { on: boolean; ask: () => Promise<boolean> };
  /** Phase 91: the owner's password managers on this "computer" (none when not given). */
  managers?: ManagerSessions;
  /** Tests: extra browser switches (e.g. host-resolver rules for look-alike sites). */
  browserArgs?: string[];
  /** Phase 93: whether desktop input is answered by the local computer approval surface. */
  approvalsHere?: boolean;
  desktopLevel?: 'ask' | 'task' | 'always';
  desktopConsent?: (p: DesktopPrompt) => Promise<'once' | 'task' | 'deny'>;
  /** Phase 93: keep the computer awake while a task is active. */
  walkAway?: boolean;
  /** Phase 94: a fixture computer for check-ups (s.check / s.apply; needs the desktop switch too). */
  system?: TestSystem;
  /** Phase 94: the computer's card for one check-up change (true = Allow once). Without it nothing changes. */
  checkupConsent?: (p: { kind: string; target: string; what: string; text: string }) => Promise<boolean>;
  /** Tests: keep every frame of the hands channel in `wire`. */
  recordWire?: boolean;
  log?: (line: string) => void;
}

/** The reference hands device: connects, says hello, runs ops, reconnects. */
export class HandsRef {
  readonly opts: HandsRefOptions;
  readonly browser: SaraBrowser;
  ws?: WsConnection;
  #stopped = false;
  #attempt = 0;
  #timer?: NodeJS.Timeout;
  readonly desktopConsent = new DesktopConsent();
  #desktopQueue: Promise<unknown> = Promise.resolve();
  readonly #answers = new Map<string, string>();
  readonly #running = new Map<string, AbortController>();
  readonly #lastFrameAt = { at: 0, hash: '' };
  #frameN = 0;
  /** Every op the server asked for (tests read it). */
  readonly seen: string[] = [];
  connects = 0;
  /** Phase 88: paused because the person took over (until they resume). */
  paused = false;
  /** Phase 88: what the device's "Sara is working" badge shows now ('' = hidden). */
  badge = '';
  readonly #inputs: number[] = [];
  /** Phase 90: the saved logins here. */
  readonly vault: TestVault;
  /** Phase 90: "Your turn" is showing (the person is signing in); continueTurn() ends it. */
  yourTurn = '';
  #turnDone?: () => void;
  /** With recordWire: every frame this device sent and got (tests grep it for the test password). */
  readonly wire: string[] = [];
  /** Phase 89: the dev tunnels open here (a loopback listener each) and their streams. */
  readonly #tunnels = new Map<string, { server: NetServer; port: number; localPort: number; sids: Set<number> }>();
  readonly #streams = new Map<number, { socket: Socket; tunnel: string; closed: boolean }>();
  #sid = 0;

  constructor(opts: HandsRefOptions) {
    this.opts = opts;
    if (opts.desktop) opts.desktop.ownOrigin = new URL(opts.server).origin;
    this.desktopConsent.level = opts.desktopLevel ?? 'task';
    if (opts.desktop) { const url = new URL(opts.server); opts.desktop.transportSecure = url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
    this.browser = new SaraBrowser({ ...(opts.info ? { info: opts.info } : {}), headless: opts.headless !== false, ...(opts.profileDir ? { profileDir: opts.profileDir } : {}), ...(opts.folder ? { folder: opts.folder } : {}), ...(opts.browserArgs ? { extraArgs: opts.browserArgs } : {}), serverOrigin: new URL(opts.server).origin });
    this.vault = opts.vault ?? new TestVault();
    if (opts.logFile && existsSync(opts.logFile)) {
      // Keep 30 days of the local log.
      const cut = Date.now() - 30 * 86_400_000;
      const keep = readFileSync(opts.logFile, 'utf8').split('\n').filter((l) => {
        try {
          return Date.parse(String((JSON.parse(l) as { at?: string }).at)) >= cut;
        } catch {
          return false;
        }
      });
      writeFileSync(opts.logFile, keep.length ? `${keep.join('\n')}\n` : '');
    }
  }

  get connected(): boolean {
    return Boolean(this.ws?.open);
  }

  async start(): Promise<void> {
    this.#stopped = false;
    // Phase 91: which managers are installed (each CLI's --version, nothing else) before the hello.
    const pm = this.opts.managers;
    if (pm && !pm.detected) await pm.detect();
    if (pm) {
      const before = pm.opts.onChange;
      pm.opts.onChange = () => {
        before?.();
        this.tellManagers();
      };
    }
    await this.#connect();
  }

  /** Phase 91: a manager was locked, unlocked, turned on or off here: the server hears names and states. */
  tellManagers(): void {
    const pm = this.opts.managers;
    if (pm) this.#send(JSON.stringify({ t: 'ev', kind: 'managers', managers: pm.views(), relockMinutes: Math.max(1, Math.round(pm.relockMs / 60_000)) }));
  }

  /** Phase 91: the person turns a manager on or off in the app (after the warning). Off forgets its session. */
  async setManager(id: ManagerId, on: boolean): Promise<void> {
    await this.opts.managers?.setOn(id, on);
  }

  async #connect(): Promise<void> {
    const u = new URL('/api/hands', this.opts.server);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const ws = await connectWebSocket(u.toString(), { headers: { Authorization: `Bearer ${this.opts.token}` }, timeoutMs: 10_000 });
      this.ws = ws;
      this.connects++;
      this.#attempt = 0;
      // Tests: everything that crosses the hands channel, both ways (the password must never be in it).
      const rawSend = ws.send.bind(ws);
      ws.send = (data: string | Buffer) => {
        this.#record('>', data);
        rawSend(data);
      };
      ws.onMessage = (d) => {
        this.#record('<', d);
        if (typeof d === 'string') void this.#message(ws, d);
        else this.#streamData(ws, d);
      };
      // Phase 88: a token with less than 30 days left is renewed over this connection.
      if (this.opts.renewBefore && Date.parse(this.opts.renewBefore) - Date.now() < 30 * 86_400_000) ws.send(JSON.stringify({ t: 'renew' }));
      ws.onClose = () => {
        this.desktopConsent.clear();
        this.opts.desktop?.endTask();
        if (this.ws === ws) this.ws = undefined;
        for (const ac of this.#running.values()) ac.abort();
        // Phase 91: the managers lock again with the connection.
        void this.opts.managers?.lockAll('disconnected');
        // Phase 89: every dev tunnel closes with the connection.
        this.closeTunnels();
        this.#later();
      };
      this.#send(JSON.stringify(this.hello()));
      this.opts.log?.(`connected to ${this.opts.server}`);
    } catch (err) {
      this.opts.log?.(`couldn't connect: ${(err as Error).message}`);
      this.#later();
      if (this.#attempt === 1) throw err;
    }
  }

  #later(): void {
    if (this.#stopped || this.opts.reconnect === false) return;
    const s = BACKOFF_S[Math.min(this.#attempt++, BACKOFF_S.length - 1)];
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#connect().catch(() => {}), s * 1000);
    this.#timer.unref?.();
  }

  hello(): Record<string, unknown> {
    return {
      t: 'hello',
      v: HANDS_PROTOCOL,
      app: REF_VERSION,
      os: `${process.platform} ${process.arch}`,
      computer: this.opts.name ?? hostname(),
      screens: this.opts.desktop ? [this.opts.desktop.screen] : [],
      browser: { found: this.browser.info.found, ...(this.browser.info.kind ? { kind: this.browser.info.kind } : {}), ...(this.browser.info.name ? { name: this.browser.info.name } : {}) },
      perms: { capture: Boolean(this.opts.desktop), input: Boolean(this.opts.desktop), ax: Boolean(this.opts.desktop) },
      optIn: { browser: this.opts.optIn?.browser !== false, desktop: this.#desktopOn },
      approvalsHere: Boolean(this.opts.desktopConsent) && this.opts.approvalsHere !== false,
      logins: this.vault.list(this.serverOrigin),
      vault: { kind: 'test', verify: this.opts.verify?.on === true },
      busy: false,
      localOnly: this.opts.localOnly === true,
      ops: [...OPS, ...(this.opts.desktop ? [...CU5_OPS, ...CU6_OPS] : []), ...(this.opts.system ? CU7_OPS : [])],
      takeover: this.opts.takeover ?? 'pause',
      hotkey: '',
      paused: this.paused,
      renew: true,
      walkAway: this.opts.walkAway === true,
      ...(this.opts.managers ? { managers: this.opts.managers.views(), relockMinutes: Math.max(1, Math.round(this.opts.managers.relockMs / 60_000)) } : {}),
    };
  }

  /** Phase 92: "The whole screen" (a second switch, off unless given). Phase 94: a check-up computer counts too. */
  get #desktopOn(): boolean {
    return Boolean(this.opts.desktop || this.opts.system) && this.opts.optIn?.desktop === true;
  }

  get serverOrigin(): string {
    return new URL(this.opts.server).origin;
  }

  /** Phase 90: Continue on "Your turn" (the person signed in, typed the code…). */
  continueTurn(): void {
    this.#turnDone?.();
  }

  /** Phase 90: a login was saved or removed here: the server hears the names and sites. */
  tellLogins(): void {
    this.#send(JSON.stringify({ t: 'ev', kind: 'logins', logins: this.vault.list(this.serverOrigin), vault: { kind: 'test', verify: this.opts.verify?.on === true } }));
  }

  #send(text: string): void {
    if (this.ws?.open) this.ws.send(text);
  }

  /** recordWire: every frame both ways is kept in `wire` (text as is, binary as latin1, 256 KB each). */
  #record(dir: '<' | '>', d: string | Buffer): void {
    if (!this.opts.recordWire) return;
    this.wire.push(typeof d === 'string' ? `${dir}${d}` : `${dir}[binary ${d.length}] ${d.subarray(0, 256 * 1024).toString('latin1')}`);
    if (this.wire.length > 20_000) this.wire.splice(0, this.wire.length - 20_000);
  }

  /** Phase 88: asks the server for a fresh token now (the apps do this when under 30 days are left). */
  renew(): void {
    this.ws?.send(JSON.stringify({ t: 'renew' }));
  }

  /**
   * Phase 88: the person moved the mouse or typed in the Sara browser window (the native apps tell
   * real input from hers with the OS; here tests call it). With "Pause Sara" nothing acts until resume().
   */
  userInput(): void {
    if ((this.opts.takeover ?? 'pause') !== 'keep') this.opts.desktop?.ownerInput();
    if ((this.opts.takeover ?? 'pause') === 'keep' || this.paused) return;
    this.paused = true;
    for (const [id, ac] of this.#running) if (this.#acting.has(id)) ac.abort(new OpError('takeover', 'Paused: the owner took over the Sara browser.'));
    this.badge = 'Paused: you\u2019re in control';
    this.ws?.send(JSON.stringify({ t: 'ev', kind: 'takeover' }));
  }

  /** Phase 88: Resume on the device's badge. */
  resume(): void {
    this.opts.desktop?.resume();
    if (!this.paused) return;
    this.opts.desktop?.resume();
    this.paused = false;
    this.badge = '';
    this.ws?.send(JSON.stringify({ t: 'ev', kind: 'resumed' }));
  }

  readonly #acting = new Set<string>();

  /** §7.7: the device's input rate limit. */
  #countInput(): void {
    const now = Date.now();
    while (this.#inputs.length && now - this.#inputs[0] > 60_000) this.#inputs.shift();
    const lastSecond = this.#inputs.filter((x) => now - x < 1000).length;
    if (lastSecond >= INPUT_LIMITS.perSecond || this.#inputs.length >= INPUT_LIMITS.perMinute) throw new OpError('rate_limited', `At most ${INPUT_LIMITS.perSecond} actions a second and ${INPUT_LIMITS.perMinute} a minute in the Sara browser.`);
    this.#inputs.push(now);
  }

  #localLog(op: string, what: string, target: string): void {
    if (!this.opts.logFile) return;
    try {
      appendFileSync(this.opts.logFile, `${JSON.stringify({ at: new Date().toISOString(), op, what: maskSecrets(what).slice(0, 160), target: maskSecrets(target).slice(0, 160) })}\n`);
    } catch {
      /* the log is best effort */
    }
  }

  /** Stop pressed on the computer: everything running is cancelled and the server is told. */
  pressStop(): void {
    this.opts.desktop?.stop();
    this.desktopConsent.clear();
    this.opts.desktop?.endTask();
    for (const ac of this.#running.values()) ac.abort();
    this.closeTunnels();
    // Phase 91: Stop locks the password managers again.
    void this.opts.managers?.lockAll('stopped');
    this.ws?.send(JSON.stringify({ t: 'ev', kind: 'stopped', by: 'user' }));
  }

  /** Tests: the connection drops (the device reconnects by itself). */
  dropConnection(): void {
    this.ws?.close(1001, 'test');
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.closeTunnels();
    this.desktopConsent.clear();
    this.opts.desktop?.endTask();
    await this.opts.managers?.lockAll('the app closed');
    this.ws?.close(1000, 'bye');
    await this.browser.close();
  }

  async #message(ws: WsConnection, raw: string): Promise<void> {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.t === 'token' && typeof m.token === 'string' && m.token.startsWith('sara_hands.')) {
      this.opts.token = m.token;
      this.opts.onToken?.(m.token, String(m.expiresAt ?? ''));
      return;
    }
    if (m.t === 's') return this.#streamControl(m);
    if (m.t === 'cancel') {
      if (m.all) {
        this.desktopConsent.clear();
        this.opts.desktop?.endTask();
        for (const ac of this.#running.values()) ac.abort();
        // Phase 91: Stop (from the chat or Settings) locks the password managers again too.
        void this.opts.managers?.lockAll('stopped');
      } else this.#running.get(String(m.id))?.abort();
      return;
    }
    if (m.t !== 'req') return;
    const id = String(m.id ?? '');
    if (!id) return;
    // Idempotent by id: a retried request gets the first answer.
    const done = this.#answers.get(id);
    if (done) return ws.send(done);
    if (this.#running.has(id)) return;
    const op = String(m.op ?? '');
    this.seen.push(op);
    const ac = new AbortController();
    this.#running.set(id, ac);
    if (INPUT_OPS.has(op) || DESKTOP_INPUT.has(op)) this.#acting.add(id);
    const what = typeof m.what === 'string' ? m.what.slice(0, 120) : '';
    if (what && op !== 'c.ping') this.badge = this.paused ? this.badge : `Sara is working: ${what}`;
    const deadline = Math.min(Math.max(1000, Number(m.deadlineMs) || 30_000), WAITING.has(op) ? 600_000 : 120_000);
    const timer = setTimeout(() => ac.abort(new OpError('timeout', `Took longer than ${Math.round(deadline / 1000)} s.`)), deadline);
    let reply: Record<string, unknown>;
    try {
      if (!OPS.has(op) && !(DESKTOP_OP.has(op) && this.opts.desktop) && !((CU7_OPS as readonly string[]).includes(op) && this.opts.system)) throw new OpError('unsupported', `This computer doesn't do "${op.slice(0, 40)}" (not in its command set).`);
      if ((op.startsWith('b.') || op === 'c.tunnel') && this.opts.optIn?.browser === false) throw new OpError('denied_local', '"Let Sara use this computer" is off here.');
      // Phase 92: the whole screen only with its own switch on here.
      if ((op.startsWith('d.') || op.startsWith('s.')) && !this.#desktopOn) throw new OpError('denied_local', '"The whole screen" is off on this computer.');
      if (INPUT_OPS.has(op) || DESKTOP_INPUT.has(op) || op === 's.apply') {
        if (this.paused) throw new OpError('takeover', 'Paused: the owner took over the Sara browser. Nothing acts until they press Resume.');
        this.#countInput();
      }
      const args = (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>;
        const result = await Promise.race([
        this.#run(ws, id, op, args, what),
        new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(ac.signal.reason instanceof OpError ? ac.signal.reason : new OpError('stopped', 'Stopped.')), { once: true })),
      ]);
      reply = { t: 'res', id, ok: true, result };
    } catch (err) {
      const e = err instanceof OpError ? err : new OpError('error', (err as Error).message);
      reply = { t: 'res', id, ok: false, error: { code: e.code, message: maskSecrets(e.message).slice(0, 500) } };
    } finally {
      clearTimeout(timer);
      this.#running.delete(id);
      this.#acting.delete(id);
    }
    const text = JSON.stringify(reply);
    this.#answers.set(id, text);
    if (this.#answers.size > 100) this.#answers.delete(this.#answers.keys().next().value!);
    if (ws.open) ws.send(text);
  }

  #image(ws: WsConnection, header: Record<string, unknown>, data: Buffer): void {
    if (ws.open) ws.send(packBinary(header, data));
  }

  /** §3.5: a live-view frame after a change (at most one per 500 ms, only when the picture changed). */
  async #frame(ws: WsConnection, tab: Tab): Promise<void> {
    if (Date.now() - this.#lastFrameAt.at < 500) return;
    try {
      const s = await this.browser.shot(tab, 960, 60);
      const hash = createHash('sha1').update(s.data).digest('hex');
      if (hash === this.#lastFrameAt.hash) return;
      this.#lastFrameAt.at = Date.now();
      this.#lastFrameAt.hash = hash;
      this.#image(ws, { frame: ++this.#frameN, mime: 'image/jpeg', w: s.w, h: s.h }, s.data);
    } catch {
      /* a frame is best effort */
    }
  }

  async #thumb(ws: WsConnection, id: string, tab: Tab, args: Record<string, unknown>): Promise<void> {
    const w = Number(args.thumb);
    if (!(w >= 64 && w <= 640)) return;
    try {
      const s = await this.browser.shot(tab, w, 55);
      this.#image(ws, { id, kind: 'thumb', mime: 'image/jpeg', w: s.w, h: s.h }, s.data);
    } catch {
      /* best effort */
    }
  }

  /** Phase 88: one acting op: target, highlight, act, then the after-state (§6.3). */
  async #act(ws: WsConnection, id: string, op: string, a: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    const b = this.browser;
    const t = b.tab(a.tab);
    b.activate(t);
    const before = { errors: t.consoleErrors, failed: t.failedRequests, url: (await b.info2(t)).url };
    t.dialog = undefined;
    const tgtArgs: Record<string, unknown> = {};
    for (const k of ['ref', 'expect', 'text', 'field', 'x', 'y', 'w', 'h']) if (a[k] !== undefined) tgtArgs[k] = a[k];
    let target: Record<string, unknown> = {};
    const need = async () => {
      const r = await b.agent<Record<string, unknown>>(t, 'target', tgtArgs);
      if (r.found !== true) throw new OpError(r.stale ? 'stale_view' : 'not_found', String(r.error ?? 'That is not on the page.'));
      if (r.disabled) throw new OpError('not_found', `${String(r.desc)} is disabled.`);
      if (r.covered) throw new OpError('not_found', `${String(r.desc)} is covered by ${String(r.covered)}: close that first.`);
      await b.agent(t, 'mark', { x: r.x, y: r.y, box: r.box, label: 'Sara' }).catch(() => {});
      return r;
    };
    let extra: Record<string, unknown> = {};
    switch (op) {
      case 'b.click': {
        target = await need();
        await b.click(t, Number(target.x), Number(target.y));
        break;
      }
      case 'b.type': {
        const value = String(a.value ?? '');
        if (value.length > INPUT_LIMITS.chars) throw new OpError('denied_local', `At most ${INPUT_LIMITS.chars} characters per action.`);
        if (maskSecrets(value) !== value) throw new OpError('denied_local', 'That text looks like a key or a sign-in token: Sara never types those.');
        target = await need();
        if (target.secret) throw new OpError('denied_local', 'That is a password field: Sara never types into those.');
        if (!target.editable) throw new OpError('not_found', `${String(target.desc)} is not a text field.`);
        await b.click(t, Number(target.x), Number(target.y));
        const f = await b.agent<Record<string, unknown>>(t, 'focusFor', { ...tgtArgs, clear: a.clear !== false });
        if (f.error || !f.focused) throw new OpError(f.secret ? 'denied_local' : 'not_found', String(f.error ?? 'That field could not be focused.'));
        if (value) await b.cdp!.send('Input.insertText', { text: value }, t.sessionId);
        if (a.submit === true) await this.#keys(t, 'Enter');
        break;
      }
      case 'b.select': {
        const r = await b.agent<Record<string, unknown>>(t, 'choose', { ...tgtArgs, option: String(a.option ?? '') });
        if (r.error) throw new OpError(r.stale ? 'stale_view' : 'not_found', String(r.error));
        await b.agent(t, 'mark', { x: r.x, y: r.y, label: 'Sara' }).catch(() => {});
        target = { desc: r.desc };
        extra = { selected: r.selected };
        break;
      }
      case 'b.keys': {
        await this.#keys(t, String(a.combo ?? ''));
        extra = { combo: String(a.combo ?? '') };
        break;
      }
      case 'b.upload': {
        const folder = b.folder;
        let name: string;
        if (a.file && typeof a.file === 'object') {
          const f = a.file as { name?: unknown; data?: unknown };
          name = basename(String(f.name ?? '')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120);
          const data = Buffer.from(String(f.data ?? ''), 'base64');
          if (!name || data.length > 2 * 1024 * 1024) throw new OpError('denied_local', 'Uploads from the server are at most 2 MB.');
          writeFileSync(join(folder, name), data);
        } else {
          name = String(a.name ?? '');
          if (!name || name !== basename(name) || name.startsWith('.')) throw new OpError('denied_local', 'Only a file name in Downloads/Sara.');
        }
        const path = join(folder, name);
        if (!existsSync(path) || !statSync(path).isFile()) throw new OpError('not_found', `There is no ${name} in Downloads/Sara on this computer.`);
        target = await need();
        const objectId = await b.agentNode(t, 'fileInput', tgtArgs);
        if (!objectId) throw new OpError('not_found', 'That is not a file upload field.');
        await b.cdp!.send('DOM.setFileInputFiles', { files: [path], objectId }, t.sessionId);
        extra = { name };
        break;
      }
    }
    await b.settle(t);
    const st = await b.agent<Record<string, unknown>>(t, 'state', {}).catch(() => ({}) as Record<string, unknown>);
    this.#localLog(op, what, String(target.desc ?? extra.combo ?? ''));
    await this.#thumb(ws, id, t, a);
    void this.#frame(ws, t);
    return { tab: t.id, target: { desc: target.desc, role: target.role, name: target.name }, state: st, navigated: String(st.url ?? before.url) !== before.url, newErrors: t.consoleErrors - before.errors, newFailed: t.failedRequests - before.failed, ...(t.dialog ? { dialog: t.dialog } : {}), consoleErrors: t.consoleErrors, failedRequests: t.failedRequests, ...extra };
  }

  /**
   * Phase 90: b.login. Only on a page whose CURRENT origin exactly equals a saved site; the username and
   * password go into the page through DevTools input on this computer. Answers filled / not found /
   * site doesn't match, nothing else about the login.
   * Phase 91: with `managers: true` the login for the page's exact origin comes from this computer's saved
   * logins first, then the password managers that are on (in order); a manager that is on but locked
   * answers `locked` (with the managers' ids) so the server asks the person to unlock it (b.unlock).
   */
  async #login(ws: WsConnection, id: string, a: Record<string, unknown>, server: string): Promise<Record<string, unknown>> {
    const b = this.browser;
    const t = b.tab(a.tab);
    b.activate(t);
    const url = (await b.info2(t)).url;
    const origin = loginOrigin(url);
    let fill: { username: string; password: string } | undefined;
    let source = 'saved';
    let savedName = '';
    const pm = a.managers === true ? this.opts.managers : undefined;
    if (!pm) {
      const login = this.vault.find(server, String(a.name ?? ''));
      if (!login) return { outcome: 'not_found', missing: 'login', tab: t.id };
      if (!siteMatches(login, url)) return { outcome: 'site_mismatch', tab: t.id };
      fill = { username: login.username, password: login.password };
      savedName = login.name;
    } else {
      let login = this.vault.find(server, String(a.name ?? ''));
      if (login && !siteMatches(login, url)) login = undefined;
      login ??= this.vault.findBySite(server, url);
      if (login) {
        fill = { username: login.username, password: login.password };
        savedName = login.name;
      } else {
        const r = await pm.lookup(url, cleanLoginName(a.name));
        if (!r.entry) return r.locked.length ? { outcome: 'locked', managers: r.locked, site: origin, tab: t.id } : { outcome: 'not_found', missing: 'login', tab: t.id };
        fill = { username: r.entry.username, password: r.entry.password };
        source = r.source!;
        r.entry.password = '';
      }
    }
    try {
      if (this.opts.verify?.on && !(await this.opts.verify.ask())) throw new OpError('denied_local', 'Nothing was filled: the person at the computer didn\u2019t confirm it was them (Windows Hello / Touch ID).');
      const f = await b.agent<{ origin?: string; pass?: { x: number; y: number; box: unknown } | null; user?: { x: number; y: number; box: unknown } | null }>(t, 'loginFields', {});
      // The page itself must say the same origin (its main frame, right now).
      if (loginOrigin(String(f.origin ?? '')) !== origin) return { outcome: 'site_mismatch', tab: t.id };
      if (!f.pass) return { outcome: 'not_found', missing: 'fields', tab: t.id };
      const label = 'Sara';
      try {
        if (f.user && fill.username) {
          await b.agent(t, 'mark', { x: f.user.x, y: f.user.y, box: f.user.box, label }).catch(() => {});
          await b.click(t, f.user.x, f.user.y);
          const fu = await b.agent<{ focused?: boolean; origin?: string }>(t, 'focusLogin', { which: 'user' });
          if (!fu.focused || loginOrigin(String(fu.origin ?? '')) !== origin) return { outcome: 'site_mismatch', tab: t.id };
          await b.cdp!.send('Input.insertText', { text: fill.username }, t.sessionId);
        }
        await b.agent(t, 'mark', { x: f.pass.x, y: f.pass.y, box: f.pass.box, label }).catch(() => {});
        await b.click(t, f.pass.x, f.pass.y);
        const fp = await b.agent<{ focused?: boolean; origin?: string; secret?: boolean }>(t, 'focusLogin', { which: 'pass' });
        if (!fp.focused || !fp.secret) return { outcome: 'not_found', missing: 'fields', tab: t.id };
        if (loginOrigin(String(fp.origin ?? '')) !== origin) return { outcome: 'site_mismatch', tab: t.id };
        await b.cdp!.send('Input.insertText', { text: fill.password }, t.sessionId);
        if (a.submit !== false) await this.#keys(t, 'Enter');
        await b.settle(t);
      } finally {
        // The catcher saw her own fill: that is not something the person typed.
        b.caught = undefined;
      }
    } finally {
      fill.password = '';
      fill.username = '';
    }
    if (source === 'saved') {
      this.vault.touch(server, savedName);
      this.#localLog('b.login', `signed in with the saved login \u201c${savedName}\u201d`, origin);
    } else this.#localLog('b.login', `signed in with ${managerName(source)}`, origin);
    await this.#thumb(ws, id, t, a);
    void this.#frame(ws, t);
    return { outcome: 'filled', tab: t.id, submitted: a.submit !== false, source };
  }

  /**
   * Phase 91: b.unlock. The person unlocks the manager in its OWN prompt (a window of its own; here the
   * `prompt` stand-in). Sara never sees the master password; she keeps only the manager's session, in memory.
   */
  async #unlock(id: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pm = this.opts.managers;
    if (!pm) throw new OpError('unsupported', 'No password manager is turned on for Sara on this computer.');
    const asked = Array.isArray(a.managers) ? (a.managers as unknown[]).map(String) : [];
    const which = MANAGER_IDS.filter((m) => pm.isOn(m) && !pm.unlocked(m) && (!asked.length || asked.includes(m)));
    if (!which.length) {
      const open = MANAGER_IDS.find((m) => pm.isOn(m) && pm.unlocked(m));
      if (open) return { unlocked: true, manager: open };
      throw new OpError('denied_local', 'No password manager is turned on for Sara on this computer.');
    }
    const m = which[0];
    this.badge = `Your turn: unlock ${managerName(m)} in its own window`;
    try {
      const ok = await pm.unlock(m, String(a.site ?? ''), this.#running.get(id)?.signal);
      this.#localLog('b.unlock', ok ? `${managerName(m)} unlocked by the person` : `${managerName(m)} not unlocked`, '');
      return ok ? { unlocked: true, manager: m } : { unlocked: false, manager: m, why: 'not unlocked in its window' };
    } catch (err) {
      if (err instanceof ManagerError) throw new OpError(err.code, err.message);
      throw err;
    } finally {
      this.badge = '';
    }
  }

  /** Phase 90: b.saveLogin. The consent window decides; the device saves only with the box ticked. */
  async #saveLogin(a: Record<string, unknown>, server: string): Promise<Record<string, unknown>> {
    const b = this.browser;
    const t = b.tab(a.tab);
    const site = loginOrigin((await b.info2(t)).url);
    if (!site) throw new OpError('not_found', 'Open the site\u2019s sign-in page in the Sara browser first: a login is saved for the site that is open.');
    if (!this.opts.consent) throw new OpError('perm_missing', 'This computer has no window to save a login with.');
    const c = b.caught && b.caught.origin === site && Date.now() - b.caught.at < CAUGHT_KEEP_MS ? b.caught : undefined;
    const name = cleanLoginName(a.name) || defaultLoginName(site);
    this.badge = 'Save a login for Sara?';
    let answer: ConsentAnswer;
    try {
      answer = await this.opts.consent({ site, name, warning: SAVE_LOGIN_WARNING.replace('{site}', site), canUseTyped: Boolean(c) });
    } finally {
      this.badge = '';
    }
    const given = answer.useTyped && c ? { ...answer, username: c.username, password: c.password } : answer;
    let view;
    try {
      view = this.vault.save(server, site, { ...given, name: cleanLoginName(given.name) || name });
    } catch (err) {
      if (err instanceof LoginError && err.code === 'cancelled') return { outcome: 'cancelled', why: err.message };
      if (err instanceof LoginError) throw new OpError(err.code, err.message);
      throw err;
    }
    if (answer.useTyped) b.caught = undefined;
    this.#localLog('b.saveLogin', `saved the login \u201c${view.name}\u201d`, site);
    this.tellLogins();
    return { outcome: 'saved', name: view.name, sites: view.sites };
  }

  async #keys(t: Tab, combo: string): Promise<void> {
    const plan = await this.browser.agent<{ events?: Record<string, unknown>[]; error?: string }>(t, 'keys', { combo });
    if (!plan.events) throw new OpError('denied_local', plan.error ?? 'Not a key Sara presses.');
    for (const ev of plan.events) await this.browser.cdp!.send('Input.dispatchKeyEvent', ev, t.sessionId);
  }

  // ---------------- Phase 89 (CU3): the dev tunnel ----------------
  /** The local ports of the dev tunnels open here (tests read it). */
  get tunnelPorts(): number[] {
    return [...this.#tunnels.values()].map((t) => t.localPort);
  }

  /** c.tunnel: a listener on 127.0.0.1 only (the same port when free here, else any free one). */
  async #openTunnel(ws: WsConnection, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(a.tunnel ?? '');
    const port = Number(a.port);
    if (!/^[0-9a-f]{8,64}$/.test(id)) throw new OpError('denied_local', 'Not a tunnel id.');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new OpError('denied_local', 'Dev tunnels use ports 1024 to 65535 only.');
    const have = this.#tunnels.get(id);
    if (have) return { localPort: have.localPort, url: `http://127.0.0.1:${have.localPort}` };
    if (this.#tunnels.size >= TUNNEL_DEVICE_LIMITS.tunnels) throw new OpError('denied_local', `At most ${TUNNEL_DEVICE_LIMITS.tunnels} dev tunnels at once on this computer.`);
    const listen = (p: number) =>
      new Promise<NetServer>((resolve, reject) => {
        const server = createNetServer((sock) => this.#accept(ws, id, sock));
        server.once('error', reject);
        // Loopback only: nothing on the network can reach it.
        server.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => resolve(server));
      });
    let server: NetServer;
    try {
      server = await listen(port);
    } catch {
      server = await listen(0);
    }
    const localPort = (server.address() as AddressInfo).port;
    this.#tunnels.set(id, { server, port, localPort, sids: new Set() });
    this.opts.log?.(`dev tunnel ${id.slice(0, 6)}: 127.0.0.1:${localPort} → the server's port ${port}`);
    return { localPort, url: `http://127.0.0.1:${localPort}` };
  }

  /** c.untunnel (or Stop, or the connection closed): the listener and its connections close. */
  closeTunnel(id: string): boolean {
    const t = this.#tunnels.get(id);
    if (!t) return false;
    this.#tunnels.delete(id);
    t.server.close();
    for (const sid of t.sids) {
      const s = this.#streams.get(sid);
      if (s) {
        s.closed = true;
        s.socket.destroy();
      }
      this.#streams.delete(sid);
    }
    return true;
  }

  closeTunnels(): void {
    for (const id of [...this.#tunnels.keys()]) this.closeTunnel(id);
  }

  /** A connection from the Sara browser (or anything on this computer) to a tunnel's local port. */
  #accept(ws: WsConnection, tunnel: string, sock: Socket): void {
    const t = this.#tunnels.get(tunnel);
    if (!t || !ws.open || this.ws !== ws || t.sids.size >= TUNNEL_DEVICE_LIMITS.streams) return void sock.destroy();
    const sid = ++this.#sid;
    const s = { socket: sock, tunnel, closed: false };
    this.#streams.set(sid, s);
    t.sids.add(sid);
    sock.setNoDelay(true);
    const send = (m: Record<string, unknown>) => {
      if (ws.open) ws.send(JSON.stringify({ t: 's', ...m }));
    };
    send({ ev: 'open', tunnel, sid });
    sock.on('data', (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += TUNNEL_DEVICE_LIMITS.chunk) if (ws.open) ws.send(packBinary({ s: sid }, chunk.subarray(i, i + TUNNEL_DEVICE_LIMITS.chunk)));
      // The connection to the server is backed up: stop reading for a moment.
      if ((ws.buffered ?? 0) > TUNNEL_DEVICE_LIMITS.highWater) {
        sock.pause();
        const wait = setInterval(() => {
          if (s.closed || (ws.buffered ?? 0) < TUNNEL_DEVICE_LIMITS.highWater / 4) {
            clearInterval(wait);
            if (!s.closed) sock.resume();
          }
        }, 25);
        wait.unref?.();
      }
    });
    sock.on('end', () => {
      if (!s.closed) send({ ev: 'end', sid });
    });
    const gone = () => {
      if (!this.#streams.has(sid)) return;
      this.#streams.delete(sid);
      t.sids.delete(sid);
      if (!s.closed) {
        s.closed = true;
        send({ ev: 'close', sid });
      }
    };
    sock.on('error', gone);
    sock.on('close', gone);
  }

  /** {t:'s'} from the server: ok, end, close, pause, resume for one stream. */
  #streamControl(m: Record<string, unknown>): void {
    const sid = Number(m.sid);
    const s = this.#streams.get(sid);
    if (!s) return;
    const ev = String(m.ev ?? '');
    if (ev === 'end') s.socket.end();
    else if (ev === 'close') {
      s.closed = true;
      s.socket.destroy();
    } else if (ev === 'pause') s.socket.pause();
    else if (ev === 'resume') s.socket.resume();
  }

  async #desktop(ws: WsConnection, id: string, op: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dt = this.opts.desktop!;
    try {
      if (op === 'd.screens') return dt.screens();
      if (op === 'd.windows') return dt.list();
      if (op === 'd.elements') return dt.elements(a);
      if (DESKTOP_INPUT.has(op)) {
        const signal = this.#running.get(id)?.signal;
        if (!signal) throw new OpError('stopped', 'The desktop request was cancelled.');
        const act = async () => {
          if (signal.aborted) throw new OpError('stopped', 'The queued desktop request was cancelled.');
          const target = dt.inspect(op, a);
          dt.beginTask(this.opts.walkAway === true);
          const prompt = { op, forceOnce: a.forceOnce === true || a.approvalLevel === 'ask', task: String(a.task ?? ''), target: { role: target.element?.role, name: target.element?.name ?? String(a.app ?? ''), secret: target.element?.secure }, ...(typeof a.text === 'string' ? { text: a.text } : {}) };
          const ok = await this.desktopConsent.allow(prompt, this.opts.desktopConsent, signal);
          if (signal?.aborted) throw new OpError('stopped', 'Stopped.');
          this.ws?.send(JSON.stringify({ t: 'ev', kind: 'local_approval', op, allowed: ok }));
          if (!ok) throw new OpError('denied_local', 'The person at this computer did not approve that action.');
          if (op !== 'd.launch') dt.refreshApproved(a);
          const result = dt.act(op, a); // Re-check after the person answers; never trust the earlier inspection.
          this.#localLog(op, String(a.task ?? ''), String(target.element?.name ?? a.app ?? ''));
          return result;
        };
        const next = this.#desktopQueue.then(act);
        this.#desktopQueue = next.catch(() => {});
        return await next;
      }
      const s = dt.shot(a);
      this.#image(ws, { id, kind: 'shot', mime: 'image/png', w: s.w, h: s.h, viewId: s.viewId }, s.png);
      this.#localLog(op, 'looked at the screen', String(a.window ?? 'screen'));
      return s.result;
    } catch (err) {
      const c = (err as { code?: string }).code;
      if (c) throw new OpError(c, (err as Error).message);
      throw err;
    }
  }

  /** Phase 94: one check-up change: the device's own rule, then its own card (every time), then the change. */
  async #apply(id: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sys = this.opts.system!;
    let ok: { kind: Parameters<TestSystem['apply']>[0]; target: string; what: string };
    try {
      ok = applyAllowed(a.kind, a.target, sys.last) as typeof ok;
    } catch (err) {
      sys.refused.push({ kind: String(a.kind ?? ''), target: String(a.target ?? ''), why: (err as Error).message });
      if (err instanceof CheckupError) throw new OpError(err.code, err.message);
      throw err;
    }
    const signal = this.#running.get(id)?.signal;
    const windows = /win/i.test(sys.data.os);
    const yes = this.opts.checkupConsent ? await this.opts.checkupConsent({ kind: ok.kind, target: ok.target, what: ok.what, text: applyCardText(ok.what, windows) }) : false;
    this.ws?.send(JSON.stringify({ t: 'ev', kind: 'local_approval', op: 's.apply', allowed: yes }));
    if (signal?.aborted) throw new OpError('stopped', 'Stopped.');
    if (!yes) {
      sys.refused.push({ kind: ok.kind, target: ok.target, why: 'declined on the computer' });
      return { done: false, declined: true, kind: ok.kind, target: ok.target };
    }
    const r = sys.apply(ok.kind, ok.target);
    this.#localLog('s.apply', ok.what, ok.target);
    return { ...r, what: ok.what };
  }

  /** Binary from the server: bytes for one stream (header {s: sid}). Anything else is ignored. */
  #streamData(ws: WsConnection, buf: Buffer): void {
    const b = parseBinary(buf);
    if (!b || b.header.s === undefined) return;
    const sid = Number(b.header.s);
    const s = this.#streams.get(sid);
    if (!s || s.closed) return;
    if (!s.socket.write(b.data)) {
      // The browser is slow to read: the server waits until it drains.
      ws.send(JSON.stringify({ t: 's', ev: 'pause', sid }));
      s.socket.once('drain', () => ws.open && ws.send(JSON.stringify({ t: 's', ev: 'resume', sid })));
    }
  }

  async #run(ws: WsConnection, id: string, op: string, args: Record<string, unknown>, what = ''): Promise<Record<string, unknown>> {
    const b = this.browser;
    if (op === 'c.ping') return { pong: true, at: new Date().toISOString() };
    if (op === 'c.tunnel') return this.#openTunnel(ws, args);
    if (op === 'c.untunnel') return { closed: this.closeTunnel(String(args.tunnel ?? '')) };
    // Phase 90: the saved logins here (names and sites only go back).
    const server = this.serverOrigin;
    if (op === 'c.endTask') { this.opts.desktop?.endTask(); this.desktopConsent.clear(); this.badge = ''; return { ended: true }; }
    // Phase 91: after the task (and "Lock now"): every manager unlocked for Sara locks again.
    if (op === 'b.relock') return { locked: (await this.opts.managers?.lockAll('the task ended')) ?? [] };
    if (op === 'b.unlock') return this.#unlock(id, args);
    // Phase 92 (CU5): desktop look on the fixture desktop, with the apps' rules (src/hands-desktop.ts).
    if (op.startsWith('d.')) return this.#desktop(ws, id, op, args);
    // Phase 94 (CU7): check-ups on the fixture computer.
    if (op === 's.check') {
      const r = this.opts.system!.check(args);
      this.#localLog(op, 'checked the computer (read only)', Object.keys(r.checks).join(', '));
      return r as unknown as Record<string, unknown>;
    }
    if (op === 's.apply') return this.#apply(id, args);
    if (op === 'b.logins') return { logins: this.vault.list(server), verify: this.opts.verify?.on === true };
    if (op === 'b.forgetLogin') {
      const all = args.all === true;
      const name = cleanLoginName(args.name);
      if (!all && !name) throw new OpError('not_found', 'Say which saved login to remove.');
      const n = all ? this.vault.remove(server, { all: true }) : this.vault.remove(server, name);
      if (n) {
        this.#localLog(op, all ? 'removed every saved login' : `removed the saved login \u201c${name}\u201d`, '');
        this.tellLogins();
      }
      return { removed: n, logins: this.vault.list(server) };
    }
    if ((op !== 'b.tabs' && op !== 'b.downloads') || b.running) await b.start();
    const tabsView = async () => Promise.all([...b.tabs.values()].map(async (t) => ({ tab: t.id, ...(await b.info2(t)), active: t === b.tab() })));
    switch (op) {
      case 'b.start':
        return { browser: { kind: b.info.kind ?? null, name: b.info.name ?? null }, tabs: await tabsView() };
      case 'b.tabs':
        return { tabs: b.running ? await tabsView() : [] };
      case 'b.open': {
        const check = addressAllowed(String(args.url ?? ''), b.serverOrigin);
        if (!check.ok) throw new OpError('denied_local', check.why);
        b.countOpen();
        const t = args.newTab === true || !b.tabs.size ? await b.newTab() : b.tab();
        b.activate(t);
        t.consoleErrors = 0;
        t.failedRequests = 0;
        t.status = 0;
        // A newly opened page starts with its own logs (the numbers keep counting up).
        t.logs.length = 0;
        let navError = '';
        await b.waitLoad(t, async () => {
          const r = (await b.cdp!.send('Page.navigate', { url: check.url.href }, t.sessionId)) as { errorText?: string };
          navError = r.errorText ?? '';
        });
        if (navError) throw new OpError('not_found', `The page didn't open: ${navError}`);
        const info = await b.info2(t);
        await this.#thumb(ws, id, t, args);
        void this.#frame(ws, t);
        return { tab: t.id, url: info.url, title: info.title, status: t.status, consoleErrors: t.consoleErrors, failedRequests: t.failedRequests };
      }
      case 'b.navigate': {
        const t = b.tab(args.tab);
        b.activate(t);
        const action = String(args.action ?? 'reload');
        if (action === 'reload') {
          t.consoleErrors = 0;
          t.failedRequests = 0;
          await b.waitLoad(t, () => b.cdp!.send('Page.reload', {}, t.sessionId));
        } else if (action === 'back' || action === 'forward') {
          const h = (await b.cdp!.send('Page.getNavigationHistory', {}, t.sessionId)) as { currentIndex: number; entries: { id: number; url: string }[] };
          const e = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
          if (!e) throw new OpError('not_found', `There is no page to go ${action} to.`);
          if (!addressAllowed(e.url, b.serverOrigin).ok) throw new OpError('denied_local', "That page isn't opened in the Sara browser.");
          await b.waitLoad(t, () => b.cdp!.send('Page.navigateToHistoryEntry', { entryId: e.id }, t.sessionId), 15_000);
        } else throw new OpError('unsupported', 'action: back, forward or reload.');
        const info = await b.info2(t);
        await this.#thumb(ws, id, t, args);
        void this.#frame(ws, t);
        return { tab: t.id, url: info.url, title: info.title, consoleErrors: t.consoleErrors, failedRequests: t.failedRequests };
      }
      case 'b.snapshot': {
        const t = b.tab(args.tab);
        const r = await b.agent<Record<string, unknown>>(t, 'snapshot', { from: Number(args.from) || 0, limit: 400 });
        await this.#thumb(ws, id, t, args);
        return { tab: t.id, viewId: `v${Date.now().toString(36)}`, ...r, consoleErrors: t.consoleErrors, failedRequests: t.failedRequests };
      }
      case 'b.read': {
        const t = b.tab(args.tab);
        const r = await b.agent<Record<string, unknown>>(t, 'text', { ...(args.ref ? { ref: String(args.ref) } : {}), max: Number(args.max) || 8000 });
        if (r.error) throw new OpError('not_found', String(r.error));
        return { tab: t.id, ...r };
      }
      case 'b.screenshot': {
        const t = b.tab(args.tab);
        const s = await b.shot(t, Math.min(1920, Math.max(160, Number(args.maxWidth) || 1280)), Math.min(90, Math.max(30, Number(args.quality) || 70)));
        const viewId = `v${Date.now().toString(36)}`;
        this.#image(ws, { id, kind: 'shot', mime: 'image/jpeg', w: s.w, h: s.h, viewId }, s.data);
        return { tab: t.id, w: s.w, h: s.h, viewId };
      }
      case 'b.logs': {
        const t = b.tab(args.tab);
        const since = Number(args.since) || 0;
        const entries = t.logs.filter((e) => Number(e.seq) > since).slice(-200);
        return { tab: t.id, url: (await b.info2(t)).url, entries, last: b.nextSeq() };
      }
      case 'b.request': {
        const t = b.tab(args.tab);
        let r: { body: string; base64Encoded: boolean };
        try {
          r = (await b.cdp!.send('Network.getResponseBody', { requestId: String(args.requestId ?? '') }, t.sessionId)) as { body: string; base64Encoded: boolean };
        } catch {
          throw new OpError('not_found', 'That response is no longer kept by the browser (reload and look again).');
        }
        const entry = t.logs.find((e) => e.requestId === String(args.requestId));
        if (r.base64Encoded) return { status: entry?.status ?? null, mime: 'binary', body: '(not text)', truncated: false };
        const body = maskSecrets(r.body);
        return { status: entry?.status ?? null, mime: 'text', body: body.slice(0, 64 * 1024), truncated: body.length > 64 * 1024 };
      }
      case 'b.find': {
        const t = b.tab(args.tab);
        const tgt: Record<string, unknown> = {};
        for (const k of ['ref', 'expect', 'text', 'field', 'x', 'y', 'w', 'h', 'focused']) if (args[k] !== undefined) tgt[k] = args[k];
        if (tgt.focused) {
          const st = await b.agent<Record<string, unknown>>(t, 'state', {});
          const info = await b.info2(t);
          return { found: true, role: 'page', name: String(st.focus ?? ''), desc: String(st.focus || 'the page'), page: { url: info.url, title: info.title } };
        }
        return b.agent<Record<string, unknown>>(t, 'target', tgt);
      }
      case 'b.click':
      case 'b.type':
      case 'b.select':
      case 'b.keys':
      case 'b.upload':
        return this.#act(ws, id, op, args, what);
      case 'b.scroll': {
        const t = b.tab(args.tab);
        const r = await b.agent<Record<string, unknown>>(t, 'scroll', args);
        if (r.error) throw new OpError(r.stale ? 'stale_view' : 'not_found', String(r.error));
        await new Promise((res) => setTimeout(res, 150));
        await this.#thumb(ws, id, t, args);
        void this.#frame(ws, t);
        return { tab: t.id, ...r };
      }
      case 'b.downloads': {
        const files = readdirSync(b.folder, { withFileTypes: true }).filter((f) => f.isFile() && !f.name.endsWith('.crdownload')).map((f) => {
          const st = statSync(join(b.folder, f.name));
          return { name: f.name, bytes: st.size, at: st.mtime.toISOString() };
        });
        return { files: files.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 100) };
      }
      case 'b.close': {
        const t = b.tab(args.tab);
        await b.cdp!.send('Target.closeTarget', { targetId: t.targetId });
        b.tabs.delete(t.id);
        return { closed: t.id };
      }
      case 'b.login':
        return this.#login(ws, id, args, server);

      case 'b.saveLogin':
        return this.#saveLogin(args, server);
      case 'b.yourTurn': {
        // §8.1: the person signs in (or types a code) themselves; she waits until they press Continue.
        const ac = this.#running.get(id);
        this.yourTurn = String(args.what ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 120) || 'sign in';
        this.badge = `Your turn: ${this.yourTurn}, then press Continue`;
        await new Promise<void>((resolve) => {
          this.#turnDone = resolve;
          ac?.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        const aborted = ac?.signal.aborted === true;
        this.#turnDone = undefined;
        this.yourTurn = '';
        this.badge = '';
        if (aborted) throw new OpError('stopped', 'Stopped.');
        const t = b.tabs.size ? b.tab() : undefined;
        return { continued: true, ...(t ? { tab: t.id, ...(await b.info2(t)) } : {}) };
      }
    }
    throw new OpError('unsupported', `This computer doesn't do "${op}".`);
  }
}

// ---- Run by hand (the Linux hands later; testing now) ----
if (process.argv[1] && /hands-ref\.ts$/.test(process.argv[1])) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const server = arg('--server');
  const tokenFile = arg('--token-file');
  if (!server || !tokenFile) {
    console.error('Usage: node src/hands-ref.ts --server http://127.0.0.1:7881 --token-file <file with the hands token> [--name NAME] [--visible] [--local-only]');
    process.exit(2);
  }
  const ref = new HandsRef({ server, token: readFileSync(tokenFile, 'utf8').trim(), ...(arg('--name') ? { name: arg('--name')! } : {}), headless: !process.argv.includes('--visible'), localOnly: process.argv.includes('--local-only'), ...(process.argv.includes('--desktop-fixture') ? { desktop: new TestDesktop(), optIn: { browser: true, desktop: true } } : {}), ...(process.argv.includes('--checkup-fixture') ? { system: new TestSystem(), optIn: { browser: true, desktop: true } } : {}), log: (l) => console.log(`[hands-ref] ${l}`) });
  void ref.start().catch((err: Error) => console.error(`[hands-ref] ${err.message}`));
  const bye = () => void ref.stop().then(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
