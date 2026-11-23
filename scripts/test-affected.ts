// X3: run only the tests a change can reach, for quick turns while working. NOT the gate: a commit
// still needs the full `npm run check` (docs/ops/DEVELOPMENT.md). No CI, no watcher: run by hand.
//
//   node scripts/test-affected.ts                 tests reached by what differs from main (and uncommitted work)
//   node scripts/test-affected.ts --base HEAD~3   ... from another starting point
//   node scripts/test-affected.ts --list          only print the test files
//   node scripts/test-affected.ts src/backup.ts   ... reached by these files
//
// A test is "reached" when it imports a changed file (directly, or through one file that is not a
// hub), or reads it as text (the many tests that check web/ and src/ source: they name the file in a string).
// A changed test file is always run. A change outside src/, web/, test/ and scripts/ (a package
// file, a persona, a template) cannot be traced, so everything runs.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (st?.isDirectory()) walk(full, out);
    else if (st?.isFile() && /\.(ts|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const IMPORT = /(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/** The files this one imports (static and import()), as repo-relative paths. */
export function importsOf(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    const target = resolve(dirname(file), (m[1] ?? m[2])!);
    if (existsSync(target)) out.push(rel(target));
  }
  return out;
}

/** Repo files named in the text as strings ('web/app.js', "src/chat.ts", join(ROOT, 'web', 'style.css')). */
export function namedFiles(text: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/['"`]((?:src|web|scripts|docs|desktop|deploy)\/[\w./@-]+)['"`]/g)) if (known.has(m[1]!)) out.add(m[1]!);
  for (const m of text.matchAll(/'(src|web|scripts|docs|desktop|deploy)'((?:\s*,\s*'[\w.@-]+')+)/g)) {
    const p = [m[1]!, ...[...m[2]!.matchAll(/'([\w.@-]+)'/g)].map((x) => x[1]!)].join('/');
    if (known.has(p)) out.add(p);
  }
  return [...out];
}

/** A file that more than this many others use is a hub. */
export const HUB = 40;

export function affectedTests(changed: string[], opts: { root?: string; depth?: number } = {}): { tests: string[]; all: boolean; why: Map<string, string> } {
  const root = opts.root ?? ROOT;
  const files = ['src', 'web', 'scripts', 'test'].filter((d) => existsSync(join(root, d))).flatMap((d) => walk(join(root, d)));
  const known = new Set(files.map(rel));
  const tests = files.map(rel).filter((f) => /^test\/.*\.(test|serial)\.ts$/.test(f));
  const why = new Map<string, string>();
  const untraceable = changed.find((c) => !/^(src|web|scripts|test|docs)\//.test(c) && !/^(CHANGELOG|README[\w.-]*|AGENTS[\w.]*)\.md$/.test(c));
  if (untraceable) return { tests, all: true, why: new Map(tests.map((t) => [t, `${untraceable} can't be traced`])) };
  // file -> the files that import it or read it as text
  const users = new Map<string, Set<string>>();
  const use = (target: string, by: string) => (users.get(target) ?? users.set(target, new Set()).get(target)!).add(by);
  for (const full of files) {
    const text = readFileSync(full, 'utf8');
    const me = rel(full);
    for (const t of importsOf(full, text)) use(t, me);
    if (me.startsWith('test/') || me.startsWith('scripts/')) for (const t of namedFiles(text, known)) use(t, me);
  }
  // Nearly every file reaches nearly every test through the hubs (chat.ts, server.ts, the test
  // helpers), so following every import would always pick ~700 files. A change is followed two
  // imports out and never through a hub (a file that more than HUB others use): the tests that
  // name the changed file or its close users. The full gate covers the rest.
  const depthMax = opts.depth ?? 2;
  const hub = (f: string) => (users.get(f)?.size ?? 0) > HUB;
  const reached = new Set<string>();
  const from = new Map<string, string>();
  let frontier = changed.filter((c) => known.has(c) || existsSync(join(root, c)));
  for (const c of frontier) from.set(c, c);
  for (let depth = 0; depth <= depthMax && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      if (reached.has(f)) continue;
      reached.add(f);
      // A changed hub still counts for its direct users; nothing is followed through one further out.
      if (depth > 0 && hub(f)) continue;
      for (const u of users.get(f) ?? []) {
        if (!from.has(u)) from.set(u, from.get(f)!);
        next.push(u);
      }
    }
    frontier = next;
  }
  const hit = tests.filter((t) => reached.has(t));
  for (const t of hit) why.set(t, from.get(t) ?? t);
  return { tests: hit, all: false, why };
}

function changedFromGit(base: string): string[] {
  const run = (args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const mergeBase = run(['merge-base', base, 'HEAD'])[0] ?? base;
  return [...new Set([...run(['diff', '--name-only', mergeBase, 'HEAD']), ...run(['diff', '--name-only']), ...run(['diff', '--name-only', '--cached']), ...run(['ls-files', '--others', '--exclude-standard'])])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const baseAt = args.indexOf('--base');
  const base = baseAt >= 0 ? args[baseAt + 1]! : 'main';
  const named = args.filter((a, i) => !a.startsWith('--') && (baseAt < 0 || i !== baseAt + 1)).map((a) => rel(resolve(a)));
  const changed = named.length ? named : changedFromGit(base);
  const { tests, all } = affectedTests(changed);
  console.log(`${changed.length} changed file(s) reach ${tests.length} test file(s)${all ? ' (everything: a changed file could not be traced)' : ''}.`);
  if (list || !tests.length) {
    for (const t of tests) console.log(t);
    process.exit(0);
  }
  const serial = tests.filter((t) => t.endsWith('.serial.ts'));
  const parallel = tests.filter((t) => !t.endsWith('.serial.ts'));
  let code = 0;
  if (parallel.length) code ||= spawnSync(process.execPath, ['--test', '--test-reporter=dot', '--test-concurrency=4', ...parallel], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
  if (serial.length) code ||= spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...serial], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
  console.log(code ? '\nSome affected tests failed.' : '\nAffected tests passed. The full gate (npm run check) still decides a commit.');
  process.exit(code);
}
