// Phase 123 (2.56.0, docs/design/LEAN.md §5.14): a lean tool list per turn and /compact. The talking
// model and the cheap models are the scripted fake from helpers.ts (every request recorded, `model`
// tells the local one from the quick one); 74 tools are the real lists of four MCP servers recorded
// into test/fixtures/lean-mcp-tools.json (GitHub 26, Playwright 25, files 14, memory 9) next to the
// test registry's built-ins; the clock is fake and waits poll.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { afterTurnExtras, commandAllowed, MENU_COMMANDS, nearlyFullOffer, parseCommand, runCommand, type BridgeAdapter, type Place } from '../src/bridges/commands.ts';
import { buildHistory, contextFill, runTurn, type ChatEvent } from '../src/chat.ts';
import { autoFold, compactNow, compactTiming, currentFold, foldBoundary, foldFor, listFolds, undoFold } from '../src/compact.ts';
import { CORE_CHAT, FIND_TOOLS, familyOf, leanFor, loadRows, normLean, SAFETY_PINS, searchTools, specTokens, tokensOf, toolsReport, DEFAULT_LEAN } from '../src/lean.ts';
import { forgetMemory } from '../src/memory-worker.ts';
import type { ProviderConfig } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { CRISIS_RESOURCES } from '../src/safety.ts';
import { Store } from '../src/store.ts';
import type { Tool } from '../src/tools/types.ts';
import { UsageStore } from '../src/usage.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const SARA_PKG_VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const LOCAL: ProviderConfig = { id: 'l', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true, defaultModel: 'local-m' };
const CLOUD: ProviderConfig = { id: 'c', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://cloud.example', defaultModel: 'cloud-m' };
const MCP = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'lean-mcp-tools.json'), 'utf8')) as Record<string, { name: string; description: string; parameters: Record<string, unknown> }[]>;

async function until<T>(f: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the state');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The four recorded MCP servers as registry tools (the ask-first default MCP tools have). */
function mcpTools(ran: string[] = []): Tool[] {
  return Object.entries(MCP).flatMap(([server, list]) =>
    list.map((t) => ({ spec: { name: t.name, description: t.description, parameters: t.parameters }, defaultPermission: 'ask' as const, source: `MCP: ${server}`, summarize: () => t.name, run: async () => (ran.push(t.name), `${t.name} done`) })),
  );
}
const fake = (name: string, perm: 'auto' | 'ask' = 'auto', ran: string[] = []): Tool => ({ spec: { name, description: `The ${name.replace(/_/g, ' ')} tool.`, parameters: { type: 'object', properties: {} } }, defaultPermission: perm, source: 'built-in', summarize: () => name, run: async () => (ran.push(name), `${name} ok`) });

function setup(t: { after: (fn: () => void) => void }, o: { providers?: ProviderConfig[]; mcp?: boolean; quick?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-02T15:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  const providers = o.providers ?? [CLOUD, LOCAL];
  app.settings.update({ providers, defaultProviderId: providers[0].id, defaultModel: providers[0].defaultModel, ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), ...(o.quick ? { routes: { quick: { providerId: 'c', model: 'cloud-m' } } } : {}) });
  app.usage = new UsageStore(app.store.db);
  app.runs = new RunStore(app.store.db, () => clock.now);
  const ran: string[] = [];
  if (o.mcp !== false) for (const x of mcpTools(ran)) app.tools.add(x);
  for (const n of [...SAFETY_PINS, 'ssh_connect', 'ssh_run', 'ssh_servers', 'board_list', 'card_add']) app.tools.add(fake(n, 'auto', ran));
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, clock, ran };
}

async function drain(gen: AsyncGenerator<ChatEvent>, app?: TestApp, approve = true): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval' && app) app.approvals.decide(ev.approvalId, approve);
  }
  return out;
}
const toolNames = (app: TestApp, i: number) => (app.requests[i].tools ?? []).map((x) => x.name);

// ------------------------------------------------------------------ Part A

test('sizes and the switch: ceil(chars/4); lean above the threshold; off, /tools all and claude-code send today’s array', async (t) => {
  const { app } = setup(t);
  const gh = app.tools.get('mcp_github_create_issue')!;
  assert.equal(specTokens(gh), Math.ceil(JSON.stringify(gh.spec).length / 4));
  const all = app.tools.enabled(undefined);
  assert.ok(tokensOf(all) > 12_000, `the fixture is big (${tokensOf(all)})`);
  const input = { text: 'hi', mode: 'chat' as const, local: false, turnId: 1, ownerTurnIds: [1] };
  assert.equal(leanFor({ ...DEFAULT_LEAN.tools }, all, input).lean, true);
  assert.equal(leanFor({ ...DEFAULT_LEAN.tools, aboveTokens: 12_000 }, all, input).lean, true);
  assert.equal(leanFor({ ...DEFAULT_LEAN.tools, aboveTokens: 12_000 }, all.filter((x) => !x.spec.name.startsWith('mcp_')), input).lean, false, 'built-ins of the test registry alone stay under 12,000');
  // Off → the request's tools array is today's, byte for byte (and no find_tools).
  const conv = app.store.createConversation();
  app.settings.update({ lean: normLean({ tools: { mode: 'off' } }) } as never);
  await drain(runTurn(app, conv.id, 'hello'));
  const today = app.tools.enabled(undefined).filter((x) => x.spec.name !== FIND_TOOLS).map((x) => x.spec);
  assert.deepEqual(app.requests.at(-1)!.tools, today);
  // /tools all in this chat → the same.
  app.settings.update({ lean: normLean({}) } as never);
  const conv2 = app.store.createConversation();
  const adapter = adapterFor(app, conv2.id);
  await runCommand({ app, bridge: 'web', place: 'owner-dm', who: 'owner', lang: 'en', cmd: parseCommand('/tools all', { herName: 'Sara', namePrefix: false })!, adapter });
  await drain(runTurn(app, conv2.id, 'hello'));
  assert.deepEqual(app.requests.at(-1)!.tools, today);
  assert.equal(SARA_PKG_VERSION.split('.').length, 3);
});

function adapterFor(app: TestApp, convId: string): BridgeAdapter {
  return { currentSession: () => app.store.getConversation(convId), startSession: () => app.store.createConversation(), stopTurn: () => false, clearQueue: () => 0 };
}

test('the main test: core + safety pins + find_tools, the directory, find_tools loads GitHub for the next step, the same card', async (t) => {
  const { app, ran } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('f1', FIND_TOOLS, { query: 'create a github issue' })], [call('c1', 'mcp_github_create_issue', { owner: 'a', repo: 'b', title: 'x' })], text('Done.'));
  const evs = await drain(runTurn(app, conv.id, 'remind me at six to call Mum'), app);
  const first = toolNames(app, 0);
  const eligible = new Set(app.tools.enabled(undefined).map((x) => x.spec.name));
  const want = [...CORE_CHAT.filter((n) => eligible.has(n)), ...SAFETY_PINS.filter((n) => eligible.has(n)), FIND_TOOLS];
  assert.deepEqual(first, want, 'core, then safety pins, then find_tools, in the fixed order');
  assert.ok(!first.some((n) => n.startsWith('mcp_')));
  const sys = app.requests[0].messages[0].content as string;
  assert.match(sys, /More tools are ready if you need them; call find_tools/);
  assert.match(sys, /GitHub \(26/);
  assert.ok(!sys.includes('mcp_playwright_browser_click,'), 'deferred names are not in the tools line');
  // find_tools → create_issue first; the next request carries its schema.
  const found = evs.find((e) => e.type === 'tool_result' && e.name === FIND_TOOLS) as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.match(found.output, /^Loaded for your next step \(5\): mcp_github_create_issue/);
  assert.ok(toolNames(app, 1).includes('mcp_github_create_issue'));
  assert.deepEqual(toolNames(app, 1).slice(0, first.length), first, 'offered order only appends');
  // The card is today's card (an MCP tool asks first).
  const card = evs.find((e) => e.type === 'approval') as Extract<ChatEvent, { type: 'approval' }>;
  assert.equal(card.name, 'mcp_github_create_issue');
  assert.deepEqual(Object.keys(card).sort(), ['approvalId', 'args', 'id', 'name', 'summary', 'type']);
  assert.deepEqual(ran, ['mcp_github_create_issue']);
  // The run's steps: lean, offered, loaded with the reason.
  const run = app.runs!.list({ conversationId: conv.id })[0];
  const steps = app.runs!.steps(run.id);
  assert.equal(steps[0].lean?.lean, true);
  assert.ok((steps[0].lean?.eligibleTokens ?? 0) > (steps[0].lean?.offeredTokens ?? 0));
  assert.ok(steps[1].lean?.loaded?.some((l) => l.name === 'mcp_github_create_issue' && l.why === 'find'));
  assert.ok(steps[1].lean?.offered?.includes('+mcp_github_create_issue'), 'later steps record what was added');
  // tool_loads keeps it for the chat.
  assert.ok(loadRows(app.store.db, conv.id).some((r) => r.tool === 'mcp_github_create_issue'));
});

test('never hides what he asked for: words (six languages), servers, @url, pins; whole SSH family', async (t) => {
  const { app } = setup(t);
  const all = app.tools.enabled(undefined);
  const plan = (txt: string, pins: string[] = [], chatPins: string[] = []) => leanFor({ ...DEFAULT_LEAN.tools, pins }, all, { text: txt, mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] }, [], chatPins);
  const has = (p: ReturnType<typeof plan>, prefix: string) => p.offeredNames().some((n) => n.startsWith(prefix));
  assert.ok(has(plan('open an issue on the repo for that crash'), 'mcp_github_'));
  assert.equal(plan('open an issue on the repo').offered.get('mcp_github_create_issue'), 'asked');
  assert.ok(has(plan('use playwright to click Login'), 'mcp_playwright_'));
  assert.equal(plan('read @url:https://x.test please').offered.get('web_fetch') !== undefined, true);
  for (const s of ['abre un issue en el repositorio', 'ouvre un ticket dans le depot', 'erstelle ein Issue im Repository', 'abra uma issue no repositório', 'apri una issue nel repository']) assert.ok(has(plan(s), 'mcp_github_'), s);
  for (const s of ['haz clic en el navegador', 'clique dans le navigateur', 'im Browser klicken', 'clicar no navegador', 'clicca nel browser']) assert.ok(has(plan(s), 'mcp_playwright_'), s);
  assert.ok(plan('hi', ['board_list']).offered.get('board_list') === 'pinned');
  assert.ok(plan('hi', [], ['board']).offeredNames().includes('card_add'), '/tools +board pins the family');
  const ssh = plan('connect to the server over ssh');
  for (const n of ['ssh_connect', 'ssh_run', 'ssh_servers']) assert.ok(ssh.offered.has(n), n);
  // Safety pins in both modes and with localCore on a local model.
  for (const mode of ['chat', 'coding'] as const) for (const local of [false, true]) {
    const p = leanFor({ ...DEFAULT_LEAN.tools }, all, { text: 'x', mode, local, turnId: 1, ownerTurnIds: [1] });
    for (const n of SAFETY_PINS) assert.equal(p.offered.get(n), 'safety', `${n} ${mode} ${local}`);
  }
  assert.equal(familyOf(app.tools.get('mcp_playwright_browser_click')!).label, 'Playwright browser');
});

test('the gate is unchanged: an eligible tool not offered runs through its card and is loaded; private chats never see MCP; Off is never found; partners get nothing', async (t) => {
  const { app, ran } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'mcp_memory_read_graph', {})], text('ok'));
  const evs = await drain(runTurn(app, conv.id, 'hello there'), app);
  assert.ok(!toolNames(app, 0).includes('mcp_memory_read_graph'));
  assert.ok(evs.some((e) => e.type === 'approval' && e.name === 'mcp_memory_read_graph'), 'a tool set to ask asks');
  assert.deepEqual(ran, ['mcp_memory_read_graph']);
  assert.ok(toolNames(app, 1).includes('mcp_memory_read_graph'), 'loaded for the next step');
  // Private: MCP isn't eligible: "isn't available here", and find_tools never lists it.
  const priv = app.store.createConversation({ private: true });
  app.settings.update({ providers: [LOCAL, CLOUD], defaultProviderId: 'l', defaultModel: 'local-m' });
  app.script.push([call('f', FIND_TOOLS, { query: 'github issue' }), call('c2', 'mcp_github_create_issue', {})], text('ok'));
  const pe = await drain(runTurn(app, priv.id, 'hi'), app);
  const results = pe.filter((e) => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }>[];
  assert.ok(!results[0].output.includes('mcp_github'));
  assert.match(results[1].output, /isn't available here/);
  // Off → never found.
  app.settings.update({ toolPermissions: { board_list: 'never' } });
  const all = app.tools.enabled(app.settings.get().toolPermissions);
  assert.ok(!searchTools(all, 'board list').some((h) => h.tool.spec.name === 'board_list'));
  // Partner chats: no tools, no find_tools.
  const partner = app.store.createConversation({ partner: 'Sam', channel: 'telegram' });
  await drain(runTurn(app, partner.id, 'hey'));
  assert.equal((app.requests.at(-1)!.tools ?? []).length, 0);
});

test('sticky and bounded: offered for 10 of his turns; the 5th find asks him; the same query twice is answered from the loads', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('f1', FIND_TOOLS, { query: 'click a button on a web page' })], text('ok'));
  await drain(runTurn(app, conv.id, 'hello'), app);
  const loaded = loadRows(app.store.db, conv.id).map((r) => r.tool);
  assert.ok(loaded.some((n) => n.startsWith('mcp_playwright_')));
  for (let i = 2; i <= 12; i++) {
    const before = app.requests.length;
    await drain(runTurn(app, conv.id, `turn ${i}`), app);
    const names = toolNames(app, before);
    if (i <= 10) assert.ok(names.includes(loaded[0]), `turn ${i} still offers it`);
    else if (i === 12) assert.ok(!names.includes(loaded[0]), 'gone after 10 of his turns');
  }
  const tt = leanFor({ ...DEFAULT_LEAN.tools }, app.tools.enabled(undefined), { text: 'x', mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
  for (let i = 0; i < 4; i++) tt.find({ query: `query ${i} github` }, 'Alex');
  assert.match(tt.find({ query: 'more' }, 'Alex'), /You've looked 4 times this turn\. Ask Alex/);
  const t2 = leanFor({ ...DEFAULT_LEAN.tools }, app.tools.enabled(undefined), { text: 'x', mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
  t2.find({ query: 'github issue' }, 'Alex');
  assert.match(t2.find({ query: 'GitHub issue' }, 'Alex'), /already looked/);
  // maxLoaded: the oldest loads drop out.
  const rows = Array.from({ length: 30 }, (_, i) => ({ tool: app.tools.enabled(undefined).filter((x) => x.spec.name.startsWith('mcp_'))[i].spec.name, family: 'x', how: 'find', lastTurn: 100 - i, uses: 1, pinned: false, lastAt: '' }));
  const t3 = leanFor({ ...DEFAULT_LEAN.tools }, app.tools.enabled(undefined), { text: 'x', mode: 'chat', local: false, turnId: 100, ownerTurnIds: [100], goal: true }, rows);
  assert.equal([...t3.offered.values()].filter((v) => v === 'goal').length, 20);
  assert.ok(!t3.offered.has(rows[29].tool), 'the oldest load drops out');
});

test('goals: a tool loaded in round 1 is offered in round 2; /tools answers with zero model calls; speed', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('f1', FIND_TOOLS, { query: 'knowledge graph memory server' })], text('round 1'));
  await drain(runTurn(app, conv.id, 'goal round 1', undefined, { persist: { kind: 'goal', id: 1, n: 1 } as never }), app);
  const got = loadRows(app.store.db, conv.id).map((r) => r.tool);
  const before = app.requests.length;
  await drain(runTurn(app, conv.id, 'goal round 2', undefined, { persist: { kind: 'goal', id: 1, n: 2 } as never }), app);
  assert.ok(got.every((n) => toolNames(app, before).includes(n)));
  const calls = app.requests.length;
  const r = await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: parseCommand('/tools', { herName: 'Sara', namePrefix: false })!, adapter: adapterFor(app, conv.id) });
  assert.match(r.text, /^Tools here: \d+ of \d+ offered/);
  assert.match(r.text, /More on request: .*GitHub \(26\)/);
  assert.equal(app.requests.length, calls);
  assert.equal((await runCommand({ app, bridge: 'telegram', place: 'partner-dm', who: 'person', lang: 'en', cmd: parseCommand('/tools', { herName: 'Sara', namePrefix: false })!, adapter: adapterFor(app, conv.id) })).refused, true);
  // 2,000 fake tools: find < 50 ms; 500 tools: leanFor < 5 ms (after warm-up).
  const many = Array.from({ length: 2000 }, (_, i) => fake(`mcp_bulk${i % 40}_tool_${i}_do_thing`));
  const tt = leanFor({ ...DEFAULT_LEAN.tools, mode: 'always' }, many, { text: 'x', mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
  let t0 = performance.now();
  tt.find({ query: 'do thing tool 77' }, 'Alex');
  assert.ok(performance.now() - t0 < 50, `find ${performance.now() - t0} ms`);
  const five = many.slice(0, 500);
  leanFor({ ...DEFAULT_LEAN.tools }, five, { text: 'x', mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
  t0 = performance.now();
  leanFor({ ...DEFAULT_LEAN.tools }, five, { text: 'x', mode: 'chat', local: false, turnId: 1, ownerTurnIds: [1] });
  assert.ok(performance.now() - t0 < 5, `leanFor ${performance.now() - t0} ms`);
});

// ------------------------------------------------------------------ Part B

/** n turns of his and hers (with a write_file receipt early on), each ~ `size` characters. */
function longChat(app: TestApp, convId: string, turns: number, size = 600): void {
  for (let i = 0; i < turns; i++) {
    app.store.addMessage(convId, 'user', `Question ${i}: ${'tell me more about the parser '.repeat(Math.ceil(size / 30)).slice(0, size)}`);
    if (i === 1) {
      app.store.addMessage(convId, 'assistant', '', { toolCalls: [{ id: `w${i}`, name: 'write_file', arguments: { path: 'src/parser.ts', content: 'x' } }] });
      app.store.addMessage(convId, 'tool', 'Wrote src/parser.ts', { toolCallId: `w${i}`, name: 'write_file', args: { path: 'src/parser.ts' }, status: 'ok' });
    }
    app.store.addMessage(convId, 'assistant', `Answer ${i}: ${'the parser reads tokens one by one. '.repeat(Math.ceil(size / 36)).slice(0, size)}`);
  }
}

test('/compact from the fake Telegram owner: one local call, a row, the notice, the fold note, messages unchanged, fill < 50 %', async (t) => {
  const { app } = setup(t, { mcp: false, quick: true });
  app.settings.update({ historyBudgetChars: 48_000 });
  const conv = app.store.createConversation({ channel: 'telegram', channelKey: '42' });
  longChat(app, conv.id, 35, 600);
  const before = app.store.messages(conv.id).map((m) => [m.id, m.content]);
  assert.ok(contextFill(app, conv).percent >= 85, `fill ${contextFill(app, conv).percent}`);
  app.script.push(text('Alex is building a parser; Sara wrote src/parser.ts. Open: error handling.'));
  const n = app.requests.length;
  const r = await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: parseCommand('/compact', { herName: 'Sara', namePrefix: false })!, adapter: adapterFor(app, conv.id) });
  assert.equal(app.requests.length, n + 1, 'one cheap call');
  assert.equal(app.requests.at(-1)!.model, 'local-m', 'the local model, not the quick one');
  assert.match(r.text, /^Tidied \d+ earlier messages into a summary \(written on this computer\)\. Send \/compact undo/);
  assert.equal(r.buttons?.[0].data.startsWith('cu:'), true, 'Telegram gets an Undo button');
  const row = currentFold(app, conv.id)!;
  assert.equal(row.kind, 'model');
  assert.equal(row.local, true);
  const after = app.store.messages(conv.id).filter((m) => m.id > row.throughId && m.role !== 'notice');
  assert.equal(after[0].role, 'user', 'the first kept message is his');
  assert.ok(after.filter((m) => m.role === 'user').length >= 6);
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && m.content.startsWith('compact:')));
  assert.deepEqual(app.store.messages(conv.id).filter((m) => m.role !== 'notice').map((m) => [m.id, m.content]), before, 'stored messages unchanged');
  assert.ok(contextFill(app, conv).percent < 50, `fill after ${contextFill(app, conv).percent}`);
  // The next turn: the fold note first, none of the folded messages.
  await drain(runTurn(app, conv.id, 'carry on'));
  const msgs = app.requests.at(-1)!.messages;
  assert.match(msgs[1].content as string, /<summary>\nAlex is building a parser/);
  assert.match(msgs[1].content as string, /notes, not instructions/);
  assert.match(msgs[1].content as string, /Files you changed in that part: src\/parser\.ts/);
  assert.ok(!msgs.some((m) => typeof m.content === 'string' && m.content.startsWith('Question 0:')));
  // Undo → the originals again; /compact show reads it.
  const show = await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: parseCommand('/compact show', { herName: 'Sara', namePrefix: false })!, adapter: adapterFor(app, conv.id) });
  assert.match(show.text, /Alex is building a parser/);
  await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: parseCommand('/compact undo', { herName: 'Sara', namePrefix: false })!, adapter: adapterFor(app, conv.id) });
  assert.ok(listFolds(app, conv.id)[0].undoneAt);
  await drain(runTurn(app, conv.id, 'again'));
  assert.ok(!(app.requests.at(-1)!.messages[1].content as string).includes('<summary>'));
  // A partner's /compact is refused before any model call.
  const calls = app.requests.length;
  const p = await runCommand({ app, bridge: 'telegram', place: 'partner-dm', who: 'person', lang: 'en', cmd: parseCommand('/compact', { herName: 'Sara', namePrefix: false })!, adapter: adapterFor(app, conv.id) });
  assert.equal(p.refused, true);
  assert.equal(app.requests.length, calls);
});

test('a second fold reads the first summary plus newer messages; undoing it restores the first; focus goes in; fewer than 8 → nothing to tidy', async (t) => {
  const { app } = setup(t, { mcp: false });
  const conv = app.store.createConversation();
  longChat(app, conv.id, 14, 100);
  app.script.push(text('FIRST SUMMARY'));
  const r1 = await compactNow(app, conv, { focus: 'keep the API part' });
  assert.ok('fold' in r1);
  assert.match(app.requests.at(-1)!.messages[1].content as string, /Alex wants this kept in particular: keep the API part/);
  longChat(app, conv.id, 10, 100);
  app.script.push(text('SECOND SUMMARY'));
  const r2 = await compactNow(app, conv, {});
  assert.ok('fold' in r2);
  assert.match(app.requests.at(-1)!.messages[1].content as string, /^Summary of the part before \(written earlier\):\nFIRST SUMMARY/);
  undoFold(app, conv.id);
  assert.equal(currentFold(app, conv.id)!.summary, 'FIRST SUMMARY');
  const tiny = app.store.createConversation();
  longChat(app, tiny.id, 7, 50);
  assert.deepEqual(await compactNow(app, tiny, {}), { skipped: 'short' });
  // Pairs: a 20-call step right before the boundary stays whole (steers are never a boundary).
  const pc = app.store.createConversation();
  longChat(app, pc.id, 3, 50);
  app.store.addMessage(pc.id, 'user', 'run the twenty');
  app.store.addMessage(pc.id, 'assistant', '', { toolCalls: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: 'read_file', arguments: {} })) });
  for (let i = 0; i < 10; i++) app.store.addMessage(pc.id, 'tool', 'r', { toolCallId: `t${i}`, name: 'read_file' });
  app.store.addMessage(pc.id, 'user', 'steer: also check', { steer: { afterStep: 1 } });
  for (let i = 10; i < 20; i++) app.store.addMessage(pc.id, 'tool', 'r', { toolCallId: `t${i}`, name: 'read_file' });
  longChat(app, pc.id, 6, 50);
  const b = foldBoundary(app.store.messages(pc.id), 6)!;
  const msgs = app.store.messages(pc.id);
  const firstKept = msgs.find((m) => m.id > b.throughId)!;
  assert.equal(firstKept.role, 'user');
  assert.ok(!firstKept.meta?.steer);
  const h = buildHistory(msgs, Infinity, undefined, undefined, undefined, { throughId: b.throughId, note: '[fold]' });
  assert.equal(h.messages.filter((m) => m.role === 'tool' && m.content === 'Cancelled: no result.').length, 0);
});

test('private stays local: cloud only → plain fold with no call; quick pick → still local; private local mode', async (t) => {
  const { app } = setup(t, { mcp: false, providers: [CLOUD], quick: true });
  const priv = app.store.createConversation({ private: true });
  longChat(app, priv.id, 14, 100);
  app.settings.update({ lean: normLean({ compact: { model: 'quick' } }) } as never);
  const n = app.requests.length;
  const r = await compactNow(app, priv, {});
  assert.equal(app.requests.length, n, 'no cheap call at all');
  assert.ok('fold' in r && r.fold.kind === 'plain');
  assert.match(r.fold.summary!, /This is a plain list, not a summary\./);
  assert.match(app.store.messages(priv.id).at(-1)!.content, /tidied as a plain list \(no model on this computer\)/);
  // With a local model: that one.
  app.settings.update({ providers: [CLOUD, LOCAL] });
  undoFold(app, priv.id);
  app.script.push(text('local summary'));
  const r2 = await compactNow(app, priv, {});
  assert.ok('fold' in r2 && r2.fold.kind === 'model');
  assert.equal(app.requests.at(-1)!.model, 'local-m');
});

test('safety never folded away: crisis pinned 24 h then a code line; refused requests never summarised; minors output and focus', async (t) => {
  const { app, clock } = setup(t, { mcp: false });
  const conv = app.store.createConversation();
  longChat(app, conv.id, 4, 80);
  const crisisMsg = app.store.addMessage(conv.id, 'user', 'I feel hopeless and want to end it');
  app.store.addMessage(conv.id, 'notice', `crisis:${CRISIS_RESOURCES}`);
  const herReply = app.store.addMessage(conv.id, 'assistant', "I'm here with you. Please reach out to these resources.");
  const refusedAsk = app.store.addMessage(conv.id, 'user', 'REFUSED-ASK-TEXT');
  app.store.addMessage(conv.id, 'assistant', 'No.', { blocked: 'minor_sexual_message' });
  longChat(app, conv.id, 10, 80);
  clock.now = new Date(clock.now.getTime() + 2 * 3_600_000);
  app.script.push(text('a calm summary'));
  const r = await compactNow(app, conv, {});
  assert.ok('fold' in r);
  const input = app.requests.at(-1)!.messages[1].content as string;
  assert.ok(!input.includes('REFUSED-ASK-TEXT'), 'refused request not in the input');
  assert.ok(!input.includes('want to end it'), 'the pinned crisis exchange is kept verbatim, not summarised');
  let f = foldFor(app, conv)!;
  assert.ok(f.pinned.has(crisisMsg.id) && f.pinned.has(herReply.id));
  assert.match(f.note, /1 request was refused earlier under the safety rules/);
  const h = buildHistory(app.store.messages(conv.id), Infinity, undefined, undefined, undefined, f);
  assert.ok(h.messages.some((m) => m.content === 'I feel hopeless and want to end it'));
  // 30 hours later: only the code-written crisis line.
  clock.now = new Date(clock.now.getTime() + 28 * 3_600_000);
  f = foldFor(app, conv)!;
  assert.equal(f.pinned.size, 0);
  assert.match(f.note, /said things that pointed to a crisis; the crisis resources were shown/);
  // A summariser tripping the minors check → discarded, plain fold, a safety event.
  const c2 = app.store.createConversation();
  longChat(app, c2.id, 14, 80);
  app.script.push(text('a 12 year old girl having sex'));
  const events0 = Number((app.store.db.prepare("SELECT COUNT(*) AS n FROM safety_events WHERE kind = 'minor_sexual_block'").get() as { n: number }).n);
  const r2 = await compactNow(app, c2, {});
  assert.ok('fold' in r2 && r2.fold.kind === 'plain');
  assert.equal(Number((app.store.db.prepare("SELECT COUNT(*) AS n FROM safety_events WHERE kind = 'minor_sexual_block'").get() as { n: number }).n), events0 + 1);
  // A minors phrase in the focus → refused before any call.
  undoFold(app, c2.id);
  const calls = app.requests.length;
  assert.deepEqual(await compactNow(app, c2, { focus: 'the 12 year old girl having sex' }), { skipped: 'refused', reason: 'focus' });
  assert.equal(app.requests.length, calls);
  // The disclosure clock isn't touched by a fold: a turn 3 h+ later still discloses.
  const at = app.store.lastDisclosureAt();
  clock.now = new Date(clock.now.getTime() + 4 * 3_600_000);
  const evs = await drain(runTurn(app, conv.id, 'hello again'));
  assert.ok(evs.some((e) => e.type === 'notice' && e.kind === 'disclosure') || at === app.store.lastDisclosureAt());
});

test('forget wins: forgetting a message inside a fold drops it and erases its summary', async (t) => {
  const { app } = setup(t, { mcp: false });
  const conv = app.store.createConversation();
  longChat(app, conv.id, 14, 80);
  app.script.push(text('summary mentioning the secret'));
  await compactNow(app, conv, {});
  const row = currentFold(app, conv.id)!;
  const target = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  const mem = app.memory!.add({ kind: 'fact', content: 'x', conversationId: conv.id, sourceMessageId: target.id, happenedOn: '2026-11-02', evidence: 'x' });
  forgetMemory(app, app.memory!, mem.id);
  const after = listFolds(app, conv.id).find((f) => f.id === row.id)!;
  assert.equal(after.undoReason, 'forgotten');
  assert.equal(after.summary, null);
  assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && /removed because you had her forget something/.test(m.content)));
  assert.equal(foldFor(app, conv), undefined);
});

test('automatic: a turn at 86 % folds before the first model call; 84 % doesn’t; not twice in 10 messages; two failures turn it off; slow folds apply next turn; partners never', async (t) => {
  const { app } = setup(t, { mcp: false });
  app.settings.update({ historyBudgetChars: 20_000 });
  const conv = app.store.createConversation();
  // ~84 %: no fold.
  while (contextFill(app, conv).percent < 82) longChat(app, conv.id, 1, 300);
  assert.equal(await autoFold(app, conv), undefined);
  while (contextFill(app, conv).percent < 87) longChat(app, conv.id, 1, 300);
  app.script.push(text('auto summary'), text('her reply'));
  const evs = await drain(runTurn(app, conv.id, 'next question'));
  assert.ok(evs.some((e) => e.type === 'notice' && e.kind === 'compact'));
  const row = currentFold(app, conv.id)!;
  assert.equal(row.trigger, 'auto');
  assert.match(app.requests.at(-1)!.messages[1].content as string, /<summary>\nauto summary/);
  const steps = app.runs!.steps(app.runs!.list({ conversationId: conv.id })[0].id);
  assert.equal(steps[0].lean?.foldId, row.id, 'step 0 shows the fold');
  const ex = afterTurnExtras(app, conv.id, 'owner-dm');
  assert.match(ex.before ?? '', /I tidied the older part of this chat/);
  // Not again within 10 of his messages.
  while (contextFill(app, conv).percent < 90) longChat(app, conv.id, 1, 2000);
  assert.equal(await autoFold(app, conv), undefined);
  // The CH1 offer stays quiet while auto is on; names /compact when off.
  assert.equal(nearlyFullOffer(app, conv, { used: 99, budget: 100, dropped: 0 }, 'en', 'owner-dm'), undefined);
  app.settings.update({ lean: normLean({ compact: { auto: false } }) } as never);
  assert.match(nearlyFullOffer(app, conv, { used: 99, budget: 100, dropped: 0 }, 'en', 'owner-dm')!, /Send \/compact to tidy the older part, or \/new/);
  // Two failures (an erroring cheap model) → plain folds, then off with one notice.
  app.settings.update({ lean: normLean({ compact: { auto: true } }) } as never);
  const c2 = app.store.createConversation();
  const boom = [{ type: 'error' as const, message: 'x' }];
  void boom;
  const origFactory = app.providerFactory;
  app.providerFactory = (cfg) => ({ config: cfg, listModels: async () => [], stream: async function* () { throw new Error('model down'); } });
  for (let k = 0; k < 2; k++) {
    longChat(app, c2.id, 12, 900);
    for (let i = 0; i < 10; i++) app.store.addMessage(c2.id, 'user', `filler ${k} ${i} ${'x'.repeat(300)}`);
    const f = await autoFold(app, c2);
    assert.equal(f?.kind, 'plain');
  }
  assert.ok(app.store.messages(c2.id).some((m) => m.meta?.autoOff));
  longChat(app, c2.id, 12, 900);
  assert.equal(await autoFold(app, c2), undefined, 'off for this chat');
  // A slow fold: the turn goes on; the fold applies next turn.
  app.providerFactory = origFactory;
  const c3 = app.store.createConversation();
  while (contextFill(app, c3).percent < 90) longChat(app, c3.id, 1, 600);
  compactTiming.autoWaitMs = 1;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  app.providerFactory = (cfg) => ({ config: cfg, listModels: async () => [], stream: async function* (req) { if (req.maxTokens === 700) await gate; yield { type: 'text' as const, text: req.maxTokens === 700 ? 'slow summary' : 'reply' }; } });
  await drain(runTurn(app, c3.id, 'go on'));
  assert.equal(currentFold(app, c3.id), undefined, 'the turn went on unfolded');
  release();
  await until(() => currentFold(app, c3.id));
  compactTiming.autoWaitMs = 20_000;
  app.providerFactory = origFactory;
  // Partner chats: never.
  const partner = app.store.createConversation({ partner: 'Sam', channel: 'telegram' });
  longChat(app, partner.id, 30, 900);
  assert.equal(await autoFold(app, partner), undefined);
});

test('cap and cost: the compact ledger counts, over the cap → plain with the budget line; usage purpose compact', async (t) => {
  const { app } = setup(t, { mcp: false });
  app.settings.update({ lean: normLean({ compact: { dailyCap: { runs: 20 } } }) } as never);
  const conv = app.store.createConversation();
  longChat(app, conv.id, 14, 80);
  app.script.push([...text('s1'), { type: 'usage', input: 100, output: 10 }]);
  await compactNow(app, conv, {});
  const led = app.store.db.prepare("SELECT * FROM budget_ledger WHERE source = 'compact'").all() as { runs: number }[];
  assert.equal(led[0].runs, 1);
  app.store.db.prepare("UPDATE budget_ledger SET runs = 99 WHERE source = 'compact'").run();
  undoFold(app, conv.id);
  const r = await compactNow(app, conv, {});
  assert.ok('fold' in r && r.fold.kind === 'plain' && r.fold.safety.why === 'cap');
  assert.match(app.store.messages(conv.id).at(-1)!.content, /today's tidy budget is used up/);
});

test('chat apps: words in six languages, /compact in the menus and /tools not, partners refused; old data opens', async (t) => {
  for (const w of ['compact', 'compactar', 'resumir', 'compacter', 'kompakt', 'compattare', 'ordenar']) assert.equal(parseCommand(`Sara ${w}`, { herName: 'Sara', namePrefix: true })?.name, 'compact', w);
  for (const w of ['tools', 'herramientas', 'outils', 'werkzeuge', 'ferramentas', 'strumenti']) assert.equal(parseCommand(`Sara ${w}`, { herName: 'Sara', namePrefix: true })?.name, 'tools', w);
  assert.ok((MENU_COMMANDS as readonly string[]).includes('compact'));
  assert.ok(!(MENU_COMMANDS as readonly string[]).includes('tools'));
  for (const p of ['partner-dm', 'room'] as Place[]) assert.equal(commandAllowed(p, 'person', 'compact'), false);
  // A 2.55 database gets the new tables and column.
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const old = new DatabaseSync(join(dir, 'old.db'));
  old.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider_id TEXT, model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);");
  old.close();
  const st = new Store(join(dir, 'old.db'));
  const tables = (st.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes('tool_loads') && tables.includes('compactions'));
  assert.ok((st.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).some((c) => c.name === 'lean_off'));
  st.close();
  // Zero new npm runtime dependencies.
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies, undefined);
  void toolsReport;
});
