// Phase 42: make a clean public copy of the project (for the 1.0 release, when the owner decides to
// publish). It copies the tracked files, minus this owner's private notes, into a new folder with
// no git history, then scans the copy:
//   - FAIL on secrets and private machine details (keys, tokens, SSH keys, private addresses);
//   - REVIEW for names of this owner's own instance (fine to keep if the owner wants them public).
// Nothing is published or pushed; the copy is left for the owner to look at.
//   node scripts/public-export.ts [--out outputs/public-export] [--check-only] [--replace]
// --replace explicitly declares an existing checked output directory disposable.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Logical PRIVATE filtering is insufficient if a retained path aliases a private tree. */
export function assertExportSource(path: string, root = ROOT): string | undefined {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Export source must be a tracked descendant.');
  let cursor = target, present = true;
  while (true) {
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) throw new Error('Export source must not traverse a link or junction.');
      if (cursor === target ? !entry.isFile() : !entry.isDirectory()) throw new Error('Export source must be a regular file with directory ancestors.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      present = false;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return present ? target : undefined;
}

/** A checked, explicitly disposable descendant; never a prefix sibling or linked path. */
export function assertExportOutput(output: string, root = ROOT, replace = false): string {
  const target = resolve(root, output);
  const rel = relative(resolve(root, 'outputs'), target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Export requires a dedicated descendant of outputs/.');
  let cursor = target;
  while (true) {
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) throw new Error('Export output must not traverse a link or junction.');
      if (!entry.isDirectory()) throw new Error('Export output ancestors must be directories.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existsSync(target) && readdirSync(target).length && !replace) throw new Error('Existing export output is not empty. Use --replace only for an explicitly disposable export directory.');
  return target;
}

/** Private to this owner: development notes, store paperwork, this server's operations. */
export const PRIVATE = [/^AGENTS\.md$/, /^docs\/handoffs\//, /^docs\/SOURCE_OF_TRUTH\.md$/, /^docs\/ops\//, /^docs\/store\//, /^docs\/BACKLOG\.md$/, /^docs\/OWNER_CHECKS\.md$/, /^deploy\/soak\//, /^evals\/results\//, /^docs\/ROADMAP\.md$/, /^docs\/DECISIONS\.md$/,
  // The standalone website overlay uses private studio templates and operational evidence.
  // Native workflow sources, MCP recipes and their process/behavior tests remain public.
  /^scripts\/(?:build-addons-site\.ts|check-addons-site\.mjs|addons-output-path\.ts)$/,
  /^test\/addons-(?:site|mcp)\.test\.ts$/,
  /^test\/addons-discovery-parity\.test\.ts$/,
  /^test\/developer-catalog-site\.test\.ts$/,
  /^test\/ec27-addons-site\.test\.ts$/,
  // A2's per-entry inventory test reads private authoring records (docs/ops, store/addons).
  /^test\/addons-a2-inventory\.test\.ts$/,
  /^store\/addons\//,
];
/** Files published under another name: the owner's working roadmap stays private; the public one takes its name. */
export const PUBLIC_AS: Record<string, string> = { 'docs/ROADMAP.public.md': 'docs/ROADMAP.md', 'AGENTS.public.md': 'AGENTS.md' };

/** Public documentation (README, docs, any Markdown file). */
const DOCS = /(^|\/)[^/]+\.md$/;
/** Never in a public copy. (Tests may use obvious fake values; those are allowed below.) An optional
 * third entry limits a check to matching paths. */
export const FAIL: [string, RegExp, RegExp?][] = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ['xAI key', /\bxai-[A-Za-z0-9]{20,}/],
  ['Anthropic OAuth token', /\bsk-ant-oat01-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/],
  // GitHub's push protection refuses these even when they are made-up examples (2.14.0's eval had a
  // fake Stripe key): build such strings in pieces ('sk_' + 'live_…') so the file never holds one.
  ['Stripe key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['AWS access key', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack/Discord-style token', /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}/],
  ['root SSH login', /\broot@[\w.-]+\.(com|net|org)\b/],
  ['Apple sign-in key file', /\bAuthKey_(?!X{10})[A-Z0-9]{10}\.p8\b/],
  // The owner's own signing setup belongs in docs/ops/mac-signing.md (private), not public docs.
  ['private signing setup in public docs', /keychain\.pass\b|\bmac-signing\b|\.secrets\/[\w.-]+\//, DOCS],
];
/** Listed for a look before publishing. (backstagecoding.com and the farena-ai GitHub are public
 * on purpose: owner decision 2026-10-26, so they are no longer listed.) */
export const REVIEW: [string, RegExp][] = [];
/** Files allowed to contain FAIL-looking test values (documented fakes). */
const FAKE_OK = [/^test\//, /^scripts\/public-export\.ts$/, /^src\/tools\/builtin\.ts$/];

/**
 * This owner's own details (email, machines, addresses, Apple IDs, folders) are never allowed, not
 * even in tests. They are NOT written here, because this script is public: they're read from a
 * git-ignored file, `.secrets/private-patterns.json` ({"patterns":[{"kind","re","flags"?}]}), or the
 * file named by SARA_PRIVATE_PATTERNS. Anyone publishing their own copy can list theirs the same way.
 */
export function loadPrivatePatterns(file = process.env.SARA_PRIVATE_PATTERNS || join(ROOT, '.secrets', 'private-patterns.json')): [string, RegExp][] {
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, 'utf8')) as { patterns?: { kind: string; re: string; flags?: string }[] };
  return (j.patterns ?? []).map((p) => [p.kind, new RegExp(p.re, p.flags ?? '')]);
}

export interface Finding {
  file: string;
  line: number;
  kind: string;
  level: 'fail' | 'review';
  text: string;
}

export function scan(files: { path: string; text: string }[], never: [string, RegExp][] = []): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((l, i) => {
      const fakeOk = FAKE_OK.some((ok) => ok.test(f.path));
      for (const [kind, re, only] of FAIL) if ((!only || only.test(f.path)) && re.test(l) && !fakeOk) out.push({ file: f.path, line: i + 1, kind, level: 'fail', text: l.trim().slice(0, 120) });
      // Private details: everywhere, tests included; the text is not echoed.
      for (const [kind, re] of never) if (re.test(l)) out.push({ file: f.path, line: i + 1, kind, level: 'fail', text: '(private value hidden)' });
      for (const [kind, re] of REVIEW) if (re.test(l)) out.push({ file: f.path, line: i + 1, kind, level: 'review', text: l.trim().slice(0, 120) });
    });
  }
  return out;
}

const isText = (p: string) => !/\.(png|jpe?g|gif|webp|ico|mp3|wav|jar|jks|keystore|zip|gz|bz2|pdf|ttf|woff2?)$/i.test(p);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({ options: { out: { type: 'string', default: join('outputs', 'public-export') }, 'check-only': { type: 'boolean', default: false }, replace: { type: 'boolean', default: false } } });
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const keep = tracked.filter((p) => !PRIVATE.some((re) => re.test(p)));
  // Check binary entries too, and finish this preflight before scanning or deleting output.
  const sources = new Map(keep.map((p) => [p, assertExportSource(p)]));
  const files = keep.filter(isText).map((p) => ({ path: p, text: sources.get(p) ? readFileSync(sources.get(p)!, 'utf8') : '' }));
  const never = loadPrivatePatterns();
  if (!never.length) console.log('Note: no private patterns file (.secrets/private-patterns.json); only generic secrets are checked.');
  const found = scan(files, never);
  const fails = found.filter((f) => f.level === 'fail');
  const reviews = found.filter((f) => f.level === 'review');
  console.log(`${keep.length} of ${tracked.length} tracked files go public (${tracked.length - keep.length} private files left out).`);
  for (const f of fails) console.log(`FAIL   ${f.file}:${f.line} ${f.kind}: ${f.text}`);
  const byFile = new Map<string, number>();
  for (const r of reviews) byFile.set(`${r.file} (${r.kind})`, (byFile.get(`${r.file} (${r.kind})`) ?? 0) + 1);
  if (byFile.size) console.log(`REVIEW (fine to keep if you want them public):\n${[...byFile].map(([k, n]) => `  ${k}: ${n}`).join('\n')}`);
  if (!opt['check-only'] && !fails.length) {
    const out = assertExportOutput(opt.out!, ROOT, opt.replace);
    rmSync(out, { recursive: true, force: true });
    for (const p of keep) {
      // A tracked file deleted in this checkout (not committed yet) is not part of the copy.
      const source = assertExportSource(p);
      if (!source) continue;
      const to = PUBLIC_AS[p] ?? p;
      mkdirSync(dirname(join(out, to)), { recursive: true });
      cpSync(source, join(out, to));
    }
    console.log(`Copied to ${out} (no git history). Look it over, then make a fresh repository from it.`);
  }
  console.log(fails.length ? `\n${fails.length} problem(s): fix them before publishing.` : '\nNo secrets or private machine details found.');
  process.exit(fails.length ? 1 : 0);
}
