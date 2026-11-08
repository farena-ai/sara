// C10 (docs/ops/C10_DESIGN.md): workers that stay. A worker is a crew member (EC12) or a standalone
// helper that keeps going: a name and a character, its own thread in the conversation list, its own
// tool groups and a daily token budget, and a durable job queue in the space's store.db (one job at a
// time per worker, retries with backoff, a time limit). The team (src/team.ts) does the work: the
// worker is one more helper (`worker-<id>`), so approvals, the sandbox, receipts and run records are
// the team's. A job that keeps failing (or runs past its time) lands in Failed jobs, where the owner
// reads the reason and replays a copy or drops it. "Needs you": one alert per blocker (an approval
// waiting, the budget reached, repeated failure, a stop he did not ask for) to the chat app he used
// last (Telegram, Discord) or the app push, held in quiet hours, never twice. A lead hands jobs to the
// workers under it ("HAND TO <name>: <job>" lines) and their results bubble up to its thread. A worker
// (and the workers under it) exports as a bundle JSON: manifest, character, permissions and skill
// names, never secrets or thread ids, its memories (results) only when ticked; import shows a preview
// with the permission review and makes them paused. Owner-only; the crews pin covers it.
//
// Tables (additive): workers, worker_jobs, worker_alerts. Driven by the reminder tick (no timer).
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { quietNow } from './life.ts';
import { policy } from './policy-profile.ts';
import { teamHelpers, type HelperDef } from './team.ts';

export const WORKER = { maxWorkers: 12, maxQueued: 50, backoffMs: [60_000, 5 * 60_000, 30 * 60_000], minJobTokens: 10_000, maxBundle: 12, version: 1 } as const;
/** The tool groups a worker may be allowed (each a few of her tools). */
export const TOOL_GROUPS: Record<string, string[]> = {
  read: ['list_dir', 'read_file', 'search'],
  web: ['web_search', 'web_fetch'],
  write: ['write_file', 'edit_file'],
  shell: ['shell'],
  git: ['git'],
  agent: ['delegate_task'],
};
/** Tools the import review flags: they change files, run commands or hand work out. */
const RISKY = new Set(['write_file', 'edit_file', 'shell', 'git', 'delegate_task']);

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dropped';
export type AlertReason = 'approval' | 'budget' | 'failing' | 'stopped';
export interface Worker {
  id: number;
  name: string;
  character: string;
  helper: string;
  toolGroups: string[];
  skills: string[];
  dailyTokens: number;
  timeLimitMin: number;
  maxAttempts: number;
  leadId: number | null;
  crewId: number | null;
  state: 'on' | 'paused';
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}
export interface WorkerJob {
  id: number;
  workerId: number;
  title: string;
  input: string;
  status: JobStatus;
  attempts: number;
  nextAt: string | null;
  error: string | null;
  result: string | null;
  tokens: number;
  parentId: number | null;
  replayOf: number | null;
  replayedBy: number | null;
  teamTaskId: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}
export interface WorkerAlert {
  key: string;
  workerId: number;
  reason: AlertReason;
  title: string;
  text: string;
  channel: string | null;
  createdAt: string;
  sentAt: string | null;
}
export interface WorkerOutcome {
  status: 'done' | 'failed' | 'stopped';
  result: string;
  tokens: number;
  error?: string;
  teamTaskId?: number;
}
export interface WorkerHandle {
  done: Promise<WorkerOutcome>;
  stop: () => void;
  /** An approval is waiting for the owner. */
  waiting: () => boolean;
  teamTaskId?: number;
}
export type WorkerRunner = (w: Worker, job: WorkerJob, budget: { tokens: number; minutes: number }) => WorkerHandle;
export interface WorkersOptions {
  runner?: WorkerRunner;
  alert?: (a: { channel: string; title: string; text: string; conversationId: string; tag: string }) => Promise<boolean>;
  quiet?: () => boolean;
}
export interface BundleWorker {
  key: string;
  name: string;
  character: string;
  helper: string;
  role: string;
  toolGroups: string[];
  skills: string[];
  dailyTokens: number;
  timeLimitMin: number;
  maxAttempts: number;
  lead: string | null;
  memories?: string[];
}
export interface WorkerBundle {
  kind: 'sara-worker-bundle';
  version: number;
  manifest: { name: string; workers: number; exportedAt: string; memories: boolean };
  workers: BundleWorker[];
}

export class WorkerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, string | number | null>;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const int = (v: unknown, d: number, lo: number, hi: number) => (v === undefined || v === null || v === '' ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)) || d)));
const HAND_RE = /^\s*HAND TO ([^:\n]{1,40}):\s*(.{3,500})$/gim;

export class Workers {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: WorkersOptions;
  readonly #live = new Map<number, { handle: WorkerHandle; done: Promise<void>; why?: 'owner' | 'timeout' }>();

  constructor(app: AppContext, db: DatabaseSync, o: WorkersOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(`
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  character TEXT NOT NULL,
  helper TEXT NOT NULL,
  tool_groups TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  daily_tokens INTEGER NOT NULL,
  time_limit_min INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  lead_id INTEGER,
  crew_id INTEGER,
  state TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  error TEXT,
  result TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  day TEXT,
  parent_id INTEGER,
  replay_of INTEGER,
  replayed_by INTEGER,
  team_task_id INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_jobs_q ON worker_jobs(worker_id, status, id);
CREATE TABLE IF NOT EXISTS worker_alerts (
  key TEXT PRIMARY KEY,
  worker_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  channel TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`);
    // Durable across a restart: a job that was running goes back in the queue (its try counts).
    const iso = this.#now().toISOString();
    db.prepare("UPDATE worker_jobs SET status = 'queued', attempts = attempts + 1, error = 'interrupted by a restart', started_at = NULL, next_at = NULL WHERE status = 'running'").run();
    db.prepare("UPDATE worker_jobs SET status = 'failed', ended_at = ? WHERE status = 'queued' AND attempts >= (SELECT max_attempts FROM workers w WHERE w.id = worker_id)").run(iso);
  }

  #now(): Date {
    return this.#app.now();
  }

  #view(r: Row): Worker {
    return {
      id: Number(r.id),
      name: String(r.name),
      character: String(r.character),
      helper: String(r.helper),
      toolGroups: JSON.parse(String(r.tool_groups)) as string[],
      skills: JSON.parse(String(r.skills)) as string[],
      dailyTokens: Number(r.daily_tokens),
      timeLimitMin: Number(r.time_limit_min),
      maxAttempts: Number(r.max_attempts),
      leadId: r.lead_id === null ? null : Number(r.lead_id),
      crewId: r.crew_id === null ? null : Number(r.crew_id),
      state: r.state === 'on' ? 'on' : 'paused',
      conversationId: String(r.conversation_id),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  #jobView(r: Row): WorkerJob {
    const n = (k: string) => (r[k] === null ? null : Number(r[k]));
    const s = (k: string) => (r[k] === null ? null : String(r[k]));
    return { id: Number(r.id), workerId: Number(r.worker_id), title: String(r.title), input: String(r.input), status: String(r.status) as JobStatus, attempts: Number(r.attempts), nextAt: s('next_at'), error: s('error'), result: s('result'), tokens: Number(r.tokens), parentId: n('parent_id'), replayOf: n('replay_of'), replayedBy: n('replayed_by'), teamTaskId: n('team_task_id'), startedAt: s('started_at'), endedAt: s('ended_at'), createdAt: String(r.created_at) };
  }

  list(): Worker[] {
    return (this.#db.prepare('SELECT * FROM workers ORDER BY id').all() as Row[]).map((r) => this.#view(r));
  }

  get(id: number): Worker | undefined {
    const r = this.#db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  job(id: number): WorkerJob | undefined {
    const r = this.#db.prepare('SELECT * FROM worker_jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#jobView(r) : undefined;
  }

  /** A worker's jobs, newest first (dropped ones left out). */
  jobs(workerId: number, limit = 30): WorkerJob[] {
    return (this.#db.prepare("SELECT * FROM worker_jobs WHERE worker_id = ? AND status <> 'dropped' ORDER BY id DESC LIMIT ?").all(workerId, limit) as Row[]).map((r) => this.#jobView(r));
  }

  children(jobId: number): WorkerJob[] {
    return (this.#db.prepare('SELECT * FROM worker_jobs WHERE parent_id = ? ORDER BY id').all(jobId) as Row[]).map((r) => this.#jobView(r));
  }

  /** Failed jobs (the dead-letter list), newest first. */
  failed(): WorkerJob[] {
    return (this.#db.prepare("SELECT * FROM worker_jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 100").all() as Row[]).map((r) => this.#jobView(r));
  }

  alerts(limit = 30): WorkerAlert[] {
    return (this.#db.prepare('SELECT * FROM worker_alerts ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => ({ key: String(r.key), workerId: Number(r.worker_id), reason: String(r.reason) as AlertReason, title: String(r.title), text: String(r.text), channel: r.channel === null ? null : String(r.channel), createdAt: String(r.created_at), sentAt: r.sent_at === null ? null : String(r.sent_at) }));
  }

  /** What blocks a worker right now (unsent or sent alerts of the last day), for the list. */
  needsYou(workerId: number): WorkerAlert | undefined {
    const since = new Date(this.#now().getTime() - 24 * 3600_000).toISOString();
    return this.alerts(100).find((a) => a.workerId === workerId && a.createdAt >= since);
  }

  #day(d: Date = this.#now()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.#app.settings.get().timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }

  /** Tokens the worker's jobs used today (in his time zone). */
  usedToday(workerId: number): number {
    return Number((this.#db.prepare('SELECT COALESCE(SUM(tokens), 0) AS n FROM worker_jobs WHERE worker_id = ? AND day = ?').get(workerId, this.#day()) as { n: number }).n);
  }

  #pinned(): void {
    if (policy().pins.crews === 'off') throw new WorkerError(403, en('Crews are turned off by your admin.'));
  }

  /** The helpers a worker can be built on: the team's, without the workers themselves. */
  #bases(): HelperDef[] {
    return teamHelpers(this.#app, { workers: false });
  }

  /** Each worker as a team helper: its base's role and model, its own tools, name and character. */
  helperDefs(bases: HelperDef[]): HelperDef[] {
    const all = this.list();
    return all.flatMap((w) => {
      const base = bases.find((b) => b.id === w.helper);
      if (!base) return [];
      const tools = [...new Set(w.toolGroups.flatMap((g) => TOOL_GROUPS[g] ?? []))];
      const under = all.filter((x) => x.leadId === w.id).map((x) => x.name);
      const lines = [base.instructions, `You are ${w.name}, one of the owner's workers.${w.character ? ` Your character: ${w.character}` : ''}`];
      if (w.skills.length) lines.push(`Use these skills when they fit: ${w.skills.join(', ')}.`);
      if (under.length) lines.push(`You lead: ${under.join(', ')}. To hand a part to one of them, end your reply with one line per part: HAND TO <name>: <what to do>.`);
      return [{ ...base, id: `worker-${w.id}`, name: w.name, blurb: clip(w.character || base.blurb, 160), instructions: lines.join('\n'), tools, custom: true }];
    });
  }

  #clean(body: Record<string, unknown>, cur?: Worker): Omit<Worker, 'id' | 'conversationId' | 'createdAt' | 'updatedAt'> {
    const has = (k: string) => body[k] !== undefined;
    let crewId = cur?.crewId ?? null;
    let fromCrew: { helper: string; name: string; character: string } | undefined;
    if (!cur && body.fromCrew) {
      const f = body.fromCrew as { crewId?: unknown; member?: unknown };
      const crew = this.#app.crews?.get(Number(f.crewId));
      const m = crew?.members[Number(f.member)];
      if (!crew || !m) throw new WorkerError(400, en('Pick a crew member.'));
      const hn = this.#bases().find((h) => h.id === m.helper)?.name ?? m.helper;
      crewId = crew.id;
      fromCrew = { helper: m.helper, name: clip(`${hn} (${crew.name})`, 40), character: clip(`${m.task}. For the crew: ${crew.brief}`, 1000) };
    }
    const name = has('name') ? clean(body.name, 40) : (cur?.name ?? fromCrew?.name ?? '');
    if (!name) throw new WorkerError(400, en('Give the worker a name.'));
    const character = has('character') ? clean(body.character, 1000) : (cur?.character ?? fromCrew?.character ?? '');
    const helper = has('helper') ? String(body.helper) : (cur?.helper ?? fromCrew?.helper ?? '');
    if (!this.#bases().some((h) => h.id === helper)) throw new WorkerError(400, en('Pick one of your helpers for the worker to be.'));
    const toolGroups = has('toolGroups') ? (Array.isArray(body.toolGroups) ? [...new Set(body.toolGroups.map(String))].filter((g) => g in TOOL_GROUPS) : []) : (cur?.toolGroups ?? ['read']);
    if (!toolGroups.length) throw new WorkerError(400, en('Allow the worker at least one group of tools.'));
    const skills = has('skills') ? (Array.isArray(body.skills) ? body.skills.map((s) => clean(s, 64)).filter((s) => /^[\w.-]+$/.test(s)).slice(0, 12) : []) : (cur?.skills ?? []);
    const dailyTokens = has('dailyTokens') ? int(body.dailyTokens, 200_000, WORKER.minJobTokens, 5_000_000) : (cur?.dailyTokens ?? 200_000);
    const timeLimitMin = has('timeLimitMin') ? int(body.timeLimitMin, 30, 2, 240) : (cur?.timeLimitMin ?? 30);
    const maxAttempts = has('maxAttempts') ? int(body.maxAttempts, 3, 1, 5) : (cur?.maxAttempts ?? 3);
    let leadId = cur?.leadId ?? null;
    if (has('leadId')) {
      leadId = body.leadId === null || body.leadId === '' || body.leadId === 0 ? null : Number(body.leadId);
      if (leadId !== null) {
        if (!this.get(leadId) || leadId === cur?.id) throw new WorkerError(400, en('Pick another worker as the lead.'));
        // No loops: walking up from the new lead never reaches this worker.
        for (let at: number | null = leadId, n = 0; at !== null && n < 20; n++) {
          if (at === cur?.id) throw new WorkerError(400, en('A worker cannot lead its own lead.'));
          at = this.get(at)?.leadId ?? null;
        }
      }
    }
    const state = has('state') ? (body.state === 'paused' ? 'paused' : 'on') : (cur?.state ?? 'on');
    return { name, character, helper, toolGroups, skills, dailyTokens, timeLimitMin, maxAttempts, leadId, crewId, state };
  }

  create(body: Record<string, unknown>): Worker {
    this.#pinned();
    if (this.list().length >= WORKER.maxWorkers) throw new WorkerError(400, en('You have the most workers there can be (12). Delete one first.'));
    const w = this.#clean(body);
    const iso = this.#now().toISOString();
    const conv = this.#app.store.createConversation({ title: `Worker: ${w.name}`, mode: 'coding' });
    const r = this.#db
      .prepare('INSERT INTO workers (name, character, helper, tool_groups, skills, daily_tokens, time_limit_min, max_attempts, lead_id, crew_id, state, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(w.name, w.character, w.helper, JSON.stringify(w.toolGroups), JSON.stringify(w.skills), w.dailyTokens, w.timeLimitMin, w.maxAttempts, w.leadId, w.crewId, w.state, conv.id, iso, iso);
    return this.get(Number(r.lastInsertRowid))!;
  }

  patch(id: number, body: Record<string, unknown>): Worker {
    const cur = this.get(id);
    if (!cur) throw new WorkerError(404, en('Worker not found'));
    if (body.state !== 'paused') this.#pinned();
    const w = this.#clean(body, cur);
    this.#db
      .prepare('UPDATE workers SET name = ?, character = ?, helper = ?, tool_groups = ?, skills = ?, daily_tokens = ?, time_limit_min = ?, max_attempts = ?, lead_id = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(w.name, w.character, w.helper, JSON.stringify(w.toolGroups), JSON.stringify(w.skills), w.dailyTokens, w.timeLimitMin, w.maxAttempts, w.leadId, w.state, this.#now().toISOString(), id);
    return this.get(id)!;
  }

  /** Forgets the worker (its thread and finished jobs stay); its queued jobs are dropped. */
  remove(id: number): boolean {
    this.stop(id);
    this.#db.prepare("UPDATE worker_jobs SET status = 'dropped' WHERE worker_id = ? AND status = 'queued'").run(id);
    this.#db.prepare('UPDATE workers SET lead_id = NULL WHERE lead_id = ?').run(id);
    return Number(this.#db.prepare('DELETE FROM workers WHERE id = ?').run(id).changes) > 0;
  }

  enqueue(workerId: number, body: { title?: unknown; input?: unknown }, o: { parentId?: number; replayOf?: number } = {}): WorkerJob {
    this.#pinned();
    const w = this.get(workerId);
    if (!w) throw new WorkerError(404, en('Worker not found'));
    const title = clean(body.title, 160);
    if (title.length < 3) throw new WorkerError(400, en('Say what the job is in a few words.'));
    const input = clean(body.input, 6000);
    const queued = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE worker_id = ? AND status = 'queued'").get(workerId) as { n: number }).n);
    if (queued >= WORKER.maxQueued) throw new WorkerError(409, en('This worker has 50 jobs waiting already.'));
    const r = this.#db.prepare("INSERT INTO worker_jobs (worker_id, title, input, status, parent_id, replay_of, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)").run(workerId, title, input, o.parentId ?? null, o.replayOf ?? null, this.#now().toISOString());
    return this.job(Number(r.lastInsertRowid))!;
  }

  /** Replays a failed job as a new queued copy; the failed one stays (marked) for the record. */
  replay(jobId: number): WorkerJob {
    const j = this.job(jobId);
    if (!j) throw new WorkerError(404, en('Job not found'));
    if (j.status !== 'failed') throw new WorkerError(409, en('Only a failed job can be replayed.'));
    const copy = this.enqueue(j.workerId, { title: j.title, input: j.input }, { replayOf: j.id, ...(j.parentId ? { parentId: j.parentId } : {}) });
    this.#db.prepare('UPDATE worker_jobs SET replayed_by = ? WHERE id = ?').run(copy.id, j.id);
    audit({ action: 'worker.replay', target: `job${j.id}`, role: 'owner', who: 'owner', channel: 'web', outcome: 'ok' });
    return copy;
  }

  /** Drops a failed or waiting job (hidden from the lists; the row stays). */
  drop(jobId: number): boolean {
    const j = this.job(jobId);
    if (!j || (j.status !== 'failed' && j.status !== 'queued')) return false;
    this.#db.prepare("UPDATE worker_jobs SET status = 'dropped', ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(this.#now().toISOString(), jobId);
    audit({ action: 'worker.drop', target: `job${j.id}`, role: 'owner', who: 'owner', channel: 'web', outcome: 'ok' });
    return true;
  }

  /** Pauses the worker and stops its running job (it goes to Failed jobs, without an alert). */
  stop(workerId: number): boolean {
    this.#db.prepare("UPDATE workers SET state = 'paused', updated_at = ? WHERE id = ?").run(this.#now().toISOString(), workerId);
    const r = this.#db.prepare("SELECT id FROM worker_jobs WHERE worker_id = ? AND status = 'running'").get(workerId) as { id: number } | undefined;
    const live = r ? this.#live.get(Number(r.id)) : undefined;
    if (!live) return false;
    live.why = 'owner';
    live.handle.stop();
    return true;
  }

  /** Resolves when the job's current try ends (tests and the routes). */
  async finished(jobId: number): Promise<WorkerJob> {
    await this.#live.get(jobId)?.done;
    return this.job(jobId)!;
  }

  /** The reminder tick: time limits, waiting approvals, the next job per free worker, held alerts. */
  tick(now: Date = this.#now()): number {
    void this.#flush();
    if (policy().pins.crews === 'off') return 0;
    for (const [id, live] of this.#live) {
      const j = this.job(id);
      const w = j ? this.get(j.workerId) : undefined;
      if (!j || !w) continue;
      if (j.startedAt && now.getTime() - Date.parse(j.startedAt) >= w.timeLimitMin * 60_000 && !live.why) {
        live.why = 'timeout';
        live.handle.stop();
        continue;
      }
      if (live.handle.waiting()) this.#raise(`approval:job${j.id}`, w, 'approval', en('{name} is waiting for your approval on "{title}".'), { title: j.title });
    }
    let started = 0;
    for (const w of this.list()) {
      if (w.state !== 'on') continue;
      if (this.#db.prepare("SELECT 1 FROM worker_jobs WHERE worker_id = ? AND status = 'running'").get(w.id)) continue;
      const r = this.#db.prepare("SELECT * FROM worker_jobs WHERE worker_id = ? AND status = 'queued' AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT 1").get(w.id, now.toISOString()) as Row | undefined;
      if (!r) continue;
      const left = w.dailyTokens - this.usedToday(w.id);
      if (left < WORKER.minJobTokens) {
        this.#raise(`budget:w${w.id}:${this.#day(now)}`, w, 'budget', en("{name} reached today's budget; its jobs wait until tomorrow."), {});
        continue;
      }
      if (this.#start(w, this.#jobView(r), left)) started++;
    }
    return started;
  }

  #start(w: Worker, job: WorkerJob, left: number): boolean {
    const runner = this.#o.runner ?? ((a, b, c) => this.#teamRun(a, b, c));
    this.#db.prepare("UPDATE worker_jobs SET status = 'running', started_at = ?, next_at = NULL WHERE id = ?").run(this.#now().toISOString(), job.id);
    let handle: WorkerHandle;
    try {
      handle = runner(w, job, { tokens: left, minutes: w.timeLimitMin });
    } catch (err) {
      const msg = (err as Error).message;
      if (/already running/i.test(msg)) {
        // The team is full: wait for the next tick without counting a try.
        this.#db.prepare("UPDATE worker_jobs SET status = 'queued', started_at = NULL WHERE id = ?").run(job.id);
        return false;
      }
      this.#settle(job.id, { status: 'failed', result: '', tokens: 0, error: msg });
      return false;
    }
    if (handle.teamTaskId) this.#db.prepare('UPDATE worker_jobs SET team_task_id = ? WHERE id = ?').run(handle.teamTaskId, job.id);
    const live: { handle: WorkerHandle; done: Promise<void>; why?: 'owner' | 'timeout' } = { handle, done: Promise.resolve() };
    live.done = handle.done
      .then(
        (o) => this.#settle(job.id, o, live.why),
        (err) => this.#settle(job.id, { status: 'failed', result: '', tokens: 0, error: (err as Error).message }, live.why),
      )
      .finally(() => this.#live.delete(job.id));
    this.#live.set(job.id, live);
    return true;
  }

  /** The default runner: the team runs the worker as its one helper, in the worker's own thread. */
  #teamRun(w: Worker, job: WorkerJob, budget: { tokens: number; minutes: number }): WorkerHandle {
    const team = this.#app.team;
    if (!team) throw new Error('team work is not available on this server');
    const task = team.start(w.conversationId, `${w.name}: ${job.title}`, { plan: [{ helper: `worker-${w.id}`, title: job.title, instructions: job.input ? `${job.title}\n\n${job.input}` : job.title }], limits: { minutes: budget.minutes, tokens: Math.max(WORKER.minJobTokens, Math.min(budget.tokens, 5_000_000)), steps: 2 } });
    const done = team.finished(task.id).then((t): WorkerOutcome => {
      const step = t.steps.find((s) => s.helper === `worker-${w.id}`);
      const result = (step?.report ?? t.report ?? '').trim();
      const status = t.status === 'done' && step?.status === 'done' ? 'done' : t.status === 'stopped' ? 'stopped' : 'failed';
      const error = status === 'failed' ? (t.status === 'limit' ? 'it reached its budget for the job' : clip(t.report ?? t.status, 300)) : undefined;
      return { status, result, tokens: t.tokens, teamTaskId: t.id, ...(error ? { error } : {}) };
    });
    return { done, stop: () => void team.stop(task.id), waiting: () => team.approvals(task.id).length > 0, teamTaskId: task.id };
  }

  #settle(jobId: number, o: WorkerOutcome, why?: 'owner' | 'timeout'): void {
    const job = this.job(jobId);
    const w = job ? this.get(job.workerId) : undefined;
    if (!job || !w) return;
    const iso = this.#now().toISOString();
    const tokens = Math.max(0, Math.round(o.tokens || 0));
    this.#db.prepare('UPDATE worker_jobs SET tokens = tokens + ?, day = ?, team_task_id = COALESCE(?, team_task_id) WHERE id = ?').run(tokens, this.#day(), o.teamTaskId ?? null, jobId);
    if (o.status === 'done' && !why) {
      this.#db.prepare("UPDATE worker_jobs SET status = 'done', attempts = attempts + 1, result = ?, error = NULL, ended_at = ? WHERE id = ?").run(clip(this.#app.redactor.redact(o.result), 20_000), iso, jobId);
      this.#post(w, `**${job.title}**\n\n${o.result || '(no reply)'}`, { jobId, status: 'done' });
      this.#handOff(w, this.job(jobId)!);
      this.#bubble(this.job(jobId)!);
      return;
    }
    const attempts = job.attempts + 1;
    const error = why === 'timeout' ? `went past its time limit (${w.timeLimitMin} min)` : why === 'owner' ? 'stopped by you' : o.status === 'stopped' ? 'it was stopped' : clip(o.error || 'it did not finish', 300);
    if (why !== 'owner' && o.status !== 'stopped' && attempts < w.maxAttempts) {
      const wait = WORKER.backoffMs[Math.min(attempts - 1, WORKER.backoffMs.length - 1)];
      this.#db.prepare("UPDATE worker_jobs SET status = 'queued', attempts = ?, error = ?, started_at = NULL, next_at = ? WHERE id = ?").run(attempts, error, new Date(this.#now().getTime() + wait).toISOString(), jobId);
      return;
    }
    this.#db.prepare("UPDATE worker_jobs SET status = 'failed', attempts = ?, error = ?, ended_at = ? WHERE id = ?").run(attempts, error, iso, jobId);
    this.#post(w, `**${job.title}**: ${error}`, { jobId, status: 'failed' });
    if (why !== 'owner') {
      if (o.status === 'stopped' && why !== 'timeout') this.#raise(`stopped:job${jobId}`, w, 'stopped', en('{name} was stopped on "{title}".'), { title: job.title });
      else this.#raise(`failing:job${jobId}`, w, 'failing', en('{name} could not do "{title}" after {n} tries: {error}'), { title: job.title, n: attempts, error });
    }
    this.#bubble(this.job(jobId)!);
  }

  #post(w: Worker, content: string, meta: Record<string, unknown>): void {
    const app = this.#app;
    if (!app.store.getConversation(w.conversationId)) return;
    const msg = app.store.addMessage(w.conversationId, 'assistant', app.redactor.redact(content), { worker: { id: w.id, name: w.name, ...meta } });
    app.events?.publish({ type: 'message', conversationId: w.conversationId, message: msg, reason: 'job' } as never);
  }

  /** A lead's "HAND TO <name>: <job>" lines become jobs for the workers under it. */
  #handOff(lead: Worker, job: WorkerJob): void {
    const under = this.list().filter((x) => x.leadId === lead.id);
    if (!under.length || !job.result) return;
    for (const m of job.result.matchAll(HAND_RE)) {
      const to = under.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
      if (!to) continue;
      try {
        this.enqueue(to.id, { title: m[2].trim(), input: `From ${lead.name}, for "${job.title}".` }, { parentId: job.id });
      } catch (err) {
        console.warn(`workers: hand-off to ${to.name} failed: ${(err as Error).message}`);
      }
    }
  }

  /** A child job ended: its result goes to the lead's thread; when all have ended, onto the lead's job. */
  #bubble(child: WorkerJob): void {
    if (!child.parentId || (child.status !== 'done' && child.status !== 'failed')) return;
    const parent = this.job(child.parentId);
    const lead = parent ? this.get(parent.workerId) : undefined;
    const me = this.get(child.workerId);
    if (!parent || !lead || !me) return;
    const line = (j: WorkerJob, name: string) => `${name}: ${j.status === 'done' ? (j.result ?? '') : `could not do it (${j.error ?? ''})`}`;
    this.#post(lead, `**${child.title}** (${me.name})\n\n${line(child, me.name)}`, { jobId: parent.id, from: me.id, status: child.status });
    const kids = this.children(parent.id).filter((k) => k.status !== 'dropped' && !k.replayedBy);
    if (kids.some((k) => k.status === 'queued' || k.status === 'running')) return;
    const names = new Map(this.list().map((x) => [x.id, x.name]));
    const summary = kids.map((k) => `- ${line(k, names.get(k.workerId) ?? '?')}`).join('\n');
    this.#db.prepare('UPDATE worker_jobs SET result = ? WHERE id = ?').run(clip(`${parent.result ?? ''}\n\nFrom the workers under ${lead.name}:\n${summary}`, 30_000), parent.id);
  }

  /** One alert per key, ever; sent now or after quiet hours. */
  #raise(key: string, w: Worker, reason: AlertReason, text: string, params: Record<string, string | number>): void {
    const set = this.#app.settings.get();
    const body = trOwner(text, set, { name: w.name, ...params });
    const r = this.#db.prepare('INSERT OR IGNORE INTO worker_alerts (key, worker_id, reason, title, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, w.id, reason, trOwner('{name} needs you', set, { name: w.name }), clip(this.#app.redactor.redact(body), 400), this.#now().toISOString());
    if (Number(r.changes) > 0) void this.#flush();
  }

  #quiet(): boolean {
    return this.#o.quiet ? this.#o.quiet() : quietNow(this.#app);
  }

  /** The chat app he used last (Telegram, Discord) when it is linked, else the app push. */
  #channel(): string {
    const mine = new Set(this.list().map((w) => w.conversationId));
    const last = this.#app.store
      .listConversations()
      .filter((c) => !mine.has(c.id) && !c.partner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const br = this.#app.bridges;
    if (last?.channel.startsWith('telegram') && br?.telegram?.ownerLinked()) return 'telegram';
    if (last?.channel.startsWith('discord') && br?.discord?.ownerLinked()) return 'discord';
    return 'push';
  }

  async #flush(): Promise<void> {
    if (this.#quiet()) return;
    const due = this.#db.prepare('SELECT * FROM worker_alerts WHERE sent_at IS NULL ORDER BY created_at LIMIT 10').all() as Row[];
    for (const r of due) {
      const w = this.get(Number(r.worker_id));
      const channel = this.#channel();
      // Claimed before sending, so a second tick never sends it again.
      if (!Number(this.#db.prepare('UPDATE worker_alerts SET sent_at = ?, channel = ? WHERE key = ? AND sent_at IS NULL').run(this.#now().toISOString(), channel, String(r.key)).changes)) continue;
      const a = { channel, title: String(r.title), text: String(r.text), conversationId: w?.conversationId ?? '', tag: `worker-${String(r.key)}` };
      const send =
        this.#o.alert ??
        (async (x: typeof a) => {
          const br = this.#app.bridges;
          if (x.channel === 'telegram') return Boolean(await br?.telegram?.toOwner(`${x.title}: ${x.text}`));
          if (x.channel === 'discord') return Boolean(await br?.discord?.toOwner(`${x.title}: ${x.text}`));
          await this.#app.push?.notifyOwner(x.title, x.text, x.conversationId, x.tag);
          return true;
        });
      const ok = await send(a).catch(() => false);
      if (!ok) this.#db.prepare('UPDATE worker_alerts SET sent_at = NULL WHERE key = ?').run(String(r.key));
    }
  }

  // ── Bundles ──────────────────────────────────────────────────────────────

  /** Strips anything secret: vault values (the redactor), provider keys, key-shaped strings. */
  #scrub(s: string): string {
    let out = this.#app.redactor.redact(s);
    for (const p of this.#app.settings.get().providers ?? []) {
      const k = (p as { apiKey?: unknown }).apiKey;
      if (typeof k === 'string' && k.length >= 8) out = out.split(k).join('[REDACTED]');
    }
    return out.replace(/\b(?:sk|pk|rk)-[\w-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');
  }

  /** A worker and the workers under it, as a bundle. Memories (its results) only when ticked. */
  exportBundle(workerId: number, o: { memories?: boolean } = {}): WorkerBundle {
    const top = this.get(workerId);
    if (!top) throw new WorkerError(404, en('Worker not found'));
    const all = this.list();
    const picked: Worker[] = [top];
    for (let i = 0; i < picked.length && picked.length < WORKER.maxBundle; i++) for (const x of all) if (x.leadId === picked[i].id && !picked.includes(x)) picked.push(x);
    const keys = new Map(picked.map((w, i) => [w.id, `w${i + 1}`]));
    const bases = this.#bases();
    const workers = picked.map((w): BundleWorker => {
      const base = bases.find((b) => b.id === w.helper);
      const mem = o.memories ? (this.#db.prepare("SELECT result FROM worker_jobs WHERE worker_id = ? AND status = 'done' AND result IS NOT NULL ORDER BY id DESC LIMIT 10").all(w.id) as { result: string }[]).map((r) => clip(this.#scrub(r.result), 2000)) : undefined;
      return { key: keys.get(w.id)!, name: this.#scrub(w.name), character: this.#scrub(w.character), helper: w.helper, role: base?.role ?? 'writer', toolGroups: w.toolGroups, skills: w.skills, dailyTokens: w.dailyTokens, timeLimitMin: w.timeLimitMin, maxAttempts: w.maxAttempts, lead: w.leadId && keys.has(w.leadId) && w.id !== top.id ? keys.get(w.leadId)! : null, ...(mem ? { memories: mem } : {}) };
    });
    audit({ action: 'worker.export', target: `worker${top.id}`, role: 'owner', who: 'owner', channel: 'web', outcome: 'ok', keys: o.memories ? ['memories'] : [] });
    return { kind: 'sara-worker-bundle', version: WORKER.version, manifest: { name: top.name, workers: workers.length, exportedAt: this.#now().toISOString(), memories: Boolean(o.memories) }, workers };
  }

  #parse(raw: unknown): BundleWorker[] {
    const b = (raw ?? {}) as Partial<WorkerBundle>;
    if (b.kind !== 'sara-worker-bundle' || typeof b.version !== 'number' || b.version > WORKER.version || !Array.isArray(b.workers) || !b.workers.length || b.workers.length > WORKER.maxBundle) throw new WorkerError(400, en('This is not a worker bundle Sara can read.'));
    const keys = new Set<string>();
    return b.workers.map((x) => {
      const w = (x ?? {}) as Partial<BundleWorker>;
      const key = clean(w.key, 20);
      const name = clean(w.name, 40);
      if (!key || !name || keys.has(key)) throw new WorkerError(400, en('This is not a worker bundle Sara can read.'));
      keys.add(key);
      const groups = Array.isArray(w.toolGroups) ? [...new Set(w.toolGroups.map(String))].filter((g) => g in TOOL_GROUPS) : [];
      return { key, name, character: clean(w.character, 1000), helper: clean(w.helper, 40), role: clean(w.role, 20), toolGroups: groups.length ? groups : ['read'], skills: Array.isArray(w.skills) ? w.skills.map((s) => clean(s, 64)).filter((s) => /^[\w.-]+$/.test(s)).slice(0, 12) : [], dailyTokens: int(w.dailyTokens, 200_000, WORKER.minJobTokens, 5_000_000), timeLimitMin: int(w.timeLimitMin, 30, 2, 240), maxAttempts: int(w.maxAttempts, 3, 1, 5), lead: typeof w.lead === 'string' ? w.lead : null, ...(Array.isArray(w.memories) ? { memories: w.memories.map((m) => clip(String(m), 2000)).slice(0, 10) } : {}) };
    });
  }

  #helperFor(w: BundleWorker): string {
    const bases = this.#bases();
    if (bases.some((b) => b.id === w.helper)) return w.helper;
    return bases.find((b) => b.id === w.role)?.id ?? 'writer';
  }

  /** What an import would make: each worker, its tools (risky ones flagged), its lead, missing skills. */
  previewImport(raw: unknown): { workers: { key: string; name: string; character: string; helper: string; toolGroups: string[]; tools: string[]; risky: string[]; dailyTokens: number; timeLimitMin: number; lead: string | null; memories: number }[]; missingSkills: string[]; room: number } {
    const ws = this.#parse(raw);
    const byKey = new Map(ws.map((w) => [w.key, w]));
    const have = new Set((this.#app.skills?.list() ?? []).map((s) => s.name));
    const missing = [...new Set(ws.flatMap((w) => w.skills))].filter((s) => !have.has(s));
    return {
      workers: ws.map((w) => {
        const tools = [...new Set(w.toolGroups.flatMap((g) => TOOL_GROUPS[g]))];
        return { key: w.key, name: w.name, character: w.character, helper: this.#helperFor(w), toolGroups: w.toolGroups, tools, risky: tools.filter((t) => RISKY.has(t)), dailyTokens: w.dailyTokens, timeLimitMin: w.timeLimitMin, lead: w.lead ? (byKey.get(w.lead)?.name ?? null) : null, memories: w.memories?.length ?? 0 };
      }),
      missingSkills: missing,
      room: WORKER.maxWorkers - this.list().length,
    };
  }

  /** Makes the bundle's workers (paused, for him to look over) after he confirmed the review. */
  importBundle(raw: unknown, o: { confirm?: boolean } = {}): Worker[] {
    this.#pinned();
    const ws = this.#parse(raw);
    if (o.confirm !== true) throw new WorkerError(400, en('Look over the workers and their permissions, then confirm.'));
    if (this.list().length + ws.length > WORKER.maxWorkers) throw new WorkerError(400, en('You have the most workers there can be (12). Delete one first.'));
    const taken = new Set(this.list().map((w) => w.name.toLowerCase()));
    const made = new Map<string, Worker>();
    // Leads first, so each worker can point at its lead.
    const left = [...ws];
    for (let guard = 0; left.length && guard < 50; guard++) {
      const i = left.findIndex((w) => !w.lead || made.has(w.lead) || !ws.some((x) => x.key === w.lead));
      const w = left.splice(i < 0 ? 0 : i, 1)[0];
      let name = w.name;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = clip(`${w.name} (${n})`, 40);
      taken.add(name.toLowerCase());
      const lead = w.lead ? made.get(w.lead) : undefined;
      const nw = this.create({ name, character: w.character, helper: this.#helperFor(w), toolGroups: w.toolGroups, skills: w.skills, dailyTokens: w.dailyTokens, timeLimitMin: w.timeLimitMin, maxAttempts: w.maxAttempts, leadId: lead?.id ?? null, state: 'paused' });
      if (w.memories?.length) this.#post(nw, `What I remember from before:\n\n${w.memories.map((m) => `- ${m}`).join('\n')}`, { imported: true });
      made.set(w.key, nw);
    }
    audit({ action: 'worker.import', target: `workers${made.size}`, role: 'owner', who: 'owner', channel: 'web', outcome: 'ok' });
    return [...made.values()];
  }
}

/** Server words (alerts) so the extractor sees them. */
export const WORKER_LINES = [en('{name} needs you')];
