// Phase 13: long background jobs (builds, test runs, a task handed to Claude Code or Grok Build).
// A job runs in the conversation's workspace sandbox while the chat carries on. Progress (the last
// lines of output) is visible in the app; when it finishes, the result is saved in the
// conversation, she tells the owner what happened (checked against the real result), and the
// owner gets a notification.
import type { DatabaseSync } from 'node:sqlite';
import { runCommand, type Bind, type RunResult, type SandboxInfo } from './tools/sandbox.ts';
import { workspaceDir } from './tools/workspace.ts';
import type { AppContext } from './chat.ts';
import { complete } from './life.ts';
import { buildSystemPrompt } from './persona.ts';
import { checkClaims, type Receipt } from './receipts.ts';
import { detectMinorSexualContent } from './safety.ts';
import { en, trOwner } from './i18n.ts';
import { identityOf } from './persona.ts';
import { billingOf, cleanBudget, overBudget, usageScope, type Budget, type UsageNumbers, type UsageScope } from './usage.ts';
import type { ProviderConfig } from './providers/types.ts';
import { RunRecorder, filesNamed } from './runs.ts';
import { JobRecoveryStore, type JobIntent, type JobRecoveryView, type RestartReview } from './job-recovery.ts';

/** 'budget': stopped cleanly at its token / $ budget (Phase 52; can be continued with more). */
export type JobStatus = 'running' | 'ok' | 'failed' | 'stopped' | 'interrupted' | 'budget';

export interface Job {
  id: number;
  conversationId: string;
  workspace: string;
  /** What runs (a shell command, or "Claude Code: <task>"). */
  label: string;
  kind: 'command' | 'agent';
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  /** The last part of the output (the whole result when finished, clipped). */
  tail: string;
  /** Extra results (agent jobs: files changed, the agent's final words, undo point). */
  result?: Record<string, unknown>;
  recovery?: JobRecoveryView;
}

export interface JobSpec {
  recoveryIntent?: JobIntent;
  conversationId: string;
  workspace: string;
  label: string;
  kind?: 'command' | 'agent';
  command: string;
  timeoutMs: number;
  env?: Record<string, string>;
  binds?: Bind[];
  sandbox?: SandboxInfo;
  /** Runs before the command (e.g. an undo point); its return value is passed to `after`. */
  before?: () => Record<string, unknown>;
  /** Turns the raw run into the job's result (e.g. the agent's final message, files changed). */
  after?: (r: RunResult, before: Record<string, unknown>) => Record<string, unknown>;
  /** Phase 52: stop cleanly when the model calls inside the job reach this. */
  budget?: Budget;
  /**
   * Phase 52: the model behind an agent job and how to read its token counts from its output
   * (one line at a time), so they are recorded and the budget is kept while it runs.
   */
  meter?: { config: ProviderConfig; model: string; parse: (line: string) => UsageNumbers | undefined };
}

/**
 * An in-process background task (a bulk Gmail change): the same jobs strip, Stop button, notice
 * and her report as a command job, but the work is a function, not a command.
 */
export interface TaskSpec {
  conversationId: string;
  workspace: string;
  label: string;
  /** Does the work; `progress` sets the line shown on the strip. Stops early when `signal` aborts. */
  run: (signal: AbortSignal, progress: (line: string) => void) => Promise<{ ok: boolean; output: string; result?: Record<string, unknown> }>;
}

const TAIL = 4000;
export const MAX_JOB_MS = 60 * 60_000;
const MAX_RUNNING = 3;

export class JobManager {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #running = new Map<number, AbortController>();
  /** MNT2: each started job's `done`, until it has settled (stopAll waits on these). */
  readonly #done = new Map<number, Promise<unknown>>();
  readonly #live = new Map<number, Job>();
  /** Phase 49: the process each running job started (previews check who listens on a port). */
  readonly #pids = new Map<number, number>();
  /** Phase 52: jobs stopped at their budget, with what's needed to carry on (until a restart). */
  readonly #recovery: JobRecoveryStore;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'command',
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      tail TEXT NOT NULL DEFAULT '',
      result TEXT
    )`);
    this.#recovery = new JobRecoveryStore(app, db);
    // Jobs that were running when the server stopped did not finish.
    db.prepare("UPDATE jobs SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(app.now().toISOString());
  }

  #row(r: Record<string, string | number | null>): Job {
    return {
      recovery: this.#recovery.view(Number(r.id)),
      id: Number(r.id),
      conversationId: String(r.conversation_id),
      workspace: String(r.workspace),
      label: String(r.label),
      kind: r.kind === 'agent' ? 'agent' : 'command',
      status: r.status as JobStatus,
      exitCode: r.exit_code === null ? null : Number(r.exit_code),
      startedAt: String(r.started_at),
      endedAt: (r.ended_at as string | null) ?? null,
      tail: String(r.tail ?? ''),
      ...(r.result ? { result: JSON.parse(String(r.result)) as Record<string, unknown> } : {}),
    };
  }

  get(id: number): Job | undefined {
    if (this.#live.has(id)) return { ...this.#live.get(id)! };
    const r = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    return r ? this.#row(r) : undefined;
  }

  list(opts: { conversationId?: string; limit?: number } = {}): Job[] {
    const rows = (opts.conversationId ? this.#db.prepare('SELECT * FROM jobs WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(opts.conversationId, opts.limit ?? 20) : this.#db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(opts.limit ?? 20)) as Record<string, string | number | null>[];
    return rows.map((r) => (this.#live.has(Number(r.id)) ? { ...this.#live.get(Number(r.id))! } : this.#row(r)));
  }

  running(): Job[] {
    return [...this.#live.values()].map((j) => ({ ...j }));
  }

  /** Phase 49: the process id a running job started (undefined once it has ended). */
  pidOf(id: number): number | undefined {
    return this.#live.has(id) ? this.#pids.get(id) : undefined;
  }

  /** Phase 49: called with the job when it ends (previews of its port are closed). */
  onEnd?: (job: Job) => void;

  /** Starts a job; returns at once. `done` resolves when it has finished and been reported. */
  start(spec: JobSpec): { job: Job; done: Promise<Job> } {
    if (this.#running.size >= MAX_RUNNING) throw new Error(`Already ${MAX_RUNNING} background jobs running; wait for one or stop it.`);
    const app = this.#app;
    const startedAt = app.now().toISOString();
    const r = this.#db.prepare("INSERT INTO jobs (conversation_id, workspace, label, kind, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(spec.conversationId, spec.workspace, app.redactor.redact(spec.label).slice(0, 500), spec.kind ?? 'command', startedAt);
    const id = Number(r.lastInsertRowid);
    const job: Job = { id, conversationId: spec.conversationId, workspace: spec.workspace, label: app.redactor.redact(spec.label).slice(0, 500), kind: spec.kind ?? 'command', status: 'running', exitCode: null, startedAt, endedAt: null, tail: '' };
    this.#recovery.save(id, spec);
    job.recovery = this.#recovery.view(id);
    this.#live.set(id, job);
    const ac = new AbortController();
    this.#running.set(id, ac);
    app.events?.publish({ type: 'job', job: { ...job } });
    let lastEvent = 0;
    // Phase 78: the job is a run too (the command as its step, her report's model call after it).
    // Its usage scope keeps the AsyncLocalStorage attribution and carries the recorder.
    const rec = app.runs && app.store.getConversation(spec.conversationId) ? new RunRecorder(app.runs, { kind: 'job', conversationId: spec.conversationId, jobId: id, title: spec.label.slice(0, 120), ...(spec.budget ? { budget: spec.budget } : {}) }) : RunRecorder.none();
    if (rec.on) rec.startStep({ label: `${spec.kind === 'agent' ? 'Agent job' : 'Background job'} #${id}`, ...(spec.meter ? { model: spec.meter.model, provider: spec.meter.config.label } : {}) });
    const ranAt = Date.now();
    // Phase 52: model calls in the job (her report about it too) count toward the job.
    const scope: UsageScope = { purpose: 'job', jobId: id, conversationId: spec.conversationId, ...(rec.on ? { runId: rec.id, onCall: (c) => rec.modelCall(c) } : {}) };
    const used = { tokens: 0, usd: 0, unpriced: 0 };
    let budgetHit: string | undefined;
    let partial = '';
    let rawTail = '';
    const meterLine = (line: string) => {
      const m = spec.meter;
      const u = m?.parse(line);
      if (!m || !u) return;
      const row = app.usage?.record(m.config, m.model, u, { ...scope, purpose: 'job' });
      // Phase 78: an agent job's own model calls (read from its output) are on the run's step.
      rec.modelCall({ model: m.model, provider: m.config.label, providerId: m.config.id, billing: billingOf(m.config), purpose: 'agent', in: u.input, out: u.output, cached: u.cached ?? 0, usd: row ? row.usd : null, reported: true, ms: 0, ok: true });
      used.tokens += u.input + u.output;
      used.usd += row?.usd ?? 0;
      if (row && row.usd === null) used.unpriced++;
      const over = overBudget(spec.budget, used);
      if (over && !budgetHit) {
        budgetHit = over;
        ac.abort(new Error('budget'));
      }
    };
    const done = usageScope.run(scope, async () => {
      let pre: Record<string, unknown> = {};
      let run: RunResult;
      try {
        pre = spec.before?.() ?? {};
        const wsDir = workspaceDir(app.rootDir ?? app.dataDir, spec.workspace);
        run = await runCommand(spec.command, wsDir, spec.sandbox ?? { ...app.sandbox, network: app.settings.get().shellNetwork ?? true }, {
          timeoutMs: Math.min(MAX_JOB_MS, spec.timeoutMs),
          signal: ac.signal,
          maxBytes: 400_000,
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.binds ? { binds: spec.binds } : {}),
          onSpawn: (pid) => this.#pids.set(id, pid),
          onOutput: (text) => {
            if (spec.meter) {
              const lines = (partial + text).split('\n');
              partial = lines.pop() ?? '';
              if (partial.length > 1_000_000) partial = '';
              for (const l of lines) meterLine(l);
            }
            rawTail = (rawTail + text).slice(-TAIL * 2);
            job.tail = app.redactor.redact(rawTail).slice(-TAIL);
            // Progress to the app at most twice a second.
            const t = Date.now();
            if (t - lastEvent > 500) {
              lastEvent = t;
              this.#db.prepare('UPDATE jobs SET tail = ? WHERE id = ?').run(job.tail, id);
              app.events?.publish({ type: 'job', job: { ...job } });
            }
          },
        });
      } catch (err) {
        run = { exitCode: null, output: `Could not run: ${(err as Error).message}`, timedOut: false, ms: 0 };
      }
      if (partial) meterLine(partial);
      const stopped = ac.signal.aborted;
      job.status = budgetHit ? 'budget' : stopped ? 'stopped' : run.exitCode === 0 && !run.timedOut ? 'ok' : 'failed';
      if (budgetHit) {
        job.result = { ...(job.result ?? {}), budget: { reason: budgetHit, ...spec.budget, used } };

      }
      job.exitCode = run.exitCode;
      job.endedAt = app.now().toISOString();
      job.tail = app.redactor.redact(run.output).slice(-TAIL) + (run.timedOut ? `\n[stopped: took longer than ${Math.round(spec.timeoutMs / 60_000)} minutes]` : '');
      try {
        if (spec.after) job.result = { ...spec.after(run, pre), ...(job.result?.budget ? { budget: job.result.budget } : {}) };
      } catch (err) {
        job.result = { error: (err as Error).message };
      }
      this.#db
        .prepare('UPDATE jobs SET status = ?, exit_code = ?, ended_at = ?, tail = ?, result = ? WHERE id = ?')
        .run(job.status, job.exitCode, job.endedAt, job.tail, job.result ? JSON.stringify(job.result) : null, id);
      this.#running.delete(id);
      this.#live.delete(id);
      this.#pids.delete(id);
      try {
        this.onEnd?.({ ...job });
      } catch {
        /* a listener's problem never breaks the job */
      }
      app.events?.publish({ type: 'job', job: { ...job } });
      const files = job.result?.files as { added?: string[]; changed?: string[]; removed?: string[] } | undefined;
      rec.tool({ id: `job-${id}`, name: spec.kind === 'agent' ? 'delegate_task' : 'start_job', summary: app.redactor.redact(job.label), args: app.redactor.redactValue({ command: spec.command.slice(0, 2000) }), status: job.status === 'ok' ? 'ok' : 'error', output: job.tail, ms: Date.now() - ranAt, approval: 'auto', files: files ? [...(files.added ?? []), ...(files.changed ?? []), ...(files.removed ?? [])].slice(0, 200) : filesNamed('', {}) });
      if (job.status === 'budget') rec.stopped('budget');
      // Her report about it is the run's next step.
      if (rec.on) rec.startStep({ label: 'Report' });
      await this.#report(job, run).catch((err: Error) => console.warn(`jobs: report failed: ${err.message}`));
      rec.close(job.status === 'ok' ? 'ok' : job.status === 'budget' ? 'budget' : job.status === 'stopped' ? 'stopped' : 'error');
      return { ...job };
    });
    this.#track(id, done);
    return { job: { ...job }, done };
  }

  /** Starts an in-process task (see TaskSpec); returns at once. */
  startTask(spec: TaskSpec): { job: Job; done: Promise<Job> } {
    if (this.#running.size >= MAX_RUNNING) throw new Error(`Already ${MAX_RUNNING} background jobs running; wait for one or stop it.`);
    const app = this.#app;
    const startedAt = app.now().toISOString();
    const label = app.redactor.redact(spec.label).slice(0, 500);
    const id = Number(this.#db.prepare("INSERT INTO jobs (conversation_id, workspace, label, kind, status, started_at) VALUES (?, ?, ?, 'command', 'running', ?)").run(spec.conversationId, spec.workspace, label, startedAt).lastInsertRowid);
    const job: Job = { id, conversationId: spec.conversationId, workspace: spec.workspace, label, kind: 'command', status: 'running', exitCode: null, startedAt, endedAt: null, tail: '' };
    this.#live.set(id, job);
    const ac = new AbortController();
    this.#running.set(id, ac);
    app.events?.publish({ type: 'job', job: { ...job } });
    let lastEvent = 0;
    const ranAt = Date.now();
    const done = (async () => {
      let out: { ok: boolean; output: string; result?: Record<string, unknown> };
      try {
        out = await spec.run(ac.signal, (line) => {
          job.tail = app.redactor.redact(line).slice(-TAIL);
          const t = Date.now();
          if (t - lastEvent > 500) {
            lastEvent = t;
            this.#db.prepare('UPDATE jobs SET tail = ? WHERE id = ?').run(job.tail, id);
            app.events?.publish({ type: 'job', job: { ...job } });
          }
        });
      } catch (err) {
        out = { ok: false, output: `Failed: ${(err as Error).message}` };
      }
      job.status = ac.signal.aborted ? 'stopped' : out.ok ? 'ok' : 'failed';
      job.exitCode = out.ok ? 0 : 1;
      job.endedAt = app.now().toISOString();
      job.tail = app.redactor.redact(out.output).slice(-TAIL);
      if (out.result) job.result = out.result;
      this.#db.prepare('UPDATE jobs SET status = ?, exit_code = ?, ended_at = ?, tail = ?, result = ? WHERE id = ?').run(job.status, job.exitCode, job.endedAt, job.tail, job.result ? JSON.stringify(job.result) : null, id);
      this.#running.delete(id);
      this.#live.delete(id);
      try {
        this.onEnd?.({ ...job });
      } catch {
        /* a listener's problem never breaks the job */
      }
      app.events?.publish({ type: 'job', job: { ...job } });
      await this.#report(job, { exitCode: job.exitCode, output: out.output, timedOut: false, ms: Date.now() - ranAt }).catch((err: Error) => console.warn(`jobs: report failed: ${err.message}`));
      return { ...job };
    })();
    this.#track(id, done);
    return { job: { ...job }, done };
  }

  #track(id: number, done: Promise<unknown>): void {
    this.#done.set(id, done);
    void done.then(() => this.#done.delete(id), () => this.#done.delete(id));
  }

  /** Arbitrary commands have no durable execution cursor; review a fresh attempt instead. */
  canContinue(_id: number): boolean { return false; }

  continueWithMore(_id: number, _more: Budget = {}): never {
    throw new Error('Direct continuation is unavailable. Review restart in Recovery, then explicitly send the reviewed request in chat.');
  }

  prepareRecovery(id: number, more: Budget = {}): RestartReview {
    const job = this.get(id);
    if (!job) throw new Error('Job not found.');
    if (job.status !== 'interrupted' && job.status !== 'budget') throw new Error('Only interrupted or budget-stopped jobs can be reviewed.');
    return this.#recovery.prepare(job, more);
  }

  stop(id: number): boolean {
    const ac = this.#running.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  /** Stops every job. MNT2: resolves when each has saved its result and report (at most `waitMs`),
   * so a shutdown or a test can close the database without a late write. */
  stopAll(waitMs = 15_000): Promise<void> {
    for (const ac of this.#running.values()) ac.abort();
    const pending = [...this.#done.values()];
    if (!pending.length) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); });
    return Promise.race([Promise.allSettled(pending).then(() => {}), limit]).finally(() => clearTimeout(timer));
  }

  /** Saves the result in the conversation, lets her say what happened, and pings the owner. */
  async #report(job: Job, run: RunResult): Promise<void> {
    const app = this.#app;
    const conv = app.store.getConversation(job.conversationId);
    if (!conv) return;
    const mins = Math.max(0, (Date.parse(job.endedAt!) - Date.parse(job.startedAt)) / 60_000);
    const took = mins < 1 ? `${Math.round(mins * 60)} s` : `${mins.toFixed(1)} min`;
    const budget = job.result?.budget as { reason?: string } | undefined;
    const outcome = job.status === 'ok' ? 'finished' : job.status === 'budget' ? `stopped at ${budget?.reason ?? 'its budget'}` : job.status === 'stopped' ? 'was stopped' : run.timedOut ? 'ran out of time' : `failed (exit code ${job.exitCode ?? 'none'})`;
    const files = job.result?.files as { added?: string[]; changed?: string[]; removed?: string[] } | undefined;
    const names = (l?: string[]) => (l?.length ? ` (${l.slice(0, 12).join(', ')}${l.length > 12 ? ', …' : ''})` : '');
    const fileLine = !files
      ? ''
      : files.added?.length || files.changed?.length || files.removed?.length
        ? `Files: ${files.added?.length ?? 0} added${names(files.added)}, ${files.changed?.length ?? 0} changed${names(files.changed)}, ${files.removed?.length ?? 0} removed${names(files.removed)}.`
        : 'Files: none were changed.';
    // The receipt she (and the owner) can see, and that her words are checked against.
    // Phase 61: the first line as a template too, so the job card reads in the owner's language.
    const headKey =
      job.status === 'ok' ? en('Background job #{id} finished after {took}: {label}')
      : job.status === 'budget' ? en('Background job #{id} stopped at its budget after {took}: {label}')
      : job.status === 'stopped' ? en('Background job #{id} was stopped after {took}: {label}')
      : run.timedOut ? en('Background job #{id} ran out of time after {took}: {label}')
      : en('Background job #{id} failed (exit code {code}) after {took}: {label}');
    const headParams = { id: job.id, took, label: job.label, code: job.exitCode ?? 'none' };
    const receiptText = [`Background job #${job.id} ${outcome} after ${took}: ${job.label}`, fileLine, job.result?.summary ? `Result: ${String(job.result.summary).slice(0, 1500)}` : '', `Last output:\n${job.tail.slice(-1500)}`].filter(Boolean).join('\n');
    // Not in the middle of her answering in that conversation: wait for her to finish (up to 10 min).
    for (let i = 0; i < 600 && app.isBusy?.(conv.id); i++) await new Promise((r) => setTimeout(r, 1000));
    // Saved as an app note (shown to the owner as a job card; she sees it in her history).
    // A task's result card (a bulk Gmail change: done, failed, Undo) rides on the notice.
    const card = job.result?.card && typeof job.result.card === 'object' ? { card: job.result.card } : {};
    const notice = app.store.addMessage(conv.id, 'notice', `job:${receiptText}`, { job: job.id, status: job.status, ...card, ...(job.status === 'budget' ? {} : { key: headKey, params: headParams }) });
    app.events?.publish({ type: 'message', conversationId: conv.id, message: notice, reason: 'job' });
    if (job.status === 'stopped') return; // the owner stopped it; nothing to announce
    if (job.status === 'budget') {
      // Phase 52: a plain message (no model call: the budget is used up), with the Continue button.
      const text = budget?.reason
        ? trOwner('I stopped {label} at {reason}, so it didn\'t go past it. What it did so far is kept. Open Recovery to review a fresh restart before sending it in chat.', app.settings.get(), { label: job.label, reason: budget.reason }, identityOf(app.persona))
        : trOwner('I stopped {label} at its budget, so it didn\'t go past it. What it did so far is kept. Open Recovery to review a fresh restart before sending it in chat.', app.settings.get(), { label: job.label }, identityOf(app.persona));
      const msg = app.store.addMessage(conv.id, 'assistant', text, { job: job.id, budget: true });
      app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'job' });
      return;
    }

    // Her short message about it (her voice; can't claim more than the receipt shows).
    let text = '';
    try {
      const s = app.settings.get();
      const system = buildSystemPrompt(app.persona, { now: app.now(), timeZone: s.timeZone, ownerName: s.ownerName });
      const owner = s.ownerName?.trim() || 'the owner';
      const note = `[Note from the app, not from ${owner}: a background job you started has ended. Here is exactly what happened:\n${receiptText}\n\nTell ${owner} the result in 1 to 3 short sentences: what ran, whether it worked, and the key detail (e.g. failing tests by name, or what changed). Only what the result above shows; if it failed, say so plainly and suggest the next step.]`;
      text = (await complete(app, conv, [{ role: 'system', content: system }, { role: 'user', content: note }], 300, 'quick')).trim();
    } catch {
      text = '';
    }
    const receipt: Receipt = { name: 'start_job', status: job.status === 'ok' ? 'ok' : 'error', args: { label: job.label }, output: receiptText };
    if (!text || checkClaims(text, [receipt]).length || detectMinorSexualContent(text, { fromHer: true })) {
      // Phase 61: the app's own fallback words, in the owner's language.
      text = job.status === 'ok' ? trOwner('Done: {label} finished ({took}).', app.settings.get(), { label: job.label, took }, identityOf(app.persona)) : run.timedOut ? trOwner('Heads up: {label} ran out of time. The details are in the job result above.', app.settings.get(), { label: job.label }, identityOf(app.persona)) : trOwner('Heads up: {label} failed (exit code {code}). The details are in the job result above.', app.settings.get(), { label: job.label, code: job.exitCode ?? 'none' }, identityOf(app.persona));
    }
    const msg = app.store.addMessage(conv.id, 'assistant', app.redactor.redact(text), { job: job.id });
    // Published like her other messages: the app shows it, phones get a notification, and the
    // Telegram/Discord bridges pass it on when set to.
    app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'job' });
    // Phase 26: and a call, if the owner wants long tasks to ring.
    if (app.calls?.wants('job')) app.calls.ring({ kind: 'job', reason: `${job.label} ${outcome}`, brief: msg.content, conversationId: conv.id });
  }
}
