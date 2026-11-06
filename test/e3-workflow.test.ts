// E3 (docs/ops/E3_DESIGN.md): a demonstrated engineering workflow through the real chat loop. One
// coding turn edits the fixture page, runs it as a job (approved once), previews it, looks at it in
// the testing browser (the fake CDP server) at phone and desktop width, fixes what is wrong, checks
// again and reports. Plus: a skipped re-check or a desktop-only shot is marked unverified,
// find_tools finds the screenshot and preview tools from the lean list, and a team part keeps the
// same approvals and receipts.
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserManager, type BrowserInfo, type LaunchedBrowser } from '../src/browser.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { JobManager } from '../src/jobs.ts';
import { DEFAULT_LEAN, FIND_TOOLS, findToolsTool, leanFor } from '../src/lean.ts';
import { PreviewManager } from '../src/preview.ts';
import type { StreamEvent } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { TeamManager } from '../src/team.ts';
import { editFileTool, listDir, readFileTool, writeFileTool } from '../src/tools/builtin.ts';
import { createBrowserTools } from '../src/tools/browser.ts';
import { createCodingTools } from '../src/tools/coding.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, fakeCdp, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const FIXTURE = join(ROOT, 'test', 'fixtures', 'e3-page');
const NODE = JSON.stringify(process.execPath);
const SERVE = `${NODE} -e "setInterval(() => {}, 1000)"`;
const OVERFLOW = [{ ok: false, detail: 'page 600px wide, window 390px' }];
const NOT_SAVED = [{ ok: false, detail: 'no visible text "Saved"' }];
const PASS = [{ ok: true }, { ok: true }];
const FIXED_CSS = readFileSync(join(FIXTURE, 'style.css'), 'utf8').replace('width: 600px', 'max-width: 100%');
const FIXED_JS = readFileSync(join(FIXTURE, 'app.js'), 'utf8').replace('#save-button', '#save');

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, checks: { ok: boolean; detail?: string }[][]) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-06T15:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  app.runs = new RunStore(app.store.db, () => clock.now);
  app.jobs = new JobManager(app, app.store.db);
  for (const x of [listDir, readFileTool, writeFileTool, editFileTool, ...createCodingTools(app), ...createBrowserTools(app)]) app.tools.add(x);
  const cdp = await fakeCdp({ checks });
  const launcher = async (): Promise<LaunchedBrowser> => ({ wsUrl: cdp.url, kill: () => {}, exited: Promise.resolve() });
  const info: BrowserInfo = { found: true, path: '/fake/chrome', kind: 'chrome', name: 'Fake', how: '' };
  // The job is a real process; the fake browser stands in for it answering on the port.
  app.previews = new PreviewManager({ owns: async () => true });
  app.browsers = new BrowserManager({ info: () => info, sandbox: () => app.sandbox, previews: app.previews, launcher, idleMs: 60_000 });
  const conv = app.store.createConversation({ title: 'notes page', mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  cpSync(FIXTURE, ws, { recursive: true });
  t.after(async () => {
    // Stop the job (a stopped job is not announced) and let it finish writing before the store closes.
    const ids = app.jobs!.running().map((j) => j.id);
    app.jobs!.stopAll();
    for (let i = 0; i < 400 && ids.some((id) => app.jobs!.get(id)?.status === 'running'); i++) await new Promise((r) => setTimeout(r, 25));
    await app.browsers?.closeAll();
    cdp.close();
    app.store.close();
    await new Promise((r) => setTimeout(r, 200));
    cleanup();
  });
  return { app, conv, ws, cdp };
}

/** Runs one owner turn, answering approvals yes; the preview link goes into the scripted browser_open calls. */
async function turn(app: TestApp, convId: string, msg: string): Promise<ChatEvent[]> {
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, convId, msg)) {
    evs.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, true);
    if (ev.type === 'tool_result' && ev.name === 'preview_start') {
      const link = /\/preview\/[0-9a-f]{32}\//.exec(ev.output)?.[0];
      for (const step of app.script) for (const e of step) if (e.type === 'tool_call' && e.call.arguments.url === 'LINK') e.call.arguments.url = link;
    }
  }
  return evs;
}

/** The scripted coding turn of the design, one tool per model step. */
function script(o: { recheck: boolean; final: string }): StreamEvent[][] {
  const s: StreamEvent[][] = [
    [call('r1', 'read_file', { path: 'style.css' })],
    [call('j1', 'start_job', { command: SERVE, label: 'serve the page' })],
    [call('p1', 'preview_start', { port: 5173 })],
    [call('o1', 'browser_open', { url: 'LINK' })],
    [call('s1', 'browser_screenshot', { width: 'phone' })],
    [call('k1', 'browser_check', { checks: [{ type: 'no_horizontal_scroll' }] })],
    [call('w1', 'write_file', { path: 'style.css', content: FIXED_CSS })],
    [call('c1', 'browser_click', { text: 'Save' })],
    [call('k2', 'browser_check', { checks: [{ type: 'text_visible', text: 'Saved' }] })],
    [call('w2', 'write_file', { path: 'app.js', content: FIXED_JS })],
    [call('o2', 'browser_open', { url: 'LINK' })],
  ];
  if (o.recheck)
    s.push(
      [call('s2', 'browser_screenshot', { width: 'phone' })],
      [call('s3', 'browser_screenshot', { width: 'desktop' })],
      [call('k3', 'browser_check', { checks: [{ type: 'no_horizontal_scroll' }, { type: 'text_visible', text: 'Saved' }] })],
    );
  else s.push([call('s3', 'browser_screenshot', { width: 'desktop' })]);
  s.push(text(o.final));
  return s;
}

const RECHECKED = 'The Save button was 600px wide and overflowed at phone width, and the click did nothing because app.js used the wrong selector. I fixed both in style.css and app.js. I checked it again at phone and desktop width: no sideways scroll, and "Saved" shows after the click.';

test('edit, render, inspect, correct at phone and desktop (scripted)', async (t) => {
  const { app, conv, ws } = await setup(t, [OVERFLOW, NOT_SAVED, PASS]);
  app.script.push(...script({ recheck: true, final: RECHECKED }));
  const evs = await turn(app, conv.id, 'Fix the notes page so it works on a phone, and check it in your browser.');
  // Tool order and statuses in the run record.
  const run = app.runs!.list({ conversationId: conv.id }).find((r) => r.kind === 'turn')!;
  const tools = app.runs!.steps(run.id).flatMap((s) => s.tools);
  assert.deepEqual(
    tools.map((x) => `${x.name}:${x.status}`),
    ['read_file', 'start_job', 'preview_start', 'browser_open', 'browser_screenshot', 'browser_check', 'write_file', 'browser_click', 'browser_check', 'write_file', 'browser_open', 'browser_screenshot', 'browser_screenshot', 'browser_check'].map((n) => `${n}:ok`),
  );
  assert.match(tools[5].output, /^FAIL no_horizontal_scroll/m);
  assert.match(tools[8].output, /^FAIL text_visible "Saved"/m);
  assert.match(tools[13].output, /^PASS no_horizontal_scroll\nPASS text_visible "Saved"/m);
  // The run receipts list both files, and both are really fixed.
  assert.deepEqual([...new Set(tools.flatMap((x) => x.files ?? []))].sort(), ['app.js', 'style.css']);
  assert.equal(readFileSync(join(ws, 'style.css'), 'utf8'), FIXED_CSS);
  assert.equal(readFileSync(join(ws, 'app.js'), 'utf8'), FIXED_JS);
  // The approval card appeared exactly once: start_job.
  assert.deepEqual(evs.filter((e) => e.type === 'approval').map((e) => (e as { name: string }).name), ['start_job']);
  // Screenshots reached the model next to their tool results (the two newest are sent again).
  const last = app.requests.at(-1)!;
  const shots = last.messages.filter((m) => m.role === 'tool' && m.name === 'browser_screenshot') as { images?: { mime: string }[] }[];
  assert.equal(shots.length, 3);
  assert.ok(shots.filter((m) => m.images?.[0]?.mime === 'image/png').length >= 2);
  // The proof strip on her reply, and the reply is not marked unverified.
  const final = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal((final.meta?.proof as string[] | undefined)?.length, 3);
  assert.ok(evs.filter((e) => e.type === 'proof').length >= 3);
  assert.match(final.content, /I fixed both in style\.css and app\.js/);
  assert.equal(final.meta?.unverified, undefined);
});

test('skipped re-check is marked unverified', async (t) => {
  // No look after the last edit (only a desktop shot), yet "fixed, looks right now at phone width".
  const { app, conv } = await setup(t, [OVERFLOW, NOT_SAVED]);
  app.script.push(...script({ recheck: false, final: 'I fixed the overflow and the Save click in style.css and app.js. I checked it at phone width and it looks right now.' }));
  // Her correction when the check asks for one.
  app.script.push(text('Correction: after the fix I only took a desktop screenshot, so I have not checked phone width yet.'));
  const evs = await turn(app, conv.id, 'Fix the notes page so it works on a phone.');
  const cc = evs.find((e) => e.type === 'claim_check') as Extract<ChatEvent, { type: 'claim_check' }>;
  assert.deepEqual(cc.claims.map((c) => `${c.kind}: ${c.sentence}`), ['browser: I checked it at phone width and it looks right now.']);
  const marked = app.store.messages(conv.id).find((m) => m.id === cc.messageId)!;
  assert.deepEqual((marked.meta?.unverified as { sentence: string }[]).map((c) => c.sentence), ['I checked it at phone width and it looks right now.'], 'marked, not blocked');
});

test('find_tools loads screenshot and preview from the lean list', async (t) => {
  const { app } = await setup(t, []);
  // As runTurn does: find_tools is registered once.
  app.tools.add(findToolsTool());
  const all = app.tools.enabled(undefined);
  const tt = leanFor({ ...DEFAULT_LEAN.tools, aboveTokens: 0 }, all, { text: 'make the page nicer', mode: 'coding', local: false, turnId: 1, ownerTurnIds: [1] });
  assert.equal(tt.lean, true, 'lean');
  assert.ok(tt.offered.has(FIND_TOOLS), [...tt.offered].join());
  assert.ok(!tt.offered.has('browser_screenshot'), 'not offered up front');
  const shot = tt.find({ query: 'screenshot at phone width' }, 'Alex');
  assert.match(shot, /Loaded for your next step[^\n]*browser_screenshot/);
  const prev = tt.find({ query: 'preview the web app' }, 'Alex');
  assert.match(prev, /preview_start/);
  assert.ok(tt.offered.has('browser_screenshot') && tt.offered.has('preview_start'));
});

test('team part editing a page keeps approvals and receipts', async (t) => {
  const { app, conv, ws } = await setup(t, [PASS]);
  app.team = new TeamManager(app, app.store.db);
  // The owner's own designer helper with the page tools; writing a file asks first here.
  app.settings.update({
    helpers: [{ id: 'pager', name: 'Pager', role: 'designer', tools: ['read_file', 'write_file', 'preview_start', 'browser_open', 'browser_screenshot', 'browser_check'] }],
    toolPermissions: { write_file: 'ask' },
  } as never);
  // A running job to preview (started outside the team, as she would).
  app.jobs!.start({ conversationId: conv.id, workspace: conv.workspace, label: 'serve the page', command: SERVE, recoveryIntent: { kind: 'command', command: SERVE }, timeoutMs: 60_000, sandbox: app.sandbox });
  app.script.push(
    [call('w1', 'write_file', { path: 'style.css', content: FIXED_CSS })],
    [call('p1', 'preview_start', { port: 5173 })],
    // The helper never looks at the page, yet says it checked it at phone width (and again when asked to correct).
    text('I fixed the Save button in style.css. I checked it at phone width and it fits now.'),
    text('I fixed the Save button in style.css. I checked it at phone width and it fits now.'),
    text('The designer changed style.css.'),
  );
  const task = app.team!.start(conv.id, 'Make the Save button fit on a phone.', { plan: [{ helper: 'pager', title: 'Fix the button', instructions: 'Fix style.css so the button fits at 390px.' }] });
  for (let i = 0; i < 100 && !app.team!.approvals(task.id).length; i++) await new Promise((r) => setTimeout(r, 20));
  const pending = app.team!.approvals(task.id);
  assert.deepEqual(pending.map((p) => p.tool), ['write_file'], 'the same approval rule as hers');
  app.approvals.decide(pending[0].id, true);
  const done = await app.team!.finished(task.id);
  const step = done.steps[0];
  assert.deepEqual(step.receipts.map((r) => `${r.name}:${r.status}`), ['write_file:ok', 'preview_start:ok']);
  assert.equal(readFileSync(join(ws, 'style.css'), 'utf8'), FIXED_CSS);
  // Her claim checks apply to the helper too: no phone screenshot, so the claim is left out.
  assert.ok(step.unverified.some((s) => /phone width/.test(s)), JSON.stringify(step));
});
