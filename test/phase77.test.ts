// Phase 77 (harness track M2, docs/design/HARNESS_TRACK.md §3 M2, §2.3, risk 9, §7 #4): before a
// tool call runs it is checked against the owner's decisions. Clear (code-matched) conflicts stop
// with the approval card in coding and work conversations; everything else only flags.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { checkPlan, contradictSettings, gateAct, parseRules, planOf, shellSegments, type Contradiction } from '../src/contradict.ts';
import type { Memory, MemoryStore } from '../src/memory.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-24T20:00:00Z');

/** A stand-in shell/git_push: records what would have run, runs nothing on this PC. */
function stubTool(name: string, ran: string[], permission: 'auto' | 'ask' = 'auto'): Tool {
  return {
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    defaultPermission: permission,
    summarize: (a) => (name === 'shell' ? `$ ${String(a.command ?? '')}` : `${name} ${JSON.stringify(a)}`),
    async run(a) {
      ran.push(name === 'shell' ? String(a.command) : `${name} ${JSON.stringify(a)}`);
      return '[exit code 0, 0.1s]\nok';
    },
  };
}

function setup(t: { after: (fn: () => void) => void }, opts: { shell?: 'auto' | 'ask' } = {}): { app: TestApp; mem: MemoryStore; ran: string[]; dir: string } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const ran: string[] = [];
  app.tools.add(stubTool('shell', ran));
  app.tools.add(stubTool('git_push', ran));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', toolPermissions: { shell: opts.shell ?? 'auto', git_push: 'auto', write_file: 'auto' } });
  // The workspace is a repository on main (for a plain `git push`).
  const ws = join(dir, 'workspaces', 'main');
  mkdirSync(join(ws, '.git'), { recursive: true });
  writeFileSync(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return { app, mem: app.memory!, ran, dir };
}

const decide = (mem: MemoryStore, content: string, evidence: string | null = null, conversationId: string | null = null, kind: Memory['kind'] = 'decision') => mem.add({ kind, content, evidence, conversationId, sourceMessageId: null, happenedOn: '2026-10-12' });

async function drain(gen: AsyncGenerator<ChatEvent>, onApproval?: (ev: Extract<ChatEvent, { type: 'approval' }>) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval?.(ev);
  }
  return out;
}

// One clear shape each: [note, tool, args]
const SHAPES: [string, string, string, Record<string, unknown>][] = [
  ['push-branch', 'Alex wants Sara to never push to main.', 'shell', { command: 'git push origin main' }],
  ['no-push', "Alex doesn't want Sara pushing at all.", 'git_push', { branch: 'feature-x' }],
  ['force-push', 'Alex and Sara agreed: no force pushes, ever.', 'shell', { command: 'git push --force origin feature-x' }],
  ['tests-first', 'Alex wants the tests run before every push.', 'shell', { command: 'git push origin feature-x' }],
  ['path', "Alex doesn't want Sara to touch the infra/ folder.", 'shell', { command: 'rm -rf infra/old' }],
  ['package-manager', 'Alex and Sara decided to use pnpm, not npm.', 'shell', { command: 'npm install lodash' }],
  ['command', 'Alex said never to run git reset --hard.', 'shell', { command: 'git reset --hard HEAD~1' }],
];

for (const [shape, note, tool, args] of SHAPES) {
  test(`clear shape "${shape}": stops with the card in a coding chat; only flags in everyday chat`, async (t) => {
    const { app, mem, ran } = setup(t);
    const n = decide(mem, note);
    // Coding conversation: the call waits for the owner; nothing runs before the answer.
    const coding = app.store.createConversation({ mode: 'coding' });
    app.script.push([call('c1', tool, args)], text('Okay.'));
    let seen: Extract<ChatEvent, { type: 'approval' }> | undefined;
    const evs = await drain(runTurn(app, coding.id, 'go ahead'), (ev) => {
      seen = ev;
      assert.equal(ran.length, 0, 'not run before the owner answers');
      app.approvals.decide(ev.approvalId, false, 'deny');
    });
    assert.ok(seen?.contradiction, 'the approval card has the contradiction section');
    assert.equal(seen!.contradiction!.memoryId, n.id);
    assert.equal(seen!.contradiction!.rule, shape);
    assert.equal(seen!.contradiction!.note, note, 'the note is quoted as stored');
    assert.match(seen!.contradiction!.bracket, /^\[why: .*sure: high\]$/);
    const res = evs.find((e) => e.type === 'tool_result');
    assert.equal(res?.type === 'tool_result' && res.status, 'denied');
    assert.equal(ran.length, 0, "Don't: never ran");
    assert.match((app.requests[1].messages.at(-1) as { content: string }).content, /declined this action: it goes against what Alex decided/);
    // Everyday chat: no stop (the tool is Allowed), she gets a short system note and it runs.
    const everyday = app.store.createConversation();
    app.script.push([call('c2', tool, args)], text('Done.'));
    const req0 = app.requests.length;
    const evs2 = await drain(runTurn(app, everyday.id, 'go ahead'), () => assert.fail('no approval card in everyday chat'));
    const flag = evs2.find((e) => e.type === 'contradiction');
    assert.ok(flag?.type === 'contradiction' && flag.item.act === 'flag' && flag.item.status === 'flagged');
    assert.equal(ran.length, 1, 'it ran');
    const sys = app.requests[req0 + 1].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(sys, /may go against what Alex decided on 2026-10-12: "/);
    assert.match(sys, /Mention this to Alex briefly/);
  });
}

test('Do it anyway: runs, recorded on the reply meta, the tool message and the note\'s use; Update the note is kept too', async (t) => {
  const { app, mem, ran } = setup(t);
  const n = decide(mem, 'Alex wants Sara to never push to main.', 'please never push straight to main');
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('c1', 'git_push', { branch: 'main' })], text('Pushed.'));
  const evs = await drain(runTurn(app, conv.id, 'push it'), (ev) => {
    assert.equal(ev.contradiction?.quote, 'please never push straight to main');
    app.approvals.decide(ev.approvalId, true, 'override');
  });
  assert.equal(ran.length, 1, 'ran after the explicit override');
  const outcome = evs.filter((e) => e.type === 'contradiction').at(-1);
  assert.ok(outcome?.type === 'contradiction' && outcome.item.answer === 'override' && outcome.item.status === 'overridden');
  const msgs = app.store.messages(conv.id);
  const reply = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.meta?.contradictions))!;
  const c = (reply.meta!.contradictions as Contradiction[])[0];
  assert.deepEqual([c.source, c.memoryId, c.act, c.answer, c.status, c.severity, c.rule, c.clear], ['contradiction', n.id, 'stop', 'override', 'overridden', 'high', 'push-branch', true]);
  assert.equal((msgs.find((m) => m.role === 'tool')!.meta!.contradiction as Contradiction).answer, 'override');
  assert.equal(mem.get(n.id)!.useCount, 1, "the note's use counts the override");
  assert.equal(mem.get(n.id)!.lastUsedOn, '2026-10-24');

  // Update the note: never runs, kept as 'update'.
  app.script.push([call('c2', 'git_push', { branch: 'main' })], text('Okay, waiting.'));
  await drain(runTurn(app, conv.id, 'push again'), (ev) => app.approvals.decide(ev.approvalId, true, 'update'));
  assert.equal(ran.length, 1, '"update" never runs it, even sent with approved: true');
  const last = app.store.messages(conv.id).filter((m) => m.role === 'assistant' && Array.isArray(m.meta?.contradictions)).at(-1)!;
  assert.deepEqual([(last.meta!.contradictions as Contradiction[])[0].answer, (last.meta!.contradictions as Contradiction[])[0].status], ['update', 'update']);
  assert.match((app.requests.at(-1)!.messages.at(-1) as { content: string }).content, /stopped this to update the note first/);
});

test('a one-time "Do it anyway" never retires the decision (memory worker), even when the summary says so', async (t) => {
  const { app, mem } = setup(t);
  const n = decide(mem, 'Alex wants Sara to never push to main.');
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('c1', 'git_push', { branch: 'main' })], text('Pushed.'));
  await drain(runTurn(app, conv.id, 'push to main'), (ev) => app.approvals.decide(ev.approvalId, true, 'override'));
  const user = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  // The summary model reads the override as the rule changing: the code keeps the decision.
  app.script.push(text(JSON.stringify({ summary: 'Alex had Sara push to main once.', facts: [], sara: [], dates: [], decisions: [{ what: 'Alex overrode the no-push-to-main rule once.', message_id: user.id, quote: 'push to main' }], promises: [], milestones: [], kept: [], outdated: [{ note: n.id, message_id: user.id, quote: 'push to main' }] })));
  const { summarizeConversation } = await import('../src/memory-worker.ts');
  await summarizeConversation(app, mem, conv.id);
  assert.equal(mem.get(n.id)!.supersededBy, null, 'the decision still stands');
  assert.match(app.requests.at(-1)!.messages.map((m) => m.content).join('\n'), /A one-time exception is not a change/);
});

test('near misses: unrelated or non-binding notes never stop (and mostly stay quiet)', (t) => {
  const { mem, dir } = setup(t);
  for (const n of [
    'Alex pushes to main every Friday at work.',
    "Alex doesn't mind pushing to the dev branch.",
    'Alex and Sara decided to try the new gym on Mondays.',
    "Alex's team uses npm at work.",
    'Alex wants Sara to write tests for every new feature.',
    'The legacy folder holds the old PHP app.',
    'Alex is not sure whether to push to main.',
    'Alex likes pushing to main on Fridays.',
  ])
    decide(mem, n, null, null, n.startsWith('Alex and') || n.startsWith('Alex wants') ? 'decision' : 'fact');
  const ws = join(dir, 'workspaces', 'main');
  const plans: [string, Record<string, unknown>][] = [
    ['shell', { command: 'git push origin main' }],
    ['shell', { command: 'git push origin dev' }],
    ['shell', { command: 'npm install' }],
    ['write_file', { path: 'legacy/index.php', content: 'x' }],
    ['shell', { command: 'git commit -m "add tests"' }],
    ['git_push', { branch: 'main' }],
  ];
  for (const [tool, args] of plans) {
    const found = checkPlan(mem, { tool, args, callId: 'c', summary: tool, conversationId: 'x', workspaceDir: ws });
    assert.equal(found.filter((c) => c.clear).length, 0, `${tool} ${JSON.stringify(args)}: ${found.map((c) => c.note).join(' | ')}`);
    assert.notEqual(gateAct(found, { settings: { on: true, mode: 'stop' }, work: true, group: false }), 'stop');
  }
  // Rule-shaped notes vs. calls that don't do what they rule out.
  for (const [note, tool, args] of [
    ['Alex wants Sara to never push to main.', 'shell', { command: 'git pull origin main' }],
    ['Alex wants Sara to never push to main.', 'shell', { command: 'git push --dry-run origin main' }],
    ["Alex doesn't want Sara to touch the infra/ folder.", 'read_file', { path: 'infra/main.tf' }],
    ["Alex doesn't want Sara to touch the infra/ folder.", 'shell', { command: 'cat infra/main.tf' }],
    ["Alex doesn't want Sara to touch the infra/ folder.", 'write_file', { path: 'src/infra-notes.md', content: 'x' }],
    ['Alex and Sara decided to use pnpm, not npm.', 'shell', { command: 'pnpm install' }],
    ['Alex said never to run git reset --hard.', 'shell', { command: 'git reset --soft HEAD~1' }],
    ['Alex and Sara agreed to never use sudo.', 'shell', { command: 'ls /etc/sudoers.d' }],
    ["Alex doesn't want .env edited by Sara.", 'shell', { command: 'echo hi > notes/env.txt' }],
    ['Alex wants the tests run before every push.', 'shell', { command: 'pnpm test && git push origin feature-x' }],
  ] as [string, string, Record<string, unknown>][]) {
    const m = decide(mem, note);
    const found = checkPlan(mem, { tool, args, callId: 'c', summary: tool, conversationId: 'x', workspaceDir: ws }).filter((c) => c.memoryId === m.id);
    assert.deepEqual(found, [], `${note} vs ${JSON.stringify(args)}`);
    mem.delete(m.id);
  }
});

test('superseded decisions and the switch: no check; "Only mention them" never stops; setting defaults', (t) => {
  const { app, mem, dir } = setup(t);
  const ws = join(dir, 'workspaces', 'main');
  const old = decide(mem, 'Alex wants Sara to never push to main.');
  const now = decide(mem, 'Alex is fine with pushes to main now.');
  mem.supersede(old.id, now.id);
  assert.deepEqual(checkPlan(mem, { tool: 'shell', args: { command: 'git push origin main' }, callId: 'c', summary: '', conversationId: 'x', workspaceDir: ws }), []);
  const live = decide(mem, 'Alex wants Sara to never push to main.');
  const found = checkPlan(mem, { tool: 'shell', args: { command: 'git push origin main' }, callId: 'c', summary: '', conversationId: 'x', workspaceDir: ws });
  assert.equal(found[0].memoryId, live.id);
  assert.equal(gateAct(found, { settings: { on: true, mode: 'mention' }, work: true, group: false }), 'flag');
  assert.equal(gateAct(found, { settings: { on: false, mode: 'stop' }, work: true, group: false }), 'none');
  assert.equal(gateAct(found, { settings: { on: true, mode: 'stop' }, work: false, group: false }), 'flag', 'everyday chat');
  assert.equal(gateAct(found, { settings: { on: true, mode: 'stop' }, work: true, group: true }), 'flag', 'group chats never stop (no approvals mid-round)');
  assert.deepEqual(contradictSettings(app.settings.get()), { on: true, mode: 'stop' }, 'on by default, stop on clear conflicts');
  assert.deepEqual(contradictSettings({ contradict: { mode: 'weird' as 'stop' } }), { on: true, mode: 'stop' });
});

test('"never" and "ask" are unchanged: a contradiction only ever adds a stop', async (t) => {
  const { app, mem, ran } = setup(t);
  decide(mem, 'Alex wants Sara to never push to main.');
  const conv = app.store.createConversation({ mode: 'coding' });
  // never: refused as before, no card at all.
  app.settings.update({ toolPermissions: { shell: 'never', git_push: 'never' } });
  app.script.push([call('c1', 'git_push', { branch: 'main' })], text('Okay.'));
  const e1 = await drain(runTurn(app, conv.id, 'push'), () => assert.fail('never asks'));
  const r1 = e1.find((e) => e.type === 'tool_result');
  assert.equal(r1?.type === 'tool_result' && r1.status, 'denied');
  assert.equal(ran.length, 0);
  // ask, no conflict: the plain card (no contradiction section), Allow runs it.
  app.settings.update({ toolPermissions: { shell: 'ask', git_push: 'ask' } });
  app.script.push([call('c2', 'shell', { command: 'ls' })], text('Okay.'));
  await drain(runTurn(app, conv.id, 'look'), (ev) => {
    assert.equal(ev.contradiction, undefined);
    app.approvals.decide(ev.approvalId, true);
  });
  assert.deepEqual(ran, ['ls']);
  // ask + a conflict in everyday chat: the usual card, no section, plus the flag.
  const everyday = app.store.createConversation();
  app.script.push([call('c3', 'shell', { command: 'git push origin main' })], text('Okay.'));
  const e3 = await drain(runTurn(app, everyday.id, 'push'), (ev) => {
    assert.equal(ev.contradiction, undefined, 'everyday chat: no stop added');
    app.approvals.decide(ev.approvalId, false);
  });
  assert.ok(e3.some((e) => e.type === 'contradiction'));
  // Switched off: auto runs without anything.
  app.settings.update({ toolPermissions: { shell: 'auto', git_push: 'auto' }, contradict: { on: false } });
  app.script.push([call('c4', 'shell', { command: 'git push origin main' })], text('Okay.'));
  const e4 = await drain(runTurn(app, conv.id, 'push'), () => assert.fail('off: no stop'));
  assert.ok(!e4.some((e) => e.type === 'contradiction'));
  assert.deepEqual(ran, ['ls', 'git push origin main']);
});

test('other apps never see private, imported or adult-channel notes; shared notes still count (same rules as their approvals)', async (t) => {
  const { app, mem } = setup(t);
  const priv = app.store.createConversation({ private: true });
  const imported = app.store.createConversation({ channel: 'import-chatgpt' });
  const adult = app.store.createConversation({ channel: 'discord-nsfw' });
  for (const c of [priv, imported, adult]) decide(mem, 'Alex wants Sara to never push to main.', null, c.id);
  const api = app.store.createConversation({ channel: 'api' });
  app.script.push([call('c1', 'shell', { command: 'git push origin main' })], text('Okay.'));
  const e1 = await drain(runTurn(app, api.id, 'push', undefined, { externalApp: true } as never));
  assert.ok(!e1.some((e) => e.type === 'contradiction'), 'notes from private/imported/adult chats stay out');
  // The same rule from a shared place is used (another app's chat is everyday chat: a flag).
  decide(mem, 'Alex wants Sara to never push to main.');
  app.script.push([call('c2', 'shell', { command: 'git push origin main' })], text('Okay.'));
  const e2 = await drain(runTurn(app, api.id, 'push', undefined, { externalApp: true } as never), () => assert.fail('no stop added for other apps'));
  const f = e2.find((e) => e.type === 'contradiction');
  assert.ok(f?.type === 'contradiction' && f.item.memoryId !== undefined && f.item.act === 'flag');
});

test('work channels stop like coding chats; a household member only meets their own notes', async (t) => {
  const { app, mem, ran } = setup(t);
  decide(mem, 'Alex wants Sara to never push to main.');
  const work = app.store.createConversation({ channel: 'discord-work', channelKey: 'x' });
  app.script.push([call('c1', 'shell', { command: 'git push origin main' })], text('Okay.'));
  let stopped = false;
  await drain(runTurn(app, work.id, 'push'), (ev) => {
    stopped = Boolean(ev.contradiction);
    app.approvals.decide(ev.approvalId, false);
  });
  assert.ok(stopped, 'work channel: stop');
  // A member's space is its own data folder (own memory): the owner's decision is not there.
  const member = setup(t);
  const conv = member.app.store.createConversation({ mode: 'coding' });
  member.app.script.push([call('c1', 'shell', { command: 'git push origin main' })], text('Okay.'));
  const evs = await drain(runTurn(member.app, conv.id, 'push'), () => assert.fail("the owner's decision isn't the member's"));
  assert.ok(!evs.some((e) => e.type === 'contradiction'));
  assert.equal(member.ran.length, 1);
  assert.equal(ran.length, 0);
});

test('performance: the check adds < 20 ms per tool call with 10,000 notes', (t) => {
  const { app, mem, dir } = setup(t);
  const words = ['garden', 'piano', 'tomato', 'cycling', 'budget', 'recipe', 'holiday', 'library', 'neighbour', 'coffee', 'deploy', 'branch', 'folder', 'config', 'tests'];
  app.store.db.exec('BEGIN');
  for (let i = 0; i < 10_000; i++) {
    const w = (k: number) => words[(i * 7 + k * 3) % words.length];
    const kind: Memory['kind'] = i % 10 === 0 ? 'decision' : 'fact';
    mem.add({ kind, content: `${i % 10 === 0 ? 'Alex decided' : 'Alex said'} something about the ${w(1)} and the ${w(2)} (${i}).`, conversationId: null, sourceMessageId: null, happenedOn: '2026-01-01' });
  }
  app.store.db.exec('COMMIT');
  decide(mem, 'Alex wants Sara to never push to main.');
  const ws = join(dir, 'workspaces', 'main');
  const input = { tool: 'shell', args: { command: 'git push origin main' }, callId: 'c', summary: '$ git push origin main', conversationId: 'x', workspaceDir: ws };
  checkPlan(mem, input); // warm (prepared statements, rule cache)
  const ms: number[] = [];
  // 15 checks, the median compared: the full suite runs files in parallel, so a few slow samples on
  // a loaded machine don't fail it (it measured 21.6 ms once in a full run, ~7 ms alone).
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const found = checkPlan(mem, { ...input, args: { command: i % 2 ? 'git push origin main' : 'write the tests for the garden budget' } });
    ms.push(performance.now() - t0);
    if (i % 2) assert.ok(found.some((c) => c.clear));
  }
  ms.sort((a, b) => a - b);
  // Target 20 ms (about 7 ms alone); the full suite on the shared server measured 20.4 and 21.6 ms, so
  // the bound leaves room for a loaded machine.
  // T44 (D5): the fastest of the 15 says what the check costs; the median says how busy the machine
  // was (3.42.0 on a server with a load of 20 failed on the median alone).
  assert.ok(ms[0] < 20, `best ${ms[0].toFixed(1)} ms, median ${ms[7].toFixed(1)} ms`);
});

test('parsing: the clear shapes in other words, and plans read in code', () => {
  const shapes = (s: string) => parseRules(s).map((r) => `${r.shape}:${r.target.join(',')}${r.exact === false ? '~' : ''}`);
  assert.deepEqual(shapes("Don't push directly to master, use a PR."), ['push-branch:master']);
  assert.deepEqual(shapes('All changes to main only through pull requests.'), ['push-branch:main']);
  assert.deepEqual(shapes('Pushes to main are not allowed.'), ['push-branch:main']);
  assert.deepEqual(shapes('never push to main without running the tests'), ['tests-first:']);
  assert.deepEqual(shapes('Leave config/prod.yaml alone.'), ['path:config/prod.yaml']);
  assert.deepEqual(shapes('The migrations folder is off-limits.'), ['path:migrations']);
  assert.deepEqual(shapes('Use yarn instead of npm.'), ['package-manager:npm']);
  assert.deepEqual(shapes("Don't npm publish without asking."), ['command:npm,publish']);
  assert.deepEqual(shapes('Never commit with --no-verify.'), ['command:--no-verify']);
  assert.deepEqual(shapes("Alex doesn't want Sara to change the billing code."), ['path:billing~']);
  for (const s of ['Alex likes pushing to main on Fridays.', 'Alex is not sure whether to push to main.', "Alex doesn't mind npm.", 'Alex decided never to deploy the billing service on Fridays.']) assert.deepEqual(parseRules(s).filter((r) => r.exact !== false), [], s);
  const seg = shellSegments('cd shop && FOO=1 sudo npm i "a b" ; echo x > out.txt');
  assert.deepEqual(seg.map((x) => [x.prog, x.cwd, x.join]), [['cd', '', ''], ['npm', 'shop', '&&'], ['echo', 'shop', ';']]);
  assert.deepEqual(seg[1].words, ['FOO=1', 'sudo', 'npm', 'i', 'a b']);
  const p = planOf('shell', { command: 'cd app && git -C sub push -f origin HEAD:main +dev' });
  assert.deepEqual([p.pushes[0].branches, p.pushes[0].force], [['main', 'dev'], true]);
  assert.deepEqual(planOf('shell', { command: 'sed -i s/a/b/ src/x.js && rm -rf "infra/old dir"' }).changes, ['src/x.js', 'infra/old dir']);
  assert.deepEqual(planOf('write_file', { path: 'README.md', content: 'never push to main' }).pushes, [], 'file contents are not the plan');
});

test('routes: Settings switch + strictness (clamped), approvals take how', async (t) => {
  const { app, mem } = setup(t, { shell: 'auto' });
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const j = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers: H });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual((await j('/tools')).body.contradict, { on: true, mode: 'stop' });
  assert.equal((await j('/tools', { method: 'PUT', body: JSON.stringify({ contradict: { on: false, mode: 'mention' } }) })).status, 200);
  assert.deepEqual((await j('/tools')).body.contradict, { on: false, mode: 'mention' });
  await j('/tools', { method: 'PUT', body: JSON.stringify({ contradict: { on: true, mode: 'bogus' } }) });
  assert.deepEqual(app.settings.get().contradict, { on: true, mode: 'mention' }, 'an unknown mode keeps the current one');
  assert.equal((await j('/tools', { method: 'PUT', body: JSON.stringify({ contradict: 'yes' }) })).status, 400);
  // The card's three buttons reach the turn through the approvals route.
  app.settings.update({ contradict: { on: true, mode: 'stop' } });
  decide(mem, 'Alex wants Sara to never push to main.');
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('c1', 'shell', { command: 'git push origin main' })], text('Okay.'));
  await drain(runTurn(app, conv.id, 'push'), (ev) => {
    void j(`/approvals/${ev.approvalId}`, { method: 'POST', body: JSON.stringify({ approved: false, how: 'update' }) });
  });
  const c = (app.store.messages(conv.id).find((m) => Array.isArray(m.meta?.contradictions))!.meta!.contradictions as Contradiction[])[0];
  assert.equal(c.answer, 'update');
});

test('web: the setting, the card section and flags use t(), theme tokens and the icon set; sw cache bumped', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const html = web('index.html');
  assert.match(html, /id="contradict-on"/);
  assert.match(html, /<select id="contradict-mode"><option value="stop">Stop on clear conflicts<\/option><option value="mention">Only mention them<\/option><\/select>/);
  const tips = JSON.parse(web('tips.json')).tips;
  for (const id of ['contradict-on', 'contradict-mode']) assert.ok(tips[id] && tips[id][0].length <= 260 && tips[id][1] === 'plan-check', id);
  assert.match(web('help.html'), /id="plan-check"/);
  const app = web('app.js');
  for (const s of ["t('This goes against something you decided')", "t('Do it anyway')", 't("Don\'t")', "t('Update the note')", "iconSpan('contradict-icon', 'warn')", "how === 'update' && c"]) assert.ok(app.includes(s), s);
  const css = web('ui-tidy.css').split('Phase 77')[1] ?? '';
  assert.ok(css.length > 100);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgb\(/i, 'theme tokens only');
  assert.match(web('sw.js'), /sara-shell-v10/);
});
