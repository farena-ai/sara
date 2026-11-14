// MCP tool definitions stay at directory quality (Glama's Tool Definition Quality Score), and the
// planner write tools (complete/update/delete to-dos, update/delete notes) work through /mcp with
// her approval rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { DESCRIBE_TOOLS, describeAnswer, describeVersion, SARA_VERSION } from '../src/mcp-bridge.ts';
import { describeTools } from '../src/mcp-server.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type Tool = { name: string; title?: string; description: string; inputSchema: { type: string; properties: Record<string, { type?: string; description?: string }>; required?: string[] }; annotations: { title?: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } };
const tools = describeTools() as unknown as Tool[];
const WRITE = ['add_task', 'complete_task', 'update_task', 'delete_task', 'add_note', 'update_note', 'delete_note', 'remember_fact'];

/** Presses Allow on the newest waiting approval whose summary matches (in the app's changes conversation). */
async function allowLatest(summary: RegExp): Promise<void> {
  const conv = app.store.listConversations().find((c) => c.channel === 'mcp' && / changes \(MCP\)$/.test(c.title))!;
  assert.ok(conv, 'changes conversation');
  const a = (await approvals(conv.id)).filter((x) => summary.test(x.summary)).at(-1);
  assert.ok(a, `approval for ${summary}`);
  await decide(a!.approvalId, true);
}

test('MCP tool definitions stay at directory quality', () => {
  assert.ok(tools.length >= 12 && tools.length <= 20, `a reasonable number of tools (${tools.length})`);
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, 'unique names');
  for (const t of tools) {
    assert.match(t.name, /^(search|list|get|read|ask|add|complete|update|delete|remember)_[a-z]+(_[a-z]+)*$/, `${t.name}: verb_noun name`);
    assert.ok(t.title && t.title.length >= 4, `${t.name}: has a title`);
    assert.equal(t.annotations.title, t.title, `${t.name}: annotation title matches`);
    assert.ok(t.description.length >= 150, `${t.name}: description is ${t.description.length} characters (150 or more)`);
    assert.match(t.description, /\b[Rr]eturns?\b/, `${t.name}: says what it returns`);
    assert.equal(t.inputSchema.type, 'object');
    for (const req of t.inputSchema.required ?? []) assert.ok(t.inputSchema.properties[req], `${t.name}: required ${req} exists`);
    for (const [p, s] of Object.entries(t.inputSchema.properties)) {
      assert.ok(s.type, `${t.name}.${p}: has a type`);
      assert.ok(s.description && s.description.length >= 15, `${t.name}.${p}: has a description`);
      assert.ok(Array.isArray((s as { examples?: unknown[] }).examples), `${t.name}.${p}: has examples`);
    }
    const write = WRITE.includes(t.name);
    assert.equal(t.annotations.openWorldHint, false, t.name);
    assert.equal(t.annotations.readOnlyHint, !write && t.name !== 'ask_sara', `${t.name}: readOnlyHint only for read tools`);
    assert.equal(t.annotations.destructiveHint, /^(delete|update)_/.test(t.name), `${t.name}: destructiveHint for update/delete`);
    if (write) {
      assert.match(t.description, /Let other apps change things/, `${t.name}: says it needs the owner's switch`);
      assert.match(t.description, /Waiting for approval in Sara/, `${t.name}: says it can wait for the owner's approval`);
      assert.match(t.description, /nothing (changes|is stored) until the owner presses Allow/, `${t.name}: says nothing changes before Allow`);
    }
  }
  for (const n of ['complete_task', 'update_task', 'delete_task', 'update_note', 'delete_note', 'read_note']) assert.equal(tools.find((t) => t.name === n)!.annotations.idempotentHint, true, n);
  for (const n of ['add_task', 'add_note', 'remember_fact', 'ask_sara']) assert.equal(tools.find((t) => t.name === n)!.annotations.idempotentHint, false, n);
  assert.ok(!tools.some((t) => t.name === 'recent_conversations'), 'the old noun name is not listed');
});

test('--describe reports Sara\'s real version (SARA_VERSION kept equal to package.json)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.equal(SARA_VERSION, pkg.version, 'bump SARA_VERSION in src/mcp-bridge.ts with the release');
  assert.equal(describeVersion(), pkg.version);
  const a = describeAnswer({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as { result: { serverInfo: { version: string } } };
  assert.equal(a.result.serverInfo.version, pkg.version);
  assert.deepEqual(DESCRIBE_TOOLS, describeTools());
});

// ---------- the planner write tools, live ----------

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-27T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
const auth = new OwnerAuth(dir, () => clock.now);
const owner = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let key = '';
const events: string[] = [];
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  key = auth.createApiKey('Cursor').token;
  app.events!.subscribe((e) => {
    if (e.type === 'planner') events.push(String((e as { what?: string }).what));
  });
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = (await r.json()) as { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } };
  return { text: j.result?.content[0].text ?? j.error?.message ?? '', isError: j.result?.isError ?? true, error: j.error };
};
const listed = async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  return ((await r.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
};
const approvals = async (convId: string) =>
  ((await (await fetch(`${base}/api/conversations/${convId}`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { activity: { approvals: { approvalId: string; summary: string }[] } | null }).activity?.approvals ?? [];
const decide = (approvalId: string, approved: boolean) => fetch(`${base}/api/approvals/${approvalId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}`, origin: base }, body: JSON.stringify({ approved }) });
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('MCP: list_recent_conversations is listed; the old name recent_conversations still works but is hidden', async () => {
  app.store.createConversation({ title: 'Garden plans' });
  const names = await listed();
  assert.ok(names.includes('list_recent_conversations'));
  assert.ok(!names.includes('recent_conversations'));
  assert.match((await call('list_recent_conversations')).text, /Garden plans/);
  const old = await call('recent_conversations');
  assert.equal(old.isError, false);
  assert.match(old.text, /Garden plans/);
});

test('MCP planner write tools: hidden and refused until "Let other apps change things" is on', async () => {
  const t = app.planner!.addTask({ title: 'Water the plants' });
  const names = await listed();
  for (const n of ['complete_task', 'update_task', 'delete_task', 'update_note', 'delete_note']) assert.ok(!names.includes(n), `${n} is off by default`);
  const r = await call('delete_task', { id: t.id });
  assert.equal(r.isError, true);
  assert.match(r.text, /Let other apps change things/);
  assert.ok(app.planner!.task(t.id), 'nothing deleted');
});

test('MCP planner write tools: complete, update and delete to-dos and notes (allowed), with events and clear unknown-id errors', async () => {
  app.settings.update({ otherApps: { changes: true } });
  try {
    const names = await listed();
    for (const n of ['complete_task', 'update_task', 'delete_task', 'update_note', 'delete_note']) assert.ok(names.includes(n), n);
    const t = app.planner!.addTask({ title: 'Call the vet' });
    events.length = 0;
    assert.equal((await call('complete_task', { id: t.id })).text, `Done: to-do #${t.id} Call the vet`);
    assert.equal(app.planner!.task(t.id)!.status, 'done');
    assert.match((await call('complete_task', { id: t.id })).text, /already done/);
    const u = await call('update_task', { id: t.id, title: 'Call the vet about Biscuit', due: 'tomorrow 9am', priority: 'high', project: 'Pets', status: 'open' });
    assert.equal(u.isError, false, u.text);
    assert.match(u.text, new RegExp(`^Changed to-do #${t.id}: Call the vet about Biscuit \\(due `));
    const after1 = app.planner!.task(t.id)!;
    assert.equal(after1.status, 'open');
    assert.equal(after1.priority, 'high');
    assert.equal(after1.project, 'Pets');
    assert.ok(after1.dueAt);
    await call('update_task', { id: t.id, due: 'none', project: '' });
    assert.equal(app.planner!.task(t.id)!.dueAt, null);
    assert.equal(app.planner!.task(t.id)!.project, null);
    assert.equal((await call('update_task', { id: t.id })).isError, true, 'nothing to change is an error');
    assert.match((await call('update_task', { id: t.id, due: 'whenever-ish blah' })).text, /Couldn't understand the time/);
    // Deleting always waits for the owner, even with to-dos set to "allowed".
    assert.match((await call('delete_task', { id: t.id })).text, /Waiting for approval in Sara/);
    assert.ok(app.planner!.task(t.id), 'not deleted before Allow');
    await allowLatest(/Delete to-do #\d+: Call the vet about Biscuit/);
    await until(() => !app.planner!.task(t.id));
    assert.equal(app.planner!.task(t.id), undefined);
    assert.ok(events.filter((e) => e === 'tasks').length >= 4, `tasks events: ${events.join(',')}`);

    // Unknown ids are refused clearly (an error result, nothing asked or changed).
    for (const [tool, args] of [['complete_task', { id: 9999 }], ['update_task', { id: 9999, title: 'x' }], ['delete_task', { id: t.id }], ['delete_task', { id: 'abc' }]] as const) {
      const r = await call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.match(r.text, /No to-do with id .*Use list_tasks/, tool);
    }

    const n = app.planner!.saveNote({ title: 'Deploy steps', body: 'ssh in, git pull' });
    events.length = 0;
    assert.equal((await call('update_note', { id: n.id, body: 'ssh in, git pull, restart' })).text, `Changed note #${n.id}: Deploy steps`);
    assert.equal(app.planner!.note(n.id)!.body, 'ssh in, git pull, restart');
    assert.equal(app.planner!.note(n.id)!.title, 'Deploy steps', 'title kept');
    await call('update_note', { id: n.id, title: 'Deploy (server 2)', project: 'Ops' });
    assert.equal(app.planner!.note(n.id)!.title, 'Deploy (server 2)');
    assert.equal(app.planner!.note(n.id)!.body, 'ssh in, git pull, restart', 'body kept');
    assert.equal(app.planner!.note(n.id)!.project, 'Ops');
    assert.match((await call('delete_note', { id: n.id })).text, /Waiting for approval in Sara/);
    assert.ok(app.planner!.note(n.id), 'not deleted before Allow');
    await allowLatest(/Delete note #\d+: Deploy \(server 2\)/);
    await until(() => !app.planner!.note(n.id));
    assert.equal(app.planner!.note(n.id), undefined);
    assert.ok(events.filter((e) => e === 'notes').length >= 3, `notes events: ${events.join(',')}`);
    for (const tool of ['update_note', 'delete_note']) {
      const r = await call(tool, { id: n.id, title: 'x' });
      assert.equal(r.isError, true, tool);
      assert.match(r.text, /No note with id .*Use list_notes/, tool);
    }
  } finally {
    app.settings.update({ otherApps: { changes: false }, toolPermissions: {} });
  }
});

test('MCP planner write tools follow her approval rules: ask → waits in Sara until Allow; declined changes nothing; never → refused', async () => {
  app.settings.update({ otherApps: { changes: true }, toolPermissions: { todo: 'ask', note: 'ask' } });
  try {
    const t = app.planner!.addTask({ title: 'Renew passport' });
    const n = app.planner!.saveNote({ title: 'Packing list', body: 'socks' });
    assert.match((await call('delete_task', { id: t.id })).text, /Waiting for approval in Sara/);
    assert.ok(app.planner!.task(t.id), 'not deleted before Allow');
    const conv = app.store.listConversations().find((c) => c.channel === 'mcp' && c.title === 'Cursor: changes (MCP)')!;
    assert.ok(conv);
    let list = await approvals(conv.id);
    const del = list.find((a) => /Cursor: Delete to-do #\d+: Renew passport/.test(a.summary))!;
    assert.ok(del, JSON.stringify(list));
    events.length = 0;
    await decide(del.approvalId, true);
    await until(() => !app.planner!.task(t.id));
    assert.equal(app.planner!.task(t.id), undefined);
    await until(() => events.includes('tasks'));
    assert.ok(events.includes('tasks'));
    await until(() => app.store.messages(conv.id).some((m) => /Deleted to-do/.test(m.content)));
    assert.ok(app.store.messages(conv.id).some((m) => m.role === 'notice' && /Deleted to-do/.test(m.content)));

    // Declined: the note stays as it was.
    assert.match((await call('update_note', { id: n.id, body: 'socks, charger' })).text, /Waiting for approval in Sara/);
    list = await approvals(conv.id);
    const upd = list.find((a) => /Change note #\d+ \(Packing list\)/.test(a.summary))!;
    assert.ok(upd, JSON.stringify(list));
    await decide(upd.approvalId, false);
    await until(() => app.store.messages(conv.id).some((m) => /Declined: Cursor: Change note/.test(m.content)));
    assert.equal(app.planner!.note(n.id)!.body, 'socks');

    // Unknown ids are refused before anything is asked.
    const before = (await approvals(conv.id)).length;
    assert.equal((await call('complete_task', { id: 424242 })).isError, true);
    assert.equal((await approvals(conv.id)).length, before, 'no approval card for an unknown id');

    app.settings.update({ toolPermissions: { todo: 'never', note: 'never' } });
    const t2 = app.planner!.addTask({ title: 'Keep me' });
    assert.match((await call('complete_task', { id: t2.id })).text, /turned off/);
    assert.match((await call('delete_note', { id: n.id })).text, /turned off/);
    assert.equal(app.planner!.task(t2.id)!.status, 'open');
    assert.ok(app.planner!.note(n.id));
  } finally {
    app.settings.update({ otherApps: { changes: false }, toolPermissions: {} });
  }
});

test('Leftover 5: update_note / delete_note say what really happens (versions kept since 3.4.2)', () => {
  const tools = describeTools();
  const upd = tools.find((x) => x.name === 'update_note')!;
  const del = tools.find((x) => x.name === 'delete_note')!;
  assert.match(String(upd.description), /keeps the text it had before as an earlier version/);
  assert.match(JSON.stringify(upd.inputSchema), /kept as an earlier version/);
  assert.doesNotMatch(String(del.description), /can't be undone|for good/);
  assert.match(String(del.description), /keeps its last version for 30 days/);
});
