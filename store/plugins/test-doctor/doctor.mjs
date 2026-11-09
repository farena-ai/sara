// doctor.mjs: Test Doctor. Plans one exactly named test of a staged project (hash-bound), asks
// Sara to run it once in a disposable copy (an owner-approved job), and reads the real TAP result:
// the failing assertion (operator, expected, actual), its line, and the source the assertion calls.
// A timeout, an expected failure (todo) or a non-assertion error is never given a root cause.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { runJob } from './sara-job.mjs';
import { blocksFor, copyFrame } from './tap.mjs';
import labels from './labels.json' with { type: 'json' };

const ROOT = 'projects';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const L = (lang) => labels[lang] ?? labels.en;

const fail = (msg) => {
  throw new Error(msg);
};

function relOk(p) {
  return typeof p === 'string' && p.length <= 200 && !/[\0\r\n\\:*?"<>|]/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..' && !/[ .]$/.test(s));
}

/** Every regular file of the staged project with its hash (links and .git refuse). */
export function treeOf(dir) {
  const files = {};
  let n = 0;
  let bytes = 0;
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) fail(`The staged project contains a link (${r}); stage plain files only.`);
      if (e.name === '.git' || e.name === 'node_modules' || r.startsWith('.sara-')) continue;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        if (++n > MAX_FILES || (bytes += st.size) > MAX_BYTES) fail('The staged project is too large (2,000 files / 20 MB).');
        files[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return files;
}

function readArgs(args, home) {
  const project = String(args.project ?? '');
  if (!NAME.test(project)) fail('project must be a staged project name (lower-case letters, digits, hyphens).');
  const file = String(args.file ?? '');
  if (!relOk(file) || !/\.(mjs|cjs|js|ts|mts)$/.test(file)) fail('file must be a relative path to a test file in the project.');
  const test = String(args.test ?? '');
  if (!test || test.length > 200 || /[\0\r\n]/.test(test)) fail('test must be the exact name of one test (one line, up to 200 characters).');
  const timeoutS = args.timeoutS === undefined ? 60 : args.timeoutS;
  if (!Number.isInteger(timeoutS) || timeoutS < 5 || timeoutS > 300) fail('timeoutS must be a whole number from 5 to 300.');
  const dir = join(home, ROOT, project);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) fail(`There is no staged project "${project}".`);
  return { project, file, test, timeoutS, dir };
}

// The exact command line Sara shows on the approval card (same quoting).
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function planOf(args, home = '.') {
  const a = readArgs(args, home);
  const tree = treeOf(a.dir);
  if (!tree[a.file]) fail(`The project has no file ${a.file}.`);
  const job = { program: 'node', args: ['--test', '--test-reporter=tap', '--test-isolation=none', `--test-name-pattern=^${esc(a.test)}$`, a.file], from: `${ROOT}/${a.project}`, timeoutS: a.timeoutS, maxOutputKB: 128 };
  const planSha = createHash('sha256').update(JSON.stringify({ v: 1, project: a.project, file: a.file, test: a.test, job, tree })).digest('hex');
  return { ...a, tree, job, planSha };
}

/** The named imports of a test file: local name → { from, imported }. */
function importsOf(text) {
  const out = new Map();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of m[1].split(',')) {
      const [imported, local] = part.trim().split(/\s+as\s+/);
      if (imported) out.set((local ?? imported).trim(), { from: m[2], imported: imported.trim() });
    }
  }
  return out;
}

function definitionOf(dir, fromFile, spec, name) {
  if (!spec.startsWith('.')) return null;
  const rel = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  if (!relOk(rel)) return null;
  const abs = join(dir, ...rel.split('/'));
  if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) return null;
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const re = new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function\\*?\\s+${esc(name)}\\b|(?:const|let|var)\\s+${esc(name)}\\b|class\\s+${esc(name)}\\b)`);
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : { file: rel, line: i + 1, text: lines[i].trim().slice(0, 300) };
}

/** Reads the job's report for the planned test. */
export function diagnose(plan, result) {
  const base = { planSha: plan.planSha, project: plan.project, file: plan.file, test: plan.test, exitCode: result.exitCode ?? null, fence: result.fence, isolated: result.isolated === true, copyDeleted: result.deleted === true, stdoutTruncated: result.stdoutTruncated === true };
  if (result.ok === false && result.content) return { ...base, status: 'not-run', reason: String(result.content).slice(0, 300) };
  if (result.error) return { ...base, status: 'not-run', reason: String(result.error).slice(0, 300) };
  if (result.cancelled) return { ...base, status: 'stopped', rootCause: null };
  if (result.timedOut) return { ...base, status: 'timeout', rootCause: null, note: 'The whole run hit its time limit; no assertion or source is claimed.' };
  const blocks = blocksFor(result.stdout, plan.test);
  if (!blocks.length) return { ...base, status: 'not-found', rootCause: null };
  const b = blocks[0];
  if (b.directive === 'TODO') return { ...base, status: 'expected-failure', rootCause: null, note: `Marked todo${b.reason ? ` (${b.reason})` : ''}: its failure is expected and stays a failure; it is not diagnosed.` };
  if (b.directive === 'SKIP') return { ...base, status: 'skipped', rootCause: null };
  if (b.ok) return { ...base, status: 'passed', rootCause: null };
  const f = b.fields;
  if (f.failureType === 'testTimeoutFailure') return { ...base, status: 'timeout', rootCause: null, error: String(f.error ?? '').slice(0, 300), note: 'The test hit its own time limit; no assertion or source is claimed.' };
  const frames = b.stack.map(copyFrame);
  const inCopy = frames.filter(Boolean);
  const ignored = frames.length - inCopy.length;
  const at = inCopy.find((x) => x.file === plan.file) ?? null;
  if (f.code !== 'ERR_ASSERTION') return { ...base, status: 'error', rootCause: null, error: { name: String(f.name ?? 'Error'), message: String(f.error ?? '').slice(0, 500) }, at, runtimeFramesIgnored: ignored, note: 'Not an assertion failure: the first frame in the project is shown, without a root-cause claim.' };
  const text = at ? readFileSync(join(plan.dir, ...plan.file.split('/')), 'utf8').split(/\r?\n/)[at.line - 1]?.trim().slice(0, 300) ?? '' : '';
  const imports = importsOf(readFileSync(join(plan.dir, ...plan.file.split('/')), 'utf8'));
  const called = [...new Set([...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].filter((n) => imports.has(n));
  const source = called.map((n) => ({ name: n, ...(definitionOf(plan.dir, plan.file, imports.get(n).from, imports.get(n).imported) ?? { file: null, line: null, text: null }) }));
  return {
    ...base,
    status: 'assertion-failed',
    assertion: { operator: f.operator ?? null, expected: f.expected ?? null, actual: f.actual ?? null, message: String(f.error ?? '').slice(0, 500), file: at?.file ?? null, line: at?.line ?? null, text },
    source,
    runtimeFramesIgnored: ignored,
    rootCause: source.length ? 'The failing assertion calls the source listed; start there. This is the assertion\'s evidence, not a proof of the fix.' : null,
  };
}

function card(lang, r) {
  const l = L(lang);
  const lines = [l[r.status] ?? r.status];
  if (r.assertion) {
    lines.push(`${r.assertion.file}:${r.assertion.line}  ${r.assertion.text}`);
    lines.push(`${l.expected}: ${JSON.stringify(r.assertion.expected)}  ${l.actual}: ${JSON.stringify(r.assertion.actual)}`);
    for (const s of r.source.slice(0, 3)) if (s.file) lines.push(`${s.file}:${s.line}  ${s.text}`);
  }
  return { title: l.title, lines: lines.map((x) => String(x).slice(0, 200)) };
}

export async function handle(args, lang = 'en', run = runJob, home = '.') {
  const op = args.operation;
  if (op !== 'plan' && op !== 'run') fail('operation must be plan or run.');
  const plan = planOf(args, home);
  if (op === 'plan') {
    const r = { status: 'planned', planSha: plan.planSha, project: plan.project, file: plan.file, test: plan.test, command: ['node', ...plan.job.args].map(quote).join(' '), files: Object.keys(plan.tree).length };
    return { content: JSON.stringify(r), card: { title: L(lang).title, lines: [L(lang).planned] } };
  }
  if (args.planSha !== plan.planSha) fail('The plan changed (files or arguments) or the planSha is wrong. Plan again.');
  let res;
  try {
    res = await run(plan.job);
  } catch (err) {
    res = { ok: false, content: `Sara refused the job: ${String(err.message ?? err).slice(0, 300)}` };
  }
  const r = diagnose(plan, res);
  return { content: JSON.stringify(r), card: card(lang, r) };
}
