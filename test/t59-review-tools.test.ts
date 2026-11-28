// T59: the review of her change with read-only tools and her tests again in a copy (src/review-tools.ts).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { DEFAULT_PRECISE, mergePrecise, preciseSettings } from '../src/diagnostics.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { runToolReview, testsInCopy, TOOL_REVIEW } from '../src/review-tools.ts';
import { SandboxGate } from '../src/sandbox-run.ts';
import { resetEditGuard } from '../src/tools/edit-guard.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const NONE = { mode: 'none', network: false, detail: 'test' } as const;

const fakeChoice = (script: (req: ChatRequest, n: number) => StreamEvent[]) => {
  let n = 0;
  const reqs: ChatRequest[] = [];
  const provider: Provider = {
    config: { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' },
    listModels: async () => ['strong'],
    async *stream(req: ChatRequest) {
      reqs.push(structuredClone({ ...req, signal: undefined }));
      yield* script(req, ++n);
    },
  };
  return { choice: { provider, model: 'strong', from: 'review' as never }, reqs };
};

test('T59: off by default, and the setting saves', () => {
  assert.equal(DEFAULT_PRECISE.checks.reviewTools, false);
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  try {
    assert.equal(preciseSettings(app).checks.reviewTools, false);
    const next = mergePrecise(app, { checks: { reviewTools: true } });
    assert.equal(next.checks.reviewTools, true);
    app.settings.update({ precise: next } as never);
    assert.equal(preciseSettings(app).checks.reviewTools, true);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('T59: the reviewer reads files, runs the tests, and answers with ISSUE lines; nothing else is offered', async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, 'SPEC.md'), 'Names are sorted by surname, then first name.\n');
    writeFileSync(join(dir, 'names.js'), 'export const sortNames = (a) => a.sort();\n');
    const ran: string[] = [];
    const { choice, reqs } = fakeChoice((req, n) => {
      if (n === 1) return [call('a', 'read_file', { path: 'SPEC.md' }), call('b', 'search', { pattern: 'sort' })];
      if (n === 2) return [call('c', 'run_tests', {})];
      if (n === 3) return [call('d', 'write_file', { path: 'names.js', content: 'x' })];
      return text('ISSUE: "sorted by surname, then first name" | sortNames sorts by the whole string, so first names decide the order');
    });
    const r = await runToolReview({ choice, material: '## The request\nSort the names', workspaceDir: dir, sandbox: NONE, testCommand: 'node --test', runTests: async () => (ran.push('t'), '[exit code 0]\n# pass 2') });
    assert.equal(r.steps, 4);
    assert.equal(r.testRuns, 1);
    assert.equal(ran.length, 1);
    assert.match(r.text, /^ISSUE: "sorted by surname/);
    assert.deepEqual(reqs[0]!.tools!.map((t) => t.name), ['list_dir', 'read_file', 'search', 'run_tests']);
    assert.match(String(reqs[0]!.messages[0]!.content), /run_tests runs the developer's test command \(node --test\)/);
    const results = reqs[3]!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(results[0]!, /1\| Names are sorted by surname/);
    assert.match(results[1]!, /names\.js:1:/);
    assert.match(results[2]!, /# pass 2/);
    assert.match(results[3]!, /There is no tool named write_file/);
    assert.equal(readFileSync(join(dir, 'names.js'), 'utf8'), 'export const sortNames = (a) => a.sort();\n', 'the reviewer never writes');
  } finally {
    cleanup();
  }
});

test('T59: the step limit holds; the last step has no tools; the tests run at most twice', async () => {
  const { dir, cleanup } = tempDir();
  try {
    let runs = 0;
    const { choice, reqs } = fakeChoice((req) => (req.tools ? [call(`x${Math.random()}`, 'run_tests', {})] : text('OK')));
    const r = await runToolReview({ choice, material: 'm', workspaceDir: dir, sandbox: NONE, runTests: async () => `run ${++runs}` });
    assert.equal(reqs.length, TOOL_REVIEW.steps);
    assert.equal(reqs.at(-1)!.tools, undefined);
    assert.match(String(reqs.at(-1)!.messages.at(-1)!.content), /no steps left/);
    assert.equal(runs, TOOL_REVIEW.testRuns);
    assert.equal(r.text, 'OK');
    // Without a test runner there is no run_tests tool.
    const b = fakeChoice(() => text('OK'));
    await runToolReview({ choice: b.choice, material: 'm', workspaceDir: dir, sandbox: NONE });
    assert.deepEqual(b.reqs[0]!.tools!.map((t) => t.name), ['list_dir', 'read_file', 'search']);
  } finally {
    cleanup();
  }
});

test('T59: the tests run in a throwaway copy: what they write never reaches the workspace', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const ws = join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'a.txt'), 'kept\n');
    const gate = new SandboxGate(join(dir, 'cache', 'sandbox-runs'), NONE, () => ({ mode: 'risky', network: false, maxMB: 100, timeLimitS: 60, dockerImage: 'node:24-slim' }), () => ({ driver: 'copy', isolated: false, label: 'copy' }) as never);
    const run = testsInCopy(gate, NONE, ws)!;
    const out = await run(`node -e "require('fs').writeFileSync('made.txt','x');console.log('ran ok')"`, AbortSignal.timeout(60_000));
    assert.match(out, /ran ok/);
    assert.match(out, /exit code 0, .*in a copy/);
    assert.equal(existsSync(join(ws, 'made.txt')), false);
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'kept\n');
    assert.equal(testsInCopy(undefined, NONE, ws), undefined, 'no sandbox gate: no test runs');
  } finally {
    cleanup();
  }
});

test('T59: in a coding turn with the tools on, the Review model looks at a file she never opened and sends her the gap', async (t) => {
  resetEditGuard();
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.codeReview = true;
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'small', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', toolPermissions: { shell: 'auto' }, routes: { review: { providerId: 'p', model: 'strong' } }, precise: { checks: { review: true, reviewTools: true } } } as never);
  const conv = app.store.createConversation({ title: 'x', mode: 'coding', workspace: 'proj3' });
  const w = workspaceDir(dir, 'proj3');
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, 'SPEC.md'), 'Totals are rounded half up to the cent.\n');
  writeFileSync(join(w, 'money.js'), 'export const roundCents = (x) => Math.floor(x);\n');
  const notes: string[] = [];
  const reviewReqs: ChatRequest[] = [];
  let small = 0;
  const script = (req: ChatRequest): StreamEvent[] => {
    const sys = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (sys.includes('You review a code change against what was asked')) {
      reviewReqs.push(req);
      if (reviewReqs.length === 1) return [call('rv1', 'read_file', { path: 'SPEC.md' })];
      const seen = req.messages.some((m) => m.role === 'tool' && /rounded half up/.test(m.content));
      return text(seen ? 'ISSUE: "rounded half up to the cent" | Math.trunc drops the half instead of rounding it up' : 'OK');
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    if (lastUser && /\[Note from the app/.test(lastUser.content)) notes.push(lastUser.content);
    small++;
    // She never opens SPEC.md: the review without tools would not see the rule.
    if (small === 1) return [call('e1', 'edit_file', { path: 'money.js', old_string: 'Math.floor(x)', new_string: 'Math.trunc(x)' })];
    if (small === 2) return text('I changed the rounding.');
    if (small === 3) return [call('e2', 'edit_file', { path: 'money.js', old_string: 'Math.trunc(x)', new_string: 'Math.round(x)' })];
    return text('It now rounds half up.');
  };
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    listModels: async () => ['small', 'strong'],
    async *stream(req: ChatRequest) {
      yield* script(req);
    },
  });
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'Fix the rounding of totals')) evs.push(ev);
  assert.equal(reviewReqs.length, 2, 'one look with a tool, then the answer');
  assert.equal(reviewReqs[0]!.model, 'strong');
  assert.deepEqual(reviewReqs[0]!.tools!.map((x) => x.name), ['list_dir', 'read_file', 'search'], 'no sandbox gate in this app: no test runs');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /found one possible gap/);
  assert.match(notes[0]!, /rounded half up to the cent/);
  assert.ok(evs.some((e) => e.type === 'notice' && /reviewed the change/.test(e.text)));
  assert.equal(readFileSync(join(w, 'money.js'), 'utf8'), 'export const roundCents = (x) => Math.round(x);\n');
});

test('T60: the strong review is on by default: with a separate Review model it reads with tools and takes over; otherwise nothing changes', async (t) => {
  resetEditGuard();
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.codeReview = true;
  assert.equal(DEFAULT_PRECISE.checks.strongReview, true);
  const base = { providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'small', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', toolPermissions: { shell: 'auto' } };
  let reviews = 0;
  const by: string[] = [];
  let small = 0;
  let strong = 0;
  const script = (req: ChatRequest): StreamEvent[] => {
    const sys = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (sys.includes('You review a code change against what was asked')) {
      reviews++;
      assert.ok(req.tools?.some((x) => x.name === 'read_file'), 'the review has its tools');
      return text('ISSUE: "rounded half up to the cent" | Math.trunc drops the half instead of rounding it up');
    }
    by.push(req.model);
    if (req.model === 'small') {
      small++;
      if (small % 2 === 1) return [call(`e${small}`, 'edit_file', { path: 'money.js', old_string: 'Math.floor(x)', new_string: 'Math.trunc(x)' })];
      return text('I changed the rounding.');
    }
    strong++;
    if (strong === 1) return [call('s1', 'edit_file', { path: 'money.js', old_string: 'Math.trunc(x)', new_string: 'Math.round(x)' })];
    return text('It now rounds half up.');
  };
  app.providerFactory = (config: ProviderConfig): Provider => ({ config, listModels: async () => ['small', 'strong'], async *stream(req: ChatRequest) { yield* script(req); } });
  const turn = async (ws: string) => {
    const conv = app.store.createConversation({ title: ws, mode: 'coding', workspace: ws });
    const w = workspaceDir(dir, ws);
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, 'SPEC.md'), 'Totals are rounded half up to the cent.\n');
    writeFileSync(join(w, 'money.js'), 'export const roundCents = (x) => Math.floor(x);\n');
    reviews = 0;
    by.length = 0;
    small = 0;
    strong = 0;
    for await (const _ of runTurn(app, conv.id, 'Fix the rounding of totals')) void _;
    return readFileSync(join(w, 'money.js'), 'utf8');
  };
  // No Review model set: no review at all (the same as before).
  app.settings.update(base as never);
  await turn('a');
  assert.equal(reviews, 0);
  assert.deepEqual(by, ['small', 'small']);
  // A Review model that is the coding model: no review (it made results worse on the benchmark).
  app.settings.update({ routes: { review: { providerId: 'p', model: 'small' } } } as never);
  await turn('b');
  assert.equal(reviews, 0);
  // A separate Review model: it reviews with tools and takes over.
  app.settings.update({ routes: { review: { providerId: 'p', model: 'strong' } } } as never);
  assert.equal(await turn('c'), 'export const roundCents = (x) => Math.round(x);\n');
  assert.equal(reviews, 1);
  assert.deepEqual(by, ['small', 'small', 'strong', 'strong']);
  // Switched off in Settings → Check her edits: nothing.
  app.settings.update({ precise: { checks: { strongReview: false } } } as never);
  await turn('d');
  assert.equal(reviews, 0);
});
