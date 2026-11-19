// V5.1 (docs/design/ROADMAP_V.md): one timeline of what she changed, with Revert where an undo
// already exists and "can't be undone" said plainly where not. Each listed kind reverts here.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { createEverydaySettingsTool } from '../src/everyday-settings.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { createSaraServer } from '../src/server.ts';
import { registerAction, registerRevert, timelineOf, TIMELINE_KINDS } from '../src/timeline.ts';
import { editFileTool, writeFileTool } from '../src/tools/builtin.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-18T15:00:00Z');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** A stand-in tool that records its calls (no real mailbox or calendar). */
function stub(name: string, out: (a: Record<string, unknown>) => string, permission: 'auto' | 'ask' = 'auto', calls: Record<string, unknown>[] = []): Tool {
  return {
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    defaultPermission: permission,
    summarize: (a) => `${name} ${JSON.stringify(a)}`,
    async run(a) {
      calls.push(a);
      return out(a);
    },
  };
}

function setup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const undone: Record<string, unknown>[] = [];
  const removed: Record<string, unknown>[] = [];
  // A fake mail id built at run time (no realistic-looking ids in tests).
  const mailId = ['m', 'test', String(Date.now() % 1000)].join('_');
  app.tools.add(writeFileTool);
  app.tools.add(editFileTool);
  app.tools.add(createEverydaySettingsTool(() => app));
  app.tools.add(stub('mail_organize', () => `Archived 3 emails.\n[gmail-result ${JSON.stringify({ id: mailId, action: 'archive', done: 3, failed: 0, total: 3 })}]`));
  app.tools.add(stub('mail_undo', () => 'Undid "archive" on 3 emails.', 'ask', undone));
  app.tools.add(stub('calendar_add', () => 'Added “Dentist” Fri 9:00 (event ev-test-1).'));
  app.tools.add(stub('calendar_remove', () => 'Removed the event.', 'ask', removed));
  app.tools.add(stub('mail_send', () => 'Sent to sam@example.com.', 'ask'));
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    toolPermissions: { write_file: 'auto', edit_file: 'auto', mail_send: 'auto', mail_undo: 'auto', calendar_remove: 'auto' },
  });
  return { app, dir, undone, removed, mailId };
}

async function act(app: TestApp, name: string, args: Record<string, unknown>): Promise<string> {
  const conv = app.store.createConversation();
  app.script.push([call('c1', name, args)], text('Done.'));
  const evs: ChatEvent[] = [];
  for await (const e of runTurn(app, conv.id, `please ${name}`)) evs.push(e);
  const res = evs.find((e) => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }> | undefined;
  assert.equal(res?.status, 'ok', `${name} ran: ${res?.output}`);
  return conv.id;
}

const newest = (app: TestApp) => timelineOf(app).list({ limit: 1 })[0];

test('V5.1: files, settings, mail, calendar and planner changes each revert', async (t) => {
  const { app, undone, removed, mailId } = setup(t);
  // Files: the snapshot taken before the write puts the file back.
  const conv = app.store.createConversation();
  const ws = workspaceDir(app.dataDir, conv.workspace);
  mkdirSync(join(ws, 'notes'), { recursive: true });
  writeFileSync(join(ws, 'notes', 'a.txt'), 'first');
  app.script.push([call('c1', 'write_file', { path: 'notes/a.txt', content: 'second' })], text('Done.'));
  for await (const _ of runTurn(app, conv.id, 'write the note')) void _;
  assert.equal(readFileSync(join(ws, 'notes', 'a.txt'), 'utf8'), 'second');
  let row = newest(app);
  assert.equal(row.kind, 'files');
  assert.equal(row.canRevert, true);
  assert.equal(row.conversationId, conv.id);
  await timelineOf(app).revert(row.id);
  assert.equal(readFileSync(join(ws, 'notes', 'a.txt'), 'utf8'), 'first', 'file is back');
  assert.ok(timelineOf(app).get(row.id)?.revertedAt, 'marked reverted');
  await assert.rejects(timelineOf(app).revert(row.id), /already/i, 'no second revert');

  // Settings: the name she calls you goes back.
  await act(app, 'change_setting', { setting: 'my_name', value: 'Pat' });
  assert.equal(app.settings.get().ownerName, 'Pat');
  row = newest(app);
  assert.equal(row.kind, 'settings');
  await timelineOf(app).revert(row.id);
  assert.equal(app.settings.get().ownerName, 'Alex');

  // Mail moves: through the existing mail_undo with the change's own id.
  await act(app, 'mail_organize', { action: 'archive', query: 'from:shop' });
  row = newest(app);
  assert.equal(row.kind, 'mail');
  assert.equal(row.canRevert, true);
  await timelineOf(app).revert(row.id);
  assert.deepEqual(undone, [{ id: mailId }]);

  // Calendar: an added event is removed again.
  await act(app, 'calendar_add', { title: 'Dentist', start: '2026-11-20T09:00' });
  row = newest(app);
  assert.equal(row.kind, 'calendar');
  await timelineOf(app).revert(row.id);
  assert.deepEqual(removed, [{ id: 'ev-test-1' }]);

  // Planner: an added to-do goes away, a done one is open again, a note gets its old text, a reminder is cancelled.
  await act(app, 'todo', { action: 'add', title: 'Buy milk' });
  const task = app.planner!.tasks({ status: 'all' }).find((x) => x.title === 'Buy milk')!;
  row = newest(app);
  assert.equal(row.kind, 'planner');
  assert.equal(row.title, 'Added the to-do “{title}”', 'a plain, translated line');
  assert.deepEqual(row.params, { title: 'Buy milk' });
  await timelineOf(app).revert(row.id);
  assert.equal(app.planner!.task(task.id), undefined);

  const t2 = app.planner!.addTask({ title: 'Call mom' });
  await act(app, 'todo', { action: 'done', id: t2.id });
  assert.equal(app.planner!.task(t2.id)?.status, 'done');
  await timelineOf(app).revert(newest(app).id);
  assert.equal(app.planner!.task(t2.id)?.status, 'open');

  const t3 = app.planner!.addTask({ title: 'Old title' });
  await act(app, 'todo', { action: 'update', id: t3.id, title: 'New title' });
  await timelineOf(app).revert(newest(app).id);
  assert.equal(app.planner!.task(t3.id)?.title, 'Old title');

  const n = app.planner!.saveNote({ title: 'Recipe', body: 'flour, eggs' });
  await act(app, 'note', { action: 'save', id: n.id, body: 'flour, eggs, sugar' });
  assert.match(app.planner!.note(n.id)!.body, /sugar/);
  await timelineOf(app).revert(newest(app).id);
  assert.equal(app.planner!.note(n.id)!.body, 'flour, eggs');

  await act(app, 'note', { action: 'delete', id: n.id });
  assert.equal(app.planner!.note(n.id), undefined);
  await timelineOf(app).revert(newest(app).id);
  assert.equal(app.planner!.note(n.id)?.body, 'flour, eggs', 'deleted note restored');

  await act(app, 'remind', { action: 'set', text: 'Water plants', when: '2026-11-19T09:00' });
  const rem = app.planner!.reminders({ status: 'all' }).find((r) => r.text === 'Water plants')!;
  await timelineOf(app).revert(newest(app).id);
  assert.notEqual(app.planner!.reminder(rem.id)?.status, 'pending', 'reminder cancelled');

  // Every listed kind is one of the timeline's kinds.
  for (const r of timelineOf(app).list({})) assert.ok(TIMELINE_KINDS.includes(r.kind), r.kind);
});

test('V5.1: irreversible changes are labeled, read-only calls are not listed', async (t) => {
  const { app } = setup(t);
  await act(app, 'mail_send', { to: 'sam@example.com', body: 'hi' });
  let row = newest(app);
  assert.equal(row.tool, 'mail_send');
  assert.equal(row.canRevert, false);
  assert.match(row.never ?? '', /can't be unsent/);
  await assert.rejects(timelineOf(app).revert(row.id), /can't/);

  await act(app, 'calendar_remove', { id: 'ev-x' });
  row = newest(app);
  assert.equal(row.kind, 'calendar');
  assert.equal(row.canRevert, false);
  assert.ok(row.never);

  await act(app, 'change_setting', { setting: 'theme', value: 'dark' });
  row = newest(app);
  assert.equal(row.kind, 'settings');
  assert.equal(row.canRevert, false, 'a device-only change says where to undo it');
  assert.match(row.never ?? '', /device/);

  const before = timelineOf(app).list({}).length;
  await act(app, 'todo', { action: 'list' });
  await act(app, 'note', { action: 'list' });
  assert.equal(timelineOf(app).list({}).length, before, 'reads are not changes');
});

test('V5.1: a new feature registers its own undo', async (t) => {
  const { app } = setup(t);
  const state = { color: 'blue' };
  app.tools.add(stub('paint_wall', (a) => `Painted ${String(a.color)}.`));
  registerAction('paint_wall', ({ before }) => ({ kind: 'other', undo: { type: 'test-paint', color: before } }), () => state.color);
  registerRevert('test-paint', async (u) => {
    state.color = String(u.color);
    return 'Repainted.';
  });
  await act(app, 'paint_wall', { color: 'red' });
  state.color = 'red';
  const row = newest(app);
  assert.equal(row.canRevert, true);
  await timelineOf(app).revert(row.id);
  assert.equal(state.color, 'blue');
});

test('V5.1: /api/timeline lists and reverts; members get their own', async (t) => {
  const { app } = setup(t);
  await act(app, 'change_setting', { setting: 'my_name', value: 'Pat' });
  await act(app, 'mail_send', { to: 'x@example.com' });
  const auth = new OwnerAuth(app.dataDir);
  const token = String(auth.newToken);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/timeline`;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const list = (await (await fetch(base, { headers: h })).json()) as { items: { id: number; kind: string; canRevert: boolean; never?: string }[]; kinds: string[] };
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.kinds, [...TIMELINE_KINDS]);
  const only = (await (await fetch(`${base}?kind=settings`, { headers: h })).json()) as { items: unknown[] };
  assert.equal(only.items.length, 1);
  const setting = list.items.find((x) => x.kind === 'settings')!;
  const r = await fetch(`${base}/${setting.id}/revert`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(app.settings.get().ownerName, 'Alex');
  const again = await fetch(`${base}/${setting.id}/revert`, { method: 'POST', headers: h, body: '{}' });
  assert.equal(again.status, 409);
  const sent = list.items.find((x) => !x.canRevert)!;
  assert.equal((await fetch(`${base}/${sent.id}/revert`, { method: 'POST', headers: h, body: '{}' })).status, 409);
  assert.ok(MEMBER_ROUTES.has('timeline'), "a member's own timeline");
});

test('V5.1: the Settings page is a hosted section with tips and translated strings', () => {
  const html = read('web/index.html');
  assert.match(html, /data-page="dh-timeline" data-group="Privacy &amp; system|data-page="dh-timeline" data-group="Privacy & system/);
  assert.match(html, /data-page="dh-timeline"[^>]*data-host="dh-reports"/);
  assert.match(read('web/settings-nav.js'), /'dh-reports', 'dh-timeline'/);
  const js = read('web/timeline.js');
  assert.match(js, /\/timeline/);
  assert.ok(!/fetch\(/.test(js) || /api\(/.test(js));
  assert.match(read('web/app.js'), /shown\.has\('dh-timeline'\)/);
  const tips = JSON.parse(read('web/tips.json')) as { pages?: Record<string, unknown> };
  assert.ok(tips.pages?.['dh-timeline'], 'page summary tip');
});
