// EC14 (docs/ops/EC14_DESIGN.md): a fake ACP editor drives `sara acp` (node src/main.ts acp) over
// stdio against a throwaway Sara with a scripted model: initialize, a new session, a streamed
// prompt, permission requests answered allow and deny, files read and written through the editor,
// a command in the editor's terminal, cancel, session/load, and no sign-in.
import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { policy, PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { editFileTool, listDir, readFileTool, searchTool, shellTool, writeFileTool } from '../src/tools/builtin.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { applyEdit, insideFolder, toolKind } from '../clients/cli/acp.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

type Json = Record<string, unknown>;
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
for (const t of [readFileTool, writeFileTool, editFileTool, listDir, searchTool, shellTool]) app.tools.add(t);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
setAuditTrail(new AuditTrail(dir, { key: () => 'k', policyRev: () => policy().get().rev }));
setPolicy(new PolicyStore(dir));
const project = join(dir, 'editor', 'my-app');
mkdirSync(join(project, 'src'), { recursive: true });
writeFileSync(join(project, 'src', 'main.ts'), 'console.log("hello from disk");\n');
writeFileSync(join(project, '.env'), 'SECRET=1\n');
let base = '';

/** A scripted ACP editor: answers the agent's fs, permission and terminal requests. */
class FakeEditor {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly updates: Json[] = [];
  readonly requests: Json[] = [];
  /** The editor's open buffers (unsaved text wins over disk). */
  readonly buffers = new Map<string, string>();
  readonly written = new Map<string, string>();
  /** Answers to permission requests, in order: an optionId, or 'cancelled'. */
  readonly permissions: string[] = [];
  /** Hold the next fs/read_text_file until this is called. */
  holdRead?: (release: () => void) => void;
  #id = 100;
  readonly #waiting = new Map<number, (m: Json) => void>();
  stderr = '';
  constructor(env: NodeJS.ProcessEnv) {
    this.proc = spawn(process.execPath, [...(env.EC14_VIA_SARA_CHAT ? [join(ROOT, 'clients', 'cli', 'bin', 'sara-chat.mjs')] : [join(ROOT, 'src', 'main.ts')]), 'acp'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => (this.stderr += String(d)));
    createInterface({ input: this.proc.stdout }).on('line', (line) => void this.#onLine(line));
  }
  #send(m: Json): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }
  async #onLine(line: string): Promise<void> {
    const m = JSON.parse(line) as Json;
    if (m.method === undefined) return this.#waiting.get(Number(m.id))?.(m);
    if (m.id === undefined) {
      if (m.method === 'session/update') this.updates.push((m.params as Json).update as Json);
      return;
    }
    this.requests.push(m);
    const p = (m.params ?? {}) as Json;
    const reply = (result: unknown) => this.#send({ id: m.id, result });
    switch (m.method) {
      case 'fs/read_text_file': {
        const path = String(p.path);
        const answer = () => {
          const text = this.buffers.get(path) ?? (() => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } })();
          if (text === undefined) this.#send({ id: m.id, error: { code: -32002, message: `Resource not found: ${path}` } });
          else reply({ content: text });
        };
        if (this.holdRead) {
          const h = this.holdRead;
          this.holdRead = undefined;
          return h(answer);
        }
        return answer();
      }
      case 'fs/write_text_file':
        this.written.set(String(p.path), String(p.content));
        this.buffers.set(String(p.path), String(p.content));
        return reply({});
      case 'session/request_permission': {
        const next = this.permissions.shift() ?? 'reject-once';
        return reply({ outcome: next === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: next } });
      }
      case 'terminal/create':
        return reply({ terminalId: 'term_1' });
      case 'terminal/wait_for_exit':
        return reply({ exitCode: 0, signal: null });
      case 'terminal/output':
        return reply({ output: 'all 3 tests passed\n', truncated: false, exitStatus: { exitCode: 0, signal: null } });
      case 'terminal/kill':
      case 'terminal/release':
        return reply({});
      default:
        this.#send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
  request(method: string, params: Json): Promise<Json> {
    const id = this.#id++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#send({ id, method, params });
    });
  }
  notify(method: string, params: Json): void {
    this.#send({ method, params });
  }
  async close(): Promise<void> {
    this.proc.stdin.end();
    await new Promise((r) => (this.proc.exitCode !== null ? r(null) : this.proc.once('exit', r)));
  }
}

const caps = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } };
const editors: FakeEditor[] = [];
const open = (env: NodeJS.ProcessEnv = { SARA_URL: base, SARA_TOKEN: token }) => {
  const e = new FakeEditor({ SARA_CHAT_CONFIG_DIR: join(dir, 'no-config'), ...env });
  editors.push(e);
  return e;
};
let ed: FakeEditor;
let sessionId = '';
const result = (m: Json) => {
  if (m.error) assert.fail(`ACP error: ${JSON.stringify(m.error)}`);
  return m.result as Json;
};
const prompt = async (text: string, extra: Json[] = []) => result(await ed.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }, ...extra] }));
const chunks = (from: number) => ed.updates.slice(from).filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => String((u.content as Json).text)).join('');

before(async () => {
  app.settings.update({ providers: [{ id: 'fake', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' }], defaultProviderId: 'fake', defaultModel: 'fake-small', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { shell: 'ask' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ed = open();
});
after(async () => {
  for (const e of editors) await e.close().catch(() => undefined);
  server.close();
  app.store.close();
  cleanup();
});

test('EC14 acp helpers: paths stay in the folder, secrets are refused, kinds, edits', () => {
  assert.equal(insideFolder(project, 'src/main.ts').rel, 'src/main.ts');
  assert.equal(insideFolder(project, join(project, 'src', 'main.ts')).rel, 'src/main.ts');
  assert.throws(() => insideFolder(project, '../other/x.ts'), /outside the folder/);
  assert.throws(() => insideFolder(project, '/etc/passwd'), /outside the folder/);
  assert.throws(() => insideFolder(project, '.env'), /env files, keys or credentials/);
  assert.throws(() => insideFolder(project, 'deploy/id_ed25519'), /credentials/);
  assert.equal(insideFolder(project, 'src/tokens.ts').rel, 'src/tokens.ts', 'ordinary code that mentions tokens is fine');
  assert.deepEqual(['read_file', 'edit_file', 'search', 'shell', 'web_fetch', 'remember'].map(toolKind), ['read', 'edit', 'search', 'execute', 'fetch', 'other']);
  assert.equal(applyEdit('a\r\nb\r\n', { old_string: 'a\nb', new_string: 'x\ny' }), 'x\r\ny\r\n');
  assert.throws(() => applyEdit('aa', { old_string: 'a', new_string: 'b' }), /matches 2 places/);
});

test('EC14 acp: initialize negotiates version 1 and the capabilities; a terminal sign-in is offered', async () => {
  const r = result(await ed.request('initialize', { protocolVersion: 1, clientCapabilities: caps, clientInfo: { name: 'zed', title: 'Zed', version: '0.200.0' } }));
  assert.equal(r.protocolVersion, 1);
  const ac = r.agentCapabilities as Json;
  assert.equal(ac.loadSession, true);
  assert.deepEqual(ac.promptCapabilities, { image: false, audio: false, embeddedContext: true });
  assert.deepEqual((r.authMethods as Json[])[0], { id: 'sara-login', name: 'Sign in to Sara', description: 'Shows a code to approve in Sara (Settings → Devices and sign-in).', type: 'terminal', args: ['login'] });
  assert.equal((r.agentInfo as Json).name, 'sara');
  assert.equal(((await ed.request('nope/method', {})).error as Json).code, -32601);
});

test('EC14 acp: a new session is a coding chat; a prompt streams her reply and reads files through the editor', async () => {
  const r = result(await ed.request('session/new', { cwd: project, mcpServers: [] }));
  sessionId = String(r.sessionId);
  const conv = app.store.getConversation(sessionId)!;
  assert.equal(conv.mode, 'coding');
  assert.equal(conv.title, 'Zed: my-app');
  // The editor's buffer has unsaved text: she must see that, not the disk.
  const main = join(project, 'src', 'main.ts');
  ed.buffers.set(main, 'console.log("hello from the buffer");\n');
  app.script.push([call('r1', 'read_file', { path: 'src/main.ts' })], text('It prints', ' hello from the buffer.'));
  const from = ed.updates.length;
  const done = await prompt('What does main.ts do?', [{ type: 'resource_link', uri: `file://${main.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1')}`, name: 'main.ts' }]);
  assert.equal(done.stopReason, 'end_turn');
  assert.match(chunks(from), /It prints hello from the buffer\./);
  const tc = ed.updates.slice(from).find((u) => u.sessionUpdate === 'tool_call')!;
  assert.equal(tc.kind, 'read');
  assert.equal(tc.toolCallId, 'r1');
  assert.deepEqual(tc.locations, [{ path: main }]);
  assert.ok(ed.updates.slice(from).some((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'r1' && u.status === 'completed'));
  const toModel = app.requests.at(-1)!.messages;
  assert.match(String(toModel.find((m) => m.role === 'tool')?.content), /hello from the buffer/);
  assert.match(String(toModel.filter((m) => m.role === 'user').at(-1)?.content), /File file:.*main\.ts:\n```\nconsole\.log\("hello from the buffer"\)/, 'the linked file went with the message');
  assert.ok(ed.requests.filter((m) => m.method === 'fs/read_text_file').length >= 2);
});

test('EC14 acp: an edit is written by the editor after an in-editor OK; a rejected one writes nothing', async () => {
  const main = join(project, 'src', 'main.ts');
  ed.permissions.push('allow-once', 'reject-once');
  app.script.push([call('e1', 'edit_file', { path: 'src/main.ts', old_string: 'hello', new_string: 'hi' })], [call('e2', 'write_file', { path: 'src/extra.ts', content: 'x' })], text('Changed the greeting.'));
  const from = ed.updates.length;
  const reqFrom = ed.requests.length;
  assert.equal((await prompt('Say hi instead')).stopReason, 'end_turn');
  const perms = ed.requests.slice(reqFrom).filter((m) => m.method === 'session/request_permission');
  assert.equal(perms.length, 2);
  const tc = (perms[0].params as Json).toolCall as Json;
  assert.equal(tc.kind, 'edit');
  assert.deepEqual((tc.content as Json[])[0], { type: 'diff', path: main, oldText: 'console.log("hello from the buffer");\n', newText: 'console.log("hi from the buffer");\n' });
  assert.deepEqual(((perms[0].params as Json).options as Json[]).map((o) => o.kind), ['allow_once', 'allow_always', 'reject_once']);
  assert.equal(ed.written.get(main), 'console.log("hi from the buffer");\n');
  assert.equal(ed.written.has(join(project, 'src', 'extra.ts')), false, 'rejected: nothing written');
  assert.equal(readFileSync(main, 'utf8'), 'console.log("hello from disk");\n', 'the editor writes, not sara acp');
  const toolMsgs = app.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.ok(toolMsgs.some((c) => /declined this change in the editor/.test(c)));
  assert.ok(ed.updates.slice(from).some((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'e1' && Array.isArray(u.content) && (u.content as Json[])[0].type === 'diff'));
  // Her workspace on the server is untouched.
  assert.deepEqual(app.store.getConversation(sessionId)!.workspace, 'my-app');
  assert.throws(() => readFileSync(join(workspaceDir(dir, 'my-app'), 'src', 'main.ts')));
});

test('EC14 acp: her approval card is the editor permission; allowed commands run in the editor terminal, denied ones never', async () => {
  ed.permissions.push('allow-once');
  app.script.push([call('s1', 'shell', { command: 'npm test' })], text('Tests pass.'));
  let reqFrom = ed.requests.length;
  await prompt('Run the tests');
  let reqs = ed.requests.slice(reqFrom).map((m) => String(m.method));
  assert.deepEqual(reqs.filter((m) => m === 'session/request_permission').length, 1, 'asked once: her card, not again for the run');
  assert.ok(reqs.includes('terminal/create') && reqs.includes('terminal/release'));
  const create = ed.requests.slice(reqFrom).find((m) => m.method === 'terminal/create')!.params as Json;
  assert.equal(create.cwd, project);
  assert.match(JSON.stringify(create.args), /npm test/);
  assert.match(String(app.requests.at(-1)!.messages.filter((m) => m.role === 'tool').at(-1)?.content), /exit code 0.*in the editor's terminal\]\nall 3 tests passed/s);
  // Denied in the editor: the server is told no; nothing runs.
  ed.permissions.push('reject-once');
  app.script.push([call('s2', 'shell', { command: 'rm -rf build' })], text('OK, I left it.'));
  reqFrom = ed.requests.length;
  await prompt('Clean the build');
  reqs = ed.requests.slice(reqFrom).map((m) => String(m.method));
  assert.ok(!reqs.includes('terminal/create'));
  assert.match(String(app.requests.at(-1)!.messages.filter((m) => m.role === 'tool').at(-1)?.content), /declined/);
});

test('EC14 acp: list and search work on the folder on disk and skip secrets', async () => {
  app.script.push([call('l1', 'list_dir', { path: '.' })], [call('q1', 'search', { pattern: 'SECRET|hello' })], text('Listed.'));
  await prompt('What is in here?');
  const tools = app.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.match(tools.at(-2)!, /^src\//m);
  assert.doesNotMatch(tools.at(-2)!, /\.env/);
  assert.match(tools.at(-1)!, /src\/main\.ts:1: console\.log\("hello from disk"\)/);
  assert.doesNotMatch(tools.at(-1)!, /SECRET/);
});

test('EC14 acp: cancel stops the turn with stopReason cancelled', async () => {
  app.script.push([call('r9', 'read_file', { path: 'src/main.ts' })], text('never sent'));
  let release: (() => void) | undefined;
  ed.holdRead = (r) => (release = r);
  const pending = ed.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Read it slowly' }] });
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(release, 'the read reached the editor');
  ed.notify('session/cancel', { sessionId });
  const r = result(await pending);
  assert.equal(r.stopReason, 'cancelled');
  release!();
  app.script.length = 0;
  // The session goes on after a cancel.
  app.script.push(text('Still here.'));
  assert.equal((await prompt('Hello?')).stopReason, 'end_turn');
});

test('EC14 acp: session/load replays the conversation; unknown sessions are refused', async () => {
  const other = open();
  result(await other.request('initialize', { protocolVersion: 1, clientCapabilities: caps, clientInfo: { name: 'zed' } }));
  const r = result(await other.request('session/load', { sessionId, cwd: project, mcpServers: [] }));
  assert.deepEqual(r, {});
  const kinds = other.updates.map((u) => u.sessionUpdate);
  assert.ok(kinds.includes('user_message_chunk') && kinds.includes('agent_message_chunk'));
  assert.ok(other.updates.some((u) => /What does main\.ts do\?/.test(String((u.content as Json).text))));
  const bad = await other.request('session/prompt', { sessionId: 'not-a-session', prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal((bad.error as Json).code, -32002);
});

test('EC14 acp: without the editor files she works in her own workspace for the folder', async () => {
  const plain = open();
  result(await plain.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'tiny-editor' } }));
  const s = result(await plain.request('session/new', { cwd: project, mcpServers: [] }));
  app.script.push([call('w1', 'write_file', { path: 'notes.md', content: 'plan' })], text('Saved in my workspace.'));
  const r = result(await plain.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Write a plan' }] }));
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(readFileSync(join(workspaceDir(dir, 'my-app'), 'notes.md'), 'utf8'), 'plan');
  assert.ok(!plain.requests.some((m) => String(m.method).startsWith('fs/')));
});

test('EC14 acp: not signed in, sessions need authentication (ACP auth_required)', async () => {
  const anon = open({ SARA_URL: '', SARA_TOKEN: '' });
  const init = result(await anon.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'zed' } }));
  assert.equal(((init.authMethods as Json[])[0] as Json).type, undefined, 'no terminal sign-in without auth.terminal');
  const r = await anon.request('session/new', { cwd: project, mcpServers: [] });
  assert.equal((r.error as Json).code, -32000);
  assert.match(String((r.error as Json).message), /sara-chat acp login/);
  assert.equal(anon.stderr.includes('Error'), false);
});

test('EC14 acp: sara-chat acp is the same agent (for computers with only sara-chat)', async () => {
  const viaChat = open({ SARA_URL: base, SARA_TOKEN: token, EC14_VIA_SARA_CHAT: '1' });
  const init = result(await viaChat.request('initialize', { protocolVersion: 1, clientCapabilities: caps, clientInfo: { name: 'zed' } }));
  assert.equal(init.protocolVersion, 1);
  const s = result(await viaChat.request('session/new', { cwd: project, mcpServers: [] }));
  assert.equal(app.store.getConversation(String(s.sessionId))?.mode, 'coding');
});
