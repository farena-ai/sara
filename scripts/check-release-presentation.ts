import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const READMES = ['README.md', 'README.es.md', 'README.fr.md', 'README.de.md', 'README.pt-BR.md', 'README.it.md'];
const REPO = 'https://github.com/farena-ai/sara';
const START = '<!-- sara:recent-releases:start -->';
const END = '<!-- sara:recent-releases:end -->';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(file: string, reason: string): never {
  throw new Error(`${file}: ${reason}`);
}

function read(root: string, file: string): string {
  try {
    // Do not follow README/package symlinks into unrelated or private local files.
    if (!lstatSync(join(root, file)).isFile()) fail(file, 'cannot read regular file');
    return readFileSync(join(root, file), 'utf8');
  } catch {
    fail(file, 'cannot read regular file');
  }
}

function links(text: string): Set<string> {
  const targets = new Set<string>();
  for (const match of text.matchAll(/<a\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) targets.add(match[1] ?? match[2]!);
  for (const match of text.matchAll(/(?<!!)\[[^\]\r\n]+\]\(([^\s)]+)(?:\s+"[^"\r\n]*")?\)/g)) targets.add(match[1]!);
  return targets;
}

function visibleMarkdown(text: string): string {
  const visible = text.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^\s*\1\s*$/gm, '');
  const runs = [...visible.matchAll(/`+/g)];
  const closing = new Array<number>(runs.length);
  const next = new Map<number, number>();
  // Code spans close only on an entire run of the same length. Index once so unmatched
  // runs do not repeatedly scan the remaining README; shorter/longer runs stay literal.
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i]![0].length;
    closing[i] = next.get(length) ?? -1;
    next.set(length, i);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const close = closing[i]!;
    if (close < 0) continue;
    const start = runs[i]!.index;
    const end = runs[close]!.index + runs[close]![0].length;
    // Keep line boundaries and separation; removing spans must not manufacture syntax.
    parts.push(visible.slice(cursor, start), visible.slice(start, end).replace(/[^\r\n]/g, ' '));
    cursor = end;
    i = close;
  }
  parts.push(visible.slice(cursor));
  return parts.join('');
}

/** Structural freshness only; release claims still need review against actual release evidence. */
export function checkReleasePresentation(root: string, version?: string): void {
  let pkg: unknown;
  const packageText = read(root, 'package.json');
  try { pkg = JSON.parse(packageText); } catch { fail('package.json', 'cannot read valid JSON'); }
  const packageVersion = pkg && typeof pkg === 'object' && 'version' in pkg ? pkg.version : undefined;
  if (typeof packageVersion !== 'string' || !SEMVER.test(packageVersion)) fail('package.json', 'invalid release version');
  const release = version ?? packageVersion;
  if (!SEMVER.test(release)) fail('package.json', 'invalid release version');
  if (release !== packageVersion) fail('package.json', 'release version does not match package version');

  for (const file of READMES) {
    const text = read(root, file);
    if (!text.trim()) fail(file, 'empty README');
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start < 0 || end < 0 || start >= end || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0) {
      fail(file, 'recent-release markers must be unique and ordered');
    }

    // Ignore comments and fenced/inline examples when checking visible introductory actions.
    const visible = visibleMarkdown(text);
    const intro = visible.split(/^##[ \t]+/m, 1)[0]!;
    const statuses = [...intro.matchAll(/^>[ \t]+\*\*[^*\r\n]+:\*\*[ \t]+([^\s,]+)/gm)];
    if (statuses.length !== 1 || statuses[0]![1] !== release) fail(file, 'status version is missing, ambiguous or stale');

    const rows = visibleMarkdown(text.slice(start + START.length, end)).split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
    const firstCell = rows[2]?.split('|')[1]?.trim().replace(/^\*\*(.*)\*\*$/, '$1');
    const firstRelease = firstCell?.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (!/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(rows[1] ?? '') || firstRelease?.[1] !== release || firstRelease?.[2] !== `${REPO}/releases/tag/v${release}`) {
      fail(file, 'first release row must match the version and exact public release tag');
    }

    const actions = links(intro);
    if (!actions.has(`${REPO}/releases/latest`)) fail(file, 'introductory download action is missing');
    if (!actions.has('docs/INSTALL.md')) fail(file, 'introductory install action is missing');
    if (!actions.has(REPO)) fail(file, 'introductory public repository/star action is missing');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) fail('check-release-presentation.ts', 'expected at most one release version');
    checkReleasePresentation(resolve(dirname(fileURLToPath(import.meta.url)), '..'), args[0]);
    console.log('Release presentation: six READMEs current.');
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
