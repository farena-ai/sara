// Phase 13: coding partner depth.
// - Background jobs: long builds and test runs keep going while the chat carries on.
// - Git: look (status, diff, log, branches) freely; commit, branch and push need the owner's OK by
//   default. Push uses the owner's GitHub token only for that command, never force-pushes.
// - Delegation: hand a task to Claude Code or Grok Build (the owner's subscriptions) in the
//   workspace sandbox; it runs as a background job, with an undo point before and the list of
//   changed files and the agent's own report after.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AppContext } from '../chat.ts';
import { MAX_JOB_MS } from '../jobs.ts';
import { runCommand, type Bind } from './sandbox.ts';
import { clip, num, str, ToolError, type Tool, type ToolContext } from './types.ts';
import { resolveInside } from './workspace.ts';
import { cleanBudget, type UsageNumbers } from '../usage.ts';
import { PROVIDER_PRESETS } from '../providers/registry.ts';

export const GITHUB_VAULT = 'git:github';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
/** Quotes one argument for /bin/sh. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function convWorkspace(app: AppContext, ctx: ToolContext): { conversationId: string; workspace: string } {
  const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
  if (!conv) throw new ToolError('No conversation for this job.');
  return { conversationId: conv.id, workspace: conv.workspace };
}

/**
 * Settings that make git run other programs (hooks, fsmonitor, pagers, external diff, ssh
 * commands, credential helpers) are switched off for every git command Sara runs herself: a
 * repository's own config is written by whoever made it, and the "look" commands run without the
 * owner's OK. Command-line settings win over every config file.
 */
export const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.sshCommand=ssh', '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'core.gitProxy=', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', '-c', 'uploadpack.packObjectsHook=', '-c', 'diff.external=', '-c', 'gpg.program=gpg'];

export async function git(ctx: ToolContext, args: string[], opts: { env?: Record<string, string>; network?: boolean; timeoutMs?: number; extra?: string[] } = {}): Promise<{ code: number | null; out: string }> {
  // `-C <folder>` must stay inside the workspace (and is turned into the sandbox's path).
  const a = [...args];
  if (a[0] === '-C') {
    const real = resolveInside(ctx.workspaceDir, a[1] ?? '.');
    const rel = relative(ctx.workspaceDir, real).split(sep).join('/') || '.';
    a[1] = ctx.sandbox.mode === 'bwrap' ? `/workspace/${rel}` : real;
  }
  const r = await runCommand(`git ${[...GIT_SAFE, ...(opts.extra ?? []), ...a].map(shq).join(' ')}`, ctx.workspaceDir, { ...ctx.sandbox, network: opts.network ?? false }, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    signal: ctx.signal,
    ...(opts.env ? { env: opts.env } : {}),
    ...(ctx.companionName && ctx.companionName !== 'Sara' ? { gitName: ctx.companionName } : {}),
  });
  return { code: r.exitCode, out: r.output.trimEnd() };
}

const SAFE_REF = /^(?!-)[\w./-]{1,100}$/;
const ref = (v: string, what: string) => {
  if (!SAFE_REF.test(v) || v.includes('..')) throw new ToolError(`That ${what} name isn't allowed.`);
  return v;
};

export function createCodingTools(app: AppContext): Tool[] {
  const startJob: Tool = {
    defaultPermission: 'ask',
    runsCommands: true,
    spec: {
      name: 'start_job',
      description:
        'Start a long command in the background (a build, a full test run, a long script) and keep talking meanwhile. Returns a job number at once; the result is reported back in this conversation when it ends (and the owner is notified). Use shell for quick commands. A web app\'s dev server runs as a job too (listening on 127.0.0.1 and a port); then look at it: pc_browser_open with app_port (the owner\'s Sara browser, through the dev tunnel) or preview_start.',
      parameters: obj({ command: { type: 'string' }, label: { type: 'string', description: 'Short name, e.g. "full test suite"' }, timeout_minutes: { type: 'integer', description: 'Default 30, max 60' } }, ['command']),
    },
    isAvailable: () => Boolean(app.jobs),
    summarize: (a) => `background: $ ${String(a.command ?? '').slice(0, 160)}`,
    async run(args, ctx) {
      const { conversationId, workspace } = convWorkspace(app, ctx);
      const command = str(args, 'command');
      const label = str(args, 'label', false) || command.slice(0, 120);
      const minutes = Math.min(60, Math.max(1, num(args, 'timeout_minutes', 30)));
      const { job } = app.jobs!.start({ conversationId, workspace, label, command, timeoutMs: minutes * 60_000, sandbox: ctx.sandbox, ...(ctx.companionName && ctx.companionName !== 'Sara' ? { env: { GIT_AUTHOR_NAME: ctx.companionName, GIT_COMMITTER_NAME: ctx.companionName } } : {}) });
      return `Started background job #${job.id} (${label}). It runs for up to ${minutes} minutes; the result will be reported here when it ends. Don't claim a result before then; use job_status to check progress.`;
    },
  };

  const jobStatus: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'job_status', description: 'Check a background job: running or finished, and its latest output.', parameters: obj({ job: { type: 'integer' } }, ['job']) },
    isAvailable: () => Boolean(app.jobs),
    summarize: (a) => `job #${String(a.job)} status`,
    async run(args) {
      const j = app.jobs!.get(num(args, 'job', 0));
      if (!j) throw new ToolError('No such job.');
      const mins = ((j.endedAt ? Date.parse(j.endedAt) : app.now().getTime()) - Date.parse(j.startedAt)) / 60_000;
      return `Job #${j.id} (${j.label}): ${j.status}${j.exitCode !== null ? `, exit code ${j.exitCode}` : ''}, ${mins.toFixed(1)} min.${j.result?.summary ? `\nResult: ${String(j.result.summary).slice(0, 2000)}` : ''}\nLatest output:\n${j.tail.slice(-3000) || '(none yet)'}`;
    },
  };

  const stopJob: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'stop_job', description: 'Stop a running background job.', parameters: obj({ job: { type: 'integer' } }, ['job']) },
    isAvailable: () => Boolean(app.jobs),
    summarize: (a) => `stop job #${String(a.job)}`,
    async run(args) {
      return app.jobs!.stop(num(args, 'job', 0)) ? 'Stopping it.' : 'That job is not running.';
    },
  };

  const gitLook: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'git',
      description: 'Look at the git repository in the workspace (read only): status, diff (unstaged and staged changes), log, branches, or show a commit.',
      parameters: obj({ action: { type: 'string', enum: ['status', 'diff', 'log', 'branches', 'show'] }, path: { type: 'string', description: 'Folder of the repository inside the workspace (default: the workspace)' }, commit: { type: 'string', description: 'For show' } }, ['action']),
    },
    summarize: (a) => `git ${String(a.action ?? '')}${a.path ? ` (${String(a.path)})` : ''}`,
    async run(args, ctx) {
      const action = str(args, 'action');
      const dir = str(args, 'path', false);
      const C = dir ? ['-C', dir] : [];
      const cmd: Record<string, string[]> = {
        status: ['status', '--short', '--branch'],
        diff: ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--patch', 'HEAD'],
        log: ['log', '--oneline', '--decorate', '-n', '20'],
        branches: ['branch', '-a', '-vv'],
        show: ['show', '--no-ext-diff', '--no-textconv', '--stat', '--patch', ref(str(args, 'commit', false) || 'HEAD', 'commit')],
      };
      if (!cmd[action]) throw new ToolError('Unknown action.');
      const r = await git(ctx, [...C, '--no-pager', ...cmd[action]]);
      if (r.code !== 0 && action === 'diff') {
        // A repository with no commits yet: show what's staged/untracked instead.
        const s = await git(ctx, [...C, 'status', '--short']);
        return clip(s.out || '(nothing)', 30_000);
      }
      return clip(r.out || '(nothing)', 30_000);
    },
  };

  const gitCommit: Tool = {
    defaultPermission: 'ask',
    spec: {
      name: 'git_commit',
      description: 'Commit changes in the workspace repository: stages the given paths (or everything), commits with the message. Optionally starts a new branch first.',
      parameters: obj({ message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, new_branch: { type: 'string' }, path: { type: 'string', description: 'Folder of the repository (default: the workspace)' } }, ['message']),
    },
    summarize: (a) => `git commit: ${String(a.message ?? '').slice(0, 100)}${a.new_branch ? ` (on new branch ${String(a.new_branch)})` : ''}`,
    async run(args, ctx) {
      const message = str(args, 'message').trim();
      if (!message || message.length > 2000) throw new ToolError('Write a commit message (up to 2000 characters).');
      const dir = str(args, 'path', false);
      const C = dir ? ['-C', dir] : [];
      const branch = str(args, 'new_branch', false);
      if (branch) {
        const b = await git(ctx, [...C, 'switch', '-c', ref(branch, 'branch')]);
        if (b.code !== 0) throw new ToolError(b.out);
      }
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]).map(String) : [];
      if (paths.some((p) => p.startsWith('-'))) throw new ToolError('Paths may not start with "-".');
      const add = await git(ctx, [...C, 'add', '--', ...(paths.length ? paths : ['.'])]);
      if (add.code !== 0) throw new ToolError(add.out);
      const c = await git(ctx, [...C, 'commit', '-m', message]);
      if (c.code !== 0) throw new ToolError(c.out || 'Nothing to commit.');
      return clip(c.out, 5000);
    },
  };

  const gitBranch: Tool = {
    defaultPermission: 'ask',
    spec: {
      name: 'git_branch',
      description: 'Create a branch, or switch to an existing one, in the workspace repository.',
      parameters: obj({ action: { type: 'string', enum: ['create', 'switch'] }, name: { type: 'string' }, path: { type: 'string' } }, ['action', 'name']),
    },
    summarize: (a) => `git ${String(a.action ?? '')} branch ${String(a.name ?? '')}`,
    async run(args, ctx) {
      const dir = str(args, 'path', false);
      const name = ref(str(args, 'name'), 'branch');
      const r = await git(ctx, [...(dir ? ['-C', dir] : []), 'switch', ...(str(args, 'action') === 'create' ? ['-c'] : []), name]);
      if (r.code !== 0) throw new ToolError(r.out);
      return r.out || `On branch ${name}.`;
    },
  };

  const gitPush: Tool = {
    defaultPermission: 'ask',
    spec: {
      name: 'git_push',
      description: "Push the current branch to the remote (default origin). Never force-pushes. GitHub repositories use the owner's GitHub token if one is set in Settings.",
      parameters: obj({ remote: { type: 'string' }, branch: { type: 'string' }, path: { type: 'string' } }),
    },
    summarize: (a) => `git push ${String(a.remote ?? 'origin')}${a.branch ? ` ${String(a.branch)}` : ''}`,
    async run(args, ctx) {
      const dir = str(args, 'path', false);
      const C = dir ? ['-C', dir] : [];
      const remote = ref(str(args, 'remote', false) || 'origin', 'remote');
      const branch = str(args, 'branch', false);
      const token = app.vault.get(GITHUB_VAULT);
      const env: Record<string, string> = {};
      const extra: string[] = [];
      let note = '';
      if (token) {
        // The token goes only to github.com over https: the final address (after any rewriting
        // rules in the repository's config) is checked first. It is handed over by a credential
        // helper defined on the command line that reads it from this one command's environment;
        // nothing is written to disk or into the repository.
        const url = (await git(ctx, [...C, 'remote', 'get-url', '--push', remote])).out.trim();
        const rewrites = (await git(ctx, [...C, 'config', '--get-regexp', '^url\\..*\\.(push)?insteadof$'])).out.trim();
        if (!rewrites && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/i.test(url)) {
          env.SARA_GIT_TOKEN = token;
          extra.push('-c', 'credential.https://github.com.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$SARA_GIT_TOKEN"; }; f', '-c', 'credential.https://github.com.useHttpPath=false');
        } else note = `\n(Your GitHub token was not used: the remote ${url ? `is ${url}` : "couldn't be read"}${rewrites ? ' and the repository rewrites addresses' : ''}, not https://github.com/…)`;
      }
      const r = await git(ctx, [...C, 'push', '--no-verify', '--set-upstream', remote, ...(branch ? [ref(branch, 'branch')] : ['HEAD'])], { env, extra, network: true, timeoutMs: 120_000 });
      const out = token ? r.out.replaceAll(token, '***') : r.out;
      if (r.code !== 0) throw new ToolError((out || 'Push failed.') + note);
      return clip((out || 'Pushed.') + note, 5000);
    },
  };

  const delegate: Tool = {
    defaultPermission: 'ask',
    runsCommands: true,
    spec: {
      name: 'delegate_task',
      description:
        "Hand a coding task to Claude Code or Grok Build (the owner's subscription) to do in this workspace on its own, with its own tools (files and commands, inside the sandbox). Runs in the background; you get its report and the list of changed files when it ends, and an undo point is made first. Give it a clear, complete task.",
      parameters: obj({ agent: { type: 'string', enum: ['claude', 'grok'] }, task: { type: 'string' }, timeout_minutes: { type: 'integer', description: 'Default 30, max 60' }, budget_tokens: { type: 'integer', description: "Optional token budget (default: the owner's job budget in Settings)" }, budget_usd: { type: 'number', description: 'Optional dollar budget (Claude Code counts it)' } }, ['agent', 'task']),
    },
    // Only inside bubblewrap: the agents run without their own per-step prompts, which is only
    // acceptable where they can't see Sara's data or the rest of the server.
    isAvailable: () => Boolean(app.jobs && app.subscriptions && (app.subscriptions.claudeStatus().signedIn || app.subscriptions.grokStatus().signedIn) && app.sandbox.mode === 'bwrap'),
    summarize: (a) => `${a.agent === 'grok' ? 'Grok Build' : 'Claude Code'} works on: ${String(a.task ?? '').slice(0, 160)}`,
    async run(args, ctx) {
      const subs = app.subscriptions!;
      const kind = str(args, 'agent') === 'grok' ? 'grok' : 'claude';
      const task = str(args, 'task').trim();
      if (task.length < 10 || task.length > 8000) throw new ToolError('Describe the task in 10 to 8000 characters.');
      if (kind === 'claude' ? !subs.claudeStatus().signedIn : !subs.grokStatus().signedIn) throw new ToolError(`${kind === 'claude' ? 'Claude' : 'Grok'} isn't signed in (Settings → Models → Subscriptions).`);
      const { conversationId, workspace } = convWorkspace(app, ctx);
      const rt = subs.agent(kind);
      mkdirSync(rt.home, { recursive: true, mode: 0o700 });
      const minutes = Math.min(60, Math.max(5, num(args, 'timeout_minutes', 30)));
      // Phase 52: the job's budget (her own choice for this task, else the owner's default).
      const given = cleanBudget({ tokens: args.budget_tokens, usd: args.budget_usd });
      const budget = given.tokens || given.usd ? given : cleanBudget(app.settings.get().jobBudget);
      const promptName = `.sara-task-${randomBytes(9).toString('hex')}.md`;
      writeFileSync(join(ctx.workspaceDir, promptName), task, { mode: 0o600, flag: 'wx' });
      // Inside the sandbox: the agent's program (read only) and its own sign-in folder.
      const binDir = rt.bin.includes('/') ? rt.bin.slice(0, rt.bin.lastIndexOf('/')) : '';
      const inBwrap = ctx.sandbox.mode === 'bwrap';
      const agentsRoot = binDir.endsWith('/bin') ? binDir.slice(0, -4) : binDir;
      const binds: Bind[] = inBwrap ? [...(agentsRoot && existsSync(agentsRoot) ? [{ src: agentsRoot, dest: agentsRoot }] : []), { src: rt.home, dest: rt.home, rw: true }] : [];
      const promptPath = inBwrap ? `/workspace/${promptName}` : join(ctx.workspaceDir, promptName);
      const bin = [rt.bin, ...(rt.binArgs ?? [])].map(shq).join(' ');
      // The owner approved this task, and the agent runs inside the workspace sandbox (it can't see
      // Sara's data or the rest of the server), so its own per-step prompts are turned off: a
      // background run has nobody to answer them, and edits would just be refused.
      const command =
        kind === 'claude'
          ? `HOME=${shq(rt.home)} ${bin} -p --output-format stream-json --verbose --permission-mode bypassPermissions --max-turns 60${budget.usd ? ` --max-budget-usd ${budget.usd}` : ''} < ${shq(promptPath)}`
          : `HOME=${shq(rt.home)} ${bin} --prompt-file ${shq(promptPath)} --permission-mode bypassPermissions --always-approve --max-turns 60`;
      const env: Record<string, string> = { DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...rt.env() };
      const name = kind === 'claude' ? 'Claude Code' : 'Grok Build';
      const { job } = app.jobs!.start({
        conversationId,
        workspace,
        kind: 'agent',
        label: `${name}: ${task.replace(/\s+/g, ' ').slice(0, 200)}`,
        command: `${command}; code=$?; rm -f ${shq(promptPath)}; exit $code`,
        timeoutMs: Math.min(MAX_JOB_MS, minutes * 60_000),
        env,
        binds,
        sandbox: { ...app.sandbox, network: true },
        ...(budget.tokens || budget.usd ? { budget } : {}),
        ...(kind === 'claude' ? { meter: { config: PROVIDER_PRESETS.find((p) => p.id === 'claude-sub')!, model: 'claude-code', parse: claudeUsageParser() } } : {}),
        before: () => ({ undo: app.snapshots.take(workspace, ctx.workspaceDir, `before ${name}: ${task.slice(0, 120)}`, conversationId).id }),
        after: (r, pre) => {
          const after = app.snapshots.take(workspace, ctx.workspaceDir, `after ${name}`, conversationId).id;
          const raw = app.snapshots.compare(workspace, String(pre.undo), after);
          // Leave out the app's own helper files (the task text, the sandbox's git settings).
          const mine = (f: string) => f.startsWith('.sara-task-') || f === '.gitconfig';
          const files = { added: raw.added.filter((f) => !mine(f)), changed: raw.changed.filter((f) => !mine(f)), removed: raw.removed.filter((f) => !mine(f)) };
          return { agent: kind, undo: pre.undo, files, summary: agentReport(kind, r.output) };
        },
      });
      return `${name} is working on it as background job #${job.id} (up to ${minutes} minutes). An undo point was made first. Its report and the changed files will come back here when it's done; don't describe results before then.`;
    },
  };

  return [startJob, jobStatus, stopJob, gitLook, gitCommit, gitBranch, gitPush, delegate];
}

/**
 * Phase 52: token counts from Claude Code's stream-json output. Each model call shows up as one or
 * more "assistant" lines with the same message id and usage: counted once per id.
 */
export function claudeUsageParser(): (line: string) => UsageNumbers | undefined {
  const seen = new Set<string>();
  return (line) => {
    if (!line.startsWith('{"type":"assistant"')) return undefined;
    try {
      const j = JSON.parse(line) as { message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } };
      const u = j.message?.usage;
      const id = j.message?.id ?? '';
      if (!u || (id && seen.has(id))) return undefined;
      if (id) seen.add(id);
      const cached = u.cache_read_input_tokens ?? 0;
      return { input: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, ...(cached ? { cached } : {}) };
    } catch {
      return undefined;
    }
  };
}

/** The agent's own final words from its output (Claude: JSON `result`; Grok: the printed reply). */
export function agentReport(kind: 'claude' | 'grok', output: string): string {
  if (kind === 'claude') {
    const start = output.indexOf('{"type":"result"');
    const from = start >= 0 ? start : output.lastIndexOf('{');
    try {
      const j = JSON.parse(output.slice(from).trim().split('\n')[0]) as { result?: string; is_error?: boolean; num_turns?: number };
      if (typeof j.result === 'string') return `${j.is_error ? '(ended with an error) ' : ''}${j.result.slice(0, 4000)}${j.num_turns ? ` [${j.num_turns} steps]` : ''}`;
    } catch {
      /* not JSON: fall through */
    }
  }
  return output.trim().slice(-4000);
}
