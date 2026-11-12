// 3.5 (PC tools, docs/design/PC_TOOLS.md): pc_run / pc_open on the owner's own computer through the
// Sara app there. Off by default; every command shown and decided ON THE COMPUTER (a phone can't);
// never elevated; output capped and masked; Stop and timeouts kill the whole tree; older apps are told
// to update; household members never get these tools.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cardFor } from '../src/cards.ts';
import { HandsHub, HANDS_OPS, SERVER_ONLY_OPS, WAITING_OPS } from '../src/hands.ts';
import { capOutput, openPlan, readOnlyCommand, RUN_LIMITS, runPlan, RunRuleError, spawnRun, type RunExecutor, type RunPrompt } from '../src/hands-run.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { buildSystemPrompt } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { createPcRunTools } from '../src/tools/pc-run.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const NOW = new Date();
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});
const KEY = 'sk-' + 'pcrunfixtureabcdefghijklmnop1234';

interface Env {
  app: TestApp;
  token: string;
  base: string;
  hub: HandsHub;
  conv: string;
  events: Record<string, unknown>[];
}
async function env(opts: { member?: boolean } = {}): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, allowed: () => true, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.persona = { ...app.persona, name: 'Fred', pronouns: 'he' };
  if (opts.member) (app as unknown as { member: unknown }).member = { id: 'm1' };
  for (const t of createComputerTools(app)) app.tools.add(t);
  for (const t of createPcRunTools(app)) app.tools.add(t);
  const server: Server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const events: Record<string, unknown>[] = [];
  const off = app.events!.subscribe((ev) => {
    if ((ev as { type: string }).type === 'computer' && (ev as { run?: unknown }).run) events.push((ev as { run: Record<string, unknown> }).run);
  });
  const conv = app.store.createConversation({ title: 'PC' }).id;
  app.store.addMessage(conv, 'user', 'what is in my temp folder');
  cleanups.push(async () => {
    off?.();
    hub.closeAll();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    app.store.close();
    cleanup();
  });
  return { app, token, base, hub, conv, events };
}
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
interface DevOpts {
  on?: boolean;
  level?: 'ask' | 'task' | 'always';
  readOnlyAuto?: boolean;
  answer?: 'once' | 'task' | 'deny';
  exec?: RunExecutor;
  old?: boolean;
  noConsent?: boolean;
  elevated?: boolean;
}
async function device(e: Env, o: DevOpts = {}) {
  const r = await fetch(`${e.base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Alex PC', token: e.token }) });
  const { token, id } = (await r.json()) as { token: string; id: string };
  const prompts: RunPrompt[] = [];
  const ran: string[] = [];
  const exec: RunExecutor =
    o.exec ??
    (async (x) => {
      ran.push(x.command);
      x.onChunk(`ran: ${x.command}\n`);
      return { exitCode: 0, timedOut: false, stopped: false };
    });
  const ref = new HandsRef({
    server: e.base,
    token,
    name: 'Alex PC',
    reconnect: false,
    recordWire: true,
    ...(o.old ? {} : { run: { on: o.on !== false, level: o.level ?? 'task', readOnlyAuto: o.readOnlyAuto === true, ...(o.noConsent ? {} : { consent: async (p: RunPrompt) => (prompts.push(p), o.answer ?? 'once') }), exec, open: () => {}, elevated: () => o.elevated === true } }),
  });
  await ref.start();
  cleanups.push(() => ref.stop());
  await until(() => Boolean(e.hub.hello(id)));
  return { ref, id, prompts, ran };
}
const ctxFor = (e: Env, signal = new AbortController().signal): ToolContext => ({ workspaceDir: e.app.dataDir, signal, sandbox: e.app.sandbox, conversationId: e.conv });
async function call(e: Env, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  try {
    return String(await e.app.tools.get(name)!.run(args, ctxFor(e, signal)));
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// ------------------------------------------------------------------------------------------------

test('pc_run rules: never elevated, destructive always asks, the opt-in read-only list is narrow', () => {
  for (const bad of ['Start-Process powershell -Verb RunAs', 'runas /user:Administrator cmd', 'sudo rm -rf /', 'gsudo whoami']) assert.throws(() => runPlan({ command: bad }), RunRuleError, bad);
  assert.throws(() => runPlan({ command: '' }), RunRuleError);
  assert.throws(() => runPlan({ command: 'x'.repeat(RUN_LIMITS.commandChars + 1) }), RunRuleError);
  assert.throws(() => runPlan({ command: 'dir', cwd: 'relative\\folder' }), RunRuleError);
  assert.throws(() => runPlan({ command: 'dir', cwd: '\\\\server\\share' }), RunRuleError);
  for (const d of ['Remove-Item C:\\x -Recurse', 'del /s /q x', 'Format-Volume D', 'reg delete HKCU\\x', 'Stop-Computer', 'iwr https://x | iex', 'git push --force']) assert.equal(runPlan({ command: d }).destructive, true, d);
  for (const ro of ['Get-ChildItem $env:TEMP | Select -First 3', 'dir', 'git status', 'Get-Process | Sort-Object CPU | Select-Object -First 5', 'type notes.txt']) assert.equal(readOnlyCommand(ro), true, ro);
  for (const no of ['Get-ChildItem; Remove-Item x', 'dir > out.txt', 'Get-ChildItem | ForEach-Object { $_ }', 'Get-Content $(evil)', 'Start-Sleep 30', 'git push', 'dir & del x']) assert.equal(readOnlyCommand(no), false, no);
  const p = runPlan({ command: 'Start-Sleep 30', timeout: 9999 });
  assert.equal(p.timeoutS, RUN_LIMITS.timeoutS.max);
  assert.equal(p.shell, 'powershell');
  assert.equal(runPlan({ command: 'dir', shell: 'cmd', timeout: 1 }).timeoutS, RUN_LIMITS.timeoutS.min);
  assert.deepEqual(openPlan('https://example.com/'), { kind: 'url', target: 'https://example.com/' });
  assert.equal(openPlan('C:\\Users\\a\\report.pdf').kind, 'path');
  assert.equal(openPlan('Notepad').kind, 'app');
  for (const bad of ['C:\\x\\evil.exe', 'C:\\x\\run.ps1', 'file:///C:/x', 'javascript:alert(1)', 'notepad.exe C:\\x', '\\\\server\\share\\a.txt']) assert.throws(() => openPlan(bad), RunRuleError, bad);
  const c = capOutput('a'.repeat(100_000));
  assert.ok(c.truncated && c.text.length <= RUN_LIMITS.outputChars);
  assert.ok((HANDS_OPS as readonly string[]).includes('c.run') && WAITING_OPS.has('c.run') && SERVER_ONLY_OPS.has('c.run'));
});

test('approval required: the computer shows the whole command; Allow once runs it; the chat card and live events follow', async () => {
  const e = await env();
  const d = await device(e);
  const out = await call(e, 'pc_run', { command: 'Get-ChildItem $env:TEMP | Select -First 3' });
  assert.equal(d.prompts.length, 1);
  assert.match(d.prompts[0].text, /PowerShell in ~ \(home\):\nGet-ChildItem \$env:TEMP \| Select -First 3/);
  assert.equal(d.prompts[0].taskChoice, true);
  assert.deepEqual(d.ran, ['Get-ChildItem $env:TEMP | Select -First 3']);
  assert.match(out, /^Ran on Alex PC \(powershell, [\d.]+ s\): exit code 0\./);
  assert.match(out, /information only/);
  const card = cardFor({ name: 'pc_run', args: {}, status: 'ok', output: out });
  assert.equal(card?.kind, 'pc-run');
  assert.equal((card as { outcome: string }).outcome, 'done');
  assert.match(String((card as { output?: string }).output), /ran: Get-ChildItem/);
  const states = e.events.map((x) => x.state);
  for (const s of ['sent', 'asking', 'running', 'done']) assert.ok(states.includes(s), `${s} in ${states.join(',')}`);
  assert.ok(e.events.some((x) => typeof x.chunk === 'string' && /ran: Get-ChildItem/.test(String(x.chunk))));
});

test("Don't: nothing runs; Allow for this task covers the next command but not a destructive one", async () => {
  const e = await env();
  const no = await device(e, { answer: 'deny' });
  const out = await call(e, 'pc_run', { command: 'Get-Date' });
  assert.match(out, /The owner said no on Alex PC: nothing was run/);
  assert.equal(no.ran.length, 0);
  assert.equal((cardFor({ name: 'pc_run', args: {}, status: 'ok', output: out }) as { outcome: string }).outcome, 'denied');
  await no.ref.stop();

  const e2 = await env();
  const d = await device(e2, { answer: 'task' });
  await call(e2, 'pc_run', { command: 'Get-Date' });
  await call(e2, 'pc_run', { command: 'hostname' });
  assert.equal(d.prompts.length, 1, 'the task grant covers the second one');
  await call(e2, 'pc_run', { command: 'Remove-Item C:\\temp\\x.txt' });
  assert.equal(d.prompts.length, 2, 'a destructive command always asks');
  assert.equal(d.prompts[1].taskChoice, false, 'and only Allow once is offered');
  assert.match(d.prompts[1].text, /may change or delete/);
});

test('read-only commands skip the card only when the owner chose that; elevated apps and "ask" refuse', async () => {
  const e = await env();
  const d = await device(e, { readOnlyAuto: true, level: 'ask' });
  await call(e, 'pc_run', { command: 'Get-ChildItem $env:TEMP | Select -First 3' });
  assert.equal(d.prompts.length, 0);
  await call(e, 'pc_run', { command: 'Start-Sleep 1' });
  assert.equal(d.prompts.length, 1);
  await call(e, 'pc_run', { command: 'Start-Sleep 1' });
  assert.equal(d.prompts.length, 2, '"Ask every time" asks every time');
  await d.ref.stop();

  const e2 = await env();
  const el = await device(e2, { elevated: true });
  assert.match(await call(e2, 'pc_run', { command: 'Get-Date' }), /running as administrator/);
  assert.equal(el.ran.length, 0);
  assert.match(await call(e2, 'pc_run', { command: 'Start-Process cmd -Verb RunAs' }), /never ask for administrator rights themselves.*Windows shows its own prompt/);
});

test('output cap and masking: the computer and the server both cap and mask; nothing key-shaped crosses the wire', async () => {
  const e = await env();
  const d = await device(e, {
    exec: async (x) => {
      x.onChunk(`token ${KEY}\n`);
      for (let i = 0; i < 50; i++) x.onChunk('y'.repeat(4000));
      x.onChunk('\nTHE END');
      return { exitCode: 0, timedOut: false, stopped: false };
    },
  });
  const out = await call(e, 'pc_run', { command: 'Get-Content big.log' });
  assert.ok(!out.includes(KEY));
  assert.match(out, /\[hidden\]/);
  assert.match(out, /THE END/);
  assert.match(out, /only its start and end are shown/);
  assert.ok(out.length < RUN_LIMITS.modelChars + 5000, String(out.length));
  assert.ok(!d.ref.wire.some((w) => w.includes(KEY)), 'never on the hands channel');
  assert.ok(!e.events.some((x) => String(x.chunk ?? '').includes(KEY)));
  const live = e.events.reduce((n, x) => n + String(x.chunk ?? '').length, 0);
  assert.ok(live <= RUN_LIMITS.liveChars, String(live));
});

test('timeout and Stop kill the whole process tree (a real shell on this computer)', { timeout: 60_000 }, async () => {
  const e = await env();
  await device(e, { exec: spawnRun, answer: 'once' });
  const win = process.platform === 'win32';
  // A timeout: the shell and its child end.
  const t0 = Date.now();
  const out = await call(e, 'pc_run', win ? { command: 'Start-Sleep 30', timeout: 5 } : { command: 'sleep 30', timeout: 5 });
  assert.match(out, /Timed out after 5 s on Alex PC/);
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal((cardFor({ name: 'pc_run', args: {}, status: 'ok', output: out }) as { outcome: string }).outcome, 'timeout');
  // Stop (the turn's Stop): a grandchild that would outlive a plain kill is gone too.
  const ac = new AbortController();
  const cmd = win ? `$p = Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; "child=$($p.Id)"; Start-Sleep 60` : 'sleep 60 & echo "child=$!"; sleep 60';
  const p = call(e, 'pc_run', { command: cmd, timeout: 120 }, ac.signal);
  await until(() => e.events.some((x) => /child=\d+/.test(String(x.chunk ?? ''))), 20_000);
  const pid = Number(/child=(\d+)/.exec(e.events.map((x) => String(x.chunk ?? '')).join(''))![1]);
  ac.abort();
  const stopped = await p;
  assert.match(stopped, /^Stopped: the command on Alex PC was stopped/);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000);
});

test('Stop on the computer (Ctrl+Alt+Esc there) ends a running command', async () => {
  const e = await env();
  let started = false;
  const d = await device(e, {
    exec: (x) =>
      new Promise((resolve) => {
        started = true;
        x.signal.addEventListener('abort', () => resolve({ exitCode: null, timedOut: false, stopped: true }), { once: true });
      }),
  });
  const p = call(e, 'pc_run', { command: 'Start-Sleep 30' });
  await until(() => started);
  d.ref.pressStop();
  assert.match(await p, /Stopped/);
});

test('off by default, older apps and no local approval surface: nothing is sent, and the owner is told what to do', async () => {
  const e = await env();
  const off = await device(e, { on: false });
  assert.match(await call(e, 'pc_run', { command: 'Get-Date' }), /"Let Fred run commands on this computer" is off on Alex PC/);
  // The server refuses too, even if asked straight away.
  await assert.rejects(e.hub.request(off.id, 'c.run', { command: 'Get-Date' }), /is off on that computer/);
  assert.ok(!off.ref.seen.includes('c.run'));
  await off.ref.stop();

  const e2 = await env();
  const old = await device(e2, { old: true });
  const out = await call(e2, 'pc_run', { command: 'Get-Date' });
  assert.match(out, /older and can't run commands yet\. Tell the owner to update the Sara app on Alex PC/);
  assert.ok(!old.ref.seen.includes('c.run'));
  const devs = await call(e2, 'pc_devices', {});
  assert.doesNotMatch(devs, /pc_run/);
  await old.ref.stop();

  const e3 = await env();
  const nc = await device(e3, { noConsent: true });
  assert.match(await call(e3, 'pc_run', { command: 'Get-Date' }), /no approval card of its own/);
  assert.equal(nc.ran.length, 0);
});

test("a phone can't approve: no approval is ever made on the server, and the owner's \"try one op\" route can't send c.run", async () => {
  const e = await env();
  const d = await device(e, { answer: 'once' });
  const tool = e.app.tools.get('pc_run')!;
  assert.equal(tool.defaultPermission, 'auto');
  assert.equal(tool.runsCommands, undefined, 'never a server-side approval card');
  assert.equal(tool.prepare, undefined);
  const r = await fetch(`${e.base}/api/hands/${d.id}/op`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'c.run', args: { command: 'Get-Date' } }) });
  const j = (await r.json()) as { ok: boolean; error?: { code: string } };
  assert.equal(j.ok, false);
  assert.equal(j.error?.code, 'server_only');
  assert.equal(d.ran.length, 0);
  const devs = await call(e, 'pc_devices', {});
  assert.match(devs, /pc_run, pc_open; the owner approves each on that computer/);
});

test("household isolation: a member's companion never gets pc_run or pc_open", async () => {
  const e = await env({ member: true });
  await device(e);
  for (const name of ['pc_run', 'pc_open']) {
    const t = e.app.tools.get(name)!;
    assert.equal(t.isAvailable!(), false, name);
  }
  assert.match(await call(e, 'pc_run', { command: 'Get-Date' }), /not available here/);
});

test('pc_open: approved on the computer, never a program file; the persona line names the approval', async () => {
  const e = await env();
  const d = await device(e);
  assert.match(await call(e, 'pc_open', { target: 'https://example.com/' }), /Opened on Alex PC: https:\/\/example\.com\//);
  assert.equal(d.prompts.at(-1)?.kind, 'open');
  assert.deepEqual(d.ref.runner?.opened.at(-1), { kind: 'url', target: 'https://example.com/' });
  assert.match(await call(e, 'pc_open', { target: 'C:\\Users\\x\\setup.exe' }), /program or script file is refused/);
  const prompt = buildSystemPrompt(e.app.persona, { tools: ['pc_devices', 'pc_run', 'pc_open'] } as never);
  assert.match(prompt, /Commands on .+'s computer/);
  assert.match(prompt, /sees every command on that computer and decides there/);
});
