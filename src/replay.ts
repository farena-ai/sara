// Phase 83 (harness track M8, docs/design/HARNESS_TRACK.md §3 M8): time-travel. The replay runner
// rebuilds the exact inputs of step N of a recorded turn and carries the turn on LIVE from there,
// with one or more inputs changed: the owner's message, a tool result she saw, the memory notes in
// or out, the model. M9's eval loop runs the same runner N times (`replayRun`, headless).
//
// What step N is rebuilt from (src/runs.ts, M3):
// - the system prompt: its stored blob (byte for byte; the memory notes block edited when asked);
// - the history: the stored messages up to the step's id range, through the same `buildHistory`
//   the turn used, plus the app's notes recorded after it; checked against the step's inputs hash;
// - the memory picks: the step's recorded picks (M1 `selectMemories` with `override` for a note
//   put in; a note taken out is removed from the block);
// - the tool results of steps before N: served from the record (they are the stored tool
//   messages in that range; nothing is run again);
// - the model: the step's own (or the one picked), pinned on the branch.
//
// Where the branch lives (decided, see HARNESS_TRACK M8 "as built"): NOT in the conversation. The
// turn runs against a scratch in-memory copy of the conversation up to step N (`new Store(':memory:')`
// with the same message ids), so nothing reaches the conversation list, search, memory, recall or
// the other conversations; when it ends its messages are kept with its run (`run_messages`). The
// branch is a new run with `parent_run_id` + `branched_from_step` (retention keeps the parent).
// "Use this answer" appends the branch's final answer to the real conversation, marked as a re-run.
//
// Side effects after the fork: approvals, the plan check (M2), the sandbox gate (M5), the budget
// (M4) and the safety layer run as in any turn. Files: coding branches work in a copy of the
// workspace restored to the step's manifest (a `git clone --shared` checkout at the recorded HEAD,
// remotes removed, plus the dirty files whose hashes still match); everyday conversations get a
// copy of the workspace as it is now. The real workspace is touched only by an explicit Apply.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildHistory, HISTORY_BUDGET_CHARS, runTurn, type AppContext, type ChatEvent, type ReplayInputs, type TurnHooks } from './chat.ts';
import type { Budget } from './budget.ts';
import { decayPolicy, type PickNote } from './memory-rank.ts';
import { localDate, memorySettings } from './memory-worker.ts';
import { selectMemories, type Injection } from './memory.ts';
import { isCloudModelName } from './model-names.ts';
import type { ChatMessage } from './providers/types.ts';
import { diffRuns, refBefore, summaryLine, unifiedDiff, type RunDiff } from './run-diff.ts';
import { inputsHash, RunRecorder, type RunStatus, type RunView, type StepView, type WorkspaceRef } from './runs.ts';
import { makeCopy, SANDBOX_HEAVY, sandboxGateSettings } from './sandbox-run.ts';
import { en, fill } from './i18n.ts';
import { Store, type Conversation, type StoredMessage } from './store.ts';
import { workspaceDir } from './tools/workspace.ts';

/** An error with the HTTP status the route answers with. */
export class ReplayError extends Error {
  readonly status: number;
  /** The English template (the app translates it) and its values. */
  readonly key: string;
  readonly params?: Record<string, string | number>;
  constructor(status: number, key: string, params?: Record<string, string | number>) {
    super(params ? fill(key, params) : key);
    this.status = status;
    this.key = key;
    if (params) this.params = params;
  }
}

/** A line the page shows in the app's language: an English template and its values. */
export interface Said {
  key: string;
  params?: Record<string, string | number>;
}
const said = (key: string, params?: Record<string, string | number>): Said => (params ? { key, params } : { key });

export interface BranchEdits {
  /** The owner's message of the turn, rewritten. */
  message?: string;
  /** Results she saw from tools of steps before the branch point, replaced (by tool call id). */
  toolResults?: { callId: string; output: string }[];
  /** Memory notes put in or taken out (ids). */
  memory?: { include?: number[]; exclude?: number[] };
  /** Another model for the branch. */
  model?: { providerId: string; model: string };
}

/** A prior tool result the step saw (served from the record, editable on the branch). */
export interface PriorTool {
  step: number;
  callId: string;
  name: string;
  summary: string;
  output: string;
  messageId: number;
}

export interface RebuiltStep {
  run: RunView;
  step: StepView;
  conversation: Conversation;
  /** The system prompt as stored. */
  system: string;
  /** The stored messages up to the step (what the branch copies). */
  stored: StoredMessage[];
  /** What the model was sent after the system prompt, rebuilt (history + the app's notes). */
  messages: ChatMessage[];
  extra: string[];
  picks: PickNote[];
  userMessage?: StoredMessage;
  priorTools: PriorTool[];
  model: { providerId: string | null; model: string | null };
  /** The inputs hash matched the recorded one (null: recorded before 2.16, no hash to compare). */
  exact: boolean | null;
  /** Why it may not be exact (messages forgotten or regenerated since…). */
  problems: Said[];
  ms: number;
}

const NOTES_HEAD = '\n### Your notes\n';
const WHY = " Each note ends with why it came to mind and how sure that is. Lean on 'high', treat 'low' as background.";
const LONG_NOTE = '[Note from the app: this conversation is long';
/** A branch's own message ids start well above the conversation's (they live only in its run record). */
const BRANCH_ID_GAP = 1_000_000_000;
const MAX_RUNNING = 2;
const KEEP_COPIES_DAYS = 14;

/** Which role a recorded note had (the record keeps the text; the app's notes to her are user lines). */
const noteMessage = (x: string): ChatMessage => (x.startsWith('[Note from the app') ? { role: 'user', content: x } : { role: 'system', content: x });

/** The step's main model call (not the safety check or a judge). */
function mainCall(step: StepView) {
  return step.calls.find((c) => !c.purpose) ?? step.calls[0];
}

/**
 * Rebuilds the inputs of one step of a recorded turn: system prompt from its blob, history from the
 * stored messages in its range (the same `buildHistory` the turn used), the app's notes, the memory
 * picks, the prior tool results, the model. Throws a ReplayError when it can't.
 */
export function rebuildStep(app: AppContext, runId: number, idx: number): RebuiltStep {
  const t0 = performance.now();
  const runs = app.runs;
  if (!runs) throw new ReplayError(404, en('Run history is not available here.'));
  const run = runs.get(runId);
  if (!run) throw new ReplayError(404, en('No such run.'));
  if (run.kind !== 'turn') throw new ReplayError(400, en('Only her replies can be branched (not background jobs, team tasks or checks).'));
  if (run.status === 'running') throw new ReplayError(409, en('This run is still going. Branch from it when it has finished.'));
  const conversation = run.conversationId ? app.store.getConversation(run.conversationId) : undefined;
  if (!conversation) throw new ReplayError(404, en('The conversation of this run is gone.'));
  const step = Number.isInteger(idx) && idx >= 0 ? runs.step(runId, idx) : undefined;
  if (!step) throw new ReplayError(404, en('No such step.'));
  if (step.label) throw new ReplayError(400, en('This step was not one of her model steps.'));
  const system = step.systemSha ? runs.blob(step.systemSha) : undefined;
  if (system === undefined) throw new ReplayError(409, en("This step's instructions weren't kept, so it can't be rebuilt."));
  const problems: Said[] = [];
  // A branch of a branch: its messages are in its run record.
  const source: StoredMessage[] = run.parentRunId ? runs.runMessages(run.id).map((m) => ({ ...m, conversationId: conversation.id, role: m.role as StoredMessage['role'] })) : app.store.messages(conversation.id);
  const toId = step.historyToId ?? 0;
  const stored = source.filter((m) => m.id <= toId);
  const s = app.settings.get();
  const hist = buildHistory(stored, s.historyBudgetChars ?? HISTORY_BUDGET_CHARS, app.uploads ? (id) => app.uploads!.load(id) : undefined);
  if ((step.historyFromId ?? 0) !== hist.firstKeptId) problems.push(said(en('The history it saw started at another message (older messages were forgotten or the history size changed).')));
  const extra = step.extra;
  const messages: ChatMessage[] = [];
  let rest = extra;
  if (hist.dropped && extra[0]?.startsWith(LONG_NOTE)) {
    messages.push({ role: 'user', content: extra[0] });
    rest = extra.slice(1);
  }
  messages.push(...hist.messages, ...rest.map(noteMessage));
  const userMessage = run.userMessageId ? stored.find((m) => m.id === run.userMessageId && m.role === 'user') : undefined;
  if (!userMessage) problems.push(said(en('The message this reply answered is gone (regenerated, edited or forgotten).')));
  // The results of the turn's earlier steps: served from the record (their stored tool messages).
  const priorTools: PriorTool[] = [];
  for (const st of runs.steps(runId).filter((x) => x.idx < idx)) {
    for (const t of st.tools) {
      const msg = t.messageId ? stored.find((m) => m.id === t.messageId) : undefined;
      if (!msg) {
        problems.push(said(en('The result of {tool} in step {n} is gone.'), { tool: t.name, n: st.idx + 1 }));
        continue;
      }
      priorTools.push({ step: st.idx, callId: t.id, name: t.name, summary: t.summary, output: msg.content, messageId: msg.id });
    }
  }
  // A branch of a branch: the parent's earlier steps are part of its history too.
  if (run.parentRunId && run.branchedFromStep !== null) {
    for (const m of stored) if (m.role === 'tool' && !priorTools.some((p) => p.messageId === m.id) && m.id > (run.userMessageId ?? 0)) priorTools.push({ step: -1, callId: String(m.meta?.toolCallId ?? ''), name: String(m.meta?.name ?? ''), summary: String(m.meta?.summary ?? ''), output: m.content, messageId: m.id });
  }
  const exact = step.inputsSha ? inputsHash(messages) === step.inputsSha : null;
  if (exact === false && !problems.length) problems.push(said(en('Something it saw has changed since (a message or note was edited).')));
  const call = mainCall(step);
  const [polProvider, ...polModel] = String(run.policy?.model ?? '').split('/');
  return {
    run,
    step,
    conversation,
    system,
    stored,
    messages,
    extra,
    picks: step.memoryPicks as PickNote[],
    ...(userMessage ? { userMessage } : {}),
    priorTools,
    model: { providerId: call?.providerId ?? (polProvider || null), model: call?.model ?? step.model ?? (polModel.join('/') || null) },
    exact,
    problems,
    ms: performance.now() - t0,
  };
}

// ------------------------------------------------------------------------------------------------
// Memory notes in or out: the recorded block, edited
// ------------------------------------------------------------------------------------------------

/**
 * The system prompt with the memory notes changed: notes taken out lose their line; notes put in
 * get the line `selectMemories` writes for them (`override.include`), after the kept ones.
 */
export function editNotes(app: AppContext, r: RebuiltStep, edit: { include?: number[]; exclude?: number[] }): { system: string; injection: Injection } {
  const exclude = new Set((edit.exclude ?? []).map(Number));
  const include = [...new Set((edit.include ?? []).map(Number))].filter((id) => !r.picks.some((p) => p.id === id) && !exclude.has(id));
  const system = r.system;
  const at = system.indexOf(NOTES_HEAD);
  let headLine = '';
  let lines: string[] = [];
  let bodyStart = -1;
  let bodyEnd = -1;
  if (at >= 0) {
    const headEnd = system.indexOf('\n', at + NOTES_HEAD.length);
    headLine = system.slice(at + NOTES_HEAD.length, headEnd);
    bodyStart = headEnd + 1;
    bodyEnd = system.indexOf('\n\n', bodyStart);
    if (bodyEnd < 0) bodyEnd = system.length;
    lines = system.slice(bodyStart, bodyEnd).split('\n');
  }
  const pickLines = lines.slice(0, r.picks.length);
  const otherLines = lines.slice(r.picks.length);
  const keptPicks: PickNote[] = [];
  const kept: string[] = [];
  r.picks.forEach((p, i) => {
    if (exclude.has(p.id)) return;
    keptPicks.push(p);
    if (pickLines[i] !== undefined) kept.push(pickLines[i]);
  });
  const added: string[] = [];
  const addedPicks: PickNote[] = [];
  if (include.length) {
    if (!app.memory) throw new ReplayError(400, en('Her memory is not available here.'));
    if (at < 0 && !system.includes('## What you remember from before')) throw new ReplayError(400, en('Her memory was off for this reply, so no note can be put in.'));
    const s = app.settings.get();
    const memCfg = memorySettings(app);
    for (const id of include) {
      const m = app.memory.get(id);
      if (!m) throw new ReplayError(404, en('There is no note #{id}.'), { id });
      // A household member's notes are in their own space (app.memory is theirs); private-chat
      // notes stay private: a note from a private conversation only goes into a private branch.
      if (m.conversationId && m.conversationId !== r.conversation.id && app.store.getConversation(m.conversationId)?.private && !r.conversation.private) throw new ReplayError(400, en('Note #{id} is from a private conversation.'), { id });
      const inj = selectMemories(app.memory, {
        userText: r.userMessage?.content ?? '',
        conversationId: r.conversation.id,
        oldestHistoryId: 0,
        budgetChars: 1_000_000,
        policy: decayPolicy(memCfg),
        today: localDate(app.now().toISOString(), s.timeZone),
        override: { include: [id] },
      });
      const i = inj.ids.indexOf(id);
      if (i < 0) throw new ReplayError(400, en("Note #{id} can't be used (it may be no longer true)."), { id });
      added.push(inj.text.split('\n')[i]);
      addedPicks.push(inj.picks[i]);
    }
  }
  const all = [...kept, ...added, ...otherLines];
  const why = all.some((l) => /\[why: [^\]]*; sure: (high|medium|low)/.test(l));
  let out: string;
  if (at >= 0) {
    if (!all.length) out = system.slice(0, at) + system.slice(bodyEnd);
    else out = `${system.slice(0, at)}${NOTES_HEAD}${headLine.replace(WHY, '')}${why ? WHY : ''}\n${all.join('\n')}${system.slice(bodyEnd)}`;
  } else if (all.length) {
    const sec = system.indexOf('## What you remember from before');
    let end = system.indexOf('\n\n', sec);
    if (end < 0) end = system.length;
    const owner = app.settings.get().ownerName?.trim() || 'the owner';
    out = `${system.slice(0, end)}${NOTES_HEAD}Your own notes from earlier conversations with ${owner} (dated). They can be out of date.${why ? WHY : ''}\n${all.join('\n')}${system.slice(end)}`;
  } else out = system;
  const picks = [...keptPicks, ...addedPicks];
  return { system: out, injection: { text: all.join('\n'), ids: picks.map((p) => p.id), chars: all.join('\n').length, picks, policyId: r.step.policyId ?? picks[0]?.policy ?? '' } };
}

// ------------------------------------------------------------------------------------------------
// The workspace at the step
// ------------------------------------------------------------------------------------------------

export interface RestoreInfo {
  dir: string;
  /** clone: a checkout at the recorded commit; copy: the workspace as it is now; empty: a new empty folder. */
  strategy: 'clone' | 'copy' | 'empty';
  head?: string;
  restored: number;
  notRestored: { path: string; why: string }[];
  notes: Said[];
  ms: number;
}

const GIT_RUN = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'advice.detachedHead=false'];
function git(cwd: string, args: string[], timeout = 120_000): { status: number | null; out: string; err: string } {
  const r = spawnSync('git', [...GIT_RUN, ...args], { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.error ? null : r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '').trim().split('\n')[0]?.slice(0, 200) ?? '' };
}

export const sha16 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Every file of a folder (no .git, no dependency folders, no links): relative path → sha (16 hex). */
export function fileHashes(dir: string, maxFiles = 50_000): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if ((e.name === '.git' && !rel) || SANDBOX_HEAVY.has(e.name)) continue;
        walk(join(d, e.name), r);
      } else if (e.isFile()) {
        if (out.size >= maxFiles) return;
        const abs = join(d, e.name);
        const size = statSync(abs).size;
        out.set(r, size > 8 * 1024 * 1024 ? `size:${size}` : sha16(readFileSync(abs)));
      }
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

/**
 * Restores the workspace as it was at a step into `dest`: a checkout of the recorded commit (a
 * `git clone --shared`, which writes nothing into the real repository; its remotes are removed so
 * nothing can be pushed from the branch) plus the uncommitted files whose recorded hashes still
 * match the real files. What can't be restored is listed, never guessed. `touched` = files the
 * step itself changed before its manifest was taken (branching from the first step).
 */
export function restoreWorkspace(real: string, ref: WorkspaceRef | null, dest: string, opts: { maxBytes: number; touched?: string[]; shellChanged?: boolean }): RestoreInfo {
  const t0 = Date.now();
  const notRestored: RestoreInfo['notRestored'] = [];
  const notes: Said[] = [];
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(real)) {
    mkdirSync(dest, { recursive: true });
    return { dir: dest, strategy: 'empty', restored: 0, notRestored, notes: [said(en('The workspace folder is gone: the branch starts in an empty folder.'))], ms: Date.now() - t0 };
  }
  const heavy = readdirSync(real, { withFileTypes: true }).filter((e) => e.isDirectory() && SANDBOX_HEAVY.has(e.name)).map((e) => e.name);
  if (heavy.length) notes.push(said(en('Dependency folders ({folders}) are not in the copy: install them in the branch if a command needs them.'), { folders: heavy.join(', ') }));
  const isRepo = (() => {
    try {
      return lstatSync(join(real, '.git')).isDirectory();
    } catch {
      return false;
    }
  })();
  if (isRepo && ref?.head && /^[0-9a-f]{40,64}$/.test(ref.head)) {
    const c = git(dirname(dest), ['clone', '--shared', '--no-checkout', '-q', '--', real, dest]);
    // The commit's own bytes first (no line-ending conversion); see below for the workspace's.
    const co = c.status === 0 ? git(dest, ['-c', 'core.autocrlf=false', 'checkout', '-q', '--detach', ref.head]) : c;
    if (c.status === 0 && co.status === 0) {
      git(dest, ['remote', 'remove', 'origin']);
      // The copy should have the bytes the real workspace had, whatever its line-ending settings:
      // tracked files that are clean in the real workspace and unchanged since that commit are
      // copied over byte for byte (read-only git in the real repo). If those show the workspace
      // checks files out with CRLF, the other tracked files are checked out the same way.
      const lines = (r: { status: number | null; out: string }) => (r.status === 0 ? r.out.split('\0').filter(Boolean) : null);
      const changed = lines(git(real, ['diff', '--name-only', '-z', ref.head, 'HEAD']));
      const statusNow = git(real, ['status', '--porcelain', '-z', '--untracked-files=no']);
      const tracked = lines(git(dest, ['ls-files', '-z']));
      if (changed && tracked && statusNow.status === 0) {
        const dirtyNow = new Set<string>();
        const parts = statusNow.out.split('\0');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].length < 4) continue;
          dirtyNow.add(parts[i].slice(3));
          if (parts[i][0] === 'R' || parts[i][0] === 'C') i++;
        }
        const moved = new Set(changed);
        let crlf = 0;
        let lf = 0;
        const rest: string[] = [];
        for (const rel of tracked) {
          if (rel.split('/').some((x) => SANDBOX_HEAVY.has(x))) continue;
          if (moved.has(rel) || dirtyNow.has(rel)) {
            rest.push(rel);
            continue;
          }
          const from = join(real, ...rel.split('/'));
          const to = join(dest, ...rel.split('/'));
          try {
            if (!lstatSync(from).isFile()) continue;
            const a = readFileSync(from);
            const b = readFileSync(to);
            if (!a.equals(b) && a.includes(13) && a.toString('latin1').replace(/\r\n/g, '\n') === b.toString('latin1')) crlf++;
            else if (b.includes(10)) lf++;
            copyFileSync(from, to);
          } catch {
            /* as checked out */
          }
        }
        if (crlf > lf && rest.length) {
          for (const rel of rest) rmSync(join(dest, ...rel.split('/')), { force: true });
          for (let i = 0; i < rest.length; i += 200) git(dest, ['-c', 'core.autocrlf=true', 'checkout', '-q', '--', ...rest.slice(i, i + 200)]);
        }
        git(dest, ['update-index', '-q', '--refresh']);
      }
      const touched = new Set(opts.touched ?? []);
      let restored = 0;
      for (const d of ref.dirty ?? []) {
        const rel = d.path;
        if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel.split(/[\\/]/)[0] === '.git') continue;
        const to = join(dest, ...rel.split('/'));
        if (touched.has(rel)) {
          notRestored.push({ path: rel, why: en('changed by that step before the workspace was recorded') });
          continue;
        }
        if (d.gone) {
          try {
            unlinkSync(to);
          } catch {
            /* not there */
          }
          restored++;
          continue;
        }
        const from = join(real, ...rel.split('/'));
        let st;
        try {
          st = lstatSync(from);
        } catch {
          notRestored.push({ path: rel, why: en('removed since') });
          continue;
        }
        if (!st.isFile()) {
          notRestored.push({ path: rel, why: en('not a plain file now') });
          continue;
        }
        if (d.sha ? sha16(readFileSync(from)) !== d.sha : d.size !== st.size) {
          notRestored.push({ path: rel, why: en('changed since') });
          continue;
        }
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        restored++;
      }
      if (ref.more) notes.push(said(en("{n} more uncommitted files weren't recorded, so they are as in the commit."), { n: ref.more }));
      if (opts.shellChanged) notes.push(said(en('That step ran commands that may have changed files before the workspace was recorded.')));
      notes.push(said(en('Files git ignores (like .env or build output) are not in the copy.')));
      const now = readHeadSafe(real);
      if (now && now !== ref.head) notes.push(said(en('Your project has moved on since (now at {head}): the branch works on the commit of that time.'), { head: now.slice(0, 10) }));
      return { dir: dest, strategy: 'clone', head: ref.head, restored, notRestored, notes, ms: Date.now() - t0 };
    }
    notes.push(said(en("Commit {head} couldn't be checked out ({error}): the copy is the workspace as it is now."), { head: ref.head.slice(0, 10), error: co.err || 'git failed' }));
    rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } else if (isRepo) notes.push(said(en('No commit was recorded for that step: the copy is the workspace as it is now.')));
  else notes.push(said(en("This workspace isn't a git repository, so only its present state can be copied (not the state at that step).")));
  makeCopy(real, dest, { maxBytes: opts.maxBytes, preferWorktree: false });
  return { dir: dest, strategy: 'copy', restored: 0, notRestored, notes, ms: Date.now() - t0 };
}

function readHeadSafe(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '-q', '--verify', 'HEAD'], 10_000);
  return r.status === 0 ? r.out.trim() : undefined;
}

/** A path inside `root` with no link on the way (for Apply). */
function safeTarget(root: string, rel: string): string | undefined {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((p) => p === '..' || p === '.git' || SANDBOX_HEAVY.has(p))) return undefined;
  const target = resolve(root, ...rel.split('/'));
  if (!target.startsWith(resolve(root) + sep)) return undefined;
  let cur = resolve(root);
  for (const part of relative(root, target).split(sep).slice(0, -1)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return undefined;
    } catch {
      break;
    }
  }
  try {
    if (lstatSync(target).isSymbolicLink()) return undefined;
  } catch {
    /* new file */
  }
  return target;
}

// ------------------------------------------------------------------------------------------------
// The branch run
// ------------------------------------------------------------------------------------------------

export interface BranchFile {
  path: string;
  change: 'added' | 'changed' | 'removed';
  /** At the end of the branch. */
  sha?: string;
  /** At the start of the branch (absent: the file didn't exist). */
  startSha?: string;
  diff?: string;
  binary?: true;
}

export interface ReplayOptions {
  fromStep: number;
  edits?: BranchEdits;
  /** Shorthand for edits.model (M9's variants). */
  model?: { providerId: string; model: string };
  /** The branch's budget (M4); undefined = the owner's default for the kind of conversation; null = none. */
  budget?: Budget | null;
  /** The workspace copy: keep it after the run (default, so its files can be compared and applied) or delete it. */
  sandbox?: { keep?: boolean };
  signal?: AbortSignal;
  /** Extra TurnHooks (tests, M9). */
  hooks?: TurnHooks;
  /** Phase 85 (M10): recall on her own forced on/off (M9's triggers variant); unset = the settings. */
  recall?: boolean;
  /** Phase 97 (ST2): notes added after the recorded ones (the skill check's "with skill X loaded"). */
  notes?: string[];
}

export interface ReplayOutcome {
  runId: number;
  status: RunStatus;
  answer: string;
  steps: number;
  tokens: number;
  usd: number;
  files: BranchFile[];
  /** Did step N's rebuilt inputs match the record (null: no hash recorded). */
  exact: boolean | null;
  summary?: string;
}

export type BranchEvent =
  | ChatEvent
  | { type: 'branch'; runId: number; fromRun: number; fromStep: number; exact: boolean | null; problems: Said[]; workspace: Omit<RestoreInfo, 'dir'> | null; edits: string[]; model: string }
  | { type: 'branch_done'; runId: number; outcome: ReplayOutcome };

const running = new WeakMap<object, Map<number, AbortController>>();
/** Branches running now for one run store (their stop buttons). */
export function runningBranches(app: AppContext): Map<number, AbortController> {
  const key = app.runs as object;
  let m = running.get(key);
  if (!m) running.set(key, (m = new Map()));
  return m;
}

export const branchesDir = (app: AppContext): string => join(app.dataDir, 'cache', 'branch-runs');

/** Copies of branches whose runs are gone, or older than two weeks, are removed. */
export function sweepBranchCopies(app: AppContext): number {
  const dir = branchesDir(app);
  if (!existsSync(dir) || !app.runs) return 0;
  let n = 0;
  const live = runningBranches(app);
  for (const name of readdirSync(dir)) {
    const id = Number(name);
    if (live.has(id)) continue;
    const p = join(dir, name);
    const old = Date.now() - statSync(p).mtimeMs > KEEP_COPIES_DAYS * 86_400_000;
    if (!Number.isInteger(id) || !app.runs.get(id) || old) {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (old && app.runs.get(id)) app.runs.setBranch(id, { copy: 'removed' });
      n++;
    }
  }
  return n;
}

/** What changed in words (for the run record and the branch line). */
function editWords(e: BranchEdits, recordedModel: string): string[] {
  const out: string[] = [];
  if (e.message !== undefined) out.push('message');
  for (const t of e.toolResults ?? []) out.push(`tool:${t.callId}`);
  for (const id of e.memory?.exclude ?? []) out.push(`note-out:${id}`);
  for (const id of e.memory?.include ?? []) out.push(`note-in:${id}`);
  if (e.model && `${e.model.providerId}/${e.model.model}` !== recordedModel) out.push(`model:${e.model.providerId}/${e.model.model}`);
  return out;
}

/** The scratch copy of the conversation the branch runs against (same ids; nothing in sara.db). */
function scratchConversation(app: AppContext, conv: Conversation, msgs: StoredMessage[], pin: { providerId: string; model: string }): Store {
  const st = new Store(':memory:', app.now);
  st.db.prepare('INSERT INTO conversations (id, title, provider_id, model, workspace, mode, private, channel, channel_key, partner, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(conv.id, conv.title, pin.providerId, pin.model, conv.workspace, conv.mode, conv.private ? 1 : 0, conv.channel, conv.channelKey, conv.partner, null, conv.createdAt, conv.updatedAt);
  const ins = st.db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)');
  st.db.exec('BEGIN');
  for (const m of msgs) ins.run(m.id, conv.id, m.role, m.content, m.createdAt, m.meta ? JSON.stringify(m.meta) : null);
  st.db.exec('COMMIT');
  const top = Math.max(Number((app.store.db.prepare('SELECT MAX(id) AS n FROM messages').get() as { n: number | null }).n ?? 0), msgs.at(-1)?.id ?? 0);
  st.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'messages'").run(top + BRANCH_ID_GAP);
  return st;
}

/** The models a branch may pick (the owner's set-up ones; private conversations: local only). */
export function branchModels(app: AppContext, conv: Conversation, recorded: { providerId: string | null; model: string | null }): { providerId: string; model: string; label: string }[] {
  const s = app.settings.get();
  const out: { providerId: string; model: string; label: string }[] = [];
  const add = (providerId?: string | null, model?: string | null) => {
    if (!providerId || !model) return;
    const p = s.providers.find((x) => x.id === providerId);
    if (!p) return;
    if (conv.private && (!p.local || isCloudModelName(model))) return;
    if (out.some((x) => x.providerId === providerId && x.model === model)) return;
    out.push({ providerId, model, label: `${model} · ${p.label}` });
  };
  add(recorded.providerId, recorded.model);
  add(conv.providerId, conv.model);
  add(s.defaultProviderId, s.defaultModel);
  add(s.companionModel?.providerId, s.companionModel?.model);
  for (const r of Object.values(s.routes ?? {})) if (r && typeof r === 'object' && 'providerId' in r) add((r as { providerId: string }).providerId, (r as { model: string }).model);
  for (const p of s.providers) {
    add(p.id, p.defaultModel);
    for (const m of app.modelCatalog?.view(p.id).models.slice(0, 200) ?? []) add(p.id, m);
  }
  // The step's own model first, then models on this computer, then the provider's cloud ones.
  const [first, ...rest] = out;
  const cloud = (m: { model: string }) => (isCloudModelName(m.model) ? 1 : 0);
  return (first ? [first, ...rest.sort((x, y) => cloud(x) - cloud(y))] : []).slice(0, 120);
}

/**
 * Branches a recorded turn from step `fromStep` with the edits, live. Yields the turn's events
 * (the same as a chat turn, so the page reuses its step line) between a `branch` event (the new
 * run id, whether the inputs were rebuilt exactly, the workspace copy) and `branch_done`.
 */
export async function* branchRun(app: AppContext, runId: number, opts: ReplayOptions): AsyncGenerator<BranchEvent> {
  const r = rebuildStep(app, runId, opts.fromStep);
  const runs = app.runs!;
  const edits: BranchEdits = { ...(opts.edits ?? {}), ...(opts.model ? { model: opts.model } : {}) };
  if (!r.userMessage) throw new ReplayError(409, en('The message this reply answered is gone (regenerated, edited or forgotten).'));
  if (edits.message !== undefined && !String(edits.message).trim()) throw new ReplayError(400, en('The message is empty.'));
  const live = runningBranches(app);
  if (live.size >= MAX_RUNNING) throw new ReplayError(409, en('Two branches are running already. Wait for one to finish.'));
  const recordedModel = `${r.model.providerId ?? ''}/${r.model.model ?? ''}`;
  const pin = edits.model ?? (r.model.providerId && r.model.model ? { providerId: r.model.providerId, model: r.model.model } : undefined);
  if (!pin) throw new ReplayError(409, en("The model of this step wasn't recorded: pick one."));
  const s = app.settings.get();
  if (!s.providers.some((p) => p.id === pin.providerId)) throw new ReplayError(400, en("That model's provider isn't set up any more: pick another model."));
  if (r.conversation.private) {
    const p = s.providers.find((x) => x.id === pin.providerId)!;
    if (!p.local || isCloudModelName(pin.model)) throw new ReplayError(400, en('This conversation is private: its branches only use models on your own hardware.'));
  }
  // The edits, on the scratch copy of the conversation.
  const msgs = r.stored.map((m) => ({ ...m, ...(m.meta ? { meta: { ...m.meta } } : {}) }));
  if (edits.message !== undefined) {
    const u = msgs.find((m) => m.id === r.userMessage!.id)!;
    u.content = String(edits.message).slice(0, 100_000);
  }
  for (const t of edits.toolResults ?? []) {
    const prior = r.priorTools.find((p) => p.callId === t.callId);
    if (!prior) throw new ReplayError(400, en("Step {n} didn't see a result of the tool call {id}."), { n: opts.fromStep + 1, id: t.callId });
    const m = msgs.find((x) => x.id === prior.messageId)!;
    // What she sees is scrubbed like any tool output.
    m.content = app.redactor.redact(String(t.output ?? '')).slice(0, 40_000);
    m.meta = { ...(m.meta ?? {}), edited: true };
  }
  let system = r.system;
  let injection: Injection | undefined = r.picks.length ? { text: '', ids: r.picks.map((p) => p.id), chars: 0, picks: r.picks, policyId: r.step.policyId ?? '' } : undefined;
  if (edits.memory && ((edits.memory.include?.length ?? 0) || (edits.memory.exclude?.length ?? 0))) {
    const e = editNotes(app, r, edits.memory);
    system = e.system;
    injection = e.injection.picks.length ? e.injection : undefined;
  }
  // The new run: a branch of the old one, its steps going on from the step it was made from.
  const rec = new RunRecorder(runs, { kind: 'turn', conversationId: r.conversation.id, userMessageId: r.userMessage.id, parentRunId: r.run.id, branchedFromStep: opts.fromStep, title: edits.message !== undefined ? String(edits.message).replace(/\s+/g, ' ').trim().slice(0, 120) : r.run.title });
  if (!rec.on) throw new ReplayError(500, en("The branch couldn't be recorded."));
  rec.startAt(opts.fromStep);
  const controller = new AbortController();
  const outer = opts.signal;
  const onAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  live.set(rec.id, controller);
  let scratch: Store | undefined;
  let restore: RestoreInfo | undefined;
  let status: RunStatus = 'error';
  let replyId = 0;
  let closed = false;
  let startHashes = new Map<string, string>();
  const startText = new Map<string, string>();
  const keep = opts.sandbox?.keep !== false;
  const words = editWords(edits, recordedModel);
  try {
    try {
      sweepBranchCopies(app);
    } catch {
      /* best effort */
    }
    // The workspace: a copy restored to the step (never the real folder).
    const real = (() => {
      try {
        return workspaceDir(app.rootDir ?? app.dataDir, r.conversation.workspace);
      } catch {
        return undefined;
      }
    })();
    if (real && (r.conversation.mode === 'coding' || existsSync(real))) {
      const allSteps = runs.steps(r.run.id);
      const ref = opts.fromStep > 0 ? refBefore(allSteps, opts.fromStep - 1) : (allSteps[0]?.workspaceRef ?? null);
      const first = allSteps.find((x) => x.idx === 0);
      const touched = opts.fromStep === 0 ? (first?.files ?? []) : [];
      const shellChanged = opts.fromStep === 0 && Boolean(first?.tools.some((x) => x.name === 'shell' && x.status !== 'denied'));
      const dest = join(branchesDir(app), String(rec.id), 'ws');
      try {
        restore = restoreWorkspace(real, r.conversation.mode === 'coding' ? ref : null, dest, { maxBytes: sandboxGateSettings(s).maxMB * 1024 * 1024, touched, shellChanged });
      } catch (err) {
        throw new ReplayError(409, en("The workspace couldn't be copied for the branch: {error}"), { error: (err as Error).message.slice(0, 200) });
      }
      startHashes = fileHashes(restore.dir);
      // Text of the files at the start, for the branch's own diff (small text files only).
      for (const [p, h] of startHashes) {
        if (h.startsWith('size:')) continue;
        try {
          const abs = join(restore.dir, ...p.split('/'));
          if (statSync(abs).size <= 256 * 1024) startText.set(p, readFileSync(abs, 'utf8'));
        } catch {
          /* unreadable */
        }
      }
    }
    scratch = scratchConversation(app, r.conversation, msgs, pin);
    runs.setBranch(rec.id, {
      fromRun: r.run.id,
      fromStep: opts.fromStep,
      edits: words,
      ...(edits.message !== undefined ? { message: String(edits.message).slice(0, 2000) } : {}),
      model: `${pin.providerId}/${pin.model}`,
      exact: r.exact,
      problems: r.problems,
      ...(restore ? { workspace: { strategy: restore.strategy, ...(restore.head ? { head: restore.head } : {}), restored: restore.restored, notRestored: restore.notRestored.slice(0, 100), notes: restore.notes }, copy: keep ? 'kept' : 'removed' } : {}),
      nonDeterministic: true,
    });
    yield { type: 'branch', runId: rec.id, fromRun: r.run.id, fromStep: opts.fromStep, exact: r.exact, problems: r.problems, workspace: restore ? { strategy: restore.strategy, ...(restore.head ? { head: restore.head } : {}), restored: restore.restored, notRestored: restore.notRestored, notes: restore.notes, ms: restore.ms } : null, edits: words, model: `${pin.providerId}/${pin.model}` };
    // The turn itself, on the scratch copy (nothing it writes reaches the real conversation).
    const overrides: Partial<AppContext> = { store: scratch, codemap: undefined, drift: undefined, security: undefined, memoryNudge: undefined, inner: undefined };
    const cx = new Proxy(app, { get: (t, k: string) => (k in overrides ? overrides[k as keyof AppContext] : t[k as keyof AppContext]) }) as AppContext;
    const replay: ReplayInputs = { system, extra: opts.notes?.length ? [...r.extra, ...opts.notes] : r.extra, ...(injection ? { injection } : {}), ...(restore ? { workspaceDir: restore.dir } : {}), ...(edits.message !== undefined ? { messageEdited: true } : {}) };
    const userText = edits.message !== undefined ? String(edits.message) : r.userMessage.content;
    status = 'stopped';
    try {
      for await (const ev of runTurn(cx, r.conversation.id, userText, controller.signal, { resume: true, recorder: rec, replay, ...(opts.budget !== undefined ? { budget: opts.budget } : {}), ...(opts.hooks ? { hooks: opts.hooks } : {}), ...(opts.recall !== undefined ? { recall: opts.recall } : {}) })) {
        if (ev.type === 'done') {
          status = 'ok';
          replyId = ev.messageId;
        } else if (ev.type === 'error') status = controller.signal.aborted ? 'stopped' : 'error';
        yield ev;
      }
    } catch (err) {
      status = controller.signal.aborted ? 'stopped' : 'error';
      yield { type: 'error', message: (err as Error).message };
    }
    const outcome = finishBranch();
    yield { type: 'branch_done', runId: rec.id, outcome };
  } finally {
    // A consumer that stopped early (closed stream) still leaves a finished record.
    if (!closed) finishBranch();
    outer?.removeEventListener('abort', onAbort);
    live.delete(rec.id);
    try {
      scratch?.close();
    } catch {
      /* closed */
    }
  }

  /** Closes the run, keeps the branch's messages and files with it (once). */
  function finishBranch(): ReplayOutcome {
    closed = true;
    try {
      rec.close(status === 'ok' && rec.outcome ? rec.outcome : status, replyId || rec.lastReplyId || undefined);
    } catch {
      /* recorded what it could */
    }
    let answer = '';
    let files: BranchFile[] = [];
    try {
      if (scratch) {
        // The branch's messages go with its run (the copied history too, so it can be rebuilt and
        // branched again); its safety events count like any turn's.
        runs.putMessages(rec.id, scratch.messages(r.conversation.id));
        for (const e of scratch.db.prepare('SELECT kind FROM safety_events ORDER BY id').all() as { kind: string }[]) app.store.recordSafetyEvent(e.kind, r.conversation.id);
        const lastCopied = r.stored.at(-1)?.id ?? 0;
        answer = [...scratch.messages(r.conversation.id)].reverse().find((m) => m.id > lastCopied && m.role === 'assistant' && m.content.trim() && !(m.meta?.toolCalls as unknown[] | undefined)?.length)?.content ?? '';
      }
    } catch (err) {
      console.warn(`branch: saving its messages failed: ${(err as Error).message}`);
    }
    try {
      if (restore) {
        files = branchFiles(restore.dir, startHashes, startText);
        if (!keep) rmSync(join(branchesDir(app), String(rec.id)), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } catch (err) {
      console.warn(`branch: comparing its files failed: ${(err as Error).message}`);
    }
    const run = runs.get(rec.id);
    const outcome: ReplayOutcome = { runId: rec.id, status: run?.status ?? status, answer, steps: run?.steps ?? 0, tokens: (run?.tokensIn ?? 0) + (run?.tokensOut ?? 0), usd: run?.usd ?? 0, files, exact: r.exact };
    try {
      const parent = runs.get(r.run.id);
      if (run && parent) outcome.summary = summaryLine(diffRuns(runs, app.store, parent, run));
    } catch {
      /* no summary */
    }
    runs.setBranch(rec.id, { files, answerChars: answer.length, ...(outcome.summary ? { summary: outcome.summary } : {}) });
    return outcome;
  }
}

/** What the branch changed in its copy: added / changed / removed, with a diff of small text files. */
export function branchFiles(dir: string, start: Map<string, string>, startText: Map<string, string>): BranchFile[] {
  const end = fileHashes(dir);
  const out: BranchFile[] = [];
  const text = (abs: string): string | undefined => {
    try {
      if (statSync(abs).size > 256 * 1024) return undefined;
      const b = readFileSync(abs);
      return b.includes(0) ? undefined : b.toString('utf8');
    } catch {
      return undefined;
    }
  };
  for (const [p, h] of end) {
    const was = start.get(p);
    if (was === h) continue;
    const now = text(join(dir, ...p.split('/')));
    const before = was ? startText.get(p) : '';
    const diff = now !== undefined && before !== undefined ? unifiedDiff(p, before, now) : undefined;
    out.push({ path: p, change: was ? 'changed' : 'added', sha: h, ...(was ? { startSha: was } : {}), ...(diff ? { diff } : {}), ...(now === undefined ? { binary: true as const } : {}) });
  }
  for (const [p, h] of start) if (!end.has(p)) out.push({ path: p, change: 'removed', startSha: h, ...(startText.has(p) ? { diff: unifiedDiff(p, startText.get(p)!, '') } : {}) });
  return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 500);
}

/** Runs a branch to its end without a page (M9's eval loop, tests): the new run id and how it went. */
export async function replayRun(app: AppContext, runId: number, opts: ReplayOptions & { onEvent?: (ev: BranchEvent) => void }): Promise<ReplayOutcome> {
  let out: ReplayOutcome | undefined;
  let id = 0;
  for await (const ev of branchRun(app, runId, opts)) {
    opts.onEvent?.(ev);
    if (ev.type === 'branch') id = ev.runId;
    if (ev.type === 'branch_done') out = ev.outcome;
  }
  if (!out) {
    const run = app.runs?.get(id);
    out = { runId: id, status: run?.status ?? 'error', answer: '', steps: run?.steps ?? 0, tokens: (run?.tokensIn ?? 0) + (run?.tokensOut ?? 0), usd: run?.usd ?? 0, files: [], exact: null };
  }
  return out;
}

/** The two runs side by side (same conversation only). */
export function compareRuns(app: AppContext, aId: number, bId: number): RunDiff {
  const runs = app.runs;
  if (!runs) throw new ReplayError(404, en('Run history is not available here.'));
  const a = runs.get(aId);
  const b = runs.get(bId);
  if (!a || !b) throw new ReplayError(404, en('No such run.'));
  if (!a.conversationId || a.conversationId !== b.conversationId) throw new ReplayError(400, en('Only runs of the same reply can be compared.'));
  return diffRuns(runs, app.store, a, b);
}

/**
 * "Use this answer": the branch's final answer goes into the real conversation as her newest
 * message, marked as a re-run (which run, from which step). Once per branch.
 */
export function useAnswer(app: AppContext, branchId: number): StoredMessage {
  const runs = app.runs;
  const run = runs?.get(branchId);
  if (!runs || !run || !run.parentRunId) throw new ReplayError(404, en('No such branch.'));
  if (run.status === 'running') throw new ReplayError(409, en('The branch is still running.'));
  if (run.branch?.usedMessageId) throw new ReplayError(409, en('This answer is in the conversation already.'));
  const conv = run.conversationId ? app.store.getConversation(run.conversationId) : undefined;
  if (!conv) throw new ReplayError(404, en('The conversation of this run is gone.'));
  const msgs = runs.runMessages(branchId);
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content.trim() && !(m.meta?.toolCalls as unknown[] | undefined)?.length);
  if (!last) throw new ReplayError(409, en('The branch has no answer to use.'));
  if (last.meta?.blocked) throw new ReplayError(409, en('That answer was blocked by a safety check.'));
  const model = String(run.branch?.model ?? '');
  const msg = app.store.addMessage(conv.id, 'assistant', last.content, { rerun: { runId: branchId, fromRun: run.parentRunId, fromStep: run.branchedFromStep }, runId: branchId, ...(last.meta?.model ? { model: last.meta.model } : {}), ...(last.meta?.provider ? { provider: last.meta.provider } : {}) });
  runs.setBranch(branchId, { usedMessageId: msg.id });
  void model;
  return msg;
}

/**
 * Apply: the branch's file changes go into the real workspace, only where the real file is still
 * as the branch found it (else it's a conflict and stays as it is). Never into .git, dependency
 * folders or through links. The owner's explicit choice; nothing else writes the real workspace.
 */
export function applyBranch(app: AppContext, branchId: number): { written: string[]; removed: string[]; conflicts: string[] } {
  const runs = app.runs;
  const run = runs?.get(branchId);
  if (!runs || !run || !run.parentRunId) throw new ReplayError(404, en('No such branch.'));
  if (run.status === 'running') throw new ReplayError(409, en('The branch is still running.'));
  if (run.branch?.applied) throw new ReplayError(409, en("This branch's files were applied already."));
  const conv = run.conversationId ? app.store.getConversation(run.conversationId) : undefined;
  if (!conv) throw new ReplayError(404, en('The conversation of this run is gone.'));
  const copy = join(branchesDir(app), String(branchId), 'ws');
  if (!existsSync(copy)) throw new ReplayError(409, en("The branch's copy is gone (discarded or cleaned up)."));
  const files = (run.branch?.files ?? []) as BranchFile[];
  if (!files.length) throw new ReplayError(409, en('The branch changed no files.'));
  const real = workspaceDir(app.rootDir ?? app.dataDir, conv.workspace);
  const written: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];
  for (const f of files) {
    const dst = safeTarget(real, f.path);
    const src = safeTarget(copy, f.path);
    if (!dst || !src) {
      conflicts.push(f.path);
      continue;
    }
    let cur: string | undefined;
    try {
      const st = lstatSync(dst);
      cur = st.isFile() ? (st.size > 8 * 1024 * 1024 ? `size:${st.size}` : sha16(readFileSync(dst))) : 'not-a-file';
    } catch {
      cur = undefined;
    }
    if (cur !== f.startSha) {
      conflicts.push(f.path);
      continue;
    }
    if (f.change === 'removed') {
      if (cur !== undefined) unlinkSync(dst);
      removed.push(f.path);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      written.push(f.path);
    }
  }
  runs.setBranch(branchId, { applied: { written, removed, conflicts, at: app.now().toISOString() } });
  return { written, removed, conflicts };
}

/** Discard the branch's workspace copy (the run record stays). */
export function discardCopy(app: AppContext, branchId: number): void {
  const run = app.runs?.get(branchId);
  if (!run || !run.parentRunId) throw new ReplayError(404, en('No such branch.'));
  if (runningBranches(app).has(branchId)) throw new ReplayError(409, en('The branch is still running.'));
  rmSync(join(branchesDir(app), String(branchId)), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.runs!.setBranch(branchId, { copy: 'removed' });
}

/** What the branch sheet needs for one step: the message, the results it saw, the notes, the models. */
export function branchInfo(app: AppContext, runId: number, idx: number) {
  const r = rebuildStep(app, runId, idx);
  const notes = r.picks.map((p) => {
    const m = app.memory?.get(p.id);
    return { id: p.id, sure: p.sure, text: m ? (m.content.length > 160 ? `${m.content.slice(0, 159)}…` : m.content) : null };
  });
  return {
    runId,
    step: idx,
    message: r.userMessage?.content ?? null,
    tools: r.priorTools.map((t) => ({ step: t.step, callId: t.callId, name: t.name, summary: t.summary, output: t.output.length > 20_000 ? `${t.output.slice(0, 20_000)}\n[…]` : t.output })),
    notes,
    model: r.model,
    models: branchModels(app, r.conversation, r.model),
    coding: r.conversation.mode === 'coding',
    private: r.conversation.private,
    exact: r.exact,
    problems: r.problems,
    workspace: (() => {
      const steps = app.runs!.steps(runId);
      const ref = idx > 0 ? refBefore(steps, idx - 1) : (steps[0]?.workspaceRef ?? null);
      return ref ? { head: ref.head ?? null, branch: ref.branch ?? null, dirty: ref.dirty?.length ?? 0 } : null;
    })(),
    ms: Math.round(r.ms * 100) / 100,
  };
}
