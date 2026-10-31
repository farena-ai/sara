// Phase 78 (harness track M3, docs/design/HARNESS_TRACK.md §2.1, §3 M3, risks 1/2/3/6/11): run
// snapshots. One run = one chat turn, one background job or one team task; one step = one model call
// plus the tool calls it asked for. Each step keeps the model, tokens in/out, cost estimate (the
// existing usage meter's own numbers), latency, the system prompt (by hash, deflated, in
// `run_blobs`), the history as a message-id range (never copied), the memory picks + policy id,
// tool calls with scrubbed arguments, status, a clipped scrubbed output, duration, the approval /
// contradiction outcome and the files touched (chat mode: the undo snapshot ids; coding mode: git
// HEAD + hashes of dirty files, risk 3).
//
// Recording never breaks the work it records: every write is wrapped and a failing recorder goes
// quiet. A turn's recorder is passed EXPLICITLY (risk 1: AsyncLocalStorage doesn't carry into code
// resumed by the caller's next()); jobs and team runs keep their AsyncLocalStorage usage scope and
// the scope carries the recorder (`UsageScope.run`).
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { ChatMessage, Provider } from './providers/types.ts';
import type { ToolCall } from './providers/types.ts';
import { billingOf, costOf, findPrice, priceTable, type Billing, type CallInfo, type UsageStore } from './usage.ts';

/** Phase 81: 'security' = a security pass or a fix-branch run (src/security/). */
export type RunKind = 'turn' | 'job' | 'team' | 'eval' | 'redteam' | 'security';
export type RunStatus = 'running' | 'ok' | 'error' | 'stopped' | 'blocked' | 'budget' | 'limit' | 'interrupted';

/** One provider call inside a step. `usd` null = cost unknown (no price, or the model reported no usage). */
export interface ModelCall {
  model: string;
  provider: string;
  providerId: string;
  /** What the call was for when it isn't the step's main call ('safety check', 'claim judge', 'plan judge'). */
  purpose?: string;
  /** api / local / subscription (local and subscription calls cost $0). */
  billing?: Billing;
  in: number;
  out: number;
  cached: number;
  usd: number | null;
  /** Did the provider report token counts (false = "cost unknown", not 0). */
  reported: boolean;
  ms: number;
  /** Time to the first streamed event. */
  firstMs?: number;
  ok: boolean;
  error?: string;
}

/** One tool call of a step, as stored (arguments and output already scrubbed). */
export interface ToolStep {
  id: string;
  name: string;
  summary: string;
  args: Record<string, unknown>;
  status: 'ok' | 'error' | 'denied';
  /** Clipped (OUTPUT_CLIP) and scrubbed. */
  output: string;
  /** Full length before clipping. */
  outputChars: number;
  ms: number;
  /** auto (ran without asking) · allowed / denied (the owner answered) · refused (never / not available here). */
  approval?: 'auto' | 'allowed' | 'denied' | 'refused';
  /** Phase 77 findings for this call (flags and stops with the owner's answer). */
  contradictions?: unknown[];
  /** Paths the call names (file tools), relative to the workspace. */
  files?: string[];
  /** Chat mode: the undo snapshot taken before it. */
  snapshotId?: string;
  messageId?: number;
  /**
   * Phase 80: the sandbox try (src/sandbox-run.ts SandboxRecord): isolation, diff, findings, the
   * owner's choice, and for an Apply the M3 workspace manifest before and after.
   */
  sandbox?: unknown;
  /** Phase 87: step thumbnails from her hands (hashes in run_thumbs; GET /api/computer/thumb/<hash>). */
  thumbs?: string[];
}

/** Coding mode: the light workspace manifest (risk 3): HEAD and the dirty files' hashes. */
export interface WorkspaceRef {
  head?: string;
  branch?: string;
  dirty?: { path: string; sha?: string; size?: number; gone?: true }[];
  /** More dirty files than were hashed. */
  more?: number;
  error?: string;
}

export interface StepInfo {
  model?: string;
  provider?: string;
  /** The system prompt (scrubbed by the caller); stored once per distinct text. */
  system?: string;
  historyFromId?: number;
  historyToId?: number;
  /** Short system notes added after the history (corrections, flags), kept whole. */
  extra?: string[];
  memoryPicks?: unknown[];
  policyId?: string;
  /** A label for steps that aren't a chat-loop pass (\"Coder: write the tests\", \"Job #4\"). */
  label?: string;
  /** Phase 83: sha256 of the history + notes sent (scrubbed), so a replay can say whether it rebuilt them exactly. */
  inputsSha?: string;
  /** Phase 96: the skills loaded in the conversation at this step (up front or with skill_use). */
  skills?: string[];
}

export interface RunSettings {
  /** Days to keep runs (0 = until deleted). */
  keepDays: number;
  /** Size cap in MB for the whole run history (oldest go first). */
  maxMb: number;
}
export const KEEP_DAY_CHOICES = [30, 90, 365, 0] as const;
export const DEFAULT_RUN_SETTINGS: RunSettings = { keepDays: 90, maxMb: 200 };
/** Runs kept per conversation, whatever the age (like the snapshot store's KEEP). */
export const KEEP_PER_CONVERSATION = 500;
export const OUTPUT_CLIP = 4000;

export function runSettings(s: { runs?: Partial<RunSettings> } | undefined): RunSettings {
  const r = s?.runs ?? {};
  const keepDays = KEEP_DAY_CHOICES.includes(Number(r.keepDays) as (typeof KEEP_DAY_CHOICES)[number]) ? Number(r.keepDays) : DEFAULT_RUN_SETTINGS.keepDays;
  const mb = Number(r.maxMb);
  const maxMb = Number.isFinite(mb) && mb >= 10 ? Math.min(10_000, Math.round(mb)) : DEFAULT_RUN_SETTINGS.maxMb;
  return { keepDays, maxMb };
}

type Row = Record<string, string | number | null | Uint8Array>;

export interface RunView {
  id: number;
  kind: RunKind;
  conversationId: string | null;
  userMessageId: number | null;
  replyMessageId: number | null;
  jobId: number | null;
  teamTaskId: number | null;
  parentRunId: number | null;
  branchedFromStep: number | null;
  title: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** Paid calls with no price, and calls that reported no usage: the cost is incomplete. */
  unpriced: number;
  unreported: number;
  ms: number;
  bytes: number;
  policy: Record<string, unknown> | null;
  /** Phase 79: the task's budget (a job's, a team task's limits, a turn's with how it ended). */
  budget: Record<string, unknown> | null;
  /** Phase 83 (M8): a branch's record (what was changed, the workspace copy, what couldn't be restored). */
  branch: Record<string, unknown> | null;
}

export interface StepView {
  idx: number;
  at: string;
  label: string | null;
  model: string | null;
  provider: string | null;
  systemSha: string | null;
  historyFromId: number | null;
  historyToId: number | null;
  calls: ModelCall[];
  tools: ToolStep[];
  memoryPicks: unknown[];
  policyId: string | null;
  contradictions: unknown[];
  workspaceRef: WorkspaceRef | null;
  files: string[];
  tokensIn: number;
  tokensOut: number;
  usd: number;
  unpriced: number;
  unreported: number;
  ms: number;
  stopped: string | null;
  replyMessageId: number | null;
  extra: string[];
  /** Phase 83: hash of the history + notes sent (null for steps recorded before 2.16). */
  inputsSha: string | null;
  /** Phase 96: the skills loaded at this step (empty before 2.29). */
  skills: string[];
}

/** Phase 83: one message of a branch, kept in the run record (never in the conversation). */
export interface RunMessage {
  id: number;
  role: string;
  content: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Phase 87: screen thumbnails are kept 30 days (COMPUTER_USE.md §6.5). */
export const THUMB_DAYS = 30;

export class RunStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  /** Settings (read on every prune so a change applies at once). */
  settings: () => RunSettings = () => DEFAULT_RUN_SETTINGS;
  /** The usage meter (prices), when there is one. */
  usage?: UsageStore;
  #lastPrune = 0;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      user_message_id INTEGER,
      reply_message_id INTEGER,
      job_id INTEGER,
      team_task_id INTEGER,
      parent_run_id INTEGER,
      branched_from_step INTEGER,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      steps INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL DEFAULT 0,
      unpriced INTEGER NOT NULL DEFAULT 0,
      unreported INTEGER NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      budget TEXT,
      policy TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_conv ON runs(conversation_id, id);
    CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
    CREATE INDEX IF NOT EXISTS runs_job ON runs(job_id);
    CREATE INDEX IF NOT EXISTS runs_team ON runs(team_task_id);
    CREATE TABLE IF NOT EXISTS run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      at TEXT NOT NULL,
      label TEXT,
      model TEXT,
      provider TEXT,
      system_sha TEXT,
      history_from_id INTEGER,
      history_to_id INTEGER,
      extra TEXT,
      memory_picks TEXT,
      policy_id TEXT,
      calls TEXT,
      tool_calls TEXT,
      tool_message_ids TEXT,
      files_touched TEXT,
      workspace_ref TEXT,
      contradictions TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL DEFAULT 0,
      unpriced INTEGER NOT NULL DEFAULT 0,
      unreported INTEGER NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL DEFAULT 0,
      stopped TEXT,
      reply_message_id INTEGER,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS run_steps_idx ON run_steps(run_id, idx);
    CREATE TABLE IF NOT EXISTS run_blobs (
      sha TEXT PRIMARY KEY,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL
    );`);
    // Phase 83 (M8, additive): a branch's record, the hash of what a step was sent, and the
    // messages of a branch (kept with its run, never in the conversation).
    const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((r) => String(r.name)));
    if (!cols('runs').has('branch')) db.exec('ALTER TABLE runs ADD COLUMN branch TEXT');
    if (!cols('run_steps').has('inputs_sha')) db.exec('ALTER TABLE run_steps ADD COLUMN inputs_sha TEXT');
    // Phase 96 (additive): which skills were loaded at each step.
    if (!cols('run_steps').has('skills')) db.exec('ALTER TABLE run_steps ADD COLUMN skills TEXT');
    // Phase 87 (additive): step thumbnails of computer use (320 px JPEGs, redacted on the device),
    // kept by hash with their run; a shorter retention than the run itself (30 days).
    db.exec(`CREATE TABLE IF NOT EXISTS run_thumbs (
      sha TEXT NOT NULL,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_idx INTEGER NOT NULL DEFAULT 0,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (sha, run_id)
    );
    CREATE INDEX IF NOT EXISTS run_thumbs_sha ON run_thumbs(sha);
    CREATE INDEX IF NOT EXISTS run_thumbs_created ON run_thumbs(created_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS run_messages (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, id)
    );
    CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_run_id);`);
    // Runs that were open when the server stopped did not finish.
    try {
      db.prepare("UPDATE runs SET status = 'interrupted', ended_at = COALESCE(ended_at, ?) WHERE status = 'running'").run(now().toISOString());
    } catch {
      /* read-only copy */
    }
  }

  /** Opens a run (0 when it can't be recorded: the conversation is gone, the disk is full…). */
  open(init: { kind: RunKind; conversationId?: string | null; userMessageId?: number | null; jobId?: number | null; teamTaskId?: number | null; parentRunId?: number | null; branchedFromStep?: number | null; title?: string; policy?: Record<string, unknown>; budget?: unknown }): number {
    try {
      const r = this.#db
        .prepare('INSERT INTO runs (kind, conversation_id, user_message_id, job_id, team_task_id, parent_run_id, branched_from_step, title, started_at, policy, budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(init.kind, init.conversationId ?? null, init.userMessageId ?? null, init.jobId ?? null, init.teamTaskId ?? null, init.parentRunId ?? null, init.branchedFromStep ?? null, (init.title ?? '').slice(0, 200), this.#now().toISOString(), j(init.policy), j(init.budget));
      return Number(r.lastInsertRowid);
    } catch {
      return 0;
    }
  }

  /** Stores a text once by its hash (deflated). Returns the hash and how many new bytes were written. */
  putBlob(text: string): { sha: string; added: number } {
    const sha = createHash('sha256').update(text).digest('hex');
    const had = this.#db.prepare('SELECT 1 FROM run_blobs WHERE sha = ?').get(sha);
    if (had) return { sha, added: 0 };
    const bytes = deflateRawSync(Buffer.from(text, 'utf8'));
    this.#db.prepare('INSERT OR IGNORE INTO run_blobs (sha, bytes, size) VALUES (?, ?, ?)').run(sha, bytes, Buffer.byteLength(text));
    return { sha, added: bytes.length };
  }

  /** Phase 87: a step thumbnail (kept with its run). Returns its hash, or undefined when it can't be kept. */
  putThumb(runId: number, stepIdx: number, data: Buffer, mime: string): string | undefined {
    if (!runId || !data.length || data.length > 512 * 1024 || (mime !== 'image/jpeg' && mime !== 'image/png')) return undefined;
    const sha = createHash('sha256').update(data).digest('hex');
    try {
      this.#db.prepare('INSERT OR IGNORE INTO run_thumbs (sha, run_id, step_idx, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(sha, runId, stepIdx, mime, data, this.#now().toISOString());
      return sha;
    } catch {
      return undefined;
    }
  }

  /** Phase 87: a step thumbnail by its hash. */
  thumb(sha: string): { mime: string; data: Buffer } | undefined {
    if (!/^[0-9a-f]{64}$/.test(sha)) return undefined;
    const r = this.#db.prepare('SELECT mime, bytes FROM run_thumbs WHERE sha = ? LIMIT 1').get(sha) as { mime: string; bytes: Uint8Array } | undefined;
    return r ? { mime: r.mime, data: Buffer.from(r.bytes) } : undefined;
  }

  blob(sha: string): string | undefined {
    const r = this.#db.prepare('SELECT bytes FROM run_blobs WHERE sha = ?').get(sha) as { bytes: Uint8Array } | undefined;
    return r ? inflateRawSync(r.bytes).toString('utf8') : undefined;
  }

  // ---- writes used by the recorder: one INSERT per step, when it ends (each write is a commit) ----
  writeStep(runId: number, idx: number, info: StepInfo, at: string, sha: string | null, s: { model?: string | null; provider?: string | null; calls: ModelCall[]; tools: ToolStep[]; files: string[]; contradictions: unknown[]; stopped?: string | null; replyMessageId?: number | null }): number {
    const sum = sumCalls(s.calls);
    const calls = j(s.calls.length ? s.calls : null);
    const tools = j(s.tools.length ? s.tools : null);
    const files = j(s.files.length ? s.files : null);
    const contra = j(s.contradictions.length ? s.contradictions : null);
    const extra = info.extra?.length ? JSON.stringify(info.extra) : null;
    const picks = info.memoryPicks?.length ? JSON.stringify(info.memoryPicks) : null;
    const msgIds = s.tools.map((t) => t.messageId).filter((x): x is number => Boolean(x));
    const bytes = (calls?.length ?? 0) + (tools?.length ?? 0) + (files?.length ?? 0) + (contra?.length ?? 0) + (extra?.length ?? 0) + (picks?.length ?? 0) + 300;
    this.#db
      .prepare('INSERT INTO run_steps (run_id, idx, at, label, model, provider, system_sha, history_from_id, history_to_id, extra, memory_picks, policy_id, calls, tool_calls, tool_message_ids, files_touched, contradictions, tokens_in, tokens_out, usd, unpriced, unreported, ms, stopped, reply_message_id, bytes, inputs_sha, skills) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, idx, at, info.label?.slice(0, 200) ?? null, s.model ?? info.model ?? null, s.provider ?? info.provider ?? null, sha, info.historyFromId ?? null, info.historyToId ?? null, extra, picks, info.policyId ?? null, calls, tools, msgIds.length ? JSON.stringify(msgIds) : null, files, contra, sum.in, sum.out, sum.usd, sum.unpriced, sum.unreported, sum.ms, s.stopped ?? null, s.replyMessageId ?? null, bytes, info.inputsSha ?? null, info.skills?.length ? JSON.stringify(info.skills.slice(0, 50)) : null);
    return bytes;
  }

  setWorkspaceRef(runId: number, idx: number, ref: WorkspaceRef): void {
    try {
      const v = JSON.stringify(ref);
      this.#db.prepare('UPDATE run_steps SET workspace_ref = ?, bytes = bytes + ? WHERE run_id = ? AND idx = ?').run(v, v.length, runId, idx);
      this.#db.prepare('UPDATE runs SET bytes = bytes + ? WHERE id = ?').run(v.length, runId);
    } catch {
      /* the run may have been pruned meanwhile */
    }
  }

  patchRun(id: number, p: { userMessageId?: number; replyMessageId?: number; title?: string; policy?: Record<string, unknown> }): void {
    if (p.userMessageId !== undefined) this.#db.prepare('UPDATE runs SET user_message_id = ? WHERE id = ?').run(p.userMessageId, id);
    if (p.replyMessageId !== undefined) this.#db.prepare('UPDATE runs SET reply_message_id = ? WHERE id = ?').run(p.replyMessageId, id);
    if (p.title !== undefined) this.#db.prepare('UPDATE runs SET title = ? WHERE id = ?').run(p.title.slice(0, 200), id);
    if (p.policy !== undefined) this.#db.prepare('UPDATE runs SET policy = ? WHERE id = ?').run(JSON.stringify(p.policy), id);
  }

  /** Closes a run: totals from its steps (and what the recorder kept for the end: one write). */
  close(id: number, status: RunStatus, bytes: number, startedMs: number, patch: { userMessageId?: number; replyMessageId?: number; policy?: Record<string, unknown>; budget?: unknown } = {}): void {
    if (patch.userMessageId !== undefined || patch.replyMessageId !== undefined || patch.policy !== undefined || patch.budget !== undefined) this.#db.prepare('UPDATE runs SET user_message_id = COALESCE(?, user_message_id), reply_message_id = COALESCE(?, reply_message_id), policy = COALESCE(?, policy), budget = COALESCE(?, budget) WHERE id = ?').run(patch.userMessageId ?? null, patch.replyMessageId ?? null, patch.policy ? JSON.stringify(patch.policy) : null, patch.budget !== undefined ? JSON.stringify(patch.budget) : null, id);
    const t = this.#db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in),0) AS i, COALESCE(SUM(tokens_out),0) AS o, COALESCE(SUM(usd),0) AS u, COALESCE(SUM(unpriced),0) AS up, COALESCE(SUM(unreported),0) AS ur, COALESCE(SUM(bytes),0) AS b FROM run_steps WHERE run_id = ?').get(id) as Row;
    this.#db
      .prepare('UPDATE runs SET status = ?, ended_at = ?, steps = ?, tokens_in = ?, tokens_out = ?, usd = ?, unpriced = ?, unreported = ?, ms = ?, bytes = ? WHERE id = ?')
      .run(status, this.#now().toISOString(), Number(t.n), Number(t.i), Number(t.o), Math.round(Number(t.u) * 1e8) / 1e8, Number(t.up), Number(t.ur), Math.max(0, Date.now() - startedMs), Math.max(bytes, Number(t.b)), id);
  }

  // ---- reads ----
  #run(r: Row): RunView {
    return {
      id: Number(r.id),
      kind: String(r.kind) as RunKind,
      conversationId: (r.conversation_id as string | null) ?? null,
      userMessageId: r.user_message_id === null ? null : Number(r.user_message_id),
      replyMessageId: r.reply_message_id === null ? null : Number(r.reply_message_id),
      jobId: r.job_id === null ? null : Number(r.job_id),
      teamTaskId: r.team_task_id === null ? null : Number(r.team_task_id),
      parentRunId: r.parent_run_id === null ? null : Number(r.parent_run_id),
      branchedFromStep: r.branched_from_step === null ? null : Number(r.branched_from_step),
      title: String(r.title ?? ''),
      startedAt: String(r.started_at),
      endedAt: (r.ended_at as string | null) ?? null,
      status: String(r.status) as RunStatus,
      steps: Number(r.steps),
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      usd: Number(r.usd),
      unpriced: Number(r.unpriced),
      unreported: Number(r.unreported),
      ms: Number(r.ms),
      bytes: Number(r.bytes),
      policy: parse<Record<string, unknown> | null>(r.policy, null),
      budget: parse<Record<string, unknown> | null>(r.budget, null),
      branch: parse<Record<string, unknown> | null>(r.branch, null),
    };
  }

  #step(r: Row): StepView {
    const tools = parse<ToolStep[]>(r.tool_calls, []);
    const files = parse<string[]>(r.files_touched, []);
    return {
      idx: Number(r.idx),
      at: String(r.at),
      label: (r.label as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      systemSha: (r.system_sha as string | null) ?? null,
      historyFromId: r.history_from_id === null ? null : Number(r.history_from_id),
      historyToId: r.history_to_id === null ? null : Number(r.history_to_id),
      calls: parse<ModelCall[]>(r.calls, []),
      tools,
      memoryPicks: parse<unknown[]>(r.memory_picks, []),
      policyId: (r.policy_id as string | null) ?? null,
      contradictions: parse<unknown[]>(r.contradictions, []),
      workspaceRef: parse<WorkspaceRef | null>(r.workspace_ref, null),
      files,
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      usd: Number(r.usd),
      unpriced: Number(r.unpriced),
      unreported: Number(r.unreported),
      ms: Number(r.ms),
      stopped: (r.stopped as string | null) ?? null,
      replyMessageId: r.reply_message_id === null ? null : Number(r.reply_message_id),
      extra: parse<string[]>(r.extra, []),
      inputsSha: (r.inputs_sha as string | null | undefined) ?? null,
      skills: parse<string[]>(r.skills, []),
    };
  }

  get(id: number): RunView | undefined {
    const r = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#run(r) : undefined;
  }

  list(opts: { conversationId?: string; limit?: number; before?: number } = {}): RunView[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    const rows = (opts.conversationId ? this.#db.prepare('SELECT * FROM runs WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(opts.conversationId, before, limit) : this.#db.prepare('SELECT * FROM runs WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)) as Row[];
    return rows.map((r) => this.#run(r));
  }

  steps(runId: number): StepView[] {
    return (this.#db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as Row[]).map((r) => this.#step(r));
  }

  step(runId: number, idx: number): StepView | undefined {
    const r = this.#db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND idx = ?').get(runId, idx) as Row | undefined;
    return r ? this.#step(r) : undefined;
  }

  /** The run a message belongs to (its reply or one of its steps' replies). Branches never (their ids are their own). */
  forMessage(messageId: number): RunView | undefined {
    const r = (this.#db.prepare('SELECT * FROM runs WHERE (reply_message_id = ? OR user_message_id = ?) AND parent_run_id IS NULL ORDER BY id DESC LIMIT 1').get(messageId, messageId) ?? this.#db.prepare('SELECT r.* FROM runs r JOIN run_steps s ON s.run_id = r.id WHERE s.reply_message_id = ? AND r.parent_run_id IS NULL ORDER BY r.id DESC LIMIT 1').get(messageId)) as Row | undefined;
    return r ? this.#run(r) : undefined;
  }

  // ---- Phase 83 (M8): branches ----
  /** The branches made from a run (newest first). */
  branches(parentId: number): RunView[] {
    return (this.#db.prepare('SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id DESC LIMIT 50').all(parentId) as Row[]).map((r) => this.#run(r));
  }

  /** A branch's record (merged into what is there). */
  setBranch(id: number, patch: Record<string, unknown>): void {
    try {
      const cur = this.get(id)?.branch ?? {};
      this.#db.prepare('UPDATE runs SET branch = ? WHERE id = ?').run(JSON.stringify({ ...cur, ...patch }), id);
    } catch {
      /* pruned meanwhile */
    }
  }

  /** A branch's messages, kept with its run (one transaction; texts over 20,000 characters clipped). */
  putMessages(runId: number, msgs: { id: number; role: string; content: string; createdAt: string; meta?: Record<string, unknown> }[]): number {
    const ins = this.#db.prepare('INSERT OR REPLACE INTO run_messages (run_id, id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    let bytes = 0;
    this.#db.exec('BEGIN');
    try {
      for (const m of msgs) {
        const content = m.content.length > 20_000 ? `${m.content.slice(0, 20_000)}\n[… ${m.content.length - 20_000} more characters]` : m.content;
        const meta = m.meta ? JSON.stringify(m.meta) : null;
        bytes += content.length + (meta?.length ?? 0) + 40;
        ins.run(runId, m.id, m.role, content, meta, m.createdAt);
      }
      this.#db.prepare('UPDATE runs SET bytes = bytes + ? WHERE id = ?').run(bytes, runId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return bytes;
  }

  runMessages(runId: number): RunMessage[] {
    return (this.#db.prepare('SELECT * FROM run_messages WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({ id: Number(r.id), role: String(r.role), content: String(r.content), createdAt: String(r.created_at), ...(r.meta ? { meta: parse<Record<string, unknown>>(r.meta, {}) } : {}) }));
  }

  /** For the health line: how many runs and how much room they take (rows + blobs). */
  stats(): { runs: number; steps: number; bytes: number } {
    const r = this.#db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM runs').get() as Row;
    const s = this.#db.prepare('SELECT COUNT(*) AS n FROM run_steps').get() as Row;
    const b = this.#db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS b FROM run_blobs').get() as Row;
    return { runs: Number(r.n), steps: Number(s.n), bytes: Number(r.b) + Number(b.b) };
  }

  /** Runs that must be kept whatever the age (parents of a branch; M8/M9 add eval runs). */
  /** Phase 84 (M9): another table's run ids to keep as well (the eval loop's runs while their eval exists). */
  keepAlso?: string;
  get #pinned(): string {
    return `id NOT IN (SELECT parent_run_id FROM runs WHERE parent_run_id IS NOT NULL)${this.keepAlso ? ` AND id NOT IN (${this.keepAlso})` : ''}`;
  }

  /**
   * Retention: runs older than the setting go (never a branch parent), then each conversation keeps
   * its newest KEEP_PER_CONVERSATION, then the oldest go until the whole history is under the size
   * cap; prompts no step uses any more are dropped. Returns how many runs were removed.
   */
  prune(force = false): number {
    const now = Date.now();
    if (!force && now - this.#lastPrune < 10 * 60_000) return 0;
    this.#lastPrune = now;
    const cfg = this.settings();
    let removed = 0;
    try {
      if (cfg.keepDays > 0) {
        const cut = new Date(this.#now().getTime() - cfg.keepDays * 86_400_000).toISOString();
        removed += Number(this.#db.prepare(`DELETE FROM runs WHERE started_at < ? AND status <> 'running' AND ${this.#pinned}`).run(cut).changes);
      }
      removed += Number(
        this.#db
          .prepare(`DELETE FROM runs WHERE status <> 'running' AND ${this.#pinned} AND id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY id DESC) AS rn FROM runs WHERE conversation_id IS NOT NULL) WHERE rn > ?)`)
          .run(KEEP_PER_CONVERSATION).changes,
      );
      const cap = cfg.maxMb * 1024 * 1024;
      let total = this.stats().bytes;
      for (let round = 0; total > cap && round < 20; round++) {
        // The oldest runs whose sizes add up to what is over the cap (to 90% of it), at least one.
        const want = total - cap * 0.9;
        const ids: number[] = [];
        let freed = 0;
        for (const r of this.#db.prepare(`SELECT id, bytes FROM runs WHERE status <> 'running' AND ${this.#pinned} ORDER BY id`).iterate() as Iterable<Row>) {
          ids.push(Number(r.id));
          freed += Number(r.bytes);
          if (freed >= want) break;
        }
        if (!ids.length) break;
        const del = this.#db.prepare('DELETE FROM runs WHERE id = ?');
        this.#db.exec('BEGIN');
        try {
          for (const id of ids) removed += Number(del.run(id).changes);
          this.#db.exec('COMMIT');
        } catch (err) {
          this.#db.exec('ROLLBACK');
          throw err;
        }
        this.#dropOrphans();
        total = this.stats().bytes;
      }
      this.#dropOrphans();
      // Phase 87: screen thumbnails go after 30 days (or the runs' own setting, if shorter).
      const thumbDays = cfg.keepDays > 0 ? Math.min(cfg.keepDays, THUMB_DAYS) : THUMB_DAYS;
      this.#db.prepare('DELETE FROM run_thumbs WHERE created_at < ?').run(new Date(this.#now().getTime() - thumbDays * 86_400_000).toISOString());
    } catch (err) {
      console.warn(`runs: pruning failed: ${(err as Error).message}`);
    }
    return removed;
  }

  #dropOrphans(): void {
    this.#db.prepare('DELETE FROM run_blobs WHERE sha NOT IN (SELECT system_sha FROM run_steps WHERE system_sha IS NOT NULL)').run();
  }

  /** \"Delete run history\" (all, or one conversation's). */
  deleteAll(conversationId?: string): number {
    const n = Number((conversationId ? this.#db.prepare('DELETE FROM runs WHERE conversation_id = ? AND status <> \'running\'').run(conversationId) : this.#db.prepare("DELETE FROM runs WHERE status <> 'running'").run()).changes);
    this.#dropOrphans();
    return n;
  }

  /** For data export (with the optional flag): runs, steps and the prompts they use. */
  exportRows(): { runs: Row[]; steps: Row[]; prompts: { sha: string; text: string }[] } {
    const runs = this.#db.prepare('SELECT * FROM runs ORDER BY id').all() as Row[];
    const steps = this.#db.prepare('SELECT * FROM run_steps ORDER BY run_id, idx').all() as Row[];
    const prompts = (this.#db.prepare('SELECT sha FROM run_blobs').all() as Row[]).map((r) => ({ sha: String(r.sha), text: this.blob(String(r.sha)) ?? '' }));
    return { runs, steps, prompts };
  }

  /** Cost of a call from its usage numbers when no usage meter is set (tests, bare apps). */
  priceCall(config: Provider['config'], model: string, u: { input: number; output: number; cached?: number }): number | null {
    const table = this.usage ? this.usage.prices() : priceTable(undefined);
    return costOf(billingOf(config), findPrice(table, config.id, model), u);
  }
}

export function sumCalls(calls: ModelCall[]): { in: number; out: number; usd: number; unpriced: number; unreported: number; ms: number } {
  let i = 0;
  let o = 0;
  let usd = 0;
  let unpriced = 0;
  let unreported = 0;
  let ms = 0;
  for (const c of calls) {
    i += c.in;
    o += c.out;
    ms += c.ms;
    if (!c.reported) unreported++;
    else if (c.usd === null) unpriced++;
    else usd += c.usd;
  }
  return { in: i, out: o, usd: Math.round(usd * 1e8) / 1e8, unpriced, unreported, ms };
}

/** Files a call names (relative workspace paths), for file tools; shell and git are covered by the workspace ref. */
export function filesNamed(name: string, args: Record<string, unknown>): string[] {
  if (name === 'write_file' || name === 'edit_file' || name === 'apply_patch') {
    const p = args.path ?? args.file;
    return typeof p === 'string' && p ? [p.slice(0, 300)] : [];
  }
  return [];
}

// ------------------------------------------------------------------------------------------------
// Coding mode: the light workspace manifest (risk 3). HEAD from the .git files (no process), the
// dirty files from one `git status` started in the background so it never holds the turn up.
// ------------------------------------------------------------------------------------------------

/** HEAD's commit and branch, read from the repository's files (no git process). */
export function readHead(dir: string): { head?: string; branch?: string } {
  try {
    const gitDir = join(dir, '.git');
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return {};
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? { head } : {};
    const branch = ref.replace(/^refs\/heads\//, '');
    const loose = join(gitDir, ...ref.split('/'));
    if (resolve(loose).startsWith(resolve(gitDir) + sep) && existsSync(loose)) return { head: readFileSync(loose, 'utf8').trim(), branch };
    const packed = join(gitDir, 'packed-refs');
    if (existsSync(packed)) {
      const line = readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
      if (line) return { head: line.split(' ')[0], branch };
    }
    return { branch };
  } catch {
    return {};
  }
}

const GIT_READONLY = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'core.untrackedCache=false'];
const MAX_DIRTY = 200;
const MAX_HASH_BYTES = 2 * 1024 * 1024;

/** HEAD + the dirty files and their sha256 (files over 2 MB: size only). */
export async function workspaceRef(dir: string, timeoutMs = 5000): Promise<WorkspaceRef> {
  const { head, branch } = readHead(dir);
  if (!head && !branch) return {};
  const out = await new Promise<string>((res, rej) =>
    execFile('git', [...GIT_READONLY, 'status', '--porcelain', '-z', '--untracked-files=normal'], { cwd: dir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => (err ? rej(err) : res(stdout))),
  ).catch((err: Error) => ({ error: err.message.split('\n')[0].slice(0, 200) }));
  if (typeof out !== 'string') return { ...(head ? { head } : {}), ...(branch ? { branch } : {}), error: out.error };
  const paths: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    paths.push(p.slice(3));
    if (code[0] === 'R' || code[0] === 'C') i++; // the old name follows
  }
  const dirty: NonNullable<WorkspaceRef['dirty']> = [];
  for (const rel of paths.slice(0, MAX_DIRTY)) {
    const abs = join(dir, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_HASH_BYTES) dirty.push({ path: rel, size: st.size });
      else dirty.push({ path: rel, sha: createHash('sha256').update(await readFile(abs)).digest('hex').slice(0, 16), size: st.size });
    } catch {
      dirty.push({ path: rel, gone: true });
    }
  }
  return { ...(head ? { head } : {}), ...(branch ? { branch } : {}), dirty, ...(paths.length > MAX_DIRTY ? { more: paths.length - MAX_DIRTY } : {}) };
}

// ------------------------------------------------------------------------------------------------
// The recorder
// ------------------------------------------------------------------------------------------------

interface OpenStep {
  idx: number;
  info: StepInfo;
  at: string;
  sha: string | null;
  calls: ModelCall[];
  tools: ToolStep[];
  files: Set<string>;
  contradictions: unknown[];
  stopped: string | null;
  replyMessageId: number | null;
  workspaceRef?: WorkspaceRef | null;
}

/**
 * Records one run. Passed explicitly to the code that does the work (risk 1). A recorder made with
 * no store (off the record, demo visitors, a bare test app) does nothing. Timings: the recorder's
 * own time is counted in `overheadMs` (the bench and the test keep it under 5 ms a step).
 */
export class RunRecorder {
  readonly id: number;
  readonly #store?: RunStore;
  readonly #started = Date.now();
  #steps: OpenStep[] = [];
  #idx = -1;
  #bytes = 0;
  #closed = false;
  #pending: Promise<unknown>[] = [];
  #lastSystem = '';
  #lastSha: string | null = null;
  /** The recorder's own time in ms (perf check). */
  overheadMs = 0;
  /** Coding mode: the workspace folder whose manifest is taken per step. */
  workspaceDir?: string;

  constructor(store: RunStore | undefined, init: Parameters<RunStore['open']>[0]) {
    this.#store = store;
    this.id = store ? store.open(init) : 0;
  }

  static none(): RunRecorder {
    return new RunRecorder(undefined, { kind: 'turn' });
  }

  get on(): boolean {
    return Boolean(this.#store && this.id && !this.#closed);
  }

  #safe<T>(fn: () => T): T | undefined {
    if (!this.on) return undefined;
    const t0 = performance.now();
    try {
      return fn();
    } catch (err) {
      console.warn(`runs: recording failed: ${(err as Error).message}`);
      return undefined;
    } finally {
      this.overheadMs += performance.now() - t0;
    }
  }

  /** The step being recorded (opens one when a call arrives outside a step: jobs, team plans). */
  #cur(): OpenStep | undefined {
    return this.#steps.at(-1);
  }

  /** Phase 83: a branch's steps go on from the step it was made from (its first step is `idx`). */
  startAt(idx: number): void {
    if (this.#idx === -1 && Number.isInteger(idx) && idx > 0) this.#idx = idx - 1;
  }

  /** Opens a step (and ends the one before). */
  startStep(info: StepInfo): number {
    return this.#safe(() => this.#open(info)) ?? -1;
  }

  #open(info: StepInfo): number {
    {
      {
        this.#end();
        const idx = ++this.#idx;
        let sha: string | null = null;
        let added = 0;
        // The same prompt as the step before (the usual case): no hashing, no lookup.
        if (info.system && info.system === this.#lastSystem) sha = this.#lastSha;
        else if (info.system) {
          ({ sha, added } = this.#store!.putBlob(info.system));
          this.#lastSystem = info.system;
          this.#lastSha = sha;
        }
        this.#bytes += added;
        this.#steps.push({ idx, info: { ...info, system: undefined }, at: new Date().toISOString(), sha, calls: [], tools: [], files: new Set(), contradictions: [], stopped: null, replyMessageId: null });
        return idx;
      }
    }
  }

  /** One provider call (from the wrapped provider or the usage scope). */
  modelCall(c: ModelCall): void {
    this.#safe(() => {
      if (!this.#cur()) this.#open({ model: c.model, provider: c.provider, ...(c.purpose ? { label: c.purpose } : {}) });
      this.#cur()!.calls.push(c);
    });
  }

  /** Phase 87: keeps a step thumbnail with this run (its hash, or undefined when not recording). */
  thumb(data: Buffer, mime: string, stepIdx = this.#idx): string | undefined {
    return this.#safe(() => {
      const sha = this.#store!.putThumb(this.id, Math.max(0, stepIdx), data, mime);
      if (sha) this.#bytes += data.length;
      return sha;
    });
  }

  /** One tool call of the current step. */
  tool(t: Omit<ToolStep, 'output' | 'outputChars'> & { output: string }): void {
    this.#safe(() => {
      if (!this.#cur()) this.#open({ label: t.name });
      const s = this.#cur()!;
      s.tools.push({ ...t, output: t.output.length > OUTPUT_CLIP ? `${t.output.slice(0, OUTPUT_CLIP)}\n[… ${t.output.length - OUTPUT_CLIP} more characters]` : t.output, outputChars: t.output.length });
      for (const f of t.files ?? []) s.files.add(f);
      if (t.contradictions?.length) s.contradictions.push(...t.contradictions);
    });
  }

  /** The last model message saved in this run (the run link goes on it when the turn ends early). */
  lastReplyId = 0;

  /** Phase 79: how the run ended when it isn't plain ok (a turn stopped at its budget: 'budget'). */
  outcome?: RunStatus;

  /** The model's message of this step was saved (afterReply). */
  reply(messageId: number, patch: { contradictions?: unknown[]; stopped?: string } = {}): void {
    this.#safe(() => {
      this.lastReplyId = messageId;
      const s = this.#cur();
      if (!s) return;
      s.replyMessageId = messageId;
      if (patch.stopped) s.stopped = patch.stopped;
      if (patch.contradictions?.length) s.contradictions = patch.contradictions;
    });
  }

  /** Why this step stopped short (budget / contradiction / gate / minors block…). */
  stopped(reason: string): void {
    this.#safe(() => {
      const s = this.#cur();
      if (s) s.stopped = reason;
    });
  }

  #end(): void {
    const s = this.#cur();
    if (!s || (s as OpenStep & { ended?: boolean }).ended) return;
    (s as OpenStep & { ended?: boolean }).ended = true;
    const last = s.calls.at(-1);
    this.#bytes += this.#store!.writeStep(this.id, s.idx, s.info, s.at, s.sha, { model: last?.model ?? null, provider: last?.provider ?? null, calls: s.calls, tools: s.tools, files: [...s.files], contradictions: s.contradictions, stopped: s.stopped, replyMessageId: s.replyMessageId });
    // Coding mode: HEAD + dirty file hashes, in the background (never holds the turn up).
    if (this.workspaceDir && (s.idx === 0 || s.tools.some((t) => /^(shell|write_file|edit_file|apply_patch|delegate_task)$|^git_/.test(t.name) && t.status !== 'denied'))) {
      const dir = this.workspaceDir;
      const store = this.#store!;
      const id = this.id;
      this.#pending.push(workspaceRef(dir).then((ref) => store.setWorkspaceRef(id, s.idx, ref), () => undefined));
    }
  }

  /** Background work still running (tests wait for the workspace manifests). */
  async settled(): Promise<void> {
    await Promise.allSettled(this.#pending.splice(0));
  }

  #patch: { userMessageId?: number; policy?: Record<string, unknown>; budget?: unknown } = {};

  /** Phase 79: the turn's budget and how it ended (written with the run's close: one write). */
  setBudget(budget: unknown): void {
    this.#patch.budget = budget;
  }

  /**
   * Phase 79: what the run has spent so far, from every call recorded in its steps (the budget's
   * live sums): tokens in + out, dollars of the priced calls, paid calls with no price, calls that
   * reported nothing, and how the calls are paid for.
   */
  totals(): { tokens: number; usd: number; unpriced: number; unreported: number; billing: Billing[] } {
    let tokens = 0;
    let usd = 0;
    let unpriced = 0;
    let unreported = 0;
    const billing = new Set<Billing>();
    for (const st of this.#steps) {
      for (const c of st.calls) {
        tokens += c.in + c.out;
        if (c.billing) billing.add(c.billing);
        if (!c.reported) unreported++;
        else if (c.usd === null) unpriced++;
        else usd += c.usd;
      }
    }
    return { tokens, usd: Math.round(usd * 1e8) / 1e8, unpriced, unreported, billing: [...billing] };
  }

  /** Kept until the run closes (one write then). */
  setUserMessage(id: number): void {
    this.#patch.userMessageId = id;
  }

  setPolicy(policy: Record<string, unknown>): void {
    this.#patch.policy = policy;
  }

  /** Ends the run; `replyMessageId` is the message the run's \"Show the run\" link sits on. */
  close(status: RunStatus, replyMessageId?: number): void {
    this.#safe(() => {
      this.#end();
      this.#store!.close(this.id, status, this.#bytes, this.#started, { ...this.#patch, ...(replyMessageId ? { replyMessageId } : {}) });
      this.#closed = true;
      this.#store!.prune();
    });
  }

  /**
   * Wraps a provider so every call it makes is recorded in the current step (model, tokens in/out,
   * cost, latency). A provider from `metered()` is re-made with this run's id (its usage rows get
   * `run_id`, its price is the meter's own); any other provider's `usage` events are read here.
   */
  wrap(p: Provider, purpose?: string): Provider {
    if (!this.on) return p;
    const meter = (p as Provider & { meter?: { rewrap: (hook: { runId?: number; onCall: (c: CallInfo) => void }) => Provider } }).meter;
    if (meter) {
      const runId = this.id;
      return meter.rewrap({ runId, onCall: (c) => this.modelCall({ ...c, ...(purpose ? { purpose } : {}) }) });
    }
    const rec = this;
    const store = this.#store!;
    return {
      config: p.config,
      listModels: (signal?: AbortSignal) => p.listModels(signal),
      async *stream(req) {
        const t0 = Date.now();
        let first: number | undefined;
        let u: { input: number; output: number; cached?: number } | undefined;
        let ok = true;
        let error: string | undefined;
        try {
          for await (const ev of p.stream(req)) {
            first ??= Date.now() - t0;
            if (ev.type === 'usage') {
              u = ev;
              continue;
            }
            yield ev;
          }
        } catch (err) {
          ok = false;
          error = (err as Error).message.slice(0, 200);
          throw err;
        } finally {
          rec.modelCall({ model: req.model, provider: p.config.label, providerId: p.config.id, billing: billingOf(p.config), ...(purpose ? { purpose } : {}), in: u?.input ?? 0, out: u?.output ?? 0, cached: u?.cached ?? 0, usd: u ? store.priceCall(p.config, req.model, u) : null, reported: Boolean(u), ms: Date.now() - t0, ...(first !== undefined ? { firstMs: first } : {}), ok, ...(error ? { error } : {}) });
        }
      },
    };
  }
}

/** The history a step saw, rebuilt from the stored messages (for the step detail view). */
export function historyRange<T extends { id: number }>(messages: T[], fromId: number | null, toId: number | null): T[] {
  return messages.filter((m) => (fromId === null || fromId === 0 || m.id >= fromId) && (toId === null || m.id <= toId));
}

/**
 * Phase 83: one hash of what a step was sent after its system prompt (history + the app's notes):
 * role, text, tool calls and tool ids, pictures by size only. The recorder stores it; a replay
 * hashes what it rebuilt the same way, so \"rebuilt exactly\" is checked, not assumed.
 */
export function inputsHash(messages: readonly ChatMessage[]): string {
  const h = createHash('sha256');
  for (const m of messages) {
    const x = m as ChatMessage & { toolCalls?: unknown; toolCallId?: string; images?: { data?: string }[] };
    h.update(`${m.role}\u0000${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')}\u0000${x.toolCalls ? JSON.stringify(x.toolCalls) : ''}\u0000${x.toolCallId ?? ''}\u0000${(x.images ?? []).map((i) => String(i.data?.length ?? 0)).join(',')}\u0001`);
  }
  return h.digest('hex').slice(0, 32);
}

/** A hash of the tool set offered (the run policy, so M9 can compare tool sets). */
export function toolSetHash(names: string[]): string {
  return createHash('sha256').update([...names].sort().join(',')).digest('hex').slice(0, 10);
}

export type { ChatMessage, ToolCall };
