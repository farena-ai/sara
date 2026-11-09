// R1C2: "Project now" at the provider seam: other active owner chats on the same project, with
// basis-labelled check results. Synthetic data only (Alex, two coding chats, a temp git repo).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { checksDb } from '../src/diagnostics.ts';
import { otherWork, projectNowSection } from '../src/project-now.ts';
import { RunStore, workspaceRef } from '../src/runs.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, tempDir, text, type TestApp } from './helpers.ts';
import { noteOf, otherRun, projectFixture } from './project-now-fixture.ts';

async function turn(app: TestApp, id: string, msg: string) { for await (const _ of runTurn(app, id, msg)) void _; }

test('two owner chats on one project see each other\'s running work and overlapping * paths', async (t) => {
  const f = projectFixture(t);
  const login = f.app.store.createConversation({ mode: 'coding', title: 'Fix login' });
  const auth = f.app.store.createConversation({ mode: 'coding', title: 'Refactor auth' });
  f.clock.now = new Date('2026-11-06T13:48:00Z');
  otherRun(f.app, login.id, ['src/auth.ts', 'src/session.ts']);
  f.clock.now = new Date('2026-11-06T14:00:00Z');
  f.app.script.push([call('w1', 'write_file', { path: 'src/auth.ts', content: 'export const a = 2;\n' })], text('Edited.'));
  await turn(f.app, auth.id, 'Refactor the auth module.');
  f.app.script.push(text('Here.'));
  const start = f.app.requests.length;
  await turn(f.app, auth.id, 'Where are we?');
  const note = noteOf(f.app.requests[start]);
  assert.match(note, /Also active on this project:/);
  assert.match(note, /"Fix login" \(12 min ago, running\): src\/auth\.ts\*, src\/session\.ts(?!\*)/);
  assert.doesNotMatch(note, /Refactor auth/, 'this chat is not listed as other work');
  // The UI view gives the same titles and paths.
  const view = otherWork(f.app, auth, '.');
  assert.deepEqual(view.map(o => [o.id, o.title, o.running, o.paths.map(p => `${p.path}${p.both ? '*' : ''}`)]), [[login.id, 'Fix login', true, ['src/auth.ts*', 'src/session.ts']]]);
});

test('an outside file edit between steps shows on the next step; a write step refreshes the basis', async (t) => {
  const f = projectFixture(t);
  const conv = f.app.store.createConversation({ mode: 'coding', title: 'Refactor auth' });
  const basis = await workspaceRef(f.ws);
  checksDb(f.app).addRun({ workspace: 'main', project: '.', checker: 'tsc', engine: 'command', files: '*', startedAt: f.app.now().toISOString(), ms: 10, exitCode: 0, state: 'ok', errors: 0, warnings: 0, otherErrors: 0, note: null, basis });
  f.app.script.push([call('r1', 'read_file', { path: 'src/auth.ts' })], [call('w1', 'write_file', { path: 'src/session.ts', content: 'export const s = 2;\n' })], text('Done.'));
  const start = f.app.requests.length;
  await turn(f.app, conv.id, 'Tidy session handling.');
  const notes = f.app.requests.slice(start).map(noteOf);
  assert.equal(notes.length, 3);
  assert.match(notes[0], /tsc: ok, 0 errors, ran on [0-9a-f]{7} \+ 0 changed files, current/);
  assert.match(notes[1], /current/, 'a read step reuses the cached manifest');
  assert.match(notes[2], /tsc: ok, 0 errors, stale[^\n]*1 files? changed \(src\/session\.ts\)/);
  // An outside editor changes a file between turns: the next step 0 sees it.
  writeFileSync(join(f.ws, 'src', 'auth.ts'), 'export const a = 3;\n');
  f.app.script.push(text('Ok.'));
  const next = f.app.requests.length;
  await turn(f.app, conv.id, 'Status?');
  assert.match(noteOf(f.app.requests[next]), /2 files changed \(src\/auth\.ts, src\/session\.ts\)/);
  assert.match(noteOf(f.app.requests[next]), /re-run the check/);
});

test('an idle chat (more than 2 h), another project, workspace or companion is never shown', async (t) => {
  const f = projectFixture(t);
  const here = f.app.store.createConversation({ mode: 'coding', title: 'Here' });
  const idle = f.app.store.createConversation({ mode: 'coding', title: 'Idle chat' });
  otherRun(f.app, idle.id, ['src/auth.ts'], { endedAt: '2026-11-06T11:59:00.000Z' });
  const recent = f.app.store.createConversation({ mode: 'coding', title: 'Recent chat' });
  otherRun(f.app, recent.id, ['src/session.ts'], { endedAt: '2026-11-06T12:30:00.000Z' });
  writeFileSync(join(workspaceDir(f.dir, 'other'), 'package.json'), '{}');
  const elsewhere = f.app.store.createConversation({ mode: 'coding', title: 'Other workspace', workspace: 'other' });
  otherRun(f.app, elsewhere.id, ['src/auth.ts']);
  const chatty = f.app.store.createConversation({ mode: 'chat', title: 'Plain chat' });
  otherRun(f.app, chatty.id, ['src/auth.ts']);
  // A second companion shares the workspaces folder but never this companion's records.
  const second = tempDir();
  t.after(() => second.cleanup());
  const other = makeApp(second.dir, f.clock);
  other.rootDir = f.dir;
  other.runs = new RunStore(other.store.db, () => f.clock.now);
  const theirs = other.store.createConversation({ mode: 'coding', title: 'Other companion' });
  otherRun(other, theirs.id, ['src/auth.ts']);
  t.after(() => other.store.close());
  const section = projectNowSection(f.app, here, { now: await workspaceRef(f.ws) }) ?? '';
  assert.match(section, /"Recent chat" \(1 h ago\): src\/session\.ts/);
  for (const hidden of ['Idle chat', 'Other workspace', 'Plain chat', 'Other companion']) assert.ok(!section.includes(hidden), hidden);
});
