// Phase 23: updates from Settings. Sara runs as an unprivileged user, so she never updates
// herself: she drops a one-word request file ("check" or "update") in her data folder, and the
// root-owned sara-updater.path unit runs `sara web-request`, which backs up, updates, checks
// health and goes back to the previous version by itself if the new one doesn't start. The
// outcome lands in update-status.json, which this module reads back for the Settings page.
//
// Phase 46: on Windows and macOS there is no root helper and no git checkout. "Check for
// updates" reads the latest release from GitHub and compares versions; "Update" answers with the
// download page, whose installer upgrades Sara in place.
//
// C9: every release publishes a signed update notice (src/update-notice.ts). With a trusted notice,
// "Update" on Windows (the per-user install) and macOS downloads the installer in the background,
// checks its SHA-256 against the notice, keeps the previous version and starts the runner
// (src/update-apply.ts), which installs, health-checks and goes back when the new version doesn't
// come up. Without a notice (or with one that isn't signed by the release key) Sara falls back to
// GitHub's newest release and the download page, as before. Linux keeps the root helper and reads
// the notice for the button (its age, security flag and minimum version).
import { assertOnline, netFetch } from './net-guard.ts';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { UpdatePlan } from './update-apply.ts';
import { REQUEST_FILE, TASK_FULL } from './update-service.ts';
import { assetKey, NOTICE_KEYS, NOTICE_URL, noticeUrlFor, verifyNotice, type NoticePayload } from './update-notice.ts';

export type UpdateState = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'updating' | 'updated' | 'rolledback' | 'failed';

export interface UpdateStatus {
  state: UpdateState;
  message: string;
  at?: string;
  version?: string;
  latest?: string;
  behind?: number;
  changes?: string[];
  /** A request is waiting for the updater to pick it up. */
  pending?: 'check' | 'update';
  /** Windows and macOS: the page with the new installer. */
  downloadUrl?: string;
  /** C9: the newest release's date (from the signed notice), for the Update button's colour. */
  releasedAt?: string;
  /** C9: the release fixes a security problem. */
  security?: boolean;
  /** C9: this version is below the notice's minimum supported version. */
  required?: boolean;
  /** C9: the notice was signed by the release key. */
  trusted?: boolean;
  /** C9: Update installs here by itself (download, verify, install, health check, roll back). */
  auto?: boolean;
  /** C9: why it can't (shown under the button). */
  autoWhy?: string;
  /** Windows service install: what Update needs ('service-task' = the Sara Update task installs it; 'service-setup' = that task isn't set up yet). */
  via?: 'service-task' | 'service-setup';
}

/** The Windows service install's update task (\Sara\Update, run as SYSTEM; src/update-service.ts). */
export interface ServiceTask {
  /** The task exists and this account may start it. */
  present(): boolean;
  /** Starts it (it reads the request Sara left in her data folder). */
  run(): Promise<void>;
}

const schtasks = (args: string[]) => spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
/** The real task, through schtasks.exe (the task's permissions let NT SERVICE\Sara read and run it). */
export const windowsServiceTask: ServiceTask = {
  present: () => schtasks(['/query', '/tn', TASK_FULL]).status === 0,
  run: async () => {
    const r = schtasks(['/run', '/tn', TASK_FULL]);
    if (r.status !== 0) throw new Error(`Windows didn't start the Sara Update task (${(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || `exit ${r.status}`}). Nothing was installed.`);
  },
};

export interface UpdaterOptions {
  dataDir: string;
  /** Where the root updater writes its status (root-owned, readable by sara). */
  statusDir?: string;
  /** Where systemd units live (tests point this elsewhere). */
  unitDir?: string;
  /** Which way updates work: Linux uses the root helper, Windows and macOS the release page. */
  platform?: NodeJS.Platform;
  /** This version (package.json), for comparing with the newest release. */
  version?: string;
  /** The newest-release address (GitHub API). */
  releaseUrl?: string;
  /** Tests stub the network. */
  fetch?: typeof fetch;
  /** C9: the CPU (installer per platform). */
  arch?: string;
  /** C9: the release-notice public keys (tests use their own). */
  noticeKeys?: Record<string, string>;
  /** C9: SARA_MODE (Windows: user|service) and SARA_PORT. */
  env?: NodeJS.ProcessEnv;
  /** C9: the install folder ({app} on Windows, Sara.app on macOS); default from Node's path. */
  appDir?: string;
  /** C9: starts the runner with the plan file (tests record it). */
  launch?: (planFile: string) => Promise<void>;
  /** C9: the Node the runner uses (default: a copy of this one outside the install folder). */
  runnerNode?: string;
  /** C9: how long the new version gets to come up (default 3 minutes). */
  healthTimeoutMs?: number;
  /** Windows service install: the update task (tests use a fake). */
  serviceTask?: ServiceTask;
}

/** Several Saras on one server: the instance's name (its unit sets SARA_INSTANCE; default "sara"). */
export function instanceName(env: NodeJS.ProcessEnv = process.env): string {
  const n = env.SARA_INSTANCE ?? '';
  return /^[a-z][a-z0-9-]{1,31}$/.test(n) ? n : 'sara';
}

const REQUEST = 'update-request';
const STATUS = 'update-status.json';
/** A request the updater hasn't picked up within this long means it isn't running. */
const STUCK_MS = 90_000;
export const RELEASE_API = 'https://api.github.com/repos/farena-ai/sara/releases/latest';
export const DOWNLOAD_PAGE = 'https://github.com/farena-ai/sara/releases/latest';
const releaseFile = (v: string, name: string) => `https://github.com/farena-ai/sara/releases/download/v${v}/${name}`;
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Compares dotted versions ("v0.46.1" vs "0.46.0"): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export class Updater {
  readonly #o: UpdaterOptions;
  /** Release mode: the last check (kept in memory; a restart checks again). */
  #last: UpdateStatus = { state: 'idle', message: '' };
  constructor(o: UpdaterOptions) {
    this.#o = o;
  }

  /** 'helper' (Linux: the root updater) or 'release' (Windows, macOS: the download page). */
  get how(): 'helper' | 'release' {
    // A given unit or status folder means the root helper (tests of it run on every system).
    const p = this.#o.platform ?? (this.#o.unitDir || this.#o.statusDir ? 'linux' : process.platform);
    return p === 'win32' || p === 'darwin' ? 'release' : 'helper';
  }

  /** True on a native systemd install with the updater unit (Docker and dev runs: no); always on Windows and macOS. */
  get available(): boolean {
    if (this.how === 'release') return true;
    return existsSync(join(this.#o.unitDir ?? '/etc/systemd/system', `${instanceName()}-updater.path`));
  }

  status(now = new Date()): UpdateStatus {
    if (this.how === 'release') return this.#withResult(now);
    let s: UpdateStatus = { state: 'idle', message: '' };
    try {
      const raw = JSON.parse(readFileSync(join(this.#o.statusDir ?? `/var/lib/${instanceName()}-updater`, STATUS), 'utf8')) as Record<string, unknown>;
      s = {
        state: String(raw.state) as UpdateState,
        message: String(raw.message ?? ''),
        ...(raw.at ? { at: String(raw.at) } : {}),
        ...(raw.version ? { version: String(raw.version) } : {}),
        ...(raw.latest ? { latest: String(raw.latest) } : {}),
        ...(raw.behind !== undefined ? { behind: Number(raw.behind) } : {}),
        ...(raw.changes ? { changes: String(raw.changes).split('\n').filter(Boolean).slice(0, 12) } : {}),
        ...this.#noticeInfo(raw.latest ? String(raw.latest) : undefined),
      };
    } catch {
      /* no status yet */
    }
    // An updater that died mid-way (power cut) must not block the button forever.
    if ((s.state === 'checking' || s.state === 'updating') && s.at && now.getTime() - Date.parse(s.at) > 20 * 60_000) {
      s.state = 'failed';
      s.message = "The last update didn't finish. On the server run: sudo sara status";
    }
    const req = join(this.#o.dataDir, REQUEST);
    if (existsSync(req)) {
      const what = readFileSync(req, 'utf8').trim() === 'update' ? 'update' : 'check';
      const age = now.getTime() - statSync(req).mtimeMs;
      s.pending = what;
      if (age > STUCK_MS) {
        s.state = 'failed';
        s.message = "The updater didn't pick up the request. On the server run: sudo sara update";
      }
    }
    return s;
  }

  /** Linux: hands the request to the root updater. Windows/macOS: use check() and update() instead. */
  request(what: 'check' | 'update'): void {
    if (this.how === 'release') throw new Error('Use check() or update() here.');
    // Phase 67: the root updater fetches from GitHub: never in private local mode.
    assertOnline('Checking for updates');
    if (!this.available) throw new Error('This server updates from the command line: sudo sara update');
    const s = this.status();
    if (s.pending || s.state === 'checking' || s.state === 'updating') throw new Error('An update check or update is already running.');
    writeFileSync(join(this.#o.dataDir, REQUEST), `${what}\n`, { mode: 0o600 });
    // C9: the signed notice tells the button how old the release is and whether it is a security fix.
    void this.#readNotice().catch(() => undefined);
  }

  /** Windows/macOS: asks GitHub for the newest release and compares it with this version. */
  check(now = new Date()): Promise<UpdateStatus> {
    // 2.18: every open page checks when it opens; several at once share one request to GitHub.
    if (!this.#inflight) this.#inflight = this.#check(now).finally(() => (this.#inflight = undefined));
    return this.#inflight;
  }
  #inflight: Promise<UpdateStatus> | undefined;

  async #check(now: Date): Promise<UpdateStatus> {
    const version = this.#o.version ?? '0.0.0';
    const at = now.toISOString();
    const f = this.#o.fetch ?? netFetch;
    // C9: the signed notice first; GitHub's newest release when there is none we can trust.
    const n = await this.#readNotice().catch((): { ok: false; reason: string; fetched: boolean } => ({ ok: false, reason: 'unreachable', fetched: false }));
    if (n.ok) {
      const p = n.notice;
      const changes = await this.#changes(f, version).catch(() => []);
      const info = this.#noticeInfo(p.version);
      const why = this.#autoWhy(p);
      const via = this.#isService() ? { via: why ? ('service-setup' as const) : ('service-task' as const) } : {};
      const base = { at, version, latest: p.version, downloadUrl: DOWNLOAD_PAGE, ...info, auto: !why, ...(why ? { autoWhy: why } : {}), ...via, ...(changes.length ? { changes } : {}) };
      this.#last =
        compareVersions(p.version, version) > 0
          ? { state: 'available', message: why ? `Sara ${p.version} is available. ${why}` : `Sara ${p.version} is available. Update downloads it, checks it, installs it and restarts Sara; if she doesn't start properly she goes back to ${version}.`, ...base }
          : { state: 'current', message: `Sara ${version} is the newest version.`, ...base, auto: false };
      return { ...this.#last };
    }
    let rel: { tag_name?: unknown; name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown };
    try {
      const res = await f(this.#o.releaseUrl ?? RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': `sara/${version}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rel = (await res.json()) as typeof rel;
      if (typeof rel?.tag_name !== 'string' || !rel.tag_name) throw new Error('no version in the answer');
    } catch {
      this.#last = { state: 'failed', message: "Couldn't check for updates. Try again later, or look on the download page.", at, version, downloadUrl: DOWNLOAD_PAGE, trusted: false, auto: false };
      return { ...this.#last };
    }
    const latest = String(rel.tag_name).replace(/^v/i, '');
    const page = typeof rel.html_url === 'string' && /^https:\/\/github\.com\//.test(rel.html_url) ? rel.html_url : DOWNLOAD_PAGE;
    const changes = typeof rel.body === 'string' ? rel.body.split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s+/, '').replace(/^#+\s*/, '').trim()).filter(Boolean).slice(0, 12) : [];
    const fallback = { trusted: false, auto: false, ...(n.fetched ? { autoWhy: `The update notice wasn't trusted (${n.reason}), so Sara doesn't install it by herself.` } : {}) };
    if (compareVersions(latest, version) > 0) {
      this.#last = { state: 'available', message: `Sara ${latest} is available. Download it and run the installer: it updates Sara in place and keeps your data.`, at, version, latest, downloadUrl: page, ...fallback, ...(changes.length ? { changes } : {}) };
    } else {
      this.#last = { state: 'current', message: `Sara ${version} is the newest version.`, at, version, latest, downloadUrl: page, ...fallback };
    }
    return { ...this.#last };
  }

  /** Windows/macOS: with a trusted notice, downloads, verifies and hands over to the runner; else the download page. */
  async update(now = new Date()): Promise<UpdateStatus> {
    const s = this.#last.state === 'available' ? this.#last : await this.check(now);
    if (s.state === 'available' && s.auto && this.#notice) {
      if (this.#bg) return { ...this.#last };
      const p = this.#notice;
      this.#last = { ...s, state: 'downloading', message: `Downloading Sara ${p.version}…`, at: now.toISOString() };
      this.#bg = this.#prepare(p)
        .catch((err: Error) => {
          this.#last = { ...s, state: 'failed', auto: false, message: err.message, at: new Date().toISOString() };
        })
        .finally(() => (this.#bg = undefined));
      return { ...this.#last };
    }
    if (s.state === 'available') return { ...s, message: `Download Sara ${s.latest} from ${s.downloadUrl} and run it: the installer updates Sara in place and keeps your data.` };
    return s;
  }

  /** Tests: waits for the background download to finish. */
  async settled(): Promise<void> {
    await this.#bg;
  }

  #bg: Promise<void> | undefined;
  /** The last trusted notice (release mode). */
  #notice: NoticePayload | undefined;
  #noticeAt: NoticePayload | undefined;
  /** The signed notice as read (the service's update task verifies it again). */
  #noticeRaw: unknown;

  get #dir(): string {
    return join(this.#o.dataDir, 'updates');
  }
  get #platform(): NodeJS.Platform {
    return this.#o.platform ?? process.platform;
  }

  /** Fetches and checks the signed notice; remembers the newest version seen (older ones are refused). */
  async #readNotice(): Promise<{ ok: true; notice: NoticePayload } | { ok: false; reason: string; fetched: boolean }> {
    const f = this.#o.fetch ?? netFetch;
    this.#notice = undefined;
    let raw: unknown;
    try {
      const res = await f(NOTICE_URL, { headers: { 'user-agent': `sara/${this.#o.version ?? '0.0.0'}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, fetched: false };
      raw = await res.json();
    } catch {
      return { ok: false, reason: 'unreachable', fetched: false };
    }
    const seenFile = join(this.#dir, 'notice-seen.json');
    let seen: string | undefined;
    try {
      seen = String((JSON.parse(readFileSync(seenFile, 'utf8')) as { version?: unknown }).version ?? '') || undefined;
    } catch {
      /* first notice */
    }
    const v = verifyNotice(raw, { keys: this.#o.noticeKeys ?? NOTICE_KEYS, ...(seen ? { seen } : {}) });
    if (!v.ok) {
      this.#notice = undefined;
      return { ok: false, reason: v.reason, fetched: true };
    }
    if (!seen || compareVersions(v.notice.version, seen) > 0) {
      mkdirSync(this.#dir, { recursive: true });
      writeFileSync(seenFile, `${JSON.stringify({ version: v.notice.version })}\n`);
    }
    this.#notice = v.notice;
    this.#noticeAt = v.notice;
    this.#noticeRaw = raw;
    return { ok: true, notice: v.notice };
  }

  /** The notice's date, security flag and minimum, for the button (only for the version it is about). */
  #noticeInfo(latest?: string): Pick<UpdateStatus, 'releasedAt' | 'security' | 'required' | 'trusted'> {
    const p = this.#noticeAt;
    if (!p || (latest && compareVersions(latest, p.version) !== 0)) return {};
    return { releasedAt: p.date, security: p.security, required: compareVersions(this.#o.version ?? '0.0.0', p.minSupported) < 0, trusted: true };
  }

  /** Why Update can't install here by itself ('' = it can). */
  #autoWhy(p: NoticePayload): string {
    const env = this.#o.env ?? process.env;
    const plat = this.#platform;
    if (!p.assets[assetKey(plat, this.#o.arch ?? process.arch)]) return 'There is no installer for this computer in the release: download it from the release page.';
    if (plat === 'win32' && env.SARA_MODE === 'service')
      return this.#serviceTask.present() ? '' : 'Sara runs as a Windows service. Run the newest Sara-Setup once as administrator: it sets up the Sara Update task, and from then on Update now works here.';
    if (plat === 'win32' && env.SARA_MODE !== 'user') return 'This Sara was not installed with Sara-Setup: download the installer from the release page.';
    if (plat === 'darwin' && !/\.app$/.test(this.#appDir)) return 'This Sara is not the Mac app: download it from the release page.';
    return '';
  }

  get #serviceTask(): ServiceTask {
    return this.#o.serviceTask ?? windowsServiceTask;
  }
  #isService(): boolean {
    return this.#platform === 'win32' && (this.#o.env ?? process.env).SARA_MODE === 'service';
  }

  get #appDir(): string {
    if (this.#o.appDir) return this.#o.appDir;
    // Windows: {app}\node\node.exe. macOS: Sara.app/Contents/Resources/node/bin/node.
    return this.#platform === 'darwin' ? resolve(dirname(process.execPath), '../../../..') : resolve(dirname(process.execPath), '..');
  }

  /** What's new: the GitHub release's notes (best effort). */
  async #changes(f: typeof fetch, version: string): Promise<string[]> {
    const res = await f(this.#o.releaseUrl ?? RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': `sara/${version}` }, signal: AbortSignal.timeout(15_000) });
    const rel = (await res.json()) as { body?: unknown };
    return typeof rel.body === 'string' ? rel.body.split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s+/, '').replace(/^#+\s*/, '').trim()).filter(Boolean).slice(0, 12) : [];
  }

  /** Downloads a file and checks its SHA-256; nothing is left behind when it doesn't match. */
  async #fetchFile(url: string, dest: string, expect: string | (() => Promise<string>)): Promise<void> {
    const f = this.#o.fetch ?? netFetch;
    mkdirSync(dirname(dest), { recursive: true });
    const res = await f(url, { headers: { 'user-agent': `sara/${this.#o.version ?? '0.0.0'}` }, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) throw new Error(`Couldn't download ${url.split('/').pop()} (HTTP ${res.status}). Nothing was installed.`);
    writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
    const want = typeof expect === 'string' ? expect : await expect();
    if (sha256(`${dest}.part`) !== want) {
      rmSync(`${dest}.part`, { force: true });
      throw new Error(`The download of ${url.split('/').pop()} didn't match the signed update notice, so nothing was installed.`);
    }
    renameSync(`${dest}.part`, dest);
  }

  /** The SHA-256 of a release file from that release's own signed notice, else its SHA256SUMS. */
  async #releaseSha(v: string, name: string): Promise<string> {
    const f = this.#o.fetch ?? netFetch;
    try {
      const r = verifyNotice(await (await f(noticeUrlFor(v), { signal: AbortSignal.timeout(15_000) })).json(), { keys: this.#o.noticeKeys ?? NOTICE_KEYS });
      const a = r.ok && r.notice.version === v ? Object.values(r.notice.assets).find((x) => x.name === name) : undefined;
      if (a) return a.sha256;
    } catch {
      /* releases before C9 have no notice */
    }
    const sums = await (await f(releaseFile(v, 'SHA256SUMS'), { signal: AbortSignal.timeout(15_000) })).text();
    const line = sums.split(/\r?\n/).find((l) => l.trim().split(/\s+\*?/)[1] === name);
    if (!line) throw new Error(`Couldn't get Sara ${v}'s installer to keep for going back, so the update didn't start.`);
    return line.trim().split(/\s+/)[0];
  }

  /** Download, verify, keep the previous version, start the runner. */
  async #prepare(p: NoticePayload): Promise<void> {
    const plat = this.#platform === 'darwin' ? 'darwin' : 'win32';
    const asset = p.assets[assetKey(plat, this.#o.arch ?? process.arch)];
    const from = this.#o.version ?? '0.0.0';
    const dl = join(this.#dir, 'download');
    const keep = join(this.#dir, 'keep');
    const installer = join(dl, asset.name);
    await this.#fetchFile(asset.url, installer, asset.sha256);
    if (plat === 'win32' && this.#isService()) {
      // The service account can't install: it leaves the signed notice and the download for the
      // Sara Update task (SYSTEM), which checks both again, keeps its own previous installer and runs it.
      rmSync(join(this.#dir, 'update-result.json'), { force: true });
      writeFileSync(join(this.#dir, REQUEST_FILE), `${JSON.stringify({ notice: this.#noticeRaw, installer }, null, 2)}\n`);
      await this.#serviceTask.run().catch((err: Error) => {
        rmSync(join(this.#dir, REQUEST_FILE), { force: true });
        throw err;
      });
      this.#last = { ...this.#last, state: 'updating', via: 'service-task', message: `Windows is installing Sara ${p.version} for the Sara service. Sara restarts in a minute or two; if she doesn't start properly she goes back to ${from}.`, at: new Date().toISOString() };
      return;
    }
    let previous = join(keep, 'Sara.app');
    if (plat === 'win32') {
      const name = `Sara-Setup-${from}.exe`;
      previous = join(keep, name);
      if (!existsSync(previous)) {
        await this.#fetchFile(releaseFile(from, name), previous, () => this.#releaseSha(from, name)).catch((err: Error) => {
          throw new Error(/didn't match/.test(err.message) ? err.message : `Couldn't get Sara ${from}'s installer to keep for going back, so the update didn't start.`);
        });
      }
    }
    // The runner runs from a copy outside the install folder (the installer replaces that folder).
    const runner = join(this.#dir, 'runner');
    mkdirSync(runner, { recursive: true });
    copyFileSync(join(import.meta.dirname, 'update-apply.ts'), join(runner, 'update-apply.ts'));
    let node = this.#o.runnerNode;
    if (!node) {
      node = join(runner, plat === 'win32' ? 'node.exe' : 'node');
      copyFileSync(process.execPath, node);
    }
    const env = this.#o.env ?? process.env;
    const plan: UpdatePlan = {
      platform: plat,
      from,
      to: p.version,
      installer,
      previous,
      appDir: this.#appDir,
      port: Number(env.SARA_PORT) || 7860,
      timeoutMs: this.#o.healthTimeoutMs ?? 3 * 60_000,
      resultFile: join(this.#dir, 'update-result.json'),
      keepDir: keep,
    };
    rmSync(plan.resultFile, { force: true });
    const planFile = join(this.#dir, 'plan.json');
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    await (this.#o.launch ?? ((f) => launchRunner(node!, join(runner, 'update-apply.ts'), f)))(planFile);
    this.#last = { ...this.#last, state: 'updating', message: `Installing Sara ${p.version}. Sara restarts in about a minute; if she doesn't start properly she goes back to ${from}.`, at: new Date().toISOString() };
  }

  /** Release mode: the runner's last outcome (after the restart) when it is newer than the last check. */
  #withResult(now: Date): UpdateStatus {
    try {
      const r = JSON.parse(readFileSync(join(this.#dir, 'update-result.json'), 'utf8')) as { state?: string; message?: string; at?: string; to?: string };
      const newer = !this.#last.at || Date.parse(r.at ?? '') > Date.parse(this.#last.at);
      if (newer && ['updating', 'updated', 'rolledback', 'failed'].includes(String(r.state)) && !this.#bg) {
        let state = r.state as UpdateState;
        let message = String(r.message ?? '');
        if (state === 'updating' && now.getTime() - Date.parse(r.at ?? '') > 20 * 60_000) {
          state = 'failed';
          message = "The last update didn't finish. Run the installer from the release page.";
        }
        return { ...this.#last, state, message, at: String(r.at), version: this.#o.version ?? '0.0.0' };
      }
    } catch {
      /* no update has run */
    }
    return { ...this.#last };
  }
}

/**
 * Starts the runner so it outlives Sara. On Windows Sara's Node runs inside the service host's job
 * (it closes every process in it when Sara stops), so the runner is created through WMI, outside it.
 */
export async function launchRunner(node: string, script: string, planFile: string): Promise<void> {
  if (process.platform === 'win32') {
    const q = (x: string) => x.replace(/'/g, "''");
    const cmd = `"${node}" --disable-warning=ExperimentalWarning "${script}" "${planFile}"`;
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(cmd)}'; CurrentDirectory = '${q(dirname(script))}' }; exit $r.ReturnValue`;
    await new Promise<void>((ok, fail) => {
      const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
      c.on('error', fail);
      c.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`Couldn't start the update (WMI ${code}).`))));
    });
    return;
  }
  const c = spawn(node, ['--disable-warning=ExperimentalWarning', script, planFile], { detached: true, stdio: 'ignore', cwd: dirname(script) });
  c.unref();
}
