// T3 (docs/SELF_CODE.md): level 3 self-repair. She changes her own code, safely:
//  1. proposeCodeFix: a separate working copy of her source (a git worktree when it is a repository,
//     else a plain copy), the owner's coding model makes the change under a per-repair cost cap and a
//     time cap, then typecheck + related tests (+ the full suite when it fits in the time) + a smoke
//     start on a free port with /api/health.
//  2. Protected paths (PROTECTED_PATHS) and test weakening are refused, at proposal and again at apply.
//  3. One card: plain-words summary, the diff, the checks. Approve: snapshot (the changed files + the
//     version), apply, restart through the runner (src/self-code-runner.ts), health check, automatic
//     rollback when she doesn't come up or comes up worse.
//  4. Applied changes are a patch queue (self_code_changes + <data>/self-code/patches/<id>.patch),
//     re-applied after an official update (checked in a copy first); one that no longer fits or fails
//     the tests is parked and the owner is told.
//  5. Optional report to the developers through the hub tickets, scrubbed, previewed exactly.
// Level 3 exists only where her source is a writable folder that survives a restart (a source
// checkout); installInfo() says plainly why not elsewhere. Owner only; every action is audited.
// NEVER (any level, any permission): edit the safety layer, hard limits, kid mode, approvals, the audit
// trail, the vault, or the permission code (this file included).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { audit as auditTrail, type AuditInput } from './audit-trail.ts';
import { cleanDiagnostics, cleanTicket, detectChannel, fileTicket, ticketBlocked, ticketWire, type HubSpace } from './hub.ts';
import { en, fill } from './i18n.ts';
import { privateLocalOn } from './net-guard.ts';
import type { RunnerPlan, RunnerResult } from './self-code-runner.ts';

import { applyPatchTo, cleanPath, isApplied, isTestFile, makePatch, parsePatch, PROTECTED_PATHS, protectedReason, readOrNull, testWeakening, type FileChange } from './self-code-rules.ts';
// The rules (protected paths, test weakening, the patch format) live in src/self-code-rules.ts.
export { applyPatchTo, cleanPath, formatPatch, isApplied, makePatch, parsePatch, PROTECTED_PATHS, protectedReason, testWeakening, type FileChange, type FilePatch } from './self-code-rules.ts';
const patchPaths = (patch: string) => parsePatch(patch).map((f) => f.path);

// ------------------------------------------------------------------------------------------------
// Where she can do this: how each install kind runs her code
// ------------------------------------------------------------------------------------------------

export type InstallKind = 'source' | 'server' | 'container' | 'desktop-windows' | 'desktop-mac' | 'package';
export interface InstallInfo {
  kind: InstallKind;
  level3: boolean;
  /** Why not (plain words; an en() key). */
  why?: string;
  root: string;
  git: boolean;
  /**
   * How a change goes live: she starts herself again (relaunch), `node --watch` does on the change, or
   * (rootapply, a Linux server install) the root helper applies it to her read-only copy and restarts her.
   */
  mode: 'relaunch' | 'watch' | 'root-helper';
  /** root-helper: the root-owned source checkout her working copies are made from (it has the tests). */
  from?: string;
}

/** rootapply: what the root helper says about itself (`/var/lib/<name>-updater/selfcode.json`, root's). */
export interface HelperState {
  on: boolean;
  src: string;
  /** U5.30: `sudo sara selfcode lock`: the owner can't turn it ON from Settings (OFF always works). */
  locked?: boolean;
  /** Who changed it last (admin, owner, install) and when. */
  by?: string;
  at?: string;
}
/** U5.30: the switch in Settings → Updates → Code changes, as the page shows it. */
export interface HelperView {
  on: boolean;
  locked: boolean;
  by: string | null;
  at: string | null;
  /** A request written and not taken by root yet. */
  pending: 'on' | 'off' | null;
  /** Root's last answer to the switch (done or refused, with its reason). */
  last: { want: string; state: string; message: string; at: string } | null;
}
const instanceOf = (env: NodeJS.ProcessEnv) => (/^[a-z][a-z0-9-]{1,31}$/.test(env.SARA_INSTANCE ?? '') ? env.SARA_INSTANCE! : 'sara');
export const helperDirOf = (env: NodeJS.ProcessEnv = process.env): string => `/var/lib/${instanceOf(env)}-updater`;
/** The helper's marker, or undefined when this server has no helper (an older install). */
export function readHelper(dir: string): HelperState | undefined {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'selfcode.json'), 'utf8')) as Record<string, unknown>;
    if (j.helper !== 1) return undefined;
    const h: HelperState = { on: j.on === true, src: typeof j.src === 'string' ? j.src : '' };
    if (typeof j.locked === 'boolean') h.locked = j.locked;
    if (typeof j.by === 'string' && /^[a-z]{1,16}$/.test(j.by)) h.by = j.by;
    if (typeof j.at === 'string' && Number.isFinite(Date.parse(j.at))) h.at = j.at;
    return h;
  } catch {
    return undefined;
  }
}

const isWritable = (p: string) => {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Server tarball (/opt/<name>, copied by root from /opt/<name>-src; ProtectSystem=strict): read-only for
 * her. Container image: a change would vanish when the image is pulled again. Windows/Mac apps: repaired
 * by reinstalling or going back (owner decision), never by rewriting their code. Homebrew/WinGet: the
 * package manager owns the files. A source checkout she can write to: yes.
 */
export function installInfo(o: { root: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => boolean; writable?: (p: string) => boolean; execArgv?: string[]; helper?: () => HelperState | undefined }): InstallInfo {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const writable = o.writable ?? isWritable;
  const git = exists(join(o.root, '.git'));
  const mode = (o.execArgv ?? process.execArgv).some((a) => a === '--watch' || a.startsWith('--watch=')) ? 'watch' : 'relaunch';
  const base = { root: o.root, git, mode } as const;
  const no = (kind: InstallKind, why: string): InstallInfo => ({ kind, level3: false, why, ...base });
  const ch = detectChannel({ env, platform, root: o.root, exists });
  if (ch === 'docker') return no('container', en("She runs from a container image here: a change to her code would be lost the next time the image is pulled or the container is made again. She can send the problem to the Sara developers instead."));
  if (ch === 'homebrew' || ch === 'winget') return no('package', en('A package manager installed her here and owns these files: it would undo a change at its next upgrade. She can send the problem to the Sara developers instead.'));
  if (ch === 'desktop-app' || (platform === 'win32' && (env.SARA_MODE === 'user' || env.SARA_MODE === 'service' || env.SARA_INSTALLED === '1'))) return no(platform === 'darwin' ? 'desktop-mac' : 'desktop-windows', en("This is the desktop app: apps are repaired by reinstalling or going back to the previous version, never by changing their code. She can send the problem to the Sara developers instead."));
  if (ch === 'installer' && platform === 'linux') {
    // rootapply: the root helper applies an approved change to the read-only copy (deploy/lib-selfcode.sh).
    const h = (o.helper ?? (() => readHelper(helperDirOf(env))))();
    if (h?.on && h.src) return { kind: 'server', level3: true, root: o.root, git: false, mode: 'root-helper', from: h.src };
    if (h) return no('server', en("Code changes from Sara are off on this server. The switch above turns them back on (unless the administrator locked it; on the server: sudo sara selfcode on). She can send the problem to the Sara developers instead."));
  }
  if (ch === 'installer') return no('server', en('This server runs her from a read-only copy that the installer made (only sudo sara update changes it), so she cannot change her own code here. She can send the problem to the Sara developers instead.'));
  if (!writable(o.root) || !writable(join(o.root, 'src'))) return no('source', en("Her source folder isn't writable by the account she runs as, so she cannot change her own code here. She can send the problem to the Sara developers instead."));
  return { kind: 'source', level3: true, ...base };
}

// ------------------------------------------------------------------------------------------------
// The separate working copy
// ------------------------------------------------------------------------------------------------

const SKIP_COPY = new Set(['node_modules', '.git', 'data', 'outputs', '.secrets']);
const git = (cwd: string, args: string[], input?: string) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });

/** A copy of her current source in `dir`: a git worktree (with her uncommitted changes) or a plain copy. */
export function makeWorkdir(root: string, dir: string, o: { git: boolean; from?: string }): void {
  mkdirSync(dirname(dir), { recursive: true });
  let done = false;
  if (o.git) {
    const r = git(root, ['worktree', 'add', '--detach', dir, 'HEAD']);
    if (r.status === 0) {
      // Her local changes (applied fixes among them) are not in HEAD: carry them over.
      const d = git(root, ['diff', 'HEAD', '--binary']);
      if (d.status === 0 && d.stdout.trim()) {
        const a = git(dir, ['apply', '--whitespace=nowarn'], d.stdout);
        if (a.status !== 0) throw new Error(`couldn't carry her local changes into the copy: ${a.stderr.trim().split('\n')[0]}`);
      }
      done = true;
    }
  }
  // rootapply: on a server the copy comes from the source checkout (it has the tests); her own
  // dependencies stay the ones linked below.
  const from = o.from ?? root;
  if (!done) cpSync(from, dir, { recursive: true, filter: (src) => !SKIP_COPY.has(basename(src)) || resolve(src) === resolve(from) });
  // Dependencies through links (never copies, never deleted through: removeWorkdir unlinks them first):
  // her own node_modules and the hydrated ones of her tool folders (tools/<name>/node_modules).
  for (const rel of depFolders(root)) {
    const at = join(dir, rel);
    if (existsSync(dirname(at)) && !existsSync(at)) symlinkSync(join(root, rel), at, 'junction');
  }
}

/** node_modules folders at the top and two levels down (tools/<name>/node_modules), relative paths. */
function depFolders(base: string): string[] {
  const out: string[] = [];
  const isDir = (p: string) => {
    try {
      return lstatSync(p).isDirectory() || lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (isDir(join(base, 'node_modules'))) out.push('node_modules');
  for (const a of safeList(base)) {
    if (SKIP_COPY.has(a) || a.startsWith('.')) continue;
    for (const b of safeList(join(base, a))) if (!b.startsWith('.') && b !== 'node_modules' && isDir(join(base, a, b, 'node_modules'))) out.push(`${a}/${b}/node_modules`);
  }
  return out;
}
const safeList = (p: string) => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** Removes the working copy: the node_modules link first (only the link), then the folder. */
export function removeWorkdir(root: string, dir: string): void {
  for (const rel of depFolders(dir)) {
    const link = join(dir, rel);
    try {
      if (lstatSync(link).isSymbolicLink()) {
        try {
          unlinkSync(link);
        } catch {
          rmdirSync(link);
        }
      }
    } catch {
      /* no link */
    }
  }
  if (existsSync(join(dir, '.git'))) git(root, ['worktree', 'remove', '--force', dir]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  if (existsSync(join(root, '.git'))) git(root, ['worktree', 'prune']);
}

// ------------------------------------------------------------------------------------------------
// Checks: typecheck, related tests, the full suite when it fits, a smoke start
// ------------------------------------------------------------------------------------------------

export interface CheckStep {
  name: 'typecheck' | 'related' | 'full' | 'smoke';
  ok: boolean;
  skipped?: boolean;
  detail: string;
  ms: number;
}
export interface CheckReport {
  ok: boolean;
  steps: CheckStep[];
}

/** The test files that import a changed file (and changed test files themselves), at most 12. */
export function relatedTests(root: string, changed: readonly string[]): string[] {
  const dir = join(root, 'test');
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => /\.test\.[cm]?[jt]s$/.test(f)) : [];
  const out = new Set<string>();
  for (const c of changed) if (isTestFile(c) && existsSync(join(root, c))) out.add(c);
  const names = changed.filter((c) => !isTestFile(c)).map((c) => basename(c).replace(/\.[cm]?[jt]s$/, ''));
  if (names.length) {
    const re = new RegExp(`[/'"](?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\.(?:ts|js|mjs)['"]`);
    for (const f of all) if (re.test(readFileSync(join(dir, f), 'utf8'))) out.add(`test/${f}`);
  }
  return [...out].sort().slice(0, 12);
}

const cleanEnv = (extra: Record<string, string> = {}) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'SARA_DEMO', 'SARA_PRIVATE_LOCAL', 'SARA_MASTER_KEY', 'SARA_INSTANCE', 'SARA_LOG_FILE', 'SARA_HUB_URL', 'SARA_INSTALLED']) if (!(k in extra)) delete e[k];
  return e;
};

function run(cmd: string, args: string[], o: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((ok) => {
    let out = '';
    let timedOut = false;
    const c = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? cleanEnv(), windowsHide: true });
    const keep = (b: Buffer) => (out = (out + b.toString('utf8')).slice(-16_000));
    c.stdout?.on('data', keep);
    c.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill();
    }, Math.max(1000, o.timeoutMs));
    c.on('error', (err) => keep(Buffer.from(String(err.message))));
    c.on('close', (code) => {
      clearTimeout(timer);
      ok({ code, out, timedOut });
    });
  });
}

/** Her own /api/health/ready answers 200 (the restart must not make it worse). Loopback only. */
export async function readyAt(port: number): Promise<boolean> {
  const r = await fetch(`http://127.0.0.1:${port}/api/health/ready`, { signal: AbortSignal.timeout(3000) });
  await r.arrayBuffer().catch(() => undefined);
  return r.status === 200;
}

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

/** Starts the copy (`node src/main.ts`) on a free port with an empty data folder; waits for /api/health. */
export async function smokeStart(dir: string, o: { timeoutMs?: number; node?: string } = {}): Promise<{ ok: boolean; detail: string }> {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'sara-selfcode-smoke-'));
  const env = cleanEnv({ SARA_DATA: data, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_SETUP: 'off', SARA_REPORT_TO: 'off', SARA_SANDBOX: 'none', SARA_TESTING: '1' });
  let out = '';
  let exited: number | null | undefined;
  const c = spawn(o.node ?? process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], { cwd: dir, env, windowsHide: true });
  c.stdout?.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-4000)));
  c.stderr?.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-4000)));
  c.on('exit', (code) => (exited = code));
  const end = Date.now() + (o.timeoutMs ?? 90_000);
  let ok = false;
  try {
    while (Date.now() < end && exited === undefined) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200 && (await r.json().catch(() => ({})))?.ok === true) {
          ok = true;
          break;
        }
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    if (exited === undefined) {
      c.kill();
      await new Promise((r) => (exited === undefined ? c.once('exit', r) : r(undefined)));
    }
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const tail = out.trim().split('\n').slice(-6).join('\n');
  return ok ? { ok, detail: `/api/health answered on a free port` } : { ok, detail: exited !== undefined && exited !== null ? `exited (${exited}) before answering: ${tail}` : `did not answer /api/health in time: ${tail}` };
}

/**
 * The real checks in the copy. The full suite only when the time left is larger than its last known
 * run (default 40 minutes); otherwise related tests + a smoke start. Typecheck when TypeScript is there.
 */
/** TypeScript errors in `after` that `before` didn't have (by file, code and message; lines may move). */
export function newErrors(after: string, before: string): string[] {
  const key = (l: string) => l.replace(/^(.+?)\(\d+,\d+\): error /, '$1: error ').trim();
  const seen = new Map<string, number>();
  for (const l of before.split('\n')) if (/: error TS\d+/.test(l)) seen.set(key(l), (seen.get(key(l)) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after.split('\n')) {
    if (!/: error TS\d+/.test(l)) continue;
    const n = seen.get(key(l)) ?? 0;
    if (n > 0) seen.set(key(l), n - 1);
    else out.push(l.trim());
  }
  return out;
}

export async function runChecks(dir: string, changed: readonly string[], deadline: number, o: { fullMs?: number; node?: string; revert?: () => () => void } = {}): Promise<CheckReport> {
  const node = o.node ?? process.execPath;
  const steps: CheckStep[] = [];
  const left = () => deadline - Date.now();
  const timed = async (name: CheckStep['name'], f: () => Promise<{ ok: boolean; detail: string }>) => {
    const t0 = Date.now();
    const r = await f();
    steps.push({ name, ok: r.ok, detail: r.detail.slice(-4000), ms: Date.now() - t0 });
  };
  const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(join(dir, 'tsconfig.json')) && existsSync(tsc)) {
    await timed('typecheck', async () => {
      const once = () => run(node, [tsc, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], { cwd: dir, timeoutMs: Math.min(left(), 15 * 60_000) });
      const r = await once();
      if (r.timedOut) return { ok: false, detail: 'ran out of time' };
      if (r.code === 0) return { ok: true, detail: 'no errors' };
      // Errors that were there before the change (a folder this copy lacks, an old error) don't count:
      // the same check on the files as they were, then only the new errors.
      if (!o.revert) return { ok: false, detail: r.out };
      const restore = o.revert();
      let before: Awaited<ReturnType<typeof run>>;
      try {
        before = await once();
      } finally {
        restore();
      }
      const fresh = newErrors(r.out, before.out);
      return fresh.length ? { ok: false, detail: fresh.join('\n') } : { ok: true, detail: 'no new errors (the copy had some before the change too)' };
    });
  } else steps.push({ name: 'typecheck', ok: true, skipped: true, detail: 'no TypeScript here', ms: 0 });
  const related = relatedTests(dir, changed);
  if (related.length) {
    await timed('related', async () => {
      const r = await run(node, ['--test', '--test-concurrency=4', ...related], { cwd: dir, timeoutMs: Math.max(1000, left()) });
      return { ok: r.code === 0, detail: r.timedOut ? 'ran out of time' : `${related.join(', ')}: ${r.code === 0 ? 'passed' : 'failed'}\n${r.code === 0 ? '' : r.out}` };
    });
  } else steps.push({ name: 'related', ok: true, skipped: true, detail: 'no test file imports the changed files', ms: 0 });
  let fullOk = false;
  if (left() > (o.fullMs ?? 40 * 60_000) && existsSync(join(dir, 'test'))) {
    const all = readdirSync(join(dir, 'test')).filter((f) => /\.test\.ts$/.test(f)).map((f) => `test/${f}`);
    await timed('full', async () => {
      const r = await run(node, ['--test', '--test-concurrency=3', ...all], { cwd: dir, timeoutMs: left() });
      fullOk = r.code === 0;
      return { ok: fullOk, detail: r.timedOut ? 'ran out of time' : r.code === 0 ? `${all.length} test files passed` : r.out };
    });
  } else steps.push({ name: 'full', ok: true, skipped: true, detail: 'not enough time left for the full suite: related tests and a smoke start instead', ms: 0 });
  if (!fullOk && existsSync(join(dir, 'src', 'main.ts'))) await timed('smoke', () => smokeStart(dir, { node, timeoutMs: Math.min(Math.max(10_000, left()), 120_000) }));
  return { ok: steps.every((s) => s.ok), steps };
}

// ------------------------------------------------------------------------------------------------
// The coding model's side
// ------------------------------------------------------------------------------------------------

export interface ModelReply {
  text: string;
  usd: number;
  /** The model ran on the owner's own hardware (private local mode needs this). */
  local?: boolean;
}
export type ModelFn = (messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal: AbortSignal) => Promise<ModelReply>;

const MAX_ROUNDS = 12;
const MAX_FIXES = 2;
const READ_MAX = 40_000;
const NO_READ = /^(\.secrets|data|outputs|node_modules|\.git)(\/|$)|^\.env|\.(pem|key|p12|pfx|keystore)$/i;

function systemPrompt(): string {
  return [
    "You are changing Sara's own source code (TypeScript on Node 24, no build step) in a separate working copy, to fix a problem or add what the owner asked for.",
    'Reply with ONE JSON object and nothing else, one of:',
    '{"read":["src/x.ts", ...]}  to see up to 6 files (paths relative to her folder);',
    '{"summary":"<1-3 plain sentences for a non-programmer: what was wrong and what you changed>","edits":[{"path":"src/x.ts","find":"<exact text that occurs once>","replace":"<new text>"}, {"path":"src/new.ts","content":"<whole new file>"}]}',
    '{"give_up":"<why, in plain words>"}',
    `Never change: ${PROTECTED_PATHS.map((p) => p.what).join('; ')}. Never delete or weaken tests (no removed asserts, no skips); add a test for the fix when you can.`,
    'Make the smallest clean change that fixes it and keep the project style. After your edits the typecheck and tests run; if they fail you get the output and can fix it.',
  ].join('\n');
}

function listing(root: string): string {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    const abs = join(root, rel);
    if (!existsSync(abs) || out.length > 900) return;
    for (const f of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) {
        if (depth < 2 && !SKIP_COPY.has(f.name)) walk(p, depth + 1);
      } else if (/\.(ts|js|mjs|json|css|html|md)$/.test(f.name)) out.push(p);
    }
  };
  for (const d of ['src', 'web', 'test']) walk(d, 0);
  return out.join('\n').slice(0, 12_000);
}

function parseReply(text: string): Record<string, unknown> | undefined {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return undefined;
  try {
    const v = JSON.parse(text.slice(s, e + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

class Refusal extends Error {
  readonly key: string;
  readonly params: Record<string, string | number>;
  constructor(key: string, params: Record<string, string | number>) {
    super(fill(key, params));
    this.key = key;
    this.params = params;
  }
}

// ------------------------------------------------------------------------------------------------
// The patch queue and the whole flow
// ------------------------------------------------------------------------------------------------

export type ChangeStatus = 'working' | 'proposed' | 'refused' | 'stopped' | 'failed' | 'discarded' | 'applying' | 'applied' | 'rolledback' | 'undoing' | 'undone' | 'parked';
export interface CodeChange {
  id: number;
  createdAt: string;
  updatedAt: string;
  request: string;
  summary: string | null;
  status: ChangeStatus;
  /** Plain-words note (English; noteKey + noteParams for the page's language). */
  note: string | null;
  noteKey: string | null;
  noteParams: Record<string, string | number> | null;
  files: string[];
  checks: CheckReport | null;
  costUsd: number;
  baseVersion: string;
  appliedAt: string | null;
  ticket: string | null;
  diff?: string;
}

export type RestartPlan = RunnerPlan;
export interface SelfCodeSettings {
  capUsd: number;
  minutes: number;
  /** T1's repair permission (read here, never written): 'auto1' | 'ask'. Level 3 always asks. */
  permission: string;
  fullUntil: string | null;
}

export interface SelfCodeDeps {
  root: string;
  dataDir: string;
  db: DatabaseSync;
  now?: () => Date;
  info?: () => InstallInfo;
  version?: () => string;
  model?: ModelFn;
  checks?: (dir: string, changed: string[], deadline: number) => Promise<CheckReport>;
  restart?: (plan: RestartPlan) => Promise<void>;
  settings?: () => SelfCodeSettings;
  hub?: () => HubSpace | undefined;
  notify?: (text: string) => void;
  audit?: (row: AuditInput) => void;
  privateLocal?: () => boolean;
  /** The port she listens on (the runner's health check asks 127.0.0.1). */
  port?: number;
  healthTimeoutMs?: number;
  /** /api/health/ready answers 200 now (the restart must not make it worse). */
  ready?: () => Promise<boolean>;
  /** rootapply: the root helper's folder (default /var/lib/<instance>-updater) and this instance's name. */
  helperDir?: string;
  instance?: string;
  /** U3.17/U3.18: every status change (remote repair reports it to the helper; fix recipes share applied ones). */
  onStatus?: (c: CodeChange) => void;
}

export class SelfCodeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, unknown>;
const SNAP = 'self-code';

export function selfCodeSettings(raw: Record<string, unknown> | undefined): SelfCodeSettings {
  const sc = (raw?.selfCode ?? {}) as Record<string, unknown>;
  const rp = (raw?.repair ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    capUsd: num(sc.capUsd, 2, 0.1, 50),
    minutes: Math.round(num(sc.minutes, 20, 5, 120)),
    permission: rp.permission === 'ask' ? 'ask' : 'auto1',
    fullUntil: typeof rp.fullUntil === 'string' && rp.fullUntil ? rp.fullUntil : null,
  };
}

export class SelfCode {
  readonly #d: SelfCodeDeps;
  readonly #dir: string;
  #running = new Map<number, Promise<CodeChange>>();
  #reapplying: Promise<void> | undefined;

  constructor(d: SelfCodeDeps) {
    this.#d = d;
    this.#dir = join(d.dataDir, SNAP);
    d.db.exec(`CREATE TABLE IF NOT EXISTS self_code_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      request TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      note TEXT,
      note_params TEXT,
      files TEXT NOT NULL DEFAULT '[]',
      checks TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      base_version TEXT NOT NULL DEFAULT '',
      applied_at TEXT,
      ticket TEXT
    )`);
  }

  #now = () => (this.#d.now ?? (() => new Date()))();
  info = (): InstallInfo => (this.#d.info ?? (() => installInfo({ root: this.#d.root })))();
  settings = (): SelfCodeSettings => this.#d.settings?.() ?? selfCodeSettings(undefined);
  #version = () => {
    try {
      return this.#d.version?.() ?? String(JSON.parse(readFileSync(join(this.#d.root, 'package.json'), 'utf8')).version ?? '');
    } catch {
      return '';
    }
  };
  #audit(action: string, outcome: AuditInput['outcome'], target?: number | string, content?: string): void {
    (this.#d.audit ?? auditTrail)({ action: `self-code.${action}`, role: 'owner', outcome, ...(target !== undefined ? { target: String(target) } : {}), ...(content ? { content: content.slice(0, 400) } : {}) });
  }
  #patchFile = (id: number) => join(this.#dir, 'patches', `${id}.patch`);
  #patch = (id: number) => readOrNull(this.#patchFile(id)) ?? '';

  #view(r: Row, diff = false): CodeChange {
    const id = Number(r.id);
    const params = r.note_params ? (JSON.parse(String(r.note_params)) as Record<string, string | number>) : null;
    return {
      id,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      request: String(r.request),
      summary: r.summary === null ? null : String(r.summary),
      status: String(r.status) as ChangeStatus,
      note: r.note ? fill(String(r.note), params ?? undefined) : null,
      noteKey: r.note ? String(r.note) : null,
      noteParams: params,
      files: JSON.parse(String(r.files ?? '[]')) as string[],
      checks: r.checks ? (JSON.parse(String(r.checks)) as CheckReport) : null,
      costUsd: Math.round(Number(r.cost_usd ?? 0) * 10_000) / 10_000,
      baseVersion: String(r.base_version ?? ''),
      appliedAt: r.applied_at ? String(r.applied_at) : null,
      ticket: r.ticket ? String(r.ticket) : null,
      ...(diff ? { diff: this.#patch(id) } : {}),
    };
  }
  get(id: number): CodeChange | undefined {
    const r = this.#d.db.prepare('SELECT * FROM self_code_changes WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r, true) : undefined;
  }
  list(limit = 50): CodeChange[] {
    return (this.#d.db.prepare('SELECT * FROM self_code_changes ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#view(r));
  }
  #set(id: number, f: Partial<{ status: ChangeStatus; summary: string; note: string | null; params: Record<string, string | number> | null; files: string[]; checks: CheckReport; cost: number; base: string; appliedAt: string | null; ticket: string }>): void {
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [this.#now().toISOString()];
    const add = (col: string, v: string | number | null) => (sets.push(`${col} = ?`), args.push(v));
    if (f.status) add('status', f.status);
    if (f.summary !== undefined) add('summary', f.summary);
    if (f.note !== undefined) (add('note', f.note), add('note_params', f.params ? JSON.stringify(f.params) : null));
    if (f.files) add('files', JSON.stringify(f.files));
    if (f.checks) add('checks', JSON.stringify(f.checks));
    if (f.cost !== undefined) add('cost_usd', f.cost);
    if (f.base !== undefined) add('base_version', f.base);
    if (f.appliedAt !== undefined) add('applied_at', f.appliedAt);
    if (f.ticket !== undefined) add('ticket', f.ticket);
    this.#d.db.prepare(`UPDATE self_code_changes SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    if (f.status && this.#d.onStatus) {
      try {
        this.#d.onStatus(this.get(id)!);
      } catch (err) {
        console.warn(`self-code: status hook: ${(err as Error).message}`);
      }
    }
  }

  status(): { available: boolean; kind: InstallKind; why: string | null; mode: string; cap: number; minutes: number; permission: string; fullUntil: string | null; version: string; changes: CodeChange[]; helper: HelperView | null } {
    const i = this.info();
    if (i.mode === 'root-helper') this.#finishHelper();
    const s = this.settings();
    return { available: i.level3, kind: i.kind, why: i.why ?? null, mode: i.mode, cap: s.capUsd, minutes: s.minutes, permission: s.permission, fullUntil: s.fullUntil, version: this.#version(), changes: this.list(), helper: this.helper() ?? null };
  }

  /** U5.30: the root helper's switch (undefined where there is no helper: not a Linux server install). */
  helper(): HelperView | undefined {
    const h = readHelper(this.#helperDir());
    if (!h) return undefined;
    let pending: HelperView['pending'] = null;
    try {
      const want = (JSON.parse(readFileSync(join(this.#dir, 'switch-request.json'), 'utf8')) as { want?: string }).want;
      if (want === 'on' || want === 'off') pending = want;
    } catch {
      /* none waiting */
    }
    let last: HelperView['last'] = null;
    try {
      const r = JSON.parse(readFileSync(join(this.#helperDir(), 'selfcode', 'switch.json'), 'utf8')) as Record<string, unknown>;
      if (typeof r.state === 'string' && typeof r.at === 'string') last = { want: String(r.want ?? ''), state: r.state, message: String(r.message ?? '').slice(0, 300), at: r.at };
    } catch {
      /* no answer yet */
    }
    return { on: h.on, locked: h.locked === true, by: h.by ?? null, at: h.at ?? null, pending, last };
  }

  /**
   * U5.30: asks the root helper to turn code changes on or off (the updater unit's request word
   * `selfcode-on` / `selfcode-off`). She never flips it herself; root re-checks and answers. The route
   * checks the owner's re-auth before an ON; a locked switch refuses ON here and again in root.
   */
  askSwitch(on: boolean): HelperView {
    const h = this.helper();
    if (!h) throw new SelfCodeError(409, en('This server has no code-change helper to switch.'));
    if (on && h.locked) throw new SelfCodeError(409, en("The server's administrator locked this switch: only they can turn code changes on (sudo sara selfcode unlock)."));
    const signal = join(this.#d.dataDir, 'update-request');
    if (existsSync(signal) || h.pending) throw new SelfCodeError(409, en('An update or another code change is waiting on this server. Try again in a minute.'));
    const approval = randomUUID();
    mkdirSync(this.#dir, { recursive: true });
    const request = { v: 1, instance: this.#d.instance ?? instanceOf(process.env), want: on ? 'on' : 'off', approval, at: this.#now().toISOString() };
    writeFileSync(join(this.#dir, 'switch-request.json'), `${JSON.stringify(request)}\n`, { mode: 0o600 });
    writeFileSync(signal, `selfcode-${request.want}\n`, { mode: 0o600 });
    this.#audit('switch', 'pending', undefined, `turn code changes ${request.want} (root helper, approval ${approval})`);
    return this.helper()!;
  }

  #assertAvailable(): InstallInfo {
    const i = this.info();
    if (!i.level3) throw new SelfCodeError(409, i.why ?? en('She cannot change her own code on this install.'));
    return i;
  }

  /** Starts a proposal in the background (the chat tool and the page); returns its row at once. */
  start(request: string): CodeChange {
    this.#assertAvailable();
    const id = this.#insert(request);
    const p = this.#propose(id).finally(() => this.#running.delete(id));
    this.#running.set(id, p);
    void p.then((c) => this.#d.notify?.(c.status === 'proposed' ? `Code change #${c.id} is ready for your OK: ${c.summary ?? c.request}` : `Code change #${c.id} was not prepared: ${c.note ?? c.status}`)).catch(() => undefined);
    return this.get(id)!;
  }
  /** Waits for every proposal still being prepared (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values(), this.#reapplying]);
  }
  /** proposeCodeFix: prepares one change and returns it (proposed, refused, stopped or failed). */
  async propose(request: string): Promise<CodeChange> {
    this.#assertAvailable();
    return this.#propose(this.#insert(request));
  }
  #insert(request: string): number {
    const req = String(request ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!req) throw new SelfCodeError(400, en('Say what is wrong or what she should change.'));
    const at = this.#now().toISOString();
    const r = this.#d.db.prepare("INSERT INTO self_code_changes (created_at, updated_at, request, status, base_version) VALUES (?, ?, ?, 'working', ?)").run(at, at, req, this.#version());
    return Number(r.lastInsertRowid);
  }

  async #propose(id: number): Promise<CodeChange> {
    const info = this.info();
    const s = this.settings();
    const request = this.get(id)!.request;
    const wd = join(this.#dir, 'work', String(id));
    const deadline = Date.now() + s.minutes * 60_000;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('time')), s.minutes * 60_000);
    let spent = 0;
    let calls = 0;
    const end = (status: ChangeStatus, note: string | null, params?: Record<string, string | number>, extra: Partial<{ summary: string; files: string[]; checks: CheckReport }> = {}) => {
      this.#set(id, { status, note, params: params ?? null, cost: spent, ...extra });
      this.#audit('propose', status === 'proposed' ? 'ok' : status === 'refused' ? 'refused' : 'failed', id, note ? fill(note, params) : undefined);
      return this.get(id)!;
    };
    try {
      if (existsSync(wd)) removeWorkdir(this.#d.root, wd);
      makeWorkdir(this.#d.root, wd, { git: info.git, ...(info.from ? { from: info.from } : {}) });
      const original = new Map<string, string | null>();
      const changes = (): FileChange[] =>
        [...original.entries()].map(([path, before]) => ({ path, before, after: readOrNull(join(wd, path)) })).filter((c) => c.before !== c.after);
      const model = this.#d.model;
      if (!model) return end('failed', en('No coding model is set up.'));
      const msgs: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: `The problem or request from the owner:\n"""${request}"""\n\nHer version: ${this.#version() || '?'}\nFiles (src, web, test):\n${listing(wd)}` },
      ];
      let fixes = 0;
      let summary = '';
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (Date.now() > deadline || ctl.signal.aborted) return end('stopped', en('Stopped at the time limit ({minutes} minutes) before a change was ready.'), { minutes: s.minutes });
        // The cap: stop before a call that would likely go past it (the average call so far).
        if (spent >= s.capUsd || (calls > 0 && spent + spent / calls > s.capUsd)) return end('stopped', en('Stopped at the spending cap ({cap}) before a change was ready.'), { cap: `$${s.capUsd.toFixed(2)}` });
        const reply = await model(msgs, ctl.signal);
        calls++;
        spent += Math.max(0, Number(reply.usd) || 0);
        if ((this.#d.privateLocal ?? privateLocalOn)() && reply.local === false) return end('refused', en('Private local mode is on: code changes use local models only, and the coding model is not a local one.'));
        msgs.push({ role: 'assistant', content: reply.text.slice(0, 60_000) });
        const j = parseReply(reply.text);
        if (!j) {
          msgs.push({ role: 'user', content: 'Reply with one JSON object only (read, edits or give_up).' });
          continue;
        }
        if (typeof j.give_up === 'string') return end('failed', en('The coding model gave up: {why}'), { why: j.give_up.slice(0, 300) });
        if (Array.isArray(j.read)) {
          const parts: string[] = [];
          let total = 0;
          for (const p of j.read.slice(0, 6)) {
            let path: string;
            try {
              path = cleanPath(String(p));
            } catch {
              parts.push(`${String(p)}: not inside her folder`);
              continue;
            }
            const text = NO_READ.test(path) ? null : readOrNull(join(wd, path));
            const body = text === null ? '(no such file, or not readable here)' : text.length > READ_MAX ? `${text.slice(0, READ_MAX)}\n… (cut)` : text;
            total += body.length;
            if (total > 120_000) break;
            parts.push(`=== ${path}\n${body}`);
          }
          msgs.push({ role: 'user', content: parts.join('\n\n') || 'Nothing to read.' });
          continue;
        }
        if (!Array.isArray(j.edits) || !j.edits.length) {
          msgs.push({ role: 'user', content: 'Reply with read, edits or give_up.' });
          continue;
        }
        if (typeof j.summary === 'string' && j.summary.trim()) summary = j.summary.trim().slice(0, 600);
        const problems: string[] = [];
        for (const e of j.edits.slice(0, 30) as Record<string, unknown>[]) {
          const path = cleanPath(String(e.path ?? ''));
          const what = protectedReason(path);
          if (what) throw new Refusal(en('It would change {what} ({path}), which she may never change.'), { what, path });
          const abs = join(wd, path);
          const cur = readOrNull(abs);
          if (!original.has(path)) original.set(path, cur);
          if (e.delete === true) {
            rmSync(abs, { force: true });
          } else if (typeof e.content === 'string') {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, e.content);
          } else if (typeof e.find === 'string' && typeof e.replace === 'string') {
            const n = cur === null ? 0 : cur.split(e.find).length - 1;
            // The same edit sent again after a failed check: already made, nothing to do.
            if (n === 0 && cur !== null && e.replace && cur.split(e.replace).length - 1 === 1) continue;
            if (n !== 1) {
              problems.push(`${path}: the find text occurs ${n} times (it must occur exactly once)`);
              continue;
            }
            writeFileSync(abs, cur!.replace(e.find, () => String(e.replace)));
          } else problems.push(`${path}: an edit needs find+replace, content, or delete`);
        }
        const ch = changes();
        const weak = testWeakening(ch);
        if (weak) throw new Refusal(en('It weakens her tests ({why}).'), { why: weak });
        if (problems.length) {
          msgs.push({ role: 'user', content: `Some edits were not made:\n${problems.join('\n')}\nSend the missing edits against the CURRENT files.` });
          continue;
        }
        if (!ch.length) {
          msgs.push({ role: 'user', content: 'Those edits changed nothing.' });
          continue;
        }
        // The copy as it was before the edits (for the typecheck's "new errors only" comparison).
        const revert = () => {
          const now = ch.map((c) => ({ path: c.path, cur: readOrNull(join(wd, c.path)) }));
          const put = (path: string, text: string | null) => (text === null ? rmSync(join(wd, path), { force: true }) : (mkdirSync(dirname(join(wd, path)), { recursive: true }), writeFileSync(join(wd, path), text)));
          for (const c of ch) put(c.path, c.before);
          return () => {
            for (const n of now) put(n.path, n.cur);
          };
        };
        const report = await (this.#d.checks ?? ((d, c, dl) => runChecks(d, c, dl, { revert })))(wd, ch.map((c) => c.path), deadline);
        if (!report.ok) {
          if (fixes++ < MAX_FIXES && Date.now() < deadline) {
            const out = report.steps.filter((x) => !x.ok).map((x) => `[${x.name}] ${x.detail}`).join('\n\n').slice(-6000);
            msgs.push({ role: 'user', content: `The checks failed:\n${out}\n\nFix it (edits against the CURRENT files).` });
            continue;
          }
          return end('failed', en("The change didn't pass the checks, so it isn't offered."), undefined, { files: ch.map((c) => c.path), checks: report, ...(summary ? { summary } : {}) });
        }
        mkdirSync(join(this.#dir, 'patches'), { recursive: true });
        writeFileSync(this.#patchFile(id), makePatch(ch));
        return end('proposed', null, undefined, { summary: summary || request, files: ch.map((c) => c.path), checks: report });
      }
      return end('stopped', en('Stopped after {n} rounds without a change.'), { n: MAX_ROUNDS });
    } catch (err) {
      if (err instanceof Refusal) return end('refused', err.key, err.params);
      if (ctl.signal.aborted) return end('stopped', en('Stopped at the time limit ({minutes} minutes) before a change was ready.'), { minutes: s.minutes });
      return end('failed', en('Preparing the change failed: {why}'), { why: String((err as Error).message).split('\n')[0]!.slice(0, 300) });
    } finally {
      clearTimeout(timer);
      try {
        if (existsSync(wd)) removeWorkdir(this.#d.root, wd);
      } catch {
        /* left for the next run */
      }
    }
  }

  /** U3.17: does a shared patch fit her code as it is now (the same lines, not applied yet)? */
  fits(patch: string): boolean {
    try {
      return Boolean(patch) && applyPatchTo(this.#d.root, patch, { dryRun: true }).ok && !isApplied(this.#d.root, patch);
    } catch {
      return false;
    }
  }

  /**
   * U3.17: a code fix shared by a linked friend's Sara. Her own rules first (protected paths, weaker
   * tests), then her own checks in a copy; it becomes an ordinary prepared change that waits for the
   * owner's Apply (snapshot, restart, health check, rollback, Undo) like any other. Nothing is applied here.
   */
  adopt(request: string, patch: string): CodeChange {
    this.#assertAvailable();
    const id = this.#insert(request);
    try {
      this.#recheck(patch);
      if (!this.fits(patch)) throw new SelfCodeError(409, en('Her code changed since this was prepared, so it no longer fits. Ask her again.'));
    } catch (err) {
      this.#set(id, { status: 'refused', note: (err as Error).message });
      this.#audit('adopt', 'refused', id, (err as Error).message);
      return this.get(id)!;
    }
    const p = this.#adopt(id, patch).finally(() => this.#running.delete(id));
    this.#running.set(id, p);
    return this.get(id)!;
  }
  async #adopt(id: number, patch: string): Promise<CodeChange> {
    const info = this.info();
    const wd = join(this.#dir, 'work', String(id));
    const files = patchPaths(patch);
    try {
      if (existsSync(wd)) removeWorkdir(this.#d.root, wd);
      makeWorkdir(this.#d.root, wd, { git: info.git, ...(info.from ? { from: info.from } : {}) });
      if (!applyPatchTo(wd, patch).ok) {
        this.#set(id, { status: 'failed', note: en('Her code changed since this was prepared, so it no longer fits. Ask her again.') });
        return this.get(id)!;
      }
      const deadline = Date.now() + this.settings().minutes * 60_000;
      const report = await (this.#d.checks ?? ((d, c, dl) => runChecks(d, c, dl)))(wd, files, deadline);
      if (!report.ok) {
        this.#set(id, { status: 'failed', note: en("The change didn't pass the checks, so it isn't offered."), files, checks: report });
        this.#audit('adopt', 'failed', id);
        return this.get(id)!;
      }
      mkdirSync(join(this.#dir, 'patches'), { recursive: true });
      writeFileSync(this.#patchFile(id), patch);
      this.#set(id, { status: 'proposed', note: null, summary: this.get(id)!.request, files, checks: report });
      this.#audit('adopt', 'ok', id);
      this.#d.notify?.(`Code change #${id} is ready for your OK: ${this.get(id)!.request}`);
      return this.get(id)!;
    } catch (err) {
      this.#set(id, { status: 'failed', note: en('Preparing the change failed: {why}'), params: { why: String((err as Error).message).split('\n')[0]!.slice(0, 300) } });
      return this.get(id)!;
    } finally {
      try {
        if (existsSync(wd)) removeWorkdir(this.#d.root, wd);
      } catch {
        /* left for the next run */
      }
    }
  }

  /** The rules again on the stored patch (Approve and re-apply run them too). */
  #recheck(patch: string, base = this.#d.root): FileChange[] {
    const parsed = parsePatch(patch);
    for (const f of parsed) {
      const what = protectedReason(f.path);
      if (what) throw new SelfCodeError(403, fill(en('It would change {what} ({path}), which she may never change.'), { what, path: f.path }));
    }
    const dry = applyPatchTo(base, patch, { dryRun: true });
    const weak = testWeakening(dry.files);
    if (weak) throw new SelfCodeError(403, fill(en('It weakens her tests ({why}).'), { why: weak }));
    return dry.files;
  }

  #snapshot(name: string, paths: string[]): { dir: string; files: { path: string; existed: boolean }[] } {
    const dir = join(this.#dir, 'snapshots', name);
    rmSync(dir, { recursive: true, force: true });
    const files = paths.map((path) => {
      const live = join(this.#d.root, path);
      const existed = existsSync(live);
      if (existed) {
        mkdirSync(dirname(join(dir, 'files', path)), { recursive: true });
        copyFileSync(live, join(dir, 'files', path));
      }
      return { path, existed };
    });
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ version: this.#version(), at: this.#now().toISOString(), files }, null, 2)}\n`);
    return { dir, files };
  }

  async #plan(kind: RunnerPlan['kind'], ids: number[], snap: { dir: string; files: { path: string; existed: boolean }[] }, info: InstallInfo): Promise<RunnerPlan> {
    const baselineReady = this.#d.ready ? await this.#d.ready().catch(() => false) : false;
    return {
      kind,
      ids,
      root: this.#d.root,
      snapshotDir: snap.dir,
      files: snap.files,
      resultFile: join(this.#dir, 'results', `${kind}-${ids.join('-')}.json`),
      timeoutMs: this.#d.healthTimeoutMs ?? 3 * 60_000,
      port: this.#d.port ?? 7860,
      pid: process.pid,
      node: process.execPath,
      args: [...process.execArgv, ...process.argv.slice(1)],
      cwd: process.cwd(),
      mode: info.mode === 'watch' ? 'watch' : 'relaunch',
      baselineReady,
      logFile: join(this.#d.dataDir, 'logs', 'self-code-restart.log'),
    };
  }

  /** Approve: snapshot, apply to her live folder, restart through the runner. */
  async apply(id: number): Promise<CodeChange> {
    const info = this.#assertAvailable();
    const c = this.get(id);
    if (!c) throw new SelfCodeError(404, en('No such code change.'));
    if (c.status !== 'proposed') throw new SelfCodeError(409, en('This change is not ready to apply (only a prepared change that passed its checks can be).'));
    const patch = this.#patch(id);
    if (info.mode === 'root-helper') return this.#askRoot(id, 'apply', patch, info, c);
    let files: FileChange[];
    try {
      files = this.#recheck(patch);
    } catch (err) {
      this.#set(id, { status: 'refused', note: (err as Error).message });
      this.#audit('apply', 'refused', id, (err as Error).message);
      throw err;
    }
    if (!applyPatchTo(this.#d.root, patch, { dryRun: true }).ok) {
      this.#set(id, { status: 'failed', note: en('Her code changed since this was prepared, so it no longer fits. Ask her again.') });
      this.#audit('apply', 'failed', id);
      throw new SelfCodeError(409, en('Her code changed since this was prepared, so it no longer fits. Ask her again.'));
    }
    const snap = this.#snapshot(String(id), files.map((f) => f.path));
    applyPatchTo(this.#d.root, patch);
    this.#set(id, { status: 'applying', note: null, base: this.#version() });
    this.#audit('apply', 'pending', id, c.summary ?? c.request);
    await this.#restart(await this.#plan('apply', [id], snap, info));
    return this.get(id)!;
  }

  /** Undo an applied change: the reverse patch through the same snapshot, restart and health check. */
  async undo(id: number): Promise<CodeChange> {
    const info = this.#assertAvailable();
    const c = this.get(id);
    if (!c) throw new SelfCodeError(404, en('No such code change.'));
    if (c.status !== 'applied') throw new SelfCodeError(409, en('Only an applied change can be undone.'));
    const patch = this.#patch(id);
    if (info.mode === 'root-helper') return this.#askRoot(id, 'undo', patch, info, c);
    const dry = applyPatchTo(this.#d.root, patch, { reverse: true, dryRun: true });
    if (!dry.ok) throw new SelfCodeError(409, en('A later change touches the same lines: undo that one first.'));
    const snap = this.#snapshot(`${id}-undo`, dry.files.map((f) => f.path));
    applyPatchTo(this.#d.root, patch, { reverse: true });
    this.#set(id, { status: 'undoing', note: null });
    this.#audit('undo', 'pending', id);
    await this.#restart(await this.#plan('undo', [id], snap, info));
    return this.get(id)!;
  }

  #helperDir = () => this.#d.helperDir ?? helperDirOf();

  /**
   * rootapply: hands an approved change to the root helper (it checks every rule again itself, applies it
   * to her read-only copy, restarts her and goes back when she isn't healthy). She writes only her own
   * data folder: the request (change number, owner approval id, the patch's hash) and the one-word
   * "selfcode" request the updater path unit watches.
   */
  #askRoot(id: number, kind: 'apply' | 'undo', patch: string, info: InstallInfo, c: CodeChange): CodeChange {
    const signal = join(this.#d.dataDir, 'update-request');
    if (existsSync(signal)) throw new SelfCodeError(409, en('An update or another code change is waiting on this server. Try again in a minute.'));
    if (kind === 'apply') {
      try {
        this.#recheck(patch, info.from ?? this.#d.root);
      } catch (err) {
        this.#set(id, { status: 'refused', note: (err as Error).message });
        this.#audit('apply', 'refused', id, (err as Error).message);
        throw err;
      }
    }
    const approval = randomUUID();
    const request = { v: 1, instance: this.#d.instance ?? instanceOf(process.env), id, kind, approval, ...(kind === 'apply' ? { sha256: createHash('sha256').update(patch).digest('hex') } : {}) };
    writeFileSync(join(this.#dir, 'root-request.json'), `${JSON.stringify(request)}\n`, { mode: 0o600 });
    writeFileSync(signal, 'selfcode\n', { mode: 0o600 });
    this.#set(id, kind === 'apply' ? { status: 'applying', note: null, base: this.#version() } : { status: 'undoing', note: null });
    this.#audit(kind, 'pending', id, `${kind === 'apply' ? (c.summary ?? c.request) : 'undo'} (root helper, approval ${approval})`);
    // The helper may refuse without restarting her: status() reads its answers (the page asks every 5 s).
    return this.get(id)!;
  }
  /** The root helper's results (`<helper dir>/selfcode/results/<id>.json`): newer than the change's row only. */
  #finishHelper(): void {
    const dir = join(this.#helperDir(), 'selfcode', 'results');
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => /^\d+\.json$/.test(x))) {
      let r: { id: number; kind: string; state: string; message?: string; at: string };
      try {
        r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as typeof r;
      } catch {
        continue;
      }
      const c = this.get(Number(r.id));
      if (!c) continue;
      const busy = c.status === 'applying' || c.status === 'undoing';
      // Results stay in root's folder: one counts once, when it is newer than the change's row.
      if (!(Date.parse(r.at) > Date.parse(c.updatedAt) - (busy ? 2000 : 0))) continue;
      const msg = r.message ? String(r.message).slice(0, 400) : null;
      const ok = r.state === 'applied' || r.state === 'undone';
      if (r.kind === 'undo') {
        if (r.state === 'undone') this.#set(c.id, { status: 'undone', note: null });
        else if (busy || c.status === 'applied') this.#set(c.id, { status: 'applied', note: msg });
        else continue;
      } else if (r.kind === 'reapply') {
        // (also while still "applying": the update's answer can replace the apply's before she read it)
        if (c.status !== 'applied' && c.status !== 'parked' && !busy) continue;
        this.#set(c.id, ok ? { status: 'applied', note: null, base: this.#version(), appliedAt: r.at } : { status: 'parked', note: msg });
      } else {
        if (!busy) continue;
        const status: ChangeStatus = ok ? 'applied' : r.state === 'rolledback' ? 'rolledback' : r.state === 'refused' ? 'refused' : 'failed';
        this.#set(c.id, ok ? { status, note: null, appliedAt: r.at } : { status, note: msg });
      }
      this.#audit(r.kind === 'undo' ? 'undone' : r.kind === 'reapply' ? 'reapply' : 'applied', ok ? 'ok' : r.state === 'refused' ? 'refused' : 'failed', c.id, `root helper: ${r.state}${msg ? `: ${msg}` : ''}`);
      if (!ok) this.#d.notify?.(`Code change #${c.id}: ${msg ?? r.state}`);
    }
  }

  discard(id: number): CodeChange {
    const c = this.get(id);
    if (!c) throw new SelfCodeError(404, en('No such code change.'));
    if (!['proposed', 'failed', 'refused', 'stopped', 'parked', 'rolledback'].includes(c.status)) throw new SelfCodeError(409, en('This change cannot be discarded now.'));
    this.#set(id, { status: 'discarded' });
    this.#audit('discard', 'ok', id);
    return this.get(id)!;
  }

  async #restart(plan: RunnerPlan): Promise<void> {
    mkdirSync(dirname(plan.resultFile), { recursive: true });
    rmSync(plan.resultFile, { force: true });
    await (this.#d.restart ?? restartRunner(this.#dir))(plan);
  }

  /** On start: reads the runner's outcomes (applied, undone, went back) and tells the owner. */
  finish(): void {
    this.#finishHelper();
    const dir = join(this.#dir, 'results');
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let r: RunnerResult;
      try {
        r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunnerResult;
      } catch {
        continue;
      }
      if (r.state === 'restarting') {
        // The runner may still be working; a result older than 15 minutes means it died.
        if (this.#now().getTime() - Date.parse(r.at) < 15 * 60_000) continue;
        r = { ...r, state: 'failed', message: "The restart runner didn't finish." };
      }
      for (const id of r.ids) {
        const c = this.get(id);
        if (!c) continue;
        const ok = r.state === 'applied' || r.state === 'undone';
        if (r.kind === 'undo') this.#set(id, ok ? { status: 'undone', note: null } : { status: 'applied', note: r.message });
        else if (r.kind === 'reapply') this.#set(id, ok ? { status: 'applied', note: null, base: this.#version(), appliedAt: r.at } : { status: 'parked', note: en('Parked: after the update she did not start properly with this change, so she went back.') });
        else this.#set(id, ok ? { status: 'applied', note: null, appliedAt: r.at } : { status: r.state === 'rolledback' ? 'rolledback' : 'failed', note: r.message });
        this.#audit(r.kind === 'undo' ? 'undone' : 'applied', ok ? 'ok' : 'failed', id, r.message);
        if (!ok) this.#d.notify?.(`Code change #${id}: ${r.message}`);
      }
      rmSync(join(dir, f), { force: true });
    }
  }

  /**
   * After a start: the runner's outcomes, then the patch queue. A queued change that is no longer in
   * her files (an official update replaced them) is re-applied in a copy and checked first; it goes
   * live through the same restart and health check, or is parked and the owner told.
   */
  afterBoot(): Promise<void> {
    this.finish();
    this.#reapplying ??= this.#reapply().finally(() => (this.#reapplying = undefined));
    return this.#reapplying;
  }

  async #reapply(): Promise<void> {
    const info = this.info();
    const applied = (this.#d.db.prepare("SELECT id FROM self_code_changes WHERE status = 'applied' ORDER BY id").all() as Row[]).map((r) => Number(r.id));
    const missing = applied.filter((id) => !isApplied(this.#d.root, this.#patch(id)));
    // rootapply: on a server, `sudo sara update` puts the queue back itself (deploy/lib-selfcode.sh).
    if (!missing.length || !info.level3 || info.mode === 'root-helper') return;
    const version = this.#version();
    const park = (id: number, key: string, params?: Record<string, string | number>) => {
      this.#set(id, { status: 'parked', note: key, params: params ?? null });
      this.#audit('park', 'refused', id, fill(key, params));
      this.#d.notify?.(`Code change #${id} was parked after the update to ${version}: ${fill(key, params)}`);
    };
    const wd = join(this.#dir, 'work', 'reapply');
    try {
      if (existsSync(wd)) removeWorkdir(this.#d.root, wd);
      makeWorkdir(this.#d.root, wd, { git: info.git });
      const ok: number[] = [];
      for (const id of missing) {
        try {
          this.#recheck(this.#patch(id));
        } catch (err) {
          park(id, (err as Error).message);
          continue;
        }
        if (applyPatchTo(wd, this.#patch(id)).ok) ok.push(id);
        else park(id, en('It no longer fits her code after the update to {version}.'), { version });
      }
      if (!ok.length) return;
      const changed = [...new Set(ok.flatMap((id) => patchPaths(this.#patch(id))))];
      const deadline = Date.now() + this.settings().minutes * 60_000;
      const report = await (this.#d.checks ?? ((d, c, dl) => runChecks(d, c, dl)))(wd, changed, deadline);
      if (!report.ok) {
        for (const id of ok) park(id, en('It fails her tests after the update to {version}.'), { version });
        return;
      }
      const snap = this.#snapshot(`reapply-${ok.join('-')}`, changed);
      for (const id of ok) applyPatchTo(this.#d.root, this.#patch(id));
      for (const id of ok) {
        this.#set(id, { status: 'applying', note: null, checks: report });
        this.#audit('reapply', 'pending', id, version);
      }
      await this.#restart(await this.#plan('reapply', ok, snap, info));
    } finally {
      try {
        if (existsSync(wd)) removeWorkdir(this.#d.root, wd);
      } catch {
        /* next time */
      }
    }
  }

  /** Exactly what "Send this fix to the Sara developers" sends (scrubbed; nothing is sent by this). */
  reportPreview(id: number): ReturnType<typeof ticketWire> {
    const h = this.#d.hub?.();
    if (!h || h.member) throw new SelfCodeError(409, en('Reports are not available here.'));
    const c = this.get(id);
    if (!c || !c.diff) throw new SelfCodeError(404, en('No such code change.'));
    const body = this.#reportBody(c);
    const t = cleanTicket(body);
    const f = h.facts();
    const diagnostics = cleanDiagnostics(body.diagnostics, h.scrub);
    return ticketWire({ kind: t.kind, title: t.title, body: h.scrub(t.body), lang: f.lang, version: f.version, os: f.os, ...(diagnostics ? { diagnostics } : {}) });
  }
  #reportBody(c: CodeChange): { kind: string; title: string; body: string; diagnostics: Record<string, unknown> } {
    const h = this.#d.hub!()!;
    const checks = (c.checks?.steps ?? []).map((s) => `${s.name}: ${s.skipped ? 'skipped' : s.ok ? 'passed' : 'failed'}`).join(', ');
    return {
      kind: 'bug',
      title: h.scrub(`Self-repair fix: ${c.summary ?? c.request}`).slice(0, 120),
      body: h.scrub([`Problem: ${c.request}`, `What she changed: ${c.summary ?? ''}`, `Files: ${c.files.join(', ')}`, `Checks: ${checks || 'none'}`, `Based on version: ${c.baseVersion}`, `Status here: ${c.status}`].join('\n')),
      diagnostics: { error: h.scrub(c.diff ?? '').slice(0, 16_000), steps: (c.checks?.steps ?? []).map((s) => ({ tool: `check:${s.name}`, status: s.skipped ? 'skipped' : s.ok ? 'ok' : 'failed' })) },
    };
  }
  /** Sends it (the owner ticked it and saw the preview). */
  async report(id: number): Promise<{ ticket: string }> {
    const h = this.#d.hub?.();
    if (!h || h.member) throw new SelfCodeError(409, en('Reports are not available here.'));
    const c = this.get(id);
    if (!c || !c.diff) throw new SelfCodeError(404, en('No such code change.'));
    if (ticketBlocked(h)) {
      this.#audit('report', 'refused', id);
      throw new SelfCodeError(409, en('Reports cannot be sent now (private local mode, the demo, or the network guard).'));
    }
    const r = await fileTicket(h, this.#reportBody(c), this.#now());
    if (!r.ok) {
      this.#audit('report', 'failed', id, r.code);
      throw new SelfCodeError(502, r.reason ?? en("The Sara developers' desk didn't take the report. Try again later."));
    }
    this.#set(id, { ticket: r.ticket });
    this.#audit('report', 'ok', id, r.ticket);
    return { ticket: r.ticket };
  }
}

/** The real restart: start the runner (it outlives her), then shut down so it can start her again. */
export function restartRunner(dir: string, o: { exit?: () => void } = {}): (plan: RunnerPlan) => Promise<void> {
  return async (plan) => {
    mkdirSync(join(dir, 'plans'), { recursive: true });
    const file = join(dir, 'plans', `${plan.kind}-${plan.ids.join('-')}.json`);
    writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
    const script = join(dirname(fileURLToPath(import.meta.url)), 'self-code-runner.ts');
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, file], { detached: true, stdio: 'ignore', cwd: plan.cwd, env: process.env, windowsHide: true });
    c.unref();
    // Under node --watch the file change restarts her by itself; otherwise she stops and the runner starts her.
    if (plan.mode === 'relaunch') setTimeout(o.exit ?? (() => process.emit('SIGTERM' as never)), 1500).unref?.();
  };
}

// ------------------------------------------------------------------------------------------------
// The owner's one SelfCode (set by main.ts for the owner's main companion; none for members/demo)
// ------------------------------------------------------------------------------------------------

const bound = new WeakMap<object, SelfCode>();
export function setSelfCode(app: object, sc: SelfCode | undefined): void {
  if (sc) bound.set(app, sc);
  else bound.delete(app);
}
export function selfCodeOf(app: object): SelfCode | undefined {
  return bound.get(app);
}
