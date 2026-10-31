// Phase 54: public coding benchmarks, run through Sara's own agent loop.
//
// The default problems are OpenAI's HumanEval (164 Python functions with hidden unit tests; MIT
// license, https://github.com/openai/human-eval). They are NOT copied into this repository: the
// script downloads the selected set from its official source on the first run and caches it under
// outputs/bench-cache/ (gitignored). `--set mbpp` selects the sanitized MBPP held-out test split.
//
// For each problem she gets a coding conversation with a workspace that holds solution.py (the
// function's signature and docstring only). She works the way she always does: read the file,
// write code, run python in the shell tool, fix, and say when she's done. Then the hidden tests
// (which she never sees) run against her solution.py in a separate folder. One attempt per
// problem, so the score is pass@1.
//
// `--mode raw` asks the same model for the function in a single reply with no tools, as a
// baseline for what the agent loop adds.
//
//   node scripts/bench-coding.ts [--set humaneval|mbpp] [--model qwen3.8:27b-mtp-q4_K_M] [--mode agent|raw]
//        [--limit 164] [--start 0] [--minutes 0] [--timeout 300] [--python python3]
//
// Needs Python 3 on the PATH (the hidden tests are Python) and an OpenAI-compatible model server
// (default: Ollama on this computer). No sandbox is used: commands run on this computer in a
// throwaway workspace, so run it on a machine where that is fine. HumanEval results are merged into
// evals/results/<date>-coding-<mode>.json; MBPP results use a separate mbpp filename.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUMAN_EVAL_SOURCE = 'https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz';
const MBPP_SOURCE = 'https://raw.githubusercontent.com/google-research/google-research/master/mbpp/sanitized-mbpp.json';
const MBPP_TEST_START = 11;
const MBPP_TEST_END = 510;

export interface Problem {
  task_id: string;
  prompt: string;
  entry_point: string;
  test: string;
  canonical_solution?: string;
  benchmark?: 'humaneval' | 'mbpp';
  test_imports?: string[];
  test_list?: string[];
}

/** Parses the HumanEval JSON-lines file. */
export function parseProblems(text: string): Problem[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Problem);
}

type MbppRow = {
  task_id: number;
  prompt: string;
  code: string;
  test_imports: string[];
  test_list: string[];
  source_file: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertMbppRow(value: unknown, index: number): MbppRow {
  if (!isRecord(value) || !Number.isInteger(value.task_id) || typeof value.prompt !== 'string' || typeof value.code !== 'string' || typeof value.source_file !== 'string' || !Array.isArray(value.test_imports) || !value.test_imports.every((item) => typeof item === 'string') || !Array.isArray(value.test_list) || !value.test_list.every((item) => typeof item === 'string')) {
    throw new Error(`Invalid sanitized MBPP row at index ${index}: expected task_id, prompt, code, test_imports, test_list and source_file.`);
  }
  return value as unknown as MbppRow;
}

function pythonIdentifierPattern(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*\\(`);
}

function mbppFunctionSignature(row: MbppRow): { name: string; signature: string } {
  const definitions = [...row.code.matchAll(/^def\s+([A-Za-z_]\w*)\s*(\([^\n]*\))\s*:/gm)].map((match) => ({
    name: match[1],
    signature: match[0].trim(),
  }));
  const called = definitions.filter(({ name }) => row.test_list.some((test) => pythonIdentifierPattern(name).test(test)));
  if (called.length !== 1) {
    throw new Error(`Unsupported sanitized MBPP task ${row.task_id}: expected one tested top-level function, found ${called.length}.`);
  }
  return called[0];
}

function pythonDocstring(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"""', '\\"""').replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

/** Parses the official sanitized MBPP JSON and returns only its held-out test split. */
export function parseMbppProblems(text: string): Problem[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error('Invalid sanitized MBPP data: expected a JSON array.');
  return raw.map(assertMbppRow).filter((row) => row.task_id >= MBPP_TEST_START && row.task_id <= MBPP_TEST_END).map((row) => {
    const main = mbppFunctionSignature(row);
    const prompt = `${main.signature}\n    """${pythonDocstring(row.prompt)}"""\n    pass\n`;
    return {
      task_id: `MBPP/${row.task_id}`,
      prompt,
      entry_point: main.name,
      test: '',
      benchmark: 'mbpp',
      test_imports: row.test_imports,
      test_list: row.test_list,
    };
  });
}

/** The Python program the hidden tests run: her file, then imports and assertions for the set. */
export function testProgram(solution: string, p: Problem): string {
  if (p.benchmark === 'mbpp') {
    return [solution, '', ...(p.test_imports ?? []), '', ...(p.test_list ?? []), ''].join('\n');
  }
  return `${solution}\n\n${p.test}\n\ncheck(${p.entry_point})\n`;
}

/** The first fenced Python block of a reply (or the whole reply when there is none). */
export function codeFromReply(reply: string): string {
  const m = /```(?:python|py)?\s*\n([\s\S]*?)```/i.exec(reply);
  return (m ? m[1] : reply).trim();
}

/** The task as she reads it in chat. */
export function taskText(p: Problem): string {
  return [
    `In this workspace, solution.py holds a Python function \`${p.entry_point}\` with only its signature and docstring.`,
    'Implement it so it does exactly what the docstring says, including its examples. Keep the function name and signature, and keep any imports the file needs.',
    'Test it yourself by running python in the shell. When it works, reply with one short line.',
  ].join(' ');
}

export function runHidden(python: string, solution: string, p: Problem, timeoutMs = 30_000): { pass: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sara-bench-test-'));
  try {
    const file = join(dir, 'check.py');
    writeFileSync(file, testProgram(solution, p));
    const r = spawnSync(python, [file], { cwd: dir, timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    if (r.error) return { pass: false, detail: (r.error as Error).message.slice(0, 300) };
    return { pass: r.status === 0, detail: `${r.stdout}${r.stderr}`.trim().slice(-300) };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function loadProblems(set: 'humaneval' | 'mbpp'): Promise<Problem[]> {
  const cache = join(ROOT, 'outputs', 'bench-cache', set === 'mbpp' ? 'sanitized-mbpp.json' : 'HumanEval.jsonl.gz');
  if (!existsSync(cache)) {
    const source = set === 'mbpp' ? MBPP_SOURCE : HUMAN_EVAL_SOURCE;
    console.log(`Downloading ${set === 'mbpp' ? 'sanitized MBPP' : 'HumanEval'} from ${source} …`);
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  const text = readFileSync(cache);
  return set === 'mbpp' ? parseMbppProblems(text.toString('utf8')) : parseProblems(gunzipSync(text).toString('utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({
    options: {
      set: { type: 'string' },
      model: { type: 'string', default: 'qwen3.8:27b-mtp-q4_K_M' },
      ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' },
      mode: { type: 'string', default: 'agent' },
      limit: { type: 'string' },
      start: { type: 'string', default: '0' },
      minutes: { type: 'string', default: '0' },
      timeout: { type: 'string', default: '300' },
      python: { type: 'string', default: process.platform === 'win32' ? 'python' : 'python3' },
    },
  });
  const set = opt.set ?? 'humaneval';
  if (set !== 'humaneval' && set !== 'mbpp') throw new Error(`Unknown benchmark set "${set}" (use humaneval or mbpp).`);
  const mode = opt.mode === 'raw' ? 'raw' : 'agent';
  const all = await loadProblems(set);
  const limit = Number(opt.limit ?? all.length);
  const picked = all.slice(Number(opt.start), Number(opt.start) + limit);
  const deadline = Number(opt.minutes) > 0 ? Date.now() + Number(opt.minutes) * 60_000 : Infinity;
  const py = spawnSync(opt.python!, ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) throw new Error(`Python not found as "${opt.python}" (use --python).`);
  const pythonVersion = `${py.stdout}${py.stderr}`.trim();
  console.log(`${set}: ${all.length} problems; running ${picked.length} from #${opt.start} in ${mode} mode on ${opt.model} (${pythonVersion}).`);

  type Run = { task: string; pass: boolean; seconds: number; toolCalls: number; detail?: string; error?: string };
  const runs: Run[] = [];
  const started = new Date();

  if (mode === 'raw') {
    for (const p of picked) {
      if (Date.now() > deadline) break;
      const t0 = Date.now();
      let reply = '';
      let error: string | undefined;
      try {
        const res = await fetch(`${opt.ollama}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(Number(opt.timeout) * 1000),
          body: JSON.stringify({ model: opt.model, stream: false, messages: [{ role: 'user', content: `Complete this Python function. Reply with the whole file in one python code block (imports, the function, nothing else).\n\n\`\`\`python\n${p.prompt}\n\`\`\`` }] }),
        });
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        reply = j.choices?.[0]?.message?.content ?? '';
      } catch (err) {
        error = (err as Error).message;
      }
      const h = error ? { pass: false, detail: '' } : runHidden(opt.python!, codeFromReply(reply), p);
      const run: Run = { task: p.task_id, pass: h.pass, seconds: Math.round((Date.now() - t0) / 1000), toolCalls: 0, ...(h.pass ? {} : { detail: h.detail }), ...(error ? { error } : {}) };
      runs.push(run);
      console.log(`${run.pass ? 'PASS' : 'FAIL'} ${p.task_id} ${run.seconds}s${error ? ` [${error}]` : ''}`);
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

    const dataDir = mkdtempSync(join(tmpdir(), 'sara-bench-coding-'));
    const vault = new Vault(dataDir);
    const store = new Store(join(dataDir, 'sara.db'));
    const app: AppContext = { store, settings: new SettingsStore(dataDir), vault, persona: loadPersona(join(ROOT, 'persona', 'sara.json')), now: () => new Date(), dataDir, tools: new ToolRegistry(), approvals: new ApprovalBroker(), sandbox: { mode: 'none', network: false, detail: 'benchmark' }, redactor: new Redactor(() => vault.values()), snapshots: new SnapshotStore(dataDir), events: new EventHub() };
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
      for (const [i, p] of picked.entries()) {
        if (Date.now() > deadline) break;
        const name = `he-${Number(opt.start) + i}`;
        const ws = workspaceDir(dataDir, name);
        writeFileSync(join(ws, 'solution.py'), p.prompt);
        const conv = store.createConversation({ mode: 'coding', workspace: name, title: p.task_id });
        const t0 = Date.now();
        let toolCalls = 0;
        let error: string | undefined;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(new Error('timeout')), Number(opt.timeout) * 1000);
        try {
          for await (const ev of runTurn(app, conv.id, taskText(p), ctl.signal)) {
            if (ev.type === 'tool_call') toolCalls++;
            else if (ev.type === 'error') error = ev.message;
          }
        } catch (err) {
          error = (err as Error).message;
        } finally {
          clearTimeout(timer);
        }
        const solution = existsSync(join(ws, 'solution.py')) ? readFileSync(join(ws, 'solution.py'), 'utf8') : '';
        // Even after a timeout, whatever she saved is tested (that is what she'd hand over).
        const h = runHidden(opt.python!, solution, p);
        const run: Run = { task: p.task_id, pass: h.pass, seconds: Math.round((Date.now() - t0) / 1000), toolCalls, ...(h.pass ? {} : { detail: h.detail }), ...(error ? { error } : {}) };
        runs.push(run);
        const n = runs.filter((r) => r.pass).length;
        console.log(`${run.pass ? 'PASS' : 'FAIL'} ${p.task_id} ${run.seconds}s, ${toolCalls} tool calls${error ? ` [${error}]` : ''}  (${n}/${runs.length})`);
      }
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }

  const pass = runs.filter((r) => r.pass).length;
  const result = {
    benchmark: set === 'mbpp' ? 'MBPP sanitized (google-research, CC BY 4.0)' : 'HumanEval (openai/human-eval, MIT)',
    mode,
    model: opt.model,
    at: started.toISOString(),
    finished: new Date().toISOString(),
    python: pythonVersion,
    platform: process.platform,
    first: picked[0]?.task_id,
    tasks: runs.length,
    pass,
    pass1: runs.length ? Math.round((pass / runs.length) * 1000) / 10 : 0,
    seconds: runs.reduce((n, r) => n + r.seconds, 0),
    runs,
  };
  console.log(`\n${mode}: ${pass}/${runs.length} hidden-test passes (pass@1 ${result.pass1}%) on ${opt.model}, ${Math.round(result.seconds / 60)} min.`);
  const out = join(ROOT, 'evals', 'results', `${started.toISOString().slice(0, 10)}-coding-${set === 'mbpp' ? 'mbpp-' : ''}${mode}.json`);
  mkdirSync(dirname(out), { recursive: true });
  let prev: unknown[] = [];
  if (existsSync(out)) {
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
