// Phase 58: a harder coding benchmark, where her tools should matter.
//
// HumanEval (scripts/bench-coding.ts) is single functions the model already knows by heart. These
// are small, original repository tasks written for Sara (bench/tasks/<id>/): a bug spread over
// two or three modules, a feature described in a README or SPEC, a refactor that mustn't change
// behaviour, in JavaScript and Python. Each task has:
//   start/      the project as she gets it (with its own, partly failing, test suite)
//   task.json   the request, the language and the command that runs the hidden tests
//   hidden/     tests she never sees, run after she finishes
// and bench/solutions/<id>/ holds a reference solution (files laid over start/), used only by
// `--mode verify` to prove every task is solvable and that its hidden tests catch the starting code.
//
//   node scripts/bench-tasks.ts --mode verify                  (no model: checks the tasks)
//   node scripts/bench-tasks.ts --mode agent [--model qwen3.8:27b-mtp-q4_K_M] [--timeout 480]
//   node scripts/bench-tasks.ts --mode raw                     (baseline: one reply, no tools)
//        [--only 01-cart-totals,05-date-range] [--minutes 0] [--python python3] [--ollama <url>]
//   node scripts/bench-tasks.ts --tier projects …              (Phase 62: the real-size projects)
//
// Phase 62 adds a second tier, bench/projects/<id>/ (reference solutions in
// bench/project-solutions/<id>/): real-size projects of 20 to 40 files and one to two thousand
// lines each, where the bug or the refactor is spread over modules and the agent has to read and
// run code to find it. Same task format, same hidden-test grading; results go to
// evals/results/<date>-projects-<mode>.json.
//
// Agent mode: a coding conversation with a workspace holding a copy of start/; she works the way
// she always does (read files, edit, run the tests in the shell) and says when she's done. Raw
// mode: the same model gets every file of start/ in one message and must answer with the full new
// content of each file it changes; those files are written and the same hidden tests run. Like
// bench-coding, nothing is sandboxed: the code runs on this computer in throwaway folders. The
// result is merged into evals/results/<date>-tasks-<mode>.json.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, 'bench', 'tasks');
const SOLUTIONS = join(ROOT, 'bench', 'solutions');
/** Phase 62: the real-size projects tier. */
export const TIERS = {
  tasks: { tasks: TASKS, solutions: SOLUTIONS, name: 'Sara repository tasks (bench/tasks, original)', file: 'tasks', timeout: 480 },
  projects: { tasks: join(ROOT, 'bench', 'projects'), solutions: join(ROOT, 'bench', 'project-solutions'), name: 'Sara real-size projects (bench/projects, original)', file: 'projects', timeout: 900 },
} as const;
const SKIP = new Set(['node_modules', '__pycache__', '.git', '.pytest_cache', '__hidden__']);

export interface Task {
  id: string;
  title: string;
  kind: 'bug' | 'feature' | 'refactor';
  lang: 'js' | 'python';
  prompt: string;
  /** The hidden-test command, run in the checked folder; {python} and node are filled in. */
  hidden: string[];
  env?: Record<string, string>;
  /** The folder the task lives in (bench/tasks or bench/projects). */
  root?: string;
}

export function loadTasks(dir = TASKS): Task[] {
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'task.json')))
    .sort()
    .map((id) => ({ id, ...(JSON.parse(readFileSync(join(dir, id, 'task.json'), 'utf8')) as Omit<Task, 'id'>), root: dir }));
}

/** Every file under a folder, as forward-slash relative paths (caches and hidden tests skipped). */
export function listFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** The request as she reads it in chat (agent mode). */
export function taskText(t: Task): string {
  const run = t.lang === 'js' ? 'Run its tests with `node --test` (Node 24; no npm packages are needed or installed).' : 'Run its tests with `python -m unittest discover -s tests` (Python 3, standard library only).';
  return `${t.prompt}\n\nThe project is in your workspace. ${run} Work until the task is done and the tests pass, then reply with one short line saying what you changed.`;
}

/** The single message the plain model gets (raw mode): the request and every file. */
export function rawPrompt(t: Task, files: { path: string; text: string }[]): string {
  const fence = (s: string) => (s.includes('```') ? '````' : '```');
  return [
    `Here is a small software project and a task for it.\n\nTask: ${t.prompt}`,
    `\nThe project's files:\n`,
    ...files.map((f) => `### ${f.path}\n${fence(f.text)}\n${f.text.replace(/\n$/, '')}\n${fence(f.text)}\n`),
    'You cannot run anything. Reply with the complete new content of every file you change or add: for each one, a line `### path/to/file` and then one code block holding the whole file. Leave out files you do not change.',
  ].join('\n');
}

/** Files from a reply: a `### path` (or **path** / File: path) line followed by a fenced block. */
export function filesFromReply(reply: string): { path: string; text: string }[] {
  const lines = reply.split(/\r?\n/);
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*(?:#{1,6}\s*|\*\*|File:\s*)`?([\w.\-/]+\.\w+)`?\**:?\s*$/.exec(lines[i]);
    if (!head) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[j] ?? '');
    if (!open) continue;
    const body: string[] = [];
    let k = j + 1;
    while (k < lines.length && !(lines[k].trim().startsWith(open[1]) && lines[k].trim().replace(/[`~]/g, '') === '')) body.push(lines[k++]);
    out.set(head[1], `${body.join('\n')}\n`);
    i = k;
  }
  return [...out].map(([path, text]) => ({ path, text }));
}

/** A relative path that stays inside the project, or undefined. */
export function safePath(p: string): string | undefined {
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
  return !n || n === '.' || n.startsWith('../') || n === '..' || posix.isAbsolute(n) || /^[a-z]:/i.test(n) ? undefined : n;
}

export function copyProject(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const f of listFiles(from)) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
}

function command(argv: string[], python: string): [string, string[]] {
  const fill = argv.map((a) => (a === '{python}' ? python : a === 'node' ? process.execPath : a));
  return [fill[0], fill.slice(1)];
}

/** Runs the hidden tests against a finished project folder (copied, so nothing she left behind interferes). */
export function runHidden(t: Task, project: string, python: string, timeoutMs = 120_000): { pass: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sara-tasks-check-'));
  try {
    copyProject(project, dir);
    cpSync(join(t.root ?? TASKS, t.id, 'hidden'), join(dir, '__hidden__'), { recursive: true });
    const [file, args] = command(t.hidden, python);
    const r = spawnSync(file, args, { cwd: dir, timeout: timeoutMs, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...t.env, PYTHONDONTWRITEBYTECODE: '1', NODE_TEST_CONTEXT: undefined } });
    if (r.error) return { pass: false, detail: (r.error as Error).message.slice(0, 300) };
    const out = `${r.stdout}${r.stderr}`;
    const failures = out.split('\n').filter((l) => /^\s*not ok|Error|^\s*(actual|expected):|^FAIL:/.test(l));
    return { pass: r.status === 0, detail: (failures.length ? failures.join('\n') : out.trim().slice(-600)).slice(0, 1200) };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Size of a project: files and lines (text files only), for the published table. */
export function projectSize(dir: string): { files: number; lines: number } {
  const files = listFiles(dir);
  let lines = 0;
  for (const f of files) if (/\.(js|mjs|ts|py|md|json|txt|sh|css|html|ya?ml|toml|cfg|ini)$/i.test(f)) lines += readFileSync(join(dir, f), 'utf8').split('\n').length;
  return { files: files.length, lines };
}

/** The task's own (visible) tests, for --mode verify. */
function runVisible(t: Task, project: string, python: string): boolean {
  const [file, args] = t.lang === 'js' ? [process.execPath, ['--test']] : [python, ['-m', 'unittest', 'discover', '-s', 'tests']];
  const r = spawnSync(file, args, { cwd: project, timeout: 120_000, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...t.env, PYTHONDONTWRITEBYTECODE: '1', NODE_TEST_CONTEXT: undefined } });
  return r.status === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({
    options: {
      model: { type: 'string', default: 'qwen3.8:27b-mtp-q4_K_M' },
      ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' },
      mode: { type: 'string', default: 'agent' },
      only: { type: 'string', default: '' },
      minutes: { type: 'string', default: '0' },
      timeout: { type: 'string', default: '' },
      tier: { type: 'string', default: 'tasks' },
      python: { type: 'string', default: process.platform === 'win32' ? 'python' : 'python3' },
    },
  });
  const mode = opt.mode === 'raw' ? 'raw' : opt.mode === 'verify' ? 'verify' : 'agent';
  const tier = opt.tier === 'projects' ? TIERS.projects : TIERS.tasks;
  if (!opt.timeout) opt.timeout = String(tier.timeout);
  const only = opt.only ? new Set(opt.only.split(',')) : undefined;
  const tasks = loadTasks(tier.tasks).filter((t) => !only || only.has(t.id));
  const py = spawnSync(opt.python!, ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) throw new Error(`Python not found as "${opt.python}" (use --python).`);
  const pythonVersion = `${py.stdout}${py.stderr}`.trim();
  const deadline = Number(opt.minutes) > 0 ? Date.now() + Number(opt.minutes) * 60_000 : Infinity;

  if (mode === 'verify') {
    // Every task must fail on its starting code and pass (hidden and visible tests) on the reference solution.
    let bad = 0;
    for (const t of tasks) {
      const start = join(tier.tasks, t.id, 'start');
      const before = runHidden(t, start, opt.python!);
      const dir = mkdtempSync(join(tmpdir(), 'sara-tasks-ref-'));
      try {
        copyProject(start, dir);
        copyProject(join(tier.solutions, t.id), dir);
        const after = runHidden(t, dir, opt.python!);
        const visible = runVisible(t, dir, opt.python!);
        const ok = !before.pass && after.pass && visible;
        if (!ok) bad++;
        const size = projectSize(start);
        console.log(`${ok ? 'OK  ' : 'BAD '} ${t.id.padEnd(22)} ${size.files} files, ${size.lines} lines; start: ${before.pass ? 'PASSES (should fail)' : 'fails'}, reference: ${after.pass ? 'passes' : 'FAILS'}, visible tests on reference: ${visible ? 'pass' : 'FAIL'}${after.pass ? '' : `\n${after.detail}`}`);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    }
    console.log(`\n${tasks.length - bad}/${tasks.length} tasks verified (${pythonVersion}).`);
    process.exit(bad ? 1 : 0);
  }

  console.log(`Repository tasks: running ${tasks.length} in ${mode} mode on ${opt.model} (${pythonVersion}).`);
  type Run = { task: string; title: string; kind: string; lang: string; pass: boolean; seconds: number; toolCalls: number; filesChanged: number; files?: number; lines?: number; detail?: string; error?: string };
  const sizeOf = (t: Task) => (tier === TIERS.projects ? projectSize(join(tier.tasks, t.id, 'start')) : {});
  const runs: Run[] = [];
  const started = new Date();
  const scratch = mkdtempSync(join(tmpdir(), 'sara-bench-tasks-'));
  const changedFiles = (start: string, done: string) => listFiles(done).filter((f) => !existsSync(join(start, f)) || readFileSync(join(start, f), 'utf8') !== readFileSync(join(done, f), 'utf8')).length;

  try {
    if (mode === 'raw') {
      for (const t of tasks) {
        if (Date.now() > deadline) break;
        const start = join(tier.tasks, t.id, 'start');
        const files = listFiles(start).map((p) => ({ path: p, text: readFileSync(join(start, p), 'utf8') }));
        const t0 = Date.now();
        let reply = '';
        let error: string | undefined;
        try {
          const res = await fetch(`${opt.ollama}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(Number(opt.timeout) * 1000),
            body: JSON.stringify({ model: opt.model, stream: false, messages: [{ role: 'user', content: rawPrompt(t, files) }] }),
          });
          const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
          reply = j.choices?.[0]?.message?.content ?? '';
          if (!res.ok) error = j.error?.message ?? `HTTP ${res.status}`;
        } catch (err) {
          error = (err as Error).message;
        }
        const dir = join(scratch, t.id);
        copyProject(start, dir);
        let written = 0;
        for (const f of filesFromReply(reply)) {
          const p = safePath(f.path);
          if (!p) continue;
          mkdirSync(dirname(join(dir, p)), { recursive: true });
          writeFileSync(join(dir, p), f.text);
          written++;
        }
        if (!error && !written) error = 'no files in the reply';
        const h = runHidden(t, dir, opt.python!);
        const run: Run = { task: t.id, title: t.title, kind: t.kind, lang: t.lang, pass: h.pass, seconds: Math.round((Date.now() - t0) / 1000), toolCalls: 0, filesChanged: changedFiles(start, dir), ...sizeOf(t), ...(h.pass ? {} : { detail: h.detail }), ...(error ? { error } : {}) };
        runs.push(run);
        console.log(`${run.pass ? 'PASS' : 'FAIL'} ${t.id} ${run.seconds}s, ${run.filesChanged} files changed${error ? ` [${error}]` : ''}  (${runs.filter((r) => r.pass).length}/${runs.length})`);
      }
    } else {
      const { runTurn } = await import('../src/chat.ts');
      const { EventHub } = await import('../src/events.ts');
      const { loadPersona } = await import('../src/persona.ts');
      const { Redactor } = await import('../src/redact.ts');
      const { SettingsStore } = await import('../src/settings.ts');
      const { SnapshotStore } = await import('../src/snapshots.ts');
      const { Store } = await import('../src/store.ts');
      const { ApprovalBroker, ToolRegistry } = await import('../src/tools/registry.ts');
      const { workspaceDir } = await import('../src/tools/workspace.ts');
      const { Vault } = await import('../src/vault.ts');
      type AppContext = import('../src/chat.ts').AppContext;

      const vault = new Vault(scratch);
      const store = new Store(join(scratch, 'sara.db'));
      const app: AppContext = { store, settings: new SettingsStore(scratch), vault, persona: loadPersona(join(ROOT, 'persona', 'sara.json')), now: () => new Date(), dataDir: scratch, tools: new ToolRegistry(), approvals: new ApprovalBroker(), sandbox: { mode: 'none', network: false, detail: 'benchmark' }, redactor: new Redactor(() => vault.values()), snapshots: new SnapshotStore(scratch), events: new EventHub() };
      app.settings.update({
        providers: [{ id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: opt.ollama!, local: true }],
        defaultProviderId: 'ol',
        defaultModel: opt.model,
        ownerName: 'Sam',
        timeZone: 'UTC',
        disclosureAcceptedAt: new Date().toISOString(),
        // Nobody is there to approve: the shell runs without asking; no web access (no peeking).
        toolPermissions: { shell: 'auto', web_fetch: 'never' },
      });
      try {
        for (const t of tasks) {
          if (Date.now() > deadline) break;
          const start = join(tier.tasks, t.id, 'start');
          const name = `task-${t.id}`;
          const ws = workspaceDir(scratch, name);
          copyProject(start, ws);
          const conv = store.createConversation({ mode: 'coding', workspace: name, title: t.title });
          const t0 = Date.now();
          let toolCalls = 0;
          let error: string | undefined;
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(new Error('timeout')), Number(opt.timeout) * 1000);
          try {
            for await (const ev of runTurn(app, conv.id, taskText(t), ctl.signal)) {
              if (ev.type === 'tool_call') {
                toolCalls++;
                // The hidden tests and reference solutions live in this repository; note any look at them.
                if (/bench[\\/](tasks|solutions|projects|project-solutions)|__hidden__/.test(JSON.stringify(ev.args))) error = 'looked outside the workspace at the benchmark files';
              } else if (ev.type === 'error') error = ev.message;
            }
          } catch (err) {
            error = (err as Error).message;
          } finally {
            clearTimeout(timer);
          }
          // Even after a timeout, whatever she left is tested (that is what she'd hand over).
          const h = runHidden(t, ws, opt.python!);
          const run: Run = { task: t.id, title: t.title, kind: t.kind, lang: t.lang, pass: h.pass, seconds: Math.round((Date.now() - t0) / 1000), toolCalls, filesChanged: changedFiles(start, ws), ...sizeOf(t), ...(h.pass ? {} : { detail: h.detail }), ...(error ? { error } : {}) };
          runs.push(run);
          console.log(`${run.pass ? 'PASS' : 'FAIL'} ${t.id} ${run.seconds}s, ${toolCalls} tool calls, ${run.filesChanged} files changed${error ? ` [${error}]` : ''}  (${runs.filter((r) => r.pass).length}/${runs.length})`);
        }
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  const pass = runs.filter((r) => r.pass).length;
  const result = {
    benchmark: tier.name,
    mode,
    model: opt.model,
    at: started.toISOString(),
    finished: new Date().toISOString(),
    python: pythonVersion,
    platform: process.platform,
    first: runs[0]?.task,
    tasks: runs.length,
    pass,
    pass1: runs.length ? Math.round((pass / runs.length) * 1000) / 10 : 0,
    seconds: runs.reduce((n, r) => n + r.seconds, 0),
    runs,
  };
  console.log(`\n${mode}: ${pass}/${runs.length} tasks pass their hidden tests (pass@1 ${result.pass1}%) on ${opt.model}, ${Math.round(result.seconds / 60)} min.`);
  const out = join(ROOT, 'evals', 'results', `${started.toISOString().slice(0, 10)}-${tier.file}-${mode}.json`);
  mkdirSync(dirname(out), { recursive: true });
  let prev: unknown[] = [];
  if (existsSync(out) && statSync(out).size) {
    try {
      const j = JSON.parse(readFileSync(out, 'utf8')) as unknown;
      prev = Array.isArray(j) ? j : [j];
    } catch {
      prev = [];
    }
  }
  writeFileSync(out, `${JSON.stringify([...prev, result], null, 2)}\n`);
  console.log(`Results: ${out}`);
}
