// T55 (coding correctness): the stale-write guard, the syntax check after every write, and the
// done gate (tests must have run after the last change before a coding turn ends).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { DoneGate, doneGateWhy, TEST_RUN } from '../src/done-gate.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import type { Receipt } from '../src/receipts.ts';
import { editFileTool, readFileTool, writeFileTool } from '../src/tools/builtin.ts';
import { resetEditGuard, syntaxProblem } from '../src/tools/edit-guard.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, tempDir, text, type TestApp } from './helpers.ts';

function ws(t: { after: (fn: () => void) => void }) {
  resetEditGuard();
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ctx = (conversationId: string | undefined = 'c1') => ({ workspaceDir: dir, signal: new AbortController().signal, sandbox: { mode: 'none' }, ...(conversationId ? { conversationId } : {}) }) as unknown as ToolContext;
  return { dir, ctx };
}

test('T55: write_file over a file she has not read says so; a new file needs nothing', async (t) => {
  const { dir, ctx } = ws(t);
  writeFileSync(join(dir, 'a.txt'), 'the owner wrote this\n');
  assert.match(String(await writeFileTool.run({ path: 'a.txt', content: 'gone' }, ctx())), /already existed \(21 bytes\) and you had not read it/);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'gone');
  await readFileTool.run({ path: 'a.txt' }, ctx());
  assert.doesNotMatch(String(await writeFileTool.run({ path: 'a.txt', content: 'new' }, ctx())), /had not read it/);
  assert.match(String(await writeFileTool.run({ path: 'a.txt', content: 'newer' }, ctx())), /^Wrote/, 'her own write counts as seen');
  assert.match(String(await writeFileTool.run({ path: 'sub/b.txt', content: 'x' }, ctx())), /^Wrote/);
  // Another conversation has not read it.
  assert.match(String(await writeFileTool.run({ path: 'a.txt', content: 'other' }, ctx('c2'))), /had not read it/);
  // A call with no conversation (a script) is not guarded.
  assert.match(String(await writeFileTool.run({ path: 'a.txt', content: 'script' }, ctx(''))), /^Wrote/);
});

test('T55: neither tool writes into a file that changed since she read it', async (t) => {
  const { dir, ctx } = ws(t);
  const f = join(dir, 'm.js');
  writeFileSync(f, 'const a = 1;\n');
  await readFileTool.run({ path: 'm.js' }, ctx());
  // Something else (the owner's editor, a formatter) writes to it.
  writeFileSync(f, 'const a = 1;\nconst b = 2;\n');
  utimesSync(f, new Date(), new Date(Date.now() + 5_000));
  await assert.rejects(() => editFileTool.run({ path: 'm.js', old_string: 'const a = 1;', new_string: 'const a = 3;' }, ctx()), /changed since you last read it/);
  await assert.rejects(() => writeFileTool.run({ path: 'm.js', content: 'x' }, ctx()), /changed since you last read it/);
  await readFileTool.run({ path: 'm.js' }, ctx());
  assert.match(String(await editFileTool.run({ path: 'm.js', old_string: 'const a = 1;', new_string: 'const a = 3;' }, ctx())), /^Edited/);
  // edit_file on a file she never read still works: the exact old_string is the proof.
  writeFileSync(join(dir, 'n.js'), 'let n = 0;\n');
  assert.match(String(await editFileTool.run({ path: 'n.js', old_string: 'let n = 0;', new_string: 'let n = 1;' }, ctx())), /^Edited/);
});

test('T55: a write that leaves the file unparseable says so at once (JSON, JS, TS, Python)', async (t) => {
  const { dir, ctx } = ws(t);
  assert.match(String(await writeFileTool.run({ path: 'p.json', content: '{"a": 1,}' }, ctx())), /SYNTAX ERROR/);
  assert.doesNotMatch(String(await writeFileTool.run({ path: 'ok.json', content: '{"a": 1}' }, ctx())), /SYNTAX ERROR/);
  const js = String(await writeFileTool.run({ path: 'bad.mjs', content: 'export function f( {\n  return 1;\n}\n' }, ctx()));
  assert.match(js, /SYNTAX ERROR: the file as it is now does not parse: SyntaxError/);
  assert.doesNotMatch(String(await writeFileTool.run({ path: 'ok.mjs', content: 'export const f = () => 1;\n' }, ctx())), /SYNTAX ERROR/);
  writeFileSync(join(dir, 'e.mjs'), 'export function g() {\n  return 1;\n}\n');
  assert.match(String(await editFileTool.run({ path: 'e.mjs', old_string: '  return 1;\n}', new_string: '  return 1;\n' }, ctx())), /SYNTAX ERROR/);
  // TypeScript: only real syntax errors, never types or the syntax the stripper leaves alone.
  const strips = typeof (await import('node:module') as unknown as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes === 'function';
  if (strips) {
    assert.ok(await syntaxProblem(join(dir, 'x.ts'), 'export function f(x: string) { return x +; }\n'));
    assert.equal(await syntaxProblem(join(dir, 'y.ts'), 'export const a: number = "not a number" as unknown as number;\n'), undefined);
    assert.equal(await syntaxProblem(join(dir, 'z.ts'), 'export enum E { A, B }\n'), undefined);
  }
  mkdirSync(join(dir, 'py'), { recursive: true });
  const py = String(await writeFileTool.run({ path: 'py/bad.py', content: 'def f(:\n    pass\n' }, ctx()));
  const okPy = String(await writeFileTool.run({ path: 'py/ok.py', content: 'def f():\n    return 1\n' }, ctx()));
  assert.doesNotMatch(okPy, /SYNTAX ERROR/);
  // With no Python on this computer the check is skipped, never wrong.
  if (/SYNTAX ERROR/.test(py)) assert.match(py, /SyntaxError/);
  // A kind of file that is not checked is left alone.
  assert.doesNotMatch(String(await writeFileTool.run({ path: 'notes.md', content: '{{ not code' }, ctx())), /SYNTAX ERROR/);
});

const R = (name: string, args: Record<string, unknown>, output = '', status: Receipt['status'] = 'ok'): Receipt => ({ name, status, args, output }) as Receipt;
const edit = R('edit_file', { path: 'src/a.js' }, 'Edited src/a.js (1 replacement).');
const testOk = R('shell', { command: 'npm test' }, '[exit code 0]\n12 passing');
const testBad = R('shell', { command: 'npm test' }, '[exit code 1]\n1 failing');

test('T55: the done gate: tests must have run after the last change', () => {
  const base = { reply: 'All done, the bug is fixed.', ownerText: 'Fix the totals bug', testCommand: 'npm test' };
  assert.deepEqual(doneGateWhy({ ...base, receipts: [edit] }), { why: 'not-run', command: 'npm test' });
  assert.deepEqual(doneGateWhy({ ...base, receipts: [testOk, edit] }), { why: 'stale', command: 'npm test' });
  assert.equal(doneGateWhy({ ...base, receipts: [edit, testOk] }), undefined);
  assert.deepEqual(doneGateWhy({ ...base, receipts: [edit, testBad] }), { why: 'failed', command: 'npm test' });
  assert.equal(doneGateWhy({ ...base, reply: 'Two tests still fail: the rounding ones.', receipts: [edit, testBad] }), undefined, 'she says so: an honest stop');
  // Nothing changed, or a project with no tests at all: nothing to ask for.
  assert.equal(doneGateWhy({ ...base, receipts: [R('read_file', { path: 'a.js' })] }), undefined);
  assert.equal(doneGateWhy({ reply: 'Done.', ownerText: 'x', receipts: [edit] }), undefined);
  // No command in the project files, but she ran tests before her last change: that command.
  assert.deepEqual(doneGateWhy({ reply: 'Done.', ownerText: 'x', receipts: [R('shell', { command: 'python -m pytest -q' }, '[exit code 0]'), edit] }), { why: 'stale', command: 'python -m pytest -q' });
  // The owner said not to.
  assert.equal(doneGateWhy({ ...base, ownerText: "Fix it, don't run the tests", receipts: [edit] }), undefined);
  for (const c of ['npm test', 'node --test', 'python -m unittest discover', 'pytest -q', 'cargo test', 'go test ./...', 'pnpm test']) assert.ok(TEST_RUN.test(c), c);
  assert.equal(TEST_RUN.test('git status'), false);
});

test('T55: the done gate nudges at most twice a turn and stays out of goals', () => {
  const o = { receipts: [edit], reply: 'Done.', testCommand: 'npm test', ownerText: 'fix', ownerName: 'Alex', canStep: true, goalOrLoop: false, hasShell: true };
  const g = new DoneGate();
  assert.match(g.note(o)!, /you changed files and have not run the tests\. Run them now \(npm test\)/);
  assert.match(g.note({ ...o, receipts: [testOk, edit] })!, /after your last test run/);
  assert.equal(g.note(o), undefined, 'two a turn');
  assert.equal(new DoneGate().note({ ...o, goalOrLoop: true }), undefined);
  assert.equal(new DoneGate().note({ ...o, hasShell: false }), undefined);
  assert.equal(new DoneGate().note({ ...o, canStep: false }), undefined);
  assert.match(new DoneGate().note({ ...o, receipts: [edit, testBad] })!, /your last test run failed, and your reply does not say so/);
});

test('T55: in a coding turn, "done" after an edit with no test run gets one more step, and she runs the tests', async (t) => {
  resetEditGuard();
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', toolPermissions: { shell: 'auto' } });
  const conv = app.store.createConversation({ title: 'x', mode: 'coding', workspace: 'proj' });
  const w = workspaceDir(dir, 'proj');
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, 'package.json'), JSON.stringify({ name: 'proj', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(w, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  writeFileSync(join(w, 'sum.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './sum.js';\ntest('sum', () => assert.equal(sum(1, 2), 3));\n");
  const notes: string[] = [];
  let n = 0;
  const script = (req: ChatRequest): StreamEvent[] => {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    if (lastUser && /\[Note from the app/.test(lastUser.content)) notes.push(lastUser.content);
    n++;
    if (n === 1) return [call('c1', 'edit_file', { path: 'sum.js', old_string: 'a - b', new_string: 'a + b' })];
    if (n === 2) return text('Done, the bug is fixed.');
    if (n === 3) return [call('c2', 'shell', { command: 'npm test' })];
    return text('The tests pass now: 1 of 1.');
  };
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    listModels: async () => ['m'],
    async *stream(req: ChatRequest) {
      yield* script(req);
    },
  });
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'Fix the sum bug')) evs.push(ev);
  assert.equal(notes.length, 1, 'one note from the app');
  assert.match(notes[0]!, /you changed files and have not run the tests\. Run them now \(npm test\)/);
  assert.ok(evs.some((e) => e.type === 'tool_call' && e.name === 'shell'), 'she ran the tests');
  assert.equal(n, 4, 'and then the turn ended');
});
