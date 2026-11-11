// PRQ (docs/ops/PRQ_DESIGN.md): what is installed, the approval card for one program, and the
// install job (progress, Stop, timeout), then a re-check. Owner only (the route checks who asks);
// the policy (Settings and the EC5 pin) is checked here, on the server, every time; every outcome
// is one EC4 audit row. The runner is injected: tests and the screenshot instance never install.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, win32 } from 'node:path';
import { audit } from '../audit-trail.ts';
import { netFetch, privateLocalOn } from '../net-guard.ts';
import { killTree } from '../plugins/exec-job.ts';
import { policy } from '../policy-profile.ts';
import { isProgramId, program, PROGRAMS, type Os, type ProgramId } from './catalog.ts';
import { detect, type Detection, type DetectEnv } from './detect.ts';
import { installPlan, linuxSystem, shellLine, winLine, type InstallPlan, type PlanEnv, type PlanStep } from './plan.ts';

export type InstallsSetting = 'allowed' | 'ask' | 'off';
export const INSTALLS: readonly InstallsSetting[] = ['allowed', 'ask', 'off'];
export const JOB_TIMEOUT_MS = 20 * 60_000;
export const PROPOSAL_MS = 10 * 60_000;
const MAX_LINES = 40;
const MAX_STEP_OUTPUT = 64 * 1024;

/** A refusal the route turns into an HTTP error (the words are the app's, translated there). */
export class PrereqRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface StepOutcome {
  code: number | null;
  error?: string;
}
/** Runs one argv (shell:false) in `cwd`; lines go to onLine; the signal stops it. */
export type StepRunner = (argv: string[], o: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLine: (line: string) => void }) => Promise<StepOutcome>;
export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface ProgramStatus extends Detection {
  name: string;
  url: string;
  method: InstallPlan['method'];
  elevation: InstallPlan['elevation'];
  manual?: InstallPlan['manual'];
  after?: InstallPlan['after'];
}
export interface Proposal {
  id: string;
  program: ProgramId;
  name: string;
  method: InstallPlan['method'];
  source: InstallPlan['source'];
  elevation: InstallPlan['elevation'];
  userInstall: boolean;
  /** The exact steps as shown on the card: a command line, a download (with its sha256) or a file. */
  steps: ({ kind: 'run'; line: string } | { kind: 'download'; url: string; sha256?: string } | { kind: 'file'; file: string })[];
  privateLocal: boolean;
  setting: InstallsSetting;
  platform: Os | string;
  after?: InstallPlan['after'];
  expires: number;
}
export type JobState = 'running' | 'ok' | 'failed' | 'stopped' | 'timeout';
export interface JobView {
  id: string;
  program: ProgramId;
  name: string;
  state: JobState;
  step: number;
  steps: number;
  lines: string[];
  startedAt: string;
  endedAt?: string;
  /** After the job: the re-check. */
  found?: boolean;
  version?: string;
  /** Installed into a folder fenced tool servers may not see (Linux user install). */
  userInstall?: boolean;
  error?: string;
}

export interface PrereqDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (f: string) => boolean;
  list?: (d: string) => string[];
  read?: (f: string) => string | undefined;
  version?: DetectEnv['version'];
  /** Linux: running as root, `sudo -n true` works, a command is on PATH. */
  isRoot?: () => boolean;
  sudoOk?: () => boolean;
  runner?: StepRunner;
  fetch?: Fetcher;
  /** Where job temp folders go (`<data>/cache/prereqs`). */
  tmpRoot: string;
  /** The owner's setting (Settings → Add-ons); the EC5 pin tightens it. */
  setting: () => InstallsSetting | undefined;
  timeoutMs?: number;
  /** Adds a catalog folder to Sara's own PATH after an install (tool servers then find it). */
  addPath?: (dir: string) => void;
  /** Sara's own Node with npx beside it (tool servers run on it; a system Node is never needed). */
  ownNode?: () => Detection | undefined;
}

interface Pending {
  proposal: Proposal;
  plan: InstallPlan;
}
interface Job {
  view: JobView;
  ctl: AbortController;
  done: Promise<void>;
}

const SECRET_ENV = /(TOKEN|SECRET|PASSW|API_?KEY|CREDENTIAL|PRIVATE)|^SARA_/i;
/** The installer's environment: the user's, minus anything that looks like a secret or Sara's own. */
export function installerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !SECRET_ENV.test(k)));
}

/** The default runner: spawn with shell:false, H_EXEC's non-blocking tree kill on Stop. */
export const spawnStep: StepRunner = (argv, o) =>
  new Promise((resolve) => {
    if (o.signal.aborted) return resolve({ code: null, error: 'stopped' });
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (err) {
      return resolve({ code: null, error: (err as Error).message });
    }
    let bytes = 0;
    let rest = '';
    const take = (b: Buffer) => {
      if (bytes > MAX_STEP_OUTPUT) return;
      bytes += b.length;
      const parts = (rest + b.toString('utf8')).split(/\r?\n|\r/);
      rest = parts.pop() ?? '';
      for (const l of parts) if (l.trim()) o.onLine(l);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let settled = false;
    let giveUp: NodeJS.Timeout | undefined;
    const finish = (r: StepOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      o.signal.removeEventListener('abort', stop);
      if (rest.trim()) o.onLine(rest);
      resolve(r);
    };
    const stop = () => {
      killTree(child);
      // Never hold the job open on a process that won't die: settle and say so.
      giveUp = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: null, error: 'stop not confirmed' });
      }, 20_000);
      giveUp.unref?.();
    };
    o.signal.addEventListener('abort', stop, { once: true });
    child.on('error', (err) => finish({ code: null, error: err.message }));
    child.on('close', (code) => finish({ code }));
  });

const lstatOk = (f: string): boolean => {
  try {
    lstatSync(f);
    return true;
  } catch {
    return false;
  }
};
const winPaths = (env: NodeJS.ProcessEnv) => ({ ProgramFiles: env.ProgramFiles ?? env.PROGRAMFILES, 'ProgramFiles(x86)': env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'], LOCALAPPDATA: env.LOCALAPPDATA, USERPROFILE: env.USERPROFILE });

export class PrereqService {
  readonly d: PrereqDeps;
  readonly #pending = new Map<string, Pending>();
  readonly #jobs = new Map<string, Job>();
  #cache: { at: number; list: Map<ProgramId, Detection> } | undefined;

  constructor(d: PrereqDeps) {
    this.d = d;
  }
  get #platform(): Os | string {
    return this.d.platform ?? process.platform;
  }
  get #env(): NodeJS.ProcessEnv {
    return this.d.env ?? process.env;
  }
  #exists(f: string): boolean {
    return (this.d.exists ?? existsSync)(f);
  }

  /** The owner's setting held to the EC5 pin (pins only tighten: ask or off). */
  setting(): InstallsSetting {
    const own = this.d.setting() ?? 'ask';
    const pin = policy().pins.programInstalls;
    const rank = { allowed: 0, ask: 1, off: 2 } as const;
    return pin && rank[pin] > rank[own] ? pin : own;
  }

  #detectEnv(): DetectEnv {
    const env = this.#env;
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    return {
      platform: (this.#platform === 'win32' || this.#platform === 'darwin' ? this.#platform : 'linux') as Os,
      pathVar: env.PATH ?? env.Path ?? '',
      vars: { ...winPaths(env), HOME: home },
      exists: (f) => this.#exists(f),
      list: this.d.list ?? ((dir) => readdirSync(dir)),
      version:
        this.d.version ??
        ((file, args) => {
          if (/\.(cmd|bat)$/i.test(file)) return undefined;
          const r = spawnSync(file, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false, env: installerEnv(env) });
          return r.status === 0 ? `${r.stdout ?? ''}${r.stderr ?? ''}` : undefined;
        }),
    };
  }

  /** One program's detection (cached a few seconds; a finished job clears the cache). */
  detect(id: ProgramId): Detection {
    if (!this.#cache || Date.now() - this.#cache.at > 15_000) this.#cache = { at: Date.now(), list: new Map() };
    const hit = this.#cache.list.get(id);
    if (hit) return hit;
    // Sara itself runs on Node, and tool servers run on hers (src/tools/mcp.ts puts it first): when
    // npx sits beside it, that is the Node add-ons get, whatever (old) one the system has.
    const own = id === 'node' ? (this.d.ownNode ? this.d.ownNode() : this.d.exists ? undefined : ownNodeDetection()) : undefined;
    const d = own ?? detect(program(id), this.#detectEnv());
    this.#cache.list.set(id, d);
    return d;
  }

  #planEnv(): PlanEnv {
    const env = this.#env;
    const plat = this.#platform;
    const home = env.HOME ?? env.USERPROFILE ?? homedir();
    const de = this.#detectEnv();
    const onPath = (cmd: string) => detect({ id: 'uv', name: cmd, url: '', detect: { commands: [cmd], paths: {} } }, de).path ?? null;
    let linux: PlanEnv['linux'];
    let root = false;
    let sudo = false;
    if (plat === 'linux') {
      const rel = this.d.read ? this.d.read('/etc/os-release') : existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : undefined;
      linux = linuxSystem(rel ?? '', (c) => Boolean(onPath(c)));
      root = this.d.isRoot ? this.d.isRoot() : process.getuid?.() === 0;
      sudo = !root && (this.d.sudoOk ? this.d.sudoOk() : Boolean(onPath('sudo')) && spawnSync('sudo', ['-n', 'true'], { timeout: 5000, stdio: 'ignore' }).status === 0);
    }
    // winget is an app execution alias: stat can't follow it, lstat sees it.
    // A Windows path, built the Windows way whatever computer runs this code (detection is per target).
    const alias = env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe') : undefined;
    const aliasThere = (f: string) => (this.d.exists ? this.d.exists(f) : existsSync(f) || lstatOk(f));
    const winget = plat === 'win32' ? (alias && aliasThere(alias) ? alias : onPath('winget')) : null;
    const brew = plat === 'darwin' ? (['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((f) => this.#exists(f)) ?? onPath('brew')) : null;
    return { platform: plat, arch: this.d.arch ?? process.arch, home, ...(linux ? { linux } : {}), root, sudo, winget, brew };
  }

  plan(id: ProgramId): InstallPlan {
    return installPlan(program(id), this.#planEnv());
  }

  /** Every catalog program (or the ones asked for): found or not, and what Sara would do. */
  status(ids: ProgramId[] = PROGRAMS.map((p) => p.id)): ProgramStatus[] {
    const env = this.#planEnv();
    return ids.map((id) => {
      const p = installPlan(program(id), env);
      return { ...this.detect(id), name: p.name, url: program(id).url, method: p.method, elevation: p.elevation, ...(p.manual ? { manual: p.manual } : {}), ...(p.after ? { after: p.after } : {}) };
    });
  }

  #refuse(id: string, who: string, code: string, status: number, message: string): never {
    audit({ action: 'prereq.install', target: id, who, role: 'owner', channel: 'web', outcome: 'refused', keys: [code] });
    throw new PrereqRefused(status, code, message);
  }

  /** *Install it for me*: the approval card (nothing runs). Manual plans come back without an id to approve. */
  propose(id: unknown, who = 'owner'): Proposal | { manual: InstallPlan['manual']; program: ProgramId; name: string; after?: InstallPlan['after'] } {
    if (!isProgramId(id)) throw new PrereqRefused(404, 'unknown', 'Sara does not know that program.');
    if (this.setting() === 'off') this.#refuse(id, who, 'policy', 409, 'Program installs are off on this server.');
    const found = this.detect(id);
    if (found.found && !found.old) throw new PrereqRefused(409, 'installed', 'It is already on this computer.');
    const plan = this.plan(id);
    if (plan.manual) return { manual: plan.manual, program: id, name: plan.name, ...(plan.after ? { after: plan.after } : {}) };
    const win = this.#platform === 'win32';
    const proposal: Proposal = {
      id: randomUUID(),
      program: id,
      name: plan.name,
      method: plan.method,
      source: plan.source,
      elevation: plan.elevation,
      userInstall: plan.userInstall === true,
      steps: plan.steps.map((s) => (s.kind === 'run' ? { kind: 'run' as const, line: (win ? winLine : shellLine)(s.argv) } : s.kind === 'download' ? { kind: 'download' as const, url: s.url, ...(s.sha256 ? { sha256: s.sha256 } : {}) } : { kind: 'file' as const, file: s.file })),
      privateLocal: privateLocalOn(),
      setting: this.setting(),
      platform: this.#platform,
      ...(plan.after ? { after: plan.after } : {}),
      expires: Date.now() + PROPOSAL_MS,
    };
    for (const [k, p] of this.#pending) if (p.proposal.expires < Date.now()) this.#pending.delete(k);
    this.#pending.set(proposal.id, { proposal, plan });
    return proposal;
  }

  /** *Run it*: the approved card's exact plan, as a job. */
  approve(planId: string, who = 'owner'): JobView {
    const p = this.#pending.get(planId);
    if (!p || p.proposal.expires < Date.now()) throw new PrereqRefused(404, 'expired', 'That card has expired. Press Install it for me again.');
    const id = p.proposal.program;
    if (this.setting() === 'off') this.#refuse(id, who, 'policy', 409, 'Program installs are off on this server.');
    // Private local mode: the guard is never bypassed (like a model download); the owner turns it off for the install.
    if (privateLocalOn()) this.#refuse(id, who, 'private', 409, 'Private local mode is on: installing a program needs the internet. Turn Nothing leaves this computer off for the install, then on again.');
    for (const j of this.#jobs.values()) if (j.view.state === 'running') throw new PrereqRefused(409, 'busy', 'Another program is being installed. Wait for it or stop it.');
    this.#pending.delete(planId);
    return this.#start(p.plan, who);
  }

  job(id: string): JobView | undefined {
    return this.#jobs.get(id)?.view;
  }
  /** Waits for a job to end (tests, and the route's short poll). */
  async settled(id: string): Promise<JobView | undefined> {
    await this.#jobs.get(id)?.done;
    return this.job(id);
  }
  stop(id: string): JobView | undefined {
    const j = this.#jobs.get(id);
    if (j?.view.state === 'running') j.ctl.abort(new Error('stopped'));
    return j?.view;
  }

  #start(plan: InstallPlan, who: string): JobView {
    const view: JobView = { id: randomUUID(), program: plan.program, name: plan.name, state: 'running', step: 0, steps: plan.steps.length, lines: [], startedAt: new Date().toISOString(), ...(plan.userInstall ? { userInstall: true } : {}) };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), this.d.timeoutMs ?? JOB_TIMEOUT_MS);
    timer.unref?.();
    const line = (l: string) => {
      view.lines.push(l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 300));
      if (view.lines.length > MAX_LINES) view.lines.splice(0, view.lines.length - MAX_LINES);
    };
    const done = (async () => {
      mkdirSync(this.d.tmpRoot, { recursive: true });
      const tmp = mkdtempSync(join(this.d.tmpRoot, 'job-'));
      let failed: string | undefined;
      try {
        for (const [i, s] of plan.steps.entries()) {
          if (ctl.signal.aborted) break;
          view.step = i + 1;
          failed = await this.#step(s, tmp, ctl.signal, line);
          if (failed) break;
        }
      } catch (err) {
        failed = (err as Error).message;
      } finally {
        clearTimeout(timer);
        try {
          rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          /* a file still held: the cache folder is cleaned later */
        }
      }
      const reason = ctl.signal.aborted ? String((ctl.signal.reason as Error)?.message ?? 'stopped') : undefined;
      view.state = reason === 'timeout' ? 'timeout' : reason ? 'stopped' : failed ? 'failed' : 'ok';
      if (failed && !reason) view.error = failed.slice(0, 300);
      this.#cache = undefined;
      const again = this.detect(plan.program);
      view.found = again.found && !again.old;
      if (again.version) view.version = again.version;
      if (again.found && again.dir && !again.onPath) this.d.addPath?.(again.dir);
      view.endedAt = new Date().toISOString();
      audit({ action: 'prereq.install', target: plan.program, who, role: 'owner', channel: 'web', outcome: view.state === 'ok' ? 'ok' : 'failed', keys: [plan.method, ...(view.state === 'ok' || view.state === 'failed' ? [] : [view.state]), ...(view.state === 'ok' && !view.found ? ['not-found'] : [])] });
    })();
    this.#jobs.set(view.id, { view, ctl, done });
    for (const [k, j] of this.#jobs) if (j.view.state !== 'running' && this.#jobs.size > 20) this.#jobs.delete(k);
    return view;
  }

  /** One step; a failure comes back as its reason (said in the result), never thrown. */
  async #step(s: PlanStep, tmp: string, signal: AbortSignal, line: (l: string) => void): Promise<string | undefined> {
    if (s.kind === 'file') {
      writeFileSync(join(tmp, s.file), s.text, { mode: 0o644 });
      return undefined;
    }
    if (s.kind === 'download') {
      line(`↓ ${s.url}`);
      const get: Fetcher = this.d.fetch ?? ((url, init) => netFetch(url, init));
      const res = await get(s.url, { signal });
      if (!res.ok || !res.body) return `download ${res.status}`;
      const chunks: Uint8Array[] = [];
      let n = 0;
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
        n += c.length;
        if (n > s.maxBytes) return 'download too large';
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      if (s.sha256) {
        const got = createHash('sha256').update(buf).digest('hex');
        if (got !== s.sha256) return 'checksum mismatch';
        line(`sha256 ✓ ${got}`);
      }
      writeFileSync(join(tmp, s.file), buf, { mode: 0o644 });
      return undefined;
    }
    const argv = s.argv.map((a) => a.replace(/\{tmp\}/g, tmp));
    line(`$ ${(this.#platform === 'win32' ? winLine : shellLine)(argv)}`);
    const out = await (this.d.runner ?? spawnStep)(argv, { cwd: tmp, env: installerEnv(this.#env), signal, onLine: line });
    if (out.code === 0) return undefined;
    return out.error ?? `exit ${out.code}`;
  }
}

/** Sara's own Node, when npx sits beside it. */
export function ownNodeDetection(execPath = process.execPath, version = process.versions.node): Detection | undefined {
  const dir = dirname(execPath);
  const npx = ['npx', 'npx.cmd'].map((n) => join(dir, n)).find((f) => existsSync(f));
  return npx ? { id: 'node', found: true, path: execPath, dir, onPath: false, version } : undefined;
}

/** Adds a folder to this process's PATH (tool servers Sara starts inherit it). */
export function addToPath(dir: string): void {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const cur = process.env[key] ?? '';
  if (!cur.split(delimiter).some((d) => d.toLowerCase() === dir.toLowerCase())) process.env[key] = cur ? `${dir}${delimiter}${cur}` : dir;
}

// ---- the server's service (routes); a throwaway screenshot instance may swap in a fake computer ----
type Overrides = Partial<Pick<PrereqDeps, 'runner' | 'fetch' | 'exists' | 'list' | 'version'>>;
let overrides: Overrides = {};
export function setPrereqOverrides(o: Overrides): void {
  overrides = { ...o };
}
export const prereqOverrides = (): Overrides => overrides;
