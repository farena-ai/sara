// N5 (Mac parity): the Mac app now offers the person's own tabs (AppleScript, behind "Let Sara see my tabs"),
// Files (read only, the same scope choices), approved commands (zsh) and its own updates. The server needs
// few changes: it reads the ops a device says it has. These tests use a device that says hello like the Mac
// app (its ops are read from desktop/mac/Sources/Hands.swift) and check what the server tells her.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { HandsHub } from '../src/hands.ts';
import { openPlan, readOnlyCommand, runPlan, RunRuleError, runShell, type RunExecutor, type RunPrompt } from '../src/hands-run.ts';
import { HandsRef, type HandsRefOptions } from '../src/hands-ref.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { createPcRunTools } from '../src/tools/pc-run.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** The Mac app's command set, as its source declares it (Hands.ops). */
function macOps(): string[] {
  const src = readFileSync(join(ROOT, 'desktop/mac/Sources/Hands.swift'), 'utf8');
  const block = /static let ops: Set<String> = \[([\s\S]*?)\]\n/.exec(src)?.[1] ?? '';
  return [...block.matchAll(/"([a-z]\.[A-Za-z]+)"/g)].map((m) => m[1]);
}

/** A device that says hello like the Mac app (app, system, ops and its own "see my tabs" switch). */
interface MacHello {
  ops: string[];
  tabs?: boolean;
  desktop?: boolean;
  files?: boolean;
  app?: string;
}
class MacRef extends HandsRef {
  readonly mac: MacHello;
  constructor(opts: HandsRefOptions, mac: MacHello) {
    super(opts);
    this.mac = mac;
  }
  override hello(): Record<string, unknown> {
    const h = super.hello();
    return {
      ...h,
      app: this.mac.app ?? 'Sara for Mac 3.6.0',
      os: 'macOS 15.1.0',
      ops: this.mac.ops,
      optIn: { ...(h.optIn as object), desktop: this.mac.desktop !== false, files: this.mac.files !== false, ...(this.mac.tabs === undefined ? {} : { tabs: this.mac.tabs }) },
      fileRoots: ['desktop', 'documents', 'downloads', 'home'],
      fileScope: 'home',
      perms: { capture: true, input: true, ax: true },
    };
  }
}

interface Env {
  app: TestApp;
  token: string;
  base: string;
  hub: HandsHub;
  conv: string;
}
async function env(): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, allowed: () => true, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.persona = { ...app.persona, name: 'Fred', pronouns: 'he' };
  for (const t of createComputerTools(app)) app.tools.add(t);
  for (const t of createPcRunTools(app)) app.tools.add(t);
  const server: Server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const conv = app.store.createConversation({ title: 'Mac' }).id;
  app.store.addMessage(conv, 'user', 'what can you do on my Mac');
  cleanups.push(async () => {
    hub.closeAll();
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    app.store.close();
    cleanup();
  });
  return { app, token, base, hub, conv };
}
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
async function mac(e: Env, mac: MacHello, answer: 'once' | 'deny' = 'once') {
  const r = await fetch(`${e.base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ali MacBook', token: e.token }) });
  const { token, id } = (await r.json()) as { token: string; id: string };
  const prompts: RunPrompt[] = [];
  const shells: string[] = [];
  const exec: RunExecutor = async (x) => {
    shells.push(x.shell);
    x.onChunk(`ran: ${x.command}\n`);
    return { exitCode: 0, timedOut: false, stopped: false };
  };
  const ref = new MacRef({ server: e.base, token, name: 'Ali MacBook', reconnect: false, run: { on: true, level: 'task', consent: async (p) => (prompts.push(p), answer), exec, open: () => {} } }, mac);
  await ref.start();
  cleanups.push(() => ref.stop());
  await until(() => Boolean(e.hub.hello(id)));
  return { ref, id, prompts, shells };
}
const ctxFor = (e: Env): ToolContext => ({ workspaceDir: e.app.dataDir, signal: new AbortController().signal, sandbox: e.app.sandbox, conversationId: e.conv });
async function call(e: Env, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    return String(await e.app.tools.get(name)!.run(args, ctxFor(e)));
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

test('the Mac app declares the new ops (tabs, tab switch, files, commands) in its command set', () => {
  const ops = macOps();
  for (const op of ['d.tabs', 'd.tabswitch', 'f.list', 'f.read', 'c.run', 'c.open', 'd.shot', 'b.open']) assert.ok(ops.includes(op), op);
  const src = readFileSync(join(ROOT, 'desktop/mac/Sources/Hands.swift'), 'utf8');
  // Waiting ops (the card on the Mac may take minutes) and the hello's switches.
  assert.match(src, /waitingOps: Set<String> = \[[^\]]*"d\.tabswitch", "c\.run", "c\.open"\]/);
  assert.match(src, /func optInView\(\) -> \[String: Any\] \{ \["browser": true, "desktop": desktop, "files": files, "run": runner\.on, "tabs": tabsOn\] \}/);
  assert.match(src, /"fileRoots": HandsFiles\.rootNames\(\), "fileScope": HandsFiles\.scopeName/);
});

test('pc_devices: a current Mac app says what it can do (zsh commands, files, tabs) and nothing about "for now"', async () => {
  const e = await env();
  const d = await mac(e, { ops: macOps(), tabs: true });
  const h = e.hub.devices().find((x) => x.id === d.id)!;
  assert.equal(h.optIn?.tabs, true);
  assert.equal(h.optIn?.run, true);
  assert.deepEqual(h.fileRoots, ['desktop', 'documents', 'downloads', 'home']);
  const out = await call(e, 'pc_devices', {});
  assert.match(out, /Sara for Mac 3\.6\.0, macOS 15\.1\.0/);
  assert.match(out, /you may run zsh commands there/);
  assert.doesNotMatch(out, /PowerShell or cmd commands there/);
  assert.match(out, /read the owner's own browser tabs \(pc_my_tabs\) and bring one to the front/);
  assert.match(out, /their whole user folder \("home"\)/);
  assert.doesNotMatch(out, /for Mac can't|for now/);
});

test('pc_devices: "Let Sara see my tabs" off on the Mac is named exactly', async () => {
  const e = await env();
  await mac(e, { ops: macOps(), tabs: false });
  const out = await call(e, 'pc_devices', {});
  assert.match(out, /"Let Fred see my tabs" is off there/);
  assert.match(out, /Not now[\s\S]*read their own browser tabs: "Let Fred see my tabs" is off/);
  assert.doesNotMatch(out, /• read the owner's own browser tabs/);
});

test('an older Mac app (no tabs, files or commands) is told to update, like an older Windows app', async () => {
  const e = await env();
  const old = macOps().filter((o) => !['d.tabs', 'd.tabswitch', 'f.list', 'f.read', 'c.run', 'c.open'].includes(o));
  await mac(e, { ops: old, app: 'Sara for Mac 3.5.0' });
  const out = await call(e, 'pc_devices', {});
  assert.match(out, /this Sara app is older \(Sara for Mac 3\.5\.0\): to let you see every open tab of their own browsers and read their files, the owner needs to update the Sara app/);
  const run = await call(e, 'pc_run', { command: 'ls' });
  assert.match(run, /The Sara app on Ali MacBook is older and can't run commands yet\. Tell the owner to update the Sara app/);
  const files = await call(e, 'pc_files', { folder: 'documents' });
  assert.match(files, /can't read the owner's files yet\. Tell the owner to update the Sara app/);
});

test('pc_run on a Mac runs zsh (whatever shell was asked), shown as zsh on the Mac\'s card', async () => {
  const e = await env();
  const d = await mac(e, { ops: macOps(), tabs: true });
  const out = await call(e, 'pc_run', { command: 'ls -la ~/Documents', shell: 'powershell' });
  assert.match(out, /^Ran on Ali MacBook \(zsh, [\d.]+ s\): exit code 0\./);
  assert.deepEqual(d.shells, ['zsh']);
  assert.equal(d.prompts.length, 1);
  assert.match(d.prompts[0].text, /^zsh in ~ \(home\):\nls -la ~\/Documents$/);
});

test('pc_run with zsh on a Windows computer is refused before anything is sent', async () => {
  const e = await env();
  const r = await fetch(`${e.base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Alex PC', token: e.token }) });
  const { token, id } = (await r.json()) as { token: string; id: string };
  const ran: string[] = [];
  const ref = new (class extends HandsRef {
    override hello() {
      return { ...super.hello(), app: 'Sara for Windows 3.6.0', os: 'Windows 11' };
    }
  })({ server: e.base, token, name: 'Alex PC', reconnect: false, run: { on: true, consent: async () => 'once', exec: async (x) => (ran.push(x.command), { exitCode: 0, timedOut: false, stopped: false }), open: () => {} } });
  await ref.start();
  cleanups.push(() => ref.stop());
  await until(() => Boolean(e.hub.hello(id)));
  const out = await call(e, 'pc_run', { command: 'ls', shell: 'zsh' });
  assert.match(out, /Alex PC is a Windows computer: use shell "powershell" \(default\) or "cmd"/);
  assert.equal(ran.length, 0);
});

test('the Mac rules on the server: zsh, sudo/su/admin refused, Mac changes always ask, Mac program files never opened', () => {
  assert.equal(runShell('zsh'), 'zsh');
  assert.equal(runShell('bash'), 'zsh');
  assert.equal(runShell(''), 'powershell');
  for (const bad of ['sudo ls', 'su -', 'ls && su root', 'doas whoami', `osascript -e 'do shell script "id" with administrator privileges'`]) assert.throws(() => runPlan({ command: bad, shell: 'zsh' }), RunRuleError, bad);
  for (const ok of ['ls ~/sudoku', 'echo summary']) assert.doesNotThrow(() => runPlan({ command: ok, shell: 'zsh' }), ok);
  for (const d of ['chmod 777 x', 'launchctl unload x', 'defaults write com.apple.dock x 1', 'diskutil eraseDisk x', 'killall Dock', 'brew install x', 'osascript -e "quit app \\"Mail\\""']) assert.equal(runPlan({ command: d, shell: 'zsh' }).destructive, true, d);
  for (const ro of ['ls -la', 'df -h', 'cat notes.txt | head -5', 'git status', 'sw_vers']) assert.equal(readOnlyCommand(ro), true, ro);
  for (const no of ['echo $HOME', 'ls; rm x', 'cat a > b']) assert.equal(readOnlyCommand(no), false, no);
  for (const bad of ['/Applications/Calculator.app', '/Applications/Calculator.app/', '~/run.command', '~/x.sh', '~/Downloads/setup.pkg', '~/x.workflow', '~/a.scpt']) assert.throws(() => openPlan(bad), RunRuleError, bad);
  assert.equal(openPlan('~/Documents/report.pdf').kind, 'path');
  assert.equal(openPlan('TextEdit').kind, 'app');
});
