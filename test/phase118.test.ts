// Phase 118 (2.51.0): keep going until it's done (goals on a chat) and repeat-in-chat loops
// (docs/design/PERSIST.md §5.14). The model is the scripted fake from helpers.ts (it records every
// request); tools are fakes in the test registry; the clock is fake (makeApp's clock object); the
// workspace is a temp folder with a tiny package.json whose `test` script reads a file. Waits poll
// for state, and each test cleans up its own temp folder.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setUpBoard } from '../src/board-work.ts';
import { parseCommand, runCommand as runChatCommand, type BridgeAdapter } from '../src/bridges/commands.ts';
import { Goals, goalsFor, parseGoalCommand } from '../src/goals.ts';
import { inQuiet } from '../src/life.ts';
import { Loops, loopsFor, parseLoopCommand } from '../src/loops.ts';
import { cleanChecks, refuseCheck } from '../src/persist.ts';
import { pendingFor } from '../src/pending.ts';
import type { StreamEvent } from '../src/providers/types.ts';
import { ReminderScheduler } from '../src/reminders.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { UsageStore } from '../src/usage.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const SARA_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const START = new Date('2026-11-01T15:00:00Z');

async function until<T>(f: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the state');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The tiny project: `npm test` passes when the file `state` says green (node --test style counts). */
const PKG = { name: 'p118', version: '1.0.0', scripts: { test: `node -e "const s=require('fs').readFileSync('state','utf8').trim();const f=s==='green'?0:s==='red-b'?3:s==='red-a'?5:2;console.log('ℹ pass '+(f?1:4));console.log('ℹ fail '+f);if(f){console.log('Error: expected green but got '+s)}process.exit(f?1:0)"` } };

interface Setup {
  app: TestApp;
  clock: { now: Date };
  ws: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  ran: Record<string, number>;
  deploy: { state: string };
  events: { type: string; [k: string]: unknown }[];
  pushes: { title: string; text: string }[];
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, o: { settings?: Record<string, unknown> } = {}): Promise<Setup> {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(START) };
  const app = makeApp(dir, clock);
  app.usage = new UsageStore(app.store.db, () => clock.now);
  const runs = new RunStore(app.store.db, () => clock.now);
  runs.usage = app.usage;
  runs.settings = () => runSettings(app.settings.get());
  app.runs = runs;
  const pushes: Setup['pushes'] = [];
  app.push = { notifyOwner: async (title: string, txt: string) => void pushes.push({ title, text: txt }) } as never;
  const events: Setup['events'] = [];
  app.events!.subscribe((ev) => events.push(ev as never));
  const ws = workspaceDir(dir, 'main');
  writeFileSync(join(ws, 'package.json'), JSON.stringify(PKG, null, 2));
  writeFileSync(join(ws, 'state'), 'red');
  mkdirSync(join(ws, 'test'), { recursive: true });
  writeFileSync(join(ws, 'test', 'a.test.js'), "require('assert').ok(true)\n");
  const ran: Record<string, number> = { write_file: 0, deploy_status: 0, ask_tool: 0 };
  const deploy = { state: 'green' };
  const write: Tool = {
    spec: { name: 'write_file', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    defaultPermission: 'auto',
    summarize: (a) => `write ${String(a.path)}`,
    async run(a) {
      ran.write_file++;
      writeFileSync(join(ws, String(a.path)), String(a.content));
      return `wrote ${String(a.path)}`;
    },
  };
  const deployTool: Tool = {
    spec: { name: 'deploy_status', description: 'the deploy', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: () => 'check the deploy',
    async run() {
      ran.deploy_status++;
      return `deploy: ${deploy.state}`;
    },
  };
  const ask: Tool = {
    spec: { name: 'ask_tool', description: 'asks first', parameters: { type: 'object', properties: {} } },
    defaultPermission: 'ask',
    summarize: () => 'restart the server',
    async run() {
      ran.ask_tool++;
      return 'restarted';
    },
  };
  for (const tl of [write, deployTool, ask]) app.tools.add(tl);
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'UTC',
    disclosureAcceptedAt: START.toISOString(),
    toolPermissions: { write_file: 'auto', deploy_status: 'auto', ask_tool: 'ask' },
    proactive: { quietStart: 22, quietEnd: 9 },
    ...(o.settings ?? {}),
  } as never);
  const { OwnerAuth } = await import('../src/auth.ts');
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: SARA_VERSION, revision: null, startedAt: START.toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    app.goals?.abortChecks();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* a stream */
    }
    return { status: res.status, json };
  };
  return { app, clock, ws, api, ran, deploy, events, pushes };
}

const writeState = (v: string, id = 'w') => [call(id, 'write_file', { path: 'state', content: v })];
const sentText = (app: TestApp, i: number) => (app.requests[i]?.messages ?? []).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n');
const goalOf = (s: Setup, convId: string) => goalsFor(s.app).current(convId)!;
const reqWith = (s: Setup, needle: string) => s.app.requests.findIndex((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes(needle)));

// ------------------------------------------------------------------ part A: goals

test('goal: done = the check. Round 1 claims "all pass" but the check is red; round 2 is queued with the real failure; green → done', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  s.app.script.push(writeState('red-a', 'w1'), text('All tests pass now!'), text('I wrote the state file; I have not run the tests.'), writeState('green', 'w2'), text('Fixed the state file.'));
  const opts = await s.api('GET', `/conversations/${conv.id}/goal`);
  assert.deepEqual((opts.json.defaultChecks as { kind: string; command: string }[]).map((c) => [c.kind, c.command]), [['tests', 'npm test']]);
  const r = await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const g = await until(() => (goalOf(s, conv.id).state === 'done' ? goalOf(s, conv.id) : undefined)).catch((e) => {
    console.log(JSON.stringify(goalOf(s, conv.id)), JSON.stringify(goalsFor(s.app).checks(goalOf(s, conv.id).id)), JSON.stringify(s.app.store.messages(conv.id).map((m) => [m.role, m.content.slice(0, 150), m.meta?.goal])), JSON.stringify(pendingFor(s.app).list(conv.id)));
    throw e;
  });
  const checks = goalsFor(s.app).checks(g.id);
  assert.deepEqual(checks.map((c) => [c.round, c.ok, c.failed]), [[1, false, 5], [2, true, 0]]);
  assert.match(checks[0].quote ?? '', /expected green but got red-a/);
  assert.equal(g.round, 2);
  assert.equal(g.reason, null);
  // Round 2's step-0 request carried the app's note with the real failure and "Round 2 of 5".
  const r2 = reqWith(s, 'Round 2 of 5');
  assert.ok(r2 > 0, 'round 2 got the note');
  assert.match(sentText(s.app, r2), /it is NOT done yet: exit code 1, 5 failing/);
  assert.match(sentText(s.app, r2), /Note from the app, not from Alex/);
  // The claim check flagged "All tests pass now!" as today; the goal did not end on it.
  const users = s.app.store.messages(conv.id).filter((m) => m.role === 'user');
  assert.equal(users.length, 1, 'round 2 is not a fake owner message');
  const final = s.app.store.messages(conv.id).filter((m) => (m.meta?.goal as { end?: boolean } | undefined)?.end).at(-1)!;
  assert.match(final.content, /Done: the check passed \(npm test: 4 passed, 0 failed\) after 2 round/);
  const states = s.events.filter((e) => e.type === 'goal').map((e) => (e.goal as { state: string }).state);
  assert.ok(states.includes('running') && states.includes('checking') && states.at(-1) === 'done', states.join(','));
  // /goal prints "done".
  const st = await s.api('POST', `/conversations/${conv.id}/command`, { text: '/goal' });
  assert.match(String(st.json.reply), /done/);
});

test('goal: never self-declared: she only says it is done → stuck after round 2 (stuckAfter 2), after round 3 with stuckAfter 3; no round after stuck', async (t) => {
  for (const stuckAfter of [2, 3]) {
    const s = await setup(t, { settings: { persist: { goals: { stuckAfter } } } });
    const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
    for (let i = 0; i < 6; i++) s.app.script.push(text('All done, every test passes.'), text('I have not run anything.'));
    await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
    const g = await until(() => (goalOf(s, conv.id).state === 'stuck' ? goalOf(s, conv.id) : undefined));
    assert.equal(g.round, stuckAfter);
    const calls = s.app.requests.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.app.requests.length, calls, 'no round after stuck');
    assert.match(s.app.store.messages(conv.id).at(-1)!.content, new RegExp(`Stuck after round ${stuckAfter}`));
  }
});

test('goal: progress resets stuck (keys A, B, B → stuck only after the third); 5 → 3 → 3 failing is progress then no progress', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  s.app.script.push(writeState('red-a', 'a1'), text('a'), writeState('red-b', 'a2'), text('b'), writeState('red-b ', 'a3'), text('b again'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  const g = await until(() => (goalOf(s, conv.id).state === 'stuck' ? goalOf(s, conv.id) : undefined));
  assert.equal(g.round, 3);
  assert.deepEqual(goalsFor(s.app).checks(g.id).map((c) => c.failed), [5, 3, 3]);
});

test('goal: tamper. Editing the test file or scripts.test and going green ends amber (done, review) with the files listed; a new test file + the fix is review too', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  s.app.script.push([call('t1', 'write_file', { path: 'test/a.test.js', content: '// gone\n' }), call('t2', 'write_file', { path: 'state', content: 'green' })], text('Changed the test.'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  const g = await until(() => (goalOf(s, conv.id).state === 'done' ? goalOf(s, conv.id) : undefined));
  assert.equal(g.reason, 'review');
  assert.match(s.app.store.messages(conv.id).at(-1)!.content, /done, but review it.*test\/a\.test\.js/i);
  // scripts.test changed.
  const s2 = await setup(t);
  const c2 = s2.app.store.createConversation({ mode: 'coding', title: 'p' });
  s2.app.script.push([call('t3', 'write_file', { path: 'package.json', content: JSON.stringify({ ...PKG, scripts: { test: 'node -e "console.log(\'ℹ pass 1\');console.log(\'ℹ fail 0\')"' } }) })], text('Simplified the test script.'));
  await s2.api('POST', `/conversations/${c2.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  const g2 = await until(() => (goalOf(s2, c2.id).state === 'done' ? goalOf(s2, c2.id) : undefined));
  assert.equal(g2.reason, 'review');
  assert.match(s2.app.store.messages(c2.id).at(-1)!.content, /package\.json \(scripts: npm test\)/);
  // A new test file and the fix: review as well (the owner decides; the rule is visible).
  const s3 = await setup(t);
  const c3 = s3.app.store.createConversation({ mode: 'coding', title: 'p' });
  s3.app.script.push([call('t4', 'write_file', { path: 'test/b.test.js', content: 'new test\n' }), call('t5', 'write_file', { path: 'state', content: 'green' })], text('Added a test and fixed it.'));
  await s3.api('POST', `/conversations/${c3.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  const g3 = await until(() => (goalOf(s3, c3.id).state === 'done' ? goalOf(s3, c3.id) : undefined));
  assert.equal(g3.reason, 'review');
});

test('board: Done when tests → her card work is a goal; Doing while rounds run, Done only on a green check; green after editing a test waits on you', async (t) => {
  const s = await setup(t);
  setUpBoard(s.app);
  const b = s.app.board!;
  const roleOf = (id: number) => b.column(b.card(id)!.columnId)!.role;
  const c = b.addCard(b.general().id, { title: 'Make the tests pass' });
  s.app.script.push(writeState('red-a', 'w1'), text('I wrote the state file.'), writeState('green', 'w2'), text('I wrote the state file again.'));
  const r = await s.api('POST', `/tasks/${c.id}/assign`, { assignee: 'sara', checks: ['tests'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await until(() => b.card(c.id)!.work?.goalId);
  assert.equal(roleOf(c.id), 'doing');
  await s.app.cardWork!.finished(String(c.id));
  const w = b.card(c.id)!.work!;
  assert.equal(w.state, 'done', JSON.stringify(w));
  assert.equal(roleOf(c.id), 'done');
  const g = goalsFor(s.app).get(w.goalId!)!;
  assert.equal(g.state, 'done');
  assert.equal(g.round, 2);
  assert.deepEqual(goalsFor(s.app).checks(g.id).map((x) => x.ok), [false, true]);
  assert.equal(g.meta.card, String(c.id));
  // A goal in a chat never makes a card; the card's goal lives in the card's own conversation.
  assert.equal(s.app.store.getConversation(g.conversationId)!.channel, 'board');
  assert.ok(b.activity(c.id).some((x) => x.what === 'receipt'), 'one activity line per checked round');
  // Green after she changed the test file: the card waits on you (done, review), never Done.
  const c2 = b.addCard(b.general().id, { title: 'Make it green again' });
  writeFileSync(join(s.ws, 'state'), 'red');
  s.app.script.push([call('t1', 'write_file', { path: 'test/a.test.js', content: '// gone\n' }), call('t2', 'write_file', { path: 'state', content: 'green' })], text('Changed the test.'));
  await s.api('POST', `/tasks/${c2.id}/assign`, { assignee: 'sara', checks: ['tests'] });
  await until(() => b.card(c2.id)!.work?.goalId);
  await s.app.cardWork!.finished(String(c2.id));
  const w2 = b.card(c2.id)!.work!;
  assert.equal(w2.state, 'waiting', JSON.stringify(w2));
  assert.equal(w2.ask?.kind, 'goal');
  assert.match(w2.ask!.text, /Green, but she changed tests: test\/a\.test\.js/);
  assert.equal(roleOf(c2.id), 'waiting');
  // Without Done when, card work is unchanged (no goal).
  const c3 = b.addCard(b.general().id, { title: 'Write notes.md' });
  s.app.script.push([call('n1', 'write_file', { path: 'notes.md', content: '# Notes\n' })], text('I wrote notes.md.'));
  await s.api('POST', `/tasks/${c3.id}/assign`, { assignee: 'sara' });
  await s.app.cardWork!.finished(String(c3.id));
  assert.equal(b.card(c3.id)!.work!.goalId, undefined);
  assert.equal(b.card(c3.id)!.work!.state, 'done');
});

test('goal: refused checks (installs, deletes, network) → 400 with the reason; writes are allowed; the check can only change through the owner', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  const post = (command: string) => s.api('POST', `/conversations/${conv.id}/goal`, { text: 'x', checks: [{ kind: 'command', command }] });
  const a = await post('npm install && npm test');
  assert.equal(a.status, 400);
  assert.match(String(a.json.error), /installs packages/);
  assert.match(String((await post('rm -rf build && make')).json.error), /deletes files/);
  assert.match(String((await post('curl https://example.com/health')).json.error), /uses the network/);
  assert.equal(refuseCheck('jest --ci > cache.txt'), undefined, 'writes are allowed');
  assert.ok('checks' in cleanChecks([{ kind: 'command', command: 'jest --ci' }], []));
  // No tool in her registry touches chat_goals.
  assert.ok(!s.app.tools.list().some((tl) => /goal/.test(tl.spec.name) && tl.spec.name !== 'propose_goal'));
  const draft = await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'x', checks: ['tests'] });
  assert.equal(draft.status, 201);
  const ch = await s.api('PUT', `/conversations/${conv.id}/goal/check`, { checks: [{ kind: 'command', command: 'node -e "process.exit(0)"' }] });
  assert.equal((ch.json.goal as { checks: { kind: string }[] }).checks[0].kind, 'command');
});

test('goal: caps. Rounds 2 → paused (cap:rounds) with no round 3; a token cap projected from the last round stops before round 2; usd ignored on a subscription', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  s.app.script.push(writeState('red-a', 'c1'), text('one'), writeState('red-b', 'c2'), text('two'), writeState('green', 'c3'), text('three'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], caps: { rounds: 2 }, start: true });
  const g = await until(() => (goalOf(s, conv.id).state === 'paused' ? goalOf(s, conv.id) : undefined));
  assert.equal(g.reason, 'cap:rounds');
  assert.equal(g.round, 2);
  assert.match(s.app.store.messages(conv.id).at(-1)!.content, /stopped before round 3/);
  // Resume with +2 rounds: round 3 runs and goes green.
  const rs = await s.api('POST', `/conversations/${conv.id}/goal/resume`, { more: { rounds: 2 } });
  assert.equal(rs.status, 200);
  await until(() => goalOf(s, conv.id).state === 'done');
  // Tokens: 30,000 with rounds of ~20,000 → round 2 is not started.
  const s2 = await setup(t);
  const c2 = s2.app.store.createConversation({ mode: 'coding', title: 'p' });
  s2.app.script.push([...writeState('red-a', 'd1'), { type: 'usage', input: 15_000, output: 5_000 }] as StreamEvent[], [...text('one'), { type: 'usage', input: 100, output: 10 }] as StreamEvent[]);
  await s2.api('POST', `/conversations/${c2.id}/goal`, { text: 'make the tests pass', checks: ['tests'], caps: { tokens: 30_000 }, start: true });
  const g2 = await until(() => (goalOf(s2, c2.id).state === 'paused' ? goalOf(s2, c2.id) : undefined));
  assert.equal(g2.reason, 'cap:tokens');
  assert.equal(g2.round, 1, 'round 2 never started');
});

test('goal: held by the turn budget. A round that reaches its budget pauses the goal; Continue with more runs it on, then the check runs and the goal goes on', async (t) => {
  const s = await setup(t, { settings: { turnBudgets: { coding: { on: true, tokens: 0, steps: 3 } } } });
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  s.app.script.push(writeState('red', 'b1'), writeState('red', 'b2'), writeState('red', 'b3'), text('Summary: still working.'), text('more summary'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  const g = await until(() => (goalOf(s, conv.id).state === 'paused' ? goalOf(s, conv.id) : undefined));
  assert.equal(g.reason, 'budget');
  assert.equal(goalsFor(s.app).checks(g.id).length, 0, 'no check after a budget stop');
  s.app.script.length = 0;
  s.app.script.push(writeState('green', 'b4'), text('Done the fix.'));
  const cont = await s.api('POST', `/conversations/${conv.id}/continue`, { budget: { steps: 10 } });
  assert.equal(cont.status, 200);
  await until(() => goalOf(s, conv.id).state === 'done');
});

test('goal: the loop guard carries across rounds (seeded; listed in the note); tools paused in a round → stuck', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  const bad = { path: 'missing/dir/x', content: 'y' };
  s.app.script.push([call('g1', 'write_file', bad)], [call('g2', 'write_file', bad)], [call('g3', 'write_file', bad)], text('That keeps failing.'));
  s.app.script.push([call('g4', 'write_file', bad)], text('Still blocked.'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], caps: { rounds: 2 }, start: true });
  await until(() => goalOf(s, conv.id).round === 2 && ['paused', 'stuck'].includes(goalOf(s, conv.id).state));
  const g = goalOf(s, conv.id);
  assert.ok((g.meta.blocked ?? []).length >= 1, 'the block is kept on the goal');
  const r2 = reqWith(s, 'Round 2 of 2');
  assert.match(sentText(s.app, r2), /Still blocked from earlier rounds/);
  const blockedTool = s.app.store.messages(conv.id).filter((m) => m.role === 'tool').at(-1)!;
  assert.match(blockedTool.content, /Blocked by Sara's loop guard/, 'refused at once in round 2');
  // Tools paused in a round → stuck.
  const s2 = await setup(t);
  const c2 = s2.app.store.createConversation({ mode: 'coding', title: 'p' });
  for (let i = 0; i < 8; i++) s2.app.script.push([call(`h${i}`, 'write_file', bad)]);
  s2.app.script.push(text('I give up.'));
  await s2.api('POST', `/conversations/${c2.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  const g2 = await until(() => (goalOf(s2, c2.id).state === 'stuck' ? goalOf(s2, c2.id) : undefined));
  assert.match(s2.app.store.messages(c2.id).at(-1)!.content, /kept trying the same failing step/);
});

test('goal: Stop wins. Stop during a round drops the queued round (stopped); Stop while the check runs kills it (no green row); /stop pauses, /reset stops', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  // A slow check: Stop while it runs.
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'wait for it', checks: [{ kind: 'command', command: 'node -e "setTimeout(()=>process.exit(0),8000)"' }], start: true });
  s.app.script.push(text('Done my part.'));
  await until(() => goalOf(s, conv.id).state === 'checking');
  const st = await s.api('POST', `/conversations/${conv.id}/goal/stop`, {});
  assert.equal((st.json.goal as { state: string }).state, 'stopped');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!goalsFor(s.app).checks(goalOf(s, conv.id).id).some((c) => c.ok), 'no green row after Stop');
  assert.equal(pendingFor(s.app).list(conv.id).length, 0);
  // /stop pauses; /reset stops (the web command route runs the same command layer as the chat apps).
  const c2 = s.app.store.createConversation({ mode: 'coding', title: 'q' });
  await s.api('POST', `/conversations/${c2.id}/goal`, { text: 'wait again', checks: [{ kind: 'command', command: 'node -e "setTimeout(()=>process.exit(1),8000)"' }], start: true });
  s.app.script.push(text('My part.'));
  await until(() => goalOf(s, c2.id).state === 'checking');
  await s.api('POST', `/conversations/${c2.id}/command`, { text: '/stop' });
  assert.equal(goalOf(s, c2.id).state, 'paused');
  await s.api('POST', `/conversations/${c2.id}/command`, { text: '/reset' });
  assert.equal(goalOf(s, c2.id).state, 'stopped');
});

test('goal: owner first. A message posted while the check runs runs as the next round (with the goal note); no extra round is added', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  s.app.script.push(writeState('red-a', 'o1'), text('Round one.'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'make the tests pass', checks: ['tests'], start: true });
  await until(() => goalOf(s, conv.id).state === 'checking');
  const r = await s.api('POST', `/conversations/${conv.id}/messages`, { content: 'the state file wants green', whileBusy: 'queue' });
  assert.equal(r.status, 202);
  s.app.script.push(writeState('green', 'o2'), text('Wrote green as you said.'));
  const g = await until(() => (goalOf(s, conv.id).state === 'done' ? goalOf(s, conv.id) : undefined));
  assert.equal(g.round, 2, 'his message was round 2');
  const i = reqWith(s, 'the state file wants green');
  assert.match(sentText(s.app, i), /Round 2 of 5/);
  assert.ok(!s.app.store.messages(conv.id).some((m) => m.role === 'notice' && /Round 2/.test(m.content)), 'the queued round made way');
});

test('goal: restart. Running and checking goals come back paused (restart) on the same data folder; no turn, no check; one line each; Resume starts the next round', async (t) => {
  const s = await setup(t);
  const a = s.app.store.createConversation({ mode: 'coding', title: 'a' });
  const b = s.app.store.createConversation({ mode: 'coding', title: 'b' });
  await s.api('POST', `/conversations/${a.id}/goal`, { text: 'goal a', checks: ['tests'] });
  await s.api('POST', `/conversations/${b.id}/goal`, { text: 'goal b', checks: ['tests'] });
  s.app.store.db.exec("UPDATE chat_goals SET state = 'running', started_at = '2026-11-01T15:00:00.000Z', round = 1 WHERE text = 'goal a'");
  s.app.store.db.exec("UPDATE chat_goals SET state = 'checking', started_at = '2026-11-01T15:00:00.000Z', round = 1 WHERE text = 'goal b'");
  const calls = s.app.providerCalls;
  // The rebuilt app on the same data folder (a second Store on the same file, as after a restart).
  const { Store } = await import('../src/store.ts');
  const again = { ...s.app, store: new Store(join(s.app.dataDir, 'sara.db'), () => s.clock.now) } as TestApp;
  t.after(() => again.store.close());
  const swept = new Goals(again, again.store.db).startupSweep();
  assert.equal(swept, 2);
  assert.equal(s.app.providerCalls, calls, 'no model call');
  for (const c of [a, b]) {
    const g = goalOf(s, c.id);
    assert.deepEqual([g.state, g.reason], ['paused', 'restart']);
    assert.equal(s.app.store.messages(c.id).filter((m) => /Sara restarted/.test(m.content)).length, 1);
  }
  s.app.script.push(writeState('green', 'r1'), text('Fixed.'));
  await s.api('POST', `/conversations/${a.id}/goal/resume`, {});
  await until(() => goalOf(s, a.id).state === 'done');
});

test('goal: reviewer and owner checks. APPROVE without a real quote is not green; with one it is (labelled "not by tests"); the owner check asks and his tap decides', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'chat', title: 'essay' });
  s.app.script.push([call('e1', 'write_file', { path: 'essay.md', content: 'The quick brown fox jumps over the lazy dog.\n' })], text('Wrote it.'));
  s.app.script.push(text('Looks fine.\nVERDICT: APPROVE'));
  s.app.script.push([call('e2', 'write_file', { path: 'essay.md', content: 'A lazy dog sleeps under the old oak tree.\n' })], text('Rewrote it.'));
  s.app.script.push(text('The line `A lazy dog sleeps under the old oak tree.` reads well.\nVERDICT: APPROVE'));
  await s.api('POST', `/conversations/${conv.id}/goal`, { text: 'write a one-line essay', checks: ['reviewer'], start: true });
  const g = await until(() => (goalOf(s, conv.id).state === 'done' ? goalOf(s, conv.id) : undefined));
  const rows = goalsFor(s.app).checks(g.id);
  assert.deepEqual(rows.map((r) => r.ok), [false, true], 'the first APPROVE quoted nothing real');
  assert.match(s.app.store.messages(conv.id).at(-1)!.content, /Checked by a reviewer model, not by tests/);
  // "I'll say".
  const c2 = s.app.store.createConversation({ mode: 'chat', title: 'plan' });
  s.app.script.push(text('Here is a plan.'), text('Here is a better plan.'));
  await s.api('POST', `/conversations/${c2.id}/goal`, { text: 'plan my week', checks: ['owner'], start: true });
  await until(() => goalOf(s, c2.id).meta.asking);
  await s.api('POST', `/conversations/${c2.id}/goal/said`, { done: false });
  await until(() => goalOf(s, c2.id).round === 2 && goalOf(s, c2.id).meta.asking);
  const done = await s.api('POST', `/conversations/${c2.id}/goal/said`, { done: true });
  assert.equal((done.json.goal as { state: string }).state, 'done');
  assert.match(s.app.store.messages(c2.id).at(-1)!.content, /You said it’s done/);
});

test('goal and loop: who. Partner and talk-only rooms refused (no model); off the record and group chats 400; commands never reach a model', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'p' });
  const calls = s.app.providerCalls;
  const adapter: BridgeAdapter = { currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0 };
  for (const [place, who] of [['partner-dm', 'person'], ['room', 'owner'], ['partner-dm', 'owner']] as const) {
    for (const line of ['/goal make it green done when tests', '/loop every 10m: check the deploy']) {
      const cmd = parseCommand(line, { herName: 'Sara', namePrefix: false })!;
      const r = await runChatCommand({ app: s.app, bridge: 'telegram', place, who, lang: 'en', cmd, adapter });
      assert.equal(r.refused, true, `${place}/${who} ${line}`);
    }
  }
  assert.equal(goalsFor(s.app).current(conv.id), undefined);
  assert.equal(loopsFor(s.app).forConversation(conv.id).length, 0);
  // Off the record.
  const off = await s.api('POST', '/conversations', { offRecord: true, title: 'x' });
  const offId = String((off.json as { id?: string }).id ?? '');
  if (offId) {
    const r = await s.api('POST', `/conversations/${offId}/goal`, { text: 'x', checks: ['owner'] });
    assert.equal(r.status, 400);
  }
  // A group chat.
  const grp = s.app.store.createConversation({ title: 'room', channel: 'group', channelKey: 'r1' } as never);
  assert.equal((await s.api('POST', `/conversations/${grp.id}/goal`, { text: 'x', checks: ['owner'] })).status, 400);
  assert.equal((await s.api('POST', `/conversations/${grp.id}/loops`, { prompt: 'x', everyMin: 10 })).status, 400);
  // Owner commands through the web route: parsed with zero model calls.
  const g = await s.api('POST', `/conversations/${conv.id}/command`, { text: '/goal make it green done when tests' });
  assert.match(String(g.json.reply), /Send \/goal start/);
  const l = await s.api('POST', `/conversations/${conv.id}/command`, { text: '/loop every 10m for 1h: check the deploy' });
  assert.match(String(l.json.reply), /Send \/loop start/);
  assert.equal(s.app.providerCalls, calls, 'no model call');
  assert.deepEqual(parseGoalCommand('make it green done when `npm test`'), { sub: 'set', text: 'make it green', check: '`npm test`' });
});

// ------------------------------------------------------------------ part B: loops

const tickNow = async (s: Setup, mins: number) => {
  s.clock.now = new Date(s.clock.now.getTime() + mins * 60_000);
  new ReminderScheduler(s.app, s.app.planner!).tick();
  await until(() => !pendingFor(s.app).busy(s.app.store.listConversations()[0]?.id ?? '') && !loopsFor(s.app).all().some((l) => l.state === 'ticking'));
};
const loopOf = (s: Setup, convId: string) => loopsFor(s.app).forConversation(convId).at(-1)!;

test('loop: the main test. /loop every 10m for 1h → card; Start; same is folded (no push, no chat-app message); changed is a message and one push; ended after the hour', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'deploy' });
  const card = await s.api('POST', `/conversations/${conv.id}/command`, { text: "/loop every 10m for 1h: check the deploy and tell me if it's red" });
  assert.match(String(card.json.reply), /every 10m · for 1 h · at most 6 times/);
  const st = await s.api('POST', `/conversations/${conv.id}/command`, { text: '/loop start' });
  assert.match(String(st.json.reply), /next 15:10/);
  const before = s.app.requests.length;
  s.app.script.push([call('d1', 'deploy_status', {})], text('The deploy is green.\n[[loop: same]]'));
  const msgEvents = () => s.events.filter((e) => e.type === 'message' && (e as { reason?: string }).reason === 'reply').length;
  const m0 = msgEvents();
  await tickNow(s, 10);
  assert.ok(s.app.requests.length > before, 'one tick turn');
  assert.match(sentText(s.app, before), /this is a repeat Alex set in this chat \(every 10m/);
  const folded = s.app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal(folded.content, 'The deploy is green.', 'the tag is stripped');
  assert.equal(folded.meta?.folded, true);
  assert.equal(s.pushes.length, 0, 'no push');
  assert.equal(msgEvents(), m0, 'no chat-app message');
  s.deploy.state = 'red';
  s.app.script.push([call('d2', 'deploy_status', {})], text('The deploy went red at 15:20!\n[[loop: changed]]'));
  await tickNow(s, 10);
  assert.equal(s.pushes.length, 1, 'one push');
  assert.equal(msgEvents(), m0 + 1, 'the chat app gets it');
  for (let i = 0; i < 4; i++) {
    s.app.script.push([call(`d${i + 3}`, 'deploy_status', {})], text(`Still red (${i}).\n[[loop: same]]`));
    await tickNow(s, 10);
  }
  await tickNow(s, 10);
  const l = loopOf(s, conv.id);
  assert.equal(l.state, 'ended');
  assert.match(s.app.store.messages(conv.id).at(-1)!.content, /The repeat ended/);
  const calls = s.app.requests.length;
  await tickNow(s, 10);
  assert.equal(s.app.requests.length, calls, 'no more ticks');
});

test('loop: met needs proof (no tool → changed, loop goes on; an ok tool and a clean claim → done); a back-ticked until command decides; an identical changed is downgraded to same', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'pr' });
  const r = await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'look at PR 42', everyMin: 10, forMin: 120, until: 'the PR is merged', start: true });
  assert.equal(r.status, 201);
  s.app.script.push(text('It is merged.\n[[loop: met]]'));
  await tickNow(s, 10);
  assert.equal(loopOf(s, conv.id).state, 'active', 'met without a receipt is a change');
  assert.equal(s.pushes.length, 1);
  s.app.script.push([call('m1', 'deploy_status', {})], text('Checked: merged.\n[[loop: met]]'));
  await tickNow(s, 10);
  assert.equal(loopOf(s, conv.id).state, 'done');
  // Identical "changed" (only the time differs) → same, no push.
  const c2 = s.app.store.createConversation({ mode: 'coding', title: 'w' });
  await s.api('POST', `/conversations/${c2.id}/loops`, { prompt: 'watch it', everyMin: 10, forMin: 120, start: true });
  const p0 = s.pushes.length;
  s.app.script.push([call('f1', 'deploy_status', {})], text('Status at 15:30: red\n[[loop: changed]]'));
  await tickNow(s, 10);
  s.app.script.push([call('f2', 'deploy_status', {})], text('Status at 15:40: red\n[[loop: changed]]'));
  await tickNow(s, 10);
  assert.equal(s.pushes.length, p0 + 1, 'the second, identical one was downgraded');
  assert.equal(loopsFor(s.app).ticks(loopOf(s, c2.id).id)[0].outcome, 'same');
  // An until command: the P2 check decides, her tag is ignored.
  const c3 = s.app.store.createConversation({ mode: 'coding', title: 'c' });
  writeFileSync(join(s.ws, 'state'), 'red');
  await s.api('POST', `/conversations/${c3.id}/loops`, { prompt: 'wait for green', everyMin: 10, forMin: 120, untilCheck: 'npm test', start: true });
  s.app.script.push(text('Done!\n[[loop: met]]'));
  await tickNow(s, 10);
  assert.equal(loopOf(s, c3.id).state, 'active', 'the check is red: not met');
  writeFileSync(join(s.ws, 'state'), 'green');
  s.app.script.push(text('Looks the same.\n[[loop: same]]'));
  await tickNow(s, 10);
  assert.equal(loopOf(s, c3.id).state, 'done', 'the green check decides');
});

test('loop: quiet hours skip ticks (one skipped row, no model call) and one tick runs at 09:00; with hold a change at 03:00 waits and goes as "While you slept"', async (t) => {
  const s = await setup(t);
  s.clock.now = new Date('2026-11-01T22:50:00Z');
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'night' });
  await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'watch it', everyMin: 10, forMin: 720, start: true });
  const calls = s.app.requests.length;
  for (let i = 0; i < 6; i++) await tickNow(s, 10);
  assert.equal(s.app.requests.length, calls, 'no model call in quiet hours');
  const l = loopOf(s, conv.id);
  assert.equal(loopsFor(s.app).ticks(l.id).filter((x) => x.why === 'quiet').length, 1);
  s.clock.now = new Date('2026-11-02T09:00:00Z');
  s.app.script.push([call('q1', 'deploy_status', {})], text('Morning: green.\n[[loop: same]]'));
  await tickNow(s, 0);
  assert.ok(s.app.requests.length > calls, 'one tick at 09:00');
  const n = s.app.requests.length;
  await tickNow(s, 0);
  assert.equal(s.app.requests.length, n, 'not the backlog');
  assert.equal(inQuiet(23, 22, 9), true);
  // Hold: ticks run at night; a change waits for the morning.
  const s2 = await setup(t, { settings: { persist: { loops: { quiet: 'hold' } } } });
  s2.clock.now = new Date('2026-11-02T02:55:00Z');
  const c2 = s2.app.store.createConversation({ mode: 'coding', title: 'hold' });
  await s2.api('POST', `/conversations/${c2.id}/loops`, { prompt: 'watch it', everyMin: 5, forMin: 600, start: true });
  s2.app.script.push([call('h1', 'deploy_status', {})], text('The deploy went red at 03:00.\n[[loop: changed]]'));
  await tickNow(s2, 5);
  assert.equal(s2.pushes.length, 0, 'the push waits');
  s2.clock.now = new Date('2026-11-02T09:00:00Z');
  loopsFor(s2.app).pause(loopOf(s2, c2.id).id);
  new ReminderScheduler(s2.app, s2.app.planner!).tick();
  assert.equal(s2.pushes.length, 1);
  assert.match(s2.pushes[0].text, /While you slept: The deploy went red at 03:00/);
});

test('loop: two failed ticks → stopped (failed); a red until-check is not a failure; an until loop with six identical same ticks → stopped (no progress); a watch loop keeps going', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'f' });
  await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'watch it', everyMin: 10, forMin: 600, start: true });
  const failing = s.app.providerFactory;
  s.app.providerFactory = () => ({ config: { id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'x' }, listModels: async () => [], async *stream() { throw new Error('provider down'); } }) as never;
  await tickNow(s, 10);
  assert.equal(loopOf(s, conv.id).state, 'active');
  await tickNow(s, 10);
  assert.deepEqual([loopOf(s, conv.id).state, loopOf(s, conv.id).reason], ['stopped', 'failed']);
  s.app.providerFactory = failing;
  // No progress.
  const c2 = s.app.store.createConversation({ mode: 'coding', title: 'u' });
  await s.api('POST', `/conversations/${c2.id}/loops`, { prompt: 'look at PR 42', everyMin: 10, forMin: 600, until: 'merged', start: true });
  const c3 = s.app.store.createConversation({ mode: 'coding', title: 'w' });
  await s.api('POST', `/conversations/${c3.id}/loops`, { prompt: 'watch', everyMin: 10, forMin: 600, start: true });
  for (let i = 0; i < 6; i++) {
    s.app.script.push([call(`n${i}a`, 'deploy_status', {})], text('Not merged.\n[[loop: same]]'), [call(`n${i}b`, 'deploy_status', {})], text('Green.\n[[loop: same]]'));
    await tickNow(s, 10);
  }
  assert.deepEqual([loopOf(s, c2.id).state, loopOf(s, c2.id).reason], ['stopped', 'no-progress']);
  assert.equal(loopOf(s, c3.id).state, 'active', 'a watch loop goes on');
});

test('loop: budget. The daily share used up → paused (cap:day) with no model call; the next day it is active again; the ledger matches the runs', async (t) => {
  const s = await setup(t, { settings: { persist: { loops: { dailyTokens: 100_000, maxActive: 1 } } } });
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'b' });
  await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'watch', everyMin: 10, forMin: 1440, start: true });
  s.app.script.push([call('u1', 'deploy_status', {}), { type: 'usage', input: 60_000, output: 1_000 }] as StreamEvent[], [...text('Green.\n[[loop: same]]'), { type: 'usage', input: 39_000, output: 500 }] as StreamEvent[]);
  await tickNow(s, 10);
  const led = loopsFor(s.app).ledger.get('loops');
  assert.equal(led.tokens, 100_500);
  const runs = s.app.runs!.list({ conversationId: conv.id }).filter((r) => r.policy?.loopId);
  assert.equal(runs.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0), led.tokens);
  const calls = s.app.requests.length;
  await tickNow(s, 10);
  assert.deepEqual([loopOf(s, conv.id).state, loopOf(s, conv.id).reason], ['paused', 'cap:day']);
  assert.equal(s.app.requests.length, calls);
  s.clock.now = new Date('2026-11-02T10:00:00Z');
  s.app.script.push([call('u2', 'deploy_status', {})], text('Green.\n[[loop: same]]'));
  await tickNow(s, 0);
  assert.equal(loopOf(s, conv.id).state, 'active');
});

test('loop: no asks while nobody watches. A tool that asks is refused (no approval event), the loop pauses (approval); Allow once and resume runs it once', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'a' });
  await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'restart it if red', everyMin: 10, forMin: 600, start: true });
  s.app.script.push([call('k1', 'ask_tool', {})], text('I could not restart it.\n[[loop: changed]]'));
  await tickNow(s, 10);
  assert.deepEqual([loopOf(s, conv.id).state, loopOf(s, conv.id).reason], ['paused', 'approval']);
  assert.equal(s.ran.ask_tool, 0);
  assert.ok(!s.events.some((e) => e.type === 'approval'));
  assert.match(s.app.store.messages(conv.id).filter((m) => m.role === 'tool').at(-1)!.content, /This is a repeat and Alex isn’t watching/);
  await s.api('POST', `/loops/${loopOf(s, conv.id).id}/resume`, { allowOnce: true });
  s.app.script.push([call('k2', 'ask_tool', {})], text('Restarted.\n[[loop: changed]]'));
  await tickNow(s, 10);
  assert.equal(s.ran.ask_tool, 1);
});

test('loop: limits and restart. every 1m → 400; a fourth active loop → 409; for 30h capped to 24h; no end → 4h; after a rebuild loops are paused with next_at cleared and no tick runs', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'l' });
  const one = await s.api('POST', `/conversations/${conv.id}/loops/parse`, { text: '/loop every 1m: x' });
  assert.equal(one.status, 400);
  assert.match(String(one.json.error), /shorter than the 5 minutes/);
  const long = await s.api('POST', `/conversations/${conv.id}/loops/parse`, { text: '/loop every 10m for 30h: x' });
  assert.equal((long.json.card as { forMin: number; capped: boolean }).forMin, 24 * 60);
  const dflt = await s.api('POST', `/conversations/${conv.id}/loops/parse`, { text: '/loop every 10m: x' });
  assert.equal((dflt.json.card as { forMin: number }).forMin, 4 * 60);
  assert.deepEqual(parseLoopCommand('every 30m for 3h until the PR is merged: look at PR 42'), { sub: 'set', spec: { prompt: 'look at PR 42', everyMin: 30, forMin: 180, untilText: 'the PR is merged' } });
  for (let i = 0; i < 3; i++) assert.equal((await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: `w${i}`, everyMin: 10, start: true })).status, 201);
  assert.equal((await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'w4', everyMin: 10, start: true })).status, 409);
  const swept = new Loops(s.app, s.app.store.db).startupSweep();
  assert.equal(swept, 3);
  for (const l of loopsFor(s.app).forConversation(conv.id)) assert.deepEqual([l.state, l.reason, l.nextAt], ['paused', 'restart', null]);
  const calls = s.app.requests.length;
  await tickNow(s, 30);
  assert.equal(s.app.requests.length, calls, 'no tick after the restart');
  const r = await s.api('POST', `/loops/${loopOf(s, conv.id).id}/resume`, {});
  assert.equal(Date.parse((r.json.loop as { nextAt: string }).nextAt), s.clock.now.getTime() + 10 * 60_000);
});

test('loop: a crisis line from the owner pauses the chat\'s loops (crisis, 48 h); old data opens; /v1 cannot create goals or loops', async (t) => {
  const s = await setup(t);
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'c' });
  await s.api('POST', `/conversations/${conv.id}/loops`, { prompt: 'watch', everyMin: 10, forMin: 600, start: true });
  loopsFor(s.app).crisisPause(conv.id);
  assert.deepEqual([loopOf(s, conv.id).state, loopOf(s, conv.id).reason], ['paused', 'crisis']);
  // A 2.50 database (no new tables) opens and gets them.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  new Goals({ ...s.app } as TestApp, db);
  new Loops({ ...s.app } as TestApp, db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('chat_goals','goal_checks','chat_loops','loop_ticks')").all().length === 4);
  db.close();
  // Commands that reach /v1 are plain text to her: no goal row.
  assert.equal(goalsFor(s.app).current('nope'), undefined);
});
