// T43 (B1): every eval that needs no model, in one run, with one page to compare releases by.
//
//   node scripts/eval-all.ts            run them all, print a table, write outputs/evals/<date>/all.md
//   node scripts/eval-all.ts --save     also write docs/results/<version>-evals.md (do this before a release)
//   node scripts/eval-all.ts --only tools,crisis
//
// Each one is its own script with its own pass mark; this only runs them one after another, keeps
// how each ended (its exit code and its last lines) and how long it took. Evals that need a real
// model (memory, consistency, the model's first move, her replies in the crisis eval) are not here:
// run those by hand with a model on this computer, and say which in the release notes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface EvalJob {
  id: string;
  what: string;
  args: string[];
  /** The line of its output that says how it went (the first match wins); else its last line. */
  line?: RegExp;
}

export const EVAL_JOBS: EvalJob[] = [
  { id: 'tools', what: 'The right tool in the list, the right model for the message (words only)', args: ['scripts/eval-tools.ts'], line: /^- \*\*Offer:\*\*.*/m },
  { id: 'crisis', what: 'The crisis lines: the word patterns on 64 messages', args: ['scripts/eval-crisis.ts'], line: /^\| In danger now.*/m },
  { id: 'memory-rank', what: 'Which notes come to mind (ranking, no model)', args: ['scripts/eval-memory.ts', '--rank'], line: /false word picks.*/ },
  { id: 'claims', what: 'Did she do what she said (the receipt check, six languages)', args: ['scripts/eval-claims.ts'], line: /heldout:\n[^\n]*\n\s+en[^\n]*/ },
  { id: 'contradict', what: 'A plan against an earlier decision', args: ['scripts/eval-contradict.ts'], line: /held-out set:.*/ },
  { id: 'learning', what: '"Make this a skill?" offers', args: ['scripts/eval-learning.ts'], line: /held-out set:.*/ },
  { id: 'security', what: 'The security pass on seeded vulnerabilities', args: ['scripts/eval-security.ts'], line: /^all\s+.*/m },
  { id: 'threat', what: 'The threat graph rules', args: ['scripts/eval-threat.ts'], line: /missed:.*/ },
  { id: 'redteam', what: 'The red-team code path (a few minutes)', args: ['scripts/eval-redteam.ts'], line: /held-out \/ [^\n]*/ },
];

export interface EvalRun {
  id: string;
  what: string;
  ok: boolean;
  seconds: number;
  line: string;
}

/** The line that says how a run went. */
export function resultLine(job: Pick<EvalJob, 'line'>, output: string): string {
  const hit = job.line?.exec(output)?.[0];
  const last = output.trim().split('\n').filter((l) => l.trim()).at(-1) ?? '';
  return (hit ?? last).replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 240);
}

export function evalPage(runs: EvalRun[], meta: { version: string; at: string }): string {
  const out = [`# Evals that need no model`, '', `Sara ${meta.version} · ${meta.at} · ${runs.filter((r) => r.ok).length} of ${runs.length} ended well`, '', '| Eval | What it checks | Ended | Its own words | Time |', '|---|---|---|---|---|'];
  for (const r of runs) out.push(`| ${r.id} | ${r.what} | ${r.ok ? 'ok' : '**FAILED**'} | ${r.line} | ${r.seconds} s |`);
  out.push('', 'Run with a model by hand, not here: `eval:memory`, `eval:consistency`, `eval:tools -- --model`, `eval:crisis -- --model`.', '');
  return out.join('\n');
}

function main(): void {
  const { values: opt } = parseArgs({ options: { save: { type: 'boolean' }, only: { type: 'string' } } });
  const only = opt.only ? new Set(opt.only.split(',').map((s) => s.trim())) : undefined;
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
  const at = new Date().toISOString();
  const runs: EvalRun[] = [];
  for (const job of EVAL_JOBS.filter((j) => !only || only.has(j.id))) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...job.args], { cwd: ROOT, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const run: EvalRun = { id: job.id, what: job.what, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 1000), line: resultLine(job, output) };
    runs.push(run);
    console.log(`${run.ok ? 'ok    ' : 'FAILED'} ${run.id.padEnd(12)} ${String(run.seconds).padStart(4)} s  ${run.line}`);
  }
  const page = evalPage(runs, { version, at });
  const dir = join(ROOT, 'outputs', 'evals', at.slice(0, 10));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'all.md'), page);
  writeFileSync(join(dir, 'all.json'), JSON.stringify({ version, at, runs }, null, 1));
  if (opt.save) writeFileSync(join(ROOT, 'docs', 'results', `${version}-evals.md`), page);
  console.log(`\n${runs.filter((r) => r.ok).length} of ${runs.length} ended well. Written to ${dir}${opt.save ? ` and docs/results/${version}-evals.md` : ''}`);
  if (runs.some((r) => !r.ok)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
