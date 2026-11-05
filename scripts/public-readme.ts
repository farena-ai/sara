// The presentation publisher can change only these existing public entry points.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPrivatePatterns, scan } from './public-export.ts';

export const PUBLIC_READMES = ['README.md', 'README.es.md', 'README.fr.md', 'README.de.md', 'README.pt-BR.md', 'README.it.md'] as const;
const allowed = new Set<string>(PUBLIC_READMES);
const git = (repo: string, args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Check before removing/recreating a clone: an outputs junction must never redirect writes. */
export function assertReadmeOutput(root: string): void {
  for (const path of [join(root, 'outputs'), join(root, 'outputs', 'public-repo')]) {
    if (!existsSync(path)) {
      // lstat also detects dangling symlinks, which existsSync intentionally ignores.
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('README outputs must be real directories, never symlinks or junctions.');
  }
}

function regularFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('README inputs and public targets must be regular files, never symlinks.');
  return readFileSync(path);
}

function readmeEntries(repo: string, args: string[], index = false): void {
  const entries = git(repo, args).split('\0').filter(Boolean);
  const format = index ? /^100(?:644|755) [a-f0-9]+ 0\t(.+)$/ : /^100(?:644|755) blob [a-f0-9]+\t(.+)$/;
  const paths = entries.map((entry) => format.exec(entry)?.[1]);
  if (entries.length !== PUBLIC_READMES.length || paths.some((path) => !path || !allowed.has(path)) || new Set(paths).size !== PUBLIC_READMES.length) {
    throw new Error('All six README files must already be tracked regular files in the source and public base.');
  }
}

function scanReadmes(root: string, files: { path: string; text: string }[]): void {
  const found = scan(files, loadPrivatePatterns(process.env.SARA_PRIVATE_PATTERNS || join(root, '.secrets', 'private-patterns.json'))).filter((finding) => finding.level === 'fail');
  // Report only location/kind; never repeat the rejected secret or private value.
  if (found.length) throw new Error(`README privacy scan failed: ${found.map((finding) => `${finding.file}:${finding.line} ${finding.kind}`).join('; ')}`);
}

/** Validate the complete selection before any destination is written, then stage only that selection. */
export function stagePublicReadmes(root: string, repo: string): void {
  if (git(repo, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('README public base must be clean.');
  readmeEntries(root, ['ls-files', '--stage', '-z', '--', ...PUBLIC_READMES], true);
  readmeEntries(repo, ['ls-tree', '-z', 'HEAD', '--', ...PUBLIC_READMES]);
  const files = PUBLIC_READMES.map((path) => {
    const bytes = regularFile(join(root, path));
    regularFile(join(repo, path));
    if (!bytes.toString('utf8').trim()) throw new Error(`README input is empty: ${path}`);
    return { path, bytes, text: bytes.toString('utf8') };
  });
  scanReadmes(root, files);
  for (const file of files) writeFileSync(join(repo, file.path), file.bytes);
  git(repo, ['add', '--', ...PUBLIC_READMES]);
  assertReadmeChanges(root, repo, ['diff', '--cached', '--name-only', '--no-renames', '-z']);
}

/** Recheck after commit as well: Git hooks must not broaden a presentation update. */
export function assertReadmeChanges(root: string, repo: string, args: string[], commit?: string): void {
  readmeEntries(repo, ['ls-files', '--stage', '-z', '--', ...PUBLIC_READMES], true);
  if (commit) readmeEntries(repo, ['ls-tree', '-z', commit, '--', ...PUBLIC_READMES]);
  // Scan actual staged/committed blobs too: filters and hooks may transform worktree text.
  scanReadmes(root, PUBLIC_READMES.map((path) => ({ path, text: execFileSync('git', ['show', `${commit ?? ''}:${path}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) })));
  const changed = git(repo, args).split('\0').filter(Boolean);
  if (!changed.length) throw new Error('Nothing changed in the public README files.');
  if (changed.some((path) => !allowed.has(path))) throw new Error('README-only scope violated: a non-README path changed.');
}

/** Tags and other branches remain byte-for-byte refs, with only main allowed to advance. */
export function readmeProtectedRefs(repo: string): string {
  return git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter((line) => !line.startsWith('refs/heads/main ')).join('\n');
}
