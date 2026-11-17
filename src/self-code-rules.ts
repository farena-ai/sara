// T3 + rootapply (docs/SELF_CODE.md): the rules level 3 lives by, with no imports but Node's own.
// Kept apart from src/self-code.ts so the root helper on Linux servers (src/self-code-root.ts, run by
// root from the root-owned source checkout) can use exactly these rules without loading any module a
// code change could touch. Both files are protected paths themselves.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

/** Paths she may never change (relative to her source folder, forward slashes, any case). */
export const PROTECTED_PATHS: readonly { re: RegExp; what: string }[] = [
  { re: /^src\/(safety|safety-check)\.ts$|^src\/routes\/safety-check\.ts$|^docs\/compliance\.md$/i, what: 'the safety layer' },
  { re: /^src\/(computer-policy|tool-policy|policy-profile|net-guard|private-local|web-guard|browser-guard|loop-guard|budget|usage)\.ts$/i, what: 'hard limits' },
  { re: /^src\/(family|household|member-tools)\.ts$|^src\/routes\/(family|member-tools)\.ts$/i, what: 'kid mode and household limits' },
  { re: /^src\/(pending|device-approval|hands-desktop-consent)\.ts$/i, what: 'approvals' },
  { re: /^src\/(audit-trail|legal-hold)\.ts$|^src\/routes\/governance\.ts$/i, what: 'the audit trail' },
  { re: /^src\/(vault|secret-sources|redact|auth|webauthn)\.ts$/i, what: 'the vault and sign-in' },
  { re: /^src\/(settings|repair|self-code|self-code-runner|self-code-rules|self-code-root)\.ts$|^src\/(routes|tools)\/(repair|self-code)\.ts$/i, what: 'her permissions and this repair code' },
  { re: /^test\/([^/]*(safety|self-code|repair|audit|household-isolation|private-local|kid|family)[^/]*)\.test\.ts$/i, what: 'the tests that guard these' },
  { re: /^(deploy|packaging|desktop|android|ios|\.git|\.github|\.secrets|node_modules|data|outputs)(\/|$)|^\.env/i, what: 'install scripts, apps and outside folders' },
  { re: /^package(-lock)?\.json$/i, what: 'her dependencies' },
];

/** A path from the model, cleaned to `a/b.ts`; throws when it leaves her folder. */
export function cleanPath(p: string): string {
  const raw = String(p ?? '').replace(/\\/g, '/').trim();
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\u0000-\u001f]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('/')) throw new Error(`not inside her folder: ${raw}`);
  const n = posix.normalize(raw).replace(/^(\.\/)+/, '');
  if (n === '.' || n.startsWith('../') || n === '..' || n.split('/').includes('..')) throw new Error(`not inside her folder: ${raw}`);
  return n;
}

/** Why a path may not be changed (undefined when it may). */
export function protectedReason(path: string): string | undefined {
  let p: string;
  try {
    p = cleanPath(path);
  } catch {
    return 'something outside her source folder';
  }
  return PROTECTED_PATHS.find((x) => x.re.test(p))?.what;
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export const isTestFile = (p: string) => /^test\//i.test(p) || /\.test\.[cm]?[jt]s$/i.test(p);
const count = (s: string | null, re: RegExp) => (s ?? '').match(re)?.length ?? 0;
const ASSERTS = /\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(|\bt\.assert\b/g;
const TESTS = /(?:^|[^\w.])(?:test|it|describe)(?:\.\w+)?\s*\(/gm;
const SKIPS = /\.(?:skip|todo|only)\s*\(|\b(?:skip|todo)\s*:\s*(?:true|['"`])/g;

/** Why a change weakens the tests (a deleted test file, fewer checks or tests, skipped tests). */
export function testWeakening(changes: readonly FileChange[]): string | undefined {
  for (const c of changes) {
    if (!isTestFile(c.path) || c.before === null) continue;
    if (c.after === null) return `it deletes the test file ${c.path}`;
    if (count(c.after, ASSERTS) < count(c.before, ASSERTS)) return `it removes checks from ${c.path}`;
    if (count(c.after, TESTS) < count(c.before, TESTS)) return `it removes tests from ${c.path}`;
    if (count(c.after, SKIPS) > count(c.before, SKIPS)) return `it makes tests skip in ${c.path}`;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------
// The patch format: unified-diff style, applied by line matching (no git needed)
// ------------------------------------------------------------------------------------------------

type Op = { t: ' ' | '-' | '+'; s: string };
const lines = (s: string) => s.split('\n');

function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  if (A.length * B.length > 4_000_000) {
    for (const s of A) mid.push({ t: '-', s });
    for (const s of B) mid.push({ t: '+', s });
  } else {
    // Longest common subsequence on the changed middle.
    const n = A.length;
    const m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) (mid.push({ t: ' ', s: A[i]! }), i++, j++);
      else if (L[i + 1]![j]! >= L[i]![j + 1]!) mid.push({ t: '-', s: A[i++]! });
      else mid.push({ t: '+', s: B[j++]! });
    }
    while (i < n) mid.push({ t: '-', s: A[i++]! });
    while (j < m) mid.push({ t: '+', s: B[j++]! });
  }
  return [...a.slice(0, pre).map((s) => ({ t: ' ' as const, s })), ...mid, ...a.slice(a.length - suf).map((s) => ({ t: ' ' as const, s }))];
}

/** A readable patch for these changes (3 lines of context; new and deleted files whole). */
export function makePatch(changes: readonly FileChange[], ctx = 3): string {
  const out: string[] = [];
  for (const c of changes) {
    if (c.before === c.after) continue;
    out.push(c.before === null ? '--- /dev/null' : `--- a/${c.path}`, c.after === null ? '+++ /dev/null' : `+++ b/${c.path}`);
    const a = c.before === null ? [] : lines(c.before);
    const b = c.after === null ? [] : lines(c.after);
    if (c.before === null || c.after === null) {
      out.push(`@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`, ...a.map((s) => `-${s}`), ...b.map((s) => `+${s}`));
      continue;
    }
    const ops = diffLines(a, b);
    const changed = ops.map((o, i) => (o.t !== ' ' ? i : -1)).filter((i) => i >= 0);
    let k = 0;
    while (k < changed.length) {
      let start = Math.max(0, changed[k]! - ctx);
      let end = Math.min(ops.length, changed[k]! + ctx + 1);
      while (k + 1 < changed.length && changed[k + 1]! - ctx <= end) end = Math.min(ops.length, changed[++k]! + ctx + 1);
      k++;
      let oldStart = 1;
      let newStart = 1;
      for (let i = 0; i < start; i++) {
        if (ops[i]!.t !== '+') oldStart++;
        if (ops[i]!.t !== '-') newStart++;
      }
      const hunk = ops.slice(start, end);
      const oldLen = hunk.filter((o) => o.t !== '+').length;
      const newLen = hunk.filter((o) => o.t !== '-').length;
      out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...hunk.map((o) => `${o.t}${o.s}`));
      start = end;
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

interface Hunk {
  oldStart: number;
  ops: Op[];
}
export interface FilePatch {
  path: string;
  oldNull: boolean;
  newNull: boolean;
  hunks: Hunk[];
}

/** Reads a patch made by makePatch (hunk sizes decide where each hunk ends). */
export function parsePatch(text: string): FilePatch[] {
  const L = text.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  let i = 0;
  while (i < L.length) {
    if (!L[i]!.startsWith('--- ')) {
      i++;
      continue;
    }
    const from = L[i]!.slice(4);
    const to = (L[i + 1] ?? '').slice(4);
    i += 2;
    const path = cleanPath((to === '/dev/null' ? from : to).replace(/^[ab]\//, ''));
    const fp: FilePatch = { path, oldNull: from === '/dev/null', newNull: to === '/dev/null', hunks: [] };
    while (i < L.length && L[i]!.startsWith('@@')) {
      const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(L[i]!);
      if (!m) throw new Error('bad hunk header');
      let oldLeft = Number(m[2]);
      let newLeft = Number(m[4]);
      i++;
      const ops: Op[] = [];
      while (oldLeft > 0 || newLeft > 0) {
        const l = L[i++];
        if (l === undefined) throw new Error('the patch ends inside a hunk');
        const t = l[0] as Op['t'];
        if (t !== ' ' && t !== '-' && t !== '+') throw new Error('bad patch line');
        ops.push({ t, s: l.slice(1) });
        if (t !== '+') oldLeft--;
        if (t !== '-') newLeft--;
      }
      fp.hunks.push({ oldStart: Number(m[1]), ops });
    }
    files.push(fp);
  }
  return files;
}

function swap(fp: FilePatch): FilePatch {
  return { path: fp.path, oldNull: fp.newNull, newNull: fp.oldNull, hunks: fp.hunks.map((h) => ({ oldStart: h.oldStart, ops: h.ops.map((o) => ({ t: o.t === '-' ? '+' : o.t === '+' ? '-' : ' ', s: o.s })) })) };
}

/** One file's new content, or a conflict (null content = the file doesn't exist). */
function applyFile(content: string | null, fp: FilePatch): { ok: true; after: string | null } | { ok: false } {
  const take = (t: Op['t']) => fp.hunks.flatMap((h) => h.ops.filter((o) => o.t === t || o.t === ' ').map((o) => o.s));
  if (fp.oldNull) return content === null ? { ok: true, after: take('+').join('\n') } : { ok: false };
  if (content === null) return { ok: false };
  if (fp.newNull) return content === take('-').join('\n') ? { ok: true, after: null } : { ok: false };
  const cur = lines(content);
  let offset = 0;
  let from = 0;
  for (const h of fp.hunks) {
    let found: { pos: number; old: string[]; neu: string[]; lead: number } | undefined;
    // Exact first; then with fewer context lines at the edges (like patch's fuzz), so a release that
    // added a line next to her change still takes it. The changed lines themselves must match.
    for (let fuzz = 0; fuzz <= 3 && !found; fuzz++) {
      let a = 0;
      let b = h.ops.length;
      while (a < fuzz && a < b && h.ops[a]!.t === ' ') a++;
      while (h.ops.length - b < fuzz && b > a && h.ops[b - 1]!.t === ' ') b--;
      if (fuzz && a === 0 && b === h.ops.length) break;
      const ops = h.ops.slice(a, b);
      const old = ops.filter((o) => o.t !== '+').map((o) => o.s);
      const neu = ops.filter((o) => o.t !== '-').map((o) => o.s);
      if (!old.length && fuzz) break;
      const at = (p: number) => p >= from && p + old.length <= cur.length && old.every((s, k) => cur[p + k] === s);
      const want = h.oldStart - 1 + offset + a;
      let pos = at(want) ? want : -1;
      if (pos < 0) {
        // Shifted (lines added or removed above): the nearest place where the old lines match.
        for (let p = from; p + old.length <= cur.length; p++) if (at(p) && (pos < 0 || Math.abs(p - want) < Math.abs(pos - want))) pos = p;
      }
      if (pos >= 0) found = { pos, old, neu, lead: a };
    }
    if (!found) return { ok: false };
    cur.splice(found.pos, found.old.length, ...found.neu);
    offset = found.pos - found.lead - (h.oldStart - 1) + found.neu.length - found.old.length;
    from = found.pos + found.neu.length;
  }
  return { ok: true, after: cur.join('\n') };
}

export const readOrNull = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

/** Applies a patch to a folder: all files or none. `reverse` takes it out; `dryRun` only checks. */
export function applyPatchTo(root: string, patch: string, o: { reverse?: boolean; dryRun?: boolean } = {}): { ok: boolean; conflicts: string[]; files: FileChange[] } {
  const files: FileChange[] = [];
  const conflicts: string[] = [];
  for (const raw of parsePatch(patch)) {
    const fp = o.reverse ? swap(raw) : raw;
    const before = readOrNull(join(root, fp.path));
    const r = applyFile(before, fp);
    if (!r.ok) conflicts.push(fp.path);
    else files.push({ path: fp.path, before, after: r.after });
  }
  if (conflicts.length || o.dryRun) return { ok: !conflicts.length, conflicts, files };
  for (const f of files) {
    const p = join(root, f.path);
    if (f.after === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.after);
    }
  }
  return { ok: true, conflicts, files };
}

/** The patch is in place in this folder (taking it out would work). */
export const isApplied = (root: string, patch: string): boolean => applyPatchTo(root, patch, { reverse: true, dryRun: true }).ok;

/** The patch text for these parsed files (the hunk sizes counted again). */
export function formatPatch(files: readonly FilePatch[]): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(f.oldNull ? '--- /dev/null' : `--- a/${f.path}`, f.newNull ? '+++ /dev/null' : `+++ b/${f.path}`);
    for (const h of f.hunks) {
      const o = h.ops.filter((x) => x.t !== '+').length;
      const n = h.ops.filter((x) => x.t !== '-').length;
      out.push(`@@ -${h.oldStart},${o} +${f.oldNull ? 0 : h.oldStart},${n} @@`, ...h.ops.map((x) => `${x.t}${x.s}`));
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
