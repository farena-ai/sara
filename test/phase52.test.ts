// Phase 52: Sara everywhere you build. The cost and token meter (providers report usage, it's
// recorded per call with what it was for; prices only where known; local / subscription = $0),
// budgets for team tasks and jobs that stop cleanly and can continue, device-code sign-in, the
// terminal client end to end, the VS Code package, and the starter projects.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { DeviceFlow } from '../src/device-flow.ts';
import { exportAll, importAll } from '../src/export.ts';
import { JobManager } from '../src/jobs.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { createSaraServer } from '../src/server.ts';
import { copyStarter, listStarters, packageName, STARTERS_DIR } from '../src/starters.ts';
import { TeamManager } from '../src/team.ts';
import { writeFileTool } from '../src/tools/builtin.ts';
import { claudeUsageParser } from '../src/tools/coding.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { billingOf, cleanBudget, cleanPrices, costOf, findPrice, overBudget, priceTable, UsageStore, usageLine } from '../src/usage.ts';
import { folderContext, parseArgs, SECRET_FILE } from '../clients/cli/sara.ts';
import { buildVsix, unzip } from '../scripts/pack-vscode.ts';
import { call, collectText, makeApp, readBody, ROOT, tempDir, text } from './helpers.ts';

// A real Python (on a Mac without the Xcode Command Line Tools, /usr/bin/python3 is only a stub).
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const HAS_PYTHON = spawnSync(PYTHON, ['--version'], { stdio: 'ignore' }).status === 0;

const usage = (input: number, output: number, cached?: number) => ({ type: 'usage' as const, input, output, ...(cached ? { cached } : {}) });

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-27T15:00:00Z') };
const app = makeApp(dir, clock);
app.usage = new UsageStore(app.store.db, () => clock.now);
app.usage.prices = () => priceTable(app.settings.get().prices);
app.jobs = new JobManager(app, app.store.db);
app.team = new TeamManager(app, app.store.db);
app.tools.add(writeFileTool);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({
    providers: [
      { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
      { id: 'ollama-local', label: 'Ollama on the server', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
      { id: 'claude-sub', label: 'Claude (your subscription)', kind: 'claude-code', baseUrl: 'https://api.anthropic.com' },
    ],
    defaultProviderId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: clock.now.toISOString(),
    toolPermissions: { write_file: 'ask' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  app.jobs?.stopAll();
  server.close();
  app.store.close();
  cleanup();
});
const api = (path: string, method = 'GET', body?: unknown, auth = token) => fetch(base + path, { method, headers: { authorization: `Bearer ${auth}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const chat = async (convId: string, content: string, bearer = token) => (await api(`/api/conversations/${convId}/messages`, 'POST', { content }, bearer)).text();
const until = async (fn: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
};

test('prices: defaults only where verified; owner rows win; dated names match; local and subscriptions are $0', () => {
  const table = priceTable([{ model: 'gpt-6.1-sol', inPerM: 1, outPerM: 1 }]);
  assert.equal(findPrice(table, 'openai', 'gpt-6.1-sol')?.inPerM, 1, 'the owner row wins');
  assert.equal(findPrice(priceTable([]), 'openai', 'gpt-6.1-sol-2026-09-01')?.inPerM, 2, 'a dated model name matches');
  assert.equal(findPrice(priceTable([]), 'openrouter', 'some/unknown-model'), undefined);
  assert.equal(costOf('api', findPrice(priceTable([]), 'openai', 'gpt-6.1-sol'), { input: 1_000_000, output: 100_000, cached: 500_000 }), 0.5 * 2 + 0.5 * 0.1 + 0.1 * 10);
  assert.equal(costOf('api', undefined, { input: 10, output: 10 }), null, 'unknown price: no cost');
  assert.equal(costOf('local', undefined, { input: 10, output: 10 }), 0);
  assert.equal(billingOf({ id: 'x', label: 'x', kind: 'openai-compatible', baseUrl: 'http://192.168.1.5:11434/v1' }), 'local');
  assert.equal(billingOf({ id: 'x', label: 'x', kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1' }), 'subscription');
  assert.equal(billingOf({ id: 'x', label: 'x', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }), 'api');
  assert.throws(() => cleanPrices([{ model: 'm', inPerM: -1, outPerM: 1 }]), /input price/);
  assert.deepEqual(cleanPrices([{ model: ' m ', inPerM: '1.5', outPerM: 3, cachedInPerM: '' }, { model: 'M', inPerM: 9, outPerM: 9 }]), [{ model: 'm', inPerM: 1.5, outPerM: 3 }]);
  assert.deepEqual(cleanBudget({ tokens: '50000', usd: '' }), { tokens: 50_000 });
  assert.equal(overBudget({ usd: 1 }, { tokens: 0, usd: 1.2 }), 'its budget of $1.00');
  // L4: a dollar-only budget stops at a call with no price (a token budget keeps counting instead).
  assert.match(String(overBudget({ usd: 1 }, { tokens: 10, usd: 0, unpriced: 1 })), /no price for this model.*set a token budget or a price/);
  assert.equal(overBudget({ usd: 1, tokens: 5000 }, { tokens: 10, usd: 0, unpriced: 1 }), undefined);
  assert.match(usageLine({ calls: 1, input: 1200, output: 300, cached: 0, tokens: 1500, usd: 0, unpriced: 0, billing: ['subscription'] }), /1\.5k tokens .* \$0 \(subscription\)/);
  assert.match(usageLine({ calls: 1, input: 10, output: 5, cached: 0, tokens: 15, usd: 0, unpriced: 1, billing: ['api'] }), /cost unknown/);
});

test('adapters report usage: OpenAI-compatible (stream_options) and Anthropic (message_start/delta)', async (t) => {
  let body = '';
  const srv = createServer(async (req, res) => {
    body = await readBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url?.endsWith('/chat/completions')) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: null })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      for (const ev of [
        { type: 'message_start', message: { usage: { input_tokens: 30, cache_read_input_tokens: 70, output_tokens: 1 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Yo' } },
        { type: 'message_delta', usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ])
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      res.end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  const o = await collectText(new OpenAICompatibleProvider({ id: 'o', label: 'O', kind: 'openai-compatible', baseUrl: url }).stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(o.text, 'Hi');
  assert.deepEqual(o.calls, [usage(120, 7, 100)]);
  assert.deepEqual(JSON.parse(body).stream_options, { include_usage: true });
  const a = await collectText(new AnthropicProvider({ id: 'a', label: 'A', kind: 'anthropic', baseUrl: url }, 'k').stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(a.text, 'Yo');
  assert.deepEqual(a.calls, [usage(100, 12, 70)]);
});

test('meter: a chat turn records tokens and cost per conversation; usage never reaches the reply as a tool call', async () => {
  const conv = app.store.createConversation({ title: 'Meter' });
  app.script.push([...text('Hello', ' Alex.'), usage(4000, 200, 1000)]);
  const sse = await chat(conv.id, 'hi');
  assert.match(sse, /Hello/);
  assert.doesNotMatch(sse, /event: tool_call/);
  const u = (await (await api(`/api/conversations/${conv.id}/usage`)).json()) as { calls: number; input: number; output: number; usd: number; line: string };
  assert.equal(u.calls, 1);
  assert.equal(u.input, 4000);
  assert.equal(u.output, 200);
  // 3000 × $2 + 1000 × $0.10 + 200 × $10, per million.
  assert.equal(u.usd, 0.0081);
  assert.match(u.line, /4\.2k tokens .* about \$0\.0081/);
  // A local model and a subscription: tokens, no price.
  const local = app.store.createConversation({ title: 'Local', providerId: 'ollama-local', model: 'gemma4' });
  app.script.push([...text('Hi.'), usage(50, 5)]);
  await chat(local.id, 'hey');
  assert.match(((await (await api(`/api/conversations/${local.id}/usage`)).json()) as { line: string }).line, /· local$/);
  const s = (await (await api('/api/usage')).json()) as { today: { total: { calls: number }; byModel: { model: string; billing: string[] }[]; byPurpose: { purpose: string }[] }; defaults: unknown[] };
  assert.equal(s.today.total.calls >= 2, true);
  assert.ok(s.today.byModel.some((m) => m.model === 'gemma4' && m.billing.includes('local')));
  assert.ok(s.today.byPurpose.some((p) => p.purpose === 'chat'));
  assert.ok(s.defaults.length >= 5);
  // The owner's own price applies at once.
  assert.equal((await api('/api/usage/settings', 'PUT', { prices: [{ model: 'gemma4', providerId: 'ollama-local', inPerM: 5, outPerM: 5 }], jobBudget: { tokens: 200000 }, teamUsd: 3 })).status, 200);
  assert.deepEqual(app.settings.get().jobBudget, { tokens: 200_000 });
  assert.equal(app.settings.get().teamLimits?.usd, 3);
  app.script.push([...text('Hi.'), usage(50, 5)]);
  await chat(local.id, 'again');
  assert.equal(((await (await api(`/api/conversations/${local.id}/usage`)).json()) as { usd: number }).usd, 0, 'a local model never gets a price');
  assert.equal((await api('/api/usage/settings', 'PUT', { prices: [{ model: 'x', inPerM: 'lots', outPerM: 1 }] })).status, 400);
  app.settings.update({ teamLimits: undefined, jobBudget: undefined, prices: undefined });
});

test('team budget: stops cleanly at its $ budget (parts left wait), Continue with more budget finishes it', async () => {
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push(
    // The plan, reporting $0.01 of usage (4000 in × $2/M + 200 out × $10/M).
    [...text(JSON.stringify({ steps: [{ helper: 'coder', title: 'Write it', instructions: 'Write a note.' }, { helper: 'tester', title: 'Check it', instructions: 'Check and report.' }] })), usage(4000, 200)],
    // Her report at the limit.
    text('I stopped at the budget.'),
  );
  const t1 = app.team!.start(conv.id, 'Write a short note file and check it.', { limits: { usd: 0.01 } });
  const stopped = await app.team!.finished(t1.id);
  assert.equal(stopped.status, 'limit', JSON.stringify(app.team!.log(t1.id).map((l) => l.text)));
  assert.deepEqual(stopped.steps.map((s) => s.status), ['waiting', 'waiting'], 'nothing past the budget ran');
  assert.equal(app.team!.usage(t1.id)?.usd, 0.01);
  const msg = app.store.messages(conv.id).at(-1)!;
  assert.deepEqual(msg.meta?.team, { id: t1.id, status: 'limit' });
  assert.match(msg.content, /Continue with more budget/);
  // Continue: the same budget again ($0.02 in all); the parts left run.
  app.script.push(text('Wrote the note.'), text('Checked it. VERDICT: PASS'), text('All done.'));
  const res = await api(`/api/team/${t1.id}/continue`, 'POST', {});
  assert.equal(res.status, 200);
  const done = await app.team!.finished(t1.id);
  assert.equal(done.status, 'done', JSON.stringify(app.team!.log(t1.id).map((l) => l.text)));
  assert.equal(done.limits.usd, 0.02);
  assert.deepEqual(done.steps.map((s) => s.status), ['done', 'done']);
  assert.equal((await api(`/api/team/${t1.id}/continue`, 'POST', {})).status, 400, 'only a task at a limit continues');
});

test('job budget (L4): a dollar-only budget stops at the first call with no price, and says why', async (t) => {
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  const line = JSON.stringify({ type: 'assistant', message: { id: 'u1', usage: { input_tokens: 50, output_tokens: 10 } } });
  writeFileSync(join(ws, 'emit-unpriced.js'), `console.log(${JSON.stringify(line)});\nsetTimeout(() => console.log('{"type":"result","result":"done"}'), 3000);\n`);
  const spec = { conversationId: conv.id, workspace: conv.workspace, label: 'Agent on a model with no price', kind: 'agent' as const, command: `${JSON.stringify(process.execPath)} emit-unpriced.js`, timeoutMs: 60_000, budget: { usd: 1 }, meter: { config: { id: 'openrouter-x', label: 'OpenRouter', kind: 'openai-compatible' as const, baseUrl: 'https://openrouter.ai/api/v1' }, model: 'some/unpriced-model-xyz', parse: claudeUsageParser() } };
  const { done } = app.jobs!.start(spec);
  t.after(() => app.jobs!.stopAll());
  const j = await done;
  assert.equal(j.status, 'budget', j.tail);
  assert.match(String((j.result?.budget as { reason: string }).reason), /no price for this model.*set a token budget or a price/);
});

test('job budget: an agent job stops cleanly at its token budget, says so plainly, and can continue', async (t) => {
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  // Like Claude Code's stream-json: one call shown as two lines (same id), then another call.
  const line = (id: string, n: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: n, output_tokens: 100 } } });
  writeFileSync(join(ws, 'emit.js'), `console.log(${JSON.stringify(line('m1', 500))});\nconsole.log(${JSON.stringify(line('m1', 500))});\nconsole.log(${JSON.stringify(line('m2', 500))});\nsetTimeout(() => console.log('{"type":"result","result":"done"}'), 1500);\n`);
  const spec = { conversationId: conv.id, workspace: conv.workspace, label: 'Claude Code: write a note', kind: 'agent' as const, command: `${JSON.stringify(process.execPath)} emit.js`, timeoutMs: 60_000, budget: { tokens: 1000 }, meter: { config: { id: 'claude-sub', label: 'Claude (your subscription)', kind: 'claude-code' as const, baseUrl: 'https://api.anthropic.com' }, model: 'claude-code', parse: claudeUsageParser() } };
  const { job, done } = app.jobs!.start(spec);
  const j = await done;
  t.after(() => app.jobs!.stopAll());
  assert.equal(j.status, 'budget', j.tail);
  assert.match(String((j.result?.budget as { reason: string }).reason), /token budget \(1,000 tokens\)/);
  const u = app.usage!.forJob(job.id);
  assert.equal(u.tokens, 1200, 'the repeated line counted once');
  assert.deepEqual(u.billing, ['subscription']);
  assert.match(usageLine(u), /\$0 \(subscription\)/);
  const msg = app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal(msg.meta?.budget, true);
  assert.match(msg.content, /didn't go past it/);
  const list = (await (await api(`/api/jobs?conversation=${conv.id}`)).json()) as { id: number; canContinue?: boolean; usage?: { tokens: number } }[];
  assert.equal(list.find((x) => x.id === job.id)?.canContinue, true);
  assert.equal(list.find((x) => x.id === job.id)?.usage?.tokens, 1200);
  // Continue with the same budget again (2000 tokens): this run finishes.
  const next = (await (await api(`/api/jobs/${job.id}/continue`, 'POST', {})).json()) as { id: number; label: string };
  assert.match(next.label, /\(continued\)$/);
  await until(() => app.jobs!.get(next.id)?.status !== 'running');
  assert.equal(app.jobs!.get(next.id)?.status, 'ok');
  assert.equal((await api(`/api/jobs/${job.id}/continue`, 'POST', {})).status, 400, 'continued once');
});

test('device flow: code → owner approves → the app gets its token once; it is listed, works with two-step on, can\'t approve others, signs out', async () => {
  const start = await fetch(`${base}/api/device/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'sara-chat/0.52.0 (linux) node' }, body: JSON.stringify({ name: 'sara-chat on Linux (box)<script>' }) });
  assert.equal(start.status, 200);
  const s = (await start.json()) as { code: string; pollToken: string; verifyUrl: string };
  assert.match(s.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(s.verifyUrl, `${base}/device`, 'the code is never in the link (the owner types it)');
  const poll = () => fetch(`${base}/api/device/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollToken: s.pollToken }) });
  assert.equal(((await (await poll()).json()) as { status: string }).status, 'pending');
  assert.equal((await fetch(`${base}/api/device/pending`)).status, 401, 'owner only');
  const one = (await (await api(`/api/device/pending?code=${s.code.toLowerCase().replace('-', '')}`)).json()) as { request: { name: string; ip: string; ageSeconds: number } };
  assert.equal(one.request.name, 'sara-chat on Linux (box)script', 'the name is cleaned');
  assert.equal(one.request.ip, '127.0.0.1', 'the address it asked from is shown');
  assert.equal(typeof one.request.ageSeconds, 'number');
  // Approving needs proof it's the owner (token, two-step code or passkey), not only a sign-in.
  const noProof = await api('/api/device/approve', 'POST', { code: s.code });
  assert.equal(noProof.status, 403);
  assert.equal(((await noProof.json()) as { confirm: string }).confirm, 'token');
  assert.equal((await api('/api/device/approve', 'POST', { code: s.code, token: 'wrong' })).status, 403);
  assert.equal((await api('/api/device/approve', 'POST', { code: s.code, token })).status, 200);
  const got = (await (await poll()).json()) as { status: string; token: string; deviceId: string };
  assert.equal(got.status, 'approved');
  assert.match(got.token, /^sara_dev\./);
  assert.equal((await poll()).status, 410, 'handed out once');
  // The token works for the API; it's listed as an app.
  assert.equal((await api('/api/conversations', 'GET', undefined, got.token)).status, 200);
  const devs = ((await (await api('/api/devices')).json()) as { devices: { id: string; kind: string }[] }).devices;
  assert.equal(devs.find((d) => d.id === got.deviceId)?.kind, 'app');
  const who = (await (await api('/api/device/whoami', 'GET', undefined, got.token)).json()) as { device: { label: string }; companion: string };
  assert.equal(who.companion, 'Sara');
  assert.match(who.device.label, /sara-chat on Linux/);
  // An app can't approve another app.
  const s2 = (await (await fetch(`${base}/api/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"other"}' })).json()) as { code: string };
  assert.equal((await api('/api/device/approve', 'POST', { code: s2.code, token }, got.token)).status, 403);
  // Nor change sign-in settings, list or sign out devices, or make pairing codes.
  for (const [path, method] of [['/api/devices', 'GET'], ['/api/devices/others', 'DELETE'], ['/api/security', 'GET'], ['/api/two-step/start', 'POST'], ['/api/passkey/register-options', 'POST'], ['/api/owner-token/rotate', 'POST'], ['/api/pair', 'POST'], ['/api/device/pending', 'GET']] as const) {
    assert.equal((await api(path, method, method === 'GET' ? undefined : { token }, got.token)).status, 403, `${method} ${path}`);
  }
  assert.equal((await api('/api/device/deny', 'POST', { code: s2.code })).status, 200);
  // A wrong token, then signing out.
  assert.equal((await api('/api/conversations', 'GET', undefined, `${got.token}x`)).status, 401);
  assert.equal((await api('/api/device/logout', 'POST', {}, got.token)).status, 200);
  assert.equal((await api('/api/conversations', 'GET', undefined, got.token)).status, 401);
  // The confirm page is served.
  assert.match(await (await fetch(`${base}/device`)).text(), /Approve an app/);
  // Codes expire.
  let now = 0;
  const f = new DeviceFlow(() => now);
  const r = f.start('x');
  now += 11 * 60_000;
  assert.equal(f.poll(r.pollToken).status, 'expired');
});

test('terminal client end to end: login with the device code, ask about a folder (no secrets), an approval y/n, logout', async (t) => {
  const cfgDir = join(dir, 'cli-config');
  const env = { ...process.env, SARA_CHAT_CONFIG_DIR: cfgDir, NO_COLOR: '1' };
  const cli = join(ROOT, 'clients', 'cli', 'sara.ts');
  const run = (args: string[], input = '') =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.stdin.end(input);
      p.on('close', (code) => resolve({ code, out, err }));
    });
  // login: read the code it shows, approve it as the owner.
  const login = spawn(process.execPath, [cli, 'login', base], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => login.kill());
  let shown = '';
  login.stdout.on('data', (d) => (shown += d));
  await until(() => /\b[A-Z2-9]{4}-[A-Z2-9]{4}\b/.test(shown), 15_000);
  const code = /\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/.exec(shown)![1];
  assert.match(shown, /\/device where you're signed in and type the code/);
  assert.equal((await api('/api/device/approve', 'POST', { code, token })).status, 200);
  const exit = await new Promise<number | null>((r) => login.on('close', r));
  assert.equal(exit, 0, shown);
  // Phase 68: config.json holds a list of servers; this one is profile #1 and in use.
  const saved = JSON.parse(readFileSync(join(cfgDir, 'config.json'), 'utf8')) as { active: string; servers: { id: string; token: string; url: string; conversationId?: string }[] };
  const cfg = saved.servers.find((p) => p.id === saved.active)!;
  assert.match(cfg.token, /^sara_dev\./);
  if (process.platform !== 'win32') assert.equal(statSync(join(cfgDir, 'config.json')).mode & 0o777, 0o600);
  // ask --dir: a short listing + README; .env and node_modules never sent.
  const folder = join(dir, 'proj');
  mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'README.md'), '# Weather app\nShows the weather.');
  writeFileSync(join(folder, '.env'), 'API_KEY=supersecretvalue');
  writeFileSync(join(folder, 'server.key'), 'KEYDATA');
  writeFileSync(join(folder, 'src', 'main.js'), 'console.log(1)');
  writeFileSync(join(folder, 'node_modules', 'x', 'index.js'), '');
  app.requests.length = 0;
  app.script.push(text('It is a weather app.'));
  const a = await run(['ask', 'What is this project?', '--dir', folder]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /Sara: It is a weather app\./);
  assert.match(a.err, /Sending: a list of \d+ entries \(2 files\) and README\.md/);
  const sent = JSON.stringify(app.requests.at(-1)!.messages.at(-1));
  assert.match(sent, /Weather app/);
  assert.match(sent, /src\/main\.js/);
  assert.doesNotMatch(sent, /supersecretvalue|server\.key|- \.env|node_modules\/x/);
  // An approval prompt answered y on the terminal.
  app.script.push([call('w1', 'write_file', { path: 'from-cli.txt', content: 'hi from the terminal' })], text('Wrote it.'));
  const b = await run(['ask', 'Write a file'], 'y\n');
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /Sara wants to: .*from-cli\.txt/);
  assert.match(b.out, /Wrote it\./);
  const conv = app.store.getConversation(JSON.parse(readFileSync(join(cfgDir, 'config.json'), 'utf8')).servers[0].conversationId)!;
  assert.equal(readFileSync(join(workspaceDir(dir, conv.workspace), 'from-cli.txt'), 'utf8'), 'hi from the terminal');
  // Interactive chat with piped input (lines typed before she's ready aren't lost), then /quit.
  app.script.push(text('Hi from the chat.'));
  const c = await run(['--new'], 'hello there\n/quit\n');
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /you: Sara: Hi from the chat\./);
  // logout: the token stops working and the file is gone.
  const out = await run(['logout']);
  assert.equal(out.code, 0);
  assert.equal(existsSync(join(cfgDir, 'config.json')), false);
  assert.equal((await api('/api/conversations', 'GET', undefined, cfg.token)).status, 401);
  assert.match((await run(['ask', 'hi'])).err, /Not signed in/);
});

test('terminal client: folder overview leaves out secrets; arguments', () => {
  for (const n of ['.env', '.env.local', 'id_ed25519', 'cert.pem', 'my.key', 'credentials', 'db-password.txt', 'secrets.json']) assert.ok(SECRET_FILE.test(n), n);
  for (const n of ['README.md', 'index.js', 'environment.ts', 'keyboard.js']) assert.ok(!SECRET_FILE.test(n), n);
  const ctx = folderContext(ROOT, { max: 40 });
  assert.match(ctx.text, /README\.md/);
  assert.doesNotMatch(ctx.text, /node_modules\/|\.git\//);
  assert.deepEqual(parseArgs(['ask', 'why', '--dir', '.', '--new']), { cmd: 'ask', rest: ['why'], flags: { dir: '.', new: true } });
  assert.equal(parseArgs([]).cmd, 'chat');
});

test('VS Code: the .vsix has a manifest and the extension; the panel CSP is strict; plain JS parses', () => {
  const v = buildVsix();
  const files = unzip(v.bytes);
  assert.ok(files.has('extension.vsixmanifest') && files.has('[Content_Types].xml'));
  const pkg = JSON.parse(files.get('extension/package.json')!.toString()) as { contributes: { commands: { title: string }[]; viewsContainers: { activitybar: { id: string }[] } } };
  assert.deepEqual(pkg.contributes.commands.map((c) => c.title).filter((x) => /Sign in|Ask about selection|Explain this file|Send file to her library/.test(x)).length, 4);
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].id, 'sara');
  const version = (JSON.parse(readFileSync(join(ROOT, 'clients', 'vscode', 'package.json'), 'utf8')) as { version: string }).version;
  assert.ok(files.get('extension.vsixmanifest')!.toString().includes(`Version="${version}"`));
  assert.ok(files.has('extension/profiles.js'), 'Phase 68: the server list logic ships');
  const ext = files.get('extension/extension.js')!.toString();
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(ext)![1];
  assert.match(csp, /^default-src 'none'; .*script-src 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.doesNotMatch(ext, /style="|<script>|src="http/);
  for (const f of ['extension.js', 'profiles.js', 'media/panel.js']) assert.equal(spawnSync(process.execPath, ['--check', join(ROOT, 'clients', 'vscode', f)]).status, 0, f);
  assert.doesNotMatch(files.get('extension/media/panel.js')!.toString(), /fetch\(|XMLHttpRequest|WebSocket/, 'the page has no network of its own');
});

test('starters: five tested templates; copying fills the name and never overwrites; each template passes its own tests', async (t) => {
  const names = listStarters().map((s) => s.name);
  assert.deepEqual(names, ['cli-tool', 'landing-page', 'python-cli', 'rest-api', 'telegram-bot']);
  const ws = join(dir, 'starter-ws');
  mkdirSync(ws, { recursive: true });
  const { folder } = copyStarter(ws, 'rest-api', 'My_API');
  assert.equal((JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { name: string }).name, 'my_api');
  assert.match(readFileSync(join(folder, 'README.md'), 'utf8'), /^# My_API/);
  assert.equal(existsSync(join(folder, 'starter.json')), false);
  assert.throws(() => copyStarter(ws, 'rest-api', 'My_API'), /already/);
  assert.throws(() => copyStarter(ws, 'nope', 'x'), /No starter called "nope"/);
  assert.throws(() => copyStarter(ws, 'cli-tool', '../escape'), /folder/);
  assert.equal(packageName('Weather Bot!'), 'weather-bot-');
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  for (const n of ['cli-tool', 'landing-page', 'rest-api', 'telegram-bot']) {
    const r = spawnSync(process.execPath, ['--test'], { cwd: join(STARTERS_DIR, n), encoding: 'utf8', timeout: 120_000, env });
    assert.equal(r.status, 0, `${n}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ℹ fail 0/);
  }
  if (!HAS_PYTHON) return t.diagnostic(`python-cli's own tests not run: ${PYTHON} not installed`);
  const python = spawnSync(PYTHON, ['-B', '-m', 'unittest'], { cwd: join(STARTERS_DIR, 'python-cli'), encoding: 'utf8', timeout: 120_000, env });
  assert.equal(python.status, 0, `python-cli: ${python.stdout}\n${python.stderr}`);
  assert.match(`${python.stdout}\n${python.stderr}`, /OK/);
});

test('starters: "New project from a starter" copies into the workspace and its tests pass as a job; the tool is in her coding prompt', async (t) => {
  const res = await api('/api/starters', 'POST', { name: 'telegram-bot', projectName: 'weather-bot', workspace: 'main' });
  assert.equal(res.status, 201, await res.clone().text());
  const r = (await res.json()) as { conversationId: string; jobId: number; message: string };
  assert.match(r.message, /weather-bot.*Telegram bot/);
  const folder = join(workspaceDir(dir, 'main'), 'weather-bot');
  assert.equal((JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { name: string }).name, 'weather-bot');
  await until(() => app.jobs!.get(r.jobId)?.status !== 'running', 120_000);
  const job = app.jobs!.get(r.jobId)!;
  assert.equal(job.status, 'ok', job.tail);
  assert.match(job.tail, /fail 0/);
  assert.equal(app.store.getConversation(r.conversationId)?.mode, 'coding');
  const pythonRes = await api('/api/starters', 'POST', { name: 'python-cli', projectName: 'python-counts', workspace: 'main' });
  assert.equal(pythonRes.status, 201, await pythonRes.clone().text());
  const pythonStarter = (await pythonRes.json()) as { jobId: number; message: string };
  assert.match(pythonStarter.message, /Python command-line tool/);
  await until(() => app.jobs!.get(pythonStarter.jobId)?.status !== 'running', 120_000);
  const pythonJob = app.jobs!.get(pythonStarter.jobId)!;
  if (HAS_PYTHON) {
    assert.equal(pythonJob.status, 'ok', pythonJob.tail);
    assert.match(pythonJob.tail, /OK/);
  } else t.diagnostic(`the python-cli job's result not checked: ${PYTHON} not installed`);
  assert.equal((await api('/api/starters', 'POST', { name: 'telegram-bot', projectName: 'weather-bot', workspace: 'main' })).status, 400, 'never overwrites');
});

test('export / import round trip: usage records, the owner\'s prices and job budget', (t) => {
  const { dir: d2, cleanup: c2 } = tempDir();
  const b = makeApp(d2, clock);
  b.usage = new UsageStore(b.store.db, () => clock.now);
  t.after(() => {
    b.store.close();
    c2();
  });
  app.settings.update({ prices: [{ model: 'my-model', inPerM: 1, outPerM: 2 }], jobBudget: { usd: 4 } });
  const file = JSON.parse(JSON.stringify(exportAll(app)));
  assert.ok(file.usage.length >= 3);
  const r = importAll(b, file);
  assert.equal(r.usage, file.usage.length);
  assert.equal(r.prices, 1);
  assert.deepEqual(b.settings.get().jobBudget, { usd: 4 });
  assert.equal(importAll(b, file).usage, 0, 'a second import adds nothing');
  app.settings.update({ prices: undefined, jobBudget: undefined });
});
