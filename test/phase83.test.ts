// Phase 83 (harness track M8, docs/design/HARNESS_TRACK.md §3 M8): time-travel. Rebuild the exact
// inputs of step N of a recorded turn, serve the earlier steps' tool results from the record (no
// re-execution), carry on live with edits (message, a tool result, memory notes, model), as a new
// run with parent_run_id + branched_from_step; coding branches work in a copy restored to the
// step's commit; the conversation is untouched unless "Use this answer"; approvals, budgets and
// the safety layer still apply; the diff; off the record never replayable; owner-only; speed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type BeforeModelCall, type ChatEvent, type TurnHooks } from '../src/chat.ts';
import { BRANCH_ACTIONS, memberRouteCheck, type MemberRecord } from '../src/household.ts';
import type { ChatMessage, StreamEvent } from '../src/providers/types.ts';
import { applyBranch, branchInfo, branchRun, compareRuns, rebuildStep, replayRun, ReplayError, useAnswer, type BranchEvent } from '../src/replay.ts';
import { diffTokens, diffWords, unifiedDiff } from '../src/run-diff.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { detectCrisis } from '../src/safety.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { priceTable, UsageStore } from '../src/usage.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const usage = (input: number, output: number): StreamEvent => ({ type: 'usage', input, output });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

interface Setup {
  app: TestApp;
  runs: RunStore;
  dir: string;
  /** Times each tool really ran. */
  ran: Record<string, number>;
}

function setup(t: { after: (fn: () => void) => void }): Setup {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.usage = new UsageStore(app.store.db, () => NOW);
  app.usage.prices = () => priceTable(app.settings.get().prices);
  const runs = new RunStore(app.store.db, () => NOW);
  runs.usage = app.usage;
  runs.settings = () => runSettings(app.settings.get());
  app.runs = runs;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const ran: Record<string, number> = { shell: 0, write_file: 0 };
  const shell: Tool = {
    spec: { name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: (a) => `shell ${String(a.command ?? '')}`,
    async run(a) {
      ran.shell++;
      return `[exit code 0]\nran ${String(a.command)}`;
    },
  };
  // A real file write in whatever workspace the turn has (the branch: its copy).
  const write: Tool = {
    spec: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: (a) => `write ${String(a.path)}`,
    async run(a, ctx) {
      ran.write_file++;
      const p = join(ctx.workspaceDir, String(a.path));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, String(a.content));
      return `Wrote ${String(a.path)}`;
    },
  };
  app.tools.add(shell);
  app.tools.add(write);
  app.settings.update({
    providers: [
      { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      { id: 'loc', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
    ],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    toolPermissions: { shell: 'auto', write_file: 'auto' },
    prices: [{ model: 'm', inPerM: 1, outPerM: 2 }],
  });
  return { app, runs, dir, ran };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** What each model call of a turn was sent (copied: the loop keeps adding to the list). */
function recorder(): { hooks: TurnHooks; sent: { model: string; messages: ChatMessage[] }[] } {
  const sent: { model: string; messages: ChatMessage[] }[] = [];
  return { sent, hooks: { beforeModelCall: (c: BeforeModelCall) => void sent.push({ model: c.model, messages: JSON.parse(JSON.stringify(c.messages)) }) } };
}

/** The same 3-step turn every time: a command, a file write, the answer. */
async function threeSteps(s: Setup, mode: 'chat' | 'coding' = 'coding', opts: { hooks?: TurnHooks } = {}) {
  const conv = s.app.store.createConversation({ mode, title: 'Theme work' });
  s.app.script.push([call('c1', 'shell', { command: 'ls' }), usage(1000, 50)], [call('c2', 'write_file', { path: 'src/theme.ts', content: 'export const theme = "blue";\n' }), usage(1200, 80)], [...text('Done: the theme is blue now.'), usage(1400, 30)]);
  const evs = await drain(runTurn(s.app, conv.id, 'make the theme blue', undefined, opts.hooks ? { hooks: opts.hooks } : {}));
  assert.ok(evs.some((e) => e.type === 'done'), JSON.stringify(evs.filter((e) => e.type === 'error')));
  const [run] = s.runs.list({ conversationId: conv.id });
  return { conv, run };
}

/** A coding workspace that is a git repository with one commit and one uncommitted file. */
function repo(s: Setup): string {
  const ws = workspaceDir(s.app.dataDir, 'main');
  git(ws, 'init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'README.md'), '# demo\n');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'theme.ts'), 'export const theme = "red";\n');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'start');
  writeFileSync(join(ws, 'notes.md'), 'uncommitted note\n');
  return ws;
}

async function refsWritten(runs: RunStore, id: number) {
  for (let i = 0; i < 100 && runs.steps(id).filter((x) => x.workspaceRef?.head).length < 2; i++) await new Promise((r) => setTimeout(r, 30));
}

const snapshotDir = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else if (e.isFile()) out[r] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  walk(dir, '');
  return out;
};

test('the inputs of step N are rebuilt byte for byte: system prompt from its blob, history from the range, memory picks', async (t) => {
  const s = setup(t);
  s.app.memory!.add({ kind: 'fact', content: "Alex's project uses the blue theme.", evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  const rec = recorder();
  const { run } = await threeSteps(s, 'chat', { hooks: rec.hooks });
  assert.equal(rec.sent.length, 3);
  for (const n of [0, 1, 2]) {
    const r = rebuildStep(s.app, run.id, n);
    assert.equal(r.system, rec.sent[n].messages[0].content, `step ${n}: the system prompt from its blob, byte for byte`);
    assert.deepEqual(r.messages, rec.sent[n].messages.slice(1), `step ${n}: the history and notes, rebuilt`);
    assert.equal(r.exact, true, 'the recorded inputs hash matches');
    assert.deepEqual(r.problems, []);
    assert.ok(r.picks.length >= 1 && r.picks.every((p) => typeof p.id === 'number'), 'the memory picks of the step');
    assert.equal(r.model.providerId, 'p');
    assert.equal(r.model.model, 'm');
  }
  // Step 2 saw both earlier tool results: served from the record.
  const r2 = rebuildStep(s.app, run.id, 2);
  assert.deepEqual(r2.priorTools.map((x) => x.name), ['shell', 'write_file']);
  // A changed message is noticed (the hash no longer matches).
  const tool = s.app.store.messages(run.conversationId!).find((m) => m.role === 'tool')!;
  s.app.store.updateMessageContent(tool.id, 'something else');
  assert.equal(rebuildStep(s.app, run.id, 2).exact, false);
  assert.ok(rebuildStep(s.app, run.id, 2).problems.length);
  // Not a step, not a run, not a turn.
  assert.throws(() => rebuildStep(s.app, run.id, 9), (e) => e instanceof ReplayError && e.status === 404);
  assert.throws(() => rebuildStep(s.app, 9999, 0), (e) => e instanceof ReplayError && e.status === 404);
});

test('a branch from step 2 serves the earlier tool results from the record (nothing runs again) and starts from the same inputs', async (t) => {
  const s = setup(t);
  const orig = recorder();
  const { conv, run } = await threeSteps(s, 'chat', { hooks: orig.hooks });
  assert.deepEqual(s.ran, { shell: 1, write_file: 1 });
  const before = s.app.store.messages(conv.id);
  const fork = recorder();
  s.app.script.push([...text('Done again.'), usage(1400, 20)]);
  const out = await replayRun(s.app, run.id, { fromStep: 2, hooks: fork.hooks });
  assert.equal(out.status, 'ok');
  assert.equal(out.answer, 'Done again.');
  assert.deepEqual(s.ran, { shell: 1, write_file: 1 }, 'no tool ran again: steps 0 and 1 came from the record');
  assert.equal(out.exact, true);
  // The branch's first model call was sent exactly what step 2 was sent.
  assert.deepEqual(fork.sent[0].messages, orig.sent[2].messages);
  // A separate run: parent + branch point; its steps go on from step 2.
  const b = s.runs.get(out.runId)!;
  assert.equal(b.parentRunId, run.id);
  assert.equal(b.branchedFromStep, 2);
  assert.equal(b.conversationId, conv.id);
  assert.deepEqual(s.runs.steps(b.id).map((x) => x.idx), [2]);
  assert.equal(b.branch?.nonDeterministic, true);
  assert.deepEqual(s.runs.branches(run.id).map((x) => x.id), [b.id]);
  // The conversation is untouched: the branch's messages live in its run record.
  assert.deepEqual(s.app.store.messages(conv.id), before);
  const kept = s.runs.runMessages(b.id);
  assert.equal(kept.at(-1)?.content, 'Done again.');
  assert.ok(kept.at(-1)!.id > before.at(-1)!.id + 1_000_000, "the branch's own ids never look like the conversation's");
  assert.equal(s.runs.forMessage(before.at(-1)!.id)?.id, run.id, 'the reply still opens the original run');
  // Retention keeps the parent, however old.
  s.app.store.db.prepare("UPDATE runs SET started_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(run.id);
  s.runs.prune(true);
  assert.ok(s.runs.get(run.id), 'a branch parent is never pruned');
  // "Use this answer": appended, clearly marked as a re-run; once.
  const used = useAnswer(s.app, b.id);
  assert.equal(used.content, 'Done again.');
  assert.deepEqual(used.meta?.rerun, { runId: b.id, fromRun: run.id, fromStep: 2 });
  assert.equal(s.app.store.messages(conv.id).length, before.length + 1);
  assert.throws(() => useAnswer(s.app, b.id), (e) => e instanceof ReplayError && e.status === 409);
});

test('edits: the message, a tool result, memory notes in and out, the model', async (t) => {
  const s = setup(t);
  const blue = s.app.memory!.add({ kind: 'fact', content: "Alex's project uses the blue theme.", evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  const { run } = await threeSteps(s, 'chat');
  // A note written after the reply: put in on the branch.
  const cats = s.app.memory!.add({ kind: 'fact', content: 'Alex has two cats named Miso and Tofu.', evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-09-02' });
  const r2 = rebuildStep(s.app, run.id, 2);
  assert.ok(r2.picks.some((p) => p.id === blue.id), 'the blue note went in');
  assert.ok(!r2.picks.some((p) => p.id === cats.id), 'the cats note did not');
  const fork = recorder();
  s.app.script.push([...text('Using the green theme.'), usage(900, 10)]);
  const out = await replayRun(s.app, run.id, {
    fromStep: 2,
    hooks: fork.hooks,
    edits: { message: 'make the theme green', toolResults: [{ callId: 'c1', output: '[exit code 0]\nsrc/ green.css' }], memory: { exclude: [blue.id], include: [cats.id] } },
    model: { providerId: 'loc', model: 'small' },
  });
  assert.equal(out.status, 'ok');
  const sent = fork.sent[0];
  assert.equal(sent.model, 'small', 'the model picked');
  const system = String(sent.messages[0].content);
  assert.ok(!system.includes('blue theme'), 'the note taken out is gone from her notes');
  assert.ok(system.includes('Miso and Tofu'), 'the note put in is there');
  assert.ok(sent.messages.some((m) => m.role === 'user' && m.content === 'make the theme green'), 'the rewritten message');
  assert.ok(sent.messages.some((m) => m.role === 'tool' && m.content.includes('green.css')), 'the replaced tool result');
  assert.ok(!sent.messages.some((m) => m.role === 'tool' && m.content.includes('ran ls')), 'not the recorded one');
  const step = s.runs.steps(out.runId)[0];
  assert.equal(step.model, 'small');
  assert.deepEqual((step.memoryPicks as { id: number }[]).map((p) => p.id), [cats.id], 'the picks recorded on the branch');
  assert.equal(s.app.requests.at(-1)!.model, 'small');
  const b = s.runs.get(out.runId)!;
  assert.deepEqual(b.branch?.edits, ['message', 'tool:c1', `note-out:${blue.id}`, `note-in:${cats.id}`, 'model:loc/small']);
  // A tool call the step never saw is refused, before anything runs.
  await assert.rejects(replayRun(s.app, run.id, { fromStep: 1, edits: { toolResults: [{ callId: 'c2', output: 'x' }] } }), (e) => e instanceof ReplayError && e.status === 400);
  // The branch sheet's data: message, results, notes with their text, models.
  const info = branchInfo(s.app, run.id, 2);
  assert.equal(info.message, 'make the theme blue');
  assert.deepEqual(info.tools.map((x) => x.callId), ['c1', 'c2']);
  assert.ok(info.notes.some((n) => n.id === blue.id && n.text?.includes('blue')));
  assert.ok(info.models.some((m) => m.providerId === 'p' && m.model === 'm'));
});

test('coding: the branch works in a copy at the recorded commit; the real workspace is untouched; Apply writes only what is unchanged', async (t) => {
  const s = setup(t);
  const ws = repo(s);
  const head0 = git(ws, 'rev-parse', 'HEAD');
  const { conv, run } = await threeSteps(s, 'coding');
  await refsWritten(s.runs, run.id);
  assert.equal(readFileSync(join(ws, 'src', 'theme.ts'), 'utf8'), 'export const theme = "blue";\n', 'the original turn wrote the real file');
  const ref1 = s.runs.steps(run.id).find((x) => x.idx === 1)!.workspaceRef!;
  assert.equal(ref1.head, head0);
  // The project moves on: a new commit, and the uncommitted note changes.
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'blue');
  writeFileSync(join(ws, 'notes.md'), 'changed later\n');
  const realBefore = snapshotDir(ws);
  const worktrees = git(ws, 'worktree', 'list');
  const remotes = git(ws, 'remote');
  // Branch from step 1 (before the write): she writes another theme, in the copy.
  s.app.script.push([call('w2', 'write_file', { path: 'src/theme.ts', content: 'export const theme = "green";\n' }), call('w3', 'write_file', { path: 'src/green.ts', content: 'export const green = true;\n' }), usage(800, 40)], [...text('Green it is.'), usage(900, 10)]);
  const evs: BranchEvent[] = [];
  const out = await replayRun(s.app, run.id, { fromStep: 1, edits: { message: 'make the theme green' }, onEvent: (e) => evs.push(e) });
  assert.equal(out.status, 'ok');
  const start = evs.find((e) => e.type === 'branch') as Extract<BranchEvent, { type: 'branch' }>;
  assert.equal(start.workspace?.strategy, 'clone');
  assert.equal(start.workspace?.head, head0, 'the copy is at the commit recorded for that step');
  assert.ok(start.workspace!.notRestored.some((x) => x.path === 'notes.md' && x.why === 'changed since'), "what couldn't be restored is said");
  assert.ok(start.workspace!.notes.some((n) => /moved on/.test(n.key) && n.params?.head === git(ws, 'rev-parse', 'HEAD').slice(0, 10)));
  // The real workspace: not a byte changed, no worktree, no remote added.
  assert.deepEqual(snapshotDir(ws), realBefore);
  assert.equal(git(ws, 'worktree', 'list'), worktrees);
  assert.equal(git(ws, 'remote'), remotes);
  // The copy has the branch's file, a detached HEAD at the old commit and no remote to push to.
  const copy = join(s.app.dataDir, 'cache', 'branch-runs', String(out.runId), 'ws');
  assert.equal(readFileSync(join(copy, 'src', 'theme.ts'), 'utf8'), 'export const theme = "green";\n');
  assert.equal(git(copy, 'rev-parse', 'HEAD'), head0);
  assert.equal(git(copy, 'remote'), '');
  // Byte for byte as the real workspace (line endings too, whatever this computer's git settings).
  assert.deepEqual(readFileSync(join(copy, 'README.md')), readFileSync(join(ws, 'README.md')));
  assert.ok(!readFileSync(join(copy, 'src', 'theme.ts'), 'utf8').includes('\r'), 'no line endings made up for a file that changed since');
  // Its files: one change, with its diff from the step's state (red → green).
  assert.deepEqual(out.files.map((f) => [f.path, f.change]), [['src/green.ts', 'added'], ['src/theme.ts', 'changed']]);
  assert.match(out.files[1].diff ?? '', /-export const theme = "red";\n\+export const theme = "green";/);
  // The diff of the two runs.
  const d = compareRuns(s.app, run.id, out.runId);
  assert.equal(d.sharedUntil, 1);
  assert.deepEqual(d.steps.map((x) => [x.idx, x.shared]), [[0, true], [1, false], [2, false]]);
  assert.equal(d.steps[1].a?.tools[0].args.content, 'export const theme = "blue";\n');
  assert.equal(d.steps[1].b?.tools[0].args.content, 'export const theme = "green";\n');
  assert.ok(d.files.some((f) => f.path === 'src/theme.ts' && !f.same), 'different file edits in src/theme.ts');
  assert.equal(d.answer.same, false);
  assert.equal(d.answer.ops.filter((o) => o.t !== '+').map((o) => o.s).join(''), 'Done: the theme is blue now.');
  assert.equal(d.answer.ops.filter((o) => o.t !== '-').map((o) => o.s).join(''), 'Green it is.');
  assert.equal(d.summary.stepsA, 3);
  assert.equal(d.summary.stepsB, 3);
  // Apply (the owner's explicit choice): the new file goes in; theme.ts changed in the real
  // workspace since the step (the original wrote blue), so it is a conflict and stays as it is.
  const applied = applyBranch(s.app, out.runId);
  assert.deepEqual(applied.written, ['src/green.ts']);
  assert.deepEqual(applied.conflicts, ['src/theme.ts']);
  assert.deepEqual(snapshotDir(ws), { ...realBefore, 'src/green.ts': 'export const green = true;\n' }, 'only the unchanged file was written');
  assert.throws(() => applyBranch(s.app, out.runId), (e) => e instanceof ReplayError && e.status === 409);
  void conv;
});

test('approvals, budgets and the safety layer still apply on a branch', async (t) => {
  const s = setup(t);
  const { run } = await threeSteps(s, 'chat');
  // A tool that asks first: the branch stops at the approval card; a no means it never runs.
  s.app.settings.update({ toolPermissions: { shell: 'ask', write_file: 'auto' } });
  s.app.script.push([call('again', 'shell', { command: 'rm -rf build' }), usage(100, 10)], [...text('I did not run it.'), usage(100, 10)]);
  const evs: BranchEvent[] = [];
  const gen = branchRun(s.app, run.id, { fromStep: 1 });
  for await (const ev of gen) {
    evs.push(ev);
    if (ev.type === 'approval') s.app.approvals.decide(ev.approvalId, false);
  }
  const ap = evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }> | undefined;
  assert.ok(ap, 'the approval card is shown');
  assert.equal(s.ran.shell, 1, 'denied: it never ran');
  const done = evs.find((e) => e.type === 'branch_done') as Extract<BranchEvent, { type: 'branch_done' }>;
  assert.equal(s.runs.steps(done.runId)[0].tools[0].approval, 'denied');
  // A budget: 1,000 tokens, 600 a step → the ladder, then the run ends at its budget.
  s.app.settings.update({ toolPermissions: { shell: 'auto', write_file: 'auto' } });
  s.app.script.push([call('b1', 'shell', { command: 'ls' }), usage(500, 100)], [call('b2', 'shell', { command: 'ls' }), usage(500, 100)], [...text('Summary: stopped at the budget.'), usage(100, 20)], [...text('extra'), usage(1, 1)]);
  const out = await replayRun(s.app, run.id, { fromStep: 2, budget: { tokens: 1000 } });
  assert.equal(out.status, 'budget', 'the branch stops at its budget');
  // The safety layer: a rewritten message that is a crisis gets the crisis help, as in any turn.
  const crisis = 'I want to end my life';
  assert.ok(detectCrisis(crisis));
  s.app.script.push([...text("I'm here with you."), usage(100, 10)]);
  const evs2: BranchEvent[] = [];
  await replayRun(s.app, run.id, { fromStep: 0, edits: { message: crisis }, onEvent: (e) => evs2.push(e) });
  assert.ok(evs2.some((e) => e.type === 'notice' && e.kind === 'crisis'), 'the crisis help is shown');
  assert.match(String(s.app.requests.at(-1)!.messages[0].content), /Important for this reply/, 'and her instructions carry the crisis note');
});

test('off the record is never replayable; branching is the owner\'s (members 403); the routes stream and compare', async (t) => {
  const s = setup(t);
  const auth = new OwnerAuth(s.dir, () => NOW);
  const server = createSaraServer({ app: s.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  // Off the record: no run at all, so nothing to branch.
  const off = await (await api('/api/conversations', 'POST', { offRecord: true })).json();
  s.app.script.push([...text('Between us.'), usage(10, 2)]);
  await (await api(`/api/conversations/${off.id}/messages`, 'POST', { content: 'keep this off the record' })).text();
  assert.equal(s.runs.stats().runs, 0);
  assert.equal((await api('/api/runs/1/branch', 'POST', { fromStep: 0 })).status, 404);
  // A recorded reply, branched through the route (server-sent events), then compared.
  const conv = await (await api('/api/conversations', 'POST', {})).json();
  s.app.script.push([call('r1', 'shell', { command: 'ls' }), usage(100, 10)], [...text('Listed the files.'), usage(120, 12)]);
  await (await api(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'list the files' })).text();
  const id = (await (await api(`/api/runs?conversationId=${conv.id}`)).json()).runs[0].id;
  const info = await (await api(`/api/runs/${id}/steps/1/branch`)).json();
  assert.equal(info.message, 'list the files');
  assert.equal(info.tools[0].callId, 'r1');
  assert.equal((await api(`/api/runs/${id}/branch`, 'POST', { fromStep: 'x' })).status, 400);
  s.app.script.push([...text('Listed them again.'), usage(110, 9)]);
  const res = await api(`/api/runs/${id}/branch`, 'POST', { fromStep: 1, edits: { toolResults: [{ callId: 'r1', output: 'a.txt b.txt' }] } });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
  const body = await res.text();
  const evs = body.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l!.slice(6)));
  const first = evs.find((e) => e.type === 'branch');
  assert.ok(first?.runId);
  assert.ok(evs.some((e) => e.type === 'branch_done' && e.outcome.answer === 'Listed them again.'));
  const one = await (await api(`/api/runs/${id}`)).json();
  assert.equal(one.branches[0].id, first.runId);
  const diff = await (await api(`/api/runs/${id}/diff/${first.runId}`)).json();
  assert.equal(diff.sharedUntil, 1);
  assert.match(diff.line, /^The branch used /);
  // The branch's own step view rebuilds its prompt from its run record.
  const st = await (await api(`/api/runs/${first.runId}/steps/1`)).json();
  assert.ok(st.prompt.history.some((m: { role: string; content: string }) => m.role === 'tool' && m.content.includes('a.txt b.txt')));
  // Use this answer through the route; the conversation gets it once.
  assert.equal((await api(`/api/runs/${first.runId}/use`, 'POST', {})).status, 200);
  assert.equal((await api(`/api/runs/${first.runId}/use`, 'POST', {})).status, 409);
  // A household member: their run view is read only; every branch action is the owner's.
  const member = { id: 'ana', name: 'Ana', status: 'active', limits: { voice: true, pictures: true } } as unknown as MemberRecord;
  assert.equal(memberRouteCheck(member, 'GET', ['runs', String(id)]), undefined);
  for (const a of BRANCH_ACTIONS) {
    const r = memberRouteCheck(member, a === 'diff' ? 'GET' : 'POST', ['runs', String(id), a, ...(a === 'diff' ? ['2'] : [])]);
    assert.equal(r?.status, 403, a);
    assert.equal(r?.ownerOnly, true);
  }
  assert.equal(memberRouteCheck(member, 'GET', ['runs', String(id), 'steps', '1', 'branch'])?.status, 403);
});

test('a private conversation branches only on local models; the diff helpers are right', async (t) => {
  const s = setup(t);
  s.app.settings.update({ routes: { private: { providerId: 'loc', model: 'small' } } });
  const conv = s.app.store.createConversation({ private: true });
  s.app.script.push([...text('Private answer.'), usage(10, 2)]);
  await drain(runTurn(s.app, conv.id, 'a private question'));
  const [run] = s.runs.list({ conversationId: conv.id });
  await assert.rejects(replayRun(s.app, run.id, { fromStep: 0, model: { providerId: 'p', model: 'm' } }), (e) => e instanceof ReplayError && /private/.test(e.message));
  assert.ok(branchInfo(s.app, run.id, 0).models.every((m) => m.providerId === 'loc'));
  s.app.script.push([...text('Private again.'), usage(10, 2)]);
  const out = await replayRun(s.app, run.id, { fromStep: 0 });
  assert.equal(out.status, 'ok');
  assert.equal(s.app.requests.at(-1)!.model, 'small');
  // Diff helpers.
  const join2 = (ops: { t: string; s: string }[], keep: string) => ops.filter((o) => o.t === '=' || o.t === keep).map((o) => o.s).join('');
  const a = 'the quick brown fox jumps over the lazy dog';
  const b = 'the quick red fox leaps over the lazy dog today';
  const ops = diffWords(a, b);
  assert.equal(join2(ops, '-'), a);
  assert.equal(join2(ops, '+'), b);
  assert.deepEqual(diffTokens(['a', 'b', 'c'], ['a', 'x', 'c']).map((o) => o.t), ['=', '-', '+', '=']);
  assert.equal(unifiedDiff('x', 'one\ntwo\n', 'one\ntwo\n'), '');
  assert.equal(unifiedDiff('x.ts', 'a\nb\nc\n', 'a\nB\nc\n'), '--- a/x.ts\n+++ b/x.ts\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n ');
});

test('speed: step N of a turn in a 2,000-message conversation is rebuilt in well under 100 ms', async (t) => {
  const s = setup(t);
  // Phase 123: a chat this full would be tidied before the turn (one cheap call from the script);
  // this test measures rebuilding a step, so automatic tidying is off here.
  s.app.settings.update({ lean: { compact: { auto: false } } } as never);
  const conv = s.app.store.createConversation({ mode: 'chat' });
  const ins = s.app.store.db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  s.app.store.db.exec('BEGIN');
  for (let i = 0; i < 2000; i++) ins.run(conv.id, i % 2 ? 'assistant' : 'user', `message ${i} ${'words '.repeat(20)}`, NOW.toISOString());
  s.app.store.db.exec('COMMIT');
  s.app.script.push([call('c1', 'shell', { command: 'ls' }), usage(10, 1)], [...text('ok'), usage(10, 1)]);
  await drain(runTurn(s.app, conv.id, 'one more'));
  const [run] = s.runs.list({ conversationId: conv.id });
  rebuildStep(s.app, run.id, 1);
  const t0 = performance.now();
  const N = 10;
  for (let i = 0; i < N; i++) assert.equal(rebuildStep(s.app, run.id, 1).exact, true);
  const ms = (performance.now() - t0) / N;
  console.log(`rebuild of step 1 (2,000 messages): ${ms.toFixed(1)} ms`);
  assert.ok(ms < 100, `${ms} ms`);
  assert.ok(existsSync(s.dir));
});
