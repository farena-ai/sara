// EC14 (docs/ops/EC14_DESIGN.md): the server side of editors (ACP): editor sessions, editor-linked
// turns whose file and command tools run in the editor, the policy pin and the audit row.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { cleanEditorLink, EditorCalls, editorCalls, folderWorkspace } from '../src/editor-link.ts';
import { policy, PolicyStore, setPolicy, validatePolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { editFileTool, listDir, readFileTool, searchTool, shellTool, writeFileTool } from '../src/tools/builtin.ts';
import { call, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
for (const t of [readFileTool, writeFileTool, editFileTool, listDir, searchTool, shellTool]) app.tools.add(t);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
setAuditTrail(new AuditTrail(dir, { key: () => 'k', policyRev: () => policy().get().rev }));
setPolicy(new PolicyStore(dir));
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'fake', label: 'Fake', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' }], defaultProviderId: 'fake', defaultModel: 'fake-small', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { shell: 'ask' } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown } = {}) =>
  fetch(base + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });

/** Sends a message and reads its events; `on` answers events as they arrive (like an editor would). */
async function turn(convId: string, content: string, body: Record<string, unknown>, on: (ev: Record<string, unknown>) => Promise<void> | void = () => {}): Promise<Record<string, unknown>[]> {
  const res = await req(`/api/conversations/${convId}/messages`, { method: 'POST', body: { content, ...body } });
  if (res.status !== 200) assert.fail(`${res.status} ${await res.text()}`);
  const events: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      const ev = JSON.parse(data) as Record<string, unknown>;
      events.push(ev);
      await on(ev);
    }
  }
  return events;
}

test('EC14 link: the editor link is cleaned; folders become workspace names', () => {
  assert.deepEqual(cleanEditorLink({ label: 'Zed\u0000 editor', terminal: true }), { label: 'Zed editor', terminal: true });
  assert.deepEqual(cleanEditorLink({}), { label: 'Editor', terminal: false });
  assert.equal(cleanEditorLink('yes'), undefined);
  assert.equal(folderWorkspace('/home/alex/My App!'), 'My-App');
  assert.equal(folderWorkspace('C:\\code\\sara'), 'sara');
  assert.equal(folderWorkspace('/'), 'editor');
  assert.equal(folderWorkspace('/x/...'), 'editor');
});

test('EC14 calls: an answer settles the call once; abort and timeout cancel it', async () => {
  const calls = new EditorCalls();
  const a = calls.open('c1', new AbortController().signal);
  assert.equal(calls.answer(a.id, { ok: true, output: 'done' }), true);
  assert.equal(await a.result, 'done');
  assert.equal(calls.answer(a.id, { ok: true, output: 'again' }), false, 'settled once');
  const b = calls.open('c1', new AbortController().signal);
  calls.answer(b.id, { ok: false, output: 'File not found: x' });
  await assert.rejects(b.result, /File not found: x/);
  const ctl = new AbortController();
  const c = calls.open('c1', ctl.signal);
  ctl.abort();
  await assert.rejects(c.result, /Cancelled/);
  const d = calls.open('c1', new AbortController().signal, 20);
  await assert.rejects(d.result, /didn't answer/);
  assert.equal(calls.answer('nope', { ok: true, output: '' }), false);
});

test('EC14 sessions: a coding chat named after the editor and folder, with one audit row', async () => {
  const n = auditTrail()!.list().length;
  const r = await req('/api/editor/sessions', { method: 'POST', body: { editor: 'Zed', folder: '/home/alex/my-app' } });
  assert.equal(r.status, 201);
  const s = (await r.json()) as { conversationId: string; workspace: string; title: string };
  const conv = app.store.getConversation(s.conversationId)!;
  assert.equal(conv.mode, 'coding');
  assert.equal(conv.workspace, 'my-app');
  assert.equal(conv.title, 'Zed: my-app');
  const rows = auditTrail()!.list().slice(0, auditTrail()!.list().length - n);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'editor.session');
  assert.equal(rows[0].target, `conversation:${s.conversationId}`);
});

test('EC14 turn: only editor tools are offered, a file read runs in the editor and its answer reaches the model', async () => {
  const conv = app.store.createConversation({ mode: 'coding', title: 'Zed: app', workspace: 'app' });
  app.script.push([call('r1', 'read_file', { path: 'src/main.ts' })], text('It prints hello.'));
  const seen: Record<string, unknown>[] = [];
  const events = await turn(conv.id, 'What does main.ts do?', { editor: { label: 'Zed', terminal: false } }, async (ev) => {
    if (ev.type !== 'editor_call') return;
    seen.push(ev);
    const r = await req(`/api/editor/calls/${String(ev.callId)}`, { method: 'POST', body: { ok: true, output: '1| console.log("hello")' } });
    assert.equal(r.status, 200);
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'read_file');
  assert.deepEqual(seen[0].args, { path: 'src/main.ts' });
  assert.equal(seen[0].approved, false);
  const offered = (app.requests.at(-2)!.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(offered, ['edit_file', 'list_dir', 'read_file', 'search', 'web_fetch', 'write_file'], 'no shell without a terminal; nothing workspace-bound');
  const toolMsg = app.requests.at(-1)!.messages.find((m) => m.role === 'tool');
  assert.match(String(toolMsg?.content), /console\.log\("hello"\)/);
  assert.ok(events.some((e) => e.type === 'tool_result' && e.status === 'ok'));
  assert.match(String(app.store.messages(conv.id).at(-1)?.content), /prints hello/);
});

test('EC14 turn: a command asks with her card first; the editor runs it only after the OK', async () => {
  const conv = app.store.createConversation({ mode: 'coding', title: 'Zed: app', workspace: 'app' });
  app.script.push([call('s1', 'shell', { command: 'npm test' })], text('Tests pass.'));
  const order: string[] = [];
  await turn(conv.id, 'Run the tests', { editor: { label: 'Zed', terminal: true } }, async (ev) => {
    if (ev.type === 'approval') {
      order.push('approval');
      await req(`/api/approvals/${String(ev.approvalId)}`, { method: 'POST', body: { approved: true } });
    }
    if (ev.type === 'editor_call') {
      order.push(`editor:${String(ev.name)}:${String(ev.approved)}`);
      await req(`/api/editor/calls/${String(ev.callId)}`, { method: 'POST', body: { ok: true, output: '[exit code 0]\nok' } });
    }
  });
  assert.deepEqual(order, ['approval', 'editor:shell:true']);
  assert.ok((app.requests.at(-2)!.tools ?? []).some((t) => t.name === 'shell'));
});

test('EC14 turn: a declined card never reaches the editor; an editor error is the tool error', async () => {
  const conv = app.store.createConversation({ mode: 'coding', title: 'Zed: app', workspace: 'app' });
  app.script.push([call('s2', 'shell', { command: 'rm -rf build' })], [call('w1', 'write_file', { path: '.env', content: 'X=1' })], text('OK.'));
  const editorSeen: string[] = [];
  const events = await turn(conv.id, 'Clean up', { editor: { label: 'Zed', terminal: true } }, async (ev) => {
    if (ev.type === 'approval') await req(`/api/approvals/${String(ev.approvalId)}`, { method: 'POST', body: { approved: false } });
    if (ev.type === 'editor_call') {
      editorSeen.push(String(ev.name));
      await req(`/api/editor/calls/${String(ev.callId)}`, { method: 'POST', body: { ok: false, output: "Sara can't touch .env files." } });
    }
  });
  assert.deepEqual(editorSeen, ['write_file']);
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((r) => r.status), ['denied', 'error']);
  assert.match(String(results[1].output), /can't touch \.env/);
});

test('EC14 turn: Stop cancels a call the editor never answers; foreign call ids are 404', async () => {
  const conv = app.store.createConversation({ mode: 'coding', title: 'Zed: app', workspace: 'app' });
  app.script.push([call('r2', 'read_file', { path: 'a.txt' })], text('never'));
  const events = await turn(conv.id, 'Read a.txt', { editor: { label: 'Zed' } }, async (ev) => {
    if (ev.type === 'editor_call') await req(`/api/conversations/${conv.id}/stop`, { method: 'POST', body: {} });
  });
  assert.ok(events.some((e) => e.type === 'editor_call'));
  assert.equal(editorCalls.size, 0, 'nothing left waiting');
  app.script.length = 0;
  assert.equal((await req('/api/editor/calls/not-a-call', { method: 'POST', body: { ok: true, output: 'x' } })).status, 404);
});

test('EC14 turn: without an editor link her own workspace tools run as before', async () => {
  const conv = app.store.createConversation({ mode: 'coding', title: 'Plain', workspace: 'plain' });
  app.script.push([call('w2', 'write_file', { path: 'note.txt', content: 'hi' })], text('Wrote it.'));
  const events = await turn(conv.id, 'Write a note', {});
  assert.ok(!events.some((e) => e.type === 'editor_call'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.status === 'ok'));
});

test('EC14 policy: editors can be pinned off (never on); sessions and editor turns are refused', async () => {
  assert.throws(() => validatePolicy({ pins: { editors: true } }), /pinned off/);
  assert.deepEqual(validatePolicy({ pins: { editors: false } }).pins, { editors: false });
  policy().set({ name: 'Office', pins: { editors: false } });
  try {
    const r = await req('/api/editor/sessions', { method: 'POST', body: { editor: 'Zed', folder: '/x/app' } });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /Set by your admin/);
    const conv = app.store.createConversation({ mode: 'coding' });
    const t = await req(`/api/conversations/${conv.id}/messages`, { method: 'POST', body: { content: 'hi', editor: { label: 'Zed' } } });
    assert.equal(t.status, 409);
    assert.equal(policy().editorsOn, false);
  } finally {
    policy().set({ name: 'Office', pins: {} });
  }
  assert.equal(policy().editorsOn, true);
});
