// T46 C4: team helpers follow the rules of her own turns (src/team.ts): the history is kept to the
// model's budget, an empty reply is not a finished part, and the time limit ends a long call.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ChatMessage } from '../src/providers/types.ts';
import { fitHelperHistory, LEFT_OUT_NOTE, TaskClock, TeamManager, teamTiming } from '../src/team.ts';
import { readFileTool } from '../src/tools/builtin.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-24T15:00:00Z') };
const app = makeApp(dir, clock);
app.tools.add(readFileTool);
// A tool that takes as long as the test says, and stops when it is told to.
const slow = { ms: 0, runs: 0, stopped: 0 };
const waitTool: Tool = {
  spec: { name: 'wait_tool', description: 'Waits.', parameters: { type: 'object', properties: {} } },
  defaultPermission: 'auto',
  summarize: () => 'wait',
  run: (_args, ctx) =>
    new Promise<string>((resolve, reject) => {
      slow.runs++;
      const timer = setTimeout(() => resolve('waited'), slow.ms);
      ctx.signal.addEventListener('abort', () => {
        slow.stopped++;
        clearTimeout(timer);
        reject(new Error('stopped'));
      }, { once: true });
    }),
} as Tool;
app.tools.add(waitTool);
app.team = new TeamManager(app, app.store.db);
const HELPERS = [{ id: 'waiter', name: 'Waiter', role: 'researcher' as const, tools: ['wait_tool', 'read_file'] }];
const BASE = {
  providers: [{ id: 'p', label: 'P', kind: 'openai-compatible' as const, baseUrl: 'http://x' }],
  defaultProviderId: 'p',
  defaultModel: 'm',
  ownerName: 'Alex',
  timeZone: 'America/Chicago',
  disclosureAcceptedAt: clock.now.toISOString(),
  toolPermissions: { wait_tool: 'auto', read_file: 'auto' } as Record<string, 'auto' | 'ask' | 'never'>,
  helpers: HELPERS,
};
before(() => {
  app.settings.update(BASE);
});
after(() => {
  teamTiming.minuteMs = 60_000;
  app.store.close();
  cleanup();
});
const plan = [{ helper: 'waiter', title: 'One part', instructions: 'Do the part.' }];
const logOf = (id: number) => app.team!.log(id).map((l) => l.text);
const size = (ms: ChatMessage[]) => ms.reduce((n, m) => n + m.content.length, 0);
/** Every tool result sits after the request that asked for it. */
function paired(ms: ChatMessage[]): boolean {
  const asked = new Set<string>();
  for (const m of ms) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) asked.add(c.id);
    if (m.role === 'tool' && !asked.has(m.toolCallId)) return false;
  }
  return true;
}

test('history: the instructions and the task stay, the oldest moves go, a note names the tools already run', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'Your part: read things' }];
  const ran: string[] = [];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `f${i}` } }] });
    messages.push({ role: 'tool', toolCallId: `c${i}`, name: 'read_file', content: `${i}:${'x'.repeat(3000)}` });
    ran.push('read_file');
  }
  const left = fitHelperHistory(messages, 20_000, ran);
  assert.ok(left > 0);
  assert.equal(messages[0]!.content, 'rules');
  assert.equal(messages[1]!.content, 'Your part: read things');
  assert.ok(messages[2]!.content.startsWith(LEFT_OUT_NOTE));
  assert.match(messages[2]!.content, /already ran: read_file \(\d+ times\)\. Do not run those again\./);
  assert.ok(size(messages) < 24_000, `fits: ${size(messages)}`);
  assert.ok(paired(messages));
  assert.match(messages.at(-1)!.content, /^19:/, 'the newest result is still there');
  // A second pass with nothing new keeps one note, not two.
  fitHelperHistory(messages, 20_000, ran);
  assert.equal(messages.filter((m) => m.content.startsWith(LEFT_OUT_NOTE)).length, 1);
  // Room for everything: nothing is touched.
  const small: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
  assert.equal(fitHelperHistory(small, 20_000), 0);
  assert.equal(small.length, 3);
});

test('a long part: what is sent to the model stays inside the history budget over many moves', async () => {
  app.settings.update({ historyBudgetMode: 'fixed', historyBudgetChars: 20_000 });
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'big.txt'), Array.from({ length: 150 }, (_, i) => `line ${i} ${'y'.repeat(60)}`).join('\n'));
  app.requests.length = 0;
  for (let i = 0; i < 18; i++) app.script.push([call(`r${i}`, 'read_file', { path: 'big.txt' })]);
  app.script.push(text('Read the file many times; nothing else to report.'), text('Report.'));
  const t = app.team!.start(conv.id, 'Read big.txt again and again.', { plan });
  const done = await app.team!.finished(t.id);
  assert.equal(done.status, 'done', JSON.stringify(logOf(t.id)));
  assert.equal(done.steps[0]!.receipts.length, 18);
  const mine = app.requests.filter((r) => /^You are Waiter/.test(String(r.messages[0]?.content)));
  assert.equal(mine.length, 19);
  const one = mine[1]!.messages.at(-1)!.content.length;
  assert.ok(one > 8000, `each result is big (${one})`);
  // Without a budget the last call would carry six whole results and twelve shortened ones.
  for (const r of mine) assert.ok(size(r.messages) < 30_000, `a call of ${size(r.messages)} characters`);
  const last = mine.at(-1)!.messages;
  assert.match(String(last[1]!.content), /Your part: One part/);
  assert.ok(last.some((m) => m.content.startsWith(LEFT_OUT_NOTE) && /read_file \(\d+ times\)/.test(m.content)));
  assert.ok(paired(last));
  app.settings.update({ historyBudgetMode: 'auto', historyBudgetChars: undefined });
});

test('two empty replies and no tool used: the part fails, it does not pass as done', async () => {
  const conv = app.store.createConversation({ mode: 'coding' });
  // Only private reasoning counts as empty too.
  app.script.push(text('<think>what should I do</think>'), text(''), text('Report.'));
  const t = app.team!.start(conv.id, 'Do one thing and report.', { plan });
  const done = await app.team!.finished(t.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps[0]!.status, 'failed');
  assert.match(done.steps[0]!.report ?? '', /sent an empty reply twice and used no tool/);
  assert.ok(logOf(t.id).some((l) => /sent an empty reply; asked again/.test(l)));
});

test('one empty reply, then words: asked once more and the report is taken', async () => {
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push(text(''), text('Nothing needed doing.'), text('Report.'));
  const t = app.team!.start(conv.id, 'Do one thing and report.', { plan });
  const done = await app.team!.finished(t.id);
  assert.equal(done.status, 'done', JSON.stringify(logOf(t.id)));
  assert.equal(done.steps[0]!.report, 'Nothing needed doing.');
});

test('two empty replies after real work: the part is done, with no report', async () => {
  slow.ms = 0;
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('w1', 'wait_tool', {})], text(''), text(''), text('Report.'));
  const t = app.team!.start(conv.id, 'Do one thing and report.', { plan });
  const done = await app.team!.finished(t.id);
  assert.equal(done.status, 'done', JSON.stringify(logOf(t.id)));
  assert.equal(done.steps[0]!.report, '(no report)');
  assert.equal(done.steps[0]!.receipts.length, 1);
});

test('two empty replies with a backup model set: the backup takes over and writes the report', async () => {
  app.settings.update({ defaultFallbacks: [{ providerId: 'p', model: 'backup' }] });
  const conv = app.store.createConversation({ mode: 'coding' });
  app.requests.length = 0;
  app.script.push(text(''), text(''), text('The backup did the part.'), text('Report.'));
  const t = app.team!.start(conv.id, 'Do one thing and report.', { plan });
  const done = await app.team!.finished(t.id);
  app.settings.update({ defaultFallbacks: [] });
  assert.equal(done.status, 'done', JSON.stringify(logOf(t.id)));
  assert.equal(done.steps[0]!.report, 'The backup did the part.');
  assert.ok(logOf(t.id).some((l) => /P \(m\) sent an empty reply twice, so P \(backup\) took over/.test(l)));
  const mine = app.requests.filter((r) => /^You are Waiter/.test(String(r.messages[0]?.content)));
  assert.deepEqual(mine.map((r) => r.model), ['m', 'm', 'backup']);
});

test('the time limit ends a model call that never answers', async () => {
  teamTiming.minuteMs = 150; // the shortest limit (2 minutes) lasts 300 ms
  const conv = app.store.createConversation({ mode: 'coding' });
  const orig = app.providerFactory!;
  app.providerFactory = (config) => ({
    config,
    listModels: async () => [],
    stream: (req) =>
      (async function* () {
        if (/^You are Waiter/.test(String(req.messages[0]?.content))) await new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(req.signal!.reason), { once: true }));
        yield { type: 'text' as const, text: 'Report.' };
      })(),
  });
  const t0 = Date.now();
  const t = app.team!.start(conv.id, 'Something that hangs.', { limits: { minutes: 2 }, plan });
  const done = await app.team!.finished(t.id);
  app.providerFactory = orig;
  teamTiming.minuteMs = 60_000;
  assert.equal(done.status, 'limit', JSON.stringify(logOf(t.id)));
  assert.ok(Date.now() - t0 < 5000, 'it did not wait for the model');
  assert.ok(logOf(t.id).some((l) => /Stopped at the time limit \(2 minutes\)/.test(l)));
  assert.equal(done.steps[0]!.status, 'waiting', 'the part can run again with more budget');
});

test('the time limit ends a tool call that runs long', async () => {
  teamTiming.minuteMs = 150;
  slow.ms = 20_000;
  slow.runs = 0;
  slow.stopped = 0;
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('w1', 'wait_tool', {})], text('Report.'));
  const t0 = Date.now();
  const t = app.team!.start(conv.id, 'Something with a long tool.', { limits: { minutes: 2 }, plan });
  const done = await app.team!.finished(t.id);
  teamTiming.minuteMs = 60_000;
  slow.ms = 0;
  app.script.length = 0;
  assert.equal(done.status, 'limit', JSON.stringify(logOf(t.id)));
  assert.ok(Date.now() - t0 < 5000, 'it did not wait for the tool');
  assert.equal(slow.runs, 1);
  assert.equal(slow.stopped, 1, 'the tool was told to stop');
});

test('time waiting for the owner on an approval card is not the task\'s time', async () => {
  teamTiming.minuteMs = 400; // 2 minutes last 800 ms
  slow.ms = 0;
  app.settings.update({ toolPermissions: { ...BASE.toolPermissions, wait_tool: 'ask' } });
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('w1', 'wait_tool', {})], text('Waited as asked.'), text('Report.'));
  const t = app.team!.start(conv.id, 'Something that asks first.', { limits: { minutes: 2 }, plan });
  for (let i = 0; i < 100 && !app.team!.approvals(t.id).length; i++) await new Promise((r) => setTimeout(r, 10));
  const [pending] = app.team!.approvals(t.id);
  assert.equal(pending?.tool, 'wait_tool');
  // The owner takes longer than the whole limit to answer.
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(app.team!.get(t.id)!.status, 'running', 'the card is still open');
  assert.equal(app.approvals.decide(pending!.id, true), true);
  const done = await app.team!.finished(t.id);
  teamTiming.minuteMs = 60_000;
  app.settings.update({ toolPermissions: BASE.toolPermissions });
  assert.equal(done.status, 'done', JSON.stringify(logOf(t.id)));
  assert.equal(done.steps[0]!.report, 'Waited as asked.');
});

test('the task clock: stands still during a wait, and an armed limit fires on the task\'s own time', async () => {
  const c = new TaskClock();
  let up = 0;
  const off = c.arm(120, () => up++);
  await c.wait(new Promise((r) => setTimeout(r, 300)));
  assert.equal(up, 0, 'not during the wait');
  assert.ok(c.used() < 100, `the wait is not counted (${c.used()})`);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(up, 1);
  off();
  const c2 = new TaskClock();
  let up2 = 0;
  c2.arm(50, () => up2++)();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(up2, 0, 'called off');
});
