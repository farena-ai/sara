// lab.mjs: Flaky Test Lab. Repeats one exactly named test of a staged project up to 20 times in
// ONE owner-approved job (a disposable copy), each repetition a fresh import of the test file with
// its seed in globalThis.SARA_FLAKY_SEED, and keeps every run's outcome and duration. A mix of
// passes and failures is "flaky" (with a 95% interval for the failure rate); always-pass and
// always-fail are not; a stopped or timed-out run makes no verdict.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJob } from './sara-job.mjs';
import { blocksFor } from './tap.mjs';
import labels from './labels.json' with { type: 'json' };

const ROOT = 'projects';
const RUNNER = '.sara-flaky/runner.test.mjs';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const L = (lang) => labels[lang] ?? labels.en;
const fail = (msg) => {
  throw new Error(msg);
};
const relOk = (p) => typeof p === 'string' && p.length <= 200 && !/[\0\r\n\\:*?"<>|'`$]/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..' && !/[ .]$/.test(s));
// The exact command line Sara shows on the approval card (same quoting).
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function treeOf(dir) {
  const files = {};
  let n = 0;
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) fail(`The staged project contains a link (${r}); stage plain files only.`);
      if (e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.sara-')) continue;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        if (++n > 2000) fail('The staged project is too large (2,000 files).');
        files[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return files;
}

export function planOf(args, home = '.') {
  const project = String(args.project ?? '');
  if (!NAME.test(project)) fail('project must be a staged project name (lower-case letters, digits, hyphens).');
  const file = String(args.file ?? '');
  if (!relOk(file) || !/\.(mjs|js|ts|mts)$/.test(file)) fail('file must be a relative path to an ES module test file in the project.');
  const test = String(args.test ?? '');
  if (!test || test.length > 200 || /[\0\r\n]/.test(test)) fail('test must be the exact name of one test (one line, up to 200 characters).');
  const runs = args.runs === undefined ? 10 : args.runs;
  if (!Number.isInteger(runs) || runs < 2 || runs > 20) fail('runs must be a whole number from 2 to 20.');
  const timeoutS = args.timeoutS === undefined ? 120 : args.timeoutS;
  if (!Number.isInteger(timeoutS) || timeoutS < 5 || timeoutS > 300) fail('timeoutS must be a whole number from 5 to 300.');
  const dir = join(home, ROOT, project);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) fail(`There is no staged project "${project}".`);
  const tree = treeOf(dir);
  if (!tree[file]) fail(`The project has no file ${file}.`);
  const job = { program: 'node', args: ['--test', '--test-reporter=tap', '--test-isolation=none', '--test-concurrency=1', `--test-name-pattern=^${esc(test)}$`, RUNNER], from: `${ROOT}/${project}`, timeoutS, maxOutputKB: 256 };
  const planSha = createHash('sha256').update(JSON.stringify({ v: 1, project, file, test, runs, job, tree })).digest('hex');
  return { project, file, test, runs, timeoutS, dir, tree, job, planSha };
}

/** The repetition driver written into the staged project (outside the plan hash). */
export function runnerSource(file, runs) {
  return `// Written by Flaky Test Lab: ${runs} fresh imports of ${file}, seeds 1..${runs}.\nfor (let i = 1; i <= ${runs}; i++) {\n  globalThis.SARA_FLAKY_SEED = i;\n  await import(${JSON.stringify(`../${file}`)} + '?sara-run=' + i);\n}\n`;
}

/** 95% Wilson interval for k failures in n runs. */
export function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const r = (x) => Math.round(x * 1000) / 1000;
  return [r(Math.max(0, (c - m) / d)), r(Math.min(1, (c + m) / d))];
}

export function verdictOf(plan, result) {
  const base = { planSha: plan.planSha, project: plan.project, file: plan.file, test: plan.test, requestedRuns: plan.runs, fence: result.fence, isolated: result.isolated === true, copyDeleted: result.deleted === true };
  if (result.ok === false && result.content) return { ...base, status: 'not-run', verdict: null, reason: String(result.content).slice(0, 300) };
  if (result.error) return { ...base, status: 'not-run', verdict: null, reason: String(result.error).slice(0, 300) };
  const blocks = blocksFor(result.stdout, plan.test).filter((b) => b.directive !== 'SKIP');
  const runs = blocks.slice(0, plan.runs).map((b, i) => ({ seed: i + 1, outcome: b.directive === 'TODO' ? 'todo' : b.ok ? 'pass' : 'fail', durationMs: typeof b.fields.duration_ms === 'number' ? b.fields.duration_ms : null, failureType: b.ok ? null : b.fields.failureType ?? null }));
  const fails = runs.filter((r) => r.outcome === 'fail').length;
  const counted = { ...base, runs, observed: runs.length, failures: fails };
  if (result.cancelled) return { ...counted, status: 'stopped', verdict: null, note: 'Stopped before all runs finished: no verdict.' };
  if (result.timedOut) return { ...counted, status: 'timeout', verdict: null, note: 'The job hit its time limit: no verdict.' };
  if (!runs.length) return { ...counted, status: 'not-found', verdict: null };
  if (runs.length < plan.runs) return { ...counted, status: 'incomplete', verdict: null, note: `Only ${runs.length} of ${plan.runs} runs reported: no verdict.` };
  const verdict = fails === 0 ? 'stable-pass' : fails === runs.length ? 'consistent-failure' : 'flaky';
  return { ...counted, status: 'done', verdict, failingSeeds: runs.filter((r) => r.outcome === 'fail').map((r) => r.seed), failureRate: Math.round((fails / runs.length) * 1000) / 1000, failureRate95: wilson(fails, runs.length) };
}

function card(lang, r) {
  const l = L(lang);
  const head = r.verdict ? l[r.verdict] : l[r.status] ?? r.status;
  const lines = [head];
  if (r.runs?.length) lines.push(`${l.failures}: ${r.failures}/${r.observed}`);
  if (r.verdict === 'flaky') lines.push(`${l.seeds}: ${r.failingSeeds.join(', ')}`);
  return { title: l.title, lines };
}

export async function handle(args, lang = 'en', run = runJob, home = '.') {
  const op = args.operation;
  if (op !== 'plan' && op !== 'run') fail('operation must be plan or run.');
  const plan = planOf(args, home);
  if (op === 'plan') {
    const r = { status: 'planned', planSha: plan.planSha, runs: plan.runs, command: ['node', ...plan.job.args].map(quote).join(' ') };
    return { content: JSON.stringify(r), card: { title: L(lang).title, lines: [L(lang).planned] } };
  }
  if (args.planSha !== plan.planSha) fail('The plan changed (files or arguments) or the planSha is wrong. Plan again.');
  mkdirSync(join(plan.dir, '.sara-flaky'), { recursive: true });
  writeFileSync(join(plan.dir, ...RUNNER.split('/')), runnerSource(plan.file, plan.runs));
  let res;
  try {
    res = await run(plan.job);
  } catch (err) {
    res = { ok: false, content: `Sara refused the job: ${String(err.message ?? err).slice(0, 300)}` };
  }
  const r = verdictOf(plan, res);
  return { content: JSON.stringify(r), card: card(lang, r) };
}
