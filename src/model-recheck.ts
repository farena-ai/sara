// W2.4 the monthly re-check (docs/FREE_MODELS.md): a small eval subset run on the listed free models
// that are installed in Ollama on THIS computer, so the "tested" marks in Settings → On this computer
// stay true for this hardware and these builds. Local only: loopback Ollama, never a cloud model, no
// paid calls. Off by default (like Phase 84's re-check); when on it runs at most once a month and only
// when nobody has talked to her for 20 minutes, riding the hourly evals timer (no timer of its own).
// Results: <dataDir>/model-recheck.json; `node scripts/model-recheck.ts --publish` writes the same
// rows to docs/results/model-recheck.json for the results page (scripts/bench-compare.ts).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { writeFileAtomic } from './fs-util.ts';
import { FREE_MODELS, installedAs, type FreeJob, type FreeModelList, type RecheckResult } from './free-models.ts';
import { isCloudModelName } from './model-names.ts';
import { ollamaRoot, type OllamaStatus } from './local-models.ts';
import { firstTenDeps } from './first-ten.ts';
import { netFetch } from './net-guard.ts';
import type { ProviderConfig } from './providers/types.ts';

export const RECHECK_FILE = 'model-recheck.json';
export const MONTH_MS = 30 * 86_400_000;
export const IDLE_MS = 20 * 60_000;
/** Each answer gets this long (a big model loading into memory for the first time is slow). */
const CALL_MS = 180_000;
/** At most this many model/job pairs per run (a run stays well under an hour). */
const MAX_PAIRS = 12;

interface Probe {
  id: string;
  /** Ask (chat) or embed. */
  ask?: string;
  image?: boolean;
  check: (answer: string) => boolean | Promise<boolean>;
}

/** The JSON object in an answer (```json fences or bare). */
function jsonIn(s: string): Record<string, unknown> | undefined {
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The code in an answer (the first fenced block, or the whole answer). */
export function codeIn(s: string): string {
  const m = /```[a-z]*\s*\n([\s\S]*?)```/i.exec(s);
  return (m ? m[1] : s).trim();
}

/**
 * Runs generated code in a separate Node with the permission model on and no grants: no files, no
 * child processes, no workers, no addons (and no network modules are reachable without them).
 */
export function runSandboxed(code: string, tail: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--permission', '--disable-warning=ExperimentalWarning', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: {} });
    let out = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-2000)));
    p.on('error', () => resolve(''));
    p.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    p.stdin.end(`${code}\n;${tail}`);
  });
}

export const PROBES: Record<'chat' | 'coding' | 'vision' | 'embeddings', Probe[]> = {
  chat: [
    { id: 'follow', ask: 'Reply with exactly one word: banana', check: (a) => /^\W*banana\W*$/i.test(a.trim()) },
    { id: 'math', ask: 'What is 17 × 23? Reply with only the number.', check: (a) => /(^|\D)391(\D|$)/.test(a) },
    { id: 'json', ask: 'Give the capital of France as JSON like {"capital": "..."} and nothing else.', check: (a) => /paris/i.test(String(jsonIn(a)?.capital ?? '')) },
  ],
  coding: [
    {
      id: 'code',
      ask: 'Write a JavaScript function named isPalindrome(s) that returns true when s reads the same backwards, ignoring upper and lower case. Reply with only the code.',
      check: async (a) => (await runSandboxed(codeIn(a), 'console.log(JSON.stringify([isPalindrome("Racecar"), isPalindrome("abc"), isPalindrome("Noon")]))')) === '[true,false,true]',
    },
    { id: 'math', ask: 'What is 17 × 23? Reply with only the number.', check: (a) => /(^|\D)391(\D|$)/.test(a) },
  ],
  vision: [{ id: 'color', ask: 'What color is this picture? Reply with one word.', image: true, check: (a) => /\bred\b/i.test(a) }],
  embeddings: [{ id: 'meaning', check: () => true }],
};

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A 64×64 plain red PNG, made here (no picture files shipped). */
export function redPng(size = 64): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([220, 30, 30]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const isLoopback = (root: string) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(root);
const cos = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

/** Runs one job's probes on one model in the Ollama at `root` (this computer only). */
export async function runModel(root: string, model: string, job: FreeJob, fetchImpl: typeof fetch): Promise<Omit<RecheckResult, 'at'>> {
  if (!isLoopback(root)) throw new Error('The re-check only runs on this computer.');
  if (isCloudModelName(model)) throw new Error('The re-check never uses cloud models.');
  const started = Date.now();
  const failed: string[] = [];
  const base = root.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  if (job === 'embeddings') {
    try {
      const r = await fetchImpl(`${base}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: ['a small cat asleep on the sofa', 'a kitten napping on the couch', 'quarterly tax payment deadline'] }), signal: AbortSignal.timeout(CALL_MS) });
      const e = ((await r.json()) as { embeddings?: number[][] }).embeddings ?? [];
      if (!(e.length === 3 && cos(e[0], e[1]) > cos(e[0], e[2]) + 0.05)) failed.push('meaning');
    } catch {
      failed.push('meaning');
    }
    return { model, job, passed: 1 - failed.length, of: 1, ms: Date.now() - started, failed };
  }
  const probes = PROBES[job as 'chat' | 'coding' | 'vision'];
  if (!probes) throw new Error(`No re-check for ${job}.`);
  for (const p of probes) {
    try {
      const msg: { role: string; content: string; images?: string[] } = { role: 'user', content: p.ask ?? '' };
      if (p.image) msg.images = [redPng().toString('base64')];
      const r = await fetchImpl(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [msg], stream: false, think: false, options: { temperature: 0, num_predict: 400 } }), signal: AbortSignal.timeout(CALL_MS) });
      const answer = String(((await r.json()) as { message?: { content?: string } }).message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
      if (!(await p.check(answer))) failed.push(p.id);
    } catch {
      failed.push(p.id);
    }
  }
  return { model, job, passed: probes.length - failed.length, of: probes.length, ms: Date.now() - started, failed };
}

export interface RecheckDeps {
  dataDir: string;
  /** Ollama's address on this computer (src/local-models.ts ollamaRoot). */
  root: () => string;
  fetch: typeof fetch;
  now: () => Date;
  ollama: () => Promise<OllamaStatus>;
  /** When someone last talked to her (ms); the monthly run waits for 20 quiet minutes. */
  lastActivity: () => number;
  list?: FreeModelList;
}

interface State {
  on: boolean;
  lastRun?: string;
  results: Record<string, RecheckResult>;
}

export class ModelRecheck {
  readonly #d: RecheckDeps;
  #state: State;
  #running: Promise<{ results: RecheckResult[] }> | undefined;

  constructor(d: RecheckDeps) {
    this.#d = d;
    this.#state = { on: false, results: {} };
    const f = join(d.dataDir, RECHECK_FILE);
    try {
      if (existsSync(f)) {
        const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<State>;
        this.#state = { on: j.on === true, ...(j.lastRun ? { lastRun: j.lastRun } : {}), results: j.results && typeof j.results === 'object' ? j.results : {} };
      }
    } catch {
      /* a broken file: start fresh */
    }
  }

  #save(): void {
    writeFileAtomic(join(this.#d.dataDir, RECHECK_FILE), `${JSON.stringify(this.#state, null, 1)}\n`);
  }

  view(): { on: boolean; lastRun: string | null; running: boolean; results: Record<string, RecheckResult> } {
    return { on: this.#state.on, lastRun: this.#state.lastRun ?? null, running: Boolean(this.#running), results: { ...this.#state.results } };
  }

  setOn(on: boolean): void {
    this.#state.on = on;
    this.#save();
  }

  get running(): boolean {
    return Boolean(this.#running);
  }

  /** Starts a run (or joins the one going). */
  run(): Promise<{ results: RecheckResult[] }> {
    this.#running ??= this.#run().finally(() => (this.#running = undefined));
    return this.#running;
  }

  async #run(): Promise<{ results: RecheckResult[] }> {
    const list = this.#d.list ?? FREE_MODELS;
    const ollama = await this.#d.ollama();
    const root = this.#d.root();
    const pairs: { id: string; model: string; job: FreeJob }[] = [];
    if (ollama.found !== false) {
      for (const m of list.models) {
        if (m.how !== 'ollama' || !(m.job in PROBES)) continue;
        const at = installedAs(m, ollama);
        if (at && !isCloudModelName(at)) pairs.push({ id: m.id, model: at, job: m.job });
      }
    }
    // The same build in two jobs with the same probes (gpt-oss chat and coding) is asked once per job.
    const out: RecheckResult[] = [];
    const done = new Map<string, Omit<RecheckResult, 'at'>>();
    for (const p of pairs.slice(0, MAX_PAIRS)) {
      const key = `${p.model}|${p.job}`;
      const r = done.get(key) ?? (await runModel(root, p.model, p.job, this.#d.fetch));
      done.set(key, r);
      const row: RecheckResult = { ...r, at: this.#d.now().toISOString() };
      this.#state.results[p.id] = row;
      out.push(row);
    }
    this.#state.lastRun = this.#d.now().toISOString();
    this.#save();
    return { results: out };
  }

  /** Monthly: on, a month since the last run, nobody talking for 20 minutes. True when it ran. */
  async tick(): Promise<boolean> {
    if (!this.#state.on || this.#running) return false;
    const now = this.#d.now().getTime();
    if (this.#state.lastRun && now - Date.parse(this.#state.lastRun) < MONTH_MS) return false;
    if (now - this.#d.lastActivity() < IDLE_MS) return false;
    await this.run();
    return true;
  }
}

const per = new WeakMap<object, ModelRecheck>();
/** The parts of an app the re-check reads (AppContext fits). */
export interface RecheckApp {
  dataDir: string;
  now: () => Date;
  settings: { get(): { providers: ProviderConfig[] } };
  store: { db: { prepare(sql: string): { get(): unknown } } };
}
/** One re-check per app (the owner's main space); built on first use, real Ollama on this computer. */
export function recheckOf(app: RecheckApp): ModelRecheck {
  let r = per.get(app);
  if (!r) {
    const root = () => ollamaRoot(app.settings.get().providers);
    r = new ModelRecheck({
      dataDir: app.dataDir,
      root,
      fetch: netFetch,
      now: () => app.now(),
      ollama: () => firstTenDeps.ollama(root()),
      lastActivity: () => {
        const row = app.store.db.prepare('SELECT MAX(created_at) AS t FROM messages').get() as { t: string | null } | undefined;
        return row?.t ? Date.parse(row.t) : 0;
      },
    });
    per.set(app, r);
  }
  return r;
}
