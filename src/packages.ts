// Phase 96 (ST1, docs/design/STAPLES.md §2.1.6): folder packages. Skills (and, from ST3, plugins)
// are folders that arrive as a .zip, a git URL or a folder on the server. This file does the safe
// part once:
//   - caps on size and file count, so a zip bomb or a huge repo is refused, not unpacked;
//   - no links (every entry lstat'ed; symlinks, hard links and devices refused; a symlink entry in a
//     zip is refused by its Unix mode), no "..", no absolute paths, names NFC-normalised;
//   - a content hash (sha256 over the sorted paths and bytes) that pins exactly what the owner saw;
//   - git clones with hardened flags (no hooks, no credential helper, no fsmonitor, https only,
//     depth 1, no submodules, no LFS), after the private-local-mode check (src/net-guard.ts);
//   - a scan for prompt-injection tells, data sent elsewhere, key-shaped strings and scripts.
// Nothing here writes into a skill folder by itself; callers write with `writePackage`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { openZip } from './library/zip.ts';
import { checkOutbound } from './net-guard.ts';
import { KEY_SHAPED } from './redact.ts';
import { GIT_SAFE } from './tools/coding.ts';
import { commandPath } from './tools/sandbox.ts';

export interface PackageFile {
  /** Forward-slash path inside the folder (NFC). */
  path: string;
  data: Buffer;
}

export interface PackageLimits {
  /** Largest archive accepted (bytes). */
  maxZipBytes: number;
  maxFiles: number;
  /** All files together, unpacked. */
  maxTotalBytes: number;
  maxFileBytes: number;
  maxDepth: number;
}

/** §4.8: a .zip up to 5 MB and 300 files. */
export const SKILL_LIMITS: PackageLimits = { maxZipBytes: 5 * 1024 * 1024, maxFiles: 300, maxTotalBytes: 20 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxDepth: 8 };

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}

/** Folders a package never carries along. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store']);

/** A safe relative path, or a PackageError. */
export function cleanRelPath(raw: string): string {
  const p = String(raw ?? '').replace(/\\/g, '/').normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (!p || /[\u0000-\u001f\u007f]/.test(p)) throw new PackageError(`A file name in it isn't allowed (${JSON.stringify(p.slice(0, 80))}).`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new PackageError(`It holds a file with an absolute path (${p.slice(0, 80)}).`);
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) throw new PackageError(`It holds a file that points outside its folder (${p.slice(0, 80)}).`);
  const clean = segs.filter((s) => s && s !== '.');
  if (!clean.length) throw new PackageError('It holds a file with an empty name.');
  return clean.join('/');
}

function capCheck(files: PackageFile[], lim: PackageLimits): void {
  if (files.length > lim.maxFiles) throw new PackageError(`It has more than ${lim.maxFiles} files.`);
  let total = 0;
  for (const f of files) {
    if (f.data.length > lim.maxFileBytes) throw new PackageError(`${f.path} is too big.`);
    total += f.data.length;
    if (total > lim.maxTotalBytes) throw new PackageError('It unpacks to too much data.');
    if (f.path.split('/').length > lim.maxDepth) throw new PackageError(`${f.path} is nested too deep.`);
  }
}

/** The files of a .zip (zip-bomb caps; links, "..", absolute paths and duplicates refused). */
export function fromZip(buf: Buffer, lim: PackageLimits = SKILL_LIMITS): PackageFile[] {
  if (buf.length > lim.maxZipBytes) throw new PackageError(`The zip is larger than ${Math.round(lim.maxZipBytes / 1048576)} MB.`);
  let zip;
  try {
    zip = openZip(buf, { maxEntries: lim.maxFiles * 2 + 50, maxEntryBytes: lim.maxFileBytes, maxTotalBytes: lim.maxTotalBytes, maxRatio: 200 });
  } catch (err) {
    throw new PackageError((err as Error).message);
  }
  const files: PackageFile[] = [];
  const seen = new Set<string>();
  for (const e of zip.all) {
    // Unix mode in the high 16 bits of the external attributes (made by Unix = 3): a link or a
    // device is refused, whatever its name.
    const unix = (e.madeBy ?? 0) >> 8 === 3 || (e.madeBy ?? 0) >> 8 === 19 ? ((e.attrs ?? 0) >>> 16) & 0o170000 : 0;
    if (unix === 0o120000) throw new PackageError(`It holds a link (${e.name.slice(0, 80)}); links aren't allowed.`);
    if (unix && unix !== 0o100000 && unix !== 0o040000) throw new PackageError(`It holds a special file (${e.name.slice(0, 80)}).`);
    const path = cleanRelPath(e.name);
    if (e.name.endsWith('/')) continue;
    if (path.split('/').some((s) => SKIP_DIRS.has(s) || s === '__MACOSX')) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) throw new PackageError(`It holds ${path} twice.`);
    seen.add(key);
    if (files.length >= lim.maxFiles) throw new PackageError(`It has more than ${lim.maxFiles} files.`);
    let data: Buffer;
    try {
      data = zip.read(e.name);
    } catch (err) {
      throw new PackageError((err as Error).message);
    }
    files.push({ path, data });
  }
  capCheck(files, lim);
  return files;
}

/** The files of a folder on this server (lstat'ed: links, hard links and devices refused). */
export function fromFolder(root: string, lim: PackageLimits = SKILL_LIMITS, opts: { skipLinks?: boolean } = {}): PackageFile[] {
  const top = lstatSync(root);
  if (top.isSymbolicLink()) throw new PackageError("That folder is a link; links aren't allowed.");
  if (!top.isDirectory()) throw new PackageError("That isn't a folder.");
  const files: PackageFile[] = [];
  let total = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > lim.maxDepth) throw new PackageError(`${rel || '.'} is nested too deep.`);
    const names = readdirSync(dir).sort();
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        if (opts.skipLinks) continue;
        throw new PackageError(`${r} is a link; links aren't allowed.`);
      }
      if (st.isDirectory()) {
        walk(abs, r, depth + 1);
        continue;
      }
      if (!st.isFile()) throw new PackageError(`${r} is a special file.`);
      if (st.nlink > 1 && process.platform !== 'win32') throw new PackageError(`${r} is a hard link; links aren't allowed.`);
      if (files.length >= lim.maxFiles) throw new PackageError(`It has more than ${lim.maxFiles} files.`);
      if (st.size > lim.maxFileBytes) throw new PackageError(`${r} is too big.`);
      total += st.size;
      if (total > lim.maxTotalBytes) throw new PackageError('It holds too much data.');
      files.push({ path: cleanRelPath(r), data: readFileSync(abs) });
    }
  };
  walk(root, '', 1);
  capCheck(files, lim);
  return files;
}

/** sha256 over the sorted paths and their bytes: the hash the owner's review pins. */
export function hashFiles(files: readonly PackageFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path, 'utf8');
    h.update('\0');
    h.update(String(f.data.length));
    h.update('\0');
    h.update(f.data);
  }
  return h.digest('hex');
}

/** Writes a package into a new folder (which must not exist yet). */
export function writePackage(files: readonly PackageFile[], dest: string): void {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const abs = join(dest, ...cleanRelPath(f.path).split('/'));
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, f.data, { mode: 0o600, flag: 'wx' });
  }
}

/** Removes a common top folder ("my-skill/SKILL.md" → "SKILL.md") when every file is inside it. */
export function stripTop(files: PackageFile[]): { top?: string; files: PackageFile[] } {
  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  if (tops.size !== 1 || files.some((f) => !f.path.includes('/'))) return { files };
  const top = [...tops][0];
  return { top, files: files.map((f) => ({ path: f.path.slice(top.length + 1), data: f.data })) };
}

/**
 * The skill folders in a package: the package itself when SKILL.md is at its top, else each folder
 * (at the top or under skills/) that holds a SKILL.md.
 */
export function skillRoots(files: PackageFile[]): { folder: string; files: PackageFile[] }[] {
  const { top, files: inner } = stripTop(files);
  if (inner.some((f) => f.path === 'SKILL.md')) return [{ folder: top ?? '', files: inner }];
  const roots = new Set<string>();
  for (const f of inner) {
    const m = /^(?:skills\/)?([^/]+)\/SKILL\.md$/.exec(f.path);
    if (m) roots.add(f.path.slice(0, -'/SKILL.md'.length));
  }
  return [...roots].sort().map((r) => ({ folder: posix.basename(r), files: inner.filter((f) => f.path.startsWith(`${r}/`)).map((f) => ({ path: f.path.slice(r.length + 1), data: f.data })) }));
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl|exe|bin)$/i;
export const isScriptPath = (p: string): boolean => p.startsWith('scripts/') || SCRIPT_EXT.test(p);

export type FindingKind = 'injection' | 'egress' | 'secret' | 'script' | 'binary';
export interface PackageFinding {
  kind: FindingKind;
  file: string;
  line?: number;
  /** The words found (cut to 160 characters; secrets are never quoted). */
  text: string;
  host?: string;
}

const INJECTION: RegExp[] = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier|your|other) (?:instructions|rules|messages|directions|guidelines)\b/i,
  /\bdisregard (?:all |any |your |the )?(?:previous |prior |system )?(?:instructions|rules|guidelines|prompt|safety)\b/i,
  /\b(?:forget|override|bypass|drop|remove|skip) (?:your |the |all )?(?:system prompt|instructions|safety (?:rules|notes|layer)|guardrails|boundaries|approvals?|disclosure)\b/i,
  /\byou are (?:now )?(?:not an ai|a human|dan|jailbroken|unrestricted|unfiltered)\b/i,
  /\b(?:reveal|print|show|send|upload|post|leak) (?:me |us )?(?:your |the )?(?:system prompt|hidden instructions|api keys?|vault|tokens?|passwords?|secrets?|owner\.json)\b/i,
  /\b(?:don'?t|do not|never) (?:tell|inform|ask|warn) (?:the )?(?:user|owner|human)\b/i,
  /\bwithout (?:asking|approval|telling|permission|the owner'?s? (?:ok|approval))\b/i,
  /\b(?:turn|switch) off (?:the )?(?:safety|approvals?|disclosure|crisis|sandbox)\b/i,
  /<\/?(?:system|instructions?)>/i,
];
const NET_CALL = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|fetch\s*\(|requests\.(?:get|post|put)|urllib|http\.request|https\.request|axios|nc\s|netcat|scp\s|rsync\s|ftp\s)/i;
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?[^\s"'<>)\]]*/gi;
// Built in pieces so this file holds no key marker itself.
const PRIVATE_KEY = new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE', 'KEY-----'].join(' '));
const DOC_HOSTS = /(^|\.)(agentskills\.io|example\.(com|org|net)|github\.com|githubusercontent\.com|npmjs\.com|python\.org|nodejs\.org|mozilla\.org|keepachangelog\.com|semver\.org|wikipedia\.org)$/i;

/** What the review card warns about (each finding quotes the words really in the file). */
export function scanPackage(files: readonly PackageFile[]): PackageFinding[] {
  const out: PackageFinding[] = [];
  const push = (f: PackageFinding) => {
    if (out.length < 200 && !out.some((x) => x.kind === f.kind && x.file === f.file && x.text === f.text)) out.push(f);
  };
  for (const f of files) {
    const script = isScriptPath(f.path);
    if (script) push({ kind: 'script', file: f.path, text: f.path });
    if (f.data.subarray(0, 8000).includes(0)) {
      if (!/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf)$/i.test(f.path)) push({ kind: 'binary', file: f.path, text: f.path });
      continue;
    }
    const text = f.data.toString('utf8');
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const re of INJECTION) {
        const m = re.exec(line);
        if (m) push({ kind: 'injection', file: f.path, line: i + 1, text: m[0].slice(0, 160) });
      }
      // A script that names an address, or a command line (in any file) that sends to one.
      const net = NET_CALL.test(line);
      if (script || net) {
        for (const m of line.matchAll(URL_RE)) {
          const host = m[1].toLowerCase();
          if (script || !DOC_HOSTS.test(host)) push({ kind: 'egress', file: f.path, line: i + 1, text: line.trim().slice(0, 160), host });
        }
      }
      if (PRIVATE_KEY.test(line) || KEY_SHAPED.some((re) => re.test(line))) push({ kind: 'secret', file: f.path, line: i + 1, text: '' });
    });
  }
  return out;
}

/** Only https git URLs without a user name or password in them. */
export function checkGitUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new PackageError("That isn't a web address.");
  }
  if (u.protocol !== 'https:') throw new PackageError('Only https:// git addresses can be added.');
  if (u.username || u.password) throw new PackageError("Leave the user name and password out of the address.");
  if (!u.hostname || u.hostname.startsWith('-') || u.href.length > 500) throw new PackageError("That isn't a git address.");
  return u;
}

/**
 * Clones a git repository (latest commit only) into a scratch folder and returns its files.
 * Refused in private local mode before anything connects. The scratch folder is always removed.
 */
export async function fromGit(url: string, scratchRoot: string, lim: PackageLimits = SKILL_LIMITS, timeoutMs = 60_000): Promise<PackageFile[]> {
  const u = checkGitUrl(url);
  checkOutbound(u, 'git clone');
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(scratchRoot, 'git-'));
  const dest = join(tmp, 'repo');
  try {
    const args = [...GIT_SAFE, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'core.symlinks=false', 'clone', '--depth', '1', '--single-branch', '--no-recurse-submodules', '--no-tags', '-q', '--', u.href, dest];
    await new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd: tmp, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: { PATH: commandPath(), HOME: tmp, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) } }, (err, _out, stderr) => {
        if (err) reject(new PackageError(`git couldn't fetch it: ${String(stderr || err.message).trim().split('\n').at(-1)?.slice(0, 200)}`));
        else resolve();
      });
    });
    return fromFolder(dest, lim, { skipLinks: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}
