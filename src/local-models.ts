// Phase 67: a model on this computer. Finds Ollama (http://127.0.0.1:11434: /api/version and
// /api/tags), looks at the hardware (an NVIDIA GPU's name and memory through nvidia-smi, a Mac's
// unified memory through sysctl, the RAM through os.totalmem), recommends a model from a small
// table (docs/CHOOSING_A_MODEL.md), and downloads it with Ollama's /api/pull, with progress and
// Cancel. Nothing is installed without the owner pressing a button; on Windows the optional
// "Install Ollama with winget" runs only after an explicit click.
import { execFile, spawn } from 'node:child_process';
import { arch, platform, totalmem } from 'node:os';
import { assertOnline, netFetch } from './net-guard.ts';
import type { ProviderConfig } from './providers/types.ts';
import { isCloudModelName, EMBED_MODEL_NAME } from './model-names.ts';

export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
export const OLLAMA_DOWNLOAD = 'https://ollama.com/download';

const GB = 1024 ** 3;

export interface Hardware {
  platform: string;
  arch: string;
  /** RAM in GB (rounded to one decimal). */
  ramGb: number;
  /** The biggest NVIDIA GPU, if nvidia-smi found one. */
  gpu?: { name: string; vramGb: number };
  /** Apple silicon: the GPU shares the main memory. */
  appleSilicon?: boolean;
  /** The memory the recommendation is based on (VRAM, part of unified memory, or RAM). */
  budgetGb: number;
  /** What the budget is: 'gpu' (VRAM), 'unified' (Apple silicon) or 'cpu' (no GPU found). */
  basis: 'gpu' | 'unified' | 'cpu';
}

/** One row of the table: from `minGb` of model memory up, this model. Sizes are the download. */
export interface ModelTier {
  minGb: number;
  model: string;
  /** Approximate download size in GB. */
  sizeGb: number;
  /** English (translated by the app). */
  note: string;
}

/**
 * GPU memory (or the Mac's share of unified memory) → model. Follows docs/CHOOSING_A_MODEL.md:
 * roughly 0.6 GB per billion parameters at 4 bits, plus room for the conversation.
 */
export const GPU_TIERS: readonly ModelTier[] = [
  { minGb: 0, model: 'qwen3.5:2b', sizeGb: 2.7, note: 'Small and quick: fine for short chats and memory notes; weak at tools.' },
  { minGb: 4, model: 'qwen3.5:4b', sizeGb: 3.4, note: 'Fine for everyday chat and quick jobs; weak at coding.' },
  { minGb: 8, model: 'qwen3.5:9b', sizeGb: 6.6, note: 'Usable chat and simple tools.' },
  { minGb: 12, model: 'gemma4:12b', sizeGb: 7.7, note: 'Good chat, decent tools, can see pictures.' },
  { minGb: 16, model: 'gpt-oss:20b', sizeGb: 14, note: 'Good chat and tools.' },
  { minGb: 24, model: 'qwen3.8:27b', sizeGb: 18, note: 'Strong chat, coding and tools: what the published results used.' },
];

/** No GPU found: the model runs on the processor, so smaller is kinder. */
export const CPU_TIERS: readonly ModelTier[] = [
  { minGb: 0, model: 'qwen3.5:2b', sizeGb: 2.7, note: 'Runs on the processor: slow but usable for short chats.' },
  { minGb: 16, model: 'qwen3.5:4b', sizeGb: 3.4, note: 'Runs on the processor: expect a few words a second.' },
];

/** Apple silicon: the share of unified memory left for a model next to macOS and your apps. */
export const UNIFIED_SHARE = 0.45;

export function memoryBudget(hw: Pick<Hardware, 'ramGb' | 'gpu' | 'appleSilicon'>): { budgetGb: number; basis: Hardware['basis'] } {
  if (hw.gpu) return { budgetGb: hw.gpu.vramGb, basis: 'gpu' };
  if (hw.appleSilicon) return { budgetGb: Math.round(hw.ramGb * UNIFIED_SHARE * 10) / 10, basis: 'unified' };
  return { budgetGb: hw.ramGb, basis: 'cpu' };
}

/** The biggest tier that fits the budget. */
export function recommendModel(hw: Pick<Hardware, 'budgetGb' | 'basis'>): ModelTier {
  const table = hw.basis === 'cpu' ? CPU_TIERS : GPU_TIERS;
  let pick = table[0];
  for (const t of table) if (hw.budgetGb >= t.minGb) pick = t;
  return pick;
}

type Exec = (file: string, args: string[]) => Promise<string>;
const execText: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** "NVIDIA GeForce RTX 4070, 12282" lines (MiB) → the biggest GPU. */
export function parseNvidiaSmi(out: string): { name: string; vramGb: number } | undefined {
  let best: { name: string; vramGb: number } | undefined;
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!m) continue;
    const vramGb = Math.round((Number(m[2]) / 1024) * 10) / 10;
    if (!best || vramGb > best.vramGb) best = { name: m[1], vramGb };
  }
  return best;
}

/** Looks at this computer. Never fails: what it can't find is left out. */
export async function detectHardware(opts: { exec?: Exec; platform?: string; arch?: string; totalmem?: number } = {}): Promise<Hardware> {
  const run = opts.exec ?? execText;
  const plat = opts.platform ?? platform();
  const cpu = opts.arch ?? arch();
  let ram = opts.totalmem ?? totalmem();
  let gpu: Hardware['gpu'];
  let appleSilicon = false;
  if (plat === 'darwin') {
    appleSilicon = cpu === 'arm64';
    const mem = await run('sysctl', ['-n', 'hw.memsize']).catch(() => '');
    if (Number(mem.trim()) > 0) ram = Number(mem.trim());
  } else {
    const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']).catch(() => '');
    gpu = parseNvidiaSmi(out);
  }
  const base = { platform: plat, arch: cpu, ramGb: Math.round((ram / GB) * 10) / 10, ...(gpu ? { gpu } : {}), ...(appleSilicon ? { appleSilicon } : {}) };
  return { ...base, ...memoryBudget(base) };
}

export interface OllamaModel {
  name: string;
  sizeGb: number;
  /** Runs on Ollama's servers (Ollama Cloud), not this computer. */
  cloud: boolean;
}

export interface OllamaStatus {
  found: boolean;
  url: string;
  version?: string;
  models: OllamaModel[];
}

/** Ollama's own address (no /v1) for a provider, or the default. */
export function ollamaRoot(providers: ProviderConfig[]): string {
  const p = providers.find((x) => x.kind === 'openai-compatible' && /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]):11434\b/i.test(x.baseUrl));
  return p ? p.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '') : DEFAULT_OLLAMA;
}

export async function detectOllama(root = DEFAULT_OLLAMA, fetchImpl: typeof fetch = netFetch): Promise<OllamaStatus> {
  try {
    const v = await fetchImpl(`${root}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!v.ok) return { found: false, url: root, models: [] };
    const version = String(((await v.json().catch(() => ({}))) as { version?: unknown }).version ?? '') || undefined;
    const t = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const j = (await t.json().catch(() => ({}))) as { models?: { name?: string; model?: string; size?: number; remote_host?: string }[] };
    const models = (j.models ?? []).map((m) => {
      const name = String(m.name ?? m.model ?? '');
      return { name, sizeGb: Math.round(((m.size ?? 0) / GB) * 10) / 10, cloud: Boolean(m.remote_host) || isCloudModelName(name) };
    });
    return { found: true, url: root, ...(version ? { version } : {}), models: models.filter((m) => m.name) };
  } catch {
    return { found: false, url: root, models: [] };
  }
}

/** Models that really run here (not Ollama Cloud, not embedding-only). */
export const chatModels = (models: OllamaModel[]): OllamaModel[] => models.filter((m) => !m.cloud && !EMBED_MODEL_NAME.test(m.name));

// ---------- downloading a model ----------

export interface PullStatus {
  model: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  /** 0..100 (whole download), or null before the sizes are known. */
  percent: number | null;
  completedBytes: number;
  totalBytes: number;
  /** Ollama's latest status line ("pulling 3f8e…", "verifying sha256 digest"…). */
  stage: string;
  error?: string;
  startedAt: string;
}

/**
 * Reads Ollama's /api/pull stream: one JSON object a line, per layer `digest`, `total`,
 * `completed`; `{"status":"success"}` at the end, `{"error":…}` on failure.
 */
export class PullProgress {
  readonly #layers = new Map<string, { total: number; completed: number }>();
  #buf = '';
  stage = '';
  done = false;
  error: string | undefined;

  /** Feeds a piece of the stream (lines may be split anywhere). */
  push(chunk: string): void {
    this.#buf += chunk;
    let i: number;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      this.line(this.#buf.slice(0, i));
      this.#buf = this.#buf.slice(i + 1);
    }
  }

  /** The end of the stream (a last line without a newline). */
  end(): void {
    if (this.#buf.trim()) this.line(this.#buf);
    this.#buf = '';
  }

  line(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    let j: { status?: unknown; digest?: unknown; total?: unknown; completed?: unknown; error?: unknown };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      return; // not JSON: ignored
    }
    if (typeof j.error === 'string' && j.error) {
      this.error = j.error.slice(0, 300);
      return;
    }
    if (typeof j.status === 'string') this.stage = j.status.slice(0, 120);
    if (typeof j.digest === 'string' && Number(j.total) > 0) {
      const prev = this.#layers.get(j.digest);
      const completed = Math.max(prev?.completed ?? 0, Number(j.completed) || 0);
      this.#layers.set(j.digest, { total: Number(j.total), completed: Math.min(completed, Number(j.total)) });
    }
    if (j.status === 'success') this.done = true;
  }

  get totalBytes(): number {
    let n = 0;
    for (const l of this.#layers.values()) n += l.total;
    return n;
  }

  get completedBytes(): number {
    let n = 0;
    for (const l of this.#layers.values()) n += l.completed;
    return n;
  }

  get percent(): number | null {
    if (this.done) return 100;
    const t = this.totalBytes;
    return t ? Math.min(99, Math.floor((this.completedBytes / t) * 100)) : null;
  }
}

/** One download at a time for the whole server. */
export class ModelPuller {
  #status: PullStatus | undefined;
  #ctl: AbortController | undefined;
  readonly #fetch: typeof fetch;
  /** Called once a download finished (the server then picks the model). */
  onDone: ((model: string) => void) | undefined;

  constructor(fetchImpl: typeof fetch = netFetch) {
    this.#fetch = fetchImpl;
  }

  status(): PullStatus | undefined {
    return this.#status ? { ...this.#status } : undefined;
  }

  get running(): boolean {
    return this.#status?.state === 'running';
  }

  /** Starts downloading; returns at once. The progress is in status(). */
  start(root: string, model: string): PullStatus {
    if (this.running) throw new Error('A download is already running.');
    if (!/^[\w.\-/:]{1,200}$/.test(model) || isCloudModelName(model)) throw new Error('That is not a model name Ollama can download here.');
    const ctl = new AbortController();
    this.#ctl = ctl;
    const st: PullStatus = { model, state: 'running', percent: null, completedBytes: 0, totalBytes: 0, stage: 'starting', startedAt: new Date().toISOString() };
    this.#status = st;
    void this.#run(root, model, st, ctl.signal);
    return { ...st };
  }

  cancel(): boolean {
    if (!this.running) return false;
    this.#ctl?.abort();
    return true;
  }

  async #run(root: string, model: string, st: PullStatus, signal: AbortSignal): Promise<void> {
    const prog = new PullProgress();
    const sync = () => {
      st.percent = prog.percent;
      st.completedBytes = prog.completedBytes;
      st.totalBytes = prog.totalBytes;
      st.stage = prog.stage || st.stage;
    };
    try {
      const res = await this.#fetch(`${root}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal });
      if (!res.ok || !res.body) throw new Error(`Ollama answered HTTP ${res.status}.`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        prog.push(dec.decode(value, { stream: true }));
        sync();
        if (prog.error) break;
      }
      prog.end();
      sync();
      if (prog.error) throw new Error(prog.error);
      if (!prog.done) throw new Error('The download stopped before Ollama said it was finished.');
      st.state = 'done';
      st.percent = 100;
      this.onDone?.(model);
    } catch (err) {
      if (signal.aborted) st.state = 'cancelled';
      else {
        st.state = 'error';
        st.error = (err as Error).message.slice(0, 300);
      }
    }
  }
}

// ---------- installing Ollama on Windows (only after an explicit click) ----------

export interface InstallStatus {
  state: 'running' | 'done' | 'error';
  output: string;
}

let install: InstallStatus | undefined;

export const installStatus = (): InstallStatus | undefined => (install ? { ...install } : undefined);

/** `winget install Ollama.Ollama` (Windows only). Never called without the owner's click. */
export function installOllamaWithWinget(run: typeof spawn = spawn): InstallStatus {
  if (platform() !== 'win32') throw new Error('winget is only on Windows. Download Ollama from ollama.com/download.');
  assertOnline('Installing Ollama');
  if (install?.state === 'running') return { ...install };
  const st: InstallStatus = { state: 'running', output: '' };
  install = st;
  const p = run('winget', ['install', '-e', '--id', 'Ollama.Ollama', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const take = (d: Buffer) => (st.output = (st.output + d.toString('utf8')).replace(/[\r\b]+/g, '\n').slice(-4000));
  p.stdout?.on('data', take);
  p.stderr?.on('data', take);
  p.on('error', (err) => {
    st.state = 'error';
    st.output += `\n${err.message}`;
  });
  p.on('close', (code) => {
    if (st.state === 'running') st.state = code === 0 ? 'done' : 'error';
  });
  return { ...st };
}
