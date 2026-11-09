// Phase 84 (harness track M9, docs/design/HARNESS_TRACK.md §3 M9): the eval loop. Tasks picked from
// the owner's own recorded runs (eligibility, freezing, private / off the record left out), the
// estimate and the hard ceiling, the parallel cap, each variant replayed through replayRun with a
// fake provider, the scoring math and the sign test (no winner unless significant), the judge
// (positions swapped, quotes required), apply + the settings history, the real workspace and
// conversation untouched, stop, the routes and member isolation, "Re-check monthly" off by default.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { checkVote, ceilingFor, DEFAULT_SCHEDULE, evalSchedule, Evals, judgeOutcome, pairParts, scoreEval, signTest, similarity, testCounts, weighted, WEIGHTS, type EvalRunRow, type EvalTask, type VariantSpec } from '../src/evals.ts';
import { memberRouteCheck, OWNER_SETTINGS, type MemberRecord } from '../src/household.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { SandboxGate, sandboxGateSettings } from '../src/sandbox-run.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { priceTable, UsageStore } from '../src/usage.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const usage = (input: number, output: number): StreamEvent => ({ type: 'usage', input, output });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Brain = (req: ChatRequest) => StreamEvent[];
interface Setup {
  app: TestApp;
  runs: RunStore;
  evals: Evals;
  dir: string;
  brains: Record<string, Brain>;
  live: { now: number; max: number; delay: number; calls: number };
}

const lastUserIdx = (req: ChatRequest) => {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i].role === 'user') return i;
  return -1;
};
const sawTool = (req: ChatRequest) => req.messages.slice(lastUserIdx(req)).some((m) => m.role === 'tool');
/** A coding model that sets `value` to n (one write, then the answer). */
const coder =
  (n: number, words = `Done: value is ${n} now.`): Brain =>
  (req) =>
    sawTool(req) ? [{ type: 'text', text: words }, usage(1200, 50)] : [{ type: 'tool_call', call: { id: `w${n}-${Math.random().toString(36).slice(2, 7)}`, name: 'write_file', arguments: { path: 'src/value.js', content: `export const value = ${n};\n` } } }, usage(1000, 100)];

function setup(t: { after: (fn: () => void) => void }): Setup {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  app.usage = new UsageStore(app.store.db, () => NOW);
  app.usage.prices = () => priceTable(app.settings.get().prices);
  const runs = new RunStore(app.store.db, () => NOW);
  runs.usage = app.usage;
  runs.settings = () => runSettings(app.settings.get());
  app.runs = runs;
  const brains: Record<string, Brain> = { orig: coder(42), good: coder(42), bad: coder(41) };
  const live = { now: 0, max: 0, delay: 0, calls: 0 };
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    async listModels() {
      return Object.keys(brains);
    },
    async *stream(req: ChatRequest) {
      live.calls++;
      live.now++;
      live.max = Math.max(live.max, live.now);
      try {
        if (live.delay) await sleep(live.delay);
        if (req.signal?.aborted) throw new Error('aborted');
        for (const ev of (brains[req.model] ?? (() => [{ type: 'text', text: 'ok' } as StreamEvent, usage(10, 2)]))(req)) yield ev;
      } finally {
        live.now--;
      }
    },
  });
  const write: Tool = {
    spec: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: (a) => `write ${String(a.path)}`,
    async run(a, ctx) {
      const p = join(ctx.workspaceDir, String(a.path));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, String(a.content));
      return `Wrote ${String(a.path)}`;
    },
  };
  // A tool that always asks first: an eval must answer it No (nobody is watching).
  const deploy: Tool = { spec: { name: 'deploy', description: 'deploy', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => 'deploy', run: async () => 'deployed' };
  app.tools.add(write);
  app.tools.add(deploy);
  app.settings.update({
    providers: [
      { id: 'loc', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
      { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
    ],
    defaultProviderId: 'loc',
    defaultModel: 'orig',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    toolPermissions: { write_file: 'auto' },
    prices: [{ model: 'paid', inPerM: 1, outPerM: 2 }],
  });
  const evals = new Evals(app);
  app.evals = evals;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, runs, evals, dir, brains, live };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** One recorded coding turn ("set value to 42"), then the owner's reaction. */
async function seed(s: Setup, opts: { mode?: 'coding' | 'chat'; reaction?: string; private?: boolean; title?: string } = {}) {
  const conv = s.app.store.createConversation({ mode: opts.mode ?? 'coding', title: opts.title ?? 'Value', ...(opts.private ? { private: true } : {}) });
  const evs = await drain(runTurn(s.app, conv.id, 'set value to 42'));
  assert.ok(evs.some((e) => e.type === 'done'), JSON.stringify(evs.filter((e) => e.type === 'error')));
  if (opts.reaction) s.app.store.addMessage(conv.id, 'user', opts.reaction);
  const [run] = s.runs.list({ conversationId: conv.id });
  return { conv, run };
}

function project(s: Setup): string {
  const ws = workspaceDir(s.app.dataDir, 'main');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(ws, 'test'), { recursive: true });
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(ws, 'src', 'value.js'), 'export const value = 0;\n');
  writeFileSync(join(ws, 'test', 'value.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.js';\ntest('value', () => assert.equal(value, 42));\n");
  return ws;
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

async function finish(s: Setup) {
  await s.evals.work;
}

test('task picking: the last N eligible turns, frozen; private, partner, nothing-to-grade and everyday left out; off the record has no run', async (t) => {
  const s = setup(t);
  await seed(s, { reaction: 'thanks, that works' });
  await seed(s, { reaction: 'no, that is wrong: use 43' });
  await seed(s); // nothing to grade (no tests, no reaction) without the judge
  await seed(s, { mode: 'chat', reaction: 'thanks!' }); // everyday
  await seed(s, { private: true, reaction: 'perfect' });
  const partner = s.app.store.createConversation({ mode: 'coding', partner: 'Sam' });
  await drain(runTurn(s.app, partner.id, 'hi'));
  // Off the record: the app has no run store there, so the turn leaves nothing to pick.
  const before = s.runs.stats().runs;
  const off = { ...s.app, runs: undefined } as TestApp;
  const offConv = s.app.store.createConversation({ mode: 'coding' });
  await drain(runTurn(off, offConv.id, 'secret'));
  assert.equal(s.runs.stats().runs, before);

  // A cloud variant: the private conversation is left out.
  const cloud = s.evals.create({ kind: 'coding', count: 20, variants: [{ model: { providerId: 'cloud', model: 'paid' } }] });
  assert.equal(cloud.tasks.length, 2);
  assert.deepEqual(cloud.tasks.map((x) => x.feedback.kind).sort(), ['accepted', 'corrected']);
  assert.equal(cloud.skipped.private, 1);
  assert.equal(cloud.skipped['nothing to grade'], 1);
  assert.equal(cloud.skipped['someone else'], 1);
  assert.equal(cloud.tasks.find((x) => x.feedback.kind === 'corrected')!.feedback.quote, 'no, that is wrong: use 43');
  // Local only: the private one is in; with the judge on, the ungraded one too; count is honoured.
  const local = s.evals.create({ kind: 'coding', count: 20, variants: [{ model: { providerId: 'loc', model: 'good' } }], judge: true });
  assert.equal(local.tasks.length, 4);
  assert.ok(local.tasks.some((x) => x.private));
  assert.equal(s.evals.create({ kind: 'coding', count: 1, variants: [{ budget: 'tight' }], judge: true }).tasks.length, 1);
  // Everyday only.
  const day = s.evals.create({ kind: 'everyday', count: 20, variants: [{ budget: 'roomy' }] });
  assert.equal(day.tasks.length, 1);
  assert.equal(day.tasks[0].coding, false);
  // Frozen: a newer turn doesn't change a re-run's tasks.
  await seed(s, { reaction: 'great, thanks' });
  const again = s.evals.create({ from: cloud.id });
  assert.deepEqual(again.tasks.map((x) => x.runId), cloud.tasks.map((x) => x.runId));
  assert.deepEqual(again.variants, cloud.variants);
  assert.equal(s.evals.create({ kind: 'coding', count: 20, variants: [{ model: { providerId: 'cloud', model: 'paid' } }] }).tasks.length, 3);
  // A variant must change something; at most 3; the control is always first.
  assert.throws(() => s.evals.create({ kind: 'coding', variants: [{}] }), /change at least one/);
  assert.throws(() => s.evals.create({ kind: 'coding', variants: [] }), /at least one variant/);
  assert.equal(s.evals.create({ kind: 'coding', variants: [{ budget: 'tight' }, { budget: 'roomy' }, { sandbox: 'off' }, { sandbox: 'every' }] }).variants.length, 4);
});

test('estimate up front and a hard total ceiling that stops the eval at it', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 3; i++) await seed(s, { reaction: 'thanks, works' });
  const ev = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'good' } }], concurrency: 1 });
  // Each original run: 1000+100 then 1200+50 tokens; 3 tasks × 2 runs.
  assert.equal(ev.estimate.tokens, 3 * 2 * 2350);
  assert.equal(ev.estimate.paid, false);
  assert.equal(ev.estimate.usd, 0);
  assert.equal(ev.ceiling.tokens, ceilingFor(ev.estimate.tokens));
  assert.ok(ev.ceiling.tokens >= ev.estimate.tokens * 1.5);
  // A paid variant is priced.
  const paid = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'cloud', model: 'paid' } }] });
  assert.equal(paid.estimate.paid, true);
  assert.ok((paid.estimate.usd ?? 0) > 0);
  assert.ok((paid.ceiling.usd ?? 0) > 0);
  // Start needs a ceiling in range.
  assert.throws(() => s.evals.start(ev.id, { ceiling: { tokens: 10 } }), /between 1,000/);
  s.evals.start(ev.id, { ceiling: { tokens: 5000 } });
  await finish(s);
  const done = s.evals.store.get(ev.id)!;
  assert.equal(done.status, 'ceiling');
  assert.ok(done.progress.ceilingHit);
  assert.ok(done.progress.tokens <= 5000, `spent ${done.progress.tokens}`);
  assert.ok(s.evals.store.runs(ev.id).length < 6);
  assert.throws(() => s.evals.start(ev.id), /already run/);
});

test('runs in parallel up to the cap, each variant through replayRun (a branch from step 0 on its model)', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 2; i++) await seed(s, { reaction: 'thanks, works' });
  s.live.delay = 25;
  s.live.max = 0;
  const ev = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'bad' } }], concurrency: 2 });
  s.evals.start(ev.id);
  await finish(s);
  assert.equal(s.live.max, 2, 'two at once');
  const rows = s.evals.store.runs(ev.id);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    const run = s.runs.get(r.runId!)!;
    const task = ev.tasks[r.task];
    assert.equal(run.parentRunId, task.runId);
    assert.equal(run.branchedFromStep, 0);
    assert.equal(run.branch?.model, r.variant === 'control' ? 'loc/orig' : 'loc/bad');
    assert.deepEqual(run.branch?.eval, { id: ev.id, task: r.task, variant: r.variant });
    assert.equal(r.status, 'ok');
    assert.equal(r.steps, 2);
    assert.match(r.answer, r.variant === 'control' ? /42/ : /41/);
    // The real workspace already has 42 (the original turn): the control changes nothing, 41 changes the file.
    assert.deepEqual(r.files.map((f) => f.path), r.variant === 'control' ? [] : ['src/value.js']);
  }
  // The cap of one.
  s.live.max = 0;
  const one = s.evals.create({ from: ev.id, concurrency: 1 });
  s.evals.start(one.id);
  await finish(s);
  assert.equal(s.live.max, 1);
  // Retention keeps the eval's runs.
  assert.match(s.runs.keepAlso ?? '', /eval_runs/);
});

test('scoring: weights scaled over the parts present; tests, findings and cost count; the sign test', () => {
  // Weights add up to 1 and the score is the weighted mean of the parts present.
  assert.equal(Math.round(Object.values(WEIGHTS).reduce((a, b) => a + b, 0) * 1000) / 1000, 1);
  assert.equal(weighted({ tests: 1, done: 1 }), 1);
  assert.ok(Math.abs(weighted({ tests: 0, done: 1 }) - 0.1 / 0.45) < 1e-12);
  const task = { feedback: { kind: 'accepted' as const }, answer: 'Done: value is 42 now.' };
  const row = (o: Partial<EvalRunRow>): EvalRunRow => ({ evalId: 1, task: 0, variant: 'v1', runId: 1, status: 'ok', tokens: 1000, usd: 0, steps: 2, ms: 1000, answer: 'Done: value is 42 now.', files: [], tests: null, findings: 0, findingList: [], denied: 0, ...o });
  const pass = { command: 'npm test', ran: true, exitCode: 0, passed: 3, failed: 0, ms: 10, isolated: false, output: '' };
  const fail = { ...pass, exitCode: 1, passed: 1, failed: 2 };
  const p = pairParts(task, row({ tests: pass, tokens: 1000 }), row({ tests: fail, tokens: 2000, findings: 3, usd: 0.02, answer: 'Done: value is 41.' }));
  assert.equal(p.control.tests, 1);
  assert.equal(p.variant.tests, 1 / 3);
  assert.equal(p.control.tokens, 1);
  assert.equal(p.variant.tokens, 0.5);
  assert.equal(p.variant.findings, 0.25);
  assert.equal(p.control.cost, 1);
  assert.equal(p.variant.cost, 0);
  assert.equal(p.control.feedback, 1);
  assert.ok(p.variant.feedback! < 1);
  assert.equal(p.control.judge, undefined);
  // Corrected: moving away from the rejected answer is better.
  const q = pairParts({ feedback: { kind: 'corrected' }, answer: 'Done: value is 42 now.' }, row({}), row({ answer: 'Set it to 43 instead.' }));
  assert.ok(q.variant.feedback! > q.control.feedback!);
  // Tests count only when both sides ran them.
  assert.equal(pairParts(task, row({ tests: pass }), row({})).control.tests, undefined);
  assert.equal(similarity('value is 42', 'value is 42'), 1);
  assert.deepEqual(testCounts('ℹ tests 3\nℹ pass 2\nℹ fail 1\n'), { passed: 2, failed: 1 });
  assert.deepEqual(testCounts('==== 4 passed, 1 failed in 0.2s'), { passed: 4, failed: 1 });
  // Exact two-sided sign test.
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(3, 2), 1);
  assert.ok(Math.abs(signTest(14, 2) - 0.0042) < 0.0001);
  assert.ok(Math.abs(signTest(6, 0) - 0.03125) < 1e-9);
  assert.equal(signTest(5, 5), 1);
  assert.ok(signTest(40, 10) < 0.0001);
});

/** Synthetic rows: `pattern` per task = 'w' (variant passes its tests, control fails), 'l', or 't'. */
function synthetic(pattern: string) {
  const tasks = [...pattern].map((_, i) => ({ idx: i, title: `task ${i}`, feedback: { kind: 'none' }, answer: '' }) as unknown as EvalTask);
  const variants: VariantSpec[] = [{ id: 'control' }, { id: 'v1', budget: 'tight' }];
  const pass = { command: 'npm test', ran: true, exitCode: 0, passed: 1, failed: 0, ms: 1, isolated: false, output: '' };
  const fail = { ...pass, exitCode: 1, passed: 0, failed: 1 };
  const rows: EvalRunRow[] = [];
  [...pattern].forEach((c, i) => {
    const base = { evalId: 1, task: i, runId: i * 2 + 1, status: 'ok', tokens: 1000, usd: 0, steps: 2, ms: 100, answer: 'x', files: [], findings: 0, findingList: [], denied: 0 };
    rows.push({ ...base, variant: 'control', tests: c === 'l' ? pass : c === 'w' ? fail : pass });
    rows.push({ ...base, variant: 'v1', runId: i * 2 + 2, tests: c === 'w' ? pass : c === 'l' ? fail : pass });
  });
  return { ev: { tasks, variants, kind: 'coding' as const }, rows };
}

test('the winner is named only when the sign test says so; "no clear winner" otherwise', () => {
  // 14 wins, 4 ties, 2 losses over 20 coding tasks: a clear winner.
  const clear = synthetic('wwwwwwwwwwwwwwttttll');
  const r = scoreEval(clear.ev, clear.rows);
  const v = r.variants[0];
  assert.deepEqual([v.wins, v.ties, v.losses, v.pairs], [14, 4, 2, 20]);
  assert.ok(v.p < 0.01 && v.significant);
  assert.equal(v.verdict, 'better');
  assert.equal(r.winner, 'v1');
  assert.ok(v.pct > 0);
  assert.match(r.headline.text, /^\+\d+% on 20 of your coding tasks \(wins 14, ties 4, losses 2; p=0\.004\)$/);
  assert.equal(r.headline.key, '{pct} on {n} of your coding tasks (wins {w}, ties {t}, losses {l}; p={p})');
  assert.equal(r.tasks[0].variants.v1.outcome, 'win');
  assert.equal(r.tasks[0].variants.v1.runId, 2);
  assert.equal(r.tasks[0].control.runId, 1);
  // 3 wins, 2 losses: no winner claimed, even though the variant's mean is higher.
  const unclear = synthetic('wwwlltttt');
  const u = scoreEval(unclear.ev, unclear.rows);
  assert.equal(u.winner, null);
  assert.equal(u.variants[0].verdict, 'unclear');
  assert.ok(u.variants[0].pct > 0);
  assert.match(u.headline.text, /^No clear winner on 9 tasks/);
  // All losses: the current settings win.
  const worse = synthetic('llllllll');
  assert.equal(scoreEval(worse.ev, worse.rows).winner, 'control');
  // With three variants the bar is 0.05 / 3: 6–0 (p≈0.031) is no longer enough.
  const three = synthetic('wwwwww');
  three.ev.variants.push({ id: 'v2', budget: 'roomy' }, { id: 'v3', sandbox: 'off' });
  const t3 = scoreEval(three.ev, three.rows);
  assert.ok(Math.abs(t3.alpha - 0.05 / 3) < 1e-12);
  assert.equal(t3.variants[0].wins, 6);
  assert.equal(t3.winner, null);
  // Missing runs don't count as pairs.
  const miss = synthetic('ww');
  miss.rows[1].status = 'error';
  assert.equal(scoreEval(miss.ev, miss.rows).variants[0].pairs, 1);
});

test('the tests signal: the project\'s tests run in a sandbox copy after each variant; a clear winner end to end', async (t) => {
  const s = setup(t);
  const ws = project(s);
  s.app.sandboxGate = new SandboxGate(join(s.dir, 'cache', 'sandbox-runs'), s.app.sandbox, () => sandboxGateSettings(s.app.settings.get()));
  for (let i = 0; i < 6; i++) await seed(s);
  const realFiles = snapshotDir(ws);
  const convs = s.app.store.listConversations().map((c) => ({ id: c.id, n: s.app.store.messages(c.id).length }));
  const ev = s.evals.create({ kind: 'coding', count: 6, variants: [{ model: { providerId: 'loc', model: 'bad' } }] });
  assert.equal(ev.tasks.length, 6);
  assert.ok(ev.tasks.every((x) => x.tests === 'npm test'));
  s.evals.start(ev.id);
  await finish(s);
  const done = s.evals.store.get(ev.id)!;
  assert.equal(done.status, 'done');
  const rows = s.evals.store.runs(ev.id);
  for (const r of rows) {
    assert.ok(r.tests?.ran, JSON.stringify(r.tests));
    assert.equal(r.tests!.exitCode === 0, r.variant === 'control', `${r.variant}: ${r.tests!.output.slice(-300)}`);
  }
  // The control (current settings) beats the variant on all 6: 6–0 is significant at 0.05.
  assert.equal(done.result!.winner, 'control');
  assert.equal(done.result!.variants[0].losses, 6);
  // Never touched: the real workspace and the conversations.
  assert.deepEqual(snapshotDir(ws), realFiles);
  assert.deepEqual(s.app.store.listConversations().map((c) => ({ id: c.id, n: s.app.store.messages(c.id).length })), convs);
  // The copies are gone.
  const copies = join(s.dir, 'cache', 'branch-runs');
  for (const r of rows) assert.ok(!readdirSync(copies).includes(String(r.runId)), `copy of ${r.runId} removed`);
});

test('approvals during an eval are answered No and counted; findings on changed files count', async (t) => {
  const s = setup(t);
  await seed(s, { reaction: 'thanks, works' });
  s.brains.risky = (req) => (sawTool(req) ? [{ type: 'text', text: 'I tried.' }, usage(100, 10)] : [{ type: 'tool_call', call: { id: 'd1', name: 'deploy', arguments: {} } }, { type: 'tool_call', call: { id: 'd2', name: 'write_file', arguments: { path: 'src/db.js', content: 'export const q = (id) => db.query("SELECT * FROM users WHERE id = " + id);\n' } } }, usage(100, 10)]);
  const ev = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'risky' } }] });
  s.evals.start(ev.id);
  await finish(s);
  const r = s.evals.store.runs(ev.id).find((x) => x.variant === 'v1')!;
  assert.equal(r.denied, 1);
  const step = s.runs.steps(r.runId!).find((x) => x.tools.some((y) => y.name === 'deploy'))!;
  assert.equal(step.tools.find((y) => y.name === 'deploy')!.status, 'denied');
  assert.ok(r.findings >= 1, JSON.stringify(r.findingList));
  assert.equal(r.findingList[0].file, 'src/db.js');
});

test('the judge: positions swapped, a quote from the picked answer required', async (t) => {
  // Pure checks first.
  const a = 'Done: value is 42 now.';
  const b = 'Done: value is 41.';
  assert.equal(checkVote('{"better":"A","quote":"value is 42 now","why":"right"}', a, b).valid, true);
  assert.equal(checkVote('{"better":"A","quote":"value is 99 now","why":"made up"}', a, b).dropped, 'quote not in the answer');
  assert.equal(checkVote('{"better":"B","quote":"41"}', a, b).dropped, 'no quote');
  assert.equal(checkVote('nonsense', a, b).valid, false);
  const ok = (pick: 'A' | 'B') => ({ pick, valid: true });
  assert.equal(judgeOutcome(ok('B'), ok('A')), 'win');
  assert.equal(judgeOutcome(ok('A'), ok('B')), 'loss');
  assert.equal(judgeOutcome(ok('A'), ok('A')), 'tie', 'always the first position = position bias, no preference');
  assert.equal(judgeOutcome({ pick: 'B', valid: false }, ok('A')), 'tie');
  // Live through the runner with a fake Reviewing model.
  const s = setup(t);
  await seed(s);
  await seed(s);
  s.app.settings.update({ routes: { review: { providerId: 'loc', model: 'judge' } } });
  let mode: 'fair' | 'biased' | 'liar' = 'fair';
  s.brains.judge = (req) => {
    const u = String(req.messages.at(-1)?.content ?? '');
    const A = /Answer A:\n([\s\S]*?)\n\nAnswer B:/.exec(u)![1];
    const B = /Answer B:\n([\s\S]*)$/.exec(u)![1];
    const pick = mode === 'biased' ? 'A' : A.includes('42') ? 'A' : 'B';
    const quote = mode === 'liar' ? 'value is 42 for sure' : (pick === 'A' ? A : B).slice(6, 22);
    return [{ type: 'text', text: JSON.stringify({ better: pick, quote, why: 'checked' }) }, usage(200, 20)];
  };
  const runOnce = async () => {
    const ev = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'bad' } }], judge: true });
    s.evals.start(ev.id);
    await finish(s);
    return s.evals.store.runs(ev.id).filter((r) => r.variant === 'v1');
  };
  const fair = await runOnce();
  assert.ok(fair.every((r) => r.judge?.outcome === 'loss'), JSON.stringify(fair.map((r) => r.judge)));
  assert.deepEqual(fair[0].judge!.votes.map((v) => v.order), ['control-first', 'variant-first']);
  assert.ok(fair[0].judge!.votes.every((v) => v.valid && v.quote));
  mode = 'biased';
  assert.ok((await runOnce()).every((r) => r.judge?.outcome === 'tie'));
  mode = 'liar';
  const liar = await runOnce();
  assert.ok(liar.every((r) => r.judge?.outcome === 'tie' && r.judge.votes.every((v) => v.dropped === 'quote not in the answer')));
});

test('apply writes the settings and a line in the settings history; Keep mine records the choice only', async (t) => {
  const s = setup(t);
  await seed(s, { reaction: 'thanks, works' });
  const ev = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'good' }, memory: { preset: 'custom', halfLifeDays: 90 }, sandbox: 'every', budget: 'tight' }] });
  assert.throws(() => s.evals.apply(ev.id, { variant: 'v1' }), /no result yet/);
  s.evals.start(ev.id);
  await finish(s);
  assert.throws(() => s.evals.apply(ev.id, { variant: 'nope' }), /Pick one of the variants/);
  const out = s.evals.apply(ev.id, { variant: 'v1' });
  const st = s.app.settings.get();
  assert.deepEqual({ providerId: st.routes!.coding!.providerId, model: st.routes!.coding!.model }, { providerId: 'loc', model: 'good' });
  assert.equal(st.memory!.fade, 'custom');
  assert.equal(st.memory!.decay!.halfLifeDays, 90);
  assert.equal(sandboxGateSettings(st).mode, 'every');
  assert.equal((st.turnBudgets as { coding: { tokens: number } }).coding.tokens, 50_000);
  assert.deepEqual(out.changes.map((c) => c.key).sort(), ['memory.fade', 'routes.coding', 'sandboxGate.mode', 'turnBudgets.coding']);
  const h = s.evals.store.history();
  assert.equal(h[0].ref, ev.id);
  assert.equal(h[0].source, 'eval');
  assert.match(h[0].what, /Eval #\d+: used/);
  assert.equal(s.evals.store.get(ev.id)!.applied!.variant, 'v1');
  const before = JSON.stringify(s.app.settings.get());
  s.evals.apply(ev.id, { keep: true });
  assert.equal(JSON.stringify(s.app.settings.get()), before);
  assert.equal(s.evals.store.get(ev.id)!.applied!.kept, true);
  assert.equal(s.evals.store.history()[0].changes.length, 0);
});

test('stop ends a running eval; finished pairs are still scored', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 4; i++) await seed(s, { reaction: 'thanks, works' });
  s.live.delay = 60;
  const ev = s.evals.create({ kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'good' } }], concurrency: 1 });
  s.evals.start(ev.id);
  assert.throws(() => s.evals.start(s.evals.create({ from: ev.id }).id), /Another eval is running/);
  await sleep(400);
  assert.equal(s.evals.stop(ev.id), true);
  await finish(s);
  const done = s.evals.store.get(ev.id)!;
  assert.equal(done.status, 'stopped');
  assert.ok(s.evals.store.runs(ev.id).length < 8);
  assert.ok(done.result);
  assert.equal(s.evals.stop(ev.id), false);
});

test('"Re-check monthly" is off by default; on, it waits for an idle hour and a month', async (t) => {
  assert.equal(DEFAULT_SCHEDULE.monthly, false);
  assert.equal(evalSchedule({}).monthly, false);
  assert.ok(OWNER_SETTINGS.includes('evalSchedule'));
  const s = setup(t);
  await seed(s, { reaction: 'thanks, works' });
  const ev = s.evals.create({ kind: 'coding', variants: [{ budget: 'roomy' }] });
  s.evals.start(ev.id);
  await finish(s);
  s.evals.lastActivity = () => 0;
  assert.equal(s.evals.tick(), undefined, 'off: nothing runs');
  s.app.settings.update({ evalSchedule: { monthly: true, budgetTokens: 50_000 } });
  s.evals.lastActivity = () => NOW.getTime() - 60_000;
  assert.equal(s.evals.tick(), undefined, 'not idle');
  s.evals.lastActivity = () => 0;
  const id = s.evals.tick();
  assert.ok(id);
  await finish(s);
  const m = s.evals.store.get(id!)!;
  assert.equal(m.options.scheduled, true);
  assert.ok(m.ceiling.tokens <= 50_000);
  assert.equal(s.evals.tick(), undefined, 'once a month');
});

test('routes: create (estimate), confirm to start, live result, apply; owner-only (members 403), demo refused', async (t) => {
  const s = setup(t);
  await seed(s, { reaction: 'thanks, works' });
  const auth = new OwnerAuth(s.dir, () => NOW);
  const server = createSaraServer({ app: s.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + path, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const list = await api('/api/evals');
  assert.equal(list.status, 200);
  assert.ok(list.json.choices.models.some((m: { model: string; local: boolean }) => m.model === 'orig' && m.local));
  assert.equal(list.json.schedule.monthly, false);
  assert.deepEqual(list.json.weights, WEIGHTS);
  assert.equal((await api('/api/evals', 'POST', { kind: 'coding', variants: [{}] })).status, 400);
  const made = await api('/api/evals', 'POST', { kind: 'coding', variants: [{ model: { providerId: 'loc', model: 'good' } }] });
  assert.equal(made.status, 201);
  const id = made.json.eval.id;
  assert.ok(made.json.eval.estimate.tokens > 0);
  assert.equal((await api(`/api/evals/${id}/start`, 'POST', {})).status, 400, 'needs the owner\'s confirm');
  assert.equal((await api(`/api/evals/${id}/start`, 'POST', { confirm: true, ceiling: { tokens: 100_000 } })).status, 202);
  await finish(s);
  const one = await api(`/api/evals/${id}`);
  assert.equal(one.json.eval.status, 'done');
  assert.equal(one.json.runs.length, 2);
  assert.ok(one.json.eval.result.headline.key);
  assert.equal((await api(`/api/evals/${id}/stop`, 'POST', {})).status, 404);
  assert.equal((await api(`/api/evals/${id}/apply`, 'POST', { keep: true })).status, 200);
  assert.equal((await api('/api/evals/schedule', 'PUT', { budgetTokens: 7 })).status, 400);
  assert.equal((await api('/api/evals/schedule', 'PUT', { monthly: true, budgetTokens: 100_000 })).json.monthly, true);
  assert.equal((await api('/api/evals/x')).status, 404);
  // Members: the whole family is the owner's.
  const member = { id: 'ana', name: 'Ana', status: 'active', limits: { voice: true, pictures: true } } as unknown as MemberRecord;
  for (const [m, p] of [['GET', ['evals']], ['POST', ['evals']], ['GET', ['evals', '1']], ['POST', ['evals', '1', 'start']], ['POST', ['evals', '1', 'apply']], ['PUT', ['evals', 'schedule']]] as [string, string[]][]) {
    const r = memberRouteCheck(member, m, p);
    assert.equal(r?.status, 403);
    assert.equal(r?.ownerOnly, true);
  }
  // The demo: not a demo read.
  assert.match(readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8'), /const DEMO_READS = new Set\(\[(?![^\]]*'evals')/);
});

test('the Evals window: owner-only place in the sidebar, tips, translations, no inline styles, ES modules parse, a fresh app cache', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const html = web('index.html');
  assert.match(html, /data-dest="evals" data-owner-only><button class="side-go" id="open-evals"/);
  assert.match(html, /<dialog id="evals" aria-label="Evals">/);
  for (const id of ['ev-kind', 'ev-count', 'ev-judge', 'ev-conc', 'ev-variants', 'ev-estimate', 'ev-draft', 'ev-list', 'ev-detail', 'ev-monthly', 'ev-mbudget', 'ev-history']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<select id="ev-monthly"><option value="off">Off<\/option>/, 'monthly re-check: Off first (the default)');
  // V3 (docs/ops/V3_DESIGN.md §2): Add-ons came after Evals.
  assert.match(web('nav.js'), /'findings', 'evals', 'addons'\]/);
  const view = web('evals-view.js');
  assert.doesNotMatch(view, /style=|\.style\./, 'no inline styles');
  assert.match(view, /openDiffSheet\(tr\.control\.runId, x\.runId/, 'each pair links to the M8 diff');
  assert.match(view, /confirm\(t\('Once a month/, 'switching the monthly check on needs an explicit yes');
  assert.match(web('app.js'), /es\.addEventListener\('eval'/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of ['Evals', 'Use this setting', 'Keep mine', 'Re-check monthly', 'Hard ceiling', '{pct} on {n} of your coding tasks (wins {w}, ties {t}, losses {l}; p={p})', 'No clear winner: no task finished in both runs.']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.notEqual(d[k], k, `${lang}: ${k} is translated`);
    }
  }
  const { dir, cleanup } = tempDir();
  try {
    for (const f of ['app.js', 'evals-view.js', 'nav.js']) {
      const copy = join(dir, f.replace(/\.js$/, '.mjs'));
      writeFileSync(copy, web(f));
      const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  } finally {
    cleanup();
  }
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v17'\)[\s\S]*sara-shell-v16 from Phase 83/);
  assert.ok(existsSync(join(ROOT, 'web', 'evals-view.js')));
  assert.match(web('help.html'), /<h2 id="evals">/);
});
