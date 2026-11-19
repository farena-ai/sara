// V1.4 Open benchmark page: the same original repository tasks (bench/tasks, bench/projects) run
// through other agent harnesses that YOU installed yourself (their CLIs, their own keys and
// settings), graded by the same hidden tests as Sara, and a static results page.
//
//   node scripts/bench-compare.ts                   every harness found on PATH (+ Sara when Ollama answers), then the page
//   node scripts/bench-compare.ts --harness aider   one harness (comma list; `sara` = Sara's own agent loop)
//   node scripts/bench-compare.ts --mode verify     no model: tasks solvable + the harness pipeline grades right
//   node scripts/bench-compare.ts --page            only rebuild docs/results/index.html (offline)
//        [--tier projects] [--only 01-cart-totals,05-date-range] [--timeout 480] [--python python]
//        [--config evals/harnesses.json] [--model <Sara's model>] [--ollama <url>] [--label-model <text>]
//
// A harness is only a command line (no other project's code lives in this repository). Presets
// cover a few common CLIs; add or override any in evals/harnesses.json:
//   [{ "id": "my-agent", "label": "My agent", "command": ["my-agent", "--task-file", "{promptFile}"],
//      "version": ["my-agent", "--version"], "model": "the model it is set to" }]
// Placeholders: {prompt} (the task text), {promptFile} (the same text in a file), {workspace},
// {node}, {python}; "stdin": true pipes the task text in. Each task runs in a fresh throwaway copy
// of its start/ folder outside this repository, with nothing sandboxed (like bench-tasks), so only
// configure CLIs you trust. Raw rows go to evals/results/<date>-compare-<tier>-<id>.json (private);
// short summaries without replies or paths to docs/results/compare-<tier>-<id>.json (public).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { killTree as killProcessTree } from '../src/hands-run.ts';
import { copyProject, listFiles, loadTasks, runHidden, taskText, TIERS, type Task } from './bench-tasks.ts';
import type { RealSummary } from './real-runs-publish.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs', 'results');
const RAW = join(ROOT, 'evals', 'results');
const TASK_FILE = '.bench-task.md';

export interface Harness {
  id: string;
  label: string;
  command: string[];
  /** Pipe the task text to the CLI's standard input. */
  stdin?: boolean;
  /** A command that prints the CLI's version (shown on the page). */
  version?: string[];
  /** The model the CLI is set to, when you know it (else "the CLI's own default"). */
  model?: string;
  note?: string;
  /** Built-in pipeline checks only: may use {solution}. */
  internal?: boolean;
}

/** Common agent CLIs, as plain command lines. Flags follow each CLI's documented non-interactive
 *  mode; check them against `--help` of the version you have and override in evals/harnesses.json. */
export const PRESETS: Harness[] = [
  { id: 'claude-code', label: 'Claude Code', command: ['claude', '-p', '--dangerously-skip-permissions'], stdin: true, version: ['claude', '--version'], note: 'Headless print mode; edits and test runs are allowed without asking (the folder is a throwaway copy).' },
  { id: 'codex', label: 'Codex CLI', command: ['codex', 'exec', '--full-auto', '--skip-git-repo-check', '-'], stdin: true, version: ['codex', '--version'], note: 'Non-interactive exec mode, task text on standard input.' },
  { id: 'aider', label: 'Aider', command: ['aider', '--yes-always', '--no-git', '--no-auto-commits', '--message-file', '{promptFile}'], version: ['aider', '--version'], note: 'One message from a file, then exits.' },
];

export function validHarness(h: unknown): string | undefined {
  const x = h as Partial<Harness>;
  if (!x || typeof x !== 'object') return 'not an object';
  if (typeof x.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(x.id)) return 'id must be lower-case letters, digits and dashes';
  if (x.id === 'sara') return 'id "sara" is Sara herself';
  if (typeof x.label !== 'string' || !x.label.trim()) return `${x.id}: label missing`;
  if (!Array.isArray(x.command) || !x.command.length || x.command.some((a) => typeof a !== 'string') || !x.command[0]) return `${x.id}: command must be a non-empty list of strings`;
  if (x.version !== undefined && (!Array.isArray(x.version) || x.version.some((a) => typeof a !== 'string'))) return `${x.id}: version must be a list of strings`;
  if (x.model !== undefined && typeof x.model !== 'string') return `${x.id}: model must be text`;
  return undefined;
}

/** The presets plus your own file (same id = yours wins). Bad entries are listed, never run. */
export function loadHarnesses(file = join(ROOT, 'evals', 'harnesses.json')): { harnesses: Harness[]; problems: string[] } {
  const out = new Map(PRESETS.map((h) => [h.id, h]));
  const problems: string[] = [];
  if (existsSync(file)) {
    let list: unknown;
    try {
      list = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return { harnesses: [...out.values()], problems: [`${basename(file)}: ${(err as Error).message}`] };
    }
    for (const h of Array.isArray(list) ? list : [list]) {
      const why = validHarness(h);
      if (why) problems.push(why);
      else out.set((h as Harness).id, { ...(h as Harness), internal: false });
    }
  }
  return { harnesses: [...out.values()], problems };
}

export interface Vars {
  prompt: string;
  promptFile: string;
  workspace: string;
  node: string;
  python: string;
  solution?: string;
}

export function fill(args: string[], v: Vars, internal: boolean): string[] {
  return args.map((a) => a.replace(/\{(prompt|promptFile|workspace|node|python|solution)\}/g, (_, k: keyof Vars) => (k === 'solution' && !internal ? '' : (v[k] ?? ''))));
}

/** A program on PATH (with PATHEXT on Windows), or an existing path; undefined when missing. */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const win = process.platform === 'win32';
  const exts = win ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const tryAt = (base: string) => {
    for (const e of exts) if (isFile(base + e) && (!win || e || extname(base))) return base + e;
    return undefined;
  };
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) return tryAt(resolve(cmd));
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const hit = tryAt(join(dir, cmd));
    if (hit) return hit;
  }
  return undefined;
}

export interface Row {
  task: string;
  title: string;
  kind: string;
  lang: string;
  pass: boolean;
  seconds: number;
  exit: number | null;
  filesChanged: number;
  detail?: string;
  error?: string;
}

const solutionOf = (t: Task) => join(t.root === TIERS.projects.tasks ? TIERS.projects.solutions : TIERS.tasks.solutions, t.id);

/** Ends the harness and everything it started. Windows: Sara's own killTree (taskkill /T, and its
 * own walk of the process tree when taskkill fails, as it can on a loaded PC or inside a job). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') killProcessTree(pid);
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone already */
    }
  }
}

/** Windows .cmd/.bat shims (npm CLIs) run through cmd.exe; refuse arguments cmd would change. */
function launch(file: string, args: string[]): { file: string; args: string[]; verbatim: boolean } | { error: string } {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  const bad = args.find((a) => /["%!\r\n^]/.test(a));
  if (bad !== undefined) return { error: 'this CLI is a .cmd shim: pass the task with {promptFile} or "stdin": true, not {prompt}' };
  const q = (a: string) => (/[\s&|<>()]/.test(a) || !a ? `"${a}"` : a);
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[file, ...args].map(q).join(' ')}"`], verbatim: true };
}

/** Runs one task through one harness in a throwaway copy and grades it with the hidden tests. */
export async function runHarness(h: Harness, t: Task, o: { python: string; timeoutSec: number }): Promise<Row> {
  const base = mkdtempSync(join(tmpdir(), 'sara-compare-'));
  const ws = join(base, 'project');
  const start = join(t.root ?? TIERS.tasks.tasks, t.id, 'start');
  const t0 = Date.now();
  const row = (extra: Partial<Row>): Row => ({ task: t.id, title: t.title, kind: t.kind, lang: t.lang, pass: false, seconds: Math.round((Date.now() - t0) / 1000), exit: null, filesChanged: 0, ...extra });
  try {
    copyProject(start, ws);
    const prompt = taskText(t);
    const promptFile = join(ws, TASK_FILE);
    writeFileSync(promptFile, prompt);
    const argv = fill(h.command, { prompt, promptFile, workspace: ws, node: process.execPath, python: o.python, solution: solutionOf(t) }, !!h.internal);
    const file = argv[0] === process.execPath ? process.execPath : findOnPath(argv[0]);
    if (!file) return row({ error: `${basename(argv[0])} not found on PATH` });
    const l = launch(file, argv.slice(1));
    if ('error' in l) return row({ error: l.error });
    const env: Record<string, string | undefined> = { ...process.env, SARA_BENCH: '1' };
    delete env.NODE_TEST_CONTEXT;
    let error: string | undefined;
    const exit = await new Promise<number | null>((done) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(l.file, l.args, { cwd: ws, env, windowsHide: true, windowsVerbatimArguments: l.verbatim, detached: process.platform !== 'win32', stdio: [h.stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
      } catch (err) {
        error = (err as Error).message;
        return done(null);
      }
      // The time limit ends the harness; until it has really ended, the kill is tried again every 5 s
      // (W0.4: one taskkill under the full suite's load left a hung harness running for 15 minutes).
      let again: ReturnType<typeof setInterval> | undefined;
      const timer = setTimeout(() => {
        error = `stopped after ${o.timeoutSec} s (time limit)`;
        killTree(child.pid);
        again = setInterval(() => killTree(child.pid), 5000);
      }, o.timeoutSec * 1000);
      child.on('error', (err) => {
        error ??= err.message;
      });
      child.on('exit', () => {
        if (again) clearInterval(again); // its id may be reused from here on
        again = undefined;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (again) clearInterval(again);
        done(code);
      });
      if (h.stdin && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
      }
    });
    rmSync(promptFile, { force: true });
    const changed = listFiles(ws).filter((f) => !existsSync(join(start, f)) || readFileSync(join(start, f), 'utf8') !== readFileSync(join(ws, f), 'utf8')).length;
    const seconds = Math.round((Date.now() - t0) / 1000);
    const graded = runHidden(t, ws, o.python);
    return { ...row({ exit, filesChanged: changed, seconds }), pass: graded.pass, ...(graded.pass ? {} : { detail: graded.detail }), ...(error ? { error } : {}) };
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const FAKE = join(ROOT, 'scripts', 'bench-fake-harness.ts');
const fakeHarness = (how: 'solve' | 'nothing'): Harness => ({ id: `fake-${how}`, label: `Fake harness (${how})`, internal: true, command: ['{node}', FAKE, how, '{workspace}', '{solution}', '{promptFile}'] });

/** Proves the pipeline: a harness that lays the reference solution passes, one that does nothing fails. */
export async function selfTest(o: { python: string; task: Task }): Promise<{ ok: boolean; solve: Row; nothing: Row }> {
  const solve = await runHarness(fakeHarness('solve'), o.task, { python: o.python, timeoutSec: 120 });
  const nothing = await runHarness(fakeHarness('nothing'), o.task, { python: o.python, timeoutSec: 120 });
  return { ok: solve.pass && !nothing.pass, solve, nothing };
}

export function versionOf(h: Harness): string {
  if (!h.version?.length) return '';
  const file = findOnPath(h.version[0]);
  if (!file) return '';
  const l = launch(file, h.version.slice(1));
  if ('error' in l) return '';
  const r = spawnSync(l.file, l.args, { encoding: 'utf8', timeout: 20_000, windowsHide: true, windowsVerbatimArguments: l.verbatim });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? '';
}

export interface CompareRun {
  harness: string;
  label: string;
  version: string;
  model: string;
  tier: 'tasks' | 'projects';
  command: string[];
  at: string;
  finished: string;
  platform: string;
  python: string;
  tasks: number;
  pass: number;
  pass1: number;
  seconds: number;
  runs: Row[];
}

/** Path-like words in a command or an error, cut to their last part (no user folders on a public page). */
const scrub = (s: string) => s.replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s"']+){2,}/g, (m) => `…/${basename(m.replace(/\\/g, '/'))}`);

export function rerunOf(id: string, tier: string): string {
  return `node scripts/bench-compare.ts --harness ${id}${tier === 'projects' ? ' --tier projects' : ''}`;
}

/** The public summary: scores, model, dates and the exact command; no replies, test output or paths. */
export function compareSummary(r: CompareRun, source: string) {
  return {
    harness: r.harness,
    label: r.label,
    version: scrub(r.version),
    model: r.model,
    tier: r.tier,
    benchmark: r.tier === 'projects' ? TIERS.projects.name : TIERS.tasks.name,
    command: r.command.map((a, i) => (i === 0 ? basename(a.replace(/\\/g, '/')) : scrub(a))).join(' '),
    rerun: rerunOf(r.harness, r.tier),
    started: r.at,
    finished: r.finished,
    platform: r.platform,
    python: r.python,
    tasks: r.tasks,
    passed: r.pass,
    pass1: r.pass1,
    minutes: Math.round(r.seconds / 6) / 10,
    failed: r.runs.filter((x) => !x.pass).map((x) => x.task),
    stopped: r.runs.filter((x) => x.error).map((x) => ({ task: x.task, error: scrub(x.error!) })),
    runs: r.runs.map((x) => ({ task: x.task, title: x.title, kind: x.kind, lang: x.lang, pass: x.pass, seconds: x.seconds, filesChanged: x.filesChanged })),
    source,
  };
}
export type CompareSummary = ReturnType<typeof compareSummary>;

/** A Sara summary as docs/results/tasks-*.json and projects-*.json hold it (scripts/publish-results.ts). */
export interface SaraSummary {
  benchmark: string;
  mode: string;
  model: string;
  started: string;
  python?: string;
  platform?: string;
  tasks: number;
  passed: number;
  pass1?: number;
  minutes?: number;
  runs: { task: string; title?: string; pass: boolean; seconds?: number }[];
  /** Every run in the source file (publish-results keeps them so a better run never hides a worse one). */
  everyRun?: { started: string; passed: number; of: number }[];
  source?: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** A command whose words never break inside (no line break after a flag's dashes). */
const cmdHtml = (c: string) => c.split(' ').map((w) => `<span class="nw">${esc(w)}</span>`).join(' ');
const day = (iso: string) => String(iso ?? '').slice(0, 10);
const tierOf = (s: SaraSummary) => (/projects/i.test(s.benchmark) ? 'projects' : 'tasks');

interface PageRow {
  who: string;
  how: string;
  model: string;
  tier: string;
  passed: number;
  of: number;
  minutes?: number;
  every?: string;
  date: string;
  rerun: string;
  command: string;
  version: string;
  platform: string;
  runs: Map<string, boolean>;
  titles: Map<string, string>;
}

const CSS = `
:root{--bg:#f7f5f2;--card:#fff;--text:#1d1b19;--muted:#6b645c;--line:#e4ded6;--accent:#2f6f62;--pass:#1f7a46;--fail:#b3261e;--chip:#efeae3;--code:#f1ede7}
@media (prefers-color-scheme: dark){:root{--bg:#141312;--card:#1d1c1a;--text:#ece8e2;--muted:#a69e94;--line:#34312d;--accent:#7cc4b3;--pass:#6fd19a;--fail:#ff8a80;--chip:#2a2825;--code:#262421}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1120px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 8px}
h2{font-size:1.25rem;margin:36px 0 12px}
p.lead{color:var(--muted);margin:0 0 20px;max-width:72ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px 0;overflow:hidden}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;white-space:nowrap}
td.score{font-weight:700;white-space:nowrap}
td.date,td.model{white-space:nowrap}
.sub{display:block;color:var(--muted);font-size:.85rem;font-weight:400}
code{font:.85rem/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:2px 6px;border-radius:6px;overflow-wrap:break-word}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 10px;font-size:.8rem;color:var(--muted);white-space:nowrap}
.nw{white-space:nowrap}.none{color:var(--muted)}.ok{color:var(--pass);font-weight:700}.no{color:var(--fail);font-weight:700}
.grid td,.grid th{text-align:center;white-space:nowrap}.grid th{white-space:normal;min-width:7ch}.grid td:first-child,.grid th:first-child{text-align:left;white-space:normal;min-width:14ch}.grid code{white-space:nowrap}
ul.plain{padding-left:20px;max-width:80ch}ul.plain li{margin:6px 0}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-x:auto;font:.85rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
footer{margin-top:40px;color:var(--muted);font-size:.85rem}
a{color:var(--accent)}
@media (max-width:640px){main{padding:20px 12px 48px}h1{font-size:1.5rem}th,td{padding:8px 10px}
.stack tr:first-child{display:none}
.stack tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:12px 14px;border-bottom:1px solid var(--line)}
.stack tr:last-child{border-bottom:0}
.stack td{display:block;padding:0;border:0;min-width:0}
.stack td.score{grid-column:2;grid-row:1 / span 2;text-align:right}
.stack td.model,.stack td.set,.stack td.date{grid-column:1;white-space:normal;font-size:.9rem}
.stack td.model::before{content:"Model: ";color:var(--muted)}
.stack td.date::before{content:"Date: ";color:var(--muted)}
.stack td.cmd{grid-column:1 / -1;margin-top:4px}}
`;

/** The static results page: no scripts, no outside files, light and dark. */
/** W0.1: the everyday real-model task runs (scripts/eval-real.ts summaries), newest first, task by task. */
export function realSection(real: RealSummary[]): string {
  if (!real.length) return '';
  const runs = [...real].sort((a, b) => b.started.localeCompare(a.started) || b.label.localeCompare(a.label));
  const name = (r: RealSummary) => `${day(r.started)} ${r.label}`;
  const summary = runs
    .map((r) => `<tr><td><strong>${esc(name(r))}</strong><span class="sub">Sara ${esc(r.version)}</span></td><td class="model">${esc(r.model)}<span class="sub">judge ${esc(r.judge)}</span></td><td class="score">${r.passed}/${r.of}<span class="sub">${r.of ? Math.round((r.passed / r.of) * 100) : 0}%, ${r.minutes} min</span>${r.judgeAvg !== null ? `<span class="sub">judge ${r.judgeAvg.toFixed(2)}/5</span>` : ''}</td><td class="date">${esc(day(r.started))}</td><td class="cmd"><code>${cmdHtml(r.command)}</code></td></tr>`)
    .join('\n');
  const ids: string[] = [];
  const feature = new Map<string, string>();
  for (const r of runs) for (const t of r.runs) if (!feature.has(t.task)) { ids.push(t.task); feature.set(t.task, t.feature); }
  const head = `<tr><th>Task</th>${runs.map((r) => `<th>${esc(name(r))}</th>`).join('')}</tr>`;
  const body = ids
    .map((id) => `<tr><td><code>${esc(id)}</code><span class="sub">${esc(feature.get(id) ?? '')}</span></td>${runs.map((r) => { const t = r.runs.find((x) => x.task === id); return !t ? '<td class="none" aria-label="not run">–</td>' : t.pass ? '<td class="ok" aria-label="pass">✓</td>' : `<td class="no" aria-label="fail" title="${esc(t.failed.join('; '))}">✗</td>`; }).join('')}</tr>`)
    .join('\n');
  return `<h2 id="everyday">Everyday tasks with a real local model</h2>
<p class="lead">Real chat turns on a throwaway Sara with fixture mail, calendar, web pages and a second linked server; a local model through Ollama answers every turn and uses her real tools. A task passes only when every code check passes (the tool ran, the rows and files exist, nothing private leaked); a small local judge scores it 1-5 too.</p>
<div class="card scroll"><table class="stack">
<tr><th>Run</th><th>Model</th><th>Score</th><th>Date</th><th>Re-run</th></tr>
${summary}
</table></div>
<h2>Everyday tasks: task by task</h2>
<div class="card scroll"><table class="grid">
${head}
${body}
</table></div>
`;
}

/** W2.4: the monthly re-check of free local models (src/model-recheck.ts, scripts/model-recheck.ts --publish). */
export interface RecheckSummary {
  kind: 'model-recheck';
  started: string;
  version: string;
  command: string;
  results: { model: string; job: string; passed: number; of: number; at: string; ms: number; failed: string[] }[];
}

export function recheckSection(r: RecheckSummary | undefined): string {
  if (!r) return '';
  const rows = r.results
    .map((x) => `<tr><td><strong>${esc(x.model)}</strong><span class="sub">${esc(x.job)}</span></td><td class="score">${x.passed}/${x.of}<span class="sub">${(x.ms / 1000).toFixed(1)} s${x.failed.length ? `, missed: ${esc(x.failed.join(', '))}` : ''}</span></td><td class="date">${esc(day(x.at))}</td></tr>`)
    .join('\n');
  return `<h2 id="free-models">Free and local models: the monthly re-check</h2>
<p class="lead">A small check set (follow an instruction, arithmetic, JSON, a small JavaScript function run with no file or network rights, the color of a picture, meaning search) on every model from Sara's free model list that is installed in Ollama on the test computer. Settings → Models &amp; usage → On this computer shows the same marks for your own computer. Sara ${esc(r.version)}, ${esc(day(r.started))}.</p>
<div class="card scroll"><table class="stack">
<tr><th>Model</th><th>Score</th><th>Date</th></tr>
${rows || '<tr><td>No listed model was installed.</td></tr>'}
</table></div>
<p class="lead"><code>${cmdHtml(r.command)}</code></p>
`;
}

export function buildPage(d: { sara: SaraSummary[]; others: CompareSummary[]; real?: RealSummary[]; recheck?: RecheckSummary; built: string }): string {
  const rows: PageRow[] = [];
  for (const s of d.sara) {
    const tier = tierOf(s);
    const agent = s.mode === 'agent';
    const cmd = `node scripts/bench-tasks.ts${tier === 'projects' ? ' --tier projects' : ''} --mode ${s.mode} --model ${s.model}`;
    rows.push({
      who: agent ? 'Sara' : 'Same model, no harness',
      how: agent ? 'her agent loop: reads, runs the tests, edits' : 'one reply with every file, no tools',
      model: s.model, tier, passed: s.passed, of: s.tasks, minutes: s.minutes, every: (s.everyRun?.length ?? 0) > 1 ? s.everyRun!.map((x) => `${x.passed}/${x.of}`).join(', ') : undefined, date: day(s.started), rerun: cmd, command: cmd, version: '', platform: [s.platform, s.python].filter(Boolean).join(', '),
      runs: new Map(s.runs.map((r) => [r.task, r.pass])), titles: new Map(s.runs.map((r) => [r.task, r.title ?? r.task])),
    });
  }
  for (const o of d.others) {
    rows.push({
      who: o.label, how: o.version || 'installed CLI', model: o.model, tier: o.tier, passed: o.passed, of: o.tasks, minutes: o.minutes, date: day(o.started), rerun: o.rerun, command: o.command, version: o.version, platform: [o.platform, o.python].filter(Boolean).join(', '),
      runs: new Map(o.runs.map((r) => [r.task, r.pass])), titles: new Map(o.runs.map((r) => [r.task, r.title])),
    });
  }
  const order = (r: PageRow) => (r.tier === 'tasks' ? 0 : 1);
  rows.sort((a, b) => order(a) - order(b) || b.passed / Math.max(1, b.of) - a.passed / Math.max(1, a.of) || a.who.localeCompare(b.who));
  const tierName = (t: string) => (t === 'projects' ? 'Real-size projects' : 'Repository tasks');
  const modelCell = (m: string) => (m ? esc(m) : '<span class="sub">the CLI\'s own default</span>');
  const summary = rows
    .map((r) => `<tr><td><strong>${esc(r.who)}</strong><span class="sub">${esc(r.how)}</span></td><td class="model">${modelCell(r.model)}</td><td class="set"><span class="chip">${tierName(r.tier)}</span></td><td class="score">${r.passed}/${r.of}<span class="sub">${r.of ? Math.round((r.passed / r.of) * 100) : 0}%${r.minutes !== undefined ? `, ${r.minutes} min` : ''}</span>${r.every ? `<span class="sub">every run: ${esc(r.every)}</span>` : ''}</td><td class="date">${esc(r.date)}</td><td class="cmd"><code>${cmdHtml(r.rerun)}</code></td></tr>`)
    .join('\n');
  const grids = ['tasks', 'projects']
    .map((tier) => {
      const rs = rows.filter((r) => r.tier === tier);
      if (!rs.length) return '';
      const ids = [...new Set(rs.flatMap((r) => [...r.runs.keys()]))].sort();
      const title = (id: string) => rs.map((r) => r.titles.get(id)).find(Boolean) ?? id;
      const head = `<tr><th>Task</th>${rs.map((r) => `<th>${esc(r.who)}</th>`).join('')}</tr>`;
      const body = ids.map((id) => `<tr><td><code>${esc(id)}</code><span class="sub">${esc(title(id))}</span></td>${rs.map((r) => (r.runs.has(id) ? (r.runs.get(id) ? '<td class="ok" aria-label="pass">✓</td>' : '<td class="no" aria-label="fail">✗</td>') : '<td class="none" aria-label="not run">–</td>')).join('')}</tr>`).join('\n');
      return `<h2>${tierName(tier)}: task by task</h2>\n<div class="card scroll"><table class="grid">\n${head}\n${body}\n</table></div>`;
    })
    .join('\n');
  const commands = rows
    .map((r) => `<tr><td><strong>${esc(r.who)}</strong><span class="sub">${tierName(r.tier)}, ${esc(r.date)}</span></td><td class="cmd"><code>${cmdHtml(r.command)}</code>${r.platform ? `<span class="sub">${esc(r.platform)}</span>` : ''}</td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sara benchmark: original repository tasks</title>
<style>${CSS}</style>
</head>
<body data-built="${esc(d.built)}">
<main>
<h1>Sara benchmark: original repository tasks</h1>
<p class="lead">Small and real-size coding projects written for Sara (a bug spread over modules, a feature from a spec, a refactor that must keep behavior), in JavaScript and Python. Every harness gets the same request in a fresh copy of the project and is graded by the same hidden tests it never sees.</p>
<div class="card scroll"><table class="stack">
<tr><th>Harness</th><th>Model</th><th>Set</th><th>Score</th><th>Date</th><th>Re-run</th></tr>
${summary}
</table></div>
${grids}
<h2>Exact commands</h2>
<div class="card scroll"><table class="stack">
<tr><th>Run</th><th>Command</th></tr>
${commands}
</table></div>
${realSection(d.real ?? [])}${recheckSection(d.recheck)}<h2>How it is run</h2>
<ul class="plain">
<li>Tasks: <code>bench/tasks</code> and <code>bench/projects</code>, original to this repository. Reference solutions exist only to prove each task is solvable and that its hidden tests fail on the starting code (<code>node scripts/bench-compare.ts --mode verify</code>).</li>
<li>Other harnesses are the CLIs their users installed, with their own keys and settings; this repository holds only the command line used to call them, never their code. A harness's model is shown when its owner said which one it uses.</li>
<li>Each task runs once (pass@1) in a throwaway folder outside the repository, with the same time limit for everyone; whatever is left when the time is up is what gets graded.</li>
<li>Sara's rows use a local model through her normal agent loop; the "no harness" row is the same model answering once with every file, to show what the loop adds.</li>
<li>Never a better run hiding a worse one: the score is the newest full run, "every run" lists all runs of that day, and all of them are kept in <code>docs/results/*.json</code> (what changed between runs: docs/RESULTS.md).</li>
</ul>
<h2>Run it yourself</h2>
<pre>node scripts/bench-compare.ts --mode verify     # no model: checks tasks and the grading pipeline
node scripts/bench-compare.ts                   # every harness found on this computer, then this page
node scripts/bench-compare.ts --harness aider   # one harness (add your own in evals/harnesses.json)
node scripts/bench-compare.ts --page            # rebuild this page from docs/results (offline)</pre>
<footer>Built ${esc(d.built)} from docs/results by <code>scripts/bench-compare.ts</code>. Works offline: one file, no scripts.</footer>
</main>
</body>
</html>
`;
}

const readJson = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;

/** The page from the summaries in docs/results (Sara's tasks/projects rows + every compare-*.json). */
export function pageFromDocs(built: string, dir = DOCS): string {
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  const sara = files.filter((f) => /^(tasks|projects)-(agent|raw)\.json$/.test(f)).map((f) => readJson<SaraSummary>(join(dir, f)));
  const others = files.filter((f) => /^compare-(tasks|projects)-[a-z0-9-]+\.json$/.test(f)).map((f) => readJson<CompareSummary>(join(dir, f)));
  const real = files.filter((f) => /^real-runs-[a-z0-9-]+\.json$/.test(f)).map((f) => readJson<RealSummary>(join(dir, f)));
  const recheck = files.includes('model-recheck.json') ? readJson<RecheckSummary>(join(dir, 'model-recheck.json')) : undefined;
  return buildPage({ sara, others, real, ...(recheck ? { recheck } : {}), built });
}

export function writePage(built = new Date().toISOString().slice(0, 10)): string {
  const out = join(DOCS, 'index.html');
  mkdirSync(DOCS, { recursive: true });
  writeFileSync(out, pageFromDocs(built));
  return out;
}

async function ollamaUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/v1\/?$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({
    options: {
      mode: { type: 'string', default: 'run' },
      harness: { type: 'string', default: '' },
      tier: { type: 'string', default: 'tasks' },
      only: { type: 'string', default: '' },
      timeout: { type: 'string', default: '' },
      python: { type: 'string', default: process.platform === 'win32' ? 'python' : 'python3' },
      config: { type: 'string', default: join(ROOT, 'evals', 'harnesses.json') },
      model: { type: 'string', default: 'qwen3.8:27b-mtp-q4_K_M' },
      ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' },
      'label-model': { type: 'string', default: '' },
      page: { type: 'boolean', default: false },
    },
  });
  const tierKey = opt.tier === 'projects' ? 'projects' : 'tasks';
  const tier = TIERS[tierKey];
  const timeoutSec = Number(opt.timeout || tier.timeout);
  const only = opt.only ? new Set(opt.only.split(',')) : undefined;
  const tasks = loadTasks(tier.tasks).filter((t) => !only || only.has(t.id));
  const { harnesses, problems } = loadHarnesses(opt.config);
  for (const p of problems) console.log(`Skipped a harness in ${basename(opt.config!)}: ${p}`);

  if (opt.page) {
    console.log(`Page: ${writePage()}`);
    process.exit(0);
  }

  const py = spawnSync(opt.python!, ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) throw new Error(`Python not found as "${opt.python}" (use --python).`);
  const pythonVersion = `${py.stdout}${py.stderr}`.trim();

  if (opt.mode === 'verify') {
    // 1. Every task fails on its starting code and passes on the reference solution.
    const v = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bench-tasks.ts'), '--mode', 'verify', '--tier', tierKey, '--python', opt.python!, ...(opt.only ? ['--only', opt.only] : [])], { stdio: 'inherit', windowsHide: true });
    // 2. The harness pipeline grades right: a fake harness that solves passes, one that does nothing fails.
    const s = await selfTest({ python: opt.python!, task: tasks.find((t) => t.lang === 'js') ?? tasks[0] });
    console.log(`\nHarness pipeline: fake harness that solves → ${s.solve.pass ? 'pass' : 'FAIL'}; fake harness that does nothing → ${s.nothing.pass ? 'PASS (should fail)' : 'fail'}.`);
    // 3. Which harnesses this computer has (nothing is run).
    for (const h of harnesses) {
      const at = findOnPath(h.command[0]);
      console.log(`${at ? 'found  ' : 'missing'} ${h.id.padEnd(14)} ${h.label}${at ? ` (${versionOf(h) || 'version unknown'})` : ''}`);
    }
    const ok = v.status === 0 && s.ok && !problems.length;
    console.log(ok ? '\nverify: OK' : '\nverify: FAILED');
    process.exit(ok ? 0 : 1);
  }

  const wanted = opt.harness ? opt.harness.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  const runSara = wanted ? wanted.includes('sara') : await ollamaUp(opt.ollama!);
  const picked = wanted ? harnesses.filter((h) => wanted.includes(h.id)) : harnesses.filter((h) => findOnPath(h.command[0]));
  for (const w of wanted ?? []) if (w !== 'sara' && !harnesses.some((h) => h.id === w)) console.log(`No harness called "${w}" (presets: ${PRESETS.map((h) => h.id).join(', ')}; add your own in evals/harnesses.json).`);
  if (!runSara && !picked.length) console.log('No harness to run: none of the preset CLIs is on PATH and Ollama does not answer. See --mode verify.');

  if (runSara) {
    console.log(`\n== Sara (${opt.model}) ==`);
    const args = [join(ROOT, 'scripts', 'bench-tasks.ts'), '--mode', 'agent', '--tier', tierKey, '--model', opt.model!, '--ollama', opt.ollama!, '--python', opt.python!, '--timeout', String(timeoutSec), ...(opt.only ? ['--only', opt.only] : [])];
    spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    spawnSync(process.execPath, [join(ROOT, 'scripts', 'publish-results.ts')], { stdio: 'inherit', windowsHide: true });
  }
  for (const h of picked) {
    console.log(`\n== ${h.label} ==`);
    const started = new Date();
    const runs: Row[] = [];
    for (const t of tasks) {
      const r = await runHarness(h, t, { python: opt.python!, timeoutSec });
      runs.push(r);
      console.log(`${r.pass ? 'PASS' : 'FAIL'} ${t.id} ${r.seconds}s, ${r.filesChanged} files changed${r.error ? ` [${r.error}]` : ''}  (${runs.filter((x) => x.pass).length}/${runs.length})`);
    }
    const pass = runs.filter((r) => r.pass).length;
    const result: CompareRun = { harness: h.id, label: h.label, version: versionOf(h), model: opt['label-model'] || h.model || '', tier: tierKey, command: h.command, at: started.toISOString(), finished: new Date().toISOString(), platform: process.platform, python: pythonVersion, tasks: runs.length, pass, pass1: runs.length ? Math.round((pass / runs.length) * 1000) / 10 : 0, seconds: runs.reduce((n, r) => n + r.seconds, 0), runs };
    const name = `compare-${tierKey}-${h.id}.json`;
    const raw = join(RAW, `${started.toISOString().slice(0, 10)}-${name}`);
    mkdirSync(RAW, { recursive: true });
    let prev: CompareRun[] = [];
    try {
      prev = existsSync(raw) ? (readJson<CompareRun[] | CompareRun>(raw) as CompareRun[]) : [];
      if (!Array.isArray(prev)) prev = [prev];
    } catch {
      prev = [];
    }
    writeFileSync(raw, `${JSON.stringify([...prev, result], null, 2)}\n`);
    writeFileSync(join(DOCS, name), `${JSON.stringify(compareSummary(result, basename(raw)), null, 2)}\n`);
    console.log(`${h.label}: ${pass}/${runs.length} (pass@1 ${result.pass1}%). Raw: ${raw}`);
  }
  console.log(`\nPage: ${writePage()}`);
}
