// Phase 86 (harness track M11, docs/design/HARNESS_TRACK.md §3 M11): red-team mode. Before you ship,
// she tries to BREAK her own output, entirely inside an M5 sandbox copy of the project at its current
// state, with the network off and a budget of its own shown up front:
//   a) the project's tests (npm/pnpm/yarn test, pytest, go test, cargo test) in a copy: failures are
//      recorded;
//   b) the app started in the copy (a Node or Python start file, a port the harness picked and checked
//      free, a bounded start time), then the FIXED catalogue of generic robustness inputs
//      (src/redteam-probes.ts) at every entry point the M7 threat map found: crashes (5xx, the
//      process ending, uncaught errors in its log), hangs, stack traces and secrets in responses;
//   c) insecure defaults in the code and config, and the headers the app really sent;
//   d) the attacker side: the Coding model may write up to N small probe scripts against the
//      sandboxed app only. Code checks each script first (src/redteam-probes.ts validateScript: only
//      APP_URL, no other hosts, no installs, no programs, no process stopping, no files outside the
//      copy); its requests go through the driver's recording proxy, so what happened is observed by
//      code, never taken from the script's word. Without OS isolation (Windows copy-only mode) the
//      scripts are shown to the owner and run only after his OK, never by themselves;
//   e) the Reviewing model (stronger; falls back to Coding) validates every candidate break: it must
//      cite the reproducing input, the observed output and the code line, each checked by code, and
//      re-running the probe in a fresh copy must reproduce it. Anything else is dropped ("no theater").
// Breaks become findings (source 'redteam') in the one table; "Fix what broke" goes through
// FixBranches.startBatch with this module's re-check (the reproducing probe must now pass, the tests
// must pass, the M6/M7 checks must not find more). Nothing is ever pushed. Every probe and result is
// on the run (M3, kind 'redteam'); a fixed break becomes a lesson (M10).
import { lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext, BeforeTool, TurnHooks } from './chat.ts';
import { resolveChain } from './chat.ts';
import { isCloudModelName } from './model-names.ts';
import {
  BREAK_RULES,
  breaksIn,
  citeFromTrace,
  DRIVER_DIR,
  DRIVER_SOURCE,
  detectStart,
  detectTestCommand,
  driverEvents,
  headerFindings,
  insecureDefaults,
  KIND_WORDS,
  maskSecrets,
  observedText,
  paramsOf,
  planProbes,
  probeLine,
  subRoutes,
  projectFiles,
  projectSecrets,
  testFailures,
  validateScript,
  type BreakKind,
  type DriverPlan,
  type Exchange,
  type Params,
  type Probe,
  type ProbeKind,
  type ScriptLang,
  type StartPlan,
} from './redteam-probes.ts';
import { RunRecorder } from './runs.ts';
import { runInSandbox, type Isolation, type SandboxFinding } from './sandbox-run.ts';
import { readWorkspaceText, validateQuotes, type Finding, type FindingSeverity, type FindingStore, type NewFinding } from './security/findings.ts';
import { git, repoState } from './security/git.ts';
import { askModel, jsonIn } from './security/pass.ts';
import { checkFile } from './security/rules.ts';
import { analyze, type Entry } from './security/threat-graph.ts';
import type { Conversation } from './store.ts';
import { lessonText, normalizeMessage } from './triggers.ts';
import { workspaceDir } from './tools/workspace.ts';

// ------------------------------------------------------------------------------------------------
// Settings (Settings → Coding → Coding projects → Red-team before shipping)
// ------------------------------------------------------------------------------------------------

export type ShipMode = 'off' | 'ask' | 'always';
export const SHIP_MODES: readonly ShipMode[] = ['ask', 'always', 'off'];
export const SCRIPT_CHOICES = [0, 1, 3, 5] as const;
export const RT_BUDGET_CHOICES = [10_000, 30_000, 100_000] as const;
export const RT_MINUTE_CHOICES = [2, 5, 10] as const;
export interface RedTeamSettings {
  /** Before a push / PR / release she is asked to do: Off / Ask me (default) / Always. */
  ship: ShipMode;
  /** How many probe scripts the attacker model may write per run (0 = none). */
  scripts: number;
  /** Tokens for the attacker and the reviewer together (M4: no override; it stops). */
  budgetTokens: number;
  /** The whole run's time limit. */
  minutes: number;
}
export const DEFAULT_REDTEAM: RedTeamSettings = { ship: 'ask', scripts: 3, budgetTokens: 30_000, minutes: 5 };

export function redteamSettings(s: { redteam?: Partial<RedTeamSettings> } | undefined): RedTeamSettings {
  const r = s?.redteam ?? {};
  return {
    ship: SHIP_MODES.includes(r.ship as ShipMode) ? (r.ship as ShipMode) : DEFAULT_REDTEAM.ship,
    scripts: (SCRIPT_CHOICES as readonly number[]).includes(Number(r.scripts)) ? Number(r.scripts) : DEFAULT_REDTEAM.scripts,
    budgetTokens: (RT_BUDGET_CHOICES as readonly number[]).includes(Number(r.budgetTokens)) ? Number(r.budgetTokens) : DEFAULT_REDTEAM.budgetTokens,
    minutes: (RT_MINUTE_CHOICES as readonly number[]).includes(Number(r.minutes)) ? Number(r.minutes) : DEFAULT_REDTEAM.minutes,
  };
}
export function mergeRedteam(cur: RedTeamSettings, body: Record<string, unknown>): RedTeamSettings {
  // An unknown value keeps the saved one (never silently falls back to the default).
  const valid: Record<string, (v: unknown) => boolean> = {
    ship: (v) => SHIP_MODES.includes(v as ShipMode),
    scripts: (v) => (SCRIPT_CHOICES as readonly number[]).includes(Number(v)),
    budgetTokens: (v) => (RT_BUDGET_CHOICES as readonly number[]).includes(Number(v)),
    minutes: (v) => (RT_MINUTE_CHOICES as readonly number[]).includes(Number(v)),
  };
  return redteamSettings({ redteam: { ...cur, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => valid[k]?.(v))) } as Partial<RedTeamSettings> });
}

// ------------------------------------------------------------------------------------------------
// The report
// ------------------------------------------------------------------------------------------------

export type ReportStatus = 'running' | 'awaiting' | 'done' | 'stopped' | 'error';

export interface ScriptItem {
  id: string;
  lang: ScriptLang;
  purpose: string;
  code: string;
  status: 'rejected' | 'awaiting' | 'ran' | 'skipped' | 'approved';
  problems?: string[];
  requests?: number;
  note?: string;
}

export interface BreakItem {
  findingId: number;
  kind: string;
  severity: FindingSeverity;
  title: string;
  entry: string;
  /** The reproducing input (a request line, the command's arguments, a script's request). */
  input: string;
  observed: string;
  file: string | null;
  line: number | null;
  quote: string | null;
  by: 'probe' | 'script' | 'tests' | 'default';
  reproduced: boolean;
  /** Other inputs that broke the same way. */
  also: number;
}

export interface RedTeamReport {
  id: number;
  workspace: string;
  conversationId: string | null;
  runId: number | null;
  reason: 'ask' | 'ship';
  status: ReportStatus;
  stage: string;
  startedAt: string;
  endedAt?: string;
  isolation: { driver: string; isolated: boolean; label: string };
  budget: { tokens: number; minutes: number; usedTokens: number; ms: number };
  plan: PlanView;
  tests: { command: string; ran: boolean; exitCode: number | null; timedOut: boolean; failures: string[]; output: string; note?: string } | null;
  app: { started: boolean; port: number | null; why?: string | null; log: string[] } | null;
  tried: { probes: number; byKind: Partial<Record<ProbeKind, number>>; entries: { id: string; label: string; probes: number }[]; defaults: number; scripts: number; behaviour: { rule: string; title: string; severity: string }[] };
  candidates: number;
  dropped: { title: string; why: string; input?: string }[];
  breaks: BreakItem[];
  scripts: ScriptItem[];
  attacker: { ran: boolean; model?: string; note?: string; written: number; rejected: number };
  reviewer: { ran: boolean; model?: string; note?: string; kept: number; dropped: number };
  error?: string;
}

export interface PlanView {
  workspace: string;
  entries: { id: string; kind: string; label: string; file: string; line: number; params: Params }[];
  probes: number;
  capped: number;
  notTried: string[];
  tests: string | null;
  start: (StartPlan & { command: string }) | { none: string };
  isolation: { driver: string; isolated: boolean; label: string };
  budget: { tokens: number; minutes: number };
  scripts: { max: number; needApproval: boolean };
  defaults: string[];
}

/** A candidate that passed reproduction and review. */
type Kept = Candidate & { severity: FindingSeverity; title: string; quote: { file: string; line: number; quote: string } | null; reviewed: boolean };

/** One candidate break before validation. */
interface Candidate {
  cid: string;
  kind: BreakKind;
  by: 'probe' | 'script' | 'tests';
  entry: Entry | undefined;
  probe?: Probe;
  script?: { id: string; lang: ScriptLang; code: string; method: string; path: string };
  input: string;
  observed: string;
  /** Code-cited line (a project frame in the trace, else the entry's own line). */
  cite?: { file: string; line: number; quote: string };
  also: number;
}

// ------------------------------------------------------------------------------------------------
// The store (one row per red-team run; additive table in each space's sara.db)
// ------------------------------------------------------------------------------------------------


/** How long a reproduction waits for an answer to a break that was not a hang (see #patient). */
const REPRO_WAIT_MS = 15_000;
export class RedTeamStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS redteam_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      run_id INTEGER,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS redteam_ws ON redteam_runs(workspace, id);`);
  }
  create(r: Omit<RedTeamReport, 'id'>): RedTeamReport {
    const now = new Date().toISOString();
    const res = this.#db.prepare('INSERT INTO redteam_runs (workspace, conversation_id, run_id, status, report, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.workspace, r.conversationId, r.runId, r.status, '{}', now, now);
    const full = { ...r, id: Number(res.lastInsertRowid) } as RedTeamReport;
    this.save(full);
    return full;
  }
  save(r: RedTeamReport): void {
    this.#db.prepare('UPDATE redteam_runs SET status = ?, run_id = ?, report = ?, updated_at = ? WHERE id = ?').run(r.status, r.runId, JSON.stringify(r).slice(0, 2_000_000), new Date().toISOString(), r.id);
  }
  get(id: number): RedTeamReport | undefined {
    const row = this.#db.prepare('SELECT report FROM redteam_runs WHERE id = ?').get(id) as { report: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.report) as RedTeamReport;
    } catch {
      return undefined;
    }
  }
  list(workspace?: string, limit = 20): RedTeamReport[] {
    const rows = (workspace ? this.#db.prepare('SELECT report FROM redteam_runs WHERE workspace = ? ORDER BY id DESC LIMIT ?').all(workspace, limit) : this.#db.prepare('SELECT report FROM redteam_runs ORDER BY id DESC LIMIT ?').all(limit)) as { report: string }[];
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.report) as RedTeamReport];
      } catch {
        return [];
      }
    });
  }
  /** Start-up: runs cut short by a restart are marked stopped. */
  recover(): number {
    let n = 0;
    for (const r of this.list(undefined, 200)) {
      if (r.status !== 'running') continue;
      this.save({ ...r, status: 'stopped', stage: '', error: 'Interrupted by a restart.', endedAt: new Date().toISOString() });
      n++;
    }
    return n;
  }
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

/** A free loopback port (from SARA_REDTEAM_PORTS "a-b" when set, else one the system picks). */
export async function freePort(range?: [number, number]): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number>((res) => {
      const s = createServer();
      s.once('error', () => res(-1));
      s.listen(p, '127.0.0.1', () => {
        const got = (s.address() as { port: number }).port;
        s.close(() => res(got));
      });
    });
  if (range) {
    for (let p = range[0]; p <= range[1]; p++) {
      if (p >= 7860 && p <= 7863) continue;
      const got = await tryPort(p);
      if (got > 0) return got;
    }
    throw new Error(`No free port in ${range[0]}-${range[1]}.`);
  }
  const got = await tryPort(0);
  if (got <= 0) throw new Error('No free port.');
  return got;
}

export function portRange(env: NodeJS.ProcessEnv = process.env): [number, number] | undefined {
  const m = /^(\d{2,5})-(\d{2,5})$/.exec(String(env.SARA_REDTEAM_PORTS ?? '').trim());
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 1023 && b >= a && b < 65536 ? [a, b] : undefined;
}

/** M7's entry points (the environment left out) plus routes inside plain server functions. */
export function entriesOf(files: string[], read: (rel: string) => string | undefined): Entry[] {
  const a = analyze(files, read);
  return [...a.entries.filter((e) => e.kind !== 'env'), ...subRoutes(files, read)];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const KIND_GROUP: Record<BreakKind, string> = { exit: 'down', crash: 'error', uncaught: 'error', timeout: 'hang', 'stack-trace': 'trace', 'secret-echo': 'secret' };
/** Shipping actions she may be asked to do (the gate asks / runs first). */
export function isShipAction(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'git_push' || tool === 'github_open_pr') return true;
  const cmd = String(args.command ?? args.cmd ?? '');
  if ((tool === 'shell' || tool === 'git') && /\bgit\s+push\b|\bgh\s+(?:pr\s+create|release\s+create)\b|\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|^\s*push\b/.test(cmd)) return true;
  return false;
}

const ATTACKER_SYSTEM = `You test the robustness of the owner's OWN app, which runs in a throwaway sandbox copy with the network off. Write up to {N} small probe scripts that send unusual but harmless input to the app's entry points: empty, very long, unusual Unicode, path-like text, quotes, numbers out of range, wrong types, missing or duplicated fields, malformed JSON. No exploit payloads, no attacks on other systems.
Rules (checked by code; a script that breaks one is thrown away):
- Node ES module (lang "node") or Python 3 (lang "python"). At most 60 lines.
- Reach the app ONLY through the environment variable APP_URL, e.g. the built-in fetch with process.env.APP_URL + '/path?x=1', or urllib.request.urlopen(os.environ['APP_URL'] + '/path'). No other address, host or port.
- No other modules than node:assert, node:url, node:querystring, node:util, node:buffer (Node; fetch is built in) or json, urllib, http.client, sys, time, string, os.environ (Python).
- No programs, installs, process stopping, file writes, eval, other environment values.
- Catch errors and keep going; the harness records every request and response itself.
Answer with JSON only: {"scripts":[{"lang":"node","purpose":"one sentence","code":"..."}]}`;

const REVIEW_SYSTEM = `You are the second pass of a red-team run on the owner's own app. Each candidate is something that looked like a break when unusual input was sent to the app in a sandbox. Decide for each whether it is a REAL robustness or exposure problem, and cite the evidence.
Answer with JSON only: {"breaks":[{"id":"C1","real":true,"severity":"high|medium|low","title":"what breaks, in plain words","input":"copied from the candidate's input","observed":"copied from the candidate's observed output","file":"path as given","line":12,"quote":"one code line copied character for character"}]}
Rules:
- "input" and "observed" must be copied from the candidate exactly (a part is fine). "quote" must be ONE line copied exactly from the code shown: the line that fails or should check the input.
- Set "real": false for things that are not problems (a 404 for a missing page, a 400 for bad input is GOOD behaviour).
- Do not add candidates. A candidate you leave out is dropped.`;

// ------------------------------------------------------------------------------------------------
// RedTeam
// ------------------------------------------------------------------------------------------------

export interface StartInput {
  workspace: string;
  wsDir: string;
  conversationId?: string | null;
  reason?: 'ask' | 'ship';
  private?: boolean;
  /** Tests: a fixed port range for the sandboxed app. */
  ports?: [number, number];
}

export class RedTeam {
  readonly store: RedTeamStore;
  readonly findings: FindingStore;
  readonly #app: AppContext;
  /** Runs going on now (tests await them). */
  readonly running = new Map<number, { promise: Promise<RedTeamReport>; ctrl: AbortController }>();
  /** Scripts waiting for the owner's OK, by report id (kept until approved or skipped). */
  readonly #pending = new Map<number, { input: StartInput; scripts: ScriptItem[]; start: StartPlan | null; entries: Entry[] }>();
  /** Test hook: isolation override (tests run the copy-only driver on every platform). */
  isolation?: () => Isolation;
  /** How long the app may take to start and each request to answer (tests shorten them). */
  timing = { startMs: 15_000, reqMs: 5_000 };

  constructor(app: AppContext, findings: FindingStore, db: DatabaseSync) {
    this.#app = app;
    this.findings = findings;
    this.store = new RedTeamStore(db);
  }

  settings(): RedTeamSettings {
    return redteamSettings(this.#app.settings.get() as { redteam?: Partial<RedTeamSettings> });
  }

  #iso(): Isolation {
    if (this.isolation) return this.isolation();
    const gate = this.#app.sandboxGate;
    return gate ? gate.isolation() : { driver: 'copy', isolated: false, label: 'Not isolated' };
  }

  /** What a run would do, before anything runs (the estimate shown up front). */
  plan(workspace: string, wsDir: string): PlanView {
    const s = this.settings();
    const iso = this.#iso();
    const read = (f: string) => readWorkspaceText(wsDir, f);
    const files = projectFiles(wsDir);
    const all = entriesOf(files, read);
    const entries = all.slice(0, 60).map((e) => ({ id: e.id, kind: e.kind, label: e.label, file: e.file, line: e.line, params: paramsOf(read(e.file) ?? '', e) }));
    const { probes, capped } = planProbes(all.filter((e) => e.kind === 'http' || e.kind === 'upload' || e.kind === 'cli').slice(0, 60).map((e) => ({ entry: e, params: entries.find((x) => x.id === e.id)?.params ?? { query: [], body: [], path: [] } })));
    const start = detectStart(wsDir, read);
    const notTried = all.filter((e) => e.kind === 'message').map((e) => `${e.label} (${e.file}:${e.line}): messages are not probed`);
    if ('none' in start && all.some((e) => e.kind === 'http' || e.kind === 'upload')) notTried.push(`HTTP entry points: ${start.none}`);
    return {
      workspace,
      entries,
      probes: probes.filter((p) => p.type === 'cli' || !('none' in start)).length,
      capped,
      notTried,
      tests: detectTestCommand(wsDir) ?? null,
      start: 'none' in start ? start : { ...start, command: `${start.lang === 'node' ? 'node' : 'python'} ${start.file}` },
      isolation: { driver: iso.driver, isolated: iso.isolated, label: iso.label },
      budget: { tokens: s.budgetTokens, minutes: s.minutes },
      scripts: { max: s.scripts, needApproval: !iso.isolated },
      defaults: ['debug-on', 'default-credentials', 'cors-wildcard', 'missing-headers', 'listen-all', 'world-writable', 'env-committed'],
    };
  }

  get(id: number): RedTeamReport | undefined {
    return this.store.get(id);
  }

  list(workspace?: string): RedTeamReport[] {
    return this.store.list(workspace);
  }

  /** Starts a run in the background; returns the report (status running). */
  start(input: StartInput): RedTeamReport {
    for (const [id, r] of this.running) if (this.store.get(id)?.workspace === input.workspace && r) throw new Error(`A red-team run is already going on in this project (#${id}).`);
    const s = this.settings();
    const plan = this.plan(input.workspace, input.wsDir);
    const conv = input.conversationId ? this.#app.store.getConversation(input.conversationId) : undefined;
    const rec = this.#app.runs ? new RunRecorder(this.#app.runs, { kind: 'redteam', conversationId: conv?.id ?? null, title: `Red team: ${input.workspace}`, budget: { tokens: s.budgetTokens, minutes: s.minutes } }) : RunRecorder.none();
    const report = this.store.create({
      workspace: input.workspace,
      conversationId: conv?.id ?? null,
      runId: rec.on ? rec.id : null,
      reason: input.reason ?? 'ask',
      status: 'running',
      stage: 'starting',
      startedAt: new Date().toISOString(),
      isolation: plan.isolation,
      budget: { tokens: s.budgetTokens, minutes: s.minutes, usedTokens: 0, ms: 0 },
      plan,
      tests: null,
      app: null,
      tried: { probes: 0, byKind: {}, entries: [], defaults: 0, scripts: 0, behaviour: [] },
      candidates: 0,
      dropped: [],
      breaks: [],
      scripts: [],
      attacker: { ran: false, written: 0, rejected: 0 },
      reviewer: { ran: false, kept: 0, dropped: 0 },
    });
    const ctrl = new AbortController();
    const promise = this.#run(report, input, rec, ctrl.signal).catch((err: Error) => {
      const r = this.store.get(report.id) ?? report;
      const out = { ...r, status: 'error' as const, stage: '', error: err.message.slice(0, 500), endedAt: new Date().toISOString() };
      this.store.save(out);
      rec.close('error');
      return out;
    });
    this.running.set(report.id, { promise, ctrl });
    void promise.finally(() => {
      this.running.delete(report.id);
      this.#publish(report.id);
    });
    return report;
  }

  stop(id: number): RedTeamReport | undefined {
    this.running.get(id)?.ctrl.abort();
    this.#pending.delete(id);
    const r = this.store.get(id);
    if (r && r.status === 'awaiting') {
      for (const sc of r.scripts) if (sc.status === 'awaiting') sc.status = 'skipped';
      this.store.save({ ...r, status: 'done', stage: '', endedAt: new Date().toISOString() });
    }
    return this.store.get(id);
  }

  #publish(id: number): void {
    const r = this.store.get(id);
    if (!r) return;
    this.#app.events?.publish({ type: 'findings', conversationId: r.conversationId, workspace: r.workspace, summary: { kind: 'redteam', id: r.id, status: r.status, breaks: r.breaks.length } as never });
  }

  /** Runs one command (the driver or the tests) in a fresh M5 sandbox copy, network off. */
  async #sandbox(wsDir: string, command: string, timeoutMs: number, signal: AbortSignal, inject?: Record<string, string>) {
    const gate = this.#app.sandboxGate;
    const iso = this.#iso();
    const g = gate?.settings();
    return runInSandbox(wsDir, command, { cacheDir: gate?.cacheDir ?? `${this.#app.dataDir}/cache/sandbox-runs`, base: this.#app.sandbox, isolation: iso, network: false, timeoutMs, signal, maxBytes: (g?.maxMB ?? 500) * 1048576, keep: false, ...(g?.dockerImage ? { dockerImage: g.dockerImage } : {}), preferWorktree: false, ...(inject ? { inject } : {}) });
  }

  /**
   * Reproduction waits for the answer itself (up to REPRO_WAIT_MS) for every break that was not a
   * hang: judged by the hang limit, a crash that answers slowly on a busy machine came back as a
   * "timeout" and was dropped as not reproduced. A hang is still judged by the hang limit.
   */
  #patient<T extends object>(x: T, kinds: BreakKind[]): T {
    return kinds.includes('timeout') ? x : { ...x, waitMs: REPRO_WAIT_MS };
  }

  /** Runs the driver with a plan in a sandbox copy of `dir`; returns its events and the try's findings. */
  async #drive(dir: string, plan: DriverPlan, scripts: Record<string, string>, signal: AbortSignal): Promise<{ events: Record<string, unknown>[]; behaviour: SandboxFinding[]; output: string; notRun?: string }> {
    const inject: Record<string, string> = { [`${DRIVER_DIR}/driver.mjs`]: DRIVER_SOURCE, [`${DRIVER_DIR}/plan.json`]: JSON.stringify(plan), ...scripts };
    const r = await this.#sandbox(dir, `node ${DRIVER_DIR}/driver.mjs`, plan.deadlineMs + plan.startMs + 20_000, signal, inject);
    const output = r.run?.output ?? '';
    return { events: driverEvents(output), behaviour: r.findings, output, ...(r.notRun ? { notRun: r.notRun } : {}) };
  }

  async #run(report: RedTeamReport, input: StartInput, rec: RunRecorder, outer: AbortSignal): Promise<RedTeamReport> {
    const t0 = Date.now();
    const s = this.settings();
    const signal = AbortSignal.any([outer, AbortSignal.timeout(s.minutes * 60_000)]);
    const left = () => Math.max(0, s.minutes * 60_000 - (Date.now() - t0));
    const save = (p: Partial<RedTeamReport>) => {
      Object.assign(report, p, { budget: { ...report.budget, usedTokens: rec.on ? rec.totals().tokens : report.budget.usedTokens, ms: Date.now() - t0 } });
      this.store.save(report);
    };
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const files = projectFiles(input.wsDir);
    const entries = entriesOf(files, read);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const secrets = projectSecrets(input.wsDir);
    const start = detectStart(input.wsDir, read);
    const startPlan = 'none' in start ? null : start;
    const candidates: Candidate[] = [];
    let cn = 0;
    // a) The project's tests.
    rec.startStep({ label: 'Run the tests' });
    save({ stage: 'running the tests' });
    const testCmd = detectTestCommand(input.wsDir);
    if (testCmd && !signal.aborted) {
      const tt = Date.now();
      const r = await this.#sandbox(input.wsDir, testCmd, Math.min(left(), (this.#app.sandboxGate?.settings().timeLimitS ?? 120) * 1000), signal);
      const out = r.run?.output ?? r.notRun ?? '';
      const failures = r.run && r.run.exitCode !== 0 ? testFailures(out) : [];
      report.tests = { command: testCmd, ran: Boolean(r.run), exitCode: r.run?.exitCode ?? null, timedOut: r.run?.timedOut ?? false, failures, output: out.length > 4000 ? `…${out.slice(-4000)}` : out, ...(r.notRun ? { note: r.notRun } : {}) };
      rec.tool({ id: 'tests', name: 'redteam_tests', summary: testCmd, args: { command: testCmd }, status: r.run?.exitCode === 0 ? 'ok' : 'error', output: out, ms: Date.now() - tt });
      if (r.run && r.run.exitCode !== 0) {
        const line = failures[0] ?? out.split(/\r?\n/).reverse().find((l) => /fail|error/i.test(l))?.trim() ?? `exit code ${r.run.exitCode}`;
        candidates.push({ cid: `C${++cn}`, kind: 'crash', by: 'tests', entry: undefined, input: testCmd, observed: clip(`${line}\n${failures.slice(1, 6).join('\n')}`, 1500), also: Math.max(0, failures.length - 1) });
      }
    }
    save({});
    // b) The app in a copy, and the fixed catalogue at every entry point.
    rec.startStep({ label: 'Probe the entry points' });
    save({ stage: 'probing the entry points' });
    const paramsBy = new Map(entries.map((e) => [e.id, paramsOf(read(e.file) ?? '', e)]));
    const { probes } = planProbes(entries.filter((e) => e.kind === 'http' || e.kind === 'upload' || e.kind === 'cli').slice(0, 60).map((e) => ({ entry: e, params: paramsBy.get(e.id)! })));
    const runnable = probes.filter((p) => p.type === 'cli' || startPlan);
    const cliFiles = Object.fromEntries(entries.filter((e) => e.kind === 'cli').map((e) => [e.id, e.file]));
    let port: number | null = null;
    let exchanges: Exchange[] = [];
    let baseline: Exchange | undefined;
    if ((runnable.length || startPlan) && !signal.aborted && left() > 15_000) {
      port = startPlan?.portFrom === 'fixed' ? startPlan.port! : await freePort(input.ports ?? portRange());
      const plan: DriverPlan & { cli: Record<string, string> } = { mode: 'probe', start: startPlan, port, startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: false, probes: runnable, scripts: [], scriptMs: 20_000, deadlineMs: Math.max(5_000, left() - 25_000), cli: cliFiles };
      const tt = Date.now();
      const d = await this.#drive(input.wsDir, plan, {}, signal);
      const st = d.events.find((e) => e.t === 'start');
      const done = d.events.find((e) => e.t === 'done');
      report.app = startPlan ? { started: Boolean(st?.ok), port, why: (st?.why as string | null) ?? d.notRun ?? (st ? null : 'the driver did not run'), log: ((done?.log ?? st?.log ?? []) as string[]).slice(-30).map((l) => maskSecrets(l, secrets)) } : null;
      exchanges = d.events.filter((e) => e.t === 'x') as unknown as Exchange[];
      report.tried.behaviour = d.behaviour.filter((f) => f.severity !== 'info').map((f) => ({ rule: f.rule, title: f.title, severity: f.severity }));
      for (const x of exchanges) {
        const p = runnable.find((q) => q.id === x.probe);
        if (!p) continue;
        report.tried.probes++;
        report.tried.byKind[p.kind] = (report.tried.byKind[p.kind] ?? 0) + 1;
        if (p.kind === 'baseline' && !baseline && x.status !== null && x.status < 500) baseline = x;
        const kinds = breaksIn(x, secrets);
        rec.tool({ id: p.id, name: 'redteam_probe', summary: probeLine(p), args: { entry: p.entry, kind: p.kind, ...(p.type === 'http' ? { method: p.method, path: clip(p.path, 300) } : { args: p.args.map((a) => clip(a, 80)) }) }, status: kinds.length ? 'error' : 'ok', output: clip(`${kinds.length ? `broke: ${kinds.join(', ')}\n` : ''}${maskSecrets(observedText(x), secrets)}`, 2000), ms: x.ms });
        if (p.kind === 'baseline' && !kinds.includes('secret-echo') && !kinds.includes('exit')) continue;
        for (const k of kinds) {
          const e = byId.get(p.entry);
          const same = candidates.find((c) => c.by === 'probe' && c.entry?.id === p.entry && KIND_GROUP[c.kind] === KIND_GROUP[k]);
          if (same) {
            same.also++;
            continue;
          }
          candidates.push({ cid: `C${++cn}`, kind: k, by: 'probe', entry: e, probe: p, input: probeLine(p), observed: maskSecrets(observedText(x), secrets), cite: this.#cite(input.wsDir, files, `${x.body}\n${x.log.join('\n')}\n${x.output ?? ''}`, e), also: 0 });
        }
      }
      report.tried.entries = entries.map((e) => ({ id: e.id, label: e.label, probes: exchanges.filter((x) => runnable.find((q) => q.id === x.probe)?.entry === e.id).length }));
      rec.tool({ id: 'driver', name: 'redteam_app', summary: startPlan ? `${startPlan.lang} ${startPlan.file} on 127.0.0.1:${port}` : 'command-line probes', args: { port }, status: report.app?.started === false ? 'error' : 'ok', output: clip(`${report.app?.why ?? ''}\n${(report.app?.log ?? []).join('\n')}`, 2000), ms: Date.now() - tt });
    } else if (startPlan === null && 'none' in start) report.app = { started: false, port: null, why: start.none, log: [] };
    save({});
    // c) Insecure defaults: code and config, and the headers the app really sent.
    rec.startStep({ label: 'Insecure defaults' });
    save({ stage: 'checking insecure defaults' });
    const tracked = new Set(repoState(input.wsDir).repo ? git(input.wsDir, ['ls-files', '-z']).out.split('\0').filter(Boolean) : []);
    const configs = [...new Set([...files, ...[...tracked].filter((f) => /(?:^|\/)\.env[^/]*$|\.(?:json|ya?ml|toml|ini|cfg|conf)$/.test(f))])];
    const defaults = insecureDefaults(configs, read, { tracked, ...(process.platform !== 'win32' ? { mode: (rel: string) => this.#mode(input.wsDir, rel) } : {}) });
    if (baseline && startPlan) {
      const listenAt = this.#listenLine(read(startPlan.file), startPlan.file);
      defaults.push(...headerFindings(baseline.headers, listenAt, `${baseline.status} ${Object.keys(baseline.headers ?? {}).join(', ')}`));
    }
    report.tried.defaults = report.plan.defaults.length;
    rec.tool({ id: 'defaults', name: 'redteam_defaults', summary: 'insecure defaults', args: { files: configs.length }, status: defaults.length ? 'error' : 'ok', output: defaults.map((d) => `${d.rule} ${d.file ?? ''}:${d.line ?? ''} ${d.quote ?? ''}`).join('\n') || 'none', ms: 0 });
    // d) The attacker model's scripts (validated by code; without isolation: the owner's OK first).
    let scriptCands: Candidate[] = [];
    if (s.scripts > 0 && startPlan && report.app?.started && !signal.aborted) {
      rec.startStep({ label: 'Attacker scripts' });
      save({ stage: 'asking the Coding model for probe scripts' });
      const written = await this.#attacker(input, entries, paramsBy, candidates, rec, s, signal);
      report.attacker = written.info;
      report.scripts = written.scripts;
      const ok = written.scripts.filter((x) => x.status === 'awaiting');
      if (ok.length) {
        const iso = this.#iso();
        if (iso.isolated) {
          for (const x of ok) x.status = 'approved';
          scriptCands = await this.#runScripts(input, report, ok, startPlan, entries, secrets, rec, signal, () => cn++);
          cn += scriptCands.length;
        } else {
          // §7 #1 / the brief: on a computer without OS isolation, the owner reads and approves each script.
          this.#pending.set(report.id, { input, scripts: ok, start: startPlan, entries });
        }
      }
    }
    save({});
    // e) Reproduce, then the Reviewing model, then findings.
    const final = await this.#validate(input, report, [...candidates, ...scriptCands], startPlan, secrets, rec, s, signal);
    this.#file(input, report, final, defaults, rec);
    const awaiting = this.#pending.has(report.id);
    save({ status: signal.aborted && !awaiting ? (outer.aborted ? 'stopped' : 'done') : awaiting ? 'awaiting' : 'done', stage: awaiting ? 'waiting for your OK on the probe scripts' : '', ...(awaiting ? {} : { endedAt: new Date().toISOString() }), ...(signal.aborted && !outer.aborted ? { error: 'Stopped at the time limit.' } : {}) });
    if (!awaiting) rec.close(signal.aborted ? 'error' : 'ok');
    else this.#recs.set(report.id, rec);
    return report;
  }

  /** Recorders of runs waiting for script approval (closed when they finish). */
  readonly #recs = new Map<number, RunRecorder>();

  #mode(dir: string, rel: string): number | undefined {
    try {
      return lstatSync(`${dir}/${rel}`).mode;
    } catch {
      return undefined;
    }
  }

  /** The line that starts listening (where security headers would be set), for header findings. */
  #listenLine(text: string | undefined, file: string): { file: string; line: number; quote: string } | undefined {
    if (!text) return undefined;
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => /\.listen\(|HTTPServer\(|createServer\(|app\.run\(/.test(l));
    return i >= 0 ? { file, line: i + 1, quote: lines[i].trim() } : undefined;
  }

  /** The code line a break points at: a project frame in its trace, else the entry's own line. */
  #cite(wsDir: string, files: string[], text: string, e: Entry | undefined): Candidate['cite'] {
    const at = citeFromTrace(text, files);
    if (at) {
      const line = readWorkspaceText(wsDir, at.file)?.split(/\r?\n/)[at.line - 1]?.trim();
      if (line && line.replace(/\s+/g, '').length >= 6) return { file: at.file, line: at.line, quote: line };
    }
    return e ? { file: e.file, line: e.line, quote: e.quote } : undefined;
  }

  async #chain(input: StartInput, purpose: 'coding' | 'review', rec: RunRecorder) {
    const conv: Conversation = (input.conversationId ? this.#app.store.getConversation(input.conversationId) : undefined) ?? { id: '', title: 'Red team', providerId: null, model: null, workspace: input.workspace, mode: 'coding', private: Boolean(input.private), channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '', updatedAt: '' };
    let chain: ReturnType<typeof resolveChain>;
    try {
      chain = resolveChain(this.#app, conv, purpose);
    } catch {
      return [];
    }
    // A private conversation (or private local mode, via resolveChain) uses only models on this computer.
    if (conv.private || input.private) chain = chain.filter((c) => c.provider.config.local && !isCloudModelName(c.model));
    if (rec.on) chain = chain.map((c) => ({ ...c, provider: rec.wrap(c.provider, purpose === 'review' ? 'red-team review' : 'red-team attacker') }));
    return chain;
  }

  async #attacker(input: StartInput, entries: Entry[], paramsBy: Map<string, Params>, found: Candidate[], rec: RunRecorder, s: RedTeamSettings, signal: AbortSignal): Promise<{ scripts: ScriptItem[]; info: RedTeamReport['attacker'] }> {
    const chain = await this.#chain(input, 'coding', rec);
    if (!chain.length) return { scripts: [], info: { ran: false, note: 'no model', written: 0, rejected: 0 } };
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const code = entries
      .filter((e) => e.kind === 'http' || e.kind === 'upload')
      .slice(0, 12)
      .map((e) => {
        const lines = (read(e.file) ?? '').split(/\r?\n/);
        const p = paramsBy.get(e.id);
        return `${e.id} ${e.label} (${e.file}:${e.line}); reads query ${p?.query.join(', ') || '-'}, body ${p?.body.join(', ') || '-'}, path ${p?.path.join(', ') || '-'}\n${lines.slice(e.line - 1, e.line + 24).map((l, i) => `${String(e.line + i).padStart(4)}| ${l}`).join('\n')}`;
      })
      .join('\n\n');
    const user = `Entry points of the app (found by code):\n${code}\n\nThe fixed catalogue already found: ${found.length ? found.map((c) => `${c.kind} at ${c.entry?.label ?? 'tests'}`).join('; ') : 'nothing'}.\nWrite at most ${s.scripts} scripts that look for OTHER robustness problems.`;
    const system = ATTACKER_SYSTEM.replace('{N}', String(s.scripts));
    const room = s.budgetTokens - (rec.on ? rec.totals().tokens : 0) - Math.ceil((system.length + user.length) / 3.5);
    if (room < 600) return { scripts: [], info: { ran: false, note: 'budget', written: 0, rejected: 0 } };
    let text = '';
    let model = '';
    try {
      ({ text, model } = await askModel(chain, [{ role: 'system', content: system }, { role: 'user', content: user }], Math.min(4000, room), signal));
    } catch (err) {
      return { scripts: [], info: { ran: false, note: `error: ${(err as Error).message.slice(0, 160)}`, written: 0, rejected: 0 } };
    }
    const scripts: ScriptItem[] = [];
    const take = (answer: string, max: number, note?: string) => {
      const j = jsonIn(answer) as { scripts?: unknown[] } | undefined;
      const raw = Array.isArray(j?.scripts) ? j!.scripts : [];
      for (const x of raw.slice(0, max)) {
        if (!x || typeof x !== 'object') continue;
        const o = x as Record<string, unknown>;
        const lang: ScriptLang = String(o.lang ?? 'node').toLowerCase().startsWith('py') ? 'python' : 'node';
        const codeText = String(o.code ?? '').replace(/\r\n/g, '\n');
        const v = validateScript(codeText, lang);
        scripts.push({ id: `S${scripts.length + 1}`, lang, purpose: norm(String(o.purpose ?? '')).slice(0, 200), code: codeText.slice(0, 6000), status: v.ok ? 'awaiting' : 'rejected', ...(v.ok ? {} : { problems: v.problems }), ...(note ? { note } : {}) });
      }
    };
    take(text, s.scripts);
    // One rewrite round: the refused scripts go back with the checks' reasons (the same checks apply
    // to the rewrites; a rewrite that still breaks a rule is refused too).
    const refused = scripts.filter((x) => x.status === 'rejected');
    const room2 = s.budgetTokens - (rec.on ? rec.totals().tokens : 0);
    if (refused.length && room2 >= 1500 && !signal.aborted) {
      const again = `These scripts were refused by the checks:\n\n${refused.map((x) => `${x.id} (${x.lang}): ${(x.problems ?? []).join('; ')}\n${x.code}`).join('\n\n')}\n\nRewrite them so they follow every rule (fetch is built into Node: do not import it). Answer with the same JSON shape.`;
      try {
        const r2 = await askModel(chain, [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: text.slice(0, 6000) }, { role: 'user', content: again }], Math.min(4000, room2 - Math.ceil((system.length + user.length + again.length) / 3.5)), signal);
        take(r2.text, refused.length, 'rewritten after the checks');
      } catch {
        /* the first answer stands */
      }
    }
    for (const sc of scripts) rec.tool({ id: sc.id, name: 'redteam_script', summary: `${sc.id} (${sc.lang}): ${sc.purpose}`, args: { lang: sc.lang }, status: sc.status === 'rejected' ? 'denied' : 'ok', output: `${sc.status === 'rejected' ? `refused: ${(sc.problems ?? []).join('; ')}\n` : ''}${sc.code}`, ms: 0 });
    return { scripts, info: { ran: true, model, written: scripts.length, rejected: scripts.filter((x) => x.status === 'rejected').length } };
  }

  /** Runs approved scripts through the driver's recording proxy; every recorded break is a candidate. */
  async #runScripts(input: StartInput, report: RedTeamReport, list: ScriptItem[], start: StartPlan, entries: Entry[], secrets: string[], rec: RunRecorder, signal: AbortSignal, next: () => number): Promise<Candidate[]> {
    const port = start.portFrom === 'fixed' ? start.port! : await freePort(input.ports ?? portRange());
    const files: Record<string, string> = {};
    const scripts = list.map((x) => {
      const file = `${DRIVER_DIR}/${x.id.toLowerCase()}.${x.lang === 'python' ? 'py' : 'mjs'}`;
      files[file] = x.code;
      return { id: x.id, lang: x.lang, file };
    });
    const plan: DriverPlan = { mode: 'scripts', start, port, startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: true, probes: [], scripts, scriptMs: 20_000, deadlineMs: 90_000 };
    const d = await this.#drive(input.wsDir, plan, files, signal);
    const out: Candidate[] = [];
    let n = 0;
    for (const ev of d.events.filter((e) => e.t === 'script')) {
      const sc = list.find((x) => x.id === ev.id);
      if (!sc) continue;
      const records = (ev.records ?? []) as (Exchange & { method: string; path: string; sent: string })[];
      sc.status = 'ran';
      sc.requests = records.length;
      report.tried.scripts++;
      rec.tool({ id: `${sc.id}-run`, name: 'redteam_script_run', summary: `${sc.id}: ${records.length} requests`, args: { lang: sc.lang }, status: 'ok', output: clip(maskSecrets(`${String(ev.output ?? '')}\n${records.map((r) => `${r.method} ${clip(r.path, 120)} -> ${r.status ?? (r.timedOut ? 'timeout' : 'none')}`).join('\n')}`, secrets), 3000), ms: Number(ev.ms ?? 0) });
      for (const r of records) {
        const kinds = breaksIn({ ...r, probe: sc.id }, secrets);
        for (const k of kinds) {
          const e = entries.find((x) => x.kind === 'http' && x.path && r.path.split('?')[0] === (x.path ?? '').replace(/:[^/]+/g, (m) => r.path.split('?')[0].split('/')[(x.path ?? '').split('/').indexOf(m)] ?? m));
          if (out.some((c) => c.script?.id === sc.id && KIND_GROUP[c.kind] === KIND_GROUP[k] && c.script.path === r.path)) continue;
          const input2 = `${r.method} ${clip(r.path, 300)}${r.sent ? ` with body ${clip(JSON.stringify(r.sent), 200)}` : ''} (from script ${sc.id})`;
          out.push({ cid: `C${next() + 1}S${++n}`, kind: k, by: 'script', entry: e, script: { id: sc.id, lang: sc.lang, code: sc.code, method: r.method, path: r.path }, input: input2, observed: maskSecrets(observedText(r), secrets), cite: this.#cite(input.wsDir, projectFiles(input.wsDir), `${r.body}\n${r.log.join('\n')}`, e), also: 0 });
        }
      }
    }
    return out;
  }

  /** The owner approved (or skipped) the waiting scripts: run them, validate, file, finish. */
  async approveScripts(id: number, approve: string[]): Promise<RedTeamReport> {
    const p = this.#pending.get(id);
    const report = this.store.get(id);
    if (!p || !report || report.status !== 'awaiting') throw new Error('No probe scripts are waiting for your OK in this run.');
    this.#pending.delete(id);
    const rec = this.#recs.get(id) ?? RunRecorder.none();
    this.#recs.delete(id);
    const s = this.settings();
    const ok = p.scripts.filter((x) => approve.includes(x.id));
    for (const sc of report.scripts) if (sc.status === 'awaiting') sc.status = approve.includes(sc.id) ? 'approved' : 'skipped';
    report.status = 'running';
    report.stage = ok.length ? 'running the approved probe scripts' : '';
    this.store.save(report);
    const ctrl = new AbortController();
    const promise = (async () => {
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(s.minutes * 60_000)]);
      if (ok.length && p.start) {
        rec.startStep({ label: 'Approved attacker scripts' });
        const items = report.scripts.filter((x) => approve.includes(x.id));
        const secrets = projectSecrets(p.input.wsDir);
        const cands = await this.#runScripts(p.input, report, items, p.start, p.entries, secrets, rec, signal, () => report.candidates + 100);
        const final = await this.#validate(p.input, report, cands, p.start, secrets, rec, s, signal);
        this.#file(p.input, report, final, [], rec);
      }
      report.status = ctrl.signal.aborted ? 'stopped' : 'done';
      report.stage = '';
      report.endedAt = new Date().toISOString();
      report.budget.usedTokens = rec.on ? rec.totals().tokens : report.budget.usedTokens;
      this.store.save(report);
      rec.close('ok');
      return report;
    })().catch((err: Error) => {
      report.status = 'error';
      report.error = err.message.slice(0, 500);
      report.endedAt = new Date().toISOString();
      this.store.save(report);
      rec.close('error');
      return report;
    });
    this.running.set(id, { promise, ctrl });
    void promise.finally(() => {
      this.running.delete(id);
      this.#publish(id);
    });
    return report;
  }

  /**
   * Reproduction and review. Every candidate is re-run in a fresh copy (the app started afresh for
   * each); one that doesn't break the same way again is dropped. Then the Reviewing model must cite
   * the input, the observed output and a code line for each (all checked by code); a candidate it
   * calls not real, leaves out or cites wrongly is dropped. Without a reviewer model, the code-found
   * candidates keep their code-cited line and model-written ones are dropped (nobody checked them).
   */
  async #validate(input: StartInput, report: RedTeamReport, cands: Candidate[], start: StartPlan | null, secrets: string[], rec: RunRecorder, s: RedTeamSettings, signal: AbortSignal): Promise<Kept[]> {
    report.candidates += cands.length;
    if (!cands.length) return [];
    rec.startStep({ label: 'Reproduce' });
    report.stage = 'reproducing what broke';
    this.store.save(report);
    const reproduced: Candidate[] = [];
    // Probe candidates: one driver run, the app started afresh for every probe.
    const probeC = cands.filter((c) => c.by === 'probe' && c.probe);
    if (probeC.length && !signal.aborted) {
      const port = start?.portFrom === 'fixed' ? start.port! : await freePort(input.ports ?? portRange());
      const plan: DriverPlan & { cli: Record<string, string> } = { mode: 'repro', start, port, startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: true, probes: probeC.map((c) => (c.probe!.type === 'http' ? this.#patient(c.probe!, [c.kind]) : c.probe!)), scripts: [], scriptMs: 20_000, deadlineMs: Math.max(10_000, Math.min(120_000, s.minutes * 60_000)), cli: Object.fromEntries(probeC.filter((c) => c.entry?.kind === 'cli').map((c) => [c.entry!.id, c.entry!.file])) };
      const d = await this.#drive(input.wsDir, plan, {}, signal);
      for (const c of probeC) {
        const x = d.events.find((e) => e.t === 'x' && e.probe === c.probe!.id) as unknown as Exchange | undefined;
        const again = x ? breaksIn(x, secrets) : [];
        rec.tool({ id: `${c.cid}-repro`, name: 'redteam_reproduce', summary: c.input, args: { candidate: c.cid, kind: c.kind }, status: again.includes(c.kind) ? 'error' : 'ok', output: x ? clip(maskSecrets(observedText(x), secrets), 1500) : 'not run', ms: x?.ms ?? 0 });
        if (x && again.includes(c.kind)) reproduced.push(c);
        else report.dropped.push({ title: BREAK_RULES[c.kind].title, why: 'did not happen again in a fresh copy', input: c.input });
      }
    }
    // Script candidates: the script runs again in a fresh copy; the same request must break the same way.
    const scriptC = cands.filter((c) => c.by === 'script' && c.script);
    if (scriptC.length && start && !signal.aborted) {
      const byScript = new Map<string, Candidate[]>();
      for (const c of scriptC) byScript.set(c.script!.id, [...(byScript.get(c.script!.id) ?? []), c]);
      const port = start.portFrom === 'fixed' ? start.port! : await freePort(input.ports ?? portRange());
      const files: Record<string, string> = {};
      const scripts = [...byScript.values()].map((l) => {
        const x = l[0].script!;
        const file = `${DRIVER_DIR}/${x.id.toLowerCase()}.${x.lang === 'python' ? 'py' : 'mjs'}`;
        files[file] = x.code;
        return this.#patient({ id: x.id, lang: x.lang, file }, l.map((c) => c.kind));
      });
      const d = await this.#drive(input.wsDir, { mode: 'scripts', start, port, startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: true, probes: [], scripts, scriptMs: 20_000, deadlineMs: 90_000 }, files, signal);
      for (const c of scriptC) {
        const ev = d.events.find((e) => e.t === 'script' && e.id === c.script!.id);
        const recs = ((ev?.records ?? []) as (Exchange & { path: string })[]).filter((r) => r.path === c.script!.path);
        const ok = recs.some((r) => breaksIn({ ...r, probe: 'S' }, secrets).includes(c.kind));
        rec.tool({ id: `${c.cid}-repro`, name: 'redteam_reproduce', summary: c.input, args: { candidate: c.cid, kind: c.kind }, status: ok ? 'error' : 'ok', output: recs[0] ? clip(maskSecrets(observedText(recs[0]), secrets), 1500) : 'the request was not made again', ms: 0 });
        if (ok) reproduced.push(c);
        else report.dropped.push({ title: BREAK_RULES[c.kind].title, why: 'did not happen again in a fresh copy', input: c.input });
      }
    }
    // Test failures: the tests are run again in a fresh copy.
    const testC = cands.filter((c) => c.by === 'tests');
    if (testC.length && !signal.aborted) {
      const r = await this.#sandbox(input.wsDir, testC[0].input, Math.min(Math.max(10_000, s.minutes * 60_000 / 3), (this.#app.sandboxGate?.settings().timeLimitS ?? 120) * 1000), signal);
      for (const c of testC) {
        if (r.run && r.run.exitCode !== 0) reproduced.push(c);
        else report.dropped.push({ title: 'The tests fail', why: 'passed when run again', input: c.input });
      }
    }
    // The Reviewing model.
    rec.startStep({ label: 'Review' });
    report.stage = 'the Reviewing model checks each break';
    this.store.save(report);
    const verdicts = await this.#review(input, reproduced, rec, s, signal);
    report.reviewer = { ...report.reviewer, ...verdicts.info, kept: report.reviewer.kept, dropped: report.reviewer.dropped };
    const out: Kept[] = [];
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    for (const c of reproduced) {
      const v = verdicts.byId.get(c.cid);
      const codeQuote = c.cite && validateQuotes([{ source: 'redteam', severity: 'info', rule: 'x', title: 'x', advice: '', file: c.cite.file, line: c.cite.line, quote: c.cite.quote }], read).kept[0];
      const cq = codeQuote ? { file: codeQuote.file!, line: codeQuote.line!, quote: codeQuote.quote! } : null;
      const rule = BREAK_RULES[c.kind];
      if (verdicts.info.ran) {
        if (!v) {
          report.dropped.push({ title: rule.title, why: 'not confirmed by the Reviewing model', input: c.input });
          report.reviewer.dropped++;
          continue;
        }
        if (v.real === false) {
          report.dropped.push({ title: rule.title, why: 'the Reviewing model found it is not a real problem', input: c.input });
          report.reviewer.dropped++;
          continue;
        }
        const inputOk = norm(String(v.input ?? '')).length >= 3 && norm(c.input).includes(norm(String(v.input)));
        const obsOk = norm(String(v.observed ?? '')).length >= 3 && norm(c.observed).includes(norm(String(v.observed)));
        if (!inputOk || !obsOk) {
          report.dropped.push({ title: rule.title, why: !inputOk ? 'the review did not cite the reproducing input' : 'the review did not cite the observed output', input: c.input });
          report.reviewer.dropped++;
          continue;
        }
        const mq = v.file && v.quote ? validateQuotes([{ source: 'redteam', severity: 'info', rule: 'x', title: 'x', advice: '', file: String(v.file).replace(/^\.?\/*/, ''), line: Number(v.line) || 1, quote: String(v.quote) }], read).kept[0] : undefined;
        const quote = mq ? { file: mq.file!, line: mq.line!, quote: mq.quote! } : c.by === 'tests' ? null : cq;
        if (!quote && c.by !== 'tests') {
          report.dropped.push({ title: rule.title, why: 'no code line could be quoted', input: c.input });
          report.reviewer.dropped++;
          continue;
        }
        const sev = String(v.severity ?? '').toLowerCase();
        report.reviewer.kept++;
        out.push({ ...c, severity: sev === 'high' ? 'high' : sev === 'low' ? 'low' : sev === 'medium' ? 'medium' : rule.severity, title: norm(String(v.title ?? '')).slice(0, 200) || rule.title, quote, reviewed: true });
      } else {
        // No reviewer: model-written candidates are dropped; code-found ones keep the code-cited line.
        if (c.by === 'script') {
          report.dropped.push({ title: rule.title, why: 'no Reviewing model to check a model-written probe', input: c.input });
          continue;
        }
        if (!cq && c.by !== 'tests') {
          report.dropped.push({ title: rule.title, why: 'no code line could be quoted', input: c.input });
          continue;
        }
        out.push({ ...c, severity: c.by === 'tests' ? 'medium' : rule.severity, title: c.by === 'tests' ? 'The tests fail' : rule.title, quote: cq, reviewed: false });
      }
    }
    return out;
  }

  async #review(input: StartInput, list: Candidate[], rec: RunRecorder, s: RedTeamSettings, signal: AbortSignal): Promise<{ info: { ran: boolean; model?: string; note?: string }; byId: Map<string, Record<string, unknown>> }> {
    const byId = new Map<string, Record<string, unknown>>();
    if (!list.length) return { info: { ran: false, note: 'nothing to review' }, byId };
    if (signal.aborted) return { info: { ran: false, note: 'time limit' }, byId };
    const sec = (this.#app.settings.get() as { securityPass?: { reviewer?: boolean } }).securityPass;
    if (sec?.reviewer === false) return { info: { ran: false, note: 'off' }, byId };
    const chain = await this.#chain(input, 'review', rec);
    if (!chain.length) return { info: { ran: false, note: 'no model' }, byId };
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const shownFiles = new Map<string, Set<number>>();
    for (const c of list) {
      for (const at of [c.cite, c.entry ? { file: c.entry.file, line: c.entry.line } : undefined]) if (at) shownFiles.set(at.file, (shownFiles.get(at.file) ?? new Set()).add(at.line));
    }
    const code = [...shownFiles]
      .slice(0, 6)
      .map(([f, ls]) => {
        const lines = (read(f) ?? '').split(/\r?\n/);
        const from = Math.max(0, Math.min(...ls) - 15);
        const to = Math.min(lines.length, Math.max(...ls) + 25);
        return `File ${f} (lines ${from + 1}-${to}):\n${lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(4)}| ${l}`).join('\n')}`;
      })
      .join('\n\n');
    const cands = list
      .slice(0, 25)
      .map((c) => `${c.cid} (${c.kind}${c.by === 'script' ? ', from a model-written script' : c.by === 'tests' ? ', the project tests' : ''})${c.entry ? ` at ${c.entry.label} (${c.entry.file}:${c.entry.line})` : ''}\ninput: ${c.input}\nobserved:\n${clip(c.observed, 900)}${c.cite ? `\ncode found by the stack trace: ${c.cite.file}:${c.cite.line}: ${c.cite.quote}` : ''}`)
      .join('\n\n');
    const user = `Candidates:\n\n${cands}\n\nThe code (line numbers are not part of it):\n${code}`;
    const room = s.budgetTokens - (rec.on ? rec.totals().tokens : 0) - Math.ceil((REVIEW_SYSTEM.length + user.length) / 3.5);
    if (room < 400) return { info: { ran: false, note: 'budget' }, byId };
    let text = '';
    let model = '';
    try {
      ({ text, model } = await askModel(chain, [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: user }], Math.min(3000, room), signal));
    } catch (err) {
      return { info: { ran: false, note: `error: ${(err as Error).message.slice(0, 160)}` }, byId };
    }
    const j = jsonIn(text) as { breaks?: unknown[] } | unknown[] | undefined;
    const raw = Array.isArray(j) ? j : Array.isArray((j as { breaks?: unknown[] })?.breaks) ? (j as { breaks: unknown[] }).breaks : [];
    for (const x of raw.slice(0, 40)) if (x && typeof x === 'object' && typeof (x as Record<string, unknown>).id === 'string') byId.set(String((x as Record<string, unknown>).id).trim(), x as Record<string, unknown>);
    return { info: { ran: true, model }, byId };
  }

  /** The kept breaks and the insecure defaults into the findings table (quotes checked again). */
  #file(input: StartInput, report: RedTeamReport, final: Kept[], defaults: NewFinding[], rec: RunRecorder): void {
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const list: NewFinding[] = [];
    for (const c of final) {
      const rule = BREAK_RULES[c.kind];
      const steps = [c.entry ? { file: c.entry.file, line: c.entry.line, label: c.entry.label } : null, c.quote ? { file: c.quote.file, line: c.quote.line, label: c.probe ? `breaks on ${KIND_WORDS[c.probe.kind]}` : c.by === 'script' ? 'breaks on a script request' : 'breaks here' } : null].filter(Boolean);
      list.push({
        source: 'redteam',
        origin: c.reviewed || c.by === 'script' ? 'model' : 'code',
        severity: c.severity,
        rule: c.by === 'tests' ? 'redteam:tests' : `redteam:${c.kind}`,
        title: c.title,
        advice: rule.advice,
        file: c.quote?.file ?? null,
        line: c.quote?.line ?? null,
        quote: c.quote?.quote ?? (c.by === 'tests' ? clip(c.observed.split('\n')[0], 300) : null),
        meta: { probe: c.by, kind: c.kind, input: c.input, observed: clip(c.observed, 2000), reproduced: true, reviewed: c.reviewed, also: c.also, redteamId: report.id, ...(c.entry ? { entry: { id: c.entry.id, file: c.entry.file, line: c.entry.line, quote: c.entry.quote, label: c.entry.label, kind: c.entry.kind } } : {}), ...(steps.length ? { path: steps } : {}), ...(c.probe ? { repro: c.probe } : {}), ...(c.script ? { script: c.script } : {}) },
      });
    }
    for (const d of defaults) list.push({ ...d, meta: { ...(d.meta ?? {}), redteamId: report.id } });
    const { kept, dropped } = validateQuotes(list, read);
    for (const d of dropped) report.dropped.push({ title: d.finding.title, why: `quote ${d.why}` });
    const rows = kept.length ? this.findings.add(kept, { conversationId: report.conversationId, workspace: input.workspace, runId: report.runId }) : [];
    kept.forEach((f, i) => {
      const row = rows[i];
      if (!row) return;
      const m = f.meta ?? {};
      report.breaks.push({ findingId: row.id, kind: String(m.kind ?? m.rule ?? f.rule), severity: f.severity, title: f.title, entry: String((m.entry as { label?: string } | undefined)?.label ?? ''), input: String(m.input ?? ''), observed: String(m.observed ?? m.observed ?? f.quote ?? ''), file: f.file ?? null, line: f.line ?? null, quote: f.quote ?? null, by: (m.probe as BreakItem['by']) ?? 'default', reproduced: m.probe !== 'default', also: Number(m.also ?? 0) });
    });
    rec.tool({ id: `file-${report.breaks.length}`, name: 'redteam_findings', summary: `${kept.length} findings`, args: {}, status: 'ok', output: kept.map((f) => `${f.rule} ${f.file ?? ''}:${f.line ?? ''}`).join('\n') || 'none', ms: 0 });
  }

  // ---- the fix loop's re-check and lessons ----------------------------------------------------

  /**
   * The re-check for \"Fix what broke\" (FixBranches.startBatch): how many of this finding's problems
   * are still there in `dir` (0 = fixed). A break re-runs its reproducing probe (or the script's
   * request) in a sandbox copy of `dir`; an insecure default re-runs its own check.
   */
  async recheck(f: Pick<Finding, 'rule' | 'file' | 'quote' | 'meta'>, dir: string, signal: AbortSignal): Promise<number> {
    const m = f.meta as Record<string, unknown>;
    const read = (rel: string) => readWorkspaceText(dir, rel);
    if (m.probe === 'default') {
      const rule = String(m.rule ?? f.rule.replace(/^redteam:/, ''));
      if (rule === 'missing-headers' || (rule === 'cors-wildcard' && !f.file)) {
        const start = detectStart(dir, read);
        if ('none' in start) return 1;
        const probe: Probe = { type: 'http', id: 'h1', entry: 'E0', kind: 'baseline', method: 'GET', path: '/', label: 'an ordinary request' };
        const plan: DriverPlan = { mode: 'repro', start, port: start.portFrom === 'fixed' ? start.port! : await freePort(portRange()), startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: true, probes: [probe], scripts: [], scriptMs: 0, deadlineMs: 30_000 };
        const d = await this.#drive(dir, plan, {}, signal);
        const x = d.events.find((e) => e.t === 'x') as unknown as Exchange | undefined;
        // The app must start and answer: a fix that stops it from starting is not a fix.
        if (!x || !d.events.find((e) => e.t === 'start')?.ok || x.status === null) return 1;
        return headerFindings(x.headers, undefined, '').filter((h) => h.rule === f.rule).length;
      }
      const files = f.file ? [f.file] : projectFiles(dir);
      return insecureDefaults(files, read, { tracked: new Set(f.file ? [f.file] : []) }).filter((x) => x.rule === f.rule).length;
    }
    if (m.probe === 'tests') {
      const cmd = detectTestCommand(dir);
      if (!cmd) return 0;
      const r = await this.#sandbox(dir, cmd, 120_000, signal);
      return r.run && r.run.exitCode === 0 ? 0 : 1;
    }
    const kind = String(m.kind ?? '') as BreakKind;
    const start = detectStart(dir, read);
    const startPlan = 'none' in start ? null : start;
    const secrets = projectSecrets(dir);
    if (m.repro && typeof m.repro === 'object') {
      const probe = m.repro as Probe;
      const entry = m.entry as { id: string; file: string } | undefined;
      if (probe.type === 'http' && !startPlan) return 1;
      const plan: DriverPlan & { cli: Record<string, string> } = { mode: 'repro', start: startPlan, port: startPlan?.portFrom === 'fixed' ? startPlan.port! : await freePort(portRange()), startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: true, probes: [probe.type === 'http' ? this.#patient(probe, [kind]) : probe], scripts: [], scriptMs: 0, deadlineMs: 30_000, cli: entry ? { [entry.id]: entry.file } : {} };
      const d = await this.#drive(dir, plan, {}, signal);
      const st = d.events.find((e) => e.t === 'start');
      if (probe.type === 'http' && !st?.ok) return 1;
      const x = d.events.find((e) => e.t === 'x') as unknown as Exchange | undefined;
      if (!x) return 1;
      return breaksIn(x, secrets).includes(kind) ? 1 : 0;
    }
    if (m.script && typeof m.script === 'object' && startPlan) {
      const sc = m.script as { id: string; lang: ScriptLang; code: string; path: string };
      const file = `${DRIVER_DIR}/${sc.id.toLowerCase()}.${sc.lang === 'python' ? 'py' : 'mjs'}`;
      const d = await this.#drive(dir, { mode: 'scripts', start: startPlan, port: startPlan.portFrom === 'fixed' ? startPlan.port! : await freePort(portRange()), startMs: this.timing.startMs, reqMs: this.timing.reqMs, fresh: true, probes: [], scripts: [this.#patient({ id: sc.id, lang: sc.lang, file }, [kind])], scriptMs: 20_000, deadlineMs: 60_000 }, { [file]: sc.code }, signal);
      const ev = d.events.find((e) => e.t === 'script');
      const recs = ((ev?.records ?? []) as (Exchange & { path: string })[]).filter((r) => r.path === sc.path);
      return recs.some((r) => breaksIn({ ...r, probe: 'S' }, secrets).includes(kind)) ? 1 : 0;
    }
    // Nothing to re-run: the quoted line itself is the proof (gone = fixed).
    return f.file && f.quote && read(f.file)?.includes(f.quote) ? 1 : 0;
  }

  /** M6/M7 checks over a folder (the fix must not make them find more). */
  static checksCount(dir: string): number {
    const files = projectFiles(dir);
    let n = 0;
    for (const f of files) {
      const t = readWorkspaceText(dir, f);
      if (t !== undefined) n += checkFile(f, t).length;
    }
    try {
      n += analyze(files, (rel) => readWorkspaceText(dir, rel)).hits.length;
    } catch {
      /* best effort */
    }
    return n;
  }

  /**
   * M10: a break the fix loop fixed (and the owner applied) becomes a lesson note: the reproducing
   * input and the observed error, and the change, quoted from the fix's diff. Returns the note ids.
   */
  lesson(list: Finding[], diff: string): number[] {
    const mem = this.#app.memory;
    if (!mem) return [];
    const memCfg = (this.#app.settings.get() as { memory?: { enabled?: boolean } }).memory;
    if (memCfg?.enabled === false) return [];
    const minus = diff.split('\n').find((l) => l.startsWith('-') && !l.startsWith('---') && l.slice(1).trim());
    const plus = diff.split('\n').find((l) => l.startsWith('+') && !l.startsWith('+++') && l.slice(1).trim());
    const fixes = minus && plus ? [`${minus.slice(1).trim().slice(0, 140)} → ${plus.slice(1).trim().slice(0, 140)}`] : plus ? [plus.slice(1).trim().slice(0, 200)] : [];
    if (!fixes.length) return [];
    const ids: number[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const f of list) {
      if (f.source !== 'redteam' || f.meta?.probe === 'default') continue;
      const input = String(f.meta?.input ?? '');
      const observed = String(f.meta?.observed ?? '').split('\n').find((l) => l.trim()) ?? '';
      if (!input || !observed) continue;
      const note = mem.add({ kind: 'lesson', content: lessonText(`red-team probe: ${input}`, observed, fixes, f.workspace ?? ''), conversationId: f.conversationId ?? null, sourceMessageId: null, happenedOn: today, evidence: `red-team break #${f.id}: “${clip(observed, 300)}” · fix: ${fixes[0]}` });
      ids.push(note.id);
      try {
        this.#app.recall?.addLesson({ memoryId: note.id, workspace: f.workspace ?? '', sig: `redteam|${normalizeMessage(observed)}`, conversationId: f.conversationId ?? '', failRun: f.runId ?? null, failStep: null, fixRun: f.fix?.runId ?? null, fixStep: null, command: `red-team probe: ${clip(input, 280)}`, errorQuote: clip(observed, 300), fixQuote: fixes[0], packages: [], files: f.file ? [f.file] : [], createdAt: new Date().toISOString() });
      } catch (err) {
        console.warn(`red-team lesson: ${(err as Error).message}`);
      }
    }
    return ids;
  }

  // ---- before shipping -------------------------------------------------------------------------

  /**
   * The ship gate (a TurnHooks participant in coding conversations): before a push / PR / release
   * she was asked to do. Ask me: the approval card offers \"Red-team first\". Always: the run goes
   * first (bounded by its time limit) and its result is on the card; breaks make the card appear
   * even for a tool that runs without asking.
   */
  shipHooks(conv: Conversation, wsDir: string): TurnHooks | undefined {
    const mode = this.settings().ship;
    if (mode === 'off' || conv.mode !== 'coding') return undefined;
    return {
      beforeTool: async (c: BeforeTool) => {
        if (!isShipAction(c.call.name, c.call.arguments)) return undefined;
        if (mode === 'ask') return { redteam: { mode: 'ask', ask: true, workspace: conv.workspace } satisfies RedTeamGateCard };
        let r: RedTeamReport | undefined;
        try {
          const started = this.start({ workspace: conv.workspace, wsDir, conversationId: conv.id, reason: 'ship', private: Boolean(conv.private) });
          r = await this.running.get(started.id)?.promise;
          r ??= this.store.get(started.id);
        } catch (err) {
          return { redteam: { mode: 'always', ask: true, workspace: conv.workspace, error: (err as Error).message.slice(0, 300) } satisfies RedTeamGateCard };
        }
        const serious = r ? r.breaks.filter((b) => b.severity === 'high' || b.severity === 'block').length : 0;
        const card: RedTeamGateCard = { mode: 'always', ask: Boolean(r && (r.breaks.length || r.status === 'awaiting')), workspace: conv.workspace, breaks: r?.breaks.length ?? 0, serious, ...(r ? { id: r.id, status: r.status } : {}) };
        return { redteam: card };
      },
    };
  }
}

export interface RedTeamGateCard {
  mode: 'ask' | 'always';
  /** Show the approval card (Ask me always; Always only when something broke). */
  ask: boolean;
  workspace: string;
  id?: number;
  breaks?: number;
  serious?: number;
  status?: string;
  error?: string;
}

/** Where a finding's workspace folder is (for routes). */
export function wsDirOf(app: AppContext, workspace: string): string {
  return workspaceDir(app.rootDir ?? app.dataDir, workspace);
}

